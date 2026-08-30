// =============================================================================
// CHAIN — every byte this terminal shows comes from here. No backend exists.
//
// Public WAX infrastructure has sharp edges that all fail quietly:
//   * Greymass answers 403 without a User-Agent (browsers always send one, so
//     this only bites server-side — kept in mind because the roster is shared).
//   * Hosts return 420/429 under load. One degrading host must never stall a
//     sweep, so every call rotates and a hurt host gets benched.
//   * Hyperion gaps and lags. Treat its answers as possibly partial, never as
//     the source of truth for balances.
// All six hosts below send Access-Control-Allow-Origin:*, which is what makes a
// serverless terminal possible at all.
// =============================================================================

export const RPC_HOSTS = [
  'https://wax.eosusa.io',
  'https://api.waxsweden.org',
  'https://wax.greymass.com',
  'https://wax.cryptolions.io',
  'https://wax.eosdac.io',
  'https://api.wax.alohaeos.com',
];

export const HYPERION_HOSTS = [
  'https://wax.eosusa.io',
  'https://wax.cryptolions.io',
  'https://api.waxsweden.org',
];

const benched = new Map();
let cursor = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function pick(hosts) {
  const now = Date.now();
  for (let i = 0; i < hosts.length; i++) {
    const h = hosts[(cursor + i) % hosts.length];
    if ((benched.get(h) || 0) <= now) { cursor = (cursor + i + 1) % hosts.length; return h; }
  }
  return hosts[cursor++ % hosts.length];
}
const bench = (h, ms) => benched.set(h, Date.now() + ms);

export const health = () => RPC_HOSTS.map(h => ({ host: h, benched: (benched.get(h) || 0) > Date.now() }));

// A healthy WAX node answers a 1000-row table read in well under 1.5s. Waiting
// 25s for a dead one is what turns "a host is down" into "the page hangs", so
// requests are hedged: if the first host has not answered within HEDGE_MS a
// second attempt starts alongside it on another host, and the first response
// home wins. Measured 2026-08-29: api.waxsweden.org was timing out at 20s while
// greymass answered in 60ms, and without hedging that stalls a whole sweep.
const REQ_TIMEOUT = 9000;
const HEDGE_MS = 2200;

