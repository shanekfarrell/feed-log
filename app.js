// ================= CONFIG — edit these =================
const CONFIG = {
  SUPABASE_URL: '',   // your Supabase project URL; blank = this-phone-only mode
  // One shared log for both phones: every phone opens it automatically, so there's nothing to join.
  // Private app: the code sits in the page source, like her details below.
  FAMILY: null,   // optional: { room, code } to open every phone straight into one shared log
  HOME_URL: '',
  SUPABASE_ANON_KEY: '',   // public by design; never put a secret key here

  // Her details, so nobody has to type them in. Private app: these sit in the page source.
  BABY: { name: '', birth: '' },   // or fill in, e.g. { name: 'Sam', birth: '2026-01-31' }
  REDBOOK_WEIGHTS: [],   // optional built-in weigh-ins: [['2026-01-31', 3.4], ...]
  DEFAULT_WEIGHT_KG: 3.5,       // birth weight; used until a weight check-in is added in ⚙︎
  TARGET_ML_PER_KG: [150, 200],
  FEEDS_PER_DAY: [8, 12],
  WEIGHT_GAIN_G_PER_WEEK: [150, 200],
  FEED_INTERVAL_MIN: 150,        // every 2½ hours: next due = start of last feed + this (change it from the Next Feed card)
  LONG_FEED_WARN_MIN: 45,        // "Still feeding?" banner after this much timer time
  BREAST_ML_PER_MIN: 5,          // rough estimate of milk per breast minute (can be changed in ⚙︎)
  REPEAT_FEED_MIN: 60,           // same side (or bottle after bottle) starting within this long of the first one's start = one feed
  TOPUP_MERGE_MIN: 60,           // a bottle starting within this long of a breast feed's start (or vice versa) counts as the same feed
  DAY_START_HOUR: 5,             // "today" starts at 05:00, not midnight
  NIGHT: [19, 7],                // window for "longest stretch last night"
  TIMELINE_DAYS: 7,

  TIME_STEP_MIN: 5,
  ML_STEP: 10,
  DEFAULT_ML: 60,
};
// ========================================================

const F = window.FeedLogic;
const MIN = 60e3, HOUR = 60 * MIN;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get: (k) => { try { return localStorage.getItem('feedlog.' + k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem('feedlog.' + k, v); } catch {} },
};
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const posNum = (v) => { const n = parseFloat(String(v).replace(',', '.')); return n > 0 ? n : 0; };

// ---------- room + identity ----------
const params = new URLSearchParams(location.search);
const randomFrom = (alphabet, n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => alphabet[b % alphabet.length]).join('');
const newRoom = () => randomFrom('abcdefghjkmnpqrstuvwxyz23456789', 9);
const newCode = () => randomFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 24);
// Settled in bootstrap(): the link opened, else this phone's log, else (after email sign-in) the account's log, else a new one.
let room = F.validRoom(ls.get('room')) ? ls.get('room') : '';
let code = ls.get('code');
function setRoom(r, c) {
  room = r; code = c;
  ls.set('room', room); ls.set('code', code);
  // Clean address: a saved home-screen icon or tab must never carry a log name around (see pickRoom).
  history.replaceState(null, '', location.pathname);
}
const sb = CONFIG.SUPABASE_URL ? supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY) : null;

let me = ls.get('name');
let partnerPhone = ls.get('partner');

// ---------- storage ----------
function supaStore() {
  return {
    async load() {
      const since = new Date(Date.now() - (CONFIG.TIMELINE_DAYS + 1) * 24 * HOUR).toISOString();
      const res = await Promise.all([
        sb.from('events').select('*').eq('room', room).gte('at', since).order('at', { ascending: false }),
        sb.from('events').select('*').eq('room', room).eq('type', 'baby').order('at', { ascending: false }).limit(1),
        sb.from('events').select('*').eq('room', room).eq('type', 'weight').order('at', { ascending: false }).limit(20),
      ]);
      for (const r of res) if (r.error) throw r.error;
      return [...new Map(res.flatMap((r) => r.data).map((e) => [e.id, e])).values()];
    },
    // Idempotent: a retry after a lost response must not fail on the duplicate id.
    // Errors carry the HTTP status, so the write queue can tell a server outage (retry) from a rejection (drop).
    async insert(ev) { const { error, status } = await sb.from('events').upsert(ev, { onConflict: 'id', ignoreDuplicates: true }); if (error) throw Object.assign(error, { status }); },
    async update(ev) { const { error, status } = await sb.from('events').update({ at: ev.at, data: ev.data }).eq('id', ev.id); if (error) throw Object.assign(error, { status }); },
    async remove(id) { const { error, status } = await sb.from('events').delete().eq('id', id); if (error) throw Object.assign(error, { status }); },
    async exportAll() {
      const out = [];
      for (let i = 0; ; i += 1000) {   // the API returns at most 1,000 rows per request
        const { data, error } = await sb.from('events').select('*').eq('room', room).order('at').range(i, i + 999);
        if (error) throw error;
        out.push(...data);
        if (data.length < 1000) return out;
      }
    },
    async importMany(evs) {
      if (!evs.length) return 0;
      const { data, error } = await sb.from('events').upsert(evs, { onConflict: 'id', ignoreDuplicates: true }).select('id');
      if (error) throw error;
      return data.length;
    },
    async otherRooms() {   // every other log this phone belongs to (the database only shows logs it has joined)
      const rows = [];
      for (let i = 0; ; i += 1000) {
        const { data, error } = await sb.from('events').select('room').neq('room', room).range(i, i + 999);
        if (error) throw error;
        rows.push(...data);
        if (data.length < 1000) return F.roomsIn(rows, room);
      }
    },
    async exportRoom(name, since) {   // entries in another log this phone belongs to, optionally only those added since a time
      const out = [];
      for (let i = 0; ; i += 1000) {
        let q = sb.from('events').select('*').eq('room', name);
        if (since) q = q.gt('created_at', since);
        const { data, error } = await q.order('at').range(i, i + 999);
        if (error) throw error;
        out.push(...data);
        if (data.length < 1000) return out;
      }
    },
    async existingIds(ids) {   // which of these ids are in this log (chunked to keep the request short)
      const out = [];
      for (let i = 0; i < ids.length; i += 100) {
        const { data, error } = await sb.from('events').select('id').eq('room', room).in('id', ids.slice(i, i + 100));
        if (error) throw error;
        out.push(...data.map((r) => r.id));
      }
      return out;
    },
    async loadRange(from, to) {
      const { data, error } = await sb.from('events').select('*').eq('room', room)
        .gte('at', new Date(from).toISOString()).lt('at', new Date(to).toISOString()).order('at').limit(1000);
      if (error) throw error;
      return data;
    },
    subscribe(onUpsert, onDelete) {
      const roomFilter = 'room=eq.' + room;
      sb.channel('room-' + room)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events', filter: roomFilter }, (p) => onUpsert(p.new))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'events', filter: roomFilter }, (p) => onUpsert(p.new))
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'events' }, (p) => onDelete(p.old.id))
        .subscribe();
    },
  };
}

function localStore() {
  const key = () => 'demo.' + room;
  const read = () => { try { return JSON.parse(ls.get(key()) || '[]'); } catch { return []; } };
  const write = (a) => ls.set(key(), JSON.stringify(a));
  return {
    async load() { return read(); },
    async insert(ev) { const a = read(); if (!a.some((e) => e.id === ev.id)) write([...a, ev]); },
    async update(ev) { write(read().map((e) => (e.id === ev.id ? ev : e))); },
    async remove(id) { write(read().filter((e) => e.id !== id)); },
    async exportAll() { return read(); },
    async existingIds(ids) { const want = new Set(ids); return read().filter((e) => want.has(e.id)).map((e) => e.id); },
    async exportRoom(name) { try { return JSON.parse(ls.get('demo.' + name) || '[]'); } catch { return []; } },
    async otherRooms() {
      const names = [];
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('feedlog.demo.')) names.push(k.slice(13)); } } catch {}
      return F.roomsIn(names.map((r) => ({ room: r })), room);
    },
    async loadRange(from, to) { return read().filter((e) => { const x = new Date(e.at).getTime(); return x >= from && x < to; }); },
    async importMany(evs) {
      const a = read(), have = new Set(a.map((e) => e.id)), add = evs.filter((e) => !have.has(e.id));
      write([...a, ...add]);
      return add.length;
    },
    subscribe() {},
  };
}

const store = sb ? supaStore() : localStore();

// ---------- sign-in and joining ----------
// Signs this phone in (silently, no password) and joins the log. False means a blocking sheet is showing.
async function bootstrap() {
  let { room: r, code: c } = F.pickRoom({ urlRoom: params.get('room'), urlCode: params.get('code'), storedRoom: room, storedCode: code, family: CONFIG.FAMILY });
  if (!sb) { setRoom(r || newRoom(), ''); return true; }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const { error } = await sb.auth.signInAnonymously();
    if (error) { console.error(error); blockSheet('connect'); return false; }
  } else if (!r && !session.user.is_anonymous) {
    const { data } = await sb.rpc('my_room');   // signed in by email on a new phone
    if (data && data[0]) { r = data[0].room; c = data[0].join_code; }
  }
  if (!r) r = newRoom();
  if (!F.validCode(c)) c = newCode();   // a new log, or one made before join codes: the first phone claims it
  setRoom(r, c);
  const joined = sb.rpc('join_room', { p_room: r, p_code: c }).then(async ({ error }) => {
    if (!error) return true;
    console.error(error);
    if (/bad_code/.test(error.message)) {
      // Safety net: this phone may already belong to a log. Open that instead of asking for a link.
      const { data } = await sb.rpc('my_room');
      const mine = data && data[0];
      if (mine) {
        setRoom(mine.room, mine.join_code);
        if (mine.room !== r) { location.reload(); return false; }
        return true;
      }
      blockSheet('link');
      return false;
    }
    if (!session) { blockSheet('connect'); return false; }
    return true;   // offline with a session: carry on with what this phone has
  });
  return session ? true : joined;   // a returning phone doesn't wait for the network
}

const pasteBox = () => `<label class="set-label">Have a link from your partner? Paste it here</label>
  <div class="row"><input class="field" id="pLink" placeholder="https://…"><button class="secondary inline" id="pJoin">Join</button></div>`;
const wirePaste = () => { $('#pJoin').onclick = () => joinFromText($('#pLink').value); };
function joinFromText(text) {
  const inv = F.parseInvite(text);
  if (!inv) return toast('That doesn’t look like a Feed Log link');
  ls.set('room', inv.room); ls.set('code', inv.code);
  location.replace(location.pathname);
}
const shareLink = () => sb ? F.inviteLink(location.origin + location.pathname, room, code) : `${location.origin}${location.pathname}?room=${room}`;

function blockSheet(kind) {
  sheet = null;
  if (kind === 'connect') {
    openSheet(`<h3>No connection</h3><p>Couldn’t connect. Check your internet and try again.</p>
      <button class="confirm" id="bRetry">Try again</button>`, false);
    $('#bRetry').onclick = () => location.reload();
    return;
  }
  openSheet(`<h3>Join this log</h3><p>Ask your partner to send the log’s link again.</p>
    ${pasteBox()}
    <button class="secondary" id="bEmail">Get back in by email</button>
    <button class="secondary" id="bNew">Start a new log instead</button>`, false);
  wirePaste();
  $('#bEmail').onclick = openRecovery;
  $('#bNew').onclick = () => { ls.set('room', ''); ls.set('code', ''); location.replace(location.pathname); };
}

