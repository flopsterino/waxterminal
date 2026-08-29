// =============================================================================
// TX — turning a compound plan into actions a wallet can sign.
//
// Split into TWO transactions on purpose. addliquid takes concrete amounts, but
// a swap's output is only known once it executes. Predicting it means either
// under-depositing (leaving value behind) or over-asking (the whole thing
// reverts on a rounding error). So: harvest and swap first, read what actually
// landed, then deposit that. Two signatures, no guessing.
// =============================================================================

import { state } from './store.js';
import { balanceOf } from './chain.js';
import { authorization, account } from './wallet.js';

const ALCOR = 'swap.alcor';
const SLIPPAGE = 0.02;          // on swap minOut only; the deposit uses real balances

const dec = (v, d) => {
  // Always round DOWN: asking to spend a satoshi more than you hold reverts.
  const f = 10 ** d;
  return (Math.floor(v * f) / f).toFixed(d);
};
export const asset = (amount, symbol, decimals) => `${dec(amount, decimals)} ${symbol}`;

const tokenMeta = id => state.tokens.get(id) || { symbol: id.split('@')[0], contract: id.split('@')[1], decimals: 8 };
const priceOf = id => state.prices.get(id)?.usd ?? null;

// --------------------------------------------------------------- routing ----
// Alcor's swapexactin memo routes a whole comma-separated pool path internally,
// so one transfer can cross several pools. Find the path whose thinnest pool is
// deepest — a route is only as good as its worst hop.
export function findPath(fromToken, toToken, { maxHops = 3 } = {}) {
  if (fromToken === toToken) return [];
  const byToken = new Map();
  for (const p of state.pools) {
    if (p.dex !== 'alcor' || !(p.tvl > 0)) continue;
    for (const [a, b] of [[p.tokenA, p.tokenB], [p.tokenB, p.tokenA]]) {
      if (!byToken.has(a)) byToken.set(a, []);
      byToken.get(a).push({ pool: p, other: b });
    }
  }
  let best = null;
  const seen = new Map([[fromToken, 0]]);
  const queue = [{ token: fromToken, path: [], bottleneck: Infinity }];
  while (queue.length) {
    const cur = queue.shift();
    if (cur.path.length >= maxHops) continue;
    for (const edge of (byToken.get(cur.token) || [])) {
      const bottleneck = Math.min(cur.bottleneck, edge.pool.tvl);
      if (best && bottleneck <= best.bottleneck) continue;      // cannot beat what we have
      const path = [...cur.path, edge.pool];
      if (edge.other === toToken) {
        if (!best || bottleneck > best.bottleneck) best = { path, bottleneck };
        continue;
      }
      const depthSeen = seen.get(edge.other) ?? -1;
      if (bottleneck > depthSeen) { seen.set(edge.other, bottleneck); queue.push({ token: edge.other, path, bottleneck }); }
    }
  }
  return best ? best.path : null;
}

