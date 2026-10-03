use std::path::Path;
use std::sync::Arc;

use axum::Router;
use axum::middleware;
use axum::routing::any;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::origin;
use crate::routes::{self, BODY_LIMIT};
use crate::state::AppState;

/// The whole application: the API under `/api/v1`, then the built frontend for
/// everything else, with unknown paths falling back to its `index.html` so that
/// client-side routes survive a reload. Unknown paths under `/api/` are JSON
/// 404s instead.
pub fn router(state: Arc<AppState>) -> Router {
    let dir = &state.config.static_dir;
    Router::new()
        .nest(
            "/api/v1",
            routes::api(state.clone()).fallback(routes::api_not_found),
        )
        .route("/api/{*path}", any(routes::api_not_found))
        .fallback_service(frontend(dir))
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
