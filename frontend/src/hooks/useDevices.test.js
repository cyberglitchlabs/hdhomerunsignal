import { chooseDevice, clampTuner } from './useDevices';

const a = { id: 'AAAA', online: true };
const b = { id: 'BBBB', online: true };

describe('chooseDevice', () => {
  test('keeps the current device while it is still online', () => {
    expect(chooseDevice([a, b], 'BBBB')).toBe(b);
  });

  test('picks the first online device when nothing is selected', () => {
    expect(chooseDevice([a, b], '')).toBe(a);
  });

  test('falls back to the first online device when the current one went offline', () => {
    expect(chooseDevice([a, { ...b, online: false }], 'BBBB')).toBe(a);
  });

  test('treats a device with no online flag as online', () => {
    expect(chooseDevice([{ id: 'CCCC' }], '')).toEqual({ id: 'CCCC' });
  });

  test('is null when no device is online', () => {
    expect(chooseDevice([{ ...a, online: false }], 'AAAA')).toBeNull();
    expect(chooseDevice([], 'AAAA')).toBeNull();
  });
});

describe('clampTuner', () => {
  test('keeps a tuner the device has', () => {
    expect(clampTuner(1, { tuners: 4 })).toBe(1);
    expect(clampTuner(3, { tuners: 4 })).toBe(3);
  });

  test('moves to the last tuner when the device has fewer', () => {
    expect(clampTuner(3, { tuners: 2 })).toBe(1);
  });

  test('leaves the tuner alone until the device info is known', () => {
    expect(clampTuner(3, null)).toBe(3);
  });

  test('never goes below tuner 0', () => {
    expect(clampTuner(2, { tuners: 0 })).toBe(0);
  });
});
