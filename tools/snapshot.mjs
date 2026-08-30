// =============================================================================
// SNAPSHOT — runs in GitHub Actions, not on anyone's server.
//
// Two jobs:
//   1. data/pools.json    a precomputed snapshot so a first visit paints in
//                         under a second instead of sweeping the chain for 15s.
//   2. data/history.ndjson  one appended line per run. This is the memory the
//                         terminal otherwise does not have: Hyperion's retention
//                         is not ours to rely on, and nothing else records what
//                         a farm's APR was last Tuesday.
//
// Deliberately not a database. The whole dataset fits in memory, the browser
// already filters and sorts it, and a file in the repo needs no host, no
// credentials and no uptime.
// =============================================================================

import { writeFile, appendFile, readFile, mkdir } from 'node:fs/promises';
import { loadCore, state, farmGroups, groupStakedUsd } from '../js/store.js';
import { hyperion } from '../js/chain.js';
import { parseAsset } from '../js/math.js';

const OUT = new URL('../data/', import.meta.url);
const TOP_POOLS_IN_HISTORY = 150;
const MIN_TVL = 100;

const round = (v, d = 6) => (v == null || !isFinite(v)) ? null : Number(v.toFixed(d));

await mkdir(OUT, { recursive: true });
console.log('reading chain…');
const t0 = Date.now();
await loadCore({ force: true, onProgress: p => p.msg && console.log('  ' + p.msg) });
console.log(`read in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${state.pools.length} pools, ${state.farms.length} farms`);

// Alcor's staked value needs two chain reads per farmed pool. Doing that in the
// visitor's browser meant a button labelled "compute APR", which is asking the
// reader to do the terminal's job — and most never would, so most farms showed
// no APR at all. It belongs here: a few hundred calls once a day, on a runner,
// against nobody's home connection.
const alcorGroups = farmGroups().filter(g => g.dex === 'alcor' && g.farms.some(f => f.numStakes > 0));
console.log(`valuing ${alcorGroups.length} Alcor farm groups...`);
let valued = 0;
const BATCH = 6;
for (let i = 0; i < alcorGroups.length; i += BATCH) {
  await Promise.all(alcorGroups.slice(i, i + BATCH).map(async g => {
    try {
      const usd = await groupStakedUsd(g);
      if (usd == null) return;
      g.stakedUsd = usd;
      const ratio = g.pool?.tvl > 0 ? (g.pool.tvlReal || 0) / g.pool.tvl : 0;
      g.stakedReal = usd * ratio;
      if (g.stakedReal >= 25 && g.rewardRealDay > 0) g.aprReal = (g.rewardRealDay * 365 / g.stakedReal) * 100;
      if (g.stakedUsd >= 25 && g.rewardUsdDay > 0) g.apr = (g.rewardUsdDay * 365 / g.stakedUsd) * 100;
      valued++;
    } catch {}
  }));
  if (i % 60 === 0) console.log(`  ${Math.min(i + BATCH, alcorGroups.length)}/${alcorGroups.length}`);
}
console.log(`valued ${valued} Alcor groups`);

// Push the computed values back onto the underlying farm rows so the snapshot
// carries them.
// The group carries `key` (already dex:poolId) and `dex` — it has no `poolDex`,
// so building the index on that produced keys of "undefined:603" while the farm
// rows looked up "alcor:603". Every one of the 362 valuations was computed and
// then silently dropped on the floor.
const groupByPool = new Map(alcorGroups.map(g => [g.key, g]));
for (const f of state.farms) {
  const g = groupByPool.get(`${f.poolDex}:${f.poolId}`);
  if (!g || g.stakedUsd == null) continue;
  f.stakedUsd = g.stakedUsd; f.stakedReal = g.stakedReal;
  const share = g.rewardUsdDay > 0 ? (f.rewardUsdDay || 0) / g.rewardUsdDay : 0;
  f.apr = (g.stakedUsd >= 25 && f.rewardUsdDay > 0) ? (f.rewardUsdDay * 365 / g.stakedUsd) * 100 : f.apr;
  f.aprReal = (g.stakedReal >= 25 && f.rewardRealDay > 0) ? (f.rewardRealDay * 365 / g.stakedReal) * 100 : f.aprReal;
  f.aprStatus = f.apr != null ? 'ok' : f.aprStatus;
}

