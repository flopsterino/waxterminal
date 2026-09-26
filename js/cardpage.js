// =============================================================================
// CARD PAGE — one share card, drawn from the lightest reads that make it.
//
// The Telegram bot is a Worker and cannot draw; it opens this page in
// Cloudflare's headless browser and screenshots #card. The full site takes
// half a minute to load in a headless browser; this reads only what one card
// needs: the bot's slice of the snapshot (prices, liquidity, volume, pools,
// farms), Alcor's candles, and for a position Alcor's own position data and
// ledger. The drawing is the site's (sharecard.js), so the cards match.
//
//   card.html?t=token&id=CHEESE@cheeseburger&p=30d
//   card.html?t=pair&pool=1252&p=30d
//   card.html?t=pos&acct=<account>&pos=<id>[&unit=usd][&show=1]
// When done, <img id="card" data-ready> holds the PNG; on failure
// <div id="msg" data-error> says why.
// =============================================================================

import { drawMarketCard, drawShareCard } from './sharecard.js';
import { alcorCandles, positionLedger, positionPnl } from './store.js';
import { tokenStats, holderCount } from './holders.js';
import { loadTokenMeta, tokenLogo } from './tokens.js';
import { earningsHistory } from './rewards.js';

const WAX = 'WAX@eosio.token';
const q = new URLSearchParams(location.search);
const PERIODS = { '7d': { bucket: 14400, days: 7, label: '7 days · 4h candles' }, '30d': { bucket: 86400, days: 30, label: '30 days · daily candles' }, '90d': { bucket: 86400, days: 90, label: '90 days · daily candles' } };
const per = PERIODS[q.get('p')] || PERIODS['30d'];
const within = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

const sig = (v, n = 3) => (v >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : v.toFixed(Math.min(12, Math.max(2, n - 1 - Math.floor(Math.log10(v))))));
const usd = v => (v == null || !isFinite(v) ? '—' : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `$${(v / 1e3).toFixed(1)}k` : v >= 1 ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : `$${sig(v)}`);
const px = v => (v == null ? '—' : `$${sig(v, 3)}`);
const qty = v => (v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v >= 1 ? v.toFixed(2) : sig(v));
const pct = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;

async function botData() {
  const d = await (await fetch('data/bot.json', { cache: 'no-cache' })).json();
  const tok = new Map(d.t.map(([id, u, ch, liq, vol]) => [id, { id, sym: id.split('@')[0], c: id.split('@')[1], usd: u, ch, liq, vol }]));
  const pools = d.p.map(([dex, id, a, b, ia, ib, fee, tvl, vol]) => ({ dex, id, a, b, ia, ib, fee, tvl, vol }));
  const farms = d.f.map(([id, dex, pd, pi, rs, apr, end, usdDay, staked]) => ({ id, dex, pd, pi, rs, apr, end, usdDay, staked }));
  return { wax: d.wax, tok, pools, farms };
}

// Candles for `baseId` in `pool`, in the pool's own units or in dollars.
async function candles(pool, baseId, { inUsd = true, period = per } = {}) {
  const since = Date.now() / 1000 - period.days * 86400;
  const raw = (await alcorCandles(pool.id, period.bucket).catch(() => [])).filter(c => c.time >= since);
  const isA = pool.ia === baseId;
  const own = raw.map(c => (isA ? { t: c.time, o: c.open, h: c.high, l: c.low, c: c.close } : { t: c.time, o: 1 / c.open, h: 1 / c.low, l: 1 / c.high, c: 1 / c.close }));
  if (!inUsd) return own;
  const quote = isA ? pool.ib : pool.ia;
  if (quote !== WAX) return own;
  const wax = (await alcorCandles('314', period.bucket).catch(() => [])).filter(c => c.time >= since - period.bucket);
  let j = 0;
  return own.map(c => {
    while (j + 1 < wax.length && wax[j + 1].time <= c.t) j++;
    const w = wax[j]; if (!w) return null;
    const O = c.o * w.open, C = c.c * w.close;
    return { t: c.t, o: O, c: C, h: Math.max(O, C, c.h * Math.max(w.open, w.close)), l: Math.min(O, C, c.l * Math.min(w.open, w.close)) };
  }).filter(Boolean);
}
const move = (cs, days) => { const since = Date.now() / 1000 - days * 86400; const f = cs.find(c => c.t >= since); return f && cs.length ? (cs[cs.length - 1].c / f.o - 1) * 100 : null; };

