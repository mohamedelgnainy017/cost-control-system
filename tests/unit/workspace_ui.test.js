'use strict';
/**
 * عقد واجهة مساحة العمل (Workspace Links UI) — فحص ثابت
 * ============================================================
 * يتحقق من: وجود شريط السياق في الشاشات الخمس · أدوات الربط ·
 * لوحة التفاصيل في المستكشف · تبويبات إدارة التقارير · أدوات مصمم الشاشات ·
 * وعدم وجود تنفيذ اعتباطي.
 */
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

console.log('== عقد واجهة مساحة العمل ==');

const root = path.join(__dirname, '..', '..');
const IDX = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const AN = fs.readFileSync(path.join(root, 'public', 'analysis.js'), 'utf8');
const WC = fs.readFileSync(path.join(root, 'public', 'workcenter.js'), 'utf8');
const RD = fs.readFileSync(path.join(root, 'public', 'report-designer.js'), 'utf8');
const SS = fs.readFileSync(path.join(root, 'public', 'screen-studio.js'), 'utf8');
const WS = fs.readFileSync(path.join(root, 'public', 'workspace.js'), 'utf8');
const WL = fs.readFileSync(path.join(root, 'public', 'workspace-links.js'), 'utf8');
const SRV = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');

/* ---------- 1) شريط السياق في الأقسام الثلاثة ---------- */
for (const id of ['ws-context-analysis', 'ws-context-report-studio', 'ws-context-screen-studio']) {
  chk(IDX.includes('id="' + id + '"'), 'شريط السياق موجود: ' + id);
}
chk(!IDX.includes('ws-context-workflow'), 'لا شريط سياق منفصل للشاشة المدموجة (workflow)');
chk(!IDX.includes('ws-context-reports-manager'), 'لا شريط سياق للشاشة المدموجة (reports-manager)');
chk(IDX.includes('/workspace-links.js') && IDX.includes('/workspace.js'), 'سكربتات الربط محمّلة');

/* ---------- 2) وحدة العلاقات (مصدر واحد) ---------- */
chk(WL.includes('function buildIndex'), 'وحدة العلاقات تبني الفهرس');
chk(WL.includes('formulaUsage') && WL.includes('columnUsage') && WL.includes('runUsage'), 'دوال الاستخدام موجودة');
chk(!/require\('fs'\)|require\("fs"\)/.test(WL), 'وحدة العلاقات بلا I/O');
chk(SRV.includes("'GET /workspace-links.js'"), 'الخادم يقدّم وحدة العلاقات للمتصفح');
chk(fs.existsSync(path.join(root, 'public', 'workspace-links.js')), 'وحدة العلاقات ملف عام (تُخدَم بلا إعادة تشغيل)');

/* ---------- 3) طبقة الربط في المتصفح ---------- */
chk(WS.includes('window.Workspace ='), 'طبقة Workspace معرَّفة');
chk(WS.includes('function go(') && WS.includes('gotoGroupSub'), 'الانتقال بين الشاشات عبرgotoGroupSub');
chk(WS.includes('loadIndex'), 'تحميل فهرس العلاقات');
chk(!/\beval\s*\(/.test(WS) && !/new Function\s*\(/.test(WS), 'لا تنفيذ اعتباطي في طبقة الربط');

/* ---------- 4) المستكشف: لوحة التفاصيل والبحث بأسماء الأعمدة ---------- */
chk(IDX.includes('id="an-detail"'), 'لوحة التفاصيل موجودة في المستكشف');
chk(AN.includes('data-col-detail') && AN.includes('showColumnDetail'), 'تفاصيل العمود قابلة للفتح');
chk(AN.includes('data-fml-detail') && AN.includes('showFormulaDetail'), 'تفاصيل المعادلة قابلة للفتح');
chk(AN.includes('fieldNamesOf'), 'البحث يشمل أسماء الأعمدة');
chk(AN.includes('focusExplorerFormula') && AN.includes('focusExplorerColumn'), 'تركيز العنصر من شاشة أخرى');
chk(!AN.includes('qu’esteko'), 'لا نص مشوّه في المستكشف');
chk(!AN.includes('و|report'), 'لا كلمة إنجليزية متبقية في تلميح المعادلات');

/* ---------- 5) إدارة التقارير: قائمة موحدة + مصمم داخل قسم التقارير ---------- */
chk(IDX.includes('id="rp-p-app"') && IDX.includes('id="rp-p-designer"'),
  'لوحتا التقارير ظاهرتان (جميع التقارير · المصمم)');
chk(IDX.includes('data-pf-group="app"') && IDX.includes('data-pf-group="saved"') && IDX.includes('data-pf-group="draft"'),
  'القائمة الموحدة مصنَّفة: تقارير التطبيق · تقاريري · المسودات');
chk(WC.includes('/api/reports/saved') && WC.includes('data-rm='),
  'التقارير المحفوظة تُعرض وتُدار من القائمة الموحدة نفسها');
chk(IDX.includes('id="rm-sort"'), 'قائمة الترتيب موجودة');
chk(WC.includes("rmAppReports"), 'تقارير التطبيق تُحمَّل من سجل التطبيق');
chk(WC.includes('data-ra="import"'), 'استيراد تقرير التطبيق في المصمم');
chk(WC.includes("rm-rows") === false, 'لا سجل مكرر');
chk(WC.includes('تقرير تطبيق') && WC.includes('تصميم محفوظ'), 'تمييز القديم/الجديد');

/* ---------- 6) مصمم التقارير: روابط المصدر + إعادة الهيكلة ---------- */
chk(IDX.includes('id="rs-rebuild"'), 'زر إعادة الهيكلة موجود');
chk(RD.includes('rs-rebuild'), 'إعادة الهيكلة موصولة');
chk(RD.includes('id="rs-src-analysis"') || RD.includes('rs-src-analysis'), 'رابط فتح التحليل من لوحة المصدر');
chk(RD.includes('rs-src-explorer'), 'رابط فتح المستكشف من لوحة المصدر');
chk(RD.includes('id="rs-to-screen"') || IDX.includes('id="rs-to-screen"'), 'الإدراج في شاشة موجود');
chk(RD.includes('insertReportIntoScreen'), 'دالة الإدراج في شاشة مستخدمة');

/* ---------- 7) مصمم الشاشات: إدراج تقرير + شاشات النظام ---------- */
chk(IDX.includes('id="ss-insert-report"') && IDX.includes('id="ss-insert-report-btn"'), 'أداة إدراج تقرير محفوظ موجودة');
chk(IDX.includes('id="ss-system-screens"'), 'أداة عرض شاشات النظام موجودة');
chk(SS.includes('function insertSavedReport'), 'دالة الإدراج منفَّذة');
chk(SS.includes('function showSystemScreens'), 'دالة شاشات النظام منفَّذة');
chk(SS.includes('لا بنية المحتوى') || SS.includes('المحتوى غير قابل للتحرير'), 'الحدّ الجاهز مذكور صراحةً');

/* ---------- 8) سلامة عامة ---------- */
for (const [name, src] of [['analysis.js', AN], ['workcenter.js', WC], ['report-designer.js', RD], ['screen-studio.js', SS]]) {
  chk(!/\beval\s*\(/.test(src) && !/new Function\s*\(/.test(src), 'لا تنفيذ اعتباطي في ' + name);
}
chk(!/\beval\s*\(/.test(APP) && !/new Function\s*\(/.test(APP), 'لا تنفيذ اعتباطي في app.js');
chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');
console.log('\nworkspace_ui.test.js — pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
