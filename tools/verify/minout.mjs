// =============================================================================
// MIN OUT — the rule that decides what a swap is allowed to come back with.
//
// Compounding CHEESE/WAXWETH reverted every time with "Received lower than
// minTokenOut: 30, poolId: 7801": the band needed a tenth of a cent of
// WAXWETH, and a minimum three units under a 33-unit quote is not a tolerance,
// it is a coin flip. So the sizes around that case are walked here rather than
// on somebody's money.
//
// Run: node tools/verify/minout.mjs
// =============================================================================

import { state } from '../../js/store.js';
import { __minout } from '../../js/tx.js';

const { tooSmallToSwap, roundingSafeMin, loosenMemo, skipReason } = __minout;

const WETH = 'WAXWETH@eth.token';
const CHEESE = 'CHEESE@cheeseburger';
const weth = { symbol: 'WAXWETH', contract: 'eth.token', decimals: 8 };
state.prices.set(WETH, { usd: 2692.27 });
state.prices.set(CHEESE, { usd: 0.008018 });
state.tokens.set(WETH, weth);

let bad = 0;
const is = (name, got, want) => {
  const ok = Math.abs(got - want) < 1e-12 || got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (wanted ${want})`}`);
};
const yes = (name, got) => { if (!got) bad++; console.log(`${got ? 'ok  ' : 'FAIL'} ${name}`); };

// The leg that reverted: 33 units of WAXWETH, nine hundredths of a cent.
const reverted = 33e-8;
yes('the leg that reverted is not swapped at all', tooSmallToSwap(reverted, WETH, 8));
console.log(`     reason: ${skipReason(reverted, WETH, weth)}`);

// A third of a cent of CHEESE — 4 decimals, so 400 units — is not dust to a
// pool and must keep swapping exactly as it did before the rule existed.
const CHEESE_META = { symbol: 'CHEESE', contract: 'cheeseburger', decimals: 4 };
state.tokens.set(CHEESE, CHEESE_META);
const cheeseBit = 0.0033 / 0.008018;                 // ~0.41 CHEESE, 4,100 units
yes('a third of a cent of CHEESE still swaps', !tooSmallToSwap(cheeseBit, CHEESE, 4));
is('and keeps its percentage', roundingSafeMin(cheeseBit * 0.98, cheeseBit, CHEESE, 4), cheeseBit * 0.98);

// Just over a cent: worth swapping, but not worth protecting — one unit.
const cent = 0.011 / 2692.27;                      // ~409 units
yes('a one-cent leg is swapped', !tooSmallToSwap(cent, WETH, 8));
is('a one-cent leg asks for one unit', roundingSafeMin(cent * 0.98, cent, WETH, 8), 1e-8);

// Ten cents: 3,700 units, where a unit of rounding is 0.03% — the ordinary
// tolerance stands.
const dime = 0.10 / 2692.27;
is('a ten-cent leg keeps its percentage', roundingSafeMin(dime * 0.98, dime, WETH, 8), dime * 0.98);

// A real swap: fifty dollars of WAXWETH, tolerance untouched.
const fifty = 50 / 2692.27;
is('a fifty-dollar leg keeps its percentage', roundingSafeMin(fifty * 0.98, fifty, WETH, 8), fifty * 0.98);

// No price at all: judged on size, because rounding is the only thing known.
const unpriced = 'ZZZ@nowhere';
is('an unpriced 50-unit leg asks for one unit', roundingSafeMin(45e-8, 50e-8, unpriced, 8), 1e-8);
is('an unpriced 5,000-unit leg keeps its percentage', roundingSafeMin(4900e-8, 5000e-8, unpriced, 8), 4900e-8);

// And the same rule written into a memo Alcor built.
const memo = `swapexactin#7801#eosio.null#0.00000030 WAXWETH@eth.token#0`;
const loosened = loosenMemo({ memo, min: 30e-8, expect: 33e-8, inputAsset: '0.1100 CHEESE' }, weth, WETH);
is('a dust memo asks for one unit', loosened.min, 1e-8);
yes('the rest of the memo is untouched',
  loosened.memo === 'swapexactin#7801#eosio.null#0.00000001 WAXWETH@eth.token#0');
const big = { memo: `swapexactin#7801#eosio.null#0.01000000 WAXWETH@eth.token#0`, min: 0.01, expect: 0.0102, inputAsset: '3400.0000 CHEESE' };
yes('a real memo is left exactly as Alcor built it', loosenMemo(big, weth, WETH).memo === big.memo);

console.log(bad ? `\n${bad} failed` : '\nall good');
process.exit(bad ? 1 : 0);
