//! The shared pollers, with the clock paused so that seconds pass instantly and
//! exactly.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use hdhr_client::{BackendError, DeviceBackend, Hdhr};
use hdhr_core::model::ScannedChannel;
use hdhr_core::parse::Discovered;
use hdhr_server::hub::{Hub, HubConfig, Key, Message, PlpLog};
use serde_json::{Value, json};

const TUNED: &str = include_str!("../../hdhr-core/tests/fixtures/hardware-status-locked.txt");
const IDLE: &str = include_str!("../../hdhr-core/tests/fixtures/hardware-status-idle.txt");

#[derive(Default)]
struct Mock {
    gets: HashMap<String, String>,
    /// How long every call takes to answer.
    delay: Duration,
    /// Variables whose calls never answer.
    hang: Vec<String>,
    calls: Mutex<Vec<String>>,
}

impl Mock {
    fn with(mut self, variable: &str, value: &str) -> Self {
        self.gets.insert(variable.into(), value.into());
        self
    }

    fn count(&self, call: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| *c == call)
            .count()
    }
}

#[async_trait]
impl DeviceBackend for Mock {
    async fn discover(&self, _: Option<&str>) -> Result<Vec<Discovered>, BackendError> {
        Ok(Vec::new())
    }

    async fn get(&self, device: &str, variable: &str) -> Result<String, BackendError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("get {device} {variable}"));
        if self.hang.iter().any(|v| v == variable) {
            std::future::pending::<()>().await;
        }
        tokio::time::sleep(self.delay).await;
        self.gets
            .get(variable)
            .cloned()
            .ok_or(BackendError::Failed {
                message: "ERROR: unknown getset variable".into(),
                exit_code: Some(1),
            })
    }

    async fn set(&self, _: &str, _: &str, _: &str) -> Result<String, BackendError> {
        Ok(String::new())
    }

    async fn scan(&self, _: &str, _: u8, _: &str) -> Result<Vec<ScannedChannel>, BackendError> {
        Ok(Vec::new())
    }
}

fn hub(mock: Mock) -> (Arc<Hub>, Arc<Mock>) {
    let mock = Arc::new(mock);
    let hub = Hub::new(
        Hdhr::new(mock.clone()),
        Arc::new(PlpLog::default()),
        HubConfig::default(),
    );
    (hub, mock)
}

fn tuner(device: &str, tuner: u8) -> Key {
    Key::Tuner {
        device: device.into(),
        tuner,
    }
}

fn data(message: &Message) -> Value {
    serde_json::from_str(&message.data).unwrap()
}

/// Lets time pass, and the poller run, by `seconds`.
async fn pass(seconds: f64) {
    tokio::time::sleep(Duration::from_secs_f64(seconds)).await;
}

// ------------------------------------------------------------------ sharing

#[tokio::test(start_paused = true)]
async fn many_subscribers_share_one_poller() {
    let (hub, mock) = hub(Mock::default().with("/tuner0/status", IDLE));
    let subscriptions: Vec<_> = (0..3).map(|_| hub.subscribe(tuner("h", 0))).collect();
    assert_eq!(hub.active(), 1);

    pass(2.5).await; // polls at 0 s, 1 s and 2 s
    assert_eq!(
        mock.count("get h /tuner0/status"),
        3,
        "one poll per tick, not one per subscriber"
    );
    assert_eq!(mock.count("get h /tuner0/debug"), 3);
    drop(subscriptions);
}

#[tokio::test(start_paused = true)]
async fn each_tuner_and_each_mode_has_its_own_poller() {
    let (hub, _) = hub(Mock::default());
    let _a = hub.subscribe(tuner("h", 0));
    let _b = hub.subscribe(tuner("h", 1));
    let _c = hub.subscribe(tuner("other", 0));
    let _d = hub.subscribe(Key::Antenna {
        device: "h".into(),
        tuners: 2,
    });
    let _e = hub.subscribe(Key::Antenna {
        device: "h".into(),
        tuners: 3,
    });
    assert_eq!(hub.active(), 5);
    let _same = hub.subscribe(tuner("h", 0));
    assert_eq!(hub.active(), 5);
}

#[tokio::test(start_paused = true)]
async fn the_poller_stops_with_the_last_subscriber_and_restarts_for_the_next() {
    let (hub, mock) = hub(Mock::default().with("/tuner0/status", IDLE));
    let first = hub.subscribe(tuner("h", 0));
    let second = hub.subscribe(tuner("h", 0));
    pass(1.5).await;
    assert_eq!(mock.count("get h /tuner0/status"), 2);

    drop(first);
    pass(2.0).await;
    assert_eq!(hub.active(), 1, "one subscriber is still watching");
    assert_eq!(mock.count("get h /tuner0/status"), 4);

    drop(second);
    assert_eq!(hub.active(), 0);
    let stopped_at = mock.count("get h /tuner0/status");
    pass(10.0).await;
    assert_eq!(
        mock.count("get h /tuner0/status"),
        stopped_at,
        "nothing is polled while nobody watches"
    );

    let _again = hub.subscribe(tuner("h", 0));
    pass(0.5).await;
    assert_eq!(
        mock.count("get h /tuner0/status"),
        stopped_at + 1,
        "a new subscriber starts it again"
    );
}

