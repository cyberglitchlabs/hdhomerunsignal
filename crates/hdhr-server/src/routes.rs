//! The REST API under `/api/v1`.
//!
//! Every device id and tuner in a path is validated before anything runs, and
//! only validated values reach the tool.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, RawQuery, Request, State};
use axum::http::{Extensions, HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use hdhr_core::model::{Device, DeviceInfo, PlpInfo, Program, ScannedChannel, TunerStatus};
use hdhr_core::validate;
use serde_json::{Value, json};
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::discovery::discover_devices;
use crate::error::ApiError;
use crate::schema::{Atsc3Request, ChannelRequest, ErrorBody, StreamUrl, TuneResult, Version};
use crate::state::AppState;
use crate::stream;

pub(crate) type ApiResult<T> = Result<T, ApiError>;

/// Largest request body accepted.
pub const BODY_LIMIT: usize = 10 * 1024;

/// The API's routes, each registered together with its entry in the OpenAPI spec,
/// so a route without documentation (or the reverse) cannot exist.
pub fn api() -> OpenApiRouter<Arc<AppState>> {
    OpenApiRouter::new()
        .routes(routes!(list_devices))
        .routes(routes!(device_info))
        .routes(routes!(channel_maps))
        .routes(routes!(scan))
        .routes(routes!(tuner_status))
        .routes(routes!(programs))
        .routes(routes!(plp_info))
        .routes(routes!(l1_info))
        .routes(routes!(set_channel))
        .routes(routes!(channel_up))
        .routes(routes!(channel_down))
        .routes(routes!(clear_tuner))
        .routes(routes!(set_atsc3))
        .routes(routes!(stream_url))
        .routes(routes!(playlist))
        .routes(routes!(stream::tuner_stream))
        .routes(routes!(stream::antenna_stream))
        .routes(routes!(version))
}

// ----------------------------------------------------------------- validation

pub(crate) fn device(id: &str) -> ApiResult<&str> {
    validate::device_host(id).ok_or_else(|| ApiError::bad_request("Invalid device id"))
}

pub(crate) fn tuner(tuner: &str) -> ApiResult<u8> {
    validate::tuner(tuner).ok_or_else(|| ApiError::bad_request("Invalid tuner"))
}

/// The device and tuner of a path, checked in that order.
fn device_and_tuner<'a>(id: &'a str, tuner_text: &str) -> ApiResult<(&'a str, u8)> {
    Ok((device(id)?, tuner(tuner_text)?))
}

/// The `tuners` query parameter: 1 to 8, as a plain decimal number.
pub(crate) fn tuner_count(query: Option<String>) -> ApiResult<u8> {
    Query::new(query)
        .get("tuners")
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|text| text.parse::<u8>().ok())
        .filter(|count| (1..=8).contains(count))
        .ok_or_else(|| ApiError::bad_request("Invalid tuners"))
}

/// A query string where each name must appear at most once: a repeated name is
/// not a usable value, and is treated as missing.
pub(crate) struct Query(Vec<(String, String)>);

impl Query {
    pub(crate) fn new(raw: Option<String>) -> Self {
        let raw = raw.unwrap_or_default();
        Self(
            url::form_urlencoded::parse(raw.as_bytes())
                .into_owned()
                .collect(),
        )
    }

    pub(crate) fn get(&self, name: &str) -> Option<&str> {
        let mut found = self.0.iter().filter(|(key, _)| key == name);
        match (found.next(), found.next()) {
            (Some((_, value)), None) => Some(value),
            _ => None,
        }
    }
}

/// The JSON object of a request body. A body that is not sent as JSON counts as
/// empty, so the handler's own validation answers; one that claims to be JSON
/// and is not, is refused.
fn json_body(headers: &HeaderMap, body: &Bytes) -> ApiResult<Value> {
    let is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .is_some_and(|t| t.trim().eq_ignore_ascii_case("application/json"))
        });
    if !is_json || body.is_empty() {
        return Ok(json!({}));
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(value @ (Value::Object(_) | Value::Array(_))) => Ok(value),
        _ => Err(ApiError::bad_request("Invalid JSON")),
    }
}

