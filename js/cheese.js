// =============================================================================
// CHEESEHUB — the sister site's services, used rather than reimplemented.
//
// CheeseHub already runs three things this terminal would otherwise have to
// build: resources paid for in CHEESE (cheesepowerz for CPU and NET, ram.chz
// for RAM) and a banner slot people buy on chain (cheesebannad). Everything
// here is an ordinary token transfer with a memo, so nothing needs their
// permission or their uptime — and using the same contracts keeps one cheese
// umbrella over both sites instead of two competing ones.
// =============================================================================

import { getRows } from './chain.js';

export const CHEESE = { symbol: 'CHEESE', contract: 'cheeseburger', decimals: 4 };
export const POWERUP_ACCOUNT = 'cheesepowerz';
export const RAM_ACCOUNT = 'ram.chz';
const BANNER_CONTRACT = 'cheesebannad';

// Rounded down: a transfer of a hair more than the wallet holds reverts.
const qty = (n, d = 4) => (Math.floor(Number(n) * 10 ** d + 1e-9) / 10 ** d).toFixed(d);

// CPU, NET or a split of the two. The memo shapes are the contract's, read off
// CheeseHub's own transfers: "cpu:60,net:40:receiver", "net:receiver", or just
// the receiver for plain CPU.
export function buildCheesePowerup({ account, amount, receiver = '', cpuPct = 100 }) {
  const to = receiver || account;
  const cpu = Math.max(0, Math.min(100, Math.round(cpuPct)));
  const net = 100 - cpu;
  const memo = cpu > 0 && net > 0 ? `cpu:${cpu},net:${net}:${to}` : net > 0 ? `net:${to}` : to;
  return [{
    account: CHEESE.contract, name: 'transfer',
    authorization: [{ actor: account, permission: 'active' }],
    data: { from: account, to: POWERUP_ACCOUNT, quantity: `${qty(amount)} ${CHEESE.symbol}`, memo },
  }];
}

// RAM is bought, not rented: CHEESE to ram.chz, memo is whoever gets the bytes.
export function buildCheeseRam({ account, amount, receiver = '' }) {
  return [{
    account: CHEESE.contract, name: 'transfer',
    authorization: [{ actor: account, permission: 'active' }],
    data: { from: account, to: RAM_ACCOUNT, quantity: `${qty(amount)} ${CHEESE.symbol}`, memo: receiver || account },
  }];
}

// What the service has actually done, which is the only honest way to quote a
// rate: it is not a price list, it is a lifetime average.
export async function powerupStats() {
  try {
    const d = await getRows(POWERUP_ACCOUNT, POWERUP_ACCOUNT, 'stats', { limit: 1 });
    const r = (d.rows || [])[0];
    if (!r) return null;
    const cheese = parseFloat(String(r.total_cheese_received || '0')) || 0;
    const wax = parseFloat(String(r.total_wax_spent || '0')) || 0;
    return { powerups: Number(r.total_powerups) || 0, cheese, wax, waxPerCheese: cheese > 0 ? wax / cheese : null };
  } catch { return null; }
}

// ------------------------------------------------------------- banner slots --
// Slots are daily and start at 14:00 UTC; each row is one position in one day.
// A row with no image is an unsold slot, which is worth knowing: it is the
// thing a reader can go and buy.
export async function currentBanners({ now = Date.now() } = {}) {
  let rows = [];
  try {
    const d = await getRows(BANNER_CONTRACT, BANNER_CONTRACT, 'bannerads', { limit: 1000 });
    rows = d.rows || [];
  } catch { return { slot: null, banners: [], free: 0 }; }
  const sec = Math.floor(now / 1000);
  const times = [...new Set(rows.map(r => Number(r.time)))].sort((a, b) => a - b);
  const slot = [...times].reverse().find(t => t <= sec) ?? null;
  if (slot == null) return { slot: null, banners: [], free: 0 };
  const here = rows.filter(r => Number(r.time) === slot);
  const banners = here
    .filter(r => r.ipfs_hash && !Number(r.suspended) && r.user !== BANNER_CONTRACT)
    .map(r => ({
      position: Number(r.position), user: r.user,
      img: r.ipfs_hash, url: r.website_url || '',
      shared: r.shared_user ? { user: r.shared_user, img: r.shared_ipfs_hash, url: r.shared_website_url } : null,
      // Rented as half a spot. Until somebody takes the other half it is
      // still half a spot, not a whole one at the half price.
      rentalShared: Number(r.rental_type) === 1,
    }))
    .sort((a, b) => a.position - b.position);
  // Every position of the running day as CheeseHub reads it (its
  // BannerDisplay): the renter's banner, the shared renter's, and whether a
  // shared spot still has an unsold half.
  const positions = here.map(r => ({
    position: Number(r.position),
    suspended: !!Number(r.suspended) || r.suspended === true,
    user: r.user, ipfs: r.ipfs_hash || '', url: r.website_url || '',
    shared: Number(r.rental_type) === 1,
    sharedUser: r.shared_user || '', sharedIpfs: r.shared_ipfs_hash || '', sharedUrl: r.shared_website_url || '',
  })).sort((a, b) => a.position - b.position);
  return { slot: slot * 1000, banners, positions, free: here.length - banners.length };
}

