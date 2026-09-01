// =============================================================================
// COMPOUND — planning a harvest-and-redeposit for one concentrated position.
//
// The naive picture (claim one reward, put it back) does not survive contact
// with real farms. Measured on chain 2026-08-29: 633 of 1,883 farmed pools pay
// MORE THAN ONE reward token, some of them nine or ten at once, and 1,125 live
// farms pay a token that is not in the pool at all — while 1,837 pay one that
// already is. So a harvest is a basket of N assets, of which an arbitrary subset
// already happens to be the right token.
//
// On top of that, the destination is a tick range, not a pool. The required
// deposit ratio is a function of the band and the current price, so it moves
// every time the market does, and every position wants a different one.
//
// This module therefore solves: basket of N assets -> exactly the two-token
// ratio THIS band needs, with the fewest swaps, and no contract in the loop.
// =============================================================================

import { depositRatio, amountsForLiquidity } from './math.js';
import { getAllRows, getRows } from './chain.js';

const ALCOR = 'swap.alcor';
const DUST_USD = 0.01;

// Incentive rows are immutable enough within a session and are shared by every
// position staked in them, so one fetch serves the whole wallet.
const incCache = new Map();
async function incentiveById(iid) {
  const key = String(iid);
  if (incCache.has(key)) return incCache.get(key);
  const d = await getRows(ALCOR, ALCOR, 'incentives', { limit: 1, lower: key });
  const row = d.rows?.[0];
  const val = (row && String(row.id) === key) ? row : null;
  incCache.set(key, val);
  return val;
}

// ---------------------------------------------------------------- harvest ---
// Synthetix-style staking maths, which is what Alcor's incentives implement:
//   rewardPerToken = stored + (elapsed * rewardRateE18) / totalStakingWeight
//   earned         = weight * (rewardPerToken - userPaid) / 1e18 + rewards
// `elapsed` stops at periodFinish, otherwise an ended farm keeps accruing on
// paper and every downstream number inherits the error.
export function pendingReward(incentive, stake, nowSec = Date.now() / 1000) {
  const total = Number(incentive.totalStakingWeight);
  const stored = Number(incentive.rewardPerTokenStored);
  const last = Number(incentive.lastUpdateTime);
  const finish = Number(incentive.periodFinish);
  const applicable = Math.min(nowSec, finish);
  const elapsed = Math.max(0, applicable - last);
  const rpt = total > 0 ? stored + (elapsed * Number(incentive.rewardRateE18)) / total : stored;
  const weight = Number(stake.stakingWeight);
  const earnedRaw = weight * (rpt - Number(stake.userRewardPerTokenPaid)) / 1e18 + Number(stake.rewards);
  return Math.max(0, earnedRaw);
}

// Everything claimable for one position: uncollected trading fees on both sides,
// plus the pending reward from every incentive it is staked in.
export async function harvestFor(position, pool, { prices, tokens }) {
  const basket = [];

  const feeA = Number(position.feesA ?? 0);
  const feeB = Number(position.feesB ?? 0);
  if (feeA > 0) basket.push({ tokenId: pool.tokenA, symbol: pool.symA, amount: feeA, usd: pool.priceUsdA != null ? feeA * pool.priceUsdA : null, source: 'fees', priced: pool.priceUsdA != null });
  if (feeB > 0) basket.push({ tokenId: pool.tokenB, symbol: pool.symB, amount: feeB, usd: pool.priceUsdB != null ? feeB * pool.priceUsdB : null, source: 'fees', priced: pool.priceUsdB != null });

  // Which incentives is this position staked in? stakingpos is the global map.
  let incentiveIds = [];
  try {
    const sp = await getRows(ALCOR, ALCOR, 'stakingpos', { limit: 1, lower: position.posId });
    const row = sp.rows?.[0];
    if (row && String(row.posId) === String(position.posId)) incentiveIds = row.incentiveIds || [];
  } catch { /* unstaked positions simply have no row */ }

  // Both tables are keyed so we can ask for exactly one row: incentives by id,
  // stakes by posId. Fetching whole tables to find a single row is what made the
  // first version of this unusably slow. All incentives are read at once, and
  // incentive rows are shared across positions, so they are cached.
  const results = await Promise.all(incentiveIds.map(async iid => {
    try {
      const [inc, stakeRes] = await Promise.all([
        incentiveById(iid),
        getRows(ALCOR, String(iid), 'stakes', { limit: 1, lower: position.posId }),
      ]);
      if (!inc) return null;
      const stake = stakeRes.rows?.[0];
      if (!stake || String(stake.posId) !== String(position.posId)) return null;
      const [, sym] = String(inc.reward.quantity).split(/\s+/);
      const dec = (String(inc.reward.quantity).split(' ')[0].split('.')[1] || '').length;
      const amount = pendingReward(inc, stake) / 10 ** dec;
      if (!(amount > 0)) return null;
      const tokenId = `${sym}@${inc.reward.contract}`;
      const px = prices.get(tokenId);
      return { tokenId, symbol: sym, amount, usd: px ? amount * px.usd : null, source: `farm #${iid}`, priced: !!px, incentiveId: String(iid) };
    } catch { return null; }          // one unreadable incentive must not void the harvest
  }));
  for (const r of results) if (r) basket.push(r);
  return { basket, incentiveIds };
}

