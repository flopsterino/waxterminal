// =============================================================================
// LOGOS — vendor the token marks into the repo, once, in CI.
//
// Where they come from, after a long hunt: Alcor's frontend resolves a logo with
//   $tokenLogo(symbol, contract) -> require(`./wax/${symbol.toLowerCase()}_${contract}.png`)
// and falls back to the eoscafe registry. Those bundled files live in their
// open-source UI repo, so the whole set — 944 WAX tokens — is addressable at a
// stable path. The community registry adds a few dozen more.
//
// They are copied here rather than hotlinked. raw.githubusercontent.com is a
// source host, not a CDN: fetching a few hundred images per page load makes
// someone else's rate limit our problem, for files that change twice a year.
// =============================================================================

import { writeFile, mkdir, readdir } from 'node:fs/promises';

const ALCOR_TREE = 'https://api.github.com/repos/alcorexchange/alcor-ui/git/trees/master?recursive=1';
const ALCOR_RAW = 'https://raw.githubusercontent.com/alcorexchange/alcor-ui/master/';
const REGISTRY = 'https://raw.githubusercontent.com/eoscafe/eos-airdrops/master/tokens.json';
const OUT = new URL('../data/logos/', import.meta.url);
const MAX_BYTES = 400_000;

await mkdir(OUT, { recursive: true });
const existing = new Set(await readdir(OUT).catch(() => []));
const manifest = {};
const wanted = new Map();          // 'SYM@contract' -> source url

// --- Alcor's set: assets/tokens/wax/{symbol}_{contract}.png ------------------
try {
  const tree = await (await fetch(ALCOR_TREE, { signal: AbortSignal.timeout(40000) })).json();
  const files = (tree.tree || []).filter(x => x.path.startsWith('assets/tokens/wax/'));
  for (const f of files) {
    const name = f.path.split('/').pop();
    const m = name.match(/^(.+?)_(.+)\.(png|jpg|jpeg|svg|webp|gif)$/i);
    if (!m) continue;                                  // a few stray files do not follow it
    const [, sym, contract] = m;
    wanted.set(`${sym.toUpperCase()}@${contract}`, ALCOR_RAW + f.path);
  }
  console.log(`alcor-ui lists ${wanted.size} WAX token logos`);
} catch (e) { console.log('alcor logo index unavailable:', e.message); }

// --- community registry, for anything Alcor does not carry -------------------
try {
  const all = await (await fetch(REGISTRY, { signal: AbortSignal.timeout(30000) })).json();
  let added = 0;
  for (const t of all) {
    if (t.chain !== 'wax' || !t.logo) continue;
    const key = `${t.symbol}@${t.account}`;
    if (!wanted.has(key)) { wanted.set(key, t.logo); added++; }
  }
  console.log(`registry adds ${added} more`);
} catch (e) { console.log('registry unavailable:', e.message); }

// --- fetch, skipping what is already here ------------------------------------
let fetched = 0, skipped = 0, failed = 0;
const entries = [...wanted.entries()];
const BATCH = 12;

for (let i = 0; i < entries.length; i += BATCH) {
  await Promise.all(entries.slice(i, i + BATCH).map(async ([key, url]) => {
    const ext = (url.match(/\.(png|jpg|jpeg|svg|webp|gif)(\?|$)/i)?.[1] || 'png').toLowerCase();
    const [sym, contract] = key.split('@');
    const file = `${contract}-${sym}.${ext}`.replace(/[^\w.@-]/g, '_');
    manifest[key] = file;
    if (existing.has(file)) { skipped++; return; }
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) { failed++; delete manifest[key]; return; }
      const buf = Buffer.from(await r.arrayBuffer());
      // A "logo" that is really an HTML error page helps nobody.
      if (buf.length < 64 || buf.length > MAX_BYTES) { failed++; delete manifest[key]; return; }
      await writeFile(new URL(file, OUT), buf);
      fetched++;
    } catch { failed++; delete manifest[key]; }
  }));
  if (i % 240 === 0) console.log(`  ${Math.min(i + BATCH, entries.length)}/${entries.length}`);
}

await writeFile(new URL('manifest.json', OUT), JSON.stringify(manifest));
console.log(`logos: ${fetched} fetched, ${skipped} already present, ${failed} failed, ${Object.keys(manifest).length} in manifest`);
