import { useCallback, useEffect, useRef, useState } from 'react';

// ATSC 3.0 is detected from the presence of PLP data in the status.
export function deriveAtsc3State(status) {
  return {
    isAtsc3Channel: Boolean(status.plpInfo && Object.keys(status.plpInfo).length > 0),
    plpInfo: status.plpInfo || null,
    l1Info: status.l1Info || null
  };
}

// Nothing received yet for the current source
const EMPTY = { source: undefined, status: null, plpInfo: null, l1Info: null, isAtsc3Channel: false };

/**
 * The live tuner status pushed over the event stream, plus the ATSC 3.0 details
 * (PLP and L1 info) that come with it.
 *
 * `source` identifies what the stream is for (the device and tuner). Readings are
 * stored with the source they arrived for, and only the current source's are
 * returned, so no render after a switch shows the previous tuner's reading, and
 * the new tuner's first reading always counts as a change, even when it matches
 * the old tuner's channel and lock.
 */
export function useTunerState(source) {
  const [state, setState] = useState(EMPTY);
  // The source new readings belong to. Updated in an effect that runs before the
  // stream for the new source subscribes, so no reading is tagged with the old one.
  const sourceRef = useRef(source);

  // Also forget what was stored, so returning to an earlier source does not bring
  // its old reading back
  useEffect(() => {
    sourceRef.current = source;
    setState(EMPTY);
  }, [source]);

  // Feed this each 'tuner-status' event.
  const handleTunerStatus = useCallback((status) => {
    setState({ source: sourceRef.current, status, ...deriveAtsc3State(status) });
  }, []);

  // Drop the ATSC 3.0 details, e.g. when the channel or tuner changes.
  const clearAtsc3Info = useCallback(() => {
    setState((prev) => ({ ...prev, plpInfo: null, l1Info: null, isAtsc3Channel: false }));
  }, []);

  const current = state.source === source ? state : EMPTY;
  return {
    tunerStatus: current.status,
    plpInfo: current.plpInfo,
    l1Info: current.l1Info,
    isAtsc3Channel: current.isAtsc3Channel,
    handleTunerStatus,
    clearAtsc3Info
  };
}
