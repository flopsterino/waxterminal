// =============================================================================
// DEPTHMATH — how much can you actually trade here.
//
// "Sellable" was the wrong question and a bad answer. What a person wants to
// know, whether it is their first swap or their thousandth, is: how big a trade
// can I do before I move the price against myself.
//
// That number is NOT the reserve. Concentrated liquidity puts the same dollars
// in a narrow band, so a $1,000 V3 pool with everything at the current price is
// far deeper right here than a $1,000 constant-product pool spread from zero to
// infinity — and far shallower one tick outside the band.
//
// For a V3 pool, moving the price by a fraction d costs roughly L·√P·d/2 of the
// quote token, PROVIDED the band survives that move. It usually does not: a
// ten-tick position is exhausted after 0.1%, so the estimate is capped by what
// is actually sitting on that side. Without the cap a $836 pool reported $5.9M
// of depth, which is how a position ten ticks wide looks from the outside.
// =============================================================================

import { sqrtPriceFromX64 } from './math.js';

// USD you can trade in one go before the price moves `move` (0.01 = 1%).
export function tradeDepth(pool, move = 0.01) {
  const valA = pool.priceUsdA != null ? pool.reserveA * pool.priceUsdA : null;
  const valB = pool.priceUsdB != null ? pool.reserveB * pool.priceUsdB : null;
  const sideCap = Math.min(valA ?? Infinity, valB ?? Infinity);
  if (!isFinite(sideCap) || sideCap <= 0) return null;

  if (pool.dex !== 'alcor') {
    // Constant product: a 1% price move takes about half a percent of a side.
    return sideCap * (move / 2);
  }
  if (!(pool.liquidity > 0) || !pool.sqrtX64 || pool.priceUsdB == null) return sideCap * (move / 2);

  const s = sqrtPriceFromX64(pool.sqrtX64);
  const rawB = pool.liquidity * s * (move / 2);
  const usd = (rawB / 10 ** pool.decB) * pool.priceUsdB;
  // The band cannot pay out more than it holds.
  return Math.min(usd, sideCap);
}
