// =============================================================================
// STORE — loads both DEXes straight from chain, derives everything, caches it.
//
// There is no server, so this module IS the backend. Cold load pulls ~20k pool
// rows; IndexedDB keeps them so a revisit paints instantly and refreshes behind
// the user. Nothing here is stored anywhere the user cannot clear.
// =============================================================================

import { getRows, getAllRows, getAllRowsSharded, hyperion, warmHosts } from './chain.js';
import { priceFromX64, parseAsset, tokenId, amountsForLiquidity, sqrtPriceFromX64, depositRatio, feesOwed } from './math.js';
import { computePrices, THIN_ROUTE_USD, STABLES } from './price.js';
import { computeDepth, poolRealisable, counterparties } from './depth.js';
import { tradeDepth } from './depthmath.js';

const ALCOR = 'swap.alcor', TACO = 'swap.taco', BOX = 'swap.box', ADEX = 'swap.adex';
const CACHE_KEY = 'core-v2';
// Below this staked value an APR is arithmetic noise, not information: $1.32 staked
// against $230/day of rewards computes to 6,372,786% and means nothing.
export const MIN_STAKE_FOR_APR_USD = 25;
const FRESH_MS = 5 * 60 * 1000;

// ------------------------------------------------------------- IndexedDB ----
// 20k pools is far past the 5 MB localStorage ceiling, so the cache lives here.
// Everything here is wrapped in a timeout because IndexedDB can simply never
// answer: an open blocked by another tab fires neither onsuccess nor onerror,
// and private windows, cleared site data and storage-blocking settings each fail
// differently. A cache that hangs is worse than no cache — it took the whole
// page down with it, silently, behind a spinner, on every path except the one
// that skipped the cache entirely.
const IDB_TIMEOUT = 1500;
const withTimeout = (p, ms = IDB_TIMEOUT) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error('storage timeout')), ms)),
]);

function idb() {
  return new Promise((res, rej) => {
    let r;
    try { r = indexedDB.open('waxterm', 1); } catch (e) { return rej(e); }
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('indexeddb error'));
    r.onblocked = () => rej(new Error('indexeddb blocked'));
  });
}
async function cacheGet(key) {
  try {
    const db = await withTimeout(idb());
    return await withTimeout(new Promise((res, rej) => {
      const t = db.transaction('kv').objectStore('kv').get(key);
      t.onsuccess = () => res(t.result || null); t.onerror = () => rej(t.error);
    }));
  } catch { return null; }
}
async function cacheSet(key, val) {
  try {
    const db = await withTimeout(idb());
    await withTimeout(new Promise((res, rej) => {
      const t = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
      t.onsuccess = () => res(); t.onerror = () => rej(t.error);
    }), 4000);
  } catch { /* private mode, quota, blocked: run uncached rather than fail */ }
}
export async function clearCache() {
  try { const db = await withTimeout(idb()); db.transaction('kv', 'readwrite').objectStore('kv').clear(); } catch {}
}

// ------------------------------------------------------------------ load ----
export const state = { pools: [], farms: [], prices: new Map(), prevPrices: new Map(), prevAt: null, tokens: new Map(), loadedAt: 0, waxUsd: null, stale: false, hosts: [], shardsFailed: 0, fromSnapshot: false, depth: new Map(), solidTokens: new Set(), snapshotFarms: new Map(), snapshotPools: new Map(), counts: null, facing: new Map(), volumeAt: null };

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
      feeBps: 30,                                   // 0.30% charged on a trade
      lpFeeBps: 10,                                 // of which 0.1% reaches the LP, per Taco's docs
      reserveA: a.amount, reserveB: b.amount,
      liquidity: lp.amount, lpSupply: lp.amount, lpDecimals: lp.decimals,
      sqrtX64: null, tick: null,
      priceAB: a.amount > 0 ? b.amount / a.amount : null,
      active: a.amount > 0 && b.amount > 0, tvl: null,
    });
  }
  return out;
}

// Defibox on WAX: constant product, token0/token1 with a "decimals,SYMBOL"
// string and asset-string reserves. 1,443 pairs, so worth having; the shape is
// close enough to Taco that it normalises into the same row.
function normaliseBox(rows, tokens) {
  const out = [];
  for (const p of rows) {
    const a = parseAsset(p.reserve0), b = parseAsset(p.reserve1);
    const [decA] = String(p.token0.symbol).split(',');
    const [decB] = String(p.token1.symbol).split(',');
    const ta = tokenId(a.symbol, p.token0.contract), tb = tokenId(b.symbol, p.token1.contract);
    if (!tokens.has(ta)) tokens.set(ta, { id: ta, symbol: a.symbol, contract: p.token0.contract, decimals: Number(decA) });
    if (!tokens.has(tb)) tokens.set(tb, { id: tb, symbol: b.symbol, contract: p.token1.contract, decimals: Number(decB) });
    out.push({
      dex: 'defibox', id: String(p.id),
      tokenA: ta, tokenB: tb, symA: a.symbol, symB: b.symbol,
      decA: Number(decA), decB: Number(decB),
      feeBps: 30,                                  // Defibox charges 0.30%
      reserveA: a.amount, reserveB: b.amount,
      liquidity: Number(p.liquidity_token) || 0, lpSupply: Number(p.liquidity_token) || 0,
      sqrtX64: null, tick: null,
      priceAB: a.amount > 0 ? b.amount / a.amount : null,
      active: a.amount > 0 && b.amount > 0, tvl: null,
    });
  }
  return out;
}

