import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { createCancelGate } from '../utils/cancelGate';

/**
 * Which device to show after a discovery: the current one while it is still
 * online, otherwise the first online one, or null when none is.
 */
export function chooseDevice(devices, currentId) {
  const online = devices.filter(d => d.online !== false);
  return online.find(d => d.id === currentId) || online[0] || null;
}

// Tuner count assumed when a device's info cannot be loaded
export const FALLBACK_DEVICE_INFO = { tuners: 2 };

/** The tuner to use on a device: the current one, or the last one if it doesn't have that many. */
export function clampTuner(tuner, deviceInfo) {
  if (deviceInfo && tuner >= deviceInfo.tuners) return Math.max(deviceInfo.tuners - 1, 0);
  return tuner;
}

/**
 * The devices on the network and the one being viewed. Discovers on mount and
 * selects the first online device; discoverDevices(true) forces a fresh lookup
 * and keeps the current device while it is still online.
 */
export function useDevices() {
  const [devices, setDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [deviceInfo, setDeviceInfo] = useState(null);
  // True when the info request failed and deviceInfo is the fallback
  const [infoError, setInfoError] = useState(false);
  const [loading, setLoading] = useState(false);
  // The selection as discoverDevices sees it, even before React re-renders
  const selectedRef = useRef('');
  const [infoGate] = useState(createCancelGate);

  const clearSelection = () => {
    infoGate.cancel();
    selectedRef.current = '';
    setSelectedDevice('');
    setDeviceInfo(null);
    setInfoError(false);
  };

  // Switch to a device and load its info. Only the latest request's info is
  // used, so a slow response for a device the user left is ignored.
  const selectDevice = async (deviceId) => {
    infoGate.cancel();
    const isCurrent = infoGate.start();
    if (deviceId !== selectedRef.current) {
      // The old device's info does not describe the new one
      setDeviceInfo(null);
    }
    setInfoError(false);
    selectedRef.current = deviceId;
    setSelectedDevice(deviceId);

    try {
      const response = await axios.get(`/api/v1/devices/${deviceId}/info`);
      console.log('Device info received:', response.data);
      if (isCurrent()) setDeviceInfo(response.data);
      return response.data;
    } catch (error) {
      console.error('Failed to get device info:', error);
      if (isCurrent()) {
        // Monitoring waits for the info, so give it a tuner count to go on
        setDeviceInfo(FALLBACK_DEVICE_INFO);
        setInfoError(true);
      }
      return null;
    }
  };

  const retryDeviceInfo = () => (selectedRef.current ? selectDevice(selectedRef.current) : Promise.resolve(null));

  const discoverDevices = async (force = false) => {
    setLoading(true);
    try {
      const url = force ? '/api/v1/devices?force=true' : '/api/v1/devices';
      const response = await axios.get(url);
      setDevices(response.data);
      const chosen = chooseDevice(response.data, selectedRef.current);
      if (chosen) {
        await selectDevice(chosen.id);
      } else {
        // None online, or none found at all (e.g. the device was unplugged):
        // the old selection no longer exists. Harmless when nothing was selected.
        clearSelection();
      }
    } catch (error) {
      console.error('Failed to discover devices:', error);
    }
    setLoading(false);
  };

  useEffect(() => {
    discoverDevices();
  }, []);

  return {
    devices, selectedDevice, selectDevice, deviceInfo, infoError, retryDeviceInfo, loading, discoverDevices
  };
}