// ------------------------------------------------------------------- plan ---
// Route an N-asset basket into the exact two-token split this band needs.
//
// Order matters: assets that are ALREADY tokenA or tokenB are counted first and
// never swapped, because swapping them would pay fees to arrive where they are.
// Whatever is foreign is then split across the two sides in proportion to what
// each side is still short, which usually removes the need for a final trim.
// `noSwap` compounds only what already fits.
//
// The default plan converts the whole basket into the band's ratio, and on a
// lopsided harvest that means selling most of one reward to buy the other: a
// $5 CHEESE / $2 WAXWBTC claim into a 50/50 band sells $1.50 of CHEESE. Every
// compounding holder doing that on the same schedule is real, self-inflicted
// selling pressure on the token they are farming.
//
// So there is a second, quieter shape: put back the largest balanced pair the
// harvest already contains, and leave the remainder in the wallet. Nothing is
// sold, nothing is lost — the leftover is simply not deposited, and it funds
// the next compound.
export function planCompound({ pool, position, basket, feeBps = 0, sqrtP, noSwap = false }) {
  const ratio = depositRatio(sqrtP, position.tickLower, position.tickUpper);

  const priced = basket.filter(b => b.priced && b.usd > 0);
  const unpriced = basket.filter(b => !b.priced || !(b.usd > 0));
  const grossUsd = priced.reduce((s, b) => s + b.usd, 0);
  const feeUsd = grossUsd * (feeBps / 10000);
  const netUsd = grossUsd - feeUsd;
  const keep = grossUsd > 0 ? netUsd / grossUsd : 0;

  const isA = b => b.tokenId === pool.tokenA;
  const isB = b => b.tokenId === pool.tokenB;

  let haveA = priced.filter(isA).reduce((s, b) => s + b.usd, 0) * keep;
  let haveB = priced.filter(isB).reduce((s, b) => s + b.usd, 0) * keep;

  // Two incentives on the same pool often pay the SAME token (measured: pool
  // 4356 pays ASSETS from two separate farms). They still need one getreward
  // each, but they must swap as one lot or we pay the spread twice.
  const merged = new Map();
  for (const b of priced) {
    if (isA(b) || isB(b)) continue;
    const cur = merged.get(b.tokenId);
    if (cur) { cur.usd += b.usd * keep; cur.amount += b.amount; cur.sources.push(b.source); }
    else merged.set(b.tokenId, { ...b, usd: b.usd * keep, sources: [b.source] });
  }
  const foreign = [...merged.values()];

  const targetA = netUsd * ratio.shareA;
  const targetB = netUsd * ratio.shareB;

  const swaps = [];
  let needA = targetA - haveA, needB = targetB - haveB;

  // ---- the quiet path: deposit what already fits, sell nothing -------------
  if (noSwap) {
    // The band wants shareA:shareB. Without a swap the deposit is capped by
    // whichever side is proportionally shorter — a side the band does not want
    // at all (share 0) cannot be the constraint, so it is skipped rather than
    // dividing by zero.
    const capA = ratio.shareA > 0 ? haveA / ratio.shareA : Infinity;
    const capB = ratio.shareB > 0 ? haveB / ratio.shareB : Infinity;
    const total = Math.min(capA, capB);
    const depA = isFinite(total) ? total * ratio.shareA : 0;
    const depB = isFinite(total) ? total * ratio.shareB : 0;
    // Everything not deposited stays where it is: the unswapped side, and every
    // foreign reward, which without a swap can never become a pool token.
    // Amounts as well as dollars: a panel that has to explain where money goes
    // is not helped by "$0.90" when the holder is looking for "220 WAX".
    const share = (usdPart, wholeUsd, wholeAmt) => (wholeUsd > 0 ? wholeAmt * (usdPart / wholeUsd) : 0);
    const amtA = priced.filter(isA).reduce((s, b) => s + b.amount, 0);
    const amtB = priced.filter(isB).reduce((s, b) => s + b.amount, 0);
    const left = [];
    if (haveA - depA > DUST_USD) left.push({ symbol: pool.symA, tokenId: pool.tokenA, usd: haveA - depA, amount: share(haveA - depA, haveA, amtA) });
    if (haveB - depB > DUST_USD) left.push({ symbol: pool.symB, tokenId: pool.tokenB, usd: haveB - depB, amount: share(haveB - depB, haveB, amtB) });
    for (const f of foreign) left.push({ symbol: f.symbol, tokenId: f.tokenId, usd: f.usd, amount: f.amount, foreign: true });
    const depositUsd = depA + depB;

    const actions = [
      ...(basket.some(b => b.source === 'fees') ? [{ name: 'collect', contract: ALCOR, note: `uncollected ${pool.symA}/${pool.symB} fees` }] : []),
      ...[...new Set(basket.filter(b => b.incentiveId).map(b => b.incentiveId))].map(id => ({ name: 'getreward', contract: ALCOR, note: `incentive #${id}` })),
      ...(depositUsd > 0 ? [{ name: 'addliquid', contract: ALCOR, note: `back into ticks ${position.tickLower}…${position.tickUpper}` }] : []),
      ...(depositUsd > 0 && feeBps > 0 ? [{ name: 'transfer', contract: 'fee', note: `${(feeBps / 100).toFixed(2)}% service fee` }] : []),
    ];

    return {
      noSwap: true, ratio, grossUsd, feeUsd, netUsd,
      targetA: depA, targetB: depB, finalA: depA, finalB: depB,
      depositA: depA, depositB: depB, depositUsd,
      leftover: left, leftoverUsd: left.reduce((s, x) => s + x.usd, 0),
      swaps: [], alreadyRight: priced.filter(b => isA(b) || isB(b)), unpriced, foreign,
      actions,
      needsSplit: actions.length > 14,
      viable: depositUsd > 0,
      warn: !ratio.inRange ? 'Out of range — the price has left this band, so what you add earns nothing until it comes back.' : null,
      reason: depositUsd > 0 ? null
        : `Without swapping there is no balanced pair to put back — this harvest is ${haveA > haveB ? pool.symA : pool.symB} on one side only. Switch to "with swapping", or let it build up.`,
    };
  }

  // Foreign assets first, largest first so the big decisions are made while both
  // deficits are still meaningful.
  for (const f of foreign.sort((x, y) => y.usd - x.usd)) {
    const pa = Math.max(0, needA), pb = Math.max(0, needB);
    const tot = pa + pb;
    let toA, toB;
    if (tot <= 0) { toA = f.usd * ratio.shareA; toB = f.usd - toA; }   // both full: follow the band's own ratio
    else { toA = f.usd * (pa / tot); toB = f.usd - toA; }
    if (toA > DUST_USD) { swaps.push({ from: f.symbol, fromToken: f.tokenId, to: pool.symA, toToken: pool.tokenA, usd: toA, why: 'foreign reward' }); haveA += toA; needA -= toA; }
    if (toB > DUST_USD) { swaps.push({ from: f.symbol, fromToken: f.tokenId, to: pool.symB, toToken: pool.tokenB, usd: toB, why: 'foreign reward' }); haveB += toB; needB -= toB; }
  }

  // Anything still off is trimmed with one swap between the two pool tokens.
  if (needA > DUST_USD)      { swaps.push({ from: pool.symB, fromToken: pool.tokenB, to: pool.symA, toToken: pool.tokenA, usd: needA, why: 'rebalance to band' }); haveA += needA; haveB -= needA; needA = 0; }
  else if (needB > DUST_USD) { swaps.push({ from: pool.symA, fromToken: pool.tokenA, to: pool.symB, toToken: pool.tokenB, usd: needB, why: 'rebalance to band' }); haveB += needB; haveA -= needB; needB = 0; }

  const alreadyRight = priced.filter(b => isA(b) || isB(b));

  // Action budget for the single transaction the wallet will be asked to sign.
  const actions = [
    ...(basket.some(b => b.source === 'fees') ? [{ name: 'collect', contract: ALCOR, note: `uncollected ${pool.symA}/${pool.symB} fees` }] : []),
    ...[...new Set(basket.filter(b => b.incentiveId).map(b => b.incentiveId))].map(id => ({ name: 'getreward', contract: ALCOR, note: `incentive #${id}` })),
    ...swaps.map(s => ({ name: 'swap', contract: ALCOR, note: `${s.from} → ${s.to}` })),
    { name: 'addliquid', contract: ALCOR, note: `back into ticks ${position.tickLower}…${position.tickUpper}` },
    ...(feeUsd > 0 ? [{ name: 'transfer', contract: 'fee', note: `${(feeBps / 100).toFixed(2)}% service fee` }] : []),
  ];

  return {
    noSwap: false, ratio, grossUsd, feeUsd, netUsd,
    targetA, targetB, finalA: haveA, finalB: haveB,
    // What the redeposit is sized against. Named explicitly rather than
    // recomputed from netUsd at the call site, so the two modes cannot drift.
    depositA: haveA, depositB: haveB, depositUsd: haveA + haveB,
    leftover: unpriced.map(b => ({ symbol: b.symbol, tokenId: b.tokenId, usd: 0, unpriced: true })),
    leftoverUsd: 0,
    swaps, alreadyRight, unpriced, foreign,
    actions,
    // WAX transactions are bounded by CPU/NET, not just action count; past this
    // the builder should split rather than let it fail on chain.
    needsSplit: actions.length > 14,
    viable: netUsd > 0,
    warn: !ratio.inRange ? 'Out of range — the price has left this band, so what you add earns nothing until it comes back.' : null,
    reason: netUsd > 0 ? null : 'Nothing has accrued yet — there is nothing to claim.',
  };
}

