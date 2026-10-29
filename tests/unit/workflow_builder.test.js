'use strict';
/**
 * اختبارات Workflow Studio — الدفعة 2 (مُنشئ مرئي)
 * - فحص ساكن للواجهة (app.js / index.html) — بلا متصفح.
 * - اختبار انتشار الأعمدة (mirror) مقابل المحرك على بيانات اصطناعية.
 * - لا أي اتصال شبكية (guard).
 */
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const path = require('node:path');

const W = require('../../src/workflow');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);
const eq = (a, b, m) => chk(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const appjs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
const idx = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

console.log('== workflow builder (static + column propagation) ==');

/* ---------- 1) فحص ساكن: المُنشئ والهيكل ---------- */
chk(/function wfColumns\(/.test(appjs), 'app.js يحوي wfColumns (انتشار الأعمدة)');
chk(/function renderSteps\(/.test(appjs), 'app.js يحوي renderSteps');
chk(/function openEditor\(/.test(appjs), 'app.js يحوي openEditor');
chk(/function applyEditor\(/.test(appjs), 'app.js يحوي applyEditor');
chk(/function collectStep\(/.test(appjs), 'app.js يحوي collectStep');
chk(/function syncJson\(/.test(appjs), 'app.js يحوي syncJson');
chk(/function applyJson\(/.test(appjs), 'app.js يحوي applyJson (تطبيق JSON)');
chk(/function wfSave\(asNew\)/.test(appjs), 'app.js يحوي wfSave(asNew) (حفظ/حفظ باسم)');
chk(/id="wf-steps-list"/.test(idx), 'index.html يحوي #wf-steps-list');
chk(/id="wf-add-step"/.test(idx), 'index.html يحوي زر إضافة خطوة');
chk(/id="wf-id"/.test(idx), 'index.html يحوي حقل id خفي (تحديث بدل تكرار)');
chk(/id="wf-save-as"/.test(idx), 'index.html يحوي زر حفظ باسم');
chk(/id="wf-editor"/.test(idx), 'index.html يحوي لوحة المحرر');
chk(/id="wf-editor-err"/.test(idx), 'index.html يحوي منطقة خطأ المحرر');
chk(/id="wf-source-fields"/.test(idx), 'index.html يحوي region حقول المصدر');
chk(/id="wf-apply-json"/.test(idx), 'index.html يحوي زر تطبيق JSON');
chk(/wf-details/.test(idx) && /wf-steps/.test(idx), 'محرر JSON المتقدم ما يزال موجودًا (توافق)');
chk(/loadSourceFields/.test(appjs), 'app.js يجلب حقول المصدر');
chk(/api\/datasets\/fields/.test(appjs), 'app.js يستدعي /api/datasets/fields');

/* ---------- 2) انتشار الأعمدة: mirror مقابل المحرك (بيانات اصطناعية) ---------- */
/* mirror (نفس منطق app.js) */
function wfColumns(list, src) {
  let cols = (src || []).slice();
  for (const s of (list || [])) {
    switch (s.type) {
      case 'select': if (Array.isArray(s.columns) && s.columns.length) cols = s.columns.slice(); break;
      case 'filter': break;
      case 'compute': if (s.newColumn) cols = cols.concat([s.newColumn]); break;
      case 'groupBy': cols = (s.keys || []).slice().concat((s.aggs || []).map(a => a.out)); break;
      case 'join': {
        const rr = Array.isArray(s.rightRows) ? s.rightRows : [];
        const rc = rr.length ? Object.keys(rr[0]) : [];
        const prefix = s.rightPrefix || '';
        const out = cols.slice();
        for (const c of rc) { const n = prefix ? prefix + c : c; if (!out.includes(n)) out.push(n); }
        cols = out; break;
      }
    }
  }
  return cols;
}

const rows = [
  { item: 'A', qty: 10, price: 5, note: 'x' },
  { item: 'A', qty: 3, price: 5, note: null },
  { item: 'B', qty: 7, price: 2, note: 'y' },
];
const srcCols = ['item', 'qty', 'price', 'note'];

const cases = [
  { name: 'select', steps: [{ id: 's1', type: 'select', columns: ['item', 'qty'] }] },
  { name: 'filter', steps: [{ id: 'f1', type: 'filter', column: 'item', op: 'eq', value: 'A' }] },
  { name: 'compute', steps: [{ id: 'c1', type: 'compute', newColumn: 'total', formula: 'qty * price' }] },
  { name: 'groupBy', steps: [{ id: 'g1', type: 'groupBy', keys: ['item'], aggs: [{ fn: 'SUM', column: 'qty', out: 'sum_qty' }] }] },
  { name: 'chained', steps: [
      { id: 'f1', type: 'filter', column: 'item', op: 'eq', value: 'A' },
      { id: 'c1', type: 'compute', newColumn: 'total', formula: 'qty * price' },
      { id: 'g1', type: 'groupBy', keys: ['item'], aggs: [{ fn: 'SUM', column: 'total', out: 'sum_total' }] },
  ] },
  { name: 'join', steps: [{ id: 'j1', type: 'join', leftKey: 'item', rightKey: 'k', rightRows: [{ k: 'A', extra: 1 }], joinType: 'left' }] },
];
for (const c of cases) {
  const wf = { name: c.name, source: { type: 'memory' }, steps: c.steps };
  const r = W.executeWorkflow(wf, { rows: rows.map(x => ({ ...x })), columns: srcCols.slice() });
  chk(r.ok, 'mirror case ' + c.name + ' → executeWorkflow ok');
  const mirror = wfColumns(c.steps, srcCols);
  eq(r.columns, mirror, 'mirror case ' + c.name + ' → columns match engine');
}

/* ---------- 3) guard: صفر اتصال ---------- */
chk(guard.count() === 0, 'صفر اتصال شبكة');
console.log(`\nworkflow_builder.test.js — pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
