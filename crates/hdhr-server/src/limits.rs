//! Per-client request limiting.
//!
//! A fixed window per client address, the same shape as the Node server's
//! `express-rate-limit`: the first request starts a window, requests inside it
//! count, and the window starts over once it has elapsed. A smoothed limiter
//! would admit extra requests as it refills, which is not what the limits mean.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use hdhr_core::validate::TrustProxy;

/// Windows are dropped once the table holds this many clients.
const SWEEP_AT: usize = 4096;

pub struct RateLimiter {
    limit: u32,
    window: Duration,
    buckets: Mutex<HashMap<String, (Instant, u32)>>,
}

impl RateLimiter {
    /// `limit` requests per `window`; a limit of 0 never refuses.
    pub fn new(limit: u32, window: Duration) -> Self {
        Self {
            limit,
            window,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Counts a request from `client`. `Err` carries how long until the window
    /// ends when the request is over the limit.
    pub fn hit(&self, client: &str) -> Result<(), Duration> {
        if self.limit == 0 {
            return Ok(());
        }
        let now = Instant::now();
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if buckets.len() >= SWEEP_AT {
            buckets.retain(|_, (started, _)| now.duration_since(*started) < self.window);
        }
        let (started, count) = buckets.entry(client.to_owned()).or_insert((now, 0));
        if now.duration_since(*started) >= self.window {
            (*started, *count) = (now, 0);
        }
        *count += 1;
        if *count > self.limit {
            Err(self.window.saturating_sub(now.duration_since(*started)))
        } else {
            Ok(())
        }
    }
}

/// Works out which address a request really came from.
#[derive(Debug, Clone)]
pub enum ClientAddress {
    /// Ignore `X-Forwarded-For`: whoever connected is the client.
    Direct,
    /// Believe it from this many proxies in front of the server.
    Hops(u32),
    /// Believe it from proxies at these addresses.
    Proxies(Vec<(IpAddr, u8)>),
}

impl ClientAddress {
    pub fn new(trust: &TrustProxy) -> Self {
        match trust {
            TrustProxy::Disabled => Self::Direct,
            TrustProxy::Hops(hops) => Self::Hops(*hops),
            TrustProxy::Addrs(entries) => {
                Self::Proxies(entries.iter().filter_map(|e| parse_cidr(e)).collect())
            }
        }
    }

    /// The bucket key for a request from `socket` carrying `forwarded_for`.
    ///
    /// Walks the chain from the connection backwards, past each trusted proxy,
    /// and stops at the first address that is not trusted: that is the client.
    /// Everything further left was written by the client or a proxy we do not
    /// trust, so it cannot be used to pick a bucket.
    pub fn resolve(&self, socket: IpAddr, forwarded_for: Option<&str>) -> String {
        let chain: Vec<String> = std::iter::once(unmap(socket).to_string())
            .chain(
                forwarded_for
                    .unwrap_or_default()
                    .rsplit(',')
                    .map(str::trim)
                    .filter(|entry| !entry.is_empty())
                    .map(str::to_owned),
            )
            .collect();

        let trusted = |index: usize| match self {
            Self::Direct => false,
            Self::Hops(hops) => (index as u64) < u64::from(*hops),
            Self::Proxies(nets) => chain[index]
                .parse::<IpAddr>()
                .is_ok_and(|ip| nets.iter().any(|&(net, prefix)| in_net(ip, net, prefix))),
        };
        let client = (0..chain.len() - 1)
            .find(|&i| !trusted(i))
            .unwrap_or(chain.len() - 1);
        bucket_key(&chain[client])
    }
}

/// An IPv4 address that arrived on a dual-stack socket as `::ffff:a.b.c.d`.
fn unmap(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        v4 => v4,
    }
}

fn parse_cidr(entry: &str) -> Option<(IpAddr, u8)> {
    let (address, prefix) = entry
        .split_once('/')
        .map_or((entry, None), |(a, p)| (a, Some(p)));
    let ip = unmap(address.parse().ok()?);
    let full = if ip.is_ipv4() { 32 } else { 128 };
    let prefix = match prefix {
        Some(p) => p.parse::<u8>().ok().filter(|&p| p <= full)?,
        None => full,
    };
    Some((ip, prefix))
}

fn in_net(ip: IpAddr, net: IpAddr, prefix: u8) -> bool {
    match (unmap(ip), net) {
        (IpAddr::V4(ip), IpAddr::V4(net)) => {
            mask_u32(prefix) & u32::from(ip) == mask_u32(prefix) & u32::from(net)
        }
        (IpAddr::V6(ip), IpAddr::V6(net)) => {
            mask_u128(prefix) & u128::from(ip) == mask_u128(prefix) & u128::from(net)
        }
        _ => false,
    }
}

fn mask_u32(prefix: u8) -> u32 {
    u32::MAX.checked_shl(32 - u32::from(prefix)).unwrap_or(0)
}

fn mask_u128(prefix: u8) -> u128 {
    u128::MAX.checked_shl(128 - u32::from(prefix)).unwrap_or(0)
}

/// The key a client's requests are counted under. An IPv6 client usually owns a
/// whole /64 and can pick addresses freely within it, so v6 addresses share a
/// bucket per /56, as `express-rate-limit` does.
fn bucket_key(address: &str) -> String {
    match address.parse::<IpAddr>() {
        Ok(IpAddr::V6(v6)) => {
            let masked = Ipv6Addr::from(u128::from(v6) & mask_u128(56));
            format!("{masked}/56")
        }
        Ok(ip) => ip.to_string(),
        Err(_) => address.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn allows_up_to_the_limit_then_refuses() {
        let limiter = RateLimiter::new(3, Duration::from_secs(60));
        let results: Vec<bool> = (0..5).map(|_| limiter.hit("a").is_ok()).collect();
        assert_eq!(results, [true, true, true, false, false]);
    }

    #[test]
    fn clients_are_counted_separately() {
        let limiter = RateLimiter::new(1, Duration::from_secs(60));
        assert!(limiter.hit("a").is_ok());
        assert!(limiter.hit("a").is_err());
        assert!(limiter.hit("b").is_ok());
    }

    #[test]
    fn a_limit_of_zero_never_refuses() {
        let limiter = RateLimiter::new(0, Duration::from_secs(60));
        assert!((0..100).all(|_| limiter.hit("a").is_ok()));
    }

    #[test]
    fn the_window_starts_over_once_it_has_elapsed() {
        let limiter = RateLimiter::new(1, Duration::from_millis(60));
        assert!(limiter.hit("a").is_ok());
        let wait = limiter.hit("a").unwrap_err();
        assert!(wait <= Duration::from_millis(60));
        std::thread::sleep(Duration::from_millis(80));
        assert!(limiter.hit("a").is_ok());
    }

    #[test]
    fn a_full_table_drops_expired_windows() {
        let limiter = RateLimiter::new(1, Duration::from_millis(20));
        for i in 0..SWEEP_AT {
            let _ = limiter.hit(&i.to_string());
        }
        std::thread::sleep(Duration::from_millis(40));
        let _ = limiter.hit("new");
        assert!(limiter.buckets.lock().unwrap().len() < SWEEP_AT);
    }

    #[test]
    fn untrusted_proxies_cannot_pick_the_bucket() {
        let direct = ClientAddress::new(&TrustProxy::Disabled);
        assert_eq!(
            direct.resolve(ip("198.51.100.7"), Some("203.0.113.1")),
            "198.51.100.7"
        );
        assert_eq!(direct.resolve(ip("198.51.100.7"), None), "198.51.100.7");
    }

    #[test]
    fn one_trusted_hop_uses_the_last_forwarded_address() {
        let one = ClientAddress::new(&TrustProxy::Hops(1));
        assert_eq!(
            one.resolve(ip("10.0.0.1"), Some("203.0.113.1")),
            "203.0.113.1"
        );
        // Anything the client prepended is ignored: only the proxy's entry counts.
        assert_eq!(
            one.resolve(ip("10.0.0.1"), Some("1.2.3.4, 203.0.113.1")),
            "203.0.113.1"
        );
        // No header at all: the connection itself.
        assert_eq!(one.resolve(ip("10.0.0.1"), None), "10.0.0.1");
    }

    #[test]
    fn two_hops_skip_two_proxies() {
        let two = ClientAddress::new(&TrustProxy::Hops(2));
        assert_eq!(
            two.resolve(ip("10.0.0.1"), Some("203.0.113.1, 10.0.0.2")),
            "203.0.113.1"
        );
        assert_eq!(
            two.resolve(ip("10.0.0.1"), Some("9.9.9.9, 203.0.113.1, 10.0.0.2")),
            "203.0.113.1"
        );
        // A short chain stops at its leftmost address.
        assert_eq!(
            two.resolve(ip("10.0.0.1"), Some("203.0.113.1")),
            "203.0.113.1"
        );
    }

    #[test]
    fn a_list_of_proxies_trusts_only_those_addresses() {
        let list = ClientAddress::new(&TrustProxy::Addrs(vec![
            "127.0.0.1".into(),
            "::1".into(),
            "10.42.0.0/16".into(),
        ]));
        assert_eq!(
            list.resolve(ip("127.0.0.1"), Some("203.0.113.1")),
            "203.0.113.1"
        );
        assert_eq!(list.resolve(ip("::1"), Some("203.0.113.2")), "203.0.113.2");
        // Two trusted proxies in a row are both skipped.
        assert_eq!(
            list.resolve(ip("127.0.0.1"), Some("203.0.113.3, 10.42.7.7")),
            "203.0.113.3"
        );
        // A connection from anyone else is the client, whatever it sends.
        assert_eq!(
            list.resolve(ip("198.51.100.7"), Some("203.0.113.1")),
            "198.51.100.7"
        );
        // IPv4 on a dual-stack socket matches its IPv4 entry.
        assert_eq!(
            list.resolve(ip("::ffff:127.0.0.1"), Some("203.0.113.4")),
            "203.0.113.4"
        );
    }

    #[test]
    fn junk_in_the_header_is_just_a_key() {
        let one = ClientAddress::new(&TrustProxy::Hops(1));
        assert_eq!(one.resolve(ip("10.0.0.1"), Some("not an ip")), "not an ip");
        assert_eq!(one.resolve(ip("10.0.0.1"), Some(" , ,")), "10.0.0.1");
    }

    #[test]
    fn ipv6_clients_share_a_bucket_per_56() {
        let direct = ClientAddress::new(&TrustProxy::Disabled);
        let a = direct.resolve(ip("2001:db8:1234:5600::1"), None);
        let b = direct.resolve(ip("2001:db8:1234:56ff:aaaa::2"), None);
        let other = direct.resolve(ip("2001:db8:1234:5700::1"), None);
        assert_eq!(a, b);
        assert_ne!(a, other);
    }

    #[test]
    fn cidr_matching() {
        assert!(in_net(ip("10.42.9.9"), ip("10.42.0.0"), 16));
        assert!(!in_net(ip("10.43.0.1"), ip("10.42.0.0"), 16));
        assert!(in_net(ip("1.2.3.4"), ip("1.2.3.4"), 32));
        assert!(in_net(ip("fd00::1"), ip("fd00::"), 8));
        assert!(!in_net(ip("fe00::1"), ip("fd00::"), 8));
        assert!(
            !in_net(ip("10.0.0.1"), ip("fd00::"), 8),
            "families do not mix"
        );
    }
}
