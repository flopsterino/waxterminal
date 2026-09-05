// =============================================================================
// ACCOUNT — everything one WAX account holds, in one request.
//
// light-api's /account endpoint returns every token balance, the staked
// resources, the permissions and whether the account carries code, all at once.
// Reading the same thing off a node would be one get_currency_balance per
// contract, and a busy account has been airdropped a thousand of them.
//
// Which is also the problem this page has to solve rather than reproduce: of
// 1,102 balances on a real account, the overwhelming majority are zero, and
// most of the rest are unsolicited tokens with no market. A list of a thousand
// rows is not "everything you hold", it is a haystack. So the page leads with
// what can actually be valued and says plainly how much it is not showing.
// =============================================================================

const LIGHT = 'https://wax.light-api.net/api';

export async function accountInfo(account) {
  const r = await fetch(`${LIGHT}/account/wax/${encodeURIComponent(account)}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`account ${r.status}`);
  const d = await r.json();

  const balances = (d.balances || [])
    .map(b => ({
      contract: b.contract,
      symbol: b.currency,
      decimals: Number(b.decimals) || 0,
      amount: Number(b.amount) || 0,
      id: `${b.currency}@${b.contract}`,
    }))
    .filter(b => b.amount > 0);

  return {
    account,
    balances,
    zeroed: (d.balances || []).length - balances.length,
    resources: d.resources || null,
    // An account carrying code holds tokens for other people as often as not,
    // which changes what a big balance means.
    isContract: !!d.code?.code_hash && d.code.code_hash !== '0000000000000000000000000000000000000000000000000000000000000000',
    permissions: d.permissions || [],
    delegatedFrom: d.delegated_from || [],
  };
}

// Value what can be valued, and be explicit about the rest. Pricing an
// airdropped token at zero and pricing it at "unknown" look identical in a
// total; only one of them is honest.
export function valueBalances(balances, prices, depth) {
  let priced = 0, unpriced = 0;
  const rows = balances.map(b => {
    const px = prices.get(b.id)?.usd ?? null;
    const d = depth?.get(b.id);
    // Realisable, on the same basis as everything else here: a balance is worth
    // what a route to a bridged dollar could actually carry out of it.
    const usd = px != null ? b.amount * px : null;
    const real = usd != null ? usd * (d?.ratio ?? 0) : null;
    if (usd != null) priced += usd; else unpriced++;
    return { ...b, price: px, usd, real, ratio: d?.ratio ?? 0 };
  });
  rows.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  return { rows, priced, unpriced, realisable: rows.reduce((s, r) => s + (r.real ?? 0), 0) };
}

// What this account has been trading, and through which pools.
//
// Not from logswap: that action is authorised by the contract, so Hyperion
// indexes it under swap.alcor rather than under the trader, and asking for one
// account's swaps that way returns the whole chain's. The transfer that starts
// the swap *is* signed by the trader, and its memo names every pool the route
// will cross — so the same feed that answers "what did they send" also answers
// "where did it go".
export async function accountSwaps(account, { hours = 168, maxPages = 3 } = {}) {
  const { hyperion, dropEchoes } = await import('./chain.js');
  const after = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    let d;
    try {
      d = await hyperion(`/v2/history/get_actions?${new URLSearchParams({
        account, 'act.name': 'transfer', after, limit: '1000', skip: String(page * 1000), sort: 'desc',
      })}`);
    } catch { break; }
    const got = d.actions || [];
    rows.push(...got);
    if (got.length < 1000) break;
  }

  const VENUES = new Set(['swap.alcor', 'swap.taco', 'swap.box', 'swap.adex']);
  const out = [];
  for (const a of dropEchoes(rows)) {
    const x = a.act?.data;
    if (!x) continue;
    // Both directions. What someone SENT a venue is what they sold; what the
    // venue sent BACK is what they bought. Reading only the outgoing leg — which
    // is all this did — can tell you somebody traded and never what they ended
    // up holding, so it cannot answer whether they are accumulating a token or
    // getting out of it.
    const sending = x.from === account && VENUES.has(x.to);
    const receiving = x.to === account && VENUES.has(x.from);
    if (!sending && !receiving) continue;
    const memo = String(x.memo || '');
    const route = memo.toLowerCase().startsWith('swapexactin#')
      ? memo.split('#')[1]?.split(',').filter(Boolean) ?? null : null;
    // The outgoing leg carries the route in its memo; the leg coming back is
    // the venue paying out and carries none, so a missing route disqualifies
    // only the side that should have had one.
    if (sending && !route) continue;         // a deposit or a fee, not a trade
    const [amt, sym] = String(x.quantity || '').split(' ');
    out.push({
      ts: new Date(a.timestamp + (a.timestamp.endsWith('Z') ? '' : 'Z')).getTime(),
      trx: a.trx_id, venue: sending ? x.to : x.from, route,
      side: sending ? 'sold' : 'bought',
      amount: parseFloat(amt) || 0, symbol: sym, contract: a.act.account,
    });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}


// What an account has been accumulating and what it has been getting out of.
//
// Per token: what they sold into a venue, what a venue paid them, and the
// difference. A trader who is round-tripping nets to roughly nothing; one who
// is dumping shows a large negative; one who is buying shows the opposite. It
// is the question "what is this wallet actually doing" reduced to a column of
// numbers.
export function tradeFlow(swaps, prices) {
  const by = new Map();
  for (const s of swaps) {
    const id = `${s.symbol}@${s.contract}`;
    let r = by.get(id);
    if (!r) { r = { id, symbol: s.symbol, contract: s.contract, bought: 0, sold: 0, trades: 0, last: 0 }; by.set(id, r); }
    if (s.side === 'bought') r.bought += s.amount; else r.sold += s.amount;
    r.trades++;
    if (s.ts > r.last) r.last = s.ts;
  }
  const out = [];
  for (const r of by.values()) {
    const px = prices?.get(r.id)?.usd ?? null;
    const net = r.bought - r.sold;
    out.push({
      ...r, net, priced: px != null,
      netUsd: px != null ? net * px : null,
      turnoverUsd: px != null ? (r.bought + r.sold) * px : null,
    });
  }
  // Biggest movement first, priced where we can and by token amount where we
  // cannot — a wallet's largest position change is the thing worth seeing.
  out.sort((a, b) => Math.abs(b.netUsd ?? 0) - Math.abs(a.netUsd ?? 0) || Math.abs(b.net) - Math.abs(a.net));
  return out;
}

// The trades themselves, newest first.
//
// accountSwaps returns transfer LEGS: one row for what went to the venue and
// one for what came back. A person does not think in legs — they think "I sold
// 400 CHEESE and got 1.2 WAX" — and those two rows share a transaction id, so
// pairing on it turns a feed of movements back into a list of trades.
//
// A route can pay out in more than one leg when the venue splits it, so both
// sides are lists rather than single values.
export function tradeList(swaps, { limit = 60 } = {}) {
  const byTrx = new Map();
  for (const s of swaps) {
    let t = byTrx.get(s.trx);
    if (!t) { t = { trx: s.trx, ts: s.ts, venue: s.venue, sold: [], bought: [], route: null }; byTrx.set(s.trx, t); }
    if (s.ts < t.ts) t.ts = s.ts;
    if (s.side === 'sold') { t.sold.push(s); if (s.route) t.route = s.route; }
    else t.bought.push(s);
  }
  return [...byTrx.values()]
    // A leg with no counterpart is a deposit or a payout we could not pair —
    // real, but not a trade, and showing it as one would invent a direction.
    .filter(t => t.sold.length && t.bought.length)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}
