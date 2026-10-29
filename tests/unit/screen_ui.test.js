'use strict';
/**
 * عقد واجهة مصمم الشاشات (static + wiring)
 * ============================================================
 * يفحص وجود الشاشة في HTML وربطها بالخادم والتنقل والصلاحيات،
 * وغياب أي تنفيذ اعتباطي في واجهة الشاشات.
 */
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

console.log('== واجهة مصمم الشاشات ==');

const root = path.join(__dirname, '..', '..');
const IDX = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const STUDIO = fs.readFileSync(path.join(root, 'public', 'screen-studio.js'), 'utf8');
const SRV = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
const POLICY = fs.readFileSync(path.join(root, 'src', 'route-policy.js'), 'utf8');
const MODEL = fs.readFileSync(path.join(root, 'src', 'app-screen.js'), 'utf8');

/* ---------- 1) HTML ---------- */
chk(IDX.includes('<section id="tab-screen-studio"'), 'قسم «مصمم الشاشات» موجود في HTML');
chk(/data-goto="screen-studio"/.test(IDX), 'زر «مصمم الشاشات» في الشريط');
chk(IDX.includes('id="ss-custom-open"') && IDX.includes('id="ss-custom-open-row"'),
  'فتح الشاشات المخصّصة من داخل «الشاشات والتحكّم»');
chk(!IDX.includes('id="nav-custom-btn"'), 'لا زر «شاشات مخصّصة» خارجيًا في الشريط');
chk(IDX.includes('id="ss-canvas"') && IDX.includes('id="ss-inspector"'), 'لوحة المكوّنات ولوحة الخصائص موجودان');
chk(IDX.includes('id="ss-inputs"') && IDX.includes('id="ss-buttons"'), 'لوحتا المدخلات والأزرار موجودان');
chk(IDX.includes('id="ss-run"'), 'اختيار مصدر البيانات موجود');
chk(IDX.includes('id="ss-preview-host"'), 'منطقة المعاينة موجودة');
chk(/<script src="\/screen-studio\.js">/.test(IDX), 'سكربت مصمم الشاشات محمَّل');
chk(/<script src="\/app-screen\.js">/.test(IDX), 'نموذج الشاشات محمَّل (مصدر واحد مع الخادم)');

/* ---------- 2) app.js ---------- */
chk(APP.includes("'screen-studio': ["), 'عنوان الشاشة معرَّف في TITLES');
chk(APP.includes("name === 'screen-studio'"), 'loadTab يفرّع على «screen-studio»');
chk(APP.includes('loadScreenStudioTab'), 'خطّاف المصمم مستخدم');
chk(/platform: \[[^\]]*'screen-studio'/.test(APP), 'الشاشة ضمن قائمة «منصة التحليل»');
chk(/g === 'custom' \? \(DROP_SUBS\.custom \|\| \[\]\)/.test(APP), 'قائمة الشاشات المخصّصة مرتبطة بالصلاحيات');
chk(STUDIO.includes("$('ss-custom-open')") && STUDIO.includes('data-cs-open'), 'قائمة فتح الشاشات المخصّصة داخل المنصة');
chk(!/g === 'custom' \? '#nav-custom-btn'/.test(APP), 'لا ربط لزر خارجي محذوف');
chk(APP.includes('mountCustomScreens'), 'بناء الشاشات المخصّصة عند الدخول');
chk(APP.includes("indexOf('cs_') === 0"), 'التنقل يدعم معرّفات cs_');
chk(/const isAdmin = \(\) => !!\(me && me\.role === 'admin'\)/.test(APP), 'قاعدة isAdmin كما هي (لم تُمَس)');
chk(/const tabAllowed = t => t === PLATFORM_HOME/.test(APP), 'قاعدة tabAllowed تحترم الصفحة الرئيسية للمنصة');
chk(!/\beval\s*\(/.test(APP) && !/new Function\s*\(/.test(APP), 'لا تنفيذ اعتباطي في app.js');

/* ---------- 3) screen-studio.js ---------- */
chk(!/\beval\s*\(/.test(STUDIO) && !/new Function\s*\(/.test(STUDIO), 'لا تنفيذ اعتباطي في مصمم الشاشات');
chk(!/document\.write\(/.test(STUDIO), 'لا document.write');
chk(STUDIO.includes("ApiCall") || STUDIO.includes("apiCall"), 'يستخدم مسار API الموحّد');
chk(STUDIO.includes('/api/screens/custom/save'), 'الحفظ عبر مسار الشاشات المخصّصة');
chk(STUDIO.includes('/api/reports/render'), 'التصيير عبر محرّك التقارير (بلا حساب موازٍ)');
chk(STUDIO.includes('openCustomScreen'), 'خطّاف فتح شاشة مخصّصة');
chk(STUDIO.includes('loadScreenStudioTab'), 'خطّاف تحميل المصمم');
chk(!/\+\s*b\.action\.id\s*\+/.test(STUDIO), 'معرّف الإجراء لا يُحقن بلا تهريب');
chk(STUDIO.includes('esc(b.action.id)'), 'معرّف الإجراء يمرّ بالتهريب قبل العرض');

/* ---------- 4) الخادم ---------- */
chk(SRV.includes("'GET /api/screens/custom'"), 'مسار قائمة الشاشات المخصّصة');
chk(SRV.includes("'GET /api/screens/custom/get'"), 'مسار فتح شاشة');
chk(SRV.includes("'POST /api/screens/custom/save'"), 'مسار حفظ شاشة');
chk(SRV.includes("'POST /api/screens/custom/delete'"), 'مسار حذف شاشة');
chk(SRV.includes("'GET /app-screen.js'"), 'النموذج يُخدَم من src (مصدر حقيقة واحد)');
chk(SRV.includes('function allTabs()'), 'التبويبات الديناميكية (ثابتة + مخصّصة)');
chk(SRV.includes('function customTabs()'), 'قائمة الشاشات المخصّصة في التبويبات');
chk(/const PERM_ROUTES = Policy\.WRITE_PERM_ROUTES/.test(SRV), 'server uses the policy write-permission table');
chk(POLICY.includes("'POST /api/screens/custom/save': 'master'"), 'حفظ الشاشات بصلاحية master');
chk(POLICY.includes("'POST /api/screens/custom/delete': 'master'"), 'حذف الشاشات بصلاحية master');
chk(POLICY.includes("['/api/screens/custom', ['screen-studio', 'dashboard']]"), 'مسار الشاشات مربوط بالشاشات');
chk(/const CUSTOM_SCREEN_API = Policy\.CUSTOM_SCREEN_API/.test(SRV) && POLICY.includes('CUSTOM_SCREEN_API'), 'استثناء قراءة الشاشات المخصّصة محدَّد');

/* ---------- 5) النموذج ---------- */
chk(MODEL.includes('ID_RE'), 'النموذج يعرّف قاعدة المعرّفات');
chk(MODEL.includes('validateScreen'), 'النموذج يوفّر التحقق');
chk(MODEL.includes('composeRenderPayload'), 'النموذج يوفّر تركيب حزمة التصيير');
chk(!/require\('fs'\)|require\("fs"\)/.test(MODEL), 'النموذج بلا I/O');

chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');
console.log('\nscreen_ui.test.js — pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
