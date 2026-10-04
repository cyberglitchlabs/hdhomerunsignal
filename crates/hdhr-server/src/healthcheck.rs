//! `hdhr-server --healthcheck`: asks the running server for its version and exits
//! 0 if it answers 200, 1 otherwise. The image has no `curl` and no Node, so the
//! binary checks itself, with a plain TCP request to the loopback address.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// What the check asks for: a cheap route that touches no device.
pub const HEALTH_PATH: &str = "/api/v1/version";

/// Asks the server on `127.0.0.1:port` for [`HEALTH_PATH`]. The whole check,
/// connecting included, must finish within `limit`.
pub async fn check(port: u16, limit: Duration) -> Result<(), String> {
    tokio::time::timeout(limit, request(port))
        .await
        .map_err(|_| format!("no answer within {limit:?}"))?
}

async fn request(port: u16) -> Result<(), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .map_err(|e| format!("could not connect: {e}"))?;
    let request = format!(
        "GET {HEALTH_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("could not send: {e}"))?;

    // The status line is all that matters, and it is in the first bytes.
    let mut head = [0u8; 64];
    let mut read = 0;
    while read < head.len() && !head[..read].contains(&b'\n') {
        match stream
            .read(&mut head[read..])
            .await
            .map_err(|e| format!("could not read: {e}"))?
        {
            0 => break,
            n => read += n,
        }
    }
    let line = String::from_utf8_lossy(&head[..read]);
    let status = line.lines().next().unwrap_or_default();
    match status.split_whitespace().collect::<Vec<_>>().as_slice() {
        [version, "200", ..] if version.starts_with("HTTP/") => Ok(()),
        _ => Err(format!("unexpected answer {status:?}")),
    }
}
