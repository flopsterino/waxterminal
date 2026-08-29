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
const groupByPool = new Map(alcorGroups.map(g => [`${g.poolDex}:${g.poolId}`, g]));
for (const f of state.farms) {
  const g = groupByPool.get(`${f.poolDex}:${f.poolId}`);
  if (!g || g.stakedUsd == null) continue;
  f.stakedUsd = g.stakedUsd; f.stakedReal = g.stakedReal;
  const share = g.rewardUsdDay > 0 ? (f.rewardUsdDay || 0) / g.rewardUsdDay : 0;
  f.apr = (g.stakedUsd >= 25 && f.rewardUsdDay > 0) ? (f.rewardUsdDay * 365 / g.stakedUsd) * 100 : f.apr;
  f.aprReal = (g.stakedReal >= 25 && f.rewardRealDay > 0) ? (f.rewardRealDay * 365 / g.stakedReal) * 100 : f.aprReal;
  f.aprStatus = f.apr != null ? 'ok' : f.aprStatus;
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
    vr: round(p.tvlReal, 2), er: round(p.exitRatio, 6),
  }));

const prices = [...state.prices.entries()]
  .filter(([, v]) => v.usd > 0)
  .map(([id, v]) => [id, round(v.usd, 12), v.via, round(v.depth, 2)]);

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
