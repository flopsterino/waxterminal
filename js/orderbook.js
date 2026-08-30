// =============================================================================
// ORDER BOOK — the half of Alcor this terminal was ignoring.
//
// alcordexmain is a real limit order book, and a busy one: ten thousand actions
// in thirty days, fills landing minutes apart. Showing only AMM pools and
// calling that "the market" leaves out every resting bid and every seller
// waiting above the pool price — which on a thin token is most of the market.
//
// Placing an order is a token transfer whose memo names what you want back:
//
//   send 1.5 WAX,  memo "299.9994 ZOTIC@exzoticfarms"  → a bid for ZOTIC
//   send 0.15 INDEX, memo "0.322725 WAX@eosio.token"   → an ask, priced in WAX
//
// So there is no place-order action to get wrong; there is a transfer, and the
// price is whatever ratio those two numbers describe. Cancelling is an action,
// and it needs the market id as well as the order id.
// =============================================================================

import { getRows, getAllRows } from './chain.js';

const DEX = 'alcordexmain';

// Every market, cached for the session: 970 rows across one paged read, and
// they change about as often as new tokens list.
let marketCache = null;
export async function markets() {
  if (marketCache) return marketCache;
  const rows = await getAllRows(DEX, DEX, 'markets');
  marketCache = rows.map(m => ({
    id: Number(m.id),
    base: parseSym(m.base_token), quote: parseSym(m.quote_token),
    minBuy: parseFloat(m.min_buy) || 0, minSell: parseFloat(m.min_sell) || 0,
    frozen: !!m.frozen, feeBps: Number(m.fee) || 0,
  }));
  return marketCache;
}

function parseSym(t) {
  const [decimals, symbol] = String(t?.sym || ',').split(',');
  return { symbol, decimals: Number(decimals) || 0, contract: t?.contract || '', id: `${symbol}@${t?.contract || ''}` };
}

// The market for a pair, either way round — a book is one market whichever side
// you happen to be looking from.
export async function marketFor(tokenA, tokenB) {
  const all = await markets();
  return all.find(m => (m.base.id === tokenA && m.quote.id === tokenB) || (m.base.id === tokenB && m.quote.id === tokenA)) || null;
}

// Bids and asks for one market, scoped by its id.
//
// unit_price is an integer in the contract's own fixed point, and rather than
// reverse-engineer its exponent the price is taken from the two quantities the
// order actually names. They are the numbers the order will fill at.
export async function book(marketId, { limit = 60 } = {}) {
  const [buys, sells] = await Promise.all([
    getRows(DEX, String(marketId), 'buyorder', { limit }).then(r => r.rows || []).catch(() => []),
    getRows(DEX, String(marketId), 'sellorder', { limit }).then(r => r.rows || []).catch(() => []),
  ]);

  const bid = buys.map(o => {
    const give = parseFloat(o.bid) || 0;      // WAX offered
    const want = parseFloat(o.ask) || 0;      // token wanted
    return { id: Number(o.id), account: o.account, side: 'buy', base: give, quote: want,
      price: want > 0 ? give / want : 0, at: Number(o.timestamp) * 1000 };
  }).filter(o => o.price > 0).sort((a, b) => b.price - a.price);

  const ask = sells.map(o => {
    const give = parseFloat(o.bid) || 0;      // token offered
    const want = parseFloat(o.ask) || 0;      // WAX wanted
    return { id: Number(o.id), account: o.account, side: 'sell', base: want, quote: give,
      price: give > 0 ? want / give : 0, at: Number(o.timestamp) * 1000 };
  }).filter(o => o.price > 0).sort((a, b) => a.price - b.price);

  return {
    bid, ask,
    best: { bid: bid[0]?.price ?? null, ask: ask[0]?.price ?? null },
    // The gap between the best bid and the best ask, as a fraction of the mid.
    // A book with one side empty has no spread rather than an infinite one.
    spread: (bid[0] && ask[0]) ? (ask[0].price - bid[0].price) / ((ask[0].price + bid[0].price) / 2) : null,
  };
}

// Every open order belonging to one account, across the markets it might be in.
// The tables are scoped per market with no owner index, so this asks only about
// markets the caller already has a reason to care about.
export async function ordersOf(account, marketIds) {
  const out = [];
  await Promise.all(marketIds.map(async id => {
    const b = await book(id, { limit: 200 }).catch(() => null);
    if (!b) return;
    for (const o of [...b.bid, ...b.ask]) if (o.account === account) out.push({ ...o, marketId: id });
  }));
  return out.sort((a, b) => b.at - a.at);
}
