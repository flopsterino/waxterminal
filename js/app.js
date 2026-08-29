// =============================================================================
// APP — views and wiring. All data comes from store.js, which reads the chain
// directly; there is no server anywhere in this application.
// =============================================================================

import { loadCore, state, walletPositions, recentSwaps, poolHistory, clearCache, farmGroups, groupStakedUsd } from './store.js';
import { harvestFor, planCompound } from './compound.js';
import { lineChart, donut, bars, rangeBar } from './charts.js';
import { sqrtPriceFromX64 } from './math.js';

// ------------------------------------------------------------ formatting ----
const nf = (v, d = 2) => (v == null || !isFinite(v)) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
function usd(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k';
  if (a >= 0.995) return '$' + v.toFixed(2);
  if (a > 0)    return '$' + v.toPrecision(2);
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
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pairName = p => `${esc(p.symA)}/${esc(p.symB)}`;
const $ = s => document.querySelector(s);

let CFG = null;

// ----------------------------------------------------------------- boot -----
async function boot() {
  try {
    CFG = await (await fetch('theme.json')).json();
    $('#brandName').textContent = CFG.identity?.name ?? 'WAX Terminal';
    if (CFG.identity?.favicon) $('#brandMark').textContent = CFG.identity.favicon;
    document.title = CFG.identity?.name ?? 'WAX Terminal';
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
  });
  $('#refreshBtn').onclick = async () => { await clearCache(); location.reload(); };
  $('#poolBack').onclick = () => show(lastView || 'pools');

  banner('<div class="loading"><span class="spinner"></span><span id="loadmsg">Reading Alcor and TacoSwap from chain…</span></div>');
  try {
    await loadCore({ onProgress: p => {
      const m = $('#loadmsg');
      if (!m) return;
      if (p.phase === 'snapshot') {
        // Paint the snapshot straight away so the terminal is usable while the
        // live read finishes behind it.
        m.textContent = `Showing a snapshot from ${ago(new Date(p.at).toISOString())} while reading live state…`;
        renderPools(); renderFarms();
      } else if (p.msg) m.textContent = p.msg;
    } });
  } catch (e) {
    // A failed live read is not the same as having nothing to show. If the
    // published snapshot loaded, the terminal is still usable and should say
    // what it is showing rather than just complain.
    if (state.pools.length) {
      banner(`<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">
        <b>Showing the published snapshot from ${ago(new Date(state.loadedAt).toISOString())}.</b>
        Live chain read failed (${esc(e.message)}) — public nodes rate-limit. Prices and TVL are as of the snapshot;
        wallet lookups and the activity feed need the chain and will not work until it is reachable.</div>`);
    } else {
      banner(`<div class="err"><b>Could not reach the chain.</b> ${esc(e.message)} — public nodes rate-limit; try reloading in a moment.</div>`);
      return;
    }
  }
  if (!state.fromSnapshot) banner('');

  if (state.waxUsd) $('#waxPrice').innerHTML = `WAX <b>$${state.waxUsd.toFixed(5)}</b>`;
  const alive = state.hosts.filter(h => h.ok);
  const dead = state.hosts.length - alive.length;
  $('#freshness').innerHTML = `${state.pools.length.toLocaleString()} pools &middot; ${state.farms.length.toLocaleString()} farms`
    + ` &middot; <span title="${state.hosts.map(h => `${h.host.replace('https://', '')} ${h.ok ? h.ms + 'ms' : 'not responding'}`).join('\n')}">${alive.length}/${state.hosts.length} nodes${dead ? `, ${dead} down` : ''}</span>`;
  if (state.shardsFailed) {
    banner(`<div class="err">Part of the chain read did not come back (${state.shardsFailed} shard${state.shardsFailed === 1 ? '' : 's'}), so some pools are missing. Everything shown is real; the list is just incomplete. Reload to try again.</div>`);
  }

  wirePools(); wireFarms(); wireWallet(); wireActivity(); wireCompound();
  renderPools(); renderFarms();
  if (!routeFromHash()) show(CFG.content?.defaultView || 'pools');
  window.addEventListener('hashchange', routeFromHash);

  if (state.stale) loadCore({ force: true }).then(() => { renderPools(); renderFarms(); });
}

