// =============================================================================
// SHARE CARDS — a result, drawn as a picture someone can post.
//
// Everything happens in the browser: a 1200x630 canvas (the size Telegram and
// X preview best), the brand's own mark and mouse, the figures the page is
// already showing. On a phone the system share sheet takes the file straight
// into a chat; on a desktop it downloads.
//
// The account name is off by default. A wallet name next to a profit figure is
// an address for anyone who wants to look at the rest of that wallet, and the
// person sharing should choose that, not find it out afterwards.
// =============================================================================

const W = 1200, H = 630;
const INK = '#F2F4F6', MUTED = '#8A96A0', GOLD = '#F5B335', GOOD = '#2EBD85', BAD = '#F6465D';

const imgCache = new Map();
function loadImg(src) {
  if (!src) return Promise.resolve(null);
  if (!imgCache.has(src)) {
    imgCache.set(src, new Promise(res => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => res(im);
      im.onerror = () => res(null);
      im.src = src;
    }));
  }
  return imgCache.get(src);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Text that has to fit a width: the size steps down until it does.
function fitText(ctx, text, maxW, size, weight = 800) {
  let s = size;
  for (; s > 18; s -= 2) {
    ctx.font = `${weight} ${s}px Inter, system-ui, sans-serif`;
    if (ctx.measureText(text).width <= maxW) break;
  }
  return s;
}

/**
 * spec: {
 *   title     'CHEESE / WAXUSDC'
 *   kicker    'Alcor position · since 2026-08-16'
 *   big       '+$109.56'          the figure the card is about
 *   bigTone   'good' | 'bad' | null
 *   bigSub    '+12.7% on what went in'
 *   stats     [['Value', '$954.11'], ['Paid / day', '$0.50'], …]  up to four
 *   logos     [url, url]          token marks, drawn overlapping
 *   account   'qu.ug.wam' | null  only drawn when the sharer asked for it
 * }
 */
