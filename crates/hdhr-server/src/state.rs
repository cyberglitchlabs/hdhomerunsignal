use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use hdhr_client::{CloudClient, Hdhr};
use hdhr_core::model::Device;

use crate::config::Config;
use crate::hub::{Hub, HubConfig, PlpLog};
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
    pub plp: Arc<PlpLog>,
    /// The shared pollers behind the event streams.
    pub hub: Arc<Hub>,
    /// Open event streams per client address, for `HDHR_MAX_STREAMS_PER_CLIENT`.
    pub streams_by_client: Mutex<HashMap<String, usize>>,
    /// Flips to true when the server starts shutting down, which ends every stream.
    pub shutdown: tokio::sync::watch::Sender<bool>,
    pub general_limiter: RateLimiter,
    /// A channel scan occupies a tuner for up to a minute, so it gets a tight limit.
    pub scan_limiter: RateLimiter,
    pub clients: ClientAddress,
}

impl AppState {
    pub fn new(config: Config, hdhr: Hdhr, cloud: CloudClient) -> Self {
        Self::with_hub_config(config, hdhr, cloud, HubConfig::default())
    }

    pub fn with_hub_config(
        config: Config,
        hdhr: Hdhr,
        cloud: CloudClient,
        hub_config: HubConfig,
    ) -> Self {
        let window = Duration::from_secs(60);
        let plp = Arc::new(PlpLog::default());
        Self {
            hub: Hub::new(hdhr.clone(), plp.clone(), hub_config),
            plp,
            streams_by_client: Mutex::new(HashMap::new()),
            shutdown: tokio::sync::watch::channel(false).0,
            general_limiter: RateLimiter::new(config.rate_limit, window),
            scan_limiter: RateLimiter::new(if config.rate_limit == 0 { 0 } else { 6 }, window),
            clients: ClientAddress::new(&config.trust_proxy),
            config,
            hdhr,
            cloud,
            registry: tokio::sync::Mutex::new(Registry::default()),
            devices: RwLock::new(Vec::new()),
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

/// An open event stream's place in its client's allowance; dropping it frees the place.
pub struct StreamSlot {
    state: Arc<AppState>,
    client: String,
}

impl AppState {
    /// Takes a place for `client`, or `None` when it already holds as many streams
    /// as `HDHR_MAX_STREAMS_PER_CLIENT` allows (0 allows any number).
    pub fn acquire_stream(self: &Arc<Self>, client: &str) -> Option<StreamSlot> {
        let mut streams = self
            .streams_by_client
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let held = streams.entry(client.to_owned()).or_insert(0);
        if self.config.max_streams_per_client > 0 && *held >= self.config.max_streams_per_client {
            return None;
        }
        *held += 1;
        Some(StreamSlot {
            state: self.clone(),
            client: client.to_owned(),
        })
    }

    /// Ends every open stream, so that graceful shutdown is not held up by them.
    pub fn begin_shutdown(&self) {
        self.shutdown.send_replace(true);
    }
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        let mut streams = self
            .state
            .streams_by_client
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(held) = streams.get_mut(&self.client) {
            *held -= 1;
            if *held == 0 {
                streams.remove(&self.client);
            }
        }
    }
}
