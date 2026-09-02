// =============================================================================
// HOLDERS — who actually owns this token, and which of them are the same person.
//
// A holder list alone is easy to misread: four wallets holding 10% each looks
// like distribution until you notice one account created all four. WAX records
// the creator of every account, which is a cheap and unusually strong signal —
// two of the top holders of a token frequently turn out to share one.
//
// That is not proof of common ownership and is not presented as such. It is the
// same kind of fact as a bubble map edge: worth seeing, yours to interpret.
// =============================================================================

import { hyperion, rpc, dropEchoes } from './chain.js';

const LIGHT = 'https://wax.light-api.net/api';

// Contracts, not people. Balance sitting in these is liquidity or custody, and
// counting it as "a holder" makes every token look concentrated in one whale.
const KNOWN = new Map([
  ['swap.alcor', 'Alcor pools'],
  ['swap.taco', 'TacoSwap pools'],
  ['swap.box', 'Defibox pools'],
  ['swap.adex', 'A-DEX pools'],
  ['alcordexmain', 'Alcor order book'],
  ['eosio.ram', 'system'],
  ['eosio.stake', 'system'],
]);

// An account carrying code is not a person. Locker, vault, bridge and pool
// contracts otherwise show up as the biggest "whale" on every token — a locker contract can hold most of a
// token's supply, for everyone, rather than owning any of it.
const codeCache = new Map();
export async function hasCode(account) {
  if (codeCache.has(account)) return codeCache.get(account);
  let is = false;
  try {
    // Through the rotation, not at one host. A token page asks this of up to
    // fifty holders at once, and fifty parallel POSTs at a single node is the
    // shape that earns a 420 — which then reads as "this token has no
    // contracts in its holder list", the opposite of the truth.
    const d = await rpc('get_account', { account_name: account });
    is = !!(d.last_code_update && d.last_code_update !== '1970-01-01T00:00:00.000');
  } catch {}
  codeCache.set(account, is);
  return is;
}

export async function topHolders(contract, symbol, limit = 30) {
  const r = await fetch(`${LIGHT}/topholders/wax/${contract}/${symbol}/${limit}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`holders ${r.status}`);
  const rows = await r.json();
  return rows.map(([account, balance]) => ({
    account, balance: Number(balance),
    contractRole: KNOWN.get(account) || null,
  }));
}

const creatorCache = new Map();
export async function creatorOf(account) {
  if (creatorCache.has(account)) return creatorCache.get(account);
  let c = null;
  try {
    const d = await hyperion(`/v2/history/get_creator?account=${encodeURIComponent(account)}`);
    c = d.creator || null;
  } catch { /* older accounts have no recorded creator */ }
  creatorCache.set(account, c);
  return c;
}
export async function clusterHolders(holders) {
  // Resolve contracts first so they are excluded from clustering entirely.
  await Promise.all(holders.map(async h => {
    if (h.contractRole) return;
    if (await hasCode(h.account)) h.contractRole = 'contract';
  }));
  const people = holders.filter(h => !h.contractRole);
  const creators = await Promise.all(people.map(h => creatorOf(h.account)));
  people.forEach((h, i) => { h.creator = creators[i] || null; });

  const byCreator = new Map();
  for (const h of people) {
    if (!h.creator || h.creator === 'eosio' || h.creator === '') continue;
    if (!byCreator.has(h.creator)) byCreator.set(h.creator, []);
    byCreator.get(h.creator).push(h);
  }

  const clusters = [];
  for (const [creator, members] of byCreator) {
    if (members.length < 2) continue;
    const total = members.reduce((s, m) => s + m.balance, 0);
    clusters.push({ creator, members, total });
    for (const m of members) m.cluster = creator;
  }
  clusters.sort((a, b) => b.total - a.total);
  return clusters;
}

// What a wallet really controls: what it holds, plus its share of the token
// sitting in liquidity positions.
//
// Moving tokens between wallets is ordinary — a project runs a treasury, a
// farm funder, an airdrop account — so a transfer graph on its own accuses
// people of doing their job. Ownership is the question worth asking, and a
// wallet that looks small can hold most of a pool.
export async function lpHoldings(account, tokenId, pools) {
  const [symbol, contract] = [tokenId.split('@')[0], tokenId.split('@')[1]];
  let total = 0;
  const detail = [];

  // Alcor publishes an account's positions already valued and sized.
  try {
    const r = await fetch(`https://wax.alcor.exchange/api/v2/account/${encodeURIComponent(account)}/positions`,
      { signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const byPool = new Map(pools.filter(p => p.dex === 'alcor').map(p => [String(p.id), p]));
      for (const pos of await r.json()) {
        if (pos.closed) continue;
        const pool = byPool.get(String(pos.pool));
        if (!pool) continue;
        const side = pool.tokenA === tokenId ? pos.amountA : pool.tokenB === tokenId ? pos.amountB : null;
        if (side == null) continue;
        const amt = parseFloat(String(side)) || 0;
        if (amt > 0) { total += amt; detail.push({ pool: `${pool.symA}/${pool.symB}`, amount: amt, venue: 'Alcor' }); }
      }
    }
  } catch { /* fall through: wallet-only is still a useful answer */ }

  // TacoSwap LP is a plain token balance, so a share of the pair's reserves.
  try {
    const { getAllRows } = await import('./chain.js');
    const rows = await getAllRows('swap.taco', account, 'accounts');
    const byLp = new Map(pools.filter(p => p.dex === 'taco').map(p => [p.id, p]));
    for (const row of rows) {
      const [amtStr, sym] = String(row.balance).trim().split(/\s+/);
      const pool = byLp.get(sym);
      if (!pool || !(pool.lpSupply > 0)) continue;
      const share = Number(amtStr) / pool.lpSupply;
      const reserve = pool.tokenA === tokenId ? pool.reserveA : pool.tokenB === tokenId ? pool.reserveB : null;
      if (reserve == null) continue;
      const amt = reserve * share;
      if (amt > 0) { total += amt; detail.push({ pool: `${pool.symA}/${pool.symB}`, amount: amt, venue: 'Taco' }); }
    }
  } catch {}

  return { total, detail };
}

