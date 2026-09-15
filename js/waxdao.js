// =============================================================================
// WAXDAO FARMS — the rewards people forget they are owed.
//
// farms.waxdao pays token rewards for staked NFTs. This terminal does not
// manage the NFTs, and is not going to: they are a different kind of asset with
// a different set of ways to lose them. But the *rewards* are plain tokens
// accruing to an account that usually has to go and look for them on a third
// site, so they belong on a page that already asks "what are you owed".
//
// The stakers table is keyed by an integer id and scoped to the contract, so
// finding one user's rows looks impossible — until you notice secondary index
// 3 is the user name. One query instead of a scan of every staker on WAX.
// =============================================================================

import { getRows } from './chain.js';

const CONTRACT = 'farms.waxdao';

// Every farm the contract runs, so they can be browsed rather than only
// claimed. 135 rows in one read, 21 of them still paying.
let farmCache = null, farmAt = 0;
export async function waxdaoFarms({ maxAgeMs = 5 * 60 * 1000 } = {}) {
  if (farmCache && Date.now() - farmAt < maxAgeMs) return farmCache;
  let rows = [];
  try {
    const d = await getRows(CONTRACT, CONTRACT, 'farms', { limit: 400 });
    rows = d.rows || [];
  } catch { return farmCache || []; }
  farmCache = rows.map(r => {
    const rewards = (r.reward_pools || []).map(x => {
      const hourly = parseQty(x.total_hourly_reward);
      const funds = parseQty(x.total_funds);
      if (!hourly) return null;
      return {
        symbol: hourly.symbol, contract: x.contract, perHour: hourly.amount,
        perDay: hourly.amount * 24, funds: funds ? funds.amount : 0,
        // What is left in the pot at the rate it pays, which is the only honest
        // end date: expiration says when it may stop, funding says when it must.
        daysLeft: hourly.amount > 0 && funds ? funds.amount / (hourly.amount * 24) : null,
      };
    }).filter(Boolean);
    return {
      id: Number(r.id), name: r.farmname, creator: r.creator,
      type: Number(r.farm_type) || 0,
      collections: r.collections || [],
      staked: Number(r.total_staked) || 0,
      createdAt: Number(r.time_created) * 1000,
      endsAt: Number(r.expiration) * 1000,
      status: Number(r.status) || 0,
      rewards,
      avatar: r.profile?.avatar || '', description: r.profile?.description || '',
      socials: r.socials || {},
    };
  });
  farmAt = Date.now();
  return farmCache;
}

export async function waxdaoStakes(account) {
  let rows = [];
  try {
    const d = await getRows(CONTRACT, CONTRACT, 'stakers', {
      limit: 100, lower: account, upper: account, indexPosition: 3, keyType: 'name',
    });
    rows = d.rows || [];
  } catch { return []; }

  return rows
    .filter(r => r.user === account)
    .map(r => ({
      farm: r.farmname,
      assets: (r.asset_ids || []).length,
      // The ids themselves, because taking NFTs back out names them.
      assetIds: (r.asset_ids || []).map(String),
      // The contract holds what has accrued since the last state change, and
      // the hourly rate on top of it — so what is claimable *now* is the stored
      // balance plus the rate times the time since. Shown separately: one is
      // recorded, the other is arithmetic.
      stored: (r.claimable_balances || []).map(parseQty).filter(Boolean),
      perHour: (r.rates_per_hour || []).map(parseQty).filter(Boolean),
      since: Number(r.last_state_change) * 1000,
    }))
    // Everything staked, not only what is still paying: a farm that has run out
    // still holds the NFTs, and taking them back is the whole reason to look.
    .filter(s => s.stored.length || s.perHour.length || s.assets > 0);
}

export function buildWaxdaoUnstake({ account, farm, assetIds, auth = null }) {
  auth = auth || [{ actor: account, permission: 'active' }];
  return [{
    account: CONTRACT, name: 'unstake', authorization: auth,
    data: { user: account, farmname: farm, asset_ids: assetIds.map(String) },
  }];
}

function parseQty(q) {
  const raw = q?.quantity ?? q;
  if (!raw) return null;
  const [amt, sym] = String(raw).split(' ');
  const amount = parseFloat(amt);
  if (!isFinite(amount)) return null;
  return { amount, symbol: sym, contract: q?.contract || '', decimals: (amt.split('.')[1] || '').length };
}

// Stored plus accrued, per token. The estimate is only as good as the clock, so
// callers show it as an estimate and the claim itself pays whatever it pays.
export function claimableNow(stake, now = Date.now()) {
  const hours = Math.max(0, (now - stake.since) / 3600000);
  const out = new Map();
  for (const s of stake.stored) out.set(s.symbol, { ...s });
  for (const r of stake.perHour) {
    const cur = out.get(r.symbol) || { ...r, amount: 0 };
    out.set(r.symbol, { ...cur, amount: cur.amount + r.amount * hours });
  }
  return [...out.values()].filter(x => x.amount > 0);
}

// One action per farm. Claiming is free here — the fee is for compounding, and
// collecting your own money is not a service anyone should be charged for.
export function buildWaxdaoClaims({ account, farms, auth = null }) {
  auth = auth || [{ actor: account, permission: 'active' }];
  return farms.map(farm => ({
    account: CONTRACT, name: 'claim', authorization: auth,
    data: { user: account, farmname: farm },
  }));
}
