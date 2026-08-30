// Does the "with LPs" switch change the pie, and by the right amount?
import { parseHTML } from 'linkedom';
import { readFile } from 'node:fs/promises';
const root = new URL('file:///home/admini/waxterminal/');
const { window, document } = parseHTML(await readFile(new URL('index.html', root), 'utf8'));
const store = new Map();
Object.assign(globalThis, {
  window, document,
  location: Object.assign(new URL('http://127.0.0.1:8110/'), { hash: '#wallet/qu.ug.wam' }),
  history: { replaceState(_a, _b, u) { globalThis.location.hash = String(u).replace(/^[^#]*/, ''); } },
  localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: id => clearTimeout(id),
  matchMedia: () => ({ matches: false, addEventListener() {} }), alert: () => {},
  navigator: { userAgent: 'node' }, indexedDB: undefined,
  HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
  customElements: { define() {}, get() {} },
});
window.scrollTo = () => {}; window.localStorage = globalThis.localStorage;
window.getComputedStyle = globalThis.getComputedStyle;
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  if (typeof u === 'string' && !/^https?:/.test(u)) {
    try { return new Response(await readFile(new URL(u, root)), { status: 200 }); } catch { return new Response('', { status: 404 }); }
  }
  return realFetch(u, o);
};
await import(new URL('js/app.js', root).href);
await new Promise(r => setTimeout(r, 50));
document.dispatchEvent(new window.Event('DOMContentLoaded'));
await new Promise(r => setTimeout(r, 55000));

const sum = () => document.querySelector('#pieSum')?.textContent || '(no summary)';
const legend = () => [...document.querySelectorAll('#balPie .dlabel, #balPie text')].map(n => n.textContent).slice(0, 4).join(' | ');
console.log('wallet only :', sum());
const sw = document.querySelector('#pieLps');
console.log('switch present:', !!sw, '| starts', sw?.getAttribute('aria-checked'));
sw?.dispatchEvent(new window.Event('click', { bubbles: true }));
await new Promise(r => setTimeout(r, 400));
console.log('with LPs    :', sum(), '| now', sw?.getAttribute('aria-checked'));
