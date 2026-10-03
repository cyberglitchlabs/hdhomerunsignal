//! The HTTP layer against a scripted backend, without starting a process. The
//! Node server's black-box tests (run with SERVER_CMD) cover parity; these cover
//! what is specific to this server.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use hdhr_client::{BackendError, CloudClient, DeviceBackend, Hdhr};
use hdhr_core::model::ScannedChannel;
use hdhr_core::parse::Discovered;
use hdhr_server::app::router;
use hdhr_server::config::Config;
use hdhr_server::state::AppState;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tower::ServiceExt;

#[derive(Default)]
struct Mock {
    gets: HashMap<String, String>,
    found: Vec<Discovered>,
    calls: Mutex<Vec<String>>,
}

impl Mock {
    fn with(mut self, variable: &str, value: &str) -> Self {
        self.gets.insert(variable.into(), value.into());
        self
    }
}

#[async_trait]
impl DeviceBackend for Mock {
    async fn discover(&self, target: Option<&str>) -> Result<Vec<Discovered>, BackendError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("discover {}", target.unwrap_or("*")));
        Ok(if target.is_none() {
            self.found.clone()
        } else {
            Vec::new()
        })
    }

    async fn get(&self, device: &str, variable: &str) -> Result<String, BackendError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("get {device} {variable}"));
        self.gets
            .get(variable)
            .cloned()
            .ok_or(BackendError::Failed {
                message: "ERROR: unknown getset variable".into(),
                exit_code: Some(1),
            })
    }

    async fn set(&self, device: &str, variable: &str, value: &str) -> Result<String, BackendError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("set {device} {variable} {value}"));
        Ok("ok".into())
    }

    async fn scan(
        &self,
        device: &str,
        tuner: u8,
        map: &str,
    ) -> Result<Vec<ScannedChannel>, BackendError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("scan {device} {tuner} {map}"));
        Ok(Vec::new())
    }
}

struct App {
    router: Router,
    state: Arc<AppState>,
    mock: Arc<Mock>,
}

fn config(vars: &[(&str, &str)]) -> Config {
    let vars: HashMap<String, String> = vars
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    Config::from_lookup(|name| vars.get(name).cloned()).unwrap()
}

fn app(mock: Mock, vars: &[(&str, &str)]) -> App {
    let mock = Arc::new(mock);
    let mut vars = vars.to_vec();
    vars.push(("HDHR_RATE_LIMIT", "0"));
    let cloud = CloudClient::new(
        vars.iter()
            .find(|(k, _)| *k == "HDHR_CLOUD_DISCOVERY_URL")
            .map_or("http://127.0.0.1:9/discover", |(_, v)| v),
    );
    let state = Arc::new(AppState::new(config(&vars), Hdhr::new(mock.clone()), cloud));
    App {
        router: router(state.clone()),
        state,
        mock,
    }
}

impl App {
    async fn send(&self, request: Request<Body>) -> (StatusCode, axum::http::HeaderMap, String) {
        let response = self.router.clone().oneshot(request).await.unwrap();
        let (status, headers) = (response.status(), response.headers().clone());
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, headers, String::from_utf8_lossy(&body).into_owned())
    }

    async fn get(&self, path: &str) -> (StatusCode, String) {
        let (status, _, body) = self
            .send(Request::get(path).body(Body::empty()).unwrap())
            .await;
        (status, body)
    }

    async fn post(
        &self,
        path: &str,
        content_type: Option<&str>,
        body: &str,
    ) -> (StatusCode, String) {
        let mut request = Request::post(path);
        if let Some(content_type) = content_type {
            request = request.header(header::CONTENT_TYPE, content_type);
        }
        let (status, _, body) = self
            .send(request.body(Body::from(body.to_owned())).unwrap())
            .await;
        (status, body)
    }

    fn calls(&self) -> Vec<String> {
        self.mock.calls.lock().unwrap().clone()
    }

    fn count(&self, call: &str) -> usize {
        self.calls().iter().filter(|c| *c == call).count()
    }
}

fn json_of(body: &str) -> Value {
    serde_json::from_str(body).unwrap_or_else(|e| panic!("{e}: {body:?}"))
}

fn static_dir(files: &[(&str, &str)]) -> PathBuf {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "hdhr-server-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    for (name, content) in files {
        let path = dir.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    fs::create_dir_all(&dir).unwrap();
    dir
}

// ------------------------------------------------------------ frontend & 404s

