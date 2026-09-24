// =============================================================================
// V2 LIQUIDITY — adding to (and taking from) TacoSwap and NeftyBlocks pairs.
//
// Both are constant-product pools: a deposit is the two tokens in the pool's
// current ratio, and the LP tokens you get are your share of what is then in
// it. The two contracts want it asked for differently, read off real deposits:
//
//   TacoSwap     <A>::transfer "deposit" · <B>::transfer "deposit" ·
//                swap.taco::addliquidity(user, to_buy)       to_buy = LP asset
//                swap.taco::remliquidity(user, to_sell)      to take it out
//   NeftyBlocks  <A>::transfer and <B>::transfer, both with the memo
//                "deposit_to_pair:<p,A@c>-<p,B@c>" ·
//                swap.nefty::addliquidity(owner, token0, token1)
//                lp.nefty::transfer to swap.nefty            to take it out
//
// Whatever does not fit the ratio comes straight back in the same transaction
// (both contracts' deposit tables are empty right after real deposits), and
// the second amount is computed from the first in the exact ratio anyway, so
// the remainder is dust. The pair is re-read from the chain for every quote:
// a two-hour-old snapshot is not a ratio to deposit at.
// =============================================================================

import { getRows } from './chain.js';

const TACO = 'swap.taco', NEFTY = 'swap.nefty', NEFTY_LP = 'lp.nefty';

// A symbol code as the uint64 the pair tables are keyed by.
const codeKey = code => {
  let v = 0n;
  for (let i = 0; i < code.length; i++) v |= BigInt(code.charCodeAt(i)) << BigInt(8 * i);
  return v.toString();
};
const parse = q => {
  const [n, sym] = String(q).trim().split(/\s+/);
  return { amount: Number(n), decimals: (n.split('.')[1] || '').length, symbol: sym };
};
const fmt = (amount, decimals, symbol) => `${(Math.floor(amount * 10 ** decimals + 1e-9) / 10 ** decimals).toFixed(decimals)} ${symbol}`;

// The pair as the chain holds it now, in one shape for both venues.
export async function livePair(pool) {
  const code = String(pool.id);
  if (pool.dex === 'taco') {
    const r = (await getRows(TACO, TACO, 'pairs', { lower: codeKey(code), limit: 1 })).rows?.[0];
    if (!r || String(r.id) !== code) throw new Error('This TacoSwap pair is not on the chain any more.');
    const a = parse(r.pool1.quantity), b = parse(r.pool2.quantity), lp = parse(r.supply);
    return { dex: 'taco', code, a: { ...a, contract: r.pool1.contract }, b: { ...b, contract: r.pool2.contract }, supply: lp.amount, lpDecimals: lp.decimals };
  }
  if (pool.dex === 'nefty') {
    const r = (await getRows(NEFTY, NEFTY, 'pairs', { lower: codeKey(code), limit: 1 })).rows?.[0];
    if (!r || String(r.code) !== code) throw new Error('This NeftyBlocks pair is not on the chain any more.');
    const a = parse(r.reserve0.quantity), b = parse(r.reserve1.quantity);
    return { dex: 'nefty', code, a: { ...a, contract: r.reserve0.contract }, b: { ...b, contract: r.reserve1.contract },
      supply: Number(r.total_liquidity) || 0, lpDecimals: 0, active: !!r.active };
  }
  throw new Error('Not a v2 pool.');
}

// Given an amount of one side, the other side and the LP tokens it buys.
// A pool with nothing in it has no ratio: the first deposit sets it, and that
// is not something this panel does on anyone's behalf.
export function quoteV2(pair, side, amount) {
  if (!(pair.a.amount > 0) || !(pair.b.amount > 0) || !(pair.supply > 0)) throw new Error('This pair is empty; its first deposit sets the price, which this page does not do.');
  const amtA = side === 'a' ? amount : amount * pair.a.amount / pair.b.amount;
  const amtB = side === 'b' ? amount : amount * pair.b.amount / pair.a.amount;
  // Rounded down to what each token can carry; the LP count follows the
  // smaller of the two shares, with a hair of room so the contract never
  // has to mint more than it was paid for.
  const a = Math.floor(amtA * 10 ** pair.a.decimals) / 10 ** pair.a.decimals;
  const b = Math.floor(amtB * 10 ** pair.b.decimals) / 10 ** pair.b.decimals;
  const share = Math.min(a / pair.a.amount, b / pair.b.amount);
  const lp = Math.floor(pair.supply * share * 0.9995 * 10 ** pair.lpDecimals) / 10 ** pair.lpDecimals;
  return { a, b, lp, shareAfter: lp / (pair.supply + lp) };
}

export async function buildV2Add({ account, pair, quote, auth = null }) {
  const au = auth || [{ actor: account, permission: 'active' }];
  const qa = fmt(quote.a, pair.a.decimals, pair.a.symbol), qb = fmt(quote.b, pair.b.decimals, pair.b.symbol);
  if (pair.dex === 'taco') {
    const actions = [];
    // A first deposit into a pair needs the LP balance row to exist; opening
    // it is only added when the wallet does not have one yet.
    const has = (await getRows(TACO, account, 'accounts', { lower: codeKey(pair.code), limit: 1 }).catch(() => ({ rows: [] }))).rows?.[0];
    if (!has || !String(has.balance || '').endsWith(` ${pair.code}`)) {
      actions.push({ account: TACO, name: 'open', authorization: au, data: { owner: account, symbol: `${pair.lpDecimals},${pair.code}`, ram_payer: account } });
    }
    actions.push(
      { account: pair.a.contract, name: 'transfer', authorization: au, data: { from: account, to: TACO, quantity: qa, memo: 'deposit' } },
      { account: pair.b.contract, name: 'transfer', authorization: au, data: { from: account, to: TACO, quantity: qb, memo: 'deposit' } },
      { account: TACO, name: 'addliquidity', authorization: au, data: { user: account, to_buy: fmt(quote.lp, pair.lpDecimals, pair.code) } },
    );
    return actions;
  }
  const t0 = { sym: `${pair.a.decimals},${pair.a.symbol}`, contract: pair.a.contract };
  const t1 = { sym: `${pair.b.decimals},${pair.b.symbol}`, contract: pair.b.contract };
  const memo = `deposit_to_pair:${t0.sym}@${t0.contract}-${t1.sym}@${t1.contract}`;
  return [
    { account: pair.a.contract, name: 'transfer', authorization: au, data: { from: account, to: NEFTY, quantity: qa, memo } },
    { account: pair.b.contract, name: 'transfer', authorization: au, data: { from: account, to: NEFTY, quantity: qb, memo } },
    { account: NEFTY, name: 'addliquidity', authorization: au, data: { owner: account, token0: t0, token1: t1 } },
  ];
}

