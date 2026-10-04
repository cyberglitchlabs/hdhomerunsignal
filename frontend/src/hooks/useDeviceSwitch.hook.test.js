// @vitest-environment jsdom
import { renderHook, act, waitFor } from '@testing-library/react';
import axios from 'axios';
import { useDevices, FALLBACK_DEVICE_INFO, INFO_TIMEOUT_MS } from './useDevices';
import { useEventStream } from './useEventStream';
import { useSelectedTuner } from './useSelectedTuner';

vi.mock('axios');

class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.listeners = {};
    FakeEventSource.instances.push(this);
  }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  close() { this.closed = true; }
}
const opened = () => FakeEventSource.instances.map((s) => s.url);
const open = () => FakeEventSource.instances.filter((s) => !s.closed).map((s) => s.url);

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const noop = () => {};

describe('useSelectedTuner', () => {
  test('is the chosen tuner while the device info is unknown', () => {
    const { result } = renderHook(({ info }) => useSelectedTuner(info), { initialProps: { info: null } });
    act(() => result.current[1](3));
    expect(result.current[0]).toBe(3);
  });

  test('is already clamped in the render where the info arrives', () => {
    const seen = [];
    const { result, rerender } = renderHook(({ info }) => {
      const value = useSelectedTuner(info);
      seen.push(value[0]);
      return value;
    }, { initialProps: { info: null } });
    act(() => result.current[1](3));
    seen.length = 0;

    rerender({ info: { tuners: 2 } });

    expect(seen[0]).toBe(1); // never 3 with the 2-tuner info
    expect(result.current[0]).toBe(1);
  });

  test('keeps a tuner the device has', () => {
    const { result } = renderHook(() => useSelectedTuner({ tuners: 4 }));
    act(() => result.current[1](3));
    expect(result.current[0]).toBe(3);
  });
});

describe('switching device', () => {
  // The three hooks wired as SignalMeter wires them
  function useView({ selectedDevice, info }) {
    const [tuner, setTuner] = useSelectedTuner(info);
    useEventStream({
      selectedDevice, selectedTuner: tuner, antennaMode: false, deviceInfo: info,
      onTunerStatus: noop, onAntennaModeStatus: noop, onLeaveAntennaMode: noop
    });
    return { tuner, setTuner };
  }

  test('no stream is opened until the device info is known', () => {
    renderHook(() => useView({ selectedDevice: 'A', info: null }));
    expect(opened()).toEqual([]);
  });

  test('switching from tuner 3 of a 4-tuner device to a 2-tuner one opens one valid stream', () => {
    const { result, rerender } = renderHook((p) => useView(p), {
      initialProps: { selectedDevice: 'A', info: { tuners: 4 } }
    });
    act(() => result.current.setTuner(3));
    expect(open()).toEqual(['/api/v1/devices/A/tuner/3/stream']);
    FakeEventSource.instances = [];

    rerender({ selectedDevice: 'B', info: null }); // selection committed, info still loading
    expect(opened()).toEqual([]);

    rerender({ selectedDevice: 'B', info: { tuners: 2 } });
    expect(opened()).toEqual(['/api/v1/devices/B/tuner/1/stream']);
  });

  test('the old device stream is closed as soon as the switch is made', () => {
    const { rerender } = renderHook((p) => useView(p), {
      initialProps: { selectedDevice: 'A', info: { tuners: 2 } }
    });
    rerender({ selectedDevice: 'B', info: null });
    expect(open()).toEqual([]);
  });
});

