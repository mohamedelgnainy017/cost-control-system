'use strict';
/**
 * حراسة بنية التنقل — منصة واحدة بثلاثة أقسام ومدخل تقارير واحد
 * =========================================================================
 * العطل التاريخي: كُتبت مجموعة «منصة التحليل» داخل قائمة فرعية ⇒ اختفت
 * أزرار الاستوديو، وبقي زر المنصة داخل قائمة مخفية.
 *
 * البنية الحالية (بعد إعادة التنظيم):
 *   الرئيسية · البيانات الأساسية · تسجيل البيانات · منصة التحليل (٣ أقسام + الصفحة الرئيسية)
 *   «المعادلات والتحليل» ليست شاشة رابعة: محتواها داخل «البيانات والتحليل».
 *   ولا يوجد زر خارجي مكرّر للتقارير، ولا زر «شاشات مخصّصة» خارجي
 *   (الشاشات المخصّصة تُفتح من داخل «تصميم الشاشات والتحكم»).
 *
 * الفحوصات بنيوية (ساكنة) على HTML المُخدوم — بلا متصفح.
 */
const fs = require('fs');
const path = require('path');
const guard = require('./_guard');
guard.install();

const IDX = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

console.log('== بنية شريط التنقل ==');

/* ---------- 1) تحليل <nav> إلى شجرة مبسّطة ---------- */
const navStart = IDX.indexOf('<nav>');
const navEnd = IDX.indexOf('</nav>');
chk(navStart >= 0 && navEnd > navStart, '<nav> موجود في index.html');
const NAV = IDX.slice(navStart + 5, navEnd);

const root = { tag: 'nav', id: '', cls: '', children: [], path: [] };
const stack = [root];
let mismatch = '';
{
  const re = /<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(NAV)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    if (['meta', 'link', 'br', 'hr', 'img', 'input'].includes(tag)) continue;
    if (closing) {
      const popped = stack.pop();
      if (!popped) { mismatch = ' closing بدون فتح: ' + tag; break; }
      if (popped.tag !== tag) { mismatch = ' فتح <' + popped.tag + '> وإغلاق </' + tag + '>'; break; }
      continue;
    }
    const id = (attrs.match(/id="([^"]+)"/) || [])[1] || '';
    const cls = (attrs.match(/class="([^"]+)"/) || [])[1] || '';
    const node = { tag, id, cls, attrs, children: [], path: stack.slice() };
    stack[stack.length - 1].children.push(node);
    if (!m[4]) stack.push(node);
  }
}
chk(mismatch === '', 'وسوم <nav> متوازنة بلا تداخل' + (mismatch ? ' — ' + mismatch : ''));
chk(stack.length === 1 && stack[0] === root, 'لا وسوم مفتوحة معلّقة داخل <nav>');

/* ---------- 2) كل مجموعة قائمة منسدلة ابن مباشر لـ <nav> (حراسة العطل) ---------- */
const drops = root.children.filter(n => n.tag === 'div' && (n.cls || '').includes('nav-drop'));
chk(drops.length >= 3, 'عدد المجموعات في الشريط: ' + drops.length + ' (البيانات · التسجيل · منصة التحليل)');
for (const d of drops) {
  const insideMenu = d.path.some(p => (p.cls || '').includes('nav-menu'));
  chk(!insideMenu, 'المجموعة «' + (d.id || d.cls) + '» ابن مباشر لـ <nav> (ليست داخل قائمة فرعية)');
}

/* ---------- 3) مدخل التقارير واحد: لا معلومات/تقارير/شاشات مخصّصة خارجية ---------- */
{
  chk(!IDX.includes('id="nav-info-drop"') && !IDX.includes('id="nav-info-btn"'),
    'لا مجموعة «لوحة المعلومات» المكرّرة (التقارير داخل المنصة فقط)');
  chk(!IDX.includes('id="nav-rep-sub"') && !IDX.includes('id="rep-sub-list"'),
    'لا قائمة تقارير فرعية خارجية مكرّرة');
  chk(!IDX.includes('id="nav-custom-drop"') && !IDX.includes('id="nav-custom-btn"'),
    'لا زر «شاشات مخصّصة» في التنقل الخارجي');
  chk(/id="rp-app-groups"/.test(IDX) && /data-pf-group="sales"/.test(IDX),
    'مجموعات التقارير نُقلت داخل شاشة «التقارير»');
  chk(/id="ss-custom-open"/.test(IDX), 'فتح الشاشات المخصّصة من داخل «الشاشات والتحكّم»');
}

