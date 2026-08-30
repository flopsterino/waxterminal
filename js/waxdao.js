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
      // The contract holds what has accrued since the last state change, and
      // the hourly rate on top of it — so what is claimable *now* is the stored
      // balance plus the rate times the time since. Shown separately: one is
      // recorded, the other is arithmetic.
      stored: (r.claimable_balances || []).map(parseQty).filter(Boolean),
      perHour: (r.rates_per_hour || []).map(parseQty).filter(Boolean),
      since: Number(r.last_state_change) * 1000,
    }))
    .filter(s => s.stored.length || s.perHour.length);
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
