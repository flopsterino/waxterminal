// =============================================================================
// VERIFY — render the app in node, with a real DOM and the real chain.
//
// The headless-chromium path this repo used for visual checks became unusable:
// it hangs at exit on this host, on pages it rendered fine an hour earlier, and
// nothing about the app changed in between. Rather than keep guessing at
// chromium, this drives the same modules against a DOM implementation.
//
// It is not a substitute for looking at the page — it cannot tell you something
// is ugly. It can tell you what rendered, with which numbers, which is what a
// dump-dom check was ever actually used for here.
// =============================================================================

import { parseHTML } from 'linkedom';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const { window, document } = parseHTML(html);

// The globals the app expects from a browser. Anything it reaches for that is
// not here is a thing worth knowing about, so nothing is stubbed defensively.
const store = new Map();
globalThis.window = window;
globalThis.document = document;
globalThis.location = Object.assign(new URL('http://127.0.0.1:8110/'), { hash: process.argv[3] || '' });
globalThis.history = { replaceState(_a, _b, url) { globalThis.location.hash = String(url).replace(/^[^#]*/, ''); } };
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
window.scrollTo = () => {};
window.getComputedStyle = globalThis.getComputedStyle;
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
window.localStorage = globalThis.localStorage;
globalThis.alert = msg => console.log('[alert]', msg);
globalThis.navigator = { userAgent: 'node' };
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.customElements = { define() {}, get() {} };

// Relative fetches are files; everything else is the real chain.
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  if (typeof u === 'string' && !/^https?:/.test(u)) {
    try { return new Response(await readFile(new URL(String(u).split('?')[0], root)), { status: 200 }); }
    catch { return new Response('', { status: 404 }); }
  }
  return realFetch(u, o);
};

// IndexedDB is only a cache; without it the app reads from chain, which is what
// a verification run should be doing anyway.
globalThis.indexedDB = undefined;

// A swallowed error here looks exactly like a page that rendered nothing, so
// everything the app throws is surfaced rather than absorbed.
process.on('unhandledRejection', e => console.error('[unhandled]', e?.stack || e));
process.on('uncaughtException', e => console.error('[uncaught]', e?.stack || e));

const entry = (html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/) || [, 'js/app.js'])[1];
await import(new URL(entry, root).href).catch(e => { console.error('[import failed]', e?.stack || e); });

// The app boots on DOMContentLoaded, which never fires against an
// already-parsed document — so it is dispatched by hand, once the module has
// had a chance to register its listener.
await new Promise(r => setTimeout(r, 50));
document.dispatchEvent(new window.Event('DOMContentLoaded'));

// Let the page settle. Everything here loads asynchronously by design, so the
// wait is real time rather than a promise anyone exposes.
const seconds = Number(process.argv[2] || 25);
await new Promise(r => setTimeout(r, seconds * 1000));

// Panels that only exist after a click cannot be checked from a first paint.
// Any number of --click=<selector> arguments are dispatched in order, each
// followed by a settle, so a plan panel or a sub-tab can be opened and read.
for (const arg of process.argv.slice(3).filter(a => /^--(click|toggle|type)=/.test(a))) {
  // --type=<selector>=<value> fills a field and fires the input event, which is
  // the only way to reach a panel that computes from what someone typed. The
  // wait is long because a quote is a network call behind a debounce.
  if (arg.startsWith('--type=')) {
    const body = arg.slice('--type='.length);
    const at = body.indexOf('=');
    const sel = body.slice(0, at), val = body.slice(at + 1);
    const el = document.querySelector(sel);
    if (!el) { console.error(`[type] no match for ${sel}`); continue; }
    el.value = val;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    if (typeof el.oninput === 'function') await el.oninput(new window.Event('input'));
    await new Promise(r => setTimeout(r, Number(process.env.TYPE_WAIT || 8) * 1000));
    continue;
  }
  if (arg.startsWith('--toggle=')) {
    const sel = arg.slice('--toggle='.length);
    const el = document.querySelector(sel);
    if (!el) { console.error(`[toggle] no match for ${sel}`); continue; }
    el.checked = !el.checked;
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
    if (typeof el.onchange === 'function') await el.onchange(new window.Event('change'));
    await new Promise(r => setTimeout(r, 3000));
    continue;
  }
  const sel = arg.slice('--click='.length);
  const el = document.querySelector(sel);
  if (!el) { console.error(`[click] no match for ${sel}`); continue; }
  let fired = false;
  const spy = () => { fired = true; };
  el.addEventListener('click', spy);
  el.dispatchEvent(new window.Event('click', { bubbles: true }));
  el.removeEventListener('click', spy);
  if (!fired && typeof el.onclick === 'function') await el.onclick(new window.Event('click'));
  await new Promise(r => setTimeout(r, Number(process.env.CLICK_WAIT || 12) * 1000));
}

console.log(document.documentElement.outerHTML);