// Alcor publishes 24h/week/month volume per pool. Deriving that here from the
// swap feed would mean paging tens of thousands of actions and extrapolating
// from a noisy window — measured against these figures, a 15-minute sample
// missed by up to 4x. Their number is the better one, so use it and say so.
const volByPool = new Map();
try {
  const r = await fetch('https://wax.alcor.exchange/api/v2/swap/pools', { signal: AbortSignal.timeout(45000) });
  if (r.ok) {
    for (const p of await r.json()) {
      volByPool.set(String(p.id), {
        d1: p.volumeUSD24 ?? null, d7: p.volumeUSDWeek ?? null, d30: p.volumeUSDMonth ?? null,
        ch24: p.change24 ?? null,
        // When Alcor first saw the pool — the only reliable age we can get, and
        // new pools are where both the yield and the rug live.
        born: p.firstSeenAt ? Date.parse(p.firstSeenAt) || null : null,
      });
    }
    console.log(`volume: ${volByPool.size} Alcor pools`);
  }
} catch (e) { console.log('volume fetch failed, continuing without:', e.message); }

// Alcor is the only venue that publishes volume, so the others are counted from
// their own swap logs: Taco's exchangelog, Defibox's and A-DEX's swaplog. Each
// carries the amounts and the pool, so one pass over 24 hours gives volume per
// pool priced with the same numbers as everything else on the page.
async function volumeFromLogs(account, action, poolField, { pages = 30 } = {}) {
  const after = new Date(Date.now() - 24 * 3600e3).toISOString();
  const out = new Map();
  let counted = 0;
  for (let page = 0; page < pages; page++) {
    let d;
    try {
      const q = new URLSearchParams({ 'act.account': account, 'act.name': action, after, limit: '1000', skip: String(page * 1000), sort: 'desc' });
      d = await hyperion(`/v2/history/get_actions?${q}`);
    } catch { break; }
    const got = d.actions || [];
    for (const a of got) {
      const x = a.act.data;
      const id = String(x[poolField]);
      // A-DEX wraps its amounts in {quantity, contract}; the others are plain.
      const qin = x.quantity_in?.quantity ?? x.quantity_in;
      if (!qin) continue;
      const asset = parseAsset(qin);
      const pool = state.pools.find(p => p.dex === (account === 'swap.taco' ? 'taco' : account === 'swap.box' ? 'defibox' : 'adex') && p.id === id);
      if (!pool) continue;
      const px = pool.symA === asset.symbol ? pool.priceUsdA : pool.symB === asset.symbol ? pool.priceUsdB : null;
      if (px == null) continue;
      out.set(id, (out.get(id) || 0) + asset.amount * px);
      counted++;
    }
    if (got.length < 1000) break;
  }
  console.log(`  ${account}: ${counted} swaps over ${out.size} pools`);
  return out;
}

console.log('counting volume on the venues that do not publish it...');
const [tacoVol, boxVol, adexVol] = await Promise.all([
  volumeFromLogs('swap.taco', 'exchangelog', 'id').catch(() => new Map()),
  volumeFromLogs('swap.box', 'swaplog', 'pair_id').catch(() => new Map()),
  volumeFromLogs('swap.adex', 'swaplog', 'pool_id', { pages: 2 }).catch(() => new Map()),
]);
const otherVol = { taco: tacoVol, defibox: boxVol, adex: adexVol };

// Alcor publishes safe_usd_price and zeroes it for tokens it will not stand
// behind. That judgement is worth deferring to — honouring it brings Alcor TVL
// here within 1% of what Alcor itself reports — but not on its own: they zero
// 2,024 of their 2,064 tokens, which is a risk policy rather than a statement
// that a token is worthless. HOLE is scored 15 and vetoed, while its own exit is
// $915 against $1,335 pooled, a ratio of 0.68.
//
// So a price is dropped only when BOTH agree: Alcor declines to quote it AND
// this terminal's own exit analysis finds nearly nothing standing behind it.
// The goldenvaults ring fails both at 0.0015; HOLE fails neither.
const VETO_RATIO = 0.05;
const vetoed = new Set();
try {
  const toks = await (await fetch('https://wax.alcor.exchange/api/v2/tokens', { signal: AbortSignal.timeout(30000) })).json();
  let declined = 0;
  for (const t of toks) {
    const id = `${t.symbol}@${t.contract}`;
    if (!(t.safe_usd_price === 0 || t.is_scam)) continue;
    declined++;
    const d = state.depth.get(id);
    if (t.is_scam || !d || d.ratio < VETO_RATIO) vetoed.add(id);
  }
  console.log(`alcor declines ${declined} tokens; ${vetoed.size} of them also fail our own exit test`);
  let dropped = 0;
  for (const id of vetoed) {
    if (state.prices.delete(id)) dropped++;
    const d = state.depth.get(id);
    if (d) { d.nominal = 0; d.realisable = 0; d.ratio = 0; }
  }
  for (const p of state.pools) {
    if (vetoed.has(p.tokenA)) { p.priceUsdA = null; p.usdA = null; }
    if (vetoed.has(p.tokenB)) { p.priceUsdB = null; p.usdB = null; }
    const pa = p.priceUsdA, pb = p.priceUsdB;
    if (pa != null && pb != null) p.tvl = p.reserveA * pa + p.reserveB * pb;
    else if (pa != null || pb != null) {
      const known = pa != null ? p.reserveA * pa : p.reserveB * pb;
      p.tvl = p.dex === 'alcor' ? known : known * 2;
    } else p.tvl = null;
    if (p.tvlReal != null && p.tvl != null) p.tvlReal = Math.min(p.tvlReal, p.tvl);
  }
  console.log(`dropped ${dropped} prices; Alcor TVL now $${Math.round(state.pools.filter(p => p.dex === 'alcor').reduce((s, p) => s + (p.tvl || 0), 0)).toLocaleString()}`);
} catch (e) { console.log('could not read Alcor token list:', e.message); }

