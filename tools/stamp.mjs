// =============================================================================
// STAMP — give every deploy its own URLs.
//
// GitHub Pages serves with `cache-control: max-age=600`, so for ten minutes
// after a push a returning visitor gets the previous app.js. That is not a
// cosmetic delay: a fix can be live on the server, verified, and still absent
// from the browser of the person who reported the bug — which reads exactly
// like the fix never happened.
//
// A query string cannot be inherited: `import './store.js'` inside
// `app.js?v=abc` resolves to `js/store.js`, no query, cached. So every relative
// import has to be stamped too, or the entry point is fresh and everything it
// pulls in is stale — the worst of the two states, because the halves disagree.
//
// Run at deploy time against a checkout. The repo itself stays unstamped.
// =============================================================================

import { readFile, writeFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const v = (process.argv[2] || String(Date.now())).slice(0, 12);

// Relative specifiers only. A CDN import is versioned by its own URL and must
// not be touched.
const REL = /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"?]+\.js)\2/g;

const files = (await readdir(new URL('js/', root))).filter(f => f.endsWith('.js'));
let imports = 0;
for (const f of files) {
  const u = new URL(`js/${f}`, root);
  const src = await readFile(u, 'utf8');
  const out = src.replace(REL, (_m, head, q, spec) => { imports++; return `${head}${q}${spec}?v=${v}${q}`; });
  if (out !== src) await writeFile(u, out);
}

const idx = new URL('index.html', root);
let html = await readFile(idx, 'utf8');
const before = html;
html = html
  .replace(/(href=")(app\.css)(")/g, `$1$2?v=${v}$3`)
  .replace(/(src=")(js\/app\.js)(")/g, `$1$2?v=${v}$3`);
await writeFile(idx, html);

// The service worker names its cache after the build, so a new deploy drops
// the previous one's code instead of serving it next to the new.
const swUrl = new URL('sw.js', root);
try { const sw = await readFile(swUrl, 'utf8'); await writeFile(swUrl, sw.replace(/__BUILD__/g, v)); } catch { /* no worker in this build */ }

console.log(`stamped v=${v}: ${imports} imports across ${files.length} modules, index.html ${html !== before ? 'updated' : 'UNCHANGED — check the selectors'}`);
