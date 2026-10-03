import { useEffect, useRef } from 'react';

/**
 * Ask the backend to stream what the current mode needs: one tuner's status
 * normally, or every tuner's in antenna mode. Returns a function that stops
 * it, or null when there is nothing to start yet (no socket, no device, or
 * antenna mode before the device's tuner count is known).
 */
export function startMonitoring(socket, { selectedDevice, selectedTuner, antennaMode, deviceInfo }) {
  if (!socket || !selectedDevice) return null;

  if (antennaMode) {
    if (!deviceInfo) return null;
    socket.emit('start-antenna-mode', {
      deviceId: selectedDevice,
      tunerCount: deviceInfo.tuners
    });
  } else {
    socket.emit('start-monitoring', {
      deviceId: selectedDevice,
      tuner: selectedTuner
    });
  }
  return () => socket.emit('stop-monitoring');
}

/**
 * Keep the backend streaming for the selected device, tuner and mode. This is
 * the only place that starts or stops monitoring: each change stops the old
 * stream and starts the new one exactly once.
 *
 * onLeaveAntennaMode runs when normal mode starts so the caller can drop the
 * antenna readings.
 */
export function useMonitoring({ socket, selectedDevice, selectedTuner, antennaMode, deviceInfo, onLeaveAntennaMode }) {
  const onLeaveRef = useRef(onLeaveAntennaMode);
  useEffect(() => {
    onLeaveRef.current = onLeaveAntennaMode;
  });

  // Antenna mode only needs the tuner count, so depend on that rather than on
  // the whole deviceInfo object.
  const tunerCount = deviceInfo?.tuners;
  // The selected tuner is irrelevant in antenna mode, so it must not restart it.
  const tuner = antennaMode ? null : selectedTuner;

  useEffect(() => {
    const stop = startMonitoring(socket, {
      selectedDevice,
      selectedTuner: tuner,
      antennaMode,
      deviceInfo: tunerCount === undefined ? null : { tuners: tunerCount }
    });
    if (!stop) return undefined;
    if (!antennaMode) onLeaveRef.current();
    return stop;
  }, [socket, selectedDevice, tuner, antennaMode, tunerCount]);
}
