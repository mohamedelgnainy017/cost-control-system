/* ============================================================
 * البيانات والعلاقات · المعادلات والتحليل — واجهة الاستكشاف
 * ============================================================
 * الشاشة ١ «البيانات والعلاقات»:
 *   المصادر والجداول (مع طبيعة البيانات) · العلاقات (مخطط تفاعلي) · الشاشات والتقارير
 * الشاشة ٢ «المعادلات والتحليل»:
 *   قاموس المعادلات الموثَّق · المعادلات المحفوظة
 *
 * البيانات من: /api/catalog · /api/model/formulas · /api/model/relations
 *              · /api/screens · /api/formulas/saved · /api/workflows/outputs
 * لا بيانات اصطناعية: أي قائمة فارغة تُعرض بحالة فارغة صريحة.
 */
(function () {
  const apiCall = (typeof api === 'function') ? api : (async (u, o) => {
    const r = await fetch(u, o); const j = await r.json();
    if (!r.ok || !j.ok) throw new Error((j && (j.message || j.error)) || r.statusText);
    return (j && j.data) ? j.data : j;
  });
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  let sources = [], formulas = [], relations = [], screens = [], reports = [];
  let savedFormulas = [];        /* المعادلات التي حفظها المستخدم (سجل مشترك) */
  let runtimeCols = new Map();   /* runId ⇒ {col, formulaId, formulaName, version} */
  let domain = '', status = '', query = '', nature = '';
  let fmlQuery = '', fmlStatus = '';

  const STATUS_CLS = {
    'منفّذ': 'ok', 'موثق فقط': 'warn', 'غير متاح': 'err', 'يحتاج تحقق': 'warn',
    'مطابق منطقيًا': 'ok', 'جزئي': 'warn', 'مختلف': 'err', 'غير منفَّذ': 'err', 'غير متحقق رقميًا': 'info',
    'متحقق باختبارات اصطناعية': 'ok', 'متحقق رقميًا': 'ok',
  };
  function pill(s) {
    const c = STATUS_CLS[s] ? ' ' + STATUS_CLS[s] : '';
    return '<span class="pill' + c + '">' + esc(s || '—') + '</span>';
  }
  const match = (...parts) => {
    if (!query) return true;
    return parts.filter(Boolean).join(' ').toLowerCase().includes(query);
  };
  const matchF = (...parts) => {
    if (!fmlQuery) return true;
    return parts.filter(Boolean).join(' ').toLowerCase().includes(fmlQuery);
  };

  /* ---------- طبيعة البيانات: فعلية · اختبار · تعريف موثّق ---------- */
  const NATURES = [
    { id: 'actual', label: 'بيانات فعلية' },
    { id: 'test', label: 'بيانات اختبار' },
    { id: 'declared', label: 'تعريف موثّق (غير منفَّذ)' },
  ];
  function natureOf(s) {
    if (!s) return { id: 'declared', label: 'غير معروف', cls: '' };
    if (s.id === 'synthetic' || /synthetic|اختباري/i.test(String(s.technical || ''))) {
      return { id: 'test', label: 'بيانات اختبار', cls: 'info' };
    }
    if (s.status === 'منفّذ') return { id: 'actual', label: 'بيانات فعلية', cls: 'ok' };
    return { id: 'declared', label: 'تعريف موثّق (غير منفَّذ)', cls: 'warning' };
  }

  async function loadAll() {
    const msgs = ['an-msg', 'wf-msg'].map($).filter(Boolean);
    msgs.forEach(m => { m.textContent = 'جارٍ التحميل…'; });
    try {
      const [cat, mod, rel, scr, saved, outs] = await Promise.all([
        apiCall('/api/catalog'),
        apiCall('/api/model/formulas'),
        apiCall('/api/model/relations'),
        apiCall('/api/screens'),
        apiCall('/api/formulas/saved').catch(() => ({ items: [] })),
        apiCall('/api/workflows/outputs').catch(() => ({ items: [] })),
      ]);
      sources = cat.sources || [];
      formulas = mod.items || [];
      relations = rel.items || [];
      screens = scr.screens || [];
      reports = scr.reports || [];
      savedFormulas = saved.items || [];
      /* الأعمدة المحسوبة أثناء التشغيل: من مخرجات التشغيل المحفوظة (مرجع معادلة + نسخة) */
      runtimeCols = new Map();
      for (const o of (outs.items || [])) {
        const cols = o.formulaColumns || {};
        for (const fid of Object.keys(cols)) {
          const c = cols[fid];
          if (!c) continue;
          const name = (typeof c === 'object') ? (c.column || c.name) : c;
          const meta = (typeof c === 'object') ? c : {};
          runtimeCols.set(name, {
            runId: o.runId || '',
            formulaId: fid,
            formulaName: meta.formulaName || meta.name || fid,
            version: meta.version === undefined ? null : meta.version,
          });
        }
      }
      fillSelects(cat);
      renderAll();
      /* فهرس العلاقات (تشغيلات/تقارير/شاشات) — يُحمَّل مرة واحدة ويُحدِّث الجداول */
      if (window.Workspace && typeof window.Workspace.loadIndex === 'function') {
        window.Workspace.loadIndex().then(() => { renderAll(); }).catch(() => {});
      }
      if (msgs.length) {
        msgs.forEach(m => {
          m.textContent = sources.length + ' مصدر · ' + formulas.length + ' معادلة · '
            + relations.length + ' علاقة · ' + screens.length + ' شاشة · ' + reports.length + ' تقرير';
        });
      }
    } catch (e) {
      msgs.forEach(m => { m.textContent = 'تعذّر التحميل: ' + e.message; });
    }
  }

  function fillSelects(cat) {
    const dom = $('an-domain');
    if (dom) {
      const cur = dom.value;
      dom.innerHTML = '<option value="">كل المجالات</option>';
      const seen = new Set();
      for (const s of sources) if (s.domain) seen.add(s.domain);
      for (const d of seen) {
        const o = document.createElement('option'); o.value = d; o.textContent = d; dom.appendChild(o);
      }
      dom.value = cur;
    }
    const st = $('an-status');
    if (st) {
      const cur = st.value;
      st.innerHTML = '<option value="">كل الحالات</option>';
      for (const s of Object.keys(STATUS_CLS)) {
        const o = document.createElement('option'); o.value = s; o.textContent = s; st.appendChild(o);
      }
      st.value = cur;
    }
    const nat = $('an-nature');
    if (nat) {
      const cur = nat.value;
      nat.innerHTML = '<option value="">كل طبيعة البيانات</option>';
      for (const n of NATURES) {
        const o = document.createElement('option'); o.value = n.id; o.textContent = n.label; nat.appendChild(o);
      }
      nat.value = cur;
    }
    const fst = $('fml-status');
    if (fst) {
      const cur = fst.value;
      fst.innerHTML = '<option value="">كل الحالات</option>';
      for (const s of Object.keys(STATUS_CLS)) {
        const o = document.createElement('option'); o.value = s; o.textContent = s; fst.appendChild(o);
      }
      fst.value = cur;
    }
  }

  /* ---------------- الرسم ---------------- */
  function renderAll() {
    renderSources();
    renderRelations();
    renderScreens();
    renderFormulas();
    renderSavedFormulas();
  }
  function renderPanel(name) {
    if (name === 'sources') renderSources();
    else if (name === 'relations') renderRelations();
    else if (name === 'screens') renderScreens();
    else if (name === 'formulas') { renderFormulas(); renderSavedFormulas(); }
  }

  /* ---------------- ١) المصادر والجداول ---------------- */
  function renderSources() {
    const host = $('an-sources'); if (!host) return;
    const rows = sources.filter(s => (!domain || s.domain === domain) && (!status || s.status === status)
      && (!nature || natureOf(s).id === nature)
      && match(s.id, s.label, s.description, s.grain, s.technical, fieldNamesOf(s).join(' ')));
    if (!rows.length) { host.innerHTML = '<div class="hint">لا مصادر مطابقة</div>'; return; }
    const byDomain = {};
    for (const s of rows) (byDomain[s.domain || 'أخرى'] = byDomain[s.domain || 'أخرى'] || []).push(s);
    let html = '';
    for (const dm of Object.keys(byDomain)) {
      html += '<h4 class="an-dom">' + esc(dm) + ' <span class="muted xs">(' + byDomain[dm].length + ')</span></h4>';
      html += '<div class="an-grid">';
      for (const s of byDomain[dm]) {
        const nat = natureOf(s);
        html += '<div class="an-card' + (s.canonical ? ' canonical' : '') + '">';
        html += '<div class="an-h"><b>' + esc(s.label) + '</b>' + pill(s.status)
          + '<span class="pill ' + nat.cls + '">' + esc(nat.label) + '</span>'
          + (s.canonical ? '<span class="pill ok">★ مرجع</span>' : '') + '</div>';
        html += '<div class="muted xs">' + esc(s.id) + ' · ' + esc(s.technical) + '</div>';
        html += '<div class="an-desc">' + esc(s.description || '') + '</div>';
        html += '<div class="an-meta"><span>المستوى: ' + esc(s.grain || '—') + '</span>';
        html += '<span>المفتاح: ' + esc((s.rowKey || []).join(' + ') || '—') + '</span>';
        html += '<span>الزمن: ' + esc(s.timeGrain || '—') + '</span>';
        html += '<span>الحقول: ' + (s.fieldCount || (s.fields || []).length) + '</span></div>';
        if (s.canonicalNote) html += '<div class="an-note">' + esc(s.canonicalNote) + '</div>';
        if (s.canonicalFor) html += '<div class="an-meta"><span>المرجع المعتمد لـ: ' + esc(s.canonicalFor) + '</span></div>';
        html += sourceColumnsBlock(s);
        html += '</div>';
      }
      html += '</div>';
    }
    host.innerHTML = html;
    wireDetailButtons();
  }

  /** أسماء أعمدة المصدر (تُستعمل في البحث) */
  function fieldNamesOf(s) {
    return (Array.isArray(s && s.fields) ? s.fields : []).map(f => (f && f.name) || '');
  }

  /** تصنيف عمود: أصلي · مشتق موثق · محسوب أثناء التشغيل · غير معروف */
  function columnKind(s, f) {
    if (f && f.origin === 'source') return { k: 'أصلي (من المصدر)', cls: 'ok' };
    if (f && f.origin === 'derived') {
      return f.formula
        ? { k: 'مشتق موثق', cls: 'warning' }
        : { k: 'مشتق — المنطق داخل الاستعلام', cls: 'warning' };
    }
    if (runtimeCols.has(f.name)) return { k: 'محسوب أثناء التشغيل', cls: 'ok' };
    return { k: 'غير معروف', cls: '' };
  }

  /** كتلة أعمدة المصدر (قابلة للطي) — لا تُختصر في عدد */
  function sourceColumnsBlock(s) {
    const fields = Array.isArray(s.fields) ? s.fields : [];
    if (!fields.length) {
      return '<details class="an-cols"><summary>تفاصيل الأعمدة: غير متاحة لهذا المصدر</summary>'
        + '<div class="hint">لا يوجد تعريف أعمدة موثَّق لهذا المصدر في الفهرس.</div></details>';
    }
    const derived = fields.filter(f => f.origin === 'derived').length;
    let rows = '';
    for (const f of fields) {
      const kind = columnKind(s, f);
      const rt = runtimeCols.get(f.name);
      let origin = '';
      if (rt) origin = 'محسوب في التشغيل ' + (rt.runId || '') + ' — المعادلة: ' + rt.formulaName
        + (rt.version === null || rt.version === undefined ? '' : ' (نسخة ' + rt.version + ')');
      else if (f.formula) origin = 'المعادلة الموثّقة: ' + f.formula;
      else if (f.origin === 'derived') origin = 'المنطق داخل استعلام التطبيق — لا توجد صيغة نصية قابلة للتنفيذ';
      else origin = 'قيمة من المصدر';
      rows += '<tr><td><b>' + esc(f.name) + '</b></td>'
        + '<td class="muted xs">' + esc(f.type || '—') + '</td>'
        + '<td><span class="pill ' + kind.cls + '">' + esc(kind.k) + '</span></td>'
        + '<td class="muted xs">' + esc(f.description || '') + '</td>'
        + '<td class="muted xs">' + esc(origin) + '</td>'
        + '<td><button type="button" class="btn xs ghost" data-col-detail="' + esc(f.name) + '" data-src="' + esc(s.id) + '">تفاصيل</button></td></tr>';
    }
    return '<details class="an-cols"><summary>الأعمدة (' + fields.length + ' — ' + derived + ' مشتق موثَّق)</summary>'
      + '<table class="an-table"><thead><tr><th>العمود</th><th>النوع</th><th>التصنيف</th><th>الوصف</th><th>الأصل / المعادلة</th><th></th></tr></thead><tbody>'
      + rows + '</tbody></table>'
      + '<div class="hint">«صيغة موثّقة» تعني نصًّا مرجعيًّا من الفهرس — لا يعني بالضرورة دالة قابلة للتنفيذ في محرّك المعادلات. '
      + 'زر «تفاصيل» يعرض نوع العمود وأصله والاستخدام الفعلي في النظام.</div>'
      + '</details>';
  }

  /* ---------------- ٢) العلاقات (مخطط تفاعلي + جدول) ---------------- */
  function renderRelations() {
    const host = $('an-relations'); if (!host) return;
    const rows = relations.filter(r => {
      const src = sources.find(s => s.id === r.from);
      return (!domain || (src && src.domain === domain))
        && match(r.from, r.to, r.leftKey, r.rightKey, r.note);
    });
    if (!rows.length) { host.innerHTML = '<div class="hint">لا علاقات مطابقة</div>'; return; }
    const labels = {};
    for (const s of sources) labels[s.id] = s.label || s.id;
    let html = '<div class="rel-host" id="an-graph"></div>';
    html += '<table class="an-table"><thead><tr><th>من</th><th>إلى</th><th>المفتاح</th><th>الاتجاه</th>'
      + '<th>الثقة</th><th>الملاحظة</th></tr></thead><tbody>';
    for (const r of rows) {
      html += '<tr><td>' + esc(r.fromLabel || r.from) + '</td><td>' + esc(r.toLabel || r.to) + '</td>';
      html += '<td class="muted xs">' + esc(r.leftKey) + ' → ' + esc(r.rightKey) + '</td>';
      html += '<td>' + esc(r.direction) + '</td>';
      html += '<td>' + (r.confidence === 'confirmed' ? '<span class="pill ok">مؤكد</span>' : '<span class="pill warning">مقترح</span>') + '</td>';
      html += '<td class="muted xs">' + esc(r.note || '') + '</td></tr>';
    }
    html += '</tbody></table>';
    host.innerHTML = html;
    /* المخطط التفاعلي — يُبنى من نفس البيانات */
    const graphHost = $('an-graph');
    if (graphHost && window.RelationsGraph) {
      window.RelationsGraph.render(graphHost, rows, { labels });
    } else if (graphHost) {
      graphHost.innerHTML = '<div class="hint">مخطط العلاقات غير محمّل.</div>';
    }
  }

  /* ---------------- ٣) الشاشات والتقارير ---------------- */
  function renderScreens() {
    const host = $('an-screens'); if (!host) return;
    const srows = screens.filter(s => (!domain || (s.sources || []).some(x => x.domain === domain))
      && match(s.id, s.label, (s.measures || []).join(' '), (s.sources || []).map(x => x.label).join(' ')));
    let html = '<h4 class="an-dom">الشاشات</h4>';
    html += '<table class="an-table"><thead><tr><th>الشاشة</th><th>المصدر</th><th>المقاييس</th>'
      + '<th>إعادة الاستخدام</th><th></th></tr></thead><tbody>';
    for (const s of srows) {
      const merged = s.mergedInto ? '<div class="muted xs">دُمجت داخل: ' + esc(s.mergedInto) + '</div>' : '';
      html += '<tr><td><b>' + esc(s.label) + '</b><div class="muted xs">' + esc(s.id) + '</div>' + merged + '</td>';
      html += '<td>' + (s.sources || []).map(x => esc(x.label || x.id) + (x.canonical ? ' ★' : '')).join('<br>') + '</td>';
      html += '<td class="muted xs">' + esc((s.measures || []).join(' · ') || '—') + '</td>';
      html += '<td>' + reusePill(s.reuse) + '</td>';
      html += '<td>' + (s.sources || []).map(x => x.id).filter(Boolean).map(sid =>
        '<button type="button" class="btn xs ghost" data-open-source="' + esc(sid) + '">تحليل</button>').join(' ') + '</td></tr>';
    }
    html += '</tbody></table>';
    html += '<h4 class="an-dom">التقارير</h4>';
    html += '<table class="an-table"><thead><tr><th>التقرير</th><th>المصدر</th><th>الحقول</th>'
      + '<th>إعادة الاستخدام</th><th></th><th></th></tr></thead><tbody>';
    for (const r of reports) {
      if (!match(r.key, r.label, r.source)) continue;
      html += '<tr><td><b>' + esc(r.label) + '</b><div class="muted xs">' + esc(r.key)
        + (r.hidden ? ' (خام/تصدير)' : '') + '</div></td>';
      html += '<td>' + esc(r.source || '—') + '</td>';
      html += '<td class="muted xs">' + esc((r.fields || []).join(' · ')) + '</td>';
      html += '<td>' + reusePill(r.reuse) + '</td>';
      html += '<td class="muted xs">' + esc(reportGaps(r)) + '</td>';
      html += '<td><button type="button" class="btn xs ghost" data-open-report="' + esc(r.key) + '">فتح في شاشة التقارير</button>'
        + '<button type="button" class="btn xs ghost" data-import-report="' + esc(r.key) + '">استيراد في المصمم</button></td></tr>';
    }
    html += '</tbody></table>';
    /* جدولان جديدان: التصاميم المحفوظة والشاشات المخصّصة (روابط فعلية) */
    const idx = window.Workspace ? window.Workspace.getIndex() : null;
    if (idx) {
      const savedReps = (idx.reports || []).filter(r => match(r.name, r.id, r.runId));
      html += '<h4 class="an-dom">تصاميم التقارير المحفوظة</h4>';
      if (!savedReps.length) {
        html += '<div class="hint">لا تصاميم محفوظة — تُنشأ من «التقارير» ← «المصمّم».</div>';
      } else {
        html += '<table class="an-table"><thead><tr><th>التقرير</th><th>معرّف التشغيل</th><th>التاريخ</th><th></th></tr></thead><tbody>';
        for (const r of savedReps) {
          html += '<tr><td><b>' + esc(r.name || r.id) + '</b><div class="muted xs">' + esc(r.id) + '</div></td>'
            + '<td class="muted xs">' + esc(r.runId || '—') + '</td>'
            + '<td class="muted xs">' + esc(r.savedAt || '—') + '</td>'
            + '<td><button type="button" class="btn xs ghost" data-open-saved-report="' + esc(r.id) + '">فتح في المصمم</button></td></tr>';
        }
        html += '</tbody></table>';
      }
      const customScreens = (idx.screens || []).filter(s => match(s.name, s.id, s.runId));
      html += '<h4 class="an-dom">الشاشات المخصّصة</h4>';
      if (!customScreens.length) {
        html += '<div class="hint">لا شاشات مخصّصة — تُنشأ من «الشاشات والتحكم».</div>';
      } else {
        html += '<table class="an-table"><thead><tr><th>الشاشة</th><th>المصدر</th><th>المكوّنات</th><th></th></tr></thead><tbody>';
        for (const s of customScreens) {
          html += '<tr><td><b>' + esc(s.name || s.id) + '</b><div class="muted xs">' + esc(s.id) + '</div></td>'
            + '<td class="muted xs">' + esc(s.runId || '—') + '</td>'
            + '<td class="muted xs">' + esc(String(s.components || 0)) + '</td>'
            + '<td><button type="button" class="btn xs ghost" data-open-custom-screen="' + esc(s.id) + '">فتح</button></td></tr>';
        }
        html += '</tbody></table>';
      }
    }
    host.innerHTML = html;
    /* ربط الأزرار بمكوّناتها القائمة */
    host.querySelectorAll('[data-open-source]').forEach(b => b.addEventListener('click', () => {
      const sid = b.getAttribute('data-open-source');
      if (typeof window.openWorkflowForSource === 'function') window.openWorkflowForSource(sid);
      else toast('استوديو التحليل غير متاح في هذه النسخة');
    }));
    host.querySelectorAll('[data-open-report]').forEach(b => b.addEventListener('click', () => {
      const key = b.getAttribute('data-open-report');
      if (window.PlatformShell) {
        window.PlatformShell.show('report-studio', 'app');
        if (typeof window.goTab === 'function') window.goTab('report-studio');
      }
      if (typeof window.focusAppReport === 'function') window.focusAppReport(key);
    }));
    host.querySelectorAll('[data-import-report]').forEach(b => b.addEventListener('click', () => {
      const key = b.getAttribute('data-import-report');
      if (typeof window.openLegacyImport === 'function') window.openLegacyImport(key);
      else toast('المصمم غير متاح في هذه النسخة');
    }));
    host.querySelectorAll('[data-open-saved-report]').forEach(b => b.addEventListener('click', () => {
      const id = b.getAttribute('data-open-saved-report');
      if (window.Workspace) window.Workspace.go('report-studio', { reportId: id, openReportId: id });
      else if (typeof window.loadReportIntoDesigner === 'function') window.loadReportIntoDesigner(id);
    }));
    host.querySelectorAll('[data-open-custom-screen]').forEach(b => b.addEventListener('click', () => {
      const id = b.getAttribute('data-open-custom-screen');
      if (window.Workspace) window.Workspace.go('screen-studio', { screenId: id });
    }));
  }

  /** ما هو معروف عن تقرير قديم وما هو ناقص فيه */
  function reportGaps(r) {
    const gaps = [];
    if (!r.source) gaps.push('المصدر غير مصرَّح به');
    if (!r.fields || !r.fields.length) gaps.push('الحقول غير مصرَّح بها');
    if (r.reuse === 'view-only') gaps.push('عرض فقط — بلا كود تنفيذ');
    gaps.push('الأعمدة الفعلية تتطلب تشغيل التقرير (قراءة بيانات)');
    const src = r.source ? sources.find(s => s.id === r.source) : null;
    if (src && src.status !== 'منفّذ') gaps.push('المصدر موثّق فقط (بلا مسار قراءة في محرك التدفقات)');
    return gaps.join(' · ');
  }

  function reusePill(reuse) {
    if (reuse === 'catalog') return '<span class="pill ok">مصدر في الفهرس</span>';
    if (reuse === 'composite') return '<span class="pill warning">تجميعي</span>';
    return '<span class="pill info">عرض فقط</span>';
  }

  /* ---------------- ٤) المعادلات (الشاشة الثانية) ---------------- */
  function formulaState(f) {
    if (f.numericVerified) return { t: 'موثّقة ومختبرة', cls: 'ok' };
    if (f.status === 'مطابق منطقيًا') return { t: 'موثّقة وقابلة للتنفيذ', cls: 'ok' };
    if (f.status === 'جزئي') return { t: 'موثّقة (تنفيذ جزئي)', cls: 'warning' };
    if (f.status === 'مختلف') return { t: 'موثّقة (اختلاف دلالي)', cls: 'warning' };
    if (f.status === 'غير منفَّذ') return { t: 'مرجع فقط — غير منفَّذة', cls: 'warning' };
    if (f.status === 'موثق فقط' || f.status === 'غير متاح') return { t: 'غير متاحة في التطبيق', cls: 'info' };
    return { t: f.status || 'غير معروفة', cls: '' };
  }

  function renderFormulas() {
    const host = $('an-formulas'); if (!host) return;
    const rows = formulas.filter(f => (!domain || f.domain === domain) && (!fmlStatus || f.status === fmlStatus)
      && matchF(f.name, f.table, f.counterpart, f.location, f.dax, f.logic));
    let html = '<h4 class="an-dom">قاموس المعادلات الموثَّق <span class="muted xs">(' + rows.length + ')</span></h4>';
    if (!rows.length) { html += '<div class="hint">لا معادلات مطابقة</div>'; }
    else {
      html += '<table class="an-table"><thead><tr><th>الاسم</th><th>النوع</th><th>المجال</th><th>الحالة</th>'
        + '<th>المقابل في الكود</th><th>الموضع</th><th>المعادلة</th></tr></thead><tbody>';
      for (const f of rows) {
        html += '<tr><td><b>' + esc(f.name) + '</b>'
          + (f.table ? '<div class="muted xs">' + esc(f.table) + '</div>' : '') + '</td>';
        html += '<td>' + esc(f.kind) + '</td><td>' + esc(f.domain) + '</td>';
        html += '<td><span class="pill ' + formulaState(f).cls + '">' + esc(formulaState(f).t) + '</span></td>';
        html += '<td>' + pill(f.status) + (f.numericVerified ? '' : '<div class="muted xs">لم يُقاس رقمياً</div>') + '</td>';
        html += '<td>' + esc(f.counterpart || '—') + '</td>';
        html += '<td class="muted xs">' + esc(f.location || '—') + '</td>';
        html += '<td><details><summary>عرض</summary><pre class="an-code">' + esc(f.dax || f.logic || '') + '</pre>'
          + (f.note ? '<div class="an-note">' + esc(f.note) + '</div>' : '') + '</details>'
          + '<button type="button" class="btn xs ghost" data-fml-detail="' + esc(f.id) + '">تفاصيل</button></td></tr>';
      }
      html += '</tbody></table>';
    }
    host.innerHTML = html;
    wireDetailButtons();
  }

  /** المعادلات المحفوظة (أنشأها المستخدم) — محرّر فعلي + قائمة */
  function renderSavedFormulas() {
    const host = $('an-savedFormulas'); if (!host) return;
    if (window.FormulaEditor && typeof window.FormulaEditor.mount === 'function') {
      const h = document.createElement('div');
      h.id = 'fml-editor-host';
      host.innerHTML = '';
      host.appendChild(h);
      try {
        window.FormulaEditor.mount(h, { onSaved: () => { try { renderSavedFormulas(); } catch (_) {} } });
      } catch (e) {
        host.innerHTML = '<div class="muted">تعذّر تحميل محرّر المعادلات</div>';
      }
      return;
    }
    let html = '<h4 class="an-dom">المعادلات المحفوظة <span class="muted xs">(' + savedFormulas.length + ')</span></h4>';
    if (!savedFormulas.length) {
      html += '<div class="hint">لا توجد معادلات محفوظة بعد.</div>';
    } else {
      html += '<table class="an-table"><thead><tr><th>الاسم</th><th>الحقول</th><th>التعبير</th><th>النسخة</th><th>الأصل</th></tr></thead><tbody>';
      for (const f of savedFormulas) {
        const fields = (f.fields || []).map(x => x.name).join(' · ') || '—';
        html += '<tr><td><b>' + esc(f.name || f.id) + '</b><div class="muted xs">' + esc(f.id || '') + '</div></td>'
          + '<td class="muted xs">' + esc(fields) + '</td>'
          + '<td class="muted xs"><code>' + esc(f.expr || '') + '</code></td>'
          + '<td class="muted xs">' + esc(String(f.version === undefined ? '' : f.version)) + '</td>'
          + '<td class="muted xs">' + esc(f.origin === 'visual' ? 'بصري' : (f.origin || '—')) + '</td></tr>';
      }
      html += '</tbody></table>';
    }
    host.innerHTML = html;
  }

  /* ---------------- لوحة التفاصيل (عمود/معادلة) ---------------- */
  function detailHost(kind) { return $(kind === 'formula' ? 'an-fml-detail' : 'an-detail'); }

  function closeDetail(kind) {
    const host = detailHost(kind);
    if (!host) return;
    host.hidden = true; host.innerHTML = '';
  }

  /** تفاصيل عمود: النوع · الوصف · الأصل · المعادلة · الاستخدام الفعلي */
  async function showColumnDetail(sourceId, fieldName) {
    const host = detailHost('column');
    if (!host) return;
    const src = sources.find(s => s.id === sourceId);
    const f = (src && Array.isArray(src.fields) ? src.fields : []).find(x => x.name === fieldName);
    if (!f) { toast('العمود غير موجود في الفهرس'); return; }
    const kind = columnKind(src, f);
    const rt = runtimeCols.get(f.name);
    host.hidden = false;
    host.innerHTML = '<div class="ws-detail-h"><b>عمود: ' + esc(f.name) + '</b>'
      + '<span class="muted xs">' + esc(src.label || sourceId) + ' · ' + esc(src.technical || '') + '</span>'
      + '<button type="button" class="btn xs ghost" id="an-detail-close">إغلاق</button></div>'
      + '<div class="ws-detail-g"><div class="ws-kv"><span>النوع</span><b>' + esc(f.type || '—') + '</b></div>'
      + '<div class="ws-kv"><span>التصنيف</span><b>' + esc(kind.k) + '</b></div>'
      + '<div class="ws-kv"><span>الوصف</span><b>' + esc(f.description || '—') + '</b></div>'
      + '<div class="ws-kv"><span>المستوى</span><b>' + esc(src.grain || '—') + '</b></div>'
      + '<div class="ws-kv"><span>طبيعة البيانات</span><b>' + esc(natureOf(src).label) + '</b></div></div>'
      + '<div class="ws-detail-sec">صيغة/منشأ العمود</div>'
      + '<pre class="an-code">' + esc(f.formula || (rt ? ('محسب أثناء التشغيل — المعادلة: ' + rt.formulaName + (rt.version === null ? '' : ' (نسخة ' + rt.version + ')')) : (f.origin === 'derived' ? 'المنطق داخل استعلام التطبيق — لا توجد صيغة نصية قابلة للتنفيذ' : 'قيمة من المصدر'))) + '</pre>'
      + '<div class="ws-detail-sec">الاستخدام الفعلي (من بيانات النظام)</div>'
      + '<div class="ws-usage-box" id="an-col-usage"><div class="hint">جارٍ الفحص…</div></div>';
    $('an-detail-close')?.addEventListener('click', () => closeDetail('column'));

    const box = $('an-col-usage');
    try {
      const idx = await (window.Workspace ? window.Workspace.loadIndex() : Promise.resolve(null));
      const links = window.WorkspaceLinks;
      if (!idx || !links) { box.innerHTML = '<div class="hint">تعذّر تحميل فهرس العلاقات.</div>'; return; }
      const usage = links.columnUsage(idx, f.name);
      box.innerHTML = window.Workspace.usageHtml(usage, { empty: 'لا تشغيلات محفوظة تستخدم هذا العمود حتى الآن.' });
      window.Workspace.wireUsage(box);
    } catch (e) {
      box.innerHTML = '<div class="hint">تعذّر الفحص: ' + esc(e.message) + '</div>';
    }
    host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /** تفاصيل معادلة: النص · المصدر · الحالة · التحقق · الاستخدام */
  async function showFormulaDetail(formulaId) {
    const host = detailHost('formula');
    if (!host) return;
    const f = formulas.find(x => x.id === formulaId);
    if (!f) { toast('المعادلة غير موجودة'); return; }
    const st = formulaState(f);
    host.hidden = false;
    host.innerHTML = '<div class="ws-detail-h"><b>معادلة: ' + esc(f.name) + '</b>'
      + '<span class="muted xs">' + esc(f.kind || '') + (f.table ? ' · ' + esc(f.table) : '') + '</span>'
      + '<button type="button" class="btn xs ghost" id="an-fml-detail-close">إغلاق</button></div>'
      + '<div class="ws-detail-g"><div class="ws-kv"><span>الحالة</span><b><span class="pill ' + st.cls + '">' + esc(st.t) + '</span></b></div>'
      + '<div class="ws-kv"><span>المقابل في الكود</span><b>' + esc(f.counterpart || '—') + '</b></div>'
      + '<div class="ws-kv"><span>الموضع</span><b>' + esc(f.location || '—') + '</b></div>'
      + '<div class="ws-kv"><span>تحقّق رقمي</span><b>' + (f.numericVerified ? 'متحقّق رقميًا' : 'لم يُتحقَّق رقميًا') + '</b></div></div>'
      + '<div class="ws-detail-sec">نص المعادلة</div>'
      + '<pre class="an-code">' + esc(f.dax || f.logic || '—') + '</pre>'
      + (f.note ? '<div class="an-note">' + esc(f.note) + '</div>' : '')
      + '<div class="ws-detail-sec">الاستخدام الفعلي (من بيانات النظام)</div>'
      + '<div class="ws-usage-box" id="an-fml-usage"><div class="hint">جارٍ الفحص…</div></div>';
    $('an-fml-detail-close')?.addEventListener('click', () => closeDetail('formula'));

    const box = $('an-fml-usage');
    try {
      const idx = await (window.Workspace ? window.Workspace.loadIndex() : Promise.resolve(null));
      const links = window.WorkspaceLinks;
      if (!idx || !links) { box.innerHTML = '<div class="hint">تعذّر تحميل فهرس العلاقات.</div>'; return; }
      const usage = links.formulaUsage(idx, f.id);
      box.innerHTML = window.Workspace.usageHtml(usage, { empty: 'لم تُطبَّق هذه المعادلة في أي تشغيل محفوظ — لا يمكن إثبات استخدامها بعد.' });
      window.Workspace.wireUsage(box);
    } catch (e) {
      box.innerHTML = '<div class="hint">تعذّر الفحص: ' + esc(e.message) + '</div>';
    }
    host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* أزرار التفاصيل (عمود/معادلة) — تُربط بعد كل رسم */
  function wireDetailButtons() {
    document.querySelectorAll('[data-col-detail]').forEach(b => b.addEventListener('click', () => {
      showColumnDetail(b.getAttribute('data-src'), b.getAttribute('data-col-detail'));
    }));
    document.querySelectorAll('[data-fml-detail]').forEach(b => b.addEventListener('click', () => {
      showFormulaDetail(b.getAttribute('data-fml-detail'));
    }));
  }

  /* فتح التفاصيل من شاشة أخرى (سياق مشترك) */
  window.focusExplorerFormula = function (id) {
    if (window.PlatformShell) window.PlatformShell.show('analysis', 'formulas');
    renderFormulas();
    showFormulaDetail(id);
  };
  window.focusExplorerColumn = function (name, sourceId) {
    if (window.PlatformShell) window.PlatformShell.show('analysis', 'sources');
    renderSources();
    if (sourceId) showColumnDetail(sourceId, name);
  };

  /* ---------------- التهيئة ---------------- */
  function init() {
    const s = $('an-search');
    if (s) s.addEventListener('input', () => { query = (s.value || '').trim().toLowerCase(); renderSources(); renderRelations(); renderScreens(); });
    const d = $('an-domain');
    if (d) d.addEventListener('change', () => { domain = d.value; renderSources(); renderRelations(); renderScreens(); renderFormulas(); });
    const st = $('an-status');
    if (st) st.addEventListener('change', () => { status = st.value; renderSources(); });
    const nat = $('an-nature');
    if (nat) nat.addEventListener('change', () => { nature = nat.value; renderSources(); });
    const fs2 = $('fml-search');
    if (fs2) fs2.addEventListener('input', () => { fmlQuery = (fs2.value || '').trim().toLowerCase(); renderFormulas(); });
    const fst = $('fml-status');
    if (fst) fst.addEventListener('change', () => { fmlStatus = fst.value; renderFormulas(); });
    const r = $('an-refresh');
    if (r) r.addEventListener('click', loadAll);
    /* تبويبا لوحة المعادلات: القاموس الموثَّق ↔ المعادلات المحفوظة (كلاهما موجود دومًا) */
    const fTabs = Array.prototype.slice.call(document.querySelectorAll('#fml-subtabs [data-an]'));
    fTabs.forEach(b => b.addEventListener('click', () => {
      const which = b.getAttribute('data-an');
      fTabs.forEach(x => {
        const on = x === b;
        x.classList.toggle('active', on);
        x.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      const doc = $('an-formulas'), saved = $('an-savedFormulas');
      if (doc) doc.hidden = which !== 'formulas';
      if (saved) saved.hidden = which !== 'savedFormulas';
      if (which === 'savedFormulas') renderSavedFormulas();
      if (which === 'formulas') renderFormulas();
    }));
    /* خطّافات اللوحات */
    if (window.PlatformShell) {
      window.PlatformShell.onPanel('analysis', (p) => renderPanel(p));
    }
    loadAll();
  }

  window.loadAnalysisTab = function () { loadAll(); };
  window.loadAnalysisData = loadAll;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
