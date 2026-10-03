// Shared helpers for the server integration tests: start the real server in a
// child process with a fake `hdhomerun_config` first on PATH that records every
// invocation, and make plain HTTP requests against it.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// Records its arguments as one JSON array per line and answers just enough for
// the server's parsers to be happy. It never talks to a network.
const FAKE_TOOL = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_HDHR_LOG, JSON.stringify(args) + '\\n');
const target = args[1] === 'get' || args[1] === 'set' ? args[2] : '';
if (args[0] === 'discover' && args.length === 1) { if (process.env.FAKE_DISCOVER_OUTPUT) console.log(process.env.FAKE_DISCOVER_OUTPUT); }
else if (target === '/sys/model') console.log('HDHR5-4US');
else if (target === '/sys/hwmodel') console.log('HDHR5-4US');
else if (/\\/status$/.test(target)) console.log('ch=8vsb:27 lock=8vsb ss=90 snq=80 seq=100 bps=0 pps=0');
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeout = 5000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(interval);
  }
}

function makeFakeTool() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdhr-test-'));
  const bin = path.join(dir, 'hdhomerun_config');
  fs.writeFileSync(bin, FAKE_TOOL, { mode: 0o755 });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  const httpsLog = path.join(dir, 'https.log');
  fs.writeFileSync(httpsLog, '');
  return { dir, log, httpsLog };
}

function spawnServer(env = {}) {
  const tool = makeFakeTool();
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      PATH: `${tool.dir}${path.delimiter}${process.env.PATH}`,
      FAKE_HDHR_LOG: tool.log,
      // The server never reaches the network under test; see test-https-stub.js.
      FAKE_HTTPS_LOG: tool.httpsLog,
      NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, 'test-https-stub.js'))}`,
      PORT: '0',
      HDHOMERUN_DISABLE_DISCOVERY: 'true',
      HDHR_DISABLE_CLOUD_DISCOVERY: '',
      HDHR_RATE_LIMIT: '0',
      HDHR_TRUST_PROXY: '',
      HDHR_ALLOWED_ORIGINS: '',
      HDHOMERUN_DEVICES: '',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  proc.stdout.on('data', (chunk) => { output += chunk; });
  proc.stderr.on('data', (chunk) => { output += chunk; });

  const exited = new Promise((resolve) => {
    proc.on('exit', (code, signal) => resolve({ code, signal }));
  });

  const calls = () => fs.readFileSync(tool.log, 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));

  const httpsCalls = () => fs.readFileSync(tool.httpsLog, 'utf8').split('\n').filter(Boolean);

  // Resolves with the bound port, or rejects if the server exits first.
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 10000);
    const check = () => {
      const match = /running on port (\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    proc.stdout.on('data', check);
    exited.then(({ code }) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}: ${output}`));
    });
  });
  ready.catch(() => {}); // callers that only watch for exit must not trigger unhandledRejection

  const cleanup = () => fs.rmSync(tool.dir, { recursive: true, force: true });

  return {
    proc,
    exited,
    ready,
    output: () => output,
    calls,
    httpsCalls,
    clearCalls: () => fs.writeFileSync(tool.log, ''),
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      await exited;
      cleanup();
    },
    cleanup
  };
}

// Starts the server and resolves once it is listening.
async function startServer(env) {
  const server = spawnServer(env);
  try {
    server.port = await server.ready;
  } catch (err) {
    await server.stop();
    throw err;
  }
  return server;
}

// Minimal HTTP client: unlike fetch it lets a test set Origin and Host freely.
function request(port, { method = 'GET', path: urlPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined
      : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      agent: false,
      headers: {
        ...(payload !== undefined && { 'Content-Type': 'application/json' }),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// Socket.IO over plain HTTP long-polling, so no client library is needed.
// Packets are Engine.IO v4: "0{...}" open, "40" connect, "42[...]" event.
const SIO = '/socket.io/?EIO=4&transport=polling';

async function socketHandshake(port, headers = {}) {
  const res = await request(port, { path: `${SIO}&t=${Date.now()}`, headers });
  if (res.status !== 200) return { res };
  const open = JSON.parse(res.body.slice(res.body.indexOf('{')));
  return { res, sid: open.sid };
}

// Opens a polling session, connects to the default namespace and returns a
// function that emits events on it.
async function socketConnect(port) {
  const { res, sid } = await socketHandshake(port);
  if (!sid) throw new Error(`Socket.IO handshake failed with ${res.status}`);
  const url = `${SIO}&sid=${sid}`;
  await request(port, { method: 'POST', path: url, body: '40', headers: { 'Content-Type': 'text/plain' } });
  await request(port, { path: url }); // read the namespace connect packet
  return {
    sid,
    emit: (event, payload) => request(port, {
      method: 'POST',
      path: url,
      body: `42${JSON.stringify([event, payload])}`,
      headers: { 'Content-Type': 'text/plain' }
    })
  };
}

module.exports = { startServer, spawnServer, request, socketHandshake, socketConnect, sleep, waitFor, SIO };
