//! The data the API returns. Serialized names and optionality match what the
//! frontend already reads: a field that a device did not report is left out
//! rather than sent as `null`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// A tuner device the user can pick.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Device {
    /// What commands address the device by: a device ID, IP address or hostname.
    pub id: String,
    pub ip: String,
    pub name: String,
    pub online: bool,
}

/// Model and capabilities of one device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub model: String,
    pub tuners: u8,
    pub atsc3_support: bool,
}

/// One reading of `/tuner<n>/status`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TunerStatus {
    /// The tuned channel as the device reports it, e.g. `8vsb:27`, or `none`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    pub lock: bool,
    /// Signal strength, percent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ss: Option<u64>,
    /// Signal-to-noise quality, percent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snq: Option<u64>,
    /// Symbol error quality, percent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    /// Stream bitrate in bits per second.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bps: Option<u64>,
    /// Packets per second.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pps: Option<u64>,
    /// Signal strength estimated in dBm from the debug counters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ss_db: Option<f64>,
    /// Signal-to-noise estimated in dB from the debug counters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snr_db: Option<f64>,
    /// The debug counters the dB estimates came from, as `signal-snr/third`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debug_raw: Option<String>,
}

/// One program (virtual channel) on the tuned channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    pub program_num: String,
    pub virtual_channel: String,
    pub name: String,
    /// Same as `name`; kept for clients that read it.
    pub callsign: String,
    /// The parenthesised note after the name, e.g. `encrypted` or `atsc3`.
    pub status: String,
    pub encrypted: bool,
    pub atsc3: bool,
}

/// A program found during a channel scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgram {
    pub program_num: String,
    pub virtual_channel: String,
    pub name: String,
}

/// A frequency that locked during a channel scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScannedChannel {
    pub frequency: String,
    pub channel: String,
    pub modulation: String,
    pub signal_strength: u32,
    pub snr: u32,
    pub symbol_quality: u32,
    pub programs: Vec<ScanProgram>,
}

/// One ATSC 3.0 physical layer pipe, from `/tuner<n>/plpinfo`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlpInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sfi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modulation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coderate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_interleaving: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lls: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock: Option<bool>,
}

/// PLP id to its details.
pub type PlpMap = BTreeMap<u32, PlpInfo>;

/// ATSC 3.0 L1 signalling, as the raw `key=value` pairs the device reports.
pub type L1Info = BTreeMap<String, String>;
