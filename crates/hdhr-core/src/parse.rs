//! Parsers for what `hdhomerun_config` and the cloud lookup print. They take
//! the text and return typed values; an empty or unrecognised input yields an
//! empty result rather than an error, because devices vary in what they report.

use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;

use crate::model::{L1Info, PlpInfo, PlpMap, Program, ScanProgram, ScannedChannel, TunerStatus};

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static pattern")
}

/// First capture group of the first match.
fn capture<'a>(pattern: &Regex, text: &'a str) -> Option<&'a str> {
    pattern
        .captures(text)
        .map(|c| c.get(1).map_or("", |m| m.as_str()))
}

// ---------------------------------------------------------------- discovery

static DISCOVER_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"hdhomerun device ([A-F0-9-]+) found at ([0-9.]+)"));

/// A device found by the UDP broadcast.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Discovered {
    pub device_id: String,
    pub ip: String,
}

/// Parses `hdhomerun_config discover`, one `hdhomerun device <ID> found at <IP>`
/// line per device. A device that answers twice is listed once.
pub fn parse_discover(output: &str) -> Vec<Discovered> {
    let mut found: Vec<Discovered> = Vec::new();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        if let Some(c) = DISCOVER_RE.captures(line) {
            if !found.iter().any(|d| d.device_id == c[1]) {
                found.push(Discovered {
                    device_id: c[1].to_owned(),
                    ip: c[2].to_owned(),
                });
            }
        }
    }
    found
}

/// The device ID in the output of `hdhomerun_config discover <host>`, if any.
pub fn parse_discover_id(output: &str) -> Option<String> {
    DISCOVER_RE.captures(output).map(|c| c[1].to_owned())
}

/// A tuner from the cloud lookup (`https://ipv4-api.hdhomerun.com/discover`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudDevice {
    pub device_id: String,
    pub local_ip: String,
}

#[derive(Deserialize)]
struct CloudEntry {
    #[serde(rename = "DeviceID")]
    device_id: Option<String>,
    #[serde(rename = "LocalIP")]
    local_ip: Option<String>,
}

/// Parses the cloud lookup's JSON array. Only tuners are kept: DVRs carry a
/// `StorageID` instead of a `DeviceID`, and an entry without an address cannot
/// be reached.
pub fn parse_cloud_discover(json: &str) -> Result<Vec<CloudDevice>, serde_json::Error> {
    let entries: Vec<CloudEntry> = serde_json::from_str(json)?;
    Ok(entries
        .into_iter()
        .filter_map(|e| match (e.device_id, e.local_ip) {
            (Some(device_id), Some(local_ip)) if !device_id.is_empty() && !local_ip.is_empty() => {
                Some(CloudDevice {
                    device_id,
                    local_ip,
                })
            }
            _ => None,
        })
        .collect())
}

/// The display name of a discovered device.
pub fn device_name(device_id: &str, model: Option<&str>) -> String {
    match model {
        Some(model) => format!("HDHomeRun {device_id} ({model})"),
        None => format!("HDHomeRun {device_id}"),
    }
}

/// The display name of a device that was added by address, whose ID may not be known.
pub fn host_device_name(host: &str, device_id: Option<&str>, model: &str) -> String {
    match device_id {
        Some(id) => format!("HDHomeRun {id} ({model})"),
        None => format!("HDHomeRun {model} ({host})"),
    }
}

// ------------------------------------------------------------- device info

/// How many tuners a model has, going by its name. Used only when probing the
/// tuners directly fails.
pub fn tuners_for_model(model: &str) -> u8 {
    if model.contains("PRIME") {
        3
    } else if model.contains("QUATTRO") || model.contains("QUATRO") {
        4
    } else {
        2
    }
}

/// Counts the tuners that answered a status query (`tuner0` to `tuner7`). A
/// device where none answered is assumed to have two.
pub fn tuner_count(answered: &[bool]) -> u8 {
    match answered.iter().filter(|&&ok| ok).count() {
        0 => 2,
        n => u8::try_from(n).unwrap_or(u8::MAX),
    }
}

// ------------------------------------------------------------ tuner status

static CHANNEL_RE: LazyLock<Regex> = LazyLock::new(|| re(r"ch=([^\s]+)"));
static LOCK_RE: LazyLock<Regex> = LazyLock::new(|| re(r"lock=([^\s]+)"));
static SS_RE: LazyLock<Regex> = LazyLock::new(|| re(r"ss=([0-9]+)"));
static SNQ_RE: LazyLock<Regex> = LazyLock::new(|| re(r"snq=([0-9]+)"));
static SEQ_RE: LazyLock<Regex> = LazyLock::new(|| re(r"seq=([0-9]+)"));
static BPS_RE: LazyLock<Regex> = LazyLock::new(|| re(r"bps=([0-9]+)"));
static PPS_RE: LazyLock<Regex> = LazyLock::new(|| re(r"pps=([0-9]+)"));
static DEBUG_RE: LazyLock<Regex> = LazyLock::new(|| re(r"dbg=([0-9]+)-([0-9]+)/(-?[0-9]+)"));

