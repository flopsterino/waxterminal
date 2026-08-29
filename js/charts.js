// =============================================================================
// CHARTS — hand-drawn SVG. No chart library: every colour must resolve through
// the theme tokens so a rebrand restyles the charts too, and a static site
// should not pull 300 KB to draw a line.
// =============================================================================

const NS = 'http://www.w3.org/2000/svg';
const el = (n, attrs = {}) => { const e = document.createElementNS(NS, n); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

// Area+line series. Values are [{x:number, y:number}]; x is usually a timestamp.
export function lineChart(points, { width = 640, height = 170, pad = 28, color = 'var(--c1)', fmtY = v => v, fmtX = v => v } = {}) {
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', preserveAspectRatio: 'none' });
  if (!points.length) return svg;

  const xs = points.map(p => p.x), ys = points.map(p => p.y).filter(v => isFinite(v));
  if (!ys.length) return svg;
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= Math.abs(y0 || 1) * .05; y1 += Math.abs(y1 || 1) * .05; }
  const padY = (y1 - y0) * .1; y0 -= padY; y1 += padY;

  const X = v => pad + ((v - x0) / (x1 - x0 || 1)) * (width - pad - 8);
  const Y = v => height - pad - ((v - y0) / (y1 - y0 || 1)) * (height - pad - 12);

  // Horizontal guides, drawn first so the series sits on top of them.
  for (let i = 0; i <= 3; i++) {
    const v = y0 + (y1 - y0) * (i / 3);
    const y = Y(v);
    svg.appendChild(el('line', { x1: pad, x2: width - 8, y1: y, y2: y, stroke: 'var(--line)', 'stroke-width': 1 }));
    const t = el('text', { x: 3, y: y + 3.5, fill: 'var(--muted)', 'font-size': 9, 'font-family': 'var(--font-data)' });
    t.textContent = fmtY(v); svg.appendChild(t);
  }

  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const area = `${d}L${X(points.at(-1).x).toFixed(1)},${height - pad}L${X(points[0].x).toFixed(1)},${height - pad}Z`;

  const gid = 'g' + Math.random().toString(36).slice(2, 8);
  const defs = el('defs');
  const grad = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
  const s1 = el('stop', { offset: '0%',   'stop-color': color, 'stop-opacity': .28 });
  const s2 = el('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 });
  grad.append(s1, s2); defs.appendChild(grad); svg.appendChild(defs);

  svg.appendChild(el('path', { d: area, fill: `url(#${gid})` }));
  svg.appendChild(el('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  // Emphasise the last point: on a live feed that is the number people want.
  const last = points.at(-1);
  svg.appendChild(el('circle', { cx: X(last.x), cy: Y(last.y), r: 3, fill: color }));

  const lx = el('text', { x: pad, y: height - 6, fill: 'var(--muted)', 'font-size': 9, 'font-family': 'var(--font-data)' });
  lx.textContent = fmtX(x0); svg.appendChild(lx);
  const rx = el('text', { x: width - 8, y: height - 6, fill: 'var(--muted)', 'font-size': 9, 'font-family': 'var(--font-data)', 'text-anchor': 'end' });
  rx.textContent = fmtX(x1); svg.appendChild(rx);
  return svg;
}

// Donut for share-of-total. Slices beyond `top` collapse into "other" rather
// than producing an unreadable ring of slivers.
export function donut(items, { size = 168, thickness = 26, top = 7, fmt = v => v } = {}) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:16px;align-items:center;flex-wrap:wrap';
  const sorted = [...items].filter(i => i.value > 0).sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, top);
  const rest = sorted.slice(top).reduce((s, i) => s + i.value, 0);
  if (rest > 0) head.push({ label: `other (${sorted.length - top})`, value: rest });
  const total = head.reduce((s, i) => s + i.value, 0) || 1;

  const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size });
  const r = (size - thickness) / 2, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r;
  let offset = 0;
  head.forEach((it, i) => {
    const frac = it.value / total;
    const c = el('circle', {
      cx, cy, r, fill: 'none',
      stroke: `var(--c${(i % 8) + 1})`, 'stroke-width': thickness,
      'stroke-dasharray': `${(frac * C).toFixed(2)} ${C.toFixed(2)}`,
      'stroke-dashoffset': (-offset * C).toFixed(2),
      transform: `rotate(-90 ${cx} ${cy})`,
    });
    c.appendChild(el('title')).textContent = `${it.label}: ${fmt(it.value)}`;
    svg.appendChild(c);
    offset += frac;
  });
  wrap.appendChild(svg);

  const leg = document.createElement('div');
  leg.style.cssText = 'display:flex;flex-direction:column;gap:5px;font-size:12px;min-width:150px;flex:1';
  head.forEach((it, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:7px';
    row.innerHTML = `<span style="width:9px;height:9px;border-radius:2px;background:var(--c${(i % 8) + 1});flex:none"></span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${it.label}</span>
      <span class="mono dim">${fmt(it.value)}</span>`;
    leg.appendChild(row);
  });
  wrap.appendChild(leg);
  return wrap;
}

// Horizontal bars for ranked comparisons (volume by pool, rewards by farm).
export function bars(items, { fmt = v => v, max = null, color = 'var(--c1)' } = {}) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px';
  const top = max ?? Math.max(...items.map(i => i.value), 1);
  for (const it of items) {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:minmax(70px,1fr) 2fr auto;gap:9px;align-items:center;font-size:12px';
    row.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${it.label}</span>
      <span style="height:8px;background:var(--surface-3);border-radius:99px;overflow:hidden">
        <span style="display:block;height:100%;width:${(it.value / top * 100).toFixed(1)}%;background:${color};border-radius:99px"></span>
      </span>
      <span class="mono dim">${fmt(it.value)}</span>`;
    wrap.appendChild(row);
  }
  return wrap;
}

// A position's tick band with the market price marked on it. The one visual
// that makes concentrated liquidity legible at a glance.
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
