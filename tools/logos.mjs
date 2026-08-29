// =============================================================================
// LOGOS — vendor the token marks into the repo, once, in CI.
//
// The community registry lives on raw.githubusercontent.com, which is a source
// host, not a CDN: hotlinking a few hundred images from every page load is slow,
// rate-limited, and a dependency on someone else's uptime for something that
// changes maybe twice a year. Fetch them in the daily job instead and serve them
// from our own Pages site.
// =============================================================================

import { writeFile, mkdir, readdir } from 'node:fs/promises';

const REG = 'https://raw.githubusercontent.com/eoscafe/eos-airdrops/master/tokens.json';
const OUT = new URL('../data/logos/', import.meta.url);

await mkdir(OUT, { recursive: true });
const existing = new Set(await readdir(OUT).catch(() => []));

const all = await (await fetch(REG)).json();
const wax = all.filter(t => t.chain === 'wax' && t.logo);
console.log(`registry lists ${wax.length} WAX tokens with a logo`);

const manifest = {};
let fetched = 0, skipped = 0, failed = 0;

for (const t of wax) {
  const key = `${t.symbol}@${t.account}`;
  const ext = (t.logo.match(/\.(png|jpg|jpeg|gif|svg|webp)(\?|$)/i)?.[1] || 'png').toLowerCase();
  const file = `${t.account}-${t.symbol}.${ext}`.replace(/[^\w.@-]/g, '_');
  manifest[key] = file;
  if (existing.has(file)) { skipped++; continue; }
  try {
    const r = await fetch(t.logo, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) { failed++; delete manifest[key]; continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    // A "logo" that is really an HTML error page helps nobody.
    if (buf.length < 64 || buf.length > 400_000) { failed++; delete manifest[key]; continue; }
    await writeFile(new URL(file, OUT), buf);
    fetched++;
  } catch { failed++; delete manifest[key]; }
}

await writeFile(new URL('manifest.json', OUT), JSON.stringify(manifest));
console.log(`logos: ${fetched} fetched, ${skipped} already present, ${failed} failed, ${Object.keys(manifest).length} in manifest`);