// ------------------------------------------------------------ farm gap -----
// Being an LP and being in the farm are two different things, and the terminal
// used to show only the first. Measured on pool 11051 (CHEESE/HOLE): two live
// incentives paying 32.5% and 6.6%, fifteen positions staked into them and one
// that is not — earning trading fees and nothing else, with no indication
// anywhere that a farm was even running on the pool it is sitting in.
//
// That is the whole answer to "why can I not compound this one with farm
// rewards": there are no farm rewards to compound, because nobody pressed stake.

// Which incentives each position is staked in. One keyed read per position
// rather than a walk of a 60,000-row table, run a few at a time.
export async function stakedIncentives(posIds, { concurrency = 6 } = {}) {
  const map = new Map();
  const ids = [...posIds];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= ids.length) return;
      const posId = ids[i];
      try {
        const d = await getRows(ALCOR, ALCOR, 'stakingpos', { limit: 1, lower: posId });
        const row = d.rows?.[0];
        map.set(String(posId), (row && String(row.posId) === String(posId)) ? row.incentiveIds.map(String) : []);
      } catch { map.set(String(posId), []); }
    }
  }));
  return map;
}

// The farms running on a position's pool, split into the ones it is already in
// and the ones it is missing. `farms` is the terminal's own farm list, so this
// costs nothing beyond the stakedIncentives read.
export function farmGap(position, farms, joinedIds = []) {
  const joined = new Set(joinedIds.map(String));
  const now = Date.now();
  const live = farms.filter(f => f.poolDex === 'alcor' && String(f.poolId) === String(position.pool.id) && f.periodFinish > now);
  const missing = live.filter(f => !joined.has(String(f.id)));
  const sumApr = list => {
    const known = list.map(f => f.apr).filter(v => v != null && isFinite(v));
    return known.length ? known.reduce((s, v) => s + v, 0) : null;
  };
  return {
    live, missing,
    inFarm: live.filter(f => joined.has(String(f.id))),
    aprLive: sumApr(live),
    aprMissing: sumApr(missing),
    // What the missing farms would pay this position per day once it joins.
    // Its own stake dilutes the pot, so the quoted APR is what the farm pays
    // today and not what this position would get: the honest figure is the
    // pot's daily value times the share this position would then hold. On a
    // small farm that difference is most of the number.
    missedUsdDay: missing.reduce((s, f) => {
      const pot = f.rewardUsdDay;
      const staked = f.stakedUsd;
      if (!(pot > 0) || !(position.valueUsd > 0)) return s;
      if (!(staked > 0)) return s + pot;                 // an empty farm pays it all
      return s + pot * (position.valueUsd / (staked + position.valueUsd));
    }, 0),
  };
}
