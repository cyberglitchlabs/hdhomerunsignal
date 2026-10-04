import React from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Chip,
  Grid,
  Paper
} from '@mui/material';
import SignalHistoryChart, { SERIES_SIGNAL, SERIES_SNR } from './SignalHistoryChart';
import { useSignalHistory } from '../hooks/useSignalHistory';
import { formatChannelDisplay } from '../utils/channels';

// The two per-tuner history charts. Keeps its own rolling history: it restarts
// when the tuner's channel changes and records every reading, lock or not.
function TunerHistoryCharts({ status }) {
  const history = useSignalHistory(status, { resetKey: status?.channel || 'none', fixedWindow: false });

  return (
    <Grid container spacing={1}>
      <Grid item xs={6}>
        <Typography variant="caption" sx={{ fontSize: '0.7rem', fontWeight: 500 }}>
          Signal: {status?.ss || 0}%
        </Typography>
        <Box sx={{ height: 80, mt: 0.5 }}>
          <SignalHistoryChart history={history} series={SERIES_SIGNAL} variant="compact" />
        </Box>
      </Grid>

      <Grid item xs={6}>
        <Typography variant="caption" sx={{ fontSize: '0.7rem', fontWeight: 500 }}>
          SNR: {status?.snq || 0}%
        </Typography>
        <Box sx={{ height: 80, mt: 0.5 }}>
          <SignalHistoryChart history={history} series={SERIES_SNR} variant="compact" />
        </Box>
      </Grid>
    </Grid>
  );
}

function AntennaMode({ allTunersData, region, channelMap }) {
  const getSymbolColor = (symbolQuality) => {
    if (symbolQuality === 100) return 'success';
    if (symbolQuality > 0) return 'error';
    return 'default';
  };

  const getSymbolLabel = (symbolQuality) => {
    if (symbolQuality === 100) return '100% ✓';
    if (symbolQuality > 0) return `${symbolQuality}%`;
    return 'No Signal';
  };

  if (!allTunersData || allTunersData.length === 0) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <Typography variant="body1" color="text.secondary">
          Starting antenna tuning mode...
        </Typography>
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2, fontSize: '1rem', textAlign: 'center' }}>
        Antenna Tuning Mode - All Tuners
      </Typography>

      <Grid container spacing={2}>
        {allTunersData.map(({ tuner, status }) => (
          <Grid item xs={12} md={6} key={tuner}>
            <Card>
              <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                  <Typography variant="body1" sx={{ fontWeight: 600, fontSize: '0.95rem' }}>
                    Tuner {tuner}
                  </Typography>
                  <Chip
                    label={getSymbolLabel(status?.seq || 0)}
                    color={getSymbolColor(status?.seq || 0)}
                    size="small"
                    sx={{ fontWeight: 600 }}
                  />
                </Box>

                {status?.channel && status.channel !== 'none' && (
                  <Typography variant="body2" sx={{ fontSize: '0.8rem', mb: 1, color: 'text.secondary' }}>
                    {formatChannelDisplay(status.channel, region, channelMap)}
                  </Typography>
                )}

                <TunerHistoryCharts status={status} />
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}

export default AntennaMode;
