const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../logic.js');

const MIN = 60e3;
const T0 = new Date(2026, 9, 16, 13, 0).getTime();

test('startFeed opens one running segment', () => {
  assert.deepEqual(F.startFeed('L', T0), { status: 'running', segments: [{ side: 'L', start: T0, end: null }] });
});

test('sideTotals counts the open segment up to now', () => {
  assert.deepEqual(F.sideTotals(F.startFeed('L', T0), T0 + 8 * MIN), { L: 8 * MIN, R: 0 });
});

test('pause stops the clock; resume continues on the same side', () => {
  let d = F.pauseFeed(F.startFeed('L', T0), T0 + 5 * MIN);
  assert.equal(F.isPaused(d), true);
  assert.equal(F.totalMs(d, T0 + 30 * MIN), 5 * MIN);
  d = F.resumeFeed(d, T0 + 10 * MIN);
  assert.equal(F.isPaused(d), false);
  assert.equal(F.currentSide(d), 'L');
  assert.equal(F.totalMs(d, T0 + 12 * MIN), 7 * MIN);
});

test('resume on a feed that is not paused changes nothing', () => {
  const d = F.startFeed('R', T0);
  assert.equal(F.resumeFeed(d, T0 + MIN), d);
});

test('timer ops do not mutate their input', () => {
  const d = F.startFeed('L', T0);
  F.pauseFeed(d, T0 + MIN); F.switchSide(d, T0 + MIN); F.finishFeed(d, T0 + MIN);
  assert.deepEqual(d, { status: 'running', segments: [{ side: 'L', start: T0, end: null }] });
});

test('switchSide closes the current side and opens the other', () => {
  const d = F.switchSide(F.startFeed('L', T0), T0 + 10 * MIN);
  assert.equal(F.currentSide(d), 'R');
  assert.deepEqual(F.sideTotals(d, T0 + 16 * MIN), { L: 10 * MIN, R: 6 * MIN });
});

test('switchSide while paused starts the other side running', () => {
  let d = F.pauseFeed(F.startFeed('L', T0), T0 + 4 * MIN);
  d = F.switchSide(d, T0 + 6 * MIN);
  assert.equal(F.isPaused(d), false);
  assert.equal(F.currentSide(d), 'R');
  assert.deepEqual(F.sideTotals(d, T0 + 8 * MIN), { L: 4 * MIN, R: 2 * MIN });
});

test('finishFeed closes the open segment and marks done', () => {
  const d = F.finishFeed(F.startFeed('R', T0), T0 + 9 * MIN);
  assert.equal(d.status, 'done');
  assert.equal(F.isPaused(d), false);
  assert.deepEqual(F.sideTotals(d, T0 + 60 * MIN), { L: 0, R: 9 * MIN });
});

test('finishFeed keeps a 20-second feed rather than losing it', () => {
  const d = F.finishFeed(F.startFeed('L', T0), T0 + 20e3);
  assert.equal(F.totalMs(d, T0 + MIN), 20e3);
  assert.equal(F.lastSide(d), 'L');
});

test('feedStart, feedEnd, firstSide, lastSide', () => {
  const d = F.finishFeed(F.switchSide(F.startFeed('L', T0), T0 + 10 * MIN), T0 + 15 * MIN);
  assert.equal(F.feedStart(d), T0);
  assert.equal(F.feedEnd(d, 0), T0 + 15 * MIN);
  assert.equal(F.firstSide(d), 'L');
  assert.equal(F.lastSide(d), 'R');
});

test('lastSide ignores a zero-length final segment', () => {
  const d = F.finishFeed(F.switchSide(F.startFeed('L', T0), T0 + 10 * MIN), T0 + 10 * MIN);
  assert.equal(F.lastSide(d), 'L');
});

test('editFeed lays sides back-to-back from start, first side first', () => {
  assert.deepEqual(F.editFeed({ start: T0, minL: 12, minR: 5, first: 'R' }), {
    status: 'done',
    segments: [
      { side: 'R', start: T0, end: T0 + 5 * MIN },
      { side: 'L', start: T0 + 5 * MIN, end: T0 + 17 * MIN },
    ],
  });
});

test('editFeed drops a side with zero minutes', () => {
  assert.deepEqual(F.editFeed({ start: T0, minL: 0, minR: 7, first: 'L' }).segments, [{ side: 'R', start: T0, end: T0 + 7 * MIN }]);
});

test('editFeed fixes a timer left running for 3 hours', () => {
  const left = F.startFeed('L', T0);
  assert.equal(F.totalMs(left, T0 + 180 * MIN), 180 * MIN);
  const fixed = F.editFeed({ start: F.feedStart(left), minL: 20, minR: 0, first: 'L' });
  assert.equal(F.totalMs(fixed, T0 + 180 * MIN), 20 * MIN);
  assert.equal(F.feedStart(fixed), T0);
});

test('editFeed returns null for zero minutes', () => {
  assert.equal(F.editFeed({ start: T0, minL: 0, minR: 0, first: 'L' }), null);
});

test('fmtDur and mmss', () => {
  assert.equal(F.fmtDur(14 * MIN), '14m');
  assert.equal(F.fmtDur(160 * MIN), '2h 40m');
  assert.equal(F.fmtDur(125 * MIN), '2h 05m');
  assert.equal(F.fmtDur(-5), '0m');
  assert.equal(F.mmss(65e3), '1:05');
  assert.equal(F.mmss(3725e3), '1:02:05');
  assert.equal(F.mmss(-1), '0:00');
});
