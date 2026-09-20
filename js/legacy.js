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
//   WaxDAO      a drop sells an NFT for whatever token its creator chose. Paid
//               ones assert the amount and then pay it in one transaction,
//               memo |purchase_drop|<drop>|<nonce>|; free ones call claimdrop.
//               Verified on c0ff0eb0… (57 NFTs for 427,443 OWLZ) and against
//               the 1,340 free claims.
// =============================================================================

import { getRows, getAllRows, HYPERION_HOSTS } from './chain.js';

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

// WAX the curve takes to move the supply from one point to the next, before
// the fee — the integral of the price between them. Which is how far off the
// listing a token really is: a progress bar says 53%, this says what the rest
// costs.
export function curveWax(supplyFrom, supplyTo, curveConfig) {
  const y0 = CURVE_T - supplyFrom, y1 = CURVE_T - supplyTo;
  if (!(y0 > 0) || !(y1 > 0) || !(supplyTo > supplyFrom)) return null;
  return curveConfig * CURVE_T * (1 / y1 - 1 / y0);
}
// The same, as the amount a buyer has to send: the contract keeps 1% before
// the rest reaches the curve.
export const curveWaxToSend = (from, to, cfg) => {
  const net = curveWax(from, to, cfg);
  return net == null ? null : net / (1 - CURVE_FEE);
};

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

// One token, read on its own. Both tables are keyed by the symbol, so a token
// page costs three single-row reads rather than a walk of all 263 curves.
export async function waxfunToken(symbol, contract = WAXFUN_TOKENS) {
  const sym = String(symbol || '').toUpperCase();
  if (!/^[A-Z]{1,7}$/.test(sym)) return null;
  const [curve, meta, stat] = await Promise.all([
    getRows(WAXFUN_CURVE, contract, 'tkncrv', { lower: sym, limit: 1 }).then(d => d.rows?.[0]).catch(() => null),
    getRows(WAXFUN_TOKENS, contract, 'tokenmdata', { lower: sym, limit: 1 }).then(d => d.rows?.[0]).catch(() => null),
    getRows(contract, sym, 'stat', { limit: 1 }).then(d => d.rows?.[0]).catch(() => null),
  ]);
  if (!curve || curve.sym_code !== sym) return null;
  const m = meta?.sym_code === sym ? meta : {};
  return {
    symbol: sym, contract, id: `${sym}@${contract}`,
    state: String(curve.state || '').toUpperCase(),
    reservedWax: parseAmount(curve.reserved_wax),
    dexGoal: parseAmount(curve.dex_goal),
    kothGoal: parseAmount(curve.king_of_the_hill_goal),
    curveConfig: Number(curve.curve_config) || 0,
    name: m.token_name || sym,
    image: m.image || '', description: m.description || '', creator: m.creator || '',
    createdAt: m.creation_time ? Date.parse(m.creation_time + 'Z') : null,
    website: m.website || '', telegram: m.telegram || '', x: m.x || '',
    supply: stat ? parseAmount(stat.supply) : null,
    maxSupply: stat ? parseAmount(stat.max_supply) : null,
    decimals: stat ? decimalsOf(stat.supply) : 8,
    issuer: stat?.issuer || '',
  };
}

