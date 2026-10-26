const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../logic.js');
const { createSync } = require('../sync.js');

// A store that can be held, so a request can be "in flight" while the test acts.
function fakeStore() {
  const rows = new Map();
  let gate = null, fail = null;
  const wait = () => gate && gate.p;
  return {
    rows,
    hold() { let r; gate = { p: new Promise((res) => (r = res)) }; gate.release = r; },
    release() { const g = gate; gate = null; g.release(); },
    failWith(fn) { fail = fn; },
    async load() { const snap = [...rows.values()].map((r) => ({ ...r })); await wait(); return snap; },
    async insert(ev) { await wait(); const e = fail && fail('insert', ev); if (e) throw e; if (!rows.has(ev.id)) rows.set(ev.id, { ...ev }); },
    async update(ev) { await wait(); const e = fail && fail('update', ev); if (e) throw e; if (rows.has(ev.id)) rows.set(ev.id, { ...rows.get(ev.id), at: ev.at, data: ev.data }); },
    async remove(id) { await wait(); const e = fail && fail('remove', id); if (e) throw e; rows.delete(id); },
  };
}
const T = new Date(2026, 9, 16, 13).getTime();
let n = 0;
const bottle = (ml, id = 'o' + n++) => ({ id, room: 'roomroom1', type: 'bottle', at: new Date(T).toISOString(), by_name: 'A', data: { ml } });
function setup() {
  const store = fakeStore(), errors = [];
  let list = [];
  const sync = createSync(store, { normalize: F.normalize, onChange: (l) => (list = l), onError: (m) => errors.push(m) });
  return { store, sync, errors, list: () => list, ml: (id) => list.find((e) => e.id === id)?.data.ml };
}

test('persist shows the event at once and saves it', async () => {
  const { store, sync, ml } = setup();
  const ev = bottle(60);
  const p = sync.persist(ev, true);
  assert.equal(ml(ev.id), 60);
  await p;
  assert.equal(store.rows.get(ev.id).data.ml, 60);
});

test('I-1: a tap during a refresh is not lost when the snapshot lands', async () => {
  const { store, sync, list } = setup();
  store.hold();
  const r = sync.refresh();
  await Promise.resolve();
  const ev = bottle(60);
  const p = sync.persist(ev, true);
  store.release();
  await r; await p; await sync.flush();
  assert.ok(list().some((e) => e.id === ev.id));
});

test('I-2: a partner update that arrives while our write is pending is applied afterwards', async () => {
  const { store, sync, ml } = setup();
  const ev = bottle(60);
  await sync.persist(ev, true);
  store.hold();
  const p = sync.persist({ ...ev, data: { ml: 70 } }, false);
  sync.applyRemote({ ...ev, data: { ml: 90 } });           // partner's later write
  store.release();
  await p; await sync.flush();
  assert.equal(ml(ev.id), 90);
});

test('I-3: a rejected write is dropped and later writes still sync', async () => {
  const { store, sync, errors } = setup();
  store.failWith((op, ev) => (ev.data && ev.data.ml === 1 ? { code: '23514', message: 'check violation' } : null));
  await sync.persist(bottle(1), true);
  const ok = bottle(60);
  await sync.persist(ok, true);
  assert.ok(store.rows.has(ok.id));
  assert.equal(errors.length, 1);
});

test('I-3: refresh still loads the partner\'s rows while offline writes are queued', async () => {
  const { store, sync, list } = setup();
  const theirs = bottle(80);
  store.rows.set(theirs.id, theirs);
  store.failWith((op) => (op === 'insert' ? new TypeError('fetch failed') : null));
  const mine = bottle(60);
  await sync.persist(mine, true);
  await sync.refresh();
  assert.ok(list().some((e) => e.id === theirs.id));
  assert.ok(list().some((e) => e.id === mine.id));
});

