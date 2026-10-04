import { useState } from 'react';
import { Alert, Box, Button, Grid } from '@mui/material';
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
import { useRegion } from '../hooks/useRegion';
import { useSelectedTuner } from '../hooks/useSelectedTuner';
import { useSignalHistory } from '../hooks/useSignalHistory';
import { statsKey, useSignalStats } from '../hooks/useSignalStats';
import { useEventStream } from '../hooks/useEventStream';
import { useTunerState } from '../hooks/useTunerState';
import { getChannelRange } from '../utils/channels';

function SignalMeter() {
  const { region, channelMap, setChannelMap, changeRegion } = useRegion();
  const {
    devices, selectedDevice, selectDevice, deviceInfo, infoError, retryDeviceInfo, loading, discoverDevices
  } = useDevices();
  // Already valid for the device, so no stream or request uses a tuner it lacks
  const [selectedTuner, setSelectedTuner] = useSelectedTuner(deviceInfo);
  const [antennaMode, setAntennaMode] = useState(false);
  const [allTunersData, setAllTunersData] = useState([]);
  const [contextMenu, setContextMenu] = useState(null); // { mouseX, mouseY, program }
  const { showInstallButton, install } = useInstallPrompt();

  const { tunerStatus, plpInfo, l1Info, isAtsc3Channel, handleTunerStatus, clearAtsc3Info } = useTunerState(`${selectedDevice}/${selectedTuner}`);
  // Rolling signal/SNR history for the chart. Restarts with the channel (same key
  // as the session start/peak markers) and only records readings with a lock.
  const signalHistory = useSignalHistory(tunerStatus, {
    resetKey: statsKey(selectedDevice, selectedTuner, tunerStatus?.channel),
    requireLock: true
  });
  const signalStats = useSignalStats(tunerStatus, selectedDevice, selectedTuner);

  useEventStream({
    selectedDevice,
    selectedTuner,
    antennaMode,
    deviceInfo,
    onTunerStatus: handleTunerStatus,
    onAntennaModeStatus: setAllTunersData,
    onLeaveAntennaMode: () => setAllTunersData([])
  });

  const {
    directChannel,
    setDirectChannel,
    currentChannelPrograms,
    tuneToDirectChannel,
    incrementChannel,
    decrementChannel,
    clearTuner
  } = useChannelControl({ selectedDevice, selectedTuner, region, channelMap, tunerStatus, clearAtsc3Info });

  const showTunerPanels = !antennaMode && selectedDevice;

  return (
    <Box>
      <Grid container spacing={1}>
        <DeviceBar
          region={region}
          onRegionChange={changeRegion}
          devices={devices}
          selectedDevice={selectedDevice}
          onDeviceChange={selectDevice}
          onRefresh={() => discoverDevices(true)}
          loading={loading}
          deviceInfo={deviceInfo}
          antennaMode={antennaMode}
          onToggleAntennaMode={() => setAntennaMode(!antennaMode)}
          showInstallButton={showInstallButton}
          onInstall={install}
        />

        {infoError && selectedDevice && (
          <Grid item xs={12}>
            <Alert
              severity="warning"
              action={<Button color="inherit" size="small" onClick={retryDeviceInfo}>Retry</Button>}
            >
              Could not load this device's details, so it is assumed to have {deviceInfo?.tuners} tuners.
            </Alert>
          </Grid>
        )}

        {/* Antenna Tuning Mode */}
        {antennaMode && selectedDevice && (
          <Grid item xs={12}>
            <AntennaMode allTunersData={allTunersData} region={region} channelMap={channelMap} />
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
            channelMap={channelMap}
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
        channelMap={channelMap}
        selectedDevice={selectedDevice}
      />
    </Box>
  );
}

export default SignalMeter;
