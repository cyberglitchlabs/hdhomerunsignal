# Parser fixtures

- `hardware-*` files are verbatim output of `hdhomerun_config` (libhdhomerun
  20260313) against an HDHomeRun `HDTC-2US` (`hdhomeruntc_atsc`, two ATSC 1.0
  tuners, firmware 20260313), captured 2026-10-03 while both tuners were idle.
  The scan is the full `us-bcast` scan of tuner 0.
- `synthetic-*` files are written by hand from the formats the Node server's
  comments describe, for states the test device cannot produce (a tuned
  tuner, ATSC 3.0, the cloud lookup). Replace them with captures when a
  device that can produce them is at hand.
- `hardware-*-locked.txt` were captured with tuner 0 tuned to `auto:34`
  (us-bcast channel 34, 593 MHz); the tuner was cleared afterwards.
