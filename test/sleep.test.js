const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../logic.js');

const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();
const MIN = 60e3, HOUR = 60 * MIN;
let n = 0;
const sleep = (start, end) => ({ id: 's' + n++, type: 'baby', at: new Date(start).toISOString(), data: { kind: 'sleep', start, end } });

test('isSleep tells sleeps apart from the settings record', () => {
  assert.equal(F.isSleep(sleep(at(18, 9), at(18, 10))), true);
  assert.equal(F.isSleep({ id: 'b', type: 'baby', at: new Date().toISOString(), data: { name: 'Ava' } }), false);
});

test('normalize keeps valid sleeps and drops broken ones', () => {
  assert.ok(F.normalize(sleep(at(18, 9), null)));
  assert.ok(F.normalize(sleep(at(18, 9), at(18, 10))));
  assert.equal(F.normalize({ id: 'bad', type: 'baby', at: new Date(at(18, 9)).toISOString(), data: { kind: 'sleep', start: 'x', end: null } }), null);
  assert.equal(F.normalize(sleep(at(18, 10), at(18, 9))), null);   // ends before it starts
});

test('sleepState while asleep: since when, and how long she was awake before', () => {
  const ev = [sleep(at(18, 6), at(18, 8)), sleep(at(18, 10), null)];
  const s = F.sleepState(ev, at(18, 10, 45), 5);
  assert.equal(s.asleep, true);
  assert.equal(s.since, at(18, 10));
  assert.equal(s.awakeBefore, 2 * HOUR);           // woke at 08:00, asleep again at 10:00
  assert.equal(s.current.id, ev[1].id);
});

test('sleepState while awake: since when, last sleep length, today’s total and count', () => {
  const ev = [sleep(at(18, 3), at(18, 6)), sleep(at(18, 9), at(18, 10, 30)), sleep(at(17, 13), at(17, 14))];
  const s = F.sleepState(ev, at(18, 12), 5);
  assert.equal(s.asleep, false);
  assert.equal(s.since, at(18, 10, 30));
  assert.equal(s.lastSleepMs, 90 * MIN);
  assert.equal(s.awakeBefore, 3 * HOUR);           // up at 06:00, asleep at 09:00
  assert.equal(s.todayMs, HOUR + 90 * MIN);        // day starts 05:00: 05:00–06:00 counts, plus 09:00–10:30
  assert.equal(s.todayCount, 2);
});

test('sleepState with no sleeps logged', () => {
  const s = F.sleepState([], at(18, 12), 5);
  assert.equal(s.asleep, false);
  assert.equal(s.since, null);
  assert.equal(s.todayMs, 0);
});

test('dailySleep gives each day’s total, number of sleeps, longest sleep and average awake window', () => {
  const ev = [
    sleep(at(17, 9), at(17, 10)),                 // day of the 17th (from 05:00)
    sleep(at(17, 13), at(17, 15)),
    sleep(at(17, 23), at(18, 2)),                 // counted on the 17th until 05:00 on the 18th
    sleep(at(18, 9), at(18, 9, 30)),
    sleep(at(18, 11), null),                      // asleep now
  ];
  const d = F.dailySleep(ev, at(18, 12), 2, 5);
  assert.equal(d.length, 2);
  assert.equal(d[0].start, at(17, 5));
  assert.deepEqual({ ms: d[0].ms, count: d[0].count, longest: d[0].longest }, { ms: 6 * HOUR, count: 3, longest: 3 * HOUR });
  assert.equal(d[0].avgAwakeMs, (3 * HOUR + 8 * HOUR) / 2);   // 10:00→13:00 and 15:00→23:00
  assert.deepEqual({ ms: d[1].ms, count: d[1].count, longest: d[1].longest }, { ms: 90 * MIN, count: 2, longest: HOUR });
  assert.equal(d[1].avgAwakeMs, (7 * HOUR + 90 * MIN) / 2);   // 02:00→09:00 and 09:30→11:00
});
