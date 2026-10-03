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
  return { dir, log };
}

// The server under test: `node server.js` by default, or any other backend
// implementing the same HTTP contract via SERVER_CMD (a command and optional
// arguments separated by spaces, e.g. SERVER_CMD=target/debug/hdhr-server). It
// must print "running on port <n>" once listening; that is how tests find it.
function serverCommand() {
  const [cmd, ...args] = (process.env.SERVER_CMD || '').split(/\s+/).filter(Boolean);
  return cmd ? [cmd, args] : [process.execPath, [path.join(__dirname, 'server.js')]];
}

// Unroutable: nothing under test may reach the real cloud lookup. startServer
// swaps in a local stub that records the requests instead.
const NO_CLOUD_URL = 'http://127.0.0.1:9/discover';

function spawnServer(env = {}) {
  const tool = makeFakeTool();
  const [cmd, args] = serverCommand();
  const proc = spawn(cmd, args, {
    env: {
      ...process.env,
      PATH: `${tool.dir}${path.delimiter}${process.env.PATH}`,
      FAKE_HDHR_LOG: tool.log,
      HDHR_CLOUD_DISCOVERY_URL: NO_CLOUD_URL,
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
    clearCalls: () => fs.writeFileSync(tool.log, ''),
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      await exited;
      cleanup();
    },
    cleanup
  };
}

// Local stand-in for the cloud discovery API: answers with an empty device list
// and records the path of every request.
async function startCloudStub() {
  const calls = [];
  const stub = http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end('[]');
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  return { calls, url: `http://127.0.0.1:${stub.address().port}/discover`, close: () => stub.close() };
}

// Starts the server and resolves once it is listening. server.cloudCalls()
// lists the request paths it sent to the cloud discovery stub.
async function startServer(env) {
  const stub = await startCloudStub();
  const server = spawnServer({ HDHR_CLOUD_DISCOVERY_URL: stub.url, ...env });
  server.cloudCalls = () => [...stub.calls];
  const stop = server.stop;
  server.stop = async () => { await stop(); stub.close(); };
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

// Opens a Server-Sent Events subscription and collects what arrives. Resolves
// once the response headers are in. `events` holds { event, data } for each
// event (data parsed as JSON), and `comments` the keepalive comment lines.
function openStream(port, urlPath, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const comments = [];
    let buffer = '';
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET', path: urlPath, agent: false,
      headers: { Accept: 'text/event-stream', ...headers }
    }, (res) => {
      const closed = new Promise((done) => { res.on('close', done); });
      if (res.statusCode !== 200) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, events, comments, closed, close() {} }));
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) comments.push(line.slice(1).trim());
            else if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (data) events.push({ event, data: JSON.parse(data) });
        }
      });
      res.on('error', () => {});
      resolve({ status: res.statusCode, headers: res.headers, events, comments, closed, close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { startServer, spawnServer, request, openStream, sleep, waitFor };
