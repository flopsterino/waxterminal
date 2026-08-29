// =============================================================================
// TOKENS — identity and second opinions.
//
// People recognise tokens by their mark, not by a ticker in a table. WAX has no
// on-chain logo registry, and the one community list that covers it reaches 218
// tokens — 37 of the 223 this terminal prices. So: a real logo where one exists,
// and a deterministic generated mark everywhere else. Never a broken image, and
// never a blank where a token should be.
//
// The same fetch also brings back Alcor's own view of each token: a score, a
// trusted flag, and a `safe_usd_price` they set to zero when they will not
// stand behind a quote. That is an independent check on this terminal's own
// depth analysis — where the two disagree, the UI says so rather than picking a
// winner silently.
// =============================================================================

// Logos are vendored into the repo by tools/logos.mjs and served from our own
// site: raw.githubusercontent.com is a source host, not a CDN, and hotlinking a
// few hundred images per page load makes someone else's rate limit our problem.
const LOGO_MANIFEST = 'data/logos/manifest.json';
const LOGO_DIR = 'data/logos/';
const ALCOR_TOKENS = 'https://wax.alcor.exchange/api/v2/tokens';

const logos = new Map();       // 'SYM@contract' -> url
const meta = new Map();        // 'SYM@contract' -> { score, trusted, scam, safeUsd, usd }
let loaded = null;

export async function loadTokenMeta() {
  if (loaded) return loaded;
  loaded = (async () => {
    const [man, alc] = await Promise.all([
      fetch(LOGO_MANIFEST).then(r => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(ALCOR_TOKENS).then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    for (const [id, file] of Object.entries(man)) logos.set(id, LOGO_DIR + file);
    for (const t of alc) {
      meta.set(`${t.symbol}@${t.contract}`, {
        score: t.score ?? null,
        trusted: !!t.is_trusted,
        scam: !!t.is_scam,
        safeUsd: t.safe_usd_price ?? null,
        usd: t.usd_price ?? null,
      });
    }
    return { logos: logos.size, meta: meta.size };
  })();
  return loaded;
}

export const tokenMeta = id => meta.get(id) || null;
export const tokenLogo = id => logos.get(id) || null;

// Deterministic identity colour. This encodes nothing but "which token", so a
// wide hue wheel is correct here — unlike a chart series, where hue carries
// meaning and the palette is fixed and validated.
function hue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

// Returns an element, always. `size` in px.
export function tokenMark(id, symbol, { size = 18 } = {}) {
  const url = logos.get(id);
  if (url) {
    const img = document.createElement('img');
    img.className = 'tokmark';
    img.src = url; img.alt = ''; img.loading = 'lazy';
    img.style.cssText = `width:${size}px;height:${size}px`;
    // A dead logo URL must degrade to the generated mark, not to a broken icon.
    img.onerror = () => img.replaceWith(generated(id, symbol, size));
    return img;
  }
  return generated(id, symbol, size);
}

function generated(id, symbol, size) {
  const d = document.createElement('span');
  d.className = 'tokmark gen';
  const h = hue(id);
  d.style.cssText = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;`
    + `background:oklch(0.62 0.13 ${h});color:oklch(0.16 0.03 ${h})`;
  d.textContent = (symbol || '?').slice(0, 2).toUpperCase();
  d.title = symbol || id;
  return d;
}

// A pair reads as one object, so overlap the two marks slightly.
export function pairMark(tokenA, symA, tokenB, symB, { size = 18 } = {}) {
  const w = document.createElement('span');
  w.className = 'pairmark';
  const a = tokenMark(tokenA, symA, { size });
  const b = tokenMark(tokenB, symB, { size });
  b.style.marginLeft = `-${Math.round(size * 0.32)}px`;
  w.append(a, b);
  return w;
}
