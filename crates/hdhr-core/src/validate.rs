//! Strict allowlist validators for every value that reaches `hdhomerun_config`
//! or is reflected into a response. Each returns the (normalised) value, or
//! `None` when the input is not acceptable.
//!
//! Patterns spell out ASCII classes (`[0-9]`, `[A-Za-z0-9]`) instead of `\d` and
//! `\w`, which match other Unicode scripts in Rust.

use std::fmt::Display;
use std::net::IpAddr;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

static HOST_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$").unwrap());
static CHANNEL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:[a-z0-9]{2,10}:)?[0-9]{1,10}(?::[0-9]{1,3}(?:\+[0-9]{1,3})*)?$").unwrap()
});
static DIGITS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{1,10}$").unwrap());
static SMALL_INT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{1,3}$").unwrap());

const CHANNEL_MAPS: &[&str] = &[
    "us-bcast", "us-cable", "us-hrc", "us-irc", "ca-bcast", "ca-cable", "ca-hrc", "ca-irc",
    "eu-bcast", "eu-cable", "au-bcast", "au-cable",
];

const MAX_HOST_LENGTH: usize = 253;
const MAX_PLPS: usize = 64;
const MAX_NAME_LENGTH: usize = 64;
const MAX_LOG_LENGTH: usize = 1000;
/// The highest tuner index a device can have (the CLI addresses `/tuner0` to `/tuner7`).
pub const MAX_TUNER: u8 = 7;
/// Most proxies `HDHR_TRUST_PROXY` may name as a hop count.
pub const MAX_PROXY_HOPS: u32 = 32;

/// Device ID (e.g. `1080ABCD`), IPv4 address or hostname. Must start with an
/// alphanumeric so it can never be parsed as a command-line option.
pub fn device_host(value: &str) -> Option<&str> {
    (value.len() <= MAX_HOST_LENGTH && HOST_RE.is_match(value)).then_some(value)
}

/// A tuner index, `"0"` to `"7"`.
pub fn tuner(value: &str) -> Option<u8> {
    match value.as_bytes() {
        [digit @ b'0'..=b'7'] => Some(digit - b'0'),
        _ => None,
    }
}

/// One of the channel maps `hdhomerun_config scan` knows.
pub fn channel_map(value: &str) -> Option<&str> {
    CHANNEL_MAPS.contains(&value).then_some(value)
}

/// `27`, `auto:27`, `8vsb:27`, `qam256:117`, `auto:575000000`, `atsc3:27`,
/// `atsc3:27:0+1+2`, plus the special values `none`, `+` and `-`.
pub fn channel(value: &str) -> Option<&str> {
    (matches!(value, "none" | "+" | "-") || CHANNEL_RE.is_match(value)).then_some(value)
}

/// Optional list of ATSC 3.0 PLP ids from a JSON body. Missing or `null` means
/// "none selected"; items may be integers or short digit strings.
pub fn plps(value: Option<&Value>) -> Option<Vec<u8>> {
    let items = match value {
        None | Some(Value::Null) => return Some(Vec::new()),
        Some(Value::Array(items)) if items.len() <= MAX_PLPS => items,
        Some(_) => return None,
    };
    items.iter().map(plp_id).collect()
}

fn plp_id(item: &Value) -> Option<u8> {
    let number = match item {
        Value::String(text) if SMALL_INT_RE.is_match(text) => text.parse::<f64>().ok()?,
        Value::Number(number) => number.as_f64()?,
        _ => return None,
    };
    // JSON has one number type, so 2.0 counts as the integer 2.
    (number.fract() == 0.0 && (0.0..=255.0).contains(&number)).then_some(number as u8)
}

/// One to ten ASCII digits.
pub fn digits(value: &str) -> Option<&str> {
    DIGITS_RE.is_match(value).then_some(value)
}

/// Free-text label reflected into the M3U playlist: no control characters (so a
/// value cannot add playlist lines) and a bounded length.
pub fn display_name(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_ascii_control())
        .take(MAX_NAME_LENGTH)
        .collect()
}

/// Renders any value for a log line: line breaks are removed and other control
/// characters become spaces, so a value cannot forge extra log entries, and the
/// length is bounded.
pub fn log_safe(value: impl Display) -> String {
    let text: String = value
        .to_string()
        .chars()
        .filter(|c| !matches!(c, '\n' | '\r'))
        .map(|c| if c.is_ascii_control() { ' ' } else { c })
        .collect();
    if text.chars().count() > MAX_LOG_LENGTH {
        let mut cut: String = text.chars().take(MAX_LOG_LENGTH).collect();
        cut.push('…');
        cut
    } else {
        text
    }
}

/// What `HDHR_TRUST_PROXY` asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrustProxy {
    /// Do not believe `X-Forwarded-For` at all.
    Disabled,
    /// Believe it from this many proxies in front of the server.
    Hops(u32),
    /// Believe it from these proxy IP addresses or CIDR ranges.
    Addrs(Vec<String>),
}

