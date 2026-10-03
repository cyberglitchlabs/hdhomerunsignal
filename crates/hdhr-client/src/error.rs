use std::time::Duration;

/// Why a call to a device failed.
#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    /// A value was refused before anything was run, because it could be read as
    /// an option or is not shaped like what the command expects.
    #[error("invalid {what}")]
    InvalidArgument { what: &'static str },
    /// The tool could not be started (not installed, not executable).
    #[error("could not run {program}: {source}")]
    Spawn {
        program: String,
        source: std::io::Error,
    },
    /// The call did not finish in time and was stopped.
    #[error("timed out after {0:?}")]
    Timeout(Duration),
    /// The tool or the device reported an error.
    #[error("{message}")]
    Failed {
        message: String,
        exit_code: Option<i32>,
    },
    /// The cloud lookup could not be reached or answered something unusable.
    #[error("cloud lookup failed: {0}")]
    Cloud(String),
}
