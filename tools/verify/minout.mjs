// =============================================================================
// MIN OUT — the rule that decides what a swap is allowed to come back with.
//
// Compounding CHEESE/WAXWETH reverted every time with "Received lower than
// minTokenOut: 30, poolId: 7801": the band was nine hundredths of a cent out
// of balance, and a minimum three units under a 33-unit quote is not a
// tolerance, it is a coin flip.
//
// The rule that replaced it decides nothing about how small an amount is worth
// compounding — WAX has no mempool to be sandwiched in, and how little someone
// compounds is their business. It only refuses to ask for a precision the pool
// cannot deliver. These are the sizes that matter, walked here rather than on
// somebody's money.
//
// Run: node tools/verify/minout.mjs
// =============================================================================

import { state } from '../../js/store.js';
import { __minout } from '../../js/tx.js';

const { tooSmallToSwap, roundingSafeMin, loosenMemo, skipReason } = __minout;

const weth = { symbol: 'WAXWETH', contract: 'eth.token', decimals: 8 };
const cheese = { symbol: 'CHEESE', contract: 'cheeseburger', decimals: 4 };
state.tokens.set('WAXWETH@eth.token', weth);
state.tokens.set('CHEESE@cheeseburger', cheese);

let bad = 0;
const is = (name, got, want) => {
  const ok = got === want || Math.abs(got - want) < 1e-12;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (wanted ${want})`}`);
};
const yes = (name, got) => { if (!got) bad++; console.log(`${got ? 'ok  ' : 'FAIL'} ${name}`); };

// The leg that reverted: 33 units of WAXWETH, nine hundredths of a cent. It is
// swapped — it is the holder's dust — and it asks for one unit, which rounding
// cannot take away.
const reverted = 33e-8;
yes('the leg that reverted is still swapped', !tooSmallToSwap(reverted, 8));
is('and asks for one unit', roundingSafeMin(reverted * 0.98, reverted, 8), 1e-8);

// Smaller still: two units, the smallest swap that can ask for one unit back
// and still have a unit of room for rounding.
yes('two units is swapped', !tooSmallToSwap(2e-8, 8));
is('and asks for one unit', roundingSafeMin(2e-8 * 0.98, 2e-8, 8), 1e-8);

// One unit, or less: asking for a unit back leaves nothing for rounding.
yes('one unit cannot be swapped', tooSmallToSwap(1e-8, 8));
yes('under a unit cannot be swapped', tooSmallToSwap(0.4e-8, 8));
console.log(`     reason: ${skipReason(weth)}`);

// A third of a cent of CHEESE is four thousand units: rounding is noise there,
// so the ordinary tolerance stands.
const cheeseBit = 0.41;
yes('a third of a cent of CHEESE is swapped', !tooSmallToSwap(cheeseBit, 4));
is('and keeps its percentage', roundingSafeMin(cheeseBit * 0.98, cheeseBit, 4), cheeseBit * 0.98);

// A real swap: fifty dollars of WAXWETH, tolerance untouched.
const fifty = 50 / 2692.27;
is('a fifty-dollar leg keeps its percentage', roundingSafeMin(fifty * 0.98, fifty, 8), fifty * 0.98);

// Exactly at the line, from both sides.
is('999 units asks for one unit', roundingSafeMin(980e-8, 999e-8, 8), 1e-8);
is('1,000 units keeps its percentage', roundingSafeMin(980e-8, 1000e-8, 8), 980e-8);

// And the same rule written into a memo Alcor built.
const memo = 'swapexactin#7801#eosio.null#0.00000030 WAXWETH@eth.token#0';
const loosened = loosenMemo({ memo, min: 30e-8, expect: 33e-8, inputAsset: '0.1100 CHEESE' }, weth);
is('a dust memo asks for one unit', loosened.min, 1e-8);
yes('the rest of the memo is untouched',
  loosened.memo === 'swapexactin#7801#eosio.null#0.00000001 WAXWETH@eth.token#0');
const big = { memo: 'swapexactin#7801#eosio.null#0.01000000 WAXWETH@eth.token#0', min: 0.01, expect: 0.0102, inputAsset: '3400.0000 CHEESE' };
yes('a real memo is left exactly as Alcor built it', loosenMemo(big, weth).memo === big.memo);

console.log(bad ? `\n${bad} failed` : '\nall good');
process.exit(bad ? 1 : 0);
