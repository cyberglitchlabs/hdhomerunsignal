import { streamUrl, subscribe } from './useEventStream';

const base = { selectedDevice: '1234ABCD', selectedTuner: 1, antennaMode: false, deviceInfo: { tuners: 4 } };

describe('streamUrl', () => {
  test('normal mode subscribes to the selected tuner', () => {
    expect(streamUrl(base)).toBe('/api/devices/1234ABCD/tuner/1/stream');
  });

  test('normal mode starts without waiting for the device info', () => {
    expect(streamUrl({ ...base, deviceInfo: null })).toBe('/api/devices/1234ABCD/tuner/1/stream');
  });

  test('antenna mode subscribes to every tuner of the device', () => {
    expect(streamUrl({ ...base, antennaMode: true })).toBe('/api/devices/1234ABCD/antenna/stream?tuners=4');
  });

  test('antenna mode waits for the device info', () => {
    expect(streamUrl({ ...base, antennaMode: true, deviceInfo: null })).toBeNull();
  });

  test('nothing to subscribe to without a device', () => {
    expect(streamUrl({ ...base, selectedDevice: '' })).toBeNull();
  });

  test('the device is URL-encoded', () => {
    expect(streamUrl({ ...base, selectedDevice: 'my tuner/1' })).toBe('/api/devices/my%20tuner%2F1/tuner/1/stream');
  });
});

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name, fn) { this.listeners[name] = fn; }

  close() { this.closed = true; }
}

describe('subscribe', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('opens one EventSource on the url and closes it when stopped', () => {
    const stop = subscribe('/api/devices/x/tuner/0/stream', { onTunerStatus: vi.fn(), onAntennaModeStatus: vi.fn() });
    expect(FakeEventSource.instances.map((s) => s.url)).toEqual(['/api/devices/x/tuner/0/stream']);
    stop();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  test('forwards parsed events to the matching callback', () => {
    const onTunerStatus = vi.fn();
    const onAntennaModeStatus = vi.fn();
    subscribe('/u', { onTunerStatus, onAntennaModeStatus });
    const [source] = FakeEventSource.instances;
    source.listeners['tuner-status']({ data: '{"channel":"auto:27","lock":true}' });
    source.listeners['antenna-mode-status']({ data: '[{"tuner":0}]' });
    expect(onTunerStatus).toHaveBeenCalledWith({ channel: 'auto:27', lock: true });
    expect(onAntennaModeStatus).toHaveBeenCalledWith([{ tuner: 0 }]);
  });

  test('a malformed event is ignored rather than thrown', () => {
    const onTunerStatus = vi.fn();
    subscribe('/u', { onTunerStatus, onAntennaModeStatus: vi.fn() });
    expect(() => FakeEventSource.instances[0].listeners['tuner-status']({ data: 'not json' })).not.toThrow();
    expect(onTunerStatus).not.toHaveBeenCalled();
  });
});