async function tokenCard(D) {
  const id = q.get('id');
  const t = D.tok.get(id);
  if (!t) throw new Error(`No price for ${id}`);
  const alcor = D.pools.filter(p => p.dex === 'alcor' && (p.ia === id || p.ib === id));
  const pool = id === WAX ? D.pools.find(p => p.dex === 'alcor' && p.id === '314') : (alcor.find(p => p.ia === WAX || p.ib === WAX) || alcor[0]);
  const [cs, daily, stats, holders] = await Promise.all([
    pool ? candles(pool, id) : [],
    pool && !(per.bucket === 86400 && per.days >= 30) ? candles(pool, id, { period: PERIODS['30d'] }) : null,
    within(tokenStats(t.c, t.sym).catch(() => null), 8000),
    within(holderCount(t.c, t.sym).catch(() => null), 8000),
  ]);
  const dailySeries = daily || cs;
  const cap = stats ? stats.circulating * t.usd : null;
  return drawMarketCard({
    title: t.sym, kicker: `${t.c}${pool ? ` · ${pool.a}/${pool.b} on Alcor` : ''}`,
    logos: [tokenLogo(id)].filter(Boolean),
    price: px(t.usd), priceSub: id !== WAX && D.wax ? `${qty(t.usd / D.wax)} WAX` : '',
    changes: [['24h', t.ch], ['7d', move(dailySeries, 7)], ['30d', move(dailySeries, 30)]],
    candles: cs, chartLabel: `${t.sym} in USD · ${per.label}`,
    stats: [['Market cap', cap ? usd(cap) : '—'], ['Holders', holders ? holders.toLocaleString('en-US') : '—'], ['Pooled', usd(t.liq)], ['Volume 24h', t.vol ? usd(t.vol) : '—']],
  });
}

async function pairCard(D) {
  const pid = String(q.get('pool') || '').replace(/^alcor:/, '');
  const p = D.pools.find(x => x.dex === 'alcor' && x.id === pid);
  if (!p) throw new Error(`No Alcor pool ${pid} with liquidity`);
  // Read the way people price it: the non-WAX (or non-stable) token as base.
  const baseIsA = !(p.ia === WAX || /USD/.test(p.a)) || p.ib === WAX;
  const base = baseIsA ? p.ia : p.ib, quote = baseIsA ? p.ib : p.ia;
  const bs = baseIsA ? p.a : p.b, qs = baseIsA ? p.b : p.a;
  const [cs, d30] = await Promise.all([candles(p, base, { inUsd: false }), per.days >= 30 ? null : candles(p, base, { inUsd: false, period: PERIODS['30d'] })]);
  const last = cs.length ? cs[cs.length - 1].c : null;
  const farm = D.farms.filter(f => f.pd === 'alcor' && f.pi === pid).sort((a, b) => (b.apr || 0) - (a.apr || 0))[0];
  const feeApr = p.tvl > 0 ? p.vol * (p.fee / 10000) / p.tvl * 365 * 100 : null;
  return drawMarketCard({
    title: `${bs} / ${qs}`, kicker: `Alcor #${pid} · ${(p.fee / 100).toFixed(2)}% fee`,
    logos: [tokenLogo(base), tokenLogo(quote)].filter(Boolean),
    price: last != null ? `${qty(last)} ${qs}` : '—', priceSub: D.tok.get(base)?.usd ? `${px(D.tok.get(base).usd)} per ${bs}` : '',
    changes: [['24h', move(cs, 1)], ['7d', move(d30 || cs, 7)], ['30d', move(d30 || cs, 30)]],
    candles: cs, chartLabel: `${qs} per ${bs} · ${per.label}`,
    stats: [['Liquidity', usd(p.tvl)], ['Volume 24h', p.vol > 0 ? usd(p.vol) : '—'], ['Fee APR', feeApr != null ? `${feeApr.toFixed(1)}%` : '—'], ['Farm APR', farm?.apr != null ? `${farm.apr.toFixed(1)}%` : 'no farm']],
  });
}