/// What JavaScript's `String(value)` gives for the values a channel number can
/// arrive as, so `{"channel": 27}` and `{"channel": "27"}` mean the same. Anything
/// else cannot be a channel number.
fn channel_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => {
            let n = number.as_f64()?;
            (n.fract() == 0.0 && n.abs() < 1e15).then(|| format!("{}", n as i64))
        }
        Value::Array(items) if items.len() == 1 => channel_text(items.first()),
        _ => None,
    }
}

// ------------------------------------------------------------------ middleware

/// Counts every request, except event streams, against the general limit.
pub async fn general_limit(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    if is_stream_path(request.uri().path()) {
        return next.run(request).await;
    }
    let peer = request.extensions().get::<ConnectInfo<SocketAddr>>();
    match limit(&state, &state.general_limiter, peer, request.headers()) {
        Some(refused) => refused,
        None => next.run(request).await,
    }
}

fn limit(
    state: &AppState,
    limiter: &crate::limits::RateLimiter,
    peer: Option<&ConnectInfo<SocketAddr>>,
    headers: &HeaderMap,
) -> Option<Response> {
    let wait = limiter.hit(&client_key(state, peer, headers)).err()?;
    let mut response = ApiError::too_many("Too many requests").into_response();
    if let Ok(seconds) = HeaderValue::from_str(&wait.as_secs().max(1).to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, seconds);
    }
    Some(response)
}

/// What a client is counted as: the address the connection came from, or the one
/// `HDHR_TRUST_PROXY` says a proxy forwarded. The server always supplies the peer
/// address; without one the request is still counted, under a shared key, rather
/// than skipping its limit.
pub fn client_key(
    state: &AppState,
    peer: Option<&ConnectInfo<SocketAddr>>,
    headers: &HeaderMap,
) -> String {
    match peer {
        Some(ConnectInfo(peer)) => {
            let forwarded = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok());
            state.clients.resolve(peer.ip(), forwarded)
        }
        None => "unknown".to_owned(),
    }
}

/// An event stream: `/api/v1/devices/{id}/tuner/{tuner}/stream` or
/// `/api/v1/devices/{id}/antenna/stream`. A stream stays open for as long as the
/// page does, and a browser's `EventSource` gives up for good on a 429, so streams
/// are bounded by the per-client stream cap instead of the request rate.
fn is_stream_path(path: &str) -> bool {
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    matches!(
        segments.as_slice(),
        ["api", "v1", "devices", _, "tuner", _, "stream"]
            | ["api", "v1", "devices", _, "antenna", "stream"]
    )
}

// -------------------------------------------------------------------- handlers

#[utoipa::path(
    get,
    path = "/devices",
    tag = "devices",
    summary = "List devices",
    description = "The devices to offer. Found by local broadcast; if that finds nothing, by SiliconDust's cloud lookup (unless disabled); plus any devices configured by address. The cloud result is kept until a refresh.",
    params(("force" = Option<bool>, Query, description = "`true` is the user pressing Refresh: it forgets remembered devices and allows the cloud lookup to run again. Any other value is ignored.")),
    responses((status = 200, description = "The devices.", body = Vec<Device>), (status = 429, description = "Too many requests from this client.", body = ErrorBody))
)]
async fn list_devices(
    State(state): State<Arc<AppState>>,
    RawQuery(query): RawQuery,
) -> impl IntoResponse {
    let force = Query::new(query).get("force") == Some("true");
    Json(discover_devices(&state, force).await)
}

#[utoipa::path(
    get,
    path = "/devices/{id}/info",
    tag = "devices",
    summary = "Device model and tuner count",
    params(("id" = String, Path, description = "A device ID (e.g. `1080ABCD`), IPv4 address or hostname: letters, digits, dots and hyphens, starting with a letter or digit, at most 253 characters.")),
    responses((status = 200, description = "The device. An unreachable one is reported as model `Unknown` with two tuners.", body = DeviceInfo), (status = 400, description = "A device, tuner or parameter is not valid.", body = ErrorBody))
)]
async fn device_info(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.hdhr.device_info(device(&id)?).await))
}

