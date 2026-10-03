const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, openStream, sleep, waitFor } = require('./test-support');

describe('event streams', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.stop());

  const callsFor = (device) => server.calls().filter((c) => c[0] === device).length;

  test('a tuner subscription is an SSE response that pushes tuner-status', async (t) => {
    const stream = await openStream(server.port, '/api/devices/stream1/tuner/1/stream');
    t.after(() => stream.close());
    assert.equal(stream.status, 200);
    assert.match(stream.headers['content-type'], /^text\/event-stream/);
    assert.match(stream.headers['cache-control'], /no-cache/);
    assert.equal(stream.headers['x-accel-buffering'], 'no');

    await waitFor(() => stream.events.length > 0, { timeout: 5000 });
    const { event, data } = stream.events[0];
    assert.equal(event, 'tuner-status');
    assert.equal(data.lock, true);
    assert.ok('currentProgram' in data && 'plpInfo' in data && 'l1Info' in data);
    // Only the requested tuner is polled.
    for (const call of server.calls().filter((c) => c[0] === 'stream1')) assert.match(call[2], /^\/tuner1\//);
  });

  test('an antenna subscription pushes antenna-mode-status for every tuner', async (t) => {
    const stream = await openStream(server.port, '/api/devices/stream2/antenna/stream?tuners=3');
    t.after(() => stream.close());
    assert.equal(stream.status, 200);

    await waitFor(() => stream.events.length > 0, { timeout: 5000 });
    const { event, data } = stream.events[0];
    assert.equal(event, 'antenna-mode-status');
    assert.deepEqual(data.map((d) => d.tuner), [0, 1, 2]);
    assert.ok(data.every((d) => d.status));
  });

  test('closing the connection stops monitoring', async () => {
    const stream = await openStream(server.port, '/api/devices/stream3/tuner/0/stream');
    await waitFor(() => callsFor('stream3') > 0, { timeout: 5000 });
    stream.close();
    await stream.closed;
    await sleep(300); // a tick that was already in flight may still finish
    const settled = callsFor('stream3');
    await sleep(1500);
    assert.equal(callsFor('stream3'), settled);
  });

  test('closing one stream leaves another on the same device running', async (t) => {
    const a = await openStream(server.port, '/api/devices/stream4/tuner/0/stream');
    const b = await openStream(server.port, '/api/devices/stream4/tuner/1/stream');
    t.after(() => { a.close(); b.close(); });
    await waitFor(() => a.events.length > 0 && b.events.length > 0, { timeout: 5000 });
    a.close();
    await a.closed;
    const before = b.events.length;
    await waitFor(() => b.events.length > before, { timeout: 5000 });
  });
});
