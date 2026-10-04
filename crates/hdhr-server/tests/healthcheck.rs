//! The health check against the real router, and against servers that misbehave.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use hdhr_client::{BackendError, CloudClient, DeviceBackend, Hdhr};
use hdhr_core::model::ScannedChannel;
use hdhr_core::parse::Discovered;
use hdhr_server::config::Config;
use hdhr_server::healthcheck::check;
use hdhr_server::state::AppState;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

struct Nothing;

#[async_trait]
impl DeviceBackend for Nothing {
    async fn discover(&self, _: Option<&str>) -> Result<Vec<Discovered>, BackendError> {
        Ok(Vec::new())
    }
    async fn get(&self, _: &str, _: &str) -> Result<String, BackendError> {
        Err(BackendError::Failed {
            message: "no device".into(),
            exit_code: None,
        })
    }
    async fn set(&self, _: &str, _: &str, _: &str) -> Result<String, BackendError> {
        Err(BackendError::Failed {
            message: "no device".into(),
            exit_code: None,
        })
    }
    async fn scan(&self, _: &str, _: u8, _: &str) -> Result<Vec<ScannedChannel>, BackendError> {
        Ok(Vec::new())
    }
}

const LIMIT: Duration = Duration::from_secs(2);

/// A server that answers every request with `response`, verbatim.
async fn canned(response: &'static str) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 1024];
            let _ = socket.read(&mut buffer).await;
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    port
}

#[tokio::test]
async fn a_running_server_is_healthy() {
    let vars: HashMap<String, String> = HashMap::new();
    let config = Config::from_lookup(|name| vars.get(name).cloned()).unwrap();
    let state = AppState::new(
        config,
        Hdhr::new(Arc::new(Nothing)),
        CloudClient::new("http://127.0.0.1:9/discover"),
    );
    let app = hdhr_server::app::router(Arc::new(state))
        .into_make_service_with_connect_info::<std::net::SocketAddr>();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await });

    assert_eq!(check(port, LIMIT).await, Ok(()));
}

#[tokio::test]
async fn only_a_200_is_healthy() {
    assert_eq!(
        check(
            canned("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await,
            LIMIT
        )
        .await,
        Ok(())
    );
    assert_eq!(
        check(canned("HTTP/1.0 200 OK\r\n\r\n").await, LIMIT).await,
        Ok(())
    );
    for response in [
        "HTTP/1.1 500 Internal Server Error\r\n\r\n",
        "HTTP/1.1 404 Not Found\r\n\r\n",
        "HTTP/1.1 429 Too Many Requests\r\n\r\n",
        "HTTP/1.1 301 Moved Permanently\r\n\r\n",
        "not http at all\r\n",
        "200 OK\r\n",
        "",
    ] {
        let error = check(canned(response).await, LIMIT)
            .await
            .expect_err(response);
        assert!(error.contains("unexpected answer"), "{response:?}: {error}");
    }
}

#[tokio::test]
async fn nothing_listening_is_unhealthy() {
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = closed.local_addr().unwrap().port();
    drop(closed);
    let error = check(port, LIMIT).await.unwrap_err();
    assert!(error.contains("could not connect"), "{error}");
}

#[tokio::test]
async fn a_server_that_never_answers_times_out() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (_socket, _) = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
    });
    let started = std::time::Instant::now();
    let error = check(port, Duration::from_millis(300)).await.unwrap_err();
    assert!(error.contains("no answer within"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(2));
}
