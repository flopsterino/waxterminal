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
import { authorization, account, hasSession } from './wallet.js';

const ALCOR = 'swap.alcor';
const SLIPPAGE = 0.02;          // on swap minOut only; the deposit uses real balances

const dec = (v, d) => {
  // Always round DOWN: asking to spend a satoshi more than you hold reverts.
  const f = 10 ** d;
  return (Math.floor(v * f) / f).toFixed(d);
};
export const asset = (amount, symbol, decimals) => `${dec(amount, decimals)} ${symbol}`;

// account() returns null, not undefined, when nothing is connected — and a
// default parameter only fills in for undefined. So `me = account()` yields
// null, passes explicitly into the next builder where the same default cannot
// rescue it either, and the first anyone hears of it is the ABI encoder
// refusing to serialise a name field: "Found null for non-optional type: name".
// A true message about entirely the wrong thing.
//
// Reported once from a connected wallet on the Liquidity page, which none of
// the obvious explanations account for: both modules import the same wallet.js
// under the same stamped URL, there is no second load path, and the button
// behind it already checks account(). So the guard says what it actually saw —
// whether a session object exists, and what it reported as the actor — because
// the next occurrence has to be diagnosable from a screenshot rather than
// another round of guessing.
const signer = me => {
  const who = me ?? account();
  if (!who) {
    throw new Error(`No wallet connected — connect one and try again. `
      + `(passed ${me === undefined ? 'nothing' : JSON.stringify(me)}, `
      + `session ${hasSession() ? 'present' : 'missing'}, account ${JSON.stringify(account())})`);
  }
  return String(who);
};

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
  me = signer(me);
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
  me = signer(me);
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
    // Zero is the only refusal. Not "too small to bother with" — that is the
    // holder's call — but genuinely zero once rounded to what the token can
    // express, where the transfer would either do nothing or revert.
    if (parseFloat(dec(amountIn, from.decimals)) <= 0) { swaps.push({ ...s, skipped: `below one ${from.symbol} unit` }); continue; }
    if (parseFloat(dec(minOut, to.decimals)) <= 0) { swaps.push({ ...s, skipped: `would return less than one ${to.symbol} unit` }); continue; }

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

