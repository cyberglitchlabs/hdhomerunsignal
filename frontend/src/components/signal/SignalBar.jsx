import { Box, LinearProgress, Tooltip } from '@mui/material';
import { getSignalColor } from '../../utils/signal';

// Signal bar with optional session markers: a dimmed high-water fill behind the
// live bar, and a caret under the track showing the reading when we first locked
// this channel. Together they show at a glance whether an antenna nudge helped.
export default function SignalBar({ value, stats }) {
  const current = value || 0;
  const peak = stats ? Math.max(stats.max, current) : null;
  const initial = stats && stats.initial !== null ? stats.initial : null;
  const tip = stats
    ? `Now ${current}% \u00b7 Start ${initial === null ? '\u2014' : initial + '%'} \u00b7 Peak ${peak}%`
    : '';

  return (
    <Tooltip title={tip} placement="top" arrow enterDelay={200} disableInteractive>
    <Box>
      <Box sx={{ position: 'relative', height: 8 }}>
        <Box sx={{ position: 'absolute', inset: 0, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.1)' }} />
        {peak !== null && (
          <Box sx={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${peak}%`,
            borderRadius: 4,
            backgroundColor: getSignalColor(peak),
            opacity: 0.3
          }} />
        )}
        <LinearProgress
          variant="determinate"
          value={current}
          sx={{
            position: 'absolute',
            inset: 0,
            height: 8,
            borderRadius: 4,
            backgroundColor: 'transparent',
            '& .MuiLinearProgress-bar': { backgroundColor: getSignalColor(current) }
          }}
        />
      </Box>
      <Box sx={{ position: 'relative', height: 9 }}>
        {initial !== null && (
          <Box sx={{
            position: 'absolute',
            left: `${initial}%`,
            transform: 'translateX(-50%)',
            fontSize: '0.5rem',
            lineHeight: 1,
            color: 'text.secondary',
            opacity: 0.65,
            userSelect: 'none'
          }}>
            &#9650;
          </Box>
        )}
      </Box>
    </Box>
    </Tooltip>
  );
}
