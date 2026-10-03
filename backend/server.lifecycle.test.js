const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, socketHandshake, SIO, request, sleep } = require('./test-support');

const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms))
]);

describe('graceful shutdown', () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    test(`${signal} exits 0 quickly when idle`, async (t) => {
      const server = await startServer();
      t.after(() => server.stop());
      assert.equal((await request(server.port, { path: '/api/version' })).status, 200);
      const started = Date.now();
      server.proc.kill(signal);
      const { code } = await withTimeout(server.exited, 3000, 'shutdown');
      assert.equal(code, 0, server.output());
      assert.ok(Date.now() - started < 3000);
      assert.match(server.output(), new RegExp(`${signal} received`));
    });
  }

  test('SIGTERM exits 0 quickly with a live socket.io long-poll connection and a running monitor', async (t) => {
    const server = await startServer();
    t.after(() => server.stop());

    // Open a session, start monitoring, then leave a long-poll request hanging.
    const { sid } = await socketHandshake(server.port);
    const url = `${SIO}&sid=${sid}`;
    const plain = { 'Content-Type': 'text/plain' };
    await request(server.port, { method: 'POST', path: url, body: '40', headers: plain });
    await request(server.port, { path: url });
    await request(server.port, {
      method: 'POST', path: url, headers: plain,
      body: '42["start-monitoring",{"deviceId":"10.0.0.5","tuner":0}]'
    });

    const closed = new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: server.port, path: url, agent: new http.Agent({ keepAlive: true }) });
      req.on('response', (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve); });
      req.on('error', resolve);
    });
    await sleep(200); // let the poll reach the server

    const started = Date.now();
    server.proc.kill('SIGTERM');
    const { code } = await withTimeout(server.exited, 3000, 'shutdown');
    assert.equal(code, 0, server.output());
    assert.ok(Date.now() - started < 3000);
    await withTimeout(closed, 1000, 'client connection close');
  });

  test('a second signal while shutting down is ignored', async (t) => {
    const server = await startServer();
    t.after(() => server.stop());
    server.proc.kill('SIGTERM');
    server.proc.kill('SIGTERM');
    const { code } = await withTimeout(server.exited, 3000, 'shutdown');
    assert.equal(code, 0);
  });
});
