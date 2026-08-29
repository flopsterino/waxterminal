// =============================================================================
// CHARTS — hand-drawn SVG, no library.
//
// Colours come from --c1..--c8 in theme.css, assigned in fixed order and never
// cycled: colour follows the entity, so a filter that removes a series must not
// repaint the survivors. That eight-slot set is validated against both theme
// surfaces; charts here only consume it.
//
// Every plot ships a hover layer. A chart in a browser that cannot be
// interrogated is a picture of data, not a view of it.
// =============================================================================

const NS = 'http://www.w3.org/2000/svg';
const el = (n, a = {}) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
export const SERIES = i => `var(--c${(i % 8) + 1})`;

// ------------------------------------------------------------- tooltip ------
let tip;
function tooltip() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'charttip';
  tip.hidden = true;
  document.body.appendChild(tip);
  return tip;
}
function showTip(html, x, y) {
  const t = tooltip();
  t.innerHTML = html; t.hidden = false;
  const r = t.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 14));
  const top = Math.max(8, y - r.height - 12);
  t.style.transform = `translate(${left}px, ${top}px)`;
}
export const hideTip = () => { if (tip) tip.hidden = true; };

// -------------------------------------------------------------- line/area ---
// points: [{x, y}] — x is usually a timestamp. One series: no legend, the title
// names it. Crosshair + tooltip on hover, endpoint emphasised.
export function areaChart(points, { height = 190, color = 'var(--c1)', fmtY = v => v, fmtX = v => v, label = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'chart';
  if (!points.length) { wrap.innerHTML = '<div class="chart-empty">No data in range.</div>'; return wrap; }

  const W = 720, H = height, padL = 46, padR = 12, padT = 12, padB = 24;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label });
  svg.style.cssText = `width:100%;height:${H}px;display:block;overflow:visible`;

  const xs = points.map(p => p.x), ys = points.map(p => p.y).filter(Number.isFinite);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y0 === y1) { const p = Math.abs(y0 || 1) * 0.08; y0 -= p; y1 += p; }
  // Start value axes at zero where the data allows: a truncated baseline makes a
  // 2% move look like a crash.
  if (y0 > 0 && y0 / y1 > 0.55) y0 = 0;
  const pad = (y1 - y0) * 0.08; y1 += pad;

  const X = v => padL + ((v - x0) / (x1 - x0 || 1)) * (W - padL - padR);
  const Y = v => H - padB - ((v - y0) / (y1 - y0 || 1)) * (H - padT - padB);

  for (let i = 0; i <= 3; i++) {
    const v = y0 + (y1 - y0) * (i / 3), y = Y(v);
    svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: 'var(--line)', 'stroke-width': 1 }));
    const t = el('text', { x: padL - 6, y: y + 3.5, fill: 'var(--muted)', 'font-size': 10, 'text-anchor': 'end' });
    t.style.fontFamily = 'var(--font-data)'; t.textContent = fmtY(v);
    svg.appendChild(t);
  }

  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const gid = 'g' + Math.random().toString(36).slice(2, 8);
  const defs = el('defs'), grad = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(el('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': .25 }),
              el('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }));
  defs.appendChild(grad); svg.appendChild(defs);
  svg.appendChild(el('path', { d: `${d}L${X(points.at(-1).x)},${H - padB}L${X(points[0].x)},${H - padB}Z`, fill: `url(#${gid})` }));
  svg.appendChild(el('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  const last = points.at(-1);
  svg.appendChild(el('circle', { cx: X(last.x), cy: Y(last.y), r: 4, fill: color, stroke: 'var(--surface)', 'stroke-width': 2 }));

  for (const [v, anchor] of [[x0, 'start'], [x1, 'end']]) {
    const t = el('text', { x: v === x0 ? padL : W - padR, y: H - 6, fill: 'var(--muted)', 'font-size': 10, 'text-anchor': anchor });
    t.style.fontFamily = 'var(--font-data)'; t.textContent = fmtX(v); svg.appendChild(t);
  }

  const cross = el('line', { y1: padT, y2: H - padB, stroke: 'var(--line-2)', 'stroke-width': 1, opacity: 0 });
  const dot = el('circle', { r: 4, fill: color, stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 });
  svg.append(cross, dot);
  const hit = el('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' });
  svg.appendChild(hit);

  hit.addEventListener('pointermove', e => {
    const box = svg.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * W;
    let best = points[0], bd = Infinity;
    for (const p of points) { const dd = Math.abs(X(p.x) - vx); if (dd < bd) { bd = dd; best = p; } }
    cross.setAttribute('x1', X(best.x)); cross.setAttribute('x2', X(best.x)); cross.setAttribute('opacity', 1);
    dot.setAttribute('cx', X(best.x)); dot.setAttribute('cy', Y(best.y)); dot.setAttribute('opacity', 1);
    showTip(`<b>${fmtY(best.y)}</b><span>${fmtX(best.x)}</span>`, e.clientX, e.clientY);
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); hideTip(); });

  wrap.appendChild(svg);
  return wrap;
}

