//! Runs against a real device. Ignored by default:
//!
//!     HDHR_TEST_DEVICE=192.168.1.50 cargo test -p hdhr-client --test hardware -- --ignored
//!
//! These only read, except `tune_and_clear`, which also needs HDHR_TEST_TUNE set
//! to a channel (e.g. `auto:34`) and refuses to touch tuner 0 unless it is idle.
//! `scan` needs HDHR_TEST_SCAN=1 and takes about two minutes. It uses tuner 0
//! unless HDHR_TEST_SCAN_TUNER says otherwise.

use std::sync::Arc;

use hdhr_client::{CliBackend, Hdhr};

fn device() -> Option<String> {
    std::env::var("HDHR_TEST_DEVICE")
        .ok()
        .filter(|d| !d.is_empty())
}

fn hdhr() -> Hdhr {
    Hdhr::new(Arc::new(CliBackend::default()))
}

#[tokio::test]
#[ignore = "needs a device: set HDHR_TEST_DEVICE"]
async fn reads_the_device() {
    let Some(host) = device() else { return };
    let hdhr = hdhr();

    let found = hdhr
        .backend()
        .discover(Some(&host))
        .await
        .expect("discover");
    assert_eq!(found.len(), 1, "{found:?}");
    println!("discover: {found:?}");

    let model = hdhr.hardware_model(&host).await.expect("hardware model");
    let info = hdhr.device_info(&host).await;
    println!("model {model}, info {info:?}");
    assert!(info.tuners >= 1 && info.tuners <= 8);
    assert_ne!(info.model, "Unknown");

    let by_host = hdhr.device_by_host(&host).await;
    println!("device: {by_host:?}");
    assert!(by_host.online);

    for tuner in 0..info.tuners {
        let status = hdhr.tuner_status(&host, tuner).await.expect("tuner status");
        println!("tuner {tuner}: {status:?}");
        assert!(status.channel.is_some());
    }

    assert!(
        hdhr.tuner_status(&host, info.tuners).await.is_none() || info.tuners == 8,
        "one past the last tuner does not exist"
    );
    let plp = hdhr.plp_info(&host, 0).await;
    println!("plp: {plp:?}");
}

#[tokio::test]
#[ignore = "needs a device: set HDHR_TEST_DEVICE and HDHR_TEST_TUNE"]
async fn tune_and_clear() {
    let (Some(host), Ok(channel)) = (device(), std::env::var("HDHR_TEST_TUNE")) else {
        return;
    };
    let hdhr = hdhr();

    let before = hdhr.tuner_status(&host, 0).await.expect("tuner status");
    if before.channel.as_deref() != Some("none") {
        println!("tuner 0 is in use ({:?}); not touching it", before.channel);
        return;
    }

    let outcome = async {
        hdhr.set_channel(&host, 0, &channel).await.expect("tune");
        let mut programs = Vec::new();
        for _ in 0..10 {
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
            programs = hdhr.programs(&host, 0).await;
            if !programs.is_empty() {
                break;
            }
        }
        let status = hdhr
            .tuner_status(&host, 0)
            .await
            .expect("status while tuned");
        (status, programs)
    }
    .await;
    // Always give the tuner back.
    hdhr.clear_tuner(&host, 0).await.expect("clear");

    let (status, programs) = outcome;
    println!("tuned: {status:?}\nprograms: {programs:?}");
    assert!(status.lock, "no lock on {channel}");
    assert!(!programs.is_empty(), "no programs on {channel}");
    let after = hdhr
        .tuner_status(&host, 0)
        .await
        .expect("status after clear");
    assert_eq!(after.channel.as_deref(), Some("none"));
}

#[tokio::test]
#[ignore = "needs a device and two minutes: set HDHR_TEST_DEVICE and HDHR_TEST_SCAN=1"]
async fn scan() {
    let (Some(host), Ok(_)) = (device(), std::env::var("HDHR_TEST_SCAN")) else {
        return;
    };
    // The scan needs a tuner nobody else is using: HDHR_TEST_SCAN_TUNER, default 0.
    let tuner = std::env::var("HDHR_TEST_SCAN_TUNER")
        .ok()
        .and_then(|t| t.parse().ok())
        .unwrap_or(0);
    let channels = hdhr().scan(&host, tuner, "us-bcast").await.expect("scan");
    println!("{} channels locked", channels.len());
    assert!(channels.iter().all(|c| c.modulation != "none"));
}
