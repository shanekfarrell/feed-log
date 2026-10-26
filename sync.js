// Keeps the local list of events in step with the store (Supabase or this phone's localStorage).
// Local writes show at once and are queued, in order, until the store takes them.
// The browser gets window.FeedSync; the tests get module.exports.
(function (root) {
  // A Postgres/Supabase error (has a code) won't succeed on retry; a network error might.
  // Auth errors are the exception: an expired or refreshing session recovers on its own.
  // So are server-side outages: a 5xx, the API not reaching the database (PGRST000–003), or a
  // dropped connection / database short of resources (Postgres classes 08, 53, 57). Those are kept
  // and retried; throwing them away lost feeds logged while the database was down.
  const AUTH_CODES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '42501']);
  const isAuth = (err) => !!err && (err.status === 401 || AUTH_CODES.has(err.code));
  const isOutage = (err) => !!err && (err.status >= 500 || /^PGRST00\d$/.test(err.code) || /^(08|53|57)/.test(err.code));
  const permanent = (err) => !!(err && typeof err.code === 'string') && !isAuth(err) && !isOutage(err);

  // onPending(items) reports the unsent queue whenever it changes, so the app can keep it on the phone;
  // restore puts a saved queue back after the app restarts, so nothing logged offline is lost.
  function createSync(store, { normalize = (r) => r, onChange = () => {}, onError = () => {}, onPending = () => {}, restore = [] } = {}) {
    let events = new Map();     // id -> event: what the screen shows
    const pending = new Map();  // id -> { op: 'insert' | 'update' | 'delete', ev }
    const held = new Map();     // id -> partner row (null = deleted) that arrived while our write was pending
    const touched = new Map();  // id -> seq of our last local change
    let seq = 0, chain = Promise.resolve();

    const changed = () => onChange([...events.values()]);
    const report = () => onPending([...pending.entries()].map(([id, item]) => ({ id, op: item.op, ev: item.ev })));
    const touch = (id) => touched.set(id, ++seq);

    function applyHeld(id) {
      if (!held.has(id) || pending.has(id)) return;
      const row = held.get(id);
      held.delete(id);
      if (row) events.set(id, row); else events.delete(id);
      changed();
    }

    async function drain() {
      while (pending.size) {
        const [id, item] = pending.entries().next().value;
        try {
          if (item.op === 'delete') await store.remove(id);
          else await store[item.op](item.ev);
        } catch (err) {
          if (!permanent(err)) { onError(isAuth(err) ? 'Not synced yet, will retry' : isOutage(err) ? 'Server not responding, will sync when it’s back' : 'Offline, will sync when back', err); return; }
          onError('Couldn’t save that change', err);
          if (pending.get(id) === item) pending.delete(id);
          report();
          applyHeld(id);
          continue;
        }
        const latest = pending.get(id);
        if (latest === item) { pending.delete(id); report(); applyHeld(id); }
        else if (latest && item.op === 'insert' && latest.op === 'insert') latest.op = 'update';
      }
    }
    const flush = () => (chain = chain.then(drain));

    function persist(ev, isNew) {
      events.set(ev.id, ev);
      touch(ev.id);
      changed();
      const prev = pending.get(ev.id);
      const op = prev && prev.op !== 'delete' ? prev.op : isNew ? 'insert' : 'update';
      pending.delete(ev.id);   // re-queue at the back, after anything it depends on
      pending.set(ev.id, { op, ev });
      report();
      return flush();
    }

    function remove(id) {
      events.delete(id);
      touch(id);
      changed();
      pending.delete(id);
      pending.set(id, { op: 'delete' });   // always sent: an earlier insert may already be on the server
      report();
      return flush();
    }

    function applyRemote(row) {
      const ev = normalize(row);
      if (!ev) return;
      if (pending.has(ev.id)) { held.set(ev.id, ev); return; }
      events.set(ev.id, ev);
      changed();
    }
    function applyRemoteDelete(id) {
      if (pending.has(id)) { held.set(id, null); return; }
      if (events.delete(id)) changed();
    }

    // Put back writes saved from a previous session (the app was closed before they were sent).
    for (const item of restore || []) {
      if (!item || !item.id || !['insert', 'update', 'delete'].includes(item.op)) continue;
      const ev = item.ev && normalize(item.ev);
      if (item.op !== 'delete' && !ev) continue;
      pending.set(item.id, item.op === 'delete' ? { op: 'delete' } : { op: item.op, ev });
      touch(item.id);
      if (ev) events.set(item.id, ev); else events.delete(item.id);
    }
    if (pending.size) changed();

    async function refresh() {
      await flush();
      const startSeq = seq;
      let rows;
      try { rows = await store.load(); } catch (err) { onError('Can’t reach server', err); return; }
      const next = new Map();
      for (const r of rows) { const ev = normalize(r); if (ev) next.set(ev.id, ev); }
      // Our own changes made during the load, or not yet saved, win over the snapshot.
      for (const [id, s] of touched) {
        if (s > startSeq || pending.has(id)) { const local = events.get(id); if (local) next.set(id, local); else next.delete(id); }
        else touched.delete(id);
      }
      events = next;
      changed();
    }

    return { persist, remove, applyRemote, applyRemoteDelete, refresh, flush };
  }

  const api = { createSync };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FeedSync = api;
})(typeof self !== 'undefined' ? self : this);
