'use strict';
/**
 * نموذج الشاشات المخصّصة (src/app-screen.js) — اختبارات وحدة نقية
 * ============================================================
 * يفحص: التطبيع · التحقق من الروابط · تركيب حزمة التصيير
 * بلا I/O وبلا شبكة (حارس الاتصال مثبَّت).
 */
const guard = require('./_guard');
guard.install();
const AppScreen = require('../../src/app-screen');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);
const eq = (a, b, m) => chk(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('== نموذج الشاشات المخصّصة ==');

/* ---------- 1) المعرّفات ---------- */
chk(AppScreen.isScreenId('cs_dash1'), 'معرّف صالح: cs_dash1');
chk(!AppScreen.isScreenId('dashboard'), 'معرّف شاشة قائمة مرفوض');
chk(!AppScreen.isScreenId('cs_'), 'معرّف ناقص مرفوض');
chk(!AppScreen.isScreenId('cs_a'), 'معرّف قصير مرفوض');
chk(!AppScreen.isScreenId(''), 'معرّف فارغ مرفوض');
chk(!AppScreen.isScreenId('cs_bad id!'), 'معرّف بمحارف غير مسموحة مرفوض');

/* ---------- 2) التطبيع ---------- */
{
  const def = {
    id: 'cs_test1',
    name: 'شاشة المخزون',
    desc: 'وصف',
    source: { runId: 'run_abc' },
    components: [
      { id: 'c1', type: 'kpi', label: 'إجمالي', column: 'qty', agg: 'sum' },
      { id: 'c2', type: 'table', columns: ['item', 'qty'] },
      { id: 'c3', type: 'heading', text: 'ملخص' },
      { id: 'cX', type: 'unknown-type' },          /* يُسقط */
    ],
    inputs: [{ id: 'i1', type: 'select', column: 'item', op: '==' }],
    buttons: [{ id: 'b1', label: 'تحديث', action: { kind: 'refresh', id: 'refresh' } }],
  };
  const n = AppScreen.normalizeScreen(def);
  eq(n.id, 'cs_test1', 'المعرّف محفوظ');
  eq(n.name, 'شاشة المخزون', 'الاسم محفوظ');
  eq(n.source, { kind: 'run', runId: 'run_abc' }, 'المصدر محفوظ');
  eq(n.components.length, 3, 'المكوّنات غير المعروفة تُسقط (3 من 4)');
  eq(n.inputs.length, 1, 'المدخل محفوظ');
  eq(n.buttons.length, 1, 'الزر محفوظ');
  eq(n.buttonsPosition, 'top', 'موضع الأزرار الافتراضي أعلى');
  /* نص طويل يقتطع */
  const long = AppScreen.normalizeScreen({ id: 'cs_x1', name: 'ا'.repeat(200) });
  eq(long.name.length, 80, 'الاسم يقتطع إلى 80');
  /* نوع غير معروف في الزر ⇒ يُسقط */
  const badBtn = AppScreen.normalizeScreen({ id: 'cs_x2', name: 'x', buttons: [{ id: 'b', action: { kind: 'evil', id: 'x' } }] });
  eq(badBtn.buttons.length, 0, 'زر بإجراء غير معروف يُسقط');
  /* معرّف زر مُسقط بلا إجراء */
  const noAction = AppScreen.normalizeScreen({ id: 'cs_x3', name: 'x', buttons: [{ id: 'b' }] });
  eq(noAction.buttons.length, 0, 'زر بلا إجراء يُسقط');
}

/* ---------- 3) التحقق من الروابط ---------- */
const RUNS = [{ runId: 'run_abc', columns: ['item', 'qty', 'value'] }];
{
  const base = { id: 'cs_v1', name: 'شاشة', source: { runId: 'run_abc' }, components: [{ id: 'c1', type: 'kpi', label: 'x', column: 'qty', agg: 'sum' }] };
  const v = AppScreen.validateScreen(base, { runs: RUNS });
  chk(v.ok, 'تعريف صحيح يمرّ: ' + v.errors.join(' | '));

  const noRun = AppScreen.validateScreen(Object.assign({}, base, { source: undefined }), { runs: RUNS });
  chk(!noRun.ok, 'مكوّن بيانات بلا مصدر ⇒ خطأ');
  chk(noRun.errors.some(e => /مصدر/.test(e)), 'رسالة الخطأ تذكر المصدر');

  const badRun = AppScreen.validateScreen(Object.assign({}, base, { source: { runId: 'run_nope' } }), { runs: RUNS });
  chk(!badRun.ok, 'تشغيل غير موجود ⇒ خطأ');
  chk(badRun.errors.some(e => /غير موجود/.test(e)), 'رسالة الخطأ تذكر التشغيل غير الموجود');

  const badCol = AppScreen.validateScreen(Object.assign({}, base, { components: [{ id: 'c1', type: 'kpi', label: 'x', column: 'nope', agg: 'sum' }] }), { runs: RUNS });
  chk(!badCol.ok, 'عمود غير موجود في نتيجة التشغيل ⇒ خطأ');

  const noName = AppScreen.validateScreen({ id: 'cs_v2', components: [{ id: 'c1', type: 'heading', text: 'x' }] }, { runs: RUNS });
  chk(!noName.ok, 'بلا اسم ⇒ خطأ');

  const empty = AppScreen.validateScreen({ id: 'cs_v3', name: 'فارغة' }, { runs: RUNS });
  chk(!empty.ok, 'شاشة بلا مكوّنات ولا أزرار ⇒ خطأ');

  const badId = AppScreen.validateScreen({ id: 'dashboard', name: 'x', components: [{ id: 'c1', type: 'heading', text: 'y' }] }, { runs: RUNS });
  chk(!badId.ok, 'معرّف محجوز ⇒ خطأ');
}

/* ---------- 4) الأزرار: إجراءات مسجَّلة فقط ---------- */
{
  const def = {
    id: 'cs_b1', name: 'أزرار',
    buttons: [{ id: 'b1', label: 'تحديث', action: { kind: 'registered', id: 'refresh' } }],
  };
  const okv = AppScreen.validateScreen(def, { actions: ['refresh', 'saveReport'] });
  chk(okv.ok, 'زر بإجراء مسجَّل يمرّ');
  const bad = AppScreen.validateScreen(def, { actions: ['saveReport'] });
  chk(!bad.ok, 'زر بإجراء غير مسجَّل ⇒ خطأ');
  const gotoBad = AppScreen.validateScreen({
    id: 'cs_b2', name: 'انتقال',
    buttons: [{ id: 'b1', label: 'انتقال', action: { kind: 'goto', id: 'cs_missing' } }],
  }, { screens: ['cs_other'] });
  chk(!gotoBad.ok, 'زر انتقال إلى شاشة غير معروفة ⇒ خطأ');
  const repBad = AppScreen.validateScreen({
    id: 'cs_b3', name: 'تقرير',
    buttons: [{ id: 'b1', label: 'تقرير', action: { kind: 'openReport', id: 'rep_missing' } }],
  }, { reports: ['rep_1'] });
  chk(!repBad.ok, 'زر فتح تقرير غير محفوظ ⇒ خطأ');
}

/* ---------- 5) تركيب حزمة التصيير (نفس محرّك التقارير) ---------- */
{
  const def = {
    id: 'cs_r1', name: 'تصيير',
    source: { runId: 'run_abc' },
    components: [{ id: 'c1', type: 'kpi', label: 'إجمالي', column: 'qty', agg: 'sum' }],
    inputs: [
      { id: 'i1', type: 'select', column: 'item', op: '==' },
      { id: 'i2', type: 'text', column: 'note', op: 'contains' },
    ],
  };
  const p = AppScreen.composeRenderPayload(def, { i1: 'A' });
  eq(p.report.runId, 'run_abc', 'حزمة التصيير تحمل معرّف التشغيل');
  eq(p.report.filters.length, 1, 'فلتر واحد فقط (المدخل الفارغ يُسقط)');
  eq(p.report.filters[0], { column: 'item', op: '==', value: 'A' }, 'الفلتر الصحيح');
  eq(p.report.components.length, 1, 'المكوّنات منقولة');
  const p2 = AppScreen.composeRenderPayload(def, { i1: 'A', i2: 'x' });
  eq(p2.report.filters.length, 2, 'فلتران عند تعبئة المدخلين');
  const p3 = AppScreen.composeRenderPayload(def, {});
  eq(p3.report.filters.length, 0, 'بلا فلاتر عند غياب القيم');
  /* القيمة الافتراضية في التعريف تُستخدم */
  const def2 = Object.assign({}, def, { inputs: [{ id: 'i1', type: 'text', column: 'item', op: '==', value: 'B' }] });
  const p4 = AppScreen.composeRenderPayload(def2, {});
  eq(p4.report.filters[0].value, 'B', 'القيمة الافتراضية تُستخدم');
  /* عملية «فارغ» بلا قيمة */
  const def3 = Object.assign({}, def, { inputs: [{ id: 'i1', type: 'text', column: 'item', op: 'empty' }] });
  const p5 = AppScreen.composeRenderPayload(def3, { i1: 'x' });
  eq(p5.report.filters[0].value, undefined, 'عملية «فارغ» بلا قيمة');
}

/* ---------- 6) مخطط الأعمدة الناقصة (نفس قاعدة المحرّك) ---------- */
{
  const cols = new Set(['item', 'qty']);
  eq(AppScreen.componentMissingColumns({ type: 'kpi', column: 'qty' }, cols), [], 'عمود موجود ⇒ لا نواقص');
  eq(AppScreen.componentMissingColumns({ type: 'kpi', column: 'zzz' }, cols), ['zzz'], 'عمود ناقص يُكتشف');
  eq(AppScreen.componentMissingColumns({ type: 'table', columns: ['item', 'zzz'] }, cols), ['zzz'], 'جدول: عمود ناقص');
  eq(AppScreen.componentMissingColumns({ type: 'bar', category: 'item', value: 'qty' }, cols), [], 'مخطط: عمودان موجودان');
}

chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');
console.log('\nscreen_model.test.js — pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