export async function buildRedeposit({ pool, position, feeBps = 0, feeAccount = '', before, expected = null, exact = false, me = account(), auth = null }) {
  me = signer(me);
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
  //
  // The 3x slack is for the ordinary path, where the plan and the harvest are
  // meant to be the same thing and the gap is only measurement error. With
  // selling switched off they are deliberately different — the plan deposits a
  // fraction of what is in the wallet — so 3x stops being tolerance and starts
  // being a leak: it would sweep three times the intended amount, and addliquid
  // parks whatever the band cannot use inside swap.alcor rather than handing it
  // back, which is worse than leaving it in the wallet where the holder wanted
  // it. So an exact plan gets an exact cap.
  if (expected) {
    const slack = exact ? 1.02 : 3;
    const capA = expected.a * slack, capB = expected.b * slack;
    if (capA > 0 && balA > capA) balA = capA;
    if (capB > 0 && balB > capB) balB = capB;
    if ((capA > 0 && balA >= capA) || (capB > 0 && balB >= capB)) {
      console.warn(`[compound] harvest delta exceeded the plan by ${slack}x; capped`, { balA, balB, expected });
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
  me = signer(me);
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
export function buildVoteClaim({ account: me = account(), proxy = '', producers = [], fallbackProxy = '', auth = null }) {
  me = signer(me);
  auth = auth || [{ actor: me, permission: 'active' }];
  const actions = [];

  // An account that has never voted earns nothing at all, and no amount of
  // claiming changes that — so a claim that leaves it unvoted is a button that
  // cannot work. Where there is no existing choice, the configured proxy is
  // cast; where there is one, it is re-cast unchanged, which refreshes a
  // decaying weight without touching who they picked.
  const hasOwn = !!(proxy || producers.length);
  const useProxy = hasOwn ? proxy : fallbackProxy;
  if (hasOwn || fallbackProxy) {
    actions.push({
      account: SYSTEM, name: 'voteproducer', authorization: auth,
      data: { voter: me, proxy: useProxy || '', producers: useProxy ? [] : producers },
    });
  }
  actions.push({ account: SYSTEM, name: 'claimgbmvote', authorization: auth, data: { owner: me } });
  return { actions, refreshedVote: hasOwn, castNewVote: !hasOwn && !!fallbackProxy, proxy: useProxy };
}

// Put back what actually landed, in the CPU/NET ratio they already run, and pay
// the fee from the same claim. Anything the caller did not measure is not spent:
// `claimed` is a balance difference, never a balance.
export function buildStakeBack({
  claimed, cpuWeight = 1, netWeight = 0,
  account: me = account(), feeBps = 0, feeAccount = '', auth = null,
}) {
  me = signer(me);
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
  me = signer(me);
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
  me = signer(me);
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

// ------------------------------------------------------------- promotion ----
// Buying a promoted slot, as a button rather than as instructions.
//
// Telling someone to assemble `promote:p:alcor:11051` by hand and send tokens
// to an account they typed themselves is how tokens go somewhere irreversible.
// The memo is not a form to fill in; it is an implementation detail of a
// payment the page can just make.
export function buildPromotion({ kind, id, days, terms, me = account(), auth = null }) {
  me = signer(me);
  auth = auth || [{ actor: me, permission: 'active' }];
  const amount = Math.max(0, days) * terms.perDay;
  if (!(amount > 0)) return { actions: [], amount: 0 };
  return {
    actions: [{
      account: terms.contract, name: 'transfer', authorization: auth,
      data: {
        from: me, to: terms.account,
        // Whole tokens: a fractional day buys a fractional slot and reads as a
        // rounding error on the receipt.
        quantity: asset(amount, terms.token, 8),
        memo: `${terms.prefix}:${kind}:${id}`,
      },
    }],
    amount, days,
  };
}

// -------------------------------------------------------------- resources ---
// Powering up with CHEESE rather than with WAX.
//
// cheesepowerz takes CHEESE, burns it to eosio.null, and pays for the system
// powerup out of its own WAX. Read off the chain rather than from an ABI: the
// action a user signs is an ordinary token transfer, and the memo is simply the
// account to power up. Measured over its lifetime, 2,636 CHEESE bought 4,778
// WAX of powerup — about 1.8 WAX per CHEESE — and every one of those CHEESE
// was destroyed, which makes this the largest sink the token has.
const CHEESE_POWERUP = 'cheesepowerz';

export function buildPowerup({ amount, target, token, me = account(), auth = null }) {
  me = signer(me);
  auth = auth || [{ actor: me, permission: 'active' }];
  if (!(amount > 0)) return { actions: [] };
  return {
    actions: [{
      account: token.contract, name: 'transfer', authorization: auth,
      data: {
        from: me, to: CHEESE_POWERUP,
        quantity: asset(amount, token.symbol, token.decimals),
        // The memo is the account that gets the resources, which is usually but
        // not always the sender — powering up a friend is a normal thing to do.
        memo: target || me,
      },
    }],
    amount, target: target || me,
  };
}

// Taking staked WAX back out. Three days in a refund queue before it lands,
// which is the chain's rule and not something a UI can soften — so it is said
// plainly rather than buried.
export function buildUnstake({ cpu = 0, net = 0, me = account(), auth = null }) {
  me = signer(me);
  auth = auth || [{ actor: me, permission: 'active' }];
  if (!(cpu > 0) && !(net > 0)) return { actions: [] };
  return {
    actions: [{
      account: SYSTEM, name: 'undelegatebw', authorization: auth,
      data: {
        from: me, receiver: me,
        unstake_net_quantity: asset(net, 'WAX', WAX_DECIMALS),
        unstake_cpu_quantity: asset(cpu, 'WAX', WAX_DECIMALS),
      },
    }],
    cpu, net, total: cpu + net,
  };
}

// Collect a refund that has matured. The chain releases it automatically in
// most cases, but a stuck one needs asking, and there is no harm in asking.
export function buildRefund({ me = account(), auth = null }) {
  me = signer(me);
  auth = auth || [{ actor: me, permission: 'active' }];
  return { actions: [{ account: SYSTEM, name: 'refund', authorization: auth, data: { owner: me } }] };
}

// Voting, on its own rather than as a side effect of claiming. A proxy and a
// producer list are mutually exclusive on chain: setting one clears the other.
export function buildVote({ proxy = '', producers = [], me = account(), auth = null }) {
  me = signer(me);
  auth = auth || [{ actor: me, permission: 'active' }];
  return {
    actions: [{
      account: SYSTEM, name: 'voteproducer', authorization: auth,
      data: { voter: me, proxy: proxy || '', producers: proxy ? [] : [...producers].sort() },
    }],
  };
}

const CLAIM_MARGIN = 0.995;

// Claim and deposit in a single transaction. No swap, so every number in it is
// known before it is signed.
export function buildOneShot({ pool, position, basket, plan, feeBps = 0, feeAccount = '', me = account(), auth = null }) {
  me = signer(me);
  auth = auth || [{ actor: me, permission: 'active' }];
  const { actions } = buildHarvest({ pool, position, basket, plan, me, auth });
  if (!actions.length) throw new Error('Nothing claimable to harvest.');

  // The recorded floor, not the forecast. A farm reward's live figure
  // extrapolates with the staking weight we read, and a large staker joining
  // after that read makes it too high — 4.91% too high on a farm last written
  // four hours earlier, which no flat margin covers. The floor is what the
  // contract has already booked and cannot go down.
  let depA = (plan.depositFloorA ?? plan.depositAmtA ?? 0) * CLAIM_MARGIN;
  let depB = (plan.depositFloorB ?? plan.depositAmtB ?? 0) * CLAIM_MARGIN;

  const fee = [];
  if (feeAccount && feeBps > 0) {
    const fa = depA * (feeBps / 10000), fb = depB * (feeBps / 10000);
    depA -= fa; depB -= fb;
    for (const [amt, sym, dcm, id] of [[fa, pool.symA, pool.decA, pool.tokenA], [fb, pool.symB, pool.decB, pool.tokenB]]) {
      if (parseFloat(dec(amt, dcm)) <= 0) continue;
      const t = tokenMeta(id);
      fee.push({
        account: t.contract, name: 'transfer', authorization: auth,
        data: { from: me, to: feeAccount, quantity: asset(amt, sym, dcm), memo: 'compound fee' },
      });
    }
  }

  // addliquid spends from an internal balance funded by a transfer with memo
  // "deposit" in the same transaction — and a taxing token delivers less than
  // it sent, so the ask is discounted by the rate a holder was measured paying.
  const net = (amt, id) => amt * (1 - (venueTaxOf(id) / 10000));
  const askA = net(depA, pool.tokenA), askB = net(depB, pool.tokenB);
  if (parseFloat(dec(askA, pool.decA)) <= 0 && parseFloat(dec(askB, pool.decB)) <= 0) {
    throw new Error('Nothing large enough to deposit — the harvest rounds to zero in both tokens.');
  }

  const ta = tokenMeta(pool.tokenA), tb = tokenMeta(pool.tokenB);
  const deposit = [];
  if (parseFloat(dec(depA, pool.decA)) > 0) deposit.push({
    account: ta.contract, name: 'transfer', authorization: auth,
    data: { from: me, to: ALCOR, quantity: asset(depA, pool.symA, pool.decA), memo: 'deposit' },
  });
  if (parseFloat(dec(depB, pool.decB)) > 0) deposit.push({
    account: tb.contract, name: 'transfer', authorization: auth,
    data: { from: me, to: ALCOR, quantity: asset(depB, pool.symB, pool.decB), memo: 'deposit' },
  });

  deposit.push({
    account: ALCOR, name: 'addliquid', authorization: auth,
    data: {
      poolId: Number(pool.id), owner: me,
      tokenADesired: asset(askA, pool.symA, pool.decA),
      tokenBDesired: asset(askB, pool.symB, pool.decB),
      tickLower: position.tickLower, tickUpper: position.tickUpper,
      // Zero, for the same reason buildRedeposit uses zero: addliquid consumes
      // the two sides at the ratio the band requires at the current price, so
      // one side binds and the rest of the other stays in the internal balance.
      // Requiring 99% of BOTH is requiring the deposit to already be at that
      // ratio to the satoshi, which it never is — and Alcor rejects it as
      // "Price slippage check". There is no price to be protected from here:
      // this is adding liquidity, not trading, and the amounts are capped by
      // what was just transferred in.
      tokenAMin: asset(0, pool.symA, pool.decA),
      tokenBMin: asset(0, pool.symB, pool.decB),
      deadline: 0,
    },
  });

  return { actions: [...actions, ...fee, ...deposit], depA, depB, margin: CLAIM_MARGIN };
}

// Claim and convert in a single transaction: the swap spends what the claim
// just delivered. Sized from the plan and shaded down, because the transfer
// executes against whatever actually arrived.
export function buildClaimAndSwap({ pool, position, basket, plan, harvested = null, me = account(), auth = null }) {
  me = signer(me);
  auth = auth || [{ actor: me, permission: 'active' }];
  const { actions } = buildHarvest({ pool, position, basket, plan, me, auth });
  if (!actions.length) throw new Error('Nothing claimable to harvest.');

  // The claim has not run yet, so there is nothing measured to size against —
  // the plan's own figures are all there is, shaded by the same margin.
  const scaled = { ...plan, swaps: plan.swaps.map(x => ({ ...x, usd: x.usd * CLAIM_MARGIN })) };
  const sw = buildSwaps({ pool, plan: scaled, harvested, me, auth });
  return { actions: [...actions, ...sw.actions], swaps: sw.swaps };
}