// New phone: email code → sign in as the account that owns the recovery email → back to its log.
function openRecovery() {
  sheet = null;
  openSheet(`<h3>Get back in by email</h3>
    <label class="set-label">Your recovery email</label>
    <input class="field" id="rEmail" type="email" inputmode="email" autocomplete="email">
    <button class="confirm" id="rSend">Email me a code</button>
    <div id="rStep2" hidden>
      <label class="set-label">Code from the email</label>
      <input class="field" id="rCode" inputmode="numeric" autocomplete="one-time-code">
      <button class="confirm" id="rVerify">Sign in</button>
    </div>
    <p class="fine">If the email has a link instead of a code: tap it, then in the page that opens go to ⚙︎ → Copy log link, and paste it into this app.</p>`);
  $('#rSend').onclick = async () => {
    const email = $('#rEmail').value.trim();
    if (!email) return $('#rEmail').focus();
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname } });
    if (error) {
      console.error(error);
      return toast(/signup|not found|not allowed/i.test(error.message) ? 'That email isn’t set up for recovery yet. Ask your partner for the link instead.' : error.message);
    }
    $('#rStep2').hidden = false;
    $('#rCode').focus();
  };
  $('#rVerify').onclick = async () => {
    const { error } = await sb.auth.verifyOtp({ email: $('#rEmail').value.trim(), token: $('#rCode').value.trim(), type: 'email' });
    if (error) { console.error(error); return toast('That code didn’t work. Check it, or send a new one.'); }
    const { data } = await sb.rpc('my_room');
    if (!data || !data[0]) return toast('Signed in, but no log was found for this email');
    ls.set('room', data[0].room); ls.set('code', data[0].join_code);
    location.replace(location.pathname);
  };
}

async function renderRecovery() {
  const { data } = await sb.auth.getUser();
  const el = $('#sRecovery'), user = data && data.user;
  if (!el) return;
  if (user && user.email) el.innerHTML = `Set to <b>${esc(user.email)}</b>. On a new phone, use “Get back in by email”.`;
  else if (user && user.new_email) el.innerHTML = `Waiting for you to confirm <b>${esc(user.new_email)}</b>. Check your inbox.`;
  else {
    el.innerHTML = `<div class="row"><input class="field" id="rSet" type="email" inputmode="email" placeholder="you@example.com"><button class="secondary inline" id="rSave">Save</button></div>
      Recovery emails only reach the Supabase account owner’s address. Others: ask your partner for the link.`;
    $('#rSave').onclick = async () => {
      const email = $('#rSet').value.trim();
      if (!email) return $('#rSet').focus();
      const { error } = await sb.auth.updateUser({ email }, { emailRedirectTo: location.origin + location.pathname });
      if (error) { console.error(error); return toast(error.message); }
      renderRecovery();
    };
  }
}

// ---------- state ----------
let events = F.withBuiltinWeights([], CONFIG.REDBOOK_WEIGHTS);
const byTimeDesc = (a, b) => new Date(b.at) - new Date(a.at);
const byId = (id) => events.find((e) => e.id === id);

// Writes show on screen at once and are queued until the server takes them (see sync.js).
const savedQueue = (() => { try { return JSON.parse(ls.get('unsent') || '[]'); } catch { return []; } })();
const sync = FeedSync.createSync(store, {
  normalize: F.normalize,
  restore: savedQueue,                                            // entries logged offline before the app was closed
  onPending: (items) => ls.set('unsent', JSON.stringify(items)),
  onChange: (list) => { events = F.withBuiltinWeights(list, CONFIG.REDBOOK_WEIGHTS).sort(byTimeDesc); render(); scheduleMerge(); },
  onError: (msg, err) => { console.error(err); toast(msg); },
});
const persist = (ev, isNew) => sync.persist(ev, isNew);
const removeEvent = (id) => sync.remove(id);
const MOVED = false;   // set true on an old address to send phones to HOME_URL

// Repeat feeds of the same kind starting within an hour of each other become one entry (see F.reconcileFeeds). Runs shortly
// after any change, from either phone; both phones reach the same result, so it's safe if both do it.
let mergeTimer = null;
function scheduleMerge() { clearTimeout(mergeTimer); mergeTimer = setTimeout(mergeRepeatFeeds, 1500); }
async function mergeRepeatFeeds() {
  if (MOVED || !room) return;
  if (sheet) return scheduleMerge();   // not while an entry is open for editing
  const { updates, deletes } = F.reconcileFeeds(events, CONFIG.REPEAT_FEED_MIN);
  for (const u of updates) await persist(u, false);   // save the combined entry before removing the rest
  for (const id of deletes) await removeEvent(id);
}
const refresh = () => (MOVED ? Promise.resolve() : sync.refresh());

// ---------- time helpers ----------
const hm = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
function dayWord(ms) {
  const d = new Date(ms).toDateString(), n = new Date();
  if (d === n.toDateString()) return 'today';
  n.setDate(n.getDate() - 1);
  if (d === n.toDateString()) return 'yesterday';
  return new Date(ms).toLocaleDateString([], { weekday: 'short' });
}

// ---------- domain ----------
const t = (e) => new Date(e.at).getTime();
const SIDE = { L: 'Left', R: 'Right' };
const baby = () => {   // the shared baby record, falling back to the built-in details
  const b = events.find((e) => e.type === 'baby' && !F.isSleep(e))?.data || {};   // sleeps share the 'baby' type
  return { ...b, name: (typeof b.name === 'string' && b.name) || CONFIG.BABY.name, birth: b.birth || CONFIG.BABY.birth };
};
const setting = (key, cfgKey) => { const v = parseFloat(baby()[key]); return v > 0 ? v : CONFIG[cfgKey]; };
const intervalMin = () => Math.min(180, Math.max(120, setting('interval', 'FEED_INTERVAL_MIN')));   // 2–3 hours
const mlPerMin = () => setting('mlPerMin', 'BREAST_ML_PER_MIN');
// Daily milk target [low, high]. A daily amount set in the app wins; otherwise 150–200 ml per kg of her weight.
const suggestedTarget = () => F.targetRange(weightKg(), CONFIG.TARGET_ML_PER_KG);
function milkTarget() {
  const set = parseFloat(baby().targetMl);
  return set > 0 ? [set, Math.round((set * 4) / 3 / 10) * 10] : suggestedTarget();
}
const weightKg = () => F.latestKg(events, parseFloat(baby().weight) || CONFIG.DEFAULT_WEIGHT_KG);
function ageDays() {   // completed days: 0 on the day she's born
  const b = baby().birth;
  if (!b) return null;
  const d = Math.floor((Date.now() - new Date(b + 'T00:00').getTime()) / (24 * HOUR));
  return d >= 0 ? d : null;
}
const ageText = (d) => F.ageLabel(d);
const longDur = (ms) => {
  const m = Math.max(0, Math.floor(ms / MIN)), h = Math.floor(m / 60), r = m % 60;
  return h ? `${h} hr${h === 1 ? '' : 's'} ${r} min${r === 1 ? '' : 's'}` : `${m} min${m === 1 ? '' : 's'}`;
};
const hms = (ms) => { const x = Math.max(0, Math.floor(ms / 1000)); return [Math.floor(x / 3600), Math.floor(x / 60) % 60, x % 60].map(pad).join(':'); };
const dayName = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'long' });
const shortDate = (ms) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
// Only touch the DOM when the markup changes, so a tap is never lost to the once-a-second refresh.
const setHTML = (el, html) => { if (el._h !== html) { el._h = html; el.innerHTML = html; } };

// ---------- render ----------
function renderStatus() {
  const now = Date.now(), ss = F.sessions(events, now, CONFIG.TOPUP_MERGE_MIN), last = ss[ss.length - 1];
  setHTML($('#status'), `<div class="label">Time Since Last Feed</div><div class="value">${last ? longDur(now - last.start) : '—'}</div>`);
  if (!last) {
    setHTML($('#due'), `<div class="label">Next Feed is Due</div><div class="value"><small>Start a feed and it’ll show here</small></div>`);
    return;
  }
  const due = last.start + intervalMin() * MIN, late = now - due, side = SIDE[F.startOnSide(events)];
  setHTML($('#due'), `<div class="label-row"><div class="label">Next Feed is Due</div><button class="caps-link" id="dueEdit">Every ${F.intervalLabel(intervalMin())}</button></div>
    <div class="value ${late > 0 ? 'late' : ''}">${late > 0 ? `${longDur(late)} ago` : `${dayName(due)} ${hm(due)}`} <small>on the ${side}</small></div>`);
}
function renderButtons() {
  $('#buttons').hidden = !!F.pickRunning(events).current;
  const side = F.startOnSide(events);
  for (const s of ['L', 'R']) {
    const b = $(`[data-side="${s}"]`);
    b.querySelector('.badge').hidden = s !== side;
    b.querySelector('.hint').textContent = s === side ? 'Start here' : '';
  }
}
// The timer card is rebuilt only when its buttons change, so a tap is never lost
// to the once-a-second refresh. The clock text is updated in place.
let timerKey = '';
function renderTimer() {
  const now = Date.now(), { current, stale } = F.pickRunning(events), el = $('#timer');
  el.hidden = !current;
  if (!current) { timerKey = ''; return; }
  const d = current.data, tot = F.sideTotals(d, now), total = tot.L + tot.R;
  const side = F.currentSide(d), paused = F.isPaused(d), long = total > CONFIG.LONG_FEED_WARN_MIN * MIN;
  const key = [current.id, paused, side, long, stale.map((s) => s.id).join()].join('|');
  if (key !== timerKey) {
    timerKey = key;
    el.innerHTML = `${long ? '<div class="warn">Still feeding? Stop and fix the time.</div>' : ''}
      <div class="tgrid">
        <div class="tcol">
          <button class="bigbtn" data-op="stop"><span class="badge">✓</span>Stop</button>
          <button class="bigbtn" data-op="${paused ? 'resume' : 'pause'}">${paused ? 'Resume' : 'Pause'}</button>
        </div>
        <button class="bigbtn tall" data-op="switch"><small>Switch to</small>${SIDE[F.other(side)]}</button>
      </div>
      <div class="clock">${side} <span id="tClock"></span></div>
      <div class="sidetot" id="tTot"></div>
      <div class="center"><button class="link danger" data-op="discard">Discard</button></div>
      ${stale.map((s) => `<div class="stale">Another feed was also started at ${hm(F.feedStart(s.data))}${s.by_name ? ` by ${esc(s.by_name)}` : ''}.
        <button class="link" data-op="save-stale" data-id="${s.id}">Edit and save</button>
        <button class="link danger" data-op="discard-stale" data-id="${s.id}">Discard it</button></div>`).join('')}`;
  }
  $('#tClock').textContent = hms(tot[side]);
  $('#tTot').textContent = `${paused ? 'Paused · ' : ''}Total ${F.mmss(total)} · L ${F.mmss(tot.L)} · R ${F.mmss(tot.R)}${current.by_name ? ' · ' + current.by_name : ''}`;
}

