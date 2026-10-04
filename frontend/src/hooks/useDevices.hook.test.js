// @vitest-environment jsdom
import { renderHook, act, waitFor } from '@testing-library/react';
import axios from 'axios';
import { useDevices } from './useDevices';

vi.mock('axios');

const a = { id: 'AAAA', online: true };

function respondWith({ devices, info = { tuners: 2 } }) {
  axios.get.mockImplementation(async (url) => {
    if (url.includes('/info')) return { data: info };
    return { data: devices() };
  });
}

afterEach(() => vi.resetAllMocks());

describe('useDevices.discoverDevices', () => {
  test('selects the first online device on mount', async () => {
    respondWith({ devices: () => [a] });
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.selectedDevice).toBe('AAAA'));
    expect(result.current.deviceInfo).toEqual({ tuners: 2 });
  });

  test('an empty list on mount leaves the "no devices" state', async () => {
    respondWith({ devices: () => [] });
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.selectedDevice).toBe('');
    expect(result.current.deviceInfo).toBeNull();
  });

  test('a Refresh that finds no devices clears the selection', async () => {
    let devices = [a];
    respondWith({ devices: () => devices });
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.selectedDevice).toBe('AAAA'));

    devices = [];
    await act(() => result.current.discoverDevices(true));

    expect(result.current.selectedDevice).toBe('');
    expect(result.current.deviceInfo).toBeNull();
  });

  test('a Refresh where every device is offline clears the selection', async () => {
    let devices = [a];
    respondWith({ devices: () => devices });
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.selectedDevice).toBe('AAAA'));

    devices = [{ ...a, online: false }];
    await act(() => result.current.discoverDevices(true));

    expect(result.current.selectedDevice).toBe('');
  });
});
