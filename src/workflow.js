'use strict';
/**
 * Workflow Studio — محرك تنفيذ مسارات التحويل (Phase Sprint-1)
 * ============================================================
 * - يعمل على مصفوفات من صفوف (objects) في الذاكرة (DB-independent core).
 * - خطوات: select, filter, compute, groupBy, join, sort.
 * - الربط بمصدر حقيقي: الخطوة تقبل rightSource (معرّف من فهرس البيانات) بدل
 *   rightRows الحرفية — وتُحلّ الصفوف عبر مُزوِّد خارجي قبل التنفيذ (prepareWorkflow)،
 *   فلا يبقى المحرك متصلاً بقاعدة البيانات.
 * - تحقق (validation) + معاينة (preview) + سجل تحويل (trace).
 * - حفظ/تحميل JSON (fs) — اختياري.
 * - لا eval: الحقول المحسوبة تستخدم formulas.evaluateFormula.
 * - لا writes to DB.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const formulas = require('./formulas');
const PY = require('./python-transform');

const STEP_TYPES = ['select', 'filter', 'compute', 'groupBy', 'pivot', 'unpivot', 'join', 'union', 'compare', 'reconcile', 'variance', 'outlier', 'quality', 'dedupe', 'nulls', 'window', 'sort', 'python'];
const FILTER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'in', 'isNull', 'isNotNull'];
const AGG_FNS = ['SUM', 'COUNT', 'COUNT_DISTINCT', 'AVG', 'MIN', 'MAX', 'MEDIAN', 'STDEV'];
const JOIN_TYPES = ['inner', 'left'];
const UNION_MODES = ['strict', 'align'];
const DEDUPE_KEEP = ['first', 'last'];
const NULL_ACTIONS = ['drop', 'fill'];
const WINDOW_OPS = ['rowNumber', 'rank', 'runningTotal'];
const OUTLIER_METHODS = ['iqr', 'zscore'];
const OUTLIER_ACTIONS = ['flag', 'remove'];
const QUALITY_COLUMNS = ['__check', '__columns', '__status', '__issues', '__sample'];
const PIVOT_DEFAULT_PREFIX = 'pivot_';
const UNPIVOT_DEFAULT_KEY = 'variable';
const UNPIVOT_DEFAULT_VALUE = 'value';
/* حدود التنفيذ: تمنع مسارات ضخمة/طويلة من استهلاك الخادم بلا سقف. */
const MAX_STEPS = 200;
const MAX_ROWS = 100000;
const MAX_EXECUTION_MS = 30000;

/** مفاتيح الترتيب في خطوة sort */
const sortKeys = step => (Array.isArray(step.by) && step.by.length ? step.by : (step.column ? [step.column] : []));

const isNullish = v => v === null || v === undefined;

/** قيم رقمية فقط — تُستخدم في التجميعات الإحصائية */
function numericValues(vals) {
  return (vals || []).filter(v => !isNullish(v))
    .map(v => (typeof v === 'number' ? v : Number(v)))
    .filter(n => Number.isFinite(n));
}

/** خطة إعادة تسمية أعمدة select — بلا آثار جانبية */
function selectRenamePlan(columns, renames) {
  const chosen = Array.isArray(columns) ? columns.slice() : [];
  const map = new Map();
  const errors = [];
  const fromSeen = new Set();
  for (const raw of (Array.isArray(renames) ? renames : [])) {
    if (!raw || typeof raw !== 'object') { errors.push('rename must be object'); continue; }
    const from = String(raw.from || '').trim();
    const to = String(raw.to || '').trim();
    if (!from) { errors.push('rename requires from'); continue; }
    if (!to) { errors.push('rename requires to for ' + from); continue; }
    if (!chosen.includes(from)) { errors.push('rename source not selected: ' + from); continue; }
    if (fromSeen.has(from)) { errors.push('duplicate rename source: ' + from); continue; }
    fromSeen.add(from);
    map.set(from, to);
  }
  const outColumns = chosen.map(c => map.get(c) || c);
  const seen = new Set();
  for (const c of outColumns) {
    if (seen.has(c)) errors.push('duplicate output column after rename: ' + c);
    seen.add(c);
  }
  return { ok: errors.length === 0, errors, map, columns: outColumns };
}

/* ---------- الجدول المحوري وإلغاء المحورية ----------
 * التصميم مقصود: أسماء أعمدة Pivot ديناميكية (تعتمد على قيم عمود/أعمدة المحورية)،
 * لذلك لا يمكن الحكم على مخططها قبل التنفيذ. يتحقق الرسم من إعداداتها فقط،
 * ويُترك التحقق من الأعمدة اللاحقة إلى التنفيذ (نفس سلوك المحرك الخطي).
 */
function pivotConfig(step) {
  const s = step && typeof step === 'object' ? step : {};
  const rowKeys = Array.isArray(s.rowKeys) ? s.rowKeys.map(String) : [];
  const columnKeys = Array.isArray(s.columnKeys)
    ? s.columnKeys.map(String)
    : (s.columnKey ? [String(s.columnKey)] : []);
  const values = Array.isArray(s.values) ? s.values : [];
  const prefix = s.prefix === undefined ? PIVOT_DEFAULT_PREFIX : String(s.prefix);
  return { rowKeys, columnKeys, values, prefix };
}

function pivotValueBase(v) {
  const out = String(v && v.out || '').trim();
  if (out) return out;
  const fn = String(v && v.fn || 'SUM');
  const col = String(v && v.column || '').trim();
  return fn + (col ? '_' + col : '');
}

function pivotLabel(values) {
  return (values || []).map(v => {
    if (v === null || v === undefined || v === '') return '(فارغ)';
    const s = String(v).trim();
    return s || '(فارغ)';
  }).join(' / ');
}

function pivotPlan(columns, step) {
  const errors = [];
  const cols = Array.isArray(columns) ? columns : null;
  const cfg = pivotConfig(step);
  if (!cfg.rowKeys.length) errors.push('pivot requires non-empty rowKeys[]');
  if (!cfg.columnKeys.length) errors.push('pivot requires non-empty columnKeys[]');
  if (!cfg.values.length) errors.push('pivot requires non-empty values[]');
  if (cols) {
    for (const k of cfg.rowKeys) if (!cols.includes(k)) errors.push('pivot unknown row key: ' + k);
    for (const k of cfg.columnKeys) if (!cols.includes(k)) errors.push('pivot unknown column key: ' + k);
  }
  const bases = new Set();
  cfg.values.forEach((v, i) => {
    if (!v || typeof v !== 'object') { errors.push('pivot value #' + (i + 1) + ' must be object'); return; }
    if (!AGG_FNS.includes(v.fn)) errors.push('pivot unknown agg fn: ' + String(v.fn));
    if (v.fn !== 'COUNT' && (!v.column || (cols && !cols.includes(v.column)))) {
      errors.push('pivot value requires valid column: ' + String(v.column || ''));
    }
    const base = pivotValueBase(v);
    if (!base) errors.push('pivot value requires out name');
    else if (bases.has(base)) errors.push('duplicate pivot value out: ' + base);
    else bases.add(base);
  });
  return { ok: errors.length === 0, errors, rowKeys: cfg.rowKeys, columnKeys: cfg.columnKeys, values: cfg.values, prefix: cfg.prefix };
}

function unpivotConfig(step, columns) {
  const s = step && typeof step === 'object' ? step : {};
  const cols = Array.isArray(columns) ? columns : null;
  const valueColumns = Array.isArray(s.valueColumns) ? s.valueColumns.map(String) : [];
  const idColumns = Array.isArray(s.idColumns) ? s.idColumns.map(String) : [];
  const keyName = String(s.keyName || UNPIVOT_DEFAULT_KEY).trim() || UNPIVOT_DEFAULT_KEY;
  const valueName = String(s.valueName || UNPIVOT_DEFAULT_VALUE).trim() || UNPIVOT_DEFAULT_VALUE;
  return { idColumns, valueColumns, keyName, valueName, dropNulls: !!s.dropNulls, cols };
}

function unpivotPlan(columns, step) {
  const errors = [];
  const cfg = unpivotConfig(step, columns);
  const cols = cfg.cols;
  if (!cfg.valueColumns.length) errors.push('unpivot requires non-empty valueColumns[]');
  if (!cfg.keyName) errors.push('unpivot requires keyName');
  if (!cfg.valueName) errors.push('unpivot requires valueName');
  if (cfg.keyName === cfg.valueName) errors.push('unpivot keyName and valueName must differ');
  if (cols) {
    for (const c of cfg.idColumns) if (!cols.includes(c)) errors.push('unpivot unknown id column: ' + c);
    for (const c of cfg.valueColumns) if (!cols.includes(c)) errors.push('unpivot unknown value column: ' + c);
  }
  const ids = cfg.idColumns.length ? cfg.idColumns : (cols ? cols.filter(c => !cfg.valueColumns.includes(c)) : []);
  if (ids.includes(cfg.keyName)) errors.push('unpivot keyName collides with an id column: ' + cfg.keyName);
  if (ids.includes(cfg.valueName)) errors.push('unpivot valueName collides with an id column: ' + cfg.valueName);
  for (const c of cfg.valueColumns) if (cfg.idColumns.includes(c)) errors.push('unpivot column cannot be both id and value: ' + c);
  return { ok: errors.length === 0, errors, idColumns: ids, valueColumns: cfg.valueColumns, keyName: cfg.keyName, valueName: cfg.valueName, dropNulls: cfg.dropNulls };
}

/** قائمة أعمدة من مصفوفة أو نص مفصول بفواصل (توافق مع الإعدادات القديمة) */
function keyList(v) {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map(x => x.trim()).filter(Boolean);
  return [];
}

function compareConfig(step) {
  return {
    leftKeys: keyList(step && step.leftKeys).length ? keyList(step.leftKeys) : keyList(step && step.leftKey),
    rightKeys: keyList(step && step.rightKeys).length ? keyList(step && step.rightKeys) : keyList(step && step.rightKey),
  };
}

function joinKeys(step) {
  return compareConfig(step);
}

