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

describe('the CH field follows the region and channel map', () => {
  const base = { selectedDevice: 'A', selectedTuner: 0, region: 'us', channelMap: 'us-bcast' };
  const onVhfLow = { channel: 'auto6t:57000000', lock: true }; // US channel 2; EU has no plan below 174 MHz

  async function tunedTo(status, props = base) {
    const hook = renderHook((p) => useBoth(p), { initialProps: props });
    act(() => hook.result.current.handleTunerStatus(status));
    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    return hook;
  }

  test('a frequency-form channel shows the number its region gives it', async () => {
    const { result } = await tunedTo(onVhfLow);
    expect(result.current.directChannel).toBe('2');
  });

  test('a region that cannot place the frequency clears the field instead of keeping the old number', async () => {
    const { result, rerender } = await tunedTo(onVhfLow);
    rerender({ ...base, region: 'eu', channelMap: 'eu-bcast' });
    expect(result.current.directChannel).toBe('');
  });

  test('stepping after that starts from the bottom of the range, not the old number', async () => {
    const { result, rerender } = await tunedTo(onVhfLow);
    rerender({ ...base, region: 'eu', channelMap: 'eu-bcast' });
    await act(() => result.current.incrementChannel());
    expect(axios.post).toHaveBeenLastCalledWith(
      '/api/v1/devices/A/tuner/0/channel',
      { channel: '6' } // EU range starts at 5
    );
  });

  test('a normal status update with an unplaceable frequency also clears the field', async () => {
    const { result } = await tunedTo({ channel: 'auto6t:100000000', lock: true });
    expect(result.current.directChannel).toBe('');
  });

  test('a cable frequency shows its cable channel under a cable map', async () => {
    const { result } = await tunedTo(
      { channel: 'auto6c:651000000', lock: true },
      { ...base, channelMap: 'us-cable' }
    );
    expect(result.current.directChannel).toBe('100');
  });

  test('switching to a cable map recomputes the field for the same frequency', async () => {
    const { result, rerender } = await tunedTo({ channel: 'auto6c:243000000', lock: true });
    expect(result.current.directChannel).toBe(''); // broadcast has no channel at 243 MHz
    rerender({ ...base, channelMap: 'us-cable' });
    expect(result.current.directChannel).toBe('27');
  });

  test('a region change does not overwrite what the user typed for a plain channel', async () => {
    const { result, rerender } = await tunedTo({ channel: 'auto:27', lock: true });
    act(() => result.current.setDirectChannel('31'));
    rerender({ ...base, region: 'ca', channelMap: 'ca-bcast' });
    expect(result.current.directChannel).toBe('31');
  });
});

describe('tuning with a channel map that is not the device\'s', () => {
  const base = { selectedDevice: 'A', selectedTuner: 0, region: 'us' };
  const post = () => axios.post.mock.calls.at(-1);

  async function tuneTo(channel, props) {
    const { result } = renderHook((p) => useBoth(p), { initialProps: { ...base, ...props } });
    await act(() => result.current.tuneToDirectChannel(channel));
    return result;
  }

  test("tunes by the typed number while the device's own map is in use", async () => {
    await tuneTo('27', { channelMap: 'us-bcast', deviceChannelMap: 'us-bcast' });
    expect(post()).toEqual(['/api/v1/devices/A/tuner/0/channel', { channel: '27' }]);
  });

  test("tunes by frequency when the chosen map differs from the device's, never changing the device's map", async () => {
    await tuneTo('27', { channelMap: 'us-cable', deviceChannelMap: 'us-bcast' });
    expect(post()).toEqual(['/api/v1/devices/A/tuner/0/channel', { channel: 'auto:243000000' }]);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post.mock.calls.every(([url]) => url.endsWith('/channel'))).toBe(true);
  });

  test('stepping uses the same rule', async () => {
    const { result } = renderHook((p) => useBoth(p), {
      initialProps: { ...base, channelMap: 'us-cable', deviceChannelMap: 'us-bcast' }
    });
    act(() => result.current.setDirectChannel('27'));
    await act(() => result.current.incrementChannel());
    expect(post()).toEqual(['/api/v1/devices/A/tuner/0/channel', { channel: 'auto:249000000' }]); // channel 28
  });

  test('a channel the chosen map does not have is not sent', async () => {
    await tuneTo('159', { channelMap: 'us-cable', deviceChannelMap: 'us-bcast' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('without a known device map it tunes by the typed number, as before', async () => {
    await tuneTo('27', { channelMap: 'us-cable' });
    expect(post()).toEqual(['/api/v1/devices/A/tuner/0/channel', { channel: '27' }]);
  });
});
