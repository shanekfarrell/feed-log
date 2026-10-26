const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../logic.js');

const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();
let n = 0;
const iso = (ms) => new Date(ms).toISOString();
const breast = (s, l, r = 0) => ({ id: 'b' + n++, type: 'breast', at: iso(s), data: F.editFeed({ start: s, minL: l, minR: r, first: 'L' }) });
const bottle = (s, ml) => ({ id: 'o' + n++, type: 'bottle', at: iso(s), data: { ml } });

test('feedMix splits the last 24 hours into breast, bottle and breast-plus-top-up feeds', () => {
  const ev = [breast(at(16, 9), 10), bottle(at(16, 9, 20), 40), breast(at(16, 12), 15), bottle(at(16, 15), 60), breast(at(15, 6), 10)];
  assert.deepEqual(F.feedMix(ev, at(15, 13), at(16, 13, 1), at(16, 16), 30), { feeds: 2, breast: 1, bottle: 0, both: 1 });
  assert.deepEqual(F.feedMix(ev, at(15, 17), at(16, 17), at(16, 17), 30), { feeds: 3, breast: 1, bottle: 1, both: 1 });
});

test('dailySummary gives each day’s feeds, breast minutes, bottle ml and estimated total, oldest first', () => {
  const ev = [breast(at(15, 9), 10, 10), bottle(at(15, 13), 60), breast(at(16, 8), 30), bottle(at(16, 4), 50)];
  const d = F.dailySummary(ev, at(16, 20), 2, 5, 5);
  assert.equal(d.length, 2);
  assert.equal(d[0].start, at(15, 5));
  assert.deepEqual({ feeds: d[0].feeds, breastMin: d[0].breastMin, bottleMl: d[0].bottleMl, estMl: d[0].estMl }, { feeds: 3, breastMin: 20, bottleMl: 110, estMl: 210 });
  assert.deepEqual({ feeds: d[1].feeds, breastMin: d[1].breastMin, bottleMl: d[1].bottleMl, estMl: d[1].estMl }, { feeds: 1, breastMin: 30, bottleMl: 0, estMl: 150 });
});

test('busiestHours finds the 3-hour window with the most feed starts', () => {
  const ev = [breast(at(14, 19), 5), breast(at(14, 20), 5), breast(at(15, 19, 30), 5), breast(at(15, 21), 5), breast(at(16, 3), 5)];
  assert.deepEqual(F.busiestHours(ev, at(14, 0), at(16, 23), 30), { startHour: 19, count: 4 });
  assert.equal(F.busiestHours([], at(14, 0), at(16, 23), 30), null);
});

test('timeOnDay puts a typed time on the entry’s day, and a time later than now on the day before', () => {
  const now = at(17, 9, 30);
  assert.equal(F.timeOnDay(now, '08:15', now), at(17, 8, 15));
  assert.equal(F.timeOnDay(now, '09:33', now), at(17, 9, 33));          // a few minutes ahead is fine (clock drift)
  assert.equal(F.timeOnDay(now, '23:40', now), at(16, 23, 40));         // just after midnight: last night
  assert.equal(F.timeOnDay(at(15, 14), '13:05', now), at(15, 13, 5));   // editing an older entry keeps its day
  assert.equal(F.timeOnDay(now, 'nonsense', now), null);
  assert.equal(F.hhmm(at(17, 8, 5)), '08:05');
});

test('ageLabel shows weeks and days', () => {
  assert.equal(F.ageLabel(0), '0 days old');
  assert.equal(F.ageLabel(1), '1 day old');
  assert.equal(F.ageLabel(13), '13 days old');
  assert.equal(F.ageLabel(14), '2 weeks old');
  assert.equal(F.ageLabel(26), '3 weeks 5 days old');
  assert.equal(F.ageLabel(29), '4 weeks 1 day old');
  assert.equal(F.ageLabel(90), '12 weeks 6 days old');
  assert.equal(F.ageLabel(100), '3 months old');
});

test('farInPast flags a new entry many hours ago and offers the 12-hour flip when that fits', () => {
  const now = at(24, 2, 2);
  // 12:20 typed at 2am lands on yesterday afternoon; 00:20 tonight is the likely meaning.
  assert.deepEqual(F.farInPast(at(23, 12, 20), now, 6), { hours: 14, flip: at(24, 0, 20) });
  // 3 hours ago is normal: no warning.
  assert.equal(F.farInPast(at(23, 23, 0), now, 6), null);
  // 8 hours ago with no sensible flip (12 hours later would be in the future).
  assert.deepEqual(F.farInPast(at(23, 18, 0), now, 6), { hours: 8, flip: null });
});
