'use strict';
/**
 * فهرس علاقات مساحة العمل (src/workspace-links.js) — اختبارات وحدة
 * ============================================================
 * بيانات اصطناعية فقط: تتحقق من أن الروابط تُبنى من أدلة فعلية
 * (formulaColumns · runId · workflowId · أزرار الشاشات) ولا تُخترع.
 */
const guard = require('./_guard');
guard.install();
const WL = require('../../public/workspace-links.js');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);
const eq = (a, b, m) => chk(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('== فهرس علاقات مساحة العمل ==');

const SOURCES = [
  { id: 'daily_balances', label: 'الأرصدة اليومية', domain: 'inventory' },
  { id: 'borse', label: 'البورصة', domain: 'prices' },
];
const FORMULAS = [
  { id: 'fml.cost', name: 'تكلفة الوحدة', status: 'مطابق منطقيًا' },
  { id: 'fml.dax.only', name: 'مقياس DAX غير منفَّذ', status: 'غير منفَّذ' },
];
const RUNS = [
  {
    runId: 'run_1', workflowId: 'wf_1', workflowName: 'تحليل المخزون', savedAt: '2026-10-20T10:00:00Z',
    rowCount: 12, columns: ['item', 'qty', 'cost_unit'], formulaColumns: { 'fml.cost': 'cost_unit' },
    source: { name: 'daily_balances', label: 'الأرصدة اليومية' },
  },
  {
    runId: 'run_2', workflowId: 'wf_2', workflowName: 'تحليل البورصة', savedAt: '2026-10-21T10:00:00Z',
    rowCount: 4, columns: ['item', 'close'], formulaColumns: {}, source: { name: 'borse', label: 'البورصة' },
  },
];
const REPORTS = [
  { id: 'rep_1', name: 'تقرير المخزون', runId: 'run_1', savedAt: '2026-10-21T12:00:00Z', components: 3 },
  { id: 'rep_2', name: 'تقرير البورصة', runId: 'run_2', savedAt: '2026-10-21T13:00:00Z', components: 2 },
];
const WORKFLOWS = [
  { id: 'wf_1', name: 'تحليل المخزون', savedAt: '2026-10-19' },
  { id: 'wf_2', name: 'تحليل البورصة', savedAt: '2026-10-20' },
];
const SCREENS = [
  { id: 'cs_stock', name: 'شاشة المخزون', runId: 'run_1', components: 3, buttons: [] },
  { id: 'cs_bourse', name: 'شاشة البورصة', runId: 'run_2', components: 1, buttons: [{ id: 'b1', action: { kind: 'openReport', id: 'rep_1' } }] },
];

const idx = WL.buildIndex({ sources: SOURCES, formulas: FORMULAS, runs: RUNS, reports: REPORTS, workflows: WORKFLOWS, screens: SCREENS });

/* ---------- 1) معادلة ← تشغيلات (دليل formulaColumns) ---------- */
{
  const u = WL.formulaUsage(idx, 'fml.cost');
  eq(u.runs.length, 1, 'المعادلة استُخدمت في تشغيل واحد');
  eq(u.runs[0].runId, 'run_1', 'التشغيل الصحيح');
  eq(u.runs[0].column, 'cost_unit', 'العمود المحسوب');
  eq(u.runs[0].workflowName, 'تحليل المخزون', 'اسم التحليل ظاهر');
  eq(u.reports.map(r => r.id), ['rep_1'], 'التقرير المعتمد عليها');
  eq(u.analyses.map(a => a.id), ['wf_1'], 'التحليل الذي أنتج التشغيل');
  const none = WL.formulaUsage(idx, 'fml.dax.only');
  eq(none.runs.length, 0, 'معادلة غير منفَّذة: لا تشغيلات (لا ادّعاء)');
  eq(none.reports.length, 0, 'معادلة غير منفَّذة: لا تقارير');
}

/* ---------- 2) عمود ← تشغيلات وتقارير ---------- */
{
  const u = WL.columnUsage(idx, 'cost_unit');
  eq(u.runs.length, 1, 'العمود المحسوب في تشغيل واحد');
  eq(u.runs[0].formulaId, 'fml.cost', 'العمود مرتبط بالمعادلة');
  eq(u.runs[0].computed, true, 'العمود مُعلَّم كمحسوب');
  eq(u.reports.map(r => r.id), ['rep_1'], 'التقرير الذي يعرض العمود');
  const plain = WL.columnUsage(idx, 'close');
  eq(plain.runs.length, 1, 'عمود أصلي في تشغيل واحد');
  eq(plain.runs[0].computed, false, 'العمود الأصلي غير محسوب');
  eq(plain.runs[0].formulaId, null, 'لا معادلة مرتبطة');
}

/* ---------- 3) تشغيل ← تقرير/تحليل/شاشات ---------- */
{
  const u = WL.runUsage(idx, 'run_1');
  eq(u.reports.map(r => r.id), ['rep_1'], 'تقرير واحد يعتمد على التشغيل');
  eq(u.analysis.id, 'wf_1', 'التحليل المرتبط');
  /* الشاشات: مباشرةً (مصدر الشاشة = التشغيل) أو عبر تقرير يعتمد عليه */
  eq(u.screens.map(s => s.id).sort(), ['cs_bourse', 'cs_stock'], 'الشاشات التي تعرض بيانات التشغيل (مباشرة أو عبر تقرير)');
  const u2 = WL.runUsage(idx, 'run_2');
  eq(u2.screens.map(s => s.id), ['cs_bourse'], 'الشاشة الثانية');
}

/* ---------- 4) تقرير ← شاشات (زر openReport) ---------- */
{
  const u = WL.reportUsage(idx, 'rep_1');
  const ids = u.screens.map(s => s.id).sort();
  eq(ids, ['cs_bourse', 'cs_stock'], 'التقرير يظهر في شاشتين (مصدر + زر)');
  const via = u.screens.map(s => s.via);
  chk(via.indexOf('زر «فتح التقرير»') >= 0, 'رابط الزر موثّق');
}

/* ---------- 5) مصدر ← تشغيلات ---------- */
{
  const u = WL.sourceUsage(idx, 'daily_balances');
  eq(u.runs.map(r => r.runId), ['run_1'], 'التشغيل مرتبط بالمصدر');
  eq(u.reports.map(r => r.id), ['rep_1'], 'التقرير عبر التشغيل');
  const empty = WL.sourceUsage(idx, 'contract_balances');
  eq(empty.runs.length, 0, 'مصدر بلا تشغيلات ⇒ لا رابط');
}

/* ---------- 6) سلسلة السياق ---------- */
{
  const chain = WL.chain(idx, { sourceId: 'daily_balances', runId: 'run_1', reportId: 'rep_1', screenId: 'cs_stock' });
  eq(chain.map(c => c.kind), ['مصدر', 'تشغيل', 'تقرير', 'شاشة'], 'ترتيب السلسلة صحيح');
  eq(chain[1].label, 'تحليل المخزون', 'اسم التشغيل من اسم التحليل');
  const empty = WL.chain(idx, {});
  eq(empty.length, 0, 'سلسلة فارغة بلا سياق');
}

/* ---------- 7) لا روابط بلا دليل ---------- */
{
  const idx2 = WL.buildIndex({
    sources: [{ id: 'x', label: 'س' }], formulas: [], runs: [], reports: [], workflows: [], screens: [],
  });
  eq(WL.formulaUsage(idx2, 'any').runs.length, 0, 'فهرس فارغ ⇒ لا علاقات');
  eq(WL.runUsage(idx2, 'run_x').reports.length, 0, 'تشغيل غير موجود ⇒ لا علاقات');
  eq(WL.reportUsage(idx2, 'rep_x').screens.length, 0, 'تقرير غير موجود ⇒ لا شاشات');
}

/* ---------- 8) قيم formulaColumns بصيغتين ---------- */
{
  eq(WL.formulaColumnName('col_a'), 'col_a', 'قيمة نصية');
  eq(WL.formulaColumnName({ column: 'col_b' }), 'col_b', 'كائن بعمود');
  eq(WL.formulaColumnName({ name: 'col_c' }), 'col_c', 'كائن باسم');
  eq(WL.formulaColumnName(null), '', 'قيمة فارغة');
  const idx3 = WL.buildIndex({ runs: [{ runId: 'r', columns: ['z'], formulaColumns: { f: { column: 'z', formulaName: 'F', version: 2 } } }] });
  const u = WL.formulaUsage(idx3, 'f');
  eq(u.runs[0].column, 'z', 'العمود من كائن formulaColumns');
}

chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');
console.log('\nworkspace_links.test.js — pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
