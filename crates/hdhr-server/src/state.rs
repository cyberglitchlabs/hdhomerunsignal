use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

use hdhr_client::{CloudClient, Hdhr};
use hdhr_core::model::Device;

use crate::config::Config;
use crate::limits::{ClientAddress, RateLimiter};

/// How long a device added by address is remembered before it is asked again.
pub const DEVICE_NAME_TTL: Duration = Duration::from_secs(5 * 60);

/// What the device list remembers between requests.
#[derive(Default)]
pub struct Registry {
    /// Devices added by address, by host, with when they were looked up.
    pub by_host: HashMap<String, (Instant, Device)>,
    /// The cloud lookup's result, kept until the user explicitly refreshes: the
    /// lookup is a request to SiliconDust and must not run on every automatic call.
    pub cloud: Option<Vec<Device>>,
}

pub struct AppState {
    pub config: Config,
    pub hdhr: Hdhr,
    pub cloud: CloudClient,
    /// Held for the whole of a discovery, so concurrent refreshes take turns.
    pub registry: tokio::sync::Mutex<Registry>,
    /// The devices the last discovery returned; the stream and playlist routes
    /// only serve devices on this list.
    pub devices: RwLock<Vec<Device>>,
    /// Devices already reported as lacking PLP info, so it is logged once.
    pub plp_unavailable_logged: Mutex<HashSet<String>>,
    pub general_limiter: RateLimiter,
    /// A channel scan occupies a tuner for up to a minute, so it gets a tight limit.
    pub scan_limiter: RateLimiter,
    pub clients: ClientAddress,
}

impl AppState {
    pub fn new(config: Config, hdhr: Hdhr, cloud: CloudClient) -> Self {
        let window = Duration::from_secs(60);
        Self {
            general_limiter: RateLimiter::new(config.rate_limit, window),
            scan_limiter: RateLimiter::new(if config.rate_limit == 0 { 0 } else { 6 }, window),
            clients: ClientAddress::new(&config.trust_proxy),
            config,
            hdhr,
            cloud,
            registry: tokio::sync::Mutex::new(Registry::default()),
            devices: RwLock::new(Vec::new()),
            plp_unavailable_logged: Mutex::new(HashSet::new()),
        }
    }

    pub fn find_device(&self, id: &str) -> Option<Device> {
        self.devices
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .find(|d| d.id == id)
            .cloned()
    }
}
