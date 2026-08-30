// =============================================================================
// STAKE REWARDS — compounding the other yield on WAX.
//
// Staking WAX for CPU and NET pays a voter reward, and almost nobody collects
// it: it does not arrive on its own, it has a 24-hour cooldown, and the vote
// that earns it decays until you re-cast it. So the WAX sits staked, earning
// something the holder never claims and never restakes.
//
// The flow, read off a real claim rather than guessed:
//
//   eosio::voteproducer   re-cast the SAME proxy or producers, which refreshes
//                         a decaying vote weight — this changes who you vote
//                         for not at all, and is why claims on chain are
//                         almost always paired with it
//   eosio::claimgbmvote   pays out, as eosio.voters → you, memo "voter pay"
//   eosio::delegatebw     put it back into CPU and NET
//
// What cannot be done is predict the payout. It comes from a shared bucket
// divided by a voteshare that updates continuously, and reimplementing that
// arithmetic to show a number before the click would be a guess dressed as a
// figure. So this reports what the last claim actually paid and how long ago —
// and the compound itself measures the balance either side of the claim, the
// same way the LP one does.
// =============================================================================

import { getRows, hyperion } from './chain.js';

export async function stakeInfo(account) {
  const d = await getRows('eosio', 'eosio', 'voters', { limit: 1, lower: account });
  const row = d.rows?.[0];
  const voter = row && row.owner === account ? row : null;

  const staked = voter ? Number(voter.staked) / 1e8 : 0;
  const lastClaim = voter?.last_claim_time ? new Date(voter.last_claim_time + 'Z').getTime() : null;
  const weight = voter ? Number(voter.last_vote_weight) : 0;

  return {
    account,
    staked,
    proxy: voter?.proxy || '',
    producers: voter?.producers || [],
    // You earn only while your vote counts. A weight of zero means the vote has
    // decayed away or was never cast, and a claim would pay nothing.
    voting: !!(voter?.proxy || (voter?.producers || []).length) && weight > 0,
    weight,
    lastClaim,
    // The contract allows one claim a day.
    claimableAt: lastClaim ? lastClaim + 24 * 3600 * 1000 : null,
    exists: !!voter,
  };
}

// What their claims have actually paid. The only honest basis for "is this
// worth clicking", since the payout cannot be computed in advance.
export async function claimHistory(account, { days = 120 } = {}) {
  const after = new Date(Date.now() - days * 86400000).toISOString();
  let d;
  try {
    d = await hyperion(`/v2/history/get_actions?${new URLSearchParams({
      account, 'act.account': 'eosio.token', 'act.name': 'transfer', after, limit: '500', sort: 'desc',
    })}`);
  } catch { return []; }

  const out = [];
  const seen = new Set();
  for (const a of (d.actions || [])) {
    const k = `${a.trx_id}:${a.action_ordinal}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const x = a.act?.data;
    if (!x || x.to !== account) continue;
    if (x.from !== 'eosio.voters' && x.from !== 'eosio') continue;
    if (!/voter pay|genesis/i.test(String(x.memo || ''))) continue;
    const amt = parseFloat(String(x.quantity || '')) || 0;
    if (!(amt > 0)) continue;
    out.push({
      ts: new Date(a.timestamp + (a.timestamp.endsWith('Z') ? '' : 'Z')).getTime(),
      amount: amt, trx: a.trx_id, kind: /genesis/i.test(x.memo) ? 'genesis' : 'voter',
    });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

// An annualised rate from what was actually received, not from a formula: total
// paid over the window, scaled to a year, against what is staked. It is a
// backward-looking number and is labelled as one.
export function observedApr(history, staked) {
  if (!history.length || !(staked > 0)) return null;
  const span = Date.now() - history.at(-1).ts;
  if (span < 7 * 86400000) return null;                 // too short to annualise
  const paid = history.reduce((s, h) => s + h.amount, 0);
  return (paid / staked) * (365 * 86400000 / span) * 100;
}
