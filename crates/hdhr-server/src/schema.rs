//! Types that exist to describe the API: request bodies, small responses and the
//! payloads of the event streams. The stream payloads are what the hub really
//! serializes, so the spec cannot drift from the wire for them.

use hdhr_core::model::{L1Info, PlpMap, TunerStatus};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// The body of every error response.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ErrorBody {
    /// What went wrong, in words.
    pub error: String,
}

/// The body of `POST .../channel`.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ChannelRequest {
    /// What to tune: `27`, `auto:27`, `8vsb:27`, `qam256:117`, `auto:575000000`,
    /// `atsc3:27`, `atsc3:27:0+1+2`, or the special values `none` (stop), `+` and `-`
    /// (next and previous channel).
    #[schema(
        example = "auto:27",
        pattern = r"^(?:[a-z0-9]{2,10}:)?[0-9]{1,10}(?::[0-9]{1,3}(?:\+[0-9]{1,3})*)?$|^(?:none|\+|-)$"
    )]
    pub channel: String,
}

/// The body of `POST .../atsc3`.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct Atsc3Request {
    /// The RF channel, as digits. A JSON number is accepted too.
    #[schema(example = "27", pattern = r"^[0-9]{1,10}$")]
    pub channel: String,
    /// The PLPs to decode, 0 to 255 each (up to 64). Each may also be a string of digits.
    #[serde(default)]
    pub plps: Vec<u8>,
}

/// The answer to a tuning command.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct TuneResult {
    pub success: bool,
    /// What the device answered, usually empty.
    pub result: String,
}

/// A URL a player can open.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct StreamUrl {
    #[schema(example = "http://192.168.1.50:5004/auto/ch34-3")]
    pub url: String,
}

/// What the built frontend says about itself.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    /// A hash of the build, or `unknown` when there is no build information.
    pub hash: String,
    /// When it was built (ISO 8601), or null when unknown.
    pub build_time: Option<String>,
}

/// The payload of a `tuner-status` event: the tuner's status, plus the current
/// program and the ATSC 3.0 details.
///
/// A tuner that does not answer still produces an event, with none of the status
/// fields (no `channel`, no `lock`), so a page can tell the device is not
/// reporting. `plpInfo` and `l1Info` are only fetched while a channel is tuned.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TunerEvent {
    /// The tuned channel as the device reports it, e.g. `auto:34`, or `none`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// Whether the tuner has a lock on the signal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock: Option<bool>,
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
    /// Signal strength estimated in dBm, when the device reports the counters for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ss_db: Option<f64>,
    /// Signal-to-noise estimated in dB, when the device reports the counters for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snr_db: Option<f64>,
    /// The debug counters the dB estimates came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debug_raw: Option<String>,
    /// The selected program number, as the device reports it, or null.
    #[schema(required = true)]
    pub current_program: Option<String>,
    /// ATSC 3.0 PLPs by id, or null when the device reports none.
    #[schema(required = true, value_type = Option<std::collections::HashMap<String, hdhr_core::model::PlpInfo>>)]
    pub plp_info: Option<PlpMap>,
    /// ATSC 3.0 L1 signalling as raw key/value pairs, or null.
    #[schema(required = true, value_type = Option<std::collections::HashMap<String, String>>)]
    pub l1_info: Option<L1Info>,
}

impl TunerEvent {
    /// One poll's result. `status` is `None` when the tuner did not answer.
    pub fn new(
        status: Option<TunerStatus>,
        current_program: Option<String>,
        plp_info: Option<PlpMap>,
        l1_info: Option<L1Info>,
    ) -> Self {
        let status = status.map(|s| (s.lock, s)); // the lock is a plain bool in a status, optional here
        Self {
            channel: status.as_ref().and_then(|(_, s)| s.channel.clone()),
            lock: status.as_ref().map(|(lock, _)| *lock),
            ss: status.as_ref().and_then(|(_, s)| s.ss),
            snq: status.as_ref().and_then(|(_, s)| s.snq),
            seq: status.as_ref().and_then(|(_, s)| s.seq),
            bps: status.as_ref().and_then(|(_, s)| s.bps),
            pps: status.as_ref().and_then(|(_, s)| s.pps),
            ss_db: status.as_ref().and_then(|(_, s)| s.ss_db),
            snr_db: status.as_ref().and_then(|(_, s)| s.snr_db),
            debug_raw: status.as_ref().and_then(|(_, s)| s.debug_raw.clone()),
            current_program,
            plp_info,
            l1_info,
        }
    }
}

/// One tuner's reading inside an `antenna-mode-status` event.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct AntennaReading {
    pub tuner: u8,
    /// Null when that tuner did not answer.
    pub status: Option<TunerStatus>,
}

/// The payload of an `antenna-mode-status` event: one reading per tuner, in order.
pub type AntennaEvent = Vec<AntennaReading>;
