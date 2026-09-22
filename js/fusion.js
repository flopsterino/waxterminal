// =============================================================================
// WAXFUSION — liquid staking that outlived its own website.
//
// waxfusion.io answers HTTP 400. The contract behind it does not care: 3.1
// million sWAX is still earning, 2.2 million LSWAX is still trading, and the
// people holding it have no way to claim, compound, or get out — which is the
// worst of the three, because getting out is on a clock.
//
// The shape of it, read off the contract and its own history rather than any
// documentation:
//
//   stake        WAX to dapp.fusion, memo "stake" — you get sWAX 1:1
//   liquify      sWAX to LSWAX, which is sWAX that compounds instead of paying
//   unliquify    LSWAX back to dapp.fusion, memo "unliquify" (or
//                |unliquify_exact|<minimum>| when you want a floor)
//   claim        claimrewards (WAX), claimswax (restake it), claimaslswax
//   redeem       reqredeem books a place in an epoch; redeem takes the WAX out
//                during that epoch's 48-hour window; instaredeem skips the
//                queue for the protocol's fee
//
// Epochs run a week apart, each renting CPU for a fortnight, and a redemption
// window opens 14 days after an epoch starts and closes two days later. Miss
// it and you wait for the next one — which is exactly the sort of thing a dead
// front end turns into lost money.
//
// The keeper actions (compound, createfarms, stakeallcpu, claimrefunds,
// updatetop21) are permissionless: the history shows strangers calling them,
// and the protocol depends on somebody doing it.
// =============================================================================

import { getRows, balanceOf } from './chain.js';

export const FUSION = 'dapp.fusion';
export const SWAX = { symbol: 'SWAX', decimals: 8 };
export const LSWAX = { symbol: 'LSWAX', contract: 'token.fusion', decimals: 8 };
const WAX = { symbol: 'WAX', contract: 'eosio.token', decimals: 8 };

const amt = q => parseFloat(String(q || '').split(' ')[0]) || 0;
const asset = (v, decimals, symbol) => `${(Math.floor(Number(v) * 10 ** decimals) / 10 ** decimals).toFixed(decimals)} ${symbol}`;

// Everything the protocol says about itself, in three reads.
export async function fusionState({ now = Date.now() } = {}) {
  const [g, r, g2, top] = await Promise.all([
    getRows(FUSION, FUSION, 'global', { limit: 1 }).then(d => d.rows?.[0]).catch(() => null),
    getRows(FUSION, FUSION, 'rewards', { limit: 1 }).then(d => d.rows?.[0]).catch(() => null),
    getRows(FUSION, FUSION, 'global2', { limit: 1 }).then(d => d.rows?.[0]).catch(() => null),
    getRows(FUSION, FUSION, 'top21', { limit: 1 }).then(d => d.rows?.[0]).catch(() => null),
  ]);
  if (!g) throw new Error('dapp.fusion did not answer');
  const startedAt = Number(g.last_epoch_start_time) || 0;
  // The last few epochs, which is where the open window is if there is one.
  const epochs = await getRows(FUSION, FUSION, 'epochs', {
    limit: 6, lower: String(Math.max(0, startedAt - Number(g.cpu_rental_epoch_length_seconds || 0) * 3)),
  }).then(d => (d.rows || []).map(e => ({
    id: Number(e.start_time),
    startsAt: Number(e.start_time) * 1000,
    unstakeAt: Number(e.time_to_unstake) * 1000,
    cpuWallet: e.cpu_wallet,
    bucket: amt(e.wax_bucket), toRefund: amt(e.wax_to_refund),
    returned: amt(e.total_cpu_funds_returned), added: amt(e.total_added_to_redemption_bucket),
    windowFrom: Number(e.redemption_period_start_time) * 1000,
    windowTo: Number(e.redemption_period_end_time) * 1000,
  }))).catch(() => []);

  const openEpoch = epochs.find(e => e.windowFrom <= now && now < e.windowTo) || null;
  const nextEpoch = epochs.filter(e => e.windowFrom > now).sort((a, b) => a.windowFrom - b.windowFrom)[0] || null;

  // Synthetix-shaped reward accounting: a rate per second against the staked
  // total. Both sides are in the same 1e-8 units, so the scaling cancels and
  // only the rate's own 1e6 has to come off.
  const rate = r ? Number(r.rewardRate) / 1e6 : 0;
  const supply = r ? Number(r.totalSupply) : 0;
  const aprPct = supply > 0 ? (rate * 31536000 / supply) * 100 : null;

  const backing = amt(g.swax_currently_backing_lswax);
  const liquified = amt(g.liquified_swax);
  return {
    earning: amt(g.swax_currently_earning),
    backing, liquified,
    // What one LSWAX is worth in sWAX. It only goes up: rewards on the sWAX
    // behind it are compounded rather than paid out.
    lswaxInSwax: liquified > 0 ? backing / liquified : 1,
    staked: amt(g.swax_currently_earning) + backing,
    revenueDistributed: amt(g.total_revenue_distributed),
    rewardsClaimed: amt(g.total_rewards_claimed),
    pendingRevenue: amt(g.revenue_awaiting_distribution),
    forRedemption: amt(g.wax_for_redemption),
    availableForRentals: amt(g.wax_available_for_rentals),
    rentPricePerWax: amt(g.cost_to_rent_1_wax),
    cpuContract: g.current_cpu_contract,
    minStake: amt(g.minimum_stake_amount),
    minUnliquify: amt(g.minimum_unliquify_amount),
    // Every _1e6 field here is a percentage scaled by a million, the fee
    // included: 50000 is 0.05%, not 5%. Measured on chain rather than argued
    // about — 12.77369541 sWAX instantly redeemed returned 12.76730857 WAX,
    // which is five hundredths of a percent.
    feePct: (Number(g.protocol_fee_1e6) || 0) / 1e6,
    shares: {
      user: (Number(g.user_share_1e6) || 0) / 1e6,
      pol: (Number(g.pol_share_1e6) || 0) / 1e6,
      ecosystem: (Number(g.ecosystem_share_1e6) || 0) / 1e6,
    },
    lastCompoundAt: Number(g.last_compound_time) * 1000,
    lastIncentiveAt: Number(g.last_incentive_distribution) * 1000,
    nextStakeAllAt: Number(g.next_stakeall_time) * 1000,
    incentivesBucket: amt(g.incentives_bucket),
    epochSeconds: Number(g.seconds_between_epochs),
    rentalSeconds: Number(g.cpu_rental_epoch_length_seconds),
    windowSeconds: Number(g.redemption_period_length_seconds),
    aprPct, aprCapPct: g2 ? (Number(g2.max_staker_apr_1e6) || 0) / 1e6 : null,
    paused: !!g2?.panic,
    epochs, openEpoch, nextEpoch,
    rewardPool: r ? amt(r.rewardPool) : null,
    top21At: top ? Number(top.last_update) * 1000 : null,
    producers: (top?.block_producers || []).length,
    // Refunds the CPU contracts owe back: an epoch whose unstaking has
    // finished but whose WAX has not been collected.
    refundable: epochs.filter(e => e.toRefund > 0 && e.unstakeAt <= now).reduce((s2, e) => s2 + e.toRefund, 0),
  };
}

