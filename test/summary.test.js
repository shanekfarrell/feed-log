const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../logic.js');

const MIN = 60e3, HOUR = 60 * MIN;
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m).getTime();
let n = 0;
const iso = (ms) => new Date(ms).toISOString();
const breast = (start, minL, minR = 0, first = 'L') =>
  ({ id: 'b' + n++, type: 'breast', at: iso(start), by_name: 'A', data: F.editFeed({ start, minL, minR, first }) });
const running = (start, side = 'L') => ({ id: 'r' + n++, type: 'breast', at: iso(start), by_name: 'A', data: F.startFeed(side, start) });
const bottle = (time, ml) => ({ id: 'o' + n++, type: 'bottle', at: iso(time), by_name: 'A', data: { ml } });
const weight = (time, kg) => ({ id: 'w' + n++, type: 'weight', at: iso(time), by_name: 'A', data: { kg } });

test('sessions merges a top-up bottle within 30 min of a breast feed', () => {
  const ev = [breast(at(16, 13), 15), bottle(at(16, 13, 30), 60), bottle(at(16, 15), 60)];
  const ss = F.sessions(ev, at(16, 16), 30);
  assert.equal(ss.length, 2);
  assert.equal(ss[0].items.length, 2);
  assert.equal(ss[0].start, at(16, 13));
  assert.equal(ss[0].end, at(16, 13, 30));
});

test('sessions keeps two breast feeds separate even when close', () => {
  const ss = F.sessions([breast(at(16, 13), 10), breast(at(16, 13, 20), 10)], at(16, 14), 30);
  assert.equal(ss.length, 2);
});

test('sessions ignores running feeds and other types', () => {
  const ev = [running(at(16, 13)), weight(at(16, 9), 4.2), { id: 'x', type: 'baby', at: iso(at(16, 8)), data: {} }];
  assert.deepEqual(F.sessions(ev, at(16, 14), 30), []);
});

test('nextDue counts from the start of the last feed, top-up included', () => {
  const ev = [breast(at(16, 13), 15), bottle(at(16, 13, 30), 60)];
  assert.equal(F.nextDue(ev, at(16, 14), 180, 30), at(16, 16));
  assert.equal(F.nextDue([], at(16, 14), 180, 30), null);
});

test('startOnSide is the opposite of the side the last feed ended on', () => {
  assert.equal(F.startOnSide([breast(at(16, 9), 10, 5, 'L')]), 'L');
  assert.equal(F.startOnSide([breast(at(16, 9), 10, 0, 'L')]), 'R');
  assert.equal(F.startOnSide([breast(at(16, 9), 10, 0, 'L'), breast(at(16, 12), 0, 8, 'R')]), 'L');
  assert.equal(F.startOnSide([]), 'L');
  assert.equal(F.startOnSide([running(at(16, 13), 'R')]), 'L');
});

test('dayStart uses the 05:00 boundary', () => {
  assert.equal(F.dayStart(at(16, 4, 59), 5), at(15, 5));
  assert.equal(F.dayStart(at(16, 5), 5), at(16, 5));
  assert.equal(F.dayStart(at(16, 23), 5), at(16, 5));
  assert.equal(F.shiftDay(at(16, 5), -1), at(15, 5));
});

test('feedCount counts merged feeds starting inside the window', () => {
  const ev = [breast(at(15, 12), 10), breast(at(16, 1), 10), bottle(at(16, 1, 20), 30), breast(at(16, 4), 10)];
  assert.equal(F.feedCount(ev, at(15, 13), at(16, 13), at(16, 13), 30), 2);
});

test('todayTotals sums saved breast feeds by start day, leaves out running ones, and adds bottles', () => {
  const ev = [
    breast(at(16, 4, 50), 20),           // started before 05:00: yesterday
    breast(at(16, 9), 12, 8, 'L'),
    running(at(16, 13), 'R'),
    bottle(at(16, 10), 60), bottle(at(16, 12), 90), bottle(at(15, 22), 60),
  ];
  const x = F.todayTotals(ev, at(16, 5), at(16, 13, 10), 5);
  assert.deepEqual(x, { L: 12 * MIN, R: 8 * MIN, breastMin: 20, estBreastMl: 100, bottleMl: 150, bottles: 2 });
});

test('targetRange rounds to 10 ml', () => {
  assert.deepEqual(F.targetRange(4.17, [150, 200]), [630, 830]);
});

test('topUp gives remaining ml and bottle count, never negative', () => {
  assert.deepEqual(F.topUp(630, 120, 300, 60), { remaining: 210, bottles: 4 });
  assert.deepEqual(F.topUp(630, 400, 300, 60), { remaining: 0, bottles: 0 });
});

test('weights and latestKg', () => {
  const ev = [weight(at(1, 12), 4.0), weight(at(8, 12), 4.2), weight(at(5, 12), 0)];
  assert.deepEqual(F.weights(ev).map((w) => w.data.kg), [4.2, 4.0]);
  assert.equal(F.latestKg(ev, 3.5), 4.2);
  assert.equal(F.latestKg([], 3.5), 3.5);
});

