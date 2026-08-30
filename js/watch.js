// =============================================================================
// WATCHLIST — the honest version of alerts on a site with no server.
//
// A real alert needs something awake when you are not: a job that watches the
// chain and pushes you a message. This terminal is a folder of files on a
// static host, so it cannot have one, and pretending otherwise would mean a
// bell icon that never rings.
//
// What it can do is remember. The browser stores which pools, tokens and farms
// you follow *and what they were worth when you last looked*, so the next visit
// opens with what moved while you were gone. That answers the question an alert
// is usually asked to answer — "did anything happen?" — without lying about
// being awake.
//
// Everything lives in this browser. Nothing is uploaded, there is no account,
// and clearing site data clears the list.
// =============================================================================

const KEY = 'waxterminal.watch.v1';

// A watched thing is a kind plus an id: 't:HOLE@hole.cheese', 'p:alcor:11051',
// 'f:alcor:4004'. The kind is part of the key because a pool and a farm can
// share an id and mean different things.
let store = { ids: [], seen: {} };
let loaded = false;

function load() {
  if (loaded) return store;
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (Array.isArray(d?.ids)) store = { ids: d.ids, seen: d.seen || {} };
    }
  } catch { /* private mode, blocked storage, corrupt value — start empty */ }
  return store;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* nothing to do about it */ }
}

const listeners = new Set();
export const onWatchChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const fire = () => { for (const fn of listeners) { try { fn(); } catch {} } };

export const watchKey = (kind, id) => `${kind}:${id}`;
export function isWatched(kind, id) { load(); return store.ids.includes(watchKey(kind, id)); }
export function watchCount() { load(); return store.ids.length; }
export function watchedOf(kind) { load(); return store.ids.filter(k => k.startsWith(kind + ':')).map(k => k.slice(kind.length + 1)); }

export function toggleWatch(kind, id) {
  load();
  const k = watchKey(kind, id);
  const i = store.ids.indexOf(k);
  if (i >= 0) { store.ids.splice(i, 1); delete store.seen[k]; }
  else store.ids.push(k);
  save();
  fire();
  return i < 0;
}

// What each watched thing looked like when the page last showed it to you.
// Recorded on render rather than on some timer, because "since you last looked"
// is the only baseline a visitor can reason about — a fixed 24h window would
// report the same move on three visits in one afternoon.
// The baseline is only moved forward once a visit has had time to be a visit.
// The overview renders twice within seconds of loading — once from the
// snapshot, once when the live sweep lands — and re-recording on each would
// turn "since you last looked" into "since two seconds ago" before the reader
// had finished the sentence.
const MIN_REBASE_MS = 10 * 60 * 1000;

export function markSeen(kind, id, metrics) {
  load();
  const k = watchKey(kind, id);
  if (!store.ids.includes(k)) return;
  const prev = store.seen[k];
  if (prev && Date.now() - prev.at < MIN_REBASE_MS) return;
  store.seen[k] = { at: Date.now(), ...metrics };
  save();
}

// The comparison, made before markSeen overwrites it. Returns only fields that
// were recorded last time and have a number now, so a newly-watched thing
// reports nothing rather than a move from zero.
export function sinceSeen(kind, id, metrics) {
  load();
  const prev = store.seen[watchKey(kind, id)];
  if (!prev) return null;
  const out = { at: prev.at, changed: [] };
  for (const [field, now] of Object.entries(metrics)) {
    const was = prev[field];
    if (typeof was !== 'number' || typeof now !== 'number' || !isFinite(was) || !isFinite(now)) continue;
    if (was === 0 && now === 0) continue;
    out.changed.push({ field, was, now, pct: was !== 0 ? (now / was - 1) * 100 : null });
  }
  return out.changed.length ? out : { ...out, changed: [] };
}

// A star, wired. Kept here so every table draws the same control and the same
// pressed state rather than three near-copies.
export function watchStar(kind, id, label = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'star';
  const paint = () => {
    const on = isWatched(kind, id);
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? '★' : '☆';
    b.title = on ? `Following ${label || id} — click to stop` : `Follow ${label || id} and see what moved next visit`;
  };
  paint();
  b.onclick = e => { e.stopPropagation(); toggleWatch(kind, id); paint(); };
  onWatchChange(paint);
  return b;
}
