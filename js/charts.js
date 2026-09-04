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

// A drawing width that matches the screen it lands on.
//
// Every chart here used a 720-wide viewBox with preserveAspectRatio="none",
// which stretches the drawing to whatever width it gets. On a desktop that is
// near enough 1:1 and nobody notices. On a 390-point iPhone it squashes the
// horizontal axis to 0.54 while leaving the vertical at 1, so every label is
// drawn at half width — legible on the author's laptop, mangled on the device
// most people actually hold. Matching the viewBox to the viewport keeps the
// scale at 1:1 on both.
const chartW = () => (typeof window !== 'undefined' && window.innerWidth > 0
  ? Math.max(300, Math.min(720, Math.round(window.innerWidth - 60)))
  : 720);

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

  const W = chartW(), H = height, padL = 46, padR = 12, padT = 12, padB = 24;
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

// --------------------------------------------------------------- columns ----
// Volume through time.
//
// Not an area chart: a filled line implies a continuous quantity that was
// always somewhere between two readings, and volume is a bucket total. Drawn
// that way it invents trades in the gaps and makes an hour with one swap look
// like an hour of steady flow. Columns say the bucket is the unit.
export function columns(points, { height = 170, color = 'var(--c2)', fmtY = v => v, fmtX = v => v, label = '', onPick = null } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'chart';
  if (!points.length) { wrap.innerHTML = '<div class="chart-empty">No data in range.</div>'; return wrap; }

  const W = chartW(), H = height, padL = 46, padR = 12, padT = 12, padB = 24;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label });
  svg.style.cssText = `width:100%;height:${H}px;display:block;overflow:visible`;

  const y1 = Math.max(...points.map(p => p.y).filter(Number.isFinite), 0) * 1.1 || 1;
  const inner = W - padL - padR;
  const step = inner / points.length;
  const bw = Math.max(1, Math.min(step * 0.72, 34));
  const X = i => padL + step * i + (step - bw) / 2;
  const Y = v => H - padB - (v / y1) * (H - padT - padB);

  for (let i = 0; i <= 3; i++) {
    const v = y1 * (i / 3), y = Y(v);
    svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: 'var(--line)', 'stroke-width': 1 }));
    const t = el('text', { x: padL - 6, y: y + 3.5, fill: 'var(--muted)', 'font-size': 10, 'text-anchor': 'end' });
    t.style.fontFamily = 'var(--font-data)'; t.textContent = fmtY(v);
    svg.appendChild(t);
  }

  // The bar was the only hover target, which on a quiet hour is a three-pixel
  // sliver you have to hunt for. Each column gets a full-height catcher instead,
  // so the whole vertical strip answers — and it highlights, so you can see
  // which one you are reading.
  const bars = [];
  points.forEach((p, i) => {
    const h = Math.max(p.y > 0 ? 1.5 : 0, (H - padB) - Y(p.y));
    const r = el('rect', { x: X(i), y: H - padB - h, width: bw, height: h, fill: color, rx: 1.5 });
    svg.appendChild(r);
    bars.push(r);
  });

  const band = el('rect', { x: padL, y: padT, width: 0, height: H - padT - padB, fill: 'var(--ink)', 'fill-opacity': 0.06, rx: 2 });
  band.style.pointerEvents = 'none';
  svg.appendChild(band);

  const hit = el('g');
  points.forEach((p, i) => {
    const c = el('rect', { x: padL + step * i, y: padT, width: step, height: H - padT - padB, fill: 'transparent' });
    c.style.cursor = onPick ? 'pointer' : 'crosshair';
    const show = e => {
      band.setAttribute('x', padL + step * i);
      band.setAttribute('width', step);
      bars.forEach((b, j) => b.setAttribute('opacity', j === i ? 1 : 0.45));
      showTip(`<b>${fmtY(p.y)}</b><span>${fmtX(p.x)}</span>${p.note ? `<span>${p.note}</span>` : ''}`, e.clientX, e.clientY);
    };
    c.addEventListener('pointerenter', show);
    c.addEventListener('pointermove', show);
    if (onPick) c.addEventListener('click', () => onPick(p, i));
    hit.appendChild(c);
  });
  hit.addEventListener('pointerleave', () => {
    band.setAttribute('width', 0);
    bars.forEach(b => b.removeAttribute('opacity'));
    hideTip();
  });
  svg.appendChild(hit);

  for (const [v, anchor] of [[points[0].x, 'start'], [points.at(-1).x, 'end']]) {
    const t = el('text', { x: v === points[0].x ? padL : W - padR, y: H - 6, fill: 'var(--muted)', 'font-size': 10, 'text-anchor': anchor });
    t.style.fontFamily = 'var(--font-data)'; t.textContent = fmtX(v); svg.appendChild(t);
  }

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
// ------------------------------------------------------------- sparkline ----
// A shape, in a table cell. No axes and no labels on purpose: the number beside
// it is the value, and all this has to answer is whether that number has been
// climbing, falling or sitting still. Two points are not a trend, so it draws
// nothing until there are three.
export function sparkline(values, { width = 74, height = 20, color = 'var(--c1)' } = {}) {
  const wrap = document.createElement('span');
  const ys = values.filter(Number.isFinite);
  if (ys.length < 3) { wrap.className = 'dim'; wrap.textContent = '—'; return wrap; }
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const span = (hi - lo) || Math.abs(hi) || 1;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'trend' });
  svg.style.cssText = `width:${width}px;height:${height}px;display:inline-block;vertical-align:middle;overflow:visible`;
  const X = i => (i / (ys.length - 1)) * width;
  const Y = v => height - 2 - ((v - lo) / span) * (height - 4);
  svg.appendChild(el('path', {
    d: ys.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(''),
    fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));
  svg.appendChild(el('circle', { cx: X(ys.length - 1), cy: Y(ys.at(-1)), r: 2, fill: color }));
  wrap.appendChild(svg);
  return wrap;
}

