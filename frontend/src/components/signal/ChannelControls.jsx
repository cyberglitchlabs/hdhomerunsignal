import { Box, Button, TextField, Typography } from '@mui/material';
import {
  Radio as TuneIcon,
  SkipPrevious,
  SkipNext,
  Stop as StopIcon
} from '@mui/icons-material';

// The tuned channel's name, the CH field to type one in, and the tune,
// previous, next and stop buttons.
export default function ChannelControls({
  tunerStatus,
  selectedDevice,
  directChannel,
  onDirectChannelChange,
  maxChannel,
  onTune,
  onPrevious,
  onNext,
  onStop
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1, flexWrap: 'wrap', gap: 1 }}>
      <Typography variant="h6" sx={{ fontSize: '1.1rem', minWidth: 'fit-content' }}>
        {!tunerStatus?.channel || tunerStatus.channel === 'none' ? 'Stopped' : tunerStatus.channel}
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
        <TextField
          label="CH"
          variant="outlined"
          size="small"
          value={directChannel}
          onChange={(e) => onDirectChannelChange(e.target.value.replace(/\D/g, ''))}
          onKeyPress={(e) => {
            if (e.key === 'Enter') {
              onTune(directChannel);
            }
          }}
          placeholder={String(maxChannel)}
          sx={{
            width: 60,
            '& .MuiOutlinedInput-root': {
              paddingLeft: 0,
              paddingRight: 0,
            },
            '& .MuiOutlinedInput-input': {
              padding: '6px 4px',
              textAlign: 'center',
              fontSize: '14px'
            }
          }}
          disabled={!selectedDevice}
          inputProps={{ maxLength: String(maxChannel).length, inputMode: 'numeric', pattern: '[0-9]*' }}
        />
        <Button variant="contained" onClick={() => onTune(directChannel)} disabled={!selectedDevice || !directChannel} size="small" sx={{ minWidth: 'auto', px: 1 }}>
          <TuneIcon />
        </Button>
        <Button variant="outlined" onClick={onPrevious} disabled={!selectedDevice} size="small" sx={{ minWidth: 'auto', px: 1 }}>
          <SkipPrevious />
        </Button>
        <Button variant="outlined" onClick={onNext} disabled={!selectedDevice} size="small" sx={{ minWidth: 'auto', px: 1 }}>
          <SkipNext />
        </Button>
        <Button variant="contained" color="error" onClick={onStop} disabled={!selectedDevice || tunerStatus?.channel === 'none'} size="small" sx={{ minWidth: 'auto', px: 1 }}>
          <StopIcon />
        </Button>
      </Box>
    </Box>
  );
}
