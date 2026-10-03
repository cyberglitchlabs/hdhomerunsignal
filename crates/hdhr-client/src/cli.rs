use std::ffi::OsString;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use async_trait::async_trait;
use hdhr_core::model::ScannedChannel;
use hdhr_core::parse::{Discovered, parse_discover, parse_scan};
use hdhr_core::validate;
use regex::Regex;
use tokio::process::Command;

use crate::{BackendError, DeviceBackend};

/// `/tuner0/status`, `/sys/model`: letters, digits, underscores and slashes
/// after a leading slash.
static VARIABLE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/[A-Za-z0-9_/]+$").unwrap());

/// How [`CliBackend`] runs the tool.
#[derive(Debug, Clone)]
pub struct CliConfig {
    /// The program to run, looked up on `PATH` unless it has a directory part.
    pub program: OsString,
    /// Limit for `get` and `set`.
    pub call_timeout: Duration,
    /// Limit for `discover`, which waits for devices to answer a broadcast.
    pub discover_timeout: Duration,
    /// Limit for `scan`. A full US scan of one tuner took about 100 seconds.
    pub scan_timeout: Duration,
}

impl Default for CliConfig {
    fn default() -> Self {
        Self {
            program: "hdhomerun_config".into(),
            call_timeout: Duration::from_secs(10),
            discover_timeout: Duration::from_secs(5),
            scan_timeout: Duration::from_secs(180),
        }
    }
}

/// Reaches devices by running `hdhomerun_config`. Arguments are passed as an
/// array, never through a shell, and every call has a timeout that kills the
/// process, so a hung device cannot hold a task forever.
#[derive(Debug, Clone, Default)]
pub struct CliBackend {
    config: CliConfig,
}

struct Output {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    success: bool,
}

impl CliBackend {
    pub fn new(config: CliConfig) -> Self {
        Self { config }
    }

    async fn run(&self, args: &[&str], timeout: Duration) -> Result<Output, BackendError> {
        let child = Command::new(&self.config.program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|source| BackendError::Spawn {
                program: self.config.program.to_string_lossy().into_owned(),
                source,
            })?;
        // Dropping the future on timeout drops the child, which kills it.
        let output = tokio::time::timeout(timeout, child.wait_with_output())
            .await
            .map_err(|_| BackendError::Timeout(timeout))?
            .map_err(|source| BackendError::Spawn {
                program: self.config.program.to_string_lossy().into_owned(),
                source,
            })?;
        Ok(Output {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            exit_code: output.status.code(),
            success: output.status.success(),
        })
    }

    /// The text of a failed call: what the tool printed, else its exit status.
    fn failure(output: &Output) -> BackendError {
        let said = if output.stderr.trim().is_empty() {
            &output.stdout
        } else {
            &output.stderr
        };
        let message = said.trim();
        BackendError::Failed {
            message: if message.is_empty() {
                format!("hdhomerun_config exited with {:?}", output.exit_code)
            } else {
                message.to_owned()
            },
            exit_code: output.exit_code,
        }
    }
}

fn check_device(device: &str) -> Result<&str, BackendError> {
    validate::device_host(device).ok_or(BackendError::InvalidArgument { what: "device" })
}

fn check_variable(variable: &str) -> Result<&str, BackendError> {
    if VARIABLE_RE.is_match(variable) {
        Ok(variable)
    } else {
        Err(BackendError::InvalidArgument { what: "variable" })
    }
}

#[async_trait]
impl DeviceBackend for CliBackend {
    async fn discover(&self, target: Option<&str>) -> Result<Vec<Discovered>, BackendError> {
        let output = match target {
            None => {
                self.run(&["discover"], self.config.discover_timeout)
                    .await?
            }
            Some(target) => {
                self.run(
                    &["discover", check_device(target)?],
                    self.config.discover_timeout,
                )
                .await?
            }
        };
        if !output.success {
            return Err(Self::failure(&output));
        }
        Ok(parse_discover(&output.stdout))
    }

    async fn get(&self, device: &str, variable: &str) -> Result<String, BackendError> {
        let args = [check_device(device)?, "get", check_variable(variable)?];
        let output = self.run(&args, self.config.call_timeout).await?;
        if !output.success {
            return Err(Self::failure(&output));
        }
        Ok(output.stdout.trim().to_owned())
    }

    async fn set(&self, device: &str, variable: &str, value: &str) -> Result<String, BackendError> {
        // A value is data, so it may be anything the device accepts (including
        // "-"), but a NUL cannot be passed as an argument at all.
        if value.contains('\0') {
            return Err(BackendError::InvalidArgument { what: "value" });
        }
        let args = [
            check_device(device)?,
            "set",
            check_variable(variable)?,
            value,
        ];
        let output = self.run(&args, self.config.call_timeout).await?;
        if !output.success {
            return Err(Self::failure(&output));
        }
        Ok(output.stdout.trim().to_owned())
    }

    async fn scan(
        &self,
        device: &str,
        tuner: u8,
        channel_map: &str,
    ) -> Result<Vec<ScannedChannel>, BackendError> {
        if tuner > validate::MAX_TUNER {
            return Err(BackendError::InvalidArgument { what: "tuner" });
        }
        let channel_map =
            validate::channel_map(channel_map).ok_or(BackendError::InvalidArgument {
                what: "channel map",
            })?;
        let target = format!("/tuner{tuner}");
        let output = self
            .run(
                &[check_device(device)?, "scan", &target, channel_map],
                self.config.scan_timeout,
            )
            .await?;
        // The tool exits with status 1 after a scan that completed, so a
        // non-zero status only counts as a failure when nothing was scanned.
        let channels = parse_scan(&output.stdout);
        if !output.success && !output.stdout.contains("SCANNING:") {
            return Err(Self::failure(&output));
        }
        Ok(channels)
    }
}
