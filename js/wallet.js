// =============================================================================
// WALLET — WharfKit, loaded only when someone actually connects.
//
// The bundles are ~250 KB together; making every visitor pay that to look at a
// pool table would be rude, so the import is deferred until the first connect.
//
// Nothing in this file can move funds. It hands a built transaction to the
// user's wallet and the wallet asks them. There is no key here, no delegated
// permission, and no contract of ours in the path.
// =============================================================================

const CDN = 'https://cdn.jsdelivr.net/npm';
const V = {
  session: '1.6.1', renderer: '1.4.3', anchor: '1.7.3', cloud: '1.6.5',
};

export const WAX_CHAIN = {
  id: '1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4',
  url: 'https://wax.greymass.com',
};

let kit = null;
export let session = null;
const listeners = new Set();
export const onSession = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach(f => f(session));

// WAX Cloud Wallet needs a popup and a secure context; over plain HTTP it fails
// in ways that look like the user cancelled. Say so up front instead.
export const isSecure = () => window.isSecureContext;

async function kitOnce() {
  if (kit) return kit;
  const [{ SessionKit }, { WebRenderer }, { WalletPluginAnchor }, cloud] = await Promise.all([
    import(`${CDN}/@wharfkit/session@${V.session}/+esm`),
    import(`${CDN}/@wharfkit/web-renderer@${V.renderer}/+esm`),
    import(`${CDN}/@wharfkit/wallet-plugin-anchor@${V.anchor}/+esm`),
    import(`${CDN}/@wharfkit/wallet-plugin-cloudwallet@${V.cloud}/+esm`).catch(() => null),
  ]);

  const wallets = [new WalletPluginAnchor()];
  // Only offer Cloud Wallet where it can actually work.
  if (cloud && isSecure()) {
    const CW = cloud.WalletPluginCloudWallet || cloud.default;
    if (CW) wallets.push(new CW());
  }

  kit = new SessionKit({
    appName: 'WAX Terminal',
    chains: [{ id: WAX_CHAIN.id, url: WAX_CHAIN.url }],
    ui: new WebRenderer(),
    walletPlugins: wallets,
  });
  return kit;
}

export async function connect() {
  const k = await kitOnce();
  const { session: s } = await k.login();
  session = s;
  emit();
  return s;
}

// Restore a previous session so a reload does not force another wallet prompt.
export async function restore() {
  try {
    const k = await kitOnce();
    const s = await k.restore();
    if (s) { session = s; emit(); }
    return s;
  } catch { return null; }
}

export async function disconnect() {
  try { if (kit && session) await kit.logout(session); } catch {}
  session = null; emit();
}

export const account = () => (session ? String(session.actor) : null);
export const hasSession = () => !!session;

// One signature, N actions. Returns the transaction id the chain accepted.
// ----------------------------------------------------------- simulation ----
// Sign, run it against a node WITHOUT broadcasting, and only send it if the
// node executed it cleanly.
//
// `compute_transaction` runs a transaction speculatively and returns the traces
// it would have produced. It cannot be used before signing — public WAX nodes
// answer an unsigned transaction with "Missing signatures", tested on greymass,
// eosusa and waxsweden — but it accepts a signed one: fed a transaction lifted
// out of a recent block it got all the way to "duplicate transaction", which is
// the signature check passing.
//
// So the order is sign, simulate, broadcast. The signature is not the expensive
// part; landing a transaction that reverts is. A revert still bills CPU and NET
// against the account, and on a three-signature compound the one that fails is
// the last one, after the harvest is already loose in the wallet.
import { RPC_HOSTS } from './chain.js';

const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join('');

// One host, one attempt, and the body is read whatever the status: a 500 here
// usually carries the assertion message that explains the revert, and throwing
// it away would leave "it failed" as the entire diagnosis.
async function rpc(endpoint, body, host) {
  const res = await fetch(`${host}/v1/chain/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, json };
}

// The readable half of an EOSIO error, which is buried three levels down and
// is the only part anyone can act on.
export function chainError(json) {
  const d = json?.error?.details;
  if (Array.isArray(d) && d.length) {
    // The first detail is the outermost frame; the last is usually the actual
    // assertion that fired.
    const msg = d.find(x => /assertion failure|required|insufficient|balance|overdrawn/i.test(x.message || ''))?.message
      || d[d.length - 1]?.message || d[0]?.message;
    return String(msg).replace(/^assertion failure with message:\s*/i, '');
  }
  return json?.error?.what || json?.message || null;
}

function packed(result) {
  const ser = result.resolved?.serializedTransaction ?? result.resolved?.transaction?.serialized;
  if (!ser) return null;
  return {
    signatures: (result.signatures || []).map(String),
    compression: 0,
    packed_context_free_data: '',
    packed_trx: hex(ser),
  };
}

export async function transact(actions, { broadcast = true, verify = false } = {}) {
  if (!session) throw new Error('No wallet connected');

  if (!verify || !broadcast) {
    const result = await session.transact({ actions }, { broadcast });
    return {
      id: String(result.resolved?.transaction?.id ?? result.response?.transaction_id ?? ''),
      result,
    };
  }

  const result = await session.transact({ actions }, { broadcast: false });
  const tx = packed(result);
  const id = String(result.resolved?.transaction?.id ?? '');
  // If the signed bytes cannot be recovered there is nothing to simulate, and
  // refusing to send at all would be worse than sending unverified.
  if (!tx) {
    const r = await session.transact({ actions });
    return { id: String(r.resolved?.transaction?.id ?? r.response?.transaction_id ?? ''), result: r, verified: false };
  }

  let simulated = null;
  for (const host of RPC_HOSTS.slice(0, 3)) {
    let r;
    try { r = await rpc('compute_transaction', { transaction: tx }, host); }
    catch { continue; }                       // host unreachable: try the next
    if (r.ok) { simulated = r.json; break; }
    // A duplicate means this exact transaction is already on chain, which is a
    // success and not a reason to refuse.
    const msg = chainError(r.json) || '';
    if (/duplicate transaction/i.test(msg)) { simulated = null; break; }
    // Anything the node calls a client error is the transaction's fault, and
    // sending it would burn the account's CPU and NET to reach the same answer.
    if (r.status >= 400 && r.json?.error) {
      const e = new Error(msg || `Simulation failed (${r.status})`);
      e.simulated = true;
      throw e;
    }
  }

  const sent = await rpcAny('push_transaction', tx);
  return { id: String(sent.transaction_id || id), result, simulated, verified: true };
}

// Broadcast, walking the host list on network failure only.
async function rpcAny(endpoint, body) {
  let last = null;
  for (const host of RPC_HOSTS) {
    let r;
    try { r = await rpc(endpoint, body, host); } catch (e) { last = e; continue; }
    if (r.ok) return r.json;
    const msg = chainError(r.json) || `HTTP ${r.status}`;
    if (/duplicate transaction/i.test(msg)) return r.json || {};
    throw new Error(msg);
  }
  throw last || new Error(`${endpoint}: no host answered`);
}

export const authorization = () => [{ actor: account(), permission: String(session.permission) }];
