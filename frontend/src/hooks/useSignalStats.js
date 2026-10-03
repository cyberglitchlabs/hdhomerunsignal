import { useEffect, useState } from 'react';
import { trackMetric } from '../utils/signal';

// Stats belong to one device, tuner and channel; any change starts them over.
export function statsKey(device, tuner, channel) {
  return `${device}|${tuner}|${channel}`;
}

// Pure, so it is safe to call from a state updater. Hands back `prev` itself
// when nothing moved.
export function nextSignalStats(prev, status, key) {
  const base = prev && prev.key === key ? prev : null;
  const ss = trackMetric(base?.ss, status.ss);
  const snq = trackMetric(base?.snq, status.snq);
  const seq = trackMetric(base?.seq, status.seq);
  // trackMetric hands back the same object when nothing moved, so this keeps
  // the idle case from re-rendering three progress bars every status tick.
  if (base && ss === base.ss && snq === base.snq && seq === base.seq) return base;
  return { key, ss, snq, seq };
}

/**
 * Per-channel session stats: first locked reading and high-water mark for
 * ss/snq/seq. Reset whenever the tuned channel (or device/tuner) changes.
 * Returns { key, ss, snq, seq }, or null until the stats belong to the
 * channel on screen.
 */
export function useSignalStats(tunerStatus, selectedDevice, selectedTuner) {
  const [signalStats, setSignalStats] = useState(null);

  // Track start/peak signal values for the currently tuned channel
  useEffect(() => {
    const channel = tunerStatus?.channel;
    if (!channel || channel === 'none') {
      setSignalStats(null);
      return;
    }
    // Hold onto the stats through a momentary loss of lock - dropping out while
    // the antenna swings shouldn't wipe the reference points.
    if (!tunerStatus.lock) return;

    const key = statsKey(selectedDevice, selectedTuner, channel);
    setSignalStats((prev) => nextSignalStats(prev, tunerStatus, key));
  }, [tunerStatus, selectedDevice, selectedTuner]);

  // Only show start/peak markers once the stats belong to the channel on screen
  const key = statsKey(selectedDevice, selectedTuner, tunerStatus?.channel);
  return signalStats?.key === key ? signalStats : null;
}
