// =============================================================================
// DEPTH — separating what a pool holds from what it could actually pay out.
//
// The problem this exists to solve, measured on chain 2026-08-29:
//
//   parareserves is a plain eosio.token contract — accounts, stat, issue,
//   transfer, nothing else. No collateral, no redemption, no peg, despite the
//   name. It minted exactly 1,000,000 PARAUSD and put 999,997.68 of them inside
//   swap.alcor: 99.9997% of the entire supply, in positions it owns itself, at a
//   price it chose. Read naively that is $998,088 of "TVL". The whole exit to
//   anything else is $1,186. TVL@hype.gm is worse: $561,055 nominal, $8 out.
//
// So a token's price being correct is not the same as its value being
// realisable, and a terminal that reports the first as the second is lying with
// arithmetic. This module computes, per token, how much OTHER value stands
// opposite it — the money that would have to be on the table for its holdings to
// be worth what they say.
// =============================================================================

// A token is "solid" once enough independently-solid value stands against it.
// Bridged dollars seed the set; WAX earns its way in through them; tokens paired
// with WAX earn it through WAX. Self-issued tokens paired only with each other
// never do, which is exactly the distinction being drawn.
const SEED_SOLID_USD = 2000;
const ROUNDS = 4;

// Assets whose value does not depend on WAX's own pool graph: bridged dollars,
// bridged BTC/ETH, and WAX itself, which trades on centralised exchanges with
// orders of magnitude more depth than anything on this chain.
//
// Without this the model asked "what if the entire WAX inventory of every pool
// were dumped at once", answered 0.65, and wrote $31,122 off the chain's own
// currency — including $2,056 from WAX/WAXUSDC, the flagship pair. That is a
// real question, but it is not the one a value figure is answering.
const ANCHORED = new Set([
  'WAX@eosio.token',
  'WAXUSDC@eth.token', 'WAXUSDT@eth.token', 'USDT@usdt.alcor',
  'WAXWBTC@eth.token', 'WAXWETH@eth.token', 'WAXDAI@eth.token',
]);

export function computeDepth(pools, prices, stables) {
  const nominal = new Map();          // token -> USD sitting in pools
  for (const p of pools) {
    if (p.priceUsdA != null) nominal.set(p.tokenA, (nominal.get(p.tokenA) || 0) + p.reserveA * p.priceUsdA);
    if (p.priceUsdB != null) nominal.set(p.tokenB, (nominal.get(p.tokenB) || 0) + p.reserveB * p.priceUsdB);
  }

  const solid = new Set([...stables, ...ANCHORED]);
  let exit = new Map();

  for (let round = 0; round < ROUNDS; round++) {
    exit = new Map();
    for (const p of pools) {
      const va = p.priceUsdA != null ? p.reserveA * p.priceUsdA : null;
      const vb = p.priceUsdB != null ? p.reserveB * p.priceUsdB : null;
      // Only value standing on the solid side counts as an exit. Two tokens that
      // are both illiquid do not make each other liquid by facing each other.
      if (vb != null && solid.has(p.tokenB)) exit.set(p.tokenA, (exit.get(p.tokenA) || 0) + vb);
      if (va != null && solid.has(p.tokenA)) exit.set(p.tokenB, (exit.get(p.tokenB) || 0) + va);
    }
    const before = solid.size;
    for (const [t, v] of exit) if (v >= SEED_SOLID_USD) solid.add(t);
    if (solid.size === before) break;
  }

  // Realisable value is capped by the exit that exists. A token cannot have more
  // value in pools than there is money willing to stand opposite it.
  const out = new Map();
  for (const [t, nom] of nominal) {
    const ex = exit.get(t) || 0;
    const realisable = (stables.has(t) || ANCHORED.has(t)) ? nom : Math.min(nom, ex);
    out.set(t, {
      anchored: ANCHORED.has(t) || stables.has(t),
      nominal: nom,
      exit: ex,
      realisable,
      ratio: nom > 0 ? realisable / nom : 0,
      solid: solid.has(t),
    });
  }
  return { tokens: out, solid };
}

// A pool's realisable value: each side scaled by how much of that token's
// nominal value the market could actually absorb.
export function poolRealisable(p, depth) {
  const da = depth.get(p.tokenA), db = depth.get(p.tokenB);
  const va = p.priceUsdA != null ? p.reserveA * p.priceUsdA * (da ? da.ratio : 0) : 0;
  const vb = p.priceUsdB != null ? p.reserveB * p.priceUsdB * (db ? db.ratio : 0) : 0;
  return va + vb;
}