// Tokens nobody can move, because a contract is holding them until a date.
//
// waxdaolocker is chain-wide, not one project's: every lock ever made on WAX
// sits in one table, so the whole picture costs a single read and is worth
// caching for the session. status is the field that matters — 0 was created and
// never funded, 2 has already been withdrawn, and only 1 is money actually held.
//
// The distinction is the difference between a real number and a flattering one:
// counting every row would say 16.5 million CHEESE is locked whether or not it
// was ever deposited.
const LOCKER = 'waxdaolocker';
let locksCache = null;

export async function lockedSupply() {
  if (locksCache) return locksCache;
  const out = new Map();
  try {
    const { getAllRows } = await import('./chain.js');
    const rows = await getAllRows(LOCKER, LOCKER, 'locks');
    const now = Date.now() / 1000;
    for (const r of rows) {
      if (Number(r.status) !== 1) continue;
      const [amt, sym] = String(r.amount).split(' ');
      const id = `${sym}@${r.token_contract}`;
      const e = out.get(id) || { locked: 0, locks: 0, nextUnlock: null, claimable: 0, claimableLocks: 0 };
      const n = Number(amt);
      if (!(n > 0)) continue;
      e.locked += n;
      e.locks++;
      const t = Number(r.unlock_time);
      // Past its date and still sitting there: locked in the table, but only
      // until someone claims it. Saying that is more useful than pretending the
      // date has not passed.
      if (t <= now) { e.claimable += n; e.claimableLocks++; }
      else if (e.nextUnlock == null || t < e.nextUnlock) e.nextUnlock = t;
      out.set(id, e);
    }
  } catch { return out; }        // locker unreachable: report nothing locked, not a wrong number
  locksCache = out;
  return out;
}