#[utoipa::path(
    get,
    path = "/devices/{id}/channelmaps",
    tag = "devices",
    summary = "Each tuner's channel map",
    description = "The channel map each tuner is set to on the device, which decides what a channel number such as `27` means when tuning. Read-only. Null for a tuner that does not answer or has a map this app does not know.",
    params(("id" = String, Path, description = "A device ID (e.g. `1080ABCD`), IPv4 address or hostname: letters, digits, dots and hyphens, starting with a letter or digit, at most 253 characters."), ("tuners" = u8, Query, description = "How many tuners to read, 1 to 8 (plain digits).")),
    responses((status = 200, description = "One entry per tuner, in order.", body = Vec<Option<String>>), (status = 400, description = "A device or `tuners` is not valid.", body = ErrorBody))
)]
async fn channel_maps(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<impl IntoResponse> {
    let device = device(&id)?;
    let tuners = tuner_count(query)?;
    Ok(Json(state.hdhr.channel_maps(device, tuners).await))
}

#[utoipa::path(
    get,
    path = "/devices/{id}/scan/{tuner}",
    tag = "tuners",
    summary = "Scan for channels",
    description = "Scans a channel map on one tuner and returns the channels that locked, with their programs. This occupies the tuner and can take two minutes. Limited to 6 requests a minute per client.",
    params(("id" = String, Path, description = "A device ID (e.g. `1080ABCD`), IPv4 address or hostname: letters, digits, dots and hyphens, starting with a letter or digit, at most 253 characters."), ("tuner" = u8, Path, description = "The tuner index, 0 to 7.", minimum = 0, maximum = 7), ("channelMap" = Option<String>, Query, description = "One of `us-bcast` (the default), `us-cable`, `us-hrc`, `us-irc`, `ca-bcast`, `ca-cable`, `ca-hrc`, `ca-irc`, `eu-bcast`, `eu-cable`, `au-bcast`, `au-cable`. Giving it twice is an error.")),
    responses((status = 200, description = "The channels that locked.", body = Vec<ScannedChannel>), (status = 400, description = "A device, tuner or parameter is not valid.", body = ErrorBody), (status = 429, description = "Too many requests from this client.", body = ErrorBody), (status = 500, description = "The device or the tool reported an error.", body = ErrorBody))
)]
async fn scan(
    State(state): State<Arc<AppState>>,
    Path((id, tuner_text)): Path<(String, String)>,
    RawQuery(query): RawQuery,
    extensions: Extensions,
    headers: HeaderMap,
) -> ApiResult<Response> {
    // A scan occupies a tuner for up to a minute, so it has a limit of its own.
    if let Some(refused) = limit(
        &state,
        &state.scan_limiter,
        extensions.get::<ConnectInfo<SocketAddr>>(),
        &headers,
    ) {
        return Ok(refused);
    }
    let (id, tuner) = device_and_tuner(&id, &tuner_text)?;
    let query = Query::new(query);
    // Absent means the default; a repeated or unknown map is refused.
    let requested = if query.0.iter().any(|(key, _)| key == "channelMap") {
        query.get("channelMap").unwrap_or("")
    } else {
        "us-bcast"
    };
    let channel_map = validate::channel_map(requested)
        .ok_or_else(|| ApiError::bad_request("Invalid channelMap"))?;
    Ok(Json(state.hdhr.scan(id, tuner, channel_map).await?).into_response())
}

