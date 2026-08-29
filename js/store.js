// =============================================================================
// STORE — loads both DEXes straight from chain, derives everything, caches it.
//
// There is no server, so this module IS the backend. Cold load pulls ~20k pool
// rows; IndexedDB keeps them so a revisit paints instantly and refreshes behind
// the user. Nothing here is stored anywhere the user cannot clear.
// =============================================================================

import { getRows, getAllRows, getAllRowsSharded, hyperion, warmHosts } from './chain.js';
import { priceFromX64, parseAsset, tokenId, amountsForLiquidity, sqrtPriceFromX64, depositRatio } from './math.js';
import { computePrices, THIN_ROUTE_USD } from './price.js';

const ALCOR = 'swap.alcor', TACO = 'swap.taco';
const CACHE_KEY = 'core-v2';
// Below this staked value an APR is arithmetic noise, not information: $1.32 staked
// against $230/day of rewards computes to 6,372,786% and means nothing.
export const MIN_STAKE_FOR_APR_USD = 25;
const FRESH_MS = 5 * 60 * 1000;

// ------------------------------------------------------------- IndexedDB ----
// 20k pools is far past the 5 MB localStorage ceiling, so the cache lives here.
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('waxterm', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function cacheGet(key) {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const t = db.transaction('kv').objectStore('kv').get(key);
      t.onsuccess = () => res(t.result || null); t.onerror = () => rej(t.error);
    });
  } catch { return null; }
}
async function cacheSet(key, val) {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const t = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
      t.onsuccess = () => res(); t.onerror = () => rej(t.error);
    });
  } catch { /* private mode or quota: run uncached rather than fail */ }
}
export async function clearCache() {
  try { const db = await idb(); db.transaction('kv', 'readwrite').objectStore('kv').clear(); } catch {}
}

// ------------------------------------------------------------------ load ----
export const state = { pools: [], farms: [], prices: new Map(), tokens: new Map(), loadedAt: 0, waxUsd: null, stale: false, hosts: [], shardsFailed: 0, fromSnapshot: false };

function normaliseAlcor(rows, tokens) {
  const out = [];
  for (const p of rows) {
    const a = parseAsset(p.tokenA.quantity), b = parseAsset(p.tokenB.quantity);
    const ta = tokenId(a.symbol, p.tokenA.contract), tb = tokenId(b.symbol, p.tokenB.contract);
    if (!tokens.has(ta)) tokens.set(ta, { id: ta, symbol: a.symbol, contract: p.tokenA.contract, decimals: a.decimals });
    if (!tokens.has(tb)) tokens.set(tb, { id: tb, symbol: b.symbol, contract: p.tokenB.contract, decimals: b.decimals });
    let priceAB = null;
    try { priceAB = priceFromX64(p.currSlot.sqrtPriceX64, a.decimals, b.decimals); } catch {}
    out.push({
      dex: 'alcor', id: String(p.id),
      tokenA: ta, tokenB: tb, symA: a.symbol, symB: b.symbol, decA: a.decimals, decB: b.decimals,
      feeBps: p.fee / 100,                       // Alcor stores millionths: 3000 = 0.30%
      reserveA: a.amount, reserveB: b.amount,
      liquidity: Number(p.liquidity),
      sqrtX64: p.currSlot?.sqrtPriceX64 ?? null,
      tick: p.currSlot?.tick ?? null,
      tickSpacing: p.tickSpacing,
      priceAB: isFinite(priceAB) ? priceAB : null,
      active: !!p.active, tvl: null,
    });
  }
  return out;
}