#[tokio::test]
async fn the_frontend_is_served_and_unknown_routes_fall_back_to_it() {
    let dir = static_dir(&[
        ("index.html", "<html>app</html>"),
        ("assets/app.js", "console.log(1)"),
    ]);
    let app = app(
        Mock::default(),
        &[("HDHR_STATIC_DIR", dir.to_str().unwrap())],
    );
    assert_eq!(
        app.get("/").await,
        (StatusCode::OK, "<html>app</html>".into())
    );
    assert_eq!(
        app.get("/assets/app.js").await,
        (StatusCode::OK, "console.log(1)".into())
    );
    // A client-side route survives a reload.
    assert_eq!(
        app.get("/signal/some-device").await,
        (StatusCode::OK, "<html>app</html>".into())
    );
    fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn unknown_api_paths_are_json_404s_not_the_frontend() {
    let dir = static_dir(&[("index.html", "<html>app</html>")]);
    let app = app(
        Mock::default(),
        &[("HDHR_STATIC_DIR", dir.to_str().unwrap())],
    );
    // The unversioned paths are gone: this is the breaking change.
    for path in [
        "/api/devices",
        "/api/version",
        "/api/v1/nothing",
        "/api/v1/devices/10.0.0.5/nothing",
        "/api/v2/devices",
    ] {
        let (status, body) = app.get(path).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(json_of(&body), json!({ "error": "Not found" }), "{path}");
    }
    fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn version_comes_from_the_built_frontend() {
    let dir = static_dir(&[(
        "build-version.json",
        r#"{"hash":"abc123","buildTime":"2026-10-03T00:00:00Z"}"#,
    )]);
    let app_with = app(
        Mock::default(),
        &[("HDHR_STATIC_DIR", dir.to_str().unwrap())],
    );
    assert_eq!(
        json_of(&app_with.get("/api/v1/version").await.1),
        json!({ "hash": "abc123", "buildTime": "2026-10-03T00:00:00Z" })
    );
    fs::remove_dir_all(dir).unwrap();

    let none = app(Mock::default(), &[("HDHR_STATIC_DIR", "/nonexistent")]);
    assert_eq!(
        json_of(&none.get("/api/v1/version").await.1),
        json!({ "hash": "unknown", "buildTime": null })
    );
    let broken = static_dir(&[("build-version.json", "not json")]);
    let app_broken = app(
        Mock::default(),
        &[("HDHR_STATIC_DIR", broken.to_str().unwrap())],
    );
    assert_eq!(
        json_of(&app_broken.get("/api/v1/version").await.1),
        json!({ "hash": "unknown", "buildTime": null })
    );
    fs::remove_dir_all(broken).unwrap();
}

// ------------------------------------------------------------------- requests

#[tokio::test]
async fn a_json_body_that_is_not_json_is_refused() {
    let app = app(Mock::default(), &[]);
    let path = "/api/v1/devices/10.0.0.5/tuner/0/channel";
    for body in ["{not json", "27", "\"27\"", "null"] {
        let (status, response) = app.post(path, Some("application/json"), body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(
            json_of(&response),
            json!({ "error": "Invalid JSON" }),
            "{body}"
        );
    }
    assert_eq!(app.calls(), Vec::<String>::new());
}

#[tokio::test]
async fn a_body_not_sent_as_json_counts_as_empty() {
    let app = app(Mock::default(), &[]);
    let path = "/api/v1/devices/10.0.0.5/tuner/0/channel";
    for content_type in [None, Some("text/plain")] {
        let (status, response) = app.post(path, content_type, r#"{"channel":"27"}"#).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json_of(&response), json!({ "error": "Invalid channel" }));
    }
    assert_eq!(app.calls(), Vec::<String>::new());
}

#[tokio::test]
async fn a_charset_on_the_content_type_is_fine() {
    let app = app(Mock::default(), &[]);
    let (status, response) = app
        .post(
            "/api/v1/devices/10.0.0.5/tuner/2/channel",
            Some("application/json; charset=utf-8"),
            r#"{"channel":"auto:34"}"#,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json_of(&response),
        json!({ "success": true, "result": "ok" })
    );
    assert_eq!(app.calls(), ["set 10.0.0.5 /tuner2/channel auto:34"]);
}

#[tokio::test]
async fn the_channel_must_be_a_string_but_atsc3_accepts_a_number() {
    let app = app(Mock::default(), &[]);
    let (status, _) = app
        .post(
            "/api/v1/devices/h/tuner/0/channel",
            Some("application/json"),
            r#"{"channel":27}"#,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // The same value an ATSC 3.0 request sends as a number or a digit string.
    for body in [
        r#"{"channel":27}"#,
        r#"{"channel":"27"}"#,
        r#"{"channel":27.0}"#,
    ] {
        let (status, _) = app
            .post(
                "/api/v1/devices/h/tuner/0/atsc3",
                Some("application/json"),
                body,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    assert_eq!(app.calls(), ["set h /tuner0/channel atsc3:27"; 3]);
    for body in [
        r#"{"channel":27.5}"#,
        r#"{"channel":true}"#,
        r#"{"channel":null}"#,
        r#"{"channel":{}}"#,
        r#"{}"#,
        r#"{"channel":"27","plps":"x"}"#,
    ] {
        let (status, _) = app
            .post(
                "/api/v1/devices/h/tuner/0/atsc3",
                Some("application/json"),
                body,
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
}

#[tokio::test]
async fn an_oversized_body_is_refused() {
    let app = app(Mock::default(), &[]);
    let body = format!(r#"{{"channel":"27","pad":"{}"}}"#, "x".repeat(20_000));
    let (status, _) = app
        .post(
            "/api/v1/devices/h/tuner/0/channel",
            Some("application/json"),
            &body,
        )
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(app.calls(), Vec::<String>::new());
}

#[tokio::test]
async fn a_repeated_query_parameter_is_not_a_value() {
    let app = app(
        Mock::default().with("/sys/hwmodel", "HDTC-2US"),
        &[("HDHOMERUN_DEVICES", "10.0.0.5")],
    );
    app.get("/api/v1/devices").await;
    let (status, _) = app
        .get("/api/v1/devices/10.0.0.5/stream/url?ch=27&ch=28&program=1")
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = app
        .get("/api/v1/devices/10.0.0.5/stream/url?ch=27&program=1")
        .await;
    assert_eq!(
        (status, json_of(&body)),
        (
            StatusCode::OK,
            json!({ "url": "http://10.0.0.5:5004/auto/ch27-1" })
        )
    );
}

#[tokio::test]
async fn a_playlist_without_a_name_is_named_after_the_channel() {
    let app = app(
        Mock::default().with("/sys/hwmodel", "HDTC-2US"),
        &[("HDHOMERUN_DEVICES", "10.0.0.5")],
    );
    app.get("/api/v1/devices").await;
    let (status, headers, body) = app
        .send(
            Request::get("/api/v1/devices/10.0.0.5/stream/play.m3u?ch=34&program=3&name=")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        "#EXTM3U\n#EXTINF:-1,Ch34 Program 3\nhttp://10.0.0.5:5004/auto/ch34-3\n"
    );
    assert_eq!(
        headers[header::CONTENT_DISPOSITION],
        "attachment; filename=\"ch34-3.m3u\""
    );

    let (_, headers, _) = app
        .send(
            Request::get(
                "/api/v1/devices/10.0.0.5/stream/play.m3u?ch=34&program=3&name=A%20%26%20B%2FC",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(
        headers[header::CONTENT_DISPOSITION],
        "attachment; filename=\"A___B_C.m3u\""
    );
}

#[tokio::test]
async fn unreachable_tuners_answer_null_or_empty_not_an_error() {
    let app = app(Mock::default(), &[]);
    assert_eq!(
        app.get("/api/v1/devices/h/tuner/0/status").await,
        (StatusCode::OK, "null".into())
    );
    assert_eq!(
        app.get("/api/v1/devices/h/tuner/0/programs").await,
        (StatusCode::OK, "[]".into())
    );
    assert_eq!(
        app.get("/api/v1/devices/h/tuner/0/plpinfo").await,
        (StatusCode::OK, "null".into())
    );
    assert_eq!(
        app.get("/api/v1/devices/h/tuner/0/l1info").await,
        (StatusCode::OK, "null".into())
    );
}

// ------------------------------------------------------------------ discovery

#[tokio::test]
async fn devices_added_by_address_are_remembered_until_a_refresh() {
    let app = app(
        Mock::default().with("/sys/hwmodel", "HDTC-2US"),
        &[
            ("HDHOMERUN_DEVICES", "10.0.0.5, bad host, 10.0.0.6"),
            ("HDHOMERUN_DISABLE_DISCOVERY", "true"),
        ],
    );
    let (_, body) = app.get("/api/v1/devices").await;
    let names: Vec<_> = json_of(&body)
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        names,
        ["10.0.0.5", "10.0.0.6"],
        "the invalid entry is skipped"
    );
    assert_eq!(app.count("get 10.0.0.5 /sys/hwmodel"), 1);

    app.get("/api/v1/devices").await;
    assert_eq!(app.count("get 10.0.0.5 /sys/hwmodel"), 1, "remembered");
    app.get("/api/v1/devices?force=true").await;
    assert_eq!(
        app.count("get 10.0.0.5 /sys/hwmodel"),
        2,
        "Refresh asks again"
    );
    app.get("/api/v1/devices?force=false").await;
    assert_eq!(
        app.count("get 10.0.0.5 /sys/hwmodel"),
        2,
        "only the exact word forces"
    );
}

#[tokio::test]
async fn an_unreachable_device_is_listed_offline() {
    let app = app(
        Mock::default(),
        &[
            ("HDHOMERUN_DEVICES", "10.0.0.9"),
            ("HDHOMERUN_DISABLE_DISCOVERY", "true"),
        ],
    );
    let (_, body) = app.get("/api/v1/devices").await;
    assert_eq!(
        json_of(&body),
        json!([{ "id": "10.0.0.9", "ip": "10.0.0.9", "name": "HDHomeRun (10.0.0.9)", "online": false }])
    );
}

#[tokio::test]
async fn playlists_and_stream_urls_only_serve_devices_on_the_list() {
    let app = app(
        Mock::default().with("/sys/hwmodel", "X"),
        &[
            ("HDHOMERUN_DEVICES", "10.0.0.5"),
            ("HDHOMERUN_DISABLE_DISCOVERY", "true"),
        ],
    );
    let (status, _) = app
        .get("/api/v1/devices/10.0.0.5/stream/url?ch=27&program=1")
        .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "nothing has been discovered yet"
    );
    app.get("/api/v1/devices").await;
    assert_eq!(
        app.get("/api/v1/devices/10.0.0.5/stream/url?ch=27&program=1")
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        app.get("/api/v1/devices/10.0.0.6/stream/url?ch=27&program=1")
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.state.find_device("10.0.0.5").unwrap().name,
        "HDHomeRun X (10.0.0.5)"
    );
}

/// Serves `body` for as many requests as arrive, counting them.
async fn cloud_stub(body: &'static str) -> (String, Arc<AtomicU32>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/discover", listener.local_addr().unwrap());
    let hits = Arc::new(AtomicU32::new(0));
    let counter = hits.clone();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            counter.fetch_add(1, Ordering::SeqCst);
            let mut buffer = vec![0u8; 4096];
            let _ = socket.read(&mut buffer).await;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    (url, hits)
}

#[tokio::test]
async fn the_cloud_lookup_runs_once_until_the_user_refreshes() {
    let (url, hits) = cloud_stub(r#"[{"DeviceID":"10548B20","LocalIP":"192.168.100.61"}]"#).await;
    let app = app(
        Mock::default().with("/sys/hwmodel", "HDTC-2US"),
        &[("HDHR_CLOUD_DISCOVERY_URL", &url)],
    );

    let (_, first) = app.get("/api/v1/devices").await;
    assert_eq!(
        json_of(&first),
        json!([{ "id": "192.168.100.61", "ip": "192.168.100.61", "name": "HDHomeRun 10548B20 (HDTC-2US)", "online": true }])
    );
    let (_, again) = app.get("/api/v1/devices").await;
    assert_eq!(again, first);
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "automatic calls reuse the result"
    );
    app.get("/api/v1/devices?force=true").await;
    assert_eq!(hits.load(Ordering::SeqCst), 2, "Refresh looks again");
}

#[tokio::test]
async fn a_failing_cloud_lookup_is_remembered_too_and_the_list_is_empty() {
    let app = app(Mock::default(), &[]); // the default stub URL has nothing listening
    assert_eq!(
        app.get("/api/v1/devices").await,
        (StatusCode::OK, "[]".into())
    );
    assert_eq!(
        app.get("/api/v1/devices").await,
        (StatusCode::OK, "[]".into())
    );
    assert_eq!(
        app.count("discover *"),
        2,
        "the local broadcast still runs every time"
    );
}

#[tokio::test]
async fn a_local_device_means_no_cloud_lookup() {
    let (url, hits) = cloud_stub("[]").await;
    let mock = Mock {
        found: vec![Discovered {
            device_id: "10548B20".into(),
            ip: "192.168.100.61".into(),
        }],
        ..Mock::default()
    }
    .with("/sys/hwmodel", "HDTC-2US");
    let app = app(mock, &[("HDHR_CLOUD_DISCOVERY_URL", &url)]);
    let (_, body) = app.get("/api/v1/devices?force=true").await;
    assert_eq!(json_of(&body)[0]["id"], "10548B20");
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}
