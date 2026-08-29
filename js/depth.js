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

  // Distance from a real anchor, and the rule that makes this work: a token's
  // exit may only count value standing in tokens STRICTLY CLOSER to an anchor
  // than itself.
  //
  // Without that rule the model endorses circles. Measured before the fix: LADYZ
  // was credited $66,969 of exit, of which $60,463 came from CATERZ, DRAGONZ,
  // HOPPERZ and BUTTERZ — issued by the same account as LADYZ. Exactly $563 came
  // from WAX. One of them crossed the threshold through a small WAX pool, was
  // marked solid, and then vouched for the other four, which vouched back. Five
  // self-issued tokens certified each other into looking like the deepest
  // liquidity on the chain, which is the precise thing this module exists to
  // refuse.
  const dist = new Map();
  for (const id of stables) dist.set(id, 0);
  for (const id of ANCHORED) dist.set(id, 0);

  const exit = new Map();
  for (let round = 1; round <= ROUNDS; round++) {
    const gained = new Map();
    for (const p of pools) {
      const va = p.priceUsdA != null ? p.reserveA * p.priceUsdA : null;
      const vb = p.priceUsdB != null ? p.reserveB * p.priceUsdB : null;
      // Value opposite A counts for B only if B's counterparty is already
      // closer to an anchor than B can be at this round.
      const dA = dist.get(p.tokenA), dB = dist.get(p.tokenB);
      if (vb != null && dB != null && dB < round && !dist.has(p.tokenA)) gained.set(p.tokenA, (gained.get(p.tokenA) || 0) + vb);
      if (va != null && dA != null && dA < round && !dist.has(p.tokenB)) gained.set(p.tokenB, (gained.get(p.tokenB) || 0) + va);
    }
    for (const [t, v] of gained) {
      exit.set(t, Math.max(exit.get(t) || 0, v));
      if (v >= SEED_SOLID_USD) dist.set(t, round);
    }
  }

  // Anything never reached keeps whatever partial exit it accumulated; anchors
  // are unbounded by construction.
  const out = new Map();
  for (const [t, nom] of nominal) {
    const anchored = stables.has(t) || ANCHORED.has(t);
    const ex = anchored ? Infinity : (exit.get(t) || 0);
    const realisable = anchored ? nom : Math.min(nom, ex);
    out.set(t, {
      anchored,
      distance: dist.get(t) ?? null,
      nominal: nom,
      exit: anchored ? nom : ex,
      realisable,
      ratio: nom > 0 ? realisable / nom : 0,
      solid: dist.has(t),
    });
  }
  return { tokens: out, solid: new Set([...dist.keys()]) };
}

// Who is standing on the other side of this token's liquidity.
//
// The abstract ratio above is defensible but hard to argue with, so this
// computes the thing you can check in one line: how much of a token's
// counterparty value sits in tokens issued by the same account, and how
// concentrated it is in a single partner.
//
// Measured: NBG has 70% of its counterparty value in WAXCASH; WAXCASH has 41%
// in NBG plus 12% in NIFTY, which is issued by the same account as NBG. Three
// NBG/WAXCASH pools hold $46,398 between them, the largest block on the chain,
// and it is two projects holding each other up.
export function counterparties(pools) {
  const facing = new Map();      // token -> Map(otherToken -> usd)
  for (const p of pools) {
    const va = p.priceUsdA != null ? p.reserveA * p.priceUsdA : 0;
    const vb = p.priceUsdB != null ? p.reserveB * p.priceUsdB : 0;
    for (const [self, other, otherVal] of [[p.tokenA, p.tokenB, vb], [p.tokenB, p.tokenA, va]]) {
      if (!(otherVal > 0)) continue;
      let m = facing.get(self);
      if (!m) { m = new Map(); facing.set(self, m); }
      m.set(other, (m.get(other) || 0) + otherVal);
    }
  }

  const out = new Map();
  for (const [self, m] of facing) {
    const selfContract = self.split('@')[1];
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    if (!(total > 0)) continue;
    let sameIssuer = 0;
    for (const [other, v] of m) if (other.split('@')[1] === selfContract) sameIssuer += v;
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    out.set(self, {
      total,
      top: sorted[0] ? { token: sorted[0][0], usd: sorted[0][1], share: sorted[0][1] / total } : null,
      sameIssuerShare: sameIssuer / total,
      partners: sorted.slice(0, 3).map(([token, usd]) => ({ token, usd, share: usd / total })),
    });
  }
  return out;
}

// A pool's realisable value: each side scaled by how much of that token's
// nominal value the market could actually absorb.
export function poolRealisable(p, depth) {
  const da = depth.get(p.tokenA), db = depth.get(p.tokenB);
  const va = p.priceUsdA != null ? p.reserveA * p.priceUsdA * (da ? da.ratio : 0) : 0;
  const vb = p.priceUsdB != null ? p.reserveB * p.priceUsdB * (db ? db.ratio : 0) : 0;
  return va + vb;
}