/* ---------- 4) كل زر تنقّل يشير إلى قسم موجود ---------- */
const SECTIONS = new Set([...IDX.matchAll(/<section id="tab-([^"]+)"/g)].map(m => m[1]));
const GROUP_TABS = new Set(['md', 'daily', 'pricegroup']);
const allButtons = [];
(function walk(n) { for (const c of n.children) { allButtons.push(c); walk(c); } })(root);
const navButtons = allButtons.filter(n => n.tag === 'button');
chk(navButtons.length > 0, 'عدد أزرار الشريط: ' + navButtons.length);

const gotoNames = [];
for (const b of navButtons) {
  const go = (b.attrs.match(/data-goto="([^"]+)"/) || [])[1];
  const tab = (b.attrs.match(/data-tab="([^"]+)"/) || [])[1];
  if (go) gotoNames.push(go);
  if (tab && !GROUP_TABS.has(tab)) {
    chk(SECTIONS.has(tab), 'زر data-tab="' + tab + '" يشير إلى قسم موجود (#tab-' + tab + ')');
  }
  if (go) {
    chk(SECTIONS.has(go), 'زر data-goto="' + go + '" يشير إلى قسم موجود (#tab-' + go + ')');
  }
}
for (const t of ['platform', 'analysis', 'report-studio', 'screen-studio']) {
  chk(SECTIONS.has(t), 'القسم #tab-' + t + ' موجود في HTML');
}
for (const t of ['analysis', 'report-studio', 'screen-studio']) {
  chk(gotoNames.includes(t), '«' + t + '» متاح من الشريط (data-goto)');
}
chk(!SECTIONS.has('workflow'), 'لا قسم رابع باسم workflow (محتواه داخل البيانات والتحليل)');
chk(/const PLATFORM_HOST = \{[^}]*'workflow': 'analysis'/.test(APP),
  'الرابط/الصلاحية القديمة workflow تُترجم إلى قسم analysis');
chk(!SECTIONS.has('workcenter') && !SECTIONS.has('reports-manager'),
  'التبويبات القديمة لم تبقَ كأقسام منفصلة (مدموجة)');
chk(!/data-platform-home="1"/.test(IDX), 'تم إخفاء «الصفحة الرئيسية للمنصة» من القائمة وفتح المهام مباشرة');
chk(/id="platform-home-grid"/.test(IDX) && /id="platform-home-status"/.test(IDX),
  'الصفحة الرئيسية ما زالت موجودة كـ tab-platform للعرض عند الحاجة');

/* ---------- 5) الأقسام الثلاثة هي محتوى القائمة ---------- */
{
  const labels = navButtons.map(b => (b.attrs.match(/data-goto="([^"]+)"/) || [])[1]).filter(Boolean);
  chk(labels.includes('analysis') && labels.includes('report-studio') && labels.includes('screen-studio'),
    'الأقسام الثلاثة موجودة في قائمة المنصة');
  chk(!labels.includes('workflow'), 'لا مدخل تنقل رابع لـ workflow (لا تكرار)');
}

/* ---------- 6) DROP_SUBS في app.js يطابق أزرار الشريط ---------- */
{
  const m = APP.match(/const DROP_SUBS = \{([\s\S]*?)\n\};/);
  chk(!!m, 'جدول DROP_SUBS موجود في app.js');
  const body = m ? m[1] : '';
  const platform = (body.match(/platform:\s*\[([^\]]*)\]/) || [])[1] || '';
  const listed = platform.split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  for (const t of ['analysis', 'report-studio', 'screen-studio']) {
    chk(listed.includes(t), 'DROP_SUBS.platform يحوي «' + t + '»');
  }
  chk(!listed.includes('workflow'), 'DROP_SUBS.platform لا يكرّر workflow كقسم رابع');
  chk(/platform: \['analysis'/.test(APP), 'مجموعة المنصة مرتبطة بالأقسام الثلاثة في app.js');
  chk(/g === 'platform' \? '#nav-platform-btn'/.test(APP), 'زر المنصة مرتبط في dropBtnSel');
  chk(/g === 'platform' \? \$\('#nav-platform-menu'\)/.test(APP), 'قائمة المنصة مرتبطة في dropMenuEl');
}

/* ---------- 7) كل شاشة لها عنوان وخطّاف تحميل ---------- */
{
  const t = (APP.match(/const TITLES = \{([\s\S]*?)\n\};/) || [])[1] || '';
  for (const tab of ['platform', 'analysis', 'report-studio', 'screen-studio']) {
    chk(new RegExp("'" + tab + "':").test(t) || new RegExp('\\b' + tab + ':').test(t), 'عنوان القسم «' + tab + '» معرَّف في TITLES');
  }
  chk(/function openPlatformHome\(\)/.test(APP), 'دالة فتح الصفحة الرئيسية معرَّفة');
  chk(/if \(isPlatformHome\(name\)\) \{ openPlatformHome\(\); return; \}/.test(APP),
    'goTab يفتح الصفحة الرئيسية للمنصة');
  for (const [tab, fn] of [['analysis', 'loadAnalysisTab'],
    ['report-studio', 'loadReportStudioTab'], ['screen-studio', 'loadScreenStudioTab']]) {
    chk(new RegExp("name === '" + tab + "'").test(APP), 'loadTab يفرّع على «' + tab + '»');
    chk(APP.includes(fn), 'خطّاف ' + fn + ' مستخدم');
  }
  chk(/name === 'analysis'[\s\S]*loadWorkflowTab/.test(APP),
    'بناء التحليل يُحمَّل داخل قسم analysis (بلا شاشة رابعة)');
}

/* ---------- 8) المدير لا يُحجب عن أي شاشة (قاعدة واحدة) ---------- */
{
  chk(/const isAdmin = \(\) => !!\(me && me\.role === 'admin'\)/.test(APP), 'قاعدة isAdmin معرَّفة مرة واحدة');
  chk(/const tabAllowed = t => t === PLATFORM_HOME/.test(APP), 'قاعدة tabAllowed تحترم صفحة المنصة الرئيسية');
  chk(/!isAdmin\(\) && me && Array\.isArray\(me\.tabs\)/.test(APP), 'loadTab لا يحجب المدير عن شاشة');
  chk(/PLATFORM_SCREENS\.some\(x => tabAllowed\(x\)\)/.test(APP), 'صفحة المنصة متاحة لمن يملك أي شاشة');
  chk(/g === 'platform' \? PLATFORM_SCREENS\.filter\(t => tabAllowed\(t\)\)/.test(APP),
    'مجموعة المنصة تمرّر على tabAllowed');
  chk(/if \(b\.dataset\.goto\) \{ vis\(b, tabAllowed\(b\.dataset\.goto\)\); return; \}/.test(APP),
    'إظهار أزرار التنقل يمرّر على tabAllowed');
  chk(/if \(b\.dataset\.drop\) \{ vis\(b\.closest\('\.nav-drop'\) \|\| b, \(DROP_SUBS\[b\.dataset\.drop\] \|\| \[\]\)\.some\(t => tabAllowed\(t\)\)\); return; \}/.test(APP),
    'إظهار المجموعات يمرّر على tabAllowed');
  chk(/!tabs\.includes\(current\)/.test(APP) === false || /!tabAllowed\(current\)/.test(APP),
    'تغيير الدور لا يطرد المستخدم من صفحة المنصة الرئيسية');
  chk(!/const isAdmin = !!me && me\.role === 'admin';/.test(APP), 'لا نسخة مكرّرة من قاعدة المدير');
  chk(/r\.status === 404 && \/\^\\s\*not found/.test(APP), 'رسالة 404 توجّه المستخدم لإعادة تشغيل الخادم');
}

/* ---------- 9) لا eval ولا تفسير نصي في الواجهة ---------- */
chk(!/\beval\s*\(/.test(APP) && !/new Function\s*\(/.test(APP), 'لا تنفيذ اعتباطي في app.js');

chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');
console.log('\nnav_structure.test.js — pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
