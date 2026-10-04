import { useEffect, useState } from 'react';
import { clampTuner } from './useDevices';

/**
 * The tuner being viewed. The value returned is already valid for the device
 * whose info is passed in, in the same render that info arrives, so nothing
 * subscribes to a tuner the device does not have. The stored choice follows,
 * so it does not drift back to the old number.
 */
export function useSelectedTuner(deviceInfo) {
  const [selectedTuner, setSelectedTuner] = useState(0);
  const tuner = clampTuner(selectedTuner, deviceInfo);

  useEffect(() => {
    if (tuner !== selectedTuner) setSelectedTuner(tuner);
  }, [tuner, selectedTuner]);

  return [tuner, setSelectedTuner];
}