// When each of the housekeeping actions last ran. The contract records some of
// them itself; the rest are one read of its own history, which is cheap enough
// once and cached for the session.
let runCache = null;
export async function fusionKeeperRuns({ maxAgeMs = 5 * 60 * 1000 } = {}) {
  if (runCache && Date.now() - runCache.at < maxAgeMs) return runCache.map;
  const map = new Map();
  const { hyperion } = await import('./chain.js');
  // One query per action would be six; this one read covers the actions the
  // contract does not timestamp itself, which in practice is claimrefunds.
  try {
    const d = await hyperion(`/v2/history/get_actions?account=${FUSION}&act.name=claimrefunds&limit=1&sort=desc`);
    const a = d.actions?.[0];
    if (a) map.set('claimrefunds', { at: Date.parse(a.timestamp + (String(a.timestamp).endsWith('Z') ? '' : 'Z')), by: a.act?.authorization?.[0]?.actor || null });
  } catch { /* a missing timestamp is not worth failing the page over */ }
  runCache = { at: Date.now(), map };
  return map;
}

// One account's side of it.
export async function fusionUser(account) {
  if (!account) return null;
  const [row, reqs, lswax, wax] = await Promise.all([
    getRows(FUSION, FUSION, 'stakers', { limit: 1, lower: account }).then(d => {
      const x = d.rows?.[0];
      return x && x.wallet === account ? x : null;
    }).catch(() => null),
    getRows(FUSION, account, 'rdmrequests', { limit: 20 }).then(d => d.rows || []).catch(() => []),
    balanceOf(account, LSWAX.contract, LSWAX.symbol).catch(() => 0),
    balanceOf(account, WAX.contract, WAX.symbol).catch(() => 0),
  ]);
  return {
    account,
    swax: row ? amt(row.swax_balance) : 0,
    claimable: row ? amt(row.claimable_wax) : 0,
    lastUpdate: row ? Number(row.last_update) * 1000 : null,
    lswax, wax,
    requests: reqs.map(r => ({ epochId: Number(r.epoch_id), amount: amt(r.wax_amount_requested) })),
  };
}

const auth1 = (account, auth) => auth || [{ actor: account, permission: 'active' }];

