const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../logic.js');

const MIN = 60e3;
const at = (h, m = 0) => new Date(2026, 9, 18, h, m).getTime();
const iso = (ms) => new Date(ms).toISOString();
const seg = (side, from, to) => ({ side, start: from, end: to });
const breast = (id, ...segments) => ({ id, type: 'breast', at: iso(Math.min(...segments.map((s) => s.start))), by_name: 'A', data: { status: 'done', segments } });
const bottle = (id, time, ml) => ({ id, type: 'bottle', at: iso(time), by_name: 'A', data: { ml } });

test('two left feeds within an hour become one, keeping the earlier entry', () => {
  const a = breast('a', seg('L', at(13), at(13, 15))), b = breast('b', seg('L', at(13, 50), at(14)));
  const r = F.reconcileFeeds([b, a], 60);
  assert.deepEqual(r.deletes, ['b']);
  assert.equal(r.updates.length, 1);
  assert.equal(r.updates[0].id, 'a');
  assert.deepEqual(r.updates[0].data, { status: 'done', segments: [seg('L', at(13), at(13, 15)), seg('L', at(13, 50), at(14))] });
  assert.equal(r.updates[0].at, iso(at(13)));
});

test('the hour runs from the start of the first feed to the start of the next', () => {
  const a = breast('a', seg('L', at(13), at(13, 40))), b = breast('b', seg('L', at(14), at(14, 10)));
  assert.deepEqual(F.reconcileFeeds([a, b], 60).deletes, ['b']);
  const c = breast('c', seg('L', at(14, 1), at(14, 10)));
  assert.deepEqual(F.reconcileFeeds([a, c], 60), { updates: [], deletes: [] });
});

test('left-only and right-only feeds stay separate', () => {
  const a = breast('a', seg('L', at(13), at(13, 15))), b = breast('b', seg('R', at(13, 30), at(13, 40)));
  assert.deepEqual(F.reconcileFeeds([a, b], 60), { updates: [], deletes: [] });
});

test('a both-sides feed merges with a later feed that shares a side', () => {
  const a = breast('a', seg('L', at(13), at(13, 10)), seg('R', at(13, 10), at(13, 20))), b = breast('b', seg('R', at(13, 50), at(14)));
  const r = F.reconcileFeeds([a, b], 60);
  assert.deepEqual(r.deletes, ['b']);
  assert.deepEqual(F.sideTotals(r.updates[0].data, 0), { L: 10 * MIN, R: 20 * MIN });
});

test('overlapping time on the same side is counted once', () => {
  const a = breast('a', seg('L', at(13, 47), at(14, 2))), b = breast('b', seg('L', at(14), at(14, 5)));
  const r = F.reconcileFeeds([a, b], 60);
  assert.deepEqual(r.updates[0].data.segments, [seg('L', at(13, 47), at(14, 5))]);
});

test('several same-side feeds starting within the hour become one', () => {
  const ev = [breast('a', seg('R', at(9), at(9, 10))), breast('b', seg('R', at(9, 30), at(9, 40))), breast('c', seg('R', at(9, 55), at(10, 5)))];
  const r = F.reconcileFeeds(ev, 60);
  assert.deepEqual(r.deletes.sort(), ['b', 'c']);
  assert.equal(F.sideTotals(r.updates[0].data, 0).R, 30 * MIN);
});

test('bottles within an hour become one bottle with the ml added up', () => {
  const r = F.reconcileFeeds([bottle('x', at(14, 10), 15), bottle('y', at(14, 50), 20), bottle('z', at(17), 30)], 60);
  assert.deepEqual(r.deletes, ['y']);
  assert.deepEqual(r.updates, [{ ...bottle('x', at(14, 10), 35) }]);
});

test('bottles never merge with breast feeds', () => {
  const ev = [breast('a', seg('L', at(13), at(13, 15))), bottle('x', at(13, 20), 30)];
  assert.deepEqual(F.reconcileFeeds(ev, 60), { updates: [], deletes: [] });
});

test('a running feed is left alone', () => {
  const a = breast('a', seg('L', at(13), at(13, 15)));
  const run = { id: 'r', type: 'breast', at: iso(at(13, 30)), by_name: 'A', data: { status: 'running', segments: [{ side: 'L', start: at(13, 30), end: null }] } };
  assert.deepEqual(F.reconcileFeeds([a, run], 60), { updates: [], deletes: [] });
});

test('merging is stable: running it again on the result changes nothing', () => {
  const ev = [breast('a', seg('L', at(13), at(13, 15))), breast('b', seg('L', at(13, 50), at(14))), bottle('x', at(15), 10), bottle('y', at(15, 30), 10)];
  const r = F.reconcileFeeds(ev, 60);
  const after = ev.filter((e) => !r.deletes.includes(e.id)).map((e) => r.updates.find((u) => u.id === e.id) || e);
  assert.deepEqual(F.reconcileFeeds(after, 60), { updates: [], deletes: [] });
});

test('both phones pick the same entry to keep when two feeds start at the same minute', () => {
  const a = breast('m', seg('L', at(13), at(13, 10))), b = breast('k', seg('L', at(13), at(13, 5)));
  assert.deepEqual(F.reconcileFeeds([a, b], 60).deletes, ['m']);
  assert.deepEqual(F.reconcileFeeds([b, a], 60).deletes, ['m']);
});

test('repeat feeds merge only when the next starts within an hour of the first one starting', () => {
  const a = breast('a', seg('L', at(13), at(13, 40))), b = breast('b', seg('L', at(14, 5), at(14, 15)));
  assert.deepEqual(F.reconcileFeeds([a, b], 60), { updates: [], deletes: [] });
  const c = breast('c', seg('L', at(13, 55), at(14, 5)));
  assert.deepEqual(F.reconcileFeeds([a, c], 60).deletes, ['c']);
});

test('a chain of same-side feeds stops at an hour from the first start', () => {
  const ev = [breast('a', seg('R', at(9), at(9, 10))), breast('b', seg('R', at(9, 50), at(10))), breast('c', seg('R', at(10, 30), at(10, 40)))];
  assert.deepEqual(F.reconcileFeeds(ev, 60).deletes, ['b']);
});
