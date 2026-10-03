//! The typed operations against a scripted backend, using the parser fixtures.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use hdhr_client::{BackendError, DeviceBackend, Hdhr, RetryPolicy};
use hdhr_core::model::ScannedChannel;
use hdhr_core::parse::{CloudDevice, Discovered};
use serde_json::json;

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!("../../hdhr-core/tests/fixtures/", $name))
    };
}

type Reply = Result<String, String>;

/// Answers `get` from a table (anything not in it fails like an unknown
/// variable) and records every call as a string.
#[derive(Default)]
struct Mock {
    gets: Mutex<HashMap<String, Vec<Reply>>>,
    discover: Mutex<HashMap<Option<String>, Vec<Discovered>>>,
    calls: Mutex<Vec<String>>,
}

impl Mock {
    /// Replies for a variable, used in order; the last one repeats.
    fn on(self, variable: &str, replies: &[Reply]) -> Self {
        self.gets
            .lock()
            .unwrap()
            .insert(variable.to_owned(), replies.to_vec());
        self
    }

    fn ok(self, variable: &str, value: &str) -> Self {
        self.on(variable, &[Ok(value.to_owned())])
    }

    fn found(self, target: Option<&str>, id: &str, ip: &str) -> Self {
        self.discover
            .lock()
            .unwrap()
            .entry(target.map(str::to_owned))
            .or_default()
            .push(Discovered {
                device_id: id.into(),
                ip: ip.into(),
            });
        self
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn count(&self, call: &str) -> usize {
        self.calls().iter().filter(|c| *c == call).count()
    }
}

fn failed(message: &str) -> BackendError {
    BackendError::Failed {
        message: message.into(),
        exit_code: Some(1),
    }
}

#[async_trait]
impl DeviceBackend for Mock {
    async fn discover(&self, target: Option<&str>) -> Result<Vec<Discovered>, BackendError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("discover {}", target.unwrap_or("*")));
        Ok(self
            .discover
            .lock()
            .unwrap()
            .get(&target.map(str::to_owned))
            .cloned()
            .unwrap_or_default())
    }

    async fn get(&self, device: &str, variable: &str) -> Result<String, BackendError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("get {device} {variable}"));
        let mut gets = self.gets.lock().unwrap();
        match gets.get_mut(variable) {
            None => Err(failed("ERROR: unknown getset variable")),
            Some(replies) => {
                let reply = if replies.len() > 1 {
                    replies.remove(0)
                } else {
                    replies[0].clone()
                };
                reply.map_err(|m| failed(&m))
            }
        }
    }

    async fn set(&self, device: &str, variable: &str, value: &str) -> Result<String, BackendError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("set {device} {variable} {value}"));
        Ok(String::new())
    }

    async fn scan(
        &self,
        device: &str,
        tuner: u8,
        map: &str,
    ) -> Result<Vec<ScannedChannel>, BackendError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("scan {device} {tuner} {map}"));
        Ok(Vec::new())
    }
}

fn hdhr(mock: Mock) -> (Hdhr, Arc<Mock>) {
    let mock = Arc::new(mock);
    (Hdhr::new(mock.clone()), mock)
}

fn json_of<T: serde::Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap()
}

// ------------------------------------------------------------------- status

#[tokio::test]
async fn tuner_status_combines_status_and_debug() {
    let (hdhr, mock) = hdhr(
        Mock::default()
            .ok("/tuner1/status", fixture!("hardware-status-locked.txt"))
            .ok("/tuner1/debug", "tun: dbg=65-19/-1817"),
    );
    let status = hdhr.tuner_status("10.0.0.5", 1).await.unwrap();
    assert_eq!(status.channel.as_deref(), Some("auto:34"));
    assert_eq!(
        (status.ss, status.ss_db, status.snr_db),
        (Some(86), Some(-57.5), Some(5.9))
    );
    assert_eq!(mock.count("get 10.0.0.5 /tuner1/status"), 1);
    assert_eq!(mock.count("get 10.0.0.5 /tuner1/debug"), 1);
}

