// =============================================================================
// WaxEDGE alert bot — a Cloudflare Worker, Free plan.
//
// Opt-in only. The bot answers people who message it, and sends alerts to the
// chats that asked for them; there is no broadcast, no list of users to write
// to, and nothing here sends a message on anyone's behalf.
//
//   /watch <account>         alerts when an Alcor position leaves its range, and
//                            when it comes back
//   /price <SYM> above|below <usd>   one alert, then it removes itself
//   /list  /unwatch <account>  /stop (forgets the chat entirely)
//
// Budget. The Free plan allows 50 outgoing requests and a few milliseconds of
// CPU per run, and D1 a generous number of writes a day. So the cron works in
// small batches that rotate through everything being watched, and the database
// is written only when something actually changed.
// =============================================================================

const ALCOR = 'https://wax.alcor.exchange/api/v2';
const SITE = 'https://waxedge.app';
const MAX_WATCH = 3, MAX_PRICE = 5;
const ACCOUNTS_PER_RUN = 15, TOKENS_PER_RUN = 10, SENDS_PER_RUN = 20;
const ACCOUNT_RE = /^[a-z1-5.]{1,12}$/;

// ---------------------------------------------------------------- telegram --
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.ok ? r.json() : null;
}
const say = (env, chat, text) => tg(env, 'sendMessage', {
  chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true,
});
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ------------------------------------------------------------------- alcor --
async function positions(account) {
  const r = await fetch(`${ALCOR}/account/${encodeURIComponent(account)}/positions`, { cf: { cacheTtl: 60 } });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows.filter(p => !p.closed).map(p => ({
    id: String(p.id),
    pair: `${String(p.amountA || '').split(' ')[1] || '?'}/${String(p.amountB || '').split(' ')[1] || '?'}`,
    inRange: !!p.inRange,
  }));
}
async function tokenPrice(id) {
  const r = await fetch(`${ALCOR}/tokens/${encodeURIComponent(id)}`, { cf: { cacheTtl: 60 } });
  if (!r.ok) return null;
  const t = await r.json();
  return Number(t.usd_price) > 0 ? Number(t.usd_price) : null;
}
// A symbol to one token. Several contracts can issue the same symbol; the one
// Alcor trusts, then the one with the best score, is the one people mean.
async function resolveToken(input) {
  const [sym, contract] = input.toUpperCase().split('@');
  if (contract) return { id: `${sym.toLowerCase()}-${contract.toLowerCase()}`, symbol: sym, contract: contract.toLowerCase() };
  const r = await fetch(`${ALCOR}/tokens`, { cf: { cacheTtl: 3600 } });
  if (!r.ok) return null;
  const all = (await r.json()).filter(t => t.symbol === sym && !t.is_scam);
  if (!all.length) return null;
  all.sort((a, b) => (b.is_trusted - a.is_trusted) || ((b.score || 0) - (a.score || 0)));
  return { id: all[0].id, symbol: all[0].symbol, contract: all[0].contract, others: all.length - 1 };
}
const fmtUsd = v => (v >= 1 ? `$${v.toFixed(2)}` : `$${Number(v.toPrecision(3))}`);

// ---------------------------------------------------------------- commands --
const HELP = [
  '<b>WaxEDGE alerts</b>',
  '',
  '/watch <i>account</i> — tell me when an Alcor position leaves its range, and when it is back',
  '/price <i>SYM</i> above|below <i>usd</i> — one alert when a token crosses a price',
  '/list — what this chat is watching',
  '/unwatch <i>account</i> — stop watching one',
  '/stop — forget this chat entirely',
].join('\n');

