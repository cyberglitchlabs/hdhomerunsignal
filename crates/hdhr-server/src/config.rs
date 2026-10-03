//! Settings from the environment. The names and defaults are the Node server's,
//! so an existing deployment keeps working unchanged.

use std::collections::HashSet;
use std::path::PathBuf;

use hdhr_core::validate::{self, TrustProxy};

const DEFAULT_PORT: u16 = 3000;
const DEFAULT_RATE_LIMIT: u32 = 300;

#[derive(Debug, Clone)]
pub struct Config {
    /// `PORT`. 0 picks a free port, which the tests use.
    pub port: u16,
    /// `HDHOMERUN_DEVICES`: devices to add by address, as written (not yet validated).
    pub manual_devices: Vec<String>,
    /// `HDHOMERUN_DISABLE_DISCOVERY=true`.
    pub disable_discovery: bool,
    /// `HDHR_DISABLE_CLOUD_DISCOVERY=true`.
    pub disable_cloud_discovery: bool,
    /// `HDHR_CLOUD_DISCOVERY_URL`, for tests and alternative lookups.
    pub cloud_discovery_url: String,
    /// `HDHR_ALLOWED_ORIGINS`: browser origins allowed to call the API cross-origin.
    pub allowed_origins: HashSet<String>,
    /// `HDHR_RATE_LIMIT`: requests per minute per client; 0 turns limiting off.
    pub rate_limit: u32,
    /// `HDHR_TRUST_PROXY`.
    pub trust_proxy: TrustProxy,
    /// `HDHR_STATIC_DIR`: the built frontend to serve.
    pub static_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Reads settings through `get`, so tests can supply their own. A value that
    /// would weaken a protection (an invalid `HDHR_TRUST_PROXY`) is an error
    /// rather than a silent fallback.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let text = |name: &str| get(name).unwrap_or_default();
        let flag = |name: &str| text(name) == "true";

        let port = match text("PORT").trim() {
            "" => DEFAULT_PORT,
            value => value
                .parse()
                .map_err(|_| format!("Invalid PORT {}", validate::log_safe(value)))?,
        };
        let rate_limit = match text("HDHR_RATE_LIMIT").trim() {
            "" => DEFAULT_RATE_LIMIT,
            value => value.parse().unwrap_or_else(|_| {
                tracing::warn!(
                    "Ignoring invalid HDHR_RATE_LIMIT {}; using {DEFAULT_RATE_LIMIT}",
                    validate::log_safe(value)
                );
                DEFAULT_RATE_LIMIT
            }),
        };
        let trust_proxy = validate::parse_trust_proxy(get("HDHR_TRUST_PROXY").as_deref())?;
        let list = |name: &str| -> Vec<String> {
            text(name)
                .split(',')
                .map(|item| item.trim().to_owned())
                .filter(|item| !item.is_empty())
                .collect()
        };

        Ok(Self {
            port,
            manual_devices: list("HDHOMERUN_DEVICES"),
            disable_discovery: flag("HDHOMERUN_DISABLE_DISCOVERY"),
            disable_cloud_discovery: flag("HDHR_DISABLE_CLOUD_DISCOVERY"),
            cloud_discovery_url: get("HDHR_CLOUD_DISCOVERY_URL")
                .filter(|url| !url.is_empty())
                .unwrap_or_else(|| hdhr_client::DEFAULT_CLOUD_URL.to_owned()),
            allowed_origins: list("HDHR_ALLOWED_ORIGINS").into_iter().collect(),
            rate_limit,
            trust_proxy,
            static_dir: get("HDHR_STATIC_DIR")
                .filter(|dir| !dir.is_empty())
                .unwrap_or_else(|| "public".into())
                .into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(vars: &[(&str, &str)]) -> Result<Config, String> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(|name| vars.get(name).cloned())
    }

    #[test]
    fn defaults() {
        let c = config(&[]).unwrap();
        assert_eq!((c.port, c.rate_limit), (3000, 300));
        assert!(c.manual_devices.is_empty() && c.allowed_origins.is_empty());
        assert!(!c.disable_discovery && !c.disable_cloud_discovery);
        assert_eq!(c.trust_proxy, TrustProxy::Disabled);
        assert_eq!(
            c.cloud_discovery_url,
            "https://ipv4-api.hdhomerun.com/discover"
        );
        assert_eq!(c.static_dir, PathBuf::from("public"));
    }

    #[test]
    fn empty_values_mean_the_default() {
        let c = config(&[
            ("PORT", ""),
            ("HDHR_RATE_LIMIT", ""),
            ("HDHR_CLOUD_DISCOVERY_URL", ""),
            ("HDHR_TRUST_PROXY", ""),
        ])
        .unwrap();
        assert_eq!((c.port, c.rate_limit), (3000, 300));
        assert_eq!(c.trust_proxy, TrustProxy::Disabled);
    }

    #[test]
    fn port_zero_is_kept_and_a_bad_port_is_an_error() {
        assert_eq!(config(&[("PORT", "0")]).unwrap().port, 0);
        assert_eq!(config(&[("PORT", "8080")]).unwrap().port, 8080);
        assert!(config(&[("PORT", "http")]).is_err());
        assert!(config(&[("PORT", "70000")]).is_err());
    }

    #[test]
    fn flags_are_only_true_for_the_exact_word() {
        for value in ["false", "0", "TRUE", "yes", ""] {
            let c = config(&[
                ("HDHR_DISABLE_CLOUD_DISCOVERY", value),
                ("HDHOMERUN_DISABLE_DISCOVERY", value),
            ])
            .unwrap();
            assert!(
                !c.disable_cloud_discovery && !c.disable_discovery,
                "{value:?}"
            );
        }
        let c = config(&[
            ("HDHR_DISABLE_CLOUD_DISCOVERY", "true"),
            ("HDHOMERUN_DISABLE_DISCOVERY", "true"),
        ])
        .unwrap();
        assert!(c.disable_cloud_discovery && c.disable_discovery);
    }

    #[test]
    fn lists_are_trimmed_and_drop_empty_items() {
        let c = config(&[
            ("HDHOMERUN_DEVICES", " 10.0.0.5, ,hdhr.local,"),
            (
                "HDHR_ALLOWED_ORIGINS",
                "https://a.example, https://b.example",
            ),
        ])
        .unwrap();
        assert_eq!(c.manual_devices, ["10.0.0.5", "hdhr.local"]);
        assert!(c.allowed_origins.contains("https://b.example") && c.allowed_origins.len() == 2);
    }

    #[test]
    fn a_rate_limit_that_is_not_a_number_falls_back_to_the_default() {
        assert_eq!(
            config(&[("HDHR_RATE_LIMIT", "lots")]).unwrap().rate_limit,
            300
        );
        assert_eq!(config(&[("HDHR_RATE_LIMIT", "0")]).unwrap().rate_limit, 0);
        assert_eq!(config(&[("HDHR_RATE_LIMIT", "5")]).unwrap().rate_limit, 5);
    }

    #[test]
    fn an_invalid_trust_proxy_is_an_error_not_a_fallback() {
        for bad in ["true", "0", "33", "0.0.0.0/0", "loopback"] {
            let error = config(&[("HDHR_TRUST_PROXY", bad)]).unwrap_err();
            assert!(error.contains("Invalid HDHR_TRUST_PROXY"), "{bad}: {error}");
        }
        assert_eq!(
            config(&[("HDHR_TRUST_PROXY", "1")]).unwrap().trust_proxy,
            TrustProxy::Hops(1)
        );
    }
}
