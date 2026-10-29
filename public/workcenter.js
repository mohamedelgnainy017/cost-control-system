/* ============================================================
 * التقارير — إدارة التقارير المحفوظة + تقارير التطبيق + شريط الحالة
 * ============================================================
 * الشاشات الثلاث للمنصة تستعمل هذا الملف في موضعين:
 *   • «التقارير» ← تقارير التطبيق (الأصلية) + التقارير المحفوظة
 *   • شريط الحالة أعلى كل شاشة ⇒ محتوى «مركز العمل» القديم (مدمج، لا ملغى)
 *
 * قاعدة الأمانة: ما يُعرض من تعريف تقرير لا يُسمّى «التقرير الفعلي» إلا إذا
 * استُخرج من ناتج تشغيله الحقيقي — وكل دليل يحمل مصدره (runtime / code / registry).
 */
(function () {
  'use strict';
  const apiCall = (typeof api === 'function') ? api : (async (u, o) => {
    const r = await fetch(u, o); const j = await r.json();
    if (!r.ok || !j.ok) throw new Error((j && (j.message || j.error)) || r.statusText);
    return (j && j.data) ? j.data : j;
  });
  const $ = id => document.getElementById(id);
  const esc = s => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const fmtDate = iso => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('ar-EG'); } catch (_) { return String(iso); }
  };
  const empty = msg => '<div class="wc-empty">' + esc(msg) + '</div>';

  /* ============================================================
   * ١) شريط الحالة — محتوى مركز العمل (مدمج داخل الشاشات الثلاث)
   * ============================================================ */
  const LIMIT = 5;

  function isMissingRoute(e) {
    return !!(e && (e.status === 404 || /المسار غير موجود|not found/i.test(String(e.message || ''))));
  }

  /** وضع التوافق: الخادم المشغّل أقدم من الكود ⇒ نبني العرض من المسارات القائمة
     الموجودة فعلًا (تشغيلات · فهرس · معادلات · شاشات) — بيانات حقيقية بلا اختلاق. */
  function buildWorkCenterLegacy(p) {
    const src = p || {};
    const runs = (src.runs && src.runs.items) || [];
    const catSum = (src.catalog && src.catalog.summary) || {};
    const mod = (src.model && src.model.summary) || src.model || {};
    const scr = (src.screens && src.screens.summary) || src.screens || {};
    const st = catSum.byStatus || {};
    const f = mod.formulas || {};
    const runRows = runs.slice(0, LIMIT).map(r => ({
      runId: r.runId || '',
      source: (r.source && (r.source.label || r.source.name)) || '',
      workflowName: r.workflowName || '',
      rows: Number(r.rowCount) || 0,
      columns: Array.isArray(r.columns) ? r.columns.length : 0,
      savedAt: r.savedAt || '',
      traced: !!r.traced,
      definitionChanged: r.definitionChanged === true,
      engineState: r.engineState || 'unknown',
      warnings: Array.isArray(r.warnings) ? r.warnings.length : 0,
    }));
    const health = {
      sources: {
        total: Number(catSum.total) || 0,
        implemented: Number(st['منفّذ']) || 0,
        documented: Number(st['موثق فقط']) || 0,
        other: Math.max(0, (Number(catSum.total) || 0) - (Number(st['منفّذ']) || 0) - (Number(st['موثق فقط']) || 0)),
        canonical: catSum.canonicalBalance || '',
      },
      formulas: { total: Number(f.total) || 0, byStatus: f.byStatus || {}, numericVerified: Number(mod.numericVerified) || 0 },
      screens: { total: Number(scr.screens) || 0, reports: Number(scr.reports) || 0, visibleReports: Number(scr.visibleReports) || 0 },
    };
    const alerts = [];
    const warned = runRows.filter(r => r.warnings > 0);
    if (warned.length) alerts.push({ kind: 'warn', title: 'نتائج تحتاج انتباهًا', detail: warned.length + ' نتيجة تحمل تحذيرات (اقتطاع أو ربط غير مكتمل).' });
    const untraced = runRows.filter(r => !r.traced);
    if (untraced.length) alerts.push({ kind: 'info', title: 'نتائج قديمة بلا تتبّع كامل', detail: untraced.length + ' نتيجة سابقة لا تحمل تعريف تشغيلها.' });
    return {
      generatedAt: new Date().toISOString(),
      runs: runRows,
      reports: [],
      formulas: [],
      health,
      alerts,
      actions: [],
      empty: { runs: runRows.length === 0, reports: true, formulas: true },
      degraded: {
        active: true,
        missing: ['آخر التقارير المحفوظة', 'المعادلات المحفوظة'],
        note: 'نسخة الخادم المشغّلة أقدم من الكود: العرض مبني على المسارات الموجودة فعلًا. '
          + '«آخر التقارير» و«المعادلات المحفوظة» تحتاج إعادة تشغيل الخادم.',
      },
    };
  }

  async function loadWorkCenterLegacy() {
    const [runs, catalog, model, screens] = await Promise.all([
      apiCall('/api/workflows/outputs').catch(() => null),
      apiCall('/api/catalog').catch(() => null),
      apiCall('/api/model/formulas').catch(() => null),
      apiCall('/api/screens').catch(() => null),
    ]);
    if (!runs && !catalog) throw new Error('تعذّر الوصول إلى مسارات الحالة على الخادم');
    return buildWorkCenterLegacy({ runs, catalog, model, screens });
  }

  /** يجلب حالة المنصة (المسار الجديد أولًا ثم وضع التوافق) */
  async function loadStatus(force) {
    try {
      return await apiCall('/api/workcenter');
    } catch (e) {
      if (isMissingRoute(e)) return loadWorkCenterLegacy();
      throw e;
    }
  }

  /* ============================================================
   * ٢) التقارير المحفوظة (تصاميم المخزن)
   * ============================================================ */
  let rmRows = [];            /* التصاميم المحفوظة (مخزن المصمم) */
  let rmAppReports = [];      /* تقارير التطبيق المدمجة */
  let rmTab = 'saved';        /* اللوحة النشطة داخل إدارة التقارير */

  async function loadReportsManager() {
    const host = $('rm-grid'); const msg = $('rm-msg'); if (!host) return;
    try {
      const d = await apiCall('/api/reports/saved');
      rmRows = d.items || [];
    } catch (e) {
      host.innerHTML = empty(isMissingRoute(e)
        ? 'قائمة التقارير المحفوظة غير متاحة في نسخة الخادم المشغّلة — أعد تشغيل الخادم.'
        : 'تعذّر تحميل التقارير: ' + e.message);
      if (msg) msg.textContent = e.message;
      return;
    }
    try {
      const r = await apiCall('/api/screens');
      rmAppReports = (r && r.reports) ? r.reports : [];
    } catch (e) { rmAppReports = []; }
    const counts = $('rm-counts');
    if (counts) counts.textContent = rmRows.length + ' تصميم محفوظ · ' + rmAppReports.length + ' تقرير تطبيق';
    renderReportsManager();
  }

  function renderReportsManager() {
    const host = $('rm-grid'); const msg = $('rm-msg'); if (!host) return;
    const q = (($('rm-search') || {}).value || '').trim().toLowerCase();
    const src = (($('rm-source') || {}).value || '');
    const sortBy = (($('rm-sort') || {}).value || 'date');

    const rows = rmRows.filter(r => (!q || String(r.name || '').toLowerCase().includes(q))
      && (!src || String((r.source && r.source.label) || '') === src))
      .sort((a, b) => sortBy === 'name' ? String(a.name || '').localeCompare(String(b.name || ''), 'ar')
        : sortBy === 'source' ? String((a.source && a.source.label) || '').localeCompare(String((b.source && b.source.label) || ''), 'ar')
        : String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
    if (!rows.length) { host.innerHTML = '<div class="wc-empty">' + (rmRows.length ? 'لا نتائج مطابقة للبحث.' : 'لا توجد تقارير محفوظة بعد.') + '</div>'; return; }
    host.innerHTML = rows.map(r => {
      const s = r.source || {};
      return '<div class="rm-card">'
        + '<div class="rm-card-h"><b>' + esc(r.name) + '</b>'
        + '<span class="pill ok">تصميم محفوظ</span>'
        + (s.traced ? '<span class="pill ok">تتبّع</span>' : '<span class="pill info">بلا تتبّع</span>') + '</div>'
        + '<div class="muted xs">' + esc(s.label || 'مصدر غير محدد') + (r.runId ? ' · ' + esc(r.runId) : '') + '</div>'
        + '<div class="muted xs">' + esc(fmtDate(r.savedAt)) + ' · ' + (r.components || 0) + ' مكوّن</div>'
        + '<div class="rm-acts">'
        + '<button class="btn xs" data-rm="open" data-id="' + esc(r.id) + '">فتح</button>'
        + '<button class="btn xs ghost" data-rm="dup" data-id="' + esc(r.id) + '">نسخ</button>'
        + '<button class="btn xs ghost" data-rm="html" data-id="' + esc(r.id) + '">HTML</button>'
        + '<button class="btn xs ghost" data-rm="xlsx" data-id="' + esc(r.id) + '">Excel</button>'
        + '<button class="btn xs ghost" data-rm="rename" data-id="' + esc(r.id) + '">إعادة تسمية</button>'
        + '<button class="btn xs danger" data-rm="del" data-id="' + esc(r.id) + '">حذف</button>'
        + '</div></div>';
    }).join('');
    host.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => rmAction(b.getAttribute('data-rm'), b.getAttribute('data-id'))));
    if (msg) msg.textContent = rows.length + ' تقرير' + (rows.length !== rmRows.length ? ' (من ' + rmRows.length + ')' : '');
  }

  async function rmAction(act, id) {
    const msg = $('rm-msg');
    try {
      if (act === 'open') {
        if (typeof window.loadReportIntoDesigner === 'function') {
          await window.loadReportIntoDesigner(id);
          if (window.PlatformShell) window.PlatformShell.show('report-studio', 'designer');
          if (typeof window.goTab === 'function') window.goTab('report-studio');
        } else if (typeof window.goTab === 'function') window.goTab('report-studio');
        return;
      }
      if (act === 'html' || act === 'xlsx') {
        window.open('/api/reports/export/' + act + '?id=' + encodeURIComponent(id), '_blank');
        return;
      }
      if (act === 'del') {
        if (!window.confirm('حذف التقرير نهائيًا؟')) return;
        await apiCall('/api/reports/delete?id=' + encodeURIComponent(id), { method: 'POST' });
        if (msg) msg.textContent = 'تم الحذف';
        await loadReportsManager();
        return;
      }
      if (act === 'dup' || act === 'rename') {
        const r = await apiCall('/api/reports/get?id=' + encodeURIComponent(id));
        const def = Object.assign({}, r);
        if (act === 'dup') {
          def.id = undefined;
          def.name = String(def.name || 'تقرير') + ' - نسخة';
        } else {
          const nn = window.prompt('الاسم الجديد:', def.name || '');
          if (!nn || nn === def.name) return;
          def.name = nn;
        }
        await apiCall('/api/reports/save', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ report: def }),
        });
        if (msg) msg.textContent = act === 'dup' ? 'تم النسخ' : 'تم إعادة التسمية';
        await loadReportsManager();
      }
    } catch (e) {
      if (msg) msg.textContent = 'تعذّر الإجراء: ' + e.message;
    }
  }

  /* ============================================================
   * ٣) تقارير التطبيق الأصلية — الفتح وتتبّع الأعمدة
   * ============================================================ */
  let appReports = [];     /* تقارير التطبيق المدمجة */
  let savedReports = [];   /* التقارير المحفوظة (مخزن المصمم) */
  let appGroup = '';       /* التصنيف المختار: '' | app | saved | sales | store | bal | pbix */

  async function loadAppReports() {
    const host = $('rp-app-grid'); const msg = $('rp-app-msg'); if (!host) return;
    const [scr, saved] = await Promise.all([
      apiCall('/api/screens').catch(() => null),
      apiCall('/api/reports/saved').catch(() => null),
    ]);
    appReports = (scr && scr.reports) ? scr.reports : [];
    savedReports = (saved && saved.items) ? saved.items : [];
    rmRows = savedReports;
    renderAppReports();
    if (msg) msg.textContent = appReports.length + ' تقرير تطبيق · ' + savedReports.length + ' تقرير محفوظ';
  }

  function savedAreDrafts(r) {
    return !r.runId;
  }

  function renderAppReports() {
    const host = $('rp-app-grid'); if (!host) return;
    const q = (($('rp-app-search') || {}).value || '').trim().toLowerCase();
    const src = (($('rp-app-source') || {}).value || '');
    const appRows = appReports.filter(r => !['app', 'saved'].includes(appGroup)
      && (!q || String(r.label || r.key || '').toLowerCase().includes(q) || String(r.key || '').toLowerCase().includes(q))
      && (!src || String(r.source || '') === src)
      && (!appGroup || (typeof reportGroupOf === 'function' && reportGroupOf(r.key) === appGroup)));
    const savedRows = savedReports.filter(r => !['sales', 'store', 'bal', 'pbix'].includes(appGroup)
      && (appGroup !== 'app')
      && (!appGroup || appGroup === 'saved' || (appGroup === 'draft' ? savedAreDrafts(r) : !savedAreDrafts(r)))
      && (!q || String(r.name || '').toLowerCase().includes(q))
      && (!src || String((r.source && (r.source.label || r.source.name)) || '') === src));
    const counts = $('rp-app-counts');
    if (counts) counts.textContent = (appRows.length + savedRows.length) + ' تقرير'
      + ((appRows.length + savedRows.length) !== (appReports.length + savedReports.length)
        ? ' (من ' + (appReports.length + savedReports.length) + ')' : '');
    if (!appRows.length && !savedRows.length) { host.innerHTML = empty('لا تقارير مطابقة للتصنيف أو البحث.'); return; }
    const appHtml = appRows.map(r =>
      '<div class="rm-card">'
      + '<div class="rm-card-h"><b>' + esc(r.label || r.key) + '</b>'
      + '<span class="pill info">تقرير تطبيق</span>'
      + (r.hidden ? '<span class="pill">خام/تصدير</span>' : '') + '</div>'
      + '<div class="muted xs">' + esc(r.key) + ' · ' + esc(r.source || '—') + '</div>'
      + '<div class="muted xs">' + esc((r.fields || []).length) + ' حقل · ' + esc(r.grouping || '—') + '</div>'
      + '<div class="rm-acts">'
      + '<button class="btn xs" data-ra="open" data-id="' + esc(r.key) + '">فتح في التطبيق</button>'
      + '<button class="btn xs ghost" data-ra="trace" data-id="' + esc(r.key) + '">تتبّع الأعمدة</button>'
      + '<button class="btn xs ghost" data-ra="import" data-id="' + esc(r.key) + '">استيراد في المصمّم</button>'
      + '</div></div>').join('');
    const savedHtml = savedRows.map(r => {
      const s = r.source || {};
      return '<div class="rm-card">'
        + '<div class="rm-card-h"><b>' + esc(r.name) + '</b>'
        + '<span class="pill ok">' + (savedAreDrafts(r) ? 'مسودة' : 'تقريري') + '</span>'
        + (s.traced ? '<span class="pill ok">تتبّع</span>' : '<span class="pill info">بلا تتبّع</span>') + '</div>'
        + '<div class="muted xs">' + esc(s.label || 'مصدر غير محدد') + (r.runId ? ' · ' + esc(r.runId) : '') + '</div>'
        + '<div class="muted xs">' + esc(fmtDate(r.savedAt)) + ' · ' + (r.components || 0) + ' مكوّن</div>'
        + '<div class="rm-acts">'
        + '<button class="btn xs" data-rm="open" data-id="' + esc(r.id) + '">تحرير في المصمّم</button>'
        + '<button class="btn xs ghost" data-rm="dup" data-id="' + esc(r.id) + '">نسخ</button>'
        + '<button class="btn xs ghost" data-rm="html" data-id="' + esc(r.id) + '">HTML</button>'
        + '<button class="btn xs ghost" data-rm="xlsx" data-id="' + esc(r.id) + '">Excel</button>'
        + '<button class="btn xs ghost" data-rm="rename" data-id="' + esc(r.id) + '">إعادة تسمية</button>'
        + '<button class="btn xs danger" data-rm="del" data-id="' + esc(r.id) + '">حذف</button>'
        + '</div></div>';
    }).join('');
    host.innerHTML = appHtml + savedHtml;
    host.querySelectorAll('[data-ra]').forEach(b => b.addEventListener('click', () => {
      const act = b.getAttribute('data-ra');
      const id = b.getAttribute('data-id');
      if (act === 'open') openAppReport(id);
      else if (act === 'trace') traceAppReport(id);
      else if (act === 'import') {
        if (typeof window.openLegacyImport === 'function') window.openLegacyImport(id);
        else toast('المصمّم غير متاح في هذه النسخة');
      }
    }));
    host.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
      await rmAction(b.getAttribute('data-rm'), b.getAttribute('data-id'));
      if (b.getAttribute('data-rm') !== 'html' && b.getAttribute('data-rm') !== 'xlsx') loadAppReports();
    }));
  }

  /** فتح التقرير الأصلي في شاشة التقارير داخل التطبيق (كما تُعرض للمستخدم) */
  function openAppReport(key) {
    if (!key) return;
    if (typeof window.openReportsScreen === 'function') {
      window.openReportsScreen(key).catch(e => toast(e.message));
      return;
    }
    if (typeof window.goTab === 'function') window.goTab('reports');
  }

  /**
   * تتبّع مصدر كل عمود واعتمادياته:
   *   runtime  = مستخرج من ناتج التقرير الحقيقي (الدليل الأول)
   *   code     = استخراج ساكن من الشيفرة (استدلال — يُعلَم كذلك)
   *   registry = مصرَّح به في سجل الشاشات (تصريح لا يُثبت)
   */
  async function traceAppReport(key) {
    const host = $('rp-app-detail'); const msg = $('rp-app-msg');
    if (!host || !key) return;
    host.hidden = false;
    host.innerHTML = '<div class="ws-detail-h"><b>تتبّع تقرير: ' + esc(key) + '</b>'
      + '<button type="button" class="btn xs ghost" id="rp-app-detail-close">إغلاق</button></div>'
      + '<div class="hint">جارٍ تنفيذ التقرير لاستخراج أعمدته الفعلية…</div>';
    $('rp-app-detail-close')?.addEventListener('click', () => { host.hidden = true; host.innerHTML = ''; });
    try {
      const out = await apiCall('/api/reports/import-legacy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: key }),
      });
      host.innerHTML = traceHtml(key, out);
      $('rp-app-detail-close')?.addEventListener('click', () => { host.hidden = true; host.innerHTML = ''; });
      if (msg) msg.textContent = 'تتبّع جاهز: ' + key;
    } catch (e) {
      host.innerHTML = '<div class="ws-detail-h"><b>تتبّع تقرير: ' + esc(key) + '</b></div>'
        + '<div class="hint">تعذّر التنفيذ: ' + esc(e.message)
        + ' — الأعمدة المسجَّلة في السجل تُعرض أدناه (تعريف مصرَّح به، لا ناتج فعلي).</div>'
        + registryTable(key);
      if (msg) msg.textContent = 'تعذّر التنفيذ: ' + e.message;
    }
  }

  function registryTable(key) {
    const r = appReports.find(x => x.key === key);
    if (!r) return '';
    return '<div class="ws-detail-sec">ما هو مصرَّح به في السجل (ليس ناتجًا فعليًا)</div>'
      + '<table class="an-table"><thead><tr><th>الحقل</th></tr></thead><tbody>'
      + (r.fields || []).map(f => '<tr><td>' + esc(f) + '</td></tr>').join('')
      + '</tbody></table>';
  }

  function traceHtml(key, out) {
    const ex = (out && out.extraction) || {};
    const cols = (ex.runtime && ex.runtime.columns) || [];
    const declared = ex.declared || [];
    const diff = ex.diff || {};
    let h = '<div class="ws-detail-h"><b>تتبّع تقرير: ' + esc(ex.label || key) + '</b>'
      + '<button type="button" class="btn xs ghost" id="rp-app-detail-close">إغلاق</button></div>';
    if (ex.runtime && ex.runtime.ok) {
      h += '<div class="rd-note ok"><b>الأعمدة مستخرجة من ناتج التقرير الحقيقي</b><span>'
        + cols.length + ' عمود · ' + (ex.runtime.rowCount || 0) + ' صف · المصدر: ' + esc(ex.label || key) + '</span></div>';
    } else {
      h += '<div class="rd-note warn"><b>تعذّر تنفيذ التقرير الأصلي</b><span>'
        + esc((ex.runtime && ex.runtime.error) || 'سبب غير معروف')
        + ' — الأعمدة أدناه من التصريح المسجَّل فقط (غير مُثبتة ببيانات).</span></div>';
    }
    if (cols.length) {
      h += '<div class="ws-detail-sec">أعمدة التقرير ودليل كل عمود</div>'
        + '<table class="an-table"><thead><tr><th>العمود</th><th>النوع</th><th>الدليل</th></tr></thead><tbody>'
        + cols.map(c => '<tr><td><b>' + esc(c.name) + '</b></td><td class="muted xs">' + esc(c.type || '—') + '</td>'
          + '<td>' + evidencePill(c.evidence) + '</td></tr>').join('')
        + '</tbody></table>';
    }
    if (declared.length) {
      h += '<div class="ws-detail-sec">مصرَّح به في سجل الشاشات (تصريح لا يُثبت)</div>'
        + '<div class="muted xs">' + declared.map(d => esc(d.name)).join(' · ') + '</div>';
    }
    if (ex.code && (ex.code.functions || []).length) {
      h += '<div class="ws-detail-sec">دوال تنفيذ التقرير (من الشيفرة — استدلال)</div>'
        + '<div class="muted xs">' + ex.code.functions.map(esc).join(' · ') + '</div>';
    }
    if (ex.code && (ex.code.tables || []).length) {
      h += '<div class="ws-detail-sec">جداول مرجَّحة (استدلال)</div>'
        + '<div class="muted xs">' + ex.code.tables.map(esc).join(' · ') + '</div>';
    }
    if (ex.code && (ex.code.params || []).length) {
      h += '<div class="ws-detail-sec">معاملات/فلاتر مدعومة (استدلال)</div>'
        + '<div class="muted xs">' + ex.code.params.map(esc).join(' · ') + '</div>';
    }
    if ((diff.missingAtRuntime || []).length) {
      h += '<div class="rd-note warn"><b>مصرَّح به ولم يظهر في الناتج</b><span>' + diff.missingAtRuntime.map(esc).join(' · ') + '</span></div>';
    }
    if ((diff.notDeclared || []).length) {
      h += '<div class="rd-note warn"><b>في الناتج وغير مصرَّح به</b><span>' + diff.notDeclared.map(esc).join(' · ') + '</span></div>';
    }
    if ((ex.notes || []).length) {
      h += '<ul class="rd-note-list">' + ex.notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>';
    }
    return h;
  }

  function evidencePill(e) {
    if (e === 'runtime') return '<span class="pill ok">من ناتج التقرير الحقيقي</span>';
    if (e === 'code') return '<span class="pill warning">استدلال من الشيفرة</span>';
    return '<span class="pill info">مصرَّح به في السجل فقط</span>';
  }

  /* ---------------- التهيئة ---------------- */
  document.addEventListener('DOMContentLoaded', () => {
    $('rm-search')?.addEventListener('input', renderReportsManager);
    $('rm-source')?.addEventListener('change', renderReportsManager);
    $('rm-sort')?.addEventListener('change', renderReportsManager);
    $('rp-app-search')?.addEventListener('input', renderAppReports);
    $('rp-app-source')?.addEventListener('change', renderAppReports);
    document.querySelectorAll('#rp-app-groups [data-pf-group]').forEach(b => {
      b.addEventListener('click', () => {
        appGroup = b.getAttribute('data-pf-group') || '';
        document.querySelectorAll('#rp-app-groups [data-pf-group]').forEach(x => {
          x.classList.toggle('active', x === b);
        });
        renderAppReports();
      });
    });
  });

  /* شريط الحالة: يُحدَّث من PlatformShell */
  window.WorkCenter = {
    loadStatus, buildWorkCenterLegacy, loadReportsManager, loadAppReports,
    traceAppReport, openAppReport, renderReportsManager,
  };
  /* توافق مع الواجهات القديمة */
  window.loadWorkCenterTab = function () { return loadStatus().catch(() => {}); };
  window.loadReportsManagerTab = function () { return loadReportsManager(); };
  window.loadAppReportsTab = function () { return loadAppReports(); };
  /* توافق قديم: كانت الدالتان معروضتين مباشرة على window قبل التغليف */
  window.buildWorkCenterLegacy = buildWorkCenterLegacy;
  window.isMissingRoute = isMissingRoute;
})();