#[tokio::test]
async fn tuner_status_survives_a_missing_debug_but_not_a_missing_status() {
    let (hdhr_debug_missing, _) =
        hdhr(Mock::default().ok("/tuner0/status", "ch=8vsb:27 lock=8vsb ss=90"));
    let status = hdhr_debug_missing.tuner_status("h", 0).await.unwrap();
    assert_eq!((status.ss, status.ss_db), (Some(90), None));

    let (hdhr_none, _) = hdhr(Mock::default().ok("/tuner0/debug", "tun: dbg=65-19/5"));
    assert!(hdhr_none.tuner_status("h", 0).await.is_none());
    let (hdhr_empty, _) = hdhr(Mock::default().ok("/tuner0/status", ""));
    assert!(hdhr_empty.tuner_status("h", 0).await.is_none());
}

#[tokio::test]
async fn a_tuner_the_device_cannot_have_is_never_queried() {
    let (hdhr, mock) = hdhr(Mock::default().ok("/tuner8/status", "x"));
    assert!(hdhr.tuner_status("h", 8).await.is_none());
    assert!(hdhr.current_program("h", 8).await.is_none());
    assert!(hdhr.programs("h", 8).await.is_empty());
    assert!(hdhr.plp_info("h", 8).await.is_err());
    assert!(hdhr.l1_info("h", 8).await.is_none());
    assert!(hdhr.set_channel("h", 8, "27").await.is_err());
    assert_eq!(mock.calls(), Vec::<String>::new());
}

#[tokio::test]
async fn current_program_plp_and_l1() {
    let (hdhr, _) = hdhr(
        Mock::default()
            .ok("/tuner0/program", "3")
            .ok("/tuner0/plpinfo", fixture!("synthetic-plpinfo.txt"))
            .ok("/tuner1/plpinfo", "")
            .ok("/tuner0/l1info", fixture!("synthetic-l1info.txt")),
    );
    assert_eq!(hdhr.current_program("h", 0).await.as_deref(), Some("3"));
    assert_eq!(hdhr.plp_info("h", 0).await.unwrap().unwrap().len(), 2);
    assert!(
        hdhr.plp_info("h", 1).await.unwrap().is_none(),
        "no PLPs is not an error"
    );
    assert!(
        hdhr.plp_info("h", 2).await.is_err(),
        "a device without ATSC 3.0 cannot answer"
    );
    assert_eq!(hdhr.l1_info("h", 0).await.unwrap()["fft_size"], "8192");
    assert!(hdhr.l1_info("h", 1).await.is_none());
}

// ----------------------------------------------------------------- programs

const LOCKED: &str = "ch=8vsb:34 lock=8vsb ss=86 snq=100 seq=100 bps=1 pps=0";

#[tokio::test]
async fn programs_are_not_requested_from_an_idle_tuner() {
    let (hdhr, mock) = hdhr(
        Mock::default()
            .ok("/tuner0/status", fixture!("hardware-status-idle.txt"))
            .ok("/tuner0/streaminfo", "3: 2.1 X"),
    );
    assert!(hdhr.programs("h", 0).await.is_empty());
    assert_eq!(
        mock.count("get h /tuner0/streaminfo"),
        0,
        "an idle tuner has nothing to list"
    );
}

#[tokio::test]
async fn programs_are_not_requested_from_a_frequency_with_no_lock() {
    let (hdhr, mock) = hdhr(
        Mock::default()
            .ok(
                "/tuner0/status",
                "ch=auto:641000000 lock=none ss=47 snq=0 seq=0 bps=0 pps=0",
            )
            .ok("/tuner0/streaminfo", "3: 2.1 X"),
    );
    assert!(hdhr.programs("h", 0).await.is_empty());
    assert_eq!(mock.count("get h /tuner0/streaminfo"), 0);
}

#[tokio::test]
async fn programs_of_a_locked_tuner() {
    let (hdhr, _) = hdhr(Mock::default().ok("/tuner0/status", LOCKED).ok(
        "/tuner0/streaminfo",
        fixture!("hardware-streaminfo-locked.txt"),
    ));
    let programs = hdhr.programs("h", 0).await;
    assert_eq!(programs.len(), 5);
    assert_eq!(json_of(&programs[0])["name"], json!("MNPBS"));
}

#[tokio::test(start_paused = true)]
async fn programs_retry_a_failed_query_after_the_error_delay() {
    let (hdhr, mock) = hdhr(Mock::default().ok("/tuner0/status", LOCKED).on(
        "/tuner0/streaminfo",
        &[
            Err("busy".into()),
            Err("busy".into()),
            Ok(fixture!("hardware-streaminfo-locked.txt").into()),
        ],
    ));
    let started = tokio::time::Instant::now();
    assert_eq!(hdhr.programs("h", 0).await.len(), 5);
    assert_eq!(mock.count("get h /tuner0/streaminfo"), 3);
    assert_eq!(
        started.elapsed(),
        Duration::from_millis(3000),
        "two waits of 1.5 s"
    );
}

