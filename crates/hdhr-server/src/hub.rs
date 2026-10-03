//! Shared pollers for the event streams.
//!
//! Every open stream wants the same reading of the same tuner, so a tuner is
//! polled once however many streams watch it: the first subscriber starts a
//! poller, the readings go out on a `watch` channel, and the poller stops when
//! the last subscriber is gone. Two browser tabs on one tuner cost one set of
//! `hdhomerun_config` calls per second, not two.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hdhr_client::Hdhr;
use hdhr_core::model::PlpMap;
use hdhr_core::validate::log_safe;
use serde_json::{Map, Value, json};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// What a stream watches.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Key {
    /// One tuner's status, program, and ATSC 3.0 details.
    Tuner { device: String, tuner: u8 },
    /// The status of every tuner of a device, for antenna alignment.
    Antenna { device: String, tuners: u8 },
}

/// One server-sent event: a name and its JSON payload, serialized once.
#[derive(Debug, PartialEq, Eq)]
pub struct Message {
    pub event: &'static str,
    pub data: String,
}

pub type Latest = Option<Arc<Message>>;

#[derive(Debug, Clone, Copy)]
pub struct HubConfig {
    /// Time between the starts of two polls. A poll that outlasts it delays the
    /// next one rather than overlapping it.
    pub interval: Duration,
    /// Limit for each group of device calls in a poll, so a device that stops
    /// answering cannot stall the stream.
    pub call_timeout: Duration,
}

impl Default for HubConfig {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(1),
            call_timeout: Duration::from_secs(5),
        }
    }
}

/// Devices already reported as lacking PLP info. A device without ATSC 3.0 fails
/// that query on every poll, so it is said once, not on every poll.
#[derive(Default)]
pub struct PlpLog(Mutex<HashSet<String>>);

impl PlpLog {
    /// PLP details, or `None` for a device that has none or cannot answer.
    pub async fn plp_or_none(&self, hdhr: &Hdhr, device: &str, tuner: u8) -> Option<PlpMap> {
        match hdhr.plp_info(device, tuner).await {
            Ok(plps) => plps,
            Err(_) => {
                if self
                    .0
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(device.to_owned())
                {
                    tracing::info!(
                        "PLP info not available from {} (no ATSC 3.0 support?); not logging again",
                        log_safe(device)
                    );
                }
                None
            }
        }
    }
}

struct Entry {
    latest: watch::Receiver<Latest>,
    subscribers: usize,
    poller: JoinHandle<()>,
}

pub struct Hub {
    hdhr: Hdhr,
    plp: Arc<PlpLog>,
    config: HubConfig,
    entries: Mutex<HashMap<Key, Entry>>,
}

/// A stream's hold on a poller. Dropping it lets the poller stop if it was the last.
pub struct Subscription {
    hub: Arc<Hub>,
    key: Key,
    pub latest: watch::Receiver<Latest>,
}

impl Hub {
    pub fn new(hdhr: Hdhr, plp: Arc<PlpLog>, config: HubConfig) -> Arc<Self> {
        Arc::new(Self {
            hdhr,
            plp,
            config,
            entries: Mutex::new(HashMap::new()),
        })
    }

    /// Joins the poller for `key`, starting it if nobody is watching yet. Must be
    /// called from within the runtime.
    pub fn subscribe(self: &Arc<Self>, key: Key) -> Subscription {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let entry = entries.entry(key.clone()).or_insert_with(|| {
            tracing::info!("Starting monitoring for {}", describe(&key));
            let (sender, latest) = watch::channel(None);
            let poller = tokio::spawn(run(
                self.hdhr.clone(),
                self.plp.clone(),
                key.clone(),
                sender,
                self.config,
            ));
            Entry {
                latest,
                subscribers: 0,
                poller,
            }
        });
        entry.subscribers += 1;
        Subscription {
            hub: self.clone(),
            key,
            latest: entry.latest.clone(),
        }
    }

    /// How many pollers are running. For tests.
    pub fn active(&self) -> usize {
        self.entries.lock().unwrap_or_else(|p| p.into_inner()).len()
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut entries = self.hub.entries.lock().unwrap_or_else(|p| p.into_inner());
        let Some(entry) = entries.get_mut(&self.key) else {
            return;
        };
        entry.subscribers -= 1;
        if entry.subscribers == 0 {
            if let Some(entry) = entries.remove(&self.key) {
                entry.poller.abort();
            }
            tracing::info!("Stopping monitoring for {}", describe(&self.key));
        }
    }
}

fn describe(key: &Key) -> String {
    match key {
        Key::Tuner { device, tuner } => format!("device {}, tuner {tuner}", log_safe(device)),
        Key::Antenna { device, tuners } => format!(
            "device {}, antenna mode with {tuners} tuners",
            log_safe(device)
        ),
    }
}

async fn run(
    hdhr: Hdhr,
    plp: Arc<PlpLog>,
    key: Key,
    sender: watch::Sender<Latest>,
    config: HubConfig,
) {
    loop {
        let started = Instant::now();
        let message = match &key {
            Key::Tuner { device, tuner } => {
                poll_tuner(&hdhr, &plp, device, *tuner, config.call_timeout).await
            }
            Key::Antenna { device, tuners } => {
                poll_antenna(&hdhr, device, *tuners, config.call_timeout).await
            }
        };
        sender.send_replace(Some(Arc::new(message)));
        tokio::time::sleep(config.interval.saturating_sub(started.elapsed())).await;
    }
}

/// Runs a group of device calls under the per-poll limit; one that does not
/// finish counts as no answer.
async fn bounded<T>(limit: Duration, call: impl Future<Output = Option<T>>) -> Option<T> {
    tokio::time::timeout(limit, call).await.ok().flatten()
}

async fn poll_tuner(
    hdhr: &Hdhr,
    plp: &PlpLog,
    device: &str,
    tuner: u8,
    limit: Duration,
) -> Message {
    let (status, program) = tokio::join!(
        bounded(limit, hdhr.tuner_status(device, tuner)),
        bounded(limit, hdhr.current_program(device, tuner)),
    );

    // The ATSC 3.0 details only exist on a tuned channel. A device without them
    // answers nothing, which is reported as null.
    let tuned = status
        .as_ref()
        .and_then(|s| s.channel.as_deref())
        .is_some_and(|channel| channel != "none");
    let (plp_info, l1_info) = if tuned {
        tokio::join!(
            bounded(limit, async {
                Some(plp.plp_or_none(hdhr, device, tuner).await)
            }),
            bounded(limit, async { Some(hdhr.l1_info(device, tuner).await) }),
        )
    } else {
        (None, None)
    };

    // A tuner that did not answer still gets an event, with no channel or lock in
    // it, so the page can tell the device is not reporting.
    let mut data = match status.map(serde_json::to_value) {
        Some(Ok(Value::Object(fields))) => fields,
        _ => Map::new(),
    };
    data.insert("currentProgram".into(), json!(program));
    data.insert("plpInfo".into(), json!(plp_info.flatten()));
    data.insert("l1Info".into(), json!(l1_info.flatten()));
    Message {
        event: "tuner-status",
        data: Value::Object(data).to_string(),
    }
}

async fn poll_antenna(hdhr: &Hdhr, device: &str, tuners: u8, limit: Duration) -> Message {
    let readings = futures_util::future::join_all((0..tuners).map(|tuner| async move {
        let status = bounded(limit, hdhr.tuner_status(device, tuner)).await;
        json!({ "tuner": tuner, "status": status })
    }))
    .await;
    Message {
        event: "antenna-mode-status",
        data: Value::Array(readings).to_string(),
    }
}