function numOrNull(v) {
  if (isNullish(v) || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function qualitySample(values) {
  const list = (values || []).slice(0, 3).map(v => {
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  });
  return list.join(' | ').slice(0, 180);
}

/** خطة التباين: أعمدة الإدخال، التسامح، وأعمدة الناتج */
function variancePlan(columns, step) {
  const s = step && typeof step === 'object' ? step : {};
  const errors = [];
  const cols = Array.isArray(columns) ? columns : null;
  const leftColumn = String(s.leftColumn || s.leftKey || '').trim();
  const rightColumn = String(s.rightColumn || s.rightKey || '').trim();
  const outPrefix = String(s.outPrefix || 'variance').trim() || 'variance';
  const tolerance = s.tolerance === undefined || s.tolerance === '' ? 0 : Number(s.tolerance);
  const percent = s.percent !== false;
  if (!leftColumn) errors.push('variance requires leftColumn');
  if (!rightColumn) errors.push('variance requires rightColumn');
  if (!Number.isFinite(tolerance) || tolerance < 0) errors.push('variance tolerance must be a non-negative number');
  if (cols) {
    if (leftColumn && !cols.includes(leftColumn)) errors.push('variance unknown left column: ' + leftColumn);
    if (rightColumn && !cols.includes(rightColumn)) errors.push('variance unknown right column: ' + rightColumn);
  }
  const outColumns = [outPrefix + '_diff', outPrefix + '_abs_diff'];
  if (percent) outColumns.push(outPrefix + '_pct_diff');
  outColumns.push(outPrefix + '_status');
  if (cols) for (const c of outColumns) if (cols.includes(c)) errors.push('variance output column already exists: ' + c);
  return { ok: errors.length === 0, errors, leftColumn, rightColumn, outPrefix, tolerance, percent, outColumns };
}

/** خطة كشف الشواذ: الطريقة والحد والإجراء */
function outlierPlan(columns, step) {
  const s = step && typeof step === 'object' ? step : {};
  const errors = [];
  const cols = Array.isArray(columns) ? columns : null;
  const column = String(s.column || '').trim();
  const method = String(s.method || 'iqr').toLowerCase();
  const action = String(s.action || 'flag').toLowerCase();
  const defaultThreshold = method === 'zscore' ? 3 : 1.5;
  const threshold = s.threshold === undefined || s.threshold === '' ? defaultThreshold : Number(s.threshold);
  const out = String(s.out || 'is_outlier').trim() || 'is_outlier';
  if (!column) errors.push('outlier requires column');
  if (!OUTLIER_METHODS.includes(method)) errors.push('outlier invalid method: ' + method);
  if (!OUTLIER_ACTIONS.includes(action)) errors.push('outlier invalid action: ' + action);
  if (!Number.isFinite(threshold) || threshold <= 0) errors.push('outlier threshold must be a positive number');
  if (cols && column && !cols.includes(column)) errors.push('outlier unknown column: ' + column);
  if (action === 'flag' && cols && cols.includes(out)) errors.push('outlier output column already exists: ' + out);
  return {
    ok: errors.length === 0, errors, column, method, action, threshold, out,
    outColumns: action === 'flag' ? (cols ? cols.concat([out]) : null) : (cols ? cols.slice() : null),
  };
}

/** خطة فحص جودة البيانات: قواعد notNull / unique / range / regex */
function qualityPlan(columns, step) {
  const s = step && typeof step === 'object' ? step : {};
  const errors = [];
  const cols = Array.isArray(columns) ? columns : null;
  const notNull = keyList(s.notNull);
  const unique = keyList(s.unique);
  const range = s.range && typeof s.range === 'object' ? s.range : {};
  const regex = s.regex && typeof s.regex === 'object' ? s.regex : {};
  const rangeColumn = String(range.column || '').trim();
  const rangeMin = range.min === undefined || range.min === '' ? null : Number(range.min);
  const rangeMax = range.max === undefined || range.max === '' ? null : Number(range.max);
  const regexColumn = String(regex.column || '').trim();
  const regexPattern = String(regex.pattern || '');
  const typeCheck = s.typeCheck && typeof s.typeCheck === 'object' ? s.typeCheck : {};
  const typeColumn = String(typeCheck.column || '').trim();
  const typeExpected = String(typeCheck.expected || '').trim();
  const rules = [];
  if (notNull.length) rules.push({ type: 'notNull', columns: notNull });
  if (unique.length) rules.push({ type: 'unique', columns: unique });
  if (rangeColumn) rules.push({ type: 'range', column: rangeColumn, min: rangeMin, max: rangeMax });
  if (regexColumn) rules.push({ type: 'regex', column: regexColumn, pattern: regexPattern });
  if (typeColumn) rules.push({ type: 'type', column: typeColumn, expected: typeExpected });
  if (!rules.length) errors.push('quality requires at least one check');
  if (cols) {
    for (const c of notNull) if (!cols.includes(c)) errors.push('quality unknown notNull column: ' + c);
    for (const c of unique) if (!cols.includes(c)) errors.push('quality unknown unique column: ' + c);
    if (rangeColumn && !cols.includes(rangeColumn)) errors.push('quality unknown range column: ' + rangeColumn);
    if (regexColumn && !cols.includes(regexColumn)) errors.push('quality unknown regex column: ' + regexColumn);
    if (typeColumn && !cols.includes(typeColumn)) errors.push('quality unknown type column: ' + typeColumn);
  }
  if (rangeColumn) {
    if (rangeMin === null && rangeMax === null) errors.push('quality range requires min or max');
    if (rangeMin !== null && !Number.isFinite(rangeMin)) errors.push('quality range min must be a number');
    if (rangeMax !== null && !Number.isFinite(rangeMax)) errors.push('quality range max must be a number');
    if (rangeMin !== null && rangeMax !== null && rangeMin > rangeMax) errors.push('quality range min must be <= max');
  }
  if (regexColumn) {
    if (!regexPattern) errors.push('quality regex requires pattern');
    else {
      try { new RegExp(regexPattern); }
      catch (e) { errors.push('quality regex invalid: ' + e.message); }
    }
  }
  if (typeColumn && ['number', 'string', 'date', 'boolean'].indexOf(typeExpected) < 0) {
    errors.push('quality typeCheck expected must be number|string|date|boolean');
  }
  return {
    ok: errors.length === 0, errors, rules, notNull, unique,
    range: { column: rangeColumn, min: rangeMin, max: rangeMax },
    regex: { column: regexColumn, pattern: regexPattern },
    typeCheck: { column: typeColumn, expected: typeExpected },
  };
}

/** مفتاح صف من عدة أعمدة (مقارنة/تجميع) */
const rowKey = (row, keys) => JSON.stringify((keys || []).map(k => row ? row[k] : undefined));

/** ترتيب مستقر مع مفاتيح متعددة — الفارغ أخيرًا دائمًا */
function stableSortRows(rows, keys, dir) {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => {
    for (const k of keys) {
      const av = a.r[k], bv = b.r[k];
      if (av === bv) continue;
      if (isNullish(av) || av === '') return 1;
      if (isNullish(bv) || bv === '') return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), 'ar') * dir;
    }
    return a.i - b.i;
  }).map(x => x.r);
}

function now() { return new Date().toISOString(); }

function inferType(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (v instanceof Date) return 'date';
  return 'string';
}

function colTypes(rows) {
  const types = {};
  const sample = rows.slice(0, 50);
  for (const r of sample) {
    for (const k of Object.keys(r)) {
      if (types[k] && types[k] !== 'null') continue;
      const t = inferType(r[k]);
      if (t !== 'null') types[k] = t;
    }
  }
  for (const k of Object.keys(types)) if (!types[k]) types[k] = 'string';
  return types;
}

