// =============================================================================
// HOLDERS — who actually owns this token, and which of them are the same person.
//
// A holder list alone is easy to misread: four wallets holding 10% each looks
// like distribution until you notice one account created all four. WAX records
// the creator of every account, which is a cheap and unusually strong signal —
// among the top CHEESE holders, `liquidcheese` and `cheesebuildr` were both
// created by `zeebigcheese`.
//
// That is not proof of common ownership and is not presented as such. It is the
// same kind of fact as a bubble map edge: worth seeing, yours to interpret.
// =============================================================================

import { hyperion } from './chain.js';

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
// contracts otherwise show up as the biggest "whale" on every token — 78.7% of
// CHEESE sits in waxdaolocker, which holds it for everyone rather than owning it.
const codeCache = new Map();
export async function hasCode(account) {
  if (codeCache.has(account)) return codeCache.get(account);
  let is = false;
  try {
    const { rpc } = await import('./chain.js');
    const d = await fetch('https://wax.greymass.com/v1/chain/get_account', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_name: account }), signal: AbortSignal.timeout(12000),
    }).then(r => r.json());
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

// The real cluster signal: who has moved size to whom.
//
// A shared creator is suggestive; a chain of transfers between two wallets is
// evidence. This walks each top holder's history of THIS token, keeps only the
// counterparties who are also top holders, and joins them into components — the
// same thing a bubble map draws, computed from the transfers themselves.
export async function transferClusters(contract, symbol, holders, { minShare = 0.005, supply = 0 } = {}) {
  const people = holders.filter(h => !h.contractRole).slice(0, 14);
  const set = new Set(people.map(h => h.account));
  const edges = new Map();                       // 'a|b' -> usd-less token amount

  await Promise.all(people.map(async h => {
    try {
      const q = new URLSearchParams({
        account: h.account, 'act.account': contract, 'act.name': 'transfer',
        limit: '250', sort: 'desc',
      });
      const d = await hyperion(`/v2/history/get_actions?${q}`);
      for (const a of (d.actions || [])) {
        const x = a.act.data;
        if (!x || x.from === x.to) continue;
        const [sym] = String(x.quantity || '').split(' ').slice(1);
        if (sym !== symbol) continue;
        if (!set.has(x.from) || !set.has(x.to)) continue;
        const amt = parseFloat(x.quantity) || 0;
        if (!(amt > 0)) continue;
        // Ignore dust: a cluster is about size moving, not a test transaction.
        if (supply > 0 && amt / supply < minShare / 10) continue;
        const key = [x.from, x.to].sort().join('|');
        edges.set(key, (edges.get(key) || 0) + amt);
      }
    } catch { /* one unreadable history must not void the graph */ }
  }));

  // Connected components over those edges.
  const parent = new Map(people.map(h => [h.account, h.account]));
  const find = a => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const key of edges.keys()) { const [a, b] = key.split('|'); union(a, b); }

  const groups = new Map();
  for (const h of people) {
    const root = find(h.account);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(h);
  }

  const out = [];
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const total = members.reduce((s, m) => s + m.balance, 0);
    const links = [...edges.entries()]
      .filter(([k]) => { const [a, b] = k.split('|'); return members.some(m => m.account === a) && members.some(m => m.account === b); })
      .map(([k, v]) => ({ pair: k.split('|'), amount: v }))
      .sort((a, b) => b.amount - a.amount);
    out.push({ members, total, links, share: supply > 0 ? total / supply : null });
    for (const m of members) m.transferCluster = members.map(x => x.account).join('+');
  }
  out.sort((a, b) => b.total - a.total);
  return out;
}

// Group holders that share a creator. Anything created by the system, or the
// only member of its group, is left ungrouped — a "cluster of one" is noise.
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

// Total supply, so a balance can be read as a share of the whole.
export async function tokenSupply(contract, symbol) {
  const { getRows } = await import('./chain.js');
  const d = await getRows(contract, symbol, 'stat', { limit: 1 });
  const row = d.rows?.[0];
  if (!row) return null;
  return Number(String(row.supply).split(' ')[0]);
}
