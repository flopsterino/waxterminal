// =============================================================================
// OLD PROJECTS — contracts that outlived their front ends.
//
// A WAX contract does not stop when the website paying for the website stops.
// PepperStake's pools kept accruing for months with nobody able to collect;
// WaxDAO's farms are still paying; wax.fun's bonding curves still trade. The
// people with money in them can do nothing about it, because the only interface
// anyone built is gone.
//
// So this reads them off the chain and puts the buttons back. Everything here
// was checked against real transactions rather than guessed from an ABI — for a
// dead project there is nobody left to ask, and a wrong memo spends somebody
// else's money:
//
//   wax.fun     tokens live on alpha.waxfun, the curve on main.waxfun. A buy is
//               WAX to main.waxfun with a JSON memo naming the token and the
//               slippage; a sell is the token itself with the same memo shape.
//               Verified on 27ffeab8… (buy) and 06a42f9b… (sell).
//   WaxDAO      drops mint from waxdaomarket::claimdrop, which is what its
//               1,340 claims used. Paid drops take payment somewhere this has
//               not seen used since 2025, so those are listed and not claimed:
//               guessing a payment memo with someone's tokens is not on.
// =============================================================================

import { getRows, getAllRows } from './chain.js';

export const WAXFUN_TOKENS = 'alpha.waxfun';
export const WAXFUN_CURVE = 'main.waxfun';
export const WAXDAO_MARKET = 'waxdaomarket';

// ---------------------------------------------------------------- the curve --
// Worked out from the chain, because wax.fun's front end is gone and its
// contract ships no formula anyone can read. It is a constant product against
// virtual reserves:
//
//   T  = 2^30 tokens (1,073,741,824) — the virtual token reserve
//   W0 = the token's curve_config, in WAX — the virtual WAX reserve
//   Y  = T - supply                    price p(S) = W0*T / (T - S)^2
//
// How that was established, since guessing here spends other people's money:
//   - two tokens nobody has burned solve S*(1 + W0/R) to 1.07375e9 and
//     1.07375e9, which is 2^30 to five digits;
//   - the price it predicts matches the contract's own logged price on TENX
//     (1.92607e-4 against 1.926e-4) and on WU (7.60566e-5 against 7.605e-5);
//   - it reproduces a real 6,500 WAX buy: 35,597,000 tokens predicted against
//     35,596,919 issued.
// Fees: a buy is charged 1% of the WAX before it reaches the curve, a sell pays
// out 1% less than the curve gives — both seen in the transfers of real trades.
export const CURVE_T = 2 ** 30;
export const CURVE_FEE = 0.01;
export const DEX_GOAL_TOKENS = 8e8;             // supply at which it lists on Alcor

export const curvePrice = (supply, curveConfig) => {
  const y = CURVE_T - supply;
  return y > 0 ? (curveConfig * CURVE_T) / (y * y) : null;
};

// Spending `wax` (gross, fee included) gets you this many tokens.
export function curveBuy(wax, supply, curveConfig) {
  const y = CURVE_T - supply;
  const w = wax * (1 - CURVE_FEE);
  if (!(w > 0) || !(y > 0)) return null;
  const out = (w * y * y) / (curveConfig * CURVE_T + w * y);
  return out > 0 && out < y ? out : null;
}

// Selling `tokens` back pays this much WAX, after the fee.
export function curveSell(tokens, supply, curveConfig) {
  const y = CURVE_T - supply;
  if (!(tokens > 0) || !(y > 0) || tokens > supply) return null;
  const gross = (curveConfig * CURVE_T * tokens) / (y * (y + tokens));
  return gross > 0 ? gross * (1 - CURVE_FEE) : null;
}

// How far along the curve it is: the contract lists a token on Alcor once 800M
// of it has been sold.
export const curveProgress = supply => Math.max(0, Math.min(1, supply / DEX_GOAL_TOKENS));

const parseAmount = q => parseFloat(String(q || '').split(' ')[0]) || 0;
const decimalsOf = q => (String(q || '').split(' ')[0].split('.')[1] || '').length;

