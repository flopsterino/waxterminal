// =============================================================================
// LEADERS — who is actually doing this, measured rather than self-reported.
//
// Every WAX front end can tell you what a pool holds. None of them can tell you
// who is providing that liquidity, what it has earned them, or who is trading
// against it — because answering that means reading every position in every
// pool and computing Uniswap-V3 fee growth for each one, which is not something
// a page can do while someone waits.
//
// A nightly job can. It costs about a minute of reads: two table calls per pool
// with liquidity (614 of them today), plus a walk back through a day of
// logswap. The result is a small file the site serves like any other.
//
// Three boards, and they measure different things on purpose:
//
//   Liquidity providers   position value, and fees EARNED — the number nobody
//                         else publishes, because it is not in any table. It is
//                         reconstructed from the pool's fee-growth counters.
//   Traders               USD moved through Alcor in 24h, from logswap, by the
//                         account that signed the swap.
//   Farmers               position value staked into live incentives.
//
// Deliberately NOT ranked: profit. A trader's P&L is not knowable from swap
// logs — an arbitrage cycle nets out across legs, and a swap in isolation looks
// like a loss to whoever took the other side. Publishing a made-up profit
// column would be the "synthetic volume" thing this terminal exists to avoid.
// =============================================================================

import { writeFile, readFile } from 'node:fs/promises';
import { loadCore, state } from '../js/store.js';
import { getAllRows, getAllRowsSharded, hyperion } from '../js/chain.js';
import { amountsForLiquidity, sqrtPriceFromX64, feesOwed, parseAsset } from '../js/math.js';

const OUT = new URL('../data/', import.meta.url);
const ALCOR = 'swap.alcor';
const TOP = 40;                       // rows published per board

// Accounts the operator has asked to keep off the boards. Their trades still
// count towards every total on the site; they are simply not named. Someone
// running a bot has a real interest in not advertising it, and a leaderboard
// that doubles as a target list is a worse product than one that does not.
let HIDDEN = new Set();
try {
  const theme = JSON.parse(await readFile(new URL('../theme.json', import.meta.url), 'utf8'));
  HIDDEN = new Set(theme?.commercial?.leaderboardHidden || []);
} catch {}

// Positions sent to the burn account. They still earn fees — the pool cannot
// tell the difference — and nobody can ever collect them, so they topped the
// fees board while belonging to no one. Reported as a fact of its own instead
// of ranked as though an account were doing well.
const BURN = new Set(['eosio.null', 'nulls.alcor']);

// A few at a time. These are public nodes shared with everything else on this
// machine, and a nightly job has no reason to be in a hurry.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

console.log('loading pools and prices…');
await loadCore({ force: true, onProgress: p => p.msg && console.log('  ' + p.msg) });
console.log(`  ${state.pools.length} pools, ${state.prices.size} prices`);

// ------------------------------------------------------- liquidity + farms --
// Which positions are staked, in one read rather than one per position.
const stakedIn = new Map();
try {
  for (const r of await getAllRows(ALCOR, ALCOR, 'stakingpos')) {
    stakedIn.set(String(r.posId), (r.incentiveIds || []).map(String));
  }
} catch (e) { console.error('stakingpos:', e.message); }
console.log(`  ${stakedIn.size} staked positions`);

// Incentives that have not ended, so "farming" means earning rather than
// merely still being attached to something that finished in March.
const liveIncentives = new Set(state.farms.filter(f => f.poolDex === 'alcor' && f.periodFinish > Date.now()).map(f => String(f.id)));

// A floor, because `tvl > 0` on a live read is 9,777 pools — two table calls
// each, twenty thousand requests at public nodes shared with everything else
// running on this machine. Measured on the pooled value: a $10 floor keeps
// 100.0% of it and drops two thirds of the pools. Anything a farm runs on is
// kept regardless of size, or the farming board would have holes in it.
const MIN_TVL = 10;
const farmedPools = new Set(state.farms.filter(f => f.poolDex === 'alcor').map(f => String(f.poolId)));
const pools = state.pools.filter(p => p.dex === 'alcor' && p.sqrtX64
  && (p.tvl >= MIN_TVL || farmedPools.has(String(p.id))));

// The fee-growth counters live on the raw pool row, which the normalised pool
// does not carry. Fetching that row per pool is 614 extra keyed reads for a
// table that answers in twelve sharded ones — and it was most of why the first
// run took six minutes.
const rawPools = new Map();
try {
  const maxId = Math.max(...pools.map(p => Number(p.id))) + 1000;
  for (const r of await getAllRowsSharded(ALCOR, ALCOR, 'pools', maxId, { shard: 1000 })) {
    rawPools.set(String(r.id), r);
  }
} catch (e) { console.error('raw pools:', e.message); }
console.log(`reading positions in ${pools.length} pools (${rawPools.size} fee-growth rows)…`);