/* ---------- validation ---------- */
function validateStep(step, columns) {
  const errors = [];
  if (!step || typeof step !== 'object') { errors.push('step must be object'); return { ok: false, errors }; }
  if (!STEP_TYPES.includes(step.type)) errors.push('unknown step type: ' + step.type);
  const cols = columns || [];
  switch (step.type) {
    case 'select': {
      if (!Array.isArray(step.columns) || step.columns.length === 0) errors.push('select requires non-empty columns[]');
      for (const c of (step.columns || [])) if (!cols.includes(c)) errors.push('unknown column: ' + c);
      const rn = selectRenamePlan(step.columns, step.renames);
      if (!rn.ok) errors.push(...rn.errors);
      break;
    }
    case 'filter': {
      if (!step.column || !cols.includes(step.column)) errors.push('filter requires valid column');
      if (!FILTER_OPS.includes(step.op)) errors.push('invalid filter op: ' + step.op);
      if (step.op !== 'isNull' && step.op !== 'isNotNull' && (step.value === undefined || step.value === null)) errors.push('filter requires value');
      break;
    }
    case 'compute': {
      if (!step.newColumn || typeof step.newColumn !== 'string') errors.push('compute requires newColumn');
      if (cols.includes(step.newColumn)) errors.push('column already exists: ' + step.newColumn);
      /* إمّا تعبير مباشر أو معادلة محفوظة (تُحلّ إلى تعبيرها قبل التنفيذ) */
      if (step.formulaId) {
        if (!step.formula) errors.push('compute with formulaId requires the resolved formula');
      } else if (!step.formula || typeof step.formula !== 'string') errors.push('compute requires formula or formulaId');
      else {
        const v = formulas.validateFormula(step.formula);
        if (!v.ok) errors.push(...v.errors.map(e => 'formula: ' + e));
      }
      break;
    }
    case 'groupBy': {
      if (!Array.isArray(step.keys) || step.keys.length === 0) errors.push('groupBy requires non-empty keys[]');
      for (const k of (step.keys || [])) if (!cols.includes(k)) errors.push('unknown key column: ' + k);
      if (!Array.isArray(step.aggs) || step.aggs.length === 0) errors.push('groupBy requires non-empty aggs[]');
      for (const a of (step.aggs || [])) {
        if (!AGG_FNS.includes(a.fn)) errors.push('unknown agg fn: ' + a.fn);
        if (a.fn !== 'COUNT' && (!a.column || !cols.includes(a.column))) errors.push('agg requires valid column: ' + (a.column || ''));
        if (!a.out || typeof a.out !== 'string') errors.push('agg requires out name');
      }
      break;
    }
    case 'pivot': {
      const p = pivotPlan(cols, step);
      if (!p.ok) errors.push(...p.errors);
      break;
    }
    case 'unpivot': {
      const u = unpivotPlan(cols, step);
      if (!u.ok) errors.push(...u.errors);
      break;
    }
    case 'join': {
      const keys = joinKeys(step);
      if (!keys.leftKeys.length) errors.push('join requires leftKeys[] or leftKey');
      if (!keys.rightKeys.length) errors.push('join requires rightKeys[] or rightKey');
      if (keys.leftKeys.length !== keys.rightKeys.length) errors.push('join requires equal number of left/right keys');
      for (const k of keys.leftKeys) if (!cols.includes(k)) errors.push('join unknown left key: ' + k);
      /* إمّا صفوف حرفية (قائمة قديمة) أو مصدر مسجَّل في الفهرس */
      const hasRightRows = Array.isArray(step.rightRows);
      if (!hasRightRows && !step.rightSource) errors.push('join requires rightRows[] or rightSource');
      if (hasRightRows && step.rightRows.length) {
        for (const k of keys.rightKeys) if (!step.rightRows[0].hasOwnProperty(k)) errors.push('rightKey not found in rightRows: ' + k);
      }
      if (!JOIN_TYPES.includes(step.joinType || 'inner')) errors.push('invalid joinType');
      break;
    }
    case 'union': {
      const hasRightRows = Array.isArray(step.rightRows);
      if (!hasRightRows && !step.rightSource) errors.push('union requires rightRows[] or rightSource');
      if (!UNION_MODES.includes(step.mode || 'align')) errors.push('invalid union mode: ' + step.mode);
      if (hasRightRows && step.mode === 'strict' && step.rightRows.length) {
        const rightCols = Array.isArray(step.rightColumns) && step.rightColumns.length
          ? step.rightColumns : Object.keys(step.rightRows[0] || {});
        const a = cols.slice().sort(), b = rightCols.slice().sort();
        if (JSON.stringify(a) !== JSON.stringify(b)) errors.push('union strict requires identical schemas');
      }
      break;
    }
    case 'compare':
    case 'reconcile': {
      const kind = step.type;
      const keys = compareConfig(step);
      if (!keys.leftKeys.length) errors.push(kind + ' requires leftKeys[]');
      if (!keys.rightKeys.length) errors.push(kind + ' requires rightKeys[] or rightKey');
      if (keys.leftKeys.length !== keys.rightKeys.length) errors.push(kind + ' requires equal number of left/right keys');
      for (const k of keys.leftKeys) if (!cols.includes(k)) errors.push(kind + ' unknown left key: ' + k);
      const hasRightRows = Array.isArray(step.rightRows);
      if (!hasRightRows && !step.rightSource) errors.push(kind + ' requires rightRows[] or rightSource');
      if (hasRightRows && step.rightRows.length) {
        const rightCols = Array.isArray(step.rightColumns) && step.rightColumns.length
          ? step.rightColumns : Object.keys(step.rightRows[0] || {});
        for (const k of keys.rightKeys) if (!rightCols.includes(k)) errors.push(kind + ' unknown right key: ' + k);
        for (const c of (Array.isArray(step.compareColumns) ? step.compareColumns : [])) {
          if (!cols.includes(c) || !rightCols.includes(c)) errors.push(kind + ' column missing from one side: ' + c);
        }
      }
      if (kind === 'reconcile') {
        const tolerance = step.tolerance === undefined || step.tolerance === '' ? 0 : Number(step.tolerance);
        if (!Number.isFinite(tolerance) || tolerance < 0) errors.push('reconcile tolerance must be a non-negative number');
      }
      break;
    }
    case 'variance': {
      const plan = variancePlan(cols, step);
      if (!plan.ok) errors.push(...plan.errors);
      break;
    }
    case 'outlier': {
      const plan = outlierPlan(cols, step);
      if (!plan.ok) errors.push(...plan.errors);
      break;
    }
    case 'quality': {
      const plan = qualityPlan(cols, step);
      if (!plan.ok) errors.push(...plan.errors);
      break;
    }
    case 'dedupe': {
      if (step.keep && !DEDUPE_KEEP.includes(step.keep)) errors.push('invalid dedupe keep: ' + step.keep);
      for (const k of (Array.isArray(step.keys) ? step.keys : [])) if (!cols.includes(k)) errors.push('dedupe unknown key: ' + k);
      break;
    }
    case 'nulls': {
      const action = step.action || 'drop';
      if (!NULL_ACTIONS.includes(action)) errors.push('invalid nulls action: ' + action);
      const selected = Array.isArray(step.columns) ? step.columns : [];
      for (const c of selected) if (!cols.includes(c)) errors.push('nulls unknown column: ' + c);
      if (action === 'fill') {
        if (!selected.length) errors.push('nulls fill requires columns[]');
        if (step.value === undefined || step.value === null) errors.push('nulls fill requires value');
      }
      break;
    }
    case 'window': {
      const op = step.op || 'rowNumber';
      if (!WINDOW_OPS.includes(op)) errors.push('invalid window op: ' + op);
      if (!step.out || typeof step.out !== 'string') errors.push('window requires out name');
      else if (cols.includes(step.out)) errors.push('window output column already exists: ' + step.out);
      for (const k of (Array.isArray(step.partitionBy) ? step.partitionBy : [])) if (!cols.includes(k)) errors.push('window unknown partition column: ' + k);
      for (const k of (Array.isArray(step.orderBy) ? step.orderBy : [])) if (!cols.includes(k)) errors.push('window unknown order column: ' + k);
      if (step.order && !['asc','desc'].includes(step.order)) errors.push('invalid window order');
      if (op === 'runningTotal' && (!step.column || !cols.includes(step.column))) errors.push('window runningTotal requires valid column');
      break;
    }
    case 'sort': {
      const keys = sortKeys(step);
      if (!keys.length) errors.push('sort requires by[]');
      for (const k of keys) if (!cols.includes(k)) errors.push('unknown column: ' + k);
      if (step.order && !['asc','desc'].includes(step.order)) errors.push('invalid sort order');
      break;
    }
    case 'python': {
      const p = PY.validatePythonConfig(step, cols);
      if (!p.ok) errors.push(...p.errors);
      break;
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateStepShape(step) {
  const errors = [];
  if (!step || typeof step !== 'object') { errors.push('step must be object'); return { ok: false, errors }; }
  if (!STEP_TYPES.includes(step.type)) { errors.push('unknown step type: ' + step.type); return { ok: false, errors }; }
  switch (step.type) {
    case 'select': {
      if (!Array.isArray(step.columns) || step.columns.length === 0) errors.push('select requires non-empty columns[]');
      const rn = selectRenamePlan(step.columns, step.renames);
      if (!rn.ok) errors.push(...rn.errors);
      break;
    }
    case 'filter':
      if (!step.column) errors.push('filter requires column');
      if (!FILTER_OPS.includes(step.op)) errors.push('invalid filter op: ' + step.op);
      if (step.op !== 'isNull' && step.op !== 'isNotNull' && (step.value === undefined || step.value === null)) errors.push('filter requires value');
      break;
    case 'compute':
      if (!step.newColumn || typeof step.newColumn !== 'string') errors.push('compute requires newColumn');
      if (step.formulaId) { /* يُحلّ إلى تعبيره عند التنفيذ/المعاينة */ }
      else if (!step.formula || typeof step.formula !== 'string') errors.push('compute requires formula or formulaId');
      else { const v = formulas.validateFormula(step.formula); if (!v.ok) errors.push(...v.errors.map(e => 'formula: ' + e)); }
      break;
    case 'groupBy':
      if (!Array.isArray(step.keys) || step.keys.length === 0) errors.push('groupBy requires non-empty keys[]');
      if (!Array.isArray(step.aggs) || step.aggs.length === 0) errors.push('groupBy requires non-empty aggs[]');
      for (const a of (step.aggs || [])) {
        if (!AGG_FNS.includes(a.fn)) errors.push('unknown agg fn: ' + a.fn);
        if (a.fn !== 'COUNT' && !a.column) errors.push('agg requires column');
        if (!a.out) errors.push('agg requires out name');
      }
      break;
    case 'pivot': {
      const p = pivotPlan(null, step);
      if (!p.ok) errors.push(...p.errors);
      break;
    }
    case 'unpivot': {
      const u = unpivotPlan(null, step);
      if (!u.ok) errors.push(...u.errors);
      break;
    }
    case 'join': {
      const keys = joinKeys(step);
      if (!keys.leftKeys.length) errors.push('join requires leftKeys[] or leftKey');
      if (!keys.rightKeys.length) errors.push('join requires rightKeys[] or rightKey');
      if (keys.leftKeys.length !== keys.rightKeys.length) errors.push('join requires equal number of left/right keys');
      if (!Array.isArray(step.rightRows) && !step.rightSource) errors.push('join requires rightRows[] or rightSource');
      if (step.joinType && !JOIN_TYPES.includes(step.joinType)) errors.push('invalid joinType');
      break;
    }
    case 'union':
      if (!Array.isArray(step.rightRows) && !step.rightSource) errors.push('union requires rightRows[] or rightSource');
      if (step.mode && !UNION_MODES.includes(step.mode)) errors.push('invalid union mode: ' + step.mode);
      break;
    case 'compare':
    case 'reconcile': {
      const kind = step.type;
      const keys = compareConfig(step);
      if (!keys.leftKeys.length) errors.push(kind + ' requires leftKeys[]');
      if (!keys.rightKeys.length) errors.push(kind + ' requires rightKeys[] or rightKey');
      if (keys.leftKeys.length !== keys.rightKeys.length) errors.push(kind + ' requires equal number of left/right keys');
      if (!Array.isArray(step.rightRows) && !step.rightSource) errors.push(kind + ' requires rightRows[] or rightSource');
      if (kind === 'reconcile') {
        const tolerance = step.tolerance === undefined || step.tolerance === '' ? 0 : Number(step.tolerance);
        if (!Number.isFinite(tolerance) || tolerance < 0) errors.push('reconcile tolerance must be a non-negative number');
      }
      break;
    }
    case 'variance': {
      const plan = variancePlan(null, step);
      if (!plan.ok) errors.push(...plan.errors);
      break;
    }
    case 'outlier': {
      const plan = outlierPlan(null, step);
      if (!plan.ok) errors.push(...plan.errors);
      break;
    }
    case 'quality': {
      const plan = qualityPlan(null, step);
      if (!plan.ok) errors.push(...plan.errors);
      break;
    }
    case 'dedupe':
      if (step.keep && !DEDUPE_KEEP.includes(step.keep)) errors.push('invalid dedupe keep: ' + step.keep);
      break;
    case 'nulls':
      if (step.action && !NULL_ACTIONS.includes(step.action)) errors.push('invalid nulls action: ' + step.action);
      if ((step.action || 'drop') === 'fill' && (!Array.isArray(step.columns) || !step.columns.length)) errors.push('nulls fill requires columns[]');
      if ((step.action || 'drop') === 'fill' && (step.value === undefined || step.value === null)) errors.push('nulls fill requires value');
      break;
    case 'window':
      if (!step.out) errors.push('window requires out name');
      if (step.op && !WINDOW_OPS.includes(step.op)) errors.push('invalid window op: ' + step.op);
      if ((step.op || 'rowNumber') === 'runningTotal' && !step.column) errors.push('window runningTotal requires column');
      break;
    case 'sort': {
      const keys = sortKeys(step);
      if (!keys.length) errors.push('sort requires by[]');
      if (step.order && !['asc','desc'].includes(step.order)) errors.push('invalid sort order');
      break;
    }
    case 'python': {
      const p = PY.validatePythonConfig(step, null);
      if (!p.ok) errors.push(...p.errors);
      break;
    }
  }
  return { ok: errors.length === 0, errors };
}
function validateWorkflow(wf) {
  const errors = [];
  if (!wf || typeof wf !== 'object') { errors.push('workflow must be object'); return { ok: false, errors }; }
  if (!wf.name || typeof wf.name !== 'string') errors.push('workflow requires name');
  if (!wf.source) errors.push('workflow requires source');
  if (!Array.isArray(wf.steps)) {
    errors.push('steps must be array');
    return { ok: errors.length === 0, errors };
  }
  if (wf.steps.length > MAX_STEPS) errors.push('workflow has too many steps (' + wf.steps.length + ' > ' + MAX_STEPS + ')');
  const seenIds = new Set();
  wf.steps.forEach((s) => {
    const id = s && s.id ? String(s.id) : '';
    if (id) {
      if (seenIds.has(id)) errors.push('duplicate step id: ' + id);
      seenIds.add(id);
    }
  });
  return { ok: errors.length === 0, errors };
}

/* ---------- step runners ---------- */
function runSelect(rows, step) {
  const plan = selectRenamePlan(step.columns, step.renames);
  if (!plan.ok) throw new Error('select: ' + plan.errors.join('; '));
  const out = rows.map(r => {
    const o = {};
    for (const c of step.columns) o[plan.map.get(c) || c] = r[c];
    return o;
  });
  const msg = plan.map.size
    ? 'selected ' + step.columns.length + ' columns, renamed ' + plan.map.size
    : 'selected ' + step.columns.length + ' columns';
  return { rows: out, columns: plan.columns.slice(), message: msg };
}

function runFilter(rows, cols, step) {
  const out = rows.filter(r => {
    const v = r[step.column];
    switch (step.op) {
      case 'eq': return v === step.value;
      case 'ne': return v !== step.value;
      case 'gt': return (v > step.value);
      case 'gte': return (v >= step.value);
      case 'lt': return (v < step.value);
      case 'lte': return (v <= step.value);
      case 'contains': return String(v === null || v === undefined ? '' : v).toLowerCase().includes(String(step.value === null || step.value === undefined ? '' : step.value).toLowerCase());
      case 'startsWith': return String(v === null || v === undefined ? '' : v).toLowerCase().startsWith(String(step.value === null || step.value === undefined ? '' : step.value).toLowerCase());
      case 'in': return Array.isArray(step.value) ? step.value.includes(v) : false;
      case 'isNull': return isNullish(v) || v === '';
      case 'isNotNull': return !isNullish(v) && v !== '';
      default: return true;
    }
  });
  return { rows: out, columns: cols.slice(), message: 'filtered ' + (rows.length - out.length) + ' rows removed' };
}

function runCompute(rows, cols, step) {
  const warnings = [];
  const out = rows.map(r => {
    const res = formulas.evaluateFormula(step.formula, r);
    if (!res.ok) throw new Error(res.errors.join('; '));
    if (res.warnings && res.warnings.length) warnings.push(...res.warnings);
    const o = Object.assign({}, r);
    o[step.newColumn] = res.value;
    return o;
  });
  const newCols = cols.concat([step.newColumn]);
  const msg = warnings.length ? 'computed with warnings: ' + warnings.join(', ') : 'computed ' + step.newColumn;
  return { rows: out, columns: newCols, message: msg, warnings };
}

/** حساب تجميعة واحدة — مصدر واحد لدلالات groupBy وpivot */
function aggregateValue(vals, fn, rowCount) {
  const values = Array.isArray(vals) ? vals : [];
  switch (fn) {
    case 'COUNT': return rowCount;
    case 'COUNT_DISTINCT': return new Set(values.filter(v => v !== null && v !== undefined)).size;
    case 'SUM': return values.filter(v => v !== null && v !== undefined).reduce((s, v) => s + (typeof v === 'number' ? v : (Number(v) || 0)), 0);
    case 'AVG': {
      const nums = numericValues(values);
      return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
    }
    case 'MIN': {
      const nums = numericValues(values);
      return nums.length ? Math.min(...nums) : null;
    }
    case 'MAX': {
      const nums = numericValues(values);
      return nums.length ? Math.max(...nums) : null;
    }
    case 'MEDIAN': {
      const nums = numericValues(values).sort((x, y) => x - y);
      if (!nums.length) return null;
      const mid = Math.floor(nums.length / 2);
      return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
    }
    case 'STDEV': {
      const nums = numericValues(values);
      if (nums.length < 2) return null;
      const mean = nums.reduce((s, n) => s + n, 0) / nums.length;
      const variance = nums.reduce((s, n) => s + Math.pow(n - mean, 2), 0) / (nums.length - 1);
      return Math.sqrt(variance);
    }
    default: return null;
  }
}

function runGroupBy(rows, cols, step) {
  const groups = new Map();
  for (const r of rows) {
    const key = JSON.stringify(step.keys.map(k => r[k]));
    if (!groups.has(key)) groups.set(key, { keyVals: step.keys.map(k => r[k]), rows: [] });
    groups.get(key).rows.push(r);
  }
  const outCols = step.keys.slice().concat(step.aggs.map(a => a.out));
  const out = [];
  for (const g of groups.values()) {
    const o = {};
    step.keys.forEach((k, i) => { o[k] = g.keyVals[i]; });
    for (const a of step.aggs) {
      o[a.out] = aggregateValue(g.rows.map(r => r[a.column]), a.fn, g.rows.length);
    }
    out.push(o);
  }
  return { rows: out, columns: outCols, message: 'grouped into ' + out.length + ' groups' };
}

/* ---------- الجدول المحوري (Pivot / Cross-tab) ---------- */
function runPivot(rows, cols, step) {
  const plan = pivotPlan(cols, step);
  if (!plan.ok) throw new Error('pivot: ' + plan.errors.join('; '));
  const { rowKeys, columnKeys, values, prefix } = plan;

  /* أعمدة المحورية الفعلية = توليفات القيم في البيانات، بترتيب ثابت */
  const comboByKey = new Map();
  const combos = [];
  for (const r of rows) {
    const vals = columnKeys.map(k => r[k]);
    const key = JSON.stringify(vals);
    if (comboByKey.has(key)) continue;
    const combo = { key, values: vals, label: pivotLabel(vals), order: combos.length };
    comboByKey.set(key, combo);
    combos.push(combo);
  }
  combos.sort((a, b) => a.label.localeCompare(b.label, 'ar', { numeric: true }) || a.order - b.order);
  const labelSeen = new Map();
  for (const c of combos) {
    let label = c.label;
    if (labelSeen.has(label)) {
      let n = 2;
      while (labelSeen.has(label + ' #' + n)) n += 1;
      label = label + ' #' + n;
    }
    labelSeen.set(label, true);
    c.label = label;
  }

  const outCols = rowKeys.slice();
  const used = new Set(outCols);
  const valueCols = [];
  for (const v of values) {
    const base = pivotValueBase(v);
    for (const c of combos) {
      let name = prefix + base + '__' + c.label;
      if (used.has(name)) {
        let n = 2;
        while (used.has(name + '#' + n)) n += 1;
        name = name + '#' + n;
      }
      used.add(name);
      outCols.push(name);
      valueCols.push({ spec: v, combo: c, name });
    }
  }

  /* مجموعة الصفوف + خلايا كل مجموعة (مفتاح الصف × مفتاح عمود المحورية) */
  const groups = new Map();
  for (const r of rows) {
    const rk = JSON.stringify(rowKeys.map(k => r[k]));
    if (!groups.has(rk)) groups.set(rk, { rowVals: rowKeys.map(k => r[k]), cells: new Map() });
    const g = groups.get(rk);
    const ck = JSON.stringify(columnKeys.map(k => r[k]));
    if (!g.cells.has(ck)) g.cells.set(ck, []);
    g.cells.get(ck).push(r);
  }
  const hasFill = Object.prototype.hasOwnProperty.call(step, 'fill') && step.fill !== undefined;
  const out = [];
  for (const g of groups.values()) {
    const o = {};
    rowKeys.forEach((k, i) => { o[k] = g.rowVals[i]; });
    for (const vc of valueCols) {
      const cellRows = g.cells.get(vc.combo.key) || [];
      if (!cellRows.length) {
        const fn = vc.spec.fn;
        o[vc.name] = hasFill ? step.fill : ((fn === 'COUNT' || fn === 'COUNT_DISTINCT') ? 0 : null);
      } else {
        o[vc.name] = aggregateValue(cellRows.map(r => r[vc.spec.column]), vc.spec.fn, cellRows.length);
      }
    }
    out.push(o);
  }
  return {
    rows: out,
    columns: outCols,
    message: 'pivot: ' + out.length + ' صفًا × ' + combos.length + ' عمود محورية (' + outCols.length + ' عمود ناتج)',
  };
}

/* ---------- إلغاء المحورية (Unpivot / Wide → Long) ---------- */
function runUnpivot(rows, cols, step) {
  const plan = unpivotPlan(cols, step);
  if (!plan.ok) throw new Error('unpivot: ' + plan.errors.join('; '));
  const out = [];
  for (const r of rows) {
    for (const vc of plan.valueColumns) {
      if (plan.dropNulls && (r[vc] === null || r[vc] === undefined)) continue;
      const o = {};
      for (const id of plan.idColumns) o[id] = r[id];
      o[plan.keyName] = vc;
      o[plan.valueName] = r[vc];
      out.push(o);
    }
  }
  return {
    rows: out,
    columns: plan.idColumns.concat([plan.keyName, plan.valueName]),
    message: 'unpivot: ' + plan.valueColumns.length + ' أعمدة × ' + rows.length + ' صفًا = ' + out.length + ' صفًا',
  };
}

function runJoin(rows, cols, step) {
  const rightRows = step.rightRows;
  if (!Array.isArray(rightRows)) throw new Error('join requires rightRows[] (resolve rightSource first)');
  const keys = joinKeys(step);
  if (!keys.leftKeys.length || !keys.rightKeys.length) throw new Error('join requires leftKeys[] and rightKeys[]');
  if (keys.leftKeys.length !== keys.rightKeys.length) throw new Error('join requires equal number of left/right keys');
  const joinType = step.joinType || 'inner';
  // index right by composite key
  const index = new Map();
  for (const r of rightRows) {
    const k = rowKey(r, keys.rightKeys);
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(r);
  }
  const out = [];
  const rightCols = rightRows.length ? Object.keys(rightRows[0]) : [];
  const outCols = cols.slice().concat(rightCols.filter(c => !cols.includes(c)).map(c => step.rightPrefix ? step.rightPrefix + c : c));
  // check row duplication
  let dupWarning = false;
  for (const r of rows) {
    const k = rowKey(r, keys.leftKeys);
    const matches = index.get(k) || [];
    if (matches.length > 1) dupWarning = true;
  }
  for (const r of rows) {
    const k = rowKey(r, keys.leftKeys);
    const matches = index.get(k) || [];
    if (matches.length === 0) {
      if (joinType === 'left') {
        const o = Object.assign({}, r);
        for (const c of rightCols) {
          const outName = step.rightPrefix ? step.rightPrefix + c : c;
          if (!cols.includes(outName)) o[outName] = null;
        }
        out.push(o);
      }
      // inner: skip
    } else {
      for (const m of matches) {
        const o = Object.assign({}, r);
        for (const c of rightCols) {
          const outName = step.rightPrefix ? step.rightPrefix + c : c;
          if (!cols.includes(outName)) o[outName] = m[c];
        }
        out.push(o);
      }
    }
  }
  const grainNote = step.rightGrain ? ' [' + (step.rightSourceLabel || step.rightSource || '') + ' — مستوى: ' + step.rightGrain + ']' : '';
  const relation = step.relation || 'many-to-one';

  /* ---- حالة اكتمال الربط ----
   * - complete            : الطرف الأيمن كامل، ولا تضخيم غير متوقّع.
   * - possibly-truncated  : مقتطع، لكن النتيجة *مثبتة* غير متأثرة (كل مفاتيح اليسار
   *                         مطابقة، ولا مفتاح مكرر يمسّ الضم).
   * - incomplete          : مقتطع بلا إثبات، أو تضخيم بسبب مفتاح غير فريد في علاقة
   *                         متعدد-إلى-واحد ⇒ لا يجوز الاعتماد على مجاميعه.
   * علاقة متعدد-إلى-متعدد: تكرار الطرف الأيمن سلوك متوقّع ⇒ ملاحظة لا خطأ. */
  const rightKeyCounts = new Map();
  for (const r of rightRows) {
    const k = rowKey(r, keys.rightKeys);
    rightKeyCounts.set(k, (rightKeyCounts.get(k) || 0) + 1);
  }
  const duplicatedKeys = [...rightKeyCounts.values()].filter(n => n > 1).length;
  const leftKeys = new Set(rows.map(r => rowKey(r, keys.leftKeys)));
  let matchedLeft = 0;
  for (const k of leftKeys) if (rightKeyCounts.has(k)) matchedLeft += 1;
  const allLeftMatched = leftKeys.size === 0 || matchedLeft === leftKeys.size;
  const unexpectedDup = relation === 'many-to-one' && duplicatedKeys > 0;

  let completeness = 'complete';
  const warnings = [];
  if (step.rightTruncated) {
    if (allLeftMatched && !unexpectedDup) {
      completeness = 'possibly-truncated';
      warnings.push('الطرف الأيمن بلغ حد الصفوف (' + (step.rightLimit || 0) + ') — لكن كل مفاتيح اليسار مطابقة ولا تكرار، فالنتيجة غير متأثرة' + grainNote);
    } else {
      completeness = 'incomplete';
      warnings.push('الطرف الأيمن مقتطع عند حد الصفوف (' + (step.rightLimit || 0) + ') — قد توجد صفوف بلا مطابقة: لا يجوز الاعتماد على مجاميع هذا الربط' + grainNote);
    }
  }
  if (unexpectedDup) {
    completeness = 'incomplete';
    warnings.push('مفتاح غير فريد في الطرف الأيمن (' + duplicatedKeys + ' مفتاح مكرر) في علاقة متعدد-إلى-واحد ⇒ تكرار الصفوف وتضخيم المجاميع' + grainNote);
  } else if (dupWarning && relation !== 'many-to-one') {
    warnings.push('تكرار في الطرف الأيمن متوقّع في علاقة ' + relation + ' (ليس تضخيمًا غير متوقّع)' + grainNote);
  }
  const msg = (completeness === 'incomplete' ? 'join done with WARNING: not complete — ' : (completeness === 'possibly-truncated' ? 'join done with WARNING: possibly truncated — ' : 'join done'))
    + (completeness === 'complete' ? '' : warnings[0]);
  return { rows: out, columns: outCols, message: msg, warnings, completeness };
}

/* ---------- اتحاد الجداول ---------- */
function runUnion(rows, cols, step) {
  const rightRows = Array.isArray(step.rightRows) ? step.rightRows : null;
  if (!rightRows) throw new Error('union requires rightRows[] (resolve rightSource first)');
  const rightCols = Array.isArray(step.rightColumns) && step.rightColumns.length
    ? step.rightColumns
    : (rightRows.length ? Object.keys(rightRows[0] || {}) : []);
  const mode = step.mode || 'align';
  if (mode === 'strict') {
    const a = cols.slice().sort(), b = rightCols.slice().sort();
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error('union (strict): schemas differ — left [' + cols.join(', ') + '] / right [' + rightCols.join(', ') + ']');
    }
    const out = rows.concat(rightRows.map(r => {
      const o = {};
      for (const c of cols) o[c] = r[c];
      return o;
    }));
    return { rows: out, columns: cols.slice(), message: 'union (strict): ' + out.length + ' rows' };
  }
  if (mode !== 'align') throw new Error('union: invalid mode ' + mode);
  const outCols = cols.concat(rightCols.filter(c => !cols.includes(c)));
  const out = rows.map(r => Object.assign({}, r)).concat(rightRows.map(r => Object.assign({}, r)));
  return { rows: out, columns: outCols, message: 'union (align): ' + out.length + ' rows, ' + outCols.length + ' columns' };
}

/* ---------- إزالة التكرار ---------- */
function runDedupe(rows, cols, step) {
  const keys = Array.isArray(step.keys) && step.keys.length ? step.keys : cols;
  const keep = step.keep === 'last' ? 'last' : 'first';
  if (keep === 'last') {
    const map = new Map();
    for (const r of rows) {
      const k = rowKey(r, keys);
      if (map.has(k)) map.delete(k);
      map.set(k, r);
    }
    const out = Array.from(map.values());
    return { rows: out, columns: cols.slice(), message: 'dedupe (last): ' + (rows.length - out.length) + ' rows removed' };
  }
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = rowKey(r, keys);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return { rows: out, columns: cols.slice(), message: 'dedupe (first): ' + (rows.length - out.length) + ' rows removed' };
}

/* ---------- القيم الفارغة ---------- */
function runNulls(rows, cols, step) {
  const action = step.action === 'fill' ? 'fill' : 'drop';
  const selected = Array.isArray(step.columns) && step.columns.length ? step.columns : cols;
  const treatEmpty = !!step.treatEmpty;
  const bad = v => isNullish(v) || (treatEmpty && v === '');
  if (action === 'fill') {
    const out = rows.map(r => {
      const o = Object.assign({}, r);
      for (const c of selected) if (bad(o[c])) o[c] = step.value;
      return o;
    });
    return { rows: out, columns: cols.slice(), message: 'nulls filled in ' + selected.length + ' columns' };
  }
  const out = rows.filter(r => !selected.some(c => bad(r[c])));
  return { rows: out, columns: cols.slice(), message: 'nulls drop: ' + (rows.length - out.length) + ' rows removed' };
}

/* ---------- مقارنة جدولين / تسوية بتفاوت ---------- */
function runCompare(rows, cols, step) {
  const rightRows = Array.isArray(step.rightRows) ? step.rightRows : null;
  if (!rightRows) throw new Error('compare requires rightRows[] (resolve rightSource first)');
  const keys = compareConfig(step);
  const leftKeys = keys.leftKeys;
  const rightKeys = keys.rightKeys;
  if (!leftKeys.length || !rightKeys.length) throw new Error('compare requires leftKeys[] and rightKeys[]');
  if (leftKeys.length !== rightKeys.length) throw new Error('compare requires equal number of left/right keys');
  const hasTolerance = step.tolerance !== undefined && step.tolerance !== null && step.tolerance !== '';
  const tolerance = hasTolerance ? Number(step.tolerance) : null;
  if (hasTolerance && (!Number.isFinite(tolerance) || tolerance < 0)) throw new Error('compare tolerance must be a non-negative number');
  const includeDiff = !!step.includeDiff;
  const rightCols = Array.isArray(step.rightColumns) && step.rightColumns.length
    ? step.rightColumns
    : (rightRows.length ? Object.keys(rightRows[0] || {}) : []);
  let cmpCols = Array.isArray(step.compareColumns) && step.compareColumns.length
    ? step.compareColumns
    : cols.filter(c => rightCols.includes(c) && !leftKeys.includes(c));
  cmpCols = cmpCols.filter(c => cols.includes(c) && rightCols.includes(c));
  const warnings = [];
  const rightIndex = new Map();
  for (const r of rightRows) {
    const k = rowKey(r, rightKeys);
    if (!rightIndex.has(k)) rightIndex.set(k, []);
    rightIndex.get(k).push(r);
  }
  for (const [k, list] of rightIndex) if (list.length > 1) warnings.push('مفتاح مكرر في الطرف الثاني: ' + k + ' (' + list.length + ' صفوف)');
  const leftKeySet = new Set();
  const out = [];
  const counts = { matched: 0, changed: 0, left_only: 0, right_only: 0 };
  const outColumns = ['__status', '__key', '__left', '__right'].concat(includeDiff ? ['__diff'] : []);
  const pushRow = (status, key, left, right, diffs) => {
    counts[status] += 1;
    if (status === 'matched' && !step.includeMatched) return;
    const row = {
      __status: status,
      __key: key,
      __left: left ? JSON.stringify(left) : null,
      __right: right ? JSON.stringify(right) : null,
    };
    if (includeDiff) row.__diff = diffs && Object.keys(diffs).length ? JSON.stringify(diffs) : null;
    out.push(row);
  };
  for (const r of rows) {
    const k = rowKey(r, leftKeys);
    leftKeySet.add(k);
    const matches = rightIndex.get(k) || [];
    if (!matches.length) { pushRow('left_only', k, r, null, null); continue; }
    const m = matches[0];
    let changed = false;
    const diffs = {};
    for (const c of cmpCols) {
      const lv = r[c], rv = m[c];
      if (hasTolerance) {
        const ln = numOrNull(lv), rn = numOrNull(rv);
        if (ln !== null && rn !== null) {
          const d = rn - ln;
          if (Math.abs(d) > tolerance) { changed = true; diffs[c] = { left: lv, right: rv, diff: d }; }
          continue;
        }
      }
      if (JSON.stringify(lv) !== JSON.stringify(rv)) {
        changed = true;
        diffs[c] = { left: lv, right: rv };
      }
    }
    pushRow(changed ? 'changed' : 'matched', k, r, m, diffs);
  }
  for (const r of rightRows) {
    const k = rowKey(r, rightKeys);
    if (!leftKeySet.has(k)) pushRow('right_only', k, null, r, null);
  }
  return {
    rows: out,
    columns: outColumns,
    message: 'compare: matched ' + counts.matched + ', changed ' + counts.changed
      + ', left_only ' + counts.left_only + ', right_only ' + counts.right_only,
    warnings,
    comparison: counts,
  };
}

function runReconcile(rows, cols, step) {
  const tolerance = step.tolerance === undefined || step.tolerance === '' ? 0 : Number(step.tolerance);
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('reconcile tolerance must be a non-negative number');
  const res = runCompare(rows, cols, Object.assign({}, step, { type: 'compare', tolerance, includeDiff: true }));
  return Object.assign({}, res, {
    message: 'reconcile (tolerance ' + tolerance + '): matched ' + res.comparison.matched
      + ', changed ' + res.comparison.changed + ', left_only ' + res.comparison.left_only
      + ', right_only ' + res.comparison.right_only,
    reconciliation: res.comparison,
  });
}

/* ---------- تحليل التباين ---------- */
function runVariance(rows, cols, step) {
  const plan = variancePlan(cols, step);
  if (!plan.ok) throw new Error('variance: ' + plan.errors.join('; '));
  const out = [];
  const counts = { matched: 0, changed: 0, missing: 0 };
  for (const r of rows) {
    const a = numOrNull(r[plan.leftColumn]);
    const b = numOrNull(r[plan.rightColumn]);
    const o = Object.assign({}, r);
    if (a === null || b === null) {
      counts.missing += 1;
      o[plan.outPrefix + '_diff'] = null;
      o[plan.outPrefix + '_abs_diff'] = null;
      if (plan.percent) o[plan.outPrefix + '_pct_diff'] = null;
      o[plan.outPrefix + '_status'] = 'missing';
    } else {
      const diff = b - a;
      const absDiff = Math.abs(diff);
      const within = absDiff <= plan.tolerance;
      if (within) counts.matched += 1; else counts.changed += 1;
      o[plan.outPrefix + '_diff'] = diff;
      o[plan.outPrefix + '_abs_diff'] = absDiff;
      if (plan.percent) o[plan.outPrefix + '_pct_diff'] = a === 0 ? null : diff / a;
      o[plan.outPrefix + '_status'] = within ? 'matched' : 'changed';
    }
    out.push(o);
  }
  return {
    rows: out,
    columns: cols.concat(plan.outColumns),
    message: 'variance: matched ' + counts.matched + ', changed ' + counts.changed + ', missing ' + counts.missing,
    variance: counts,
  };
}

/* ---------- كشف الشواذ (IQR / Z-Score) ---------- */
function runOutlier(rows, cols, step) {
  const plan = outlierPlan(cols, step);
  if (!plan.ok) throw new Error('outlier: ' + plan.errors.join('; '));
  const nums = numericValues(rows.map(r => r[plan.column]));
  let lower = null, upper = null;
  if (nums.length) {
    if (plan.method === 'iqr') {
      const sorted = nums.slice().sort((a, b) => a - b);
      const quantile = p => {
        const pos = (sorted.length - 1) * p;
        const base = Math.floor(pos);
        const rest = pos - base;
        return sorted[base] + (sorted[base + 1] === undefined ? 0 : rest * (sorted[base + 1] - sorted[base]));
      };
      const q1 = quantile(0.25);
      const q3 = quantile(0.75);
      const iqr = q3 - q1;
      lower = q1 - plan.threshold * iqr;
      upper = q3 + plan.threshold * iqr;
    } else {
      const mean = nums.reduce((s, n) => s + n, 0) / nums.length;
      const variance = nums.reduce((s, n) => s + Math.pow(n - mean, 2), 0) / nums.length;
      const sd = Math.sqrt(variance);
      if (sd > 0) {
        lower = mean - plan.threshold * sd;
        upper = mean + plan.threshold * sd;
      }
    }
  }
  const isOutlier = v => {
    const n = numOrNull(v);
    return n !== null && lower !== null && upper !== null && (n < lower || n > upper);
  };
  let out;
  let flagged = 0;
  if (plan.action === 'remove') {
    out = rows.filter(r => {
      const bad = isOutlier(r[plan.column]);
      if (bad) flagged += 1;
      return !bad;
    });
  } else {
    out = rows.map(r => {
      const bad = isOutlier(r[plan.column]);
      if (bad) flagged += 1;
      return Object.assign({}, r, { [plan.out]: bad });
    });
  }
  const warnings = nums.length ? [] : ['لا توجد قيم رقمية صالحة في العمود «' + plan.column + '» — لم يُكتشف أي شاذ.'];
  return {
    rows: out,
    columns: plan.action === 'flag' ? cols.concat([plan.out]) : cols.slice(),
    message: 'outlier (' + plan.method + ', ' + plan.threshold + '): ' + flagged + (plan.action === 'remove' ? ' rows removed' : ' rows flagged'),
    warnings,
    outlier: { method: plan.method, threshold: plan.threshold, lower, upper, flagged },
  };
}

/** توافق قيمة مع نوع متوقع — أرقام نصية مقبولة كأرقام، والتاريخ ISO/Date فقط. */
function valueMatchesType(value, expected) {
  if (value === null || value === undefined || value === '') return true;
  if (expected === 'number') {
    return (typeof value === 'number' && Number.isFinite(value))
      || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
  }
  if (expected === 'boolean') {
    return typeof value === 'boolean' || value === 'true' || value === 'false' || value === 1 || value === 0;
  }
  if (expected === 'date') {
    if (value instanceof Date) return !isNaN(value);
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(value.trim()) && !isNaN(Date.parse(value));
  }
  if (expected === 'string') return typeof value === 'string';
  return true;
}

/* ---------- فحص جودة البيانات (تقرير) ---------- */
function runQuality(rows, cols, step) {
  const plan = qualityPlan(cols, step);
  if (!plan.ok) throw new Error('quality: ' + plan.errors.join('; '));
  const out = [];
  for (const rule of plan.rules) {
    if (rule.type === 'notNull') {
      for (const c of rule.columns) {
        const bad = rows.filter(r => isNullish(r[c]) || r[c] === '');
        out.push({
          __check: 'notNull', __columns: c,
          __status: bad.length ? 'fail' : 'pass', __issues: bad.length,
          __sample: qualitySample(bad.map(r => r[c])),
        });
      }
    } else if (rule.type === 'unique') {
      const counts = new Map();
      for (const r of rows) {
        const k = rowKey(r, rule.columns);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      const dupKeys = [...counts.entries()].filter(([, n]) => n > 1);
      const dupRows = dupKeys.reduce((s, [, n]) => s + n, 0);
      out.push({
        __check: 'unique', __columns: rule.columns.join('+'),
        __status: dupKeys.length ? 'fail' : 'pass', __issues: dupRows,
        __sample: qualitySample(dupKeys.slice(0, 3).map(([k]) => k)),
      });
    } else if (rule.type === 'range') {
      const bad = rows.filter(r => {
        const n = numOrNull(r[rule.column]);
        if (n === null) return true;
        if (rule.min !== null && n < rule.min) return true;
        if (rule.max !== null && n > rule.max) return true;
        return false;
      });
      out.push({
        __check: 'range', __columns: rule.column,
        __status: bad.length ? 'fail' : 'pass', __issues: bad.length,
        __sample: qualitySample(bad.map(r => r[rule.column])),
      });
    } else if (rule.type === 'regex') {
      let re;
      try { re = new RegExp(rule.pattern); }
      catch (e) { throw new Error('quality regex invalid: ' + e.message); }
      const bad = rows.filter(r => {
        const v = r[rule.column];
        return isNullish(v) ? true : !re.test(String(v));
      });
      out.push({
        __check: 'regex', __columns: rule.column,
        __status: bad.length ? 'fail' : 'pass', __issues: bad.length,
        __sample: qualitySample(bad.map(r => r[rule.column])),
      });
    } else if (rule.type === 'type') {
      const bad = rows.filter(r => !valueMatchesType(r[rule.column], rule.expected));
      out.push({
        __check: 'type', __columns: rule.column,
        __status: bad.length ? 'fail' : 'pass', __issues: bad.length,
        __sample: qualitySample(bad.map(r => r[rule.column])),
      });
    }
  }
  const issues = out.reduce((s, r) => s + r.__issues, 0);
  return {
    rows: out,
    columns: QUALITY_COLUMNS.slice(),
    message: 'quality: ' + out.length + ' checks, ' + issues + ' issues',
    quality: { pass: issues === 0, checks: out.length, issues },
  };
}

/* ---------- نافذة: ترقيم/ترتيب/تراكم ---------- */
function runWindow(rows, cols, step) {
  const op = step.op || 'rowNumber';
  if (!WINDOW_OPS.includes(op)) throw new Error('window: invalid op ' + op);
  const outCol = String(step.out || '').trim();
  if (!outCol) throw new Error('window requires out name');
  const partitionBy = Array.isArray(step.partitionBy) ? step.partitionBy : [];
  const orderBy = Array.isArray(step.orderBy) ? step.orderBy : [];
  const dir = step.order === 'desc' ? -1 : 1;
  const groups = new Map();
  rows.forEach((r, i) => {
    const k = rowKey(r, partitionBy);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ r, i });
  });
  const out = new Array(rows.length);
  const cmp = (a, b) => {
    for (const k of orderBy) {
      const av = a.r[k], bv = b.r[k];
      if (av === bv) continue;
      if (isNullish(av) || av === '') return 1;
      if (isNullish(bv) || bv === '') return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), 'ar') * dir;
    }
    return a.i - b.i;
  };
  for (const list of groups.values()) {
    const sorted = orderBy.length ? list.slice().sort(cmp) : list.slice();
    let running = 0;
    let prevRank = 0;
    let prevVals = null;
    sorted.forEach((item, idx) => {
      const o = Object.assign({}, item.r);
      if (op === 'runningTotal') {
        const n = typeof item.r[step.column] === 'number' ? item.r[step.column] : Number(item.r[step.column]);
        running += Number.isFinite(n) ? n : 0;
        o[outCol] = running;
      } else if (op === 'rank') {
        const vals = orderBy.map(k => item.r[k]);
        const same = prevVals && JSON.stringify(vals) === JSON.stringify(prevVals);
        const rank = orderBy.length ? (same ? prevRank : idx + 1) : idx + 1;
        o[outCol] = rank;
        prevRank = rank;
        prevVals = vals;
      } else {
        o[outCol] = idx + 1;
      }
      out[item.i] = o;
    });
  }
  for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = Object.assign({}, rows[i], { [outCol]: null });
  return { rows: out, columns: cols.concat([outCol]), message: 'window ' + op + ': ' + outCol };
}

