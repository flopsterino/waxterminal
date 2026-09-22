// =============================================================================
// RATINGS — 🔥 💩 🚩 🚀, and each one costs something.
//
// A free vote button is a bot's playground: the first person to write a loop
// decides what every visitor sees, for nothing. So a vote here is a transfer —
// a small amount of the house token to the house account, with the subject and
// the verdict in the memo. The chain is the ballot box: anyone can recount it,
// nobody can quietly rewrite it, and a thousand fake votes cost a thousand
// times the fee.
//
//   memo: rate:t:CHEESE@cheeseburger:fire
//         rate:p:alcor:1015:rocket
//
// One account, one standing vote per subject: the newest transfer from an
// account replaces its earlier one, so changing your mind costs the fee again
// and stuffing the ballot costs the fee every time. Votes older than the
// window stop counting, because a rug's reputation should not be decided by
// how it looked last spring.
// =============================================================================

import { hyperion, dropEchoes } from './chain.js';

export const VOTES = [
  { key: 'rocket', emoji: '🚀', label: 'Going up' },
  { key: 'fire', emoji: '🔥', label: 'Hot right now' },
  { key: 'poo', emoji: '💩', label: 'Rubbish' },
  { key: 'flag', emoji: '🚩', label: 'Something is wrong here' },
];
const KEYS = new Set(VOTES.map(v => v.key));

let cfg = null;
export function configureRatings(commercial) {
  const r = commercial?.rating;
  cfg = (r?.enabled !== false && r?.account && r?.token?.symbol && r?.token?.contract && r?.price > 0) ? r : null;
  return cfg;
}
export const ratingsConfigured = () => !!cfg;
export const ratingTerms = () => cfg
  ? { symbol: cfg.token.symbol, contract: cfg.token.contract, account: cfg.account, price: cfg.price, prefix: cfg.memoPrefix || 'rate' }
  : null;

export const ratingSubject = (kind, id) => `${kind}:${id}`;
export const ratingMemo = (subject, vote) => (cfg ? `${cfg.memoPrefix || 'rate'}:${subject}:${vote}` : null);

// `decimals` is passed in by the caller wherever the chain's own answer is at
// hand, because a token's precision is a fact about the token and not a
// setting: HOLE is 8, the config said 4, and the contract rejected every vote
// with "symbol precision mismatch".
export function buildRatingVote({ account, subject, vote, decimals = null, auth = null }) {
  if (!cfg) throw new Error('Ratings are not configured');
  if (!KEYS.has(vote)) throw new Error('Unknown vote');
  auth = auth || [{ actor: account, permission: 'active' }];
  const dec = Number.isInteger(decimals) ? decimals : (cfg.token.decimals ?? 4);
  return [{
    account: cfg.token.contract, name: 'transfer', authorization: auth,
    data: {
      from: account, to: cfg.account,
      quantity: `${Number(cfg.price).toFixed(dec)} ${cfg.token.symbol}`,
      memo: ratingMemo(subject, vote),
    },
  }];
}

// The rating people see is TODAY's. A vote is a sentiment, not a certificate:
// letting one buy-in stand forever is exactly how a project pays once and
// wears "legit" for a year, so the headline counts only the last 24 hours and
// everything before that becomes history you can still look at.
const DAY_MS = 86400000;
const WINDOW_DAYS = 90;
let cache = null, cacheAt = 0;

