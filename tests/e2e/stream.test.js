const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, openStream, request, sleep, waitFor } = require('./test-support');

describe('event streams', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.stop());

  const callsFor = (device) => server.calls().filter((c) => c[0] === device).length;

  test('a tuner subscription is an SSE response that pushes tuner-status', async (t) => {
    const stream = await openStream(server.port, '/api/v1/devices/stream1/tuner/1/stream');
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
    const stream = await openStream(server.port, '/api/v1/devices/stream2/antenna/stream?tuners=3');
    t.after(() => stream.close());
    assert.equal(stream.status, 200);

    await waitFor(() => stream.events.length > 0, { timeout: 5000 });
    const { event, data } = stream.events[0];
    assert.equal(event, 'antenna-mode-status');
    assert.deepEqual(data.map((d) => d.tuner), [0, 1, 2]);
    assert.ok(data.every((d) => d.status));
  });

  test('closing the connection stops monitoring', async () => {
    const stream = await openStream(server.port, '/api/v1/devices/stream3/tuner/0/stream');
    await waitFor(() => callsFor('stream3') > 0, { timeout: 5000 });
    stream.close();
    await stream.closed;
    await sleep(300); // a tick that was already in flight may still finish
    const settled = callsFor('stream3');
    await sleep(1500);
    assert.equal(callsFor('stream3'), settled);
  });

  test('closing one stream leaves another on the same device running', async (t) => {
    const a = await openStream(server.port, '/api/v1/devices/stream4/tuner/0/stream');
    const b = await openStream(server.port, '/api/v1/devices/stream4/tuner/1/stream');
    t.after(() => { a.close(); b.close(); });
    await waitFor(() => a.events.length > 0 && b.events.length > 0, { timeout: 5000 });
    a.close();
    await a.closed;
    const before = b.events.length;
    await waitFor(() => b.events.length > before, { timeout: 5000 });
  });

  test('the first reading arrives right away, not after a full interval', async (t) => {
    const stream = await openStream(server.port, '/api/v1/devices/stream5/tuner/0/stream');
    t.after(() => stream.close());
    await waitFor(() => stream.events.length > 0, { timeout: 700, interval: 10 });
  });
});

describe('event streams with a slow tuner', () => {
  test('a poll that has not finished is never overlapped by the next one', async (t) => {
    // One tick makes two sequential tool calls (status, then program), 1.2 s each.
    const server = await startServer({ FAKE_HDHR_DELAY_MS: '1200' });
    t.after(() => server.stop());
    const stream = await openStream(server.port, '/api/v1/devices/slow1/tuner/0/stream');
    t.after(() => stream.close());
    await sleep(3500);
    // Overlapping ticks would have started a status call every second (4 by now).
    const statusCalls = server.calls().filter((c) => /\/status$/.test(c[2])).length;
    assert.ok(statusCalls <= 2, `${statusCalls} status calls in 3.5 s`);
  });
});

describe('event stream limits', () => {
  test('streams are not counted against the request rate limit', async (t) => {
    const server = await startServer({ HDHR_RATE_LIMIT: '2' });
    t.after(() => server.stop());
    // EventSource never retries after a 429, so reconnecting must always work.
    for (let i = 0; i < 6; i++) {
      const stream = await openStream(server.port, '/api/v1/devices/limit1/tuner/0/stream');
      assert.equal(stream.status, 200, `connection ${i}`);
      stream.close();
      await stream.closed;
    }
    // Ordinary requests are still limited.
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await request(server.port, { path: '/api/v1/version' })).status);
    assert.ok(statuses.includes(429), statuses.join());
  });

  test('a client can only hold so many streams at once, and closing one frees a slot', async (t) => {
    const server = await startServer({ HDHR_MAX_STREAMS_PER_CLIENT: '2' });
    t.after(() => server.stop());
    const open = () => openStream(server.port, '/api/v1/devices/limit2/tuner/0/stream');
    const a = await open();
    const b = await open();
    t.after(() => { a.close(); b.close(); });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);

    const refused = await open();
    assert.equal(refused.status, 429);

    a.close();
    await a.closed;
    // The server notices the close asynchronously, so allow a moment.
    let reopened;
    for (let i = 0; i < 40 && !(reopened && reopened.status === 200); i++) {
      if (reopened) await sleep(50);
      reopened = await open();
    }
    t.after(() => reopened.close());
    assert.equal(reopened.status, 200);
  });

  test('HDHR_MAX_STREAMS_PER_CLIENT=0 removes the cap', async (t) => {
    const server = await startServer({ HDHR_MAX_STREAMS_PER_CLIENT: '0' });
    const streams = [];
    t.after(async () => { streams.forEach((s) => s.close()); await server.stop(); });
    for (let i = 0; i < 20; i++) streams.push(await openStream(server.port, '/api/v1/devices/limit3/tuner/0/stream'));
    assert.ok(streams.every((s) => s.status === 200));
  });
});
