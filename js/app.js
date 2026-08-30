// =============================================================================
// APP — views and wiring. All data comes from store.js, which reads the chain
// directly; there is no server anywhere in this application.
// =============================================================================

import { loadCore, state, walletPositions, recentSwaps, clearCache, farmGroups, groupStakedUsd, loadHistory, SNAPSHOT_ONLY, toCandles, tokenTable, walletPositionsFast, tradeRoutes, swapsFromDeltas, tokenSeries, perDay, venueDeltas, chartDeltas, alcorCandles, TRADE_VENUES, MIN_STAKE_FOR_APR_USD } from './store.js';
import { harvestFor, planCompound } from './compound.js';
import * as wallet from './wallet.js';
import { buildHarvest, buildSwaps, buildRedeposit, readBalances, harvestedFrom, buildVoteClaim, buildStakeBack, buildAddLiquidity, buildRemoveLiquidity, buildPromotion, buildPowerup, buildUnstake, buildRefund, buildVote, buildLimitOrder, buildCancelOrder, asset } from './tx.js';
import { areaChart, columns, donut, bars, histogram, rangeBar, hideTip, bubbleMap, sparkline } from './charts.js';
import { candleChart, histogramChart, lineSeriesChart } from './tvchart.js';
import { loadTokenMeta, pairMark, tokenMark, tokenMeta } from './tokens.js';
import { topHolders, clusterHolders, transferClusters, tokenStats, lpHoldings, topLPs, tokenTax, holderCount, transferActivity } from './holders.js';
import { cap } from './limits.js';
import { accountInfo, valueBalances, accountSwaps } from './account.js';
import { stakeInfo, claimHistory, observedApr } from './stake.js';
import { resourcesOf, useFraction, cpuTransactions, bytes, micros } from './resources.js';
import { markets as obMarkets, marketFor, book, ordersOf } from './orderbook.js';
import { waxdaoStakes, claimableNow, buildWaxdaoClaims } from './waxdao.js';
import { pepperStakes, buildPepperClaim } from './pepperstake.js';
import { balanceOf } from './chain.js';
import { csvButton } from './csv.js';
import { watchStar, watchedOf, sinceSeen, markSeen, watchCount, onWatchChange } from './watch.js';
import { configurePromotion, promotionConfigured, promotionTerms, promotionMemo, activePromotions } from './promote.js';
import { sqrtPriceFromX64, depositRatio } from './math.js';

// ------------------------------------------------------------ formatting ----
const nf = (v, d = 2) => (v == null || !isFinite(v)) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
// Everything on WAX is earned, held and spent in WAX, so a page that only
// speaks dollars makes people divide in their heads all day. One switch in the
// header changes every figure at once — it is the same number either way, and
// which one is easier to think in is not ours to decide.
//
// Stored per browser, because it is a reading preference and not a setting
// anyone should have to make twice.
let UNIT = (() => { try { return localStorage.getItem('waxterminal.unit') === 'wax' ? 'wax' : 'usd'; } catch { return 'usd'; } })();
const inWax = v => (state.waxUsd > 0 ? v / state.waxUsd : null);

function usd(v) {
  if (v == null || !isFinite(v)) return '—';
  if (UNIT === 'wax') {
    const w = inWax(v);
    // No WAX price yet means no conversion; showing the dollar figure is
    // better than showing a dash where a number belongs.
    if (w == null) return usdRaw(v);
    const a = Math.abs(w);
    if (a >= 1e9) return (w / 1e9).toFixed(2) + 'B WAX';
    if (a >= 1e6) return (w / 1e6).toFixed(2) + 'M WAX';
    if (a >= 1e3) return (w / 1e3).toFixed(1) + 'k WAX';
    if (a >= 1)   return w.toFixed(2) + ' WAX';
    if (a > 0)    return w.toPrecision(2) + ' WAX';
    return '0 WAX';
  }
  return usdRaw(v);
}

function usdRaw(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k';
  if (a >= 0.995) return '$' + v.toFixed(2);
  // Sub-cent dollar amounts are noise in every place this is used — a pool
  // holding $0.0000000043 is a pool holding nothing — and toPrecision hands
  // back "4.3e-9", which is not a thing to print on a page.
  if (a >= 0.005) return '$' + v.toFixed(3);
  if (a > 0)      return (v < 0 ? '>-$0.01' : '<$0.01');
  return '$0';
}
function qty(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  if (a >= 1)   return v.toFixed(2);
  if (a > 0)    return v.toPrecision(3);
  return '0';
}
const pct = v => (v == null || !isFinite(v)) ? '—' : (v >= 1000 ? '>999%' : v.toFixed(1) + '%');
const ago = t => {
  const s = (Date.now() - new Date(t + (String(t).endsWith('Z') ? '' : 'Z')).getTime()) / 1000;
  if (s < 60) return Math.max(0, Math.round(s)) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};
// How long something has existed. New pools are where both the best yields and
// the worst rugs are, so it earns a column rather than a footnote.
function age(ts) {
  if (!ts) return '—';
  const d = (Date.now() - ts) / 86400000;
  if (d < 1) return Math.max(1, Math.round(d * 24)) + 'h';
  if (d < 60) return Math.round(d) + 'd';
  if (d < 730) return Math.round(d / 30) + 'mo';
  return (d / 365).toFixed(1) + 'y';
}
// Seeing that CHEESE/LSWAX is the best farm on WAX is only half of it; the other
// half is being able to go and do something about it.
const venueUrl = {
  alcor: p => `https://wax.alcor.exchange/analytics/pools/${p.id}`,
  taco: () => 'https://swap.tacocrypto.io/pools',
  defibox: () => 'https://wax.defibox.io',
  adex: () => 'https://alcor.exchange',
};
const swapUrl = p => p.dex === 'alcor'
  ? `https://wax.alcor.exchange/swap?input=${p.symA.toLowerCase()}-${p.tokenA.split('@')[1]}&output=${p.symB.toLowerCase()}-${p.tokenB.split('@')[1]}`
  : venueUrl[p.dex]?.(p) || '#';
const farmUrl = p => p.dex === 'alcor' ? 'https://wax.alcor.exchange/positions' : 'https://swap.tacocrypto.io/farms';

const venueName = { alcor: 'Alcor', taco: 'TacoSwap', defibox: 'Defibox', adex: 'A-DEX' };

// waxblock is the explorer everyone on WAX already reads, so a transaction or a
// block links straight out to it. An *account* does not: clicking a wallet
// should show what they hold here, where their balances are already priced and
// their positions already valued.
// A price is a ratio, and which way round it reads is a preference, not a
// fact. WAXUSDC per WAX and WAX per WAXUSDC are the same chart seen from either
// end — so it is the same chart, with a switch, rather than two.
//
// Inverting swaps high and low as well as taking the reciprocal: the highest
// price of X in Y is the lowest price of Y in X, and forgetting that draws
// candles inside out.
// One source per venue. Alcor publishes candles going back to the day the pool
// opened; the others publish nothing, so their charts are still rebuilt from
// pool rows — which is where the ten-thousand-row ceiling lives and why a busy
// pool used to stop two days back whatever window was asked for.
async function candlesFor(pool, bucketSec, onProgress) {
  if (pool.dex === 'alcor') {
    onProgress?.('all of it');
    const c = await alcorCandles(pool.id, bucketSec).catch(() => null);
    if (c?.length) return { candles: c, source: 'alcor', span: (Date.now() / 1000 - c[0].time) / 86400 };
  }
  const days = 21;
  onProgress?.(`${days} days`);
  const rows = await chartDeltas(pool, bucketSec);
  if (!rows.length) return { candles: [], source: 'deltas', span: 0, rows };
  return { candles: toCandles(rows, { bucketSec }), source: 'deltas', span: (Date.now() - rows[0].ts) / 86400000, rows };
}

function invertCandles(candles) {
  return candles
    .filter(c => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)
    .map(c => ({ time: c.time, open: 1 / c.open, high: 1 / c.low, low: 1 / c.high, close: 1 / c.close, volume: c.volume }));
}

// Decimals follow the magnitude: two on a price near a dollar is a flat line,
// six on a price near four thousand is noise.
const precisionFor = v => Math.max(2, Math.min(8, Math.ceil(-Math.log10(Math.abs(v) || 1)) + 4));

// Every time series offers the same steps, from one control, so they cannot
// drift apart: the WAX chart on the front page had no selector at all and was
// frozen at fifteen minutes, the token's volume chart offered windows (24h/3d/
// 7d) where its neighbour offered candle sizes, and the two price charts each
// wired their own copy.
const CHART_INTERVALS = [
  { s: 300, label: '5m' }, { s: 900, label: '15m' }, { s: 3600, label: '1h' },
  { s: 14400, label: '4h' }, { s: 86400, label: '24h' },
];

function intervalChips(scope, active = 3600, { skip = [] } = {}) {
  return CHART_INTERVALS.filter(i => !skip.includes(i.s))
    .map(i => `<button class="chip" data-ivfor="${esc(scope)}" data-iv="${i.s}" aria-pressed="${i.s === active}">${i.label}</button>`)
    .join('');
}

function wireIntervals(scope, onPick) {
  const sel = `[data-ivfor="${scope}"]`;
  document.querySelectorAll(sel).forEach(b => b.onclick = () => {
    document.querySelectorAll(sel).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    onPick(Number(b.dataset.iv));
  });
}

const trxUrl = id => `https://waxblock.io/transaction/${id}`;
const blockUrl = n => `https://waxblock.io/block/${n}`;
// Rendered as a span rather than an anchor: the row it sits in is often itself
// clickable, and a nested <a> steals that click on touch.
const acctLink = name => `<span class="acct-link" data-acct="${esc(name)}" title="See what ${esc(name)} holds">${esc(name)}</span>`;

// One delegated handler for every account name on the page, however it got
// there — tables are rewritten constantly and rebinding each time is how a
// click quietly stops working.
document.addEventListener('click', e => {
  const el = e.target.closest?.('[data-acct]');
  if (!el) return;
  e.stopPropagation();
  openAccount(el.dataset.acct);
});
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pairName = p => `${esc(p.symA)}/${esc(p.symB)}`;
const $ = s => document.querySelector(s);

let CFG = null;

// theme.json promised three things it did not deliver: a tagline, footer links
// and per-surface feature flags. A config key that nothing reads is worse than
// no key — the partner rebranding this sets it, sees nothing change, and stops
// trusting the rest of the file.
function applyTheme(cfg) {
  const tag = $('#ovTagline');
  if (tag && cfg.identity?.tagline) tag.textContent = cfg.identity.tagline;

  const links = $('#brandLinks');
  if (links && Array.isArray(cfg.links) && cfg.links.length) {
    links.innerHTML = cfg.links
      .filter(l => l?.href && l?.label && /^https?:\/\//.test(l.href))
      .map(l => `<a href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.label)}</a>`)
      .join(' &middot; ');
  }

  // A hidden surface has to be unreachable, not merely untabbed: the hash
  // router would happily open a view whose tab was removed.
  const off = Object.entries(cfg.features || {}).filter(([, on]) => on === false).map(([k]) => k);
  for (const view of off) {
    document.querySelector(`#tabs button[data-view="${view}"]`)?.remove();
    document.getElementById(`view-${view}`)?.remove();
  }
  hiddenViews = new Set(off);
}
let hiddenViews = new Set();

// ----------------------------------------------------------------- boot -----
async function boot() {
  try {
    CFG = await (await fetch('theme.json')).json();
    configurePromotion(CFG.commercial);
    $('#brandName').textContent = CFG.identity?.name ?? 'WAX Terminal';
    if (CFG.identity?.favicon) $('#brandMark').textContent = CFG.identity.favicon;
    document.title = CFG.identity?.name ?? 'WAX Terminal';
    applyTheme(CFG);
  } catch { CFG = { content: {}, features: {} }; }

  const saved = localStorage.getItem('waxterm-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('#themeBtn').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('waxterm-theme', next); } catch {}
  };

  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-view]'); if (!b) return;
    show(b.dataset.view);
    if (b.dataset.view === 'wallet') autoWallet();
  });
  const paintUnit = () => {
    const b = $('#unitToggle');
    if (b) { b.textContent = UNIT === 'wax' ? 'WAX' : 'USD'; b.setAttribute('aria-pressed', String(UNIT === 'wax')); }
  };
  paintUnit();
  $('#unitToggle').onclick = () => {
    UNIT = UNIT === 'wax' ? 'usd' : 'wax';
    try { localStorage.setItem('waxterminal.unit', UNIT); } catch {}
    paintUnit();
    // Every figure on the page came from usd(), so the whole view is redrawn
    // rather than patched — a half-converted table is worse than either unit.
    redrawCurrent();
  };
  $('#refreshBtn').onclick = async () => { await clearCache(); location.reload(); };
  $('#poolBack').onclick = () => show(lastView || 'pools');
  $('#tokBack').onclick = () => show(lastView || 'tokens');
  $('#acctBack').onclick = () => show(lastView || 'overview');

  // Wire everything BEFORE loading. Handlers do not need data, and hanging the
  // first render off a progress callback meant one early return anywhere in
  // that path left the page on a spinner with no error — which is exactly what
  // happened, and only on the path that reads the chain.
  wirePools(); wireFarms(); wireTokens(); wireWallet(); wireActivity(); wireCompound(); wireConnect();

  const paint = () => {
    try { renderPools(); renderFarms(); renderTokens(); renderOverview(); }
    catch (e) { banner(`<div class="err"><b>Could not draw the page.</b> <code class="mono">${esc(e.message)}</code></div>`); }
  };

  // Token marks and Alcor's scores. Started now so they are usually ready by
  // the time there is anything to draw; if they are late the page paints without
  // them and repaints when they land. This call went missing in an earlier
  // rewrite of this function, which is why every row showed a generated mark
  // even though 1,035 real logos were sitting in data/logos.
  let marksReady = false;
  const marks = loadTokenMeta().then(() => { marksReady = true; }).catch(() => {});

  banner('<div class="loading"><span class="spinner"></span><span id="loadmsg">Loading…</span></div>');

  let loadError = null;
  try {
    await loadCore({ onProgress: p => {
      const m = $('#loadmsg');
      if (m && p.msg) m.textContent = p.msg;
    } });
  } catch (e) { loadError = e; }

  // Whatever came back — snapshot, cache, or a full read — draw it.
  if (state.pools.length) {
    // Give the marks a moment so the first paint carries them, but never wait on
    // them: a slow logo host must not hold up the whole terminal.
    await Promise.race([marks, new Promise(r => setTimeout(r, 2000))]);
    paint();
    if (!marksReady) marks.then(() => paint());
    if (state.waxUsd) $('#waxPrice').innerHTML = `WAX <b>$${state.waxUsd.toFixed(5)}</b>`;
    const alive = state.hosts.filter(h => h.ok).length;
    // A node roster and a raw pool count are things the author cares about.
    // What a reader wants from a footer is how old the numbers are.
    // Volume refreshes hourly, everything else daily, so say which is which
    // rather than stamping one time over both.
    $('#freshness').textContent = state.volumeAt
      ? `Volume ${ago(new Date(state.volumeAt).toISOString())} · rest ${ago(new Date(state.loadedAt).toISOString())}`
      : (state.loadedAt ? `Updated ${ago(new Date(state.loadedAt).toISOString())}` : '');
    if (loadError) {
      banner(`<div class="freshbar">Showing the daily snapshot from ${ago(new Date(state.loadedAt).toISOString())}.
        Live chain read failed &mdash; wallet lookups and the trade feed need it. <button class="btn ghost" id="goLive">Try again</button></div>`);
    } else if (state.fromSnapshot) {
      banner(`<div class="freshbar">Daily snapshot from ${ago(new Date(state.loadedAt).toISOString())}. Pools and wallets you open are read live.
        <button class="btn ghost" id="goLive">Refresh from chain</button></div>`);
    } else banner('');
    const b = $('#goLive');
    if (b) b.onclick = async () => {
      b.disabled = true; b.textContent = 'Reading chain…';
      try {
        await loadCore({ force: true, onProgress: p => { if (p.msg) b.textContent = p.msg; } });
        groups = []; tokRows = null; paint(); banner('');
      } catch { b.disabled = false; b.textContent = 'Still unreachable — try again'; }
    };
  } else {
    banner(`<div class="err"><b>Could not load any data.</b> ${esc(loadError?.message || 'unknown')}<br>
      The public WAX nodes may be rate-limiting. Reloading usually fixes it.</div>`);
    return;
  }

  if (!routeFromHash()) show(CFG.content?.defaultView || 'overview');
  window.addEventListener('hashchange', routeFromHash);

  // The full chain sweep is ~15 seconds and re-reads 19,820 pools to change
  // numbers by a fraction of a percent. Doing that on every visit made the
  // terminal feel broken. The committed snapshot is the default source; a live
  // read is a deliberate act, and anything you actually open (a pool, a wallet,
  // a compound) reads live state for that one thing anyway.
  if (state.fromSnapshot) {
    banner(`<div class="freshbar">Showing the daily snapshot from ${ago(new Date(state.loadedAt).toISOString())}.
      Pools and wallets you open are read live. <button class="btn ghost" id="goLive">Refresh everything from chain</button></div>`);
    const b = $('#goLive');
    if (b) b.onclick = async () => {
      b.disabled = true; b.textContent = 'Reading chain…';
      try {
        await loadCore({ force: true, onProgress: p => { if (p.msg) b.textContent = p.msg; } });
        groups = []; renderPools(); renderFarms(); renderOverview();
        banner('');
      } catch (e) { b.disabled = false; b.textContent = 'Refresh failed — try again'; }
    };
  }
}

const banner = html => { $('#banner').innerHTML = html; };
let lastView = 'pools';
// The chip states what the tier is doing, including when it could not be
// checked — a node that will not answer must not quietly demote a holder.
// One line for every capped table. Whether a row is missing because the tier
// limits the view or because the data ends there is exactly the thing a visitor
// cannot tell by looking, so it is always said out loud — and the free cap
// always names what lifts it rather than pretending the list simply stops.
function capNote(total, shown, noun, { filterable = true } = {}) {
  if (!(total > shown)) return `${total.toLocaleString()} ${noun}`;
  // Only tables that actually have a search box may advise using one.
  const lift = filterable ? ' <span class="dim">&mdash; narrow it with search or filters</span>' : '';
  return `showing top ${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}${lift}`;
}


// Entitlement changes how many rows a table draws, so whichever table is on
// screen has to be redrawn instead of waiting for the next navigation.
function redrawCurrent() {
  try {
    // Whatever is actually on screen, including the detail pages — the unit
    // switch has to reach every number, and a token page left in dollars while
    // the header says WAX is the worst of both.
    const [view, arg] = location.hash.replace(/^#/, '').split('/');
    if (view === 'token' && arg) return void openToken(decodeURIComponent(arg));
    if (view === 'pool' && arg) return void openPool(decodeURIComponent(arg));
    if (view === 'account' && arg) return void openAccount(decodeURIComponent(arg));
    if (lastView === 'pools') renderPools();
    else if (lastView === 'tokens') renderTokens();
    else if (lastView === 'farms') renderFarms();
    else if (lastView === 'overview') renderOverview();
    else if (lastView === 'activity' && activityLoaded) renderActivity();
  } catch {}
}

function show(v, arg = null) {
  // A view the partner turned off is not a view.
  if (hiddenViews.has(v)) v = CFG?.content?.defaultView && !hiddenViews.has(CFG.content.defaultView) ? CFG.content.defaultView : 'overview';
  if (v !== 'pool' && v !== 'token' && v !== 'account') lastView = v;
  hideTip();
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  const hash = arg ? `#${v}/${arg}` : `#${v}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  window.scrollTo(0, 0);
}

// A view worth looking at is worth linking to: #farms, #pool/alcor:314,
// #wallet/someaccount all deep-link straight into the terminal.
function routeFromHash() {
  const [view, arg] = location.hash.replace(/^#/, '').split('/');
  if (!view) return false;
  if (view === 'pool' && arg) { openPool(decodeURIComponent(arg)); return true; }
  if (view === 'token' && arg) { openToken(decodeURIComponent(arg)); return true; }
  if (view === 'account' && arg) { openAccount(decodeURIComponent(arg)); return true; }
  if (view === 'wallet' && !arg && wallet.account()) { show('wallet'); autoWallet(); return true; }
  if (view === 'wallet' && arg) {
    const acct = decodeURIComponent(arg);
    show('wallet'); $('#walletInput').value = acct; lookupWallet(acct); return true;
  }
  if (view === 'compound' && arg) { const a = decodeURIComponent(arg); show('compound'); $('#compInput').value = a; runCompound(a); return true; }
  if (['overview', 'pools', 'tokens', 'farms', 'wallet', 'activity', 'compound'].includes(view)) {
    show(view);
    if (view === 'activity' && !activityLoaded) renderActivity();
    return true;
  }
  return false;
}

// ------------------------------------------------------------- OVERVIEW -----
// The page that answers "what is going on" before anyone touches a filter.
// Charts, not tables: a 19,000-row table is a database dump, not an overview.
let showRisky = false;
function renderOverview() {
  const pools = state.pools.filter(p => p.tvl > 0);
  const groups = farmGroups();
  const nominal = pools.reduce((s, p) => s + p.tvl, 0);
  const realisable = pools.reduce((s, p) => s + (p.tvlReal || 0), 0);
  const selfBackedVal = pools.filter(p => state.depth.get(p.tokenA)?.selfBacked || state.depth.get(p.tokenB)?.selfBacked)
    .reduce((s, p) => s + (p.tvl || 0), 0);
  const rewardsReal = groups.reduce((s, g) => s + (g.rewardRealDay || 0), 0);
  const rewardsNom = groups.reduce((s, g) => s + g.rewardUsdDay, 0);
  // Same measure as the farms page: what a real deposit would earn, in pools you
  // could actually enter. Ranking on the headline rate here would contradict the
  // page it links to.
  const SIZE = 0;
  for (const g of groups) {
    const tvl = g.pool?.tvlReal;
    g.share = tvl > 0 ? SIZE / (tvl + SIZE) : 1;
    // With no deposit there is nothing to dilute and no pool too small to take
    // it, so the constraint only applies once an amount is entered.
    g.tooSmall = farmFilters.size > 0 && g.share > 0.33;
    // Emissions outrunning the pool: the rate is real and the token cannot
    // survive it. Worth seeing, not worth ranking first.
    g.runaway = g.pool?.tvlReal > 0 && g.rewardRealDay > g.pool.tvlReal * 0.5;
    g.aprAt = aprAtSize(g, SIZE);
  }
  const bestApr = groups.filter(g => g.aprAt != null && !g.tooSmall && !g.runaway).sort((a, b) => b.aprAt - a.aprAt);
  const withApr = groups.filter(g => g.aprAt != null && !g.tooSmall && g.aprAt < 500);

  $('#ovStats').innerHTML = `
    <div class="stat"><span class="v">${usd(realisable)}</span><span class="k">pooled value</span><span class="sub">${usd(nominal)} at face value &middot; ${(selfBackedVal / nominal * 100).toFixed(0)}% of that in tokens that mostly back each other</span></div>
    <div class="stat"><span class="v">${usd(state.pools.reduce((s, p) => s + (p.vol24 || 0), 0))}</span><span class="k">traded in 24h</span><span class="sub">across every venue</span></div>
    <div class="stat"><span class="v">${groups.length.toLocaleString()}</span><span class="k">farmed pools</span><span class="sub">${state.farms.filter(f => !f.ended).length.toLocaleString()} incentives</span></div>
    <div class="stat"><span class="v">${usd(rewardsReal)}</span><span class="k">real rewards daily</span><span class="sub">${usd(rewardsNom)} counted at face value</span></div>
    <div class="stat"><span class="v">$${state.waxUsd ? state.waxUsd.toFixed(5) : '—'}</span><span class="k">WAX</span><span class="sub">routed to a bridged dollar</span></div>`;

  const box = $('#ovCharts');
  box.innerHTML = `
    <div class="section" id="ovPromoSec" hidden><h3>Promoted <span class="dim">— paid placement, not a ranking</span></h3>
      <div class="card"><div id="ovPromo"></div></div>
    </div>
    <div class="section" id="ovWatchSec" hidden><h3>Your watchlist <span class="dim">— what moved since you last looked</span></h3>
      <div class="card"><div id="ovWatch"></div></div>
    </div>
    <div class="section"><h3>Farms</h3>
      <div class="card"><h3>Best rates <span class="dim">— what they pay today</span>
        <span class="hero">${bestApr.length} of ${groups.length} farms</span></h3>
        <div id="ovBest"></div></div>
      <div class="grid g2">
        <div class="card"><h3>Biggest daily payouts
          <span style="margin-left:auto"><button class="chip" id="riskyToggle" aria-pressed="${showRisky}" title="Farms emitting more in a day than their pool is worth — a real rate, on a token that cannot survive paying it">risky</button></span></h3><div id="ovRew"></div></div>
        <div class="card"><h3>Where the rates sit <span class="dim">— ${withApr.length} farms</span></h3><div id="ovApr"></div></div>
      </div>
    </div>
    <div class="section"><h3>Where the liquidity is</h3>
      <div class="grid g2">
        <div class="card"><h3>Deepest pools <span class="hero" id="ovTopHero"></span></h3><div id="ovTop"></div></div>
        <div class="card"><h3>Split by venue</h3><div id="ovDex"></div></div>
      </div>
    </div>
    <div class="section"><h3>Tokens</h3>
      <div class="grid g2">
        <div class="card"><h3>Most traded <span class="dim">— 24h volume</span></h3><div id="ovTokVol"></div></div>
        <div class="card"><h3>Most pooled <span class="dim">— value behind the token</span></h3><div id="ovTokTvl"></div></div>
      </div>
    </div>
    <div class="section"><h3>Market</h3>
      <div class="grid g2">
        <div class="card"><h3>WAX price <span class="dim">— from Alcor pool #314 state changes</span>
          <span style="margin-left:auto;display:flex;gap:4px">${intervalChips('ovWax')}</span></h3>
          <div id="ovWax"><div class="loading"><span class="spinner"></span><span>Reading history…</span></div></div>
          <p class="sub chartspan" id="ovWaxNote" style="margin:8px 0 0">&nbsp;</p></div>
        <div class="card"><h3>Alcor fee tiers <span class="dim">— by real pooled value</span></h3><div id="ovFee"></div></div>
      </div>
    </div>
    <div class="section"><h3>Tracked over time</h3>
      <div class="card"><h3>Total value locked <span class="dim">— one point per daily snapshot</span></h3><div id="ovHist"></div></div>
    </div>`;

  // Best APRs first: it is the question people open a farm page to answer.
  const bestBox = $('#ovBest');
  if (!bestApr.length) bestBox.innerHTML = '<div class="chart-empty">No farm currently has both real rewards and real staked capital.</div>';
  else {
    bestBox.appendChild(bars(bestApr.slice(0, 10).map(g => ({
      label: g.pool ? `${g.pool.symA}/${g.pool.symB}` : g.poolId,
      sub: `${usd(g.pool?.tvlReal || 0)} pool`,
      value: g.aprAt,
      note: `you'd own ${(g.share * 100).toFixed(0)}% · pool ${usd(g.pool?.tvlReal || 0)} · pays ${[...new Set(g.rewards.map(r => r.symbol))].slice(0, 3).join(', ')}`,
      go: () => openPool(g.key),
    })), { fmt: v => v.toFixed(0) + '%', color: 'var(--c3)' }));
  }

  const top = [...pools].sort((a, b) => (b.tvlReal || 0) - (a.tvlReal || 0)).slice(0, 8);
  renderWatchlist(groups);
  renderPromoted();

  $('#ovTopHero').textContent = usd(top.reduce((s, p) => s + (p.tvlReal || 0), 0)) + ' in the top 8';
  $('#ovTop').appendChild(bars(top.map(p => {
    const c = state.depth.get(p.tokenA)?.topPartner, d2 = state.depth.get(p.tokenB)?.topPartner;
    return { label: `${p.symA}/${p.symB}`, value: p.tvlReal || 0,
      note: `${(p.feeBps / 100).toFixed(2)}% fee · ${p.vol24 > 0 ? usd(p.vol24) + ' traded' : 'no volume'}`,
      go: () => openPool(`${p.dex}:${p.id}`) };
  }), { fmt: usd }));

  const toks = tokenTable().filter(t => t.depth1 >= 5);
  const byVol = [...toks].filter(t => t.vol24 > 0).sort((a, b) => b.vol24 - a.vol24).slice(0, 8);
  const byTvl = [...toks].sort((a, b) => b.tvl - a.tvl).slice(0, 8);
  $('#ovTokVol').appendChild(byVol.length
    ? bars(byVol.map(t => ({ label: t.symbol, value: t.vol24, note: `${t.pools} pools · ${usd(t.depth1)} tradeable`, go: () => openToken(t.id) })), { fmt: usd, color: 'var(--c2)' })
    : Object.assign(document.createElement('div'), { className: 'chart-empty', textContent: 'Volume arrives with the next daily snapshot.' }));
  $('#ovTokTvl').appendChild(bars(byTvl.map(t => ({ label: t.symbol, value: t.tvl, note: `${t.pools} pools · ${usd(t.depth1)} tradeable at 1%`, go: () => openToken(t.id) })), { fmt: usd, color: 'var(--c1)' }));

  const byDex = new Map();
  for (const p of pools) { const n = venueName[p.dex] || p.dex; byDex.set(n, (byDex.get(n) || 0) + (p.tvlReal || 0)); }
  $('#ovDex').appendChild(donut([...byDex].map(([label, value]) => ({ label, value })), { fmt: usd, top: 2 }));

  // A farm emitting more in a day than its pool is worth is not a payout, it is
  // a token about to be printed into the ground. BUZZ/SHIL pays $25.28 a day
  // into a pool holding $0.53 — 48 times its own value, every day — and topping
  // this chart with it told readers the opposite of the truth.
  const sane = g => g.pool?.tvlReal > 0 && g.rewardRealDay < g.pool.tvlReal * 0.5;
  // Farms emitting more in a day than their pool is worth were hidden outright.
  // They are worth seeing — they are often the highest number on the page — so
  // they are a toggle rather than a decision made for the reader.
  const payers = groups.filter(g => g.rewardRealDay > 0 && (showRisky || sane(g)))
    .sort((a, b) => b.rewardRealDay - a.rewardRealDay).slice(0, 8);
  const runaway = groups.filter(g => g.rewardRealDay > 0 && !sane(g)).length;
  $('#ovRew').appendChild(payers.length
    ? bars(payers.map(g => ({
        label: g.pool ? `${g.pool.symA}/${g.pool.symB}` : g.poolId,
        value: g.rewardRealDay,
        note: `${usd(g.rewardUsdDay)} at face value · ${g.tokenCount} token${g.tokenCount === 1 ? '' : 's'}`,
        go: () => openPool(g.key),
      })), { fmt: usd, color: 'var(--c2)' })
    : Object.assign(document.createElement('div'), { className: 'chart-empty', textContent: 'No farm pays a reward with real liquidity behind it.' }));
  if (runaway) {
    const n = document.createElement('p');
    n.className = 'sub'; n.style.marginTop = '10px';
    n.textContent = showRisky
      ? `Including ${runaway} farm${runaway === 1 ? '' : 's'} that emit more in a day than their pool is worth. The rate is real; the token cannot survive paying it.`
      : `${runaway} farm${runaway === 1 ? '' : 's'} hidden: each emits more in a day than its pool is worth. Turn on "risky" to see them.`;
    $('#ovRew').appendChild(n);
  }
  const rt = $('#riskyToggle');
  if (rt) rt.onclick = () => { showRisky = !showRisky; renderOverview(); };

  $('#ovApr').appendChild(withApr.length
    ? histogram(withApr.map(g => g.aprAt), { fmtX: v => v.toFixed(0) + '%', color: 'var(--c3)', label: 'APR distribution' })
    : Object.assign(document.createElement('div'), { className: 'chart-empty', textContent: 'No real APRs yet — hit "Compute APR" on the farms page to value the Alcor ones.' }));

  // Alcor only. Its fee is a real field on the pool row (0.05 / 0.30 / 1.00%);
  // the other venues charge one flat rate that this terminal takes from their
  // documentation, and charting an assumption next to a fact invents a "0.10%
  // tier" that does not exist.
  const byFee = new Map();
  for (const p of pools) {
    if (p.dex !== 'alcor') continue;
    const k = `${(p.feeBps / 100).toFixed(2)}%`;
    byFee.set(k, (byFee.get(k) || 0) + (p.tvlReal || 0));
  }
  $('#ovFee').appendChild(donut([...byFee].map(([label, value]) => ({ label, value })), { fmt: usd, top: 4 }));

  if (SNAPSHOT_ONLY) {
    $('#ovWax').innerHTML = '<div class="chart-empty">Snapshot mode — chain history not fetched.</div>';
  } else {
    // Was frozen at fifteen minutes over two pages of history — about a day —
    // so the front page's only price chart could not be zoomed out at all.
    const waxPool = state.pools.find(p => p.dex === 'alcor' && String(p.id) === '314');
    let waxIv = 3600, waxBusy = false;
    const drawWax = async () => {
      const el = $('#ovWax');
      if (!el || !waxPool || waxBusy) return;
      waxBusy = true;
      try {
        const got = await candlesFor(waxPool, waxIv,
          d => { el.innerHTML = `<div class="loading"><span class="spinner"></span><span>Reading ${d} of WAX…</span></div>`; });
        if (!got.candles.length) { el.innerHTML = '<div class="chart-empty">No price history for this pool.</div>'; return; }
        await candleChart(el, got.candles, { height: 260, precision: precisionFor(got.candles.at(-1)?.close) })
          .catch(() => { el.innerHTML = '<div class="chart-empty">Chart library unavailable.</div>'; });
        const note = $('#ovWaxNote');
        if (note) note.textContent = `${got.candles.length.toLocaleString()} candles, back to ${new Date(got.candles[0].time * 1000).toISOString().slice(0, 10)}`
          + (got.source === 'alcor' ? ' — the whole life of the pool.' : '.');
      } catch { const e2 = $('#ovWax'); if (e2) e2.innerHTML = '<div class="chart-empty">History unavailable right now.</div>'; }
      finally { waxBusy = false; }
    };
    drawWax();
    wireIntervals('ovWax', v => { waxIv = v; drawWax(); });
  }

  loadHistory().then(rows => {
    const el = $('#ovHist');
    // A handful of points inside one day is not a time series; drawing it makes
    // a flat line look like a chart and implies history that is not there yet.
    const days = new Set(rows.map(r => new Date(r.at).toISOString().slice(0, 10))).size;
    if (days < 3) {
      el.innerHTML = `<div class="chart-empty">Tracking started ${rows.length ? ago(new Date(rows[0].at).toISOString()) : 'today'} &mdash; ${days} day${days === 1 ? '' : 's'} recorded.<br>
        A daily job appends one point per day. This chart appears once there are three, because two points drawn across a year of axis is a picture of nothing.</div>`;
      return;
    }
    // One point per day: collapse multiple runs in a day to that day's last.
    const perDay = new Map();
    for (const r of rows) perDay.set(new Date(r.at).toISOString().slice(0, 10), r);
    rows = [...perDay.values()];
    // TradingView where it loads, hand-drawn SVG where it does not. The library
    // comes from a CDN, and a blocked CDN should cost you zoom and a crosshair,
    // not the chart.
    lineSeriesChart(el, rows.map(r => ({ time: Math.floor(r.at / 1000), value: r.tvlReal ?? r.tvl })),
      { height: 240, color: 'var(--c1)', fmt: usd })
      .catch(() => {
        el.innerHTML = '';
        el.appendChild(areaChart(rows.map(r => ({ x: r.at, y: r.tvlReal ?? r.tvl })), {
          fmtY: usd, fmtX: t => new Date(t).toISOString().slice(0, 10), color: 'var(--c1)', label: 'TVL over time',
        }));
      });
  }).catch(() => {});
}

