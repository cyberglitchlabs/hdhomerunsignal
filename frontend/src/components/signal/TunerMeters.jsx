import { Box, Typography } from '@mui/material';
import SignalHistoryChart, { SERIES_BOTH } from '../SignalHistoryChart';
import SignalBar from './SignalBar';
import { formatDataRate } from '../../utils/signal';

// Signal, SNR and symbol quality bars, the data rate and the history chart for a
// locked tuner; a placeholder when there is no lock. `stats` carries the session
// start/peak markers (see useSignalStats).
export default function TunerMeters({ tunerStatus, stats, signalHistory }) {
  if (!tunerStatus?.lock) {
    return (
      <Typography variant="body2" sx={{ textAlign: 'center', py: 1, color: 'text.secondary' }}>
        No signal detected
      </Typography>
    );
  }

  return (
    <>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
        <Box sx={{ flex: '1 1 120px', minWidth: 120 }}>
          <Typography variant="body2" sx={{ fontSize: '0.75rem', mb: 0.5 }}>
            Signal: {tunerStatus.ss || 0}%
            {tunerStatus.ssDb && <span style={{ fontSize: '0.65rem', opacity: 0.8 }}> (~{tunerStatus.ssDb}dBm)</span>}
          </Typography>
          <SignalBar value={tunerStatus.ss} stats={stats?.ss} />
        </Box>
        <Box sx={{ flex: '1 1 120px', minWidth: 120 }}>
          <Typography variant="body2" sx={{ fontSize: '0.75rem', mb: 0.5 }}>
            SNR: {tunerStatus.snq || 0}%
            {tunerStatus.snrDb && tunerStatus.snrDb > 0 && <span style={{ fontSize: '0.65rem', opacity: 0.8 }}> (~{tunerStatus.snrDb}dB)</span>}
          </Typography>
          <SignalBar value={tunerStatus.snq} stats={stats?.snq} />
        </Box>
        <Box sx={{ flex: '1 1 120px', minWidth: 120 }}>
          <Typography variant="body2" sx={{ fontSize: '0.75rem', mb: 0.5 }}>Sym: {tunerStatus.seq || 0}%</Typography>
          <SignalBar value={tunerStatus.seq} stats={stats?.seq} />
        </Box>
        <Box sx={{ flex: '1 1 100px', minWidth: 100, textAlign: 'right' }}>
          <Typography variant="body2" sx={{ fontSize: '0.75rem' }}>Rate</Typography>
          <Typography variant="body1" sx={{ fontSize: '0.9rem', fontWeight: 500 }}>{formatDataRate(tunerStatus.bps)}</Typography>
        </Box>
      </Box>
      <Box sx={{ height: 180, mt: 1 }}>
        <SignalHistoryChart history={signalHistory} series={SERIES_BOTH} variant="detailed" />
      </Box>
    </>
  );
}
