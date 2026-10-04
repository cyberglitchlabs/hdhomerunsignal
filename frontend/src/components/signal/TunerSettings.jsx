import { Box, FormControl, FormHelperText, InputLabel, MenuItem, Select } from '@mui/material';
import PanelCard from './PanelCard';
import { CHANNEL_MAPS } from '../../utils/channels';

const labelOf = (value) => Object.values(CHANNEL_MAPS).flat().find((map) => map.value === value)?.label || value;

// The channel map in use, and which of the device's tuners to look at. Channel
// numbers are read with the device's own map unless another is chosen here; a
// different choice only changes how this page tunes (by frequency), never the
// device's setting, and is not remembered.
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
            onChange={(e) => onChannelMapChange(e.target.value)}
          >
            {options.map((map) => (
              <MenuItem key={map.value} value={map.value}>
                {map.label}
              </MenuItem>
            ))}
          </Select>
          {deviceChannelMap && (
            <FormHelperText>
              {deviceChannelMap === channelMap
                ? "The device's channel map"
                : `The device is set to ${labelOf(deviceChannelMap)}. Tuning by frequency; the device's setting is not changed.`}
            </FormHelperText>
          )}
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
