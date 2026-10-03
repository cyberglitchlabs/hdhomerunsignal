export function getSignalColor(value) {
  if (value >= 80) return '#4CAF50';
  if (value >= 60) return '#FF9800';
  return '#F44336';
}

export function formatDataRate(bps) {
  if (!bps) return '0.000 Mbps';
  return (bps / 1000000).toFixed(3) + ' Mbps';
}

// Fold one status reading into a metric's session stats. Each metric latches its
// own baseline on its first non-zero reading: the device reports lock=none with
// 0/0/0 while it is still acquiring, and the three values do not come up together,
// so a shared baseline pins whichever metric arrives last at 0.
export function trackMetric(prev, raw) {
  const value = raw || 0;
  if (!prev) return { initial: value > 0 ? value : null, max: value };
  const initial = prev.initial === null && value > 0 ? value : prev.initial;
  if (initial === prev.initial && value <= prev.max) return prev;
  return { initial, max: Math.max(prev.max, value) };
}
