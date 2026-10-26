// Feed Log maths. Pure functions only: no DOM, no storage, no clock (callers pass `now`).
// The browser gets window.FeedLogic; the tests get module.exports.
(function (root) {
  const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const t = (e) => new Date(e.at).getTime();
  const other = (side) => (side === 'L' ? 'R' : 'L');

  // ---------- one breast feed: { status, segments: [{ side, start, end|null }] } ----------
  const openSeg = (d) => d.segments.find((s) => s.end == null);
  const lastSeg = (d) => d.segments[d.segments.length - 1];
  const closeOpen = (d, now) => d.segments.map((s) => (s.end == null ? { ...s, end: now } : s));

  function sideTotals(d, now) {
    const tot = { L: 0, R: 0 };
    for (const s of d.segments) tot[s.side] += Math.max(0, (s.end ?? now) - s.start);
    return tot;
  }
  const totalMs = (d, now) => { const x = sideTotals(d, now); return x.L + x.R; };

  const startFeed = (side, now) => ({ status: 'running', segments: [{ side, start: now, end: null }] });
  const pauseFeed = (d, now) => ({ ...d, segments: closeOpen(d, now) });
  const resumeFeed = (d, now) =>
    openSeg(d) ? d : { ...d, segments: [...d.segments, { side: lastSeg(d).side, start: now, end: null }] };
  const switchSide = (d, now) =>
    ({ ...d, segments: [...closeOpen(d, now), { side: other(lastSeg(d).side), start: now, end: null }] });
  const finishFeed = (d, now) => ({ status: 'done', segments: closeOpen(d, now) });

  const isPaused = (d) => d.status === 'running' && !openSeg(d);
  const currentSide = (d) => lastSeg(d).side;
  const feedStart = (d) => Math.min(...d.segments.map((s) => s.start));
  const feedEnd = (d, now) => Math.max(...d.segments.map((s) => s.end ?? now));
  const firstSide = (d) => d.segments.reduce((a, b) => (b.start < a.start ? b : a)).side;
  function lastSide(d) {
    const real = d.segments.filter((s) => (s.end ?? Infinity) > s.start);
    return (real.length ? real[real.length - 1] : lastSeg(d)).side;
  }

  // An edited feed is rewritten as one segment per side, back-to-back from `start`.
  function editFeed({ start, minL, minR, first }) {
    const mins = { L: Math.max(0, Math.round(minL)), R: Math.max(0, Math.round(minR)) };
    if (mins.L + mins.R === 0) return null;
    const segments = [];
    let at = start;
    for (const side of [first, other(first)]) {
      if (!mins[side]) continue;
      segments.push({ side, start: at, end: at + mins[side] * MIN });
      at += mins[side] * MIN;
    }
    return { status: 'done', segments };
  }

  // ---------- formatting ----------
  function fmtDur(ms) {
    const m = Math.max(0, Math.floor(ms / MIN));
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }
  function mmss(ms) {
    const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  // ---------- feeds across events ----------
  const isDoneBreast = (e) => e.type === 'breast' && e.data.status === 'done';
  const isFeed = (e) => isDoneBreast(e) || e.type === 'bottle';
  const startOf = (e) => (e.type === 'breast' ? feedStart(e.data) : t(e));
  const endOf = (e, now) => (e.type === 'breast' ? feedEnd(e.data, now) : t(e));

  // Feeds, oldest first. A bottle within mergeMin of a breast feed is a top-up: the same feed.
  function sessions(events, now, mergeMin) {
    const out = [];
    for (const e of events.filter(isFeed).sort((a, b) => startOf(a) - startOf(b))) {
      const prev = out[out.length - 1], s = startOf(e);
      // A breast feed and a bottle are one feed only if the later one starts within mergeMin of the first start.
      const mixed = prev && (e.type === 'bottle') !== (prev.items[prev.items.length - 1].type === 'bottle');
      if (mixed && s - prev.start <= mergeMin * MIN) {
        prev.items.push(e);
        prev.end = Math.max(prev.end, endOf(e, now));
      } else out.push({ start: s, end: endOf(e, now), items: [e] });
    }
    return out;
  }
  // Repeat feeds of the same kind starting within windowMin of the first one's start are one feed:
  // bottles with bottles, breast feeds that share a side. The earliest entry is kept with the others'
  // time or ml folded in, and the rest are deleted. Deterministic, so both phones agree.
  function reconcileFeeds(events, windowMin) {
    const order = (a, b) => startOf(a) - startOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const sidesOf = (e) => new Set(e.data.segments.map((s) => s.side));
    const groups = [];
    for (const e of events.filter(isFeed).sort(order)) {
      const s = startOf(e), sides = e.type === 'breast' ? sidesOf(e) : null;
      let g = null;
      for (let i = groups.length - 1; i >= 0 && !g; i--) {
        const c = groups[i];
        if (c.type !== e.type || s - c.start > windowMin * MIN) continue;
        if (sides && ![...sides].some((x) => c.sides.has(x))) continue;
        g = c;
      }
      if (g) { g.items.push(e); g.end = Math.max(g.end, endOf(e, 0)); if (sides) sides.forEach((x) => g.sides.add(x)); }
      else groups.push({ type: e.type, start: s, end: endOf(e, 0), sides, items: [e] });
    }
    const updates = [], deletes = [];
    for (const g of groups) {
      if (g.items.length < 2) continue;
      const keep = g.items[0];
      let data;
      if (g.type === 'bottle') data = { ml: g.items.reduce((n, e) => n + (+e.data.ml || 0), 0) };
      else {
        const segs = g.items.flatMap((e) => e.data.segments).sort((a, b) => a.start - b.start || (a.side < b.side ? -1 : 1));
        const merged = [];
        for (const x of segs) {
          const last = [...merged].reverse().find((m) => m.side === x.side);
          if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
          else merged.push({ side: x.side, start: x.start, end: x.end });
        }
        data = { status: 'done', segments: merged };
      }
      updates.push({ ...keep, at: g.type === 'bottle' ? keep.at : new Date(feedStart(data)).toISOString(), data });
      deletes.push(...g.items.slice(1).map((e) => e.id));
    }
    return { updates, deletes };
  }
  function nextDue(events, now, intervalMin, mergeMin) {
    const ss = sessions(events, now, mergeMin);
    return ss.length ? ss[ss.length - 1].start + intervalMin * MIN : null;
  }
  function startOnSide(events) {
    const last = events.filter(isDoneBreast).sort((a, b) => startOf(b) - startOf(a))[0];
    return last ? other(lastSide(last.data)) : 'L';
  }
  const feedCount = (events, from, to, now, mergeMin) =>
    sessions(events, now, mergeMin).filter((s) => s.start >= from && s.start < to).length;

  // ---------- days ----------
  function dayStart(now, hour) {
    const d = new Date(now);
    d.setHours(hour, 0, 0, 0);
    if (d.getTime() > now) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  function shiftDay(ms, n) { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); }

  // ---------- milk ----------
  function todayTotals(events, start, now, mlPerMin) {
    let L = 0, R = 0, bottleMl = 0, bottles = 0;
    for (const e of events) {
      if (isDoneBreast(e) && feedStart(e.data) >= start) { const x = sideTotals(e.data, now); L += x.L; R += x.R; }
      if (e.type === 'bottle' && t(e) >= start && t(e) <= now) { bottleMl += +e.data.ml || 0; bottles++; }
    }
    const breastMin = Math.round((L + R) / MIN);
    return { L, R, breastMin, estBreastMl: Math.round(breastMin * mlPerMin), bottleMl, bottles };
  }
  const round10 = (x) => Math.round(x / 10) * 10;
  const targetRange = (kg, [lo, hi]) => [round10(kg * lo), round10(kg * hi)];
  function topUp(target, bottleMl, estBreastMl, bottleSize) {
    const remaining = Math.max(0, round10(target - bottleMl - estBreastMl));
    return { remaining, bottles: remaining ? Math.ceil(remaining / bottleSize) : 0 };
  }

  // ---------- weight ----------
  const weights = (events) => events.filter((e) => e.type === 'weight' && +e.data.kg > 0).sort((a, b) => t(b) - t(a));
  const latestKg = (events, fallback) => { const w = weights(events)[0]; return w ? +w.data.kg : fallback; };
  // Gain between the latest weight and the most recent one at least minDays before it.
  function weightGain(events, minGain, ageDays, minDays = 2) {
    const ws = weights(events), a = ws[0];
    const b = a && ws.find((x) => t(a) - t(x) >= minDays * DAY);
    if (!b) return null;
    const gPerWeek = Math.round(((a.data.kg - b.data.kg) * 1000 * 7 * DAY) / (t(a) - t(b)));
    const band = Math.abs(gPerWeek) > 600 ? 'check' : ageDays != null && ageDays < 14 ? 'early'
      : gPerWeek >= minGain ? 'green' : gPerWeek >= 100 ? 'amber' : 'red';
    return { gPerWeek, band, since: t(b), kg: +a.data.kg };
  }

  // ---------- night ----------
  // The most recently finished night window, e.g. [yesterday 19:00, today 07:00].
  function lastNight(now, [from, to]) {
    const end = new Date(now);
    end.setHours(to, 0, 0, 0);
    if (end.getTime() > now) end.setDate(end.getDate() - 1);
    const start = new Date(end);
    start.setDate(start.getDate() - 1);
    start.setHours(from, 0, 0, 0);
    return [start.getTime(), end.getTime()];
  }
  function longestNightGap(events, now, night, mergeMin) {
    const [ws, we] = lastNight(now, night), ss = sessions(events, now, mergeMin);
    let best = null;
    for (let i = 1; i < ss.length; i++) {
      const from = ss[i - 1].end, to = ss[i].start;
      if (to > ws && from < we && (!best || to - from > best.ms)) best = { ms: to - from, from, to };
    }
    return best;
  }

  // ---------- timeline strip ----------
  function dayBlocks(events, start, end, now) {
    const len = end - start, pct = (x) => ((x - start) / len) * 100, out = [];
    for (const e of events) {
      if (e.type === 'breast') for (const s of e.data.segments) {
        const a = Math.max(s.start, start), b = Math.min(s.end ?? now, end);
        if (b > a) out.push({ id: e.id, kind: s.side, left: pct(a), width: Math.max(0.4, pct(b) - pct(a)) });
      }
      if (e.type === 'bottle' && t(e) >= start && t(e) < end) out.push({ id: e.id, kind: 'bottle', left: pct(t(e)), width: 0.8 });
    }
    return out;
  }

  // ---------- running feed ----------
  function pickRunning(events) {
    const r = events.filter((e) => e.type === 'breast' && e.data.status === 'running')
      .sort((a, b) => feedStart(b.data) - feedStart(a.data));
    return { current: r[0] || null, stale: r.slice(1) };
  }


  // ---------- safety ----------
  const finite = (x) => typeof x === 'number' && Number.isFinite(x);
  // Rows come from the other phone or anyone holding the room link: keep only well-formed ones.
  function normalize(r) {
    if (!r || typeof r.id !== 'string' || Number.isNaN(Date.parse(r.at))) return null;
    const d = r.data && typeof r.data === 'object' ? r.data : {};
    const base = { ...r, by_name: typeof r.by_name === 'string' ? r.by_name : '' };
    switch (r.type) {
      case 'bottle': { const ml = typeof d.ml === 'number' ? d.ml : NaN; return ml > 0 && ml < 1000 ? { ...base, data: { ml } } : null; }
      case 'weight': { const kg = typeof d.kg === 'number' ? d.kg : NaN; return kg > 0 && kg < 30 ? { ...base, data: { kg } } : null; }
      case 'breast': {
        const segs = Array.isArray(d.segments) ? d.segments : [];
        if (!segs.length || (d.status !== 'running' && d.status !== 'done')) return null;
        const ok = segs.every((s) => s && (s.side === 'L' || s.side === 'R') && finite(s.start)
          && (s.end == null ? d.status === 'running' : finite(s.end)));
        return ok ? { ...base, data: { status: d.status, segments: segs.map((s) => ({ side: s.side, start: s.start, end: s.end ?? null })) } } : null;
      }
      case 'baby': {
        // Sleeps ride on the 'baby' type so no database change is needed: data { kind: 'sleep', start, end|null }.
        if (d.kind === 'sleep') {
          const ok = finite(d.start) && (d.end == null || (finite(d.end) && d.end >= d.start));
          return ok ? { ...base, data: { kind: 'sleep', start: d.start, end: d.end ?? null } } : null;
        }
        return { ...base, data: d };
      }
      default: return null;
    }
  }
  // "Back to timer" after Stop: null if the other phone already saved it; otherwise restore the state at Stop.
  const backToTimer = (d, wasPaused, now) => (d.status !== 'running' ? null : wasPaused ? d : resumeFeed(d, now));
  // A jump over 20% from the last weight is probably pounds or a typo.
  const suspectWeight = (kg, prevKg) => !!prevKg && Math.abs(kg - prevKg) / prevKg > 0.2;
  const validRoom = (room) => /^[a-z0-9]{8,32}$/.test(room || '');


  // ---------- invite links and backups ----------
  const validCode = (code) => /^[A-Za-z0-9_-]{20,64}$/.test(code || '');
  const inviteLink = (base, room, code) => `${base}?room=${room}&code=${code}`;
  // Accepts a bare link or a whole pasted message that contains one.
  function parseInvite(text) {
    const m = String(text || '').match(/https?:\/\/\S+/);
    if (!m) return null;
    let u;
    try { u = new URL(m[0]); } catch { return null; }
    const room = u.searchParams.get('room'), code = u.searchParams.get('code');
    return validRoom(room) && validCode(code) ? { room, code } : null;
  }
  const backupFile = (room, events, now) =>
    ({ app: 'feed-log', version: 1, room, exported_at: new Date(now).toISOString(), events });
  // Restores into `room`, whatever log the file came from; malformed rows are dropped and counted.
  function parseBackup(text, room) {
    let f;
    try { f = JSON.parse(text); } catch { return null; }
    if (!f || f.app !== 'feed-log' || f.version !== 1 || !Array.isArray(f.events)) return null;
    const events = [];
    for (const r of f.events) { const ev = normalize({ ...r, room }); if (ev) events.push(ev); }
    return { events, skipped: f.events.length - events.length };
  }


  // ---------- growth (WHO Child Growth Standards, girls, weight-for-age) ----------
  // [age in days, L, M, S]: weekly to 13 weeks, then monthly to 12 months. UK-WHO charts use these from 2 weeks.
  const WHO_GIRLS_WFA = [
    [0, 0.3809, 3.2322, 0.14171], [7, 0.2671, 3.3388, 0.146], [14, 0.2304, 3.5693, 0.14339],
    [21, 0.2024, 3.8352, 0.1406], [28, 0.1789, 4.0987, 0.13805], [35, 0.1582, 4.3476, 0.13583],
    [42, 0.1395, 4.5793, 0.13392], [49, 0.1224, 4.795, 0.13228], [56, 0.1065, 4.9959, 0.13087],
    [63, 0.0918, 5.1842, 0.12966], [70, 0.0779, 5.3618, 0.12861], [77, 0.0648, 5.5295, 0.1277],
    [84, 0.0525, 5.6883, 0.12691], [91, 0.0407, 5.8393, 0.12622],
    [122, -0.005, 6.4237, 0.12402], [152, -0.043, 6.8985, 0.12274], [183, -0.0756, 7.297, 0.12204],
    [213, -0.1039, 7.6422, 0.12178], [243, -0.1288, 7.9487, 0.12181], [274, -0.1507, 8.2254, 0.12199],
    [304, -0.17, 8.48, 0.12223], [335, -0.1872, 8.7192, 0.12247], [365, -0.2024, 8.9481, 0.12268],
  ];
  function lmsAt(ageDays) {
    const T = WHO_GIRLS_WFA, a = Math.max(0, Math.min(ageDays, T[T.length - 1][0]));
    let i = 0;
    while (i < T.length - 2 && T[i + 1][0] <= a) i++;
    const [d0, L0, M0, S0] = T[i], [d1, L1, M1, S1] = T[i + 1], f = Math.min(1, (a - d0) / (d1 - d0));
    if (f === 0) return { L: L0, M: M0, S: S0 };
    if (f === 1) return { L: L1, M: M1, S: S1 };
    return { L: L0 + f * (L1 - L0), M: M0 + f * (M1 - M0), S: S0 + f * (S1 - S0) };
  }
  const zFromWeight = (kg, ageDays) => { const { L, M, S } = lmsAt(ageDays); return ((kg / M) ** L - 1) / (L * S); };
  const weightFromZ = (z, ageDays) => { const { L, M, S } = lmsAt(ageDays); return M * (1 + L * S * z) ** (1 / L); };
  function centileFromZ(z) {   // standard normal CDF, Abramowitz & Stegun 7.1.26
    const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return 50 * (1 + (z < 0 ? -erf : erf));
  }
  // UK chart centile lines sit 2/3 of a standard deviation apart.
  const CENTILE_LINES = [[-2, '2nd'], [-4 / 3, '9th'], [-2 / 3, '25th'], [0, '50th'], [2 / 3, '75th'], [4 / 3, '91st'], [2, '98th']];
  function centileName(centile) {
    const p = Math.min(99.999, Math.max(0.001, centile) ) / 100;
    let lo = -8, hi = 8;   // invert the CDF by bisection
    for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (centileFromZ(mid) / 100 < p) lo = mid; else hi = mid; }
    const z = lo, on = CENTILE_LINES.find(([lz]) => Math.abs(z - lz) <= 0.1);
    if (on) return `on the ${on[1]}`;
    if (z > 2) return 'above the 98th';
    if (z < -2) return 'below the 2nd';
    const i = CENTILE_LINES.findIndex(([lz]) => lz > z);
    return `between the ${CENTILE_LINES[i - 1][1]} and ${CENTILE_LINES[i][1]}`;
  }
  function nextWeekday(now, weekday) {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    do d.setDate(d.getDate() + 1); while (d.getDay() !== weekday);
    return d.getTime();
  }
  // Her weigh-ins on the curves, last week's gain, and what staying on her line looks like next.
  function growthReport(events, birthDate, now, checkInDay = 2) {
    const birth = new Date(birthDate + 'T00:00').getTime();
    if (!birthDate || Number.isNaN(birth)) return null;
    const ageOf = (ms) => Math.floor((ms - birth) / DAY);
    // One weigh-in per day: if a day was entered twice, the most recently entered one wins.
    const byDay = new Map();
    for (const e of weights(events).reverse().filter((x) => t(x) >= birth && t(x) <= now + DAY)) {   // ignore mis-dated future entries
      const day = new Date(t(e)).toDateString(), had = byDay.get(day);
      if (!had || String(e.created_at || '') >= String(had.created_at || '')) byDay.set(day, e);
    }
    const points = [...byDay.values()].sort((a, b) => t(a) - t(b))
      .map((e) => { const ageDays = ageOf(t(e)), kg = +e.data.kg, z = zFromWeight(kg, ageDays); return { at: t(e), ageDays, kg, z, centile: centileFromZ(z) }; });
    if (!points.length) return null;
    const latest = points[points.length - 1];
    const prev = [...points].reverse().find((p) => p.ageDays <= latest.ageDays - 2);
    const lastWeekGrams = prev ? Math.round(((latest.kg - prev.kg) * 1000 * 7) / (latest.ageDays - prev.ageDays)) : null;
    const holdGramsPerWeek = Math.round((weightFromZ(latest.z, latest.ageDays + 7) - weightFromZ(latest.z, latest.ageDays)) * 1000);
    const nextAt = nextWeekday(now, checkInDay), expKg = weightFromZ(latest.z, ageOf(nextAt));
    // Weigh-in to weigh-in: last week's gain against what would have kept her on her line, and this week's goal.
    const lastWeek = prev ? { fromAt: prev.at, toAt: latest.at, gainedG: Math.round((latest.kg - prev.kg) * 1000),
      goalG: Math.round((weightFromZ(prev.z, latest.ageDays) - prev.kg) * 1000) } : null;
    const thisWeek = { fromAt: latest.at, toAt: nextAt, goalG: Math.round((expKg - latest.kg) * 1000), targetKg: expKg };
    return { points, latest, prev, lastWeekGrams, holdGramsPerWeek, lastWeek, thisWeek, expected: { at: nextAt, ageDays: ageOf(nextAt), kg: expKg } };
  }


  // Time between feeds: 2 to 3 hours in 15-minute steps.
  const INTERVAL_CHOICES = [120, 135, 150, 165, 180];
  const intervalLabel = (min) => { const h = Math.floor(min / 60), m = min % 60; return m ? `${h} hrs ${m}` : `${h} hrs`; };


  // Red-book weigh-ins baked into the app: [ 'yyyy-mm-dd', kg ]. A weigh-in logged in the app on the same day wins.
  function withBuiltinWeights(events, builtins) {
    const logged = new Set(events.filter((e) => e.type === 'weight').map((e) => new Date(e.at).toDateString()));
    const extra = builtins
      .map(([date, kg]) => ({ id: 'redbook-' + date, type: 'weight', at: new Date(date + 'T12:00').toISOString(), by_name: 'Red book', data: { kg }, builtin: true }))
      .filter((e) => !logged.has(new Date(e.at).toDateString()));
    return [...events, ...extra];
  }


  // ---------- feeding patterns ----------
  // Feeds in a window, by kind: breast only, bottle only, or breast with a bottle top-up.
  function feedMix(events, from, to, now, mergeMin) {
    const out = { feeds: 0, breast: 0, bottle: 0, both: 0 };
    for (const s of sessions(events, now, mergeMin)) {
      if (s.start < from || s.start >= to) continue;
      const hasBreast = s.items.some((e) => e.type === 'breast'), hasBottle = s.items.some((e) => e.type === 'bottle');
      out.feeds++;
      out[hasBreast && hasBottle ? 'both' : hasBreast ? 'breast' : 'bottle']++;
    }
    return out;
  }
  // One row per day (days start at `hour`), oldest first: feeds, breast minutes, bottle ml, estimated total ml.
  function dailySummary(events, now, days, hour, mlPerMin, mergeMin = 30) {
    const today = dayStart(now, hour), out = [];
    for (let i = days - 1; i >= 0; i--) {
      const start = shiftDay(today, -i), end = shiftDay(start, 1);
      let ms = 0, bottleMl = 0;
      for (const e of events) {
        if (isDoneBreast(e) && feedStart(e.data) >= start && feedStart(e.data) < end) ms += totalMs(e.data, now);
        if (e.type === 'bottle' && t(e) >= start && t(e) < end) bottleMl += +e.data.ml || 0;
      }
      const breastMin = Math.round(ms / MIN);
      out.push({ start, feeds: feedCount(events, start, end, now, mergeMin), breastMin, bottleMl, estMl: Math.round(breastMin * mlPerMin) + bottleMl });
    }
    return out;
  }
  // The 3-hour window of the day with the most feeds starting in it.
  function busiestHours(events, from, to, mergeMin) {
    const counts = new Array(24).fill(0);
    let any = false;
    for (const s of sessions(events, to, mergeMin)) if (s.start >= from && s.start < to) { counts[new Date(s.start).getHours()]++; any = true; }
    if (!any) return null;
    let best = null;
    for (let h = 0; h < 24; h++) {
      const c = counts[h] + counts[(h + 1) % 24] + counts[(h + 2) % 24];
      if (!best || c > best.count) best = { startHour: h, count: c };
    }
    return best;
  }


  // Which log to open at launch. A full share link (room + code) switches logs; a leftover address
  // with only a room never overrides the phone's own log (pairing it with this phone's code is
  // what made "Join this log" appear on every launch).
  function pickRoom({ urlRoom, urlCode, storedRoom, storedCode, family }) {
    if (family && validRoom(family.room) && validCode(family.code)) return { room: family.room, code: family.code };   // one log for both phones
    if (validRoom(urlRoom) && validCode(urlCode)) return { room: urlRoom, code: urlCode };
    if (validRoom(storedRoom)) return { room: storedRoom, code: storedCode || '' };
    if (validRoom(urlRoom)) return { room: urlRoom, code: '' };
    return { room: '', code: '' };
  }


  // A stable UUID for (log, original id): a name-based id from SHA-256, so copying twice never duplicates.
  async function deriveId(room, id) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(room + ':' + id));
    const b = new Uint8Array(hash).slice(0, 16);
    b[6] = (b[6] & 0x0f) | 0x50;   // version 5 style
    b[8] = (b[8] & 0x3f) | 0x80;   // RFC 4122 variant
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  // A phone's entries from its old log, ready for the family log: feeds, bottles and weigh-ins only
  // (the family log has its own settings and built-in history), with stable new ids.
  async function rowsToMove(rows, familyRoom, skipIds) {
    const keep = rows.filter((r) => ['breast', 'bottle', 'weight'].includes(r.type) && !skipIds.has(r.id));
    return Promise.all(keep.map(async (r) => ({ ...r, id: await deriveId(familyRoom, r.id), room: familyRoom })));
  }


  const roomsIn = (rows, exclude) => [...new Set(rows.map((r) => r.room))].filter((r) => r !== exclude && validRoom(r));


  // Typed times: "HH:MM" on the same calendar day as `base`; if that lands more than 5 minutes after now,
  // it must mean the day before (e.g. typing 23:40 just after midnight).
  const hhmm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  function timeOnDay(base, text, now) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
    if (!m || +m[1] > 23 || +m[2] > 59) return null;
    const d = new Date(base);
    d.setHours(+m[1], +m[2], 0, 0);
    if (d.getTime() > now + 5 * MIN) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  // A new entry timed limitH hours or more ago is probably a slip (12:20 picked for 00:20 lands on
  // yesterday afternoon). Says how long ago it is, and the time 12 hours later if that's still not in the future.
  function farInPast(ms, now, limitH) {
    if (now - ms < limitH * HOUR) return null;
    const flip = ms + 12 * HOUR;
    return { hours: Math.round((now - ms) / HOUR), flip: flip <= now + 5 * MIN ? flip : null };
  }


  // ---------- sleep ----------
  const isSleep = (e) => e.type === 'baby' && !!e.data && e.data.kind === 'sleep';
  // Is she asleep or awake, since when, how long was she awake before her latest sleep, and today's total.
  function sleepState(events, now, dayHour) {
    const sleeps = events.filter(isSleep).sort((a, b) => a.data.start - b.data.start);
    const out = { asleep: false, since: null, current: null, lastSleepMs: null, awakeBefore: null, todayMs: 0, todayCount: 0 };
    if (!sleeps.length) return out;
    const open = sleeps.filter((e) => e.data.end == null), done = sleeps.filter((e) => e.data.end != null);
    const endBefore = (t0, skip) => {
      const ends = done.filter((e) => e !== skip && e.data.end <= t0).map((e) => e.data.end);
      return ends.length ? Math.max(...ends) : null;
    };
    let anchor;
    if (open.length) {
      out.current = open[open.length - 1];
      out.asleep = true;
      out.since = out.current.data.start;
      anchor = out.current;
    } else {
      anchor = done.reduce((a, b) => (b.data.end > a.data.end ? b : a));
      out.since = anchor.data.end;
      out.lastSleepMs = anchor.data.end - anchor.data.start;
    }
    const prevEnd = endBefore(anchor.data.start, anchor);
    out.awakeBefore = prevEnd == null ? null : anchor.data.start - prevEnd;
    const from = dayStart(now, dayHour);
    for (const e of sleeps) {
      const a = Math.max(from, e.data.start), b = Math.min(now, e.data.end ?? now);
      if (b > a) { out.todayMs += b - a; out.todayCount++; }
    }
    return out;
  }


  // One row per day (days start at dayHour), oldest first: time asleep, number of sleeps, longest sleep,
  // and the average awake window (from waking up to the next sleep starting that day).
  function dailySleep(events, now, days, dayHour) {
    const sleeps = events.filter(isSleep).sort((a, b) => a.data.start - b.data.start);
    const today = dayStart(now, dayHour), out = [];
    for (let i = days - 1; i >= 0; i--) {
      const start = shiftDay(today, -i), end = Math.min(shiftDay(start, 1), now);
      let ms = 0, count = 0, longest = 0;
      const gaps = [];
      sleeps.forEach((e, k) => {
        const a = Math.max(start, e.data.start), b = Math.min(end, e.data.end ?? now);
        if (b > a) { ms += b - a; count++; longest = Math.max(longest, b - a); }
        const prev = sleeps[k - 1];
        if (prev && prev.data.end != null && e.data.start >= start && e.data.start < end && e.data.start > prev.data.end) gaps.push(e.data.start - prev.data.end);
      });
      out.push({ start, ms, count, longest, avgAwakeMs: gaps.length ? gaps.reduce((x, y) => x + y, 0) / gaps.length : null });
    }
    return out;
  }


  // Her age for the header: days for the first 2 weeks, then weeks and days, then months.
  function ageLabel(d) {
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (d < 14) return `${plural(d, 'day')} old`;
    if (d < 91) { const w = Math.floor(d / 7), r = d % 7; return `${plural(w, 'week')}${r ? ' ' + plural(r, 'day') : ''} old`; }
    return `${plural(Math.floor(d / 30.44), 'month')} old`;
  }

  const api = {
    MIN, DAY, other,
    sideTotals, totalMs, startFeed, pauseFeed, resumeFeed, switchSide, finishFeed,
    isPaused, currentSide, feedStart, feedEnd, firstSide, lastSide, editFeed,
    fmtDur, mmss,
    isFeed, startOf, endOf, sessions, nextDue, startOnSide, feedCount,
    dayStart, shiftDay, todayTotals, targetRange, topUp,
    weights, latestKg, weightGain, longestNightGap, dayBlocks, pickRunning,
    normalize, backToTimer, suspectWeight, validRoom, reconcileFeeds, farInPast,
    validCode, inviteLink, parseInvite, backupFile, parseBackup,
    pickRoom, deriveId, rowsToMove, roomsIn, hhmm, timeOnDay, ageLabel,
    lmsAt, zFromWeight, weightFromZ, centileFromZ, centileName, nextWeekday, growthReport, CENTILE_LINES,
    INTERVAL_CHOICES, intervalLabel,
    withBuiltinWeights,
    feedMix, dailySummary, busiestHours, isSleep, sleepState, dailySleep,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FeedLogic = api;
})(typeof self !== 'undefined' ? self : this);
