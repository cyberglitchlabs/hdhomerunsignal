const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, openStream, sleep, waitFor } = require('./test-support');

const DEV = '10.0.0.5';
const enc = encodeURIComponent;

describe('API: injection attempts never reach hdhomerun_config', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.stop());
  beforeEach(() => server.clearCalls());

  const badDevices = ['-h', '--help', 'a;id', '$(id)', '`id`', 'a b', 'a|b', 'a&b', 'a\nb', '-1', '.hidden', 'x'.repeat(254)];
  const badTuners = ['8', '-1', '1;2', 'x', '1.5', '01', '$(id)'];
  const badChannels = ['27;id', '$(id)', '-h', '--help', 'auto:27 x', '27\nset', 'a'.repeat(50), '', 'atsc3:27:0+1+', 27, { a: 1 }, ['27'], null];

  const deviceRoutes = [
    ['GET', (d) => `/api/v1/devices/${enc(d)}/info`],
    ['GET', (d) => `/api/v1/devices/${enc(d)}/channelmaps?tuners=2`],
    ['GET', (d) => `/api/v1/devices/${enc(d)}/scan/0`],
    ['GET', (d) => `/api/v1/devices/${enc(d)}/tuner/0/status`],
    ['GET', (d) => `/api/v1/devices/${enc(d)}/tuner/0/programs`],
    ['POST', (d) => `/api/v1/devices/${enc(d)}/tuner/0/channel`, { channel: '27' }],
    ['POST', (d) => `/api/v1/devices/${enc(d)}/tuner/0/channel/up`],
    ['POST', (d) => `/api/v1/devices/${enc(d)}/tuner/0/channel/down`],
    ['POST', (d) => `/api/v1/devices/${enc(d)}/tuner/0/clear`],
    ['GET', (d) => `/api/v1/devices/${enc(d)}/tuner/0/plpinfo`],
    ['GET', (d) => `/api/v1/devices/${enc(d)}/tuner/0/l1info`],
    ['POST', (d) => `/api/v1/devices/${enc(d)}/tuner/0/atsc3`, { channel: '27' }],
    ['GET', (d) => `/api/v1/devices/${enc(d)}/stream/url?ch=27&program=1`],
    ['GET', (d) => `/api/v1/devices/${enc(d)}/stream/play.m3u?ch=27&program=1`]
  ];

  test('device id', async () => {
    for (const device of badDevices) {
      for (const [method, url, body] of deviceRoutes) {
        const res = await request(server.port, { method, path: url(device), body });
        assert.equal(res.status, 400, `${method} ${url(device)} -> ${res.status}`);
      }
    }
    assert.deepEqual(server.calls(), []);
  });

  test('tuner', async () => {
    const tunerRoutes = [
      ['GET', 'scan/{t}'], ['GET', 'tuner/{t}/status'], ['GET', 'tuner/{t}/programs'],
      ['POST', 'tuner/{t}/channel', { channel: '27' }], ['POST', 'tuner/{t}/channel/up'],
      ['POST', 'tuner/{t}/channel/down'], ['POST', 'tuner/{t}/clear'],
      ['GET', 'tuner/{t}/plpinfo'], ['GET', 'tuner/{t}/l1info'],
      ['POST', 'tuner/{t}/atsc3', { channel: '27' }]
    ];
    for (const tuner of badTuners) {
      for (const [method, tail, body] of tunerRoutes) {
        const url = `/api/v1/devices/${DEV}/${tail.replace('{t}', enc(tuner))}`;
        const res = await request(server.port, { method, path: url, body });
        assert.equal(res.status, 400, `${method} ${url} -> ${res.status}`);
      }
    }
    assert.deepEqual(server.calls(), []);
  });

  test('channelMap', async () => {
    for (const map of ['us-bcast;id', '--help', '$(id)', 'xx', 'US-BCAST', '', 'us-bcast us-cable']) {
      const res = await request(server.port, { path: `/api/v1/devices/${DEV}/scan/0?channelMap=${enc(map)}` });
      assert.equal(res.status, 400, `channelMap=${JSON.stringify(map)} -> ${res.status}`);
    }
    // Repeated parameters arrive as an array, which is not a channel map either.
    const dup = await request(server.port, { path: `/api/v1/devices/${DEV}/scan/0?channelMap=us-bcast&channelMap=us-cable` });
    assert.equal(dup.status, 400);
    assert.deepEqual(server.calls(), []);
  });

  test('channel body', async () => {
    for (const channel of badChannels) {
      const res = await request(server.port, {
        method: 'POST', path: `/api/v1/devices/${DEV}/tuner/0/channel`, body: { channel }
      });
      assert.equal(res.status, 400, `channel=${JSON.stringify(channel)} -> ${res.status}`);
    }
    const noBody = await request(server.port, { method: 'POST', path: `/api/v1/devices/${DEV}/tuner/0/channel`, body: '{}' });
    assert.equal(noBody.status, 400);
    assert.deepEqual(server.calls(), []);
  });

  test('atsc3 body', async () => {
    for (const body of [
      { channel: '27;id' }, { channel: '27', plps: 'x' }, { channel: '27', plps: ['1;2'] },
      { channel: '27', plps: [256] }, { channel: '27', plps: [-1] }, { channel: '27', plps: new Array(65).fill(1) }, {}
    ]) {
      const res = await request(server.port, { method: 'POST', path: `/api/v1/devices/${DEV}/tuner/0/atsc3`, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(server.calls(), []);
  });

  test('oversized JSON body is rejected', async () => {
    const res = await request(server.port, {
      method: 'POST', path: `/api/v1/devices/${DEV}/tuner/0/channel`, body: { channel: '27', pad: 'x'.repeat(20000) }
    });
    assert.equal(res.status, 413);
    assert.deepEqual(server.calls(), []);
  });

  test('event stream subscriptions with bad parameters', async () => {
    const enc = encodeURIComponent;
    const bad = [
      `/api/v1/devices/-h/tuner/0/stream`,
      `/api/v1/devices/${enc('a;id')}/tuner/0/stream`,
      `/api/v1/devices/${enc('$(id)')}/tuner/0/stream`,
      `/api/v1/devices/badtuner1/tuner/8/stream`,
      `/api/v1/devices/badtuner2/tuner/${enc('1;2')}/stream`,
      `/api/v1/devices/badtuner3/tuner/-1/stream`,
      `/api/v1/devices/-h/antenna/stream?tuners=2`,
      `/api/v1/devices/${enc('a;id')}/antenna/stream?tuners=2`,
      `/api/v1/devices/count0/antenna/stream?tuners=0`,
      `/api/v1/devices/count9/antenna/stream?tuners=9`,
      `/api/v1/devices/countfrac/antenna/stream?tuners=1.5`,
      `/api/v1/devices/countnan/antenna/stream?tuners=x`,
      `/api/v1/devices/countnone/antenna/stream`
    ];
    for (const path of bad) {
      const stream = await openStream(server.port, path);
      assert.equal(stream.status, 400, path);
      assert.equal(stream.headers['content-type'].split(';')[0], 'application/json', path);
    }
    // A valid subscription last. Once its tool calls show up, the earlier
    // tick(s) of any wrongly accepted subscription have had time to run as well.
    const good = await openStream(server.port, '/api/v1/devices/good1/tuner/2/stream');
    assert.equal(good.status, 200);
    await waitFor(() => server.calls().some((c) => c[0] === 'good1'), { timeout: 5000 });
    await sleep(300);
    good.close();

    const calls = server.calls();
    assert.ok(calls.length > 0);
    assert.deepEqual([...new Set(calls.map((c) => c[0]))], ['good1']);
    for (const call of calls) assert.match(call[2], /^\/tuner2\//);
  });
});

describe('API: legitimate requests reach the tool with exact arguments', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.stop());
  beforeEach(() => server.clearCalls());

  const post = (path, body) => request(server.port, { method: 'POST', path, body });

  test('set channel (including ATSC 3.0 and special values)', async () => {
    for (const channel of ['27', 'auto:27', '8vsb:27', 'qam256:117', 'auto:575000000', 'atsc3:27:0+1+2', 'none', '+', '-']) {
      server.clearCalls();
      const res = await post(`/api/v1/devices/${DEV}/tuner/2/channel`, { channel });
      assert.equal(res.status, 200, channel);
      assert.deepEqual(server.calls(), [[DEV, 'set', '/tuner2/channel', channel]]);
    }
  });

  test('channel up, down and clear', async () => {
    await post(`/api/v1/devices/1080ABCD/tuner/1/channel/up`);
    await post(`/api/v1/devices/1080ABCD/tuner/1/channel/down`);
    await post(`/api/v1/devices/1080ABCD/tuner/1/clear`);
    assert.deepEqual(server.calls(), [
      ['1080ABCD', 'set', '/tuner1/channel', '+'],
      ['1080ABCD', 'set', '/tuner1/channel', '-'],
      ['1080ABCD', 'set', '/tuner1/channel', 'none']
    ]);
  });

  test('atsc3 builds the channel string from validated parts', async () => {
    const res = await post(`/api/v1/devices/${DEV}/tuner/0/atsc3`, { channel: '27', plps: [0, '1', 2] });
    assert.equal(res.status, 200);
    assert.deepEqual(server.calls(), [[DEV, 'set', '/tuner0/channel', 'atsc3:27:0+1+2']]);

    server.clearCalls();
    await post(`/api/v1/devices/${DEV}/tuner/0/atsc3`, { channel: '27' });
    assert.deepEqual(server.calls(), [[DEV, 'set', '/tuner0/channel', 'atsc3:27']]);
  });

  test('scan', async () => {
    let res = await request(server.port, { path: `/api/v1/devices/${DEV}/scan/1` });
    assert.equal(res.status, 200);
    assert.deepEqual(server.calls(), [[DEV, 'scan', '/tuner1', 'us-bcast']]);

    server.clearCalls();
    res = await request(server.port, { path: `/api/v1/devices/${DEV}/scan/3?channelMap=eu-cable` });
    assert.equal(res.status, 200);
    assert.deepEqual(server.calls(), [[DEV, 'scan', '/tuner3', 'eu-cable']]);
  });

  test('tuner status', async () => {
    const res = await request(server.port, { path: `/api/v1/devices/${DEV}/tuner/0/status` });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).channel, '8vsb:27');
    assert.deepEqual(server.calls().map((c) => c.slice(0, 3)).sort(), [
      [DEV, 'get', '/tuner0/debug'],
      [DEV, 'get', '/tuner0/status']
    ]);
  });

  test('device info', async () => {
    const res = await request(server.port, { path: `/api/v1/devices/example-host.local/info` });
    assert.equal(res.status, 200);
    const calls = server.calls();
    assert.deepEqual(calls[0], ['example-host.local', 'get', '/sys/model']);
    for (const call of calls.slice(1)) assert.match(call.join(' '), /^example-host\.local get \/tuner[0-7]\/status$/);
  });
});

