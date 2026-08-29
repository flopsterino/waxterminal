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
