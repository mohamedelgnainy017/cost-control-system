'use strict';
/**
 * نموذج تعريف التقرير الموحّد (Report Definition Schema) — مصمم التقارير
 * ======================================================================
 * يفصل بين الطبقات الأربع المطلوبة:
 *   1) مصدر البيانات   → report.source { name, label, runId, savedAt, rowCount }
 *   2) التحليل         → مفاتيح المكوّن (column/agg/category/value/columns/sort/limit…)
 *   3) التخطيط         → component.grid { w, h } + report.layout { columns, gap }
 *   4) النمط           → component.style { bg, color, border, radius, fontSize, align, padding, shadow, accent }
 *   + التنسيق الشرطي  → component.rules [{ column, op, value, color, bg }]
 * والتصيير/التصدير يبقىان في python/report_engine.py (يستهلكان ما سبق دون أي تعديل يدوي).
 *
 * **توافق مع التقارير القديمة:** المكوّن المسطّح (label/column/agg/…) يبقى صالحًا بلا تحويل،
 * والمكوّن بلا `grid` يبقى بعرض كامل كما كان ⇒ التقارير المحفوظة سابقًا تُعرض كما هي.
 *
 * الوحدة تعمل في Node (module.exports) وفي المتصفح (window.ReportSchema) — ملف واحد مصدر حقيقة.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReportSchema = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- الثوابت ---------------- */
  const COMPONENT_TYPES = ['kpi', 'table', 'bar', 'line', 'pie', 'heading', 'text', 'divider', 'shape'];
  const AGGS = ['sum', 'avg', 'count', 'min', 'max'];
  const RULE_OPS = ['>', '>=', '<', '<=', '==', '!='];
  /* فلاتر البيانات على مستوى التقرير (تُطبَّق على الصفوف قبل التصيير) */
  const FILTER_OPS = ['>', '>=', '<', '<=', '==', '!=', 'contains', 'startsWith', 'in', 'notEmpty', 'empty'];
  const MAX_FILTERS = 10;
  const ALIGNMENTS = ['start', 'center', 'end', 'justify'];
  const MAX_RULES = 10;
  const MAX_COMPONENTS = 50;

  const GRID = { columns: 12, minW: 1, maxW: 12, minH: 1, maxH: 6 };
  const DEFAULT_SIZE = {
    kpi: { w: 3, h: 1 }, table: { w: 12, h: 2 }, bar: { w: 6, h: 2 }, line: { w: 6, h: 2 },
    pie: { w: 4, h: 2 }, heading: { w: 12, h: 1 }, text: { w: 12, h: 1 }, divider: { w: 12, h: 1 },
    shape: { w: 12, h: 1 },
  };

  /* ---------------- أدوات تطبيع (كل قيمة تُنظَّف وتُقصَر) ---------------- */
  const clampInt = (v, min, max, def) => {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
  };

  const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  const RGB_RE = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/;
  const cleanColor = v => {
    const s = String(v == null ? '' : v).trim();
    return (HEX_RE.test(s) || RGB_RE.test(s)) ? s : '';
  };

  /* حدود CSS: حروف/أرقام ورموز محددة فقط + لا أقواس معقوفة (يمنع أي حقن) */
  const BORDER_RE = /^(?:none|(?:\d{1,3}(?:px|pt|em|rem|%)\s+)?(?:solid|dashed|dotted|double)\s+(?:#[0-9a-fA-F]{3,8}|rgba?\([\d\s,.%]+\)|[a-z]+)(?:\s+(?:\d{1,3}(?:px|pt|em|rem|%)\s+)?(?:#[0-9a-fA-F]{3,8}|rgba?\([\d\s,.%]+\)|[a-z]+))?)$/;
  const cleanBorder = v => {
    const s = String(v == null ? '' : v).trim();
    return BORDER_RE.test(s) ? s : '';
  };

  const FONT_RE = /^[A-Za-z0-9\s"'\-]{1,40}$/;
  const cleanFont = v => {
    const s = String(v == null ? '' : v).trim();
    return FONT_RE.test(s) ? s : '';
  };

  const cleanAlign = v => (ALIGNMENTS.indexOf(String(v)) >= 0 ? String(v) : '');
  const cleanWeight = v => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return (s === 'normal' || s === 'bold' || s === 'lighter' || /^[1-9]00$/.test(s)) ? s : '';
  };

  /* ---------------- المكوّن ---------------- */
  function defaultGrid(type) {
    const d = DEFAULT_SIZE[type] || { w: GRID.columns, h: 1 };
    return { w: d.w, h: d.h };
  }

  /** تطبيع النمط: تُحفظ المفاتيح المسموحة فقط وبقيم آمنة */
  function normalizeStyle(style) {
    const s = (style && typeof style === 'object') ? style : {};
    const out = {};
    const bg = cleanColor(s.bg);
    if (bg) out.bg = bg;
    const color = cleanColor(s.color);
    if (color) out.color = color;
    const border = cleanBorder(s.border);
    if (border) out.border = border;
    const accent = cleanColor(s.accent);
    if (accent) out.accent = accent;
    if (s.radius !== undefined && s.radius !== null && s.radius !== '') out.radius = clampInt(s.radius, 0, 40, 12);
    if (s.fontSize !== undefined && s.fontSize !== null && s.fontSize !== '') out.fontSize = clampInt(s.fontSize, 8, 72, 0);
    const fw = cleanWeight(s.fontWeight);
    if (fw) out.fontWeight = fw;
    const al = cleanAlign(s.align);
    if (al) out.align = al;
    if (s.padding !== undefined && s.padding !== null && s.padding !== '') out.padding = clampInt(s.padding, 0, 48, 12);
    if (s.shadow) out.shadow = true;
    return out;
  }

  /** تطبيع فلاتر التقرير — عمود + عملية + قيمة (قائمة بيضاء) */
  function normalizeFilters(filters) {
    if (!Array.isArray(filters)) return [];
    const out = [];
    for (const f of filters) {
      if (!f || typeof f !== 'object') continue;
      const column = String(f.column || '').trim();
      if (!column) continue;
      const op = FILTER_OPS.indexOf(String(f.op)) >= 0 ? String(f.op) : '==';
      const item = { column, op };
      if (f.value !== undefined && f.value !== null && f.value !== '') {
        const n = Number(f.value);
        item.value = (Number.isFinite(n) && String(f.value).trim() !== '') ? n : String(f.value).slice(0, 120);
      }
      out.push(item);
      if (out.length >= MAX_FILTERS) break;
    }
    return out;
  }

  /** تطبيع شرط تنسيق شرطي */
  function normalizeRule(rule) {
    if (!rule || typeof rule !== 'object') return null;
    const column = String(rule.column || '').trim();
    if (!column) return null;
    const op = RULE_OPS.indexOf(String(rule.op)) >= 0 ? String(rule.op) : '>';
    const out = { column, op };
    if (rule.value !== undefined && rule.value !== null && rule.value !== '') {
      const n = Number(rule.value);
      out.value = Number.isFinite(n) ? n : String(rule.value).slice(0, 40);
    }
    const color = cleanColor(rule.color);
    if (color) out.color = color;
    const bg = cleanColor(rule.bg);
    if (bg) out.bg = bg;
    return out;
  }

  function normalizeRules(rules) {
    if (!Array.isArray(rules)) return [];
    const out = [];
    for (const r of rules) {
      const n = normalizeRule(r);
      if (n) out.push(n);
      if (out.length >= MAX_RULES) break;
    }
    return out;
  }

  /** تطبيع التخطيط — المكوّن بلا grid يبقى بعرض كامل (توافق مع القديم) */
  function normalizeGrid(grid, type) {
    if (!grid || typeof grid !== 'object') return null;
    const w = clampInt(grid.w, GRID.minW, GRID.maxW, (DEFAULT_SIZE[type] || {}).w || GRID.columns);
    const h = clampInt(grid.h, GRID.minH, GRID.maxH, (DEFAULT_SIZE[type] || {}).h || 1);
    return { w, h };
  }

  let idSeq = 0;
  function nextId(existing) {
    idSeq += 1;
    let id = 'c' + idSeq;
    const has = new Set((existing || []).map(c => c && c.id));
    while (has.has(id)) { idSeq += 1; id = 'c' + idSeq; }
    return id;
  }

  /** مكوّن جديد بنمطه الافتراضي */
  function newComponent(type, opts) {
    const t = COMPONENT_TYPES.indexOf(type) >= 0 ? type : 'kpi';
    const o = opts || {};
    const comp = { id: o.id || nextId(o.siblings), type: t };
    if (t === 'kpi') { comp.label = o.label || 'مؤشر جديد'; comp.column = o.column || ''; comp.agg = o.agg || 'sum'; }
    else if (t === 'table') { comp.columns = Array.isArray(o.columns) ? o.columns.slice() : []; }
    else if (t === 'bar' || t === 'line' || t === 'pie') {
      comp.title = o.title || 'عنوان المخطط'; comp.category = o.category || ''; comp.value = o.value || ''; comp.agg = o.agg || 'sum';
      comp.showTitle = o.showTitle !== false;
    } else if (t === 'heading' || t === 'text') { comp.text = o.text || (t === 'heading' ? 'عنوان' : 'نص'); }
    else if (t === 'shape') { comp.text = o.text || ''; }
    comp.grid = normalizeGrid(o.grid, t) || defaultGrid(t);
    comp.style = normalizeStyle(o.style);
    if (o.rules) comp.rules = normalizeRules(o.rules);
    return comp;
  }

  /** نسخة من مكوّن (بمعرّف جديد) */
  function duplicateComponent(comp, siblings) {
    if (!comp || typeof comp !== 'object') return null;
    const copy = JSON.parse(JSON.stringify(comp));
    delete copy.id;
    copy.grid = normalizeGrid(copy.grid, copy.type) || defaultGrid(copy.type);
    copy.style = normalizeStyle(copy.style);
    copy.rules = normalizeRules(copy.rules);
    return newComponent(copy.type, Object.assign({}, copy, { id: nextId(siblings) }));
  }

  /** تطبيع مكوّن واحد (يحافظ على المفاتيح القديمة المسطّحة) */
  function normalizeComponent(comp, index, siblings) {
    if (!comp || typeof comp !== 'object') return null;
    const t = COMPONENT_TYPES.indexOf(comp.type) >= 0 ? comp.type : null;
    if (!t) return null;
    const out = {};
    out.id = String(comp.id || (nextId(siblings) + '_' + index));
    out.type = t;
    /* مفاتيح التحليل القديمة (مسطّحة) — تُنسخ كما هي */
    const DATA_KEYS = ['label', 'column', 'agg', 'decimals', 'columns', 'sort', 'desc', 'limit',
      'title', 'category', 'value', 'showTitle', 'xLabel', 'yLabel', 'text'];
    for (const k of DATA_KEYS) if (comp[k] !== undefined) out[k] = comp[k];
    /* مرجع معادلة محفوظة (معرّف + نسخة) — يُحلّ إلى عمود في بيانات التشغيل */
    if (comp.formula && typeof comp.formula === 'object' && comp.formula.id) {
      out.formula = {
        id: String(comp.formula.id).slice(0, 60),
        version: Number.isFinite(Number(comp.formula.version)) ? Number(comp.formula.version) : null,
        name: comp.formula.name ? String(comp.formula.name).slice(0, 120) : '',
      };
    }
    if (out.agg && AGGS.indexOf(out.agg) < 0) out.agg = 'sum';
    if (out.decimals !== undefined) out.decimals = clampInt(out.decimals, 0, 6, 2);
    if (out.limit !== undefined) out.limit = clampInt(out.limit, 1, 500, 20);
    if (Array.isArray(out.columns)) out.columns = out.columns.map(String);
    const g = normalizeGrid(comp.grid, t);
    if (g) out.grid = g;
    const s = normalizeStyle(comp.style);
    if (Object.keys(s).length) out.style = s;
    const r = normalizeRules(comp.rules);
    if (r.length) out.rules = r;
    return out;
  }

  /** تطبيع التقرير كاملاً (متوافق مع الشكل القديم) */
  function normalizeReport(rep) {
    const r = (rep && typeof rep === 'object') ? rep : {};
    const out = {};
    out.name = String(r.name || 'تقرير').slice(0, 120);
    /* عنوان ووصف التقرير (يظهران في ملف HTML المُصدَّر) — اختياريان ولا يغيّران المعاينة المضمّنة */
    out.title = String(r.title || '').slice(0, 120);
    out.description = String(r.description || '').slice(0, 400);
    out.runId = r.runId ? String(r.runId).slice(0, 80) : '';
    /* مرجع تقرير قائم من التطبيق (مصدر البيانات البديل) — يُحفظ مع التعريف */
    const lg = (r.legacy && typeof r.legacy === 'object') ? r.legacy : null;
    out.legacy = lg && lg.name
      ? { name: String(lg.name).slice(0, 80), params: (lg.params && typeof lg.params === 'object') ? JSON.parse(JSON.stringify(lg.params).slice(0, 2000)) : {} }
      : null;
    out.version = 2;
    const src = (r.source && typeof r.source === 'object') ? r.source : {};
    out.source = {
      name: src.name ? String(src.name).slice(0, 80) : '',
      label: src.label ? String(src.label).slice(0, 120) : '',
      runId: src.runId ? String(src.runId).slice(0, 80) : out.runId,
      savedAt: src.savedAt ? String(src.savedAt).slice(0, 40) : '',
      rowCount: Number.isFinite(Number(src.rowCount)) ? Number(src.rowCount) : 0,
      workflowName: src.workflowName ? String(src.workflowName).slice(0, 120) : '',
      /* تتبّع: هل النتيجة تحمل تعريف تشغيل مستقل؟ وما الفلاتر التي أثّرت فيها؟ */
      traced: !!src.traced,
      definitionHash: src.definitionHash ? String(src.definitionHash).slice(0, 40) : '',
      filters: (src.filters && typeof src.filters === 'object')
        ? JSON.parse(JSON.stringify(src.filters).slice(0, 2000)) : null,
    };
    const lay = (r.layout && typeof r.layout === 'object') ? r.layout : {};
    out.layout = {
      columns: clampInt(lay.columns, 2, 24, GRID.columns),
      gap: clampInt(lay.gap, 0, 32, 12),
      pageWidth: clampInt(lay.pageWidth, 600, 2000, 1200),
    };
    const comps = Array.isArray(r.components) ? r.components : [];
    const out2 = [];
    for (const c of comps.slice(0, MAX_COMPONENTS)) {
      const n = normalizeComponent(c, out2.length, out2);
      if (n) out2.push(n);
    }
    out.components = out2;
    out.filters = normalizeFilters(r.filters);
    return out;
  }

  /** تحقق من التقرير (نفس القواعد التي يطبّقها محرك Python + قيود النموذج) */
  function validateReport(rep) {
    const errors = [];
    if (!rep || typeof rep !== 'object') return { ok: false, errors: ['التقرير يجب أن يكون كائنًا'] };
    if (!rep.name || !String(rep.name).trim()) errors.push('اسم التقرير مطلوب');
    if (!Array.isArray(rep.components)) errors.push('مكونات التقرير يجب أن تكون مصفوفة');
    else {
      if (rep.components.length > MAX_COMPONENTS) errors.push('عدد المكونات أكبر من الحد (' + MAX_COMPONENTS + ')');
      rep.components.forEach((c, i) => {
        if (!c || typeof c !== 'object') { errors.push('المكوّن ' + (i + 1) + ' ليس كائنًا'); return; }
        if (COMPONENT_TYPES.indexOf(c.type) < 0) errors.push('المكوّن ' + (i + 1) + ': نوع غير معروف ' + c.type);
        if (c.type === 'kpi') {
          if (!c.label) errors.push('المكوّن ' + (i + 1) + ': عنوان المؤشر مطلوب');
          if (!c.column) errors.push('المكوّن ' + (i + 1) + ': عمود المؤشر مطلوب');
          if (c.agg && AGGS.indexOf(c.agg) < 0) errors.push('المكوّن ' + (i + 1) + ': تجميع غير معروف ' + c.agg);
        }
        if (c.type === 'table' && (!Array.isArray(c.columns) || !c.columns.length)) {
          errors.push('المكوّن ' + (i + 1) + ': أعمدة الجدول مطلوبة');
        }
        if (c.formula && typeof c.formula === 'object' && !c.formula.id) {
          errors.push('المكوّن ' + (i + 1) + ': مرجع المعادلة ناقص (id)');
        }
        if ((c.type === 'bar' || c.type === 'line' || c.type === 'pie')) {
          if (!c.category || !c.value) errors.push('المكوّن ' + (i + 1) + ': عمود الفئات والقيم مطلوبان');
          if (c.agg && AGGS.indexOf(c.agg) < 0) errors.push('المكوّن ' + (i + 1) + ': تجميع غير معروف ' + c.agg);
        }
        if (c.grid && (c.grid.w < GRID.minW || c.grid.w > GRID.maxW || c.grid.h < GRID.minH || c.grid.h > GRID.maxH)) {
          errors.push('المكوّن ' + (i + 1) + ': أبعاد التخطيط خارج الحدود');
        }
        if (c.rules) {
          if (!Array.isArray(c.rules)) errors.push('المكوّن ' + (i + 1) + ': الشروط يجب أن تكون مصفوفة');
          else if (c.rules.length > MAX_RULES) errors.push('المكوّن ' + (i + 1) + ': عدد الشروط أكبر من الحد');
          else {
            for (const r of c.rules) {
              if (!r || !r.column) { errors.push('المكوّن ' + (i + 1) + ': شرط بلا عمود'); continue; }
              if (RULE_OPS.indexOf(r.op) < 0) errors.push('المكوّن ' + (i + 1) + ': عملية شرط غير معروفة ' + r.op);
            }
          }
        }
      });
    }
    return { ok: errors.length === 0, errors };
  }

  /** ملخص سريع للعرض في الواجهة */
  function summarize(comp) {
    switch (comp.type) {
      case 'kpi': return (comp.label || '') + ' = ' + (comp.agg || 'sum') + '(' + (comp.column || '?') + ')';
      case 'table': return 'أعمدة: ' + (comp.columns || []).join(', ') + (comp.limit ? ' · حد ' + comp.limit : '');
      case 'bar': case 'line': case 'pie': return (comp.title || '') + ' — ' + (comp.category || '?') + ' × ' + (comp.value || '?') + ' (' + (comp.agg || 'sum') + ')';
      case 'heading': case 'text': return String(comp.text || '').slice(0, 60);
      case 'divider': return 'فاصل';
      default: return '';
    }
  }

  return {
    COMPONENT_TYPES, AGGS, RULE_OPS, FILTER_OPS, ALIGNMENTS, GRID, DEFAULT_SIZE, MAX_RULES, MAX_FILTERS, MAX_COMPONENTS,
    clampInt, cleanColor, cleanBorder, cleanFont, cleanAlign,
    normalizeStyle, normalizeRule, normalizeRules, normalizeFilters, normalizeGrid, normalizeComponent, normalizeReport,
    newComponent, duplicateComponent, validateReport, summarize, defaultGrid,
  };
});