describe('API: channel maps', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.stop());
  beforeEach(() => server.clearCalls());

  test('each tuner\'s map is read from the device and nothing is set', async () => {
    const res = await request(server.port, { path: '/api/v1/devices/example-host.local/channelmaps?tuners=2' });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), ['us-cable', 'us-cable']);
    const calls = server.calls().map((call) => call.join(' ')).sort();
    assert.deepEqual(calls, [
      'example-host.local get /tuner0/channelmap',
      'example-host.local get /tuner1/channelmap'
    ]);
  });

  test('the tuner count must be 1 to 8', async () => {
    for (const tuners of ['', '?tuners=0', '?tuners=9', '?tuners=x']) {
      const res = await request(server.port, { path: `/api/v1/devices/example-host.local/channelmaps${tuners}` });
      assert.equal(res.status, 400, tuners);
    }
    assert.deepEqual(server.calls(), []);
  });
});

describe('API: M3U playlist', () => {
  let server;
  before(async () => {
    server = await startServer({ HDHOMERUN_DEVICES: DEV });
    // Load the configured device into the controller.
    const res = await request(server.port, { path: '/api/v1/devices' });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body)[0].id, DEV);
  });
  after(() => server.stop());

  test('a plain request produces the expected playlist', async () => {
    const res = await request(server.port, { path: '/api/v1/devices/10.0.0.5/stream/play.m3u?ch=27&program=3&name=KQED' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^audio\/x-mpegurl\b/);
    assert.equal(res.headers['content-disposition'], 'attachment; filename="KQED.m3u"');
    assert.equal(res.body, '#EXTM3U\n#EXTINF:-1,KQED\nhttp://10.0.0.5:5004/auto/ch27-3\n');
  });

  test('a newline in name cannot add playlist lines', async () => {
    const evil = 'x\r\n#EXTINF:-1,evil\r\nhttp://evil.example/stream\n';
    const res = await request(server.port, {
      path: `/api/v1/devices/${DEV}/stream/play.m3u?ch=27&program=3&name=${enc(evil)}`
    });
    assert.equal(res.status, 200);
    const lines = res.body.split('\n').filter(Boolean);
    assert.equal(lines.length, 3, res.body);
    assert.equal(lines[0], '#EXTM3U');
    assert.match(lines[1], /^#EXTINF:-1,[^\r\n]*$/);
    assert.equal(lines[2], 'http://10.0.0.5:5004/auto/ch27-3');
    assert.ok(!res.body.includes('\r'));
    assert.ok(!res.headers['content-disposition'].match(/[\r\n]/));
  });

  test('non-numeric ch or program is rejected; unknown device is 404', async () => {
    for (const query of ['ch=27;id&program=1', 'ch=27&program=a', 'ch=27', 'program=1']) {
      const res = await request(server.port, { path: `/api/v1/devices/${DEV}/stream/play.m3u?${query}` });
      assert.equal(res.status, 400, query);
    }
    const res = await request(server.port, { path: '/api/v1/devices/10.9.9.9/stream/play.m3u?ch=27&program=1' });
    assert.equal(res.status, 404);
  });
});
