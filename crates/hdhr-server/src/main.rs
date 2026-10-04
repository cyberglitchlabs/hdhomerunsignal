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
use tokio::signal::unix::{Signal, SignalKind, signal};

/// How long open connections get to finish once a shutdown signal arrives.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[tokio::main]
async fn main() -> ExitCode {
    // `--openapi` prints the API description and exits, which is how the committed
    // copy in `api/openapi.json` is regenerated and checked.
    if std::env::args().nth(1).as_deref() == Some("--openapi") {
        print!("{}", hdhr_server::openapi::spec_json());
        return ExitCode::SUCCESS;
    }

    // `--healthcheck` asks the server already running on PORT whether it is well, for
    // the container's HEALTHCHECK, and exits 0 (well) or 1.
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        let port = std::env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3000);
        return match hdhr_server::healthcheck::check(port, Duration::from_secs(4)).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("unhealthy: {error}");
                ExitCode::FAILURE
            }
        };
    }

    // Logs go to stdout without colour, one line each, like the Node server's.
    tracing_subscriber::fmt()
        .with_ansi(false)
        .with_target(false)
        .without_time()
        .init();

    // Installed before the server can report it is ready: a signal that arrives
    // first would get the default action and kill the process without a clean
    // shutdown. The streams remember signals from here on, so one that arrives
    // before the server starts waiting on them is still acted on.
    let signals = match (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
    ) {
        (Ok(term), Ok(int)) => Some((term, int)),
        _ => {
            tracing::error!("Could not install signal handlers");
            None
        }
    };

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
    let app = router(state.clone()).into_make_service_with_connect_info::<SocketAddr>();

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

    let served = axum::serve(listener, app).with_graceful_shutdown(shutdown_signal(state, signals));
    match served.await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!("Server error: {error}");
            ExitCode::FAILURE
        }
    }
}

/// Resolves on SIGTERM or SIGINT, after ending every event stream (which would
/// otherwise stay open for ever), then starts a timer that ends the process if
/// connections stay open past [`SHUTDOWN_TIMEOUT`]. In a container the server is
/// PID 1, where a signal without a handler is ignored.
async fn shutdown_signal(state: Arc<AppState>, signals: Option<(Signal, Signal)>) {
    let Some((mut term, mut int)) = signals else {
        return std::future::pending().await;
    };
    let name = tokio::select! {
        _ = term.recv() => "SIGTERM",
        _ = int.recv() => "SIGINT",
    };
    tracing::info!("{name} received, shutting down");
    state.begin_shutdown();
    tokio::spawn(async {
        tokio::time::sleep(SHUTDOWN_TIMEOUT).await;
        tracing::error!("Shutdown timed out, forcing exit");
        std::process::exit(1);
    });
}