/* ---------- ترتيب ---------- */
/** ترتيب متعدد المفاتيح: الأرقام numeric، النصوص localeCompare، والفارغ أخيراً دائماً */
function runSort(rows, cols, step) {
  const keys = sortKeys(step);
  if (!keys.length) throw new Error('sort requires by[]');
  const dir = step.order === 'desc' ? -1 : 1;
  const out = stableSortRows(rows, keys, dir);
  return { rows: out, columns: cols.slice(), message: 'sorted by ' + keys.join(', ') + ' (' + (dir < 0 ? 'desc' : 'asc') + ')' };
}

/* ---------- execution ---------- */
/** تشغيل خطوة غير Python — نفس المنفّذات المستخدمة في المسار المتزامن وغير المتزامن. */
function runStepSync(step, rows, columns) {
  switch (step.type) {
    case 'select': return runSelect(rows, step);
    case 'filter': return runFilter(rows, columns, step);
    case 'compute': return runCompute(rows, columns, step);
    case 'groupBy': return runGroupBy(rows, columns, step);
    case 'pivot': return runPivot(rows, columns, step);
    case 'unpivot': return runUnpivot(rows, columns, step);
    case 'join': return runJoin(rows, columns, step);
    case 'union': return runUnion(rows, columns, step);
    case 'compare': return runCompare(rows, columns, step);
    case 'reconcile': return runReconcile(rows, columns, step);
    case 'variance': return runVariance(rows, columns, step);
    case 'outlier': return runOutlier(rows, columns, step);
    case 'quality': return runQuality(rows, columns, step);
    case 'dedupe': return runDedupe(rows, columns, step);
    case 'nulls': return runNulls(rows, columns, step);
    case 'window': return runWindow(rows, columns, step);
    case 'sort': return runSort(rows, columns, step);
    case 'python': throw new Error('python step requires executeWorkflowAsync');
    default: throw new Error('unknown step type ' + step.type);
  }
}