// Every token still on a wax.fun curve, with what it says about itself.
export async function waxfunTokens({ scopes = [WAXFUN_TOKENS, 'beta.waxfun'] } = {}) {
  const meta = new Map();
  for (const scope of scopes) {
    let rows = [];
    try { rows = await getAllRows(WAXFUN_TOKENS, scope === WAXFUN_TOKENS ? WAXFUN_TOKENS : scope, 'tokenmdata'); } catch { rows = []; }
    for (const m of rows) meta.set(`${scope}:${m.sym_code}`, m);
  }
  const out = [];
  for (const scope of scopes) {
    let curves = [];
    try { curves = await getAllRows(WAXFUN_CURVE, scope, 'tkncrv'); } catch { continue; }
    for (const c of curves) {
      const m = meta.get(`${scope}:${c.sym_code}`) || {};
      out.push({
        symbol: c.sym_code, contract: scope,
        id: `${c.sym_code}@${scope}`,
        state: String(c.state || '').toUpperCase(),          // TRADING, LISTED, …
        reservedWax: parseAmount(c.reserved_wax),
        dexGoal: parseAmount(c.dex_goal),
        kothGoal: parseAmount(c.king_of_the_hill_goal),
        curveConfig: Number(c.curve_config) || 0,
        name: m.token_name || c.sym_code,
        image: m.image || '',
        description: m.description || '',
        creator: m.creator || '',
        createdAt: m.creation_time ? Date.parse(m.creation_time + 'Z') : null,
        website: m.website || '', telegram: m.telegram || '', x: m.x || '',
      });
    }
  }
  out.sort((a, b) => b.reservedWax - a.reservedWax);
  return out;
}

// Supply is per-symbol scope on the token contract, so it is read for the one
// token somebody opened rather than for all of them.
export async function waxfunSupply(token) {
  try {
    const d = await getRows(token.contract, token.symbol, 'stat', { limit: 1 });
    const r = d.rows?.[0];
    if (!r) return null;
    return {
      supply: parseAmount(r.supply),
      maxSupply: parseAmount(r.max_supply),
      decimals: decimalsOf(r.supply),
      issuer: r.issuer,
    };
  } catch { return null; }
}

const fmt = (n, d) => (Math.floor(Number(n) * 10 ** d + 1e-9) / 10 ** d).toFixed(d);
const memoFor = (action, token, slippagePct) =>
  JSON.stringify({ action, token: token.symbol, contract: token.contract, max_slippage: Number(slippagePct) });

// Buying is WAX to the curve; the curve issues the tokens and refuses if the
// price moved past the slippage. The 1% fee comes off what is sent.
export function buildWaxfunBuy({ account, token, wax, slippagePct = 5 }) {
  return [{
    account: 'eosio.token', name: 'transfer',
    authorization: [{ actor: account, permission: 'active' }],
    data: { from: account, to: WAXFUN_CURVE, quantity: `${fmt(wax, 8)} WAX`, memo: memoFor('buy', token, slippagePct) },
  }];
}

// Selling sends the token back; the curve retires it and pays WAX, less 1%.
export function buildWaxfunSell({ account, token, amount, decimals, slippagePct = 5 }) {
  return [{
    account: token.contract, name: 'transfer',
    authorization: [{ actor: account, permission: 'active' }],
    data: { from: account, to: WAXFUN_CURVE, quantity: `${fmt(amount, decimals)} ${token.symbol}`, memo: memoFor('sell', token, slippagePct) },
  }];
}

// ---------------------------------------------------------------- WaxDAO ----
export async function waxdaoDrops({ now = Date.now() } = {}) {
  let rows = [];
  try { rows = await getAllRows(WAXDAO_MARKET, WAXDAO_MARKET, 'drops'); } catch { return []; }
  const sec = now / 1000;
  return rows
    .map(d => ({
      id: Number(d.ID),
      creator: d.user,
      price: parseAmount(d.price),
      priceSymbol: String(d.price || '').split(' ')[1] || '',
      priceContract: d.contract,
      collection: d.collection, schema: d.schema, templateId: Number(d.template_id),
      left: Number(d.total_left), total: Number(d.total_available),
      perUser: Number(d.limit_per_user), cooldown: Number(d.cooldown),
      whitelist: d.whitelist_type, farm: d.farmname, minStake: Number(d.minimum_to_stake),
      startsAt: Number(d.start_time) * 1000, endsAt: Number(d.end_time) * 1000,
      description: d.drop_description || '', logo: d.drop_logo || '',
      type: d.drop_type || '',
    }))
    // Still open: started, not ended, and either unlimited or with some left.
    .filter(d => d.startsAt / 1000 <= sec && d.endsAt / 1000 > sec && (d.total === 0 || d.left > 0))
    .sort((a, b) => a.price - b.price || b.id - a.id);
}

// The claim the contract's own history used 1,340 times. `unique_id` is the
// caller's nonce; WaxDAO's own front end sent a random one.
export function buildDropClaim({ account, dropId, count = 1 }) {
  return [{
    account: WAXDAO_MARKET, name: 'claimdrop',
    authorization: [{ actor: account, permission: 'active' }],
    data: {
      drop_ID: Number(dropId), user: account, quantity_to_mint: Math.max(1, Math.round(count)),
      unique_id: Math.floor(Math.random() * 2 ** 31),
    },
  }];
}