// Supply, ceiling, issuer, how much has been sent to eosio.null — the WAX
// convention for burning, since the chain has no burn primitive — and how much
// is time-locked.
//
// Circulating is what is left. Both subtractions are provable on chain: burned
// tokens sit in an account with no keys, and locked ones in a contract that
// will not release them before a timestamp. A market cap that ignores either is
// quoting a supply that does not exist — for CHEESE that is 21 million against
// a real float nearer four and a half.
export async function tokenStats(contract, symbol) {
  const { getRows } = await import('./chain.js');
  const d = await getRows(contract, symbol, 'stat', { limit: 1 });
  const row = d.rows?.[0];
  if (!row) return null;
  const supply = Number(String(row.supply).split(' ')[0]);
  const maxSupply = Number(String(row.max_supply).split(' ')[0]);
  let burned = 0;
  try {
    const b = await getRows(contract, 'eosio.null', 'accounts', { limit: 20 });
    const hit = (b.rows || []).find(r => String(r.balance).endsWith(' ' + symbol));
    burned = hit ? parseFloat(hit.balance) : 0;
  } catch {}
  const lk = (await lockedSupply()).get(`${symbol}@${contract}`) || null;
  const locked = lk ? lk.locked : 0;
  return {
    supply, maxSupply, burned, issuer: row.issuer,
    locked, lockRows: lk ? lk.locks : 0,
    nextUnlock: lk ? lk.nextUnlock : null,
    claimable: lk ? lk.claimable : 0,
    circulating: Math.max(0, supply - burned - locked),
  };
}

// Everyone providing liquidity in this token, summed across its pools. The
// wallet list misses them entirely: a token's largest supplier often holds
// almost none of it in their own account.
export async function topLPs(tokenId, pools, { maxPools = 10 } = {}) {
  const { getAllRows } = await import('./chain.js');
  const { sqrtPriceFromX64, amountsForLiquidity } = await import('./math.js');
  const owners = new Map();
  const add = (o, amt) => { if (amt > 0) owners.set(o, (owners.get(o) || 0) + amt); };

  const alcor = pools.filter(p => p.dex === 'alcor' && p.tvl > 20).sort((a, b) => b.tvl - a.tvl).slice(0, maxPools);
  await Promise.all(alcor.map(async p => {
    try {
      const rows = await getAllRows('swap.alcor', p.id, 'positions');
      const s = sqrtPriceFromX64(p.sqrtX64);
      const isA = p.tokenA === tokenId;
      for (const r of rows) {
        const { amountA, amountB } = amountsForLiquidity(r.liquidity, s, r.tickLower, r.tickUpper);
        add(r.owner, isA ? amountA / 10 ** p.decA : amountB / 10 ** p.decB);
      }
    } catch {}
  }));
  return [...owners].map(([account, amount]) => ({ account, amount })).sort((a, b) => b.amount - a.amount);
}


// ------------------------------------------------------------------ tax -----
// Some WAX tokens take a cut of every transfer. It is not a standard, so each
// contract keeps it in its own table, but the handful of shapes in use cover
// most of the taxed supply:
//
//   waxpepetoken.txfeecfg  transaction_fee_percent 3 + dev_fee_percent 2, with
//                          the first going to eosio.null — burned on every send
//   buzzingarden.configs   per symbol, tx_fees: [{recipient, bps}]
//
// This matters beyond curiosity: a 3% transfer tax silently eats a swap route
// and turns a profitable compound into a loss, which is exactly the class of
// bug that is invisible until you are looking for it.
//   chadtoken.gm.txfees    sym "4,CHAD", fee_receivers: [{receiver, fee}] where
//                          fee is a fraction rather than basis points
const TAX_TABLES = ['txfeecfg', 'configs', 'txfees', 'config', 'taxcfg', 'fees', 'settings'];

// Which of the tax tables a contract actually has. One ABI call answers it, and
// replaces up to seven table reads that mostly fail — the difference between a
// two-minute daily job and a twelve-minute one.
const abiTables = new Map();
async function taxTablesOf(contract) {
  if (abiTables.has(contract)) return abiTables.get(contract);
  let names = [];
  try {
    const d = await rpc('get_abi', { account_name: contract });
    const all = (d.abi?.tables || []).map(t => t.name);
    names = TAX_TABLES.filter(t => all.includes(t));
  } catch {}
  abiTables.set(contract, names);
  return names;
}

