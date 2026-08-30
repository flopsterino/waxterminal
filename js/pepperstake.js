// =============================================================================
// PEPPERSTAKE — the second pile of rewards people forget they are owed.
//
// Same shape of problem as the WaxDAO farms: tokens accruing to an account that
// has to go to a third site to collect them, if it remembers at all. Different
// contract, different mechanics.
//
// Claiming here is two actions and they are not interchangeable:
//
//   collect(owner, pool_id, period)   accrues one period into `collected`
//   withdraw(owner, pool_id)          pays `collected` out to the wallet
//
// A pool runs for a fixed number of periods of a fixed length, and each has to
// be collected separately — miss six months and that is a hundred and eighty
// collects before a withdraw pays anything. The user row remembers where it got
// to, so the work is bounded by how long you have been away rather than by the
// life of the pool.
// =============================================================================

import { getRows } from './chain.js';

const CONTRACT = 'pepperstake';

// A pool's config: how long a period is, how many there are, what it pays.
const poolCache = new Map();
async function poolInfo(id) {
  if (poolCache.has(id)) return poolCache.get(id);
  let row = null;
  try {
    const d = await getRows(CONTRACT, CONTRACT, 'pools', { limit: 1, lower: String(id) });
    const r = (d.rows || [])[0];
    if (r && Number(r.id) === Number(id)) row = r;
  } catch {}
  const info = row ? {
    id: Number(row.id),
    reward: parseQty(row.period_reward),
    periods: Number(row.periods_count) || 0,
    periodSec: Number(row.time_per_period_sec) || 0,
    startAt: Number(row.start_at) * 1000,
    unstakeSec: Number(row.unstake_time_sec) || 0,
    display: row.display_data || '',
  } : null;
  poolCache.set(id, info);
  return info;
}

function parseQty(q) {
  const raw = q?.quantity ?? q;
  if (!raw) return null;
  const [amt, sym] = String(raw).split(' ');
  return { amount: parseFloat(amt) || 0, symbol: sym, contract: q?.contract || '', decimals: (amt.split('.')[1] || '').length };
}

export async function pepperStakes(account) {
  let rows = [];
  try {
    const d = await getRows(CONTRACT, account, 'userpools', { limit: 100 });
    rows = d.rows || [];
  } catch { return []; }
  if (!rows.length) return [];

  const out = await Promise.all(rows.map(async r => {
    const pool = await poolInfo(r.pool_id);
    const collected = Number(r.collected) || 0;
    const next = Number(r.next_claim_num) || 0;

    // Which period the pool is in now. Everything from `next` up to here is
    // accrued but uncollected — the reason a withdraw can pay nothing while
    // rewards are plainly owed.
    const now = pool && pool.periodSec > 0
      ? Math.min(pool.periods, Math.floor((Date.now() - pool.startAt) / (pool.periodSec * 1000)))
      : 0;
    const behind = Math.max(0, now - next + 1);

    return {
      poolId: Number(r.pool_id), pool,
      collected,
      stakedTokens: Number(r.staked_tokens) || 0,
      stakedAssets: Number(r.staked_assets_power) || 0,
      nextPeriod: next,
      currentPeriod: now,
      // Uncollected periods, capped: a hundred and eighty collect actions is not
      // one transaction, and pretending otherwise builds one that fails.
      behind: Math.min(behind, 60),
      behindTotal: behind,
    };
  }));

  return out.filter(s => s.collected > 0 || s.behind > 0 || s.stakedTokens > 0 || s.stakedAssets > 0);
}

// Collect the periods that are owed, then take the lot out. Bounded, because a
// transaction has a CPU limit and a long absence would blow through it.
export function buildPepperClaim({ account, stake, maxPeriods = 40, auth = null }) {
  auth = auth || [{ actor: account, permission: 'active' }];
  const actions = [];
  const n = Math.min(stake.behind, maxPeriods);
  for (let i = 0; i < n; i++) {
    actions.push({
      account: CONTRACT, name: 'collect', authorization: auth,
      data: { owner: account, pool_id: Number(stake.poolId), period: stake.nextPeriod + i },
    });
  }
  // Withdraw is worth doing even with nothing newly collected: an earlier visit
  // may have collected and never taken it out.
  actions.push({
    account: CONTRACT, name: 'withdraw', authorization: auth,
    data: { owner: account, pool_id: Number(stake.poolId) },
  });
  return { actions, collected: n, remaining: Math.max(0, stake.behindTotal - n) };
}
