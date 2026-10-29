'use strict';
/**
 * استيراد تقرير قائم من التطبيق إلى المصمم — اختبار وظيفي
 * =========================================================================
 * يثبت: أن ناتج التقرير الحقيقي becomes a designer definition قابل للتحرير،
 *        وأن ما لا يُستخرج يُذكر صراحةً (لا اختلاق)، وأن الأصل لا يُمس.
 * بيانات اصطناعية فقط · بلا DB · بلا شبكة.
 */
const guard = require('./_guard');
guard.install();

const LR = require('../../src/legacy-report');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

console.log('== استيراد تقرير قائم إلى المصمم ==');

const ROWS = [
  { item: 'صنف أ', qty: 10, value: 50.5, doc_date: '2026-01-05' },
  { item: 'صنف ب', qty: 3, value: 12, doc_date: '2026-02-07' },
  { item: 'صنف ج', qty: null, value: 0, doc_date: '2026-03-09' },
];

/* ---------- 1) الاستخراج الساكن من الشيفرة (evidence: code) ---------- */
{
  const fnText = "F => (F.mode === 'detail' ? A.salesDetail(F) : DB.all(`SELECT * FROM sales ORDER BY id`))";
  const code = {
    analytics: 'async function salesDetail(F = {}) { return all(`SELECT sp.item, sp.qty FROM sp JOIN items i ON i.id = sp.item_id WHERE ${F.filter}`); }',
    pbix: 'async function contractCoverage(F = {}) { return all(`SELECT * FROM contract_balances`); }',
  };
  const st = LR.staticFromCode(fnText, code);
  chk(st.evidence === 'code', 'الاستخراج الساكن موسوم evidence=code');
  chk(st.functions.includes('A.salesDetail') && st.functions.includes('DB.all'), 'الدوال المستدعاة مستخرجة: ' + st.functions.join(', '));
  chk(st.tables.includes('sales') && st.tables.includes('sp') && st.tables.includes('items'),
    'جداول SQL مستخرجة من جسم الدالة: ' + st.tables.join(', '));
  chk(st.params.includes('mode') && st.params.includes('filter'), 'معاملات الفلاتر مستخرجة: ' + st.params.join(', '));
  chk(st.confidence === 'low', 'ثقة الاستخراج الساكن منخفضة (يُراجَع مقابل التنفيذ)');
}

/* ---------- 2) التحويل من ناتج حقيقي ---------- */
{
  const rows = ROWS.map(r => Object.assign({}, r));
  const out = LR.convertToDesigner({
    name: 'sales-total', label: 'المبيعات', desc: 'تجميع المبيعات',
    rows,
    declared: [{ name: 'item' }, { name: 'qty' }, { name: 'value' }, { name: 'missing_col' }],
    staticMeta: { functions: ['A.salesGroup'], params: ['by', 'per'], tables: ['sales', 'sp'], evidence: 'code' },
  });
  const d = out.report;
  const ex = out.extraction;

  chk(d.legacy && d.legacy.name === 'sales-total', 'التعريف يحمل مرجع التقرير القائم');
  chk(d.title === 'المبيعات' && d.description === 'تجميع المبيعات', 'العنوان والوصف منقولان');
  chk(d.runId === '', 'لا نتيجة تشغيل مرتبطة (المصدر هو التقرير القائم)');

  const heading = d.components.find(c => c.type === 'heading');
  const text = d.components.find(c => c.type === 'text');
  const kpis = d.components.filter(c => c.type === 'kpi');
  const table = d.components.find(c => c.type === 'table');
  chk(!!heading && heading.text === 'المبيعات', 'مكوّن عنوان قابل للتحرير');
  chk(!!text && text.text === 'تجميع المبيعات', 'مكوّن وصف قابل للتحرير');
  chk(kpis.length === 2 && kpis.every(k => k.column && k.agg), 'بطاقات مؤشرات للأعمدة الرقمية: ' + kpis.map(k => k.column).join(', '));
  chk(kpis.every(k => ['qty', 'value'].includes(k.column)), 'المؤشرات مولَّدة من الأعمدة الرقمية فقط');
  chk(!!table && table.columns.join(',') === 'item,qty,value,doc_date', 'جدول بأعمدة الناتج الحقيقي');

  chk(ex.runtime.ok === true && ex.runtime.rowCount === 3, 'الناتج الحقيقي مسجَّل (3 صفوف)');
  chk(ex.runtime.columns.every(c => c.evidence === 'runtime'), 'كل عمود موسوم evidence=runtime');
  chk(ex.runtime.columns.find(c => c.name === 'doc_date').type === 'date', 'نوع التاريخ مستنتج');
  chk(ex.runtime.columns.find(c => c.name === 'qty').type === 'number', 'نوع الرقم مستنتج رغم وجود NULL');
  chk(ex.declared.some(d2 => d2.evidence === 'registry'), 'الأعمدة المصرَّح بها موسومة evidence=registry');
  chk(ex.diff.missingAtRuntime.join(',') === 'missing_col', 'العمود المصرَّح به وغير الموجود مُبلَّغ');
  chk(ex.diff.notDeclared.join(',') === 'doc_date', 'العمود الموجود وغير المصرَّح به مُبلَّغ');
  chk(ex.notes.length >= 4, 'ملاحظات الاستخراج: ' + ex.notes.length);
  chk(ex.notes.some(n => /مستخرجة من ناتج التقرير الحقيقي/.test(n)), 'ملاحظة تذكر مصدر الأعمدة');
  chk(ex.notes.some(n => /استدلال/.test(n)), 'ملاحظة تفصل الاستدلال عن الحقيقة');

  /* الأصل لا يُمس: الصفوف الأصلية لم تتغيّر */
  chk(ROWS[0].qty === 10 && Object.keys(ROWS[0]).length === 4, 'صفوف الأصل لم تُعدَّل');
  chk(JSON.stringify(ROWS) === JSON.stringify([
    { item: 'صنف أ', qty: 10, value: 50.5, doc_date: '2026-01-05' },
    { item: 'صنف ب', qty: 3, value: 12, doc_date: '2026-02-07' },
    { item: 'صنف ج', qty: null, value: 0, doc_date: '2026-03-09' },
  ]), 'بيانات الأصل كما هي بالضبط');
}

