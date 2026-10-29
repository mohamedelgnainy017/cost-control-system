'use strict';
/**
 * تكامل الشاشات المخصّصة — دورة كاملة ببيانات اصطناعية
 * ============================================================
 * تحليل اصطناعي ⇒ تشغيل محفوظ ⇒ تعريف شاشة ⇒ تحقق ⇒ تصيير حقيقي
 * عبر محرّك التقارير (python) ⇒ إعادة فتح ⇒ إعادة تشغيل.
 *
 * كل الملفات في مجلد مؤقت خارج المستودع ⇒ لا مساس ب data/ ولا بقاعدة البيانات.
 */
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('../../src/workflow');
const AppScreen = require('../../src/app-screen');
const Store = require('../../src/screen-store');
const R = require('../../src/report-bridge');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);
const eq = (a, b, m) => chk(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('== تكامل الشاشات المخصّصة (اصطناعي) ==');

const TMP = path.join(os.tmpdir(), 'ccs_screen_it_' + Date.now().toString(36));
const WF_ROOT = path.join(TMP, 'workflows');
const SCREENS_ROOT = path.join(TMP, 'screens');
fs.mkdirSync(SCREENS_ROOT, { recursive: true });

/* ---------- 1) تحليل اصطناعي وتشغيله ---------- */
const rows = [
  { item: 'A', qty: 10, price: 5 },
  { item: 'A', qty: 3, price: 5 },
  { item: 'B', qty: 7, price: 2 },
  { item: 'C', qty: 4, price: 1 },
];
const wf = {
  name: 'شاشة-اصطناعية',
  source: { type: 'memory', name: 'orders' },
  steps: [
    { id: 's1', type: 'select', columns: ['item', 'qty', 'price'] },
    { id: 's2', type: 'compute', newColumn: 'total', formula: 'qty * price' },
  ],
};
const data = { rows: rows.map(r => Object.assign({}, r)), columns: ['item', 'qty', 'price'] };
const res = W.executeWorkflow(wf, data);
chk(res.ok, 'التشغيل الاصطناعي نجح');
eq(res.columns, ['item', 'qty', 'price', 'total'], 'الأعمدة بعد الحساب');
const runId = 'run_screen_it';
W.saveOutput(runId, res, WF_ROOT);
const saved = W.loadOutput(runId, WF_ROOT);
chk(!!saved, 'نتيجة التشغيل محفوظة');
eq(saved.columns, ['item', 'qty', 'price', 'total'], 'أعمدة النتيجة المحفوظة');

/* ---------- 2) تعريف شاشة ---------- */
const screen = {
  id: 'cs_it1',
  name: 'شاشة المبيعات',
  desc: 'تحليل اصطناعي',
  source: { kind: 'run', runId },
  components: [
    { id: 'c1', type: 'heading', text: 'ملخص' },
    { id: 'c2', type: 'kpi', label: 'إجمالي المبيعات', column: 'total', agg: 'sum' },
    { id: 'c3', type: 'table', columns: ['item', 'qty', 'total'], limit: 10 },
    { id: 'c4', type: 'bar', title: 'حسب الصنف', category: 'item', value: 'total', agg: 'sum' },
  ],
  inputs: [{ id: 'i1', type: 'select', column: 'item', op: '==' }],
  buttons: [{ id: 'b1', label: 'تحديث', action: { kind: 'refresh', id: 'refresh' } }],
};
const norm = AppScreen.normalizeScreen(screen);
const v = AppScreen.validateScreen(norm, { runs: [{ runId, columns: saved.columns }] });
chk(v.ok, 'تعريف الشاشة صالح: ' + v.errors.join(' | '));

/* ---------- 3) التحقق من رفض الروابط الخاطئة ---------- */
{
  const bad = AppScreen.validateScreen(
    AppScreen.normalizeScreen(Object.assign({}, screen, { source: { runId: 'run_missing' } })),
    { runs: [{ runId, columns: saved.columns }] }
  );
  chk(!bad.ok, 'مصدر غير موجود ⇒ يُرفض قبل الحفظ');
  const badCol = AppScreen.validateScreen(
    AppScreen.normalizeScreen(Object.assign({}, screen, {
      components: [{ id: 'c1', type: 'kpi', label: 'x', column: 'nope', agg: 'sum' }],
    })),
    { runs: [{ runId, columns: saved.columns }] }
  );
  chk(!badCol.ok, 'عمود غير موجود ⇒ يُرفض قبل الحفظ');
}

/* ---------- 4) الحفظ وإعادة الفتح ---------- */
{
  const r = Store.saveScreen(norm, SCREENS_ROOT);
  chk(!r.error, 'حفظ الشاشة نجح: ' + (r.error || ''));
  const again = Store.loadScreen('cs_it1', SCREENS_ROOT);
  chk(!!again, 'إعادة الفتح نجحت');
  eq(again.name, 'شاشة المبيعات', 'الاسم محفوظ');
  eq(again.components.length, 4, 'المكوّنات محفوظة (4)');
  eq(again.components[1].column, 'total', 'عمود المؤشر محفوظ');
  eq(again.components[2].columns, ['item', 'qty', 'total'], 'أعمدة الجدول محفوظة');
  eq(again.inputs.length, 1, 'المدخل محفوظ');
  eq(again.buttons[0].action.kind, 'refresh', 'إجراء الزر محفوظ');
  eq(again.source.runId, runId, 'مصدر التشغيل محفوظ');
}

/* ---------- 5) التصيير الحقيقي عبر محرّك التقارير ---------- */
(async () => {
  try {
    const def = Store.loadScreen('cs_it1', SCREENS_ROOT);
    const payload = AppScreen.composeRenderPayload(def, {});
    eq(payload.report.runId, runId, 'حزمة التصيير مرتبطة بالتشغيل');
    const out = await R.renderReport(payload.report, { columns: saved.columns, rows: saved.rows });
    chk(out.ok, 'التصيير نجح: ' + (out.error || ''));
    const html = String(out.html || '');
    chk(html.indexOf('إجمالي المبيعات') >= 0, 'عنوان المؤشر ظاهر');
    /* المجموع الكلي = 10*5 + 3*5 + 7*2 + 4*1 = 83 */
    chk(/83/.test(html), 'قيمة المؤشر صحيحة (83)');
    chk(html.indexOf('<table') >= 0, 'الجدول مرسوم');
    chk(html.indexOf('<svg') >= 0, 'المخطط مرسوم');
    chk(html.indexOf('ملخص') >= 0, 'العنوان مرسوم');

    /* ---------- 6) الفلتر يقلّل الصفوف (نفس محرّك التقارير) ---------- */
    const filtered = AppScreen.composeRenderPayload(def, { i1: 'A' });
    const out2 = await R.renderReport(filtered.report, { columns: saved.columns, rows: saved.rows });
    chk(out2.ok, 'التصيير مع الفلتر نجح');
    const html2 = String(out2.html || '');
    /* الصفوف A فقط: 10*5 + 3*5 = 65 */
    chk(/65/.test(html2), 'قيمة المؤشر بعد الفلتر صحيحة (65)');
    chk(!/83/.test(html2), 'المجموع قبل الفلتر لا يظهر بعد الفلتر');

    /* ---------- 7) إعادة التشغيل بعد إعادة الفتح ---------- */
    const reopened = Store.loadScreen('cs_it1', SCREENS_ROOT);
    const out3 = await R.renderReport(AppScreen.composeRenderPayload(reopened, {}).report,
      { columns: saved.columns, rows: saved.rows });
    chk(out3.ok, 'إعادة التشغيل بعد إعادة الفتح نجحت');
    chk(/83/.test(String(out3.html || '')), 'النتيجة متطابقة بعد إعادة الفتح (83)');
  } catch (e) {
    badTag('استثناء غير متوقع: ' + e.message);
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');
  console.log('\nscreen_integration.test.js — pass=' + pass + ' fail=' + fail);
  if (fail > 0) process.exit(1);
})();
