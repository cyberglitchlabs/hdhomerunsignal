import { statsKey, nextSignalStats } from './useSignalStats';

const reading = (ss, snq, seq) => ({ ss, snq, seq });

describe('statsKey', () => {
  test('identifies the device, tuner and channel', () => {
    expect(statsKey('1234ABCD', 2, 'auto:27')).toBe('1234ABCD|2|auto:27');
  });
});

describe('nextSignalStats', () => {
  test('the first reading becomes both the start and the peak', () => {
    const stats = nextSignalStats(null, reading(55, 50, 100), 'k');
    expect(stats).toEqual({
      key: 'k',
      ss: { initial: 55, max: 55 },
      snq: { initial: 50, max: 50 },
      seq: { initial: 100, max: 100 }
    });
  });

  test('keeps the start and raises the peak on a higher reading', () => {
    let stats = nextSignalStats(null, reading(55, 50, 100), 'k');
    stats = nextSignalStats(stats, reading(80, 78, 100), 'k');
    expect(stats.ss).toEqual({ initial: 55, max: 80 });
    expect(stats.snq).toEqual({ initial: 50, max: 78 });
  });

  test('a lower reading leaves the peak alone', () => {
    let stats = nextSignalStats(null, reading(80, 78, 100), 'k');
    stats = nextSignalStats(stats, reading(70, 66, 100), 'k');
    expect(stats.ss).toEqual({ initial: 80, max: 80 });
  });

  test('hands back the same object when nothing moved', () => {
    const first = nextSignalStats(null, reading(70, 66, 100), 'k');
    expect(nextSignalStats(first, reading(70, 66, 100), 'k')).toBe(first);
    expect(nextSignalStats(first, reading(60, 60, 90), 'k')).toBe(first);
  });

  test('each metric latches its own start on its first non-zero reading', () => {
    // Still acquiring: signal is up but SNR and symbol quality have not arrived.
    let stats = nextSignalStats(null, reading(60, 0, 0), 'k');
    expect(stats.snq).toEqual({ initial: null, max: 0 });
    stats = nextSignalStats(stats, reading(62, 40, 0), 'k');
    expect(stats.ss.initial).toBe(60);
    expect(stats.snq.initial).toBe(40);
    expect(stats.seq.initial).toBeNull();
    stats = nextSignalStats(stats, reading(62, 45, 100), 'k');
    expect(stats.snq.initial).toBe(40);
    expect(stats.seq.initial).toBe(100);
  });

  test('missing values count as 0', () => {
    const stats = nextSignalStats(null, {}, 'k');
    expect(stats.ss).toEqual({ initial: null, max: 0 });
  });

  test('a different key starts over from the new reading', () => {
    const before = nextSignalStats(null, reading(80, 78, 100), 'ch-7');
    const after = nextSignalStats(before, reading(30, 25, 90), 'ch-9');
    expect(after.key).toBe('ch-9');
    expect(after.ss).toEqual({ initial: 30, max: 30 });
  });

  test('does not mutate the previous stats', () => {
    const before = nextSignalStats(null, reading(55, 50, 100), 'k');
    const snapshot = JSON.parse(JSON.stringify(before));
    nextSignalStats(before, reading(90, 90, 100), 'k');
    expect(before).toEqual(snapshot);
  });
});
