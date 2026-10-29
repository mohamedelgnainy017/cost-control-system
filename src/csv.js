'use strict';
/**
 * CSV serializers — shared by /api/export and Workflow Studio output export.
 * - toCsv: original report CSV (BOM + CRLF + quote escaping).
 * - safeToCsv: workflow output CSV with Excel formula-injection guard.
 * No dependencies. DB-independent.
 */
function toCsv(rows) {
  if (!rows || !rows.length) return '\uFEFF';
  const cols = Object.keys(rows[0]);
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map(c => esc(r[c])).join(','));
  return '\uFEFF' + lines.join('\r\n');
}

function safeToCsv(rows) {
  if (!rows || !rows.length) return '\uFEFF';
  const cols = Object.keys(rows[0]);
  const esc = v => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    /* منع تفسير القيمة كصيغة في Excel */
    if (/^[=+\-@\t\r]/.test(s)) s = '\t' + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.map(c => esc(c)).join(',')];
  for (const r of rows) lines.push(cols.map(c => esc(r[c])).join(','));
  return '\uFEFF' + lines.join('\r\n');
}

module.exports = { toCsv, safeToCsv };
