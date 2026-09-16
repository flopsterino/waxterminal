// =============================================================================
// PROXIES — the list a voter picks from.
//
// Nobody types a proxy's account name from memory, so the wallet offers a list.
// regproxyinfo holds what proxies say about themselves (182 entries today), but
// registering there does not make an account a proxy, and plenty of entries are
// wallets that never voted for anyone. Whether an account IS a proxy, whether it
// votes, and how much stake already follows it are in eosio's voters table —
// one row per owner. That is a couple of hundred reads, once a day here rather
// than in every visitor's browser.
// =============================================================================

import { writeFile } from 'node:fs/promises';
import { getRows, getAllRows } from '../js/chain.js';

const OUT = new URL('../data/proxies.json', import.meta.url);
const LIMIT = Number(process.env.PROXY_LIMIT || 0) || Infinity;   // for a small local check

const info = (await getAllRows('regproxyinfo', 'regproxyinfo', 'proxies')).slice(0, LIMIT);
console.log(`regproxyinfo: ${info.length} entries`);

const out = [];
for (const p of info) {
  let row = null;
  try {
    const d = await getRows('eosio', 'eosio', 'voters', { limit: 1, lower: p.owner });
    row = d.rows?.[0]?.owner === p.owner ? d.rows[0] : null;
  } catch { continue; }
  // A proxy that votes for nobody passes nothing on: its voters earn nothing.
  if (!row || !Number(row.is_proxy) || !(row.producers || []).length) continue;
  const clean = v => String(v || '').trim().slice(0, 140);
  out.push({
    owner: p.owner,
    name: clean(p.name) || p.owner,
    slogan: clean(p.slogan),
    website: /^https?:\/\//.test(p.website || '') ? clean(p.website) : '',
    logo: /^https:\/\//.test(p.logo_256 || '') ? clean(p.logo_256) : '',
    producers: row.producers.length,
    // Vote weight is stake scaled by the time it was cast, so it ranks proxies
    // but is not a WAX figure; it is published as a share of the largest.
    weight: Number(row.proxied_vote_weight) || 0,
  });
}
out.sort((a, b) => b.weight - a.weight);
const top = out[0]?.weight || 1;
for (const p of out) p.share = +(p.weight / top).toFixed(4);
for (const p of out) delete p.weight;

await writeFile(OUT, JSON.stringify({ at: new Date().toISOString(), proxies: out }));
console.log(`proxies.json: ${out.length} voting proxies`);
