// =============================================================================
// MATH — Alcor is a Uniswap-V3 clone on X64 fixed point (not X96).
// TVL, position value, in-range status and the compounder's deposit ratio all
// rest on these. Verified against live pool state; see the self-test page.
// =============================================================================

const Q64 = 2 ** 64;
const TICK_BASE = 1.0001;

export const sqrtPriceFromX64 = x => Number(BigInt(x)) / Q64;
export const rawPriceFromX64  = x => { const s = sqrtPriceFromX64(x); return s * s; };

// WAX carries 8 decimals, TLM 4. Skip this rescale and every TVL is out by
// orders of magnitude.
export const humanPrice   = (raw, decA, decB) => raw * 10 ** (decA - decB);
export const priceFromX64 = (x, decA, decB) => humanPrice(rawPriceFromX64(x), decA, decB);

export const sqrtRatioAtTick = t => Math.pow(TICK_BASE, t / 2);
export const tickAtPrice     = p => Math.floor(Math.log(p) / Math.log(TICK_BASE));

// Token amounts held by `liquidity` over [tickLower, tickUpper], in RAW units.
export function amountsForLiquidity(liquidity, sqrtP, tickLower, tickUpper) {
  const L = Number(liquidity);
  const sa = sqrtRatioAtTick(tickLower), sb = sqrtRatioAtTick(tickUpper), s = sqrtP;
  if (!(L > 0) || !(sb > sa)) return { amountA: 0, amountB: 0 };
  if (s <= sa) return { amountA: L * (sb - sa) / (sa * sb), amountB: 0 };
  if (s >= sb) return { amountA: 0, amountB: L * (sb - sa) };
  return { amountA: L * (sb - s) / (s * sb), amountB: L * (s - sa) };
}

// What fraction of a new deposit's value must be token A for THIS range at THIS
// price. Harvested fees never arrive in this ratio, which is exactly why a
// compound needs a swap in the middle.
export function depositRatio(sqrtP, tickLower, tickUpper) {
  const sa = sqrtRatioAtTick(tickLower), sb = sqrtRatioAtTick(tickUpper), s = sqrtP;
  if (s <= sa) return { shareA: 1, shareB: 0, inRange: false, side: 'below' };
  if (s >= sb) return { shareA: 0, shareB: 1, inRange: false, side: 'above' };
  const vA = s * (sb - s) / sb, vB = s - sa;
  return { shareA: vA / (vA + vB), shareB: vB / (vA + vB), inRange: true, side: 'in' };
}

// WAX assets are 'AMOUNT SYMBOL'; the decimal count lives in the string itself.
export function parseAsset(q) {
  const [amount, symbol] = String(q).trim().split(/\s+/);
  const dot = amount.indexOf('.');
  return { amount: Number(amount), symbol, decimals: dot === -1 ? 0 : amount.length - dot - 1 };
}

export const tokenId = (symbol, contract) => `${symbol}@${contract}`;

// ------------------------------------------------------------ fees owed -----
// What a position has earned and not collected.
//
// The `feesA`/`feesB` fields on a position row are NOT this: they are what a
// previous collect already credited and left sitting there, and on a position
// that has never been poked they are zero while real fees accrue. Reading them
// as "fees waiting" reported $0 on a position Alcor's own page showed $1.69 on.
//
// The real figure is Uniswap V3's fee-growth accounting, which Alcor implements
// unchanged: the pool tracks fees per unit of liquidity since inception, each
// initialised tick tracks the growth that happened on the far side of it, and
// the difference is what accrued inside this position's band while the position
// was in it.
//
//   inside = global - below(lower) - above(upper)
//   owed   = liquidity * (inside - insideLast) / 2^64 + already credited
//
// Checked against Alcor's own index on position 146875 (pool 11051): 178.24
// CHEESE against their 178.2561, and 7.8096 HOLE against their 7.80965294.
const M128 = 1n << 128n;
const big = v => BigInt(v ?? 0);
// Growth counters are unsigned and wrap, so a plain subtraction can go negative
// and turn a real balance into a nonsense one.
const wrapSub = (a, b) => ((a - b) % M128 + M128) % M128;

