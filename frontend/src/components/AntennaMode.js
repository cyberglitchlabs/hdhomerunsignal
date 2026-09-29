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

// Convert frequency (in Hz) to broadcast channel number
function frequencyToChannel(freqHz) {
  const freqMhz = freqHz / 1000000;

  // VHF Low (channels 2-6): 54-88 MHz
  if (freqMhz >= 54 && freqMhz <= 88) {
    const vhfLowChannels = [
      { ch: 2, freq: 57 }, { ch: 3, freq: 63 }, { ch: 4, freq: 69 },
      { ch: 5, freq: 79 }, { ch: 6, freq: 85 }
    ];
    let closest = vhfLowChannels[0];
    let minDiff = Math.abs(freqMhz - closest.freq);
    for (const ch of vhfLowChannels) {
      const diff = Math.abs(freqMhz - ch.freq);
      if (diff < minDiff) {
        minDiff = diff;
        closest = ch;
      }
    }
    return closest.ch;
  }

  // VHF High (channels 7-13): 174-216 MHz
  if (freqMhz >= 174 && freqMhz <= 216) {
    const channel = Math.round((freqMhz - 177) / 6) + 7;
    return Math.max(7, Math.min(13, channel));
  }

  // UHF (channels 14-36): 470-608 MHz (post-repack)
  if (freqMhz >= 470 && freqMhz <= 608) {
    const channel = Math.round((freqMhz - 473) / 6) + 14;
    return Math.max(14, Math.min(36, channel));
  }

  return null; // Unknown frequency range
}

// Format channel display - convert frequency format to channel number
function formatChannelDisplay(channelStr) {
  if (!channelStr || channelStr === 'none') {
    return 'Not tuned';
  }

  // Check for frequency format (e.g., "auto6t:605028615")
  const freqMatch = channelStr.match(/:(\d{8,})/);
  if (freqMatch) {
    const freqHz = parseInt(freqMatch[1]);
    const channel = frequencyToChannel(freqHz);
    if (channel) {
      return `Channel ${channel}`;
    }
  }

  // Standard format (e.g., "auto:4" -> "Channel 4")
  const channelMatch = channelStr.match(/(?:auto:)?(\d+)/);
  if (channelMatch) {
    return `Channel ${channelMatch[1]}`;
  }

  return channelStr; // Fallback to raw format
}

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

function AntennaMode({ allTunersData }) {
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
                    {formatChannelDisplay(status.channel)}
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
