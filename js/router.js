// =============================================================================
// ROUTER — ask Alcor's own router where a swap should go.
//
// We used to answer that question ourselves, from the pool graph, ranking
// routes by the depth a nightly pass had measured. That is a model of Alcor's
// liquidity, and a coarse one: three quarters of pools have no measured depth
// at all, so they fell back to half a percent of pooled value. A model is only
// ever as good as its last refresh, and this one sent a $20 swap through a pool
// holding $8 — the chain refused it, correctly, with "Received lower than
// minTokenOut".
//
// Alcor's router walks the real ticks in the current state and returns the
// route, the exact output, and the memo that executes it. It is the same
// endpoint their own front end uses, so by construction it cannot disagree with
// what the contract will do. It also finds routes ours does not: for WAX into
// PXJ it returns a single pool, where our graph picked two.
//
// Their answer is authoritative but not guaranteed — it is one host, behind
// Cloudflare, that can be slow or down. So every quote falls back to the local
// graph, and the caller is told which one it got. A static site that hard-
// depends on one endpoint is broken whenever that endpoint is.
//
// ON RATE LIMITS. This runs in the visitor's browser, so the requests come from
// their address, not ours. But the person most likely to have this page open is
// also running trading bots against the same host from the same address, and
// Cloudflare counts the address. Hence: a 15-second cache, one in-flight
// request per distinct question, a hard floor between calls, and a caller-side
// debounce. A panel being typed into settles to about one request.
// =============================================================================

const API = 'https://wax.alcor.exchange/api/v2/swapRouter/getRoute';
const TTL_MS = 15000;
const MIN_GAP_MS = 250;      // never more than four calls a second, ever
const TIMEOUT_MS = 8000;

const cache = new Map();     // key -> { at, val }
const inflight = new Map();  // key -> Promise
let lastCall = 0;

// Alcor names a token `symbol-contract`, lower case. Ours is `SYMBOL@contract`.
export const alcorToken = meta => `${String(meta.symbol).toLowerCase()}-${meta.contract}`;

// A memo is an instruction to move someone's money, so it is parsed and checked
// rather than pasted. The shape is
//   swapexactin#<pool ids>#<receiver>#<min out> SYM@contract#<deadline>
export function parseMemo(memo) {
  const p = String(memo || '').split('#');
  if (p.length < 5 || p[0] !== 'swapexactin') return null;
  const [amtSym, contract] = String(p[3]).split('@');
  const sp = String(amtSym).trim().split(/\s+/);
  if (sp.length !== 2 || !contract) return null;
  const min = Number(sp[0]);
  if (!Number.isFinite(min)) return null;
  return { route: p[1].split(',').map(Number), receiver: p[2], min, symbol: sp[1], contract };
}

const parseAsset = s => Number(String(s || '').trim().split(/\s+/)[0]);

async function gap() {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
}

// Ask for a route. Resolves to null when Alcor cannot answer — never throws for
// a routing failure, because the caller has a local fallback for exactly that.
//
// `amount` is in whole tokens and must be the amount actually sent: the quote
// is for that size and no other.
export async function quote({ from, to, amount, slippagePct = 2, receiver, maxHops = 3 }) {
  if (!from?.contract || !to?.contract || !(amount > 0) || !receiver) return null;
  const key = `${alcorToken(from)}>${alcorToken(to)}|${amount}|${slippagePct}|${receiver}|${maxHops}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.val;
  if (inflight.has(key)) return inflight.get(key);

  const run = (async () => {
    await gap();
    const url = `${API}?trade_type=EXACT_INPUT&input=${encodeURIComponent(alcorToken(from))}`
      + `&output=${encodeURIComponent(alcorToken(to))}&amount=${amount}`
      + `&slippage=${slippagePct}&receiver=${encodeURIComponent(receiver)}&maxHops=${maxHops}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      // Routing failures come back as plain text ("No trading route available"),
      // not JSON, so the body is read once and only then parsed.
      const body = await res.text();
      if (!res.ok) return null;
      let d;
      try { d = JSON.parse(body); } catch { return null; }
      if (!d || !Array.isArray(d.swaps) || !d.swaps.length) return null;

      // One send per leg. Alcor may split an order across routes, and each part
      // carries its own memo and its own share of the input.
      const sends = [];
      for (const s of d.swaps) {
        const m = parseMemo(s.memo);
        // Every check here is about someone else's money landing somewhere we
        // did not ask for. A memo naming a different receiver, or a different
        // token than the one we are buying, is not used — it is discarded and
        // the local route takes over.
        if (!m) return null;
        if (m.receiver !== receiver) return null;
        if (m.contract !== to.contract) return null;
        if (String(m.symbol).toUpperCase() !== String(to.symbol).toUpperCase()) return null;
        const input = parseAsset(s.input);
        if (!(input > 0)) return null;
        // The leg spends the token we said we were spending, or it spends
        // something else of the holder's.
        const inSym = String(s.input).trim().split(/\s+/)[1];
        if (String(inSym).toUpperCase() !== String(from.symbol).toUpperCase()) return null;
        // Keep Alcor's own amount string rather than reformatting it: it is
        // already at the token's precision and the quote is for exactly it.
        sends.push({ input, inputAsset: String(s.input).trim(), memo: s.memo, route: m.route, expect: parseAsset(s.output), min: m.min });
      }
      // The parts must add up to what we asked to spend, or we would be sending
      // an amount the quote was not for.
      const spent = sends.reduce((a, s) => a + s.input, 0);
      if (Math.abs(spent - amount) / amount > 1e-6) return null;

      const val = {
        source: 'alcor',
        sends,
        route: sends.flatMap(s => s.route),
        expect: parseAsset(d.output),
        min: sends.reduce((a, s) => a + s.min, 0),
        // Alcor reports impact in per cent; everything downstream uses a fraction.
        impact: Number(d.priceImpact) / 100 || 0,
        hops: Math.max(...sends.map(s => s.route.length)),
        split: sends.length > 1,
      };
      cache.set(key, { at: Date.now(), val });
      return val;
    } catch {
      return null;                     // timeout, offline, blocked — fall back
    } finally {
      clearTimeout(timer);
      inflight.delete(key);
    }
  })();

  inflight.set(key, run);
  return run;
}

// For a panel that repaints on every keystroke: wait until typing settles.
export function debounce(fn, ms = 350) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
