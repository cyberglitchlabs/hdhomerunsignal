const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, spawnServer, request } = require('./test-support');

const statuses = async (server, count, options) => {
  const out = [];
  for (let i = 0; i < count; i++) out.push((await request(server.port, options)).status);
  return out;
};

describe('rate limiting', () => {
  test('requests over HDHR_RATE_LIMIT get 429', async (t) => {
    const server = await startServer({ HDHR_RATE_LIMIT: '5' });
    t.after(() => server.stop());
    assert.deepEqual(await statuses(server, 7, { path: '/api/v1/version' }), [200, 200, 200, 200, 200, 429, 429]);
    const res = await request(server.port, { path: '/api/v1/version' });
    assert.equal(res.status, 429);
    assert.deepEqual(JSON.parse(res.body), { error: 'Too many requests' });
  });

  test('scans have a stricter limit than the general one', async (t) => {
    const server = await startServer({ HDHR_RATE_LIMIT: '1000' });
    t.after(() => server.stop());
    const scan = { path: '/api/v1/devices/10.0.0.5/scan/0' };
    assert.deepEqual(await statuses(server, 8, scan), [200, 200, 200, 200, 200, 200, 429, 429]);
    // Other endpoints are unaffected, and the tool ran only for the allowed scans.
    assert.equal((await request(server.port, { path: '/api/v1/version' })).status, 200);
    assert.equal(server.calls().filter((c) => c[1] === 'scan').length, 6);
  });

  test('HDHR_RATE_LIMIT=0 disables both limiters', async (t) => {
    const server = await startServer({ HDHR_RATE_LIMIT: '0' });
    t.after(() => server.stop());
    assert.ok((await statuses(server, 10, { path: '/api/v1/devices/10.0.0.5/scan/0' })).every((s) => s === 200));
    assert.ok((await statuses(server, 20, { path: '/api/v1/version' })).every((s) => s === 200));
  });

  test('the default limit is 300 per minute', async (t) => {
    const server = await startServer({ HDHR_RATE_LIMIT: '' });
    t.after(() => server.stop());
    const results = await Promise.all(Array.from({ length: 305 }, () => request(server.port, { path: '/api/v1/version' })));
    assert.equal(results.filter((r) => r.status === 200).length, 300);
    assert.equal(results.filter((r) => r.status === 429).length, 5);
  });
});

describe('HDHR_TRUST_PROXY', () => {
  const xff = (ip) => ({ path: '/api/v1/version', headers: { 'X-Forwarded-For': ip } });

  test('with one trusted hop, each X-Forwarded-For client has its own bucket', async (t) => {
    const server = await startServer({ HDHR_RATE_LIMIT: '2', HDHR_TRUST_PROXY: '1' });
    t.after(() => server.stop());
    assert.deepEqual(await statuses(server, 3, xff('203.0.113.1')), [200, 200, 429]);
    assert.deepEqual(await statuses(server, 3, xff('203.0.113.2')), [200, 200, 429]);
    assert.deepEqual(await statuses(server, 1, xff('203.0.113.1')), [429]);
  });

  test('a list of proxy addresses works too', async (t) => {
    const server = await startServer({ HDHR_RATE_LIMIT: '1', HDHR_TRUST_PROXY: '127.0.0.1, ::1' });
    t.after(() => server.stop());
    assert.deepEqual(await statuses(server, 2, xff('203.0.113.1')), [200, 429]);
    assert.deepEqual(await statuses(server, 1, xff('203.0.113.2')), [200]);
  });

  test('unset: a spoofed X-Forwarded-For does not change the bucket', async (t) => {
    const server = await startServer({ HDHR_RATE_LIMIT: '2' });
    t.after(() => server.stop());
    const results = [];
    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '198.51.100.7']) {
      results.push((await request(server.port, xff(ip))).status);
    }
    assert.deepEqual(results, [200, 200, 429, 429]);
  });

  for (const value of ['true', 'false', '0', '33', '-1', '1.5', 'loopback', '0.0.0.0/0', '::/0', '10.0.0.0/0', '10.0.0.0/33', 'not-an-ip', '127.0.0.1,', '1/2/3']) {
    test(`invalid value ${JSON.stringify(value)} stops the server with exit status 1`, async () => {
      const server = spawnServer({ HDHR_TRUST_PROXY: value });
      const { code } = await server.exited;
      assert.equal(code, 1, server.output());
      assert.match(server.output(), /Invalid HDHR_TRUST_PROXY/);
      server.cleanup();
    });
  }
});
