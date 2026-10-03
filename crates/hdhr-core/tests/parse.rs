//! Fixture tests for the parsers. `hardware-*` fixtures are verbatim captures
//! from an HDHomeRun HDTC-2US; `synthetic-*` ones are written by hand (see
//! tests/fixtures/README.md).

use hdhr_core::model::TunerStatus;
use hdhr_core::parse::*;
use serde_json::json;

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!("fixtures/", $name))
    };
}

fn to_json<T: serde::Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap()
}

// ---------------------------------------------------------------- discovery

#[test]
fn discover_parses_the_device_on_the_network() {
    let found = parse_discover(fixture!("hardware-discover.txt"));
    assert_eq!(
        found,
        vec![Discovered {
            device_id: "10548B20".into(),
            ip: "192.168.100.61".into()
        }]
    );
}

#[test]
fn discover_lists_each_device_once_in_order_and_ignores_other_lines() {
    let output = "\
hdhomerun device 1080ABCD found at 192.168.1.50
some other line
hdhomerun device 10548B20 found at 192.168.1.51
hdhomerun device 1080ABCD found at 192.168.1.50

";
    let ids: Vec<_> = parse_discover(output)
        .into_iter()
        .map(|d| d.device_id)
        .collect();
    assert_eq!(ids, ["1080ABCD", "10548B20"]);
    assert!(parse_discover("").is_empty());
    assert!(parse_discover("no device found").is_empty());
}

#[test]
fn discover_by_host_yields_the_device_id() {
    assert_eq!(
        parse_discover_id(fixture!("hardware-discover-host.txt")).as_deref(),
        Some("10548B20")
    );
    assert_eq!(parse_discover_id("ERROR: no device found"), None);
}

#[test]
fn cloud_discovery_keeps_tuners_with_an_address() {
    let devices = parse_cloud_discover(fixture!("synthetic-cloud-discover.json")).unwrap();
    // The DVR (StorageID) and the entry without an address are dropped.
    assert_eq!(
        devices,
        vec![CloudDevice {
            device_id: "10548B20".into(),
            local_ip: "192.168.100.61".into()
        }]
    );
    assert!(parse_cloud_discover("[]").unwrap().is_empty());
    assert!(parse_cloud_discover("not json").is_err());
    assert!(parse_cloud_discover("{}").is_err());
}

#[test]
fn device_names() {
    assert_eq!(
        device_name("10548B20", Some("HDTC-2US")),
        "HDHomeRun 10548B20 (HDTC-2US)"
    );
    assert_eq!(device_name("10548B20", None), "HDHomeRun 10548B20");
    assert_eq!(
        host_device_name("10.0.0.5", Some("10548B20"), "HDTC-2US"),
        "HDHomeRun 10548B20 (HDTC-2US)"
    );
    assert_eq!(
        host_device_name("10.0.0.5", None, "HDTC-2US"),
        "HDHomeRun HDTC-2US (10.0.0.5)"
    );
}

// ------------------------------------------------------------- device info

#[test]
fn tuner_count_is_the_number_of_tuners_that_answered() {
    // The test device answers for tuners 0 and 1 only.
    assert_eq!(
        tuner_count(&[true, true, false, false, false, false, false, false]),
        2
    );
    assert_eq!(tuner_count(&[true; 4]), 4);
    assert_eq!(tuner_count(&[false; 8]), 2);
}

#[test]
fn tuners_for_model_by_name() {
    assert_eq!(tuners_for_model("HDHR5-4US"), 2);
    assert_eq!(tuners_for_model("HDHOMERUN_PRIME"), 3);
    assert_eq!(tuners_for_model("HDHR-QUATTRO"), 4);
    assert_eq!(tuners_for_model("HDTC-2US"), 2);
}

// ------------------------------------------------------------ tuner status

#[test]
fn idle_tuner_status() {
    // A real idle tuner prints "ch=none lock=none". The Node server reported
    // lock=true here (any lock= field counted); the port keeps that.
    let status = parse_tuner_status(
        fixture!("hardware-status-idle.txt"),
        Some(fixture!("hardware-debug-idle.txt")),
    );
    assert_eq!(
        to_json(&status),
        json!({ "channel": "none", "lock": true, "ss": 0, "snq": 0, "seq": 0, "bps": 0, "pps": 0 })
    );
}

#[test]
fn the_word_none_alone_is_an_unlocked_idle_tuner() {
    assert_eq!(
        to_json(&parse_tuner_status("none\n", None)),
        json!({ "channel": "none", "lock": false })
    );
}

#[test]
fn locked_tuner_status_with_db_estimates() {
    let status = parse_tuner_status(
        fixture!("synthetic-status-locked.txt"),
        Some(fixture!("synthetic-debug-locked.txt")),
    );
    assert_eq!(
        to_json(&status),
        json!({
            "channel": "8vsb:34", "lock": true, "ss": 85, "snq": 100, "seq": 100,
            "bps": 19392640, "pps": 1812,
            // signal 65 raw is "good" (-50 - (80 - 65) * 0.5); snr 19 raw * 0.31
            "ssDb": -57.5, "snrDb": 5.9, "debugRaw": "65-19/-1817"
        })
    );
}

