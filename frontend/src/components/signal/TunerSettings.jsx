import { Box, FormControl, InputLabel, MenuItem, Select } from '@mui/material';
import PanelCard from './PanelCard';
import { CHANNEL_MAPS } from '../../utils/channels';

// Channel map for the region, and which of the device's tuners to look at.
export default function TunerSettings({ region, channelMap, onChannelMapChange, deviceInfo, selectedTuner, onTunerChange }) {
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
            {CHANNEL_MAPS[region].map((map) => (
              <MenuItem key={map.value} value={map.value}>
                {map.label}
              </MenuItem>
            ))}
          </Select>
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