// Marks are DOM, not markup: rows render as strings, then the marks are grafted
// on. Doing it this way keeps the table build a single innerHTML write.
// Stars are DOM with state and a listener, so like the token marks they are
// grafted on after the row strings are written rather than serialised into them.
function fillStars(root) {
  root.querySelectorAll('[data-star]').forEach(el => {
    if (el.dataset.done) return;
    const [kind, id, label] = el.dataset.star.split('|');
    el.appendChild(watchStar(kind, id, label));
    el.dataset.done = '1';
  });
}

function fillMarks(root) {
  root.querySelectorAll('[data-pm]').forEach(el => {
    if (el.dataset.done) return;
    const [ta, sa, tb, sb] = el.dataset.pm.split('|');
    el.appendChild(tb ? pairMark(ta, sa, tb, sb) : tokenMark(ta, sa));
    el.dataset.done = '1';
  });
}

// Alcor publishes its own score per token and zeroes `safe_usd_price` for ones
// it will not stand behind. Shown next to our depth verdict: two independent
// methods agreeing is worth more than either alone, and where they disagree the
// reader should see that rather than be handed a silent winner.
function trustChip(tokenId) {
  const m = tokenMeta(tokenId);
  if (!m) return '';
  if (m.scam) return `<span class="trust bad" title="Alcor has flagged this token as a scam">flagged</span>`;
  // "no safe price" was Alcor's internal field name leaking onto the page. What
  // it means to a reader is that the exchange will not stand behind a price.
  if (m.safeUsd === 0) return `<span class="trust bad" title="Alcor will not quote a price for this token — treat any figure here as indicative only">unpriced by Alcor</span>`;
  if (m.trusted && m.score >= 80) return `<span class="trust ok" title="Alcor rates this ${m.score} out of 100">${m.score}</span>`;
  if (m.score != null) return `<span class="trust" title="Alcor rates this ${m.score} out of 100">${m.score}</span>`;
  return '';
}

// --------------------------------------------------------------- FILTERS ----
// Numeric range filters over the loaded set. No database is involved and none is
// needed: filtering 19,820 objects in memory takes about a millisecond, which is
// faster than any round trip to a server could ever be.
const num = v => { const n = parseFloat(String(v).replace(/[, ]/g, '')); return Number.isFinite(n) ? n : null; };

function rangeField(key, label, store, { unit = '', step = 'any' } = {}) {
  return `<label>${label}${unit ? ` <span style="text-transform:none;letter-spacing:0;font-weight:400">(${unit})</span>` : ''}
    <span class="pairin">
      <input type="number" step="${step}" placeholder="min" data-f="${key}.min" value="${store[key]?.min ?? ''}">
      <span>to</span>
      <input type="number" step="${step}" placeholder="max" data-f="${key}.max" value="${store[key]?.max ?? ''}">
    </span></label>`;
}
const inRange = (v, r) => {
  if (!r) return true;
  if (r.min != null && !(v >= r.min)) return false;
  if (r.max != null && !(v <= r.max)) return false;
  return true;
};

function wireFilterPanel(panel, store, onChange) {
  panel.querySelectorAll('input[data-f], select[data-f]').forEach(inp => {
    inp.oninput = () => {
      const [key, side] = inp.dataset.f.split('.');
      if (side) { store[key] = store[key] || {}; store[key][side] = inp.value === '' ? null : num(inp.value); }
      else store[key] = inp.value;
      onChange();
    };
  });
}

// ---------------------------------------------------------------- POOLS -----
// Sorted by what trades, not by what sits. Ranking on pooled value put
// NBG/WAXCASH fifth on $7,428 of liquidity and $0 of trading, while WAX/LFGK —
// $463 pooled turning over $366 in a day — did not appear at all. Depth is
// still a column, and still sortable; it is just not the question most people
// open this page with.
const poolFilters = { q: '', dex: 'all', hideDust: true, hideThin: false, sort: 'vol24', dir: -1,
  tvl: {}, fee: {}, depth: {}, farmed: 'any' };

// What each table last put on screen. An export has to be exactly what the
// reader is looking at — same filters, same sort, same order — or the
// spreadsheet and the page quietly disagree about what was there.
// Paid slots, read back off the chain. See js/promote.js for why this is a
// ledger of transfers rather than a list in the config.
//
// Labelled as paid on every row, and kept out of every ranking, filter and
// total on the page. A terminal people use to decide where to put money cannot
// sell an unmarked position in its own numbers and still be worth reading.
// Promoting this, as a button. The memo is an implementation detail of a
// payment the page can make — asking someone to assemble one by hand and send
// tokens to an account they typed themselves is how tokens go somewhere
// irreversible.
function promoteBox(kind, id, name) {
  if (!promotionConfigured()) return '';
  const t = promotionTerms();
  return `<div class="section"><h3>Promote ${esc(name)}</h3>
    <div class="card">
      <div class="toolbar" style="margin:0">
        <span class="sub">For</span>
        ${[7, 30, 90].map((d, i) => `<button class="chip" data-promo-days="${d}"${i === 0 ? ' aria-pressed="true"' : ''}>${d} days</button>`).join('')}
        <span style="flex:1"></span>
        <button class="btn" id="promoBuy" data-kind="${esc(kind)}" data-id="${esc(id)}">Promote &mdash; <span id="promoCost">${qty(7 * t.perDay)} ${esc(t.token)}</span></button>
      </div>
      <div id="promoOut" style="margin-top:10px"></div>
      <p class="sub" style="margin:10px 0 0">${qty(t.perDay)} ${esc(t.token)} a day, on the front page. Slots are ordered by total spend, so paying more puts you higher, and paying again extends rather than replaces.
      Nobody is turned away for being late &mdash; a slot below the top few is still a slot.
      A promoted row is labelled as paid and changes no ranking, filter or total anywhere here: you are buying a place on the page, not a place in the numbers.</p>
    </div></div>`;
}

// Wired after the page is written, like every other control here.
function wirePromote() {
  const buy = $('#promoBuy');
  if (!buy || !promotionConfigured()) return;
  const t = promotionTerms();
  let days = 7;
  document.querySelectorAll('[data-promo-days]').forEach(b => b.onclick = () => {
    document.querySelectorAll('[data-promo-days]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    days = Number(b.dataset.promoDays);
    const c = $('#promoCost'); if (c) c.textContent = `${qty(days * t.perDay)} ${t.token}`;
  });
  buy.onclick = async () => {
    const out = $('#promoOut');
    if (!wallet.account()) { try { await wallet.connect(); } catch { return; } }
    const built = buildPromotion({ kind: buy.dataset.kind, id: buy.dataset.id, days, terms: t, me: wallet.account() });
    out.innerHTML = `<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">
      Send <b>${qty(built.amount)} ${esc(t.token)}</b> to <span class="mono">${esc(t.account)}</span> for <b>${days} days</b> of promotion.
      ${t.account === 'eosio.null' ? '<br><span class="dim">Burned on arrival, so it costs supply rather than paying anyone.</span>' : ''}
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="promoSign">Sign and promote</button></div></div>`;
    $('#promoSign').onclick = async () => {
      out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
      try {
        const r = await wallet.transact(built.actions);
        out.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)"><b>Promoted.</b> Live on the front page for ${days} days.
          <br><a class="mono" style="font-size:11px" href="${trxUrl(r.id)}" target="_blank" rel="noopener">${r.id.slice(0, 16)}… &nearr;</a></div>`;
      } catch (e) { out.innerHTML = txError(e); }
    };
  };
}

async function renderPromoted() {
  const sec = $('#ovPromoSec'), box = $('#ovPromo');
  if (!sec || !box || !promotionConfigured()) return;
  const t = promotionTerms();
  let live = [];
  try { live = await activePromotions(); } catch { return; }
  if (!live.length) { sec.hidden = true; return; }

  const byPool = new Map(state.pools.map(p => [`${p.dex}:${p.id}`, p]));
  const byToken = new Map(tokenTable().map(x => [x.id, x]));
  const byFarm = new Map(farmGroups().map(g => [g.key, g]));
  const rows = live.slice(0, promotionTerms().slots).map(pr => {
    const subject = pr.kind === 'p' ? byPool.get(pr.id) : pr.kind === 'f' ? byFarm.get(pr.id) : byToken.get(pr.id);
    if (!subject) return null;
    const name = pr.kind === 'f' ? (subject.pool ? `${subject.pool.symA}/${subject.pool.symB} farm` : `farm ${subject.poolId}`)
      : pr.kind === 'p' ? `${subject.symA}/${subject.symB}` : subject.symbol;
    const sub = pr.kind === 'f' ? `${[...new Set(subject.rewards.map(r => r.symbol))].slice(0, 3).join(', ')} · ${usd(subject.rewardRealDay)}/day`
      : pr.kind === 'p' ? `${venueName[subject.dex] || subject.dex} · ${(subject.feeBps / 100).toFixed(2)}% · ${usd(subject.tvlReal)} pooled`
      : `${subject.contract} · ${usd(subject.tvl)} pooled · ${subject.pools} pools`;
    return { pr, name, sub };
  }).filter(Boolean);
  if (!rows.length) { sec.hidden = true; return; }
  sec.hidden = false;

  const days = ms => Math.max(0, Math.round(ms / 86400000));
  box.innerHTML = `<div class="tablewrap" style="max-height:none;border:0"><table style="font-size:12.5px">
    <tbody>${rows.map(r => `<tr class="clickable" data-promo="${esc(r.pr.kind)}|${esc(r.pr.id)}">
      <td><span class="badge warn">paid</span> <b>${esc(r.name)}</b> <span class="sub">${esc(r.sub)}</span></td>
      <td class="r num dim">${qty(r.pr.paid)} ${esc(t.token)}${r.pr.payments > 1 ? ` <span class="sub">in ${r.pr.payments} payments</span>` : ''}</td>
      <td class="r num dim">#${r.pr.rank}</td>
      <td class="r num dim">${days(r.pr.until - Date.now())}d left</td>
    </tr>`).join('')}</tbody></table></div>
    <p class="sub" style="margin:10px 0 0">These slots were bought, and that is the only reason they are here &mdash; ordered by what was spent, and nothing else on this page ranks, filters or totals differently because of it.
    Each was paid for on chain: ${rows.map(r => acctLink(r.pr.from)).join(', ')} sent ${esc(t.token)} to <span class="mono">${esc(t.account)}</span>, and the payment buys a day per ${qty(t.perDay)} ${esc(t.token)} from the moment it lands.
    ${t.account === 'eosio.null' ? `It is burned on arrival, so a promotion costs supply rather than paying anyone.` : ''}
    Every pool, token and farm page has a Promote button; ${qty(t.perDay)} ${esc(t.token)} buys a day.${live.length > rows.length ? ` ${live.length - rows.length} more ${live.length - rows.length === 1 ? 'is' : 'are'} paid up and waiting below the top ${rows.length} — nobody is turned away, they are just outbid for now.` : ''}</p>`;

  box.querySelectorAll('tr[data-promo]').forEach(tr => {
    const [kind, id] = tr.dataset.promo.split('|');
    tr.onclick = () => (kind === 't' ? openToken(id) : openPool(id));
  });
}

// The watchlist, drawn against what these things were worth when you last
// looked at them. See js/watch.js for why this is a memory rather than an
// alert: a static site has nothing awake to send you one.
function renderWatchlist(groups) {
  const sec = $('#ovWatchSec'), box = $('#ovWatch');
  if (!sec || !box) return;
  const toks = tokenTable();
  const byToken = new Map(toks.map(t => [t.id, t]));
  const byPool = new Map(state.pools.map(p => [`${p.dex}:${p.id}`, p]));
  const byFarm = new Map((groups || farmGroups()).map(g => [g.key, g]));

  const items = [];
  for (const id of watchedOf('t')) {
    const t = byToken.get(id);
    if (t) items.push({ kind: 't', id, name: t.symbol, sub: t.contract,
      metrics: { price: t.price, pooled: t.tvl, vol24: t.vol24 },
      go: () => openToken(id) });
  }
  for (const id of watchedOf('p')) {
    const p = byPool.get(id);
    if (p) items.push({ kind: 'p', id, name: `${p.symA}/${p.symB}`, sub: `${venueName[p.dex] || p.dex} · ${(p.feeBps / 100).toFixed(2)}%`,
      metrics: { pooled: p.tvlReal, vol24: p.vol24, price: p.priceAB },
      go: () => openPool(id) });
  }
  for (const id of watchedOf('f')) {
    const g = byFarm.get(id);
    if (g) items.push({ kind: 'f', id, name: g.pool ? `${g.pool.symA}/${g.pool.symB} farm` : `farm ${g.poolId}`, sub: [...new Set(g.rewards.map(r => r.symbol))].slice(0, 3).join(', '),
      metrics: { apr: g.aprReal, paysDay: g.rewardRealDay, staked: g.stakedReal },
      go: () => openPool(id) });
  }

  if (!items.length) { sec.hidden = true; return; }
  sec.hidden = false;

  const LABEL = { price: 'price', pooled: 'pooled', vol24: '24h volume', apr: 'APR', paysDay: 'pays daily', staked: 'staked' };
  const fmtOf = f => (f === 'apr' ? (v => pct(v)) : f === 'price' ? (v => (v >= 0.01 ? '$' + v.toFixed(4) : '$' + v.toPrecision(3))) : usd);

  box.innerHTML = `<div class="tablewrap" style="max-height:none;border:0"><table style="font-size:12.5px">
    <tbody>${items.map(it => {
      const d = sinceSeen(it.kind, it.id, it.metrics);
      const moves = (d?.changed || []).filter(c => c.pct != null && Math.abs(c.pct) >= 0.5);
      return `<tr class="clickable" data-watch="${esc(it.kind)}|${esc(it.id)}">
        <td><b>${esc(it.name)}</b> <span class="sub">${esc(it.sub || '')}</span></td>
        <td>${Object.entries(it.metrics).filter(([, v]) => v != null && isFinite(v))
              .map(([f, v]) => `<span class="badge">${esc(LABEL[f] || f)} ${fmtOf(f)(v)}</span>`).join(' ')}</td>
        <td class="r">${!d ? '<span class="dim">first time you are seeing this here</span>'
          : moves.length ? moves.map(c => `<span class="${c.pct > 0 ? 'pos' : 'neg'}">${c.pct > 0 ? '+' : ''}${c.pct.toFixed(1)}% ${esc(LABEL[c.field] || c.field)}</span>`).join(' &middot; ')
          : `<span class="dim">unchanged since ${ago(new Date(d.at).toISOString())}</span>`}</td>
      </tr>`;
    }).join('')}</tbody></table></div>
    <p class="sub" style="margin:10px 0 0">${watchCount()} followed. Held in this browser only &mdash; no account, nothing uploaded, and a static site has nothing awake to send you an alert.
    The comparison is against what each of these was worth the last time this page showed it to you.</p>`;

  box.querySelectorAll('tr[data-watch]').forEach(tr => {
    const [kind, id] = tr.dataset.watch.split('|');
    const it = items.find(x => x.kind === kind && x.id === id);
    tr.onclick = () => it?.go();
  });
  // Recorded after the comparison is on screen, never before it.
  for (const it of items) markSeen(it.kind, it.id, it.metrics);
}

const lastRendered = { pools: [], tokens: [], farms: [] };

// Exported raw, never formatted. "$1.2k" is a thing to read; 1234.56 is a thing
// to sum, and re-parsing a display string is how a column of money turns into a
// column of text halfway down.
const CSV_COLS = {
  pools: [
    { h: 'venue', v: p => p.dex }, { h: 'pool_id', v: p => p.id },
    { h: 'pair', v: p => `${p.symA}/${p.symB}` },
    { h: 'token_a', v: p => p.tokenA }, { h: 'token_b', v: p => p.tokenB },
    { h: 'fee_pct', v: p => p.feeBps / 100 },
    { h: 'value_realisable_usd', v: p => p.tvlReal }, { h: 'value_face_usd', v: p => p.tvl },
    { h: 'volume_24h_usd', v: p => p.vol24 }, { h: 'volume_7d_usd', v: p => p.vol7d },
    { h: 'change_24h_pct', v: p => p.change24 },
    { h: 'trade_depth_1pct_usd', v: p => p.depth1 },
    { h: 'price_b_per_a', v: p => p.priceAB },
    { h: 'price_a_usd', v: p => p.priceUsdA }, { h: 'price_b_usd', v: p => p.priceUsdB },
    { h: 'reserve_a', v: p => p.reserveA }, { h: 'reserve_b', v: p => p.reserveB },
    { h: 'first_seen', v: p => (p.bornAt ? new Date(p.bornAt).toISOString() : null) },
  ],
  tokens: [
    { h: 'token', v: t => t.id }, { h: 'symbol', v: t => t.symbol }, { h: 'contract', v: t => t.contract },
    { h: 'price_usd', v: t => t.price },
    { h: 'pooled_realisable_usd', v: t => t.tvl }, { h: 'pooled_face_usd', v: t => t.tvlNominal },
    { h: 'volume_24h_usd', v: t => t.vol24 },
    { h: 'trade_depth_1pct_usd', v: t => t.depth1 },
    { h: 'exit_value_usd', v: t => t.exit }, { h: 'exit_ratio', v: t => t.ratio },
    { h: 'transfer_tax_pct', v: t => t.taxBps / 100 },
    { h: 'burned_on_transfer_pct', v: t => t.burnBps / 100 },
    { h: 'tax_paid_to_dex_pct', v: t => t.venueTaxBps / 100 },
    { h: 'pools', v: t => t.pools }, { h: 'venues', v: t => [...t.venues].join(' ') },
    { h: 'first_seen', v: t => (t.bornAt ? new Date(t.bornAt).toISOString() : null) },
  ],
  farms: [
    { h: 'venue', v: g => g.dex }, { h: 'pool_id', v: g => g.poolId },
    { h: 'pair', v: g => (g.pool ? `${g.pool.symA}/${g.pool.symB}` : '') },
    { h: 'fee_pct', v: g => (g.pool ? g.pool.feeBps / 100 : null) },
    { h: 'pays', v: g => [...new Set(g.rewards.map(r => r.symbol))].join(' ') },
    { h: 'incentives', v: g => g.farms.length },
    { h: 'reward_per_day_usd', v: g => g.rewardUsdDay },
    { h: 'reward_per_day_sellable_usd', v: g => g.rewardRealDay },
    { h: 'staked_usd', v: g => g.stakedUsd }, { h: 'staked_sellable_usd', v: g => g.stakedReal },
    { h: 'apr_pct', v: g => g.apr }, { h: 'apr_sellable_pct', v: g => g.aprReal },
    { h: 'apr_at_your_size_pct', v: g => g.aprAt },
    { h: 'your_share_of_pool', v: g => g.share },
    { h: 'runway_days', v: g => (isFinite(g.runwayDays) ? g.runwayDays : null) },
    { h: 'apr_status', v: g => g.aprStatus },
  ],
};

// The export carries the same rows the table is showing, cap included. A free
// tier that shows 400 pools but hands over 19,820 in a file would make the cap
// a fiction; saying which of the two numbers you are getting keeps it honest.
function wireCsv(toolbarSel, beforeSel, name, key) {
  const bar = $(toolbarSel);
  if (!bar || bar.querySelector('.csv')) return;
  const b = csvButton('Export CSV', name, () => lastRendered[key].slice(0, cap(key)), CSV_COLS[key]);
  b.title = `Downloads exactly what this table is showing — the same filters, the same sort, up to the ${cap(key).toLocaleString()} rows the view holds.`;
  bar.insertBefore(b, $(beforeSel));
}

function wirePools() {
  wireCsv('#view-pools .toolbar', '#poolCount', 'wax-pools', 'pools');
  $('#poolSearch').oninput = e => { poolFilters.q = e.target.value.trim().toLowerCase(); renderPools(); };
  const setDex = d => { poolFilters.dex = d; ['All', 'Alcor', 'Taco'].forEach(n => $(`#fDex${n}`).setAttribute('aria-pressed', String(d === n.toLowerCase() || (d === 'all' && n === 'All')))); renderPools(); };
  $('#fDexAll').onclick = () => setDex('all');
  $('#fDexAlcor').onclick = () => setDex('alcor');
  $('#fDexTaco').onclick = () => setDex('taco');
  $('#fLiq').onclick = e => { poolFilters.hideDust = !poolFilters.hideDust; e.target.setAttribute('aria-pressed', String(poolFilters.hideDust)); renderPools(); };
  $('#fThin').onclick = e => { poolFilters.hideThin = !poolFilters.hideThin; e.target.setAttribute('aria-pressed', String(poolFilters.hideThin)); renderPools(); };
  const panel = $('#poolFilters');
  panel.innerHTML = rangeField('tvl', 'Pooled value', poolFilters, { unit: 'USD' })
    + rangeField('fee', 'Fee tier', poolFilters, { unit: '%', step: '0.01' })
    + rangeField('depth', 'Route depth', poolFilters, { unit: 'USD' })
    + `<label>Has a farm<select data-f="farmed">
        <option value="any">Any</option><option value="yes">Farmed only</option><option value="no">Unfarmed only</option>
      </select></label>`;
  wireFilterPanel(panel, poolFilters, renderPools);
  $('#fMorePool').onclick = e => { panel.hidden = !panel.hidden; e.target.setAttribute('aria-pressed', String(!panel.hidden)); };
}

let _farmed = null;
const farmedPools = () => (_farmed ??= new Set(state.farms.filter(f => !f.ended).map(f => `${f.poolDex}:${f.poolId}`)));

function filteredPools() {
  const min = CFG?.content?.minTvlUsd ?? 100;
  return state.pools.filter(p => {
    if (poolFilters.dex !== 'all' && p.dex !== poolFilters.dex) return false;
    // Dust is a pool nobody uses, not merely a small one. Now that the table
    // leads on volume, a pool that traded a hundred dollars today has earned
    // its row whatever its size — hiding it would have meant ranking on a
    // number the filter was throwing away.
    if (poolFilters.hideDust && !((p.tvl ?? 0) >= min || (p.vol24 ?? 0) >= min)) return false;
    if (poolFilters.hideThin && p.thin) return false;
    if (!inRange(p.tvlReal ?? -1, poolFilters.tvl)) return false;
    if (!inRange(p.feeBps / 100, poolFilters.fee)) return false;
    if (!inRange(isFinite(p.routeDepth) ? p.routeDepth : Infinity, poolFilters.depth)) return false;
    if (poolFilters.farmed !== 'any') {
      const has = farmedPools().has(`${p.dex}:${p.id}`);
      if (poolFilters.farmed === 'yes' && !has) return false;
      if (poolFilters.farmed === 'no' && has) return false;
    }
    if (poolFilters.q) {
      const s = `${p.symA}/${p.symB} ${p.id}`.toLowerCase();
      if (!s.includes(poolFilters.q)) return false;
    }
    return true;
  });
}

const POOL_COLS = [
  { k: 'rank', label: '', sortable: false },
  { k: 'pair', label: 'Pool', sortable: false },
  { k: 'tvlReal', label: 'Pooled value', r: true, sortable: true },
  { k: 'vol24', label: 'Volume 24h', r: true, sortable: true },
  { k: 'vol7d', label: '7d', r: true, sortable: true },
  { k: 'turnover', label: 'Turnover', r: true, sortable: true },
  { k: 'price', label: 'Price', r: true, sortable: false },
  { k: 'change24', label: '24h', r: true, sortable: true },
  { k: 'feeBps', label: 'Fee', r: true, sortable: true },
  { k: 'bornAt', label: 'Age', r: true, sortable: true },
];

function renderPools() {
  const rows = filteredPools();
  lastRendered.pools = rows;
  rows.sort((a, b) => {
    const k = poolFilters.sort;
    const x = a[k], y = b[k];
    const xn = x == null || !isFinite(x), yn = y == null || !isFinite(y);
    if (xn && yn) return 0;
    if (xn) return 1;
    if (yn) return -1;
    return (x - y) * poolFilters.dir;
  });

  // Two numbers, and they are nine times apart on WAX, so the page has to say
  // which one it is showing. Face value counts every token at its quoted price;
  // realisable value counts only what a route to a bridged dollar could carry
  // out. The realisable one leads everywhere, because it is the one that
  // survives contact with a sell order.
  const total = rows.reduce((s, p) => s + (p.tvl || 0), 0);
  const totalReal = rows.reduce((s, p) => s + (p.tvlReal || 0), 0);
  const concentrated = rows.filter(p => state.depth.get(p.tokenA)?.selfBacked || state.depth.get(p.tokenB)?.selfBacked);
  const concVal = concentrated.reduce((s, p) => s + (p.tvl || 0), 0);
  // state.pools holds what the snapshot kept (anything above $100 or farmed).
  // Printing that under "Alcor pools" claimed 723 where the chain has 11,585.
  // Counted per venue, not "Alcor and the rest". The rest was three venues
  // summed against a total that only covered TacoSwap, which printed 9,704 of
  // 8,252 — a subset larger than the set it came from.
  const perVenue = new Map();
  for (const p of state.pools) perVenue.set(p.dex, (perVenue.get(p.dex) || 0) + 1);
  const shownA = perVenue.get('alcor') || 0;
  const others = [...perVenue].filter(([d]) => d !== 'alcor').sort((a, b) => b[1] - a[1]);
  const shownT = others.reduce((a, [, n]) => a + n, 0);
  const alcorTotal = state.counts?.alcor ?? shownA;
  const priced = [...state.prices.values()].length;
  $('#poolStats').innerHTML = `
    <div class="stat"><span class="v">${usd(totalReal)}</span><span class="k">pooled value</span><span class="sub">${usd(total)} at face value &middot; ${usd(concVal)} of that in pools whose tokens mostly back each other</span></div>
    <div class="stat"><span class="v">${shownA.toLocaleString()}</span><span class="k">Alcor pools</span><span class="sub">${alcorTotal > shownA ? `of ${alcorTotal.toLocaleString()} in existence` : 'every one on the chain'}</span></div>
    <div class="stat"><span class="v">${shownT.toLocaleString()}</span><span class="k">on the other venues</span><span class="sub">${others.map(([d, n]) => `${n.toLocaleString()} ${venueName[d] || d}`).join(' &middot; ')}</span></div>
    <div class="stat"><span class="v">${priced.toLocaleString()}</span><span class="k">priced tokens</span><span class="sub">of ${state.tokens.size.toLocaleString()} seen</span></div>
    <div class="stat"><span class="v">$${state.waxUsd ? state.waxUsd.toFixed(5) : '—'}</span><span class="k">WAX</span><span class="sub">deepest stable route</span></div>`;

  // The body renders as far as the tier allows. Reporting rows.length made a
  // search for something ranked 900th look like it does not exist.
  const CAP = cap('pools');
  // "showing top 400 of 574" invites the reader to think 574 is all there is,
  // when the dust filter is holding back twenty thousand more. Say both.
  const hidden = state.pools.length - rows.length;
  $('#poolCount').innerHTML = capNote(rows.length, CAP, 'pools')
    + (hidden > 0 ? ` <span class="dim">&middot; ${hidden.toLocaleString()} more filtered out</span>` : '');

  const thead = $('#poolTable thead');
  thead.innerHTML = '<tr>' + POOL_COLS.map(c =>
    `<th class="${c.r ? 'r ' : ''}${c.sortable ? 'sortable' : ''}" data-k="${c.k}">${c.label}${poolFilters.sort === c.k ? ` <span class="dir">${poolFilters.dir < 0 ? '▾' : '▴'}</span>` : ''}</th>`).join('') + '</tr>';
  thead.querySelectorAll('th.sortable').forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    if (poolFilters.sort === k) poolFilters.dir *= -1; else { poolFilters.sort = k; poolFilters.dir = -1; }
    renderPools();
  });

  const body = rows.slice(0, cap('pools')).map((p, i) => {
    const ch = p.change24;
    return `
    <tr class="clickable" data-pool="${p.dex}:${esc(p.id)}">
      <td class="rank">${i + 1}<span data-star="p|${esc(p.dex)}:${esc(String(p.id))}|${esc(p.symA)}/${esc(p.symB)}"></span></td>
      <td><span data-pm="${esc(p.tokenA)}|${esc(p.symA)}|${esc(p.tokenB)}|${esc(p.symB)}"></span><span class="pairbig">${pairName(p)}</span>
        <span class="venue ${p.dex}">${p.dex === 'alcor' ? 'Alcor' : p.dex === 'taco' ? 'Taco' : p.dex === 'defibox' ? 'Defibox' : 'A-DEX'}</span>
        <span class="sub">${(p.feeBps / 100).toFixed(2)}%</span></td>
      <td class="r num" title="What this pool could actually pay out, priced through routes that reach a bridged dollar. ${usd(p.tvl)} at face value.">${usd(p.tvlReal)}<span class="nominal">${usd(p.tvl)} face</span></td>
      <td class="r num">${p.vol24 > 0 ? usd(p.vol24) : '<span class="dim">—</span>'}</td>
      <td class="r num dim">${p.vol7d > 0 ? usd(p.vol7d) : '—'}</td>
      <td class="r num" title="24h volume against pooled value — how hard the liquidity is working">${p.turnover > 0 ? p.turnover.toFixed(2) + '×' : '<span class="dim">—</span>'}</td>
      <td class="r num">${p.priceAB != null ? qty(p.priceAB) : '—'} <span class="sub">${esc(p.symB)}</span></td>
      <td class="r num ${ch > 0 ? 'pos' : ch < 0 ? 'neg' : 'dim'}">${ch == null ? '—' : (ch > 0 ? '+' : '') + ch.toFixed(1) + '%'}</td>
      <td class="r num dim">${(p.feeBps / 100).toFixed(2)}%</td>
      <td class="r num dim">${age(p.bornAt)}</td>
    </tr>`;
  }).join('');
  $('#poolTable tbody').innerHTML = body || '<tr><td colspan="9" class="empty">No pools match.</td></tr>';
  fillMarks($('#poolTable tbody'));
  fillStars($('#poolTable tbody'));
  $('#poolTable tbody').querySelectorAll('tr[data-pool]').forEach(tr => tr.onclick = () => openPool(tr.dataset.pool));
}

// --------------------------------------------------------------- TOKENS -----
// Same argument as the pools table: what trades, not what sits.
const tokFilters = { q: '', solidOnly: true, sort: 'vol24', dir: -1 };
let tokRows = null;

function wireTokens() {
  wireCsv('#view-tokens .toolbar', '#tokCount', 'wax-tokens', 'tokens');
  $('#tokSearch').oninput = e => { tokFilters.q = e.target.value.trim().toLowerCase(); renderTokens(); };
  $('#fTokSolid').onclick = e => {
    tokFilters.solidOnly = !tokFilters.solidOnly;
    e.target.setAttribute('aria-pressed', String(tokFilters.solidOnly));
    renderTokens();
  };
}

function renderTokens() {
  if (!tokRows || tokRows._at !== state.loadedAt) { tokRows = tokenTable(); tokRows._at = state.loadedAt; }
  let rows = tokRows.filter(t => {
    // Tradeable means someone can buy or sell it: it has a price this terminal
    // will stand behind, and pooled value behind that price.
    //
    // It used to mean $5 of depth before a 1% move, which is a much tighter
    // question than anyone was asking. RUGG has $128 pooled across 201 pools
    // and traded $29 today, and was hidden because moving its price 1% only
    // takes $1.03. The old rule showed 88 tokens where 225 have a real market.
    if (tokFilters.solidOnly && !(t.price != null && t.tvl >= 10)) return false;
    if (tokFilters.q && !`${t.symbol} ${t.contract}`.toLowerCase().includes(tokFilters.q)) return false;
    return true;
  });
  rows.sort((a, b) => {
    const x = a[tokFilters.sort], y = b[tokFilters.sort];
    const xn = x == null || !isFinite(x), yn = y == null || !isFinite(y);
    if (xn && yn) return 0;
    if (xn) return 1;
    if (yn) return -1;
    return (x - y) * tokFilters.dir;
  });

  lastRendered.tokens = rows;
  // A pool has two sides, and each side credits the pool's volume to its token.
  // That is right per token — WAX's 24h includes every pool WAX is in — and
  // wrong the moment you add the column up, because every trade is then counted
  // once for each end of it. Measured at exactly 2.00x. The same goes for the
  // pool count: a pool holding two shown tokens is still one pool.
  //
  // Pooled value is not affected: each side is credited half, so the column
  // already sums to the whole once.
  const shown = new Set(rows.map(t => t.id));
  let vol = 0, poolsBehind = 0;
  for (const p of state.pools) {
    if (!shown.has(p.tokenA) && !shown.has(p.tokenB)) continue;
    poolsBehind++;
    vol += p.vol24 || 0;
  }
  const tvl = rows.reduce((s, t) => s + t.tvl, 0);
  $('#tokStats').innerHTML = `
    <div class="stat"><span class="v">${rows.length.toLocaleString()}</span><span class="k">tokens shown</span><span class="sub">of ${tokRows.length.toLocaleString()} seen in pools</span></div>
    <div class="stat"><span class="v">${usd(tvl)}</span><span class="k">pooled behind them</span></div>
    <div class="stat"><span class="v">${usd(vol)}</span><span class="k">traded in 24h</span><span class="sub">each trade counted once, across all four venues</span></div>
    <div class="stat"><span class="v">${poolsBehind.toLocaleString()}</span><span class="k">pools holding them</span></div>`;

  const cols = [
    { k: 'rank', label: '' },
    { k: 'symbol', label: 'Token' },
    { k: 'price', label: 'Price', r: true, s: true },
    { k: 'tvl', label: 'Pooled value', r: true, s: true },
    { k: 'vol24', label: 'Volume 24h', r: true, s: true },
    { k: 'depth1', label: 'Trade depth', r: true, s: true },
    { k: 'taxBps', label: 'Transfer tax', r: true, s: true },
    { k: 'backing', label: 'Backed by', s: false },
    { k: 'pools', label: 'Pools', r: true, s: true },
    { k: 'bornAt', label: 'First seen', r: true, s: true },
  ];
  const thead = $('#tokTable thead');
  thead.innerHTML = '<tr>' + cols.map(c => `<th class="${c.r ? 'r ' : ''}${c.s ? 'sortable' : ''}" data-k="${c.k}">${c.label}${tokFilters.sort === c.k ? ` <span class="dir">${tokFilters.dir < 0 ? '▾' : '▴'}</span>` : ''}</th>`).join('') + '</tr>';
  thead.querySelectorAll('th.sortable').forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    if (tokFilters.sort === k) tokFilters.dir *= -1; else { tokFilters.sort = k; tokFilters.dir = -1; }
    renderTokens();
  });

  const tokHidden = tokRows.length - rows.length;
  $('#tokCount').innerHTML = capNote(rows.length, cap('tokens'), 'tokens')
    + (tokHidden > 0 ? ` <span class="dim">&middot; ${tokHidden.toLocaleString()} more filtered out</span>` : '');
  $('#tokTable tbody').innerHTML = rows.slice(0, cap('tokens')).map((t, i) => `
    <tr class="clickable" data-tok="${esc(t.symbol)}" data-tokid="${esc(t.id)}">
      <td class="rank">${i + 1}<span data-star="t|${esc(t.id)}|${esc(t.symbol)}"></span></td>
      <td><span data-pm="${esc(t.id)}|${esc(t.symbol)}"></span><span class="pairbig">${esc(t.symbol)}</span>
        <span class="sub">${esc(t.contract)}</span>${trustChip(t.id)}</td>
      <td class="r num">${t.price == null ? '<span class="dim">—</span>' : '$' + (t.price >= 0.01 ? t.price.toFixed(4) : t.price.toPrecision(3))}</td>
      <td class="r num">${usd(t.tvl)}</td>
      <td class="r num">${t.vol24 > 0 ? usd(t.vol24) : '<span class="dim">—</span>'}</td>
      <td class="r num" title="Summed across the ${t.pools} pools holding it: what you could trade in one go, splitting the order, before moving the price 1%">${t.depth1 > 0 ? usd(t.depth1) : '<span class="dim">—</span>'}</td>
      <td class="r num ${t.taxBps > 0 ? 'neg' : 'dim'}" title="${t.taxBps > 0
        ? `Every transfer of ${esc(t.symbol)} costs ${(t.taxBps / 100).toFixed(2)}%${t.burnBps > 0 ? `, of which ${(t.burnBps / 100).toFixed(2)}% is burned` : ''}. A route through it pays this at each hop.`
        : 'No transfer tax found in this contract\'s tables.'}">${t.taxBps > 0 ? (t.taxBps / 100).toFixed(2) + '%' : '—'}</td>
      <td class="dim" style="font-size:11.5px">${(() => {
        const d = state.depth.get(t.id);
        if (!d?.topPartner) return '—';
        const sym = d.topPartner.token.split('@')[0];
        const pctv = (d.topPartner.share * 100).toFixed(0);
        const heavy = d.topPartner.share > 0.5;
        return `<span class="${heavy ? 'warnish' : ''}" title="${pctv}% of the value standing opposite ${esc(t.symbol)} is ${esc(sym)}${d.selfBacked ? ', and most of what backs it comes from the same issuer' : ''}">${esc(sym)} ${pctv}%</span>`;
      })()}</td>
      <td class="r num dim">${t.pools}</td>
      <td class="r num dim">${age(t.bornAt)}</td>
    </tr>`).join('') || '<tr><td colspan="9" class="empty">No tokens match.</td></tr>';
  fillMarks($('#tokTable tbody'));
  fillStars($('#tokTable tbody'));
  $('#tokTable tbody').querySelectorAll('tr[data-tok]').forEach(tr => tr.onclick = () => openToken(tr.dataset.tokid));
}

