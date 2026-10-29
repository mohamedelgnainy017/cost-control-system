'use strict';
/**
 * Formula Studio — مكتبة مركزية للوظائف (Phase Sprint-1)
 * ============================================================
 * - closed-whitelist: لا eval، لا تنفيذ حر. التقييم يتم عبر parser صغير (recursive descent).
 * - كل وظيفة تحمل metadata: id, name, description, params[{name,type}],
 *   returnType, nullBehavior, errors, examples.
 * - لا 의존ات خارجية. آمن للاختبار دون DB.
 */
const crypto = require('node:crypto');
const pure = require('./pure');

/* ---------- إصدار محرك تنفيذ المعادلات ----------
 * يُحفظ مع كل تشغيل ليبانَ ما إذا كانت النتيجة نُفِّذت بنفس المحرّك.
 * FORMULA_ENGINE_VERSION: إصدار بشري (يُرفع عند تغيّر سلوك الدوال).
 * formulaEngineHash: بصمة ثابتة لسلوك المحرّك فعليًا (تغيير أي دالة يغيّرها)
 *   ⇒ تكتشف تغيّر الدوال حتى لو نُسي رفع الإصدار. بلا أسرار ولا صفوف. */
const FORMULA_ENGINE_VERSION = '1.0.0';
function formulaEngineHash() {
  const parts = Object.keys(FUNCTIONS).sort().map(id => id + ':' + String(FUNCTIONS[id].impl));
  return crypto.createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex').slice(0, 16);
}

/* =====================================================================
 * 1) Registry of supported functions
 * ===================================================================== */
const FUNCTIONS = {};

function register(fn) {
  if (!fn || !fn.id || !fn.name) throw new Error('function must have id and name');
  if (FUNCTIONS[fn.id]) throw new Error('duplicate function id: ' + fn.id);
  FUNCTIONS[fn.id] = fn;
  return fn;
}

function getFunction(id) {
  if (!id) return null;
  const key = String(id);
  if (FUNCTIONS[key]) return FUNCTIONS[key];
  const lower = key.toLowerCase();
  if (FUNCTIONS[lower]) return FUNCTIONS[lower];
  // match by display name (case-insensitive)
  return Object.values(FUNCTIONS).find(f => String(f.name).toLowerCase() === lower) || null;
}
function listFunctions() { return Object.values(FUNCTIONS).map(f => ({
  id: f.id, name: f.name, description: f.description,
  params: f.params, returnType: f.returnType,
  nullBehavior: f.nullBehavior, errors: f.errors, examples: f.examples,
})); }

/* helper: coerce to number or null */
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : null;
}

function str(v) { return v === null || v === undefined ? null : String(v); }

/* =====================================================================
 * 2) Implementations (closed whitelist)
 * ===================================================================== */

