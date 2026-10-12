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

const TITLES = {
  dashboard: ['لوحة التحكم', 'إدارة المستخدمين وصلاحيات الشاشات'],
  md: ['البيانات الأساسية', 'الأصناف • المواقع والمصانع • أنواع الحركات'],
  daily: ['البيانات اليومية', 'حركات سيستم • مبيعات • أرصدة — ملفات باسم التاريخ'],
  pricegroup: ['الأسعار اليومية', 'متابعة البورصة • أسعار السوق • تكلفة يومية'],
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

/* الأقسام: زر واحد في القايمة الجانبية «مثل البيانات الأساسية» وجواه عدة شاشات فرعية */
const MD_GROUPS = {
  md:     { title: 'البيانات الأساسية', crumb: 'الأصناف • المواقع والمصانع • أنواع الحركات',
            subs: ['md-items', 'md-locations', 'md-movetypes'] },
  daily:  { title: 'البيانات اليومية',  crumb: 'حركات سيستم • مبيعات • أرصدة',
            subs: ['movements', 'sales', 'inventory'] },
  pricegroup: { title: 'الأسعار اليومية',   crumb: 'متابعة البورصة • أسعار السوق • تكلفة يومية',
            subs: ['borse', 'prices', 'costs'] },
};
const mdSubsAllowed = id => {
  const g = MD_GROUPS[id];
  if (!g) return [];
  const mine = me && Array.isArray(me.tabs) && me.tabs.length ? me.tabs : g.subs;
  return g.subs.filter(t => mine.includes(t));
};
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
  $('#tab-' + id).classList.add('active');
  $('#page-title').textContent = g.title;
  $('#page-crumb').textContent = g.crumb;
  $('#sidebar').classList.remove('open');
  $$('#tab-' + id + ' [data-sub]').forEach(btn => vis(btn, allowed.includes(btn.dataset.sub)));
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
      $('#page-title').textContent = t[0];
      $('#page-crumb').textContent = '';
      $('#sidebar').classList.remove('open');
      rememberScreen(name);
      loadTab(name).catch(e => toast('خطأ: ' + e.message));
    });
  });
});
/* زر «‹ رجوع» داخل الشاشات الفرعية يعيدك لصفحة قسمها */
$$('[data-back]').forEach(b => {
  b.addEventListener('click', () => {
    const nb = document.querySelector('nav button[data-tab="' + b.dataset.back + '"]');
    if (nb) nb.click();
  });
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
    { k: 'item', t: 'كود الصنف', type: 'text', req: true },
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
    { k: 'item', t: 'كود الصنف', type: 'text', req: true },
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
    { k: 'item', t: 'كود الصنف', type: 'text', req: true },
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
    { k: 'item_code', t: 'كود الصنف', type: 'text', req: true },
    { k: 'item', t: 'اسم الصنف', type: 'text' },
    { k: 'cost_land', t: 'التكلفة (أرضه)', type: 'num' },
    { k: 'market_land', t: 'السوق (أرضه)', type: 'num' },
    { k: 'currency', t: 'العملة', type: 'text' },
  ],
  /* البورصة: قيم السوق + مدخلات التكلفة — «سعر التكلفة» يحسبه الخادم */
  borse: [
    { k: 'borse_date', t: 'تاريخ التسعير', type: 'date', req: true },
    { k: 'item_code', t: 'الصنف', type: 'sel', req: true, opts: [
      { v: '1001', l: '1001 — الــــــــــذرة' },
      { v: '1002', l: '1002 — الصويا' },
      { v: '1004', l: '1004 — البذرة' },
    ] },
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
};

let deCat = null, deEditId = null, deRowsById = {};

function deBuildFields() {
  const host = $('#de-fields'); if (!host) return;
  const star = f => f.req ? ' <b class="neg">*</b>' : '';
  host.innerHTML = (DE_FIELDS[deCat] || []).map(f => {
    if (f.type === 'sel') {                       // قائمة خيارات ثابتة (أصناف البورصة)
      return `<label><span>${escHtml(f.t)}${star(f)}</span>` +
        `<select class="input" data-k="${f.k}">` +
        (f.opts || []).map(o => `<option value="${escHtml(o.v)}">${escHtml(o.l)}</option>`).join('') +
        `</select></label>`;
    }
    if (f.type === 'date') {                       // تاريخ: تلميح dd/mm/yyyy بدل نص المتصفح
      return `<label><span>${escHtml(f.t)}${star(f)}</span>` +
        `<span class="dwrap"><input class="input" data-k="${f.k}" type="date" lang="en-GB" required>` +
        `<span class="dph">dd/mm/yyyy</span></span></label>`;
    }
    const attrs = f.type === 'num' ? 'inputmode="decimal"' : '';
    return `<label><span>${escHtml(f.t)}${star(f)}</span>` +
      `<input class="input" data-k="${f.k}" ${attrs}></label>`;
  }).join('');
}

function deCollect() {
  const data = {};
  $$('#de-fields [data-k]').forEach(el => { data[el.dataset.k] = el.value.trim(); });
  return data;
}

function deReset() {
  deEditId = null;
  const form = $('#de-form'); if (form) form.reset();
  const b = $('#de-save-btn'); if (b) { b.textContent = 'حفظ'; b.disabled = false; }
  const r = $('#de-reset'); if (r) r.style.display = 'none';
  const e = $('#de-err'); if (e) { e.hidden = true; e.textContent = ''; }
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

function deEdit(id) {
  const r = deRowsById[id]; if (!r) return;
  deEditId = Number(id);
  $$('#de-fields [data-k]').forEach(el => {
    const v = r[el.dataset.k];
    el.value = (v === null || v === undefined) ? ''
      : el.type === 'date' ? String(v).slice(0, 10) : v;
  });
  const b = $('#de-save-btn'); if (b) b.textContent = 'حفظ التعديل';
  const rs = $('#de-reset'); if (rs) rs.style.display = '';
  const e = $('#de-err'); if (e) { e.hidden = true; e.textContent = ''; }
  $('#de-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function deDelete(id) {
  if (!confirm('حذف هذا السجل اليدوي نهائياً؟')) return;
  try {
    await api('/api/daily/delete', { method: 'POST', headers: hdr, body: JSON.stringify({ cat: deCat, id }) });
    toast('تم الحذف ✔');
    if (deEditId === Number(id)) deReset();
    await loadManualList();
    const cfg = DAILY_CATS[deCat];
    if (cfg && cfg.reload) cfg.reload().catch(() => {});
  } catch (e) { toast('خطأ: ' + e.message); }
}

function openManual(cat) {
  if (!can('import')) { toast('دورك لا يملك صلاحية الإدخال — اطلب من المدير تفعيلها'); return; }
  if (!DE_FIELDS[cat]) return;
  deCat = cat;
  $('#de-cat').textContent = '— ' + (DAILY_CATS[cat] ? DAILY_CATS[cat].label : cat);
  deReset();
  deBuildFields();
  $('#de-modal').hidden = false;
  loadManualList();
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
  b.addEventListener('click', () => {
    $$('nav button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    current = b.dataset.tab;
    rememberScreen(current);
    if (MD_GROUPS[current]) { showMdLanding(current); return; }
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
  if (name === 'reports') return loadReports();
}

/* ---------------- لوحة التحكم — إدارة المستخدمين والصلاحيات فقط ---------------- */
async function loadDashboard() {
  const isAdmin = !!me && me.role === 'admin';
  const canUsers = can('users');
  const canSee = isAdmin || canUsers;
  vis($('#dash-hero'), canSee);
  vis($('#dash-stats'), canSee);
  vis($('#card-tabperms'), isAdmin);
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
  dashboard: '◧', 'md-items': '▦', 'md-locations': '⌂', 'md-movetypes': '⇅',
  inventory: '◫', sales: '◈', movements: '⇄', borse: '⌁', prices: '¤',
  costs: '∑', quality: '◇', reports: '⤓',
};
/* لون صورة المستخدم حسب اسمه */
const AVC = ['a1', 'a2', 'a3', 'a4', 'a5'];
const avc = s => {
  let n = 0;
  for (const c of String(s || '')) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return AVC[n % AVC.length];
};

/* ---- صلاحيات الشاشات: جدول (شاشة × أدوار) للمدير ---- */
async function loadTabPerms() {
  const d = await api('/api/tabs');
  const acc = new Set(d.perms.accountant || []);
  const view = new Set(d.perms.viewer || []);
  table($('#tbl-tabperms'), [
    { t: 'الشاشة', h: true, f: r => `<div class="scr"><i>${TAB_ICONS[r.id] || '◈'}</i><b>${escHtml(r.label)}</b></div>` },
    { t: 'مدير', h: true, f: () => '<span class="pill info">✓ دائماً</span>' },
    { t: 'محاسب', h: true, f: r => `<label class="psw" title="محاسب"><input type="checkbox" data-role="accountant" data-tab="${r.id}" ${acc.has(r.id) ? 'checked' : ''}><i></i></label>` },
    { t: 'مشاهد', h: true, f: r => `<label class="psw" title="مشاهد"><input type="checkbox" data-role="viewer" data-tab="${r.id}" ${view.has(r.id) ? 'checked' : ''}><i></i></label>` },
  ], d.tabs, { empty: '—' });
  return d.tabs;
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
  const d = await api(`/api/md/items?origin=${mdItemsOrigin}&q=${encodeURIComponent(q)}&limit=1000`
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
    ...(canM ? [{ t: '', h: true, f: r => `<button class="btn sm ghost" data-item="${escHtml(r.code)}">✎ تعديل</button>` }] : []),
  ], d, { empty: 'لا توجد أصناف — استورد ملف الحركات وسيُجلب الموجود منها تلقائياً' });
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
  const r = code ? (mdItemsRows.find(x => x.code === code) || mdPickItems.find(x => x.code === code)) : null;
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

/* نافذة اختيار عامة تُستخدمها كل شاشات «إضافة بيانات»:
   cfg = { title, label, noun, load, nameOf, onEdit, onDelete } */
async function openPicker(cfg) {
  mdPick = cfg;
  const sel = $('#md-pick-sel'), info = $('#md-pick-info');
  $('#md-pick-title').textContent = cfg.title;
  const lbl = $('#md-pick-lbl'); if (lbl) lbl.firstChild.textContent = cfg.label + ' ';
  sel.innerHTML = '<option value="">جارٍ التحميل…</option>';
  if (info) info.textContent = '';
  $('#md-pick-modal').hidden = false;
  try { mdPickItems = await cfg.load(); }
  catch (err) { mdPickItems = []; if (info) info.textContent = 'تعذّر التحميل: ' + err.message; }
  const name = cfg.nameOf || (r => r.descr || r.name || '');
  sel.innerHTML = mdPickItems.length
    ? mdPickItems.map(r => `<option value="${escHtml(r.code)}">${escHtml(r.code)} — ${escHtml(name(r))}</option>`).join('')
    : '<option value="">لا توجد بيانات</option>';
  if (info) info.textContent = `${n0(mdPickItems.length)} ${cfg.noun} متاح — اختر ثم اضغط «تعديل» أو «حذف»`;
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

$('#md-add-btn')?.addEventListener('click', e => {
  e.stopPropagation();
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
    nameOf: r => r.descr || r.name || '',
    load: () => type === 'item' ? api('/api/md/items?limit=3000')
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
/* قائمة «إضافة بيانات» في المواقع: شركة / موقع / مخزن — كلٌّ بإضافة/تعديل/حذف */
$('#md-loc-add-btn')?.addEventListener('click', e => {
  e.stopPropagation();
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
      unit: $('#mw-unit').value, place: $('#mw-place').value.trim(), editCode: editing }) });
    $('#md-wh-modal').hidden = true;
    f.dataset.edit = '';
    toast(editing ? 'تم تعديل المخزن ✔' : 'تمت إضافة المخزن ✔');
    await loadMdLocations();
  } catch (err) { mdErr('mw-err', err.message); }
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
  const r = code ? (mdMtypes.find(x => x.code === code) || mdPickItems.find(x => x.code === code)) : null;
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
      title: 'إدارة تصنيفات الحركات', label: 'اختر التصنيف المطلوب', noun: 'التصنيف',
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
    title: 'إدارة أنواع الحركات', label: 'اختر نوع الحركة المطلوب', noun: 'نوع الحركة',
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
  const r = code ? (mdMtypeCats.find(x => x.code === code) || mdPickItems.find(x => x.code === code)) : null;
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
  const [ov, rec, ip, ic] = await Promise.all([
    api(appendQ('/api/overview', qs)), api(appendQ('/api/reconcile?limit=100', qs)),
    api(appendQ('/api/inventory/place', qs)), api(appendQ('/api/inventory/class', qs)),
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
    const p = new URLSearchParams();
    p.set('limit', '200');
    if ($('#recon-all').checked) p.set('all', '1');
    const qs = inventoryQS();
    const rec = await api('/api/reconcile?' + p.toString() + (qs ? '&' + qs.slice(1) : ''));
    renderRecon(rec); toast('تم احتساب المطابقة');
  } catch (e) { toast('خطأ: ' + e.message); }
});

/* فلترة فورية: التاريخ والبحث والمدى — بلا زر «تطبيق الفلتر» */
liveFilter(['if-item', 'if-from', 'if-to', 'if-place', 'if-place-to', 'if-company', 'if-company-to',
  'if-unit', 'if-unit-to', 'if-storage', 'if-storage-to'],
  () => loadInventory().catch(e => toast(e.message)), 300);

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
  const level = $('#sal-level')?.value || 'detail';
  const d = await api(appendQ('/api/sales/day?limit=20000&by=' + encodeURIComponent(level), qs));
  const rows = d.rows || [];
  const L = d.label || 'تفصيلي';
  const moneyCols = [
    { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
    { t: 'قيمة البيع', k: 'value', n: 1, f: r => money(r.value) },
    { t: 'قيمة البيع للوحدة', k: 'unit_value', n: 1, f: r => (r.unit_value == null ? '—' : n2(r.unit_value)) },
    { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
  ];
  let cols, footerLbl;
  if (level === 'detail') {
    cols = [
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
  } else if (level === 'item') {
    cols = [
      { t: L, k: 'k' },
      { t: 'الوصف', k: 'descr' },
      { t: 'وحدة القياس', k: 'uom', f: r => (r.uom || '—') },
      { t: 'مستندات', k: 'docs', n: 1, f: r => n0(r.docs) },
      ...moneyCols,
    ];
    footerLbl = 'صنف';
  } else {
    /* مستوى مجموعة (مكان/شركة/عميل/مخزن) مفصل على الأصناف: مجموعة × صنف */
    cols = [
      { t: L + ' — تفصيل الصنف', k: 'g' },
      { t: 'الصنف', k: 'item' },
      { t: 'الوصف', k: 'item_desc' },
      { t: 'وحدة القياس', k: 'uom', f: r => (r.uom || '—') },
      { t: 'مستندات', k: 'docs', n: 1, f: r => n0(r.docs) },
      ...moneyCols,
    ];
    footerLbl = 'بند (صنف × ' + L + ')';
  }
  table($('#tbl-sal-detail'), cols, rows, { limit: 0, empty: 'لا توجد بنود مبيعات مطابقة للفلاتر' });
  const tLines = rows.reduce((s, r) => s + (r.lines || 0), 0);
  const tQty = rows.reduce((s, r) => s + (r.qty || 0), 0);
  const tVal = rows.reduce((s, r) => s + (r.value || 0), 0);
  const cnt = $('#sal-detail-count');
  if (cnt) cnt.innerHTML = '<b>' + n0(rows.length) + '</b> ' + footerLbl +
    ' • <b>' + n0(tLines) + '</b> بند • كمية <b>' + n2(tQty) + '</b> • قيمة البيع <b>' + money(tVal) + '</b> ج.م';
  const csv = $('#sal-csv');
  if (csv) csv.href = appendQ('/api/export?name=sales-day-' + (level === 'detail' ? 'detail' : level), qs);
}

/* تغيير طريقة تجميع التقرير في شاشة المبيعات اليومية */
$('#sal-level')?.addEventListener('change', () => loadSales().catch(e => toast(e.message)));

liveFilter(SALES_FILTER_IDS, () => loadSales().catch(e => toast(e.message)), 300);

/* ---------------- الحركات ---------------- */
/* ---- الحركات: فلاتر (من/إلى/مكان/نوع حركة/توجيه/وحدة/صنف) ---- */
const movementsQS = () => filterQS(
  { from: 'mf-from', to: 'mf-to', item: 'mf-item' },
  { place: ['mf-place', 'mf-place-to'], mtype: ['mf-mtype', 'mf-mtype-to'],
    dir: ['mf-dir', 'mf-dir-to'], unit: ['mf-unit', 'mf-unit-to'],
    storage: ['mf-storage', 'mf-storage-to'] });
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
    ]);
  }
  const d = await api(appendQ('/api/movements/report', qs));

  /* تجميع كل توجيه: وارد/صادر + الصافي + عدد الحركات الحقيقية (بعد إسقاط الملغى) */
  table($('#mv-dir-sum'), [
    { t: 'التوجيه', k: 'direction' },
    { t: 'عدد الحركات', k: 'lines', n: 1, f: r => n0(r.lines) },
    { t: 'كمية وارد', k: 'in_qty', n: 1, f: r => n2(r.in_qty) },
    { t: 'قيمة وارد', k: 'in_val', n: 1, f: r => money(r.in_val) },
    { t: 'كمية صادر', k: 'out_qty', n: 1, f: r => n2(r.out_qty) },
    { t: 'قيمة صادر', k: 'out_val', n: 1, f: r => money(r.out_val) },
    { t: 'صافي الكمية', k: 'qty', n: 1, f: r => n2(r.qty), cls: r => dv(r.qty) },
    { t: 'صافي القيمة', k: 'amount', n: 1, f: r => money(r.amount), cls: r => dv(r.amount) },
  ], d.directions);

  /* تقرير واحد: صنف × توجيه × مخزن × مكان — كمية وقيمة صافية */
  table($('#mv-report'), [
    { t: 'كود الصنف', k: 'item' },
    { t: 'اسم الصنف', k: 'item_desc' },
    { t: 'وحدة القياس', k: 'uom' },
    { t: 'التوجيه', k: 'direction' },
    { t: 'المخزن', k: 'storage_loc' },
    { t: 'المكان', k: 'place' },
    { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty), cls: r => dv(r.qty) },
    { t: 'القيمة', k: 'amount', n: 1, f: r => money(r.amount), cls: r => dv(r.amount) },
  ], d.rows);

  const tot = d.rows.reduce((s, r) => s + (r.lines || 0), 0);
  const netVal = d.rows.reduce((s, r) => s + (r.amount || 0), 0);
  $('#mv-report-count').textContent = n0(d.rows.length) + ' سطر • ' + n0(tot) + ' حركة حقيقية'
    + ' • صافي القيمة ' + money(netVal) + ' — الأرقام بعد إسقاط حركات الإلغاء';
}

liveFilter(['mf-item', 'mf-from', 'mf-to', 'mf-place', 'mf-place-to', 'mf-mtype', 'mf-mtype-to',
  'mf-dir', 'mf-dir-to', 'mf-unit', 'mf-unit-to', 'mf-storage', 'mf-storage-to'],
  () => loadMovements().catch(e => toast(e.message)), 300);

/* قائمة «فلاتر أخرى» تُدار مركزياً — لا حاجة لمعالج خاص بالسوق اليومية */

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
  lineChart($('#ch-borse'), lines, { fmt: v => n2(v), height: 260, zero: false });
  borseLegend(lines);

  lineChart($('#ch-usd'), [
    { name: 'ريت الدولار', color: '#34d399', points: usd.map(r => ({ x: r.borse_date, y: r.usd_rate })) },
  ], { fmt: v => n2(v), height: 260, area: true, zero: false });

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
  vis($('#pr-pane-edit'), name === 'edit');
  vis($('#pr-pane-hist'), name === 'hist');
  if (name === 'edit') {
    loadSpan().then(() => defaultRange('pr-from', 'pr-to', 'prices'));
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
liveFilter(['pr-from', 'pr-to', 'pr-item'], () => loadPrices().catch(e => toast(e.message)), 300);
$('#pr-onlyov')?.addEventListener('change', () => renderPrGrid());

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
  resetSort();
  /* المدى الافتراضي: آخر تاريخ في البيانات — تُملأ الحقول دائماً ليطابق ما عُرض فعلاً */
  await loadSpan();
  defaultRange('cs-from', 'cs-to', 'balances');
  if (!$('#cs-to').value) {
    const t = fmtDate(new Date());
    $('#cs-to').value = t;
    if (!$('#cs-from').value) $('#cs-from').value = t;
  }
  const from = $('#cs-from').value, to = $('#cs-to').value;
  const item = $('#cs-item').value, itemTo = $('#cs-item-to').value;
  const unit = $('#cs-unit').value, unitTo = $('#cs-unit-to').value;
  const level = $('#cs-level').value;
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if (item) q.set('item_from', item);
  if (itemTo) q.set('item_to', itemTo);
  if (unit) q.set('unit_from', unit);
  if (unitTo) q.set('unit_to', unitTo);
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
  const curI = isel.value, curI2 = $('#cs-item-to')?.value || '', curU = usel.value, curU2 = $('#cs-unit-to')?.value || '';
  const items = new Map(), units = new Map();
  rows.forEach(r => {
    if (!items.has(r.item_code)) items.set(r.item_code, r.item || r.item_code);
    if (level === 'detail' && r.unit_code) units.set(r.unit_code, r.unit_name || r.unit_code);
  });
  const fill = (sel, vals, none, cur) => {
    if (!sel) return;
    sel.innerHTML = `<option value="">${none}</option>` +
      [...vals].map(([c, n]) => `<option value="${escHtml(c)}">${escHtml(String(n).slice(0, 42))} (${escHtml(c)})</option>`).join('');
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  };
  fill(isel, items, 'كل الأصناف', curI); fill($('#cs-item-to'), items, 'من…', curI2);
  fill(usel, units, 'كل المصانع', curU); fill($('#cs-unit-to'), units, 'كل المصانع', curU2);
  usel.disabled = level !== 'detail';
  const uto = $('#cs-unit-to'); if (uto) uto.disabled = level !== 'detail';
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
liveFilter(['cs-from', 'cs-to', 'cs-item', 'cs-item-to', 'cs-unit', 'cs-unit-to', 'cs-level'],
  () => loadCosts().catch(e => toast(e.message)), 300);
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
function qualityFilterQS() {
  const p = new URLSearchParams();
  const sev = $('#q-sev')?.value;
  if (sev) p.set('sev', sev);
  const ent = ($('#q-ent')?.value || '').trim();
  if (ent) p.set('ent', ent);
  const s = p.toString();
  return s ? '?' + s : '';
}
async function loadQuality(run) {
  resetSort();
  const qs = qualityFilterQS();
  const qi = await api('/api/quality' + (run ? '?run=1' + (qs ? '&' + qs.slice(1) : '') : qs));
  const csv = $('#q-csv');
  if (csv) csv.href = '/api/export?name=quality' + (qs ? '&' + qs.slice(1) : '');
  table($('#tbl-quality'), [
    { t: 'الرمز', k: 'code' },
    { t: 'المستوى', h: true, f: r => `<span class="pill ${r.severity}">${r.severity === 'error' ? 'خطورة' : r.severity === 'warning' ? 'تنبيه' : 'معلومة'}</span>` },
    { t: 'الفحص', k: 'entity' },
    { t: 'النتيجة', k: 'message' },
    { t: 'أمثلة', f: r => { try { return (JSON.parse(r.details).sample || []).join('، '); } catch (_) { return '—'; } } },
  ], qi, { empty: 'لا توجد ملاحظات — البيانات سليمة ✔' });
}
$('#btn-qrun')?.addEventListener('click', () => loadQuality(true).then(() => toast('تمت إعادة الفحص')));
liveFilter(['q-ent', 'q-sev'], () => loadQuality(false).catch(e => toast(e.message)), 300);

/* ---------------- مركز التقارير (عرض داخل المتصفح + تصدير) ---------------- */
/* كيف يُعرض كل تقرير: عمود الجدول + نوع الرسم البياني (اختياري) */
/* أعمدة «الإجمالي»: العمود الأول يتبع مستوى الإظهار، وأعمدة إضافية حسب المستوى */
function salesTotalCols(label, extra = []) {
  return [
    { t: label, k: 'k' },
    ...extra,
    { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
    { t: 'قيمة البيع', k: 'value', n: 1, f: r => money(r.value) },
    { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
    { t: 'تكلفة البيع', k: 'cost', n: 1, f: r => money(r.cost) },
    { t: 'مجمل الربح', k: 'profit', n: 1, f: r => money(r.profit), cls: r => dv(r.profit) },
    { t: 'الهامش %', k: 'marginPct', n: 1, f: r => pct(r.marginPct), cls: r => (r.marginPct || 0) < 0 ? 'neg' : 'pos' },
  ];
}
/* أعمدة «الإجمالي» بمستويات مجموعة (مكان/شركة/عميل/مخزن):
   كل مجموعة تتفصل على الأصناف — مجموعة × صنف مع التكلفة والربح */
function salesGroupItemCols(label, extra = []) {
  return [
    { t: label + ' — تفصيل الصنف', k: 'g' },
    { t: 'الصنف', k: 'item' },
    { t: 'الوصف', k: 'item_desc' },
    { t: 'وحدة القياس', k: 'uom', f: r => (r.uom || '—') },
    ...extra,
    { t: 'مستندات', k: 'docs', n: 1, f: r => n0(r.docs) },
    { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
    { t: 'قيمة البيع', k: 'value', n: 1, f: r => money(r.value) },
    { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
    { t: 'تكلفة البيع', k: 'cost', n: 1, f: r => money(r.cost) },
    { t: 'مجمل الربح', k: 'profit', n: 1, f: r => money(r.profit), cls: r => dv(r.profit) },
    { t: 'الهامش %', k: 'marginPct', n: 1, f: r => pct(r.marginPct), cls: r => (r.marginPct || 0) < 0 ? 'neg' : 'pos' },
  ];
}
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
const movementsTotalCols = () => [
  { t: 'الصنف', k: 'k' },
  { t: 'الوصف', k: 'descr' },
  { t: 'وحدة القياس', k: 'uom', f: r => (r.uom || '—') },
  ...movementsMeasureCols(),
];
const movementsGroupItemCols = label => [
  { t: label + ' — تفصيل الصنف', k: 'g' },
  { t: 'الصنف', k: 'item' },
  { t: 'الوصف', k: 'item_desc' },
  { t: 'وحدة القياس', k: 'uom', f: r => (r.uom || '—') },
  ...movementsMeasureCols(),
];
function inventoryMeasureCols() {
  return [
    { t: 'سجلات', k: 'lines', n: 1, f: r => n0(r.lines) },
    { t: 'أيام', k: 'days', n: 1, f: r => n0(r.days) },
    { t: 'افتتاحي كمية', k: 'open_qty', n: 1, f: r => n2(r.open_qty) },
    { t: 'افتتاحي قيمة', k: 'open_val', n: 1, f: r => money(r.open_val) },
    { t: 'ختامي كمية', k: 'close_qty', n: 1, f: r => n2(r.close_qty) },
    { t: 'ختامي قيمة', k: 'close_val', n: 1, f: r => money(r.close_val) },
  ];
}
const inventoryTotalCols = () => [
  { t: 'الصنف', k: 'k' },
  { t: 'الوصف', k: 'descr' },
  ...inventoryMeasureCols(),
];
const inventoryGroupItemCols = label => [
  { t: label + ' — تفصيل الصنف', k: 'g' },
  { t: 'الصنف', k: 'item' },
  { t: 'الوصف', k: 'item_desc' },
  ...inventoryMeasureCols(),
];
const REP_VIEW = {
  /* ---------- تقارير المبيعات والربحية الثلاثة ---------- */
  'sales-detail': {
    limit: 20000,
    cols: [
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
    ],
  },
  'sales-total-item': { cols: salesTotalCols('الصنف', [{ t: 'الوصف', k: 'descr' }]) },
  'sales-total-place': { cols: salesGroupItemCols('المكان') },
  'sales-total-company': { cols: salesGroupItemCols('الشركة') },
  'sales-total-cust': { cols: salesGroupItemCols('العميل', [{ t: 'الضريبة', k: 'tax', n: 1, f: r => money(r.tax) }]) },
  'sales-total-storage': { cols: salesGroupItemCols('المخزن') },
  /* ---------- تقارير مخازن: تفصيلي • إجمالي (أعلى) • فترات ---------- */
  'movements-detail': {
    limit: 20000,
    cols: [
      { t: 'التاريخ', k: 'post_date' },
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
    ],
  },
  'movements-periods': {
    limit: 20000,
    chart: { kind: 'line', series: [
      { name: 'وارد', color: '#34d399', x: 'ym', y: 'in_val' },
      { name: 'صادر', color: '#f59e0b', x: 'ym', y: 'out_val' },
    ] },
    cols: [
      { t: 'المستوى', k: 'level' },
      { t: 'الفترة', k: 'ym' },
      { t: 'أصناف', k: 'items', n: 1, f: r => n0(r.items) },
      ...movementsMeasureCols(),
    ],
  },
  /* ---------- تقارير أرصدة: تفصيلي • إجمالي (أعلى) • فترات ---------- */
  'inventory-detail': {
    limit: 20000,
    cols: [
      { t: 'التاريخ', k: 'balance_date' },
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
    ],
  },
  'inventory-periods': {
    limit: 20000,
    chart: { kind: 'line', series: [
      { name: 'رصيد افتتاحي', color: '#5b8cff', x: 'ym', y: 'open_val' },
      { name: 'رصيد ختامي', color: '#34d399', x: 'ym', y: 'close_val' },
    ] },
    cols: [
      { t: 'المستوى', k: 'level' },
      { t: 'الفترة', k: 'ym' },
      { t: 'أصناف', k: 'items', n: 1, f: r => n0(r.items) },
      ...inventoryMeasureCols(),
    ],
  },
  'sales-periods': {
    limit: 20000,
    cols: [
      { t: 'المستوى', k: 'level' },
      { t: 'الفترة', k: 'ym' },
      { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
      { t: 'مستندات', k: 'docs', n: 1, f: r => n0(r.docs) },
      { t: 'قيمة البيع', k: 'value', n: 1, f: r => money(r.value) },
      { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
      { t: 'تكلفة البيع', k: 'cost', n: 1, f: r => money(r.cost) },
      { t: 'مجمل الربح', k: 'profit', n: 1, f: r => money(r.profit), cls: r => dv(r.profit) },
      { t: 'الهامش %', k: 'marginPct', n: 1, f: r => pct(r.marginPct), cls: r => (r.marginPct || 0) < 0 ? 'neg' : 'pos' },
    ],
  },
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
    chart: { kind: 'line', series: [
      { name: 'قيمة البيع', color: '#5b8cff', x: 'ym', y: 'value' },
      { name: 'التكلفة', color: '#f59e0b', x: 'ym', y: 'cost' },
    ] },
    cols: [
      { t: 'الشهر', k: 'ym' },
      { t: 'قيمة البيع', k: 'value', n: 1, f: r => money(r.value) },
      { t: 'التكلفة', k: 'cost', n: 1, f: r => money(r.cost) },
      { t: 'مجمل الربح', k: 'profit', n: 1, f: r => money(r.profit), cls: r => dv(r.profit) },
      { t: 'الهامش %', k: 'marginPct', n: 1, f: r => pct(r.marginPct), cls: r => (r.marginPct || 0) < 0 ? 'neg' : 'pos' },
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
      { t: 'التكلفة', k: 'cost', n: 1, f: r => money(r.cost) },
      { t: 'مجمل الربح', k: 'profit', n: 1, f: r => money(r.profit), cls: r => dv(r.profit) },
      { t: 'الهامش %', k: 'marginPct', n: 1, f: r => pct(r.marginPct), cls: r => (r.marginPct || 0) < 0 ? 'neg' : 'pos' },
      { t: 'الكمية', k: 'qty', n: 1, f: r => n2(r.qty) },
      { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
    ],
  },
  'sales-customer': {
    cols: [
      { t: 'العميل', k: 'customer' },
      { t: 'القيمة', k: 'value', n: 1, f: r => money(r.value) },
      { t: 'التكلفة', k: 'cost', n: 1, f: r => money(r.cost) },
      { t: 'مجمل الربح', k: 'profit', n: 1, f: r => money(r.profit), cls: r => dv(r.profit) },
      { t: 'الضريبة', k: 'tax', n: 1, f: r => money(r.tax) },
      { t: 'بنود', k: 'lines', n: 1, f: r => n0(r.lines) },
    ],
  },
  'sales-class': {
    cols: [
      { t: 'الفئة+الحالة', k: 'combo' },
      { t: 'القيمة الموقّعة', k: 'value', n: 1, f: r => money(r.value), cls: r => dv(r.value) },
      { t: 'التكلفة', k: 'cost', n: 1, f: r => money(r.cost) },
      { t: 'مجمل الربح', k: 'profit', n: 1, f: r => money(r.profit), cls: r => dv(r.profit) },
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

const reportQS = () => filterQS(
  { from: 'rf-from', to: 'rf-to', item: 'rf-item' },
  { place: ['rf-place', 'rf-place-to'], unit: ['rf-unit', 'rf-unit-to'],
    storage: ['rf-storage', 'rf-storage-to'], company: ['rf-company', 'rf-company-to'],
    cls: ['rf-cls', 'rf-cls-to'], grp: ['rf-grp', 'rf-grp-to'],
    cust: ['rf-cust', 'rf-cust-to'] });
/* ---------- تقارير «الإجمالي» في مركز التقارير: تقرير واجهة واحد لكل نطاق،
      ب«بند تجميع» يختاره المستخدم. مستويات المجموعة (مكان/شركة/عميل/مخزن/وحدة/
      توجيه/نوع حركة/تصنيف/مجموعة) **مفصّلة على مستوى الصنف** (مجموعة × صنف)
      لتعطي دلالة فعلية — والصنف يقف وحده لأنه تفصيل الصنف أصلاً. */
const REP_DOMAINS = {
  'sales-total': {
    levels: [
      { v: 'item', t: 'على مستوى الصنف', label: 'الصنف' },
      { v: 'place', t: 'على مستوى المكان — تفصيل الأصناف', label: 'المكان' },
      { v: 'company', t: 'على مستوى الشركة — تفصيل الأصناف', label: 'الشركة' },
      { v: 'cust', t: 'على مستوى العميل — تفصيل الأصناف', label: 'العميل' },
      { v: 'storage', t: 'على مستوى المخزن — تفصيل الأصناف', label: 'المخزن' },
    ],
    cols: lv => (lv.v === 'item'
      ? salesTotalCols('الصنف', [{ t: 'الوصف', k: 'descr' }])
      : salesGroupItemCols(lv.label)),
  },
  'movements-total': {
    levels: [
      { v: 'item', t: 'على مستوى الصنف', label: 'الصنف' },
      { v: 'place', t: 'على مستوى المكان — تفصيل الأصناف', label: 'المكان' },
      { v: 'company', t: 'على مستوى الشركة — تفصيل الأصناف', label: 'الشركة' },
      { v: 'storage', t: 'على مستوى المخزن — تفصيل الأصناف', label: 'المخزن' },
      { v: 'unit', t: 'على مستوى الوحدة — تفصيل الأصناف', label: 'الوحدة' },
      { v: 'dir', t: 'على مستوى التوجيه — تفصيل الأصناف', label: 'التوجيه' },
      { v: 'mtype', t: 'على مستوى نوع الحركة — تفصيل الأصناف', label: 'نوع الحركة' },
    ],
    cols: lv => (lv.v === 'item' ? movementsTotalCols() : movementsGroupItemCols(lv.label)),
  },
  'inventory-total': {
    levels: [
      { v: 'item', t: 'على مستوى الصنف', label: 'الصنف' },
      { v: 'place', t: 'على مستوى المكان — تفصيل الأصناف', label: 'المكان' },
      { v: 'company', t: 'على مستوى الشركة — تفصيل الأصناف', label: 'الشركة' },
      { v: 'storage', t: 'على مستوى المخزن — تفصيل الأصناف', label: 'المخزن' },
      { v: 'unit', t: 'على مستوى الوحدة — تفصيل الأصناف', label: 'الوحدة' },
      { v: 'cls', t: 'على مستوى التصنيف — تفصيل الأصناف', label: 'التصنيف' },
      { v: 'grp', t: 'على مستوى المجموعة — تفصيل الأصناف', label: 'المجموعة' },
    ],
    cols: lv => (lv.v === 'item' ? inventoryTotalCols() : inventoryGroupItemCols(lv.label)),
  },
};
/* كل مستوى من كل نطاق = مدخل REP_VIEW خاص به (الاسم = <report>-<level>) */
Object.entries(REP_DOMAINS).forEach(([rep, d]) => {
  d.levels.forEach(lv => { REP_VIEW[rep + '-' + lv.v] = { limit: 20000, cols: d.cols(lv) }; });
});
/* مستوى التجميع محفوظ لكل نطاق على حدة (لا يضيع عند التنقل بين التقارير) */
const repLevels = {};
const repDomainOf = name => REP_DOMAINS[name] || null;
const repTotalSales = 'sales-total';
const repApiName = name => {
  const d = repDomainOf(name);
  return d ? name + '-' + (repLevels[name] || d.levels[0].v) : name;
};

let currentReport = null;
/* عناصر إضافية خاصة بالتقرير المعروض: «بند تجميع» لتقارير الإجمالي + ربط التكلفة للمبيعات */
let repLink = 'doc_item';
function renderRepOpts(name) {
  const host = $('#rep-opts');
  if (!host) return;
  const d = repDomainOf(name);
  host.hidden = !d;
  const wrap = $('#rep-link-wrap');
  if (wrap) wrap.hidden = name !== repTotalSales;
  if (!d) return;
  if (!repLevels[name]) repLevels[name] = d.levels[0].v;
  const sel = $('#rep-level');
  if (sel) {
    sel.innerHTML = d.levels.map(l => `<option value="${l.v}">${escHtml(l.t)}</option>`).join('');
    sel.value = repLevels[name];
  }
  const link = $('#rep-link');
  if (link) link.value = repLink;
}
$('#rep-opts')?.addEventListener('change', async e => {
  const cur = currentReport;
  if (e.target.id === 'rep-level' && cur && repDomainOf(cur)) {
    repLevels[cur] = e.target.value;
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
  const isRaw = String(name).endsWith('-raw');
  const apiName = repApiName(name);
  currentReport = name;
  $$('#report-list .exp-card').forEach(a => a.classList.toggle('on', a.dataset.name === name));
  $('#rep-title').textContent = meta.label;
  renderRepOpts(name);
  const host = $('#rep-table');
  const qs = reportQS();
  $('#rep-csv').style.display = '';
  $('#rep-csv').href = '/api/export?name=' + encodeURIComponent(apiName) + (qs ? '&' + qs.slice(1) : '');
  /* تقرير جديد → فلاتر أعمدة نظيفة */
  if (host.__lastReport !== apiName) { host.__filters = {}; host.__lastReport = apiName; }
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
        op: r.op || 'contains',
        v: String(r.v === null || r.v === undefined ? '' : r.v),
        v2: String(r.v2 === null || r.v2 === undefined ? '' : r.v2),
      };
    });
    if (Object.keys(active).length) colf = '&cols=' + encodeURIComponent(JSON.stringify(active));
  }
  if (!soft) {
    $('#rep-meta').textContent = 'جاري التحميل...';
    host.innerHTML = '<div class="muted" style="padding:16px">جاري التحميل...</div>';
    host.__colSig = null; host.__tbody = null;
  }
  host.dataset.report = isRaw ? '1' : '';
  try {
    const d = await api('/api/report?name=' + encodeURIComponent(apiName)
      + (isRaw ? '&page=' + (repPage[name] || 1) + '&pageSize=1000' : '&limit=' + ((REP_VIEW[apiName] && REP_VIEW[apiName].limit) || 500))
      + (qs ? '&' + qs.slice(1) : '') + colf);
    const cfg = REP_VIEW[apiName] || REP_VIEW[name];
    $('#rep-meta').textContent =
      `${n0(d.total)} صف` + (isRaw ? ` — صفحة ${n0(d.page)} من ${n0(d.pages)}` : (d.total > d.rows.length ? ` — يُعرض أول ${n0(d.rows.length)} صف` : '')) +
      (d.desc ? ` • ${d.desc}` : '');
    drawReportChart(cfg, d.rows);
    /* الأعمدة تُبنى من أول صف؛ وعند نتيجة فارغة (فلتر بلا مطابقة) نُبقي أعمدة الجدول السابقة
       حتى لا يمسح الجدول رأسه وفلاتره ويبقى المستخدم قادراً على تعديل الفلتر. */
    const cols = (cfg && cfg.cols) || (d.rows && d.rows.length ? autoCols(d.rows) : (host.__cols || []));
    table(host, cols, d.rows, { limit: 0, empty: 'لا توجد بيانات لهذا التقرير' });
    /* للتقارير الخام: الفلترة تجري على كل الشيت عبر الخادم — نوضّح ذلك في الشريط */
    if (isRaw && host.__bar && host.__barInfo) {
      const anyF = Object.keys(host.__filters || {}).some(k => filterRuleActive(host.__filters[k]));
      host.__bar.hidden = !anyF;
      if (anyF) host.__barInfo.textContent = `فلاتر الأعمدة: ${n0(d.total)} صف مطابق في كل الشيت — صفحة ${n0(d.page)} من ${n0(d.pages)}`;
    }
    renderRepPager(name, d, isRaw);
  } catch (e) {
    $('#rep-meta').textContent = '';
    host.innerHTML = `<div class="neg" style="padding:16px">${e.message}</div>`;
    host.__colSig = null; host.__tbody = null;
    $('#rep-chart').innerHTML = ''; $('#rep-legend').innerHTML = '';
    renderRepPager(name, null, false);
  }
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
  if (!isRaw || !d || !d.pages || d.pages < 2) { host.innerHTML = ''; host.hidden = true; return; }
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
    keys: ['sales-detail', 'sales-total', 'sales-periods'],
  },
  store: {
    label: 'تقارير مخازن', icon: '⇄',
    keys: ['movements-detail', 'movements-total', 'movements-periods', 'movements-raw'],
  },
  bal: {
    label: 'تقارير أرصدة', icon: '◫',
    keys: ['inventory-detail', 'inventory-total', 'inventory-periods', 'reconcile', 'balances-raw', 'borse-latest', 'borse-raw'],
  },
  misc: {
    label: 'تقارير أخرى', icon: '▤',
    keys: ['quality', 'sales-raw'],
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
  defaultRange('rf-from', 'rf-to', 'movements');
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
  /* تقارير «الإجمالي» عناصر واجهة واحدة لكل نطاق بمستوى تجميع (بقية مستوياتها مخفية) */
  [
    { name: 'sales-total', label: 'إجمالي المبيعات والربحية', desc: 'الإيراد والتكلفة ومجمل الربح — ببند تجميع مفصل على الصنف' },
    { name: 'movements-total', label: 'إجمالي حركات المخازن', desc: 'وارد وصادر وصافي — ببند تجميع مفصل على الصنف' },
    { name: 'inventory-total', label: 'إجمالي أرصدة المخازن', desc: 'افتتاحي وختامي — ببند تجميع مفصل على الصنف' },
  ].forEach(v => { if (!reportList.some(r => r.name === v.name)) reportList.push(v); });
  repPage = {};
  renderReportList(currentRepGroup);
}

/* يعرض بطاقات التقارير لمجموعة واحدة — مع أي تقرير غير مصنّف (يُذيّل للمجموعة الأولى) */
function renderReportList(grp) {
  currentRepGroup = grp;
  const host = $('#report-list');
  if (!host) return;
  $$('#rep-groups .seg').forEach(b => b.classList.toggle('on', b.dataset.grp === grp));
  const seen = new Set(repGroupKeys(grp));
  const order = new Map(repGroupKeys(grp).map((k, i) => [k, i]));
  const items = reportList.filter(r => seen.has(r.name))
    .sort((a, b) => (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99));
  /* أي تقرير ما له مجموعة: يظهر في كل المجموعات حتى لا يختفي */
  const extra = reportList.filter(r => !reportGroupOf(r.name));
  const all = [...items, ...extra];
  const meta = REP_GROUPS[grp];
  host.innerHTML = '';
  $('#rep-count').textContent = `${n0(items.length)} تقرير في «${meta ? meta.label : grp}»`;
  all.forEach(r => {
    const a = document.createElement('a');
    a.className = 'exp-card';
    a.href = '#';
    a.dataset.name = r.name;
    const g = reportGroupOf(r.name);
    const icon = g ? REP_GROUPS[g].icon : '▤';
    a.innerHTML = `<span class="bi">${icon}</span><span><b>${r.label}</b><small>${r.desc || ''}</small></span>`;
    a.addEventListener('click', ev => { ev.preventDefault(); repPage[r.name] = 1; showReport(r.name); });
    host.appendChild(a);
  });
  const empty = $('#rep-list-empty');
  if (empty) empty.hidden = all.length > 0;
  /* أول تقرير في المجموعة يُعرض تلقائياً — الشاشة يبقى فيها دايماً تقرير معروض */
  if (all.length) { repPage[all[0].name] = 1; showReport(all[0].name); }
}

$$('#rep-groups .seg').forEach(b => b.addEventListener('click', () => {
  renderReportList(b.dataset.grp);
}));

/* معايير التقارير: فلترة فورية — أي تغيير في التاريخ أو البحث يُعيد التقرير مباشرة */
const RF_FILTER_IDS = ['rf-from', 'rf-to', 'rf-item',
  'rf-place', 'rf-place-to', 'rf-unit', 'rf-unit-to', 'rf-storage', 'rf-storage-to',
  'rf-company', 'rf-company-to', 'rf-cls', 'rf-cls-to', 'rf-grp', 'rf-grp-to',
  'rf-cust', 'rf-cust-to'];
liveFilter(RF_FILTER_IDS,
  () => { if (currentReport) showReport(currentReport).catch(e => toast(e.message)); }, 400);

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
    const g = MD_GROUPS[b.dataset.tab];
    if (g) vis(b, !tabs || g.subs.some(t => tabs.includes(t)));
    else vis(b, !tabs || tabs.includes(b.dataset.tab));
  });
  vis($('#btn-borse-fetch'), can('sync'));
  vis($('#btn-be-fetch'), can('sync'));
  vis($('#btn-qrun'), can('quality'));
  vis($('#btn-users'), can('users'));
  vis($('#btn-refresh'), !!me);
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
  dbStatus();
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
  if (me) { const n = activeScreen(); if (!MD_GROUPS[n]) loadTab(n).catch(() => {}); }
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
  if (MD_GROUPS[name]) { goTab(name); return true; }
  const el = document.querySelector(`nav button[data-tab="${name}"]`)
    || document.querySelector(`[data-sub="${name}"]`);
  if (el) { el.click(); return true; }
  return false;
}
$('#btn-refresh')?.addEventListener('click', async () => {
  const name = activeScreen();
  if (MD_GROUPS[name]) { showMdLanding(name); toast('تم التحديث'); return; }
  try { await loadTab(name); toast('تم التحديث'); } catch (e) { toast(e.message); }
});
window.addEventListener('resize', () => {
  if (!me) return;
  const name = activeScreen();
  if (MD_GROUPS[name]) return;
  clearTimeout(window._rt);
  window._rt = setTimeout(() => loadTab(name).catch(() => {}), 300);
});

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
