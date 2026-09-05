// =============================================================================
// APP — views and wiring. All data comes from store.js, which reads the chain
// directly; there is no server anywhere in this application.
// =============================================================================

import { loadCore, state, walletPositions, recentSwaps, clearCache, farmGroups, groupStakedUsd, loadHistory, SNAPSHOT_ONLY, toCandles, tokenTable, walletPositionsFast, tradeRoutes, swapsFromDeltas, tokenSeries, perDay, venueDeltas, chartDeltas, alcorCandles, TRADE_VENUES, MIN_STAKE_FOR_APR_USD } from './store.js';
import { harvestFor, planCompound, stakedIncentives, farmGap, pendingFarms, pendingAt, accrualPerSec } from './compound.js';
import { earningsHistory, summariseEarnings } from './rewards.js';
import * as wallet from './wallet.js';
import { buildCreatePool, buildRedeposit, buildOneShot, buildClaimAndSwap, buildRestake, planZap, buildZapSwap, buildZapDeposit, buildPowerupVia, readBalances, buildVoteClaim, buildStakeBack, buildAddLiquidity, buildRemoveLiquidity, buildPromotion, buildPowerup, buildUnstake, buildRefund, buildVote, asset } from './tx.js';
import { areaChart, columns, donut, bars, histogram, rangeBar, hideTip, bubbleMap, sparkline, depthChart } from './charts.js';
import { candleChart, histogramChart, lineSeriesChart } from './tvchart.js';
import { liquidityBands, bandValues } from './math.js';
import { loadTokenMeta, pairMark, tokenMark, tokenMeta } from './tokens.js';
import { debounce } from './router.js';
import { topHolders, clusterHolders, transferGraph, tokenStats, lpHoldings, topLPs, tokenTax, holderCount, transferActivity, upcomingUnlocks, lockedSupply } from './holders.js';
import { cap } from './limits.js';
import { accountInfo, valueBalances, accountSwaps, tradeFlow } from './account.js';
import { stakeInfo, claimHistory, observedApr } from './stake.js';
import { resourcesOf, useFraction, cpuTransactions, bytes, micros } from './resources.js';
import { markets as obMarkets, marketFor, book, ordersOf } from './orderbook.js';
import { waxdaoStakes, claimableNow, buildWaxdaoClaims } from './waxdao.js';
import { pepperStakes, buildPepperClaim } from './pepperstake.js';
import { balanceOf, getAllRows } from './chain.js';
import { csvButton } from './csv.js';
import { watchStar, watchedOf, sinceSeen, markSeen, watchCount, onWatchChange } from './watch.js';
import { configurePromotion, promotionConfigured, promotionTerms, activePromotions } from './promote.js';
import { sqrtPriceFromX64, depositRatio, amountsForLiquidity } from './math.js';

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
const sigfig = v => {
  if (v == null || !isFinite(v) || v === 0) return '—';
  const a = Math.abs(v);
  if (a >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (a >= 1) return v.toPrecision(4).replace(/\.?0+$/, '');
  return v.toPrecision(3);
};
// Money at a fixed precision. Both of these honour the unit switch: choosing
// WAX and still being shown dollars everywhere the number actually matters —
// farm rewards, what is waiting to be claimed, what has been paid out — makes
// the switch a lie. Only the WAX price itself stays in dollars, because that is
// what it is.
const fixed = (v, digits) => {
  if (v == null || !isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  if (UNIT === 'wax') {
    const w = inWax(v);
    if (w != null) return sign + Math.abs(w).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + ' WAX';
  }
  return sign + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};
const usdExact = v => fixed(v, 2);
// Four decimals, because two of them cannot show a number moving by a
// thousandth of a cent a second — which is the whole point of showing it move.
const usd4 = v => fixed(v, 4);
// Six decimals is plenty for WAX and not nearly enough for WAXWBTC: it printed
// 0.0000 beside $0.0162, which reads as owning nothing worth 1.6 cents. Below
// what six decimals can show, precision takes over.
const qtyFine = v => {
  if (v == null || !isFinite(v)) return '—';
  if (v === 0) return '0';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (v >= 1e-6) return v.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 8 });
  return v.toPrecision(3);
};
const pct = v => (v == null || !isFinite(v)) ? '—' : (v >= 1000 ? 'off the scale' : v.toFixed(1) + '%');
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
// Three kinds of name, one way to write each. Anywhere a token, a pool or an
// account is mentioned it can be clicked through to, so the chain runs in every
// direction: farm to pool to token to holder to that holder's wallet, and back
// out through the pools they are in.
const acctLink = name => `<span class="xlink acct-link" data-acct="${esc(name)}" title="See what ${esc(name)} holds">${esc(name)}</span>`;
const tokLink = (id, label = null) => `<span class="xlink" data-tokid="${esc(id)}" title="Open ${esc(label || String(id).split('@')[0])}">${esc(label || String(id).split('@')[0])}</span>`;
const poolLink = (dex, id, label) => `<span class="xlink" data-poolkey="${esc(dex)}:${esc(id)}" title="Open this pool">${label}</span>`;
const pairLinks = p => `${tokLink(p.tokenA, p.symA)}/${tokLink(p.tokenB, p.symB)}`;

// A row is the least specific thing under the cursor. When a click lands on a
// token, pool, farm or account link inside it, that link owns the click and the
// row must keep out of it.
//
// The delegated handler below captures the event and stops it, which in a
// browser is enough on its own. This states the same rule where it does not
// depend on capture firing first: belt and braces on a click that otherwise
// opens two pages and leaves one of them loading in the background.
const LINK_SEL = '[data-tokid],[data-poolkey],[data-farmkey],[data-acct]';
const rowClick = fn => e => { if (e && e.target && e.target.closest && e.target.closest(LINK_SEL)) return; fn(e); };

// One delegated handler for every one of them, however it got on the page —
// tables are rewritten constantly and rebinding each time is how a click
// quietly stops working. Most specific first: a token name inside a pool row
// should open the token, not the pool.
//
// CAPTURE, not bubble. A row carries its own onclick, and in the bubble phase
// the row's handler has already run by the time this one sees the event —
// stopPropagation() then cancels nothing, because there is nothing left to
// cancel. Clicking a token name inside a pool row opened the pool AND the
// token, landed on the token page, and left the pool page's async reads still
// writing into a panel nobody was looking at. Capturing puts "most specific
// first" back the right way round.
//
// Safe to swallow the event here because all four of these are plain spans
// wrapping a name — no button, input or link lives inside one.
document.addEventListener('click', e => {
  const t = e.target.closest?.('[data-tokid]');
  if (t && t.dataset.tokid) { e.stopPropagation(); openToken(t.dataset.tokid); return; }
  const k = e.target.closest?.('[data-poolkey]');
  if (k) { e.stopPropagation(); openPool(k.dataset.poolkey); return; }
  // Emitted by the token page's farm summary, and until now by nothing that
  // listened: the spans looked like links and did nothing.
  const f = e.target.closest?.('[data-farmkey]');
  if (f && f.dataset.farmkey) { e.stopPropagation(); openFarm(f.dataset.farmkey); return; }
  const el = e.target.closest?.('[data-acct]');
  if (!el) return;
  e.stopPropagation();
  show('wallet', el.dataset.acct); $('#walletInput').value = el.dataset.acct; lookupWallet(el.dataset.acct);
}, true);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pairName = p => `${esc(p.symA)}/${esc(p.symB)}`;
// What a trade costs and what a provider receives are not the same number
// everywhere: TacoSwap charges 0.30% and passes 0.1% of it to the LP. Earnings
// use the provider's cut, or a Taco position reads three times too rich.
const lpCut = p => p.lpFeeBps ?? p.feeBps;

// What the pool's own trading pays a provider, annualised off the last seven
// days. A farm's APR and a pool's fee APR are different money from different
// sources — one stops when the incentive ends, the other does not — so they are
// never added into a single number without saying so.
// The farm rate a deposit of this size would get, not the rate on the board:
// joining puts you in the denominator.
const farmAprFor = (pool, usdIn) => {
  const g = seedApr(farmGroups()).find(x => x.dex === pool.dex && String(x.poolId) === String(pool.id));
  if (!g) return null;
  const live = g.farms.filter(f => (f.periodFinish ? f.periodFinish > Date.now() : !f.ended));
  const useReal = g.stakedReal != null && g.rewardRealDay > 0;
  const day = live.reduce((a, f) => a + ((useReal ? f.rewardRealDay : f.rewardUsdDay) || 0), 0);
  const staked = (useReal ? g.stakedReal : g.stakedUsd) ?? 0;
  if (!(day > 0) || !(usdIn > 0)) return null;
  return ((day * (usdIn / (staked + usdIn))) * 365 / usdIn) * 100;
};

const FEE_APR_MIN_TVL = 25;
// Has anything counted volume for this venue at all? Alcor comes from the hourly
// file; every other venue is counted from a day of its own swap log by the daily
// job, and if that ran, at least one of its pools traded. Without the question
// there is no way to tell "nothing traded" from "nobody looked", and answering
// zero to the second one is a lie.
let volSeen = null, volSeenAt = 0;
const venueCountsVolume = dex => {
  if (dex === 'alcor') return !!state.volumeAt;
  if (volSeenAt !== state.loadedAt) {
    volSeen = new Set();
    for (const p of state.pools) if (p.vol24 > 0) volSeen.add(p.dex);
    volSeenAt = state.loadedAt;
  }
  return volSeen.has(dex);
};

const feeApr = pool => {
  if (!pool) return null;
  // Alcor publishes a seven-day figure. Nobody else does, so the daily job
  // counts a day of their swap logs instead — which left vol7d null on every
  // TacoSwap pool and meant this formula could never fire there. 217 farm rows
  // blank, 95 of them holding a real 24-hour number that nothing ever read.
  //
  // Only ever 24 hours or 7 days. A month annualised is history, not a rate
  // anyone can act on. On the 7-day setting a venue with no weekly figure falls
  // back to its day, because a real number from the wrong window beats a blank.
  const perDay = farmFilters.feeWindow === '24h'
    ? (pool.vol24 > 0 ? pool.vol24 : 0)
    : (pool.vol7d > 0 ? pool.vol7d / 7 : (pool.vol24 > 0 ? pool.vol24 : 0));
  if (!(perDay > 0)) {
    // A pool the pass did not mention did not trade. That is a measured zero,
    // and 0% is an answer — a dash reads as "we could not find out", which was
    // wrong for three quarters of this table.
    return venueCountsVolume(pool.dex) ? 0 : null;
  }
  // The floor belongs here and not above it. Dividing real fee income by a
  // two-cent pool is what printed 314 billion percent; dividing NO fee income
  // by it is just zero, and a pool being small is no reason to refuse to say so.
  if (!(pool.tvlReal >= FEE_APR_MIN_TVL)) return null;
  return (perDay * (lpCut(pool) / 10000) * 365 / pool.tvlReal) * 100;
};

// Why a fee APR cell is empty or zero. A dash with no explanation reads as a
// number we could not find, and here it never is: it is either a pool too small
// to divide by, or a venue nothing has counted.
const feeAprWhy = pool => {
  if (!pool) return 'no pool';
  const week = farmFilters.feeWindow !== '24h' && pool.vol7d > 0;
  const perDay = week ? pool.vol7d / 7 : (pool.vol24 > 0 ? pool.vol24 : 0);
  if (!(perDay > 0)) return venueCountsVolume(pool.dex) ? 'No trades counted' : 'No volume figure for this venue';
  if (!(pool.tvlReal >= FEE_APR_MIN_TVL)) return `Only ${usd(pool.tvlReal)} in the pool — too small to quote a rate against`;
  return week ? 'Annualised from seven days of trading' : 'Annualised from one day of trading';
};
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

// Is the server on a newer deploy than this tab? See the note at the call site.
async function checkForNewer(build) {
  try {
    const r = await fetch(`index.html?_=${Date.now()}`, { cache: 'reload' });
    if (!r.ok) return;
    const live = ((await r.text()).match(/js\/app\.js\?v=([a-f0-9]+)/) || [])[1];
    if (!live || live.slice(0, 7) === build) return;
    const bar = document.createElement('div');
    bar.className = 'freshbar';
    bar.style.marginTop = '8px';
    bar.innerHTML = `A newer build is live &mdash; this tab is running <span class="mono">${esc(build)}</span>.
      <button class="btn ghost" id="reloadNew">Load it</button>`;
    $('#banner')?.appendChild(bar);
    // location.reload() alone can be served the same cached document, so the
    // stamped URL is what forces the fetch.
    $('#reloadNew').onclick = () => { location.replace(location.pathname + '?b=' + live.slice(0, 7) + location.hash); };
  } catch { /* offline, or index.html is not where we think: say nothing */ }
}

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
    if (b.dataset.view === 'leaders') renderLeaders();
    // One extra table read, and only for someone who opened the tokens page.
    if (b.dataset.view === 'tokens') renderUnlocks().catch(() => {});
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
  // Charts are drawn at the width they were built for, so a rotation or a
  // resized window leaves them stretched — the exact distortion the viewport-
  // width viewBox exists to avoid. Redraw when the width actually changes by
  // enough to matter; a soft keyboard opening is not a resize.
  let lastW = window.innerWidth;
  window.addEventListener('resize', debounce(() => {
    const w = window.innerWidth;
    if (Math.abs(w - lastW) < 80) return;
    lastW = w;
    redrawCurrent();
  }, 250));

  $('#refreshBtn').onclick = async () => { await clearCache(); location.reload(); };
  $('#farmBack').onclick = () => show(lastView || 'farms');
  $('#poolBack').onclick = () => show(lastView || 'pools');
  $('#tokBack').onclick = () => show(lastView || 'tokens');

  // Wire everything BEFORE loading. Handlers do not need data, and hanging the
  // first render off a progress callback meant one early return anywhere in
  // that path left the page on a spinner with no error — which is exactly what
  // happened, and only on the path that reads the chain.
  wireFarms(); wireTokens(); wireWallet(); wireActivity(); wireConnect(); wireLeaders();

  // Start the nightly file on the way past. It is 30 KB and it carries the farm
  // APR denominator, so having it in flight before the first table is drawn is
  // the difference between a rate and a second of "computing…".
  nightlyFile();

  const paint = () => {
    try { renderFarms(); renderTokens(); renderOverview(); }
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
    await loadCore({ swr: true, onProgress: p => {
      const m = $('#loadmsg');
      if (m && p.msg) m.textContent = p.msg;
    } });
  } catch (e) { loadError = e; }

  // Cache was there but past its five minutes: the page is already drawable, so
  // it draws, and the real sweep runs behind the reader instead of in front of
  // them. Everything repaints when it lands.
  const refreshBehind = state.stale && state.pools.length;

  // Whatever came back — snapshot, cache, or a full read — draw it.
  if (state.pools.length) {
    // Give the marks a moment so the first paint carries them, but never wait on
    // them: a slow logo host must not hold up the whole terminal.
    await Promise.race([marks, new Promise(r => setTimeout(r, 2000))]);
    paint();
    if (!marksReady) marks.then(() => paint());
    if (refreshBehind) {
      loadCore({ force: true })
        .then(() => { groups = []; tokRows = null; paint(); })
        .catch(() => {});
    }
    if (state.waxUsd) $('#waxPrice').innerHTML = `WAX <b>$${state.waxUsd.toFixed(5)}</b>`;
    // A node roster and a raw pool count are things the author cares about.
    // What a reader wants from a footer is how old the numbers are.
    // Volume refreshes hourly, everything else daily, so say which is which
    // rather than stamping one time over both.
    let txt = state.volumeAt
      ? `Volume ${ago(new Date(state.volumeAt).toISOString())} · rest ${ago(new Date(state.loadedAt).toISOString())}`
      : (state.loadedAt ? `Updated ${ago(new Date(state.loadedAt).toISOString())}` : '');
    // Which build this browser is actually running. Pages caches code for ten
    // minutes, so "it is still broken" and "the fix is live" can both be true
    // at once, and without this neither of us can tell which.
    const build = (import.meta.url.split('?v=')[1] || '').slice(0, 7);
    if (build) txt += `${txt ? ' · ' : ''}build ${build}`;
    $('#freshness').textContent = txt;

    // Pages sends max-age=600 on index.html and that is not configurable. The
    // page therefore keeps pointing at the PREVIOUS deploy's stamped modules
    // for up to ten minutes, and an ordinary reload does not go and look. From
    // the reader's side a fix that shipped and a fix that never happened are
    // the same thing, and the only way out was to know to hard-refresh.
    //
    // So the page checks. One conditional request for a 12 KB document, and if
    // the deploy on the server is not the one running here, it says so and
    // offers the reload that actually works.
    if (build) checkForNewer(build);
    if (loadError) {
      banner(`<div class="freshbar">Showing the last snapshot, ${ago(new Date(state.loadedAt).toISOString())}.
        Live chain read failed &mdash; wallet lookups and the trade feed need it. <button class="btn ghost" id="goLive">Try again</button></div>`);
    } else if (state.fromSnapshot) {
      banner(`<div class="freshbar">Snapshot from ${ago(new Date(state.loadedAt).toISOString())}, rebuilt every two hours. Pools and wallets you open are read live.
        <button class="btn ghost" id="goLive">Refresh from chain</button></div>`);
    } else banner('');
    // Money left mid-flight outranks anything else on the page.
    resumeBanner().catch(() => {});
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
    banner(`<div class="freshbar">Showing the last snapshot, ${ago(new Date(state.loadedAt).toISOString())}.
      Pools and wallets you open are read live. <button class="btn ghost" id="goLive">Refresh everything from chain</button></div>`);
    const b = $('#goLive');
    if (b) b.onclick = async () => {
      b.disabled = true; b.textContent = 'Reading chain…';
      try {
        await loadCore({ force: true, onProgress: p => { if (p.msg) b.textContent = p.msg; } });
        groups = []; renderFarms(); renderOverview();
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
    if (view === 'farm' && arg) return void openFarm(decodeURIComponent(arg));
    if (view === 'account' && arg) { const a = decodeURIComponent(arg); show('wallet', a); $('#walletInput').value = a; return void lookupWallet(a); }
    if (lastView === 'tokens') renderTokens();
    else if (lastView === 'farms') renderFarms();
    else if (lastView === 'overview') renderOverview();
    else if (lastView === 'activity' && activityLoaded) renderActivity();
    else if (lastView === 'wallet') {
      // The wallet page was the one view the unit switch never reached, so the
      // header said WAX while every balance below it stayed in dollars. It
      // rebuilds from the account already on screen.
      const a = ($('#walletInput')?.value || '').trim();
      if (a) { walletShown = null; lookupWallet(a); }
    }
  } catch {}
}

function show(v, arg = null) {
  // Pools and farms are one table now. Old links, bookmarks and the partner's
  // own config still say "pools", and they should still arrive somewhere.
  if (v === 'pools') v = 'farms';
  // A view the partner turned off is not a view.
  if (hiddenViews.has(v)) v = CFG?.content?.defaultView && !hiddenViews.has(CFG.content.defaultView) ? CFG.content.defaultView : 'overview';
  if (!['pool', 'token', 'account', 'farm'].includes(v)) lastView = v;
  // A once-a-second recompute has no business running behind a page nobody is
  // looking at, and it holds every incentive row it read alive with it.
  if (v !== 'wallet') stopAccrual();
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
  // #account/<name> was a separate, thinner page. One wallet view now, so an
  // old link still lands somewhere useful.
  if (view === 'account' && arg) { const a = decodeURIComponent(arg); show('wallet', a); $('#walletInput').value = a; lookupWallet(a); return true; }
  if (view === 'wallet' && !arg && wallet.account()) { show('wallet'); autoWallet(); return true; }
  if (view === 'wallet' && arg) {
    const acct = decodeURIComponent(arg);
    show('wallet'); $('#walletInput').value = acct; lookupWallet(acct); return true;
  }
  // #compound/<account> was the old Liquidity page. One positions list now.
  if (view === 'compound' && arg) { const a = decodeURIComponent(arg); show('wallet', a); $('#walletInput').value = a; lookupWallet(a); return true; }
  if (view === 'farm' && arg) { openFarm(decodeURIComponent(arg)); return true; }
  if (view === 'leaders') { show('leaders'); renderLeaders(); return true; }
  if (['overview', 'pools', 'tokens', 'farms', 'wallet', 'activity'].includes(view)) {
    show(view);
    if (view === 'activity' && !activityLoaded) renderActivity();
    if (view === 'leaders') renderLeaders();
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
  const groups = seedApr(farmGroups());
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
    g.tooSmall = g.share > 0.33;      // at the overview's own reference size
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
          <span style="margin-left:auto" class="switchwrap">
            <span class="switchlabel">risky</span>
            <button class="switch" id="riskyToggle" role="switch" aria-checked="${showRisky}" aria-label="Show farms that emit more per day than their pool is worth"><span class="knob"></span></button>
          </span></h3><div id="ovRew"></div></div>
        <div class="card"><h3>Where the rates sit <span class="dim">— ${withApr.length} farms</span></h3><div id="ovApr"></div></div>
      </div>
    </div>
    <div class="section"><h3>Where the liquidity is</h3>
      <div class="grid g2">
        <div class="card"><h3>Deepest pools <span class="hero" id="ovTopHero"></span></h3><div id="ovTop"></div></div>
        <div class="card"><h3>Best paid liquidity <span class="dim">&mdash; fees earned in 7 days</span></h3><div id="ovDex"></div></div>
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
        <div class="card"><h3>Ending soon <span class="dim">&mdash; yield with a date on it</span></h3><div id="ovFee"></div></div>
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
    ? bars(byVol.map(t => ({ label: t.symbol, value: t.vol24, sub: `${t.pools} pools &middot; ${usd(t.depth1)} tradeable`, go: () => openToken(t.id) })), { fmt: usd, color: 'var(--c2)' })
    : Object.assign(document.createElement('div'), { className: 'chart-empty', textContent: 'Volume arrives with the next daily snapshot.' }));
  $('#ovTokTvl').appendChild(bars(byTvl.map(t => ({ label: t.symbol, value: t.tvl, sub: `${t.pools} pools &middot; ${usd(t.depth1)} tradeable at 1%`, go: () => openToken(t.id) })), { fmt: usd, color: 'var(--c1)' }));

  // What the pools actually PAID their providers last week, which is the
  // question someone with money to place has. It replaced a donut of which
  // venue holds what share of the value — true, and nothing anyone can act on.
  const paid = pools
    .map(p => {
      const perDay = p.vol7d > 0 ? p.vol7d / 7 : (p.vol24 > 0 ? p.vol24 : 0);
      return { p, fees: perDay * 7 * (lpCut(p) / 10000) };
    })
    .filter(x => x.fees > 0)
    .sort((a, b) => b.fees - a.fees)
    .slice(0, 8);
  $('#ovDex').appendChild(paid.length
    ? bars(paid.map(({ p, fees }) => ({
        label: `${p.symA}/${p.symB} ${(p.feeBps / 100).toFixed(2)}%`,
        value: fees,
        sub: `${usd(p.tvlReal)} pooled &middot; ${pct(feeApr(p))} a year at that rate`,
        go: () => openPool(`${p.dex}:${p.id}`),
      })), { fmt: usd, color: 'var(--c3)' })
    : Object.assign(document.createElement('div'), { className: 'chart-empty', textContent: 'No trading fees recorded this week.' }));

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
      ? `Including ${runaway} farm${runaway === 1 ? '' : 's'} that emit more in a day than their pool is worth.`
      : `${runaway} farm${runaway === 1 ? '' : 's'} hidden: each emits more in a day than its pool is worth.`;
    $('#ovRew').appendChild(n);
  }
  const rt = $('#riskyToggle');
  if (rt) rt.onclick = () => { showRisky = !showRisky; rt.setAttribute('aria-checked', String(showRisky)); renderOverview(); };

  $('#ovApr').appendChild(withApr.length
    ? histogram(withApr.map(g => g.aprAt), { fmtX: v => v.toFixed(0) + '%', color: 'var(--c3)', label: 'APR distribution' })
    : Object.assign(document.createElement('div'), { className: 'chart-empty', textContent: 'No computed APRs yet.' }));

  // Alcor only. Its fee is a real field on the pool row (0.05 / 0.30 / 1.00%);
  // the other venues charge one flat rate that this terminal takes from their
  // documentation, and charting an assumption next to a fact invents a "0.10%
  // tier" that does not exist.
  // Yield with a date on it. A farm ending in nine days is a rate you can still
  // take and then cannot, and nothing on the site said so — where the previous
  // chart here reported which fee tier holds the most value, which is a fact
  // about Alcor's tier design rather than about anyone's money.
  const now2 = Date.now();
  const ending = groups
    .filter(g => g.endsAt && g.endsAt > now2 && g.endsAt < now2 + 45 * 86400e3 && g.rewardRealDay > 0)
    .sort((a, b) => b.rewardRealDay - a.rewardRealDay)
    .slice(0, 8);
  $('#ovFee').appendChild(ending.length
    ? bars(ending.map(g => ({
        label: g.pool ? `${g.pool.symA}/${g.pool.symB}` : String(g.poolId),
        value: g.rewardRealDay,
        sub: `${Math.max(0, Math.round((g.endsAt - now2) / 86400e3))} days left &middot; ${usd(g.stakedReal ?? g.stakedUsd)} staked`,
        go: () => openFarm(g.key),
      })), { fmt: v => usd(v) + '/day', color: 'var(--c4)' })
    : Object.assign(document.createElement('div'), { className: 'chart-empty', textContent: 'No farm ends in the next six weeks.' }));

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
    // Cards have room for a bigger mark than a table row does, and on a card
    // the pair is the first thing being identified rather than a repeat of the
    // text beside it.
    const size = el.closest('.poscard, .ph') ? 26 : 18;
    el.appendChild(tb ? pairMark(ta, sa, tb, sb, { size }) : tokenMark(ta, sa, { size }));
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
  if (m.safeUsd === 0) return `<span class="trust bad" title="Alcor quotes no price for this token">unpriced by Alcor</span>`;
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
    const [key, side] = inp.dataset.f.split('.');
    // Start from what the filter actually holds, or the panel opens showing a
    // state the table is not in.
    if (!side) {
      if (inp.type === 'checkbox') inp.checked = !!store[key];
      else if (store[key] != null && store[key] !== '') {
        // A <select>'s value is not writable everywhere, so the option is
        // marked instead — and the whole thing is guarded, because a panel that
        // cannot show its own state must not take the page down with it.
        try {
          if (inp.tagName === 'SELECT') {
            for (const o of inp.options) o.selected = String(o.value) === String(store[key]);
          } else inp.value = store[key];
        } catch { /* leave it at its markup default */ }
      }
    }
    const apply = () => {
      if (side) { store[key] = store[key] || {}; store[key][side] = inp.value === '' ? null : num(inp.value); }
      // A checkbox reports "on", not true. Reading .value here set realOnly to
      // the string "on" when ticked and "" when not — truthy either way once it
      // had been touched.
      else store[key] = inp.type === 'checkbox' ? inp.checked : inp.value;
      onChange();
    };
    inp.oninput = apply;
    if (inp.type === 'checkbox') inp.onchange = apply;
  });
}

