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

const qty = (n, d = 4) => Number(n).toFixed(d);

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
    }))
    .sort((a, b) => a.position - b.position);
  return { slot: slot * 1000, banners, free: here.length - banners.length };
}
