'use strict';
/**
 * اختبارات وحدة صِّرفة لـ src/contract.js — Phase 0.3A
 * -----------------------------------------------------
 * - لا قاعدة بيانات، لا خادم، لا I/O.
 * - يفعّل _guard أولًا لمنع أي اتصال شبكة.
 * - القيم المتوقعة مأخوذة من السلوك الفعلي للكود، لا من إعادة كتابة المنطق.
 *   التشغيل: node tests/unit/contract.test.js
 */
const guard = require('./_guard');
guard.install();

const c = require('../../src/contract.js');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

/** يقارن مخرجًا بقيمة متوقعة عبر JSON مع رسالة تشخيصية */
const eq = (actual, expected, m) =>
  chk(JSON.stringify(actual) === JSON.stringify(expected), `${m} — got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

console.log('== contract.js ==');

/* ---------- normalize ---------- */
eq(c.normalize(null), '', 'normalize(null) -> ""');
eq(c.normalize(undefined), '', 'normalize(undefined) -> ""');
eq(c.normalize(45), '45', 'normalize(number) -> "45"');
eq(c.normalize('  26  ديسمبر  '), '26 ديسمبر', 'normalize collapses whitespace + trims');
eq(c.normalize('٢٠٢٦'), '2026', 'normalize converts Arabic-Indic digits');
eq(c.normalize('۱۲۳'), '123', 'normalize converts Extended Arabic-Indic digits');
eq(c.normalize('a\u200fb\u00a0c'), 'a b c', 'normalize maps RTL mark + NBSP to spaces');
eq(c.normalize('a\n\tb'), 'a b', 'normalize collapses newline/tab to single space');

/* ---------- monthIndex ---------- */
eq(c.monthIndex('ديسمبر'), 12, 'monthIndex(AR full) -> 12');
eq(c.monthIndex('December'), 12, 'monthIndex(EN full, case-insensitive) -> 12');
eq(c.monthIndex('dec'), 12, 'monthIndex(EN abbrev) -> 12');
eq(c.monthIndex('xyz'), null, 'monthIndex(unknown) -> null');
eq(c.monthIndex(''), null, 'monthIndex("") -> null');
eq(c.monthIndex(null), null, 'monthIndex(null) -> null');

/* ---------- labelOf  (Excel display: 2-digit year + AR month) ---------- */
eq(c.labelOf(2026, 12), '26 ديسمبر', 'labelOf(2026,12)');
eq(c.labelOf(2025, 1), '25 يناير', 'labelOf(2025,1)');

/* ---------- parseContract: accepted forms ---------- */
const dec2026 = { year: 2026, month: 12, iso: '2026-12-01', label: '26 ديسمبر' };
eq(c.parseContract('2026-12'), dec2026, 'parseContract YYYY-MM');
eq(c.parseContract('2026-12-15'), dec2026, 'parseContract YYYY-MM-DD (day ignored)');
eq(c.parseContract('12/2026'), dec2026, 'parseContract MM/YYYY');
eq(c.parseContract('26 ديسمبر'), dec2026, 'parseContract YY AR-month');
eq(c.parseContract('ديسمبر 2026'), dec2026, 'parseContract AR-month YYYY');
eq(c.parseContract('ديسمبر 26'), dec2026, 'parseContract AR-month YY');

/* ---------- parseContract: rejected / null ---------- */
eq(c.parseContract('   '), null, 'parseContract(blank) -> null');
eq(c.parseContract('hello'), null, 'parseContract(junk) -> null');
eq(c.parseContract('13/2026'), null, 'parseContract month>12 -> null');
eq(c.parseContract('2026-13'), null, 'parseContract month>12 (ISO) -> null');
eq(c.parseContract('1989-12'), null, 'parseContract year<1990 -> null');
eq(c.parseContract('2041-12'), null, 'parseContract year>2040 -> null');
/* الحارس المقصود ضد أثر قراءة SheetJS الخاطئ لرمز B2 (السنة 45 → 2045) */
eq(c.parseContract('45 December'), null, 'parseContract("45 December") blocked by 2040 bound');
eq(c.parseContract('61 ديسمبر'), null, 'parseContract YY 61 -> 1961 out of bounds -> null');
eq(c.parseContract('60 ديسمبر'), null, 'parseContract YY 60 -> 2060 out of bounds -> null');

/* ---------- fromSerial (Excel 1900 serial -> Excel label) ---------- */
eq(c.fromSerial(46357), '26 ديسمبر', 'fromSerial(46357)');
eq(c.fromSerial(46023), '26 يناير', 'fromSerial(46023)');
eq(c.fromSerial(1), null, 'fromSerial(1) -> year 1900 out of bounds -> null');
eq(c.fromSerial(0), null, 'fromSerial(0) -> null');
eq(c.fromSerial(-5), null, 'fromSerial(negative) -> null');
eq(c.fromSerial(NaN), null, 'fromSerial(NaN) -> null');

/* ---------- fromCell (raw/formatted cell -> display/storage value) ---------- */
eq(c.fromCell(null), null, 'fromCell(null) -> null');
eq(c.fromCell(46357), '26 ديسمبر', 'fromCell(serial number)');
eq(c.fromCell('46357'), '26 ديسمبر', 'fromCell(numeric string in Excel range)');
eq(c.fromCell('26 ديسمبر'), '26 ديسمبر', 'fromCell(already-label text)');
eq(c.fromCell('   '), null, 'fromCell(blank) -> null');
eq(c.fromCell(12), '12', 'fromCell(12) below 20000 kept as string');
eq(c.fromCell('19999'), '19999', 'fromCell("19999") below 20000 kept as string');
eq(c.fromCell('99999'), '99999', 'fromCell("99999") above 80000 kept as string');

/* ---------- constants ---------- */
chk(Array.isArray(c.AR_MONTHS) && c.AR_MONTHS.length === 12, 'AR_MONTHS has 12 months');
chk(Array.isArray(c.EN_MONTHS) && c.EN_MONTHS.length === 12, 'EN_MONTHS has 12 months');
chk(typeof c.HINT === 'string' && c.HINT.length > 0, 'HINT is a non-empty string');

/* ---------- safety ---------- */
chk(guard.count() === 0, 'no network connection attempted');

console.log(`\ncontract.test.js — pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