function normaliseTaco(rows, tokens) {
  const out = [];
  for (const p of rows) {
    const a = parseAsset(p.pool1.quantity), b = parseAsset(p.pool2.quantity), lp = parseAsset(p.supply);
    const ta = tokenId(a.symbol, p.pool1.contract), tb = tokenId(b.symbol, p.pool2.contract);
    if (!tokens.has(ta)) tokens.set(ta, { id: ta, symbol: a.symbol, contract: p.pool1.contract, decimals: a.decimals });
    if (!tokens.has(tb)) tokens.set(tb, { id: tb, symbol: b.symbol, contract: p.pool2.contract, decimals: b.decimals });
    out.push({
      dex: 'taco', id: String(p.id),                // the pair id IS the LP token symbol
      tokenA: ta, tokenB: tb, symA: a.symbol, symB: b.symbol, decA: a.decimals, decB: b.decimals,
      feeBps: 10,                                   // Taco docs: 0.1% to the LP
      reserveA: a.amount, reserveB: b.amount,
      liquidity: lp.amount, lpSupply: lp.amount, lpDecimals: lp.decimals,
      sqrtX64: null, tick: null,
      priceAB: a.amount > 0 ? b.amount / a.amount : null,
      active: a.amount > 0 && b.amount > 0, tvl: null,
    });
  }
  return out;
}

function applyPrices(pools, prices) {
  for (const p of pools) {
    const pa = prices.get(p.tokenA)?.usd ?? null;
    const pb = prices.get(p.tokenB)?.usd ?? null;
    p.usdA = pa; p.usdB = pb;
    // One priced leg still gives a defensible TVL: in a balanced AMM it is half
    // the pool, so double it. Both legs unpriced means we say nothing.
    // A constant-product pair is balanced in value by construction, so doubling
    // one priced leg is exact for Taco. Alcor's concentrated liquidity carries no
    // such guarantee, so a half-priced Alcor pool reports only what we can prove
    // and flags itself rather than inventing the other half.
    // A pool's TVL is only as sound as the shallowest route behind its prices.
    // 595k of a token you can only sell $505 of is not 595k of TVL.
    const da = prices.get(p.tokenA)?.depth ?? 0, db = prices.get(p.tokenB)?.depth ?? 0;
    p.routeDepth = Math.min(pa != null ? da : Infinity, pb != null ? db : Infinity);
    p.thin = isFinite(p.routeDepth) && p.routeDepth < THIN_ROUTE_USD;
    if (pa != null && pb != null) { p.tvl = p.reserveA * pa + p.reserveB * pb; p.tvlPartial = false; }
    else if (pa != null || pb != null) {
      const known = pa != null ? p.reserveA * pa : p.reserveB * pb;
      p.tvl = p.dex === 'taco' ? known * 2 : known;
      p.tvlPartial = p.dex !== 'taco';
    } else { p.tvl = null; p.tvlPartial = false; }
    p.priceUsdA = pa; p.priceUsdB = pb;
  }
}