// ----------------------------------------------------------------- donut ----
// Share-of-total. Capped low on purpose: a ring of twenty slivers encodes
// nothing, and past a handful the colours stop being separable, so the tail
// folds into one "other" slice. Every slice is direct-labelled in the legend,
// which is also the relief for the light theme's lower-contrast slots.
export function donut(items, { size = 150, thickness = 22, top = 5, fmt = v => v } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'donut';
  const sorted = [...items].filter(i => i.value > 0).sort((a, b) => b.value - a.value);
  if (!sorted.length) { wrap.innerHTML = '<div class="chart-empty">Nothing to show.</div>'; return wrap; }
  const head = sorted.slice(0, top);
  const restV = sorted.slice(top).reduce((s, i) => s + i.value, 0);
  if (restV > 0) head.push({ label: `Other (${sorted.length - top})`, value: restV, other: true });
  const total = head.reduce((s, i) => s + i.value, 0) || 1;

  const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img' });
  svg.style.flex = 'none';
  const r = (size - thickness) / 2, c = size / 2, C = 2 * Math.PI * r;
  let offset = 0;
  head.forEach((it, i) => {
    const frac = it.value / total;
    // A 2px surface gap between segments keeps adjacent fills from reading as one.
    const gap = Math.min(2, frac * C * 0.4);
    const arc = el('circle', {
      cx: c, cy: c, r, fill: 'none',
      stroke: it.other ? 'var(--line-2)' : SERIES(i), 'stroke-width': thickness,
      'stroke-dasharray': `${Math.max(0, frac * C - gap).toFixed(2)} ${C.toFixed(2)}`,
      'stroke-dashoffset': (-offset * C).toFixed(2),
      transform: `rotate(-90 ${c} ${c})`,
    });
    arc.style.cursor = 'default';
    arc.addEventListener('pointermove', e => showTip(`<b>${it.label}</b><span>${fmt(it.value)} · ${(frac * 100).toFixed(1)}%</span>`, e.clientX, e.clientY));
    arc.addEventListener('pointerleave', hideTip);
    svg.appendChild(arc);
    offset += frac;
  });
  wrap.appendChild(svg);

  const leg = document.createElement('div');
  leg.className = 'legend';
  head.forEach((it, i) => {
    const row = document.createElement('div');
    row.innerHTML = `<span class="sw" style="background:${it.other ? 'var(--line-2)' : SERIES(i)}"></span>
      <span class="lb">${it.label}</span><span class="vl mono">${fmt(it.value)}</span>`;
    leg.appendChild(row);
  });
  wrap.appendChild(leg);
  return wrap;
}

// ------------------------------------------------------------------ bars ----
// Ranked comparison. One measure, so one colour: hue here would encode nothing.
// Data-ends are rounded and anchored to the baseline.
export function bars(items, { fmt = v => v, color = 'var(--c1)', max = null } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'bars';
  if (!items.length) { wrap.innerHTML = '<div class="chart-empty">Nothing to show.</div>'; return wrap; }
  const top = max ?? Math.max(...items.map(i => i.value), 1);
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'bar';
    row.innerHTML = `<span class="lb" title="${it.label}">${it.label}</span>
      <span class="tr"><span class="fill" style="width:${Math.max(1.5, it.value / top * 100).toFixed(1)}%;background:${color}"></span></span>
      <span class="vl mono">${fmt(it.value)}</span>`;
    row.addEventListener('pointermove', e => showTip(`<b>${it.label}</b><span>${fmt(it.value)}${it.note ? ' · ' + it.note : ''}</span>`, e.clientX, e.clientY));
    row.addEventListener('pointerleave', hideTip);
    wrap.appendChild(row);
  }
  return wrap;
}

