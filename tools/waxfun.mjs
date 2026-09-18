// =============================================================================
// WAX.FUN — the curves, their supplies, and therefore their prices.
//
// A token's price on wax.fun is a function of its supply, and supply lives in a
// table scoped per symbol: one read per token. That is 255 reads, which belongs
// in a daily job rather than in every visitor's browser — the page then draws
// prices, market caps and progress instantly and re-reads only the one token
// somebody opens.
//
// The curve itself is derived in js/legacy.js; see the comment there for how it
// was established against real trades.
// =============================================================================

import { writeFile } from 'node:fs/promises';
import { getRows, getAllRows } from '../js/chain.js';
import { CURVE_T, DEX_GOAL_TOKENS, curvePrice } from '../js/legacy.js';

const OUT = new URL('../data/waxfun.json', import.meta.url);
const CURVE = 'main.waxfun';
const SCOPES = ['alpha.waxfun', 'beta.waxfun'];
const amt = q => parseFloat(String(q || '').split(' ')[0]) || 0;

const out = [];
for (const scope of SCOPES) {
  let curves = [];
  try { curves = await getAllRows(CURVE, scope, 'tkncrv'); } catch { continue; }
  console.log(`${scope}: ${curves.length} curves`);
  for (const c of curves) {
    let supply = null, decimals = 8;
    try {
      const d = await getRows(scope, c.sym_code, 'stat', { limit: 1 });
      const r = d.rows?.[0];
      if (r) {
        supply = amt(r.supply);
        decimals = (String(r.supply).split(' ')[0].split('.')[1] || '').length;
      }
    } catch { /* one unreadable token must not void the file */ }
    const cfg = Number(c.curve_config) || 0;
    out.push({
      sym: c.sym_code, contract: scope, state: String(c.state || '').toUpperCase(),
      cfg, reserved: amt(c.reserved_wax), supply, decimals,
      price: supply != null ? curvePrice(supply, cfg) : null,
      progress: supply != null ? Math.min(1, supply / DEX_GOAL_TOKENS) : null,
    });
  }
}
out.sort((a, b) => (b.price || 0) * (b.supply || 0) - (a.price || 0) * (a.supply || 0));
await writeFile(OUT, JSON.stringify({ at: new Date().toISOString(), virtualTokens: CURVE_T, tokens: out }));
console.log(`waxfun.json: ${out.length} tokens, ${out.filter(t => t.supply != null).length} with a supply`);
