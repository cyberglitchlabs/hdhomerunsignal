import { useEffect, useRef } from 'react';

/**
 * The URL of the event stream the current mode needs: one tuner's status
 * normally, or every tuner's in antenna mode. Null when there is nothing to
 * subscribe to yet (no device, or antenna mode before the device's tuner count
 * is known). useEventStream also holds back normal mode until the info is known.
 */
export function streamUrl({ selectedDevice, selectedTuner, antennaMode, deviceInfo }) {
  if (!selectedDevice) return null;
  const device = encodeURIComponent(selectedDevice);
  if (antennaMode) {
    if (!deviceInfo) return null;
    return `/api/v1/devices/${device}/antenna/stream?tuners=${deviceInfo.tuners}`;
  }
  return `/api/v1/devices/${device}/tuner/${selectedTuner}/stream`;
}

/**
 * Open an EventSource on `url` and forward its status events. Returns a
 * function that closes it. The browser reconnects a dropped stream on its own,
 * and each connection is a fresh subscription, so nothing has to be restarted.
 */
export function subscribe(url, { onTunerStatus, onAntennaModeStatus }) {
  const source = new EventSource(url);
  const forward = (handler) => (event) => {
    try {
      handler(JSON.parse(event.data));
    } catch (error) {
      console.log('Ignoring malformed stream event:', error.message);
    }
  };
  source.addEventListener('tuner-status', forward(onTunerStatus));
  source.addEventListener('antenna-mode-status', forward(onAntennaModeStatus));
  source.onerror = () => console.log('Event stream interrupted; the browser will reconnect');
  return () => source.close();
}

/**
 * Keep one event stream open for the selected device, tuner and mode. This is
 * the only place that subscribes: each change closes the old stream and opens
 * the new one exactly once. Nothing is opened until the device's info is known,
 * so the tuner (already clamped by the caller) is one the device has.
 *
 * onLeaveAntennaMode runs when normal mode starts so the caller can drop the
 * antenna readings. The callbacks may change between renders; the latest ones
 * are always used.
 */
export function useEventStream({
  selectedDevice, selectedTuner, antennaMode, deviceInfo,
  onTunerStatus, onAntennaModeStatus, onLeaveAntennaMode
}) {
  const latest = useRef({ onTunerStatus, onAntennaModeStatus, onLeaveAntennaMode });
  // An effect, so a discarded render can't leak in
  useEffect(() => {
    latest.current = { onTunerStatus, onAntennaModeStatus, onLeaveAntennaMode };
  });

  // Only antenna mode needs the tuner count, so normal monitoring must not
  // restart when the info changes, only wait for it.
  const infoKnown = Boolean(deviceInfo);
  const tunerCount = antennaMode ? deviceInfo?.tuners : undefined;
  // The selected tuner is irrelevant in antenna mode, so it must not restart it.
  const tuner = antennaMode ? null : selectedTuner;

  useEffect(() => {
    const url = streamUrl({
      selectedDevice,
      selectedTuner: tuner,
      antennaMode,
      deviceInfo: tunerCount === undefined ? null : { tuners: tunerCount }
    });
    if (!url || !infoKnown) return undefined;
    if (!antennaMode) latest.current.onLeaveAntennaMode();
    return subscribe(url, {
      onTunerStatus: (status) => latest.current.onTunerStatus(status),
      onAntennaModeStatus: (data) => latest.current.onAntennaModeStatus(data)
    });
  }, [selectedDevice, tuner, antennaMode, tunerCount, infoKnown]);
}
