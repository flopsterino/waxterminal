// =============================================================================
// BOT DATA — the slice of the snapshot the Telegram bot reads.
//
// The bot is a Cloudflare Worker on the Free plan: a few milliseconds of CPU
// per run. pools.json is a megabyte; parsing it there would spend the whole
// allowance on one file. So this writes the part the bot needs — every priced
// token with its 24h move, liquidity and volume, the pools worth naming, the
// live farms — as small arrays, after every snapshot and every volume refresh.
//
//   t  [id, usd, change24 %, liquidity $, volume24 $]
//   p  [dex, id, symA, symB, idA, idB, feeBps, tvl $, volume24 $]
//   f  [farmId, dex, poolDex, poolId, rewardSymbol, apr %, ends ms, $/day, staked $]
// =============================================================================

import { readFile, writeFile } from 'node:fs/promises';

const DIR = new URL('../data/', import.meta.url);
const snap = JSON.parse(await readFile(new URL('pools.json', DIR), 'utf8'));
let vol = {};
try { vol = JSON.parse(await readFile(new URL('volume.json', DIR), 'utf8')); } catch { /* volume is optional */ }
const r = (v, d = 2) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const sig = v => (v == null || !isFinite(v) ? null : Number(v.toPrecision(6)));

// Volume from the hourly file when it has the pool, the snapshot's otherwise.
const vol24 = p => vol?.[p.d]?.[p.i]?.[0] ?? p.v1 ?? 0;
const prev = new Map((snap.prevPrices || []).map(x => [x[0], x[1]]));

const liq = new Map(), tv = new Map();
for (const p of snap.pools) {
  const real = p.vr ?? p.v ?? 0, v = vol24(p);
  for (const id of [p.ca, p.cb]) {
    liq.set(id, (liq.get(id) || 0) + real / 2);
    tv.set(id, (tv.get(id) || 0) + v);
  }
}

const t = snap.prices.map(([id, usd]) => {
  const was = prev.get(id);
  return [id, sig(usd), was > 0 ? r((usd / was - 1) * 100, 1) : null, r(liq.get(id) || 0, 0), r(tv.get(id) || 0, 0)];
}).filter(x => x[1] > 0).sort((a, b) => b[3] - a[3]);

const p = snap.pools.filter(x => (x.vr ?? x.v ?? 0) >= 20 || vol24(x) >= 20)
  .map(x => [x.d, String(x.i), x.a, x.b, x.ca, x.cb, x.f, r(x.vr ?? x.v ?? 0, 0), r(vol24(x), 0)])
  .sort((a, b) => b[7] - a[7]);

const now = Date.now();
const f = snap.farms.filter(x => x.pf > now && (x.ru ?? 0) >= 0.02)
  .map(x => [String(x.i), x.d, x.pd, String(x.pi), x.rs, r(x.ar ?? x.ap, 1), x.pf, r(x.ru, 2), r(x.sr ?? x.su, 0)])
  .sort((a, b) => (b[5] ?? 0) - (a[5] ?? 0));

const out = { at: snap.at, vat: vol.at || null, wax: snap.waxUsd, t, p, f };
await writeFile(new URL('bot.json', DIR), JSON.stringify(out));
console.log(`bot.json — ${t.length} tokens, ${p.length} pools, ${f.length} farms, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