function traceEngine(step) {
  return step && step.type === 'python' ? 'python-restricted' : 'javascript';
}

function executeWorkflow(wf, data) {
  const validation = validateWorkflow(wf);
  if (!validation.ok) {
    return { ok: false, error: 'invalid workflow: ' + validation.errors.join('; '), steps: [], rows: null, columns: null, trace: [] };
  }
  // resolve source rows
  let rows = null;
  let columns = null;
  if (data && Array.isArray(data.rows)) {
    rows = data.rows.map(r => Object.assign({}, r));
    columns = data.columns || (rows.length ? Object.keys(rows[0]) : []);
  } else if (data && data.sourceData && Array.isArray(data.sourceData)) {
    rows = data.sourceData.map(r => Object.assign({}, r));
    columns = data.sourceColumns || (rows.length ? Object.keys(rows[0]) : []);
  } else {
    return { ok: false, error: 'no source data provided', steps: [], rows: null, columns: null, trace: [] };
  }
  if (rows.length > MAX_ROWS) {
    return { ok: false, error: 'source rows exceed limit (' + rows.length + ' > ' + MAX_ROWS + ')', steps: [], rows: null, columns: null, trace: [] };
  }
  const execStarted = Date.now();
  const trace = [];
  for (const step of wf.steps) {
    if (Date.now() - execStarted > MAX_EXECUTION_MS) {
      const t = { id: null, type: 'guard', status: 'failed', message: 'execution timeout after ' + MAX_EXECUTION_MS + ' ms', startedAt: now(), rowCount: rows.length };
      trace.push(t);
      return { ok: false, error: t.message, steps: trace, rows: null, columns: null, trace };
    }
    const sv = validateStep(step, columns);
    if (!sv.ok) {
      const t = { id: step.id || step.type, type: step.type, status: 'failed', message: 'validation: ' + sv.errors.join('; '), startedAt: now(), rowCount: rows.length };
      trace.push(t);
      return { ok: false, error: t.message, steps: trace, rows: null, columns: null, trace };
    }
    const startedAt = now();
    try {
      const res = runStepSync(step, rows, columns);
      rows = res.rows;
      columns = res.columns;
      if (rows.length > MAX_ROWS) throw new Error('result rows exceed limit (' + rows.length + ' > ' + MAX_ROWS + ')');
      if (Date.now() - execStarted > MAX_EXECUTION_MS) throw new Error('execution timeout after ' + MAX_EXECUTION_MS + ' ms');
      const t = { id: step.id || step.type, type: step.type, status: 'success', message: res.message, startedAt, finishedAt: now(), rowCount: rows.length, warnings: res.warnings || [], completeness: res.completeness || null, engine: traceEngine(step) };
      trace.push(t);
    } catch (e) {
      const t = { id: step.id || step.type, type: step.type, status: 'failed', message: e.message, startedAt, finishedAt: now(), rowCount: rows.length, engine: traceEngine(step) };
      trace.push(t);
      // do not publish partial result
      return { ok: false, error: e.message, steps: trace, rows: null, columns: null, trace };
    }
  }
  return {
    ok: true, rows, columns, steps: trace, trace, rowCount: rows.length,
    elapsedMs: Date.now() - execStarted,
    limits: { steps: MAX_STEPS, rows: MAX_ROWS, executionMs: MAX_EXECUTION_MS },
  };
}

