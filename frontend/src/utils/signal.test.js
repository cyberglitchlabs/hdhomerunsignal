import { formatDataRate, getSignalColor, trackMetric } from './signal';

describe('getSignalColor', () => {
  test('green from 80, amber from 60, red below', () => {
    expect(getSignalColor(100)).toBe('#4CAF50');
    expect(getSignalColor(80)).toBe('#4CAF50');
    expect(getSignalColor(79)).toBe('#FF9800');
    expect(getSignalColor(60)).toBe('#FF9800');
    expect(getSignalColor(59)).toBe('#F44336');
    expect(getSignalColor(0)).toBe('#F44336');
  });
});

describe('formatDataRate', () => {
  test('shows megabits to three places', () => {
    expect(formatDataRate(19392658)).toBe('19.393 Mbps');
    expect(formatDataRate(12345678)).toBe('12.346 Mbps');
  });

  test('no rate is 0.000 Mbps', () => {
    expect(formatDataRate(0)).toBe('0.000 Mbps');
    expect(formatDataRate(undefined)).toBe('0.000 Mbps');
  });
});

describe('trackMetric', () => {
  test('starts from the first reading', () => {
    expect(trackMetric(undefined, 60)).toEqual({ initial: 60, max: 60 });
  });

  test('a zero first reading has no start yet', () => {
    expect(trackMetric(undefined, 0)).toEqual({ initial: null, max: 0 });
    expect(trackMetric(undefined, undefined)).toEqual({ initial: null, max: 0 });
  });

  test('latches the start on the first non-zero reading', () => {
    const waiting = trackMetric(undefined, 0);
    expect(trackMetric(waiting, 45)).toEqual({ initial: 45, max: 45 });
  });

  test('raises the peak and returns the same object when nothing moved', () => {
    const prev = trackMetric(undefined, 60);
    expect(trackMetric(prev, 75)).toEqual({ initial: 60, max: 75 });
    expect(trackMetric(prev, 60)).toBe(prev);
    expect(trackMetric(prev, 10)).toBe(prev);
  });
});
