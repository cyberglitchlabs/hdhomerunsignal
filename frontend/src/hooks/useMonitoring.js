import { useEffect } from 'react';

/**
 * Tell the backend what to stream over the socket: one tuner's status
 * normally, or every tuner's in antenna mode.
 *
 * onLeaveAntennaMode runs when normal mode (re)starts so the caller can drop
 * the antenna readings.
 */
export function useMonitoring({ socket, selectedDevice, selectedTuner, antennaMode, deviceInfo, onLeaveAntennaMode }) {
  useEffect(() => {
    if (selectedDevice && socket) {
      console.log('useEffect: Starting monitoring for device:', selectedDevice, 'tuner:', selectedTuner);
      socket.emit('start-monitoring', {
        deviceId: selectedDevice,
        tuner: selectedTuner
      });
    }
    return () => {
      if (socket) {
        console.log('useEffect cleanup: Stopping monitoring');
        socket.emit('stop-monitoring');
      }
    };
  }, [selectedDevice, selectedTuner, socket]);

  // Handle antenna mode switching
  useEffect(() => {
    if (!socket || !selectedDevice || !deviceInfo) return;

    if (antennaMode) {
      console.log('Switching to antenna mode');
      socket.emit('stop-monitoring');
      socket.emit('start-antenna-mode', {
        deviceId: selectedDevice,
        tunerCount: deviceInfo.tuners
      });
    } else {
      console.log('Switching to normal mode');
      socket.emit('stop-monitoring');
      socket.emit('start-monitoring', {
        deviceId: selectedDevice,
        tuner: selectedTuner
      });
      onLeaveAntennaMode(); // Clear antenna mode data
    }
  }, [antennaMode, selectedDevice, socket, deviceInfo, selectedTuner]);
}