#[tokio::test(start_paused = true)]
async fn programs_retry_an_empty_answer_after_the_longer_delay() {
    let (hdhr, mock) = hdhr(Mock::default().ok("/tuner0/status", LOCKED).on(
        "/tuner0/streaminfo",
        &[
            Ok("none".into()),
            Ok(fixture!("hardware-streaminfo-locked.txt").into()),
        ],
    ));
    let started = tokio::time::Instant::now();
    assert_eq!(hdhr.programs("h", 0).await.len(), 5);
    assert_eq!(mock.count("get h /tuner0/streaminfo"), 2);
    assert_eq!(started.elapsed(), Duration::from_millis(2000));
}

#[tokio::test(start_paused = true)]
async fn programs_give_up_after_the_retries() {
    let (hdhr, mock) = hdhr(
        Mock::default()
            .ok("/tuner0/status", LOCKED)
            .on("/tuner0/streaminfo", &[Err("busy".into())]),
    );
    let hdhr = hdhr.with_retry(RetryPolicy {
        max_retries: 2,
        ..RetryPolicy::default()
    });
    assert!(hdhr.programs("h", 0).await.is_empty());
    assert_eq!(
        mock.count("get h /tuner0/streaminfo"),
        3,
        "the first try plus two retries"
    );

    let (hdhr, mock) = hdhr_with_empty();
    assert!(hdhr.programs("h", 0).await.is_empty());
    assert_eq!(
        mock.count("get h /tuner0/streaminfo"),
        4,
        "the default is three retries"
    );
}

fn hdhr_with_empty() -> (Hdhr, Arc<Mock>) {
    hdhr(
        Mock::default()
            .ok("/tuner0/status", LOCKED)
            .ok("/tuner0/streaminfo", "none"),
    )
}

// ----------------------------------------------------------------- devices

#[tokio::test]
async fn device_info_counts_the_tuners_that_answer() {
    let (hdhr, mock) = hdhr(
        Mock::default()
            .ok("/sys/model", "hdhomeruntc_atsc")
            .ok("/tuner0/status", "ch=none")
            .ok("/tuner1/status", "ch=none"),
    );
    let info = hdhr.device_info("h").await;
    assert_eq!(
        json_of(&info),
        json!({ "model": "hdhomeruntc_atsc", "tuners": 2, "atsc3Support": true })
    );
    for tuner in 0..=7 {
        assert_eq!(
            mock.count(&format!("get h /tuner{tuner}/status")),
            1,
            "tuner {tuner} is probed once"
        );
    }

    let mut four = Mock::default().ok("/sys/model", "HDHR5-4US");
    for tuner in 0..4 {
        four = four.ok(&format!("/tuner{tuner}/status"), "ch=none");
    }
    assert_eq!(hdhr_of(four).device_info("h").await.tuners, 4);
}

fn hdhr_of(mock: Mock) -> Hdhr {
    hdhr(mock).0
}

#[tokio::test]
async fn device_info_defaults_when_the_device_does_not_answer() {
    let info = hdhr_of(Mock::default()).device_info("h").await;
    assert_eq!(
        json_of(&info),
        json!({ "model": "Unknown", "tuners": 2, "atsc3Support": false })
    );
    // A model but no tuner answering is still assumed to have two.
    assert_eq!(
        hdhr_of(Mock::default().ok("/sys/model", "X"))
            .device_info("h")
            .await
            .tuners,
        2
    );
}

#[tokio::test]
async fn discovered_devices_are_named_with_their_model() {
    let (hdhr, _) = hdhr(
        Mock::default()
            .found(None, "10548B20", "192.168.100.61")
            .found(None, "1080ABCD", "192.168.100.62")
            .ok("/sys/hwmodel", "HDTC-2US"),
    );
    let devices = hdhr.discover_devices().await;
    assert_eq!(
        json_of(&devices),
        json!([
            { "id": "10548B20", "ip": "192.168.100.61", "name": "HDHomeRun 10548B20 (HDTC-2US)", "online": true },
            { "id": "1080ABCD", "ip": "192.168.100.62", "name": "HDHomeRun 1080ABCD (HDTC-2US)", "online": true },
        ])
    );
    // No model answer: the name has no parentheses.
    let (no_model, _) = hdhr_with_one_device();
    assert_eq!(
        no_model.discover_devices().await[0].name,
        "HDHomeRun 10548B20"
    );
}