$('#timer').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-op]');
  const { current } = F.pickRunning(events);
  if (!btn || !current) return;
  const now = Date.now(), op = btn.dataset.op;
  if (op === 'discard') { askConfirm('Discard this feed? It won’t be saved.', 'Discard').then((ok) => ok && removeEvent(current.id)); return; }
  if (op === 'discard-stale') { const id = btn.dataset.id; askConfirm('Discard the other feed?', 'Discard').then((ok) => ok && removeEvent(id)); return; }
  if (op === 'save-stale') { const s = byId(btn.dataset.id); if (s) openBreast(s, now, F.isPaused(s.data)); return; }
  if (op === 'stop') {
    const wasPaused = F.isPaused(current.data), paused = { ...current, data: F.pauseFeed(current.data, now) };
    persist(paused, false);
    return openBreast(paused, now, wasPaused);
  }
  const fn = { pause: F.pauseFeed, resume: F.resumeFeed, switch: F.switchSide }[op];
  persist({ ...current, data: fn(current.data, now) }, false);
});
function renderStrip() {
  const now = Date.now(), today = F.dayStart(now, CONFIG.DAY_START_HOUR);
  let html = '';
  for (let i = 0; i < CONFIG.TIMELINE_DAYS; i++) {
    const start = F.shiftDay(today, -i), end = F.shiftDay(start, 1);
    const blocks = F.dayBlocks(events, start, end, now)
      .map((b) => `<i class="blk ${b.kind}" style="left:${b.left.toFixed(2)}%;width:${b.width.toFixed(2)}%"></i>`).join('');
    const nowLine = i === 0 ? `<i class="nowline" style="left:${(((now - start) / (end - start)) * 100).toFixed(2)}%"></i>` : '';
    const label = i === 0 ? 'Today' : new Date(start).toLocaleDateString([], { weekday: 'short' });
    html += `<div class="srow"><div class="sday">${label}</div><div class="track">${blocks}${nowLine}</div></div>`;
  }
  const h = CONFIG.DAY_START_HOUR;
  const ticks = [0, 6, 12, 18].map((o) => `<span style="left:${(o / 24) * 100}%">${pad((h + o) % 24)}:00</span>`).join('');
  html += `<div class="ticks">${ticks}</div>
    <div class="legend"><span><i style="--c:var(--left)"></i>Left</span><span><i style="--c:var(--right)"></i>Right</span><span><i style="--c:var(--bottle)"></i>Bottle</span></div>`;
  $('#strip').innerHTML = html;
}
// Milk so far today against her daily target: shared by the top bar and the Analysis goal card.
function milkToday(now = Date.now()) {
  const kg = weightKg(), rate = mlPerMin(), [lo, hi] = milkTarget();
  const day = F.todayTotals(events, F.dayStart(now, CONFIG.DAY_START_HOUR), now, rate);
  const got = day.bottleMl + day.estBreastMl;
  return { kg, rate, lo, hi, day, got, done: got >= lo, top: F.topUp(lo, day.bottleMl, day.estBreastMl, CONFIG.DEFAULT_ML) };
}

let currentPage = 'timer';
function renderMilkbar() {
  const el = $('#milkbar'), m = milkToday();
  el.hidden = currentPage === 'analysis';
  el.className = m.done ? 'done' : '';
  setHTML(el, m.done
    ? `<span>🎉 Today’s milk target reached · ~${m.got} ml</span>`
    : `<i class="mfill" style="width:${Math.min(100, (m.got / m.lo) * 100).toFixed(1)}%"></i><span>Milk today ~${m.got} of ${m.lo} ml · ${m.top.remaining} ml to go</span>`);
}
$('#milkbar').onclick = () => showPage('analysis');

function renderGoal() {
  const m = milkToday(), custom = parseFloat(baby().targetMl) > 0;
  setHTML($('#goal'), m.done
    ? `<div class="goalcard done"><div class="party">🎉🍼🎉</div><div class="big">Today’s target is covered!</div>
        <div style="font-size:18px;font-weight:700;margin-top:6px">~${m.got} ml of her ${m.lo} ml target</div>
        <p class="fine">${m.day.bottleMl} ml by bottle + ~${m.day.estBreastMl} ml from the breast (estimate). Anything more today is a bonus.</p>
        <button class="caps-link" id="targetEdit" style="color:var(--text)">Target ${m.lo} ml a day · change</button></div>`
    : `<div class="goalcard"><div class="label-row"><div class="label">Milk today</div><button class="caps-link" id="targetEdit">Target ${m.lo} ml · change</button></div>
        <div class="big">~${m.got} <small style="font-size:18px;color:var(--dim)">of ${m.lo} ml</small></div>
        <div class="gain" style="height:18px;margin-top:10px"><b style="background:var(--accent);width:${Math.min(100, (m.got / m.lo) * 100).toFixed(1)}%"></b></div>
        <div class="barlab"><span>${Math.min(100, Math.round((m.got / m.lo) * 100))}% of today’s target</span><span>${m.lo} ml</span></div>
        <div style="font-weight:700;margin-top:8px">${m.top.remaining} ml to go ≈ ${m.top.bottles} × ${CONFIG.DEFAULT_ML} ml bottles</div>
        <p class="fine">${m.day.bottleMl} ml by bottle + ~${m.day.estBreastMl} ml from the breast (estimate at ${m.rate} ml/min).${custom ? '' : ` Target is 150 ml per kg of her weight.`}</p></div>`);
}
$('#goal').addEventListener('click', (ev) => { if (ev.target.closest('#targetEdit')) openTarget(); });

// Daily milk target: type an amount, or go back to the weight-based suggestion. Shared by both phones.
function openTarget() {
  sheet = null;
  const [sLo, sHi] = suggestedTarget(), cur = parseFloat(baby().targetMl) > 0 ? parseFloat(baby().targetMl) : '';
  openSheet(`<h3>Daily milk target</h3>
    <div class="row"><label>Target</label>${numBox('tgIn', cur || sLo, 'ml')}</div>
    <p class="fine">Suggested for ${weightKg()} kg: ${sLo}–${sHi} ml a day (150–200 ml per kg).</p>
    <button class="confirm" id="tgSave" style="margin-top:14px">Save</button>
    ${cur ? '<button class="secondary" id="tgReset">Use the suggested amount</button>' : ''}`);
  $('#tgIn').onfocus = (e) => e.target.select();
  const save = async (val) => {
    closeSheet();
    await persist({ id: crypto.randomUUID(), room, type: 'baby', at: new Date().toISOString(), by_name: me, data: { ...baby(), targetMl: val } }, true);
  };
  $('#tgSave').onclick = () => {
    const v = parseInt($('#tgIn').value, 10);
    if (!(v >= 200 && v <= 2000)) { toast('Target in ml a day, e.g. 700'); return $('#tgIn').focus(); }
    save(v);
  };
  if ($('#tgReset')) $('#tgReset').onclick = () => save('');
}

function renderAnalysis() {
  const now = Date.now(), m = milkToday(now), gr = F.growthReport(events, baby().birth, now);
  const mix = F.feedMix(events, now - 24 * HOUR, now + 1, now, CONFIG.TOPUP_MERGE_MIN);
  const [fLo] = CONFIG.FEEDS_PER_DAY, feedsOk = mix.feeds >= fLo;
  const night = F.longestNightGap(events, now, CONFIG.NIGHT, CONFIG.TOPUP_MERGE_MIN);

  // Feeds: one bar split by kind, with a tick at the 8-a-day minimum. More is fine.
  const scale = Math.max(mix.feeds, 12), seg = (n, cls) => (n ? `<i class="${cls}" style="width:${((n / scale) * 100).toFixed(1)}%"></i>` : '');
  const feedsHtml = `<div class="sig-top"><span class="sig-name">Feeds in the last 24 hours</span>
      <span class="${feedsOk ? 'okpill' : 'lowpill'}">${mix.feeds} ${feedsOk ? '✓' : ''}</span></div>
    <div class="mix">${seg(mix.breast, 'mb')}${seg(mix.both, 'mt')}${seg(mix.bottle, 'mo')}<span class="tick" style="left:${((fLo / scale) * 100).toFixed(1)}%"></span></div>
    <div class="keys"><span><i style="background:var(--left)"></i>${mix.breast} breast</span><span><i style="background:repeating-linear-gradient(135deg,var(--left) 0 3px,var(--bottle) 3px 6px)"></i>${mix.both} breast + bottle top-up</span><span><i style="background:var(--bottle)"></i>${mix.bottle} bottle</span></div>
    <p class="fine">${feedsOk ? `At least ${fLo} a day is the aim, so ${mix.feeds} is great. Feeding more often than that is normal at this age.` : `Fewer than ${fLo} feeds in the last 24 hours. Offer feeds a little more often.`}</p>`;

  // Weight: last week's gain against its goal, and this week's goal.
  let gainHtml, gainOk = null;
  if (gr && gr.lastWeek) {
    const lw = gr.lastWeek, tw = gr.thisWeek, pct = Math.round((lw.gainedG / Math.max(1, lw.goalG)) * 100);
    const sc = Math.max(lw.goalG, lw.gainedG, tw.goalG, 1);
    gainOk = lw.gainedG >= 0.8 * lw.goalG;
    gainHtml = `<div class="sig-top"><span class="sig-name">Last week <small class="fine">${shortDate(lw.fromAt)} → ${shortDate(lw.toAt)}</small></span>
        <span class="${gainOk ? 'okpill' : 'lowpill'}">${lw.gainedG > 0 ? '+' : ''}${lw.gainedG} g</span></div>
      <div class="gain"><b style="width:${Math.max(0, (lw.gainedG / sc) * 100).toFixed(1)}%"></b><span class="tick" style="left:${((lw.goalG / sc) * 100).toFixed(1)}%"></span></div>
      <div class="barlab"><span>${pct}% of a ${lw.goalG} g goal</span><span>goal ${lw.goalG} g</span></div>
      <div class="sig-top" style="margin-top:14px"><span class="sig-name">This week <small class="fine">${shortDate(tw.fromAt)} → ${dayName(tw.toAt).slice(0, 3)} ${shortDate(tw.toAt)}</small></span></div>
      <div class="twk">
        <div><b>+${tw.goalG} g</b><span>target this week</span></div>
        <div><b>~${Math.round(tw.goalG / Math.max(1, Math.round((tw.toAt - tw.fromAt) / 864e5)))} g</b><span>a day</span></div>
        <div><b>~${tw.targetKg.toFixed(2)} kg</b><span>at ${dayName(tw.toAt)}’s weigh-in</span></div>
      </div>
      <p class="fine">Goals are what keeps her on her centile line. Most babies gain 150–200 g a week; her goal is higher because she’s tracking a high centile, and drifting down a little is common.</p>`;
  } else {
    gainHtml = `<div class="sig-top"><span class="sig-name">Weight gain</span></div><p class="fine">Add two weigh-ins a few days apart (Growth tab) to see this.</p>`;
  }

  const verdict = gainOk == null
    ? { cls: feedsOk ? 'good' : 'watch', icon: feedsOk ? '✓' : '!', text: feedsOk ? 'Feeding plenty. Add weigh-ins to check her growth too.' : `Fewer feeds than usual in the last 24 hours (aim for at least ${fLo}).` }
    : feedsOk && gainOk
    ? { cls: 'good', icon: '✓', text: 'Looking good: feeding plenty and growing along her line.' }
    : { cls: 'watch', icon: '!', text: !gainOk ? 'Feeding plenty, but last week’s gain was below her goal. Worth mentioning at the weigh-in.'
        : `Fewer feeds than usual in the last 24 hours (aim for at least ${fLo}).` };

  setHTML($('#analysis'), `
    <div class="q"><div class="qh">Is she getting enough?</div>
      <div class="verdict ${verdict.cls}"><span class="vi">${verdict.icon}</span><span>${verdict.text}</span></div>
      <div class="sig">${feedsHtml}</div>
      <div class="sig" style="margin-bottom:0">${gainHtml}</div>
    </div>
    <div class="q"><div class="qh">Bottles vs breast today</div>
      <div class="split">
        <div><b>${m.day.breastMin}m</b>on the breast<small>L ${Math.round(m.day.L / MIN)}m · R ${Math.round(m.day.R / MIN)}m · ~${m.day.estBreastMl} ml</small></div>
        <div><b>${m.day.bottleMl} ml</b>by bottle<small>${m.day.bottles} bottle${m.day.bottles === 1 ? '' : 's'}</small></div>
      </div>
    </div>
    ${night ? `<p class="fine">Longest stretch last night: <b>${F.fmtDur(night.ms)}</b> (${hm(night.from)}–${hm(night.to)})</p>` : ''}
    <p class="fine">A guide, not medical advice: check with your midwife or health visitor.</p>`);
}

