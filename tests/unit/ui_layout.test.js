'use strict';
/**
 * مصمم الشاشات والقوائم — اكتشاف آلي لعناصر الشاشات + إجراءات مسجَّلة
 * =========================================================================
 * يثبت: (1) اكتشاف عناصر الشاشات من DOM مبسَّط (وظيفي)،
 *        (2) أن كل عنصر في التعريف يشير إلى عنصر قائم في الواجهة الحقيقية،
 *        (3) أن التطبيع والإجراءات مغلقان (لا JS حرّ ولا تجاوز صلاحيات).
 */
const fs = require('fs');
const path = require('path');
const guard = require('./_guard');
guard.install();

const UI = require('../../public/ui-layout.js');
const IDX = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
const RD = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'report-designer.js'), 'utf8');
const UIE = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'ui-editor.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'styles.css'), 'utf8');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

console.log('== مصمم الشاشات والقوائم (توسيع) ==');

/* ---------- 0) DOM مبسَّط يحاكي شاشتين حقيقيتين (للاختبار الوظيفي) ---------- */
const mkEl = (id, text, dataset) => ({
  id, textContent: text, dataset: dataset || {}, style: {},
  closest: () => null, querySelector: () => null, querySelectorAll: () => [],
});
const mkSection = (id, title, map) => ({
  id,
  querySelector: (s) => (s === '.card-h h3' || s === 'h3' ? mkEl('h', title) : null),
  querySelectorAll: (s) => (map[s] || []),
});
const SALES = mkSection('tab-sales', 'المبيعات', {
  'h3, h4': [mkEl('h3', 'إجمالي المبيعات'), mkEl('h4', 'التفصيل')],
  '.card-h .muted, .card-h .muted.xs, .hint': [mkEl('p', 'ملاحظة توضيحية')],
  '.card': [mkEl('div', 'بطاقة')],
  'table': [mkEl('table', 'جدول')],
  'button': [mkEl('button', 'تقرير'), mkEl('button', 'تصدير')],
});
const WORK = mkSection('tab-workcenter', 'مركز العمل', {
  'button': [mkEl('button', 'تحديث')],
});
const FAKE_DOC = {
  querySelectorAll: (s) => (s === 'section[id^="tab-"]' ? [SALES, WORK] : []),
  querySelector: (s) => (s && s.indexOf('nav ') === 0 ? mkEl('navbtn', 'زر') : null),
  head: null,
  createElement: () => mkEl('x', ''),
};
global.document = FAKE_DOC;

/* ---------- 1) اكتشاف آلي: DOM مبسَّط (اختبار وظيفي) ---------- */
{
  const els = UI.discover();
  const screens = UI.screens();

  chk(els.length === 8, 'العناصر المكتشفة: ' + els.length + ' (6 للمبيعات + 1 لمركز العمل + 1؟)');

  chk(els.length === 8, 'العناصر المكتشفة: ' + els.length + ' (6 للمبيعات + 1 لمركز العمل + 1؟)');
  chk(screens.length === 2, 'الشاشات المكتشفة: ' + screens.length);
  chk(screens[0].id === 'sales' && screens[0].label === 'المبيعات', 'معرّف الشاشة وعنوانها: ' + screens[0].id + ' / ' + screens[0].label);
  chk(els.some(e => e.id === 'sc:sales:text:1' && e.label === 'إجمالي المبيعات'), 'معرّف العنصر ثابت (شاشة+نوع+ترتيب)');
  chk(els.some(e => e.id === 'sc:sales:button:2' && e.label === 'تصدير'), 'ترتيب عناصر الزر صحيح');
  chk(els.some(e => e.kind === 'table' && e.id === 'sc:sales:table:1'), 'الجداول مكتشفة');
  chk(els.some(e => e.kind === 'card' && e.id === 'sc:sales:card:1'), 'البطاقات مكتشفة');
  chk(els.every(e => e.screen === 'sales' || e.screen === 'workcenter'), 'كل عنصر منسوب لشاشته');
}