function buildFarms({ incentives, stakingpos, tacoRewards, pools, prices, tokens }) {
  const farms = [];
  const now = Date.now();
  const byId = new Map(pools.map(p => [`${p.dex}:${p.id}`, p]));

  const stakedCount = new Map();
  for (const sp of stakingpos) for (const iid of sp.incentiveIds) stakedCount.set(String(iid), (stakedCount.get(String(iid)) || 0) + 1);

  for (const inc of incentives) {
    const r = parseAsset(inc.reward.quantity);
    const rt = tokenId(r.symbol, inc.reward.contract);
    if (!tokens.has(rt)) tokens.set(rt, { id: rt, symbol: r.symbol, contract: inc.reward.contract, decimals: r.decimals });
    const finish = Number(inc.periodFinish) * 1000;
    // rewardRateE18 is reward-token RAW units per second, scaled by 1e18.
    const perDay = (Number(inc.rewardRateE18) / 1e18) * 86400 / 10 ** r.decimals;
    const rp = prices.get(rt);
    const pool = byId.get(`alcor:${inc.poolId}`);
    const ended = finish <= now;
    farms.push({
      dex: 'alcor', id: String(inc.id), poolDex: 'alcor', poolId: String(inc.poolId), pool,
      rewardToken: rt, rewardSymbol: r.symbol, rewardPerDay: perDay,
      rewardUsdDay: rp ? perDay * rp.usd : null,
      periodFinish: finish, ended,
      totalWeight: Number(inc.totalStakingWeight),
      numStakes: stakedCount.get(String(inc.id)) ?? Number(inc.numberOfStakes) ?? 0,
      creator: inc.creator,
      stakedUsd: null,                              // exact value needs 2 calls: computed lazily
      apr: null,
      aprStatus: ended ? 'ended' : (!rp ? 'unpriceable' : (Number(inc.totalStakingWeight) > 0 ? 'lazy' : 'no_stake')),
    });
  }

  // Taco needs no position work: staked LP is a plain token amount, and an LP
  // token is worth its share of the pair's reserves.
  for (const fr of tacoRewards) {
    const st = parseAsset(fr.total_amount);
    const pool = byId.get(`taco:${st.symbol}`);
    const [rdec, rsym] = String(fr.symbol).split(',');
    const rt = tokenId(rsym, fr.contract);
    if (!tokens.has(rt)) tokens.set(rt, { id: rt, symbol: rsym, contract: fr.contract, decimals: Number(rdec) });
    const perDay = Number(fr.daily_reward) / 10 ** Number(rdec);
    const rp = prices.get(rt);
    const rewardUsdDay = rp ? perDay * rp.usd : null;
    let stakedUsd = null;
    if (pool?.tvl != null && pool.lpSupply > 0) stakedUsd = pool.tvl * (st.amount / pool.lpSupply);
    const live = Number(fr.remaining) > 0 && perDay > 0;
    farms.push({
      dex: 'taco', id: String(fr.id), poolDex: 'taco', poolId: pool ? pool.id : st.symbol, pool,
      rewardToken: rt, rewardSymbol: rsym, rewardPerDay: perDay, rewardUsdDay,
      periodFinish: null, ended: !live,
      totalWeight: st.amount, numStakes: null, creator: fr.owner,
      stakedUsd,
      apr: (live && rewardUsdDay != null && stakedUsd >= MIN_STAKE_FOR_APR_USD) ? (rewardUsdDay * 365 / stakedUsd) * 100 : null,
      aprStatus: !live ? 'ended'
        : rewardUsdDay == null ? 'unpriceable'
        : !(stakedUsd > 0) ? 'no_stake'
        : stakedUsd < MIN_STAKE_FOR_APR_USD ? 'thin' : 'ok',
    });
  }
  return farms;
}

