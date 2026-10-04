export const REGIONS = [
  { value: 'us', label: 'United States' },
  { value: 'ca', label: 'Canada' },
  { value: 'eu', label: 'United Kingdom / EU' },
  { value: 'au', label: 'Australia' }
];

export const CHANNEL_MAPS = {
  us: [
    { value: 'us-bcast', label: 'US Broadcast' },
    { value: 'us-cable', label: 'US Cable' },
    { value: 'us-hrc', label: 'US HRC' },
    { value: 'us-irc', label: 'US IRC' }
  ],
  ca: [
    { value: 'ca-bcast', label: 'CA Broadcast' },
    { value: 'ca-cable', label: 'CA Cable' },
    { value: 'ca-hrc', label: 'CA HRC' },
    { value: 'ca-irc', label: 'CA IRC' }
  ],
  eu: [
    { value: 'eu-bcast', label: 'UK/EU Broadcast' },
    { value: 'eu-cable', label: 'UK/EU Cable' }
  ],
  au: [
    { value: 'au-bcast', label: 'AU Broadcast' },
    { value: 'au-cable', label: 'AU Cable' }
  ]
};

export const DEFAULT_CHANNEL_MAP = {
  us: 'us-bcast',
  ca: 'ca-bcast',
  eu: 'eu-bcast',
  au: 'au-bcast'
};

// Channel plans for the cable, HRC and IRC maps, from libhdhomerun's
// hdhomerun_channels.c. Each range is [first channel, last channel, frequency
// of the first channel in Hz, spacing in Hz]. HRC and IRC channels sit at offset
// frequencies, and the tables already hold them, so a reported frequency has to
// be within PLAN_TOLERANCE_HZ of a channel's; anything further is another plan's.
// Canadian maps use the US tables; EU and AU cable share one table.
const PLAN_TOLERANCE_HZ = 500000;

const CABLE_PLANS = {
  'us-cable': [
    [2, 4, 57000000, 6000000], [5, 6, 79000000, 6000000], [7, 13, 177000000, 6000000],
    [14, 22, 123000000, 6000000], [23, 94, 219000000, 6000000], [95, 99, 93000000, 6000000],
    [100, 158, 651000000, 6000000]
  ],
  'us-hrc': [
    [2, 4, 55752700, 6000300], [5, 6, 79753900, 6000300], [7, 13, 175758700, 6000300],
    [14, 22, 121756000, 6000300], [23, 94, 217760800, 6000300], [95, 99, 91754500, 6000300],
    [100, 158, 649782400, 6000300]
  ],
  'us-irc': [
    [2, 4, 57012500, 6000000], [5, 6, 81012500, 6000000], [7, 13, 177012500, 6000000],
    [14, 22, 123012500, 6000000], [23, 41, 219012500, 6000000], [42, 42, 333025000, 6000000],
    [43, 94, 339012500, 6000000], [95, 97, 93012500, 6000000], [98, 99, 111025000, 6000000],
    [100, 158, 651012500, 6000000]
  ],
  'eu-cable': [[108, 862, 108000000, 1000000]]
};

// The plan for a cable, HRC or IRC map, or null for a broadcast map
function cablePlan(channelMap) {
  const key = (channelMap || '').replace(/^(ca|au)-/, (_, prefix) => (prefix === 'ca' ? 'us-' : 'eu-'));
  return CABLE_PLANS[key] || null;
}

// The channel at a frequency in a cable plan, or null if none is within the tolerance
function planFrequencyToChannel(plan, freqHz) {
  let best = null;
  let bestDiff = Infinity;
  for (const [first, last, base, spacing] of plan) {
    const index = Math.round((freqHz - base) / spacing);
    if (index < 0 || first + index > last) continue;
    const diff = Math.abs(freqHz - (base + index * spacing));
    if (diff <= Math.min(spacing / 2, PLAN_TOLERANCE_HZ) && diff < bestDiff) {
      best = first + index;
      bestDiff = diff;
    }
  }
  return best;
}

// The frequency of a channel in a cable plan, or null if the plan has no such channel
function planChannelToFrequency(plan, channel) {
  for (const [first, last, base, spacing] of plan) {
    if (channel >= first && channel <= last) return base + (channel - first) * spacing;
  }
  return null;
}

