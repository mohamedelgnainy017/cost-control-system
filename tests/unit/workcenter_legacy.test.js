'use strict';
/**
 * وضع التوافق لمركز العمل — يعمل على خادم أقدم لا يملك /api/workcenter
 * =========================================================================
 * البيانات كلها اصطناعية · بلا شبكة · بلا DB.
 * الهدف: المركز يعمل ببيانات حقيقية من المسارات القائمة، بلا اختلاق،
 *        والبطاقات التي لا مصدر لها تبقى فارغة صراحةً مع تنبيه.
 */
const path = require('path');
const guard = require('./_guard');
guard.install();

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

/* بيئة متصفّح مصغّرة (الملف يغلّف نفسه في IIFE ويقرأ document عند التهيئة) */
global.window = global.window || {};
global.document = global.document || { addEventListener() { } };
const WC = require(path.join(__dirname, '..', '..', 'public', 'workcenter.js'));

const fs = require('fs');
const IDX = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'styles.css'), 'utf8');
const WCJS = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'workcenter.js'), 'utf8');

console.log('== وضع توافق مركز العمل ==');

/* ---------- 1) الدوال معروضة ---------- */
chk(typeof window.buildWorkCenterLegacy === 'function', 'buildWorkCenterLegacy معروضة');
chk(typeof window.isMissingRoute === 'function', 'isMissingRoute معروضة');

/* ---------- 2) التعرّف على غياب المسار ---------- */
chk(window.isMissingRoute({ status: 404 }) === true, '404 ⇒ مسار مفقود');
chk(window.isMissingRoute({ message: 'المسار غير موجود في الخادم المشغّل' }) === true, 'رسالة 404 المحلية ⇒ مسار مفقود');
chk(window.isMissingRoute({ status: 500, message: 'خطأ داخلي' }) === false, 'خطأ آخر ليس مسارًا مفقودًا');
chk(window.isMissingRoute({ status: 403, message: 'ممنوع' }) === false, '403 ليس مسارًا مفقودًا');

/* ---------- 3) البناء من المسارات القائمة (بأشكال استجابات API الحقيقية) ---------- */
{
  const d = window.buildWorkCenterLegacy({
    runs: { items: [
      { runId: 'run_1', source: { name: 'daily_balances', label: 'الأرصدة اليومية' }, rowCount: 120, columns: ['a', 'b'], savedAt: '2026-10-20T10:00:00Z', traced: true, definitionChanged: false, engineState: 'same', warnings: [] },
      { runId: 'run_2', source: { name: 'movements', label: 'الحركات' }, rowCount: 5000, columns: ['a'], savedAt: '2026-10-21T10:00:00Z', traced: false, definitionChanged: null, engineState: 'unknown', warnings: ['اقتُطع الطرف الأيمن'] },
    ] },
    /* GET /api/catalog ⇒ {summary, domains, statuses, sources} */
    catalog: { summary: { total: 21, canonicalBalance: 'daily_balances', byStatus: { 'منفّذ': 20, 'موثق فقط': 1 } } },
    /* GET /api/model/formulas ⇒ {items, summary, …} وsummary فيه {formulas:{total,byStatus}, numericVerified} */
    model: { summary: { formulas: { total: 81, byStatus: { 'مطابق منطقيًا': 31 } }, numericVerified: 0 } },
    /* GET /api/screens ⇒ {summary, screens, reports} */
    screens: { summary: { screens: 18, reports: 31, visibleReports: 17 } },
  });
  chk(d.degraded && d.degraded.active === true, 'العرض معلَّم كوضع توافق');
  chk(/إعادة تشغيل الخادم/.test(d.degraded.note), 'التنبيه يذكر إعادة تشغيل الخادم');
  chk(d.runs.length === 2 && d.runs[0].rows === 120 && d.runs[0].columns === 2, 'التشغيلات محوَّلة بأرقامها الحقيقية');
  chk(d.runs[0].source === 'الأرصدة اليومية', 'اسم المصدر محوَّل');
  chk(d.runs[1].warnings === 1 && d.runs[1].traced === false, 'التحذيرات وحالة التتبّع محوَّلة');
  chk(d.health.sources.total === 21 && d.health.sources.implemented === 20 && d.health.sources.documented === 1, 'صحة المصادر صحيحة');
  chk(d.health.sources.canonical === 'daily_balances', 'المرجع المعتمد ظاهر');
  chk(d.health.formulas.total === 81, 'عدد المعادلات صحيح');
  chk(d.health.screens.total === 18 && d.health.screens.reports === 31, 'عدّ الشاشات والتقارير صحيح');
  chk(d.reports.length === 0 && d.formulas.length === 0, 'لا بيانات مفترضة في البطاقتين غير المتاحتين');
  chk(d.empty.reports === true && d.empty.formulas === true, 'الحالة الفارغة معلنة في البطاقتين');
  chk(d.empty.runs === false, 'بطاقة التشغيلات ليست فارغة');
  chk(d.alerts.some(a => a.kind === 'warn') && d.alerts.some(a => a.kind === 'info'), 'التنبيهات مشتقة من التشغيلات');
  chk(Array.isArray(d.actions) && d.actions.length === 0, 'لا إجراءات مفترضة في وضع التوافق');
}

/* ---------- 4) غياب البيانات ⇒ لا اختلاق ---------- */
{
  const d = window.buildWorkCenterLegacy({});
  chk(d.runs.length === 0 && d.reports.length === 0 && d.formulas.length === 0, 'لا عناصر عند غياب البيانات');
  chk(d.empty.runs === true && d.empty.reports === true && d.empty.formulas === true, 'كل الحالات الفارغة معلنة');
  chk(d.health.sources.total === 0 && d.health.screens.total === 0, 'الأرقام المفقودة صفر لا قيم متخيّلة');
}

/* ---------- 5) الربط في الواجهة ---------- */
{
  chk(/apiCall\('\/api\/workcenter'\)/.test(WCJS), 'المركز يطلب المسار الجديد أولًا');
  chk(/apiCall\('\/api\/workflows\/outputs'\)/.test(WCJS), 'وضع التوافق يقرأ قائمة التشغيلات');
  chk(/apiCall\('\/api\/catalog'\)/.test(WCJS) && /apiCall\('\/api\/screens'\)/.test(WCJS)
    && /apiCall\('\/api\/model\/formulas'\)/.test(WCJS), 'وضع التوافق يقرأ الفهرس والمعادلات والشاشات');
  chk(/isMissingRoute\(e\)/.test(WCJS), 'الرجوع إلى وضع التوافق عند غياب المسار');
  chk(IDX.includes('id="wc-degraded"'), 'شريط وضع التوافق موجود في HTML');
  chk(/\.wc-degraded\[hidden\]\{display:none\}/.test(CSS), 'شريط التوافق مخفي افتراضيًا (hidden respected)');
  chk(!/\beval\s*\(/.test(WCJS) && !/new Function\s*\(/.test(WCJS), 'لا تنفيذ اعتباطي في workcenter.js');
}

chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');
console.log('\nworkcenter_legacy.test.js — pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