// ---------------------------------------------------------------- FARMS -----
// Rows are POOLS, not incentives: 633 of 1,883 farmed pools run several
// incentives at once and a user experiences that as one farm paying several
// tokens. Listing raw incentives would show the same pool ten times.
const farmFilters = { q: '', alcor: true, taco: true, realOnly: false, expired: false, sort: 'aprAt', dir: -1, size: 0,
  apr: {}, rewards: {}, staked: {}, tokens: {}, reward: '' };
let groups = [];

// What a farm pays YOU, not what it pays the person already in it. Your deposit
// joins the pot, so your share is size/(staked+size) and your return is
// rewards*365/(staked+size). A 296% APR on $35 of staked capital becomes 18.8%
// the moment you put $500 in; a 239% on $850 stays at 151%. Ranking on the
// headline number sorts by how empty a farm is, which is why the top of the
// list was full of pools nobody would touch.
function aprAtSize(g, size) {
  if (!(g.rewardRealDay > 0)) return null;
  const staked = g.stakedReal;
  if (staked == null) return null;
  // An APR needs a real denominator. $0.001 a day against two cents staked is
  // 1,774% and is arithmetic, not a return — and with no deposit entered there
  // was nothing else to disqualify it, so the front page's "best rates" was a
  // list of farms holding pennies. The floor is the same one the rest of the
  // app uses; once you enter an amount, your own money is what lifts a farm
  // over it, which is exactly right.
  if (staked + size < MIN_STAKE_FOR_APR_USD) return null;
  return (g.rewardRealDay * 365 / (staked + size)) * 100;
}

// The other half of the same problem. Diluting against staked capital alone
// still ranked a farm with $1 staked at the top, because arithmetically your
// $500 would collect nearly all the rewards. But you cannot put $500 into a pool
// that holds $1: you would be 99.8% of it, and every cent of price impact on the
// way in and out would be your own. The pool is the constraint, not the farm.
function poolShare(g, size) {
  const tvl = g.pool?.tvlReal;
  if (!(tvl > 0)) return 1;
  return size / (tvl + size);
}

function wireFarms() {
  wireCsv('#view-farms .toolbar', '#farmCount', 'wax-farms', 'farms');
  $('#farmSearch').oninput = e => { farmFilters.q = e.target.value.trim().toLowerCase(); renderFarms(); };
  const tog = (key, id) => $(id).onclick = e => { farmFilters[key] = !farmFilters[key]; e.target.setAttribute('aria-pressed', String(farmFilters[key])); renderFarms(); };
  tog('alcor', '#fFarmAlcor'); tog('taco', '#fFarmTaco'); tog('realOnly', '#fReal');
  $('#fExpired').onclick = e => {
    farmFilters.expired = !farmFilters.expired;
    e.target.setAttribute('aria-pressed', String(farmFilters.expired));
    groups._key = null; renderFarms();
  };
  const sizeInput = $('#depositSize');
  const applySize = v => {
    const n = Math.max(0, Number(v) || 0);
    farmFilters.size = n;
    document.querySelectorAll('[data-size]').forEach(x => x.setAttribute('aria-pressed', String(Number(x.dataset.size) === n)));
    renderFarms();
  };
  let sizeTimer;
  sizeInput.oninput = () => { clearTimeout(sizeTimer); sizeTimer = setTimeout(() => applySize(sizeInput.value), 250); };
  document.querySelectorAll('[data-size]').forEach(b => b.onclick = () => { sizeInput.value = b.dataset.size; applySize(b.dataset.size); });
  $('#fLive').style.display = 'none';                 // groups are live-only by construction
  // No compute button: the daily job values every Alcor farm, so an APR is
  // either there or honestly absent. Asking a reader to press a button to find
  // out what a farm pays is asking them to do the terminal's work.
  const calc = $('#calcApr'); if (calc) calc.remove();
  const panel = $('#farmFilterPanel');
  panel.innerHTML = rangeField('apr', 'APR', farmFilters, { unit: '%' })
    + rangeField('rewards', 'Rewards per day', farmFilters, { unit: 'USD' })
    + rangeField('staked', 'Staked value', farmFilters, { unit: 'USD' })
    + rangeField('tokens', 'Reward tokens', farmFilters, { unit: 'count', step: '1' })
    + `<label>Pays this token<input data-f="reward" placeholder="e.g. WAX" value=""></label>`;
  wireFilterPanel(panel, farmFilters, renderFarms);
  $('#fMoreFarm').onclick = e => { panel.hidden = !panel.hidden; e.target.setAttribute('aria-pressed', String(!panel.hidden)); };
}

function filteredGroups() {
  return groups.filter(g => {
    if (!farmFilters.alcor && g.dex === 'alcor') return false;
    if (!farmFilters.taco && g.dex === 'taco') return false;
    if (farmFilters.realOnly && g.aprReal == null) return false;
    if (farmFilters.q) {
      const s = `${g.pool ? g.pool.symA + '/' + g.pool.symB : g.poolId} ${g.rewards.map(r => r.symbol).join(' ')} ${g.poolId}`.toLowerCase();
      if (!s.includes(farmFilters.q)) return false;
    }
    // An unknown APR is not a low one: a farm whose APR has not been computed is
    // excluded by an APR filter rather than silently treated as zero.
    if ((farmFilters.apr.min != null || farmFilters.apr.max != null) && g.aprReal == null) return false;
    if (!inRange(g.aprReal, farmFilters.apr)) return false;
    if (!inRange(g.rewardRealDay, farmFilters.rewards)) return false;
    if ((farmFilters.staked.min != null || farmFilters.staked.max != null) && g.stakedReal == null) return false;
    if (!inRange(g.stakedReal, farmFilters.staked)) return false;
    if (!inRange(g.tokenCount, farmFilters.tokens)) return false;
    if (farmFilters.reward) {
      const want = farmFilters.reward.trim().toUpperCase();
      if (!g.rewards.some(r => r.symbol.toUpperCase().includes(want))) return false;
    }
    return true;
  });
}

let groupsAll = [];
function renderFarms() {
  const key = `${state.loadedAt}:${farmFilters.expired}`;
  if (groups._key !== key) {
    // Expired farms are excluded by default: their reward rate is zero, so any
    // APR computed from one is arithmetic on a farm that stopped paying. They
    // are still worth being able to look at, which is what the toggle is for.
    groups = farmGroups({ liveOnly: !farmFilters.expired });
    groups._key = key; groups._at = state.loadedAt;
  }
  const rows = filteredGroups();
  for (const g of rows) {
    g.share = poolShare(g, farmFilters.size);
    g.aprAt = aprAtSize(g, farmFilters.size);
    // Past a third of the pool you are not joining a market, you are becoming
    // one. Those rank below everything you could actually enter.
    g.tooSmall = g.share > 0.33;
  }
  // A missing value is not a small one. Sorting nulls as -Infinity put every
  // farm we cannot value at the top of a descending APR sort, which is the
  // opposite of useful — they sink to the bottom whichever way you sort.
  rows.sort((a, b) => {
    if (a.tooSmall !== b.tooSmall) return a.tooSmall ? 1 : -1;
    if (a.runaway !== b.runaway) return a.runaway ? 1 : -1;
    const x = a[farmFilters.sort], y = b[farmFilters.sort];
    const xn = x == null || !isFinite(x), yn = y == null || !isFinite(y);
    if (xn && yn) return (b.rewardUsdDay || 0) - (a.rewardUsdDay || 0);
    if (xn) return 1;
    if (yn) return -1;
    return (x - y) * farmFilters.dir;
  });

  lastRendered.farms = rows;

  const payReal = groups.reduce((s, g) => s + (g.rewardRealDay || 0), 0);
  const enterableAll = rows.filter(g => !g.tooSmall && g.aprAt != null);
  const best = enterableAll.length ? Math.max(...enterableAll.map(g => g.aprAt)) : null;
  const median = enterableAll.length
    ? [...enterableAll].map(g => g.aprAt).sort((a, b) => a - b)[Math.floor(enterableAll.length / 2)]
    : null;
  const multi = groups.filter(g => g.tokenCount > 1).length;
  $('#farmStats').innerHTML = `
    <div class="stat"><span class="v">${enterableAll.length.toLocaleString()}</span><span class="k">${farmFilters.size > 0 ? 'big enough for you' : 'farms paying'}</span><span class="sub">of ${groups.length.toLocaleString()} farmed pools</span></div>
    <div class="stat"><span class="v">${best != null ? pct(best) : '—'}</span><span class="k">best rate${farmFilters.size > 0 ? ' at your size' : ''}</span><span class="sub">${farmFilters.size > 0 ? 'after your deposit dilutes it' : 'as advertised today'}</span></div>
    <div class="stat"><span class="v">${median != null ? pct(median) : '—'}</span><span class="k">middle of the pack</span><span class="sub">half pay more, half pay less</span></div>
    <div class="stat"><span class="v">${usd(payReal)}</span><span class="k">paid out daily</span><span class="sub">across every farm, in sellable tokens</span></div>
    <div class="stat"><span class="v">${multi.toLocaleString()}</span><span class="k">pay several tokens</span><span class="sub">up to ${Math.max(...groups.map(g => g.tokenCount), 0)} at once</span></div>`;
  const enterable = rows.filter(g => !g.tooSmall && g.aprAt != null).length;
  $('#farmCount').innerHTML = (farmFilters.size > 0
    ? `${enterable.toLocaleString()} can take ${usd(farmFilters.size)}<span class="dim"> &middot; ${rows.length.toLocaleString()} farms</span>`
    : `${rows.length.toLocaleString()} farms`)
    + (rows.length > 250 ? '<span class="dim"> &middot; top 250 listed</span>' : '');

  const cols = [
    { k: 'rank', label: '', s: false },
    { k: 'pool', label: 'Pool', s: false },
    { k: 'aprAt', label: 'APR', r: true, s: true },
    { k: 'share', label: 'You\u2019d own', r: true, s: true },
    { k: 'rewards', label: 'Pays per day', s: false },
    { k: 'stakedReal', label: 'Pool', r: true, s: true },
    { k: 'rewardRealDay', label: 'Value / day', r: true, s: true },
    { k: 'endsAt', label: 'Ends', r: true, s: true },
  ];
  const thead = $('#farmTable thead');
  thead.innerHTML = '<tr>' + cols.map(c => `<th class="${c.r ? 'r ' : ''}${c.s ? 'sortable' : ''}" data-k="${c.k}">${c.label}${farmFilters.sort === c.k ? ` <span class="dir">${farmFilters.dir < 0 ? '▾' : '▴'}</span>` : ''}</th>`).join('') + '</tr>';
  thead.querySelectorAll('th.sortable').forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    if (farmFilters.sort === k) farmFilters.dir *= -1; else { farmFilters.sort = k; farmFilters.dir = -1; }
    renderFarms();
  });

  $('#farmCount').innerHTML = capNote(rows.length, cap('farms'), 'farms');
  $('#farmTable tbody').innerHTML = rows.slice(0, cap('farms')).map((g, i) => {
    const pool = g.pool
      ? `<span data-pm="${esc(g.pool.tokenA)}|${esc(g.pool.symA)}|${esc(g.pool.tokenB)}|${esc(g.pool.symB)}"></span>
         <span class="pairbig">${pairName(g.pool)}</span>
         <span class="venue ${g.dex}">${g.dex === 'alcor' ? 'Alcor' : g.dex === 'taco' ? 'Taco' : g.dex}</span>
         ${g.runaway ? `<span class="badge bad" title="Pays ${usd(g.rewardRealDay)} a day into a pool holding ${usd(g.pool.tvlReal)}. The rate is real; the token cannot survive it.">burning out</span>` : ''}`
      : `<span class="dim">${esc(g.poolId)}</span>`;
    // What it pays and how much of it: several incentives can pay the same token,
    // so sum per token rather than listing it twice.
    const byTok = new Map();
    for (const r of g.rewards) {
      const cur = byTok.get(r.token) || { symbol: r.symbol, perDay: 0, usdDay: 0 };
      cur.perDay += r.perDay || 0; cur.usdDay += r.usdDay || 0;
      byTok.set(r.token, cur);
    }
    const list = [...byTok].sort((a, b) => b[1].usdDay - a[1].usdDay);
    const chips = list.slice(0, 3).map(([tok, r]) =>
        `<span class="rew" title="${qty(r.perDay)} ${esc(r.symbol)} per day${r.usdDay ? ' · ' + usd(r.usdDay) : ''}">
           <span data-pm="${esc(tok)}|${esc(r.symbol)}"></span>
           <b>${qty(r.perDay)}</b>&nbsp;${esc(r.symbol)}</span>`).join('')
      + (list.length > 3 ? `<span class="rew more" title="${list.slice(3).map(([, r]) => qty(r.perDay) + ' ' + r.symbol).join(', ')}">+${list.length - 3}</span>` : '');
    // Show what you would get, with the headline underneath only when the two
    // differ enough to matter — that gap IS the size of the farm.
    // Show the move, not the destination. "62% → 43%" says what adding your
    // money does to the rate; a lone diluted number just looks like a worse farm.
    const moved = farmFilters.size > 0 && g.aprReal != null && g.aprAt != null && g.aprReal > g.aprAt * 1.02;
    const aprCell = g.tooSmall
      ? `<span class="dim" title="This pool holds ${usd(g.pool?.tvlReal || 0)}. Adding ${usd(farmFilters.size)} would make you ${(g.share * 100).toFixed(0)}% of it — you would mostly be trading against yourself.">too small for that</span>`
      : g.aprAt != null
        ? (moved
            ? `<span class="aprmove"><span class="was">${pct(g.aprReal)}</span><span class="arrow">&rarr;</span><span class="apr">${pct(g.aprAt)}</span></span>`
            : `<span class="apr">${pct(g.aprAt)}</span>`)
        : `<span class="dim">—</span>`;
    const rw = g.runwayDays;
    return `<tr class="clickable ${g.tooSmall ? 'faded' : ''}" data-pool="${g.dex}:${esc(g.poolId)}">
      <td class="rank">${i + 1}</td>
      <td>${pool}</td>
      <td class="r">${aprCell}</td>
      <td class="r num ${g.tooSmall ? 'neg' : g.share > 0.15 ? '' : 'dim'}">${farmFilters.size > 0 ? (g.share * 100).toFixed(g.share > 0.1 ? 0 : 1) + '%' : '—'}</td>
      <td>${chips}</td>
      <td class="r num">${usd(g.pool?.tvlReal ?? 0)}<span class="nominal">${g.stakedReal != null ? usd(g.stakedReal) + ' staked' : ''}</span></td>
      <td class="r num">${usd(g.rewardRealDay)}</td>
      <td class="r num ${rw != null && rw < 7 ? 'neg' : 'dim'}" title="${rw == null ? '' : `Rewards run out in about ${rw < 1 ? Math.round(rw * 24) + ' hours' : Math.round(rw) + ' days'} at today's rate`}">${
        g.expired ? '<span class="badge bad">expired</span>'
        : rw == null ? '—'
        : rw < 1 ? Math.round(rw * 24) + 'h'
        : rw < 400 ? Math.round(rw) + 'd' : '400d+'}</td>
      <td class="r num dim">#${g.newestId}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="empty">No farms match.</td></tr>';
  fillMarks($('#farmTable tbody'));
  $('#farmTable tbody').querySelectorAll('tr[data-pool]').forEach(tr => tr.onclick = () => openPool(tr.dataset.pool));
}

// Exact APR for the rows on screen. The denominator is the UNION of positions
// staked across the pool's incentives, so a position in five farms counts once.
async function computeVisibleApr() {
  const btn = $('#calcApr');
  const targets = filteredGroups()
    .sort((a, b) => ((a[farmFilters.sort] ?? -Infinity) - (b[farmFilters.sort] ?? -Infinity)) * farmFilters.dir)
    .slice(0, 250)
    .filter(g => g.aprStatus === 'lazy' && g.dex === 'alcor');
  if (!targets.length) { btn.textContent = 'Nothing left to compute'; setTimeout(() => btn.textContent = 'Compute APR for visible', 1800); return; }

  btn.disabled = true;
  const BATCH = 5;
  for (let i = 0; i < targets.length; i += BATCH) {
    btn.textContent = `Computing ${Math.min(i + BATCH, targets.length)}/${targets.length}…`;
    await Promise.all(targets.slice(i, i + BATCH).map(async g => {
      try {
        const st = await groupStakedUsd(g);
        g.stakedUsd = st;
        if (st >= 25 && g.rewardUsdDay > 0) { g.apr = (g.rewardUsdDay * 365 / st) * 100; g.aprStatus = 'ok'; }
        else g.aprStatus = !(st > 0) ? 'no_stake' : 'thin';
      } catch { /* stays computable on a retry */ }
    }));
    renderFarms();
  }
  btn.disabled = false;
  btn.textContent = 'Compute APR for visible';
}

// --------------------------------------------------------------- WALLET -----
function wireWallet() {
  // Connected already means the question has an answer, so asking it again is
  // a form standing between someone and their own wallet.
  // Connected already means the question has an answer, so asking it again is a
  // form standing between someone and their own wallet. The search box stays —
  // looking at another account is a real thing to want — it just is not the
  // toll gate.
  //
  // The first version gated on the input being empty, which never happened:
  // restoring a session pre-fills it with your own name, so the field showed
  // the account and then refused to look it up. Gate on what has actually been
  // rendered instead.
  // Three panes, one lookup. Everything still loads together — the split is
  // about not making someone scroll past their CPU meter to reach a balance,
  // not about loading less.
  $('#walletTabs')?.addEventListener('click', e => {
    const b = e.target.closest('button[data-wtab]');
    if (!b) return;
    document.querySelectorAll('#walletTabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.wpane').forEach(p2 => { p2.hidden = p2.dataset.wpane !== b.dataset.wtab; });
  });

  wallet.onSession(() => {
    const a = wallet.account();
    if (a && lastView === 'wallet') autoWallet();
  });
  $('#walletGo').onclick = () => lookupWallet($('#walletInput').value.trim());
  $('#walletInput').onkeydown = e => { if (e.key === 'Enter') lookupWallet(e.target.value.trim()); };
  // No demo button. It held a stranger's account name, and pointing thousands
  // of visitors at someone's wallet because it made a convenient example is not
  // ours to do.
  $('#walletDemo')?.remove();
}

// ------------------------------------------------------- WALLET SECTIONS ----
// Everything an account holds and everything it is owed.
//
// One rule runs through all of it: **claiming is free**. Collecting your own
// money is not a service, and charging for it would make the fee feel like a
// toll rather than a price. The fee exists for compounding, which is work the
// terminal does on your behalf — several transactions, measured balances, sized
// deposits — and it is only ever taken from what was just claimed.

// ---------------------------------------------------------- RESOURCES ------
// CPU, NET and RAM, and the three things people actually need to do with them:
// top up, get staked WAX back, and vote so the stake earns something.
//
// The numbers that say how close you are to being unable to transact live in
// get_account and nowhere a normal person looks. A meter is the whole point.
// Whether a claim should re-cast the vote on its way past. On by default,
// because a decayed vote silently stops the reward and the fix is free — but a
// preference, because re-voting is a transaction someone might not want.
const autoVoteOn = () => { try { return localStorage.getItem('waxterminal.autovote') !== '0'; } catch { return true; } };

