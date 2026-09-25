// =============================================================================
// WaxEDGE alert bot — a Cloudflare Worker, Free plan.
//
// Opt-in only. The bot answers people who message it, and sends alerts to the
// chats that asked for them; there is no broadcast, no list of users to write
// to, and nothing here sends a message on anyone's behalf.
//
// What a chat can ask for:
//   wallets   /watch — positions out of range, close to the edge, fees ready to
//             compound, farms starting or ending on their pools, transfers in
//             and out (swaps read as one line), NFTs received, CPU/NET/RAM
//             running out, vote rewards ready to claim; /settings per wallet
//   markets   /alert (price above/below, in USD or WAX), /move (every ±N%),
//             /whale (big swaps in a token), /newpools, /newfarms,
//             /floor (an NFT collection or template listed under a price)
//   daily     /digest at the hour you choose, with /fav tokens in it
//   look-ups  /price /token /top /pools /farms /wallet /res /wax /status
//
// Budget. The Free plan allows 50 outgoing requests, 50 database queries and a
// few milliseconds of CPU per run. The cron runs every minute and each run
// does a small, rotating share of the work under a hard request budget; the
// database is read in one batch and written in one batch. Market data comes
// from the site's own snapshot (data/bot.json, ~90 KB) rather than from the
// megabyte files, and live prices one token at a time from Alcor.
// =============================================================================

const SITE = 'https://waxedge.app';
const ALCOR = 'https://wax.alcor.exchange/api/v2';
const RPC = ['https://wax.greymass.com', 'https://wax.cryptolions.io'];
const HYP = ['https://wax.cryptolions.io', 'https://api.waxsweden.org', 'https://wax.eosusa.io'];
const AA = 'https://wax.api.atomicassets.io';
const LIM = { watch: 5, alerts: 15, favs: 12 };
const ACCOUNT_RE = /^[a-z1-5.]{1,12}$/;
const DAY = 86400e3, HOUR = 3600e3;

// What a watched wallet alerts on, until someone changes it in /settings.
// fees and xfer are dollar thresholds; -1 / 0 switches them off.
const OPT_DEF = { range: 1, edge: 1, fees: 5, farm: 1, xfer: 10, nft: 1, res: 1, claim: 1 };
const OPT_CYCLE = { fees: [0, 1, 5, 25, 100], xfer: [-1, 0, 1, 10, 100, 1000] };
const OPT_NAME = {
  range: 'Out of range / back in range', edge: 'Close to the edge of its range', fees: 'Fees ready to compound',
  farm: 'Farms starting or ending on my pools', xfer: 'Transfers and swaps', nft: 'NFTs in and out',
  res: 'CPU / NET / RAM running low', claim: 'Vote rewards ready to claim',
};