// Convert frequency (in Hz) to a channel number: with a cable, HRC or IRC map
// by that map's plan, otherwise by the region's broadcast plan
export function frequencyToChannel(freqHz, region = 'us', channelMap = '') {
  const plan = cablePlan(channelMap);
  if (plan) return planFrequencyToChannel(plan, freqHz);

  const freqMhz = freqHz / 1000000;

  if (region === 'eu') {
    // UK/EU DVB-T/T2 frequencies
    // Band III (VHF): 174-230 MHz → channels 5-12
    if (freqMhz >= 174 && freqMhz <= 230) {
      // Channel 5: 177.5 MHz center, then +7 MHz for each channel
      const channel = Math.round((freqMhz - 177.5) / 7) + 5;
      return Math.max(5, Math.min(12, channel));
    }

    // Band IV/V (UHF): 470-790 MHz → channels 21-60
    // Note: Post-700MHz clearance, many regions only use 21-48
    if (freqMhz >= 470 && freqMhz <= 790) {
      // Channel 21: 474 MHz center, then +8 MHz for each channel
      const channel = Math.round((freqMhz - 474) / 8) + 21;
      return Math.max(21, Math.min(60, channel));
    }

    return null; // Unknown frequency range
  }

  if (region === 'au') {
    // Australian DVB-T frequencies (7 MHz raster)
    // Band III (VHF): channels 6-12 with 9A (205.5 MHz) between 9 and 10
    if (freqMhz >= 174 && freqMhz <= 230) {
      const slot = Math.round((freqMhz - 177.5) / 7); // 0 = ch6 ... 4 = 9A ... 7 = ch12
      if (slot === 4) return '9A';
      const channel = slot < 4 ? slot + 6 : slot + 5;
      return Math.max(6, Math.min(12, channel));
    }

    // Band IV/V (UHF): channels 28-51 (post digital dividend, 526-694 MHz)
    if (freqMhz >= 526 && freqMhz <= 694) {
      // Channel 28: 529.5 MHz center, then +7 MHz for each channel
      const channel = Math.round((freqMhz - 529.5) / 7) + 28;
      return Math.max(28, Math.min(51, channel));
    }

    return null; // Unknown frequency range
  }

  // US ATSC frequencies
  // VHF Low (channels 2-6): 54-88 MHz
  if (freqMhz >= 54 && freqMhz <= 88) {
    // Channel 2: 57 MHz center, Channel 3: 63, Channel 4: 69, Channel 5: 79, Channel 6: 85
    const vhfLowChannels = [
      { ch: 2, freq: 57 }, { ch: 3, freq: 63 }, { ch: 4, freq: 69 },
      { ch: 5, freq: 79 }, { ch: 6, freq: 85 }
    ];
    let closest = vhfLowChannels[0];
    let minDiff = Math.abs(freqMhz - closest.freq);
    for (const ch of vhfLowChannels) {
      const diff = Math.abs(freqMhz - ch.freq);
      if (diff < minDiff) {
        minDiff = diff;
        closest = ch;
      }
    }
    return closest.ch;
  }

  // VHF High (channels 7-13): 174-216 MHz
  if (freqMhz >= 174 && freqMhz <= 216) {
    // Channel 7: 177 MHz center, then +6 MHz for each channel
    const channel = Math.round((freqMhz - 177) / 6) + 7;
    return Math.max(7, Math.min(13, channel));
  }

  // UHF (channels 14-36): 470-608 MHz (post-repack)
  if (freqMhz >= 470 && freqMhz <= 608) {
    // Channel 14: 473 MHz center, then +6 MHz for each channel
    const channel = Math.round((freqMhz - 473) / 6) + 14;
    return Math.max(14, Math.min(36, channel));
  }

  return null; // Unknown frequency range
}

// Convert a channel number to its frequency (in Hz), by the cable, HRC or IRC
// map's plan or the region's broadcast plan
export function channelToFrequency(channel, region = 'us', channelMap = '') {
  const plan = cablePlan(channelMap);
  if (plan) {
    const number = parseInt(channel, 10);
    return isNaN(number) ? null : planChannelToFrequency(plan, number);
  }

  if (region === 'au' && String(channel).toUpperCase() === '9A') {
    return 205.5 * 1000000;
  }

  const ch = parseInt(channel, 10);
  if (isNaN(ch)) return null;

  if (region === 'eu') {
    // Band III (VHF): channels 5-12
    if (ch >= 5 && ch <= 12) {
      return ((ch - 5) * 7 + 177.5) * 1000000;
    }
    // Band IV/V (UHF): channels 21-60
    if (ch >= 21 && ch <= 60) {
      return ((ch - 21) * 8 + 474) * 1000000;
    }
    return null;
  }

  if (region === 'au') {
    // Band III (VHF): channels 6-9, then 10-12 shifted up past 9A
    if (ch >= 6 && ch <= 9) {
      return ((ch - 6) * 7 + 177.5) * 1000000;
    }
    if (ch >= 10 && ch <= 12) {
      return ((ch - 10) * 7 + 212.5) * 1000000;
    }
    // Band IV/V (UHF): channels 28-51
    if (ch >= 28 && ch <= 51) {
      return ((ch - 28) * 7 + 529.5) * 1000000;
    }
    return null;
  }

  // US ATSC frequencies
  // VHF Low (channels 2-6)
  const vhfLow = { 2: 57, 3: 63, 4: 69, 5: 79, 6: 85 };
  if (vhfLow[ch]) return vhfLow[ch] * 1000000;

  // VHF High (channels 7-13): 177 MHz + 6 MHz per channel
  if (ch >= 7 && ch <= 13) {
    return ((ch - 7) * 6 + 177) * 1000000;
  }

  // UHF (channels 14-36): 473 MHz + 6 MHz per channel
  if (ch >= 14 && ch <= 36) {
    return ((ch - 14) * 6 + 473) * 1000000;
  }

  return null;
}