async function onMessage(env, msg) {
  const chat = msg.chat?.id;
  const text = String(msg.text || '').trim();
  if (!chat || !text.startsWith('/')) return;
  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();
  const now = Date.now();

  if (cmd === '/start' || cmd === '/help') return say(env, chat, HELP);

  if (cmd === '/watch') {
    const acct = String(args[0] || '').toLowerCase();
    if (!ACCOUNT_RE.test(acct)) return say(env, chat, 'Usage: /watch <i>account</i> — a WAX account name, e.g. /watch eosio.null');
    const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM watches WHERE chat_id = ?').bind(chat).first()).n;
    if (n >= MAX_WATCH) return say(env, chat, `This chat already watches ${MAX_WATCH} accounts. /unwatch one first.`);
    const pos = await positions(acct);
    if (!pos) return say(env, chat, `Alcor did not answer for <b>${esc(acct)}</b>. Try again in a minute.`);
    const state = Object.fromEntries(pos.map(p => [p.id, p.inRange ? 1 : 0]));
    await env.DB.prepare('INSERT OR REPLACE INTO watches (chat_id, account, state, created) VALUES (?, ?, ?, ?)')
      .bind(chat, acct, JSON.stringify(state), now).run();
    const out = pos.filter(p => !p.inRange);
    return say(env, chat, `Watching <b>${esc(acct)}</b>: ${pos.length} Alcor position${pos.length === 1 ? '' : 's'}`
      + (out.length ? `, <b>${out.length} out of range now</b> (${out.map(p => esc(p.pair)).join(', ')}).` : ', all in range.')
      + `\nI will write when one leaves its range or comes back.`);
  }

  if (cmd === '/unwatch') {
    const acct = String(args[0] || '').toLowerCase();
    const r = await env.DB.prepare('DELETE FROM watches WHERE chat_id = ? AND account = ?').bind(chat, acct).run();
    return say(env, chat, r.meta?.changes ? `Stopped watching <b>${esc(acct)}</b>.` : `This chat was not watching <b>${esc(acct)}</b>.`);
  }

  if (cmd === '/price') {
    const [symIn, dirIn, valIn] = args;
    const dir = String(dirIn || '').toLowerCase();
    const price = Number(String(valIn || '').replace(',', '.').replace('$', ''));
    if (!symIn || !['above', 'below'].includes(dir) || !(price > 0)) {
      return say(env, chat, 'Usage: /price <i>SYM</i> above|below <i>usd</i> — e.g. /price CHEESE above 0.01');
    }
    const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM price_alerts WHERE chat_id = ?').bind(chat).first()).n;
    if (n >= MAX_PRICE) return say(env, chat, `This chat already has ${MAX_PRICE} price alerts. /stop clears them, or wait for one to fire.`);
    const t = await resolveToken(symIn);
    if (!t) return say(env, chat, `No token <b>${esc(symIn.toUpperCase())}</b> on Alcor. Use SYM@contract if it is a new one.`);
    const now$ = await tokenPrice(t.id);
    await env.DB.prepare('INSERT INTO price_alerts (chat_id, token, symbol, dir, price, created) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(chat, t.id, t.symbol, dir, price, now).run();
    return say(env, chat, `Alert set: <b>${esc(t.symbol)}</b> (${esc(t.contract)}) ${dir} ${fmtUsd(price)}`
      + (now$ ? `. Now ${fmtUsd(now$)}.` : '.') + (t.others ? `\n${t.others} other token${t.others === 1 ? '' : 's'} use this symbol; I picked the one Alcor trusts.` : ''));
  }

  if (cmd === '/list') {
    const w = (await env.DB.prepare('SELECT account FROM watches WHERE chat_id = ?').bind(chat).all()).results;
    const p = (await env.DB.prepare('SELECT symbol, dir, price FROM price_alerts WHERE chat_id = ?').bind(chat).all()).results;
    if (!w.length && !p.length) return say(env, chat, 'Nothing yet. /help shows what I can do.');
    return say(env, chat, [
      w.length ? `<b>Watching</b>: ${w.map(x => esc(x.account)).join(', ')}` : '',
      p.length ? `<b>Price alerts</b>:\n${p.map(x => `• ${esc(x.symbol)} ${x.dir} ${fmtUsd(x.price)}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n'));
  }

  if (cmd === '/stop') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM watches WHERE chat_id = ?').bind(chat),
      env.DB.prepare('DELETE FROM price_alerts WHERE chat_id = ?').bind(chat),
    ]);
    return say(env, chat, 'Done — this chat is forgotten. /start any time to come back.');
  }

  return say(env, chat, HELP);
}

