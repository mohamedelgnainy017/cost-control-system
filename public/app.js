'use strict';
/* واجهة النظام — تحميل البيانات من API وعرضها */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({ ok: false, error: 'استجابة غير صالحة' }));
  if (!j.ok) {
    if (r.status === 401) {
      if (!opts.quiet401) { me = null; applyRoleUI(); enterLogin(j.message || 'انتهى الجلسة — سجّل الدخول'); }
      throw new Error(j.message || j.error || 'انتهى الجلسة');
    }
    if (r.status === 403 && !opts.quiet403) toast(j.message || 'لا تملك صلاحية تنفيذ هذه العملية');
    const err = new Error(j.message || j.error || 'خطأ');
    err.status = r.status;
    throw err;
  }
  return j.data;
}
const hdr = { 'Content-Type': 'application/json' };
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

const TITLES = {
  dashboard: ['لوحة التحكم', 'إدارة المستخدمين وصلاحيات الشاشات'],
  md: ['البيانات الأساسية', 'الأصناف • المواقع والمصانع • أنواع الحركات'],
  'md-items': ['الأصناف الأساسية', 'كود واسم ووحدة + المجموعات والتصنيفات — جلب تلقائي من الحركات'],
  'md-locations': ['المواقع والمصانع', 'الشركة ← الوحدة ← المخزن + المكان'],
  'md-movetypes': ['أنواع الحركات', 'النوع والوصف + وصف السيستم والتصنيف'],
  inventory: ['المخزون والمطابقة', 'الأرصدة مقابل الحركات — افتتاحي + وارد − صادر = ختامي'],
  sales: ['المبيعات والربحية', 'الإيراد والتكلفة ومجمل الربح حسب المكان والصنف'],
  movements: ['الحركات', 'الوارد والصادر واتجاهات الترحيل'],
  borse: ['البورصة اليومية', 'أسعار الذرة والصويا والبذرة وريت الدولار — تسجيل يومي'],
  prices: ['الأسعار اليومية', 'أربع قيم لكل صنف/يوم: تكلفة وسوق — أرضه ووصال'],
  costs: ['التكلفة اليومية', '3 أصناف بورصة بالمعادلة + قيمة الرصيد ÷ كمية الرصيد للباقي — تفصيلي وإجمالي'],
  quality: ['جودة البيانات', 'فحوص تلقائية لسلامة البيانات قبل الاعتماد'],
  import: ['الاستيراد', 'تحميل ملفات Excel إلى قاعدة البيانات'],
  reports: ['التقارير', 'عرض التقارير داخل المتصفح وتصديرها CSV'],
};

function kpi(host, { label, value, sub, tone, icon = '◈', g = 'g1' }) {
  const d = document.createElement('div');
  d.className = 'card kpi ' + g + (tone ? ' ' + tone : '');
  d.innerHTML =
    `<div class="top"><div class="ico">${icon}</div></div>` +
    `<div class="label">${label}</div>` +
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

/* قسم «البيانات الأساسية»: زر واحد في القايمة الجانبية، وجواه الشاشات الثلاث */
const MD_SUBS = ['md-items', 'md-locations', 'md-movetypes'];
const mdSubsAllowed = () => {
  if (!me || !Array.isArray(me.tabs) || !me.tabs.length) return MD_SUBS;
  return MD_SUBS.filter(t => me.tabs.includes(t));
};
function showMdLanding() {
  const allowed = mdSubsAllowed();
  if (!allowed.length) {
    toast('شاشة البيانات الأساسية غير مسموحة لدورك');
    const alt = me && Array.isArray(me.tabs) && me.tabs[0] && me.tabs[0] !== 'md' ? me.tabs[0] : null;
    if (alt) goTab(alt);
    return;
  }
  $$('section').forEach(s => s.classList.remove('active'));
  $('#tab-md').classList.add('active');
  const t = TITLES.md || ['البيانات الأساسية', ''];
  $('#page-title').textContent = t[0];
  $('#page-crumb').textContent = t[1];
  $('#sidebar').classList.remove('open');
  $$('#tab-md [data-sub]').forEach(btn => vis(btn, allowed.includes(btn.dataset.sub)));
}
/* أزرار الشاشات داخل قسم البيانات الأساسية */
$$('#tab-md [data-sub]').forEach(b => {
  b.addEventListener('click', () => {
    const name = b.dataset.sub;
    if (!mdSubsAllowed().includes(name)) { toast('هذه الشاشة غير مسموحة لدورك'); return; }
    $$('section').forEach(s => s.classList.remove('active'));
    $('#tab-' + name).classList.add('active');
    const t = TITLES[name] || [name, ''];
    $('#page-title').textContent = t[0];
    $('#page-crumb').textContent = t[1];
    $('#sidebar').classList.remove('open');
    loadTab(name).catch(e => toast('خطأ: ' + e.message));
  });
});
/* زر «‹ رجوع» داخل الشاشات الثلاث يعيدك لصفحة قسم البيانات الأساسية */
$$('[data-back="md"]').forEach(b => {
  b.addEventListener('click', () => {
    const nb = document.querySelector('nav button[data-tab="md"]');
    if (nb) nb.click();
  });
});

$$('nav button').forEach(b => {
  b.addEventListener('click', () => {
    $$('nav button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    current = b.dataset.tab;
    if (current === 'md') { showMdLanding(); return; }
    $$('section').forEach(s => s.classList.remove('active'));
    $('#tab-' + current).classList.add('active');
    const t = TITLES[current] || ['', ''];
    $('#page-title').textContent = t[0];
    $('#page-crumb').textContent = t[1];
    $('#sidebar').classList.remove('open');
    loadTab(current).catch(e => toast('خطأ: ' + e.message));
  });
});

async function loadTab(name) {
  /* حماية الشاشات: الشاشة غير المسموحة لدورك لا تُحمَّل */
  if (me && Array.isArray(me.tabs) && me.tabs.length && !me.tabs.includes(name)) {
    const alt = me.tabs[0];
    toast('شاشة «' + (TITLES[name] || ['', name])[0] + '» غير مسموحة لدورك');
    if (alt && alt !== name) return goTab(alt);
    return;
  }
  if (name === 'dashboard') return loadDashboard();
  if (name === 'md-items') return loadMdItems();
  if (name === 'md-locations') return loadMdLocations();
  if (name === 'md-movetypes') return loadMdMtypes();
  if (name === 'inventory') return loadInventory();
  if (name === 'sales') return loadSales();
  if (name === 'movements') return loadMovements();
  if (name === 'borse') return loadBorse();
  if (name === 'prices') return loadPrices();
  if (name === 'costs') return loadCosts();
  if (name === 'quality') return loadQuality();
  if (name === 'import') { loadImports(); loadToday(); return; }
  if (name === 'reports') return loadReports();
}

/* ---------------- لوحة التحكم — إدارة المستخدمين والصلاحيات فقط ---------------- */
async function loadDashboard() {
  const isAdmin = !!me && me.role === 'admin';
  const canUsers = can('users');
  vis($('#card-tabperms'), isAdmin);
  vis($('#card-users'), canUsers);
  vis($('#dash-hint'), !isAdmin && !canUsers);  // دور مُصرَّح له بالدخول بلا إدارة

  if (canUsers) await initUsersForm();
  const jobs = [];
  if (isAdmin) jobs.push(loadTabPerms().catch(e => toast(e.message)));
  if (canUsers) jobs.push(renderUsers().catch(() => {}));
  await Promise.all(jobs);
}

/* ---- صلاحيات الشاشات: جدول (شاشة × أدوار) للمدير ---- */
async function loadTabPerms() {
  const d = await api('/api/tabs');
  const acc = new Set(d.perms.accountant || []);
  const view = new Set(d.perms.viewer || []);
  table($('#tbl-tabperms'), [
    { t: 'الشاشة', h: true, f: r => `<b>${escHtml(r.label)}</b>` },
    { t: 'مدير', h: true, f: () => '<span class="pill info">✓ دائماً</span>' },
    { t: 'محاسب', h: true, f: r => `<input type="checkbox" data-role="accountant" data-tab="${r.id}" ${acc.has(r.id) ? 'checked' : ''}>` },
    { t: 'مشاهد', h: true, f: r => `<input type="checkbox" data-role="viewer" data-tab="${r.id}" ${view.has(r.id) ? 'checked' : ''}>` },
  ], d.tabs, { empty: '—' });
}
$('#btn-tabperms-save')?.addEventListener('click', async () => {
  const btn = $('#btn-tabperms-save');
  const perms = { accountant: [], viewer: [] };
  $$('#tbl-tabperms input[data-role]').forEach(cb => { if (cb.checked) perms[cb.dataset.role].push(cb.dataset.tab); });
  btn.disabled = true;
  try {
    await api('/api/tabs/save', { method: 'POST', headers: hdr, body: JSON.stringify({ perms }) });
    toast('تم حفظ صلاحيات الشاشات ✔ — تُطبَّق على المستخدمين عند إعادة تحميل شاشاتهم');
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

const mdOpen = id => { const el = $('#' + id); if (el) { el.hidden = false; el.querySelector('input,select')?.focus(); } };
const mdErr = (id, msg) => { const el = $('#' + id); if (el) { el.hidden = !msg; if (msg) el.textContent = msg; } };

/* ---------------- شاشة الأصناف ---------------- */
async function loadMdItems() {
  const canM = can('master');
  vis($('#md-sync'), canM);
  vis($('#md-item-btn'), canM);
  vis($('#md-group-btn'), canM);
  vis($('#md-class-btn'), canM);
  const [g, c] = await Promise.all([
    api('/api/md/items/groups').catch(() => []),
    api('/api/md/items/classes').catch(() => []),
  ]);
  mdGroupsList = g; mdClassesList = c;
  fillMdSelects();
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
  const q = ($('#md-items-q')?.value || '').trim();
  const d = await api(`/api/md/items?origin=${mdItemsOrigin}&q=${encodeURIComponent(q)}&limit=1000`);
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
    ...(canM ? [{ t: '', h: true, f: r => `<button class="btn sm ghost" data-item="${escHtml(r.code)}">✎ تعديل</button>` }] : []),
  ], d, { empty: 'لا توجد أصناف — استورد ملف الحركات ثم اضغط «جلب من الحركات»' });
}

/* فلترة: الكل / مسجّلي / المجلوبة من الحركات */
$$('#md-items-segs .seg').forEach(b => b.addEventListener('click', () => {
  $$('#md-items-segs .seg').forEach(x => x.classList.toggle('on', x === b));
  mdItemsOrigin = b.dataset.origin;
  renderMdItems().catch(e => toast(e.message));
}));

let mdItemsTimer = null;
$('#md-items-q')?.addEventListener('input', () => {
  clearTimeout(mdItemsTimer);
  mdItemsTimer = setTimeout(() => renderMdItems().catch(() => {}), 300);
});

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
  const r = code ? mdItemsRows.find(x => x.code === code) : null;
  f.dataset.edit = r ? r.code : '';
  $('#md-item-title').textContent = r ? 'تعديل صنف' : 'إضافة صنف';
  $('#mi-code').value = r ? r.code : '';
  $('#mi-descr').value = r ? (r.descr || '') : '';
  $('#mi-uom').value = r ? (r.uom || '') : '';
  $('#mi-group').value = r ? (r.group_code || '') : '';
  $('#mi-class').value = r ? (r.class_code || '') : '';
  mdErr('mi-err', null);
  updMiCount();
  mdOpen('md-item-modal');
}
$('#md-item-btn')?.addEventListener('click', () => openMdItem(null));

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
  const r = code ? mdGroupsList.find(x => x.code === code) : null;
  f.dataset.edit = r ? r.code : '';
  $('#md-group-title').textContent = r ? 'تعديل مجموعة' : 'إضافة مجموعة';
  $('#mg-code').value = r ? r.code : '';
  $('#mg-descr').value = r ? (r.descr || '') : '';
  mdErr('mg-err', null);
  mdOpen('md-group-modal');
}
$('#md-group-btn')?.addEventListener('click', () => openMdGroup(null));
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
  const r = code ? mdClassesList.find(x => x.code === code) : null;
  f.dataset.edit = r ? r.code : '';
  $('#md-class-title').textContent = r ? 'تعديل تصنيف' : 'إضافة تصنيف';
  $('#mc-code').value = r ? r.code : '';
  $('#mc-descr').value = r ? (r.descr || '') : '';
  mdErr('mc-err', null);
  mdOpen('md-class-modal');
}
$('#md-class-btn')?.addEventListener('click', () => openMdClass(null));
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

