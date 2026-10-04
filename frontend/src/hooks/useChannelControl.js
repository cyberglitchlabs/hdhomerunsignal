import { useEffect, useState } from 'react';
import axios from 'axios';
import { createCancelGate } from '../utils/cancelGate';
import { channelFromStatus, getChannelRange, stepChannel, tuneTarget } from '../utils/channels';

/**
 * Tune the selected tuner and keep the CH field and the program list in step
 * with what it is actually tuned to.
 *
 * channelMap is the map channel numbers are read and typed in; deviceChannelMap
 * is the one the device itself is set to, when known. When they differ the tune
 * is sent as a frequency (see tuneTarget) so the device's setting is not touched.
 *
 * clearAtsc3Info drops the ATSC 3.0 details held elsewhere whenever the old
 * channel's data goes stale.
 */
export function useChannelControl({
  selectedDevice, selectedTuner, region, channelMap, deviceChannelMap, tunerStatus, clearAtsc3Info
}) {
  const [directChannel, setDirectChannel] = useState('');
  const [currentChannelPrograms, setCurrentChannelPrograms] = useState([]);
  // Every program fetch checks this before writing, so one that is overtaken
  // by a new tune, a tuner/device switch, Stop or unmount is dropped.
  const [programFetchGate] = useState(createCancelGate);

  // Drop everything shown for the previous channel, device or tuner
  const resetChannelData = () => {
    programFetchGate.cancel();
    setCurrentChannelPrograms([]);
    clearAtsc3Info();
    setDirectChannel('');
  };

  // Clear all data when the device or tuner changes. This runs before the
  // auto-fetch effect below so that effect's fetch is not cancelled by it.
  useEffect(() => {
    console.log('Device/tuner changed to:', selectedDevice, selectedTuner, '- clearing old channel data');
    resetChannelData();
    // Note: monitoring will restart via the monitoring effect, and
    // the auto-fetch effect will repopulate data for the new tuner
  }, [selectedDevice, selectedTuner]);

  // Leaving the page cancels any pending program fetch
  useEffect(() => () => programFetchGate.cancel(), []);

  // The channel number the tuner's reported channel means in this region and
  // channel map. A frequency-form channel is a different number per region and
  // map, so the effect below also reruns when a change moves that number, but not
  // otherwise (a region change must not overwrite what the user has typed for
  // 'auto:27'). Null when the region and map cannot place the frequency.
  const reportedChannel = tunerStatus?.channel && tunerStatus.channel !== 'none'
    ? channelFromStatus(tunerStatus.channel, region, channelMap)
    : null;

  // Update directChannel input field when tuner status changes
  useEffect(() => {
    if (tunerStatus?.channel) {
      if (tunerStatus.channel === 'none') {
        // Tuner is cleared/stopped
        setDirectChannel('');
        setCurrentChannelPrograms([]);
      } else {
        // An unplaceable frequency clears the field: leaving the previous number
        // would show one from another region or map, and the up/down buttons
        // would step from it.
        setDirectChannel(reportedChannel ?? '');
      }
    }
  }, [tunerStatus?.channel, reportedChannel]);

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

  const getCurrentChannelPrograms = async (isCurrent = programFetchGate.start()) => {
    if (!selectedDevice) return [];

    try {
      const response = await axios.get(`/api/v1/devices/${selectedDevice}/tuner/${selectedTuner}/programs`);
      if (!isCurrent()) return [];
      setCurrentChannelPrograms(response.data);
      return response.data;
    } catch (error) {
      console.error('Failed to get current channel programs:', error);
      if (isCurrent()) setCurrentChannelPrograms([]);
      return [];
    }
  };

  const tuneToDirectChannel = async (channel) => {
    if (!selectedDevice || !channel) return;

    const target = tuneTarget(channel, region, channelMap, deviceChannelMap);
    if (target === null) {
      console.warn(`Channel ${channel} does not exist in ${channelMap}`);
      return;
    }

    try {
      // Cancel any pending program fetch from previous channel change
      programFetchGate.cancel();
      // Started before the POST so a Stop, switch or newer tune while it is in
      // flight also drops the fetches below
      const isCurrent = programFetchGate.start();

      // Clear old data immediately when changing channels
      setCurrentChannelPrograms([]);
      clearAtsc3Info();

      // Use regular tuning - let backend auto-detect ATSC 3.0
      await axios.post(`/api/v1/devices/${selectedDevice}/tuner/${selectedTuner}/channel`, {
        channel: target
      });
      if (!isCurrent()) return;

      // Don't clear directChannel - it will be updated by the effect when tuner status updates

      // Wait for tuner to lock with progressive delays
      const waitAndGetPrograms = async () => {
        // Initial wait
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (!isCurrent()) return;

        const firstResponse = await getCurrentChannelPrograms(isCurrent);

        // Try again after longer delay for slow-locking channels
        await new Promise(resolve => setTimeout(resolve, 4000));
        if (!isCurrent()) return;

        const response = await axios.get(`/api/v1/devices/${selectedDevice}/tuner/${selectedTuner}/programs`);
        if (!isCurrent()) return;
        if (response.data.length > (firstResponse?.length || 0)) {
          setCurrentChannelPrograms(response.data);
        }
      };

      waitAndGetPrograms().catch(error => console.error('Failed to get programs after tuning:', error));
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

      await axios.post(`/api/v1/devices/${selectedDevice}/tuner/${selectedTuner}/clear`);
    } catch (error) {
      console.error('Failed to clear tuner:', error);
    }
  };

  return {
    directChannel,
    setDirectChannel,
    currentChannelPrograms,
    tuneToDirectChannel,
    incrementChannel,
    decrementChannel,
    clearTuner
  };
}