// ------------------------------------------------------------ renting a slot --
// Read off the deployed cheesebannad contract (its ABI, not the README, which
// names an action that does not exist): a slot is rented by sending WAX with
// the memo `banner|<slot start>|<days>|<position>|<mode>`, and its picture is
// set afterwards with editadbanner — or editsharedad for the second renter of
// a shared slot. Mode e is the whole slot, s is half of one at 70% of the
// price, j joins someone else's half. The contract refuses e and s less than
// 48 hours before the slot starts, and j less than 12.
export const BANNER_ACCOUNT = BANNER_CONTRACT;
export const RENT_LEAD_SEC = 48 * 3600;
export const JOIN_LEAD_SEC = 12 * 3600;
const WAX_UNITS = 1e8;

export async function bannerCalendar({ now = Date.now() } = {}) {
  const [ads, cfg] = await Promise.all([
    getRows(BANNER_CONTRACT, BANNER_CONTRACT, 'bannerads', { limit: 1000 }),
    getRows(BANNER_CONTRACT, BANNER_CONTRACT, 'config', { limit: 1 }).catch(() => ({ rows: [] })),
  ]);
  // The price as the contract counts it: integer units, shared at 70/100.
  const priceUnits = Math.round((parseFloat(String(cfg.rows?.[0]?.wax_price_per_day || '100')) || 100) * WAX_UNITS);
  const sec = now / 1000;
  const slots = (ads.rows || [])
    .map(r => ({
      time: Number(r.time), position: Number(r.position),
      user: r.user === BANNER_CONTRACT ? null : r.user,
      shared: Number(r.rental_type) === 1,
      sharedUser: r.shared_user || null,
      img: r.ipfs_hash || '', url: r.website_url || '',
      sharedImg: r.shared_ipfs_hash || '', sharedUrl: r.shared_website_url || '',
      suspended: !!Number(r.suspended) || r.suspended === true,
    }))
    .filter(r => r.time + 86400 > sec)
    .sort((a, b) => a.time - b.time || a.position - b.position);
  return { priceUnits, sharedUnits: Math.floor(priceUnits * 70 / 100), slots };
}

// One transfer per run of consecutive days on the same position and mode.
export function buildBannerRent({ account, picks, priceUnits }) {
  const auth = [{ actor: account, permission: 'active' }];
  const groups = new Map();
  for (const p of picks) {
    const k = `${p.position}|${p.mode}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p.time);
  }
  const actions = [];
  let total = 0;
  for (const [k, times] of groups) {
    const [position, mode] = k.split('|');
    const unit = mode === 'e' ? priceUnits : Math.floor(priceUnits * 70 / 100);
    times.sort((a, b) => a - b);
    let start = times[0], n = 1;
    const flush = () => {
      const units = unit * n;
      total += units;
      actions.push({
        account: 'eosio.token', name: 'transfer', authorization: auth,
        data: { from: account, to: BANNER_CONTRACT, quantity: `${(units / WAX_UNITS).toFixed(8)} WAX`, memo: `banner|${start}|${n}|${position}|${mode}` },
      });
    };
    for (let i = 1; i < times.length; i++) {
      if (times[i] === start + n * 86400) { n++; continue; }
      flush(); start = times[i]; n = 1;
    }
    flush();
  }
  return { actions, totalWax: total / WAX_UNITS };
}

export function buildBannerEdit({ account, slots, ipfs, url }) {
  const auth = [{ actor: account, permission: 'active' }];
  return slots.map(s => ({
    account: BANNER_CONTRACT, name: s.secondary ? 'editsharedad' : 'editadbanner', authorization: auth,
    data: { user: account, start_time: s.time, position: s.position, ipfs_hash: ipfs, website_url: url },
  }));
}