// A snapshot committed by the hourly GitHub Action. Loading it paints the
// terminal in well under a second; the live chain read then replaces it in the
// background. Entirely optional — if the file is absent the terminal just does
// the full sweep, which is how it worked before any of this existed.
async function loadSnapshot() {
  const res = await fetch('data/pools.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('no snapshot');
  const d = await res.json();
  const tokens = new Map();
  const pools = d.pools.map(p => {
    for (const [id, sym, dec] of [[p.ca, p.a, p.da], [p.cb, p.b, p.db]]) {
      if (!tokens.has(id)) tokens.set(id, { id, symbol: sym, contract: id.split('@')[1], decimals: dec });
    }
    return {
      dex: p.d, id: p.i, tokenA: p.ca, tokenB: p.cb, symA: p.a, symB: p.b,
      decA: p.da, decB: p.db, feeBps: p.f, reserveA: p.ra, reserveB: p.rb,
      liquidity: p.l, tick: p.t, sqrtX64: p.s, priceAB: p.p, tvl: p.v,
      priceUsdA: p.pa, priceUsdB: p.pb, usdA: p.pa, usdB: p.pb,
      tvlPartial: (p.pa == null) !== (p.pb == null), active: true,
      routeDepth: p.rd ?? Infinity, thin: !!p.tn,
      lpSupply: p.d === 'taco' ? p.l : undefined,
    };
  });
  state.pools = pools;
  state.tokens = tokens;
  state.prices = new Map(d.prices.map(([id, usd, via, depth]) => [id, { usd, via, depth }]));
  state.waxUsd = d.waxUsd;
  state.loadedAt = d.at;
  const byId = new Map(pools.map(p => [`${p.dex}:${p.id}`, p]));
  state.farms = (d.farms || []).map(f => ({
    dex: f.d, id: f.i, poolDex: f.pd, poolId: f.pi, pool: byId.get(`${f.pd}:${f.pi}`),
    rewardToken: f.rt, rewardSymbol: f.rs, rewardPerDay: f.rp, rewardUsdDay: f.ru,
    periodFinish: f.pf, ended: false, totalWeight: f.tw, numStakes: f.ns,
    creator: f.cr, stakedUsd: f.su, apr: f.ap, aprStatus: f.st,
  }));
  state.fromSnapshot = true;
  return d;
}

export async function loadCore({ onProgress = () => {}, force = false } = {}) {
  if (!force) {
    const cached = await cacheGet(CACHE_KEY);
    if (cached) {
      hydrate(cached);
      state.stale = Date.now() - cached.loadedAt > FRESH_MS;
      onProgress({ phase: 'cache', done: true, stale: state.stale });
      if (!state.stale) return state;
    } else {
      // No cache yet: show the committed snapshot immediately rather than a
      // spinner for fifteen seconds, then keep loading the real thing.
      try {
        const d = await loadSnapshot();
        onProgress({ phase: 'snapshot', done: false, at: d.at, pools: state.pools.length });
      } catch { /* no snapshot published; fall through to the full sweep */ }
    }
  }

  // Probe the roster first. A dead public node costs 9s per request otherwise,
  // and finding that out during the sweep is what makes a cold load feel broken.
  onProgress({ phase: 'chain', msg: 'Checking WAX nodes' });
  const hosts = await warmHosts();
  state.hosts = hosts;
  const alive = hosts.filter(h => h.ok).length;
  if (!alive) throw new Error('No public WAX node responded');
  onProgress({ phase: 'chain', msg: `${alive}/${hosts.length} nodes responding` });

  const tokens = new Map();

  // Alcor ids are sequential, so shard the sweep and fetch ~12 pages at once.
  const [alcorPools, incentives, stakingpos, tacoPairs, tacoRewards] = await Promise.all([
    getAllRowsSharded(ALCOR, ALCOR, 'pools', 13000, { onPage: (d, t) => onProgress({ phase: 'chain', msg: `Alcor pools ${d}/${t}` }) }),
    getAllRowsSharded(ALCOR, ALCOR, 'incentives', 5000),
    getAllRows(ALCOR, ALCOR, 'stakingpos'),
    getAllRows(TACO, TACO, 'pairs', { onPage: n => onProgress({ phase: 'chain', msg: `TacoSwap pairs ${n}` }) }),
    getAllRows(TACO, TACO, 'pairreward'),
  ]);

  onProgress({ phase: 'derive', msg: 'Pricing tokens' });
  state.shardsFailed = (alcorPools.shardsFailed || 0) + (incentives.shardsFailed || 0);
  const pools = [...normaliseAlcor(alcorPools, tokens), ...normaliseTaco(tacoPairs, tokens)];
  const prices = computePrices(pools);
  applyPrices(pools, prices);
  const farms = buildFarms({ incentives, stakingpos, tacoRewards, pools, prices, tokens });

  state.pools = pools; state.farms = farms; state.prices = prices; state.tokens = tokens;
  state.loadedAt = Date.now(); state.stale = false; state.fromSnapshot = false;
  state.waxUsd = prices.get('WAX@eosio.token')?.usd ?? null;

  await cacheSet(CACHE_KEY, {
    loadedAt: state.loadedAt, pools, farms: farms.map(f => ({ ...f, pool: undefined })),
    prices: [...prices.entries()], tokens: [...tokens.entries()],
  });
  onProgress({ phase: 'done', done: true });
  return state;
}

function hydrate(c) {
  state.pools = c.pools;
  state.prices = new Map(c.prices);
  state.tokens = new Map(c.tokens);
  const byId = new Map(c.pools.map(p => [`${p.dex}:${p.id}`, p]));
  state.farms = c.farms.map(f => ({ ...f, pool: byId.get(`${f.poolDex}:${f.poolId}`) }));
  state.loadedAt = c.loadedAt;
  state.waxUsd = state.prices.get('WAX@eosio.token')?.usd ?? null;
}

// ------------------------------------------------- exact Alcor farm value ----
// stakes(scope=incentive) gives the staked position ids; positions(scope=pool)
// gives their liquidity and range. Two calls, and the answer is exact rather
// than inferred from a staking weight whose formula we would be guessing at.
const stakedCache = new Map();
export async function farmStakedUsd(farm) {
  if (farm.dex === 'taco') return farm.stakedUsd;
  const key = `${farm.id}`;
  if (stakedCache.has(key)) return stakedCache.get(key);
  const pool = farm.pool;
  if (!pool || pool.tvl == null || !pool.sqrtX64) return null;
  const [stakes, positions] = await Promise.all([
    getAllRows(ALCOR, farm.id, 'stakes'),
    getAllRows(ALCOR, farm.poolId, 'positions'),
  ]);
  const posById = new Map(positions.map(p => [String(p.id), p]));
  const s = sqrtPriceFromX64(pool.sqrtX64);
  let usd = 0;
  for (const st of stakes) {
    const p = posById.get(String(st.posId));
    if (!p) continue;
    usd += positionUsd(p, pool, s);
  }
  stakedCache.set(key, usd);
  return usd;
}

export function positionUsd(pos, pool, sqrtP) {
  const { amountA, amountB } = amountsForLiquidity(pos.liquidity, sqrtP, pos.tickLower, pos.tickUpper);
  const a = amountA / 10 ** pool.decA, b = amountB / 10 ** pool.decB;
  const ua = pool.priceUsdA != null ? a * pool.priceUsdA : 0;
  const ub = pool.priceUsdB != null ? b * pool.priceUsdB : 0;
  return ua + ub;
}

// --------------------------------------------------------- wallet lookup ----
// The chain scopes Alcor positions by poolId with the owner INSIDE the row, so
// there is no "what does this wallet own" query. Sweeping 11,551 scopes is not
// an option in a browser. Instead: Hyperion knows which pools this account has
// acted on (addliquid/collect/subliquid are signed BY the user, unlike the
// inline logmint), and we then read only those pools' position tables.
export async function walletPositions(account, { onProgress = () => {} } = {}) {
  const poolIds = new Set();
  onProgress({ msg: 'Finding pools you have touched' });
  for (const name of ['addliquid', 'collect', 'subliquid']) {
    try {
      const d = await hyperion(`/v2/history/get_actions?account=${encodeURIComponent(account)}&act.account=${ALCOR}&act.name=${name}&limit=500&sort=desc`);
      for (const a of (d.actions || [])) { const pid = a.act?.data?.poolId; if (pid !== undefined) poolIds.add(String(pid)); }
    } catch { /* one action type missing must not empty the whole result */ }
  }

  const byId = new Map(state.pools.map(p => [`${p.dex}:${p.id}`, p]));
  const out = [];
  const ids = [...poolIds];
  let done = 0;
  await Promise.all(ids.map(async pid => {
    const pool = byId.get(`alcor:${pid}`);
    if (!pool || !pool.sqrtX64) { done++; return; }
    try {
      const rows = await getAllRows(ALCOR, pid, 'positions');
      const s = sqrtPriceFromX64(pool.sqrtX64);
      for (const p of rows) {
        if (p.owner !== account) continue;
        const { amountA, amountB } = amountsForLiquidity(p.liquidity, s, p.tickLower, p.tickUpper);
        const ratio = depositRatio(s, p.tickLower, p.tickUpper);
        out.push({
          dex: 'alcor', pool, posId: p.id, owner: p.owner,
          tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: Number(p.liquidity),
          amountA: amountA / 10 ** pool.decA, amountB: amountB / 10 ** pool.decB,
          feesA: Number(p.feesA) / 10 ** pool.decA, feesB: Number(p.feesB) / 10 ** pool.decB,
          valueUsd: positionUsd(p, pool, s),
          feesUsd: (Number(p.feesA) / 10 ** pool.decA) * (pool.priceUsdA || 0) + (Number(p.feesB) / 10 ** pool.decB) * (pool.priceUsdB || 0),
          inRange: ratio.inRange, side: ratio.side, ratio,
        });
      }
    } catch {}
    done++; onProgress({ msg: `Reading positions ${done}/${ids.length}` });
  }));

  // Taco LP is a plain token balance issued by swap.taco: one call, no sweep.
  let tacoLp = [];
  try {
    const rows = await getAllRows(TACO, account, 'accounts');
    for (const r of rows) {
      const bal = parseAsset(r.balance);
      const pool = byId.get(`taco:${bal.symbol}`);
      if (!pool || !(bal.amount > 0) || !(pool.lpSupply > 0)) continue;
      const share = bal.amount / pool.lpSupply;
      tacoLp.push({
        dex: 'taco', pool, balance: bal.amount, share,
        amountA: pool.reserveA * share, amountB: pool.reserveB * share,
        valueUsd: pool.tvl != null ? pool.tvl * share : null,
        inRange: true, side: 'in',
      });
    }
  } catch {}

  out.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
  tacoLp.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
  return { alcor: out, taco: tacoLp, poolsChecked: ids.length };
}

// ------------------------------------------------------------- activity -----
// logswap carries the trader, signed token deltas AND post-swap reserves, so a
// single feed answers volume, price and who-traded-what without any indexing.
export async function recentSwaps({ poolId = null, minutes = 15, maxPages = 6, onProgress = null } = {}) {
  // 250 swaps covers about 50 seconds on WAX — arb bots trade that fast, so a
  // fixed action count is a useless window. Page over real time instead.
  const after = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const page = n => {
    const q = new URLSearchParams({
      'act.account': ALCOR, 'act.name': 'logswap',
      after, limit: '1000', skip: String(n * 1000), sort: 'desc',
    });
    return hyperion(`/v2/history/get_actions?${q}`);
  };

  // Page 0 also tells us the total, so the remaining pages can go out at once
  // instead of one after another. Sequential paging took 46s for 15 minutes of
  // WAX; parallel takes about a fifth of that.
  const first = await page(0);
  const actions = [...(first.actions || [])];
  const total = Math.min(first.total?.value ?? actions.length, maxPages * 1000);
  onProgress?.(actions.length, total);

  const pages = Math.ceil(total / 1000) - 1;
  if (pages > 0) {
    const rest = await Promise.all(
      Array.from({ length: Math.min(pages, maxPages - 1) }, (_, i) =>
        page(i + 1).then(d => d.actions || []).catch(() => []))   // a lost page beats a lost view
    );
    for (const got of rest) { actions.push(...got); onProgress?.(actions.length, total); }
  }
  const truncated = (first.total?.value ?? 0) > actions.length;
  const byId = new Map(state.pools.map(p => [`${p.dex}:${p.id}`, p]));
  const out = [];
  for (const a of actions) {
    const x = a.act.data;
    if (poolId != null && String(x.poolId) !== String(poolId)) continue;
    const pool = byId.get(`alcor:${x.poolId}`);
    const ta = parseAsset(x.tokenA), tb = parseAsset(x.tokenB);
    // One leg is negative (leaving the pool). Value the swap on whichever side
    // we can actually price.
    const usdA = pool?.priceUsdA != null ? Math.abs(ta.amount) * pool.priceUsdA : null;
    const usdB = pool?.priceUsdB != null ? Math.abs(tb.amount) * pool.priceUsdB : null;
    out.push({
      ts: a.timestamp, trx: a.trx_id, pool, poolId: String(x.poolId),
      trader: x.sender, symA: ta.symbol, symB: tb.symbol,
      amountA: ta.amount, amountB: tb.amount,
      volumeUsd: usdA ?? usdB ?? null,
      dir: ta.amount > 0 ? 'buyB' : 'buyA',
    });
  }
  out.windowMinutes = minutes;
  out.truncated = truncated;
  out.reportedTotal = first.total?.value ?? out.length;
  return out;
}

// Hyperion get_deltas replays a table row over time — this is the entire history
// layer, for free, with no indexer. Retention is the node's, not ours.
export async function poolHistory(poolId, { limit = 300 } = {}) {
  const q = new URLSearchParams({ code: ALCOR, scope: ALCOR, table: 'pools', limit: String(limit), sort: 'desc' });
  const d = await hyperion(`/v2/history/get_deltas?${q}`);
  const rows = (d.deltas || []).filter(x => String(x.primary_key) === String(poolId));
  return rows.map(x => {
    const a = parseAsset(x.data.tokenA.quantity), b = parseAsset(x.data.tokenB.quantity);
    let price = null;
    try { price = priceFromX64(x.data.currSlot.sqrtPriceX64, a.decimals, b.decimals); } catch {}
    return { ts: x.timestamp, block: x.block_num, reserveA: a.amount, reserveB: b.amount, price, liquidity: Number(x.data.liquidity) };
  }).reverse();
}

// ------------------------------------------------------- farm grouping ------
// A pool is what a user farms, not an incentive. Measured on chain: 633 of 1,883
// farmed pools run several incentives at once, sometimes ten, and users think of
// that as one farm paying several tokens. Group accordingly.
export function farmGroups({ liveOnly = true } = {}) {
  const groups = new Map();
  for (const f of state.farms) {
    if (liveOnly && f.ended) continue;
    const key = `${f.poolDex}:${f.poolId}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key, dex: f.poolDex, poolId: f.poolId, pool: f.pool,
        farms: [], rewards: [], rewardUsdDay: 0, stakedUsd: null, apr: null,
        aprStatus: 'lazy', endsAt: null, anyUnpriceable: false,
      };
      groups.set(key, g);
    }
    g.farms.push(f);
    g.rewards.push({ symbol: f.rewardSymbol, token: f.rewardToken, perDay: f.rewardPerDay, usdDay: f.rewardUsdDay, id: f.id });
    if (f.rewardUsdDay != null) g.rewardUsdDay += f.rewardUsdDay; else g.anyUnpriceable = true;
    if (f.periodFinish && (!g.endsAt || f.periodFinish < g.endsAt)) g.endsAt = f.periodFinish;
  }

  for (const g of groups.values()) {
    // Taco stakes a plain LP token, so the staked value is already known and the
    // several farms on one pair share that same staked pool.
    if (g.dex === 'taco') {
      const known = g.farms.map(f => f.stakedUsd).filter(v => v != null && v > 0);
      g.stakedUsd = known.length ? Math.max(...known) : null;
      g.apr = (g.stakedUsd >= MIN_STAKE_FOR_APR_USD && g.rewardUsdDay > 0) ? (g.rewardUsdDay * 365 / g.stakedUsd) * 100 : null;
      g.aprStatus = g.apr != null ? 'ok'
        : !(g.stakedUsd > 0) ? 'no_stake'
        : g.stakedUsd < MIN_STAKE_FOR_APR_USD ? 'thin'
        : g.rewardUsdDay > 0 ? 'ok' : 'unpriceable';
    } else if (!g.rewardUsdDay && g.anyUnpriceable) {
      g.aprStatus = 'unpriceable';
    } else if (!g.farms.some(f => f.numStakes > 0)) {
      g.aprStatus = 'no_stake';
    }
    g.tokenCount = new Set(g.rewards.map(r => r.token)).size;
  }
  return [...groups.values()];
}

// Exact staked value for a whole pool's farm set. Different incentives on one
// pool have different staked sets, so the denominator is their UNION — counting
// a position once even when it is staked in five of them.
const groupCache = new Map();
export async function groupStakedUsd(group) {
  if (group.dex === 'taco') return group.stakedUsd;
  if (groupCache.has(group.key)) return groupCache.get(group.key);
  const pool = group.pool;
  if (!pool || !pool.sqrtX64) return null;

  const stakeSets = await Promise.all(group.farms.map(f => getAllRows(ALCOR, f.id, 'stakes').catch(() => [])));
  const posIds = new Set();
  for (const rows of stakeSets) for (const r of rows) posIds.add(String(r.posId));
  if (!posIds.size) { groupCache.set(group.key, 0); return 0; }

  const positions = await getAllRows(ALCOR, group.poolId, 'positions');
  const s = sqrtPriceFromX64(pool.sqrtX64);
  let usd = 0;
  for (const p of positions) if (posIds.has(String(p.id))) usd += positionUsd(p, pool, s);
  groupCache.set(group.key, usd);
  return usd;
}
