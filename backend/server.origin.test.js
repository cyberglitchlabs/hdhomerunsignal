const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, socketHandshake, socketConnect, sleep } = require('./test-support');

describe('origin checks', () => {
  let server;
  let host;
  before(async () => {
    server = await startServer({ HDHR_ALLOWED_ORIGINS: 'https://dash.example, https://other.example' });
    host = `127.0.0.1:${server.port}`;
  });
  after(() => server.stop());

  const api = (origin) => request(server.port, {
    path: '/api/version',
    headers: origin === undefined ? {} : { Origin: origin }
  });

  describe('HTTP API', () => {
    test('a cross-origin request gets 403 and is not processed', async () => {
      const res = await request(server.port, {
        method: 'POST',
        path: '/api/devices/10.0.0.5/tuner/0/channel',
        headers: { Origin: 'https://evil.example' },
        body: { channel: '27' }
      });
      assert.equal(res.status, 403);
      assert.deepEqual(JSON.parse(res.body), { error: 'Origin not allowed' });
      assert.equal(res.headers['access-control-allow-origin'], undefined);
      assert.deepEqual(server.calls(), []);
    });

    test('lookalike and malformed origins get 403', async () => {
      for (const origin of [`http://${host}.evil.example`, `http://evil.example/${host}`, 'null', 'not a url', 'https://dash.example.evil.example']) {
        const res = await api(origin);
        assert.equal(res.status, 403, origin);
      }
    });

    test('same-origin requests get 200', async () => {
      assert.equal((await api(`http://${host}`)).status, 200);
    });

    test('requests without an Origin header get 200', async () => {
      assert.equal((await api(undefined)).status, 200);
    });

    test('an origin listed in HDHR_ALLOWED_ORIGINS gets 200 with CORS headers', async () => {
      for (const origin of ['https://dash.example', 'https://other.example']) {
        const res = await api(origin);
        assert.equal(res.status, 200, origin);
        assert.equal(res.headers['access-control-allow-origin'], origin);
        assert.equal(res.headers.vary, 'Origin');
      }
    });

    test('preflight is answered only for allowed origins', async () => {
      const ok = await request(server.port, { method: 'OPTIONS', path: '/api/version', headers: { Origin: 'https://dash.example' } });
      assert.equal(ok.status, 204);
      const bad = await request(server.port, { method: 'OPTIONS', path: '/api/version', headers: { Origin: 'https://evil.example' } });
      assert.equal(bad.status, 403);
    });
  });

  describe('Socket.IO handshake', () => {
    test('a cross-origin handshake is refused', async () => {
      const { res, sid } = await socketHandshake(server.port, { Origin: 'https://evil.example' });
      assert.equal(res.status, 403);
      assert.equal(sid, undefined);
    });

    test('a same-origin handshake is accepted', async () => {
      const { res, sid } = await socketHandshake(server.port, { Origin: `http://${host}` });
      assert.equal(res.status, 200);
      assert.ok(sid);
    });

    test('an allowlisted origin is accepted', async () => {
      const { res, sid } = await socketHandshake(server.port, { Origin: 'https://dash.example' });
      assert.equal(res.status, 200);
      assert.ok(sid);
    });

    test('a client without an Origin header is accepted', async () => {
      const { res, sid } = await socketHandshake(server.port);
      assert.equal(res.status, 200);
      assert.ok(sid);
    });

    test('a refused origin cannot start monitoring', async () => {
      const refused = await socketHandshake(server.port, { Origin: 'https://evil.example' });
      assert.equal(refused.res.status, 403);
      const attempt = await request(server.port, {
        method: 'POST',
        path: '/socket.io/?EIO=4&transport=polling&sid=forged',
        headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
        body: '42["start-monitoring",{"deviceId":"evilhost","tuner":0}]'
      });
      assert.notEqual(attempt.status, 200);
      await sleep(1300);
      assert.ok(!server.calls().some((c) => c[0] === 'evilhost'));
    });
  });
});

describe('origin checks without an allowlist', () => {
  test('only the same origin is accepted', async (t) => {
    const server = await startServer();
    t.after(() => server.stop());
    const get = (origin) => request(server.port, { path: '/api/version', headers: { Origin: origin } });
    assert.equal((await get(`http://127.0.0.1:${server.port}`)).status, 200);
    assert.equal((await get('https://dash.example')).status, 403);
    assert.equal((await socketHandshake(server.port, { Origin: 'https://dash.example' })).res.status, 403);
    const socket = await socketConnect(server.port);
    assert.ok(socket.sid);
  });
});
