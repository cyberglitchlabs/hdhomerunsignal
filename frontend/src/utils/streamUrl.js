/**
 * A backend stream URL for a device, e.g. streamUrl(id, 'play.m3u', { ch, program, name }).
 * The device id and every parameter value are encoded, so Watch and Copy Stream
 * URL build their requests the same way for any value.
 */
export function streamUrl(deviceId, endpoint, params) {
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `/api/devices/${encodeURIComponent(deviceId)}/stream/${endpoint}?${query}`;
}
