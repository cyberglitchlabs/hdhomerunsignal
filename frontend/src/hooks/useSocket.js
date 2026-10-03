import { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';

// Delay before re-emitting after a reconnect, so the socket is fully ready.
const RESTART_DELAY_MS = 100;

/**
 * Subscribe to the backend's status events and, after a reconnect, ask it to
 * resume whatever was being monitored.
 *
 * getMonitorState() returns the current { selectedDevice, selectedTuner,
 * antennaMode, deviceInfo }; it is read when the socket reconnects and again
 * when the restart fires, so it must reflect the latest values.
 */
export function bindSocketEvents(socket, { onTunerStatus, onAntennaModeStatus, getMonitorState }) {
  socket.on('tuner-status', onTunerStatus);
  socket.on('antenna-mode-status', onAntennaModeStatus);

  // Handle socket connection/reconnection
  let hasConnectedOnce = false;

  socket.on('connect', () => {
    if (hasConnectedOnce) {
      console.log('Socket reconnected - restarting monitoring');
      // On reconnect, restart monitoring if we have a device selected
      if (getMonitorState().selectedDevice) {
        // Add small delay to ensure socket is fully ready
        setTimeout(() => {
          const { selectedDevice, selectedTuner, antennaMode, deviceInfo } = getMonitorState();
          if (antennaMode) {
            // Restart antenna mode
            console.log('Emitting start-antenna-mode for device:', selectedDevice, 'tuners:', deviceInfo?.tuners);
            socket.emit('start-antenna-mode', {
              deviceId: selectedDevice,
              tunerCount: deviceInfo?.tuners || 2
            });
          } else {
            // Restart normal monitoring
            console.log('Emitting start-monitoring for device:', selectedDevice, 'tuner:', selectedTuner);
            socket.emit('start-monitoring', {
              deviceId: selectedDevice,
              tuner: selectedTuner
            });
          }
        }, RESTART_DELAY_MS);
      } else {
        console.log('No device selected, skipping monitoring restart');
      }
    } else {
      console.log('Socket connected (initial)');
      hasConnectedOnce = true;
      // Don't start monitoring here - the monitoring effect handles it
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Socket disconnected:', reason);
  });

  socket.on('connect_error', (error) => {
    console.log('Socket connection error:', error.message);
  });

  socket.on('reconnect_attempt', (attemptNumber) => {
    console.log('Reconnection attempt:', attemptNumber);
  });

  socket.on('reconnect_error', (error) => {
    console.log('Reconnection error:', error.message);
  });

  socket.on('reconnect_failed', () => {
    console.log('Reconnection failed - gave up');
  });
}

/**
 * Open the Socket.IO connection for the lifetime of the component and return
 * the socket (null until it exists). The callbacks and monitorState may change
 * between renders; the latest ones are always used.
 */
export function useSocket({ onTunerStatus, onAntennaModeStatus, monitorState }) {
  const [socket, setSocket] = useState(null);
  const latest = useRef({ onTunerStatus, onAntennaModeStatus, monitorState });
  latest.current = { onTunerStatus, onAntennaModeStatus, monitorState };

  useEffect(() => {
    const newSocket = io({
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000
    });
    setSocket(newSocket);

    bindSocketEvents(newSocket, {
      onTunerStatus: (status) => latest.current.onTunerStatus(status),
      onAntennaModeStatus: (data) => latest.current.onAntennaModeStatus(data),
      getMonitorState: () => latest.current.monitorState
    });

    return () => {
      newSocket.close();
    };
  }, []);

  return socket;
}
