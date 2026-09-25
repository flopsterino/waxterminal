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
//   redeem       reqredeem books a request into an epoch; redeem withdraws
//                during that epoch's 48-hour redemption period; instaredeem
//                skips it for the protocol's fee
//
// Epochs run a week apart, each renting CPU for a fortnight, and an epoch's
// redemption period opens 14 days after it starts and closes two days later.
// Miss it and you wait for the next one — exactly the sort of thing a dead
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
    limit: 12, lower: String(Math.max(0, startedAt - Number(g.cpu_rental_epoch_length_seconds || 0) * 3)),
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
  // total, both in 1e-8 units. The rate carries its own scale of 1e3, not 1e6:
  // read as 1e6 it pays the 3.1M staked sWAX 0.83 WAX a day and the page said
  // 0.01% a year, while the contract's own totals show stakers paid 1.01M WAX
  // over 779 days — 1,299 a day. At 1e3 the current rate is 829 WAX a day,
  // 9.7% a year, under the 12% cap it is meant to sit under.
  const rate = r ? Number(r.rewardRate) / 1e3 : 0;
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
    lastEpochStart: startedAt * 1000,
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

// Every token that goes INTO dapp.fusion — WAX to stake, LSWAX to unliquify —
// is preceded in the same transaction by dapp.fusion::stake {user}. It opens
// (or touches) the account's row that the incoming transfer is booked to;
// without it the transfer is refused. Read off every real transaction:
//   stake · WAX "stake"                              (02551cfb…, 25-09)
//   stake · LSWAX "|unliquify_exact|…|" · instaredeem (df698189…, 25-09)
// Claims, reqredeem and redeem stand on their own.
const openRow = (account, a) => ({ account: FUSION, name: 'stake', authorization: a, data: { user: account } });

// WAX in. The contract mints sWAX one for one and starts it earning.
export const buildFusionStake = ({ account, wax, auth = null }) => {
  const a = auth1(account, auth);
  return [openRow(account, a), {
    account: WAX.contract, name: 'transfer', authorization: a,
    data: { from: account, to: FUSION, quantity: asset(wax, 8, 'WAX'), memo: 'stake' },
  }];
};

// sWAX that pays you, into LSWAX that compounds instead.
export const buildFusionLiquify = ({ account, swax, auth = null }) => [{
  account: FUSION, name: 'liquify', authorization: auth1(account, auth),
  data: { user: account, quantity: asset(swax, 8, 'SWAX') },
}];

// WAX straight to LSWAX, one transaction: stake it, then liquify exactly the
// sWAX that just arrived (one for one). The same three actions real users
// sign (02551cfb…).
export const buildFusionStakeLiquify = ({ account, wax, auth = null }) => [
  ...buildFusionStake({ account, wax, auth }),
  ...buildFusionLiquify({ account, swax: wax, auth }),
];

// And back. A minimum turns it into the exact variant, which refuses rather
// than filling at a worse rate than you accepted.
export function buildFusionUnliquify({ account, lswax, minSwax = null, auth = null }) {
  // The exact variant carries its minimum as raw units, not as an asset
  // string: a real one reads |unliquify_exact|1277369541| for 12.77369541
  // sWAX. Written any other way the contract has nothing to parse.
  const floor = minSwax != null ? Math.floor(Number(minSwax) * 1e8) : null;
  const memo = floor > 0 ? `|unliquify_exact|${floor}|` : 'unliquify';
  const a = auth1(account, auth);
  return [openRow(account, a), {
    account: LSWAX.contract, name: 'transfer', authorization: a,
    data: { from: account, to: FUSION, quantity: asset(lswax, 8, 'LSWAX'), memo },
  }];
}

// Redeeming what most people actually hold: LSWAX. Unliquify with an exact
// floor, then redeem exactly that floor — the sWAX is guaranteed to be there
// because the unliquify refuses to give less. Instantly (instaredeem, for the
// fee) or as a request for the next redemption period. One transaction.
export function buildFusionRedeemFromLswax({ account, lswax, lswaxInSwax, instant = true, replace = false, auth = null }) {
  const floor = Math.floor(Number(lswax) * Number(lswaxInSwax) * 0.999 * 1e8) / 1e8;
  if (!(floor > 0)) throw new Error('Too little LSWAX to redeem.');
  const swax = floor;
  return {
    swax,
    actions: [
      ...buildFusionUnliquify({ account, lswax, minSwax: swax, auth }),
      ...(instant ? buildFusionInstaRedeem({ account, swax, auth }) : buildFusionReqRedeem({ account, swax, replace, auth })),
    ],
  };
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

// Withdraw, during the redemption period the request was booked into.
export const buildFusionRedeem = ({ account, auth = null }) => [{
  account: FUSION, name: 'redeem', authorization: auth1(account, auth), data: { user: account },
}];

// Skip the wait, for the protocol's fee, out of whatever is held for
// redemptions right now.
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
    what: 'Turns arrived revenue into more sWAX behind LSWAX.' },
  { name: 'createfarms', args: () => ({}), title: 'Fund the farms',
    what: 'Hands the ecosystem share to the Alcor incentives it funds.' },
  { name: 'stakeallcpu', args: () => ({}), title: 'Put idle WAX to work',
    what: 'Stakes idle WAX to the CPU wallets so it earns.' },
  { name: 'claimrefunds', args: () => ({}), title: 'Collect refunds',
    what: 'Pulls back WAX that finished unstaking.' },
  { name: 'updatetop21', args: () => ({}), title: 'Refresh the producer list',
    what: 'Points its votes at the current top 21 producers.' },
  { name: 'clearexpired', args: account => ({ user: account }), title: 'Clear your expired request',
    what: 'Frees the sWAX behind a request whose period has passed.' },
];

export function buildFusionKeeper({ account, name, auth = null }) {
  const k = KEEPER.find(x => x.name === name);
  if (!k) throw new Error(`Unknown protocol action ${name}`);
  return [{ account: FUSION, name: k.name, authorization: auth1(account, auth), data: k.args(account) }];
}

// ---- where a redemption request lands ---------------------------------------
// Straight from reqredeem (dapp.fusion source, fusion.cpp): it looks at three
// epochs — the one before last_epoch_start_time, that one, and the next —
// skips any whose redemption period has already begun, and books the request
// into the earliest with room. Room is the WAX that epoch's CPU stake returns
// (wax_bucket) minus what is already requested from it (wax_to_refund). A
// request too big for one is split across them; what none of them can hold is
// paid out on the spot from the rental pool, if the pool has it.
export function redemptionEpochs(st, now = Date.now()) {
  const step = st.epochSeconds * 1000;
  const ids = [st.lastEpochStart - step, st.lastEpochStart, st.lastEpochStart + step];
  return ids.map(id => st.epochs.find(e => e.startsAt === id)).filter(Boolean).map(e => ({
    ...e,
    requested: e.toRefund,
    free: Math.max(0, e.bucket - e.toRefund),
    open: e.windowFrom > now,          // still takes new requests
  }));
}
export function planRequest(st, swax, now = Date.now()) {
  let left = swax;
  const parts = [];
  for (const e of redemptionEpochs(st, now)) {
    if (!e.open || !(e.free > 0) || !(left > 0)) continue;
    const take = Math.min(left, e.free);
    parts.push({ epoch: e, amount: take });
    left -= take;
  }
  const now_ = Math.min(left, st.availableForRentals);
  return { parts, paidNow: now_ > 0 ? now_ : 0, impossible: left - now_ > 1e-8 ? left - now_ : 0 };
}
