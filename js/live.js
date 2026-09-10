// =============================================================================
// LIVE — a trade tape that keeps up, for the market you are looking at.
//
// Alcor serves every swap in a pool with the trader, both signed amounts, the
// post-trade sqrt price, a dollar figure and a timestamp — the exact columns a
// DexScreener tape shows. It is their server, behind Cloudflare, and the person
// most likely to have this page open also runs trading bots against that same
// host from the same address. So this is deliberately gentle:
//
//   one pool at a time, the one on screen
//   one request every 7 seconds, and none while the tab is hidden
//   backs off to a minute after failures, and says so
//   a trade is only ever added once, keyed on its transaction id
//
// Nothing else on the page polls. Everything else is the two-hourly snapshot.
// =============================================================================

const API = 'https://wax.alcor.exchange/api/v2/swap/pools';
const EVERY_MS = 7000;
const MAX_BACKOFF_MS = 60000;

// Returns a stop function. `onRows(fresh, all)` receives the trades that are
// new since the last call, newest first, and the whole kept list.
export function watchPoolTrades(poolId, onRows, { keep = 80, onState = () => {} } = {}) {
  let stopped = false;
  let timer = null;
  let wait = EVERY_MS;
  let failures = 0;
  const seen = new Set();
  let rows = [];

  const tick = async () => {
    if (stopped) return;
    // A hidden tab reads nothing. It picks up where it left off when shown.
    if (typeof document !== 'undefined' && document.hidden) { schedule(); return; }
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 9000);
      const r = await fetch(`${API}/${encodeURIComponent(poolId)}/swaps?limit=40`, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(t);
      if (r.status === 429) throw new Error('rate limited');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const list = Array.isArray(d) ? d : (d?.swaps || []);
      const fresh = [];
      for (const x of list) {
        const id = x.trx_id || x._id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        fresh.push(x);
      }
      if (fresh.length) {
        fresh.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
        rows = [...fresh, ...rows].slice(0, keep);
        // Keep the de-dup set from growing without bound on a busy pool.
        if (seen.size > keep * 4) { seen.clear(); for (const x of rows) seen.add(x.trx_id || x._id); }
        onRows(fresh, rows);
      } else if (!rows.length) {
        onRows([], rows);
      }
      failures = 0; wait = EVERY_MS;
      onState({ ok: true, at: Date.now() });
    } catch (e) {
      failures++;
      // Double the gap each time up to a minute. Three failures in a row is a
      // host having a bad time, and hammering it is how an address gets banned.
      wait = Math.min(MAX_BACKOFF_MS, EVERY_MS * 2 ** failures);
      onState({ ok: false, error: String(e?.message || e), retryIn: wait });
    }
    schedule();
  };
  const schedule = () => { if (!stopped) timer = setTimeout(tick, wait); };
  const onVis = () => { if (!document.hidden && !stopped) { clearTimeout(timer); tick(); } };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
  tick();

  return () => {
    stopped = true;
    clearTimeout(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
  };
}

// Which way a trade went, from the pool's point of view. A negative token A
// amount means A LEFT the pool, which is somebody buying A.
export const tradeSide = x => (Number(x.tokenA) < 0 ? 'buy' : 'sell');

// B per A after the trade, from the price the pool itself recorded.
export function tradePrice(x, decA, decB) {
  try {
    const s = Number(BigInt(x.sqrtPriceX64)) / 2 ** 64;
    return s * s * 10 ** (decA - decB);
  } catch { return null; }
}
