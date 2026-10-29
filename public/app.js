'use strict';
/* واجهة النظام — تحميل البيانات من API وعرضها */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({ ok: false, error: 'استجابة غير صالحة' }));
  if (!j.ok) {
    if (r.status === 401) {
      const isTestUser = !!(me && me.id === 0 && me.username === 'workflow-test');
      if (!opts.quiet401 && !isTestUser) { me = null; applyRoleUI(); enterLogin(j.message || 'انتهى الجلسة — سجّل الدخول'); }
      const err = new Error(j.message || j.error || 'انتهى الجلسة');
      err.status = 401; err.data = j;
      throw err;
    }
    if (r.status === 403 && !opts.quiet403) toast(j.message || 'لا تملك صلاحية تنفيذ هذه العملية');
    /* 404 من الراوتر (المسار غير موجود أصلًا في النسخة المشغّلة) ⇒ رسالة قابلة للتنفيذ */
    if (r.status === 404 && /^\s*not found\s*$/i.test(String(j.error || j.message || ''))) {
      const err = new Error('المسار غير موجود في الخادم المشغّل — أعد تشغيل الخادم ليُحمّل الكود الجديد');
      err.status = 404; err.data = j;
      throw err;
    }
    const err = new Error(j.message || j.error || 'خطأ');
    err.status = r.status; err.data = j;
    throw err;
  }
  return j.data;
}
const hdr = { 'Content-Type': 'application/json' };

/* ---- أدوات الفلاتر المشتركة ---- */
/* يجمع قيم حقول الفلاتر في استعلام URL
   plain: { اسم المعامل: id } قيمة مفردة.
   range: { اسم المعامل: [idمن, idإلى] } نطاق قيم → اسم_from / اسم_to.
   ملاحظة: الـ ids تُمرَّر عارية بلا «#» — نجلبها بـ getElementById لا querySelector */
function filterQS(plain = {}, range = {}) {
  const p = new URLSearchParams();
  const val = id => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
  for (const [k, id] of Object.entries(plain)) { const v = val(id); if (v) p.set(k, v); }
  for (const [k, pair] of Object.entries(range)) {
    const fv = val(pair[0]), tv = val(pair[1]);
    if (fv) p.set(k + '_from', fv);
    if (tv) p.set(k + '_to', tv);
  }
  const s = p.toString();
  return s ? '?' + s : '';
}
/* يلحق استعلام الفلاتر بمسار له معاملات أصلية أو لا */
const appendQ = (base, qs) => qs ? base + (base.includes('?') ? '&' : '?') + qs.slice(1) : base;

/* ================= قائمة الأصناف الأساسية الموحدة =================
   مصدر واحد لكل الشاشات: جدول الأصناف الأساسية (كود 9 خانات).
   القيمة المُخزَّنة والمُرسلة للخادم دائماً هي **كود الصنف** —
   الربط مع عقود الاستيراد وحركات/مبيعات/تصديرات السيستم كله بهذا الكود. */
let ITEMS_ALL = null;
let ITEMS_HTML = '';
const ITEMS_BY_CODE = new Map();
async function loadItemsAll(opts) {
  const q = (opts && opts.quiet401) ? { quiet401: true } : {};
  if (ITEMS_ALL && !force && !(opts && opts.force)) return ITEMS_ALL;
  ITEMS_ALL = await api('/api/items/all?limit=20000', q);
  ITEMS_HTML = ITEMS_ALL.map(i =>
    `<option value="${escHtml(i.code)}">${escHtml(i.code)} — ${escHtml(i.descr)}${i.uom ? ' (' + escHtml(i.uom) + ')' : ''}</option>`
  ).join('');
  ITEMS_BY_CODE.clear();
  ITEMS_ALL.forEach(i => ITEMS_BY_CODE.set(String(i.code), i));
  return ITEMS_ALL;
}

/* ================= مراجع عقود الاستيراد (موردين/مصادر/موانئ) =================
   مصدر قوائم النماذج المنسدلة في عقود الاستيراد — تُدار من شاشة «مراجع العقود». */
let REFS = null;   /* { supplier:[{code,name}], source:[…], arrival_port:[…], loading_port:[…] } */
async function loadRefs(force) {
  if (REFS && !force) return REFS;
  try {
    const refs = await api('/api/contracts/refs');
    /* تحميل العقود من جدول التسجيل كمرجع موحد للرقم الداخلى */
    try {
      const conData = await api('/api/report?name=contract-registrations-raw&page=1&pageSize=5000');
      refs.contract_registrations = ((conData && conData.rows) || []).map(r => ({
        code: String(r.internal_no || r.id || ''),
        name: String(r.internal_no || '').trim() || String(r.id || ''),
      })).filter(r => r.code && r.name);
    } catch (_) { refs.contract_registrations = []; }
    REFS = refs;
  }
  catch (_) { REFS = { supplier: [], source: [], arrival_port: [], loading_port: [], contract_registrations: [] }; }
  return REFS;
}
/* يملأ <select> مرجعي بالاسم (القيمة المخزَّنة) مع عرض «الكود — الاسم»،
   ويُبقي قيمة قديمة غير موجودة في القائمة حتى لا تُفقد عند التعديل. */
function fillRefSelect(el, kind, value) {
  if (!el) return;
  const list = (REFS && REFS[kind]) || [];
  const cur = value != null ? String(value) : String(el.value || '');
  el.innerHTML = '<option value=""></option>' + list.map(r =>
    `<option value="${escHtml(r.name)}">${escHtml(r.code)} — ${escHtml(r.name)}</option>`).join('');
  if (cur && !list.some(r => String(r.name) === cur))
    el.insertAdjacentHTML('beforeend', `<option value="${escHtml(cur)}">${escHtml(cur)}</option>`);
  el.value = cur;
}
/* تعبئة قائمة اختيار شركة من شاشة البيانات الأساسية (القيمة = اسم الشركة لتوافق البيانات القديمة) */
function fillContractCompanySelect(el, value) {
  if (!el) return;
  const list = (mdLoc && Array.isArray(mdLoc.companies)) ? mdLoc.companies : [];
  const cur = value != null && value !== '' ? String(value) : String(el.value || '');
  el.innerHTML = '<option value=""></option>' + list.map(c =>
    `<option value="${escHtml(c.code)}">${escHtml(c.code)} — ${escHtml(c.name)}</option>`).join('');
  if (cur && !list.some(c => String(c.code) === cur))
    el.insertAdjacentHTML('beforeend', `<option value="${escHtml(cur)}">${escHtml(cur)}</option>`);
  el.value = cur;
  el.dataset.pv = cur;
}

/* عرض الصنف: «كود • اسم» من الكاش — أو النص كما هو إن لم يوجد في الأساسية */
const itemDisp = code => {
  const i = ITEMS_BY_CODE.get(String(code || ''));
  return i ? `${code} • ${i.descr}` : String(code || '—');
};
/* تعبئة قائمة اختيار صنف من القائمة الموحدة (تحافظ على الاختيار الحالي) */
async function fillItemSelect(sel, first = 'الكل', value) {
  if (!sel) return;
  const cur = sel.dataset.pv != null && sel.dataset.pv !== '' ? sel.dataset.pv
    : (value !== undefined && value !== null ? String(value) : String(sel.value || ''));
  try { await loadItemsAll(); } catch (e) { return; }
  sel.innerHTML = `<option value="">${escHtml(first)}</option>` + ITEMS_HTML;
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}
/* يملأ زوج قوائم «من / إلى» بنفس القيم المميزة مع الحفاظ على الاختيار الحالي */
async function fillDimPair(id, idTo, url) {
  const vals = await api(url).catch(() => []);
  const opts = vals.map(v => `<option value="${escHtml(v)}">${escHtml(v)}</option>`).join('');
  const norm = s => (s && s.charAt(0) === '#' ? s : '#' + s);   // querySelector يحتاج «#»
  const set = (sel, first) => {
    const el = $(norm(sel)); if (!el) return;
    const cur = el.value;
    el.innerHTML = `<option value="">${first}</option>` + opts;
    el.value = cur;
  };
  set(id, 'من…'); set(idTo, 'إلى…');
}
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}
const n0 = v => (v === null || v === undefined || isNaN(v)) ? '—'
  : new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v);
const n2 = v => (v === null || v === undefined || isNaN(v)) ? '—'
  : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v);
const money = v => (v === null || v === undefined || isNaN(v)) ? '—' : n0(v);
const pct = v => (v === null || v === undefined || isNaN(v)) ? '—' : n2(v) + '%';
const dv = v => (Number(v) || 0) < 0 ? 'neg' : '';

/* عنوان الشاشة: تجاوز طبقة التخطيط (مصمم الشاشات والقوائم) ثم الخريطة الافتراضية */
const titleFor = name => {
  const ov = (window.UiLayout && window.UiLayout.titleFor) ? window.UiLayout.titleFor(name) : '';
  if (ov) return [ov, ''];
  if (TITLES[name]) return TITLES[name];
  /* شاشة مخصّصة: اسمها من سجل الشاشات المخصّصة */
  if (window.AppScreens && typeof window.AppScreens.list === 'function') {
    const hit = window.AppScreens.list().find(s => s.id === name);
    if (hit) return [hit.name || name, 'شاشة مخصّصة'];
  }
  return [name, ''];
};
const TITLES = {
  platform: ['منصة التحليل', 'ثلاثة أقسام: البيانات والتحليل · التقارير ولوحات المعلومات · تصميم الشاشات والتحكم'],
  dashboard: ['لوحة التحكم', 'إدارة المستخدمين وصلاحيات الشاشات'],
  md: ['البيانات الأساسية', 'الأصناف • المواقع والمصانع • أنواع الحركات'],
  daily: ['البيانات اليومية', 'حركات سيستم • مبيعات • أرصدة — ملفات باسم التاريخ'],
  pricegroup: ['الأسعار اليومية', 'متابعة البورصة • أسعار السوق • تكلفة يومية'],
  'md-items': ['الأصناف الأساسية', 'كود واسم ووحدة + المجموعات والتصنيفات — جلب تلقائي من الحركات'],
  'md-locations': ['المواقع والمصانع', 'الشركة ← الوحدة ← المخزن + المكان'],
  'md-movetypes': ['أنواع الحركات', 'النوع والوصف + وصف السيستم والتصنيف'],
  'md-contractrefs': ['مراجع العقود', 'الموردين • المصادر • موانئ الوصول • موانئ التحميل'],
  inventory: ['المخزون والمطابقة', 'الأرصدة مقابل الحركات — افتتاحي + وارد − صادر = ختامي'],
  sales: ['المبيعات والربحية', 'الإيراد والتكلفة ومجمل الربح حسب المكان والصنف'],
  movements: ['الحركات', 'الوارد والصادر واتجاهات الترحيل'],
  borse: ['البورصة اليومية', 'أسعار الذرة والصويا والبذرة وريت الدولار — تسجيل يومي'],
  prices: ['الأسعار اليومية', 'أربع قيم لكل صنف/يوم: تكلفة وسوق — أرضه ووصال'],
  costs: ['التكلفة اليومية', '3 أصناف بورصة بالمعادلة + قيمة الرصيد ÷ كمية الرصيد للباقي — تفصيلي وإجمالي'],
  contracts: ['عقود الاستيراد', 'التسجيل • تفصيلى • السداد • التحميل • الربط • الترويل • الافراج'],
  reports: ['التقارير', 'عرض التقارير داخل المتصفح وتصديرها CSV'],
  workflow: ['البيانات والتحليل', 'المعادلات وبناء التحليل والنتائج المحفوظة (قسم داخل البيانات والتحليل)'],
  analysis: ['البيانات والتحليل', 'المصادر والجداول · العلاقات · المعادلات · بناء التحليل · النتائج'],

  'report-studio': ['التقارير ولوحات المعلومات', 'جميع التقارير · مصمّم التقارير · التقارير المحفوظة'],
  'screen-studio': ['تصميم الشاشات والتحكم', 'شاشات مخصّصة · تحرير عناصر شاشات التطبيق والتحكّم في الواجهة'],
};

function kpi(host, { label, value, sub, tone, icon = '◈', g = 'g1', topTitle = false, pin = false }) {
  const d = document.createElement('div');
  d.className = 'card kpi ' + g + (tone ? ' ' + tone : '');
  const pinHtml = pin ? '<button class="kpi-pin" type="button" title="تثبيت">📌</button>' : '';
  const topLabelHtml = topTitle ? `<div class="kpi-toplabel">${label}</div>` : '';
  d.innerHTML =
    `<div class="top">${pinHtml}${topLabelHtml}<div class="ico">${icon}</div></div>` +
    (topTitle ? '' : `<div class="label">${label}</div>`) +
    `<div class="value">0</div>` +
    (sub ? `<div class="delta">${sub}</div>` : '');
  host.appendChild(d);
  animateNum(d.querySelector('.value'), value);
}

/** عدّاد تصاعدي مطابق لصيغة الأرقام */
function animateNum(el, text) {
  const raw = String(text === null || text === undefined ? '' : text).trim();
  const clean = raw.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(clean)) { el.textContent = raw; return; }
  const target = Number(clean);
  const dec = (clean.split('.')[1] || '').length;
  const fmt = v => new Intl.NumberFormat('en-US', { maximumFractionDigits: dec, minimumFractionDigits: dec }).format(v);
  const t0 = performance.now(), dur = 850;
  const step = t => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(target * e);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------------- التبويبات ---------------- */
let current = 'dashboard';
const loaders = {};

/* الأقسام: زر واحد في القايمة الجانبية «مثل البيانات الأساسية» وجواه عدة شاشات فرعية */
/* هوية الأقسام الثلاثة لمنصة التحليل + خريطة الدمج (تبويبات قديمة دُمجت) */
const PLATFORM_HOST = { 'workcenter': 'analysis', 'workflow': 'analysis', 'reports-manager': 'report-studio' };
const PLATFORM_SCREENS = ['analysis', 'report-studio', 'screen-studio'];
/* أي تبويب (قديم أو جديد) ⇒ الشاشة المضيفة في المنصة */
const platformHost = t => PLATFORM_HOST[t] || t;
/* «منصة التحليل» صفحة رئيسية تجميعية: تُتاح لمن يملك أي شاشة من شاشاتها الثلاث */
const PLATFORM_HOME = 'platform';
const isPlatformHome = t => t === PLATFORM_HOME;

const MD_GROUPS = {
  md:     { title: 'البيانات الأساسية', crumb: 'الأصناف • المواقع والمصانع • أنواع الحركات • الموردين • المصادر • موانئ الوصول • موانئ التحميل',
            subs: ['md-items', 'md-locations', 'md-movetypes', 'md-contractrefs'] },
  daily:  { title: 'تسجيل البيانات',  crumb: 'بيانات يومية • أسعار وتكلفة • عقود الاستيراد',
            subs: ['movements', 'sales', 'inventory'] },
  pricegroup: { title: 'الأسعار والتكلفة', crumb: 'بورصة يومية • أسعار يومية • تكلفة يومية',
            subs: ['borse', 'prices', 'costs'] },
  contracts: { title: 'عقود الاستيراد', crumb: 'التسجيل • تفصيلى • السداد • التحميل • الربط • الترويل • الافراج',
               subs: ['contracts'] },
};
/* عنوان الصفحة (topbar محذوف — الدالة آمنة عند غياب العنصر) */
const setHead = (t, c) => {
  const h = document.getElementById('page-title'); if (h) h.textContent = t || '';
  const m = document.getElementById('page-crumb'); if (m) m.textContent = c || '';
};
/* المدير يملك كل الشاشات (نفس قاعدة الخادم tabsOfUser) — فلا تُحجب عنه أي شاشة،
   حتى لو كانت قائمة التبويبات المحمّلة أقدم من الكود (قبل إعادة تشغيل الخادم) */
const isAdmin = () => !!(me && me.role === 'admin');
const tabAllowed = t => t === PLATFORM_HOME
  ? PLATFORM_SCREENS.some(x => tabAllowed(x))
  : (isAdmin()
    || !(me && Array.isArray(me.tabs) && me.tabs.length)
    || me.tabs.includes(t)
    || me.tabs.includes(platformHost(t)));
const mdSubsAllowed = id => {
  const g = MD_GROUPS[id];
  if (!g) return [];
  return g.subs.filter(t => tabAllowed(t));
};
/* القوائم المنسدلة في الشريط العلوي: كل زر قسم يفتح بنوده مباشرة بلا صفحة وسيطة.
   daily تجمع شاشات daily + pricegroup (الأسعار مدمجة مع البيانات اليومية) */
const DROP_SUBS = {
  md: [...MD_GROUPS.md.subs],
  /* «تسجيل البيانات» تحوي: بيانات يومية + أسعار وتكلفة + عقود الاستيراد */
  daily: [...MD_GROUPS.daily.subs, ...MD_GROUPS.pricegroup.subs, ...MD_GROUPS.contracts.subs],
  pricing: [...MD_GROUPS.pricegroup.subs],
  contracts: [...MD_GROUPS.contracts.subs],
  info: ['analysis', 'report-studio', 'reports'],
  /* «منصة التحليل»: مساحات العمل (مركز العمل · التحليل · المستكشف · التصميم · التقارير · مصمم الشاشات) */
  platform: ['analysis', 'report-studio', 'screen-studio'],
  /* «الشاشات المخصّصة»: تُملأ وقت التشغيل من الشاشات المحفوظة */
  custom: [],
};
const dropAllowed = g => (g === 'daily'
  ? [...mdSubsAllowed('daily'), ...mdSubsAllowed('pricegroup'), ...mdSubsAllowed('contracts')]
  : g === 'pricing' ? mdSubsAllowed('pricegroup')
  : g === 'info' ? ['analysis', 'report-studio', 'reports'].filter(t => tabAllowed(t))
  : g === 'platform' ? PLATFORM_SCREENS.filter(t => tabAllowed(t))
  : g === 'custom' ? (DROP_SUBS.custom || []).filter(t => tabAllowed(t))
  : mdSubsAllowed(g));
const dropBtnSel = g => (g === 'md' ? '#nav-md-btn' : g === 'contracts' ? '#nav-daily-btn' : g === 'pricing' ? '#nav-daily-btn' : g === 'info' ? '#nav-info-btn' : g === 'platform' ? '#nav-platform-btn' : '#nav-daily-btn');
const dropMenuEl = g => (g === 'md' ? $('#nav-md-menu') : g === 'info' ? $('#nav-info-menu') : g === 'platform' ? $('#nav-platform-menu') : $('#nav-daily-menu'));
function toggleNavMenu(g, force) {
  const m = dropMenuEl(g); if (!m) return;
  const show = force !== undefined ? !!force : m.hidden;
  closeNavMenus(show ? m : null);
  syncDropOpen();
  if (!show) return;
  const btn = document.querySelector(dropBtnSel(g));
  if (btn) {
    const r = btn.getBoundingClientRect();
    m.style.top = Math.round(r.bottom + 8) + 'px';
    m.style.left = 'auto';
    m.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
  }
  m.hidden = false;
  syncDropOpen();
}
function syncDropOpen() {
  $$('.nav-drop').forEach(d => {
    const menu = d.querySelector('.nav-menu');
    d.classList.toggle('open', !!(menu && !menu.hidden));
  });
}
function closeNavMenus(except) {
  $$('.nav-menu').forEach(m => { if (m !== except) m.hidden = true; });
  $$('nav [data-rep-grp]').forEach(x => { if (except && except.id === 'nav-rep-sub') return; x.classList.remove('on'); });
  $$('nav [data-submenu]').forEach(x => { if (except && except.id === x.dataset.submenu) return; x.classList.remove('on'); });
  syncDropOpen();
}
/* انتقال مباشر لشاشة فرعية من القائمة المنسدلة — بلا صفحة وسيطة */
function gotoGroupSub(g, name, panel) {
  if (!(DROP_SUBS[g] || []).includes(name) || !dropAllowed(g).includes(name)) {
    toast('هذه الشاشة غير مسموحة لدورك'); return;
  }
  closeNavMenus();
  $$('nav button').forEach(x => x.classList.remove('active'));
  document.querySelector(dropBtnSel(g))?.classList.add('active');
  $$('section').forEach(s => s.classList.remove('active'));
  const sec = $('#tab-' + name);
  if (!sec) { toast('الشاشة غير مبنية بعد — أعد تحميل الصفحة'); return; }
  sec.classList.add('active');
  const t = titleFor(name);
  setHead(t[0], '');
  rememberScreen(name);
  loadTab(name).catch(e => toast('خطأ: ' + e.message));
  if (panel && window.PlatformShell && typeof window.PlatformShell.show === 'function') {
    try { window.PlatformShell.show(name, panel); } catch (_) {}
  }
}
document.addEventListener('click', e => {
  if (e.target.closest('.nav-drop')) return;
  closeNavMenus();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNavMenus(); });
function showMdLanding(id) {
  const g = MD_GROUPS[id];
  if (!g) return;
  const allowed = mdSubsAllowed(id);
  if (!allowed.length) {
    toast('هذا القسم غير مسموح لدورك');
    const alt = me && Array.isArray(me.tabs) && me.tabs[0] && me.tabs[0] !== id ? me.tabs[0] : null;
    if (alt) goTab(alt);
    return;
  }
  $$('section').forEach(s => s.classList.remove('active'));
  if (!document.getElementById('tab-' + id)) {
    /* صفحة البلاطات محذوفة (daily) → أول شاشة مسموحة من القائمة المنسدلة مباشرة */
    const grp = id === 'pricegroup' ? 'pricing' : id;
    const order = (typeof DROP_SUBS !== 'undefined' && DROP_SUBS[grp]) || g.subs;
    const all = grp === 'daily'
      ? [...mdSubsAllowed('daily'), ...mdSubsAllowed('pricegroup')]
      : allowed;
    const first = order.find(s => all.includes(s)) || all[0];
    if (first && typeof gotoGroupSub === 'function') gotoGroupSub(grp, first);
    return;
  }
  $('#tab-' + id).classList.add('active');
  setHead(g.title, g.crumb);
  $('#sidebar').classList.remove('open');
  $$('#tab-' + id + ' [data-sub]').forEach(btn => vis(btn, allowed.includes(btn.dataset.sub)));
  if (id === 'contracts') {
    /* الحالة الافتراضية «نشط» على كل خطوات العقود */
    const cst = document.getElementById('con-status');
    if (cst) cst.value = 'ACTIVE';
    showConStep(conView);
  }
}
/* أزرار الشاشات الفرعية داخل الأقسام */
Object.keys(MD_GROUPS).forEach(id => {
  $$('#tab-' + id + ' [data-sub]').forEach(b => {
    b.addEventListener('click', () => {
      const name = b.dataset.sub;
      if (!mdSubsAllowed(id).includes(name)) { toast('هذه الشاشة غير مسموحة لدورك'); return; }
      $$('section').forEach(s => s.classList.remove('active'));
      $('#tab-' + name).classList.add('active');
      const t = TITLES[name] || [name, ''];
      setHead(t[0], '');
      $('#sidebar').classList.remove('open');
      rememberScreen(name);
      loadTab(name).catch(e => toast('خطأ: ' + e.message));
    });
  });
});
/* مسح فلاتر الأعمدة في جدول — نفس منطق زر «مسح الفلاتر» داخل شريط الجدول */
function clearTableFilters(sel) {
  const host = typeof sel === 'string' ? $(sel) : sel;
  if (!host || !host.__filters) return;
  for (const k of Object.keys(host.__filters)) {
    const r = host.__filters[k];
    if (r && typeof r === 'object') { r.op = 'in'; r.set = []; r.v = ''; r.v2 = ''; }
  }
  (host.__ths || []).forEach(th => th.__sync && th.__sync());
  if (typeof tablePaint === 'function') tablePaint(host);
}
/* إرجاع حقلَي التاريخ لآخر تاريخ بيانات المجموعة (عرض يوم واحد) */
function resetDateRange(fromId, toId, group) {
  const last = lastDataDate(group);
  if (!last) return;
  const f = $(fromId), t = $(toId);
  if (f) f.value = last;
  if (t) t.value = last;
}
const blank = ids => ids.forEach(id => { const e = $('#' + id); if (e) e.value = ''; });
/* أزرار «مسح»: تفرّغ خانة البحث وكل الفلاتر — وفي الشاشات اليومية تُرجع التاريخ لآخره */
$('#md-items-clear')?.addEventListener('click', () => {
  $('#md-items-q').value = '';
  $('#md-items-origin').value = 'all';
  $('#md-items-clsstate').value = '';
  blank(['md-items-group', 'md-items-group-to', 'md-items-class', 'md-items-class-to']);
  clearTableFilters('#tbl-md-items');
  renderMdItems().catch(e => toast(e.message));
});
$('#md-loc-clear')?.addEventListener('click', () => {
  $('#md-loc-q').value = '';
  ['#tbl-md-companies', '#tbl-md-units', '#tbl-md-warehouses'].forEach(clearTableFilters);
  renderMdLocPane().catch(e => toast(e.message));
});
$('#md-mtype-clear')?.addEventListener('click', () => {
  $('#md-mtype-q').value = '';
  $('#md-mtype-dirstate').value = '';
  $('#md-mtype-cat').value = ''; $('#md-mtype-cat-to').value = '';
  clearTableFilters('#tbl-md-mtypes');
  renderMdMtypes().catch(e => toast(e.message));
});
$('#if-clear')?.addEventListener('click', () => {
  resetDateRange('#if-from', '#if-to', 'balances');
  $('#if-item').value = '';
  blank(['if-place', 'if-place-to', 'if-company', 'if-company-to', 'if-unit', 'if-unit-to', 'if-storage', 'if-storage-to']);
  clearTableFilters('#tbl-inv-detail');
  loadInventory().catch(e => toast(e.message));
});
$('#sf-clear')?.addEventListener('click', () => {
  resetDateRange('#sf-from', '#sf-to', 'sales');
  $('#sf-item').value = '';
  blank(['sf-place', 'sf-place-to', 'sf-cust', 'sf-cust-to', 'sf-unit', 'sf-unit-to', 'sf-storage', 'sf-storage-to']);
  clearTableFilters('#tbl-sal-detail');
  loadSales().catch(e => toast(e.message));
});
$('#mf-clear')?.addEventListener('click', () => {
  resetDateRange('#mf-from', '#mf-to', 'movements');
  $('#mf-item').value = '';
  blank(['mf-place', 'mf-place-to', 'mf-mtype', 'mf-mtype-to', 'mf-dir', 'mf-dir-to', 'mf-unit', 'mf-unit-to', 'mf-storage', 'mf-storage-to']);
  clearTableFilters('#mv-report');
  loadMovements().catch(e => toast(e.message));
});

/* شاشة البورصة: يمسح نطاق التاريخ (فيرجع لـ«آخر N يوم») + الصنف + فلاتر الجداول */
$('#bo-clear')?.addEventListener('click', () => {
  blank(['bo-from', 'bo-to']);
  const it = $('#borse-item'); if (it) it.value = '';
  const rg = $('#borse-range'); if (rg) { const d = [...rg.options].find(o => o.defaultSelected); if (d) rg.value = d.value; }
  clearTableFilters('#tbl-borse-latest');
  clearTableFilters('#tbl-borse');
  borseRangeHint();
  loadBorse().catch(e => toast(e.message));
});

/* ---------------- استيراد الملفات اليومية: رفع ← معاينة ← تأكيد / استبدال / حذف / بحث ---------------- */
/* الفئات التي لها «إدخال يدوي» — reload يُحدّث الشاشة بعد الحفظ/الحذف.
   البورصة والأسعار بلا ملف مصدر: إدخالهما يدوي فقط فوق الجلب الذاتي. */
const DAILY_CATS = {
  movements: { label: 'الحركات اليومية', reload: () => loadMovements() },
  sales:     { label: 'المبيعات اليومية', reload: () => loadSales() },
  balances:  { label: 'الأرصدة اليومية',  reload: () => loadInventory() },
  borse:     { label: 'البورصة اليومية',  reload: () => loadBorse() },
  prices:    { label: 'الأسعار اليومية',  reload: () => loadPrices() },
  /* عقود الاستيراد — أقسام الإدخال اليومي (لكل قسم جدوله ومفتاحه «الرقم داخلي») */
  contract_registrations: { label: 'تسجيل عقد',        reload: () => loadConView() },
  contract_details:       { label: 'تفصيلى العقد',      reload: () => loadConView() },
  contract_payments:      { label: 'السداد',            reload: () => loadConView() },
  contract_loading:       { label: 'التحميل',           reload: () => loadConView() },
  contract_hedge:         { label: 'الربط',             reload: () => loadConView() },
  contract_roll:          { label: 'الترويل',           reload: () => loadConView() },
  contract_release:       { label: 'الافراج',           reload: () => loadConView() },
};
/* الفئات التي تُدار بملفات مرفوعة (نافذة الاستيراد) — البورصة والأسعار خارجها */
const UPLOAD_CATS = ['movements', 'sales', 'balances'];
let dfCat = null;        // الفئة المفتوحة حالياً في نافذة الاستيراد
let dfBusy = false;
let dfReplacing = null;  // {file_name, file_path} عند الاستبدال
let dfStaged = null;     // {token, cat, name, as} بعد اكتمال المعاينة
let dfPendingFile = null, dfPendingName = null, dfPendingAs = null;   // آخر ملف اختير (لإعادة المعاينة بعد كلمة المرور)

const dflPill = f => f.stored
  ? '<span class="pill info">محفوظ</span>'
  : '<span class="pill">خارجي</span>';

function dflRow(f) {
  const dateTxt = f.date ? `<span class="pill warning">بتاريخ ${f.date}</span>` : '';
  const last = f.last_imported ? new Date(f.last_imported).toLocaleString() : '—';
  return `<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 6px;border-bottom:1px solid var(--line)">
    <span style="flex:1;min-width:190px">
      <b>${escHtml(f.file_name)}</b> ${dateTxt} ${dflPill(f)}
      <div class="muted xs">${n0(f.rows_total)} صف • آخر استيراد ${escHtml(last)}</div>
    </span>
    <button class="btn sm" title="اختر ملفاً جديداً ليستبدل هذا الملف وبياناته" data-rep="${escHtml(f.file)}" data-fname="${escHtml(f.file_name)}">استبدال</button>
    <button class="btn sm ghost" title="مسح صفوف هذا الملف نهائياً" data-del="${escHtml(f.file)}">حذف</button>
  </div>`;
}

async function loadDailyFiles() {
  if (!dfCat) return;
  const d = await api('/api/files/daily?cat=' + dfCat);
  const input = $('#dfl-q');
  const q = ((input && input.value) || '').trim().toLowerCase();
  const files = (d.files || []).filter(f =>
    !q
    || (f.file_name || '').toLowerCase().includes(q)
    || (f.date || '').includes(q)
    || (f.file || '').toLowerCase().includes(q)
  );
  const host = $('#tbl-dfl');
  host.innerHTML = files.length
    ? files.map(dflRow).join('')
    : '<div class="muted" style="padding:14px 6px">لا توجد ملفات مستوردة لهذه الفئة — اضغط «＋ إضافة ملف».</div>';
  $('#dfl-count').textContent = files.length + ' ملف' + (q ? ' (نتيجة البحث)' : '');
  $$('#tbl-dfl [data-rep]').forEach(b => b.addEventListener('click', () => {
    dfReplacing = { file_name: b.dataset.fname, file_path: b.dataset.rep };
    $('#dfl-file').click();
  }));
  $$('#tbl-dfl [data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('حذف هذا الملف نهائياً؟ تُمسح كل صفوفه من قاعدة البيانات.')) return;
    try {
      const r = await api('/api/files/delete', {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ cat: dfCat, file: b.dataset.del }),
      });
      toast('تم الحذف ✔ حركات ' + n0(r.movements) + ' • مبيعات ' + n0(r.sales) + ' • أرصدة ' + n0(r.balances));
      await loadDailyFiles();
      const cfg = DAILY_CATS[dfCat];
      if (cfg && cfg.reload) cfg.reload().catch(() => {});
    } catch (e) { toast('خطأ: ' + e.message); }
  }));
}

/* ============ استعراض خطوات عقود الاستيراد (قائمة منسدلة أعلى الشاشة) ============
   كل خطوة تعرض جدول تقريرها الخام (المحفوظ في قاعدة البيانات + اليدوي). الصفوف
   اليدوية قابلة للتعديل/الحذف من نفس الجدول؛ الصفوف المستوردة للقراءة فقط (وسم «ملف»). */
const CON_VIEWS = {
  contract_registrations: { report: 'contract-registrations-raw', label: 'تسجيل عقد',              add: 'تسجيل عقد جديد' },
  contract_details:       { report: 'contract-details-raw',       label: 'تفصيلى العقد / المركب',  add: 'إضافة تفصيلى / مركب' },
  contract_loading:       { report: 'contract-loading-raw',       label: 'التحميل',                add: 'إضافة تحميل' },
  contract_hedge:         { report: 'contract-hedge-raw',         label: 'الربط',                  add: 'إضافة ربط' },
  contract_roll:          { report: 'contract-roll-raw',          label: 'الترويل',                add: 'إضافة ترويل' },
  contract_release:       { report: 'contract-release-raw',       label: 'الافراج',                add: 'إضافة إفراج' },
  contract_payments:      { report: 'contract-payments-raw',      label: 'السداد',                 add: 'إضافة سداد' },
};
let conView = (() => {
  try { const s = localStorage.getItem('ccs-con-step'); return (s && CON_VIEWS[s]) ? s : 'contract_registrations'; }
  catch (_) { return 'contract_registrations'; }
})();
let conRowsById = {};

/* أعمدة الاستعراض: وسم المصدر + أعمدة الإدخال (بلا عمود الأزرار) + عمود أزرار لليدوي فقط */
function conViewCols(cat) {
  const base = (DE_COLS[cat] || []).filter(c => !c.h);
  const cols = [...base];

  if (cat === 'contract_registrations') {
    cols.push({ t: 'التفاصيل', h: true, f: r => '<button class="btn sm" data-con-open-detail="' + escHtml(r.id) + '">فتح التفاصيل</button>' });
  }
  cols.push({ t: '', h: true, f: r => deActions(r.id) });
  return cols;
}

let conSelectedNo = '';
let conDetailRowsById = {};
function openContractDetails(no) {
  no = String(no || '').trim();
  if (!no) { toast('لا يوجد رقم داخلي للعقد'); return; }
  conSelectedNo = no;
  const panel = document.getElementById('con-detail-panel');
  if (panel) panel.hidden = false;
  const t = document.getElementById('con-detail-no');
  if (t) t.textContent = '— ' + no;
  loadContractDetails().catch(e => toast(e.message));
}
async function loadContractDetails() {
  const host = document.getElementById('tbl-con-detail');
  if (!host) return;
  host.innerHTML = '<div class="muted" style="padding:12px"></div>';
  const c = document.getElementById('con-detail-count');
  if (c) c.textContent = '';
  try {
    const d = await api('/api/report?name=contract-details-raw&page=1&pageSize=5000');
    const rows = ((d && d.rows) || []).filter(r => String(r.internal_no) === String(conSelectedNo));
    conDetailRowsById = {};
    rows.forEach(r => { conDetailRowsById[String(r.id)] = r; });
    table(host, DE_COLS.contract_details, rows, { limit: 0, empty: 'لا توجد تفاصيل لهذا العقد' });
    $$('#tbl-con-detail [data-de-edit]').forEach(b => b.addEventListener('click', () => {
      const row = conDetailRowsById[b.dataset.deEdit];
      if (!row) return;
      openManual('contract_details');
      setTimeout(() => { deFill(row); }, 0);
    }));
    $$('#tbl-con-detail [data-de-del]').forEach(b =>
      b.addEventListener('click', () => deDelete(b.dataset.deDel, 'contract_details')));
    if (c) c.textContent = rows.length + ' تفصيلى';
  } catch (e) {
    host.innerHTML = '<div class="muted" style="padding:12px">' + escHtml(e.message) + '</div>';
  }
}
function closeContractDetails() {
  conSelectedNo = '';
  const panel = document.getElementById('con-detail-panel');
  if (panel) panel.hidden = true;
}

async function loadConView() {
  const v = CON_VIEWS[conView];
  const host = $('#tbl-con-view');
  if (!v || !host) return;
  host.innerHTML = '<div class="muted" style="padding:12px"></div>';
  const c = $('#con-view-count');
  if (c) c.textContent = '';
  try {
    const qs = new URLSearchParams();
    const q = (document.getElementById('con-q')?.value || '').trim();
    if (q) qs.set('q', q);
    const from = document.getElementById('con-from')?.value || '';
    const to = document.getElementById('con-to')?.value || '';
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const st = document.getElementById('con-status')?.value || '';
    if (st) qs.set('status', st);
    const qStr = qs.toString() ? '&' + qs.toString() : '';
    const d = await api('/api/report?name=' + encodeURIComponent(v.report) + '&page=1&pageSize=5000' + qStr);
    const rows = (d && d.rows) || [];
    /* ربط بيانات التفاصيل الناقصة من جدول contract_details للعرض الموحد */
    try {
      const det = await api('/api/report?name=contract-details-raw&page=1&pageSize=5000');
      const detMap = {};
      (det && det.rows || []).forEach(r => { if (r.internal_no) detMap[String(r.internal_no)] = r; });
      rows.forEach(r => {
        const dRow = detMap[String(r.internal_no || r.id)];
        if (!dRow) return;
        if (!r.expected_arrival && dRow.expected_arrival) r.expected_arrival = dRow.expected_arrival;
        if (!r.operation_start && dRow.operation_start) r.operation_start = dRow.operation_start;
        if (!r.vessel_status && dRow.vessel_status) r.vessel_status = dRow.vessel_status;
        if (!r.vessel_name && dRow.vessel_name) r.vessel_name = dRow.vessel_name;
        if (!r.arrival_port && dRow.arrival_port) r.arrival_port = dRow.arrival_port;
        if (!r.detail_quantity && dRow.detail_quantity != null) r.detail_quantity = dRow.detail_quantity;
        if (!r.internal_company && dRow.internal_company) r.internal_company = dRow.internal_company;
      });
    } catch (_) {}
    conRowsById = {};
    rows.forEach(r => { conRowsById[String(r.id)] = r; });
    table(host, conViewCols(conView), rows, { limit: 0, empty: 'لا توجد بيانات بعد — اضغط «＋ إضافة»' });
    const csv = document.getElementById('con-csv');
    if (csv) {
      const qs = new URLSearchParams();
      const q = (document.getElementById('con-q')?.value || '').trim();
      if (q) qs.set('q', q);
      const from = document.getElementById('con-from')?.value || '';
      const to = document.getElementById('con-to')?.value || '';
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const st = document.getElementById('con-status')?.value || '';
      if (st) qs.set('status', st);
      const qStr = qs.toString() ? '?' + qs.toString() : '';
      csv.style.display = '';
      csv.href = '/api/export?name=' + encodeURIComponent(v.report) + qStr;
    }
    $$('#tbl-con-view [data-de-edit]').forEach(b => b.addEventListener('click', async () => {
      const row = conRowsById[b.dataset.deEdit];
      if (!row) return;
      await openManual(conView);
      deFill(row);
    }));
    $$('#tbl-con-view [data-con-open-detail]').forEach(b => b.addEventListener('click', () => {
      const row = conRowsById[b.dataset.conOpenDetail];
      openContractDetails(row ? row.internal_no : '');
    }));
    $$('#tbl-con-view [data-de-del]').forEach(b =>
      b.addEventListener('click', () => deDelete(b.dataset.deDel, conView)));
    if (c) c.textContent = n0(rows.length) + ' سجل' + (d && d.total > rows.length ? ' (من ' + n0(d.total) + ')' : '');
  } catch (e) {
    host.innerHTML = `<div class="muted" style="padding:12px">${escHtml(e.message)}</div>`;
  }
}

function showConStep(cat) {
  if (!CON_VIEWS[cat]) cat = 'contract_registrations';
  conView = cat;
  try { localStorage.setItem('ccs-con-step', cat); } catch (_) {}
  $$('nav [data-con-step]').forEach(b => b.classList.toggle('on', b.dataset.conStep === cat));
  const add = document.getElementById('con-add');
  if (add) add.textContent = '＋ ' + CON_VIEWS[cat].add;
  const t = document.getElementById('con-view-title');
  if (t) t.textContent = CON_VIEWS[cat].label;
  const sub = document.getElementById('con-sub-label');
  if (sub) sub.textContent = '— ' + (CON_VIEWS[cat].label || '');
  return loadConView();
}

/* فلاتر العقود: بحث + تاريخ + حالة العقد — فورية. الحالة الافتراضية دائماً «نشط» على كل الخطوات */
const CON_STATUS_DEFAULT = '';
const CON_FILTER_IDS = ['con-q', 'con-from', 'con-to', 'con-status'];
CON_FILTER_IDS.forEach(id => {
  document.getElementById(id)?.addEventListener('input', () => loadConView().catch(e => toast(e.message)));
});

/* زر مسح فلاتر العقود — يُعيد الحالة إلى الافتراضى «نشط» */
document.getElementById('con-clear')?.addEventListener('click', () => {
  CON_FILTER_IDS.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const st = document.getElementById('con-status');
  if (st) st.value = CON_STATUS_DEFAULT;
  loadConView().catch(e => toast(e.message));
});

/* فتح شاشة العقود على خطوةٍ ما من القائمة المنسدلة في الشريط العلوي */
function showConStepScreen(step) {
  closeNavMenus();
  $$('nav button').forEach(x => x.classList.remove('active'));
  document.querySelector(dropBtnSel('contracts'))?.classList.add('active');
  $$('section').forEach(s => s.classList.remove('active'));
  $('#tab-contracts').classList.add('active');
  $('#sidebar').classList.remove('open');
  const t = TITLES.contracts || ['عقود الاستيراد', ''];
  setHead(t[0], t[1]);
  rememberScreen('contracts');
  showConStep(step);
}


/* يرفع الملف إلى مرحلة المعاينة (.staging) ويعرض الجداول والصفوف المكتشفة قبل الاستيراد */
async function previewDailyFile(file, name, as) {
  dfPendingFile = file; dfPendingName = name; dfPendingAs = as || null;
  const box = $('#dfl-preview');
  const warn = $('#dfl-preview-warn');
  box.style.display = 'block';
  warn.textContent = 'جاري رفع الملف وتحليله…';
  $('#dfl-preview-body').innerHTML = '';
  $('#dfl-preview-meta').textContent = '';
  $('#dfl-preview-title').textContent = 'معاينة: ' + name;
  $('#dfl-confirm').disabled = true;
  const q = new URLSearchParams({ cat: dfCat, name });
  const pw = ($('#dfl-pw') && $('#dfl-pw').value) || '';
  if (pw) q.set('pw', pw);
  try {
    const r = await fetch('/api/import/preview?' + q.toString(), { method: 'POST', body: file });
    const j = await r.json().catch(() => ({ ok: false, error: 'استجابة غير صالحة' }));
    if (!j.ok) throw new Error(j.error || j.message || 'فشل تحليل الملف');
    dfStaged = { token: j.data.token, cat: dfCat, name: j.data.name, as: as || null };
    renderDailyPreview(j.data.analysis, { replacing: !!as, name: j.data.name });
  } catch (e) {
    dfStaged = null;
    warn.innerHTML = `<span class="neg">تعذّرت المعاينة: ${escHtml(e.message)}</span> — إن كان الملف محمياً فأدخل كلمة المرور ثم غيّرها هنا لإعادة المحاولة.`;
  }
}

function renderDailyPreview(analysis, meta) {
  const sheets = Array.isArray(analysis) ? analysis : [];
  let tables = 0, samples = 0, html = '';
  for (const sh of sheets) {
    if (!sh.tables || !sh.tables.length) continue;
    html += `<div style="margin-bottom:12px"><b>${escHtml(sh.name)}</b> <span class="muted xs">(${escHtml(sh.ref || '')})</span>`;
    for (const t of sh.tables) {
      tables++; samples += (t.rows || []).length;
      html += `<div class="pill info" style="display:inline-block;margin:6px 3px 2px">${escHtml(t.label)}</div>`;
      html += '<div class="tblwrap" style="margin-top:4px;max-height:220px"><table><thead><tr>' +
        (t.headers || []).map(h => `<th>${escHtml(h)}</th>`).join('') + '</tr></thead><tbody>' +
        (t.rows || []).map(r => '<tr>' + r.map(c => `<td>${escHtml(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>';
    }
    html += '</div>';
  }
  $('#dfl-preview-body').innerHTML = html || '<div class="muted">لم يُعثر على جداول معروفة داخل الملف.</div>';
  const warn = $('#dfl-preview-warn');
  if (!tables) {
    warn.innerHTML = '<span class="neg">لم يُكتشف أي جدول معروف — لا يمكن الاستيراد.</span>';
    $('#dfl-confirm').disabled = true;
  } else {
    $('#dfl-confirm').disabled = false;
    warn.innerHTML = `تم كشف <b>${tables}</b> جدولاً و<b>${samples}</b> صف معاينة.` +
      (meta && meta.replacing ? ' — <span class="pill warning">استبدال ملف قائم</span>' : '');
  }
  $('#dfl-preview-meta').textContent = (meta && meta.name) || '';
}

async function confirmDailyImport() {
  if (dfBusy) { toast('يوجد استيراد جارٍ — انتظر اكتماله'); return; }
  if (!dfStaged) { toast('اختر ملفاً وعايِنه أولاً'); return; }
  dfBusy = true;
  const btn = $('#dfl-confirm'); btn.disabled = true; btn.textContent = 'جاري الاستيراد…';
  const pr = $('#dfl-progress'); pr.style.display = 'block';
  $('#dfl-stage').textContent = 'جاري الاستيراد…';
  try {
    const r = await api('/api/import/commit', {
      method: 'POST', headers: hdr,
      body: JSON.stringify({
        token: dfStaged.token, cat: dfStaged.cat, name: dfStaged.name,
        as: dfStaged.as || undefined, pw: ($('#dfl-pw') && $('#dfl-pw').value) || undefined,
      }),
    });
    closeDailyPreview();
    await pollDailyJob(r.jobId);
  } catch (e) {
    pr.style.display = 'none'; $('#dfl-stage').textContent = '';
    toast('خطأ: ' + e.message);
  } finally {
    dfBusy = false; btn.disabled = false; btn.textContent = '✔ تأكيد الاستيراد';
  }
}

function closeDailyPreview() {
  dfStaged = null; dfPendingFile = null; dfPendingName = null; dfPendingAs = null;
  $('#dfl-preview').style.display = 'none';
  $('#dfl-preview-body').innerHTML = '';
  const pw = $('#dfl-pw'); if (pw) pw.value = '';
}

function pollDailyJob(jobId) {
  return new Promise(resolve => {
    const pr = $('#dfl-progress');
    const poll = setInterval(async () => {
      try {
        const j = await api('/api/import/status?id=' + jobId);
        $('#dfl-stage').textContent = 'الحالة: ' + j.stage + ' (' + Math.round((Date.now() - j.started) / 1000) + ' ث)';
        if (j.status === 'done' || j.status === 'error') {
          clearInterval(poll);
          pr.style.display = 'none'; $('#dfl-stage').textContent = '';
          if (j.status === 'error') { toast('فشل الاستيراد: ' + (j.error || 'خطأ')); return resolve(); }
          const tables = ((j.result && j.result.tables) || []).filter(t => !t.error);
          const rows = tables.reduce((s, t) => s + (t.rows || 0), 0);
          toast('تم الاستيراد ✔ ' + n0(rows) + ' صف في: ' + (tables.map(t => t.label).join('، ') || '—'));
          await loadDailyFiles();
          const cfg = DAILY_CATS[dfCat];
          if (cfg && cfg.reload) cfg.reload().catch(() => {});
          /* تحديث قائمة الأصناف الأساسية من قاعدة البيانات (مزامنة من الحركات) */
          loadItemsAll({ force: true }).catch(() => {});
          resolve();
        }
      } catch (e) {
        clearInterval(poll);
        pr.style.display = 'none'; $('#dfl-stage').textContent = '';
        toast('خطأ في متابعة الاستيراد: ' + e.message);
        resolve();
      }
    }, 1500);
  });
}

function openDailyImport(cat) {
  if (!can('import')) {
    toast('دورك لا يملك صلاحية الاستيراد — اطلب من المدير تفعيلها');
    return;
  }
  /* البورصة والأسعار بلا ملفات مرفوعة — إدارتهما من الإدخال اليدوي لا من هنا */
  if (!UPLOAD_CATS.includes(cat)) {
    toast('هذه الشاشة بلا استيراد ملفات — استخدم «إدخال يدوي»');
    return;
  }
  dfCat = cat; dfReplacing = null;
  $('#dfl-cat').textContent = '— ' + DAILY_CATS[cat].label;
  $('#dfl-q').value = '';
  const pr = $('#dfl-progress'); pr.style.display = 'none'; $('#dfl-stage').textContent = '';
  closeDailyPreview();
  $('#daily-files-modal').hidden = false;
  loadDailyFiles().catch(e => toast('خطأ: ' + e.message));
}

$$('[data-daily-import]').forEach(b => b.addEventListener('click', () => openDailyImport(b.dataset.dailyImport)));
$$('nav [data-con-step]').forEach(b => b.addEventListener('click', () => showConStepScreen(b.dataset.conStep)));
$('#con-add')?.addEventListener('click', () => openManual(conView));
$('#con-detail-back')?.addEventListener('click', () => closeContractDetails());
$('#con-detail-add')?.addEventListener('click', async () => {
  await openManual('contract_details');
  const el = document.querySelector('#de-fields [data-k="internal_no"]');
  if (el) { el.value = conSelectedNo; el.readOnly = true; }
});
$('#con-view-refresh')?.addEventListener('click', () => loadConView().catch(e => toast('خطأ: ' + e.message)));
$('#dfl-add')?.addEventListener('click', () => { dfReplacing = null; $('#dfl-file').click(); });
$('#dfl-refresh')?.addEventListener('click', () => loadDailyFiles().catch(e => toast('خطأ: ' + e.message)));
$('#dfl-q')?.addEventListener('input', () => loadDailyFiles().catch(() => {}));
$('#dfl-cancel')?.addEventListener('click', closeDailyPreview);
$('#dfl-confirm')?.addEventListener('click', () => confirmDailyImport());
/* تغيير كلمة المرور بعد فشل معاينة ملف محمي يعيد المحاولة تلقائياً بنفس الملف */
$('#dfl-pw')?.addEventListener('change', () => {
  if (dfPendingFile && !dfStaged) previewDailyFile(dfPendingFile, dfPendingName, dfPendingAs);
});
$('#dfl-file')?.addEventListener('change', async () => {
  const input = $('#dfl-file');
  const f = input.files && input.files[0];
  input.value = '';
  if (!f || !dfCat) { dfReplacing = null; return; }
  const rep = dfReplacing; dfReplacing = null;
  try {
    if (rep) await previewDailyFile(f, rep.file_name, rep.file_path);
    else await previewDailyFile(f, f.name, '');
  } catch (e) { toast('خطأ: ' + e.message); }
});

/* ---------------- الإدخال اليدوي للبيانات اليومية (حركات/مبيعات/أرصدة) ----------------
   يُخزَّن كل صف بـ source_file='manual'، والتعديل/الحذف من هذه الشاشة للصفوف اليدوية فقط
   (الصفوف القادمة من ملفات محصّنة). الحقول المشتقة (المكان/الشركة/التوجيه/إشارة البيع)
   تُحسب في الخادم لحظة الحفظ. */
const DE_FIELDS = {
  movements: [
    { k: 'post_date', t: 'تاريخ الترحيل', type: 'date', req: true },
    { k: 'item', t: 'الصنف (بالقائمة)', type: 'items', req: true },
    { k: 'item_desc', t: 'وصف الصنف', type: 'text' },
    { k: 'uom', t: 'وحدة القياس', type: 'text' },
    { k: 'qty', t: 'الكمية', type: 'num' },
    { k: 'move_type', t: 'نوع الحركة', type: 'text' },
    { k: 'doc_ref', t: 'مرجع المستند', type: 'text' },
    { k: 'customer', t: 'العميل / المورد', type: 'text' },
    { k: 'unit_code', t: 'كود الوحدة', type: 'text' },
    { k: 'storage_loc', t: 'موقع التخزين', type: 'text' },
    { k: 'company_code', t: 'كود الشركة (تلقائي)', type: 'text' },
    { k: 'amount', t: 'القيمة', type: 'num' },
    { k: 'currency', t: 'العملة', type: 'text' },
    { k: 'descr', t: 'ملاحظات', type: 'text' },
  ],
  sales: [
    { k: 'invoice_date', t: 'تاريخ الفاتورة', type: 'date', req: true },
    { k: 'invoice_doc', t: 'رقم الفاتورة', type: 'text' },
    { k: 'ref_doc', t: 'المستند المرجع', type: 'text' },
    { k: 'item', t: 'الصنف (بالقائمة)', type: 'items', req: true },
    { k: 'item_desc', t: 'وصف الصنف', type: 'text' },
    { k: 'qty', t: 'الكمية', type: 'num' },
    { k: 'net_value', t: 'صافي القيمة', type: 'num' },
    { k: 'unit_code', t: 'كود الوحدة', type: 'text' },
    { k: 'beneficiary', t: 'المستفيد', type: 'text' },
    { k: 'tax', t: 'الضريبة', type: 'num' },
    { k: 'storage_loc', t: 'موقع التخزين', type: 'text' },
  ],
  balances: [
    { k: 'balance_date', t: 'تاريخ الرصيد', type: 'date', req: true },
    { k: 'item', t: 'الصنف (بالقائمة)', type: 'items', req: true },
    { k: 'item_desc', t: 'وصف الصنف', type: 'text' },
    { k: 'base_uom', t: 'الوحدة الأساسية', type: 'text' },
    { k: 'unit_code', t: 'كود الوحدة', type: 'text' },
    { k: 'storage_loc', t: 'موقع التخزين', type: 'text' },
    { k: 'company_code', t: 'كود الشركة (تلقائي)', type: 'text' },
    { k: 'currency', t: 'العملة', type: 'text' },
    { k: 'material_type', t: 'نوع المادة', type: 'text' },
    { k: 'open_qty', t: 'رصيد أول كمية', type: 'num' },
    { k: 'open_val', t: 'رصيد أول قيمة', type: 'num' },
    { k: 'close_qty', t: 'رصيد آخر كمية', type: 'num' },
    { k: 'close_val', t: 'رصيد آخر قيمة', type: 'num' },
  ],
  /* الأسعار اليومية: تكلفة/سوق لكل (تاريخ × صنف) */
  prices: [
    { k: 'price_date', t: 'تاريخ السعر', type: 'date', req: true },
    { k: 'item_code', t: 'الصنف (بالقائمة)', type: 'items', req: true },
    { k: 'item', t: 'اسم الصنف (تلقائي)', type: 'text' },
    { k: 'cost_land', t: 'التكلفة (أرضه)', type: 'num' },
    { k: 'market_land', t: 'السوق (أرضه)', type: 'num' },
    { k: 'currency', t: 'العملة', type: 'text' },
  ],
  /* البورصة: قيم السوق + مدخلات التكلفة — «سعر التكلفة» يحسبه الخادم */
  borse: [
    { k: 'borse_date', t: 'تاريخ التسعير', type: 'date', req: true },
    { k: 'item_code', t: 'الصنف (بالقائمة)', type: 'items', req: true },
    { k: 'contract', t: 'العقد (مثل 26 ديسمبر)', type: 'text' },
    { k: 'low', t: 'منخفض', type: 'num' },
    { k: 'high', t: 'عالٍ', type: 'num' },
    { k: 'close', t: 'إغلاق', type: 'num' },
    { k: 'borse_now', t: 'سعر البورصة', type: 'num' },
    { k: 'basis', t: 'متوسط البريم', type: 'num' },
    { k: 'fx_factor', t: 'معامل التحويل', type: 'num' },
    { k: 'usd_rate', t: 'ريت الدولار', type: 'num' },
    { k: 'fees', t: 'المصاريف', type: 'num' },
    { k: 'down_payment', t: 'النولون', type: 'num' },
  ],
  /* ---- عقود الاستيراد: مسار الإدخال اليومي ---- */
  contract_registrations: [
    { k: 'internal_no', t: 'الرقم داخلي', type: 'text', ph: 'يُولَّد تلقائياً', readonly: true },
    { k: 'contract_date', t: 'تاريخ التعاقد', type: 'date', req: true },
    { k: 'contract_category', t: 'التصنيف', type: 'sel', req: true, opts: [{ v: 'خامات', l: 'خامات' }, { v: 'إضافات', l: 'إضافات' }] },
    { k: 'classification', t: 'التصنيف التفصيلي', type: 'text', req: true, list: 'de-cls-list' },
    { k: 'supplier', t: 'المورد', type: 'ref', req: true, ref: 'supplier' },
    { k: 'source_country', t: 'بلد المنشأ', type: 'ref', req: true, ref: 'source' },
    { k: 'contracting_company', t: 'شركة التعاقد', type: 'company', req: true },
    { k: 'internal_company', t: 'الشركة الداخلية', type: 'company', req: true },
    { k: 'contract_no', t: 'رقم العقد', type: 'text', req: true },
    { k: 'quantity', t: 'الكمية الإجمالية', type: 'num', req: true },
    { k: 'detail_quantity', t: 'الكمية التفصيلية', type: 'num', req: true },
    { k: 'contract_premium', t: 'البريم', type: 'text', req: true },
    { k: 'shipping_type', t: 'نظام الشحن', type: 'sel', req: true, opts: [{ v: 'CIF', l: 'CIF' }, { v: 'FOB', l: 'FOB' }] },
    { k: 'shipping_value', t: 'قيمة الشحن', type: 'num', req: true },
    { k: 'initial_price', t: 'السعر المبدئي', type: 'num', req: true },
    { k: 'contract_exchange', t: 'بورصة التعاقد', type: 'text', req: true },
    { k: 'expected_payment_date', t: 'متوقع السداد', type: 'date', req: true },
    { k: 'contract_status', t: 'حالة العقد', type: 'sel', req: true, opts: [
      { v: 'ACTIVE', l: 'نشط' }, { v: 'FINISH', l: 'منتهي' }, { v: 'UNDER', l: 'تحت التشغيل' }] },
    { k: 'expected_cif_price', t: 'سعر CIF متوقع', type: 'num', req: true },
    { k: 'vessel_name', t: 'الباخرة', type: 'text' },
    { k: 'arrival_port', t: 'ميناء الوصول', type: 'ref', ref: 'arrival_port' },
    { k: 'expected_arrival', t: 'وصول متوقع', type: 'date', req: true },
    { k: 'operation_start', t: 'بداية تشغيل', type: 'date' },
    { k: 'loading_duration', t: 'مدة التحميل', type: 'text' },
    { k: 'operation_end', t: 'نهاية تشغيل', type: 'date' },
    { k: 'vessel_status', t: 'موقف المركب', type: 'sel', req: true, opts: [
      { v: 'منتظر الوصول', l: 'منتظر الوصول' },
      { v: 'جارى التفريغ', l: 'جارى التفريغ' },
      { v: 'منتظر التفريغ', l: 'منتظر التفريغ' },
      { v: 'انتهاء التفريغ', l: 'انتهاء التفريغ' }] },
    { k: 'notes', t: 'ملاحظات', type: 'text' },
  ],
  contract_details: [
    { k: 'internal_no', t: 'الرقم الداخلى', type: 'ref', req: true, ref: 'contract_registrations' },
    { k: 'classification', t: 'التصنيف', type: 'text' },
    { k: 'source_country', t: 'المصدر / بلد المنشأ', type: 'ref', ref: 'source' },
    { k: 'external_company', t: 'الشركة الخارجية', type: 'text' },
    { k: 'internal_company', t: 'الشركة الداخلية', type: 'company' },
    { k: 'contract_no', t: 'رقم العقد', type: 'text' },
    { k: 'detail_quantity', t: 'كمية تفصيلى', type: 'num' },
    { k: 'vessel_name', t: 'الباخرة', type: 'text' },
    { k: 'arrival_port', t: 'ميناء الوصول', type: 'ref', ref: 'arrival_port' },
    { k: 'expected_arrival', t: 'وصول متوقع', type: 'date' },
    { k: 'operation_start', t: 'بداية تشغيل', type: 'date' },
    { k: 'loading_duration', t: 'مدة التحميل', type: 'text' },
    { k: 'operation_end', t: 'نهاية تشغيل', type: 'date' },
    { k: 'contract_status', t: 'موقف العقد', type: 'sel', opts: [
      { v: 'ACTIVE', l: 'نشط' }, { v: 'FINISH', l: 'منتهي' }, { v: 'UNDER', l: 'تحت التشغيل' }] },
    { k: 'vessel_status', t: 'موقف المركب', type: 'text' },
    { k: 'notes', t: 'ملاحظات', type: 'text' },
  ],
  contract_payments: [
    { k: 'internal_no', t: 'الرقم الداخلى', type: 'ref', req: true, ref: 'contract_registrations' },
    { k: 'payment_date', t: 'تاريخ السداد', type: 'date', req: true },
    { k: 'payment_company', t: 'شركة السداد', type: 'text' },
    { k: 'item', t: 'التصنيف من العقد', type: 'text' },
    { k: 'supplier', t: 'المورد', type: 'ref', ref: 'supplier' },
    { k: 'contract_no', t: 'رقم العقد', type: 'text' },
    { k: 'internal_company', t: 'الشركة الداخلية', type: 'company' },
    { k: 'payment_type', t: 'نوع السداد', type: 'text' },
    { k: 'price_type', t: 'نوع السعر', type: 'text' },
    { k: 'payment_status', t: 'موقف السداد', type: 'text' },
    { k: 'payment_quantity', t: 'كمية السداد', type: 'num' },
    { k: 'payment_price', t: 'سعر السداد', type: 'num' },
    { k: 'exchange_rate', t: 'ريت السداد', type: 'num' },
    { k: 'responsible_person', t: 'مسئول السداد', type: 'text' },
    { k: 'notes', t: 'ملاحظات السداد', type: 'text' },
  ],
  contract_loading: [
    { k: 'internal_no', t: 'الرقم الداخلى', type: 'ref', req: true, ref: 'contract_registrations' },
    { k: 'loading_date', t: 'تاريخ التحميل', type: 'date', req: true },
    { k: 'contract_no', t: 'رقم العقد', type: 'text' },
    { k: 'item', t: 'التصنيف من العقد', type: 'text' },
    { k: 'vessel_name', t: 'اسم المركب', type: 'text' },
    { k: 'loading_type', t: 'نوع التحميل', type: 'text' },
    { k: 'loading_quantity', t: 'كمية التحميل', type: 'num' },
    { k: 'notes', t: 'ملاحظات التحميل', type: 'text' },
  ],
  contract_hedge: [
    { k: 'internal_no', t: 'الرقم الداخلى', type: 'ref', req: true, ref: 'contract_registrations' },
    { k: 'hedge_date', t: 'تاريخ الربط', type: 'date', req: true },
    { k: 'supplier', t: 'المورد', type: 'ref', ref: 'supplier' },
    { k: 'contract_no', t: 'رقم العقد', type: 'text' },
    { k: 'item', t: 'التصنيف من العقد', type: 'text' },
    { k: 'contract_exchange', t: 'بورصة التعاقد', type: 'text' },
    { k: 'contract_count', t: 'عدد العقود', type: 'num' },
    { k: 'hedge_quantity', t: 'كمية الربط', type: 'num' },
    { k: 'exchange_price', t: 'سعر البورصة', type: 'num' },
    { k: 'hedge_exchange', t: 'بورصة الربط', type: 'text' },
    { k: 'hedge_premium', t: 'بريم الربط', type: 'num' },
    { k: 'hedge_price', t: 'سعر الربط', type: 'num' },
    { k: 'hedge_value', t: 'قيمة الربط (تُحسب تلقائياً)', type: 'num' },
    { k: 'notes', t: 'ملاحظات الربط', type: 'text' },
  ],
  contract_roll: [
    { k: 'internal_no', t: 'الرقم الداخلى', type: 'ref', req: true, ref: 'contract_registrations' },
    { k: 'roll_date', t: 'تاريخ الترويل', type: 'date', req: true },
    { k: 'contract_no', t: 'رقم العقد', type: 'text' },
    { k: 'supplier', t: 'المورد', type: 'ref', ref: 'supplier' },
    { k: 'item', t: 'التصنيف من العقد', type: 'text' },
    { k: 'roll_quantity', t: 'كمية الترويل', type: 'num' },
    { k: 'contract_exchange', t: 'بورصة التعاقد', type: 'text' },
    { k: 'hedge_exchange', t: 'بورصة الربط', type: 'text' },
    { k: 'previous_exchange', t: 'بورصة سابقة', type: 'text' },
    { k: 'rolling_exchange', t: 'بورصة الرولينج', type: 'text' },
    { k: 'rolling_price', t: 'سعر الرولينج', type: 'num' },
    { k: 'notes', t: 'ملاحظات الرولينج', type: 'text' },
  ],
  contract_release: [
    { k: 'internal_no', t: 'الرقم الداخلى', type: 'ref', req: true, ref: 'contract_registrations' },
    { k: 'release_date', t: 'تاريخ الافراج', type: 'date', req: true },
    { k: 'contract_no', t: 'رقم العقد', type: 'text' },
    { k: 'item', t: 'التصنيف من العقد', type: 'text' },
    { k: 'vessel_name', t: 'اسم المركب', type: 'text' },
    { k: 'release_quantity', t: 'كمية الافراج', type: 'num' },
    { k: 'release_type', t: 'نوع الافراج', type: 'text' },
    { k: 'notes', t: 'ملاحظات', type: 'text' },
  ],
};

const deActions = id =>
  `<button class="btn sm ghost" data-de-edit="${id}" title="تعديل">✎</button> ` +
  `<button class="btn sm ghost" data-de-del="${id}" title="حذف">🗑</button>`;

const DE_COLS = {
  movements: [
    { t: 'التاريخ', k: 'post_date' },
    { t: 'الصنف', f: r => (r.item || '—') + (r.item_desc ? ' • ' + r.item_desc : '') },
    { t: 'النوع', k: 'move_type' },
    { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
    { t: 'القيمة', k: 'amount', n: 1, f: r => n2(r.amount) },
    { t: 'المكان', k: 'place' },
    { t: 'الوحدة', k: 'unit_code' },
    { t: '', h: true, f: r => deActions(r.id) },
  ],
  sales: [
    { t: 'التاريخ', k: 'invoice_date' },
    { t: 'الفاتورة', k: 'invoice_doc' },
    { t: 'المرجع', k: 'ref_doc' },
    { t: 'الصنف', f: r => (r.item || '—') + (r.item_desc ? ' • ' + r.item_desc : '') },
    { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
    { t: 'صافي القيمة', k: 'net_value', n: 1, f: r => n2(r.net_value) },
    { t: 'المستفيد', k: 'beneficiary' },
    { t: 'المكان', k: 'place' },
    { t: '', h: true, f: r => deActions(r.id) },
  ],
  balances: [
    { t: 'التاريخ', k: 'balance_date' },
    { t: 'الصنف', f: r => (r.item || '—') + (r.item_desc ? ' • ' + r.item_desc : '') },
    { t: 'الوحدة الأساسية', k: 'base_uom' },
    { t: 'رصيد أول كمية', k: 'open_qty', n: 1, f: r => n2(r.open_qty) },
    { t: 'رصيد أول قيمة', k: 'open_val', n: 1, f: r => n2(r.open_val) },
    { t: 'رصيد آخر كمية', k: 'close_qty', n: 1, f: r => n2(r.close_qty) },
    { t: 'رصيد آخر قيمة', k: 'close_val', n: 1, f: r => n2(r.close_val) },
    { t: 'المكان', k: 'place' },
    { t: '', h: true, f: r => deActions(r.id) },
  ],
  prices: [
    { t: 'التاريخ', k: 'price_date' },
    { t: 'الصنف', f: r => (r.item || r.item_code || '—') },
    { t: 'التكلفة (أرضه)', k: 'cost_land', n: 1, f: r => money(r.cost_land) },
    { t: 'السوق (أرضه)', k: 'market_land', n: 1, f: r => money(r.market_land) },
    { t: 'العملة', k: 'currency' },
    { t: '', h: true, f: r => deActions(r.id) },
  ],
  borse: [
    { t: 'التاريخ', k: 'borse_date' },
    { t: 'الصنف', f: r => (r.item || r.item_code || '—') },
    { t: 'العقد', k: 'contract' },
    { t: 'إغلاق', k: 'close', n: 1, f: r => n2(r.close) },
    { t: 'سعر البورصة', k: 'borse_now', n: 1, f: r => n2(r.borse_now) },
    { t: 'الريت', k: 'usd_rate', n: 1, f: r => n2(r.usd_rate) },
    { t: 'سعر التكلفة', k: 'cost_price', n: 1, f: r => money(r.cost_price) },
    { t: '', h: true, f: r => deActions(r.id) },
  ],
  /* ---- عقود الاستيراد ---- */
  contract_registrations: [
    { t: 'الرقم داخلي', k: 'internal_no' },
    { t: 'التاريخ', k: 'contract_date' },
    { t: 'التصنيف', k: 'classification' },
    { t: 'المورد', k: 'supplier' },
    { t: 'شركة التعاقد', k: 'contracting_company' },
    { t: 'الشركة الداخلية', k: 'internal_company' },
    { t: 'رقم العقد', k: 'contract_no' },
    { t: 'الكمية الإجمالية', k: 'quantity', n: 1, f: r => n2(r.quantity) },
    { t: 'كمية تفصيلى', k: 'detail_quantity', n: 1, f: r => n2(r.detail_quantity) },
    { t: 'الباخرة', k: 'vessel_name' },
    { t: 'ميناء الوصول', k: 'arrival_port' },
    { t: 'حالة العقد', k: 'contract_status' },
    { t: '', h: true, f: r => deActions(r.id) },
  ],
  contract_details: [
    { t: 'الرقم داخلي', k: 'internal_no' },
    { t: 'التصنيف', k: 'classification' },
    { t: 'رقم العقد', k: 'contract_no' },
    { t: 'كمية تفصيلى', k: 'detail_quantity', n: 1, f: r => n2(r.detail_quantity) },
    { t: 'الباخرة', k: 'vessel_name' },
    { t: 'ميناء الوصول', k: 'arrival_port' },
    { t: 'وصول متوقع', k: 'expected_arrival' },
    { t: 'بداية تشغيل', k: 'operation_start' },
    { t: 'موقف المركب', k: 'vessel_status' },
    { t: '', h: true, f: r => deActions(r.id) },
  ],
  contract_payments: [
    { t: 'الرقم داخلي', k: 'internal_no' },
    { t: 'التاريخ', k: 'payment_date' },
    { t: 'الصنف', f: r => itemDisp(r.item) },
    { t: 'المورد', k: 'supplier' },
    { t: 'رقم العقد', k: 'contract_no' },
    { t: 'كمية السداد', k: 'payment_quantity', n: 1, f: r => n2(r.payment_quantity) },
    { t: 'سعر السداد', k: 'payment_price', n: 1, f: r => n2(r.payment_price) },
    { t: 'الريت', k: 'exchange_rate', n: 1, f: r => n2(r.exchange_rate) },
    { t: 'موقف السداد', k: 'payment_status' },
    { t: '', h: true, f: r => deActions(r.id) },
  ],
  contract_loading: [
    { t: 'الرقم داخلي', k: 'internal_no' },
    { t: 'التاريخ', k: 'loading_date' },
    { t: 'رقم العقد', k: 'contract_no' },
    { t: 'الصنف', f: r => itemDisp(r.item) },
    { t: 'اسم المركب', k: 'vessel_name' },
    { t: 'نوع التحميل', k: 'loading_type' },
    { t: 'كمية التحميل', k: 'loading_quantity', n: 1, f: r => n2(r.loading_quantity) },
    { t: '', h: true, f: r => deActions(r.id) },
  ],
  contract_hedge: [
    { t: 'الرقم داخلي', k: 'internal_no' },
    { t: 'التاريخ', k: 'hedge_date' },
    { t: 'المورد', k: 'supplier' },
    { t: 'رقم العقد', k: 'contract_no' },
    { t: 'الصنف', f: r => itemDisp(r.item) },
    { t: 'كمية الربط', k: 'hedge_quantity', n: 1, f: r => n2(r.hedge_quantity) },
    { t: 'بريم الربط', k: 'hedge_premium', n: 1, f: r => n2(r.hedge_premium) },
    { t: 'سعر الربط', k: 'hedge_price', n: 1, f: r => n2(r.hedge_price) },
    { t: 'قيمة الربط', k: 'hedge_value', n: 1, f: r => n2(r.hedge_value) },
    { t: '', h: true, f: r => deActions(r.id) },
  ],
  contract_roll: [
    { t: 'الرقم داخلي', k: 'internal_no' },
    { t: 'التاريخ', k: 'roll_date' },
    { t: 'رقم العقد', k: 'contract_no' },
    { t: 'المورد', k: 'supplier' },
    { t: 'الصنف', f: r => itemDisp(r.item) },
    { t: 'كمية الترويل', k: 'roll_quantity', n: 1, f: r => n2(r.roll_quantity) },
    { t: 'سعر الرولينج', k: 'rolling_price', n: 1, f: r => n2(r.rolling_price) },
    { t: '', h: true, f: r => deActions(r.id) },
  ],
  contract_release: [
    { t: 'الرقم داخلي', k: 'internal_no' },
    { t: 'التاريخ', k: 'release_date' },
    { t: 'رقم العقد', k: 'contract_no' },
    { t: 'الصنف', f: r => itemDisp(r.item) },
    { t: 'اسم المركب', k: 'vessel_name' },
    { t: 'كمية الافراج', k: 'release_quantity', n: 1, f: r => n2(r.release_quantity) },
    { t: 'نوع الافراج', k: 'release_type' },
    { t: '', h: true, f: r => deActions(r.id) },
  ],
};

let deCat = null, deEditId = null, deRowsById = {};

function deBuildFields() {
  const host = $('#de-fields'); if (!host) return;
  const star = f => f.req ? ' <b class="neg">*</b>' : '';
  host.innerHTML = (DE_FIELDS[deCat] || []).map(f => {
    if (f.type === 'items') {                     // قائمة الأصناف الأساسية الموحدة — القيمة كود الصنف
      return `<label><span>${escHtml(f.t)}${star(f)}</span>` +
        `<select class="input" data-k="${f.k}" data-type-items></select></label>`;
    }
    if (f.type === 'ref') {                       // قائمة مرجعية (مورد/مصدر/ميناء) — القيمة اسم المرجع
      return `<label><span>${escHtml(f.t)}${star(f)}</span>` +
        `<select class="input" data-k="${f.k}" data-type-ref="${escHtml(f.ref)}"></select></label>`;
    }
    if (f.type === 'company') {                   // قائمة شركات البيانات الأساسية
      return `<label><span>${escHtml(f.t)}${star(f)}</span>` +
        `<select class="input" data-k="${f.k}" data-type-company></select></label>`;
    }
    if (f.type === 'sel') {                       // قائمة خيارات ثابتة (أصناف البورصة)
      return `<label><span>${escHtml(f.t)}${star(f)}</span>` +
        `<select class="input" data-k="${f.k}">` +
        (f.opts || []).map(o => `<option value="${escHtml(o.v)}">${escHtml(o.l)}</option>`).join('') +
        `</select></label>`;
    }
    if (f.type === 'date') {                       // تاريخ: dd/mm/yyyy داخل الخانة
      return `<label><span>${escHtml(f.t)}${star(f)}</span>` +
        `<input class="input" data-k="${f.k}" type="date" lang="en-GB" placeholder="يوم/شهر/سنة" required></label>`;
    }
    const attrs = (f.type === 'num' ? 'inputmode="decimal"' : '') + (f.readonly ? ' readonly' : '');
    const ph = f.ph ? ` placeholder="${escHtml(f.ph)}"` : '';
    const list = f.list ? ` list="${escHtml(f.list)}"` : '';
    return `<label><span>${escHtml(f.t)}${star(f)}</span>` +
      `<input class="input" data-k="${f.k}" ${attrs}${ph}${list}></label>`;
  }).join('');
  /* تعبئة قوائم الأصناف من القائمة الموحدة + ربط التعبئة التلقائية للاسم/الوحدة */
  $$('#de-fields [data-type-items]').forEach(el => {
    fillItemSelect(el, 'اختر صنفاً…', el.dataset.pv);
    el.addEventListener('change', () => deItemAuto(deCat, el.dataset.k, el.value));
  });
  /* تعبئة القوائم المرجعية (مورد/مصدر/ميناء الوصول/ميناء التحميل) من شاشة «مراجع العقود» */
  $$('#de-fields [data-type-ref]').forEach(el => fillRefSelect(el, el.dataset.typeRef, el.dataset.pv));
  $$('#de-fields [data-type-company]').forEach(el => fillContractCompanySelect(el, el.dataset.pv));
  /* ملء تلقائي عند اختيار الرقم الداخلى من قائمة العقود */
  const intNoEl = $('#de-fields [data-k="internal_no"]');
  if (intNoEl) {
    intNoEl.addEventListener('change', async () => {
      const val = String(intNoEl.value || '').trim();
      if (!val || intNoEl.dataset.typeRef !== 'contract_registrations') return;
      try {
        const d = await api('/api/report?name=contract-registrations-raw&page=1&pageSize=5000');
        const row = (d && d.rows || []).find(r => String(r.internal_no) === val || String(r.contract_no || '') === val || String(r.id) === val);
        if (!row) return;
        const fields = {supplier:'supplier',contract_no:'contract_no',classification:'classification',contract_exchange:'contract_exchange',expected_payment_date:'expected_payment_date',expected_cif_price:'expected_cif_price',quantity:'quantity',detail_quantity:'detail_quantity',contract_premium:'contract_premium',shipping_type:'shipping_type',shipping_value:'shipping_value',initial_price:'initial_price',contract_status:'contract_status',contracting_company:'contracting_company',internal_company:'internal_company',source_country:'source_country',vessel_name:'vessel_name',arrival_port:'arrival_port',expected_arrival:'expected_arrival',operation_start:'operation_start',operation_end:'operation_end',vessel_status:'vessel_status',notes:'notes',item:'classification'};
        Object.entries(fields).forEach(([formKey, dbKey]) => {
          const target = document.querySelector(`#de-fields [data-k="${formKey}"]`);
          if (target && row[dbKey] !== undefined && row[dbKey] !== null) target.value = String(row[dbKey]);
        });
      } catch (_) {}
    });
  }
}

/* حقول مشتقة تُملأ تلقائياً عند اختيار صنف من القائمة (حسب الشاشة) */
const ITEM_AUTO = {
  movements: { item_desc: i => i.descr, uom: i => i.uom },
  sales:     { item_desc: i => i.descr },
  balances:  { item_desc: i => i.descr },
  prices:    { item: i => i.descr },
};
function deItemAuto(cat, k, code) {
  const map = ITEM_AUTO[cat];
  if (!map) return;
  const it = ITEMS_BY_CODE.get(String(code || ''));
  Object.entries(map).forEach(([fk, get]) => {
    if (fk === k) return;
    const el = document.querySelector(`#de-fields [data-k="${fk}"]`);
    if (el && !el.disabled) el.value = it ? get(it) : '';
  });
}

function deCollect() {
  const data = {};
  $$('#de-fields [data-k]').forEach(el => { data[el.dataset.k] = el.value.trim(); });
  return data;
}

function deReset() {
  deEditId = null;
  const form = $('#de-form'); if (form) form.reset();
  $$('#de-fields [data-type-items]').forEach(el => { delete el.dataset.pv; });
  $$('#de-fields [data-type-ref]').forEach(el => { delete el.dataset.pv; });
  const b = $('#de-save-btn'); if (b) { b.textContent = 'حفظ'; b.disabled = false; }
  const r = $('#de-reset'); if (r) r.style.display = 'none';
  const e = $('#de-err'); if (e) { e.hidden = true; e.textContent = ''; }
  const ino = $('#de-fields [data-k="internal_no"]');
  if (ino) { ino.disabled = false; ino.readOnly = true; }
}

async function loadManualList() {
  if (!deCat) return;
  const host = $('#tbl-de');
  try {
    const d = await api('/api/daily/list?cat=' + encodeURIComponent(deCat) + '&limit=300');
    const rows = (d && d.rows) || [];
    deRowsById = {};
    rows.forEach(r => { deRowsById[r.id] = r; });
    table(host, DE_COLS[deCat], rows, { empty: 'لا توجد سجلات يدوية بعد — أضف صفاً من الأعلى' });
    const c = $('#de-count'); if (c) c.textContent = rows.length + ' سجل يدوي';
    $$('#tbl-de [data-de-edit]').forEach(b => b.addEventListener('click', () => deEdit(b.dataset.deEdit)));
    $$('#tbl-de [data-de-del]').forEach(b => b.addEventListener('click', () => deDelete(b.dataset.deDel)));
  } catch (e) {
    host.innerHTML = `<div class="muted" style="padding:12px">${escHtml(e.message)}</div>`;
  }
}

function deFill(row) {
  if (!row) return;
  deEditId = Number(row.id);
  $$('#de-fields [data-k]').forEach(el => {
    const v = row[el.dataset.k];
    el.value = (v === null || v === undefined) ? ''
      : el.type === 'date' ? String(v).slice(0, 10) : v;
    /* قفل الرقم الداخلى نهائياً أثناء التعديل */
    if (el.dataset.k === 'internal_no' && deEditId) { el.disabled = true; el.readOnly = true; }
    /* لقوائم الأصناف: احفظ القيمة بحيث تُطبَّق */
    if (el.hasAttribute('data-type-items')) { el.dataset.pv = el.value; }
    /* للمراجع: أعد تعبئة القائمة */
    if (el.hasAttribute('data-type-ref')) { el.dataset.pv = el.value; fillRefSelect(el, el.dataset.typeRef, el.value); }
    if (el.hasAttribute('data-type-company')) { el.dataset.pv = el.value; fillContractCompanySelect(el, el.value); }
  });
  const b = $('#de-save-btn'); if (b) b.textContent = 'حفظ التعديل';
  const rs = $('#de-reset'); if (rs) rs.style.display = '';
  const e = $('#de-err'); if (e) { e.hidden = true; e.textContent = ''; }
  $('#de-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function deEdit(id) { deFill(deRowsById[id]); }

async function deDelete(id, cat) {
  cat = cat || deCat;
  if (!confirm('حذف هذا السجل اليدوي نهائياً؟')) return;
  try {
    await api('/api/daily/delete', { method: 'POST', headers: hdr, body: JSON.stringify({ cat, id }) });
    toast('تم الحذف ✔');
    if (deEditId === Number(id)) deReset();
    await loadManualList();
    loadConView().catch(() => {});
    if (conSelectedNo) loadContractDetails().catch(() => {});
    const cfg = DAILY_CATS[cat];
    if (cfg && cfg.reload) cfg.reload().catch(() => {});
  } catch (e) { toast('خطأ: ' + e.message); }
}

async function openManual(cat) {
  if (!can('import')) { toast('دورك لا يملك صلاحية الإدخال — اطلب من المدير تفعيلها'); return; }
  if (!DE_FIELDS[cat]) return;
  deCat = cat;
  $('#de-cat').textContent = '— ' + (DAILY_CATS[cat] ? DAILY_CATS[cat].label : cat);
  await loadRefs();
  mdLoc = await api('/api/md/locs');           // ← تحميل الشركات الجديدة
  deReset();
  deBuildFields();
  wireContractNoPreview();
  $('#de-modal').hidden = false;
  loadManualList();
}

/* تسجيل عقد جديد: يظهر «الرقم داخلي» التالي تلقائياً بمجرد اختيار التصنيف والتاريخ */
function wireContractNoPreview() {
  if (deCat !== 'contract_registrations') return;
  const noEl = $('#de-fields [data-k="internal_no"]');
  const clsEl = $('#de-fields [data-k="classification"]');
  const dateEl = $('#de-fields [data-k="contract_date"]');
  if (!noEl || !clsEl || !dateEl) return;
  const refresh = async () => {
    if (deEditId) return;                       /* في التعديل لا نُولّد */
    if (noEl.value.trim()) return;              /* رقم مُدخل يدوياً */
    const classification = clsEl.value.trim(), date = dateEl.value.trim();
    if (!classification || !date) return;
    try {
      const d = await api('/api/daily/preview-no?classification=' + encodeURIComponent(classification)
        + '&date=' + encodeURIComponent(date));
      if (d && d.internal_no && !noEl.value.trim()) noEl.value = d.internal_no;
    } catch (_) {}
  };
  ['change', 'blur'].forEach(ev => { clsEl.addEventListener(ev, refresh); dateEl.addEventListener(ev, refresh); });
}

$('#de-form')?.addEventListener('submit', async ev => {
  ev.preventDefault();
  if (!deCat) return;
  const err = $('#de-err');
  if (err) { err.hidden = true; err.textContent = ''; }
  const btn = $('#de-save-btn');
  const editing = !!deEditId;
  if (btn) { btn.disabled = true; btn.textContent = 'جاري الحفظ…'; }
  try {
    await api('/api/daily/save', {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ cat: deCat, id: deEditId || undefined, data: deCollect() }),
    });
    toast(editing ? 'تم تعديل السجل ✔' : 'تمت الإضافة ✔');
    deReset();
    await loadManualList();
    loadConView().catch(() => {});
    const cfg = DAILY_CATS[deCat];
    if (cfg && cfg.reload) cfg.reload().catch(() => {});
  } catch (e) {
    if (err) { err.hidden = false; err.textContent = e.message; }
    toast('خطأ: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = editing ? 'حفظ التعديل' : 'حفظ'; }
  }
});
$('#de-reset')?.addEventListener('click', deReset);
$('#de-refresh')?.addEventListener('click', () => loadManualList());

$$('[data-manual]').forEach(b => b.addEventListener('click', () => openManual(b.dataset.manual)));

$$('nav button').forEach(b => {
  if (b.closest('.nav-tools')) return;   // أزرار الأدوات لها معالجاتها الخاصة — ليست تنقلاً
  if (b.dataset.repGrp || b.dataset.repName) return;   // قوائم التقارير المتتالية لها معالجها الخاص
  if (b.dataset.conStep) return;
  if (b.dataset.submenu) return;   // أزرار القوائم الجانبية لها معالجها الخاص   // خطوات العقود في القائمة المنسدلة لها معالجها الخاص
  if (b.dataset.goto) { b.addEventListener('click', () => {
    if (b.dataset.pane && typeof mdRefPane !== 'undefined') mdRefPane = b.dataset.pane;
    gotoGroupSub(b.dataset.grp, b.dataset.goto, b.dataset.panel);
  }); return; }
  b.addEventListener('click', (ev) => {
    if (b.hasAttribute('data-platform-home')) {
      ev.preventDefault();
      closeNavMenus();
      openPlatformHome();
      return;
    }
    if (b.dataset.drop === 'platform' && !(ev.target && ev.target.closest && ev.target.closest('.caret'))) {
      toggleNavMenu('platform');
      return;
    }
    if (b.dataset.drop) { toggleNavMenu(b.dataset.drop); return; }
    $$('nav button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    current = b.dataset.tab;
    rememberScreen(current);
    if (MD_GROUPS[current]) { showMdLanding(current); return; }
    $$('section').forEach(s => s.classList.remove('active'));
    $('#tab-' + current).classList.add('active');
    const t = titleFor(current);
    setHead(t[0], t[1]);
    $('#sidebar').classList.remove('open');
    loadTab(current).catch(e => toast('خطأ: ' + e.message))
      .then(() => { if (window.UiLayout && window.UiLayout.apply) { try { window.UiLayout.apply(); } catch (e) { /* تجاهل */ } } });
  });
});

async function loadTab(name) {
  /* حماية الشاشات: الشاشة غير المسموحة لدورك لا تُحمَّل */
  if (isPlatformHome(name)) {
    if (window.PlatformShell && typeof window.PlatformShell.renderHome === 'function') {
      window.PlatformShell.renderHome();
    }
    if (window.PlatformShell && typeof window.PlatformShell.loadStatus === 'function') {
      window.PlatformShell.loadStatus().catch(() => {});
    }
    return;
  }
  /* التبويبات القديمة المدموجة (workflow · workcenter · reports-manager) ⇒ القسم المضيف */
  name = platformHost(name);
  if (!isAdmin() && me && Array.isArray(me.tabs) && me.tabs.length && !tabAllowed(name)) {
    const alt = me.tabs[0];
    toast('شاشة «' + (TITLES[name] || ['', name])[0] + '» غير مسموحة لدورك');
    if (alt && alt !== name) return goTab(alt);
    return;
  }
  if (name === 'dashboard') return loadDashboard();
  /* فلاتر الأصناف في الشاشات اليومية ومركز التقارير تُملأ من القائمة الموحدة (بالكود) */
  const itemFilter = { movements: 'mf-item', sales: 'sf-item', inventory: 'if-item', reports: 'rf-item' }[name];
  if (itemFilter) fillItemSelect(document.getElementById(itemFilter), 'الكل');
  if (name === 'md-items') return loadMdItems();
  if (name === 'md-locations') return loadMdLocations();
  if (name === 'md-movetypes') return loadMdMtypes();
  if (name === 'md-contractrefs') return loadMdRefs();
  if (name === 'inventory') return loadInventory();
  if (name === 'sales') return loadSales();
  if (name === 'movements') return loadMovements();
  if (name === 'borse') return loadBorse();
  if (name === 'prices') return showPricesPane('view');
  if (name === 'costs') return loadCosts();

  /* الشاشات الثلاث للمنصة: تفعيل اللوحة النشطة + شريط الحالة (قبل تحميل محتوى اللوحة) */
  if (PLATFORM_SCREENS.indexOf(name) >= 0) {
    if (window.PlatformShell) {
      window.PlatformShell.activate(name);
      window.PlatformShell.loadStatus().catch(() => {});
    }
  }
  if (name === 'reports') return loadReports();
  if (name === 'report-studio') { if (typeof window.loadReportStudioTab === 'function') window.loadReportStudioTab(); return; }
  if (name === 'analysis') {
    if (typeof window.loadAnalysisTab === 'function') window.loadAnalysisTab();
    if (typeof window.loadWorkflowTab === 'function') window.loadWorkflowTab();
    return;
  }
  if (name === 'screen-studio') { if (typeof window.loadScreenStudioTab === 'function') window.loadScreenStudioTab(); return; }
  /* الشاشات المخصّصة (cs_*) — تُعرض من قسمها المبني وقت التشغيل */
  if (String(name || '').indexOf('cs_') === 0) {
    if (typeof window.openCustomScreen === 'function') window.openCustomScreen(name);
    return;
  }
}


/* زر مسح فلاتر التقارير — التاريخ والبحث والأبعاد */
$('#rf-groupby')?.addEventListener('change', () => {
  const host = $('#rep-table');
  if (host) host.__groupBy = document.getElementById('rf-groupby')?.value || '';
  if (typeof tablePaint === 'function' && host) tablePaint(host);
});
/* ---------- قوائم التقارير المنسدلة في الشريط الجانبي ---------- */
const REP_GROUPS_NAV = {
  sales: { label: 'تقارير مبيعات', icon: '◈' },
  store: { label: 'تقارير مخازن', icon: '⇄' },
  bal:   { label: 'تقارير أرصدة', icon: '◫' },
  pbix:  { label: 'تقارير Power BI (عقود)', icon: '📊' },
};

async function fillRepSubMenu(grp) {
  const host = document.getElementById('rep-sub-list');
  if (!host) return;
  if (!reportList.length) {
    try { await loadReports(); } catch (e) { host.innerHTML = '<div class="muted" style="padding:8px">' + e.message + '</div>'; return; }
  }
  const seen = new Set(repGroupKeys(grp));
  const order = new Map(repGroupKeys(grp).map((k, i) => [k, i]));
  const items = reportList.filter(r => seen.has(r.name) && r.name !== 'contract-unified')
    .sort((a, b) => (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99));
  const extra = reportList.filter(r => !reportGroupOf(r.name) && r.name !== 'contract-unified');
  const all = [...items, ...extra];
  host.innerHTML = all.map(r =>
    '<button data-rep-name="' + escHtml(r.name) + '"><i>' + escHtml(reportGroupOf(r.name) ? REP_GROUPS_NAV[reportGroupOf(r.name)]?.icon || '▤' : '▤') + '</i><span>' + escHtml(r.label) + '</span></button>'
  ).join('');
}

$$('nav [data-rep-grp]').forEach(b => {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const grp = b.dataset.repGrp;
    $$('nav [data-rep-grp]').forEach(x => x.classList.toggle('on', x === b));
    const menu = b.closest('.nav-menu');
    const r = menu ? menu.getBoundingClientRect() : { right: 0, left: 0, top: 0 };
    const sub = document.getElementById('nav-rep-sub');
    if (sub) {
      sub.hidden = false;
      const w = sub.offsetWidth || 250;
      /* دائماً على اليسار — بفجوة واضحة فلا تغطي الأولى */
      sub.style.left = Math.round(Math.max(8, r.left - w - 14)) + 'px';
      sub.style.top = Math.round(Math.max(8, r.top)) + 'px';
      syncDropOpen();
      fillRepSubMenu(grp).catch(() => {});
    }
    /* القائمة الأولى لا تختفي */
  });
});

/* قائمة فرعية داخل قائمة منسدلة (مثل «بيانات يومية» داخل «تسجيل البيانات») */
/* قائمة جانبية داخل قائمة منسدلة (بيانات يومية / الأسعار والتكلفة / عقود الاستيراد) */
$$('nav [data-submenu]').forEach(b => {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const sub = document.getElementById(b.dataset.submenu);
    if (!sub) return;
    const menu = b.closest('.nav-menu');
    const r = menu ? menu.getBoundingClientRect() : { left: 0, top: 0 };
    const willOpen = sub.hidden;
    /* إغلاق أي قائمة جانبية أخرى مفتوحة */
    $$('.nav-menu.nav-sub').forEach(m => { if (m !== sub) m.hidden = true; });
    $$('nav [data-submenu]').forEach(x => { if (x !== b) x.classList.remove('on'); });
    sub.hidden = !willOpen;
    b.classList.toggle('on', willOpen);
    if (!willOpen) { syncDropOpen(); return; }
    /* الموضع: على يسار القائمة الأصلية (RTL) مع منع الخروج عن حدود الشاشة */
    const w = sub.offsetWidth || 250, hgt = sub.offsetHeight || 200;
    const left = Math.min(Math.max(8, r.left - w - 14), Math.max(8, window.innerWidth - w - 8));
    const top = Math.min(Math.max(8, r.top), Math.max(8, window.innerHeight - hgt - 8));
    sub.style.left = Math.round(left) + 'px';
    sub.style.right = 'auto';
    sub.style.top = Math.round(top) + 'px';
    syncDropOpen();
  });
});

/* فتح شاشة التقارير مباشرة (من الاستعادة أو اختيار تقرير) — بلا فتح القوائم المنسدلة */
async function openReportsScreen(name) {
  closeNavMenus();
  fillItemSelect(document.getElementById('rf-item'), 'الكل');
  $$('nav .nav-drop').forEach(d => d.classList.remove('open'));
  $$('nav button').forEach(x => x.classList.remove('active'));
  /* مدخل التقارير الموحّد صار «منصة التحليل» (لا زر تقارير خارجي) */
  document.querySelector(dropBtnSel('platform'))?.classList.add('active');
  current = 'reports';
  $$('section').forEach(s => s.classList.remove('active'));
  const tab = document.getElementById('tab-reports');
  if (!tab) return false;
  tab.classList.add('active');
  if (!name) {
    const t = TITLES.reports || ['التقارير', ''];
    setHead(t[0], t[1]);
    await loadReports();
    return true;
  }
  if (!reportList.length) { try { await loadReports(); } catch (_) {} }
  const t = titleFor(name);
  setHead(t[0], '');
  applyReportRange(reportGroupOf(name));
  await showReport(name);
  return true;
}
function savedReport() { try { return localStorage.getItem('ccs-report') || ''; } catch (_) { return ''; } }
function rememberReport(name) { try { if (name) localStorage.setItem('ccs-report', name); } catch (_) {} }

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rep-name]');
  if (!btn) return;
  const name = btn.dataset.repName;
  rememberScreen('reports');
  rememberReport(name);
  repPage[name] = 1;
  currentRepGroup = reportGroupOf(name);
  openReportsScreen(name).catch(err => toast(err.message));
});

/* ---------------- لوحة التحكم — إدارة المستخدمين والصلاحيات فقط ---------------- */
async function loadDashboard() {
  const isAdminUser = isAdmin();
  const canUsers = can('users');
  const canSee = isAdminUser || canUsers;
  vis($('#dash-hero'), canSee);
  vis($('#dash-stats'), canSee);
  vis($('#card-tabperms'), isAdminUser);
  vis($('#card-users'), canUsers);
  vis($('#dash-hint'), !canSee);

  fillDashGreeting();
  if (canUsers) await initUsersForm();
  let tabsData = null, usersData = null;
  const jobs = [];
  if (isAdmin) jobs.push(loadTabPerms().then(d => { tabsData = d; }).catch(e => toast(e.message)));
  if (canUsers) jobs.push(renderUsers().then(u => { usersData = u; }).catch(() => {}));
  await Promise.all(jobs);
  renderDashStats(usersData, tabsData);
}

/* ---- التحية حسب الوقت + التاريخ + دور المستخدم ---- */
function fillDashGreeting() {
  const g = $('#dash-greeting');
  if (g && me) {
    const h = new Date().getHours();
    const hello = h < 12 ? 'صباح الخير' : h < 18 ? 'مساء الخير' : 'ليلة سعيدة';
    g.textContent = hello + '، ' + (me.full_name || me.username);
  }
  const d = $('#dash-date');
  if (d) d.textContent = new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date());
  const rn = $('#dash-role-name');
  if (rn && me) rn.textContent = me.roleLabel || roleLabels[me.role] || 'مدير';
}

/* ---- إحصاءات لوحة التحكم (عدّادة تصاعدية) ---- */
function renderDashStats(users, tabs) {
  const anim = (id, v) => { const el = $(id); if (el) animateNum(el, String(v)); };
  if (users) {
    anim('#st-users', users.length);
    anim('#st-active', users.filter(u => u.active).length);
    anim('#st-must', users.filter(u => u.must_change).length);
  }
  if (tabs) anim('#st-tabs', tabs.length);
}

/* ---- أيقونات الشاشات (مطابقة للشريط الجانبي) ---- */
const TAB_ICONS = {
  dashboard: '◧', 'md-items': '▦', 'md-locations': '⌂', 'md-movetypes': '⇅', 'md-contractrefs': '⛴',
  inventory: '◫', sales: '◈', movements: '⇄', borse: '⌁', prices: '¤',
  costs: '∑', reports: '⤓', contracts: '📄',
};
/* لون صورة المستخدم حسب اسمه */
const AVC = ['a1', 'a2', 'a3', 'a4', 'a5'];
const avc = s => {
  let n = 0;
  for (const c of String(s || '')) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return AVC[n % AVC.length];
};

/* ---- صلاحيات الشاشات: قائمة مستخدم ← شاشاته (للمدير فقط) ---- */
let tpAll = { tabs: [], users: [], perms: {} };
function tpRender() {
  const uid = $('#tp-user')?.value;
  const host = $('#tp-list');
  if (!host) return;
  const set = new Set((uid && tpAll.perms[uid]) || []);
  host.innerHTML = tpAll.tabs.map(t =>
    `<label class="tp-item" title="${escHtml(t.label)}">
       <label class="psw"><input type="checkbox" data-tab="${t.id}" ${set.has(t.id) ? 'checked' : ''}><i></i></label>
       <span class="scr"><i>${TAB_ICONS[t.id] || '◈'}</i><b>${escHtml(t.label)}</b></span>
     </label>`).join('');
}
async function loadTabPerms() {
  const d = await api('/api/tabs');
  tpAll = { tabs: d.tabs || [], users: (d.users || []).filter(u => u.role !== 'admin'), perms: d.perms || {} };
  const sel = $('#tp-user');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = tpAll.users.map(u =>
      `<option value="${u.id}">${escHtml(u.full_name || u.username)} — ${escHtml(u.roleLabel || u.role)}</option>`).join('')
      || '<option value="">لا يوجد مستخدمون</option>';
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
  }
  tpRender();
  return d.tabs;
}
$('#tp-user')?.addEventListener('change', tpRender);
$('#tp-list')?.addEventListener('change', e => {
  const cb = e.target.closest('input[data-tab]');
  if (!cb) return;
  const uid = $('#tp-user')?.value;
  if (!uid) return;
  const cur = new Set(tpAll.perms[uid] || []);
  if (cb.checked) cur.add(cb.dataset.tab); else cur.delete(cb.dataset.tab);
  tpAll.perms[uid] = [...cur];
});
$('#btn-tabperms-save')?.addEventListener('click', async () => {
  const btn = $('#btn-tabperms-save');
  const uid = $('#tp-user')?.value;
  if (!uid) { toast('اختر مستخدماً أولاً'); return; }
  btn.disabled = true;
  try {
    await api('/api/tabs/save', { method: 'POST', headers: hdr,
      body: JSON.stringify({ perms: { [uid]: tpAll.perms[uid] || [] } }) });
    toast('تم حفظ صلاحيات الشاشات ✔ — تُطبَّق على المستخدم عند إعادة تحميل شاشته');
  } catch (e) { toast('خطأ: ' + e.message); }
  finally { btn.disabled = false; }
});

/* ============ البيانات الأساسية: الأصناف والمواقع وأنواع الحركات ============ */
let mdItemsOrigin = 'all';
let mdItemsRows = [];
let mdGroupsList = [];    /* قيم مشتقة من items — لقوائم نموذج الصنف المنسدلة */
let mdClassesList = [];
let mdLocPane = 'companies';
let mdLoc = { companies: [], units: [], warehouses: [] };
let mdMtypes = [];
let mdMtypeCats = [];     /* التصنيفات المعرَّفة (صفوف kind='category' في movement_types) */

const mdOpen = id => { const el = $('#' + id); if (el) { el.hidden = false; el.querySelector('input,select')?.focus(); } };
const mdErr = (id, msg) => { const el = $('#' + id); if (el) { el.hidden = !msg; if (msg) el.textContent = msg; } };

/* ---------------- شاشة الأصناف ---------------- */
async function loadMdItems() {
  const canM = can('master');
  vis($('#md-add-drp'), canM);
  const [g, c] = await Promise.all([
    api('/api/md/items/groups').catch(() => []),
    api('/api/md/items/classes').catch(() => []),
  ]);
  mdGroupsList = g; mdClassesList = c;
  fillMdSelects();
  const setFilter = (sel, selTo, vals) => {
    const opts = vals.map(x => `<option value="${escHtml(x.code)}">${escHtml(x.code)} — ${escHtml(x.descr || '')}</option>`).join('');
    const set = (el, first) => {
      if (!el) return;
      const cur = el.value;
      el.innerHTML = `<option value="">${first}</option>` + opts;
      el.value = cur;
    };
    set($(sel), 'من…'); set($(selTo), 'إلى…');
  };
  setFilter('#md-items-group', '#md-items-group-to', g);
  setFilter('#md-items-class', '#md-items-class-to', c);
  await renderMdItems();
}

/* قوائم المجموعة والتصنيف في نموذج الصنف: خيار واحد «كود — اسم» */
function fillMdSelects() {
  const set = (sel, vals, none) => {
    const el = $(sel); if (!el) return;
    const cur = el.value;
    el.innerHTML = `<option value="">${escHtml(none)}</option>` +
      vals.map(x => `<option value="${escHtml(x.code)}">${escHtml(x.code)} — ${escHtml(x.descr || '')}</option>`).join('');
    el.value = cur;
  };
  set('#mi-group', mdGroupsList, '— بدون مجموعة —');
  set('#mi-class', mdClassesList, '— بدون تصنيف —');
}

/* مساعدة التسلسل: اختيار مجموعة يملأ تصنيفها الأب تلقائياً إن لم يُختار تصنيف */
function mdGroupToClass() {
  const gsel = $('#mi-group'), csel = $('#mi-class');
  if (!gsel || !csel) return;
  const g = mdGroupsList.find(x => x.code === gsel.value);
  if (g && g.class_code && !csel.value) { csel.value = g.class_code; }
}

async function renderMdItems() {
  resetSort();
  const q = ($('#md-items-q')?.value || '').trim();
  const grp = ($('#md-items-group')?.value || '').trim();
  const grpTo = ($('#md-items-group-to')?.value || '').trim();
  const cls = ($('#md-items-class')?.value || '').trim();
  const clsTo = ($('#md-items-class-to')?.value || '').trim();
  const clsState = ($('#md-items-clsstate')?.value || '').trim();
  const d = await api(`/api/md/items?origin=${mdItemsOrigin}&q=${encodeURIComponent(q)}&limit=20000`
    + (grp ? '&group_from=' + encodeURIComponent(grp) : '') + (grpTo ? '&group_to=' + encodeURIComponent(grpTo) : '')
    + (cls ? '&cls_from=' + encodeURIComponent(cls) : '') + (clsTo ? '&cls_to=' + encodeURIComponent(clsTo) : '')
    + (clsState ? '&clsstate=' + encodeURIComponent(clsState) : ''));
  mdItemsRows = d;
  const mine = d.filter(r => r.origin !== 'movement').length;
  const cnt = $('#md-items-count');
  if (cnt) cnt.textContent =
    `${n0(d.length)} صنف معروض — مسجّل: ${n0(mine)} • مُجلب من الحركات: ${n0(d.length - mine)}`;
  const canM = can('master');
  table($('#tbl-md-items'), [
    { t: 'كود الصنف', k: 'code' },
    { t: 'اسم الصنف', k: 'descr' },
    { t: 'الوحدة', k: 'uom' },
    { t: 'مجموعة المواد', h: true, f: r => [r.group_code, r.group_desc].filter(Boolean).map(escHtml).join(' — ') },
    { t: 'التصنيف', h: true, f: r => [r.class_code, r.class_desc].filter(Boolean).map(escHtml).join(' — ') },
    { t: 'المصدر', h: true, f: r => r.origin === 'movement'
        ? '<span class="pill info">من الحركات</span>' : '<span class="pill">مسجّل</span>' },
    { t: 'تاريخ الإضافة', h: true, f: r => r.movement_sheet_date || '—' },
    { t: 'الحال', h: true, f: r => ({ SUB: 'صب', PACKED: 'معبأ', TANK: 'تنك', JUMBO: 'جامبو', BULK: 'سايب' }[r.status] || '—') },
    ...(canM ? [{ t: '', h: true, f: r => `<button class="btn sm ghost" data-item="${escHtml(r.code)}">✎ تعديل</button>` }] : []),
  ], d, { limit: 0, empty: 'لا توجد أصناف — استورد ملف الحركات وسيُجلب الموجود منها تلقائياً' });
}

/* تفصيل البيانات: الكل / تم تسجيلها / مجلوبة من الحركات — فلترة فورية */
$('#md-items-origin')?.addEventListener('change', () => {
  mdItemsOrigin = $('#md-items-origin').value || 'all';
  renderMdItems().catch(e => toast(e.message));
});
liveFilter(['md-items-q', 'md-items-clsstate', 'md-items-group', 'md-items-group-to',
  'md-items-class', 'md-items-class-to'], () => renderMdItems().catch(e => toast(e.message)), 300);
$('#md-items-q')?.addEventListener('keydown', e => { if (e.key === 'Enter') renderMdItems().catch(() => {}); });

$('#tbl-md-items')?.addEventListener('click', e => {
  const b = e.target.closest('[data-item]');
  if (b && can('master')) openMdItem(b.dataset.item);
});

/* --- نافذة الصنف: كود 9 خانات + اسم + وحدة + مجموعة + تصنيف --- */
function updMiCount() {
  const f = $('#md-item-form');
  if (!f) return;
  const editing = f.dataset.edit || '';
  const v = $('#mi-code').value.trim();
  const sameOld = !!editing && v === editing;
  const valid = /^\d{9}$/.test(v) || sameOld;
  const c = $('#mi-count');
  if (c) c.textContent = valid
    ? (sameOld && v.length !== 9 ? `${v.length} / 9 — الكود الحالي (بدون تغيير)` : '9 / 9 ✔')
    : `${v.length} / 9 — لا تُقبل الإضافة قبل اكتمال الـ9 خانات`;
  const btn = $('#mi-btn');
  if (btn) btn.disabled = !valid || !$('#mi-descr').value.trim() || !$('#mi-uom').value.trim();
}
['#mi-code', '#mi-descr', '#mi-uom'].forEach(s => $(s)?.addEventListener('input', updMiCount));

$('#mi-group')?.addEventListener('change', mdGroupToClass);

function openMdItem(code) {
  const f = $('#md-item-form');
  const pickRows = mdPick && mdPick.type === 'item' ? mdPickItems : [];
  const r = code ? (mdItemsRows.find(x => x.code === code) || pickRows.find(x => x.code === code)) : null;
  f.dataset.edit = r ? r.code : '';
  $('#md-item-title').textContent = r ? 'تعديل صنف' : 'إضافة صنف';
  $('#mi-code').value = r ? r.code : '';
  $('#mi-descr').value = r ? (r.descr || '') : '';
  $('#mi-uom').value = r ? (r.uom || '') : '';
  $('#mi-group').value = r ? (r.group_code || '') : '';
  $('#mi-class').value = r ? (r.class_code || '') : '';
  $('#mi-status').value = r ? (r.status || '') : '';
  mdErr('mi-err', null);
  updMiCount();
  mdOpen('md-item-modal');
}
$('#md-item-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const editing = f.dataset.edit || '';
  mdErr('mi-err', null);
  try {
    await api('/api/md/items/save', { method: 'POST', headers: hdr, body: JSON.stringify({
      code: $('#mi-code').value.trim(),
      descr: $('#mi-descr').value.trim(),
      uom: $('#mi-uom').value.trim(),
      groupCode: $('#mi-group').value.trim(),
      classCode: $('#mi-class').value.trim(),
      status: $('#mi-status').value.trim(),
      editCode: editing,
    }) });
    $('#md-item-modal').hidden = true;
    f.dataset.edit = '';
    toast(editing ? 'تم تعديل الصنف ✔' : 'تمت إضافة الصنف ✔');
    await renderMdItems();
  } catch (err) { mdErr('mi-err', err.message); }
});

/* --- نافذة المجموعة: كود + اسم --- */
function openMdGroup(code) {
  const f = $('#md-group-form');
  const pickRows = mdPick && mdPick.type === 'group' ? mdPickItems : [];
  const r = code ? (mdGroupsList.find(x => x.code === code) || pickRows.find(x => x.code === code)) : null;
  f.dataset.edit = r ? r.code : '';
  $('#md-group-title').textContent = r ? 'تعديل مجموعة' : 'إضافة مجموعة';
  $('#mg-code').value = r ? r.code : '';
  /* الكود مفتاح ثابت مرتبط بالأصناف والحركات — يُقفل عند التعديل لمنع إنشاء نسخة مكررة */
  $('#mg-code').readOnly = !!r;
  $('#mg-descr').value = r ? (r.descr || '') : '';
  mdErr('mg-err', null);
  mdOpen('md-group-modal');
}
$('#md-group-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const editing = f.dataset.edit || '';
  mdErr('mg-err', null);
  try {
    await api('/api/md/items/groups/save', { method: 'POST', headers: hdr, body: JSON.stringify({
      code: $('#mg-code').value.trim(), descr: $('#mg-descr').value.trim(), editCode: editing }) });
    $('#md-group-modal').hidden = true;
    f.dataset.edit = '';
    toast(editing ? 'تم تعديل المجموعة ✔' : 'تمت إضافة المجموعة ✔');
    mdGroupsList = await api('/api/md/items/groups');
    fillMdSelects();
  } catch (err) { mdErr('mg-err', err.message); }
});

/* --- نافذة التصنيف: كود + اسم --- */
function openMdClass(code) {
  const f = $('#md-class-form');
  const pickRows = mdPick && mdPick.type === 'class' ? mdPickItems : [];
  const r = code ? (mdClassesList.find(x => x.code === code) || pickRows.find(x => x.code === code)) : null;
  f.dataset.edit = r ? r.code : '';
  $('#md-class-title').textContent = r ? 'تعديل تصنيف' : 'إضافة تصنيف';
  $('#mc-code').value = r ? r.code : '';
  /* الكود مفتاح ثابت مرتبط بالأصناف والحركات — يُقفل عند التعديل لمنع إنشاء نسخة مكررة */
  $('#mc-code').readOnly = !!r;
  $('#mc-descr').value = r ? (r.descr || '') : '';
  mdErr('mc-err', null);
  mdOpen('md-class-modal');
}
$('#md-class-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const editing = f.dataset.edit || '';
  mdErr('mc-err', null);
  try {
    await api('/api/md/items/classes/save', { method: 'POST', headers: hdr, body: JSON.stringify({
      code: $('#mc-code').value.trim(), descr: $('#mc-descr').value.trim(), editCode: editing }) });
    $('#md-class-modal').hidden = true;
    f.dataset.edit = '';
    toast(editing ? 'تم تعديل التصنيف ✔' : 'تمت إضافة التصنيف ✔');
    mdClassesList = await api('/api/md/items/classes');
    fillMdSelects();
  } catch (err) { mdErr('mc-err', err.message); }
});

/* --- قائمة «إضافة بيانات»: صنف / مجموعة / تصنيف — كلٌّ بإضافة/تعديل/حذف ---
   تعديل/حذف يفتحان نافذة اختيار للسجل، والجلب من الحركات تلقائي مع كل استيراد */
let mdPick = null;        /* إعداد النافذة الحالية */
let mdPickItems = [];     /* سجلات النافذة الحالية */
let mdPickSeq = 0;        /* يمنع نتيجة طلب قديم من الكتابة فوق نافذة أحدث (سباق تحميل) */

/* نافذة اختيار عامة تُستخدمها كل شاشات «إضافة بيانات»:
   cfg = { title, label, noun, type, load, nameOf, onEdit, onDelete } */
async function openPicker(cfg) {
  const seq = ++mdPickSeq;                  /* أي فتح جديد يُلغي نتائج الطلبات السابقة */
  mdPick = cfg;
  mdPickItems = [];
  const sel = $('#md-pick-sel'), info = $('#md-pick-info');
  const editBtn = $('#md-pick-edit'), delBtn = $('#md-pick-del');
  if (editBtn) editBtn.disabled = true;     /* لا تعديل/حذف قبل اكتمال تحميل النوع الصحيح */
  if (delBtn) delBtn.disabled = true;
  $('#md-pick-title').textContent = cfg.title;
  const lbl = $('#md-pick-lbl'); if (lbl) lbl.firstChild.textContent = cfg.label + ' ';
  sel.innerHTML = '<option value="">جارٍ التحميل…</option>';
  if (info) info.textContent = '';
  $('#md-pick-modal').hidden = false;
  let rows = [], loadErr = '';
  try { rows = await cfg.load(); }
  catch (err) { loadErr = err.message; }
  if (seq !== mdPickSeq) return;            /* نتيجة متأخرة لنافذة أخرى — تجاهلها تماماً */
  mdPickItems = Array.isArray(rows) ? rows : [];
  const name = cfg.nameOf || (r => r.descr || r.name || '');
  if (loadErr) {
    sel.innerHTML = '<option value="">تعذّر التحميل</option>';
    if (info) info.textContent = 'تعذّر التحميل: ' + loadErr;
  } else {
    sel.innerHTML = mdPickItems.length
      ? mdPickItems.map(r => `<option value="${escHtml(r.code)}">${escHtml(r.code)} — ${escHtml(name(r))}</option>`).join('')
      : '<option value="">لا توجد بيانات</option>';
    if (info) info.textContent = `${n0(mdPickItems.length)} ${cfg.noun} متاح — اختر ثم اضغط «تعديل» أو «حذف»`;
  }
  if (editBtn) editBtn.disabled = false;
  if (delBtn) delBtn.disabled = false;
}

$('#md-pick-edit')?.addEventListener('click', () => {
  const code = $('#md-pick-sel').value;
  if (!code || !mdPickItems.some(r => r.code === code)) { toast('اختر عنصراً أولاً'); return; }
  $('#md-pick-modal').hidden = true;
  mdPick.onEdit(code);
});

$('#md-pick-del')?.addEventListener('click', async () => {
  const code = $('#md-pick-sel').value;
  if (!code || !mdPickItems.some(r => r.code === code)) { toast('اختر عنصراً أولاً'); return; }
  if (!confirm(`حذف ${mdPick.noun} «${code}» نهائياً؟`)) return;
  const btn = $('#md-pick-del'); if (btn) btn.disabled = true;
  try { await mdPick.onDelete(code); $('#md-pick-modal').hidden = true; }
  catch (err) { toast('خطأ: ' + err.message); }
  finally { if (btn) btn.disabled = false; }
});

/* بطاقة واحدة فقط لكل نوع داخل قوائم «إضافة بيانات».
   حذف العقد المكررة من DOM (وليس إخفاؤها بـ CSS) يمنع التكرار مهما كان مصدره
   — حتى لو أُعيد إلحاق عناصر أو بقيت نسخة قديمة في الصفحة. */
function normalizeAddMenu(menuSel, key) {
  const all = document.querySelectorAll(menuSel);
  for (let i = 1; i < all.length; i++) all[i].remove();   /* قائمة مكرّرة بنفس المعرّف */
  const menu = all[0]; if (!menu) return;
  const seen = new Set();
  [...menu.children].forEach(el => {
    if (!el.classList || !el.classList.contains('cpp-item')) return;
    const k = String((el.dataset || {})[key] || '');
    if (!k) return;
    if (seen.has(k)) { el.remove(); return; }
    seen.add(k);
  });
}
normalizeAddMenu('#md-add-menu', 'type');
normalizeAddMenu('#md-loc-add-menu', 'locType');
normalizeAddMenu('#md-mt-add-menu', 'mtType');

$('#md-add-btn')?.addEventListener('click', e => {
  e.stopPropagation();
  normalizeAddMenu('#md-add-menu', 'type');
  const m = $('#md-add-menu'); if (m) m.hidden = !m.hidden;
});
document.addEventListener('click', e => {
  const btn = e.target.closest('.filters-mv-menu > .btn[data-more]');
  if (btn) {
    e.stopPropagation();
    const pop = btn.parentElement.querySelector('.filters-mv-pop');
    if (!pop) return;
    const willOpen = pop.hidden;
    $$('.filters-mv-pop').forEach(m => { m.hidden = true; });
    pop.hidden = !willOpen;
    refreshMoreBadge();
    return;
  }
  if (e.target.closest('.filters-mv-menu')) return;   /* الضغط جوه القائمة متقفلّهاش */
  $$('.filters-mv-pop').forEach(m => { if (!m.hidden) m.hidden = true; });
  ['#md-add-menu', '#md-loc-add-menu', '#md-mt-add-menu'].forEach(s => {
    const m = $(s); if (m && !m.hidden) m.hidden = true;
  });
});
/* مؤشر عدد الفلاتر المُختارة داخل زر «فلاتر أخرى» */
function refreshMoreBadge() {
  $$('.filters-mv-menu').forEach(wrap => {
    const btn = wrap.querySelector('button[data-more]');
    const pop = wrap.querySelector('.filters-mv-pop');
    if (!btn || !pop) return;
    const n = [...pop.querySelectorAll('.fl')].filter(fl => {
      if (fl.hasAttribute('data-nocount')) return false;
      return [...fl.querySelectorAll('select, input')].some(el =>
        el.type === 'checkbox' ? el.checked : String(el.value || '').trim() !== '');
    }).length;
    btn.classList.toggle('has-on', n > 0);
    if (n > 0) btn.setAttribute('data-count', n); else btn.removeAttribute('data-count');
  });
}
document.addEventListener('change', e => { if (e.target.closest('.filterbar')) refreshMoreBadge(); });
document.addEventListener('input', e => { if (e.target.closest('.filterbar')) refreshMoreBadge(); });
document.addEventListener('click', e => { if (e.target.closest('.filterbar')) refreshMoreBadge(); });

$('#md-add-menu')?.addEventListener('click', e => {
  const it = e.target.closest('[data-type]');
  const act = e.target.closest('[data-act]');
  if (!it || !act) return;
  $('#md-add-menu').hidden = true;
  const type = it.dataset.type, a = act.dataset.act;
  if (a === 'add') {
    if (type === 'item') openMdItem(null);
    else if (type === 'group') openMdGroup(null);
    else openMdClass(null);
    return;
  }
  const noun = { item: 'الصنف', group: 'المجموعة', class: 'التصنيف' }[type];
  openPicker({
    title: 'إدارة ' + { item: 'الأصناف', group: 'المجموعات', class: 'التصنيفات' }[type],
    label: 'اختر ' + noun + ' المطلوب',
    noun: noun,
    type,
    nameOf: r => r.descr || r.name || '',
    load: () => type === 'item' ? api('/api/md/items?limit=20000')
      : type === 'group' ? api('/api/md/items/groups') : api('/api/md/items/classes'),
    onEdit: code => { if (type === 'item') openMdItem(code); else if (type === 'group') openMdGroup(code); else openMdClass(code); },
    onDelete: async code => {
      const url = '/api/md/items'
        + (type === 'group' ? '/groups' : type === 'class' ? '/classes' : '') + '/delete';
      await api(url, { method: 'POST', headers: hdr, body: JSON.stringify({ code }) });
      toast(`تم حذف ${noun} «${code}» ✔`);
      await loadMdItems();
    },
  });
});

/* ---------------- شاشة المواقع والمصانع ---------------- */
async function loadMdLocations() {
  const canM = can('master');
  vis($('#md-loc-add-drp'), canM);
  mdLoc = await api('/api/md/locs');
  renderMdLocPane();
}

function mdAct(type, code, label = '✎') {
  return can('master')
    ? `<button class="btn sm ghost" data-loc="${type}" data-code="${escHtml(code)}">${label}</button>`
    : '';
}

function renderMdLocPane() {
  const pane = mdLocPane;
  const qu = ($('#md-loc-q')?.value || '').trim().toLowerCase();
  const flt = arr => qu
    ? arr.filter(r => [r.code, r.name, r.place, r.unit_code, r.company_code, r.company_name]
        .some(x => String(x || '').toLowerCase().includes(qu)))
    : arr;
  $$('#md-loc-segs .seg').forEach(b => b.classList.toggle('on', b.dataset.pane === pane));
  vis($('#tbl-md-companies'), pane === 'companies');
  vis($('#tbl-md-units'), pane === 'units');
  vis($('#tbl-md-warehouses'), pane === 'warehouses');

  table($('#tbl-md-companies'), [
    { t: 'كود الشركة', k: 'code' },
    { t: 'اسم الشركة', k: 'name' },
    { t: 'العملة', k: 'currency' },
    { t: 'وحدات', n: 1, f: r => n0(r.units) },
    ...(can('master') ? [{ t: '', h: true, f: r => mdAct('company', r.code) }] : []),
  ], flt(mdLoc.companies), { empty: 'لا توجد شركات — اضغط «＋ شركة»' });

  table($('#tbl-md-units'), [
    { t: 'كود الوحدة', k: 'code' },
    { t: 'اسم الوحدة', k: 'name' },
    { t: 'الشركة', h: true, f: r => escHtml(r.company_name || r.company_code || '') },
    { t: 'العملة', k: 'currency' },
    { t: 'المكان', k: 'place' },
    ...(can('master') ? [{ t: '', h: true, f: r => mdAct('unit', r.code) }] : []),
  ], flt(mdLoc.units), { empty: 'لا توجد وحدات — اضغط «＋ وحدة»' });

  table($('#tbl-md-warehouses'), [
    { t: 'كود المخزن', k: 'code' },
    { t: 'اسم المخزن', k: 'name' },
    { t: 'الوحدة', h: true, f: r => escHtml(r.unit_code || '') },
    { t: 'الشركة', h: true, f: r => escHtml(r.company_code || '') },
    { t: 'المكان', k: 'place' },
    { t: 'الموقع', k: 'location_name' },
    { t: 'التصنيف', k: 'classification' },
    { t: 'تجمع المخازن', k: 'warehouse_group' },
    { t: 'أرصدة تقرير نشطة', h: true, f: r => `<input type="checkbox" data-wh-rep="${escHtml(r.code)}" ${r.report_active ? 'checked' : ''} ${can('master') ? '' : 'disabled'}>` },
    ...(can('master') ? [{ t: '', h: true, f: r => mdAct('wh', r.code) }] : []),
  ], flt(mdLoc.warehouses), { empty: 'لا توجد مخازن — اضغط «＋ مخزن» (أو ارفع البيانات دفعة واحدة لاحقاً)' });
}

$$('#md-loc-segs .seg').forEach(b => b.addEventListener('click', () => { mdLocPane = b.dataset.pane; renderMdLocPane(); }));
liveFilter(['md-loc-q'], () => renderMdLocPane(), 300);

['#tbl-md-companies', '#tbl-md-units', '#tbl-md-warehouses'].forEach(sel =>
  $(sel)?.addEventListener('click', e => {
    const b = e.target.closest('[data-loc]');
    if (b && can('master')) openMdLoc(b.dataset.loc, b.dataset.code);
  }));
$('#tbl-md-warehouses')?.addEventListener('change', async e => {
  const cb = e.target && e.target.closest ? e.target.closest('[data-wh-rep]') : null;
  if (!cb || !can('master')) return;
  try {
    await api('/api/md/locs/warehouse/report-active', { method: 'POST', headers: hdr, body: JSON.stringify({ code: cb.dataset.whRep, active: cb.checked }) });
    const w = mdLoc.warehouses.find(x => x.code === cb.dataset.whRep);
    if (w) w.report_active = cb.checked;
  } catch (err) {
    cb.checked = !cb.checked;
    toast(err.message || 'فشل التحديث');
  }
});

function fillCompanySelect(sel, val) {
  $(sel).innerHTML = '<option value="">— اختر الشركة —</option>' +
    mdLoc.companies.map(c =>
      `<option value="${escHtml(c.code)}" ${c.code === val ? 'selected' : ''}>${escHtml(c.code)} — ${escHtml(c.name)}</option>`).join('');
}

function openMdLoc(type, code) {
  if (type === 'company') {
    const r = code ? mdLoc.companies.find(x => x.code === code) : null;
    const f = $('#md-comp-form');
    f.dataset.edit = r ? r.code : '';
    $('#md-comp-title').textContent = r ? 'تعديل شركة' : 'إضافة شركة';
    $('#mco-code').value = r ? r.code : '';
    $('#mco-name').value = r ? r.name : '';
    $('#mco-ccy').value = r ? (r.currency || '') : '';
    mdErr('mco-err', null);
    mdOpen('md-comp-modal');
    return;
  }
  if (type === 'unit') {
    const r = code ? mdLoc.units.find(x => x.code === code) : null;
    const f = $('#md-unit-form');
    f.dataset.edit = r ? r.code : '';
    $('#md-unit-title').textContent = r ? 'تعديل وحدة' : 'إضافة وحدة';
    $('#mu-code').value = r ? r.code : '';
    $('#mu-name').value = r ? r.name : '';
    fillCompanySelect('#mu-company', r ? r.company_code : '');
    $('#mu-place').value = r ? (r.place || '') : '';
    mdErr('mu-err', null);
    mdOpen('md-unit-modal');
    return;
  }
  /* مخزن */
  const r = code ? mdLoc.warehouses.find(x => x.code === code) : null;
  const f = $('#md-wh-form');
  f.dataset.edit = r ? r.code : '';
  $('#md-wh-title').textContent = r ? 'تعديل مخزن' : 'إضافة مخزن';
  $('#mw-code').value = r ? r.code : '';
  $('#mw-name').value = r ? r.name : '';
  $('#mw-unit').innerHTML = '<option value="">— اختر الوحدة —</option>' +
    mdLoc.units.map(x =>
      `<option value="${escHtml(x.code)}" ${r && x.code === r.unit_code ? 'selected' : ''}>${escHtml(x.code)} — ${escHtml(x.name)}</option>`).join('');
  const u = r ? mdLoc.units.find(x => x.code === r.unit_code) : null;
  $('#mw-company-hint').textContent = u
    ? `الشركة: ${u.company_name || u.company_code} • المكان: ${u.place || '—'}`
    : 'اختر الوحدة لعرض الشركة التابعة';
  $('#mw-place').value = r ? (r.place || '') : '';
  $('#mw-location').value = r ? (r.location_name || '') : '';
  $('#mw-classification').value = r ? (r.classification || '') : '';
  $('#mw-whgroup').value = r ? (r.warehouse_group || '') : '';
   if ($('#mw-report-active')) $('#mw-report-active').checked = !!(r && r.report_active);
  mdErr('mw-err', null);
  mdOpen('md-wh-modal');
}
/* قائمة «إضافة بيانات» في المواقع: شركة / موقع / مخزن — كلٌّ بإضافة/تعديل/حذف */
$('#md-loc-add-btn')?.addEventListener('click', e => {
  e.stopPropagation();
  normalizeAddMenu('#md-loc-add-menu', 'locType');
  const m = $('#md-loc-add-menu'); if (m) m.hidden = !m.hidden;
});
$('#md-loc-add-menu')?.addEventListener('click', e => {
  const it = e.target.closest('[data-loc-type]');
  const act = e.target.closest('[data-act]');
  if (!it || !act) return;
  $('#md-loc-add-menu').hidden = true;
  const type = it.dataset.locType, a = act.dataset.act;
  if (a === 'add') { openMdLoc(type, null); return; }
  const noun = { company: 'الشركة', unit: 'الموقع', wh: 'المخزن' }[type];
  const listKey = { company: 'companies', unit: 'units', wh: 'warehouses' }[type];
  const ep = { company: 'company', unit: 'unit', wh: 'warehouse' }[type];
  openPicker({
    title: 'إدارة ' + { company: 'الشركات', unit: 'المواقع', wh: 'المخازن' }[type],
    label: 'اختر ' + noun + ' المطلوب',
    noun: noun,
    type: 'loc:' + type,
    nameOf: r => r.name || '',
    load: () => api('/api/md/locs').then(d => d[listKey] || []),
    onEdit: code => openMdLoc(type, code),
    onDelete: async code => {
      await api(`/api/md/locs/${ep}/delete`, { method: 'POST', headers: hdr, body: JSON.stringify({ code }) });
      toast(`تم حذف ${noun} «${code}» ✔`);
      await loadMdLocations();
    },
  });
});

/* اختيار الوحدة: يعرض الشركة، ويملأ المكان إن كان فارغاً */
$('#mw-unit')?.addEventListener('change', () => {
  const u = mdLoc.units.find(x => x.code === $('#mw-unit').value);
  $('#mw-company-hint').textContent = u
    ? `الشركة: ${u.company_name || u.company_code} • المكان: ${u.place || '—'}`
    : 'اختر الوحدة لعرض الشركة التابعة';
  if (u && u.place && !$('#mw-place').value.trim()) $('#mw-place').value = u.place;
});

$('#md-comp-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const editing = f.dataset.edit || '';
  mdErr('mco-err', null);
  try {
    await api('/api/md/locs/company/save', { method: 'POST', headers: hdr, body: JSON.stringify({
      code: $('#mco-code').value.trim(), name: $('#mco-name').value.trim(),
      currency: $('#mco-ccy').value.trim(), editCode: editing }) });
    $('#md-comp-modal').hidden = true;
    f.dataset.edit = '';
    toast(editing ? 'تم تعديل الشركة ✔' : 'تمت إضافة الشركة ✔');
    await loadMdLocations();
  } catch (err) { mdErr('mco-err', err.message); }
});

$('#md-unit-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const editing = f.dataset.edit || '';
  mdErr('mu-err', null);
  try {
    await api('/api/md/locs/unit/save', { method: 'POST', headers: hdr, body: JSON.stringify({
      code: $('#mu-code').value.trim(), name: $('#mu-name').value.trim(),
      company: $('#mu-company').value, place: $('#mu-place').value.trim(), editCode: editing }) });
    $('#md-unit-modal').hidden = true;
    f.dataset.edit = '';
    toast(editing ? 'تم تعديل الوحدة ✔' : 'تمت إضافة الوحدة ✔');
    await loadMdLocations();
  } catch (err) { mdErr('mu-err', err.message); }
});

$('#md-wh-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const editing = f.dataset.edit || '';
  mdErr('mw-err', null);
  try {
    await api('/api/md/locs/warehouse/save', { method: 'POST', headers: hdr, body: JSON.stringify({
      code: $('#mw-code').value.trim(), name: $('#mw-name').value.trim(),
      unit: $('#mw-unit').value, place: $('#mw-place').value.trim(),
      locationName: $('#mw-location').value.trim(),
      classification: $('#mw-classification').value.trim(),
      warehouseGroup: $('#mw-whgroup').value.trim(),
       reportActive: $('#mw-report-active')?.checked || false, editCode: editing }) });
    $('#md-wh-modal').hidden = true;
    f.dataset.edit = '';
    toast(editing ? 'تم تعديل المخزن ✔' : 'تمت إضافة المخزن ✔');
    await loadMdLocations();
  } catch (err) { mdErr('mw-err', err.message); }
});

/* ---------------- شاشة مراجع العقود (موردين/مصادر/موانئ) ---------------- */
const REF_LABELS = { supplier: 'الموردين', source: 'المصادر', arrival_port: 'موانئ الوصول', loading_port: 'موانئ التحميل' };
const REF_NOUN = { supplier: 'المورد', source: 'المصدر', arrival_port: 'ميناء الوصول', loading_port: 'ميناء التحميل' };
let mdRefPane = 'supplier';
let mdRefRows = [];

async function loadMdRefs() {
  vis($('#md-ref-add'), can('master'));
  const refTitle = $('#tab-md-contractrefs h3');
  if (refTitle) refTitle.innerHTML = 'مراجع العقود <small>' + (REF_LABELS[mdRefPane] || '') + '</small>';
  await renderMdRefs();
}

async function renderMdRefs() {
  const pane = mdRefPane;
  try {
    mdRefRows = await api('/api/md/refs?kind=' + encodeURIComponent(pane));
  } catch (e) {
    $('#tbl-md-refs').innerHTML = `<div class="muted" style="padding:12px">${escHtml(e.message)}</div>`;
    return;
  }
  const qu = ($('#md-ref-q')?.value || '').trim().toLowerCase();
  const rows = qu
    ? mdRefRows.filter(r => [r.code, r.name].some(x => String(x || '').toLowerCase().includes(qu)))
    : mdRefRows;
  const canM = can('master');
  table($('#tbl-md-refs'), [
    { t: 'الكود', k: 'code' },
    { t: 'الاسم', k: 'name' },
    ...(canM ? [{ t: '', h: true, f: r =>
      `<button class="btn sm ghost" data-ref-edit="${escHtml(r.code)}">✎ تعديل</button> ` +
      `<button class="btn sm danger" data-ref-del="${escHtml(r.code)}">🗑 حذف</button>` }] : []),
  ], rows, { empty: 'لا توجد بيانات — اضغط «＋ إضافة»' });
}

$('#md-ref-q')?.addEventListener('keydown', e => { if (e.key === 'Enter') renderMdRefs().catch(() => {}); });
liveFilter(['md-ref-q'], () => renderMdRefs().catch(() => {}), 250);
$('#md-ref-clear')?.addEventListener('click', () => {
  const q = $('#md-ref-q'); if (q) q.value = '';
  renderMdRefs().catch(() => {});
});
$('#md-ref-add')?.addEventListener('click', () => openMdRef(null, mdRefPane));
$('#tbl-md-refs')?.addEventListener('click', e => {
  const ed = e.target.closest('[data-ref-edit]');
  const dl = e.target.closest('[data-ref-del]');
  if (ed && can('master')) openMdRef(ed.dataset.refEdit, mdRefPane);
  else if (dl && can('master')) delMdRef(dl.dataset.refDel);
});

function openMdRef(code, kind) {
  const f = $('#md-ref-form'); if (!f) return;
  const r = code ? mdRefRows.find(x => x.code === code) : null;
  f.dataset.edit = r ? r.code : '';
  f.dataset.kind = kind || mdRefPane;
  $('#md-ref-title').textContent = (r ? 'تعديل ' : 'إضافة ') + (REF_NOUN[f.dataset.kind] || '');
  $('#mr-kind').value = REF_LABELS[f.dataset.kind] || '';
  $('#mr-code').value = r ? r.code : '';
  $('#mr-code').placeholder = r ? '' : 'تلقائي';
  $('#mr-name').value = r ? (r.name || '') : '';
  mdErr('mr-err', null);
  mdOpen('md-ref-modal');
}

async function delMdRef(code) {
  const r = mdRefRows.find(x => x.code === code);
  if (!confirm(`حذف «${(r && r.name) || code}» نهائياً؟`)) return;
  try {
    await api('/api/md/refs/delete', { method: 'POST', headers: hdr,
      body: JSON.stringify({ kind: mdRefPane, code }) });
    toast('تم الحذف ✔');
    REFS = null;                       /* إبطال كاش النماذج المنسدلة */
    await renderMdRefs();
  } catch (e) { toast('تعذّر الحذف: ' + e.message); }
}

$('#md-ref-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const editing = f.dataset.edit || '';
  mdErr('mr-err', null);
  try {
    await api('/api/md/refs/save', { method: 'POST', headers: hdr, body: JSON.stringify({
      kind: f.dataset.kind, code: $('#mr-code').value.trim(),
      name: $('#mr-name').value.trim(), editCode: editing }) });
    $('#md-ref-modal').hidden = true;
    f.dataset.edit = '';
    REFS = null;                       /* إبطال كاش النماذج المنسدلة */
    toast(editing ? 'تم التعديل ✔' : 'تمت الإضافة ✔');
    await renderMdRefs();
  } catch (err) { mdErr('mr-err', err.message); }
});

/* ---------------- شاشة أنواع الحركات ---------------- */
async function loadMdMtypes() {
  vis($('#md-mt-add-drp'), can('master'));
  await renderMdMtypes();
}

async function renderMdMtypes() {
  resetSort();
  const q = ($('#md-mtype-q')?.value || '').trim();
  mdMtypes = await api('/api/md/mtypes?q=' + encodeURIComponent(q));
  /* التصنيفات المُعرَّفة (صفوف kind='category' في نفس الجدول) */
  mdMtypeCats = await api('/api/md/mtypes/categories').catch(() => []);
  /* نملأ قائمتَي «من / إلى» بأسماء التصنيفات المعرَّفة + أي تصنيف مستخدم فعلاً (مع الحفاظ على الاختيار) */
  const catSel = $('#md-mtype-cat'), catSelTo = $('#md-mtype-cat-to');
  if (catSel) {
    const cur = catSel.value, curTo = catSelTo ? catSelTo.value : '';
    const vals = [...new Set([
      ...mdMtypeCats.map(r => String(r.name || '').trim()),
      ...mdMtypes.map(r => String(r.category || '').trim()),
    ].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
    const opts = '<option value="">كل التصنيفات</option>' +
      vals.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
    catSel.innerHTML = opts;
    if ([...catSel.options].some(o => o.value === cur)) catSel.value = cur;
    if (catSelTo) { catSelTo.innerHTML = opts; if ([...catSelTo.options].some(o => o.value === curTo)) catSelTo.value = curTo; }
  }
  const cat = $('#md-mtype-cat')?.value || '';
  const catTo = $('#md-mtype-cat-to')?.value || '';
  const dirState = $('#md-mtype-dirstate')?.value || '';
  const rows = mdMtypes.filter(r => {
    const v = r.category || '';
    if (cat && v.localeCompare(cat, 'ar') < 0) return false;
    if (catTo && v.localeCompare(catTo, 'ar') > 0) return false;
    const directed = (r.system_desc || '') !== '' || v !== '';
    if (dirState === 'done' && !directed) return false;
    if (dirState === 'none' && directed) return false;
    return true;
  });
  const canM = can('master');
  table($('#tbl-md-mtypes'), [
    { t: 'نوع الحركة', k: 'code' },
    { t: 'وصف الحركة', k: 'descr' },
    { t: 'وصف السيستم', k: 'system_desc' },
    { t: 'التصنيف', k: 'category' },
    ...(canM ? [{ t: '', h: true, f: r => `<button class="btn sm ghost" data-mtype="${escHtml(r.code)}">✎ تعديل</button>` }] : []),
  ], rows, { empty: 'لا توجد أنواع حركات — استورد ملف الحركات أو أضفها يدوياً' });
}

$('#tbl-md-mtypes')?.addEventListener('click', e => {
  const b = e.target.closest('[data-mtype]');
  if (b && can('master')) openMdMtype(b.dataset.mtype);
});
liveFilter(['md-mtype-q', 'md-mtype-dirstate', 'md-mtype-cat', 'md-mtype-cat-to'],
  () => renderMdMtypes().catch(e => toast(e.message)), 300);

/* يملأ قائمة تصنيفات نموذج نوع الحركة:
   التصنيفات المُعرَّفة (kind='category') + أي تصنيف مستخدم فعلاً في نوع حركة قائم
   حتى يظهر التصنيف القديم عند التعديل ولا يُفقد بالحفظ */
async function fillMtCat(val) {
  const el = $('#mt-cat'); if (!el) return;
  try { mdMtypeCats = await api('/api/md/mtypes/categories'); } catch (_) {}
  if (!Array.isArray(mdMtypes) || !mdMtypes.length) {
    try { mdMtypes = await api('/api/md/mtypes?q='); } catch (_) { mdMtypes = []; }
  }
  const vals = [...new Set([
    ...mdMtypeCats.map(r => String(r.name || '').trim()),
    ...mdMtypes.map(r => String(r.category || '').trim()),
  ].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
  el.innerHTML = '<option value="">— بلا تصنيف —</option>' +
    vals.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
  if (val && !vals.includes(val)) el.insertAdjacentHTML('beforeend', `<option value="${escHtml(val)}">${escHtml(val)}</option>`);
  el.value = val || '';
}

async function openMdMtype(code) {
  const pickRows = mdPick && mdPick.type === 'mtype' ? mdPickItems : [];
  const r = code ? (mdMtypes.find(x => x.code === code) || pickRows.find(x => x.code === code)) : null;
  const f = $('#md-mtype-form');
  f.dataset.edit = r ? r.code : '';
  $('#md-mtype-title').textContent = r ? 'تعديل نوع حركة' : 'إضافة نوع حركة';
  $('#mt-code').value = r ? r.code : '';
  $('#mt-descr').value = r ? (r.descr || '') : '';
  $('#mt-sys').value = r ? (r.system_desc || '') : '';
  await fillMtCat(r ? (r.category || '') : '');
  mdErr('mt-err', null);
  mdOpen('md-mtype-modal');
}
$('#md-mtype-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const editing = f.dataset.edit || '';
  mdErr('mt-err', null);
  try {
    await api('/api/md/mtypes/save', { method: 'POST', headers: hdr, body: JSON.stringify({
      code: $('#mt-code').value.trim(), descr: $('#mt-descr').value.trim(),
      systemDesc: $('#mt-sys').value.trim(), category: $('#mt-cat').value, editCode: editing }) });
    $('#md-mtype-modal').hidden = true;
    f.dataset.edit = '';
    toast(editing ? 'تم تعديل نوع الحركة ✔' : 'تمت إضافة نوع الحركة ✔');
    await loadMdMtypes();
  } catch (err) { mdErr('mt-err', err.message); }});

/* قائمة «إضافة بيانات» في أنواع الحركات: حركة / تصنيف — كلٌّ بإضافة/تعديل/حذف */
$('#md-mt-add-btn')?.addEventListener('click', e => {
  e.stopPropagation();
  normalizeAddMenu('#md-mt-add-menu', 'mtType');
  const m = $('#md-mt-add-menu'); if (m) m.hidden = !m.hidden;
});
$('#md-mt-add-menu')?.addEventListener('click', e => {
  const it = e.target.closest('[data-mt-type]');
  const act = e.target.closest('[data-act]');
  if (!it || !act) return;
  $('#md-mt-add-menu').hidden = true;
  const type = it.dataset.mtType, a = act.dataset.act;
  /* «تصنيف»: نفس جدول بيانات الحركات (kind='category') — بلا جدول منفصل */
  if (type === 'cat') {
    if (a === 'add') { openMdCat(null); return; }
    openPicker({
      title: 'إدارة تصنيفات الحركات', label: 'اختر التصنيف المطلوب', noun: 'التصنيف', type: 'mcat',
      nameOf: r => r.name || '',
      load: () => api('/api/md/mtypes/categories'),
      onEdit: code => openMdCat(code),
      onDelete: async code => {
        await api('/api/md/mtypes/category/delete', { method: 'POST', headers: hdr, body: JSON.stringify({ code }) });
        toast(`تم حذف التصنيف «${code}» ✔`);
        await renderMdMtypes();
      },
    });
    return;
  }
  if (a === 'add') { openMdMtype(null); return; }
  openPicker({
    title: 'إدارة أنواع الحركات', label: 'اختر نوع الحركة المطلوب', noun: 'نوع الحركة', type: 'mtype',
    nameOf: r => r.descr || '',
    load: () => api('/api/md/mtypes?q='),
    onEdit: code => openMdMtype(code),
    onDelete: async code => {
      await api('/api/md/mtypes/delete', { method: 'POST', headers: hdr, body: JSON.stringify({ code }) });
      toast(`تم حذف نوع الحركة «${code}» ✔`);
      await renderMdMtypes();
    },
  });
});

/* ---- التصنيفات: صفوف داخل نفس جدول  movement_types  (kind='category') ---- */
function openMdCat(code) {
  const pickRows = mdPick && mdPick.type === 'mcat' ? mdPickItems : [];
  const r = code ? (mdMtypeCats.find(x => x.code === code) || pickRows.find(x => x.code === code)) : null;
  const f = $('#md-mcat-form');
  f.dataset.edit = r ? r.code : '';
  $('#md-mcat-title').textContent = r ? 'تعديل تصنيف' : 'إضافة تصنيف';
  $('#mcat-code').value = r ? r.code : '';
  $('#mcat-name').value = r ? (r.name || '') : '';
  $('#mcat-descr').value = r ? (r.descr || '') : '';
  mdErr('mcat-err', null);
  mdOpen('md-mcat-modal');
}
$('#md-mcat-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const editing = f.dataset.edit || '';
  mdErr('mcat-err', null);
  try {
    await api('/api/md/mtypes/category/save', { method: 'POST', headers: hdr, body: JSON.stringify({
      code: $('#mcat-code').value.trim(), name: $('#mcat-name').value.trim(),
      descr: $('#mcat-descr').value.trim(), editCode: editing }) });
    $('#md-mcat-modal').hidden = true;
    f.dataset.edit = '';
    toast(editing ? 'تم تعديل التصنيف ✔' : 'تمت إضافة التصنيف ✔');
    await loadMdMtypes();
  } catch (err) { mdErr('mcat-err', err.message); }
});

/* ---------------- المخزون ---------------- */
/* ---- المخزون: فلاتر (من/إلى/مكان/شركة/وحدة/صنف) ---- */
const inventoryQS = () => filterQS(
  { from: 'if-from', to: 'if-to', item: 'if-item' },
  { place: ['if-place', 'if-place-to'], company: ['if-company', 'if-company-to'],
    unit: ['if-unit', 'if-unit-to'], storage: ['if-storage', 'if-storage-to'] });
let inventoryDimsLoaded = false;
async function loadInventory() {
  resetSort();
  await loadSpan();
  defaultRange('if-from', 'if-to', 'balances');
  const qs = inventoryQS();
  if (!inventoryDimsLoaded) {
    inventoryDimsLoaded = true;
    await Promise.all([
      fillDimPair('if-place', 'if-place-to', '/api/dims?dim=place&src=balances'),
      fillDimPair('if-company', 'if-company-to', '/api/dims?dim=company&src=balances'),
      fillDimPair('if-unit', 'if-unit-to', '/api/dims?dim=unit&src=balances'),
      fillDimPair('if-storage', 'if-storage-to', '/api/dims?dim=storage&src=balances'),
    ]);
  }
  const group = $('#if-group')?.value || 'item';
  const brk = group === 'detail' ? '' : ($('#if-break')?.value === 'total' ? '' : ($('#if-break')?.value || ''));
  const per = group === 'detail' ? '' : ($('#if-per')?.value || '');
  const d = await api(appendQ('/api/inventory/report?by=' + encodeURIComponent(group) + '&by2=' + encodeURIComponent(brk) + '&per=' + encodeURIComponent(per) + '&limit=20000', qs));

  /* أعمدة الأموال المشتركة: افتتاحي + ختامي + قيمة الوحدة */
  const moneyCols = [
    { t: 'افتتاحي (قيمة)', k: 'open_val', n: 1, f: r => money(r.open_val) },
    { t: 'ختامي (قيمة)', k: 'close_val', n: 1, f: r => money(r.close_val) },
    { t: 'التغير', n: 1, f: r => money(r.close_val - r.open_val), cls: r => dv(r.close_val - r.open_val) },
    { t: 'كمية ختامية', k: 'close_qty', n: 1, f: r => n2(r.close_qty) },
    { t: 'قيمة الوحدة', n: 1, f: r => { const q = Number(r.close_qty) || 0, v = Number(r.close_val) || 0; return q ? money(Math.round((v / q) * 100) / 100) : '—'; } },
  ];
  const perCol = per ? [{ t: 'الفترة', k: 'per' }] : [];
  if (group === 'detail' && !per) {
    table($('#tbl-inv-detail'), [
      { t: 'التاريخ', k: 'balance_date', f: r => (r.balance_date || '—') },
      { t: 'كود الصنف', k: 'item' },
      { t: 'الوصف', k: 'item_desc' },
      { t: 'وحدة القياس', k: 'uom' },
      { t: 'التصنيف', k: 'cls' },
      { t: 'المجموعة', k: 'grp' },
      { t: 'المخزن', k: 'storage_loc' },
      { t: 'الوحدة', k: 'unit_code' },
      { t: 'الشركة', k: 'company_code' },
      { t: 'المكان', k: 'place' },
      { t: 'افتتاحي (كمية)', k: 'open_qty', n: 1, f: r => n2(r.open_qty) },
      ...moneyCols,
    ], d.rows, { empty: 'لا توجد أرصدة مطابقة للفلاتر' });
  } else {
    /* تجميع ثنائي/ثلاثي: فترة × تجميع × تفصيل */
    table($('#tbl-inv-detail'), [
      ...perCol,
      { t: d.label || 'التجميع', k: 'g1' },
      ...(brk ? [{ t: d.label2 || 'التفصيل', k: 'g2' }] : []),
      ...(group === 'item' ? [{ t: 'الوصف', k: 'item_desc' }, { t: 'وحدة القياس', k: 'uom' }] : []),
      ...moneyCols,
    ], d.rows, { empty: 'لا توجد أرصدة مطابقة للفلاتر' });
  }
  const tOpen = d.rows.reduce((s, r) => s + (r.open_val || 0), 0);
  const tClose = d.rows.reduce((s, r) => s + (r.close_val || 0), 0);
  const tQty = d.rows.reduce((s, r) => s + (r.close_qty || 0), 0);
}

liveFilter(['if-item', 'if-from', 'if-to', 'if-place', 'if-place-to', 'if-company', 'if-company-to',
  'if-unit', 'if-unit-to', 'if-storage', 'if-storage-to'],
  () => loadInventory().catch(e => toast(e.message)), 300);

/* تغيير طريقة تجميع التقرير في شاشة الأرصدة اليومية */
$('#if-group')?.addEventListener('change', () => {
  vis($('#if-break'), $('#if-group').value !== 'detail');
  vis($('#if-per'), $('#if-group').value !== 'detail');
  loadInventory().catch(e => toast(e.message));
});
$('#if-break')?.addEventListener('change', () => loadInventory().catch(e => toast(e.message)));
$('#if-per')?.addEventListener('change', () => loadInventory().catch(e => toast(e.message)));

/* ---------------- المبيعات ---------------- */
/* ---- المبيعات: فلاتر (من/إلى/صنف + نطاقات: مكان/عميل/وحدة/مخزن) ---- */
const SALES_DIMS = {
  place: ['sf-place', 'sf-place-to'], cust: ['sf-cust', 'sf-cust-to'],
  unit: ['sf-unit', 'sf-unit-to'], storage: ['sf-storage', 'sf-storage-to'],
};
const SALES_FILTER_IDS = Object.values(SALES_DIMS).flat().concat(['sf-from', 'sf-to', 'sf-item']);
const salesQS = () => filterQS({ from: 'sf-from', to: 'sf-to', item: 'sf-item' }, SALES_DIMS);
let salesDimsLoaded = false;
async function loadSales() {
  resetSort();
  await loadSpan();
  defaultRange('sf-from', 'sf-to', 'sales');
  const qs = salesQS();
  if (!salesDimsLoaded) {
    salesDimsLoaded = true;
    await Promise.all([
      fillDimPair('sf-place', 'sf-place-to', '/api/dims?dim=place&src=sales'),
      fillDimPair('sf-cust', 'sf-cust-to', '/api/dims?dim=cust&src=sales'),
      fillDimPair('sf-unit', 'sf-unit-to', '/api/dims?dim=unit&src=sales'),
      fillDimPair('sf-storage', 'sf-storage-to', '/api/dims?dim=storage&src=sales'),
    ]);
  }
  const group = $('#sal-group')?.value || 'item';
  const brk = group === 'detail' ? '' : ($('#sal-break')?.value === 'total' ? '' : ($('#sal-break')?.value || ''));
  const per = group === 'detail' ? '' : ($('#sal-per')?.value || '');
  const d = await api(appendQ('/api/sales/day?limit=20000&by=' + encodeURIComponent(group) + '&by2=' + encodeURIComponent(brk) + '&per=' + encodeURIComponent(per), qs));
  const rows = d.rows || [];
  const L = d.label || 'الصنف';
  const L2 = d.label2 || '';
  const moneyCols = [
    { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
    { t: 'قيمة البيع', k: 'value', n: 1, f: r => money(r.value) },
    { t: 'قيمة البيع للوحدة', k: 'unit_value', n: 1, f: r => (r.unit_value == null ? '—' : n2(r.unit_value)) },
    { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
  ];
  const perCol = per ? [{ t: 'الفترة', k: 'per' }] : [];
  let cols, footerLbl;
  if (group === 'detail' && !per) {
    cols = [
      { t: 'التاريخ', k: 'invoice_date', f: r => (r.invoice_date || '—') },
      { t: 'كود الصنف', k: 'item' },
      { t: 'اسم الصنف', k: 'item_desc' },
      { t: 'وحدة القياس', k: 'uom', f: r => (r.uom || '—') },
      { t: 'التصنيف', k: 'cls', f: r => r.cls + (r.class_code ? ' (' + r.class_code + ')' : '') },
      { t: 'المجموعة', k: 'grp', f: r => r.grp + (r.group_code ? ' (' + r.group_code + ')' : '') },
      { t: 'المخزن', k: 'storage_loc' },
      { t: 'الوحدة', k: 'unit_code' },
      { t: 'المكان', k: 'place' },
      { t: 'الشركة', k: 'company_code' },
      ...moneyCols,
    ];
    footerLbl = 'تفصيلي';
  } else if (group === 'item' && !brk && !per) {
    cols = [
      { t: L, k: 'g1' },
      { t: 'الوصف', k: 'item_desc' },
      { t: 'وحدة القياس', k: 'uom', f: r => (r.uom || '—') },
      { t: 'مستندات', k: 'docs', n: 1, f: r => n0(r.docs) },
      ...moneyCols,
    ];
    footerLbl = 'صنف';
  } else {
    /* تجميع ثنائي/ثلاثي: فترة × تجميع × تفصيل */
    cols = [
      ...perCol,
      { t: L, k: 'g1' },
      ...(brk ? [{ t: L2, k: 'g2' }] : []),
      ...(group === 'item' ? [{ t: 'الوصف', k: 'item_desc' }, { t: 'وحدة القياس', k: 'uom', f: r => (r.uom || '—') }] : []),
      ...moneyCols,
    ];
    footerLbl = (per ? 'فترة × ' : '') + (brk ? 'بند (' + L + ' × ' + L2 + ')' : 'بند (' + L + ')');
  }
  table($('#tbl-sal-detail'), cols, rows, { limit: 0, empty: 'لا توجد بنود مبيعات مطابقة للفلاتر' });
  const tLines = rows.reduce((s, r) => s + (r.lines || 0), 0);
  const tQty = rows.reduce((s, r) => s + (r.qty || 0), 0);
  const tVal = rows.reduce((s, r) => s + (r.value || 0), 0);
  const cnt = $('#sal-detail-count');
  if (cnt) cnt.innerHTML = '<b>' + n0(rows.length) + '</b> ' + footerLbl +
    ' • <b>' + n0(tLines) + '</b> بند • كمية <b>' + n2(tQty) + '</b> • قيمة البيع <b>' + money(tVal) + '</b> ج.م';
  const csv = $('#sal-csv');
  if (csv) csv.href = appendQ('/api/export?name=sales-day&by=' + encodeURIComponent(group) + '&by2=' + encodeURIComponent(brk) + '&per=' + encodeURIComponent(per), qs);
}

/* تغيير طريقة تجميع التقرير في شاشة المبيعات اليومية */
$('#sal-group')?.addEventListener('change', () => {
  vis($('#sal-break'), $('#sal-group').value !== 'detail');
  vis($('#sal-per'), $('#sal-group').value !== 'detail');
  loadSales().catch(e => toast(e.message));
});
$('#sal-break')?.addEventListener('change', () => loadSales().catch(e => toast(e.message)));
$('#sal-per')?.addEventListener('change', () => loadSales().catch(e => toast(e.message)));

liveFilter(SALES_FILTER_IDS, () => loadSales().catch(e => toast(e.message)), 300);

/* ---------------- الحركات ---------------- */
/* ---- الحركات: فلاتر (من/إلى/مكان/نوع حركة/توجيه/وحدة/صنف) ---- */
const movementsQS = () => filterQS(
  { from: 'mf-from', to: 'mf-to', item: 'mf-item', grp: 'mf-grp', cls: 'mf-cls',
    mtype: 'mf-mtype', dir: 'mf-dir', company: 'mf-company', place: 'mf-place', storage: 'mf-storage',
    item_inner: 'mf-item-inner', mtype_cat: 'mf-mtype-cat', cust: 'mf-cust' },
  { grp_range: ['mf-grp-from','mf-grp-to'], cls_range: ['mf-cls-from','mf-cls-to'],
    item_range: ['mf-item-inner-from','mf-item-inner-to'], mtype_range: ['mf-mtype-from','mf-mtype-to'],
    mtype_cat_range: ['mf-mtype-cat-from','mf-mtype-cat-to'], dir_range: ['mf-dir-from','mf-dir-to'],
    company_range: ['mf-company-from','mf-company-to'], place_range: ['mf-place-from','mf-place-to'],
    storage_range: ['mf-storage-from','mf-storage-to'], cust_range: ['mf-cust-from','mf-cust-to'],
    place_old: ['mf-place', 'mf-place-to'], mtype_old: ['mf-mtype', 'mf-mtype-to'],
    dir_old: ['mf-dir', 'mf-dir-to'], storage_old: ['mf-storage', 'mf-storage-to'] });
let movementsDimsLoaded = false;
async function loadMovements() {
  resetSort();
  await loadSpan();
  defaultRange('mf-from', 'mf-to', 'movements');
  const qs = movementsQS();
  if (!movementsDimsLoaded) {
    movementsDimsLoaded = true;
    await Promise.all([
      fillDimPair('mf-place', 'mf-place-to', '/api/dims?dim=place&src=movements'),
      fillDimPair('mf-mtype', 'mf-mtype-to', '/api/dims?dim=mtype&src=movements'),
      fillDimPair('mf-dir', 'mf-dir-to', '/api/dims?dim=dir&src=movements'),
      fillDimPair('mf-unit', 'mf-unit-to', '/api/dims?dim=unit&src=movements'),
      fillDimPair('mf-storage', 'mf-storage-to', '/api/dims?dim=storage&src=movements'),
      (async () => {
        const grpVals = await api('/api/dims?dim=grp&src=movements').catch(() => []);
        const grpOpts = grpVals.map(v => `<option value="${escHtml(String(v))}">${escHtml(String(v))}</option>`).join('');
        const fill = (id, label) => { const el = document.getElementById(id); if (!el) return; const cur = el.value; el.innerHTML = `<option value="">${label}</option>` + grpOpts; if (cur && el.querySelector(`option[value="${escHtml(cur)}"]`)) el.value = cur; };
        fill('mf-grp', 'كل المجموعات'); fill('mf-grp-from', 'من'); fill('mf-grp-to', 'إلى');
      })(),
      (async () => {
        const clsVals = await api('/api/dims?dim=cls&src=sales').catch(() => []);
        const clsOpts = clsVals.map(v => `<option value="${escHtml(String(v))}">${escHtml(String(v))}</option>`).join('');
        const fill = (id, label) => { const el = document.getElementById(id); if (!el) return; const cur = el.value; el.innerHTML = `<option value="">${label}</option>` + clsOpts; if (cur && el.querySelector(`option[value="${escHtml(cur)}"]`)) el.value = cur; };
        fill('mf-cls', 'كل التصنيفات'); fill('mf-cls-from', 'من'); fill('mf-cls-to', 'إلى');
      })(),
      (async () => {
        const itemVals = await api('/api/items/all?limit=20000').catch(() => []);
        const itemOpts = itemVals.map(i => `<option value="${escHtml(i.code)}">${escHtml(i.code)} — ${escHtml(i.descr || '')}</option>`).join('');
        const fill = (id, label) => { const el = document.getElementById(id); if (!el) return; const cur = el.value; el.innerHTML = `<option value="">${label}</option>` + itemOpts; if (cur && el.querySelector(`option[value="${escHtml(cur)}"]`)) el.value = cur; };
        fill('mf-item-inner', 'كل الأصناف'); fill('mf-item-inner-from', 'من'); fill('mf-item-inner-to', 'إلى');
      })(),
      (async () => {
        const mtypeVals = await api('/api/dims?dim=mtype&src=movements').catch(() => []);
        const mtypeOpts = mtypeVals.map(v => `<option value="${escHtml(String(v))}">${escHtml(String(v))}</option>`).join('');
        const fill = (id, label) => { const el = document.getElementById(id); if (!el) return; const cur = el.value; el.innerHTML = `<option value="">${label}</option>` + mtypeOpts; if (cur && el.querySelector(`option[value="${escHtml(cur)}"]`)) el.value = cur; };
        fill('mf-mtype', 'كل الحركات'); fill('mf-mtype-from', 'من'); fill('mf-mtype-to', 'إلى');
        fill('mf-mtype-cat', 'كل التصنيفات'); fill('mf-mtype-cat-from', 'من'); fill('mf-mtype-cat-to', 'إلى');
      })(),
      (async () => {
        const dirVals = await api('/api/dims?dim=dir&src=movements').catch(() => []);
        const dirOpts = dirVals.map(v => `<option value="${escHtml(String(v))}">${escHtml(String(v))}</option>`).join('');
        const fill = (id, label) => { const el = document.getElementById(id); if (!el) return; const cur = el.value; el.innerHTML = `<option value="">${label}</option>` + dirOpts; if (cur && el.querySelector(`option[value="${escHtml(cur)}"]`)) el.value = cur; };
        fill('mf-dir', 'كل التوجيهات'); fill('mf-dir-from', 'من'); fill('mf-dir-to', 'إلى');
      })(),
      (async () => {
        const compVals = await api('/api/dims?dim=company&src=sales').catch(() => []);
        const compOpts = compVals.map(v => `<option value="${escHtml(String(v))}">${escHtml(String(v))}</option>`).join('');
        const fill = (id, label) => { const el = document.getElementById(id); if (!el) return; const cur = el.value; el.innerHTML = `<option value="">${label}</option>` + compOpts; if (cur && el.querySelector(`option[value="${escHtml(cur)}"]`)) el.value = cur; };
        fill('mf-company', 'كل الشركات'); fill('mf-company-from', 'من'); fill('mf-company-to', 'إلى');
      })(),
      (async () => {
        const custVals = await api('/api/dims?dim=cust&src=sales').catch(() => []);
        const custOpts = custVals.map(v => `<option value="${escHtml(String(v))}">${escHtml(String(v))}</option>`).join('');
        const fill = (id, label) => { const el = document.getElementById(id); if (!el) return; const cur = el.value; el.innerHTML = `<option value="">${label}</option>` + custOpts; if (cur && el.querySelector(`option[value="${escHtml(cur)}"]`)) el.value = cur; };
        fill('mf-cust', 'كل العملاء'); fill('mf-cust-from', 'من'); fill('mf-cust-to', 'إلى');
      })(),
      fillDimPair('mf-place', 'mf-place-to', '/api/dims?dim=place&src=movements'),
      fillDimPair('mf-storage', 'mf-storage-to', '/api/dims?dim=storage&src=movements'),
    ]);
  }
  /* التجميع أُلغي نهائياً من هذه الشاشة — كل سطر = حركة أصلية واحدة */
  const d = await api(appendQ('/api/movements/report?by=detail&limit=20000', qs));

  /* أعمدة الأموال: كمية + قيمة + قيمة الوحدة — كل سطر حركة أصلية، لا إجماليات في الجدول */
  const moneyCols = [
    { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty), cls: r => dv(r.qty) },
    { t: 'القيمة', k: 'amount', n: 1, f: r => money(r.amount), cls: r => dv(r.amount) },
    { t: 'قيمة الوحدة', n: 1, f: r => { const q = Number(r.qty) || 0, v = Number(r.amount) || 0; return q ? money(Math.round((v / q) * 100) / 100) : '—'; } },
  ];
  if (true) {
    table($('#mv-report'), [
      { t: 'رقم الحركة', k: 'id', n: 1, f: r => n0(r.id) },
      { t: 'التاريخ', k: 'post_date', f: r => (r.post_date || '—') },
      { t: 'كود الصنف', k: 'item' },
      { t: 'اسم الصنف', k: 'item_desc' },
      { t: 'وحدة القياس', k: 'uom' },
      { t: 'التوجيه', k: 'direction' },
      { t: 'المخزن', k: 'storage_loc' },
      { t: 'المكان', k: 'place' },
      ...moneyCols,
    ], d.rows, { empty: 'لا توجد حركات مطابقة للفلاتر', totals: true });
  }
  const tot = d.rows.reduce((s, r) => s + (r.lines || 0), 0);
  const netVal = d.rows.reduce((s, r) => s + (r.amount || 0), 0);
  $('#mv-report-count').textContent = n0(d.rows.length) + ' سطر • ' + n0(tot) + ' حركة حقيقية'
    + ' • صافي القيمة ' + money(netVal);
}

liveFilter([
  'mf-item', 'mf-from', 'mf-to',
  'mf-grp', 'mf-grp-from', 'mf-grp-to', 'mf-cls', 'mf-cls-from', 'mf-cls-to',
  'mf-item-inner', 'mf-item-inner-from', 'mf-item-inner-to',
  'mf-mtype', 'mf-mtype-from', 'mf-mtype-to', 'mf-mtype-cat', 'mf-mtype-cat-from', 'mf-mtype-cat-to',
  'mf-dir', 'mf-dir-from', 'mf-dir-to',
  'mf-company', 'mf-company-from', 'mf-company-to',
  'mf-place', 'mf-place-from', 'mf-place-to', 'mf-storage', 'mf-storage-from', 'mf-storage-to',
  'mf-cust', 'mf-cust-from', 'mf-cust-to'
], () => loadMovements().catch(e => toast(e.message)), 300);

function toggleMenu(id, btn) {
  const el = $('#' + id);
  if (!el) return;
  const open = el.hidden;
  ['items-menu','types-menu','places-menu','other-menu'].forEach(m => { if (m !== id) { const e=$('#'+m); if(e&&!e.hidden) e.hidden=true; if(e&&e.parentElement!==document.body) document.body.appendChild(e); } });
  if (el.parentElement !== document.body) document.body.appendChild(el);
  el.hidden = !open;
  if (!open && btn) btn.classList.remove('on'); else if (btn) btn.classList.add('on');
  if (open) {
    if (btn) {
      const rect = btn.getBoundingClientRect();
      el.style.position = 'fixed';
      el.style.top = (rect.bottom + 6) + 'px';
      const menuW = 240;
      if (rect.right + menuW > window.innerWidth) {
        el.style.right = '4px';
        el.style.left = 'auto';
      } else {
        el.style.left = rect.left + 'px';
        el.style.right = 'auto';
      }
      el.style.zIndex = '20000';
      el.style.width = menuW + 'px';
      el.style.maxHeight = '70vh';
      el.style.overflow = 'auto';
      el.style.overflowX = 'hidden';
    }
  } else {
    el.style.position = ''; el.style.top = ''; el.style.left = ''; el.style.zIndex = ''; el.style.width = '';
  }
}
function closeAllMenus() {
  ['items-menu','types-menu','places-menu','other-menu'].forEach(m => { const e=$('#'+m); if(e&&!e.hidden) e.hidden=true; if(e) { e.style.position=''; e.style.top=''; e.style.left=''; e.style.zIndex=''; e.style.width=''; } });
  ['btn-items','btn-types','btn-places','btn-other'].forEach(b => { const b2=$('#'+b); if(b2) b2.classList.remove('on'); });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.cpp') && !e.target.closest('.cpp-menu')) closeAllMenus();
});
function clearMenu(name) {
  if (name === 'items') {
    $('#mf-grp').value=''; $('#mf-grp-from').value=''; $('#mf-grp-to').value='';
    $('#mf-cls').value=''; $('#mf-cls-from').value=''; $('#mf-cls-to').value='';
    $('#mf-item-inner').value=''; $('#mf-item-inner-from').value=''; $('#mf-item-inner-to').value='';
  }
  if (name === 'types') {
    $('#mf-mtype').value=''; $('#mf-mtype-from').value=''; $('#mf-mtype-to').value='';
    $('#mf-mtype-cat').value=''; $('#mf-mtype-cat-from').value=''; $('#mf-mtype-cat-to').value='';
    $('#mf-dir').value=''; $('#mf-dir-from').value=''; $('#mf-dir-to').value='';
  }
  if (name === 'places') {
    $('#mf-company').value=''; $('#mf-company-from').value=''; $('#mf-company-to').value='';
    $('#mf-place').value=''; $('#mf-place-from').value=''; $('#mf-place-to').value='';
    $('#mf-storage').value=''; $('#mf-storage-from').value=''; $('#mf-storage-to').value='';
  }
  if (name === 'other') { $('#mf-cust').value=''; $('#mf-cust-from').value=''; $('#mf-cust-to').value=''; }
}
function applyMenu(name) {
  loadMovements().catch(e => toast(e.message));
}
function clearGroup(name) {
  clearMenu(name);
  loadMovements().catch(e => toast(e.message));
}

/* طبقة التجميع أُلغيت نهائياً من شاشة الحركات اليومية — كل سطر = حركة أصلية */

/* قائمة «فلاتر أخرى» تُدار مركزياً — لا حاجة لمعالج خاص بالسوق اليومية */

/* ---------------- البورصة اليومية ---------------- */
let borseItemsSig = '';

async function loadBorse() {
  const days = Number($('#borse-range')?.value || 180);
  const itemSel = $('#borse-item');
  const item = itemSel ? itemSel.value : '';
  const from = ($('#bo-from')?.value || '').trim();
  const to = ($('#bo-to')?.value || '').trim();
  const q = new URLSearchParams({ days, item, from, to });
  const [d, st] = await Promise.all([
    api(`/api/borse?${q}`),
    api('/api/borse/status').catch(() => null),
  ]);
  const { summary, latest, series, usd, recent } = d;

  // فلتر الأصناف (يُعاد بناؤه عند تغيّر البيانات فقط)
  if (itemSel) {
    const sig = summary.items.map(i => i.item + '|' + i.item_code).join(',');
    if (sig !== borseItemsSig) {
      borseItemsSig = sig;
      itemSel.innerHTML = '';
      const o0 = document.createElement('option');
      o0.value = ''; o0.textContent = 'كل الأصناف';
      itemSel.appendChild(o0);
      summary.items.forEach(i => {
        const o = document.createElement('option');
        o.value = i.item_code || i.item;
        o.textContent = (i.item_code ? i.item_code + ' — ' : '') + i.item;
        itemSel.appendChild(o);
      });
      itemSel.value = item;
    }
  }

  // آخر الأسعار
  table($('#tbl-borse-latest'), [
    { t: 'الصنف', k: 'item' },
    { t: 'الكود', k: 'item_code' },
    { t: 'العقد', k: 'contract' },
    { t: 'التاريخ', k: 'borse_date' },
    { t: 'منخفض', k: 'low', n: 1, f: r => money(r.low) },
    { t: 'عالي', k: 'high', n: 1, f: r => money(r.high) },
    { t: 'الإغلاق', k: 'close', n: 1, f: r => money(r.close) },
    { t: 'التغير %', n: 1,
      f: r => (r.close != null && r.prev_close) ? pct((r.close - r.prev_close) / r.prev_close * 100) : '—',
      cls: r => (r.close != null && r.prev_close)
        ? ((r.close - r.prev_close) >= 0 ? 'pos' : 'neg') : '' },
    { t: 'سعر التكلفة', k: 'cost_price', n: 1, f: r => money(r.cost_price) },
    { t: 'ريت $', k: 'usd_rate', n: 1, f: r => n2(r.usd_rate) },
  ], latest);

  // منحنيات الإغلاق — شارت مستقل لكل صنف + شارت ريت الدولار، كلها في شبكة من 4
  const colors = ['#5b8cff', '#34d399', '#f59e0b', '#fb7185', '#a78bfa', '#38bdf8'];
  const CH_H = 150;
  const host = $('#borse-charts');
  if (host) {
    host.innerHTML = '';
    const grouped = {};
    series.forEach(r => { if (r.close != null && r.item) (grouped[r.item] = grouped[r.item] || []).push(r); });
    const names = Object.keys(grouped).sort();
    if (!names.length) {
      host.innerHTML = '<div class="card"><div class="muted">لا توجد أسعار إغلاق في النطاق المحدّد</div></div>';
    }
    names.forEach((name, i) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div class="card-h"><h3 title="${escHtml(name)}">${escHtml(name)} <small>إغلاق</small></h3></div><div class="ch-mini"></div>`;
      host.appendChild(card);
      lineChart(card.querySelector('.ch-mini'), [{
        name, color: colors[i % colors.length],
        points: grouped[name].map(r => ({ x: r.borse_date, y: r.close })),
      }], { fmt: v => n2(v), height: CH_H, zero: false });
    });
    /* شارت ريت الدولار دائماً آخر عنصر في الشبكة */
    const ucard = document.createElement('div');
    ucard.className = 'card';
    ucard.innerHTML = '<div class="card-h"><h3>سعر صرف الدولار <small>مع البورصة</small></h3></div><div class="ch-mini"></div>';
    host.appendChild(ucard);
    lineChart(ucard.querySelector('.ch-mini'), [
      { name: 'ريت الدولار', color: '#34d399', points: usd.map(r => ({ x: r.borse_date, y: r.usd_rate })) },
    ], { fmt: v => n2(v), height: CH_H, area: true, zero: false });
  }

  // سجل التسجيلات
  table($('#tbl-borse'), [
    { t: 'التاريخ', k: 'borse_date' },
    { t: 'العقد', k: 'contract' },
    { t: 'الكود', k: 'item_code' },
    { t: 'الصنف', k: 'item' },
    { t: 'منخفض', k: 'low', n: 1, f: r => money(r.low) },
    { t: 'عالي', k: 'high', n: 1, f: r => money(r.high) },
    { t: 'الإغلاق', k: 'close', n: 1, f: r => money(r.close) },
    { t: 'سعر البورصة', k: 'borse_now', n: 1, f: r => money(r.borse_now) },
    { t: 'التكلفة', k: 'cost_price', n: 1, f: r => money(r.cost_price) },
    { t: 'ريت $', k: 'usd_rate', n: 1, f: r => n2(r.usd_rate) },
    { t: 'نولون', k: 'down_payment', n: 1, f: r => money(r.down_payment) },
    { t: 'مصاريف', k: 'fees', n: 1, f: r => money(r.fees) },
    { t: 'معامل التحويل', k: 'fx_factor', n: 1, f: r => n2(r.fx_factor) },
  ], recent);

  // حالة الجلب الذاتي
  if (st) renderBorseStatus(st);
}

/** عرض حالة الجلب (آخر محاولة، موعد الجلب، العقود النشطة، الأيام الفائتة) */
function renderBorseStatus(st) {
  const el = $('#borse-src');
  if (el) {
    const lr = st.lastRun;
    let head;
    if (!lr) head = 'لم يُجرَ جلب بعد';
    else if (lr.ok) head = `آخر جلب ${lr.at} — ${n0(lr.written)} صف جديد / ${n0(lr.updated)} محدَّث`;
    else head = `آخر محاولة فشلت (${lr.at}): ${lr.error || '—'}`;
    const usd = st.usd && st.usd.rate != null ? ` • ريت $ ${n2(st.usd.rate)}` : '';
    const items = (st.items || [])
      .map(i => `${i.symbol} (${i.contract})`).join(' • ');
    el.textContent = `${head} • موعد الجلب ${st.time} • ${st.source ? st.source.prices : 'Yahoo'} + ${st.source ? st.source.usd : 'بنك مصر'}` +
      (items ? ` • ${items}` : '') + usd;
  }
  const at = $('#borse-fetchat');
  if (at && st.time) at.textContent = st.time;
  const pill = $('#borse-pending');
  if (pill) {
    const miss = st.missing || [];
    if (miss.length) { pill.style.display = ''; pill.textContent = `⚠ ${miss.length} يوم فائت لم يُجلَب بعد`; }
    else if (st.lastRun && st.lastRun.ok === false) { pill.style.display = ''; pill.textContent = '⚠ فشل آخر جلب — أعد المحاولة'; }
    else pill.style.display = 'none';
  }
}

$('#borse-range')?.addEventListener('change', () => { borseRangeHint(); loadBorse().catch(e => toast(e.message)); });
$('#borse-item')?.addEventListener('change', () => loadBorse().catch(e => toast(e.message)));
/* نطاق التاريخ الاختياري (من/إلى) — فارغ = نرجع لـ«آخر N يوم» */
liveFilter(['bo-from', 'bo-to'], () => { borseRangeHint(); loadBorse().catch(e => toast(e.message)); }, 300);

/* تحديد تاريخ واحد على الأقل يتجاوز «آخر N يوم» — نُعتّم المحدّد ونوضّح ذلك بالتلميح */
function borseRangeHint() {
  const on = !!((($('#bo-from')?.value || '').trim()) || (($('#bo-to')?.value || '').trim()));
  const rg = $('#borse-range');
  if (rg) {
    rg.classList.toggle('is-overridden', on);
    rg.title = on ? 'مُتجاوز — نطاق التاريخ المحدّد فوقه هو المسيطر (امسح التاريخ ليرجع)' : 'نطاق زمني جاهز';
  }
}
borseRangeHint();

/* جلب فوري — يشغّل نفس مسار الجلب الذاتي اليومي (Yahoo + بنك مصر) */
async function fetchBorse(btn, onDone) {
  if (btn) btn.disabled = true;
  const src = $('#borse-src');
  try {
    const t0 = Date.now();
    if (src) src.textContent = 'جاري الجلب من Yahoo وبنك مصر…';
    const r = await api('/api/borse/fetch', { method: 'POST', headers: hdr, body: JSON.stringify({}) });
    const st = r.status || (await api('/api/borse/status').catch(() => null));
    if (st) renderBorseStatus(st);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    toast(`اكتمل الجلب ✔ ${n0((r.dates || []).length)} يوم — ${n0(r.written)} صف جديد، ${n0(r.updated)} محدَّث (${secs} ث)`);
    (onDone || (() => loadBorse()))();
  } catch (e) {
    if (src) src.textContent = 'تعذّر الجلب: ' + e.message;
    toast('فشل الجلب: ' + e.message, 8000);
    api('/api/borse/status').then(renderBorseStatus).catch(() => {});
  } finally { if (btn) btn.disabled = false; }
}
$('#btn-borse-fetch')?.addEventListener('click', () => {
  /* الجلب يعيد تحميل اللوحة المفتوحة حالياً */
  const pane = (document.querySelector('#borse-segs .seg.on') || {}).dataset?.pane || 'view';
  const done = pane === 'edit' ? () => loadBorseEdit()
             : pane === 'hist' ? () => loadBorseHist()
             : null;
  fetchBorse($('#btn-borse-fetch'), done);
});
$('#btn-be-fetch')?.addEventListener('click', () => fetchBorse($('#btn-be-fetch'), () => loadBorseEdit()));

/* ============ البورصة — التعديل اليدوي (التعديل يسري من تاريخه فما بعد) ============ */
let beRows = [];
let beFields = {};
let beCell = null;

const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/* آخر تاريخ في البيانات — يجيب مرَّة واحدة ويحتفظ به.
   مدى كل جدول: /api/span → { movements:[من,إلى], sales:[...], balances:[...] } */
let SPAN = null;
async function loadSpan(force) {
  if (SPAN && !force) return SPAN;
  try { SPAN = await api('/api/span'); } catch (_) { SPAN = null; }
  return SPAN;
}
/* آخر تاريخ لبيانات مجموعة: movements | sales | balances */
const lastDataDate = g => {
  const s = SPAN && SPAN[g];
  return s && s[1] ? String(s[1]) : '';
};
/**
 * يملأ حقلَي التاريخ بالمدى الافتراضي: «إلى» = آخر تاريخ في بيانات المجموعة،
 * و«من» = نفس التاريخ (أي عرض يوم واحد افتراضياً)، مع احترام أي قيمة سبق اختيارها.
 * الفحص واضح: يُستبدل فقط إذا كان الحقل فارغاً.
 */
function defaultRange(fromId, toId, group) {
  const last = lastDataDate(group) || '';
  const from = document.getElementById(fromId), to = document.getElementById(toId);
  if (last) {
    if (to && !String(to.value || '').trim()) to.value = last;
    if (from && !String(from.value || '').trim()) from.value = last;
  }
}

/* ---------------- فلترة فورية بلا زر «تطبيق الفلتر» ----------------
   الكتابة في خانة البحث أو التاريخ تُعيد تحميل البيانات مباشرة (بعد توقف لحظي)،
   وتغيير القائمة المنسدلة أو مربع الاختيار يُعيدها فوراً.
   الدالة المُمرَّرة (run) هي مُحمّل الشاشة نفسه — فيصبح الفلتر لحظياً في كل الشاشات. */
function liveFilter(ids, run, debounce = 300) {
  const els = ids.map(id => document.getElementById(id)).filter(Boolean);
  let t = null;
  const fire = (delay) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; Promise.resolve(run()).catch(e => toast(e.message)); }, delay);
  };
  els.forEach(el => {
    /* القوائم تُطلق change عند الاختيار، والنصوص والتواريخ والمربعات تُطلق input */
    const evt = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => fire(debounce));
    /* Enter/التحديد من القائمة يطبّق فوراً بلا انتظار التوقف اللحظي */
    if (evt === 'input') el.addEventListener('change', () => fire(0));
  });
  return () => fire(0);
}

function showBorsePane(name) {
  $$('#borse-segs .seg').forEach(b => b.classList.toggle('on', b.dataset.pane === name));
  vis($('#borse-pane-view'), name === 'view');
  vis($('#borse-pane-edit'), name === 'edit');
  vis($('#borse-pane-hist'), name === 'hist');
  /* أدوات «نظرة عامة» (نطاق التاريخ/آخر أيام/الصنف/CSV) تظهر في لوحة النظرة العامة فقط */
  vis($('#bo-view-tools'), name === 'view');
  if (name === 'edit') {
    loadSpan().then(() => defaultRange('be-from', 'be-to', 'borse'));
    if (!beRows.length) loadBorseEdit().catch(e => toast(e.message));
  }
  if (name === 'hist') loadBorseHist().catch(e => toast(e.message));
}
$$('#borse-segs .seg').forEach(b => b.addEventListener('click', () => showBorsePane(b.dataset.pane)));

function beFillItems(rows) {
  const sel = $('#be-item'); if (!sel) return;
  const cur = sel.value;
  const seen = new Map();
  rows.forEach(r => { if (!seen.has(r.item_code)) seen.set(r.item_code, r.item); });
  sel.innerHTML = '<option value="">كل الأصناف</option>' +
    [...seen].map(([c, n]) => `<option value="${escHtml(c)}">${escHtml(n)} (${escHtml(c)})</option>`).join('');
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}

async function loadBorseEdit() {
  await loadSpan();
  /* المدى الافتراضي = آخر تاريخ في بيانات البورصة (أو نؤول لليوم إن لا بيانات) */
  const last = lastDataDate('borse') || fmtDate(new Date());
  if (!$('#be-to').value) $('#be-to').value = last;
  if (!$('#be-from').value) $('#be-from').value = last;
  const from = $('#be-from').value, to = $('#be-to').value, item = $('#be-item').value;
  const d = await api(`/api/borse/grid?from=${encodeURIComponent(from || '')}&to=${encodeURIComponent(to || '')}&item=${encodeURIComponent(item || '')}`);
  beRows = d.rows; beFields = d.fields;
  const eff = $('#be-effdate'); if (eff) eff.textContent = d.to;
  beFillItems(d.rows);
  renderBeGrid();
}

function beTitle(r, field) {
  const base = r.base[field] === '' ? '—' : r.base[field];
  const m = r.marks[field];
  return m
    ? `القيمة الأساسية: ${base} • تعديل سارٍ من ${m.eff}${m.by ? ' • بواسطة ' + m.by : ''}`
    : `القيمة الأساسية (المجلوبة) — بدون تعديل`;
}
const beVal = v => (v === null || v === undefined || v === '') ? '—' : escHtml(v);
const beCellHtml = (r, field) => {
  const cls = 'cellbtn' + (r.marks[field] ? ' ov' : '');
  const title = escHtml(beTitle(r, field));
  const inner = beVal(r.value[field]);
  if (!can('sync')) return `<span class="${cls}" title="${title}">${inner}</span>`;
  return `<button type="button" class="${cls}" title="${title}" data-d="${r.date}" data-i="${escHtml(r.item_code)}" data-f="${field}">${inner}</button>`;
};

function renderBeGrid() {
  const onlyOv = $('#be-onlyov')?.checked;
  const rows = onlyOv ? beRows.filter(r => Object.keys(r.marks).length) : beRows;
  const L = k => (beFields[k] && beFields[k].label) || k;
  table($('#tbl-borse-edit'), [
    { t: 'التاريخ', k: 'date' },
    { t: 'الصنف', k: 'item' },
    { t: L('borse'), n: 1, h: true, f: r => beCellHtml(r, 'borse') },
    { t: 'منخفض', n: 1, f: r => money(r.chart.low) },
    { t: 'عالي', n: 1, f: r => money(r.chart.high) },
    { t: 'الإغلاق', n: 1, f: r => money(r.chart.close) },
    { t: L('prem'), n: 1, h: true, f: r => beCellHtml(r, 'prem') },
    { t: L('price'), n: 1, h: true, f: r => beCellHtml(r, 'price') },
    { t: L('usd'), n: 1, h: true, f: r => beCellHtml(r, 'usd') },
    { t: L('nolon'), n: 1, h: true, f: r => beCellHtml(r, 'nolon') },
    { t: L('expenses'), n: 1, h: true, f: r => beCellHtml(r, 'expenses') },
    { t: L('conv'), n: 1, h: true, f: r => beCellHtml(r, 'conv') },
    { t: 'تكلفة $', n: 1, f: r => r.calc.cost_usd == null ? '—' : n2(r.calc.cost_usd) },
    { t: 'تكلفة أرضه', n: 1, f: r => money(r.calc.cost_land) },
    { t: 'تكلفة وصال', n: 1, f: r => money(r.calc.cost_wasal) },
  ], rows, { limit: 2000, empty: 'لا توجد بيانات في هذا المدى' });
}

$('#tbl-borse-edit')?.addEventListener('click', e => {
  const b = e.target.closest('button.cellbtn[data-f]');
  if (b) openBeModal(b.dataset.d, b.dataset.i, b.dataset.f);
});
$('#btn-be-load')?.addEventListener('click', () => loadBorseEdit().catch(e => toast(e.message)));
$('#be-onlyov')?.addEventListener('change', () => renderBeGrid());
['#be-from', '#be-to'].forEach(s => $(s)?.addEventListener('change', () => loadBorseEdit().catch(e => toast(e.message))));
$('#be-item')?.addEventListener('change', () => loadBorseEdit().catch(e => toast(e.message)));

function openBeModal(date, itemCode, field) {
  const row = beRows.find(r => r.date === date && r.item_code === itemCode);
  if (!row || !beFields[field]) return;
  beCell = { date, item_code: itemCode, field };
  const meta = beFields[field];
  const m = row.marks[field];
  $('#be-title').textContent = 'تعديل: ' + meta.label;
  $('#be-meta').innerHTML =
    `صنف <b>${escHtml(row.item)}</b> (${escHtml(row.item_code)}) — بتاريخ <b>${date}</b>` +
    (m ? ` — عليه تعديل سارٍ من <b>${m.eff}</b>${m.by ? ' بواسطة <b>' + escHtml(m.by) + '</b>' : ''}` : '');
  $('#be-val').value = row.value[field] === null || row.value[field] === undefined ? '' : row.value[field];
  $('#be-note').value = (m && m.note) || '';
  $('#be-eff').textContent =
    `يسري من ${date} فما بعد على كل الأيام حتى تعديل أحدث. القيمة الأساسية: «${row.base[field] || '—'}»`;
  const err = $('#be-err'); err.hidden = true;
  $('#be-revert').style.display = m ? '' : 'none';
  beWarn(field, date);
  $('#be-modal').hidden = false;
  const inp = $('#be-val'); inp.focus(); inp.select();
}

/** تنبيهات الخلية: من يكتب هذا العمود أصلاً وهل يعلوه الجلب الذاتي؟ */
function beWarn(field, date) {
  const el = $('#be-warn');
  if (!el) return;
  let msg = '';
  if (field === 'borse') {
    msg = 'العقد يُخزَّن كـ<b>تاريخ</b> ويظهر «26 ديسمبر». الصيغ المقبولة: ' +
      '<b>26 ديسمبر</b> • <b>ديسمبر 2026</b> • <b>2026-12</b>. ' +
      'النظام يمرّر للعقد الأقرب تلقائياً عند انتهاءه — تعديلك يعلو ذلك من تاريخه فما بعد.';
  } else if (field === 'usd') {
    msg = `ريت الدولار يُجلب يومياً من <b>بنك مصر</b> إلى القيمة الأساسية في يوم الجلب (${date}) — ` +
      'تعديلك يعلوه ويبقى سارياً على كل الأيام بعده حتى تلغيه.';
  } else if (field === 'price' || field === 'prem') {
    msg = 'الجلب اليومي يكتب القيمة الأساسية من مصادر البورصة، ويمسك هذا العمود من آخر صف جديد — ' +
      'تعديلك يسري من تاريخه فما بعد ولا يلمسه الجلب.';
  } else if (field === 'nolon' || field === 'expenses' || field === 'conv') {
    msg = 'قيمة تُحمَّل للأمام إلى كل الأيام الجديدة من آخر صف — تعديلك تبقى سارية عليها.';
  }
  el.innerHTML = msg;
  el.hidden = !msg;
}

/** بعد أي تعديل أو إلغاء: حدّث الشبكة وأيام الجلب (لا ملف يُكتب أبداً) */
async function beAfterEdit() {
  await loadBorseEdit();
}

$('#be-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  if (!beCell) return;
  const err = $('#be-err'); err.hidden = true;
  const btn = $('#be-btn'); btn.disabled = true;
  try {
    await api('/api/borse/override', {
      method: 'POST', headers: hdr,
      body: JSON.stringify({
        item_code: beCell.item_code, eff_date: beCell.date, field: beCell.field,
        value: $('#be-val').value, note: $('#be-note').value,
      }),
    });
    const { field, date } = beCell;
    $('#be-modal').hidden = true;
    toast(`تم الحفظ ✔ ${beFields[field].label} يسري من ${date} فما بعد`);
    await beAfterEdit();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  finally { btn.disabled = false; }
});

$('#be-revert')?.addEventListener('click', async () => {
  if (!beCell) return;
  const err = $('#be-err'); err.hidden = true;
  try {
    const r = await api('/api/borse/override/delete', {
      method: 'POST', headers: hdr,
      body: JSON.stringify({
        item_code: beCell.item_code, eff_date: beCell.date, field: beCell.field,
      }),
    });
    $('#be-modal').hidden = true;
    toast(r.deleted ? 'تم إلغاء التعديل ✔ عادت الخلية للقيمة الأساسية' : 'لا يوجد تعديل لإلغائه');
    await beAfterEdit();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
});

/* سجل التعديلات */
async function loadBorseHist() {
  const rows = await api('/api/borse/overrides?limit=500');
  table($('#tbl-bo-hist'), [
    { t: 'يسري من', k: 'eff_date' },
    { t: 'الصنف', f: r => r.item_name || r.item_code },
    { t: 'الكود', k: 'item_code' },
    { t: 'العمود', h: true, f: r => escHtml((beFields[r.field] && beFields[r.field].label) || r.field) },
    { t: 'القيمة', k: 'value' },
    { t: 'ملاحظة', f: r => r.note ? escHtml(r.note) : '—' },
    { t: 'بواسطة', k: 'by_name' },
    { t: 'وقت الحفظ', h: true, f: r => String(r.created_at || '').slice(0, 16).replace('T', ' ') },
    { t: '', h: true, f: r => `<button class="btn sm ghost" data-del="${escHtml(r.item_code)}|${r.eff_date}|${r.field}">↩ إلغاء</button>` },
  ], rows, { empty: 'لا توجد تعديلات بعد' });
}
$('#btn-bo-hist')?.addEventListener('click', () => loadBorseHist().catch(e => toast(e.message)));
$('#tbl-bo-hist')?.addEventListener('click', async e => {
  const b = e.target.closest('button[data-del]');
  if (!b) return;
  const [item_code, eff_date, field] = b.dataset.del.split('|');
  try {
    const r = await api('/api/borse/override/delete', { method: 'POST', headers: hdr, body: JSON.stringify({ item_code, eff_date, field }) });
    toast(r.deleted ? 'تم إلغاء التعديل ✔' : 'لا يوجد تعديل');
    await loadBorseHist();
    await beAfterEdit();
  } catch (ex) { toast(ex.message); }
});

/* ============ الأسعار اليومية — التعديل اليدوي (يسري من تاريخه فما بعد) ============ */
let prRows = [];
let prFields = {};
let prMeta = null;
let prCell = null;

function showPricesPane(name) {
  $$('#pr-segs .seg').forEach(b => b.classList.toggle('on', b.dataset.pane === name));
  vis($('#pr-pane-view'), name === 'view');
  vis($('#pr-pane-edit'), name === 'edit');
  vis($('#pr-pane-hist'), name === 'hist');
  if (name === 'view') {
    loadSpan().then(() => defaultRange('pr-from', 'pr-to', 'prices'));
    loadPrLatest().catch(e => toast(e.message));
  }
  if (name === 'edit') {
    loadSpan().then(() => defaultRange('pr-from', 'pr-to', 'prices'));
    if (!prRows.length) loadPrices().catch(e => toast(e.message));
  }
  if (name === 'hist') loadPrHist().catch(e => toast(e.message));
}
$$('#pr-segs .seg').forEach(b => b.addEventListener('click', () => showPricesPane(b.dataset.pane)));

/* تحميل قائمة جميع الأصناف (اسم + كود) مرة واحدة على الأقل — مستقل عن فلتر التاريخ */
async function prLoadAllItems(force) {
  const sel = $('#pr-item'); if (!sel) return;
  if (!force && prItemsLoaded) { if (sel.value !== sel.value) sel.value = sel.value; return; }
  prItemsLoaded = true;
  const cur = sel.value;
  const fill = (pairs) => {
    sel.innerHTML = '<option value="">كل الأصناف</option>' +
      [...pairs].sort((a, b) => (a[0] || '').localeCompare(b[0] || ''))
        .map(([cc, n]) => `<option value="${escHtml(cc)}">${escHtml(String(n || cc).slice(0, 42))} (${escHtml(cc)})</option>`).join('');
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
  };
  try {
    const d = await api('/api/prices/latest');
    const seen = new Map();
    (d.rows || []).forEach(r => { if (r.item_code && !seen.has(r.item_code)) seen.set(r.item_code, r.item || r.item_code); });
    if (seen.size) { fill(seen); return; }
  } catch (e) { /* fallback للبيانات الأساسية */ }
  /* لا أسعار مسجلة بعد → الأصناف من البيانات الأساسية بنفس صيغة باقي الشاشات */
  try {
    const items = await api('/api/md/items?limit=20000');
    const seen = new Map();
    (Array.isArray(items) ? items : []).forEach(r => {
      const cc = r.code || r.item_code;
      if (cc && !seen.has(cc)) seen.set(cc, r.descr || r.item || cc);
    });
    fill(seen);
  } catch (e) { /* non-fatal */ }
}
let prItemsLoaded = false;
async function loadPrices() {
  await prLoadAllItems();
  resetSort();
  await loadSpan();
  /* المدى الافتراضي = آخر تاريخ في بيانات الأسعار نفسه (أو نؤول لليوم إن لا بيانات) */
  const last = lastDataDate('prices') || fmtDate(new Date());
  if (!$('#pr-to').value) $('#pr-to').value = last;
  if (!$('#pr-from').value) $('#pr-from').value = $('#pr-to').value;
  const from = $('#pr-from').value, to = $('#pr-to').value, item = $('#pr-item').value;
  const d = await api(`/api/prices/grid?from=${encodeURIComponent(from || '')}&to=${encodeURIComponent(to || '')}&item=${encodeURIComponent(item || '')}`);
  prRows = d.rows; prFields = d.fields; prMeta = d.meta;
  const eff = $('#pr-effdate'); if (eff) eff.textContent = d.to;
  renderPrKpis(d.meta);
  renderPrGrid();
}

/* لوحة «نظرة»: آخر سعر مسجَّل لكل صنف */
async function loadPrLatest() {
  await prLoadAllItems();
  const d = await api('/api/prices/latest');
  const item = ($('#pr-item') && $('#pr-item').value) || '';
  const rows = (d.rows || []).filter(r => !item || r.item_code === item);
  const src = $('#pr-src');
  if (src) {
    const last = rows.reduce((m, r) => (r.price_date > m ? r.price_date : m), '');
    src.textContent = last ? `آخر تحديث ${last} — ${rows.length} صنف` : 'لا توجد أسعار مسجَّلة بعد';
  }
  const pill = $('#pr-pending');
  if (pill) pill.style.display = 'none';
  table($('#tbl-pr-latest'), [
    { t: 'الصنف', k: 'item' },
    { t: 'الكود', k: 'item_code' },
    { t: 'التاريخ', k: 'price_date' },
    { t: 'التكلفة (أرضه)', k: 'cost_land', n: 1, f: r => money(r.cost_land) },
    { t: 'السوق (أرضه)', k: 'market_land', n: 1, f: r => money(r.market_land) },
    { t: 'العملة', k: 'currency' },
  ], rows, { empty: 'لا توجد أسعار مسجَّلة — استخدم زر «يدوى» لإضافة أسعار' });
}

function renderPrKpis(m) {
  const h = $('#pr-kpis'); if (!h) return;
  h.innerHTML = '';
  if (!m) return;
  kpi(h, { label: 'آخر تاريخ مسجَّل', value: m.last_date || '—', sub: 'في قاعدة البيانات', icon: '📅', g: 'g1' });
  kpi(h, { label: 'عدد الأصناف', value: n0(m.items), sub: 'لديها سعر مسجَّل', icon: '◇', g: 'g2' });
  kpi(h, { label: 'صفوف الأسعار', value: n0(m.source_rows), sub: 'في قاعدة البيانات', icon: '▤', g: 'g3' });
  kpi(h, { label: 'أيام المدى المعروض', value: n0(m.dates), sub: '× الأصناف = صفوف الشبكة', icon: '▦', g: 'g4' });
}

const prVal = v => (v === null || v === undefined || v === '') ? '—' : escHtml(v);
const prTitle = (r, field) => {
  const base = r.base[field] === '' ? '—' : r.base[field];
  const m = r.marks[field];
  return m
    ? `القيمة الأساسية: ${base} • تعديل سارٍ من ${m.eff}${m.by ? ' • بواسطة ' + m.by : ''}`
    : `القيمة الأساسية (المستوردة) — بدون تعديل`;
};
const prCellHtml = (r, field) => {
  const cls = 'cellbtn' + (r.marks[field] ? ' ov' : '');
  const title = escHtml(prTitle(r, field));
  const inner = prVal(r.value[field]);
  if (!can('sync')) return `<span class="${cls}" title="${title}">${inner}</span>`;
  return `<button type="button" class="${cls}" title="${title}" data-d="${r.date}" data-i="${escHtml(r.item_code)}" data-f="${field}">${inner}</button>`;
};

function renderPrGrid() {
  const onlyOv = $('#pr-onlyov')?.checked;
  const rows = onlyOv ? prRows.filter(r => Object.keys(r.marks).length) : prRows;
  const L = k => (prFields[k] && prFields[k].label) || k;
  const n2v = v => (v === null || v === undefined) ? '—' : n2(v);
  table($('#tbl-prices'), [
    { t: 'التاريخ', k: 'date' },
    { t: 'الصنف', k: 'item' },
    { t: 'الكود', k: 'item_code' },
    { t: L('cost'), n: 1, h: true, f: r => prCellHtml(r, 'cost') },
    { t: 'تكلفة وصال', n: 1, f: r => n2v(r.calc.cost_wasal) },
    { t: L('market'), n: 1, h: true, f: r => prCellHtml(r, 'market') },
    { t: 'سوق وصال', n: 1, f: r => n2v(r.calc.market_wasal) },
    { t: 'النولون', n: 1, f: r => n2v(r.calc.nolon) },
    { t: 'العملة', k: 'ccy', f: r => r.ccy ? escHtml(r.ccy) : '—' },
  ], rows, { limit: 3000, empty: 'لا توجد أسعار في هذا المدى — استخدم زر «يدوى» لإضافة الأسعار' });
}

$('#tbl-prices')?.addEventListener('click', e => {
  const b = e.target.closest('button.cellbtn[data-f]');
  if (b) openPrModal(b.dataset.d, b.dataset.i, b.dataset.f);
});
$('#pr-item')?.addEventListener('change', () => {
  if (!$('#pr-pane-edit').hidden) loadPrices().catch(e => toast(e.message));
  else loadPrLatest().catch(e => toast(e.message));
});
liveFilter(['pr-from', 'pr-to'], () => loadPrices().catch(e => toast(e.message)), 300);
$('#pr-onlyov')?.addEventListener('change', () => renderPrGrid());

/* زر «مسح» في شاشة الأسعار — يرجّع التاريخ لآخر يوم بيانات (أو اليوم إن لا بيانات) ويمسح الصنف وفلاتر الجداول */
$('#pr-clear')?.addEventListener('click', () => {
  const val = lastDataDate('prices') || fmtDate(new Date());
  const f = $('#pr-from'), t = $('#pr-to');
  if (f) f.value = val;
  if (t) t.value = val;
  const it = $('#pr-item'); if (it) it.value = '';
  clearTableFilters('#tbl-prices');
  clearTableFilters('#tbl-pr-latest');
  if (!$('#pr-pane-edit').hidden) loadPrices().catch(e => toast(e.message));
  else loadPrLatest().catch(e => toast(e.message));
});

function openPrModal(date, itemCode, field) {
  const row = prRows.find(r => r.date === date && r.item_code === itemCode);
  if (!row || !prFields[field]) return;
  prCell = { date, item_code: itemCode, field };
  const meta = prFields[field];
  const m = row.marks[field];
  $('#pr-title').textContent = 'تعديل: ' + meta.label;
  $('#pr-meta').innerHTML =
    `صنف <b>${escHtml(row.item)}</b> (${escHtml(row.item_code)}) — بتاريخ <b>${date}</b>` +
    (m ? ` — عليه تعديل سارٍ من <b>${m.eff}</b>${m.by ? ' بواسطة <b>' + escHtml(m.by) + '</b>' : ''}` : '');
  $('#pr-val').value = row.value[field] === null || row.value[field] === undefined ? '' : row.value[field];
  $('#pr-note').value = (m && m.note) || '';
  $('#pr-eff').textContent =
    `يسري من ${date} فما بعد على كل الأيام حتى تعديل أحدث. القيمة الأساسية: «${row.base[field] || '—'}»`;
  const err = $('#pr-err'); err.hidden = true;
  $('#pr-revert').style.display = m ? '' : 'none';
  const warn = $('#pr-warn');
  if (warn) {
    warn.innerHTML = 'القيمة الأساسية تصل من استيراد شيت <b>الاسعار</b>، والنظام يحمّلها للأمام إلى كل الأيام الجديدة — ' +
      'تعديلك يسري من تاريخه فما بعد ولا يلمسه الاستيراد. تعديل <b>النولون</b> يُعدَّل من شاشة البورصة.';
    warn.hidden = false;
  }
  $('#pr-modal').hidden = false;
  const inp = $('#pr-val'); inp.focus(); inp.select();
}

$('#pr-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  if (!prCell) return;
  const err = $('#pr-err'); err.hidden = true;
  const btn = $('#pr-btn'); btn.disabled = true;
  try {
    await api('/api/prices/override', {
      method: 'POST', headers: hdr,
      body: JSON.stringify({
        item_code: prCell.item_code, eff_date: prCell.date, field: prCell.field,
        value: $('#pr-val').value, note: $('#pr-note').value,
      }),
    });
    const { field, date } = prCell;
    $('#pr-modal').hidden = true;
    toast(`تم الحفظ ✔ ${prFields[field].label} يسري من ${date} فما بعد`);
    prItemsLoaded = false;
    await prLoadAllItems(true);
    await loadPrices();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  finally { btn.disabled = false; }
});

$('#pr-revert')?.addEventListener('click', async () => {
  if (!prCell) return;
  const err = $('#pr-err'); err.hidden = true;
  try {
    const r = await api('/api/prices/override/delete', {
      method: 'POST', headers: hdr,
      body: JSON.stringify({
        item_code: prCell.item_code, eff_date: prCell.date, field: prCell.field,
      }),
    });
    $('#pr-modal').hidden = true;
    toast(r.deleted ? 'تم إلغاء التعديل ✔ عادت الخلية للقيمة الأساسية' : 'لا يوجد تعديل لإلغائه');
    await loadPrices();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
});

/* سجل تعديلات الأسعار */
async function loadPrHist() {
  const rows = await api('/api/prices/overrides?limit=500');
  table($('#tbl-pr-hist'), [
    { t: 'يسري من', k: 'eff_date' },
    { t: 'الصنف', f: r => r.item_name || r.item_code },
    { t: 'الكود', k: 'item_code' },
    { t: 'العمود', h: true, f: r => escHtml((prFields[r.field] && prFields[r.field].label) || r.field) },
    { t: 'القيمة', k: 'value' },
    { t: 'ملاحظة', f: r => r.note ? escHtml(r.note) : '—' },
    { t: 'بواسطة', k: 'by_name' },
    { t: 'وقت الحفظ', h: true, f: r => String(r.created_at || '').slice(0, 16).replace('T', ' ') },
    { t: '', h: true, f: r => `<button class="btn sm ghost" data-prdel="${escHtml(r.item_code)}|${r.eff_date}|${r.field}">↩ إلغاء</button>` },
  ], rows, { empty: 'لا توجد تعديلات بعد' });
}
$('#btn-pr-hist')?.addEventListener('click', () => loadPrHist().catch(e => toast(e.message)));
$('#tbl-pr-hist')?.addEventListener('click', async e => {
  const b = e.target.closest('button[data-prdel]');
  if (!b) return;
  const [item_code, eff_date, field] = b.dataset.prdel.split('|');
  try {
    const r = await api('/api/prices/override/delete', { method: 'POST', headers: hdr, body: JSON.stringify({ item_code, eff_date, field }) });
    toast(r.deleted ? 'تم إلغاء التعديل ✔' : 'لا يوجد تعديل');
    await loadPrHist();
    if (prRows.length) await loadPrices();
  } catch (ex) { toast(ex.message); }
});

/* ---------------- التكلفة اليومية ---------------- */
let csData = { rows: [], level: 'detail' };
const METHOD_LABEL = { borse: 'بورصة', balance: 'أرصدة' };

async function loadCosts() {
  resetSort();
  await loadSpan();
  defaultRange('cs-from', 'cs-to', 'balances');
  if (!$('#cs-to').value) {
    const t = fmtDate(new Date());
    $('#cs-to').value = t;
    if (!$('#cs-from').value) $('#cs-from').value = t;
  }
  const from = $('#cs-from').value, to = $('#cs-to').value;
  const item = $('#cs-item').value;
  const unit = $('#cs-unit').value;
  const level = $('#cs-level').value;
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if (item) q.set('item', item);
  if (unit) q.set('unit', unit);
  q.set('level', level);
  const d = await api('/api/costs/grid?' + q.toString());
  csData = { rows: d.rows, level: d.level, from: d.from, to: d.to };
  csFillSelects(d.rows, d.level);
  renderCsKpis(d);
  renderCsGrid();
  api('/api/costs/status').then(s => {
    const w = ((s && s.warnings) || []).filter(x => x.code === 'zero_cost');
    const wh = $('#cs-warn');
    if (wh) wh.innerHTML = w.length
      ? ` <b class="neg">⚠ ${escHtml(w[0].title)}:</b> ${escHtml(w[0].detail)}`
      : '';
  }).catch(() => {});
}

function csFillSelects(rows, level) {
  const isel = $('#cs-item'), usel = $('#cs-unit');
  if (!isel || !usel) return;
  const curI = isel.value, curU = usel.value;
  /* فلتر الصنف من القائمة الأساسية الموحدة (بالكود) */
  fillItemSelect(isel, 'كل الأصناف', curI);
  const units = new Map();
  rows.forEach(r => {
    if (level === 'detail' && r.unit_code) units.set(r.unit_code, r.unit_name || r.unit_code);
  });
  const fill = (sel, vals, none, cur) => {
    if (!sel) return;
    sel.innerHTML = `<option value="">${none}</option>` +
      [...vals].map(([c, n]) => `<option value="${escHtml(c)}">${escHtml(String(n).slice(0, 42))} (${escHtml(c)})</option>`).join('');
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  };
  fill(usel, units, 'كل المصانع', curU);
  usel.disabled = level !== 'detail';
}

function renderCsKpis(d) {
  const h = $('#cs-kpis'); if (!h) return;
  h.innerHTML = '';
  const rows = d.rows || [];
  const items = new Set(rows.map(r => r.item_code)).size;
  const units = new Set(rows.filter(r => r.unit_code).map(r => r.unit_code)).size;
  const dates = new Set(rows.map(r => r.cost_date)).size;
  kpi(h, { icon: '📅', g: 'g1', label: 'المدى المعروض', value: d.from && d.to ? `${d.from} ← ${d.to}` : '—', sub: `${n0(dates)} يوم` });
  kpi(h, { icon: '◇', g: 'g2', label: 'عدد الأصناف', value: n0(items), sub: 'في المدى المعروض' });
  kpi(h, { icon: '▤', g: 'g3', label: 'مصانع', value: n0(units), sub: 'في العرض التفصيلي' });
  kpi(h, { icon: '∑', g: 'g4', label: 'صفوف المعروض', value: n0(rows.length), sub: 'حتى 3000 صف' });
}

function renderCsGrid() {
  const rows = csData.rows || [];
  if (csData.level === 'total') {
    table($('#tbl-costs'), [
      { t: 'التاريخ', k: 'cost_date' },
      { t: 'الصنف', k: 'item' },
      { t: 'الكود', k: 'item_code' },
      { t: 'المصدر', f: r => METHOD_LABEL[r.method] || r.method },
      { t: 'تكلفة الوحدة (مرجّح)', n: 1, h: true, f: r => money(r.cost) },
      { t: 'أدنى مصنع', n: 1, f: r => money(r.cost_min) },
      { t: 'أعلى مصنع', n: 1, f: r => money(r.cost_max) },
      { t: 'الكمية', n: 1, f: r => n2(r.qty) },
      { t: 'القيمة', n: 1, f: r => money(r.value) },
    ], rows, { limit: 3000, empty: 'لا توجد تكلفة في هذا المدى' });
    return;
  }
  table($('#tbl-costs'), [
    { t: 'التاريخ', k: 'cost_date' },
    { t: 'الصنف', k: 'item' },
    { t: 'الكود', k: 'item_code' },
    { t: 'المصنع', f: r => r.method === 'borse' ? 'عقد بورصة — بلا مصنع'
        : (r.unit_name ? `${r.unit_name} (${r.unit_code})` : (r.unit_code || '—')) },
    { t: 'الشركة', f: r => r.company_name || '—' },
    { t: 'المصدر', f: r => METHOD_LABEL[r.method] || r.method },
    { t: 'تكلفة الوحدة', n: 1, h: true, f: r => money(r.cost) },
    { t: 'الكمية', n: 1, f: r => n2(r.qty) },
    { t: 'القيمة', n: 1, f: r => money(r.value) },
  ], rows, { limit: 3000, empty: 'لا توجد تكلفة في هذا المدى' });
}

/* حالة المحرك: المصدران والبناء والتنبيهات */
async function loadCsStatus() {
  const s = await api('/api/costs/status');
  const k = $('#cs-skpis'); if (!k) return;
  k.innerHTML = '';
  const b = s.built || {};
  const mbor = (s.methods || []).find(m => m.method === 'borse');
  const mbal = (s.methods || []).find(m => m.method === 'balance');
  kpi(k, { icon: '∑', g: 'g1', label: 'صفوف التكلفة', value: n0(b.rows), sub: `${n0(b.dates)} يوم × ${n0(b.items)} صنف` });
  kpi(k, { icon: '⌁', g: 'g2', label: 'بورصة (سعر × ريت + مصاريف)', value: n0(mbor && mbor.rows), sub: 'الذرة / الصويا / البذرة' });
  kpi(k, { icon: '▤', g: 'g3', label: 'أرصدة (قيمة ÷ كمية)', value: n0(mbal && mbal.rows), sub: 'باقي الأصناف لكل مصنع' });
  kpi(k, { icon: '✅', g: 'g4', label: 'آخر يوم مبني', value: b.to_d || '—', sub: s.dirty ? `⚠ يعاد البناء من ${s.dirty}` : 'محدَّث حتى اليوم', tone: s.dirty ? undefined : 'good' });

  const src = s.sources || {};
  const fmtSrc = o => `${(o && o.from) || '—'} ← ${(o && o.to) || '—'}`;
  table($('#cs-status'), [
    { t: 'المصدر', h: true, f: r => `<b>${r.k}</b>` },
    { t: 'المدى', k: 'a' },
    { t: 'الحجم', k: 'b' },
    { t: 'المعادلة', k: 'c' },
  ], [
    { k: 'البورصة — جلب ذاتي (Yahoo + بنك مصر)', a: fmtSrc(src.borse), b: `${n0(src.borse && src.borse.dates)} يوم × ${n0(src.borse && src.borse.items)} صنف`, c: (src.borse && src.borse.formula) || '' },
    { k: 'الأرصدة — شيت في ملف اليوم', a: fmtSrc(src.balances), b: `${n0(src.balances && src.balances.dates)} تاريخ رصيد • ${n0(src.balances && src.balances.items)} صنف • ${n0(src.balances && src.balances.pairs)} (صنف × مصنع)`, c: (src.balances && src.balances.formula) || '' },
  ], { empty: '—' });

  const win = $('#cs-warnings');
  if (win) {
    const items = (s.warnings || []).map(w =>
      `<div class="hint warn" style="margin-top:8px"><b>⚠ ${escHtml(w.title)}</b><br>${escHtml(w.detail)}</div>`).join('');
    const dirty = s.dirty
      ? `<div class="hint warn" style="margin-top:8px"><b>⚠ بانتظار إعادة البناء من ${escHtml(s.dirty)}</b><br>تُبنى تلقائياً عند أول قراءة لشبكة التكلفة.</div>`
      : '';
    win.innerHTML = items + dirty;
  }
}

function showCostsPane(name) {
  $$('#cs-segs .seg').forEach(b => b.classList.toggle('on', b.dataset.pane === name));
  vis($('#cs-pane-view'), name === 'view');
  vis($('#cs-pane-status'), name === 'status');
  vis($('#cs-view-tools'), name === 'view');
  if (name === 'view') {
    if (!$('#cs-to').value) {
      const t = new Date(); $('#cs-to').value = fmtDate(t); $('#cs-from').value = fmtDate(t);
    }
    if (!csData.rows.length) loadCosts().catch(e => toast(e.message));
  }
  if (name === 'status') loadCsStatus().catch(e => toast(e.message));
}
$$('#cs-segs .seg').forEach(b => b.addEventListener('click', () => showCostsPane(b.dataset.pane)));
$('#cs-item')?.addEventListener('change', () => loadCosts().catch(e => toast(e.message)));
$('#cs-unit')?.addEventListener('change', () => loadCosts().catch(e => toast(e.message)));
liveFilter(['cs-from', 'cs-to', 'cs-level'], () => loadCosts().catch(e => toast(e.message)), 300);
$('#cs-clear')?.addEventListener('click', () => {
  const last = lastDataDate('balances') || fmtDate(new Date());
  $('#cs-from').value = last; $('#cs-to').value = last;
  $('#cs-level').value = 'detail';
  $('#cs-item').value = ''; $('#cs-unit').value = '';
  clearTableFilters('#tbl-costs');
  loadCosts().catch(e => toast(e.message));
});

/* ---------------- مركز التقارير (عرض داخل المتصفح + تصدير) ---------------- */
/* كيف يُعرض كل تقرير: عمود الجدول + نوع الرسم البياني (اختياري) */
/* ---------- مقاييس الحركة والأرصدة (مشتركة بين التفصيلي والإجمالي والفترات) ---------- */
function movementsMeasureCols() {
  return [
    { t: 'وارد كمية', k: 'in_qty', n: 1, f: r => n2(r.in_qty) },
    { t: 'وارد قيمة', k: 'in_val', n: 1, f: r => money(r.in_val) },
    { t: 'صادر كمية', k: 'out_qty', n: 1, f: r => n2(r.out_qty) },
    { t: 'صادر قيمة', k: 'out_val', n: 1, f: r => money(r.out_val) },
    { t: 'صافي كمية', k: 'qty', n: 1, f: r => n2(r.qty) },
    { t: 'صافي قيمة', k: 'amount', n: 1, f: r => money(r.amount) },
    { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
  ];
}

function repDetailCols(name) {
  if (name === 'movements-total') {
    return [
      { t: 'التاريخ', k: 'post_date', f: r => (r.post_date || '—') },
      { t: 'كود الصنف', k: 'item' },
      { t: 'اسم الصنف', k: 'item_desc' },
      { t: 'وحدة القياس', k: 'uom', f: r => (r.uom || '—') },
      { t: 'التوجيه', k: 'direction' },
      { t: 'نوع الحركة', k: 'move_type', f: r => (r.move_type || '—') },
      { t: 'المخزن', k: 'storage_loc' },
      { t: 'المكان', k: 'place' },
      { t: 'الوحدة', k: 'unit_code', f: r => (r.unit_code || '—') },
      { t: 'الشركة', k: 'company_code', f: r => (r.company_code || '—') },
      ...movementsMeasureCols(),
    ];
  }
  if (name === 'inventory-total') {
    return [
      { t: 'التاريخ', k: 'balance_date', f: r => (r.balance_date || '—') },
      { t: 'كود الصنف', k: 'item' },
      { t: 'اسم الصنف', k: 'item_desc' },
      { t: 'وحدة القياس', k: 'uom', f: r => (r.uom || '—') },
      { t: 'الوحدة', k: 'unit_code', f: r => (r.unit_code || '—') },
      { t: 'المخزن', k: 'storage_loc', f: r => (r.storage_loc || '—') },
      { t: 'المكان', k: 'place', f: r => (r.place || '—') },
      { t: 'الشركة', k: 'company_code', f: r => (r.company_code || '—') },
      { t: 'التصنيف', k: 'cls', f: r => r.cls + (r.class_code ? ' (' + r.class_code + ')' : '') },
      { t: 'المجموعة', k: 'grp', f: r => r.grp + (r.group_code ? ' (' + r.group_code + ')' : '') },
      { t: 'افتتاحي كمية', k: 'open_qty', n: 1, f: r => n2(r.open_qty) },
      { t: 'افتتاحي قيمة', k: 'open_val', n: 1, f: r => money(r.open_val) },
      { t: 'ختامي كمية', k: 'close_qty', n: 1, f: r => n2(r.close_qty) },
      { t: 'ختامي قيمة', k: 'close_val', n: 1, f: r => money(r.close_val) },
      { t: 'حركة كمية', k: 'move_qty', n: 1, f: r => n2(r.move_qty), cls: r => dv(r.move_qty) },
      { t: 'حركة قيمة', k: 'move_val', n: 1, f: r => money(r.move_val), cls: r => dv(r.move_val) },
    ];
  }
  /* contract-unified — تفصيلي: صف لكل بند تفصيلي */
  if (name === 'contract-unified') {
    return [
      { t: 'الرقم الداخلي', k: 'internal_no' },
      { t: 'تاريخ التعاقد', k: 'contract_date', f: r => r.contract_date || '—' },
      { t: 'التصنيف', k: 'classification', f: r => r.classification || '—' },
      { t: 'المورد', k: 'supplier', f: r => r.supplier || '—' },
      { t: 'المصدر', k: 'source_country', f: r => r.source_country || '—' },
      { t: 'شركة التعاقد', k: 'contracting_company', f: r => r.contracting_company || '—' },
      { t: 'رقم العقد', k: 'contract_no', f: r => r.contract_no || '—' },
      { t: 'كمية العقد', k: 'quantity', n: 1, f: r => n2(r.quantity), cls: r => dv(r.quantity) },
      { t: 'الشركة الداخلية', k: 'internal_company', f: r => r.internal_company || '—' },
      { t: 'الشركة الخارجية', k: 'external_company', f: r => r.external_company || '—' },
      { t: 'كمية التفصيل', k: 'detail_quantity', n: 1, f: r => n2(r.detail_quantity) },
      { t: 'الباخرة', k: 'vessel_name', f: r => r.vessel_name || '—' },
      { t: 'ميناء الوصول', k: 'arrival_port', f: r => r.arrival_port || '—' },
      { t: 'وصول متوقع', k: 'expected_arrival', f: r => r.expected_arrival || '—' },
      { t: 'بداية التشغيل', k: 'operation_start', f: r => r.operation_start || '—' },
      { t: 'نهاية التشغيل', k: 'operation_end', f: r => r.operation_end || '—' },
      { t: 'موقف المركب', k: 'vessel_status', f: r => r.vessel_status || '—' },
      { t: 'حالة العقد', k: 'contract_status', f: r => r.contract_status || '—' },
    ];
  }
  /* sales-total */
  return [
    { t: 'التاريخ', k: 'invoice_date' },
    { t: 'المستند', k: 'invoice_doc' },
    { t: 'كود الصنف', k: 'item' },
    { t: 'اسم الصنف', k: 'item_desc' },
    { t: 'وحدة القياس', k: 'uom', f: r => (r.uom || '—') },
    { t: 'التصنيف', k: 'cls', f: r => r.cls + (r.class_code ? ' (' + r.class_code + ')' : '') },
    { t: 'المجموعة', k: 'grp', f: r => r.grp + (r.group_code ? ' (' + r.group_code + ')' : '') },
    { t: 'المخزن', k: 'storage_loc' },
    { t: 'الوحدة', k: 'unit_code' },
    { t: 'المكان', k: 'place' },
    { t: 'الشركة', k: 'company_code' },
    { t: 'عملة الشركة', k: 'currency', f: r => (r.currency || '—') },
    { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
    { t: 'قيمة البيع', k: 'value', n: 1, f: r => money(r.value) },
    { t: 'تكلفة البيع', k: 'cost', n: 1, f: r => money(r.cost) },
    { t: 'مجمل الربح', k: 'profit', n: 1, f: r => money(r.profit), cls: r => dv(r.profit) },
    { t: 'الهامش %', k: 'marginPct', n: 1, f: r => pct(r.marginPct), cls: r => (r.marginPct || 0) < 0 ? 'neg' : 'pos' },
  ];
}
const REP_VIEW = {
  'reconcile': {
    cols: [
      { t: 'الصنف', k: 'item' }, { t: 'الوصف', k: 'item_desc' },
      { t: 'الموقع', k: 'storage_loc' }, { t: 'المكان', k: 'place' },
      { t: 'نهاية سابق', k: 'prev_date' }, { t: 'بداية لاحق', k: 'next_date' },
      { t: 'ختامي سابق', k: 'close_val', n: 1, f: r => money(r.close_val) },
      { t: 'افتتاحي لاحق', k: 'open_val', n: 1, f: r => money(r.open_val) },
      { t: 'فرق القيمة', k: 'diff_val', n: 1, f: r => money(r.diff_val), cls: r => Math.abs(r.diff_val || 0) > 1 ? 'neg' : 'pos' },
      { t: 'فرق الكمية', k: 'diff_qty', n: 1, f: r => n2(r.diff_qty || 0), cls: r => Math.abs(r.diff_qty || 0) > 0.001 ? 'neg' : 'pos' },
    ],
  },
  'borse-latest': {
    cols: [
      { t: 'الصنف', k: 'item' }, { t: 'الكود', k: 'item_code' }, { t: 'العقد', k: 'contract' },
      { t: 'التاريخ', k: 'borse_date' },
      { t: 'منخفض', k: 'low', n: 1, f: r => money(r.low) },
      { t: 'عالي', k: 'high', n: 1, f: r => money(r.high) },
      { t: 'الإغلاق', k: 'close', n: 1, f: r => money(r.close) },
      { t: 'التغير %', n: 1,
        f: r => (r.close != null && r.prev_close) ? pct((r.close - r.prev_close) / r.prev_close * 100) : '—',
        cls: r => (r.close != null && r.prev_close) ? ((r.close - r.prev_close) >= 0 ? 'pos' : 'neg') : '' },
      { t: 'التكلفة', k: 'cost_price', n: 1, f: r => money(r.cost_price) },
      { t: 'ريت $', k: 'usd_rate', n: 1, f: r => n2(r.usd_rate) },
    ],
  },
  /* ---------- تقارير عقود الاستيراد: تفصيلي • فترات (الإجمالي يُبنى ديناميكياً) ---------- */
  'contract-registrations-detail': {
    limit: 20000,
    cols: [
      { t: 'الرقم الداخلي', k: 'internal_no' },
      { t: 'تصنيف التعاقد', k: 'contract_category', f: r => r.contract_category || '—' },
      { t: 'نوع التعاقد', k: 'contract_type', f: r => r.contract_type || '—' },
      { t: 'تاريخ التعاقد', k: 'contract_date', f: r => r.contract_date || '—' },
      { t: 'التصنيف', k: 'classification', f: r => r.classification || '—' },
      { t: 'المورد', k: 'supplier', f: r => r.supplier || '—' },
      { t: 'المصدر', k: 'source_country', f: r => r.source_country || '—' },
      { t: 'شركة التعاقد', k: 'contracting_company', f: r => r.contracting_company || '—' },
      { t: 'رقم العقد', k: 'contract_no', f: r => r.contract_no || '—' },
      { t: 'الكمية', k: 'quantity', n: 1, f: r => n2(r.quantity), cls: r => dv(r.quantity) },
      { t: 'الشحن', k: 'shipping_type', f: r => r.shipping_type || '—' },
      { t: 'قيمة الشحن', k: 'shipping_value', n: 1, f: r => money(r.shipping_value) },
      { t: 'السعر المبدئي', k: 'initial_price', n: 1, f: r => n2(r.initial_price) },
      { t: 'بورصة التعاقد', k: 'contract_exchange', f: r => r.contract_exchange || '—' },
      { t: 'متوقع سداد', k: 'expected_payment_date', f: r => r.expected_payment_date || '—' },
      { t: 'حالة العقد', k: 'contract_status', f: r => r.contract_status || '—' },
      { t: 'سعر CIF متوقع', k: 'expected_cif_price', n: 1, f: r => n2(r.expected_cif_price) },
      { t: 'القيمة المتوقعة', k: 'expected_value', n: 1, f: r => money(r.expected_value) },
    ],
  },
  'contract-registrations-periods': {
    limit: 20000,
    chart: { kind: 'line', series: [
      { name: 'القيمة المتوقعة', color: '#5b8cff', x: 'ym', y: 'expected_value' },
    ] },
    cols: [
      { t: 'المستوى', k: 'level' },
      { t: 'الفترة', k: 'ym' },
      { t: 'عقود', k: 'contracts', n: 1, f: r => n0(r.contracts) },
      { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
      { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty), cls: r => dv(r.qty) },
      { t: 'قيمة الشحن', k: 'ship_val', n: 1, f: r => money(r.ship_val) },
      { t: 'القيمة المتوقعة', k: 'expected_value', n: 1, f: r => money(r.expected_value) },
    ],
  },
  /* ---------- صفحات Power BI لعقود الاستيراد (إعادة بناء) ---------- */
  'pbix-home': {
    limit: 5,
    cols: [
      { t: 'موقف ربط الخامات (ذرة)', k: 'hedge_position' },
      { t: 'الريت اليومى (مجموع)', k: 'daily_rate_sum', n: 1, f: r => n2(r.daily_rate_sum) },
      { t: 'عدد مراكب الذرة', k: 'corn_vessels', n: 1, f: r => n0(r.corn_vessels) },
      { t: 'قيمة المطلوب سداده', k: 'docs_value', n: 1, f: r => money(r.docs_value) },
    ],
  },
  'pbix-hedge-position': {
    limit: 500,
    filters: false,
    cols: [
      { t: 'التصنيف', k: 'cls' },
      { t: 'الكميات المدفوعة بدون تسعير', k: 'paid_unpriced', n: 1, f: r => n2(r.paid_unpriced) },
      { t: 'المتبقى من الكمية المفتوحة', k: 'remaining_open', n: 1, f: r => n2(r.remaining_open) },
      { t: 'رصيد المصانع', k: 'factory', n: 1, f: r => n2(r.factory) },
      { t: 'رصيد التغطية', k: 'coverage_balance', n: 1, f: r => n2(r.coverage_balance) },
      { t: 'Position', k: 'position', f: r => (r.coverage_balance != null && r.coverage_balance < 0) ? 'SHORT' : 'LONG', cls: r => (r.coverage_balance != null && r.coverage_balance < 0) ? 'neg' : 'pos' },
      { t: 'عدد العقود', k: 'contracts', n: 1, f: r => n0(r.contracts) },
      { t: 'عدد الأيام', k: 'days_enough', n: 1, f: r => n2(r.days_enough) },
    ],
  },
  'pbix-corn-vessels': {
    limit: 5000,
    cols: [
      { t: 'المصدر', k: 'source' },
      { t: 'المورد', k: 'supplier' },
      { t: 'الكمية', k: 'quantity', n: 1, f: r => n2(r.quantity) },
      { t: 'الشحن', k: 'shipping' },
      { t: 'قيمة الشحن', k: 'shipping_value', n: 1, f: r => money(r.shipping_value) },
      { t: 'موقف التسعير', k: 'pricing_status' },
      { t: 'السعر CIF', k: 'cif', n: 1, f: r => n2(r.cif) },
      { t: 'الباخرة', k: 'vessel' },
      { t: 'موقف السداد', k: 'payment_status' },
      { t: 'وصول متوقع', k: 'expected_arrival' },
      { t: 'موقف المركب', k: 'vessel_status' },
      { t: 'صافي البريم', k: 'net_premium', n: 1, f: r => n2(r.net_premium) },
      { t: 'شهر الوصول', k: 'arrival_month' },
      { t: 'أعلى قيمة بورصة', k: 'max_bourse', n: 1, f: r => n2(r.max_bourse) },
      { t: 'صافي البريم النهائي', k: 'final_net_premium', n: 1, f: r => n2(r.final_net_premium) },
    ],
  },
  'pbix-corn-summary': {
    limit: 200,
    cols: [
      { t: 'المصدر', k: 'source' },
      { t: 'كمية مراكب الذرة', k: 'qty', n: 1, f: r => n2(r.qty) },
      { t: 'عدد مراكب الذرة', k: 'vessels', n: 1, f: r => n0(r.vessels) },
    ],
  },
  'pbix-docs-value': {
    limit: 5000,
    cols: [
      { t: 'المورد', k: 'supplier' },
      { t: 'التصنيف', k: 'classification' },
      { t: 'متوقع سداد', k: 'expected_payment' },
      { t: 'حالة التجميع', k: 'status' },
      { t: 'كمية المطلوب سداده', k: 'to_pay_qty', n: 1, f: r => n2(r.to_pay_qty) },
      { t: 'سعر CIF المتوقع الفعلي', k: 'cif_actual', n: 1, f: r => n2(r.cif_actual) },
      { t: 'قيمة المطلوب سداده', k: 'value', n: 1, f: r => money(r.value) },
      { t: 'شهر السداد المتوقع', k: 'pay_month' },
    ],
  },
  'pbix-docs-class': {
    limit: 200,
    cols: [
      { t: 'التصنيف', k: 'cls' },
      { t: 'كمية المطلوب سداده', k: 'qty', n: 1, f: r => n2(r.qty) },
      { t: 'قيمة المطلوب سداده', k: 'value', n: 1, f: r => money(r.value) },
      { t: 'عدد السطور', k: 'lines', n: 1, f: r => n0(r.lines) },
    ],
  },
  'pbix-docs-month': {
    limit: 200,
    cols: [
      { t: 'شهر عربى سداد متوقع', k: 'month' },
      { t: 'كمية المطلوب سداده', k: 'qty', n: 1, f: r => n2(r.qty) },
      { t: 'قيمة المطلوب سداده', k: 'value', n: 1, f: r => money(r.value) },
      { t: 'عدد السطور', k: 'lines', n: 1, f: r => n0(r.lines) },
    ],
  },
  'pbix-priced-costs': {
    limit: 500,
    cols: [
      { t: 'التصنيف', k: 'cls' },
      { t: 'الريت اليومى', k: 'daily_rate', n: 1, f: r => n2(r.daily_rate) },
      { t: 'السعر بالدولار', k: 'price_usd', n: 1, f: r => n2(r.price_usd) },
      { t: 'التكلفة الحالية', k: 'current_cost', n: 1, f: r => money(r.current_cost) },
      { t: 'سعر السوق', k: 'market_price', n: 1, f: r => money(r.market_price) },
      { t: 'الفرق', k: 'diff', n: 1, f: r => money(r.diff), cls: r => dv(r.diff) },
    ],
  },
  'pbix-main-coverage': {
    limit: 500,
    cols: [
      { t: 'التصنيف', k: 'cls' },
      { t: 'رصيد المصانع', k: 'factory', n: 1, f: r => n2(r.factory) },
      { t: 'رصيد متاح ميناء', k: 'port', n: 1, f: r => n2(r.port) },
      { t: 'كمية مدفوعة وغير مفتوحة', k: 'paid_not_opened', n: 1, f: r => n2(r.paid_not_opened) },
      { t: 'كمية مطلوب سدادها', k: 'to_pay', n: 1, f: r => n2(r.to_pay) },
      { t: 'كمية تعاقدات', k: 'contracted', n: 1, f: r => n2(r.contracted) },
      { t: 'ما تم بيعه', k: 'sold', n: 1, f: r => n2(r.sold) },
      { t: 'إجمالى الرصيد', k: 'balance', n: 1, f: r => n2(r.balance) },
      { t: 'كمية الاستهلاك', k: 'consumption', n: 1, f: r => n2(r.consumption) },
      { t: 'يكفى يوم حتى تاريخ', k: 'enough_until' },
      { t: 'عدد الأيام', k: 'days_enough', n: 1, f: r => n2(r.days_enough) },
    ],
  },
  'pbix-additives-coverage': {
    limit: 500,
    cols: [
      { t: 'التصنيف', k: 'cls' },
      { t: 'إجمالى الرصيد', k: 'balance', n: 1, f: r => n2(r.balance) },
      { t: 'ميناء إضافات', k: 'port_additions', n: 1, f: r => n2(r.port_additions) },
      { t: 'تعاقدات إضافات', k: 'contract_additions', n: 1, f: r => n2(r.contract_additions) },
      { t: 'الإجمالى الكلى', k: 'items_total', n: 1, f: r => n2(r.items_total) },
      { t: 'الاستهلاك', k: 'consumption', n: 1, f: r => n2(r.consumption) },
      { t: 'المتاح يكفى يوم حتى تاريخ', k: 'enough_until' },
      { t: 'عدد الأيام', k: 'days_enough', n: 1, f: r => n2(r.days_enough) },
    ],
  },
};

let reportList = [];

function autoCols(rows) {
  if (!rows || !rows.length) return [];
  return Object.keys(rows[0]).map(k => ({
    t: k, k, n: typeof rows[0][k] === 'number',
    f: r => (typeof r[k] === 'number') ? n2(r[k]) : r[k],
  }));
}

function drawReportChart(cfg, rows) {
  const c = cfg && cfg.chart;
  const host = $('#rep-chart'), legend = $('#rep-legend');
  if (!c || !rows.length) { host.innerHTML = ''; legend.innerHTML = ''; return; }
  if (c.kind === 'hbar') {
    hBarChart(host, rows.filter(r => Number(r[c.value]) !== 0), { label: c.label, value: c.value });
    legend.innerHTML = '';
  } else if (c.kind === 'bar') {
    barChart(host, rows, { x: c.x, y: c.y, label: c.label || c.x });
    legend.innerHTML = '';
  } else if (c.kind === 'line') {
    const series = c.series.map(s => ({
      name: s.name, color: s.color,
      points: rows.filter(r => r[s.x] != null).map(r => ({ x: r[s.x], y: r[s.y] })),
    }));
    lineChart(host, series);
    legend.innerHTML = series.map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('');
  }
}

const reportQS = () => {
  const d = (document.getElementById('rf-date')?.value || '').trim();
  const p = new URLSearchParams();
  if (d) { p.set('from', d); p.set('to', d); }
  const item = (document.getElementById('rf-item')?.value || '').trim();
  if (item) p.set('item', item);
  const kind = (document.getElementById('pbix-kind')?.value || '').trim();
  if (kind) p.set('kind', kind);
  ['place','unit','storage','company','cls','grp','cust'].forEach(k => {
    const a = document.getElementById('rf-' + k), b = document.getElementById('rf-' + k + '-to');
    const fv = a ? String(a.value || '').trim() : '', tv = b ? String(b.value || '').trim() : '';
    if (fv) p.set(k + '_from', fv);
    if (tv) p.set(k + '_to', tv);
  });
  const s = p.toString();
  return s ? '?' + s : '';
};
/* ---------- تقارير «الإجمالي» في مركز التقارير: مستويَا تجميع لكل نطاق —
       «التجميع على مستوى» {صنف/مجموعة/تصنيف} و«والتفصيل على مستوى»
       {مكان/شركة/عميل/مخزن/وحدة}. الصفوف = (أساسي × تفصيل) أو الأساسي وحده. */
const REP_DOMAINS = {
  'sales-total': {
    primary: [
      { v: 'item', t: 'الصنف' },
      { v: 'grp', t: 'المجموعة' },
      { v: 'cls', t: 'التصنيف' },
    ],
    second: [
      { v: 'total', t: 'بدون تفصيل' },
      { v: 'place', t: 'المكان' },
      { v: 'company', t: 'الشركة' },
      { v: 'cust', t: 'العميل' },
      { v: 'storage', t: 'المخزن' },
      { v: 'unit', t: 'الوحدة' },
    ],
  },
  'movements-total': {
    primary: [
      { v: 'item', t: 'الصنف' },
      { v: 'grp', t: 'المجموعة' },
      { v: 'cls', t: 'التصنيف' },
    ],
    second: [
      { v: 'total', t: 'بدون تفصيل' },
      { v: 'place', t: 'المكان' },
      { v: 'company', t: 'الشركة' },
      { v: 'unit', t: 'الوحدة' },
      { v: 'storage', t: 'المخزن' },
    ],
  },
  'inventory-total': {
    primary: [
      { v: 'item', t: 'الصنف' },
      { v: 'grp', t: 'المجموعة' },
      { v: 'cls', t: 'التصنيف' },
    ],
    second: [
      { v: 'total', t: 'بدون تفصيل' },
      { v: 'place', t: 'المكان' },
      { v: 'company', t: 'الشركة' },
      { v: 'unit', t: 'الوحدة' },
      { v: 'storage', t: 'المخزن' },
    ],
  },
  'contract-registrations-total': {
    primary: [
      { v: 'cls', t: 'التصنيف' },
      { v: 'sup', t: 'المورد' },
      { v: 'src', t: 'المصدر' },
      { v: 'cat', t: 'تصنيف التعاقد' },
      { v: 'type', t: 'نوع التعاقد' },
      { v: 'stat', t: 'حالة العقد' },
      { v: 'ship', t: 'الشحن' },
    ],
    second: [
      { v: '', t: 'بدون تفصيل' },
      { v: 'sup', t: 'المورد' },
      { v: 'src', t: 'المصدر' },
      { v: 'ccomp', t: 'شركة التعاقد' },
      { v: 'type', t: 'نوع التعاقد' },
      { v: 'stat', t: 'حالة العقد' },
    ],
  },
  'contract-unified': {
    primary: [{ v: 'contract', t: 'العقد' }],
    second: [{ v: '', t: 'بدون تفصيل' }],
  },
};
/* أعمدة تقرير «الإجمالي» حسب النطاق — الصفوف: [فترة] g1 [+ g2] (+ الوصف لمستوى الصنف) */
function repTotalCols(name, g, l2, per) {
  const l1 = ({ item: 'الصنف', grp: 'المجموعة', cls: 'التصنيف',
    sup: 'المورد', src: 'المصدر', cat: 'تصنيف التعاقد', type: 'نوع التعاقد',
    stat: 'حالة العقد', ship: 'الشحن', ccomp: 'شركة التعاقد' })[g] || 'التجميع';
  const head = [...(per ? [{ t: 'الفترة', k: 'per' }] : []), { t: l1, k: 'g1' }, ...(l2 ? [{ t: l2, k: 'g2' }] : [])];
  const itemExtra = g === 'item' ? [{ t: 'الوصف', k: 'item_desc' }, { t: 'وحدة القياس', k: 'uom', f: r => (r.uom || '—') }] : [];
  if (name === 'movements-total') {
    return [...head, ...itemExtra,
      { t: 'عدد', k: 'lines', n: 1, f: r => n0(r.lines) },
      { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty), cls: r => dv(r.qty) },
      { t: 'القيمة', k: 'amount', n: 1, f: r => money(r.amount), cls: r => dv(r.amount) },
    ];
  }
  if (name === 'inventory-total') {
    return [...head, ...itemExtra,
      { t: 'افتتاحي (قيمة)', k: 'open_val', n: 1, f: r => money(r.open_val) },
      { t: 'ختامي (قيمة)', k: 'close_val', n: 1, f: r => money(r.close_val) },
      { t: 'التغير', n: 1, f: r => money(r.close_val - r.open_val), cls: r => dv(r.close_val - r.open_val) },
      { t: 'كمية ختامية', k: 'close_qty', n: 1, f: r => n2(r.close_qty) },
    ];
  }
  if (name === 'contract-registrations-total') {
    return [...head,
      { t: 'عقود', k: 'contracts', n: 1, f: r => n0(r.contracts) },
      { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
      { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty), cls: r => dv(r.qty) },
      { t: 'قيمة الشحن', k: 'ship_val', n: 1, f: r => money(r.ship_val) },
      { t: 'القيمة المتوقعة', k: 'expected_value', n: 1, f: r => money(r.expected_value) },
    ];
  }
  if (name === 'contract-unified') {
    return [
      { t: 'الرقم الداخلي', k: 'internal_no' },
      { t: 'تاريخ التعاقد', k: 'contract_date', f: r => r.contract_date || '—' },
      { t: 'التصنيف', k: 'classification', f: r => r.classification || '—' },
      { t: 'المورد', k: 'supplier', f: r => r.supplier || '—' },
      { t: 'المصدر', k: 'source_country', f: r => r.source_country || '—' },
      { t: 'شركة التعاقد', k: 'contracting_company', f: r => r.contracting_company || '—' },
      { t: 'رقم العقد', k: 'contract_no', f: r => r.contract_no || '—' },
      { t: 'الكمية', k: 'quantity', n: 1, f: r => n2(r.quantity), cls: r => dv(r.quantity) },
      { t: 'سعر CIF متوقع', k: 'expected_cif_price', n: 1, f: r => n2(r.expected_cif_price) },
      { t: 'القيمة المتوقعة', k: 'expected_value', n: 1, f: r => money(r.expected_value) },
      { t: 'متوقع سداد', k: 'expected_payment_date', f: r => r.expected_payment_date || '—' },
      { t: 'حالة العقد', k: 'contract_status', f: r => r.contract_status || '—' },
      { t: 'عدد التفصيلات', k: 'detail_lines', n: 1, f: r => n0(r.detail_lines) },
    ];
  }
  return [...head, ...itemExtra,
    { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
    { t: 'قيمة البيع', k: 'value', n: 1, f: r => money(r.value) },
    { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
    { t: 'تكلفة البيع', k: 'cost', n: 1, f: r => money(r.cost) },
    { t: 'مجمل الربح', k: 'profit', n: 1, f: r => money(r.profit), cls: r => dv(r.profit) },
    { t: 'الهامش %', k: 'marginPct', n: 1, f: r => pct(r.marginPct), cls: r => (r.marginPct || 0) < 0 ? 'neg' : 'pos' },
  ];
}
/* النطاقات: limit فقط — الأعمدة تُبنى من الاختيار الحالي */
Object.keys(REP_DOMAINS).forEach(rep => { REP_VIEW[rep] = { limit: 20000 }; });
/* اختيار التجميع محفوظ لكل نطاق على حدة (لا يضيع عند التنقل بين التقارير) */
const repGroups = {};
const repBreaks = {};
const repPers = {};
const repModes = {};
const REP_PERIODS = [
  { v: '', t: 'بدون فترة' },
  { v: 'week', t: 'أسبوعي' },
  { v: 'month', t: 'شهري' },
  { v: 'quarter', t: 'ربع سنوي' },
  { v: 'half', t: 'نصف سنوي' },
  { v: 'q3', t: '3 أرباع' },
  { v: 'year', t: 'سنوي' },
];
const REP_MODES = [
  { v: '', t: 'تقرير إجمالي' },
  { v: 'detail', t: 'تقرير تفصيلي' },
  { v: 'raw', t: 'بيانات خام' },
];
const repDomainOf = name => REP_DOMAINS[name] || null;
const repTotalSales = 'sales-total';

let currentReport = null;
/* عناصر إضافية خاصة بالتقرير المعروض: مستويَا التجميع + الفترة + ربط التكلفة */
let repLink = 'doc_item';
function renderRepOpts(name) {
  const host = $('#rep-opts');
  if (!host) return;
  const d = repDomainOf(name);
  host.hidden = !d;
  const wrap = $('#rep-link-wrap');
  if (wrap) wrap.hidden = name !== repTotalSales;
  if (!d) return;
  if (!repGroups[name]) repGroups[name] = d.primary[0].v;
  if (repBreaks[name] === undefined || repBreaks[name] === '') repBreaks[name] = 'total';
  if (repPers[name] === undefined) repPers[name] = '';
  if (repModes[name] === undefined) repModes[name] = 'detail';
  const sel = $('#rep-group');
  if (sel) {
    sel.innerHTML = d.primary.map(l => `<option value="${l.v}">${escHtml(l.t)}</option>`).join('');
    sel.value = repGroups[name];
  }
  const sel2 = $('#rep-break');
  if (sel2) {
    sel2.innerHTML = d.second.map(l => `<option value="${l.v}">${escHtml(l.t)}</option>`).join('');
    sel2.value = repBreaks[name];
  }
  const sel3 = $('#rep-per');
  if (sel3) {
    sel3.innerHTML = REP_PERIODS.map(l => `<option value="${l.v}">${escHtml(l.t)}</option>`).join('');
    sel3.value = repPers[name];
  }
  const sel4 = $('#rep-mode');
  if (sel4) {
    sel4.innerHTML = REP_MODES.map(l => `<option value="${l.v}">${escHtml(l.t)}</option>`).join('');
    sel4.value = repModes[name];
  }
  /* «تفصيلي» و«خام»: مستويات التجميع والتفصيل والفترة لا تنطبق عليهما — تُخفى */
  const simpleMode = (repModes[name] || '') !== '';
  [sel, sel2, sel3].forEach(s => { const lb = s && s.closest('label'); if (lb) lb.hidden = simpleMode; });
  const link = $('#rep-link');
  if (link) link.value = repLink;
}
$('#rep-opts')?.addEventListener('change', async e => {
  const cur = currentReport;
  if (e.target.id === 'rep-group' && cur && repDomainOf(cur)) {
    repGroups[cur] = e.target.value;
    showReport(cur).catch(err => toast(err.message));
  } else if (e.target.id === 'rep-break' && cur && repDomainOf(cur)) {
    repBreaks[cur] = e.target.value;
    showReport(cur).catch(err => toast(err.message));
  } else if (e.target.id === 'rep-per' && cur && repDomainOf(cur)) {
    repPers[cur] = e.target.value;
    showReport(cur).catch(err => toast(err.message));
  } else if (e.target.id === 'rep-mode' && cur && repDomainOf(cur)) {
    repModes[cur] = e.target.value;
    showReport(cur).catch(err => toast(err.message));
  } else if (e.target.id === 'rep-link') {
    const link = e.target.value;
    try {
      await api('/api/settings/cost', { method: 'POST', headers: hdr, body: JSON.stringify({ link }) });
      repLink = link;
      toast('تم تغيير طريقة الربط — يُعاد حساب الربحية');
    } catch (err) { toast(err.message); $('#rep-link').value = repLink; }
    if (cur && repDomainOf(cur)) showReport(cur).catch(() => {});
  }
});

async function showReport(name, opts = {}) {
  const meta = reportList.find(r => r.name === name);
  if (!meta) return;
  const soft = !!(opts && opts.soft);
  const dom = repDomainOf(name);
  const mode = dom ? (repModes[name] || '') : '';
  const isRaw = String(name).endsWith('-raw') || mode === 'raw';
  const apiName = dom ? name : name;
  const g = dom ? (repGroups[name] || dom.primary[0].v) : '';
  const b = dom ? (repBreaks[name] || '') : '';
  const per = dom ? (repPers[name] || '') : '';
  const brk = (mode === 'detail' || !b || b === 'total') ? '' : b;
  const byQ = dom ? '&by=' + encodeURIComponent(g) + '&by2=' + encodeURIComponent(brk) + '&per=' + encodeURIComponent(per) + '&mode=' + encodeURIComponent(mode) : '';
  const sig = apiName + '|' + g + '|' + b + '|' + per + '|' + mode;
  currentReport = name;
  rememberReport(name);
  
  $('#rep-title').textContent = meta.label;
  const _rrb = $('#rep-recon-btn'); if (_rrb) _rrb.style.display = apiName === 'reconcile' ? '' : 'none';
  renderRepOpts(name);
  const host = $('#rep-table');
  const qs = reportQS();
  /* زرّا التصدير (في رأس الشاشة وداخل العارض) — يُحدَّثان معًا */
  for (const btn of [$('#rep-csv'), $('#rep-csv-view')]) {
    if (!btn) continue;
    btn.style.display = '';
    btn.href = '/api/export?name=' + encodeURIComponent(apiName) + byQ + (qs ? '&' + qs.slice(1) : '');
  }
  /* الصفحة الرئيسية لعقود الاستيراد (pbix-home) — صفحة بطاقات بلا فلاتر/تصدير */
  const landing = apiName === 'pbix-home';
  $('#rf-view-tools').style.display = landing ? 'none' : '';
  /* تقرير موقف ربط الخامات: إخفاء الفلاتر العلوية واستبدالها بفلتر التصنيفات */
  if (apiName === 'pbix-hedge-position') {
    $('#rf-view-tools').style.display = 'none';
    const kindWrap = $('#pbix-kind-wrap');
    if (kindWrap) {
      kindWrap.style.display = '';
      const sel = $('#pbix-kind');
      if (sel && sel.options.length <= 1) {
        sel.innerHTML = '<option value="">كل التصنيفات</option>' +
          '<option value="خامات">خامات</option>' +
          '<option value="اضافات">اضافات</option>' +
          '<option value="بورصة">اصناف البورصة</option>';
      }
    }
  }
  $('#rep-opts').style.display = (landing || apiName === 'pbix-hedge-position') ? 'none' : '';
  if (landing || apiName === 'pbix-hedge-position') {
    for (const btn of [$('#rep-csv'), $('#rep-csv-view')]) if (btn) btn.style.display = 'none';
  }
  /* تقرير جديد (أو تغيّر مستويَي التجميع) → فلاتر أعمدة نظيفة */
  if (host.__lastReport !== sig) { host.__filters = {}; host.__groupBy = ''; host.__lastReport = sig; }
  /* فلاتر رؤوس الأعمدة: للتقارير الخام تُرسل للخادم ليُفلتر كل الشيت لا الصفحة فقط */
  let colf = '';
  if (isRaw) {
    const src = host.__filters || {};
    const active = {};
    Object.keys(src).forEach(k => {
      const r = src[k];
      if (!filterRuleActive(r)) return;
      if (typeof r === 'string') { active[k] = { op: 'contains', v: r }; return; }
      active[k] = {
        op: r.op || 'in',
        v: String(r.v === null || r.v === undefined ? '' : r.v),
        v2: String(r.v2 === null || r.v2 === undefined ? '' : r.v2),
      };
      if (Array.isArray(r.set)) active[k].set = r.set;
    });
    if (Object.keys(active).length) colf = '&cols=' + encodeURIComponent(JSON.stringify(active));
  }
  if (!soft) {
    $('#rep-meta').textContent = '';
    host.innerHTML = '';
    host.__colSig = null; host.__tbody = null;
    /* مسح أي تقرير سابق بالكامل — الرسم البياني والوصف والترقيم */
    const chart = document.getElementById('rep-chart');
    const legend = document.getElementById('rep-legend');
    const pager = document.getElementById('rep-pager');
    if (chart) chart.innerHTML = '';
    if (legend) legend.innerHTML = '';
    if (pager) { pager.innerHTML = ''; pager.hidden = true; }
  }
  host.dataset.report = isRaw ? '1' : '';
  try {
    const _recon = (apiName === 'reconcile');
   const _reconPage = _recon ? (repPage[apiName] || 1) : 1;
   const _pageParam = _recon ? '&page=' + _reconPage + '&limit=500'
     : (isRaw ? '&page=1&pageSize=100000' : '&limit=100000');
   const d = await api('/api/report?name=' + encodeURIComponent(apiName)
      + _pageParam   /* عرض كل الصفوف بلا حد */
      + byQ + (qs ? '&' + qs.slice(1) : '') + colf);
    const cfg = REP_VIEW[apiName] || REP_VIEW[name];
    if (landing) {
      renderPbixLanding(d);
      return;
    }
    $('#rep-meta').textContent =
      `${n0(d.total)} صف` + (isRaw ? (d.pages > 1 ? ` — صفحة ${n0(d.page)} من ${n0(d.pages)}` : '') : (d.total > d.rows.length ? ` — يُعرض أول ${n0(d.rows.length)} صف` : '')) +
      (d.desc ? ` • ${d.desc}` : '');
    drawReportChart(cfg, d.rows);
    /* أعمدة تقارير «الإجمالي» تُبنى من مستويَي التجميع الحاليَّين؛ وباقي التقارير من REP_VIEW.
       عنوان المستوى الثاني يُشتق من قائمة النطاق (الخادم يُعيد الصفوف فقط). */
    const l2 = dom ? (((dom.second || []).find(o => o.v === brk) || {}).t || '') : '';
    const domCols = dom ? (mode === 'detail' ? repDetailCols(name) : repTotalCols(name, g, l2, per)) : null;
    const cols = domCols || (cfg && cfg.cols) || (d.rows && d.rows.length ? autoCols(d.rows) : (host.__cols || []));
    table(host, cols, d.rows, { limit: 0, empty: 'لا توجد بيانات لهذا التقرير', filters: apiName === 'pbix-hedge-position' ? false : true });
    /* تعبئة قائمة التجميع حسب عمود */
    const gbSel = document.getElementById('rf-groupby');
    if (gbSel) {
      const cur = gbSel.value;
      gbSel.innerHTML = '<option value="">بدون تجميع</option>' +
        cols.filter(c => c.k).map(c => `<option value="${escHtml(c.k)}">${escHtml(c.t)}</option>`).join('');
      if (cur && [...gbSel.options].some(o => o.value === cur)) gbSel.value = cur;
    }
    /* شريط الفلاتر (دائماً للتقارير الخام): عدد الأعمدة المفلترة + صفوف مطابقة + مسح الكل */
    if (host.__bar && host.__barInfo) {
      const activeKeys = Object.keys(host.__filters || {}).filter(k => filterRuleActive(host.__filters[k]));
      const n = activeKeys.length;
      host.__bar.hidden = !(isRaw || n);
      if (n) {
        host.__barInfo.innerHTML = `<b>${n0(n)}</b> عمود مُفلتر — ${n0(d.total)} صف مطابق في كل الشيت`;
        host.__barClear.hidden = false;
      } else if (isRaw) {
        host.__barInfo.innerHTML = `<span class="muted">لا توجد فلاتر — اضغط أيقونة الفلتر أعلى أي عمود لعرض قيمه والتصفية بها</span>`;
        host.__barClear.hidden = true;
      } else {
        host.__barClear.hidden = true;
      }
    }
    renderRepPager(name, d, isRaw || name === 'reconcile');
  } catch (e) {
    $('#rep-meta').textContent = '';
    host.innerHTML = `<div class="neg" style="padding:16px">${e.message}</div>`;
    host.__colSig = null; host.__tbody = null;
    $('#rep-chart').innerHTML = ''; $('#rep-legend').innerHTML = '';
    renderRepPager(name, null, false);
  }
}

/* ---------- الصفحة الرئيسية لتقارير عقود الاستيراد (بنمط Power BI) ---------- */
function renderPbixLanding(d) {
  const r = (d && d.rows && d.rows[0]) || {};
  const host = document.getElementById('rep-table');
  if (!host) return;
  /* cards */
  const cards = document.createElement('div');
  cards.className = 'grid kpis pbix-kpis';
  const isShort = String(r.hedge_position || '').includes('SHORT');
  /* بطاقة موقف ربط الخامات — عنوان بالأعلى بجانب زر الدبوس، قيمة مع تباعد */
  const hedgeCard = document.createElement('div');
  hedgeCard.className = 'card kpi g1' + (isShort ? ' pink' : '');
  const hedgeTitle = 'موقف ربط الخامات';
  const allowedCommodities = ['البذرة','الذرة','الصويا'];
  const hedgeLines = String(r.hedge_position || '—').split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(parts => allowedCommodities.includes(parts[0] || ''))
    .map(parts => {
      const name = parts[0] || '';
      const pos = parts.slice(1).join(' ') || '';
      const isShortLine = pos.includes('SHORT');
      return `<div class="hedge-row"><span class="hedge-name">${escHtml(name)}</span><span class="hedge-pos ${isShortLine ? 'short' : 'long'}">${escHtml(pos)}</span></div>`;
    }).join('');
  hedgeCard.innerHTML =
    `<div class="top"><button class="kpi-pin" type="button" title="تثبيت">📌</button><div class="kpi-toplabel">${escHtml(hedgeTitle)}</div><div class="ico">🔗</div></div>` +
    `<div class="value hedge-value">${hedgeLines}</div>`;
  cards.appendChild(hedgeCard);
  kpi(cards, { icon: '💱', g: 'g2', label: 'ريت الدولار اليومي', value: n2(r.daily_rate_sum), sub: 'مجموع الريت اليومي المسجل' });
  kpi(cards, { icon: '🚢', g: 'g3', label: 'إجمالي مراكب الذرة', value: n0(r.corn_vessels), sub: 'عدد المركب لتوريد الذرة' });
  kpi(cards, { icon: '💵', g: 'g4', label: 'قيمة مطلوب سدادها', value: money(r.docs_value), sub: 'قيمة مستندات السداد المتوقعة' });
  /* image below cards */
  const imgWrap = document.createElement('div');
  imgWrap.className = 'pbix-image';
  imgWrap.innerHTML = '<img src="img/contracts-hero.jpg" alt="img" onerror="this.remove()">';
  host.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'pbix-landing';
  wrap.appendChild(cards);
  wrap.appendChild(imgWrap);
  host.appendChild(wrap);
}

/* إعادة جلب تقرير خام عند تغيّر فلاتر رؤوس الأعمدة (فلترة على كل الشيت عبر الخادم) */
onTableFilter = function () {
  if (!currentReport || !String(currentReport).endsWith('-raw')) return;
  repPage[currentReport] = 1;   /* فلتر جديد → نرجع إلى الصفحة الأولى */
  showReport(currentReport, { soft: true }).catch(() => {});
};

/* ترقيم صفحات التقارير الخام — كل البيانات متاحة صفحة صفحة */
let repPage = {};
function renderRepPager(name, d, isRaw) {
  const host = $('#rep-pager');
  if (!host) return;
  const _showPager = isRaw || name === 'reconcile';
  if (!_showPager || !d || !d.pages || d.pages < 2) { host.innerHTML = ''; host.hidden = true; return; }
  const page = d.page, pages = d.pages;
  const btn = (label, p, off, title) =>
    `<button type="button" class="btn sm ghost" data-pg="${p}" ${off ? 'disabled' : ''} title="${title || ''}">${label}</button>`;
  let nums = '';
  const from = Math.max(1, Math.min(page - 2, pages - 4));
  const to = Math.min(pages, from + 4);
  for (let i = from; i <= to; i++) nums += `<button type="button" class="btn sm${i === page ? '' : ' ghost'}" data-pg="${i}">${n0(i)}</button>`;
  host.hidden = false;
  host.innerHTML =
    `${btn('‹ الأولى', 1, page === 1, 'الصفحة الأولى')}
     ${btn('‹ السابقة', page - 1, page === 1, 'الصفحة السابقة')}
     <span class="muted xs" style="padding:0 4px">صفحة ${n0(page)} من ${n0(pages)}</span>
     ${nums}
     ${btn('التالية ›', page + 1, page === pages, 'الصفحة التالية')}
     ${btn('الأخيرة ›', pages, page === pages, 'الصفحة الأخيرة')}`;
}
$('#rep-recon-btn')?.addEventListener('click', async () => {
  const btn = $('#rep-recon-btn'); if (btn) btn.disabled = true;
  try {
    const qs = reportQS();
    const r = await api('/api/reconcile?limit=200' + (qs ? '&' + qs.slice(1) : ''));
    const host = $('#rep-table'); if (!host) return;
    host.innerHTML = '';
    const summary = document.createElement('div');
    summary.className = 'hint';
    summary.innerHTML = `المطابقة: ${n0(r.matched)} مطابق · <b class="neg">${n0(r.mismatches)}</b> غير مطابق · فرق إجمالي ${money(r.totalDiff)} · فجوات: ${n0(r.gaps.length)} · أزواج: ${n0(r.keys)}`;
    host.appendChild(summary);
    const cols = (REP_VIEW['reconcile'] && REP_VIEW['reconcile'].cols) || [];
    const sampleHost = document.createElement('div');
    host.appendChild(sampleHost);
    table(sampleHost, cols, r.sample || [], { limit: 0, empty: 'لا توجد مطابقات خاطئة' });
    if (r.gaps && r.gaps.length) {
      const gtitle = document.createElement('div');
      gtitle.className = 'hint warn';
      gtitle.style.marginTop = '8px';
      gtitle.innerHTML = '<b>فجوات تاريخ (غير متتالية — لم تُقارن):</b>';
      host.appendChild(gtitle);
      const gtable = document.createElement('div');
      host.appendChild(gtable);
      const gcols = [{ t: 'الصنف', k: 'item' }, { t: 'من', k: 'prev_date' }, { t: 'إلى', k: 'next_date' },
        { t: 'ختامي', k: 'close_val', n: 1, f: x => money(x.close_val) },
        { t: 'افتتاحي', k: 'open_val', n: 1, f: x => money(x.open_val) }];
      table(gtable, gcols, r.gaps, { limit: 0, empty: '' });
    }
    const meta = $('#rep-meta'); if (meta) meta.textContent = `${n0(r.mismatches)} غير مطابق · ${n0(r.gaps.length)} فجوة · ${n0(r.keys)} زوج`;
  } catch (e) { toast(e.message); }
  btn.disabled = false;
});
$('#rep-pager')?.addEventListener('click', e => {
  const b = e.target.closest('button[data-pg]');
  if (!b || b.disabled) return;
  repPage[currentReport] = Number(b.dataset.pg) || 1;
  if (currentReport) showReport(currentReport).catch(err => toast(err.message));
});

let rfDimsLoaded = false;
/* مجموعة كل تقرير — تقسيم مركز التقارير */
const REP_GROUPS = {
  sales: {
    label: 'تقارير مبيعات', icon: '◈',
    keys: ['sales-total'],
  },
  store: {
    label: 'تقارير مخازن', icon: '⇄',
    keys: ['movements-total'],
  },
  bal: {
    label: 'تقارير أرصدة', icon: '◫',
    keys: ['inventory-total', 'reconcile', 'borse-latest', 'borse-raw'],
  },
  pbix: {
    label: 'تقارير Power BI (عقود)', icon: '📊',
    keys: ['pbix-home', 'pbix-hedge-position', 'pbix-corn-vessels', 'pbix-corn-summary',
      'pbix-docs-value', 'pbix-docs-class', 'pbix-docs-month', 'pbix-priced-costs',
      'pbix-main-coverage', 'pbix-additives-coverage'],
  },
};
let currentRepGroup = 'sales';
const repGroupKeys = g => (REP_GROUPS[g] ? REP_GROUPS[g].keys : []);
/* التقارير غير المصنّفة تُلحق بآخر مجموعة تُذيّل بها */
function reportGroupOf(name) {
  for (const [g, d] of Object.entries(REP_GROUPS)) if (d.keys.includes(name)) return g;
  return null;
}

async function loadReports() {
  resetSort();
  await loadSpan();
  const rfDate = document.getElementById('rf-date');
  if (rfDate && !String(rfDate.value || '').trim()) {
    rfDate.value = lastDataDate('balances') || lastDataDate('movements') || '';
  }
  if (!rfDimsLoaded) {
    rfDimsLoaded = true;
    fillDimPair('rf-place', 'rf-place-to', '/api/dims?dim=place&src=movements').catch(() => {});
    fillDimPair('rf-unit', 'rf-unit-to', '/api/dims?dim=unit&src=sales').catch(() => {});
    fillDimPair('rf-storage', 'rf-storage-to', '/api/dims?dim=storage&src=sales').catch(() => {});
    fillDimPair('rf-company', 'rf-company-to', '/api/dims?dim=company&src=sales').catch(() => {});
    fillDimPair('rf-cls', 'rf-cls-to', '/api/dims?dim=cls&src=sales').catch(() => {});
    fillDimPair('rf-grp', 'rf-grp-to', '/api/dims?dim=grp&src=sales').catch(() => {});
    fillDimPair('rf-cust', 'rf-cust-to', '/api/dims?dim=cust&src=sales').catch(() => {});
  }
  reportList = await api('/api/reports');
  [
    { name: 'sales-total', label: 'المبيعات' },
    { name: 'movements-total', label: 'الحركات' },
    { name: 'inventory-total', label: 'الأرصدة' },
  ].forEach(v => { if (!reportList.some(r => r.name === v.name)) reportList.push(v); });
  repPage = {};
}

/* نطاق التاريخ الافتراضي لمركز التقارير: عند أول اختيار أو عند تبديل المجموعة
   يُملأ النطاق بمدى بيانات تلك المجموعة كاملاً — حتى لا يظهر التقرير فارغاً
   (سابقاً: يوم واحد فقط من مدا الحركات فكانت تقارير المبيعات/Aرصدة «لا توجد بيانات»).
   بعد ذلك يبقى النطاق على ما اختاره المستخدم حتى يغيّر المجموعة. */
let lastRepRangeGrp = null;
const REP_SPAN_KEY = { sales: 'sales', store: 'movements', bal: 'balances', contracts: 'contracts', pbix: 'contracts' };
function applyReportRange(grp) {
  const el = document.getElementById('rf-date');
  if (!el) return;
  if (grp === lastRepRangeGrp) return;
  lastRepRangeGrp = grp;
  if (!SPAN) loadSpan();
  const s = SPAN && SPAN[REP_SPAN_KEY[grp] || 'movements'];
  if (s && s[1] && !String(el.value || '').trim()) el.value = s[1];
}

/* ملء القائمة المنسدلة بالتقارير لمجموعة واحدة — مع أي تقرير غير مصنّف */
function renderReportList(grp) {
  currentRepGroup = grp;
  applyReportRange(grp);
}



/* معايير التقارير: فلترة فورية — أي تغيير في التاريخ أو البحث يُعيد التقرير مباشرة */
const RF_FILTER_IDS = ['rf-date', 'rf-item',
  'rf-place', 'rf-place-to', 'rf-unit', 'rf-unit-to', 'rf-storage', 'rf-storage-to',
  'rf-company', 'rf-company-to', 'rf-cls', 'rf-cls-to', 'rf-grp', 'rf-grp-to',
  'rf-cust', 'rf-cust-to', 'pbix-kind'];
liveFilter(RF_FILTER_IDS,
  () => {
    if (!currentReport) return;
    if (currentReport === 'reconcile') repPage[currentReport] = 1;   /* تغيير فلتر → إعادة إلى الصفحة الأولى */
    showReport(currentReport).catch(e => toast(e.message));
  }, 400);

/* ---------------- المصادقة والمستخدمون ---------------- */
let me = null;
let roleLabels = { admin: 'مدير', accountant: 'محاسب', viewer: 'مشاهد' };
const can = p => !!(me && Array.isArray(me.perms) && me.perms.includes(p));
const escHtml = s => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const vis = (el, on) => {
  if (!el) return;
  if (on) { el.removeAttribute('hidden'); el.style.display = ''; }
  else el.style.display = 'none';
};

function enterLogin(msg) {
  vis($('#login-screen'), true);
  const err = $('#login-err');
  if (err) { err.hidden = !msg; if (msg) err.textContent = msg; }
  const u = $('#login-user'); if (u && document.activeElement !== u) u.focus();
}

/* الصفحة الرئيسية للمنصة: تجميع الشاشات الثلاث + حالة حقيقية من الواجهة */
function openPlatformHome() {
  closeNavMenus();
  $$('nav button').forEach(x => x.classList.remove('active'));
  document.querySelector(dropBtnSel('platform'))?.classList.add('active');
  current = PLATFORM_HOME;
  rememberScreen(PLATFORM_HOME);
  $$('section').forEach(s => s.classList.remove('active'));
  const sec = $('#tab-' + PLATFORM_HOME);
  if (!sec) { toast('صفحة المنصة غير موجودة في الواجهة'); return; }
  sec.classList.add('active');
  const t = TITLES[PLATFORM_HOME] || ['منصة التحليل والتقارير', ''];
  setHead(t[0], t[1]);
  $('#sidebar')?.classList.remove('open');
  if (window.PlatformShell && typeof window.PlatformShell.renderHome === 'function') {
    window.PlatformShell.renderHome();
  }
  if (window.PlatformShell && typeof window.PlatformShell.loadStatus === 'function') {
    window.PlatformShell.loadStatus().catch(() => {});
  }
  if (window.UiLayout && window.UiLayout.apply) { try { window.UiLayout.apply(); } catch (_) {} }
}

function goTab(name) {
  /* التبويبان المدموجان ⇒ شاشتهما المضيفة */
  name = platformHost(name);
  /* الصفحة الرئيسية للمنصة */
  if (isPlatformHome(name)) { openPlatformHome(); return; }
  /* شاشة التقارير لم تعد لها زر مستقل في الشريط — تُفتح عبر «لوحة المعلومات» */
  if (name === 'reports') { openReportsScreen().catch(() => {}); return; }
  /* الشاشات المخصّصة: أزرارها في قائمة «الشاشات المخصّصة» (data-goto) */
  if (String(name || '').indexOf('cs_') === 0) {
    const cb = document.querySelector(`nav button[data-goto="${name}"]`);
    if (cb) { cb.click(); return; }
    if (typeof window.openCustomScreen === 'function') window.openCustomScreen(name);
    return;
  }
  /* زر «رجوع» يفتح صفحة القسم (بلاطات) — الزر الرئيسي في الشريط يفتح القائمة فقط.
     pricegroup بلا زر مستقل: تُضاء لها قائمة البيانات اليومية */
  const grp = name === 'pricegroup' ? 'daily' : name;
  if (MD_GROUPS[name] && DROP_SUBS[grp]) {
    $$('nav button').forEach(x => x.classList.remove('active'));
    document.querySelector(dropBtnSel(grp))?.classList.add('active');
    current = name;
    rememberScreen(name);
    showMdLanding(name);
    return;
  }
  const b = document.querySelector(`nav button[data-tab="${name}"]`)
    || document.querySelector(`nav button[data-goto="${name}"]`);
  if (b) b.click();
}

function applyRoleUI() {
  /* ظهور الشاشات: محدَّد بصلاحيات الشاشات التي يضبطها المدير */
  const tabs = me && Array.isArray(me.tabs) ? me.tabs : null;
  $$('nav button').forEach(b => {
    if (b.closest('.nav-tools')) return;   // أدوات الشريط (رجوع/تحديث/...) — لا تُعامل كتنقل ولا تُخفى بالصلاحيات
    if (b.closest('.nav-menu')) return;   // عناصر القوائم المنسدلة — تُدار بفتح/غلق القائمة لا بالصلاحيات
    if (b.dataset.goto) { vis(b, tabAllowed(b.dataset.goto)); return; }
    if (b.dataset.drop) { vis(b.closest('.nav-drop') || b, (DROP_SUBS[b.dataset.drop] || []).some(t => tabAllowed(t))); return; }
    const g = MD_GROUPS[b.dataset.tab];
    if (g) vis(b, g.subs.some(t => tabAllowed(t)));
    else vis(b, tabAllowed(b.dataset.tab));
  });
  vis($('#btn-borse-fetch'), can('sync'));
  vis($('#btn-be-fetch'), can('sync'));
  vis($('#btn-refresh'), !!me);
  vis($('#me-chip'), !!me);
  if (me) {
    const name = me.full_name || me.username;
    $('#me-name').textContent = name;
    $('#me-role').textContent = me.roleLabel;
    $('#me-avatar').textContent = (name || '?').trim().charAt(0) || '؟';
  }
  /* إن كانت الشاشة الحالية ممنوعة → الذهاب لأول شاشة مسموحة */
  /* التخطيط يُطبَّق بعد الصلاحيات ⇒ إخفاء التخطيط لا يلغي إخفاء الصلاحية */
  if (window.UiLayout && window.UiLayout.isLoaded && window.UiLayout.isLoaded()) {
    try { window.UiLayout.apply(); } catch (e) { /* تجاهل */ }
  }
  if (me && tabs && tabs.length && !tabAllowed(current)) goTab(tabs[0]);
}

/* ---------- الإجراءات المسجَّلة (يستعملها مصمم الشاشات للأزرار) ----------
   كل إجراء مرتبط بزر قائم في التطبيق ⇒ نفس مسار التنفيذ ونفس الصلاحيات.
   لا يُقبل اسم دالة عشوائي ولا كود حرّ. */
const UI_ACTIONS = {
  refresh: { label: 'تحديث البيانات', perm: null, host: '#btn-refresh' },
  /* أفعال التطبيق الحقيقية (أزرار قائمة بمعرّفاتها الثابتة) */
  fetchBorseDaily: { label: 'سحب البورصة اليومية', perm: 'sync', host: '#btn-borse-fetch' },
  fetchBePrices: { label: 'سحب الأسعار (be)', perm: 'sync', host: '#btn-be-fetch' },
  reportExportCsv: { label: 'تصدير التقرير CSV', perm: null, host: '#rep-csv' },
  reportExportCsvView: { label: 'تصدير التقرير CSV (من العارض)', perm: null, host: '#rep-csv-view' },
  reportReconcile: { label: 'شاشة المطابقة', perm: null, host: '#rep-recon-btn' },
  wfRun: { label: 'تشغيل التدفق', perm: null, host: '#wf-run' },
  wfPreview: { label: 'معاينة التدفق', perm: null, host: '#wf-preview' },
  wfSave: { label: 'حفظ التدفق', perm: null, host: '#wf-save' },
  wfNew: { label: 'تدفق جديد', perm: null, host: '#wf-new' },
  rsSave: { label: 'حفظ التقرير', perm: null, host: '#rs-save' },
  rsSaveAs: { label: 'حفظ التقرير باسم', perm: null, host: '#rs-save-as' },
  rsValidate: { label: 'تحقق من التقرير', perm: null, host: '#rs-validate' },
  rsExport: { label: 'تصدير التقرير HTML', perm: null, host: '#rs-export' },
  rsExportXlsx: { label: 'تصدير التقرير Excel', perm: null, host: '#rs-export-xlsx' },
  rsDelete: { label: 'حذف التقرير', perm: null, host: '#rs-delete' },
  fetchBorse: { label: 'جلب البورصة', perm: 'sync', host: '#btn-borse-fetch' },
  fetchBe: { label: 'جلب الأسعار (be)', perm: 'sync', host: '#btn-be-fetch' },
  newReport: { label: 'تقرير جديد', perm: null, host: '#rs-new' },
  loadReport: { label: 'فتح تقرير محفوظ', perm: null, host: '#rs-load' },
  saveReport: { label: 'حفظ التقرير', perm: null, host: '#rs-save' },
  validateReport: { label: 'تحقق من التقرير', perm: null, host: '#rs-validate' },
  previewReport: { label: 'معاينة التقرير', perm: null, host: '#rs-preview' },
  exportReport: { label: 'تصدير التقرير (HTML)', perm: null, host: '#rs-export' },
  quickReport: { label: 'تقرير سريع', perm: null, host: '#rs-quick' },
  importLegacy: { label: 'استيراد تقرير من التطبيق', perm: null, host: '#rs-legacy-import' },
  addFilter: { label: 'إضافة فلتر للبيانات', perm: null, host: '#rs-add-filter' },
  uiPreview: { label: 'معاينة تخطيط الواجهة', perm: null, host: '#ss-ui-preview' },
};
window.UiActions = {
  list: () => Object.entries(UI_ACTIONS).map(([id, a]) => ({ id, label: a.label, perm: a.perm })),
  /* تعديل الإعدادات العامة (شاشات/قوائم/أزرار) يتطلّب صلاحية 'master' (نظام الصلاحيات الحالي).
     إن لم يُحسم المستخدم بعد (تحميل الجلسة) ⇒ نترك القرار للخادم (الحَكَم الحقيقي). */
  canEditSettings: () => {
    const u = (typeof me !== 'undefined' && me) ? me : null;
    if (!u) return true;
    if (u.role === 'admin') return true;
    return !!(Array.isArray(u.perms) && u.perms.indexOf('master') >= 0);
  },
  can: id => {
    const a = UI_ACTIONS[id];
    if (!a) return false;
    return !a.perm || can(a.perm);
  },
  run: id => {
    const a = UI_ACTIONS[id];
    if (!a) { toast('إجراء غير مسجَّل'); return false; }
    if (a.perm && !can(a.perm)) { toast('لا تملك صلاحية: ' + a.label); return false; }
    const host = a.host ? $(a.host) : null;
    if (!host) { toast('الإجراء غير متاح في هذه الشاشة'); return false; }
    try { host.click(); } catch (e) { toast('تعذّر تنفيذ الإجراء: ' + e.message); return false; }
    return true;
  },
};
/* اعتراض الأزرار التي لها إجراء مُتجاوز (أو مُنشأة) — بالتقاط قبل تنفيذ المعالج الأصلي */
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('button[data-ui-action], button[data-ui-id]') : null;
  if (!btn) return;
  const act = btn.getAttribute('data-ui-action');
  if (act) {
    e.preventDefault(); e.stopPropagation();
    window.UiActions.run(act);
    return;
  }
  const id = btn.getAttribute('data-ui-id');
  const it = (window.UiLayout && window.UiLayout.itemFor) ? window.UiLayout.itemFor(id) : null;
  if (!it || !it.action) return;   /* لا تجاوز ⇒ السلوك الأصلي كما هو */
  e.preventDefault(); e.stopPropagation();
  window.UiActions.run(it.action);
}, true);

/* ---------- طبقة تخطيط الواجهة المحفوظة (مصمم الشاشات والقوائم) ---------- */
let uiLayoutLoaded = false;
async function loadUiLayout() {
  if (uiLayoutLoaded || !window.UiLayout) return;
  uiLayoutLoaded = true;
  try {
    const r = await api('/api/reports/get?id=ui-layout', { quiet401: true });
    if (r && r.ui) {
      window.UiLayout.setModel(r.ui);
      window.UiLayout.apply();
    }
  } catch (e) { /* لا تخطيط محفوظ ⇒ الواجهة الافتراضية */ }
}

function enterApp(user) {
  me = user;
  vis($('#login-screen'), false);
  $('#login-err').hidden = true;
  loadItemsAll({ quiet401: true, force: true }).catch(() => {});   // تسخين قائمة الأصناف الأساسية الموحدة early
  /* تعبئة قوائم الأصناف في فلاتر التقارير (movements, sales, inventory) */
  fillItemSelect(document.getElementById('mf-item'), 'كل الأصناف');
  fillItemSelect(document.getElementById('sf-item'), 'كل الأصناف');
  fillItemSelect(document.getElementById('if-item'), 'كل الأصناف');
  const p = $('#login-pass'); if (p) p.value = '';
  applyRoleUI();
  loadUiLayout();
  /* الشاشات المخصّصة: تُبنى أقسامها وزرّها في الشريط حسب صلاحية المستخدم */
  if (typeof window.mountCustomScreens === 'function') window.mountCustomScreens().catch(() => {});
  const saved = (() => { try { return localStorage.getItem('ccs-screen'); } catch (_) { return null; } })();
  const okSaved = saved && (!me.tabs || !me.tabs.length || me.tabs.includes(saved)
    || (MD_GROUPS[saved] && mdSubsAllowed(saved).length));
  if (!(okSaved && showScreenByName(saved))) loadTab(current).catch(e => toast('خطأ: ' + e.message));
  if (user.mustChange) openPwModal(true);
}

/* ---- نافذة تغيير كلمة المرور ---- */
function openPwModal(force) {
  const forced = !!force;
  $('#pw-modal').hidden = false;
  $('#pw-close').style.display = forced ? 'none' : '';
  $('#pw-old-row').style.display = (forced && me && me.mustChange) ? 'none' : '';
  $('#pw-why').textContent = (forced && me && me.mustChange)
    ? 'حسابك ما زال على كلمة المرور الافتراضية — يجب تغييرها قبل متابعة العمل.'
    : 'أدخل كلمة المرور الحالية ثم كلمة المرور الجديدة (6 أحرف على الأقل).';
  $('#pw-form').reset();
  $('#pw-err').hidden = true;
  $('#pw-modal').dataset.forced = forced ? '1' : '';
  setTimeout(() => { const f = forced ? $('#pw-new') : $('#pw-old'); if (f) f.focus(); }, 60);
}

let pwBusy = false;   // حارس SubmitEvent: لا يُرسل الطلب مرتين عند الضغط المزدوج/Enter
$('#pw-form')?.addEventListener('submit', async ev => {
  ev.preventDefault();
  if (pwBusy) return;
  const err = $('#pw-err');
  const nw = $('#pw-new').value, nw2 = $('#pw-new2').value;
  const forced = $('#pw-modal').dataset.forced === '1';
  err.hidden = true;
  if (nw.length < 6) { err.textContent = 'كلمة المرور الجديدة: 6 أحرف على الأقل'; err.hidden = false; return; }
  if (nw !== nw2) { err.textContent = 'كلمتا المرور غير متطابقتين'; err.hidden = false; return; }
  pwBusy = true;
  const btn = $('#pw-btn'); btn.disabled = true; btn.textContent = 'جاري الحفظ...';
  try {
    await api('/api/auth/change-password', {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ old: $('#pw-old').value, password: nw }),
    });
    if (me) me.mustChange = false;
    $('#pw-modal').hidden = true;
    toast('تم تغيير كلمة المرور ✔');
  } catch (e) {
    if (e.message !== 'انتهى الجلسة') { err.textContent = e.message; err.hidden = false; }
  } finally {
    pwBusy = false;
    btn.disabled = false; btn.textContent = 'حفظ كلمة المرور';
    if (forced && err.hidden) $('#pw-modal').dataset.forced = '';
  }
});

/* ---- بطاقة المستخدمين في لوحة التحكم (تعبئة قوائم الأدوار) ---- */
async function initUsersForm() {
  try {
    const info = await api('/api/auth/login-info', { quiet401: true });
    if (info && info.roles) {
      roleLabels = Object.fromEntries(info.roles.map(r => [r.id, r.label]));
      const sel = $('#u-role');
      if (sel) {
        sel.innerHTML = info.roles.map(r => `<option value="${r.id}">${r.label}</option>`).join('');
        sel.value = 'viewer';
      }
    }
  } catch (_) {}
}

async function renderUsers() {
  try {
    const users = await api('/api/users');
    const cnt = $('#users-count');
    if (cnt) cnt.textContent = users.length ? users.length + ' مستخدم' : '';
    const sel = id => `<select class="input sm" data-act="role" data-id="${id}">` +
      Object.keys(roleLabels).map(r => `<option value="${r}">${roleLabels[r]}</option>`).join('') + '</select>';
    table($('#tbl-users'), [
      { t: 'المستخدم', h: true, f: r => {
          const ch = (r.full_name || r.username || '؟').trim().charAt(0) || '؟';
          return `<div class="urow">` +
            `<span class="u-avatar ${avc(r.username)}">${escHtml(ch)}</span>` +
            `<span><b>${escHtml(r.username)}</b>` +
            (r.full_name ? `<div class="muted xs">${escHtml(r.full_name)}</div>` : '') +
            (me && r.id === me.id ? '<div class="muted xs">◂ حسابك</div>' : '') +
            `</span></div>`;
        } },
      { t: 'الدور', h: true, f: r => sel(r.id).replace(`<option value="${r.role}">`, `<option value="${r.role}" selected>`) },
      { t: 'الحالة', h: true, f: r => (r.active ? '<span class="pill info">نشط</span>' : '<span class="pill error">معطّل</span>') +
          (r.must_change ? ' <span class="pill warning">كلمة افتراضية</span>' : '') },
      { t: 'آخر دخول', h: true, f: r => `<span class="muted xs">${escHtml(r.last_login || 'لم يدخل بعد')}</span>` },
      { t: 'إجراءات', h: true, f: r => `<div class="row" style="gap:6px">` +
          `<button class="btn sm ghost" title="إعادة تعيين كلمة المرور" data-act="pass" data-id="${r.id}" data-user="${escHtml(r.username)}">🔑</button>` +
          `<button class="btn sm ghost" title="${r.active ? 'تعطيل الحساب' : 'تفعيل الحساب'}" data-act="toggle" data-id="${r.id}" data-active="${r.active ? 1 : 0}">${r.active ? '⏸' : '▶'}</button>` +
          `<button class="btn sm ghost" title="حذف المستخدم" data-act="del" data-id="${r.id}">🗑</button>` +
        `</div>` },
    ], users, { empty: 'لا يوجد مستخدمون' });
    return users;
  } catch (e) { toast(e.message); return null; }
}

$('#user-form')?.addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    await api('/api/users', {
      method: 'POST', headers: hdr,
      body: JSON.stringify({
        username: $('#u-name').value, full_name: $('#u-full').value,
        role: $('#u-role').value, password: $('#u-pass').value,
      }),
    });
    toast('تمت إضافة المستخدم ✔');
    $('#user-form').reset();
    await renderUsers();
  } catch (e) { toast('خطأ: ' + e.message); }
});

$('#tbl-users')?.addEventListener('click', async ev => {
  const b = ev.target.closest('button[data-act]');
  if (!b || !can('users')) return;
  const id = Number(b.dataset.id), act = b.dataset.act;
  try {
    if (act === 'toggle') {
      const active = b.dataset.active === '1';
      await api('/api/users/update', { method: 'POST', headers: hdr, body: JSON.stringify({ id, active: !active }) });
      toast(active ? 'تم تعطيل المستخدم' : 'تم تفعيل المستخدم');
    } else if (act === 'pass') {
      const p = prompt(`كلمة المرور الجديدة لـ «${b.dataset.user}» (6 أحرف على الأقل):`);
      if (!p) return;
      await api('/api/users/update', { method: 'POST', headers: hdr, body: JSON.stringify({ id, password: p }) });
      toast('تم إعادة التعيين — سيُطلب من المستخدم تغييرها عند الدخول');
    } else if (act === 'del') {
      if (!confirm(`حذف المستخدم «${b.dataset.user}» نهائياً؟`)) return;
      await api('/api/users/delete', { method: 'POST', headers: hdr, body: JSON.stringify({ id }) });
      toast('تم حذف المستخدم');
    }
    await renderUsers();
  } catch (e) { toast('خطأ: ' + e.message); }
});

$('#tbl-users')?.addEventListener('change', async ev => {
  const s = ev.target.closest('select[data-act="role"]');
  if (!s || !can('users')) return;
  try {
    await api('/api/users/update', { method: 'POST', headers: hdr, body: JSON.stringify({ id: Number(s.dataset.id), role: s.value }) });
    toast('تم تغيير الدور إلى «' + (roleLabels[s.value] || s.value) + '»');
    await renderUsers();
  } catch (e) { toast('خطأ: ' + e.message); renderUsers(); }
});

/* ---- أزرار الدخول والخروج ---- */
$('#login-form')?.addEventListener('submit', async ev => {
  ev.preventDefault();
  const btn = $('#login-btn'), err = $('#login-err');
  btn.disabled = true; btn.textContent = 'جاري الدخول...'; err.hidden = true;
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ username: $('#login-user').value, password: $('#login-pass').value }),
    });
    const j = await r.json().catch(() => ({ ok: false, error: 'استجابة غير صالحة' }));
    if (!j.ok) throw new Error(j.error || 'فشل الدخول');
    enterApp(j.data.user);
  } catch (e) {
    err.textContent = e.message; err.hidden = false;
    const p = $('#login-pass'); p.value = ''; p.focus();
  } finally { btn.disabled = false; btn.textContent = 'دخول'; }
});

$('#btn-logout')?.addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  me = null;
  applyRoleUI();
  toast('تم تسجيل الخروج');
  enterLogin();
});

$('#me-chip')?.addEventListener('click', () => { if (me) openPwModal(false); });
$('#me-chip')?.setAttribute('title', 'الحساب — انقر لتغيير كلمة المرور');

$$('[data-close]').forEach(b => b.addEventListener('click', () => {
  const id = b.dataset.close;
  const el = document.getElementById(id);
  if (el && !(id === 'pw-modal' && el.dataset.forced === '1')) el.hidden = true;
}));

/* ---------------- الثيم والقائمة ---------------- */
const html = document.documentElement;
const savedTheme = localStorage.getItem('ccs-theme');
if (savedTheme) html.dataset.theme = savedTheme;
const syncThemeBtn = () => { const b = $('#btn-theme'); if (b) b.textContent = html.dataset.theme === 'light' ? '☾' : '☀'; };
syncThemeBtn();
$('#btn-theme')?.addEventListener('click', () => {
  html.dataset.theme = html.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('ccs-theme', html.dataset.theme);
  syncThemeBtn();
  if (me) { const n = activeScreen(); if (!MD_GROUPS[n]) loadTab(n).catch(() => {}); }
});

$('#scrim')?.addEventListener('click', () => $('#sidebar').classList.remove('open'));

/* ---------------- بدء التشغيل ---------------- */
/* الشاشة المعروضة فعلياً: قد تكون شاشة فرعية داخل قسم (md-items …). لا نعتمد على `current`
   لأنه يحمل معرّف القسم الأب (md/daily/pricegroup) وهو ليس من صلاحيات الشاشات، فيؤدي
   loadTab إلى حماية الصلاحيات وتحويلك لشاشة أخرى. */
function activeScreen() {
  const s = document.querySelector('section.active');
  const id = s && s.id ? s.id.replace(/^tab-/, '') : '';
  return id || current;
}
/* تذكّر آخر شاشة (حتى بعد تحديث الصفحة) مع مراعاة صلاحيات الدور */
function rememberScreen(name) {
  try { if (me && name) localStorage.setItem('ccs-screen', name); } catch (_) {}
}
function showScreenByName(name) {
  if (!name) return false;
  if (isPlatformHome(name)) { openPlatformHome(); return true; }
  if (name === 'reports') {
    /* فتح شاشة التقرير المحفوظ مباشرة — لا الضغط على زر القائمة المنسدلة */
    openReportsScreen(savedReport()).catch(() => {});
    return true;
  }
  if (MD_GROUPS[name]) { goTab(name); return true; }
  const el = document.querySelector(`nav button[data-tab="${name}"]`)
    || document.querySelector(`[data-sub="${name}"]`)
    || document.querySelector(`nav button[data-goto="${name}"]`);
  if (el) { el.click(); return true; }
  return false;
}
let refreshBusy = false;
$('#btn-refresh')?.addEventListener('click', async () => {
  const name = activeScreen();
  if (refreshBusy) return;
  if (MD_GROUPS[name]) { showMdLanding(name); toast('تم التحديث'); return; }
  /* الشاشات متعددة اللوحات: حدّث بيانات اللوحة المفتوحة نفسها — لا ترجع للوحة الأولى */
  const paneOf = seg => document.querySelector(seg + ' .seg.on')?.dataset.pane;
  refreshBusy = true;
  try {
    if (name === 'borse') {
      const p = paneOf('#borse-segs') || 'view';
      if (p === 'edit') await loadBorseEdit();
      else if (p === 'hist') await loadBorseHist();
      else await loadBorse();
    } else if (name === 'prices') {
      const p = paneOf('#pr-segs') || 'view';
      if (p === 'edit') await loadPrices();
      else if (p === 'hist') await loadPrHist();
      else await loadPrLatest();
    } else if (name === 'costs') {
      if ((paneOf('#cs-segs') || 'view') === 'status') await loadCsStatus();
      else await loadCosts();
    } else if (name === 'reports') {
      /* تحديث التقارير: أعد تحميل التقرير المفتوح نفسه — لا ترجع للوحة ولا تفتح القائمة */
      await openReportsScreen(currentReport || savedReport());
    } else await loadTab(name);
    toast('تم التحديث');
  } catch (e) { toast(e.message); }
  finally { refreshBusy = false; }
});
window.addEventListener('resize', () => {
  if (!me) return;
  const name = activeScreen();
  if (MD_GROUPS[name]) return;
  clearTimeout(window._rt);
  window._rt = setTimeout(() => loadTab(name).catch(() => {}), 300);
});

/* بدء التشغيل: فحص الجلسة ثم الدخول أو عرض شاشة تسجيل الدخول */
(async function boot() {
  applyRoleUI();                       // إخفاء ما لا يظهر قبل الدخول
  $('#login-btn').disabled = true;
  $('#login-btn').textContent = 'جاري التحقق...';
  try {
    const d = await api('/api/auth/me', { quiet401: true });
    enterApp(d.user);
  } catch (_) {
    enterLogin();
    fetch('/api/auth/login-info').then(r => r.json()).then(j => {
      if (j.ok && j.data.firstLogin) {
        const h = $('#login-hint');
        h.innerHTML = 'أول تشغيل للنظام — الدخول بـ <b>admin / admin123</b> ثم غيّر كلمة المرور فوراً.';
        h.hidden = false;
      }
    }).catch(() => {});
  } finally {
    $('#login-btn').disabled = false;
    $('#login-btn').textContent = 'دخول';
  }
})();
/* ===== Workflow Studio (MVP) — visual builder ===== */
(function () {
  const apiCall = (typeof api === 'function') ? api : (async (u, o) => {
    const r = await fetch(u, o); const j = await r.json(); if (!r.ok || !j.ok) throw new Error((j && (j.message || j.error)) || r.statusText); return (j && j.data) ? j.data : j;
  });
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  const STEP_TYPES = ['select','filter','compute','groupBy','pivot','unpivot','join','union','compare','dedupe','nulls','window','sort','python'];
  const TYPE_LABEL = {
    select:'select — اختيار وإعادة تسمية', filter:'filter — تصفية صفوف', compute:'compute — حساب عمود',
    groupBy:'groupBy — تجميع', pivot:'pivot — جدول محوري (Cross-tab)', unpivot:'unpivot — إلغاء المحورية',
    join:'join — ربط بمصدر مسجَّل', union:'union — اتحاد جداول',
    compare:'compare — مقارنة جدولين', dedupe:'dedupe — إزالة التكرار', nulls:'nulls — معالجة القيم الفارغة',
    window:'window — ترقيم/تراكم', sort:'sort — ترتيب',
    python:'python — تحويل Python مقيّد',
  };
  const FILTER_OPS = ['eq','ne','gt','gte','lt','lte','contains','startsWith','in','isNull','isNotNull'];
  const AGG_FNS = ['SUM','COUNT','COUNT_DISTINCT','AVG','MIN','MAX','MEDIAN','STDEV'];

  let steps = [];
  let sourceColumns = [];
  let editingIndex = null;
  let fns = [];
  let lastRunId = null;

  /* ---------- column propagation (mirror of workflow.js) ---------- */
  function wfColumns(list, src) {
    let cols = (src || []).slice();
    for (const s of (list || [])) {
      switch (s.type) {
        case 'select': {
          if (Array.isArray(s.columns) && s.columns.length) {
            const map = {};
            for (const r of (Array.isArray(s.renames) ? s.renames : [])) if (r && r.from && r.to) map[r.from] = r.to;
            cols = s.columns.map(c => map[c] || c);
          }
          break;
        }
        case 'filter': break;
        case 'compute': if (s.newColumn) cols = cols.concat([s.newColumn]); break;
        case 'groupBy': cols = (s.keys || []).slice().concat((s.aggs || []).map(a => a.out)); break;
        case 'pivot': cols = (s.rowKeys || []).slice(); break; // أعمدة Pivot الديناميكية تُعرف عند التنفيذ
        case 'unpivot': {
          const ids = (Array.isArray(s.idColumns) && s.idColumns.length)
            ? s.idColumns.slice()
            : cols.filter(c => !(s.valueColumns || []).includes(c));
          cols = ids.concat([s.keyName || 'variable', s.valueName || 'value']);
          break;
        }
        case 'join': {
          const rr = Array.isArray(s.rightRows) ? s.rightRows : [];
          const rc = rr.length ? Object.keys(rr[0]) : [];
          const prefix = s.rightPrefix || '';
          const out = cols.slice();
          for (const c of rc) { const n = prefix ? prefix + c : c; if (!out.includes(n)) out.push(n); }
          cols = out; break;
        }
        case 'union': break;
        case 'compare': cols = ['__status', '__key', '__left', '__right']; break;
        case 'dedupe': case 'nulls': break;
        case 'window': if (s.out && !cols.includes(s.out)) cols = cols.concat([s.out]); break;
        case 'python': {
          for (const op of (Array.isArray(s.operations) ? s.operations : [])) {
            if (op && op.out && !cols.includes(op.out)) cols = cols.concat([op.out]);
          }
          break;
        }
      }
    }
    return cols;
  }

  /* ---------- source fields ---------- */
  /* ---------- المعادلات المحفوظة (سجل مركزي مشترك بين الاستوديوين) ---------- */
  let wfFormulas = [];
  async function loadSavedFormulas() {
    try {
      const d = await apiCall('/api/formulas/saved');
      wfFormulas = (d && d.items) || [];
    } catch (e) { wfFormulas = []; }
  }
  function formulaOptions(selected) {
    const opts = ['<option value="">— لا شيء (اكتب التعبير) —</option>'];
    for (const f of wfFormulas) {
      opts.push('<option value="' + esc(f.id) + '"' + (selected === f.id ? ' selected' : '') + '>'
        + esc(f.name) + ' (نسخة ' + esc(String(f.version)) + ')</option>');
    }
    return opts.join('');
  }

  /* ---------- مصادر الفهرس (تُملأ من /api/datasets) ---------- */
  let wfSources = [];
  function renderWorkbookStatus(s) {
    const host = $('wf-workbook-status');
    if (!host) return;
    if (!s) { host.hidden = true; host.textContent = ''; return; }
    let text = '';
    let cls = 'wf-workbook-note';
    if (s.status === 'ready') {
      text = 'مصادر Excel جاهزة للقراءة فقط: ' + (s.sheetCount || (s.items || []).length) + ' ورقة من ' + (s.fileCount || 0) + ' ملف.';
      if (s.reason) { text += ' ' + s.reason; cls += ' is-warn'; }
    } else if (s.status === 'denied') {
      text = s.reason || 'ليس لديك صلاحية قراءة ملفات Excel — صلاحية الاستيراد (import) مطلوبة.';
      cls += ' is-err';
    } else if (s.status === 'unset') {
      text = s.reason || 'مصدر Excel غير مهيأ — اضبط WORKFLOW_WORKBOOK_DIR على مجلد قراءة مخصص.';
      cls += ' is-warn';
    } else {
      text = s.reason || 'مصدر Excel غير متاح.';
      cls += ' is-warn';
    }
    host.hidden = !text;
    host.className = cls;
    host.textContent = text;
  }
  async function loadSourceList() {
    try {
      const [ds, outs, files, workbooks] = await Promise.allSettled([
        apiCall('/api/datasets'),
        apiCall('/api/workflows/outputs'),
        apiCall('/api/datasets/files'),
        apiCall('/api/datasets/workbooks'),
      ]);
      const base = ds.status === 'fulfilled' ? ((ds.value && ds.value.items) || []) : [];
      const outputs = outs.status === 'fulfilled'
        ? (((outs.value && outs.value.items) || []).map(o => ({
            name: 'output:' + o.runId,
            label: 'نتيجة سابقة — ' + o.runId + (o.workflowName ? ' · ' + o.workflowName : '') + ' (' + (o.rowCount || 0) + ' صف)',
            domain: 'نتائج سابقة', canonical: false, isOutput: true,
          })))
        : [];
      renderWorkbookStatus(workbooks.status === 'fulfilled' ? workbooks.value : null);
      const localFiles = files.status === 'fulfilled'
        ? (((files.value && files.value.items) || []).map(f => Object.assign({}, f, { domain: 'ملفات محلية (اختبار)' })))
        : [];
      const workbookSources = workbooks.status === 'fulfilled'
        ? (((workbooks.value && workbooks.value.items) || []).map(f => Object.assign({}, f, { domain: 'ملفات Excel (قراءة فقط)' })))
        : [];
      wfSources = base.concat(outputs, localFiles, workbookSources);
      const sel = $('wf-source'); if (!sel) return;
      const cur = sel.value;
      const groups = {};
      for (const s of wfSources) {
        if (s.name === 'synthetic') continue;
        const dm = s.domain || 'أخرى';
        (groups[dm] = groups[dm] || []).push(s);
      }
      sel.innerHTML = '';
      const mem = document.createElement('option');
      mem.value = 'synthetic'; mem.textContent = 'بيانات تجريبية (synthetic)';
      sel.appendChild(mem);
      for (const dm of Object.keys(groups)) {
        const og = document.createElement('optgroup'); og.label = dm;
        for (const s of groups[dm]) {
          const o = document.createElement('option');
          o.value = s.isOutput ? 'output/' + s.name.slice(7)
            : (String(s.name).indexOf('file:') === 0 ? 'file/' + s.name.slice(5)
              : (String(s.name).indexOf('workbook:') === 0 ? 'workbook/' + s.name.slice(9) : 'dataset/' + s.name));
          /* تحذير واضح للمصدر غير المعتمد (يبقى متاحًا — لا استبعاد تلقائي) */
          const warn = s.canonicalNote ? ' — ⚠ غير المرجع المعتمد' : '';
          o.textContent = s.label + (s.canonical ? ' ★' : '') + warn;
          if (s.canonicalNote) o.title = s.canonicalNote;
          og.appendChild(o);
        }
        sel.appendChild(og);
      }
      if (cur) sel.value = cur;
      if (!sel.value) sel.value = 'synthetic';
    } catch (e) { /* القائمة قد لا تكون متاحة */ }
  }
  /* خيارات مصدر الربط (مصدر مسجَّل أو بيانات حرفية) */
  function sourceOptions(selected) {
    const opts = ['<option value="">— بيانات حرفية (JSON) —</option>'];
    for (const s of wfSources) {
      if (s.name === 'synthetic') continue;
      opts.push('<option value="' + esc(s.name) + '"' + (selected === s.name ? ' selected' : '') + '>'
        + esc(s.label) + (s.canonical ? ' ★' : '') + '</option>');
    }
    return opts.join('');
  }
  async function loadSourceFields() {
    const src = ($('wf-source') && $('wf-source').value) || 'synthetic';
    const name = src.startsWith('dataset/') ? src.slice(8)
      : (src.startsWith('output/') ? 'output:' + src.slice(7)
        : (src.startsWith('file/') ? 'file:' + src.slice(5)
          : (src.startsWith('workbook/') ? 'workbook:' + src.slice(9) : 'synthetic')));
    try {
      const d = await apiCall('/api/datasets/fields?name=' + encodeURIComponent(name));
      sourceColumns = (d && d.columns) || [];
      const fields = (d && d.fields) || sourceColumns.map(c => ({ name: c, type: 'any', description: '' }));
      const sample = (d && d.sample) || [];
      const host = $('wf-source-fields');
      const renderFields = (q) => {
        if (!host) return;
        const ql = (q || '').trim().toLowerCase();
        const filtered = ql ? fields.filter(f => (f.name + ' ' + (f.description || '')).toLowerCase().includes(ql)) : fields;
        host.innerHTML = filtered.map(f =>
          '<span class="wf-chip" title="' + esc(f.description || '') + '">' + esc(f.name) +
          '<span class="muted xs" style="margin-inline-start:4px">(' + esc(f.type || 'any') + ')</span></span>'
        ).join('') || '<span class="muted xs">لا حقول مطابقة</span>';
      };
      if (host) { host._fields = fields; host._render = renderFields; renderFields(''); }
      const search = $('wf-field-search');
      if (search) { search.value = ''; search.oninput = () => renderFields(search.value); }
      const row = $('wf-fields-row'); if (row) row.hidden = false;
      // sample panel
      const sampleHost = $('wf-source-sample');
      const sampleRow = $('wf-sample-row');
      if (sampleHost && sample.length) {
        const cols = Object.keys(sample[0]);
        let html = '<div class="hint">عينة (أول ' + sample.length + ' صفوف) — ليست بالضرورة كل البيانات</div>';
        html += '<table><thead><tr>' + cols.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>';
        sample.forEach(r => { html += '<tr>' + cols.map(c => '<td>' + esc(r[c]) + '</td>').join('') + '</tr>'; });
        html += '</tbody></table>';
        sampleHost.innerHTML = html;
        if (sampleRow) sampleRow.hidden = false;
      } else {
        if (sampleHost) sampleHost.innerHTML = '<div class="hint">لا توجد عينة متاحة</div>';
        if (sampleRow) sampleRow.hidden = false;
      }
    } catch (e) {
      sourceColumns = [];
      const host = $('wf-source-fields'); if (host) host.innerHTML = '<span class="neg xs">' + esc(e.message) + '</span>';
      const row = $('wf-fields-row'); if (row) row.hidden = false;
    }
  }
  function wfSource() {
    const v = ($('wf-source') && $('wf-source').value) || 'synthetic';
    if (v.indexOf('dataset/') === 0) return { type: 'dataset', name: v.slice(8), settings: { days: 120 } };
    if (v.indexOf('output/') === 0) return { type: 'output', name: v.slice(7) };
    if (v.indexOf('file/') === 0) return { type: 'file', name: v.slice(5) };
    return { type: 'memory', name: v };
  }
  /** الرسم المرئي الحالي (إن وُجد) — يُرسل مع تعريف التحليل ليترجمه الخادم إلى خطوات */
  function wfGraph() {
    try {
      if (window.WorkflowCanvas && typeof window.WorkflowCanvas.getGraph === 'function') {
        const g = window.WorkflowCanvas.getGraph();
        if (g && Array.isArray(g.nodes) && g.nodes.length) return g;
      }
    } catch (_) { /* المحرّر المرئي قد لا يكون محمّلًا */ }
    return null;
  }
  /** يضمّ الرسم إلى تعريف التحليل عند وجوده فقط (توافق كامل مع المسارات القديمة) */
  function wfWithGraph(wf) {
    const g = wfGraph();
    if (g) wf.graph = g;
    return wf;
  }
  /** مزامنة المحرّر المرئي مع الخطوات بعد تعديلها من القائمة المتقدمة */
  function wfSyncCanvasFromSteps(markDirty) {
    const c = window.WorkflowCanvas;
    if (!c || typeof c.loadWorkflow !== 'function') return;
    try {
      const src = wfSource();
      c.loadWorkflow({
        name: ($('wf-name') && $('wf-name').value) || 'untitled',
        source: src,
        steps: steps.slice(),
      }, { dirty: !!markDirty });
      if (markDirty && typeof c.markDirty === 'function') c.markDirty();
    } catch (_) { /* لا تعطّل التحرير المتقدم */ }
  }

  /* ---------- steps list ---------- */
  function stepSummary(s) {
    switch (s.type) {
      case 'select': return 'أعمدة: ' + (s.columns || []).join(', ');
      case 'filter': return (s.column || '?') + ' ' + (s.op || '?') + ' ' + JSON.stringify(s.value);
      case 'compute': return (s.newColumn || '?') + ' = ' + (s.formula || '');
      case 'groupBy': return 'مفاتيح: ' + (s.keys || []).join(',') + ' | تجميعات: ' + (s.aggs || []).map(a => a.fn + '(' + (a.column || '*') + ')→' + a.out).join(', ');
      case 'join': return (s.leftKey || '?') + ' ⋈ ' + (s.rightKey || '?') + ' (' + (s.joinType || 'inner') + ')' + (s.rightSource ? ' — ' + s.rightSource : '');
      case 'union': return 'اتحاد ' + (s.mode === 'strict' ? 'صارم' : 'متوافق') + (s.rightSource ? ' — ' + s.rightSource : '');
      case 'compare': return 'مفاتيح: ' + ((s.leftKeys || []).join(',')) + ' ↔ ' + ((s.rightKeys || []).join(',')) + (s.rightSource ? ' — ' + s.rightSource : '');
      case 'dedupe': return 'تكرار حسب: ' + (((s.keys || []).length ? s.keys.join(',') : 'كل الأعمدة')) + ' — ' + (s.keep === 'last' ? 'آخر' : 'أول');
      case 'nulls': return (s.action === 'fill' ? 'ملء' : 'حذف') + ' — أعمدة: ' + (((s.columns || []).length ? s.columns.join(',') : 'الكل'));
      case 'window': return (s.op || 'rowNumber') + ' → ' + (s.out || '?');
      case 'python': return 'Python مقيّد · ' + ((s.operations || []).length) + ' عملية — عمليات بيضاء فقط';
      case 'sort': return 'ترتيب: ' + ((s.by || []).join(', ')) + ' (' + (s.order || 'asc') + ')';
      default: return JSON.stringify(s);
    }
  }
  function renderSteps() {
    const host = $('wf-steps-list'); if (!host) return;
    if (!steps.length) { host.innerHTML = '<div class="hint">لا توجد خطوات. اضغط «＋ إضافة خطوة».</div>'; syncJson(); updateCount(); return; }
    host.innerHTML = steps.map((s, i) => {
      return '<div class="wf-step">' +
        '<div class="wf-step-rail"><span class="wf-step-num">' + (i + 1) + '</span><span class="wf-step-type pill">' + esc(s.type) + '</span></div>' +
        '<div class="wf-step-body"><div class="wf-step-id">' + esc(s.id || s.type) + '</div><div class="muted xs">' + esc(stepSummary(s)) + '</div></div>' +
        '<div class="wf-step-actions">' +
          '<button class="btn xs ghost" data-act="up" data-i="' + i + '" ' + (i === 0 ? 'disabled' : '') + ' title="أعلى">↑</button>' +
          '<button class="btn xs ghost" data-act="down" data-i="' + i + '" ' + (i === steps.length - 1 ? 'disabled' : '') + ' title="أسفل">↓</button>' +
          '<button class="btn xs" data-act="preview" data-i="' + i + '">معاينة</button>' +
          '<button class="btn xs" data-act="edit" data-i="' + i + '">تعديل</button>' +
          '<button class="btn xs danger" data-act="del" data-i="' + i + '">حذف</button>' +
        '</div></div>';
    }).join('');
    host.querySelectorAll('[data-act]').forEach(b => {
      b.addEventListener('click', () => {
        const i = Number(b.getAttribute('data-i'));
        const act = b.getAttribute('data-act');
        if (act === 'up' && i > 0) { const t = steps[i-1]; steps[i-1] = steps[i]; steps[i] = t; renderSteps(); }
        else if (act === 'down' && i < steps.length - 1) { const t = steps[i+1]; steps[i+1] = steps[i]; steps[i] = t; renderSteps(); }
        else if (act === 'del') { steps.splice(i, 1); if (editingIndex === i) closeEditor(); else if (editingIndex !== null && editingIndex > i) editingIndex--; renderSteps(); }
        else if (act === 'preview') wfPreviewStep(i);
        else if (act === 'edit') openEditor(i);
      });
    });
    syncJson(); updateCount();
  }
  function updateCount() { const el = $('wf-steps-count'); if (el) el.textContent = steps.length ? (steps.length + ' خطوة') : ''; }

  /* ---------- editor ---------- */
  let beforeCols = [];
  function openEditor(idx) {
    editingIndex = idx;
    const isNew = idx === null;
    const step = isNew ? { id: 's' + (steps.length + 1), type: 'select' } : JSON.parse(JSON.stringify(steps[idx]));
    const title = $('wf-editor-title'); if (title) title.textContent = (isNew ? 'إضافة خطوة' : 'تعديل الخطوة ' + (idx + 1));
    beforeCols = isNew ? wfColumns(steps, sourceColumns) : wfColumns(steps.slice(0, idx), sourceColumns);
    const body = $('wf-editor-body'); if (!body) return;
    body.innerHTML = editorForm(step);
    window.__wfStep = step;
    const editor = $('wf-editor'); if (editor) editor.hidden = false;
    wireEditor(step);
  }
  function closeEditor() { editingIndex = null; const e = $('wf-editor'); if (e) e.hidden = true; const b = $('wf-editor-body'); if (b) b.innerHTML = ''; showEditorErr(''); }

  /* ---------- حفظ معادلة في السجل المشترك (من داخل التطبيق) ---------- */
  const FN_WORDS = ['ADD','SUB','MUL','DIV','ABS','ROUND','CEIL','FLOOR','MIN2','MAX2','COALESCE','IFNULL','IF','UPPER','LOWER','TRIM','CONCAT','LEN','NUMF','R2F','YEAR','MONTH','DAY','MONTH_NAME','TODAY','DATEDIFF'];
  async function saveStepFormula() {
    const ta = $('ed-formula');
    const expr = ta ? String(ta.value || '').trim() : '';
    if (!expr) { toast('اكتب التعبير أولًا'); return; }
    const suggested = (($('ed-newcol') && $('ed-newcol').value) || '').trim() || ('معادلة ' + (steps.length + 1));
    const name = window.prompt('اسم المعادلة المحفوظة:', suggested);
    if (!name) return;
    /* الحقول: المعرّفات الواردة في التعبير + أنواعها من أعمدة المصدر المختار */
    const known = (($('wf-source-fields') && $('wf-source-fields')._fields) || []);
    const ids = Array.from(new Set((expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [])
      .filter(x => FN_WORDS.indexOf(x.toUpperCase()) < 0)));
    const fields = ids.map(id => {
      const f = known.find(k => k && k.name === id);
      return { name: id, type: (f && f.type) || 'any', description: (f && f.description) || '' };
    });
    try {
      const r = await apiCall('/api/formulas/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formula: { name: String(name).trim(), expr, fields, origin: 'visual' } }),
      });
      await loadSavedFormulas();
      /* إعادة رسم المحرّر ⇒ تظهر المعادلة الجديدة في قائمة «معادلة محفوظة» فورًا */
      const stepNow = window.__wfStep;
      if (stepNow) renderFields(stepNow.type || 'compute', stepNow);
      const sel = $('ed-formulaid');
      if (sel && r && r.id) sel.value = r.id;
      toast('تم حفظ المعادلة «' + name + '» — صارت متاحة في الاستوديو وفي المصمم');
    } catch (e) {
      toast('تعذّر الحفظ: ' + e.message);
    }
  }
  function editorForm(step) {
    const typeOpts = STEP_TYPES.map(t => '<option value="' + t + '"' + (step.type === t ? ' selected' : '') + '>' + esc(TYPE_LABEL[t]) + '</option>').join('');
    let html = '<div class="wf-row"><label>المعرّف (id):</label><input class="input sm" id="ed-id" value="' + esc(step.id || '') + '" /></div>';
    html += '<div class="wf-row"><label>النوع:</label><select class="wf-select" id="ed-type">' + typeOpts + '</select></div>';
    html += '<div id="ed-fields"></div>';
    return html;
  }
  function renderFields(type, step) {
    const body = $('ed-fields'); if (!body) return;
    const cols = beforeCols;
    let html = '';
    if (type === 'select') {
      html += '<div class="wf-row"><label>الأعمدة (Ctrl/Cmd لاختيار متعدد):</label><select class="wf-select" id="ed-cols" multiple size="6">' +
        cols.map(c => '<option value="' + esc(c) + '"' + ((step.columns || []).includes(c) ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>إعادة التسمية (JSON):</label><textarea class="wf-textarea" id="ed-renames" rows="2" placeholder=\'[{"from":"qty","to":"quantity"}]\'>' +
        esc(JSON.stringify(step.renames || [], null, 2)) + '</textarea></div>';
    } else if (type === 'filter') {
      html += '<div class="wf-row"><label>العمود:</label><select class="wf-select" id="ed-col">' + cols.map(c => '<option value="' + esc(c) + '"' + (step.column === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>العملية:</label><select class="wf-select" id="ed-op">' + FILTER_OPS.map(o => '<option value="' + o + '"' + (step.op === o ? ' selected' : '') + '>' + o + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>القيمة:</label><input class="input sm" id="ed-val" value="' + esc(step.value === undefined ? '' : (Array.isArray(step.value) ? step.value.join(',') : step.value)) + '" placeholder="للـ in: a,b,c" /></div>';
    } else if (type === 'compute') {
      html += '<div class="wf-row"><label>اسم العمود الجديد:</label><input class="input sm" id="ed-newcol" value="' + esc(step.newColumn || '') + '" /></div>';
      html += '<div class="wf-row"><label>معادلة محفوظة:</label><select class="wf-select" id="ed-formulaid">' + formulaOptions(step.formulaId) + '</select><span class="muted xs">تُملأ التعبير من السجل المشترك وتُحفظ مرجعها (معرّف + نسخة) — نفس المحرك في الاستوديوين.</span></div>';
      html += '<div class="wf-row"><label>المعادلة:</label><textarea class="wf-textarea" id="ed-formula" rows="3">' + esc(step.formula || '') + '</textarea></div>';
      html += '<div class="wf-row"><label>إدراج دالة:</label><div class="wf-fn-insert">' + fns.map(f => '<button type="button" class="btn xs ghost" data-fn="' + esc(f.name) + '">' + esc(f.name) + '</button>').join('') + '</div></div>';
      html += '<div class="wf-row"><button type="button" class="btn xs" id="ed-save-formula">احفظ كمعادلة</button><span class="muted xs">تُحفظ في السجل المشترك (باسم + حقول + نسخة) فتصبح متاحة في هذا الاستوديو وفي مصمم التقارير.</span></div>';
    } else if (type === 'groupBy') {
      html += '<div class="wf-row"><label>المفاتيح (متعدد):</label><select class="wf-select" id="ed-keys" multiple size="6">' + cols.map(c => '<option value="' + esc(c) + '"' + ((step.keys || []).includes(c) ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>التجميعات:</label><div id="ed-aggs"></div><button type="button" class="btn xs" id="ed-add-agg">＋ تجميع</button></div>';
    } else if (type === 'pivot') {
      html += '<div class="wf-row"><label>مفاتيح صفوف الجدول:</label><select class="wf-select" id="ed-prowkeys" multiple size="5">' +
        cols.map(c => '<option value="' + esc(c) + '"' + ((step.rowKeys || []).includes(c) ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>أعمدة المحورية (Cross-tab):</label><select class="wf-select" id="ed-pcolkeys" multiple size="5">' +
        cols.map(c => '<option value="' + esc(c) + '"' + ((step.columnKeys || []).includes(c) ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>القيم التجميعية (JSON):</label><textarea class="wf-textarea" id="ed-pvalues" rows="4" placeholder=\'[{"fn":"SUM","column":"qty","out":"qty"}]\'>' +
        esc(JSON.stringify(step.values || [], null, 2)) + '</textarea><span class="muted xs">كل قيمة: fn (SUM/COUNT/...)، column، out. أعمدة الناتج ديناميكية.</span></div>';
      html += '<div class="wf-row"><label>بادئة أعمدة الناتج:</label><input class="input sm" id="ed-pprefix" value="' + esc(step.prefix === undefined ? 'pivot_' : step.prefix) + '" /></div>';
      html += '<div class="wf-row"><label>قيمة الخلايا الفارغة (اختياري):</label><input class="input sm" id="ed-pfill" value="' + esc(step.fill === undefined ? '' : step.fill) + '" placeholder="فارغة = null" /></div>';
    } else if (type === 'unpivot') {
      html += '<div class="wf-row"><label>الأعمدة التي تتحول إلى صفوف:</label><select class="wf-select" id="ed-uvalues" multiple size="5">' +
        cols.map(c => '<option value="' + esc(c) + '"' + ((step.valueColumns || []).includes(c) ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>أعمدة الهوية (فارغة = كل ما عدا القيم):</label><select class="wf-select" id="ed-uids" multiple size="5">' +
        cols.map(c => '<option value="' + esc(c) + '"' + ((step.idColumns || []).includes(c) ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>اسم عمود المفتاح:</label><input class="input sm" id="ed-ukey" value="' + esc(step.keyName || 'variable') + '" /></div>';
      html += '<div class="wf-row"><label>اسم عمود القيمة:</label><input class="input sm" id="ed-uvalue" value="' + esc(step.valueName || 'value') + '" /></div>';
      html += '<div class="wf-row"><label><input type="checkbox" id="ed-udropnulls"' + (step.dropNulls ? ' checked' : '') + ' /> حذف الصفوف التي قيمتها null</label></div>';
    } else if (type === 'join') {
      html += '<div class="wf-row"><label>مفتاح اليسار:</label><select class="wf-select" id="ed-leftkey">'
        + cols.map(c => '<option value="' + esc(c) + '"' + (step.leftKey === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>مصدر الربط (من فهرس البيانات):</label><select class="wf-select" id="ed-rightsource">'
        + sourceOptions(step.rightSource) + '</select><span class="muted xs">مصدر مسجَّل — تُجلب صفوفه عند التنفيذ بصلاحياتك وحدود الصفوف، ويُسجَّل مستوى تفصيله.</span></div>';
      html += '<div class="wf-row"><label>مفتاح اليمين (عمود المصدر):</label><input class="input sm" id="ed-rightkey" value="' + esc(step.rightKey || '') + '" /></div>';
      html += '<div class="wf-row"><label>نوع الربط:</label><select class="wf-select" id="ed-jointype">'
        + ['inner','left'].map(j => '<option value="' + j + '"' + ((step.joinType || 'inner') === j ? ' selected' : '') + '>' + j + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>بادئة أعمدة اليمين (اختياري):</label><input class="input sm" id="ed-prefix" value="' + esc(step.rightPrefix || '') + '" /></div>';
      html += '<div class="wf-row"><label>بيانات الطرف الأيمن حرفية (JSON — للقديم فقط):</label><textarea class="wf-textarea" id="ed-rightrows" rows="3">'
        + esc(JSON.stringify(step.rightRows || [], null, 2)) + '</textarea></div>';
    } else if (type === 'union') {
      html += '<div class="wf-row"><label>الوضع:</label><select class="wf-select" id="ed-unionmode">'
        + ['align','strict'].map(m => '<option value="' + m + '"' + ((step.mode || 'align') === m ? ' selected' : '') + '>' + (m === 'strict' ? 'صارم' : 'متوافق') + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>المصدر الثاني:</label><select class="wf-select" id="ed-rightsource">' + sourceOptions(step.rightSource) + '</select></div>';
      html += '<div class="wf-row"><label>أو صفوف الطرف الثاني (JSON):</label><textarea class="wf-textarea" id="ed-rightrows" rows="3">'
        + esc(JSON.stringify(step.rightRows || [], null, 2)) + '</textarea></div>';
    } else if (type === 'compare') {
      html += '<div class="wf-row"><label>مفاتيح اليسار (متعدد):</label><select class="wf-select" id="ed-leftkeys" multiple size="4">'
        + cols.map(c => '<option value="' + esc(c) + '"' + ((step.leftKeys || []).includes(c) ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>المصدر الثاني:</label><select class="wf-select" id="ed-rightsource">' + sourceOptions(step.rightSource) + '</select></div>';
      html += '<div class="wf-row"><label>مفاتيح اليمين (مفصولة بفاصلة):</label><input class="input sm" id="ed-rightkeys" value="' + esc((step.rightKeys || []).join(',')) + '" /></div>';
      html += '<div class="wf-row"><label>أعمدة المقارنة (متعدد — فارغ = الكل):</label><select class="wf-select" id="ed-cmpcols" multiple size="4">'
        + cols.map(c => '<option value="' + esc(c) + '"' + ((step.compareColumns || []).includes(c) ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label><input type="checkbox" id="ed-includematched"' + (step.includeMatched ? ' checked' : '') + ' /> إظهار المطابق</label></div>';
      html += '<div class="wf-row"><label>أو صفوف الطرف الثاني (JSON):</label><textarea class="wf-textarea" id="ed-rightrows" rows="3">'
        + esc(JSON.stringify(step.rightRows || [], null, 2)) + '</textarea></div>';
    } else if (type === 'dedupe') {
      html += '<div class="wf-row"><label>مفاتيح التكرار (متعدد — فارغ = الكل):</label><select class="wf-select" id="ed-keys" multiple size="6">'
        + cols.map(c => '<option value="' + esc(c) + '"' + ((step.keys || []).includes(c) ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>الاحتفاظ:</label><select class="wf-select" id="ed-keep">'
        + ['first','last'].map(k => '<option value="' + k + '"' + ((step.keep || 'first') === k ? ' selected' : '') + '>' + (k === 'last' ? 'آخر صف' : 'أول صف') + '</option>').join('') + '</select></div>';
    } else if (type === 'nulls') {
      html += '<div class="wf-row"><label>الإجراء:</label><select class="wf-select" id="ed-nullaction">'
        + ['drop','fill'].map(a => '<option value="' + a + '"' + ((step.action || 'drop') === a ? ' selected' : '') + '>' + (a === 'fill' ? 'ملء' : 'حذف') + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>الأعمدة (متعدد — فارغ = الكل للحذف):</label><select class="wf-select" id="ed-cols" multiple size="6">'
        + cols.map(c => '<option value="' + esc(c) + '"' + ((step.columns || []).includes(c) ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>قيمة الملء:</label><input class="input sm" id="ed-nullvalue" value="' + esc(step.value === undefined ? '' : step.value) + '" /></div>';
      html += '<div class="wf-row"><label><input type="checkbox" id="ed-treatempty"' + (step.treatEmpty ? ' checked' : '') + ' /> النص الفارغ فارغ</label></div>';
    } else if (type === 'window') {
      html += '<div class="wf-row"><label>العملية:</label><select class="wf-select" id="ed-winop">'
        + ['rowNumber','rank','runningTotal'].map(o => '<option value="' + o + '"' + ((step.op || 'rowNumber') === o ? ' selected' : '') + '>' + o + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>اسم العمود الناتج:</label><input class="input sm" id="ed-winout" value="' + esc(step.out || '') + '" /></div>';
      html += '<div class="wf-row"><label>تقسيم المجموعات (متعدد):</label><select class="wf-select" id="ed-winpart" multiple size="4">'
        + cols.map(c => '<option value="' + esc(c) + '"' + ((step.partitionBy || []).includes(c) ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>الترتيب (متعدد):</label><select class="wf-select" id="ed-winorder" multiple size="4">'
        + cols.map(c => '<option value="' + esc(c) + '"' + ((step.orderBy || []).includes(c) ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>الاتجاه:</label><select class="wf-select" id="ed-winordir">'
        + ['asc','desc'].map(o => '<option value="' + o + '"' + ((step.order || 'asc') === o ? ' selected' : '') + '>' + o + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>عمود المجموع التراكمي:</label><select class="wf-select" id="ed-wincol">'
        + cols.map(c => '<option value="' + esc(c) + '"' + (step.column === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>';
    } else if (type === 'sort') {
      html += '<div class="wf-row"><label>الترتيب حسب (متعدد):</label><select class="wf-select" id="ed-sortby" multiple size="6">'
        + cols.map(c => '<option value="' + esc(c) + '"' + ((step.by || []).includes(c) ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>';
      html += '<div class="wf-row"><label>الاتجاه:</label><select class="wf-select" id="ed-sortorder">'
        + ['asc','desc'].map(o => '<option value="' + o + '"' + ((step.order || 'asc') === o ? ' selected' : '') + '>' + (o === 'asc' ? 'تصاعدي' : 'تنازلي') + '</option>').join('') + '</select></div>';
    } else if (type === 'python') {
      html += '<div class="wf-row"><label>عمليات Python المقيّدة (JSON):</label><textarea class="wf-textarea" id="ed-pyops" rows="8" placeholder=\'[{"op":"trim","column":"name","out":"name_clean"}]\'>'
        + esc(JSON.stringify(step.operations || [], null, 2)) + '</textarea></div>';
      html += '<div class="muted xs">وضع مقيّد فقط: trim/lower/upper/replace/round/math/concat/length/coalesce/to_number/to_text. لا كود ولا استيراد ولا ملفات أو شبكة.</div>';
    }
    body.innerHTML = html;
    /* اختيار معادلة محفوظة ⇒ يملأ التعبير (ويُبقي المرجع) */
    $('ed-save-formula')?.addEventListener('click', saveStepFormula);
    const fsel = $('ed-formulaid');
    if (fsel) {
      fsel.addEventListener('change', () => {
        const f = wfFormulas.find(x => x.id === fsel.value);
        const ta = $('ed-formula');
        if (f && ta) ta.value = f.expr;
      });
    }
    // wire insert-function buttons
    body.querySelectorAll('[data-fn]').forEach(b => {
      b.addEventListener('click', () => {
        const ta = $('ed-formula'); if (!ta) return;
        const name = b.getAttribute('data-fn');
        const pos = ta.selectionStart;
        ta.value = ta.value.slice(0, pos) + name + '(' + ta.value.slice(ta.selectionEnd);
        ta.focus();
      });
    });
    // groupBy aggs
    if (type === 'groupBy') {
      const aggsHost = $('ed-aggs');
      const initAggs = (window.__wfStep && window.__wfStep.type === 'groupBy' && Array.isArray(window.__wfStep.aggs)) ? window.__wfStep.aggs : [];
      renderAggs(initAggs);
      const addBtn = $('ed-add-agg');
      if (addBtn) addBtn.addEventListener('click', () => {
        const aggs = collectAggs().concat([{ fn: 'SUM', column: cols[0] || '', out: 'agg_' + (collectAggs().length + 1) }]);
        renderAggs(aggs);
      });
    }
  }
  function renderAggs(aggs) {
    const host = $('ed-aggs'); if (!host) return;
    const cols = beforeCols;
    host.innerHTML = (aggs || []).map((a, i) => {
      return '<div class="wf-row" data-agg="' + i + '" style="border:1px solid var(--line);padding:8px;border-radius:8px">' +
        '<div class="row">' +
        '<select class="wf-select" data-a="fn">' + AGG_FNS.map(f => '<option value="' + f + '"' + (a.fn === f ? ' selected' : '') + '>' + f + '</option>').join('') + '</select>' +
        '<select class="wf-select" data-a="col">' + cols.map(c => '<option value="' + esc(c) + '"' + (a.column === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>' +
        '<input class="input sm" data-a="out" value="' + esc(a.out || '') + '" placeholder="اسم الناتج" />' +
        '<button type="button" class="btn xs danger" data-a="del">✕</button>' +
        '</div></div>';
    }).join('');
    host.querySelectorAll('[data-a="del"]').forEach(b => {
      b.addEventListener('click', () => { const row = b.closest('[data-agg]'); if (row) row.remove(); });
    });
  }
  function collectAggs() {
    const host = $('ed-aggs'); if (!host) return [];
    const out = [];
    host.querySelectorAll('[data-agg]').forEach(row => {
      out.push({ fn: row.querySelector('[data-a="fn"]').value, column: row.querySelector('[data-a="col"]').value, out: row.querySelector('[data-a="out"]').value });
    });
    return out;
  }
  function wireEditor(step) {
    const typeSel = $('ed-type');
    if (!typeSel) return;
    const render = () => { const s = window.__wfStep || step; s.type = typeSel.value; renderFields(typeSel.value, s); };
    typeSel.addEventListener('change', render);
    render();
  }
  function collectStep() {
    const type = $('ed-type').value;
    const id = ($('ed-id') && $('ed-id').value.trim()) || ('s' + (steps.length + 1));
    const step = { id, type };
    if (type === 'select') {
      const sel = $('ed-cols'); step.columns = Array.from(sel.selectedOptions).map(o => o.value);
      const raw = ($('ed-renames') && $('ed-renames').value.trim()) || '[]';
      try { step.renames = JSON.parse(raw); }
      catch (e) { throw new Error('إعادات التسمية JSON غير صالح: ' + e.message); }
      if (!Array.isArray(step.renames)) throw new Error('إعادات التسمية يجب أن تكون مصفوفة');
    } else if (type === 'filter') {
      step.column = $('ed-col').value; step.op = $('ed-op').value;
      const raw = $('ed-val').value.trim();
      if (step.op === 'in') step.value = raw ? raw.split(',').map(x => x.trim()).filter(x => x !== '') : [];
      else if (raw === '') step.value = '';
      else if (!isNaN(Number(raw)) && raw !== '') step.value = Number(raw);
      else step.value = raw;
    } else if (type === 'compute') {
      step.newColumn = $('ed-newcol').value.trim();
      step.formula = $('ed-formula').value.trim();
      const fid = $('ed-formulaid') ? $('ed-formulaid').value : '';
      if (fid) {
        const f = wfFormulas.find(x => x.id === fid);
        step.formulaId = fid;
        step.formulaVersion = f ? f.version : null;
        step.formulaName = f ? f.name : '';
      } else {
        delete step.formulaId; delete step.formulaVersion; delete step.formulaName;
      }
    } else if (type === 'groupBy') {
      const ks = $('ed-keys');
      step.keys = Array.from(ks.selectedOptions).map(o => o.value);
      step.aggs = collectAggs();
    } else if (type === 'pivot') {
      const rk = $('ed-prowkeys'); step.rowKeys = rk ? Array.from(rk.selectedOptions).map(o => o.value) : [];
      const ck = $('ed-pcolkeys'); step.columnKeys = ck ? Array.from(ck.selectedOptions).map(o => o.value) : [];
      try { step.values = JSON.parse(($('ed-pvalues') && $('ed-pvalues').value) || '[]'); }
      catch (e) { throw new Error('قيم الجدول المحوري JSON غير صالحة: ' + e.message); }
      if (!Array.isArray(step.values)) throw new Error('قيم الجدول المحوري يجب أن تكون مصفوفة');
      step.prefix = ($('ed-pprefix') && $('ed-pprefix').value.trim()) || 'pivot_';
      const pf = ($('ed-pfill') && $('ed-pfill').value.trim()) || '';
      if (pf === '') delete step.fill;
      else step.fill = (!isNaN(Number(pf)) ? Number(pf) : pf);
    } else if (type === 'unpivot') {
      const uv = $('ed-uvalues'); step.valueColumns = uv ? Array.from(uv.selectedOptions).map(o => o.value) : [];
      const ui = $('ed-uids'); step.idColumns = ui ? Array.from(ui.selectedOptions).map(o => o.value) : [];
      step.keyName = ($('ed-ukey') && $('ed-ukey').value.trim()) || 'variable';
      step.valueName = ($('ed-uvalue') && $('ed-uvalue').value.trim()) || 'value';
      step.dropNulls = !!($('ed-udropnulls') && $('ed-udropnulls').checked);
    } else if (type === 'join') {
      step.leftKey = $('ed-leftkey').value;
      step.rightKey = $('ed-rightkey').value.trim();
      step.joinType = $('ed-jointype').value;
      const pref = $('ed-prefix').value.trim(); if (pref) step.rightPrefix = pref;
      const rsrc = $('ed-rightsource') ? $('ed-rightsource').value : '';
      if (rsrc) {
        step.rightSource = rsrc;
        delete step.rightRows;
      } else {
        try { step.rightRows = JSON.parse($('ed-rightrows').value || '[]'); }
        catch (e) { throw new Error('rightRows JSON غير صالح: ' + e.message); }
        if (!Array.isArray(step.rightRows)) throw new Error('rightRows يجب أن تكون مصفوفة');
      }
    } else if (type === 'union') {
      step.mode = $('ed-unionmode').value;
      const rsrc = $('ed-rightsource') ? $('ed-rightsource').value : '';
      if (rsrc) { step.rightSource = rsrc; delete step.rightRows; }
      else {
        try { step.rightRows = JSON.parse(($('ed-rightrows') && $('ed-rightrows').value) || '[]'); }
        catch (e) { throw new Error('rightRows JSON غير صالح: ' + e.message); }
        if (!Array.isArray(step.rightRows)) throw new Error('rightRows يجب أن تكون مصفوفة');
      }
    } else if (type === 'compare') {
      const lk = $('ed-leftkeys'); step.leftKeys = lk ? Array.from(lk.selectedOptions).map(o => o.value) : [];
      const rk = ($('ed-rightkeys') && $('ed-rightkeys').value.trim()) || '';
      step.rightKeys = rk ? rk.split(',').map(x => x.trim()).filter(Boolean) : [];
      const cc = $('ed-cmpcols'); step.compareColumns = cc ? Array.from(cc.selectedOptions).map(o => o.value) : [];
      step.includeMatched = !!($('ed-includematched') && $('ed-includematched').checked);
      const rsrc = $('ed-rightsource') ? $('ed-rightsource').value : '';
      if (rsrc) { step.rightSource = rsrc; delete step.rightRows; }
      else {
        try { step.rightRows = JSON.parse(($('ed-rightrows') && $('ed-rightrows').value) || '[]'); }
        catch (e) { throw new Error('rightRows JSON غير صالح: ' + e.message); }
        if (!Array.isArray(step.rightRows)) throw new Error('rightRows يجب أن تكون مصفوفة');
      }
    } else if (type === 'dedupe') {
      const ks = $('ed-keys'); step.keys = ks ? Array.from(ks.selectedOptions).map(o => o.value) : [];
      step.keep = $('ed-keep').value;
    } else if (type === 'nulls') {
      step.action = $('ed-nullaction').value;
      const cs = $('ed-cols'); step.columns = cs ? Array.from(cs.selectedOptions).map(o => o.value) : [];
      step.value = ($('ed-nullvalue') && $('ed-nullvalue').value) || '';
      step.treatEmpty = !!($('ed-treatempty') && $('ed-treatempty').checked);
    } else if (type === 'window') {
      step.op = $('ed-winop').value;
      step.out = ($('ed-winout') && $('ed-winout').value.trim()) || '';
      const pt = $('ed-winpart'); step.partitionBy = pt ? Array.from(pt.selectedOptions).map(o => o.value) : [];
      const ob = $('ed-winorder'); step.orderBy = ob ? Array.from(ob.selectedOptions).map(o => o.value) : [];
      step.order = $('ed-winordir').value;
      step.column = $('ed-wincol') ? $('ed-wincol').value : '';
    } else if (type === 'sort') {
      const sb = $('ed-sortby');
      step.by = sb ? Array.from(sb.selectedOptions).map(o => o.value) : [];
      step.order = $('ed-sortorder').value;
    } else if (type === 'python') {
      step.mode = 'restricted';
      try { step.operations = JSON.parse(($('ed-pyops') && $('ed-pyops').value) || '[]'); }
      catch (e) { throw new Error('عمليات Python JSON غير صالحة: ' + e.message); }
      if (!Array.isArray(step.operations)) throw new Error('عمليات Python يجب أن تكون مصفوفة');
    }
    if (step.rightPrefix === undefined) delete step.rightPrefix;
    return step;
  }
  function showEditorErr(msg) {
    const el = $('wf-editor-err'); if (!el) return;
    if (msg) { el.hidden = false; el.textContent = msg; } else { el.hidden = true; el.textContent = ''; }
  }
  function applyEditor() {
    showEditorErr('');
    let step;
    try { step = collectStep(); } catch (e) { showEditorErr(e.message); return; }
    if (!step.id) { showEditorErr('المعرّف مطلوب'); return; }
    if (step.type === 'select' && (!step.columns || !step.columns.length)) { showEditorErr('اختر عمودًا واحدًا على الأقل'); return; }
    if (step.type === 'filter' && !step.column) { showEditorErr('اختر عمودًا للتصفية'); return; }
    if (step.type === 'compute' && (!step.newColumn || !step.formula)) { showEditorErr('اسم العمود والمعادلة مطلوبان'); return; }
    if (step.type === 'groupBy' && (!step.keys || !step.keys.length || !step.aggs || !step.aggs.length)) { showEditorErr('مفاتيح وتجميعات مطلوبة'); return; }
    if (step.type === 'pivot' && (!step.rowKeys.length || !step.columnKeys.length || !step.values.length)) { showEditorErr('الجدول المحوري يحتاج مفاتيح صفوف وأعمدة وقيمة تجميعية واحدة على الأقل'); return; }
    if (step.type === 'unpivot' && !step.valueColumns.length) { showEditorErr('اختر عمود قيمة واحدًا على الأقل لإلغاء المحورية'); return; }
    if (step.type === 'unpivot' && step.keyName === step.valueName) { showEditorErr('اسم المفتاح واسم القيمة يجب أن يختلفا'); return; }
    if (step.type === 'join' && (!step.leftKey || !step.rightKey || (!step.rightSource && !Array.isArray(step.rightRows)))) { showEditorErr('مفتاحان مطلوبان + مصدر ربط مسجَّل أو بيانات طرف أيمن'); return; }
    if (step.type === 'union' && (!step.rightSource && !Array.isArray(step.rightRows))) { showEditorErr('اختر مصدرًا ثانيًا أو صفوفًا حرفية للاتحاد'); return; }
    if (step.type === 'compare' && (!step.leftKeys.length || !step.rightKeys.length || step.leftKeys.length !== step.rightKeys.length)) { showEditorErr('مفاتيح المقارنة مطلوبة ومتساوية العدد'); return; }
    if (step.type === 'compare' && (!step.rightSource && !Array.isArray(step.rightRows))) { showEditorErr('اختر مصدرًا ثانيًا أو صفوفًا حرفية للمقارنة'); return; }
    if (step.type === 'nulls' && step.action === 'fill' && !step.columns.length) { showEditorErr('اختر عمودًا واحدًا على الأقل للملء'); return; }
    if (step.type === 'window' && !step.out) { showEditorErr('اسم عمود النافذة مطلوب'); return; }
    if (step.type === 'window' && step.op === 'runningTotal' && !step.column) { showEditorErr('اختر عمود المجموع التراكمي'); return; }
    if (step.type === 'sort' && (!step.by || !step.by.length)) { showEditorErr('اختر عمودًا واحدًا على الأقل للترتيب'); return; }
    if (step.type === 'python' && (!step.operations || !step.operations.length)) { showEditorErr('أضف عملية Python مقيّدة واحدة على الأقل'); return; }
    if (editingIndex === null) steps.push(step); else steps[editingIndex] = step;
    closeEditor(); renderSteps(); wfSyncCanvasFromSteps(true);
  }

  /* ---------- sync ---------- */
  function syncJson() {
    const ta = $('wf-steps'); if (ta) ta.value = JSON.stringify(steps, null, 2);
  }
  function applyJson() {
    const ta = $('wf-steps'); if (!ta) return;
    let parsed;
    try { parsed = JSON.parse(ta.value || '[]'); } catch (e) { toast('JSON غير صالح: ' + e.message); return; }
    if (!Array.isArray(parsed)) { toast('يجب أن تكون الخطوات مصفوفة'); return; }
    steps = parsed; renderSteps(); wfSyncCanvasFromSteps(true); toast('تم تطبيق JSON');
  }

  /* ---------- save/load ---------- */
  async function wfLoadList() {
    try {
      const d = await apiCall('/api/workflows');
      const sel = $('wf-list'); if (!sel) return;
      const cur = sel.value;
      sel.innerHTML = '<option value="">— اختر مسارًا —</option>';
      (d.items || []).forEach(it => {
        const o = document.createElement('option'); o.value = it.id; o.textContent = (it.name || it.id) + ' (' + it.id + ')'; sel.appendChild(o);
      });
      if (cur) sel.value = cur;
    } catch (e) { toast(e.message); }
  }
  async function wfLoadSelected() {
    const id = $('wf-list').value; if (!id) { toast('اختر مسارًا'); return; }
    await wfLoadById(id);
  }
  /** تحميل تحليل محفوظ بمعرّفه (من المستكشف أو من رابط السياق) */
  async function wfLoadById(id) {
    if (!id) return false;
    try {
      const wf = await apiCall('/api/workflows/get?id=' + encodeURIComponent(id));
      $('wf-name').value = wf.name || '';
      const idEl = $('wf-id'); if (idEl) idEl.value = wf.id || id;
      steps = Array.isArray(wf.steps) ? wf.steps : [];
      const sv = wf.source && wf.source.type === 'dataset' ? ('dataset/' + wf.source.name)
        : (wf.source && wf.source.type === 'output' ? ('output/' + wf.source.name)
          : (wf.source && wf.source.type === 'file' ? ('file/' + wf.source.name)
            : (wf.source && wf.source.type === 'workbook' ? ('workbook/' + wf.source.name)
              : (wf.source ? (wf.source.name || 'synthetic') : 'synthetic'))));
      if (window.WorkflowHost && typeof window.WorkflowHost.setSourceValue === 'function') window.WorkflowHost.setSourceValue(sv);
      else if ($('wf-source')) $('wf-source').value = sv;
      await loadSourceFields();
      renderSteps();
      if (window.WorkflowCanvas && typeof window.WorkflowCanvas.loadWorkflow === 'function') {
        window.WorkflowCanvas.loadWorkflow(wf);
      }
      if (window.Workspace) window.Workspace.setContext({ workflowId: wf.id || id, workflowName: wf.name || '' });
      toast('تم التحميل: ' + (wf.name || id));
      return true;
    } catch (e) { toast(e.message); return false; }
  }
  async function wfSave(asNew) {
    const name = ($('wf-name').value || 'untitled').trim();
    const idEl = $('wf-id');
    const id = asNew ? undefined : (idEl && idEl.value.trim()) || undefined;
    const wf = wfWithGraph({ name, source: wfSource(), steps: steps.slice() });
    if (id) wf.id = id;
    try {
      const r = await apiCall('/api/workflows/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow: wf }) });
      toast(asNew ? ('تم الحفظ باسم: ' + r.id) : ('تم الحفظ: ' + r.id));
      if (idEl) idEl.value = r.id;
      if (window.WorkflowCanvas && typeof window.WorkflowCanvas.markSaved === 'function') window.WorkflowCanvas.markSaved();
      await wfLoadList();
      const sel = $('wf-list'); if (sel) sel.value = r.id;
    } catch (e) { toast(e.message); }
  }
  async function wfValidate() {
    const wf = wfWithGraph({ name: $('wf-name').value || 'untitled', source: wfSource(), steps: steps.slice() });
    try {
      const r = await apiCall('/api/workflows/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow: wf }) });
      $('wf-status').textContent = r.ok ? '✅ التحقق ناجح' : '❌ ' + (r.errors || []).map(e => (e.step || '') + ': ' + (e.errors || []).join(', ')).join(' | ');
    } catch (e) { $('wf-status').textContent = '❌ ' + e.message; }
  }
  async function wfPreviewStep(i) {
    const step = steps[i]; if (!step) return;
    const wf = wfWithGraph({ name: $('wf-name').value || 'untitled', source: wfSource(), steps: steps.slice() });
    try {
      const r = await apiCall('/api/workflows/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow: wf, limit: 20, until: step.id || step.type }) });
      const host = $('wf-result'); if (host) {
        const label = '<div class="hint">معاينة حتى الخطوة: ' + esc(step.id || step.type) + ' (' + esc(step.type) + ')</div>';
        host.innerHTML = label + renderResultHtml(r);
      }
    } catch (e) { renderResult({ ok: false, error: e.message }); }
  }
  function renderResultHtml(d) {
    if (!d || !d.ok) return '<div class="neg">' + esc(d && d.error ? d.error : 'فشل') + '</div>';
    let html = '<div class="hint">صفوف: ' + (d.rowCount || (d.rows ? d.rows.length : 0)) + (d.preview ? ' (معاينة)' : '') + '</div>';
    if (d.runId) html += '<div class="hint">معرّف التشغيل: <b>' + esc(d.runId) + '</b> <button class="btn xs" id="wf-send-to-report">استخدمه في استوديو التقارير</button></div>';
    if (d.sourceNotes && d.sourceNotes.length) html += '<div class="hint">⚠ ' + d.sourceNotes.map(esc).join(' · ') + '</div>';
    if (d.formulaColumns && Object.keys(d.formulaColumns).length) {
      const items = Object.keys(d.formulaColumns).map(fid => {
        const v = d.formulaColumns[fid];
        const name = (v && typeof v === 'object') ? (v.column || v.name || '') : String(v || '');
        return esc(fid) + (name ? ' → ' + esc(name) : '');
      });
      html += '<div class="hint">المعادلات المطبَّقة في هذا التشغيل: ' + items.join(' · ') + '</div>';
    }
    if (d.rows && d.rows.length) {
      const cols = d.columns || Object.keys(d.rows[0]);
      html += '<table><thead><tr>' + cols.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>';
      d.rows.forEach(r => { html += '<tr>' + cols.map(c => '<td>' + esc(r[c]) + '</td>').join('') + '</tr>'; });
      html += '</tbody></table>';
    }
    if (d.steps && d.steps.length) {
      html += '<h4>سجل الخطوات</h4><table><thead><tr><th>الخطوة</th><th>النوع</th><th>الحالة</th><th>صفوف</th><th>الاكتمال</th><th>رسالة</th></tr></thead><tbody>';
      d.steps.forEach(s => {
        const comp = s.completeness || '';
        const compTag = !comp ? '—' : (comp === 'complete' ? 'مكتمل' : (comp === 'possibly-truncated' ? 'تحذير احتمال الاقتطاع' : 'غير مكتمل — لا يُعتمد على مجاميعه'));
        html += '<tr><td>' + esc(s.id) + '</td><td>' + esc(s.type) + '</td><td>' + esc(s.status) + '</td><td>' + esc(s.rowCount)
          + '</td><td>' + esc(compTag) + '</td><td>' + esc(s.message) + (s.warnings && s.warnings.length ? ' · ' + esc(s.warnings.join(', ')) : '') + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    return html;
  }
  async function wfExportCsv() {
    if (lastRunId) { window.open('/api/workflows/output/csv?id=' + encodeURIComponent(lastRunId), '_blank'); return; }
    toast('يجب أن تحتوي على components مصفوفة');
  }
  async function wfRetrieve() {
    const id = ($('wf-runid') && $('wf-runid').value.trim()) || '';
    if (!id) { toast('أدخل معرّف تشغيل'); return; }
    try {
      const d = await apiCall('/api/workflows/output?id=' + encodeURIComponent(id));
      const host = $('wf-result'); if (host) {
        let html = '<div class="hint">تشغيل: ' + esc(d.runId || id) + ' — صفوف: ' + (d.rowCount || (d.rows ? d.rows.length : 0)) + ' — حفظ: ' + esc(d.savedAt || '') + '</div>';
        if (d.rows && d.rows.length) {
          const cols = d.columns || Object.keys(d.rows[0]);
          html += '<table><thead><tr>' + cols.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>';
          d.rows.forEach(r => { html += '<tr>' + cols.map(c => '<td>' + esc(r[c]) + '</td>').join('') + '</tr>'; });
          html += '</tbody></table>';
        } else { html += '<div class="hint">لا نتائج</div>'; }
        host.innerHTML = html;
      }
      lastRunId = d.runId || id;
    } catch (e) { toast(e.message); }
  }
  function renderResult(d) {
    const host = $('wf-result'); if (!host) return;
    if (!d || !d.ok) { host.innerHTML = '<div class="neg">' + esc(d && d.error ? d.error : 'فشل') + '</div>'; return; }
    let html = renderResultHtml(d);
    /* المصدر الذي أنتج النتيجة + روابط السياق (تحليل · تقرير · شاشة) */
    const srcInfo = d.source || {};
    if (srcInfo.label || srcInfo.name) {
      html += '<div class="hint">مصدر النتيجة: ' + esc(srcInfo.label || srcInfo.name)
        + (srcInfo.grain ? ' · مستوى: ' + esc(srcInfo.grain) : '')
        + ' <button type="button" class="btn xs ghost" id="wf-src-explorer">فتح في المستكشف</button></div>';
    }
    if (d.formulaColumns && Object.keys(d.formulaColumns).length) {
      const items = Object.keys(d.formulaColumns).map(fid => {
        const v = d.formulaColumns[fid];
        const name = (v && typeof v === 'object') ? (v.column || v.name || '') : String(v || '');
        return esc(fid) + (name ? ' → ' + esc(name) : '');
      });
      html += '<div class="hint">المعادلات المطبَّقة: ' + items.join(' · ') + '</div>';
    }
    if (d.runId) {
      html += '<div class="wf-toolbar"><button type="button" class="btn xs ghost" id="wf-to-screen">＋ إدراج النتيجة في شاشة</button></div>';
    }
    host.innerHTML = html;
    const srcBtn = $('wf-src-explorer');
    if (srcBtn) srcBtn.addEventListener('click', () => {
      const sid = (d.source && (d.source.name || d.source.id)) || '';
      if (window.Workspace) window.Workspace.go('analysis', { sourceId: sid, sourceName: (d.source && d.source.label) || sid, runId: d.runId || '' });
    });
    const scrBtn = $('wf-to-screen');
    if (scrBtn) scrBtn.addEventListener('click', async () => {
      if (window.Workspace) window.Workspace.go('screen-studio', { runId: d.runId || '', runLabel: d.workflowName || d.runId || '' });
      if (typeof window.insertRunIntoScreen === 'function') await window.insertRunIntoScreen(d.runId);
    });
    const sendBtn = $('wf-send-to-report');
    if (sendBtn) sendBtn.addEventListener('click', async () => {
      const target = $('rs-runid');
      if (target) target.value = d.runId;
      goTab('report-studio');
      /* جلب أعمدة التشغيل تلقائيًا — بلا إعادة إدخال يدوي (مثل «تقرير سريع») */
      try {
        const loaded = (typeof window.loadReportColumnsForRun === 'function')
          ? await window.loadReportColumnsForRun(d.runId) : false;
        if (!loaded) toast('تعذّر جلب أعمدة التشغيل ' + d.runId + ' — اضغط «جلب الأعمدة» في المصمم');
      } catch (e) {
        toast('تعذّر جلب الأعمدة: ' + e.message);
      }
    });
  }
  async function wfPreview() {
    const wf = wfWithGraph({ name: $('wf-name').value || 'untitled', source: wfSource(), steps: steps.slice() });
    try { const r = await apiCall('/api/workflows/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow: wf, limit: 20 }) }); renderResult(r); }
    catch (e) { renderResult({ ok: false, error: e.message }); }
  }
  async function wfRun() {
    const wf = wfWithGraph({ name: $('wf-name').value || 'untitled', source: wfSource(), steps: steps.slice() });
    try { const r = await apiCall('/api/workflows/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow: wf }) }); lastRunId = r.runId || null; renderResult(r); wfLoadRuns(); }
    catch (e) { renderResult({ ok: false, error: e.message }); }
  }
  async function wfLoadFns() {
    const host = $('wf-fns'); if (!host) return;
    try {
      const d = await apiCall('/api/formulas');
      const items = (d && d.items) ? d.items : [];
      if (!items.length) { host.innerHTML = '<div class="hint">لا توجد وظائف.</div>'; return; }
      fns = items;
      host.innerHTML = items.map(f => {
        const params = (f.params || []).map(p => p.name + ':' + p.type).join(', ');
        return '<div class="wf-fn"><b>' + esc(f.name) + '</b> (' + esc(f.id) + ') — ' + esc(f.description) +
          '<br><span class="muted xs">params: ' + esc(params) + ' → ' + esc(f.returnType) + ' | null: ' + esc(f.nullBehavior) + '</span>' +
          (f.examples && f.examples.length ? '<br><span class="muted xs">مثال: ' + esc(f.examples[0]) + '</span>' : '') + '</div>';
      }).join('');
    } catch (e) { host.innerHTML = '<div class="neg">تعذّر تحميل الوظائف: ' + esc(e.message) + '</div>'; }
  }

  /* ---------- المخرجات المحفوظة (نتائج التشغيل) ---------- */
  async function wfLoadRuns() {
    const sel = $('wf-runs-list'); if (!sel) return;
    const msg = $('wf-runs-msg');
    try {
      const d = await apiCall('/api/workflows/outputs');
      const items = (d && d.items) ? d.items : [];
      if (!items.length) {
        sel.innerHTML = '<option value="">— لا مخرجات محفوظة —</option>';
        if (msg) msg.textContent = 'نفّذ تحليلًا أولًا لتظهر نتيجته هنا.';
        return;
      }
      sel.innerHTML = items.map(r => '<option value="' + esc(r.runId) + '">'
        + esc((r.source && (r.source.label || r.source.name)) || r.workflowName || r.runId)
        + ' · ' + esc(r.runId) + ' (' + (r.rowCount || 0) + ' صف · ' + (r.columns || []).length + ' عمود)'
        + (r.traced ? '' : ' · بلا تتبّع') + '</option>').join('');
      if (msg) msg.textContent = items.length + ' مخرج محفوظ';
      await wfShowRunInfo(sel.value);
    } catch (e) {
      if (msg) msg.textContent = 'تعذّر تحميل المخرجات: ' + e.message;
    }
  }
  async function wfShowRunInfo(runId) {
    const host = $('wf-runs-info'); if (!host || !runId) return;
    try {
      const d = await apiCall('/api/workflows/output?id=' + encodeURIComponent(runId));
      const cols = (d && d.columns) || [];
      const fc = (d && d.formulaColumns) || {};
      let html = '<div class="hint">المخرج: <b>' + esc(d.runId || runId) + '</b> — ' + (d.rowCount || 0) + ' صف · '
        + cols.length + ' عمود · حفظ: ' + esc(d.savedAt || '—')
        + (d.workflowName ? ' · التحليل: ' + esc(d.workflowName) : '') + '</div>';
      if (Object.keys(fc).length) {
        const items = Object.keys(fc).map(fid => {
          const v = fc[fid];
          const nm = (v && typeof v === 'object') ? (v.column || v.name || '') : String(v || '');
          return esc(fid) + (nm ? ' → ' + esc(nm) : '');
        });
        html += '<div class="hint">المعادلات المطبَّقة: ' + items.join(' · ') + '</div>';
      }
      if (d.warnings && d.warnings.length) html += '<div class="hint">⚠ ' + d.warnings.map(esc).join(' · ') + '</div>';
      if (cols.length) {
        html += '<div class="muted xs">الأعمدة: ' + cols.map(esc).join(' · ') + '</div>';
      }
      host.innerHTML = html;
    } catch (e) {
      host.innerHTML = '<div class="neg">' + esc(e.message) + '</div>';
    }
  }
  async function wfOpenRun() {
    const sel = $('wf-runs-list');
    const id = (sel && sel.value) || '';
    if (!id) { toast('اختر مخرجًا محفوظًا'); return; }
    const runid = $('wf-runid'); if (runid) runid.value = id;
    await wfRetrieve();
    if (window.Workspace) window.Workspace.setContext({ runId: id, runLabel: id });
  }
  async function wfRunToReport() {
    const sel = $('wf-runs-list');
    const id = (sel && sel.value) || '';
    if (!id) { toast('اختر مخرجًا محفوظًا'); return; }
    const target = $('rs-runid'); if (target) target.value = id;
    goTab('report-studio');
    try {
      const loaded = (typeof window.loadReportColumnsForRun === 'function') ? await window.loadReportColumnsForRun(id) : false;
      if (!loaded) toast('تعذّر جلب أعمدة التشغيل ' + id);
    } catch (e) { toast('تعذّر جلب الأعمدة: ' + e.message); }
  }

  /* ---------- جسر المحرّر المرئي (Workflow Canvas) ---------- */
  window.WorkflowHost = {
    getSource: wfSource,
    setSourceValue(value) {
      const sel = $('wf-source'); if (!sel) return;
      const v = String(value || 'synthetic');
      let opt = Array.from(sel.options).find(o => o.value === v);
      if (!opt) {
        opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v === 'synthetic' ? 'بيانات تجريبية (synthetic)'
          : (v.indexOf('output/') === 0 ? 'نتيجة سابقة — ' + v.slice(7)
            : (v.indexOf('file/') === 0 ? 'ملف — ' + v.slice(5)
              : (v.indexOf('workbook/') === 0 ? 'Excel — ' + v.slice(9) : v.replace(/^dataset\//, ''))));
        sel.appendChild(opt);
      }
      if (sel.value === v) return;
      sel.value = v;
      loadSourceFields();
    },
    getSteps: () => steps.slice(),
    setSteps(next) {
      steps = Array.isArray(next) ? next.slice() : [];
      renderSteps();
    },
    getMeta() {
      return {
        id: ($('wf-id') && $('wf-id').value.trim()) || '',
        name: ($('wf-name') && $('wf-name').value.trim()) || 'تحليل مرئي',
      };
    },
    refreshRuns: () => wfLoadRuns(),
  };

  document.addEventListener('DOMContentLoaded', () => {
    const btnNew = $('wf-new');
    if (btnNew) btnNew.addEventListener('click', () => {
      $('wf-name').value = 'workflow_' + Date.now();
      const idEl = $('wf-id'); if (idEl) idEl.value = '';
      steps = []; renderSteps();
      if (window.WorkflowCanvas && typeof window.WorkflowCanvas.reset === 'function') window.WorkflowCanvas.reset();
      $('wf-result').innerHTML = ''; $('wf-status').textContent = '';
    });
    $('wf-load')?.addEventListener('click', wfLoadSelected);
    $('wf-save')?.addEventListener('click', () => wfSave(false));
    $('wf-save-as')?.addEventListener('click', () => wfSave(true));
    $('wf-add-step')?.addEventListener('click', () => openEditor(null));
    $('wf-apply-step')?.addEventListener('click', applyEditor);
    $('wf-cancel-step')?.addEventListener('click', closeEditor);
    $('wf-validate')?.addEventListener('click', wfValidate);
    $('wf-preview')?.addEventListener('click', wfPreview);
    $('wf-run')?.addEventListener('click', wfRun);
    $('wf-export')?.addEventListener('click', wfExportCsv);
    $('wf-retrieve')?.addEventListener('click', wfRetrieve);
    $('wf-apply-json')?.addEventListener('click', applyJson);
    $('wf-runs-list')?.addEventListener('change', (e) => wfShowRunInfo(e.target.value));
    $('wf-run-open')?.addEventListener('click', wfOpenRun);
    $('wf-run-report')?.addEventListener('click', wfRunToReport);
    const srcSel = $('wf-source');
    if (srcSel) srcSel.addEventListener('change', () => {
      loadSourceFields(); renderSteps();
      if (window.WorkflowCanvas && typeof window.WorkflowCanvas.setSource === 'function') {
        window.WorkflowCanvas.setSource(srcSel.value);
      }
    });
    wfLoadList(); wfLoadFns(); loadSavedFormulas(); loadSourceList(); loadSourceFields(); renderSteps(); wfLoadRuns();
  });
  window.loadWorkflowTab = function () { wfLoadList(); wfLoadFns(); loadSavedFormulas(); loadSourceList(); loadSourceFields(); renderSteps(); wfLoadRuns(); };
  /* فتح مصدر محدَّد في استوديو التحليل (من المستكشف) — بلا شاشة جديدة */
  window.openWorkflowForSource = async function (sourceId) {    if (!sourceId) return false;
    const sel = $('wf-source');
    if (!sel) return false;
    const wanted = ['dataset/' + sourceId, sourceId];
    const opt = Array.from(sel.options).find(o => wanted.indexOf(o.value) >= 0);
    if (!opt) { toast('المصدر «' + sourceId + '» غير متاح للقراءة بصلاحياتك'); return false; }
    sel.value = opt.value;
    goTab('workflow');
    await loadSourceFields();
    renderSteps();
    toast('المصدر «' + sourceId + '» جاهز في استوديو التحليل — اختر الخطوة ثم «تشغيل»');
    return true;
  };
  /* فتح تحليل محفوظ بمعرّفه (من المستكشف أو رابط السياق) */
  window.openWorkflowById = async function (id) {
    if (!id) return false;
    goTab('workflow');
    const okLoad = await wfLoadById(id);
    if (okLoad) toast('تم فتح التحليل المحفوظ: ' + id);
    return okLoad;
  };
})();

/* ===== Report Studio (Python engine) — نُقل إلى public/report-designer.js (مصمم مرئي) ===== */
/* loadWorkflowTab exposed by the Workflow IIFE below (see window.loadWorkflowTab) */