// WAX in. The contract mints sWAX one for one and starts it earning.
export const buildFusionStake = ({ account, wax, auth = null }) => [{
  account: WAX.contract, name: 'transfer', authorization: auth1(account, auth),
  data: { from: account, to: FUSION, quantity: asset(wax, 8, 'WAX'), memo: 'stake' },
}];

// sWAX that pays you, into LSWAX that compounds instead.
export const buildFusionLiquify = ({ account, swax, auth = null }) => [{
  account: FUSION, name: 'liquify', authorization: auth1(account, auth),
  data: { user: account, quantity: asset(swax, 8, 'SWAX') },
}];

// And back. A minimum turns it into the exact variant, which refuses rather
// than filling at a worse rate than you accepted.
export function buildFusionUnliquify({ account, lswax, minSwax = null, auth = null }) {
  // The exact variant carries its minimum as raw units, not as an asset
  // string: a real one reads |unliquify_exact|1277369541| for 12.77369541
  // sWAX. Written any other way the contract has nothing to parse.
  const floor = minSwax != null ? Math.floor(Number(minSwax) * 1e8) : null;
  const memo = floor > 0 ? `|unliquify_exact|${floor}|` : 'unliquify';
  return [{
    account: LSWAX.contract, name: 'transfer', authorization: auth1(account, auth),
    data: { from: account, to: FUSION, quantity: asset(lswax, 8, 'LSWAX'), memo },
  }];
}

// Three ways to take what you are owed: as WAX, straight back into sWAX, or as
// LSWAX. The last one names a floor because it prices through the same ratio a
// liquify does.
export function buildFusionClaim({ account, as = 'wax', minLswax = 0, auth = null }) {
  const a = auth1(account, auth);
  if (as === 'swax') return [{ account: FUSION, name: 'claimswax', authorization: a, data: { user: account } }];
  if (as === 'lswax') {
    return [{ account: FUSION, name: 'claimaslswax', authorization: a, data: { user: account, minimum_output: asset(minLswax, 8, 'LSWAX') } }];
  }
  return [{ account: FUSION, name: 'claimrewards', authorization: a, data: { user: account } }];
}

// Book a place in the queue. `replace` decides what happens to a request you
// already have: the contract refuses rather than quietly overwrite it.
export const buildFusionReqRedeem = ({ account, swax, replace = false, auth = null }) => [{
  account: FUSION, name: 'reqredeem', authorization: auth1(account, auth),
  data: { user: account, swax_to_redeem: asset(swax, 8, 'SWAX'), accept_replacing_prev_requests: !!replace },
}];

// Take the WAX out, during the window the request was booked into.
export const buildFusionRedeem = ({ account, auth = null }) => [{
  account: FUSION, name: 'redeem', authorization: auth1(account, auth), data: { user: account },
}];

// Skip the queue, for the protocol's fee, out of whatever is in the redemption
// bucket right now.
export const buildFusionInstaRedeem = ({ account, swax, auth = null }) => [{
  account: FUSION, name: 'instaredeem', authorization: auth1(account, auth),
  data: { user: account, swax_to_redeem: asset(swax, 8, 'SWAX') },
}];

// The housekeeping anyone may do. Every one of these has been called by an
// ordinary account in the contract's own history — they are how the protocol
// keeps running, and with the website gone nobody is pressing them on a
// schedule any more.
export const KEEPER = [
  { name: 'compound', args: () => ({}), title: 'Compound',
    what: 'Turns the revenue that has arrived into more sWAX behind LSWAX. Everybody holding LSWAX gets a little richer; whoever presses it pays the CPU.' },
  { name: 'createfarms', args: () => ({}), title: 'Fund the farms',
    what: 'Moves the ecosystem share into the Alcor incentives the protocol pays for, so the LSWAX pools keep rewarding liquidity.' },
  { name: 'stakeallcpu', args: () => ({}), title: 'Put idle WAX to work',
    what: 'Stakes WAX sitting in the contract to the CPU rental wallets, where it earns for stakers instead of doing nothing.' },
  { name: 'claimrefunds', args: () => ({}), title: 'Collect refunds',
    what: 'Pulls back WAX that finished unstaking from the CPU contracts so it can be used again.' },
  { name: 'updatetop21', args: () => ({}), title: 'Refresh the producer list',
    what: 'Points the protocol’s votes at the current top 21 block producers, which is where its voting rewards come from.' },
  { name: 'clearexpired', args: account => ({ user: account }), title: 'Clear your expired request',
    what: 'Removes a redemption request of yours whose window has passed, freeing the sWAX it was holding.' },
];

export function buildFusionKeeper({ account, name, auth = null }) {
  const k = KEEPER.find(x => x.name === name);
  if (!k) throw new Error(`Unknown protocol action ${name}`);
  return [{ account: FUSION, name: k.name, authorization: auth1(account, auth), data: k.args(account) }];
}