const banner = html => { $('#banner').innerHTML = html; };
let lastView = 'pools';
function show(v, arg = null) {
  if (v !== 'pool') lastView = v;
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
  if (view === 'wallet' && arg) {
    const acct = decodeURIComponent(arg);
    show('wallet'); $('#walletInput').value = acct; lookupWallet(acct); return true;
  }
  if (view === 'compound' && arg) { const a = decodeURIComponent(arg); show('compound'); $('#compInput').value = a; runCompound(a); return true; }
  if (['pools', 'farms', 'wallet', 'activity', 'compound'].includes(view)) {
    show(view);
    if (view === 'activity' && !activityLoaded) renderActivity();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- POOLS -----
const poolFilters = { q: '', dex: 'all', hideDust: true, hideThin: false, sort: 'tvl', dir: -1 };

function wirePools() {
  $('#poolSearch').oninput = e => { poolFilters.q = e.target.value.trim().toLowerCase(); renderPools(); };
  const setDex = d => { poolFilters.dex = d; ['All', 'Alcor', 'Taco'].forEach(n => $(`#fDex${n}`).setAttribute('aria-pressed', String(d === n.toLowerCase() || (d === 'all' && n === 'All')))); renderPools(); };
  $('#fDexAll').onclick = () => setDex('all');
  $('#fDexAlcor').onclick = () => setDex('alcor');
  $('#fDexTaco').onclick = () => setDex('taco');
  $('#fLiq').onclick = e => { poolFilters.hideDust = !poolFilters.hideDust; e.target.setAttribute('aria-pressed', String(poolFilters.hideDust)); renderPools(); };
  $('#fThin').onclick = e => { poolFilters.hideThin = !poolFilters.hideThin; e.target.setAttribute('aria-pressed', String(poolFilters.hideThin)); renderPools(); };
}

function filteredPools() {
  const min = CFG?.content?.minTvlUsd ?? 100;
  return state.pools.filter(p => {
    if (poolFilters.dex !== 'all' && p.dex !== poolFilters.dex) return false;
    if (poolFilters.hideDust && !(p.tvl >= min)) return false;
    if (poolFilters.hideThin && p.thin) return false;
    if (poolFilters.q) {
      const s = `${p.symA}/${p.symB} ${p.id}`.toLowerCase();
      if (!s.includes(poolFilters.q)) return false;
    }
    return true;
  });
}

const POOL_COLS = [
  { k: 'pair', label: 'Pair', sortable: false },
  { k: 'dex', label: 'DEX', sortable: false },
  { k: 'tvl', label: 'TVL', r: true, sortable: true },
  { k: 'price', label: 'Price', r: true, sortable: false },
  { k: 'feeBps', label: 'Fee', r: true, sortable: true },
  { k: 'reserveA', label: 'Reserves', r: true, sortable: false },
];

function renderPools() {
  const rows = filteredPools();
  rows.sort((a, b) => {
    const k = poolFilters.sort;
    return ((a[k] ?? -Infinity) - (b[k] ?? -Infinity)) * poolFilters.dir;
  });

  const total = rows.reduce((s, p) => s + (p.tvl || 0), 0);
  const thinTvl = rows.filter(p => p.thin).reduce((s, p) => s + (p.tvl || 0), 0);
  const alcor = state.pools.filter(p => p.dex === 'alcor').length;
  const taco = state.pools.filter(p => p.dex === 'taco').length;
  const priced = [...state.prices.values()].length;
  $('#poolStats').innerHTML = `
    <div class="stat"><span class="v">${usd(total)}</span><span class="k">TVL shown</span>${thinTvl > 0 ? `<span class="sub">${usd(thinTvl)} of it thinly routed</span>` : ''}</div>
    <div class="stat"><span class="v">${alcor.toLocaleString()}</span><span class="k">Alcor pools</span></div>
    <div class="stat"><span class="v">${taco.toLocaleString()}</span><span class="k">TacoSwap pairs</span></div>
    <div class="stat"><span class="v">${priced.toLocaleString()}</span><span class="k">priced tokens</span><span class="sub">of ${state.tokens.size.toLocaleString()} seen</span></div>
    <div class="stat"><span class="v">$${state.waxUsd ? state.waxUsd.toFixed(5) : '—'}</span><span class="k">WAX</span><span class="sub">deepest stable route</span></div>`;

  const partial = rows.filter(p => p.tvlPartial).length;
  $('#poolCount').innerHTML = `${rows.length.toLocaleString()} shown` +
    (partial ? ` &middot; <span title="Marked * — only one side could be priced">${partial} partly priced</span>` : '');

  const thead = $('#poolTable thead');
  thead.innerHTML = '<tr>' + POOL_COLS.map(c =>
    `<th class="${c.r ? 'r ' : ''}${c.sortable ? 'sortable' : ''}" data-k="${c.k}">${c.label}${poolFilters.sort === c.k ? ` <span class="dir">${poolFilters.dir < 0 ? '▾' : '▴'}</span>` : ''}</th>`).join('') + '</tr>';
  thead.querySelectorAll('th.sortable').forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    if (poolFilters.sort === k) poolFilters.dir *= -1; else { poolFilters.sort = k; poolFilters.dir = -1; }
    renderPools();
  });

  const body = rows.slice(0, 400).map(p => `
    <tr class="clickable" data-pool="${p.dex}:${esc(p.id)}">
      <td><span class="pair">${pairName(p)}</span> <span class="sub">#${esc(p.id)}</span></td>
      <td><span class="badge ${p.dex}">${p.dex}</span></td>
      <td class="r num">${usd(p.tvl)}${p.tvlPartial ? '<span class="dim" title="Only one side of this pool could be priced, so this counts just that leg — the rest is not guessed at">*</span>' : ''}${p.thin ? `<span class="badge warn" style="margin-left:6px" title="The price behind this TVL routes to a real dollar through only ${usd(p.routeDepth)} of liquidity. The price is right; the value is not realisable at this size.">thin</span>` : ''}</td>
      <td class="r num">${p.priceAB != null ? qty(p.priceAB) : '—'} <span class="sub">${esc(p.symB)}</span></td>
      <td class="r num">${(p.feeBps / 100).toFixed(2)}%</td>
      <td class="r num dim">${qty(p.reserveA)} ${esc(p.symA)} <span style="opacity:.55">/</span> ${qty(p.reserveB)} ${esc(p.symB)}</td>
    </tr>`).join('');
  $('#poolTable tbody').innerHTML = body || '<tr><td colspan="6" class="empty">No pools match.</td></tr>';
  $('#poolTable tbody').querySelectorAll('tr[data-pool]').forEach(tr => tr.onclick = () => openPool(tr.dataset.pool));
}