async function renderWalletResources(account) {
  const out = $('#walletRes');
  if (!out) return;
  out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Reading your resources…</span></div>';

  let r;
  try { r = await resourcesOf(account); } catch { out.innerHTML = ''; return; }

  const cheese = state.tokens.get('CHEESE@cheeseburger') || { symbol: 'CHEESE', contract: 'cheeseburger', decimals: 4 };
  const meter = (label, frac, detail) => `
    <div class="meter">
      <div class="meterhead"><span>${label}</span><span class="mono ${frac > 0.9 ? 'neg' : frac > 0.7 ? 'warnish' : 'dim'}">${(frac * 100).toFixed(1)}% used</span></div>
      <div class="metertrack"><span class="meterfill ${frac > 0.9 ? 'hot' : frac > 0.7 ? 'warm' : ''}" style="width:${Math.max(1, frac * 100).toFixed(1)}%"></span></div>
      <div class="sub">${detail}</div>
    </div>`;

  const refund = r.refund;
  const ready = refund && Date.now() >= refund.readyAt;

  out.innerHTML = `<div class="section"><h3>Resources <span class="dim">&mdash; what makes an account able to transact at all</span></h3>
    <div class="grid g2">
      <div class="card"><h3>Where you stand</h3>
        ${meter('CPU', useFraction(r.cpu), `${micros(r.cpu.available)} left &mdash; about ${cpuTransactions(r.cpu.available).toLocaleString()} more transactions, from ${qty(r.staked.cpu)} WAX staked`)}
        ${meter('NET', useFraction(r.net), `${bytes(r.net.available)} left, from ${qty(r.staked.net)} WAX staked`)}
        ${meter('RAM', useFraction(r.ram), `${bytes(r.ram.max - r.ram.used)} free of ${bytes(r.ram.max)} &mdash; RAM is bought, not staked, and holds your token rows`)}
        <p class="sub" style="margin:10px 0 0">CPU refills over a day. Running out is the usual reason an account suddenly cannot do anything, and it is the cheapest problem here to fix.</p>
      </div>

      <div class="card"><h3>Power up with CHEESE <span class="dim">&mdash; burned, not paid to anyone</span></h3>
        <div class="toolbar" style="margin:0">
          ${[0.5, 2, 5, 20].map((a, i) => `<button class="chip" data-pw="${a}"${i === 1 ? ' aria-pressed="true"' : ''}>${a} CHEESE</button>`).join('')}
        </div>
        <p class="sub" style="margin:9px 0 0" id="pwNote"></p>
        <div id="pwOut" style="margin-top:10px"></div>
        <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="pwGo">Power up</button></div>
      </div>
    </div>

    <div class="grid g2" style="margin-top:12px">
      <div class="card"><h3>Unstake <span class="dim">&mdash; three days in a queue before it lands</span></h3>
        <div class="filters" style="display:grid;gap:8px;margin:0">
          <label>From CPU<input id="unCpu" type="number" step="any" min="0" max="${r.staked.cpu}" placeholder="0" inputmode="decimal"></label>
          <label>From NET<input id="unNet" type="number" step="any" min="0" max="${r.staked.net}" placeholder="0" inputmode="decimal"></label>
        </div>
        <p class="sub" style="margin:9px 0 0">You have ${qty(r.staked.cpu)} WAX in CPU and ${qty(r.staked.net)} in NET. Unstaking lowers what you can transact with, and the WAX is neither staked nor spendable for three days.</p>
        <div id="unOut" style="margin-top:10px"></div>
        <div class="toolbar" style="margin:10px 0 0"><button class="btn ghost" id="unGo">Review</button></div>
      </div>

      <div class="card"><h3>Voting <span class="dim">&mdash; a stake that does not vote earns nothing</span></h3>
        ${r.voter && (r.voter.proxy || r.voter.producers.length) ? `
          <p class="sub" style="margin:0 0 10px">Voting ${r.voter.proxy ? `through the proxy ${acctLink(r.voter.proxy)}` : `for ${r.voter.producers.length} producers directly`}${r.voter.weight > 0 ? '' : ', but the weight has decayed to nothing &mdash; claiming re-casts it'}.</p>`
        : `<p class="sub" style="margin:0 0 10px"><b class="neg">Not voting.</b> Staked WAX earns a reward only while it votes, so this stake is earning nothing at all.</p>`}
        <div class="toolbar" style="margin:0">
          <button class="chip" id="voteProxyBtn" aria-pressed="true">Use a proxy</button>
          <input class="search" id="voteProxy" value="${esc(r.voter?.proxy || CFG?.commercial?.stakeProxy || 'waxcommunity')}" style="max-width:200px" spellcheck="false">
          <button class="btn ghost" id="voteGo">Vote</button>
        </div>
        <label class="pick" style="margin-top:10px"><input type="checkbox" id="voteAuto"${autoVoteOn() ? ' checked' : ''}>
          <span class="sub">Re-cast this vote automatically whenever I claim or compound, so the weight never decays</span></label>
        <div id="voteOut" style="margin-top:10px"></div>
        <p class="sub" style="margin:10px 0 0">A proxy votes on your behalf and you can change or drop it whenever you like. Voting for producers directly works too &mdash; this terminal does not pick either for you.</p>
      </div>

      <div class="card"><h3>Refund queue</h3>
        ${refund ? `<div class="stats" style="margin:0 0 10px">
            <div class="stat"><span class="v">${qty(refund.total)} WAX</span><span class="k">on its way back</span><span class="sub">${qty(refund.cpu)} from CPU, ${qty(refund.net)} from NET</span></div>
            <div class="stat"><span class="v ${ready ? 'pos' : ''}">${ready ? 'ready' : ago(new Date(refund.readyAt).toISOString()).replace(' ago', '')}</span><span class="k">${ready ? 'claim it' : 'until it lands'}</span><span class="sub">unstaked ${ago(new Date(refund.at).toISOString())}</span></div>
          </div>
          <div id="rfOut"></div>
          <div class="toolbar" style="margin:0"><button class="btn" id="rfGo"${ready ? '' : ' disabled'}>Collect refund</button></div>`
        : `<p class="sub" style="margin:0">Nothing unstaking. Anything you take out of CPU or NET waits here for three days, and this is where it appears &mdash; it usually lands on its own, and this page can nudge it if it does not.</p>`}
      </div>
    </div>
  </div>`;

  // ---- power up ------------------------------------------------------------
  let pw = 2;
  const pwNote = $('#pwNote');
  const paintPw = () => {
    // Priced from what the service has actually done: 2,636 CHEESE bought 4,778
    // WAX of powerup over its life. An observed rate, not a promised one.
    const waxish = pw * 1.81;
    pwNote.innerHTML = `${pw} CHEESE buys roughly ${qty(waxish)} WAX of CPU and NET for a day, going by what this service has historically delivered.
      The CHEESE is burned to <span class="mono">eosio.null</span> &mdash; it pays nobody, it leaves circulation.`;
  };
  paintPw();
  out.querySelectorAll('[data-pw]').forEach(b => b.onclick = () => {
    out.querySelectorAll('[data-pw]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    pw = Number(b.dataset.pw); paintPw();
  });
  $('#pwGo').onclick = async () => {
    const box = $('#pwOut');
    if (!wallet.account()) { try { await wallet.connect(); } catch { return; } }
    const built = buildPowerup({ amount: pw, target: account, token: cheese, me: wallet.account() });
    box.innerHTML = `<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">
      Send <b>${pw} CHEESE</b> to <span class="mono">cheesepowerz</span> to power up <span class="mono">${esc(account)}</span>.
      <br><span class="dim">One transfer. The service burns the CHEESE and pays the system powerup fee in its own WAX.</span>
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="pwSign">Sign and power up</button></div></div>`;
    $('#pwSign').onclick = async () => {
      box.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
      try {
        const tx = await wallet.transact(built.actions);
        box.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)"><b>Powered up.</b> CPU and NET should be available within a block.
          <br><a class="mono" style="font-size:11px" href="${trxUrl(tx.id)}" target="_blank" rel="noopener">${tx.id.slice(0, 16)}… &nearr;</a></div>`;
      } catch (e) { box.innerHTML = txError(e); }
    };
  };

  // ---- unstake -------------------------------------------------------------
  $('#unGo').onclick = () => {
    const box = $('#unOut');
    const cpu = Number($('#unCpu').value) || 0, net = Number($('#unNet').value) || 0;
    if (!(cpu > 0) && !(net > 0)) { box.innerHTML = '<div class="err">Enter an amount.</div>'; return; }
    if (cpu > r.staked.cpu || net > r.staked.net) { box.innerHTML = '<div class="err">That is more than you have staked.</div>'; return; }
    const built = buildUnstake({ cpu, net, me: account });
    box.innerHTML = `<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">
      Unstake <b>${qty(built.total)} WAX</b> &mdash; ${qty(cpu)} from CPU and ${qty(net)} from NET.
      <br><span class="dim">It lands in your wallet in three days. Until then it is not staked, not spendable, and not earning &mdash; and your CPU drops immediately.</span>
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="unSign">Sign and unstake</button></div></div>`;
    $('#unSign').onclick = async () => {
      box.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
      try {
        const tx = await wallet.transact(built.actions);
        box.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)"><b>Unstaked.</b> ${qty(built.total)} WAX is in the refund queue for three days.
          <br><a class="mono" style="font-size:11px" href="${trxUrl(tx.id)}" target="_blank" rel="noopener">${tx.id.slice(0, 16)}… &nearr;</a></div>`;
      } catch (e) { box.innerHTML = txError(e); }
    };
  };

  // ---- open orders ---------------------------------------------------------
  // The order-book tables are scoped per market with no owner index, so this
  // asks only about the markets whose token this account actually holds. A
  // sweep of all 970 would be 970 reads to find, usually, none.
  (async () => {
    const box = $('#walletOrders');
    if (!box) return;
    try {
      const [all, info] = await Promise.all([obMarkets(), accountInfo(account)]);
      const held = new Set(info.balances.map(b => b.id));
      const mine = all.filter(m => held.has(m.quote.id) || held.has(m.base.id)).slice(0, 60);
      const orders = await ordersOf(account, mine.map(m => m.id));
      if (!orders.length) { box.innerHTML = ''; return; }
      const byId = new Map(all.map(m => [m.id, m]));
      box.innerHTML = `<div class="section"><h3>Open orders <span class="dim">&mdash; resting on Alcor's book until filled or cancelled</span></h3>
        <div class="card"><div class="tablewrap" style="max-height:none;border:0"><table style="font-size:12.5px">
          <thead><tr><th></th><th>Market</th><th class="r">Price</th><th class="r">Size</th><th class="r">Placed</th><th></th></tr></thead>
          <tbody>${orders.map(o => {
            const m = byId.get(o.marketId);
            return `<tr>
              <td class="${o.side === 'buy' ? 'pos' : 'neg'}">${o.side}</td>
              <td>${m ? esc(m.quote.symbol) + '/' + esc(m.base.symbol) : '#' + o.marketId}</td>
              <td class="r num">${qty(o.price)}</td>
              <td class="r num">${qty(o.quote)}${m ? ' <span class="sub">' + esc(m.quote.symbol) + '</span>' : ''}</td>
              <td class="r num dim">${ago(new Date(o.at).toISOString())}</td>
              <td class="r"><button class="chip" data-cancel="${o.marketId}|${o.id}|${o.side}">cancel</button></td>
            </tr>`;
          }).join('')}</tbody></table></div>
          <div id="obCancelOut" style="margin-top:10px"></div>
          <p class="sub" style="margin:10px 0 0">${orders.length} open. What you sent is held by the book until the order fills or you cancel it, and cancelling returns it.</p>
        </div></div>`;
      box.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => {
        const [marketId, orderId, side] = b.dataset.cancel.split('|');
        const out2 = $('#obCancelOut');
        out2.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
        try {
          const tx = await wallet.transact(buildCancelOrder({ marketId, orderId, side, me: account }).actions);
          out2.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)"><b>Cancelled.</b> What you sent is back in your wallet.
            <br><a class="mono" style="font-size:11px" href="${trxUrl(tx.id)}" target="_blank" rel="noopener">${tx.id.slice(0, 16)}… &nearr;</a></div>`;
        } catch (e) { out2.innerHTML = txError(e); }
      });
    } catch { box.innerHTML = ''; }
  })();

  // ---- voting --------------------------------------------------------------
  const va = $('#voteAuto');
  if (va) va.onchange = () => { try { localStorage.setItem('waxterminal.autovote', va.checked ? '1' : '0'); } catch {} };
  const vg = $('#voteGo');
  if (vg) vg.onclick = async () => {
    const box = $('#voteOut');
    const proxy = $('#voteProxy').value.trim().toLowerCase();
    if (!/^[a-z1-5.]{1,12}$/.test(proxy)) { box.innerHTML = '<div class="err">That is not a WAX account name.</div>'; return; }
    if (!wallet.account()) { try { await wallet.connect(); } catch { return; } }
    box.innerHTML = `<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">
      Vote through <span class="mono">${esc(proxy)}</span>. This replaces whatever you vote for now, and you can change it again at any time from here or any wallet.
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="voteSign">Sign and vote</button></div></div>`;
    $('#voteSign').onclick = async () => {
      box.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
      try {
        const tx = await wallet.transact(buildVote({ proxy, me: wallet.account() }).actions);
        box.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)"><b>Voted.</b> Your stake earns from here on.
          <br><a class="mono" style="font-size:11px" href="${trxUrl(tx.id)}" target="_blank" rel="noopener">${tx.id.slice(0, 16)}… &nearr;</a></div>`;
      } catch (e) { box.innerHTML = txError(e); }
    };
  };

  // ---- refund --------------------------------------------------------------
  const rf = $('#rfGo');
  if (rf) rf.onclick = async () => {
    const box = $('#rfOut');
    box.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
    try {
      const tx = await wallet.transact(buildRefund({ me: account }).actions);
      box.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)"><b>Collected.</b>
        <br><a class="mono" style="font-size:11px" href="${trxUrl(tx.id)}" target="_blank" rel="noopener">${tx.id.slice(0, 16)}… &nearr;</a></div>`;
    } catch (e) { box.innerHTML = txError(e); }
  };
}

// Every signing path in this app reports a decline the same way, and a decline
// is not an error worth alarming anyone about.
const txError = e => {
  const m = String(e?.message || e);
  return `<div class="err">${/cancel|reject|declin/i.test(m) ? 'You declined the signature — nothing happened.' : esc(m)}</div>`;
};

// ---- staked WAX ------------------------------------------------------------
async function renderWalletStake(account, feeBps, feeAccount) {
  const out = $('#walletStake');
  if (!out) return;
  out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Reading your stake…</span></div>';

  let info, history;
  try { [info, history] = await Promise.all([stakeInfo(account), claimHistory(account)]); }
  catch { out.innerHTML = ''; return; }

  if (!info.exists || !(info.staked > 0)) { out.innerHTML = ''; return; }

  const apr = observedApr(history, info.staked);
  const last = history[0] || null;
  const ready = info.claimableAt == null || Date.now() >= info.claimableAt;
  const waxUsd = state.waxUsd || 0;
  const waited = info.lastClaim ? Math.round((Date.now() - info.lastClaim) / 86400000) : null;

  out.innerHTML = `<div class="section"><h3>Staked WAX <span class="dim">&mdash; the reward on CPU and NET, which does not arrive on its own</span></h3>
    <div class="stats">
      <div class="stat"><span class="v">${qty(info.staked)} WAX</span><span class="k">staked</span><span class="sub">${waxUsd ? usd(info.staked * waxUsd) : '&nbsp;'}</span></div>
      <div class="stat"><span class="v ${info.voting ? 'pos' : 'neg'}">${info.voting ? 'earning' : 'not earning'}</span><span class="k">vote</span><span class="sub">${info.voting
        ? (info.proxy ? `proxied to ${acctLink(info.proxy)}` : `${info.producers.length} producers`)
        : 'a stake that does not vote earns nothing'}</span></div>
      <div class="stat"><span class="v">${apr != null ? pct(apr) : '—'}</span><span class="k">observed rate</span><span class="sub">${apr != null ? 'from what was actually paid' : 'needs a week of claims to annualise'}</span></div>
      <div class="stat"><span class="v">${last ? qty(last.amount) + ' WAX' : '—'}</span><span class="k">last claim paid</span><span class="sub">${last ? ago(new Date(last.ts).toISOString()) : 'never claimed'}</span></div>
    </div>
    <div class="card">
      ${!info.voting ? `<p class="sub" style="margin:0 0 10px">This stake is not voting, so it earns nothing. Voting for producers or a proxy starts the reward &mdash; this terminal will not pick one for you, because who you vote for is not a thing to have chosen on your behalf.</p>` : ''}
      ${info.lastClaim && !ready ? `<p class="sub" style="margin:0 0 10px">Claimed ${ago(new Date(info.lastClaim).toISOString())}. The contract allows one claim a day.</p>` : ''}
      ${info.voting && ready && waited > 7 ? `<p class="sub" style="margin:0 0 10px"><b>${waited} days</b> since the last claim. The reward accrues whether or not it is collected, but the vote weight that earns it decays &mdash; which is why the claim re-casts your existing ${info.proxy ? 'proxy' : 'producers'} in the same transaction.</p>` : ''}
      <div id="stakeSteps"></div>
      <div class="toolbar" style="margin:0">
        <button class="btn" id="stakeGo"${ready ? '' : ' disabled'}>Claim and restake</button>
      </div>
      <p class="sub" style="margin:10px 0 0">Two signatures: one claims, then your balance is read to see exactly what arrived, and the second stakes that back${feeBps > 0 && feeAccount ? `, less a ${(feeBps / 100).toFixed(2)}% fee to ${acctLink(feeAccount)}` : ''}.
      ${!info.voting ? `The claim also casts your vote to <span class="mono">${esc(CFG?.commercial?.stakeProxy || 'a proxy')}</span>, because a stake that does not vote earns nothing at all &mdash; you can change it any time from any wallet.` : ''}</p>
    </div>
  </div>`;

  $('#stakeGo').onclick = () => runStake(account, info, feeBps, feeAccount, {});
}

// ---- pepperstake claims ----------------------------------------------------
// The same forgotten-rewards problem as the WaxDAO farms, on a contract that
// makes you collect each period separately before a withdraw pays anything.
// Someone away for six months is a hundred and eighty collect actions behind,
// which is not one transaction — so the batch is bounded and says what is left.
async function renderPepperClaims(account) {
  const out = $('#walletClaims');
  if (!out) return;
  let stakes = [];
  try { stakes = await pepperStakes(account); } catch { out.innerHTML = ''; return; }
  const live = stakes.filter(s => s.collected > 0 || s.behind > 0);
  if (!live.length) { out.innerHTML = ''; return; }

  out.innerHTML = `<div class="section"><h3>PepperStake <span class="dim">&mdash; rewards that accrue period by period and wait to be collected</span></h3>
    <div class="card">
      <div class="tablewrap" style="max-height:none;border:0"><table style="font-size:12.5px">
        <thead><tr><th></th><th>Pool</th><th>Pays</th><th class="r">Uncollected</th><th class="r">Staked</th></tr></thead>
        <tbody>${live.map(s => `<tr>
          <td><input type="checkbox" class="peppick" data-pool="${s.poolId}" checked></td>
          <td class="mono">#${s.poolId}</td>
          <td>${s.pool?.reward ? `${qty(s.pool.reward.amount)} ${esc(s.pool.reward.symbol)} <span class="sub">per period</span>` : '<span class="dim">unknown</span>'}</td>
          <td class="r num ${s.behindTotal > 0 ? '' : 'dim'}">${s.behindTotal > 0 ? `${s.behindTotal} period${s.behindTotal === 1 ? '' : 's'}` : '—'}${s.behindTotal > s.behind ? ` <span class="sub">${s.behind} this go</span>` : ''}</td>
          <td class="r num dim">${s.stakedAssets ? `${s.stakedAssets} NFTs` : s.stakedTokens ? qty(s.stakedTokens) : '—'}</td>
        </tr>`).join('')}</tbody></table></div>
      <div id="pepSteps"></div>
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="pepGo">Claim selected &mdash; no fee</button></div>
      <p class="sub" style="margin:10px 0 0">This contract accrues one period at a time and only pays out what has been collected, so a claim is a run of collects followed by a withdraw.
      Up to forty periods per pool per transaction &mdash; a longer absence takes more than one go, and the button says how much is left.
      No fee: this is a claim, not a compound.</p>
    </div></div>`;

  $('#pepGo').onclick = async () => {
    const picked = new Set([...document.querySelectorAll('.peppick:checked')].map(c => Number(c.dataset.pool)));
    const box = $('#pepSteps');
    const chosen = live.filter(s => picked.has(s.poolId));
    if (!chosen.length) { box.innerHTML = '<div class="err" style="margin-top:10px">Nothing selected.</div>'; return; }
    if (!wallet.account()) { try { await wallet.connect(); } catch { return; } }

    const built = chosen.map(s => ({ s, b: buildPepperClaim({ account, stake: s }) }));
    const actions = built.flatMap(x => x.b.actions);
    const left = built.reduce((n, x) => n + x.b.remaining, 0);
    box.innerHTML = `<div class="loading" style="margin-top:10px"><span class="spinner"></span><span>Waiting for your wallet — ${actions.length} actions across ${chosen.length} pool${chosen.length === 1 ? '' : 's'}…</span></div>`;
    try {
      const tx = await wallet.transact(actions);
      box.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft);margin-top:10px"><b>Claimed.</b> ${chosen.length} pool${chosen.length === 1 ? '' : 's'} collected and withdrawn.
        ${left > 0 ? `<br><span class="dim">${left} period${left === 1 ? '' : 's'} still uncollected — run it again to catch up the rest.</span>` : ''}
        <br><a class="mono" style="font-size:11px" href="${trxUrl(tx.id)}" target="_blank" rel="noopener">${tx.id.slice(0, 16)}… &nearr;</a></div>`;
    } catch (e) { box.innerHTML = `<div style="margin-top:10px">${txError(e)}</div>`; }
  };
}

// ---- WaxDAO farm rewards ---------------------------------------------------
async function renderWalletFarms(account) {
  const out = $('#walletFarms');
  if (!out) return;
  let stakes = [];
  try { stakes = await waxdaoStakes(account); } catch { out.innerHTML = ''; return; }
  const live = stakes.map(s => ({ s, now: claimableNow(s) })).filter(x => x.now.length);
  if (!live.length) { out.innerHTML = ''; return; }

  const valueOf = t => {
    const px = state.prices.get(`${t.symbol}@${t.contract}`)?.usd;
    return px != null ? t.amount * px : null;
  };
  const total = live.reduce((s, x) => s + x.now.reduce((a, t) => a + (valueOf(t) ?? 0), 0), 0);

  out.innerHTML = `<div class="section"><h3>WaxDAO farms <span class="dim">&mdash; rewards on staked NFTs, which most people forget they are owed</span></h3>
    <div class="card">
      <div class="tablewrap" style="max-height:none;border:0"><table style="font-size:12.5px">
        <thead><tr><th></th><th>Farm</th><th class="r">Staked</th><th>Waiting for you</th><th class="r">Worth</th></tr></thead>
        <tbody>${live.map(({ s, now }, i) => `<tr>
          <td><input type="checkbox" class="wdpick" data-farm="${esc(s.farm)}" checked></td>
          <td class="mono">${esc(s.farm)}</td>
          <td class="r num dim">${s.assets} NFT${s.assets === 1 ? '' : 's'}</td>
          <td>${now.map(t => `<span class="badge">${qty(t.amount)} ${esc(t.symbol)}</span>`).join(' ')}</td>
          <td class="r num">${(() => { const v = now.reduce((a, t) => a + (valueOf(t) ?? 0), 0); return v > 0 ? usd(v) : '<span class="dim">unpriced</span>'; })()}</td>
        </tr>`).join('')}</tbody></table></div>
      <div id="wdSteps"></div>
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="wdClaim">Claim selected &mdash; no fee</button></div>
      <p class="sub" style="margin:10px 0 0">${total > 0 ? `${usd(total)} waiting across ${live.length} farm${live.length === 1 ? '' : 's'}. ` : ''}Amounts are the balance the contract has recorded plus what has accrued since, at the farm's hourly rate &mdash; an estimate on the second half, and the claim pays whatever it actually pays.
      This is a claim, not a compound, so there is no fee. The NFTs themselves are not touched and are not managed here &mdash;
      <a href="https://cheesehubwax.github.io/cheesehub/farm" target="_blank" rel="noopener">CheeseHub &nearr;</a> is where you stake them, create a farm, or do anything else WaxDAO.</p>
    </div>
  </div>`;

  $('#wdClaim').onclick = async () => {
    const farms = [...document.querySelectorAll('.wdpick:checked')].map(c => c.dataset.farm);
    const box = $('#wdSteps');
    if (!farms.length) { box.innerHTML = '<div class="err" style="margin-top:10px">Nothing selected.</div>'; return; }
    box.innerHTML = `<div class="loading" style="margin-top:10px"><span class="spinner"></span><span>Waiting for your wallet — claiming ${farms.length} farm${farms.length === 1 ? '' : 's'}…</span></div>`;
    try {
      const r = await wallet.transact(buildWaxdaoClaims({ account, farms }));
      box.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft);margin-top:10px"><b>Claimed.</b> ${farms.length} farm${farms.length === 1 ? '' : 's'} paid out to your wallet.
        <br><span class="mono" style="font-size:11px">${r.id.slice(0, 16)}…</span></div>`;
    } catch (e) {
      const m = String(e.message || e);
      box.innerHTML = `<div class="err" style="margin-top:10px">${/cancel|reject|declin/i.test(m) ? 'You declined the signature — nothing happened.' : esc(m)}</div>`;
    }
  };
}

// ---- balances, and sending them somewhere ----------------------------------
async function renderWalletBalances(account) {
  const out = $('#walletBalances');
  if (!out) return;
  out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Reading balances…</span></div>';

  let info;
  try { info = await accountInfo(account); } catch { out.innerHTML = ''; return; }
  const v = valueBalances(info.balances, state.prices, state.depth);
  const priced = v.rows.filter(r => r.usd != null);

  out.innerHTML = `<div class="section"><h3>Balances</h3>
    <div class="grid g2">
      <div class="card"><h3>What you hold <span class="dim">&mdash; ${usd(v.realisable)} realisable of ${usd(v.priced)} at face value</span></h3>
        <div class="tablewrap" style="max-height:340px;border:0"><table style="font-size:12.5px"><tbody>${
          priced.slice(0, 40).map(r => `<tr class="clickable" data-tokid="${esc(r.id)}">
            <td><span data-pm="${esc(r.id)}|${esc(r.symbol)}"></span><span class="pairbig">${esc(r.symbol)}</span></td>
            <td class="r num">${qty(r.amount)}</td>
            <td class="r num">${usd(r.usd)}</td>
            <td class="r num ${r.ratio < 0.5 ? 'dim' : ''}">${usd(r.real)}</td></tr>`).join('')}</tbody></table></div>
        <p class="sub" style="margin:9px 0 0">${priced.length} priced, ${v.unpriced} with no pool deep enough to quote, ${info.zeroed.toLocaleString()} sitting at zero. The last column is what a route to a bridged dollar could actually carry out.</p></div>

      <div class="card"><h3>Send</h3>
        <div class="filters" style="display:grid;gap:8px;margin:0">
          <label>Token<select id="sendTok">${v.rows.filter(r => r.amount > 0).map(r =>
            `<option value="${esc(r.id)}">${esc(r.symbol)} — ${qty(r.amount)} available</option>`).join('')}</select></label>
          <label>To<input id="sendTo" placeholder="account name" autocomplete="off" spellcheck="false"></label>
          <label>Amount<input id="sendAmt" type="number" step="any" min="0" placeholder="0.0000" inputmode="decimal"></label>
          <label>Memo<input id="sendMemo" placeholder="optional — required by most exchanges" autocomplete="off"></label>
        </div>
        <div id="sendOut" style="margin-top:10px"></div>
        <div class="toolbar" style="margin:10px 0 0">
          <button class="btn ghost" id="sendMax">Send everything</button>
          <button class="btn" id="sendGo">Review</button>
        </div>
        <p class="sub" style="margin:10px 0 0">A transfer cannot be undone and an account name that does not exist will simply fail, which is the kinder of the two outcomes. The review step shows exactly what will be signed.</p>
      </div>
    </div>
  </div>`;

  fillMarks($('#walletBalances'));
  out.querySelectorAll('tr[data-tokid]').forEach(tr => tr.onclick = () => openToken(tr.dataset.tokid));

  const balOf = id => v.rows.find(r => r.id === id)?.amount ?? 0;
  $('#sendMax').onclick = () => { $('#sendAmt').value = String(balOf($('#sendTok').value)); };
  $('#sendGo').onclick = () => reviewSend(account, v.rows);
}

// Two clicks, on purpose. The first builds the transfer and shows it back in
// words; the second signs it. Everything else in this terminal is reversible or
// merely a read — this is the one control that moves someone else's money to
// someone else.
function reviewSend(account, rows) {
  const box = $('#sendOut');
  const id = $('#sendTok').value;
  const to = $('#sendTo').value.trim().toLowerCase();
  const amount = Number($('#sendAmt').value);
  const memo = $('#sendMemo').value;
  const row = rows.find(r => r.id === id);

  if (!row) { box.innerHTML = '<div class="err">Pick a token.</div>'; return; }
  if (!/^[a-z1-5.]{1,12}$/.test(to)) { box.innerHTML = '<div class="err">That is not a WAX account name. They are 1–12 characters of a–z, 1–5 and dots.</div>'; return; }
  if (!(amount > 0)) { box.innerHTML = '<div class="err">Enter an amount.</div>'; return; }
  if (amount > row.amount) { box.innerHTML = `<div class="err">You hold ${qty(row.amount)} ${esc(row.symbol)}, which is less than that.</div>`; return; }

  const worth = row.price != null ? usd(amount * row.price) : null;
  box.innerHTML = `<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">
    Send <b>${qty(amount)} ${esc(row.symbol)}</b>${worth ? ` (${worth})` : ''} from <span class="mono">${esc(account)}</span> to <span class="mono">${esc(to)}</span>${memo ? ` with memo <span class="mono">${esc(memo)}</span>` : ', with no memo'}.
    ${!memo ? '<br><span class="dim">Most exchanges and services need a memo to credit a deposit. Without one it can be lost.</span>' : ''}
    <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="sendConfirm">Sign and send</button></div></div>`;

  $('#sendConfirm').onclick = async () => {
    box.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
    try {
      const r = await wallet.transact([{
        account: row.contract, name: 'transfer',
        authorization: [{ actor: account, permission: 'active' }],
        data: { from: account, to, quantity: asset(amount, row.symbol, row.decimals), memo },
      }]);
      box.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)"><b>Sent.</b> ${qty(amount)} ${esc(row.symbol)} to ${esc(to)}.
        <br><a class="mono" style="font-size:11px" href="${trxUrl(r.id)}" target="_blank" rel="noopener">${r.id.slice(0, 16)}… &nearr;</a></div>`;
    } catch (e) {
      const m = String(e.message || e);
      box.innerHTML = `<div class="err">${/cancel|reject|declin/i.test(m) ? 'You declined the signature — nothing was sent.' : esc(m)}</div>`;
    }
  };
}

// Which account the wallet view is currently showing, so entering it again
// does not re-sweep positions that are already on screen.
let walletShown = null;

function autoWallet() {
  const a = wallet.account();
  if (!a || walletShown === a) return false;
  $('#walletInput').value = a;
  lookupWallet(a);
  return true;
}

async function lookupWallet(account) {
  if (!account) return;
  walletShown = account;
  // Each section answers its own question and loads on its own schedule; the
  // position sweep is the slowest of them and should not hold up a balance.
  const feeAccount = CFG?.commercial?.feeAccount || '';
  const feeBps = feeAccount ? Math.max(0, Math.min(100, CFG?.commercial?.compoundFeeBps ?? 0)) : 0;
  renderWalletResources(account).catch(() => {});
  renderWalletStake(account, feeBps, feeAccount).catch(() => {});
  renderWalletFarms(account).catch(() => {});
  renderPepperClaims(account).catch(() => {});
  renderWalletBalances(account).catch(() => {});

  const out = $('#walletOut');
  out.innerHTML = '<div class="loading"><span class="spinner"></span><span id="wmsg">Looking up…</span></div>';
  let res;
  try {
    // Alcor's own index first — seconds instead of twenty, and it knows what you
    // deposited. Reading the chain ourselves is the fallback, not the default.
    const alcor = await walletPositionsFast(account);
    const slow = await walletPositions(account, { onProgress: () => {}, skipAlcor: true }).catch(() => ({ alcor: [], taco: [], poolsChecked: 0 }));
    res = { alcor: alcor.length ? alcor : slow.alcor, taco: slow.taco, poolsChecked: slow.poolsChecked };
  } catch {
    try { res = await walletPositions(account, { onProgress: p => { const m = $('#wmsg'); if (m) m.textContent = p.msg; } }); }
    catch (e) { out.innerHTML = `<div class="err">Lookup failed: ${esc(e.message)}</div>`; return; }
  }

  const all = [...res.alcor, ...res.taco];
  if (!all.length) {
    out.innerHTML = `<div class="empty">No liquidity found for <span class="mono">${esc(account)}</span>.<br>
      <span class="dim">Checked ${res.poolsChecked} Alcor pool${res.poolsChecked === 1 ? '' : 's'} this account has interacted with, plus its TacoSwap LP balances.</span></div>`;
    return;
  }

  const totalUsd = all.reduce((s, p) => s + (p.valueUsd || 0), 0);
  const feesUsd = res.alcor.reduce((s, p) => s + (p.feesUsd || 0), 0);
  const outOfRange = res.alcor.filter(p => !p.inRange);
  const oorUsd = outOfRange.reduce((s, p) => s + (p.valueUsd || 0), 0);
  // What the position is earning, from the pool's own 24h volume and fee tier
  // times your share of it. Only in-range positions earn anything.
  // Deposited, profit and value all come from Alcor's own books for the Alcor
  // positions. The headline "liquidity value" also counts TacoSwap, valued
  // here, so putting the two side by side invited the subtraction and gave the
  // wrong answer: $827.74 against $750.58 deposited reads as $77 of profit,
  // where the figure shown was $4.04. It was right — it just was not comparing
  // against the number printed beside it.
  const deposited = res.alcor.reduce((s, p) => s + (p.depositedUsd || 0), 0);
  const pnl = res.alcor.reduce((s, p) => s + (p.pnlUsd || 0), 0);
  const alcorValue = res.alcor.reduce((s, p) => s + (p.valueUsd || 0), 0);
  const tacoCount = all.length - res.alcor.length;
  const dailyFees = all.reduce((s, p) => {
    const pool = p.pool;
    if (!p.inRange || !(pool.vol24 > 0) || !(pool.tvlReal > 0)) return s;
    return s + pool.vol24 * (pool.feeBps / 10000) * ((p.valueUsd || 0) / pool.tvlReal);
  }, 0);

  let html = `<div class="stats">
      <div class="stat"><span class="v">${usd(totalUsd)}</span><span class="k">liquidity value</span><span class="sub">${all.length} position${all.length === 1 ? '' : 's'} across ${new Set(all.map(p => p.pool.dex)).size} venue${new Set(all.map(p => p.pool.dex)).size === 1 ? '' : 's'}</span></div>
      <div class="stat"><span class="v">${usd(feesUsd)}</span><span class="k">fees waiting</span><span class="sub">uncollected, earning nothing</span></div>
      <div class="stat"><span class="v ${outOfRange.length ? 'neg' : 'pos'}">${usd(oorUsd)}</span><span class="k">idle, out of range</span><span class="sub">${outOfRange.length} of ${res.alcor.length} Alcor position${res.alcor.length === 1 ? '' : 's'}</span></div>
      <div class="stat"><span class="v">${usd(dailyFees)}</span><span class="k">earning per day</span><span class="sub">at each pool's 24h volume</span></div>
      ${deposited > 0 ? `<div class="stat"><span class="v ${pnl >= 0 ? 'pos' : 'neg'}">${pnl >= 0 ? '+' : ''}${usd(pnl)}</span><span class="k">profit so far</span><span class="sub">${usd(alcorValue)} now against ${usd(deposited)} put in, on Alcor positions only${tacoCount > 0 ? ` &mdash; the ${tacoCount} TacoSwap position${tacoCount === 1 ? '' : 's'} above ${tacoCount === 1 ? 'is' : 'are'} not in this` : ''}</span></div>` : ''}
    </div>`;

  if (outOfRange.length) {
    html += `<div class="note" style="margin-bottom:16px"><b>${usd(oorUsd)} is sitting outside its range.</b>
      Concentrated liquidity only earns while the price is inside the band you chose. Nobody checks this daily, and
      quiet weeks out of range are where the yield actually goes.</div>`;
  }

  html += `<div class="grid g2" style="margin-bottom:16px">
      <div class="card"><h3>Where your money is</h3><div id="walDonut"></div></div>
      <div class="card"><h3>Fees waiting to be collected</h3><div id="walFees"></div></div>
    </div>`;

  html += '<div class="grid g2">';
  for (const p of res.alcor) {
    const share = p.pool.tvlReal > 0 ? p.valueUsd / p.pool.tvlReal : null;
    html += `<div class="poscard ${p.inRange ? '' : 'out'}" data-rb="${esc(p.pool.id)}:${p.tickLower}:${p.tickUpper}:${p.pool.tick}">
      <div class="ph"><span data-pm="${esc(p.pool.tokenA)}|${esc(p.pool.symA)}|${esc(p.pool.tokenB)}|${esc(p.pool.symB)}"></span>
        <span class="pairbig">${pairName(p.pool)}</span>
        <span class="venue alcor">Alcor</span>
        <span class="badge ${p.inRange ? 'good' : 'bad'}">${p.inRange ? 'earning' : 'out of range'}</span>
        <span style="flex:1"></span><span class="pv">${usd(p.valueUsd)}</span></div>
      <div class="sub">#${p.posId} &middot; ${(p.pool.feeBps / 100).toFixed(2)}% fee${share != null ? ` &middot; ${(share * 100).toFixed(1)}% of the pool` : ''}</div>
      <div class="rb-slot" style="margin-top:10px"></div>
      <dl class="kv">
        <dt>${esc(p.pool.symA)}</dt><dd>${qty(p.amountA)}</dd>
        <dt>${esc(p.pool.symB)}</dt><dd>${qty(p.amountB)}</dd>
        <dt>Fees waiting</dt><dd>${usd(p.feesUsd)}</dd>
        ${p.depositedUsd > 0 ? `<dt>Profit</dt><dd class="${p.pnlUsd >= 0 ? 'pos' : 'neg'}">${p.pnlUsd >= 0 ? '+' : ''}${usd(p.pnlUsd)}</dd>` : ''}
        <dt>Needs topping up at</dt><dd>${(p.ratio.shareA * 100).toFixed(0)} / ${(p.ratio.shareB * 100).toFixed(0)}</dd>
      </dl>
      <button class="btn ghost" style="margin-top:10px;width:100%" data-compound="${esc(p.pool.id)}:${p.posId}">Plan compound</button>
      <div class="cplan" hidden></div></div>`;
  }
  for (const p of res.taco) {
    html += `<div class="poscard">
      <div class="ph"><span data-pm="${esc(p.pool.tokenA)}|${esc(p.pool.symA)}|${esc(p.pool.tokenB)}|${esc(p.pool.symB)}"></span>
        <span class="pairbig">${pairName(p.pool)}</span>
        <span class="venue taco">Taco</span>
        <span style="flex:1"></span><span class="pv">${usd(p.valueUsd)}</span></div>
      <div class="sub">${qty(p.balance)} ${esc(p.pool.id)} LP &middot; ${(p.share * 100).toPrecision(3)}% of the pair</div>
      <dl class="kv">
        <dt>${esc(p.pool.symA)}</dt><dd>${qty(p.amountA)}</dd>
        <dt>${esc(p.pool.symB)}</dt><dd>${qty(p.amountB)}</dd>
      </dl></div>`;
  }
  html += '</div>';
  out.innerHTML = html;

  // Charts after the markup exists.
  $('#walDonut')?.appendChild(donut(all.map(p => ({ label: `${p.pool.symA}/${p.pool.symB}`, value: p.valueUsd || 0 })), { fmt: usd, top: 6 }));
  const feeRows = res.alcor.filter(p => p.feesUsd > 0).sort((a, b) => b.feesUsd - a.feesUsd).slice(0, 8);
  $('#walFees')?.appendChild(feeRows.length
    ? bars(feeRows.map(p => ({ label: `${p.pool.symA}/${p.pool.symB}`, value: p.feesUsd, note: `position #${p.posId}` })), { fmt: usd, color: 'var(--c3)' })
    : Object.assign(document.createElement('div'), { className: 'chart-empty', textContent: 'Nothing uncollected right now.' }));

  // Range bars are DOM, not markup: build them after the cards exist.
  out.querySelectorAll('.poscard[data-rb]').forEach(card => {
    const [, tl, tu, tk] = card.dataset.rb.split(':').map(Number);
    card.querySelector('.rb-slot')?.appendChild(rangeBar(tl, tu, tk));
  });
  out.querySelectorAll('button[data-compound]').forEach(btn => {
    btn.onclick = () => {
      const [poolId, posId] = btn.dataset.compound.split(':');
      const pos = res.alcor.find(x => String(x.pool.id) === poolId && String(x.posId) === posId);
      if (pos) showCompound(btn, pos);
    };
  });
}

