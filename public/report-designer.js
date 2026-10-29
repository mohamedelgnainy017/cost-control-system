/* ============================================================
 * مصمم التقارير واللوحات المرئي (Report Designer)
 * ============================================================
 * لوحة تصميم حقيقية: عناصر على شبكة 12 عمود · سحب لإعادة الترتيب ·
 * مقبض لتغيير العرض · لوحة خصائص (بيانات / تخطيط / نمط / شروط) ·
 * معاينة حيّة من محرك Python · حفظ وإعادة فتح بنفس التصميم.
 *
 * النموذج (مصدر · تحليل · تخطيط · نمط · شروط) معرَّف في src/report-schema.js
 * والمصحَّح من طرف الخادم — ولا يُنفَّذ أي كود من داخل المحرر.
 */
(function () {
  'use strict';
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

  const S = window.ReportSchema || null;
  const TYPES = ['kpi', 'table', 'bar', 'line', 'pie', 'heading', 'text', 'divider'];
  const TYPE_LABEL = {
    kpi: 'مؤشر (KPI)', table: 'جدول', bar: 'مخطط أعمدة', line: 'مخطط خطي',
    pie: 'مخطط دائري', heading: 'عنوان', text: 'نص', divider: 'فاصل', shape: 'شكل',
  };
  const AGGS = ['sum', 'avg', 'count', 'min', 'max'];
  const OPS = ['>', '>=', '<', '<=', '==', '!='];
  const ALIGN_OPTS = [['start', 'بداية'], ['center', 'توسيط'], ['end', 'نهاية'], ['justify', 'ضبط']];
  const GRID_COLS = 12;

  let comps = [];
  let columns = [];
  let source = null;
  let selectedId = null;
  let reportId = '';
  let dirty = false;
  let tab = 'data';
  let layout = { columns: GRID_COLS, gap: 12 };
  let dragId = null;
  let rsFormulas = [];
  let rsTrace = null;   /* تتبّع النتيجة: مصدر · فلاتر · بصمة · حالة التعريف */
  let rsFormulaCols = {};      /* أعمدة التشغيل المحسوبة ⇒ {formulaId: column} */
  let rsFormulaVersions = {};  /* نسخة كل معادلة مطبَّقة في التشغيل */
  let legacySource = null;  /* مرجع تقرير قائم من التطبيق (مصدر المعاينة بعد الاستيراد) */
  let legacyNotes = [];     /* ما استُخرج وما لم يُستخرج (تُعرض للمستخدم) */
  let reportFilters = [];    /* فلاتر البيانات على مستوى التقرير (تُطبَّق في المحرك) */
  const FILTER_OPS = ['>', '>=', '<', '<=', '==', '!=', 'contains', 'startsWith', 'in', 'notEmpty', 'empty'];

  /* ---------------- أدوات ---------------- */
  const byId = id => comps.find(c => c.id === id) || null;
  const selected = () => byId(selectedId);
  function setDirty(v) { dirty = !!v; }
  function busy(msg) { const st = $('rs-status'); if (st) st.textContent = msg || ''; }
  function confirmDiscard() {
    if (!dirty) return true;
    return window.confirm('توجد تعديلات غير محفوظة — هل تريد المتابعة وفقدانها؟');
  }
  function uid() {
    let n = 1;
    const has = new Set(comps.map(c => c.id));
    while (has.has('e' + n)) n++;
    return 'e' + n;
  }
  function newComp(type) {
    const c = { id: uid(), type };
    if (type === 'kpi') { c.label = 'مؤشر'; c.column = columns[0] || ''; c.agg = 'sum'; c.grid = { w: 3, h: 1 }; }
    else if (type === 'table') { c.columns = columns.slice(0, 4); c.limit = 20; c.grid = { w: 12, h: 2 }; }
    else if (type === 'bar' || type === 'line') { c.title = 'مخطط'; c.category = columns[0] || ''; c.value = columns[1] || columns[0] || ''; c.agg = 'sum'; c.grid = { w: 6, h: 2 }; }
    else if (type === 'pie') { c.title = 'توزيع'; c.category = columns[0] || ''; c.value = columns[1] || columns[0] || ''; c.agg = 'sum'; c.grid = { w: 4, h: 2 }; }
    else if (type === 'heading' || type === 'text') { c.text = ''; c.grid = { w: 12, h: 1 }; }
    else if (type === 'divider') { c.grid = { w: 12, h: 1 }; }
    else if (type === 'shape') { c.text = ''; c.grid = { w: 12, h: 1 }; }
    c.style = {};
    return c;
  }
  /* ---------------- التراجع والإعادة (حالة حقيقية قابلة للاستعادة) ---------------- */
  const past = [];
  const future = [];
  const MAX_HISTORY = 60;
  let lastState = null;
  function stateSnapshot() { return JSON.stringify({ comps, layout, selectedId }); }
  /* تُستدعى بعد كل تعديل: تحفظ الحالة السابقة (محتوى + تخطيط + تحديد) */
  function trackChange() {
    const s = stateSnapshot();
    if (lastState === null) { lastState = s; updateHistoryUI(); return; }
    if (s === lastState) return;
    past.push(lastState);
    while (past.length > MAX_HISTORY) past.shift();
    future.length = 0;
    lastState = s;
    updateHistoryUI();
  }
  function restoreState(json) {
    let st;
    try { st = JSON.parse(json); } catch (_) { return; }
    comps = Array.isArray(st.comps) ? st.comps : [];
    if (st.layout && typeof st.layout === 'object') layout = st.layout;
    selectedId = st.selectedId || null;
    lastState = stateSnapshot();
    setDirty(true);
    renderCanvas(); renderInspector(); syncJson();
    updateHistoryUI();
  }
  function undo() {
    if (!past.length) { toast('لا يوجد تعديل للتراجع عنه'); return; }
    future.push(stateSnapshot());
    restoreState(past.pop());
    toast('تم التراجع');
  }
  function redo() {
    if (!future.length) { toast('لا يوجد تعديل لإعادته'); return; }
    past.push(stateSnapshot());
    restoreState(future.pop());
    toast('تمت الإعادة');
  }
  function resetHistory() { past.length = 0; future.length = 0; lastState = null; updateHistoryUI(); }
  function updateHistoryUI() {
    const el = $('rs-history-count'); if (el) el.textContent = String(past.length);
    const ub = $('rs-undo'); if (ub) ub.disabled = past.length === 0;
    const rb = $('rs-redo'); if (rb) rb.disabled = future.length === 0;
  }
  /* ---------------- المعاينة الحيّة (تحديث مجدول بعد كل تعديل) ---------------- */
  let liveOn = false;
  let liveTimer = null;
  function liveLabel() {
    const b = $('rs-live');
    if (b) { b.textContent = 'معاينة حيّة: ' + (liveOn ? 'مُفعّلة' : 'مُعطّلة'); b.setAttribute('aria-pressed', liveOn ? 'true' : 'false'); }
  }
  function scheduleLivePreview() {
    if (!liveOn) return;
    const runId = ($('rs-runid') && $('rs-runid').value.trim()) || '';
    const hasLegacy = !!(legacySource && legacySource.name);
    if (!runId && !hasLegacy) return;   /* بلا مصدر ⇒ لا معاينة (ولا بيانات مفترضة) */
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { liveTimer = null; preview(); }, 700);
  }
  function toggleLive() {
    liveOn = !liveOn;
    liveLabel();
    if (liveOn) {
      const runId = ($('rs-runid') && $('rs-runid').value.trim()) || '';
      if (runId) preview(); else toast('المعاينة الحيّة تحتاج مصدر بيانات — اختر تشغيلًا محفوظًا');
    }
  }
  /* ---------- المعادلات المحفوظة (السجل المشترك) ---------- */
  async function loadSavedFormulas() {
    try {
      const d = await apiCall('/api/formulas/saved');
      rsFormulas = (d && d.items) || [];
    } catch (e) { rsFormulas = []; }
  }
  function formulaOptions(selected) {
    const opts = ['<option value="">— عمود مباشر —</option>'];
    for (const f of rsFormulas) {
      opts.push('<option value="' + esc(f.id) + '"' + (selected === f.id ? ' selected' : '') + '>'
        + esc(f.name) + ' (نسخة ' + esc(String(f.version)) + ')</option>');
    }
    return opts.join('');
  }

  /* ---------- بطاقة التتبّع (مصدر النتيجة وفلاترها وبصمتها) ---------- */
  function tracePanel() {
    const t = rsTrace || {};
    const rows = [];
    rows.push(['المصدر', (t.label || t.name || 'غير محدد')]);
    rows.push(['التشغيل', t.runId || '—']);
    rows.push(['عدد الصفوف', t.rowCount === undefined ? '—' : String(t.rowCount)]);
    rows.push(['الحقول', t.columns === undefined ? '—' : String(t.columns)]);
    rows.push(['وقت التشغيل', t.savedAt || '—']);
    rows.push(['بصمة التعريف', t.definitionHash || '—']);
    rows.push(['إصدار محرك المعادلات', t.engineVersion
      ? (t.engineVersion + (t.engineState === 'changed' ? ' — تغيّر منذ التشغيل (النتائج لا تُقارن)' : (t.engineState === 'unknown' ? ' — غير معروف' : ' — مطابق')))
      : 'غير معروف (نتيجة قديمة)']);
    if (t.joinCompleteness) {
      rows.push(['اكتمال الربط', t.joinCompleteness === 'complete' ? 'مكتمل'
        : (t.joinCompleteness === 'possibly-truncated' ? 'تحذير احتمال الاقتطاع'
          : 'غير مكتمل — لا يجوز الاعتماد على مجاميعه')]);
    }
    const warns = (t.warnings && t.warnings.length ? t.warnings : (t.sourceNotes || []));
    if (warns.length) rows.push(['تحذيرات التشغيل', warns.join(' · ')]);
    rows.push(['تتبّع كامل', t.traced ? 'نعم — النتيجة تحمل تعريف تشغيلها' : 'لا — نتيجة قديمة بلا تعريف تشغيل محفوظ']);
    if (t.definitionChanged === true) rows.push(['تحذير', 'ملف التدفق تغيّر بعد هذا التشغيل — قد تختلف النتائج']);
    if (t.filters && Object.keys(t.filters).length) {
      rows.push(['فلاتر التشغيل', Object.keys(t.filters).map(k => k + '=' + t.filters[k]).join(' · ')]);
    }
    if (t.sourceNote) rows.push(['تنبيه المصدر', t.sourceNote]);
    return '<div class="rd-sec-title">تتبّع مصدر النتيجة</div>'
      + '<div class="rd-trace">' + rows.map(r =>
        '<div class="rd-trace-row"><span>' + esc(r[0]) + '</span><b>' + esc(r[1]) + '</b></div>').join('') + '</div>';
  }

  function colOpts(sel, multi) {
    const list = columns.length ? columns : [];
    return list.map(c => '<option value="' + esc(c) + '"' + ((multi && (sel || []).includes(c)) || sel === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
  }
  function titleOf(c) {
    if (!c) return '';
    if (c.type === 'kpi') return c.label || 'مؤشر';
    if (c.type === 'table') return 'جدول — ' + ((c.columns || []).join('، ') || 'بلا أعمدة');
    if (c.type === 'bar' || c.type === 'line' || c.type === 'pie') return c.title || TYPE_LABEL[c.type];
    if (c.type === 'heading' || c.type === 'text') return (c.text || '').slice(0, 40) || TYPE_LABEL[c.type];
    if (c.type === 'divider') return 'فاصل';
    if (c.type === 'shape') return (c.text || '').slice(0, 40) || 'شكل';
    return '';
  }

  /* ---------------- المعاينة المصغّرة داخل اللوحة ---------------- */
  function mini(c) {
    const st = c.style || {};
    const style = [];
    if (st.bg) style.push('background:' + st.bg);
    if (st.color) style.push('color:' + st.color);
    if (st.border) style.push('border:' + st.border);
    if (st.radius !== undefined) style.push('border-radius:' + st.radius + 'px');
    if (st.fontSize) style.push('font-size:' + st.fontSize + 'px');
    if (st.fontWeight) style.push('font-weight:' + st.fontWeight);
    if (st.align) style.push('text-align:' + st.align);
    if (st.padding !== undefined) style.push('padding:' + st.padding + 'px');
    const s = ' style="' + esc(style.join(';')) + '"';
    if (c.type === 'kpi') {
      return '<div class="rd-mini rd-mini-kpi"' + s + '><span>' + esc(c.label || 'مؤشر') + '</span><b>'
        + esc(String(c.agg || 'sum').toUpperCase()) + ' · ' + esc(c.column || '?') + '</b></div>';
    }
    if (c.type === 'table') {
      const cs = (c.columns || []).slice(0, 4);
      return '<div class="rd-mini rd-mini-table"' + s + '><table><thead><tr>'
        + cs.map(x => '<th>' + esc(x) + '</th>').join('') + '</tr></thead><tbody><tr>'
        + cs.map(() => '<td>—</td>').join('') + '</tr></tbody></table></div>';
    }
    if (c.type === 'bar') {
      const bars = [0.45, 0.8, 0.3, 0.65, 0.5];
      return '<div class="rd-mini rd-mini-bar"' + s + '>' + bars.map(h =>
        '<i style="height:' + Math.round(h * 100) + '%"></i>').join('') + '</div>';
    }
    if (c.type === 'line') {
      return '<div class="rd-mini rd-mini-line"' + s + '><svg viewBox="0 0 100 40" preserveAspectRatio="none">'
        + '<polyline points="0,30 20,18 40,26 60,10 80,20 100,8" fill="none" stroke="currentColor" stroke-width="2"/></svg></div>';
    }
    if (c.type === 'pie') {
      return '<div class="rd-mini rd-mini-pie"' + s + '><i></i></div>';
    }
    if (c.type === 'divider') return '<div class="rd-mini rd-mini-divider"></div>';
    if (c.type === 'shape') return '<div class="rd-mini rd-mini-shape"' + s + '>' + esc((c.text || '').slice(0, 80)) + '</div>';
    return '<div class="rd-mini rd-mini-text"' + s + '>' + esc((c.text || '').slice(0, 120) || '—') + '</div>';
  }

  /* ---------------- اللوحة (canvas) ---------------- */
  function renderCanvas() {
    const host = $('rs-canvas'); if (!host) return;
    trackChange();
    scheduleLivePreview();
    if (!comps.length) {
      host.innerHTML = '<div class="hint">اللوحة فارغة — أضف عنصرًا من الشريط أعلاه (مؤشر · جدول · مخطط …).</div>';
      return;
    }
    host.style.setProperty('--rd-cols', String(layout.columns));
    host.innerHTML = comps.map(c => {
      const g = c.grid || { w: 12, h: 1 };
      return '<div class="rd-item' + (c.id === selectedId ? ' selected' : '') + '" draggable="true" data-id="' + esc(c.id) + '"'
        + ' style="grid-column:span ' + g.w + ';min-height:' + Math.max(48, g.h * 54) + 'px">'
        + '<div class="rd-item-head"><span class="rd-badge">' + esc(TYPE_LABEL[c.type] || c.type) + '</span>'
        + '<b class="rd-item-title">' + esc(titleOf(c)) + '</b>'
        + '<span class="rd-item-acts">'
        + '<button type="button" class="rd-ic" data-act="edit" data-id="' + esc(c.id) + '" title="تعديل">✎</button>'
        + '<button type="button" class="rd-ic" data-act="dup" data-id="' + esc(c.id) + '" title="نسخ">⧉</button>'
        + '<button type="button" class="rd-ic" data-act="up" data-id="' + esc(c.id) + '" title="أعلى">↑</button>'
        + '<button type="button" class="rd-ic" data-act="down" data-id="' + esc(c.id) + '" title="أسفل">↓</button>'
        + '<button type="button" class="rd-ic danger" data-act="del" data-id="' + esc(c.id) + '" title="حذف">✕</button>'
        + '</span></div>'
        + '<div class="rd-item-body">' + mini(c) + '</div>'
        + '<span class="rd-resize" data-resize="' + esc(c.id) + '" title="اسحب يمينًا/يسارًا لتغيير العرض"></span>'
        + '</div>';
    }).join('');
    host.querySelectorAll('[data-act]').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        const id = b.getAttribute('data-id');
        const act = b.getAttribute('data-act');
        const i = comps.findIndex(c => c.id === id);
        if (i < 0) return;
        if (act === 'up' && i > 0) { const t = comps[i - 1]; comps[i - 1] = comps[i]; comps[i] = t; }
        else if (act === 'down' && i < comps.length - 1) { const t = comps[i + 1]; comps[i + 1] = comps[i]; comps[i] = t; }
        else if (act === 'del') {
          if (!window.confirm('حذف العنصر «' + (titleOf(comps[i]) || TYPE_LABEL[comps[i].type]) + '»؟')) return;
          comps.splice(i, 1); if (selectedId === id) selectedId = null;
        }
        else if (act === 'dup') { const copy = JSON.parse(JSON.stringify(comps[i])); copy.id = uid(); comps.splice(i + 1, 0, copy); selectedId = copy.id; }
        else if (act === 'edit') { selectedId = id; tab = 'data'; }
        setDirty(true); renderCanvas(); renderInspector(); syncJson();
      });
    });
    host.querySelectorAll('.rd-item').forEach(el => {
      el.addEventListener('click', () => { selectedId = el.getAttribute('data-id'); renderCanvas(); renderInspector(); });
      el.addEventListener('dragstart', e => { dragId = el.getAttribute('data-id'); el.classList.add('dragging'); try { e.dataTransfer.setData('text/plain', dragId); } catch (_) {} });
      el.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); });
      el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drop-target'); });
      el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
      el.addEventListener('drop', e => {
        e.preventDefault(); el.classList.remove('drop-target');
        const from = comps.findIndex(c => c.id === dragId);
        const to = comps.findIndex(c => c.id === el.getAttribute('data-id'));
        if (from < 0 || to < 0 || from === to) return;
        const moved = comps.splice(from, 1)[0];
        comps.splice(to, 0, moved);
        setDirty(true); renderCanvas(); syncJson();
      });
    });
    host.querySelectorAll('[data-resize]').forEach(h => {
      h.addEventListener('pointerdown', e => startResize(e, h.getAttribute('data-resize'), host));
    });
  }

  /* مقبض تغيير العرض: سحب يمين/يسار ⇒ عدد الأعمدة الذي يشغله العنصر */
  function startResize(e, id, host) {
    e.preventDefault(); e.stopPropagation();
    const c = byId(id); if (!c) return;
    const rect = host.getBoundingClientRect();
    const cell = (rect.width - layout.gap * (layout.columns - 1)) / layout.columns;
    const startX = e.clientX;
    const startW = (c.grid && c.grid.w) || 12;
    const move = ev => {
      const dx = ev.clientX - startX;
      /* RTL: السحب لليسار = عرض أكبر */
      const w = Math.max(1, Math.min(layout.columns, startW - Math.round(dx / (cell + layout.gap))));
      c.grid = c.grid || { w: 12, h: 1 };
      if (c.grid.w !== w) {
        c.grid.w = w;
        setDirty(true);
        renderCanvas();
        syncJson();
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      renderInspector();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* ---------------- لوحة الخصائص ---------------- */
  function renderInspector() {
    const host = $('rs-inspector'); if (!host) return;
    document.querySelectorAll('#rs-tabs .rd-tab').forEach(b => b.classList.toggle('active', b.dataset.rt === tab));
    const c = selected();
    if (!c) {
      host.innerHTML = '<div class="hint">اختر عنصرًا من اللوحة لتحرير بياناته وتخطيطه ونمطه.</div>';
      return;
    }
    let html = '';
    if (tab === 'data') html = dataPanel(c);
    else if (tab === 'layout') html = layoutPanel(c);
    else if (tab === 'style') html = stylePanel(c);
    else html = rulesPanel(c);
    host.innerHTML = html;
    host.querySelectorAll('[data-rd-open-fml]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-rd-open-fml');
        if (!id) return;
        try {
          if (typeof window.goTab === 'function') window.goTab('workflow');
          if (window.PlatformShell && typeof window.PlatformShell.show === 'function') window.PlatformShell.show('analysis', 'formulas');
        } catch (_) {}
        setTimeout(() => {
          try {
            if (window.FormulaEditor && typeof window.FormulaEditor.open === 'function') {
              window.FormulaEditor.open(id);
            }
          } catch (_) {}
        }, 200);
      });
    });
    wireInspector(c);
  }

  function dataPanel(c) {
    let h = tracePanel();
    h += '<div class="rd-sec-title">مرجع المعادلة (اختياري)</div>';
    const fref = c.formula && c.formula.id ? c.formula : null;
    let fstate = '';
    if (fref) {
      const applied = rsFormulaCols[fref.id];
      const ver = fref.version;
      const runVer = rsFormulaVersions[fref.id];
      if (applied) {
        fstate = '<span class="pill ok">مرجع موثّق</span> <span class="muted xs">العمود المحسوب: '
          + esc(String(applied)) + ' · نسخة المعادلة: ' + esc(String(ver === undefined || ver === null ? '—' : ver))
          + (runVer !== undefined && ver !== undefined && ver !== null && Number(runVer) !== Number(ver) ? ' · <span class="warn">تختلف عن نسخة التشغيل — أعد تشغيل التدفق</span>' : (runVer !== undefined && runVer !== null ? ' · نسخة التشغيل: ' + esc(String(runVer)) : ''))
          + '</span>'
          + '<div><button type="button" class="btn xs ghost" data-rd-open-fml="' + esc(fref.id) + '">فتح المعادلة في محرّر المعادلات</button></div>';
      } else {
        fstate = '<span class="pill warning">غير مطبَّقة على بيانات هذا التشغيل</span>'
          + '<span class="muted xs">أعد تشغيل التدفق الذي يحسبها، أو اختر عمودًا مباشرًا.</span>';
      }
    } else {
      fstate = '<span class="muted xs">لا يوجد مرجع معادلة موثّق لهذا العنصر — يُستخدم عمود مباشر من بيانات التشغيل.</span>';
    }
    h += row('معادلة محفوظة', '<select class="wf-select" data-k="formula.id">' + formulaOptions(c.formula && c.formula.id) + '</select>'
      + '<span class="muted xs">تُستخدم كقيمة لهذا العنصر — تُحلّ إلى عمود محسوب في بيانات التشغيل (نفس محرك التدفقات).</span>' + fstate);
    h += '<div class="rd-sec-title">بيانات العنصر</div>';
    if (c.type === 'kpi') {
      h += row('العنوان', '<input class="input sm" data-k="label" value="' + esc(c.label || '') + '" />');
      h += row('العمود', '<select class="wf-select" data-k="column">' + colOpts(c.column) + '</select>');
      h += row('الحساب', '<select class="wf-select" data-k="agg">' + AGGS.map(a => '<option value="' + a + '"' + (c.agg === a ? ' selected' : '') + '>' + a + '</option>').join('') + '</select>');
      h += row('منازل عشرية', '<input class="input sm" type="number" min="0" max="6" data-k="decimals" value="' + esc(c.decimals === undefined ? '' : c.decimals) + '" placeholder="تلقائي" />');
    } else if (c.type === 'table') {
      h += row('الأعمدة', '<select class="wf-select" data-k="columns" multiple size="6">' + colOpts(c.columns, true) + '</select>');
      h += row('ترتيب حسب', '<select class="wf-select" data-k="sort"><option value="">—</option>' + colOpts(c.sort) + '</select>');
      h += row('اتجاه', '<select class="wf-select" data-k="desc"><option value="0"' + (!c.desc ? ' selected' : '') + '>تصاعدي</option><option value="1"' + (c.desc ? ' selected' : '') + '>تنازلي</option></select>');
      h += row('حد الصفوف', '<input class="input sm" type="number" min="1" max="500" data-k="limit" value="' + esc(c.limit === undefined ? '' : c.limit) + '" placeholder="الكل" />');
      h += row('منازل عشرية', '<input class="input sm" type="number" min="0" max="6" data-k="decimals" value="' + esc(c.decimals === undefined ? '' : c.decimals) + '" placeholder="تلقائي" />');
    } else if (c.type === 'bar' || c.type === 'line' || c.type === 'pie') {
      h += row('عنوان المخطط', '<input class="input sm" data-k="title" value="' + esc(c.title || '') + '" />');
      h += row('عمود الفئات', '<select class="wf-select" data-k="category">' + colOpts(c.category) + '</select>');
      h += row('عمود القيم', '<select class="wf-select" data-k="value">' + colOpts(c.value) + '</select>');
      h += row('الحساب', '<select class="wf-select" data-k="agg">' + AGGS.map(a => '<option value="' + a + '"' + (c.agg === a ? ' selected' : '') + '>' + a + '</option>').join('') + '</select>');
      h += row('إظهار العنوان', '<select class="wf-select" data-k="showTitle"><option value="1"' + (c.showTitle !== false ? ' selected' : '') + '>نعم</option><option value="0"' + (c.showTitle === false ? ' selected' : '') + '>لا</option></select>');
      h += row('المحور الأفقي', '<input class="input sm" data-k="xLabel" value="' + esc(c.xLabel || '') + '" />');
      h += row('المحور الرأسي', '<input class="input sm" data-k="yLabel" value="' + esc(c.yLabel || '') + '" />');
    } else if (c.type === 'heading' || c.type === 'text') {
      h += row('النص', '<textarea class="wf-textarea" data-k="text" rows="3">' + esc(c.text || '') + '</textarea>');
    } else if (c.type === 'shape') {
      h += row('النص (اختياري)', '<textarea class="wf-textarea" data-k="text" rows="2">' + esc(c.text || '') + '</textarea>');
      h += '<div class="hint">عنصر زخرفي: شريط/صندوق ملوّن (لا يعتمد على بيانات) — للتحويل بين الأقسام أو للتأكيد على منطقة.</div>';
    } else if (c.type === 'divider') {
      h += '<div class="hint">فاصل أفقي بين الأقسام.</div>';
    }
    return h;
  }

  function layoutPanel(c) {
    const g = c.grid || { w: 12, h: 1 };
    let h = '<div class="rd-sec-title">تخطيط العنصر</div>';
    h += row('العرض (أعمدة الشبكة)', '<input type="range" min="1" max="' + layout.columns + '" step="1" data-k="grid.w" value="' + g.w + '" /><span class="rd-val">' + g.w + '/' + layout.columns + '</span>');
    h += row('الارتفاع', '<input type="range" min="1" max="6" step="1" data-k="grid.h" value="' + g.h + '" /><span class="rd-val">' + g.h + '</span>');
    h += '<div class="hint">يمكن أيضاً سحب المقبض أسفل العنصر في اللوحة لتغيير العرض مباشرة.</div>';
    h += '<div class="rd-sec-title">شبكة التقرير</div>';
    h += row('عدد أعمدة الشبكة', '<input type="range" min="2" max="24" step="1" data-k="layout.columns" value="' + layout.columns + '" /><span class="rd-val">' + layout.columns + '</span>');
    h += row('المسافة بين العناصر', '<input type="range" min="0" max="32" step="1" data-k="layout.gap" value="' + layout.gap + '" /><span class="rd-val">' + layout.gap + 'px</span>');
    return h;
  }

  function stylePanel(c) {
    const st = c.style || {};
    let h = '<div class="rd-sec-title">النمط البصري</div>';
    h += row('لون الخلفية', colorInput('style.bg', st.bg || '#111a2e'));
    h += row('لون النص', colorInput('style.color', st.color || '#e9eefb'));
    h += row('لون التمييز (حد)', colorInput('style.accent', st.accent || '#5b8cff'));
    h += row('الحد', '<input class="input sm" data-k="style.border" value="' + esc(st.border || '') + '" placeholder="1px solid #33415c" />');
    h += row('استدارة الزوايا', '<input type="range" min="0" max="40" step="1" data-k="style.radius" value="' + (st.radius === undefined ? 12 : st.radius) + '" /><span class="rd-val">' + (st.radius === undefined ? 12 : st.radius) + 'px</span>');
    h += row('حجم الخط', '<input type="range" min="8" max="48" step="1" data-k="style.fontSize" value="' + (st.fontSize === undefined ? 14 : st.fontSize) + '" /><span class="rd-val">' + (st.fontSize === undefined ? 14 : st.fontSize) + 'px</span>');
    h += row('سماكة الخط', '<select class="wf-select" data-k="style.fontWeight">'
      + ['', 'normal', 'bold', '500', '600', '700'].map(w => '<option value="' + w + '"' + ((st.fontWeight || '') === w ? ' selected' : '') + '>' + (w || 'تلقائي') + '</option>').join('') + '</select>');
    h += row('المحاذاة', '<select class="wf-select" data-k="style.align">'
      + [['', 'تلقائي']].concat(ALIGN_OPTS).map(a => '<option value="' + a[0] + '"' + ((st.align || '') === a[0] ? ' selected' : '') + '>' + a[1] + '</option>').join('') + '</select>');
    h += row('الحشو الداخلي', '<input type="range" min="0" max="48" step="1" data-k="style.padding" value="' + (st.padding === undefined ? 12 : st.padding) + '" /><span class="rd-val">' + (st.padding === undefined ? 12 : st.padding) + 'px</span>');
    h += row('ظل', '<select class="wf-select" data-k="style.shadow"><option value="0"' + (!st.shadow ? ' selected' : '') + '>بدون</option><option value="1"' + (st.shadow ? ' selected' : '') + '>مع ظل</option></select>');
    h += '<button type="button" class="btn sm ghost" id="rs-style-reset">إرجاع النمط الافتراضي</button>';
    return h;
  }

  function rulesPanel(c) {
    const rules = c.rules || [];
    let h = '<div class="rd-sec-title">التنسيق الشرطي</div>';
    if (c.type !== 'table' && c.type !== 'kpi') {
      h += '<div class="hint">التنسيق الشرطي متاح للجدول وللمؤشر.</div>';
      return h;
    }
    if (!rules.length) h += '<div class="hint">لا شروط — أضف شرطًا لتلوين القيم المطابقة.</div>';
    rules.forEach((r, i) => {
      h += '<div class="rd-rule" data-i="' + i + '">'
        + row('العمود', '<select class="wf-select" data-r="column" data-i="' + i + '">' + colOpts(r.column) + '</select>')
        + row('الشرط', '<select class="wf-select" data-r="op" data-i="' + i + '">' + OPS.map(o => '<option value="' + o + '"' + (r.op === o ? ' selected' : '') + '>' + o + '</option>').join('') + '</select>')
        + row('القيمة', '<input class="input sm" data-r="value" data-i="' + i + '" value="' + esc(r.value === undefined ? '' : r.value) + '" />')
        + row('لون النص', colorInput('rule.color', r.color || '#fb7185', i))
        + row('لون الخلفية', colorInput('rule.bg', r.bg || '#3b1d2a', i))
        + '<button type="button" class="btn xs danger" data-del-rule="' + i + '">حذف الشرط</button>'
        + '</div>';
    });
    h += '<button type="button" class="btn sm" id="rs-add-rule">＋ شرط</button>';
    return h;
  }

  function row(label, control) {
    return '<label class="rd-row"><span>' + esc(label) + '</span>' + control + '</label>';
  }
  function colorInput(path, value, ruleIndex) {
    const id = 'rd-c-' + path.replace(/[^a-z0-9]/gi, '-') + (ruleIndex === undefined ? '' : '-' + ruleIndex);
    return '<span class="rd-color"><input type="color" id="' + id + '" data-color="' + path + '"' + (ruleIndex === undefined ? '' : ' data-rule="' + ruleIndex + '"') + ' value="' + esc(value) + '" />'
      + '<input class="input sm" data-k="' + path + '"' + (ruleIndex === undefined ? '' : ' data-rule="' + ruleIndex + '"') + ' value="' + esc(value) + '" /></span>';
  }

  /* كتابة قيمة داخل العنصر (تدعم المسارات style.x و grid.w) */
  function setPath(obj, path, value) {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = value;
  }

  function wireInspector(c) {
    const host = $('rs-inspector'); if (!host) return;
    host.querySelectorAll('[data-k]').forEach(inp => {
      const path = inp.getAttribute('data-k');
      const ruleIndex = inp.getAttribute('data-rule');
      const handler = () => {
        let needInspector = false;
        let v = inp.value;
        if (inp.type === 'range' || inp.type === 'number') v = v === '' ? undefined : Number(v);
        if (path === 'style.shadow') v = String(v) === '1';
        if (path === 'desc') v = String(v) === '1';
        if (path === 'showTitle') v = String(v) === '1';
        if (path === 'columns') v = Array.from(inp.selectedOptions).map(o => o.value);
        if (path === 'grid.w' || path === 'grid.h') {
          c.grid = c.grid || { w: 12, h: 1 };
          c.grid[path.split('.')[1]] = v;
        } else if (path === 'layout.columns' || path === 'layout.gap') {
          layout[path.split('.')[1]] = v;
          if (path === 'layout.columns') {
            for (const x of comps) if (x.grid) x.grid.w = Math.min(x.grid.w, v);
          }
        } else if (path.indexOf('style.') === 0) {
          c.style = c.style || {};
          const key = path.split('.')[1];
          if (v === '' || v === undefined) delete c.style[key];
          else c.style[key] = v;
        } else if (path === 'formula.id') {
          if (!v) { delete c.formula; }
          else {
            const f = rsFormulas.find(x => x.id === v);
            c.formula = { id: v, version: f ? f.version : null, name: f ? f.name : '' };
            /* المعادلة تُغذّي قيمة العنصر ⇒ املأ عمود التشغيل المحسوب نفسه
               حتى يبقى التعريف صالحًا؛ المحرّك يستبدل العمود بالعمود المحسوب. */
            const applied = rsFormulaCols[v];
            if (applied) {
              if (c.type === 'kpi') c.column = applied;
              else if (c.type === 'bar' || c.type === 'line' || c.type === 'pie') c.value = applied;
              else if (c.type === 'table') {
                const cols = Array.isArray(c.columns) ? c.columns.slice() : [];
                if (cols.indexOf(applied) < 0) cols.push(applied);
                c.columns = cols;
              } else c.column = applied;
              needInspector = true;
            }
          }
        } else if (ruleIndex !== null && ruleIndex !== undefined) {
          const r = (c.rules || [])[Number(ruleIndex)];
          if (r) r[path.replace(/^rule\./, '')] = v;
        } else {
          if (v === '' && (path === 'decimals' || path === 'limit' || path === 'sort')) delete c[path];
          else c[path] = v;
        }
        setDirty(true);
        renderCanvas();
        if (needInspector) renderInspector();
        syncJson();
        /* تحديث القيم المعروضة بجوار المنزلقات دون فقدان التركيز */
        const valEl = inp.parentElement && inp.parentElement.querySelector('.rd-val');
        if (valEl && (inp.type === 'range')) {
          valEl.textContent = inp.getAttribute('data-k') === 'layout.gap' ? v + 'px'
            : (inp.getAttribute('data-k') === 'grid.w' ? v + '/' + layout.columns : String(v));
        }
      };
      inp.addEventListener('input', handler);
      inp.addEventListener('change', handler);
    });
    host.querySelectorAll('[data-color]').forEach(inp => {
      inp.addEventListener('input', () => {
        const path = inp.getAttribute('data-color');
        const ruleIndex = inp.getAttribute('data-rule');
        const twin = inp.parentElement.querySelector('input.input');
        if (twin) twin.value = inp.value;
        if (ruleIndex !== null) {
          const r = (c.rules || [])[Number(ruleIndex)];
          if (r) r[path.replace(/^rule\./, '')] = inp.value;
        } else {
          c.style = c.style || {};
          c.style[path.replace(/^style\./, '')] = inp.value;
        }
        setDirty(true); renderCanvas(); syncJson();
      });
    });
    host.querySelectorAll('[data-del-rule]').forEach(b => {
      b.addEventListener('click', () => {
        const i = Number(b.getAttribute('data-del-rule'));
        c.rules = (c.rules || []).filter((_, k) => k !== i);
        setDirty(true); renderInspector(); renderCanvas(); syncJson();
      });
    });
    const addRule = $('rs-add-rule');
    if (addRule) addRule.addEventListener('click', () => {
      c.rules = c.rules || [];
      if (c.rules.length >= 10) { toast('الحد الأقصى 10 شروط'); return; }
      c.rules.push({ column: columns[0] || '', op: '>', value: 0, color: '#fb7185', bg: '' });
      setDirty(true); renderInspector(); renderCanvas(); syncJson();
    });
    const resetStyle = $('rs-style-reset');
    if (resetStyle) resetStyle.addEventListener('click', () => {
      c.style = {};
      setDirty(true); renderInspector(); renderCanvas(); syncJson();
    });
  }

  /* ---------------- تعريف التقرير ---------------- */
  function definition() {
    const base = {
      name: ($('rs-name') && $('rs-name').value.trim()) || 'تقرير',
      title: ($('rs-title') && $('rs-title').value.trim()) || '',
      description: ($('rs-description') && $('rs-description').value.trim()) || '',
      runId: ($('rs-runid') && $('rs-runid').value.trim()) || '',
      legacy: legacySource || null,
      filters: reportFilters || [],
      source: source || {},
      layout: layout,
      components: comps,
    };
    return S ? S.normalizeReport(base) : base;
  }
  function syncJson() {
    const ta = $('rs-json'); if (ta) ta.value = JSON.stringify(definition(), null, 2);
  }
  function applyJson() {
    const ta = $('rs-json'); if (!ta) return;
    let parsed;
    try { parsed = JSON.parse(ta.value || '{}'); } catch (e) { toast('JSON غير صالح: ' + e.message); return; }
    if (!parsed || !Array.isArray(parsed.components)) { toast('يجب أن يحتوي على components مصفوفة'); return; }
    const norm = S ? S.normalizeReport(parsed) : parsed;
    comps = norm.components;
    if (norm.layout) layout = norm.layout;
    if (norm.source) source = norm.source;
    if (parsed.name) $('rs-name').value = parsed.name;
    if (parsed.runId) $('rs-runid').value = parsed.runId;
    setDirty(true);
    renderCanvas(); renderInspector(); syncJson();
    toast('تم تطبيق JSON');
  }

  /* ================= «تقرير سريع» =================
   * يختار المستخدم مصدرًا معتمدًا وأعمدة ⇒ نشغّل تدفقًا بخطوة select واحدة عبر
   * مسار التشغيل القائم (صلاحيات + حدود صفوف + حفظ النتيجة + التتبّع)، ثم نفتح
   * المصمم على النتيجة. لا مسار قراءة جديد ولا SQL ولا حسابات موازية.
   */
  async function openQuickPanel() {
    const panel = $('rs-quick-panel'); if (panel) panel.hidden = false;
    const msg = $('rs-quick-msg');
    const sel = $('rs-quick-source');
    if (!sel) return;
    try {
      const d = await apiCall('/api/datasets');
      const items = (d && d.items) || [];
      sel.innerHTML = '';
      for (const s of items) {
        if (s.name === 'synthetic') continue;
        /* مصادر مستثناة (مثل أرصدة العقود — المرجع المعتمد هو daily_balances) */
        if (s.quickReport === false) continue;
        const o = document.createElement('option');
        o.value = s.name;
        o.textContent = s.label + (s.perm ? '' : ' — يتطلب صلاحية');
        sel.appendChild(o);
      }
      if (!sel.value && sel.options.length) sel.value = sel.options[0].value;
      await loadQuickFields();
    } catch (e) { if (msg) msg.textContent = 'تعذّر تحميل المصادر: ' + e.message; }
  }

  async function loadQuickFields() {
    const name = ($('rs-quick-source') || {}).value;
    const cols = $('rs-quick-cols');
    const msg = $('rs-quick-msg');
    if (!name || !cols) return;
    try {
      const d = await apiCall('/api/datasets/fields?name=' + encodeURIComponent(name));
      const fields = (d && d.fields) || [];
      cols.innerHTML = fields.map(f => '<option value="' + esc(f.name) + '">' + esc(f.name)
        + ' <span class="muted xs">(' + esc(f.type || 'any') + ')</span></option>').join('');
      if (msg) msg.textContent = fields.length + ' حقل متاح' + ((d && d.sample) ? ' · عيّنة ' + d.sample.length + ' صف' : '');
    } catch (e) {
      cols.innerHTML = '';
      if (msg) msg.textContent = 'تعذّر قراءة الحقول (قد تكون الصلاحية ناقصة): ' + e.message;
    }
  }

  async function createQuickRun() {
    const name = ($('rs-quick-source') || {}).value;
    const sel = $('rs-quick-cols');
    const cols = sel ? Array.from(sel.selectedOptions || []).map(o => o.value) : [];
    const msg = $('rs-quick-msg');
    if (!name) { if (msg) msg.textContent = 'اختر مصدرًا'; return; }
    if (!cols.length) { if (msg) msg.textContent = 'اختر عمودًا واحدًا على الأقل'; return; }
    try {
      if (msg) msg.textContent = 'جارٍ إنشاء نتيجة التشغيل…';
      const settings = { days: 120 };
      const f = ($('rs-quick-from') || {}).value; if (f) settings.from = f;
      const t = ($('rs-quick-to') || {}).value; if (t) settings.to = t;
      const wf = {
        name: 'تقرير سريع',
        source: { type: 'dataset', name, settings },
        steps: [{ id: 'q1', type: 'select', columns: cols }],
      };
      const r = await apiCall('/api/workflows/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow: wf }),
      });
      if (!r || !r.ok) throw new Error((r && (r.error || r.message)) || 'فشل التشغيل');
      const ri = $('rs-runid'); if (ri) ri.value = r.runId;
      const nm = $('rs-name'); if (nm && (!nm.value || nm.value === 'تقرير')) nm.value = 'تقرير سريع — ' + name;
      await fetchRunColumns(r.runId);
      await loadRuns();
      const rl = $('rs-runlist'); if (rl) rl.value = r.runId;
      const notes = (r.sourceNotes && r.sourceNotes.length) ? ' · ' + r.sourceNotes.join(' · ') : '';
      if (msg) msg.textContent = 'النتيجة جاهزة: ' + r.runId + ' (' + (r.rowCount || 0) + ' صف)' + notes;
    } catch (e) {
      if (msg) msg.textContent = 'تعذّر إنشاء النتيجة: ' + e.message;
    }
  }

  /* ---------------- مصدر البيانات ---------------- */
  async function loadRuns() {
    const sel = $('rs-runlist'); if (!sel) return;
    try {
      const d = await apiCall('/api/workflows/outputs');
      const cur = sel.value;
      sel.innerHTML = '<option value="">— اختر تشغيلًا محفوظًا —</option>';
      (d.items || []).forEach(it => {
        const src = it.source ? (it.source.label || it.source.name) : '';
        const when = it.savedAt ? new Date(it.savedAt).toLocaleString('ar-EG') : '';
        /* markers حالة التتبّع: هل النتيجة قابلة للتتبّع؟ هل تغيّر التعريف بعدها؟ */
        const traceTag = it.traced === true
          ? (it.definitionChanged === true ? ' · تعريف تغيّر' : ' · تتبّع كامل')
          : ' · تتبّع غير مكتمل';
        const warnTag = (it.warnings && it.warnings.length) ? (' · ' + it.warnings.length + ' تحذير') : '';
        const o = document.createElement('option');
        o.value = it.runId;
        o.textContent = (src ? src + ' · ' : '') + (it.workflowName ? it.workflowName + ' · ' : '')
          + (it.runId || '') + ' (' + (it.rowCount || 0) + ' صف)' + (when ? ' — ' + when : '')
          + traceTag + warnTag;
        o.title = traceTag + warnTag;
        sel.appendChild(o);
      });
      if (cur) sel.value = cur;
    } catch (e) { /* تجاهل */ }
  }
  async function fetchRunColumns(runId) {
    const id = (runId || ($('rs-runid') && $('rs-runid').value.trim()) || '').trim();
    if (!id) { toast('اختر تشغيلًا محفوظًا أو أدخل معرّف تشغيل'); return false; }
    /* تفريغ أعمدة التشغيل السابق قبل التحميل (لا خلط بين تشغيلين) */
    columns = [];
    rsTrace = null;
    try {
      const d = await apiCall('/api/workflows/output?id=' + encodeURIComponent(id));
      columns = (d && d.columns) || [];
      if (!columns.length && d && d.rows && d.rows.length) columns = Object.keys(d.rows[0]);
      /* مراجع المعادلات المطبَّقة في هذا التشغيل (لعرضها في المفتّش) */
      rsFormulaCols = (d && d.formulaColumns) || {};
      rsFormulaVersions = (d && d.formulaVersions) || {};
      renderFilters();
      source = {
        name: (d && d.source && d.source.name) || '', label: (d && d.source && d.source.label) || '',
        runId: id, savedAt: (d && d.savedAt) || '', rowCount: (d && d.rowCount) || (d && d.rows ? d.rows.length : 0),
        workflowName: (d && d.workflowName) || '',
        traced: !!(d && d.definition), definitionHash: (d && d.definitionHash) || '',
        filters: (d && d.definition && d.definition.source && d.definition.source.settings) ? d.definition.source.settings : null,
        canonical: d && d.source ? d.source.canonical : undefined,
        engineVersion: (d && d.engineVersion) || null,
        engineHash: (d && d.engineHash) || null,
        engineState: !d || !d.engineHash ? 'unknown'
          : (!d.currentEngineHash ? 'unknown'
            : (d.engineHash === d.currentEngineHash ? 'same' : 'changed')),
        joinCompleteness: (d && d.joinCompleteness) || null,
        warnings: (d && d.warnings) || [],
      };
      rsTrace = {
        name: source.name, label: source.label, runId: id, rowCount: source.rowCount, columns: columns.length,
        savedAt: source.savedAt, definitionHash: source.definitionHash, traced: source.traced,
        filters: source.filters, sourceNote: source.canonical === false ? 'مصدر أرصدة غير معتمد (الأرصدة اليومية هي المرجع)' : '',
      };
      const info = $('rs-source-info');
      if (info) {
        info.innerHTML = (source.label ? 'المصدر: ' + esc(source.label) + ' · ' : '')
          + (source.workflowName ? 'التدفق: ' + esc(source.workflowName) + ' · ' : '')
          + 'التشغيل: ' + esc(id) + ' · ' + (source.rowCount || 0) + ' صف · ' + columns.length + ' حقل'
          + (source.savedAt ? ' · ' + new Date(source.savedAt).toLocaleString('ar-EG') : '')
          + ' <button type="button" class="btn xs ghost" id="rs-src-analysis">فتح التحليل</button>'
          + ' <button type="button" class="btn xs ghost" id="rs-src-explorer">فتح في المستكشف</button>'
          + ' <button type="button" class="btn xs ghost" id="rs-src-output">فتح المخرجات</button>';
        $('rs-src-analysis')?.addEventListener('click', () => {
          const run = (window.Workspace && window.Workspace.getIndex()) ? window.Workspace.getIndex().byRun.get(id) : null;
          if (!run || !run.workflowId) { toast('لا يوجد تحليل مرتبط بهذا التشغيل'); return; }
          if (window.Workspace) window.Workspace.go('workflow', { runId: id, runLabel: source.workflowName || id, workflowId: run.workflowId, workflowName: run.workflowName || '' });
          if (typeof window.openWorkflowById === 'function') window.openWorkflowById(run.workflowId);
        });
        $('rs-src-explorer')?.addEventListener('click', () => {
          if (window.Workspace) window.Workspace.go('analysis', { sourceId: source.name || '', sourceName: source.label || '', runId: id });
        });
        $('rs-src-output')?.addEventListener('click', () => {
          window.open('/api/workflows/output/csv?id=' + encodeURIComponent(id), '_blank');
        });
      }
      setDirty(true);
      renderCanvas(); renderInspector(); syncJson();
      toast('تم جلب ' + columns.length + ' حقل من ' + (source.label || id));
      return true;
    } catch (e) { toast(e.message); return false; }
  }

  /** جلب أعمدة تشغيل محدَّد (يُستدعى من استوديو التحليل) — يُرجع نجاح/فشل */
  async function loadReportColumnsForRun(runId) {
    const id = (runId || ($('rs-runid') && $('rs-runid').value.trim()) || '').trim();
    if (!id) return false;
    const okFetch = await fetchRunColumns(id);
    if (okFetch === false) return false;
    if (!columns.length) { toast('لا أعمدة في التشغيل ' + id); return false; }
    renderCanvas(); renderInspector();
    return true;
  }
  /* متاح لواجهة التطبيق (زر «استخدمه في استوديو التقارير») */
  window.loadReportColumnsForRun = loadReportColumnsForRun;

  /* ---------------- فلاتر البيانات (على مستوى التقرير) ---------------- */
  function renderFilters() {
    const host = $('rs-filters-list'); if (!host) return;
    if (!reportFilters.length) {
      host.innerHTML = '<div class="hint">لا فلاتر — كل الصفوف تظهر. أضف فلترًا لتقييد النتائج.</div>';
    } else {
      host.innerHTML = reportFilters.map((f, i) =>
        '<div class="rd-filter" data-i="' + i + '">'
        + '<select class="wf-select" data-f="column">' + colOpts(f.column) + '</select>'
        + '<select class="wf-select" data-f="op">' + FILTER_OPS.map(o =>
          '<option value="' + o + '"' + (f.op === o ? ' selected' : '') + '>' + o + '</option>').join('') + '</select>'
        + '<input class="input sm" data-f="value" value="' + esc(f.value === undefined ? '' : f.value) + '" placeholder="القيمة" />'
        + '<button type="button" class="btn xs danger" data-del-filter="' + i + '">حذف</button>'
        + '</div>').join('');
      host.querySelectorAll('[data-f]').forEach(inp => {
        inp.addEventListener('change', () => {
          const row = inp.closest('[data-i]');
          const i = Number(row.getAttribute('data-i'));
          if (!reportFilters[i]) return;
          const key = inp.getAttribute('data-f');
          reportFilters[i][key] = key === 'value' ? inp.value : inp.value;
          setDirty(true); syncJson(); scheduleLivePreview();
        });
      });
      host.querySelectorAll('[data-del-filter]').forEach(b => {
        b.addEventListener('click', () => {
          const i = Number(b.getAttribute('data-del-filter'));
          reportFilters.splice(i, 1);
          setDirty(true); renderFilters(); syncJson(); scheduleLivePreview();
        });
      });
    }
    const cnt = $('rs-filters-count');
    if (cnt) cnt.textContent = reportFilters.length ? reportFilters.length + ' فلتر' : '';
  }
  function addFilter() {
    if (reportFilters.length >= 10) { toast('الحد الأقصى 10 فلاتر'); return; }
    if (!columns.length) { toast('اختر مصدر بيانات أولًا (تظهر أعمدته هنا)'); return; }
    reportFilters.push({ column: columns[0], op: '==', value: '' });
    setDirty(true); renderFilters(); syncJson();
  }

  /* ---------------- استيراد تقرير قائم من التطبيق ---------------- */
  /** قائمة التقارير القائمة في التطبيق (فهرس الخادم) */
  function syncFiltersColumns() {
    if (!reportFilters.length) return;
    const known = new Set(columns);
    for (const f of reportFilters) if (!known.has(f.column) && columns.length) f.column = columns[0];
    renderFilters();
  }

  async function loadLegacyList() {
    const sel = $('rs-legacy-list'); if (!sel) return;
    try {
      const list = await apiCall('/api/reports');
      const items = Array.isArray(list) ? list : (list && list.items) || [];
      sel.innerHTML = '<option value="">— اختر تقريرًا من التطبيق —</option>';
      for (const it of items) {
        const o = document.createElement('option');
        o.value = it.name || it.key || '';
        o.textContent = (it.label || it.name || '') + (it.desc ? ' — ' + it.desc.slice(0, 60) : '');
        sel.appendChild(o);
      }
    } catch (e) { /* القائمة غير متاحة (خادم أقدم) — يبقى الحقل فارغًا */ }
    probeLegacyImport();
  }

  /** فحص توفّر مسار الاستيراد في النسخة المشغّلة (لا ادّعاء accomplishment) */
  async function probeLegacyImport() {
    const cap = $('rs-legacy-cap');
    const btn = $('rs-legacy-import');
    try {
      /* اسم غير معروف ⇒ الخادم المتوافق يرد 400 (المسار موجود) والقديم يرد 404 */
      await apiCall('/api/reports/import-legacy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '__capability_probe__' }),
      });
      if (cap) cap.textContent = '✅ مسار الاستيراد متاح في هذه النسخة.';
      if (btn) btn.disabled = false;
      return true;
    } catch (e) {
      const st = e && e.status;
      if (st === 400) {
        if (cap) cap.textContent = '✅ مسار الاستيراد متاح في هذه النسخة.';
        if (btn) btn.disabled = false;
        return true;
      }
      if (st === 404) {
        if (cap) cap.textContent = '⚠️ مسار الاستيراد غير موجود في النسخة المشغّلة — الاستيراد سيعمل بعد إعادة تشغيل الخادم (تحقّق منه على الخادم نفسه).';
        if (btn) btn.disabled = true;
        return false;
      }
      if (cap) cap.textContent = 'تعذّر فحص المسار: ' + (e && e.message ? e.message : e);
      if (btn) btn.disabled = true;
      return false;
    }
  }

  /** استيراد تقرير قائم من التطبيق */
  async function importLegacy() {
    const name = ($('rs-legacy-list') && $('rs-legacy-list').value) || '';
    const msg = $('rs-legacy-msg');
    if (!name) { if (msg) msg.textContent = 'اختر تقريرًا أولًا'; return; }
    if (!confirmDiscard()) { if (msg) msg.textContent = 'تم الإلغاء — لم تُفقد تعديلاتك'; return; }
    try {
      if (msg) msg.textContent = 'جارٍ استخراج «' + name + '» …';
      const out = await apiCall('/api/reports/import-legacy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      const def = (out && out.report) || {};
      const ex = (out && out.extraction) || {};
      comps = (def.components || []).map((c, i) => Object.assign({}, c, { id: c.id || 'i' + (i + 1) }));
      if (def.layout) layout = def.layout;
      legacySource = def.legacy || { name, params: {} };
      legacyNotes = ex.notes || [];
      columns = ((ex.runtime && ex.runtime.columns) || []).map(c => c.name);
      renderFilters();
      source = { name: legacySource.name, label: (ex.label || name), legacy: true, traced: false };
      if ($('rs-name')) $('rs-name').value = def.name || name;
      if ($('rs-title')) $('rs-title').value = def.title || (ex.label || name);
      if ($('rs-description')) $('rs-description').value = def.description || '';
      const idEl = $('rs-id'); if (idEl) idEl.value = '';   /* حفظ كنسخة جديدة — الأصل لا يُستبدل */
      reportId = '';
      setDirty(true);
      renderCanvas(); renderInspector(); syncJson();
      renderLegacyNotes(ex);
      if (msg) msg.textContent = 'تم الاستيراد: ' + (ex.label || name)
        + ' — ' + ((ex.runtime && ex.runtime.columns) || []).length + ' عمود'
        + (ex.runtime && ex.runtime.ok ? '' : ' (تعذّر تنفيذ التقرير الأصلي — استُخرج التعريف من الكود فقط)');
      toast('تم استيراد التقرير في المصمم (الأصل لم يُمس)');
    } catch (e) {
      if (msg) msg.textContent = 'تعذّر الاستيراد: ' + e.message;
    }
  }

  /** عرض ما استُخرج وما لم يُستخرج */
  function renderLegacyNotes(ex) {
    const host = $('rs-legacy-notes'); if (!host) return;
    const e = ex || {};
    const cols = (e.runtime && e.runtime.columns) || [];
    const declared = e.declared || [];
    const diff = e.diff || {};
    let h = '';
    if (e.runtime && e.runtime.ok) {
      h += '<div class="rd-note ok"><b>مستخرج من ناتج التقرير الحقيقي</b><span>'
        + cols.length + ' عمود · ' + (e.runtime.rowCount || 0) + ' صف · المصدر: ' + esc(e.label || e.name) + '</span></div>';
    } else {
      h += '<div class="rd-note warn"><b>تعذّر تنفيذ التقرير الأصلي</b><span>'
        + esc((e.runtime && e.runtime.error) || 'سبب غير معروف')
        + ' — الأعمدة أدناه من التصريح المسجَّل فقط (غير مُثبتة ببيانات).</span></div>';
    }
    if (cols.length) {
      h += '<div class="rd-note"><b>الأعمدة</b><span>' + cols.map(c =>
        esc(c.name) + ' <i>' + esc(c.type) + '</i> [' + esc(c.evidence) + ']').join(' · ') + '</span></div>';
    }
    if (declared.length) {
      h += '<div class="rd-note"><b>مصرَّح به في سجل الشاشات</b><span>' + declared.map(d => esc(d.name)).join(' · ') + '</span></div>';
    }
    if ((diff.missingAtRuntime || []).length) {
      h += '<div class="rd-note warn"><b>مصرَّح به ولم يظهر في الناتج</b><span>' + diff.missingAtRuntime.map(esc).join(' · ') + '</span></div>';
    }
    if ((diff.notDeclared || []).length) {
      h += '<div class="rd-note"><b>في الناتج وغير مصرَّح به</b><span>' + diff.notDeclared.map(esc).join(' · ') + '</span></div>';
    }
    if (e.code && (e.code.tables || []).length) {
      h += '<div class="rd-note"><b>جداول مرجَّحة من الشيفرة (استدلال)</b><span>' + e.code.tables.map(esc).join(' · ') + '</span></div>';
    }
    if (e.code && (e.code.params || []).length) {
      h += '<div class="rd-note"><b>معاملات/فلاتر مدعومة (استدلال)</b><span>' + e.code.params.map(esc).join(' · ') + '</span></div>';
    }
    if ((e.notes || []).length) {
      h += '<ul class="rd-note-list">' + e.notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>';
    }
    host.innerHTML = h;
  }

  /* ---------------- التقارير: قائمة/فتح/حفظ ---------------- */
  async function loadList() {
    try {
      const d = await apiCall('/api/reports/saved');
      const sel = $('rs-list'); if (!sel) return;
      const cur = sel.value;
      sel.innerHTML = '<option value="">— اختر تقريرًا —</option>';
      (d.items || []).forEach(it => {
        const o = document.createElement('option');
        o.value = it.id;
        o.textContent = (it.name || it.id) + ' (' + it.id + ')'
          + (it.source && it.source.label ? ' — ' + it.source.label : '');
        sel.appendChild(o);
      });
      if (cur) sel.value = cur;
    } catch (e) { toast(e.message); }
  }
  async function loadSelected() {
    const id = $('rs-list').value; if (!id) { toast('اختر تقريرًا'); return; }
    if (!confirmDiscard()) { toast('تم الإلغاء — لم تُفقد تعديلاتك'); return; }
    try {
      const r = await apiCall('/api/reports/get?id=' + encodeURIComponent(id));
      const norm = S ? S.normalizeReport(r) : r;
      $('rs-name').value = r.name || '';
      const idEl = $('rs-id'); if (idEl) idEl.value = r.id || id;
      reportId = r.id || id;
      comps = norm.components || [];
      layout = norm.layout || layout;
      if ($('rs-title')) $('rs-title').value = r.title || '';
      if ($('rs-description')) $('rs-description').value = r.description || '';
      source = r.source || null;
      $('rs-runid').value = r.runId || '';
      columns = [];
      setDirty(false);
      resetHistory();
      renderCanvas(); renderInspector(); syncJson();
      if (r.runId) await fetchRunColumns(r.runId);
      renderFilters();
      toast('تم الفتح: ' + (r.name || reportId));
    } catch (e) { toast(e.message); }
  }
  async function save(asNew) {
    let name = ($('rs-name').value || 'تقرير').trim();
    if (asNew) {
      const base = name.replace(/\s*-\s*نسخة(\s*\(\d+\))?$/, '');
      let candidate = base + ' - نسخة';
      let n = 2;
      const taken = new Set(((await apiCall('/api/reports/saved')).items || []).map(x => x.name));
      while (taken.has(candidate)) { candidate = base + ' - نسخة (' + n + ')'; n++; }
      name = candidate;
      $('rs-name').value = name;
    }
    const idEl = $('rs-id');
    const id = asNew ? '' : ((idEl && idEl.value.trim()) || reportId || '');
    const def = definition();
    def.name = name;
    if (id) def.id = id;
    try {
      busy('جاري الحفظ…');
      const r = await apiCall('/api/reports/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ report: def }),
      });
      reportId = r.id;
      if (idEl) idEl.value = r.id;
      setDirty(false);
      busy('✅ تم الحفظ: ' + r.id);
      toast(asNew ? ('تم الحفظ باسم: ' + r.id) : ('تم الحفظ: ' + r.id));
      await loadList();
      const sel = $('rs-list'); if (sel) sel.value = r.id;
    } catch (e) {
      busy('❌ تعذّر الحفظ: ' + e.message);
      toast('تعذّر الحفظ: ' + e.message);
    }
  }
  async function remove() {
    const id = ($('rs-id') && $('rs-id').value.trim()) || reportId;
    if (!id) { toast('اختر تقريرًا محفوظًا أولًا'); return; }
    if (!window.confirm('حذف التقرير «' + id + '» نهائيًا؟')) return;
    try {
      await apiCall('/api/reports/delete?id=' + encodeURIComponent(id), { method: 'POST' });
      toast('تم الحذف');
      $('rs-id').value = '';
      reportId = '';
      comps = [];
      setDirty(false);
      renderCanvas(); renderInspector(); syncJson();
      await loadList();
    } catch (e) { toast(e.message); }
  }

  /* ---------------- معاينة/تحقق/تصدير ---------------- */
  async function validate() {
    const def = definition();
    if (S) {
      const v = S.validateReport(def);
      if (!v.ok) { busy('❌ ' + v.errors.join(' · ')); return; }
    }
    try {
      busy('جاري التحقق…');
      const runId = ($('rs-runid') && $('rs-runid').value.trim()) || '';
      const r = await apiCall('/api/reports/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: def, runId }),
      });
      if (r.ok) { busy('✅ تعريف التقرير صالح'); return; }
      /* الأخطاء تُعرض كاملة — لا تُختصر ولا تُخفى */
      const list = (r.errors && r.errors.length) ? r.errors : [r.error || 'خطأ غير معروف'];
      busy('❌ ' + list.join(' · '));
      showErrorList(list);
    } catch (e) { busy('❌ ' + e.message); }
  }
  async function preview() {
    const def = definition();
    const runId = ($('rs-runid') && $('rs-runid').value.trim()) || '';
    try {
      busy('جاري المعاينة…');
      const payload = { report: def, runId };
      if (legacySource && legacySource.name) payload.legacy = legacySource;
      const r = await apiCall('/api/reports/render', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const host = $('rs-result');
      const errs = (r.errors && r.errors.length) ? r.errors : [];
      if (host) {
        const src = source && source.label ? source.label + ' · ' + runId : (runId || 'لا مصدر محدد');
        host.innerHTML = '<div class="hint">مصدر المعاينة: ' + esc(src) + '</div>'
          + (errs.length ? errorListHtml(errs) : '')
          + (r.html || (r.rows === 0 ? '<div class="hint">لا توجد بيانات لعرضها.</div>' : ''));
      }
      busy(errs.length
        ? ('⚠️ معاينة: ' + (r.count || 0) + ' عنصر · ' + (r.rows || 0) + ' صف · تعذّر حساب ' + errs.length + ' عنصر (العمود غير موجود في البيانات)')
        : ('✅ معاينة: ' + (r.count || 0) + ' عنصر · ' + (r.rows || 0) + ' صف'
          + (runId ? ' · المصدر: ' + runId : ' · لا مصدر محدد')));
    } catch (e) {
      busy('❌ ' + e.message);
      const host = $('rs-result'); if (host) host.innerHTML = '<div class="neg">' + esc(e.message) + '</div>';
    }
  }
  /* قائمة الأخطاء المعروضة (فوق المعاينة/تحت الحالة) — لا تُخفى ولا تُقصّ */
  function errorListHtml(list) {
    return '<div class="neg" style="padding:10px 12px;margin:8px 0"><b>تعذّر حساب ' + list.length + ' عنصر:</b><ul style="margin:6px 0 0;padding-inline-start:18px">'
      + list.map(m => '<li>' + esc(m) + '</li>').join('') + '</ul></div>';
  }
  function showErrorList(list) {
    const host = $('rs-result');
    if (host) host.innerHTML = errorListHtml(list);
  }

  function exportUrl(kind) {
    const id = ($('rs-id') && $('rs-id').value.trim()) || reportId;
    if (!id) { toast('احفظ التقرير أولاً'); return null; }
    return '/api/reports/export/' + kind + '?id=' + encodeURIComponent(id);
  }
  function exportCsv() {
    const runId = ($('rs-runid') && $('rs-runid').value.trim()) || '';
    if (!runId) { toast('اختر مصدر البيانات أولًا'); return; }
    window.open('/api/workflows/output/csv?id=' + encodeURIComponent(runId), '_blank');
  }
  function openPrintFallback(id) {
    const url = '/api/reports/export/print?id=' + encodeURIComponent(id) + '&auto=1';
    const w = window.open(url, '_blank');
    if (!w) {
      toast('تعذّر فتح نافذة الطباعة — اسمح بالنوافذ المنبثقة لهذا الموقع ثم أعد المحاولة');
      return false;
    }
    toast('فُتح عرض الطباعة — اختر «حفظ كـ PDF» من نافذة الطباعة');
    return true;
  }
  async function exportPdf() {
    const id = ($('rs-id') && $('rs-id').value.trim()) || reportId;
    if (!id) { toast('احفظ التقرير أولاً'); return; }
    let cap = null;
    try {
      const caps = await apiCall('/api/reports/capabilities');
      cap = (caps && caps.capabilities) || caps || {};
    } catch (_) { cap = null; }
    if (cap && cap.pdf) {
      window.open('/api/reports/export/pdf?id=' + encodeURIComponent(id), '_blank');
      return;
    }
    /* لا حزم PDF عربية على الخادم ⇒ طباعة المتصفح إلى PDF بنفس بيانات التقرير */
    openPrintFallback(id);
  }

  /* ---------------- التهيئة ---------------- */
  function newReport() {
    if (!confirmDiscard()) { toast('تم الإلغاء — لم تُفقد تعديلاتك'); return; }
    $('rs-name').value = 'تقرير_' + Date.now();
    const idEl = $('rs-id'); if (idEl) idEl.value = '';
    reportId = '';
    $('rs-runid').value = '';
    columns = [];
    source = null;
    comps = [];
    selectedId = null;
    reportFilters = [];
    setDirty(false);
    resetHistory();
    renderCanvas(); renderInspector(); syncJson();
    const host = $('rs-result'); if (host) host.innerHTML = '';
    busy('');
    const info = $('rs-source-info'); if (info) info.textContent = '';
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('rs-new')?.addEventListener('click', newReport);
    $('rs-load')?.addEventListener('click', loadSelected);
    $('rs-save')?.addEventListener('click', () => save(false));
    $('rs-save-as')?.addEventListener('click', () => save(true));
    $('rs-delete')?.addEventListener('click', remove);
    /* إعادة الهيكلة من الصفر: تفريغ المكوّنات مع الحفاظ على المصدر والهوية */
    $('rs-rebuild')?.addEventListener('click', () => {
      if (!comps.length) { toast('لا توجد مكوّنات لإعادة هيكلتها'); return; }
      if (!window.confirm('إعادة الهيكلة ستفرغ كل المكوّنات الحالية (' + comps.length + ') وتُبقي المصدر والهوية.\nهل تريد المتابعة؟')) return;
      const keepRun = ($('rs-runid') && $('rs-runid').value.trim()) || '';
      const keepName = ($('rs-name') && $('rs-name').value.trim()) || '';
      const keepTitle = ($('rs-title') && $('rs-title').value.trim()) || '';
      const keepDesc = ($('rs-description') && $('rs-description').value.trim()) || '';
      const keepId = ($('rs-id') && $('rs-id').value.trim()) || '';
      comps = [];
      selectedId = null;
      reportFilters = [];
      layout = { columns: 12, gap: 12 };
      if ($('rs-runid')) $('rs-runid').value = keepRun;
      if ($('rs-name')) $('rs-name').value = keepName;
      if ($('rs-title')) $('rs-title').value = keepTitle;
      if ($('rs-description')) $('rs-description').value = keepDesc;
      if ($('rs-id')) $('rs-id').value = keepId;
      setDirty(true);
      resetHistory();
      renderCanvas(); renderInspector(); renderFilters(); syncJson();
      toast('أُفرغت المكوّنات — ابدأ البناء من جديد (اضغط «حفظ» للاعتماد)');
    });
    /* إدراج التقرير في شاشة (موجودة أو جديدة) — عبر مصمم الشاشات */
    $('rs-to-screen')?.addEventListener('click', async () => {
      const btn = $('rs-to-screen');
      const info = $('rs-to-screen-msg');
      const def = definition();
      if (!def.runId) { toast('اختر مصدر التشغيل أولاً'); if (info) info.textContent = 'لا يوجد مصدر تشغيل'; return; }
      if (btn) btn.disabled = true;
      if (info) info.textContent = 'جارٍ الإدراج…';
      try {
        const rep = Object.assign({}, def, { id: ($('rs-id') && $('rs-id').value.trim()) || '' });
        if (typeof window.insertReportIntoScreen === 'function') {
          const id = await window.insertReportIntoScreen(rep);
          if (info) info.textContent = id ? ('أُدرج في الشاشة: ' + id) : 'لم يتم الإدراج';
        } else if (info) info.textContent = 'مصمم الشاشات غير محمّل';
      } finally {
        if (btn) btn.disabled = false;
      }
    });
    $('rs-validate')?.addEventListener('click', validate);
    $('rs-preview')?.addEventListener('click', preview);
    $('rs-export')?.addEventListener('click', () => { const u = exportUrl('html'); if (u) window.open(u, '_blank'); });
    $('rs-export-xlsx')?.addEventListener('click', () => { const u = exportUrl('xlsx'); if (u) window.open(u, '_blank'); });
    $('rs-export-csv')?.addEventListener('click', exportCsv);
    $('rs-export-pdf')?.addEventListener('click', exportPdf);
    $('rs-apply-json')?.addEventListener('click', applyJson);
    $('rs-loadrun')?.addEventListener('click', () => fetchRunColumns());
    $('rs-quick')?.addEventListener('click', openQuickPanel);
    $('rs-quick-source')?.addEventListener('change', loadQuickFields);
    $('rs-quick-create')?.addEventListener('click', createQuickRun);
    $('rs-runlist')?.addEventListener('change', () => {
      if (!$('rs-runlist').value) return;
      if (!confirmDiscard()) { const cur = $('rs-runid'); if (cur) $('rs-runid').value = cur.value; toast('تم الإلغاء — لم تُفقد تعديلاتك'); return; }
      fetchRunColumns($('rs-runlist').value);
    });
    const runidInput = $('rs-runid');
    if (runidInput) runidInput.addEventListener('change', () => { if (confirmDiscard()) fetchRunColumns(runidInput.value.trim()); });
    const addMap = {
      'rs-add-kpi': 'kpi', 'rs-add-table': 'table', 'rs-add-bar': 'bar', 'rs-add-line': 'line',
      'rs-add-pie': 'pie', 'rs-add-heading': 'heading', 'rs-add-text': 'text', 'rs-add-divider': 'divider',
      'rs-add-shape': 'shape',
    };
    Object.keys(addMap).forEach(bid => {
      const btn = $(bid);
      if (!btn) return;
      btn.addEventListener('click', () => {
        const c = newComp(addMap[bid]);
        comps.push(c);
        selectedId = c.id;
        setDirty(true);
        renderCanvas(); renderInspector(); syncJson();
      });
    });
    document.querySelectorAll('#rs-tabs .rd-tab').forEach(b => {
      b.addEventListener('click', () => { tab = b.dataset.rt; renderInspector(); });
    });
    $('rs-legacy-import')?.addEventListener('click', importLegacy);
    $('rs-add-filter')?.addEventListener('click', addFilter);
    $('rs-undo')?.addEventListener('click', undo);
    $('rs-redo')?.addEventListener('click', redo);
    $('rs-live')?.addEventListener('click', toggleLive);
    liveLabel();
    /* اختصارات: Ctrl+Z تراجع · Ctrl+Y / Ctrl+Shift+Z إعادة (خارج حقول الإدخال) */
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = (e.key || '').toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      const t = e.target;
      const tag = (t && t.tagName) ? t.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;
      const sec = document.getElementById('tab-report-studio');
      if (!sec || !sec.classList.contains('active')) return;
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo(); else undo();
    });
    loadList(); loadRuns(); loadSavedFormulas(); loadLegacyList();
    renderCanvas(); renderInspector(); renderFilters(); syncJson();
    if (!S) busy('⚠️ لم يُحمَّل نموذج التقرير الموحّد (إعادة تشغيل الخادم مطلوبة) — سيعمل المصمم بلا تطبيع مسبق');
  });

  /** فتح تقرير قائم في لوحة الاستيراد (من المستكشف) */
  window.openLegacyImport = async function (key) {    if (!key) return false;
    goTab('report-studio');
    await loadLegacyList();
    const sel = $('rs-legacy-list');
    if (sel) {
      const opt = Array.from(sel.options).find(o => o.value === key);
      if (!opt) { toast('التقرير «' + key + '» غير متاح في فهرس التقارير'); return false; }
      sel.value = key;
    }
    await importLegacy();
    return true;
  };
  window.loadReportStudioTab = function () { loadList(); loadRuns(); loadSavedFormulas(); loadLegacyList(); renderCanvas(); renderInspector(); renderFilters(); syncJson(); };
  /* تُستدعى من مركز العمل وإدارة التقارير */
  window.openQuickReport = function () { openQuickPanel(); };
  window.loadReportIntoDesigner = async function (id) {
    if (!id) return;
    const r = await apiCall('/api/reports/get?id=' + encodeURIComponent(id));
    const norm = S ? S.normalizeReport(r) : r;
    if ($('rs-name')) $('rs-name').value = r.name || '';
    const idEl = $('rs-id'); if (idEl) idEl.value = r.id || id;
    comps = norm.components || [];
    if (norm.layout) layout = norm.layout;
    legacySource = norm.legacy || null;
    reportFilters = Array.isArray(norm.filters) ? norm.filters : [];
    legacyNotes = [];
    if (norm.legacy && norm.legacy.name) {
      columns = [];
      legacyNotes = ['هذا التقرير مستورد من تقرير قائم: ' + norm.legacy.name + ' — المعاينة تستخدم ناتج ذلك التقرير.'];
    }
    if ($('rs-title')) $('rs-title').value = r.title || '';
    if ($('rs-description')) $('rs-description').value = r.description || '';
    source = r.source || null;
    if ($('rs-runid')) $('rs-runid').value = r.runId || '';
    columns = [];
    rsTrace = null;
    setDirty(false);
    resetHistory();
    renderCanvas(); renderInspector(); syncJson();
    if (r.runId) await fetchRunColumns(r.runId);
    toast('تم فتح التقرير: ' + (r.name || id));
  };
})();