/* ---------- 3) تعذّر التنفيذ ⇒ توثيق صريح (لا اختلاق) ---------- */
{
  const out = LR.convertToDesigner({
    name: 'pbix-home', label: 'الصفحة الرئيسية', desc: 'بطاقات',
    rows: null, columns: null,
    declared: [{ name: 'g1' }, { name: 'qty' }],
    staticMeta: { functions: ['A.contractPbixCards'], params: [], tables: ['contract_balances'], evidence: 'code' },
    runtimeError: 'relation "x" does not exist',
  });
  const ex = out.extraction;
  chk(ex.runtime.ok === false, 'الناتج غير متاح');
  chk(ex.runtime.error === 'relation "x" does not exist', 'سبب الخطأ محفوظ كما هو');
  chk(ex.runtime.columns.length === 0, 'لا أعمدة مختلقة');
  chk(ex.notes.some(n => /لم يُنفَّذ التقرير/.test(n)), 'ملاحظة صريحة بأن التقرير لم يُنفَّذ');
  chk(ex.notes.some(n => /غير مُثبت/.test(n)), 'التصريح وحده موسوم بأنه غير مُثبت');
  chk(out.report.components.every(c => c.type !== 'table' && c.type !== 'kpi'),
    'بدون بيانات ⇒ لا جدول ولا بطاقات (لا أعمدة مختلقة)');
  chk(ex.code.tables.includes('contract_balances'), 'الجداول المستخرجة من الشيفرة موجودة رغم تعذّر التنفيذ');
}

/* ---------- 4) استنتاج الأنواع ---------- */
{
  chk(LR.inferType([1, 2, 3]) === 'number', 'أرقام ⇒ number');
  chk(LR.inferType(['a', 'b']) === 'string', 'نصوص ⇒ string');
  chk(LR.inferType(['2026-01-05', '2026-02-07']) === 'date', 'تواريخ ⇒ date');
  chk(LR.inferType(['2026-01-05', 5]) === 'mixed', 'خلط ⇒ mixed');
  chk(LR.inferType([null, undefined, '']) === 'empty', 'بلا قيم ⇒ empty');
  chk(LR.inferType(['1,200', '3,400']) === 'number', 'أرقام بفواصل ⇒ number');
}

/* ---------- 5) حدود مولَّدة (لا انفجار في العدد) ---------- */
{
  const many = [];
  for (let i = 0; i < 30; i++) many.push({ c: i, s: 'x' + i });
  const out = LR.convertToDesigner({ name: 'x', label: 'x', rows: many, declared: [] });
  const kpis = out.report.components.filter(c => c.type === 'kpi');
  const table = out.report.components.find(c => c.type === 'table');
  chk(kpis.length <= LR.MAX_KPI, 'عدد البطاقات محدود بـ' + LR.MAX_KPI);
  chk(table.columns.length <= LR.MAX_TABLE_COLS, 'عدد أعمدة الجدول محدود بـ' + LR.MAX_TABLE_COLS);
  chk(out.extraction.runtime.columns.length === 2, 'كل الأعمدة مستخرجة (الحد للعرض فقط): ' + out.extraction.runtime.columns.length);
  chk(out.extraction.runtime.rowCount === 30, 'عدد الصفوف كما هو');
}