/** تنفيذ غير متزامن: نفس محرك الخطوات + عقدة Python المقيّدة (عملية فرعية بمهلة). */
async function executeWorkflowAsync(wf, data) {
  const validation = validateWorkflow(wf);
  if (!validation.ok) {
    return { ok: false, error: 'invalid workflow: ' + validation.errors.join('; '), steps: [], rows: null, columns: null, trace: [] };
  }
  let rows = null;
  let columns = null;
  if (data && Array.isArray(data.rows)) {
    rows = data.rows.map(r => Object.assign({}, r));
    columns = data.columns || (rows.length ? Object.keys(rows[0]) : []);
  } else if (data && data.sourceData && Array.isArray(data.sourceData)) {
    rows = data.sourceData.map(r => Object.assign({}, r));
    columns = data.sourceColumns || (rows.length ? Object.keys(rows[0]) : []);
  } else {
    return { ok: false, error: 'no source data provided', steps: [], rows: null, columns: null, trace: [] };
  }
  if (rows.length > MAX_ROWS) {
    return { ok: false, error: 'source rows exceed limit (' + rows.length + ' > ' + MAX_ROWS + ')', steps: [], rows: null, columns: null, trace: [] };
  }
  const execStarted = Date.now();
  const trace = [];
  for (const step of wf.steps) {
    if (Date.now() - execStarted > MAX_EXECUTION_MS) {
      const t = { id: null, type: 'guard', status: 'failed', message: 'execution timeout after ' + MAX_EXECUTION_MS + ' ms', startedAt: now(), rowCount: rows.length };
      trace.push(t);
      return { ok: false, error: t.message, steps: trace, rows: null, columns: null, trace };
    }
    const sv = validateStep(step, columns);
    if (!sv.ok) {
      const t = { id: step.id || step.type, type: step.type, status: 'failed', message: 'validation: ' + sv.errors.join('; '), startedAt: now(), rowCount: rows.length, engine: traceEngine(step) };
      trace.push(t);
      return { ok: false, error: t.message, steps: trace, rows: null, columns: null, trace };
    }
    const startedAt = now();
    try {
      let res;
      if (step.type === 'python') {
        const py = await PY.runPythonTransform(rows, columns, step, { timeoutMs: PY.DEFAULT_TIMEOUT_MS });
        if (!py.ok) throw new Error(py.error || 'فشل تحويل Python المقيّد.');
        res = {
          rows: py.rows,
          columns: py.columns,
          message: 'Python مقيّد: ' + (py.applied || 0) + ' عملية · ' + (py.durationMs || 0) + ' ms · Python ' + (py.pythonVersion || ''),
          python: { mode: py.mode, operations: py.applied || 0, durationMs: py.durationMs || 0, pythonVersion: py.pythonVersion || '', outputBytes: py.outputBytes || 0 },
          warnings: py.warnings || [],
        };
      } else {
        res = runStepSync(step, rows, columns);
      }
      rows = res.rows;
      columns = res.columns;
      if (rows.length > MAX_ROWS) throw new Error('result rows exceed limit (' + rows.length + ' > ' + MAX_ROWS + ')');
      if (Date.now() - execStarted > MAX_EXECUTION_MS) throw new Error('execution timeout after ' + MAX_EXECUTION_MS + ' ms');
      const t = { id: step.id || step.type, type: step.type, status: 'success', message: res.message, startedAt, finishedAt: now(), rowCount: rows.length, warnings: res.warnings || [], completeness: res.completeness || null, engine: traceEngine(step) };
      if (res.python) t.python = res.python;
      trace.push(t);
    } catch (e) {
      const t = { id: step.id || step.type, type: step.type, status: 'failed', message: e.message, startedAt, finishedAt: now(), rowCount: rows.length, engine: traceEngine(step) };
      trace.push(t);
      return { ok: false, error: e.message, steps: trace, rows: null, columns: null, trace };
    }
  }
  return {
    ok: true, rows, columns, steps: trace, trace, rowCount: rows.length,
    elapsedMs: Date.now() - execStarted,
    limits: { steps: MAX_STEPS, rows: MAX_ROWS, executionMs: MAX_EXECUTION_MS },
  };
}

