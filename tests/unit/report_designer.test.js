'use strict';
/**
 * اختبارات سلوكية لمصمم التقارير (Report Designer) — بيانات اصطناعية، معزولة.
 * - تخزين التقارير: src/report-store.js (حفظ/فتح/نسخة مستقلة/قائمة)
 * - إعدادات العرض المدعومة فعليًا: عبر محرك Python (fmt/decimals/showTitle/axisLabels/limit)
 * - لا اتصال ولا قاعدة بيانات (guard).
 */
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RS = require('../../src/report-store');
const RB = require('../../src/report-bridge');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);
const eq = (a, b, m) => chk(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('== report designer (storage + display settings) ==');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-des-'));

/* ---------- 1) التخزين: حفظ/فتح ---------- */
const comps = [
  { type: 'kpi', label: 'إجمالي المبيعات', column: 'amount', agg: 'sum', decimals: 2 },
  { type: 'table', columns: ['item', 'amount'], sort: 'amount', desc: true, limit: 25, decimals: 0 },
  { type: 'bar', title: 'المبيعات حسب الصنف', category: 'item', value: 'amount', agg: 'sum', showTitle: false, xLabel: 'الصنف', yLabel: 'القيمة' },
  { type: 'line', title: 'الاتجاه', category: 'day', value: 'amount', agg: 'sum' },
  { type: 'pie', title: 'التوزيع', category: 'item', value: 'amount', agg: 'sum' },
  { type: 'heading', text: 'تقرير المبيعات' },
  { type: 'text', text: 'ملاحظة توضيحية' },
];
const r1 = RS.saveReport({ name: 'تقرير المبيعات', runId: 'run_x', components: comps }, tmp);
chk(!r1.error && !!r1.id, 'saveReport يعيد معرّفًا');
chk(fs.existsSync(path.join(tmp, r1.id + '.json')), 'ملف التقرير موجود');

const back = RS.loadReport(r1.id, tmp);
chk(!!back, 'loadReport يُرجع التعريف');
chk(back.name === 'تقرير المبيعات' && back.runId === 'run_x', 'الاسم ومعرّف التشغيل محفوظان');
eq(back.components.length, 7, 'عدد المكونات محفوظ');
eq(back.components.map(c => c.type), ['kpi', 'table', 'bar', 'line', 'pie', 'heading', 'text'], 'ترتيب المكونات محفوظ');
chk(back.components[0].decimals === 2 && back.components[0].label === 'إجمالي المبيعات', 'إعدادات المؤشر محفوظة');
chk(back.components[1].limit === 25 && back.components[1].sort === 'amount' && back.components[1].desc === true, 'إعدادات الجدول محفوظة');
chk(back.components[2].showTitle === false && back.components[2].xLabel === 'الصنف' && back.components[2].yLabel === 'القيمة', 'إعدادات المخطط محفوظة');
chk(!!back.savedAt && !!back.createdAt, 'تواريخ الإنشاء/الحفظ موجودة');

/* ---------- 2) نسخة مستقلة باسم جديد ---------- */
const copy = RS.saveReport({ name: 'تقرير المبيعات - نسخة', components: comps.slice(0, 2) }, tmp);
chk(!copy.error && copy.id !== r1.id, '«حفظ باسم» ينشئ معرّفًا مستقلًا');
const orig = RS.loadReport(r1.id, tmp);
const copyBack = RS.loadReport(copy.id, tmp);
chk(orig && orig.components.length === 7, 'الأصل لم يتغيّر بعد الحفظ باسم');
chk(copyBack && copyBack.components.length === 2, 'النسخة تحتفظ بمكوناتها الخاصة');
chk(copyBack.name === 'تقرير المبيعات - نسخة', 'النسخة باسم مستقل');
const list = RS.listReports(tmp);
chk(list.length === 2, 'القائمة تعرض التقريرين');
chk(list.some(x => x.id === r1.id) && list.some(x => x.id === copy.id), 'كلا المعرّفين في القائمة');
chk(list.every(x => typeof x.id === 'string' && typeof x.name === 'string'), 'عناصر القائمة كاملة');

/* ---------- 3) حالات غير صالحة ---------- */
chk(RS.saveReport({ components: [] }, tmp).error === 'report requires name', 'حفظ بلا اسم مرفوض');
chk(RS.saveReport({ name: 'x' }, tmp).error === 'components must be array', 'حفظ بمكونات غير مصفوفة مرفوض');
chk(RS.saveReport(null, tmp).error === 'report required', 'حفظ بلا تعريف مرفوض');
chk(RS.loadReport('no-such', tmp) === null, 'فتح تقرير غير موجود → null');
chk(RS.loadReport('../../etc/passwd', tmp) === null, 'معرّف غير آمن → null (لا خروج عن المجلد)');
const unsafe = RS.saveReport({ name: 'x', id: '../../evil', components: [] }, tmp);
chk(unsafe.id && unsafe.id.indexOf('/') < 0 && unsafe.id.indexOf('\\') < 0, 'معرّف محرَّم (لا path traversal)');
chk(fs.existsSync(path.join(tmp, unsafe.id + '.json')), 'الملف المحفوظ داخل المجلد فقط');

/* ---------- 4) إعدادات العرض تُطبَّق فعلاً في المخرجات (محرك Python) ---------- */
const rows = [
  { item: 'A', day: '2026-01-01', amount: 10.5 },
  { item: 'A', day: '2026-01-02', amount: 3.25 },
  { item: 'B', day: '2026-01-01', amount: 7 },
];
const cols = ['item', 'day', 'amount'];

(async () => {
  /* KPI decimals */
  const kpi = await RB.renderReport({ name: 'k', components: [{ type: 'kpi', label: 'sum', column: 'amount', agg: 'sum', decimals: 2 }] }, { columns: cols, rows });
  chk(kpi.ok === true, 'render KPI ok');
  chk(kpi.html.includes('20.75'), 'decimals=2 يعرض منزلتين عشريتين (20.75)');

  /* KPI بدون decimals = تلقائي */
  const kpiAuto = await RB.renderReport({ name: 'k', components: [{ type: 'kpi', label: 'sum', column: 'amount', agg: 'sum' }] }, { columns: cols, rows });
  chk(kpiAuto.html.includes('20.75'), 'بدون decimals:Formatter التلقائي');

  /* KPI decimals=0 */
  const kpi0 = await RB.renderReport({ name: 'k', components: [{ type: 'kpi', label: 'sum', column: 'amount', agg: 'sum', decimals: 0 }] }, { columns: cols, rows });
  chk(kpi0.html.includes('>21<'), 'decimals=0 يعرض عددًا صحيحًا (21)');

  /* جدول: حد الصفوف 1..500 */
  const many = Array.from({ length: 600 }, (_, i) => ({ item: 'I' + i, day: '2026-01-01', amount: i }));
  const lim1 = await RB.renderReport({ name: 't', components: [{ type: 'table', columns: ['item'], limit: 1 }] }, { columns: cols, rows: many });
  const rowsShown = (lim1.html.match(/<tr>/g) || []).length - 1; // ناقص صف رأس الجدول
  chk(rowsShown === 1, 'limit=1 يعرض صفًا واحدًا (' + rowsShown + ')');
  const lim0 = await RB.renderReport({ name: 't', components: [{ type: 'table', columns: ['item'], limit: 0 }] }, { columns: cols, rows: many });
  chk((lim0.html.match(/<tr>/g) || []).length - 1 === 1, 'limit=0 يُقيَّد إلى صف واحد (لا صفوف)');
  const limBig = await RB.renderReport({ name: 't', components: [{ type: 'table', columns: ['item'], limit: 999 }] }, { columns: cols, rows: many });
  chk((limBig.html.match(/<tr>/g) || []).length - 1 === 500, 'limit=999 يُقيَّد إلى 500 صف');

  /* جدول: ترتيب تنازلي */
  const sorted = await RB.renderReport({ name: 't', components: [{ type: 'table', columns: ['item', 'amount'], sort: 'amount', desc: true }] }, { columns: cols, rows });
  chk(sorted.html.indexOf('10.5') < sorted.html.indexOf('7'), 'الترتيب التنازلي مُطبَّق');

  /* مخطط: إخفاء العنوان + تسميات المحاور */
  const chart = await RB.renderReport({ name: 'c', components: [{ type: 'bar', title: 'SECRET_TITLE', category: 'item', value: 'amount', agg: 'sum', showTitle: false, xLabel: 'XLABEL', yLabel: 'YLABEL' }] }, { columns: cols, rows });
  chk(chart.ok === true && chart.html.indexOf('SECRET_TITLE') < 0, 'showTitle=false يُخفي عنوان المخطط');
  chk(chart.html.includes('XLABEL') && chart.html.includes('YLABEL'), 'تسميات المحاور تظهر في المخطط');

  const chartOn = await RB.renderReport({ name: 'c', components: [{ type: 'bar', title: 'VISIBLE_TITLE', category: 'item', value: 'amount', agg: 'sum' }] }, { columns: cols, rows });
  chk(chartOn.html.includes('VISIBLE_TITLE'), 'العنوان يظهر افتراضيًا');

  /* مكونات متعددة معًا في معاينة واحدة */
  const multi = await RB.renderReport({ name: 'm', components: comps }, { columns: cols, rows });
  chk(multi.ok === true, 'معاينة كل المكونات معًا ok');
  chk(multi.html.includes('kpi-value') && multi.html.includes('<table') && multi.html.includes('<svg'), 'المؤشر + الجدول + المخطط معًا في نفس المعاينة');
  chk(multi.html.includes('تقرير المبيعات'), 'العنوان النصي في المعاينة');
  chk(multi.count === 7, 'عدد المكونات في المعاينة = 7');

  /* مصدر غير موجود → لا انهيار */
  const noData = await RB.renderReport({ name: 'm', components: comps }, { columns: [], rows: [] });
  chk(noData.ok === true, 'معاينة بلا بيانات لا تفشل');

  chk(guard.count() === 0, 'صفر اتصال');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nreport_designer.test.js — pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
