/* ============================================================
 * مصمم الشاشات المخصّصة + تشغيلها داخل التطبيق
 * ============================================================
 * الشاشة المخصّصة = تعريف محفوظ (src/app-screen.js) مكوّناته من محرّك
 * التقارير نفسه (مصدر واحد للحساب) ⇒ الشاشة لا تحسب أي رقم.
 *
 * - إنشاء/تعديل/نسخ/إعادة تسمية/حذف شاشة (معرّف فريد يبدأ بـ cs_)
 * - ربط الشاشة بنتيجة تشغيل محفوظة (تحليل) ⇒ أعمدة حقيقية
 * - مكوّنات: عنوان · نص · فاصل · شكل · بطاقة/مؤشر · جدول · مخططات
 * - مدخلات (فلاتر) مربوطة بأعمدة ⇒ تُطبَّق في المحرك مع عرض الصفوف
 * - أزرار مرتبطة بإجراءات حقيقية: إجراء مسجَّل · انتقال لشاشة · فتح تقرير محفوظ
 * - معاينة حقيقية (تصيير من المحرك) ثم حفظ وإعادة فتح
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
  function msg(t) { const m = $('ss-msg'); if (m) m.textContent = t || ''; }
  function notify(t) { if (typeof toast === 'function') toast(t); }

  const M = () => (window.AppScreen || null);
  const S = () => (window.ReportSchema || null);

  const TYPE_LABEL = {
    kpi: 'بطاقة/مؤشر', table: 'جدول', bar: 'مخطط أعمدة', line: 'مخطط خطي',
    pie: 'مخطط دائري', heading: 'عنوان', text: 'نص', divider: 'فاصل', shape: 'شكل',
  };
  const AGG_LABEL = { sum: 'مجموع', avg: 'متوسط', count: 'عدد', min: 'أدنى', max: 'أقصى' };
  const OP_LABEL = {
    '==': 'يساوي', '!=': 'لا يساوي', '>': 'أكبر من', '>=': 'أكبر أو يساوي',
    '<': 'أصغر من', '<=': 'أصغر أو يساوي', contains: 'يحتوي', startsWith: 'يبدأ بـ',
    in: 'من قائمة', notEmpty: 'غير فارغ', empty: 'فارغ',
  };
  const INPUT_TYPE_LABEL = { select: 'قائمة', text: 'نص', number: 'رقم', date: 'تاريخ' };
  const PALETTE = ['heading', 'text', 'divider', 'shape', 'kpi', 'table', 'bar', 'line', 'pie'];

  /* ==================================================================
   * 1) التشغيل: بناء الشاشات المخصّصة وعرضها داخل التطبيق
   * ================================================================== */
  const Runtime = {
    items: [],        /* {id,name,...} */
    defs: new Map(),  /* id → التعريف */
    mounted: false,
  };

  async function fetchScreens() {
    try {
      const r = await apiCall('/api/screens/custom');
      Runtime.items = (r && r.items) ? r.items : [];
    } catch (e) { Runtime.items = []; }
    return Runtime.items;
  }

  /** الشاشات المسموح بها للمستخدم الحالي (نفس منطق الصلاحيات في app.js) */
  function allowedScreens() {
    const admin = (typeof me !== 'undefined' && me && me.role === 'admin');
    return Runtime.items.filter(s => {
      if (admin) return true;
      if (typeof me === 'undefined' || !me || !Array.isArray(me.tabs) || !me.tabs.length) return true;
      return me.tabs.indexOf(s.id) >= 0;
    });
  }

  /** يبني قائمة الشريط وقسم الشاشة لكل شاشة مخصّصة */
  function mountScreens() {
    const main = document.querySelector('main');
    const menu = $('nav-custom-menu');
    const list = allowedScreens();
    if (typeof DROP_SUBS !== 'undefined') DROP_SUBS.custom = list.map(s => s.id);
    if (menu) {
      menu.innerHTML = list.length
        ? list.map(s => '<button data-grp="custom" data-goto="' + esc(s.id) + '"><i>▤</i><span>' + esc(s.name || s.id) + '</span></button>').join('')
        : '<div class="muted xs" style="padding:8px">لا توجد شاشات مخصّصة متاحة</div>';
    }
    /* فتح الشاشات المخصّصة من داخل المنصة (بديل زر الشريط الخارجي) */
    const openHost = $('ss-custom-open');
    const openRow = $('ss-custom-open-row');
    if (openHost) {
      openHost.innerHTML = list.length
        ? list.map(s => '<button type="button" class="btn xs ghost" data-cs-open="' + esc(s.id) + '">'
            + esc(s.name || s.id) + '</button>').join('')
        : '<span class="muted xs">لا توجد شاشات مخصّصة محفوظة بعد.</span>';
      if (openRow) openRow.hidden = false;
      if (!openHost.getAttribute('data-wired')) {
        openHost.setAttribute('data-wired', '1');
        openHost.addEventListener('click', (e) => {
          const b = e.target.closest('[data-cs-open]');
          if (b) window.openCustomScreen(b.getAttribute('data-cs-open'));
        });
      }
    }
    for (const s of list) {
      const sec = document.getElementById('tab-' + s.id);
      if (!sec && main) {
        const el = document.createElement('section');
        el.id = 'tab-' + s.id;
        el.className = 'wf-section';
        el.innerHTML =
          '<div class="card">'
          + '<div class="card-h"><h3>' + esc(s.name || s.id) + '</h3><span class="muted xs ss-meta"></span></div>'
          + '<div class="ss-toolbar"><div class="ss-btns"></div><div class="ss-filters"></div>'
          + '<button type="button" class="btn sm ghost ss-refresh">تحديث</button></div>'
          + '<div class="ss-body"><div class="hint">جارٍ التحميل…</div></div>'
          + '</div>';
        main.appendChild(el);
        el.querySelector('.ss-refresh').addEventListener('click', () => renderScreen(s.id, true));
      }
    }
    /* تحديث حالة الإظهار حسب الصلاحيات */
    if (typeof applyRoleUI === 'function') { try { applyRoleUI(); } catch (e) { /* تجاهل */ } }
    Runtime.mounted = true;
  }

  async function loadDef(id) {
    if (Runtime.defs.has(id)) return Runtime.defs.get(id);
    const r = await apiCall('/api/screens/custom/get?id=' + encodeURIComponent(id));
    const def = M() ? M().normalizeScreen(r) : r;
    Runtime.defs.set(id, def);
    return def;
  }

  /** يرسم الشاشة: أزرار + مدخلات + تصيير المكوّنات عبر محرّك التقارير */
  async function renderScreen(id, force) {
    const sec = document.getElementById('tab-' + id);
    if (!sec) return;
    const body = sec.querySelector('.ss-body');
    const meta = sec.querySelector('.ss-meta');
    let def;
    try {
      def = await loadDef(id);
    } catch (e) {
      body.innerHTML = '<div class="hint">تعذّر تحميل الشاشة: ' + esc(e.message) + '</div>';
      return;
    }
    const head = sec.querySelector('.card-h h3');
    if (head) head.textContent = def.name || id;
    if (meta) {
      meta.textContent = def.source && def.source.runId
        ? 'مصدر: ' + def.source.runId + (def.components.length ? ' · ' + def.components.length + ' مكوّن' : '')
        : (def.components.length ? def.components.length + ' مكوّن' : 'بلا مصدر بيانات');
    }
    const values = {};
    renderButtons(sec, def);
    await renderFilters(sec, def, values);
    if (!def.source || !def.source.runId) {
      body.innerHTML = '<div class="hint">لا يوجد مصدر بيانات لهذه الشاشة — اربطها بتشغيل محفوظ من «مصمم الشاشات».</div>';
      return;
    }
    body.innerHTML = '<div class="hint">جارٍ التصيير…</div>';
    try {
      const payload = M() ? M().composeRenderPayload(def, values) : { report: { components: def.components } };
      const r = await apiCall('/api/reports/render', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: payload.report, runId: def.source.runId }),
      });
      const html = (r && (r.html || (r.data && r.data.html))) || '';
      body.innerHTML = html || '<div class="hint">لم يُرجع المحرك محتوى.</div>';
    } catch (e) {
      body.innerHTML = '<div class="hint">تعذّر تصيير الشاشة: ' + esc(e.message) + '</div>';
    }
  }

  function renderButtons(sec, def) {
    const host = sec.querySelector('.ss-btns');
    if (!host) return;
    host.innerHTML = (def.buttons || []).map(b =>
      '<button type="button" class="btn sm" data-ss-btn="' + esc(b.id) + '" data-kind="' + esc(b.action.kind) + '" data-aid="' + esc(b.action.id) + '">'
      + esc(b.label || b.action.id) + '</button>').join('');
    host.querySelectorAll('[data-ss-btn]').forEach(btn => {
      btn.addEventListener('click', () => runScreenAction(btn.getAttribute('data-kind'), btn.getAttribute('data-aid'), sec));
    });
  }

  async function runScreenAction(kind, aid, sec) {
    try {
      if (kind === 'registered') {
        if (window.UiActions && typeof window.UiActions.run === 'function') {
          const okRun = window.UiActions.run(aid);
          if (!okRun) notify('الإجراء غير متاح في هذه الشاشة');
          return;
        }
        notify('لا توجد إجراءات مسجَّلة');
        return;
      }
      if (kind === 'goto') {
        if (typeof goTab === 'function') goTab(aid);
        return;
      }
      if (kind === 'openReport') {
        if (typeof window.loadReportIntoDesigner === 'function') {
          await window.loadReportIntoDesigner(aid);
          if (typeof goTab === 'function') goTab('report-studio');
        } else notify('تعذّر فتح التقرير');
        return;
      }
      if (kind === 'refresh') {
        const id = sec && sec.id ? sec.id.replace(/^tab-/, '') : '';
        if (id) await renderScreen(id, true);
      }
    } catch (e) { notify('تعذّر تنفيذ الإجراء: ' + e.message); }
  }

  async function renderFilters(sec, def, values) {
    const host = sec.querySelector('.ss-filters');
    if (!host) return;
    const inputs = (M() ? M().inputsSchema(def) : def.inputs) || [];
    if (!inputs.length) { host.innerHTML = ''; return; }
    let distinct = {};
    if (def.source && def.source.runId) {
      try {
        const out = await apiCall('/api/workflows/output?id=' + encodeURIComponent(def.source.runId));
        const rows = (out && out.rows) ? out.rows : [];
        inputs.forEach(inp => {
          if (inp.type !== 'select') return;
          const set = new Set();
          rows.slice(0, 5000).forEach(r => {
            const v = r ? r[inp.column] : null;
            if (v !== null && v !== undefined && v !== '') set.add(String(v));
          });
          distinct[inp.column] = Array.from(set).slice(0, 100);
        });
      } catch (e) { /* بلا قوائم ⇒ نص حر */ }
    }
    host.innerHTML = inputs.map(inp => {
      const id = 'ssf-' + inp.id;
      const label = '<label class="ss-filter-l" for="' + esc(id) + '">' + esc(inp.label || inp.column) + '</label>';
      if (inp.type === 'select') {
        const opts = (distinct[inp.column] || []).map(v => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
        return '<span class="ss-filter">' + label
          + '<select class="wf-select" id="' + esc(id) + '" data-inp="' + esc(inp.id) + '" data-op="' + esc(inp.op) + '" data-col="' + esc(inp.column) + '">'
          + '<option value="">— الكل —</option>' + opts + '</select></span>';
      }
      const type = inp.type === 'number' ? 'number' : (inp.type === 'date' ? 'date' : 'text');
      return '<span class="ss-filter">' + label
        + '<input class="wf-input" type="' + type + '" id="' + esc(id) + '" data-inp="' + esc(inp.id) + '" data-op="' + esc(inp.op) + '" data-col="' + esc(inp.column) + '" placeholder="' + esc(OP_LABEL[inp.op] || inp.op) + '" /></span>';
    }).join('');
    host.querySelectorAll('[data-inp]').forEach(el => {
      el.addEventListener('change', () => {
        values[el.getAttribute('data-inp')] = el.value;
        const id = sec.id.replace(/^tab-/, '');
        renderScreen(id, true);
      });
    });
  }

  window.AppScreens = {
    refresh: fetchScreens,
    mount: mountScreens,
    open: renderScreen,
    list: () => Runtime.items,
    getDef: loadDef,
  };

  /* ==================================================================
   * 2) المصمم: إنشاء الشاشات وربطها
   * ================================================================== */
  const Studio = {
    list: [],
    reports: [],       /* التقارير المحفوظة (لزر «فتح تقرير») */
    def: null,          /* التعريف الجاري تحريره */
    columns: [],        /* أعمدة مصدر الشاشة */
    runs: [],
    selected: null,     /* معرّف المكوّن المختار */
    selectedInput: null,
    selectedButton: null,
    dirty: false,
  };

  function setDirty(v) { Studio.dirty = !!v; }

  function currentDef() {
    if (!Studio.def) Studio.def = newDef('cs_' + stamp());
    return Studio.def;
  }
  function stamp() { return 'scr' + Date.now().toString(36).slice(-5); }
  function newDef(id) {
    const d = { id: id || ('cs_' + stamp()), name: 'شاشة جديدة', desc: '', components: [], inputs: [], buttons: [], buttonsPosition: 'top' };
    return d;
  }

  /* ---------- قائمة الشاشات ---------- */
  async function loadStudioList() {
    try {
      const r = await apiCall('/api/screens/custom');
      Studio.list = (r && r.items) ? r.items : [];
    } catch (e) { Studio.list = []; }
    try {
      const rr = await apiCall('/api/reports/saved');
      Studio.reports = (rr && rr.items) ? rr.items : [];
    } catch (e) { Studio.reports = []; }
    renderInsertReportSelect();
    renderScreenSelect();
  }

  /** قائمة التقارير المحفوظة (للإدراج داخل الشاشة) */
  function renderInsertReportSelect() {
    const sel = $('ss-insert-report'); if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">— اختر تقريرًا محفوظًا —</option>'
      + (Studio.reports || []).map(r => '<option value="' + esc(r.id) + '">' + esc(r.name || r.id)
        + (r.runId ? ' · ' + esc(r.runId) : '') + '</option>').join('');
    if (cur) sel.value = cur;
  }
  function renderScreenSelect() {
    const sel = $('ss-list'); if (!sel) return;
    sel.innerHTML = Studio.list.length
      ? Studio.list.map(s => '<option value="' + esc(s.id) + '">' + esc(s.name || s.id) + ' (' + esc(s.id) + ')</option>').join('')
      : '<option value="">— لا توجد شاشات محفوظة — أنشئ واحدة —</option>';
    if (Studio.def) sel.value = Studio.def.id;
  }

  /* ---------- مصدر البيانات (التشغيلات المحفوظة) ---------- */
  async function loadRuns() {
    try {
      const r = await apiCall('/api/workflows/outputs');
      Studio.runs = (r && r.items) ? r.items : [];
    } catch (e) { Studio.runs = []; }
    const sel = $('ss-run'); if (!sel) return;
    sel.innerHTML = '<option value="">— اختر تشغيلًا محفوظًا —</option>' + Studio.runs.map(x =>
      '<option value="' + esc(x.runId) + '">' + esc((x.source && (x.source.label || x.source.name)) || x.workflowName || x.runId)
      + ' · ' + esc(x.runId) + ' (' + (x.rowCount || 0) + ' صف)</option>').join('');
    if (Studio.def && Studio.def.source) sel.value = Studio.def.source.runId;
  }

  async function loadColumns(runId) {
    Studio.columns = [];
    if (!runId) { renderInspector(); return; }
    try {
      const out = await apiCall('/api/workflows/output?id=' + encodeURIComponent(runId));
      Studio.columns = (out && out.columns) ? out.columns : [];
    } catch (e) { Studio.columns = []; }
    const info = $('ss-run-info');
    if (info) info.textContent = Studio.columns.length ? (Studio.columns.length + ' عمود: ' + Studio.columns.join('، ')) : 'تعذّر جلب الأعمدة';
    renderInspector();
  }

  /* ---------- لوحة المكوّنات ---------- */
  function uid(prefix) {
    const has = new Set((Studio.def ? Studio.def.components : []).map(c => c.id));
    let n = 1;
    while (has.has(prefix + n)) n++;
    return prefix + n;
  }
  function addComponent(type) {
    const d = currentDef();
    const sch = S();
    const comp = sch ? sch.newComponent(type, { siblings: d.components }) : { id: uid('c'), type };
    if (type === 'kpi') { comp.label = 'مؤشر'; comp.column = Studio.columns[0] || ''; comp.agg = 'sum'; }
    if (type === 'table') { comp.columns = Studio.columns.slice(0, 4); comp.limit = 20; }
    if (type === 'bar' || type === 'line' || type === 'pie') {
      comp.title = 'مخطط'; comp.category = Studio.columns[0] || ''; comp.value = Studio.columns[1] || Studio.columns[0] || ''; comp.agg = 'sum';
    }
    if (type === 'heading' || type === 'text' || type === 'shape') comp.text = type === 'heading' ? 'عنوان' : (type === 'text' ? 'نص' : '');
    d.components.push(comp);
    Studio.selected = comp.id;
    setDirty(true);
    renderCanvas(); renderInspector();
  }
  function moveComponent(dir) {
    const d = currentDef();
    const i = d.components.findIndex(c => c.id === Studio.selected);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= d.components.length) return;
    const tmp = d.components[i]; d.components[i] = d.components[j]; d.components[j] = tmp;
    setDirty(true); renderCanvas();
  }
  function removeComponent() {
    const d = currentDef();
    const i = d.components.findIndex(c => c.id === Studio.selected);
    if (i < 0) return;
    d.components.splice(i, 1);
    Studio.selected = null;
    setDirty(true); renderCanvas(); renderInspector();
  }
  function duplicateComponent() {
    const d = currentDef();
    const i = d.components.findIndex(c => c.id === Studio.selected);
    if (i < 0) return;
    const sch = S();
    const copy = sch ? sch.duplicateComponent(d.components[i], d.components) : Object.assign({}, d.components[i]);
    copy.id = uid('c');
    d.components.splice(i + 1, 0, copy);
    Studio.selected = copy.id;
    setDirty(true); renderCanvas(); renderInspector();
  }

  function renderCanvas() {
    const host = $('ss-canvas'); if (!host) return;
    const d = currentDef();
    if (!d.components.length) {
      host.innerHTML = '<div class="hint">لا مكوّنات — أضف من شريط الأدوات أعلاه (عنوان · نص · بطاقة · جدول · مخطط).</div>';
      return;
    }
    host.innerHTML = d.components.map((c, i) => {
      const t = TYPE_LABEL[c.type] || c.type;
      let sub = '';
      if (c.type === 'kpi') sub = (c.label || '') + ' · ' + (c.column || '—') + ' (' + (AGG_LABEL[c.agg] || c.agg) + ')';
      else if (c.type === 'table') sub = (c.columns || []).join('، ') || 'بلا أعمدة';
      else if (c.type === 'bar' || c.type === 'line' || c.type === 'pie') sub = (c.title || '') + ' · ' + (c.category || '—') + ' → ' + (c.value || '—');
      else sub = c.text || '';
      return '<div class="ss-comp' + (c.id === Studio.selected ? ' sel' : '') + '" data-comp="' + esc(c.id) + '">'
        + '<span class="ss-comp-i">' + (i + 1) + '</span>'
        + '<span class="ss-comp-t">' + esc(t) + '</span>'
        + '<span class="ss-comp-s">' + esc(sub) + '</span>'
        + '<span class="ss-comp-a"><button type="button" class="btn xs" data-cmd="up" data-id="' + esc(c.id) + '">↑</button>'
        + '<button type="button" class="btn xs" data-cmd="down" data-id="' + esc(c.id) + '">↓</button>'
        + '<button type="button" class="btn xs ghost" data-cmd="dup" data-id="' + esc(c.id) + '">نسخ</button>'
        + '<button type="button" class="btn xs danger" data-cmd="del" data-id="' + esc(c.id) + '">حذف</button></span></div>';
    }).join('');
    host.querySelectorAll('[data-comp]').forEach(el => {
      el.addEventListener('click', (e) => {
        const cmdBtn = e.target.closest('[data-cmd]');
        if (cmdBtn) {
          e.stopPropagation();
          Studio.selected = cmdBtn.getAttribute('data-id');
          const cmd = cmdBtn.getAttribute('data-cmd');
          if (cmd === 'up') moveComponent(-1);
          else if (cmd === 'down') moveComponent(1);
          else if (cmd === 'dup') duplicateComponent();
          else if (cmd === 'del') removeComponent();
          return;
        }
        Studio.selected = el.getAttribute('data-comp');
        renderCanvas(); renderInspector();
      });
    });
  }

  /* ---------- لوحة الخصائص ---------- */
  function columnOptions(sel) {
    return '<option value="">— بدون عمود —</option>' + Studio.columns.map(c =>
      '<option value="' + esc(c) + '"' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
  }
  function renderInspector() {
    const host = $('ss-inspector'); if (!host) return;
    const d = currentDef();
    const c = d.components.find(x => x.id === Studio.selected);
    if (!c) {
      host.innerHTML = '<div class="hint">اختر مكوّنًا من القائمة لتحرير خصائصه.</div>'
        + '<div class="wf-row" style="margin-top:8px">'
        + '<label class="rd-ui-vis"><input type="checkbox" data-sprop="name-mode"' + (d.__editingName ? ' checked' : '') + ' /> تحرير الاسم والوصف</label></div>'
        + '<div class="wf-row" style="margin-top:8px">'
        + '<input class="wf-input" id="ss-name" placeholder="اسم الشاشة" value="' + esc(d.name || '') + '" />'
        + '<input class="wf-input" id="ss-desc" placeholder="وصف مختصر" value="' + esc(d.desc || '') + '" />'
        + '</div>';
      const nm = $('ss-name'); const ds = $('ss-desc');
      if (nm) nm.addEventListener('input', () => { d.name = nm.value; setDirty(true); });
      if (ds) ds.addEventListener('input', () => { d.desc = ds.value; setDirty(true); });
      return;
    }
    let h = '<div class="rd-ui-props-h"><b>' + esc(TYPE_LABEL[c.type] || c.type) + '</b><span class="muted xs">' + esc(c.id) + '</span></div>';
    if (c.type === 'kpi') {
      h += row('النص', '<input class="input sm" data-cprop="label" value="' + esc(c.label || '') + '" />');
      h += row('العمود', '<select class="wf-select" data-cprop="column">' + columnOptions(c.column) + '</select>');
      h += row('التجميع', '<select class="wf-select" data-cprop="agg">' + Object.keys(AGG_LABEL).map(a =>
        '<option value="' + a + '"' + ((c.agg || 'sum') === a ? ' selected' : '') + '>' + AGG_LABEL[a] + '</option>').join('') + '</select>');
      h += row('المنازل', '<input class="input sm" type="number" min="0" max="6" data-cprop="decimals" value="' + esc(c.decimals === undefined ? '' : c.decimals) + '" />');
    } else if (c.type === 'table') {
      h += row('الأعمدة', '<select class="wf-select" data-cprop="columns" multiple size="6">' + Studio.columns.map(col =>
        '<option value="' + esc(col) + '"' + ((c.columns || []).indexOf(col) >= 0 ? ' selected' : '') + '>' + esc(col) + '</option>').join('') + '</select>');
      h += row('أقصى صفوف', '<input class="input sm" type="number" min="1" max="500" data-cprop="limit" value="' + esc(c.limit === undefined ? '' : c.limit) + '" />');
    } else if (c.type === 'bar' || c.type === 'line' || c.type === 'pie') {
      h += row('العنوان', '<input class="input sm" data-cprop="title" value="' + esc(c.title || '') + '" />');
      h += row('التصنيف', '<select class="wf-select" data-cprop="category">' + columnOptions(c.category) + '</select>');
      h += row('القيمة', '<select class="wf-select" data-cprop="value">' + columnOptions(c.value) + '</select>');
      h += row('التجميع', '<select class="wf-select" data-cprop="agg">' + Object.keys(AGG_LABEL).map(a =>
        '<option value="' + a + '"' + ((c.agg || 'sum') === a ? ' selected' : '') + '>' + AGG_LABEL[a] + '</option>').join('') + '</select>');
    } else if (c.type === 'heading' || c.type === 'text' || c.type === 'shape') {
      h += row(c.type === 'heading' ? 'العنوان' : 'النص', '<input class="input sm" data-cprop="text" value="' + esc(c.text || '') + '" />');
    }
    host.innerHTML = h;
    host.querySelectorAll('[data-cprop]').forEach(el => {
      el.addEventListener('change', () => {
        const key = el.getAttribute('data-cprop');
        let v = el.value;
        if (el.multiple) v = Array.from(el.selectedOptions).map(o => o.value);
        else if (key === 'decimals' || key === 'limit') v = v === '' ? undefined : Number(v);
        if (v === undefined) delete c[key]; else c[key] = v;
        setDirty(true);
        renderCanvas();
      });
    });
  }
  function row(label, control) {
    return '<div class="wf-row"><label>' + esc(label) + '</label>' + control + '</div>';
  }

  /* ---------- المدخلات (فلاتر) ---------- */
  function renderInputs() {
    const host = $('ss-inputs'); if (!host) return;
    const d = currentDef();
    if (!d.inputs.length) { host.innerHTML = '<div class="hint">لا مدخلات — أضف فلترًا مربوطًا بعمود.</div>'; return; }
    host.innerHTML = d.inputs.map((inp, i) =>
      '<div class="ss-row" data-input="' + esc(inp.id) + '">'
      + '<span class="ss-row-t">' + esc(inp.label || inp.id) + '</span>'
      + '<select class="wf-select" data-inpprop="column">' + columnOptions(inp.column) + '</select>'
      + '<select class="wf-select" data-inpprop="op">' + Object.keys(OP_LABEL).map(o =>
        '<option value="' + esc(o) + '"' + ((inp.op || '==') === o ? ' selected' : '') + '>' + OP_LABEL[o] + '</option>').join('') + '</select>'
      + '<select class="wf-select" data-inpprop="type">' + Object.keys(INPUT_TYPE_LABEL).map(t =>
        '<option value="' + t + '"' + ((inp.type || 'text') === t ? ' selected' : '') + '>' + INPUT_TYPE_LABEL[t] + '</option>').join('') + '</select>'
      + '<input class="wf-input" data-inpprop="label" placeholder="العنوان" value="' + esc(inp.label || '') + '" />'
      + '<button type="button" class="btn xs danger" data-inpdel="' + esc(inp.id) + '">حذف</button>'
      + '</div>').join('');
    host.querySelectorAll('[data-inpprop]').forEach(el => {
      el.addEventListener('change', () => {
        const rowEl = el.closest('[data-input]');
        const inp = d.inputs.find(x => x.id === rowEl.getAttribute('data-input'));
        if (!inp) return;
        const key = el.getAttribute('data-inpprop');
        inp[key] = el.value;
        setDirty(true);
      });
    });
    host.querySelectorAll('[data-inpdel]').forEach(b => b.addEventListener('click', () => {
      d.inputs = d.inputs.filter(x => x.id !== b.getAttribute('data-inpdel'));
      setDirty(true); renderInputs();
    }));
  }
  function addInput() {
    const d = currentDef();
    if (d.inputs.length >= (M() ? M().MAX_INPUTS : 8)) { notify('الحد الأقصى للمدخلات reached'); return; }
    d.inputs.push({ id: 'in' + (d.inputs.length + 1) + '_' + Date.now().toString(36).slice(-3), type: 'text', column: Studio.columns[0] || '', op: '==', label: '' });
    setDirty(true); renderInputs();
  }

  /* ---------- الأزرار ---------- */
  function actionChoices() {
    const list = (window.UiActions && typeof window.UiActions.list === 'function') ? window.UiActions.list() : [];
    return list;
  }
  function gotoChoices() {
    const tabs = [];
    if (typeof TITLES !== 'undefined') Object.keys(TITLES).forEach(k => tabs.push({ id: k, label: TITLES[k][0] }));
    Studio.list.forEach(s => tabs.push({ id: s.id, label: s.name || s.id }));
    return tabs;
  }
  function renderButtons() {
    const host = $('ss-buttons'); if (!host) return;
    const d = currentDef();
    if (!d.buttons.length) { host.innerHTML = '<div class="hint">لا أزرار — أضف زرًا مرتبطًا بإجراء حقيقي.</div>'; return; }
    host.innerHTML = d.buttons.map(b =>
      '<div class="ss-row" data-btn="' + esc(b.id) + '">'
      + '<input class="wf-input" data-btnprop="label" placeholder="نص الزر" value="' + esc(b.label || '') + '" />'
      + '<select class="wf-select" data-btnprop="kind">' + [
        ['registered', 'إجراء مسجَّل في التطبيق'], ['goto', 'انتقال إلى شاشة'],
        ['openReport', 'فتح تقرير محفوظ'], ['refresh', 'تحديث الشاشة'],
      ].map(k => '<option value="' + k[0] + '"' + (b.action.kind === k[0] ? ' selected' : '') + '>' + k[1] + '</option>').join('') + '</select>'
      + '<select class="wf-select" data-btnprop="target">' + targetOptions(b) + '</select>'
      + '<button type="button" class="btn xs danger" data-btndel="' + esc(b.id) + '">حذف</button>'
      + '</div>').join('');
    host.querySelectorAll('[data-btnprop]').forEach(el => {
      el.addEventListener('change', () => {
        const rowEl = el.closest('[data-btn]');
        const b = d.buttons.find(x => x.id === rowEl.getAttribute('data-btn'));
        if (!b) return;
        const key = el.getAttribute('data-btnprop');
        if (key === 'kind') { b.action.kind = el.value; b.action.id = ''; }
        else if (key === 'target') b.action.id = el.value;
        else b.label = el.value;
        setDirty(true);
        renderButtons();
      });
    });
    host.querySelectorAll('[data-btndel]').forEach(btn => btn.addEventListener('click', () => {
      d.buttons = d.buttons.filter(x => x.id !== btn.getAttribute('data-btndel'));
      setDirty(true); renderButtons();
    }));
  }
  function targetOptions(b) {
    const kind = b.action.kind;
    if (kind === 'registered') {
      return actionChoices().map(a => '<option value="' + esc(a.id) + '"' + (b.action.id === a.id ? ' selected' : '') + '>' + esc(a.label) + '</option>').join('');
    }
    if (kind === 'goto') {
      return gotoChoices().map(t => '<option value="' + esc(t.id) + '"' + (b.action.id === t.id ? ' selected' : '') + '>' + esc(t.label) + '</option>').join('');
    }
    if (kind === 'openReport') {
      const reps = Studio.reports || [];
      return '<option value="">— اختر تقريرًا محفوظًا —</option>' + reps.map(r =>
        '<option value="' + esc(r.id) + '"' + (b.action.id === r.id ? ' selected' : '') + '>' + esc(r.name || r.id) + '</option>').join('');
    }
    return '<option value="">(لا شيء)</option>';
  }
  function addButton() {
    const d = currentDef();
    if (d.buttons.length >= (M() ? M().MAX_BUTTONS : 8)) { notify('الحد الأقصى للأزرار reached'); return; }
    const acts = actionChoices();
    d.buttons.push({ id: 'b' + (d.buttons.length + 1) + '_' + Date.now().toString(36).slice(-3), label: 'إجراء', action: { kind: acts.length ? 'registered' : 'goto', id: acts.length ? acts[0].id : 'dashboard' } });
    setDirty(true); renderButtons();
  }

  /* ---------- التحقق والحفظ ---------- */
  function collectCtx() {
    const runs = Studio.runs.map(r => ({ runId: r.runId, columns: r.columns || [] }));
    const screens = gotoChoices().map(t => t.id);
    const actions = actionChoices().map(a => a.id);
    const reports = (Studio.reports || []).map(r => r.id);
    return { runs, screens, actions, reports };
  }
  function validateNow() {
    const m = M(); if (!m) return { ok: false, errors: ['نموذج الشاشات غير محمّل'] };
    const def = m.normalizeScreen(Studio.def);
    return m.validateScreen(def, collectCtx());
  }
  async function saveScreen() {
    const v = validateNow();
    if (!v.ok) { msg('تعذّر الحفظ: ' + v.errors.join(' · ')); notify('الشاشة غير مكتملة — راجع الرسائل'); return; }
    try {
      msg('جارٍ الحفظ…');
      const r = await apiCall('/api/screens/custom/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ screen: Studio.def }),
      });
      Studio.def = M() ? M().normalizeScreen(r.screen || Studio.def) : Studio.def;
      Runtime.defs.set(Studio.def.id, Studio.def);
      setDirty(false);
      msg('تم الحفظ (' + Studio.def.id + ')');
      notify('تم حفظ الشاشة');
      await loadStudioList();
      await mountScreens();
    } catch (e) {
      msg('تعذّر الحفظ: ' + e.message);
    }
  }
  async function openScreenDef(id) {
    try {
      const r = await apiCall('/api/screens/custom/get?id=' + encodeURIComponent(id));
      Studio.def = M() ? M().normalizeScreen(r) : r;
      Studio.selected = null;
      const runSel = $('ss-run');
      if (runSel && Studio.def.source) runSel.value = Studio.def.source.runId;
      await loadColumns(Studio.def.source ? Studio.def.source.runId : '');
      renderCanvas(); renderInspector(); renderInputs(); renderButtons();
      msg('تم فتح الشاشة: ' + (Studio.def.name || id));
    } catch (e) { msg('تعذّر الفتح: ' + e.message); }
  }
  async function previewScreen() {
    const host = $('ss-preview-host'); if (!host) return;
    const v = validateNow();
    if (!v.ok) { host.innerHTML = '<div class="hint">لا يمكن المعاينة: ' + esc(v.errors.join(' · ')) + '</div>'; return; }
    host.innerHTML = '<div class="hint">جارٍ المعاينة…</div>';
    try {
      const def = M().normalizeScreen(Studio.def);
      const payload = M().composeRenderPayload(def, {});
      if (!payload.report.runId) { host.innerHTML = '<div class="hint">اختر مصدر بيانات (تشغيلًا محفوظًا) للمعاينة.</div>'; return; }
      const r = await apiCall('/api/reports/render', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: payload.report, runId: payload.report.runId }),
      });
      const html = (r && (r.html || (r.data && r.data.html))) || '';
      host.innerHTML = '<div class="ss-preview-h"><b>معاينة مباشرة</b><span class="muted xs">تصيير من محرّك التقارير على نتائج التشغيل المحفوظة</span></div>'
        + '<div class="ss-preview-body">' + (html || '<div class="hint">لا محتوى.</div>') + '</div>';
    } catch (e) {
      host.innerHTML = '<div class="hint">تعذّر التصيير: ' + esc(e.message) + '</div>';
    }
  }

  /* ---------- الربط ---------- */
  function wire() {
    const pal = $('ss-palette');
    if (pal) {
      pal.innerHTML = PALETTE.map(t => '<button type="button" class="btn sm" data-add="' + t + '">＋ ' + esc(TYPE_LABEL[t]) + '</button>').join('');
      pal.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => addComponent(b.getAttribute('data-add'))));
    }
    $('ss-list')?.addEventListener('change', (e) => openScreenDef(e.target.value));
    $('ss-run')?.addEventListener('change', async (e) => {
      const id = e.target.value;
      const d = currentDef();
      if (id) d.source = { kind: 'run', runId: id }; else delete d.source;
      setDirty(true);
      await loadColumns(id);
    });
    $('ss-save')?.addEventListener('click', saveScreen);
    $('ss-preview')?.addEventListener('click', previewScreen);
    $('ss-new')?.addEventListener('click', () => {
      const name = window.prompt('اسم الشاشة الجديدة:', 'شاشة جديدة');
      if (!name) return;
      const d = newDef();
      d.name = name;
      Studio.def = d; Studio.selected = null;
      renderCanvas(); renderInspector(); renderInputs(); renderButtons();
      setDirty(true);
      msg('شاشة جديدة — اربط مصدرًا وأضف مكوّنات ثم احفظ');
    });
    $('ss-copy')?.addEventListener('click', async () => {
      const d = currentDef();
      const copy = JSON.parse(JSON.stringify(d));
      copy.id = 'cs_' + stamp();
      copy.name = (d.name || 'شاشة') + ' (نسخة)';
      copy.createdAt = undefined; copy.savedAt = undefined;
      Studio.def = copy;
      setDirty(true);
      msg('نسخة محلية — اضغط «حفظ» لإنشائها');
      renderCanvas(); renderInspector(); renderInputs(); renderButtons();
    });
    $('ss-rename')?.addEventListener('click', () => {
      const d = currentDef();
      const nn = window.prompt('الاسم الجديد:', d.name || '');
      if (!nn) return;
      d.name = nn;
      setDirty(true);
      const nm = $('ss-name'); if (nm) nm.value = nn;
      msg('أُعيدت التسمية — اضغط «حفظ»');
    });
    $('ss-delete')?.addEventListener('click', async () => {
      const d = currentDef();
      if (!d.id) return;
      if (!window.confirm('حذف الشاشة «' + (d.name || d.id) + '» نهائيًا؟')) return;
      try {
        await apiCall('/api/screens/custom/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: d.id }),
        });
        notify('تم حذف الشاشة');
        Studio.def = null;
        await loadStudioList();
        await fetchScreens();
        await mountScreens();
        renderCanvas(); renderInspector(); renderInputs(); renderButtons();
      } catch (e) { msg('تعذّر الحذف: ' + e.message); }
    });
    $('ss-add-input')?.addEventListener('click', addInput);
    $('ss-add-button')?.addEventListener('click', addButton);
    $('ss-insert-report-btn')?.addEventListener('click', insertSavedReport);
    $('ss-system-screens')?.addEventListener('click', showSystemScreens);
  }

  /* ---------- إدراج تقرير محفوظ داخل الشاشة ---------- */
  async function insertSavedReport() {
    const sel = $('ss-insert-report');
    const msgEl = $('ss-insert-msg');
    const id = (sel && sel.value) || '';
    if (!id) { if (msgEl) msgEl.textContent = 'اختر تقريرًا محفوظًا أولًا'; return; }
    const d = currentDef();
    try {
      const rep = await apiCall('/api/reports/get?id=' + encodeURIComponent(id));
      if (!rep || !Array.isArray(rep.components)) { if (msgEl) msgEl.textContent = 'التقرير بلا مكوّنات'; return; }
      const runId = (rep.runId || (rep.source && rep.source.runId) || '').trim();
      if (runId) d.source = { kind: 'run', runId };
      const used = new Set(d.components.map(c => c.id));
      for (const comp of rep.components) {
        const copy = JSON.parse(JSON.stringify(comp));
        let i = 1; let nid = 'c' + i;
        while (used.has(nid)) { i++; nid = 'c' + i; }
        used.add(nid);
        copy.id = nid;
        d.components.push(copy);
      }
      if (rep.id && !d.buttons.some(b => b.action.kind === 'openReport' && b.action.id === rep.id)) {
        d.buttons.push({ id: 'b' + (d.buttons.length + 1), label: 'فتح ' + (rep.name || 'التقرير'), action: { kind: 'openReport', id: rep.id } });
      }
      setDirty(true);
      renderCanvas(); renderInspector(); renderInputs(); renderButtons();
      if (msgEl) msgEl.textContent = 'أُدرج ' + rep.components.length + ' مكوّنًا من «' + (rep.name || rep.id) + '» — اضغط «حفظ»';
      notify('أُدرج محتوى التقرير في الشاشة');
    } catch (e) {
      if (msgEl) msgEl.textContent = 'تعذّر الإدراج: ' + e.message;
    }
  }

  /* ---------- إنشاء شاشة من نتيجة تشغيل (من استوديو التحليل) ---------- */
  window.insertRunIntoScreen = async function (runId) {
    if (!runId) { notify('لا يوجد تشغيل لربطه'); return null; }
    try {
      const out = await apiCall('/api/workflows/output?id=' + encodeURIComponent(runId));
      const cols = (out && out.columns) || [];
      if (!cols.length) { notify('لا أعمدة في هذا التشغيل'); return null; }
      const label = (out && out.workflowName) ? out.workflowName : 'شاشة';
      const name = window.prompt('اسم الشاشة المرتبطة بالتشغيل ' + runId + ':', label + ' — شاشة');
      if (!name) return null;
      const def = newDef('cs_run_' + String(runId).replace(/[^A-Za-z0-9]/g, '').slice(-10));
      def.name = name;
      def.source = { kind: 'run', runId };
      /* مكوّنان مبدئيان: عنوان + جدول بأعمدة التشغيل (بلا حساب) */
      def.components.push({ id: 'c1', type: 'heading', text: name });
      def.components.push({ id: 'c2', type: 'table', columns: cols.slice(0, 5), limit: 20 });
      const r = await apiCall('/api/screens/custom/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ screen: def }),
      });
      await fetchScreens();
      await mountScreens();
      await loadStudioList();
      notify('أُنشئت الشاشة «' + name + '» من التشغيل ' + runId);
      if (window.Workspace) window.Workspace.go('screen-studio', { screenId: r.id || def.id, screenName: name, runId });
      return r.id || def.id;
    } catch (e) {
      notify('تعذّر إنشاء الشاشة: ' + e.message);
      return null;
    }
  };

  /* ---------- شاشات النظام (تشغيلية) — ما يمكن تعديله فعلًا ---------- */
  async function showSystemScreens() {    const host = $('ss-inputs'); if (!host) return;
    try {
      const r = await apiCall('/api/screens');
      const rows = (r && r.screens) ? r.screens : [];
      const operational = rows.filter(s => s.group !== 'التحليل');
      const design = rows.filter(s => s.group === 'التحليل');
      let html = '<div class="ws-detail-h"><b>شاشات النظام</b>'
        + '<span class="muted xs">تشغيلية: ' + operational.length + ' · تحليل وتصميم: ' + design.length + '</span>'
        + '<button type="button" class="btn xs ghost" id="ss-sys-close">إغلاق</button></div>';
      html += '<div class="ws-detail-sec">شاشات تشغيلية — تُحرَّر من لوحة «شاشات التطبيق والتحكّم» في هذه الشاشة</div>';
      html += '<table class="an-table"><thead><tr><th>الشاشة</th><th>المصدر</th><th>ما يمكن تعديله</th></tr></thead><tbody>';
      for (const s of operational) {
        html += '<tr><td><b>' + esc(s.label) + '</b><div class="muted xs">' + esc(s.id) + '</div></td>'
          + '<td class="muted xs">' + esc((s.sources || []).map(x => x.label || x.id).join(' · ') || '—') + '</td>'
          + '<td class="muted xs">العنوان · التسمية · الترتيب · الإظهار · الألوان (لا بنية المحتوى)</td></tr>';
      }
      html += '</tbody></table>';
      html += '<div class="ws-detail-sec">شاشات التحليل والتصميم (منصة التحليل)</div>';
      html += '<table class="an-table"><thead><tr><th>الشاشة</th><th>الغرض</th></tr></thead><tbody>';
      for (const s of design) {
        html += '<tr><td><b>' + esc(s.label) + '</b><div class="muted xs">' + esc(s.id) + '</div></td>'
          + '<td class="muted xs">' + esc(s.note || '—') + '</td></tr>';
      }
      html += '</tbody></table>';
      html += '<div class="hint">للتعديل الفعلي لشاشة تشغيلية: لوحة «شاشات التطبيق والتحكّم» في هذه الشاشة — تختار الشاشة وتحرّر عناصرها. '
        + 'الشاشات المخصّصة (المصمَّمة هنا) تُعدَّل بالكامل: مكوّنات · فلاتر · أزرار · ربط ببيانات.</div>';
      host.innerHTML = html;
      $('ss-sys-close')?.addEventListener('click', renderInputs);
    } catch (e) {
      toast('تعذّر تحميل سجل الشاشات: ' + e.message);
    }
  }

  window.showSystemScreens = showSystemScreens;

  window.loadScreenStudioTab = async function () {
    if (!Studio.list.length) await loadStudioList();
    if (!Studio.def) {
      const first = Studio.list[0];
      if (first) await openScreenDef(first.id);
    }
    await loadRuns();
    wire();
    renderCanvas(); renderInspector(); renderInputs(); renderButtons();
  };

  /* ==================================================================
   * 3) إدراج تقرير في شاشة (شاشة موجودة أو جديدة) — جسر المصمَّمين
   * ================================================================== */  /**
   * ينسخ مكوّنات تقرير محفوظ إلى شاشة مخصّصة (أو ينشئ شاشة جديدة منها)،
   * ويربط زرًّا يفتح التقرير. المكوّنات تُصيَّر بنفس محرّك التقارير.
   */
  window.insertReportIntoScreen = async function (report) {    if (!report || !Array.isArray(report.components)) {
      notify('التقرير غير صالح للإدراج'); return null;
    }
    const runId = (report.runId || (report.source && report.source.runId) || '').trim();
    if (!runId) { notify('التقرير بلا مصدر تشغيل — لا يمكن إدراجه في شاشة'); return null; }
    await loadStudioList();
    const options = Studio.list.map(s => s.id + ' — ' + (s.name || s.id)).join('\n');
    const pick = window.prompt(
      'أدرج التقرير «' + (report.name || 'بلا اسم') + '» في:\n'
      + (options ? options + '\n' : '')
      + 'اكتب معرّف شاشة جديدة يبدأ بـ cs_ لإنشائها، أو معرّف شاشة موجودة:',
      Studio.list[0] ? Studio.list[0].id : ('cs_report_' + stamp())
    );
    if (!pick) return null;
    const target = String(pick).trim();
    let def;
    if (Studio.list.some(s => s.id === target)) {
      try {
        const r = await apiCall('/api/screens/custom/get?id=' + encodeURIComponent(target));
        def = M() ? M().normalizeScreen(r) : r;
      } catch (e) { notify('تعذّر فتح الشاشة: ' + e.message); return null; }
    } else {
      if (!M() || !M().isScreenId(target)) { notify('معرّف الشاشة غير صالح (يجب أن يبدأ بـ cs_)'); return null; }
      def = newDef(target);
      def.name = (report.name || 'شاشة') + ' — شاشة';
    }
    /* مصدر الشاشة = نفس تشغيل التقرير ⇒ الأرقام مطابقة بلا حساب موازٍ */
    def.source = { kind: 'run', runId };
    const used = new Set(def.components.map(c => c.id));
    for (const comp of report.components) {
      const copy = JSON.parse(JSON.stringify(comp));
      let i = 1; let nid = 'r' + i;
      while (used.has(nid)) { i++; nid = 'r' + i; }
      used.add(nid);
      copy.id = nid;
      def.components.push(copy);
    }
    /* زر يفتح التقرير الأصلي (إجراء حقيقي) */
    if (report.id && !def.buttons.some(b => b.action.kind === 'openReport' && b.action.id === report.id)) {
      def.buttons.push({ id: 'b' + (def.buttons.length + 1), label: 'فتح التقرير', action: { kind: 'openReport', id: report.id } });
    }
    try {
      const r = await apiCall('/api/screens/custom/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ screen: def }),
      });
      await fetchScreens();
      await mountScreens();
      const m = $('rs-to-screen-msg');
      if (m) m.textContent = 'أُدرج التقرير في الشاشة «' + (def.name || def.id) + '»';
      notify('تم إدراج التقرير في الشاشة ' + (def.name || def.id));
      return r.id || def.id;
    } catch (e) {
      notify('تعذّر الإدراج: ' + e.message);
      return null;
    }
  };

  window.mountCustomScreens = async function () {
    await fetchScreens();
    mountScreens();
  };
  window.openCustomScreen = function (id) {
    /* الشاشات المخصّصة لم تعد زرًّا خارجيًا في الشريط: تُفتح من داخل
       «الشاشات والتحكّم» ⇒ لا بد من تفعيل قسمها قبل تصييرها. */
    const sec = document.getElementById('tab-' + id);
    if (sec) {
      if (typeof closeNavMenus === 'function') { try { closeNavMenus(); } catch (_) {} }
      document.querySelectorAll('section').forEach(s => s.classList.remove('active'));
      sec.classList.add('active');
      if (typeof current !== 'undefined') current = id;
      if (typeof rememberScreen === 'function') rememberScreen(id);
      if (typeof setHead === 'function') setHead('شاشة مخصّصة — ' + id, 'مبنية من «الشاشات والتحكّم»');
      document.getElementById('sidebar')?.classList.remove('open');
    }
    return renderScreen(id, true);
  };
})();
