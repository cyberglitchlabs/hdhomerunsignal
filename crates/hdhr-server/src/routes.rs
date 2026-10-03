//! The REST API under `/api/v1`.
//!
//! Every device id and tuner in a path is validated before anything runs, and
//! only validated values reach the tool.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, RawQuery, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use hdhr_core::validate::{self, log_safe};
use serde_json::{Value, json};

use crate::discovery::discover_devices;
use crate::error::ApiError;
use crate::state::AppState;

type ApiResult<T> = Result<T, ApiError>;

/// Largest request body accepted.
pub const BODY_LIMIT: usize = 10 * 1024;

pub fn api(state: Arc<AppState>) -> Router<Arc<AppState>> {
    let scan = Router::new()
        .route("/devices/{id}/scan/{tuner}", get(scan))
        .route_layer(middleware::from_fn_with_state(state, scan_limit));

    Router::new()
        .route("/devices", get(list_devices))
        .route("/devices/{id}/info", get(device_info))
        .route("/devices/{id}/tuner/{tuner}/status", get(tuner_status))
        .route("/devices/{id}/tuner/{tuner}/programs", get(programs))
        .route("/devices/{id}/tuner/{tuner}/plpinfo", get(plp_info))
        .route("/devices/{id}/tuner/{tuner}/l1info", get(l1_info))
        .route("/devices/{id}/tuner/{tuner}/channel", post(set_channel))
        .route("/devices/{id}/tuner/{tuner}/channel/up", post(channel_up))
        .route(
            "/devices/{id}/tuner/{tuner}/channel/down",
            post(channel_down),
        )
        .route("/devices/{id}/tuner/{tuner}/clear", post(clear_tuner))
        .route("/devices/{id}/tuner/{tuner}/atsc3", post(set_atsc3))
        .route("/devices/{id}/stream/url", get(stream_url))
        .route("/devices/{id}/stream/play.m3u", get(playlist))
        .route("/version", get(version))
        .merge(scan)
}

// ----------------------------------------------------------------- validation

fn device(id: &str) -> ApiResult<&str> {
    validate::device_host(id).ok_or_else(|| ApiError::bad_request("Invalid device id"))
}

fn tuner(tuner: &str) -> ApiResult<u8> {
    validate::tuner(tuner).ok_or_else(|| ApiError::bad_request("Invalid tuner"))
}

/// The device and tuner of a path, checked in that order.
fn device_and_tuner<'a>(id: &'a str, tuner_text: &str) -> ApiResult<(&'a str, u8)> {
    Ok((device(id)?, tuner(tuner_text)?))
}

/// A query string where each name must appear at most once: a repeated name is
/// not a usable value, and is treated as missing.
struct Query(Vec<(String, String)>);

impl Query {
    fn new(raw: Option<String>) -> Self {
        let raw = raw.unwrap_or_default();
        Self(
            url::form_urlencoded::parse(raw.as_bytes())
                .into_owned()
                .collect(),
        )
    }

    fn get(&self, name: &str) -> Option<&str> {
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

/// Counts every request against the general limit. The caller's address is the
/// connection's, or the one `HDHR_TRUST_PROXY` says a proxy forwarded.
pub async fn general_limit(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    match limit(&state, &state.general_limiter, &request) {
        Some(refused) => refused,
        None => next.run(request).await,
    }
}

async fn scan_limit(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    match limit(&state, &state.scan_limiter, &request) {
        Some(refused) => refused,
        None => next.run(request).await,
    }
}

fn limit(
    state: &AppState,
    limiter: &crate::limits::RateLimiter,
    request: &Request,
) -> Option<Response> {
    // The server always supplies the peer address. Without one the request is
    // still counted, under a shared key, rather than skipping the limit.
    let client = match request.extensions().get::<ConnectInfo<SocketAddr>>() {
        Some(ConnectInfo(peer)) => {
            let forwarded = request
                .headers()
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok());
            state.clients.resolve(peer.ip(), forwarded)
        }
        None => "unknown".to_owned(),
    };
    let wait = limiter.hit(&client).err()?;
    let mut response = ApiError::too_many("Too many requests").into_response();
    if let Ok(seconds) = HeaderValue::from_str(&wait.as_secs().max(1).to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, seconds);
    }
    Some(response)
}

// -------------------------------------------------------------------- handlers

async fn list_devices(
    State(state): State<Arc<AppState>>,
    RawQuery(query): RawQuery,
) -> impl IntoResponse {
    let force = Query::new(query).get("force") == Some("true");
    Json(discover_devices(&state, force).await)
}

async fn device_info(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.hdhr.device_info(device(&id)?).await))
}

async fn scan(
    State(state): State<Arc<AppState>>,
    Path((id, tuner_text)): Path<(String, String)>,
    RawQuery(query): RawQuery,
) -> ApiResult<impl IntoResponse> {
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
    Ok(Json(state.hdhr.scan(id, tuner, channel_map).await?))
}

async fn tuner_status(
    State(state): State<Arc<AppState>>,
    Path((id, t)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    let (id, tuner) = device_and_tuner(&id, &t)?;
    Ok(Json(state.hdhr.tuner_status(id, tuner).await))
}

async fn programs(
    State(state): State<Arc<AppState>>,
    Path((id, t)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    let (id, tuner) = device_and_tuner(&id, &t)?;
    Ok(Json(state.hdhr.programs(id, tuner).await))
}

async fn plp_info(
    State(state): State<Arc<AppState>>,
    Path((id, t)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    let (id, tuner) = device_and_tuner(&id, &t)?;
    Ok(Json(plp_or_none(&state, id, tuner).await))
}

/// PLP details, or `None` for a device that has none or cannot answer. A device
/// that cannot answer fails the same way on every poll, so it is reported once.
pub async fn plp_or_none(
    state: &AppState,
    id: &str,
    tuner: u8,
) -> Option<hdhr_core::model::PlpMap> {
    match state.hdhr.plp_info(id, tuner).await {
        Ok(plps) => plps,
        Err(_) => {
            let first = state
                .plp_unavailable_logged
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(id.to_owned());
            if first {
                tracing::info!(
                    "PLP info not available from {} (no ATSC 3.0 support?); not logging again",
                    log_safe(id)
                );
            }
            None
        }
    }
}

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

async fn channel_up(
    State(state): State<Arc<AppState>>,
    Path((id, t)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    let (id, tuner) = device_and_tuner(&id, &t)?;
    Ok(done(state.hdhr.channel_up(id, tuner).await?))
}

async fn channel_down(
    State(state): State<Arc<AppState>>,
    Path((id, t)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    let (id, tuner) = device_and_tuner(&id, &t)?;
    Ok(done(state.hdhr.channel_down(id, tuner).await?))
}

async fn clear_tuner(
    State(state): State<Arc<AppState>>,
    Path((id, t)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    let (id, tuner) = device_and_tuner(&id, &t)?;
    Ok(done(state.hdhr.clear_tuner(id, tuner).await?))
}

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

async fn stream_url(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<impl IntoResponse> {
    let (url, ..) = program_url(&state, &id, &Query::new(query))?;
    Ok(Json(json!({ "url": url })))
}

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
