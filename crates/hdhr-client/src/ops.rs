use std::sync::Arc;
use std::time::Duration;

use futures_util::future::join_all;
use hdhr_core::model::{Device, DeviceInfo, L1Info, PlpMap, Program, ScannedChannel, TunerStatus};
use hdhr_core::parse::{
    CloudDevice, device_name, host_device_name, parse_current_program, parse_l1info, parse_plpinfo,
    parse_streaminfo, parse_tuner_status, tuner_count,
};
use hdhr_core::validate;

use crate::{BackendError, DeviceBackend};

/// How long [`Hdhr::programs`] waits for a tuner to report its programs, which
/// can take a few seconds after a channel change (longer for ATSC 3.0).
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    /// Extra attempts after the first.
    pub max_retries: u32,
    /// Wait before retrying a failed query.
    pub error_delay: Duration,
    /// Wait before retrying a query that answered with no programs.
    pub empty_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 3,
            error_delay: Duration::from_millis(1500),
            empty_delay: Duration::from_millis(2000),
        }
    }
}

/// The operations the API needs, on top of any [`DeviceBackend`].
#[derive(Clone)]
pub struct Hdhr {
    backend: Arc<dyn DeviceBackend>,
    retry: RetryPolicy,
}

fn tuner_variable(tuner: u8, name: &str) -> Result<String, BackendError> {
    if tuner > validate::MAX_TUNER {
        return Err(BackendError::InvalidArgument { what: "tuner" });
    }
    Ok(format!("/tuner{tuner}/{name}"))
}

impl Hdhr {
    pub fn new(backend: Arc<dyn DeviceBackend>) -> Self {
        Self {
            backend,
            retry: RetryPolicy::default(),
        }
    }

    pub fn with_retry(mut self, retry: RetryPolicy) -> Self {
        self.retry = retry;
        self
    }

    pub fn backend(&self) -> &Arc<dyn DeviceBackend> {
        &self.backend
    }

    // ---------------------------------------------------------- discovery

    /// The model name a device reports, or `None` if it did not answer.
    pub async fn hardware_model(&self, host: &str) -> Option<String> {
        let model = self.backend.get(host, "/sys/hwmodel").await.ok()?;
        (!model.is_empty()).then_some(model)
    }

    /// Devices found by broadcast, each named with its model. A failed
    /// broadcast finds nothing.
    pub async fn discover_devices(&self) -> Vec<Device> {
        let found = self.backend.discover(None).await.unwrap_or_default();
        join_all(found.into_iter().map(|d| async move {
            let model = self.hardware_model(&d.ip).await;
            Device {
                name: device_name(&d.device_id, model.as_deref()),
                id: d.device_id,
                ip: d.ip,
                online: true,
            }
        }))
        .await
    }

    /// Turns the cloud lookup's tuners into devices. They are addressed by IP,
    /// because the broadcast that would resolve a device ID found nothing.
    pub async fn devices_from_cloud(&self, entries: Vec<CloudDevice>) -> Vec<Device> {
        join_all(entries.into_iter().map(|e| async move {
            let model = self.hardware_model(&e.local_ip).await;
            Device {
                name: device_name(&e.device_id, model.as_deref()),
                id: e.local_ip.clone(),
                ip: e.local_ip,
                online: true,
            }
        }))
        .await
    }

    /// A device the user added by address. An unreachable one comes back marked
    /// offline, so the UI can show it greyed out instead of dropping it.
    pub async fn device_by_host(&self, host: &str) -> Device {
        let Ok(model) = self.backend.get(host, "/sys/hwmodel").await else {
            return Device {
                id: host.into(),
                ip: host.into(),
                name: format!("HDHomeRun ({host})"),
                online: false,
            };
        };
        let model = if model.is_empty() {
            "Unknown".to_owned()
        } else {
            model
        };
        // The ID is only for display. Commands keep addressing the device by the
        // address the user gave, which also works across subnets.
        let device_id = match self.backend.discover(Some(host)).await {
            Ok(found) => found.into_iter().next().map(|d| d.device_id),
            Err(_) => None,
        };
        Device {
            id: host.into(),
            ip: host.into(),
            name: host_device_name(host, device_id.as_deref(), &model),
            online: true,
        }
    }

    /// The device ID a host answers to, if it does.
    pub async fn device_id(&self, host: &str) -> Option<String> {
        self.backend
            .discover(Some(host))
            .await
            .ok()?
            .into_iter()
            .next()
            .map(|d| d.device_id)
    }

    // ------------------------------------------------------------- device

    /// Model and tuner count. The count is the number of `tuner<n>` variables
    /// that answer, since the device does not say; a device that does not answer
    /// at all is reported as an unknown two-tuner model.
    pub async fn device_info(&self, host: &str) -> DeviceInfo {
        let Ok(model) = self.backend.get(host, "/sys/model").await else {
            return DeviceInfo {
                model: "Unknown".into(),
                tuners: 2,
                atsc3_support: false,
            };
        };
        let probes = join_all((0..=validate::MAX_TUNER).map(|tuner| async move {
            self.backend
                .get(host, &format!("/tuner{tuner}/status"))
                .await
                .is_ok()
        }))
        .await;
        // ATSC 3.0 is detected from whether PLP data shows up, not from the model.
        DeviceInfo {
            model,
            tuners: tuner_count(&probes),
            atsc3_support: true,
        }
    }