// A-DEX: nine pools, tiny, but the same constant-product shape and free to
// include once the normaliser exists.
function normaliseAdex(rows, tokens) {
  const out = [];
  for (const p of rows) {
    const a = parseAsset(p.base_token.quantity), b = parseAsset(p.quote_token.quantity);
    const ta = tokenId(a.symbol, p.base_token.contract), tb = tokenId(b.symbol, p.quote_token.contract);
    if (!tokens.has(ta)) tokens.set(ta, { id: ta, symbol: a.symbol, contract: p.base_token.contract, decimals: a.decimals });
    if (!tokens.has(tb)) tokens.set(tb, { id: tb, symbol: b.symbol, contract: p.quote_token.contract, decimals: b.decimals });
    const fee = parseFloat(String(p.pool_fee)) || 0.2;
    out.push({
      dex: 'adex', id: String(p.id),
      tokenA: ta, tokenB: tb, symA: a.symbol, symB: b.symbol,
      decA: a.decimals, decB: b.decimals,
      feeBps: Math.round(fee * 100),
      reserveA: a.amount, reserveB: b.amount,
      liquidity: 0, sqrtX64: null, tick: null,
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
      p.tvl = p.dex === 'alcor' ? known : known * 2;   // constant product is balanced in value; concentrated liquidity is not
      p.tvlPartial = p.dex === 'alcor';
    } else { p.tvl = null; p.tvlPartial = false; }
    p.priceUsdA = pa; p.priceUsdB = pb;
  }
}

// What a pool holds versus what it could pay out. Everything the terminal calls
// "real" downstream comes from here.
function applyDepth(pools, prices) {
  const { tokens, solid } = computeDepth(pools, prices, STABLES);
  state.depth = tokens; state.solidTokens = solid;
  state.facing = counterparties(pools);
  // Concentration is the checkable version of the depth model's verdict, and it
  // travels with the token so the UI can show the evidence rather than a score.
  for (const [id, d] of tokens) {
    const f = state.facing.get(id);
    d.topPartner = f?.top ?? null;
    d.sameIssuerShare = f?.sameIssuerShare ?? 0;
    d.partners = f?.partners ?? [];
    // Not a verdict — a fact. "92% of what backs HOLE is CHEESE" is true and
    // worth knowing whether the project is sound or not, and calling it
    // "circular" turned a concentration measure into an accusation aimed at
    // perfectly honest small tokens.
    d.concentrated = (f?.top?.share ?? 0) > 0.5;
    d.selfBacked = d.sameIssuerShare > 0.4;
  }
  // Standing opposite a circle is the same problem one step removed. PARAUSD
  // issues nothing itself and faces no single partner heavily, yet every one of
  // its counterparties is a goldenvaults token propping up the others — which is
  // why $998,192 of it sits in pools against a $1,411 exit.
  for (let pass = 0; pass < 3; pass++) {
    let changed = 0;
    for (const [id, d] of tokens) {
      if (d.selfBacked || d.anchored) continue;
      const f = state.facing.get(id);
      if (!f) continue;
      let sus = 0;
      for (const [other, v] of Object.entries(Object.fromEntries(f.partners.map(x => [x.token, x.usd])))) {
        if (tokens.get(other)?.selfBacked) sus += v;
      }
      if (sus / f.total > 0.5) { d.selfBacked = true; d.viaPartners = true; changed++; }
    }
    if (!changed) break;
  }
  for (const p of pools) {
    p.tvlReal = poolRealisable(p, tokens);
    const da = tokens.get(p.tokenA), db = tokens.get(p.tokenB);
    p.exitRatio = Math.min(da ? da.ratio : 0, db ? db.ratio : 0);
    p.solidPair = !!(da?.solid && db?.solid);
    // Turnover says whether a pool is working or just parked: $1k of volume on
    // $1k of liquidity is a different animal from $1k on $200k.
    p.turnover = (p.vol24 > 0 && p.tvlReal > 0) ? p.vol24 / p.tvlReal : null;
    // Trade depth is price impact in THIS pool, so it must not be scaled by the
    // graph-wide dumpability ratio — that put pool 314 at $138 where an exact
    // tick walk says $197-213. But it must still be CAPPED by what can actually
    // leave: without that, five self-issued goldenvaults tokens each claimed
    // $13,324 of depth against a real exit of $612, and took over the token
    // list. You cannot trade out more than there is to trade out.
    const raw = tradeDepth(p, 0.01);
    const exitCap = Math.min(da?.anchored ? Infinity : (da?.exit ?? 0),
                             db?.anchored ? Infinity : (db?.exit ?? 0));
    p.depth1 = raw == null ? null : Math.min(raw, isFinite(exitCap) ? exitCap : raw);
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
      rewardRealDay: rp ? perDay * rp.usd * (state.depth.get(rt)?.ratio ?? 0) : null,
      rewardSolid: !!state.depth.get(rt)?.solid,
      stakedReal: null, aprReal: null,
      periodFinish: finish, ended,
      runwayDays: ended ? 0 : (finish - now) / 86400e3,
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
    const stakedReal = (pool?.tvlReal != null && pool.lpSupply > 0) ? pool.tvlReal * (st.amount / pool.lpSupply) : null;
    const rewardRatio = state.depth.get(rt)?.ratio ?? 0;
    const rewardRealDay = rewardUsdDay != null ? rewardUsdDay * rewardRatio : null;
    // `remaining` is in raw units, so ten units of a six-decimal token — a
    // hundred-thousandth of one — passed as "live". Measured: 1,934 of 2,504
    // Taco farms had under a day of funding left and together accounted for 95%
    // of the daily reward figure this terminal published. Runway is the honest
    // test, and it is also what a person wants to know before entering.
    const runwayDays = Number(fr.daily_reward) > 0 ? Number(fr.remaining) / Number(fr.daily_reward) : 0;
    const live = runwayDays >= 1 && perDay > 0;
    farms.push({
      dex: 'taco', id: String(fr.id), poolDex: 'taco', poolId: pool ? pool.id : st.symbol, pool,
      rewardToken: rt, rewardSymbol: rsym, rewardPerDay: perDay, rewardUsdDay,
      periodFinish: null, ended: !live,
      totalWeight: st.amount, numStakes: null, creator: fr.owner,
      stakedUsd,
      stakedReal, rewardRealDay,
      // The number a person should act on: rewards they could actually sell,
      // over capital that is actually there. Both halves have to be real or the
      // percentage is arithmetic about nothing.
      aprReal: (live && rewardRealDay > 0 && stakedReal >= MIN_STAKE_FOR_APR_USD) ? (rewardRealDay * 365 / stakedReal) * 100 : null,
      rewardSolid: !!state.depth.get(rt)?.solid,
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
      tickSpacing: p.ts ?? null,
      priceUsdA: p.pa, priceUsdB: p.pb, usdA: p.pa, usdB: p.pb,
      lpFeeBps: p.d === 'taco' ? 10 : undefined,
      tvlPartial: (p.pa == null) !== (p.pb == null), active: true,
      routeDepth: p.rd ?? Infinity, thin: !!p.tn, tvlReal: p.vr ?? null, exitRatio: p.er ?? 0,
      vol24: p.v1 ?? null, vol7d: p.v7 ?? null, change24: p.ch ?? null,
      turnover: (p.v1 > 0 && p.vr > 0) ? p.v1 / p.vr : null,
      depth1: p.d1 ?? null, bornAt: p.bd ?? null,
      lpSupply: p.d === 'taco' ? p.l : undefined,
    };
  });
  state.pools = pools;
  state.tokens = tokens;
  state.prices = new Map(d.prices.map(([id, usd, via, depth]) => [id, { usd, via, depth: depth ?? Infinity }]));
  state.waxUsd = d.waxUsd;
  state.loadedAt = d.at;
  state.counts = d.counts || null;
  const byId = new Map(pools.map(p => [`${p.dex}:${p.id}`, p]));
  // Depth comes from the snapshot per token. It used to be faked as N entries of
  // a placeholder so the counters read right, which meant every token looked
  // unsellable and the Tokens view filtered itself down to nothing.
  state.depth = new Map();
  state.solidTokens = new Set();
  for (const row of d.prices) {
    const [id, , , , exit = 0, ratio = 0, solid = 0, nominal = 0, taxBps = 0, burnBps = 0, venueTaxBps = 0] = row;
    // taxBps is what the token charges in general; venueTaxBps is what a holder
    // was actually observed paying to deposit into swap.alcor, which for 28 of
    // the 40 taxed tokens is nothing at all.
    state.depth.set(id, { exit, ratio, solid: !!solid, nominal, realisable: nominal * ratio, taxBps, burnBps, venueTaxBps });
    if (solid) state.solidTokens.add(id);
  }
  // Yesterday's prices, so a 24h change is a subtraction rather than a guess.
  state.prevPrices = new Map((d.prevPrices || []).map(([id, usd]) => [id, usd]));
  state.prevAt = d.prevAt ?? null;

  state.farms = (d.farms || []).map(f => ({
    dex: f.d, id: f.i, poolDex: f.pd, poolId: f.pi, pool: byId.get(`${f.pd}:${f.pi}`),
    rewardToken: f.rt, rewardSymbol: f.rs, rewardPerDay: f.rp, rewardUsdDay: f.ru,
    periodFinish: f.pf, ended: false, totalWeight: f.tw, numStakes: f.ns,
    creator: f.cr, stakedUsd: f.su, apr: f.ap, aprStatus: f.st,
    stakedReal: f.sr ?? null, rewardRealDay: f.rr ?? 0, aprReal: f.ar ?? null, rewardSolid: !!f.so,
  }));
  // Keep the snapshot's farm rows around. A live chain read cannot value an
  // Alcor farm — that needs two extra calls per pool, which is why the daily job
  // does it — so without this every Alcor APR vanished a few seconds after the
  // page painted, taking the best farms on WAX with it.
  state.snapshotFarms = new Map();
  for (const f of (d.farms || [])) {
    if (f.sr == null && f.su == null) continue;
    const k = `${f.d}:${f.i}`;
    state.snapshotFarms.set(k, { stakedUsd: f.su, stakedReal: f.sr, at: d.at });
  }
  // Keep the snapshot's own per-pool facts for the same reason the farm rows
  // are kept: a live chain read cannot produce them. A pool row carries
  // reserves, not the date it was created.
  // Only Alcor publishes volume, so the daily job counts the other venues from
  // their own swap logs. That count is in this file and nowhere else — the
  // hourly volume file is Alcor-only — so it is kept here for the live sweep to
  // put back, or TacoSwap, Defibox and A-DEX report no trading at all.
  state.snapshotPools = new Map();
  for (const p of d.pools) {
    if (p.bd == null && p.v1 == null) continue;
    state.snapshotPools.set(`${p.d}:${p.i}`, { bornAt: p.bd ?? null, vol24: p.v1 ?? null, vol7d: p.v7 ?? null, change24: p.ch ?? null });
  }

  await applyVolume(pools);

  state.fromSnapshot = true;
  return d;
}

// Volume is refreshed hourly in its own file, because a 24h figure written into
// a daily snapshot reads 75% wrong a few hours later.
//
// It has to be applied to whichever set of pools is current. The live sweep
// builds new pool objects from chain and assigns them over the snapshot's, and
// for as long as it did not re-apply this, every volume figure in the terminal
// silently became a dash a few seconds after the page painted — the tokens
// table, "most traded", the pool rows, a token's 24h. A pool row on chain
// carries reserves; volume is history, and history lives in this file.
let volumeFile = null;
async function applyVolume(pools) {
  try {
    if (!volumeFile) {
      const r = await fetch('data/volume.json', { cache: 'no-cache' });
      if (!r.ok) return;
      volumeFile = await r.json();
    }
    state.volumeAt = volumeFile.at;
    const byId = new Map(pools.map(p => [`${p.dex}:${p.id}`, p]));
    for (const [id, row] of Object.entries(volumeFile.alcor || {})) {
      const pool = byId.get(`alcor:${id}`);
      if (!pool) continue;
      const [v1, v7, ch] = row;
      pool.vol24 = v1; pool.vol7d = v7; pool.change24 = ch;
      pool.turnover = (v1 > 0 && pool.tvlReal > 0) ? v1 / pool.tvlReal : null;
    }
  } catch { /* the snapshot's own figures stand in */ }
}

// Development brake. This machine also runs trading bots that depend on the same
// public WAX nodes from the same IP, and a repeated 19,820-pool sweep during UI
// work is load those bots do not need to compete with. `?snapshot=1` renders
// entirely from the committed file and touches the chain zero times.
//
// In production this cannot happen: the terminal runs in each visitor's browser,
// so their calls come from their own IP, and the daily snapshot runs on GitHub.
export const SNAPSHOT_ONLY = typeof location !== 'undefined' && new URLSearchParams(location.search).has('snapshot');

export async function loadCore({ onProgress = () => {}, force = false, swr = false } = {}) {
  if (SNAPSHOT_ONLY) {
    const d = await loadSnapshot();
    state.stale = false; state.hosts = [];   // no live read follows in this mode
    onProgress({ phase: 'snapshot', done: true, at: d.at, pools: state.pools.length });
    return state;
  }
  if (!force) {
    const cached = await cacheGet(CACHE_KEY);
    if (cached) {
      hydrate(cached);
      // The cache can be an hour older than volume.json, which refreshes hourly.
      await applyVolume(state.pools);
      state.stale = Date.now() - cached.loadedAt > FRESH_MS;
      onProgress({ phase: 'cache', done: true, stale: state.stale });
      if (!state.stale) return state;
      // Stale is not useless. Five minutes old means the pool reserves have
      // moved a little; it does not mean the reader should watch a spinner
      // sweep thirteen thousand rows before seeing anything. Hand back what is
      // here and let the caller refresh behind them.
      if (swr) return state;
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
  const [alcorPools, incentives, stakingpos, tacoPairs, tacoRewards, boxPairs, adexPools] = await Promise.all([
    getAllRowsSharded(ALCOR, ALCOR, 'pools', 13000, { onPage: (d, t) => onProgress({ phase: 'chain', msg: `Alcor pools ${d}/${t}` }) }),
    getAllRowsSharded(ALCOR, ALCOR, 'incentives', 5000),
    getAllRows(ALCOR, ALCOR, 'stakingpos'),
    getAllRows(TACO, TACO, 'pairs', { onPage: n => onProgress({ phase: 'chain', msg: `TacoSwap pairs ${n}` }) }),
    getAllRows(TACO, TACO, 'pairreward'),
    getAllRows(BOX, BOX, 'pairs', { onPage: n => onProgress({ phase: 'chain', msg: `Defibox pairs ${n}` }) }).catch(() => []),
    getAllRows(ADEX, ADEX, 'pools').catch(() => []),
  ]);

  onProgress({ phase: 'derive', msg: 'Pricing tokens' });
  state.shardsFailed = (alcorPools.shardsFailed || 0) + (incentives.shardsFailed || 0);
  const pools = [
    ...normaliseAlcor(alcorPools, tokens),
    ...normaliseTaco(tacoPairs, tokens),
    ...normaliseBox(boxPairs, tokens),
    ...normaliseAdex(adexPools, tokens),
  ];
  const prices = computePrices(pools);
  applyPrices(pools, prices);
  applyDepth(pools, prices);
  const farms = buildFarms({ incentives, stakingpos, tacoRewards, pools, prices, tokens });

  // Backfill what only the daily job can compute, and mark how old it is.
  let backfilled = 0;
  for (const f of farms) {
    if (f.stakedReal != null || f.dex !== 'alcor') continue;
    const snap = state.snapshotFarms.get(`${f.dex}:${f.id}`);
    if (!snap) continue;
    f.stakedUsd = snap.stakedUsd; f.stakedReal = snap.stakedReal; f.stakedAt = snap.at;
    if (f.stakedReal >= MIN_STAKE_FOR_APR_USD && f.rewardRealDay > 0) f.aprReal = (f.rewardRealDay * 365 / f.stakedReal) * 100;
    if (f.stakedUsd >= MIN_STAKE_FOR_APR_USD && f.rewardUsdDay > 0) f.apr = (f.rewardUsdDay * 365 / f.stakedUsd) * 100;
    backfilled++;
  }
  if (backfilled) onProgress({ phase: 'derive', msg: `restored staked value for ${backfilled} farms` });

  // The same restoration for pools: volume and the date a pool was created are
  // history, and the sweep reads state.
  for (const p of pools) {
    const snap = state.snapshotPools?.get(`${p.dex}:${p.id}`);
    if (!snap) continue;
    if (snap.bornAt != null) p.bornAt = snap.bornAt;
    if (snap.vol24 != null) { p.vol24 = snap.vol24; p.vol7d = snap.vol7d; p.change24 = snap.change24; }
  }
  // Alcor's hourly file lands last, so where both have a figure the fresher one
  // wins.
  await applyVolume(pools);

  state.pools = pools; state.farms = farms; state.prices = prices; state.tokens = tokens;
  stakingMap();          // warm it now; the farms page needs it and it takes seconds
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
// Alcor publishes an account's positions already valued, with fees earned and
// profit against what was deposited. Two seconds instead of twenty, and it
// carries figures the chain alone does not: what you put in, and what you have
// made since. Verified against our own chain read on a 13-position wallet — the
// two agree to 0.3%. If it is unavailable we fall through to reading the chain.
export async function walletPositionsFast(account) {
  const res = await fetch(`https://wax.alcor.exchange/api/v2/account/${encodeURIComponent(account)}/positions`,
    { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`alcor ${res.status}`);
  const rows = await res.json();
  const byId = new Map(state.pools.map(p => [`${p.dex}:${p.id}`, p]));
  const out = [];
  for (const r of rows) {
    if (r.closed) continue;
    const pool = byId.get(`alcor:${r.pool}`);
    if (!pool) continue;
    const fa = parseAsset(r.feesA || '0 X'), fb = parseAsset(r.feesB || '0 X');
    const s = pool.sqrtX64 ? sqrtPriceFromX64(pool.sqrtX64) : null;
    const ratio = s ? depositRatio(s, r.tickLower, r.tickUpper) : { shareA: 0.5, shareB: 0.5, inRange: !!r.inRange, side: 'in' };
    out.push({
      dex: 'alcor', pool, posId: r.id, owner: r.owner,
      tickLower: r.tickLower, tickUpper: r.tickUpper, liquidity: Number(r.liquidity),
      amountA: parseAsset(r.amountA || '0 X').amount,
      amountB: parseAsset(r.amountB || '0 X').amount,
      feesA: fa.amount, feesB: fb.amount,
      valueUsd: Number(r.totalValue) || 0,
      feesUsd: Number(r.totalFeesUSD) || 0,
      depositedUsd: Number(r.depositedUSDTotal) || 0,
      pnlUsd: Number(r.pNl) || 0,
      inRange: !!r.inRange, side: ratio.side, ratio,
    });
  }
  out.sort((a, b) => b.valueUsd - a.valueUsd);
  return out;
}

export async function walletPositions(account, { onProgress = () => {}, skipAlcor = false } = {}) {
  if (skipAlcor) {
    // Only the Taco side is wanted; skip the Alcor sweep entirely.
    const byId = new Map(state.pools.map(p => [`${p.dex}:${p.id}`, p]));
    const taco = [];
    try {
      for (const r of await getAllRows(TACO, account, 'accounts')) {
        const bal = parseAsset(r.balance);
        const pool = byId.get(`taco:${bal.symbol}`);
        if (!pool || !(bal.amount > 0) || !(pool.lpSupply > 0)) continue;
        const share = bal.amount / pool.lpSupply;
        taco.push({ dex: 'taco', pool, balance: bal.amount, share,
          amountA: pool.reserveA * share, amountB: pool.reserveB * share,
          valueUsd: pool.tvl != null ? pool.tvl * share : null,
          valueRealUsd: pool.tvlReal != null ? pool.tvlReal * share : null,
          inRange: true, side: 'in' });
      }
    } catch {}
    taco.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
    return { alcor: [], taco, poolsChecked: 0 };
  }
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
      const mine = rows.filter(p => p.owner === account);
      if (!mine.length) { done++; return; }
      const s = sqrtPriceFromX64(pool.sqrtX64);

      // A position's `feesA`/`feesB` are only what an earlier collect already
      // credited — zero on a position nobody has poked, while fees accrue.
      // Getting the real figure needs the pool's fee-growth counters and the
      // two ticks bounding each band, so they are read once per pool here.
      let raw = null, ticks = new Map();
      try {
        const pr = await getRows(ALCOR, ALCOR, 'pools', { limit: 1, lower: pid });
        if (pr.rows?.[0] && String(pr.rows[0].id) === String(pid)) raw = pr.rows[0];
        const wanted = [...new Set(mine.flatMap(p => [p.tickLower, p.tickUpper]))];
        await Promise.all(wanted.map(async t => {
          const d = await getRows(ALCOR, pid, 'ticks', { limit: 1, lower: t });
          const r = d.rows?.[0];
          if (r && Number(r.id) === Number(t)) ticks.set(Number(t), r);
        }));
      } catch { raw = null; }

      for (const p of mine) {
        const { amountA, amountB } = amountsForLiquidity(p.liquidity, s, p.tickLower, p.tickUpper);
        const ratio = depositRatio(s, p.tickLower, p.tickUpper);
        const owed = raw ? feesOwed(p, raw, ticks.get(p.tickLower), ticks.get(p.tickUpper))
                         : { feesA: Number(p.feesA), feesB: Number(p.feesB) };
        const fa = owed.feesA / 10 ** pool.decA, fb = owed.feesB / 10 ** pool.decB;
        out.push({
          dex: 'alcor', pool, posId: p.id, owner: p.owner,
          tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: Number(p.liquidity),
          amountA: amountA / 10 ** pool.decA, amountB: amountB / 10 ** pool.decB,
          feesA: fa, feesB: fb,
          valueUsd: positionUsd(p, pool, s),
          feesUsd: fa * (pool.priceUsdA || 0) + fb * (pool.priceUsdB || 0),
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
  // Pages go out in parallel against a live feed, and `skip` counts from the
  // top of a descending sort, so a swap landing mid-fetch shifts every later
  // page down by one and the tail of one page reappears as the head of the
  // next. Measured at 0 over 12 pages in a quiet market, but a burst is exactly
  // when this view matters. Dedupe on global_sequence, which is unique per
  // action. NOT on trx_id: 314 of 1,000 Alcor logswaps share a transaction
  // because a multi-hop route is several real swaps, and collapsing those
  // would delete volume rather than protect it.
  // Hyperion caps total.value at 10,000, so hitting exactly that means the
  // window is larger than it will tell us — a 24h feed summed from it reported
  // $1,633 against Alcor's own $30,514 for the same day.
  const capped = (first.total?.value ?? 0) >= 10000;
  const truncated = capped || (first.total?.value ?? 0) > actions.length;
  const byId = new Map(state.pools.map(p => [`${p.dex}:${p.id}`, p]));
  const out = [];
  const seen = new Set();
  let repeats = 0;
  for (const a of actions) {
    if (a.global_sequence != null) {
      if (seen.has(a.global_sequence)) { repeats++; continue; }
      seen.add(a.global_sequence);
    }
    const x = a.act.data;
    if (poolId != null && String(x.poolId) !== String(poolId)) continue;
    const pool = byId.get(`alcor:${x.poolId}`);
    const ta = parseAsset(x.tokenA), tb = parseAsset(x.tokenB);
    // One leg is negative (leaving the pool). Value the swap on whichever side
    // we can actually price.
    // A swap is ONE trade with two sides, so it must be valued once — on the
    // side whose price we trust more. Taking side A whenever it exists valued
    // trades in whichever junk token happened to be listed first.
    const dA = state.depth.get(pool?.tokenA), dB = state.depth.get(pool?.tokenB);
    const usdA = pool?.priceUsdA != null ? Math.abs(ta.amount) * pool.priceUsdA : null;
    const usdB = pool?.priceUsdB != null ? Math.abs(tb.amount) * pool.priceUsdB : null;
    const preferA = (dA?.exit ?? 0) >= (dB?.exit ?? 0);
    const nominal = preferA ? (usdA ?? usdB) : (usdB ?? usdA);
    const ratio = Math.max(dA?.ratio ?? 0, dB?.ratio ?? 0);
    out.push({
      ts: a.timestamp, trx: a.trx_id, seq: Number(a.global_sequence) || 0, pool, poolId: String(x.poolId),
      trader: x.sender, symA: ta.symbol, symB: tb.symbol,
      amountA: ta.amount, amountB: tb.amount,
      volumeUsd: nominal ?? null,
      volumeReal: nominal != null ? nominal * ratio : null,
      dir: ta.amount > 0 ? 'buyB' : 'buyA',
    });
  }
  // The other three venues publish their own swap log, and those are small
  // enough to read whole: an hour of WAX is thousands of Alcor swaps against a
  // few hundred on TacoSwap and a couple of dozen on Defibox. Leaving them out
  // made "every trade on WAX" mean "every trade on Alcor", and hid the routes
  // that cross from one venue to another — which are exactly the interesting
  // ones, since they only exist because the two disagreed on a price.
  const others = await otherVenueSwaps(after, byId).catch(() => []);
  out.push(...others);
  out.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  out.windowMinutes = minutes;
  out.truncated = truncated;
  out.capped = capped;
  out.repeats = repeats;
  out.reportedTotal = (first.total?.value ?? out.length) + others.length;
  out.venueCounts = { alcor: out.length - others.length, other: others.length };
  return out;
}

// Where each venue logs a swap, and how to read one. The shapes differ enough
// that a single parser would be mostly branches: Taco names the trader `maker`
// and the others `owner`, A-DEX wraps its amounts in {quantity, contract}, and
// only Alcor emits signed deltas rather than an in/out pair.
const SWAP_LOGS = [
  { dex: 'taco', account: TACO, action: 'exchangelog', pool: x => x.id, who: x => x.maker, in: x => x.quantity_in, out: x => x.quantity_out },
  { dex: 'defibox', account: BOX, action: 'swaplog', pool: x => x.pair_id, who: x => x.owner, in: x => x.quantity_in, out: x => x.quantity_out },
  { dex: 'adex', account: ADEX, action: 'swaplog', pool: x => x.pool_id, who: x => x.owner, in: x => x.quantity_in?.quantity, out: x => x.quantity_out?.quantity },
];

async function otherVenueSwaps(after, byId) {
  const sets = await Promise.all(SWAP_LOGS.map(async src => {
    const rows = [];
    for (let page = 0; page < 3; page++) {
      let d;
      try {
        d = await hyperion(`/v2/history/get_actions?${new URLSearchParams({
          'act.account': src.account, 'act.name': src.action, after,
          limit: '1000', skip: String(page * 1000), sort: 'desc',
        })}`);
      } catch { break; }
      const got = d.actions || [];
      rows.push(...got);
      if (got.length < 1000) break;
    }
    const out = [];
    const seen = new Set();
    for (const a of rows) {
      const gs = a.global_sequence ?? a.receipts?.[0]?.global_sequence;
      if (gs != null) { if (seen.has(gs)) continue; seen.add(gs); }
      const x = a.act.data;
      const pool = byId.get(`${src.dex}:${src.pool(x)}`);
      if (!pool) continue;
      const qi = src.in(x), qo = src.out(x);
      if (!qi || !qo) continue;
      const ai = parseAsset(qi), ao = parseAsset(qo);
      // Signed the way Alcor signs it: what the pool gained is positive.
      const inIsA = ai.symbol === pool.symA;
      const amountA = inIsA ? ai.amount : -ao.amount;
      const amountB = inIsA ? -ao.amount : ai.amount;
      const dA = state.depth.get(pool.tokenA), dB = state.depth.get(pool.tokenB);
      const usdA = pool.priceUsdA != null ? Math.abs(amountA) * pool.priceUsdA : null;
      const usdB = pool.priceUsdB != null ? Math.abs(amountB) * pool.priceUsdB : null;
      const preferA = (dA?.exit ?? 0) >= (dB?.exit ?? 0);
      const nominal = preferA ? (usdA ?? usdB) : (usdB ?? usdA);
      const ratio = Math.max(dA?.ratio ?? 0, dB?.ratio ?? 0);
      out.push({
        ts: a.timestamp, trx: a.trx_id, seq: Number(gs) || 0, pool, poolId: String(src.pool(x)),
        trader: src.who(x), symA: pool.symA, symB: pool.symB,
        amountA, amountB,
        volumeUsd: nominal ?? null,
        volumeReal: nominal != null ? nominal * ratio : null,
        dir: amountA > 0 ? 'buyB' : 'buyA',
      });
    }
    return out;
  }));
  return sets.flat();
}

// A multi-hop trade is one intent, not several. Swaps that share a transaction
// are the hops of a single route, ordered by global_sequence — 314 of every
// 1,000 Alcor logswaps are one of these, and read as separate trades they
// scatter a single decision across the table with no way to see the shape of
// it. Reconstructing the path also separates the two kinds of trade on WAX: a
// route that ends in the token it started from is an arbitrage cycle, and one
// that ends somewhere else is somebody actually swapping.
export function tradeRoutes(swaps) {
  const byTx = new Map();
  for (const s of swaps) {
    if (!byTx.has(s.trx)) byTx.set(s.trx, []);
    byTx.get(s.trx).push(s);
  }
  const routes = new Map();
  for (const [trx, hops] of byTx) {
    hops.sort((a, b) => a.seq - b.seq);
    const path = [];
    const pools = [];
    for (const h of hops) {
      const inA = h.amountA > 0;
      if (!path.length) path.push(inA ? h.symA : h.symB);
      path.push(inA ? h.symB : h.symA);
      pools.push(h.poolId);
    }
    // Every hop carries roughly the same value, so summing them counts one
    // trade several times. The route is worth what went into it.
    const value = hops[0]?.volumeReal ?? hops[0]?.volumeUsd ?? null;
    const key = path.join('\u2009\u2192\u2009');
    let r = routes.get(key);
    if (!r) {
      r = { path, key, hops: hops.length, pools, cycle: path.length > 2 && path[0] === path[path.length - 1],
            n: 0, usd: 0, priced: 0, traders: new Map(), last: hops[0].ts, sample: trx };
      routes.set(key, r);
    }
    r.n++;
    if (value != null) { r.usd += value; r.priced++; }
    if (hops[0].ts > r.last) { r.last = hops[0].ts; r.sample = trx; }
    r.traders.set(hops[0].trader, (r.traders.get(hops[0].trader) || 0) + 1);
  }
  const all = [...routes.values()];
  for (const r of all) {
    r.top = [...r.traders].sort((a, b) => b[1] - a[1]);
    r.solo = r.top.length === 1;
  }
  return all;
}


// Hyperion get_deltas replays a table row over time — this is the entire history
// layer, for free, with no indexer. `primary_key` filters server-side, so one
// pool costs one query instead of pulling the whole table and discarding 99% of
// it. Retention is the history node's, not ours.
// TacoSwap keys its pairs by symbol code rather than by number — "LFGWAXA"
// rather than 17 — and get_deltas wants the number. It is the same uint64 seen
// a different way: up to seven bytes, first character in the lowest.
const symbolCodeKey = code => {
  let v = 0n;
  for (let i = code.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(code.charCodeAt(i));
  return v.toString();
};

// Where each venue keeps the state a swap rewrites, and which side of the row
// this codebase calls A. These must match the normalise* functions above or
// every trade comes out backwards.
const DELTA_SOURCE = {
  alcor:   { code: ALCOR, table: 'pools', key: p => String(p.id), a: r => r.tokenA.quantity, b: r => r.tokenB.quantity },
  taco:    { code: TACO,  table: 'pairs', key: p => symbolCodeKey(String(p.id)), a: r => r.pool1.quantity, b: r => r.pool2.quantity },
  defibox: { code: BOX,   table: 'pairs', key: p => String(p.id), a: r => r.reserve0, b: r => r.reserve1 },
  adex:    { code: ADEX,  table: 'pools', key: p => String(p.id), a: r => r.base_token.quantity, b: r => r.quote_token.quantity },
};

// Alcor publishes its own candles, and they go back to the day the pool opened.
//
// Replaying pool rows was the only way to chart the venues that publish
// nothing, and it still is for those — but on Alcor it was the wrong tool for
// long windows. Hyperion caps a delta query at 10,000 rows, so a busy pool hit
// that ceiling two and a half days back however wide a date range was asked
// for: the chart cut off at 28 August because there was nothing older in hand,
// not because nothing older happened.
//
// This is one request for 148,288 five-minute bars reaching to May 2023, with
// open, high, low, close and volume already aggregated. Cheaper, longer, and
// computed by the venue whose pool it is.
const ALCOR_RESOLUTION = { 300: '5', 900: '15', 1800: '30', 3600: '60', 14400: '240', 86400: '1D', 604800: '1W' };

const candleCache = new Map();
export async function alcorCandles(poolId, bucketSec) {
  const res = ALCOR_RESOLUTION[bucketSec];
  if (!res) return null;
  const key = `${poolId}:${res}`;
  if (candleCache.has(key)) return candleCache.get(key);
  const r = await fetch(`https://wax.alcor.exchange/api/v2/swap/pools/${encodeURIComponent(poolId)}/candles?resolution=${res}`,
    { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`candles ${r.status}`);
  const raw = await r.json();
  // Numbers arrive as strings, and time in milliseconds where the chart wants
  // seconds. A bar with a zero or missing price is dropped rather than drawn as
  // a spike to the floor.
  const out = raw.map(c => ({
    time: Math.floor(c.time / 1000),
    open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
    volume: Number(c.volume) || 0,
  })).filter(c => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)
    .sort((a, b) => a.time - b.time);
  candleCache.set(key, out);
  return out;
}

// Which venues a trade history can be replayed for at all.
export const TRADE_VENUES = new Set(Object.keys(DELTA_SOURCE));

// One pool's past, on any of the four venues.
//
// All of them keep their state in a plain table, and Hyperion's get_deltas
// replays a single row filtered server-side by primary key — one query per
// pool instead of pulling the whole table and discarding 99% of it. Retention
// is the history node's, not ours.
export async function venueDeltas(pool, { limit = 1000, pages = 3, after = null, before = null } = {}) {
  const src = DELTA_SOURCE[pool.dex];
  if (!src) return [];
  const key = src.key(pool);
  const out = [];
  for (let page = 0; page < pages; page++) {
    const q = new URLSearchParams({
      code: src.code, scope: src.code, table: src.table,
      primary_key: key, limit: String(limit), skip: String(page * limit), sort: 'desc',
      ...(after ? { after } : {}), ...(before ? { before } : {}),
    });
    let d;
    try { d = await hyperion(`/v2/history/get_deltas?${q}`); }
    catch (e) { if (!out.length) throw e; break; }
    const got = (d.deltas || []).filter(x => String(x.primary_key) === key);
    out.push(...got);
    if (got.length < limit) break;
  }
  return out.map(x => {
    const a = parseAsset(src.a(x.data)), b = parseAsset(src.b(x.data));
    let price = null;
    if (pool.dex === 'alcor') {
      // Concentrated liquidity: the reserve ratio is not the price.
      try { price = priceFromX64(x.data.currSlot.sqrtPriceX64, a.decimals, b.decimals); } catch {}
    } else if (a.amount > 0) price = b.amount / a.amount;
    return {
      ts: new Date(x.timestamp + (x.timestamp.endsWith('Z') ? '' : 'Z')).getTime(),
      block: x.block_num, reserveA: a.amount, reserveB: b.amount,
      price, liquidity: Number(x.data.liquidity ?? x.data.liquidity_token ?? 0),
    };
  }).filter(r => r.price > 0).reverse();
}

// How far back a chart reaches should follow the candle you asked for, not a
// row count. Three pages of a busy pool is 1.7 days — fine at five minutes a
// candle, useless at one a day, which is why the long intervals looked cut off:
// there was nothing older to draw, and the chart was honestly showing all it
// had.
//
// `get_deltas` accepts a time range, and the 10,000-row ceiling is per query
// rather than per pool, so a window is fetched by date and paged within it.
export const CHART_WINDOW_DAYS = { 300: 2, 900: 5, 3600: 21, 14400: 90, 86400: 400 };

// Cached per pool: switching 1h → 24h → 1h should not refetch what is already
// in hand, and the widest window fetched so far covers every narrower one.
const deltaCache = new Map();

export async function chartDeltas(pool, bucketSec, { onProgress = null } = {}) {
  const days = CHART_WINDOW_DAYS[bucketSec] ?? 21;
  const key = `${pool.dex}:${pool.id}`;
  const held = deltaCache.get(key);
  if (held && held.days >= days) return held.rows;

  onProgress?.(days);
  const after = new Date(Date.now() - days * 86400000).toISOString();
  // A wide window on a busy pool is a lot of rows, so the page budget grows
  // with it rather than being spent on the first two days.
  const pages = days <= 5 ? 3 : days <= 21 ? 6 : 10;
  const rows = await venueDeltas(pool, { pages, after });
  // A wider window that came back with less than a narrower one means the
  // history node's retention ran out, not that the pool went quiet — keep
  // whichever reaches further back.
  if (!held || rows.length >= held.rows.length) deltaCache.set(key, { days, rows });
  return deltaCache.get(key).rows;
}

export const poolDeltas = (poolId, opts) => venueDeltas({ dex: 'alcor', id: poolId }, opts);
export const poolHistory = (poolId, opts) => poolDeltas(poolId, opts);

// Trades read back out of the pool row.
//
// Hyperion cannot filter logswap by pool: the `poolId` query parameter is
// accepted and silently ignored, and what comes back is the whole chain's swap
// firehose. Asking for one pool's trades that way means reading every swap on
// WAX and throwing almost all of it away, which is why a token page could only
// ever claim "no trades in six hours" after actually looking at about twenty
// minutes of them.
//
// The pool row itself is the trade index. Every swap rewrites it, so two
// consecutive states are one trade: the reserve that fell is what was sold,
// the one that rose is what was bought. Deposits and withdrawals rewrite the
// same row, so they have to be told apart or a single large deposit reads as a
// day of trading — a swap moves the two sides in opposite directions and moves
// the price with them, which a mint or a burn does not.
export function swapsFromDeltas(rows) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], r = rows[i];
    const dA = r.reserveA - prev.reserveA;
    const dB = r.reserveB - prev.reserveB;
    const opposed = (dA > 0 && dB < 0) || (dA < 0 && dB > 0);
    if (!opposed || r.price === prev.price) continue;
    out.push({
      ts: r.ts, block: r.block, price: r.price,
      amountA: dA, amountB: dB,
      // Which way a reader thinks of it: A went in, or A came out.
      side: dA > 0 ? 'sell' : 'buy',
    });
  }
  return out;
}


// Candles from state changes. Every swap rewrites the pool row, so consecutive
// rows give both the price path and — from the change in reserves — the volume
// that moved it. No trade index required.
export function toCandles(rows, { bucketSec = 300 } = {}) {
  const buckets = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const key = Math.floor(r.ts / 1000 / bucketSec) * bucketSec;
    let c = buckets.get(key);
    if (!c) { c = { time: key, open: r.price, high: r.price, low: r.price, close: r.price, volume: 0 }; buckets.set(key, c); }
    c.high = Math.max(c.high, r.price);
    c.low = Math.min(c.low, r.price);
    c.close = r.price;
    const prev = rows[i - 1];
    if (prev) c.volume += Math.abs(r.reserveA - prev.reserveA);
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
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
        aprStatus: 'lazy', endsAt: null, anyUnpriceable: false, newestId: 0,
      };
      groups.set(key, g);
    }
    g.farms.push(f);
    g.newestId = Math.max(g.newestId, Number(f.id) || 0);
    if (f.ended) g.expired = true;
    if (f.runwayDays != null) g.runwayDays = g.runwayDays == null ? f.runwayDays : Math.max(g.runwayDays, f.runwayDays);
    g.rewards.push({ symbol: f.rewardSymbol, token: f.rewardToken, perDay: f.rewardPerDay, usdDay: f.rewardUsdDay, id: f.id });
    if (f.rewardUsdDay != null) g.rewardUsdDay += f.rewardUsdDay; else g.anyUnpriceable = true;
    if (f.periodFinish && (!g.endsAt || f.periodFinish < g.endsAt)) g.endsAt = f.periodFinish;
  }

  for (const g of groups.values()) {
    // Every incentive on one pool shares the same staked capital, so the group's
    // stake is the largest any of them reports — not their sum.
    //
    // This used to run for Taco only. Alcor's stake needs two chain reads per
    // pool, so the daily job computes it and writes it onto each farm row; but
    // this function ignored those and left every Alcor group at null, which
    // discarded all 362 of them and left the farms page showing no Alcor APR at
    // all. The venue makes no difference here: if the number is on the rows,
    // use it.
    const known = g.farms.map(f => f.stakedUsd).filter(v => v != null && v > 0);
    if (known.length) g.stakedUsd = Math.max(...known);
    const knownReal = g.farms.map(f => f.stakedReal).filter(v => v != null && v > 0);
    if (knownReal.length) g.stakedReal = Math.max(...knownReal);

    if (g.dex === 'taco') {
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
    g.rewardRealDay = g.farms.reduce((s, f) => s + (f.rewardRealDay || 0), 0);
    g.rewardsSolid = g.farms.some(f => f.rewardSolid);
    if (g.stakedReal >= MIN_STAKE_FOR_APR_USD && g.rewardRealDay > 0) {
      g.aprReal = (g.rewardRealDay * 365 / g.stakedReal) * 100;
    } else g.aprReal = null;
  }
  return [...groups.values()];
}

// Exact staked value for a whole pool's farm set. Different incentives on one
// pool have different staked sets, so the denominator is their UNION — counting
// a position once even when it is staked in five of them.
const groupCache = new Map();

// posId -> the incentives it is staked in, for the whole chain. One paged read
// shared by every group that asks, instead of the stakes table once per
// incentive — which is where the wait came from.
let stakingPromise = null;
function stakingMap() {
  stakingPromise ??= getAllRows(ALCOR, ALCOR, 'stakingpos')
    .then(rows => new Map(rows.map(r => [String(r.posId), (r.incentiveIds || []).map(String)])))
    .catch(() => { stakingPromise = null; return new Map(); });
  return stakingPromise;
}
export async function groupStakedUsd(group) {
  if (group.dex === 'taco') return group.stakedUsd;
  if (groupCache.has(group.key)) return groupCache.get(group.key);
  const pool = group.pool;
  if (!pool || !pool.sqrtX64) return null;

  const staked = await stakingMap();
  const ours = new Set(group.farms.map(f => String(f.id)));
  const posIds = new Set();
  for (const [posId, incs] of staked) if (incs.some(i => ours.has(i))) posIds.add(posId);
  if (!posIds.size) { groupCache.set(group.key, 0); return 0; }

  const positions = await getAllRows(ALCOR, group.poolId, 'positions');
  const s = sqrtPriceFromX64(pool.sqrtX64);
  let usd = 0;
  for (const p of positions) if (posIds.has(String(p.id))) usd += positionUsd(p, pool, s);
  // Scale to what the staked capital could actually be sold for, using the same
  // exit ratio that governs the pool's own real value.
  const ratio = pool.tvl > 0 ? (pool.tvlReal || 0) / pool.tvl : 0;
  groupCache.set(group.key, usd);
  group.stakedReal = usd * ratio;
  return usd;
}


// ---------------------------------------------------------------- history ---
// The daily GitHub Action appends one line per run, split by month. This is the
// only multi-year memory in the system: chain state is now-only and Hyperion's
// retention is not ours to depend on.
export async function loadHistory({ months = 24 } = {}) {
  const now = new Date();
  const names = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    names.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const files = await Promise.all(names.map(async n => {
    try {
      const r = await fetch(`data/history/${n}.ndjson`, { cache: 'no-cache' });
      if (!r.ok) return [];
      return (await r.text()).trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }));
  return files.flat().sort((a, b) => a.at - b.at);
}

// One token's line out of that history. The daily job records the tokens with
// real pooled value, so a token that has never been in that band has no history
// at all — an empty series is a gap to say out loud, not a zero to plot.
export function tokenSeries(rows, id) {
  const out = [];
  for (const r of rows) {
    const hit = (r.tokens || []).find(t => t[0] === id);
    if (!hit) continue;
    out.push({ at: r.at, tvl: hit[1] ?? 0, vol: hit[2] ?? 0, price: hit[3] ?? null, pools: hit[4] ?? 0 });
  }
  return out;
}

// Several runs a day collapse to that day's last reading, so a day the job ran
// twice does not weigh double against one where it ran once.
export function perDay(rows, key = r => r.at) {
  const m = new Map();
  for (const r of rows) m.set(new Date(key(r)).toISOString().slice(0, 10), r);
  return [...m.values()];
}


// ----------------------------------------------------------------- tokens ---
// A token's standing across every venue at once: what it is worth, how much of
// it is pooled, how much actually trades, and how many pools would have to be
// wrong for that to be wrong.
export function tokenTable() {
  const rows = new Map();
  const touch = id => {
    let r = rows.get(id);
    if (!r) {
      const t = state.tokens.get(id) || { symbol: id.split('@')[0], contract: id.split('@')[1] };
      const d = state.depth.get(id);
      r = {
        id, symbol: t.symbol, contract: t.contract,
        price: state.prices.get(id)?.usd ?? null,
        tvl: 0, tvlNominal: 0, vol24: 0, vol7d: 0, pools: 0, venues: new Set(),
        exit: d?.exit ?? 0, solid: !!d?.solid, ratio: d?.ratio ?? 0, depth1: 0, bornAt: null,
        taxBps: d?.taxBps ?? 0, burnBps: d?.burnBps ?? 0, venueTaxBps: d?.venueTaxBps ?? 0,
      };
      rows.set(id, r);
    }
    return r;
  };

  for (const p of state.pools) {
    if (!(p.tvl > 0) && !(p.vol24 > 0)) continue;
    const half = (p.tvlReal || 0) / 2, halfNom = (p.tvl || 0) / 2;
    for (const [id, side] of [[p.tokenA, 'a'], [p.tokenB, 'b']]) {
      const r = touch(id);
      // Split the pool's value between its two sides rather than crediting each
      // with the whole thing, or the totals add up to twice the market.
      r.tvl += half; r.tvlNominal += halfNom;
      // Volume is the trade, and a trade touches both tokens — so both are
      // credited in full. That is the convention every DEX tracker uses, and it
      // means token volumes deliberately do not sum to venue volume.
      r.vol24 += p.vol24 || 0;
      r.vol7d += p.vol7d || 0;
      // Depth adds across pools — you can split an order — but only up to what
      // can actually leave. Summing 57 buzzingarden pools gave LADYZ $13,324 of
      // "depth" against a $6,220 exit, because moving it 1% in one pool moves it
      // in the other 56: arbitrage closes them in the same block. The cap is
      // applied after the sum.
      r.depth1 += p.depth1 || 0;
      // A token is as new as the first pool anyone made for it.
      if (p.bornAt && (r.bornAt == null || p.bornAt < r.bornAt)) r.bornAt = p.bornAt;
      r.pools++; r.venues.add(p.dex);
    }
  }
  for (const r of rows.values()) {
    const d = state.depth.get(r.id);
    if (d && !d.anchored && isFinite(d.exit)) r.depth1 = Math.min(r.depth1, d.exit);

    // 24h change, from the price this token had in the previous snapshot. A
    // token that was not priced then has no change — which is not the same as
    // zero, and must not be sorted as though it were.
    const was = state.prevPrices.get(r.id);
    r.change24 = (was > 0 && r.price > 0) ? (r.price / was - 1) * 100 : null;
    r.priceWas = was ?? null;

    // Trending is not "traded the most" — that is the same eight tokens every
    // day. It is trading unusually MUCH FOR ITSELF: today against its own
    // weekly run rate. A token needs a real day behind it to qualify, or every
    // token whose first-ever trade happened today scores infinity.
    const weekly = r.vol7d > 0 ? r.vol7d / 7 : 0;
    r.heat = (weekly > 0 && r.vol24 >= 50) ? r.vol24 / weekly : null;
  }
  return [...rows.values()];
}