/* --- جلب الأصناف من الحركات يدوياً --- */
$('#md-sync')?.addEventListener('click', async () => {
  const b = $('#md-sync');
  b.disabled = true; b.textContent = '… جارٍ الجلب';
  try {
    const r = await api('/api/md/items/sync', { method: 'POST', headers: hdr, body: JSON.stringify({}) });
    toast(`تم الجلب: ${n0(r.inserted)} صنف جديد • ${n0(r.settled)} صنف تسكينة • ${n0(r.locations)} موقع جديد • ${n0(r.warehouses)} مخزن جديد`);
    await renderMdItems();
  } catch (e) { toast('خطأ: ' + e.message); }
  finally { b.disabled = false; b.textContent = '↻ جلب من الحركات'; }
});

/* ---------------- شاشة المواقع والمصانع ---------------- */
async function loadMdLocations() {
  const canM = can('master');
  vis($('#md-comp-btn'), canM);
  vis($('#md-unit-btn'), canM);
  vis($('#md-wh-btn'), canM);
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
  ], mdLoc.companies, { empty: 'لا توجد شركات — اضغط «＋ شركة»' });

  table($('#tbl-md-units'), [
    { t: 'كود الوحدة', k: 'code' },
    { t: 'اسم الوحدة', k: 'name' },
    { t: 'الشركة', h: true, f: r => escHtml(r.company_name || r.company_code || '') },
    { t: 'العملة', k: 'currency' },
    { t: 'المكان', k: 'place' },
    ...(can('master') ? [{ t: '', h: true, f: r => mdAct('unit', r.code) }] : []),
  ], mdLoc.units, { empty: 'لا توجد وحدات — اضغط «＋ وحدة»' });

  table($('#tbl-md-warehouses'), [
    { t: 'كود المخزن', k: 'code' },
    { t: 'اسم المخزن', k: 'name' },
    { t: 'الوحدة', h: true, f: r => escHtml(r.unit_code || '') },
    { t: 'الشركة', h: true, f: r => escHtml(r.company_code || '') },
    { t: 'المكان', k: 'place' },
    ...(can('master') ? [{ t: '', h: true, f: r => mdAct('wh', r.code) }] : []),
  ], mdLoc.warehouses, { empty: 'لا توجد مخازن — اضغط «＋ مخزن» (أو ارفع البيانات دفعة واحدة لاحقاً)' });
}

$$('#md-loc-segs .seg').forEach(b => b.addEventListener('click', () => { mdLocPane = b.dataset.pane; renderMdLocPane(); }));

