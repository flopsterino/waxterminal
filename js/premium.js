// Premium without a backend.
//
// The whole terminal is a static site read from public nodes, so there is
// nowhere to keep a subscriber list and no account to log into. The only fact
// both sides can already agree on is what the chain says the visitor holds, so
// entitlement is a balance or an NFT, checked in the browser against the same
// nodes everything else uses.
//
// This is deliberately not a paywall on the truth. Premium never changes a
// number, hides a warning, or shortens a table of results the free view would
// have shown as wrong — it lifts caps on depth and adds convenience. A free
// visitor gets a complete, honest terminal; a holder gets more of it at once.
// Gating the numbers themselves would make the free tier a worse answer rather
// than a smaller one, which is exactly how a free tier drives people away.
import { balanceOf, getRows } from './chain.js';

let cfg = null;
let cached = { account: null, ok: false, reason: 'not checked', held: null };
const listeners = new Set();

export const onPremium = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const announce = () => { for (const fn of listeners) { try { fn(cached); } catch {} } };

export function configurePremium(commercial) {
  cfg = commercial?.premium || null;
  if (!cfg?.enabled) cfg = null;
  return cfg;
}

export const premiumConfigured = () => !!cfg;
export const isPremium = () => cached.ok;
export const premiumState = () => ({ ...cached, cfg });

// What a holder must have, said plainly, so the offer is legible before anyone
// connects a wallet.
export function premiumTerms() {
  if (!cfg) return null;
  if (cfg.token) return `${Number(cfg.token.min).toLocaleString()} ${cfg.token.symbol}`;
  if (cfg.collection) return `any ${cfg.collection} NFT`;
  return null;
}

export async function checkPremium(account) {
  if (!cfg) { cached = { account, ok: false, reason: 'no premium tier configured', held: null }; announce(); return cached; }
  if (!account) { cached = { account: null, ok: false, reason: 'no wallet connected', held: null }; announce(); return cached; }
  try {
    if (cfg.token) {
      const held = await balanceOf(account, cfg.token.contract, cfg.token.symbol);
      const need = Number(cfg.token.min) || 0;
      cached = { account, ok: held >= need, held, need, reason: held >= need ? 'holds enough' : 'below the threshold' };
    } else if (cfg.collection) {
      // atomicassets keeps one row per asset scoped by owner, so ownership is a
      // table read rather than an API call — no third party in the path. The
      // table is keyed by asset_id with no index on the collection, so a holder
      // of more than one page has to be walked: stopping at the first thousand
      // would deny anyone whose matching asset happens to sort late.
      let n = 0, lower = null, exhausted = false;
      for (let page = 0; page < 12; page++) {
        const res = await getRows('atomicassets', account, 'assets', { limit: 1000, lower });
        const rows = res?.rows || [];
        n += rows.filter(r => r.collection_name === cfg.collection).length;
        if (n > 0) { exhausted = true; break; }              // one is enough
        if (rows.length < 1000 || !res?.more) { exhausted = true; break; }
        lower = res.next_key;
      }
      cached = { account, ok: n > 0, held: n, need: 1,
        reason: n > 0 ? 'owns one' : exhausted ? 'owns none' : 'owns none in the first 12,000 checked' };
    } else {
      cached = { account, ok: false, reason: 'premium tier is misconfigured', held: null };
    }
  } catch (e) {
    // A node that will not answer must not silently demote a paying holder into
    // a free visitor with no explanation.
    cached = { account, ok: false, reason: `could not check: ${e.message}`, held: null, errored: true };
  }
  announce();
  return cached;
}

// Every cap in one place, so the free tier can be read off at a glance instead
// of being scattered through the views as bare numbers.
const CAPS = {
  pools:      { free: 400,  premium: Infinity },
  tokens:     { free: 300,  premium: Infinity },
  farms:      { free: 250,  premium: Infinity },
  routes:     { free: 40,   premium: 400 },
  swaps:      { free: 150,  premium: 1000 },
  holders:    { free: 50,   premium: 200 },
  historyDays:{ free: 90,   premium: Infinity },
};

export const cap = name => {
  const c = CAPS[name];
  if (!c) return Infinity;
  return cached.ok ? c.premium : c.free;
};

export const capsTable = () => Object.entries(CAPS).map(([k, v]) => ({ k, ...v }));