// The channel map channel numbers are read and typed in: one the user picked
// that differs from the device's, else the tuner's own map when the device
// reported one (it is what the device uses to interpret numbers), else the
// page's default for the region.
export function effectiveChannelMap(deviceMaps, tuner, pickedMap, defaultMap) {
  return pickedMap ?? deviceMaps?.[tuner] ?? defaultMap;
}

// Valid channel numbers for the CH field and the up/down buttons. Cable maps
// use wider numbering than broadcast (values from libhdhomerun's channel tables):
// US/CA cable, HRC and IRC run 2-158, and EU/AU cable uses the frequency in MHz
// as the channel number (108-862).
export function getChannelRange(region, channelMap = '') {
  if (channelMap === 'eu-cable' || channelMap === 'au-cable') return { min: 108, max: 862 };
  if (/-(cable|hrc|irc)$/.test(channelMap)) return { min: 2, max: 158 };
  if (region === 'eu') return { min: 5, max: 60 }; // EU: VHF 5-12, UHF 21-60
  if (region === 'au') return { min: 6, max: 51 }; // AU: VHF 6-12, UHF 28-51
  return { min: 2, max: 36 };                      // US: VHF 2-13, UHF 14-36
}

// The value the CH field should show for a tuner's reported channel, or null
// when the region and map cannot place it (the caller clears the field). 'none'
// (tuner stopped) is handled by the caller.
// Formats: "auto6t:605028615" (frequency in Hz), "auto:4" and "13".
export function channelFromStatus(statusChannel, region, channelMap = '') {
  const freqMatch = statusChannel.match(/:(\d{8,})/);
  if (freqMatch) {
    const channel = frequencyToChannel(parseInt(freqMatch[1]), region, channelMap);
    return channel ? channel.toString() : null;
  }
  const channelMatch = statusChannel.match(/(?:auto:)?(\d+)/);
  return channelMatch ? channelMatch[1] : null;
}

// How a tuner's reported channel reads on screen, e.g. "Channel 27". A
// frequency-form channel is converted using the region and channel map; one they
// cannot place is shown as reported.
export function formatChannelDisplay(statusChannel, region, channelMap = '') {
  if (!statusChannel || statusChannel === 'none') return 'Not tuned';
  const channel = channelFromStatus(statusChannel, region, channelMap);
  return channel ? `Channel ${channel}` : statusChannel;
}

// Frequency (Hz) for a stream URL from a status channel such as "auto:27".
// A 9+ digit value is already a frequency; anything else is an RF channel.
export function streamFrequency(statusChannel, region, channelMap = '') {
  const rawChannel = statusChannel?.split(':')[1];
  if (!rawChannel) return null;
  return (rawChannel.length >= 9 ? rawChannel : channelToFrequency(rawChannel, region, channelMap)) || null;
}

// What to send the device to tune `channel`. The device reads a plain number
// with its own channel map, so when the map in use is that one (or the device's
// is not known) the number goes as typed. Otherwise the frequency comes from the
// map in use and is sent as such, which leaves the device's own setting alone.
// Null when that map has no such channel. Anything that is not a plain channel
// number (such as 'auto:27') is passed through.
export function tuneTarget(channel, region, channelMap, deviceMap) {
  if (!deviceMap || channelMap === deviceMap) return channel;
  if (!/^(\d+|9A)$/i.test(channel)) return channel;
  const frequency = channelToFrequency(channel, region, channelMap);
  return frequency === null ? null : `auto:${Math.round(frequency)}`;
}

// The channel one step up (+1) or down (-1) from the CH field, clamped to the
// range. An empty or invalid field steps from the bottom of the range.
export function stepChannel(directChannel, delta, { min, max }) {
  const current = parseInt(directChannel) || min;
  return delta > 0 ? Math.min(max, current + 1) : Math.max(min, current - 1);
}
