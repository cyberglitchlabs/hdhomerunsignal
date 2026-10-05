//! CliBackend against a fake `hdhomerun_config`, a shell script that records the
//! arguments it received, one per line, and answers by variable name.

use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use hdhr_client::{BackendError, CliBackend, CliConfig, DeviceBackend};

const SCAN: &str = include_str!("../../hdhr-core/tests/fixtures/hardware-scan-us-bcast.txt");

struct Fake {
    dir: PathBuf,
    backend: CliBackend,
}

impl Fake {
    fn new(call_timeout: Duration) -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "hdhr-client-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("scan.txt"), SCAN).unwrap();
        let script = format!(
            r#"#!/bin/sh
[ "$1" = "--probe" ] && exit 0
for a in "$@"; do printf '%s\n' "$a"; done >> '{dir}/args.log'
echo '--' >> '{dir}/args.log'
case "$*" in
  *"get /tuner0/status") echo 'ch=none lock=none ss=0 snq=0 seq=0 bps=0 pps=0' ;;
  *"get /tuner9/status"|*"get /missing") echo 'ERROR: unknown getset variable'; exit 1 ;;
  *"get /hang") echo $$ > '{dir}/hung.pid'; exec sleep 30 ;;
  *"discover") echo 'hdhomerun device 10548B20 found at 192.168.100.61' ;;
  *"discover 10.0.0.9") echo 'hdhomerun device 1080ABCD found at 10.0.0.9' ;;
  *" scan /tuner0 us-bcast") cat '{dir}/scan.txt'; exit 1 ;;
  *" scan /tuner1 us-cable") echo 'ERROR: no device found'; exit 1 ;;
  *"set /tuner0/channel"*) echo "set:$4" ;;
  *) ;;
esac
"#,
            dir = dir.display()
        );
        let program = dir.join("hdhomerun_config");
        fs::write(&program, script).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        wait_until_executable(&program);
        let backend = CliBackend::new(CliConfig {
            program: program.into(),
            call_timeout,
            ..CliConfig::default()
        });
        Self { dir, backend }
    }

    /// The argument lists of every call so far.
    fn calls(&self) -> Vec<Vec<String>> {
        let log = fs::read_to_string(self.dir.join("args.log")).unwrap_or_default();
        log.split("--\n")
            .filter(|call| !call.is_empty())
            .map(|call| call.lines().map(str::to_owned).collect())
            .collect()
    }
}

/// Running a file fails with "Text file busy" while any process still has it open
/// for writing, and these tests run on parallel threads of one process: a fork on
/// another thread can briefly inherit the write descriptor of the script just
/// written. Run it once, retrying while it is busy. After one run succeeds nothing
/// holds it open for writing (the descriptor is closed, so no later fork can
/// inherit it), and the calls under test cannot hit the error.
fn wait_until_executable(program: &Path) {
    for _ in 0..500 {
        match Command::new(program).arg("--probe").status() {
            Err(error) if error.kind() == ErrorKind::ExecutableFileBusy => {
                std::thread::sleep(Duration::from_millis(10));
            }
            result => {
                assert!(result.unwrap().success());
                return;
            }
        }
    }
    panic!("{} is still busy after 5 seconds", program.display());
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn alive(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid])
        .output()
        .is_ok_and(|o| o.status.success())
}

#[tokio::test]
async fn get_passes_exact_arguments_and_returns_trimmed_output() {
    let fake = Fake::new(Duration::from_secs(5));
    let value = fake
        .backend
        .get("192.168.100.61", "/tuner0/status")
        .await
        .unwrap();
    assert_eq!(value, "ch=none lock=none ss=0 snq=0 seq=0 bps=0 pps=0");
    assert_eq!(fake.calls(), [["192.168.100.61", "get", "/tuner0/status"]]);
}

#[tokio::test]
async fn set_passes_the_value_as_one_literal_argument() {
    let fake = Fake::new(Duration::from_secs(5));
    // No shell: these are data, not syntax, and "-" is a legitimate channel value.
    for value in [
        "-",
        "+",
        "none",
        "$(touch pwned)",
        "a b; touch pwned",
        "auto:34",
    ] {
        let echoed = fake
            .backend
            .set("10.0.0.5", "/tuner0/channel", value)
            .await
            .unwrap();
        assert_eq!(echoed, format!("set:{value}"));
    }
    assert!(!Path::new("pwned").exists());
    let last = fake.calls().pop().unwrap();
    assert_eq!(last, ["10.0.0.5", "set", "/tuner0/channel", "auto:34"]);
    assert_eq!(
        fake.calls()[4],
        ["10.0.0.5", "set", "/tuner0/channel", "a b; touch pwned"]
    );
}