fn number(pattern: &Regex, text: &str) -> Option<u64> {
    capture(pattern, text)?.parse().ok()
}

/// Rounds to one decimal place the way JavaScript's `Math.round` does, which
/// breaks ties upward, so the numbers match the Node server's.
fn round_tenth(value: f64) -> f64 {
    (value * 10.0 + 0.5).floor() / 10.0
}

/// Rough dBm for a raw signal counter. The device only reports a percentage;
/// this maps the debug counter onto the range seen on ATSC hardware (about
/// -40 dBm strong to -80 dBm weak). It is an estimate, not a measurement.
fn estimate_signal_dbm(raw: f64) -> f64 {
    if raw >= 80.0 {
        -40.0 - (100.0 - raw) * 0.5
    } else if raw >= 60.0 {
        -50.0 - (80.0 - raw) * 0.5
    } else if raw >= 20.0 {
        -60.0 - (60.0 - raw) * 0.5
    } else {
        -80.0 - (20.0 - raw) * 0.5
    }
}

/// Parses `/tuner<n>/status`, plus `/tuner<n>/debug` when it was available,
/// which adds the dB estimates. `None` when the status could not be read.
///
/// Fields the device did not report are left unset. `lock` is true only when
/// the device names what it locked to (`lock=8vsb`); `lock=none` is no lock. The
/// Node server counted any `lock=` field, so an idle tuner read as locked.
pub fn parse_tuner_status(status: &str, debug: Option<&str>) -> TunerStatus {
    let line = status.trim();
    if line == "none" {
        return TunerStatus {
            channel: Some("none".into()),
            lock: false,
            ..TunerStatus::default()
        };
    }

    let mut parsed = TunerStatus {
        channel: capture(&CHANNEL_RE, line).map(str::to_owned),
        lock: capture(&LOCK_RE, line).is_some_and(|lock| lock != "none"),
        ss: number(&SS_RE, line),
        snq: number(&SNQ_RE, line),
        seq: number(&SEQ_RE, line),
        bps: number(&BPS_RE, line),
        pps: number(&PPS_RE, line),
        ..TunerStatus::default()
    };

    if let Some(c) = debug.and_then(|d| DEBUG_RE.captures(d)) {
        if let (Ok(signal), Ok(snr)) = (c[1].parse::<u64>(), c[2].parse::<u64>()) {
            parsed.ss_db = Some(round_tenth(estimate_signal_dbm(signal as f64)));
            // SNR is a rough linear conversion: raw 0-80 is about 0-25 dB.
            parsed.snr_db = Some(if snr > 0 {
                round_tenth(snr as f64 * 0.31)
            } else {
                0.0
            });
            parsed.debug_raw = Some(format!("{signal}-{snr}/{}", &c[3]));
        }
    }
    parsed
}

/// Parses `/tuner<n>/program`: the selected program number, or `None` when
/// there is none.
pub fn parse_current_program(output: &str) -> Option<String> {
    let program = output.trim();
    (!program.is_empty() && program != "none").then(|| program.to_owned())
}

// ----------------------------------------------------------------- programs

// ATSC 1.0: tsid=0x0001 program=1: 12.1 WHYY (encrypted)
// ATSC 3.0: service=1: 12.1 WHYY (atsc3), or program=1: 12.1 WHYY
static PROGRAM_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?:program|service)=([0-9]+):\s*([0-9.]+)\s+(.+?)(?:\s+\(([^)]+)\))?$"));
static PROGRAM_ALT_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"([0-9]+):\s*([0-9.]+)\s+(.+?)(?:\s+\(([^)]+)\))?$"));

/// Parses `/tuner<n>/streaminfo` into the programs on the tuned channel.
pub fn parse_streaminfo(output: &str) -> Vec<Program> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let c = PROGRAM_RE
                .captures(line)
                .or_else(|| PROGRAM_ALT_RE.captures(line))?;
            let name = c[3].trim().to_owned();
            let status = c.get(4).map_or("", |m| m.as_str()).to_owned();
            Some(Program {
                program_num: c[1].to_owned(),
                virtual_channel: c[2].to_owned(),
                callsign: name.clone(),
                name,
                encrypted: status.contains("encrypted"),
                atsc3: status.contains("atsc3"),
                status,
            })
        })
        .collect()
}

// --------------------------------------------------------------------- scan

static SCANNING_RE: LazyLock<Regex> = LazyLock::new(|| re(r"SCANNING: ([0-9]+) \(([^)]+)\)"));
static LOCK_LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"LOCK: ([A-Za-z0-9_]+) \(ss=([0-9]+) snq=([0-9]+) seq=([0-9]+)\)"));
static SCAN_PROGRAM_RE: LazyLock<Regex> = LazyLock::new(|| re(r"PROGRAM ([0-9]+): ([0-9.]+) (.+)"));

