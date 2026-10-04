// @vitest-environment jsdom
import { renderHook, act, waitFor } from '@testing-library/react';
import axios from 'axios';
import { useChannelControl } from './useChannelControl';
import { useTunerState } from './useTunerState';

vi.mock('axios');

const programs = [{ number: '27.1', name: 'KABC' }];
const locked = { channel: 'auto:27', lock: true, ss: 90, snq: 90, seq: 100 };

// The two hooks wired together the way SignalMeter wires them
function useBoth(props) {
  const state = useTunerState(`${props.selectedDevice}/${props.selectedTuner}`);
  const control = useChannelControl({
    region: 'us',
    channelMap: 'us-bcast',
    tunerStatus: state.tunerStatus,
    clearAtsc3Info: state.clearAtsc3Info,
    ...props
  });
  return { ...state, ...control };
}

beforeEach(() => {
  axios.get.mockResolvedValue({ data: programs });
  axios.post.mockResolvedValue({ data: {} });
});
afterEach(() => vi.resetAllMocks());

async function settledOnTuner(initial) {
  const hook = renderHook((props) => useBoth(props), { initialProps: initial });
  act(() => hook.result.current.handleTunerStatus(locked));
  await waitFor(() => expect(hook.result.current.currentChannelPrograms).toEqual(programs));
  expect(hook.result.current.directChannel).toBe('27');
  return hook;
}

describe('switching tuner or device', () => {
  test('the CH field and programs come back when the new tuner is on the same channel and lock', async () => {
    const { result, rerender } = await settledOnTuner({ selectedDevice: 'A', selectedTuner: 0 });

    rerender({ selectedDevice: 'A', selectedTuner: 1 });
    expect(result.current.directChannel).toBe('');
    expect(result.current.currentChannelPrograms).toEqual([]);

    act(() => result.current.handleTunerStatus({ ...locked })); // tuner 1's first reading
    await waitFor(() => expect(result.current.currentChannelPrograms).toEqual(programs));
    expect(result.current.directChannel).toBe('27');
    expect(axios.get).toHaveBeenLastCalledWith('/api/v1/devices/A/tuner/1/programs');
  });

  test('the same holds when the device changes', async () => {
    const { result, rerender } = await settledOnTuner({ selectedDevice: 'A', selectedTuner: 0 });

    rerender({ selectedDevice: 'B', selectedTuner: 0 });
    act(() => result.current.handleTunerStatus({ ...locked }));

    await waitFor(() => expect(result.current.currentChannelPrograms).toEqual(programs));
    expect(result.current.directChannel).toBe('27');
    expect(axios.get).toHaveBeenLastCalledWith('/api/v1/devices/B/tuner/0/programs');
  });

  test('the old tuner status is gone until the new tuner reports', async () => {
    const { result, rerender } = await settledOnTuner({ selectedDevice: 'A', selectedTuner: 0 });
    rerender({ selectedDevice: 'A', selectedTuner: 1 });
    expect(result.current.tunerStatus).toBeNull();
  });

  test('a new tuner that is not tuned leaves the CH field blank and fetches nothing', async () => {
    const { result, rerender } = await settledOnTuner({ selectedDevice: 'A', selectedTuner: 0 });
    axios.get.mockClear();

    rerender({ selectedDevice: 'A', selectedTuner: 1 });
    act(() => result.current.handleTunerStatus({ channel: 'none', lock: false }));

    expect(result.current.directChannel).toBe('');
    expect(result.current.currentChannelPrograms).toEqual([]);
    expect(axios.get).not.toHaveBeenCalled();
  });
});
