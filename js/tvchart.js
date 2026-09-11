// =============================================================================
// TVCHART — TradingView Lightweight Charts for price series.
//
// Hand-drawn SVG is right for donuts, bars and distributions; it is the wrong
// tool for a price chart, where people expect candles, a real time axis, zoom
// and a crosshair that reads values. This is the library that does that, it is
// Apache-2.0, and it is ~190 KB — so it loads only when a price chart is
// actually shown, not on every visit.
//
// Data comes from pool state deltas, not a trade index: every swap rewrites the
// pool row, so consecutive rows carry both the price path and the volume.
// =============================================================================

const CDN = 'https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/+esm';
let lib = null;

async function load() {
  if (!lib) lib = await import(CDN);
  return lib;
}

const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// A canvas cannot read CSS. Callers pass theme colours as `var(--c1)`, which
// SVG understands and a canvas rejects — and appending '44' for the area fill
// made 'var(--c1)44', which throws inside the library, so every line chart on
// the overview, the token pages and the market pages drew nothing at all in a
// real browser. Resolve the variable, then express opacity as rgba().
function solid(c, fallback) {
  const m = /^var\((--[\w-]+)\)$/.exec(String(c || '').trim());
  return (m ? cssVar(m[1]) : c) || fallback;
}
function alpha(c, a) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (!hex) return c;
  const h = hex[1].length === 3 ? [...hex[1]].map(x => x + x).join('') : hex[1];
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Read the theme rather than hard-coding: a rebrand must restyle the price
// chart too, and the token set is the single source for that.
function themeOptions() {
  return {
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: cssVar('--muted') || '#888',
      fontFamily: cssVar('--font-data') || 'monospace',
      fontSize: 10,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: cssVar('--line') || '#222' },
      horzLines: { color: cssVar('--line') || '#222' },
    },
    rightPriceScale: { borderColor: cssVar('--line') || '#222' },
    timeScale: { borderColor: cssVar('--line') || '#222', timeVisible: true, secondsVisible: false },
    crosshair: {
      mode: 0,
      vertLine: { color: cssVar('--line-2'), width: 1, style: 2, labelBackgroundColor: cssVar('--accent') },
      horzLine: { color: cssVar('--line-2'), width: 1, style: 2, labelBackgroundColor: cssVar('--accent') },
    },
    handleScale: { axisPressedMouseMove: { time: true, price: false } },
    // Deliberately NOT autoSize. That option installs the library's own
    // ResizeObserver, and an exception thrown inside it belongs to a script
    // from another origin: it escapes every .catch() around the mount, reaches
    // window.onerror as a bare "Script error." with no file and no line, and
    // the boot banner then tells the reader the WAX nodes are rate-limiting
    // them. Sizing happens below instead, in code we can wrap.
  };
}

// Every chart on a container replaces whatever was there before.
//
// Redrawing used to leak: switching the interval on the front page calls the
// mount again, which clears the container's HTML but leaves the previous chart
// object alive with an observer still watching a node that is no longer in the
// document. A session spent clicking through intervals accumulates them, and
// each one is a live callback inside third-party code.
const mounted = new WeakMap();

function mount(container, createChart, options, height) {
  const prev = mounted.get(container);
  if (prev) { try { prev.chart.remove(); } catch {} try { prev.stop(); } catch {} }

  container.innerHTML = '';
  container.style.height = height + 'px';
  const width = Math.max(0, container.clientWidth || container.getBoundingClientRect().width || 0);
  const chart = createChart(container, { ...options, width: width || undefined, height });

  // Our own observer, so a throw here is ours to catch. It also stops itself
  // once the container leaves the document, which is what the leak above was.
  let ro = null;
  const stop = () => { try { ro?.disconnect(); } catch {} ro = null; };
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      try {
        if (!container.isConnected) { stop(); return; }
        const w = container.clientWidth;
        if (w > 0) chart.applyOptions({ width: w, height });
      } catch { stop(); }
    });
    try { ro.observe(container); } catch { stop(); }
  }

  mounted.set(container, { chart, stop });
  return { chart, stop };
}