// Transfer taxes, for every token that appears in a pool. Reading these needs a
// table call per contract, which is why it happens here rather than in the
// browser — and it belongs on every list, because a 5% tax silently eats a
// multi-hop swap and turns a profitable compound into a loss.
const { tokenTax } = await import('../js/holders.js');
const taxByToken = new Map();
{
  const wanted = new Map();
  for (const p of state.pools) {
    if (!(p.tvl > 0)) continue;
    for (const id of [p.tokenA, p.tokenB]) {
      const [sym, contract] = [id.split('@')[0], id.split('@')[1]];
      if (!wanted.has(id)) wanted.set(id, { sym, contract });
    }
  }
  const entries = [...wanted.entries()];
  console.log(`reading transfer taxes for ${entries.length} tokens...`);
  const BATCH = 8;
  let taxed = 0;
  for (let i = 0; i < entries.length; i += BATCH) {
    await Promise.all(entries.slice(i, i + BATCH).map(async ([id, { sym, contract }]) => {
      try {
        const t = await tokenTax(contract, sym);
        if (t.bps > 0) { taxByToken.set(id, t); taxed++; }
      } catch {}
    }));
    if (i % 400 === 0) console.log(`  ${Math.min(i + BATCH, entries.length)}/${entries.length}`);
  }
  console.log(`taxes: ${taxed} of ${entries.length} tokens charge one`);
}

// --- the fast-start snapshot ------------------------------------------------
// Everything worth showing on first paint: pools with real TVL, plus every pool
// that has a farm even if thin, because the farms page needs them.
const groups = farmGroups();
const farmedIds = new Set(groups.map(g => `${g.dex}:${g.poolId}`));
const pools = state.pools
  .filter(p => p.tvl >= MIN_TVL || farmedIds.has(`${p.dex}:${p.id}`))
  .map(p => ({
    d: p.dex, i: p.id, a: p.symA, b: p.symB, ca: p.tokenA, cb: p.tokenB,
    da: p.decA, db: p.decB, f: p.feeBps,
    ra: round(p.reserveA, 8), rb: round(p.reserveB, 8),
    l: p.liquidity, t: p.tick, s: p.sqrtX64,
    p: round(p.priceAB, 12), v: round(p.tvl, 2), pa: round(p.priceUsdA, 12), pb: round(p.priceUsdB, 12),
    rd: isFinite(p.routeDepth) ? round(p.routeDepth, 0) : null, tn: p.thin ? 1 : 0,
    bd: p.dex === 'alcor' ? (volByPool.get(String(p.id))?.born ?? null) : null,
    v1: p.dex === 'alcor' ? (volByPool.get(String(p.id))?.d1 ?? null) : (otherVol[p.dex]?.get(String(p.id)) ?? null),
    v7: p.dex === 'alcor' ? (volByPool.get(String(p.id))?.d7 ?? null) : null,
    ch: p.dex === 'alcor' ? (volByPool.get(String(p.id))?.ch24 ?? null) : null,
    vr: round(p.tvlReal, 2), er: round(p.exitRatio, 6), d1: round(p.depth1, 2),
  }));