#[tokio::test]
async fn unsafe_arguments_are_refused_before_anything_runs() {
    let fake = Fake::new(Duration::from_secs(5));
    for device in ["-h", "--help", "a;id", "$(id)", "a b", "", "x\ny"] {
        assert!(
            matches!(
                fake.backend.get(device, "/tuner0/status").await,
                Err(BackendError::InvalidArgument { .. })
            ),
            "{device:?}"
        );
    }
    for variable in [
        "tuner0/status",
        "/tuner0/status; id",
        "-h",
        "/a b",
        "",
        "/",
        "/tuner0/$(id)",
    ] {
        assert!(
            matches!(
                fake.backend.get("10.0.0.5", variable).await,
                Err(BackendError::InvalidArgument { .. })
            ),
            "{variable:?}"
        );
    }
    assert!(matches!(
        fake.backend
            .set("10.0.0.5", "/tuner0/channel", "a\0b")
            .await,
        Err(BackendError::InvalidArgument { .. })
    ));
    assert!(matches!(
        fake.backend.discover(Some("-h")).await,
        Err(BackendError::InvalidArgument { .. })
    ));
    assert!(matches!(
        fake.backend.scan("10.0.0.5", 8, "us-bcast").await,
        Err(BackendError::InvalidArgument { .. })
    ));
    assert!(matches!(
        fake.backend.scan("10.0.0.5", 0, "us-bcast; id").await,
        Err(BackendError::InvalidArgument { .. })
    ));
    assert_eq!(
        fake.calls(),
        Vec::<Vec<String>>::new(),
        "the tool must not have been run"
    );
}

#[tokio::test]
async fn a_failing_call_reports_what_the_tool_said() {
    let fake = Fake::new(Duration::from_secs(5));
    match fake.backend.get("10.0.0.5", "/missing").await {
        Err(BackendError::Failed { message, exit_code }) => {
            assert_eq!(message, "ERROR: unknown getset variable");
            assert_eq!(exit_code, Some(1));
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_call_that_hangs_times_out_and_the_process_is_killed() {
    // Generous, so a slow first exec of the script cannot beat the timeout.
    let fake = Fake::new(Duration::from_secs(2));
    let started = std::time::Instant::now();
    let result = fake.backend.get("10.0.0.5", "/hang").await;
    assert!(
        matches!(result, Err(BackendError::Timeout(_))),
        "{result:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(10));

    let pid = fs::read_to_string(fake.dir.join("hung.pid"))
        .unwrap()
        .trim()
        .to_owned();
    for _ in 0..40 {
        if !alive(&pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("process {pid} is still running after the timeout");
}

#[tokio::test]
async fn a_missing_tool_is_a_spawn_error() {
    let backend = CliBackend::new(CliConfig {
        program: "/nonexistent/hdhomerun_config".into(),
        ..CliConfig::default()
    });
    assert!(matches!(
        backend.get("10.0.0.5", "/sys/model").await,
        Err(BackendError::Spawn { .. })
    ));
}

#[tokio::test]
async fn discover_parses_the_broadcast_and_a_single_target() {
    let fake = Fake::new(Duration::from_secs(5));
    let all = fake.backend.discover(None).await.unwrap();
    assert_eq!(
        (all[0].device_id.as_str(), all[0].ip.as_str()),
        ("10548B20", "192.168.100.61")
    );
    let one = fake.backend.discover(Some("10.0.0.9")).await.unwrap();
    assert_eq!(one[0].device_id, "1080ABCD");
    assert_eq!(
        fake.calls(),
        [vec!["discover"], vec!["discover", "10.0.0.9"]]
    );
}

#[tokio::test]
async fn a_scan_that_exits_with_status_1_still_returns_its_channels() {
    // The real tool exits 1 after a completed scan.
    let fake = Fake::new(Duration::from_secs(5));
    let channels = fake.backend.scan("10.0.0.5", 0, "us-bcast").await.unwrap();
    assert_eq!(channels.len(), 15);
    assert_eq!(fake.calls(), [["10.0.0.5", "scan", "/tuner0", "us-bcast"]]);
}

#[tokio::test]
async fn a_scan_that_did_not_start_is_a_failure() {
    let fake = Fake::new(Duration::from_secs(5));
    assert!(matches!(
        fake.backend.scan("10.0.0.5", 1, "us-cable").await,
        Err(BackendError::Failed { .. })
    ));
}
