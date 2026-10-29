'use strict';
/**
 * اختبارات وحدة صِّرفة لـ src/xlsx-reader.js — Phase 0.3A
 * --------------------------------------------------------
 * يغطّي فقط الدوال الصِّرفة المُصدَّرة: num, numx, str, excelSerialToISO, csvToRows.
 * **لا** يستدعي readWorkbook / readHeaderPreview / readViaCom (تلمس ملفات وتُشغّل
 * PowerShell) ولا يفتح أي اتصال شبكة.
 *   التشغيل: node tests/unit/xlsx-reader.test.js
 */
const guard = require('./_guard');
guard.install();

const x = require('../../src/xlsx-reader.js');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

const eq = (actual, expected, m) =>
  chk(JSON.stringify(actual) === JSON.stringify(expected), `${m} — got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

console.log('== xlsx-reader.js ==');

/* ---------- num: number with default fallback ---------- */
eq(x.num(null), 0, 'num(null) -> default 0');
eq(x.num(undefined), 0, 'num(undefined) -> default 0');
eq(x.num(null, 5), 5, 'num(null,5) -> custom default');
eq(x.num(''), 0, 'num("") -> 0');
eq(x.num('1,234.5'), 1234.5, 'num strips thousands separators');
eq(x.num('١٢٣'), 123, 'num converts Arabic-Indic digits');
eq(x.num('abc'), 0, 'num(non-numeric) -> 0');
eq(x.num('abc', -1), -1, 'num(non-numeric, -1) -> custom default');
eq(x.num(Infinity), 0, 'num(Infinity) -> 0 (non-finite)');
eq(x.num(true), 0, 'num(true) -> 0 (String(true) not numeric)');
eq(x.num(42), 42, 'num(42) -> 42');
eq(x.num('  7  '), 7, 'num trims whitespace');

/* ---------- numx: nullable number tolerating currency formatting ---------- */
eq(x.numx(null), null, 'numx(null) -> null (blank != 0)');
eq(x.numx(undefined), null, 'numx(undefined) -> null');
eq(x.numx(''), null, 'numx("") -> null');
eq(x.numx('$  1,278.0'), 1278, 'numx strips currency symbol + spaces + commas');
eq(x.numx('¢  215.90'), 215.9, 'numx strips cent sign');
eq(x.numx('52.48'), 52.48, 'numx plain decimal');
eq(x.numx('-'), null, 'numx("-") -> null');
eq(x.numx('\u2014'), null, 'numx(em-dash) -> null');
eq(x.numx('50%'), 50, 'numx strips percent sign');
eq(x.numx('١٢٣'), 123, 'numx converts Arabic-Indic digits');
eq(x.numx('abc'), null, 'numx(non-numeric) -> null');
eq(x.numx(0), 0, 'numx(0) -> 0 (real zero preserved)');
eq(x.numx(3.5), 3.5, 'numx(3.5) -> 3.5');
eq(x.numx(Infinity), null, 'numx(Infinity) -> null');

/* ---------- str ---------- */
eq(x.str(null), '', 'str(null) -> ""');
eq(x.str(undefined), '', 'str(undefined) -> ""');
eq(x.str('  hi  '), 'hi', 'str trims');
eq(x.str(0), '0', 'str(0) -> "0" (not empty)');

/* ---------- excelSerialToISO ---------- */
eq(x.excelSerialToISO(null), null, 'excelSerialToISO(null) -> null');
eq(x.excelSerialToISO(''), null, 'excelSerialToISO("") -> null');
eq(x.excelSerialToISO(46357), '2026-12-01', 'excelSerialToISO(46357)');
eq(x.excelSerialToISO(46023), '2026-01-01', 'excelSerialToISO(46023)');
eq(x.excelSerialToISO('46357'), '2026-12-01', 'excelSerialToISO(numeric string)');
eq(x.excelSerialToISO('2026-12-15'), '2026-12-15', 'excelSerialToISO(ISO passthrough)');
eq(x.excelSerialToISO('2026-12-15T10:00'), '2026-12-15', 'excelSerialToISO(ISO datetime -> date only)');
eq(x.excelSerialToISO(0), null, 'excelSerialToISO(0) -> null (serial < 1)');
eq(x.excelSerialToISO(-1), null, 'excelSerialToISO(negative) -> null');
eq(x.excelSerialToISO('junk'), null, 'excelSerialToISO(unparseable) -> null');

/* ---------- csvToRows (pure, in-memory string only) ---------- */
eq(x.csvToRows('a,b\n1,2'), [['a', 'b'], ['1', '2']], 'csvToRows simple 2x2');

/* ---------- exported surface: file-touching fns exist but are NOT used here ---------- */
chk(typeof x.readWorkbook === 'function', 'readWorkbook exported (not invoked in this test)');
chk(typeof x.readHeaderPreview === 'function', 'readHeaderPreview exported (not invoked)');

/* ---------- safety ---------- */
chk(guard.count() === 0, 'no network connection attempted');

console.log(`\nxlsx-reader.test.js — pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
