// =============================================================================
// ACCOUNT VALUE OVER TIME — what an account was worth on each past day.
//
// Nothing on chain stores that, so it is rebuilt. Start from what the account
// holds today, walk its transfers backwards undoing each one, and price every
// day's holdings at that day's close on Alcor.
//
// What the rebuild treats as the account's own money changing place rather
// than value arriving or leaving, and so skips:
//   - WAX moving to and from eosio.stake (staking for CPU and NET, refunds)
//   - tokens deposited into Alcor and TacoSwap positions and paid back out
// Which is why today's starting point includes staked WAX and the tokens inside
// liquidity positions: they are carried back to the day they were put there. A
// position that has since shifted its mix is carried back with today's mix —
// the page says so. NFTs and farm stakes are not in it.
// =============================================================================

import { HYPERION_HOSTS, dropEchoes } from './chain.js';
import { alcorCandles } from './store.js';

const DAY = 86400000;
const tsOf = a => new Date(a.timestamp + (String(a.timestamp).endsWith('Z') ? '' : 'Z')).getTime();

// A year of transfers, newest first, paged by time rather than by skip: a
// public Hyperion stops honouring skip at ten thousand rows. Kept for ten
// minutes, so the lookup that follows a transaction reads one page, not ten.
//
// The nodes do not agree on how far back they remember. Asked for the same
// account's year, one answered 5,142 transfers back to the first day, one
// 3,392 back to November, one 715 back to February, one 899 back to August —
// and paging across them in rotation stitched those into a history that
// changed on every reload. So the read runs newest-first on one node until
// that node has nothing older, and only then continues, from exactly that
// point in time, on a node that remembers further back. The one that remembers
// most also serves a hundred rows a page where the others serve a thousand,
// which is why it is not simply used for everything.
const historyCache = new Map();
const DEEP_HOST = 'https://wax-history.eosdac.io';
// Not in the shared rotation: it refuses any page over a hundred rows, and the
// rest of the app asks for 250 and 1,000 — a quarter of those requests failed
// and were retried onto nodes already rate-limiting.
const HISTORY_HOSTS = [...HYPERION_HOSTS, DEEP_HOST];
const pageSize = new Map([[DEEP_HOST, 100]]);
export async function transferHistory(account, { days = 365, maxRequests = 30, onProgress = null } = {}) {
  const since = Date.now() - days * DAY;
  const after = new Date(since).toISOString();
  const cached = historyCache.get(account);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000 && cached.since <= since + DAY) {
    const fresh = await page(cached.host, account, new Date(cached.at - 60000).toISOString(), null).then(r => r.actions).catch(() => []);
    const seen = new Set(cached.rows.map(key));
    cached.rows = [...fresh.filter(a => !seen.has(key(a))), ...cached.rows];
    cached.at = Date.now();
    return { actions: dropEchoes(cached.rows), complete: cached.complete, requests: 1 };
  }

  onProgress?.(0);
  const probes = await probeHosts(account, after);
  const rows = [];
  const seen = new Set();
  let before = null, requests = probes.length, complete = false, first = null;
  const done = new Set();
  while (requests < maxRequests) {
    // A node that still has something older than the cursor: the biggest pages
    // first, then the longest memory.
    const cursor = before ? new Date(before).getTime() : Date.now();
    const host = probes
      .filter(p => !done.has(p.host) && p.oldest < cursor - 60000)
      .sort((x, y) => (limitOf(y.host) - limitOf(x.host)) || (x.oldest - y.oldest))[0]?.host;
    if (!host) { complete = true; break; }
    first = first || host;
    let got, total;
    try {
      ({ actions: got, total } = await page(host, account, after, before));
      requests++;
    } catch (e) {
      requests++;
      const cap = /maximum:\s*(\d+)/i.exec(String(e.message));
      if (cap) { pageSize.set(host, Number(cap[1])); continue; }
      done.add(host);
      continue;
    }
    onProgress?.(rows.length + got.length);
    let fresh = 0;
    for (const a of got) {
      const k = key(a);
      if (seen.has(k)) continue;
      seen.add(k); rows.push(a); fresh++;
    }
    if (got.length) { const t = String(got.at(-1).timestamp); before = t.endsWith('Z') ? t : t + 'Z'; }
    // This node is finished when its own count says the page held everything
    // left, or it returned nothing, or a whole page repeated (a thousand rows in
    // one instant, which paging by time cannot get past).
    if (!got.length || !fresh || (total && total.relation === 'eq' && total.value <= got.length)) done.add(host);
  }
  // Reaching the start of the window is finishing, whichever limit came first.
  if (!complete && before && new Date(before).getTime() <= since + DAY) complete = true;
  historyCache.set(account, { rows, complete, since, host: first, at: Date.now() });
  return { actions: dropEchoes(rows), complete, requests };
}

