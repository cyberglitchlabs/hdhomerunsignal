import {
  Button,
  Chip,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography
} from '@mui/material';
import { PlayArrow as PlayIcon } from '@mui/icons-material';
import PanelCard from './PanelCard';
import { streamFrequency } from '../../utils/channels';
import { streamUrl } from '../../utils/streamUrl';

// The programs on the tuned channel. Watch opens the stream in the user's
// player; right-clicking it asks onContextMenu({ mouseX, mouseY, program }).
export default function ProgramTable({ programs, tunerStatus, region, selectedDevice, onContextMenu }) {
  const watch = (program) => {
    const freq = streamFrequency(tunerStatus?.channel, region);
    if (!freq) return;
    const channelName = `${program.callsign} ${program.virtualChannel}`;
    window.location.href = streamUrl(selectedDevice, 'play.m3u', {
      ch: freq,
      program: program.programNum,
      name: channelName
    });
  };

  return (
    <PanelCard>
      <Typography variant="body1" sx={{ fontSize: '0.9rem', mb: 1, fontWeight: 500 }}>
        Programs on Channel {tunerStatus?.channel?.split(':')[0] || 'Unknown'}
      </Typography>
      <TableContainer component={Paper} sx={{ backgroundColor: 'transparent', boxShadow: 'none' }}>
        <Table size="small" sx={{ '& .MuiTableCell-root': { py: 0.5, fontSize: '0.8rem' } }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 600 }}>PID</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Virtual</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Call Sign</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Status</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Watch</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {programs.map((program, index) => (
              <TableRow key={index}>
                <TableCell>{program.programNum}</TableCell>
                <TableCell>
                  <Chip
                    label={program.virtualChannel}
                    size="small"
                    color="primary"
                    variant="outlined"
                    sx={{ height: 20, fontSize: '0.7rem' }}
                  />
                </TableCell>
                <TableCell>{program.callsign}</TableCell>
                <TableCell>
                  {program.encrypted && (
                    <Chip label="Encrypted" size="small" color="warning" sx={{ height: 18, fontSize: '0.65rem' }} />
                  )}
                  {program.status && !program.encrypted && (
                    <Chip label={program.status} size="small" sx={{ height: 18, fontSize: '0.65rem' }} />
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    size="small"
                    variant="contained"
                    color="primary"
                    onClick={() => watch(program)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      onContextMenu({ mouseX: e.clientX, mouseY: e.clientY, program });
                    }}
                    sx={{ minWidth: 'auto', px: 1, py: 0.25, fontSize: '0.7rem' }}
                    startIcon={<PlayIcon sx={{ fontSize: '0.9rem !important' }} />}
                  >
                    Watch
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </PanelCard>
  );
}
