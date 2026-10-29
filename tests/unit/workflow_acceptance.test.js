'use strict';
/**
 * اختبارات قبول Workflow Studio — الدفعة الثالثة (بيانات اصطناعية، معزولة).
 * - دورة كاملة: build → validate → preview → run → save → load → edit → save → save-as → id مختلف.
 * - انتشار الأعمدة، الأخطاء، التوافق مع المحرك.
 * - لا أي اتصال (guard).
 */
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const W = require('../../src/workflow');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);
const eq = (a, b, m) => chk(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const rows = [
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

console.log('== workflow acceptance (full cycle, synthetic) ==');

/* ---------- 1) تعريف workflow يضم الخطوات الخمس ---------- */
const wf = {
  name: 'acceptance-wf',
  source: { type: 'memory', name: 'orders' },
  steps: [
    { id: 'j1', type: 'join', leftKey: 'customerId', rightKey: 'id', rightRows: customers, joinType: 'left' },
    { id: 's1', type: 'select', columns: ['id', 'name', 'region', 'qty', 'price', 'note'] },
    { id: 'f1', type: 'filter', column: 'qty', op: 'gt', value: 0 },
    { id: 'c1', type: 'compute', newColumn: 'total', formula: 'qty * price' },
    { id: 'g1', type: 'groupBy', keys: ['name', 'region'], aggs: [
        { fn: 'SUM', column: 'total', out: 'sum_total' },
        { fn: 'COUNT', column: 'id', out: 'n' },
        { fn: 'COUNT_DISTINCT', column: 'region', out: 'regions' },
        { fn: 'AVG', column: 'total', out: 'avg_total' },
        { fn: 'MIN', column: 'total', out: 'min_total' },
        { fn: 'MAX', column: 'total', out: 'max_total' },
    ] },
  ],
};

/* ---------- 2) validate ---------- */
const v = W.validateWorkflow(wf);
chk(v.ok, 'validateWorkflow ok for 5-step workflow');
const vStep = W.validateStep(wf.steps[0], ['id', 'customerId', 'qty', 'price', 'note']);
chk(vStep.ok, 'join step validates with columns');

/* ---------- 3) preview (حد 2) ---------- */
const data = { rows: rows.map(r => ({ ...r })), columns: ['id', 'customerId', 'qty', 'price', 'note'] };
const pv = W.previewWorkflow(wf, data, 2);
chk(pv.ok && pv.preview === true, 'preview ok');
chk(pv.rows.length === 2, 'preview limited to 2');
chk(pv.totalRows > 0, 'preview totalRows > 0');

/* ---------- 4) run كامل ---------- */
const res = W.executeWorkflow(wf, data);
chk(res.ok, 'executeWorkflow ok (5 steps)');
chk(res.rows !== null, 'result published (not null)');
chk(Array.isArray(res.trace) && res.trace.length === 5, 'trace has 5 steps');
chk(res.trace.every(s => s.status === 'success'), 'all 5 steps success');
chk(res.trace.every(s => typeof s.rowCount === 'number'), 'every trace entry has rowCount');
/* انتشار الأعمدة */
eq(res.columns, ['name', 'region', 'sum_total', 'n', 'regions', 'avg_total', 'min_total', 'max_total'],
  'columns propagated correctly after groupBy');
/* نتائج */
const alice = res.rows.find(r => r.name === 'Alice');
chk(alice && alice.sum_total === (10 * 5 + 3 * 5), 'Alice sum_total = 10*5 + 3*5 = 65');
chk(alice && alice.n === 2, 'Alice n = 2');
chk(alice && alice.regions === 1, 'Alice COUNT_DISTINCT region = 1');
chk(alice && alice.avg_total === 32.5, 'Alice avg_total = 32.5');
chk(alice && alice.min_total === 15, 'Alice min_total = 15');
chk(alice && alice.max_total === 50, 'Alice max_total = 50');

/* ---------- 5) فشل التحقق لا ينشر نتيجة جزئية ---------- */
const badWf = { name: 'bad', source: { type: 'memory' }, steps: [
  { id: 's1', type: 'select', columns: ['qty', 'price'] },
  { id: 'bad', type: 'compute', newColumn: 'x', formula: 'qty *' },
] };
const badRes = W.executeWorkflow(badWf, { rows: rows.map(r => ({ ...r })), columns: ['id', 'customerId', 'qty', 'price', 'note'] });
chk(!badRes.ok, 'invalid formula step fails workflow');
chk(badRes.rows === null, 'no partial result published on failure');
chk(badRes.trace.length === 2 && badRes.trace[1].status === 'failed', 'trace records failure');

/* ---------- 6) unknown column validation ---------- */
const ucWf = { name: 'uc', source: { type: 'memory' }, steps: [{ id: 's1', type: 'select', columns: ['nope'] }] };
const ucRes = W.executeWorkflow(ucWf, { rows: rows.map(r => ({ ...r })), columns: ['id', 'customerId', 'qty', 'price', 'note'] });
chk(!ucRes.ok, 'unknown column fails validation');

/* ---------- 7) filter ops ---------- */
for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'in']) {
  const fw = { name: 'f', source: { type: 'memory' }, steps: [{ id: 'f1', type: 'filter', column: 'qty', op, value: op === 'in' ? [10, 7] : (op === 'contains' || op === 'startsWith' ? 'a' : 5) }] };
  // use a column that exists
  const fw2 = { name: 'f', source: { type: 'memory' }, steps: [{ id: 'f1', type: 'filter', column: 'note', op, value: op === 'in' ? ['a', 'b'] : 'a' }] };
  const fr = W.executeWorkflow(fw2, { rows: rows.map(r => ({ ...r })), columns: ['id', 'customerId', 'qty', 'price', 'note'] });
  chk(fr.ok, 'filter op ' + op + ' executes without error');
}