// ---------------------------------------------------------------- FARMS -----
// Rows are POOLS, not incentives: 633 of 1,883 farmed pools run several
// incentives at once and a user experiences that as one farm paying several
// tokens. Listing raw incentives would show the same pool ten times.
const farmFilters = { q: '', alcor: true, taco: true, sort: 'rewardUsdDay', dir: -1 };
let groups = [];

function wireFarms() {
  $('#farmSearch').oninput = e => { farmFilters.q = e.target.value.trim().toLowerCase(); renderFarms(); };
  const tog = (key, id) => $(id).onclick = e => { farmFilters[key] = !farmFilters[key]; e.target.setAttribute('aria-pressed', String(farmFilters[key])); renderFarms(); };
  tog('alcor', '#fFarmAlcor'); tog('taco', '#fFarmTaco');
  $('#fLive').style.display = 'none';                 // groups are live-only by construction
  $('#calcApr').onclick = computeVisibleApr;
}

function filteredGroups() {
  return groups.filter(g => {
    if (!farmFilters.alcor && g.dex === 'alcor') return false;
    if (!farmFilters.taco && g.dex === 'taco') return false;
    if (farmFilters.q) {
      const s = `${g.pool ? g.pool.symA + '/' + g.pool.symB : g.poolId} ${g.rewards.map(r => r.symbol).join(' ')} ${g.poolId}`.toLowerCase();
      if (!s.includes(farmFilters.q)) return false;
    }
    return true;
  });
}

