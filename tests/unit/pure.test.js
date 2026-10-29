'use strict';
/**
 * اختبارات الوحدة الصِّرفة — Phase 0.3C (A · B1/B1b: clsKey · B2a: normAr · B3a: ceil1000 · B4a: pad2)
 * ==================================================================
 * يتحقق من:
 *   1. استقلال `src/pure.js` (بلا وحدة إنتاج تعتمد على DB).
 *   2. سلوك `clsKey` و`normAr` و`ceil1000` و`pad2` مباشرةً من `src/pure.js`.
 *   3. تكافؤ `clsKey` مع نسختين مرجعيتين مأخوذتين **حرفيًا** من الجسمين
 *      السابقين: `src/analytics.js` (قبل 0.3C-B1) و`src/pbix.js` (قبل 0.3C-B1b).
 *   4. تكافؤ `normAr` مع نسخة مرجعية مأخوذة **حرفيًا** من `src/server.js`
 *      (قبل 0.3C-B2a).
 *   5. تكافؤ `ceil1000` مع نسخة مرجعية مأخوذة **حرفيًا** من `src/pbix.js`
 *      (قبل 0.3C-B3a)، وتكافؤ `pad2` مع نسخة مرجعية مأخوذة **حرفيًا** من
 *      النسخ الثلاث السابقة (قبل 0.3C-B4a).
 *   6. تمييز `normAr` عن `clsKey` (غير متكافئتين عمدًا).
 *   7. (فحص ساكن) أن analytics.js/pbix.js يستوردان `clsKey` من `./pure`،
 *      وأن server.js يستورد `normAr`، وأن pbix.js/server.js/borse-fetch.js
 *      تستورد `pad2` بلا تعريفات محلية.
 *
 * ما لا يفعله: لا يستورد analytics.js/pbix.js/server.js/db.js، ولا يختبر
 * أي دالة أخرى، ولا يثبت تطابق نتائج تقارير Power BI كاملة، ولا يدّعي أن
 * `_guard` يغطي الملفات أو العمليات الفرعية.
 *
 * التشغيل: node tests/unit/pure.test.js
 */
