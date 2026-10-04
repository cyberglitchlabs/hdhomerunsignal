//! The OpenAPI description of the API, built from the same route registrations
//! that serve it.

use std::sync::Arc;

use axum::Router;
use utoipa::OpenApi;
use utoipa::openapi::OpenApi as Spec;
use utoipa_axum::router::OpenApiRouter;

use crate::routes;
use crate::schema::{AntennaReading, TunerEvent};
use crate::state::AppState;

/// Where the API is served, and so the prefix of every path in the spec.
pub const API_PREFIX: &str = "/api/v1";

#[derive(OpenApi)]
#[openapi(
    info(
        title = "HDHomeRun Signal API",
        version = "1.0.0",
        description = "Control and watch HDHomeRun tuners.\n\n\
## Event streams\n\n\
`GET /devices/{id}/tuner/{tuner}/stream` and `GET /devices/{id}/antenna/stream` are [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html), \
which OpenAPI cannot describe as a stream, so they are documented here. Open one with `EventSource`; closing the connection ends the subscription, and `EventSource` reconnects by itself.\n\n\
* The tuner stream sends a `tuner-status` event about once a second, whose data is a `TunerEvent`.\n\
* The antenna stream sends an `antenna-mode-status` event about once a second, whose data is an array of `AntennaReading`, one per tuner.\n\
* The first reading is sent as soon as the stream opens, and a comment line (`: keepalive`) every 15 seconds keeps idle proxies from closing it.\n\
* A client may hold a limited number of streams (`HDHR_MAX_STREAMS_PER_CLIENT`, 16 by default); beyond that the answer is 429, and `EventSource` does not retry after one.\n\n\
## Versioning\n\n\
Everything is under `/api/v1`. The unversioned `/api/...` paths of earlier releases, and their Socket.IO endpoint, no longer exist.",
    ),
    tags(
        (name = "devices", description = "Finding devices."),
        (name = "tuners", description = "Reading a tuner."),
        (name = "tuning", description = "Changing what a tuner is tuned to."),
        (name = "streaming", description = "Watching a program and the live event streams."),
        (name = "app", description = "The frontend."),
    ),
    components(schemas(TunerEvent, AntennaReading))
)]
struct ApiDoc;

/// The API's routes, nested under [`API_PREFIX`], and its spec.
pub fn build() -> (Router<Arc<AppState>>, Spec) {
    let (router, mut spec) = OpenApiRouter::with_openapi(ApiDoc::openapi())
        .nest(API_PREFIX, routes::api().fallback(routes::api_not_found))
        .split_for_parts();
    // utoipa fills the licence from Cargo.toml, which has none: an empty name is not one.
    spec.info.license = None;
    (router, spec)
}

/// The spec as pretty-printed JSON, ending in a newline. This is what
/// `api/openapi.json` holds.
pub fn spec_json() -> String {
    let (_, spec) = build();
    let mut json = spec.to_pretty_json().expect("the spec serializes");
    json.push('\n');
    json
}
