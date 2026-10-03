use std::time::Duration;

use hdhr_core::parse::{CloudDevice, parse_cloud_discover};

use crate::BackendError;

/// SiliconDust's lookup of the devices on this network's public address.
pub const DEFAULT_CLOUD_URL: &str = "https://ipv4-api.hdhomerun.com/discover";

const TIMEOUT: Duration = Duration::from_secs(5);

/// The cloud lookup, used when the local broadcast finds nothing.
#[derive(Debug, Clone)]
pub struct CloudClient {
    url: String,
    http: reqwest::Client,
}

impl Default for CloudClient {
    fn default() -> Self {
        Self::new(DEFAULT_CLOUD_URL)
    }
}

impl CloudClient {
    /// A client for `url`; point it at a local stub in tests.
    pub fn new(url: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(concat!("hdhr-client/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("a client with only a timeout and user agent always builds");
        Self {
            url: url.into(),
            http,
        }
    }

    /// The tuners the lookup lists. A failure to reach it, a non-success status
    /// and a body that is not the expected JSON are all errors.
    pub async fn fetch(&self) -> Result<Vec<CloudDevice>, BackendError> {
        let cloud = |e: reqwest::Error| BackendError::Cloud(e.without_url().to_string());
        let body = self
            .http
            .get(&self.url)
            .send()
            .await
            .and_then(|response| response.error_for_status())
            .map_err(cloud)?
            .text()
            .await
            .map_err(cloud)?;
        parse_cloud_discover(&body)
            .map_err(|e| BackendError::Cloud(format!("unexpected response: {e}")))
    }
}
