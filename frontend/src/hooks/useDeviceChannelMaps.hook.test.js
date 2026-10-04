// @vitest-environment jsdom
import { renderHook, act, waitFor } from '@testing-library/react';
import axios from 'axios';
import { useDeviceChannelMaps } from './useDeviceChannelMaps';

vi.mock('axios');

afterEach(() => vi.resetAllMocks());

const urlFor = (device, tuners) => `/api/v1/devices/${device}/channelmaps?tuners=${tuners}`;

describe('useDeviceChannelMaps', () => {
  test("loads each tuner's map for the device", async () => {
    axios.get.mockResolvedValue({ data: ['us-bcast', 'us-cable'] });
    const { result } = renderHook(() => useDeviceChannelMaps('A', 2, 'auto:27'));
    await waitFor(() => expect(result.current).toEqual(['us-bcast', 'us-cable']));
    expect(axios.get).toHaveBeenCalledWith(urlFor('A', 2));
  });

  test('asks for nothing until the device and its tuner count are known', () => {
    renderHook(() => useDeviceChannelMaps('', 2, undefined));
    renderHook(() => useDeviceChannelMaps('A', undefined, undefined));
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('reloads when the tuned channel changes, since a map change may have come with it', async () => {
    axios.get.mockResolvedValueOnce({ data: ['us-bcast'] }).mockResolvedValueOnce({ data: ['us-cable'] });
    const { result, rerender } = renderHook(({ channel }) => useDeviceChannelMaps('A', 1, channel), {
      initialProps: { channel: 'auto:27' }
    });
    await waitFor(() => expect(result.current).toEqual(['us-bcast']));

    rerender({ channel: 'auto:30' });
    await waitFor(() => expect(result.current).toEqual(['us-cable']));
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  test('does not reload while the channel stays the same', async () => {
    axios.get.mockResolvedValue({ data: ['us-bcast'] });
    const { result, rerender } = renderHook(({ channel }) => useDeviceChannelMaps('A', 1, channel), {
      initialProps: { channel: 'auto:27' }
    });
    await waitFor(() => expect(result.current).toEqual(['us-bcast']));
    rerender({ channel: 'auto:27' });
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test("another device's maps are dropped at once and the new device's are loaded", async () => {
    axios.get.mockImplementation(async (url) => ({ data: url === urlFor('A', 1) ? ['us-cable'] : ['eu-cable'] }));
    const { result, rerender } = renderHook(({ device }) => useDeviceChannelMaps(device, 1, 'auto:27'), {
      initialProps: { device: 'A' }
    });
    await waitFor(() => expect(result.current).toEqual(['us-cable']));

    rerender({ device: 'B' });
    expect(result.current).toEqual([]);
    await waitFor(() => expect(result.current).toEqual(['eu-cable']));
  });

  test('a slow answer for a device the user left is ignored', async () => {
    let resolveA;
    axios.get.mockImplementation((url) => (url === urlFor('A', 1)
      ? new Promise((resolve) => { resolveA = resolve; })
      : Promise.resolve({ data: ['eu-cable'] })));
    const { result, rerender } = renderHook(({ device }) => useDeviceChannelMaps(device, 1, 'auto:27'), {
      initialProps: { device: 'A' }
    });
    rerender({ device: 'B' });
    await waitFor(() => expect(result.current).toEqual(['eu-cable']));

    await act(async () => resolveA({ data: ['us-cable'] }));
    expect(result.current).toEqual(['eu-cable']);
  });

  test('a failed request leaves no maps, so callers use the selected one', async () => {
    axios.get.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useDeviceChannelMaps('A', 2, 'auto:27'));
    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });
});