#[tokio::test(start_paused = true)]
async fn a_late_subscriber_gets_the_latest_reading_without_waiting() {
    let (hub, _) = hub(Mock::default().with("/tuner0/status", TUNED));
    let early = hub.subscribe(tuner("h", 0));
    pass(0.1).await;
    assert!(early.latest.borrow().is_some());

    let late = hub.subscribe(tuner("h", 0));
    assert!(late.latest.borrow().is_some(), "no wait for the next tick");
    assert_eq!(late.latest.borrow().as_ref().unwrap().event, "tuner-status");

    // A stream that opens a new poller has nothing yet, and gets its first reading at once.
    let fresh = hub.subscribe(tuner("h", 1));
    assert!(fresh.latest.borrow().is_none());
    pass(0.1).await;
    assert!(
        fresh.latest.borrow().is_some(),
        "the first poll runs immediately"
    );
}

// ------------------------------------------------------------------- timing

#[tokio::test(start_paused = true)]
async fn a_poll_that_has_not_finished_is_never_overlapped() {
    // Each tick takes 1.2 s (its calls run together), longer than the 1 s interval.
    let mock = Mock {
        delay: Duration::from_millis(1200),
        ..Mock::default()
    }
    .with("/tuner0/status", IDLE);
    let (hub, mock) = hub(mock);
    let _subscription = hub.subscribe(tuner("h", 0));
    pass(3.1).await;
    // Ticks start at 0 s, 1.2 s and 2.4 s. Starting one every second would make four.
    assert_eq!(mock.count("get h /tuner0/status"), 3);
}

#[tokio::test(start_paused = true)]
async fn a_device_that_stops_answering_cannot_stall_the_stream() {
    let mock = Mock {
        hang: vec![
            "/tuner0/status".into(),
            "/tuner0/debug".into(),
            "/tuner0/program".into(),
        ],
        ..Mock::default()
    };
    let (hub, _) = hub(mock);
    let subscription = hub.subscribe(tuner("h", 0));
    pass(4.9).await;
    assert!(
        subscription.latest.borrow().is_none(),
        "still waiting inside the 5 s limit"
    );
    pass(0.2).await;
    let latest = subscription
        .latest
        .borrow()
        .clone()
        .expect("a reading once the limit passed");
    // A device that did not answer still gets an event, with no channel or lock.
    assert_eq!(
        data(&latest),
        json!({ "currentProgram": null, "plpInfo": null, "l1Info": null })
    );
}

// ------------------------------------------------------------------ content

#[tokio::test(start_paused = true)]
async fn a_tuned_tuner_reports_status_program_plp_and_l1() {
    let (hub, mock) = hub(Mock::default()
        .with("/tuner0/status", TUNED)
        .with("/tuner0/program", "3")
        .with(
            "/tuner0/plpinfo",
            "0: sfi=0 mod=qam256 cod=10/15 layer=core ti=cti lls=1 lock=1",
        )
        .with("/tuner0/l1info", "fft_size=8192"));
    let subscription = hub.subscribe(tuner("h", 0));
    pass(0.1).await;
    let message = subscription.latest.borrow().clone().unwrap();
    assert_eq!(message.event, "tuner-status");
    let body = data(&message);
    assert_eq!(
        (
            body["channel"].as_str(),
            body["lock"].as_bool(),
            body["ss"].as_u64()
        ),
        (Some("auto:34"), Some(true), Some(86))
    );
    assert_eq!(body["currentProgram"], "3");
    assert_eq!(body["plpInfo"]["0"]["modulation"], "qam256");
    assert_eq!(body["l1Info"], json!({ "fft_size": "8192" }));
    assert_eq!(mock.count("get h /tuner0/plpinfo"), 1);
}

#[tokio::test(start_paused = true)]
async fn an_idle_tuner_skips_the_atsc3_queries() {
    let (hub, mock) = hub(Mock::default()
        .with("/tuner0/status", IDLE)
        .with("/tuner0/program", "none"));
    let subscription = hub.subscribe(tuner("h", 0));
    pass(0.1).await;
    let body = data(&subscription.latest.borrow().clone().unwrap());
    assert_eq!(body["channel"], "none");
    assert_eq!(
        (
            body["lock"].as_bool(),
            body["currentProgram"].clone(),
            body["plpInfo"].clone()
        ),
        (Some(false), Value::Null, Value::Null)
    );
    assert_eq!(
        mock.count("get h /tuner0/plpinfo") + mock.count("get h /tuner0/l1info"),
        0
    );
}

#[tokio::test(start_paused = true)]
async fn antenna_mode_reports_every_tuner_and_survives_one_failing() {
    // Tuner 1 does not answer.
    let (hub, _) = hub(Mock::default()
        .with("/tuner0/status", TUNED)
        .with("/tuner2/status", IDLE));
    let subscription = hub.subscribe(Key::Antenna {
        device: "h".into(),
        tuners: 3,
    });
    pass(0.1).await;
    let message = subscription.latest.borrow().clone().unwrap();
    assert_eq!(message.event, "antenna-mode-status");
    let readings = data(&message);
    let readings = readings.as_array().unwrap();
    assert_eq!(
        readings
            .iter()
            .map(|r| r["tuner"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [0, 1, 2]
    );
    assert_eq!(readings[0]["status"]["channel"], "auto:34");
    assert_eq!(readings[1]["status"], Value::Null);
    assert_eq!(readings[2]["status"]["channel"], "none");
}
