'use strict';
const guard = require('./_guard');
guard.install();
const C = require('../../src/csv');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

console.log('== csv.js (toCsv / safeToCsv) ==');

/* 1) empty rows -> BOM only */
chk(C.toCsv([]) === '\uFEFF', 'toCsv([]) = BOM');
chk(C.safeToCsv([]) === '\uFEFF', 'safeToCsv([]) = BOM');

/* 2) basic shape + header */
const rows = [{ a: 1, b: 'x' }, { a: 2, b: 'y' }];
const csv = C.toCsv(rows);
chk(csv.startsWith('\uFEFF'), 'BOM present');
chk(csv.includes('a,b'), 'header a,b');
chk(csv.includes('1,x'), 'row 1');
chk(csv.includes('2,y'), 'row 2');

/* 3) Arabic text preserved */
const ar = C.safeToCsv([{ name: 'أحمد', val: 5 }]);
chk(ar.includes('أحمد'), 'Arabic preserved in CSV');

/* 4) null/undefined -> empty */
const n = C.safeToCsv([{ a: null, b: undefined, c: '' }]);
chk(n.includes(',,'), 'null/undefined/empty -> empty cells');

/* 5) formula injection guard */
for (const bad of ['=1+1', '+cmd', '-1', '@SUM(A1)', '\tfoo', '\rbar']) {
  const out = C.safeToCsv([{ x: bad }]);
  // the dangerous cell must be prefixed with tab (inside quotes if needed)
  chk(out.includes('\t' + bad.replace(/^[\t\r]/, '')) || out.includes('\t' + bad),
    'formula guard prefixes dangerous value: ' + JSON.stringify(bad));
}

/* 6) quote escaping */
const q = C.safeToCsv([{ x: 'a"b,c' }]);
chk(q.includes('"a""b,c"'), 'quote escaping + comma quoting');

/* 7) newline in cell */
const nl = C.safeToCsv([{ x: 'line1\nline2' }]);
chk(nl.includes('"line1\nline2"'), 'newline cell quoted');

/* 8) header escaping (column names with special chars) */
const he = C.safeToCsv([{ 'a,b': 1 }]);
chk(he.startsWith('\uFEFF"a,b"'), 'header with comma quoted');

/* 9) full results beyond preview (large row count) */
const big = Array.from({ length: 100 }, (_, i) => ({ i, v: i * 2 }));
const bigCsv = C.safeToCsv(big);
chk(bigCsv.split('\r\n').length === 101, '100 rows + header = 101 lines');

/* 10) null rows -> BOM */
chk(C.toCsv(null) === '\uFEFF', 'toCsv(null) = BOM');
chk(C.safeToCsv(undefined) === '\uFEFF', 'safeToCsv(undefined) = BOM');

/* 11) guard */
chk(guard.count() === 0, 'صفر اتصال');
console.log(`\ncsv.test.js — pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