// Sleep on Analysis: today at a glance, then hours asleep per day for the last week.
function renderSleepStats() {
  const now = Date.now(), days = F.dailySleep(events, now, CONFIG.TIMELINE_DAYS, CONFIG.DAY_START_HOUR), d = days[days.length - 1];
  if (!days.some((x) => x.count)) {
    setHTML($('#sleepStats'), '<div class="label">Sleep</div><p class="fine">Use the Sleep switch on the Feed Timer (or its + to log one you missed) and her sleep shows up here.</p>');
    return;
  }
  const max = Math.max(17 * HOUR, ...days.map((x) => x.ms)), pct = (v) => ((v / max) * 100).toFixed(1);
  const full = days.slice(0, -1).filter((x) => x.count), avg = full.length ? full.reduce((a, x) => a + x.ms, 0) / full.length : null;
  const hrs = (ms) => (ms / HOUR).toFixed(ms >= 10 * HOUR ? 0 : 1).replace(/\.0$/, '') + 'h';
  setHTML($('#sleepStats'), `<div class="label">Sleep</div>
    <div class="facts">
      <div class="fact"><b>${longDur(d.ms)}</b><span>asleep today, across ${d.count} sleep${d.count === 1 ? '' : 's'}</span></div>
      <div class="fact"><b>${d.longest ? longDur(d.longest) : '—'}</b><span>longest sleep today</span></div>
      <div class="fact"><b>${d.avgAwakeMs != null ? longDur(d.avgAwakeMs) : '—'}</b><span>average time awake between sleeps today</span></div>
      <div class="fact"><b>${avg != null ? longDur(avg) : '—'}</b><span>average a day over the last ${full.length} full day${full.length === 1 ? '' : 's'}</span></div>
    </div>
    <div class="qh" style="margin-top:14px">Hours asleep per day</div>
    <div class="cols">${days.map((x) => `<div class="col"><i class="cs" style="height:${pct(x.ms)}%"></i><em style="bottom:calc(${pct(x.ms)}% + 2px)">${x.ms ? hrs(x.ms) : ''}</em></div>`).join('')}</div>
    <div class="collabs">${days.map((x, i) => `<span>${i === days.length - 1 ? 'Today' : new Date(x.start).toLocaleDateString([], { weekday: 'short' })}</span>`).join('')}</div>
    <p class="fine">Newborns often sleep 14–17 hours a day, in short stretches. Days with nothing logged show as empty.</p>`);
}

// Last 7 days: milk per day against her target band, plus a few plain-English findings.
function renderWeek() {
  const now = Date.now(), m = milkToday(now);
  const days = F.dailySummary(events, now, CONFIG.TIMELINE_DAYS, CONFIG.DAY_START_HOUR, m.rate, CONFIG.TOPUP_MERGE_MIN);
  const max = Math.max(m.hi * 1.15, ...days.map((d) => d.estMl), 1), pct = (v) => ((v / max) * 100).toFixed(1);
  const cols = days.map((d, i) => `<div class="col"><i class="cb" style="height:${pct(d.estMl - d.bottleMl)}%"></i><i class="co" style="height:${pct(d.bottleMl)}%"></i>
      <em style="bottom:calc(${pct(d.estMl)}% + 2px)">${d.estMl || ''}</em></div>`).join('');
  const labs = days.map((d, i) => `<span>${i === days.length - 1 ? 'Today' : new Date(d.start).toLocaleDateString([], { weekday: 'short' })}</span>`).join('');
  const full = days.slice(0, -1).filter((d) => d.feeds), hit = full.filter((d) => d.estMl >= m.lo).length;
  const busy = F.busiestHours(events, F.shiftDay(F.dayStart(now, CONFIG.DAY_START_HOUR), -(CONFIG.TIMELINE_DAYS - 1)), now, CONFIG.TOPUP_MERGE_MIN);
  const avg = (a, k) => (a.length ? Math.round(a.reduce((s, d) => s + d[k], 0) / a.length) : 0);
  const recent = full.slice(-3), earlier = full.slice(0, -3);
  const finds = [];
  if (full.length) finds.push(`Milk target reached on <b>${hit} of ${full.length}</b> full days (average ~${avg(full, 'estMl')} ml a day).`);
  if (full.length) finds.push(`About <b>${avg(full, 'feeds')} feeds a day</b>, with ${avg(full, 'breastMin')} minutes on the breast and ${avg(full, 'bottleMl')} ml by bottle.`);
  if (earlier.length && recent.length) {
    const a = avg(earlier, 'bottleMl'), b = avg(recent, 'bottleMl');
    if (Math.abs(b - a) >= 30) finds.push(`Bottles are ${b > a ? 'up' : 'down'}: ~${b} ml a day over the last 3 days, from ~${a} ml before.`);
  }
  if (busy && busy.count >= 4) finds.push(`Busiest time: <b>${pad(busy.startHour)}:00–${pad((busy.startHour + 3) % 24)}:00</b> (${busy.count} feeds this week).${busy.startHour >= 16 && busy.startHour <= 21 ? ' Evening cluster feeding is very common.' : ''}`);
  setHTML($('#week'), `<div class="qh" style="margin-top:10px">Milk per day</div>
    <div class="cols">${cols}<span class="band" style="bottom:${pct(m.lo)}%;height:${(pct(m.hi) - pct(m.lo)).toFixed(1)}%"></span><span class="bandlab" style="bottom:${pct(m.hi)}%">target</span></div>
    <div class="collabs">${labs}</div>
    <div class="keys" style="margin-top:6px"><span><i style="background:var(--left)"></i>breast (estimate)</span><span><i style="background:var(--bottle)"></i>bottle</span><span><i style="background:color-mix(in srgb, var(--ok) 30%, transparent)"></i>target ${m.lo}–${m.hi} ml</span></div>
    ${finds.length ? `<ul class="finds">${finds.map((f) => `<li>${f}</li>`).join('')}</ul>` : '<p class="fine">Log a few days of feeds to see patterns here.</p>'}`);
}

function feedIcon(e) {   // the breast picture with a blue L on its left and/or a red R on its right; or a bottle
  if (e.type === 'bottle') return '<div class="ic"><img src="icons/style/i_bottle.png" alt=""></div>';
  const x = F.sideTotals(e.data, Date.now()), sides = ['L', 'R'].filter((k) => x[k] >= MIN / 2);
  if (!sides.length) sides.push(F.firstSide(e.data));
  return `<div class="ic">${sides.includes('L') ? '<b class="lt L">L</b>' : ''}<img src="icons/style/breast.svg" alt="">${sides.includes('R') ? '<b class="lt R">R</b>' : ''}</div>`;
}
function feedWhat(e) {
  if (e.type === 'bottle') return `${e.data.ml} ml bottle`;
  const x = F.sideTotals(e.data, Date.now()), m = Math.round((x.L + x.R) / MIN);
  const both = x.L >= MIN / 2 && x.R >= MIN / 2 ? ` (L ${Math.round(x.L / MIN)}, R ${Math.round(x.R / MIN)})` : '';
  return m ? `Fed for ${m} min${m === 1 ? '' : 's'}${both}` : 'Fed for under a minute';
}
// Logs: one card per feed, newest first, grouped by calendar day. Starts at 7 days; "Show earlier days" adds a week.
let logsDays = CONFIG.TIMELINE_DAYS, noEarlier = false;
async function showEarlierDays() {
  const today = F.dayStart(Date.now(), 0), to = F.shiftDay(today, -(logsDays - 1)), from = F.shiftDay(to, -7);
  const btn = $('#moreDays');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  let rows;
  try { rows = await store.loadRange(from, to); }
  catch (err) { console.error(err); toast('Can’t reach server'); $('#logsMore')._h = null; return renderTimeline(); }
  rows.forEach((r) => sync.applyRemote(r));
  logsDays += 7;
  if (!rows.length && !events.some((e) => (e.type === 'breast' || e.type === 'bottle') && F.startOf(e) < from)) noEarlier = true;
  $('#logsMore')._h = null;   // the button text was changed by hand above, so force a redraw
  render();
}

function renderTimeline() {
  const now = Date.now(), from = F.shiftDay(F.dayStart(now, 0), -(logsDays - 1));
  const isFeedRow = (e) => e.type === 'bottle' || (e.type === 'breast' && e.data.status === 'done');
  const feeds = events.filter((e) => isFeedRow(e) || F.isSleep(e)).sort((a, b) => F.startOf(b) - F.startOf(a));
  const prevFeed = (i) => feeds.slice(i + 1).find(isFeedRow);
  let html = '', day = '';
  feeds.forEach((e, i) => {
    const start = F.startOf(e);
    if (start < from) return;
    const d = new Date(start).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    if (d !== day) { day = d; html += `<div class="dayhead">${esc(d)}</div>`; }
    if (F.isSleep(e)) {
      html += `<button class="entry sleep" data-id="${e.id}"><div class="ic"><img src="icons/style/i_moon.png" alt=""></div><div>
        <div class="time">${hm(e.data.start)}${e.data.end != null ? ` - ${hm(e.data.end)}` : ''}</div>
        <div class="what">${e.data.end != null ? `Slept for ${longDur(e.data.end - e.data.start)}` : `Asleep for ${longDur(now - e.data.start)} so far`}</div></div></button>`;
      return;
    }
    const prev = prevFeed(i);
    html += `<button class="entry" data-id="${e.id}">${feedIcon(e)}<div>
      <div class="time">${e.type === 'breast' ? `${hm(start)} - ${hm(F.endOf(e, now))}` : hm(start)}</div>
      <div class="what">${esc(feedWhat(e))}</div>
      ${prev ? `<div class="gap">${longDur(start - F.startOf(prev))} since previous feed</div>` : ''}</div></button>`;
  });
  setHTML($('#timeline'), html || '<div class="empty">No feeds logged yet</div>');
  setHTML($('#logsMore'), noEarlier ? '<p class="fine center">That’s everything: no earlier feeds.</p>'
    : '<button class="addbtn" id="moreDays">Show earlier days</button>');
}
function renderAge() {
  const d = ageDays(), name = typeof baby().name === 'string' ? baby().name : '';
  $('#babyName').textContent = name || 'Feed Log';
  const photo = typeof baby().photo === 'string' && baby().photo.startsWith('data:image/') ? baby().photo : 'icons/style/avatar.svg';
  if ($('#avatarImg').getAttribute('src') !== photo) $('#avatarImg').src = photo;
  $('#logsTitle').textContent = name ? `${name}’s Logs` : 'Logs';
  const today = new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  $('#age').textContent = today + (d == null ? '' : ' · ' + ageText(d));
}