/* ---------- 6) الربط في الواجهة (استيراد → معاينة → حفظ) ---------- */
{
  const fs = require('fs');
  const path = require('path');
  const IDX = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  const RD = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'report-designer.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'styles.css'), 'utf8');
  chk(IDX.includes('id="rs-legacy-list"') && IDX.includes('id="rs-legacy-import"') && IDX.includes('id="rs-legacy-notes"'),
    'لوحة الاستيراد موجودة في الواجهة (قائمة + زر + ملاحظات)');
  chk(RD.includes("apiCall('/api/reports/import-legacy'"), 'الواجهة تستدعي مسار الاستيراد');
  chk(RD.includes("apiCall('/api/reports')"), 'الواجهة تقرأ فهرس التقارير القائمة');
  chk(/payload\.legacy = legacySource/.test(RD), 'المعاينة ترسل مرجع التقرير القائم');
  chk(/legacy: legacySource \|\| null/.test(RD), 'تعريف التقرير يحمل المرجع (يُحفظ مع التقرير)');
  chk(/idEl\.value = '';/.test(RD), 'الاستيراد يفرّغ المعرّف ⇒ الحفظ ينشئ نسخة جديدة (الأصل لا يُستبدل)');
  chk(/columns = \(\(ex\.runtime && ex\.runtime\.columns\) \|\| \[\]\)\.map\(c => c\.name\)/.test(RD),
    'أعمدة الناتج تُملأ في المصمم (لتعديل الأعمدة والفلاتر)');
  chk(RD.includes('function renderLegacyNotes'), 'عرض ما استُخرج وما لم يُستخرج');
  chk(CSS.includes('.rd-legacy') && CSS.includes('.rd-note'), 'تنسيق اللوحة والملاحظات');
  chk(!/\beval\s*\(/.test(RD) && !/new Function\s*\(/.test(RD), 'لا تنفيذ اعتباطي في المصمم');
}

/* ---------- 7) فلاتر البيانات على مستوى التقرير ---------- */
{
  const fs = require('fs');
  const path = require('path');
  const S = require('../../src/report-schema');
  chk(Array.isArray(S.FILTER_OPS) && S.FILTER_OPS.indexOf('contains') >= 0, 'عمليات الفلاتر معرَّفة في النموذج');
  chk(S.MAX_FILTERS === 10, 'حدّ الفلاتر 10');
  const n = S.normalizeReport({ name: 'x', components: [], filters: [
    { column: 'qty', op: '>', value: 5 },
    { column: 'item', op: 'contains', value: 'A' },
    { column: '', op: '==' },
    { column: 'z', op: 'DROP TABLE' },
    { column: 'n', op: '==' },
  ] });
  chk(n.filters.length === 4, 'الفلاتر الصالحة فقط (بلا عمود تُسقط): ' + n.filters.length);
  chk(n.filters[0].column === 'qty' && n.filters[0].op === '>' && n.filters[0].value === 5, 'الفلتر الأول محفوظ');
  chk(n.filters[1].op === 'contains', 'العملية النصية محفوظة');
  chk(n.filters[2].column === 'z' && n.filters[2].op === '==', 'العملية غير المعروفة تُوحَّد إلى == (لا تُنفَّذ كعملية خام)');
  chk(n.filters[3].column === 'n', 'الفلتر الأخير محفوظ');
  const over = S.normalizeReport({ name: 'x', components: [], filters: Array.from({ length: 30 }, () => ({ column: 'c', op: '==' })) });
  chk(over.filters.length === 10, 'الفلاتر محدودة بـ10');

  const RD = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'report-designer.js'), 'utf8');
  const IDX = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  chk(IDX.includes('id="rs-filters-list"') && IDX.includes('id="rs-add-filter"'), 'لوحة الفلاتر في الواجهة');
  chk(/filters: reportFilters \|\| \[\]/.test(RD), 'التعريف يحمل فلاتر التقرير');
  chk(/function renderFilters\(\)/.test(RD) && /function addFilter\(\)/.test(RD), 'وظائف رسم/إضافة الفلتر موجودة');
  chk(/FILTER_OPS = \['>', '>=', '<', '<=', '==', '!=', 'contains'/.test(RD), 'قائمة العمليات في المصمم');
  chk(/reportFilters = Array\.isArray\(norm\.filters\)/.test(RD), 'استعادة الفلاتر عند فتح تقرير محفوظ');
  chk(/reportFilters = \[\];/.test(RD), 'تفريغ الفلاتر عند تقرير جديد');
}

chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');
console.log('\nlegacy_import.test.js — pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
