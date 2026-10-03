import { useCallback, useState } from 'react';

// ATSC 3.0 is detected from the presence of PLP data in the status.
export function deriveAtsc3State(status) {
  return {
    isAtsc3Channel: Boolean(status.plpInfo && Object.keys(status.plpInfo).length > 0),
    plpInfo: status.plpInfo || null,
    l1Info: status.l1Info || null
  };
}

/**
 * The live tuner status pushed over the event stream, plus the ATSC 3.0 details
 * (PLP and L1 info) that come with it.
 */
export function useTunerState() {
  const [tunerStatus, setTunerStatus] = useState(null);
  const [plpInfo, setPlpInfo] = useState(null);
  const [l1Info, setL1Info] = useState(null);
  const [isAtsc3Channel, setIsAtsc3Channel] = useState(false);

  // Feed this each 'tuner-status' event.
  const handleTunerStatus = useCallback((status) => {
    setTunerStatus(status);
    const atsc3 = deriveAtsc3State(status);
    setIsAtsc3Channel(atsc3.isAtsc3Channel);
    setPlpInfo(atsc3.plpInfo);
    setL1Info(atsc3.l1Info);
  }, []);

  // Drop the ATSC 3.0 details, e.g. when the channel or tuner changes.
  const clearAtsc3Info = useCallback(() => {
    setPlpInfo(null);
    setL1Info(null);
    setIsAtsc3Channel(false);
  }, []);

  return { tunerStatus, plpInfo, l1Info, isAtsc3Channel, handleTunerStatus, clearAtsc3Info };
}