// ------------------------------------------------------------- COMPOUND -----
// No contract, no delegated permission: the terminal computes the sequence and
// the wallet signs it. Nothing here can move funds on its own.
async function showCompound(btn, pos) {
  const box = btn.nextElementSibling;
  if (!box.hidden) { box.hidden = true; btn.textContent = 'Plan compound'; return; }
  box.hidden = false;
  btn.textContent = 'Hide plan';
  box.innerHTML = '<div class="loading"><span class="spinner"></span><span>Reading claimable rewards…</span></div>';

  let harvest, plan;
  try {
    harvest = await harvestFor(pos, pos.pool, { prices: state.prices, tokens: state.tokens });
    plan = planCompound({
      pool: pos.pool, position: pos, basket: harvest.basket,
      feeBps: 0,
      sqrtP: sqrtPriceFromX64(pos.pool.sqrtX64),
    });
  } catch (e) { box.innerHTML = `<div class="err">Could not build a plan: ${esc(e.message)}</div>`; return; }

  const b = plan;
  const basketRows = harvest.basket.map(x => `<tr>
      <td><b>${esc(x.symbol)}</b></td>
      <td class="r num">${qty(x.amount)}</td>
      <td class="r num">${x.priced ? usd(x.usd) : '<span class="dim" title="No pool deep enough to price this token">unpriceable</span>'}</td>
      <td class="dim" style="font-size:11px">${esc(x.source)}</td></tr>`).join('');

  const swapRows = b.swaps.length
    ? b.swaps.map(s => `<tr><td><b>${esc(s.from)}</b> → <b>${esc(s.to)}</b></td><td class="r num">${usd(s.usd)}</td><td class="dim" style="font-size:11px">${esc(s.why)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="dim" style="padding:8px 13px">No swap needed — the harvest already matches the band.</td></tr>';

  box.innerHTML = `
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
      ${!b.viable ? `<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">${esc(b.reason)}</div>` : ''}
      <div class="stats" style="margin-bottom:10px">
        <div class="stat"><span class="v">${usd(b.grossUsd)}</span><span class="k">claimable now</span><span class="sub">${harvest.basket.length} item${harvest.basket.length === 1 ? '' : 's'}</span></div>
        <div class="stat"><span class="v">${usd(b.netUsd)}</span><span class="k">redeposited</span><span class="sub">${b.feeUsd > 0 ? 'after ' + usd(b.feeUsd) + ' fee' : 'no fee charged'}</span></div>
        <div class="stat"><span class="v">${(b.ratio.shareA * 100).toFixed(1)}/${(b.ratio.shareB * 100).toFixed(1)}</span><span class="k">this band needs</span><span class="sub">${esc(pos.pool.symA)} / ${esc(pos.pool.symB)}</span></div>
        <div class="stat"><span class="v">${b.actions.length}</span><span class="k">actions, one signature</span>${b.needsSplit ? '<span class="sub neg">must be split</span>' : ''}</div>
      </div>

      <div class="grid g2">
        <div class="card"><h3>Harvest <span class="dim">— what is claimable</span></h3>
          <table style="font-size:12.5px"><tbody>${basketRows}</tbody></table>
          ${b.alreadyRight.length ? `<p class="sub" style="margin:9px 0 0">${b.alreadyRight.map(x => esc(x.symbol)).join(', ')} ${b.alreadyRight.length === 1 ? 'is' : 'are'} already a pool token — never swapped, that would pay the spread to stand still.</p>` : ''}
        </div>
        <div class="card"><h3>Swaps <span class="dim">— basket into the band's ratio</span></h3>
          <table style="font-size:12.5px"><tbody>${swapRows}</tbody></table>
          <p class="sub" style="margin:9px 0 0">Lands at ${(b.finalA / (b.finalA + b.finalB) * 100 || 0).toFixed(2)}% / ${(b.finalB / (b.finalA + b.finalB) * 100 || 0).toFixed(2)}%.</p>
        </div>
      </div>

      <div class="card" style="margin-top:12px"><h3>The transaction your wallet would sign</h3>
        <ol style="margin:0;padding-left:20px;font-size:12.5px;line-height:1.75">
          ${b.actions.map(a => `<li><code class="mono">${esc(a.name)}</code> <span class="dim">${esc(a.note)}</span></li>`).join('')}
        </ol>
        <p class="sub" style="margin:10px 0 0">Claim, convert, redeposit &mdash; three signatures, or two when there is nothing to convert. The splits exist because the amount to convert is only known once the claim has executed, and the deposit only once the conversion has. No contract holds your funds and no permission is delegated.</p>
      </div>
    </div>`;
}

// ---------------------------------------------------------- WALLET LINK -----
function wireConnect() {
  const btn = $('#connectBtn'), chip = $('#acctChip');
  wallet.onSession(s => {
    const a = wallet.account();
    btn.hidden = !!a; chip.hidden = !a;
    if (a) $('#acctName').textContent = a;
    // The compound page is per-account: connecting should fill it in, not make
    // the user retype what the wallet already told us.
    if (a && !$('#compInput').value) { $('#compInput').value = a; $('#walletInput').value = a; }
  });
  // A change in entitlement changes how much of each table is drawn, so the
  // view that is open has to be redrawn rather than waiting for a navigation.
  // Starring something on the pools page should not require a reload to see it
  // on the front page.
  onWatchChange(() => { if (lastView === 'overview') { try { renderWatchlist(); } catch {} } });
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'Connecting…';
    try { await wallet.connect(); }
    catch (e) { if (!/cancel/i.test(e.message || '')) banner(`<div class="err">Wallet connection failed: ${esc(e.message)}</div>`); }
    finally { btn.disabled = false; btn.textContent = 'Connect wallet'; }
  };
  $('#disconnectBtn').onclick = () => wallet.disconnect();
  if (!SNAPSHOT_ONLY) wallet.restore();

  if (!wallet.isSecure()) {
    // Say this once, plainly. A Cloud Wallet popup that silently fails over
    // plain HTTP looks like the user cancelled, and they will blame the site.
    btn.title = 'Served over plain HTTP — only Anchor will work. HTTPS is needed for WAX Cloud Wallet.';
  }
}

// Run one position's compound.
//
// Three transactions, not two — and the page used to promise two. Claiming and
// converting cannot share a signature, because the amount to convert is not
// known until the claim has executed and the wallet has been read; converting
// and redepositing cannot share one either, because the deposit is sized from
// what the swap actually returned. A user told to expect two prompts and handed
// three has every reason to stop and wonder what the third one is.
//
// The convert step is skipped outright when the harvest already arrives in the
// two tokens the position needs, which is common on a single-token farm, so it
// is drawn as skipped rather than quietly vanishing.
async function runOne(box, entry, feeBps, feeAccount) {
  const { pos, harvest, plan } = entry;
  const steps = [
    { t: 'Claim', d: `Collect your fees and ${plan.actions.filter(a => a.name === 'getreward').length} farm reward(s). Nothing is swapped or spent.` },
    { t: 'Convert', d: 'Sell only what was just harvested into the two tokens this position holds. Sized from the measured claim, never from your balance.' },
    { t: 'Redeposit', d: 'Add exactly what arrived back into your range.'
        + (feeBps > 0 && feeAccount ? ` A ${(feeBps / 100).toFixed(2)}% fee on what was harvested goes to ${feeAccount}; nothing else leaves your wallet.` : '') },
  ];
  const render = (i, msg, err) => {
    box.innerHTML = `<div class="steps">${steps.map((s, n) => `
      <div class="step ${s.skipped ? 'done' : n < i ? 'done' : n === i ? 'active' : ''}">
        <span class="n">${s.skipped || n < i ? '&check;' : n + 1}</span>
        <div><h4>${s.t}</h4><p>${s.skipped ? esc(s.skipped) : n === i && msg ? esc(msg) : s.d}</p></div>
      </div>`).join('')}</div>
      ${err ? `<div class="err" style="margin-top:10px">${esc(err)}</div>` : ''}`;
  };

  try {
    render(0, 'Reading your balances…');
    // Everything the claim could produce, measured first, so afterwards the
    // difference is the harvest and nothing else.
    const basketIds = [...new Set(harvest.basket.map(b => b.tokenId))];
    const before = await readBalances(pos.pool, basketIds);

    render(0, 'Waiting for your wallet…');
    const { actions } = buildHarvest({ pool: pos.pool, position: pos, basket: harvest.basket, plan });
    if (!actions.length) throw new Error('Nothing claimable to harvest.');
    const r1 = await wallet.transact(actions);

    render(1, 'Measuring what arrived…');
    await new Promise(r => setTimeout(r, 2500));
    const after = await readBalances(pos.pool, basketIds);
    const harvested = harvestedFrom(before, after);
    if (!harvested.size) throw new Error('The claim produced nothing.');

    // Swaps sized from the measured harvest, then the deposit, in one signature.
    const sw = buildSwaps({ pool: pos.pool, plan, harvested });
    const skipped = sw.swaps.filter(x => x.skipped);
    if (sw.actions.length) {
      render(1, 'Waiting for your wallet — converting what you claimed…');
      await wallet.transact(sw.actions);
      await new Promise(r => setTimeout(r, 2500));
    } else {
      steps[1].skipped = 'Nothing to convert — the harvest already arrived in the two tokens this position holds.';
    }
    render(2, 'Sizing the deposit from what actually landed…');
    // What the plan said the harvest is worth, in token terms — the cap the
    // redeposit checks itself against.
    const pxA = pos.pool.priceUsdA, pxB = pos.pool.priceUsdB;
    const expected = {
      a: pxA > 0 ? (plan.netUsd * plan.ratio.shareA) / pxA : 0,
      b: pxB > 0 ? (plan.netUsd * plan.ratio.shareB) / pxB : 0,
    };
    const dep = await buildRedeposit({ pool: pos.pool, position: pos, feeBps, feeAccount, before, expected });
    render(2, 'Waiting for your wallet — putting it back…');
    const r2 = await wallet.transact(dep.actions);

    box.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)">
      <b>Compounded.</b> Put back ${qty(dep.depA)} ${esc(pos.pool.symA)} and ${qty(dep.depB)} ${esc(pos.pool.symB)} — the harvest only.
      Your existing ${esc(pos.pool.symA)} and ${esc(pos.pool.symB)} were left alone.
      ${skipped.length ? `<br><span class="dim">${skipped.length} reward left unswapped (${skipped.map(s => esc(s.skipped)).join(', ')}) — it is in your wallet.</span>` : ''}
      <br><span class="mono" style="font-size:11px">${r1.id.slice(0, 16)}… &middot; ${r2.id.slice(0, 16)}…</span></div>`;
  } catch (e) {
    const m = String(e.message || e);
    render(0, null, /cancel|reject|declin/i.test(m)
      ? 'You declined the signature — nothing happened.'
      : `Transaction failed: ${m}`);
  }
}

// --------------------------------------------------- COMPOUND (whole wallet) -
function wireCompound() {
  $('#compGo').onclick = () => runCompound($('#compInput').value.trim());
  $('#newPosGo').onclick = async () => {
    const who = $('#compInput').value.trim() || wallet.account();
    if (!who) { alert('Enter your account, or connect a wallet.'); return; }
    renderNewPosition(who);
  };
  $('#compInput').onkeydown = e => { if (e.key === 'Enter') runCompound(e.target.value.trim()); };
  $('#compDemo')?.remove();
}

async function runStake(account, info, feeBps, feeAccount, { claimOnly = false } = {}) {
  const box = $('#stakeSteps');
  const btn = $('#stakeGo');
  const steps = claimOnly
    ? [{ t: 'Claim', d: `Re-cast your existing ${info.proxy ? `proxy (${info.proxy})` : 'producers'} to refresh the vote weight, then collect the reward into your wallet. No fee, nothing staked.` }]
    : [
      { t: 'Claim', d: `Re-cast your existing ${info.proxy ? `proxy (${info.proxy})` : 'producers'} to refresh the vote weight, then collect the reward. Nothing is staked or spent.` },
      { t: 'Restake', d: 'Read what actually arrived and stake exactly that back into CPU and NET.' },
    ];
  const render = (i, msg, err) => {
    box.innerHTML = `<div class="steps">${steps.map((s, n) => `
      <div class="step ${n < i ? 'done' : n === i ? 'active' : ''}">
        <span class="n">${n < i ? '&check;' : n + 1}</span>
        <div><h4>${s.t}</h4><p>${n === i && msg ? esc(msg) : s.d}</p></div>
      </div>`).join('')}</div>
      ${err ? `<div class="err" style="margin-top:10px">${esc(err)}</div>` : ''}`;
  };

  btn.disabled = true;
  try {
    render(0, 'Reading your WAX balance…');
    const before = await balanceOf(account, 'eosio.token', 'WAX');

    render(0, 'Waiting for your wallet…');
    const claim = buildVoteClaim({
      account, proxy: info.proxy, producers: info.producers,
      // Off means claim only; the vote is left exactly as it is, decay and all.
      fallbackProxy: autoVoteOn() ? (CFG?.commercial?.stakeProxy || '') : '',
    });
    const r1 = await wallet.transact(claim.actions);

    if (claimOnly) {
      box.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)">
        <b>Claimed.</b> The reward is in your wallet. No fee was taken.
        <br><a class="mono" style="font-size:11px" href="${trxUrl(r1.id)}" target="_blank" rel="noopener">${r1.id.slice(0, 16)}… &nearr;</a></div>`;
      return;
    }

    render(1, 'Measuring what arrived…');
    await new Promise(r => setTimeout(r, 2500));
    const after = await balanceOf(account, 'eosio.token', 'WAX');
    const claimed = after - before;
    if (!(claimed > 0)) throw new Error('The claim paid nothing. The reward may already have been collected today, or the vote may have decayed to zero.');

    // Leave the CPU cost of the second transaction unstaked, or a wallet with
    // no spare WAX cannot pay for the very transaction that stakes it.
    const KEEP = 0.01;
    const stakeable = Math.max(0, claimed - KEEP);
    const back = buildStakeBack({
      claimed: stakeable, cpuWeight: info.staked, netWeight: 0,
      account, feeBps, feeAccount,
    });
    if (!back.actions.length) throw new Error('Nothing left to stake after the claim.');

    render(1, 'Waiting for your wallet — staking it back…');
    const r2 = await wallet.transact(back.actions);

    box.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)">
      <b>Compounded.</b> Claimed ${qty(claimed)} WAX and staked ${qty(back.staked)} of it back${back.fee > 0 ? `, ${qty(back.fee)} WAX fee` : ''}.
      <br><span class="mono" style="font-size:11px">${r1.id.slice(0, 16)}… &middot; ${r2.id.slice(0, 16)}…</span></div>`;
  } catch (e) {
    const m = String(e.message || e);
    render(0, null, /cancel|reject|declin/i.test(m) ? 'You declined the signature — nothing happened.' : m);
    btn.disabled = false;
  }
}

// ------------------------------------------------------- NEW POSITION ------
// Opening a pair you are not already in.
//
// The same addliquid as adding to an existing position — Alcor has no separate
// mint, a position simply is a range you have liquidity in — so the whole
// feature is choosing a range and not choosing a bad one.
//
// Concentrated liquidity punishes a range chosen carelessly in a way that
// constant-product does not: too narrow and the price leaves it and you earn
// nothing, too wide and your capital is spread so thin it barely earns either.
// So the picker offers bands around the current price rather than raw ticks,
// and says what each one means.
function renderNewPosition(account) {
  const box = $('#newPos');
  if (!box) return;
  const pools = state.pools
    .filter(p => p.dex === 'alcor' && p.sqrtX64 && p.tvlReal > 0)
    .sort((a, b) => (b.vol24 || 0) - (a.vol24 || 0) || (b.tvlReal || 0) - (a.tvlReal || 0))
    .slice(0, 300);

  box.innerHTML = `<div class="section"><h3>Open a new position</h3>
    <div class="card">
      <div class="filters" style="display:grid;gap:8px;margin:0">
        <label>Pool<select id="npPool">${pools.map(p =>
          `<option value="${esc(p.id)}">${esc(p.symA)}/${esc(p.symB)} — ${(p.feeBps / 100).toFixed(2)}% — ${usd(p.tvlReal)} pooled${p.vol24 > 0 ? `, ${usd(p.vol24)} traded` : ''}</option>`).join('')}</select></label>
      </div>
      <div class="toolbar" style="margin:10px 0 0">
        <span class="sub">Range</span>
        <button class="chip" data-band="full" aria-pressed="true">Full range</button>
        <button class="chip" data-band="50">±50%</button>
        <button class="chip" data-band="20">±20%</button>
        <button class="chip" data-band="5">±5%</button>
      </div>
      <p class="sub" id="npRange" style="margin:9px 0 0"></p>
      <div class="filters" style="display:grid;gap:8px;margin:10px 0 0">
        <label id="npLabA">Amount<input id="npA" type="number" step="any" min="0" placeholder="0" inputmode="decimal"></label>
        <label id="npLabB">Amount<input id="npB" type="number" step="any" min="0" placeholder="0" inputmode="decimal"></label>
      </div>
      <div id="npOut" style="margin-top:10px"></div>
      <div class="toolbar" style="margin:10px 0 0">
        <button class="btn ghost" id="npClose">Cancel</button>
        <button class="btn" id="npGo">Review</button>
      </div>
    </div></div>`;

  let band = 'full';
  const poolOf = () => pools.find(p => String(p.id) === $('#npPool').value);

  // Ticks must land on the pool's own spacing or the contract rejects them, and
  // the spacing differs per fee tier — 10 on a stable pair, 60 on a volatile
  // one. Rounding outward rather than to nearest, so a ±20% band is never
  // quietly narrower than it says.
  const ticksFor = p => {
    const spacing = p.tickSpacing || 60;
    const MAX = Math.floor(443580 / spacing) * spacing;
    if (band === 'full') return { lower: -MAX, upper: MAX };
    const pct = Number(band) / 100;
    const cur = p.tick ?? 0;
    // A tick is a 1.0001 step, so a band is log(ratio)/log(1.0001) ticks wide —
    // and the two sides are NOT the same width. A symmetric tick span around
    // the price reads as "+50% / −33%", because halving and doubling are not
    // mirror images on a log scale. Each side is computed from its own ratio so
    // "±50%" means the price can actually fall by half.
    const T = r => Math.log(r) / Math.log(1.0001);
    return {
      lower: Math.max(-MAX, Math.floor((cur + T(1 - pct)) / spacing) * spacing),
      upper: Math.min(MAX, Math.ceil((cur + T(1 + pct)) / spacing) * spacing),
    };
  };

  const paint = () => {
    const p = poolOf();
    if (!p) return;
    const { lower, upper } = ticksFor(p);
    const r = depositRatio(sqrtPriceFromX64(p.sqrtX64), lower, upper);
    $('#npLabA').firstChild.textContent = `${p.symA} `;
    $('#npLabB').firstChild.textContent = `${p.symB} `;
    const priceAt = t => Math.pow(1.0001, t) * 10 ** (p.decA - p.decB);
    $('#npRange').innerHTML = band === 'full'
      ? `Full range: your liquidity works at every price, the way a normal AMM pool does. It earns least per dollar and can never fall out of range &mdash; the safe default, and what most of these positions are.`
      : `From ${qty(priceAt(lower))} to ${qty(priceAt(upper))} ${esc(p.symB)} per ${esc(p.symA)}, around ${qty(p.priceAB)} now.
         Ticks ${lower}…${upper} on a spacing of ${p.tickSpacing || 60}. A narrower band earns more per dollar while the price stays inside it and nothing at all once it leaves.`;
    $('#npRange').innerHTML += ` <br>At this range the pool wants ${(r.shareA * 100).toFixed(1)}% ${esc(p.symA)} and ${(r.shareB * 100).toFixed(1)}% ${esc(p.symB)} by value.`;
  };

  $('#npPool').onchange = paint;
  box.querySelectorAll('[data-band]').forEach(b => b.onclick = () => {
    box.querySelectorAll('[data-band]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    band = b.dataset.band; paint();
  });
  $('#npClose').onclick = () => { box.innerHTML = ''; };

  const A = $('#npA'), B = $('#npB');
  const mirror = (from, to, keyFrom) => {
    const p = poolOf(); if (!p) return;
    const { lower, upper } = ticksFor(p);
    const r = depositRatio(sqrtPriceFromX64(p.sqrtX64), lower, upper);
    const [pxF, pxT, shF, shT] = keyFrom === 'A'
      ? [p.priceUsdA, p.priceUsdB, r.shareA, r.shareB]
      : [p.priceUsdB, p.priceUsdA, r.shareB, r.shareA];
    const v = Number(from.value);
    if (!(v > 0) || !(pxF > 0) || !(pxT > 0) || !(shF > 0)) return;
    to.value = ((v * pxF / shF * shT) / pxT).toPrecision(8).replace(/0+$/, '');
  };
  A.oninput = () => mirror(A, B, 'A');
  B.oninput = () => mirror(B, A, 'B');
  paint();

  $('#npGo').onclick = () => {
    const p = poolOf();
    const out = $('#npOut');
    if (!p) { out.innerHTML = '<div class="err">Pick a pool.</div>'; return; }
    const amountA = Number(A.value) || 0, amountB = Number(B.value) || 0;
    if (!(amountA > 0) && !(amountB > 0)) { out.innerHTML = '<div class="err">Enter an amount.</div>'; return; }
    const { lower, upper } = ticksFor(p);
    const built = buildAddLiquidity({ pool: p, tickLower: lower, tickUpper: upper, amountA, amountB, me: account });
    const worth = amountA * (p.priceUsdA || 0) + amountB * (p.priceUsdB || 0);
    out.innerHTML = `<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">
      Open a ${band === 'full' ? 'full-range' : '±' + band + '%'} position in <b>${esc(p.symA)}/${esc(p.symB)}</b> at ${(p.feeBps / 100).toFixed(2)}%, with
      <b>${qty(amountA)} ${esc(p.symA)}</b> and <b>${qty(amountB)} ${esc(p.symB)}</b>${worth > 0 ? ` (${usd(worth)})` : ''}, ticks ${lower}…${upper}.
      <br><span class="dim">${built.actions.length} actions in one signature. Whatever the pool cannot take at the current ratio stays in your Alcor balance rather than being lost.</span>
      ${band !== 'full' ? '<br><span class="dim">A narrow band stops earning the moment the price leaves it, and you are then holding whichever of the two tokens is the losing side. That is the trade you are making, not a malfunction.</span>' : ''}
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="npConfirm">Sign and open</button></div></div>`;
    $('#npConfirm').onclick = async () => {
      out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
      try {
        const r = await wallet.transact(built.actions);
        out.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)"><b>Opened.</b> Load your positions to see it.
          <br><a class="mono" style="font-size:11px" href="${trxUrl(r.id)}" target="_blank" rel="noopener">${r.id.slice(0, 16)}… &nearr;</a></div>`;
      } catch (e) {
        const m = String(e.message || e);
        out.innerHTML = `<div class="err">${/cancel|reject|declin/i.test(m) ? 'You declined the signature — nothing happened.' : esc(m)}</div>`;
      }
    };
  };
}

// ------------------------------------------------------- ADD / REMOVE LP ----
// Only one panel open at a time. Both use fixed element ids, so two open at
// once would have the second one's Review button reading the first one's
// inputs — which on a deposit form is not a cosmetic bug.
function closeOtherLpPanels(keep) {
  document.querySelectorAll('.lpbox').forEach(b => { if (b !== keep) b.innerHTML = ''; });
}

// The two operations Alcor's own positions page exists for, and the two this
// terminal could not do — which is an odd gap in a page whose only other
// feature, compounding, is those two run back to back.
//
// Both panels are deliberately plain. A deposit and a withdrawal are the
// moments to show someone exactly what will happen and then get out of the way,
// not to be clever about it.

// A concentrated position holds the two tokens in a ratio set by where the
// price sits inside its band, so a deposit has to arrive in that ratio or the
// remainder simply sits in the internal balance. Typing one side and having the
// other follow is the only version of this that does not waste money.
function renderAddLiquidity(box, pos, account) {
  closeOtherLpPanels(box);
  const pool = pos.pool;
  const ratio = pos.ratio || { shareA: 0.5, shareB: 0.5 };
  const pxA = pool.priceUsdA, pxB = pool.priceUsdB;

  box.innerHTML = `<div class="card" style="margin-top:11px;background:var(--surface-2)">
    <h3>Add to ${pairName(pool)} <span class="dim">&mdash; ticks ${pos.tickLower}…${pos.tickUpper}</span></h3>
    <div class="filters" style="display:grid;gap:8px;margin:0">
      <label>${esc(pool.symA)}<input id="addA" type="number" step="any" min="0" placeholder="0" inputmode="decimal"></label>
      <label>${esc(pool.symB)}<input id="addB" type="number" step="any" min="0" placeholder="0" inputmode="decimal"></label>
    </div>
    <p class="sub" id="addNote" style="margin:9px 0 0">This band currently wants ${(ratio.shareA * 100).toFixed(1)}% ${esc(pool.symA)} and ${(ratio.shareB * 100).toFixed(1)}% ${esc(pool.symB)} by value. Type either side and the other follows; the pool takes what it needs at the live ratio and anything left over stays in your Alcor balance, where you can withdraw it.</p>
    <div id="addOut" style="margin-top:10px"></div>
    <div class="toolbar" style="margin:10px 0 0">
      <button class="btn ghost" data-close-lp>Cancel</button>
      <button class="btn" id="addGo">Review</button>
    </div>
  </div>`;

  // Mirroring by value: equal dollars on each side of whatever ratio the band
  // asks for, which is the thing a depositor actually means.
  const A = $('#addA'), B = $('#addB');
  const mirror = (from, to, fromPx, toPx, fromShare, toShare) => {
    const v = Number(from.value);
    if (!(v > 0) || !(fromPx > 0) || !(toPx > 0) || !(fromShare > 0)) return;
    to.value = ((v * fromPx / fromShare * toShare) / toPx).toPrecision(8).replace(/0+$/, '');
  };
  A.oninput = () => mirror(A, B, pxA, pxB, ratio.shareA, ratio.shareB);
  B.oninput = () => mirror(B, A, pxB, pxA, ratio.shareB, ratio.shareA);
  box.querySelector('[data-close-lp]').onclick = () => { box.innerHTML = ''; };

  $('#addGo').onclick = () => {
    const amountA = Number(A.value) || 0, amountB = Number(B.value) || 0;
    const out = $('#addOut');
    if (!(amountA > 0) && !(amountB > 0)) { out.innerHTML = '<div class="err">Enter an amount.</div>'; return; }
    const built = buildAddLiquidity({ pool, tickLower: pos.tickLower, tickUpper: pos.tickUpper, amountA, amountB, me: account });
    const worth = (amountA * (pxA || 0)) + (amountB * (pxB || 0));
    out.innerHTML = `<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">
      Deposit <b>${qty(amountA)} ${esc(pool.symA)}</b> and <b>${qty(amountB)} ${esc(pool.symB)}</b>${worth > 0 ? ` (${usd(worth)})` : ''} into ticks ${pos.tickLower}…${pos.tickUpper}.
      ${built.venueTaxA || built.venueTaxB ? `<br><span class="dim">One of these taxes the transfer, so the deposit asks for what arrives rather than what was sent — the difference stays in your Alcor balance.</span>` : ''}
      <br><span class="dim">${built.actions.length} actions in one signature: the transfers that fund it, then addliquid. Nothing else in your wallet is touched.</span>
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="addConfirm">Sign and deposit</button></div></div>`;
    $('#addConfirm').onclick = async () => {
      out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
      try {
        const r = await wallet.transact(built.actions);
        out.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)"><b>Added.</b> Reload your positions to see the new size.
          <br><a class="mono" style="font-size:11px" href="${trxUrl(r.id)}" target="_blank" rel="noopener">${r.id.slice(0, 16)}… &nearr;</a></div>`;
      } catch (e) {
        const m = String(e.message || e);
        out.innerHTML = `<div class="err">${/cancel|reject|declin/i.test(m) ? 'You declined the signature — nothing happened.' : esc(m)}</div>`;
      }
    };
  };
}

