import { useEffect, useState } from 'react';
import axios from 'axios';

/**
 * The devices on the network and the one being viewed. Discovers on mount and
 * selects the first online device; discoverDevices(true) forces a fresh lookup.
 */
export function useDevices() {
  const [devices, setDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [loading, setLoading] = useState(false);

  const discoverDevices = async (force = false) => {
    setLoading(true);
    try {
      const url = force ? '/api/devices?force=true' : '/api/devices';
      const response = await axios.get(url);
      setDevices(response.data);
      // Auto-select first online device
      const firstOnlineDevice = response.data.find(d => d.online !== false);
      if (firstOnlineDevice) {
        setSelectedDevice(firstOnlineDevice.id);
        await getDeviceInfo(firstOnlineDevice.id);
      } else if (response.data.length > 0) {
        // All devices offline - clear selection
        setSelectedDevice('');
        setDeviceInfo(null);
      }
    } catch (error) {
      console.error('Failed to discover devices:', error);
    }
    setLoading(false);
  };

  const getDeviceInfo = async (deviceId) => {
    try {
      const response = await axios.get(`/api/devices/${deviceId}/info`);
      console.log('Device info received:', response.data);
      setDeviceInfo(response.data);
      return response.data;
    } catch (error) {
      console.error('Failed to get device info:', error);
      return null;
    }
  };

  useEffect(() => {
    discoverDevices();
  }, []);

  return { devices, selectedDevice, setSelectedDevice, deviceInfo, loading, discoverDevices, getDeviceInfo };
}