function previewWorkflow(wf, data, limit) {
  const L = Math.max(1, Math.min(Number(limit) || 20, 1000));
  const res = executeWorkflow(wf, data);
  if (!res.ok) return res;
  const total = res.rows.length;
  return Object.assign({}, res, {
    rows: res.rows.slice(0, L),
    preview: true,
    totalRows: total,
    message: 'preview of ' + Math.min(L, total) + ' of ' + total + ' rows',
  });
}

async function previewWorkflowAsync(wf, data, limit) {
  const L = Math.max(1, Math.min(Number(limit) || 20, 1000));
  const res = await executeWorkflowAsync(wf, data);
  if (!res.ok) return res;
  const total = res.rows.length;
  return Object.assign({}, res, {
    rows: res.rows.slice(0, L),
    preview: true,
    totalRows: total,
    message: 'preview of ' + Math.min(L, total) + ' of ' + total + ' rows',
  });
}

/* ---------- synthetic fixture (DB-independent) ---------- */
function syntheticFixture() {
  const orders = [
    { id: 1, customerId: 1, qty: 10, price: 5, note: 'a' },
    { id: 2, customerId: 1, qty: 3, price: 5, note: null },
    { id: 3, customerId: 2, qty: 7, price: 2, note: 'b' },
    { id: 4, customerId: 3, qty: 0, price: 0, note: '' },
    { id: 5, customerId: 99, qty: 4, price: 1, note: 'orphan' },
  ];
  const customers = [
    { id: 1, name: 'Alice', region: 'North' },
    { id: 2, name: 'Bob', region: 'South' },
    { id: 3, name: 'Carol', region: 'North' },
  ];
  return {
    name: 'synthetic',
    source: { type: 'memory', name: 'orders' },
    sourceRows: orders,
    sourceColumns: ['id', 'customerId', 'qty', 'price', 'note'],
    rightRows: customers,
    rightColumns: ['id', 'name', 'region'],
  };
}

