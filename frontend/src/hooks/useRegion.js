import { useEffect, useState } from 'react';
import { DEFAULT_CHANNEL_MAP } from '../utils/channels';

/**
 * The selected region (remembered between visits) and its channel map.
 * Changing the region resets the channel map to that region's default.
 */
export function useRegion() {
  // Load region from localStorage, default to 'us'
  const [region, setRegion] = useState(() => {
    return localStorage.getItem('hdhr-region') || 'us';
  });
  const [channelMap, setChannelMap] = useState(() => {
    // Set default channel map based on region
    return DEFAULT_CHANNEL_MAP[region] || 'us-bcast';
  });

  // Save region preference to localStorage
  useEffect(() => {
    localStorage.setItem('hdhr-region', region);
  }, [region]);

  const changeRegion = (newRegion) => {
    setRegion(newRegion);
    // Reset channel map to default for new region
    setChannelMap(DEFAULT_CHANNEL_MAP[newRegion]);
  };

  return { region, channelMap, setChannelMap, changeRegion };
}
