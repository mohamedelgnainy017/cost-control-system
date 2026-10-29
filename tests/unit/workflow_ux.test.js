'use strict';
/**
 * اختبارات تجربة الاستخدام (Workflow ↔ Report Studio) — معزولة.
 * - تدقيق ساكن لواجهات التسليم/الحماية/الانشغال/المعاينة المنفصلة.
 * - سلوك بيانات: حفظ/فتح تقرير يحتفظ بمعرّف التشغيل (أساس اختيار المصدر).
 */
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RS = require('../../src/report-store');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

const app = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
/* المصمم المرئي انتقل إلى public/report-designer.js — التدقيقات الساكنة تُطبَّق عليه */
const rd = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'report-designer.js'), 'utf8');
const idx = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

console.log('== workflow/report UX contract ==');

/* ---------- 1) تسليم نتيجة التحليل إلى استوديو التقارير ---------- */
chk(/if \(d\.runId\) html \+= .*معرّف التشغيل/.test(app), 'نتيجة التشغيل تعرض معرّف التشغيل للمستخدم');
chk(/id="wf-send-to-report"/.test(app), 'زر «استخدمه في استوديو التقارير» موجود');
chk(/wf-send-to-report/.test(app) && /goTab\('report-studio'\)/.test(app),
  'الزر ينقل المستخدم إلى استوديو التقارير');
chk(/const target = \$\('rs-runid'\);\s*\n\s*if \(target\) target\.value = d\.runId;/.test(app),
  'الزر يعبّئ معرّف التشغيل في استوديو التقارير');