test('weightGain bands', () => {
  const g = (kg2) => F.weightGain([weight(at(1, 12), 4.0), weight(at(8, 12), kg2)], 150, 30);
  assert.deepEqual(g(4.2), { gPerWeek: 200, band: 'green', since: at(1, 12), kg: 4.2 });
  assert.equal(g(4.12).band, 'amber');
  assert.equal(g(4.12).gPerWeek, 120);
  assert.equal(g(4.05).band, 'red');
  assert.equal(g(3.9).band, 'red');
  assert.equal(g(3.9).gPerWeek, -100);
});

test('weightGain under 2 weeks old is "early", not red', () => {
  const x = F.weightGain([weight(at(1, 12), 4.17), weight(at(4, 12), 3.95)], 150, 5);
  assert.equal(x.band, 'early');
});

test('weightGain ignores weights less than 2 days apart', () => {
  assert.equal(F.weightGain([weight(at(8, 9), 4.2), weight(at(8, 18), 4.25)], 150, 30), null);
  const x = F.weightGain([weight(at(1, 12), 4.0), weight(at(8, 9), 4.2), weight(at(8, 18), 4.25)], 150, 30);
  assert.equal(x.kg, 4.25);
  assert.equal(x.since, at(1, 12));
  assert.equal(F.weightGain([weight(at(8, 12), 4.2)], 150, 30), null);
});

test('longestNightGap finds the longest gap in the last completed night', () => {
  const ev = [breast(at(15, 18), 15), breast(at(15, 22), 15), breast(at(16, 3), 15), breast(at(16, 6, 30), 15)];
  assert.deepEqual(F.longestNightGap(ev, at(16, 9), [19, 7], 30), { ms: 4 * HOUR + 45 * MIN, from: at(15, 22, 15), to: at(16, 3) });
  // At 03:00 tonight isn't over, so it looks at the night before, which has no gaps.
  assert.equal(F.longestNightGap(ev, at(16, 3), [19, 7], 30), null);
});

test('dayBlocks positions segments and bottles as percentages of the day', () => {
  const start = at(16, 5), end = F.shiftDay(start, 1);
  const b = F.dayBlocks([breast(at(16, 11), 60), bottle(at(16, 17), 60)], start, end, at(16, 20));
  assert.equal(b.length, 2);
  assert.equal(b[0].kind, 'L');
  assert.equal(b[0].left, 25);
  assert.ok(Math.abs(b[0].width - 4.1667) < 0.001);
  assert.deepEqual({ ...b[1], id: undefined }, { id: undefined, kind: 'bottle', left: 50, width: 0.8 });
});

test('dayBlocks clips a feed that crosses the 05:00 boundary', () => {
  const ev = [breast(at(16, 4, 50), 20)];
  const today = F.dayBlocks(ev, at(16, 5), F.shiftDay(at(16, 5), 1), at(16, 8));
  const yesterday = F.dayBlocks(ev, at(15, 5), at(16, 5), at(16, 8));
  assert.equal(today[0].left, 0);
  assert.ok(Math.abs(today[0].width - (10 / 1440) * 100) < 0.001);
  assert.ok(Math.abs(yesterday[0].left + yesterday[0].width - 100) < 0.001);
});

test('dayBlocks draws a running feed up to now', () => {
  const b = F.dayBlocks([running(at(16, 11))], at(16, 5), F.shiftDay(at(16, 5), 1), at(16, 11, 30));
  assert.ok(Math.abs(b[0].width - (30 / 1440) * 100) < 0.001);
});

test('pickRunning returns the newest running feed and the rest as stale', () => {
  const older = running(at(16, 13)), newer = running(at(16, 13, 1));
  assert.deepEqual(F.pickRunning([older, newer, breast(at(16, 9), 10)]), { current: newer, stale: [older] });
  assert.deepEqual(F.pickRunning([]), { current: null, stale: [] });
});

test('a bottle counts with a breast feed only if it starts within the hour after the feed started', () => {
  // A 45-minute feed then a bottle 30 minutes after it ended: 75 minutes start to start, so two feeds.
  const late = F.sessions([breast(at(16, 13), 25, 20), bottle(at(16, 14, 15), 60)], at(16, 16), 60);
  assert.equal(late.length, 2);
  const soon = F.sessions([breast(at(16, 13), 25, 20), bottle(at(16, 13, 55), 60)], at(16, 16), 60);
  assert.equal(soon.length, 1);
});

test('a chain never stretches a combined feed past an hour from its first start', () => {
  const ev = [breast(at(16, 13), 10), bottle(at(16, 13, 40), 30), breast(at(16, 14, 20), 10)];
  assert.equal(F.sessions(ev, at(16, 16), 60).length, 2);
});