/* ---------- 8) حفظ/تحميل/تحديث/حفظ باسم ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-acc-'));
const id1 = W.saveWorkflow({ name: 'v1', source: { type: 'memory' }, steps: wf.steps.slice(0, 1) }, tmp);
chk(typeof id1 === 'string' && id1.length > 0, 'saveWorkflow returns id');
const loaded1 = W.loadWorkflow(id1, tmp);
chk(loaded1 && loaded1.name === 'v1', 'loadWorkflow round-trips name');
chk(Array.isArray(loaded1.steps) && loaded1.steps.length === 1, 'loadWorkflow round-trips steps');
/* تحديث: حفظ بنفس id */
const id2 = W.saveWorkflow({ id: id1, name: 'v2', source: { type: 'memory' }, steps: wf.steps.slice(0, 2) }, tmp);
chk(id2 === id1, 'save with existing id updates (no duplicate)');
const loaded2 = W.loadWorkflow(id1, tmp);
chk(loaded2 && loaded2.name === 'v2' && loaded2.steps.length === 2, 'updated workflow reflects new name/steps');
/* حفظ باسم: بدون id → id جديد */
const id3 = W.saveWorkflow({ name: 'v3-copy', source: { type: 'memory' }, steps: wf.steps.slice(0, 1) }, tmp);
chk(id3 !== id1, 'save without id creates a new id (save-as)');
const listed = W.listWorkflows(tmp);
chk(listed.length === 2, 'listWorkflows shows 2 (original + copy)');
chk(listed.some(x => x.id === id1) && listed.some(x => x.id === id3), 'both ids listed');

/* ---------- 9) مخرجات التشغيل (saveOutput/loadOutput) ---------- */
const outPath = W.saveOutput('acc-run-1', res, tmp);
chk(fs.existsSync(outPath), 'saveOutput writes file');
const outLoaded = W.loadOutput('acc-run-1', tmp);
chk(outLoaded && outLoaded.rowCount === res.rows.length, 'loadOutput round-trips rowCount');
chk(Array.isArray(outLoaded.columns) && outLoaded.columns.length === res.columns.length, 'loadOutput round-trips columns');
/* مخرجات غير موجودة */
chk(W.loadOutput('no-such-run', tmp) === null, 'loadOutput missing → null');
/* workflow غير موجود */
chk(W.loadWorkflow('no-such-wf', tmp) === null, 'loadWorkflow missing → null');

/* ---------- 10) صيغة JSON preserved (توافق) ---------- */
const raw = fs.readFileSync(path.join(tmp, id1 + '.json'), 'utf8');
const parsed = JSON.parse(raw);
chk(parsed.source.type === 'memory' && Array.isArray(parsed.steps), 'saved JSON has source + steps');
chk(parsed.savedAt, 'savedAt stamped');

/* ---------- 11) لا تسرب بين الاختبارات (temp dir isolated) ---------- */
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-acc2-'));
chk(W.listWorkflows(tmp2).length === 0, 'fresh temp dir has no workflows (no leakage)');
fs.rmSync(tmp2, { recursive: true, force: true });

/* cleanup */
fs.rmSync(tmp, { recursive: true, force: true });

/* ---------- 12) guard ---------- */
chk(guard.count() === 0, 'صفر اتصال شبكة');
console.log(`\nworkflow_acceptance.test.js — pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
