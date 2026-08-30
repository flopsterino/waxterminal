// Which taxed tokens actually charge a fee when a HOLDER deposits into
// swap.alcor? The tables do not answer this: chadtoken.gm calls its list
// "ignored_senders" but a real 16.1M CHAD deposit from a plain account paid
// nothing, while buzzingarden scopes "exempted" by a hashed key that does not
// contain swap.alcor. So ask the chain instead of the ABI — find real deposits
// and look for a fee transfer riding alongside.
const HYP = process.env.HYPERION || 'https://wax.eosusa.io';
const VENUE = 'swap.alcor';
// Senders that are exempt for reasons that do not generalise to a holder: other
// venues, and the arb accounts that negotiated their own exemption.
const NOT_REPRESENTATIVE = new Set([
  'swap.alcor', 'swap.taco', 'swap.box', 'swap.we', 'swap.nefty', 'swap.adex',
  'alcordexmain', 'reward.alcor', 'eldrinvale12', 'eosio.null',
]);
// A second leg of a multi-hop route is not a fee. NEWS looked taxed because the
// same account also sent to swap.we in the same transaction — 247,598 of it,
// against a 0.10% rate. A fee is small and goes somewhere that is not a venue.
const VENUES = new Set(['swap.we', 'swap.nefty', 'swap.taco', 'swap.box', 'swap.adex', 'alcordexmain']);
const amountOf = q => Number(String(q).split(' ')[0]) || 0;

async function get(path) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(HYP + path, { signal: AbortSignal.timeout(30000) });
      if (r.ok) return await r.json();
    } catch {}
  }
  return null;
}

export async function probeToken(symbol, contract, { pages = 4 } = {}) {
  const samples = [];
  for (let skip = 0; skip < pages * 1000 && samples.length < 3; skip += 1000) {
    const j = await get(`/v2/history/get_actions?account=${VENUE}&act.account=${contract}` +
      `&act.name=transfer&limit=1000&skip=${skip}&sort=desc`);
    const acts = j?.actions || [];
    if (!acts.length) break;
    for (const a of acts) {
      const d = a.act.data;
      if (d.to !== VENUE) continue;
      if (NOT_REPRESENTATIVE.has(d.from)) continue;
      if (!String(d.quantity || '').endsWith(' ' + symbol)) continue;
      samples.push(a);
      if (samples.length >= 3) break;
    }
  }
  if (!samples.length) return { symbol, contract, verdict: 'unknown', reason: 'no holder deposit found' };

  for (const s of samples) {
    const t = await get(`/v2/history/get_transaction?id=${s.trx_id}`);
    if (!t) continue;
    const seen = new Set();
    const transfers = [];
    for (const a of (t.actions || [])) {
      if (a.act.name !== 'transfer') continue;
      if (seen.has(a.global_sequence)) continue;   // notifications repeat the action
      seen.add(a.global_sequence);
      if (!String(a.act.data.quantity || '').endsWith(' ' + symbol)) continue;
      transfers.push(a.act.data);
    }
    const from = s.act.data.from;
    const sent = amountOf(s.act.data.quantity);
    const fee = transfers.filter(d => d.from === from && d.to !== VENUE
      && !VENUES.has(d.to)
      && amountOf(d.quantity) > 0 && amountOf(d.quantity) < sent * 0.25);
    if (fee.length) {
      const paidPct = 100 * fee.reduce((a, f) => a + amountOf(f.quantity), 0) / sent;
      return { symbol, contract, verdict: 'taxed', sender: from, paidPct,
        paid: fee.map(f => `${f.quantity} -> ${f.to}`).join(', '), sample: s.trx_id };
    }
  }
  return { symbol, contract, verdict: 'exempt', sender: samples[0].act.data.from, sample: samples[0].trx_id };
}
