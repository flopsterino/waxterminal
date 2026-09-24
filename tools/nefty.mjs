// =============================================================================
// NEFTYBLOCKS BLENDS — the open recipes on blend.nefty, ready to draw.
//
// NeftyBlocks' site is gone; its blend contract is not (someone blended on it
// the day this was written). The table holds thousands of recipes, most of them
// named only by template numbers, so the daily job does the reading once:
// every open, visible recipe, the tokens they take resolved to their contracts,
// the ownership rule behind the secured ones, and a name and image for every
// template they take or give. The page then draws instantly, and re-reads the
// one recipe somebody is about to blend.
//
// The shapes below were read off the contract (its ABI and config) and checked
// against real blends, e.g. 0bd9c4aa… on 2026-09-20:
//   openbal · <token>::transfer "deposit" · announcedepo(count) ·
//   atomicassets::transfer "deposit" · fuse(claimer, blend, assets, [], check)
// =============================================================================

import { writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { getRows, getAllRows } from '../js/chain.js';

const DIR = new URL('../data/nefty/', import.meta.url);
const BLEND = 'blend.nefty', SECURE = 'secure.nefty';
const AA = 'https://wax.api.atomicassets.io/atomicassets/v1';
const now = Date.now() / 1000;
const secs = t => { const n = Number(t) || 0; return n > 1e11 ? n / 1000 : n; };
const parseJson = s => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

// Tokens the contract accepts, keyed "precision,SYMBOL" — an FT ingredient only
// carries a quantity, and the quantity's own precision picks the contract.
const cfg = (await getRows(BLEND, BLEND, 'config', { limit: 1 })).rows?.[0] || {};
const tokenContract = new Map((cfg.supported_tokens || []).map(t => [t.sym, t.contract]));
const ftOf = q => {
  const [n, sym] = String(q).split(' ');
  const prec = (n.split('.')[1] || '').length;
  return { amount: Number(n), symbol: sym, decimals: prec, contract: tokenContract.get(`${prec},${sym}`) || null, quantity: q };
};

const effectOf = e => (!e ? { burn: true, to: null }
  : e[0] === 'TRANSFER_EFFECT' ? { burn: false, to: e[1]?.to || null }
  : { burn: Number(e[1]?.type) === 0, to: null });

function ingredient([kind, b], index) {
  const eff = effectOf(b.effect);
  const base = { index, count: Number(b.amount) || 1, ...eff };
  switch (kind) {
    case 'TEMPLATE_INGREDIENT': return { ...base, kind: 'template', collection: b.collection_name, templateId: Number(b.template_id) };
    case 'SCHEMA_INGREDIENT': return { ...base, kind: 'schema', collection: b.collection_name, schema: b.schema_name, note: parseJson(b.display_data).description || '' };
    case 'COLLECTION_INGREDIENT': return { ...base, kind: 'collection', collection: b.collection_name };
    case 'ATTRIBUTE_INGREDIENT': return {
      ...base, kind: 'attribute', collection: b.collection_name, schema: b.schema_name,
      attrs: (b.attributes || []).map(a => ({ name: a.attribute_name, values: a.allowed_values || [] })),
      note: parseJson(b.display_data).description || '',
    };
    case 'FT_INGREDIENT': return { index, kind: 'ft', count: 0, ...ftOf(b.quantity), ...eff };
    default: return { index, kind: 'unknown', raw: kind };
  }
}

function result([kind, b]) {
  if (kind === 'ON_DEMAND_NFT_RESULT') return { kind: 'mint', templateId: Number(b.template_id) };
  if (kind === 'POOL_NFT_RESULT') { const d = parseJson(b.display_data); return { kind: 'pool', pool: b.pool_name, name: d.name || b.pool_name, image: d.image || '' }; }
  if (kind === 'FT_RESULT') { const q = b.amount?.quantity || ''; return { kind: 'ft', ...ftOf(q), contract: b.amount?.contract || ftOf(q).contract }; }
  return { kind: 'unknown', raw: kind };
}

// ---- every recipe, then the ones somebody can use today --------------------
const all = await getAllRows(BLEND, BLEND, 'blends', { onPage: (n, more) => { if (n % 5000 < 1000) console.log(`  ${n} recipes read${more ? '…' : ''}`); } });
console.log(`blend.nefty: ${all.length} recipes`);
const open = all.filter(b => !Number(b.is_hidden)
  && secs(b.start_time) <= now
  && (!secs(b.end_time) || secs(b.end_time) > now)
  && (!Number(b.max) || Number(b.use_count) < Number(b.max)));

// ---- the ownership rules behind the secured ones ---------------------------
// secure.nefty keeps them per collection. Only "hold N of these" filters are
// something the page can satisfy on its own; anything else is marked, so the
// page says it cannot, instead of sending a blend that will be refused.
const security = new Map();
for (const b of open.filter(x => Number(x.security_id))) {
  const key = `${b.collection_name}:${b.security_id}`;
  if (security.has(key)) continue;
  let rule = null;
  try {
    const r = (await getRows(SECURE, b.collection_name, 'proofown', { lower: b.security_id, limit: 1 })).rows?.[0];
    if (r && String(r.security_id) === String(b.security_id)) {
      const filters = (r.group?.filters || []).map(([k, f]) => ({
        kind: k, collection: f.collection_name, schema: f.schema_name || null,
        templateId: Number(f.template_id) || null, op: Number(f.comparison_operator), amount: Number(f.amount) || 1,
      }));
      const ok = filters.length && filters.every(f => ['TEMPLATE_HOLDINGS', 'SCHEMA_HOLDINGS', 'COLLECTION_HOLDINGS'].includes(f.kind) && [2, 3].includes(f.op));
      rule = { type: 'ownership', and: Number(r.group?.logical_operator) === 0, filters, supported: !!ok && Number(r.group?.logical_operator) === 0 };
    }
  } catch { /* unreadable: treated as unsupported below */ }
  security.set(key, rule || { type: 'other', supported: false });
}

// ---- names and pictures for every template in play -------------------------
const ids = new Set();
for (const b of open) {
  for (const i of b.ingredients) if (i[0] === 'TEMPLATE_INGREDIENT') ids.add(Number(i[1].template_id));
  for (const r of b.rolls) for (const o of r.outcomes) for (const x of o.results) if (x[0] === 'ON_DEMAND_NFT_RESULT') ids.add(Number(x[1].template_id));
}
const templates = {};
const list = [...ids];
for (let i = 0; i < list.length; i += 100) {
  try {
    const r = await fetch(`${AA}/templates?ids=${list.slice(i, i + 100).join(',')}&limit=100`, { signal: AbortSignal.timeout(30000) });
    const d = await r.json();
    for (const t of d.data || []) {
      const im = t.immutable_data || {};
      templates[t.template_id] = { name: im.name || '', img: im.img || im.image || im.video || '' };
    }
  } catch (e) { console.log('templates batch failed:', e.message); }
  await new Promise(r => setTimeout(r, 250));   // a public API, asked politely
}

const rows = open.map(b => {
  const d = parseJson(b.display_data);
  const ing = b.ingredients.map(ingredient);
  const rolls = b.rolls.map(r => ({
    total: Number(r.total_odds) || 1,
    outcomes: r.outcomes.map(o => ({ odds: Number(o.odds) || 0, results: o.results.map(result) })),
  }));
  const firstMint = rolls[0]?.outcomes[0]?.results.find(x => x.kind === 'mint');
  const sec = Number(b.security_id) ? security.get(`${b.collection_name}:${b.security_id}`) : null;
  return {
    id: Number(b.blend_id), col: b.collection_name, cat: b.category || '',
    // No name of its own is common; the first thing it makes is the next best.
    name: d.name || templates[firstMint?.templateId]?.name || `Blend #${b.blend_id}`,
    desc: d.description || '', img: d.image || templates[firstMint?.templateId]?.img || '',
    start: secs(b.start_time) * 1000 || 0, end: secs(b.end_time) * 1000 || 0,
    max: Number(b.max) || 0, ...(Number(b.max) ? { used: Number(b.use_count) || 0 } : {}),
    security: sec ? { id: Number(b.security_id), ...sec } : null,
    ing, rolls,
    unsupported: ing.some(i => i.kind === 'unknown' || (i.kind === 'ft' && !i.contract))
      || rolls.some(r => r.outcomes.some(o => o.results.some(x => x.kind === 'unknown'))),
  };
}).sort((a, b) => b.id - a.id);

// ---- written in pieces a page can afford ----------------------------------
// 25,000 recipes are "open" in the sense that nobody ever closed them, and one
// file of them is 27 MB. So: an index of the collections and their counts,
// and one file per collection that loads when somebody picks it. Each file carries only the templates its own recipes name, and
// files that did not change are not rewritten.
const withTemplates = list => {
  const t = {};
  for (const b of list) {
    for (const i of b.ing) if (i.templateId && templates[i.templateId]) t[i.templateId] = templates[i.templateId];
    for (const r of b.rolls) for (const o of r.outcomes) for (const x of o.results) if (x.templateId && templates[x.templateId]) t[x.templateId] = templates[x.templateId];
  }
  return t;
};
await mkdir(new URL('c/', DIR), { recursive: true });
const byCol = new Map();
for (const r of rows) { if (!byCol.has(r.col)) byCol.set(r.col, []); byCol.get(r.col).push(r); }
const keep = new Set();
for (const [col, list] of byCol) {
  const file = `${col}.json`;
  keep.add(file);
  await writeFile(new URL(`c/${file}`, DIR), JSON.stringify({ col, templates: withTemplates(list), blends: list }));
}
for (const f of await readdir(new URL('c/', DIR))) if (!keep.has(f)) await unlink(new URL(`c/${f}`, DIR));
// The index is only the list of collections: the page shows nothing until
// somebody names a collection or asks for the blends they hold pieces for.
const collections = [...byCol].map(([col, list]) => ({ col, n: list.length, newest: list[0].id }))
  .sort((a, b) => b.newest - a.newest);
await writeFile(new URL('index.json', DIR), JSON.stringify({ at: new Date().toISOString(), total: rows.length, collections }));
console.log(`nefty: ${rows.length} open of ${all.length} in ${byCol.size} collection files; `
  + `${rows.filter(r => r.security).length} secured (${rows.filter(r => r.security && !r.security.supported).length} not supported), `
  + `${rows.filter(r => r.unsupported).length} with a part this page cannot do`);