// --------------------------------------------------------- transaction 1 ----
// Collect fees, claim every farm, and swap whatever is not already a pool token.
export function buildHarvest({ pool, position, basket, plan }) {
  const auth = authorization();
  const me = account();
  const actions = [];

  if (basket.some(b => b.source === 'fees')) {
    const fa = basket.find(b => b.source === 'fees' && b.tokenId === pool.tokenA);
    const fb = basket.find(b => b.source === 'fees' && b.tokenId === pool.tokenB);
    actions.push({
      account: ALCOR, name: 'collect', authorization: auth,
      data: {
        poolId: Number(pool.id), owner: me, recipient: me,
        tickLower: position.tickLower, tickUpper: position.tickUpper,
        // Cap at what we read. Fees accruing in the meantime stay put and are
        // picked up by the next compound rather than making this one unpredictable.
        tokenAMax: asset(fa ? fa.amount : 0, pool.symA, pool.decA),
        tokenBMax: asset(fb ? fb.amount : 0, pool.symB, pool.decB),
      },
    });
  }

  for (const id of [...new Set(basket.filter(b => b.incentiveId).map(b => b.incentiveId))]) {
    actions.push({
      account: ALCOR, name: 'getreward', authorization: auth,
      data: { incentiveId: Number(id), posId: Number(position.posId) },
    });
  }

  const swaps = [];
  for (const s of plan.swaps) {
    const from = tokenMeta(s.fromToken), to = tokenMeta(s.toToken);
    const pFrom = priceOf(s.fromToken), pTo = priceOf(s.toToken);
    if (!pFrom || !pTo) { swaps.push({ ...s, skipped: 'unpriceable' }); continue; }
    const path = findPath(s.fromToken, s.toToken);
    if (!path || !path.length) { swaps.push({ ...s, skipped: 'no route' }); continue; }

    const amountIn = s.usd / pFrom;
    const expectedOut = s.usd / pTo;
    const minOut = expectedOut * (1 - SLIPPAGE);
    if (!(amountIn > 0) || !(minOut > 0)) { swaps.push({ ...s, skipped: 'dust' }); continue; }

    const memo = `swapexactin#${path.map(p => p.id).join(',')}#${me}#${asset(minOut, to.symbol, to.decimals)}@${to.contract}#0`;
    actions.push({
      account: from.contract, name: 'transfer', authorization: auth,
      data: { from: me, to: ALCOR, quantity: asset(amountIn, from.symbol, from.decimals), memo },
    });
    swaps.push({ ...s, amountIn, minOut, path: path.map(p => p.id), hops: path.length });
  }

  return { actions, swaps };
}

// --------------------------------------------------------- transaction 2 ----
// Read what actually landed, deposit it into the same band, pay the fee.
export async function buildRedeposit({ pool, position, feeBps = 75, feeAccount = '' }) {
  const me = account();
  const auth = authorization();
  const ta = tokenMeta(pool.tokenA), tb = tokenMeta(pool.tokenB);

  const [balA, balB] = await Promise.all([
    balanceOf(me, ta.contract, ta.symbol),
    balanceOf(me, tb.contract, tb.symbol),
  ]);

  const actions = [];
  let feeA = 0, feeB = 0;
  if (feeAccount && feeBps > 0) {
    feeA = balA * (feeBps / 10000);
    feeB = balB * (feeBps / 10000);
  }
  const depA = Math.max(0, balA - feeA);
  const depB = Math.max(0, balB - feeB);

  actions.push({
    account: ALCOR, name: 'addliquid', authorization: auth,
    data: {
      poolId: Number(pool.id), owner: me,
      tokenADesired: asset(depA, ta.symbol, ta.decimals),
      tokenBDesired: asset(depB, tb.symbol, tb.decimals),
      tickLower: position.tickLower, tickUpper: position.tickUpper,
      // The pool takes whichever side binds and returns the rest, so a floor of
      // zero is correct here: there is nothing to protect against.
      tokenAMin: asset(0, ta.symbol, ta.decimals),
      tokenBMin: asset(0, tb.symbol, tb.decimals),
      deadline: 0,
    },
  });

  // The fee rides in the same transaction the user reviews, so it is visible
  // before signing and cannot be taken any other way.
  for (const [amt, t] of [[feeA, ta], [feeB, tb]]) {
    if (amt > 0 && Number(dec(amt, t.decimals)) > 0) {
      actions.push({
        account: t.contract, name: 'transfer', authorization: auth,
        data: { from: me, to: feeAccount, quantity: asset(amt, t.symbol, t.decimals), memo: `compound fee ${(feeBps / 100).toFixed(2)}%` },
      });
    }
  }

  return { actions, balA, balB, depA, depB, feeA, feeB };
}

// Restaking is separate: a position staked in several incentives needs one
// stake action each, and only after the liquidity is in.
export function buildRestake({ position, incentiveIds }) {
  const auth = authorization();
  return incentiveIds.map(id => ({
    account: ALCOR, name: 'stake', authorization: auth,
    data: { incentiveId: Number(id), posId: Number(position.posId) },
  }));
}
