// =============================================================================
// CSV EXPORT — the numbers, in a form you can take away.
//
// A terminal that will not hand over its figures is a picture of figures. Every
// export here is exactly what the table is showing: the same rows, the same
// filters, the same order, so a spreadsheet and the page cannot quietly
// disagree about what was on screen.
//
// Values are exported raw, not formatted. "$1.2k" is a thing to read; 1234.56
// is a thing to sum, and re-parsing a display string is how a column of money
// turns into a column of text halfway down.
// =============================================================================

// A leading =, +, - or @ makes Excel, Sheets and LibreOffice treat the cell as a
// formula, and this exports account names and on-chain memos that anyone can
// set. `=HYPERLINK(...)` in a memo is a real attack on whoever opens the file,
// so those cells are prefixed with an apostrophe — the spreadsheet convention
// for "this is text" — and the value reads back unchanged.
const RISKY = /^[=+\-@\t\r]/;

function cell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return isFinite(v) ? String(v) : '';
  if (v instanceof Date) return v.toISOString();
  let s = String(v);
  if (RISKY.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// columns: [{ h: 'Header', v: row => value }, …]
export function toCsv(rows, columns) {
  const out = [columns.map(c => cell(c.h)).join(',')];
  for (const r of rows) {
    const line = [];
    for (const c of columns) {
      let v;
      try { v = c.v(r); } catch { v = null; }
      line.push(cell(v));
    }
    out.push(line.join(','));
  }
  // A BOM so Excel opens UTF-8 correctly — without it every non-ASCII symbol
  // in a WAX token name arrives mangled.
  return '﻿' + out.join('\r\n') + '\r\n';
}

export function downloadCsv(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick rather than immediately: Safari has not finished
  // reading the blob when click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

// One helper for the whole app: give it the rows, the columns and a name.
export function exportCsv(name, rows, columns) {
  downloadCsv(`${name}-${stamp()}.csv`, toCsv(rows, columns));
}

// A button that exports whatever the table is showing at the moment it is
// pressed — `rows` is a function, not an array, so a filter typed after the
// button was wired still applies.
export function csvButton(label, name, rows, columns) {
  const b = document.createElement('button');
  b.className = 'btn ghost csv';
  b.type = 'button';
  b.textContent = label;
  b.onclick = () => {
    const data = typeof rows === 'function' ? rows() : rows;
    if (!data?.length) { b.textContent = 'nothing to export'; setTimeout(() => { b.textContent = label; }, 1600); return; }
    exportCsv(name, data, columns);
    b.textContent = `${data.length.toLocaleString()} rows ↓`;
    setTimeout(() => { b.textContent = label; }, 2200);
  };
  return b;
}
