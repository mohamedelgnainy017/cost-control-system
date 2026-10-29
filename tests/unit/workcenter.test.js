'use strict';
/**
 * اختبارات مركز العمل — تجميع حالة المنصة (بيانات اصطناعية، بلا DB)
 * =========================================================================
 * القاعدة: لا بيانات مفترضة — أي قائمة فارغة تُعلَن `empty` صراحةً،
 * والتنبيهات تُشتق من بيانات حقيقية فقط (تحذيرات/نتائج بلا تتبّع/مصادر موثّقة فقط).
 */
const guard = require('./_guard');
guard.install();

const WC = require('../../src/workcenter');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

console.log('== مركز العمل (تجميع الحالة) ==');

/* ---------- 1) الحالة الفارغة (لا بيانات ⇒ لا اختلاق) ---------- */
{
  const d = WC.buildWorkCenter({});
  chk(d.runs.length === 0 && d.reports.length === 0 && d.formulas.length === 0, 'لا عناصر مفترضة عند غياب البيانات');
  chk(d.empty.runs === true && d.empty.reports === true && d.empty.formulas === true, 'الحالات الفارغة معلنة صراحةً');
  chk(d.alerts.length === 0, 'لا تنبيهات بلا بيانات');
  chk(d.actions.length === 4, 'الإجراءات السريعة ثابتة (روابط داخلية)');
  chk(d.actions.every(a => !a.path && !a.url), 'الإجراءات لا تحمل مسارات خارجية');
}

/* ---------- 2) التشغيلات: حالة التتبّع والتحذيرات ---------- */
{
  const runs = [
    { runId: 'run_1', source: { name: 'daily_balances', label: 'الأرصدة اليومية' }, rowCount: 120, columns: ['a', 'b'],
      savedAt: '2026-10-20T10:00:00Z', traced: true, definitionChanged: false, engineState: 'same', warnings: [] },
    { runId: 'run_2', source: { name: 'movements', label: 'الحركات' }, rowCount: 5000, columns: ['a'],
      savedAt: '2026-10-21T10:00:00Z', traced: false, definitionChanged: null, engineState: 'unknown', warnings: ['اقتُطع الطرف الأيمن'] },
    { runId: 'run_3', source: { name: 'sales', label: 'المبيعات' }, rowCount: 7, columns: ['a'],
      savedAt: '2026-10-19T10:00:00Z', traced: true, definitionChanged: true, engineState: 'changed', warnings: [] },
  ];
  const d = WC.buildWorkCenter({ runs });
  chk(d.runs.length === 3, 'التشغيلات مدرجة');
  chk(d.runs[0].traced === true && d.runs[0].rows === 120 && d.runs[0].columns === 2, 'تفاصيل التشغيل مستخرجة بدقة');
  chk(d.runs[1].traced === false && d.runs[1].warnings === 1, 'النتيجة بلا تتبّع + عدد التحذيرات');
  chk(d.runs[2].definitionChanged === true, 'تغيّر التعريف مُعلَّم');
  const kinds = d.alerts.map(a => a.kind + ':' + a.title);
  chk(d.alerts.some(a => a.kind === 'warn' && /انتباه/.test(a.title)), 'تنبيه للنتائج ذات التحذيرات');
  chk(d.alerts.some(a => a.kind === 'info' && /تتبّع/.test(a.title)), 'تنبيه للنتائج القديمة بلا تتبّع');
  chk(d.alerts.some(a => a.kind === 'warn' && /محرّك معادلات أقدم/.test(a.title)),
    'تنبيه للنتائج المحسوبة بمحرّك معادلات أقدم');
  chk(d.runs[2].engineState === 'changed', 'حالة المحرّك مُنقولة كما هي');
}

/* ---------- 3) التقارير والمعادلات ---------- */
{
  const d = WC.buildWorkCenter({
    reports: [{ id: 'rep_1', name: 'تقرير مبيعات', runId: 'run_1', savedAt: '2026-10-20T10:00:00Z', source: { label: 'المبيعات', traced: true } }],
    formulas: [{ id: 'fml_1', name: 'صافي', version: 2, origin: 'visual', updatedAt: '2026-10-21T10:00:00Z' }],
  });
  chk(d.reports[0].name === 'تقرير مبيعات' && d.reports[0].traced === true, 'التقرير مع مصدره وحالة تتبّعه');
  chk(d.formulas[0].version === 2 && d.formulas[0].origin === 'بصري', 'المعادلة مع نسختها ونشئها');
  chk(d.empty.reports === false && d.empty.formulas === false, 'الحالة الفارغة لا تُعلن مع وجود عناصر');
}

/* ---------- 4) صحة المنصة ---------- */
{
  const d = WC.buildWorkCenter({
    catalog: { total: 21, canonicalBalance: 'daily_balances', byStatus: { 'منفّذ': 20, 'موثق فقط': 1 } },
    model: { formulas: { total: 81, byStatus: { 'مطابق منطقيًا': 31, 'جزئي': 10, 'مختلف': 2, 'غير منفَّذ': 6 } }, numericVerified: 0 },
    screens: { screens: 18, reports: 31, visibleReports: 17 },
  });
  const h = d.health;
  chk(h.sources.total === 21 && h.sources.implemented === 20 && h.sources.documented === 1, 'عدّ المصادر بحالاتها');
  chk(h.sources.canonical === 'daily_balances', 'المرجع المعتمد ظاهر في صحة المنصة');
  chk(h.formulas.total === 81 && h.formulas.numericVerified === 0, 'عدد المعادلات + عدد المتحقَّق رقميًا');
  chk(h.screens.total === 18 && h.screens.reports === 31 && h.screens.visibleReports === 17, 'عدّ الشاشات والتقارير');
  chk(d.alerts.some(a => /معادلات مسجّلة/.test(a.title)), 'تنبيه المعادلات غير المنفَّذة');
  chk(d.alerts.some(a => /مصادر موثّقة/.test(a.title)), 'تنبيه المصادر الموثّقة فقط');
}

/* ---------- 5) صفر اتصال ---------- */
chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');

console.log('\nworkcenter.test.js — pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