// arithmetic / math
register({
  id: 'abs', name: 'ABS', description: 'القيمة المطلقة',
  params: [{ name: 'x', type: 'number' }], returnType: 'number',
  nullBehavior: 'propagate-null', errors: [], examples: ['ABS(-5) = 5', 'ABS(col)'],
  impl: (x) => { const n = toNum(x); return n === null ? null : Math.abs(n); },
});
register({
  id: 'round', name: 'ROUND', description: 'تقريب إلى N خانات (افتراضي 2)',
  params: [{ name: 'x', type: 'number' }, { name: 'decimals', type: 'number' }],
  returnType: 'number', nullBehavior: 'propagate-null', errors: [],
  examples: ['ROUND(3.14159, 2) = 3.14', 'ROUND(col)'],
  impl: (x, d) => {
    const n = toNum(x); if (n === null) return null;
    const dec = (d === null || d === undefined) ? 2 : Math.max(0, Math.min(10, Math.trunc(toNum(d) || 0)));
    return Math.round(n * 10 ** dec) / 10 ** dec;
  },
});
register({
  id: 'ceil', name: 'CEIL', description: 'السقف (أصغر عدد صحيح >= x)',
  params: [{ name: 'x', type: 'number' }], returnType: 'number',
  nullBehavior: 'propagate-null', errors: [], examples: ['CEIL(3.2) = 4'],
  impl: (x) => { const n = toNum(x); return n === null ? null : Math.ceil(n); },
});
register({
  id: 'floor', name: 'FLOOR', description: 'الأرضية (أكبر عدد صحيح <= x)',
  params: [{ name: 'x', type: 'number' }], returnType: 'number',
  nullBehavior: 'propagate-null', errors: [], examples: ['FLOOR(3.8) = 3'],
  impl: (x) => { const n = toNum(x); return n === null ? null : Math.floor(n); },
});
register({
  id: 'min2', name: 'MIN2', description: 'أصغر قيمتين',
  params: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }], returnType: 'number',
  nullBehavior: 'ignore-null (returns the other)', errors: [],
  examples: ['MIN2(3, 7) = 3'],
  impl: (a, b) => {
    const na = toNum(a), nb = toNum(b);
    if (na === null) return nb;
    if (nb === null) return na;
    return Math.min(na, nb);
  },
});
register({
  id: 'max2', name: 'MAX2', description: 'أكبر قيمتين',
  params: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }], returnType: 'number',
  nullBehavior: 'ignore-null (returns the other)', errors: [],
  examples: ['MAX2(3, 7) = 7'],
  impl: (a, b) => {
    const na = toNum(a), nb = toNum(b);
    if (na === null) return nb;
    if (nb === null) return na;
    return Math.max(na, nb);
  },
});

// null handling
register({
  id: 'coalesce', name: 'COALESCE', description: 'أول قيمة غير فارغة',
  params: [{ name: 'a', type: 'any' }, { name: 'b', type: 'any' }], returnType: 'any',
  nullBehavior: 'returns first non-null', errors: [], examples: ['COALESCE(col, 0)'],
  impl: (a, b) => (a === null || a === undefined ? b : a),
});
register({
  id: 'ifnull', name: 'IFNULL', description: 'بديل للقيمة الفارغة',
  params: [{ name: 'x', type: 'any' }, { name: 'fallback', type: 'any' }], returnType: 'any',
  nullBehavior: 'returns fallback when null', errors: [], examples: ['IFNULL(col, "N/A")'],
  impl: (x, fb) => (x === null || x === undefined ? fb : x),
});

// conditional
register({
  id: 'if', name: 'IF', description: 'شرط: IF(cond, then, else)',
  params: [{ name: 'cond', type: 'boolean' }, { name: 'thenVal', type: 'any' }, { name: 'elseVal', type: 'any' }],
  returnType: 'any', nullBehavior: 'cond null -> else branch', errors: [],
  examples: ['IF(qty > 0, qty, 0)'],
  impl: (c, t, e) => (c ? t : e),
});

// string
register({
  id: 'upper', name: 'UPPER', description: 'تحويل إلى أحرف كبيرة',
  params: [{ name: 's', type: 'string' }], returnType: 'string',
  nullBehavior: 'propagate-null', errors: [], examples: ['UPPER(name)'],
  impl: (s) => { const v = str(s); return v === null ? null : v.toUpperCase(); },
});
register({
  id: 'lower', name: 'LOWER', description: 'تحويل إلى أحرف صغيرة',
  params: [{ name: 's', type: 'string' }], returnType: 'string',
  nullBehavior: 'propagate-null', errors: [], examples: ['LOWER(name)'],
  impl: (s) => { const v = str(s); return v === null ? null : v.toLowerCase(); },
});
register({
  id: 'trim', name: 'TRIM', description: 'حذف الفراغات من الأطراف',
  params: [{ name: 's', type: 'string' }], returnType: 'string',
  nullBehavior: 'propagate-null', errors: [], examples: ['TRIM(name)'],
  impl: (s) => { const v = str(s); return v === null ? null : v.trim(); },
});
register({
  id: 'concat', name: 'CONCAT', description: 'ربط نصوص (تجاهل الفارغ)',
  params: [{ name: 'a', type: 'any' }, { name: 'b', type: 'any' }], returnType: 'string',
  nullBehavior: 'treats null as empty', errors: [], examples: ['CONCAT(first, " ", last)'],
  impl: (...args) => {
    // last arg may be context object
    const last = args[args.length - 1];
    const ctx = (last && typeof last === 'object' && Array.isArray(last.warnings)) ? args.pop() : null;
    return args.map(v => (v === null || v === undefined ? '' : String(v))).join('');
  },
});
register({
  id: 'len', name: 'LEN', description: 'طول النص',
  params: [{ name: 's', type: 'string' }], returnType: 'number',
  nullBehavior: 'null -> 0', errors: [], examples: ['LEN(name)'],
  impl: (s) => { const v = str(s); return v === null ? 0 : v.length; },
});

