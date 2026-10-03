const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, openStream, request, sleep } = require('./test-support');

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

  test('SIGTERM exits 0 quickly with live event streams and running monitors', async (t) => {
    const server = await startServer();
    t.after(() => server.stop());

    const tuner = await openStream(server.port, '/api/devices/10.0.0.5/tuner/0/stream');
    const antenna = await openStream(server.port, '/api/devices/10.0.0.5/antenna/stream?tuners=2');
    assert.equal(tuner.status, 200);
    assert.equal(antenna.status, 200);
    await sleep(200); // let the monitors start

    const started = Date.now();
    server.proc.kill('SIGTERM');
    const { code } = await withTimeout(server.exited, 3000, 'shutdown');
    assert.equal(code, 0, server.output());
    assert.ok(Date.now() - started < 3000);
    await withTimeout(Promise.all([tuner.closed, antenna.closed]), 1000, 'client connection close');
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
