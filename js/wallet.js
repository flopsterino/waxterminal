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

// One signature, N actions. Returns the transaction id the chain accepted.
export async function transact(actions, { broadcast = true } = {}) {
  if (!session) throw new Error('No wallet connected');
  const result = await session.transact({ actions }, { broadcast });
  return {
    id: String(result.resolved?.transaction?.id ?? result.response?.transaction_id ?? ''),
    result,
  };
}

export const authorization = () => [{ actor: account(), permission: String(session.permission) }];
