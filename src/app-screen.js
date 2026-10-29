'use strict';
/**
 * نموذج الشاشات المخصّصة (App Screen Model) — مصمم الشاشات
 * ======================================================================
 * شاشة مخصّصة = تعريف محفوظ يُعرض كشاشة داخل التطبيق:
 *   1) الهوية      → id (يبدأ بـ cs_) + name (عربي) + desc
 *   2) مصدر البيانات → source.runId (تشغيل تحليل محفوظ — لا حساب موازي)
 *   3) المكوّنات   → نفس مكوّنات محرّك تقارير report-schema (نفس التصيير عبر
 *                     python/report_engine.py — بلا أي منطق حساب مكرَّر)
 *   4) المدخلات     → فلاتر مرتبطة بأعمدة (تُطبَّق عبر report.filters في التصيير)
 *   5) الأزرار      → إجراءات مسجَّلة حقيقية فقط (UiActions أو انتقال شاشة)
 *
 * المبادئ:
 *   - لا تنفيذ تقعّد ولا eval · قوائم بيضاء لكل شيء
 *   - لا يُخترع تاريخ لتشغيل غير موجود: source.runId يُفحص ضد التشغيلات الفعلية
 *   - الوحدة نقية (بلا I/O) وتعمل في Node والمتصفح
 */
