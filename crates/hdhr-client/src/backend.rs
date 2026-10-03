use async_trait::async_trait;
use hdhr_core::model::ScannedChannel;
use hdhr_core::parse::Discovered;

use crate::BackendError;

/// What a way of reaching HDHomeRun devices must provide.
///
/// Devices are addressed by a device ID, IP address or hostname that the caller
/// has already checked with `hdhr_core::validate::device_host`; a backend
/// that runs commands checks it again. Variable names look like
/// `/tuner0/status` and `/sys/model`, and values come back as the device's own
/// text, so the `hdhr-core` parsers apply to every backend.
#[async_trait]
pub trait DeviceBackend: Send + Sync {
    /// Finds devices by broadcast, or answers for one `target` (an address or
    /// device ID) only.
    async fn discover(&self, target: Option<&str>) -> Result<Vec<Discovered>, BackendError>;

    /// Reads a variable, e.g. `/tuner0/status`. The value is returned trimmed.
    async fn get(&self, device: &str, variable: &str) -> Result<String, BackendError>;

    /// Writes a variable, e.g. `/tuner0/channel`, and returns what the device
    /// answered, trimmed.
    async fn set(&self, device: &str, variable: &str, value: &str) -> Result<String, BackendError>;

    /// Scans a channel map on one tuner and returns the channels that locked.
    /// This occupies the tuner and can take minutes.
    async fn scan(
        &self,
        device: &str,
        tuner: u8,
        channel_map: &str,
    ) -> Result<Vec<ScannedChannel>, BackendError>;
}