#[test]
fn db_estimate_bands_and_rounding() {
    let db = |signal: u32, snr: u32| {
        let s = parse_tuner_status(
            "ch=8vsb:34 lock=8vsb",
            Some(&format!("tun: dbg={signal}-{snr}/5")),
        );
        (s.ss_db.unwrap(), s.snr_db.unwrap())
    };
    assert_eq!(db(100, 80), (-40.0, 24.8)); // strong
    assert_eq!(db(80, 0), (-40.0 - 10.0, 0.0)); // lower edge of strong, no SNR
    assert_eq!(db(79, 1), (-50.5, 0.3)); // just below the strong band
    assert_eq!(db(60, 10), (-60.0, 3.1)); // good
    assert_eq!(db(20, 10), (-80.0, 3.1)); // fair
    assert_eq!(db(10, 10), (-85.0, 3.1)); // weak
    assert_eq!(db(0, 10), (-90.0, 3.1));
}

#[test]
fn debug_counter_leading_zeros_are_dropped_but_the_third_value_is_kept_verbatim() {
    let status = parse_tuner_status("ch=8vsb:34 lock=8vsb", Some("tun: dbg=065-019/007"));
    assert_eq!(status.debug_raw.as_deref(), Some("65-19/007"));
}

#[test]
fn missing_fields_stay_unset() {
    let status = parse_tuner_status("ch=8vsb:34", None);
    assert_eq!(
        to_json(&status),
        json!({ "channel": "8vsb:34", "lock": false })
    );
    assert_eq!(
        to_json(&parse_tuner_status("", None)),
        json!({ "lock": false })
    );
    assert_eq!(
        parse_tuner_status("ch=8vsb:34 lock=8vsb ss=1", Some("garbage")),
        TunerStatus {
            channel: Some("8vsb:34".into()),
            lock: true,
            ss: Some(1),
            ..TunerStatus::default()
        }
    );
}

#[test]
fn current_program() {
    // The test device reports "0 transcode=none" when idle, which the Node
    // server passed through as the program; the port does the same.
    assert_eq!(
        parse_current_program(fixture!("hardware-program-idle.txt")).as_deref(),
        Some("0 transcode=none")
    );
    assert_eq!(parse_current_program("none\n"), None);
    assert_eq!(parse_current_program("  \n"), None);
    assert_eq!(parse_current_program("3\n").as_deref(), Some("3"));
}

// ----------------------------------------------------------------- programs

#[test]
fn streaminfo_of_an_idle_tuner_has_no_programs() {
    assert!(parse_streaminfo(fixture!("hardware-streaminfo-none.txt")).is_empty());
}

#[test]
fn streaminfo_atsc1() {
    let programs = parse_streaminfo(fixture!("synthetic-streaminfo-atsc1.txt"));
    assert_eq!(
        to_json(&programs),
        json!([
            { "programNum": "3", "virtualChannel": "2.1", "name": "MNPBS", "callsign": "MNPBS",
              "status": "", "encrypted": false, "atsc3": false },
            { "programNum": "4", "virtualChannel": "2.4", "name": "MNKIDS", "callsign": "MNKIDS",
              "status": "encrypted", "encrypted": true, "atsc3": false },
            { "programNum": "5", "virtualChannel": "2.3", "name": "MNLIFE", "callsign": "MNLIFE",
              "status": "no data", "encrypted": false, "atsc3": false },
        ])
    );
}