// ---------- growth ----------
function growthChart(g) {
  const W = 340, H = 220, L = 30, R = 38, T = 8, B = 24;
  const maxAge = Math.max(42, g.expected.ageDays + 7, g.latest.ageDays + 14);
  const kgs = [...g.points.map((p) => p.kg), g.expected.kg];
  for (let a = 0; a <= maxAge; a += 7) kgs.push(F.weightFromZ(-2, a), F.weightFromZ(2, a));
  const kMin = Math.floor(Math.min(...kgs) * 2) / 2, kMax = Math.ceil(Math.max(...kgs) * 2) / 2;
  const x = (a) => (L + (a / maxAge) * (W - L - R)).toFixed(1);
  const y = (k) => (T + (1 - (k - kMin) / (kMax - kMin)) * (H - T - B)).toFixed(1);
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Her weight on the WHO girls centile curves">`;
  const kStep = kMax - kMin > 4 ? 1 : 0.5;
  for (let k = kMin; k <= kMax + 1e-9; k += kStep) {
    svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(k)}" y2="${y(k)}"/><text x="${L - 5}" y="${+y(k) + 3}" text-anchor="end">${k}</text>`;
  }
  const wStep = maxAge > 120 ? 28 : 7;
  for (let a = 0; a <= maxAge; a += wStep) svg += `<text x="${x(a)}" y="${H - 6}" text-anchor="middle">${a / 7}w</text>`;
  for (const [z, name] of F.CENTILE_LINES) {
    let d = '';
    for (let a = 0; a <= maxAge; a++) d += `${a ? 'L' : 'M'}${x(a)} ${y(F.weightFromZ(z, a))}`;
    svg += `<path class="cl${z === 0 ? ' mid' : ''}" d="${d}"/><text class="lab" x="${W - R + 4}" y="${+y(F.weightFromZ(z, maxAge)) + 3}">${name}</text>`;
  }
  const pts = g.points.map((p) => [x(p.ageDays), y(p.kg)]), ex = [x(g.expected.ageDays), y(g.expected.kg)], last = pts[pts.length - 1];
  svg += `<path class="her" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('')}"/>`;
  svg += `<path class="proj" d="M${last[0]} ${last[1]}L${ex[0]} ${ex[1]}"/>`;
  pts.forEach((p, i) => { svg += `<circle class="dot" cx="${p[0]}" cy="${p[1]}" r="4"/><circle cx="${p[0]}" cy="${p[1]}" r="13" fill="transparent" data-gi="${i}"/>`; });
  svg += `<circle class="dot open" cx="${ex[0]}" cy="${ex[1]}" r="4.5"/><circle cx="${ex[0]}" cy="${ex[1]}" r="13" fill="transparent" data-gi="exp"/>`;
  return svg + '</svg>';
}
let growthNow = null;
function renderGrowth() {
  const el = $('#growth'), g = F.growthReport(events, baby().birth, Date.now());
  growthNow = g;
  if (!g) {
    setHTML(el, '<div class="label">Growth</div><p class="fine">Add her birth date and a weight check-in in Settings to see her growth chart.</p>');
    return;
  }
  const kg = g.latest.kg, [lo, hi] = F.targetRange(kg, CONFIG.TARGET_ML_PER_KG), c = Math.round(g.latest.centile);
  const from2wk = g.points.find((p) => p.ageDays >= 13);
  const drift = from2wk && from2wk !== g.latest && g.latest.z < from2wk.z - 0.25
    ? `<p class="fine">She’s moved from about the ${ordinal(Math.round(from2wk.centile))} to the ${ordinal(c)} centile since ${shortDate(from2wk.at)}. Some drift in the early weeks is common. Worth mentioning at the next weigh-in.</p>` : '';
  const tw = g.thisWeek, toGain = Math.max(0, tw.goalG);
  setHTML(el, `<div class="label">Growth</div>
    <div class="value">${F.centileName(g.latest.centile)} centile <small>(about the ${ordinal(c)})</small></div>
    ${growthChart(g)}
    <div class="tip" id="gTip">Tap a dot for details</div>
    <div class="facts">
      <div class="fact"><b>${kg.toFixed(2)} kg</b><span>on ${shortDate(g.latest.at)}</span></div>
      <div class="fact"><b>~${g.expected.kg.toFixed(2)} kg</b><span>expected ${dayName(g.expected.at)} ${shortDate(g.expected.at)} to stay on her line</span></div>
      <div class="fact"><b>+${toGain} g</b><span>to gain by ${dayName(tw.toAt)}’s weigh-in to stay on her line (~${Math.round(toGain / Math.max(1, Math.round((tw.toAt - tw.fromAt) / 864e5)))} g a day)</span></div>
      <div class="fact"><b>${lo}–${hi} ml</b><span>milk a day at ${kg.toFixed(2)} kg (150–200 ml per kg)</span></div>
    </div>
    ${drift}
    <p class="fine">Curves: WHO growth standards for girls (UK red book charts use them from 2 weeks). A guide, not medical advice.</p>`);
}
$('#growth').addEventListener('click', (ev) => {
  const hit = ev.target.closest('[data-gi]'), g = growthNow;
  if (!hit || !g) return;
  if (hit.dataset.gi === 'exp') {
    $('#gTip').textContent = `${dayName(g.expected.at)} ${shortDate(g.expected.at)}: ~${g.expected.kg.toFixed(2)} kg if she stays on her line`;
    return;
  }
  const p = g.points[+hit.dataset.gi];
  $('#gTip').textContent = `${shortDate(p.at)} · ${p.ageDays} days · ${p.kg.toFixed(3)} kg · ${ordinal(Math.round(p.centile))} centile`;
});

// ---------- built-in history ----------
// Her Baby Feed Timer feeds go into each log once. The shared baby record remembers it's done,
// so nothing doubles up and entries you delete don't come back. Fixed ids make a retry harmless.
async function importHistoryOnce() {
  if (!room || baby().historyImportedV2 || !window.FeedHistory) return;
  try {
    const evs = await FeedHistory.historyFor(room);
    const ids = [...evs.map((e) => e.id), ...FeedHistory.EVENTS.map((e) => e.id)];   // new per-log ids + old shared ones
    const todo = FeedHistory.missingHistory(evs, new Set(await store.existingIds(ids)));
    if (todo.length) await store.importMany(todo);
    // Only mark it done once every entry is really in this log; otherwise try again next launch.
    if (FeedHistory.missingHistory(evs, new Set(await store.existingIds(ids))).length) { console.warn('history import incomplete'); return; }
  } catch (err) { console.error(err); return; }   // offline: try again next launch
  await persist({ id: crypto.randomUUID(), room, type: 'baby', at: new Date().toISOString(), by_name: me, data: { ...baby(), historyImportedV2: true } }, true);
  await refresh();
}

// ---------- copying old logs into the family log ----------
// Nothing is ever deleted from an old log. Every log this phone belongs to is copied in (stable ids, so
// both phones copying the same log adds nothing twice), and each copy is checked before it counts.
// Later launches copy anything added to an old log since the last check, e.g. by a phone still on the
// old version, so nothing is lost; entries deleted from the family log don't come back.
async function moveOldLogs() {
  if (!CONFIG.FAMILY || room !== CONFIG.FAMILY.room) return;
  let rooms;
  try { rooms = await store.otherRooms(); } catch (err) { console.error(err); return; }
  let total = 0;
  for (const old of rooms) {
    const since = ls.get('moved.' + old) || null, started = new Date(Date.now() - 5 * MIN).toISOString();
    try {
      const rows = await store.exportRoom(old, since);
      const history = new Set([...(await FeedHistory.historyFor(old)).map((e) => e.id), ...FeedHistory.EVENTS.map((e) => e.id)]);
      const move = await F.rowsToMove(rows, room, history);
      const already = new Set(await store.existingIds(move.map((r) => r.id)));
      const fresh = move.filter((r) => !already.has(r.id));
      if (fresh.length) await store.importMany(fresh);
      const have = new Set(await store.existingIds(move.map((r) => r.id)));
      if (move.some((r) => !have.has(r.id))) { console.warn('copy from', old, 'incomplete; will retry'); continue; }
      ls.set('moved.' + old, started);
      total += fresh.length;
    } catch (err) { console.error(err); }   // offline: try again next launch
  }
  if (total) { await refresh(); toast(`Copied ${total} entries from this phone’s old log${rooms.length > 1 ? 's' : ''}`, true); }
}

// ---------- weigh-ins ----------
// Shared by Settings and the Growth page. `back` reopens the sheet the user came from.
async function addWeight(kgInput, dateInput, back) {
  const kg = posNum(kgInput.value), date = dateInput.value;
  if (!(kg >= 1.5 && kg <= 15)) { toast('Weight in kg, e.g. 4.35'); return kgInput.focus(); }
  if (!date) return dateInput.focus();
  if (date > isoDate(Date.now())) { toast('That date is in the future'); return dateInput.focus(); }
  if (baby().birth && date < baby().birth) { toast('That’s before her birth date'); return dateInput.focus(); }
  const prev = F.latestKg(events, parseFloat(baby().weight) || CONFIG.DEFAULT_WEIGHT_KG);
  if (F.suspectWeight(kg, prev) && !(await askConfirm(`${kg} kg is a big change from ${prev} kg. Weights are in kg, not lb. Save anyway?`, 'Save anyway'))) return back();
  await persist({ id: crypto.randomUUID(), room, type: 'weight', at: new Date(date + 'T12:00').toISOString(), by_name: me, data: { kg } }, true);
  back();
}
function openWeighIn() {
  sheet = null;
  openSheet(`<h3>Add a weigh-in</h3>
    <label class="set-label">Weight (kg)</label><input class="field" id="wiKg" inputmode="decimal" placeholder="e.g. 4.55">
    <label class="set-label">Date weighed</label><input class="field" id="wiDate" type="date" value="${isoDate(Date.now())}" max="${isoDate(Date.now())}">
    <p class="fine">From the red book: grams ÷ 1000, so 4430 g is 4.43 kg.</p>
    <button class="confirm" id="wiSave" style="margin-top:14px">Save</button>`);
  $('#wiSave').onclick = () => addWeight($('#wiKg'), $('#wiDate'), closeSheet);
}
function renderWeighins() {
  const now = Date.now(), all = F.weights(events), g = growthNow;
  const used = new Map(g ? g.points.map((p) => [p.at, p]) : []);
  const birth = baby().birth ? new Date(baby().birth + 'T00:00').getTime() : null;
  let prevKg = null;
  const rows = [...all].reverse().map((w) => {
    const at = new Date(w.at).getTime(), p = used.get(at), future = at > now + 864e5;
    const change = prevKg != null && p ? Math.round((w.data.kg - prevKg) * 1000) : null;
    if (p) prevKg = w.data.kg;
    const age = birth != null ? Math.floor((at - birth) / 864e5) : null;
    return `<tr class="${future || !p ? 'ignored' : ''}"><td>${shortDate(at)}${future ? ' <small>(future date)</small>' : ''}</td>
      <td>${age != null && age >= 0 ? `${age}d` : ''}</td><td>${(+w.data.kg).toFixed(3)}</td>
      <td class="${change > 0 ? 'up' : change < 0 ? 'down' : ''}">${change == null ? '' : `${change > 0 ? '+' : ''}${change} g`}</td>
      <td>${p ? ordinal(Math.round(p.centile)) : ''}</td>
      <td>${w.builtin ? '<small class="fine">book</small>' : `<button class="x" data-wdel="${w.id}" aria-label="Delete weigh-in">×</button>`}</td></tr>`;
  }).reverse().join('');
  setHTML($('#weighins'), `<div class="label">Weigh-ins</div>
    ${all.length ? `<table class="wtable"><tr><th>Date</th><th>Age</th><th>kg</th><th>Change</th><th>Centile</th><th></th></tr>${rows}</table>`
      : '<p class="fine">No weigh-ins yet.</p>'}
    ${all.some((w) => new Date(w.at).getTime() > now + 864e5) ? '<p class="fine">Crossed-out entries are dated in the future, so they’re left out. Delete them and add them again with the right date.</p>' : ''}
    <button class="addbtn" id="wiAdd">+ Add weigh-in</button>`);
}
$('#weighins').addEventListener('click', async (ev) => {
  if (ev.target.closest('#wiAdd')) return openWeighIn();
  const del = ev.target.closest('[data-wdel]');
  if (del && await askConfirm('Delete this weigh-in?', 'Delete')) removeEvent(del.dataset.wdel);
});

