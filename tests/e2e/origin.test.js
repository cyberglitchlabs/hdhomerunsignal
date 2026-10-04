const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, openStream, sleep } = require('./test-support');

describe('origin checks', () => {
  let server;
  let host;
  before(async () => {
    server = await startServer({ HDHR_ALLOWED_ORIGINS: 'https://dash.example, https://other.example' });
    host = `127.0.0.1:${server.port}`;
  });
  after(() => server.stop());

  const api = (origin) => request(server.port, {
    path: '/api/v1/version',
    headers: origin === undefined ? {} : { Origin: origin }
  });

  describe('HTTP API', () => {
    test('a cross-origin request gets 403 and is not processed', async () => {
      const res = await request(server.port, {
        method: 'POST',
        path: '/api/v1/devices/10.0.0.5/tuner/0/channel',
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
      const ok = await request(server.port, { method: 'OPTIONS', path: '/api/v1/version', headers: { Origin: 'https://dash.example' } });
      assert.equal(ok.status, 204);
      const bad = await request(server.port, { method: 'OPTIONS', path: '/api/v1/version', headers: { Origin: 'https://evil.example' } });
      assert.equal(bad.status, 403);
    });
  });

  describe('event streams', () => {
    const STREAM = '/api/v1/devices/10.0.0.5/tuner/0/stream';
    const open = async (origin) => {
      const stream = await openStream(server.port, STREAM, { headers: origin === undefined ? {} : { Origin: origin } });
      stream.close();
      return stream;
    };

    test('a cross-origin subscription is refused', async () => {
      const stream = await open('https://evil.example');
      assert.equal(stream.status, 403);
    });

    test('a same-origin subscription is accepted', async () => {
      assert.equal((await open(`http://${host}`)).status, 200);
    });

    test('an allowlisted origin is accepted', async () => {
      assert.equal((await open('https://dash.example')).status, 200);
    });

    test('a client without an Origin header is accepted', async () => {
      assert.equal((await open()).status, 200);
    });

    test('a refused origin cannot start monitoring', async () => {
      const stream = await openStream(server.port, '/api/v1/devices/evilhost/tuner/0/stream', { headers: { Origin: 'https://evil.example' } });
      assert.equal(stream.status, 403);
      await sleep(1300);
      assert.ok(!server.calls().some((c) => c[0] === 'evilhost'));
    });
  });
});

describe('origin checks without an allowlist', () => {
  test('only the same origin is accepted', async (t) => {
    const server = await startServer();
    t.after(() => server.stop());
    const get = (origin) => request(server.port, { path: '/api/v1/version', headers: { Origin: origin } });
    assert.equal((await get(`http://127.0.0.1:${server.port}`)).status, 200);
    assert.equal((await get('https://dash.example')).status, 403);
    const refused = await openStream(server.port, '/api/v1/devices/10.0.0.5/tuner/0/stream', { headers: { Origin: 'https://dash.example' } });
    assert.equal(refused.status, 403);
    const accepted = await openStream(server.port, '/api/v1/devices/10.0.0.5/tuner/0/stream');
    accepted.close();
    assert.equal(accepted.status, 200);
  });
});