/// Parses `HDHR_TRUST_PROXY`: a proxy hop count or a list of proxy IPs/CIDRs.
/// Deliberately narrow: `true` and any zero-length prefix (`0.0.0.0/0`, `::/0`)
/// would trust every client's `X-Forwarded-For` and let it spoof its address,
/// and named presets are refused so the setting is always explicit.
pub fn parse_trust_proxy(raw: Option<&str>) -> Result<TrustProxy, String> {
    let Some(raw) = raw else {
        return Ok(TrustProxy::Disabled);
    };
    let fail = |why: &str| {
        Err(format!(
            "Invalid HDHR_TRUST_PROXY {}: {why}. Use a proxy hop count (1-{MAX_PROXY_HOPS}) or a \
             comma-separated list of proxy IP addresses or CIDR ranges, or leave it unset.",
            serde_json::to_string(raw).unwrap_or_default()
        ))
    };

    let text = raw.trim();
    if text.is_empty() {
        return Ok(TrustProxy::Disabled);
    }

    if text.bytes().all(|b| b.is_ascii_digit()) {
        return match text.parse::<u32>() {
            Ok(hops) if !text.starts_with('0') && hops <= MAX_PROXY_HOPS => {
                Ok(TrustProxy::Hops(hops))
            }
            _ => fail("hop count out of range"),
        };
    }

    let entries: Vec<String> = text
        .split(',')
        .map(|entry| entry.trim().to_owned())
        .collect();
    for entry in &entries {
        let parts: Vec<&str> = entry.split('/').collect();
        if parts.len() > 2 {
            return fail(&format!("\"{entry}\" is not an IP address or CIDR range"));
        }
        let Ok(address) = parts[0].parse::<IpAddr>() else {
            return fail(&format!("\"{entry}\" is not an IP address or CIDR range"));
        };
        if let Some(prefix) = parts.get(1) {
            let max_prefix = if address.is_ipv4() { 32 } else { 128 };
            if !SMALL_INT_RE.is_match(prefix) {
                return fail(&format!("\"{entry}\" has an invalid prefix length"));
            }
            match prefix.parse::<u32>() {
                Ok(prefix) if (1..=max_prefix).contains(&prefix) => {}
                _ => {
                    return fail(&format!(
                        "\"{entry}\" has an invalid or unsafe prefix length"
                    ));
                }
            }
        }
    }
    Ok(TrustProxy::Addrs(entries))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const INJECTIONS: &[&str] = &[
        "1; id",
        "1 && id",
        "1|id",
        "$(id)",
        "`id`",
        "1\nid",
        "a b",
        "1'",
        "1\"",
        "-h",
        "--help",
        "",
        " ",
        "../etc/passwd",
    ];

    #[test]
    fn device_host_accepts_hex_device_ids_ipv4_and_hostnames() {
        for ok in [
            "1080ABCD",
            "1080ABCD-1",
            "192.168.1.100",
            "hdhr.local",
            "my-tuner",
            "FFFFFFFF",
        ] {
            assert_eq!(device_host(ok), Some(ok));
        }
    }

    #[test]
    fn device_host_rejects_shell_metacharacters_option_like_and_empty_values() {
        let too_long = "a".repeat(254);
        for bad in INJECTIONS
            .iter()
            .copied()
            .chain([too_long.as_str(), "é", "٣"])
        {
            assert_eq!(device_host(bad), None, "{bad:?}");
        }
        assert!(device_host(&"a".repeat(253)).is_some());
    }

    #[test]
    fn tuner_accepts_zero_to_seven_only() {
        assert_eq!(tuner("0"), Some(0));
        assert_eq!(tuner("3"), Some(3));
        assert_eq!(tuner("7"), Some(7));
        for bad in ["8", "-1", "1.5", "1;id", "01", "", " 1", "٣"] {
            assert_eq!(tuner(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn channel_map_accepts_only_known_maps() {
        for ok in CHANNEL_MAPS {
            assert_eq!(channel_map(ok), Some(*ok));
        }
        for bad in ["us-bcast; id", "xx-bcast", "US-BCAST", ""] {
            assert_eq!(channel_map(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn channel_accepts_tune_formats_used_by_the_app() {
        for ok in [
            "27",
            "auto:27",
            "8vsb:27",
            "qam256:117",
            "auto:575000000",
            "atsc3:27",
            "atsc3:27:0+1+2",
            "none",
            "+",
            "-",
        ] {
            assert_eq!(channel(ok), Some(ok), "{ok}");
        }
    }

    #[test]
    fn channel_rejects_injection_and_malformed_values() {
        for bad in INJECTIONS.iter().copied().chain([
            "27; id",
            "atsc3:27:a",
            "auto:",
            ":27",
            "atsc3:27:0+",
        ]) {
            assert_eq!(channel(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn plps_accepts_an_array_of_small_integers_and_returns_a_normalised_list() {
        assert_eq!(plps(None), Some(vec![]));
        assert_eq!(plps(Some(&Value::Null)), Some(vec![]));
        assert_eq!(plps(Some(&json!([]))), Some(vec![]));
        assert_eq!(plps(Some(&json!([0, 1, "2"]))), Some(vec![0, 1, 2]));
        assert_eq!(plps(Some(&json!([2.0, 255]))), Some(vec![2, 255]));
    }

    #[test]
    fn plps_rejects_non_arrays_non_integers_and_oversized_lists() {
        let oversized = Value::Array(vec![json!(1); 65]);
        let bad = [
            json!("0+1"),
            json!(["1;id"]),
            json!([-1]),
            json!([1.5]),
            json!([256]),
            json!({}),
            oversized,
        ];
        for value in &bad {
            assert_eq!(plps(Some(value)), None, "{value}");
        }
        assert_eq!(
            plps(Some(&Value::Array(vec![json!(1); 64]))).map(|v| v.len()),
            Some(64)
        );
    }

    #[test]
    fn digits_accepts_one_to_ten_digit_strings_only() {
        assert_eq!(digits("27"), Some("27"));
        assert_eq!(digits("575000000"), Some("575000000"));
        for bad in ["", "a", "1a", "-1", "1.5", "12345678901"] {
            assert_eq!(digits(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn display_name_strips_control_characters_and_caps_length() {
        assert_eq!(display_name("Channel 2"), "Channel 2");
        assert_eq!(display_name("a\nhttp://evil\r\nb"), "ahttp://evilb");
        assert_eq!(display_name(&"x".repeat(200)).chars().count(), 64);
        assert_eq!(display_name("WHYY·é"), "WHYY·é");
    }

    #[test]
    fn log_safe_flattens_control_characters_so_values_cannot_forge_log_lines() {
        assert_eq!(log_safe("plain text"), "plain text");
        assert_eq!(log_safe("a\nFAKE LOG LINE\r\nb"), "aFAKE LOG LINEb");
        assert_eq!(log_safe("tab\there"), "tab here");
        assert_eq!(log_safe("x".repeat(2000)).chars().count(), 1000 + 1); // truncated + ellipsis
        assert_eq!(log_safe(42), "42");
    }

    #[test]
    fn trust_proxy_unset_or_blank_means_do_not_trust() {
        for unset in [None, Some(""), Some("   ")] {
            assert_eq!(parse_trust_proxy(unset), Ok(TrustProxy::Disabled));
        }
    }

    #[test]
    fn trust_proxy_hop_counts() {
        assert_eq!(parse_trust_proxy(Some("1")), Ok(TrustProxy::Hops(1)));
        assert_eq!(parse_trust_proxy(Some(" 2 ")), Ok(TrustProxy::Hops(2)));
        assert_eq!(parse_trust_proxy(Some("32")), Ok(TrustProxy::Hops(32)));
    }

    #[test]
    fn trust_proxy_ip_and_cidr_lists() {
        let addrs = |list: &[&str]| {
            Ok(TrustProxy::Addrs(
                list.iter().map(|s| s.to_string()).collect(),
            ))
        };
        assert_eq!(
            parse_trust_proxy(Some("10.42.0.0/16")),
            addrs(&["10.42.0.0/16"])
        );
        assert_eq!(
            parse_trust_proxy(Some("10.0.0.1, 192.168.0.0/16")),
            addrs(&["10.0.0.1", "192.168.0.0/16"])
        );
        assert_eq!(parse_trust_proxy(Some("::1")), addrs(&["::1"]));
        assert_eq!(parse_trust_proxy(Some("fd00::/8")), addrs(&["fd00::/8"]));
        assert_eq!(
            parse_trust_proxy(Some("10.0.0.5/32")),
            addrs(&["10.0.0.5/32"])
        );
    }

    #[test]
    fn trust_proxy_refuses_values_that_would_trust_arbitrary_clients_or_are_malformed() {
        let bad = [
            "true",
            "TRUE",
            "false",
            "yes",
            "0",
            "-1",
            "33",
            "1.5",
            "1e2",
            "007",
            "0.0.0.0/0",
            "::/0",
            "10.0.0.0/33",
            "10.0.0.0/",
            "10.0.0.0/-1",
            "10.0.0.0/8/8",
            "999.1.1.1",
            "10.0.0.1,,",
            ",",
            "1;id",
            "loopback",
            "uniquelocal",
            "abc",
            "10.0.0.1 10.0.0.2",
        ];
        for input in bad {
            let error = parse_trust_proxy(Some(input)).expect_err(input);
            assert!(error.contains("HDHR_TRUST_PROXY"), "{input}: {error}");
        }
    }
}
