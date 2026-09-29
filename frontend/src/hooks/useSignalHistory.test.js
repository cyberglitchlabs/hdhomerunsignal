import { HISTORY_SLOTS, emptyHistory, appendSample } from './useSignalHistory';

const sample = (ss, snq) => ({ ss, snq, lock: true });
const opts = (key, fixedWindow, now = 1) => ({ key, fixedWindow, now });

describe('emptyHistory', () => {
  test('fixed window starts full of blanks', () => {
    const h = emptyHistory('a', true);
    expect(h.signal).toHaveLength(HISTORY_SLOTS);
    expect(h.signal.every(v => v === null)).toBe(true);
    expect(h.times.every(v => v === '')).toBe(true);
  });

  test('growing window starts empty', () => {
    expect(emptyHistory('a', false).signal).toEqual([]);
  });
});

describe('appendSample', () => {
  test('fixed window stays HISTORY_SLOTS wide and fills from the right', () => {
    let h = emptyHistory('a', true);
    h = appendSample(h, sample(50, 60), opts('a', true, 1));
    h = appendSample(h, sample(55, 65), opts('a', true, 2));
    expect(h.signal).toHaveLength(HISTORY_SLOTS);
    expect(h.signal.slice(-2)).toEqual([50, 55]);
    expect(h.snr.slice(-2)).toEqual([60, 65]);
    expect(h.times.slice(-2)).toEqual([1, 2]);
    expect(h.signal[0]).toBeNull();
  });

  test('growing window grows, then drops the oldest reading at the limit', () => {
    let h = emptyHistory('a', false);
    for (let i = 0; i < HISTORY_SLOTS + 5; i += 1) {
      h = appendSample(h, sample(i, i), opts('a', false, i));
    }
    expect(h.signal).toHaveLength(HISTORY_SLOTS);
    expect(h.signal[0]).toBe(5);
    expect(h.signal[HISTORY_SLOTS - 1]).toBe(HISTORY_SLOTS + 4);
  });

  test('a different key discards the old readings', () => {
    let h = emptyHistory('ch-7', false);
    h = appendSample(h, sample(80, 90), opts('ch-7', false));
    h = appendSample(h, sample(30, 40), opts('ch-9', false));
    expect(h.key).toBe('ch-9');
    expect(h.signal).toEqual([30]);
  });

  test('missing values are recorded as 0 and the input is not mutated', () => {
    const before = emptyHistory('a', false);
    const after = appendSample(before, {}, opts('a', false));
    expect(after.signal).toEqual([0]);
    expect(after.snr).toEqual([0]);
    expect(before.signal).toEqual([]);
  });
});