const lp = new Map();       // account -> totals
const poolOwners = new Map();  // poolId -> the distinct wallets providing there
const touch = a => {
  let r = lp.get(a);
  if (!r) { r = { account: a, valueUsd: 0, nominalUsd: 0, feesUsd: 0, positions: 0, staked: 0, stakedUsd: 0, pools: new Set() }; lp.set(a, r); }
  return r;
};

let scanned = 0, positionsSeen = 0;
await mapLimit(pools, 4, async p => {
  let positions = [], ticks = new Map();
  const raw = rawPools.get(String(p.id)) || null;
  try {
    const [pr, tr] = await Promise.all([
      getAllRows(ALCOR, p.id, 'positions'),
      getAllRows(ALCOR, p.id, 'ticks'),
    ]);
    positions = pr;
    for (const t of tr) ticks.set(Number(t.id), t);
  } catch { return; }

  const s = sqrtPriceFromX64(p.sqrtX64);
  for (const pos of positions) {
    if (!(Number(pos.liquidity) > 0)) continue;
    positionsSeen++;
    const { amountA, amountB } = amountsForLiquidity(pos.liquidity, s, pos.tickLower, pos.tickUpper);
    const nominalUsd = (amountA / 10 ** p.decA) * (p.priceUsdA || 0) + (amountB / 10 ** p.decB) * (p.priceUsdB || 0);
    // Discounted by what the pool could actually pay out. Nominal value ranks
    // whoever printed the biggest number rather than whoever provided the
    // deepest market: parareserves topped the board on $793,358 of positions in
    // pools holding $593,202 nominal against $982 realisable — 0.17%. Every
    // other figure on this site is already discounted this way.
    const realRatio = p.tvl > 0 ? Math.min(1, (p.tvlReal || 0) / p.tvl) : 0;
    const valueUsd = nominalUsd * realRatio;

    // The number that makes this board worth having. `feesA`/`feesB` on the row
    // are only what a previous collect already credited; what is actually owed
    // lives in the fee-growth counters and has to be reconstructed.
    let feesUsd = 0;
    if (raw) {
      try {
        const owed = feesOwed(pos, raw, ticks.get(pos.tickLower), ticks.get(pos.tickUpper));
        feesUsd = ((owed.feesA / 10 ** p.decA) * (p.priceUsdA || 0) + (owed.feesB / 10 ** p.decB) * (p.priceUsdB || 0)) * realRatio;
      } catch {}
    }

    (poolOwners.get(String(p.id)) ?? poolOwners.set(String(p.id), new Set()).get(String(p.id))).add(pos.owner);

    const r = touch(pos.owner);
    r.valueUsd += valueUsd;
    r.nominalUsd += nominalUsd;
    r.feesUsd += feesUsd;
    r.positions++;
    r.pools.add(p.id);
    const inc = stakedIn.get(String(pos.id)) || [];
    if (inc.some(id => liveIncentives.has(id))) { r.staked++; r.stakedUsd += valueUsd; }
  }
  if (++scanned % 100 === 0) console.log(`  ${scanned}/${pools.length} pools`);
});
console.log(`  ${positionsSeen} positions across ${lp.size} accounts`);

// ------------------------------------------------------------------ trades --
// A day of swaps, walked backwards. `before` is the only paging that survives
// Hyperion's 10,000-row ceiling — skip past it and the answers stop coming.
console.log('walking a day of swaps…');
const since = Date.now() - 24 * 3600e3;
const traders = new Map();
const poolById = new Map(state.pools.filter(p => p.dex === 'alcor').map(p => [String(p.id), p]));
let before = new Date().toISOString(), pages = 0, swaps = 0, volume = 0, unpriced = 0, unknownPool = 0, oldestSeen = null;