export async function loadRatings({ maxAgeMs = 4 * 60 * 1000 } = {}) {
  if (!cfg) return new Map();
  if (cache && Date.now() - cacheAt < maxAgeMs) return cache;
  const prefix = `${cfg.memoPrefix || 'rate'}:`;
  const after = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();

  const rows = [];
  for (let page = 0; page < 3; page++) {
    let d;
    try {
      // Only what was sent to the rating account. Unfiltered this read every
      // HOLE transfer on the chain — 4,637 in 90 days against 23 to the rating
      // account — three pages of a thousand on every page load, which is how a
      // public Hyperion starts answering 429.
      d = await hyperion(`/v2/history/get_actions?${new URLSearchParams({
        'act.account': cfg.token.contract, 'act.name': 'transfer', 'transfer.to': cfg.account, after,
        limit: '1000', skip: String(page * 1000), sort: 'desc',
      })}`);
    } catch { break; }
    const got = d.actions || [];
    rows.push(...got);
    if (got.length < 1000) break;
  }

  // Newest first from Hyperion, so the first vote seen from an account on a
  // subject is that account's standing vote in whichever window it falls in.
  const dayBallots = new Set(), allBallots = new Set();
  const out = new Map();               // subject -> tallies
  const cutoff = Date.now() - DAY_MS;
  const blank = () => ({ rocket: 0, fire: 0, poo: 0, flag: 0, voters: 0 });
  for (const a of dropEchoes(rows)) {
    const x = a.act?.data;
    if (!x || x.to !== cfg.account) continue;
    const memo = String(x.memo || '').trim();
    if (!memo.toLowerCase().startsWith(prefix)) continue;
    const [amtStr, sym] = String(x.quantity || '').split(' ');
    if (sym !== cfg.token.symbol) continue;
    // Underpaying is not voting. Anything at or above the price counts once.
    if ((parseFloat(amtStr) || 0) + 1e-9 < Number(cfg.price)) continue;

    const rest = memo.slice(prefix.length).split(':');
    const vote = (rest.pop() || '').toLowerCase();
    const subject = rest.join(':').trim();
    if (!subject || !KEYS.has(vote)) continue;

    const at = new Date(a.timestamp + (a.timestamp.endsWith('Z') ? '' : 'Z')).getTime();
    const ballot = `${x.from}|${subject}`;
    const t = out.get(subject) || { ...blank(), all: blank(), last: 0, mine: new Map() };

    if (at >= cutoff && !dayBallots.has(ballot)) {
      dayBallots.add(ballot);
      t[vote]++; t.voters++;
      // With the time on it, so the page can say when it frees up rather than
      // leaving a button lit and looking permanent.
      t.mine.set(x.from, { vote, at });
    }
    if (!allBallots.has(ballot)) {
      allBallots.add(ballot);
      t.all[vote]++; t.all.voters++;
    }
    if (at > t.last) t.last = at;
    out.set(subject, t);
  }
  cache = out; cacheAt = Date.now();
  return out;
}

export const RATING_WINDOW_HOURS = 24;

// After a vote lands, show it immediately rather than waiting for the history
// node to index the transfer — which takes a few seconds and reads as a
// button that did nothing.
export function applyLocalVote(subject, vote, account) {
  if (!cache) cache = new Map();
  const t = cache.get(subject) || { rocket: 0, fire: 0, poo: 0, flag: 0, voters: 0, all: { rocket: 0, fire: 0, poo: 0, flag: 0, voters: 0 }, last: 0, mine: new Map() };
  t.mine = t.mine || new Map();
  t.all = t.all || { rocket: 0, fire: 0, poo: 0, flag: 0, voters: 0 };
  const prev = myVote(t, account);
  const had = prev?.vote;
  if (had === vote) return t;
  if (had) { t[had] = Math.max(0, t[had] - 1); t.all[had] = Math.max(0, t.all[had] - 1); } else { t.voters++; t.all.voters++; }
  t[vote]++; t.all[vote]++;
  t.mine.set(account, { vote, at: Date.now() });
  t.last = Date.now();
  cache.set(subject, t);
  return t;
}

export const ratingsFor = subject => (cache ? cache.get(subject) || null : null);

// One account's standing vote on a subject, if it still counts. A vote is
// worth a day: after that the subject is open for that account again, which is
// the whole point of a rolling window — sentiment people renew, not a badge
// somebody bought once.
export function myVote(t, account) {
  if (!t || !account) return null;
  const v = t.mine?.get(account);
  if (!v) return null;
  const rec = typeof v === 'string' ? { vote: v, at: t.last || Date.now() } : v;
  const left = rec.at + DAY_MS - Date.now();
  return left > 0 ? { ...rec, msLeft: left } : null;
}
