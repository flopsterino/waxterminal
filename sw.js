// =============================================================================
// SERVICE WORKER — the second visit should not wait on the network.
//
// Three kinds of request, three rules:
//   code and styling  versioned by the deploy stamp (?v=…), so a cached copy is
//                     never stale: cache first, and old versions are dropped
//                     when a new worker takes over.
//   data/logos        change a few times a year: cache first.
//   data/*.json and   the page itself: network first, the last good copy when
//   navigations       the network is slow or gone. The numbers on screen are
//                     never older than the connection allows.
// Everything cross-origin (chain nodes, Alcor, IPFS) is left alone: those are
// live answers, and a cached one would be a wrong one.
// =============================================================================

const BUILD = '__BUILD__';
const SHELL = `wedge-shell-${BUILD}`;
const DATA = 'wedge-data';
const LOGOS = 'wedge-logos';
const NET_TIMEOUT_MS = 4000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(['./', 'theme.json', 'theme.css'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('wedge-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

const cacheFirst = async (req, name) => {
  const c = await caches.open(name);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) c.put(req, res.clone());
  return res;
};

const networkFirst = async (req, name, fallbackUrl = null) => {
  const c = await caches.open(name);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), NET_TIMEOUT_MS)),
    ]);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = (await c.match(req)) || (fallbackUrl && (await caches.match(fallbackUrl)));
    if (hit) return hit;
    throw err;
  }
};

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;

  if (req.mode === 'navigate') {
    // A deep link is answered by 404.html, which bounces to the root; only the
    // root itself has a sensible offline fallback.
    e.respondWith(networkFirst(req, SHELL, path.endsWith('/') ? './' : null));
    return;
  }
  if (path.includes('/data/logos/')) { e.respondWith(cacheFirst(req, LOGOS)); return; }
  if (path.includes('/data/')) { e.respondWith(networkFirst(req, DATA)); return; }
  if (url.searchParams.has('v') || path.includes('/brand/')) { e.respondWith(cacheFirst(req, SHELL)); return; }
  if (/\.(js|css|json|webmanifest)$/.test(path)) { e.respondWith(networkFirst(req, SHELL)); return; }
});
