// =============================================================================
// VOLUME — the one number that cannot wait for tomorrow.
//
// Volume is a trailing 24-hour window, so it decays continuously: a figure
// written into the daily snapshot read 75% high against Alcor's own numbers a
// few hours later, pool for pool. Everything else on the page moves slowly
// enough for a daily job; this does not.
//
// So it gets its own file and its own hourly schedule. Small, cheap, and it
// leaves the snapshot free to stay daily for the history series.
// =============================================================================

import { writeFile, mkdir } from 'node:fs/promises';

const OUT = new URL('../data/', import.meta.url);
await mkdir(OUT, { recursive: true });

const r = await fetch('https://wax.alcor.exchange/api/v2/swap/pools', { signal: AbortSignal.timeout(60000) });
if (!r.ok) { console.error('alcor pools:', r.status); process.exit(1); }
const pools = await r.json();

const out = {};
let counted = 0, total = 0;
for (const p of pools) {
  const v1 = p.volumeUSD24 ?? 0;
  const v7 = p.volumeUSDWeek ?? 0;
  // A month, because a day is noise on a small token and a week still is. It is
  // the window that tells you whether something trades at all, as opposed to
  // whether it traded on Tuesday.
  const v30 = p.volumeUSDMonth ?? 0;
  const ch = p.change24 ?? null;
  const chw = p.changeWeek ?? null;
  if (!(v1 > 0) && !(v7 > 0) && !(v30 > 0)) continue;
  const r = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  out[String(p.id)] = [r(v1), r(v7), r(ch), r(v30), r(chw)];
  counted++; total += v1;
}

await writeFile(new URL('volume.json', OUT), JSON.stringify({ at: Date.now(), alcor: out }));
console.log(`volume: ${counted} Alcor pools, $${total.toFixed(0)} in 24h`);

if (counted < 100) { console.error('suspiciously few pools with volume'); process.exit(1); }