// math operators as functions (for safety)
register({
  id: 'add', name: 'ADD', description: 'جمع (null-safe)',
  params: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }], returnType: 'number',
  nullBehavior: 'treats null as 0', errors: [], examples: ['ADD(a, b)'],
  impl: (a, b) => (toNum(a) || 0) + (toNum(b) || 0),
});
register({
  id: 'sub', name: 'SUB', description: 'طرح (null-safe)',
  params: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }], returnType: 'number',
  nullBehavior: 'treats null as 0', errors: [], examples: ['SUB(a, b)'],
  impl: (a, b) => (toNum(a) || 0) - (toNum(b) || 0),
});
register({
  id: 'mul', name: 'MUL', description: 'ضرب (null-safe)',
  params: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }], returnType: 'number',
  nullBehavior: 'treats null as 0', errors: [], examples: ['MUL(a, b)'],
  impl: (a, b) => (toNum(a) || 0) * (toNum(b) || 0),
});
register({
  id: 'div', name: 'DIV', description: 'قسمة (null/zero -> null + warning)',
  params: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }], returnType: 'number',
  nullBehavior: 'null -> null', errors: ['division by zero -> null'],
  examples: ['DIV(a, b)'],
  impl: (a, b, ctx) => {
    const na = toNum(a), nb = toNum(b);
    if (na === null || nb === null) return null;
    if (nb === 0) { if (ctx) ctx.warnings.push('division by zero'); return null; }
    return na / nb;
  },
});

// pure helpers from pure.js exposed as functions
register({
  id: 'ceil1000', name: 'CEIL1000', description: 'تقريب إلى أقرب 1000 (سقف)',
  params: [{ name: 'x', type: 'number' }], returnType: 'number',
  nullBehavior: 'null -> 0', errors: [], examples: ['CEIL1000(1234) = 2000'],
  impl: (x) => pure.ceil1000(toNum(x) || 0),
});
register({
  id: 'numf', name: 'NUMF', description: 'تحويل إلى رقم (null/empty -> 0)',
  params: [{ name: 'x', type: 'any' }], returnType: 'number',
  nullBehavior: 'null/"" -> 0', errors: [], examples: ['NUMF(col)'],
  impl: (x) => pure.numf(x),
});
register({
  id: 'r2f', name: 'R2', description: 'تقريب إلى خانتين',
  params: [{ name: 'x', type: 'any' }], returnType: 'number',
  nullBehavior: 'null -> 0', errors: [], examples: ['R2(col)'],
  impl: (x) => pure.r2(x),
});

/* ---------- دوال التاريخ (لتحليلات الفترات) ---------- */
/** تحويل قيمة تاريخ (نص ISO أو كائن Date) إلى أجزاء — بلا اعتماد على التوقيت المحلي */
function dateParts(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate() };
  }
  const str = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(str);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(str);
  if (m) return { y: +m[3], m: +m[2], d: +m[1] };
  const dt = new Date(str);
  if (isNaN(dt.getTime())) return null;
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** فرق الأيام بين تاريخين (a - b) */
function daysBetween(a, b) {
  const pa = dateParts(a), pb = dateParts(b);
  if (!pa || !pb) return null;
  const da = Date.UTC(pa.y, pa.m - 1, pa.d);
  const db = Date.UTC(pb.y, pb.m - 1, pb.d);
  return Math.round((da - db) / 86400000);
}