describe('useDevices info request', () => {
  const device = { id: 'AAAA', online: true };

  function serve({ info }) {
    axios.get.mockImplementation(async (url) => {
      if (url.includes('/info')) return info();
      return { data: [device] };
    });
  }

  test('a failed info request falls back to a default tuner count and reports the error', async () => {
    serve({ info: async () => { throw new Error('boom'); } });
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.infoError).toBe(true));
    expect(result.current.selectedDevice).toBe('AAAA');
    expect(result.current.deviceInfo).toEqual(FALLBACK_DEVICE_INFO);
  });

  test('retrying loads the real info and clears the error', async () => {
    let fail = true;
    serve({ info: async () => { if (fail) throw new Error('boom'); return { data: { tuners: 4 } }; } });
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.infoError).toBe(true));

    fail = false;
    await act(() => result.current.retryDeviceInfo());

    expect(result.current.infoError).toBe(false);
    expect(result.current.deviceInfo).toEqual({ tuners: 4 });
  });

  test('a failure for a device the user already left is ignored', async () => {
    let rejectFirst;
    axios.get.mockImplementation(async (url) => {
      if (url.includes('/devices/AAAA/info')) return new Promise((_, reject) => { rejectFirst = reject; });
      if (url.includes('/devices/BBBB/info')) return { data: { tuners: 4 } };
      return { data: [device, { id: 'BBBB', online: true }] };
    });
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.selectedDevice).toBe('AAAA'));

    await act(() => result.current.selectDevice('BBBB'));
    await act(async () => rejectFirst(new Error('late')));

    expect(result.current.selectedDevice).toBe('BBBB');
    expect(result.current.deviceInfo).toEqual({ tuners: 4 });
    expect(result.current.infoError).toBe(false);
  });

  test('switching device drops the old device info and any error', async () => {
    serve({ info: async () => { throw new Error('boom'); } });
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.infoError).toBe(true));

    axios.get.mockImplementation(async () => new Promise(() => {})); // next info never answers
    act(() => { result.current.selectDevice('BBBB'); });

    expect(result.current.deviceInfo).toBeNull();
    expect(result.current.infoError).toBe(false);
  });
});

describe('an assumed (fallback) device info', () => {
  test('is marked as assumed, so it cannot be mistaken for loaded info', () => {
    expect(FALLBACK_DEVICE_INFO).toEqual({ tuners: 2, assumed: true });
  });

  test('limits the tuner in use but does not overwrite the choice, so a retry gets it back', () => {
    const { result, rerender } = renderHook(({ info }) => useSelectedTuner(info), {
      initialProps: { info: { tuners: 4 } }
    });
    act(() => result.current[1](3));
    expect(result.current[0]).toBe(3);

    rerender({ info: FALLBACK_DEVICE_INFO }); // /info failed, so two tuners are assumed
    expect(result.current[0]).toBe(1);

    rerender({ info: { tuners: 4 } }); // Retry loaded the real info
    expect(result.current[0]).toBe(3);
  });

  test('real info still moves the choice off a tuner the device lacks', () => {
    const { result, rerender } = renderHook(({ info }) => useSelectedTuner(info), {
      initialProps: { info: { tuners: 4 } }
    });
    act(() => result.current[1](3));
    rerender({ info: { tuners: 2 } });
    rerender({ info: { tuners: 4 } });
    expect(result.current[0]).toBe(1); // it did not drift back to 3
  });
});

describe('the info request timeout', () => {
  test('is bounded, and asked for with a timeout', async () => {
    axios.get.mockImplementation(async (url) => (url.includes('/info') ? { data: { tuners: 4 } } : { data: [{ id: 'AAAA', online: true }] }));
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.deviceInfo).toEqual({ tuners: 4 }));

    const infoCall = axios.get.mock.calls.find(([url]) => url.includes('/info'));
    expect(infoCall[1]).toEqual({ timeout: INFO_TIMEOUT_MS });
    expect(INFO_TIMEOUT_MS).toBeGreaterThan(0);
    expect(INFO_TIMEOUT_MS).toBeLessThanOrEqual(10000);
  });

  test('a timed-out request becomes the assumed info, so monitoring can start', async () => {
    axios.get.mockImplementation(async (url) => {
      if (url.includes('/info')) throw Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' });
      return { data: [{ id: 'AAAA', online: true }] };
    });
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.deviceInfo).toEqual(FALLBACK_DEVICE_INFO));
    expect(result.current.infoError).toBe(true);
  });
});