// Taking liquidity back out pays the principal, the accrued fees and any farm
// rewards straight to the wallet in one action — checked against a real
// subliquid on chain rather than assumed from the ABI, because the ABI does not
// say where the tokens go and the neighbouring addliquid sends them somewhere
// else entirely.
function renderRemoveLiquidity(box, pos, account) {
  closeOtherLpPanels(box);
  const pool = pos.pool;
  box.innerHTML = `<div class="card" style="margin-top:11px;background:var(--surface-2)">
    <h3>Take ${pairName(pool)} back out <span class="dim">&mdash; ${usd(pos.valueUsd)} in this position</span></h3>
    <div class="toolbar" style="margin:0">
      ${[25, 50, 75, 100].map(p => `<button class="chip" data-pct="${p}"${p === 100 ? ' aria-pressed="true"' : ''}>${p}%</button>`).join('')}
    </div>
    <p class="sub" id="rmNote" style="margin:9px 0 0"></p>
    <div id="rmOut" style="margin-top:10px"></div>
    <div class="toolbar" style="margin:10px 0 0">
      <button class="btn ghost" data-close-lp>Cancel</button>
      <button class="btn" id="rmGo">Review</button>
    </div>
  </div>`;

  let pct = 100;
  const note = $('#rmNote');
  const paint = () => {
    const share = pct / 100;
    note.innerHTML = `Takes out ${qty(pos.amountA * share)} ${esc(pool.symA)} and ${qty(pos.amountB * share)} ${esc(pool.symB)}, about ${usd(pos.valueUsd * share)} at the current price.
      Your fees and any farm rewards on this position are paid out in the same action, whatever fraction you take${pct === 100 ? ', and the position closes' : ''}.`;
  };
  paint();
  box.querySelectorAll('[data-pct]').forEach(b => b.onclick = () => {
    box.querySelectorAll('[data-pct]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    pct = Number(b.dataset.pct); paint();
  });
  box.querySelector('[data-close-lp]').onclick = () => { box.innerHTML = ''; };

  $('#rmGo').onclick = () => {
    const out = $('#rmOut');
    const built = buildRemoveLiquidity({
      pool, position: pos, fraction: pct / 100,
      expectedA: pos.amountA, expectedB: pos.amountB, me: account,
    });
    if (!built.actions.length) { out.innerHTML = '<div class="err">That fraction rounds to nothing — liquidity is a whole number.</div>'; return; }
    out.innerHTML = `<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">
      Withdraw <b>${pct}%</b> of position #${pos.posId} &mdash; about ${qty(pos.amountA * pct / 100)} ${esc(pool.symA)} and ${qty(pos.amountB * pct / 100)} ${esc(pool.symB)}, plus everything it has earned.
      <br><span class="dim">Paid straight to your wallet; nothing is left in an internal balance. A minimum ${(100 - 1).toFixed(0)}% of the expected amounts is enforced, so a price move mid-transaction cancels rather than fills badly.</span>
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="rmConfirm">Sign and withdraw</button></div></div>`;
    $('#rmConfirm').onclick = async () => {
      out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
      try {
        const r = await wallet.transact(built.actions);
        out.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)"><b>Withdrawn.</b> ${pct === 100 ? 'The position is closed.' : `${pct}% taken out.`} Reload to refresh.
          <br><a class="mono" style="font-size:11px" href="${trxUrl(r.id)}" target="_blank" rel="noopener">${r.id.slice(0, 16)}… &nearr;</a></div>`;
      } catch (e) {
        const m = String(e.message || e);
        out.innerHTML = `<div class="err">${/cancel|reject|declin/i.test(m) ? 'You declined the signature — nothing happened.' : esc(m)}</div>`;
      }
    };
  };
}

async function runCompound(account) {
  if (!account) return;
  show('compound', account);
  const out = $('#compOut');
  out.innerHTML = '<div class="loading"><span class="spinner"></span><span id="cmsg">Finding your positions…</span></div>';

  let res;
  try { res = await walletPositions(account, { onProgress: p => { const m = $('#cmsg'); if (m) m.textContent = p.msg; } }); }
  catch (e) { out.innerHTML = `<div class="err">Lookup failed: ${esc(e.message)}</div>`; return; }

  if (!res.alcor.length) {
    out.innerHTML = `<div class="empty">No Alcor positions found for <span class="mono">${esc(account)}</span>. Compounding applies to concentrated positions; TacoSwap LP is handled on the farms page.</div>`;
    return;
  }

  // The fee is the partner's to set, and it stays off until they name an account
  // to receive it: an empty recipient must never mean "charge it anyway and send
  // it somewhere". buildRedeposit enforces the same pair, so the plan cannot
  // deduct a fee the transaction will not contain — it was quietly
  // under-reporting every result by 0.75% and listing a transfer that would
  // never be signed.
  const feeAccount = CFG?.commercial?.feeAccount || '';
  const feeBps = feeAccount ? Math.max(0, Math.min(100, CFG?.commercial?.compoundFeeBps ?? 0)) : 0;

  // Positions are independent, so read them in small parallel batches. Serial
  // was correct and far too slow: a 13-position wallet took minutes.
  const plans = [];
  const BATCH = 4;
  for (let i = 0; i < res.alcor.length; i += BATCH) {
    const m = $('#cmsg'); if (m) m.textContent = `Reading claimable rewards ${Math.min(i + BATCH, res.alcor.length)}/${res.alcor.length}…`;
    const chunk = await Promise.all(res.alcor.slice(i, i + BATCH).map(async pos => {
      try {
        const h = await harvestFor(pos, pos.pool, { prices: state.prices, tokens: state.tokens });
        return { pos, harvest: h, plan: planCompound({ pool: pos.pool, position: pos, basket: h.basket, feeBps, sqrtP: sqrtPriceFromX64(pos.pool.sqrtX64) }) };
      } catch { return { pos, harvest: { basket: [] }, plan: null }; }
    }));
    plans.push(...chunk);
  }

  plans.sort((a, b) => (b.plan?.grossUsd || 0) - (a.plan?.grossUsd || 0));
  // Whether a compound is worth doing is the holder's call, not ours: gas is
  // theirs, their horizon is theirs, and a position we would skip may be one
  // they want topped up. Everything with something to claim gets a button.
  const worth = plans.filter(x => x.plan && x.plan.grossUsd > 0);
  const gross = worth.reduce((s, x) => s + x.plan.grossUsd, 0);
  const fee = worth.reduce((s, x) => s + x.plan.feeUsd, 0);
  const swaps = worth.reduce((s, x) => s + x.plan.swaps.length, 0);
  const actions = worth.reduce((s, x) => s + x.plan.actions.length, 0);
  // Two signatures where the harvest already arrives in the right two tokens,
  // three where it has to be converted first. Announcing a flat two and then
  // asking for three is the one surprise this screen must not spring.
  const needSwap = worth.filter(x => x.plan.swaps.length > 0).length;
  const sigs = worth.length * 2 + needSwap;
  const unpriceable = plans.reduce((s, x) => s + (x.plan?.unpriced.length || 0), 0);
  const tokensSeen = new Set(plans.flatMap(x => x.harvest.basket.map(b => b.symbol)));

  let html = `<div class="stats">
      <div class="stat"><span class="v">${usd(gross)}</span><span class="k">claimable now</span><span class="sub">${tokensSeen.size} distinct token${tokensSeen.size === 1 ? '' : 's'}</span></div>
      <div class="stat"><span class="v">${usd(gross - fee)}</span><span class="k">back to work</span><span class="sub">${feeBps > 0 ? `after ${usd(fee)} fee at ${(feeBps / 100).toFixed(2)}%` : 'no fee charged'}</span></div>
      <div class="stat"><span class="v">${worth.length}/${plans.length}</span><span class="k">positions with something to claim</span></div>
      <div class="stat"><span class="v">${swaps}</span><span class="k">swaps needed</span><span class="sub">across all positions</span></div>
      <div class="stat"><span class="v">${sigs}</span><span class="k">signatures</span><span class="sub">${actions} actions &middot; ${needSwap} position${needSwap === 1 ? '' : 's'} also need${needSwap === 1 ? 's' : ''} a conversion</span></div>
    </div>`;

  if (unpriceable) {
    html += `<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">
      <b>${unpriceable} reward${unpriceable === 1 ? '' : 's'} could not be priced.</b> Those tokens have no pool deep enough to quote against, so they are excluded from the figures above rather than counted at a made-up value. They can still be claimed — they just cannot be valued or safely swapped.</div>`;
  }

  html += '<div class="grid" style="gap:12px">';
  for (const { pos, harvest, plan } of plans) {
    if (!plan) continue;
    // Selectable, because "compound everything" is not always what someone
    // means: a farm paying a token they want to keep, or one whose reward is
    // too small to be worth the conversion, should be leavable behind. Each
    // entry carries where it came from, so unticking one drops its claim action
    // as well as its share of the deposit.
    const basketBits = harvest.basket.map((b, bi) =>
      `<label class="pick" title="${esc(b.source)}"><input type="checkbox" data-pick="${pos.posId}" data-bi="${bi}" checked>
        <span class="badge">${esc(b.symbol)} ${b.priced ? usd(b.usd) : '?'}</span>
        <span class="sub">${esc(b.source === 'fees' ? 'LP fees' : 'farm ' + b.source)}</span></label>`).join(' ');
    html += `<div class="card">
      <div class="ph" style="display:flex;gap:9px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px">
        <span class="pair">${pairName(pos.pool)}</span>
        <span class="sub">#${pos.posId} &middot; ticks ${pos.tickLower}…${pos.tickUpper}</span>
        <span class="badge ${pos.inRange ? 'good' : 'bad'}">${pos.inRange ? 'in range' : 'out of range'}</span>
        <span style="flex:1"></span>
        <span class="mono" style="font-size:16px;font-weight:600">${usd(plan.grossUsd)}</span>
      </div>
      ${harvest.basket.length ? `
        <div style="font-size:12.5px;margin-bottom:8px">${basketBits || '<span class="dim">nothing claimable</span>'}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;font-size:12.5px">
          <div><span class="dim">This band needs</span><br><span class="mono">${(plan.ratio.shareA * 100).toFixed(1)}% ${esc(pos.pool.symA)} / ${(plan.ratio.shareB * 100).toFixed(1)}% ${esc(pos.pool.symB)}</span></div>
          <div><span class="dim">Already the right token</span><br><span class="mono">${[...new Set(plan.alreadyRight.map(b => b.symbol))].map(esc).join(', ') || '—'}</span></div>
          <div><span class="dim">To convert</span><br><span class="mono">${plan.swaps.map(s => `${esc(s.from)}&rarr;${esc(s.to)}`).join(', ') || 'nothing'}</span></div>
          <div><span class="dim">To sign</span><br><span class="mono">${plan.actions.length} actions, ${plan.swaps.length ? 3 : 2} signatures</span></div>
        </div>
        <div style="margin-top:11px"><button class="btn" data-run="${pos.posId}">Compound this position</button>
          ${!plan.ratio.inRange ? '<span class="sub" style="margin-left:10px">Out of range — this adds to a band the price has left.</span>' : ''}</div>
        <div class="runbox" data-runbox="${pos.posId}"></div>` : ''}
      <div class="toolbar" style="margin:11px 0 0;border-top:1px solid var(--line);padding-top:11px">
        <button class="btn ghost" data-add="${pos.posId}">Add liquidity</button>
        <button class="btn ghost" data-remove="${pos.posId}">Take some out</button>
        <span class="sub">Value ${usd(pos.valueUsd)}${pos.feesUsd > 0 ? ` &middot; ${usd(pos.feesUsd)} of fees waiting` : ''}</span>
      </div>
      <div class="lpbox" data-lpbox="${pos.posId}"></div>
    </div>`;
  }
  html += '</div>';

  html += `<div class="card" style="margin-top:14px"><h3>How this executes</h3>
    <p style="font-size:13px;color:var(--ink-2);margin:0 0 8px;max-width:74ch">Each position takes up to three signatures, and they cannot be fewer: the first collects your fees and farm rewards, and only once that has executed can your wallet be read to see what actually arrived. The second converts exactly that &mdash; skipped when the harvest already came in the two tokens this position holds &mdash; and the third puts back what the conversion returned. Nothing you already held is ever touched.</p>
    <p style="font-size:13px;color:var(--ink-2);margin:0;max-width:74ch">There is no compounding contract and no delegated permission. Nothing can move your funds without a signature you give at that moment — which also means a position in ten farms is ten claims in one transaction, not ten separate approvals.</p>
  </div>`;

  out.innerHTML = html;

  // Adding and removing are the two things Alcor's own positions page is for,
  // and until now this page could only compound — which is the one operation
  // that needs the other two to already exist.
  const mine = async () => {
    if (!wallet.account()) { try { await wallet.connect(); } catch { return false; } }
    if (wallet.account() !== account) {
      alert(`Connected as ${wallet.account()}, but these positions belong to ${account}.`);
      return false;
    }
    return true;
  };
  out.querySelectorAll('button[data-add]').forEach(b => b.onclick = async () => {
    if (!await mine()) return;
    const entry = plans.find(x => String(x.pos.posId) === b.dataset.add);
    if (entry) renderAddLiquidity(out.querySelector(`[data-lpbox="${b.dataset.add}"]`), entry.pos, account);
  });
  out.querySelectorAll('button[data-remove]').forEach(b => b.onclick = async () => {
    if (!await mine()) return;
    const entry = plans.find(x => String(x.pos.posId) === b.dataset.remove);
    if (entry) renderRemoveLiquidity(out.querySelector(`[data-lpbox="${b.dataset.remove}"]`), entry.pos, account);
  });

  out.querySelectorAll('button[data-run]').forEach(b => b.onclick = async () => {
    if (!wallet.account()) { try { await wallet.connect(); } catch { return; } }
    if (wallet.account() !== account) {
      alert(`Connected as ${wallet.account()}, but these positions belong to ${account}. Connect that account to compound them.`);
      return;
    }
    const entry = plans.find(x => String(x.pos.posId) === b.dataset.run);
    if (!entry) return;
    // Re-plan against what is actually ticked. Planning against the full basket
    // and then claiming a subset would size the deposit for money that never
    // arrived.
    const picked = new Set([...out.querySelectorAll(`[data-pick="${b.dataset.run}"]:checked`)].map(c => Number(c.dataset.bi)));
    const basket = entry.harvest.basket.filter((_, i) => picked.has(i));
    if (!basket.length) {
      out.querySelector(`[data-runbox="${b.dataset.run}"]`).innerHTML = '<div class="err" style="margin-top:10px">Nothing selected to compound.</div>';
      return;
    }
    const run = basket.length === entry.harvest.basket.length ? entry : {
      pos: entry.pos,
      harvest: { ...entry.harvest, basket },
      plan: planCompound({ pool: entry.pos.pool, position: entry.pos, basket, feeBps, sqrtP: sqrtPriceFromX64(entry.pos.pool.sqrtX64) }),
    };
    b.disabled = true;
    await runOne(out.querySelector(`[data-runbox="${b.dataset.run}"]`), run, feeBps, feeAccount);
    b.disabled = false;
  });
}

// ------------------------------------------------------------- ACTIVITY -----
let actWindow = 15;
function wireActivity() {
  $('#actRefresh').onclick = () => renderActivity();
  document.querySelectorAll('[data-win]').forEach(b => b.onclick = () => {
    actWindow = Number(b.dataset.win);
    document.querySelectorAll('[data-win]').forEach(x => x.setAttribute('aria-pressed', String(Number(x.dataset.win) === actWindow)));
    renderActivity();
  });
}

let activityLoaded = false;
async function renderActivity() {
  const out = $('#activityOut');
  out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Reading the swap feed…</span></div>';
  let swaps;
  // Longer windows need more pages, but not without limit: 24 hours of Alcor is
  // six figures of actions and the answer stops improving long before that.
  const pagesFor = m => m <= 60 ? 6 : m <= 240 ? 12 : 20;
  try { swaps = await recentSwaps({ minutes: actWindow, maxPages: pagesFor(actWindow), onProgress: n => { const m = out.querySelector('span:last-child'); if (m) m.textContent = `Reading the swap feed… ${n.toLocaleString()} swaps`; } }); }
  catch (e) { out.innerHTML = `<div class="err">Feed unavailable: ${esc(e.message)}</div>`; return; }
  activityLoaded = true;

  // Past the history node's ceiling the summed feed understates badly, so the
  // headline falls back to the venue's own aggregate and says so.
  const venueTotal24 = actWindow >= 1440
    ? state.pools.reduce((a, p) => a + (p.vol24 || 0), 0) || null
    : null;
  const priced = swaps.filter(s => s.volumeUsd != null);
  const vol = priced.reduce((s, x) => s + (x.volumeReal ?? 0), 0);
  const volNominal = priced.reduce((s, x) => s + x.volumeUsd, 0);
  const byPool = new Map();
  for (const s of priced) {
    const key = s.pool ? pairName(s.pool) : `#${s.poolId}`;
    byPool.set(key, (byPool.get(key) || 0) + (s.volumeReal ?? 0));
  }
  // Two different questions: who moved the most value, and who traded the most
  // often. On WAX those are almost never the same account — arbitrage bots
  // dominate the count and barely register on the size.
  const traders = new Map();
  for (const s of priced) {
    const t = traders.get(s.trader) || { usd: 0, n: 0 };
    t.usd += s.volumeReal ?? 0; t.n++;
    traders.set(s.trader, t);
  }
  // Which venues the window actually reached. Alcor is most of WAX, but a feed
  // that says "every trade" while reading one venue is not a feed of every
  // trade — and the cross-venue routes are the interesting ones, since they
  // only exist because two venues disagreed on a price.
  const byVenue = new Map();
  for (const x of swaps) { const d = x.pool?.dex || 'unknown'; byVenue.set(d, (byVenue.get(d) || 0) + 1); }
  const venueLine = [...byVenue].sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `${n.toLocaleString()} on ${venueName[d] || d}`).join(' · ');

  const routes = tradeRoutes(swaps).sort((a, b) => b.n - a.n);
  const cycles = routes.filter(r => r.cycle);
  const multi = routes.filter(r => r.hops > 1);

  $('#actMeta').innerHTML = `${swaps.length.toLocaleString()} swaps over ${actWindow >= 60 ? (actWindow / 60) + ' hours' : actWindow + ' min'} &middot; ${priced.length.toLocaleString()} priceable`
    + (swaps.capped
        ? ` &middot; <span class="neg">the history node returns at most 10,000, so this is the most recent slice of the window</span>`
        : swaps.truncated
          ? ` &middot; <span class="neg">showing the most recent ${swaps.length.toLocaleString()} of ${swaps.reportedTotal.toLocaleString()}</span>`
          : '');

  out.innerHTML = `<div class="stats">
      <div class="stat"><span class="v">${swaps.truncated && venueTotal24 ? usd(venueTotal24) : usd(vol)}</span><span class="k">volume, last ${actWindow >= 60 ? (actWindow / 60) + 'h' : actWindow + ' min'}</span><span class="sub">${
        swaps.truncated && venueTotal24 ? "each venue's own 24h figure" : swaps.truncated ? 'from a partial window' : usd(volNominal) + ' at face value'}</span></div>
      <div class="stat"><span class="v">${swaps.length.toLocaleString()}</span><span class="k">swaps</span><span class="sub">${(swaps.length / actWindow).toFixed(0)} per minute</span></div>
      <div class="stat"><span class="v">${byPool.size}</span><span class="k">pools touched</span><span class="sub">${venueLine}</span></div>
      <div class="stat"><span class="v">${traders.size}</span><span class="k">unique traders</span></div>
      <div class="stat"><span class="v">${routes.length.toLocaleString()}</span><span class="k">distinct routes</span><span class="sub">${cycles.length} of them arbitrage cycles</span></div>
    </div>
    <div class="grid g2" style="margin-bottom:12px">
      <div class="card"><h3>Volume by pool <span class="dim">— share of window</span></h3><div id="actDonut"></div></div>
      <div class="card"><h3>Most active traders <span class="dim">— by volume</span></h3><div id="actBars"></div></div>
    </div>
    <div class="card" style="margin-bottom:12px">
      <h3>Routes traded <span class="dim">&mdash; swaps sharing a transaction are one trade, in order</span></h3>
      <p class="note">${multi.length.toLocaleString()} of these took more than one hop.</p>
      <div id="actRouteCsv" style="margin-bottom:8px"></div>
      <div class="tablewrap"><table><thead><tr>
        <th>Route</th><th class="r">Hops</th><th class="r">Times</th><th class="r">Value in</th><th>Traded by</th><th class="r">Last</th>
      </tr></thead><tbody>${routes.slice(0, cap('routes')).map(r => `
        <tr>
          <td>${r.cycle ? '<span class="badge warn">arb</span> ' : ''}<span class="route">${r.path.map(esc).join('<span class="dim"> &rarr; </span>')}</span></td>
          <td class="r num dim">${r.hops}</td>
          <td class="r num">${r.n.toLocaleString()}</td>
          <td class="r num">${r.priced ? usd(r.usd) : '<span class="dim">&mdash;</span>'}</td>
          <td class="mono">${acctLink(r.top[0][0])}${r.top.length > 1 ? ` <span class="sub">and ${r.top.length - 1} other${r.top.length === 2 ? '' : 's'}</span>` : ' <span class="sub">only</span>'}</td>
          <td class="r num dim">${ago(r.last)}</td>
        </tr>`).join('')}</tbody></table></div>
    </div>
    <div class="tablewrap"><table><thead><tr>
      <th>When</th><th>Pool</th><th>Trader</th><th class="r">In</th><th class="r">Out</th><th class="r">Value</th>
    </tr></thead><tbody>${swaps.slice(0, cap('swaps')).map(s => {
      const inA = s.amountA > 0;
      return `<tr><td class="num dim"><a href="${trxUrl(s.trx)}" target="_blank" rel="noopener" title="Open this transaction on waxblock">${ago(s.ts)} &nearr;</a></td>
        <td${s.pool ? ` class="clickable" data-pool="${esc(s.pool.dex)}:${esc(String(s.pool.id))}"` : ''}>${s.pool ? `<span class="pair">${pairName(s.pool)}</span> <span class="venue ${esc(s.pool.dex)}">${esc(venueName[s.pool.dex] || s.pool.dex)}</span>` : ''} <span class="sub">#${esc(s.poolId)}</span></td>
        <td class="mono">${acctLink(s.trader)}</td>
        <td class="r num">${qty(Math.abs(inA ? s.amountA : s.amountB))} <span class="sub">${esc(inA ? s.symA : s.symB)}</span></td>
        <td class="r num">${qty(Math.abs(inA ? s.amountB : s.amountA))} <span class="sub">${esc(inA ? s.symB : s.symA)}</span></td>
        <td class="r num">${usd(s.volumeReal ?? s.volumeUsd)}</td></tr>`;
    }).join('')}</tbody></table></div>`;

  out.querySelectorAll('td[data-pool]').forEach(td => td.onclick = () => openPool(td.dataset.pool));

  // Both shapes of the same window: the routes as reconstructed, and the raw
  // swaps they were built from, so a reader can check the reconstruction rather
  // than take it on trust.
  $('#actRouteCsv')?.append(
    csvButton(`Export ${routes.length.toLocaleString()} routes`, 'wax-routes', () => routes, [
      { h: 'route', v: r => r.path.join(' > ') },
      { h: 'hops', v: r => r.hops },
      { h: 'pools', v: r => r.pools.join(' ') },
      { h: 'arbitrage_cycle', v: r => (r.cycle ? 'yes' : 'no') },
      { h: 'times', v: r => r.n },
      { h: 'value_in_usd', v: r => (r.priced ? r.usd : null) },
      { h: 'traders', v: r => r.top.length },
      { h: 'top_trader', v: r => r.top[0]?.[0] },
      { h: 'last_seen', v: r => r.last },
      { h: 'sample_trx', v: r => r.sample },
    ]),
    csvButton(`Export ${swaps.length.toLocaleString()} swaps`, 'wax-swaps', () => swaps, [
      { h: 'time', v: x => x.ts },
      { h: 'venue', v: x => x.pool?.dex },
      { h: 'pool_id', v: x => x.poolId },
      { h: 'pair', v: x => (x.pool ? `${x.pool.symA}/${x.pool.symB}` : '') },
      { h: 'trader', v: x => x.trader },
      { h: 'amount_a', v: x => x.amountA }, { h: 'symbol_a', v: x => x.symA },
      { h: 'amount_b', v: x => x.amountB }, { h: 'symbol_b', v: x => x.symB },
      { h: 'value_realisable_usd', v: x => x.volumeReal },
      { h: 'value_face_usd', v: x => x.volumeUsd },
      { h: 'trx', v: x => x.trx },
    ]));
  $('#actDonut').appendChild(donut([...byPool].map(([label, value]) => ({ label, value })), { fmt: usd }));
  $('#actBars').appendChild(bars([...traders].sort((a, b) => b[1].usd - a[1].usd).slice(0, 8)
    .map(([label, t]) => ({ label, value: t.usd, note: `${t.n} trade${t.n === 1 ? '' : 's'}` })), { fmt: usd }));
}

// -------------------------------------------------------- ACCOUNT DETAIL ----
// What one account holds, and what it has been doing.
//
// Reached by clicking any wallet name anywhere in the terminal — a holder, a
// liquidity provider, a trader in the feed. The question "who is that" is the
// one this app was asking readers to answer somewhere else.
let acctGen = 0;
async function openAccount(name) {
  if (!name) return;
  show('account', encodeURIComponent(name));
  const gen = ++acctGen;
  const stale = () => gen !== acctGen;
  const box = $('#accountDetail');

  box.innerHTML = `
    <div class="tokhead">
      <div>
        <h2 class="vt" style="margin:0">${esc(name)} <span id="acctKind"></span></h2>
        <p class="vs" style="margin:2px 0 0">Everything this account holds, priced the same way as the rest of this terminal.</p>
      </div>
      <span style="flex:1"></span>
      <a class="btn ghost" href="https://waxblock.io/account/${esc(name)}" target="_blank" rel="noopener">Explorer &nearr;</a>
      <button class="btn" id="acctLiq">Their liquidity</button>
    </div>
    <div class="stats">
      <div class="stat"><span class="v" id="aTotal">—</span><span class="k">tokens held</span><span class="sub" id="aTotalSub">what a sale could realise</span></div>
      <div class="stat"><span class="v" id="aFace">—</span><span class="k">at face value</span><span class="sub">every balance at its quoted price</span></div>
      <div class="stat"><span class="v" id="aCount">—</span><span class="k">tokens with a balance</span><span class="sub" id="aCountSub">&nbsp;</span></div>
      <div class="stat"><span class="v" id="aCpu">—</span><span class="k">staked for CPU</span><span class="sub" id="aNet">&nbsp;</span></div>
      <div class="stat"><span class="v" id="aRam">—</span><span class="k">RAM</span><span class="sub">bought, not rented</span></div>
    </div>

    <div class="section"><h3>Holdings</h3>
      <div class="card"><div id="aHold"><div class="loading"><span class="spinner"></span><span>Reading balances…</span></div></div></div>
    </div>

    <div class="section"><h3>Recent trades <span class="dim">&mdash; read from the swap memos they signed</span></h3>
      <div class="card"><div id="aSwaps"><div class="loading"><span class="spinner"></span><span>Reading their history…</span></div></div></div>
    </div>

    <div class="section" id="aLiqSec" hidden><h3>Liquidity positions</h3>
      <div class="card"><div id="aLiq"></div></div>
    </div>`;

  $('#acctLiq').onclick = () => { show('wallet'); $('#walletInput').value = name; lookupWallet(name); };

  // ---- balances -----------------------------------------------------------
  accountInfo(name).then(info => {
    if (stale()) return;
    const v = valueBalances(info.balances, state.prices, state.depth);
    const kind = $('#acctKind');
    if (kind && info.isContract) kind.innerHTML = '<span class="venue" title="This account carries code — a balance here is often held for other people">contract</span>';

    const set = (sel, html) => { const e = $(sel); if (e) e.innerHTML = html; };
    set('#aTotal', usd(v.realisable));
    set('#aFace', usd(v.priced));
    set('#aTotalSub', v.priced > v.realisable * 1.05
      ? `${((1 - v.realisable / v.priced) * 100).toFixed(0)}% of the face value has no route out`
      : 'what a sale could realise');
    set('#aCount', info.balances.length.toLocaleString());
    set('#aCountSub', info.zeroed ? `${info.zeroed.toLocaleString()} more sit at zero` : '&nbsp;');
    if (info.resources) {
      set('#aCpu', qty(info.resources.cpu_weight / 1e8) + ' WAX');
      set('#aNet', qty(info.resources.net_weight / 1e8) + ' WAX for NET');
      set('#aRam', (info.resources.ram_bytes / 1024).toFixed(0) + ' KB');
    }

    const box = $('#aHold');
    if (!v.rows.length) { box.innerHTML = '<div class="chart-empty">No token balances.</div>'; return; }
    const known = v.rows.filter(r => r.usd != null);
    const unknown = v.rows.filter(r => r.usd == null);
    box.innerHTML = `<div class="tablewrap" style="max-height:520px;border:0"><table style="font-size:12.5px">
      <thead><tr><th>Token</th><th class="r">Balance</th><th class="r">Price</th><th class="r">Face value</th><th class="r">Realisable</th></tr></thead>
      <tbody>${known.slice(0, cap('tokens')).map(r => `
        <tr class="clickable" data-tokid="${esc(r.id)}">
          <td><span data-pm="${esc(r.id)}|${esc(r.symbol)}"></span><span class="pairbig">${esc(r.symbol)}</span> <span class="sub">${esc(r.contract)}</span></td>
          <td class="r num">${qty(r.amount)}</td>
          <td class="r num dim">${r.price >= 0.01 ? '$' + r.price.toFixed(4) : '$' + r.price.toPrecision(3)}</td>
          <td class="r num">${usd(r.usd)}</td>
          <td class="r num ${r.ratio < 0.5 ? 'dim' : ''}" title="${(r.ratio * 100).toFixed(0)}% of the face value has a route to a bridged dollar">${usd(r.real)}</td>
        </tr>`).join('')}</tbody></table></div>
      <p class="sub" style="margin:9px 0 0">${known.length.toLocaleString()} priced${unknown.length ? `, and ${unknown.length.toLocaleString()} with no pool deep enough to quote &mdash; ${unknown.slice(0, 6).map(r => esc(r.symbol)).join(', ')}${unknown.length > 6 ? '…' : ''}` : ''}.
      ${info.zeroed ? `${info.zeroed.toLocaleString()} balances sit at exactly zero and are left out; most of those are unsolicited airdrops.` : ''}
      Realisable is what a route to a bridged dollar could carry out, which on a thin token is a long way under the quoted price.</p>`;
    fillMarks($('#aHold'));
    box.querySelectorAll('tr[data-tokid]').forEach(tr => tr.onclick = () => openToken(tr.dataset.tokid));
  }).catch(e => {
    if (stale()) return;
    $('#aHold').innerHTML = `<div class="chart-empty">Balances unavailable (${esc(e.message)}).</div>`;
  });

  // ---- their trades -------------------------------------------------------
  accountSwaps(name, { hours: 168 }).then(sw => {
    if (stale()) return;
    const box = $('#aSwaps'); if (!box) return;
    if (!sw.length) { box.innerHTML = '<div class="chart-empty">No swaps signed by this account in the last week.</div>'; return; }
    const byId = new Map();
    for (const p of state.pools) if (p.dex === 'alcor') byId.set(String(p.id), p);
    const poolName = id => { const p = byId.get(String(id)); return p ? `${p.symA}/${p.symB}` : `#${id}`; };
    box.innerHTML = `<div class="tablewrap" style="max-height:420px;border:0"><table style="font-size:12px">
      <thead><tr><th>When</th><th class="r">Sent</th><th>Route</th><th>Venue</th></tr></thead>
      <tbody>${sw.slice(0, cap('swaps')).map(x => `<tr>
        <td class="num dim"><a href="${trxUrl(x.trx)}" target="_blank" rel="noopener" title="Open this transaction on waxblock">${ago(new Date(x.ts).toISOString())} &nearr;</a></td>
        <td class="r num">${qty(x.amount)} <span class="sub">${esc(x.symbol)}</span></td>
        <td><span class="route">${x.route.map(poolName).map(esc).join('<span class="dim"> &rarr; </span>')}</span></td>
        <td class="dim">${esc(venueName[({ 'swap.alcor': 'alcor', 'swap.taco': 'taco', 'swap.box': 'defibox', 'swap.adex': 'adex' })[x.venue]] || x.venue)}</td>
      </tr>`).join('')}</tbody></table></div>
      <p class="sub" style="margin:9px 0 0">${sw.length.toLocaleString()} swaps in the last week, newest first. Read from the transfers this account signed &mdash; the memo names every pool the route crossed. Each row opens the transaction on waxblock.</p>`;
  }).catch(() => { const b = $('#aSwaps'); if (b) b.innerHTML = '<div class="chart-empty">Trade history unavailable.</div>'; });
}

// ---------------------------------------------------------- ORDER BOOK -----
// The half of Alcor this terminal was ignoring. Showing only AMM pools and
// calling that "the market" leaves out every resting bid and every seller
// waiting above the pool price — which on a thin token is most of it.
//
// A limit order is a transfer whose memo names what you want back, so placing
// one is a button here rather than a memo to assemble by hand.
async function renderOrderBook(boxId, tokenId, symbol) {
  const box = $(boxId);
  if (!box) return;
  const WAX = 'WAX@eosio.token';
  if (tokenId === WAX) { box.closest('.section')?.remove(); return; }

  let market, b;
  try {
    market = await marketFor(WAX, tokenId);
    if (!market) { box.innerHTML = `<div class="chart-empty">No order book for ${esc(symbol)} — it trades in pools only.</div>`; return; }
    b = await book(market.id);
  } catch { box.innerHTML = '<div class="chart-empty">Order book unavailable.</div>'; return; }

  if (!b.bid.length && !b.ask.length) {
    box.innerHTML = `<div class="chart-empty">The ${esc(symbol)}/WAX book exists but is empty — nobody has an order resting.</div>`;
    return;
  }

  // Depth is cumulative from the best price outward, which is what "how much
  // can I fill" actually asks. A bar per level makes the wall visible.
  const cum = rows => { let t = 0; return rows.map(o => ({ ...o, cum: (t += o.quote) })); };
  const bids = cum(b.bid.slice(0, 12)), asks = cum(b.ask.slice(0, 12));
  const most = Math.max(bids.at(-1)?.cum || 0, asks.at(-1)?.cum || 0, 1);
  const side = (rows, cls) => rows.map(o => `
    <tr class="obrow">
      <td class="obbar"><span class="${cls}" style="width:${(o.cum / most * 100).toFixed(1)}%"></span></td>
      <td class="r num ${cls === 'obbid' ? 'pos' : 'neg'}">${qty(o.price)}</td>
      <td class="r num">${qty(o.quote)}</td>
      <td class="mono dim">${acctLink(o.account)}</td>
    </tr>`).join('');

  box.innerHTML = `
    <div class="stats" style="margin:0 0 12px">
      <div class="stat"><span class="v">${b.best.bid != null ? qty(b.best.bid) : '—'}</span><span class="k">best bid</span><span class="sub">WAX per ${esc(symbol)}</span></div>
      <div class="stat"><span class="v">${b.best.ask != null ? qty(b.best.ask) : '—'}</span><span class="k">best ask</span><span class="sub">${b.spread != null ? (b.spread * 100).toFixed(2) + '% spread' : 'one side only'}</span></div>
      <div class="stat"><span class="v">${(b.bid.length + b.ask.length).toLocaleString()}</span><span class="k">resting orders</span><span class="sub">${b.bid.length} bids, ${b.ask.length} asks</span></div>
    </div>
    <div class="grid g2">
      <div><h4 class="obhead pos">Bids &mdash; buyers waiting</h4>
        <div class="tablewrap" style="max-height:300px;border:0"><table style="font-size:12px">
          <thead><tr><th></th><th class="r">Price</th><th class="r">${esc(symbol)}</th><th>Who</th></tr></thead>
          <tbody>${side(bids, 'obbid') || '<tr><td colspan="4" class="dim">nobody bidding</td></tr>'}</tbody></table></div></div>
      <div><h4 class="obhead neg">Asks &mdash; sellers waiting</h4>
        <div class="tablewrap" style="max-height:300px;border:0"><table style="font-size:12px">
          <thead><tr><th></th><th class="r">Price</th><th class="r">${esc(symbol)}</th><th>Who</th></tr></thead>
          <tbody>${side(asks, 'obask') || '<tr><td colspan="4" class="dim">nobody selling</td></tr>'}</tbody></table></div></div>
    </div>

    <div class="card" style="margin-top:12px;background:var(--surface-2)"><h3>Place an order</h3>
      <div class="toolbar" style="margin:0">
        <button class="chip" id="obBuy" aria-pressed="true">Buy ${esc(symbol)}</button>
        <button class="chip" id="obSell">Sell ${esc(symbol)}</button>
      </div>
      <div class="filters" style="display:grid;gap:8px;margin:10px 0 0">
        <label>Amount of ${esc(symbol)}<input id="obAmt" type="number" step="any" min="0" placeholder="0" inputmode="decimal"></label>
        <label>Price in WAX each<input id="obPrice" type="number" step="any" min="0" placeholder="${b.best.bid != null ? qty(b.best.bid) : '0'}" inputmode="decimal"></label>
      </div>
      <p class="sub" id="obNote" style="margin:9px 0 0"></p>
      <div id="obOut" style="margin-top:10px"></div>
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="obGo">Review</button></div>
    </div>
    <p class="sub" style="margin:10px 0 0">An order rests until someone takes it or you cancel it, and it fills at your price rather than at whatever the pool happens to be.
    That is the trade against swapping: you choose the price, and you wait. Market #${market.id}${market.feeBps ? `, ${(market.feeBps / 100).toFixed(2)}% fee` : ', no fee'}.</p>`;

  let buying = true;
  const tok = state.tokens.get(tokenId) || { symbol, contract: tokenId.split('@')[1], decimals: 8 };
  const waxTok = state.tokens.get(WAX) || { symbol: 'WAX', contract: 'eosio.token', decimals: 8 };
  const note = $('#obNote');
  const paint = () => {
    const amt = Number($('#obAmt').value) || 0, px = Number($('#obPrice').value) || 0;
    const total = amt * px;
    note.innerHTML = !(amt > 0 && px > 0)
      ? `Best bid ${b.best.bid != null ? qty(b.best.bid) : '—'}, best ask ${b.best.ask != null ? qty(b.best.ask) : '—'} WAX. Buying below the best ask, or selling above the best bid, means waiting.`
      : buying
        ? `Offer <b>${qty(total)} WAX</b> for <b>${qty(amt)} ${esc(symbol)}</b>${b.best.ask != null && px >= b.best.ask ? ' — at or above the best ask, so it should fill immediately' : ' — rests until someone sells into it'}.`
        : `Offer <b>${qty(amt)} ${esc(symbol)}</b> for <b>${qty(total)} WAX</b>${b.best.bid != null && px <= b.best.bid ? ' — at or below the best bid, so it should fill immediately' : ' — rests until someone buys it'}.`;
  };
  paint();
  $('#obAmt').oninput = paint; $('#obPrice').oninput = paint;
  $('#obBuy').onclick = () => { buying = true; $('#obBuy').setAttribute('aria-pressed', 'true'); $('#obSell').setAttribute('aria-pressed', 'false'); paint(); };
  $('#obSell').onclick = () => { buying = false; $('#obSell').setAttribute('aria-pressed', 'true'); $('#obBuy').setAttribute('aria-pressed', 'false'); paint(); };

  $('#obGo').onclick = async () => {
    const out = $('#obOut');
    const amt = Number($('#obAmt').value) || 0, px = Number($('#obPrice').value) || 0;
    if (!(amt > 0) || !(px > 0)) { out.innerHTML = '<div class="err">Enter an amount and a price.</div>'; return; }
    if (!wallet.account()) { try { await wallet.connect(); } catch { return; } }
    const total = amt * px;
    const built = buying
      ? buildLimitOrder({ give: { ...waxTok, amount: total }, want: { ...tok, amount: amt }, me: wallet.account() })
      : buildLimitOrder({ give: { ...tok, amount: amt }, want: { ...waxTok, amount: total }, me: wallet.account() });
    out.innerHTML = `<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">
      ${buying ? `Send <b>${qty(total)} WAX</b> and ask for <b>${qty(amt)} ${esc(symbol)}</b>` : `Send <b>${qty(amt)} ${esc(symbol)}</b> and ask for <b>${qty(total)} WAX</b>`}, at ${qty(px)} WAX each.
      <br><span class="dim">The order rests on chain until it fills or you cancel it. What you send leaves your wallet now and comes back as the other token, or as itself if you cancel.</span>
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="obSign">Sign and place</button></div></div>`;
    $('#obSign').onclick = async () => {
      out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
      try {
        const tx = await wallet.transact(built.actions);
        out.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)"><b>Placed.</b> It rests until filled or cancelled — your open orders are on My wallet.
          <br><a class="mono" style="font-size:11px" href="${trxUrl(tx.id)}" target="_blank" rel="noopener">${tx.id.slice(0, 16)}… &nearr;</a></div>`;
      } catch (e) { out.innerHTML = txError(e); }
    };
  };
}

// ---------------------------------------------------------- TOKEN DETAIL ----
// Everything the chain will say about one token, on one page.
//
// Nothing is awaited before the page paints. The first version read the token's
// supply first and only then started the price chart, the liquidity providers
// and the trade feed — so a slow `stat` read held up work that never depended
// on it. Each card now goes and gets its own answer, and says what it is doing
// while it waits.
let tokenGen = 0;
async function openToken(id) {
  const rows = tokRows || tokenTable();
  const t = rows.find(x => x.id === id);
  show('token', encodeURIComponent(id));
  // A shared link can name a token this terminal has never seen — one whose
  // pools all emptied, or one that never had any. Landing on a silently blank
  // page is worse than being told which token was asked for and why it is not
  // here, so say it rather than returning into nothing.
  if (!t) {
    const [sym, contract] = id.split('@');
    $('#tokenDetail').innerHTML = `<div class="card"><h3>${esc(sym || id)}</h3>
      <p class="sub" style="margin:8px 0 0">Nothing on ${esc(contract || 'that contract')} holds liquidity on Alcor, TacoSwap, Defibox or A-DEX right now,
      so there is no price, no depth and no trade history to show. A token appears here as soon as one pool holds it.</p>
      <p class="sub" style="margin:8px 0 0"><a href="https://waxblock.io/tokens/${esc(contract || '')}/${esc(sym || '')}" target="_blank" rel="noopener">Look it up on waxblock &nearr;</a></p></div>`;
    return;
  }

  // Opening a second token before the first has finished loading would let the
  // first one's answers land in the second one's cards — every card here fills
  // in on its own schedule and looks its element up by id, which the next token
  // reuses. Each handler checks that it is still the page being looked at.
  const gen = ++tokenGen;
  const stale = () => gen !== tokenGen;

  const d = state.depth.get(id);
  const meta = tokenMeta(id);
  const pools = state.pools.filter(p => (p.tokenA === id || p.tokenB === id) && p.tvl > 0)
    .sort((a, b) => (b.tvl || 0) - (a.tvl || 0));
  // Trades are read back out of each venue's own state table. All four keep
  // one, so all four can be replayed.
  //
  // Ordered by volume, not by size. CHEESE's largest pool by pooled value is
  // CHEESE/WAXWBTC, where nothing trades; its price and its trades both live in
  // CHEESE/WAX. A chart drawn on the biggest pool is a chart of a pool, not of
  // the token.
  const tradePools = pools.filter(p => TRADE_VENUES.has(p.dex) && (p.dex !== 'alcor' || p.sqrtX64))
    .sort((a, b) => (b.vol24 || 0) - (a.vol24 || 0) || (b.tvl || 0) - (a.tvl || 0));
  const deepest = tradePools[0] || null;
  const farms = farmGroups().filter(g => g.pool && (g.pool.tokenA === id || g.pool.tokenB === id));
  const venues = [...t.venues];

  const priceStr = t.price == null ? '—'
    : '$' + (t.price >= 0.01 ? t.price.toFixed(4) : t.price.toPrecision(3));
  // Everyone here holds WAX and prices things against it, so the dollar alone
  // makes people do arithmetic they should not have to.
  const inWax = (t.price != null && state.waxUsd > 0 && t.symbol !== 'WAX')
    ? t.price / state.waxUsd : null;

  $('#tokenDetail').innerHTML = `
    <div class="tokhead">
      <span id="tokMark"></span>
      <div>
        <h2 class="vt" style="margin:0">${esc(t.symbol)} ${trustChip(id)}</h2>
        <p class="vs" style="margin:2px 0 0">${esc(t.contract)}${t.bornAt ? ` &middot; first pooled ${age(t.bornAt)} ago` : ''}</p>
      </div>
      <span style="flex:1"></span>
      <span id="tokStar"></span>
      <a class="btn ghost" href="https://waxblock.io/tokens/${esc(t.contract)}/${esc(t.symbol)}" target="_blank" rel="noopener">Contract &nearr;</a>
      ${deepest ? `<a class="btn" href="${swapUrl(deepest)}" target="_blank" rel="noopener">Trade ${esc(t.symbol)} &nearr;</a>` : ''}
    </div>

    <div class="stats" id="tokStats">
      <div class="stat"><span class="v">${priceStr}</span><span class="k">price</span>${(() => {
        // The change comes from the deepest pool that reports one. A thin
        // pool's 24h move is noise, so it is taken from where the trading is.
        const src = pools.filter(p => p.change24 != null && p.vol24 > 0).sort((a, b) => (b.vol24 || 0) - (a.vol24 || 0))[0];
        if (!src) return '<span class="sub">&nbsp;</span>';
        const ch = src.tokenB === id ? -src.change24 : src.change24;   // quoted on A
        return `<span class="sub ${ch > 0 ? 'pos' : ch < 0 ? 'neg' : ''}">${ch > 0 ? '+' : ''}${ch.toFixed(1)}% in 24h${inWax != null ? ` &middot; ${qty(inWax)} WAX` : ''}</span>`;
      })()}${(() => {
        const src = pools.filter(p => p.change24 != null && p.vol24 > 0).sort((a, b) => (b.vol24 || 0) - (a.vol24 || 0))[0];
        return (!src && inWax != null) ? `<span class="sub">${qty(inWax)} WAX</span>` : '';
      })()}</div>
      <div class="stat"><span class="v" id="tokCap">—</span><span class="k">market cap</span><span class="sub" id="tokCapSub">circulating &times; price</span></div>
      <div class="stat"><span class="v" id="tokCirc">—</span><span class="k">circulating</span><span class="sub" id="tokBurn">&nbsp;</span></div>
      <div class="stat"><span class="v" id="tokHolderN">—</span><span class="k">holders</span><span class="sub" id="tokHolderSub">accounts with a balance</span></div>
      <div class="stat"><span class="v">${usd(t.tvl)}</span><span class="k">pooled</span><span class="sub">${t.pools} pool${t.pools === 1 ? '' : 's'} on ${venues.length} venue${venues.length === 1 ? '' : 's'}</span></div>
      <div class="stat"><span class="v" id="tokVol">${t.vol24 > 0 ? usd(t.vol24) : '<span class="dim">measuring…</span>'}</span><span class="k">traded 24h</span><span class="sub" id="tokVolSub">${t.vol24 > 0 ? 'across every venue' : '&nbsp;'}</span></div>
      <div class="stat"><span class="v">${t.depth1 > 0 ? usd(t.depth1) : '—'}</span><span class="k">trade depth</span><span class="sub">before moving price 1%</span></div>
    </div>

    <div class="section"><h3>The token itself</h3>
      <div class="grid g2">
        <div class="card"><dl class="facts" id="tokFacts">
          <dt>Contract</dt><dd class="mono">${esc(t.contract)}</dd>
          <dt>Symbol</dt><dd class="mono">${esc(t.symbol)}</dd>
          <dt>Decimals</dt><dd class="mono" id="fDec">—</dd>
          <dt>Issued by</dt><dd class="mono" id="fIssuer">—</dd>
          <dt>Total supply</dt><dd class="mono" id="fSupply">—</dd>
          <dt>Maximum ever</dt><dd class="mono" id="fMax">—</dd>
          <dt>Still mintable</dt><dd class="mono" id="fMint">—</dd>
          <dt>Burned</dt><dd class="mono" id="fBurned">—</dd>
          <dt>Circulating</dt><dd class="mono" id="fCirc">—</dd>
          <dt>Holders</dt><dd class="mono" id="fHolders">—</dd>
          <dt>Value in pools</dt><dd class="mono">${usd(t.tvl)}</dd>
          <dt>Rated by Alcor</dt><dd class="mono">${meta?.score != null ? `${meta.score}/100` : '<span class="dim">not rated</span>'}</dd>
        </dl></div>
        <div class="card"><h3>Transfer tax</h3><div id="tokTax"><div class="loading"><span class="spinner"></span><span>Reading the contract&rsquo;s tables…</span></div></div></div>
      </div>
    </div>

    ${deepest ? `<div class="section"><h3>Price</h3>
      <div class="card"><h3><span id="tokPair">${esc(deepest.symA)}/${esc(deepest.symB)}</span> <span class="dim">&mdash; rebuilt from pool state changes</span>
        <span style="margin-left:auto;display:flex;gap:4px">
          <button class="chip" id="tokFlip" title="Show the price the other way round">&#8646;</button>
          ${intervalChips('tokPrice')}
        </span></h3>
        <div id="tokChart"><div class="loading"><span class="spinner"></span><span>Replaying the pool…</span></div></div></div>
    </div>` : ''}

    ${tradePools.length ? `<div class="section"><h3>Trading</h3>
      <div class="card"><h3>Volume, hour by hour <span class="dim">&mdash; each trade sized from the pool it moved</span>
        <span style="margin-left:auto;display:flex;gap:4px">${intervalChips('tokVol', 3600, { skip: [300] })}</span></h3>
        <div id="tokVolChart"><div class="loading"><span class="spinner"></span><span>Reading trades out of the pool rows…</span></div></div>
        <p class="sub" id="tokVolNote" style="margin:10px 0 0">&nbsp;</p></div>
      <div class="grid g2">
        <div class="card"><h3>Trades <span class="dim">&mdash; newest first, read out of the pool rows</span></h3>
          <div id="tokTape"><div class="loading"><span class="spinner"></span><span>Building the tape…</span></div></div></div>
        <div class="card"><h3>Who trades it <span class="dim">&mdash; and the route they took</span></h3>
          <div id="tokTraders"><div class="loading"><span class="spinner"></span><span>Reading swap memos…</span></div></div></div>
      </div>
    </div>` : `<div class="section"><h3>Trading</h3>
      <div class="card"><p class="sub" style="margin:0">No pool holding ${esc(t.symbol)} keeps state a history node will replay, so there is no price chart and no trade history here.
      Trades are reconstructed from each venue's own table rather than from a trade index, which is the only way to do it from a browser &mdash; and it needs a table to read.</p></div>
    </div>`}

    <div class="section"><h3>Order book <span class="dim">&mdash; limit orders resting against ${esc(t.symbol)}/WAX, which the pools do not show</span></h3>
      <div class="card"><div id="tokBook"><div class="loading"><span class="spinner"></span><span>Reading the book…</span></div></div></div>
    </div>

    <div class="section"><h3>Ownership</h3>
      <div class="grid g2">
        <div class="card"><h3>Largest holders <span class="dim">&mdash; wallet plus what they hold inside pools</span></h3>
          <div id="tokHolders"><div class="loading"><span class="spinner"></span><span>Reading holders…</span></div></div></div>
        <div class="card"><h3>Holder map <span class="dim">&mdash; lines mean they have moved ${esc(t.symbol)} to each other</span></h3>
          <div id="tokBubbles"><div class="loading"><span class="spinner"></span><span>Tracing transfers…</span></div></div></div>
      </div>
    </div>

    <div class="section"><h3>Where the supply sits</h3>
      <div class="grid g2">
        <div class="card"><h3>Share of supply</h3><div id="tokDist"><div class="loading"><span class="spinner"></span><span>Waiting on holders…</span></div></div></div>
        <div class="card"><h3>Movement <span class="dim">&mdash; transfers, which is not the same question as trades</span></h3>
          <div id="tokMoves"><div class="loading"><span class="spinner"></span><span>Reading transfers…</span></div></div></div>
      </div>
    </div>

    <div class="section"><h3>Liquidity</h3>
      <div class="grid g2">
        <div class="card"><h3>Biggest liquidity providers <span class="dim">&mdash; ${esc(t.symbol)} supplied to pools</span></h3>
          <div id="tokLps"><div class="loading"><span class="spinner"></span><span>Reading positions…</span></div></div></div>
        <div class="card"><h3>Where it trades</h3><div id="tokPools"></div>
          <p class="sub" style="margin:10px 0 0">${d?.topPartner
            ? `${(d.topPartner.share * 100).toFixed(0)}% of the value standing opposite ${esc(t.symbol)} is ${esc(d.topPartner.token.split('@')[0])}.`
              + (d.sameIssuerShare > 0.2 ? ` ${(d.sameIssuerShare * 100).toFixed(0)}% of it comes from tokens issued by the same account, so its depth leans on one issuer.` : '')
            : ''}</p></div>
      </div>
    </div>

    ${farms.length ? `<div class="section"><h3>Farms paying or holding ${esc(t.symbol)}</h3>
      <div class="card"><div id="tokFarms"></div></div></div>` : ''}

    <div class="section"><h3>Tracked over time</h3>
      <div class="card"><h3>Pooled value and daily volume <span class="dim">&mdash; one point per day from the snapshot job</span></h3>
        <div id="tokHist"><div class="loading"><span class="spinner"></span><span>Reading the record…</span></div></div></div>
    </div>
    ${promoteBox('t', id, t.symbol)}`;

  $('#tokMark')?.appendChild(tokenMark(id, t.symbol, { size: 34 }));
  wirePromote();
  renderOrderBook('#tokBook', id, t.symbol).catch(() => {});
  $('#tokStar')?.appendChild(watchStar('t', id, t.symbol));

  // ---- where it trades -----------------------------------------------------
  // A table rather than bars: two pools on the same pair are common on Alcor and
  // differ only by fee tier, so a bar labelled with the pair alone draws the
  // same row twice — and neither of them is clickable.
  $('#tokPools').innerHTML = `<div class="tablewrap" style="max-height:320px;border:0"><table style="font-size:12.5px">
    <thead><tr><th>Pool</th><th>Venue</th><th class="r">Fee</th><th class="r">Pooled</th><th class="r">24h</th></tr></thead>
    <tbody>${pools.slice(0, cap('pools')).map(p => `
      <tr data-pool="${esc(p.dex)}:${esc(String(p.id))}" style="cursor:pointer">
        <td>${esc(p.symA)}/${esc(p.symB)}</td>
        <td class="dim">${esc(p.dex)}</td>
        <td class="r num dim">${(p.feeBps / 100).toFixed(2)}%</td>
        <td class="r num" title="${usd(p.tvl)} at face value">${usd(p.tvlReal)}</td>
        <td class="r num ${p.vol24 > 0 ? '' : 'dim'}">${p.vol24 > 0 ? usd(p.vol24) : '—'}</td>
      </tr>`).join('')}</tbody></table></div>`;
  $('#tokPools').querySelectorAll('tr[data-pool]').forEach(tr => tr.onclick = () => openPool(tr.dataset.pool));

  if (farms.length) {
    $('#tokFarms').innerHTML = `<div class="tablewrap" style="max-height:none;border:0"><table style="font-size:12.5px">
      <thead><tr><th>Pool</th><th>Pays</th><th class="r">Per day</th><th class="r">Staked</th><th class="r">APR</th><th>Trend</th><th class="r">Runway</th></tr></thead>
      <tbody>${farms.slice(0, cap('farms')).sort((a, b) => (b.rewardRealDay || 0) - (a.rewardRealDay || 0)).map(g => `
        <tr data-fpool="${esc(g.key)}" style="cursor:pointer">
          <td>${g.pool ? `${esc(g.pool.symA)}/${esc(g.pool.symB)} <span class="dim">${(g.pool.feeBps / 100).toFixed(2)}%</span>` : esc(g.poolId)}</td>
          <td>${[...new Set(g.rewards.map(r => r.symbol))].slice(0, 4).map(esc).join(', ')}</td>
          <td class="r num">${usd(g.rewardRealDay)}</td>
          <td class="r num">${g.stakedReal != null ? usd(g.stakedReal) : '<span class="dim">—</span>'}</td>
          <td class="r num">${g.aprReal != null ? pct(g.aprReal) : '<span class="dim">—</span>'}</td>
          <td data-apr="${esc(g.key)}"><span class="dim">…</span></td>
          <td class="r num dim">${g.runwayDays != null && isFinite(g.runwayDays) ? Math.round(g.runwayDays) + 'd' : '—'}</td>
        </tr>`).join('')}</tbody></table></div>`;
    $('#tokFarms').querySelectorAll('tr[data-fpool]').forEach(tr => tr.onclick = () => openPool(tr.dataset.fpool));
  }

  // ---- decimals, straight off the row we already have ----------------------
  const decs = state.tokens.get(id)?.decimals;
  if (decs != null) $('#fDec').textContent = String(decs);

  // ---- transfer tax --------------------------------------------------------
  tokenTax(t.contract, t.symbol).then(tax => {
    if (stale()) return;
    const el = $('#tokTax');
    if (!el) return;
    const venueBps = t.venueTaxBps || 0;
    if (!tax.bps) {
      // Absence of evidence. Some contracts hold the rate in code rather than
      // in a readable table, so this cannot promise there is none.
      el.innerHTML = `<p class="sub" style="margin:0">Nothing found in this contract&rsquo;s tables. That is not a guarantee &mdash; a rate held in code rather than in a table is invisible from outside, so a swap that comes back short is still worth believing over this line.</p>`;
      return;
    }
    const burn = tax.parts.filter(x => x.to === 'eosio.null').reduce((a, x) => a + x.bps, 0);
    el.innerHTML = `<div class="stat" style="padding:0 0 10px"><span class="v neg">${(tax.bps / 100).toFixed(2)}%</span><span class="k">taken from every transfer</span></div>
      <dl class="facts">${tax.parts.map(x => `<dt>${(x.bps / 100).toFixed(2)}% to</dt><dd class="mono">${esc(x.to)}${x.to === 'eosio.null' ? ' <span class="dim">burned</span>' : ''}</dd>`).join('')}
        <dt>Read from</dt><dd class="mono dim">${esc(tax.source)}</dd>
        <dt>Paid to a DEX</dt><dd>${venueBps > 0
          ? `<b class="neg">${(venueBps / 100).toFixed(2)}%</b> <span class="dim">&mdash; measured on a real deposit into swap.alcor</span>`
          : '<span class="ok">exempt</span> <span class="dim">&mdash; a real deposit into swap.alcor paid nothing, whatever the table says</span>'}</dd>
      </dl>
      <p class="sub" style="margin:10px 0 0">${burn > 0 ? `The ${(burn / 100).toFixed(2)}% sent to eosio.null is destroyed, so supply falls with every send. ` : ''}A swap route pays this at every hop that moves the token between accounts.</p>`;
  }).catch(() => { const el = $('#tokTax'); if (el) el.innerHTML = '<div class="chart-empty">Could not read the contract.</div>'; });

  // ---- supply, burn, market cap -------------------------------------------
  // Kicked off, not awaited: the holder table and the distribution donut need
  // the supply to turn balances into percentages, so they wait on this promise
  // rather than on this line.
  const statsP = tokenStats(t.contract, t.symbol).catch(() => null);
  statsP.then(stats => {
    if (stale()) return;
    if (!stats) return;
    const set = (sel, html) => { const e = $(sel); if (e) e.innerHTML = html; };
    set('#fSupply', qty(stats.supply));
    set('#fMax', qty(stats.maxSupply));
    set('#fMint', stats.maxSupply > stats.supply
      ? `<b class="warnish">${qty(stats.maxSupply - stats.supply)} more</b> <span class="dim">the issuer can still create</span>`
      : '<span class="ok">no</span> <span class="dim">— the whole maximum is already issued</span>');
    set('#fBurned', stats.burned > 0
      ? `${qty(stats.burned)} <span class="dim">(${(stats.burned / stats.supply * 100).toFixed(2)}% of supply)</span>`
      : '<span class="dim">none</span>');
    set('#fCirc', qty(stats.circulating));
    set('#fIssuer', esc(stats.issuer || '—'));
    set('#tokCirc', qty(stats.circulating));
    set('#tokBurn', stats.burned > 0
      ? `${qty(stats.burned)} burned <span class="dim">(${(stats.burned / stats.supply * 100).toFixed(2)}%)</span>`
      : `of ${qty(stats.maxSupply)} ever`);
    if (t.price != null) {
      set('#tokCap', usd(stats.circulating * t.price));
      set('#tokCapSub', `${(t.tvl / (stats.circulating * t.price) * 100).toFixed(1)}% of it is pooled`);
    }
  });

  // ---- how many hold it at all --------------------------------------------
  let holderTotal = null;
  holderCount(t.contract, t.symbol).then(n => {
    if (stale()) return;
    if (n == null) return;
    holderTotal = n;
    const e = $('#tokHolderN'); if (e) e.textContent = n.toLocaleString();
    const f = $('#fHolders'); if (f) f.textContent = n.toLocaleString();
    const s = $('#tokHolderSub');
    if (s) s.textContent = n < 100 ? 'a small, easily-moved holder base' : 'accounts with a balance';
  }).catch(() => {
    const e = $('#tokHolderN'); if (e) e.innerHTML = '<span class="dim">—</span>';
    const f = $('#fHolders'); if (f) f.innerHTML = '<span class="dim">holder index unavailable</span>';
  });

  // ---- the pools, replayed once ------------------------------------------
  // One read serves both the candles and the trade tape. They ask the same
  // question of the same rows, and this page runs on the reader's own IP —
  // fetching the deepest pool twice is a cost paid by whoever opened it.
  const use = tradePools.slice(0, cap('tokenPools'));
  // Three pages, not six. A quiet pool returns everything it has either way —
  // paging stops as soon as a page comes back short — and a busy one gives
  // 3,000 states, which is weeks of history against a chart that offers seven
  // days. Six pages doubled the download for nothing, and this page is paid for
  // by whoever opened it.
  const deltasP = use.length
    ? Promise.all(use.map(p => venueDeltas(p, { pages: 3 })
        .then(rws => ({ pool: p, rows: rws }))
        .catch(() => ({ pool: p, rows: [] }))))
    : Promise.resolve([]);

  // ---- price chart ---------------------------------------------------------
  if (deepest) {
    let iv = 3600, flipped = false, busy = false;
    const draw = async () => {
      const box = $('#tokChart');
      if (!box || busy) return;
      busy = true;
      try {
        const got = await candlesFor(deepest, iv,
          d => { box.innerHTML = `<div class="loading"><span class="spinner"></span><span>Reading ${d} of this pool…</span></div>`; });
        if (stale()) return;
        if (!got.candles.length) { box.innerHTML = '<div class="chart-empty">No price history for this pool.</div>'; return; }
        const shown = flipped ? invertCandles(got.candles) : got.candles;
        const pair = $('#tokPair');
        if (pair) pair.textContent = flipped ? `${deepest.symB}/${deepest.symA}` : `${deepest.symA}/${deepest.symB}`;
        await candleChart(box, shown, { height: 280, precision: precisionFor(shown.at(-1)?.close) })
          .catch(() => { box.innerHTML = '<div class="chart-empty">Chart unavailable.</div>'; });
        const note = box.nextElementSibling?.classList?.contains('chartspan') ? box.nextElementSibling : (() => {
          const n = document.createElement('p'); n.className = 'sub chartspan'; n.style.marginTop = '8px'; box.after(n); return n;
        })();
        note.textContent = `${shown.length.toLocaleString()} candles, back to ${new Date(shown[0].time * 1000).toISOString().slice(0, 10)}`
          + (got.source === 'alcor' ? ' — the whole life of the pool, from Alcor.' : ' — rebuilt from pool state changes, which the history node only keeps so far back.');
      } finally { busy = false; }
    };
    draw();
    wireIntervals('tokPrice', v => { iv = v; draw(); });
    const flip = $('#tokFlip');
    if (flip) flip.onclick = () => { flipped = !flipped; flip.setAttribute('aria-pressed', String(flipped)); draw(); };
  }

  // ---- trades, read back out of the pool rows ------------------------------
  // Hyperion will not filter logswap by pool, so asking it for one token's
  // trades means reading every swap on WAX. The old page did that for three
  // pages and then said "no trades in the last six hours" — a claim it had no
  // way to make, since three pages of a live firehose is about twenty minutes.
  // Replaying each pool's own row is both cheaper and actually complete: the
  // deepest CHEESE/HOLE pool gives back forty-five days of trades in six calls.
  if (tradePools.length) {
    deltasP.then(raw => {
      if (stale()) return;
      const sets = raw.map(({ pool, rows }) => ({ pool, swaps: swapsFromDeltas(rows) }));
      const legs = [];
      for (const { pool, swaps } of sets) {
        const isA = pool.tokenA === id;
        const px = isA ? pool.priceUsdA : pool.priceUsdB;
        for (const s of swaps) {
          const amt = isA ? s.amountA : s.amountB;         // signed, in this token
          legs.push({
            ts: s.ts, block: s.block, pool, price: s.price,
            amount: Math.abs(amt), signed: amt,
            // The sign is the pool's: it gained the token, so someone sold it.
            side: amt > 0 ? 'sold' : 'bought',
            usd: px != null ? Math.abs(amt) * px : null,
          });
        }
      }

      // A route through two of this token's pools writes both rows in the same
      // block, and listing them separately says a trade happened twice and
      // doubles the volume with it — the same mistake as summing every hop of a
      // multi-hop swap. One block is one decision: the legs are folded into it,
      // and the trade is worth its largest leg rather than their sum.
      //
      // Two unrelated traders landing in one block would be merged by this. On a
      // token with four pools that is rare, and undercounting a coincidence is a
      // far smaller error than double-counting every route.
      const byBlock = new Map();
      for (const l of legs) {
        // A missing block number must not collapse every leg into one row, so
        // it falls back to a key that is unique per leg instead.
        const key = l.block ?? `t${l.ts}:${l.pool.id}`;
        if (!byBlock.has(key)) byBlock.set(key, []);
        byBlock.get(key).push(l);
      }
      const all = [...byBlock.values()].map(g => {
        const biggest = g.reduce((m, l) => (l.amount > m.amount ? l : m), g[0]);
        const net = g.reduce((a, l) => a + l.signed, 0);
        return {
          ts: g[0].ts, block: g[0].block, legs: g,
          pools: [...new Set(g.map(l => `${l.pool.symA}/${l.pool.symB}`))],
          amount: biggest.amount,
          usd: g.reduce((m, l) => Math.max(m, l.usd ?? 0), 0) || null,
          // A route that hands the token straight on nets out near zero: it
          // passed through rather than being bought or sold.
          side: g.length > 1 && Math.abs(net) < biggest.amount * 0.02 ? 'through'
            : net > 0 ? 'sold' : 'bought',
        };
      }).sort((a, b) => b.ts - a.ts);
      // How far back the page can honestly speak for is the *shallowest* pool,
      // not the deepest. One pool reaching forty-five days while another reaches
      // three does not make the token covered for forty-five: before the newest
      // of those two starting points, the picture has a hole in it.
      const oldest = sets.filter(x => x.swaps.length).length
        ? Math.max(...sets.filter(x => x.swaps.length).map(x => x.swaps[0].ts))
        : Date.now();

      let volChart = null;
      // The bucket is what you pick; the window follows it. Sixty buckets is
      // enough to see a shape and few enough that each one is still a bar
      // rather than a hair — 15 hours at fifteen minutes, sixty days at a day.
      const drawVol = bucketSec => {
        const box = $('#tokVolChart'); if (!box) return;
        const since = Date.now() - bucketSec * 60 * 1000;
        const win = all.filter(s => s.ts >= since);
        const buckets = new Map();
        for (const s of win) {
          const key = Math.floor(s.ts / 1000 / bucketSec) * bucketSec;
          let c = buckets.get(key);
          if (!c) { c = { time: key, usd: 0, n: 0 }; buckets.set(key, c); }
          c.n++; if (s.usd != null) c.usd += s.usd;
        }
        const pts = [...buckets.values()].sort((a, b) => a.time - b.time)
          .map(b => ({ time: b.time, value: b.usd }));
        // The previous chart holds a resize observer, so it is torn down rather
        // than orphaned by overwriting the container.
        volChart?.destroy?.(); volChart = null;
        box.innerHTML = '';
        if (!pts.length) {
          box.innerHTML = `<div class="chart-empty">No ${esc(t.symbol)} trades in this window.</div>`;
        } else {
          histogramChart(box, pts, { color: 'var(--c2)', fmt: usd })
            .then(h => { volChart = h; })
            .catch(() => {
              box.innerHTML = '';
              box.appendChild(columns(pts.map(p => ({ x: p.time * 1000, y: p.value })), {
                fmtY: usd,
                fmtX: ts => new Date(ts).toISOString().slice(bucketSec >= 86400 ? 5 : 11, bucketSec >= 86400 ? 10 : 16),
                label: 'volume per bucket', color: 'var(--c2)',
              }));
            });
        }
        const moved = win.reduce((a, s) => a + (s.usd || 0), 0);
        const biggest = win.reduce((m, s) => (s.usd || 0) > (m?.usd || 0) ? s : m, null);
        const note = $('#tokVolNote');
        // Which pools were read is part of the number. Replaying all 74 of a
        // token's pools would be 74 sets of history calls from the reader's own
        // connection, so the busiest ones are replayed and the rest is said out
        // loud rather than folded into a total that looks complete.
        const venuesRead = [...new Set(use.map(p => p.dex))].join(' and ');
        const scope = tradePools.length > use.length
          ? `the ${use.length} busiest of its ${tradePools.length} pools, on ${venuesRead}`
          : `${use.length} pool${use.length === 1 ? '' : 's'} on ${venuesRead}`;
        const shown = bucketSec >= 86400 ? `${Math.round(bucketSec * 60 / 86400)} days`
          : `${Math.round(bucketSec * 60 / 3600)} hours`;
        // This figure and the "traded 24h" stat above it are two different
        // measurements and will not match. That one is each venue's own
        // published number; this one is counted here, once per trade, at the
        // value of what actually moved. Checked against the chain on pool 1252:
        // eight trades and 206.33 CHEESE from the pool rows against seven and
        // 205.79 from logswap over the same three hours — so the method is
        // sound, and the venues simply count something else.
        if (note) note.innerHTML = win.length
          ? `${win.length.toLocaleString()} trade${win.length === 1 ? '' : 's'} worth ${usd(moved)} in the last ${shown}, across ${scope}`
            + (biggest?.usd ? `, the largest ${usd(biggest.usd)}` : '')
            + `. ${oldest > since ? `The history node reaches back to ${ago(new Date(oldest).toISOString())} on the shallowest of them, so anything older is missing rather than absent.` : 'The window is fully covered.'}`
            + ` Counted here from the pools themselves, once per trade &mdash; the headline figure above is what the venues publish, which is computed differently and usually larger.`
          : `Nothing traded in ${scope} in that window. Read back to ${ago(new Date(oldest).toISOString())}.`;
      };

      drawVol(3600);
      wireIntervals('tokVol', drawVol);

      // A measured figure beats a snapshot that can be an hour old — but it
      // only covers the pools that were replayed, so it never overwrites the
      // all-venue number when there is one.
      const v24 = all.filter(s => s.ts >= Date.now() - 86400000).reduce((a, s) => a + (s.usd || 0), 0);
      if (!(t.vol24 > 0) && v24 > 0) {
        const e = $('#tokVol'); if (e) e.textContent = usd(v24);
        const s = $('#tokVolSub');
        if (s) s.textContent = tradePools.length > use.length
          ? `measured now, on its ${use.length} busiest pools`
          : 'measured now, from the pools themselves';
      }

      const tape = $('#tokTape');
      if (tape) {
        if (!all.length) { tape.innerHTML = '<div class="chart-empty">The history node returned no state changes for these pools.</div>'; return; }
        tape.innerHTML = `<div class="tablewrap" style="max-height:360px;border:0"><table style="font-size:12px">
          <thead><tr><th>When</th><th>Through</th><th></th><th class="r">${esc(t.symbol)}</th><th class="r">Value</th></tr></thead>
          <tbody>${all.slice(0, cap('tokenTape')).map(s => `<tr>
            <td class="num dim"><a href="${blockUrl(s.block)}" target="_blank" rel="noopener" title="Open this block on waxblock">${ago(new Date(s.ts).toISOString())} &nearr;</a></td>
            <td>${s.pools.map(esc).join('<span class="dim"> + </span>')}</td>
            <td class="${s.side === 'bought' ? 'pos' : s.side === 'sold' ? 'neg' : 'dim'}">${s.side}</td>
            <td class="r num">${qty(s.amount)}</td>
            <td class="r num">${s.usd != null ? usd(s.usd) : '<span class="dim">—</span>'}</td>
          </tr>`).join('')}</tbody></table></div>
          <p class="sub" style="margin:9px 0 0">${all.length.toLocaleString()} trades reconstructed, newest ${Math.min(all.length, cap('tokenTape')).toLocaleString()} shown.
          Sizes are what actually moved in the pool, so they are the trade rather than an estimate of it.
          &ldquo;through&rdquo; means the route crossed two of ${esc(t.symbol)}&rsquo;s pools in one block and handed it straight on &mdash; arbitrage, not someone buying.
          Who traded is beside this, read from the swap memos.</p>`;
        // The whole reconstruction, not the shown slice: a reader who wants to
        // do their own arithmetic on it should get every trade this page read,
        // and a tape is exactly the shape a spreadsheet is for.
        tape.appendChild(csvButton(`Export ${all.length.toLocaleString()} trades`, `${t.symbol.toLowerCase()}-trades`, () => all, [
          { h: 'time', v: x => new Date(x.ts).toISOString() },
          { h: 'block', v: x => x.block },
          { h: 'pools', v: x => x.pools.join(' + ') },
          { h: 'direction', v: x => x.side },
          { h: `amount_${t.symbol.toLowerCase()}`, v: x => x.amount },
          { h: 'value_usd', v: x => x.usd },
          { h: 'legs', v: x => x.legs.length },
        ]));
      }
    }).catch(() => {
      const b = $('#tokVolChart'); if (b) b.innerHTML = '<div class="chart-empty">Trade history unavailable.</div>';
      const c = $('#tokTape'); if (c) c.innerHTML = '<div class="chart-empty">Trade history unavailable.</div>';
    });
  }

  // ---- transfers -----------------------------------------------------------
  // Read once, used twice: the movement card and the trader list are two
  // questions of the same feed.
  const movesP = transferActivity(t.contract, t.symbol, { hours: 24 });

  movesP.then(({ transfers, covered, complete }) => {
    if (stale()) return;
    const box = $('#tokMoves'); if (!box) return;
    if (!transfers.length) { box.innerHTML = `<div class="chart-empty">No ${esc(t.symbol)} transfers in the last 24 hours.</div>`; return; }
    const total = transfers.reduce((a, x) => a + x.amount, 0);
    // The DEX contracts are one side of most transfers by construction, so
    // ranking them as "active senders" says nothing except that the token
    // trades. The accounts behind them are the answer.
    const VENUES = new Set(['swap.alcor', 'swap.taco', 'swap.box', 'swap.adex', 'alcordexmain', 'reward.alcor']);
    const parties = new Map();
    for (const x of transfers) {
      if (VENUES.has(x.from)) continue;
      parties.set(x.from, (parties.get(x.from) || 0) + x.amount);
    }
    const top = [...parties].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const biggest = [...transfers].sort((a, b) => b.amount - a.amount).slice(0, 6);
    box.innerHTML = `<div class="stats" style="margin:0 0 12px">
        <div class="stat"><span class="v">${transfers.length.toLocaleString()}</span><span class="k">transfers</span><span class="sub">${complete ? 'last 24h' : `back to ${ago(new Date(covered).toISOString())}`}</span></div>
        <div class="stat"><span class="v">${qty(total)}</span><span class="k">${esc(t.symbol)} moved</span><span class="sub">${t.price != null ? usd(total * t.price) : '&nbsp;'}</span></div>
      </div>
      <h3 style="font-size:12px;margin:0 0 6px">Largest single moves</h3>
      <div class="tablewrap" style="max-height:200px;border:0"><table style="font-size:12px"><tbody>${
        biggest.map(x => `<tr>
          <td class="num dim"><a href="${trxUrl(x.trx)}" target="_blank" rel="noopener">${ago(new Date(x.ts).toISOString())} &nearr;</a></td>
          <td class="mono">${acctLink(x.from)} <span class="dim">&rarr;</span> ${acctLink(x.to)}</td>
          <td class="r num">${qty(x.amount)}</td></tr>`).join('')}</tbody></table></div>
      <p class="sub" style="margin:9px 0 0">${top.length ? `Most active sender${top.length === 1 ? '' : 's'}, the DEX contracts aside: ${top.map(([a, v]) => `${acctLink(a)} <span class="dim">(${qty(v)})</span>`).join(', ')}.` : 'Every transfer in this window came from a DEX contract.'}
      Transfers include claims, farm payouts and swaps, so this runs well ahead of trading volume on a token people actually use.</p>`;
  }).catch(() => { const b = $('#tokMoves'); if (b) b.innerHTML = '<div class="chart-empty">Transfer history unavailable.</div>'; });

  // ---- who trades it, and through what ------------------------------------
  // Replaying a pool row gives the trade but never the trader — the row records
  // the change, not the account that caused it. The swap memo does: an Alcor
  // swap is a transfer to swap.alcor naming every pool the route will cross, so
  // the feed already fetched above answers it for free.
  movesP.then(({ transfers, covered, complete }) => {
    if (stale()) return;
    const box = $('#tokTraders'); if (!box) return;
    // Indexed once. A linear scan per pool id, over twenty thousand pools and a
    // few hundred routes, is tens of millions of comparisons on the main thread.
    const byId = new Map();
    for (const p of state.pools) if (p.dex === 'alcor') byId.set(String(p.id), p);
    const poolName = pid => {
      const p = byId.get(String(pid));
      return p ? `${p.symA}/${p.symB}` : `#${pid}`;
    };
    const who = new Map();
    for (const x of transfers) {
      const inLeg = x.to === 'swap.alcor' && x.route;
      const outLeg = x.from === 'swap.alcor';
      if (!inLeg && !outLeg) continue;
      const acct = inLeg ? x.from : x.to;
      let r = who.get(acct);
      if (!r) { r = { acct, n: 0, amount: 0, routes: new Map() }; who.set(acct, r); }
      r.n++; r.amount += x.amount;
      if (inLeg && x.route.length) {
        const key = x.route.map(poolName).join(' \u2192 ');
        r.routes.set(key, (r.routes.get(key) || 0) + 1);
      }
    }
    const list = [...who.values()].sort((a, b) => b.amount - a.amount);
    if (!list.length) { box.innerHTML = `<div class="chart-empty">Nobody swapped ${esc(t.symbol)} on Alcor in this window.</div>`; return; }
    box.innerHTML = `<div class="tablewrap" style="max-height:360px;border:0"><table style="font-size:12px">
      <thead><tr><th>Trader</th><th class="r">Trades</th><th class="r">${esc(t.symbol)}</th><th>Usual route</th></tr></thead>
      <tbody>${list.slice(0, cap('routes')).map(r => {
        const top = [...r.routes].sort((a, b) => b[1] - a[1])[0];
        const hops = top ? top[0].split(' \u2192 ').length : 0;
        return `<tr>
          <td class="mono">${acctLink(r.acct)}</td>
          <td class="r num">${r.n}</td>
          <td class="r num">${qty(r.amount)}</td>
          <td>${top ? `<span class="route">${esc(top[0])}</span>${hops > 2 ? ' <span class="badge warn">multi-hop</span>' : ''}` : '<span class="dim">out only</span>'}</td>
        </tr>`;
      }).join('')}</tbody></table></div>
      <p class="sub" style="margin:9px 0 0">${capNote(list.length, Math.min(list.length, cap('routes')), 'accounts', { filterable: false })} traded ${esc(t.symbol)} on Alcor ${complete ? 'in the last 24 hours' : `back to ${ago(new Date(covered).toISOString())}`}.
      A route with several pools is one transaction crossing all of them; where it comes back to ${esc(t.symbol)} it is arbitrage rather than someone buying.
      &ldquo;Out only&rdquo; means they received ${esc(t.symbol)} from a swap whose input was another token.</p>`;
  }).catch(() => { const b = $('#tokTraders'); if (b) b.innerHTML = '<div class="chart-empty">Swap memos unavailable.</div>'; });

  // ---- liquidity providers -------------------------------------------------
  topLPs(id, pools).then(lps => {
    if (stale()) return;
    const box = $('#tokLps'); if (!box) return;
    if (!lps.length) { box.innerHTML = '<div class="chart-empty">No positions found.</div>'; return; }
    const tot = lps.reduce((s, l) => s + l.amount, 0);
    box.innerHTML = `<div class="tablewrap" style="max-height:none;border:0"><table style="font-size:12.5px"><tbody>${
      lps.slice(0, 10).map((l, i) => `<tr><td class="rank">${i + 1}</td>
        <td class="mono">${acctLink(l.account)}</td>
        <td class="r num">${qty(l.amount)}</td>
        <td class="r num dim">${(l.amount / tot * 100).toFixed(1)}%</td></tr>`).join('')}</tbody></table></div>
      <p class="sub" style="margin:9px 0 0">${lps.length} accounts supply ${esc(t.symbol)}. This is a different list from the holders beside it &mdash; the largest supplier often does not appear there at all.</p>`;
  }).catch(() => { const b = $('#tokLps'); if (b) b.innerHTML = '<div class="chart-empty">Positions unavailable.</div>'; });

  // ---- the long record -----------------------------------------------------
  // One read: the token's own series and the APR trend on each of its farms are
  // two questions of the same file.
  const histP = loadHistory();

  histP.then(hist => {
    if (stale()) return;
    if (!farms.length) return;
    // farms rows: [key, rewardUsdDay, stakedUsd, apr, rewardRealDay, stakedReal, aprReal]
    const trend = new Map();
    for (const r of hist) {
      for (const f of (r.farms || [])) {
        if (!trend.has(f[0])) trend.set(f[0], []);
        trend.get(f[0]).push({ at: r.at, apr: f[6] ?? f[3] ?? null });
      }
    }
    document.querySelectorAll('td[data-apr]').forEach(td => {
      const pts = perDay(trend.get(td.dataset.apr) || [], r => r.at).map(r => r.apr);
      td.innerHTML = '';
      td.appendChild(sparkline(pts, { color: 'var(--c3)' }));
      td.title = pts.length >= 3
        ? `${pts.length} days recorded, ${pts.at(-1)?.toFixed(1)}% now against ${pts[0]?.toFixed(1)}% at the start`
        : 'A trend needs three days recorded; the snapshot job has not reached that yet';
    });
  }).catch(() => {});

  histP.then(hist => {
    if (stale()) return;
    const box = $('#tokHist'); if (!box) return;
    const series = perDay(tokenSeries(hist, id), r => r.at);
    if (series.length < 3) {
      box.innerHTML = `<div class="chart-empty">${series.length ? `${series.length} day${series.length === 1 ? '' : 's'} recorded so far.` : 'Nothing recorded for this token yet.'}<br>
        A daily job appends one reading per run, and this chart appears once there are three &mdash; two points drawn across an axis is a picture of nothing.
        Tokens enter the record once they hold $50 in pools or trade $50 in a day.</div>`;
      return;
    }
    box.innerHTML = '<div class="tvpair"><div class="tvtop"></div><div class="tvbot"></div></div>';
    const sec = ms => Math.floor(ms / 1000);
    const top = box.querySelector('.tvtop'), bot = box.querySelector('.tvbot');
    lineSeriesChart(top, series.map(r => ({ time: sec(r.at), value: r.tvl })), { height: 200, color: 'var(--c1)', fmt: usd })
      .catch(() => top.appendChild(areaChart(series.map(r => ({ x: r.at, y: r.tvl })), {
        fmtY: usd, fmtX: ts => new Date(ts).toISOString().slice(0, 10), color: 'var(--c1)', label: 'pooled value over time' })));
    histogramChart(bot, series.map(r => ({ time: sec(r.at), value: r.vol })), { height: 130, color: 'var(--c2)', fmt: usd })
      .catch(() => bot.appendChild(columns(series.map(r => ({ x: r.at, y: r.vol })), {
        fmtY: usd, fmtX: ts => new Date(ts).toISOString().slice(5, 10), color: 'var(--c2)', label: 'daily volume', height: 130 })));
    const first = series[0], last = series.at(-1);
    const move = first.tvl > 0 ? (last.tvl / first.tvl - 1) * 100 : null;
    box.insertAdjacentHTML('beforeend', `<p class="sub" style="margin:9px 0 0">${series.length} days recorded.
      Pooled value ${move == null ? 'has no baseline to compare against' : `${move >= 0 ? 'up' : 'down'} ${Math.abs(move).toFixed(1)}% since ${new Date(first.at).toISOString().slice(0, 10)}`}.</p>`);
  }).catch(() => { const b = $('#tokHist'); if (b) b.innerHTML = '<div class="chart-empty">Record unavailable.</div>'; });

  // ---- holders, the map, and the donut ------------------------------------
  let holders = [];
  try {
    holders = await topHolders(t.contract, t.symbol, cap('holders'));
    await clusterHolders(holders);
    if (stale()) return;
  } catch (e) {
    $('#tokHolders').innerHTML = `<div class="chart-empty">Holder list unavailable (${esc(e.message)}).</div>`;
    $('#tokDist').innerHTML = '<div class="chart-empty">Needs the holder list.</div>';
    $('#tokBubbles').innerHTML = '<div class="chart-empty">Needs the holder list.</div>';
    return;
  }

  const stats = await statsP;
  if (stale()) return;
  const supply = stats?.supply ?? 0;
  if (!holders.length) {
    $('#tokHolders').innerHTML = '<div class="chart-empty">No holders returned.</div>';
    return;
  }

  const top = holders.slice(0, 14);
  await Promise.all(top.map(async h => {
    try { h.lp = (await lpHoldings(h.account, id, pools)).total; } catch { h.lp = 0; }
    h.total = h.balance + (h.lp || 0);
  }));
  top.sort((a, b) => b.total - a.total);
  // Share of supply is computed on the wallet balance alone, never on balance
  // plus LP. A token sitting in a pool is already inside swap.alcor's balance,
  // so adding a provider's share of it on top counts the same coins twice —
  // which is how "these 14 hold 100.1% of supply" reached the page. Ranking
  // still uses the total, because what an account controls is the better
  // order; only the arithmetic has to stay on one side of the line.
  const share = b => supply > 0 ? (b / supply * 100) : null;
  $('#tokHolders').innerHTML = `<div class="tablewrap" style="max-height:none;border:0"><table style="font-size:12.5px">
    <thead><tr><th></th><th>Wallet</th><th class="r">Held</th><th class="r">In pools</th><th class="r">Share</th></tr></thead>
    <tbody>${top.map((h, i) => `
    <tr><td class="rank">${i + 1}</td>
      <td class="mono">${acctLink(h.account)}${h.contractRole ? `<span class="venue" title="An account carrying code — it holds this for other people rather than owning it">${esc(h.contractRole)}</span>` : ''}</td>
      <td class="r num">${qty(h.balance)}</td>
      <td class="r num ${h.lp > 0 ? '' : 'dim'}">${h.lp > 0 ? qty(h.lp) : '—'}</td>
      <td class="r num ${share(h.balance) > 10 && !h.contractRole ? 'warnish' : 'dim'}">${share(h.balance) == null ? '' : share(h.balance).toFixed(2) + '%'}</td>
    </tr>`).join('')}</tbody></table></div>
    <p class="sub" style="margin:9px 0 0">${supply > 0 ? `These ${top.length} hold ${(top.reduce((a, h) => a + h.balance, 0) / supply * 100).toFixed(1)}% of supply between them${holderTotal ? `, out of ${holderTotal.toLocaleString()} accounts holding any` : ''}. The share column counts wallet balances only &mdash; what sits in a pool is already inside that DEX&rsquo;s own row, so adding it again would count the same coins twice. ` : ''}Contracts are marked. Pools, lockers and bridges hold tokens for other people, so counting them as owners makes every token look held by one address.</p>`;

  if (supply > 0) {
    const inContracts = holders.filter(h => h.contractRole).reduce((a, h) => a + h.balance, 0);
    const slices = top.filter(h => !h.contractRole).slice(0, 5).map(h => ({ label: h.account, value: h.balance }));
    const named = slices.reduce((a, x) => a + x.value, 0);
    if (inContracts > 0) slices.unshift({ label: 'held by contracts', value: inContracts });
    const rest = supply - named - inContracts;
    if (rest > 0) slices.push({ label: 'everyone else', value: rest });
    const box = $('#tokDist'); box.innerHTML = '';
    box.appendChild(donut(slices, { fmt: v => qty(v) + ' ' + t.symbol, top: 8 }));
  } else $('#tokDist').innerHTML = '<div class="chart-empty">Needs the supply to turn balances into shares.</div>';

  try {
    const clusters = await transferClusters(t.contract, t.symbol, holders, { supply });
    // Wallet balances, for the same reason the share column uses them: pooled
    // tokens live in the DEX's own balance, and a bubble sized by balance+LP
    // next to a DEX bubble sized by balance draws the same coins twice.
    const nodes = top.map(h => ({ id: h.account, value: h.balance, contract: !!h.contractRole, share: supply > 0 ? h.balance / supply : null }));
    const links = clusters.flatMap(g => g.links.map(l => ({ source: l.pair[0], target: l.pair[1], value: l.amount })));
    const box = $('#tokBubbles');
    box.innerHTML = '';
    box.appendChild(bubbleMap(nodes, links, { fmt: v => qty(v) + ' ' + t.symbol, onPick: acct => openAccount(acct) }));
    const note = document.createElement('p');
    note.className = 'sub'; note.style.marginTop = '8px';
    note.innerHTML = links.length
      ? `${clusters.length} group${clusters.length === 1 ? '' : 's'} of wallets have moved ${esc(t.symbol)} between each other, holding ${clusters.map(g => (g.share * 100).toFixed(1) + '%').join(' and ')} of supply. Projects legitimately run several accounts &mdash; read it next to the share column, and click a bubble to see what that wallet actually holds.`
      : 'No transfers between the largest holders.';
    box.appendChild(note);
  } catch { $('#tokBubbles').innerHTML = '<div class="chart-empty">Could not trace transfers.</div>'; }
}