#[utoipa::path(
    get,
    path = "/devices/{id}/tuner/{tuner}/status",
    tag = "tuners",
    summary = "Tuner status",
    params(("id" = String, Path, description = "A device ID (e.g. `1080ABCD`), IPv4 address or hostname: letters, digits, dots and hyphens, starting with a letter or digit, at most 253 characters."), ("tuner" = u8, Path, description = "The tuner index, 0 to 7.", minimum = 0, maximum = 7)),
    responses((status = 200, description = "One reading, or null when the tuner did not answer.", body = Option<TunerStatus>), (status = 400, description = "A device, tuner or parameter is not valid.", body = ErrorBody))
)]
async fn tuner_status(
    State(state): State<Arc<AppState>>,
    Path((id, t)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    let (id, tuner) = device_and_tuner(&id, &t)?;
    Ok(Json(state.hdhr.tuner_status(id, tuner).await))
}

#[utoipa::path(
    get,
    path = "/devices/{id}/tuner/{tuner}/programs",
    tag = "tuners",
    summary = "Programs on the tuned channel",
    description = "Empty unless the tuner has a lock. Right after a channel change the device can need a few seconds, so this retries for up to about 7 seconds.",
    params(("id" = String, Path, description = "A device ID (e.g. `1080ABCD`), IPv4 address or hostname: letters, digits, dots and hyphens, starting with a letter or digit, at most 253 characters."), ("tuner" = u8, Path, description = "The tuner index, 0 to 7.", minimum = 0, maximum = 7)),
    responses((status = 200, description = "The programs.", body = Vec<Program>), (status = 400, description = "A device, tuner or parameter is not valid.", body = ErrorBody))
)]
async fn programs(
    State(state): State<Arc<AppState>>,
    Path((id, t)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    let (id, tuner) = device_and_tuner(&id, &t)?;
    Ok(Json(state.hdhr.programs(id, tuner).await))
}

#[utoipa::path(
    get,
    path = "/devices/{id}/tuner/{tuner}/plpinfo",
    tag = "tuners",
    summary = "ATSC 3.0 PLP details",
    params(("id" = String, Path, description = "A device ID (e.g. `1080ABCD`), IPv4 address or hostname: letters, digits, dots and hyphens, starting with a letter or digit, at most 253 characters."), ("tuner" = u8, Path, description = "The tuner index, 0 to 7.", minimum = 0, maximum = 7)),
    responses((status = 200, description = "The PLPs by id, or null when the device reports none or has no ATSC 3.0 support.", body = Option<HashMap<String, PlpInfo>>), (status = 400, description = "A device, tuner or parameter is not valid.", body = ErrorBody))
)]
async fn plp_info(
    State(state): State<Arc<AppState>>,
    Path((id, t)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    let (id, tuner) = device_and_tuner(&id, &t)?;
    Ok(Json(state.plp.plp_or_none(&state.hdhr, id, tuner).await))
}

#[utoipa::path(
    get,
    path = "/devices/{id}/tuner/{tuner}/l1info",
    tag = "tuners",
    summary = "ATSC 3.0 L1 signalling",
    params(("id" = String, Path, description = "A device ID (e.g. `1080ABCD`), IPv4 address or hostname: letters, digits, dots and hyphens, starting with a letter or digit, at most 253 characters."), ("tuner" = u8, Path, description = "The tuner index, 0 to 7.", minimum = 0, maximum = 7)),
    responses((status = 200, description = "The raw key/value pairs, or null when the device reports none.", body = Option<HashMap<String, String>>), (status = 400, description = "A device, tuner or parameter is not valid.", body = ErrorBody))
)]
async fn l1_info(
    State(state): State<Arc<AppState>>,
    Path((id, t)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    let (id, tuner) = device_and_tuner(&id, &t)?;
    Ok(Json(state.hdhr.l1_info(id, tuner).await))
}

fn done(result: String) -> Json<Value> {
    Json(json!({ "success": true, "result": result }))
}

#[utoipa::path(
    post,
    path = "/devices/{id}/tuner/{tuner}/channel",
    tag = "tuning",
    summary = "Tune a channel",
    params(("id" = String, Path, description = "A device ID (e.g. `1080ABCD`), IPv4 address or hostname: letters, digits, dots and hyphens, starting with a letter or digit, at most 253 characters."), ("tuner" = u8, Path, description = "The tuner index, 0 to 7.", minimum = 0, maximum = 7)),
    request_body(content = ChannelRequest, description = "The channel must be a string; a JSON number is refused here (but accepted by the `atsc3` endpoint)."),
    responses((status = 200, description = "Tuned.", body = TuneResult), (status = 400, description = "A device, tuner or parameter is not valid.", body = ErrorBody), (status = 500, description = "The device or the tool reported an error.", body = ErrorBody))
)]
async fn set_channel(
    State(state): State<Arc<AppState>>,
    Path((id, t)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let (id, tuner) = device_and_tuner(&id, &t)?;
    let body = json_body(&headers, &body)?;
    let channel = body
        .get("channel")
        .and_then(Value::as_str)
        .and_then(validate::channel)
        .ok_or_else(|| ApiError::bad_request("Invalid channel"))?;
    Ok(done(state.hdhr.set_channel(id, tuner, channel).await?))
}

#[utoipa::path(
    post,
    path = "/devices/{id}/tuner/{tuner}/channel/up",
    tag = "tuning",
    summary = "Next channel",
    params(("id" = String, Path, description = "A device ID (e.g. `1080ABCD`), IPv4 address or hostname: letters, digits, dots and hyphens, starting with a letter or digit, at most 253 characters."), ("tuner" = u8, Path, description = "The tuner index, 0 to 7.", minimum = 0, maximum = 7)),
    responses((status = 200, description = "Tuned.", body = TuneResult), (status = 400, description = "A device, tuner or parameter is not valid.", body = ErrorBody), (status = 500, description = "The device or the tool reported an error.", body = ErrorBody))
)]
async fn channel_up(
    State(state): State<Arc<AppState>>,
    Path((id, t)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    let (id, tuner) = device_and_tuner(&id, &t)?;
    Ok(done(state.hdhr.channel_up(id, tuner).await?))
}

#[utoipa::path(
    post,
    path = "/devices/{id}/tuner/{tuner}/channel/down",
    tag = "tuning",
    summary = "Previous channel",
    params(("id" = String, Path, description = "A device ID (e.g. `1080ABCD`), IPv4 address or hostname: letters, digits, dots and hyphens, starting with a letter or digit, at most 253 characters."), ("tuner" = u8, Path, description = "The tuner index, 0 to 7.", minimum = 0, maximum = 7)),
    responses((status = 200, description = "Tuned.", body = TuneResult), (status = 400, description = "A device, tuner or parameter is not valid.", body = ErrorBody), (status = 500, description = "The device or the tool reported an error.", body = ErrorBody))
)]
async fn channel_down(
    State(state): State<Arc<AppState>>,
    Path((id, t)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    let (id, tuner) = device_and_tuner(&id, &t)?;
    Ok(done(state.hdhr.channel_down(id, tuner).await?))
}

#[utoipa::path(
    post,
    path = "/devices/{id}/tuner/{tuner}/clear",
    tag = "tuning",
    summary = "Stop the tuner",
    params(("id" = String, Path, description = "A device ID (e.g. `1080ABCD`), IPv4 address or hostname: letters, digits, dots and hyphens, starting with a letter or digit, at most 253 characters."), ("tuner" = u8, Path, description = "The tuner index, 0 to 7.", minimum = 0, maximum = 7)),
    responses((status = 200, description = "Cleared.", body = TuneResult), (status = 400, description = "A device, tuner or parameter is not valid.", body = ErrorBody), (status = 500, description = "The device or the tool reported an error.", body = ErrorBody))
)]
async fn clear_tuner(
    State(state): State<Arc<AppState>>,
    Path((id, t)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    let (id, tuner) = device_and_tuner(&id, &t)?;
    Ok(done(state.hdhr.clear_tuner(id, tuner).await?))
}

#[utoipa::path(
    post,
    path = "/devices/{id}/tuner/{tuner}/atsc3",
    tag = "tuning",
    summary = "Tune an ATSC 3.0 channel",
    description = "Builds `atsc3:<channel>[:<plp>+<plp>...]` from validated parts.",
    params(("id" = String, Path, description = "A device ID (e.g. `1080ABCD`), IPv4 address or hostname: letters, digits, dots and hyphens, starting with a letter or digit, at most 253 characters."), ("tuner" = u8, Path, description = "The tuner index, 0 to 7.", minimum = 0, maximum = 7)),
    request_body = Atsc3Request,
    responses((status = 200, description = "Tuned.", body = TuneResult), (status = 400, description = "The channel or the PLPs are not valid.", body = ErrorBody), (status = 500, description = "The device or the tool reported an error.", body = ErrorBody))
)]
async fn set_atsc3(
    State(state): State<Arc<AppState>>,
    Path((id, t)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let (id, tuner) = device_and_tuner(&id, &t)?;
    let body = json_body(&headers, &body)?;
    let invalid = || ApiError::bad_request("Invalid channel or plps");
    let channel = channel_text(body.get("channel"));
    let channel = channel
        .as_deref()
        .and_then(validate::digits)
        .ok_or_else(invalid)?;
    let plps = validate::plps(body.get("plps")).ok_or_else(invalid)?;
    Ok(done(
        state
            .hdhr
            .set_atsc3_channel(id, tuner, channel, &plps)
            .await?,
    ))
}

/// The URL a player can open to watch one program, by RF channel and program
/// number, which avoids two stations sharing a virtual channel.
fn program_url(state: &AppState, id: &str, query: &Query) -> ApiResult<(String, String, String)> {
    let id = device(id)?;
    let (Some(ch), Some(program)) = (
        query.get("ch").and_then(validate::digits),
        query.get("program").and_then(validate::digits),
    ) else {
        return Err(ApiError::bad_request(
            "Missing or invalid ch or program query parameter",
        ));
    };
    let device = state
        .find_device(id)
        .ok_or_else(|| ApiError::not_found("Device not found"))?;
    Ok((
        format!("http://{}:5004/auto/ch{ch}-{program}", device.ip),
        ch.to_owned(),
        program.to_owned(),
    ))
}

#[utoipa::path(
    get,
    path = "/devices/{id}/stream/url",
    tag = "streaming",
    summary = "URL of a program",
    description = "The URL a player can open to watch one program, by RF channel and program number, which avoids two stations sharing a virtual channel. Only devices on the current device list are served.",
    params(("id" = String, Path, description = "A device ID (e.g. `1080ABCD`), IPv4 address or hostname: letters, digits, dots and hyphens, starting with a letter or digit, at most 253 characters."), ("ch" = String, Query, description = "The RF channel, as digits (1 to 10)."), ("program" = String, Query, description = "The program number, as digits (1 to 10).")),
    responses((status = 200, description = "The URL.", body = StreamUrl), (status = 400, description = "`ch` or `program` is missing or not digits.", body = ErrorBody), (status = 404, description = "The device is not on the list.", body = ErrorBody))
)]
async fn stream_url(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<impl IntoResponse> {
    let (url, ..) = program_url(&state, &id, &Query::new(query))?;
    Ok(Json(json!({ "url": url })))
}

#[utoipa::path(
    get,
    path = "/devices/{id}/stream/play.m3u",
    tag = "streaming",
    summary = "M3U playlist for a program",
    description = "A one-entry playlist, sent as a download.",
    params(("id" = String, Path, description = "A device ID (e.g. `1080ABCD`), IPv4 address or hostname: letters, digits, dots and hyphens, starting with a letter or digit, at most 253 characters."), ("ch" = String, Query, description = "The RF channel, as digits (1 to 10)."), ("program" = String, Query, description = "The program number, as digits (1 to 10)."), ("name" = Option<String>, Query, description = "A label for the entry; control characters are removed and it is cut at 64 characters.")),
    responses((status = 200, description = "The playlist.", content_type = "audio/x-mpegurl", body = String), (status = 400, description = "`ch` or `program` is missing or not digits.", body = ErrorBody), (status = 404, description = "The device is not on the list.", body = ErrorBody))
)]
async fn playlist(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<Response> {
    let query = Query::new(query);
    let (url, ch, program) = program_url(&state, &id, &query)?;
    // The label is free text, so control characters are stripped: a line break in
    // it could otherwise add entries to the playlist.
    let name = query
        .get("name")
        .map(validate::display_name)
        .filter(|name| !name.is_empty());
    let label = name
        .clone()
        .unwrap_or_else(|| format!("Ch{ch} Program {program}"));
    let filename = match &name {
        Some(name) => name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                    c
                } else {
                    '_'
                }
            })
            .collect(),
        None => format!("ch{ch}-{program}"),
    };
    let playlist = format!("#EXTM3U\n#EXTINF:-1,{label}\n{url}\n");
    Ok((
        [
            (header::CONTENT_TYPE, "audio/x-mpegurl".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}.m3u\""),
            ),
        ],
        playlist,
    )
        .into_response())
}

/// What the built frontend says about itself, for the update check.
#[utoipa::path(
    get,
    path = "/version",
    tag = "app",
    summary = "Frontend build version",
    description = "Read by the page to find out whether a newer build is available.",
    responses((status = 200, description = "The build.", body = Version))
)]
async fn version(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let path = state.config.static_dir.join("build-version.json");
    let version = tokio::fs::read(&path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    Json(version.unwrap_or_else(|| json!({ "hash": "unknown", "buildTime": null })))
}

/// Unknown paths under `/api/` are JSON 404s, not the frontend's page.
pub async fn api_not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" })))
}
