// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import { useTunerState } from './useTunerState';

const reading = (channel, extra = {}) => ({ channel, lock: true, ss: 80, snq: 90, ...extra });
const atsc3 = { plpInfo: { 0: { lock: true } }, l1Info: { fft_size: '8192' } };

// Every render's view of the state, so a test can see a render that mixes sources
function watch(initialSource) {
  const renders = [];
  const hook = renderHook(({ source }) => {
    const state = useTunerState(source);
    renders.push({ source, channel: state.tunerStatus?.channel ?? null, plp: state.plpInfo, atsc3: state.isAtsc3Channel });
    return state;
  }, { initialProps: { source: initialSource } });
  return { ...hook, renders };
}

describe('useTunerState', () => {
  test('keeps a reading for the source it arrived on', () => {
    const { result } = watch('A/0');
    act(() => result.current.handleTunerStatus(reading('auto:27', atsc3)));
    expect(result.current.tunerStatus.channel).toBe('auto:27');
    expect(result.current.isAtsc3Channel).toBe(true);
    expect(result.current.plpInfo).toEqual(atsc3.plpInfo);
  });

  test('no render for a new source ever shows the old source\'s reading', () => {
    const { result, rerender, renders } = watch('A/0');
    act(() => result.current.handleTunerStatus(reading('auto:27', atsc3)));
    renders.length = 0;

    rerender({ source: 'A/1' });

    expect(renders.length).toBeGreaterThan(0);
    for (const render of renders) {
      expect(render).toEqual({ source: 'A/1', channel: null, plp: null, atsc3: false });
    }
  });

  test('a reading after the switch belongs to the new source', () => {
    const { result, rerender } = watch('A/0');
    act(() => result.current.handleTunerStatus(reading('auto:27')));
    rerender({ source: 'A/1' });
    act(() => result.current.handleTunerStatus(reading('auto:27'))); // same channel and lock as before

    expect(result.current.tunerStatus).toEqual(reading('auto:27'));
  });

  test('going back to a source does not bring its old reading back', () => {
    const { result, rerender } = watch('A/0');
    act(() => result.current.handleTunerStatus(reading('auto:27')));
    rerender({ source: 'A/1' });
    rerender({ source: 'A/0' });
    expect(result.current.tunerStatus).toBeNull();
  });

  test('clearAtsc3Info drops the PLP and L1 details and keeps the reading', () => {
    const { result } = watch('A/0');
    act(() => result.current.handleTunerStatus(reading('auto:27', atsc3)));
    act(() => result.current.clearAtsc3Info());

    expect(result.current.tunerStatus.channel).toBe('auto:27');
    expect(result.current.isAtsc3Channel).toBe(false);
    expect(result.current.plpInfo).toBeNull();
    expect(result.current.l1Info).toBeNull();
  });
});