// ---------------------------------------------------------- POOL DETAIL -----
async function openPool(key) {
  const [dex, id] = key.split(':');
  const p = state.pools.find(x => x.dex === dex && x.id === id);
  if (!p) return;
  show('pool', key);
  const farms = state.farms.filter(f => f.poolDex === dex && f.poolId === id && !f.ended);

  $('#poolDetail').innerHTML = `
    <h2 class="vt">${pairName(p)} <span class="badge ${p.dex}">${p.dex}</span> <span class="dim" style="font-weight:400">#${esc(p.id)}</span></h2>
    <p class="vs">${(p.feeBps / 100).toFixed(2)}% fee tier on ${p.dex === 'alcor' ? 'Alcor' : p.dex === 'taco' ? 'TacoSwap' : p.dex === 'defibox' ? 'Defibox' : 'A-DEX'}${p.bornAt ? ` &middot; first seen ${age(p.bornAt)} ago` : ''}</p>
    <div class="toolbar" style="margin-bottom:16px">
      <span id="poolStar"></span>
      <a class="btn" href="${swapUrl(p)}" target="_blank" rel="noopener">Trade this pair &nearr;</a>
      <a class="btn ghost" href="${venueUrl[p.dex]?.(p) || '#'}" target="_blank" rel="noopener">Open the pool &nearr;</a>
      ${farms.length ? `<a class="btn ghost" href="${farmUrl(p)}" target="_blank" rel="noopener">Go to the farm &nearr;</a>` : ''}
    </div>
    <div class="stats">
      <div class="stat"><span class="v">${usd(p.tvlReal)}</span><span class="k">exit value</span><span class="sub">${p.tvl > (p.tvlReal || 0) * 1.05 ? usd(p.tvl) + ' at face value' : 'fully backed'}</span></div>
      <div class="stat"><span class="v">${p.vol24 > 0 ? usd(p.vol24) : '—'}</span><span class="k">volume 24h</span>${p.turnover > 0 ? `<span class="sub">${p.turnover.toFixed(2)}× its own liquidity</span>` : ''}</div>
      <div class="stat"><span class="v">${p.depth1 > 0 ? usd(p.depth1) : '—'}</span><span class="k">trade depth</span><span class="sub">before moving price 1%</span></div>
      <div class="stat"><span class="v">${qty(p.priceAB)}</span><span class="k">${esc(p.symB)} per ${esc(p.symA)}</span></div>
      <div class="stat"><span class="v">${qty(p.reserveA)}</span><span class="k">${esc(p.symA)} in pool</span><span class="sub">${usd(p.priceUsdA ? p.reserveA * p.priceUsdA : null)}</span></div>
      <div class="stat"><span class="v">${qty(p.reserveB)}</span><span class="k">${esc(p.symB)} in pool</span><span class="sub">${usd(p.priceUsdB ? p.reserveB * p.priceUsdB : null)}</span></div>
      <div class="stat"><span class="v">${farms.length}</span><span class="k">live farms</span></div>
    </div>
    ${farms.length ? `<div class="card" style="margin-bottom:12px"><h3>Farms on this pool</h3>
      ${farms.map(f => `<div style="display:flex;gap:10px;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);font-size:13px">
        <span><span class="mono">${qty(f.rewardPerDay)}</span> <b>${esc(f.rewardSymbol)}</b> / day</span>
        <span class="num dim">${usd(f.rewardUsdDay)} &middot; ends ${f.periodFinish ? new Date(f.periodFinish).toISOString().slice(0, 10) : 'open'}</span>
      </div>`).join('')}</div>` : ''}
    <div class="grid g2">
      <div class="card"><h3><span id="poolPair">Price</span> <span class="dim">— candles built from pool state changes</span>
        <span style="margin-left:auto;display:flex;gap:4px">
          <button class="chip" id="poolFlip" title="Show the price the other way round">&#8646;</button>
          ${intervalChips('poolPrice')}
        </span></h3><div id="poolChart"><div class="loading"><span class="spinner"></span><span>Reading state changes…</span></div></div></div>
      <div class="card"><h3>Recent swaps here</h3><div id="poolSwaps"><div class="loading"><span class="spinner"></span><span>Reading feed…</span></div></div></div>
    </div>
    ${promoteBox('p', key, `${p.symA}/${p.symB}`)}`;

  wirePromote();
  $('#poolStar')?.appendChild(watchStar('p', key, `${p.symA}/${p.symB}`));
  if (farms.length) $('#poolStar')?.appendChild(watchStar('f', key, `${p.symA}/${p.symB}` + ' farm'));

  // Every venue keeps a state table, so every venue gets a chart and a tape.
  // This used to be Alcor-only, and a TacoSwap or Defibox pool showed two boxes
  // saying the feature was not wired up yet.
  {
    const note = document.createElement('p');
    note.className = 'sub'; note.style.marginTop = '8px';
    $('#poolChart').after(note);

    // How far back this reaches follows the candle you asked for. Three pages
    // of a busy pool is 1.7 days, which is fine at five minutes a candle and
    // useless at one a day — the long intervals looked cut off because there
    // was nothing older to draw.
    let iv = 3600, flipped = false, busy = false;
    const draw = async () => {
      const box = $('#poolChart');
      if (!box || busy) return;
      busy = true;
      try {
        const got = await candlesFor(p, iv,
          d => { box.innerHTML = `<div class="loading"><span class="spinner"></span><span>Reading ${d} of this pool…</span></div>`; });
        if (!got.candles.length) { box.innerHTML = '<div class="empty">No price history for this pool.</div>'; note.textContent = ''; return; }
        const shown = flipped ? invertCandles(got.candles) : got.candles;
        const [num, den] = flipped ? [p.symA, p.symB] : [p.symB, p.symA];
        const pair = $('#poolPair');
        if (pair) pair.textContent = `${den}/${num}`;
        note.textContent = `${shown.length.toLocaleString()} candles back to ${new Date(shown[0].time * 1000).toISOString().slice(0, 10)} · ${num} per ${den}`
          + (got.source === 'alcor' ? ' · the whole life of the pool, from Alcor.' : ' · rebuilt from pool state changes.');
        await candleChart(box, shown, { height: 300, precision: precisionFor(shown.at(-1)?.close) })
          .catch(() => { box.innerHTML = '<div class="empty">Chart library unavailable.</div>'; });
      } catch (e) {
        const box2 = $('#poolChart');
        if (box2) box2.innerHTML = `<div class="empty">History unavailable: ${esc(e.message)}</div>`;
      } finally { busy = false; }
    };
    draw();
    wireIntervals('poolPrice', v => { iv = v; draw(); });
    const flip = $('#poolFlip');
    if (flip) flip.onclick = () => { flipped = !flipped; flip.setAttribute('aria-pressed', String(flipped)); draw(); };

    const deltasP = chartDeltas(p, 3600);

    // The tape comes from the same rows, not from the swap feed. Filtering the
    // chain-wide logswap firehose down to one pool finds almost nothing for a
    // quiet pool and then reports that as "no swaps", which is a statement
    // about the feed rather than about the pool.
    deltasP.then(rows => {
      const box = $('#poolSwaps');
      const sw = swapsFromDeltas(rows).reverse();
      if (!sw.length) { box.innerHTML = '<div class="empty">No trades in the window the history node keeps.</div>'; return; }
      box.innerHTML = `<div class="tablewrap" style="max-height:280px;border:0"><table>
        <thead><tr><th>When</th><th></th><th class="r">${esc(p.symA)}</th><th class="r">${esc(p.symB)}</th><th class="r">Value</th></tr></thead>
        <tbody>${sw.slice(0, cap('tokenTape')).map(x => {
          const v = p.priceUsdA != null ? Math.abs(x.amountA) * p.priceUsdA
            : p.priceUsdB != null ? Math.abs(x.amountB) * p.priceUsdB : null;
          return `<tr><td class="num dim">${ago(new Date(x.ts).toISOString())}</td>
            <td class="${x.amountA > 0 ? 'neg' : 'pos'}">${x.amountA > 0 ? `sold ${esc(p.symA)}` : `bought ${esc(p.symA)}`}</td>
            <td class="r num">${qty(Math.abs(x.amountA))}</td>
            <td class="r num">${qty(Math.abs(x.amountB))}</td>
            <td class="r num">${v != null ? usd(v) : '<span class="dim">—</span>'}</td></tr>`;
        }).join('')}</tbody></table></div>
        <p class="sub" style="margin:9px 0 0">${sw.length.toLocaleString()} trades read straight out of the pool row, back to ${ago(new Date(sw.at(-1).ts).toISOString())}.
        Who made them is not in the row &mdash; a pool records the change, not the account that caused it. The token page reads that from the swap memos.</p>`;
    }).catch(e => { $('#poolSwaps').innerHTML = `<div class="empty">Feed unavailable: ${esc(e.message)}</div>`; });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  boot();
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-view]');
    if (b?.dataset.view === 'activity' && !activityLoaded) renderActivity();
  });
});
