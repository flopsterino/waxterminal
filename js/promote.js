// =============================================================================
// PROMOTED POOLS — a paid slot whose receipt is on chain.
//
// A creator sends the configured token to the configured account with the pool
// in the memo, and the terminal reads those transfers and shows the ones whose
// paid window still covers now. That is the whole mechanism.
//
// It is deliberately not a list in theme.json. A static list needs the operator
// to edit and redeploy for every sale, cannot expire on its own, and asks the
// reader to trust that what they are seeing was actually paid for. A transfer
// is self-serve, expires by arithmetic, and anyone can check it — the ledger is
// the chain, and the terminal is only reading it back.
//
// Two rules this must never break:
//
//   1. Paid placement is labelled as paid, every time, with the amount and the
//      date it runs out. An analytics terminal that sells unmarked placement is
//      no longer an analytics terminal.
//   2. Promotion never touches a ranking, a filter, a total or an average. It
//      is its own section. Money buys a slot on the page, never a position in a
//      list of what is actually the biggest or the best paying.
//
// Sending to eosio.null makes it a burn rather than revenue, which is a choice
// the operator makes by what they put in `promotion.account`.
// =============================================================================

import { hyperion } from './chain.js';

let cfg = null;

export function configurePromotion(commercial) {
  const p = commercial?.promotion;
  cfg = (p?.enabled && p.account && p.token?.symbol && p.token?.contract && p.ratePerDay > 0) ? p : null;
  return cfg;
}

export const promotionConfigured = () => !!cfg;
export const promotionTerms = () => cfg
  ? { token: cfg.token.symbol, contract: cfg.token.contract, account: cfg.account, perDay: cfg.ratePerDay, slots: cfg.slots ?? 3, prefix: cfg.memoPrefix || 'promote' }
  : null;

// What a creator has to send, spelled out. Guessing a memo format is not a
// thing to ask of someone about to send real tokens.
export function promotionMemo(kind, id) {
  if (!cfg) return null;
  return `${cfg.memoPrefix || 'promote'}:${kind}:${id}`;
}

// Payments are read over a window long enough to cover the longest run anyone
// could still have live. A payment older than that has expired by definition,
// so there is nothing to gain by reading further back.
const LOOKBACK_DAYS = 120;

export async function activePromotions({ now = Date.now() } = {}) {
  if (!cfg) return [];
  const prefix = `${cfg.memoPrefix || 'promote'}:`;
  const after = new Date(now - LOOKBACK_DAYS * 86400000).toISOString();

  const rows = [];
  for (let page = 0; page < 4; page++) {
    let d;
    try {
      d = await hyperion(`/v2/history/get_actions?${new URLSearchParams({
        'act.account': cfg.token.contract, 'act.name': 'transfer', after,
        limit: '1000', skip: String(page * 1000), sort: 'desc',
      })}`);
    } catch { break; }
    const got = d.actions || [];
    rows.push(...got);
    if (got.length < 1000) break;
  }

  const seen = new Set();
  const out = [];
  for (const a of rows) {
    const key = `${a.trx_id}:${a.action_ordinal}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const x = a.act?.data;
    if (!x || x.to !== cfg.account) continue;
    // Case-insensitive on the prefix, case-preserving on the rest: a token id is
    // SYMBOL@contract and lowercasing it turned HOLE@hole.cheese into something
    // that matches no token at all.
    const memo = String(x.memo || '').trim();
    if (!memo.toLowerCase().startsWith(prefix)) continue;

    const [amtStr, sym] = String(x.quantity || '').split(' ');
    if (sym !== cfg.token.symbol) continue;
    const paid = parseFloat(amtStr) || 0;
    if (!(paid > 0)) continue;

    // memo: "promote:<kind>:<id>" — kind is 'p' for a pool, 't' for a token,
    // and an id containing colons (alcor:11051) survives because only the
    // first two segments are consumed.
    const rest = memo.slice(prefix.length).split(':');
    const kind = (rest.shift() || '').toLowerCase();
    const id = rest.join(':').trim();
    if (!id || (kind !== 'p' && kind !== 't')) continue;

    const at = new Date(a.timestamp + (a.timestamp.endsWith('Z') ? '' : 'Z')).getTime();
    out.push({ kind, id, paid, at, days: paid / cfg.ratePerDay, from: x.from, trx: a.trx_id });
  }

  // Payments queue rather than overlap. Two payments of one day made an hour
  // apart are two days of promotion, not one: each starts where the run
  // currently ends, or at its own timestamp if the run had already lapsed. The
  // first version took the later of the two end dates, which quietly ate the
  // second payment of anyone who topped up early.
  out.sort((a, b) => a.at - b.at);
  const merged = new Map();
  for (const p of out) {
    const k = `${p.kind}:${p.id}`;
    const r = merged.get(k) || { kind: p.kind, id: p.id, paid: 0, payments: 0, at: p.at, until: 0, from: p.from, trx: p.trx };
    const start = Math.max(p.at, r.until);
    r.until = start + p.days * 86400000;
    r.paid += p.paid;
    r.payments++;
    merged.set(k, r);
  }
  for (const [k, r] of merged) if (r.until <= now) merged.delete(k);   // run has lapsed

  // Ordered by what is still owed to the payer — time remaining — so a slot
  // that runs out tomorrow does not sit above one paid through next month.
  return [...merged.values()]
    .sort((a, b) => b.until - a.until)
    .slice(0, cfg.slots ?? 3);
}