// candles: [{time, open, high, low, close, volume}] with time in SECONDS.
export async function candleChart(container, candles, { height = 320, precision = 6, fmt = null, visible = 0 } = {}) {
  const { createChart, CandlestickSeries, HistogramSeries } = await load();
  const { chart, stop } = mount(container, createChart, themeOptions(), height);
  const up = solid('var(--good)', '#44cc99');
  const down = solid('var(--bad)', '#cc5544');

  const price = chart.addSeries(CandlestickSeries, {
    upColor: up, downColor: down, borderUpColor: up, borderDownColor: down,
    wickUpColor: up, wickDownColor: down,
    // A custom formatter where one is given, so the axis reads $0.0₆771 like
    // the rest of the page instead of 0.00000077 or 7.7e-7.
    priceFormat: fmt ? { type: 'custom', formatter: fmt, minMove: 10 ** -precision } : { type: 'price', precision, minMove: 10 ** -precision },
  });
  price.setData(candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));

  // Volume shares the pane but gets its own scale pinned to the bottom third —
  // a second price axis would be a dual-axis chart, which is a different and
  // much worse thing.
  if (candles.some(c => c.volume > 0)) {
    const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    vol.setData(candles.map(c => ({
      time: c.time, value: c.volume,
      color: alpha(c.close >= c.open ? up : down, 0.33),
    })));
  }

  if (visible && candles.length > visible) {
    chart.timeScale().setVisibleLogicalRange({ from: candles.length - visible, to: candles.length + 2 });
  } else chart.timeScale().fitContent();
  return {
    chart,
    destroy: () => { stop(); try { chart.remove(); } catch {} },
    retheme: () => chart.applyOptions(themeOptions()),
  };
}

// Bucketed volume on a real time axis. Hand-drawn columns were honest about
// the bucket being the unit but gave two x labels and no crosshair; this is a
// time series, and a time series wants zoom and a readable value under the
// cursor like the price chart above it.
export async function histogramChart(container, points, { height = 170, color = null, fmt = null } = {}) {
  const { createChart, HistogramSeries } = await load();
  const { chart, stop } = mount(container, createChart, {
    ...themeOptions(),
    // Volume has a floor of zero and no meaningful sub-cent detail, so the
    // price scale is formatted as money rather than as a quote.
    localization: fmt ? { priceFormatter: fmt } : undefined,
  }, height);
  const c = solid(color || 'var(--c2)', '#3987e5');
  const s = chart.addSeries(HistogramSeries, { color: c, priceFormat: { type: 'volume' } });
  s.setData(points.map(p => ({ time: p.time, value: p.value })));
  chart.timeScale().fitContent();
  return { chart, destroy: () => { stop(); try { chart.remove(); } catch {} }, retheme: () => chart.applyOptions(themeOptions()) };
}

// A single line, for series that have no open/high/low — an account balance, a
// TVL history, an APR over time.
export async function lineSeriesChart(container, points, { height = 240, color = null, precision = 4, fmt = null } = {}) {
  const { createChart, AreaSeries } = await load();
  const { chart, stop } = mount(container, createChart,
    { ...themeOptions(), localization: fmt ? { priceFormatter: fmt } : undefined }, height);
  const c = solid(color || 'var(--c1)', '#3987e5');
  const s = chart.addSeries(AreaSeries, {
    lineColor: c, topColor: alpha(c, 0.27), bottomColor: alpha(c, 0.02), lineWidth: 2,
    priceFormat: { type: 'price', precision, minMove: 10 ** -precision },
  });
  s.setData(points.map(p => ({ time: p.time, value: p.value })));
  chart.timeScale().fitContent();
  return { chart, destroy: () => { stop(); try { chart.remove(); } catch {} }, retheme: () => chart.applyOptions(themeOptions()) };
}