// Carry each token's depth verdict, not just its price. The browser cannot
// recompute it from the snapshot — the calculation needs every pool, including
// the thousands left out — and without it the Tokens view had nothing to filter
// on and rendered empty.
const prices = [...state.prices.entries()]
  .filter(([, v]) => v.usd > 0)
  .map(([id, v]) => {
    const d = state.depth.get(id);
    return [
      id, round(v.usd, 12), v.via, isFinite(v.depth) ? round(v.depth, 2) : null,
      d ? round(d.exit, 2) : 0,
      d ? round(d.ratio, 6) : 0,
      d?.solid ? 1 : 0,
      d ? round(d.nominal, 2) : 0,
      taxByToken.get(id)?.bps ?? 0,
      taxByToken.get(id)?.parts?.filter(x => x.to === 'eosio.null').reduce((a, x) => a + x.bps, 0) ?? 0,
    ];
  });

// Farms ride along: it is the headline page, and a fast start that shows an
// empty farms table is not a fast start.
const farmRows = state.farms.filter(f => !f.ended).map(f => ({
  d: f.dex, i: f.id, pd: f.poolDex, pi: f.poolId,
  rt: f.rewardToken, rs: f.rewardSymbol,
  rp: round(f.rewardPerDay, 8), ru: round(f.rewardUsdDay, 6),
  pf: f.periodFinish, tw: f.totalWeight, ns: f.numStakes,
  su: round(f.stakedUsd, 2), ap: round(f.apr, 3), st: f.aprStatus, cr: f.creator,
  sr: round(f.stakedReal, 2), rr: round(f.rewardRealDay, 6), ar: round(f.aprReal, 3), so: f.rewardSolid ? 1 : 0,
}));

await writeFile(new URL('pools.json', OUT), JSON.stringify({
  at: Date.now(),
  waxUsd: round(state.waxUsd, 10),
  counts: {
    alcor: state.pools.filter(p => p.dex === 'alcor').length,
    taco: state.pools.filter(p => p.dex === 'taco').length,
    farms: state.farms.length,
    solidTokens: state.solidTokens.size,
    pricedTokens: state.depth.size,
  },
  pools, prices, farms: farmRows,
}));
console.log(`wrote pools.json — ${pools.length} pools, ${farmRows.length} live farms, ${prices.length} priced tokens`);

// --- the history line -------------------------------------------------------
// Kept small on purpose: one line per run, top pools by TVL plus every farm we
// can honestly price. Anything bigger turns the repo into a data warehouse.
const topPools = [...state.pools].filter(p => p.tvl > 0)
  .sort((x, y) => (y.tvlReal || 0) - (x.tvlReal || 0)).slice(0, TOP_POOLS_IN_HISTORY)
  .map(p => [`${p.dex}:${p.id}`, round(p.tvl, 0), round(p.priceAB, 8), round(p.tvlReal, 0)]);

// Only farms paying something a person would notice. Recording 900 farms that
// pay a fraction of a cent a day turns the history file into 300 MB a year for
// nothing.
const farms = groups.filter(g => g.rewardUsdDay > 0.01)
  .map(g => [`${g.dex}:${g.poolId}`, round(g.rewardUsdDay, 3), round(g.stakedUsd, 0), round(g.apr, 1), round(g.rewardRealDay, 3), round(g.stakedReal, 0), round(g.aprReal, 1)]);

// One file per month keeps any single file small and lets old months be pruned
// or archived without rewriting history.
const month = new Date().toISOString().slice(0, 7);
await mkdir(new URL('history/', OUT), { recursive: true });
await appendFile(new URL(`history/${month}.ndjson`, OUT), JSON.stringify({
  at: Date.now(),
  wax: round(state.waxUsd, 10),
  tvl: round(state.pools.reduce((s, p) => s + (p.tvl || 0), 0), 2),
  tvlReal: round(state.pools.reduce((s, p) => s + (p.tvlReal || 0), 0), 2),
  solidTokens: state.solidTokens.size,
  nPools: state.pools.length,
  nFarms: groups.length,
  pools: topPools,
  farms,
}) + '\n');
console.log(`appended history/${month}.ndjson — ${topPools.length} pools, ${farms.length} farms`);

// Guard against silently shipping a broken snapshot: if the anchor price or the
// pool count collapses, the run should fail loudly rather than overwrite good
// data with garbage.
if (!(state.waxUsd > 0.0001 && state.waxUsd < 1)) { console.error('WAX price out of plausible band:', state.waxUsd); process.exit(1); }
if (state.pools.length < 5000) { console.error('suspiciously few pools:', state.pools.length); process.exit(1); }
console.log('sanity checks passed');
