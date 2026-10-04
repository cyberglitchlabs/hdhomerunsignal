//! The OpenAPI spec: that the committed copy is current, that it is well formed,
//! and that the interactive docs page only exists when asked for.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use hdhr_client::{BackendError, CloudClient, DeviceBackend, Hdhr};
use hdhr_core::model::ScannedChannel;
use hdhr_core::parse::Discovered;
use hdhr_server::config::Config;
use hdhr_server::openapi::spec_json;
use hdhr_server::state::AppState;
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

/// A backend that knows no devices.
struct Nothing;

#[async_trait]
impl DeviceBackend for Nothing {
    async fn discover(&self, _: Option<&str>) -> Result<Vec<Discovered>, BackendError> {
        Ok(Vec::new())
    }

    async fn get(&self, _: &str, _: &str) -> Result<String, BackendError> {
        Err(BackendError::Failed {
            message: "no device".into(),
            exit_code: Some(1),
        })
    }

    async fn set(&self, _: &str, _: &str, _: &str) -> Result<String, BackendError> {
        Err(BackendError::Failed {
            message: "no device".into(),
            exit_code: Some(1),
        })
    }

    async fn scan(&self, _: &str, _: u8, _: &str) -> Result<Vec<ScannedChannel>, BackendError> {
        Ok(Vec::new())
    }
}

fn router(vars: &[(&str, &str)]) -> axum::Router {
    let vars: HashMap<String, String> = vars
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let config = Config::from_lookup(|name| vars.get(name).cloned()).unwrap();
    let state = AppState::new(
        config,
        Hdhr::new(Arc::new(Nothing)),
        CloudClient::new("http://127.0.0.1:9/discover"),
    );
    hdhr_server::app::router(Arc::new(state))
}

async fn get(
    router: &axum::Router,
    request: Request<Body>,
) -> (StatusCode, axum::http::HeaderMap, String) {
    let response = router.clone().oneshot(request).await.unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, String::from_utf8_lossy(&body).into_owned())
}

fn spec() -> Value {
    serde_json::from_str(&spec_json()).unwrap()
}

// ---------------------------------------------------------------- the committed copy

fn committed_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../api/openapi.json")
}

/// The committed `api/openapi.json` is what generated clients are built from, so
/// it must be what the server describes. Regenerate it with
/// `UPDATE_OPENAPI=1 cargo test -p hdhr-server --test openapi` (or
/// `hdhr-server --openapi > api/openapi.json`).
#[test]
fn the_committed_spec_is_current() {
    let generated = spec_json();
    if std::env::var_os("UPDATE_OPENAPI").is_some() {
        std::fs::write(committed_path(), &generated).unwrap();
        return;
    }
    let committed =
        std::fs::read_to_string(committed_path()).expect("api/openapi.json is committed");
    assert!(
        committed == generated,
        "api/openapi.json is out of date. Regenerate it with:\n    UPDATE_OPENAPI=1 cargo test -p hdhr-server --test openapi"
    );
}

// --------------------------------------------------------------------- well formed