    // -------------------------------------------------------------- tuner

    /// One status reading, with the dB estimates when the debug counters are
    /// available. `None` when the tuner did not answer.
    pub async fn tuner_status(&self, host: &str, tuner: u8) -> Option<TunerStatus> {
        let (status, debug) = (
            tuner_variable(tuner, "status").ok()?,
            tuner_variable(tuner, "debug").ok()?,
        );
        let (status, debug) = tokio::join!(
            self.backend.get(host, &status),
            self.backend.get(host, &debug)
        );
        let status = status.ok().filter(|s| !s.is_empty())?;
        Some(parse_tuner_status(&status, debug.ok().as_deref()))
    }

    /// The selected program number, if any.
    pub async fn current_program(&self, host: &str, tuner: u8) -> Option<String> {
        let variable = tuner_variable(tuner, "program").ok()?;
        parse_current_program(&self.backend.get(host, &variable).await.ok()?)
    }

    /// The programs on the tuned channel. Empty unless the tuner is locked;
    /// right after a channel change the device may need a few attempts.
    pub async fn programs(&self, host: &str, tuner: u8) -> Vec<Program> {
        let Some(status) = self.tuner_status(host, tuner).await else {
            return Vec::new();
        };
        if !status.lock || status.channel.as_deref() == Some("none") {
            return Vec::new();
        }
        let Ok(variable) = tuner_variable(tuner, "streaminfo") else {
            return Vec::new();
        };

        let mut attempt = 0;
        loop {
            let delay = match self.backend.get(host, &variable).await {
                Ok(output) => {
                    let programs = parse_streaminfo(&output);
                    if !programs.is_empty() || attempt >= self.retry.max_retries {
                        return programs;
                    }
                    self.retry.empty_delay
                }
                Err(_) if attempt >= self.retry.max_retries => return Vec::new(),
                Err(_) => self.retry.error_delay,
            };
            attempt += 1;
            tokio::time::sleep(delay).await;
        }
    }

    /// ATSC 3.0 PLP details. `Ok(None)` when the tuner reports none; an error
    /// when the device cannot answer the query at all (no ATSC 3.0 support),
    /// which callers may want to log once rather than on every poll.
    pub async fn plp_info(&self, host: &str, tuner: u8) -> Result<Option<PlpMap>, BackendError> {
        let output = self
            .backend
            .get(host, &tuner_variable(tuner, "plpinfo")?)
            .await?;
        Ok(parse_plpinfo(&output))
    }

    /// ATSC 3.0 L1 signalling, if the device reports it.
    pub async fn l1_info(&self, host: &str, tuner: u8) -> Option<L1Info> {
        let variable = tuner_variable(tuner, "l1info").ok()?;
        parse_l1info(&self.backend.get(host, &variable).await.ok()?)
    }

    // ------------------------------------------------------------- tuning

    /// Tunes to `channel` (validated here again): `27`, `auto:27`, `atsc3:27:0+1`,
    /// or the special values `none`, `+` and `-`.
    pub async fn set_channel(
        &self,
        host: &str,
        tuner: u8,
        channel: &str,
    ) -> Result<String, BackendError> {
        let channel =
            validate::channel(channel).ok_or(BackendError::InvalidArgument { what: "channel" })?;
        self.backend
            .set(host, &tuner_variable(tuner, "channel")?, channel)
            .await
    }

    /// Tunes an ATSC 3.0 channel with the PLPs to decode.
    pub async fn set_atsc3_channel(
        &self,
        host: &str,
        tuner: u8,
        channel: &str,
        plps: &[u8],
    ) -> Result<String, BackendError> {
        let channel =
            validate::digits(channel).ok_or(BackendError::InvalidArgument { what: "channel" })?;
        let mut tune = format!("atsc3:{channel}");
        if !plps.is_empty() {
            let ids: Vec<String> = plps.iter().map(u8::to_string).collect();
            tune.push(':');
            tune.push_str(&ids.join("+"));
        }
        self.set_channel(host, tuner, &tune).await
    }

    pub async fn channel_up(&self, host: &str, tuner: u8) -> Result<String, BackendError> {
        self.set_channel(host, tuner, "+").await
    }

    pub async fn channel_down(&self, host: &str, tuner: u8) -> Result<String, BackendError> {
        self.set_channel(host, tuner, "-").await
    }

    /// Stops the tuner.
    pub async fn clear_tuner(&self, host: &str, tuner: u8) -> Result<String, BackendError> {
        self.set_channel(host, tuner, "none").await
    }

    /// Scans a channel map on one tuner; see [`DeviceBackend::scan`].
    pub async fn scan(
        &self,
        host: &str,
        tuner: u8,
        channel_map: &str,
    ) -> Result<Vec<ScannedChannel>, BackendError> {
        self.backend.scan(host, tuner, channel_map).await
    }
}
