import { Box, Button, FormControl, InputLabel, MenuItem, Select } from '@mui/material';
import {
  Refresh as RefreshIcon,
  GetApp as InstallIcon,
  Satellite as AntennaIcon
} from '@mui/icons-material';
import PanelCard from './PanelCard';
import { REGIONS } from '../../utils/channels';

// Top bar: region and device pickers, rescan, the antenna mode toggle (once the
// device's info is in) and the PWA install button.
export default function DeviceBar({
  region,
  onRegionChange,
  devices,
  selectedDevice,
  onDeviceChange,
  onRefresh,
  loading,
  deviceInfo,
  antennaMode,
  onToggleAntennaMode,
  showInstallButton,
  onInstall
}) {
  return (
    <PanelCard>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <FormControl sx={{ minWidth: 140 }} size="small">
          <InputLabel>Region</InputLabel>
          <Select
            value={region}
            label="Region"
            onChange={(e) => onRegionChange(e.target.value)}
          >
            {REGIONS.map((r) => (
              <MenuItem key={r.value} value={r.value}>
                {r.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl sx={{ minWidth: 180, flex: 1 }} size="small">
          <InputLabel>Device</InputLabel>
          <Select
            value={selectedDevice}
            label="Device"
            onChange={(e) => onDeviceChange(e.target.value)}
          >
            {devices.map((device) => (
              <MenuItem
                key={device.id}
                value={device.id}
                disabled={device.online === false}
                sx={device.online === false ? { color: 'text.disabled', fontStyle: 'italic' } : {}}
              >
                {device.name || device.id}{device.online === false ? ' (offline)' : ''}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Button
          variant="outlined"
          onClick={onRefresh}
          disabled={loading}
          sx={{ minWidth: 'auto', px: 1 }}
          size="small"
        >
          <RefreshIcon />
        </Button>
        {deviceInfo && (
          <Button
            variant={antennaMode ? "contained" : "outlined"}
            onClick={onToggleAntennaMode}
            sx={{ minWidth: 'auto', px: 1 }}
            size="small"
            color={antennaMode ? "primary" : "inherit"}
          >
            <AntennaIcon />
          </Button>
        )}
        {showInstallButton && (
          <Button
            variant="contained"
            onClick={onInstall}
            color="primary"
            sx={{ minWidth: 'auto', px: 1 }}
            size="small"
          >
            <InstallIcon />
          </Button>
        )}
      </Box>
    </PanelCard>
  );
}