/* ---------- 2) حماية التعديلات غير المحفوظة ---------- */
chk(/function confirmDiscard\(\)/.test(rd), 'وظيفة تأكيد فقدان التعديلات موجودة');
chk(/if \(!confirmDiscard\(\)\) \{ toast\('تم الإلغاء/.test(rd), 'التحميل يحمي التعديلات');
chk(/if \(!confirmDiscard\(\)\) \{ toast\('تم الإلغاء — لم تُفقد تعديلاتك'\); return; \}\n\s*\$?\s*\$?\('rs-name'\)/.test(rd) ||
    /function newReport()[\s\S]{0,220}confirmDiscard/.test(rd), 'زر «جديد» يحمي التعديلات');
chk(/rs-runlist[\s\S]{0,320}confirmDiscard/.test(rd), 'تغيير تشغيل المصدر يحمي التعديلات');
chk(/runidInput\.addEventListener[\s\S]{0,220}confirmDiscard/.test(rd), 'تغيير حقل runId يحمي التعديلات');

/* ---------- 3) تتبّع حالة التعديل ---------- */
chk(/let dirty = false;/.test(rd), 'حالة التعديل متتبَّعة');
const dirtyMarks = (rd.match(/setDirty\(true\)/g) || []).length;
chk(dirtyMarks >= 5, 'كل مسارات التعديل (إضافة/تعديل/حذف/ترتيب/JSON) تُعلّم dirtiness (' + dirtyMarks + ')');
chk((rd.match(/setDirty\(false\)/g) || []).length >= 3, 'الحفظ/الفتح/الجديد يمسحون حالة التعديل');

/* ---------- 4) حالات التحميل والنجاح ---------- */
chk(/busy\('جاري الحفظ…'\)/.test(rd), 'حالة انشغال أثناء الحفظ');
chk(/busy\('جاري المعاينة…'\)/.test(rd), 'حالة انشغال أثناء المعاينة');
chk(/busy\('جاري التحقق…'\)/.test(rd), 'حالة انشغال أثناء التحقق');
chk(/تم الحفظ باسم: /.test(rd) && /تم الحفظ: /.test(rd), 'رسائل نجاح الحفظ/الحفظ باسم موجودة');
chk(/لا توجد بيانات لعرضها/.test(rd), 'حالة «لا توجد بيانات» واضحة');
chk(/· المصدر: /.test(rd), 'المعاينة توضّح التشغيل المصدر');

/* ---------- 5) فصل المعاينة + الاستجابة ---------- */
chk(/<h3>معاينة التقرير<\/h3>/.test(idx), 'المعاينة في بطاقة مستقلة بعنوان');
chk(idx.indexOf('id="rs-canvas"') < idx.indexOf('id="rs-result"'), 'أدوات التحرير تسبق المعاينة (فصل واضح)');
chk(/@media \(max-width: 720px\)/.test(idx), 'قاعدة استجابة للشاشات الضيقة موجودة');
chk(/\.wf-section \.wf-step-actions \{ grid-column: 1 \/ -1;/.test(idx), 'أزرار المكوّن تنتقل لسطر مستقل على الشاشات الضيقة');

/* ---------- 6) سلوك البيانات: التقرير يحتفظ بمعرّف تشغيله ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-'));
const r = RS.saveReport({ name: 'ت', runId: 'run_42', components: [{ type: 'kpi', label: 'x', column: 'c', agg: 'sum' }] }, tmp);
const back = RS.loadReport(r.id, tmp);
chk(!!back && back.runId === 'run_42', 'التقرير المحفوظ يحتفظ بمعرّف التشغيل (مصدر البيانات)');
chk(!!back && back.components.length === 1, 'المكونات محفوظة مع التقرير');
fs.rmSync(tmp, { recursive: true, force: true });

/* ---------- 7) حارس ضد تلف helpers الـDOM: $() بدل $$() = TypeError يُسقط بقية app.js ---------- */
const badDollar = [];
app.split('\n').forEach((l, i) => {
  if (/(^|[^$])\$\('[^']*'\)\.(forEach|map|filter)\(/.test(l)) badDollar.push(i + 1);
});
chk(badDollar.length === 0, 'لا استدعاء $() مفرد مع forEach/map/filter — لا TypeError عند التحميل' + (badDollar.length ? ' @' + badDollar.join(',') : ''));
/* ---------- 8) حارس شجرة التنقل: لا قوائم فرعية + dropAllowed(info) مصفوفة ---------- */
/* ---------- 8) حارس شجرة التنقل: قوائم جانبية + dropAllowed(info) مصفوفة ---------- */
const navHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const navSec = navHtml.substring(navHtml.indexOf('<nav>'), navHtml.indexOf('<div class="nav-tools">'));
chk((navSec.match(/data-submenu="/g) || []).length === 3, 'تسجيل البيانات: 3 أزرار تفتح قوائم جانبية');
chk(navSec.includes('id="nav-daily-sub"') && navSec.includes('id="nav-price-sub"') && navSec.includes('id="nav-con-menu"'),
  'القوائم الجانبية الثلاث موجودة (بيانات يومية / الأسعار والتكلفة / عقود الاستيراد)');
chk((navSec.match(/data-goto="(movements|sales|inventory)"/g) || []).length === 3, 'قائمة بيانات يومية: 3 شاشات');
chk((navSec.match(/data-goto="(borse|prices|costs)"/g) || []).length === 3, 'قائمة الأسعار والتكلفة: 3 شاشات');
chk((navSec.match(/data-con-step=/g) || []).length === 7 && navSec.includes('data-rep-name="contract-unified"'),
  'قائمة عقود الاستيراد: 7 خطوات + التقرير الموحّد');
chk(navSec.includes('data-goto="analysis"') && navSec.includes('data-goto="report-studio"'),
  'قائمة المنصة تحتوي الأقسام الثلاثة (بلا شاشة workflow رابعة)');
chk(!/\['workflow', 'report-studio', 'reports'\]\.some\(/.test(app),
  'dropAllowed(info) لا يستخدم some (كان boolean ⇒ TypeError يمنع فتح الاستوديوهات)');
chk(/if \(b\.dataset\.submenu\) return;/.test(app), 'أزرار القوائم الجانبية لا يلتقطها معالج التنقل العام');
chk(app.includes("$$('nav [data-con-step]')"), 'خطوات العقود بمحدِّد عام داخل الشريط');
chk(/window\.innerHeight - hgt - 8/.test(app), 'القائمة الجانبية مقيّدة داخل حدود الشاشة (لا صندوق فارغ أسفل)');
chk(guard.count() === 0, 'صفر اتصال');

/* ---------- 9) شريط علوي مثبَّت (frozen header) ---------- */
const css = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'styles.css'), 'utf8');
chk(/body\{overflow-x:clip\}/.test(css), 'body يستخدم overflow-x:clip (لا hidden) حتى لا يصير حاوية تمرير تفقد الـ sticky');
chk(!/html,body\{overflow-x:hidden\}/.test(css), 'لا القاعدة القديمة html,body{overflow-x:hidden}');
chk(/main\{overflow-x:clip\}/.test(css), 'main يستخدم clip (بلا hidden) حتى لا يصير حاوية تمرير تفقد sticky رأس الجدول');
chk(/\.sidebar\{[\s\S]*?position:sticky;top:0;/.test(css), 'الشريط العلوي sticky:top:0');
/* فحص داخل كتلة .sidebar نفسها (لا يتسرّب لبقية الملف) */
const sidebarRule = (css.match(/\.sidebar\{[^}]*\}/) || [''])[0];
chk(!/box-shadow:/.test(sidebarRule), 'لا ظل أسفل الشريط العلوي (طلب المستخدم)');
chk(!/backdrop-filter:/.test(sidebarRule),
  'لا backdrop-filter على الشريط (ينشئ containing block فيُزيح القوائم المنسدلة fixed)');
chk(!/transform:/.test(sidebarRule), 'لا transform على الشريط (حتى لا تنزاح القوائم fixed)');
chk(!/filter:/.test(sidebarRule), 'لا filter على الشريط (نفس السبب)');
chk(!/will-change:/.test(sidebarRule), 'لا will-change على الشريط (نفس السبب)');
chk(/position:sticky;top:0;z-index:\d+/.test(sidebarRule), 'الشريط sticky مع z-index مرتفع');
chk(/\.nav-menu\{[\s\S]*?position:fixed/.test(css), 'القوائم المنسدلة position:fixed (تُموضَع بإحداثيات النافذة)');
chk(/\.nav-menu\{[\s\S]*?z-index:999/.test(css), 'القوائم المنسدلة z-index:999');
chk(/\.nav-drop\{[^}]*z-index:1000/.test(css), 'زر القائمة z-index:1000 فوق الشريط');

console.log(`\nworkflow_ux.test.js — pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