function factory() {
  'use strict';

  /* eslint-disable max-len */
  const Schema = (typeof module !== 'undefined' && module.exports)
    ? require('./report-schema')
    : (typeof window !== 'undefined' && window.ReportSchema) ? window.ReportSchema : null;

  /* ---------------- الثوابت ---------------- */
  const ID_RE = /^cs_[A-Za-z0-9][A-Za-z0-9_\-]{1,38}$/;   /* معرّف الشاشة المخصّصة: بادئة cs_ */
  const RESERVE_IDS = ['ui-layout', 'screen-studio', 'dashboard', 'workcenter',
    'workflow', 'analysis', 'report-studio', 'reports-manager', 'reports'];

  const INPUT_TYPES = ['select', 'text', 'number', 'date'];
  const ACTION_KINDS = ['registered', 'goto', 'openReport', 'refresh'];
  const MAX_INPUTS = 8;
  const MAX_BUTTONS = 8;
  const BUTTONS_POSITIONS = ['top', 'bottom'];

  /* ---------------- أدوات تطبيع ---------------- */
  const clampInt = (v, lo, hi, def) => {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n)) return def;
    return Math.max(lo, Math.min(hi, n));
  };
  const cleanText = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
  const cleanRunId = v => String(v == null ? '' : v).replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 80);
  const cleanColumn = v => String(v == null ? '' : v).replace(/[\r\n\t"<>`\\]/g, '').trim().slice(0, 80);

  /** معرّف شاشة مخصّصة صالح */
  function isScreenId(id) {
    return ID_RE.test(String(id || '')) && RESERVE_IDS.indexOf(String(id)) < 0;
  }

  /* ---------------- تطبيع المكوّنات (نفس قواعد report-schema) ---------------- */
  function normalizeComponents(list) {
    if (!Schema) return [];
    const out = [];
    if (!Array.isArray(list)) return out;
    list.slice(0, Schema.MAX_COMPONENTS).forEach((comp, i) => {
      const n = Schema.normalizeComponent(comp, i, out);
      if (n) out.push(n);
    });
    return out;
  }

  /* ---------------- تطبيع المدخلات (فلاتر مرتبطة بأعمدة) ---------------- */
  function normalizeInput(raw, i) {
    if (!raw || typeof raw !== 'object') return null;
    const column = cleanColumn(raw.column);
    if (!column) return null;
    const op = Schema && Schema.FILTER_OPS.indexOf(String(raw.op)) >= 0 ? String(raw.op) : '==';
    const type = INPUT_TYPES.indexOf(String(raw.type)) >= 0 ? String(raw.type) : 'text';
    const o = { id: cleanRunId(raw.id) || ('in' + (i + 1)), type, column, op };
    const label = cleanText(raw.label, 60);
    if (label) o.label = label;
    if (raw.value !== undefined && raw.value !== null) {
      const n = Number(raw.value);
      o.value = (type === 'number' && raw.value !== '' && Number.isFinite(n)) ? n : cleanText(raw.value, 120);
    }
    if (type === 'select' && Array.isArray(raw.options)) {
      o.options = raw.options.slice(0, 60).map(v => cleanText(v, 80)).filter(Boolean);
    }
    return o;
  }

  function normalizeInputs(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const r of list.slice(0, MAX_INPUTS)) {
      const n = normalizeInput(r, out.length);
      if (n) out.push(n);
    }
    return out;
  }

  /* ---------------- تطبيع الأزرار (إجراءات حقيقية فقط) ---------------- */
  function normalizeButton(raw, i) {
    if (!raw || typeof raw !== 'object') return null;
    const action = raw.action && typeof raw.action === 'object' ? raw.action : {};
    const kind = ACTION_KINDS.indexOf(String(action.kind)) >= 0 ? String(action.kind) : '';
    const id = cleanRunId(action.id);
    if (!kind || !id) return null;
    const o = {
      id: cleanRunId(raw.id) || ('b' + (i + 1)),
      action: { kind, id: id.slice(0, 80) },
    };
    const label = cleanText(raw.label, 60);
    o.label = label || id;
    return o;
  }

  function normalizeButtons(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const r of list.slice(0, MAX_BUTTONS)) {
      const n = normalizeButton(r, out.length);
      if (n) out.push(n);
    }
    return out;
  }

  /* ---------------- تطبيع تعريف الشاشة ---------------- */
  function normalizeScreen(def) {
    const src = def && typeof def === 'object' ? def : {};
    const out = {};
    out.id = cleanRunId(src.id);
    out.name = cleanText(src.name, 80);
    if (src.desc) out.desc = cleanText(src.desc, 240);
    const runId = (src.source && typeof src.source === 'object') ? cleanRunId(src.source.runId) : cleanRunId(src.runId);
    if (runId) out.source = { kind: 'run', runId };
    out.components = normalizeComponents(src.components);
    out.inputs = normalizeInputs(src.inputs);
    out.buttons = normalizeButtons(src.buttons);
    const pos = BUTTONS_POSITIONS.indexOf(String(src.buttonsPosition)) >= 0 ? String(src.buttonsPosition) : 'top';
    out.buttonsPosition = pos;
    return out;
  }

  /* ---------------- التحقق (نقي — يُستخدم قبل الحفظ وفي الاختبارات) ----------------
   * ctx = { runs:[{runId, columns}], actions:[ids], screens:[ids], tabs:[ids] }
   * كل مفتاح اختياري — ما يُمرَّر يُفحص، وما لا يُمرَّر لا يُفحص (بلا اختلاق).
   */
  function validateScreen(def, ctx) {
    const c = def && typeof def === 'object' ? def : {};
    const x = ctx || {};
    const errors = [];
    if (!isScreenId(c.id)) errors.push('المعرّف: يجب أن يبدأ بـ «cs_» ثم حروف/أرقام (2-39) وألا يحجب شاشة قائمة.');
    if (!cleanText(c.name, 80)) errors.push('الاسم مطلوب.');
    const comps = Array.isArray(c.components) ? c.components : [];
    const buttons = Array.isArray(c.buttons) ? c.buttons : [];
    if (!comps.length && !buttons.length) errors.push('الشاشة فارغة: أضف مكوّنًا أو زرًا واحدًا على الأقل.');
    if (comps.length > Schema.MAX_COMPONENTS) errors.push('عدد المكوّنات يتجاوز الحد المسموح.');
    /* مصدر البيانات: يجب أن يكون تشغيلًا محفوظًا فعليًا إن مرِّرت قائمة التشغيلات */
    const runId = (c.source && c.source.runId) || '';
    if (compDataCount(comps) > 0 && !runId) errors.push('مكوّنات البيانات (مؤشر/جدول/مخطط) تحتاج مصدرًا: اختر تشغيلًا محفوظًا.');
    if (runId && Array.isArray(x.runs)) {
      const run = x.runs.find(r => r && (r.runId || r.id) === runId);
      if (!run) errors.push('مصدر البيانات: التشغيل «' + runId + '» غير موجود في نتائج التشغيلات المحفوظة.');
      else if (Array.isArray(run.columns) && run.columns.length) {
        /* أعمدة المكوّنات مقابل أعمدة التشغيل الفعلي */
        const cols = new Set(run.columns);
        comps.forEach((comp, i) => {
          if (!comp) return;
          const miss = componentMissingColumns(comp, cols);
          if (miss.length) errors.push('المكوّن ' + (i + 1) + ': أعمدة غير موجودة في نتيجة التشغيل — ' + miss.join('، '));
        });
      }
    }
    /* أعمدة المدخلات مقابل أعمدة التشغيل */
    (Array.isArray(c.inputs) ? c.inputs : []).forEach(inp => {
      if (!inp || !inp.column) return;
      if (Array.isArray(x.runs)) {
        const run = x.runs.find(r => r && (r.runId || r.id) === runId);
        if (run && Array.isArray(run.columns) && run.columns.length && run.columns.indexOf(inp.column) < 0) {
          errors.push('الفلتر «' + (inp.label || inp.id) + '»: العمود «' + inp.column + '» غير موجود في نتيجة التشغيل.');
        }
      }
    });
    /* الأزرار: إجراءات مسجَّلة أو شاشات موجودة فقط */
    const acts = Array.isArray(x.actions) ? new Set(x.actions) : null;
    const screens = x.screens !== undefined ? x.screens : null;
    const reports = Array.isArray(x.reports) ? new Set(x.reports) : null;
    for (const b of buttons) {
      if (!b || !b.action) continue;
      if (b.action.kind === 'registered' && acts && !acts.has(b.action.id)) {
        errors.push('الزر «' + (b.label || b.id) + '»: الإجراء «' + b.action.id + '» غير مسجَّل في التطبيق.');
      }
      if (b.action.kind === 'goto' && Array.isArray(screens) && screens.indexOf(b.action.id) < 0) {
        errors.push('الزر «' + (b.label || b.id) + '»: الشاشة «' + b.action.id + '» غير معروفة.');
      }
      if (b.action.kind === 'openReport' && reports && !reports.has(b.action.id)) {
        errors.push('الزر «' + (b.label || b.id) + '»: التقرير «' + b.action.id + '» غير موجود في التقارير المحفوظة.');
      }
    }
    return { ok: errors.length === 0, errors };
  }

  function compDataCount(comps) {
    return comps.filter(c => c && ['kpi', 'table', 'bar', 'line', 'pie'].indexOf(c.type) >= 0).length;
  }

  /** الأعمدة التي يحتاجها المكوّن (نفس قاعدة المحرّك — تقابل component_required_columns) */
  function componentMissingColumns(comp, cols) {
    if (!comp || !cols) return [];
    const need = [];
    if (comp.type === 'kpi' && comp.column) need.push(comp.column);
    if ((comp.type === 'bar' || comp.type === 'line' || comp.type === 'pie')) {
      if (comp.category) need.push(comp.category);
      if (comp.value) need.push(comp.value);
    }
    if (comp.type === 'table' && Array.isArray(comp.columns)) need.push(...comp.columns);
    return [...new Set(need)].filter(name => name && !cols.has(name));
  }

  /* ---------------- تركيب حزمة التصيير (تستخدم محرّك التقارير الوحيد) ---------------- */
  /**
   * يبني مانديل تقرير موحّد من الشاشة وقيم المدخلات ⇒ يُرسل إلى POST /api/reports/render
   * (المحرك يطبّق الفلاتر والتجميع والتصيير — الشاشة لا تحسب شيئًا).
   */
  function composeRenderPayload(def, values) {
    const d = normalizeScreen(def);
    const vals = (values && typeof values === 'object') ? values : {};
    const filters = [];
    for (const inp of d.inputs) {
      let v = vals[inp.id];
      if (v === undefined || v === null) v = inp.value;
      if (v === '' || v === undefined || v === null) continue;
      const f = { column: inp.column, op: inp.op };
      if (inp.op !== 'empty' && inp.op !== 'notEmpty') f.value = v;
      filters.push(f);
    }
    const report = {
      name: d.name || 'شاشة مخصصة',
      components: d.components,
      filters,
    };
    if (d.source && d.source.runId) report.runId = d.source.runId;
    return { report };
  }

  /** أزواج (معرّف مدخل ⇒ عمود) لرسم حقول الإدخال */
  function inputsSchema(def) {
    return normalizeScreen(def).inputs.map(i => ({
      id: i.id, type: i.type, column: i.column, op: i.op, label: i.label || i.column, value: i.value, options: i.options || null,
    }));
  }

  const api = {
    ID_RE, RESERVE_IDS, INPUT_TYPES, ACTION_KINDS, BUTTONS_POSITIONS,
    MAX_INPUTS, MAX_BUTTONS,
    isScreenId, normalizeScreen, normalizeComponents, normalizeInputs, normalizeButtons,
    normalizeButton, normalizeInput, validateScreen, componentMissingColumns,
    composeRenderPayload, inputsSchema, compDataCount,
  };
  return api;
}

(function (root) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AppScreen = api;
})(typeof self !== 'undefined' ? self : this);
