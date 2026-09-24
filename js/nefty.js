// =============================================================================
// NEFTYBLOCKS BLENDS — the recipes on blend.nefty, and doing one.
//
// The list comes from the daily job (tools/nefty.mjs): an index with the newest
// recipes and every collection, and one file per collection. Blending re-reads
// the one recipe from the chain first, so a limit reached this afternoon is
// found here and not in a failed transaction.
//
// A blend is one transaction, in the order the contract expects (read off real
// blends, e.g. 0bd9c4aa… on 2026-09-20):
//   blend.nefty::openbal          once per token the recipe takes
//   <token>::transfer             memo "deposit"
//   blend.nefty::announcedepo     how many NFTs are coming
//   atomicassets::transfer        memo "deposit"
//   blend.nefty::nosecfuse        or ::fuse with an ownership proof
// =============================================================================

import { getRows } from './chain.js';

const BLEND = 'blend.nefty';
const AA = 'https://wax.api.atomicassets.io/atomicassets/v1';

let indexP = null;
const cols = new Map();
export function neftyIndex() {
  if (!indexP) indexP = fetch('data/nefty/index.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  return indexP;
}
export function neftyCollection(col) {
  if (!cols.has(col)) {
    cols.set(col, fetch(`data/nefty/c/${encodeURIComponent(col)}.json`, { cache: 'no-cache' })
      .then(r => (r.ok ? r.json() : null)).catch(() => null));
  }
  return cols.get(col);
}

// The recipe as the chain holds it right now: still there, still under its cap.
export async function neftyLive(id) {
  const r = (await getRows(BLEND, BLEND, 'blends', { lower: id, limit: 1 })).rows?.[0];
  if (!r || Number(r.blend_id) !== Number(id)) return null;
  const max = Number(r.max) || 0, used = Number(r.use_count) || 0;
  return { max, used, left: max ? Math.max(0, max - used) : null, hidden: !!Number(r.is_hidden) };
}

// ---- which of the wallet's NFTs would do ----------------------------------
// One AtomicAssets query per ingredient. An attribute ingredient is asked for
// by collection and schema and then checked against the allowed values here,
// because a list of allowed values is not something the API can be asked.
export async function neftyCandidates(account, ing, { limit = 100 } = {}) {
  if (!account || ing.kind === 'ft') return [];
  const q = new URLSearchParams({ owner: account, limit: String(limit), order: 'asc', sort: 'asset_id' });
  if (ing.collection) q.set('collection_name', ing.collection);
  if (ing.schema) q.set('schema_name', ing.schema);
  if (ing.templateId) q.set('template_id', String(ing.templateId));
  const r = await fetch(`${AA}/assets?${q}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`AtomicAssets ${r.status}`);
  let list = (await r.json()).data || [];
  if (ing.kind === 'attribute') {
    list = list.filter(a => (ing.attrs || []).every(at => at.values.map(String).includes(String(a.data?.[at.name] ?? ''))));
  }
  return list.map(a => ({
    id: a.asset_id,
    name: a.name || a.template?.immutable_data?.name || `#${a.asset_id}`,
    image: a.data?.img || a.template?.immutable_data?.img || '',
    templateId: Number(a.template?.template_id) || 0,
    mint: a.template_mint || null,
  }));
}

// ---- the ownership proof a secured recipe asks for -------------------------
// Only "hold N of these" rules are ones the page can meet on its own; the daily
// job marks the rest as unsupported. The proof names assets the wallet keeps —
// never ones it is about to hand over in the same blend.
export async function neftyProof(account, rule, handingOver = []) {
  if (!rule?.supported) throw new Error('This recipe has an access rule this page cannot check.');
  const skip = new Set(handingOver.map(String));
  const ids = [];
  for (const f of rule.filters) {
    const need = f.op === 2 ? f.amount + 1 : f.amount;       // 2 is "more than", 3 "at least"
    const q = new URLSearchParams({ owner: account, limit: '100', collection_name: f.collection });
    if (f.schema) q.set('schema_name', f.schema);
    if (f.templateId) q.set('template_id', String(f.templateId));
    const r = await fetch(`${AA}/assets?${q}`, { signal: AbortSignal.timeout(20000) });
    const mine = r.ok ? ((await r.json()).data || []).map(a => a.asset_id).filter(id => !skip.has(String(id))) : [];
    if (mine.length < need) {
      throw new Error(`This recipe is only for holders of ${need} ${f.templateId ? `NFT${need === 1 ? '' : 's'} of template ${f.templateId}` : `from ${f.schema || f.collection}`} — you hold ${mine.length}.`);
    }
    ids.push(...mine.slice(0, need));
  }
  return { account_name: account, asset_ids: ids };
}

// ---- the transaction -------------------------------------------------------
const fmtQty = (amount, decimals, symbol) => `${Number(amount).toFixed(decimals)} ${symbol}`;

export function buildNeftyBlend({ account, blend, picks, proof = null, auth = null }) {
  const a = auth || [{ actor: account, permission: 'active' }];
  const actions = [];
  // Tokens first: one balance opened and one deposit per token, summed when a
  // recipe asks for the same token twice.
  const tokens = new Map();
  for (const i of blend.ing.filter(x => x.kind === 'ft')) {
    const k = `${i.decimals},${i.symbol}@${i.contract}`;
    const t = tokens.get(k) || { ...i, amount: 0 };
    t.amount += i.amount;
    tokens.set(k, t);
  }
  for (const t of tokens.values()) {
    actions.push({ account: BLEND, name: 'openbal', authorization: a, data: { owner: account, token_symbol: `${t.decimals},${t.symbol}` } });
    actions.push({ account: t.contract, name: 'transfer', authorization: a,
      data: { from: account, to: BLEND, quantity: fmtQty(t.amount, t.decimals, t.symbol), memo: 'deposit' } });
  }
  // NFTs in the order of the recipe's ingredients.
  const ids = [];
  for (const i of blend.ing.filter(x => x.kind !== 'ft')) {
    const mine = (picks[i.index] || []).map(String);
    if (mine.length !== i.count) throw new Error(`Pick ${i.count} NFT${i.count === 1 ? '' : 's'} for each ingredient first.`);
    ids.push(...mine);
  }
  if (ids.length) {
    actions.push({ account: BLEND, name: 'announcedepo', authorization: a, data: { owner: account, count: ids.length } });
    actions.push({ account: 'atomicassets', name: 'transfer', authorization: a,
      data: { from: account, to: BLEND, asset_ids: ids, memo: 'deposit' } });
  }
  actions.push(blend.security
    ? { account: BLEND, name: 'fuse', authorization: a,
      data: { claimer: account, blend_id: blend.id, transferred_assets: ids, own_assets: [], security_check: ['OWNERSHIP_CHECK', proof] } }
    : { account: BLEND, name: 'nosecfuse', authorization: a,
      data: { claimer: account, blend_id: blend.id, transferred_assets: ids, own_assets: [] } });
  return actions;
}