const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

register({
  id: 'year', name: 'YEAR', description: 'سنة التاريخ',
  params: [{ name: 'date', type: 'date' }], returnType: 'number',
  nullBehavior: 'تاريخ غير صالح/فارغ -> null', errors: [],
  examples: ['YEAR("2026-07-15") = 2026'],
  impl: (v) => { const p = dateParts(v); return p ? p.y : null; },
});
register({
  id: 'month', name: 'MONTH', description: 'رقم الشهر (1-12)',
  params: [{ name: 'date', type: 'date' }], returnType: 'number',
  nullBehavior: 'تاريخ غير صالح/فارغ -> null', errors: [],
  examples: ['MONTH("2026-07-15") = 7'],
  impl: (v) => { const p = dateParts(v); return p ? p.m : null; },
});
register({
  id: 'day', name: 'DAY', description: 'رقم اليوم في الشهر',
  params: [{ name: 'date', type: 'date' }], returnType: 'number',
  nullBehavior: 'تاريخ غير صالح/فارغ -> null', errors: [],
  examples: ['DAY("2026-07-15") = 15'],
  impl: (v) => { const p = dateParts(v); return p ? p.d : null; },
});
register({
  id: 'month_name', name: 'MONTH_NAME', description: 'اسم الشهر بالعربية',
  params: [{ name: 'date', type: 'date' }], returnType: 'string',
  nullBehavior: 'تاريخ غير صالح/فارغ -> null', errors: [],
  examples: ['MONTH_NAME("2026-07-15") = "يوليو"'],
  impl: (v) => { const p = dateParts(v); return p ? AR_MONTHS[p.m - 1] : null; },
});
register({
  id: 'today', name: 'TODAY', description: 'تاريخ اليوم بصيغة YYYY-MM-DD (UTC)',
  params: [], returnType: 'string',
  nullBehavior: 'لا يقبل وسائط', errors: [],
  examples: ['TODAY() = "2026-07-15"'],
  impl: () => new Date().toISOString().slice(0, 10),
});
register({
  id: 'datediff', name: 'DATEDIFF', description: 'الفرق بين تاريخين (أيام/شهور/سنوات)',
  params: [{ name: 'unit', type: 'string' }, { name: 'a', type: 'date' }, { name: 'b', type: 'date' }],
  returnType: 'number',
  nullBehavior: 'تاريخ غير صالح -> null', errors: ['وحدة غير مدعومة -> null'],
  examples: ['DATEDIFF("day", "2026-07-15", "2026-07-01") = 14'],
  impl: (unit, a, b) => {
    const pa = dateParts(a), pb = dateParts(b);
    if (!pa || !pb) return null;
    const u = String(unit || '').trim().toLowerCase();
    if (u === 'day' || u === 'days') return daysBetween(a, b);
    if (u === 'month' || u === 'months') return (pa.y - pb.y) * 12 + (pa.m - pb.m);
    if (u === 'year' || u === 'years') return pa.y - pb.y;
    return null;
  },
});

/* =====================================================================
 * 3) Safe parser + evaluator (no eval)
 * ===================================================================== */
const TOKEN_RE = /\s*(=>|<=|>=|==|!=|&&|\|\||[+\-*/(),<>]|[0-9]+(?:\.[0-9]+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][A-Za-z0-9_]*)/g;

function tokenize(s) {
  const tokens = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  let pos = 0;
  while ((m = TOKEN_RE.exec(s)) !== null) {
    if (m.index !== pos) throw new Error('unexpected character at ' + pos + ': ' + s.slice(pos, pos + 5));
    pos = TOKEN_RE.lastIndex;
    const t = m[1];
    if (/^\s*$/.test(t)) continue;
    tokens.push(t);
  }
  if (pos !== s.length) throw new Error('unexpected trailing input at ' + pos);
  return tokens;
}

