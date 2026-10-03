//! Building the device list: the local broadcast, the cloud lookup as a
//! fallback, and devices added by address.

use std::collections::HashSet;
use std::time::Instant;

use futures_util::future::join_all;
use hdhr_core::model::Device;
use hdhr_core::validate::{self, log_safe};

use crate::state::{AppState, DEVICE_NAME_TTL, Registry};

/// The devices to offer. `force` is the user pressing Refresh: it forgets what was
/// remembered about devices added by address, and allows the cloud lookup to run.
pub async fn discover_devices(state: &AppState, force: bool) -> Vec<Device> {
    let mut registry = state.registry.lock().await;
    if force {
        registry.by_host.clear();
    }

    let mut devices: Vec<Device> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut add = |device: Device, devices: &mut Vec<Device>| {
        if seen.insert(device.id.clone()) {
            devices.push(device);
            true
        } else {
            false
        }
    };

    if state.config.disable_discovery {
        tracing::info!("Auto-discovery disabled via HDHOMERUN_DISABLE_DISCOVERY");
    } else {
        for device in auto_discover(state, &mut registry, force).await {
            add(device, &mut devices);
        }
    }

    let hosts: Vec<&str> = state
        .config
        .manual_devices
        .iter()
        .filter(|host| {
            let valid = validate::device_host(host).is_some();
            if !valid {
                tracing::error!(
                    "Ignoring invalid HDHOMERUN_DEVICES entry: {}",
                    log_safe(format!("{host:?}"))
                );
            }
            valid
        })
        .map(String::as_str)
        .collect();
    if !hosts.is_empty() {
        tracing::info!(
            "Adding {} manual device(s): {}",
            hosts.len(),
            log_safe(hosts.join(", "))
        );
        for device in manual_devices(state, &mut registry, &hosts).await {
            let (id, ip, online) = (device.id.clone(), device.ip.clone(), device.online);
            if add(device, &mut devices) {
                tracing::info!(
                    "Added manual device: {} at {} ({})",
                    log_safe(id),
                    log_safe(ip),
                    if online { "online" } else { "offline" }
                );
            }
        }
    }

    *state.devices.write().unwrap_or_else(|p| p.into_inner()) = devices.clone();
    devices
}

async fn auto_discover(state: &AppState, registry: &mut Registry, force: bool) -> Vec<Device> {
    let local = state.hdhr.discover_devices().await;
    if !local.is_empty() {
        tracing::info!("UDP discovery found {} device(s)", local.len());
        return local;
    }

    // The cloud lookup sends a request to SiliconDust, so it has its own opt-out
    // that leaves the local broadcast above alone.
    if state.config.disable_cloud_discovery {
        tracing::info!(
            "UDP discovery found no devices; cloud discovery disabled via HDHR_DISABLE_CLOUD_DISCOVERY"
        );
        return Vec::new();
    }

    if !force && let Some(cached) = &registry.cloud {
        tracing::info!(
            "UDP discovery found no devices, using cached HTTP discovery results ({} device(s))",
            cached.len()
        );
        return cached.clone();
    }

    tracing::info!("UDP discovery found no devices, trying HTTP discovery fallback...");
    let devices = match state.cloud.fetch().await {
        Ok(entries) => state.hdhr.devices_from_cloud(entries).await,
        Err(error) => {
            tracing::error!("HTTP discovery request error: {}", log_safe(error));
            Vec::new()
        }
    };
    if devices.is_empty() {
        tracing::info!("HTTP discovery also found no devices");
    } else {
        tracing::info!("HTTP discovery found {} device(s)", devices.len());
    }
    // An empty result is remembered too, so a failing lookup is not retried on every call.
    registry.cloud = Some(devices.clone());
    devices
}

/// Devices added by address, each looked up at most once per [`DEVICE_NAME_TTL`].
async fn manual_devices(state: &AppState, registry: &mut Registry, hosts: &[&str]) -> Vec<Device> {
    let now = Instant::now();
    let cached: Vec<Option<Device>> = hosts
        .iter()
        .map(|host| {
            registry
                .by_host
                .get(*host)
                .filter(|(looked_up, _)| now.duration_since(*looked_up) < DEVICE_NAME_TTL)
                .map(|(_, device)| device.clone())
        })
        .collect();

    let looked_up = join_all(hosts.iter().zip(cached).map(|(host, cached)| async move {
        match cached {
            Some(device) => (device, false),
            None => (state.hdhr.device_by_host(host).await, true),
        }
    }))
    .await;

    // Only a fresh lookup is stamped, so a remembered device still expires on time.
    let mut devices = Vec::with_capacity(looked_up.len());
    for (host, (device, fresh)) in hosts.iter().zip(looked_up) {
        if fresh {
            registry
                .by_host
                .insert((*host).to_owned(), (now, device.clone()));
        }
        devices.push(device);
    }
    devices
}
