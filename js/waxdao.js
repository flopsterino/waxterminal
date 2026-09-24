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

// How many accounts stake in one farm. The farms table carries the NFT count
// but not the people, so the Staking page showed "—" under Stakers for every
// WaxDAO farm. The stakers table has one row per (user, farm) and its fourth
// index is the farm name, so a count is one query. Every row of one farm shares
// that key, which means there is no paging past the first answer — a farm with
// more than that comes back as a floor ("1,000+"), not a made-up total.
const stakerCounts = new Map();
export function waxdaoStakerCount(farm) {
  if (!stakerCounts.has(farm)) {
    stakerCounts.set(farm, getRows(CONTRACT, CONTRACT, 'stakers', { lower: farm, upper: farm, indexPosition: 4, keyType: 'name', limit: 1000 })
      .then(d => ({ n: (d.rows || []).filter(r => r.farmname === farm).length, more: !!d.more }))
      .catch(() => null));
  }
  return stakerCounts.get(farm);
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

// =============================================================================
// WAXDAOLOCKER — tokens somebody put out of reach, on purpose, until a date.
//
// One contract, chain-wide: every lock ever made on WAX sits in one table, and
// the terminal already reads it for the supply calendar and the locked share on
// a token page. What it never did was the half that has money in it — 113 locks
// are past their date and still sitting there, because collecting one needs a
// button that no longer exists anywhere.
//
// The flow, taken from what the contract's own history does rather than its
// ABI. A lock is created and funded in one transaction:
//
//   waxdaolocker::createlock  creator, receiver, amount, token_contract, unlock
//   <token>::transfer         the same amount to waxdaolocker, memo deposit_v2
//
// and the receiver collects it afterwards with withdraw{lock_ID}. Verified on
// 2b5125c7… (a 3,002,718,038 MOONBOY lock made on 2026-09-20) and on lock 510,
// withdrawn by its receiver on 2026-09-09.
//
// status is the field that decides what a row means: 0 created and never
// funded, 1 holding money, 2 already withdrawn.
// =============================================================================

export const LOCKER = 'waxdaolocker';
export const LOCK_MEMO = 'deposit_v2';

let lockRows = null, lockAt = 0;
export async function allLocks({ maxAgeMs = 5 * 60 * 1000, force = false } = {}) {
  if (lockRows && !force && Date.now() - lockAt < maxAgeMs) return lockRows;
  const { getAllRows } = await import('./chain.js');
  lockRows = await getAllRows(LOCKER, LOCKER, 'locks');
  lockAt = Date.now();
  return lockRows;
}

const lockRow = (r, now) => {
  const [amtStr, symbol] = String(r.amount || '').split(' ');
  const amount = parseFloat(amtStr) || 0;
  const unlockAt = Number(r.unlock_time) * 1000;
  return {
    id: Number(r.ID), creator: r.creator, receiver: r.receiver,
    amount, symbol, contract: r.token_contract, tokenId: `${symbol}@${r.token_contract}`,
    decimals: (String(amtStr).split('.')[1] || '').length,
    createdAt: Number(r.time_of_creation) * 1000,
    fundedAt: Number(r.time_of_deposit) * 1000 || null,
    unlockAt, status: Number(r.status),
    ready: Number(r.status) === 1 && unlockAt <= now,
  };
};

// One account's locks, from the same read the rest of the page already made.
export async function locksFor(account, { now = Date.now() } = {}) {
  const rows = await allLocks();
  const mine = rows.map(r => lockRow(r, now))
    .filter(r => r.amount > 0 && (r.receiver === account || r.creator === account));
  return {
    // Yours to take, now.
    ready: mine.filter(r => r.receiver === account && r.ready).sort((a, b) => a.unlockAt - b.unlockAt),
    // Yours, later.
    waiting: mine.filter(r => r.receiver === account && r.status === 1 && !r.ready).sort((a, b) => a.unlockAt - b.unlockAt),
    // Locks you made for someone else, which is money you no longer control.
    given: mine.filter(r => r.creator === account && r.receiver !== account && r.status === 1).sort((a, b) => a.unlockAt - b.unlockAt),
    // Created and never funded: the contract is holding a row, not money.
    unfunded: mine.filter(r => r.status === 0),
  };
}

export function buildLockWithdraw({ account, lockIds, auth = null }) {
  const ids = (Array.isArray(lockIds) ? lockIds : [lockIds]).map(Number).filter(n => n >= 0);
  if (!ids.length) throw new Error('No lock to withdraw.');
  return ids.map(id => ({
    account: LOCKER, name: 'withdraw',
    authorization: auth || [{ actor: account, permission: 'active' }],
    data: { lock_ID: id },
  }));
}

// Create and fund in one transaction, the way the contract's own users do it.
// Nothing here can undo it: past this signature the tokens belong to the
// receiver on that date and to nobody before it.
export function buildTokenLock({ account, receiver, amount, symbol, decimals, contract, unlockAt, auth = null }) {
  const a = auth || [{ actor: account, permission: 'active' }];
  const qty = `${(Math.floor(Number(amount) * 10 ** decimals) / 10 ** decimals).toFixed(decimals)} ${symbol}`;
  const seconds = Math.floor(unlockAt / 1000);
  if (!(seconds > Date.now() / 1000)) throw new Error('The unlock date has to be in the future.');
  return [
    {
      account: LOCKER, name: 'createlock', authorization: a,
      data: { creator: account, receiver: receiver || account, amount: qty, token_contract: contract, unlock_time: seconds },
    },
    {
      account: contract, name: 'transfer', authorization: a,
      data: { from: account, to: LOCKER, quantity: qty, memo: LOCK_MEMO },
    },
  ];
}
