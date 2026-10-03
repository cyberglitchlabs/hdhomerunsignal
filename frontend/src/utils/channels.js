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

// Convert frequency (in Hz) to broadcast channel number
export function frequencyToChannel(freqHz, region = 'us') {
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

// Convert broadcast channel number to center frequency (in Hz)
export function channelToFrequency(channel, region = 'us') {
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
// when it should be left alone. 'none' (tuner stopped) is handled by the caller.
// Formats: "auto6t:605028615" (frequency in Hz), "auto:4" and "13".
export function channelFromStatus(statusChannel, region) {
  const freqMatch = statusChannel.match(/:(\d{8,})/);
  if (freqMatch) {
    const channel = frequencyToChannel(parseInt(freqMatch[1]), region);
    return channel ? channel.toString() : null;
  }
  const channelMatch = statusChannel.match(/(?:auto:)?(\d+)/);
  return channelMatch ? channelMatch[1] : null;
}

// Frequency (Hz) for a stream URL from a status channel such as "auto:27".
// A 9+ digit value is already a frequency; anything else is an RF channel.
export function streamFrequency(statusChannel, region) {
  const rawChannel = statusChannel?.split(':')[1];
  if (!rawChannel) return null;
  return (rawChannel.length >= 9 ? rawChannel : channelToFrequency(rawChannel, region)) || null;
}

// The channel one step up (+1) or down (-1) from the CH field, clamped to the
// range. An empty or invalid field steps from the bottom of the range.
export function stepChannel(directChannel, delta, { min, max }) {
  const current = parseInt(directChannel) || min;
  return delta > 0 ? Math.min(max, current + 1) : Math.max(min, current - 1);
}