// ------------------------------------------------------------------ budget --
// Every outgoing request goes through here, so a run can never pass the limit:
// past it, a request is simply not made and the job picks up next run.
const budget = (n = 45) => ({ left: n, sends: 0 });
async function get(B, url, { ttl = 0, body = null } = {}) {
  if (B.left <= 0) return null;
  B.left--;
  try {
    const r = await fetch(url, body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : (ttl ? { cf: { cacheTtl: ttl, cacheEverything: true } } : {}));
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
async function chain(B, path, body) {
  for (const h of RPC) { const d = await get(B, `${h}/v1/chain/${path}`, { body }); if (d) return d; }
  return null;
}
async function hyp(B, path) {
  for (const h of HYP.slice(0, 2)) { const d = await get(B, `${h}${path}`); if (d) return d; }
  return null;
}

// ---------------------------------------------------------------- telegram --
async function tg(env, B, method, body) {
  if (B) { if (B.left <= 0) return null; B.left--; }
  try {
    const r = await fetch(`${env.TG_API || 'https://api.telegram.org'}/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return r.ok ? r.json() : null;
  } catch { return null; }
}
const kb = rows => ({ inline_keyboard: rows.filter(r => r.length) });
const btn = (text, data) => ({ text, callback_data: data.slice(0, 64) });
const say = (env, B, chat, text, markup = null) => tg(env, B, 'sendMessage', {
  chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}),
});

// ------------------------------------------------------------------ format --
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Three significant figures below 1, written out: $0.000000186, never 1.86e-7.
const small = v => v.toFixed(Math.min(20, Math.max(2, 2 - Math.floor(Math.log10(Math.abs(v)))))).replace(/(\.\d\d\d*?)0+$/, '$1');
const fmtUsd = v => (v == null || !isFinite(v) ? '—'
  : Math.abs(v) >= 1 ? `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : v === 0 ? '$0' : `$${small(v)}`);
const fmtBig = v => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `$${(v / 1e3).toFixed(1)}k`
  : v >= 1 ? `$${Math.round(v).toLocaleString('en-US')}` : fmtUsd(v));
const fmtAmt = v => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  : v >= 1 ? v.toFixed(2) : v > 0 ? small(v) : '0');
const pct = v => (v == null || !isFinite(v) ? '' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`);
const arrow = v => (v == null ? '' : Math.abs(v) < 0.05 ? '⚪' : v > 0 ? '🟢' : '🔴');
const ago = ms => (ms < HOUR ? `${Math.max(1, Math.round(ms / 60e3))} min` : ms < 2 * DAY ? `${Math.round(ms / HOUR)}h` : `${Math.round(ms / DAY)} days`);
const tokLink = t => `<a href="${SITE}/token/${encodeURIComponent(t.id)}">${esc(t.sym)}</a>`;
const poolLink = (dex, id, label) => `<a href="${SITE}/market/${dex}:${encodeURIComponent(id)}">${esc(label)}</a>`;
const walletLink = (a, label = 'Open on WaxEDGE') => `<a href="${SITE}/wallet/${encodeURIComponent(a)}">${esc(label)}</a>`;
const VENUE = { alcor: 'Alcor', taco: 'Taco', defibox: 'Defibox', adex: 'A-DEX', nefty: 'Nefty' };
const parseQty = q => { const [n, s] = String(q || '').split(' '); return { n: Number(n) || 0, sym: s || '?' }; };
const j = (s, d = {}) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// -------------------------------------------------------------- site data --
// The snapshot's small slice (tools/botdata.mjs): refreshed every two hours for
// prices and farms, every hour for volume. Kept in the isolate for five minutes.
let DATA = null, DATA_AT = 0;
async function data(env, B) {
  if (DATA && Date.now() - DATA_AT < 300e3) return DATA;
  const d = await get(B, env.DATA_URL || `${SITE}/data/bot.json`, { ttl: 300 });
  if (!d) return DATA || { tok: new Map(), bySym: new Map(), pools: [], poolById: new Map(), farms: [], wax: null, at: 0 };
  const tok = new Map(), bySym = new Map();
  for (const [id, usd, ch, liq, vol] of d.t) {
    const [sym, c] = id.split('@');
    const t = { id, sym, c, usd, ch, liq, vol };
    tok.set(id, t);
    if (!bySym.has(sym)) bySym.set(sym, []);
    bySym.get(sym).push(t);
  }
  const pools = d.p.map(([dex, id, a, b, ia, ib, fee, tvl, vol]) => ({ dex, id, a, b, ia, ib, fee, tvl, vol }));
  const farms = d.f.map(([id, dex, pd, pi, rs, apr, end, usdDay, staked]) => ({ id, dex, pd, pi, rs, apr, end, usdDay, staked }));
  DATA = { at: d.at, wax: d.wax, tok, bySym, pools, farms, poolById: new Map(pools.map(p => [`${p.dex}:${p.id}`, p])) };
  DATA_AT = Date.now();
  return DATA;
}
const poolsOf = (D, id) => D.pools.filter(p => p.ia === id || p.ib === id);

// A symbol to one token. Several contracts issue the same symbol; the one with
// the most liquidity is the one people mean, and SYM@contract picks exactly.
async function resolve(env, B, input) {
  const D = await data(env, B);
  const [s, c] = String(input || '').split('@');
  const sym = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!sym) return null;
  if (c) { const id = `${sym}@${c.toLowerCase()}`; return D.tok.get(id) || { id, sym, c: c.toLowerCase(), usd: null, ch: null, liq: 0, vol: 0 }; }
  const hit = D.bySym.get(sym);
  if (hit?.length) return { ...hit[0], others: hit.length - 1 };
  // Not priced by the snapshot: Alcor's own list knows newer tokens.
  const all = await get(B, `${ALCOR}/tokens`, { ttl: 3600 });
  const m = (all || []).filter(t => t.symbol === sym && !t.is_scam)
    .sort((a, b) => (b.is_trusted - a.is_trusted) || ((b.score || 0) - (a.score || 0)))[0];
  return m ? { id: `${m.symbol}@${m.contract}`, sym: m.symbol, c: m.contract, usd: Number(m.usd_price) || null, ch: null, liq: 0, vol: 0 } : null;
}
// The price right now, in dollars and in WAX, from Alcor.
async function live(B, t) {
  const d = await get(B, `${ALCOR}/tokens/${encodeURIComponent(`${t.sym.toLowerCase()}-${t.c}`)}`, { ttl: 60 });
  if (!d || !(Number(d.usd_price) > 0)) return null;
  return { usd: Number(d.usd_price), wax: Number(d.system_price) || null };
}

// ------------------------------------------------------------------ wallets --
async function positions(B, account) {
  const rows = await get(B, `${ALCOR}/account/${encodeURIComponent(account)}/positions`, { ttl: 60 });
  if (!Array.isArray(rows)) return null;
  return rows.filter(p => !p.closed).map(p => {
    const A = parseQty(p.amountA), Bq = parseQty(p.amountB), fA = parseQty(p.feesA), fB = parseQty(p.feesB);
    return { id: String(p.id), pool: String(p.pool), pair: `${A.sym}/${Bq.sym}`, inRange: !!p.inRange,
      value: Number(p.totalValue) || 0, a: A.n, b: Bq.n, fa: fA.n, fb: fB.n, symA: A.sym, symB: Bq.sym };
  }).sort((a, b) => b.value - a.value);
}
// Fees in dollars, and how lopsided the position is, from the snapshot's prices.
function valued(D, p) {
  const pool = D.poolById.get(`alcor:${p.pool}`);
  const pa = pool ? D.tok.get(pool.ia)?.usd : null, pb = pool ? D.tok.get(pool.ib)?.usd : null;
  const fees = pa != null && pb != null ? p.fa * pa + p.fb * pb : null;
  const va = pa != null ? p.a * pa : null, vb = pb != null ? p.b * pb : null;
  const shareA = va != null && vb != null && va + vb > 0 ? va / (va + vb) : null;
  return { fees, shareA };
}
function summary(D, acct, pos) {
  if (!pos.length) return `<b>${esc(acct)}</b> has no open Alcor positions.\n${walletLink(acct)}`;
  const total = pos.reduce((t, p) => t + p.value, 0);
  const out = pos.filter(p => !p.inRange);
  const feesAll = pos.reduce((t, p) => t + (valued(D, p).fees || 0), 0);
  const big = pos.filter(p => p.value >= 1 || !p.inRange), dust = pos.filter(p => p.value < 1 && p.inRange);
  const line = p => {
    const f = valued(D, p).fees;
    return `${p.inRange ? '✅' : '⚠️'} ${poolLink('alcor', p.pool, p.pair)} · ${fmtUsd(p.value)}${f >= 0.01 ? ` · fees ${fmtUsd(f)}` : ''}`;
  };
  const lines = [
    `<b>${esc(acct)}</b> — ${pos.length} position${pos.length === 1 ? '' : 's'} · <b>${fmtUsd(total)}</b>${feesAll >= 0.01 ? ` · ${fmtUsd(feesAll)} in fees waiting` : ''}`,
    out.length ? `<b>${out.length} out of range</b> — earning nothing until the price returns.` : 'All in range.',
    '', ...big.slice(0, 12).map(line),
  ];
  if (big.length > 12) lines.push(`… and ${big.length - 12} more`);
  if (dust.length) lines.push(`+ ${dust.length} under $1`);
  lines.push('', walletLink(acct));
  return lines.join('\n');
}
async function account(B, a) { return chain(B, 'get_account', { account_name: a }); }
function resources(acc) {
  const r = l => (l && l.max > 0 ? Math.min(1, (l.current_used ?? l.used) / l.max) : 0);
  const vi = acc.voter_info || {};
  const last = Date.parse(`${String(vi.last_claim_time || '1970-01-01T00:00:00').replace(/Z?$/, 'Z')}`) || 0;
  return {
    cpu: r(acc.cpu_limit), net: r(acc.net_limit), ram: acc.ram_quota > 0 ? acc.ram_usage / acc.ram_quota : 0,
    ramFree: Math.max(0, (acc.ram_quota || 0) - (acc.ram_usage || 0)),
    staked: (Number(vi.staked) || 0) / 1e8, voting: !!((vi.producers || []).length || vi.proxy), lastClaim: last,
    liquid: parseQty(acc.core_liquid_balance).n,
  };
}
const bar = v => `${'▰'.repeat(Math.round(v * 10))}${'▱'.repeat(10 - Math.round(v * 10))} ${(v * 100).toFixed(0)}%`;

// ---------------------------------------------------------------- transfers --
// One wallet's transfers, read as events: a transaction that both sends and
// receives tokens is a swap and reads as one line; NFTs are their own kind.
// Shared by the wallet watch, /track and /tx, so all three read alike.
function eventsFrom(D, a, actions) {
  const byTrx = new Map();
  for (const x of actions) {
    const dt = x.act?.data || {};
    if (dt.from === dt.to || (dt.from !== a && dt.to !== a)) continue;
    if (!byTrx.has(x.trx_id)) byTrx.set(x.trx_id, []);
    byTrx.get(x.trx_id).push(x);
  }
  const events = [];
  for (const [trx, xs] of byTrx) {
    const at = Date.parse(`${String(xs[0].timestamp || '').replace(/Z?$/, 'Z')}`) || 0;
    const seq = Math.max(...xs.map(x => Number(x.global_sequence) || 0));
    const tok = [], nft = [];
    for (const x of xs) {
      const dt = x.act.data;
      if (Array.isArray(dt.asset_ids)) { nft.push({ in: dt.to === a, n: dt.asset_ids.length, who: dt.to === a ? dt.from : dt.to, memo: dt.memo || '' }); continue; }
      const q = parseQty(dt.quantity);
      const id = `${q.sym}@${x.act.account}`;
      const t = D.tok.get(id);
      tok.push({ in: dt.to === a, n: q.n, sym: q.sym, id, t, usd: t ? q.n * t.usd : null, who: dt.to === a ? dt.from : dt.to, memo: dt.memo || '' });
    }
    const ins = tok.filter(x => x.in), outs = tok.filter(x => !x.in);
    const name = x => `${fmtAmt(x.n)} ${x.t ? tokLink(x.t) : esc(x.sym)}`;
    const base = { at, trx, seq };
    if (ins.length && outs.length) {
      const priced = ins.some(x => x.usd != null) || outs.some(x => x.usd != null);
      const usd = priced ? Math.max(ins.reduce((t, x) => t + (x.usd || 0), 0), outs.reduce((t, x) => t + (x.usd || 0), 0)) : null;
      events.push({ ...base, kind: 'swap', usd, ids: new Set(tok.map(x => x.id)), syms: new Set(tok.map(x => x.sym)),
        parties: new Set(tok.map(x => x.who)), memo: tok.map(x => x.memo).join(' '),
        text: `🔁 Swapped ${outs.map(name).join(' + ')} → ${ins.map(name).join(' + ')}${usd != null ? ` (${fmtUsd(usd)})` : ''}` });
    } else {
      for (const x of tok) {
        events.push({ ...base, kind: x.in ? 'in' : 'out', usd: x.usd, ids: new Set([x.id]), syms: new Set([x.sym]), parties: new Set([x.who]), memo: x.memo,
          text: `${x.in ? '📥 Received' : '📤 Sent'} ${name(x)}${x.usd != null ? ` (${fmtUsd(x.usd)})` : ''} ${x.in ? 'from' : 'to'} <code>${esc(x.who)}</code>${x.memo && x.memo.length <= 60 ? ` — “${esc(x.memo)}”` : ''}` });
      }
    }
    for (const x of nft) {
      events.push({ ...base, kind: 'nft', usd: null, ids: new Set(), syms: new Set(), parties: new Set([x.who]), memo: x.memo, dir: x.in ? 'in' : 'out',
        text: `🖼 ${x.in ? 'Received' : 'Sent'} ${x.n} NFT${x.n === 1 ? '' : 's'} ${x.in ? 'from' : 'to'} <code>${esc(x.who)}</code>` });
    }
  }
  return events.sort((x, y) => x.seq - y.seq);
}

// The filter language shared by /tx and /track, e.g.
//   CHEESE in >50 from:liquidcheese memo:fee     swaps     nfts out
async function parseFilter(env, B, words) {
  const f = {};
  for (const w0 of words) {
    const w = w0.trim(); const lw = w.toLowerCase();
    if (!w) continue;
    if (['in', 'received', 'incoming'].includes(lw)) f.dir = 'in';
    else if (['out', 'sent', 'outgoing'].includes(lw)) f.dir = 'out';
    else if (['swap', 'swaps'].includes(lw)) f.kind = 'swap';
    else if (['nft', 'nfts'].includes(lw)) f.kind = 'nft';
    else if (/^(>|>=|\$|min:?)\d/.test(lw) || /^\d+(\.\d+)?\$$/.test(lw)) f.min = Number(lw.replace(/[^0-9.]/g, ''));
    else if (/^(from|to|with):[a-z1-5.]{1,12}$/.test(lw)) { const [k, v] = lw.split(':'); f.party = v; f.partyDir = k === 'from' ? 'in' : k === 'to' ? 'out' : null; }
    else if (/^memo:/.test(lw)) f.memo = w.slice(5).toLowerCase();
    else {
      const t = await resolve(env, B, w);
      if (!t) return { error: `I do not understand “${esc(w)}” — not a token, and not a filter word.` };
      f.tok = t.id; f.sym = t.sym;
    }
  }
  return f;
}
function matches(e, f) {
  if (f.kind && e.kind !== f.kind) return false;
  if (f.dir && !(e.kind === f.dir || (e.kind === 'nft' && e.dir === f.dir))) return false;
  if (f.tok && !e.ids.has(f.tok)) return false;
  if (f.min && !(e.usd != null && e.usd >= f.min)) return false;
  if (f.party && !e.parties.has(f.party)) return false;
  if (f.partyDir && e.kind !== 'swap' && !(e.kind === f.partyDir || e.dir === f.partyDir)) return false;
  if (f.memo && !String(e.memo || '').toLowerCase().includes(f.memo)) return false;
  return true;
}
const filterText = f => [f.kind === 'swap' ? 'swaps' : f.kind === 'nft' ? 'NFTs' : '', f.dir ? (f.dir === 'in' ? 'incoming' : 'outgoing') : '',
  f.sym ? esc(f.sym) : '', f.min ? `≥ ${fmtUsd(f.min)}` : '', f.party ? `${f.partyDir === 'in' ? 'from' : f.partyDir === 'out' ? 'to' : 'with'} ${esc(f.party)}` : '',
  f.memo ? `memo “${esc(f.memo)}”` : ''].filter(Boolean).join(' · ') || 'everything';
// The server narrows what it can — counterparty and token contract — and the
// rest is filtered here.
function txQuery(a, f, tokContract, limit) {
  const q = new URLSearchParams({ account: a, limit: String(limit), sort: 'desc' });
  q.set('filter', f.kind === 'nft' ? 'atomicassets:transfer' : tokContract ? `${tokContract}:transfer` : '*:transfer');
  if (f.party && f.partyDir === 'in') q.set('transfer.from', f.party);
  if (f.party && f.partyDir === 'out') q.set('transfer.to', f.party);
  return `/v2/history/get_actions?${q}`;
}

// --------------------------------------------------------------- liquidity --
// Liquidity going in or out, from the contracts' own records: Alcor logs every
// deposit (logmint) and withdrawal (logburn) with exact amounts and the pool's
// reserves after; TacoSwap only records the LP amount, which is turned into
// the two tokens with the pair's supply and reserves.
const codeKey = code => { let v = 0n; for (let i = 0; i < code.length; i++) v |= BigInt(code.charCodeAt(i)) << BigInt(8 * i); return v.toString(); };
async function alcorPoolInfo(B, D, pid) {
  const known = D.poolById.get(`alcor:${pid}`);
  if (known) return known;
  const pr = (await chain(B, 'get_table_rows', { code: 'swap.alcor', scope: 'swap.alcor', table: 'pools', json: true, limit: 1, lower_bound: String(pid) }))?.rows?.[0];
  if (!pr || String(pr.id) !== String(pid)) return null;
  const a = parseQty(pr.tokenA.quantity), b = parseQty(pr.tokenB.quantity);
  return { dex: 'alcor', id: String(pid), a: a.sym, b: b.sym, ia: `${a.sym}@${pr.tokenA.contract}`, ib: `${b.sym}@${pr.tokenB.contract}`, fee: pr.fee / 100, tvl: null };
}
async function liqEvent(B, D, x) {
  const d = x.act.data, name = x.act.name;
  const at = Date.parse(`${String(x.timestamp || '').replace(/Z?$/, 'Z')}`) || 0;
  if (x.act.account === 'swap.alcor') {
    const pl = await alcorPoolInfo(B, D, d.poolId);
    if (!pl) return null;
    const qa = parseQty(d.tokenA), qb = parseQty(d.tokenB), ra = parseQty(d.reserveA), rb = parseQty(d.reserveB);
    const pa = D.tok.get(pl.ia)?.usd, pb = D.tok.get(pl.ib)?.usd;
    const usd = pa != null && pb != null ? qa.n * pa + qb.n * pb : pa != null ? qa.n * pa * 2 : pb != null ? qb.n * pb * 2 : null;
    const after = pa != null && pb != null ? ra.n * pa + rb.n * pb : null;
    return { at, seq: Number(x.global_sequence), add: name === 'logmint', dex: 'alcor', pool: pl, who: d.owner, a: qa.n, b: qb.n, usd, after,
      range: Math.abs(d.tickLower) >= 443000 && Math.abs(d.tickUpper) >= 443000 ? 'full range' : 'a range' };
  }
  // TacoSwap: LP amount → share of the pair, from the pair as it is now.
  const q = parseQty(name === 'addliquidity' ? d.to_buy : d.to_sell);
  const r = (await chain(B, 'get_table_rows', { code: 'swap.taco', scope: 'swap.taco', table: 'pairs', json: true, limit: 1, lower_bound: codeKey(q.sym) }))?.rows?.[0];
  if (!r || r.id !== q.sym) return null;
  const sup = parseQty(r.supply).n, A = parseQty(r.pool1.quantity), Bq = parseQty(r.pool2.quantity);
  if (!(sup > 0)) return null;
  const share = q.n / sup;
  const pl = { dex: 'taco', id: r.id, a: A.sym, b: Bq.sym, ia: `${A.sym}@${r.pool1.contract}`, ib: `${Bq.sym}@${r.pool2.contract}` };
  const pa = D.tok.get(pl.ia)?.usd, pb = D.tok.get(pl.ib)?.usd;
  const a = A.n * share, b = Bq.n * share;
  const usd = pa != null && pb != null ? a * pa + b * pb : pa != null ? a * pa * 2 : pb != null ? b * pb * 2 : null;
  const after = pa != null ? A.n * pa * 2 : pb != null ? Bq.n * pb * 2 : null;
  return { at, seq: Number(x.global_sequence), add: name === 'addliquidity', dex: 'taco', pool: pl, who: d.user, a, b, usd, after, range: 'full range' };
}
const liqText = e => `${e.add ? '💧 <b>Added</b>' : '🔻 <b>Removed</b>'} ${e.usd != null ? `<b>${fmtUsd(e.usd)}</b> ` : ''}${e.add ? 'to' : 'from'} ${poolLink(e.dex, e.pool.id, `${e.pool.a}/${e.pool.b}`)} ${VENUE[e.dex]}
   ${fmtAmt(e.a)} ${esc(e.pool.a)} + ${fmtAmt(e.b)} ${esc(e.pool.b)} · ${e.range} · <code>${esc(e.who)}</code>${e.after != null ? ` · pool now ${fmtBig(e.after)}` : ''}`;
const LIQ_FEEDS = [['swap.alcor:logmint', 'lq:m'], ['swap.alcor:logburn', 'lq:b'], ['swap.taco:addliquidity', 'lq:ta'], ['swap.taco:remliquidity', 'lq:tr']];

// --------------------------------------------------------------- database --
const DB = env => env.DB;
async function chatRow(env, chat) {
  await DB(env).prepare('INSERT OR IGNORE INTO chats (chat_id, created) VALUES (?, ?)').bind(chat, Date.now()).run();
  return DB(env).prepare('SELECT * FROM chats WHERE chat_id = ?').bind(chat).first();
}
const countAlerts = async (env, chat) => (await DB(env).prepare('SELECT COUNT(*) AS n FROM alerts WHERE chat_id = ?').bind(chat).first()).n;
async function addAlert(env, chat, kind, target, label, params, state = {}) {
  if (await countAlerts(env, chat) >= LIM.alerts) return `This chat has ${LIM.alerts} alerts already. /alerts to remove one.`;
  const dup = await DB(env).prepare('SELECT id FROM alerts WHERE chat_id = ? AND kind = ? AND target = ? AND params = ?')
    .bind(chat, kind, target, JSON.stringify(params)).first();
  if (dup) return 'That alert is set already.';
  await DB(env).prepare('INSERT INTO alerts (chat_id, kind, target, label, params, state, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(chat, kind, target, label, JSON.stringify(params), JSON.stringify(state), Date.now()).run();
  return null;
}
const optsOf = w => ({ ...OPT_DEF, ...j(w.opts) });
// Watch state: r range, e near-edge, f fees, fe farm-ending, rs resources,
// cl day a claim reminder went out, nv not-voting nudge, pl pools held.
// The first version stored { posId: 1|0 } flat; read that as r.
function stateOf(w) {
  const s = j(w.state);
  if (!s.r && Object.keys(s).length && Object.keys(s).every(k => /^\d+$/.test(k))) return { r: s };
  return { r: {}, e: {}, f: {}, fe: {}, rs: {}, ...s };
}

// ------------------------------------------------------------ token cards --
async function tokenCard(env, B, t, { full = true } = {}) {
  const D = await data(env, B);
  const lv = await live(B, t);
  const usd = lv?.usd ?? t.usd;
  const lines = [`<b>${tokLink(t)}</b> · <code>${esc(t.c)}</code>`,
    `<b>${fmtUsd(usd)}</b>${lv?.wax && t.sym !== 'WAX' ? ` · ${fmtAmt(lv.wax)} WAX` : ''}${t.ch != null ? ` · 24h ${arrow(t.ch)} ${pct(t.ch)}` : ''}`];
  if (t.liq || t.vol) lines.push(`Liquidity ${fmtBig(t.liq || 0)} · volume 24h ${fmtBig(t.vol || 0)}`);
  if (full) {
    const ps = poolsOf(D, t.id).slice(0, 3);
    if (ps.length) lines.push('', '<b>Deepest pools</b>', ...ps.map(p => `• ${poolLink(p.dex, p.id, `${p.a}/${p.b}`)} ${VENUE[p.dex] || p.dex} ${(p.fee / 100).toFixed(2)}% · ${fmtBig(p.tvl)}`));
    const fs = D.farms.filter(f => f.rs === t.sym);
    if (fs.length) lines.push(`🌾 ${fs.length} live farm${fs.length === 1 ? ' pays' : 's pay'} in ${esc(t.sym)} — /farms ${esc(t.sym)}`);
  }
  if (t.others) lines.push(`<i>${t.others} other token${t.others === 1 ? '' : 's'} use this symbol; this is the most liquid. Use SYM@contract for another.</i>`);
  return { text: lines.join('\n'), markup: kb([
    [btn('🔔 Price alert', `mn:pa:${t.id}`), btn('📊 Every ±10%', `mv:${t.id}`), btn('🐋 Big swaps', `wh:${t.id}`)],
    [btn('💧 Liquidity', `m:/liquidity ${t.id}`), btn('👥 Holders', `m:/holders ${t.id}`), btn('🌾 Farms', `m:/farms ${t.id}`)],
    [btn('⭐ Favourite', `fv:${t.id}`), btn('💧 Alert on liquidity moves', `m:/liq ${t.id}`)],
  ]) };
}

// ----------------------------------------------------------------- help ---
const HELP = [
  '<b>WaxEDGE</b> — alerts and look-ups for WAX DeFi',
  '',
  '<b>👛 Your wallet</b>',
  '/watch <i>account</i> — positions out of range or near the edge, fees to compound, farms on your pools, transfers and swaps, NFTs, CPU/RAM, vote rewards',
  '/settings <i>account</i> — choose which of those',
  '/status · /wallet <i>account</i> · /res <i>account</i>',
  '',
  '<b>📈 Markets</b>',
  '/price <i>SYM</i> · /top · /pools <i>SYM</i> · /farms [<i>SYM</i>] · /wax',
  '/alert <i>SYM</i> above|below <i>price</i> [wax]',
  '/move <i>SYM</i> [<i>10</i>] — every ±10% move',
  '/whale <i>SYM</i> [<i>250</i>] — swaps above $250',
  '/newpools [<i>SYM</i>] · /newfarms [<i>SYM</i>]',
  '',
  '<b>🔎 Any account</b>',
  '/tx <i>account</i> [filters] — its transfers, filtered',
  '/track <i>account</i> [filters] — alert when it moves',
  '  filters: <i>SYM</i> · in · out · swaps · nfts · &gt;100 · from:<i>acct</i> · to:<i>acct</i> · memo:<i>text</i>',
  '/nfts <i>account</i> · /holders <i>SYM</i>',
  '',
  '<b>💧 Liquidity</b>',
  '/liquidity <i>SYM</i> — where it sits, recent adds and removes',
  '/liq <i>SYM</i> [<i>min $</i>] [add|remove] — alert on every move · /liq all 1000',
  '/liq <i>SYM</i> above|below <i>$</i> — total crosses a line · /pool <i>id</i>',
  '/floor <i>collection</i> [<i>template</i>] below <i>WAX</i>',
  '',
  '<b>☀️ Daily</b>',
  '/digest <i>8</i> [<i>+2</i>] — a morning summary at 08:00 (UTC+2)',
  '/fav <i>SYM</i> · /favs — your price board',
  '',
  '/alerts — everything this chat gets · /mute <i>8h</i> · /stop',
].join('\n');

// ----------------------------------------------------------------- buttons --
// Nobody should have to remember a command. A keyboard stays at the bottom of
// a private chat; every menu is tap-through; and anything that needs an input
// — an account, a token — is asked as a question the person simply answers.
// What they already watch or favourite comes back as buttons of its own.
const KEYS = {
  '📈 Markets': 'markets', '👛 Wallets': 'wallets', '🔔 Alerts': 'alerts', '💧 Liquidity': 'liquidity',
  '🔎 Look up': 'lookup', '☀️ Daily': 'daily', '❓ FAQ': 'faq', '☰ Menu': 'main',
};
const KEYBOARD = { keyboard: [['📈 Markets', '👛 Wallets'], ['🔔 Alerts', '💧 Liquidity'], ['🔎 Look up', '☀️ Daily'], ['❓ FAQ', '☰ Menu']],
  resize_keyboard: true, is_persistent: true };
const back = (to = 'main') => [btn('⬅️ Back', `mn:${to}`)];
// What a question is waiting for: an action, answered by the next message.
const ASKS = {
  '/watch': ['Which WAX account should I watch?', 'e.g. myaccount.wam'],
  '/wallet': ['Which account?', 'e.g. myaccount.wam'],
  '/price': ['Which token?', 'e.g. CHEESE, TLM or SYM@contract'],
  '/fav': ['Which token should be a favourite?', 'e.g. CHEESE'],
  '/move': ['Which token? I will write every time it moves 10%.', 'e.g. CHEESE'],
  '/whale': ['Which token? I will show every swap above $250.', 'e.g. TLM'],
  '/liq': ['Which token? I will tell you every time liquidity goes in or out of its pools.', 'e.g. CHEESE'],
  '/liquidity': ['Which token?', 'e.g. CHEESE'],
  '/holders': ['Which token?', 'e.g. CHEESE'],
  '/nfts': ['Which account?', 'e.g. myaccount.wam'],
  '/pool': ['Which Alcor pool number? It is the number at the end of the pool’s link.', 'e.g. 1252'],
  '/track': ['Which account should I follow? You can add filters after it, e.g. “somewhale out >500”.', 'account [filters]'],
  '/floor': ['Which collection, and below what price in WAX? e.g. “alien.worlds below 5” — add a template number to narrow it: “alien.worlds 19552 below 5”.', 'collection below WAX'],
  '#alert': ['Which token should the price alert be for?', 'e.g. CHEESE'],
  '#tx': ['Whose transfers?', 'e.g. myaccount.wam'],
  '#liqlvl': ['Which token, and what total? e.g. “CHEESE above 10000” or “CHEESE below 2000”.', 'TOKEN above|below dollars'],
};
async function ask(env, B, chat, action, extra = '') {
  const [q, ph] = ASKS[action.split(':')[0]] || ['Type your answer:', ''];
  await DB(env).prepare('UPDATE chats SET pending = ?, pending_at = ? WHERE chat_id = ?').bind(action, Date.now(), chat).run();
  return say(env, B, chat, `✏️ ${extra || q}`, { force_reply: true, input_field_placeholder: ph.slice(0, 64) });
}
// The answer to a question: run what it was waiting for.
async function answer(env, B, chat, action, text, isPrivate) {
  await DB(env).prepare("UPDATE chats SET pending = '' WHERE chat_id = ?").bind(chat).run();
  const t0 = text.trim();
  if (action === '#alert') {
    const t = await resolve(env, B, t0.split(/\s+/)[0]);
    if (!t) return say(env, B, chat, `No token <b>${esc(t0.toUpperCase())}</b> that I know.`, kb([[btn('✏️ Try again', 'ask:#alert')]]));
    return menu(env, B, chat, `pa:${t.id}`);
  }
  if (action.startsWith('#alertx:')) {
    const id = action.slice(8), t = await resolve(env, B, id);
    const words = t0.toLowerCase().split(/\s+/);
    let dir = words.find(w => w === 'above' || w === 'below');
    const value = Number((words.find(w => /^\$?\d/.test(w)) || '').replace(/[$,]/g, ''));
    const unit = words.includes('wax') ? 'wax' : 'usd';
    if (!(value > 0)) return say(env, B, chat, 'I need a price, like <code>0.012</code> or <code>1.5 wax</code>.', kb([[btn('✏️ Try again', `ax:${id}`)]]));
    if (!dir) { const lv = await live(B, t); const nowV = unit === 'wax' ? lv?.wax : lv?.usd; dir = nowV != null && value < nowV ? 'below' : 'above'; }
    return command(env, B, chat, `/alert ${id} ${dir} ${value}${unit === 'wax' ? ' wax' : ''}`, { isPrivate });
  }
  if (action === '#tx') {
    const a = t0.toLowerCase().split(/\s+/)[0];
    if (!ACCOUNT_RE.test(a)) return say(env, B, chat, 'That is not a WAX account name.', kb([[btn('✏️ Try again', 'ask:#tx')]]));
    return menu(env, B, chat, `tx:${a}`);
  }
  if (action === '#liqlvl') return command(env, B, chat, `/liq ${t0}`, { isPrivate });
  return command(env, B, chat, `${action} ${t0}`, { isPrivate });
}

// ---- the menus --------------------------------------------------------------
async function menu(env, B, chat, name, edit = null) {
  const [key, ...rest] = name.split(':');
  const arg = rest.join(':');
  const c = await chatRow(env, chat);
  const watched = (await DB(env).prepare('SELECT account FROM watches WHERE chat_id = ?').bind(chat).all()).results.map(r => r.account);
  let text, rows;
  switch (key) {
    case 'main':
      text = '<b>WaxEDGE</b> — what would you like?';
      rows = [[btn('📈 Markets', 'mn:markets'), btn('👛 Wallets', 'mn:wallets')],
        [btn('🔔 Alerts', 'mn:alerts'), btn('💧 Liquidity', 'mn:liquidity')],
        [btn('🔎 Look up an account', 'mn:lookup'), btn('☀️ Daily', 'mn:daily')],
        [btn('❓ FAQ', 'mn:faq'), btn('⚙️ This chat', 'mn:chat')]];
      break;
    case 'markets': {
      const favs = j(c.favs, []);
      text = `📈 <b>Markets</b>${favs.length ? '\nYour favourites — tap one for its card:' : ''}`;
      const fb = favs.map(id => btn(`⭐ ${id.split('@')[0]}`, `tk:${id}`));
      rows = [];
      for (let i = 0; i < fb.length; i += 4) rows.push(fb.slice(i, i + 4));
      rows.push([btn('🔍 Price of a token', 'ask:/price')],
        [btn('📈 Top movers', 'm:/top'), btn('🌾 Best farms', 'm:/farms'), btn('💲 WAX', 'm:/wax')],
        [btn('⭐ Favourites board', 'm:/favs'), btn('➕ Add a favourite', 'ask:/fav')], back());
      break;
    }
    case 'wallets':
      text = watched.length ? '👛 <b>Wallets</b> — tap one:' : '👛 <b>Wallets</b>\nWatch your wallet and I will tell you when a position leaves its range, fees are ready to compound, money moves, or CPU runs low.';
      rows = [...watched.map(a => [btn(`👛 ${a}`, `mn:w:${a}`)]),
        [btn('➕ Watch a wallet', 'ask:/watch')], [btn('👀 Look at any wallet', 'ask:/wallet')], back()];
      break;
    case 'w':
      text = `👛 <b>${esc(arg)}</b>`;
      rows = [[btn('📊 Positions', `m:/status ${arg}`), btn('💰 Value', `m:/wallet ${arg}`), btn('⚙️ CPU / RAM', `m:/res ${arg}`)],
        [btn('🧾 Transfers', `mn:tx:${arg}`), btn('🖼 NFTs', `m:/nfts ${arg}`)],
        watched.includes(arg) ? [btn('🔔 Which alerts', `s:${arg}`), btn('❌ Stop watching', `mn:unw:${arg}`)] : [btn('👀 Watch this wallet', `m:/watch ${arg}`)],
        back('wallets')];
      break;
    case 'unw':
      text = `Stop watching <b>${esc(arg)}</b>?`;
      rows = [[btn('Yes, stop', `m:/unwatch ${arg}`), btn('No', `mn:w:${arg}`)]];
      break;
    case 'tx':
      text = `🧾 <b>Transfers of ${esc(arg)}</b> — which ones?`;
      rows = [[btn('All', `m:/tx ${arg}`), btn('📥 In', `m:/tx ${arg} in`), btn('📤 Out', `m:/tx ${arg} out`)],
        [btn('🔁 Swaps', `m:/tx ${arg} swaps`), btn('🖼 NFTs', `m:/tx ${arg} nfts`), btn('💵 Over $100', `m:/tx ${arg} >100`)],
        [btn('✏️ My own filter', `ax2:${arg}`)],
        [btn('🔎 Alert me on every move', `m:/track ${arg}`)], [btn('🔎 Alert me on moves over $100', `m:/track ${arg} >100`)],
        back('lookup')];
      break;
    case 'alerts':
      text = '🔔 <b>Alerts</b> — what should I tell you about?';
      rows = [[btn('📋 My alerts', 'm:/alerts')],
        [btn('🔔 A price', 'ask:#alert'), btn('📊 Every ±10% move', 'ask:/move')],
        [btn('🐋 Big swaps', 'ask:/whale'), btn('💧 Liquidity moves', 'ask:/liq')],
        [btn('🆕 New pools', 'm:/newpools'), btn('🌾 New farms', 'm:/newfarms')],
        [btn('🔎 An account moving', 'ask:/track'), btn('🖼 NFT floor', 'ask:/floor')],
        [btn('👛 My wallet', 'mn:wallets'), btn('🔕 Mute', 'mn:mute')], back()];
      break;
    case 'pa': {
      const t = await resolve(env, B, arg);
      if (!t) { text = 'Unknown token.'; rows = [back('alerts')]; break; }
      const lv = await live(B, t);
      text = `🔔 <b>${tokLink(t)}</b> is ${fmtUsd(lv?.usd ?? t.usd)}${lv?.wax ? ` (${fmtAmt(lv.wax)} WAX)` : ''}.\nTell me once when it is…`;
      rows = [[btn('+10%', `pa:${t.id}:10`), btn('+25%', `pa:${t.id}:25`), btn('+50%', `pa:${t.id}:50`), btn('×2', `pa:${t.id}:100`)],
        [btn('−10%', `pa:${t.id}:-10`), btn('−25%', `pa:${t.id}:-25`), btn('−50%', `pa:${t.id}:-50`)],
        [btn('✏️ An exact price', `ax:${t.id}`)], [btn('📊 Instead: every ±10%', `mv:${t.id}`)], back('alerts')];
      break;
    }
    case 'mute':
      text = c.mute_until > Date.now() ? `🔕 Muted until ${new Date(c.mute_until).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : '🔕 Pause all alerts for…';
      rows = [[btn('1 hour', 'm:/mute 1h'), btn('8 hours', 'm:/mute 8h'), btn('1 day', 'm:/mute 1d'), btn('1 week', 'm:/mute 7d')],
        [btn('🔔 Unmute', 'm:/mute off')], back('alerts')];
      break;
    case 'liquidity':
      text = '💧 <b>Liquidity</b>';
      rows = [[btn('💧 Where is a token’s liquidity?', 'ask:/liquidity')],
        [btn('🔔 Alert me when a token’s liquidity moves', 'ask:/liq')],
        [btn('🐋 Any pool, $1,000+', 'm:/liq all 1000'), btn('🐋 Any pool, $10,000+', 'm:/liq all 10000')],
        [btn('📏 When a token’s total crosses a line', 'ask:#liqlvl')],
        [btn('🏊 One Alcor pool', 'ask:/pool')], back()];
      break;
    case 'lookup':
      text = '🔎 <b>Look up</b> — any account, any token';
      rows = [[btn('🧾 Transfers of an account', 'ask:#tx')], [btn('🔎 Follow an account', 'ask:/track')],
        [btn('💰 Wallet value', 'ask:/wallet'), btn('🖼 NFTs', 'ask:/nfts')],
        [btn('👥 Token holders', 'ask:/holders'), btn('🏊 Alcor pool', 'ask:/pool')], back()];
      break;
    case 'daily':
      text = `☀️ <b>Daily</b>${c.digest_hour >= 0 ? `\nYour digest comes at ${String(c.digest_hour).padStart(2, '0')}:00 (UTC${c.tz >= 0 ? '+' : '−'}${Math.abs(c.tz / 60)}).` : '\nA morning message with WAX, your favourites, your wallets and the day’s movers.'}`;
      rows = [[btn(c.digest_hour >= 0 ? '🕗 Change the time' : '☀️ Turn the digest on', 'mn:dg')],
        ...(c.digest_hour >= 0 ? [[btn('Turn it off', 'm:/digest off')]] : []),
        [btn('⭐ Favourites board', 'm:/favs'), btn('➕ Add a favourite', 'ask:/fav')], back()];
      break;
    case 'dg':
      text = '🕗 At what time?';
      rows = [[6, 7, 8, 9].map(h => btn(`${String(h).padStart(2, '0')}:00`, `mn:dgh:${h}`)), [10, 12, 18, 21].map(h => btn(`${h}:00`, `mn:dgh:${h}`)), back('daily')];
      break;
    case 'dgh':
      text = `🌍 ${String(arg).padStart(2, '0')}:00 in which time zone?`;
      rows = [[btn('UTC', `m:/digest ${arg} +0`), btn('UTC+1 (winter CET)', `m:/digest ${arg} +1`)],
        [btn('UTC+2 (summer CEST)', `m:/digest ${arg} +2`), btn('UTC+3', `m:/digest ${arg} +3`)],
        [btn('UTC−5 (New York)', `m:/digest ${arg} -5`), btn('UTC−8 (LA)', `m:/digest ${arg} -8`)],
        [btn('UTC+8 (Asia)', `m:/digest ${arg} +8`), btn('UTC+10 (Sydney)', `m:/digest ${arg} +10`)], back('dg')];
      break;
    case 'chat':
      text = '⚙️ <b>This chat</b>';
      rows = [[btn('📋 Everything I send here', 'm:/alerts')], [btn('🔕 Mute', 'mn:mute')], [btn('🗑 Forget this chat', 'mn:stop')], back()];
      break;
    case 'stop':
      text = 'Forget this chat? Every watched wallet, alert, favourite and the digest are deleted.';
      rows = [[btn('Yes, forget everything', 'm:/stop'), btn('No', 'mn:chat')]];
      break;
    case 'faq':
      text = '❓ <b>FAQ</b> — tap a question';
      rows = [...FAQ.map((f, i) => [btn(f[0], `mn:fq:${i}`)]), back()];
      break;
    case 'fq': {
      const f = FAQ[Number(arg)] || FAQ[0];
      text = `❓ <b>${esc(f[0])}</b>\n\n${f[1]}`;
      rows = [...(f[2] ? [f[2]] : []), back('faq')];
      break;
    }
    default:
      return menu(env, B, chat, 'main', edit);
  }
  const markup = kb(rows);
  if (edit) return tg(env, B, 'editMessageText', { chat_id: chat, message_id: edit, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup });
  return say(env, B, chat, text, markup);
}

// ---- FAQ ------------------------------------------------------------------
// [question, answer (HTML), optional row of buttons]
const FAQ = [
  ['What is this bot, and is it safe?',
    'WaxEDGE watches WAX DeFi for you and tells you when something needs your attention. It only <b>reads</b> public blockchain data: it never asks for a private key, never connects a wallet, and cannot sign or move anything. The actions it points to (compound, claim, join a farm) happen on waxedge.app with your own wallet.'],
  ['How do I get alerts for my wallet?',
    'Tap <b>👛 Wallets → ➕ Watch a wallet</b> and send your account name. From then on I watch its Alcor positions, transfers, NFTs, CPU/NET/RAM and vote rewards. Under <b>🔔 Which alerts</b> you switch each kind on or off and set the dollar thresholds. Up to 5 wallets per chat.',
    [btn('➕ Watch a wallet', 'ask:/watch')]],
  ['What does “out of range” mean?',
    'An Alcor position earns trading fees only while the price is inside the range you chose. When the price leaves it, the position turns entirely into one token and earns <b>nothing</b> until the price comes back — or until you move the range. I tell you when it leaves and when it returns. “Close to the edge” is the early warning: the position is already more than 92% one token.'],
  ['What are “fees ready to compound”?',
    'Trading fees collect inside your position; they do not grow on their own. Compounding puts them back into the position so they earn too. I tell you when the fees waiting pass your threshold ($5 by default); the link opens your wallet on waxedge.app where one button compounds them.'],
  ['Why does a farm alert say “join the farm”?',
    'On Alcor a farm pays only positions that are <b>staked</b> into it. Being in the pool is not enough. When a new farm starts on a pool you are in, I tell you, so you can stake your position and start earning the reward. I also warn you a day before a farm on your pool ends.'],
  ['Why do I not see every transfer?',
    'For a watched wallet I skip transfers below your threshold ($10 by default — change it under <b>🔔 Which alerts</b>, down to “all”) and tokens without a price, because unknown incoming tokens are almost always airdrop spam. A transaction that sends one token and receives another is shown as one swap line.'],
  ['How do CPU, NET and RAM alerts work?',
    'WAX transactions use CPU and NET, and storing data uses RAM. When one passes 90% your transactions start failing. I warn you once, and again only after it has dropped below 70% and climbs back. Top up via the Staking page on waxedge.app.'],
  ['What are vote rewards?',
    'Staked WAX that votes (or picks a proxy) earns vote rewards, claimable once every 24 hours. I remind you when they are ready. If you have staked WAX that is not voting, I tell you once, because it earns nothing that way.'],
  ['What kinds of price alerts are there?',
    '• <b>A price</b> — once, when a token goes above or below a price, in dollars or in WAX. Pick +10%, −25%… or type an exact price.\n• <b>Every ±10% move</b> — every time it moves that much from the last price I reported, up or down.\n• <b>Big swaps</b> — every swap of the token above $250 in its deepest Alcor pools, with who bought or sold.\nPrices are checked every two minutes against Alcor’s live price.',
    [btn('🔔 Set a price alert', 'ask:#alert')]],
  ['What are liquidity alerts?',
    'Liquidity is the money in a token’s pools; it decides how much you can buy or sell without moving the price. I report every deposit and withdrawal on <b>Alcor</b> and <b>TacoSwap</b>: how much, by whom, and how big the pool is afterwards — flagged when it is 10% or more of the pool. A large withdrawal is often the first sign of trouble. You can also get one alert when a token’s total liquidity crosses a line.',
    [btn('💧 Liquidity alerts', 'mn:liquidity')]],
  ['Can I follow someone else’s account?',
    'Yes — any account, it is all public. <b>🔎 Look up → Transfers of an account</b> shows its latest transfers with quick filters; <b>Follow an account</b> alerts you when it moves. Filters you can type: a token (<code>CHEESE</code>), <code>in</code> / <code>out</code>, <code>swaps</code>, <code>nfts</code>, a minimum like <code>&gt;500</code>, <code>from:account</code>, <code>to:account</code>, <code>memo:text</code>. Example: <code>somewhale CHEESE out &gt;500</code>.',
    [btn('🔎 Look up an account', 'mn:lookup')]],
  ['What are new pools, new farms and NFT floor alerts?',
    '• <b>New pools</b> — every new Alcor pool, or only those with one token.\n• <b>New farms</b> — every new Alcor farm, with the reward and its dollar value.\n• <b>NFT floor</b> — one alert when a collection (or one template in it) is listed on AtomicHub at or below your price in WAX.'],
  ['What is the daily digest?',
    'One message a day at the time you choose: WAX, your favourite tokens, your watched wallets (value, out-of-range positions, fees to compound), the biggest movers and the best farm. Add favourites under <b>📈 Markets</b>.',
    [btn('☀️ Set it up', 'mn:dg')]],
  ['How fast are alerts, and how fresh are the numbers?',
    'Checks run every minute, each doing part of the work, so most alerts arrive within 1–5 minutes. Prices for alerts are live from Alcor. The 24h changes, liquidity totals, top movers and farm figures come from the WaxEDGE snapshot, which is refreshed every one to two hours.'],
  ['Are there limits?',
    'Per chat: 5 watched wallets, 15 alerts and 12 favourites. Remove one under <b>🔔 Alerts → 📋 My alerts</b> to make room.'],
  ['How do I pause or remove alerts, and what do you keep?',
    '<b>🔔 Alerts → 📋 My alerts</b> lists everything with a ❌ button each. <b>Mute</b> pauses everything for a while. <b>⚙️ This chat → Forget this chat</b> deletes all of it. I keep only what an alert needs: this chat’s id, the accounts, tokens and settings you chose — nothing about you.'],
  ['Can I add the bot to a group?',
    'Yes. Add it, and anyone in the group can use the commands (type <code>/</code> to see them); alerts set there go to the group. In groups the bottom keyboard is not shown — use /start for the menu.'],
  ['Does it cost anything?',
    'No. The bot is free and has no premium tier.'],
];

// --------------------------------------------------------------- commands --
async function command(env, B, chat, text, { isPrivate = true } = {}) {
  const [cmdRaw, ...args] = text.trim().split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();
  // In a group, "/price@someotherbot" is not for us.
  if (cmdRaw.includes('@') && cmdRaw.startsWith('/') && !/@waxedge/i.test(cmdRaw)) return;
  const now = Date.now();
  const reply = (t, m) => say(env, B, chat, t, m);
  await chatRow(env, chat);

  if (cmd === '/start') {
    await reply(`👋 <b>Welcome to WaxEDGE.</b>\n\nI watch WAX DeFi for you: positions out of range, fees to compound, new farms, money moving, prices, liquidity, whales.\n\nEverything is a tap away — use the buttons below. No commands to remember.`,
      isPrivate ? KEYBOARD : null);
    return menu(env, B, chat, 'main');
  }
  if (cmd === '/menu') return menu(env, B, chat, 'main');
  if (cmd === '/faq') return menu(env, B, chat, 'faq');
  if (cmd === '/help') return reply(HELP, kb([[btn('☰ Menu', 'mn:main'), btn('❓ FAQ', 'mn:faq')]]));

  // ---- wallets ----
  if (cmd === '/watch') {
    const acct = String(args[0] || '').toLowerCase();
    if (!ACCOUNT_RE.test(acct)) return reply('Usage: /watch <i>account</i> — a WAX account name.');
    const n = (await DB(env).prepare('SELECT COUNT(*) AS n FROM watches WHERE chat_id = ?').bind(chat).first()).n;
    if (n >= LIM.watch) return reply(`This chat watches ${LIM.watch} wallets already. /unwatch one first.`);
    const [acc, pos, D] = [await account(B, acct), await positions(B, acct), await data(env, B)];
    if (!acc) return reply(`There is no WAX account <b>${esc(acct)}</b>.`);
    const st = { r: Object.fromEntries((pos || []).map(p => [p.id, p.inRange ? 1 : 0])), pl: [...new Set((pos || []).map(p => p.pool))] };
    await DB(env).prepare('INSERT OR REPLACE INTO watches (chat_id, account, state, created, opts) VALUES (?, ?, ?, ?, COALESCE((SELECT opts FROM watches WHERE chat_id = ? AND account = ?), \'{}\'))')
      .bind(chat, acct, JSON.stringify(st), now, chat, acct).run();
    return reply(`👀 <b>Watching ${esc(acct)}.</b> You will hear about ranges, fees, farms, transfers, NFTs, resources and vote rewards — /settings ${esc(acct)} to choose.\n\n${pos ? summary(D, acct, pos) : 'Alcor did not answer for the positions just now; they are checked every few minutes.'}`,
      kb([[btn('⚙️ Settings', `s:${acct}`), btn('👛 Wallet', `m:/wallet ${acct}`)]]));
  }
  if (cmd === '/unwatch') {
    const acct = String(args[0] || '').toLowerCase();
    const r = await DB(env).prepare('DELETE FROM watches WHERE chat_id = ? AND account = ?').bind(chat, acct).run();
    return reply(r.meta?.changes ? `Stopped watching <b>${esc(acct)}</b>.` : `This chat was not watching <b>${esc(acct)}</b>.`);
  }
  if (cmd === '/settings') {
    const acct = String(args[0] || '').toLowerCase();
    const list = acct ? [acct] : (await DB(env).prepare('SELECT account FROM watches WHERE chat_id = ?').bind(chat).all()).results.map(r => r.account);
    if (!list.length) return reply('Nothing watched yet. /watch <i>account</i> first.');
    if (list.length > 1) return reply('Settings for which wallet?', kb([list.map(a => btn(a, `s:${a}`))]));
    return settingsMessage(env, B, chat, list[0]);
  }
  if (cmd === '/status') {
    const want = String(args[0] || '').toLowerCase();
    if (want && !ACCOUNT_RE.test(want)) return reply('Usage: /status <i>account</i>');
    const list = want ? [want] : (await DB(env).prepare('SELECT account FROM watches WHERE chat_id = ?').bind(chat).all()).results.map(r => r.account);
    if (!list.length) return reply('Nothing watched yet. /watch <i>account</i> first, or /status <i>account</i> for a one-off look.');
    const D = await data(env, B);
    const parts = [];
    for (const a of list.slice(0, LIM.watch)) {
      const pos = await positions(B, a);
      parts.push(pos ? summary(D, a, pos) : `<b>${esc(a)}</b>: Alcor did not answer. Try again in a minute.`);
    }
    return reply(parts.join('\n\n—\n\n'));
  }
  if (cmd === '/wallet' || cmd === '/w') {
    const acct = String(args[0] || '').toLowerCase() || (await DB(env).prepare('SELECT account FROM watches WHERE chat_id = ? LIMIT 1').bind(chat).first())?.account;
    if (!acct || !ACCOUNT_RE.test(acct)) return reply('Usage: /wallet <i>account</i>');
    const D = await data(env, B);
    const [toks, acc, pos] = [await hyp(B, `/v2/state/get_tokens?account=${acct}&limit=200`), await account(B, acct), await positions(B, acct)];
    if (!acc) return reply(`There is no WAX account <b>${esc(acct)}</b>.`);
    const res = resources(acc);
    const rows = (toks?.tokens || []).map(x => {
      const t = D.tok.get(`${x.symbol}@${x.contract}`);
      return { sym: x.symbol, t, n: Number(x.amount) || 0, usd: t ? (Number(x.amount) || 0) * t.usd : null };
    }).filter(x => x.n > 0);
    const priced = rows.filter(x => x.usd != null).sort((a, b) => b.usd - a.usd);
    const stakedUsd = res.staked * (D.wax || 0);
    const lpUsd = (pos || []).reduce((s, p) => s + p.value, 0);
    const tokUsd = priced.reduce((s, x) => s + x.usd, 0);
    const lines = [`👛 <b>${esc(acct)}</b> — <b>${fmtUsd(tokUsd + stakedUsd + lpUsd)}</b>`,
      `Tokens ${fmtUsd(tokUsd)} · Alcor LP ${fmtUsd(lpUsd)} · staked ${fmtAmt(res.staked)} WAX (${fmtUsd(stakedUsd)})`, ''];
    for (const x of priced.slice(0, 12)) lines.push(`• ${fmtAmt(x.n)} ${x.t ? tokLink(x.t) : esc(x.sym)} · ${fmtUsd(x.usd)}${x.t?.ch != null ? ` ${pct(x.t.ch)}` : ''}`);
    if (priced.length > 12) lines.push(`… and ${priced.length - 12} more`);
    if (rows.length > priced.length) lines.push(`+ ${rows.length - priced.length} token${rows.length - priced.length === 1 ? '' : 's'} without a price`);
    if (!toks) lines.push('<i>The balance index did not answer; tokens are missing from this.</i>');
    lines.push('', `CPU ${bar(res.cpu)} · RAM ${bar(res.ram)}`, walletLink(acct));
    return reply(lines.join('\n'), kb([[btn('👀 Watch it', `m:/watch ${acct}`), btn('📊 Positions', `m:/status ${acct}`)]]));
  }
  if (cmd === '/res' || cmd === '/resources') {
    const acct = String(args[0] || '').toLowerCase() || (await DB(env).prepare('SELECT account FROM watches WHERE chat_id = ? LIMIT 1').bind(chat).first())?.account;
    if (!acct || !ACCOUNT_RE.test(acct)) return reply('Usage: /res <i>account</i>');
    const acc = await account(B, acct);
    if (!acc) return reply(`There is no WAX account <b>${esc(acct)}</b>.`);
    const r = resources(acc);
    const claimIn = r.lastClaim + DAY - now;
    return reply([`⚙️ <b>${esc(acct)}</b>`,
      `CPU ${bar(r.cpu)}`, `NET ${bar(r.net)}`, `RAM ${bar(r.ram)} · ${fmtAmt(r.ramFree / 1024)} KB free`, '',
      `Liquid ${fmtAmt(r.liquid)} WAX · staked ${fmtAmt(r.staked)} WAX`,
      r.staked >= 1 ? (r.voting ? (claimIn <= 0 ? '🎁 Vote rewards can be claimed now.' : `Next vote-reward claim in ${ago(claimIn)}.`)
        : '⚠️ Not voting — staked WAX earns no vote rewards until you vote or pick a proxy.') : '',
      `<a href="${SITE}/staking">Stake, vote and claim on WaxEDGE</a>`].filter(Boolean).join('\n'));
  }

  // ---- markets ----
  if (cmd === '/price' || cmd === '/p' || cmd === '/token' || cmd === '/t' || cmd === '/alert') {
    if (!args[0]) return reply(cmd === '/alert' ? 'Usage: /alert <i>SYM</i> above|below <i>price</i> [wax] — e.g. /alert CHEESE above 0.01' : 'Usage: /price <i>SYM</i> — e.g. /price CHEESE');
    const t = await resolve(env, B, args[0]);
    if (!t) return reply(`No token <b>${esc(args[0].toUpperCase())}</b> on WAX that I know. Use SYM@contract for a new one.`);
    if (args[1] || cmd === '/alert') {
      const dir = String(args[1] || '').toLowerCase();
      const value = Number(String(args[2] || '').replace(',', '.').replace('$', ''));
      const unit = String(args[3] || '').toLowerCase() === 'wax' ? 'wax' : 'usd';
      if (!['above', 'below'].includes(dir) || !(value > 0)) return reply('Usage: /alert <i>SYM</i> above|below <i>price</i> [wax] — e.g. /alert CHEESE above 0.01, or /alert CHEESE below 1.2 wax');
      const lv = await live(B, t);
      const err = await addAlert(env, chat, 'price', t.id, t.sym, { dir, value, unit });
      if (err) return reply(err);
      const nowV = unit === 'wax' ? lv?.wax : lv?.usd;
      const f = v => (unit === 'wax' ? `${fmtAmt(v)} WAX` : fmtUsd(v));
      return reply(`🔔 I will tell you once when <b>${tokLink(t)}</b> goes ${dir} ${f(value)}.${nowV ? ` Now ${f(nowV)}.` : ''}`);
    }
    const c = await tokenCard(env, B, t);
    return reply(c.text, c.markup);
  }
  if (cmd === '/wax') {
    const D = await data(env, B);
    const t = D.tok.get('WAX@eosio.token') || { id: 'WAX@eosio.token', sym: 'WAX', c: 'eosio.token' };
    const c = await tokenCard(env, B, t, { full: false });
    return reply(c.text, c.markup);
  }
  if (cmd === '/top') {
    const D = await data(env, B);
    const wax = D.tok.get('WAX@eosio.token'), waxCh = wax?.ch;
    // A day in which WAX itself moves 10% moves every WAX-paired token's
    // dollar price with it; ranked on dollars, the list is WAX's move many
    // times over. So when WAX moved, tokens rank on what they did against it.
    const rel = waxCh != null && Math.abs(waxCh) >= 1;
    const own = t => (rel ? ((1 + t.ch / 100) / (1 + waxCh / 100) - 1) * 100 : t.ch);
    // Left out: stablecoins, and prices that did not change at all — no trade,
    // not a move.
    const stable = t => /USD|EUR|JPY/.test(t.sym) && t.usd > 0.2;
    const liquid = [...D.tok.values()].filter(t => t.liq >= 1000 && t.ch != null && t.ch !== 0 && t.sym !== 'WAX' && !stable(t));
    const byOwn = [...liquid].sort((a, b) => own(b) - own(a));
    const up = byOwn.filter(t => own(t) >= 0.5).slice(0, 6);
    const dn = [...byOwn].reverse().filter(t => own(t) <= -0.5).slice(0, 6);
    const row = t => `• ${tokLink(t)} ${fmtUsd(t.usd)} ${arrow(own(t))} <b>${pct(own(t))}</b>${rel ? ` <i>(${pct(t.ch)} in $)</i>` : ''}`;
    const vol = [...D.tok.values()].filter(t => t.sym !== 'WAX' && !stable(t)).sort((a, b) => b.vol - a.vol).slice(0, 5);
    return reply([`📈 <b>24h movers</b> <i>($1k+ liquidity${rel ? ', measured against WAX' : ''})</i>`,
      wax ? `WAX ${fmtUsd(wax.usd)} ${arrow(waxCh)} ${pct(waxCh)}${rel ? ' — so a token that just followed WAX shows ±0% here' : ''}` : '', '',
      '🟢 <b>Up</b>', ...(up.length ? up.map(row) : ['<i>nothing rose more than 0.5%</i>']), '',
      '🔴 <b>Down</b>', ...(dn.length ? dn.map(row) : [`<i>nothing fell more than 0.5%${rel ? ' against WAX' : ''}</i>`]), '',
      '🔥 <b>Most traded</b>', ...vol.map(t => `• ${tokLink(t)} ${fmtBig(t.vol)} ${pct(rel ? own(t) : t.ch)}${rel ? ' vs WAX' : ''}`), '',
      `<i>As of ${new Date(D.at).toISOString().slice(11, 16)} UTC</i> · <a href="${SITE}/tokens">All tokens</a>`].filter((x, i, arr) => x !== '' || arr[i - 1] !== '').join('\n'));
  }
  if (cmd === '/pools') {
    if (!args[0]) return reply('Usage: /pools <i>SYM</i>');
    const t = await resolve(env, B, args[0]);
    if (!t) return reply(`No token <b>${esc(args[0].toUpperCase())}</b>.`);
    const D = await data(env, B);
    const ps = poolsOf(D, t.id).slice(0, 8);
    if (!ps.length) return reply(`No pool with ${tokLink(t)} holds $20 or more.`);
    return reply([`💧 <b>Pools with ${tokLink(t)}</b>`, ...ps.map(p => {
      const apr = p.tvl > 0 ? p.vol * (p.fee / 10000) / p.tvl * 365 * 100 : 0;
      return `• ${poolLink(p.dex, p.id, `${p.a}/${p.b}`)} ${VENUE[p.dex] || p.dex} ${(p.fee / 100).toFixed(2)}%\n   ${fmtBig(p.tvl)} in it · ${fmtBig(p.vol)} traded 24h${apr >= 0.1 ? ` · fees ${apr.toFixed(apr < 10 ? 1 : 0)}% APR` : ''}`;
    })].join('\n'));
  }
  if (cmd === '/farms') {
    const D = await data(env, B);
    const want = args[0] ? await resolve(env, B, args[0]) : null;
    const pl = f => D.poolById.get(`${f.pd}:${f.pi}`);
    const fs = D.farms.filter(f => f.staked >= 50 && (!want || f.rs === want.sym || [pl(f)?.ia, pl(f)?.ib].includes(want.id))).slice(0, 10);
    if (!fs.length) return reply(want ? `No live farm with ${tokLink(want)} and $50+ staked.` : 'No live farms in the snapshot.');
    return reply([`🌾 <b>Best live farms${want ? ` with ${esc(want.sym)}` : ''}</b> <i>(by APR, $50+ staked)</i>`,
      ...fs.map(f => { const p = pl(f); return `• ${p ? poolLink(p.dex, p.id, `${p.a}/${p.b}`) : `pool ${esc(f.pi)}`} — <b>${f.apr != null ? `${f.apr.toFixed(f.apr < 10 ? 1 : 0)}%` : '?'}</b> in ${esc(f.rs)} · ${fmtUsd(f.usdDay)}/day · ${fmtBig(f.staked)} staked · ends in ${ago(f.end - now)}`; }),
      '', `<a href="${SITE}/farms">All farms on WaxEDGE</a>`].join('\n'));
  }
  if (cmd === '/move') {
    if (!args[0]) return reply('Usage: /move <i>SYM</i> [<i>percent</i>] — e.g. /move CHEESE 10: a message every time it moves 10% from the last one');
    const t = await resolve(env, B, args[0]);
    if (!t) return reply(`No token <b>${esc(args[0].toUpperCase())}</b>.`);
    return reply(await addMove(env, B, chat, t, Number(String(args[1] || '10').replace('%', '')) || 10));
  }
  if (cmd === '/whale') {
    if (!args[0]) return reply('Usage: /whale <i>SYM</i> [<i>usd</i>] — every swap of that token above the amount (default $250)');
    const t = await resolve(env, B, args[0]);
    if (!t) return reply(`No token <b>${esc(args[0].toUpperCase())}</b>.`);
    return reply(await addWhale(env, B, chat, t, Number(String(args[1] || '250').replace('$', '')) || 250));
  }
  if (cmd === '/newpools' || cmd === '/newfarms') {
    const kind = cmd === '/newpools' ? 'newpool' : 'newfarm';
    const what = kind === 'newpool' ? 'new Alcor pool' : 'new Alcor farm';
    if (String(args[0] || '').toLowerCase() === 'off') {
      await DB(env).prepare('DELETE FROM alerts WHERE chat_id = ? AND kind = ?').bind(chat, kind).run();
      return reply(`No more ${what} alerts.`);
    }
    const t = args[0] ? await resolve(env, B, args[0]) : null;
    if (args[0] && !t) return reply(`No token <b>${esc(args[0].toUpperCase())}</b>.`);
    const err = await addAlert(env, chat, kind, t ? t.id : '*', t ? t.sym : 'any', {});
    return reply(err || `🆕 I will tell you about every ${what}${t ? ` with ${tokLink(t)}` : ''}. /${kind}s off to stop.`);
  }
  if (cmd === '/floor') {
    // /floor <collection> [template] below <wax>
    const col = String(args[0] || '').toLowerCase();
    const tpl = /^\d+$/.test(args[1] || '') ? args[1] : null;
    const rest = tpl ? args.slice(2) : args.slice(1);
    const below = Number(String(rest[1] || '').replace(',', '.'));
    if (!ACCOUNT_RE.test(col) || String(rest[0] || '').toLowerCase() !== 'below' || !(below > 0)) {
      return reply('Usage: /floor <i>collection</i> [<i>template id</i>] below <i>WAX</i> — e.g. /floor alien.worlds 19552 below 5');
    }
    const q = new URLSearchParams({ state: '1', collection_name: col, sort: 'price', order: 'asc', limit: '1', symbol: 'WAX' });
    if (tpl) q.set('template_id', tpl);
    const d = await get(B, `${AA}/atomicmarket/v2/sales?${q}`);
    const s = d?.data?.[0];
    const nowP = s ? Number(s.price.amount) / 10 ** s.price.token_precision : null;
    const err = await addAlert(env, chat, 'floor', col, `${col}${tpl ? ` #${tpl}` : ''}`, { tpl, below });
    if (err) return reply(err);
    return reply(`🖼 I will tell you once when <b>${esc(col)}${tpl ? ` template ${tpl}` : ''}</b> is listed at ${fmtAmt(below)} WAX or less.${nowP != null ? ` Cheapest now: ${fmtAmt(nowP)} WAX (${esc(s.assets?.[0]?.name || '')}).` : ''}`);
  }

  // ---- any account's transfers ----
  if (cmd === '/tx' || cmd === '/transfers' || cmd === '/track') {
    const acct = String(args[0] || '').toLowerCase();
    if (!ACCOUNT_RE.test(acct)) {
      return reply(`Usage: ${cmd === '/track' ? '/track' : '/tx'} <i>account</i> [filters]\nFilters, any mix: a token (<code>CHEESE</code>), <code>in</code> / <code>out</code>, <code>swaps</code>, <code>nfts</code>, <code>&gt;100</code> (dollars), <code>from:acct</code> <code>to:acct</code> <code>with:acct</code>, <code>memo:text</code>\ne.g. <code>/tx hole.cheese CHEESE in &gt;1</code> · <code>/track somewhale out &gt;500</code>`);
    }
    const f = await parseFilter(env, B, args.slice(1));
    if (f.error) return reply(f.error);
    if (cmd === '/track') {
      if (!(await account(B, acct))) return reply(`There is no WAX account <b>${esc(acct)}</b>.`);
      const err = await addAlert(env, chat, 'track', acct, acct, f);
      return reply(err || `🔎 Tracking <b>${esc(acct)}</b>: ${filterText(f)}. I will write when it moves — within a few minutes.`);
    }
    const D = await data(env, B);
    const tc = f.tok ? f.tok.split('@')[1] : null;
    const d = await hyp(B, txQuery(acct, f, tc, 100));
    if (!d?.actions) return reply('The history index did not answer. Try again in a minute.');
    const ev = eventsFrom(D, acct, d.actions).filter(e => matches(e, f)).reverse();
    if (!ev.length) return reply(`Nothing matching in the last ${d.actions.length} transfers of <b>${esc(acct)}</b> <i>(${filterText(f)})</i>.`);
    const when = ms => new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
    const tot = ev.filter(e => e.usd != null);
    const inUsd = tot.filter(e => e.kind === 'in').reduce((t, e) => t + e.usd, 0), outUsd = tot.filter(e => e.kind === 'out').reduce((t, e) => t + e.usd, 0);
    return reply([`🧾 <b>${esc(acct)}</b> — ${filterText(f)}`, ...ev.slice(0, 15).map(e => `<code>${when(e.at)}</code> ${e.text}`),
      ev.length > 15 ? `… ${ev.length - 15} more` : '',
      inUsd || outUsd ? `\nIn ${fmtUsd(inUsd)} · out ${fmtUsd(outUsd)} <i>(at today's prices)</i>` : '',
      `\n${walletLink(acct)}`].filter(Boolean).join('\n'),
    kb([[btn('🔎 Alert me on these', `m:/track ${[acct, ...args.slice(1)].join(' ')}`)]]));
  }

  // ---- liquidity ----
  if (cmd === '/liq') {
    // /liq SYM|poolId|all [min $] [add|remove]   or   /liq SYM above|below $
    const what = String(args[0] || '');
    if (!what) return reply('Usage:\n/liq <i>SYM</i> [<i>min $</i>] [add|remove] — every time liquidity goes in or out of its pools\n/liq <i>pool id</i> … — one Alcor pool\n/liq all 1000 — any pool, $1,000 and up\n/liq <i>SYM</i> above|below <i>$</i> — total liquidity crosses a line\n/liquidity <i>SYM</i> — where its liquidity is now');
    const rest = args.slice(1).map(x => x.toLowerCase());
    if (rest[0] === 'above' || rest[0] === 'below') {
      const value = Number(String(rest[1] || '').replace(/[$,k]/g, '')) * (/k$/.test(rest[1] || '') ? 1000 : 1);
      const t = await resolve(env, B, what);
      if (!t || !(value > 0)) return reply('Usage: /liq <i>SYM</i> above|below <i>dollars</i> — e.g. /liq CHEESE above 10000');
      const err = await addAlert(env, chat, 'liqlvl', t.id, t.sym, { dir: rest[0], value });
      return reply(err || `💧 I will tell you once when ${tokLink(t)} has ${rest[0]} ${fmtBig(value)} of liquidity. Now ${fmtBig(t.liq || 0)}.`);
    }
    const min = Number((rest.find(x => /^\$?\d/.test(x)) || '0').replace(/[$,]/g, '')) || 0;
    const side = rest.includes('add') || rest.includes('adds') ? 'add' : rest.includes('remove') || rest.includes('removes') ? 'remove' : 'both';
    let target, label;
    if (what.toLowerCase() === 'all') { target = '*'; label = 'any pool'; }
    else if (/^\d+$/.test(what)) { const pl = await alcorPoolInfo(B, await data(env, B), what); if (!pl) return reply(`No Alcor pool ${esc(what)}.`); target = `alcor:${what}`; label = `${pl.a}/${pl.b}`; }
    else { const t = await resolve(env, B, what); if (!t) return reply(`No token <b>${esc(what.toUpperCase())}</b>.`); target = t.id; label = t.sym; }
    if (target === '*' && min < 100) return reply('For every pool, set a floor of at least $100: /liq all 1000');
    const err = await addAlert(env, chat, 'liq', target, label, { min, side });
    return reply(err || `💧 I will tell you when liquidity is ${side === 'add' ? 'added to' : side === 'remove' ? 'taken out of' : 'added to or taken out of'} ${esc(label)}${target.startsWith('alcor:') || target === '*' ? '' : '’s pools'}${min ? `, from ${fmtUsd(min)}` : ''} — Alcor and TacoSwap.`);
  }
  if (cmd === '/liquidity') {
    if (!args[0]) return reply('Usage: /liquidity <i>SYM</i>');
    const t = await resolve(env, B, args[0]);
    if (!t) return reply(`No token <b>${esc(args[0].toUpperCase())}</b>.`);
    const D = await data(env, B);
    const ps = poolsOf(D, t.id);
    const byVenue = {};
    for (const p of ps) byVenue[p.dex] = (byVenue[p.dex] || 0) + p.tvl;
    const all = ps.reduce((x, p) => x + p.tvl, 0);
    const lines = [`💧 <b>${tokLink(t)}</b> — ${fmtBig(all)} in pools with it · its own side ≈ ${fmtBig(t.liq || 0)}`,
      Object.entries(byVenue).sort((a, b) => b[1] - a[1]).map(([d, v]) => `${VENUE[d] || d} ${fmtBig(v)}`).join(' · '), '',
      ...ps.slice(0, 6).map(p => `• ${poolLink(p.dex, p.id, `${p.a}/${p.b}`)} ${VENUE[p.dex] || p.dex} · ${fmtBig(p.tvl)} · ${fmtBig(p.vol)} traded`)];
    // Recent moves on Alcor in its pools: the global feed, filtered here.
    const ids = new Set(ps.filter(p => p.dex === 'alcor').map(p => p.id));
    const recent = [];
    for (const [flt] of LIQ_FEEDS.slice(0, 2)) {
      const d = await hyp(B, `/v2/history/get_actions?filter=${flt}&limit=100&sort=desc`);
      for (const x of d?.actions || []) if (ids.has(String(x.act.data.poolId))) recent.push(x);
    }
    const evs = [];
    for (const x of recent.sort((a, b) => b.global_sequence - a.global_sequence).slice(0, 6)) { const e = await liqEvent(B, D, x); if (e) evs.push(e); }
    if (evs.length) lines.push('', '<b>Recent moves</b>', ...evs.map(e => `<code>${new Date(e.at).toISOString().slice(5, 16).replace('T', ' ')}</code> ${liqText(e)}`));
    return reply(lines.join('\n'), kb([[btn('🔔 Alert on liquidity moves', `m:/liq ${t.id}`)]]));
  }

  // ---- tokens: holders, supply ----
  if (cmd === '/holders') {
    if (!args[0]) return reply('Usage: /holders <i>SYM</i>');
    const t = await resolve(env, B, args[0]);
    if (!t) return reply(`No token <b>${esc(args[0].toUpperCase())}</b>.`);
    const [h, st] = [await hyp(B, `/v2/state/get_top_holders?contract=${t.c}&symbol=${t.sym}&limit=15`), await chain(B, 'get_currency_stats', { code: t.c, symbol: t.sym })];
    const sup = parseQty(st?.[t.sym]?.supply).n, max = parseQty(st?.[t.sym]?.max_supply).n;
    if (!h?.holders?.length) return reply('The holder index did not answer. Try again in a minute.');
    const tag = a => (/^(swap\.|alcor|waxdaolocker|lock|burn|eosio\.null)/.test(a) ? ' <i>(contract/lock)</i>' : '');
    return reply([`👥 <b>Top holders of ${tokLink(t)}</b>`, sup ? `Supply ${fmtAmt(sup)}${max && max !== sup ? ` of max ${fmtAmt(max)}` : ''}${t.usd ? ` · market cap ${fmtBig(sup * t.usd)}` : ''}` : '', '',
      ...h.holders.map((x, i) => `${i + 1}. <code>${esc(x.owner)}</code> ${fmtAmt(x.amount)}${sup ? ` · ${(x.amount / sup * 100).toFixed(2)}%` : ''}${tag(x.owner)}`)].filter(x => x !== '').join('\n'),
    kb([[btn('🧾 Transfers of #1', `m:/tx ${h.holders[0].owner} ${t.id}`)]]));
  }
  if (cmd === '/pool') {
    const id = String(args[0] || '');
    if (!/^\d+$/.test(id)) return reply('Usage: /pool <i>Alcor pool id</i> — the number in the pool’s link');
    const D = await data(env, B);
    const pl = await alcorPoolInfo(B, D, id);
    if (!pl) return reply(`No Alcor pool ${esc(id)}.`);
    const api = await get(B, `${ALCOR}/swap/pools/${id}`, { ttl: 60 });
    const pa = D.tok.get(pl.ia), pb = D.tok.get(pl.ib);
    const ra = api?.tokenA?.quantity, rb = api?.tokenB?.quantity;
    const tvl = ra != null && pa && pb ? ra * pa.usd + rb * pb.usd : pl.tvl;
    const fs = D.farms.filter(f => f.pd === 'alcor' && f.pi === id);
    return reply([`🏊 <b>${poolLink('alcor', id, `${pl.a}/${pl.b}`)}</b> · Alcor #${esc(id)} · ${((api?.fee ?? pl.fee * 100) / 10000).toFixed(2)}% fee`,
      tvl != null ? `In it: ${fmtAmt(ra ?? 0)} ${esc(pl.a)} + ${fmtAmt(rb ?? 0)} ${esc(pl.b)} · <b>${fmtBig(tvl)}</b>` : '',
      api ? `Volume 24h ${fmtBig(api.volumeUSD24 || 0)} · week ${fmtBig(api.volumeUSDWeek || 0)} · price 24h ${pct(api.change24)}` : '',
      tvl > 0 && api ? `Fee APR ~${((api.volumeUSD24 || 0) * ((api.fee || 3000) / 1e6) / tvl * 365 * 100).toFixed(1)}%` : '',
      ...fs.map(f => `🌾 farm in ${esc(f.rs)} · ${f.apr?.toFixed(0)}% · ${fmtUsd(f.usdDay)}/day · ends in ${ago(f.end - Date.now())}`)].filter(Boolean).join('\n'),
    kb([[btn('💧 Liquidity alerts', `m:/liq ${id}`), btn('🐋 Big swaps', `wh:${pl.ia === 'WAX@eosio.token' ? pl.ib : pl.ia}`)]]));
  }
  if (cmd === '/nfts') {
    const acct = String(args[0] || '').toLowerCase();
    if (!ACCOUNT_RE.test(acct)) return reply('Usage: /nfts <i>account</i>');
    const d = await get(B, `${AA}/atomicassets/v1/accounts/${acct}`);
    const cols = (d?.data?.collections || []).sort((a, b) => Number(b.assets) - Number(a.assets));
    if (!d) return reply('AtomicAssets did not answer. Try again in a minute.');
    return reply([`🖼 <b>${esc(acct)}</b> — ${Number(d.data.assets).toLocaleString('en-US')} NFTs in ${cols.length} collection${cols.length === 1 ? '' : 's'}`,
      ...cols.slice(0, 12).map(c => `• ${esc(c.collection.collection_name)} — ${c.assets}`), cols.length > 12 ? `… and ${cols.length - 12} more` : '',
      `\n<a href="https://wax.atomichub.io/profile/wax-mainnet/${acct}">Open on AtomicHub</a>`].filter(Boolean).join('\n'),
    kb([[btn('🔎 Alert on NFTs in/out', `m:/track ${acct} nfts`)]]));
  }

  // ---- daily ----
  if (cmd === '/fav' || cmd === '/unfav') {
    const c = await chatRow(env, chat);
    let favs = j(c.favs, []);
    if (!args[0]) return reply('Usage: /fav <i>SYM</i> — then /favs shows them all, and the daily digest carries them.');
    const t = await resolve(env, B, args[0]);
    if (!t) return reply(`No token <b>${esc(args[0].toUpperCase())}</b>.`);
    if (cmd === '/unfav') favs = favs.filter(x => x !== t.id);
    else if (!favs.includes(t.id)) { if (favs.length >= LIM.favs) return reply(`${LIM.favs} favourites is the limit. /unfav one first.`); favs.push(t.id); }
    await DB(env).prepare('UPDATE chats SET favs = ? WHERE chat_id = ?').bind(JSON.stringify(favs), chat).run();
    return reply(cmd === '/unfav' ? `Removed ${esc(t.sym)}.` : `⭐ ${tokLink(t)} is a favourite. /favs for the board.`);
  }
  if (cmd === '/favs') {
    const c = await chatRow(env, chat);
    const favs = j(c.favs, []);
    if (!favs.length) return reply('No favourites yet. /fav <i>SYM</i> to add one.');
    const D = await data(env, B);
    const lines = ['⭐ <b>Favourites</b>'];
    for (const id of favs) {
      const t = D.tok.get(id) || { id, sym: id.split('@')[0], c: id.split('@')[1], ch: null };
      const lv = await live(B, t);
      lines.push(`• ${tokLink(t)} ${fmtUsd(lv?.usd ?? t.usd)}${lv?.wax ? ` · ${fmtAmt(lv.wax)} WAX` : ''} ${t.ch != null ? `${arrow(t.ch)} ${pct(t.ch)}` : ''}`);
    }
    return reply(lines.join('\n'));
  }
  if (cmd === '/digest') {
    const a = String(args[0] || '').toLowerCase();
    if (a === 'off') { await DB(env).prepare('UPDATE chats SET digest_hour = -1 WHERE chat_id = ?').bind(chat).run(); return reply('Daily digest off.'); }
    const hour = Number(a);
    const tzm = String(args[1] || '+0').match(/^([+-])?(\d{1,2})(?::(\d{2}))?$/);
    if (!(hour >= 0 && hour <= 23) || a === '' || !tzm) return reply('Usage: /digest <i>hour</i> [<i>UTC offset</i>] — e.g. /digest 8 +2 for 08:00 in Belgium in summer. /digest off to stop.');
    const tz = (tzm[1] === '-' ? -1 : 1) * (Number(tzm[2]) * 60 + Number(tzm[3] || 0));
    await DB(env).prepare('UPDATE chats SET digest_hour = ?, tz = ?, digest_day = ? WHERE chat_id = ?').bind(hour, tz, localDay(now, tz), chat).run();
    return reply(`☀️ Every day at ${String(hour).padStart(2, '0')}:00 (UTC${tz >= 0 ? '+' : '−'}${Math.abs(tz / 60)}): WAX, your favourite tokens, your watched wallets and the day's movers. Here is how it looks:`)
      .then(async () => say(env, B, chat, await digest(env, B, { chat_id: chat, favs: (await chatRow(env, chat)).favs, tz })));
  }
  if (cmd === '/mute') {
    const a = String(args[0] || '8h').toLowerCase();
    if (a === 'off') { await DB(env).prepare('UPDATE chats SET mute_until = 0 WHERE chat_id = ?').bind(chat).run(); return reply('🔔 Alerts are on again.'); }
    const m = a.match(/^(\d+)(m|h|d)$/);
    if (!m) return reply('Usage: /mute 30m | 8h | 2d | off');
    const until = now + Number(m[1]) * { m: 60e3, h: HOUR, d: DAY }[m[2]];
    await DB(env).prepare('UPDATE chats SET mute_until = ? WHERE chat_id = ?').bind(until, chat).run();
    return reply(`🔕 Muted until ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC. Alerts that fire meanwhile are not sent. /mute off to undo.`);
  }
  if (cmd === '/alerts' || cmd === '/list') return alertsMessage(env, B, chat);
  if (cmd === '/stop') {
    await DB(env).batch([
      DB(env).prepare('DELETE FROM watches WHERE chat_id = ?').bind(chat),
      DB(env).prepare('DELETE FROM alerts WHERE chat_id = ?').bind(chat),
      DB(env).prepare('DELETE FROM chats WHERE chat_id = ?').bind(chat),
    ]);
    return reply('Done — this chat is forgotten. /start any time to come back.');
  }

  // A bare token symbol in a private chat is a price question.
  if (isPrivate && /^[A-Za-z0-9]{2,7}(@[a-z1-5.]{1,12})?$/.test(cmdRaw) && !cmdRaw.startsWith('/')) {
    const t = await resolve(env, B, cmdRaw);
    if (t) { const c = await tokenCard(env, B, t); return reply(c.text, c.markup); }
  }
  if (cmdRaw.startsWith('/') || isPrivate) return reply('I did not understand that. Tap a button below, or ☰ Menu.', kb([[btn('☰ Menu', 'mn:main'), btn('❓ FAQ', 'mn:faq')]]));
}

async function addMove(env, B, chat, t, p) {
  const pctv = Math.max(2, Math.min(90, p));
  const lv = await live(B, t);
  if (!lv) return `No live price for ${esc(t.sym)} right now.`;
  const err = await addAlert(env, chat, 'move', t.id, t.sym, { pct: pctv }, { ref: lv.usd });
  return err || `📊 I will tell you every time <b>${tokLink(t)}</b> moves ${pctv}% from the last price I reported — starting at ${fmtUsd(lv.usd)}.`;
}
async function addWhale(env, B, chat, t, min) {
  const D = await data(env, B);
  const ps = poolsOf(D, t.id).filter(p => p.dex === 'alcor').slice(0, 3).map(p => p.id);
  if (!ps.length) return `${esc(t.sym)} has no Alcor pool with liquidity to watch.`;
  const err = await addAlert(env, chat, 'whale', t.id, t.sym, { min: Math.max(10, min), pools: ps });
  return err || `🐋 I will tell you about every ${tokLink(t)} swap above ${fmtUsd(Math.max(10, min))} in its ${ps.length} deepest Alcor pool${ps.length === 1 ? '' : 's'}.`;
}

async function alertsMessage(env, B, chat, edit = null) {
  const w = (await DB(env).prepare('SELECT account FROM watches WHERE chat_id = ?').bind(chat).all()).results;
  const a = (await DB(env).prepare('SELECT id, kind, label, params FROM alerts WHERE chat_id = ? ORDER BY id').bind(chat).all()).results;
  const c = await chatRow(env, chat);
  const describe = x => {
    const p = j(x.params);
    switch (x.kind) {
      case 'price': return `🔔 ${x.label} ${p.dir} ${p.unit === 'wax' ? `${fmtAmt(p.value)} WAX` : fmtUsd(p.value)}`;
      case 'move': return `📊 ${x.label} every ±${p.pct}%`;
      case 'whale': return `🐋 ${x.label} swaps above ${fmtUsd(p.min)}`;
      case 'newpool': return `🆕 new pools${x.label !== 'any' ? ` with ${x.label}` : ''}`;
      case 'newfarm': return `🌾 new farms${x.label !== 'any' ? ` with ${x.label}` : ''}`;
      case 'floor': return `🖼 ${x.label} under ${fmtAmt(p.below)} WAX`;
      case 'track': return `🔎 ${x.label}: ${filterText(p).replace(/<[^>]+>|&[a-z]+;/g, '')}`;
      case 'liq': return `💧 ${x.label} liquidity ${p.side === 'add' ? 'added' : p.side === 'remove' ? 'removed' : 'in/out'}${p.min ? ` ≥ ${fmtUsd(p.min)}` : ''}`;
      case 'liqlvl': return `💧 ${x.label} liquidity ${p.dir} ${fmtBig(p.value)}`;
      default: return x.kind;
    }
  };
  const lines = ['<b>This chat gets</b>'];
  if (w.length) lines.push(...w.map(x => `👛 ${esc(x.account)} — wallet alerts`));
  if (a.length) lines.push(...a.map(x => esc(describe(x))));
  if (c?.digest_hour >= 0) lines.push(`☀️ digest at ${String(c.digest_hour).padStart(2, '0')}:00 (UTC${c.tz >= 0 ? '+' : '−'}${Math.abs(c.tz / 60)})`);
  if (c?.mute_until > Date.now()) lines.push(`🔕 muted until ${new Date(c.mute_until).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  if (lines.length === 1) lines.push('Nothing yet. /help shows what I can do.');
  else lines.push('', 'Tap one to remove it.');
  const markup = kb([
    ...w.map(x => [btn(`⚙️ ${x.account}`, `s:${x.account}`), btn(`❌ ${x.account}`, `u:${x.account}`)]),
    ...a.map(x => [btn(`❌ ${describe(x)}`.slice(0, 60), `d:${x.id}`)]),
  ]);
  if (edit) return tg(env, B, 'editMessageText', { chat_id: chat, message_id: edit, text: lines.join('\n'), parse_mode: 'HTML', reply_markup: markup });
  return say(env, B, chat, lines.join('\n'), markup);
}

async function settingsMessage(env, B, chat, acct, edit = null) {
  const w = await DB(env).prepare('SELECT opts FROM watches WHERE chat_id = ? AND account = ?').bind(chat, acct).first();
  if (!w) return say(env, B, chat, `This chat is not watching <b>${esc(acct)}</b>. /watch ${esc(acct)} first.`);
  const o = optsOf(w);
  const label = k => {
    const v = o[k];
    if (k === 'fees') return `${v > 0 ? '✅' : '▫️'} ${OPT_NAME[k]}${v > 0 ? ` ≥ $${v}` : ''}`;
    if (k === 'xfer') return `${v >= 0 ? '✅' : '▫️'} ${OPT_NAME[k]}${v > 0 ? ` ≥ $${v}` : v === 0 ? ' (all)' : ''}`;
    return `${v ? '✅' : '▫️'} ${OPT_NAME[k]}`;
  };
  const text = `⚙️ <b>${esc(acct)}</b> — what to tell you about. Tap to switch; the dollar ones step through amounts.`;
  const markup = kb([...Object.keys(OPT_DEF).map(k => [btn(label(k), `o:${acct}:${k}`)]), [btn('Done', 'x')]]);
  if (edit) return tg(env, B, 'editMessageText', { chat_id: chat, message_id: edit, text, parse_mode: 'HTML', reply_markup: markup });
  return say(env, B, chat, text, markup);
}

async function onCallback(env, B, cq) {
  const chat = cq.message?.chat?.id, mid = cq.message?.message_id;
  const d = String(cq.data || '');
  const toast = text => tg(env, B, 'answerCallbackQuery', { callback_query_id: cq.id, text: text || '' });
  if (!chat) return toast();
  await chatRow(env, chat);
  if (d === 'x') { await toast('Saved'); return tg(env, B, 'editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: kb([]) }); }
  if (d.startsWith('m:')) { await toast(); return command(env, B, chat, d.slice(2), { isPrivate: cq.message.chat.type === 'private' }); }
  if (d.startsWith('mn:')) { await toast(); return menu(env, B, chat, d.slice(3), mid); }
  if (d.startsWith('ask:')) { await toast(); return ask(env, B, chat, d.slice(4)); }
  if (d.startsWith('tk:')) {
    await toast();
    const t = await resolve(env, B, d.slice(3));
    if (!t) return;
    const c = await tokenCard(env, B, t);
    return say(env, B, chat, c.text, c.markup);
  }
  if (d.startsWith('ax:')) { await toast(); return ask(env, B, chat, `#alertx:${d.slice(3)}`, `Type the price in dollars — or add “wax” for a price in WAX. e.g. <code>0.012</code> or <code>1.5 wax</code>. I work out above or below from today’s price.`); }
  if (d.startsWith('ax2:')) { await toast(); return ask(env, B, chat, `/tx ${d.slice(4)}`, `Filters for ${esc(d.slice(4))}, any mix: a token, <code>in</code> / <code>out</code>, <code>swaps</code>, <code>nfts</code>, <code>&gt;100</code>, <code>from:acct</code>, <code>to:acct</code>, <code>memo:text</code> — e.g. <code>CHEESE in &gt;10</code>`); }
  if (d.startsWith('pa:')) {
    const [, id, pc] = d.split(':');
    const t = await resolve(env, B, id), lv = t ? await live(B, t) : null;
    if (!lv) return toast('No live price right now');
    const value = Number((lv.usd * (1 + Number(pc) / 100)).toPrecision(4));
    await toast();
    return command(env, B, chat, `/alert ${t.id} ${Number(pc) > 0 ? 'above' : 'below'} ${value}`);
  }
  if (d.startsWith('s:')) { await toast(); return settingsMessage(env, B, chat, d.slice(2)); }
  if (d.startsWith('o:')) {
    const [, acct, key] = d.split(':');
    const w = await DB(env).prepare('SELECT opts FROM watches WHERE chat_id = ? AND account = ?').bind(chat, acct).first();
    if (!w || !(key in OPT_DEF)) return toast('Not watched any more');
    const o = optsOf(w);
    const cyc = OPT_CYCLE[key];
    o[key] = cyc ? cyc[(cyc.indexOf(o[key]) + 1) % cyc.length] : (o[key] ? 0 : 1);
    await DB(env).prepare('UPDATE watches SET opts = ? WHERE chat_id = ? AND account = ?').bind(JSON.stringify(o), chat, acct).run();
    await toast();
    return settingsMessage(env, B, chat, acct, mid);
  }
  if (d.startsWith('u:')) {
    await DB(env).prepare('DELETE FROM watches WHERE chat_id = ? AND account = ?').bind(chat, d.slice(2)).run();
    await toast(`Stopped watching ${d.slice(2)}`);
    return alertsMessage(env, B, chat, mid);
  }
  if (d.startsWith('d:')) {
    await DB(env).prepare('DELETE FROM alerts WHERE chat_id = ? AND id = ?').bind(chat, Number(d.slice(2))).run();
    await toast('Removed');
    return alertsMessage(env, B, chat, mid);
  }
  if (d.startsWith('mv:') || d.startsWith('wh:') || d.startsWith('fv:')) {
    const t = await resolve(env, B, d.slice(3));
    if (!t) return toast('Unknown token');
    if (d.startsWith('fv:')) { await toast(); return command(env, B, chat, `/fav ${t.id}`); }
    await toast();
    return say(env, B, chat, d.startsWith('mv:') ? await addMove(env, B, chat, t, 10) : await addWhale(env, B, chat, t, 250));
  }
  return toast();
}

// ------------------------------------------------------------------ digest --
const localDay = (ms, tz) => Math.floor((ms + tz * 60e3) / DAY);
const localHour = (ms, tz) => new Date(ms + tz * 60e3).getUTCHours();
async function digest(env, B, c) {
  const D = await data(env, B);
  const tz = c.tz || 0;
  const date = new Date(Date.now() + tz * 60e3).toUTCString().slice(0, 11);
  const wax = D.tok.get('WAX@eosio.token');
  const lines = [`☀️ <b>WaxEDGE — ${date}</b>`, '', `WAX ${fmtUsd(wax?.usd ?? D.wax)} ${wax?.ch != null ? `${arrow(wax.ch)} ${pct(wax.ch)}` : ''}`];
  for (const id of j(c.favs, []).slice(0, LIM.favs)) {
    const t = D.tok.get(id);
    if (t && t.sym !== 'WAX') lines.push(`${esc(t.sym)} ${fmtUsd(t.usd)} ${t.ch != null ? `${arrow(t.ch)} ${pct(t.ch)}` : ''}`);
  }
  const ws = (await DB(env).prepare('SELECT account FROM watches WHERE chat_id = ?').bind(c.chat_id).all()).results.slice(0, 3);
  if (ws.length) lines.push('');
  for (const { account: a } of ws) {
    const pos = await positions(B, a);
    if (!pos) { lines.push(`👛 ${esc(a)}: positions unavailable right now`); continue; }
    const v = pos.reduce((s, p) => s + p.value, 0), out = pos.filter(p => !p.inRange).length;
    const fees = pos.reduce((s, p) => s + (valued(D, p).fees || 0), 0);
    lines.push(`👛 ${walletLink(a, a)} — LP ${fmtUsd(v)}${pos.length ? ` · ${out ? `⚠️ ${out} out of range` : 'all in range'}` : ''}${fees >= 0.5 ? ` · ${fmtUsd(fees)} fees to compound` : ''}`);
  }
  const waxCh = wax?.ch, rel = waxCh != null && Math.abs(waxCh) >= 1;
  const own = t => (rel ? ((1 + t.ch / 100) / (1 + waxCh / 100) - 1) * 100 : t.ch);
  const liquid = [...D.tok.values()].filter(t => t.liq >= 1000 && t.ch != null && t.ch !== 0 && t.sym !== 'WAX' && !(/USD|EUR|JPY/.test(t.sym) && t.usd > 0.2));
  const up = [...liquid].sort((a, b) => own(b) - own(a))[0], dn = [...liquid].sort((a, b) => own(a) - own(b))[0];
  const mv = t => `${tokLink(t)} ${pct(own(t))}`;
  if (up || dn) lines.push('', `Movers${rel ? ' vs WAX' : ''}: ${[up && own(up) > 0.5 ? mv(up) : '', dn && own(dn) < -0.5 ? mv(dn) : ''].filter(Boolean).join(' · ') || 'a quiet day'}`);
  const top = D.farms.find(f => f.staked >= 100);
  if (top) { const p = D.poolById.get(`${top.pd}:${top.pi}`); if (p) lines.push(`Best farm: ${poolLink(p.dex, p.id, `${p.a}/${p.b}`)} ${top.apr?.toFixed(0)}% in ${esc(top.rs)} — /farms`); }
  return lines.join('\n');
}

// -------------------------------------------------------------------- cron --
// One run: read everything in one batch, do this minute's share, write in one.
async function tick(env, when) {
  const B = budget(45);
  const now = when || Date.now();
  const minute = new Date(now).getUTCMinutes();
  const [W, A, C, K] = (await DB(env).batch([
    DB(env).prepare('SELECT chat_id, account, state, opts FROM watches ORDER BY account'),
    DB(env).prepare('SELECT * FROM alerts'),
    DB(env).prepare('SELECT * FROM chats'),
    DB(env).prepare('SELECT k, v FROM cursor'),
  ])).map(r => r.results || []);
  const chats = new Map(C.map(c => [c.chat_id, c]));
  const cur = new Map(K.map(k => [k.k, k.v]));
  const dirty = new Map();                           // cursor keys to write
  const writes = [];
  const setCur = (k, v) => { cur.set(k, v); dirty.set(k, v); };
  const MAX_SENDS = 15;
  const send = async (chat, text, markup) => {
    if ((chats.get(chat)?.mute_until || 0) > now || B.sends >= MAX_SENDS) return false;
    B.sends++;
    await say(env, B, chat, text, markup);
    return true;
  };
  const D = await data(env, B);
  const accounts = [...new Set(W.map(w => w.account))];
  const watchesOf = a => W.filter(w => w.account === a);
  const rotate = (key, list, n) => {
    if (!list.length) return [];
    const start = (cur.get(key) || 0) % list.length;
    setCur(key, (start + n) % list.length);         // advanced first: a run that dies on one item moves past it
    return [...list, ...list].slice(start, start + Math.min(n, list.length));
  };
  const saveWatch = (w, st) => { const s = JSON.stringify(st); if (s !== w.state) { w.state = s; writes.push(DB(env).prepare('UPDATE watches SET state = ? WHERE chat_id = ? AND account = ?').bind(s, w.chat_id, w.account)); } };

  const jobs = [];
  // ---- positions: ranges, edges, fees, farms ending ------------------------
  jobs.push(async () => {
    for (const a of rotate('pos', accounts, 3)) {
      const pos = await positions(B, a);
      if (!pos) continue;
      const byId = new Map(pos.map(p => [p.id, p]));
      for (const w of watchesOf(a)) {
        const o = optsOf(w), st = stateOf(w), msgs = [];
        st.e = st.e || {}; st.f = st.f || {}; st.fe = st.fe || {};
        for (const p of pos) {
          const was = st.r[p.id];
          const lnk = `${poolLink('alcor', p.pool, p.pair)} (${fmtUsd(p.value)})`;
          if (o.range && was === 1 && !p.inRange) msgs.push(`⚠️ ${lnk} is <b>out of range</b> — no fees until the price returns, or until you move the range.`);
          if (o.range && was === 0 && p.inRange) msgs.push(`✅ ${lnk} is <b>back in range</b> and earning again.`);
          const v = valued(D, p);
          // In range but nearly all one token: the price is at one edge.
          if (p.inRange && v.shareA != null) {
            const side = v.shareA > 0.92 ? 'lower' : v.shareA < 0.08 ? 'upper' : null;
            if (side && !st.e[p.id] && o.edge) { msgs.push(`⏳ ${lnk} is close to the <b>${side} edge</b> of its range — ${((side === 'lower' ? v.shareA : 1 - v.shareA) * 100).toFixed(0)}% ${esc(side === 'lower' ? p.symA : p.symB)} already.`); st.e[p.id] = 1; }
            if (!side && v.shareA > 0.15 && v.shareA < 0.85) delete st.e[p.id];
          }
          if (o.fees > 0 && v.fees != null) {
            if (v.fees >= o.fees && !st.f[p.id]) { msgs.push(`💰 ${fmtUsd(v.fees)} in fees waiting on ${poolLink('alcor', p.pool, p.pair)} — <a href="${SITE}/wallet/${encodeURIComponent(a)}">compound them</a>.`); st.f[p.id] = 1; }
            if (v.fees < o.fees / 2) delete st.f[p.id];
          }
          st.r[p.id] = p.inRange ? 1 : 0;
        }
        for (const id of Object.keys(st.r)) if (!byId.has(id)) { delete st.r[id]; delete st.e[id]; delete st.f[id]; }
        st.pl = [...new Set(pos.map(p => p.pool))];
        if (o.farm) {
          for (const f of D.farms) {
            if (f.pd !== 'alcor' || !st.pl.includes(f.pi) || st.fe[f.id] || f.end - now > DAY || f.end < now) continue;
            const pl = D.poolById.get(`alcor:${f.pi}`);
            msgs.push(`⌛ The ${esc(f.rs)} farm on ${pl ? poolLink('alcor', f.pi, `${pl.a}/${pl.b}`) : `pool ${f.pi}`} ends in ${ago(f.end - now)}.`);
            st.fe[f.id] = 1;
          }
        }
        if (msgs.length) await send(w.chat_id, `👛 <b>${esc(a)}</b>\n${msgs.slice(0, 10).join('\n')}\n\n${walletLink(a)}`);
        saveWatch(w, st);
      }
    }
  });

  // ---- transfers, swaps and NFTs: watched wallets and /track ----------------
  const tracks = A.filter(x => x.kind === 'track');
  jobs.push(async () => {
    const want = [...new Set([
      ...accounts.filter(a => watchesOf(a).some(w => { const o = optsOf(w); return o.xfer >= 0 || o.nft; })),
      ...tracks.map(x => x.target)])].sort();
    for (const a of rotate('act', want, 5)) {
      // When everyone asking about this account wants one direction only, the
      // server filters on it: an account that is also a token contract is
      // otherwise notified of every transfer of its token, which fills the page.
      const dirs = new Set([...watchesOf(a).map(() => 'both'), ...tracks.filter(y => y.target === a).map(y => j(y.params).dir || 'both')]);
      const only = dirs.size === 1 && !dirs.has('both') ? [...dirs][0] : null;
      const d = await hyp(B, `/v2/history/get_actions?account=${a}&filter=*:transfer&limit=40&sort=desc${only ? `&transfer.${only === 'in' ? 'to' : 'from'}=${a}` : ''}`);
      if (!d?.actions) continue;
      const seen = cur.get(`seq:${a}`);
      const top = Math.max(0, ...d.actions.map(x => Number(x.global_sequence) || 0));
      if (top) setCur(`seq:${a}`, Math.max(top, seen || 0));
      if (!seen) continue;                           // first look: remember where we are, tell nothing
      const fresh = [...new Map(d.actions.filter(x => Number(x.global_sequence) > seen).map(x => [x.global_sequence, x])).values()];
      const events = eventsFrom(D, a, fresh);
      if (!events.length) continue;
      const list = es => `${es.slice(0, 8).map(e => e.text).join('\n')}${es.length > 8 ? `\n… and ${es.length - 8} more` : ''}`;
      for (const w of watchesOf(a)) {
        const o = optsOf(w);
        // A watched wallet skips unpriced tokens: incoming ones are nearly always airdrop spam.
        const mine = events.filter(e => (e.kind === 'nft' ? o.nft : o.xfer >= 0 && e.usd != null && e.usd >= o.xfer));
        if (mine.length) await send(w.chat_id, `👛 <b>${esc(a)}</b>\n${list(mine)}\n\n${walletLink(a)}`);
      }
      for (const x of tracks.filter(y => y.target === a)) {
        const f = j(x.params);
        const mine = events.filter(e => matches(e, f));
        if (mine.length) await send(x.chat_id, `🔎 <b>${esc(a)}</b> <i>(${filterText(f)})</i>\n${list(mine)}\n\n${walletLink(a)}`);
      }
    }
  });

  // ---- liquidity in and out (even minutes) ----------------------------------
  const liqAlerts = A.filter(x => x.kind === 'liq');
  if (minute % 2 === 0 && liqAlerts.length) jobs.push(async () => {
    const needTaco = liqAlerts.some(x => !x.target.startsWith('alcor:'));
    for (const [filter, key] of LIQ_FEEDS.filter(([fl]) => needTaco || fl.startsWith('swap.alcor'))) {
      const d = await hyp(B, `/v2/history/get_actions?filter=${filter}&limit=40&sort=desc`);
      if (!d?.actions) continue;
      const seen = cur.get(key);
      const top = Math.max(0, ...d.actions.map(x => Number(x.global_sequence) || 0));
      if (top) setCur(key, Math.max(top, seen || 0));
      if (!seen) continue;
      const fresh = d.actions.filter(x => Number(x.global_sequence) > seen).sort((p, q) => p.global_sequence - q.global_sequence).slice(-12);
      // Only events somebody asked about are valued: each costs at most one read.
      const wanted = x => {
        const dt = x.act.data;
        if (x.act.account === 'swap.alcor') {
          const pl = D.poolById.get(`alcor:${dt.poolId}`);
          return liqAlerts.some(y => y.target === '*' || y.target === `alcor:${dt.poolId}` || !pl || y.target === pl.ia || y.target === pl.ib);
        }
        return liqAlerts.some(y => !y.target.startsWith('alcor:'));
      };
      for (const x of fresh.filter(wanted)) {
        const e = await liqEvent(B, D, x);
        if (!e) continue;
        for (const y of liqAlerts) {
          const p = j(y.params);
          const hit = y.target === '*' || y.target === `${e.dex}:${e.pool.id}` || y.target === e.pool.ia || y.target === e.pool.ib;
          if (!hit || (p.side === 'add' && !e.add) || (p.side === 'remove' && e.add)) continue;
          if ((p.min || 0) > 0 && !(e.usd != null && e.usd >= p.min)) continue;
          // A share of the pool, so "big for this pool" is visible even when the dollars are small.
          const big = e.after > 0 && e.usd != null ? e.usd / (e.add ? e.after : e.after + e.usd) : null;
          await send(y.chat_id, `${liqText(e)}${big != null && big >= 0.1 ? `\n   ⚡ that is ${(big * 100).toFixed(0)}% of the pool` : ''}`);
        }
      }
    }
  });

  // ---- resources and vote rewards (every 5 minutes) ------------------------
  if (minute % 5 === 0) jobs.push(async () => {
    const want = accounts.filter(a => watchesOf(a).some(w => { const o = optsOf(w); return o.res || o.claim; }));
    for (const a of rotate('res', want, 6)) {
      const acc = await account(B, a);
      if (!acc) continue;
      const r = resources(acc);
      const day = Math.floor(now / DAY);
      for (const w of watchesOf(a)) {
        const o = optsOf(w), st = stateOf(w), msgs = [];
        st.rs = st.rs || {};
        if (o.res) {
          for (const [k, v, name] of [['cpu', r.cpu, 'CPU'], ['net', r.net, 'NET'], ['ram', r.ram, 'RAM']]) {
            if (v >= 0.9 && !st.rs[k]) { msgs.push(`🔋 ${name} is at <b>${(v * 100).toFixed(0)}%</b>${k === 'ram' ? ` — ${fmtAmt(r.ramFree / 1024)} KB left` : ''}. Transactions will start failing — <a href="${SITE}/staking">add ${k === 'ram' ? 'RAM' : 'resources'}</a>.`); st.rs[k] = 1; }
            if (v < 0.7) delete st.rs[k];
          }
        }
        if (o.claim && r.staked >= 1) {
          if (r.voting && now - r.lastClaim >= DAY && st.cl !== day) { msgs.push(`🎁 Your vote rewards are ready — ${fmtAmt(r.staked)} WAX staked. <a href="${SITE}/staking">Claim on WaxEDGE</a>.`); st.cl = day; }
          if (!r.voting && r.staked >= 100 && !st.nv) { msgs.push(`💤 ${fmtAmt(r.staked)} WAX is staked but not voting, so it earns no vote rewards. <a href="${SITE}/staking">Vote or pick a proxy</a>.`); st.nv = 1; }
          if (r.voting) delete st.nv;
        }
        if (msgs.length) await send(w.chat_id, `👛 <b>${esc(a)}</b>\n${msgs.join('\n')}`);
        saveWatch(w, st);
      }
    }
  });

  // ---- price and move alerts (every 2 minutes) ------------------------------
  const priceAlerts = A.filter(x => x.kind === 'price' || x.kind === 'move');
  if (minute % 2 === 0 && priceAlerts.length) jobs.push(async () => {
    const targets = [...new Set(priceAlerts.map(x => x.target))].sort();
    for (const id of rotate('tok', targets, 12)) {
      const t = D.tok.get(id) || { id, sym: id.split('@')[0], c: id.split('@')[1] };
      const lv = await live(B, t);
      if (!lv) continue;
      for (const x of priceAlerts.filter(y => y.target === id)) {
        const p = j(x.params), s = j(x.state);
        if (x.kind === 'price') {
          const v = p.unit === 'wax' ? lv.wax : lv.usd;
          if (v == null || !(p.dir === 'above' ? v >= p.value : v <= p.value)) continue;
          const f = n => (p.unit === 'wax' ? `${fmtAmt(n)} WAX` : fmtUsd(n));
          if (await send(x.chat_id, `🔔 <b>${tokLink(t)}</b> is ${p.dir} ${f(p.value)} — now <b>${f(v)}</b>.`, kb([[btn('📊 Keep me posted: ±10%', `mv:${id}`)]]))) {
            writes.push(DB(env).prepare('DELETE FROM alerts WHERE id = ?').bind(x.id));
          }
        } else {
          const ref = s.ref || lv.usd, ch = (lv.usd / ref - 1) * 100;
          if (!s.ref) { writes.push(DB(env).prepare('UPDATE alerts SET state = ? WHERE id = ?').bind(JSON.stringify({ ref: lv.usd }), x.id)); continue; }
          if (Math.abs(ch) < p.pct) continue;
          if (await send(x.chat_id, `${ch > 0 ? '📈' : '📉'} <b>${tokLink(t)}</b> ${pct(ch)} since ${fmtUsd(ref)} — now <b>${fmtUsd(lv.usd)}</b>${lv.wax ? ` · ${fmtAmt(lv.wax)} WAX` : ''}.`)) {
            writes.push(DB(env).prepare('UPDATE alerts SET state = ? WHERE id = ?').bind(JSON.stringify({ ref: lv.usd, at: now }), x.id));
          }
        }
      }
    }
  });

  // ---- whale swaps (odd minutes) ---------------------------------------------
  const whales = A.filter(x => x.kind === 'whale');
  if (minute % 2 === 1 && whales.length) jobs.push(async () => {
    const pools = [...new Set(whales.flatMap(x => j(x.params).pools || []))].sort();
    for (const pid of rotate('wh', pools, 8)) {
      const rows = await get(B, `${ALCOR}/swap/pools/${pid}/swaps?limit=25`);
      if (!Array.isArray(rows)) continue;
      const seen = cur.get(`wp:${pid}`);
      const newest = Math.max(0, ...rows.map(r => Date.parse(r.time) || 0));
      if (newest) setCur(`wp:${pid}`, Math.max(newest, seen || 0));
      if (!seen) continue;
      const pl = D.poolById.get(`alcor:${pid}`);
      if (!pl) continue;
      const fresh = rows.filter(r => (Date.parse(r.time) || 0) > seen);
      for (const x of whales.filter(y => (j(y.params).pools || []).includes(pid))) {
        const p = j(x.params);
        const isA = pl.ia === x.target;
        const big = fresh.filter(r => (Number(r.totalUSDVolume) || 0) >= p.min).slice(0, 5);
        if (!big.length) continue;
        const t = D.tok.get(x.target) || { id: x.target, sym: x.label, c: x.target.split('@')[1] };
        // The pool's side of the swap: a negative amount left the pool, which
        // is the token the trader bought.
        const lines = big.map(r => {
          const amt = isA ? Number(r.tokenA) : Number(r.tokenB), other = isA ? Number(r.tokenB) : Number(r.tokenA);
          const buy = amt < 0;
          const who = r.recipient && r.recipient !== 'swap.alcor' ? r.recipient : r.sender;
          return `${buy ? '🟢 BUY' : '🔴 SELL'} ${fmtAmt(Math.abs(amt))} ${esc(t.sym)} for ${fmtAmt(Math.abs(other))} ${esc(isA ? pl.b : pl.a)} · <b>${fmtUsd(Number(r.totalUSDVolume))}</b> · <code>${esc(who)}</code>`;
        });
        await send(x.chat_id, `🐋 <b>${tokLink(t)}</b> on ${poolLink('alcor', pid, `${pl.a}/${pl.b}`)}\n${lines.join('\n')}`);
      }
    }
  });

  // ---- new pools and new farms (every 5 minutes) ----------------------------
  if (minute % 5 === 0) jobs.push(async () => {
    const feedP = A.filter(x => x.kind === 'newpool'), feedF = A.filter(x => x.kind === 'newfarm');
    const farmWatch = W.filter(w => optsOf(w).farm && (stateOf(w).pl || []).length);
    if (feedP.length) {
      const d = await chain(B, 'get_table_rows', { code: 'swap.alcor', scope: 'swap.alcor', table: 'pools', json: true, limit: 15, reverse: true });
      const rows = d?.rows || [];
      const last = cur.get('newpool');
      if (rows.length) setCur('newpool', Math.max(last || 0, ...rows.map(r => r.id)));
      if (last) for (const r of rows.filter(r => r.id > last).reverse()) {
        const qa = parseQty(r.tokenA.quantity), qb = parseQty(r.tokenB.quantity);
        const ia = `${qa.sym}@${r.tokenA.contract}`, ib = `${qb.sym}@${r.tokenB.contract}`;
        for (const x of feedP.filter(y => y.target === '*' || y.target === ia || y.target === ib)) {
          await send(x.chat_id, `🆕 <b>New Alcor pool</b>: ${poolLink('alcor', r.id, `${qa.sym}/${qb.sym}`)} · ${(r.fee / 10000).toFixed(2)}% fee\n<code>${esc(r.tokenA.contract)}</code> / <code>${esc(r.tokenB.contract)}</code>${Number(r.liquidity) > 0 ? '' : '\nEmpty so far — the first deposit is still to come.'}`);
        }
      }
    }
    if (feedF.length || farmWatch.length) {
      const d = await chain(B, 'get_table_rows', { code: 'swap.alcor', scope: 'swap.alcor', table: 'incentives', json: true, limit: 15, reverse: true });
      const rows = d?.rows || [];
      const last = cur.get('newfarm');
      if (rows.length) setCur('newfarm', Math.max(last || 0, ...rows.map(r => r.id)));
      if (last) for (const r of rows.filter(r => r.id > last).reverse()) {
        const q = parseQty(r.reward.quantity), rid = `${q.sym}@${r.reward.contract}`;
        const days = Math.round((r.rewardsDuration || 0) / 86400);
        const rt = D.tok.get(rid);
        let pl = D.poolById.get(`alcor:${r.poolId}`);
        if (!pl) {
          const pr = (await chain(B, 'get_table_rows', { code: 'swap.alcor', scope: 'swap.alcor', table: 'pools', json: true, limit: 1, lower_bound: String(r.poolId) }))?.rows?.[0];
          if (pr && pr.id === r.poolId) { const a = parseQty(pr.tokenA.quantity), b = parseQty(pr.tokenB.quantity); pl = { id: String(pr.id), a: a.sym, b: b.sym, ia: `${a.sym}@${pr.tokenA.contract}`, ib: `${b.sym}@${pr.tokenB.contract}` }; }
        }
        const label = pl ? poolLink('alcor', r.poolId, `${pl.a}/${pl.b}`) : `pool ${r.poolId}`;
        const what = `${fmtAmt(q.n)} ${rt ? tokLink(rt) : esc(q.sym)}${rt ? ` (${fmtUsd(q.n * rt.usd)})` : ''} over ${days} day${days === 1 ? '' : 's'}`;
        const sent = new Set();
        for (const w of farmWatch.filter(w => (stateOf(w).pl || []).includes(String(r.poolId)))) {
          if (sent.has(w.chat_id)) continue;
          sent.add(w.chat_id);
          await send(w.chat_id, `🌾 <b>A farm just started on your pool</b> ${label} (${esc(w.account)}): ${what}.\nOnly staked positions earn it — <a href="${SITE}/wallet/${encodeURIComponent(w.account)}">join the farm</a>.`);
        }
        for (const x of feedF.filter(y => y.target === '*' || y.target === rid || y.target === pl?.ia || y.target === pl?.ib)) {
          if (sent.has(x.chat_id)) continue;
          sent.add(x.chat_id);
          await send(x.chat_id, `🌾 <b>New Alcor farm</b> on ${label}: ${what}.\n<a href="${SITE}/farms">Farms on WaxEDGE</a>`);
        }
      }
    }
  });

  // ---- NFT floors (every 5 minutes, offset) ---------------------------------
  const floors = A.filter(x => x.kind === 'floor');
  if (minute % 5 === 2 && floors.length) jobs.push(async () => {
    for (const x of rotate('fl', floors.map(f => f.id).sort((a, b) => a - b), 6).map(id => floors.find(f => f.id === id))) {
      const p = j(x.params);
      const q = new URLSearchParams({ state: '1', collection_name: x.target, sort: 'price', order: 'asc', limit: '1', symbol: 'WAX' });
      if (p.tpl) q.set('template_id', String(p.tpl));
      const s = (await get(B, `${AA}/atomicmarket/v2/sales?${q}`))?.data?.[0];
      if (!s) continue;
      const price = Number(s.price.amount) / 10 ** s.price.token_precision;
      if (price > p.below) continue;
      if (await send(x.chat_id, `🖼 <b>${esc(x.label)}</b> listed at <b>${fmtAmt(price)} WAX</b> (your line: ${fmtAmt(p.below)})\n${esc(s.assets?.[0]?.name || '')} #${esc(s.assets?.[0]?.template_mint || '')}\n<a href="https://wax.atomichub.io/market/sale/wax-mainnet/${s.sale_id}">Open the sale</a>`)) {
        writes.push(DB(env).prepare('DELETE FROM alerts WHERE id = ?').bind(x.id));
      }
    }
  });

  // ---- total liquidity crossing a line (from the snapshot; no requests) -----
  const levels = A.filter(x => x.kind === 'liqlvl');
  if (minute % 5 === 1 && levels.length) jobs.push(async () => {
    for (const x of levels) {
      const p = j(x.params), t = D.tok.get(x.target);
      const v = t?.liq ?? 0;
      if (!(p.dir === 'above' ? v >= p.value : v <= p.value)) continue;
      if (await send(x.chat_id, `💧 <b>${t ? tokLink(t) : esc(x.label)}</b> liquidity is ${p.dir} ${fmtBig(p.value)} — now <b>${fmtBig(v)}</b> across its pools.`,
        kb([[btn('💧 Pools', `m:/liquidity ${x.target}`)]]))) {
        writes.push(DB(env).prepare('DELETE FROM alerts WHERE id = ?').bind(x.id));
      }
    }
  });

  // ---- daily digests ------------------------------------------------------
  jobs.push(async () => {
    const due = C.filter(c => c.digest_hour >= 0 && localHour(now, c.tz || 0) === c.digest_hour && c.digest_day !== localDay(now, c.tz || 0)).slice(0, 2);
    for (const c of due) {
      writes.push(DB(env).prepare('UPDATE chats SET digest_day = ? WHERE chat_id = ?').bind(localDay(now, c.tz || 0), c.chat_id));
      await send(c.chat_id, await digest(env, B, c));
    }
  });

  for (const job of jobs) { try { await job(); } catch (e) { console.log('job failed', e?.message); } }
  for (const [k, v] of dirty) writes.push(DB(env).prepare('INSERT OR REPLACE INTO cursor (k, v) VALUES (?, ?)').bind(k, v));
  for (let i = 0; i < writes.length; i += 40) await DB(env).batch(writes.slice(i, i + 40));
  return { left: B.left, sends: B.sends, writes: writes.length };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/telegram') {
      // Only Telegram knows this secret; anything else is not a message.
      if (req.headers.get('x-telegram-bot-api-secret-token') !== env.TG_SECRET) return new Response('no', { status: 401 });
      const u = await req.json().catch(() => null);
      const B = budget(40);
      try {
        const m = u?.message;
        if (m?.text) {
          const chat = m.chat.id, isPrivate = m.chat.type === 'private', text = m.text.trim();
          const toMe = isPrivate || text.startsWith('/') || m.reply_to_message?.from?.is_bot;
          if (KEYS[text]) {
            await DB(env).prepare("UPDATE chats SET pending = '' WHERE chat_id = ?").bind(chat).run().catch(() => {});
            await menu(env, B, chat, KEYS[text]);
          } else if (toMe && !text.startsWith('/')) {
            const c = await chatRow(env, chat);
            if (c.pending && Date.now() - (c.pending_at || 0) < 15 * 60e3) await answer(env, B, chat, c.pending, text, isPrivate);
            else if (isPrivate) await command(env, B, chat, text, { isPrivate });
          } else if (toMe) {
            await DB(env).prepare("UPDATE chats SET pending = '' WHERE chat_id = ?").bind(chat).run().catch(() => {});
            await command(env, B, chat, text, { isPrivate });
          }
        }
        else if (u?.callback_query) await onCallback(env, B, u.callback_query);
      } catch (e) { console.log('update failed', e?.message); }
      return new Response('ok');
    }
    // Local testing only: wrangler dev exposes /__scheduled; this reports the run.
    if (env.DEV === '1' && url.pathname === '/tick') return Response.json(await tick(env, Number(url.searchParams.get('at')) || Date.now()));
    return new Response('WaxEDGE alerts — talk to the bot on Telegram.', { status: 200 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env, event.scheduledTime));
  },
};