/// Parses `hdhomerun_config <id> scan /tuner<n> <map>` into the channels that
/// locked, each with the programs listed under it.
///
/// The tool prints a `SCANNING:` line per frequency, then a `LOCK:` line on its
/// own line (with `TSID:` and `PROGRAM` lines after it for a locked channel).
/// Frequencies with `LOCK: none` are dropped. A `SCANNING:` and `LOCK:` on one
/// line are also accepted.
pub fn parse_scan(output: &str) -> Vec<ScannedChannel> {
    let mut channels: Vec<ScannedChannel> = Vec::new();
    // The frequency being scanned, until its LOCK line arrives.
    let mut pending: Option<(String, String)> = None;
    // Whether PROGRAM lines now belong to the last channel pushed.
    let mut locked = false;

    for line in output.lines() {
        if let Some(scan) = SCANNING_RE.captures(line) {
            pending = Some((scan[1].to_owned(), scan[2].to_owned()));
            locked = false;
        }
        // Only a LOCK line consumes the pending frequency.
        if let Some(lock) = LOCK_LINE_RE.captures(line).filter(|_| pending.is_some()) {
            let (frequency, channel) = pending.take().expect("checked above");
            if &lock[1] != "none" {
                channels.push(ScannedChannel {
                    frequency,
                    channel,
                    modulation: lock[1].to_owned(),
                    signal_strength: lock[2].parse().unwrap_or(0),
                    snr: lock[3].parse().unwrap_or(0),
                    symbol_quality: lock[4].parse().unwrap_or(0),
                    programs: Vec::new(),
                });
                locked = true;
            }
        }
        if let (true, Some(program), Some(last)) =
            (locked, SCAN_PROGRAM_RE.captures(line), channels.last_mut())
        {
            last.programs.push(ScanProgram {
                program_num: program[1].to_owned(),
                virtual_channel: program[2].to_owned(),
                name: program[3].to_owned(),
            });
        }
    }
    channels
}

// ------------------------------------------------------------------- ATSC 3

static PLP_ID_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^([0-9]+):"));
static SFI_RE: LazyLock<Regex> = LazyLock::new(|| re(r"sfi=([A-Za-z0-9_]+)"));
static MOD_RE: LazyLock<Regex> = LazyLock::new(|| re(r"mod=([A-Za-z0-9_]+)"));
static COD_RE: LazyLock<Regex> = LazyLock::new(|| re(r"cod=([0-9/]+)"));
static LAYER_RE: LazyLock<Regex> = LazyLock::new(|| re(r"layer=([A-Za-z0-9_]+)"));
static TI_RE: LazyLock<Regex> = LazyLock::new(|| re(r"ti=([A-Za-z0-9_]+)"));
static LLS_RE: LazyLock<Regex> = LazyLock::new(|| re(r"lls=([0-9]+)"));
static PLP_LOCK_RE: LazyLock<Regex> = LazyLock::new(|| re(r"lock=([0-9]+)"));

/// Parses `/tuner<n>/plpinfo`. Each line is
/// `0: sfi=0 mod=qam256 cod=10/15 layer=core ti=cti lls=1 lock=1`. `None` when
/// there are no PLPs, which is what a device without ATSC 3.0 reports.
pub fn parse_plpinfo(output: &str) -> Option<PlpMap> {
    let mut plps = PlpMap::new();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let Some(id) = capture(&PLP_ID_RE, line).and_then(|id| id.parse::<u32>().ok()) else {
            continue;
        };
        let text = |pattern: &Regex| capture(pattern, line).map(str::to_owned);
        plps.insert(
            id,
            PlpInfo {
                sfi: text(&SFI_RE),
                modulation: text(&MOD_RE),
                coderate: text(&COD_RE),
                layer: text(&LAYER_RE),
                time_interleaving: text(&TI_RE),
                lls: capture(&LLS_RE, line).map(|v| v == "1"),
                lock: capture(&PLP_LOCK_RE, line).map(|v| v == "1"),
            },
        );
    }
    (!plps.is_empty()).then_some(plps)
}

static KEY_VALUE_RE: LazyLock<Regex> = LazyLock::new(|| re(r"([A-Za-z0-9_]+)=([^\s]+)"));

/// Parses `/tuner<n>/l1info`: every `key=value` pair on every line. `None` when
/// there are none. Later values win when a key repeats.
pub fn parse_l1info(output: &str) -> Option<L1Info> {
    let mut info = L1Info::new();
    for c in output
        .lines()
        .flat_map(|line| KEY_VALUE_RE.captures_iter(line))
    {
        info.insert(c[1].to_owned(), c[2].to_owned());
    }
    (!info.is_empty()).then_some(info)
}