const limitOf = host => pageSize.get(host) || 1000;

// Each node's oldest transfer for this account inside the window, asked for as
// a single row.
async function probeHosts(account, after) {
  const probes = await Promise.all(HISTORY_HOSTS.map(async host => {
    try {
      const q = new URLSearchParams({ account, 'act.name': 'transfer', after, limit: '1', sort: 'asc' });
      const d = await get(`${host}/v2/history/get_actions?${q}`);
      const a = d.actions?.[0];
      // Answered with nothing: a node that has no transfers for this account
      // in the window. Different from not answering at all.
      return { host, oldest: a ? tsOf(a) : Infinity };
    } catch { return null; }
  }));
  const answered = probes.filter(Boolean);
  // Not one node answered. Carrying today's holdings back a year and calling
  // it a history would draw a line out of nothing.
  if (!answered.length) throw new Error('No history node answered');
  return answered;
}

async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j?.message) msg += `: ${j.message}`; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

const key = a => `${a.trx_id}:${a.action_ordinal}:${a.global_sequence ?? ''}`;
async function page(host, account, after, before) {
  const q = { account, 'act.name': 'transfer', after, limit: String(limitOf(host)), sort: 'desc' };
  if (before) q.before = before;
  const d = await get(`${host}/v2/history/get_actions?${new URLSearchParams(q)}`);
  return { actions: d.actions || [], total: d.total || null };
}

// One transfer as a change to what the account holds, or null when it is not
// one: not this account's, not a token amount, or the account's own money
// moving between its wallet, its stake and its positions.
export function movement(a, me) {
  const x = a.act?.data;
  if (!x || x.from === x.to || (x.from !== me && x.to !== me)) return null;
  const [amtStr, sym] = String(x.quantity || '').split(' ');
  const amount = parseFloat(amtStr);
  if (!(amount > 0) || !sym) return null;
  const other = x.from === me ? x.to : x.from;
  const memo = String(x.memo || '').trim();
  if (other === 'eosio.stake') return null;
  if (other === 'swap.alcor') {
    // In: "deposit" funds a position; swaps carry a route. Out: "Swap tokenOut"
    // pays a trade; everything else pays back liquidity, fees or a leftover.
    if (x.to === 'swap.alcor' && /^deposit$/i.test(memo)) return null;
    if (x.from === 'swap.alcor' && !/^swap/i.test(memo)) return null;
  }
  if (other === 'swap.taco') {
    // In: "deposit" before addliquidity; a swap's memo is its minimum out. Out:
    // "liquidity withdraw" and "refund liquidity slippage"; a swap pays out
    // with an empty memo.
    if (x.to === 'swap.taco' && /^deposit$/i.test(memo)) return null;
    if (x.from === 'swap.taco' && /liquidity/i.test(memo)) return null;
  }
  return { ts: tsOf(a), id: `${sym}@${a.act.account}`, delta: x.to === me ? amount : -amount };
}

// Day boundaries, newest first: now, then each UTC midnight going back. Each
// snapshot is labelled with the day that ended at it.
function boundaries(days, since) {
  const now = Date.now();
  const midnight = Math.floor(now / DAY) * DAY;
  const out = [{ at: now, day: midnight }];
  for (let k = 0; k < days; k++) {
    const at = midnight - k * DAY;
    if (since != null && at < since) break;
    out.push({ at, day: at - DAY });
  }
  return out;
}

// Walk the moves back across the boundaries, calling visit(boundary, holdings)
// at each. `moves` is newest first.
function walk(holdingsNow, moves, bounds, visit) {
  const h = new Map(holdingsNow);
  let i = 0;
  for (const b of bounds) {
    while (i < moves.length && moves[i].ts > b.at) {
      const m = moves[i++];
      h.set(m.id, (h.get(m.id) || 0) - m.delta);
    }
    visit(b, h);
  }
}

// A price for any day from a sparse series: that day's close, else the last
// close before it, else the first one after.
function lookup(series, day) {
  if (!series.length) return null;
  let lo = 0, hi = series.length - 1;
  if (day < series[0][0]) return series[0][1];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid][0] <= day) lo = mid; else hi = mid - 1;
  }
  return series[lo][1];
}

const dailyCloses = (candles, invert) => candles
  .map(c => [Math.floor(c.time * 1000 / DAY) * DAY, invert ? 1 / c.close : c.close])
  .filter(([, v]) => v > 0 && isFinite(v));