fn hdhr_with_one_device() -> (Hdhr, Arc<Mock>) {
    hdhr(Mock::default().found(None, "10548B20", "192.168.100.61"))
}

#[tokio::test]
async fn cloud_devices_are_addressed_by_ip() {
    let (hdhr, _) = hdhr(Mock::default().ok("/sys/hwmodel", "HDTC-2US"));
    let devices = hdhr
        .devices_from_cloud(vec![CloudDevice {
            device_id: "10548B20".into(),
            local_ip: "192.168.100.61".into(),
        }])
        .await;
    assert_eq!(
        json_of(&devices),
        json!([{ "id": "192.168.100.61", "ip": "192.168.100.61", "name": "HDHomeRun 10548B20 (HDTC-2US)", "online": true }])
    );
}

#[tokio::test]
async fn a_device_added_by_address() {
    let (hdhr, _) = hdhr(Mock::default().ok("/sys/hwmodel", "HDTC-2US").found(
        Some("10.0.0.9"),
        "1080ABCD",
        "10.0.0.9",
    ));
    let known = hdhr.device_by_host("10.0.0.9").await;
    assert_eq!(
        json_of(&known),
        json!({ "id": "10.0.0.9", "ip": "10.0.0.9", "name": "HDHomeRun 1080ABCD (HDTC-2US)", "online": true })
    );

    // Reachable, but the ID is unknown: named by model and address.
    let (anonymous, _) = hdhr_with_model();
    assert_eq!(
        anonymous.device_by_host("10.0.0.7").await.name,
        "HDHomeRun HDTC-2US (10.0.0.7)"
    );

    // Unreachable: offline, but still listed, so the UI can grey it out.
    let offline = hdhr_of(Mock::default()).device_by_host("10.0.0.8").await;
    assert_eq!(
        json_of(&offline),
        json!({ "id": "10.0.0.8", "ip": "10.0.0.8", "name": "HDHomeRun (10.0.0.8)", "online": false })
    );
}

fn hdhr_with_model() -> (Hdhr, Arc<Mock>) {
    hdhr(Mock::default().ok("/sys/hwmodel", "HDTC-2US"))
}

// ------------------------------------------------------------------- tuning

#[tokio::test]
async fn tuning_commands() {
    let (hdhr, mock) = hdhr(Mock::default());
    hdhr.set_channel("h", 1, "auto:34").await.unwrap();
    hdhr.channel_up("h", 1).await.unwrap();
    hdhr.channel_down("h", 1).await.unwrap();
    hdhr.clear_tuner("h", 1).await.unwrap();
    hdhr.set_atsc3_channel("h", 0, "27", &[]).await.unwrap();
    hdhr.set_atsc3_channel("h", 0, "27", &[0, 1, 2])
        .await
        .unwrap();
    assert_eq!(
        mock.calls(),
        [
            "set h /tuner1/channel auto:34",
            "set h /tuner1/channel +",
            "set h /tuner1/channel -",
            "set h /tuner1/channel none",
            "set h /tuner0/channel atsc3:27",
            "set h /tuner0/channel atsc3:27:0+1+2",
        ]
    );
}

#[tokio::test]
async fn bad_channels_are_refused_without_calling_the_backend() {
    let (hdhr, mock) = hdhr(Mock::default());
    for bad in ["27; id", "-h", "", "atsc3:27:a", "$(id)"] {
        assert!(
            matches!(
                hdhr.set_channel("h", 0, bad).await,
                Err(BackendError::InvalidArgument { .. })
            ),
            "{bad:?}"
        );
    }
    for bad in ["27:1", "x", "", "12345678901"] {
        assert!(
            matches!(
                hdhr.set_atsc3_channel("h", 0, bad, &[]).await,
                Err(BackendError::InvalidArgument { .. })
            ),
            "{bad:?}"
        );
    }
    assert_eq!(mock.calls(), Vec::<String>::new());
}

#[tokio::test]
async fn scan_goes_to_the_backend() {
    let (hdhr, mock) = hdhr(Mock::default());
    hdhr.scan("h", 1, "us-bcast").await.unwrap();
    assert_eq!(mock.calls(), ["scan h 1 us-bcast"]);
}
