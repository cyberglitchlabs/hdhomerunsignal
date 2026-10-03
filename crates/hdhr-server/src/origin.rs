//! Browser origin checks. The UI is served by this server, so cross-origin
//! access is off unless an origin is listed in `HDHR_ALLOWED_ORIGINS`. A browser
//! does not enforce CORS on every kind of request, so the server checks
//! `Origin` itself: no `Origin` (not a browser), the same host, or an allowed one.

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use url::Url;

use crate::error::ApiError;
use crate::state::AppState;

/// Whether a request carrying `origin` and addressed to `host` may use the API.
pub fn is_origin_allowed(
    allowed: &HashSet<String>,
    origin: Option<&str>,
    host: Option<&str>,
) -> bool {
    let Some(origin) = origin else { return true };
    if allowed.contains(origin) {
        return true;
    }
    // The origin's host and port, as a browser writes them: a default port is omitted.
    let Ok(url) = Url::parse(origin) else {
        return false;
    };
    let Some(origin_host) = url.host_str() else {
        return false;
    };
    let origin_host = match url.port() {
        Some(port) => format!("{origin_host}:{port}"),
        None => origin_host.to_owned(),
    };
    host == Some(origin_host.as_str())
}

pub async fn check(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    // Owned copies, taken in a block of their own so that nothing borrowed from
    // the request is still alive at the await below.
    let (origin, host, is_api, preflight) = {
        let header_text = |name| {
            request
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        (
            header_text(header::ORIGIN),
            header_text(header::HOST),
            request.uri().path().starts_with("/api/"),
            request.method() == Method::OPTIONS,
        )
    };

    match origin {
        Some(origin) if state.config.allowed_origins.contains(&origin) => {
            let mut response = if preflight {
                StatusCode::NO_CONTENT.into_response()
            } else {
                next.run(request).await
            };
            let headers = response.headers_mut();
            if let Ok(value) = HeaderValue::from_str(&origin) {
                headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
            }
            headers.insert(header::VARY, HeaderValue::from_static("Origin"));
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static("GET, POST"),
            );
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static("Content-Type"),
            );
            response
        }
        Some(origin)
            if is_api
                && !is_origin_allowed(
                    &state.config.allowed_origins,
                    Some(&origin),
                    host.as_deref(),
                ) =>
        {
            ApiError::forbidden("Origin not allowed").into_response()
        }
        _ => next.run(request).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(origins: &[&str]) -> HashSet<String> {
        origins.iter().map(|o| o.to_string()).collect()
    }

    #[test]
    fn no_origin_is_allowed() {
        assert!(is_origin_allowed(
            &allowed(&[]),
            None,
            Some("hdhr.local:3000")
        ));
    }

    #[test]
    fn the_same_host_is_allowed() {
        let none = allowed(&[]);
        assert!(is_origin_allowed(
            &none,
            Some("http://hdhr.local:3000"),
            Some("hdhr.local:3000")
        ));
        assert!(is_origin_allowed(
            &none,
            Some("https://hdhr.local"),
            Some("hdhr.local")
        ));
        assert!(is_origin_allowed(
            &none,
            Some("http://HDHR.local:3000"),
            Some("hdhr.local:3000")
        ));
        // A default port is not part of the host.
        assert!(is_origin_allowed(
            &none,
            Some("http://hdhr.local:80"),
            Some("hdhr.local")
        ));
    }

    #[test]
    fn a_listed_origin_is_allowed() {
        let list = allowed(&["https://dash.example"]);
        assert!(is_origin_allowed(
            &list,
            Some("https://dash.example"),
            Some("hdhr.local")
        ));
        assert!(!is_origin_allowed(
            &list,
            Some("https://dash.example:8443"),
            Some("hdhr.local")
        ));
    }

    #[test]
    fn lookalikes_and_malformed_origins_are_refused() {
        let none = allowed(&[]);
        let host = Some("127.0.0.1:3000");
        for origin in [
            "http://127.0.0.1:3000.evil.example",
            "http://evil.example/127.0.0.1:3000",
            "null",
            "not a url",
            "https://dash.example.evil.example",
            "",
            "http://127.0.0.1:3001",
        ] {
            assert!(!is_origin_allowed(&none, Some(origin), host), "{origin:?}");
        }
        assert!(!is_origin_allowed(&none, Some("http://hdhr.local"), None));
    }
}