const guard = require('./_guard');
guard.install();

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);
const eq = (actual, expected, m) =>
  chk(JSON.stringify(actual) === JSON.stringify(expected),
    `${m} — got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

/* =====================================================================
 * (1) الاستقلال
 * ===================================================================== */
console.log('== pure.js — independence ==');

let pure = null;
let loadErr = null;
try { pure = require('../../src/pure.js'); } catch (e) { loadErr = e; }
chk(loadErr === null, 'require("../../src/pure.js") succeeds alone'
  + (loadErr ? ` — ${loadErr.message}` : ''));
chk(pure !== null && typeof pure === 'object', 'module exports an object');
chk(pure !== null && !Array.isArray(pure), 'module export is not an array');
chk(pure !== null && typeof pure.clsKey === 'function', 'exports clsKey as a function');
chk(pure !== null && typeof pure.normAr === 'function', 'exports normAr as a function');
chk(pure !== null && typeof pure.ceil1000 === 'function', 'exports ceil1000 as a function');
chk(pure !== null && typeof pure.pad2 === 'function', 'exports pad2 as a function');

const loaded = Object.keys(require.cache);
const forbidden = ['db.js', 'analytics.js', 'pbix.js', 'server.js', 'cost-engine.js',
  'importer.js', 'borse-edit.js', 'prices-edit.js', 'auth.js', 'master.js'];
const hits = forbidden.filter(name => loaded.some(p => p.replace(/\\/g, '/').endsWith('/src/' + name)));
chk(hits.length === 0, `no DB-dependent production module was loaded — hits: [${hits.join(', ')}]`);
chk(guard.count() === 0, 'no network connection attempted (guard: supplementary only)');

/* فحص ساكن: pbix.js لم يعد يعرّف clsKey محليًا، ويستوردها من ./pure
 * (قراءة نصية فقط — لا استيراد لـ pbix.js لأنه يعتمد على db.js). */
const fsx = require('node:fs');
const pathx = require('node:path');
const pbixSrc = fsx.readFileSync(pathx.join(__dirname, '..', '..', 'src', 'pbix.js'), 'utf8');
chk(!/function\s+clsKey\s*\(/.test(pbixSrc), 'pbix.js no longer defines clsKey locally (static read)');
/* يتحقق من أن الاستيراد من ./pure يحوي الاسم المطلوب ضمن قائمة أسماء. */
const importsFromPure = (src, name) => {
  const m = src.match(/const\s*\{([^}]*)\}\s*=\s*require\(['"]\.\/pure['"]\)/);
  if (!m) return false;
  return m[1].split(',').map(s => s.trim()).includes(name);
};
chk(importsFromPure(pbixSrc, 'clsKey'), 'pbix.js imports clsKey from ./pure (static read)');
chk(!/^const\s+ceil1000\s*=/m.test(pbixSrc), 'pbix.js no longer defines ceil1000 locally (static read)');
chk(importsFromPure(pbixSrc, 'ceil1000'), 'pbix.js imports ceil1000 from ./pure in the same import (static read)');
/* إشارات ceil1000 في pbix.js: سطر الاستيراد + 4 أسطر استدعاء، وفيها 6 نداءات
 * (سطران يحتويان نداءين لكل منهما) => 7 إشارات إجمالًا. لا تعريف محلي. */
chk((pbixSrc.match(/\bceil1000\b/g) || []).length === 7,
  'pbix.js references ceil1000 exactly 7 times: 1 import + 6 calls on 4 lines (static read)');
chk(importsFromPure(
  fsx.readFileSync(pathx.join(__dirname, '..', '..', 'src', 'analytics.js'), 'utf8'), 'clsKey'),
  'analytics.js keeps importing clsKey from ./pure (static read)');

/* فحص ساكن: server.js يستورد normAr من ./pure ولا يعرّفها محليًا
 * (قراءة نصية فقط — لا استيراد لـ server.js لأنه يعتمد على db.js/child_process/http). */
const serverSrc = fsx.readFileSync(pathx.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
chk(!/^const\s+normAr\s*=/m.test(serverSrc), 'server.js no longer defines normAr locally (static read)');
chk(importsFromPure(serverSrc, 'normAr'), 'server.js imports normAr from ./pure (static read)');
chk(/const\s+norm\s*=\s*normAr;/.test(serverSrc),
  'server.js keeps the `const norm = normAr;` alias (static read)');

/* فحص ساكن: pad2 نُقلت إلى ./pure وحُذفت التعريفات المحلية الثلاثة (Phase 0.3C-B4a) */
const borseFetchSrc = fsx.readFileSync(pathx.join(__dirname, '..', '..', 'src', 'borse-fetch.js'), 'utf8');
chk(!/^const\s+pad2\s*=/m.test(pbixSrc), 'pbix.js no longer defines pad2 locally (static read)');
chk(importsFromPure(pbixSrc, 'pad2'), 'pbix.js imports pad2 from ./pure in the same import (static read)');
chk(!/^const\s+pad2\s*=/m.test(serverSrc), 'server.js no longer defines pad2 locally (static read)');
chk(importsFromPure(serverSrc, 'pad2'), 'server.js imports pad2 from ./pure in the same import (static read)');
chk(!/^const\s+pad2\s*=/m.test(borseFetchSrc), 'borse-fetch.js no longer defines pad2 locally (static read)');
chk(importsFromPure(borseFetchSrc, 'pad2'), 'borse-fetch.js imports pad2 from ./pure (static read)');
/* إشارات pad2: سطر الاستيراد + النداءات الفعلية.
 * pbix=4 (استيراد + 3 نداءات)، server=5 (استيراد + 4 نداءات)، borse-fetch=9 (استيراد + 8 نداءات). */
chk((pbixSrc.match(/\bpad2\b/g) || []).length === 4,
  'pbix.js references pad2 exactly 4 times: 1 import + 3 calls (static read)');
chk((serverSrc.match(/\bpad2\b/g) || []).length === 5,
  'server.js references pad2 exactly 5 times: 1 import + 4 calls (static read)');
chk((borseFetchSrc.match(/\bpad2\b/g) || []).length === 9,
  'borse-fetch.js references pad2 exactly 9 times: 1 import + 8 calls (static read)');
/* لا توحيد مع `pad` (اسم مختلف) — pad2 يجب ألا تُخلط بـ pad */
chk(!/\bpad\b/.test(pbixSrc) && !/\bpad\b/.test(borseFetchSrc),
  'pbix.js/borse-fetch.js contain no `pad` (distinct from pad2) (static read)');

/* =====================================================================
 * (2) النسخ المرجعية — منقولة حرفيًا من الأجسام السابقة (قبل النقل).
 *     clsKeyRefA: الجسم السابق في analytics.js (قبل 0.3C-B1)
 *     clsKeyRefP: الجسم السابق في pbix.js       (قبل 0.3C-B1b)
 *     normArRef:  الجسم السابق في server.js     (قبل 0.3C-B2a)
 *     لا تُعَدّل؛ هي مراجع التكافؤ.
 * ===================================================================== */
function clsKeyRefA(s) {
  return String(s || '')
    .replace(/[\u0640\s]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
}
function clsKeyRefP(v) {
  return String(v || '')
    .replace(/[\u0640\s]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
}
/* normArRef: الجسم السابق في server.js (قبل 0.3C-B2a) — منقول حرفيًا */
const normArRef = s => String(s === null || s === undefined ? '' : s).toLowerCase()
  .replace(/[أإآٱ]/g, 'ا').replace(/[ىي]/g, 'ي').replace(/[ةه]/g, 'ه')
  .replace(/[\u064B-\u065F\u0670]/g, '').replace(/[\s,،_()\-]/g, '');
/* ceil1000Ref: الجسم السابق في pbix.js (قبل 0.3C-B3a) — منقول حرفيًا */
const ceil1000Ref = x => Math.ceil(x / 1000) * 1000;
/* pad2Ref: الجسم السابق (قبل 0.3C-B4a) — منقول حرفيًا (كان بمعامل `x` فى pbix.js
 * و`n` فى server.js/borse-fetch.js؛ الفرق تسمية فقط، والجسم نفسه). */
const pad2Ref = n => String(n).padStart(2, '0');

/* =====================================================================
 * (3) سلوك clsKey — يُشتق من جسم الدالة نفسها
 * ===================================================================== */
console.log('\n== pure.js — clsKey behaviour ==');

/* نصوص عربية معتادة (بلا تغيير) */
eq(pure.clsKey('الذرة'), 'الذره', 'plain Arabic: ة→ه');
eq(pure.clsKey('الصويا'), 'الصويا', 'plain Arabic unchanged (no tatweel/hamza)');
eq(pure.clsKey('بذرة'), 'بذره', 'بذرة → بذره');

/* الهمزات */
eq(pure.clsKey('أرز'), 'ارز', 'أ → ا');
eq(pure.clsKey('إنتاج'), 'انتاج', 'إ → ا');
eq(pure.clsKey('آثار'), 'اثار', 'آ → ا');
eq(pure.clsKey('ٱمان'), 'امان', 'ٱ → ا');

/* ى → ي */
eq(pure.clsKey('مصطفى'), 'مصطفي', 'ى → ي');

/* التطويل والفراغات */
eq(pure.clsKey('الــــــــــذرة'), 'الذره', 'tatweel removed + ة→ه');
eq(pure.clsKey('الصو يا'), 'الصويا', 'internal space removed');
eq(pure.clsKey('\tبذرة\n'), 'بذره', 'tab/newline removed');

/* القيم الفارغة/null/undefined/أرقام — كما يسمح الجسم القديم */
eq(pure.clsKey(null), '', 'null → ""');
eq(pure.clsKey(undefined), '', 'undefined → ""');
eq(pure.clsKey(''), '', '"" → ""');
eq(pure.clsKey(0), '', '0 (falsy) → ""');
eq(pure.clsKey(123), '123', '123 → "123" (truthy number)');
eq(pure.clsKey(false), '', 'false (falsy) → ""');

/* حالات تميّز clsKey عن normAr — بلا استيراد normAr */
/* normAr يُصغّر الحالة؛ clsKey لا يفعل */
eq(pure.clsKey('ABC'), 'ABC', 'clsKey keeps case (unlike normAr)');
/* normAr يُسقط الفواصل/الأقواس/الشرطات والتشكيل؛ clsKey لا */
eq(pure.clsKey('a,b(c)-d'), 'a,b(c)-d', 'clsKey keeps , ( ) - (unlike normAr)');
eq(pure.clsKey('ذَرة'), 'ذَره', 'clsKey keeps diacritics (unlike normAr)');

/* =====================================================================
 * (4) تكافؤ حرفي مع النسختين المرجعيتين على مجموعة مدخلات
 * ===================================================================== */
console.log('\n== pure.js — clsKey equivalence with previous bodies ==');

const samples = [
  'الذرة', 'الــــــــــذرة', 'الصويا', 'البذرة', 'بذرة', 'دوار الشمس', 'دوارالشمس',
  'دى جى اس', 'ديجياس', 'جلوتين', 'كسب', 'دريس', 'سيلاج', 'تفلبنجر',
  'أرز', 'إنتاج', 'آثار', 'ٱمان', 'مصطفى', 'ABC', 'a,b(c)-d', 'ذَرة',
  'الذرة ', ' الذرة', 'الذره', '', '   ', '١٢٣', '123', null, undefined, 0, false,
];

/* مقابل الجسم السابق في analytics.js (قبل 0.3C-B1) */
let mismatchesA = 0;
const badA = [];
for (const s of samples) {
  const a = pure.clsKey(s);
  const b = clsKeyRefA(s);
  if (a !== b) { mismatchesA++; badA.push(`${JSON.stringify(s)}: pure=${JSON.stringify(a)} refA=${JSON.stringify(b)}`); }
}
chk(mismatchesA === 0, `clsKey === previous analytics.js body on ${samples.length} samples`
  + (badA.length ? ` — mismatches: ${badA.join(' | ')}` : ''));

/* مقابل الجسم السابق في pbix.js (قبل 0.3C-B1b) */
let mismatchesP = 0;
const badP = [];
for (const s of samples) {
  const a = pure.clsKey(s);
  const b = clsKeyRefP(s);
  if (a !== b) { mismatchesP++; badP.push(`${JSON.stringify(s)}: pure=${JSON.stringify(a)} refP=${JSON.stringify(b)}`); }
}
chk(mismatchesP === 0, `clsKey === previous pbix.js body on ${samples.length} samples`
  + (badP.length ? ` — mismatches: ${badP.join(' | ')}` : ''));

/* النسختان المرجعيتان متطابقتان سلوكيًا (الفرق الوحيد اسم الوسيط) */
let mismatchesAP = 0;
const badAP = [];
for (const s of samples) {
  const a = clsKeyRefA(s);
  const b = clsKeyRefP(s);
  if (a !== b) { mismatchesAP++; badAP.push(`${JSON.stringify(s)}: refA=${JSON.stringify(a)} refP=${JSON.stringify(b)}`); }
}
chk(mismatchesAP === 0, `previous analytics.js body === previous pbix.js body on ${samples.length} samples`
  + (badAP.length ? ` — mismatches: ${badAP.join(' | ')}` : ''));

/* =====================================================================
 * (5) سلوك normAr — يُشتق من جسم الدالة نفسها (server.js قبل 0.3C-B2a)
 * ===================================================================== */
console.log('\n== pure.js — normAr behaviour ==');

/* القيم الفارغة/null/undefined/مسافات */
eq(pure.normAr(null), '', 'null → ""');
eq(pure.normAr(undefined), '', 'undefined → ""');
eq(pure.normAr(''), '', '"" → ""');
eq(pure.normAr(' '), '', 'space → ""');
eq(pure.normAr('   '), '', 'multiple spaces → ""');

/* الأرقام والقيم غير النصية (مُحوَّلة عبر String) */
eq(pure.normAr(0), '0', '0 → "0" (NOT empty, unlike clsKey)');
eq(pure.normAr(123), '123', '123 → "123"');
eq(pure.normAr(false), 'false', 'false → "false"');
eq(pure.normAr(true), 'true', 'true → "true"');

/* العربية: همزات/ألف مقصورة/تاء مربوطة/هاء */
eq(pure.normAr('أرز'), 'ارز', 'أ → ا');
eq(pure.normAr('إنتاج'), 'انتاج', 'إ → ا');
eq(pure.normAr('آثار'), 'اثار', 'آ → ا');
eq(pure.normAr('ٱمان'), 'امان', 'ٱ → ا');
eq(pure.normAr('مصطفى'), 'مصطفي', 'ى → ي');
eq(pure.normAr('مصطفي'), 'مصطفي', 'ي kept as ي');
eq(pure.normAr('بذرة'), 'بذره', 'ة → ه');
eq(pure.normAr('بذره'), 'بذره', 'ه kept as ه');

/* التشكيل يُحذف */
eq(pure.normAr('ذَرة'), 'ذره', 'diacritics removed');
eq(pure.normAr('مُصْطَفَى'), 'مصطفي', 'multiple diacritics removed');

/* حذف الفواصل/الأقواس/الشرطات/الشرطة السفلية/المسافات/الأمثلة الجديدة */
eq(pure.normAr('a,b(c)-d'), 'abcd', 'commas/parens/hyphen removed');
eq(pure.normAr('a_b'), 'ab', 'underscore removed');
eq(pure.normAr('a-b'), 'ab', 'hyphen removed');
eq(pure.normAr('a b'), 'ab', 'space removed');
eq(pure.normAr('a\nb'), 'ab', 'newline removed');
eq(pure.normAr('a\tb'), 'ab', 'tab removed');
eq(pure.normAr('أ،ب'), 'اب', 'Arabic comma removed');

/* تصغير الحالة */
eq(pure.normAr('ABC'), 'abc', 'lowercased');

/* حالة مميّزة: التطويل \u0640 يبقى في normAr (بخلاف clsKey) */
eq(pure.normAr('الــــرة'), 'الــــره', 'tatweel is KEPT in normAr (ة→ه only)');
chk(pure.normAr('الــــرة') !== pure.clsKey('الــــرة'),
  'normAr keeps tatweel while clsKey removes it');

/* =====================================================================
 * (6) تمييز normAr عن clsKey — للمدخلات التي ثبت اختلاف سلوكها
 * ===================================================================== */
console.log('\n== pure.js — normAr vs clsKey differences ==');

const diffCases = [
  ['ABC'],            /* حالة الأحرف */
  ['a,b(c)-d'],       /* الترقيم */
  ['a_b'], ['a-b'],   /* الشرطة السفلية/الشرطة */
  ['ذَرة'],           /* التشكيل */
  ['الــــرة'],       /* التطويل */
  [0], [false],       /* القيم الكاذبة/الأرقام */
];
let diffOk = 0;
for (const c of diffCases) {
  const x = c[0];
  chk(pure.normAr(x) !== pure.clsKey(x),
    `normAr differs from clsKey for ${JSON.stringify(x)} — normAr=${JSON.stringify(pure.normAr(x))} clsKey=${JSON.stringify(pure.clsKey(x))}`);
  diffOk++;
}

/* =====================================================================
 * (7) تكافؤ حرفي بين pure.normAr وnormArRef
 * ===================================================================== */
console.log('\n== pure.js — normAr equivalence with previous body ==');

const normSamples = [
  'الذرة', 'الــــرة', 'الصويا', 'البذرة', 'بذرة', 'بذره', 'دوار الشمس', 'دوارالشمس',
  'دى جى اس', 'ديجياس', 'أرز', 'إنتاج', 'آثار', 'ٱمان', 'مصطفى', 'مصطفي',
  'ذَرة', 'مُصْطَفَى', 'ABC', 'abc', 'a,b(c)-d', 'a_b', 'a-b', 'a b', 'a\nb', 'a\tb',
  'أ،ب', 'الذرة ', ' الذرة', 'الذره', '', '   ', '١٢٣', '123',
  null, undefined, 0, 123, false, true,
];
let mismatchesN = 0;
const badN = [];
for (const s of normSamples) {
  const a = pure.normAr(s);
  const b = normArRef(s);
  if (a !== b) { mismatchesN++; badN.push(`${JSON.stringify(s)}: pure=${JSON.stringify(a)} ref=${JSON.stringify(b)}`); }
}
chk(mismatchesN === 0, `normAr === previous server.js body on ${normSamples.length} samples`
  + (badN.length ? ` — mismatches: ${badN.join(' | ')}` : ''));

/* =====================================================================
 * (8) سلوك ceil1000 — يُشتق من جسم الدالة نفسها (pbix.js قبل 0.3C-B3a)
 * ===================================================================== */
console.log('\n== pure.js — ceil1000 behaviour ==');

/* قيم صحيحة/عشرية معتادة */
eq(pure.ceil1000(0), 0, '0 → 0');
eq(pure.ceil1000(1), 1000, '1 → 1000');
eq(pure.ceil1000(999), 1000, '999 → 1000');
eq(pure.ceil1000(1000), 1000, '1000 → 1000');
eq(pure.ceil1000(1001), 2000, '1001 → 2000');
eq(pure.ceil1000(1500), 2000, '1500 → 2000');
eq(pure.ceil1000(1999), 2000, '1999 → 2000');
eq(pure.ceil1000(1234.5), 2000, '1234.5 → 2000');

/* السالب (تقريب نحو الصفر) */
eq(pure.ceil1000(-1), 0, '-1 → 0');
eq(pure.ceil1000(-999), 0, '-999 → 0');
eq(pure.ceil1000(-1000), -1000, '-1000 → -1000');
eq(pure.ceil1000(-1500), -1000, '-1500 → -1000');

/* القيم غير الرقمية — السلوك الأصلي بلا حماية (مُثبَّت كما هو) */
eq(pure.ceil1000('5000'), 5000, '"5000" → 5000');
eq(pure.ceil1000(null), 0, 'null → 0');
eq(pure.ceil1000(false), 0, 'false → 0');
eq(pure.ceil1000(''), 0, '"" → 0');
eq(pure.ceil1000(true), 1000, 'true → 1000');
chk(Number.isNaN(pure.ceil1000(undefined)), 'undefined → NaN (Number.isNaN)');
chk(Number.isNaN(pure.ceil1000(NaN)), 'NaN → NaN (Number.isNaN)');
chk(pure.ceil1000(Infinity) === Infinity, 'Infinity → Infinity');

/* حالات المقارنة الحدّية التي تُقرّر حالة التسعير/السداد في pbix.js */
eq(pure.ceil1000(null) === pure.ceil1000(0), true, 'ceil1000(null) === ceil1000(0) → true');
eq(pure.ceil1000(undefined) === pure.ceil1000(0), false, 'ceil1000(undefined) === ceil1000(0) → false');
eq(pure.ceil1000(NaN) === pure.ceil1000(0), false, 'ceil1000(NaN) === ceil1000(0) → false');
eq(pure.ceil1000(999) === pure.ceil1000(1000), true, 'ceil1000(999) === ceil1000(1000) → true');
eq(pure.ceil1000(2000) === pure.ceil1000(1999), true, 'ceil1000(2000) === ceil1000(1999) → true');
eq(pure.ceil1000(1500) === pure.ceil1000(1000), false, 'ceil1000(1500) === ceil1000(1000) → false');

/* =====================================================================
 * (9) تكافؤ حرفي بين pure.ceil1000 وceil1000Ref
 * ===================================================================== */
console.log('\n== pure.js — ceil1000 equivalence with previous body ==');

const ceilSamples = [
  0, 1, 999, 1000, 1001, 1500, 1999, 2000, 2499, 2501, -1, -999, -1000, -1500, -2000,
  1234.5, 0.4, 999.9, '5000', '0', '', 'abc', null, undefined, false, true, NaN, Infinity, -Infinity,
];
let mismatchesC = 0;
const badC = [];
for (const x of ceilSamples) {
  const a = pure.ceil1000(x);
  const b = ceil1000Ref(x);
  /* NaN !== NaN، لذا نقارن عبر Object.is (يلتقط NaN===NaN ويميّز +0/-0) */
  if (!Object.is(a, b)) {
    mismatchesC++;
    badC.push(`${String(x)}: pure=${String(a)} ref=${String(b)}`);
  }
}
chk(mismatchesC === 0, `ceil1000 === previous pbix.js body on ${ceilSamples.length} samples`
  + (badC.length ? ` — mismatches: ${badC.join(' | ')}` : ''));

/* =====================================================================
 * (10) سلوك pad2 — يُشتق من جسم الدالة نفسها (قبل 0.3C-B4a)
 * ===================================================================== */
console.log('\n== pure.js — pad2 behaviour ==');

/* أعداد صحيحة معتادة */
eq(pure.pad2(0), '00', '0 → "00"');
eq(pure.pad2(1), '01', '1 → "01"');
eq(pure.pad2(5), '05', '5 → "05"');
eq(pure.pad2(9), '09', '9 → "09"');
eq(pure.pad2(10), '10', '10 → "10"');
eq(pure.pad2(12), '12', '12 → "12"');
eq(pure.pad2(59), '59', '59 → "59"');
eq(pure.pad2(99), '99', '99 → "99"');

/* أطول من خانتين — لا اقتطاع */
eq(pure.pad2(100), '100', '100 → "100" (لا اقتطاع)');
eq(pure.pad2(1234), '1234', '1234 → "1234"');
eq(pure.pad2(-10), '-10', '-10 → "-10"');
eq(pure.pad2(-123), '-123', '-123 → "-123"');

/* السالب — الطول已然 ≥ 2 فلا يُصفَّر (سلوك أصلي) */
eq(pure.pad2(-1), '-1', '-1 → "-1" (لا تصفير)');
eq(pure.pad2(-9), '-9', '-9 → "-9" (لا تصفير)');

/* العشرية — تُمرَّر كما هي بصيغة String */
eq(pure.pad2(0.5), '0.5', '0.5 → "0.5"');
eq(pure.pad2(1.5), '1.5', '1.5 → "1.5"');
eq(pure.pad2(10.25), '10.25', '10.25 → "10.25"');

/* السلاسل النصية */
eq(pure.pad2(''), '00', '"" → "00"');
eq(pure.pad2('5'), '05', '"5" → "05"');
eq(pure.pad2('9'), '09', '"9" → "09"');
eq(pure.pad2('05'), '05', '"05" → "05"');
eq(pure.pad2('99'), '99', '"99" → "99"');
eq(pure.pad2('123'), '123', '"123" → "123"');
eq(pure.pad2('abc'), 'abc', '"abc" → "abc"');
eq(pure.pad2(' 5'), ' 5', '" 5" → " 5" (لا يُصلح الفراغ)');
eq(pure.pad2('5 '), '5 ', '"5 " → "5 " (لا يُصلح الفراغ)');

/* القيم غير الرقمية — السلوك الأصلي بلا حماية (مُثبَّت كما هو) */
eq(pure.pad2(null), 'null', 'null → "null"');
eq(pure.pad2(undefined), 'undefined', 'undefined → "undefined"');
eq(pure.pad2(true), 'true', 'true → "true"');
eq(pure.pad2(false), 'false', 'false → "false"');
eq(pure.pad2(NaN), 'NaN', 'NaN → "NaN"');
eq(pure.pad2(Infinity), 'Infinity', 'Infinity → "Infinity"');
eq(pure.pad2(-Infinity), '-Infinity', '-Infinity → "-Infinity"');

/* =====================================================================
 * (11) تكافؤ حرفي بين pure.pad2 وpad2Ref
 * ===================================================================== */
console.log('\n== pure.js — pad2 equivalence with previous body ==');

const pad2Samples = [
  0, 1, 5, 9, 10, 12, 59, 99, 100, 1234, -1, -9, -10, -123,
  0.5, 1.5, 10.25, 123.007, NaN, Infinity, -Infinity,
  '', '0', '5', '05', '9', '99', '123', 'abc', ' 5', '5 ', 'xxxxx',
  null, undefined, true, false, {}, [], [1],
];
let mismatchesP2 = 0;
const badP2 = [];
for (const x of pad2Samples) {
  const a = pure.pad2(x);
  const b = pad2Ref(x);
  /* NaN !== NaN فى المدخل، لكن الناتج نص؛ نقارن بـ Object.is لأى حال */
  if (!Object.is(a, b)) {
    mismatchesP2++;
    badP2.push(`${String(x)}: pure=${String(a)} ref=${String(b)}`);
  }
}
chk(mismatchesP2 === 0, `pad2 === previous body on ${pad2Samples.length} samples`
  + (badP2.length ? ` — mismatches: ${badP2.join(' | ')}` : ''));

/* =====================================================================
 * (B5) مساعدات تواريخ UTC — Phase 0.3C-B5
 * ===================================================================== */
console.log('\n== pure.js — B5 UTC date helpers ==');

/* نسخ مرجعية منقولة حرفيًا من src/cost-engine.js (قبل B5) */
const D_RE_REF = /^(\d{4})-(\d{2})-(\d{2})$/;
const toUtcRef = s => { const m = D_RE_REF.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
function shiftRef(s, n) {
  const t = toUtcRef(s);
  if (!isFinite(t)) return s;
  const d = new Date(t + n * 86400000);
  const p = x => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
function nextDayRef(s) { return shiftRef(s, 1); }
function eachDayRef(from, to) {
  const out = [];
  const s = toUtcRef(from), e = toUtcRef(to);
  if (!isFinite(s) || !isFinite(e) || s > e) return out;
  for (let t = s; t <= e; t += 86400000) {
    const d = new Date(t);
    const p = x => String(x).padStart(2, '0');
    out.push(`${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`);
  }
  return out;
}

chk(typeof pure.toUtc === 'function', 'exports toUtc');
chk(typeof pure.shift === 'function', 'exports shift');
chk(typeof pure.nextDay === 'function', 'exports nextDay');
chk(typeof pure.eachDay === 'function', 'exports eachDay');

/* toUtc: valid + invalid */
eq(pure.toUtc('2026-02-28'), toUtcRef('2026-02-28'), 'toUtc("2026-02-28") matches ref');
eq(pure.toUtc('2026-02-28'), 1772236800000, 'toUtc("2026-02-28") = 1772236800000');
eq(pure.toUtc(''), NaN, 'toUtc("") -> NaN');
eq(pure.toUtc(null), NaN, 'toUtc(null) -> NaN');
eq(pure.toUtc('junk'), NaN, 'toUtc("junk") -> NaN');
/* Date.UTC rolls over invalid month/day (e.g. month 13 -> Jan next year); assert consistency with ref only. */
eq(pure.toUtc('2026-13-01'), toUtcRef('2026-13-01'), 'toUtc("2026-13-01") matches ref (rolls over)');
eq(pure.toUtc('2026-02-30'), toUtcRef('2026-02-30'), 'toUtc("2026-02-30") matches ref (rolls over)');

/* shift: basic + month/year rollover + invalid passthrough */
eq(pure.shift('2026-02-28', 1), '2026-03-01', 'shift +1 day (month rollover)');
eq(pure.shift('2026-02-28', -1), '2026-02-27', 'shift -1 day');
eq(pure.shift('2026-12-31', 1), '2027-01-01', 'shift year rollover');
eq(pure.shift('2024-02-29', 1), '2024-03-01', 'shift leap day');
eq(pure.shift('not-a-date', 3), 'not-a-date', 'shift invalid returns input unchanged');
eq(pure.shift('2026-02-28', 0), '2026-02-28', 'shift 0');

/* consistency with ref across samples */
const shiftSamples = ['2026-01-01','2026-02-28','2026-03-15','2026-12-31','2024-02-29','bad',''];
let shiftMismatch = 0, shiftBad = [];
for (const s of shiftSamples) {
  for (const n of [-5, -1, 0, 1, 5, 30]) {
    const a = pure.shift(s, n);
    const b = shiftRef(s, n);
    if (!Object.is(a, b)) { shiftMismatch++; shiftBad.push(`${s}/${n}: pure=${a} ref=${b}`); }
  }
}
chk(shiftMismatch === 0, `shift === previous body on ${shiftSamples.length * 6} samples`
  + (shiftBad.length ? ` — ${shiftBad.join(' | ')}` : ''));

/* nextDay */
eq(pure.nextDay('2026-02-28'), '2026-03-01', 'nextDay("2026-02-28")');
eq(pure.nextDay('2026-12-31'), '2027-01-01', 'nextDay year rollover');

/* eachDay */
eq(pure.eachDay('2026-02-27', '2026-03-02'),
  ['2026-02-27','2026-02-28','2026-03-01','2026-03-02'], 'eachDay inclusive range');
eq(pure.eachDay('2026-03-02', '2026-02-27'), [], 'eachDay reversed range -> []');
eq(pure.eachDay('bad', '2026-03-02'), [], 'eachDay invalid from -> []');
eq(pure.eachDay('2026-02-27', 'bad'), [], 'eachDay invalid to -> []');
eq(pure.eachDay('2026-02-28', '2026-02-28'), ['2026-02-28'], 'eachDay single day');
chk(Array.isArray(pure.eachDay('2026-01-01', '2026-01-05')), 'eachDay returns array');

/* consistency with ref across ranges */
const rangeSamples = [['2026-01-01','2026-01-05'], ['2026-02-27','2026-03-02'], ['2024-02-28','2024-03-02'], ['bad','2026-01-02']];
let rangeMismatch = 0, rangeBad = [];
for (const [f, t] of rangeSamples) {
  const a = pure.eachDay(f, t);
  const b = eachDayRef(f, t);
  if (JSON.stringify(a) !== JSON.stringify(b)) { rangeMismatch++; rangeBad.push(`${f}..${t}: pure=${JSON.stringify(a)} ref=${JSON.stringify(b)}`); }
}
chk(rangeMismatch === 0, `eachDay === previous body on ${rangeSamples.length} ranges`
  + (rangeBad.length ? ` — ${rangeBad.join(' | ')}` : ''));

/* فحص ساكن: cost-engine.js يستورد toUtc/shift/nextDay/eachDay من ./pure ولا يعرّفها محليًا */
const ceSrc = fsx.readFileSync(pathx.join(__dirname, '..', '..', 'src', 'cost-engine.js'), 'utf8');
chk(!/^const\s+toUtc\s*=/m.test(ceSrc) && !/^function\s+shift\s*\(/m.test(ceSrc)
  && !/^function\s+nextDay\s*\(/m.test(ceSrc) && !/^function\s+eachDay\s*\(/m.test(ceSrc),
  'cost-engine.js no longer defines toUtc/shift/nextDay/eachDay locally (static read)');
chk(importsFromPure(ceSrc, 'toUtc') && importsFromPure(ceSrc, 'shift')
  && importsFromPure(ceSrc, 'nextDay') && importsFromPure(ceSrc, 'eachDay'),
  'cost-engine.js imports toUtc/shift/nextDay/eachDay from ./pure (static read)');

/* =====================================================================
 * (B6) مساعدات رقمية — Phase 0.3C-B6
 * ===================================================================== */
console.log('\n== pure.js — B6 numeric helpers ==');

/* نسخ مرجعية منقولة حرفيًا من src/analytics.js (قبل B6) */
const numfRef = v => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const r2Ref = n => Math.round(numfRef(n) * 100) / 100;

chk(typeof pure.numf === 'function', 'exports numf');
chk(typeof pure.r2 === 'function', 'exports r2');

/* numf: null/undefined/'' -> 0 */
eq(pure.numf(null), 0, 'numf(null) -> 0');
eq(pure.numf(undefined), 0, 'numf(undefined) -> 0');
eq(pure.numf(''), 0, 'numf("") -> 0');
eq(pure.numf(0), 0, 'numf(0) -> 0');
eq(pure.numf(false), 0, 'numf(false) -> 0');
/* numf: valid numbers */
eq(pure.numf(5), 5, 'numf(5) -> 5');
eq(pure.numf(3.14), 3.14, 'numf(3.14) -> 3.14');
eq(pure.numf('42'), 42, 'numf("42") -> 42');
eq(pure.numf('3.5'), 3.5, 'numf("3.5") -> 3.5');
eq(pure.numf(true), 1, 'numf(true) -> 1');
/* numf: invalid -> 0 */
eq(pure.numf('abc'), 0, 'numf("abc") -> 0');
eq(pure.numf(NaN), 0, 'numf(NaN) -> 0');
eq(pure.numf(Infinity), Infinity, 'numf(Infinity) -> Infinity (Number(Infinity) truthy)');
eq(pure.numf({}), 0, 'numf({}) -> 0');

/* r2: rounding to 2 decimals */
eq(pure.r2(3.14159), 3.14, 'r2(3.14159) -> 3.14');
eq(pure.r2(3.145), 3.15, 'r2(3.145) -> 3.15 (or 3.14 per banker? Math.round)');
eq(pure.r2(0), 0, 'r2(0) -> 0');
eq(pure.r2(null), 0, 'r2(null) -> 0 (via numf)');
eq(pure.r2(undefined), 0, 'r2(undefined) -> 0');
eq(pure.r2(''), 0, 'r2("") -> 0');
eq(pure.r2('2.345'), 2.35, 'r2("2.345") -> 2.35');
eq(pure.r2(-1.234), -1.23, 'r2(-1.234) -> -1.23');
eq(pure.r2(100), 100, 'r2(100) -> 100');

/* consistency with ref across samples */
const numfSamples = [null, undefined, '', 0, 5, 3.14, '42', 'abc', NaN, true, false, {}, []];
let numfMismatch = 0, numfBad = [];
for (const x of numfSamples) {
  const a = pure.numf(x);
  const b = numfRef(x);
  if (!Object.is(a, b)) { numfMismatch++; numfBad.push(`${String(x)}: pure=${a} ref=${b}`); }
}
chk(numfMismatch === 0, `numf === previous body on ${numfSamples.length} samples`
  + (numfBad.length ? ` — ${numfBad.join(' | ')}` : ''));

const r2Samples = [null, undefined, '', 0, 3.14159, -1.234, '2.345', 100, NaN];
let r2Mismatch = 0, r2Bad = [];
for (const x of r2Samples) {
  const a = pure.r2(x);
  const b = r2Ref(x);
  if (!Object.is(a, b)) { r2Mismatch++; r2Bad.push(`${String(x)}: pure=${a} ref=${b}`); }
}
chk(r2Mismatch === 0, `r2 === previous body on ${r2Samples.length} samples`
  + (r2Bad.length ? ` — ${r2Bad.join(' | ')}` : ''));

/* note: r2 uses numf internally, so Number(v)||0; Infinity -> 0 (numf(Infinity)=0) */
eq(pure.r2(Infinity), Infinity, 'r2(Infinity) -> Infinity (via numf)');

/* فحص ساكن: analytics.js يستورد numf/r2 من ./pure ولا يعرّفهما محليًا */
const analyticsSrc = fsx.readFileSync(pathx.join(__dirname, '..', '..', 'src', 'analytics.js'), 'utf8');
chk(!/^const\s+numf\s*=/m.test(analyticsSrc), 'analytics.js no longer defines numf locally (static read)');
chk(!/^const\s+r2\s*=/m.test(analyticsSrc), 'analytics.js no longer defines r2 locally (static read)');
chk(importsFromPure(analyticsSrc, 'numf'), 'analytics.js imports numf from ./pure (static read)');
chk(importsFromPure(analyticsSrc, 'r2'), 'analytics.js imports r2 from ./pure (static read)');

console.log(`\npure.test.js — pass=${pass} fail=${fail}`);
console.log('NOTE: B1 moved clsKey; B1b shared source for pbix.js; B2a moved normAr; B3a moved ceil1000; B4a moved pad2; B5 moved UTC date helpers; B6 moved numf/r2.');
console.log('NOTE: pbix.js retains its own r2 (different null semantics -> null) — NOT unified (by design).');
console.log('NOTE: Report results are NOT verified here.');
if (fail > 0) process.exit(1);