function renderFarms() {
  if (!groups.length || groups._at !== state.loadedAt) { groups = farmGroups(); groups._at = state.loadedAt; }
  const rows = filteredGroups();
  rows.sort((a, b) => ((a[farmFilters.sort] ?? -Infinity) - (b[farmFilters.sort] ?? -Infinity)) * farmFilters.dir);

  const payUsd = groups.reduce((s, g) => s + g.rewardUsdDay, 0);
  const multi = groups.filter(g => g.tokenCount > 1).length;
  const unpriceable = groups.filter(g => g.aprStatus === 'unpriceable').length;
  $('#farmStats').innerHTML = `
    <div class="stat"><span class="v">${groups.length.toLocaleString()}</span><span class="k">farmed pools</span><span class="sub">${state.farms.filter(f => !f.ended).length.toLocaleString()} incentives</span></div>
    <div class="stat"><span class="v">${usd(payUsd)}</span><span class="k">rewards / day</span><span class="sub">priced portion only</span></div>
    <div class="stat"><span class="v">${multi.toLocaleString()}</span><span class="k">pay several tokens</span><span class="sub">up to ${Math.max(...groups.map(g => g.tokenCount), 0)} at once</span></div>
    <div class="stat"><span class="v">${groups.filter(g => g.dex === 'alcor').length.toLocaleString()}</span><span class="k">on Alcor</span></div>
    <div class="stat"><span class="v">${unpriceable.toLocaleString()}</span><span class="k">unpriceable</span><span class="sub">reward token too thin</span></div>`;
  $('#farmCount').textContent = `${rows.length.toLocaleString()} shown`;

  const cols = [
    { k: 'pool', label: 'Pool', s: false },
    { k: 'dex', label: 'DEX', s: false },
    { k: 'rewards', label: 'Pays', s: false },
    { k: 'rewardUsdDay', label: 'Rewards / day', r: true, s: true },
    { k: 'stakedUsd', label: 'Staked', r: true, s: true },
    { k: 'apr', label: 'APR', r: true, s: true },
    { k: 'endsAt', label: 'First ends', r: true, s: true },
  ];
  const thead = $('#farmTable thead');
  thead.innerHTML = '<tr>' + cols.map(c => `<th class="${c.r ? 'r ' : ''}${c.s ? 'sortable' : ''}" data-k="${c.k}">${c.label}${farmFilters.sort === c.k ? ` <span class="dir">${farmFilters.dir < 0 ? '▾' : '▴'}</span>` : ''}</th>`).join('') + '</tr>';
  thead.querySelectorAll('th.sortable').forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    if (farmFilters.sort === k) farmFilters.dir *= -1; else { farmFilters.sort = k; farmFilters.dir = -1; }
    renderFarms();
  });

  $('#farmTable tbody').innerHTML = rows.slice(0, 250).map(g => {
    const pool = g.pool ? `${pairName(g.pool)} <span class="sub">#${esc(g.poolId)}</span>` : `<span class="dim">${esc(g.poolId)}</span>`;
    const seen = new Map();
    for (const r of g.rewards) seen.set(r.symbol, (seen.get(r.symbol) || 0) + (r.usdDay || 0));
    const chips = [...seen.keys()].slice(0, 5).map(sym => `<span class="badge">${esc(sym)}</span>`).join(' ')
      + (seen.size > 5 ? ` <span class="dim">+${seen.size - 5}</span>` : '');
    let aprCell;
    if (g.apr != null) {
      // True, but a 1,600% APR on $65 staked says more about the denominator than
      // the farm: any real deposit collapses it. Show it, but do not dress it up.
      const solid = g.stakedUsd >= 250;
      aprCell = `<span class="${solid ? 'pos' : 'dim'} num" ${solid ? '' : 'title="Computed on a very small staked base — depositing any real size collapses this number"'}>${pct(g.apr)}${solid ? '' : ' <span style="font-size:10px">on a tiny base</span>'}</span>`;
    }
    else if (g.aprStatus === 'unpriceable') aprCell = `<span class="badge warn" title="No pool deep enough to price the reward tokens">unpriceable</span>`;
    else if (g.aprStatus === 'no_stake') aprCell = `<span class="dim">nobody staked</span>`;
    else if (g.aprStatus === 'thin') aprCell = `<span class="dim" title="Staked value below $25 — an APR here is arithmetic noise">too thin</span>`;
    else aprCell = `<span class="dim">compute →</span>`;
    return `<tr class="clickable" data-pool="${g.dex}:${esc(g.poolId)}">
      <td>${pool}</td>
      <td><span class="badge ${g.dex}">${g.dex}</span></td>
      <td>${chips}${g.tokenCount > 1 ? ` <span class="sub">${g.tokenCount} tokens</span>` : ''}</td>
      <td class="r num">${usd(g.rewardUsdDay)}${g.anyUnpriceable ? ' <span class="dim" title="Some reward tokens could not be priced">+?</span>' : ''}</td>
      <td class="r num">${g.stakedUsd != null ? usd(g.stakedUsd) : '<span class="dim">—</span>'}</td>
      <td class="r">${aprCell}</td>
      <td class="r num dim">${g.endsAt ? new Date(g.endsAt).toISOString().slice(0, 10) : '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">No farms match.</td></tr>';
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
  $('#walletGo').onclick = () => lookupWallet($('#walletInput').value.trim());
  $('#walletInput').onkeydown = e => { if (e.key === 'Enter') lookupWallet(e.target.value.trim()); };
  $('#walletDemo').onclick = () => { $('#walletInput').value = 'maestrobeatz'; lookupWallet('maestrobeatz'); };
}

async function lookupWallet(account) {
  if (!account) return;
  const out = $('#walletOut');
  out.innerHTML = '<div class="loading"><span class="spinner"></span><span id="wmsg">Looking up…</span></div>';
  let res;
  try { res = await walletPositions(account, { onProgress: p => { const m = $('#wmsg'); if (m) m.textContent = p.msg; } }); }
  catch (e) { out.innerHTML = `<div class="err">Lookup failed: ${esc(e.message)}</div>`; return; }

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

  let html = `<div class="stats">
    <div class="stat"><span class="v">${usd(totalUsd)}</span><span class="k">liquidity value</span></div>
    <div class="stat"><span class="v">${all.length}</span><span class="k">positions</span><span class="sub">${res.alcor.length} Alcor &middot; ${res.taco.length} Taco</span></div>
    <div class="stat"><span class="v">${usd(feesUsd)}</span><span class="k">uncollected fees</span></div>
    <div class="stat"><span class="v ${outOfRange.length ? 'neg' : 'pos'}">${outOfRange.length}</span><span class="k">out of range</span><span class="sub">${usd(oorUsd)} idle</span></div>
  </div>`;

  if (outOfRange.length) {
    html += `<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">
      <b>${outOfRange.length} position${outOfRange.length === 1 ? ' is' : 's are'} out of range</b> — ${usd(oorUsd)} is sitting in pools earning no fees and no farm rewards.
      This is the number a dashboard exists to surface; nobody checks it daily.</div>`;
  }

  html += '<div class="grid g2">';
  for (const p of res.alcor) {
    const s = sqrtPriceFromX64(p.pool.sqrtX64);
    html += `<div class="poscard ${p.inRange ? '' : 'out'}" data-rb="${esc(p.pool.id)}:${p.tickLower}:${p.tickUpper}:${p.pool.tick}">
      <div class="ph"><span class="pair">${pairName(p.pool)}</span>
        <span class="badge alcor">alcor</span>
        <span class="badge ${p.inRange ? 'good' : 'bad'}">${p.inRange ? 'in range' : 'out of range'}</span>
        <span class="spacer" style="flex:1"></span><span class="pv">${usd(p.valueUsd)}</span></div>
      <div class="sub">position #${p.posId} &middot; pool #${esc(p.pool.id)} &middot; ${(p.pool.feeBps / 100).toFixed(2)}% fee</div>
      <div class="rb-slot" style="margin-top:10px"></div>
      <dl class="kv">
        <dt>${esc(p.pool.symA)}</dt><dd>${qty(p.amountA)}</dd>
        <dt>${esc(p.pool.symB)}</dt><dd>${qty(p.amountB)}</dd>
        <dt>Uncollected fees</dt><dd>${usd(p.feesUsd)}</dd>
        <dt>Deposit ratio now</dt><dd>${(p.ratio.shareA * 100).toFixed(0)}% / ${(p.ratio.shareB * 100).toFixed(0)}%</dd>
      </dl>
      <button class="btn ghost" style="margin-top:10px;width:100%" data-compound="${esc(p.pool.id)}:${p.posId}">Plan compound</button>
      <div class="cplan" hidden></div></div>`;
  }
  for (const p of res.taco) {
    html += `<div class="poscard">
      <div class="ph"><span class="pair">${pairName(p.pool)}</span>
        <span class="badge taco">taco</span>
        <span class="spacer" style="flex:1"></span><span class="pv">${usd(p.valueUsd)}</span></div>
      <div class="sub">${qty(p.balance)} ${esc(p.pool.id)} LP &middot; ${(p.share * 100).toPrecision(3)}% of the pair</div>
      <dl class="kv">
        <dt>${esc(p.pool.symA)}</dt><dd>${qty(p.amountA)}</dd>
        <dt>${esc(p.pool.symB)}</dt><dd>${qty(p.amountB)}</dd>
      </dl></div>`;
  }
  html += '</div>';
  out.innerHTML = html;

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
      feeBps: CFG?.commercial?.compoundFeeBps ?? 75,
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
        <div class="stat"><span class="v">${usd(b.netUsd)}</span><span class="k">redeposited</span><span class="sub">after ${usd(b.feeUsd)} fee</span></div>
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
        <p class="sub" style="margin:10px 0 0">One signature, one transaction. No contract holds your funds and no permission is delegated — if you do not sign, nothing happens.</p>
      </div>
    </div>`;
}

// --------------------------------------------------- COMPOUND (whole wallet) -
function wireCompound() {
  $('#compGo').onclick = () => runCompound($('#compInput').value.trim());
  $('#compInput').onkeydown = e => { if (e.key === 'Enter') runCompound(e.target.value.trim()); };
  $('#compDemo').onclick = () => { $('#compInput').value = 'liquidcheese'; runCompound('liquidcheese'); };
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

  const feeBps = CFG?.commercial?.compoundFeeBps ?? 75;
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
  const worth = plans.filter(x => x.plan?.viable);
  const gross = worth.reduce((s, x) => s + x.plan.grossUsd, 0);
  const fee = worth.reduce((s, x) => s + x.plan.feeUsd, 0);
  const swaps = worth.reduce((s, x) => s + x.plan.swaps.length, 0);
  const actions = worth.reduce((s, x) => s + x.plan.actions.length, 0);
  const unpriceable = plans.reduce((s, x) => s + (x.plan?.unpriced.length || 0), 0);
  const tokensSeen = new Set(plans.flatMap(x => x.harvest.basket.map(b => b.symbol)));

  let html = `<div class="stats">
      <div class="stat"><span class="v">${usd(gross)}</span><span class="k">claimable now</span><span class="sub">${tokensSeen.size} distinct token${tokensSeen.size === 1 ? '' : 's'}</span></div>
      <div class="stat"><span class="v">${usd(gross - fee)}</span><span class="k">back to work</span><span class="sub">after ${usd(fee)} fee at ${(feeBps / 100).toFixed(2)}%</span></div>
      <div class="stat"><span class="v">${worth.length}/${plans.length}</span><span class="k">worth compounding</span></div>
      <div class="stat"><span class="v">${swaps}</span><span class="k">swaps needed</span><span class="sub">across all positions</span></div>
      <div class="stat"><span class="v">${worth.length}</span><span class="k">transaction${worth.length === 1 ? '' : 's'} to sign</span><span class="sub">${actions} actions, one tx per position</span></div>
    </div>`;

  if (unpriceable) {
    html += `<div class="err" style="border-color:var(--accent);background:var(--accent-soft)">
      <b>${unpriceable} reward${unpriceable === 1 ? '' : 's'} could not be priced.</b> Those tokens have no pool deep enough to quote against, so they are excluded from the figures above rather than counted at a made-up value. They can still be claimed — they just cannot be valued or safely swapped.</div>`;
  }

  html += '<div class="grid" style="gap:12px">';
  for (const { pos, harvest, plan } of plans) {
    if (!plan) continue;
    const basketBits = harvest.basket.map(b =>
      `<span class="badge" title="${esc(b.source)}">${esc(b.symbol)} ${b.priced ? usd(b.usd) : '?'}</span>`).join(' ');
    html += `<div class="card">
      <div class="ph" style="display:flex;gap:9px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px">
        <span class="pair">${pairName(pos.pool)}</span>
        <span class="sub">#${pos.posId} &middot; ticks ${pos.tickLower}…${pos.tickUpper}</span>
        <span class="badge ${pos.inRange ? 'good' : 'bad'}">${pos.inRange ? 'in range' : 'out of range'}</span>
        <span style="flex:1"></span>
        <span class="mono" style="font-size:16px;font-weight:600">${usd(plan.grossUsd)}</span>
      </div>
      ${plan.viable ? `
        <div style="font-size:12.5px;margin-bottom:8px">${basketBits || '<span class="dim">nothing claimable</span>'}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;font-size:12.5px">
          <div><span class="dim">This band needs</span><br><span class="mono">${(plan.ratio.shareA * 100).toFixed(1)}% ${esc(pos.pool.symA)} / ${(plan.ratio.shareB * 100).toFixed(1)}% ${esc(pos.pool.symB)}</span></div>
          <div><span class="dim">No swap needed</span><br><span class="mono">${plan.alreadyRight.map(b => esc(b.symbol)).join(', ') || '—'}</span></div>
          <div><span class="dim">Swaps</span><br><span class="mono">${plan.swaps.map(s => `${esc(s.from)}&rarr;${esc(s.to)}`).join(', ') || 'none'}</span></div>
          <div><span class="dim">Transaction</span><br><span class="mono">${plan.actions.length} actions, 1 signature</span></div>
        </div>` : `<div class="dim" style="font-size:12.5px">${esc(plan.reason || 'Nothing to do.')}</div>`}
    </div>`;
  }
  html += '</div>';

  html += `<div class="card" style="margin-top:14px"><h3>How this executes</h3>
    <p style="font-size:13px;color:var(--ink-2);margin:0 0 8px;max-width:74ch">Each position becomes one transaction: collect fees, claim every farm reward, swap only what is not already the right token, redeposit into the same band, and pay the service fee inline. Your wallet shows all of it before you approve.</p>
    <p style="font-size:13px;color:var(--ink-2);margin:0;max-width:74ch">There is no compounding contract and no delegated permission. Nothing can move your funds without a signature you give at that moment — which also means a position in ten farms is ten claims in one transaction, not ten separate approvals.</p>
  </div>`;

  out.innerHTML = html;
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
  try { swaps = await recentSwaps({ minutes: actWindow, onProgress: n => { const m = out.querySelector('span:last-child'); if (m) m.textContent = `Reading the swap feed… ${n.toLocaleString()} swaps`; } }); }
  catch (e) { out.innerHTML = `<div class="err">Feed unavailable: ${esc(e.message)}</div>`; return; }
  activityLoaded = true;

  const priced = swaps.filter(s => s.volumeUsd != null);
  const vol = priced.reduce((s, x) => s + x.volumeUsd, 0);
  const byPool = new Map();
  for (const s of priced) {
    const key = s.pool ? pairName(s.pool) : `#${s.poolId}`;
    byPool.set(key, (byPool.get(key) || 0) + s.volumeUsd);
  }
  const traders = new Map();
  for (const s of priced) traders.set(s.trader, (traders.get(s.trader) || 0) + s.volumeUsd);

  $('#actMeta').innerHTML = `${swaps.length.toLocaleString()} swaps over ${actWindow} min &middot; ${priced.length.toLocaleString()} priceable`
    + (swaps.truncated ? ` &middot; <span class="neg">showing the most recent ${swaps.length.toLocaleString()} of ${swaps.reportedTotal.toLocaleString()}</span>` : '');

  out.innerHTML = `<div class="stats">
      <div class="stat"><span class="v">${usd(vol)}</span><span class="k">volume, last ${actWindow} min</span><span class="sub">${swaps.truncated ? 'partial window' : usd(vol / actWindow * 60) + ' / hour at this rate'}</span></div>
      <div class="stat"><span class="v">${swaps.length.toLocaleString()}</span><span class="k">swaps</span><span class="sub">${(swaps.length / actWindow).toFixed(0)} per minute</span></div>
      <div class="stat"><span class="v">${byPool.size}</span><span class="k">pools touched</span></div>
      <div class="stat"><span class="v">${traders.size}</span><span class="k">unique traders</span></div>
    </div>
    <div class="grid g2" style="margin-bottom:12px">
      <div class="card"><h3>Volume by pool <span class="dim">— share of window</span></h3><div id="actDonut"></div></div>
      <div class="card"><h3>Most active traders <span class="dim">— by volume</span></h3><div id="actBars"></div></div>
    </div>
    <div class="tablewrap"><table><thead><tr>
      <th>When</th><th>Pool</th><th>Trader</th><th class="r">In</th><th class="r">Out</th><th class="r">Value</th>
    </tr></thead><tbody>${swaps.slice(0, 150).map(s => {
      const inA = s.amountA > 0;
      return `<tr><td class="num dim">${ago(s.ts)}</td>
        <td>${s.pool ? `<span class="pair">${pairName(s.pool)}</span>` : ''} <span class="sub">#${esc(s.poolId)}</span></td>
        <td class="mono">${esc(s.trader)}</td>
        <td class="r num">${qty(Math.abs(inA ? s.amountA : s.amountB))} <span class="sub">${esc(inA ? s.symA : s.symB)}</span></td>
        <td class="r num">${qty(Math.abs(inA ? s.amountB : s.amountA))} <span class="sub">${esc(inA ? s.symB : s.symA)}</span></td>
        <td class="r num">${usd(s.volumeUsd)}</td></tr>`;
    }).join('')}</tbody></table></div>`;

  $('#actDonut').appendChild(donut([...byPool].map(([label, value]) => ({ label, value })), { fmt: usd }));
  $('#actBars').appendChild(bars([...traders].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ label, value })), { fmt: usd }));
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
    <p class="vs">${(p.feeBps / 100).toFixed(2)}% fee tier${p.tick != null ? ` &middot; tick ${p.tick}` : ''} &middot; reserves read live from <code class="mono">${dex === 'alcor' ? 'swap.alcor' : 'swap.taco'}</code></p>
    <div class="stats">
      <div class="stat"><span class="v">${usd(p.tvl)}</span><span class="k">TVL</span></div>
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
      <div class="card"><h3>Price history <span class="dim">— from Hyperion table deltas</span></h3><div id="poolChart"><div class="loading"><span class="spinner"></span><span>Reading history…</span></div></div></div>
      <div class="card"><h3>Recent swaps here</h3><div id="poolSwaps"><div class="loading"><span class="spinner"></span><span>Reading feed…</span></div></div></div>
    </div>`;

  if (dex === 'alcor') {
    poolHistory(p.id).then(h => {
      const box = $('#poolChart');
      if (!h.length) { box.innerHTML = '<div class="empty">No table deltas returned for this pool in the window the history node keeps.</div>'; return; }
      box.innerHTML = '';
      box.appendChild(lineChart(h.map(x => ({ x: new Date(x.ts + 'Z').getTime(), y: x.price })), {
        fmtY: v => qty(v), fmtX: t => new Date(t).toISOString().slice(5, 16).replace('T', ' '),
      }));
      const note = document.createElement('p');
      note.className = 'sub'; note.style.marginTop = '8px';
      note.textContent = `${h.length} state changes · ${esc(p.symB)} per ${esc(p.symA)}`;
      box.appendChild(note);
    }).catch(e => { $('#poolChart').innerHTML = `<div class="empty">History unavailable: ${esc(e.message)}</div>`; });

    recentSwaps({ poolId: p.id, limit: 400 }).then(s => {
      const box = $('#poolSwaps');
      if (!s.length) { box.innerHTML = '<div class="empty">No swaps for this pool in the recent feed window.</div>'; return; }
      box.innerHTML = `<div class="tablewrap" style="max-height:280px;border:0"><table><thead><tr><th>When</th><th>Trader</th><th class="r">Size</th><th class="r">Value</th></tr></thead><tbody>${
        s.slice(0, 40).map(x => `<tr><td class="num dim">${ago(x.ts)}</td><td class="mono">${esc(x.trader)}</td>
          <td class="r num">${qty(Math.abs(x.amountA))} ${esc(x.symA)}</td><td class="r num">${usd(x.volumeUsd)}</td></tr>`).join('')}</tbody></table></div>`;
    }).catch(e => { $('#poolSwaps').innerHTML = `<div class="empty">Feed unavailable: ${esc(e.message)}</div>`; });
  } else {
    $('#poolChart').innerHTML = '<div class="empty">TacoSwap history is not wired up yet — its state changes live in a different table shape.</div>';
    $('#poolSwaps').innerHTML = '<div class="empty">TacoSwap uses <code class="mono">exchangelog</code>; not wired up yet.</div>';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  boot();
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-view]');
    if (b?.dataset.view === 'activity' && !activityLoaded) renderActivity();
  });
});
