// =============================================================================
// PRICE — the honest-APR problem.
//
// Live farms pay in GTAP, YEET, PURR and dozens more long-tail tokens with one
// thin pool each. An APR is only as good as the price behind it, so this refuses
// to invent one: a token whose deepest route is below MIN_DEPTH_USD gets no
// price, and the UI must then say "unpriceable" rather than print a fantasy.
//
// Validated 2026-08-29: the six deepest WAX/stable pools agree on WAX to within
// 1.1%, so the anchor itself is sound.
// =============================================================================

// Only genuinely bridged dollars are declared worth a dollar. Everything else
// that CALLS itself a stablecoin has to earn its price through the graph like
// any other token.
//
// This matters more than it sounds. Measured 2026-08-29: 997,731 PARAUSD sat in
// WAX pools, but the entire exit to a bridged stablecoin was $505. Declaring it
// $1 by fiat inflated the terminal's headline TVL by roughly half a million
// dollars of value nobody could realise. DSTUSD was worse: $4 of exit.
export const STABLES = new Set([
  'WAXUSDC@eth.token',
  'USDT@usdt.alcor',
]);

export const MIN_DEPTH_USD = 40;

// A price routed through less than this is real but not realisable at size, and
// anything resting on it is marked thin in the UI rather than quietly counted.
export const THIN_ROUTE_USD = 1000;

const ROUNDS = 5;      // one more hop now that the declared stables are gone

// pools: [{dex, id, tokenA, tokenB, reserveA, reserveB, priceAB}] where priceAB
// is token B per token A in human units. Returns Map id -> {usd, via, depth}.
export function computePrices(pools) {
  const price = new Map();
  for (const id of STABLES) price.set(id, { usd: 1, via: 'bridged', depth: Infinity, hops: 0 });

  for (let round = 0; round < ROUNDS; round++) {
    let changed = 0;
    for (const p of pools) {
      if (!(p.priceAB > 0) || !isFinite(p.priceAB)) continue;
      const A = price.get(p.tokenA), B = price.get(p.tokenB);

      // Depth is the BOTTLENECK of the whole route to a real dollar, not the
      // depth of the last hop. Getting this wrong is subtle and expensive: with
      // last-hop depth, PARAUSD priced itself at $1 through a pool holding 40k
      // of it and claimed $40,026 of backing, while the actual exit to a bridged
      // stablecoin was $505. A chain is only as strong as its thinnest link, so
      // carry the minimum forward.
      if (A && !STABLES.has(p.tokenB)) {
        const hop = p.reserveA * A.usd;                    // USD on the side we trust
        const depth = Math.min(A.depth, hop);
        const cur = price.get(p.tokenB);
        const usd = A.usd / p.priceAB;
        if (hop >= MIN_DEPTH_USD && usd > 0 && isFinite(usd) && (!cur || depth > cur.depth)) {
          price.set(p.tokenB, { usd, via: `${p.dex}:${p.id}`, depth, hops: (A.hops ?? 0) + 1 }); changed++;
        }
      }
      if (B && !STABLES.has(p.tokenA)) {
        const hop = p.reserveB * B.usd;
        const depth = Math.min(B.depth, hop);
        const cur = price.get(p.tokenA);
        const usd = B.usd * p.priceAB;
        if (hop >= MIN_DEPTH_USD && usd > 0 && isFinite(usd) && (!cur || depth > cur.depth)) {
          price.set(p.tokenA, { usd, via: `${p.dex}:${p.id}`, depth, hops: (B.hops ?? 0) + 1 }); changed++;
        }
      }
    }
    if (!changed) break;
  }
  return price;
}