export async function drawShareCard(spec) {
  if (document.fonts?.ready) await document.fonts.ready.catch(() => {});
  const [mark, mouse, ...logos] = await Promise.all([
    loadImg('brand/mark.svg'), loadImg('brand/mascot.svg'), ...(spec.logos || []).map(loadImg),
  ]);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // Ground: the site's near-black with the black hole's warm glow behind the mouse.
  ctx.fillStyle = '#0B0E11';
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.84, H * 0.62, 20, W * 0.84, H * 0.62, 460);
  glow.addColorStop(0, 'rgba(120,70,8,0.55)');
  glow.addColorStop(1, 'rgba(11,14,17,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  if (mouse) ctx.drawImage(mouse, W - 400, H - 385, 380, 347);

  // Brand, top left.
  const pad = 64;
  if (mark) ctx.drawImage(mark, pad, 50, 64, 64);
  ctx.textBaseline = 'alphabetic';
  ctx.font = '800 40px Inter, system-ui, sans-serif';
  let x = pad + 80;
  for (const [t, em] of [['W', true], ['ax', false], ['EDGE', true]]) {
    ctx.font = `${em ? 800 : 600} 40px Inter, system-ui, sans-serif`;
    ctx.fillStyle = em ? INK : '#6C7883';
    ctx.fillText(t, x, 96);
    x += ctx.measureText(t).width;
  }

  // What this card is about.
  let y = 190;
  if (logos.filter(Boolean).length) {
    let lx = pad;
    for (const im of logos) {
      if (!im) continue;
      ctx.save();
      ctx.beginPath(); ctx.arc(lx + 26, y - 18, 26, 0, Math.PI * 2); ctx.closePath();
      ctx.fillStyle = '#1B2228'; ctx.fill();
      ctx.clip();
      ctx.drawImage(im, lx, y - 44, 52, 52);
      ctx.restore();
      lx += 40;
    }
    x = lx + 24;
  } else x = pad;
  const titleSize = fitText(ctx, spec.title || '', W - 480 - x, 44, 800);
  ctx.fillStyle = INK;
  ctx.font = `800 ${titleSize}px Inter, system-ui, sans-serif`;
  ctx.fillText(spec.title || '', x, y);
  if (spec.kicker) {
    ctx.font = '500 24px Inter, system-ui, sans-serif';
    ctx.fillStyle = MUTED;
    ctx.fillText(spec.kicker, pad, y + 44);
  }

  // The number.
  y = 360;
  const bigSize = fitText(ctx, spec.big || '', W - 480 - pad, 104, 800);
  ctx.font = `800 ${bigSize}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = spec.bigTone === 'good' ? GOOD : spec.bigTone === 'bad' ? BAD : INK;
  ctx.fillText(spec.big || '', pad, y);
  if (spec.bigSub) {
    ctx.font = '600 28px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#C9D1D8';
    ctx.fillText(spec.bigSub, pad, y + 46);
  }

  // Up to four supporting figures, as small tiles.
  const stats = (spec.stats || []).slice(0, 4);
  const tileW = 168, tileH = 86, gap = 14;
  stats.forEach(([k, v], i) => {
    const tx = pad + i * (tileW + gap), ty = 462;
    roundRect(ctx, tx, ty, tileW, tileH, 14);
    ctx.fillStyle = 'rgba(23,29,34,0.92)'; ctx.fill();
    ctx.strokeStyle = '#2E3840'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.font = '600 16px Inter, system-ui, sans-serif'; ctx.fillStyle = MUTED;
    ctx.fillText(String(k).toUpperCase(), tx + 16, ty + 30);
    const vs = fitText(ctx, String(v), tileW - 32, 28, 700);
    ctx.font = `700 ${vs}px Inter, system-ui, sans-serif`; ctx.fillStyle = INK;
    ctx.fillText(String(v), tx + 16, ty + 66);
  });

  // Footer: where to see your own.
  ctx.font = '700 22px Inter, system-ui, sans-serif';
  const foot = 'waxedge.app';
  const fw = ctx.measureText(foot).width + 36;
  roundRect(ctx, pad, H - 64, fw, 40, 20);
  ctx.fillStyle = GOLD; ctx.fill();
  ctx.fillStyle = '#0B0E11';
  ctx.fillText(foot, pad + 18, H - 37);
  if (spec.account) {
    ctx.font = '500 20px Inter, system-ui, sans-serif';
    ctx.fillStyle = MUTED;
    ctx.fillText(spec.account, pad + fw + 18, H - 37);
  }

  return new Promise(res => cv.toBlob(b => res(b), 'image/png'));
}

// Hand a finished card to the system share sheet where there is one that takes
// files (phones), and download it everywhere else.
export async function shareOrSave(blob, { filename = 'waxedge.png', text = '' } = {}) {
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text }); return 'shared'; }
    catch (e) { if (e?.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'saved';
}

// ---- market cards: a token or a pair, with its chart -------------------------
// The same 1200x630 frame, drawn for a market instead of a result: the price,
// how it moved, a candle chart in the TradingView manner (green up, red down,
// the price scale on the right), and four figures underneath.
function fmtAxis(v) {
  if (!(v > 0)) return '0';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1) return v.toFixed(v >= 100 ? 1 : 3);
  const d = Math.min(12, 2 - Math.floor(Math.log10(v)) + 1);
  return v.toFixed(d).replace(/(\.\d*?[1-9])0+$/, '$1');
}
function drawCandles(ctx, candles, x, y, w, h) {
  const n = candles.length;
  if (n < 2) return;
  let lo = Infinity, hi = -Infinity;
  for (const c of candles) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
  const padV = (hi - lo) * 0.08 || hi * 0.02;
  lo -= padV; hi += padV;
  const axisW = 104, cw = w - axisW;
  const Y = v => y + h - ((v - lo) / (hi - lo)) * h;
  // Grid and the price scale.
  ctx.font = '500 17px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = lo + (hi - lo) * (i / 4), yy = Y(v);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + cw, yy); ctx.stroke();
    ctx.fillStyle = MUTED; ctx.fillText(fmtAxis(v), x + cw + 12, yy);
  }
  const step = cw / n, body = Math.max(2, Math.min(18, step * 0.66));
  candles.forEach((c, i) => {
    const cx = x + step * (i + 0.5);
    const up = c.c >= c.o;
    ctx.strokeStyle = ctx.fillStyle = up ? GOOD : BAD;
    ctx.lineWidth = Math.max(1, body / 7);
    ctx.beginPath(); ctx.moveTo(cx, Y(c.h)); ctx.lineTo(cx, Y(c.l)); ctx.stroke();
    const top = Y(Math.max(c.o, c.c)), bot = Y(Math.min(c.o, c.c));
    ctx.fillRect(cx - body / 2, top, body, Math.max(1.5, bot - top));
  });
  // The last price, as TradingView marks it.
  const last = candles[n - 1].c, ly = Y(last);
  ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(245,179,53,0.7)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, ly); ctx.lineTo(x + cw, ly); ctx.stroke(); ctx.setLineDash([]);
  const tag = fmtAxis(last);
  ctx.font = '700 17px Inter, system-ui, sans-serif';
  const tw = ctx.measureText(tag).width + 14;
  roundRect(ctx, x + cw + 4, ly - 13, tw, 26, 5); ctx.fillStyle = GOLD; ctx.fill();
  ctx.fillStyle = '#0B0E11'; ctx.fillText(tag, x + cw + 11, ly);
  ctx.textBaseline = 'alphabetic';
}

/**
 * spec: {
 *   title 'CHEESE' | 'CHEESE / WAX', kicker 'cheeseburger · Alcor', logos [url],
 *   price '$0.00915', priceSub '1.34 WAX',
 *   changes [['24h', 7.3], ['7d', 13.6], ['30d', null]],
 *   candles [{o,h,l,c}], chartLabel '30 days · daily candles · USD',
 *   stats [['Market cap', '$192k'], …] up to four
 * }
 */
export async function drawMarketCard(spec) {
  if (document.fonts?.ready) await document.fonts.ready.catch(() => {});
  const [mark, ...logos] = await Promise.all([loadImg('brand/mark.svg'), ...(spec.logos || []).map(loadImg)]);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#0B0E11'; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.78, H * 0.35, 20, W * 0.78, H * 0.35, 520);
  glow.addColorStop(0, 'rgba(120,70,8,0.30)'); glow.addColorStop(1, 'rgba(11,14,17,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  const pad = 56;
  // Brand, top right, small: the market is the subject.
  if (mark) ctx.drawImage(mark, W - pad - 214, 40, 40, 40);
  let bx = W - pad - 164;
  for (const [t, em] of [['W', true], ['ax', false], ['EDGE', true]]) {
    ctx.font = `${em ? 800 : 600} 28px Inter, system-ui, sans-serif`;
    ctx.fillStyle = em ? INK : '#6C7883';
    ctx.fillText(t, bx, 70); bx += ctx.measureText(t).width;
  }

  // Title with its token marks.
  let x = pad;
  const ty = 78;
  for (const im of logos) {
    if (!im) continue;
    ctx.save(); ctx.beginPath(); ctx.arc(x + 24, ty - 16, 24, 0, Math.PI * 2); ctx.closePath();
    ctx.fillStyle = '#1B2228'; ctx.fill(); ctx.clip(); ctx.drawImage(im, x, ty - 40, 48, 48); ctx.restore();
    x += 36;
  }
  if (x > pad) x += 20;
  const ts = fitText(ctx, spec.title || '', 560 - x, 44, 800);
  ctx.font = `800 ${ts}px Inter, system-ui, sans-serif`; ctx.fillStyle = INK;
  ctx.fillText(spec.title || '', x, ty);
  if (spec.kicker) { ctx.font = '500 20px Inter, system-ui, sans-serif'; ctx.fillStyle = MUTED; ctx.fillText(spec.kicker, pad, ty + 34); }

  // Price and moves, left column.
  const ps = fitText(ctx, spec.price || '', 300, 64, 800);
  ctx.font = `800 ${ps}px Inter, system-ui, sans-serif`; ctx.fillStyle = INK;
  ctx.fillText(spec.price || '', pad, 200);
  if (spec.priceSub) { ctx.font = '600 24px Inter, system-ui, sans-serif'; ctx.fillStyle = '#C9D1D8'; ctx.fillText(spec.priceSub, pad, 238); }
  let cy = 282;
  for (const [k, v] of (spec.changes || []).filter(c => c[1] != null && isFinite(c[1]))) {
    roundRect(ctx, pad, cy, 300, 46, 12);
    ctx.fillStyle = 'rgba(23,29,34,0.92)'; ctx.fill();
    ctx.font = '600 18px Inter, system-ui, sans-serif'; ctx.fillStyle = MUTED; ctx.fillText(k, pad + 16, cy + 30);
    const s = `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
    ctx.font = '800 24px Inter, system-ui, sans-serif'; ctx.fillStyle = v >= 0 ? GOOD : BAD;
    ctx.fillText(s, pad + 284 - ctx.measureText(s).width, cy + 31);
    cy += 56;
  }

  // The chart, right.
  const chX = 420, chY = 132, chW = W - pad - chX, chH = 300;
  roundRect(ctx, chX - 12, chY - 16, chW + 24, chH + 52, 16);
  ctx.fillStyle = 'rgba(16,20,24,0.85)'; ctx.fill(); ctx.strokeStyle = '#222B32'; ctx.lineWidth = 1.5; ctx.stroke();
  if (spec.candles?.length >= 2) drawCandles(ctx, spec.candles, chX, chY, chW, chH);
  else { ctx.font = '500 20px Inter, system-ui, sans-serif'; ctx.fillStyle = MUTED; ctx.fillText('No chart for this market', chX + 20, chY + chH / 2); }
  if (spec.chartLabel) { ctx.font = '500 16px Inter, system-ui, sans-serif'; ctx.fillStyle = MUTED; ctx.fillText(spec.chartLabel, chX, chY + chH + 26); }

  // Four figures.
  const stats = (spec.stats || []).slice(0, 4);
  const gap = 14, tileW = (W - pad * 2 - gap * 3) / 4, tileH = 78, tyy = 484;
  stats.forEach(([k, v], i) => {
    const tx = pad + i * (tileW + gap);
    roundRect(ctx, tx, tyy, tileW, tileH, 14);
    ctx.fillStyle = 'rgba(23,29,34,0.92)'; ctx.fill(); ctx.strokeStyle = '#2E3840'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.font = '600 15px Inter, system-ui, sans-serif'; ctx.fillStyle = MUTED; ctx.fillText(String(k).toUpperCase(), tx + 16, tyy + 28);
    const vs = fitText(ctx, String(v), tileW - 32, 28, 700);
    ctx.font = `700 ${vs}px Inter, system-ui, sans-serif`; ctx.fillStyle = INK; ctx.fillText(String(v), tx + 16, tyy + 62);
  });

  ctx.font = '700 20px Inter, system-ui, sans-serif';
  const foot = 'waxedge.app', fw = ctx.measureText(foot).width + 32;
  roundRect(ctx, pad, H - 54, fw, 36, 18); ctx.fillStyle = GOLD; ctx.fill();
  ctx.fillStyle = '#0B0E11'; ctx.fillText(foot, pad + 16, H - 30);
  if (spec.footNote) { ctx.font = '500 16px Inter, system-ui, sans-serif'; ctx.fillStyle = MUTED; ctx.fillText(spec.footNote, pad + fw + 16, H - 30); }
  return new Promise(res => cv.toBlob(b => res(b), 'image/png'));
}

// Copy the picture itself, where the browser allows it.
export async function copyImage(blob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
  try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); return true; } catch { return false; }
}
