// Preloaded into the server under test (node --require): replaces https.get so
// no test ever reaches the network, and records each requested URL, one per
// line, in $FAKE_HTTPS_LOG. Answers with an empty device list.

const https = require('node:https');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

https.get = (url, callback) => {
  fs.appendFileSync(process.env.FAKE_HTTPS_LOG, `${url}\n`);
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy = () => {};
  setImmediate(() => {
    const res = new EventEmitter();
    callback(res);
    res.emit('data', '[]');
    res.emit('end');
  });
  return req;
};