// ------------------------------------------------------------------- cron --
async function cursorGet(env, k) {
  return (await env.DB.prepare('SELECT v FROM cursor WHERE k = ?').bind(k).first())?.v || 0;
}
const cursorSet = (env, k, v) => env.DB.prepare('INSERT OR REPLACE INTO cursor (k, v) VALUES (?, ?)').bind(k, v).run();

async function tick(env) {
  let sends = 0;

  // Positions: a rotating slice of the watched accounts.
  const accounts = (await env.DB.prepare('SELECT DISTINCT account FROM watches ORDER BY account').all()).results.map(r => r.account);
  if (accounts.length) {
    const start = (await cursorGet(env, 'acct')) % accounts.length;
    const slice = accounts.slice(start, start + ACCOUNTS_PER_RUN);
    for (const acct of slice) {
      const pos = await positions(acct);
      if (!pos) continue;
      const now = Object.fromEntries(pos.map(p => [p.id, p.inRange ? 1 : 0]));
      const byId = Object.fromEntries(pos.map(p => [p.id, p]));
      const subs = (await env.DB.prepare('SELECT chat_id, state FROM watches WHERE account = ?').bind(acct).all()).results;
      for (const s of subs) {
        const was = JSON.parse(s.state || '{}');
        const left = Object.keys(now).filter(id => was[id] === 1 && now[id] === 0);
        const back = Object.keys(now).filter(id => was[id] === 0 && now[id] === 1);
        const lines = [
          ...left.map(id => `⚠️ <b>${esc(byId[id].pair)}</b> #${id} is <b>out of range</b> — it earns no fees until the price comes back.`),
          ...back.map(id => `✅ <b>${esc(byId[id].pair)}</b> #${id} is back in range.`),
        ];
        if (lines.length && sends < SENDS_PER_RUN) {
          await say(env, s.chat_id, `<b>${esc(acct)}</b>\n${lines.join('\n')}\n\n<a href="${SITE}/wallet/${encodeURIComponent(acct)}">Open on WaxEDGE</a>`);
          sends++;
        }
        // Written only when something changed: new, closed or moved positions.
        if (JSON.stringify(was) !== JSON.stringify(now)) {
          await env.DB.prepare('UPDATE watches SET state = ? WHERE chat_id = ? AND account = ?').bind(JSON.stringify(now), s.chat_id, acct).run();
        }
      }
    }
    await cursorSet(env, 'acct', (start + slice.length) % accounts.length);
  }

  // Prices: a rotating slice of the tokens that have alerts on them.
  const tokens = (await env.DB.prepare('SELECT DISTINCT token FROM price_alerts ORDER BY token').all()).results.map(r => r.token);
  if (tokens.length) {
    const start = (await cursorGet(env, 'tok')) % tokens.length;
    const slice = tokens.slice(start, start + TOKENS_PER_RUN);
    for (const tok of slice) {
      const px = await tokenPrice(tok);
      if (px == null) continue;
      const hits = (await env.DB.prepare(
        "SELECT id, chat_id, symbol, dir, price FROM price_alerts WHERE token = ? AND ((dir = 'above' AND ? >= price) OR (dir = 'below' AND ? <= price))",
      ).bind(tok, px, px).all()).results;
      for (const h of hits) {
        if (sends >= SENDS_PER_RUN) break;
        await say(env, h.chat_id, `🔔 <b>${esc(h.symbol)}</b> is ${h.dir} ${fmtUsd(h.price)} — now ${fmtUsd(px)}.\n\n<a href="${SITE}/token/${encodeURIComponent(`${h.symbol}@${tok.slice(tok.indexOf('-') + 1)}`)}">Open on WaxEDGE</a>`);
        await env.DB.prepare('DELETE FROM price_alerts WHERE id = ?').bind(h.id).run();
        sends++;
      }
    }
    await cursorSet(env, 'tok', (start + slice.length) % tokens.length);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/telegram') {
      // Only Telegram knows this secret; anything else is not a message.
      if (req.headers.get('x-telegram-bot-api-secret-token') !== env.TG_SECRET) return new Response('no', { status: 401 });
      const update = await req.json().catch(() => null);
      if (update?.message) await onMessage(env, update.message).catch(() => {});
      return new Response('ok');
    }
    return new Response('WaxEDGE alerts — talk to the bot on Telegram.', { status: 200 });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};