export function feesOwed(pos, pool, tickLowerRow, tickUpperRow) {
  const tick = Number(pool.currSlot?.tick ?? pool.tick);
  const out = {};
  for (const side of ['A', 'B']) {
    const global = big(pool[`feeGrowthGlobal${side}X64`]);
    // An uninitialised tick has no growth recorded on its far side, which is
    // the same thing as zero — not a reason to give up on the position.
    const lo = big(tickLowerRow?.[`feeGrowthOutside${side}X64`]);
    const hi = big(tickUpperRow?.[`feeGrowthOutside${side}X64`]);
    const below = tick >= pos.tickLower ? lo : wrapSub(global, lo);
    const above = tick < pos.tickUpper ? hi : wrapSub(global, hi);
    const inside = wrapSub(wrapSub(global, below), above);
    const delta = wrapSub(inside, big(pos[`feeGrowthInside${side}LastX64`]));
    // A delta above half the range is a wrap that means "negative", i.e. the
    // position is ahead of the counter. That is not fees owed, it is zero.
    const accrued = delta > (M128 >> 1n) ? 0n : (big(pos.liquidity) * delta) >> 64n;
    out[side] = Number(accrued) + Number(pos[`fees${side}`] ?? 0);
  }
  return { feesA: out.A, feesB: out.B };
}

// --------------------------------------------------------- liquidity map ----
// Where the liquidity actually sits, across the price range.
//
// On a concentrated-liquidity pool this is the question. A pool holding
// $15,000 tells you nothing about whether a trade will move the price: all of
// it can be stacked in a band half a percent wide, or spread so thin that the
// first swap walks straight through it. Every serious Uniswap-V3 tool draws
// this and nothing on WAX does.
//
// The reconstruction is the standard one. Each initialised tick carries
// liquidityNet, the change in active liquidity when the price crosses it going
// up. Walk the ticks in order, accumulate, and the running total is the
// liquidity active between one tick and the next.
//
// Ticks are signed and the table's primary key is not, so negative ticks come
// back after positive ones. They are sorted here rather than trusted.
export function liquidityBands(tickRows) {
  const ticks = tickRows
    .map(r => ({ tick: Number(r.id), net: BigInt(r.liquidityNet) }))
    .filter(t => Number.isFinite(t.tick))
    .sort((a, b) => a.tick - b.tick);
  const bands = [];
  let L = 0n;
  for (let i = 0; i < ticks.length - 1; i++) {
    L += ticks[i].net;
    if (L > 0n) bands.push({ lower: ticks[i].tick, upper: ticks[i + 1].tick, liquidity: L });
  }
  return bands;
}

// What each band is worth, in the two tokens, if the price were inside it.
// Summing these across every band reproduces the pool's own reserves, which is
// the check that the walk above is right rather than merely plausible.
export function bandValues(bands, pool) {
  const out = [];
  // At the pool's CURRENT price, so this is what each band actually holds right
  // now: bands below the price are all of token B, bands above are all of token
  // A, and the one straddling it holds both. Priced at each band's own midpoint
  // instead, the numbers are a hypothetical and the total is not the pool.
  const sqrtP = sqrtPriceFromX64(pool.sqrtX64);
  for (const b of bands) {
    const { amountA, amountB } = amountsForLiquidity(b.liquidity, sqrtP, b.lower, b.upper);
    const a = amountA / 10 ** pool.decA, bb = amountB / 10 ** pool.decB;
    out.push({
      ...b,
      amountA: a, amountB: bb,
      priceLower: humanPrice(Math.pow(TICK_BASE, b.lower), pool.decA, pool.decB),
      priceUpper: humanPrice(Math.pow(TICK_BASE, b.upper), pool.decA, pool.decB),
      usd: a * (pool.priceUsdA || 0) + bb * (pool.priceUsdB || 0),
    });
  }
  return out;
}
