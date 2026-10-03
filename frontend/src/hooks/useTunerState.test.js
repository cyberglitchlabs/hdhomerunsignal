import { deriveAtsc3State } from './useTunerState';

describe('deriveAtsc3State', () => {
  test('a status with PLP data is an ATSC 3.0 channel', () => {
    const plpInfo = { 0: { modulation: 'qam256', lock: true } };
    const l1Info = { fft_size: '8192' };
    expect(deriveAtsc3State({ plpInfo, l1Info })).toEqual({ isAtsc3Channel: true, plpInfo, l1Info });
  });

  test('a status without PLP data is not', () => {
    expect(deriveAtsc3State({ channel: 'auto:27', lock: true })).toEqual({
      isAtsc3Channel: false,
      plpInfo: null,
      l1Info: null
    });
  });

  test('null PLP and L1 info are not an ATSC 3.0 channel', () => {
    expect(deriveAtsc3State({ plpInfo: null, l1Info: null })).toEqual({
      isAtsc3Channel: false,
      plpInfo: null,
      l1Info: null
    });
  });

  test('empty PLP data is passed through but is not detected as ATSC 3.0', () => {
    expect(deriveAtsc3State({ plpInfo: {} })).toEqual({ isAtsc3Channel: false, plpInfo: {}, l1Info: null });
  });
});
