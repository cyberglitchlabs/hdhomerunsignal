import { bindSocketEvents } from './useSocket';

function fakeSocket() {
  const handlers = {};
  return {
    handlers,
    on: (event, fn) => { handlers[event] = fn; },
    emit: vi.fn()
  };
}

function setup(initialState = {}) {
  const socket = fakeSocket();
  const state = {
    selectedDevice: '1234ABCD',
    selectedTuner: 1,
    antennaMode: false,
    deviceInfo: { tuners: 4 },
    ...initialState
  };
  const onTunerStatus = vi.fn();
  const onAntennaModeStatus = vi.fn();
  // Reads the live object, like the hook's ref does
  bindSocketEvents(socket, { onTunerStatus, onAntennaModeStatus, getMonitorState: () => state });
  return { socket, state, onTunerStatus, onAntennaModeStatus };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bindSocketEvents', () => {
  test('forwards status events to the callbacks', () => {
    const { socket, onTunerStatus, onAntennaModeStatus } = setup();
    const status = { channel: 'auto:27', lock: true };
    socket.handlers['tuner-status'](status);
    socket.handlers['antenna-mode-status']([{ tuner: 0 }]);
    expect(onTunerStatus).toHaveBeenCalledWith(status);
    expect(onAntennaModeStatus).toHaveBeenCalledWith([{ tuner: 0 }]);
  });

  test('the first connect does not start monitoring', () => {
    const { socket } = setup();
    socket.handlers.connect();
    vi.advanceTimersByTime(1000);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  test('a reconnect restarts monitoring for the selected tuner after a short delay', () => {
    const { socket } = setup();
    socket.handlers.connect();
    socket.handlers.connect();
    expect(socket.emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('start-monitoring', { deviceId: '1234ABCD', tuner: 1 });
  });

  test('a reconnect in antenna mode restarts antenna mode with the tuner count', () => {
    const { socket } = setup({ antennaMode: true });
    socket.handlers.connect();
    socket.handlers.connect();
    vi.advanceTimersByTime(100);
    expect(socket.emit).toHaveBeenCalledWith('start-antenna-mode', { deviceId: '1234ABCD', tunerCount: 4 });
  });

  test('antenna mode falls back to 2 tuners when the device info is not in yet', () => {
    const { socket } = setup({ antennaMode: true, deviceInfo: null });
    socket.handlers.connect();
    socket.handlers.connect();
    vi.advanceTimersByTime(100);
    expect(socket.emit).toHaveBeenCalledWith('start-antenna-mode', { deviceId: '1234ABCD', tunerCount: 2 });
  });

  test('a reconnect with no device selected emits nothing', () => {
    const { socket } = setup({ selectedDevice: '' });
    socket.handlers.connect();
    socket.handlers.connect();
    vi.advanceTimersByTime(1000);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  test('uses the state at the moment the restart fires, not at reconnect', () => {
    const { socket, state } = setup();
    socket.handlers.connect();
    socket.handlers.connect();
    state.selectedTuner = 3; // user switches tuner during the delay
    vi.advanceTimersByTime(100);
    expect(socket.emit).toHaveBeenCalledWith('start-monitoring', { deviceId: '1234ABCD', tuner: 3 });
  });

  test('every reconnect after the first restarts monitoring', () => {
    const { socket } = setup();
    socket.handlers.connect();
    socket.handlers.connect();
    socket.handlers.connect();
    vi.advanceTimersByTime(100);
    expect(socket.emit).toHaveBeenCalledTimes(2);
  });
});