async function once(endpoint, body, host, timeout = REQ_TIMEOUT) {
  let res;
  try {
    res = await fetch(`${host}/v1/chain/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) { bench(host, 25000); throw e; }          // timeout or network: bench hard
  if (res.status === 420 || res.status === 429) { bench(host, 30000); throw new Error(`${host} ${res.status}`); }
  if (!res.ok) { bench(host, 15000); throw new Error(`${host} HTTP ${res.status}`); }
  return res.json();
}

function post(endpoint, body, { tries = 4, hedgeMs = HEDGE_MS } = {}) {
  return new Promise((resolve, reject) => {
    let launched = 0, finished = 0, settled = false;
    const errors = [];

    const launch = () => {
      if (settled || launched >= tries) return;
      launched++;
      once(endpoint, body, pick(RPC_HOSTS)).then(
        v => { if (!settled) { settled = true; resolve(v); } },
        e => {
          errors.push(e); finished++;
          if (settled) return;
          if (finished >= launched) {
            if (launched < tries) launch();
            else reject(new Error(`${endpoint}: ${errors.at(-1)?.message || 'unreachable'}`));
          }
        }
      );
      if (launched < tries) setTimeout(() => { if (!settled) launch(); }, hedgeMs);
    };
    launch();
  });
}

// Bounded parallelism. Firing 14 shards at once is what invites a rate limit;
// six in flight keeps a cold load fast without looking like an attack.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

export async function getRows(code, scope, table, { limit = 1000, lower = null, upper = null } = {}) {
  const body = { json: true, code, scope: String(scope), table, limit };
  if (lower !== null) body.lower_bound = String(lower);
  if (upper !== null) body.upper_bound = String(upper);
  return post('get_table_rows', body);
}

// Sequential walk. Correct for any key type, but slow for big tables.
export async function getAllRows(code, scope, table, { onPage = null, cap = Infinity } = {}) {
  const out = [];
  let lower = null;
  for (;;) {
    const d = await getRows(code, scope, table, { lower });
    out.push(...d.rows);
    onPage?.(out.length, d.more);
    if (!d.more || out.length >= cap) break;
    lower = d.next_key;
  }
  return out;
}

// Sharded walk for tables with sequential integer ids (Alcor pools, incentives).
// Splitting the id space lets ~12 pages fetch at once instead of one at a time,
// which is the difference between a 20-second and a 3-second cold load.
export async function getAllRowsSharded(code, scope, table, maxId, { shard = 1000, onPage = null } = {}) {
  const starts = [];
  for (let i = 0; i <= maxId; i += shard) starts.push(i);
  let done = 0;
  const pages = await mapLimit(starts, 6, async start => {
    const rows = [];
    let lower = start;
    const end = start + shard;
    let failed = false;
    try {
      for (;;) {
        const d = await getRows(code, scope, table, { lower, upper: end - 1, limit: shard });
        rows.push(...d.rows);
        if (!d.more) break;
        lower = d.next_key;
        if (Number(lower) >= end) break;
      }
    } catch { failed = true; }      // a lost shard costs some pools, not the terminal
    done++; onPage?.(done, starts.length);
    return { rows, failed };
  });
  // An EMPTY shard is not a failed one: ids are sharded past the end of the
  // table on purpose, so most of the tail is legitimately empty.
  const all = pages.flatMap(p => p.rows);
  all.shardsFailed = pages.filter(p => p.failed).length;
  return all;
}

export async function hyperion(path, tries = 4) {
  let last;
  for (let a = 0; a < tries; a++) {
    const host = pick(HYPERION_HOSTS);
    try {
      const res = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) { bench(host, 15000); last = new Error(`HTTP ${res.status}`); continue; }
      return await res.json();
    } catch (e) { bench(host, 8000); last = e; }
    await sleep(250 * (a + 1));
  }
  throw new Error(`hyperion: ${last?.message || 'unreachable'}`);
}

export async function chainInfo() { return post('get_info', {}); }

// The same rotation, hedging and benching for anything else the app needs off a
// node. Modules that reached for a hardcoded host got none of it: a token page
// asking one host fifty times in parallel is exactly the shape that earns a 420.
export const rpc = (endpoint, body, opts) => post(endpoint, body, opts);

// A contract that re-notifies a transfer it just received produces a second
// Hyperion row for the same movement: same parties, same amount, with
// `creator_action_ordinal` pointing back at the original. Alcor does this on
// every swap, so a feed that keeps both counts every trade twice.
//
// Deduping on trx_id would be worse than the disease — a split route really
// does send several transfers in one transaction — so a row is dropped only
// when it duplicates the exact action that created it, which leaves two
// genuine equal legs alone. Shared, because every per-account and per-token
// feed in this app hits it and two of them had already got it wrong.
export function dropEchoes(actions) {
  const byTrx = new Map();
  for (const a of actions) {
    if (!byTrx.has(a.trx_id)) byTrx.set(a.trx_id, []);
    byTrx.get(a.trx_id).push(a);
  }
  const seen = new Set();
  return actions.filter(a => {
    const key = `${a.trx_id}:${a.action_ordinal}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (!a.creator_action_ordinal) return true;
    const d = a.act?.data || {};
    const echo = (byTrx.get(a.trx_id) || []).some(b => b !== a
      && b.action_ordinal === a.creator_action_ordinal
      && b.act?.data?.quantity === d.quantity
      && b.act?.data?.from === d.from
      && b.act?.data?.to === d.to);
    return !echo;
  });
}

// What a wallet actually holds of one token. The compound flow reads this
// BETWEEN its two transactions instead of predicting swap output, which is the
// difference between a deposit that lands and one that reverts on a rounding
// error.
export async function balanceOf(account, contract, symbol) {
  const d = await post('get_currency_balance', { code: contract, account, symbol });
  const row = Array.isArray(d) ? d[0] : null;
  return row ? Number(String(row).split(' ')[0]) : 0;
}

// Probe every host once so the first real sweep already knows who is dead.
//
// The probe timeout is deliberately far shorter than a real request's. A health
// check that waits nine seconds on a dead host has spent nine seconds of the
// user's boot to learn something a healthy node answers in 150ms — and it is
// exactly the kind of stall that makes a page look broken. Anything that cannot
// answer get_info promptly is not a host we want leading a sweep anyway.
const PROBE_TIMEOUT = 2500;

export async function warmHosts() {
  return Promise.all(RPC_HOSTS.map(async host => {
    const t0 = Date.now();
    try { await once('get_info', {}, host, PROBE_TIMEOUT); return { host, ms: Date.now() - t0, ok: true }; }
    catch { return { host, ms: Date.now() - t0, ok: false }; }
  }));
}
