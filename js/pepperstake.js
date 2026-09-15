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
  const info = row ? normalise(row) : null;
  poolCache.set(id, info);
  return info;
}

// display_data is a JSON blob the pool owner controls: a name and an IPFS
// image. A pool with neither is not broken, it is just unnamed.
function display(raw) {
  try {
    const d = JSON.parse(raw || '{}');
    return { name: String(d.name || '').slice(0, 80), img: String(d.img || d.image || '').slice(0, 120) };
  } catch { return { name: '', img: '' }; }
}

function normalise(row) {
  const d = display(row.display_data);
  const periods = Number(row.periods_count) || 0;
  const periodSec = Number(row.time_per_period_sec) || 0;
  const startAt = Number(row.start_at) * 1000;
  const [, sym] = String(row.accept_symbol || '').split(',');
  const precision = Number(String(row.accept_symbol || '0,X').split(',')[0]) || 0;
  const reward = parseQty(row.period_reward);
  return {
    id: Number(row.id), owner: row.owner,
    name: d.name, img: d.img,
    // A pool takes NFTs or it takes a token; the flag and the symbol together
    // say which, and both are needed — an NFT pool still carries a dummy
    // "0,POW" symbol.
    kind: row.accept_assets ? 'nft' : 'token',
    acceptSymbol: sym || '', acceptContract: row.accept_contract || '', acceptPrecision: precision,
    minStake: parseQty(row.min_stake), maxStake: parseQty(row.max_stake),
    reward, periods, periodSec, startAt,
    endsAt: startAt + periods * periodSec * 1000,
    unstakeSec: Number(row.unstake_time_sec) || 0,
    users: Number(row.total_user_pools) || 0,
    assetPower: Number(row.assets_staked_power) || 0,
    tokenPower: Number(row.tokens_staked_power) || 0,
    stakedAssets: Number(row.staked_assets) || 0,
    totalPaid: Number(row.total_paid) || 0,
    activated: !!row.activated,
    accumulative: !!row.accumulative,
    // Tokens are stored as raw integer units of the accepted symbol.
    stakedTokens: (Number(row.tokens_staked_power) || 0) / 10 ** precision,
    rewardPerDay: reward && periodSec > 0 ? reward.amount * 86400 / periodSec : 0,
  };
}

// Every pool the contract knows, so they can be browsed rather than found by
// guessing an id. 224 rows in one read; the list is cached because it changes
// when somebody creates a pool, not between two clicks.
let allPools = null, allAt = 0;
export async function pepperPools({ maxAgeMs = 5 * 60 * 1000 } = {}) {
  if (allPools && Date.now() - allAt < maxAgeMs) return allPools;
  let rows = [];
  try {
    const d = await getRows(CONTRACT, CONTRACT, 'pools', { limit: 400 });
    rows = d.rows || [];
  } catch { return allPools || []; }
  allPools = rows.map(normalise);
  allAt = Date.now();
  for (const p of allPools) poolCache.set(p.id, p);
  return allPools;
}

// What an NFT pool accepts, and what each kind is worth in staking power.
export async function pepperPoolAssets(id) {
  try {
    const d = await getRows(CONTRACT, nameFromId(id), 'poolassets', { limit: 100 });
    return (d.rows || []).map(r => ({
      collection: r.collection || '', schema: r.schema_name || '', author: r.author || '',
      key: r.format_key || '',
      formats: (r.formats || []).map(f => ({ value: f.format_value, power: Number(f.power) || 0 })),
    }));
  } catch { return []; }
}

// Table scopes are the pool id as a name, which is how the contract stores
// them: uint64 12 is "............c".
const NAME_CHARS = '.12345abcdefghijklmnopqrstuvwxyz';
function nameFromId(id) {
  const v = BigInt(id);
  let out = '';
  // Twelve five-bit characters, then one four-bit character, most significant
  // first — the standard EOSIO name encoding, applied to the id as it stands.
  for (let i = 0; i < 13; i++) {
    const shift = i === 12 ? 0n : BigInt(64 - 5 * (i + 1));
    const mask = i === 12 ? 0x0fn : 0x1fn;
    out += NAME_CHARS[Number((v >> shift) & mask)];
  }
  return out.replace(/\.+$/, '') || '.';
}

// Staking a token is a transfer with the pool in the memo; the contract has no
// stake action of its own. Verified against live stakes: "stake:506".
export function buildPepperStakeTokens({ account, pool, amount, auth = null }) {
  auth = auth || [{ actor: account, permission: 'active' }];
  const dec = pool.acceptPrecision;
  const quantity = `${Number(amount).toFixed(dec)} ${pool.acceptSymbol}`;
  return [{
    account: pool.acceptContract, name: 'transfer', authorization: auth,
    data: { from: account, to: CONTRACT, quantity, memo: `stake:${pool.id}` },
  }];
}

