// Demo build only: stands in for history.js. Makes up two weeks of believable feeds, sleeps and
// weigh-ins for "Baby", dated relative to today so the demo always looks current.
// The data is rebuilt fresh each day (and on ?reset); anything a visitor logs lasts until then.
// "Start fresh" (the bar at the top) clears the sample data so a visitor can use it for their own baby:
// their log is then kept on this phone only, never reset, until they choose "Show sample data".
// The browser gets window.FeedHistory and window.DEMO, which the demo CONFIG reads.
(function (root) {
  const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const now = Date.now();
  const AGE_DAYS = 38;
  const isoDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const today = isoDate(now);

  const clearLog = () => { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith('feedlog.')) localStorage.removeItem(k); } };
  let fresh = false;
  // Sample data is rebuilt once a day: clear this browser's demo log so the made-up history is re-imported.
  try {
    const reset = /[?&]reset\b/.test(location.search);
    if (reset) localStorage.removeItem('feedlog.demoFresh');
    fresh = localStorage.getItem('feedlog.demoFresh') === '1';
    if (!fresh && (reset || localStorage.getItem('feedlog.demoDay') !== today)) {
      clearLog();
      localStorage.setItem('feedlog.demoDay', today);
    }
  } catch {}

  // Same numbers all day, different tomorrow.
  let seed = [...today].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const between = (a, b) => a + rnd() * (b - a);
  const round5 = (ms) => Math.round(ms / (5 * MIN)) * 5 * MIN;

  const birthMs = now - AGE_DAYS * DAY;
  const birth = isoDate(birthMs);
  const onDay = (d) => isoDate(birthMs + d * DAY);
  // Weigh-ins near the 50th centile, with the usual dip after birth.
  const book = [[onDay(0), 3.3], [onDay(5), 3.18]];
  const weights = [[12, 3.36], [19, 3.64], [26, 3.93], [33, 4.2]];

  const EVENTS = [];
  let n = 0;
  const id = () => `demo-${++n}`;
  const add = (type, at, data, by) => EVENTS.push({ id: id(), type, at: new Date(at).toISOString(), by_name: by, data });

  for (const [d, kg] of weights) add('weight', new Date(onDay(d) + 'T12:00').getTime(), { kg }, 'Mum');

  // Feeds, working back from one that finished a little over an hour ago.
  const starts = [];
  let s = round5(now - between(80, 110) * MIN);
  while (s > now - 14 * DAY) {
    starts.unshift(s);
    const h = new Date(s).getHours();
    const night = h >= 22 || h < 6;
    s = round5(s - between(night ? 180 : 140, night ? 230 : 190) * MIN);
  }
  let side = 'L';
  const ends = [];
  starts.forEach((st) => {
    const h = new Date(st).getHours();
    if (h >= 18 && h < 22 && !ends.some((e) => e.bottleDay === isoDate(st))) {
      // An evening bottle of expressed milk, given by Dad.
      add('bottle', st, { ml: 10 * Math.round(between(80, 110) / 10) }, 'Dad');
      ends.push({ end: st + 20 * MIN, bottleDay: isoDate(st) });
      return;
    }
    const a = round5(between(8, 14) * MIN) || 10 * MIN, b = round5(between(5, 10) * MIN) || 5 * MIN;
    const other = side === 'L' ? 'R' : 'L';
    const segments = [{ side, start: st, end: st + a }, { side: other, start: st + a + 2 * MIN, end: st + a + 2 * MIN + b }];
    add('breast', st, { status: 'done', segments }, 'Mum');
    const end = segments[1].end;
    if (rnd() < 0.15) add('bottle', end + 5 * MIN, { ml: 30 }, 'Dad');   // the odd top-up
    ends.push({ end });
    side = other;
  });

  // Sleeps between feeds for the last four days.
  starts.forEach((st, i) => {
    if (i === starts.length - 1 || st < now - 4 * DAY) return;
    const from = round5(ends[i].end + between(10, 25) * MIN), to = round5(starts[i + 1] - between(5, 15) * MIN);
    if (to - from >= 30 * MIN) add('baby', from, { kind: 'sleep', start: from, end: to }, 'Mum');
  });

  if (fresh) EVENTS.length = 0;

  // The bar above the header: sample data → "Start fresh"; their own log → "Show sample data".
  const bar = document.createElement('div');
  bar.id = 'demoBar';
  bar.style.cssText = 'display:flex;align-items:center;gap:10px;margin:0 0 12px;padding:8px 8px 8px 14px;border-radius:16px;background:var(--card);box-shadow:0 1px 0 var(--line);font-size:14px;color:var(--dim)';
  bar.innerHTML = fresh
    ? '<span style="flex:1">Your own log, saved on this phone only.</span><button style="padding:8px 12px;border-radius:12px;background:var(--card2);color:var(--text);font-weight:700">Show sample data</button>'
    : '<span style="flex:1">Demo with sample data.</span><button style="padding:8px 12px;border-radius:12px;background:var(--accent);color:#fff;font-weight:700">Start fresh</button>';
  bar.querySelector('button').onclick = async () => {
    const ask = root.askConfirm || (async () => true);
    const ok = await ask(fresh ? 'Go back to the sample data? Everything you logged here will be deleted.' : 'Clear the sample data and start your own log? It stays on this phone only.', fresh ? 'Show sample data' : 'Start fresh');
    if (!ok) return;
    try { clearLog(); if (!fresh) localStorage.setItem('feedlog.demoFresh', '1'); } catch {}
    location.replace(location.pathname + (fresh ? '?reset' : ''));
  };
  const top = document.querySelector('header.top');
  if (top) top.before(bar);

  const L = root.FeedLogic;
  const historyFor = async (room) => Promise.all(EVENTS.map(async (e) => ({ ...e, id: await L.deriveId(room, e.id), room })));
  const missingHistory = (evs, haveIds) => evs.filter((e, i) => !haveIds.has(e.id) && !haveIds.has(EVENTS[i].id));
  root.FeedHistory = { EVENTS, historyFor, missingHistory };
  // Their own log starts with no birth date or weights: they add those in Settings.
  root.DEMO = fresh ? { birth: '', book: [], birthKg: 3.5 } : { birth, book, birthKg: book[0][1] };
})(self);