// ---------------------------------------------------------------- POOLS -----
// Sorted by what trades, not by what sits. Ranking on pooled value put
// NBG/WAXCASH fifth on $7,428 of liquidity and $0 of trading, while WAX/LFGK —
// $463 pooled turning over $366 in a day — did not appear at all. Depth is
// still a column, and still sortable; it is just not the question most people
// open this page with.

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
      <p class="sub" style="margin:10px 0 0">${qty(t.perDay)} ${esc(t.token)} a day on the front page. Ordered by spend; paying again extends it.</p>
    </div></div>`;
}

// Wired after the page is written, like every other control here.
//
// SCOPED to the box it belongs to. This markup is rendered on both the token
// page and the pool page, and both stay in the document — so a document-wide
// $('#promoBuy') always found whichever section comes first in index.html.
// Once a token page had rendered, the pool page's Promote button was left with
// no handler at all, while the day chips still moved the token page's price.
function wirePromote(root = document) {
  const buy = root.querySelector('#promoBuy');
  if (!buy || !promotionConfigured()) return;
  const t = promotionTerms();
  let days = 7;
  root.querySelectorAll('[data-promo-days]').forEach(b => b.onclick = () => {
    root.querySelectorAll('[data-promo-days]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    days = Number(b.dataset.promoDays);
    const c = root.querySelector('#promoCost'); if (c) c.textContent = `${qty(days * t.perDay)} ${t.token}`;
  });
  buy.onclick = async () => {
    const out = root.querySelector('#promoOut');
    if (!wallet.account()) { try { await wallet.connect(); } catch { return; } }
    const built = buildPromotion({ kind: buy.dataset.kind, id: buy.dataset.id, days, terms: t, me: wallet.account() });
    out.innerHTML = `<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">
      Send <b>${qty(built.amount)} ${esc(t.token)}</b> to <span class="mono">${esc(t.account)}</span> for <b>${days} days</b> of promotion.
      ${t.account === 'eosio.null' ? '<br><span class="dim">Burned on arrival, so it costs supply rather than paying anyone.</span>' : ''}
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="promoSign">Sign and promote</button></div></div>`;
    $('#promoSign').onclick = async () => {
      out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
      try {
        const r = await wallet.transact(built.actions, { verify: true });
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
    <p class="sub" style="margin:10px 0 0">Paid slots, ordered by spend.${live.length > rows.length ? ` ${live.length - rows.length} more waiting below.` : ''}</p>`;

  box.querySelectorAll('tr[data-promo]').forEach(tr => {
    const [kind, id] = tr.dataset.promo.split('|');
    tr.onclick = rowClick(() => (kind === 't' ? openToken(id) : kind === 'f' ? openFarm(id) : openPool(id)));
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
      go: () => openFarm(id) });
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
    <p class="sub" style="margin:10px 0 0">${watchCount()} followed, in this browser only.</p>`;

  box.querySelectorAll('tr[data-watch]').forEach(tr => {
    const [kind, id] = tr.dataset.watch.split('|');
    const it = items.find(x => x.kind === kind && x.id === id);
    tr.onclick = rowClick(() => it?.go());
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


// --------------------------------------------------------------- TOKENS -----
// Same argument as the pools table: what trades, not what sits.
const tokFilters = { q: '', solidOnly: true, sort: 'vol24', dir: -1, lens: 'all' };
// A lens is a question, not a sort order: each one also decides which tokens can
// answer it. "Gainers" ranked over tokens with no comparable price yesterday is
// a list of nulls, and "trending" over tokens with no week behind them is a list
// of whatever first traded this morning.
const LENSES = {
  all:      { sort: 'vol24' },
  trending: { sort: 'heat',     where: t => t.heat != null,
              note: 'By multiple of its own weekly run rate.' },
  gainers:  { sort: 'change24', where: t => t.change24 != null && t.change24 > 0 },
  losers:   { sort: 'change24', dir: 1, where: t => t.change24 != null && t.change24 < 0 },
  new:      { sort: 'bornAt',   where: t => t.bornAt != null,
              note: 'Newest first, by the day the first pool for it appeared.' },
  volume:   { sort: 'vol24',    where: t => t.vol24 > 0 },
};
let tokRows = null;

function wireTokens() {
  wireCsv('#view-tokens .toolbar', '#tokCount', 'wax-tokens', 'tokens');
  $('#tokSearch').oninput = e => { tokFilters.q = e.target.value.trim().toLowerCase(); renderTokens(); };
  document.querySelectorAll('#tokLens [data-lens]').forEach(b => b.onclick = () => {
    tokFilters.lens = b.dataset.lens;
    const l = LENSES[tokFilters.lens];
    tokFilters.sort = l.sort;
    tokFilters.dir = l.dir ?? -1;
    document.querySelectorAll('#tokLens [data-lens]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderTokens();
  });
  $('#fTokSolid').onclick = e => {
    tokFilters.solidOnly = !tokFilters.solidOnly;
    e.target.setAttribute('aria-pressed', String(tokFilters.solidOnly));
    renderTokens();
  };
}

// Every live lock on WAX, soonest first — the supply calendar.
//
// One table read, already made for the per-token float figure, shown as the
// thing a holder can act on: what is about to stop being locked, whose it is,
// and how much of that token it represents. Every row links onward, because a
// date on its own is trivia.
let unlocksDrawn = false;
async function renderUnlocks() {
  if (unlocksDrawn) return;
  const box = $('#unlockTable'), sec = $('#unlockSection');
  if (!box || !sec) return;
  let rows = [];
  try { rows = await upcomingUnlocks({ limit: 25 }); } catch { return; }
  if (!rows.length) return;
  unlocksDrawn = true;
  sec.hidden = false;

  const priced = id => state.prices.get(id)?.usd ?? null;
  box.innerHTML = `<div class="tablewrap" style="border:0"><table style="font-size:12.5px">
    <thead><tr><th>Token</th><th class="r">Unlocks</th><th class="r">Worth now</th><th>To</th><th class="r">When</th></tr></thead>
    <tbody>${rows.map(r => {
      const px = priced(r.tokenId);
      return `<tr>
        <td><span data-pm="${esc(r.tokenId)}|${esc(r.symbol)}"></span>${tokLink(r.tokenId, r.symbol)}</td>
        <td class="r num">${qty(r.amount)}</td>
        <td class="r num ${px ? '' : 'dim'}">${px ? usd(r.amount * px) : 'unpriced'}</td>
        <td>${acctLink(r.receiver)}</td>
        <td class="r num dim" title="${new Date(r.at).toISOString().slice(0, 10)}">${Math.max(0, Math.round((r.at - Date.now()) / 86400000)).toLocaleString()}d</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
  fillMarks(box);
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
    const lens = LENSES[tokFilters.lens];
    if (lens?.where && !lens.where(t)) return false;
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
    { k: 'change24', label: '24h', r: true, s: true },
    { k: 'vol24', label: 'Vol 24h', r: true, s: true },
    { k: 'vol7d', label: 'Vol 7d', r: true, s: true },
    { k: 'vol30d', label: 'Vol 30d', r: true, s: true },
    { k: 'depth1', label: 'Trade depth', r: true, s: true },
    { k: 'taxBps', label: 'Transfer tax', r: true, s: true },
    { k: 'backing', label: 'Backed by', s: false },
    { k: 'pools', label: 'Pools', r: true, s: true },
    { k: 'bornAt', label: 'First seen', r: true, s: true },
  ];
  if (tokFilters.lens === 'trending') cols.splice(6, 0, { k: 'heat', label: 'vs its week', r: true, s: true });
  const thead = $('#tokTable thead');
  thead.innerHTML = '<tr>' + cols.map(c => `<th class="${c.r ? 'r ' : ''}${c.s ? 'sortable' : ''}" data-k="${c.k}">${c.label}${tokFilters.sort === c.k ? ` <span class="dir">${tokFilters.dir < 0 ? '▾' : '▴'}</span>` : ''}</th>`).join('') + '</tr>';
  thead.querySelectorAll('th.sortable').forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    if (tokFilters.sort === k) tokFilters.dir *= -1; else { tokFilters.sort = k; tokFilters.dir = -1; }
    renderTokens();
  });

  const lens = LENSES[tokFilters.lens];
  const hrs = state.prevAt ? (state.loadedAt - state.prevAt) / 3600e3 : null;
  const lensNote = $('#tokLensNote');
  if (lensNote) {
    // "24h" is whatever the gap between the last two snapshots actually was,
    // and rounding that to a flat 24 is the kind of small lie that makes every
    // number beside it suspect.
    const span = hrs ? `Change is measured against the snapshot ${hrs.toFixed(1)}h earlier.` : 'No earlier snapshot to compare prices against yet.';
    lensNote.innerHTML = lens.note ? `${esc(lens.note)} <span class="dim">${esc(span)}</span>`
      : (/gainers|losers/.test(tokFilters.lens) ? `<span class="dim">${esc(span)}</span>` : '');
    lensNote.hidden = !lensNote.innerHTML;
  }

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
      <td class="r num ${t.change24 == null ? 'dim' : t.change24 >= 0 ? 'pos' : 'neg'}" title="${t.change24 == null
        ? 'No comparable price in the previous snapshot' : `${esc(t.symbol)} was $${t.priceWas < 0.01 ? t.priceWas.toPrecision(3) : t.priceWas.toFixed(4)}`}">${
        t.change24 == null ? '—' : (t.change24 >= 0 ? '+' : '') + t.change24.toFixed(1) + '%'}</td>
      <td class="r num">${t.vol24 > 0 ? usd(t.vol24) : '<span class="dim">—</span>'}</td>
      <td class="r num ${t.vol7d > 0 ? '' : 'dim'}">${t.vol7d > 0 ? usd(t.vol7d) : '—'}</td>
      <td class="r num ${t.vol30d > 0 ? '' : 'dim'}">${t.vol30d > 0 ? usd(t.vol30d) : '—'}</td>
      ${tokFilters.lens === 'trending' ? `<td class="r num" title="${usd(t.vol24)} today against ${usd((t.vol7d || 0) / 7)} a day over the week">${t.heat.toFixed(1)}&times;</td>` : ''}
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
    </tr>`).join('') || `<tr><td colspan="${cols.length}" class="empty">No tokens match.</td></tr>`;
  fillMarks($('#tokTable tbody'));
  fillStars($('#tokTable tbody'));
  $('#tokTable tbody').querySelectorAll('tr[data-tok]').forEach(tr => tr.onclick = rowClick(() => openToken(tr.dataset.tokid)));
}

// ---------------------------------------------------------------- FARMS -----
// Rows are POOLS, not incentives: 633 of 1,883 farmed pools run several
// incentives at once and a user experiences that as one farm paying several
// tokens. Listing raw incentives would show the same pool ten times.
// One page, one filter set. Pools and farms were two tables answering halves of
// the same question — what is this market worth, and what does it pay — and a
// reader had to hold one in their head while looking at the other.
const farmFilters = { q: '', dex: 'all', hideDust: true, farmed: 'any', realOnly: false, expired: false,
  sort: 'aprAt', dir: -1, feeWindow: '7d',
  // A reference deposit, not a control. The rate a farm quotes is the rate its
  // incumbents get, and on a farm holding three dollars that is a number nobody
  // can act on — your own money is what gives it a denominator. $100 is small
  // enough not to flatter anything and large enough to clear the floor. What
  // YOUR deposit does is answered where you make that decision, on the position
  // panel, rather than by a box on a table.
  size: 100,
  apr: {}, rewards: {}, staked: {}, tokens: {}, reward: '', tvl: {}, fee: {} };
let groups = [];

// What a farm pays YOU, not what it pays the person already in it. Your deposit
// joins the pot, so your share is size/(staked+size) and your return is
// rewards*365/(staked+size). A 296% APR on $35 of staked capital becomes 18.8%
// the moment you put $500 in; a 239% on $850 stays at 151%. Ranking on the
// headline number sorts by how empty a farm is, which is why the top of the
// list was full of pools nobody would touch.
// An APR that says "computing…" forever is worse than no column.
//
// Valuing an Alcor farm live means reading every position in its pool, so the
// page could only ever afford the fourteen rows at the top of the screen and
// every other row sat on "computing…" until the tab was closed. The nightly
// pass already reads all of them to build the boards, so the denominator is
// measured — it just was not being published. Now it is, and autoApr refreshes
// whatever is actually on screen with a live figure on top of it.
//
// Applied wherever farmGroups() is used, because opening a farm page directly
// showed a dash for the same reason the table showed "computing…".
function seedApr(groups) {
  for (const g of groups) {
    if (g.dex !== 'alcor' || g.aprStatus !== 'lazy') continue;
    const st = poolStakedUsd(g.key);
    if (st == null) continue;
    g.stakedUsd = st;
    const ratio = g.pool?.tvl > 0 ? Math.min(1, (g.pool.tvlReal || 0) / g.pool.tvl) : 0;
    g.stakedReal = st * ratio;
    if (st >= MIN_STAKE_FOR_APR_USD && g.rewardUsdDay > 0) { g.apr = (g.rewardUsdDay * 365 / st) * 100; g.aprStatus = 'nightly'; }
    // Name the reason that actually applies. A farm with plenty staked and a
    // reward token nothing will price is not "too little staked", and telling
    // someone to look at the stake sends them after the wrong thing.
    else if (!(g.rewardUsdDay > 0)) g.aprStatus = 'unpriceable';
    else g.aprStatus = !(st > 0) ? 'no_stake' : 'thin';
    if (g.stakedReal >= MIN_STAKE_FOR_APR_USD && g.rewardRealDay > 0) g.aprReal = (g.rewardRealDay * 365 / g.stakedReal) * 100;
  }
  return groups;
}

function aprAtSize(g, size) {
  // rewardRealDay is the reward discounted by what it could actually be sold
  // for. A farm paying a token with a face value and no exit is paying nothing
  // anyone can spend, and dividing by it would quote a rate on money that does
  // not come out. The caller names that reason rather than blaming the stake.
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
  wireCsv('#view-farms .toolbar', '#farmCount', 'wax-markets', 'markets');
  $('#farmSearch').oninput = e => { farmFilters.q = e.target.value.trim().toLowerCase(); renderFarms(); };
  const tog = (key, id) => $(id).onclick = e => { farmFilters[key] = !farmFilters[key]; e.target.setAttribute('aria-pressed', String(farmFilters[key])); renderFarms(); };
  tog('hideDust', '#fLiq2');

  // One venue selector for the merged page, the way the pools table had it —
  // three states rather than two toggles that can both be off and show nothing.
  const setDex = d => {
    farmFilters.dex = d;
    [['all', '#fDexAll2'], ['alcor', '#fFarmAlcor'], ['taco', '#fFarmTaco']]
      .forEach(([v, id]) => $(id)?.setAttribute('aria-pressed', String(d === v)));
    renderFarms();
  };
  $('#fDexAll2').onclick = () => setDex('all');
  $('#fFarmAlcor').onclick = () => setDex('alcor');
  $('#fFarmTaco').onclick = () => setDex('taco');

  $('#fFarmedOnly').onclick = e => {
    farmFilters.farmed = farmFilters.farmed === 'yes' ? 'any' : 'yes';
    e.target.setAttribute('aria-pressed', String(farmFilters.farmed === 'yes'));
    renderFarms();
  };

  // The window the fee APR is annualised from. Anything longer than a week is
  // history rather than a rate you could act on.
  $('#fNewPool').onclick = () => renderCreatePool($('#newPoolBox'));
  // No compute button: the daily job values every Alcor farm, so an APR is
  // either there or honestly absent. Asking a reader to press a button to find
  // out what a farm pays is asking them to do the terminal's work.
  const panel = $('#farmFilterPanel');
  panel.innerHTML = `<label>Fee APR window<select data-f="feeWindow">
      <option value="7d">7 days</option><option value="24h">24 hours</option></select></label>
    <label class="pick"><input type="checkbox" data-f="realOnly"><span>Earnable only</span></label>
    <label class="pick"><input type="checkbox" data-f="expired"><span>Show expired farms</span></label>`
    + rangeField('apr', 'APR', farmFilters, { unit: '%' })
    + rangeField('rewards', 'Rewards per day', farmFilters, { unit: 'USD' })
    + rangeField('staked', 'Staked value', farmFilters, { unit: 'USD' })
    + rangeField('tokens', 'Reward tokens', farmFilters, { unit: 'count', step: '1' })
    + `<label>Pays this token<input data-f="reward" placeholder="e.g. WAX" value=""></label>`;
  wireFilterPanel(panel, farmFilters, () => { groups._key = null; renderFarms(); });
  $('#fMoreFarm').onclick = e => { panel.hidden = !panel.hidden; e.target.setAttribute('aria-pressed', String(!panel.hidden)); };
}

function filteredGroups() {
  const minTvl = CFG?.content?.minTvlUsd ?? 100;
  return groups.filter(g => {
    if (farmFilters.dex !== 'all' && g.dex !== farmFilters.dex) return false;
    // Dust is a market nobody uses, not merely a small one — a pool that traded
    // a hundred dollars today has earned its row whatever its size. A farm is
    // never dust: something is being paid out there.
    if (farmFilters.hideDust && !g.farms.length) {
      const p = g.pool;
      if (!p || !((p.tvl ?? 0) >= minTvl || (p.vol24 ?? 0) >= minTvl)) return false;
    }
    if (farmFilters.farmed === 'yes' && !g.farms.length) return false;
    if (farmFilters.farmed === 'no' && g.farms.length) return false;
    if (farmFilters.realOnly && g.aprReal == null) return false;
    if (!inRange(g.pool?.tvlReal ?? -1, farmFilters.tvl)) return false;
    if (!inRange((g.pool?.feeBps ?? 0) / 100, farmFilters.fee)) return false;
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
  const key = `${state.loadedAt}:${farmFilters.expired}:${farmFilters.feeWindow}`;
  if (groups._key !== key) {
    // Expired farms are excluded by default: their reward rate is zero, so any
    // APR computed from one is arithmetic on a farm that stopped paying. They
    // are still worth being able to look at, which is what the toggle is for.
    groups = seedApr(farmGroups({ liveOnly: !farmFilters.expired }));
    // Trading fees are the other half of what a position in a farmed pool earns,
    // and they carry on after the incentive ends.
    for (const g of groups) {
      g.feeApr = feeApr(g.pool);
      // Mirrored onto the group so a column can sort on them: the table sorts
      // by g[key] and these all live one level down on the pool.
      g.vol24 = g.pool?.vol24 ?? null;
      g.vol7d = g.pool?.vol7d ?? null;
      g.tvlReal = g.pool?.tvlReal ?? null;
      g.turnover = g.pool?.turnover ?? null;
      g.change24 = g.pool?.change24 ?? null;
      g.bornAt = g.pool?.bornAt ?? null;
      // How many wallets are in it, and how many of those took the farm. The
      // staker count rides on the incentive row; the provider count comes from
      // the nightly pass, because counting it live means reading every position
      // in every pool.
      g.stakers = Math.max(0, ...g.farms.map(f => f.numStakes || 0)) || null;
      g.lps = poolLpCount(`${g.dex}:${g.poolId}`);
    }

    // Every pool, farmed or not. A pool with no farm still pays its providers,
    // and some pay better than farmed ones — WAX/WUF returns 76.7% on fees
    // alone with nothing staked on it. The dust filter decides what is worth
    // drawing; the build no longer decides it in advance, because that made
    // this a list of incentives rather than a list of markets.
    const farmed = new Set(groups.map(g => `${g.dex}:${g.poolId}`));
    for (const p of state.pools) {
      if (farmed.has(`${p.dex}:${p.id}`)) continue;
      const fa = feeApr(p);
      groups.push({
        key: `${p.dex}:${p.id}`, dex: p.dex, poolId: p.id, pool: p,
        farms: [], rewards: [], rewardUsdDay: 0, rewardRealDay: 0,
        stakedUsd: null, stakedReal: null,
        vol24: p.vol24 ?? null, vol7d: p.vol7d ?? null, tvlReal: p.tvlReal ?? null,
        turnover: p.turnover ?? null, change24: p.change24 ?? null, bornAt: p.bornAt ?? null,
        apr: null, aprReal: null, aprAt: null, aprStatus: 'no_farm',
        feeApr: fa, tokenCount: 0, newestId: 0, endsAt: null, feesOnly: true,
        // A pool without a farm still has providers, and the nightly pass
        // counted them. Leaving this off put a dash in the column for two
        // thirds of the table.
        lps: poolLpCount(`${p.dex}:${p.id}`), stakers: null,
      });
    }
    groups._key = key; groups._at = state.loadedAt;
  }
  const rows = filteredGroups();
  for (const g of rows) {
    // The rate YOU would get, not the one the person already in it gets. It is
    // also what makes most of this column exist at all: an APR needs a
    // denominator worth dividing by, and on a farm holding three dollars your
    // own deposit is what provides one. With no amount entered the floor blocks
    // 197 of 400 rows and the table looks broken.
    g.aprAt = aprAtSize(g, farmFilters.size || 0) ?? (g.aprReal ?? g.apr);
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

  // Facts about the markets ON SCREEN, not about the whole chain.
  //
  // What was here: the single best APR after dilution, the median APR, how many
  // farms pay more than one token and the largest number of tokens any of them
  // pays. A best-of is already the top row of a sorted table; a median APR is
  // not a thing anyone acts on; and the count of multi-token farms answers a
  // question nobody asked. One of them was also simply wrong — "of 21,412
  // farmed pools" counted every pool on the chain, because this table stopped
  // being a list of farms when pools and farms merged and the label did not.
  const shown = rows;
  const pooled = shown.reduce((a, g) => a + (g.pool?.tvlReal || 0), 0);
  const face = shown.reduce((a, g) => a + (g.pool?.tvl || 0), 0);
  const vol = shown.reduce((a, g) => a + (g.pool?.vol24 || 0), 0);
  const farmed = shown.filter(g => g.farms.length);
  const payReal = farmed.reduce((a, g) => a + (g.rewardRealDay || 0), 0);
  // Yield with a deadline. "64% of what you are looking at is farmed" is a fact
  // about the filter; this is a fact about money that stops.
  const soonest = Date.now() + 7 * 86400e3;
  const soon = farmed.filter(g => g.endsAt && g.endsAt > Date.now() && g.endsAt < soonest);
  const feeDay = shown.reduce((a, g) => {
    const p2 = g.pool; if (!p2) return a;
    const perDay = p2.vol7d > 0 ? p2.vol7d / 7 : (p2.vol24 > 0 ? p2.vol24 : 0);
    return a + perDay * (lpCut(p2) / 10000);
  }, 0);
  $('#farmStats').innerHTML = `
    <div class="stat"><span class="v">${usd(pooled)}</span><span class="k">pooled here</span><span class="sub">${
      face > pooled * 1.05 ? `${usd(face)} at face value` : 'fully backed'}</span></div>
    <div class="stat"><span class="v">${usd(vol)}</span><span class="k">traded in 24h</span><span class="sub">across ${shown.length.toLocaleString()} market${shown.length === 1 ? '' : 's'}</span></div>
    <div class="stat"><span class="v">${usd(feeDay + payReal)}</span><span class="k">paid to providers daily</span><span class="sub">${usd(feeDay)} in trading fees &middot; ${usd(payReal)} from farms</span></div>
    <div class="stat"><span class="v">${soon.length.toLocaleString()}</span><span class="k">farms ending in 7 days</span><span class="sub">${
      soon.length ? `${usd(soon.reduce((a, g) => a + (g.rewardRealDay || 0), 0))} a day stops` : 'nothing runs out this week'}</span></div>`;
  const enterable = rows.filter(g => !g.tooSmall && g.aprAt != null).length;
  $('#farmCount').innerHTML = (farmFilters.size > 0
    ? `${enterable.toLocaleString()} can take ${usd(farmFilters.size)}<span class="dim"> &middot; ${rows.length.toLocaleString()} markets</span>`
    : `${rows.length.toLocaleString()} markets`)
    + (rows.length > 250 ? '<span class="dim"> &middot; top 250 listed</span>' : '');

  // One row per market: what it holds, what it trades, what it pays. The two
  // rates stay in two columns and are never added — fee income does not stop
  // when an incentive does, and a single number would hide which half is which.
  const cols = [
    { k: 'rank', label: '', s: false },
    { k: 'pool', label: 'Pool', s: false },
    { k: 'aprAt', label: 'Farm APR', r: true, s: true, title: `What a ${usd(farmFilters.size)} deposit would earn, after joining dilutes the pot` },
    { k: 'feeApr', label: `Fee APR ${farmFilters.feeWindow}`, r: true, s: true },
    { k: 'tvlReal', label: 'Pooled value', r: true, s: true },
    { k: 'rewards', label: 'Pays per day', s: false },
    { k: 'stakedReal', label: 'Staked', r: true, s: true },
    { k: 'endsAt', label: 'Ends', r: true, s: true },
    { k: 'vol24', label: 'Vol 24h', r: true, s: true },
    { k: 'vol7d', label: 'Vol 7d', r: true, s: true },
    { k: 'change24', label: '24h', r: true, s: true },
    { k: 'bornAt', label: 'Age', r: true, s: true },
  ];
  const thead = $('#farmTable thead');
  thead.innerHTML = '<tr>' + cols.map(c => `<th class="${c.r ? 'r ' : ''}${c.s ? 'sortable ' : ''}" data-k="${c.k}"${c.title ? ` title="${esc(c.title)}"` : ''}>${c.label}${farmFilters.sort === c.k ? ` <span class="dir">${farmFilters.dir < 0 ? '▾' : '▴'}</span>` : ''}</th>`).join('') + '</tr>';
  thead.querySelectorAll('th.sortable').forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    if (farmFilters.sort === k) farmFilters.dir *= -1; else { farmFilters.sort = k; farmFilters.dir = -1; }
    renderFarms();
  });

  $('#farmCount').innerHTML = capNote(rows.length, cap('farms'), 'markets');
  $('#farmTable tbody').innerHTML = rows.slice(0, cap('farms')).map((g, i) => {
    const pool = g.pool
      ? `<span data-pm="${esc(g.pool.tokenA)}|${esc(g.pool.symA)}|${esc(g.pool.tokenB)}|${esc(g.pool.symB)}"></span>
         <span class="pairbig">${pairLinks(g.pool)}</span>
         ${g.runaway ? `<span class="badge bad" title="Pays ${usd(g.rewardRealDay)} a day into a pool holding ${usd(g.pool.tvlReal)}.">burning out</span>` : ''}`
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
           <b>${qty(r.perDay)}</b>&nbsp;${tokLink(tok, r.symbol)}</span>`).join('')
      + (list.length > 3 ? `<span class="rew more" title="${list.slice(3).map(([, r]) => qty(r.perDay) + ' ' + r.symbol).join(', ')}">+${list.length - 3}</span>` : '');
    // Show what you would get, with the headline underneath only when the two
    // differ enough to matter — that gap IS the size of the farm.
    // Show the move, not the destination. "62% → 43%" says what adding your
    // money does to the rate; a lone diluted number just looks like a worse farm.
    // The cell shows what the column sorts on. It used to show the headline
    // rate while the column ranked on the rate at your size, so a row could sort
    // high and read blank — which is most of why only a selection of APRs ever
    // appeared.
    // The cell shows what the column sorts on. It used to show the headline
    // rate while the column ranked on the rate at your size, so a row could sort
    // high and read blank — which is most of why only a selection of APRs ever
    // appeared.
    //
    // When there is no rate, the reason is worked out from the data rather than
    // read off aprStatus. That field is set by whichever branch got there first
    // and was reporting "too little staked" for 76 TacoSwap farms whose real
    // problem is that the reward cannot be sold at all.
    const rate = g.aprAt;
    const why = !g.farms.length ? ['—', 'No farm on this pool — the fee APR beside it is what it pays']
      : !(g.rewardUsdDay > 0) ? ['reward unpriced', 'Nothing will quote a price for what this farm pays']
      : !(g.rewardRealDay > 0) ? ['reward has no exit', 'The reward has a face value but no route out — nothing you could sell']
      : !(g.stakedReal > 0 || g.stakedUsd > 0) ? ['nobody staked', 'Nobody has staked, so there is no rate yet']
      : g.stakedReal == null ? ['not measured', 'The nightly pass has not reached this pool']
      : [`only ${usd(g.stakedReal ?? g.stakedUsd)} staked`, 'Too little staked to divide by'];
    const aprCell = rate != null
        ? `<span class="apr"${g.aprStatus === 'nightly' ? ' title="Staked value from last night\u2019s pass. Refreshes live for the rows on screen."' : ''}>${pct(rate)}</span>`
        : `<span class="dim" title="${esc(why[1])}">${esc(why[0])}</span>`;
    const rw = g.runwayDays;
    return `<tr class="clickable ${g.tooSmall ? 'faded' : ''}" data-pool="${g.dex}:${esc(g.poolId)}">
      <td class="rank">${i + 1}<span data-star="p|${esc(g.dex)}:${esc(String(g.poolId))}|${esc(g.pool ? g.pool.symA + '/' + g.pool.symB : String(g.poolId))}"></span></td>
      <td>${pool}</td>
      <td class="r">${aprCell}</td>
      <td class="r num ${g.feeApr ? '' : 'dim'}" title="${esc(feeAprWhy(g.pool))}">${g.feeApr != null ? pct(g.feeApr) : '—'}</td>
      <td class="r num" title="${g.pool ? `${usd(g.pool.tvl)} at face value` : ''}">${usd(g.pool?.tvlReal ?? null)}${
        g.pool && g.pool.tvl > (g.pool.tvlReal || 0) * 1.05 ? `<span class="nominal">${usd(g.pool.tvl)} face</span>` : ''}</td>
      <td>${chips}${g.rewardRealDay > 0 ? ` <span class="sub">${usd(g.rewardRealDay)}/day</span>` : ''}</td>
      <td class="r num ${g.stakedReal > 0 ? '' : 'dim'}">${g.stakedReal > 0 ? usd(g.stakedReal) : '—'}</td>
      <td class="r num ${rw != null && rw < 7 ? 'neg' : 'dim'}" title="${rw == null ? '' : `Rewards run out in about ${rw < 1 ? Math.round(rw * 24) + ' hours' : Math.round(rw) + ' days'} at today's rate`}">${
        g.expired ? '<span class="badge bad">expired</span>'
        : rw == null ? '—'
        : rw < 1 ? Math.round(rw * 24) + 'h'
        : rw < 400 ? Math.round(rw) + 'd' : '400d+'}</td>
      <td class="r num ${g.pool?.vol24 > 0 ? '' : 'dim'}">${g.pool?.vol24 > 0 ? usd(g.pool.vol24) : '—'}</td>
      <td class="r num ${g.pool?.vol7d > 0 ? '' : 'dim'}">${g.pool?.vol7d > 0 ? usd(g.pool.vol7d) : '—'}</td>
      <td class="r num ${g.pool?.change24 > 0 ? 'pos' : g.pool?.change24 < 0 ? 'neg' : 'dim'}">${
        g.pool?.change24 == null ? '—' : (g.pool.change24 > 0 ? '+' : '') + g.pool.change24.toFixed(1) + '%'}</td>
      <td class="r num dim">${g.pool?.bornAt ? age(g.pool.bornAt) : '—'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="${cols.length}" class="empty">Nothing matches.</td></tr>`;
  fillMarks($('#farmTable tbody'));
  fillStars($('#farmTable tbody'));
  // A farm row opens the farm. It used to open the pool, which answers a
  // different question and threw away everything specific to the farm.
  $('#farmTable tbody').querySelectorAll('tr[data-pool]').forEach(tr => tr.onclick = rowClick(() => openFarm(tr.dataset.pool)));
  // Fill in what the rows on screen are still missing, which then re-renders.
  autoApr();
}

// The rows on screen compute themselves. 69 Alcor groups arrived with an APR
// still uncomputed, the sort puts a missing one last, and the only way to fill
// them in was a button — so the biggest venue on WAX sat below the fold behind
// a press nobody knew to make.
let autoAprRunning = false;
async function autoApr() {
  if (autoAprRunning) return;
  const targets = filteredGroups()
    .sort((a, b) => ((a[farmFilters.sort] ?? -Infinity) - (b[farmFilters.sort] ?? -Infinity)) * farmFilters.dir)
    .slice(0, 14)
    .filter(g => (g.aprStatus === 'lazy' || g.aprStatus === 'nightly') && g.dex === 'alcor');
  if (!targets.length) return;
  autoAprRunning = true;
  try {
    // Two reads per group against public nodes, four at a time: enough to fill
    // a screen quickly without looking like a sweep.
    for (let i = 0; i < targets.length; i += 4) {
      await Promise.all(targets.slice(i, i + 4).map(async g => {
        try {
          const st = await groupStakedUsd(g);
          g.stakedUsd = st;
          const ratio = g.pool?.tvl > 0 ? Math.min(1, (g.pool.tvlReal || 0) / g.pool.tvl) : 0;
          g.stakedReal = st * ratio;
          if (st >= MIN_STAKE_FOR_APR_USD && g.rewardUsdDay > 0) { g.apr = (g.rewardUsdDay * 365 / st) * 100; g.aprStatus = 'ok'; }
          else if (!(g.rewardUsdDay > 0)) g.aprStatus = 'unpriceable';
          else g.aprStatus = !(st > 0) ? 'no_stake' : 'thin';
          g.aprReal = (g.stakedReal >= MIN_STAKE_FOR_APR_USD && g.rewardRealDay > 0)
            ? (g.rewardRealDay * 365 / g.stakedReal) * 100 : null;
        } catch { /* stays computable on a retry */ }
      }));
    }
    renderFarms();
  } finally { autoAprRunning = false; }
}


// --------------------------------------------------- WHAT THEY ARE DOING ----
// Dumping or accumulating, per token, over a week.
//
// A balance says what a wallet holds. A trade list says it was busy. Neither
// answers the question anyone actually has about somebody else's account —
// whether they are getting out of something or getting into it — and answering
// it needs both sides of every swap, because what you sent a venue and what the
// venue sent back are two different tokens.
//
// Round-tripping nets to roughly nothing, which is how an arbitrage bot reads
// here, and that is correct: it is not accumulating anything.
async function renderTradeFlow(account) {
  const box = $('#walletFlow');
  if (!box) return;
  box.innerHTML = '';
  let swaps = [];
  try { swaps = await accountSwaps(account, { hours: 168 }); } catch { return; }
  if (!swaps.length) return;
  const rows = tradeFlow(swaps, state.prices).filter(r => r.trades > 0).slice(0, 14);
  if (!rows.length) return;

  const netUsd = rows.reduce((a, r) => a + (r.netUsd || 0), 0);
  const sinceDays = Math.max(1, Math.round((Date.now() - Math.min(...swaps.map(s => s.ts))) / 86400e3));
  box.innerHTML = `<div class="section"><h3>What they have been trading
      <span class="dim">&mdash; ${swaps.length.toLocaleString()} swap legs over ${sinceDays} day${sinceDays === 1 ? '' : 's'}</span></h3>
    <div class="card">
      <div class="tablewrap" style="border:0;max-height:none"><table style="font-size:12.5px">
        <thead><tr><th>Token</th><th class="r">Bought</th><th class="r">Sold</th><th class="r">Net</th><th class="r">Worth now</th><th></th></tr></thead>
        <tbody>${rows.map(r => {
          const dir = r.net > 0 ? 'accumulating' : r.net < 0 ? 'getting out' : 'round-tripping';
          // A wallet that bought and sold nearly the same amount is not taking
          // a position, whatever the size of either leg.
          // Keeping 7% of everything you moved is not taking a position, it is
          // an arbitrage bot leaving a rounding error behind. The line is where
          // the net stops being a by-product of the turnover.
          const churn = (r.bought + r.sold) > 0 ? Math.abs(r.net) / (r.bought + r.sold) : 0;
          const label = churn < 0.15 ? 'round-tripping' : dir;
          return `<tr>
            <td><span data-pm="${esc(r.id)}|${esc(r.symbol)}"></span>${tokLink(r.id, r.symbol)}</td>
            <td class="r num ${r.bought > 0 ? 'pos' : 'dim'}">${r.bought > 0 ? qty(r.bought) : '—'}</td>
            <td class="r num ${r.sold > 0 ? 'neg' : 'dim'}">${r.sold > 0 ? qty(r.sold) : '—'}</td>
            <td class="r num ${r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : 'dim'}">${r.net > 0 ? '+' : ''}${qty(r.net)}</td>
            <td class="r num ${r.priced ? '' : 'dim'}">${r.priced ? usd(r.netUsd) : 'unpriced'}</td>
            <td><span class="pill ${label === 'accumulating' ? 'good' : label === 'getting out' ? 'bad' : ''}">${label}</span></td>
          </tr>`;
        }).join('')}</tbody></table></div>
      <p class="sub" style="margin:9px 0 0">Net ${usd(netUsd)} across everything priced.
        Both legs of each swap, so a token bought with another shows on both rows.</p>
    </div></div>`;
  fillMarks(box);
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
  // Four panes, one lookup. Everything still loads together — the split is
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
  $('#walletNewPos').onclick = async () => {
    const who = $('#walletInput').value.trim() || wallet.account();
    if (!who) { alert('Enter your account, or connect a wallet.'); return; }
    renderNewPosition(who);
  };
  $('#walletInput').onkeydown = e => { if (e.key === 'Enter') lookupWallet(e.target.value.trim()); };
  // No demo button. It held a stranger's account name, and pointing thousands
  // of visitors at someone's wallet because it made a convenient example is not
  // ours to do.
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
        <p class="sub" style="margin:10px 0 0">CPU refills over a day.</p>
      </div>

      <div class="card"><h3>Power up <span class="dim">&mdash; the CHEESE is burned, not paid to anyone</span></h3>
        <div class="toolbar" style="margin:0 0 8px">
          <button class="chip" data-pwtok="cheese" aria-pressed="true">Pay in CHEESE</button>
          <button class="chip" data-pwtok="wax">Pay in WAX</button>
        </div>
        <div class="toolbar" style="margin:0">
          ${[0.5, 2, 5, 20].map((a, i) => `<button class="chip" data-pw="${a}"${i === 1 ? ' aria-pressed="true"' : ''}>${a}</button>`).join('')}
          <span class="dim" id="pwUnit" style="font-size:12px">CHEESE</span>
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
        <p class="sub" style="margin:9px 0 0">${qty(r.staked.cpu)} WAX in CPU, ${qty(r.staked.net)} in NET.</p>
        <div id="unOut" style="margin-top:10px"></div>
        <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="unGo">Review</button></div>
      </div>

      <div class="card"><h3>Voting</h3>
        ${r.voter && (r.voter.proxy || r.voter.producers.length) ? `
          <p class="sub" style="margin:0 0 10px">Voting ${r.voter.proxy ? acctLink(r.voter.proxy) : `${r.voter.producers.length} producers`}${r.voter.weight > 0 ? '' : ' &mdash; weight decayed to nothing'}.</p>`
        : `<p class="sub" style="margin:0 0 10px"><b class="neg">Not voting</b> &mdash; this stake earns nothing.</p>`}
        <div class="toolbar" style="margin:0">
          <span class="sub">Proxy</span>
          <input class="search" id="voteProxy" value="${esc(r.voter?.proxy || CFG?.commercial?.stakeProxy || 'waxcommunity')}" style="max-width:200px" spellcheck="false">
          <button class="btn" id="voteGo">Vote</button>
        </div>
        <label class="pick" style="margin-top:10px"><input type="checkbox" id="voteAuto"${autoVoteOn() ? ' checked' : ''}>
          <span class="sub">Re-cast this vote on every claim, so the weight never decays</span></label>
        <div id="voteOut" style="margin-top:10px"></div>
              </div>

      <div class="card"><h3>Refund queue</h3>
        ${refund ? `<div class="stats" style="margin:0 0 10px">
            <div class="stat"><span class="v">${qty(refund.total)} WAX</span><span class="k">on its way back</span><span class="sub">${qty(refund.cpu)} from CPU, ${qty(refund.net)} from NET</span></div>
            <div class="stat"><span class="v ${ready ? 'pos' : ''}">${ready ? 'ready' : ago(new Date(refund.readyAt).toISOString()).replace(' ago', '')}</span><span class="k">${ready ? 'claim it' : 'until it lands'}</span><span class="sub">unstaked ${ago(new Date(refund.at).toISOString())}</span></div>
          </div>
          <div id="rfOut"></div>
          <div class="toolbar" style="margin:0"><button class="btn" id="rfGo"${ready ? '' : ' disabled'}>Collect refund</button></div>`
        : `<p class="sub" style="margin:0">Nothing unstaking.</p>`}
      </div>
    </div>
  </div>`;

  // ---- power up ------------------------------------------------------------
  let pw = 2;
  const pwNote = $('#pwNote');
  let pwTok = 'cheese';
  let pwGen = 0;
  const paintPw = async () => {
    const mine = ++pwGen;
    const unit = $('#pwUnit'); if (unit) unit.textContent = pwTok === 'wax' ? 'WAX' : 'CHEESE';
    if (pwTok === 'wax') {
      let bought = null;
      try {
        const b = await buildPowerupVia({ amount: pw, target: account, from: 'WAX@eosio.token', to: 'CHEESE@cheeseburger', me: account });
        bought = b.buys;
      } catch { /* no route or no price; the note says so */ }
      // A quote is a network call, so a stale one must not overwrite a fresh one.
      if (mine !== pwGen) return;
      pwNote.innerHTML = bought
        ? `${pw} WAX buys at least ${qty(bought)} CHEESE, which is burned for roughly ${qty(bought * 1.81)} WAX of CPU and NET for a day. One transaction.`
        : `${pw} WAX cannot be routed to CHEESE right now.`;
      return;
    }
    // Priced from what the service has actually done: 2,636 CHEESE bought 4,778
    // WAX of powerup over its life. An observed rate, not a promised one.
    const waxish = pw * 1.81;
    pwNote.innerHTML = `${pw} CHEESE buys roughly ${qty(waxish)} WAX of CPU and NET for a day, going by what this service has historically delivered.
      The CHEESE is burned to <span class="mono">eosio.null</span> &mdash; it pays nobody, it leaves circulation.`;
  };
  paintPw();
  out.querySelectorAll('[data-pwtok]').forEach(b => b.onclick = () => {
    out.querySelectorAll('[data-pwtok]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    pwTok = b.dataset.pwtok; paintPw();
  });
  out.querySelectorAll('[data-pw]').forEach(b => b.onclick = () => {
    out.querySelectorAll('[data-pw]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    pw = Number(b.dataset.pw); paintPw();
  });
  $('#pwGo').onclick = async () => {
    const box = $('#pwOut');
    if (!wallet.account()) { try { await wallet.connect(); } catch { return; } }
    const built = pwTok === 'wax'
      ? await buildPowerupVia({ amount: pw, target: account, from: 'WAX@eosio.token', to: 'CHEESE@cheeseburger', me: wallet.account() })
      : buildPowerup({ amount: pw, target: account, token: cheese, me: wallet.account() });
    box.innerHTML = `<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">
      ${pwTok === 'wax' ? `Sell <b>${pw} WAX</b> for CHEESE and burn it` : `Send <b>${pw} CHEESE</b> to <span class="mono">cheesepowerz</span>`} to power up <span class="mono">${esc(account)}</span>.
      <br><span class="dim">One transfer. The service burns the CHEESE.</span>
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="pwSign">Sign and power up</button></div></div>`;
    $('#pwSign').onclick = async () => {
      box.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
      try {
        const tx = await wallet.transact(built.actions, { verify: true });
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
      <br><span class="dim">In your wallet in three days. Not staked, not spendable, not earning.</span>
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="unSign">Sign and unstake</button></div></div>`;
    $('#unSign').onclick = async () => {
      box.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
      try {
        const tx = await wallet.transact(built.actions, { verify: true });
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
          <thead><tr><th></th><th>Market</th><th class="r">Price</th><th class="r">Size</th><th class="r">Placed</th></tr></thead>
          <tbody>${orders.map(o => {
            const m = byId.get(o.marketId);
            return `<tr>
              <td class="${o.side === 'buy' ? 'pos' : 'neg'}">${o.side}</td>
              <td>${m ? esc(m.quote.symbol) + '/' + esc(m.base.symbol) : '#' + o.marketId}</td>
              <td class="r num">${qty(o.price)}</td>
              <td class="r num">${qty(o.quote)}${m ? ' <span class="sub">' + esc(m.quote.symbol) + '</span>' : ''}</td>
              <td class="r num dim">${ago(new Date(o.at).toISOString())}</td>
            </tr>`;
          }).join('')}</tbody></table></div>
          <p class="sub" style="margin:10px 0 0">${orders.length} open. Cancel them on Alcor.</p>
        </div></div>`;
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
  lockForeign(account);
}

// Every signing path in this app reports a decline the same way, and a decline
// is not an error worth alarming anyone about.
const txError = e => {
  const m = String(e?.message || e);
  if (/cancel|reject|declin/i.test(m)) return '<div class="err">You declined the signature — nothing happened.</div>';
  if (e?.simulated) return `<div class="err"><b>Stopped before sending.</b> A node ran this and it would have failed:
    <br><span class="mono" style="font-size:11.5px">${esc(m)}</span>
    <br><span class="sub">Nothing was broadcast, so it cost you no CPU or NET.</span></div>`;
  return `<div class="err">${esc(m)}</div>`;
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

  out.innerHTML = `<div class="section"><h3>Staked WAX</h3>
    <div class="stats">
      <div class="stat"><span class="v">${qty(info.staked)} WAX</span><span class="k">staked</span><span class="sub">${waxUsd ? usd(info.staked * waxUsd) : '&nbsp;'}</span></div>
      <div class="stat"><span class="v ${info.voting ? 'pos' : 'neg'}">${info.voting ? 'earning' : 'not earning'}</span><span class="k">vote</span><span class="sub">${info.voting
        ? (info.proxy ? `proxied to ${acctLink(info.proxy)}` : `${info.producers.length} producers`)
        : 'not voting'}</span></div>
      <div class="stat"><span class="v">${apr != null ? pct(apr) : '—'}</span><span class="k">observed rate</span><span class="sub">${apr != null ? 'from what was actually paid' : 'needs a week of claims to annualise'}</span></div>
      <div class="stat"><span class="v">${last ? qty(last.amount) + ' WAX' : '—'}</span><span class="k">last claim paid</span><span class="sub">${last ? ago(new Date(last.ts).toISOString()) : 'never claimed'}</span></div>
    </div>
    <div class="card">
      
      ${info.lastClaim && !ready ? `<p class="sub" style="margin:0 0 10px">Claimed ${ago(new Date(info.lastClaim).toISOString())}. One claim a day.</p>` : ''}
      ${info.voting && ready && waited > 7 ? `<p class="sub" style="margin:0 0 10px"><b>${waited} days</b> since the last claim. The claim re-casts your vote too, so the weight stops decaying.</p>` : ''}
      <div id="stakeSteps"></div>
      <div class="toolbar" style="margin:0">
        <button class="btn" id="stakeGo"${ready ? '' : ' disabled'}>Claim and restake</button>
      </div>
      <p class="sub" style="margin:10px 0 0">Two signatures${feeBps > 0 && feeAccount ? `, ${(feeBps / 100).toFixed(2)}% fee` : ''}.${!info.voting ? ` Also votes ${acctLink(CFG?.commercial?.stakeProxy || 'a proxy')} &mdash; without a vote it earns nothing.` : ''}</p>
    </div>
  </div>`;

  $('#stakeGo').onclick = () => runStake(account, info, feeBps, feeAccount, {});
  lockForeign(account);
}

// ---- pepperstake claims ----------------------------------------------------
// The same forgotten-rewards problem as the WaxDAO farms, on a contract that
// makes you collect each period separately before a withdraw pays anything.
// Someone away for six months is a hundred and eighty collect actions behind,
// which is not one transaction — so the batch is bounded and says what is left.
// ---- what this account has already been paid ------------------------------
// The terminal could say what was waiting to be collected and nothing about
// what had been collected — which is the wrong half. Measured on a real
// account: $5.54 of LP fees on show, $91.56 of farm rewards invisible.
// ---- farm rewards, accruing ------------------------------------------------
// Farm rewards are not a balance that changes when something happens. They
// accrue every second by a formula, and the chain only writes the number down
// when someone claims — so a table can only ever show you a stale figure.
//
// The rows are read once and the amount is recomputed from the clock, which
// costs nothing and shows the thing as it actually is: a number going up. A
// farm that has ended stops, because a counter still climbing on a finished
// farm is a lie that compounds every second it stays on screen.
let accrualTimer = null;
function stopAccrual() { if (accrualTimer) { clearInterval(accrualTimer); accrualTimer = null; } }

async function renderFarmAccrual(account, positions, joined) {
  const out = $('#walletAccrual');
  if (!out) return;
  stopAccrual();

  const staked = positions.filter(p => (joined.get(String(p.posId)) || []).length);
  if (!staked.length) { out.innerHTML = ''; return; }

  out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Reading what your farms owe you…</span></div>';
  let rows;
  try { rows = await pendingFarms(staked, joined, { prices: state.prices }); }
  catch { out.innerHTML = ''; return; }
  if (!rows.length) { out.innerHTML = ''; return; }

  // Same token from two farms on the same pool is one thing you are owed, not
  // two — measured on chain, pool 4356 pays ASSETS from two separate incentives.
  const byToken = new Map();
  for (const r of rows) {
    const t = byToken.get(r.tokenId) || { tokenId: r.tokenId, symbol: r.symbol, price: r.price, rows: [], live: 0 };
    t.rows.push(r);
    if (Date.now() < r.endsAt) t.live++;
    byToken.set(r.tokenId, t);
  }
  const tokens = [...byToken.values()];
  const ended = rows.filter(r => Date.now() >= r.endsAt).length;

  out.innerHTML = `<div class="card accrual">
    <h3>Farm rewards waiting <span class="dim">&mdash; accruing as you watch</span></h3>
    <div class="acc-head">
      <span class="acc-total" id="accTotal">—</span>
      <span class="acc-rate" id="accRate"></span>
    </div>
    <div class="acc-rows">${tokens.map((t, i) => `
      <div class="acc-row">
        <span data-pm="${esc(t.tokenId)}|${esc(t.symbol)}"></span>
        <span class="sym">${esc(t.symbol)}</span>
        <span class="amt" data-acc="${i}">—</span>
        <span class="rate" data-accrate="${i}"></span>
        <span class="usd" data-accusd="${i}">${t.price == null ? '<span class="dim">unpriced</span>' : ''}</span>
        <span class="src ${t.live ? 'farm' : ''}">${t.live ? `${t.live} live farm${t.live === 1 ? '' : 's'}` : 'ended'}</span>
      </div>`).join('')}</div>
    ${ended ? `<p class="sub" style="margin:9px 0 0">${ended} ended &mdash; still claimable, no longer growing.</p>` : ''}
    ${isMine(account) ? '<div class="toolbar" style="margin:11px 0 0"><button class="btn" id="accGo">Claim or compound these</button></div>' : ''}
  </div>`;

  fillMarks(out);
  const ag = $('#accGo');
  if (ag) ag.onclick = () => { document.querySelector('#walletTabs [data-wtab="balances"]')?.click(); $('#walletOut')?.scrollIntoView({ block: 'start' }); };

  // The tick. Everything below is arithmetic on rows already in memory.
  const paint = () => {
    const now = Date.now();
    let usd = 0, perSec = 0, anyPriced = false;
    tokens.forEach((t, i) => {
      const amt = t.rows.reduce((a, r) => a + pendingAt(r, now), 0);
      const rate = t.rows.reduce((a, r) => a + accrualPerSec(r, now), 0);
      const el = out.querySelector(`[data-acc="${i}"]`);
      if (el) el.textContent = qtyFine(amt);
      const rl = out.querySelector(`[data-accrate="${i}"]`);
      if (rl) rl.textContent = rate > 0 ? `+${qtyFine(rate * 86400)} / day` : '';
      if (t.price != null) {
        anyPriced = true;
        usd += amt * t.price; perSec += rate * t.price;
        const u = out.querySelector(`[data-accusd="${i}"]`);
        if (u) u.textContent = usd4(amt * t.price);
      }
    });
    // The same rows drive the figure on each position card, so a card and the
    // counter above it can never disagree.
    const perPos = new Map();
    for (const r of rows) {
      if (r.price == null) continue;
      perPos.set(r.posId, (perPos.get(r.posId) || 0) + pendingAt(r, now) * r.price);
    }
    document.querySelectorAll('[data-farmpend]').forEach(elp => {
      const v = perPos.get(elp.dataset.farmpend);
      elp.textContent = v > 0 ? usd4(v) : '—';
      elp.classList.toggle('dim', !(v > 0));
    });

    const tot = $('#accTotal'), rt = $('#accRate');
    if (tot) tot.textContent = anyPriced ? usd4(usd) : '—';
    if (rt) rt.textContent = perSec > 0
      ? `+${usd4(perSec * 86400)} a day · ${usd4(perSec * 3600)} an hour`
      : 'not growing — every farm here has ended';
  };
  paint();
  accrualTimer = setInterval(paint, 1000);
  lockForeign(account);
}

async function renderEarned(account) {
  const out = $('#walletEarned');
  if (!out) return;
  out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Reading what you have been paid…</span></div>';

  let hist;
  try { hist = await earningsHistory(account); }
  catch (e) { out.innerHTML = `<div class="err">Could not read your payout history: ${esc(e.message)}</div>`; return; }

  if (!hist.rows.length) {
    out.innerHTML = `<div class="empty">No LP fees, farm rewards or WaxDAO claims found for <span class="mono">${esc(account)}</span>.</div>`;
    return;
  }

  const s = summariseEarnings(hist.rows, state.prices);
  const kind = k => s.kinds.get(k) || 0;
  const span = s.firstAt ? Math.max(1, Math.round((Date.now() - s.firstAt) / 86400e3)) : 0;

  out.innerHTML = `
    <div class="stats">
      <div class="stat"><span class="v">${usdExact(s.usd)}</span><span class="k">collected all time</span><span class="sub">${s.claims.toLocaleString()} payouts over ${span} days</span></div>
      <div class="stat srcstat farm"><span class="v">${usdExact(kind('farm'))}</span><span class="k">farm rewards</span><span class="sub">paid by incentives you staked into</span></div>
      <div class="stat srcstat fee"><span class="v">${usdExact(kind('fees'))}</span><span class="k">LP fees</span><span class="sub">paid by trades through your ranges</span></div>
      ${kind('waxdao') + kind('pepperstake') > 0 ? `<div class="stat"><span class="v">${usdExact(kind('waxdao') + kind('pepperstake'))}</span><span class="k">WaxDAO &amp; PepperStake</span></div>` : ''}
      <div class="stat"><span class="v">${usd(s.perDay)}</span><span class="k">a day, averaged</span><span class="sub">over the whole period</span></div>
    </div>

    <p class="vs">Today's prices${s.unpriced ? ` &middot; ${s.unpriced} unpriced, left out` : ''}${hist.truncated.length ? ` &middot; <b>first 1,000 ${hist.truncated.join(' and ')} only</b>, so the real total is higher` : ''}.</p>

    <div class="grid g2">
      <div class="card"><h3>Paid out over time</h3><div id="earnSeries"></div></div>
      <div class="card"><h3>What you were paid in</h3><div id="earnTokens"></div></div>
    </div>

    <div class="card" style="margin-top:14px"><h3>Every token you have been paid</h3>
      <div class="tablewrap"><table><thead><tr>
        <th>Token</th><th class="r">Amount</th><th class="r">Worth now</th><th class="r">Payouts</th>
      </tr></thead><tbody>${s.tokens.map(t => `<tr>
        <td><span data-pm="${esc(t.tokenId)}|${esc(t.symbol)}"></span><span class="pairbig">${esc(t.symbol)}</span></td>
        <td class="r num">${qty(t.amount)}</td>
        <td class="r num ${t.priced ? '' : 'dim'}">${t.priced ? usdExact(t.usd) : 'unpriced'}</td>
        <td class="r num dim">${t.claims}</td>
      </tr>`).join('')}</tbody></table></div>
    </div>`;

  fillMarks(out);

  // A cumulative line, because the question is "how much has this made me",
  // and a daily bar answers "was yesterday good" instead.
  let run = 0;
  const cum = s.series.map(d => ({ x: new Date(d.day + 'T12:00:00Z').getTime(), y: (run += d.usd) }));
  const es = $('#earnSeries');
  if (es) {
    if (cum.length < 2) {
      es.innerHTML = '<div class="chart-empty">One payout so far &mdash; a line needs two.</div>';
    } else {
      // The real chart, with zoom and a crosshair that reads values, like every
      // other time series here. Hand-drawn SVG is right for a donut and a
      // ranking; it is the wrong tool for anything with a time axis.
      lineSeriesChart(es, cum.map(d => ({ time: Math.floor(d.x / 1000), value: d.y })),
        { height: 200, color: 'var(--c3)', fmt: usd })
        .catch(() => {
          es.innerHTML = '';
          es.appendChild(areaChart(cum, { height: 200, color: 'var(--c3)', fmtY: usd, fmtX: t => new Date(t).toISOString().slice(0, 10), label: 'Cumulative payouts' }));
        });
    }
  }
  $('#earnTokens')?.appendChild(donut(s.tokens.filter(t => t.usd > 0).map(t => ({ label: t.symbol, value: t.usd })), { fmt: usd, top: 6 }));
  lockForeign(account);
}

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
      <p class="sub" style="margin:10px 0 0">Up to 40 periods per pool per go.</p>
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
  lockForeign(account);
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
      <p class="sub" style="margin:10px 0 0">${total > 0 ? `${usd(total)} waiting. ` : ''}Estimated. <a href="https://cheesehubwax.github.io/cheesehub/farm" target="_blank" rel="noopener">CheeseHub &nearr;</a> to stake or create a farm.</p>
    </div>
  </div>`;

  $('#wdClaim').onclick = async () => {
    const farms = [...document.querySelectorAll('.wdpick:checked')].map(c => c.dataset.farm);
    const box = $('#wdSteps');
    if (!farms.length) { box.innerHTML = '<div class="err" style="margin-top:10px">Nothing selected.</div>'; return; }
    box.innerHTML = `<div class="loading" style="margin-top:10px"><span class="spinner"></span><span>Waiting for your wallet — claiming ${farms.length} farm${farms.length === 1 ? '' : 's'}…</span></div>`;
    try {
      const r = await wallet.transact(buildWaxdaoClaims({ account, farms }), { verify: true });
      box.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft);margin-top:10px"><b>Claimed.</b> ${farms.length} farm${farms.length === 1 ? '' : 's'} paid out to your wallet.
        <br><span class="mono" style="font-size:11px">${r.id.slice(0, 16)}…</span></div>`;
    } catch (e) {
      const m = String(e.message || e);
      box.innerHTML = `<div class="err" style="margin-top:10px">${/cancel|reject|declin/i.test(m) ? 'You declined the signature — nothing happened.' : esc(m)}</div>`;
    }
  };
  lockForeign(account);
}

// ---- balances, and sending them somewhere ----------------------------------
// Positions arrive later than balances — the sweep is the slow half — so the
// pie draws from what it has and redraws when they land.
let walletPositionsFor = null;
let redrawBalancePie = () => {};

// What a position is worth, split back into the two tokens it holds. A pie of
// "wallet only" and a pie of "everything I own" are different pictures, and on
// an account with most of its value in pools the first one is misleading.
function positionSlices(account) {
  if (!walletPositionsFor || walletPositionsFor.account !== account) return [];
  const out = new Map();
  for (const p of walletPositionsFor.list) {
    const pool = p.pool;
    if (!pool) continue;
    for (const [amt, id] of [[p.amountA, pool.tokenA], [p.amountB, pool.tokenB]]) {
      const px = id === pool.tokenA ? pool.priceUsdA : pool.priceUsdB;
      if (!(amt > 0) || px == null) continue;
      const sym = (state.tokens.get(id)?.symbol) || id.split('@')[0];
      out.set(sym, (out.get(sym) || 0) + amt * px);
    }
  }
  return [...out].map(([label, value]) => ({ label, value }));
}

async function renderWalletBalances(account) {
  const out = $('#walletBalances');
  if (!out) return;
  out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Reading balances…</span></div>';

  let info;
  try { info = await accountInfo(account); } catch { out.innerHTML = ''; return; }
  const v = valueBalances(info.balances, state.prices, state.depth);
  const priced = v.rows.filter(r => r.usd != null);

  // A pie of what the wallet is, before the list of what is in it. "82% WAX"
  // is a fact about a portfolio that a column of dollar figures makes you
  // work out for yourself.
  const slices = priced.filter(r => r.usd > 0).map(r => ({ label: r.symbol, value: r.usd }));

  out.innerHTML = `<div class="section"><h3>Balances</h3>
    <div class="grid g2">
      <div class="card"><h3>Split <span id="pieSum" class="dim"></span>
        <span style="margin-left:auto" class="switchwrap">
          <span class="switchlabel">with LPs</span>
          <button class="switch" id="pieLps" role="switch" aria-checked="false" aria-label="Include what is inside your liquidity positions"><span class="knob"></span></button>
        </span></h3>
        <div id="balPie"></div></div>
      <div class="card"><h3>What you hold <span class="dim">&mdash; ${usd(v.priced)}</span></h3>
        <div class="tablewrap" style="max-height:340px;border:0"><table style="font-size:12.5px"><tbody>${
          priced.slice(0, 40).map(r => `<tr class="clickable" data-tokid="${esc(r.id)}">
            <td><span data-pm="${esc(r.id)}|${esc(r.symbol)}"></span><span class="pairbig">${esc(r.symbol)}</span></td>
            <td class="r num">${qty(r.amount)}</td>
            <td class="r num">${usd(r.usd)}</td>
            <td class="r num dim">${v.priced > 0 ? (r.usd / v.priced * 100).toFixed(1) + '%' : '—'}</td></tr>`).join('')}</tbody></table></div>
        <p class="sub" style="margin:9px 0 0">${priced.length} priced &middot; ${v.unpriced} unpriceable &middot; ${info.zeroed.toLocaleString()} at zero</p></div>

      ${isMine(account) ? `<div class="card"><h3>Send</h3>
        <div class="filters" style="display:grid;gap:8px;margin:0">
          <label>Token<select id="sendTok">${v.rows.filter(r => r.amount > 0).map(r =>
            `<option value="${esc(r.id)}">${esc(r.symbol)} — ${qty(r.amount)} available</option>`).join('')}</select></label>
          <label>To<input id="sendTo" placeholder="account name" autocomplete="off" spellcheck="false"></label>
          <label>Amount<input id="sendAmt" type="number" step="any" min="0" placeholder="0.0000" inputmode="decimal"></label>
          <label>Memo<input id="sendMemo" placeholder="optional — required by most exchanges" autocomplete="off"></label>
        </div>
        <div id="sendOut" style="margin-top:10px"></div>
        <div class="toolbar" style="margin:10px 0 0">
          <button class="btn" id="sendGo">Review</button>
        </div>
      </div>` : ''}
    </div>
  </div>`;

  let withLps = false;
  const drawPie = () => {
    const pie = $('#balPie'), sum = $('#pieSum');
    if (!pie) return;
    // Wallet and position holdings of the same token are the same holding, so
    // they are added rather than listed twice.
    const merged = new Map(slices.map(x => [x.label, x.value]));
    if (withLps) for (const x of positionSlices(account)) merged.set(x.label, (merged.get(x.label) || 0) + x.value);
    const rows = [...merged].map(([label, value]) => ({ label, value })).filter(x => x.value > 0);
    const total = rows.reduce((a, x) => a + x.value, 0);
    pie.innerHTML = '';
    if (sum) sum.textContent = `— ${usd(total)} across ${rows.length} token${rows.length === 1 ? '' : 's'}${withLps ? ', wallet and pools' : ' in your wallet'}`;
    if (!rows.length) { pie.innerHTML = '<div class="chart-empty">Nothing here can be priced.</div>'; return; }
    // Eight named slices and the tail folded into one: past that the colours
    // stop being separable and a legend of thirty rows is not a chart.
    pie.appendChild(donut(rows, { size: 170, top: 8, fmt: v2 => `${usd(v2)} · ${(v2 / total * 100).toFixed(1)}%` }));
  };
  drawPie();
  redrawBalancePie = () => { if (walletShown === account) drawPie(); };
  const pl = $('#pieLps');
  if (pl) pl.onclick = () => {
    withLps = !withLps;
    pl.setAttribute('aria-checked', String(withLps));
    drawPie();
  };

  fillMarks($('#walletBalances'));
  out.querySelectorAll('tr[data-tokid]').forEach(tr => tr.onclick = rowClick(() => openToken(tr.dataset.tokid)));

  const balOf = id => v.rows.find(r => r.id === id)?.amount ?? 0;
  const sg = $('#sendGo');
  if (sg) sg.onclick = () => reviewSend(account, v.rows);
  lockForeign(account);
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
    ${!memo ? '<br><span class="dim">No memo &mdash; an exchange may not credit it.</span>' : ''}
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
// An interrupted compound reopens on the wallet now, so the record has to
// survive the navigation and be picked up once the cards exist.
let pendingResume = null;
// Someone else's wallet is a page you read. Actions need a signature from an
// account the viewer does not have, so a button there can only end in an error
// or a prompt against the wrong wallet.
const isMine = acct => !!wallet.account() && wallet.account() === acct;

// Belt and braces on top of the per-section gates: after a pane renders for an
// account that is not the connected one, every action in it is removed. A
// button I forget to gate is a button that prompts a wallet for a signature it
// cannot give, and that is worse than a missing feature.
function lockForeign(acct) {
  if (isMine(acct)) return;
  document.querySelectorAll('.wpane button.btn, .wpane select, .wpane input').forEach(el => el.remove());
  const bar = $('#walletReadonly');
  if (bar) {
    bar.textContent = `Viewing ${acct}. Connect that account to act on it.`;
    bar.hidden = false;
  }
}

function autoWallet() {
  const a = wallet.account();
  if (!a || walletShown === a) return false;
  $('#walletInput').value = a;
  lookupWallet(a);
  return true;
}

// Joining a farm is one stake action per incentive, in a single transaction.
// The position stays where it is and stays yours: staking tells the incentive
// to count it, and nothing in the action moves liquidity.
function wireJoinFarm(root, account) {
  root.querySelectorAll('button[data-joinfarm]').forEach(btn => {
    btn.onclick = async () => {
      const box = btn.closest('.pc-farm');
      const ids = btn.dataset.inc.split(',').filter(Boolean);
      const label = btn.textContent;
      if (!wallet.account()) { try { await wallet.connect(); } catch { return; } }
      if (wallet.account() !== account) { alert(`Connected as ${wallet.account()}, but this position belongs to ${account}.`); return; }
      btn.disabled = true; btn.textContent = 'Waiting for your wallet…';
      try {
        const tx = await wallet.transact(buildRestake({ position: { posId: btn.dataset.joinfarm }, incentiveIds: ids, me: account }).actions, { verify: true });
        box.className = 'pc-farm done';
        box.innerHTML = `<div><b>Staked into ${ids.length} farm${ids.length === 1 ? '' : 's'}.</b>
          <span class="sub">Rewards accrue from this block. <a class="mono" href="${trxUrl(tx.id)}" target="_blank" rel="noopener">${tx.id.slice(0, 16)}… &nearr;</a></span></div>`;
      } catch (e) {
        btn.disabled = false; btn.textContent = label;
        const m = String(e.message || e);
        box.querySelector('.sub').innerHTML = /cancel|reject|declin/i.test(m) ? 'You declined the signature — nothing happened.' : esc(m);
      }
    };
  });
}

// --------------------------------------------------------- position card ---
// A position is five questions and the old card answered them in a definition
// list, which is the layout you reach for when you have not decided which
// number matters: what is it worth, is it earning, what is it made of, what is
// owed to it, and what is it NOT collecting.
//
// So: value and P&L in the header where the eye lands, state as pills rather
// than prose, the price band drawn instead of described, the composition as a
// bar because a 52/48 split is a shape and not a pair of numbers, and the farm
// gap called out where it cannot be missed.
function positionCard(p, mine = false) {
  const pool = p.pool;
  const share = pool.tvl > 0 ? Math.min(1, p.valueUsd / pool.tvl) : null;
  const f = p.farm;

  // Composition by value where both sides are priced, by the band's own
  // deposit ratio where they are not. A concentrated position is rarely 50/50
  // and the ratio is the whole reason topping it up needs planning.
  const vA = p.amountA * (pool.priceUsdA || 0), vB = p.amountB * (pool.priceUsdB || 0);
  const tot = vA + vB;
  const wA = tot > 0 ? vA / tot : p.ratio.shareA;

  // What this position earns a day from trading, at the pool's own 24h volume.
  const feeDay = (p.inRange && pool.vol24 > 0 && pool.tvlReal > 0)
    ? pool.vol24 * (lpCut(pool) / 10000) * (p.valueUsd / pool.tvlReal) : 0;

  // The band's edges as prices, in the pair's own units. A tick number means
  // nothing to anyone; the price it stands for is the decision.
  const priceAt = t => Math.pow(1.0001, t) * 10 ** (pool.decA - pool.decB);
  const bandLo = priceAt(p.tickLower), bandHi = priceAt(p.tickUpper), bandNow = priceAt(pool.tick);
  const farmDay = f ? f.inFarm.reduce((s, x) => {
    if (!(x.rewardUsdDay > 0) || !(x.stakedUsd > 0) || !(p.valueUsd > 0)) return s;
    return s + x.rewardUsdDay * (p.valueUsd / x.stakedUsd);
  }, 0) : 0;

  const pills = [
    `<span class="pill ${p.inRange ? 'good' : 'bad'}">${p.inRange ? 'In range' : 'Out of range'}</span>`,
    p.feesUsd > 0 ? `<span class="pill accent">${usd(p.feesUsd)} uncollected</span>` : '',
    f && f.missing.length ? `<span class="pill warn">Not in ${f.missing.length === f.live.length ? 'the farm' : `${f.missing.length} of ${f.live.length} farms`}</span>`
      : f && f.inFarm.length ? `<span class="pill good">Farming${f.aprLive != null ? ` &middot; ${pct(f.aprLive)} APR` : ''}</span>` : '',
  ].filter(Boolean).join('');

  const fig = (k, v, cls = '', sub = '') => `<div class="fig"><span class="k">${k}</span><span class="v ${cls}">${v}</span>${sub ? `<span class="figsub">${sub}</span>` : ''}</div>`;

  return `<article class="poscard ${p.inRange ? '' : 'out'}" data-rb="${esc(pool.id)}:${p.tickLower}:${p.tickUpper}:${pool.tick}">
    <header class="pc-head">
      <span class="pc-mark" data-pm="${esc(pool.tokenA)}|${esc(pool.symA)}|${esc(pool.tokenB)}|${esc(pool.symB)}"></span>
      <div class="pc-id">
        <div class="pc-pair">${pairLinks(pool)}<span class="venue alcor">Alcor</span></div>
        <div class="pc-meta">${poolLink(pool.dex, pool.id, '#' + p.posId)} &middot; ${(pool.feeBps / 100).toFixed(2)}% fee${share != null ? ` &middot; ${(share * 100).toFixed(share >= 1 ? 1 : 2)}% of the pool` : ''}</div>
      </div>
      <div class="pc-val">
        <span class="v">${usdExact(p.valueUsd)}</span>
        ${p.depositedUsd > 0 ? `<span class="d ${p.pnlUsd >= 0 ? 'pos' : 'neg'}">${p.pnlUsd >= 0 ? '+' : ''}${usdExact(p.pnlUsd)} since you opened it</span>` : ''}
      </div>
    </header>

    <div class="pc-pills">${pills}</div>
    <div class="rb-slot"></div>
    <div class="pc-band">
      <span>${sigfig(bandLo)}</span>
      <span class="now">${sigfig(bandNow)} now</span>
      <span>${sigfig(bandHi)}</span>
    </div>

    <div class="pc-split" title="${esc(pool.symA)} ${(wA * 100).toFixed(0)}% / ${esc(pool.symB)} ${((1 - wA) * 100).toFixed(0)}%">
      <div class="seg a" style="width:${(wA * 100).toFixed(2)}%"></div>
      <div class="seg b" style="width:${((1 - wA) * 100).toFixed(2)}%"></div>
    </div>
    <div class="pc-legend">
      <span><i class="a"></i>${esc(pool.symA)} ${qty(p.amountA)}</span>
      <span><i class="b"></i>${esc(pool.symB)} ${qty(p.amountB)}</span>
    </div>

    <div class="pc-figs">
      ${fig('Fees waiting', usd(p.feesUsd), p.feesUsd > 0 ? 'accent' : 'dim')}
      ${fig('Farm rewards', `<span data-farmpend="${p.posId}" class="dim">&mdash;</span>`, '')}
      ${fig('Earning / day', feeDay + farmDay > 0 ? usd(feeDay + farmDay) : '&mdash;', feeDay + farmDay > 0 ? '' : 'dim',
        feeDay + farmDay > 0
          ? `${usd(feeDay)} fees${farmDay > 0 ? ` + ${usd(farmDay)} farm` : ''}`
          : '')}
      ${fig('Top up at', `${(p.ratio.shareA * 100).toFixed(0)} / ${(p.ratio.shareB * 100).toFixed(0)}`)}
    </div>

    ${f && f.missing.length ? `<div class="pc-farm">
      <div><b>${f.aprMissing != null ? `${pct(f.aprMissing)} APR` : `${f.missing.length} farm${f.missing.length === 1 ? '' : 's'}`} you are not collecting</b>
        <span class="sub">${f.missing.map(x => tokLink(x.rewardToken, x.rewardSymbol)).join(' + ')} ${f.missing.length === 1 ? 'is' : 'are'} paid to staked positions only${f.missedUsdDay > 0 ? ` &mdash; about ${usd(f.missedUsdDay)} a day at this size` : ''}</span></div>
      ${mine ? `<button class="btn" data-joinfarm="${p.posId}" data-inc="${f.missing.map(x => esc(x.id)).join(',')}">Join the farm</button>` : ''}
    </div>` : ''}

    <footer class="pc-act">
      ${mine ? `<button class="btn" data-compound="${esc(pool.id)}:${p.posId}">Compound</button>
        <button class="btn ghost" data-add="${p.posId}">Add</button>
        <button class="btn ghost" data-remove="${p.posId}">Remove</button>` : ''}
      <a class="plink" href="${venueUrl.alcor(pool)}" target="_blank" rel="noopener">Pool &nearr;</a>
    </footer>
    <div class="cplan" hidden></div>
    <div class="lpbox" data-lpbox="${p.posId}"></div></article>`;
}

function tacoCard(p) {
  const pool = p.pool;
  const vA = p.amountA * (pool.priceUsdA || 0), vB = p.amountB * (pool.priceUsdB || 0);
  const tot = vA + vB;
  const wA = tot > 0 ? vA / tot : 0.5;
  const tacoDay = (pool.vol24 > 0 && pool.tvl > 0) ? pool.vol24 * (lpCut(pool) / 10000) * p.share : 0;
  return `<article class="poscard">
    <header class="pc-head">
      <span class="pc-mark" data-pm="${esc(pool.tokenA)}|${esc(pool.symA)}|${esc(pool.tokenB)}|${esc(pool.symB)}"></span>
      <div class="pc-id">
        <div class="pc-pair">${pairLinks(pool)}<span class="venue taco">Taco</span></div>
        <div class="pc-meta">${qty(p.balance)} LP &middot; ${(p.share * 100).toPrecision(3)}% of the pair</div>
      </div>
      <div class="pc-val"><span class="v">${usdExact(p.valueUsd)}</span></div>
    </header>
    <div class="pc-pills"><span class="pill good">Full range</span></div>
    <div class="pc-split"><div class="seg a" style="width:${(wA * 100).toFixed(2)}%"></div><div class="seg b" style="width:${((1 - wA) * 100).toFixed(2)}%"></div></div>
    <div class="pc-legend">
      <span><i class="a"></i>${esc(pool.symA)} ${qty(p.amountA)}</span>
      <span><i class="b"></i>${esc(pool.symB)} ${qty(p.amountB)}</span>
    </div>
    <div class="pc-figs">
      <div class="fig"><span class="k">Pool size</span><span class="v">${pool.tvl != null ? usd(pool.tvl) : '&mdash;'}</span></div>
      <div class="fig"><span class="k">Earning / day</span><span class="v ${tacoDay > 0 ? '' : 'dim'}">${tacoDay > 0 ? usd(tacoDay) : '&mdash;'}</span></div>
      <div class="fig"><span class="k">Fee tier</span><span class="v">${(pool.feeBps / 100).toFixed(2)}%</span></div>
    </div>
    <footer class="pc-act"><a class="plink" href="${venueUrl.taco(pool)}" target="_blank" rel="noopener">Open the pool on TacoSwap &nearr;</a></footer>
  </article>`;
}

async function lookupWallet(account) {
  if (!account) return;
  walletShown = account;
  stopAccrual();
  const ro = $('#walletReadonly'); if (ro) { ro.hidden = true; ro.textContent = ''; }          // a counter for the previous account must not keep running
  // Each section answers its own question and loads on its own schedule; the
  // position sweep is the slowest of them and should not hold up a balance.
  const feeAccount = CFG?.commercial?.feeAccount || '';
  const feeBps = feeAccount ? Math.max(0, Math.min(100, CFG?.commercial?.compoundFeeBps ?? 0)) : 0;
  renderWalletResources(account).catch(() => {});
  renderWalletStake(account, feeBps, feeAccount).catch(() => {});
  renderWalletFarms(account).catch(() => {});
  renderPepperClaims(account).catch(() => {});
  renderEarned(account).catch(() => {});
  renderWalletBalances(account).catch(() => {});
  renderTradeFlow(account).catch(() => {});

  const out = $('#walletOut');
  out.innerHTML = '<div class="loading"><span class="spinner"></span><span id="wmsg">Looking up…</span></div>';
  let res;
  try {
    // Alcor's own index first — seconds instead of twenty, and it knows what you
    // deposited. Reading the chain ourselves is the fallback, not the default.
    const alcor = await walletPositionsFast(account);
    const slow = await walletPositions(account, { onProgress: () => {}, skipAlcor: true }).catch(() => ({ alcor: [], taco: [], poolsChecked: 0 }));
    res = { alcor: alcor.length ? alcor : slow.alcor, taco: slow.taco, poolsChecked: slow.poolsChecked };
    // The pie can now offer to include what is inside the positions, which it
    // could not while this was still sweeping.
    walletPositionsFor = { account, list: [...res.alcor, ...res.taco] };
    redrawBalancePie();
  } catch {
    try { res = await walletPositions(account, { onProgress: p => { const m = $('#wmsg'); if (m) m.textContent = p.msg; } }); }
    catch (e) { out.innerHTML = `<div class="err">Lookup failed: ${esc(e.message)}</div>`; return; }
  }

  const all = [...res.alcor, ...res.taco];
  if (!all.length) {
    out.innerHTML = `<div class="empty">No liquidity found for <span class="mono">${esc(account)}</span>.<br>
      <span class="dim">Checked ${res.poolsChecked} Alcor pool${res.poolsChecked === 1 ? '' : 's'} and its Taco LP.</span></div>`;
    return;
  }

  // Being an LP and being IN THE FARM are different things, and this page used
  // to show only the first. A position sitting in a pool with a live incentive
  // it never joined earns trading fees and nothing else, and nothing on screen
  // said so — which is the whole reason a farmed pair could not be compounded
  // "with farm rewards": there were none to compound.
  try {
    const joined = await stakedIncentives(res.alcor.map(p => p.posId));
    for (const p of res.alcor) p.farm = farmGap(p, state.farms, joined.get(String(p.posId)) || []);
    // The staking map is already here, so the accrual costs one read per farm
    // rather than a second sweep.
    renderFarmAccrual(account, res.alcor, joined).catch(() => {});
  } catch { /* the cards render without it */ }

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
    return s + pool.vol24 * (lpCut(pool) / 10000) * ((p.valueUsd || 0) / pool.tvlReal);
  }, 0);

  let html = `<div class="stats">
      <div class="stat"><span class="v">${usdExact(totalUsd)}</span><span class="k">liquidity value</span><span class="sub">${all.length} position${all.length === 1 ? '' : 's'} across ${new Set(all.map(p => p.pool.dex)).size} venue${new Set(all.map(p => p.pool.dex)).size === 1 ? '' : 's'}</span></div>
      <div class="stat"><span class="v">${usdExact(feesUsd)}</span><span class="k">fees waiting</span><span class="sub">uncollected, earning nothing</span></div>
      <div class="stat"><span class="v ${outOfRange.length ? 'neg' : 'pos'}">${usdExact(oorUsd)}</span><span class="k">idle, out of range</span><span class="sub">${outOfRange.length} of ${res.alcor.length} Alcor position${res.alcor.length === 1 ? '' : 's'}</span></div>
      <div class="stat"><span class="v">${usd(dailyFees)}</span><span class="k">earning per day</span><span class="sub">at each pool's 24h volume</span></div>
      ${deposited > 0 ? `<div class="stat"><span class="v ${pnl >= 0 ? 'pos' : 'neg'}">${pnl >= 0 ? '+' : ''}${usd(pnl)}</span><span class="k">profit so far</span><span class="sub">${usd(alcorValue)} now against ${usd(deposited)} put in, on Alcor positions only${tacoCount > 0 ? ` &mdash; the ${tacoCount} TacoSwap position${tacoCount === 1 ? '' : 's'} above ${tacoCount === 1 ? 'is' : 'are'} not in this` : ''}</span></div>` : ''}
    </div>`;

  if (outOfRange.length) {
    html += `<div class="note" style="margin-bottom:16px"><b>${usd(oorUsd)} is sitting outside its range</b> and earns nothing there.</div>`;
  }

  html += `<div class="grid g2" style="margin-bottom:16px">
      <div class="card"><h3>Where your money is</h3><div id="walDonut"></div></div>
      <div class="card"><h3>Fees waiting to be collected</h3><div id="walFees"></div></div>
    </div>`;

  // Compounding is the thing this page exists to make easy, and it was a grey
  // button at the bottom of each card. Fees waiting is the honest hook: it is
  // money already earned and sitting where it earns nothing more.
  const waiting = res.alcor.reduce((a, p) => a + (p.feesUsd || 0), 0);
  const withFees = res.alcor.filter(p => p.feesUsd > 0).length;
  if (withFees) {
    html += `<div class="cta">
      <div><b>${usd(waiting)} in fees is sitting uncollected</b> across ${withFees} position${withFees === 1 ? '' : 's'}
        <span class="sub">Farm rewards are on top of this.</span></div>
      ${isMine(account) ? '<button class="btn" id="goCompound">Compound them</button>' : ''}
    </div>`;
  }

  // The farms running on pools this wallet is already in, that it never joined.
  // This is the one number on the page that is pure loss: the reward is being
  // paid, to everyone in the pool who staked, every block.
  const gaps = res.alcor.filter(p => p.farm?.missing.length);
  if (gaps.length) {
    const perDay = gaps.reduce((a, p) => a + p.farm.missedUsdDay, 0);
    html += `<div class="cta warn">
      <div><b>${gaps.length} position${gaps.length === 1 ? ' is' : 's are'} not staked into ${gaps.length === 1 ? 'a farm running on its pool' : 'the farms running on their pools'}</b>
        <span class="sub">${perDay > 0 ? `About ${usd(perDay)} a day` : 'Rewards'} paid to staked positions only.</span></div>
    </div>`;
  }

  html += '<div class="grid g2">';
  const mine = isMine(account);
  for (const p of res.alcor) html += positionCard(p, mine);
  for (const p of res.taco) html += tacoCard(p);
  html += '</div>';
  out.innerHTML = html;
  // Every position card carries a data-pm slot for its pair logos and nothing
  // was ever filling them, so the whole list rendered as bare text.
  fillMarks(out);
  lockForeign(account);
  if (pendingResume && pendingResume.account === account) {
    const r = pendingResume; pendingResume = null;
    const card = out.querySelector(`button[data-compound$=":${r.posId}"]`);
    const pos = res.alcor.find(x => String(x.posId) === String(r.posId));
    if (card && pos) { card.scrollIntoView({ block: 'center' }); showCompound(card, pos, r); }
  }
  const gc = $('#goCompound');
  if (gc) gc.onclick = () => $('#walletOut')?.scrollIntoView({ block: 'start' });

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
  // Joining a farm is one stake action per incentive, in one transaction. The
  // position stays where it is and stays yours; staking only tells the pool's
  // incentive to count it. Nothing here can move it.
  wireJoinFarm(out, account);

  // Adding and taking out were the only two things the Liquidity page did that
  // this one did not, so they live on the card now and that page is gone.
  const ownsIt = async () => {
    if (!wallet.account()) { try { await wallet.connect(); } catch { return false; } }
    if (wallet.account() !== account) { alert(`Connected as ${wallet.account()}, but these positions belong to ${account}.`); return false; }
    return true;
  };
  out.querySelectorAll('button[data-add]').forEach(b => b.onclick = async () => {
    if (!await ownsIt()) return;
    const pos = res.alcor.find(x => String(x.posId) === b.dataset.add);
    if (pos) renderAddLiquidity(out.querySelector(`[data-lpbox="${b.dataset.add}"]`), pos, account);
  });
  out.querySelectorAll('button[data-remove]').forEach(b => b.onclick = async () => {
    if (!await ownsIt()) return;
    const pos = res.alcor.find(x => String(x.posId) === b.dataset.remove);
    if (pos) renderRemoveLiquidity(out.querySelector(`[data-lpbox="${b.dataset.remove}"]`), pos, account);
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
async function showCompound(btn, pos, resume = null) {
  const box = btn.closest('.poscard, .card')?.querySelector('.cplan');
  if (!box) return;
  const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
  if (!box.hidden) { box.hidden = true; btn.textContent = label; return; }
  box.hidden = false;
  btn.textContent = 'Hide plan';
  box.innerHTML = '<div class="loading"><span class="spinner"></span><span>Reading claimable rewards…</span></div>';

  // The same fee the transaction will actually carry. Planning at zero and
  // charging 0.75% at signing time is the one surprise this panel must not
  // spring — the Compound page has always used the configured rate.
  const feeAccount = CFG?.commercial?.feeAccount || '';
  const feeBps = feeAccount ? Math.max(0, Math.min(100, CFG?.commercial?.compoundFeeBps ?? 0)) : 0;

  let harvest, preBalances = null;
  try {
    harvest = await harvestFor(pos, pos.pool, { prices: state.prices, tokens: state.tokens });
    // Read now, while the panel is being drawn and nobody is waiting on a
    // gesture. This is what makes "Compound now" one press instead of two.
    preBalances = await readBalances(pos.pool, [...new Set(harvest.basket.map(b => b.tokenId))])
      .catch(() => null);
  } catch (e) { box.innerHTML = `<div class="err">Could not build a plan: ${esc(e.message)}</div>`; return; }

  paintPlan();

  function paintPlan() {
  const plan = planCompound({
    pool: pos.pool, position: pos, basket: harvest.basket,
    feeBps, noSwap,
    sqrtP: sqrtPriceFromX64(pos.pool.sqrtX64),
  });
  const b = plan;
  // Three nested cards and a four-tile stat grid, dropped inside a card that is
  // itself half of a two-column grid. Every box drew its own border and nothing
  // had room to breathe. A plan is a short sequence, so it reads as one.
  // A token with no price cannot be sized into the band, so offering to compound
  // it is offering something that will not happen — it defaults to the wallet.
  const inPool = x => x.tokenId === pos.pool.tokenA || x.tokenId === pos.pool.tokenB;
  const rewardRows = harvest.basket.map((x, bi) => {
    // A dropdown on a row whose destination the mode has already decided is
    // theatre. Without swapping, a reward the pool does not hold cannot go into
    // the pool by any route — it goes to the wallet, and offering a choice
    // there is offering something that will not happen. So the control appears
    // only where the answer is genuinely still open:
    //
    //   with swapping      every row is a real choice
    //   without swapping   pool tokens are a choice; everything else is fixed
    //
    // Which leaves the one case worth keeping: a third token you would rather
    // not have sold, on a compound that is otherwise selling.
    const fixed = (!x.priced) || (noSwap && !inPool(x));
    const def = x.priced && !fixed ? 'compound' : 'keep';
    const opt = (v, t) => `<option value="${v}"${v === def ? ' selected' : ''}>${t}</option>`;
    return `
    <label class="prow${fixed ? ' fixed' : ''}">
      <span class="s">${esc(x.symbol)}</span>
      <span class="a">${qty(x.amount)}</span>
      <span class="u">${x.priced ? usd(x.usd) : '<span class="dim" title="No pool deep enough to price this token — it cannot be swapped, so it can only go to your wallet">unpriced</span>'}</span>
      <span class="w"><span class="src ${x.source === 'fees' ? 'fee' : 'farm'}">${x.source === 'fees' ? 'LP fee' : 'Farm reward'}</span>${x.source === 'fees' ? '' : ` <span class="dim">${esc(x.source)}</span>`}${inPool(x) ? '' : ' <span class="dim">&middot; not a token in this pool</span>'}</span>
      ${fixed
        ? `<span class="dest-fixed" title="${x.priced
            ? 'Not a token this pool holds, and nothing is being sold — so it can only go to your wallet'
            : 'No pool deep enough to price this token, so it cannot be swapped into the band'}">&rarr; your wallet</span>
           <input type="hidden" class="pickmode" data-wpick="${pos.posId}" data-bi="${bi}" value="keep">`
        : `<select class="pickmode" data-wpick="${pos.posId}" data-bi="${bi}">
            ${opt('compound', '&rarr; into the pool')}
            ${opt('keep', '&rarr; to my wallet')}
          </select>`}
    </label>`;
  }).join('');

  box.innerHTML = `
    <div class="plan">
      ${!b.viable ? `<div class="err">${esc(b.reason)}</div>` : ''}
      ${b.warn ? `<div class="note warn">${esc(b.warn)}</div>` : ''}

      <div class="planhead">
        <span class="from">${usd(b.grossUsd)}</span>
        <span class="arrow">&rarr;</span>
        <span class="to">${usd(b.depositUsd)}</span>
        <span class="note">back into the band${b.feeUsd > 0 && b.depositUsd > 0 ? ` &middot; ${usd(b.depositUsd * (feeBps / 10000))} fee` : ''} &middot; ${b.noSwap ? 'one signature' : 'two signatures'}</span>
      </div>

      <div class="prows">${rewardRows}</div>

      <div class="modeblock">
      <span class="lbl">Choose one</span>
      <div class="modesel" role="radiogroup" aria-label="How to compound">
        <button type="button" class="mode${noSwap ? '' : ' on'}" data-mode="swap" data-pos="${pos.posId}" role="radio" aria-checked="${!noSwap}">
          <b>With swapping</b>
          <span>Sells the long side to reach the band's ratio. All of it goes back in.</span>
        </button>
        <button type="button" class="mode${noSwap ? ' on' : ''}" data-mode="noswap" data-pos="${pos.posId}" role="radio" aria-checked="${noSwap}">
          <b>Without swapping</b>
          <span>Puts back what already fits. The rest goes to your wallet, unsold.</span>
        </button>
      </div>
      </div>

      <div class="dests">
        <div class="dest in">
          <span class="lbl">Back into the pool</span>
          <span class="amt">${usdExact(b.depositUsd)}</span>
          <span class="det">${[
            b.depositA > 0 && pos.pool.priceUsdA > 0 ? `${qty(b.depositA / pos.pool.priceUsdA)} ${esc(pos.pool.symA)}` : '',
            b.depositB > 0 && pos.pool.priceUsdB > 0 ? `${qty(b.depositB / pos.pool.priceUsdB)} ${esc(pos.pool.symB)}` : '',
          ].filter(Boolean).join(' + ') || 'nothing fits without swapping'}</span>
        </div>
        <div class="dest out${b.leftoverUsd > 0 ? '' : ' empty'}">
          <span class="lbl">Into your wallet</span>
          <span class="amt">${b.leftoverUsd > 0 ? usdExact(b.leftoverUsd) : '&mdash;'}</span>
          <span class="det">${b.leftoverUsd > 0
            ? b.leftover.filter(l => l.usd > 0).map(l => `${qty(l.amount)} ${esc(l.symbol)}`).join(' + ')
            : 'all of it goes back into the pool'}</span>
        </div>
      </div>

      <div class="planline">
        <span class="k">Sells</span>
        <span>${b.noSwap
          ? '<span class="pos">nothing</span>'
          : b.swaps.length
            ? b.swaps.map(x => `<b>${usd(x.usd)}</b> of ${esc(x.from)} &rarr; ${esc(x.to)}`).join(', ')
            : '<span class="pos">nothing &mdash; the harvest already matches the band</span>'}</span>
      </div>
      <div class="planline">
        <span class="k">Signs</span>
        <span><span class="mono">${b.actions.map(a => esc(a.name)).join(' &middot; ')}</span>
          <span class="dim">&mdash; ${b.noSwap ? 'one transaction' : 'two'}</span></span>
      </div>

      <button class="btn" id="wrun-${pos.posId}"${b.viable ? '' : ' disabled'}>Compound now</button>
      <div class="runbox" id="wbox-${pos.posId}"></div>
    </div>`;

  // Switching it re-plans: the deposit, the swaps, the signature count and the
  // fee all change, and showing the old numbers under a new setting is worse
  // than not offering the setting.
  box.querySelectorAll(`[data-mode][data-pos="${pos.posId}"]`).forEach(b2 => b2.onclick = () => {
    const want = b2.dataset.mode === 'noswap';
    if (want === noSwap) return;
    noSwap = want; saveNoSwap(noSwap); paintPlan();
  });

  // This panel used to end at "the transaction your wallet would sign" and stop
  // there, so the only way to actually compound was to leave the page.
  const go = box.querySelector(`#wrun-${pos.posId}`);
  if (go) go.onclick = async () => {
    if (!wallet.account()) { try { await wallet.connect(); } catch { return; } }
    if (wallet.account() !== pos.owner) {
      alert(`Connected as ${wallet.account()}, but this position belongs to ${pos.owner}.`);
      return;
    }
    const modes = new Map([...box.querySelectorAll(`[data-wpick="${pos.posId}"]`)].map(c => [Number(c.dataset.bi), c.value]));
    // Everything is claimed; the choice is only where it lands.
    const claimBasket = harvest.basket;
    const planBasket = harvest.basket.filter((_, i) => (modes.get(i) ?? 'compound') === 'compound');
    const runbox = box.querySelector(`#wbox-${pos.posId}`);
    if (!planBasket.length) { runbox.innerHTML = '<div class="err" style="margin-top:10px">Everything is set to go to your wallet &mdash; use Collect for that, it is one signature.</div>'; return; }
    const entry = {
      pos,
      harvest: { ...harvest, basket: claimBasket },
      plan: planCompound({ pool: pos.pool, position: pos, basket: planBasket, feeBps, noSwap, sqrtP: sqrtPriceFromX64(pos.pool.sqrtX64) }),
    };
    go.disabled = true;
    // Deliberately not awaited before this point: the click is the gesture the
    // wallet popup needs, and an await here would spend it.
    await runOne(runbox, entry, feeBps, feeAccount, resume, preBalances);
    go.disabled = false;
  };
  }
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
    if (a && !$('#walletInput').value) $('#walletInput').value = a;
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
// A compound was three signatures asked for from one click. Browsers only let a
// page open a window during a user gesture and an `await` spends it, so the
// later ones arrived with the gesture gone; WAX Cloud Wallet needs a popup, and
// a refused popup falls back to navigating the whole page at the wallet. That
// was the "the page refreshes at step 3" report: not a crash, a blocked popup,
// and the flow died with the document.
//
// It is one signature now when nothing is sold, and two when something is —
// see buildOneShot in tx.js. Each one still waits for a real click.
//
// The second half matters more. Between the claim and the deposit the harvest
// is sitting loose in the wallet — already collected, not yet put back — and a
// reload in that window used to lose the thread entirely. The step that has
// been reached is written down, so an interrupted compound can be finished
// rather than quietly abandoned.
// Whether compounding is allowed to sell. Remembered, because someone who does
// not want to be selling their own farm token this week does not want to be
// asked again on every position.
const NOSWAP_KEY = 'wt.compound.noswap';
let noSwap = (() => { try { return localStorage.getItem(NOSWAP_KEY) === '1'; } catch { return false; } })();
const saveNoSwap = v => { try { localStorage.setItem(NOSWAP_KEY, v ? '1' : '0'); } catch {} };

const RESUME_KEY = 'wt.compound.pending';
const loadResume = () => { try { return JSON.parse(localStorage.getItem(RESUME_KEY) || 'null'); } catch { return null; } };
const saveResume = v => { try { v ? localStorage.setItem(RESUME_KEY, JSON.stringify(v)) : localStorage.removeItem(RESUME_KEY); } catch {} };

// `preBalances` is the whole point of the "Compound now" button being one click
// rather than two. A browser only lets a page open a window during a user
// gesture, and every `await` spends it — so reading balances inside the handler
// meant the first signature arrived with the gesture already gone, and needed
// its own second press to get a fresh one.
//
// Reading them while the plan is drawn instead means the click that says
// "Compound now" IS the gesture for signature 1: nothing is awaited between the
// two. Signatures 2 and 3 still ask, because they genuinely cannot be reached
// without first measuring what the previous one produced.
async function runOne(box, entry, feeBps, feeAccount, resume = null, preBalances = null) {
  const { pos, harvest, plan } = entry;
  const oneShot = !!plan.noSwap && !resume;

  // Without swapping there is nothing to wait for: every amount in the
  // transaction is known before it is signed, so claim and deposit go together.
  // With swapping the deposit has to wait for what the swap actually returned,
  // and no restructuring changes that.
  const steps = oneShot
    ? [{ t: 'Claim and put it back', d: `Collect your fees and ${plan.actions.filter(a => a.name === 'getreward').length} farm reward(s) and add them straight back into your range — one transaction, nothing sold.` }]
    : [
      { t: 'Claim and convert', d: `Collect your fees and ${plan.actions.filter(a => a.name === 'getreward').length} farm reward(s), and convert what the band needs — one transaction. Only the harvest is spent.` },
      { t: 'Put it back', d: 'Add exactly what arrived back into your range.'
          + (feeBps > 0 && feeAccount ? ` A ${(feeBps / 100).toFixed(2)}% fee on the harvest goes to ${feeAccount}; nothing else leaves your wallet.` : '') },
    ];

  const render = (i, msg, { err = null, cta = null } = {}) => {
    box.innerHTML = `<div class="steps">${steps.map((st, n) => `
      <div class="step ${n < i ? 'done' : n === i ? 'active' : ''}">
        <span class="n">${n < i ? '&check;' : n + 1}</span>
        <div><h4>${st.t}</h4><p>${n === i && msg ? esc(msg) : st.d}</p></div>
      </div>`).join('')}</div>
      ${err ? `<div class="err" style="margin-top:10px">${esc(err)}</div>` : ''}
      ${cta ? `<button class="btn" style="margin-top:10px;width:100%" data-next>${esc(cta)}</button>` : ''}`;
  };

  // A wallet popup needs a user gesture, and an `await` spends it — so each
  // signature after the first waits for a real click of its own.
  const press = (i, label, note) => new Promise(r => {
    render(i, note, { cta: label });
    box.querySelector('[data-next]').onclick = e => { e.currentTarget.disabled = true; r(); };
  });

  const basketIds = [...new Set(harvest.basket.map(b => b.tokenId))];
  let before = resume?.before ?? preBalances ?? null;
  let r1id = resume?.claimTx ?? '';

  try {
    const me = wallet.account();
    if (!me) throw new Error('No wallet connected — connect one and try again.');

    // ---- the whole thing, in one ---------------------------------------
    if (oneShot) {
      const one = buildOneShot({ pool: pos.pool, position: pos, basket: harvest.basket, plan, feeBps, feeAccount, me });
      render(0, 'Waiting for your wallet…');
      const r = await wallet.transact(one.actions, { verify: true });
      saveResume(null);
      box.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)">
        <b>Compounded.</b> Put back ${qty(one.depA)} ${esc(pos.pool.symA)} and ${qty(one.depB)} ${esc(pos.pool.symB)} in one transaction, and sold nothing.
        <br><span class="sub">${((1 - one.margin) * 100).toFixed(1)}% under the estimate; the remainder is in your wallet.</span>
        <br><a class="mono" style="font-size:11px" href="${trxUrl(r.id)}" target="_blank" rel="noopener">${r.id.slice(0, 16)}… &nearr;</a></div>`;
      return;
    }

    // ---- 1. claim and convert ------------------------------------------
    if (!resume) {
      if (!before) {
        render(0, 'Reading your balances…');
        before = await readBalances(pos.pool, basketIds);
        await press(0, 'Claim and convert', 'Your wallet will ask once. Only what you just claimed is converted.');
      }
      const cs = await buildClaimAndSwap({ pool: pos.pool, position: pos, basket: harvest.basket, plan, me });
      render(0, 'Waiting for your wallet…');
      const r1 = await wallet.transact(cs.actions, { verify: true });
      r1id = r1.id;
      // From here the harvest is loose in the wallet. If anything interrupts
      // this, it has to be finishable.
      saveResume({ account: pos.owner, poolId: pos.pool.id, posId: pos.posId, before, claimTx: r1id, at: Date.now() });
    }

    // ---- 2. put it back -------------------------------------------------
    render(1, 'Measuring what arrived…');
    await new Promise(r => setTimeout(r, 2500));
    const pxA = pos.pool.priceUsdA, pxB = pos.pool.priceUsdB;
    const expected = {
      a: pxA > 0 ? plan.depositA / pxA : 0,
      b: pxB > 0 ? plan.depositB / pxB : 0,
    };
    const dep = await buildRedeposit({ pool: pos.pool, position: pos, feeBps, feeAccount, before, expected, exact: !!plan.noSwap, me });
    await press(1, 'Put it back', `Add ${qty(dep.depA)} ${pos.pool.symA} and ${qty(dep.depB)} ${pos.pool.symB} back into your range.`);
    render(1, 'Waiting for your wallet…');
    const r2 = await wallet.transact(dep.actions, { verify: true });
    saveResume(null);

    box.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)">
      <b>Compounded.</b> Put back ${qty(dep.depA)} ${esc(pos.pool.symA)} and ${qty(dep.depB)} ${esc(pos.pool.symB)} &mdash; the harvest only.
      Your existing ${esc(pos.pool.symA)} and ${esc(pos.pool.symB)} were left alone.
      <br><span class="mono" style="font-size:11px">${r1id.slice(0, 16)}… &middot; ${r2.id.slice(0, 16)}…</span></div>`;
  } catch (e) {
    const m = String(e.message || e);
    const declined = /cancel|reject|declin/i.test(m);
    render(0, null, {
      err: declined
        ? (r1id ? 'You declined that signature. What you already claimed is in your wallet — reopen this position to finish putting it back.' : 'You declined the signature — nothing happened.')
        : e?.simulated
          ? `Stopped before sending — a node ran this and it would have failed: ${m}. Nothing was broadcast, so it cost you no CPU or NET.`
          : `Transaction failed: ${m}`,
    });
  }
}

// An interrupted compound, offered back. The claim has executed, so the money is
// in the wallet either way; the only question is whether it gets put back.
async function resumeBanner() {
  const r = loadResume();
  if (!r) return;
  // A stale record is worse than none: after a day the balances it measured
  // against mean nothing.
  if (Date.now() - r.at > 6 * 3600e3) { saveResume(null); return; }
  const me = wallet.account();
  if (me && me !== r.account) return;
  const bar = $('#resumeBar');
  bar.innerHTML = `<div class="freshbar" style="border-color:var(--accent);background:var(--accent-soft)">
    <b>An unfinished compound.</b> Position #${esc(r.posId)} was claimed but never put back &mdash; the harvest is in your wallet.
    <button class="btn" id="resumeGo">Finish it</button>
    <button class="btn ghost" id="resumeDrop">Forget it</button></div>`;
  $('#resumeDrop').onclick = () => { saveResume(null); bar.innerHTML = ''; };
  $('#resumeGo').onclick = () => {
    bar.innerHTML = '';
    pendingResume = r;
    show('wallet', r.account); $('#walletInput').value = r.account; lookupWallet(r.account);
  };
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
    const r1 = await wallet.transact(claim.actions, { verify: true });

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
    const r2 = await wallet.transact(back.actions, { verify: true });

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
function renderNewPosition(account, poolId = null, box = $('#newPos')) {
  if (!box) return;
  // This panel is rendered into two different containers — the wallet's
  // "Open a new position" and the farm page's own. Both stay in the document,
  // so a document-wide $('#npPool') always found whichever came first: the farm
  // panel drew its range into the wallet panel and its buttons did nothing.
  const q = sel => box.querySelector(sel);
  const pools = state.pools
    .filter(p => p.dex === 'alcor' && p.sqrtX64 && p.tvlReal > 0)
    .sort((a, b) => (b.vol24 || 0) - (a.vol24 || 0) || (b.tvlReal || 0) - (a.tvlReal || 0))
    .slice(0, 300);

  const want = poolId != null ? String(poolId) : null;
  // On a farm or pool page the pool is not a question, so the picker is hidden
  // rather than offering three hundred alternatives to the one you came for.
  const fixedPool = !!poolId;
  box.innerHTML = `<div class="${fixedPool ? 'card' : 'section'}"><h3>Open a position by hand${fixedPool ? ' <span class="dim">— both tokens, your own band</span>' : ''}</h3>
    <div class="card">
      <div class="filters" style="display:grid;gap:8px;margin:0${fixedPool ? ';display:none' : ''}">
        <label>Pool<select id="npPool">${(poolId && !pools.some(p => String(p.id) === String(poolId))
          ? [...state.pools.filter(p => p.dex === 'alcor' && String(p.id) === String(poolId)), ...pools]
          : pools).map(p =>
          `<option value="${esc(p.id)}"${want === String(p.id) ? ' selected' : ''}>${esc(p.symA)}/${esc(p.symB)} — ${(p.feeBps / 100).toFixed(2)}% — ${usd(p.tvlReal)} pooled${p.vol24 > 0 ? `, ${usd(p.vol24)} traded` : ''}</option>`).join('')}</select></label>
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
    ${fixedPool ? '' : '</div>'}</div>`;

  let band = 'full';
  const poolOf = () => pools.find(p => String(p.id) === q('#npPool').value);

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
    q('#npLabA').firstChild.textContent = `${p.symA} `;
    q('#npLabB').firstChild.textContent = `${p.symB} `;
    const priceAt = t => Math.pow(1.0001, t) * 10 ** (p.decA - p.decB);
    q('#npRange').innerHTML = band === 'full'
      ? `Full range: your liquidity works at every price, the way a normal AMM pool does. It earns least per dollar and can never fall out of range &mdash; the safe default, and what most of these positions are.`
      : `From ${qty(priceAt(lower))} to ${qty(priceAt(upper))} ${esc(p.symB)} per ${esc(p.symA)}, around ${qty(p.priceAB)} now.
         Ticks ${lower}…${upper} on a spacing of ${p.tickSpacing || 60}. A narrower band earns more per dollar while the price stays inside it and nothing at all once it leaves.`;
    q('#npRange').innerHTML += ` <br>At this range the pool wants ${(r.shareA * 100).toFixed(1)}% ${esc(p.symA)} and ${(r.shareB * 100).toFixed(1)}% ${esc(p.symB)} by value.`;
  };

  q('#npPool').onchange = paint;
  box.querySelectorAll('[data-band]').forEach(b => b.onclick = () => {
    box.querySelectorAll('[data-band]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    band = b.dataset.band; paint();
  });
  q('#npClose').onclick = () => { box.innerHTML = ''; };

  const A = q('#npA'), B = q('#npB');
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

  q('#npGo').onclick = () => {
    const p = poolOf();
    const out = q('#npOut');
    if (!p) { out.innerHTML = '<div class="err">Pick a pool.</div>'; return; }
    const amountA = Number(A.value) || 0, amountB = Number(B.value) || 0;
    if (!(amountA > 0) && !(amountB > 0)) { out.innerHTML = '<div class="err">Enter an amount.</div>'; return; }
    const { lower, upper } = ticksFor(p);
    const built = buildAddLiquidity({ pool: p, tickLower: lower, tickUpper: upper, amountA, amountB, me: account });
    const worth = amountA * (p.priceUsdA || 0) + amountB * (p.priceUsdB || 0);
    out.innerHTML = `<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">
      Open a ${band === 'full' ? 'full-range' : '±' + band + '%'} position in <b>${esc(p.symA)}/${esc(p.symB)}</b> at ${(p.feeBps / 100).toFixed(2)}%, with
      <b>${qty(amountA)} ${esc(p.symA)}</b> and <b>${qty(amountB)} ${esc(p.symB)}</b>${worth > 0 ? ` (${usd(worth)})` : ''}, ticks ${lower}…${upper}.
      <br><span class="dim">${built.actions.length} actions in one signature.</span>
      ${band !== 'full' ? '<br><span class="dim">Stops earning the moment the price leaves the band.</span>' : ''}
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="npConfirm">Sign and open</button></div></div>`;
    q('#npConfirm').onclick = async () => {
      out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
      try {
        const r = await wallet.transact(built.actions, { verify: true });
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
    <p class="sub" id="addNote" style="margin:9px 0 0">Wants ${(ratio.shareA * 100).toFixed(1)}% ${esc(pool.symA)} / ${(ratio.shareB * 100).toFixed(1)}% ${esc(pool.symB)}. Type either side; the other follows.</p>
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
      ${built.venueTaxA || built.venueTaxB ? `<br><span class="dim">Taxed on transfer, so the deposit asks for what arrives.</span>` : ''}
      <br><span class="dim">${built.actions.length} actions in one signature.</span>
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="addConfirm">Sign and deposit</button></div></div>`;
    $('#addConfirm').onclick = async () => {
      out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
      try {
        const r = await wallet.transact(built.actions, { verify: true });
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
      <br><span class="dim">Paid straight to your wallet, with a ${(100 - 1).toFixed(0)}% minimum enforced.</span>
      <div class="toolbar" style="margin:10px 0 0"><button class="btn" id="rmConfirm">Sign and withdraw</button></div></div>`;
    $('#rmConfirm').onclick = async () => {
      out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Waiting for your wallet…</span></div>';
      try {
        const r = await wallet.transact(built.actions, { verify: true });
        out.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)"><b>Withdrawn.</b> ${pct === 100 ? 'The position is closed.' : `${pct}% taken out.`} Reload to refresh.
          <br><a class="mono" style="font-size:11px" href="${trxUrl(r.id)}" target="_blank" rel="noopener">${r.id.slice(0, 16)}… &nearr;</a></div>`;
      } catch (e) {
        const m = String(e.message || e);
        out.innerHTML = `<div class="err">${/cancel|reject|declin/i.test(m) ? 'You declined the signature — nothing happened.' : esc(m)}</div>`;
      }
    };
  };
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
// ------------------------------------------------------------- LEADERS -----
// Who is actually doing this, from a file the nightly job writes.
//
// It cannot be computed in the browser: ranking liquidity providers means
// reading every position in every pool with liquidity and reconstructing
// Uniswap-V3 fee growth for each one, which is about a minute of table reads.
// Nobody waits a minute. So the job does it once a day and the page serves the
// answer.
let ldData = null, ldBoard = 'providers';

// How many wallets provide liquidity in a pool, from the nightly pass. Loaded
// once, lazily, and absent rather than wrong until it arrives.
// The nightly pass, loaded once and kept whole. It already reads every position
// in every pool for the boards, so it is the cheapest place on earth to get two
// numbers the page cannot afford to compute live: how many wallets provide in a
// pool, and how much is staked into its farms.
let nightly = null;
function nightlyFile() {
  if (nightly === null) {
    nightly = undefined;                        // in flight
    fetch('data/leaders.json', { cache: 'no-cache' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        nightly = d || {};
        // The groups were built before this arrived, so they are holding a
        // "computing…" that is now answerable. Drop the cache key and redraw
        // whichever view is showing farm rates — the front page ranks on the
        // same number as the table, and would otherwise keep last night's gap
        // until something else forced it to repaint.
        groups._key = null;
        if (lastView === 'farms') renderFarms();
        else if (lastView === 'overview') renderOverview();
      })
      .catch(() => { nightly = {}; });
  }
  return nightly || null;
}
const poolIdOf = key => String(key).split(':')[1];
const poolLpCount = key => nightlyFile()?.lps?.[poolIdOf(key)] ?? null;
// Nominal USD staked into live incentives, measured. Null means unknown; zero
// means measured and nothing staked. A pool the pass scanned appears in `lps`,
// so its absence from `staked` is a real zero rather than a gap.
function poolStakedUsd(key) {
  const d = nightlyFile();
  if (!d?.staked) return null;
  const id = poolIdOf(key);
  if (d.staked[id] != null) return d.staked[id];
  return d.lps?.[id] != null ? 0 : null;
}

const LD_BOARDS = {
  providers: {
    key: 'providers', label: 'Liquidity',
    note: 'What their positions could actually pay out, not the pool\'s printed value.',
    cols: [['v', 'Position value', usdExact], ['f', 'Fees owed', usd], ['n', 'Positions', String], ['p', 'Pools', String], ['s', 'Staked', String]],
  },
  earners: {
    key: 'earners', label: 'Fees earned',
    note: 'Fees accrued and not yet collected. In no table on chain — rebuilt from each pool\'s fee-growth counters.',
    cols: [['f', 'Fees owed', usdExact], ['v', 'Position value', usd], ['n', 'Positions', String], ['p', 'Pools', String]],
  },
  farmers: {
    key: 'farmers', label: 'Farming',
    note: 'Staked into incentives that are still running.',
    cols: [['v', 'Staked value', usdExact], ['n', 'Staked positions', String], ['p', 'Pools', String]],
  },
  movers: {
    key: 'movers', label: 'Traders',
    note: 'Dollars moved through Alcor in 24h, by the account that signed the swap.',
    cols: [['v', 'Volume 24h', usdExact], ['n', 'Swaps', v => v.toLocaleString()], ['p', 'Pools', String]],
  },
};

async function renderLeaders() {
  const out = $('#ldOut');
  if (!out) return;
  if (!ldData) {
    out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Loading the boards…</span></div>';
    try {
      const r = await fetch('data/leaders.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(`leaders.json ${r.status}`);
      ldData = await r.json();
    } catch (e) {
      out.innerHTML = `<div class="empty">The leaderboards have not been built yet.<br>
        <span class="dim">Built nightly.</span></div>`;
      $('#ldStats').innerHTML = '';
      return;
    }
  }

  const d = ldData, sc = d.scope || {};
  $('#ldStats').innerHTML = `
    <div class="stat"><span class="v">${(sc.accounts || 0).toLocaleString()}</span><span class="k">liquidity providers</span><span class="sub">across ${(sc.pools || 0).toLocaleString()} pools</span></div>
    <div class="stat"><span class="v">${(sc.positions || 0).toLocaleString()}</span><span class="k">positions read</span><span class="sub">each one's fees rebuilt from chain</span></div>
    <div class="stat"><span class="v">${usd(sc.volumeUsd || 0)}</span><span class="k">traded in 24h</span><span class="sub">${(sc.swaps || 0).toLocaleString()} swaps by ${(sc.traders || 0).toLocaleString()} accounts${sc.swapsUnvalued ? ` &middot; ${sc.swapsUnvalued.toLocaleString()} more this terminal will not price` : ''}</span></div>
    <div class="stat"><span class="v">${d.at ? ago(new Date(d.at).toISOString()) : '—'}</span><span class="k">last built</span><span class="sub">rebuilt nightly</span></div>`;

  // Liquidity nobody owns. Positions transferred to the burn account keep
  // earning fees — the pool cannot tell the difference — and nobody can ever
  // collect them. It topped the fees board until it was taken off it, which is
  // a finding rather than a leader.
  const bn = d.burned;
  $('#ldBurn').innerHTML = bn && bn.n
    ? `${bn.n.toLocaleString()} burned positions at <span class="mono">eosio.null</span> hold ${usdExact(bn.v)} and are owed ${usdExact(bn.f)}, uncollectable. Left off the boards.`
    : '';
  $('#ldBurn').hidden = !(bn && bn.n);

  document.querySelectorAll('#ldTabs [data-board]').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.board === ldBoard)));

  const cfg = LD_BOARDS[ldBoard];
  const rows = d[cfg.key] || [];
  $('#ldNote').textContent = cfg.note + (sc.hidden ? ` ${sc.hidden} withheld, still counted.` : '');

  if (!rows.length) { out.innerHTML = '<div class="empty">Nothing on this board yet.</div>'; return; }

  out.innerHTML = `<div class="tablewrap"><table><thead><tr>
      <th class="r" style="width:44px"></th><th>Account</th>
      ${cfg.cols.map(c => `<th class="r">${esc(c[1])}</th>`).join('')}
    </tr></thead><tbody>${rows.map((r, i) => `<tr>
      <td class="rank">${i + 1}</td>
      <td class="mono">${acctLink(r.a)}</td>
      ${cfg.cols.map(c => `<td class="r num${r[c[0]] ? '' : ' dim'}">${r[c[0]] ? esc(String(c[2](r[c[0]]))) : '—'}</td>`).join('')}
    </tr>`).join('')}</tbody></table></div>`;

  // The name itself is the link; the row no longer needs its own binding.
}

function wireLeaders() {
  document.querySelectorAll('#ldTabs [data-board]').forEach(b => b.onclick = () => {
    ldBoard = b.dataset.board;
    renderLeaders();
  });
}

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
        ? ` &middot; <span class="neg">capped at 10,000</span>`
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
      <div class="card"><h3>Most active traders <span class="dim">&mdash; a full day, not this page</span></h3><div id="actBars"></div></div>
    </div>
    <div class="card" style="margin-bottom:12px">
      <h3>Routes traded <span class="dim">&mdash; swaps sharing a transaction are one trade, in order</span></h3>
      <p class="note">${multi.length.toLocaleString()} of these took more than one hop.</p>
      <div id="actRouteCsv" style="margin-bottom:8px"></div>
      <div class="tablewrap"><table><thead><tr>
        <th>Route</th><th class="r">Hops</th><th class="r">Times</th><th class="r">Value in</th><th>Traded by</th><th class="r">Last</th>
      </tr></thead><tbody>${routes.slice(0, cap('routes')).map(r => `
        <tr>
          <td><span class="route">${r.path.map(esc).join('<span class="dim"> &rarr; </span>')}</span></td>
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
        <td${s.pool ? ` class="clickable" data-pool="${esc(s.pool.dex)}:${esc(String(s.pool.id))}"` : ''}>${s.pool ? `<span data-pm="${esc(s.pool.tokenA)}|${esc(s.pool.symA)}|${esc(s.pool.tokenB)}|${esc(s.pool.symB)}"></span><span class="pair">${pairLinks(s.pool)}</span> <span class="venue ${esc(s.pool.dex)}">${esc(venueName[s.pool.dex] || s.pool.dex)}</span>` : ''} <span class="sub">#${esc(s.poolId)}</span></td>
        <td class="mono">${acctLink(s.trader)}</td>
        <td class="r num">${qty(Math.abs(inA ? s.amountA : s.amountB))} <span class="sub">${s.pool ? tokLink(inA ? s.pool.tokenA : s.pool.tokenB, inA ? s.symA : s.symB) : esc(inA ? s.symA : s.symB)}</span></td>
        <td class="r num">${qty(Math.abs(inA ? s.amountB : s.amountA))} <span class="sub">${s.pool ? tokLink(inA ? s.pool.tokenB : s.pool.tokenA, inA ? s.symB : s.symA) : esc(inA ? s.symB : s.symA)}</span></td>
        <td class="r num">${usd(s.volumeReal ?? s.volumeUsd)}</td></tr>`;
    }).join('')}</tbody></table></div>`;

  fillMarks(out);
  out.querySelectorAll('td[data-pool]').forEach(td => td.onclick = rowClick(() => openPool(td.dataset.pool)));

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
  // "Most active traders" used to rank the few hundred swaps this page happens
  // to be showing, which meant a board of four-dollar trades from whoever
  // touched the chain in the last few minutes. It said nothing, because it was
  // measuring nothing. The nightly pass walks a full day — 113,376 swaps — and
  // already ranks them; this is that answer, with the trade count beside the
  // volume because one is not the other, and every name clickable because the
  // whole point of the question is who they are.
  const mv = nightlyFile()?.movers;
  const box = $('#actBars');
  if (mv?.length) {
    const hrs = nightlyFile()?.scope?.windowHours;
    box.innerHTML = `<div class="tablewrap" style="border:0"><table style="font-size:12.5px">
      <thead><tr><th>Account</th><th class="r">Moved</th><th class="r">Trades</th><th class="r">Pools</th></tr></thead>
      <tbody>${mv.slice(0, 10).map(m => `<tr>
        <td>${acctLink(m.a)}</td>
        <td class="r num">${usd(m.v)}</td>
        <td class="r num dim">${(m.n || 0).toLocaleString()}</td>
        <td class="r num dim">${m.p ?? '—'}</td>
      </tr>`).join('')}</tbody></table></div>
      <p class="sub" style="margin:8px 0 0">Over ${hrs ? hrs.toFixed(0) + ' hours' : 'a day'}, from every Alcor swap in the window.</p>`;
  } else {
    // The feed slice is a poor second, so it says what it is rather than
    // pretending to answer the same question.
    box.appendChild(bars([...traders].sort((a, b) => b[1].usd - a[1].usd).slice(0, 8)
      .map(([label, t]) => ({ label, value: t.usd, note: `${t.n} trade${t.n === 1 ? '' : 's'}` })), { fmt: usd }));
  }
}

// -------------------------------------------------------- ACCOUNT DETAIL ----
// What one account holds, and what it has been doing.
//
// Reached by clicking any wallet name anywhere in the terminal — a holder, a
// liquidity provider, a trader in the feed. The question "who is that" is the
// one this app was asking readers to answer somewhere else.
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
  //
  // Three stat tiles and two full tables for what is, on most WAX markets, six
  // resting orders. One block, both sides against a shared price ladder, the
  // spread in the middle where it belongs.
  const cum = rows => { let t = 0; return rows.map(o => ({ ...o, cum: (t += o.quote) })); };
  const bids = cum(b.bid.slice(0, 8)), asks = cum(b.ask.slice(0, 8));
  const most = Math.max(bids.at(-1)?.cum || 0, asks.at(-1)?.cum || 0, 1);
  const row = (o, cls) => `<tr class="obrow" title="${esc(o.account)} · ${qty(o.quote)} ${esc(symbol)} at ${qty(o.price)} WAX">
      <td class="obbar"><span class="${cls}" style="width:${(o.cum / most * 100).toFixed(1)}%"></span></td>
      <td class="r num ${cls === 'obbid' ? 'pos' : 'neg'}">${qty(o.price)}</td>
      <td class="r num">${qty(o.quote)}</td>
      <td class="mono dim obwho">${acctLink(o.account)}</td>
    </tr>`;

  box.innerHTML = `
    <div class="obook">
      <table><tbody>${asks.slice().reverse().map(o => row(o, 'obask')).join('')
        || '<tr><td colspan="4" class="dim obnone">nobody selling</td></tr>'}</tbody></table>
      <div class="obmid">
        <span class="obspread">${b.spread != null ? (b.spread * 100).toFixed(2) + '% spread' : 'one side only'}</span>
        <span class="dim">${b.best.bid != null ? qty(b.best.bid) : '—'} / ${b.best.ask != null ? qty(b.best.ask) : '—'} WAX</span>
        <span class="dim">${(b.bid.length + b.ask.length).toLocaleString()} resting</span>
      </div>
      <table><tbody>${bids.map(o => row(o, 'obbid')).join('')
        || '<tr><td colspan="4" class="dim obnone">nobody bidding</td></tr>'}</tbody></table>
    </div>

    <p class="sub" style="margin:10px 0 0">Read-only &mdash; place and cancel on Alcor. Market #${market.id}${market.feeBps ? ` &middot; ${(market.feeBps / 100).toFixed(2)}% fee` : ' &middot; no fee'} </p>`;

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
      <p class="sub" style="margin:8px 0 0">No pool on any venue holds it.</p>
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
  const farms = seedApr(farmGroups()).filter(g => g.pool && (g.pool.tokenA === id || g.pool.tokenB === id));
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

    <div class="stats">
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

    ${farms.length ? `<div class="cta" style="margin-bottom:14px">
      <div><b>${farms.length} farm${farms.length === 1 ? '' : 's'} on pools holding ${esc(t.symbol)}</b>
        <span class="sub">${farms.slice(0, 4).map(g => `<span class="xlink" data-farmkey="${esc(g.key)}">${g.pool ? esc(g.pool.symA) + '/' + esc(g.pool.symB) : esc(g.poolId)}</span>${g.aprReal != null || g.apr != null ? ` <b>${pct(g.aprReal ?? g.apr)}</b>` : ''}`).join(' &middot; ')}${farms.length > 4 ? ` &middot; and ${farms.length - 4} more` : ''} &mdash; ${usd(farms.reduce((a, g) => a + (g.rewardUsdDay || 0), 0))} a day between them</span></div>
    </div>` : ''}

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
          <dt>Time-locked</dt><dd class="mono" id="fLocked">—</dd>
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
      <div class="card"><p class="sub" style="margin:0">No venue holding ${esc(t.symbol)} keeps replayable state — no chart, no history.</p></div>
    </div>`}

    <div class="section"><h3>Order book <span class="dim">&mdash; resting orders the pools do not show</span></h3>
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
            ? `${(d.topPartner.share * 100).toFixed(0)}% of the value opposite ${esc(t.symbol)} is ${esc(d.topPartner.token.split('@')[0])}.`
              + (d.sameIssuerShare > 0.2 ? ` ${(d.sameIssuerShare * 100).toFixed(0)}% from one issuer.` : '')
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
  wirePromote($('#tokenDetail'));
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
        <td><span data-pm="${esc(p.tokenA)}|${esc(p.symA)}|${esc(p.tokenB)}|${esc(p.symB)}"></span>${pairLinks(p)}</td>
        <td class="dim">${esc(p.dex)}</td>
        <td class="r num dim">${(p.feeBps / 100).toFixed(2)}%</td>
        <td class="r num" title="${usd(p.tvl)} at face value">${usd(p.tvlReal)}</td>
        <td class="r num ${p.vol24 > 0 ? '' : 'dim'}">${p.vol24 > 0 ? usd(p.vol24) : '—'}</td>
      </tr>`).join('')}</tbody></table></div>`;
  fillMarks($('#tokPools'));
  $('#tokPools').querySelectorAll('tr[data-pool]').forEach(tr => tr.onclick = rowClick(() => openPool(tr.dataset.pool)));

  if (farms.length) {
    $('#tokFarms').innerHTML = `<div class="tablewrap" style="max-height:none;border:0"><table style="font-size:12.5px">
      <thead><tr><th>Pool</th><th>Pays</th><th class="r">Per day</th><th class="r">Staked</th><th class="r">APR</th><th>Trend</th><th class="r">Runway</th></tr></thead>
      <tbody>${farms.slice(0, cap('farms')).sort((a, b) => (b.rewardRealDay || 0) - (a.rewardRealDay || 0)).map(g => `
        <tr data-fpool="${esc(g.key)}" style="cursor:pointer">
          <td>${g.pool ? `<span data-pm="${esc(g.pool.tokenA)}|${esc(g.pool.symA)}|${esc(g.pool.tokenB)}|${esc(g.pool.symB)}"></span>${pairLinks(g.pool)} <span class="dim">${(g.pool.feeBps / 100).toFixed(2)}%</span>` : esc(g.poolId)}</td>
          <td>${[...new Map(g.rewards.map(r => [r.token, r.symbol]))].slice(0, 4).map(([tk, sym]) => tokLink(tk, sym)).join(', ')}</td>
          <td class="r num">${usd(g.rewardRealDay)}</td>
          <td class="r num">${g.stakedReal != null ? usd(g.stakedReal) : '<span class="dim">—</span>'}</td>
          <td class="r num">${g.aprReal != null ? pct(g.aprReal) : '<span class="dim">—</span>'}</td>
          <td data-apr="${esc(g.key)}"><span class="dim">…</span></td>
          <td class="r num dim">${g.runwayDays != null && isFinite(g.runwayDays) ? Math.round(g.runwayDays) + 'd' : '—'}</td>
        </tr>`).join('')}</tbody></table></div>`;
  fillMarks($('#tokFarms'));
    $('#tokFarms').querySelectorAll('tr[data-fpool]').forEach(tr => tr.onclick = rowClick(() => openFarm(tr.dataset.fpool)));
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
      el.innerHTML = `<p class="sub" style="margin:0">None in this contract&rsquo;s tables. A rate held in code is invisible from outside.</p>`;
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
      <p class="sub" style="margin:10px 0 0">${burn > 0 ? `The ${(burn / 100).toFixed(2)}% to eosio.null is destroyed. ` : ''}Charged at every hop of a route.</p>`;
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
    const lockPct = stats.supply > 0 ? stats.locked / stats.supply * 100 : 0;
    const unlockDay = stats.nextUnlock ? new Date(stats.nextUnlock * 1000).toISOString().slice(0, 10) : null;
    set('#fLocked', stats.locked > 0
      ? `${qty(stats.locked)} <span class="dim">(${lockPct.toFixed(2)}% of supply${unlockDay ? `, next unlocks ${unlockDay}` : ''})</span>`
        + (stats.claimable > 0 ? `<br><span class="dim">${qty(stats.claimable)} is past its date and waiting to be claimed</span>` : '')
      : '<span class="dim">none</span>');
    set('#fCirc', qty(stats.circulating));
    set('#fIssuer', esc(stats.issuer || '—'));
    set('#tokCirc', qty(stats.circulating));
    // What is left out of circulating, and why. Both are provable: burned
    // tokens sit in an account with no keys, locked ones in a contract that
    // will not release them before a date.
    set('#tokBurn', [
      stats.burned > 0 ? `${qty(stats.burned)} burned` : '',
      stats.locked > 0 ? `${qty(stats.locked)} locked${unlockDay ? ` to ${unlockDay}` : ''}` : '',
    ].filter(Boolean).join(' &middot; ') || `of ${qty(stats.maxSupply)} ever`);
    if (t.price != null) {
      set('#tokCap', usd(stats.circulating * t.price));
      // A cap on paper supply is a different number from a cap on what can
      // actually be sold, so when they differ it says by how much.
      const paper = stats.supply * t.price;
      const real = stats.circulating * t.price;
      set('#tokCapSub', `${(t.tvl / real * 100).toFixed(1)}% of it is pooled`
        + (paper > real * 1.05 ? ` &middot; ${usd(paper)} on paper supply` : ''));
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
            <td class="pools-cell" title="${esc(s.pools.join(' + '))}">${s.pools.map(esc).join('<span class="dim"> + </span>')}</td>
            <td class="${s.side === 'bought' ? 'pos' : s.side === 'sold' ? 'neg' : 'dim'}">${s.side}</td>
            <td class="r num">${qty(s.amount)}</td>
            <td class="r num">${s.usd != null ? usd(s.usd) : '<span class="dim">—</span>'}</td>
          </tr>`).join('')}</tbody></table></div>
          <p class="sub" style="margin:9px 0 0">${all.length.toLocaleString()} trades, newest ${Math.min(all.length, cap('tokenTape')).toLocaleString()} shown.</p>`;
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
      <p class="sub" style="margin:9px 0 0">${top.length ? `Busiest senders: ${top.map(([a, v]) => `${acctLink(a)} <span class="dim">(${qty(v)})</span>`).join(', ')}` : 'All transfers came from a DEX contract.'}</p>`;
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
          <td class="route-cell" title="${top ? esc(top[0]) : ''}">${top ? `<span class="route">${esc(top[0])}</span>${hops > 2 ? ' <span class="badge warn">multi-hop</span>' : ''}` : '<span class="dim">out only</span>'}</td>
        </tr>`;
      }).join('')}</tbody></table></div>
      <p class="sub" style="margin:9px 0 0">${capNote(list.length, Math.min(list.length, cap('routes')), 'accounts', { filterable: false })} ${complete ? 'in 24h' : `back to ${ago(new Date(covered).toISOString())}`}. &ldquo;Out only&rdquo; means they received ${esc(t.symbol)} rather than sent it.</p>`;
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
      <p class="sub" style="margin:9px 0 0">${lps.length} accounts supply ${esc(t.symbol)}.</p>`;
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
        : 'Needs three days recorded';
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
      <td class="mono">${acctLink(h.account)}${h.contractRole ? `<span class="venue" title="A contract account">${esc(h.contractRole)}</span>` : ''}</td>
      <td class="r num">${qty(h.balance)}</td>
      <td class="r num ${h.lp > 0 ? '' : 'dim'}">${h.lp > 0 ? qty(h.lp) : '—'}</td>
      <td class="r num ${share(h.balance) > 10 && !h.contractRole ? 'warnish' : 'dim'}">${share(h.balance) == null ? '' : share(h.balance).toFixed(2) + '%'}</td>
    </tr>`).join('')}</tbody></table></div>
    <p class="sub" style="margin:9px 0 0">${supply > 0 ? `Top ${top.length} hold ${(top.reduce((a, h) => a + h.balance, 0) / supply * 100).toFixed(1)}% of supply${holderTotal ? ` of ${holderTotal.toLocaleString()} holders` : ''}. ` : ''}</p>`;

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

  // Detail is a control, not a constant. The old map kept a transfer only when
  // both ends were already top holders, which threw away the edge that matters
  // most — a deployer moving supply to a fresh wallet — and left a ring of
  // bubbles with nothing between them.
  let mapDetail = 0.0001;
  const drawMap = async () => {
    const box = $('#tokBubbles');
    box.innerHTML = '<div class="loading"><span class="spinner"></span><span>Following the transfers…</span></div>';
    let g;
    try { g = await transferGraph(t.contract, t.symbol, holders, { supply, minShare: mapDetail }); }
    catch { box.innerHTML = '<div class="chart-empty">Could not read the transfer history.</div>'; return; }
    box.innerHTML = `<div class="toolbar" style="margin:0 0 8px">
      <span class="dim" style="font-size:11.5px">Show transfers over</span>
      ${[[0.001, '0.1%'], [0.0001, '0.01%'], [0.00002, '0.002%']].map(([v, lbl]) =>
        `<button class="chip" data-detail="${v}" aria-pressed="${v === mapDetail}">${lbl} of supply</button>`).join('')}
      <span class="dim" style="font-size:11.5px">${g.nodes.length} wallets &middot; ${g.links.length} link${g.links.length === 1 ? '' : 's'}</span>
    </div>`;
    const holder = document.createElement('div');
    box.appendChild(holder);
    holder.appendChild(bubbleMap(g.nodes, g.links, {
      cap: 40, fmt: v => qty(v) + ' ' + t.symbol,
      onPick: acct => { show('wallet', acct); $('#walletInput').value = acct; lookupWallet(acct); },
    }));
    box.querySelectorAll('[data-detail]').forEach(b => b.onclick = () => { mapDetail = Number(b.dataset.detail); drawMap(); });
  };

  try {
    await drawMap();
  } catch { $('#tokBubbles').innerHTML = '<div class="chart-empty">Could not trace transfers.</div>'; }
}


// Why a rate is missing, which is more useful than an em dash.
const aprWhy = st => st === 'no_stake' ? 'nobody has staked, so there is no rate yet'
  : st === 'thin' ? 'too little staked to divide by'
  : st === 'unpriceable' ? 'the reward has no price this terminal will stand behind'
  : st === 'ended' ? 'this farm has finished'
  : st === 'no_farm' ? 'no farm here — the fee APR beside it is what it pays'
  : 'not computed yet';


// ------------------------------------------------------- CREATE A POOL ------
// The market that does not exist yet.
//
// Alcor lets anyone open one, and until now this terminal could only ever show
// you markets other people had made. The two things that are easy to get wrong
// — which token the chain calls A, and the starting price as a uint128 — are
// derived in tx.js and checked against all 751 live pools, so this panel only
// has to ask the three questions a person actually has.
function renderCreatePool(box) {
  if (!box) return;
  if (box.dataset.open === '1') { box.dataset.open = '0'; box.innerHTML = ''; return; }
  box.dataset.open = '1';

  // Only tokens with a pool already: a symbol nothing has ever traded is
  // almost always a typo, and the picker is long enough as it is.
  // Ordered by how much of each is pooled, so the tokens anyone would actually
  // open a market against are at the top. Sorting on price put WAXWBTC first,
  // which tells you only that a bitcoin is expensive.
  const weight = new Map();
  for (const p of state.pools) {
    for (const id of [p.tokenA, p.tokenB]) weight.set(id, (weight.get(id) || 0) + (p.tvlReal || 0) / 2);
  }
  const toks = [...state.tokens.values()]
    .filter(t => t.symbol && t.contract)
    .sort((a, b) => (weight.get(b.id) || 0) - (weight.get(a.id) || 0) || a.symbol.localeCompare(b.symbol));
  const opts = sel => toks.map(t =>
    `<option value="${esc(t.id)}"${t.id === sel ? ' selected' : ''}>${esc(t.symbol)} &mdash; ${esc(t.contract)}</option>`).join('');

  let fee = 30;
  box.innerHTML = `<div class="card"><h3>Create a pool</h3>
    <div class="filters" style="display:grid;gap:8px;margin:0">
      <label>Base<select id="cpA">${opts('WAX@eosio.token')}</select></label>
      <label>Quote<select id="cpB">${opts('CHEESE@cheeseburger')}</select></label>
      <label id="cpPriceLab">Starting price<input id="cpPrice" type="number" step="any" min="0" placeholder="0" inputmode="decimal"></label>
    </div>
    <div class="toolbar" style="margin:10px 0 0">
      <span class="sub">Fee</span>
      ${[[5, '0.05%'], [30, '0.30%'], [100, '1.00%']].map(([v, l]) =>
        `<button class="chip" data-cpfee="${v}"${v === 30 ? ' aria-pressed="true"' : ''}>${l}</button>`).join('')}
      <span class="dim" id="cpNote" style="font-size:12px;margin-left:auto"></span>
    </div>
    <div id="cpOut" style="margin-top:10px"></div>
    <div class="toolbar" style="margin:10px 0 0">
      <button class="btn ghost" id="cpClose">Cancel</button>
      <button class="btn" id="cpGo">Create</button>
    </div></div>`;

  const q = sel => box.querySelector(sel);
  const paint = () => {
    const a = state.tokens.get(q('#cpA').value), b = state.tokens.get(q('#cpB').value);
    const lab = q('#cpPriceLab');
    if (a && b) lab.firstChild.textContent = `Starting price — ${b.symbol} per ${a.symbol} `;
    const px = num(q('#cpPrice').value) || 0;
    const pa = a && state.prices.get(a.id)?.usd, pb = b && state.prices.get(b.id)?.usd;
    const note = q('#cpNote');
    // If both sides are priced we already know what the market says, so the
    // field is not a blank someone has to guess at.
    if (note) note.innerHTML = (pa && pb)
      ? `market is <b>${sigfig(pa / pb)}</b> <span class="dim">&mdash; <span class="xlink" id="cpUse">use it</span></span>`
      : '';
    const u = q('#cpUse');
    if (u) u.onclick = () => { q('#cpPrice').value = String(pa / pb); paint(); };

    const out = q('#cpOut');
    if (!a || !b || a.id === b.id) { out.innerHTML = '<p class="sub" style="margin:0">Pick two different tokens.</p>'; return; }
    if (!(px > 0)) { out.innerHTML = '<p class="sub" style="margin:0">Enter the price this pool should open at.</p>'; return; }
    const exists = state.pools.find(p => p.dex === 'alcor' && p.feeBps === fee
      && ((p.tokenA === a.id && p.tokenB === b.id) || (p.tokenA === b.id && p.tokenB === a.id)));
    if (exists) {
      out.innerHTML = `<div class="note warn">This pool already exists at that fee tier &mdash;
        ${poolLink('alcor', exists.id, `${esc(exists.symA)}/${esc(exists.symB)}`)} holds ${usd(exists.tvlReal)}.</div>`;
      return;
    }
    let built;
    try { built = buildCreatePool({ tokenA: a.id, tokenB: b.id, price: px, feeBps: fee, me: wallet.account() || 'eosio.null' }); }
    catch (e) { out.innerHTML = `<p class="sub" style="margin:0">${esc(e.message)}</p>`; return; }
    const { a: oa, b: ob } = built.ordered;
    out.innerHTML = `<div class="planline"><span class="k">The chain will store it as</span><span>
      <b>${esc(oa.symbol)}/${esc(ob.symbol)}</b> <span class="dim">&mdash; the order is the contract account, not your choice</span></span></div>
      <div class="planline"><span class="k">Opens at</span><span>${sigfig(px)} ${esc(b.symbol)} per ${esc(a.symbol)}</span></div>
      <div class="planline"><span class="k">Costs</span><span>RAM for the row, and nothing else. The pool starts empty &mdash; you add liquidity after.</span></div>`;
  };

  box.querySelectorAll('[data-cpfee]').forEach(btn => btn.onclick = () => {
    fee = Number(btn.dataset.cpfee);
    box.querySelectorAll('[data-cpfee]').forEach(x => x.setAttribute('aria-pressed', String(x === btn)));
    paint();
  });
  q('#cpA').onchange = paint; q('#cpB').onchange = paint; q('#cpPrice').oninput = paint;
  q('#cpClose').onclick = () => { box.dataset.open = '0'; box.innerHTML = ''; };
  q('#cpGo').onclick = async () => {
    const out = q('#cpOut');
    if (!wallet.account()) { try { await wallet.connect(); } catch { return; } }
    const a = state.tokens.get(q('#cpA').value), b = state.tokens.get(q('#cpB').value);
    const px = num(q('#cpPrice').value) || 0;
    try {
      const built = buildCreatePool({ tokenA: a.id, tokenB: b.id, price: px, feeBps: fee, me: wallet.account() });
      const r = await wallet.transact(built.actions, { verify: true });
      out.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)">
        <b>Created.</b> ${esc(built.ordered.a.symbol)}/${esc(built.ordered.b.symbol)} at ${(fee / 100).toFixed(2)}%.
        It will appear here after the next snapshot; add liquidity from the pool page.
        <br><a class="mono" style="font-size:11px" href="${trxUrl(r.id)}" target="_blank" rel="noopener">${r.id.slice(0, 16)}… &nearr;</a></div>`;
    } catch (e) { out.innerHTML = `<div class="err">${esc(e?.message || e)}</div>`; }
  };
  paint();
}


// ------------------------------------------------------------- ZAP IN -------
// One token becomes a position. Someone holding only WAX who wants to be in a
// CHEESE/HOLE band otherwise has to work out the ratio, sell the right
// fraction, deposit both sides and stake — four places to get the arithmetic
// wrong, and getting it wrong means a revert or a lopsided deposit.
// Ticks must land on the pool's own spacing or the contract rejects them, and a
// band is not symmetric in price — halving and doubling are not mirror images
// on a log scale, so each side is computed from its own ratio and rounded
// outward. Shared by both ways of funding a position.
function bandTicks(pool, band) {
  const spacing = pool.tickSpacing || 60;
  const MAX = Math.floor(443580 / spacing) * spacing;
  if (band === 'full') return { lower: -MAX, upper: MAX };
  const pct = Number(band) / 100;
  const cur = pool.tick ?? 0;
  const T = r => Math.log(r) / Math.log(1.0001);
  return {
    lower: Math.max(-MAX, Math.floor((cur + T(1 - pct)) / spacing) * spacing),
    upper: Math.min(MAX, Math.ceil((cur + T(1 + pct)) / spacing) * spacing),
  };
}
const priceAtTick = (pool, t) => Math.pow(1.0001, t) * 10 ** (pool.decA - pool.decB);

const SLIPPAGE_PCT = 2;

function renderZap(box, pool, { incentiveIds = [], account, embedded = false } = {}) {
  if (!box) return;
  const feeAccount = CFG?.commercial?.feeAccount || '';
  const feeBps = feeAccount ? Math.max(0, Math.min(200, CFG?.commercial?.zapFeeBps ?? 0)) : 0;
  const sqrtP = sqrtPriceFromX64(pool.sqrtX64);
  let fromToken = pool.tokenA;
  let band = '50';

  // A quote is a network call, so an older one can land after a newer one.
  // Every paint takes a ticket and drops its result if it is no longer the
  // latest — otherwise typing "25" briefly shows the answer for "2".
  let gen = 0;
  const paint = async () => {
    const mine = ++gen;
    const { lower: tickLower, upper: tickUpper } = bandTicks(pool, band);
    const lo = priceAtTick(pool, tickLower), hi = priceAtTick(pool, tickUpper);
    const now = priceAtTick(pool, pool.tick ?? 0);
    const bandNote = $('#zapBand');
    if (bandNote) bandNote.innerHTML = band === 'full'
      ? `Earns at every price, and earns least per dollar for it.`
      : `${sigfig(lo)} &ndash; ${sigfig(hi)} ${esc(pool.symB)} per ${esc(pool.symA)}, now ${sigfig(now)}. Outside it, this position earns nothing.`;
    const amt = num($('#zapAmt')?.value) || 0;
    const out0 = $('#zapOut');
    if (out0 && amt > 0 && !out0.dataset.painted) out0.innerHTML = `<p class="sub" style="margin:0">Finding the best route\u2026</p>`;
    const plan = await planZap({ pool, tickLower, tickUpper, fromToken, amount: amt, feeBps, sqrtP, me: account });
    if (mine !== gen) return;
    const out = $('#zapOut');
    if (!out) return;
    out.dataset.painted = '1';
    if (!plan.ok) { delete out.dataset.painted; out.innerHTML = `<p class="sub" style="margin:0">${esc(plan.reason)}</p>`; return; }
    out.innerHTML = `<div class="dests">
        <div class="dest in"><span class="lbl">Into the pool</span>
          <span class="amt">${usd(plan.usd - (plan.usd * feeBps / 10000))}</span>
          <span class="det">${[
            plan.keep > 0 ? `${qty(plan.keep)} ${esc(plan.symFrom)}` : '',
            ...plan.legs.map(l => `about ${qty(l.expect)} ${esc(l.sym)}`),
          ].filter(Boolean).join(' + ')}</span></div>
        <div class="dest out"><span class="lbl">Sold to get there</span>
          <span class="amt">${plan.needsSwap ? qty(plan.toSwap) + ' ' + esc(plan.symFrom) : 'nothing'}</span>
          <span class="det">${feeBps > 0 ? `${qty(plan.fee)} ${esc(plan.symFrom)} fee (${(feeBps / 100).toFixed(2)}%)` : 'no fee'}${plan.legs.length > 1 ? ' &middot; two swaps' : ''}</span></div>
      </div>
      ${(() => {
        const inUsd = plan.usd - plan.usd * feeBps / 10000;
        const fa = feeApr(pool);
        const farmA = farmAprFor(pool, inUsd);
        if (!(inUsd > 0) || (fa == null && farmA == null)) return '';
        const day = ((fa || 0) + (farmA || 0)) / 100 * inUsd / 365;
        const rate = r => r == null ? null : r > 999 ? 'off the scale' : pct(r);
        // What YOUR deposit does, where the decision is made. Joining a farm
        // puts your money in the denominator, so the rate on the board is the
        // rate the people already in it get — never the one you would get. On a
        // small farm that gap is most of the number.
        const before = farmAprFor(pool, 0.01);
        const shrink = (before != null && farmA != null && before > farmA * 1.02)
          ? ` <span class="dim">from</span> ${rate(before)}` : '';
        const share = pool.tvlReal > 0 ? inUsd / (pool.tvlReal + inUsd) : null;
        return `<div class="planline"><span class="k">Then earns</span><span>${usd(day)} a day
          <span class="dim">&mdash; farm ${rate(farmA) ?? 'none'}${shrink} &middot; fees ${rate(fa) ?? 'none'}</span></span></div>`
          + (share != null ? `<div class="planline"><span class="k">You would own</span><span>${
            (share * 100).toFixed(share >= 0.1 ? 1 : 2)}% of the pool
            <span class="dim">&mdash; ${usd(inUsd)} against ${usd(pool.tvlReal)} already there</span></span></div>` : '');
      })()}
      ${plan.needsSwap ? `<div class="planline"><span class="k">Route</span><span>${plan.routed === 'alcor'
        ? `Alcor&rsquo;s router &middot; ${plan.legs.map(l => `${esc(l.sym)} in ${l.hops} pool${l.hops === 1 ? '' : 's'}${l.split ? ', split' : ''}`).join(' &middot; ')}`
        : `<span class="dim">Alcor&rsquo;s router did not answer &mdash; our own map, a day old</span>`}${
        plan.legs.some(l => l.impact != null)
          ? ` <span class="dim">&middot; moves</span> ${plan.legs.filter(l => l.impact != null).map(l => `${esc(l.sym)} <b class="${l.impact > 0.05 ? 'neg' : ''}">${(l.impact * 100).toFixed(l.impact < 0.01 ? 2 : 1)}%</b>`).join(' &middot; ')}`
          : ''}</span></div>` : ''}
      <div class="planline"><span class="k">Costs</span><span>${feeBps > 0 ? `${(feeBps / 100).toFixed(2)}% zap fee` : 'no zap fee'}${
        // A quoted route has already taken the swap fee out — every pool it
        // crosses, at whatever tier each one charges. Naming a rate here would
        // be charging it twice, and naming this pool's rate would be wrong
        // anyway when the route goes somewhere else.
        plan.routed === 'alcor' ? '' : ` &middot; ${(pool.feeBps / 100).toFixed(2)}% on each swap${plan.legs.length > 1 ? ' (two)' : ''}`
      } &middot; ${(SLIPPAGE_PCT).toFixed(0)}% slippage &middot; ${plan.needsSwap ? 'two signatures' : 'one signature'}${incentiveIds.length ? `, stakes into ${incentiveIds.length} farm${incentiveIds.length === 1 ? '' : 's'}` : ''}</span></div>
      ${plan.legs.some(l => l.impact > 0.25) ? `<div class="note warn">Too big for the route. Zap less, or bring one of the pool&rsquo;s own tokens.</div>` : ''}
      <button class="btn" id="zapGo" style="width:100%;margin-top:8px">Zap in</button>
      <div class="runbox" id="zapRun"></div>`;
    $('#zapGo').onclick = () => runZap(pool, plan, { tickLower, tickUpper, incentiveIds, account, feeAccount });
  };

  // Embedded inside the farm page's own "Open a position" card, this panel
  // does not bring a second card and a second heading saying the same thing.
  box.innerHTML = `<div class="${embedded ? '' : 'card'}">${embedded ? '' : '<h3>Open a position <span class="dim">&mdash; one token, straight in</span></h3>'}
    <div class="toolbar" style="margin:0 0 6px">
      <span class="sub">Range</span>
      ${[['full', 'Full'], ['50', '\u00b150%'], ['20', '\u00b120%'], ['5', '\u00b15%']].map(([v, l]) =>
        `<button class="chip" data-zapband="${v}"${v === '50' ? ' aria-pressed="true"' : ''}>${l}</button>`).join('')}
    </div>
    <p class="sub" id="zapBand" style="margin:0 0 10px"></p>
    <div class="toolbar" style="margin:0 0 10px">
      <span class="sub">Bring</span>
      ${[[pool.tokenA, pool.symA], [pool.tokenB, pool.symB], ['WAX@eosio.token', 'WAX'], ['WAXUSDC@eth.token', 'WAXUSDC']]
        .filter(([id], i, all) => all.findIndex(x => x[0] === id) === i)
        .map(([id, sym], i) => `<button class="chip" data-zaptok="${esc(id)}"${i === 0 ? ' aria-pressed="true"' : ''}>${esc(sym)}</button>`).join('')}
      <span class="sizesel"><span class="amt"><input id="zapAmt" type="number" min="0" step="any" placeholder="amount" inputmode="decimal"></span></span>
    </div>
    <div id="zapOut"></div></div>`;
  box.querySelectorAll('[data-zapband]').forEach(b => b.onclick = () => {
    band = b.dataset.zapband;
    box.querySelectorAll('[data-zapband]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    paint();
  });
  box.querySelectorAll('[data-zaptok]').forEach(b => b.onclick = () => {
    fromToken = b.dataset.zaptok;
    box.querySelectorAll('[data-zaptok]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    paint();
  });
  // Typing is one request per settled value, not one per keystroke: the person
  // most likely to have this open is also running bots against the same host
  // from the same address, and Cloudflare counts the address.
  $('#zapAmt').oninput = debounce(paint, 350);
  paint();
}

async function runZap(pool, plan, { tickLower, tickUpper, incentiveIds, account, feeAccount }) {
  const box = $('#zapRun');
  const btn = $('#zapGo');
  const steps = [
    { t: 'Sell and pay the fee', d: `Sell ${qty(plan.toSwap)} ${plan.symFrom} into ${plan.legs.map(l => l.sym).join(' and ')}. Only what you are zapping is spent.` },
    { t: 'Deposit and stake', d: `Add what arrived into the band${incentiveIds.length ? ' and stake it' : ''}.` },
  ];
  const render = (i, msg, { err = null, cta = null } = {}) => {
    box.innerHTML = `<div class="steps">${steps.map((st, n) => `
      <div class="step ${n < i ? 'done' : n === i ? 'active' : ''}">
        <span class="n">${n < i ? '&check;' : n + 1}</span>
        <div><h4>${st.t}</h4><p>${n === i && msg ? esc(msg) : st.d}</p></div>
      </div>`).join('')}</div>
      ${err ? `<div class="err" style="margin-top:10px">${esc(err)}</div>` : ''}
      ${cta ? `<button class="btn" style="margin-top:10px;width:100%" data-next>${esc(cta)}</button>` : ''}`;
  };
  const press = (i, label, note) => new Promise(r => {
    render(i, note, { cta: label });
    box.querySelector('[data-next]').onclick = e => { e.currentTarget.disabled = true; r(); };
  });

  try {
    if (!wallet.account()) { try { await wallet.connect(); } catch { return; } }
    const me = wallet.account();
    if (!me) throw new Error('No wallet connected — connect one and try again.');
    btn.disabled = true;

    // Read both sides first, so what the swap produced can be told from what
    // was already held.
    const before = await readBalances(pool, [pool.tokenA, pool.tokenB], me);

    const t1 = await buildZapSwap({ pool, plan, feeAccount, me });
    render(0, 'Waiting for your wallet…');
    if (t1.actions.length) await wallet.transact(t1.actions, { verify: true });

    render(1, 'Measuring what arrived…');
    await new Promise(r => setTimeout(r, 2500));
    const dep = await buildZapDeposit({ pool, tickLower, tickUpper, plan, before, incentiveIds, me });
    await press(1, 'Deposit and stake', `Add ${qty(dep.depA)} ${pool.symA} and ${qty(dep.depB)} ${pool.symB} into the band.`);
    render(1, 'Waiting for your wallet…');
    const r2 = await wallet.transact(dep.actions, { verify: true });

    box.innerHTML = `<div class="err" style="border-color:var(--good);background:var(--good-soft)">
      <b>In.</b> ${qty(dep.depA)} ${esc(pool.symA)} and ${qty(dep.depB)} ${esc(pool.symB)} deposited${dep.staking ? ` and staked into ${dep.staking} farm${dep.staking === 1 ? '' : 's'}` : ''}.
      <br><a class="mono" style="font-size:11px" href="${trxUrl(r2.id)}" target="_blank" rel="noopener">${r2.id.slice(0, 16)}… &nearr;</a></div>`;
  } catch (e) {
    render(0, null, { err: String(e?.message || e) });
  } finally { if (btn) btn.disabled = false; }
}

// ---------------------------------------------------------- FARM DETAIL -----
// A farm is not a pool. It has an end date, a creator, a pot split across
// incentives that each pay a different token at a different rate, and a set of
// stakers sharing it — none of which fits in a card on the pool page, which is
// why clicking a farm used to land somewhere that answered a different question.
// A market has one page.
//
// It had two: a pool page with the price, the depth and the providers, and a
// farm page with what it pays and how to get in. The same market, forked in
// two, so answering one question meant going back out to the list and coming in
// again the other way. "veel info staat er maar wel op onlogische manieren aan
// elkaar gelinkt. teveel rondgeklik."
//
// So the farm half is a section of the market page now, and #farm/... still
// resolves — old links keep working, they just land on the whole thing.
async function openFarm(key) { return openPool(key); }

// The farm half, rendered into whatever container the market page gives it.
async function renderFarmParts(g, out) {
  if (!g || !out) return;
  const p = g.pool;
  const now = Date.now();

  // Per incentive, because that is the unit a farm is actually funded in: two
  // incentives on one pool can pay different tokens, at different rates, ending
  // on different days.
  const rows = [...g.farms].sort((a, b) => (b.rewardUsdDay || 0) - (a.rewardUsdDay || 0));
  // A TacoSwap farm carries no periodFinish: it runs until its funding is spent,
  // and the record says so with `ended: false`. Reading "no end date" as "ended"
  // reported a live farm as finished — $0 a day against a row plainly showing
  // $5.12, and the word "ended" beside "open" in the same row.
  const isLive = f => (f.periodFinish ? f.periodFinish > now : !f.ended);
  const live = rows.filter(isLive);
  const potDay = rows.reduce((s, f) => s + (f.rewardUsdDay || 0), 0);
  const liveDay = live.reduce((s, f) => s + (f.rewardUsdDay || 0), 0);
  const dated = live.filter(f => f.periodFinish > 0);
  const endsAt = dated.length ? Math.max(...dated.map(f => f.periodFinish)) : null;
  const soonest = dated.length ? Math.min(...dated.map(f => f.periodFinish)) : null;
  const stakers = Math.max(0, ...rows.map(f => f.numStakes || 0));

  let farmStakedUsd = null;
  const days = ms => (ms == null ? null : Math.max(0, (ms - now) / 86400e3));
  const forHowLong = d => d == null ? '—'
    : d < 1 ? `${Math.round(d * 24)}h`
    : d < 60 ? `${Math.round(d)} days`
    : `${(d / 30).toFixed(1)} months`;

  // No heading and no "the pool holds $x" line: this renders inside the market
  // page, under a heading that already says both.
  out.innerHTML = `
    <h3 style="margin-top:4px">The farm ${live.length
      ? `<span class="pill good">${live.length} live</span>`
      : '<span class="pill">ended</span>'}</h3>
    <div class="stats">
      <div class="stat"><span class="v">${usd(liveDay)}</span><span class="k">paid out a day</span><span class="sub">${live.length} live incentive${live.length === 1 ? '' : 's'}${potDay > liveDay ? ` &middot; ${usd(potDay - liveDay)} in ended ones` : ''}</span></div>
      <div class="stat"><span class="v">${pct(g.aprReal ?? g.apr)}</span><span class="k">farm APR</span><span class="sub">${g.aprReal != null || g.apr != null ? '' : aprWhy(g.aprStatus)}</span></div>
      <div class="stat"><span class="v">${pct(feeApr(p))}</span><span class="k">fee APR</span><span class="sub">${esc(feeAprWhy(p))}</span></div>
      <div class="stat"><span class="v" id="farmStaked">${usd(g.stakedReal ?? g.stakedUsd)}</span><span class="k">staked in it</span><span class="sub">${g.dex === 'taco' ? 'held as LP tokens' : stakers ? `${stakers} position${stakers === 1 ? '' : 's'}` : 'nobody yet'}</span></div>
      <div class="stat"><span class="v">${soonest ? forHowLong(days(soonest)) : live.length ? 'open' : '—'}</span><span class="k">${soonest ? 'until the first ends' : 'runs until'}</span><span class="sub">${
        soonest ? (endsAt && endsAt !== soonest ? `last runs ${forHowLong(days(endsAt))}` : new Date(soonest).toISOString().slice(0, 10))
        : live.length ? 'its funding runs out — no end date on chain' : 'nothing running'}</span></div>
    </div>

    <div class="card" style="margin-bottom:14px"><h3>What it pays</h3>
      <div class="tablewrap" style="border:0"><table style="font-size:12.5px">
        <thead><tr><th>Reward</th><th class="r">Per day</th><th class="r">Value / day</th>${rows.length > 1 ? '<th class="r">Share of the pot</th>' : ''}<th class="r">Ends</th><th>Funded by</th></tr></thead>
        <tbody>${rows.map(f => {
          const ended = !isLive(f);
          return `<tr class="${ended ? 'dim' : ''}">
            <td><span data-pm="${esc(f.rewardToken)}|${esc(f.rewardSymbol)}"></span> <b>${tokLink(f.rewardToken, f.rewardSymbol)}</b>
              ${ended ? '<span class="pill">ended</span>' : ''}</td>
            <td class="r num">${qty(f.rewardPerDay)} <span class="sub">${esc(f.rewardSymbol)}</span></td>
            <td class="r num">${f.rewardUsdDay ? usd(f.rewardUsdDay) : '<span class="dim">unpriced</span>'}</td>
            ${rows.length > 1 ? `<td class="r num dim">${potDay > 0 && f.rewardUsdDay ? (f.rewardUsdDay / potDay * 100).toFixed(0) + '%' : '—'}</td>` : ''}
            <td class="r num ${ended ? '' : 'dim'}">${f.periodFinish ? (ended ? new Date(f.periodFinish).toISOString().slice(0, 10) : forHowLong(days(f.periodFinish))) : ended ? 'finished' : 'open'}</td>
            <td class="mono dim">${f.creator ? acctLink(f.creator) : '—'}</td>
          </tr>`;
        }).join('')}</tbody></table></div>
      ${rows.some(f => !f.rewardUsdDay) ? '<p class="sub" style="margin:9px 0 0">An unpriced reward is real but not counted in the totals above.</p>' : ''}
    </div>

    <div class="card" style="margin-bottom:14px"><h3>Is this rate normal?
      <span class="dim">&mdash; one point per daily snapshot</span></h3>
      <div id="farmHist"></div></div>

    <div class="card" style="margin-bottom:14px"><h3>Getting in</h3>
      <div id="farmMine"></div>
    </div>
    <div class="card"><h3>Open a position <span class="dim">&mdash; two ways in</span></h3>
      <div class="toolbar" style="margin:0 0 10px">
        <span class="sub">I have</span>
        <button class="chip" data-how="one" aria-pressed="true">One token</button>
        <button class="chip" data-how="both" aria-pressed="false">Both tokens</button>
        <span class="dim" id="howNote" style="font-size:12px"></span>
      </div>
      <div id="farmZap"></div>
      <div id="farmNewPos"></div>
    </div>`;

  fillMarks(out);

  // A rate on its own is a number; a rate against its own past is an answer.
  // "95% APR" reads very differently once you can see it was 95% all week, or
  // that it was 12% until this morning because someone pulled their stake out.
  // The daily job has been recording this per farm all along and nothing showed
  // it.
  loadHistory().then(hist => {
    const box = $('#farmHist');
    if (!box) return;
    const key = `${g.dex}:${g.poolId}`;
    const pts = [];
    for (const row of hist) {
      const f = (row.farms || []).find(x => x[0] === key);
      // aprReal is index 6, and a farm the job could not value that day has a
      // null there — a gap in the line, not a zero.
      if (f && f[6] != null) pts.push({ x: row.at, y: f[6] });
    }
    const days = new Set(pts.map(p2 => new Date(p2.x).toISOString().slice(0, 10))).size;
    if (days < 3) {
      box.innerHTML = `<div class="chart-empty">${days} day${days === 1 ? '' : 's'} recorded so far. This needs three.</div>`;
      return;
    }
    const per = new Map();
    for (const p2 of pts) per.set(new Date(p2.x).toISOString().slice(0, 10), p2);
    const series = [...per.values()];
    const vals = series.map(p2 => p2.y);
    const lo = Math.min(...vals), hi = Math.max(...vals), latest = vals[vals.length - 1];
    // The answer in a sentence, because a line that has not moved looks
    // identical to a chart that failed to draw.
    const swing = lo > 0 ? (hi - lo) / lo : 0;
    const verdict = swing < 0.1 ? 'steady all week'
      : latest >= hi * 0.98 ? 'at its highest this week'
      : latest <= lo * 1.02 ? 'at its lowest this week'
      : 'moving';
    box.innerHTML = `<p class="sub" style="margin:0 0 8px"><b>${pct(latest)}</b> today &middot;
      ${pct(lo)} to ${pct(hi)} over ${series.length} days &middot; <b>${verdict}</b></p><div id="farmHistChart"></div>`;
    const cbox = $('#farmHistChart');
    lineSeriesChart(cbox, series.map(p2 => ({ time: Math.floor(p2.x / 1000), value: p2.y })),
      { height: 150, color: 'var(--c3)', fmt: v => pct(v) })
      .catch(() => {
        cbox.innerHTML = '';
        // zeroBase off: this is a rate, and drawing it from zero flattens the
        // only thing the chart is for.
        cbox.appendChild(areaChart(series, { height: 150, color: 'var(--c3)', zeroBase: false, fmtY: pct, fmtX: t => new Date(t).toISOString().slice(5, 10), label: 'Farm APR over time' }));
      });
  }).catch(() => {});


  // Seeded with what is already in, so the first number on screen is about this
  // holder rather than a round figure nobody chose.
  groupStakedUsd(g).then(v => {
    if (!(v > 0)) return;
    farmStakedUsd = v;
    const el = $('#farmStaked'); if (el) el.textContent = usd(v);
  }).catch(() => {});

  // A zap belongs here: the pool and the incentives are already known, so the
  // only thing left to say is which token you hold and how much.
  if (g.dex === 'alcor' && p?.sqrtX64) {
    // Two ways in, one card. Selling half of what you brought and depositing
    // both sides are different trades with different risks, and which one
    // someone wants depends on what is already in their wallet — so it is a
    // choice rather than a decision the page makes for them.
    const incIds = live.map(f => f.id);
    const showHow = how => {
      out.querySelectorAll('[data-how]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.how === how)));
      const note = $('#howNote');
      if (note) note.textContent = how === 'one'
        ? 'sells part of it, deposits both sides, stakes it'
        : 'you supply both sides yourself, nothing is sold';
      $('#farmZap').hidden = how !== 'one';
      $('#farmNewPos').hidden = how !== 'both';
      if (how === 'both' && !$('#farmNewPos').dataset.built) {
        $('#farmNewPos').dataset.built = '1';
        renderNewPosition(wallet.account(), g.poolId, $('#farmNewPos'));
      }
    };
    out.querySelectorAll('[data-how]').forEach(b => b.onclick = () => showHow(b.dataset.how));
    renderZap($('#farmZap'), p, { incentiveIds: incIds, account: wallet.account(), embedded: true });
    showHow('one');
  }

  renderFarmMine(g).catch(() => {});
}

// Where you stand in this farm. Not a list of positions — a reading of them:
// what each one is earning here, what share of the pot it holds, what is
// waiting on it, and whether it is even in range to be earning at all.
async function renderFarmMine(g) {
  const box = $('#farmMine');
  const me = wallet.account();
  if (!me) {
    box.innerHTML = `<p class="sub" style="margin:0 0 10px">Connect a wallet to see your positions in this farm.</p>
      <a class="btn" href="${g.pool ? venueUrl[g.dex]?.(g.pool) || '#' : '#'}" target="_blank" rel="noopener">Add liquidity on ${g.dex === 'alcor' ? 'Alcor' : 'the venue'} &nearr;</a>`;
    return;
  }
  box.innerHTML = '<div class="loading"><span class="spinner"></span><span>Reading your positions…</span></div>';

  // On TacoSwap a stake is an LP token balance, not a position row — looking for
  // one in Alcor's index finds nothing and says you have no position, which is
  // wrong for everyone farming there.
  if (g.dex === 'taco') return renderTacoFarmMine(g, me, box);

  let mine = [];
  try {
    const all = await walletPositionsFast(me);
    mine = all.filter(x => String(x.pool.id) === String(g.poolId) && x.pool.dex === g.dex);
  } catch {}

  if (!mine.length) {
    box.innerHTML = `<p class="sub" style="margin:0 0 10px">No position in this pool.</p>
      <div class="toolbar" style="margin:0">
        <button class="btn" id="farmOpen">Open one by hand</button>
        <a class="plink" href="${g.pool ? venueUrl[g.dex]?.(g.pool) || '#' : '#'}" target="_blank" rel="noopener">Pool &nearr;</a>
      </div>`;
    $('#farmOpen').onclick = () => renderNewPosition(me, g.poolId, $('#farmNewPos'));
    return;
  }

  const now = Date.now();
  const isLive = f => (f.periodFinish ? f.periodFinish > now : !f.ended);
  const liveIds = new Set(g.farms.filter(isLive).map(f => String(f.id)));
  const liveDay = g.farms.filter(isLive).reduce((a, f) => a + (f.rewardUsdDay || 0), 0);
  // Computed on demand, because the group only carries it when the farms list
  // happened to ask first — and a zero denominator turned every share into 0%
  // and the total into Infinity%.
  let staked = 0;
  try { staked = (await groupStakedUsd(g)) || 0; } catch {}
  if (!(staked > 0)) staked = g.stakedReal ?? g.stakedUsd ?? 0;

  const joined = await stakedIncentives(mine.map(x => x.posId)).catch(() => new Map());
  const pend = await pendingFarms(mine, joined, { prices: state.prices }).catch(() => []);

  const pendPos = new Map();
  for (const r of pend) {
    if (r.price == null) continue;
    pendPos.set(r.posId, (pendPos.get(r.posId) || 0) + pendingAt(r, now) * r.price);
  }

  // What you are owed, by token. A converted total answers "is this worth a
  // transaction"; it does not answer "what am I actually being paid", and on a
  // farm paying a token no price feed carries it answers nothing at all — those
  // rewards are real and were previously invisible, because the money total
  // skips anything unpriced.
  const pendTok = new Map();
  for (const r of pend) {
    const t = pendTok.get(r.tokenId) || { symbol: r.symbol, amount: 0, priced: r.price != null };
    t.amount += pendingAt(r, now);
    pendTok.set(r.tokenId, t);
  }
  const pendList = [...pendTok.values()].filter(t => t.amount > 0).sort((a, b) => b.amount - a.amount);

  // Only a position that is staked AND in range is actually earning here.
  const rows = mine.map(x => {
    const ids = (joined.get(String(x.posId)) || []).filter(id => liveIds.has(id));
    const missing = [...liveIds].filter(id => !(joined.get(String(x.posId)) || []).includes(id));
    const share = staked > 0 && ids.length ? Math.min(1, x.valueUsd / staked) : 0;
    return { x, ids, missing, share, perDay: liveDay * share, pending: pendPos.get(String(x.posId)) || 0 };
  });
  const totalIn = rows.filter(r => r.ids.length).reduce((a, r) => a + r.x.valueUsd, 0);
  const totalDay = rows.reduce((a, r) => a + r.perDay, 0);
  const totalPend = rows.reduce((a, r) => a + r.pending, 0);
  const idle = rows.filter(r => r.ids.length && !r.x.inRange).reduce((a, r) => a + r.x.valueUsd, 0);
  const unstaked = rows.filter(r => r.missing.length).reduce((a, r) => a + r.x.valueUsd, 0);

  box.innerHTML = `
    <div class="stats" style="margin-bottom:12px">
      <div class="stat"><span class="v">${usd(totalIn)}</span><span class="k">your stake here</span><span class="sub">${staked > 0 ? Math.min(100, totalIn / staked * 100).toFixed(totalIn / staked >= 0.1 ? 1 : 2) + '% of the farm' : 'the farm reports nothing staked'}</span></div>
      <div class="stat"><span class="v">${usd(totalDay)}</span><span class="k">the farm pays you a day</span><span class="sub">${usd(totalDay * 30)} a month &middot; trading fees are on top</span></div>
      <div class="stat"><span class="v">${pendList.length && !pendList.some(t => t.priced) ? `${qtyFine(pendList[0].amount)} ${esc(pendList[0].symbol)}` : usd4(totalPend)}</span><span class="k">waiting to claim</span><span class="sub">${
        pendList.length ? pendList.map(t => `${qtyFine(t.amount)} ${esc(t.symbol)}${t.priced ? '' : ' <span class="dim">unpriced</span>'}`).join(' &middot; ') : 'from this farm'
      }</span></div>
      ${unstaked > 0 ? `<div class="stat"><span class="v neg">${usd(unstaked)}</span><span class="k">not staked</span><span class="sub">earning fees only</span></div>` : ''}
      ${idle > 0 ? `<div class="stat"><span class="v neg">${usd(idle)}</span><span class="k">staked but out of range</span><span class="sub">earns nothing until the price returns</span></div>` : ''}
    </div>

    <div class="tablewrap" style="border:0"><table style="font-size:12.5px">
      <thead><tr><th>Position</th><th class="r">Value</th><th class="r">Share here</th><th class="r">A day</th><th class="r">Waiting</th><th>State</th><th></th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="mono">${poolLink(g.dex, g.poolId, '#' + r.x.posId)}</td>
        <td class="r num">${usd(r.x.valueUsd)}</td>
        <td class="r num ${r.share > 0 ? '' : 'dim'}">${r.share > 0 ? (r.share * 100).toFixed(r.share >= 0.1 ? 1 : 2) + '%' : '—'}</td>
        <td class="r num ${r.perDay > 0 ? '' : 'dim'}">${r.perDay > 0 ? usd(r.perDay) : '—'}</td>
        <td class="r num ${r.pending > 0 ? '' : 'dim'}">${r.pending > 0 ? usd4(r.pending) : '—'}</td>
        <td>${!r.ids.length ? '<span class="pill warn">not staked</span>'
            : !r.x.inRange ? '<span class="pill bad">out of range</span>'
            : `<span class="pill good">earning</span>`}${r.ids.length && r.ids.length < liveIds.size ? ` <span class="src farm">${r.ids.length} of ${liveIds.size}</span>` : ''}</td>
        <td class="r">${r.missing.length ? `<button class="btn" data-joinfarm="${r.x.posId}" data-inc="${r.missing.map(esc).join(',')}">Join</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`;
  wireJoinFarm(box, me);
  return totalIn;
}

// A TacoSwap position is a share of the pair, held as a token. There is no
// staking step and no range to fall out of: hold the LP token and you earn.
async function renderTacoFarmMine(g, me, box) {
  let lp = null;
  try {
    const res = await walletPositions(me, { skipAlcor: true });
    lp = res.taco.find(x => String(x.pool.id) === String(g.poolId)) || null;
  } catch {}

  if (!lp) {
    box.innerHTML = `<p class="sub" style="margin:0 0 10px">You hold no ${esc(g.poolId)} LP, so you are not in this farm.</p>
      <a class="btn" href="${venueUrl.taco()}" target="_blank" rel="noopener">Add liquidity on TacoSwap &nearr;</a>`;
    return 0;
  }

  const now = Date.now();
  const isLive = f => (f.periodFinish ? f.periodFinish > now : !f.ended);
  const liveDay = g.farms.filter(isLive).reduce((a, f) => a + (f.rewardUsdDay || 0), 0);
  const staked = g.stakedReal ?? g.stakedUsd ?? 0;
  const share = staked > 0 ? Math.min(1, lp.valueUsd / staked) : 0;

  box.innerHTML = `<div class="stats" style="margin-bottom:12px">
      <div class="stat"><span class="v">${usd(lp.valueUsd)}</span><span class="k">your LP here</span><span class="sub">${qty(lp.balance)} ${esc(g.poolId)}</span></div>
      <div class="stat"><span class="v">${share > 0 ? (share * 100).toFixed(share >= 0.1 ? 1 : 2) + '%' : '—'}</span><span class="k">share of the farm</span></div>
      <div class="stat"><span class="v">${usd(liveDay * share)}</span><span class="k">the farm pays you a day</span><span class="sub">${usd(liveDay * share * 30)} a month &middot; trading fees are on top</span></div>
    </div>
    <p class="sub" style="margin:0">Holding the LP token is the stake.</p>`;
  return lp.valueUsd;
}

// ---------------------------------------------------------- POOL DETAIL -----
async function openPool(key) {
  const [dex, id] = key.split(':');
  const p = state.pools.find(x => x.dex === dex && x.id === id);
  if (!p) return;
  show('pool', key);
  const farms = state.farms.filter(f => f.poolDex === dex && f.poolId === id && !f.ended);

  $('#poolDetail').innerHTML = `
    <h2 class="vt">${pairLinks(p)} <span class="badge ${p.dex}">${p.dex}</span> <span class="dim" style="font-weight:400">#${esc(p.id)}</span></h2>
    <p class="vs">${(p.feeBps / 100).toFixed(2)}% fee tier on ${p.dex === 'alcor' ? 'Alcor' : p.dex === 'taco' ? 'TacoSwap' : p.dex === 'defibox' ? 'Defibox' : 'A-DEX'}${p.bornAt ? ` &middot; first seen ${age(p.bornAt)} ago` : ''}</p>
    <div class="toolbar" style="margin-bottom:16px">
      <span id="poolStar"></span>
      <a class="btn" href="${swapUrl(p)}" target="_blank" rel="noopener">Trade this pair &nearr;</a>
      <button class="btn" id="poolAddLiq">Add liquidity</button>
      <a class="btn ghost" href="${venueUrl[p.dex]?.(p) || '#'}" target="_blank" rel="noopener">Open the pool &nearr;</a>
    </div>
    <div class="stats">
      <div class="stat"><span class="v">${usd(p.tvlReal)}</span><span class="k">exit value</span><span class="sub">${p.tvl > (p.tvlReal || 0) * 1.05 ? usd(p.tvl) + ' at face value' : 'fully backed'}</span></div>
      <div class="stat"><span class="v">${p.vol24 > 0 ? usd(p.vol24) : '—'}</span><span class="k">volume 24h</span>${p.turnover > 0 ? `<span class="sub">${p.turnover.toFixed(2)}× its own liquidity</span>` : ''}</div>
      <div class="stat"><span class="v">${p.depth1 > 0 ? usd(p.depth1) : '—'}</span><span class="k">trade depth</span><span class="sub">before moving price 1%</span></div>
      <div class="stat"><span class="v">${qty(p.priceAB)}</span><span class="k">${tokLink(p.tokenB, p.symB)} per ${tokLink(p.tokenA, p.symA)}</span></div>
      <div class="stat"><span class="v">${qty(p.reserveA)}</span><span class="k">${tokLink(p.tokenA, p.symA)} in pool</span><span class="sub">${usd(p.priceUsdA ? p.reserveA * p.priceUsdA : null)}</span></div>
      <div class="stat"><span class="v">${qty(p.reserveB)}</span><span class="k">${tokLink(p.tokenB, p.symB)} in pool</span><span class="sub">${usd(p.priceUsdB ? p.reserveB * p.priceUsdB : null)}</span></div>
      <div class="stat"><span class="v">${farms.length}</span><span class="k">live farms</span></div>
      ${p.dex === 'taco' && p.lpSupply > 0 ? '<div class="stat" id="poolLock" hidden></div>' : ''}
    </div>
    <div class="grid g2">
      <div class="card"><h3><span id="poolPair">Price</span> <span class="dim">— candles built from pool state changes</span>
        <span style="margin-left:auto;display:flex;gap:4px">
          <button class="chip" id="poolFlip" title="Show the price the other way round">&#8646;</button>
          ${intervalChips('poolPrice')}
        </span></h3><div id="poolChart"><div class="loading"><span class="spinner"></span><span>Reading state changes…</span></div></div></div>
      <div class="card"><h3>Recent swaps here</h3><div id="poolSwaps"><div class="loading"><span class="spinner"></span><span>Reading feed…</span></div></div></div>
    </div>
    ${p.dex === 'alcor' ? `<div class="card" style="margin-top:12px"><h3>Where the liquidity sits
      <span class="dim">&mdash; ${esc(p.symB)} per ${esc(p.symA)}</span></h3>
      <div id="poolDepth"><div class="loading"><span class="spinner"></span><span>Reading ticks…</span></div></div>
      <p class="sub" id="poolDepthNote" style="margin:8px 0 0">&nbsp;</p></div>` : ''}
    ${p.dex === 'alcor' ? `<div class="card" style="margin-top:12px"><h3>Who provides the liquidity here</h3>
      <div id="poolLPs"><div class="loading"><span class="spinner"></span><span>Reading positions…</span></div></div></div>` : ''}
    <div id="farmParts" style="margin-top:12px"></div>
    ${promoteBox('p', key, `${p.symA}/${p.symB}`)}`;

  // Where the money sits across price. One ticks read for the pool you opened,
  // which is a detail page and can afford it. The reconstruction is checked in
  // math.js against the pool's own reserves: it lands within about 2%, and that
  // 2% is the protocol fee plus uncollected LP fees, which sit in the pool and
  // belong to no position.
  if (p.dex === 'alcor') {
    (async () => {
      const box = $('#poolDepth');
      if (!box) return;
      try {
        const rows = await getAllRows('swap.alcor', String(p.id), 'ticks');
        const bands = bandValues(liquidityBands(rows), p);
        const price = p.priceAB;
        box.innerHTML = '';
        box.appendChild(depthChart(bands, {
          price, fmt: usd,
          fmtPrice: v => sigfig(v),
        }));
        const near = bands.filter(b => b.priceLower < price * 1.1 && b.priceUpper > price * 0.9);
        const nearUsd = near.reduce((a2, b) => a2 + b.usd, 0);
        const all = bands.reduce((a2, b) => a2 + b.usd, 0);
        const note = $('#poolDepthNote');
        if (note) note.innerHTML = all > 0
          ? `${usd(nearUsd)} of ${usd(all)} sits within 10% of the price &mdash; <b>${(nearUsd / all * 100).toFixed(0)}%</b>.
             <span class="dim">Left of the line is what buys ${esc(p.symA)}; right of it is ${esc(p.symA)} waiting to be sold.</span>`
          : '&nbsp;';
      } catch (e) {
        box.innerHTML = `<div class="chart-empty">Could not read this pool's ticks.</div>`;
      }
    })();
  }

  // "Is the liquidity locked?" is the first question anyone asks about a new
  // token, and on Taco it has an exact answer: the pair id is the LP token
  // symbol, so the locked balance over the LP supply is the share of this pool
  // nobody can withdraw yet. A lock whose date has passed is the opposite
  // signal and says so.
  if (p.dex === 'taco' && p.lpSupply > 0) {
    lockedSupply().then(m => {
      const lk = m.get(`${p.id}@swap.taco`);
      const el = $('#poolLock');
      if (!el || !lk || !(lk.locked > 0)) return;
      const held = Math.max(0, lk.locked - lk.claimable);
      const pctHeld = held / p.lpSupply * 100;
      const day = lk.nextUnlock ? new Date(lk.nextUnlock * 1000).toISOString().slice(0, 10) : null;
      el.hidden = false;
      el.innerHTML = held > 0
        ? `<span class="v ${pctHeld >= 50 ? 'pos' : ''}">${pctHeld.toFixed(pctHeld >= 10 ? 0 : 1)}%</span><span class="k">liquidity locked</span>`
          + `<span class="sub">${day ? `until ${day}` : 'no date'}${lk.claimable > 0 ? ` &middot; ${(lk.claimable / p.lpSupply * 100).toFixed(1)}% already withdrawable` : ''}</span>`
        : `<span class="v neg">expired</span><span class="k">liquidity lock</span><span class="sub">${(lk.claimable / p.lpSupply * 100).toFixed(1)}% can be withdrawn now</span>`;
    }).catch(() => {});
  }

  // The whole point of the page is that you can act on it. A button that sends
  // someone to another site, or another page, is a step at which most people
  // stop.
  const add = $('#poolAddLiq');
  if (add) add.onclick = () => {
    const target = $('#farmZap') || $('#farmParts');
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    $('#zapAmt')?.focus();
  };

  // The farm half of this market, if it has one. Same page, no second trip.
  renderFarmParts(seedApr(farmGroups()).find(x => x.key === key), $('#farmParts')).catch(() => {});

  wirePromote($('#poolDetail'));
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
        <p class="sub" style="margin:9px 0 0">${sw.length.toLocaleString()} trades, back to ${ago(new Date(sw.at(-1).ts).toISOString())}. Traders are on the token page.</p>`;
    }).catch(e => { $('#poolSwaps').innerHTML = `<div class="empty">Feed unavailable: ${esc(e.message)}</div>`; });
  }

  // The rung that was missing from the chain: a pool knew its tokens and its
  // farms, and said nothing about the people whose money is in it.
  if (p.dex === 'alcor' && $('#poolLPs')) renderPoolLPs(p).catch(() => {});
}

async function renderPoolLPs(p) {
  const box = $('#poolLPs');
  let rows;
  try { rows = await getAllRows('swap.alcor', p.id, 'positions'); }
  catch { box.innerHTML = '<div class="empty">Could not read the positions table.</div>'; return; }

  const sqrtP = p.sqrtX64 ? sqrtPriceFromX64(p.sqrtX64) : null;
  if (!sqrtP) { box.innerHTML = ''; return; }
  const by = new Map();
  let total = 0;
  for (const r of rows) {
    if (!(Number(r.liquidity) > 0)) continue;
    const { amountA, amountB } = amountsForLiquidity(r.liquidity, sqrtP, r.tickLower, r.tickUpper);
    const v = (amountA / 10 ** p.decA) * (p.priceUsdA || 0) + (amountB / 10 ** p.decB) * (p.priceUsdB || 0);
    const inRange = p.tick > r.tickLower && p.tick < r.tickUpper;
    const cur = by.get(r.owner) || { account: r.owner, usd: 0, n: 0, live: 0 };
    cur.usd += v; cur.n++; if (inRange) cur.live++;
    by.set(r.owner, cur);
    total += v;
  }
  const list = [...by.values()].sort((a, b) => b.usd - a.usd);
  if (!list.length) { box.innerHTML = '<div class="empty">Nobody holds liquidity in this pool right now.</div>'; return; }

  box.innerHTML = `<div class="tablewrap" style="max-height:340px;border:0"><table style="font-size:12.5px">
    <thead><tr><th></th><th>Wallet</th><th class="r">Value</th><th class="r">Share</th><th class="r">Positions</th><th class="r">In range</th></tr></thead>
    <tbody>${list.slice(0, 30).map((x, i) => `<tr>
      <td class="rank">${i + 1}</td>
      <td class="mono">${acctLink(x.account)}</td>
      <td class="r num">${usd(x.usd)}</td>
      <td class="r num dim">${total > 0 ? (x.usd / total * 100).toFixed(1) + '%' : '—'}</td>
      <td class="r num dim">${x.n}</td>
      <td class="r num ${x.live ? '' : 'dim'}">${x.live} of ${x.n}</td>
    </tr>`).join('')}</tbody></table></div>
    <p class="sub" style="margin:9px 0 0">${list.length} wallet${list.length === 1 ? '' : 's'}, ${usd(total)} at face value.</p>`;
}

document.addEventListener('DOMContentLoaded', () => {
  boot();
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-view]');
    if (b?.dataset.view === 'activity' && !activityLoaded) renderActivity();
  });
});
