const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('./validate');

const INJECTIONS = [
  '1; id',
  '1 && id',
  '1|id',
  '$(id)',
  '`id`',
  '1\nid',
  'a b',
  "1'",
  '1"',
  '-h',
  '--help',
  '',
  ' ',
  '../etc/passwd',
];

test('deviceHost accepts hex device ids, IPv4 and hostnames', () => {
  for (const ok of ['1080ABCD', '1080ABCD-1', '192.168.1.100', 'hdhr.local', 'my-tuner', 'FFFFFFFF']) {
    assert.equal(v.deviceHost(ok), ok);
  }
});

test('deviceHost rejects shell metacharacters, option-like and empty values', () => {
  for (const bad of [...INJECTIONS, 'a'.repeat(254), undefined, null, 5, {}, []]) {
    assert.equal(v.deviceHost(bad), null, JSON.stringify(bad));
  }
});

test('tuner accepts 0-7 as string or number and returns a number', () => {
  assert.equal(v.tuner('0'), 0);
  assert.equal(v.tuner(7), 7);
  assert.equal(v.tuner('3'), 3);
});

test('tuner rejects out of range and non-integers', () => {
  for (const bad of ['8', '-1', '1.5', '1;id', '01', '', undefined, null, {}, [], NaN]) {
    assert.equal(v.tuner(bad), null, JSON.stringify(bad));
  }
});

test('channelMap accepts only known maps', () => {
  for (const ok of ['us-bcast', 'us-cable', 'us-hrc', 'us-irc', 'ca-bcast', 'ca-cable', 'ca-hrc', 'ca-irc', 'eu-bcast', 'eu-cable', 'au-bcast', 'au-cable']) {
    assert.equal(v.channelMap(ok), ok);
  }
  for (const bad of ['us-bcast; id', 'xx-bcast', 'US-BCAST', '', undefined, ['us-bcast']]) {
    assert.equal(v.channelMap(bad), null, JSON.stringify(bad));
  }
});

test('channel accepts tune formats used by the app', () => {
  for (const ok of ['27', 'auto:27', '8vsb:27', 'qam256:117', 'auto:575000000', 'atsc3:27', 'atsc3:27:0+1+2', 'none', '+', '-']) {
    assert.equal(v.channel(ok), ok, ok);
  }
});

test('channel rejects injection and malformed values', () => {
  for (const bad of [...INJECTIONS, '27; id', 'atsc3:27:a', 'auto:', ':27', 'atsc3:27:0+', undefined, null, 27, {}]) {
    assert.equal(v.channel(bad), null, JSON.stringify(bad));
  }
});

test('plps accepts array of small integers and returns normalised list', () => {
  assert.deepEqual(v.plps(undefined), []);
  assert.deepEqual(v.plps([]), []);
  assert.deepEqual(v.plps([0, 1, '2']), [0, 1, 2]);
});

test('plps rejects non-arrays, non-integers and oversized lists', () => {
  for (const bad of ['0+1', ['1;id'], [-1], [1.5], [256], Array(65).fill(1), {}]) {
    assert.equal(v.plps(bad), null, JSON.stringify(bad));
  }
});

test('digits accepts 1-10 digit strings only', () => {
  assert.equal(v.digits('27'), '27');
  assert.equal(v.digits('575000000'), '575000000');
  for (const bad of ['', 'a', '1a', '-1', '1.5', '12345678901', undefined, ['1']]) {
    assert.equal(v.digits(bad), null, JSON.stringify(bad));
  }
});

test('displayName strips control characters and caps length', () => {
  assert.equal(v.displayName('Channel 2'), 'Channel 2');
  assert.equal(v.displayName('a\nhttp://evil\r\nb'), 'ahttp://evilb');
  assert.equal(v.displayName('x'.repeat(200)).length, 64);
  assert.equal(v.displayName(undefined), null);
  assert.equal(v.displayName(['a']), null);
});

test('logSafe flattens control characters so values cannot forge log lines', () => {
  assert.equal(v.logSafe('plain text'), 'plain text');
  assert.equal(v.logSafe('a\nFAKE LOG LINE\r\nb'), 'a FAKE LOG LINE  b');
  assert.equal(v.logSafe('tab\there'), 'tab here');
  assert.equal(v.logSafe('x'.repeat(2000)).length, 1000 + 1); // truncated + ellipsis marker
  assert.equal(v.logSafe(undefined), 'undefined');
  assert.equal(v.logSafe(new Error('bad\nthing')), 'Error: bad thing');
});
