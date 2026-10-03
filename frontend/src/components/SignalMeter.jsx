import { useState } from 'react';
import { Box, Grid } from '@mui/material';
import AntennaMode from './AntennaMode';
import Atsc3Panels from './signal/Atsc3Panels';
import ChannelControls from './signal/ChannelControls';
import DeviceBar from './signal/DeviceBar';
import PanelCard from './signal/PanelCard';
import ProgramTable from './signal/ProgramTable';
import StreamContextMenu from './signal/StreamContextMenu';
import TunerMeters from './signal/TunerMeters';
import TunerSettings from './signal/TunerSettings';
import { useChannelControl } from '../hooks/useChannelControl';
import { useDevices } from '../hooks/useDevices';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import { useMonitoring } from '../hooks/useMonitoring';
import { useRegion } from '../hooks/useRegion';
import { useSignalHistory } from '../hooks/useSignalHistory';
import { useSignalStats } from '../hooks/useSignalStats';
import { useSocket } from '../hooks/useSocket';
import { useTunerState } from '../hooks/useTunerState';
import { getChannelRange } from '../utils/channels';

function SignalMeter() {
  const { region, channelMap, setChannelMap, changeRegion } = useRegion();
  const { devices, selectedDevice, setSelectedDevice, deviceInfo, loading, discoverDevices, getDeviceInfo } = useDevices();
  const [selectedTuner, setSelectedTuner] = useState(0);
  const [antennaMode, setAntennaMode] = useState(false);
  const [allTunersData, setAllTunersData] = useState([]);
  const [contextMenu, setContextMenu] = useState(null); // { mouseX, mouseY, program }
  const { showInstallButton, install } = useInstallPrompt();

  const { tunerStatus, plpInfo, l1Info, isAtsc3Channel, handleTunerStatus, clearAtsc3Info } = useTunerState();
  // Rolling signal/SNR history for the chart. Restarts with the channel (same key
  // as the session start/peak markers) and only records readings with a lock.
  const signalHistory = useSignalHistory(tunerStatus, {
    resetKey: `${selectedDevice}|${selectedTuner}|${tunerStatus?.channel}`,
    requireLock: true
  });
  const signalStats = useSignalStats(tunerStatus, selectedDevice, selectedTuner);

  const socket = useSocket({
    onTunerStatus: handleTunerStatus,
    onAntennaModeStatus: setAllTunersData,
    monitorState: { selectedDevice, selectedTuner, antennaMode, deviceInfo }
  });
  useMonitoring({
    socket,
    selectedDevice,
    selectedTuner,
    antennaMode,
    deviceInfo,
    onLeaveAntennaMode: () => setAllTunersData([])
  });

  const {
    directChannel,
    setDirectChannel,
    currentChannelPrograms,
    resetChannelData,
    tuneToDirectChannel,
    incrementChannel,
    decrementChannel,
    clearTuner
  } = useChannelControl({ selectedDevice, selectedTuner, region, channelMap, tunerStatus, clearAtsc3Info });

  const handleDeviceChange = async (newDeviceId) => {
    setSelectedDevice(newDeviceId);

    // Clear old channel data when switching devices
    resetChannelData();

    // Get info for new device and adjust tuner if needed
    const info = await getDeviceInfo(newDeviceId);
    if (info && selectedTuner >= info.tuners) {
      // Current tuner doesn't exist on new device - switch to highest tuner
      setSelectedTuner(info.tuners - 1);
    }
  };

  const showTunerPanels = !antennaMode && selectedDevice;

  return (
    <Box>
      <Grid container spacing={1}>
        <DeviceBar
          region={region}
          onRegionChange={changeRegion}
          devices={devices}
          selectedDevice={selectedDevice}
          onDeviceChange={handleDeviceChange}
          onRefresh={() => discoverDevices(true)}
          loading={loading}
          deviceInfo={deviceInfo}
          antennaMode={antennaMode}
          onToggleAntennaMode={() => setAntennaMode(!antennaMode)}
          showInstallButton={showInstallButton}
          onInstall={install}
        />

        {/* Antenna Tuning Mode */}
        {antennaMode && selectedDevice && (
          <Grid item xs={12}>
            <AntennaMode allTunersData={allTunersData} />
          </Grid>
        )}

        {showTunerPanels && (
          <PanelCard>
            <ChannelControls
              tunerStatus={tunerStatus}
              selectedDevice={selectedDevice}
              directChannel={directChannel}
              onDirectChannelChange={setDirectChannel}
              maxChannel={getChannelRange(region, channelMap).max}
              onTune={tuneToDirectChannel}
              onPrevious={decrementChannel}
              onNext={incrementChannel}
              onStop={clearTuner}
            />
            <TunerMeters tunerStatus={tunerStatus} stats={signalStats} signalHistory={signalHistory} />
          </PanelCard>
        )}

        {showTunerPanels && (
          <TunerSettings
            region={region}
            channelMap={channelMap}
            onChannelMapChange={setChannelMap}
            deviceInfo={deviceInfo}
            selectedTuner={selectedTuner}
            onTunerChange={setSelectedTuner}
          />
        )}

        {showTunerPanels && (
          <Atsc3Panels isAtsc3Channel={isAtsc3Channel} plpInfo={plpInfo} l1Info={l1Info} />
        )}

        {showTunerPanels && currentChannelPrograms.length > 0 && (
          <ProgramTable
            programs={currentChannelPrograms}
            tunerStatus={tunerStatus}
            region={region}
            selectedDevice={selectedDevice}
            onContextMenu={setContextMenu}
          />
        )}
      </Grid>

      <StreamContextMenu
        contextMenu={contextMenu}
        onClose={() => setContextMenu(null)}
        tunerStatus={tunerStatus}
        region={region}
        selectedDevice={selectedDevice}
      />
    </Box>
  );
}

export default SignalMeter;
