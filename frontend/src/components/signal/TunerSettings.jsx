import { Box, FormControl, FormHelperText, InputLabel, MenuItem, Select } from '@mui/material';
import PanelCard from './PanelCard';
import { CHANNEL_MAPS } from '../../utils/channels';

// The channel map in use, and which of the device's tuners to look at. When the
// device reports the map it is set to, that is the one in use and it cannot be
// changed here: the device decides what a channel number means.
export default function TunerSettings({
  region, channelMap, deviceChannelMap, onChannelMapChange, deviceInfo, selectedTuner, onTunerChange
}) {
  const maps = CHANNEL_MAPS[region];
  // The device's map can be one the region's list does not have
  const options = maps.some((map) => map.value === channelMap)
    ? maps
    : [...maps, { value: channelMap, label: channelMap }];
  return (
    <PanelCard>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
        <FormControl sx={{ minWidth: 140, flex: 1 }} size="small">
          <InputLabel>Channel Map</InputLabel>
          <Select
            value={channelMap}
            label="Channel Map"
            disabled={Boolean(deviceChannelMap)}
            onChange={(e) => onChannelMapChange(e.target.value)}
          >
            {options.map((map) => (
              <MenuItem key={map.value} value={map.value}>
                {map.label}
              </MenuItem>
            ))}
          </Select>
          {deviceChannelMap && <FormHelperText>Set on the device</FormHelperText>}
        </FormControl>

        {deviceInfo && (
          <FormControl sx={{ minWidth: 100 }} size="small">
            <InputLabel>Tuner</InputLabel>
            <Select
              value={selectedTuner}
              label="Tuner"
              onChange={(e) => onTunerChange(e.target.value)}
            >
              {Array.from({ length: deviceInfo.tuners }, (_, i) => (
                <MenuItem key={i} value={i}>
                  Tuner {i}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
      </Box>
    </PanelCard>
  );
}