export function bars(items, { fmt = v => v, color = 'var(--c1)', max = null } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'bars';
  if (!items.length) { wrap.innerHTML = '<div class="chart-empty">Nothing to show.</div>'; return wrap; }
  const top = max ?? Math.max(...items.map(i => i.value), 1);
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'bar';
    // The label column is narrow on a phone, so anything appended to the name
    // pushes the name out of view — "WAX/LEEF · $30" became "WAX/LEEF · S…".
    // A second line keeps both readable, and a tooltip is no answer on touch.
    row.innerHTML = `<span class="lb" title="${it.label}">${it.label}${it.sub ? `<span class="lbsub">${it.sub}</span>` : ''}</span>
      <span class="tr"><span class="fill" style="width:${Math.max(1.5, it.value / top * 100).toFixed(1)}%;background:${color}"></span></span>
      <span class="vl mono">${fmt(it.value)}</span>`;
    row.addEventListener('pointermove', e => showTip(`<b>${it.label}</b><span>${fmt(it.value)}${it.note ? ' · ' + it.note : ''}</span>`, e.clientX, e.clientY));
    row.addEventListener('pointerleave', hideTip);
    // A ranked list of tokens and pools is a list of things to go and look at.
    // These rows were inert, so clicking the biggest token on the front page
    // did nothing at all and looked like a page that had failed to load.
    if (typeof it.go === 'function') {
      row.classList.add('clickable');
      row.addEventListener('click', () => { hideTip(); it.go(); });
    }
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

  const W = chartW(), H = height, padB = 22, padT = 8;
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

// ------------------------------------------------------------ bubble map ----
// Holders as bubbles, wallets that have moved the token to each other drawn
// together.
//
// The first version spaced every holder evenly around one ring, which is a
// picture of the holder list rather than of the token: the clusters were in
// there, but only as lines you had to trace. Grouping the ring by connected
// component and colouring each group means the shape of the ownership is the
// first thing you see — one colour taking up half the circle is the finding.
//
// Sitting in a group is not an accusation. Projects legitimately run a
// treasury, a farm funder and an airdrop account, and those three will always
// be connected. The map shows the relationship; the share column says whether
// it matters.
export function bubbleMap(nodes, links, { size = 430, fmt = v => v, onPick = null, cap = 16 } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'chart bubblemap';
  const live = nodes.filter(n => n.value > 0).sort((a, b) => b.value - a.value).slice(0, cap);
  if (live.length < 2) { wrap.innerHTML = '<div class="chart-empty">Not enough holders to map.</div>'; return wrap; }

  const ids = new Set(live.map(n => n.id));
  const edges = links.filter(l => ids.has(l.source) && ids.has(l.target));

  // Connected components, so a group can be coloured as one thing.
  const parent = new Map(live.map(n => [n.id, n.id]));
  const find = a => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  for (const l of edges) { const ra = find(l.source), rb = find(l.target); if (ra !== rb) parent.set(ra, rb); }
  const groupOf = new Map();
  const members = new Map();
  for (const n of live) {
    const r = find(n.id);
    if (!members.has(r)) members.set(r, []);
    members.get(r).push(n);
  }
  let ci = 0;
  for (const [, g] of members) { if (g.length < 2) continue; for (const n of g) groupOf.set(n.id, ci); ci++; }

  const max = Math.max(...live.map(n => n.value));
  const rOf = n => 10 + 26 * Math.sqrt(n.value / max);
  const cx = size / 2, cy = size / 2;

  // A ring spaced every holder evenly, which is a picture of the list rather
  // than of the ownership: the clusters were in there only as lines to trace.
  // A few hundred steps of repulsion, link attraction and a pull to the centre
  // put connected wallets next to each other, which is the finding.
  const P = live.map((n, i) => {
    const a = (i / live.length) * Math.PI * 2;
    return { n, r: rOf(n), x: cx + Math.cos(a) * size * 0.34, y: cy + Math.sin(a) * size * 0.34, vx: 0, vy: 0 };
  });
  const byId = new Map(P.map(p => [p.n.id, p]));
  const linked = new Map(live.map(n => [n.id, new Set()]));
  for (const l of edges) { linked.get(l.source).add(l.target); linked.get(l.target).add(l.source); }

  const settle = (steps = 320) => {
    for (let s = 0; s < steps; s++) {
      for (const p of P) { p.vx *= 0.82; p.vy *= 0.82; }
      for (let i = 0; i < P.length; i++) {
        for (let j = i + 1; j < P.length; j++) {
          const a = P[i], b = P[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d = Math.hypot(dx, dy) || 0.01;
          const want = a.r + b.r + 8;
          // Repulsion that turns into hard separation once they touch, so
          // bubbles never sit on top of each other however crowded it gets.
          const force = d < want ? (want - d) * 0.5 : 2400 / (d * d);
          dx /= d; dy /= d;
          a.vx -= dx * force; a.vy -= dy * force;
          b.vx += dx * force; b.vy += dy * force;
        }
      }
      for (const l of edges) {
        const a = byId.get(l.source), b = byId.get(l.target);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const pull = (d - (a.r + b.r + 26)) * 0.02;
        a.vx += (dx / d) * pull; a.vy += (dy / d) * pull;
        b.vx -= (dx / d) * pull; b.vy -= (dy / d) * pull;
      }
      for (const p of P) {
        if (p.fixed) { p.vx = p.vy = 0; continue; }
        // Weak: strong enough to keep the graph on the canvas, weak enough that
        // it does not pile everything into the middle. At 0.012 the map used a
        // third of its box and the labels sat on top of each other.
        p.vx += (cx - p.x) * 0.005; p.vy += (cy - p.y) * 0.005;
        p.x += p.vx; p.y += p.vy;
        const pad = p.r + 12;
        p.x = Math.max(pad, Math.min(size - pad, p.x));
        p.y = Math.max(pad, Math.min(size - pad, p.y));
      }
    }
  };
  settle();

  const H = size + 22;
  const svg = el('svg', { viewBox: `0 0 ${size} ${H}`, role: 'img', 'aria-label': 'Holder map' });
  svg.style.cssText = `width:100%;max-width:${size}px;height:auto;display:block;margin:0 auto;overflow:visible;touch-action:none`;

  const maxLink = Math.max(...edges.map(l => l.value), 1);
  const lineFor = new Map();
  const gLinks = el('g');
  for (const l of edges) {
    const line = el('line', {
      stroke: groupOf.get(l.source) == null ? 'var(--line-2)' : SERIES(groupOf.get(l.source)),
      'stroke-opacity': 0.55, 'stroke-width': 1.2 + 4 * Math.sqrt(l.value / maxLink), 'stroke-linecap': 'round',
    });
    line.appendChild(el('title')).textContent = `${l.source} ↔ ${l.target}: ${fmt(l.value)}`
      + (l.count ? ` over ${l.count} transfer${l.count === 1 ? '' : 's'}` : '');
    lineFor.set(l, line);
    gLinks.appendChild(line);
  }
  svg.appendChild(gLinks);

  const labelled = new Set([...live].sort((a, b) => b.value - a.value).slice(0, 10).map(n => n.id));
  const nodeEls = new Map();
  for (const p of P) {
    const n = p.n, gi = groupOf.get(n.id);
    const g = el('g');
    g.style.cursor = onPick ? 'pointer' : 'grab';
    const c = el('circle', {
      r: p.r,
      fill: n.contract ? 'var(--line-2)' : gi == null ? 'var(--muted)' : SERIES(gi),
      'fill-opacity': n.contract ? 0.45 : gi == null ? 0.35 : 0.8,
      'stroke-dasharray': n.moved ? '3 2' : null,
      stroke: 'var(--surface)', 'stroke-width': 2,
    });
    c.appendChild(el('title')).textContent = `${n.id}: ${fmt(n.value)}${n.moved ? ' moved — not a top holder' : ''}`
      + (n.share != null ? ` (${(n.share * 100).toFixed(2)}% of supply)` : '')
      + (n.contract ? ' — a contract, holding for others' : '')
      + (gi != null ? ` — moves this token with ${linked.get(n.id).size} other wallet${linked.get(n.id).size === 1 ? '' : 's'} here` : '');
    const pctText = n.share != null && p.r >= 17
      ? el('text', { 'text-anchor': 'middle', fill: 'var(--surface)', 'font-size': 10, 'font-weight': 700 }) : null;
    if (pctText) { pctText.style.fontFamily = 'var(--font-data)'; pctText.textContent = (n.share * 100).toFixed(n.share >= 0.1 ? 0 : 1) + '%'; }
    // The ten biggest get a name. Sixteen names in a small box overlap into an
    // unreadable mat, and a name you cannot read is worse than a hover that
    // tells you exactly — but a radius threshold cut it to three, because most
    // holders are small next to the largest. Rank is the honest cutoff.
    const label = labelled.has(n.id) ? el('text', { 'text-anchor': 'middle', fill: 'var(--ink-2)', 'font-size': 9.5 }) : null;
    if (label) {
      label.style.fontFamily = 'var(--font-data)';
      label.textContent = n.id.length > 13 ? n.id.slice(0, 12) + '…' : n.id;
    }
    g.append(c, ...(pctText ? [pctText] : []), ...(label ? [label] : []));
    svg.appendChild(g);
    nodeEls.set(n.id, { g, c, pctText, label, p });
  }

  // A short live settle after any nudge, rather than one frozen layout. The map
  // is a physical object now: push a bubble and its neighbours get out of the
  // way, let go and the whole thing relaxes back. That is the difference
  // between a diagram of a graph and a thing you can interrogate.
  let raf = 0;
  const animate = (frames = 40) => {
    cancelAnimationFrame(raf);
    let left = frames;
    const step = () => {
      settle(3);
      place();
      if (--left > 0) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const place = () => {
    for (const l of edges) {
      const a = byId.get(l.source), b = byId.get(l.target), line = lineFor.get(l);
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    }
    for (const [, e] of nodeEls) {
      e.c.setAttribute('cx', e.p.x); e.c.setAttribute('cy', e.p.y);
      if (e.pctText) { e.pctText.setAttribute('x', e.p.x); e.pctText.setAttribute('y', e.p.y + 3.5); }
      if (e.label) { e.label.setAttribute('x', e.p.x); e.label.setAttribute('y', e.p.y + e.p.r + 11); }
    }
  };
  place();

  // Hovering one wallet dims everything it has nothing to do with. On a map
  // whose whole point is "who moves this token with whom", that is the question
  // — and tracing a line by eye through sixteen bubbles is not an answer.
  const focus = id => {
    for (const [nid, e] of nodeEls) {
      const on = id == null || nid === id || linked.get(id).has(nid);
      e.g.setAttribute('opacity', on ? 1 : 0.18);
    }
    for (const l of edges) {
      const on = id == null || l.source === id || l.target === id;
      lineFor.get(l).setAttribute('stroke-opacity', on ? 0.85 : 0.06);
    }
  };

  for (const [nid, e] of nodeEls) {
    e.g.addEventListener('pointerenter', () => {
      focus(nid);
      // Lift the hovered bubble above its neighbours so a small one inside a
      // cluster can actually be read and clicked.
      e.g.parentNode.appendChild(e.g);
      e.c.setAttribute('stroke-width', 3);
    });
    e.g.addEventListener('pointerleave', () => { focus(null); e.c.setAttribute('stroke-width', 2); });
    // Drag to pull a bubble out of a knot and see what it is attached to.
    e.g.addEventListener('pointerdown', ev => {
      ev.preventDefault();
      const box = svg.getBoundingClientRect();
      const scale = size / box.width;
      e.p.fixed = true;
      let moved = 0;
      const move = m => {
        const nx = (m.clientX - box.left) * scale, ny = (m.clientY - box.top) * scale;
        moved += Math.abs(nx - e.p.x) + Math.abs(ny - e.p.y);
        e.p.x = nx; e.p.y = ny;
        settle(4); place();
      };
      const up = () => {
        e.p.fixed = false;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        // A press that never moved is a click, and a click opens the wallet.
        if (moved < 4 && onPick) onPick(nid);
        else animate(50);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  // Re-throw the layout. A force graph can settle into a knot, and the fix is
  // the same as with any physical tangle: shake it and let it fall again.
  const shake = el('text', { x: size - 8, y: 14, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 10 });
  shake.textContent = 'shuffle';
  shake.style.cursor = 'pointer';
  shake.addEventListener('click', () => {
    for (const p of P) { p.x = cx + (Math.random() - 0.5) * size * 0.7; p.y = cy + (Math.random() - 0.5) * size * 0.7; p.vx = p.vy = 0; }
    animate(90);
  });
  svg.appendChild(shake);

  const caption = el('text', { x: cx, y: H - 4, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 10 });
  caption.textContent = ci > 0
    ? 'One colour = wallets that have sent this token to each other · hover to isolate, drag to pull apart, click to open a wallet'
    : 'No transfers between these wallets · click one to see what it holds';
  svg.appendChild(caption);

  wrap.appendChild(svg);
  return wrap;
}

// ------------------------------------------------------------ depth map -----
// Where a concentrated-liquidity pool's money actually sits, across price.
//
// A pool holding $15,000 tells you nothing about whether your trade will move
// the price. All of it can be stacked in a band half a percent wide, or spread
// so thin that the first swap walks straight through. This is the chart that
// answers it, and the reason it exists here is that nothing on WAX draws one.
//
// Bars left of the current price are the quote token — what is there to buy the
// base WITH. Bars right of it are the base token, waiting to be sold. That is
// not decoration: it is why a pool can be deep in one direction and empty in
// the other, which a single "pooled value" figure hides completely.
export function depthChart(bands, { price, fmtPrice = v => v, fmt = v => v, height = 170, span = 0.6 } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'chart';
  const usable = bands.filter(b => b.usd > 0 && isFinite(b.priceLower) && isFinite(b.priceUpper));
  if (!usable.length || !(price > 0)) { wrap.innerHTML = '<div class="chart-empty">No liquidity map for this pool.</div>'; return wrap; }

  // A window around the current price. The outermost ticks on most pools are
  // full-range positions at 1e-18 and 1e18, and plotting those makes every
  // other band a pixel wide.
  const lo = price * (1 - span), hi = price * (1 + span);
  const BINS = 48;
  const step = (hi - lo) / BINS;
  const bins = new Array(BINS).fill(0);
  for (const b of usable) {
    const a = Math.max(lo, Math.min(hi, b.priceLower));
    const z = Math.max(lo, Math.min(hi, b.priceUpper));
    if (!(z > a)) continue;
    // Spread a band's value across the bins it covers, in proportion — a band
    // wider than a bin is not worth more than one that fits inside it.
    const width = b.priceUpper - b.priceLower;
    const per = b.usd * ((z - a) / (width || (z - a)));
    const i0 = Math.max(0, Math.floor((a - lo) / step));
    const i1 = Math.min(BINS - 1, Math.floor((z - lo) / step));
    const n = i1 - i0 + 1;
    for (let i = i0; i <= i1; i++) bins[i] += per / n;
  }
  const peak = Math.max(...bins, 1);
  const W = chartW(), H = height, padB = 20, padT = 8;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Liquidity by price' });
  svg.style.cssText = `width:100%;height:${H}px;display:block;overflow:visible`;
  const bw = W / BINS;
  const mid = Math.floor((price - lo) / step);
  bins.forEach((v, i) => {
    const h = (v / peak) * (H - padT - padB);
    const r = el('rect', {
      x: i * bw + 0.5, y: H - padB - h, width: bw - 1, height: Math.max(h, v ? 1.5 : 0), rx: 2,
      fill: i < mid ? 'var(--c2)' : 'var(--c1)', opacity: v ? 0.9 : 0,
    });
    const p0 = lo + i * step, p1 = p0 + step;
    r.addEventListener('pointermove', e => showTip(
      `<b>${fmtPrice(p0)} – ${fmtPrice(p1)}</b><span>${fmt(v)}${i < mid ? ' available to buy with' : ' waiting to be sold'}</span>`,
      e.clientX, e.clientY));
    r.addEventListener('pointerleave', hideTip);
    svg.appendChild(r);
  });
  // The current price, which is the only line on here that matters.
  const x = ((price - lo) / (hi - lo)) * W;
  svg.appendChild(el('line', { x1: x, x2: x, y1: padT - 4, y2: H - padB, stroke: 'var(--accent)', 'stroke-width': 1.5, 'stroke-dasharray': '3 3' }));
  for (const [frac, val] of [[0, lo], [0.5, price], [1, hi]]) {
    const t = el('text', { x: Math.min(W - 30, Math.max(24, frac * W)), y: H - 6, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 10 });
    t.textContent = fmtPrice(val);
    svg.appendChild(t);
  }
  wrap.appendChild(svg);
  return wrap;
}
