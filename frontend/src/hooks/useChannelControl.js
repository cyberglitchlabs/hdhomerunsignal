import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { channelFromStatus, getChannelRange, stepChannel } from '../utils/channels';

/**
 * Tune the selected tuner and keep the CH field and the program list in step
 * with what it is actually tuned to.
 *
 * clearAtsc3Info drops the ATSC 3.0 details held elsewhere whenever the old
 * channel's data goes stale.
 */
export function useChannelControl({ selectedDevice, selectedTuner, region, channelMap, tunerStatus, clearAtsc3Info }) {
  const [directChannel, setDirectChannel] = useState('');
  const [currentChannelPrograms, setCurrentChannelPrograms] = useState([]);
  const pendingProgramFetchRef = useRef(null);

  // Drop everything shown for the previous channel, device or tuner
  const resetChannelData = () => {
    setCurrentChannelPrograms([]);
    clearAtsc3Info();
    setDirectChannel('');
  };

  // Update directChannel input field when tuner status changes
  useEffect(() => {
    if (tunerStatus?.channel) {
      if (tunerStatus.channel === 'none') {
        // Tuner is cleared/stopped
        setDirectChannel('');
        setCurrentChannelPrograms([]);
      } else {
        const channel = channelFromStatus(tunerStatus.channel, region);
        if (channel) setDirectChannel(channel);
      }
    }
  }, [tunerStatus?.channel]);

  // Auto-fetch programs when channel is already tuned on initial load or after tuner change
  useEffect(() => {
    if (tunerStatus?.lock &&
        tunerStatus.channel &&
        tunerStatus.channel !== 'none' &&
        currentChannelPrograms.length === 0 &&
        selectedDevice) {
      // Channel is tuned but we don't have program info yet - fetch it
      console.log('Auto-fetching programs for tuner', selectedTuner);
      getCurrentChannelPrograms();
    }
  }, [tunerStatus?.lock, tunerStatus?.channel, selectedDevice, selectedTuner]);

  // Clear all data when tuner changes
  useEffect(() => {
    console.log('Tuner changed to:', selectedTuner, '- clearing old channel data');
    resetChannelData();
    // Note: monitoring will restart via the monitoring effect, and
    // the auto-fetch effect will repopulate data for the new tuner
  }, [selectedTuner]);

  const getCurrentChannelPrograms = async () => {
    if (!selectedDevice) return [];

    try {
      const response = await axios.get(`/api/devices/${selectedDevice}/tuner/${selectedTuner}/programs`);
      setCurrentChannelPrograms(response.data);
      return response.data;
    } catch (error) {
      console.error('Failed to get current channel programs:', error);
      setCurrentChannelPrograms([]);
      return [];
    }
  };

  const tuneToDirectChannel = async (channel) => {
    if (!selectedDevice || !channel) return;

    try {
      // Cancel any pending program fetch from previous channel change
      if (pendingProgramFetchRef.current) {
        pendingProgramFetchRef.current.cancelled = true;
        pendingProgramFetchRef.current = null;
      }

      // Clear old data immediately when changing channels
      setCurrentChannelPrograms([]);
      clearAtsc3Info();

      // Use regular tuning - let backend auto-detect ATSC 3.0
      await axios.post(`/api/devices/${selectedDevice}/tuner/${selectedTuner}/channel`, {
        channel
      });

      // Don't clear directChannel - it will be updated by the effect when tuner status updates

      // Create cancellation token for this fetch operation
      const fetchToken = { cancelled: false };
      pendingProgramFetchRef.current = fetchToken;

      // Wait for tuner to lock with progressive delays
      const waitAndGetPrograms = async () => {
        // Initial wait
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Check if this operation was cancelled
        if (fetchToken.cancelled) return;

        const firstResponse = await getCurrentChannelPrograms();

        // Try again after longer delay for slow-locking channels
        await new Promise(resolve => setTimeout(resolve, 4000));

        // Check again if this operation was cancelled before updating state
        if (fetchToken.cancelled) return;

        const response = await axios.get(`/api/devices/${selectedDevice}/tuner/${selectedTuner}/programs`);
        if (response.data.length > (firstResponse?.length || 0)) {
          setCurrentChannelPrograms(response.data);
        }
      };

      waitAndGetPrograms();
    } catch (error) {
      console.error('Failed to set channel:', error);
    }
  };

  // Step one channel up (+1) or down (-1) within the region's range
  const stepAndTune = async (delta) => {
    if (!selectedDevice) return;

    // Clear old data immediately
    setCurrentChannelPrograms([]);
    clearAtsc3Info();

    const next = stepChannel(directChannel, delta, getChannelRange(region, channelMap));

    try {
      await tuneToDirectChannel(next.toString());
    } catch (error) {
      console.error(`Failed to ${delta > 0 ? 'increment' : 'decrement'} channel:`, error);
    }
  };

  const incrementChannel = () => stepAndTune(1);
  const decrementChannel = () => stepAndTune(-1);

  const clearTuner = async () => {
    if (!selectedDevice) return;

    try {
      // Clear all data immediately
      resetChannelData();

      await axios.post(`/api/devices/${selectedDevice}/tuner/${selectedTuner}/clear`);
    } catch (error) {
      console.error('Failed to clear tuner:', error);
    }
  };

  return {
    directChannel,
    setDirectChannel,
    currentChannelPrograms,
    resetChannelData,
    tuneToDirectChannel,
    incrementChannel,
    decrementChannel,
    clearTuner
  };
}