// ---------- milestones ----------
// Milestones: one week per card, opening on her current week. Swipe the card (left for what's next,
// right to go back), or use ‹ › and the chips.
const msKey = (e) => e.img || (e.week ? 'w' + pad(e.week) : 'm' + pad(e.month));
const msShort = (e) => (e.week ? `Wk ${e.week}` : `${e.month} mo`);
let msSel = null;   // index into FeedMilestones.ENTRIES; null = her current week
let msEnter = '';   // which side the next card slides in from after a swipe
// Every part's sources in one fold-out list at the bottom of the card.
const msSources = (m) => {
  const parts = [{ key: 'happening', title: 'This week' }, ...FeedMilestones.SECTIONS].map((s) => {
    const list = FeedMilestones.sourcesFor(m, s.key);
    return list.length ? `<li><b>${esc(s.title)}:</b> ${list.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a>`).join(', ')}</li>` : '';
  }).join('');
  return `<details class="ms-srcs"><summary>Sources</summary><ul>${parts}</ul></details>`;
};
function msCard(m, i, cur, d) {
  const rel = i === cur ? '<span class="mstag now">This week</span>' : i < cur ? '<span class="mstag">Earlier</span>' : '<span class="mstag">Coming up</span>';
  const sub = i === cur ? `${Math.floor(d / 7)} weeks ${d % 7} day${d % 7 === 1 ? '' : 's'} old` : '';
  const parts = FeedMilestones.SECTIONS.map((s) => {
    if (s.key === 'focus') return `<div class="ms-focus"><div class="qh">Focus on</div><h3>${esc(m.focus[0])}</h3><div>${esc(m.focus[1])}</div></div>`;
    const title = s.key === 'see' ? (i === cur ? 'You might notice' : i < cur ? 'What she was doing' : 'What to look out for') : s.title;
    const body = s.list ? `<ul class="ms-list">${m[s.key].map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<div>${esc(m[s.key])}</div>`;
    // Typical numbers only appear on the card where they change.
    const g = FeedMilestones.guideNew(m)[s.key];
    const tiles = g ? `<div class="ms-guide">${g.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>` : '';
    return `<div class="ms-part${s.key === 'try' || s.key === 'you' ? ' ms-try' : ''}"><div class="qh">${title}</div>${tiles}${body}</div>`;
  }).join('');
  return `<div class="ms-week">${esc(m.label)}${rel}</div><div class="ms-theme">${esc(m.theme)}</div>${sub ? `<div class="ms-age">${esc(sub)}</div>` : ''}
    <img class="msimg" src="icons/ms/${msKey(m)}.jpg" alt="" loading="lazy" draggable="false" onerror="this.hidden=true">
    <div class="ms-text">${esc(m.happening)}</div>
    ${parts}
    ${msSources(m)}
    ${i !== cur ? `<button class="addbtn" data-ms="${cur}">Back to this week</button>` : ''}`;
}
function renderMilestones() {
  const d = ageDays(), all = FeedMilestones.ENTRIES;
  if (d == null) {
    setHTML($('#milestones'), '<div class="card"><p class="fine">Add her birth date in Settings to see what’s happening this week.</p></div>');
    return;
  }
  const cur = all.indexOf(FeedMilestones.milestones(d).now), i = msSel == null ? cur : msSel, m = all[i];
  setHTML($('#milestones'), `<div class="msnav">
      <button class="arrow" data-ms="${i - 1}" ${i === 0 ? 'disabled' : ''} aria-label="Previous">‹</button>
      <div class="mschips">${all.map((e, k) => `<button class="mschip${k === i ? ' on' : ''}${k === cur ? ' now' : ''}" data-ms="${k}">${msShort(e)}</button>`).join('')}</div>
      <button class="arrow" data-ms="${i + 1}" ${i === all.length - 1 ? 'disabled' : ''} aria-label="Next">›</button>
    </div>
    <div class="msstack">${i < all.length - 1 ? '<div class="card msback"></div>' : ''}
      <div class="card mscard${msEnter ? ' in-' + msEnter : ''}" data-i="${i}">${msCard(m, i, cur, d)}</div></div>
    <p class="fine center">Swipe the card for ${i < all.length - 1 ? 'what’s coming up' : 'earlier weeks'}. Every baby goes at her own pace: these are typical ranges, not targets.</p>`);
  msEnter = '';
  // Centre the selected chip by scrolling only the chip row, and only when the selection changed.
  const on = $('#milestones .mschip.on'), row = on && on.parentElement;
  if (row && row._sel !== i) { row._sel = i; row.scrollLeft = on.offsetLeft - row.clientWidth / 2 + on.offsetWidth / 2; }
}
function msGo(k, from) {
  const all = FeedMilestones.ENTRIES;
  if (k < 0 || k >= all.length) return;
  msSel = k; msEnter = from || '';
  renderMilestones();
  const top = $('#milestones').getBoundingClientRect().top + window.scrollY - 12;
  if (window.scrollY > top) window.scrollTo(0, top);
}
$('#milestones').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-ms]');
  if (!b || b.disabled) return;
  const k = +b.dataset.ms, at = msSel == null ? FeedMilestones.ENTRIES.indexOf(FeedMilestones.milestones(ageDays()).now) : msSel;
  msGo(k, k > at ? 'right' : k < at ? 'left' : '');
});

// Swipe the card like a deck: it follows your finger and tilts; let go past the line and it flies off.
// Up-and-down movement is left to the page so it still scrolls.
(() => {
  let drag = null;
  const host = $('#milestones');
  host.addEventListener('pointerdown', (ev) => {
    const card = ev.target.closest('.mscard');
    if (!card || ev.button > 0 || ev.target.closest('a,button,summary')) return;
    drag = { card, id: ev.pointerId, x: ev.clientX, y: ev.clientY, dx: 0, t: performance.now(), on: false };
  });
  host.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!drag.on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }   // a scroll, not a swipe
      if (Math.abs(dx) < 10) return;
      drag.on = true;
      try { drag.card.setPointerCapture(ev.pointerId); } catch {}   // keeps the drag if the finger leaves the card
      drag.card.classList.add('dragging');
    }
    const i = +drag.card.dataset.i, last = FeedMilestones.ENTRIES.length - 1;
    const edge = (dx > 0 && i === 0) || (dx < 0 && i === last);   // nothing that way: resist
    drag.dx = edge ? dx / 4 : dx;
    drag.card.style.transform = `translateX(${drag.dx}px) rotate(${drag.dx / 22}deg)`;
  });
  const end = (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const { card, dx, on, t } = drag, speed = Math.abs(dx) / Math.max(1, performance.now() - t);
    drag = null;
    if (!on) return;
    card.classList.remove('dragging');
    const i = +card.dataset.i, last = FeedMilestones.ENTRIES.length - 1;
    const go = (Math.abs(dx) > card.offsetWidth * 0.28 || speed > 0.6) && Math.abs(dx) > 30 ? (dx < 0 ? 1 : -1) : 0;
    if (!go || i + go < 0 || i + go > last) { card.style.transform = ''; return; }
    card.classList.add('flying');
    card.style.transform = `translateX(${go > 0 ? -130 : 130}%) rotate(${go > 0 ? -18 : 18}deg)`;
    setTimeout(() => msGo(i + go, go > 0 ? 'right' : 'left'), 110);
  };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', () => {
    if (drag && drag.on) { drag.card.classList.remove('dragging'); drag.card.style.transform = ''; }
    drag = null;
  });
})();

// ---------- pages ----------
const PAGES = ['timer', 'logs', 'growth', 'analysis', 'milestones'];
function showPage(p) {
  if (!PAGES.includes(p)) p = 'timer';
  ls.set('page', p);
  currentPage = p;
  if ($('#milkbar')) renderMilkbar();
  document.querySelectorAll('.page').forEach((el) => { el.hidden = el.dataset.page !== p; });
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('on', el.dataset.go === p));
  $('.top').hidden = p !== 'timer';   // other pages have their own title, like the reference app
  window.scrollTo(0, 0);
  if (p === 'milestones') renderMilestones();   // the chip row can only centre itself once it's visible
}
document.querySelector('.tabbar').addEventListener('click', (ev) => { const t = ev.target.closest('[data-go]'); if (t) showPage(t.dataset.go); });
$('#due').addEventListener('click', (ev) => { if (ev.target.closest('#dueEdit')) openInterval(); });

// Time between feeds: one tap, 2 to 3 hours. Shared by both phones (it lives in the baby record).
function openInterval() {
  sheet = null;
  const cur = intervalMin();
  openSheet(`<h3>Time between feeds</h3>
    <p class="fine" style="margin:-6px 0 14px">From the start of one feed to the start of the next.</p>
    <div class="choices">${F.INTERVAL_CHOICES.map((m) => `<button class="choice${m === cur ? ' on' : ''}" data-min="${m}">${F.intervalLabel(m)}</button>`).join('')}</div>`);
  $('#sheet').querySelectorAll('[data-min]').forEach((btn) => {
    btn.onclick = async () => {
      const b = baby();
      closeSheet();
      if (+btn.dataset.min !== cur) {
        await persist({ id: crypto.randomUUID(), room, type: 'baby', at: new Date().toISOString(), by_name: me, data: { ...b, interval: +btn.dataset.min } }, true);
      }
    };
  });
}
function render() { renderStatus(); renderTimer(); renderButtons(); renderSleep(); renderMilkbar(); renderGoal(); renderGrowth(); renderWeighins(); renderAnalysis(); renderWeek(); renderSleepStats(); renderStrip(); renderTimeline(); renderMilestones(); renderAge(); }

// ---------- bottom sheet ----------
let sheet = null;           // { kind, ... } for the open entry sheet; null for settings or closed
const SHEETS = {};          // kind -> render the sheet
const CLICK = {};           // kind -> handle a button click inside the sheet
const OPEN_EDIT = {};       // event type -> open its edit sheet

function openSheet(html, dismissable = true) {
  $('#sheet').innerHTML = html;
  $('#scrim').classList.add('open');
  $('#sheet').classList.add('open');
  $('#scrim').onclick = dismissable ? closeSheet : null;
}
function closeSheet() {
  $('#scrim').classList.remove('open'); $('#sheet').classList.remove('open'); sheet = null;
  if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(false); }   // tapped outside: cancel
}

// In-app "are you sure?". The browser's confirm() is silently blocked in WhatsApp's in-app
// browser and some home-screen apps, which made Discard and Delete do nothing.
let confirmResolve = null;
function askConfirm(message, okLabel = 'Yes') {
  if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(false); }
  sheet = null;
  return new Promise((resolve) => {
    openSheet(`<h3>${esc(message)}</h3>
      <button class="confirm danger-bg" id="cOk">${esc(okLabel)}</button>
      <button class="secondary" id="cNo">Cancel</button>`);
    confirmResolve = resolve;
    const done = (v) => { if (confirmResolve !== resolve) return; confirmResolve = null; closeSheet(); resolve(v); };
    $('#cOk').onclick = () => done(true);
    $('#cNo').onclick = () => done(false);
  });
}
const renderSheet = () => SHEETS[sheet.kind]();


$('#sheet').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button');
  if (btn && sheet && CLICK[sheet.kind]) CLICK[sheet.kind](btn);
});

// ---------- sleep ----------
// One switch at the bottom of the Feed Timer: Awake / Asleep. Each sleep is { kind: 'sleep', start, end|null }.
// The card is rebuilt only when its state changes; the clock and today's total update in place every second,
// like the feed timer, so a tap is never lost to the redraw.
let sleepKey = '';
function renderSleep() {
  const now = Date.now(), s = F.sleepState(events, now, CONFIG.DAY_START_HOUR), el = $('#sleepCard');
  const key = [s.asleep, s.since, s.current && s.current.id, s.lastSleepMs, s.awakeBefore].join('|');
  if (key !== sleepKey || !el.firstChild) {
    sleepKey = key;
    const facts = [];
    if (s.asleep && s.awakeBefore != null) facts.push(`She was awake for <b>${longDur(s.awakeBefore)}</b> before this sleep.`);
    if (!s.asleep && s.lastSleepMs != null) facts.push(`Her last sleep was <b>${longDur(s.lastSleepMs)}</b>${s.awakeBefore != null ? `, after being awake for <b>${longDur(s.awakeBefore)}</b>` : ''}.`);
    el.innerHTML = `<div class="sechead"><span>Sleep</span><button class="plus" id="sleepPlus" aria-label="Log a sleep you missed">+</button></div>
      <div class="secbody">
        <div class="seg2">
          <button data-sleep="awake" class="${s.asleep ? '' : 'on'}"><img src="icons/style/i_sun.png" alt="">Awake</button>
          <button data-sleep="asleep" class="${s.asleep ? 'on' : ''}"><img src="icons/style/i_moon.png" alt="">Asleep</button>
        </div>
        ${s.since == null ? '<div class="sleepnow">Tap <b>Asleep</b> when she drops off, or <b>+</b> to log a sleep you missed.</div>'
          : `<button class="sclock" id="sClockBtn"><span class="sclabel">${s.asleep ? 'Asleep' : 'Awake'} for</span>
              <span class="sclockv" id="sClock"></span><small>since ${hm(s.since)} · tap to change</small></button>`}
        ${facts.length ? `<div class="sleepfacts">${facts.join('<br>')}</div>` : ''}
        <div class="sleeptoday" id="sToday"></div>
      </div>`;
  }
  if (s.since != null && $('#sClock')) $('#sClock').textContent = hms(now - s.since);
  $('#sToday').innerHTML = `Today: <b>${longDur(s.todayMs)}</b> asleep${s.todayCount ? ` across ${s.todayCount} sleep${s.todayCount === 1 ? '' : 's'}` : ''}`;
}
$('#sleepCard').addEventListener('click', (ev) => {
  if (ev.target.closest('#sleepPlus')) return openSleepNew();
  const now = Date.now(), s = F.sleepState(events, now, CONFIG.DAY_START_HOUR);
  const lastDone = () => events.filter(F.isSleep).filter((e) => e.data.end != null).sort((x, y) => y.data.end - x.data.end)[0];
  if (ev.target.closest('#sClockBtn')) { const t = s.asleep ? s.current : lastDone(); if (t) openSleep(t); return; }
  const b = ev.target.closest('[data-sleep]');
  if (!b) return;
  const want = b.dataset.sleep;
  if (want === 'asleep' && !s.asleep) {
    return persist({ id: crypto.randomUUID(), room, type: 'baby', at: new Date(now).toISOString(), by_name: me, data: { kind: 'sleep', start: now, end: null } }, true);
  }
  if (want === 'awake' && s.asleep) {
    if (now - s.current.data.start < MIN) return removeEvent(s.current.id);   // under a minute: an accidental tap, not a sleep
    return persist({ ...s.current, data: { ...s.current.data, end: now } }, false);
  }
  const target = s.asleep ? s.current : lastDone();   // tapping the state she's already in: fix its time
  if (target) openSleep(target);
});
// Log a sleep after the fact (e.g. one nobody tapped at night).
function openSleepNew() {
  const end = Math.floor(Date.now() / MIN) * MIN;
  sheet = { kind: 'sleep', id: null, isNew: true, start: end - 60 * MIN, end };
  renderSheet();
}
function openSleep(e) {
  sheet = { kind: 'sleep', id: e.id, start: e.data.start, end: e.data.end };
  renderSheet();
}
OPEN_EDIT.baby = (e) => { if (F.isSleep(e)) openSleep(e); };
SHEETS.sleep = () => {
  const s = sheet;
  openSheet(`<h3>${s.isNew ? 'Log a sleep' : 'Sleep'}</h3>
    <div class="row"><label>Fell asleep</label><div class="tbox"><input class="field" id="slStart" type="time" value="${F.hhmm(s.start)}"><small>${dayWord(s.start)}</small></div></div>
    <div class="row"><label>Woke up</label><div class="tbox">${s.end == null ? '<small>still asleep</small>'
      : `<input class="field" id="slEnd" type="time" value="${F.hhmm(s.end)}"><small>${dayWord(s.end)}</small>`}</div></div>
    <button class="confirm" id="saveBtn">Save</button>
    ${s.isNew ? '' : '<button class="secondary danger" id="deleteBtn">Delete</button>'}`);
};
CLICK.sleep = (btn) => {
  const s = sheet, e = s.isNew ? null : byId(s.id), now = Date.now();
  if (btn.id === 'deleteBtn') { askConfirm('Delete this sleep?', 'Delete').then((ok) => ok && removeEvent(s.id)); return; }
  if (btn.id !== 'saveBtn' || (!s.isNew && !e)) return;
  const start = F.timeOnDay(s.start, $('#slStart').value, now);
  let end = s.end == null ? null : F.timeOnDay(s.end, $('#slEnd').value, now);
  if (start == null || (s.end != null && end == null)) return toast('Use a time like 13:05');
  if (end != null && end < start) end += 24 * HOUR;          // slept past midnight
  if (end != null && end > now + 5 * MIN) return toast('That wake-up time is in the future');
  closeSheet();
  if (s.isNew) return persist({ id: crypto.randomUUID(), room, type: 'baby', at: new Date(start).toISOString(), by_name: me, data: { kind: 'sleep', start, end } }, true);
  persist({ ...e, at: new Date(start).toISOString(), data: { kind: 'sleep', start, end } }, false);
};

// ---------- bottle ----------
function openBottle(e) {
  sheet = e ? { kind: 'bottle', id: e.id, at: t(e), ml: e.data.ml }
    : { kind: 'bottle', at: Date.now(), ml: +ls.get('ml.bottle') || CONFIG.DEFAULT_ML };
  renderSheet();
}
OPEN_EDIT.bottle = openBottle;
// Typed entry: a time box set to now (type it, or use the phone's clock picker) and typed amounts. No +/- buttons.
const timeRow = (label, ms) => `<div class="row"><label>${label}</label><div class="tbox"><input class="field" id="tIn" type="time" value="${F.hhmm(ms)}"><small id="tDay">${dayWord(ms)}</small></div></div>
  <div class="twarn" id="tWarn" hidden></div>`;
// Keeps s[key] in step with the time box, and shows "today"/"yesterday". On a new entry, a time many
// hours ago gets a warning (it's usually AM/PM picked the wrong way round) with a one-tap fix.
const FAR_PAST_H = 6;
function wireTime(s, key, isNew) {
  const show = () => {
    $('#tIn').value = F.hhmm(s[key]);
    $('#tDay').textContent = dayWord(s[key]);
    if ($('#endsAt')) $('#endsAt').textContent = endsAt(s);
    const far = isNew && F.farInPast(s[key], Date.now(), FAR_PAST_H), w = $('#tWarn');
    w.hidden = !far;
    if (!far) return;
    setHTML(w, `That’s ${far.hours} hours ago (${dayWord(s[key])} ${hm(s[key])}).
      ${far.flip ? `<button class="secondary inline" id="tFix">Use ${hm(far.flip)} ${dayWord(far.flip)}</button>` : 'Check the time before saving.'}`);
    if (far.flip) $('#tFix').onclick = () => { s[key] = far.flip; show(); };
  };
  $('#tIn').oninput = () => {
    const ms = F.timeOnDay(s[key], $('#tIn').value, Date.now());
    if (ms != null) { s[key] = ms; const v = $('#tIn').value; show(); $('#tIn').value = v; }
  };
}
const numBox = (id, value, unit) => `<div class="nbox"><input class="field" id="${id}" inputmode="numeric" pattern="[0-9]*" value="${value}"><span>${unit}</span></div>`;
SHEETS.bottle = () => {
  const s = sheet;
  openSheet(`<h3>${s.id ? 'Edit bottle' : 'Bottle'}</h3>
    ${timeRow('Time', s.at)}
    <div class="row"><label>Amount</label>${numBox('mlIn', s.ml, 'ml')}</div>
    <button class="confirm" id="saveBtn">Save</button>
    ${s.id ? '<button class="secondary danger" id="deleteBtn">Delete</button>' : ''}`);
  wireTime(s, 'at', !s.id);
  $('#mlIn').onfocus = (e) => e.target.select();
};
CLICK.bottle = (btn) => {
  const s = sheet;
  if (btn.id === 'deleteBtn') { askConfirm('Delete this bottle?', 'Delete').then((ok) => ok && removeEvent(s.id)); return; }
  if (btn.id === 'saveBtn') {
    const ml = parseInt($('#mlIn').value, 10);
    if (!(ml > 0 && ml <= 500)) { toast('Amount in ml, e.g. 60'); return $('#mlIn').focus(); }
    const old = s.id && byId(s.id);
    const ev = { id: s.id || crypto.randomUUID(), room, type: 'bottle', at: new Date(s.at).toISOString(), by_name: old ? old.by_name : me, data: { ml } };
    if (!s.id) ls.set('ml.bottle', ml);
    closeSheet();
    persist(ev, !s.id);
  }
};

// ---------- breast feed review / edit ----------
function openBreast(e, now = Date.now(), wasPaused = false) {
  const d = e.data, tot = F.sideTotals(d, now);
  sheet = {
    kind: 'breast', id: e.id, running: d.status === 'running', first: F.firstSide(d),
    start: F.feedStart(d), minL: Math.round(tot.L / MIN), minR: Math.round(tot.R / MIN), wasPaused,
  };
  sheet.orig = { start: sheet.start, minL: sheet.minL, minR: sheet.minR };
  renderSheet();
}
OPEN_EDIT.breast = (e) => openBreast(e);
function openBreastNew() {
  const first = F.startOnSide(events), start = Math.floor((Date.now() - 20 * MIN) / MIN) * MIN;
  sheet = { kind: 'breast', id: null, isNew: true, running: false, first, start,
    minL: first === 'L' ? 10 : 0, minR: first === 'R' ? 10 : 0, wasPaused: false, orig: {} };
  renderSheet();
}

const endsAt = (s) => `Ends ${hm(s.start + (s.minL + s.minR) * MIN)}`;

SHEETS.breast = () => {
  const s = sheet;
  openSheet(`<h3>${s.isNew ? 'Add a feed' : s.running ? 'Save feed' : 'Edit feed'}</h3>
    ${timeRow('Started', s.start)}
    <div class="row"><label>Left</label>${numBox('minL', s.minL, 'min')}</div>
    <div class="row"><label>Right</label>${numBox('minR', s.minR, 'min')}</div>
    <p class="fine" id="endsAt" style="margin:-4px 0 12px">${endsAt(s)}</p>
    <button class="confirm" id="saveBtn">Save</button>
    ${s.isNew ? '' : s.running ? '<button class="secondary" id="backBtn">Back to timer</button>' : '<button class="secondary danger" id="deleteBtn">Delete</button>'}`, !s.running);
  wireTime(s, 'start', s.isNew);
  for (const k of ['minL', 'minR']) {
    const input = $('#' + k);
    input.onfocus = () => input.select();
    input.oninput = () => { s[k] = Math.max(0, Math.min(240, parseInt(input.value, 10) || 0)); $('#endsAt').textContent = endsAt(s); };
  }
};

CLICK.breast = (btn) => {
  const s = sheet;
  if (btn.id === 'saveBtn' && s.isNew) {
    const data = F.editFeed({ start: s.start, minL: s.minL, minR: s.minR, first: s.first });
    if (!data) return toast('Add some minutes first');
    closeSheet();
    return persist({ id: crypto.randomUUID(), room, type: 'breast', at: new Date(F.feedStart(data)).toISOString(), by_name: me, data }, true);
  }
  const e = byId(s.id);
  if (btn.id === 'backBtn') {
    closeSheet();
    const data = e && F.backToTimer(e.data, s.wasPaused, Date.now());
    if (!data) return toast('That feed was already saved on the other phone');
    if (data !== e.data) persist({ ...e, data }, false);
    return;
  }
  if (btn.id === 'deleteBtn') { askConfirm('Delete this feed?', 'Delete').then((ok) => ok && removeEvent(s.id)); return; }
  if (btn.id === 'saveBtn') {
    if (!e) { closeSheet(); return toast('That feed was removed on the other phone'); }
    const unchanged = s.start === s.orig.start && s.minL === s.orig.minL && s.minR === s.orig.minR;
    const data = unchanged ? F.finishFeed(e.data, Date.now()) : F.editFeed({ start: s.start, minL: s.minL, minR: s.minR, first: s.first });
    if (!data) return toast('Add some minutes, or delete the feed');
    closeSheet();
    persist({ ...e, at: new Date(F.feedStart(data)).toISOString(), data }, false);
  }
};

document.querySelector('#buttons').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.id === 'bottleBtn') return openBottle();
  if (b.dataset.side) {
    if (F.pickRunning(events).current) return render(); // the other phone already started one
    const now = Date.now();
    persist({ id: crypto.randomUUID(), room, type: 'breast', at: new Date(now).toISOString(), by_name: me, data: F.startFeed(b.dataset.side, now) }, true);
  }
});

$('#logsMore').addEventListener('click', (ev) => { if (ev.target.closest('#moreDays')) showEarlierDays(); });
// Feed section +: add a feed you forgot to time, or a bottle.
$('#feedPlus').onclick = () => {
  sheet = null;
  openSheet(`<h3>Add a feed</h3>
    <button class="confirm" id="fpBreast">Breast feed</button>
    <button class="secondary" id="fpBottle">Bottle</button>`);
  $('#fpBreast').onclick = () => openBreastNew();
  $('#fpBottle').onclick = () => openBottle();
};
$('#addBreast').onclick = () => openBreastNew();
$('#addBottle').onclick = () => openBottle();

$('#timeline').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-id]');
  const e = b && byId(b.dataset.id);
  if (e && OPEN_EDIT[e.type]) OPEN_EDIT[e.type](e);
});

// ---------- settings ----------
const cleanPhone = (p) => p.replace(/[^\d]/g, '').replace(/^00/, '');

function openSettings() {
  sheet = null;
  const b = baby(), firstRun = false;   // no welcome form: her details are built in, your name is optional
  const ws = F.weights(events).slice(0, 3);
  const wItems = ws.map((w) => `<li><span>${new Date(w.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>
      <b>${esc(w.data.kg)} kg</b><button class="x" data-del="${w.id}" aria-label="Delete weight">×</button></li>`).join('');
  openSheet(`<h3>${firstRun ? 'Welcome' : 'Settings'}</h3>
    <label class="set-label">Your name (optional, labels who logged a feed)</label><input class="field" id="sName" value="${esc(me)}" placeholder="e.g. Sam">
    <label class="set-label">Partner’s WhatsApp number (with country code)</label>
    <input class="field" id="sPhone" inputmode="tel" value="${esc(partnerPhone)}" placeholder="e.g. 44 7700 900123">
    <label class="set-label">Baby’s name</label><input class="field" id="sBaby" value="${esc(typeof b.name === 'string' ? b.name : '')}" placeholder="e.g. Ava">
    <label class="set-label">Baby’s birth date</label><input class="field" id="sBirth" type="date" value="${esc(b.birth || '')}">
    <label class="set-label">Time between feeds</label>
    <button class="secondary" id="sInterval" style="margin-top:0">${F.intervalLabel(intervalMin())} · change</button>
    <label class="set-label">Breast milk estimate (ml per minute)</label>
    <input class="field" id="sRate" inputmode="decimal" value="${esc(mlPerMin())}">
    <p class="fine">A rough guess. If your midwife does a weighed feed, divide the ml by the minutes and put that here.</p>
    <button class="confirm" id="sSave" style="margin-top:18px">Save</button>

    <h3 style="margin-top:26px">Weight check-in</h3>
    <div class="row"><input class="field" id="wKg" inputmode="decimal" placeholder="kg, e.g. 4.35"><input class="field" id="wDate" type="date" value="${isoDate(Date.now())}"></div>
    <button class="secondary" id="wAdd">Add weight</button>
    <ul class="wlist">${wItems || `<li class="fine">No weights yet. Using ${weightKg()} kg.</li>`}</ul>

    ${CONFIG.FAMILY ? '<p class="fine" style="margin-top:20px">Both phones open the same family log automatically. Anything logged on one shows up on the other.</p>' : `
    <h3 style="margin-top:26px">Sharing</h3>
    <button class="secondary" id="sShare">Send this log’s link to partner</button>
    ${sb ? `<button class="secondary" id="sCopy">Copy log link</button>
    ${pasteBox()}
    <label class="set-label">Recovery email</label><div id="sRecovery" class="fine">Checking…</div>` : ''}`}

    <h3 style="margin-top:26px">Backup</h3>
    <button class="secondary" id="sExport">Export / back up</button>
    <button class="secondary" id="sImport">Restore from a backup</button>
    <input type="file" id="sFile" accept="application/json,.json" hidden>
    <p class="fine" style="text-align:center;margin-top:12px">Room ${esc(room)}${CONFIG.SUPABASE_URL ? '' : ' · demo mode (not shared)'}</p>`, !firstRun);

  $('#sSave').onclick = async () => {
    const name = $('#sName').value.trim();
    const rate = posNum($('#sRate').value);
    if (rate && (rate < 0.5 || rate > 30)) { toast('ml per minute: 0.5–30'); return $('#sRate').focus(); }
    me = name; ls.set('name', me);
    partnerPhone = cleanPhone($('#sPhone').value); ls.set('partner', partnerPhone);
    const next = { ...b, name: $('#sBaby').value.trim(), birth: $('#sBirth').value, mlPerMin: rate || '' };
    closeSheet();
    if (JSON.stringify(next) !== JSON.stringify(b)) {
      await persist({ id: crypto.randomUUID(), room, type: 'baby', at: new Date().toISOString(), by_name: me, data: next }, true);
    }
  };
  $('#sInterval').onclick = openInterval;
  $('#wAdd').onclick = () => addWeight($('#wKg'), $('#wDate'), openSettings);
  $('#sheet').querySelectorAll('[data-del]').forEach((x) => {
    x.onclick = async () => { const id = x.dataset.del; if (await askConfirm('Delete this weight?', 'Delete')) await removeEvent(id); openSettings(); };
  });
  if ($('#sShare')) $('#sShare').onclick = () => {
    location.href = `https://wa.me/${cleanPhone($('#sPhone').value)}?text=${encodeURIComponent('Feed Log: ' + shareLink())}`;
  };
  if (sb && $('#sCopy')) {
    $('#sCopy').onclick = () => navigator.clipboard.writeText(shareLink()).then(() => toast('Link copied', true), () => toast('Couldn’t copy. Use Send instead.'));
    wirePaste();
    renderRecovery();
  }
  $('#sExport').onclick = async () => {
    let all;
    try { all = await store.exportAll(); } catch (err) { console.error(err); return toast('Can’t reach server'); }
    const file = new File([JSON.stringify(F.backupFile(room, all, Date.now()), null, 1)],
      `feed-log-${room}-${isoDate(Date.now())}.json`, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {   // iPhone/Android: share sheet → Save to Files
      try { await navigator.share({ files: [file], title: 'Feed Log backup' }); } catch {}
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10e3);
  };
  $('#sImport').onclick = () => $('#sFile').click();
  $('#sFile').onchange = async () => {
    const f = $('#sFile').files[0];
    if (!f) return;
    const parsed = F.parseBackup(await f.text(), room);
    if (!parsed) return toast('That isn’t a Feed Log backup');
    if (!(await askConfirm(`Restore ${parsed.events.length} entries into this log?`, 'Restore'))) return;
    let n;
    try { n = await store.importMany(parsed.events); } catch (err) { console.error(err); return toast('Can’t reach server'); }
    await refresh();
    toast(`Restored ${n} entries (${parsed.events.length - n + parsed.skipped} already there or invalid)`, true);
  };
}
$('#settingsBtn').onclick = openSettings;

// Tap her name to rename her; tap the picture to choose a photo. Both live on the shared baby record,
// so the other phone sees them too. The photo is shrunk to a small square JPEG first.
const saveBaby = (patch) => persist({ id: crypto.randomUUID(), room, type: 'baby', at: new Date().toISOString(), by_name: me, data: { ...baby(), ...patch } }, true);
$('#babyName').onclick = () => {
  openSheet(`<h3>Baby’s name</h3>
    <input class="field" id="nName" value="${esc(baby().name || '')}" placeholder="e.g. Baby" autocomplete="off">
    <button class="confirm" id="nSave">Save</button>`);
  const input = $('#nName');
  input.focus(); input.select();
  const save = async () => {
    const name = input.value.trim();
    closeSheet();
    if (name && name !== baby().name) await saveBaby({ name });
  };
  $('#nSave').onclick = save;
  input.onkeydown = (ev) => { if (ev.key === 'Enter') save(); };
};
$('#photoBtn').onclick = () => $('#photoFile').click();
$('#photoFile').onchange = async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const img = await createImageBitmap(file);
    const side = Math.min(img.width, img.height), size = 240, c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
    await saveBaby({ photo: c.toDataURL('image/jpeg', 0.8) });
  } catch (err) { console.error(err); toast('Couldn’t use that photo. Try another.'); }
};

// ---------- misc ----------
function toast(msg, ok = false) {
  const el = $('#toast'); el.textContent = msg; el.style.display = 'block';
  el.style.background = ok ? 'var(--ok)' : '';
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.style.display = 'none'), 3000);
}

