import { useEffect, useState } from 'react';

// Number of readings kept in the rolling window.
export const HISTORY_SLOTS = 60;

// history.key identifies what the readings belong to (e.g. device|tuner|channel).
// Readings recorded under a different key are discarded on the next sample.
export function emptyHistory(key, fixedWindow) {
  const blank = (value) => (fixedWindow ? Array(HISTORY_SLOTS).fill(value) : []);
  return { key, signal: blank(null), snr: blank(null), times: blank('') };
}

// Pure, so it is safe to call from a state updater.
export function appendSample(history, sample, { key, fixedWindow, now }) {
  const base = history.key === key ? history : emptyHistory(key, fixedWindow);
  return {
    key,
    signal: [...base.signal, sample.ss || 0].slice(-HISTORY_SLOTS),
    snr: [...base.snr, sample.snq || 0].slice(-HISTORY_SLOTS),
    times: [...base.times, now].slice(-HISTORY_SLOTS)
  };
}

/**
 * Rolling signal/SNR history for one tuner.
 *
 * sample       tuner status ({ ss, snq, lock }); a new object is one new reading
 * resetKey     history restarts whenever this changes (channel, tuner, device)
 * fixedWindow  true: always HISTORY_SLOTS wide, filled from the right;
 *              false: starts empty and grows up to HISTORY_SLOTS
 * requireLock  true: readings without a lock are not recorded
 */
export function useSignalHistory(sample, { resetKey = '', fixedWindow = true, requireLock = false } = {}) {
  const [history, setHistory] = useState(() => emptyHistory(resetKey, fixedWindow));

  useEffect(() => {
    setHistory(prev => {
      const base = prev.key === resetKey ? prev : emptyHistory(resetKey, fixedWindow);
      if (!sample || (requireLock && !sample.lock)) return base;
      return appendSample(base, sample, { key: resetKey, fixedWindow, now: Date.now() });
    });
  }, [sample, resetKey, fixedWindow, requireLock]);

  return history;
}