test('I-4: discarding while the insert is in flight leaves nothing on the server', async () => {
  const { store, sync, list } = setup();
  const ev = bottle(60);
  store.hold();
  const p = sync.persist(ev, true);
  await Promise.resolve();
  const d = sync.remove(ev.id);
  store.release();
  await p; await d; await sync.flush();
  assert.equal(store.rows.has(ev.id), false);
  assert.equal(list().some((e) => e.id === ev.id), false);
});

test('an edit queued behind an in-flight insert is not lost', async () => {
  const { store, sync } = setup();
  const ev = bottle(60);
  store.hold();
  const p1 = sync.persist(ev, true);
  await Promise.resolve();
  const p2 = sync.persist({ ...ev, data: { ml: 90 } }, false);
  store.release();
  await p1; await p2; await sync.flush();
  assert.equal(store.rows.get(ev.id).data.ml, 90);
});

test('I-6: malformed remote rows are dropped', () => {
  const { sync, list } = setup();
  sync.applyRemote({ ...bottle(60), data: { ml: '<img src=x onerror=alert(1)>' } });
  sync.applyRemote({ id: 'x', type: 'breast', at: new Date(T).toISOString(), data: {} });
  assert.equal(list().length, 0);
});

for (const code of ['PGRST301', '42501']) {
  test(`an auth error (${code}) keeps the write queued and it syncs later`, async () => {
    const { store, sync, errors } = setup();
    store.failWith(() => ({ code, message: 'auth' }));
    const ev = bottle(60);
    await sync.persist(ev, true);
    assert.equal(store.rows.has(ev.id), false);
    assert.equal(errors[0], 'Not synced yet, will retry');
    store.failWith(null);
    await sync.flush();
    assert.ok(store.rows.has(ev.id));
  });
}

test('unsent writes are reported so they can be saved, and a new session sends them', async () => {
  const store = fakeStore();
  store.failWith(() => new TypeError('fetch failed'));            // offline
  let saved = [];
  const s1 = createSync(store, { normalize: F.normalize, onPending: (items) => (saved = items) });
  const ev = bottle(60);
  await s1.persist(ev, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].ev.id, ev.id);
  const keep = JSON.parse(JSON.stringify(saved));                 // as if written to the phone's storage
  store.failWith(null);                                           // app reopened with signal
  let list = [];
  const s2 = createSync(store, { normalize: F.normalize, restore: keep, onChange: (l) => (list = l), onPending: (items) => (saved = items) });
  await s2.flush();
  assert.equal(store.rows.get(ev.id).data.ml, 60);
  assert.ok(list.some((e) => e.id === ev.id));
  assert.equal(saved.length, 0);
});

test('a queued delete also survives a restart', async () => {
  const store = fakeStore();
  const ev = bottle(60);
  store.rows.set(ev.id, ev);
  store.failWith(() => new TypeError('fetch failed'));
  let saved = [];
  const s1 = createSync(store, { normalize: F.normalize, onPending: (items) => (saved = items) });
  await s1.remove(ev.id);
  store.failWith(null);
  const s2 = createSync(store, { normalize: F.normalize, restore: JSON.parse(JSON.stringify(saved)) });
  await s2.flush();
  assert.equal(store.rows.has(ev.id), false);
});

test('a write is kept and retried while the database is down (PGRST002 / 503), not thrown away', async () => {
  const { store, sync, errors } = setup();
  let down = true;
  store.failWith(() => down && { code: 'PGRST002', status: 503, message: 'Could not query the database for the schema cache. Retrying.' });
  const ev = bottle(70);
  await sync.persist(ev, true);
  assert.equal(store.rows.size, 0);
  assert.notEqual(errors[0], 'Couldn’t save that change');
  down = false;
  await sync.flush();
  assert.equal(store.rows.get(ev.id).data.ml, 70);
});

test('a server error (5xx) with a database code is also retried', async () => {
  const { store, sync } = setup();
  let down = true;
  store.failWith(() => down && { code: '57P01', status: 503, message: 'terminating connection due to administrator command' });
  const ev = bottle(40);
  await sync.persist(ev, true);
  down = false;
  await sync.flush();
  assert.equal(store.rows.get(ev.id).data.ml, 40);
});