setInterval(() => { renderStatus(); renderTimer(); renderSleep(); }, 1000);
setInterval(render, 60e3);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
window.addEventListener('online', refresh);
// Safety net for live sync: phones drop the live connection when locked, so re-check every 30 s while open.
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 30e3);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// The old Netlify address: hand this phone's log (room + join code) over to the new address.
if (MOVED) {
  const r = F.validRoom(ls.get('room')) ? ls.get('room') : '', c = F.validCode(ls.get('code')) ? ls.get('code') : '';
  const to = CONFIG.HOME_URL + (r && c ? `?room=${r}&code=${c}` : '');
  openSheet(`<h3>Feed Log has moved</h3>
    <p>It has moved to a new address. Tap below and you’ll land in the same log, with all your history.</p>
    <a class="confirm" style="display:grid;place-items:center;text-decoration:none" href="${esc(to)}">Open the new Feed Log</a>
    <p class="fine">Then add the new one to your home screen (Share → Add to Home Screen on iPhone, ⋮ → Add to Home screen on Android) and remove the old icon.</p>`, false);
} else startApp();

function startApp() {
showPage(ls.get('page'));
render();
bootstrap().then(async (ok) => {
  if (!ok) return;
  render();
  await refresh();
  store.subscribe(sync.applyRemote, sync.applyRemoteDelete);
  await importHistoryOnce();
  moveOldLogs();
});
}