// Every trade the curve has made, from its own log. `logbsl` carries both
// sides and the price it ended at, so a tape and a price line come out of one
// read — and one read covers every token, because the whole contract is quiet
// enough that a few hundred rows reach back a year.
//
// Asked of every history node rather than one of them, and merged. The same
// query returned 436 rows from one node, 153 from another and 6 from a third
// on the same afternoon: whichever the rotation happened to pick decided
// whether a token had 71 trades or none, which is not a thing a page may say
// by accident.
let tradeCache = null;
export async function waxfunTrades({ limit = 250, force = false } = {}) {
  if (tradeCache && !force && Date.now() - tradeCache.at < 120000) return tradeCache.rows;
  const q = `/v2/history/get_actions?account=${WAXFUN_CURVE}&act.name=logbsl&limit=${limit}&sort=desc`;
  const answers = await Promise.allSettled(HYPERION_HOSTS.map(async host => {
    const r = await fetch(`${host}${q}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).actions || [];
  }));
  const got = answers.filter(a => a.status === 'fulfilled').flatMap(a => a.value);
  if (!got.length && answers.every(a => a.status === 'rejected')) throw new Error('no history node answered');
  const seen = new Set();
  const rows = [];
  for (const a of got) {
    const key = `${a.trx_id}:${a.global_sequence ?? a.action_ordinal}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const x = a.act?.data || {};
    const [tokAmt, sym] = String(x.bi?.amount || '').split(' ');
    const [waxAmt] = String(x.si?.amount || '').split(' ');
    // The curve is always one side of its own trade: when it is the buyer,
    // somebody sold into it.
    const side = x.bi?.buyer === WAXFUN_CURVE ? 'sell' : 'buy';
    if (!sym) continue;
    rows.push({
      at: Date.parse(a.timestamp + (String(a.timestamp).endsWith('Z') ? '' : 'Z')),
      trx: a.trx_id, side, symbol: sym,
      account: side === 'buy' ? x.bi?.buyer : x.si?.seller,
      tokens: parseFloat(tokAmt) || 0,
      wax: parseFloat(waxAmt) || 0,
      price: parseFloat(String(x.current_price || '').split(' ')[0]) || null,
      contract: x.token_contract || WAXFUN_TOKENS,
    });
  }
  rows.sort((a, b) => b.at - a.at);
  tradeCache = { at: Date.now(), rows };
  return rows;
}

const fmt = (n, d) => (Math.floor(Number(n) * 10 ** d + 1e-9) / 10 ** d).toFixed(d);
const memoFor = (action, token, slippagePct) =>
  JSON.stringify({ action, token: token.symbol, contract: token.contract, max_slippage: Number(slippagePct) });

// Buying is WAX to the curve; the curve issues the tokens and refuses if the
// price moved past the slippage. The 1% fee comes off what is sent. The
// default is the one a real buyer used on chain — 100, which is the curve
// filling whatever it comes to; how much movement to accept is the trader's
// choice to make, not this module's.
export function buildWaxfunBuy({ account, token, wax, slippagePct = 100 }) {
  return [{
    account: 'eosio.token', name: 'transfer',
    authorization: [{ actor: account, permission: 'active' }],
    data: { from: account, to: WAXFUN_CURVE, quantity: `${fmt(wax, 8)} WAX`, memo: memoFor('buy', token, slippagePct) },
  }];
}

// Selling sends the token back; the curve retires it and pays WAX, less 1%.
export function buildWaxfunSell({ account, token, amount, decimals, slippagePct = 100 }) {
  return [{
    account: token.contract, name: 'transfer',
    authorization: [{ actor: account, permission: 'active' }],
    data: { from: account, to: WAXFUN_CURVE, quantity: `${fmt(amount, decimals)} ${token.symbol}`, memo: memoFor('sell', token, slippagePct) },
  }];
}

// ---------------------------------------------------------------- WaxDAO ----
// A drop sells one NFT for whatever token its creator felt like charging in:
// WAX, or SHIT, or OWLZ, or any of the thirty others open right now. That is
// the thing nowhere else will sell you, and the reason this tab exists.
//
// Two shapes of claim, both taken from what the contract's own history did
// rather than from its ABI:
//
//   paid   assertdrop, saying how many you are taking, and then the payment as
//          an ordinary transfer to waxdaomarket with the memo
//          |purchase_drop|<drop>|<nonce>|. The contract mints on the transfer
//          and forwards the payment to the drop's receiver, keeping 2%.
//          Checked on c0ff0eb0…: drop 2599 at 7,499 OWLZ each, asserted 57,
//          paid 427,443 OWLZ, 57 assets minted. Over ten thousand of these.
//   free   claimdrop, 1,340 of them, the last in October 2025.
//
// A drop can outlive its own collection's permission to mint, so what is left
// and whether waxdaomarket may still mint it are read before anyone signs:
// paying for an NFT the contract can no longer issue is the one mistake here
// that costs money.
export const WAXDAO_CUT = 0.02;              // what waxdaomarket keeps of a sale
const nonce = () => Math.floor(Math.random() * 2 ** 31);

// "7499.00000000 OWLZ" — kept in integer units so a quantity of 57 is the
// contract's own arithmetic and not a float's idea of it.
function assetParts(q) {
  const [amtStr = '0', symbol = ''] = String(q || '').trim().split(' ');
  const [whole = '0', frac = ''] = amtStr.split('.');
  return {
    units: BigInt((whole.replace(/[^0-9]/g, '') || '0') + frac),
    decimals: frac.length, symbol, amount: parseFloat(amtStr) || 0,
  };
}

const unitsToAsset = (units, decimals, symbol) => {
  const s = units.toString().padStart(decimals + 1, '0');
  return `${decimals ? `${s.slice(0, -decimals)}.${s.slice(-decimals)}` : s} ${symbol}`;
};

// What n of a drop costs, exactly as the contract will count it.
export function dropCost(drop, count = 1) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  return { count: n, quantity: unitsToAsset(drop.priceUnits * BigInt(n), drop.priceDecimals, drop.priceSymbol), amount: drop.price * n };
}

export async function waxdaoDrops({ now = Date.now(), openOnly = true } = {}) {
  let rows = [];
  try { rows = await getAllRows(WAXDAO_MARKET, WAXDAO_MARKET, 'drops'); } catch { return []; }
  const sec = now / 1000;
  return rows
    .map(d => {
      const price = assetParts(d.price);
      return {
        id: Number(d.ID),
        creator: d.user,
        price: price.amount, priceSymbol: price.symbol, priceContract: d.contract,
        priceUnits: price.units, priceDecimals: price.decimals,
        free: !(price.amount > 0),
        collection: d.collection, schema: d.schema, templateId: Number(d.template_id),
        // total_available 0 means unlimited, and the counter then wraps below
        // zero — 4,294,966,109 left is not a number to put on a screen.
        total: Number(d.total_available), left: Number(d.total_available) ? Number(d.total_left) : null,
        perUser: Number(d.limit_per_user), cooldown: Number(d.cooldown),
        whitelist: d.whitelist_type, allowedUsers: (d.allowed_users || []).filter(Boolean),
        farm: d.farmname && d.farmname !== 'na' ? d.farmname : '', minStake: Number(d.minimum_to_stake),
        startsAt: Number(d.start_time) * 1000, endsAt: Number(d.end_time) * 1000,
        description: d.drop_description || '', logo: d.drop_logo || '',
        type: d.drop_type || '', receiver: d.receiver && d.receiver !== 'na' ? d.receiver : '',
        // A preminted pack hands over an asset somebody put in a pool instead
        // of minting a template, so its stock is that pool's, not a template's.
        premintPool: d.drop_type === 'premint.pack' ? Number((d.other || [])[0]) || null : null,
        toPool: Number(d.percent_to_pool) || 0, poolKind: d.pool_or_farm, poolName: d.pool_or_farm_name,
      };
    })
    .filter(d => !openOnly || (d.startsAt / 1000 <= sec && d.endsAt / 1000 > sec && (d.left == null || d.left > 0)))
    .sort((a, b) => b.id - a.id);
}

// Can this drop still hand over what it promises? Three things can be false
// while the drop itself looks open: the collection has since dropped
// waxdaomarket as a minter, the template has hit its own maximum, or the
// preminted pool behind a pack is empty. Read before signing, not after.
export async function dropReadiness(drop) {
  const out = { minter: null, template: null, premint: null };
  const jobs = [
    getRows('atomicassets', 'atomicassets', 'collections', { lower: drop.collection, limit: 1 })
      .then(d => {
        const r = d.rows?.[0];
        if (r?.collection_name === drop.collection) out.minter = (r.authorized_accounts || []).includes(WAXDAO_MARKET);
      }).catch(() => {}),
  ];
  if (drop.templateId > 0) {
    jobs.push(getRows('atomicassets', drop.collection, 'templates', { lower: String(drop.templateId), limit: 1 })
      .then(d => {
        const r = d.rows?.[0];
        if (Number(r?.template_id) === drop.templateId) {
          out.template = { issued: Number(r.issued_supply) || 0, max: Number(r.max_supply) || 0, schema: r.schema_name };
        }
      }).catch(() => {}));
  }
  if (drop.premintPool) {
    jobs.push(getRows(WAXDAO_MARKET, WAXDAO_MARKET, 'premintpools', { lower: String(drop.premintPool), limit: 1 })
      .then(d => {
        const r = d.rows?.[0];
        if (Number(r?.ID) === drop.premintPool) out.premint = { left: Number(r.amount_of_assets) || 0, name: r.display_name || '' };
      }).catch(() => {}));
  }
  await Promise.all(jobs);
  return out;
}

// What stock is actually left, whichever thing holds it.
export function dropStock(drop, ready) {
  if (drop.premintPool) return ready?.premint ? ready.premint.left : null;
  if (drop.left != null) return drop.left;
  const t = ready?.template;
  if (t && t.max > 0) return Math.max(0, t.max - t.issued);
  return null;                                   // unlimited, as far as anything here knows
}

// The claim the contract's own history used 1,340 times. `unique_id` is the
// caller's nonce; WaxDAO's own front end sent a random one.
export function buildDropClaim({ account, dropId, count = 1 }) {
  return [{
    account: WAXDAO_MARKET, name: 'claimdrop',
    authorization: [{ actor: account, permission: 'active' }],
    data: {
      drop_ID: Number(dropId), user: account, quantity_to_mint: Math.max(1, Math.round(count)),
      unique_id: nonce(),
    },
  }];
}

// A paid claim: say what you are taking, then pay for it. Both actions carry
// the buyer's own authority and both are in the same transaction — the
// contract reads the assertion when the transfer arrives, so one without the
// other is either a refused transfer or a payment for nothing.
export function buildDropPurchase({ account, drop, count = 1 }) {
  const cost = dropCost(drop, count);
  const auth = [{ actor: account, permission: 'active' }];
  return [
    {
      account: WAXDAO_MARKET, name: 'assertdrop', authorization: auth,
      data: { drop_ID: Number(drop.id), user: account, quantity_to_assert: cost.count },
    },
    {
      account: drop.priceContract, name: 'transfer', authorization: auth,
      data: { from: account, to: WAXDAO_MARKET, quantity: cost.quantity, memo: `|purchase_drop|${drop.id}|${nonce()}|` },
    },
  ];
}