['#tbl-md-companies', '#tbl-md-units', '#tbl-md-warehouses'].forEach(sel =>
  $(sel)?.addEventListener('click', e => {
    const b = e.target.closest('[data-loc]');
    if (b && can('master')) openMdLoc(b.dataset.loc, b.dataset.code);
  }));

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
  mdErr('mw-err', null);
  mdOpen('md-wh-modal');
}
$('#md-comp-btn')?.addEventListener('click', () => openMdLoc('company', null));
$('#md-unit-btn')?.addEventListener('click', () => openMdLoc('unit', null));
$('#md-wh-btn')?.addEventListener('click', () => openMdLoc('wh', null));

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
      unit: $('#mw-unit').value, place: $('#mw-place').value.trim(), editCode: editing }) });
    $('#md-wh-modal').hidden = true;
    f.dataset.edit = '';
    toast(editing ? 'تم تعديل المخزن ✔' : 'تمت إضافة المخزن ✔');
    await loadMdLocations();
  } catch (err) { mdErr('mw-err', err.message); }
});

/* ---------------- شاشة أنواع الحركات ---------------- */
async function loadMdMtypes() {
  vis($('#md-mtype-btn'), can('master'));
  await renderMdMtypes();
}

async function renderMdMtypes() {
  const q = ($('#md-mtype-q')?.value || '').trim();
  mdMtypes = await api('/api/md/mtypes?q=' + encodeURIComponent(q));
  const canM = can('master');
  table($('#tbl-md-mtypes'), [
    { t: 'نوع الحركة', k: 'code' },
    { t: 'وصف الحركة', k: 'descr' },
    { t: 'وصف السيستم', k: 'system_desc' },
    { t: 'التصنيف', k: 'category' },
    ...(canM ? [{ t: '', h: true, f: r => `<button class="btn sm ghost" data-mtype="${escHtml(r.code)}">✎ تعديل</button>` }] : []),
  ], mdMtypes, { empty: 'لا توجد أنواع حركات — استورد ملف الحركات أو أضفها يدوياً' });
}

$('#tbl-md-mtypes')?.addEventListener('click', e => {
  const b = e.target.closest('[data-mtype]');
  if (b && can('master')) openMdMtype(b.dataset.mtype);
});
let mdMtypeTimer = null;
$('#md-mtype-q')?.addEventListener('input', () => {
  clearTimeout(mdMtypeTimer);
  mdMtypeTimer = setTimeout(() => renderMdMtypes().catch(() => {}), 300);
});

function openMdMtype(code) {
  const r = code ? mdMtypes.find(x => x.code === code) : null;
  const f = $('#md-mtype-form');
  f.dataset.edit = r ? r.code : '';
  $('#md-mtype-title').textContent = r ? 'تعديل نوع حركة' : 'إضافة نوع حركة';
  $('#mt-code').value = r ? r.code : '';
  $('#mt-descr').value = r ? (r.descr || '') : '';
  $('#mt-sys').value = r ? (r.system_desc || '') : '';
  $('#mt-cat').value = r ? (r.category || '') : '';
  mdErr('mt-err', null);
  mdOpen('md-mtype-modal');
}
$('#md-mtype-btn')?.addEventListener('click', () => openMdMtype(null));
$('#md-mtype-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const editing = f.dataset.edit || '';
  mdErr('mt-err', null);
  try {
    await api('/api/md/mtypes/save', { method: 'POST', headers: hdr, body: JSON.stringify({
      code: $('#mt-code').value.trim(), descr: $('#mt-descr').value.trim(),
      systemDesc: $('#mt-sys').value.trim(), category: $('#mt-cat').value.trim(), editCode: editing }) });
    $('#md-mtype-modal').hidden = true;
    f.dataset.edit = '';
    toast(editing ? 'تم تعديل نوع الحركة ✔' : 'تمت إضافة نوع الحركة ✔');
    await renderMdMtypes();
  } catch (err) { mdErr('mt-err', err.message); }
});

/* ---------------- المخزون ---------------- */
async function loadInventory() {
  const [ov, rec, ip, ic] = await Promise.all([
    api('/api/overview'), api('/api/reconcile?limit=100'), api('/api/inventory/place'), api('/api/inventory/class'),
  ]);
  const k = $('#inv-kpis'); k.innerHTML = '';
  kpi(k, { icon: '◐', g: 'g1', label: 'رصيد افتتاحي', value: money(ov.inventory.openVal), sub: n2(ov.inventory.openQty) + ' وحدة' });
  kpi(k, { icon: '⇄', g: 'g4', label: 'إجمالي الحركات', value: money(ov.movements.amount), sub: n0(ov.movements.lines) + ' حركة' });
  kpi(k, { icon: '◑', g: 'g3', label: 'رصيد ختامي', value: money(ov.inventory.closeVal), sub: n2(ov.inventory.closeQty) + ' وحدة' });
  kpi(k, { icon: '⚖', g: 'g2', label: 'فرق المطابقة', value: money(rec.totalDiff), sub: `${rec.mismatches} من ${rec.keys} مفتاح`, tone: Math.abs(rec.totalDiff) < 1 ? 'good' : 'bad' });
  kpi(k, { icon: '✔', g: 'g3', label: 'مفاتيح مطابقة تماماً', value: pct(rec.keys ? (rec.matched / rec.keys) * 100 : 0), sub: n0(rec.matched) + ' مفتاح' });
  kpi(k, { icon: '◇', g: 'g1', label: 'أصناف', value: n0(ov.counts.items), sub: n0(ov.counts.balances) + ' سجل رصيد' });

  renderRecon(rec);
  table($('#tbl-inv-place'), [
    { t: 'المكان', k: 'place' },
    { t: 'افتتاحي (قيمة)', k: 'open_val', n: 1, f: r => money(r.open_val) },
    { t: 'ختامي (قيمة)', k: 'close_val', n: 1, f: r => money(r.close_val) },
    { t: 'التغير', k: 'change', n: 1, f: r => money(r.close_val - r.open_val), cls: r => dv(r.close_val - r.open_val) },
    { t: 'كمية ختامية', k: 'close_qty', n: 1, f: r => n2(r.close_qty) },
  ], ip);

  table($('#tbl-inv-class'), [
    { t: 'التصنيف', k: 'cls' },
    { t: 'قيمة الختامي', k: 'close_val', n: 1, f: r => money(r.close_val) },
    { t: 'الكمية', k: 'close_qty', n: 1, f: r => n2(r.close_qty) },
    { t: 'النسبة', k: 'p', n: 1, f: r => pct(r.p) },
  ], (() => {
    const tot = ic.reduce((s, r) => s + (r.close_val || 0), 0) || 1;
    return ic.map(r => ({ ...r, p: (r.close_val / tot) * 100 }));
  })());
}

function renderRecon(rec) {
  const pctOk = rec.keys ? (rec.matched / rec.keys) * 100 : 0;
  $('#recon-sum').innerHTML = rec.keys
    ? `تمت مقارنة <b>${n0(rec.keys)}</b> زوج تواريخ لكل مفتاح (صنف + شركة + وحدة + موقع): ` +
      `رصيد <b>نهاية</b> التاريخ السابق مع <b>بداية</b> التاريخ اللاحق. ` +
      `مطابقة تماماً: <b class="${pctOk > 95 ? 'pos' : 'neg'}">${pct(pctOk)}</b> ` +
      `— غير مطابق: <b class="${rec.mismatches ? 'neg' : 'pos'}">${n0(rec.mismatches)}</b>، ` +
      `إجمالي فرق القيمة: <b class="${Math.abs(rec.totalDiff) < 1 ? 'pos' : 'neg'}">${money(rec.totalDiff)}</b> ج.م`
    : `لا توجد أرصدة لتاريخين مختلفين للمقارنة بعد — تحتاج بيانات أرصدة ليومين على الأقل.`;
  $('#recon-count').textContent = `(${n0(rec.sample.length)} صف معروض)`;
  table($('#tbl-recon'), [
    { t: 'الصنف', k: 'item', title: r => r.item_desc },
    { t: 'الوصف', k: 'item_desc' },
    { t: 'الموقع', k: 'storage_loc' },
    { t: 'المكان', k: 'place' },
    { t: 'نهاية سابق', k: 'prev_date' },
    { t: 'بداية لاحق', k: 'next_date' },
    { t: 'ختامي سابق', k: 'close_val', n: 1, f: r => money(r.close_val) },
    { t: 'افتتاحي لاحق', k: 'open_val', n: 1, f: r => money(r.open_val) },
    { t: 'فرق القيمة', k: 'diff_val', n: 1, f: r => money(r.diff_val), cls: r => Math.abs(r.diff_val) > 1 ? 'neg' : 'pos' },
    { t: 'فرق الكمية', k: 'diff_qty', n: 1, f: r => n2(r.diff_qty), cls: r => Math.abs(r.diff_qty) > 0.001 ? 'neg' : 'pos' },
  ], rec.sample, { empty: rec.keys ? 'كل الأزواج مطابقة ✔' : 'لا يوجد تاريخان متتاليان في الأرصدة بعد' });
}