#[test]
fn the_spec_describes_the_whole_api() {
    let spec = spec();
    assert_eq!(spec["openapi"], "3.1.0");
    let paths: HashSet<&str> = spec["paths"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(paths.len(), 18);
    assert!(
        paths.iter().all(|path| path.starts_with("/api/v1/")),
        "{paths:?}"
    );
    for expected in [
        "/api/v1/devices",
        "/api/v1/devices/{id}/channelmaps",
        "/api/v1/devices/{id}/tuner/{tuner}/stream",
        "/api/v1/devices/{id}/antenna/stream",
        "/api/v1/devices/{id}/scan/{tuner}",
        "/api/v1/version",
    ] {
        assert!(paths.contains(expected), "{expected}");
    }
    // The unversioned paths of earlier releases are not described, because they are gone.
    assert!(!paths.iter().any(|p| p.starts_with("/api/devices")));
}

#[test]
fn every_reference_resolves_and_every_operation_is_documented() {
    let spec = spec();
    let schemas: HashSet<String> = spec["components"]["schemas"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    let declared_tags: HashSet<&str> = spec["tags"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();

    fn refs(value: &Value, found: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (key, value) in map {
                    if key == "$ref" {
                        found.push(value.as_str().unwrap().to_owned());
                    } else {
                        refs(value, found);
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|item| refs(item, found)),
            _ => {}
        }
    }
    let mut found = Vec::new();
    refs(&spec, &mut found);
    assert!(!found.is_empty());
    for reference in found {
        let name = reference
            .strip_prefix("#/components/schemas/")
            .unwrap_or_else(|| panic!("{reference}"));
        assert!(schemas.contains(name), "dangling reference {reference}");
    }

    for (path, operations) in spec["paths"].as_object().unwrap() {
        for (method, operation) in operations.as_object().unwrap() {
            let at = format!("{} {path}", method.to_uppercase());
            assert!(
                operation["summary"].as_str().is_some_and(|s| !s.is_empty()),
                "{at} has no summary"
            );
            for tag in operation["tags"]
                .as_array()
                .unwrap_or_else(|| panic!("{at} has no tags"))
            {
                assert!(
                    declared_tags.contains(tag.as_str().unwrap()),
                    "{at}: undeclared tag {tag}"
                );
            }
            // Every {placeholder} in the path is a declared path parameter.
            let declared: HashSet<&str> = operation["parameters"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|p| p["in"] == "path")
                .map(|p| p["name"].as_str().unwrap())
                .collect();
            for placeholder in path
                .split('/')
                .filter_map(|s| s.strip_prefix('{').and_then(|s| s.strip_suffix('}')))
            {
                assert!(
                    declared.contains(placeholder),
                    "{at}: {placeholder} is not declared"
                );
            }
            assert!(
                operation["responses"]
                    .as_object()
                    .unwrap()
                    .contains_key("200"),
                "{at}"
            );
        }
    }
}

#[test]
fn the_event_streams_are_described_as_such() {
    let spec = spec();
    for path in [
        "/api/v1/devices/{id}/tuner/{tuner}/stream",
        "/api/v1/devices/{id}/antenna/stream",
    ] {
        let content = &spec["paths"][path]["get"]["responses"]["200"]["content"];
        assert!(
            content.get("text/event-stream").is_some(),
            "{path}: {content}"
        );
        assert!(content.get("application/json").is_none());
    }
    let required: HashSet<&str> = spec["components"]["schemas"]["TunerEvent"]["required"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    // Always present, even when null; everything else is left out for a tuner that did not answer.
    assert_eq!(
        required,
        HashSet::from(["currentProgram", "plpInfo", "l1Info"])
    );
    assert!(
        spec["info"]["description"]
            .as_str()
            .unwrap()
            .contains("Server-Sent Events")
    );
}

#[test]
fn there_is_no_made_up_licence() {
    assert!(spec()["info"].get("license").is_none());
}

// ----------------------------------------------------- served, and the docs page

#[tokio::test]
async fn the_spec_is_served_at_openapi_json() {
    let router = router(&[]);
    let (status, headers, body) = get(
        &router,
        Request::get("/api/v1/openapi.json")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        headers[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("application/json")
    );
    let served: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(served["openapi"], "3.1.0");
    assert_eq!(
        served["paths"],
        spec()["paths"],
        "the served spec describes the same paths"
    );
}

#[tokio::test]
async fn the_docs_page_is_unreachable_unless_enabled() {
    for vars in [
        &[][..],
        &[("HDHR_ENABLE_DOCS", "false")],
        &[("HDHR_ENABLE_DOCS", "1")],
    ] {
        let router = router(vars);
        let (status, _, body) = get(
            &router,
            Request::get("/api/v1/docs").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{vars:?}");
        assert!(body.contains("Not found"), "{body}");
    }
}

#[tokio::test]
async fn the_docs_page_is_served_when_enabled() {
    let router = router(&[("HDHR_ENABLE_DOCS", "true")]);
    let (status, headers, body) = get(
        &router,
        Request::get("/api/v1/docs").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        headers[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );
    assert!(
        body.contains("HDHomeRun Signal API"),
        "the page embeds the spec"
    );
}

#[tokio::test]
async fn every_path_in_the_spec_is_served() {
    // Fill the placeholders with values that pass validation, then make sure the
    // route exists: it must answer something other than the router's own 404/405.
    let router = router(&[("HDHR_RATE_LIMIT", "0")]);
    for (path, operations) in spec()["paths"].as_object().unwrap() {
        for method in operations.as_object().unwrap().keys() {
            let url = path.replace("{id}", "10.0.0.5").replace("{tuner}", "0");
            let url = if url.contains("antenna/stream") {
                format!("{url}?tuners=1")
            } else {
                url
            };
            if path.ends_with("/stream") {
                continue; // opens a stream that never ends; the stream tests cover these
            }
            let request = Request::builder()
                .method(method.to_uppercase().as_str())
                .uri(&url)
                .body(Body::empty())
                .unwrap();
            let (status, _, body) = get(&router, request).await;
            assert_ne!(status, StatusCode::METHOD_NOT_ALLOWED, "{method} {url}");
            assert!(
                !(status == StatusCode::NOT_FOUND && body.contains("\"Not found\"")),
                "{method} {url} is in the spec but not served"
            );
        }
    }
}
