use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use hdhr_client::{CliBackend, CloudClient, Hdhr};
use hdhr_core::validate::log_safe;
use hdhr_server::app::router;
use hdhr_server::config::Config;
use hdhr_server::state::AppState;
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};

/// How long open connections get to finish once a shutdown signal arrives.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[tokio::main]
async fn main() -> ExitCode {
    // Logs go to stdout without colour, one line each, like the Node server's.
    tracing_subscriber::fmt()
        .with_ansi(false)
        .with_target(false)
        .without_time()
        .init();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            tracing::error!("{}", log_safe(error));
            return ExitCode::FAILURE;
        }
    };

    let hdhr = Hdhr::new(Arc::new(CliBackend::default()));
    let state = Arc::new(AppState::new(
        config.clone(),
        hdhr,
        CloudClient::new(config.cloud_discovery_url.clone()),
    ));
    let app = router(state).into_make_service_with_connect_info::<SocketAddr>();

    let listener = match TcpListener::bind(("0.0.0.0", config.port)).await {
        Ok(listener) => listener,
        Err(error) => {
            tracing::error!("Could not listen on port {}: {error}", config.port);
            return ExitCode::FAILURE;
        }
    };
    // Report the bound port (not PORT) so PORT=0 is usable, e.g. by the tests.
    match listener.local_addr() {
        Ok(address) => tracing::info!("HDHomeRun Signal server running on port {}", address.port()),
        Err(error) => {
            tracing::error!("Could not read the listening address: {error}");
            return ExitCode::FAILURE;
        }
    }

    let served = axum::serve(listener, app).with_graceful_shutdown(shutdown_signal());
    match served.await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!("Server error: {error}");
            ExitCode::FAILURE
        }
    }
}

/// Resolves on SIGTERM or SIGINT, then starts a timer that ends the process if
/// connections stay open past [`SHUTDOWN_TIMEOUT`]. In a container the server is
/// PID 1, where a signal without a handler is ignored.
async fn shutdown_signal() {
    let (Ok(mut term), Ok(mut int)) = (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
    ) else {
        tracing::error!("Could not install signal handlers");
        return std::future::pending().await;
    };
    let name = tokio::select! {
        _ = term.recv() => "SIGTERM",
        _ = int.recv() => "SIGINT",
    };
    tracing::info!("{name} received, shutting down");
    tokio::spawn(async {
        tokio::time::sleep(SHUTDOWN_TIMEOUT).await;
        tracing::error!("Shutdown timed out, forcing exit");
        std::process::exit(1);
    });
}
