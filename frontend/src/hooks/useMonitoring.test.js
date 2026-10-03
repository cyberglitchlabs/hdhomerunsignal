import { startMonitoring } from './useMonitoring';

const base = { selectedDevice: '1234ABCD', selectedTuner: 1, antennaMode: false, deviceInfo: { tuners: 4 } };

describe('startMonitoring', () => {
  test('normal mode emits a single start-monitoring and stops with stop-monitoring', () => {
    const socket = { emit: vi.fn() };
    const stop = startMonitoring(socket, base);
    expect(socket.emit.mock.calls).toEqual([['start-monitoring', { deviceId: '1234ABCD', tuner: 1 }]]);

    stop();
    expect(socket.emit).toHaveBeenLastCalledWith('stop-monitoring');
    expect(socket.emit).toHaveBeenCalledTimes(2);
  });

  test('normal mode starts without waiting for the device info', () => {
    const socket = { emit: vi.fn() };
    expect(startMonitoring(socket, { ...base, deviceInfo: null })).toEqual(expect.any(Function));
    expect(socket.emit).toHaveBeenCalledWith('start-monitoring', { deviceId: '1234ABCD', tuner: 1 });
  });

  test('antenna mode emits only start-antenna-mode, never normal monitoring', () => {
    const socket = { emit: vi.fn() };
    startMonitoring(socket, { ...base, antennaMode: true });
    expect(socket.emit.mock.calls).toEqual([['start-antenna-mode', { deviceId: '1234ABCD', tunerCount: 4 }]]);
  });

  test('antenna mode waits for the device info', () => {
    const socket = { emit: vi.fn() };
    expect(startMonitoring(socket, { ...base, antennaMode: true, deviceInfo: null })).toBeNull();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  test('does nothing without a socket or a device', () => {
    const socket = { emit: vi.fn() };
    expect(startMonitoring(null, base)).toBeNull();
    expect(startMonitoring(socket, { ...base, selectedDevice: '' })).toBeNull();
    expect(socket.emit).not.toHaveBeenCalled();
  });
});