export async function tokenTax(contract, symbol) {
  const { getRows } = await import('./chain.js');
  const tables = await taxTablesOf(contract);
  for (const table of tables) {
    let rows;
    try { rows = (await getRows(contract, contract, table, { limit: 60 })).rows; } catch { continue; }
    if (!rows?.length) continue;

    for (const r of rows) {
      // Per-symbol config, addressed either by bare code or by "decimals,SYMBOL".
      if (r.code && String(r.code) !== symbol) continue;
      if (r.sym && String(r.sym).split(',').pop() !== symbol) continue;

      // fee_receivers carries fractions, not basis points: 0.04 is 4%.
      if (Array.isArray(r.fee_receivers) && r.fee_receivers.length) {
        const parts = r.fee_receivers
          .map(f => ({ to: f.receiver, bps: Math.round((Number(f.fee) || 0) * 10000) }))
          .filter(x => x.bps > 0);
        const bps = parts.reduce((a, x) => a + x.bps, 0);
        if (bps > 0) return { bps, source: `${contract}.${table}`, parts, tradeable: null };
      }

      if (Array.isArray(r.tx_fees) && r.tx_fees.length) {
        const bps = r.tx_fees.reduce((a, f) => a + (Number(f.bps) || 0), 0);
        if (bps > 0) return {
          bps, source: `${contract}.${table}`,
          parts: r.tx_fees.map(f => ({ to: f.recipient, bps: Number(f.bps) || 0 })),
          tradeable: r.is_tradeable === undefined ? null : !!r.is_tradeable,
        };
      }

      const pct = Number(r.transaction_fee_percent) || 0;
      const dev = Number(r.dev_fee_percent) || 0;
      if (pct + dev > 0 && r.is_active !== 0) {
        const parts = [];
        if (pct > 0) parts.push({ to: r.tx_fee_vault || '?', bps: Math.round(pct * 100) });
        if (dev > 0) parts.push({ to: r.dev_fee_vault || '?', bps: Math.round(dev * 100) });
        return { bps: Math.round((pct + dev) * 100), source: `${contract}.${table}`, parts, tradeable: null };
      }
    }
  }
  return { bps: 0, source: null, parts: [], tradeable: null };
}