// `pools`, `prices`, `stables` and `waxId` come from the page's state; the
// module keeps no copy of them.
export async function accountValueHistory({
  account, holdingsNow, pools, prices, stables, waxId, waxPoolId = '314', cap = (id, v) => v,
  days = 365, maxTokens = 12, onProgress = null,
}) {
  const hist = await transferHistory(account, {
    days, onProgress: n => onProgress?.(`Reading transfers${n ? ` — ${n.toLocaleString()} so far` : ''}…`),
  });
  const moves = hist.actions.map(a => movement(a, account)).filter(Boolean).sort((a, b) => b.ts - a.ts);
  // The line starts where the history read starts. A node that keeps seven
  // months cannot vouch for the five before them, even when it says "that is
  // everything".
  const windowStart = Date.now() - days * DAY;
  const oldest = hist.actions.length ? hist.actions.reduce((m, a) => Math.min(m, tsOf(a)), Infinity) : null;
  const since = oldest == null ? windowStart : Math.max(windowStart, oldest - DAY);
  const bounds = boundaries(days, since);

  // Which tokens ever mattered, at today's price: the largest amount held on
  // any day, valued now. The long tail of airdrops is not worth a price read.
  const nowUsd = id => prices.get(id)?.usd ?? null;
  const peak = new Map();
  walk(holdingsNow, moves, bounds, (b, h) => {
    for (const [id, amt] of h) if (amt > 0 && amt > (peak.get(id) || 0)) peak.set(id, amt);
  });
  const ranked = [...peak]
    .map(([id, amt]) => ({ id, usd: nowUsd(id) != null ? cap(id, amt * nowUsd(id)) : null }))
    .filter(x => x.usd != null && x.usd >= 1)
    .sort((a, b) => b.usd - a.usd);
  const chosen = ranked.slice(0, maxTokens).map(x => x.id);

  // Daily USD closes per chosen token: its deepest Alcor pool against WAX (or
  // a stable), times WAX's own daily close in dollars.
  const alcorPools = pools.filter(p => p.dex === 'alcor' && p.tvlReal > 0);
  const waxPool = pools.find(p => p.dex === 'alcor' && String(p.id) === String(waxPoolId));
  const flat = [];
  const series = new Map();
  const read = async (pool, invert) => dailyCloses(await alcorCandles(pool.id, 86400).catch(() => []) || [], invert);

  let waxUsd = [];
  if (waxPool) waxUsd = await read(waxPool, waxPool.tokenB === waxId);

  // A token's daily dollar closes: through its deepest Alcor pool against WAX
  // or a stable, else one step further — its deepest pool against a token that
  // has one of those. Remembered, since a partner is often priced twice.
  const memo = new Map();
  const deepest = (id, ok) => alcorPools
    .filter(p => (p.tokenA === id && ok(p.tokenB)) || (p.tokenB === id && ok(p.tokenA)))
    .sort((a, b) => b.tvlReal - a.tvlReal)[0] || null;
  const direct = id => deepest(id, o => o === waxId || stables.has(o));
  const usdSeries = async (id, hop = 0) => {
    if (memo.has(id)) return memo.get(id);
    let out = null;
    if (stables.has(id)) out = [[0, 1]];
    else if (id === waxId && waxUsd.length) out = waxUsd;
    else {
      let pool = direct(id);
      if (!pool && hop === 0) pool = deepest(id, o => !!direct(o));
      if (pool) {
        const other = pool.tokenA === id ? pool.tokenB : pool.tokenA;
        const closes = await read(pool, pool.tokenB === id);
        const otherUsd = closes.length ? await usdSeries(other, hop + 1) : null;
        if (closes.length && otherUsd?.length) out = closes.map(([d, v]) => [d, v * (lookup(otherUsd, d) || 0)]);
      }
    }
    memo.set(id, out);
    return out;
  };

  let n = 0;
  for (const id of chosen) {
    onProgress?.(`Pricing ${++n} of ${chosen.length} tokens…`);
    const got = await usdSeries(id);
    if (got?.length) series.set(id, got);
    else {
      // No history to price it with: today's price on every day, and said so.
      series.set(id, [[0, nowUsd(id)]]);
      flat.push(id);
    }
  }

  const points = [];
  walk(holdingsNow, moves, bounds, (b, h) => {
    let v = 0;
    for (const id of chosen) {
      const amt = h.get(id) || 0;
      if (!(amt > 0)) continue;
      const px = b.at === bounds[0].at ? nowUsd(id) : lookup(series.get(id) || [], b.day);
      if (px > 0) v += cap(id, amt * px);
    }
    points.push({ time: Math.floor(b.day / 1000), value: v });
  });
  points.reverse();

  return {
    points,
    from: bounds.at(-1)?.day ?? null,
    complete: hist.complete,
    transfers: hist.actions.length,
    tokens: chosen.length,
    notCharted: Math.max(0, ranked.length - chosen.length),
    flat,
  };
}
