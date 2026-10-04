import { useEffect, useState } from 'react';
import axios from 'axios';

/**
 * Each tuner's channel map as the device itself has it set (read-only), by tuner
 * index. The device's map is what decides what a channel number means when
 * tuning, so it is the one to read a reported channel with. An entry is null when
 * the device did not say, and the list is empty until it is loaded, so callers
 * fall back to the selected map.
 *
 * It reloads on a device change and when the tuned channel changes, since
 * another app sharing the tuner may have changed the map along with the channel.
 */
export function useDeviceChannelMaps(device, tuners, reportedChannel) {
  const [state, setState] = useState({ device: '', maps: [] });

  useEffect(() => {
    if (!device || !tuners) return undefined;
    let current = true;
    axios.get(`/api/v1/devices/${encodeURIComponent(device)}/channelmaps?tuners=${tuners}`)
      .then((response) => {
        if (current) setState({ device, maps: response.data });
      })
      .catch((error) => {
        console.error('Failed to get channel maps:', error);
        // Keep what this device last reported; there is nothing for a new one
        if (current) setState((prev) => (prev.device === device ? prev : { device, maps: [] }));
      });
    return () => { current = false; };
  }, [device, tuners, reportedChannel]);

  // Another device's maps never apply, even for the render before the reload
  return state.device === device ? state.maps : [];
}