while (pages < 120) {
  let d;
  try {
    d = await hyperion(`/v2/history/get_actions?act.account=${ALCOR}&act.name=logswap&limit=1000&sort=desc&before=${encodeURIComponent(before)}`);
  } catch (e) { console.error('  hyperion:', e.message); break; }
  const acts = d.actions || [];
  if (!acts.length) break;
  pages++;

  let reachedEnd = false;
  for (const a of acts) {
    const ts = new Date(a.timestamp.endsWith('Z') ? a.timestamp : a.timestamp + 'Z').getTime();
    if (ts < since) { reachedEnd = true; break; }
    const dat = a.act?.data;
    if (!dat) continue;
    const pool = poolById.get(String(dat.poolId));
    // A pool this terminal does not carry, or one whose sides it will not price,
    // cannot be valued — and counting the swap at zero would quietly deflate
    // every trader's total. Counted separately and said out loud instead.
    if (!pool) { unknownPool++; continue; }
    // Value the leg we can price, preferring the side with a price we trust.
    const A = parseAsset(dat.tokenA || '0 X'), B = parseAsset(dat.tokenB || '0 X');
    const usd = pool.priceUsdA ? Math.abs(A.amount) * pool.priceUsdA
      : pool.priceUsdB ? Math.abs(B.amount) * pool.priceUsdB : 0;
    if (!(usd > 0)) { unpriced++; continue; }
    const who = dat.sender;
    let t = traders.get(who);
    if (!t) { t = { account: who, usd: 0, swaps: 0, pools: new Set() }; traders.set(who, t); }
    t.usd += usd; t.swaps++; t.pools.add(String(pool.id));
    swaps++; volume += usd;
  }
  oldestSeen = new Date((acts[acts.length - 1].timestamp).replace(/Z?$/, 'Z')).getTime();
  const last = acts[acts.length - 1].timestamp;
  before = last.endsWith('Z') ? last : last + 'Z';
  if (reachedEnd) break;
  if (pages % 20 === 0) console.log(`  ${pages} pages, ${swaps} swaps`);
}
const valued = swaps / (swaps + unpriced + unknownPool || 1);
console.log(`  ${swaps} swaps valued, $${Math.round(volume).toLocaleString()} in 24h, ${traders.size} accounts`
  + ` (${unpriced} unpriceable, ${unknownPool} in pools not carried — ${(valued * 100).toFixed(1)}% of swaps valued)`);

// ------------------------------------------------------------------ output --
const round = (v, d = 2) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const publish = (rows, key, map) => rows
  .filter(r => !HIDDEN.has(r.account) && !BURN.has(r.account))
  .sort((a, b) => b[key] - a[key])
  .slice(0, TOP)
  .map(map);

const providers = publish([...lp.values()].filter(r => r.valueUsd > 1), 'valueUsd',
  r => ({ a: r.account, v: round(r.valueUsd), f: round(r.feesUsd, 4), n: r.positions, p: r.pools.size, s: r.staked }));

const earners = publish([...lp.values()].filter(r => r.feesUsd > 0.01), 'feesUsd',
  r => ({ a: r.account, f: round(r.feesUsd, 4), v: round(r.valueUsd), n: r.positions, p: r.pools.size }));

const farmers = publish([...lp.values()].filter(r => r.stakedUsd > 1), 'stakedUsd',
  r => ({ a: r.account, v: round(r.stakedUsd), n: r.staked, p: r.pools.size }));

const movers = publish([...traders.values()], 'usd',
  r => ({ a: r.account, v: round(r.usd), n: r.swaps, p: r.pools.size }));

const burned = [...lp.values()].filter(r => BURN.has(r.account))
  .reduce((a, r) => ({ valueUsd: a.valueUsd + r.valueUsd, feesUsd: a.feesUsd + r.feesUsd, positions: a.positions + r.positions }),
    { valueUsd: 0, feesUsd: 0, positions: 0 });

await writeFile(new URL('leaders.json', OUT), JSON.stringify({
  at: Date.now(),
  burned: { v: round(burned.valueUsd), f: round(burned.feesUsd, 2), n: burned.positions },
  scope: {
    pools: pools.length,
    positions: positionsSeen,
    accounts: lp.size,
    traders: traders.size,
    swaps, volumeUsd: round(volume),
    swapsUnvalued: unpriced + unknownPool,
    windowHours: round((Date.now() - Math.max(since, oldestSeen || since)) / 3600e3, 1),
    hidden: HIDDEN.size,
  },
  providers, earners, farmers, movers,
  // Wallets per pool, so a list can say how many people are in a market
  // without reading eighteen thousand positions to find out.
  lps: Object.fromEntries([...poolOwners].filter(([, set]) => set.size > 0).map(([id, set]) => [id, set.size])),
}));

console.log(`leaders: ${providers.length} providers, ${earners.length} earners, ${farmers.length} farmers, ${movers.length} traders`
  + (HIDDEN.size ? ` (${HIDDEN.size} account${HIDDEN.size === 1 ? '' : 's'} withheld)` : ''));
