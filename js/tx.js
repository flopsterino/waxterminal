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
// `me`/`auth` are overridable so the action set can be built and validated
// against the chain's serialiser without a wallet attached.
export function buildHarvest({ pool, position, basket, plan, me = account(), auth = null }) {
  auth = auth || [{ actor: me, permission: 'active' }];
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

  return { actions, swaps: [] };
}

// --------------------------------------------------------- transaction 2 ----
// Swap what actually arrived into the ratio the band needs, then deposit it.
export function buildSwaps({ pool, plan, harvested, me = account(), auth = null }) {
  auth = auth || [{ actor: me, permission: 'active' }];
  const actions = [];
  const swaps = [];
  for (const s of plan.swaps) {
    const from = tokenMeta(s.fromToken), to = tokenMeta(s.toToken);
    const pFrom = priceOf(s.fromToken), pTo = priceOf(s.toToken);
    if (!pFrom || !pTo) { swaps.push({ ...s, skipped: 'unpriceable' }); continue; }
    const path = findPath(s.fromToken, s.toToken);
    if (!path || !path.length) { swaps.push({ ...s, skipped: 'no route' }); continue; }

    // Sized against the measured harvest, never the estimate. `harvested` maps
    // token id to what the claim actually produced; anything not in it cannot
    // be swapped, because the holder did not receive it.
    const available = harvested?.get(s.fromToken);
    let amountIn = s.usd / pFrom;
    if (available != null) amountIn = Math.min(amountIn, available);
    if (!(amountIn > 0)) { swaps.push({ ...s, skipped: 'nothing harvested' }); continue; }
    const expectedOut = amountIn * pFrom / pTo;
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
// Balances of every token the harvest could produce, read before it runs, so
// afterwards the difference is exactly what was claimed — the two pool tokens
// plus whatever the farms pay in.
export async function readBalances(pool, tokenIds = [], me = account()) {
  const ids = [...new Set([pool.tokenA, pool.tokenB, ...tokenIds])];
  const out = new Map();
  await Promise.all(ids.map(async id => {
    const t = tokenMeta(id);
    try { out.set(id, await balanceOf(me, t.contract, t.symbol)); } catch { out.set(id, 0); }
  }));
  return out;
}

// The difference the claim made, per token. A negative delta means something
// else spent that token in between; it counts as nothing rather than as a guess.
export function harvestedFrom(before, after) {
  const out = new Map();
  for (const [id, was] of before) {
    const now = after.get(id) ?? 0;
    const gained = now - was;
    if (gained > 0) out.set(id, gained);
  }
  return out;
}

// Compound what the harvest produced — nothing else.
//
// This used to deposit the wallet balance. Someone holding 10,000 CHEESE who
// harvested 200 had all 10,200 swept into the pool, which is not compounding,
// it is a forced deposit of everything they own in that token. The only safe
// definition of "the rewards" is the difference the harvest made, so the
// balances are read before and after and only the delta is redeposited.
// What a holder was measured paying to move this token into swap.alcor. The
// snapshot probes it from real deposits rather than reading the token's ABI,
// because the tables mislead in both directions.
function venueTaxOf(tokenId) {
  return state.depth?.get(tokenId)?.venueTaxBps ?? 0;
}

export async function buildRedeposit({ pool, position, feeBps = 0, feeAccount = '', before, expected = null, me = account(), auth = null }) {
  auth = auth || [{ actor: me, permission: 'active' }];
  const ta = tokenMeta(pool.tokenA), tb = tokenMeta(pool.tokenB);

  const [afterA, afterB] = await Promise.all([
    balanceOf(me, ta.contract, ta.symbol),
    balanceOf(me, tb.contract, tb.symbol),
  ]);

  if (!before) throw new Error('Cannot tell rewards from holdings: balances before the harvest are missing');
  // `before` is a Map keyed by token id.
  const beforeA = before.get ? (before.get(pool.tokenA) ?? 0) : before.a;
  const beforeB = before.get ? (before.get(pool.tokenB) ?? 0) : before.b;
  // A negative delta means something else spent that token between the two
  // reads; compound nothing rather than guess.
  let balA = Math.max(0, afterA - beforeA);
  let balB = Math.max(0, afterB - beforeB);
  if (!(balA > 0) && !(balB > 0)) throw new Error('The harvest produced nothing to redeposit');

  // Belt and braces. The delta is the right answer, but if the "before" read
  // ever came back wrong — a failed call defaulting to zero, a stale value — the
  // delta becomes the whole wallet and this would sweep it into the pool. So the
  // deposit is also capped against what the plan said the harvest was worth.
  // Anything far past that is a measurement error, not a windfall.
  if (expected) {
    const capA = expected.a * 3, capB = expected.b * 3;
    if (capA > 0 && balA > capA) balA = capA;
    if (capB > 0 && balB > capB) balB = capB;
    if ((capA > 0 && balA >= capA) || (capB > 0 && balB >= capB)) {
      console.warn('[compound] harvest delta exceeded the plan by 3x; capped', { balA, balB, expected });
    }
  }

  const actions = [];
  let feeA = 0, feeB = 0;
  if (feeAccount && feeBps > 0) {
    feeA = balA * (feeBps / 10000);
    feeB = balB * (feeBps / 10000);
  }
  const depA = Math.max(0, balA - feeA);
  const depB = Math.max(0, balB - feeB);

  // addliquid spends from the internal balance, so it must ask for what ARRIVES
  // there, not what left the wallet. A token that taxes the deposit delivers
  // less and the whole compound reverts with the same "Insufficient balance"
  // that an unfunded addliquid gives. Asking for slightly less never reverts —
  // the shortfall simply stays in the internal balance and funds the next run —
  // so discount by the rate a holder was measured paying. 28 of the 40 taxed
  // tokens charge nothing here, and those keep a discount of zero.
  const net = (amt, id) => amt * (1 - (venueTaxOf(id) / 10000));
  const askA = net(depA, pool.tokenA);
  const askB = net(depB, pool.tokenB);

  // addliquid does NOT spend from your wallet. It spends from a balance held
  // inside swap.alcor, which you fund by transferring in with memo "deposit"
  // first — every real addliquid on chain is preceded by two of these. Calling
  // addliquid alone fails with "assertion failure with message: Insufficient
  // balance", because the internal balance is zero however much you hold.
  for (const [amt, t] of [[depA, ta], [depB, tb]]) {
    if (amt > 0 && Number(dec(amt, t.decimals)) > 0) {
      actions.push({
        account: t.contract, name: 'transfer', authorization: auth,
        data: { from: me, to: ALCOR, quantity: asset(amt, t.symbol, t.decimals), memo: 'deposit' },
      });
    }
  }

  actions.push({
    account: ALCOR, name: 'addliquid', authorization: auth,
    data: {
      poolId: Number(pool.id), owner: me,
      tokenADesired: asset(askA, ta.symbol, ta.decimals),
      tokenBDesired: asset(askB, tb.symbol, tb.decimals),
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

  // Whatever the pool does not take stays in the internal balance and can be
  // pulled back with swap.alcor::withdraw. We cannot name the amount before the
  // deposit executes, so it is surfaced to the user rather than silently left.
  return { actions, balA, balB, depA, depB, askA, askB, feeA, feeB, afterA, afterB,
    venueTaxA: venueTaxOf(pool.tokenA), venueTaxB: venueTaxOf(pool.tokenB), leftoverNote: true };
}

// Joining a farm: one stake action per incentive.
//
// Deliberately NOT part of compounding, though it looks like it should be.
// Alcor's addliquid emits logstaked for every incentive the position is already
// in, inside the same transaction, so the added liquidity starts earning
// immediately. Checked against a real compound: the position's liquidity went
// to 4,540,799,113 and its staking weight to 4,540,799,088 in the same trace.
// A restake step appended to the flow would be an extra signature that changes
// nothing.
export function buildRestake({ position, incentiveIds, me = account(), auth = null }) {
  auth = auth || [{ actor: me, permission: 'active' }];
  return incentiveIds.map(id => ({
    account: ALCOR, name: 'stake', authorization: auth,
    data: { incentiveId: Number(id), posId: Number(position.posId) },
  }));
}

// ------------------------------------------------------- stake rewards -----
// Compounding the yield on staked WAX, which is the one most holders never
// collect: it does not arrive on its own, it has a daily cooldown, and the vote
// that earns it decays until re-cast.
//
// Split in two for the same reason the LP compound is: the payout comes from a
// shared bucket divided by a continuously-updating voteshare, so the amount is
// not knowable until the claim has executed. Predicting it means either leaving
// WAX unstaked or trying to stake more than arrived.
const SYSTEM = 'eosio';
const WAX_DECIMALS = 8;

// Re-casting the same proxy or producers refreshes a decaying vote weight and
// changes who you vote for not at all — which is why real claims on chain are
// almost always paired with it. Skipped when they have never voted, because
// there is no existing choice to re-cast and this must never pick one for them.
export function buildVoteClaim({ account: me = account(), proxy = '', producers = [], auth = null }) {
  auth = auth || [{ actor: me, permission: 'active' }];
  const actions = [];
  if (proxy || producers.length) {
    actions.push({
      account: SYSTEM, name: 'voteproducer', authorization: auth,
      data: { voter: me, proxy: proxy || '', producers: proxy ? [] : producers },
    });
  }
  actions.push({ account: SYSTEM, name: 'claimgbmvote', authorization: auth, data: { owner: me } });
  return { actions, refreshedVote: !!(proxy || producers.length) };
}

// Put back what actually landed, in the CPU/NET ratio they already run, and pay
// the fee from the same claim. Anything the caller did not measure is not spent:
// `claimed` is a balance difference, never a balance.
export function buildStakeBack({
  claimed, cpuWeight = 1, netWeight = 0,
  account: me = account(), feeBps = 0, feeAccount = '', auth = null,
}) {
  auth = auth || [{ actor: me, permission: 'active' }];
  if (!(claimed > 0)) return { actions: [], staked: 0, fee: 0 };

  // The fee is the partner's to set and stays off until they name an account —
  // an empty recipient must never mean "charge it anyway".
  const bps = feeAccount ? Math.max(0, Math.min(100, feeBps)) : 0;
  const fee = claimed * (bps / 10000);
  const net = Math.max(0, claimed - fee);

  // Keep their existing split rather than imposing one. An account staked
  // entirely to CPU should stay that way.
  const total = cpuWeight + netWeight;
  const cpuShare = total > 0 ? cpuWeight / total : 1;
  const toCpu = net * cpuShare;
  const toNet = Math.max(0, net - toCpu);

  const actions = [{
    account: SYSTEM, name: 'delegatebw', authorization: auth,
    data: {
      from: me, receiver: me,
      stake_net_quantity: asset(toNet, 'WAX', WAX_DECIMALS),
      stake_cpu_quantity: asset(toCpu, 'WAX', WAX_DECIMALS),
      // Staking to yourself: never transfer ownership of the stake.
      transfer: false,
    },
  }];

  if (fee > 0) {
    actions.push({
      account: 'eosio.token', name: 'transfer', authorization: auth,
      data: { from: me, to: feeAccount, quantity: asset(fee, 'WAX', WAX_DECIMALS), memo: 'stake compound fee' },
    });
  }
  return { actions, staked: net, fee, toCpu, toNet };
}

// -------------------------------------------------- liquidity, by hand -----
// Adding and removing liquidity directly, rather than only as the tail of a
// compound. Both shapes read off real transactions rather than off the ABI
// alone, because the ABI does not tell you where the tokens end up.
//
// They end up in different places, which is the thing worth knowing:
//
//   addliquid  spends from an internal balance inside swap.alcor, funded by a
//              transfer with memo "deposit" in the same transaction. Called on
//              its own it fails with "Insufficient balance", which is a
//              confusing way for a contract to say "you did not send anything".
//   subliquid  pays straight back to the wallet — principal, accrued fees and
//              farm rewards all at once — so nothing has to be withdrawn after.

// Slippage on a deposit is not the same risk as on a swap: the pool takes what
// it needs at the current ratio and the rest stays in the internal balance. The
// minimums exist to stop the price moving under you mid-transaction.
const LIQ_SLIPPAGE = 0.01;

export function buildAddLiquidity({
  pool, tickLower, tickUpper, amountA, amountB,
  me = account(), auth = null, slippage = LIQ_SLIPPAGE,
}) {
  auth = auth || [{ actor: me, permission: 'active' }];
  const ta = tokenMeta(pool.tokenA), tb = tokenMeta(pool.tokenB);
  const actions = [];

  // Ask for what ARRIVES, not for what was sent: a token that taxes the
  // transfer delivers less than it took, and asking for the full amount fails.
  // Under-asking never reverts — the remainder simply stays in the internal
  // balance and can be withdrawn.
  const net = (amt, id) => amt * (1 - (state.depth?.get(id)?.venueTaxBps ?? 0) / 10000);
  const askA = net(amountA, pool.tokenA);
  const askB = net(amountB, pool.tokenB);

  if (amountA > 0) actions.push({
    account: ta.contract, name: 'transfer', authorization: auth,
    data: { from: me, to: ALCOR, quantity: asset(amountA, ta.symbol, ta.decimals), memo: 'deposit' },
  });
  if (amountB > 0) actions.push({
    account: tb.contract, name: 'transfer', authorization: auth,
    data: { from: me, to: ALCOR, quantity: asset(amountB, tb.symbol, tb.decimals), memo: 'deposit' },
  });

  actions.push({
    account: ALCOR, name: 'addliquid', authorization: auth,
    data: {
      poolId: Number(pool.id), owner: me,
      tokenADesired: asset(askA, ta.symbol, ta.decimals),
      tokenBDesired: asset(askB, tb.symbol, tb.decimals),
      tickLower, tickUpper,
      tokenAMin: asset(askA * (1 - slippage), ta.symbol, ta.decimals),
      tokenBMin: asset(askB * (1 - slippage), tb.symbol, tb.decimals),
      deadline: 0,
    },
  });
  return { actions, askA, askB, venueTaxA: state.depth?.get(pool.tokenA)?.venueTaxBps ?? 0, venueTaxB: state.depth?.get(pool.tokenB)?.venueTaxBps ?? 0 };
}

// Take some or all of a position back out. `fraction` of 1 closes it.
//
// Liquidity is an integer and the contract compares it exactly, so the share is
// floored: asking to burn one unit more than exists reverts the whole thing.
export function buildRemoveLiquidity({
  pool, position, fraction = 1, expectedA = 0, expectedB = 0,
  me = account(), auth = null, slippage = LIQ_SLIPPAGE,
}) {
  auth = auth || [{ actor: me, permission: 'active' }];
  const ta = tokenMeta(pool.tokenA), tb = tokenMeta(pool.tokenB);
  const share = Math.max(0, Math.min(1, fraction));
  const liquidity = Math.floor(Number(position.liquidity) * share);
  if (!(liquidity > 0)) return { actions: [], liquidity: 0 };

  return {
    actions: [{
      account: ALCOR, name: 'subliquid', authorization: auth,
      data: {
        poolId: Number(pool.id), owner: me,
        liquidity: String(liquidity),
        tickLower: position.tickLower, tickUpper: position.tickUpper,
        // Zero when we have no expectation to check against: a floor computed
        // from a number we did not measure would reject good transactions on a
        // normal tick of the price.
        tokenAMin: asset(expectedA > 0 ? expectedA * share * (1 - slippage) : 0, ta.symbol, ta.decimals),
        tokenBMin: asset(expectedB > 0 ? expectedB * share * (1 - slippage) : 0, tb.symbol, tb.decimals),
        deadline: 0,
      },
    }],
    liquidity, share,
  };
}