// A position: what it is worth, what went in and came out (Alcor's ledger,
// valued on the day of each event), so the profit in WAX and in dollars are
// each measured in their own unit. Farm payouts are not in Alcor's ledger and
// are left out here; the site's card includes them.
async function positionCard(D) {
  const acct = String(q.get('acct') || '').toLowerCase(), posId = String(q.get('pos') || '');
  const unit = q.get('unit') === 'usd' ? 'usd' : 'wax';
  const [rows, ledger, farmRows] = await Promise.all([
    fetch(`https://wax.alcor.exchange/api/v2/account/${encodeURIComponent(acct)}/positions`).then(r => r.json()),
    positionLedger(acct),
    within(earningsHistory(acct, { only: ['farm'] }).then(e => e.rows).catch(() => null), 12000),
  ]);
  const p = (rows || []).find(r => String(r.id) === posId);
  if (!p) throw new Error(`Position ${posId} is not open on ${acct}`);
  const pool = D.pools.find(x => x.dex === 'alcor' && x.id === String(p.pool));
  const tq = s => { const [n, sym] = String(s || '').split(' '); return { n: Number(n) || 0, sym: sym || '?' }; };
  const A = tq(p.amountA), B = tq(p.amountB), fA = tq(p.feesA), fB = tq(p.feesB);
  const pa = pool ? D.tok.get(pool.ia)?.usd : null, pb = pool ? D.tok.get(pool.ib)?.usd : null;
  const value = pa != null && pb != null ? A.n * pa + B.n * pb : Number(p.totalValue) || 0;
  const fees = pa != null && pb != null ? fA.n * pa + fB.n * pb : 0;
  const led = ledger.byPos.get(posId);
  // What the farms paid this position: transfers from reward.alcor naming it,
  // valued at today's prices — as on the site's card.
  const paidUsd = (farmRows || []).filter(r => String(r.posId) === posId)
    .reduce((t, r) => t + r.amount * (D.tok.get(r.tokenId)?.usd || 0), 0);
  const pnl = positionPnl(led, value + fees, D.wax, paidUsd);
  if (!pnl) throw new Error('No ledger for this position');
  const days = pnl.firstAt ? (Date.now() - pnl.firstAt) / 86400e3 : 0;
  const w = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} WAX`;
  const u = v => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  const big = unit === 'usd' ? u(pnl.usd) : w(pnl.wax);
  const basis = unit === 'usd' ? pnl.inUsd - pnl.outUsd : pnl.inWax - pnl.outWax;
  const num = unit === 'usd' ? pnl.usd : pnl.wax;
  const inUnit = v => (unit === 'usd' ? usd(v) : `${(v / D.wax).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} WAX`);
  const perDay = days >= 1 ? (unit === 'usd' ? (led.feesUsd + paidUsd) / days : (led.feesWax + paidUsd / D.wax) / days) : null;
  const perDayLabel = paidUsd > 0 ? 'Paid / day' : 'Fees / day';
  // No deposit on record (a position minted by another account or contract):
  // every WAX of it would read as profit, so the card shows what it is worth.
  if (!(basis > 0)) {
    return drawShareCard({
      title: `${A.sym} / ${B.sym}`, kicker: 'Alcor position',
      big: inUnit(value + fees), bigTone: null, bigSub: 'value now · no deposit on record, so no profit figure',
      stats: [...(perDay > 0 ? [[perDayLabel, unit === 'usd' ? usd(perDay) : `${qty(perDay)} WAX`]] : []), ['Range', p.inRange ? 'In range' : 'Out']],
      logos: pool ? [tokenLogo(pool.ia), tokenLogo(pool.ib)].filter(Boolean) : [],
      account: q.get('show') === '1' ? acct : null,
    });
  }
  return drawShareCard({
    title: `${A.sym} / ${B.sym}`,
    kicker: `Alcor position${pnl.firstAt ? ` · since ${new Date(pnl.firstAt).toISOString().slice(0, 10)}` : ''}`,
    big, bigTone: num >= 0 ? 'good' : 'bad',
    bigSub: basis > 0 ? `${pct(num / basis * 100)} on what went in` : '',
    stats: [['Value', inUnit(value + fees)], ...(perDay > 0 ? [[perDayLabel, unit === 'usd' ? usd(perDay) : `${qty(perDay)} WAX`]] : []), ['Range', p.inRange ? 'In range' : 'Out']],
    logos: pool ? [tokenLogo(pool.ia), tokenLogo(pool.ib)].filter(Boolean) : [],
    account: q.get('show') === '1' ? acct : null,
  });
}

(async () => {
  const msg = document.getElementById('msg');
  try {
    const [D] = await Promise.all([botData(), loadTokenMeta().catch(() => null)]);
    const kind = q.get('t');
    const blob = kind === 'pair' ? await pairCard(D) : kind === 'pos' ? await positionCard(D) : await tokenCard(D);
    const img = document.createElement('img');
    img.id = 'card';
    img.alt = 'WaxEDGE card';
    img.src = URL.createObjectURL(blob);
    await img.decode().catch(() => {});
    msg.replaceWith(img);
    img.setAttribute('data-ready', '1');
  } catch (e) {
    msg.textContent = `Could not draw this card: ${e.message}`;
    msg.setAttribute('data-error', '1');
  }
})();