// Taking it out: a share of the LP tokens held.
export function buildV2Remove({ account, dex, code, lp, lpDecimals = 0, auth = null }) {
  const au = auth || [{ actor: account, permission: 'active' }];
  if (dex === 'taco') return [{ account: TACO, name: 'remliquidity', authorization: au, data: { user: account, to_sell: fmt(lp, lpDecimals, code) } }];
  return [{ account: NEFTY_LP, name: 'transfer', authorization: au, data: { from: account, to: NEFTY, quantity: `${Math.floor(lp)} ${code}`, memo: '' } }];
}

// ---- zap: one of the pair's own tokens, straight in -----------------------
// Swap the right part of it in this same pool, then deposit both halves — in
// one transaction, so the pool the deposit meets is exactly the pool the swap
// left behind. The part to swap is the classic single-sided split for a
// constant-product pool with fee f:
//     s = ( sqrt( ((2-f)·R)² + 4(1-f)·R·amount ) − (2-f)·R ) / ( 2(1-f) )
// after which the rest of the token and what the swap returned sit in the
// pool's new ratio. Swap memos, read off real swaps:
//   swap.taco    "<min out>@<contract>"           e.g. "0.00000019 WAX@eosio.token"
//   swap.nefty   "swap:<pair>,min:<raw min out>"  e.g. "swap:BANLFG,min:3673"
// The deposit uses the guaranteed minimum of what the swap returns, so it can
// never ask for more than arrived; anything above that stays in the wallet.
const GUARD = 0.995;   // the swap's floor, and so the deposit's

export function planV2Zap(pair, side, amount, { feeBps = 30, zapFeeBps = 0 } = {}) {
  if (!(pair.a.amount > 0) || !(pair.b.amount > 0) || !(pair.supply > 0)) throw new Error('This pair is empty; there is nothing to zap into.');
  const X = side === 'a' ? pair.a : pair.b, Y = side === 'a' ? pair.b : pair.a;
  const f = feeBps / 10000;
  const fee = Math.floor(amount * zapFeeBps / 10000 * 10 ** X.decimals) / 10 ** X.decimals;
  const amt = amount - fee;
  const R = X.amount;
  let s = (Math.sqrt(((2 - f) * R) ** 2 + 4 * (1 - f) * R * amt) - (2 - f) * R) / (2 * (1 - f));
  s = Math.floor(s * 10 ** X.decimals) / 10 ** X.decimals;
  const out = Y.amount * s * (1 - f) / (R + s * (1 - f));
  const minOut = Math.floor(out * GUARD * 10 ** Y.decimals) / 10 ** Y.decimals;
  if (!(s > 0) || !(minOut > 0)) throw new Error('Too small to split: the swap would return less than one unit.');
  // The pool as the swap leaves it, and the deposit that fits it.
  const rX = R + s, rY = Y.amount - out;
  const needX = minOut * rX / rY;
  const depX = Math.floor(Math.min(amt - s, needX * 1.0005) * 10 ** X.decimals) / 10 ** X.decimals;
  const share = Math.min(depX / rX, minOut / rY);
  const lp = Math.floor(pair.supply * share * 0.9995 * 10 ** pair.lpDecimals) / 10 ** pair.lpDecimals;
  return { side, from: X, to: Y, fee, swap: s, out, minOut, depX, depY: minOut, lp, shareAfter: lp / (pair.supply + lp), leftover: amt - s - depX };
}

export async function buildV2Zap({ account, pair, plan, feeAccount = '', auth = null }) {
  const au = auth || [{ actor: account, permission: 'active' }];
  const X = plan.from, Y = plan.to;
  const actions = [];
  if (feeAccount && plan.fee > 0) {
    actions.push({ account: X.contract, name: 'transfer', authorization: au, data: { from: account, to: feeAccount, quantity: fmt(plan.fee, X.decimals, X.symbol), memo: 'zap fee' } });
  }
  const venue = pair.dex === 'taco' ? TACO : NEFTY;
  const memo = pair.dex === 'taco'
    ? `${fmt(plan.minOut, Y.decimals, Y.symbol)}@${Y.contract}`
    : `swap:${pair.code},min:${Math.floor(plan.minOut * 10 ** Y.decimals)}`;
  actions.push({ account: X.contract, name: 'transfer', authorization: au, data: { from: account, to: venue, quantity: fmt(plan.swap, X.decimals, X.symbol), memo } });
  // The deposit, in the pair's own order.
  const depA = plan.side === 'a' ? plan.depX : plan.depY, depB = plan.side === 'a' ? plan.depY : plan.depX;
  const deposit = await buildV2Add({ account, pair, quote: { a: depA, b: depB, lp: plan.lp }, auth: au });
  return actions.concat(deposit);
}