// How many accounts hold it at all. Concentration is meaningless without it:
// one wallet holding 40% reads very differently at thirty holders than at
// thirty thousand, and every "top holders" table implies a denominator it
// never shows.
export async function holderCount(contract, symbol) {
  const r = await fetch(`${LIGHT}/holdercount/wax/${contract}/${symbol}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`holdercount ${r.status}`);
  const n = Number((await r.text()).trim());
  return isFinite(n) ? n : null;
}

// Transfers are a different question from swap volume, and a token page that
// only counts trades misses most of what happens to a token: an airdrop moves
// a fortune without a single trade, and a token can trade hard on one pool
// while nothing at all moves between wallets.
//
// Hyperion returns one document per action with every receiver folded into a
// `receipts` array, so a transfer arrives once — but older nodes in the pool
// answer with a row per receiver, so this dedupes on the pair that is unique
// either way.
export async function transferActivity(contract, symbol, { hours = 24, maxPages = 4 } = {}) {
  const { hyperion } = await import('./chain.js');
  const after = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const page = n => hyperion(`/v2/history/get_actions?${new URLSearchParams({
    'act.account': contract, 'act.name': 'transfer', after,
    limit: '1000', skip: String(n * 1000), sort: 'desc',
  })}`);

  const first = await page(0);
  const rows = [...(first.actions || [])];
  const claimed = first.total?.value ?? rows.length;
  const pages = Math.min(Math.ceil(claimed / 1000) - 1, maxPages - 1);
  if (pages > 0) {
    const rest = await Promise.all(Array.from({ length: pages }, (_, i) =>
      page(i + 1).then(d => d.actions || []).catch(() => [])));
    for (const got of rest) rows.push(...got);
  }

  const out = [];
  let oldest = Infinity;
  for (const a of dropEchoes(rows)) {
    const x = a.act?.data;
    if (!x?.quantity) continue;
    const [amtStr, sym] = String(x.quantity).split(' ');
    if (sym !== symbol) continue;
    const amount = parseFloat(amtStr) || 0;
    const ts = new Date(a.timestamp + (a.timestamp.endsWith('Z') ? '' : 'Z')).getTime();
    oldest = Math.min(oldest, ts);
    const memo = String(x.memo || '');
    // An Alcor swap arrives as a transfer to swap.alcor whose memo names every
    // pool the route will cross: swapexactin#<ids>#<recipient>#<minOut>#<deadline>.
    // The trader and their route are therefore already in this feed, which is
    // the one thing replaying a pool row can never tell you.
    const route = memo.startsWith('swapexactin#') ? memo.split('#')[1]?.split(',').filter(Boolean) ?? null : null;
    out.push({ ts, trx: a.trx_id, from: x.from, to: x.to, amount, memo, route });
  }
  out.sort((a, b) => b.ts - a.ts);
  // Hyperion caps `total` at 10,000. Past that the window really covered is
  // whatever the pages reached, not the hours that were asked for, and saying
  // "24 hours" over a truncated read is how a quiet token gets invented.
  return {
    transfers: out,
    covered: isFinite(oldest) ? oldest : Date.now(),
    complete: claimed < 10000 && claimed <= rows.length,
  };
}

// ---------------------------------------------------------- transfer graph --
// The map people actually want: who moved this token to whom.
//
// `transferClusters` only kept a transfer when BOTH ends were already in the
// top fourteen holders, which discards nearly everything — a deployer sending
// 5% of supply to a fresh wallet is the single most interesting edge on the
// chart and that wallet is, by definition, not yet a top holder. The result was
// a map with no lines on it.
//
// This keeps the counterparty. Nodes are the top holders plus anyone who moved
// a meaningful amount with one of them; edges are the transfers between them.
export async function transferGraph(contract, symbol, holders, { supply = 0, seeds = 16, minShare = 0.0005, maxNodes = 40 } = {}) {
  const seedList = holders.slice(0, seeds);
  const seedSet = new Set(seedList.map(h => h.account));
  const edges = new Map();                        // 'a|b' -> { amount, count }
  const seen = new Map();                         // account -> total moved

  const bump = (a, b, amt) => {
    const key = [a, b].sort().join('|');
    const e = edges.get(key) || { amount: 0, count: 0 };
    e.amount += amt; e.count++;
    edges.set(key, e);
    seen.set(a, (seen.get(a) || 0) + amt);
    seen.set(b, (seen.get(b) || 0) + amt);
  };

  await Promise.all(seedList.map(async h => {
    try {
      const q = new URLSearchParams({
        account: h.account, 'act.account': contract, 'act.name': 'transfer',
        limit: '250', sort: 'desc',
      });
      const d = await hyperion(`/v2/history/get_actions?${q}`);
      for (const a of (d.actions || [])) {
        const x = a.act?.data;
        if (!x || x.from === x.to) continue;
        if (String(x.quantity || '').split(' ')[1] !== symbol) continue;
        const amt = parseFloat(x.quantity) || 0;
        if (!(amt > 0)) continue;
        // Dust is not a relationship. Below a twentieth of a percent of supply
        // this is a test transaction or a tip, and a graph full of them says
        // nothing about who controls what.
        if (supply > 0 && amt / supply < minShare) continue;
        if (!seedSet.has(x.from) && !seedSet.has(x.to)) continue;
        bump(x.from, x.to, amt);
      }
    } catch { /* one unreadable history must not void the graph */ }
  }));

  // Every seed, plus the counterparties that moved the most.
  const balanceOfAcct = new Map(holders.map(h => [h.account, h]));
  const extras = [...seen.entries()]
    .filter(([a]) => !seedSet.has(a))
    .sort((x, y) => y[1] - x[1])
    .slice(0, Math.max(0, maxNodes - seedList.length))
    .map(([a]) => a);

  const keep = new Set([...seedSet, ...extras]);
  const nodes = [...keep].map(a => {
    const h = balanceOfAcct.get(a);
    return {
      id: a,
      value: h ? h.balance : (seen.get(a) || 0),
      // A counterparty we have no balance row for is sized by what it moved,
      // and said to be sized that way rather than passed off as a holding.
      moved: !h,
      contract: !!h?.contractRole,
      share: supply > 0 && h ? h.balance / supply : null,
    };
  }).filter(n => n.value > 0);

  const links = [...edges.entries()]
    .map(([k, e]) => { const [source, target] = k.split('|'); return { source, target, value: e.amount, count: e.count }; })
    .filter(l => keep.has(l.source) && keep.has(l.target))
    .sort((a, b) => b.value - a.value);

  return { nodes, links };
}