// ------------------------------------------------------------- histogram ----
// Distribution of one measure across many items — answers "where does the bulk
// sit", which a top-10 list cannot.
export function histogram(values, { bins = 18, fmtX = v => v, color = 'var(--c1)', height = 130, label = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'chart';
  const vals = values.filter(Number.isFinite);
  if (!vals.length) { wrap.innerHTML = '<div class="chart-empty">No data.</div>'; return wrap; }
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const counts = new Array(bins).fill(0);
  for (const v of vals) counts[Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo || 1)) * bins))]++;
  const peak = Math.max(...counts, 1);

  const W = 720, H = height, padB = 22, padT = 8;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label });
  svg.style.cssText = `width:100%;height:${H}px;display:block;overflow:visible`;
  const bw = W / bins;
  counts.forEach((n, i) => {
    const h = (n / peak) * (H - padT - padB);
    const rect = el('rect', {
      x: i * bw + 1, y: H - padB - h, width: bw - 2, height: Math.max(h, n ? 1.5 : 0),
      fill: color, rx: 3,
    });
    const from = lo + (hi - lo) * (i / bins), to = lo + (hi - lo) * ((i + 1) / bins);
    rect.addEventListener('pointermove', e => showTip(`<b>${n} pool${n === 1 ? '' : 's'}</b><span>${fmtX(from)} – ${fmtX(to)}</span>`, e.clientX, e.clientY));
    rect.addEventListener('pointerleave', hideTip);
    svg.appendChild(rect);
  });
  svg.appendChild(el('line', { x1: 0, x2: W, y1: H - padB, y2: H - padB, stroke: 'var(--line)', 'stroke-width': 1 }));
  for (const [v, x, anchor] of [[lo, 0, 'start'], [hi, W, 'end']]) {
    const t = el('text', { x, y: H - 6, fill: 'var(--muted)', 'font-size': 10, 'text-anchor': anchor });
    t.style.fontFamily = 'var(--font-data)'; t.textContent = fmtX(v); svg.appendChild(t);
  }
  wrap.appendChild(svg);
  return wrap;
}

// A position's tick band with the market price on it — the one picture that
// makes concentrated liquidity legible at a glance.
export function rangeBar(tickLower, tickUpper, tick, { pad = 0.35 } = {}) {
  const d = document.createElement('div');
  d.className = 'rangebar';
  const width = tickUpper - tickLower;
  const lo = tickLower - width * pad, hi = tickUpper + width * pad;
  const pct = t => Math.max(0, Math.min(100, ((t - lo) / (hi - lo)) * 100));
  const inRange = tick > tickLower && tick < tickUpper;
  const band = document.createElement('div');
  band.className = 'band' + (inRange ? '' : ' out');
  band.style.left = pct(tickLower) + '%';
  band.style.width = (pct(tickUpper) - pct(tickLower)) + '%';
  d.appendChild(band);
  const px = document.createElement('div');
  px.className = 'px' + (inRange ? '' : ' out');
  px.style.left = pct(tick) + '%';
  d.appendChild(px);
  d.title = inRange ? 'Price is inside the band — earning' : 'Price has left the band — earning nothing';
  return d;
}

// A bubble map. Circle area is what a wallet holds; a line means those two
// wallets have moved this token between each other. Laid out on a ring rather
// than with a force simulation — with a dozen nodes the physics adds nothing but
// a dependency and a wait, and a ring keeps every label readable.
export function bubbleMap(nodes, links, { size = 380, fmt = v => v } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'chart';
  const live = nodes.filter(n => n.value > 0).slice(0, 12);
  if (live.length < 2) { wrap.innerHTML = '<div class="chart-empty">Not enough holders to map.</div>'; return wrap; }

  const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': 'Holder map' });
  svg.style.cssText = `width:100%;max-width:${size}px;height:auto;display:block;margin:0 auto;overflow:visible`;

  const max = Math.max(...live.map(n => n.value));
  const R = size * 0.34, cx = size / 2, cy = size / 2;
  const pos = new Map();
  live.forEach((n, i) => {
    const a = (i / live.length) * Math.PI * 2 - Math.PI / 2;
    pos.set(n.id, { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, n });
  });

  // Edges first so bubbles sit on top of them.
  const maxLink = Math.max(...links.map(l => l.value), 1);
  for (const l of links) {
    const a = pos.get(l.source), b = pos.get(l.target);
    if (!a || !b) continue;
    const line = el('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: 'var(--accent)', 'stroke-opacity': 0.45,
      'stroke-width': 1 + 3 * Math.sqrt(l.value / maxLink),
    });
    line.appendChild(el('title')).textContent = `${l.source} ↔ ${l.target}: ${fmt(l.value)}`;
    svg.appendChild(line);
  }

  live.forEach((n, i) => {
    const p = pos.get(n.id);
    const r = 10 + 26 * Math.sqrt(n.value / max);
    const g = el('g');
    const c = el('circle', {
      cx: p.x, cy: p.y, r,
      fill: n.contract ? 'var(--line-2)' : SERIES(i),
      'fill-opacity': n.contract ? 0.5 : 0.75,
      stroke: 'var(--surface)', 'stroke-width': 2,
    });
    c.appendChild(el('title')).textContent = `${n.id}: ${fmt(n.value)}${n.share != null ? ` (${(n.share * 100).toFixed(2)}% of supply)` : ''}${n.contract ? ' — a contract, holding for others' : ''}`;
    g.appendChild(c);
    const label = el('text', {
      x: p.x, y: p.y + r + 12, 'text-anchor': 'middle',
      fill: 'var(--ink-2)', 'font-size': 9.5,
    });
    label.style.fontFamily = 'var(--font-data)';
    label.textContent = n.id.length > 13 ? n.id.slice(0, 12) + '…' : n.id;
    g.appendChild(label);
    svg.appendChild(g);
  });

  wrap.appendChild(svg);
  return wrap;
}
