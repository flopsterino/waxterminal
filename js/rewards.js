// =============================================================================
// EARNINGS — what a position has ALREADY paid out, as opposed to what it owes.
//
// The terminal could tell you what was waiting to be collected and nothing at
// all about what you had collected. That is the wrong half: uncollected fees
// are a few dollars sitting in a table, while the farm rewards someone has been
// claiming for months are the actual return on the position, and they were
// invisible.
//
// Every payout leaves a transfer, and the memo says which kind it is:
//
//   reward.alcor   "Reward from incentiveId: 4108, positionId: 146954"
//   swap.alcor     "Collected Fee for TokenA - Pool ID #11051 - Position #…"
//   farms.waxdao   "claimed rewards from cheesefarm farm on WaxDAO"
//   pepperstake    a withdraw payout
//
// So four filtered history reads answer it completely — and the Alcor ones
// carry the position id, which means the total can be attributed to the
// position that earned it rather than left as a lump sum.
//
// swap.alcor also sends "Swap tokenOut" on every trade, which is not income and
// is 72% of the transfers from that account. Counting it would report a trading
// day as fee income.
// =============================================================================

import { hyperion } from './chain.js';
import { parseAsset, tokenId } from './math.js';

const SOURCES = [
  { from: 'reward.alcor', kind: 'farm', keep: () => true },
  { from: 'swap.alcor', kind: 'fees', keep: m => /^Collected Fee for Token/i.test(m) },
  { from: 'farms.waxdao', kind: 'waxdao', keep: () => true },
  { from: 'pepperstake', kind: 'pepperstake', keep: () => true },
];

const POS = /positionId:\s*(\d+)|Position #(\d+)/i;
const INC = /incentiveId:\s*(\d+)/i;

// One read per source. `limit=1000` is a full history for any normal account —
// the busiest real one measured had 210 farm payouts — and the page says so
// when it hits the ceiling rather than quietly reporting a truncated total.
export async function earningsHistory(account, { limit = 1000 } = {}) {
  const rows = [];
  const truncated = [];

  await Promise.all(SOURCES.map(async src => {
    let d;
    try {
      d = await hyperion(`/v2/history/get_actions?account=${encodeURIComponent(account)}`
        + `&act.name=transfer&transfer.from=${src.from}&limit=${limit}&sort=desc`);
    } catch { return; }
    const acts = d.actions || [];
    if (acts.length >= limit) truncated.push(src.kind);
    for (const a of acts) {
      const dat = a.act?.data;
      if (!dat || dat.to !== account) continue;
      const memo = String(dat.memo || '');
      if (!src.keep(memo)) continue;
      const q = parseAsset(dat.quantity || '');
      if (!(q.amount > 0)) continue;
      const m = memo.match(POS);
      rows.push({
        kind: src.kind,
        at: new Date(a.timestamp.endsWith('Z') ? a.timestamp : a.timestamp + 'Z').getTime(),
        amount: q.amount,
        symbol: q.symbol,
        tokenId: tokenId(q.symbol, a.act.account),
        posId: m ? (m[1] || m[2]) : null,
        incentiveId: (memo.match(INC) || [])[1] || null,
        trxId: a.trx_id,
      });
    }
  }));

  rows.sort((a, b) => b.at - a.at);
  return { rows, truncated };
}

// Roll a history up into the shapes a page actually draws: per token, per
// source, per position, and a daily series.
//
// Prices are today's. A token claimed at four different prices over six months
// cannot be valued at what it was worth on each day without a price history per
// token, which this terminal does not keep — so the figure is "what the rewards
// you claimed are worth now", which is a different and clearly-labelled
// question from "what they were worth when you claimed them".
export function summariseEarnings(rows, prices) {
  const byToken = new Map();
  const byKind = new Map();
  const byPos = new Map();
  const byDay = new Map();
  let usd = 0, unpriced = 0;

  for (const r of rows) {
    const px = prices.get(r.tokenId)?.usd ?? null;
    const v = px != null ? r.amount * px : null;
    if (v != null) usd += v; else unpriced++;

    const t = byToken.get(r.tokenId) || { tokenId: r.tokenId, symbol: r.symbol, amount: 0, usd: 0, priced: px != null, claims: 0 };
    t.amount += r.amount; t.usd += v || 0; t.claims++;
    byToken.set(r.tokenId, t);

    byKind.set(r.kind, (byKind.get(r.kind) || 0) + (v || 0));

    if (r.posId) {
      const p = byPos.get(r.posId) || { posId: r.posId, usd: 0, claims: 0, fees: 0, farm: 0 };
      p.usd += v || 0; p.claims++;
      if (r.kind === 'fees') p.fees += v || 0; else p.farm += v || 0;
      byPos.set(r.posId, p);
    }

    const day = new Date(r.at).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + (v || 0));
  }

  const first = rows.length ? rows[rows.length - 1].at : null;
  const days = first ? Math.max(1, (Date.now() - first) / 86400e3) : 0;

  return {
    usd, unpriced, claims: rows.length,
    firstAt: first,
    lastAt: rows.length ? rows[0].at : null,
    perDay: days ? usd / days : 0,
    tokens: [...byToken.values()].sort((a, b) => b.usd - a.usd),
    kinds: byKind,
    positions: byPos,
    series: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, v]) => ({ day, usd: v })),
  };
}
