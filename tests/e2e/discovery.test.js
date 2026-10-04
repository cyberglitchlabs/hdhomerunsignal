const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request } = require('./test-support');

// The cloud lookup is pointed at a local stub, so it shows up as a request path.
const CLOUD_URL = '/discover';

// Refreshes the device list (force=true is the explicit user refresh that is
// allowed to use the cloud fallback) and returns what the server did.
async function refresh(env) {
  const server = await startServer({ HDHOMERUN_DISABLE_DISCOVERY: '', ...env });
  try {
    const res = await request(server.port, { path: '/api/v1/devices?force=true' });
    assert.equal(res.status, 200);
    return {
      devices: JSON.parse(res.body),
      broadcasts: server.calls().filter((c) => c[0] === 'discover' && c.length === 1).length,
      cloud: server.cloudCalls(),
      output: server.output()
    };
  } finally {
    await server.stop();
  }
}

describe('cloud discovery fallback', () => {
  test('is used by default when the broadcast finds nothing', async () => {
    const result = await refresh({});
    assert.equal(result.broadcasts, 1);
    assert.deepEqual(result.cloud, [CLOUD_URL]);
  });

  test('HDHR_DISABLE_CLOUD_DISCOVERY=true skips the cloud lookup but keeps the broadcast', async () => {
    const result = await refresh({ HDHR_DISABLE_CLOUD_DISCOVERY: 'true' });
    assert.equal(result.broadcasts, 1);
    assert.deepEqual(result.cloud, []);
    assert.deepEqual(result.devices, []);
    assert.match(result.output, /cloud discovery disabled via HDHR_DISABLE_CLOUD_DISCOVERY/);
  });

  test('any other value leaves the fallback on', async () => {
    for (const value of ['false', '0', 'TRUE', 'yes']) {
      const result = await refresh({ HDHR_DISABLE_CLOUD_DISCOVERY: value });
      assert.deepEqual(result.cloud, [CLOUD_URL], value);
    }
  });

  test('is not needed, and not used, when the broadcast finds a device', async () => {
    const result = await refresh({
      FAKE_DISCOVER_OUTPUT: 'hdhomerun device 1080ABCD found at 192.168.1.50'
    });
    assert.deepEqual(result.cloud, []);
    assert.equal(result.devices[0].id, '1080ABCD');
  });

  test('disabling cloud discovery does not stop the broadcast from finding devices', async () => {
    const result = await refresh({
      HDHR_DISABLE_CLOUD_DISCOVERY: 'true',
      FAKE_DISCOVER_OUTPUT: 'hdhomerun device 1080ABCD found at 192.168.1.50'
    });
    assert.equal(result.devices[0].id, '1080ABCD');
    assert.deepEqual(result.cloud, []);
  });

  test('HDHOMERUN_DISABLE_DISCOVERY=true still turns off both', async () => {
    const result = await refresh({ HDHOMERUN_DISABLE_DISCOVERY: 'true' });
    assert.equal(result.broadcasts, 0);
    assert.deepEqual(result.cloud, []);
  });
});
