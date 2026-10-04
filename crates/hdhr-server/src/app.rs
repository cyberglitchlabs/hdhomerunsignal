use std::path::Path;
use std::sync::Arc;

use axum::Router;
use axum::middleware;
use axum::routing::{any, get};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::services::{ServeDir, ServeFile};
use utoipa_scalar::{Scalar, Servable};

use crate::openapi::{self, API_PREFIX};
use crate::origin;
use crate::routes::{self, BODY_LIMIT};
use crate::state::AppState;

/// The whole application: the API under `/api/v1`, then the built frontend for
/// everything else, with unknown paths falling back to its `index.html` so that
/// client-side routes survive a reload. Unknown paths under `/api/` are JSON
/// 404s instead.
///
/// `GET /api/v1/openapi.json` always serves the spec. The interactive page that
/// renders it, `GET /api/v1/docs`, only exists when `HDHR_ENABLE_DOCS=true`: the
/// app is meant to be locked down, and the page loads its script from a CDN.
pub fn router(state: Arc<AppState>) -> Router {
    let (api, spec) = openapi::build();
    let json = serde_json::to_string(&spec).expect("the spec serializes");
    let mut router = api.route(
        &format!("{API_PREFIX}/openapi.json"),
        get(move || {
            let json = json.clone();
            async move {
                (
                    [(axum::http::header::CONTENT_TYPE, "application/json")],
                    json,
                )
            }
        }),
    );
    if state.config.enable_docs {
        router = router.merge(Scalar::with_url(format!("{API_PREFIX}/docs"), spec));
    }

    router
        .route("/api/{*path}", any(routes::api_not_found))
        .fallback_service(frontend(&state.config.static_dir))
        .layer(RequestBodyLimitLayer::new(BODY_LIMIT))
        .layer(middleware::from_fn_with_state(state.clone(), origin::check))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            routes::general_limit,
        ))
        .with_state(state)
}

fn frontend(dir: &Path) -> ServeDir<ServeFile> {
    ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")))
}