class Parser {
  constructor(tokens) { this.t = tokens; this.i = 0; }
  peek() { return this.t[this.i]; }
  next() { return this.t[this.i++]; }
  expect(v) { const x = this.next(); if (x !== v) throw new Error('expected ' + v + ' got ' + x); }
  parse() { const e = this.expr(); if (this.i !== this.t.length) throw new Error('unexpected token ' + this.peek()); return e; }
  expr() { return this.or(); }
  or() {
    let l = this.and();
    while (this.peek() === '||') { this.next(); const r = this.and(); l = { type: 'or', left: l, right: r }; }
    return l;
  }
  and() {
    let l = this.cmp();
    while (this.peek() === '&&') { this.next(); const r = this.cmp(); l = { type: 'and', left: l, right: r }; }
    return l;
  }
  cmp() {
    let l = this.add();
    const ops = ['==', '!=', '<', '>', '<=', '>='];
    while (ops.includes(this.peek())) {
      const op = this.next(); const r = this.add();
      l = { type: 'cmp', op, left: l, right: r };
    }
    return l;
  }
  add() {
    let l = this.mul();
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.next(); const r = this.mul();
      l = { type: 'bin', op, left: l, right: r };
    }
    return l;
  }
  mul() {
    let l = this.unary();
    while (this.peek() === '*' || this.peek() === '/') {
      const op = this.next(); const r = this.unary();
      l = { type: 'bin', op, left: l, right: r };
    }
    return l;
  }
  unary() {
    if (this.peek() === '-') { this.next(); return { type: 'neg', expr: this.unary() }; }
    if (this.peek() === '!') { this.next(); return { type: 'not', expr: this.unary() }; }
    return this.primary();
  }
  primary() {
    const t = this.peek();
    if (t === '(') { this.next(); const e = this.expr(); this.expect(')'); return e; }
    if (t === undefined) throw new Error('unexpected end of expression');
    if (/^[0-9]/.test(t)) { this.next(); return { type: 'num', value: Number(t) }; }
    if (/^["']/.test(t)) { this.next(); return { type: 'str', value: t.slice(1, -1) }; }
    if (/^[A-Za-z_]/.test(t)) {
      this.next();
      if (this.peek() === '(') {
        this.next();
        const args = [];
        if (this.peek() !== ')') {
          args.push(this.expr());
          while (this.peek() === ',') { this.next(); args.push(this.expr()); }
        }
        this.expect(')');
        return { type: 'call', name: t.toUpperCase(), args };
      }
      return { type: 'col', name: t };
    }
    throw new Error('unexpected token: ' + t);
  }
}

function parseFormula(s) {
  if (typeof s !== 'string' || s.trim() === '') throw new Error('formula must be a non-empty string');
  const tokens = tokenize(s);
  const p = new Parser(tokens);
  return p.parse();
}

function evalNode(node, row, ctx) {
  const warnings = ctx.warnings;
  switch (node.type) {
    case 'num': return node.value;
    case 'str': return node.value;
    case 'col': {
      if (row && Object.prototype.hasOwnProperty.call(row, node.name)) return row[node.name];
      // case-insensitive column lookup
      if (row) {
        const key = Object.keys(row).find(k => k.toLowerCase() === node.name.toLowerCase());
        if (key) return row[key];
      }
      throw new Error('unknown column: ' + node.name);
    }
    case 'neg': { const v = evalNode(node.expr, row, ctx); if (v === null || v === undefined) return null; const n = toNum(v); if (n === null) throw new Error('neg requires number'); return -n; }
    case 'not': { const v = evalNode(node.expr, row, ctx); return !v; }
    case 'bin': {
      const l = evalNode(node.left, row, ctx);
      const r = evalNode(node.right, row, ctx);
      if (node.op === '+') {
        // string concat if either is string
        if (typeof l === 'string' || typeof r === 'string') return String(l === null ? '' : l) + String(r === null ? '' : r);
        const ln = toNum(l), rn = toNum(r);
        if (ln === null || rn === null) return null;
        return ln + rn;
      }
      if (node.op === '-') { const ln = toNum(l), rn = toNum(r); if (ln === null || rn === null) return null; return ln - rn; }
      if (node.op === '*') { const ln = toNum(l), rn = toNum(r); if (ln === null || rn === null) return null; return ln * rn; }
      if (node.op === '/') {
        const ln = toNum(l), rn = toNum(r);
        if (ln === null || rn === null) return null;
        if (rn === 0) { warnings.push('division by zero'); return null; }
        return ln / rn;
      }
      throw new Error('unknown operator ' + node.op);
    }
    case 'cmp': {
      const l = evalNode(node.left, row, ctx);
      const r = evalNode(node.right, row, ctx);
      switch (node.op) {
        case '==': return l === r;
        case '!=': return l !== r;
        case '<':  return (toNum(l) !== null && toNum(r) !== null) ? toNum(l) < toNum(r) : (String(l) < String(r));
        case '>':  return (toNum(l) !== null && toNum(r) !== null) ? toNum(l) > toNum(r) : (String(l) > String(r));
        case '<=': return (toNum(l) !== null && toNum(r) !== null) ? toNum(l) <= toNum(r) : (String(l) <= String(r));
        case '>=': return (toNum(l) !== null && toNum(r) !== null) ? toNum(l) >= toNum(r) : (String(l) >= String(r));
      }
      throw new Error('unknown cmp ' + node.op);
    }
    case 'and': {
      const l = evalNode(node.left, row, ctx);
      if (!l) return false;
      return !!evalNode(node.right, row, ctx);
    }
    case 'or': {
      const l = evalNode(node.left, row, ctx);
      if (l) return true;
      return !!evalNode(node.right, row, ctx);
    }
    case 'call': {
      const f = getFunction(node.name);
      if (!f) throw new Error('unknown function: ' + node.name);
      const args = node.args.map(a => evalNode(a, row, ctx));
      const localCtx = { warnings };
      try {
        return f.impl.apply(null, args.concat([localCtx]));
      } catch (e) {
        throw new Error('function ' + node.name + ' failed: ' + e.message);
      }
    }
    default: throw new Error('unknown node type ' + node.type);
  }
}

function evaluateFormula(formulaStr, row) {
  const ctx = { warnings: [] };
  const ast = parseFormula(formulaStr);
  const value = evalNode(ast, row || {}, ctx);
  return { ok: true, value, warnings: ctx.warnings };
}

function validateNode(node) {
  const errs = [];
  if (!node) return errs;
  if (node.type === 'call') {
    if (!getFunction(node.name)) errs.push('unknown function: ' + node.name);
    for (const a of node.args) errs.push(...validateNode(a));
  }
  if (node.left) errs.push(...validateNode(node.left));
  if (node.right) errs.push(...validateNode(node.right));
  if (node.expr) errs.push(...validateNode(node.expr));
  if (node.args) for (const a of node.args) errs.push(...validateNode(a));
  return errs;
}
function validateFormula(formulaStr) {
  try {
    const ast = parseFormula(formulaStr);
    const errs = validateNode(ast);
    if (errs.length) return { ok: false, errors: errs };
    return { ok: true, errors: [] };
  } catch (e) {
    return { ok: false, errors: [e.message] };
  }
}

/* =====================================================================
 * 4) Exports
 * ===================================================================== */
function referencedColumns(exprOrAst) {
  try {
    const ast = typeof exprOrAst === 'string' ? parseFormula(exprOrAst) : exprOrAst;
    const cols = new Set();
    function walk(n) {
      if (!n) return;
      if (n.type === 'col') cols.add(n.name);
      if (n.left) walk(n.left);
      if (n.right) walk(n.right);
      if (n.expr) walk(n.expr);
      if (Array.isArray(n.args)) {
        for (const a of n.args) walk(a);
      }
    }
    walk(ast);
    return Array.from(cols);
  } catch (_) {
    return [];
  }
}

module.exports = {
  register, getFunction, listFunctions,
  FORMULA_ENGINE_VERSION, formulaEngineHash,
  parseFormula, validateFormula, evaluateFormula,
  toNum, str,
  referencedColumns,
  FUNCTIONS,
};