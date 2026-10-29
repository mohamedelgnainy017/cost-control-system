'use strict';
/**
 * باني المعادلات البصري (Visual Formula Builder)
 * =========================================================================
 * يحوّل شكلًا هندسيًا (spec) إلى تعبير نصّي، أو العكس (تحليل التعبير إلى spec
 * مبسّط لعرضه). المحرّر البصري والنصّي ينتجان **نفس التعبير** ⇒ نفس النتيجة
 * ⇒ لا يوجد «حسابان» بل حساب واحد (محرك src/formulas.js).
 *
 * نموذج الشكل (spec):
 *   { kind:'field',  field:'qty' }
 *   { kind:'const',  value: 100 }
 *   { kind:'bin',    op:'*', left:spec, right:spec }
 *   { kind:'call',   fn:'ROUND', args:[spec, {kind:'const', value:2}] }
 *
 * الوحدة تُحمَّل في Node (مع محرّك المعادلات) وفي المتصفح (بلا محرّك):
 * في المتصفح تبقى دوال البناء/التحليل تعمل، أمّا التحقق من وجود الدالة
 * فيُؤجَّل إلى لحظة الاستدعاء برسالة عربية واضحة (لا استثناء عند التحميل).
 */
(function (root, factory) {
  const api = factory(typeof module !== 'undefined' && module.exports ? require('./formulas') : (root.Formulas || null));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FormulaBuilder = api;
})(typeof self !== 'undefined' ? self : this, function (formulas) {

const BINOPS = ['+', '-', '*', '/'];
const NUMERIC_FNS = ['ABS', 'ROUND', 'CEIL', 'FLOOR', 'MIN2', 'MAX2', 'NUMF', 'R2', 'CEIL1000', 'DIV'];
const UNARY_FNS = ['NUMF', 'R2', 'CEIL1000'];

/** هل الدالة معروفة؟ في المتصفح بلا محرّك: نكتفي بالقائمة البيضاء للقواعد. */
function hasFunction(fn) {
  const name = String(fn || '').toUpperCase();
  if (formulas && typeof formulas.getFunction === 'function') return !!formulas.getFunction(name);
  return NUMERIC_FNS.indexOf(name) >= 0;
}

function escField(name) {
  const s = String(name || '').trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : '"' + s.replace(/"/g, '') + '"';
}
function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return String(n);
}

/** يبني التعبير من الشكل — يرمي خطأ واضحًا عند بناء غير صالح */
function buildExpression(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('صيغة المعادلة غير مكتملة');
  const k = spec.kind;
  if (k === 'field') {
    const f = String(spec.field || '').trim();
    if (!f) throw new Error('اختر حقلًا');
    return escField(f);
  }
  if (k === 'const') {
    if (spec.value === '' || spec.value === null || spec.value === undefined) throw new Error('أدخل قيمة ثابتة');
    return num(spec.value);
  }
  if (k === 'bin') {
    const op = String(spec.op || '');
    if (BINOPS.indexOf(op) < 0) throw new Error('عملية غير مدعومة: ' + (op || '?'));
    const left = buildExpression(spec.left);
    const right = buildExpression(spec.right);
    /* كل عملية على مسار واحد ⇒ بلا أقواس زائدة */
    return left + ' ' + op + ' ' + right;
  }
  if (k === 'call') {
    const fn = String(spec.fn || '').toUpperCase();
    if (!hasFunction(fn)) throw new Error('دالة غير معروفة: ' + (fn || '?'));
    const args = (spec.args || []).map(buildExpression);
    return fn + '(' + args.join(', ') + ')';
  }
  throw new Error('نوع غير معروف في بنية المعادلة: ' + (k || '?'));
}

/** يبني شكلًا مبسّطًا: (lhs op rhs) مع دالة اختيارية حوله */
function buildSpec(opts) {
  const o = opts || {};
  const left = o.leftField ? { kind: 'field', field: o.leftField } : { kind: 'const', value: o.leftValue === undefined ? 0 : o.leftValue };
  const right = o.rightField ? { kind: 'field', field: o.rightField } : { kind: 'const', value: o.rightValue === undefined ? 0 : o.rightValue };
  let spec = { kind: 'bin', op: o.op || '*', left, right };
  const fn = String(o.fn || '').toUpperCase();
  if (fn) {
    if (!hasFunction(fn)) throw new Error('دالة غير معروفة: ' + fn);
    if (UNARY_FNS.indexOf(fn) >= 0) spec = { kind: 'call', fn, args: [spec] };
    else spec = { kind: 'call', fn, args: [spec, { kind: 'const', value: o.precision === undefined ? 2 : o.precision }] };
  }
  return spec;
}

/**
 * تحليل نصي مبسّط إلى شكل (للعرض فقط — best effort).
 * يعيد null إن لم يُفهم التعبير (ولا يمنع الحفظ).
 */
function parseExpression(expr) {
  const s = String(expr || '').trim();
  if (!s) return null;
  const call = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/.exec(s);
  if (call) {
    const fn = call[1].toUpperCase();
    if (!hasFunction(fn)) return null;
    const inner = call[2];
    /* مثال: ROUND(a * b, 2) */
    const m = /^(.+?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(inner);
    const argExpr = m ? m[1] : inner;
    const arg = parseExpression(argExpr);
    if (!arg) return null;
    const args = m ? [arg, { kind: 'const', value: Number(m[2]) }] : [arg];
    return { kind: 'call', fn, args };
  }
  const bin = /^(.+?)\s*([+\-*/])\s*(.+)$/.exec(s);
  if (bin) {
    const left = parseExpression(bin[1]);
    const right = parseExpression(bin[3]);
    if (!left || !right) return null;
    return { kind: 'bin', op: bin[2], left, right };
  }
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return { kind: 'const', value: Number(s) };
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return { kind: 'field', field: s };
  return null;
}

const api = { BINOPS, NUMERIC_FNS, UNARY_FNS, buildExpression, buildSpec, parseExpression, escField, hasFunction };
return api;
});
