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
const small = v => v.toFixed(Math.min(12, Math.max(2, 2 - Math.floor(Math.log10(Math.abs(v)))))).replace(/(\.\d\d\d*?)0+$/, '$1');
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
    [btn('🔔 Alert me on ±10%', `mv:${t.id}`), btn('🐋 Whale swaps', `wh:${t.id}`)],
    [btn('⭐ Favourite', `fv:${t.id}`), btn('💧 Pools', `m:/pools ${t.id}`), btn('🌾 Farms', `m:/farms ${t.sym}`)],
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
  '/floor <i>collection</i> [<i>template</i>] below <i>WAX</i>',
  '',
  '<b>☀️ Daily</b>',
  '/digest <i>8</i> [<i>+2</i>] — a morning summary at 08:00 (UTC+2)',
  '/fav <i>SYM</i> · /favs — your price board',
  '',
  '/alerts — everything this chat gets · /mute <i>8h</i> · /stop',
].join('\n');
const MENU = kb([
  [btn('📈 Top movers', 'm:/top'), btn('🌾 Best farms', 'm:/farms'), btn('💲 WAX', 'm:/wax')],
  [btn('🔔 My alerts', 'm:/alerts'), btn('⭐ Favourites', 'm:/favs'), btn('❓ Help', 'm:/help')],
]);

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
    return reply(`👋 <b>Welcome to WaxEDGE.</b>\n\nWatch a wallet and I will tell you when a position goes out of range, fees are ready to compound, a farm starts on your pool, money moves in or out, or CPU runs low.\n\nStart with /watch <i>youraccount</i> — or tap around below.`, MENU);
  }
  if (cmd === '/help') return reply(HELP, MENU);

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
    const liquid = [...D.tok.values()].filter(t => t.liq >= 1000 && t.ch != null && t.sym !== 'WAX');
    const up = [...liquid].sort((a, b) => b.ch - a.ch).slice(0, 5).filter(t => t.ch > 0);
    const dn = [...liquid].sort((a, b) => a.ch - b.ch).slice(0, 5).filter(t => t.ch < 0);
    const vol = [...D.tok.values()].filter(t => t.sym !== 'WAX' && !/USD/.test(t.sym)).sort((a, b) => b.vol - a.vol).slice(0, 5);
    const row = t => `• ${tokLink(t)} ${fmtUsd(t.usd)} ${arrow(t.ch)} ${pct(t.ch)}`;
    return reply([`📈 <b>24h movers</b> <i>(tokens with $1k+ liquidity)</i>`, ...up.map(row), '', '📉 <b>Down</b>', ...dn.map(row), '',
      '🔥 <b>Most traded</b>', ...vol.map(t => `• ${tokLink(t)} ${fmtBig(t.vol)} ${pct(t.ch)}`), '',
      `<i>As of ${new Date(D.at).toISOString().slice(11, 16)} UTC</i> · <a href="${SITE}/tokens">All tokens</a>`].join('\n'));
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
    return reply(`☀️ Every day at ${String(hour).padStart(2, '0')}:00 (UTC${tz >= 0 ? '+' : '−'}${Math.abs(tz / 60)}): WAX, your /favs, your watched wallets and the day's movers. Here is how it looks:`)
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
  if (cmdRaw.startsWith('/') || isPrivate) return reply(HELP, MENU);
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
  const liquid = [...D.tok.values()].filter(t => t.liq >= 1000 && t.ch != null && t.sym !== 'WAX');
  const up = [...liquid].sort((a, b) => b.ch - a.ch)[0], dn = [...liquid].sort((a, b) => a.ch - b.ch)[0];
  if (up || dn) lines.push('', `Movers: ${up ? `${tokLink(up)} ${pct(up.ch)}` : ''}${up && dn ? ' · ' : ''}${dn ? `${tokLink(dn)} ${pct(dn.ch)}` : ''} — /top`);
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

  // ---- transfers, swaps and NFTs --------------------------------------------
  jobs.push(async () => {
    const want = accounts.filter(a => watchesOf(a).some(w => { const o = optsOf(w); return o.xfer >= 0 || o.nft; }));
    for (const a of rotate('act', want, 4)) {
      const d = await hyp(B, `/v2/history/get_actions?account=${a}&filter=*:transfer&limit=30&sort=desc`);
      if (!d?.actions) continue;
      const seen = cur.get(`seq:${a}`);
      const top = Math.max(0, ...d.actions.map(x => Number(x.global_sequence) || 0));
      if (top) setCur(`seq:${a}`, Math.max(top, seen || 0));
      if (!seen) continue;                           // first look: remember where we are, tell nothing
      const fresh = [...new Map(d.actions.filter(x => Number(x.global_sequence) > seen).map(x => [x.global_sequence, x])).values()]
        .sort((x, y) => x.global_sequence - y.global_sequence);
      const byTrx = new Map();
      for (const x of fresh) {
        const dt = x.act.data || {};
        if (dt.from === dt.to || (dt.from !== a && dt.to !== a)) continue;
        if (!byTrx.has(x.trx_id)) byTrx.set(x.trx_id, []);
        byTrx.get(x.trx_id).push(x);
      }
      const events = [];
      for (const [, xs] of byTrx) {
        const tok = [], nft = [];
        for (const x of xs) {
          const dt = x.act.data;
          if (Array.isArray(dt.asset_ids)) { nft.push({ in: dt.to === a, n: dt.asset_ids.length, who: dt.to === a ? dt.from : dt.to }); continue; }
          const q = parseQty(dt.quantity);
          const t = D.tok.get(`${q.sym}@${x.act.account}`);
          tok.push({ in: dt.to === a, n: q.n, sym: q.sym, t, usd: t ? q.n * t.usd : null, who: dt.to === a ? dt.from : dt.to, memo: dt.memo });
        }
        const ins = tok.filter(x => x.in), outs = tok.filter(x => !x.in);
        const name = x => `${fmtAmt(x.n)} ${x.t ? tokLink(x.t) : esc(x.sym)}`;
        if (ins.length && outs.length) {
          const usd = Math.max(ins.reduce((s, x) => s + (x.usd || 0), 0), outs.reduce((s, x) => s + (x.usd || 0), 0));
          const priced = ins.some(x => x.usd != null) || outs.some(x => x.usd != null);
          events.push({ kind: 'x', usd: priced ? usd : null, text: `🔁 Swapped ${outs.map(name).join(' + ')} → ${ins.map(name).join(' + ')}${priced ? ` (${fmtUsd(usd)})` : ''}` });
        } else {
          for (const x of tok) {
            if (x.usd == null) continue;                 // unpriced incoming tokens are nearly always airdrop spam
            events.push({ kind: 'x', usd: x.usd, text: `${x.in ? '📥 Received' : '📤 Sent'} ${name(x)} (${fmtUsd(x.usd)}) ${x.in ? 'from' : 'to'} <code>${esc(x.who)}</code>${x.memo && x.memo.length <= 60 ? ` — “${esc(x.memo)}”` : ''}` });
          }
        }
        for (const x of nft) events.push({ kind: 'n', text: `🖼 ${x.in ? 'Received' : 'Sent'} ${x.n} NFT${x.n === 1 ? '' : 's'} ${x.in ? 'from' : 'to'} <code>${esc(x.who)}</code>` });
      }
      if (!events.length) continue;
      for (const w of watchesOf(a)) {
        const o = optsOf(w);
        const mine = events.filter(e => (e.kind === 'n' ? o.nft : o.xfer >= 0 && e.usd != null && e.usd >= o.xfer));
        if (!mine.length) continue;
        await send(w.chat_id, `👛 <b>${esc(a)}</b>\n${mine.slice(0, 8).map(e => e.text).join('\n')}${mine.length > 8 ? `\n… and ${mine.length - 8} more` : ''}\n\n${walletLink(a)}`);
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
        if (u?.message?.text && (u.message.text.startsWith('/') || u.message.chat.type === 'private')) await command(env, B, u.message.chat.id, u.message.text, { isPrivate: u.message.chat.type === 'private' });
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