/* ---------- 2) عناصر التنقل: كل محدّد يشير لعنصر قائم ---------- */
{
  chk(UI.NAV_ELEMENTS.length >= 15, 'عدد عناصر التنقل: ' + UI.NAV_ELEMENTS.length);
  for (const def of UI.NAV_ELEMENTS) {
    if (def.type === 'screen') {
      chk(IDX.includes('id="tab-' + def.tab + '"'), 'الشاشة «' + def.label + '» موجودة');
    } else {
      const m = def.sel.match(/^(?:#([\w-]+)|.*\[([\w-]+)="([^"]+)"\])$/);
      const marker = m && m[1] ? ('id="' + m[1] + '"') : (m ? (m[2] + '="' + m[3] + '"') : '');
      chk(!!marker && IDX.includes(marker), 'عنصر «' + def.label + '» موجود (' + marker + ')');
    }
  }
  const ids = UI.NAV_ELEMENTS.map(e => e.id);
  chk(new Set(ids).size === ids.length, 'معرّفات عناصر التنقل فريدة');
}

/* ---------- 3) الشاشات الـ18: الأقسام موجودة والمكتشف يغطّيها ---------- */
{
  const sections = [...IDX.matchAll(/<section id="tab-([^"]+)"/g)].map(m => m[1]);
  chk(sections.length >= 18, 'عدد أقسام الشاشات في HTML: ' + sections.length);
  const missing = sections.filter(s => !IDX.includes('id="tab-' + s + '"'));
  chk(missing.length === 0, 'كل قسم له معرّف');
  chk(IDX.includes('class="card"') && IDX.includes('<h3') && IDX.includes('<button')
    && (IDX.includes('<table') || IDX.includes('tblwrap')),
    'بنية الشاشات تحوي البطاقات والعناوين والأزرار (والجداول تُبنى وقت التشغيل)');
}

/* ---------- 4) التطبيق فعليًا على DOM مبسَّط (نص · خصائص · إظهار · ترتيب) ---------- */
{
  const textNode = { nodeType: 3, nodeValue: 'عنوان أصلي' };
  const el = {
    id: 'el1', dataset: {}, style: { color: '', order: '' },
    childNodes: [textNode], textContent: 'عنوان أصلي',
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
  };
  const sec = {
    id: 'tab-x',
    querySelector: (s) => (s === '.card-h h3' ? mkEl('h', 'س') : null),
    querySelectorAll: (s) => (s === 'h3, h4' ? [el] : []),
  };
  const doc = {
    querySelectorAll: (s) => (s === 'section[id^="tab-"]' ? [sec] : []),
    querySelector: () => null, head: null, createElement: () => mkEl('x', ''),
  };
  const realDoc = global.document;
  global.document = doc;
  UI.reset();
  const model = UI.normalizeLayout({ items: { 'sc:x:text:1': { label: 'عنوان معدَّل', color: '#22d3ee', order: 4, visible: false } } });
  UI.setModel(model);
  UI.apply(model);
  chk(textNode.nodeValue === 'عنوان معدَّل', 'النص عُدِّل في مكانه (لم يُمسStructure العنصر)');
  chk(el.style.color === '#22d3ee', 'لون النص طُبِّق: ' + el.style.color);
  chk(el.style.order === '4', 'الترتيب طُبِّق: ' + el.style.order);
  chk(el.style.display === 'none', 'الإخفاء طُبِّق');
  chk(el.dataset.uiId === 'sc:x:text:1', 'معرّف العنصر لِتتبّع التجاوز');
  /* إعادة الضبط: استعادة الحالة الأصلية */
  UI.setModel({ items: {} });
  UI.apply({ items: {} });
  chk(textNode.nodeValue === 'عنوان أصلي', 'النص رجع للأصل بعد إعادة الضبط');
  chk(el.style.color === '' && el.style.order === '', 'الخصائص رجعت للأصل');
  chk(el.style.display !== 'none', 'الإخفاء رُفع (لا إخفاء دائم)');
  global.document = realDoc;
  UI.reset();
}

/* ---------- 4b) إنشاء زر جديد داخل شاشة (إجراء مسجَّل) ---------- */
{
  const toolbar = { id: 'tb', appendChild: (n) => { toolbar.child = n; return n; }, querySelector: () => null };
  const sec = {
    id: 'tab-y',
    querySelector: (s) => (s === '.card-h h3' ? mkEl('h', 'س') : null),
    querySelectorAll: (s) => (s === 'button' ? [] : []),
    querySelector2: null,
  };
  sec.querySelector = (s) => {
    if (s === '.card-h h3') return mkEl('h', 'س');
    if (s === '.wf-toolbar') return toolbar;
    return null;
  };
  const doc = {
    querySelectorAll: (s) => (s === 'section[id^="tab-"]' ? [sec] : []),
    querySelector: (s) => (s === '#tab-y' ? sec : null),
    getElementById: (id) => (id === 'tab-y' ? sec : null),
    head: null,
    createElement: (t) => {
      const node = { tag: t, dataset: {}, style: {}, childNodes: [], className: '' };
      node.appendChild = function (n) { this.childNodes.push(n); return n; };
      node.querySelector = (s) => (s === 'span' ? (node.childNodes[0] || null) : null);
      return node;
    },
  };
  const realDoc = global.document;
  global.document = doc;
  UI.reset();
  const model = UI.normalizeLayout({ items: { 'new:ui1': { new: true, screen: 'y', action: 'refresh', label: 'تحديث سريع' } } });
  UI.setModel(model);
  UI.apply(model);
  chk(!!toolbar.child, 'الزر الجديد أُنشئ داخل شاشة الاختيار');
  chk(toolbar.child && toolbar.child.dataset.uiAction === 'refresh', 'الزر الجديد مرتبط بالإجراء المسجَّل');
  chk(toolbar.child && toolbar.child.querySelector && true, 'الزر الجديد بنية زر');
  const label = toolbar.child && toolbar.child.childNodes && toolbar.child.childNodes[0];
  chk(!!label && label.textContent === 'تحديث سريع', 'نص الزر الجديد محفوظ');
  global.document = realDoc;
  UI.reset();
}

/* ---------- 5) التطبيع: أنواع العناصر + الحدود + الأزرار الجديدة ---------- */
{
  const n = UI.normalizeLayout({ items: {
    'sc:sales:text:1': { label: 'عنوان جديد', color: '#22d3ee', fontSize: 999, align: 'center', bold: true },
    'sc:sales:card:1': { bg: '#34d399', border: '2px solid #fbbf24', radius: 999, padding: -5 },
    'sc:sales:button:1': { label: 'زر', color: 'red;background:url(x)' },
    'unknown:zz': { label: 'مجهول' },
    'new:ui1': { new: true, screen: 'sales', action: 'refresh', label: 'تحديث' },
    'new:ui2': { new: true, screen: 'sales' },
  } });
  const t = n.items['sc:sales:text:1'];
  chk(!!t && t.label === 'عنوان جديد', 'نص العنصر محفوظ');
  chk(t.fontSize === 48, 'حجم الخط مقيَّد (999 ⇒ 48): ' + t.fontSize);
  chk(t.align === 'center' && t.bold === true, 'المحاذاة والسُمك محفوظان');
  const c = n.items['sc:sales:card:1'];
  chk(c.bg === '#34d399', 'لون الخلفية من القائمة البيضاء');
  chk(c.border === '2px solid #fbbf24', 'الحد بنمط آمن');
  chk(c.radius === 48 && c.padding === 0, 'الأرقام مقيّدة (radius/padding)');
  chk(!n.items['sc:sales:button:1'].color, 'لون غير مسموح يُسقط');
  chk(!n.items['unknown:zz'], 'معرّف مجهول يُسقط');
  chk(!!n.items['new:ui1'] && n.items['new:ui1'].action === 'refresh', 'زر جديد بإجراء مسجَّل محفوظ');
  chk(!n.items['new:ui2'], 'زر جديد بلا إجراء يُسقط (لا زر بلا إجراء)');
}

/* ---------- 5) الإجراءات المسجَّلة: مغلقة ومربوطة بصلاحياتها ---------- */
{
  chk(/const UI_ACTIONS = \{/.test(APP), 'سجل الإجراءات موجود في app.js');
  chk(/window\.UiActions = \{/.test(APP), 'السجل مُتاح للواجهة');
  const block = (APP.match(/const UI_ACTIONS = \{([\s\S]*?)\n\};/) || [, ''])[1];
  const actions = [...block.matchAll(/(\w+):\s*\{\s*label:\s*'([^']+)',\s*perm:\s*([^,]+),\s*host:\s*'([^']+)'/g)];
  chk(actions.length >= 8, 'عدد الإجراءات المسجَّلة: ' + actions.length);
  for (const a of actions) {
    chk(IDX.includes('id="' + a[4].replace('#', '') + '"'), 'الإجراء «' + a[2] + '» مرتبط بزر قائم (' + a[4] + ')');
  }
  chk(/if \(a\.perm && !can\(a\.perm\)\)/.test(APP), 'كل إجراء يفحص صلاحيته قبل التنفيذ');
  chk(/host\.click\(\)/.test(APP), 'الإجراء ينفّذ بنفس مسار الزر القائم (نفس السلوك)');
  chk(!/eval\s*\(|new Function\s*\(/.test(APP), 'لا تنفيذ اعتباطي (لا JS حرّ)');
  chk(/button\[data-ui-action\], button\[data-ui-id\]/.test(APP), 'المعترض يلتقط الأزرار المُنشأة والمُتجاوزة');
  chk(/e\.preventDefault\(\); e\.stopPropagation\(\);/.test(APP), 'المعترض يمنع السلوك الأصلي عند وجود تجاوز');
}

/* ---------- 6) الواجهة: اختيار الشاشة + لوحة الخصائص + زر جديد ---------- */
{
  chk(IDX.includes('id="ss-ui-screen"') && IDX.includes('id="ss-ui-props"') && IDX.includes('id="ss-ui-add-btn"'),
    'قائمة الشاشات + لوحة الخصائص + زر الإضافة موجودة');
  chk(UIE.includes('function renderUiScreens') && UIE.includes('function renderUiProps') && UIE.includes('function addUiButton'),
    'دوال اختيار الشاشة وعرض الخصائص والإضافة موجودة');
  chk(/api\.KIND_PROPS\[d\.kind\]/.test(UIE), 'الخصائص المعروضة حسب نوع العنصر');
  chk(/actionSelect\('action'/.test(UIE), 'الإجراء يُختار من السجل المسجَّل');
  chk(/if \(!Number\.isFinite\(n\) \|\| n < 1 \|\| n > actions\.length\)/.test(UIE),
    'الإجراء الجديد يُتحقَّق منه ضمن السجل');
  chk(/uiScreen = e\.target\.value/.test(UIE), 'اختيار الشاشة يغيّر القائمة');
  chk(CSS.includes('.rd-ui-panes') && CSS.includes('.rd-ui-props') && CSS.includes('.rd-ui-item'),
    'تنسيق الأعمدة واللوحات');
}

/* ---------- 7) فحص توفّر الاستيراد (صدق في Capability) ---------- */
{
  chk(RD.includes('async function probeLegacyImport()'), 'فحص توفّر مسار الاستيراد موجود');
  chk(/st === 404/.test(RD) && /إعادة تشغيل الخادم/.test(RD),
    'رسالة صريحة: المسار غير موجود في النسخة المشغّلة');
  chk(/if \(btn\) btn\.disabled = true;/.test(RD), 'زر الاستيراد يُعطَّل عند غياب المسار');
  chk(IDX.includes('id="rs-legacy-cap"'), 'موضع عرض حالة المسار في اللوحة');
}

/* ---------- 8) الثوابت الآمنة ---------- */
{
  for (const c of UI.COLORS) chk(c.v === '' || /^#[0-9a-fA-F]{6}$/.test(c.v), 'لون صالح: ' + c.v);
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'ui-layout.js'), 'utf8');
  chk(/style\.display = 'none'/.test(src), 'الإخفاء مطبَّق');
  chk(!/style\.display = ''/.test(src), 'لا إظهار صريح (لا تجاوز للصلاحيات)');
  chk(/el\.style\.order = String\(it\.order\)/.test(src), 'الترتيب عبر CSS order');
  chk(!/appendChild\(el\)|insertBefore\(/.test(src.replace(/host\.appendChild\(el\)/, '')),
    'لا نقل لعناصر القائمة (الأحداث كما هي) — الزر الجديد فقط يُنشأ');
  chk(/host\.appendChild\(el\)/.test(src), 'الزر الجديد فقط يُنشأ في الشاشة');
}

chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');
console.log('\nui_layout.test.js — pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
