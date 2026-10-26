const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../logic.js');

const T = new Date(2026, 9, 16, 13).getTime();
const iso = (ms) => new Date(ms).toISOString();

test('I-6: normalize keeps good rows and rejects injected values', () => {
  const ok = { id: 'a', type: 'bottle', at: iso(T), by_name: 'A', data: { ml: 60 } };
  assert.deepEqual(F.normalize(ok), ok);
  assert.equal(F.normalize({ ...ok, data: { ml: '<img>' } }), null);
  const seg = { side: '"><img src=x>', start: T, end: T + 60e3 };
  assert.equal(F.normalize({ id: 'b', type: 'breast', at: iso(T), data: { status: 'done', segments: [seg] } }), null);
  assert.equal(F.normalize({ id: 'c', type: 'breast', at: iso(T), data: {} }), null);
  assert.equal(F.normalize({ id: 'd', type: 'pumped', at: iso(T), data: {} }), null);
  assert.equal(F.normalize({ ...ok, by_name: undefined }).by_name, '');
});

test('I-8: normalize rejects a done feed with an open segment', () => {
  const data = { status: 'done', segments: [{ side: 'L', start: T, end: null }] };
  assert.equal(F.normalize({ id: 'e', type: 'breast', at: iso(T), data }), null);
});

test('I-8: backToTimer refuses a feed already saved, and keeps a paused feed paused', () => {
  const paused = F.pauseFeed(F.startFeed('L', T), T + 60e3);
  assert.equal(F.backToTimer(F.finishFeed(paused, T + 60e3), false, T + 120e3), null);
  assert.equal(F.backToTimer(paused, true, T + 120e3), paused);
  assert.equal(F.isPaused(F.backToTimer(paused, false, T + 120e3)), false);
});

test('I-5: suspectWeight flags a jump over 20% (pounds typed as kg)', () => {
  assert.equal(F.suspectWeight(9.2, 4.17), true);
  assert.equal(F.suspectWeight(4.35, 4.17), false);
  assert.equal(F.suspectWeight(4.35, null), false);
});

test('I-5: weightGain reports "check" for an implausible gain', () => {
  const w = (d, kg) => ({ id: 'w' + d, type: 'weight', at: iso(new Date(2026, 9, d, 12).getTime()), data: { kg } });
  assert.equal(F.weightGain([w(1, 4.17), w(4, 9.2)], 150, 5).band, 'check');
});

test('I-3: validRoom accepts generated codes only', () => {
  assert.equal(F.validRoom('cpnwd7jce'), true);
  assert.equal(F.validRoom('abc'), false);
  assert.equal(F.validRoom('abc,defgh'), false);
  assert.equal(F.validRoom(''), false);
});