$('#btn-recon')?.addEventListener('click', async () => {
  try {
    const rec = await api('/api/reconcile?limit=200' + ($('#recon-all').checked ? '&all=1' : ''));
    renderRecon(rec); toast('تم احتساب المطابقة');
  } catch (e) { toast('خطأ: ' + e.message); }
});

/* ---------------- المبيعات ---------------- */
async function loadSales() {
  const [ov, sp, sm, si, sc, scls] = await Promise.all([
    api('/api/overview'), api('/api/sales/place'), api('/api/sales/month'),
    api('/api/sales/item?limit=30'), api('/api/sales/customer?limit=30'), api('/api/sales/class'),
  ]);
  const k = $('#sal-kpis'); k.innerHTML = '';
  const cust = await api('/api/sales/customer?limit=500');
  kpi(k, { icon: '◈', g: 'g1', label: 'قيمة المبيعات الموقّعة', value: money(ov.revenue), sub: pct(ov.marginPct) + ' هامش تقديري' });
  kpi(k, { icon: '▤', g: 'g4', label: 'تكلفة المبيعات', value: money(ov.cogs) });
  kpi(k, { icon: '▲', g: 'g3', label: 'مجمل الربح', value: money(ov.grossProfit), tone: ov.grossProfit >= 0 ? 'good' : 'bad' });
  kpi(k, { icon: '⌗', g: 'g2', label: 'مستندات الفواتير', value: n0(ov.revenueDocs), sub: n0(ov.counts.sales) + ' بند' });
  kpi(k, { icon: '☺', g: 'g1', label: 'عدد العملاء', value: n0(cust.length) });
  kpi(k, { icon: '%', g: 'g3', label: 'أعلى هامش مكان', value: pct(Math.max(...sp.map(p => p.marginPct || 0))) });

  table($('#tbl-sales-place'), [
    { t: 'المكان', k: 'place' },
    { t: 'قيمة البيع', k: 'value', n: 1, f: r => money(r.value) },
    { t: 'التكلفة', k: 'cost', n: 1, f: r => money(r.cost) },
    { t: 'مجمل الربح', k: 'profit', n: 1, f: r => money(r.profit), cls: r => dv(r.profit) },
    { t: 'الهامش %', k: 'marginPct', n: 1, f: r => pct(r.marginPct), cls: r => r.marginPct < 0 ? 'neg' : 'pos' },
    { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
    { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
  ], sp);

  lineChart($('#ch-sales-month'), [
    { name: 'قيمة البيع', color: '#5b8cff', points: sm.map(r => ({ x: r.ym, y: r.value })) },
    { name: 'الكمية', color: '#34d399', points: sm.map(r => ({ x: r.ym, y: r.qty })) },
  ]);

  table($('#tbl-sales-item'), [
    { t: 'الصنف', k: 'item' }, { t: 'الوصف', k: 'descr' },
    { t: 'قيمة البيع', k: 'value', n: 1, f: r => money(r.value) },
    { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
  ], si);

  table($('#tbl-sales-cust'), [
    { t: 'العميل/المستفيد', k: 'customer' },
    { t: 'القيمة', k: 'value', n: 1, f: r => money(r.value) },
    { t: 'الضريبة', k: 'tax', n: 1, f: r => money(r.tax) },
    { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
  ], sc);

  table($('#tbl-sales-class'), [
    { t: 'الفئة+الحالة', k: 'combo' },
    { t: 'القيمة الموقّعة', k: 'value', n: 1, f: r => money(r.value), cls: r => dv(r.value) },
    { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
    { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
  ], scls);
}

/* ---------------- الحركات ---------------- */
async function loadMovements() {
  const [md, mm, mp, mi] = await Promise.all([
    api('/api/movements/direction'), api('/api/movements/month'),
    api('/api/movements/place'), api('/api/movements/items?limit=30'),
  ]);
  table($('#tbl-mv-dir'), [
    { t: 'التوجيه', k: 'direction' },
    { t: 'وارد (قيمة)', k: 'inbound', n: 1, f: r => money(r.inbound) },
    { t: 'صادر (قيمة)', k: 'outbound', n: 1, f: r => money(r.outbound) },
    { t: 'الصافي', k: 'amount', n: 1, f: r => money(r.amount), cls: r => dv(r.amount) },
    { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
    { t: 'عدد', k: 'lines', n: 1, f: r => n0(r.lines) },
  ], md);

  lineChart($('#ch-mv-month'), [
    { name: 'وارد', color: '#34d399', points: mm.map(r => ({ x: r.ym, y: r.inbound })) },
    { name: 'صادر', color: '#fb7185', points: mm.map(r => ({ x: r.ym, y: r.outbound })) },
  ]);

  table($('#tbl-mv-place'), [
    { t: 'المكان', k: 'place' },
    { t: 'وارد', k: 'inbound', n: 1, f: r => money(r.inbound) },
    { t: 'صادر', k: 'outbound', n: 1, f: r => money(r.outbound) },
    { t: 'الصافي', k: 'net', n: 1, f: r => money(r.net), cls: r => dv(r.net) },
    { t: 'عدد', k: 'lines', n: 1, f: r => n0(r.lines) },
  ], mp);

  table($('#tbl-mv-items'), [
    { t: 'الصنف', k: 'item' }, { t: 'الوصف', k: 'descr' }, { t: 'المكان', k: 'place' },
    { t: 'القيمة المطلقة', k: 'amount', n: 1, f: r => money(Math.abs(r.amount)) },
    { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
  ], mi);
}

/* ---------------- البورصة اليومية ---------------- */
let borseItemsSig = '';

function borseLegend(series) {
  $('#borse-legend').innerHTML = series.map(s =>
    `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('');
}

async function loadBorse() {
  const days = Number($('#borse-range')?.value || 180);
  const itemSel = $('#borse-item');
  const item = itemSel ? itemSel.value : '';
  const [d, st] = await Promise.all([
    api(`/api/borse?days=${days}&item=${encodeURIComponent(item)}`),
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
        o.value = i.item;
        o.textContent = i.item + (i.item_code ? ` (${i.item_code})` : '');
        itemSel.appendChild(o);
      });
      itemSel.value = item;
    }
  }

  // مؤشرات
  const chg = latest.filter(r => r.close != null && r.prev_close)
    .map(r => ((r.close - r.prev_close) / r.prev_close) * 100);
  const avg = chg.length ? chg.reduce((a, b) => a + b, 0) / chg.length : null;
  const k = $('#borse-kpis'); k.innerHTML = '';
  kpi(k, { icon: '⌁', g: 'g1', label: 'آخر تسجيل يومي', value: summary.lastDate || '—',
    sub: summary.lastRows ? `${n0(summary.lastRows)} صنف في آخر يوم` : '' });
  kpi(k, { icon: '$', g: 'g3', label: 'ريت الدولار', value: n2(summary.usdRate),
    sub: summary.usdDate ? 'مسجَّل يوم ' + summary.usdDate : 'لا يوجد' });
  kpi(k, { icon: '▤', g: 'g4', label: 'سجلات البورصة', value: n0(summary.rows),
    sub: `${n0(summary.days)} يوم • من ${summary.from || '؟'} إلى ${summary.to || '؟'}` });
  kpi(k, { icon: '%', g: 'g2', label: 'متوسط تغير الإغلاق', value: pct(avg),
    sub: `مقارنة باليوم السابق — ${n0(chg.length)} صنف`,
    tone: avg === null ? '' : (avg >= 0 ? 'good' : 'bad') });

  const closes = latest.filter(r => r.close != null);
  const hi = closes.reduce((a, b) => (!a || b.close > a.close) ? b : a, null);
  const lo = closes.reduce((a, b) => (!a || b.close < a.close) ? b : a, null);
  kpi(k, { icon: '▲', g: 'g4', label: 'أعلى إغلاق اليوم', value: hi ? money(hi.close) : '—',
    sub: hi ? hi.item : 'لا توجد بيانات' });
  kpi(k, { icon: '▼', g: 'g3', label: 'أدنى إغلاق اليوم', value: lo ? money(lo.close) : '—',
    sub: lo ? lo.item : 'لا توجد بيانات' });

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

  // منحنى الإغلاق
  const colors = ['#5b8cff', '#34d399', '#f59e0b', '#fb7185', '#a78bfa', '#38bdf8'];
  const grouped = {};
  series.forEach(r => { if (r.close != null) (grouped[r.item] = grouped[r.item] || []).push(r); });
  const lines = Object.keys(grouped).map((name, i) => ({
    name, color: colors[i % colors.length],
    points: grouped[name].map(r => ({ x: r.borse_date, y: r.close })),
  }));
  lineChart($('#ch-borse'), lines, { fmt: v => n2(v), height: 260 });
  borseLegend(lines);

  lineChart($('#ch-usd'), [
    { name: 'ريت الدولار', color: '#34d399', points: usd.map(r => ({ x: r.borse_date, y: r.usd_rate })) },
  ], { fmt: v => n2(v), height: 260, area: true });

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

$('#borse-range')?.addEventListener('change', () => loadBorse().catch(e => toast(e.message)));
$('#borse-item')?.addEventListener('change', () => loadBorse().catch(e => toast(e.message)));

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
$('#btn-borse-fetch')?.addEventListener('click', () => fetchBorse($('#btn-borse-fetch')));
$('#btn-be-fetch')?.addEventListener('click', () => fetchBorse($('#btn-be-fetch'), () => loadBorseEdit()));

/* ============ البورصة — التعديل اليدوي (التعديل يسري من تاريخه فما بعد) ============ */
let beRows = [];
let beFields = {};
let beCell = null;

const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function showBorsePane(name) {
  $$('#borse-segs .seg').forEach(b => b.classList.toggle('on', b.dataset.pane === name));
  vis($('#borse-pane-view'), name === 'view');
  vis($('#borse-pane-edit'), name === 'edit');
  vis($('#borse-pane-hist'), name === 'hist');
  if (name === 'edit') {
    if (!$('#be-to').value) {
      const t = new Date(); $('#be-to').value = fmtDate(t);
      const f = new Date(); f.setDate(f.getDate() - 30); $('#be-from').value = fmtDate(f);
    }
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
  vis($('#pr-pane-edit'), name === 'edit');
  vis($('#pr-pane-hist'), name === 'hist');
  if (name === 'edit') {
    if (!$('#pr-to').value) {
      const t = new Date(); $('#pr-to').value = fmtDate(t);
      $('#pr-from').value = fmtDate(t);
    }
    if (!prRows.length) loadPrices().catch(e => toast(e.message));
  }
  if (name === 'hist') loadPrHist().catch(e => toast(e.message));
}
$$('#pr-segs .seg').forEach(b => b.addEventListener('click', () => showPricesPane(b.dataset.pane)));

function prFillItems(rows, meta) {
  const sel = $('#pr-item'); if (!sel) return;
  const cur = sel.value;
  const seen = new Map();
  rows.forEach(r => { if (!seen.has(r.item_code)) seen.set(r.item_code, r.item); });
  sel.innerHTML = '<option value="">كل الأصناف</option>' +
    [...seen].map(([c, n]) => `<option value="${escHtml(c)}">${escHtml(n)} (${escHtml(c)})</option>`).join('');
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}

async function loadPrices() {
  const from = $('#pr-from').value, to = $('#pr-to').value, item = $('#pr-item').value;
  const d = await api(`/api/prices/grid?from=${encodeURIComponent(from || '')}&to=${encodeURIComponent(to || '')}&item=${encodeURIComponent(item || '')}`);
  prRows = d.rows; prFields = d.fields; prMeta = d.meta;
  const eff = $('#pr-effdate'); if (eff) eff.textContent = d.to;
  prFillItems(d.rows, d.meta);
  renderPrKpis(d.meta);
  renderPrGrid();
}

function renderPrKpis(m) {
  const h = $('#pr-kpis'); if (!h) return;
  h.innerHTML = '';
  if (!m) return;
  kpi(h, { label: 'آخر تاريخ مستورد', value: m.last_date || '—', sub: 'من شيت «الاسعار» في ملف اليوم', icon: '📅', g: 'g1' });
  kpi(h, { label: 'عدد الأصناف', value: n0(m.items), sub: 'لديها سعر مسجَّل', icon: '◇', g: 'g2' });
  kpi(h, { label: 'صفوف المصدر', value: n0(m.source_rows), sub: 'قبل التحميل للأمام', icon: '▤', g: 'g3' });
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
  ], rows, { limit: 3000, empty: 'لا توجد أسعار في هذا المدى — استورد شيت «الاسعار» من ملف اليوم' });
}

$('#tbl-prices')?.addEventListener('click', e => {
  const b = e.target.closest('button.cellbtn[data-f]');
  if (b) openPrModal(b.dataset.d, b.dataset.i, b.dataset.f);
});
$('#btn-pr-load')?.addEventListener('click', () => loadPrices().catch(e => toast(e.message)));
$('#pr-onlyov')?.addEventListener('change', () => renderPrGrid());
['#pr-from', '#pr-to'].forEach(s => $(s)?.addEventListener('change', () => loadPrices().catch(e => toast(e.message))));
$('#pr-item')?.addEventListener('change', () => loadPrices().catch(e => toast(e.message)));

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
  /* المدى الافتراضي: اليوم — تُملأ الحقول دائماً ليطابق ما عُرض فعلاً */
  if (!$('#cs-to').value) {
    const t = new Date(); $('#cs-to').value = fmtDate(t);
    if (!$('#cs-from').value) $('#cs-from').value = fmtDate(t);
  }
  const from = $('#cs-from').value, to = $('#cs-to').value;
  const item = $('#cs-item').value, unit = $('#cs-unit').value;
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
  /* تنبيه التكلفة الصفرية يظهر فوق الشبكة إن وُجد */
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
  const items = new Map(), units = new Map();
  rows.forEach(r => {
    if (!items.has(r.item_code)) items.set(r.item_code, r.item || r.item_code);
    if (level === 'detail' && r.unit_code) units.set(r.unit_code, r.unit_name || r.unit_code);
  });
  isel.innerHTML = '<option value="">كل الأصناف</option>' +
    [...items].map(([c, n]) => `<option value="${escHtml(c)}">${escHtml(String(n).slice(0, 42))} (${escHtml(c)})</option>`).join('');
  if ([...isel.options].some(o => o.value === curI)) isel.value = curI;
  usel.innerHTML = '<option value="">كل المصانع</option>' +
    [...units].map(([c, n]) => `<option value="${escHtml(c)}">${escHtml(n)} (${escHtml(c)})</option>`).join('');
  if ([...usel.options].some(o => o.value === curU)) usel.value = curU;
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
  const rb = $('#btn-cs-rebuild');
  if (rb) rb.style.display = can('sync') ? '' : 'none';
}

function showCostsPane(name) {
  $$('#cs-segs .seg').forEach(b => b.classList.toggle('on', b.dataset.pane === name));
  vis($('#cs-pane-view'), name === 'view');
  vis($('#cs-pane-status'), name === 'status');
  if (name === 'view') {
    if (!$('#cs-to').value) {
      const t = new Date(); $('#cs-to').value = fmtDate(t); $('#cs-from').value = fmtDate(t);
    }
    if (!csData.rows.length) loadCosts().catch(e => toast(e.message));
  }
  if (name === 'status') loadCsStatus().catch(e => toast(e.message));
}
$$('#cs-segs .seg').forEach(b => b.addEventListener('click', () => showCostsPane(b.dataset.pane)));
$('#btn-cs-load')?.addEventListener('click', () => loadCosts().catch(e => toast(e.message)));
['#cs-level', '#cs-from', '#cs-to', '#cs-item', '#cs-unit'].forEach(s =>
  $(s)?.addEventListener('change', () => loadCosts().catch(e => toast(e.message))));
$('#btn-cs-rebuild')?.addEventListener('click', async () => {
  const btn = $('#btn-cs-rebuild'); btn.disabled = true;
  try {
    const r = await api('/api/costs/rebuild', { method: 'POST', headers: hdr, body: JSON.stringify({}) });
    toast(`أُعيد بناء ${r && r.rows} صف تكلفة ✔`);
    await loadCsStatus();
    loadCosts().catch(() => {});
  } catch (ex) { toast(ex.message); }
  finally { btn.disabled = false; }
});

/* ---------------- الجودة ---------------- */
async function loadQuality(run) {
  const qi = await api('/api/quality' + (run ? '?run=1' : ''));
  table($('#tbl-quality'), [
    { t: 'الرمز', k: 'code' },
    { t: 'المستوى', h: true, f: r => `<span class="pill ${r.severity}">${r.severity === 'error' ? 'خطورة' : r.severity === 'warning' ? 'تنبيه' : 'معلومة'}</span>` },
    { t: 'الفحص', k: 'entity' },
    { t: 'النتيجة', k: 'message' },
    { t: 'أمثلة', f: r => { try { return (JSON.parse(r.details).sample || []).join('، '); } catch (_) { return '—'; } } },
  ], qi, { empty: 'لا توجد ملاحظات — البيانات سليمة ✔' });
}
$('#btn-qrun')?.addEventListener('click', () => loadQuality(true).then(() => toast('تمت إعادة الفحص')));

/* ---------------- الاستيراد ---------------- */
let selectedFile = null;

async function loadFiles() {
  const dir = $('#dir').value.trim();
  const d = await api('/api/files?dir=' + encodeURIComponent(dir));
  const host = $('#filelist'); host.innerHTML = '';
  if (d.error) { host.innerHTML = `<div class="muted" style="padding:12px">${d.error}</div>`; return; }
  const up = document.createElement('div');
  up.innerHTML = `<span>📁 ..</span>`;
  up.onclick = () => { $('#dir').value = dir.replace(/[\\/][^\\/]+$/, '') || dir; loadFiles(); };
  host.appendChild(up);
  d.dirs.forEach(x => {
    const r = document.createElement('div');
    r.innerHTML = `<span>📁 ${x}</span>`;
    r.onclick = () => { $('#dir').value = (dir.replace(/[\\/]+$/, '') + '\\' + x); loadFiles(); };
    host.appendChild(r);
  });
  d.files.forEach(f => {
    const r = document.createElement('div');
    r.innerHTML = `<span>📄 ${f.name}</span><span class="dim">${(f.size / 1048576).toFixed(1)} MB</span>`;
    r.onclick = () => {
      selectedFile = (dir.replace(/[\\/]+$/, '') + '\\' + f.name);
      [...host.children].forEach(c => c.style.background = '');
      r.style.background = 'rgba(58,161,255,.15)';
      $('#btn-import').disabled = false;
      $('#files-meta').textContent = selectedFile;
    };
    host.appendChild(r);
  });
  $('#files-meta').textContent = `${d.files.length} ملف Excel`;
}
$('#btn-dirs')?.addEventListener('click', () => loadFiles().catch(e => toast(e.message)));

$('#btn-preview')?.addEventListener('click', async () => {
  if (!selectedFile) return toast('اختر ملفاً أولاً');
  $('#preview').innerHTML = '<div class="muted">جاري المعاينة...</div>';
  try {
    const out = await api('/api/import/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: selectedFile }),
    });
    let html = '';
    out.forEach(sh => {
      html += `<div style="margin-bottom:8px"><b>${sh.name}</b> <span class="muted">(${sh.ref})</span>`;
      if (sh.tables.length) sh.tables.forEach(t => { html += `<div class="pill info" style="display:inline-block;margin:3px">${t.label}</div>`; });
      else html += ` <span class="muted">— تقرير/ليس جدول بيانات</span>`;
      html += '</div>';
    });
    $('#preview').innerHTML = html || '<div class="muted">لا يوجد</div>';
    $('#import-result').innerHTML = '';
  } catch (e) { $('#preview').innerHTML = `<div class="neg">${e.message}</div>`; }
});

let importBusy = false;

/** استيراد ملف واحد إلى قاعدة البيانات مع شريط التقدم والنتيجة (يستخدمه زرّا الاستيراد) */
async function runImport(file, password) {
  if (!file) { toast('اختر ملفاً أولاً'); return; }
  if (importBusy) { toast('يوجد استيراد جارٍ — انتظر اكتماله'); return; }
  importBusy = true;
  const btnI = $('#btn-import'), btnT = $('#btn-import-today');
  if (btnI) btnI.disabled = true;
  if (btnT) btnT.disabled = true;
  const finish = () => {
    importBusy = false;
    if (btnI) btnI.disabled = !selectedFile;
    if (btnT) btnT.disabled = !todayLastPath;
  };
  try {
    const { jobId } = await api('/api/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: file, password: password || undefined }),
    });
    $('#job').style.display = 'block';
    $('#import-result').innerHTML = '';
    const poll = setInterval(async () => {
      try {
        const j = await api('/api/import/status?id=' + jobId);
        $('#job-stage').textContent = `الحالة: ${j.stage} (${Math.round((Date.now() - j.started) / 1000)} ث)`;
        if (j.status === 'done' || j.status === 'error') {
          clearInterval(poll); $('#job').style.display = 'none'; finish();
          if (j.status === 'error') { $('#import-result').innerHTML = `<div class="neg">${j.error}</div>`; loadToday(); return; }
          let html = '<div class="hint"><b>تم الاستيراد في ' + Math.round(j.ms / 1000) + ' ثانية</b><br>';
          j.result.tables.forEach(t => {
            html += t.error ? `✗ ${t.label}: ${t.error}<br>`
              : `✓ ${t.label}: ${n0(t.rows)} صف (${t.sheet})<br>`;
          });
          if (j.result.protected) html += '<br>الملف محمي — تم القراءة عبر Excel.<br>';
          const lastScan = j.quality.length && j.quality[0].created_at ? fmtDate(new Date(j.quality[0].created_at)) : null;
          html += `<br><b>ملاحظات الجودة (${j.quality.length})${lastScan ? ' — آخر فحص كامل: ' + lastScan : ''}:</b><br>` +
            j.quality.map(q => `• [${q.severity}] ${q.message}`).join('<br>');
          html += '</div>';
          $('#import-result').innerHTML = html;
          refreshBadges();
          loadImports();
          loadToday();
        }
      } catch (e) { clearInterval(poll); $('#job').style.display = 'none'; finish(); toast(e.message); }
    }, 1500);
  } catch (e) { finish(); toast('خطأ: ' + e.message); }
}

$('#btn-import')?.addEventListener('click', () => runImport(selectedFile, $('#pw').value));
$('#btn-import-today')?.addEventListener('click', () => runImport(todayLastPath, $('#pw').value));

/* ---------------- حالة استيراد اليوم ---------------- */
let todayLastPath = null;

async function loadToday() {
  let d;
  try { d = await api('/api/import/today'); } catch (_) { return; }
  todayLastPath = d.lastPath;

  const host = $('#today-status');
  if (host) {
    host.innerHTML = d.sheets.map(s => {
      if (s.imported) return `<span class="pill info">✓ ${s.label} — ${n0(s.todayRows)} صف اليوم</span>`;
      if (s.key === 'balances' && !s.lastAt) return `<span class="pill warning">… ${s.label} — أضف الشيت يومياً</span>`;
      return `<span class="pill error">✗ ${s.label} — لم يُستورد اليوم</span>`;
    }).join('');
  }
  const f = $('#today-file');
  if (f) f.textContent = d.lastFileName ? `آخر ملف: ${d.lastFileName}` : 'لا يوجد ملف مستورد بعد';
  const btn = $('#btn-import-today');
  if (btn) { btn.disabled = importBusy || !d.lastPath; btn.title = d.lastPath || ''; }
  const note = $('#today-note');
  if (note) {
    if (!d.lastPath) note.textContent = 'اختر ملفك اليومي من الأسفل مرة واحدة — بعدها يظهر الزر جاهزاً كل يوم.';
    else if (!d.anyToday) note.textContent = '⚠ لم تستورد شيتات اليوم بعد — ضغطة واحدة تكفي.';
    else note.textContent = `✔ دخلت اليوم: ${d.done} من ${d.total} شيتات.`;
  }
}

async function refreshBadges() {
  try {
    const t = await api('/api/tables');
    $('#b-mov').textContent = n0(t.movements);
    $('#b-sal').textContent = n0(t.sales);
    $('#b-itm').textContent = n0(t.items);
  } catch (_) {}
}

async function loadImports() {
  const t = await api('/api/tables');
  table($('#tbl-imports'), [
    { t: '#', k: 'id', n: 1 },
    { t: 'الملف', k: 'file_name' },
    { t: 'الجدول', f: r => ({ items: 'الأصناف', locations: 'المواقع', movement_types: 'أنواع الحركات', movements: 'الحركات', sales: 'المبيعات', balances: 'الأرصدة', borse: 'البورصة اليومية' })[r.dataset] || r.dataset },
    { t: 'الشيت', k: 'sheet_name' },
    { t: 'صفوف', k: 'rows_inserted', n: 1, f: r => n0(r.rows_inserted) },
    { t: 'تجاوز', k: 'rows_skipped', n: 1, f: r => n0(r.rows_skipped) },
    { t: 'الحالة', h: true, f: r => `<span class="pill ${r.status === 'ok' ? 'info' : 'error'}">${r.status}</span>` },
    { t: 'التاريخ', k: 'imported_at' },
  ], t.imports);
  refreshBadges();
}

/* ---------------- مركز التقارير (عرض داخل المتصفح + تصدير) ---------------- */
/* كيف يُعرض كل تقرير: عمود الجدول + نوع الرسم البياني (اختياري) */
const REP_VIEW = {
  'sales-place': {
    chart: { kind: 'hbar', label: 'place', value: 'value' },
    cols: [
      { t: 'المكان', k: 'place' },
      { t: 'قيمة البيع', k: 'value', n: 1, f: r => money(r.value) },
      { t: 'التكلفة', k: 'cost', n: 1, f: r => money(r.cost) },
      { t: 'مجمل الربح', k: 'profit', n: 1, f: r => money(r.profit), cls: r => dv(r.profit) },
      { t: 'الهامش %', k: 'marginPct', n: 1, f: r => pct(r.marginPct), cls: r => (r.marginPct || 0) < 0 ? 'neg' : 'pos' },
      { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
      { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
    ],
  },
  'sales-month': {
    chart: { kind: 'line', series: [{ name: 'قيمة البيع', color: '#5b8cff', x: 'ym', y: 'value' }] },
    cols: [
      { t: 'الشهر', k: 'ym' },
      { t: 'قيمة البيع', k: 'value', n: 1, f: r => money(r.value) },
      { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
      { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
    ],
  },
  'costs-month': {
    chart: { kind: 'line', series: [{ name: 'تكلفة البيع', color: '#f59e0b', x: 'ym', y: 'cost' }] },
    cols: [
      { t: 'الشهر', k: 'ym' },
      { t: 'التكلفة', k: 'cost', n: 1, f: r => money(r.cost) },
      { t: 'حركات', k: 'lines', n: 1, f: r => n0(r.lines) },
    ],
  },
  'sales-item': {
    cols: [
      { t: 'الصنف', k: 'item' }, { t: 'الوصف', k: 'descr' }, { t: 'المكان', k: 'place' },
      { t: 'قيمة البيع', k: 'value', n: 1, f: r => money(r.value) },
      { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
      { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
    ],
  },
  'sales-customer': {
    cols: [
      { t: 'العميل', k: 'customer' },
      { t: 'القيمة', k: 'value', n: 1, f: r => money(r.value) },
      { t: 'الضريبة', k: 'tax', n: 1, f: r => money(r.tax) },
      { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
    ],
  },
  'sales-class': {
    cols: [
      { t: 'الفئة+الحالة', k: 'combo' },
      { t: 'القيمة الموقّعة', k: 'value', n: 1, f: r => money(r.value), cls: r => dv(r.value) },
      { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
      { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
    ],
  },
  'movements-direction': {
    chart: { kind: 'hbar', label: 'direction', value: 'inbound' },
    cols: [
      { t: 'التوجيه', k: 'direction' },
      { t: 'وارد', k: 'inbound', n: 1, f: r => money(r.inbound) },
      { t: 'صادر', k: 'outbound', n: 1, f: r => money(r.outbound) },
      { t: 'الصافي', k: 'amount', n: 1, f: r => money(r.amount), cls: r => dv(r.amount) },
      { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
      { t: 'عدد', k: 'lines', n: 1, f: r => n0(r.lines) },
    ],
  },
  'movements-month': {
    chart: { kind: 'line', series: [
      { name: 'وارد', color: '#34d399', x: 'ym', y: 'inbound' },
      { name: 'صادر', color: '#fb7185', x: 'ym', y: 'outbound' }] },
    cols: [
      { t: 'الشهر', k: 'ym' },
      { t: 'وارد', k: 'inbound', n: 1, f: r => money(r.inbound) },
      { t: 'صادر', k: 'outbound', n: 1, f: r => money(r.outbound) },
      { t: 'الصافي', k: 'net', n: 1, f: r => money(r.net), cls: r => dv(r.net) },
      { t: 'عدد', k: 'lines', n: 1, f: r => n0(r.lines) },
    ],
  },
  'movements-place': {
    cols: [
      { t: 'المكان', k: 'place' },
      { t: 'وارد', k: 'inbound', n: 1, f: r => money(r.inbound) },
      { t: 'صادر', k: 'outbound', n: 1, f: r => money(r.outbound) },
      { t: 'الصافي', k: 'net', n: 1, f: r => money(r.net), cls: r => dv(r.net) },
      { t: 'عدد', k: 'lines', n: 1, f: r => n0(r.lines) },
    ],
  },
  'movements-items': {
    cols: [
      { t: 'الصنف', k: 'item' }, { t: 'الوصف', k: 'descr' }, { t: 'المكان', k: 'place' },
      { t: 'القيمة المطلقة', k: 'amount', n: 1, f: r => money(Math.abs(r.amount || 0)) },
      { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
    ],
  },
  'inventory-place': {
    chart: { kind: 'hbar', label: 'place', value: 'close_val' },
    cols: [
      { t: 'المكان', k: 'place' },
      { t: 'افتتاحي (قيمة)', k: 'open_val', n: 1, f: r => money(r.open_val) },
      { t: 'ختامي (قيمة)', k: 'close_val', n: 1, f: r => money(r.close_val) },
      { t: 'التغير', n: 1, f: r => money((r.close_val || 0) - (r.open_val || 0)), cls: r => dv((r.close_val || 0) - (r.open_val || 0)) },
      { t: 'كمية ختامية', k: 'close_qty', n: 1, f: r => n2(r.close_qty) },
    ],
  },
  'inventory-class': {
    chart: { kind: 'hbar', label: 'cls', value: 'close_val' },
    cols: [
      { t: 'التصنيف', k: 'cls' },
      { t: 'قيمة الختامي', k: 'close_val', n: 1, f: r => money(r.close_val) },
      { t: 'الكمية', k: 'close_qty', n: 1, f: r => n2(r.close_qty) },
    ],
  },
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
  'quality': {
    cols: [
      { t: 'الرمز', k: 'code' },
      { t: 'المستوى', h: true, f: r => `<span class="pill ${r.severity}">${r.severity === 'error' ? 'خطورة' : r.severity === 'warning' ? 'تنبيه' : 'معلومة'}</span>` },
      { t: 'الفحص', k: 'entity' },
      { t: 'النتيجة', k: 'message' },
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

async function showReport(name) {
  const meta = reportList.find(r => r.name === name);
  if (!meta) return;
  $$('#report-list .exp-card').forEach(a => a.classList.toggle('on', a.dataset.name === name));
  $('#rep-title').textContent = meta.label;
  $('#rep-meta').textContent = 'جاري التحميل...';
  $('#rep-csv').style.display = '';
  $('#rep-csv').href = '/api/export?name=' + encodeURIComponent(name);
  $('#rep-table').innerHTML = '<div class="muted" style="padding:16px">جاري التحميل...</div>';
  try {
    const d = await api('/api/report?name=' + encodeURIComponent(name) + '&limit=500');
    const cfg = REP_VIEW[name];
    $('#rep-meta').textContent =
      `${n0(d.total)} صف` + (d.total > d.rows.length ? ` — يُعرض أول ${n0(d.rows.length)} صف` : '') +
      (d.desc ? ` • ${d.desc}` : '');
    drawReportChart(cfg, d.rows);
    const cols = (cfg && cfg.cols) || autoCols(d.rows);
    table($('#rep-table'), cols, d.rows, { empty: 'لا توجد بيانات لهذا التقرير' });
  } catch (e) {
    $('#rep-meta').textContent = '';
    $('#rep-table').innerHTML = `<div class="neg" style="padding:16px">${e.message}</div>`;
    $('#rep-chart').innerHTML = ''; $('#rep-legend').innerHTML = '';
  }
}

async function loadReports() {
  reportList = await api('/api/reports');
  const host = $('#report-list');
  host.innerHTML = '';
  $('#rep-count').textContent = `${n0(reportList.length)} تقرير`;
  const icons = { sales: '◈', movements: '⇄', inventory: '◫', borse: '⌁', quality: '◇', costs: '▤', balances: '◫' };
  reportList.forEach((r, i) => {
    const a = document.createElement('a');
    a.className = 'exp-card';
    a.href = '#';
    a.dataset.name = r.name;
    const key = r.name.split('-')[0];
    a.innerHTML = `<span class="bi">${icons[key] || '▤'}</span><span><b>${r.label}</b><small>${r.desc || ''}</small></span>`;
    a.addEventListener('click', ev => { ev.preventDefault(); showReport(r.name); });
    host.appendChild(a);
    if (i === 0) showReport(r.name);
  });
  if (!reportList.length) host.innerHTML = '<div class="muted">لا توجد تقارير</div>';
}

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

function goTab(name) {
  const b = document.querySelector(`nav button[data-tab="${name}"]`);
  if (b) b.click();
}

function applyRoleUI() {
  /* ظهور الشاشات: محدَّد بصلاحيات الشاشات التي يضبطها المدير */
  const tabs = me && Array.isArray(me.tabs) ? me.tabs : null;
  $$('nav button').forEach(b => {
    if (b.dataset.tab === 'md')
      vis(b, !tabs || MD_SUBS.some(t => tabs.includes(t)));
    else vis(b, !tabs || tabs.includes(b.dataset.tab));
  });
  vis($('#btn-borse-fetch'), can('sync'));
  vis($('#btn-be-fetch'), can('sync'));
  vis($('#btn-qrun'), can('quality'));
  vis($('#btn-users'), can('users'));
  vis($('#btn-refresh'), !!me);
  $$('.topbar .chip').forEach(c => vis(c, !!me));
  vis($('#me-chip'), !!me);
  if (me) {
    const name = me.full_name || me.username;
    $('#me-name').textContent = name;
    $('#me-role').textContent = me.roleLabel;
    $('#me-avatar').textContent = (name || '?').trim().charAt(0) || '؟';
  }
  /* إن كانت الشاشة الحالية ممنوعة → الذهاب لأول شاشة مسموحة */
  if (me && tabs && tabs.length && !tabs.includes(current)) goTab(tabs[0]);
}

function enterApp(user) {
  me = user;
  vis($('#login-screen'), false);
  $('#login-err').hidden = true;
  const p = $('#login-pass'); if (p) p.value = '';
  applyRoleUI();
  refreshBadges().catch(() => {});
  dbStatus();
  loadTab(current).catch(e => toast('خطأ: ' + e.message));
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
    const sel = id => `<select class="input sm" data-act="role" data-id="${id}">` +
      Object.keys(roleLabels).map(r => `<option value="${r}">${roleLabels[r]}</option>`).join('') + '</select>';
    table($('#tbl-users'), [
      { t: 'المستخدم', h: true, f: r => `<b>${escHtml(r.username)}</b>` +
          (r.full_name ? `<div class="muted xs">${escHtml(r.full_name)}</div>` : '') +
          (me && r.id === me.id ? '<div class="muted xs">◂ حسابك</div>' : '') },
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
  } catch (e) { toast(e.message); }
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

$('#btn-users')?.addEventListener('click', () => {
  goTab('dashboard');
  setTimeout(() => $('#card-users')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 350);
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
  if (me) loadTab(current).catch(() => {});
});

$('#btn-menu')?.addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#scrim')?.addEventListener('click', () => $('#sidebar').classList.remove('open'));

/* حالة قاعدة البيانات في الشريط الجانبي */
async function dbStatus() {
  try {
    const i = await api('/api/health');
    const chip = $('#dbchip');
    if (chip) {
      chip.classList.remove('down');
      chip.querySelector('.txt').textContent = `${i.database} • ${i.version}`;
      chip.title = `قاعدة البيانات: ${i.database} @ ${i.host}:${i.port} (${i.version})`;
    }
  } catch (_) {
    const chip = $('#dbchip');
    if (chip) { chip.classList.add('down'); chip.querySelector('.txt').textContent = 'غير متصل'; }
  }
}

/* ---------------- بدء التشغيل ---------------- */
$('#btn-refresh')?.addEventListener('click', () => loadTab(current).then(() => toast('تم التحديث')).catch(e => toast(e.message)));
window.addEventListener('resize', () => { if (!me) return; clearTimeout(window._rt); window._rt = setTimeout(() => loadTab(current).catch(() => {}), 300); });

dbStatus();

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
