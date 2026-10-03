import {
  CHANNEL_MAPS,
  DEFAULT_CHANNEL_MAP,
  REGIONS,
  channelFromStatus,
  channelToFrequency,
  frequencyToChannel,
  getChannelRange,
  stepChannel,
  streamFrequency
} from './channels';

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('region tables', () => {
  test('every region has a channel map list and a default that is in it', () => {
    for (const { value } of REGIONS) {
      const maps = CHANNEL_MAPS[value].map((m) => m.value);
      expect(maps).toContain(DEFAULT_CHANNEL_MAP[value]);
    }
  });
});

describe('channelToFrequency', () => {
  test('US channels', () => {
    expect(channelToFrequency(2, 'us')).toBe(57e6);
    expect(channelToFrequency(7, 'us')).toBe(177e6);
    expect(channelToFrequency('27', 'us')).toBe(551e6);
    expect(channelToFrequency(36, 'us')).toBe(605e6);
  });

  test('EU and AU channels', () => {
    expect(channelToFrequency(5, 'eu')).toBe(177.5e6);
    expect(channelToFrequency(21, 'eu')).toBe(474e6);
    expect(channelToFrequency(6, 'au')).toBe(177.5e6);
    expect(channelToFrequency(10, 'au')).toBe(212.5e6);
    expect(channelToFrequency(28, 'au')).toBe(529.5e6);
    expect(channelToFrequency('9a', 'au')).toBe(205.5e6);
  });

  test('channels outside the region, and non-numbers, have no frequency', () => {
    expect(channelToFrequency(1, 'us')).toBeNull();
    expect(channelToFrequency(37, 'us')).toBeNull();
    expect(channelToFrequency(13, 'eu')).toBeNull();
    expect(channelToFrequency(20, 'au')).toBeNull();
    expect(channelToFrequency('abc', 'us')).toBeNull();
  });
});

describe('frequencyToChannel', () => {
  test('round-trips every channel of every region', () => {
    const channels = {
      us: [...range(2, 13), ...range(14, 36)],
      eu: [...range(5, 12), ...range(21, 60)],
      au: [...range(6, 12), ...range(28, 51), '9A']
    };
    for (const [region, list] of Object.entries(channels)) {
      for (const channel of list) {
        const freq = channelToFrequency(channel, region);
        expect({ region, channel, back: frequencyToChannel(freq, region) }).toEqual({ region, channel, back: channel });
      }
    }
  });

  test('frequencies outside the region are unknown', () => {
    expect(frequencyToChannel(100e6, 'us')).toBeNull();
    expect(frequencyToChannel(100e6, 'eu')).toBeNull();
    expect(frequencyToChannel(100e6, 'au')).toBeNull();
  });
});

describe('getChannelRange', () => {
  test('broadcast ranges follow the region', () => {
    expect(getChannelRange('us')).toEqual({ min: 2, max: 36 });
    expect(getChannelRange('ca', 'ca-bcast')).toEqual({ min: 2, max: 36 });
    expect(getChannelRange('eu', 'eu-bcast')).toEqual({ min: 5, max: 60 });
    expect(getChannelRange('au', 'au-bcast')).toEqual({ min: 6, max: 51 });
  });

  test('cable maps are wider than broadcast', () => {
    expect(getChannelRange('us', 'us-cable')).toEqual({ min: 2, max: 158 });
    expect(getChannelRange('us', 'us-hrc')).toEqual({ min: 2, max: 158 });
    expect(getChannelRange('ca', 'ca-irc')).toEqual({ min: 2, max: 158 });
    expect(getChannelRange('eu', 'eu-cable')).toEqual({ min: 108, max: 862 });
    expect(getChannelRange('au', 'au-cable')).toEqual({ min: 108, max: 862 });
  });
});

describe('channelFromStatus', () => {
  test('a frequency is converted to its channel', () => {
    expect(channelFromStatus('auto6t:605028615', 'us')).toBe('36');
    expect(channelFromStatus('auto6t:474000000', 'eu')).toBe('21');
  });

  test('a frequency outside the region leaves the field alone', () => {
    expect(channelFromStatus('auto6t:100000000', 'us')).toBeNull();
  });

  test('plain channel formats give the number', () => {
    expect(channelFromStatus('auto:4', 'us')).toBe('4');
    expect(channelFromStatus('13', 'us')).toBe('13');
    expect(channelFromStatus('auto:27', 'us')).toBe('27');
  });

  test('anything without a number leaves the field alone', () => {
    expect(channelFromStatus('auto', 'us')).toBeNull();
  });
});

describe('streamFrequency', () => {
  test('an RF channel is converted to a frequency', () => {
    expect(streamFrequency('auto:27', 'us')).toBe(551e6);
  });

  test('a 9+ digit value is already a frequency and is used as-is', () => {
    expect(streamFrequency('auto6t:605028615', 'us')).toBe('605028615');
  });

  test('no usable channel gives null', () => {
    expect(streamFrequency(undefined, 'us')).toBeNull();
    expect(streamFrequency('none', 'us')).toBeNull();
    expect(streamFrequency('auto:99', 'us')).toBeNull();
  });
});

describe('stepChannel', () => {
  const us = { min: 2, max: 36 };

  test('steps up and down from the CH field', () => {
    expect(stepChannel('27', 1, us)).toBe(28);
    expect(stepChannel('27', -1, us)).toBe(26);
  });

  test('stops at the ends of the range', () => {
    expect(stepChannel('36', 1, us)).toBe(36);
    expect(stepChannel('2', -1, us)).toBe(2);
  });

  test('an empty or invalid field steps from the bottom of the range', () => {
    expect(stepChannel('', 1, us)).toBe(3);
    expect(stepChannel('', -1, us)).toBe(2);
    expect(stepChannel('abc', 1, us)).toBe(3);
  });
});