/* ---------- تحضير: حلّ مصادر الربط قبل التنفيذ ----------
 * الخطوة «join» قد تشير إلى مصدر مسجَّل في فهرس البيانات عبر rightSource.
 * هنا تُجلب صفوف ذلك المصدر عبر مُزوِّد (resolver) خارجي — فيبقى المحرك نقياً،
 * وتبقى الصلاحيات وحدود الصفوف في طبقة المزوِّد (src/datasets.js).
 * rightRows الحرفية تبقى مدعومة للتدفقات المحفوظة سابقاً.
 */
async function prepareWorkflow(wf, resolver) {
  const steps = (wf.steps || []).map(s => Object.assign({}, s));
  const notes = [];
  for (const s of steps) {
    if (!['join', 'union', 'compare', 'reconcile'].includes(s.type) || !s.rightSource || Array.isArray(s.rightRows)) continue;
    if (typeof resolver !== 'function') {
      notes.push('مصدر الطرف الثاني «' + s.rightSource + '» غير متاح في هذه البيئة (لا مزوِّد)');
      continue;
    }
    const res = await resolver(s.rightSource, s);
    if (!res || !res.ok) {
      notes.push('تعذّر جلب مصدر الطرف الثاني «' + s.rightSource + '»: ' + ((res && res.error) || 'غير معروف'));
      continue;
    }
    s.rightRows = res.rows;
    s.rightColumns = res.columns;
    s.rightSourceLabel = res.label || s.rightSource;
    s.rightGrain = res.grain || '';
    s.rightTruncated = !!res.truncated;
    s.rightLimit = res.limit || null;
    s.relation = s.relation || 'many-to-one';
    notes.push('الربط مع «' + (res.label || s.rightSource) + '» — ' + (res.rows.length) + ' صف'
      + (res.grain ? ' (مستوى: ' + res.grain + ')' : '')
      + (res.truncated ? ' — ⚠️ بلغ حد الصفوف (' + (res.limit || 0) + ') فحالة الاكتمال ستُحتسب' : ''));
  }
  return { workflow: Object.assign({}, wf, { steps }), notes };
}

/* ---------- بصمة التعريف وتتبّع النتيجة ----------
 * البصمة تُحسب من «التعريف المنفَّذ» (وليس من ملف قد يُعدَّل لاحقًا)،
 * ومن تمثيل JSON قانوني: ترتيب المفاتيح لا يغيّر البصمة، وتغيير أي إعداد/فلتر
 * أو ترتيب الخطوات يغيّرها. لا صفوف ولا أسرار داخل البصمة أو نسخة التعريف. */

/** تمثيل JSON قانوني: المفاتيح مرتّبة تصاعديًا (ترتيب المفاتيح وحده لا يغيّر البصمة) */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

/** بصمة sha256 للتعريف (ستّ عشرة خانة) */
function definitionHash(definition) {
  return crypto.createHash('sha256').update(canonicalJson(definition), 'utf8').digest('hex').slice(0, 16);
}

/** نسخة مستقلة من التعريف المنفَّذ: بلا صفوف بيانات وبلا صفوف الربط المحسومة */
function definitionSnapshot(workflow) {
  const wf = workflow && typeof workflow === 'object' ? workflow : {};
  const steps = (wf.steps || []).map(s => {
    const o = Object.assign({}, s);
    delete o.rightRows;          // بيانات لا تعريف
    delete o.rightColumns;
    return o;
  });
  const out = {
    name: wf.name || '',
    source: wf.source && typeof wf.source === 'object'
      ? { type: wf.source.type, name: wf.source.name, settings: wf.source.settings || {} }
      : (wf.source || null),
    steps,
  };
  if (wf.layout) out.layout = wf.layout;
  /* الرسم المرئي جزء من التعريف المنفَّذ — لكن بلا إحداثيات العرض
     (تحريك العقدة لا يغيّر بصمة التعريف ولا نتيجة التنفيذ). */
  if (wf.graph && typeof wf.graph === 'object') {
    out.graph = {
      schemaVersion: wf.graph.schemaVersion,
      nodes: (Array.isArray(wf.graph.nodes) ? wf.graph.nodes : []).map(n => ({
        id: n && n.id, type: n && n.type, config: n && n.config,
      })),
      edges: (Array.isArray(wf.graph.edges) ? wf.graph.edges : []).map(e => ({
        id: e && e.id, from: e && e.from, to: e && e.to,
      })),
    };
    out.graphSchemaVersion = wf.graphSchemaVersion || wf.graph.schemaVersion || null;
  }
  return out;
}

/* ---------- persistence (JSON files) ---------- */
function workflowsDir(baseDir) {
  const d = baseDir || path.join(process.cwd(), 'data', 'workflows');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function sanitizeId(id) { return String(id || '').replace(/[^A-Za-z0-9_\-]/g, ''); }
function saveWorkflow(wf, baseDir) {
  const d = workflowsDir(baseDir);
  const rawId = wf.id || ('wf_' + Date.now());
  const id = sanitizeId(rawId) || ('wf_' + Date.now());
  const obj = Object.assign({}, wf, { id, savedAt: now() });
  fs.writeFileSync(path.join(d, id + '.json'), JSON.stringify(obj, null, 2), 'utf8');
  return id;
}
function loadWorkflow(id, baseDir) {
  const d = workflowsDir(baseDir);
  const safe = sanitizeId(id);
  if (!safe) return null;
  const p = path.join(d, safe + '.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function listWorkflows(baseDir) {
  const d = workflowsDir(baseDir);
  return fs.readdirSync(d).filter(f => f.endsWith('.json')).map(f => {
    try { const o = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); return { id: o.id, name: o.name, savedAt: o.savedAt }; }
    catch (e) { return null; }
  }).filter(Boolean);
}
function saveOutput(runId, result, baseDir) {
  const d = workflowsDir(baseDir);
  const outDir = path.join(d, '_outputs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const safe = sanitizeId(runId) || ('run_' + Date.now());
  const obj = { runId: safe, savedAt: now(), ok: result.ok, rowCount: result.rowCount || (result.rows ? result.rows.length : 0), columns: result.columns, rows: result.rows };
  /* تحذيرات المسار (اكتمال الربط مثلًا) تُحفظ مع النتيجة ليظهرها التقرير */
  if (result.warnings && result.warnings.length) obj.warnings = result.warnings.slice(0, 50);
  /* تحذيرات المصدر (اقتطاع/فحص صلاحيات) تُحفظ مع النتيجة لتظهر في تتبّع التقرير */
  if (result.sourceNotes && result.sourceNotes.length) obj.sourceNotes = result.sourceNotes.slice(0, 50);
  if (result.joinCompleteness) obj.joinCompleteness = result.joinCompleteness;
  /* بيانات المصدر والتدفق تُحفظ مع النتيجة لتبقى Reports مرتبطة بمصدرها */
  if (result.source) obj.source = result.source;
  if (result.workflowName) obj.workflowName = result.workflowName;
  if (result.workflowId) obj.workflowId = result.workflowId;
  /* نسخة التعريف المنفَّذ + بصمته ⇒ تتبّع كامل وإعادة إنتاج (بلا صفوف ولا أسرار) */
  if (result.definition) {
    obj.definition = result.definition;
    obj.definitionHash = result.definitionHash || definitionHash(result.definition);
    obj.traced = true;
  }
  /* أعمدة المعادلات المحسوبة (formulaId → اسم العمود) لربط التقارير بالمعادلات */
  if (result.formulaColumns && typeof result.formulaColumns === 'object') obj.formulaColumns = result.formulaColumns;
  if (result.formulaVersions && typeof result.formulaVersions === 'object') obj.formulaVersions = result.formulaVersions;
  /* إصدار محرك المعادلات: لتعرف النتيجة أي محرّك أنتجها (وهل تغيّر منذ ذلك الحين) */
  if (result.engineVersion) obj.engineVersion = result.engineVersion;
  if (result.engineHash) obj.engineHash = result.engineHash;
  fs.writeFileSync(path.join(outDir, safe + '.json'), JSON.stringify(obj, null, 2), 'utf8');
  return path.join(outDir, safe + '.json');
}
function loadOutput(runId, baseDir) {
  const d = workflowsDir(baseDir);
  const safe = sanitizeId(runId);
  if (!safe) return null;
  const p = path.join(d, '_outputs', safe + '.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

module.exports = {
  STEP_TYPES, FILTER_OPS, AGG_FNS, JOIN_TYPES, UNION_MODES, DEDUPE_KEEP, NULL_ACTIONS, WINDOW_OPS,
  OUTLIER_METHODS, OUTLIER_ACTIONS, QUALITY_COLUMNS,
  PIVOT_DEFAULT_PREFIX, UNPIVOT_DEFAULT_KEY, UNPIVOT_DEFAULT_VALUE,
  MAX_STEPS, MAX_ROWS, MAX_EXECUTION_MS,
  inferType, colTypes, selectRenamePlan, pivotPlan, unpivotPlan, pivotConfig, unpivotConfig,
  keyList, joinKeys, compareConfig, variancePlan, outlierPlan, qualityPlan,
  canonicalJson, definitionHash, definitionSnapshot,
  validateStep, validateStepShape, validateWorkflow,
  runSelect, runFilter, runCompute, runGroupBy, runPivot, runUnpivot, runJoin, runUnion, runCompare, runReconcile,
  runVariance, runOutlier, runQuality, runDedupe, runNulls, runWindow, runSort,
  executeWorkflow, executeWorkflowAsync, previewWorkflow, previewWorkflowAsync, prepareWorkflow,
  saveWorkflow, loadWorkflow, listWorkflows, saveOutput, loadOutput,
  syntheticFixture,
};