#[test]
fn streaminfo_atsc3_services() {
    let programs = parse_streaminfo(fixture!("synthetic-streaminfo-atsc3.txt"));
    let summary: Vec<_> = programs
        .iter()
        .map(|p| {
            (
                p.program_num.as_str(),
                p.virtual_channel.as_str(),
                p.name.as_str(),
                p.status.as_str(),
                p.atsc3,
                p.encrypted,
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("1", "12.1", "WHYY", "atsc3", true, false),
            ("2", "12.2", "WHYY-Create", "", false, false),
            ("3", "12.3", "Kids", "encrypted", false, true),
        ]
    );
}

#[test]
fn streaminfo_with_the_tsid_on_the_program_line() {
    let programs = parse_streaminfo("tsid=0x0001 program=1: 12.1 WHYY (encrypted)\r\n");
    assert_eq!(programs.len(), 1);
    assert_eq!(
        (programs[0].program_num.as_str(), programs[0].name.as_str()),
        ("1", "WHYY")
    );
    assert!(programs[0].encrypted);
}

// --------------------------------------------------------------------- scan

#[test]
fn scan_keeps_only_the_channels_that_locked() {
    let channels = parse_scan(fixture!("hardware-scan-us-bcast.txt"));
    // 15 of the 49 scanned frequencies locked (counted from the raw file), and
    // every one of the 83 PROGRAM lines belongs to one of them.
    let names: Vec<_> = channels.iter().map(|c| c.channel.as_str()).collect();
    assert_eq!(
        names,
        [
            "us-bcast:36",
            "us-bcast:35",
            "us-bcast:34",
            "us-bcast:33",
            "us-bcast:32",
            "us-bcast:31",
            "us-bcast:30",
            "us-bcast:29",
            "us-bcast:26",
            "us-bcast:25",
            "us-bcast:20",
            "us-bcast:16",
            "us-bcast:15",
            "us-bcast:14",
            "us-bcast:9",
        ]
    );
    assert!(channels.iter().all(|c| c.modulation == "8vsb"));
    assert_eq!(channels.iter().map(|c| c.programs.len()).sum::<usize>(), 83);
    // Channel 33 locked but carried no programs; channel 34 carries five.
    assert_eq!(channels[3].programs.len(), 0);
    assert_eq!(channels[2].programs.len(), 5);
    assert_eq!(
        (
            channels[0].frequency.as_str(),
            channels[14].frequency.as_str()
        ),
        ("605000000", "189000000")
    );
}

#[test]
fn scan_reads_signal_numbers_and_programs() {
    let channels = parse_scan(fixture!("hardware-scan-us-bcast.txt"));
    assert_eq!(
        to_json(&channels[2]),
        json!({
            "frequency": "593000000", "channel": "us-bcast:34", "modulation": "8vsb",
            "signalStrength": 85, "snr": 100, "symbolQuality": 100,
            "programs": [
                { "programNum": "3", "virtualChannel": "2.1", "name": "MNPBS" },
                { "programNum": "4", "virtualChannel": "2.4", "name": "MNKIDS" },
                { "programNum": "5", "virtualChannel": "2.3", "name": "MNLIFE" },
                { "programNum": "6", "virtualChannel": "2.5", "name": "MNREADY" },
                { "programNum": "7", "virtualChannel": "2.2", "name": "MNCH" },
            ]
        })
    );
    // A program name may contain spaces and punctuation.
    assert_eq!(channels[1].programs[1].name, "H & I");
}

#[test]
fn scan_programs_never_attach_to_an_earlier_channel_after_a_failed_lock() {
    let output = "\
SCANNING: 599000000 (us-bcast:35)
LOCK: 8vsb (ss=79 snq=78 seq=100)
PROGRAM 3: 5.1 KSTPDT
SCANNING: 593000000 (us-bcast:34)
LOCK: none (ss=7 snq=0 seq=0)
PROGRAM 9: 9.1 Stray
";
    let channels = parse_scan(output);
    assert_eq!(channels.len(), 1);
    assert_eq!(channels[0].programs.len(), 1);
}

#[test]
fn scan_accepts_scanning_and_lock_on_one_line() {
    let channels = parse_scan(
        "SCANNING: 575000000 (us-bcast:30) LOCK: 8vsb (ss=90 snq=80 seq=100)\nPROGRAM 1: 4.1 WCCO\n",
    );
    assert_eq!(channels.len(), 1);
    assert_eq!(channels[0].channel, "us-bcast:30");
    assert_eq!(channels[0].programs.len(), 1);
}

#[test]
fn scan_of_nothing_is_empty() {
    assert!(parse_scan("").is_empty());
    assert!(parse_scan("ERROR: no device found").is_empty());
}

// ------------------------------------------------------------------- ATSC 3

#[test]
fn plpinfo_of_a_device_without_atsc3_is_none() {
    assert_eq!(parse_plpinfo(fixture!("hardware-plpinfo-empty.txt")), None);
    assert_eq!(parse_plpinfo(""), None);
    assert_eq!(parse_plpinfo("not a plp line\n"), None);
}

#[test]
fn plpinfo_parses_each_plp() {
    let plps = parse_plpinfo(fixture!("synthetic-plpinfo.txt")).unwrap();
    assert_eq!(
        to_json(&plps),
        json!({
            "0": { "sfi": "0", "modulation": "qam256", "coderate": "10/15", "layer": "core",
                   "timeInterleaving": "cti", "lls": true, "lock": true },
            "1": { "sfi": "0", "modulation": "qpsk", "coderate": "6/15", "layer": "core",
                   "timeInterleaving": "off", "lls": false, "lock": false },
        })
    );
}

#[test]
fn plpinfo_keys_are_in_numeric_order_and_missing_fields_are_left_out() {
    let plps = parse_plpinfo("10: mod=qam64\n2: lock=1\n").unwrap();
    assert_eq!(plps.keys().copied().collect::<Vec<_>>(), [2, 10]);
    assert_eq!(to_json(&plps[&2]), json!({ "lock": true }));
}

#[test]
fn l1info_collects_every_key_value_pair() {
    let info = parse_l1info(fixture!("synthetic-l1info.txt")).unwrap();
    assert_eq!(info["l1_basic_mode"], "1");
    assert_eq!(info["fft_size"], "8192");
    assert_eq!(info["pilot_pattern"], "sp12_2");
    assert_eq!(info.len(), 5);
}

#[test]
fn l1info_with_no_pairs_is_none() {
    assert_eq!(parse_l1info(""), None);
    assert_eq!(parse_l1info("nothing here\n"), None);
}
