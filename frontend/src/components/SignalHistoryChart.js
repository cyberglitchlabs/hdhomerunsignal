import React, { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';

// The only place Chart.js is registered.
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

const SERIES = {
  signal: {
    label: 'Signal',
    color: 'rgba(76, 175, 80, 1)',
    fill: 'rgba(76, 175, 80, 0.1)'
  },
  snr: {
    label: 'SNR',
    color: 'rgba(255, 152, 0, 1)',
    fill: 'rgba(255, 152, 0, 0.1)'
  }
};

const TICK_COLOR = 'rgba(255, 255, 255, 0.7)';

// Stable references: callers should pass module-level arrays (or these) as `series`
// so the memoised chart data is not rebuilt on every render.
export const SERIES_SIGNAL = ['signal'];
export const SERIES_SNR = ['snr'];
export const SERIES_BOTH = ['signal', 'snr'];

// Nothing here animates (animation is off for every variant), so the chart
// already honours prefers-reduced-motion.
const BASE_OPTIONS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false
};

// Small, decoration-free chart used per tuner in Antenna mode.
const COMPACT_OPTIONS = {
  ...BASE_OPTIONS,
  scales: {
    y: { min: 0, max: 100, ticks: { color: TICK_COLOR, font: { size: 10 } }, grid: { color: 'rgba(255, 255, 255, 0.1)' } },
    x: { display: false }
  },
  plugins: { legend: { display: false }, tooltip: { enabled: false } }
};

// Larger chart for the main view: legend, percent ticks, hover tooltip.
const DETAILED_OPTIONS = {
  ...BASE_OPTIONS,
  interaction: { mode: 'index', intersect: false },
  scales: {
    y: {
      min: 0,
      max: 100,
      ticks: { color: TICK_COLOR, font: { size: 10 }, stepSize: 25, callback: (value) => `${value}%` },
      grid: {
        color: (ctx) => (ctx.tick.value === 50 ? 'rgba(255, 255, 255, 0.18)' : 'rgba(255, 255, 255, 0.08)')
      }
    },
    x: { display: false }
  },
  plugins: {
    legend: {
      display: true,
      position: 'top',
      align: 'end',
      labels: { color: TICK_COLOR, font: { size: 10 }, boxWidth: 12, padding: 8 }
    },
    tooltip: {
      callbacks: {
        title: (items) => {
          const time = items[0]?.label;
          return time ? new Date(Number(time)).toLocaleTimeString() : '';
        },
        label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y}%`
      }
    }
  }
};

const latest = (values) => {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] !== null) return values[i];
  }
  return null;
};

function describe(history, series) {
  const readings = history.signal.filter(v => v !== null).length;
  if (readings === 0) return 'Signal history chart. No readings yet.';
  const parts = series.map(name => `${SERIES[name].label} ${latest(history[name])}%`);
  return `Signal history chart. Latest reading: ${parts.join(', ')}. Showing the last ${readings} readings.`;
}

/**
 * history  value from useSignalHistory
 * series   which lines to draw: SERIES_SIGNAL, SERIES_SNR or SERIES_BOTH
 * variant  'compact' (Antenna mode) or 'detailed' (main view)
 */
function SignalHistoryChart({ history, series = SERIES_BOTH, variant = 'detailed' }) {
  const detailed = variant === 'detailed';

  const data = useMemo(() => ({
    labels: history.times,
    datasets: series.map(name => ({
      label: SERIES[name].label,
      data: history[name],
      borderColor: SERIES[name].color,
      backgroundColor: SERIES[name].fill,
      borderWidth: 2,
      fill: true,
      tension: 0.4,
      spanGaps: false,
      pointRadius: detailed ? 1.5 : 0,
      pointHoverRadius: detailed ? 3 : 0,
      pointBackgroundColor: SERIES[name].color,
      pointBorderColor: 'rgba(0, 0, 0, 0.4)',
      pointBorderWidth: detailed ? 1 : 0
    }))
  }), [history, series, detailed]);

  const summary = useMemo(() => describe(history, series), [history, series]);

  return (
    <Line data={data} options={detailed ? DETAILED_OPTIONS : COMPACT_OPTIONS} role="img" aria-label={summary}>
      {summary}
    </Line>
  );
}

export default SignalHistoryChart;
