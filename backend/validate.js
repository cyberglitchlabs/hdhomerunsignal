// Strict allowlist validators for every value that reaches hdhomerun_config
// or is reflected into a response. Each returns the (normalised) value, or
// null when the input is not acceptable.

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const CHANNEL_RE = /^(?:[a-z0-9]{2,10}:)?\d{1,10}(?::\d{1,3}(?:\+\d{1,3})*)?$/;
const DIGITS_RE = /^\d{1,10}$/;

const CHANNEL_MAPS = new Set([
  'us-bcast', 'us-cable', 'us-hrc', 'us-irc',
  'ca-bcast', 'ca-cable', 'ca-hrc', 'ca-irc',
  'eu-bcast', 'eu-cable',
  'au-bcast', 'au-cable',
]);

const MAX_TUNER = 7;
const MAX_PLPS = 64;
const MAX_NAME_LENGTH = 64;
const MAX_LOG_LENGTH = 1000;

// Device ID (e.g. 1080ABCD), IPv4 address or hostname. Must start with an
// alphanumeric so it can never be parsed as a command-line option.
function deviceHost(value) {
  if (typeof value !== 'string' || value.length > 253) return null;
  return HOST_RE.test(value) ? value : null;
}

function tuner(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= MAX_TUNER ? value : null;
  }
  if (typeof value === 'string' && /^[0-7]$/.test(value)) return Number(value);
  return null;
}

function channelMap(value) {
  return typeof value === 'string' && CHANNEL_MAPS.has(value) ? value : null;
}

// 27, auto:27, 8vsb:27, qam256:117, auto:575000000, atsc3:27, atsc3:27:0+1+2,
// plus the special values none, + and -.
function channel(value) {
  if (typeof value !== 'string') return null;
  if (value === 'none' || value === '+' || value === '-') return value;
  return CHANNEL_RE.test(value) ? value : null;
}

// Optional list of ATSC 3.0 PLP ids. Missing means "none selected".
function plps(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_PLPS) return null;
  const out = [];
  for (const item of value) {
    const n = typeof item === 'string' && /^\d{1,3}$/.test(item) ? Number(item) : item;
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

function digits(value) {
  return typeof value === 'string' && DIGITS_RE.test(value) ? value : null;
}

// Free-text label reflected into the M3U playlist: no control characters
// (so a value cannot add playlist lines) and a bounded length.
function displayName(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, MAX_NAME_LENGTH);
}

// Renders any value for a log line: control characters (newlines included)
// become spaces so a value cannot forge extra log entries, and the length is
// bounded.
function logSafe(value) {
  // eslint-disable-next-line no-control-regex
  const text = String(value).replace(/[\x00-\x1f\x7f]/g, ' ');
  return text.length > MAX_LOG_LENGTH ? `${text.slice(0, MAX_LOG_LENGTH)}…` : text;
}

module.exports = { deviceHost, tuner, channelMap, channel, plps, digits, displayName, logSafe };
