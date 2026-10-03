//! The cloud lookup against a one-shot local HTTP server.

use hdhr_client::{BackendError, CloudClient};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const BODY: &str = include_str!("../../hdhr-core/tests/fixtures/synthetic-cloud-discover.json");

/// Serves one canned response and returns the URL to request, plus the request
/// line the client sent.
async fn serve(status: &str, body: &str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/discover", listener.local_addr().unwrap());
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let handle = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = vec![0u8; 4096];
        let read = socket.read(&mut buffer).await.unwrap();
        socket.write_all(response.as_bytes()).await.unwrap();
        String::from_utf8_lossy(&buffer[..read])
            .lines()
            .next()
            .unwrap_or_default()
            .to_owned()
    });
    (url, handle)
}

#[tokio::test]
async fn fetch_returns_the_tuners() {
    let (url, request) = serve("200 OK", BODY).await;
    let devices = CloudClient::new(url).fetch().await.unwrap();
    assert_eq!(request.await.unwrap(), "GET /discover HTTP/1.1");
    assert_eq!(devices.len(), 1);
    assert_eq!(
        (devices[0].device_id.as_str(), devices[0].local_ip.as_str()),
        ("10548B20", "192.168.100.61")
    );
}

#[tokio::test]
async fn an_empty_list_is_not_an_error() {
    let (url, _) = serve("200 OK", "[]").await;
    assert!(CloudClient::new(url).fetch().await.unwrap().is_empty());
}

#[tokio::test]
async fn errors_are_reported_not_swallowed() {
    let (url, _) = serve("500 Internal Server Error", "oops").await;
    assert!(matches!(
        CloudClient::new(url).fetch().await,
        Err(BackendError::Cloud(_))
    ));

    let (url, _) = serve("200 OK", "<html>not json</html>").await;
    assert!(matches!(
        CloudClient::new(url).fetch().await,
        Err(BackendError::Cloud(_))
    ));

    // Nothing is listening.
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/discover", closed.local_addr().unwrap());
    drop(closed);
    assert!(matches!(
        CloudClient::new(url).fetch().await,
        Err(BackendError::Cloud(_))
    ));
}

#[tokio::test]
async fn the_error_does_not_leak_the_url() {
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/discover", closed.local_addr().unwrap());
    drop(closed);
    let Err(BackendError::Cloud(message)) = CloudClient::new(url.clone()).fetch().await else {
        panic!()
    };
    assert!(!message.contains(&url), "{message}");
}