export function buildPepperUnstake({ account, pool, amount = 0, assetIds = [], auth = null }) {
  auth = auth || [{ actor: account, permission: 'active' }];
  const dec = pool.acceptPrecision;
  return [{
    account: CONTRACT, name: 'unstake', authorization: auth,
    data: {
      owner: account, pool_id: Number(pool.id),
      quantity: `${Number(amount || 0).toFixed(dec)} ${pool.acceptSymbol || 'POW'}`,
      asset_ids: assetIds.map(String),
    },
  }];
}

function parseQty(q) {
  const raw = q?.quantity ?? q;
  if (!raw) return null;
  const [amt, sym] = String(raw).split(' ');
  return { amount: parseFloat(amt) || 0, symbol: sym, contract: q?.contract || '', decimals: (amt.split('.')[1] || '').length };
}

export async function pepperStakes(account) {
  let rows = [], assets = [];
  try {
    const [d, a] = await Promise.all([
      getRows(CONTRACT, account, 'userpools', { limit: 200 }),
      getRows(CONTRACT, account, 'stakedassets', { limit: 500 }).catch(() => ({ rows: [] })),
    ]);
    rows = d.rows || [];
    assets = a.rows || [];
  } catch { return []; }
  if (!rows.length) return [];
  // Which NFTs sit in which pool. Unstaking names asset ids, so a position
  // without them is one you can look at and never leave.
  const byPool = new Map();
  for (const x of assets) {
    const list = byPool.get(Number(x.pool_id)) || [];
    list.push({ id: String(x.asset_id), power: Number(x.power) || 0, template: Number(x.template_id) || 0 });
    byPool.set(Number(x.pool_id), list);
  }

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

    const nfts = byPool.get(Number(r.pool_id)) || [];
    const dec = pool?.reward?.decimals ?? 0;
    // Your share of a period is your power over the pool's, tokens and assets
    // counted the way the contract counts them.
    const mine = (Number(r.staked_assets_power) || 0) + (Number(r.staked_tokens) || 0);
    const total = pool ? pool.assetPower + pool.tokenPower : 0;
    const share = total > 0 ? mine / total : 0;
    const perPeriod = pool?.reward ? pool.reward.amount * share : 0;
    return {
      poolId: Number(r.pool_id), pool,
      collected,
      collectedAmount: collected / 10 ** dec,
      totalClaimed: (Number(r.total_claimed) || 0) / 10 ** dec,
      stakedTokens: (Number(r.staked_tokens) || 0) / 10 ** (pool?.acceptPrecision ?? 0),
      stakedTokensRaw: Number(r.staked_tokens) || 0,
      stakedAssets: Number(r.staked_assets_power) || 0,
      nfts, share, perPeriod,
      nextPeriod: next,
      currentPeriod: now,
      // Uncollected periods, capped: a hundred and eighty collect actions is not
      // one transaction, and pretending otherwise builds one that fails.
      behind: Math.min(behind, 60),
      behindTotal: behind,
      // What claiming would pay, as far as the chain lets us work it out.
      waiting: collected / 10 ** dec + behind * perPeriod,
      ended: pool ? pool.endsAt < Date.now() : false,
    };
  }));

  // Everything, ended pools included: one still owes what it accrued, and it
  // still holds the NFTs until somebody takes them out.
  return out.filter(s => s.collected > 0 || s.behindTotal > 0 || s.stakedTokens > 0 || s.stakedAssets > 0 || s.nfts.length);
}

// Unstakes already asked for, waiting out the pool's cooldown. `refund` pays
// them out, and nothing else on WAX currently offers that button.
export async function pepperUnstakes(account) {
  try {
    const d = await getRows(CONTRACT, account, 'userunstake', { limit: 100 });
    return (d.rows || []).map(r => ({
      id: Number(r.id), poolId: Number(r.pool_id),
      readyAt: Number(r.ready_at) * 1000,
      quantity: r.quantity?.quantity || '', contract: r.quantity?.contract || '',
      assets: (r.assets || []).map(a => String(a.asset_id)),
    }));
  } catch { return []; }
}

export function buildPepperRefund({ account, id, auth = null }) {
  auth = auth || [{ actor: account, permission: 'active' }];
  return [{ account: CONTRACT, name: 'refund', authorization: auth, data: { owner: account, id: Number(id) } }];
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
