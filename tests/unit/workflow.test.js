'use strict';
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

console.log('== workflow.js ==');

// synthetic data
const rows = [
  { item: 'A', qty: 10, price: 5, note: 'x' },
  { item: 'A', qty: 3, price: 5, note: null },
  { item: 'B', qty: 7, price: 2, note: 'y' },
  { item: 'C', qty: 0, price: 0, note: '' },
];

// --- select ---
const wf1 = { name: 'w1', source: { type: 'memory' }, steps: [
  { id: 's1', type: 'select', columns: ['item', 'qty'] },
] };
const r1 = W.executeWorkflow(wf1, { rows, columns: ['item','qty','price','note'] });
chk(r1.ok, 'select workflow ok');
eq(r1.rows.length, 4, 'select keeps row count');
eq(Object.keys(r1.rows[0]), ['item','qty'], 'select keeps only chosen columns');
eq(r1.steps[0].status, 'success', 'select step success');

// --- filter ---
const wf2 = { name: 'w2', source: { type: 'memory' }, steps: [
  { id: 'f1', type: 'filter', column: 'item', op: 'eq', value: 'A' },
] };
const r2 = W.executeWorkflow(wf2, { rows, columns: ['item','qty','price','note'] });
chk(r2.ok, 'filter workflow ok');
eq(r2.rows.length, 2, 'filter A -> 2 rows');

// --- compute ---
const wf3 = { name: 'w3', source: { type: 'memory' }, steps: [
  { id: 'c1', type: 'compute', newColumn: 'total', formula: 'qty * price' },
] };
const r3 = W.executeWorkflow(wf3, { rows, columns: ['item','qty','price','note'] });
chk(r3.ok, 'compute workflow ok');
eq(r3.rows[0].total, 50, 'compute total = qty*price');
eq(r3.columns, ['item','qty','price','note','total'], 'compute adds column');

// compute with null -> null
const wf3b = { name: 'w3b', source: { type: 'memory' }, steps: [
  { id: 'c1', type: 'compute', newColumn: 'total', formula: 'qty * price' },
] };
const r3b = W.executeWorkflow(wf3b, { rows: [{ item: 'X', qty: null, price: 5 }], columns: ['item','qty','price'] });
chk(r3b.ok, 'compute with null ok');
eq(r3b.rows[0].total, null, 'compute null propagation');

// divide by zero -> null + warning, step still succeeds (non-fatal)
const wf3c = { name: 'w3c', source: { type: 'memory' }, steps: [
  { id: 'c1', type: 'compute', newColumn: 'ratio', formula: 'DIV(qty, price)' },
] };
const r3c = W.executeWorkflow(wf3c, { rows: [{ item: 'Z', qty: 10, price: 0 }], columns: ['item','qty','price'] });
chk(r3c.ok, 'compute div-by-zero step succeeds (null result)');
eq(r3c.rows[0].ratio, null, 'div by zero -> null');
chk(r3c.steps[0].warnings && r3c.steps[0].warnings.length > 0, 'div by zero produces warning');

// --- groupBy ---
const wf4 = { name: 'w4', source: { type: 'memory' }, steps: [
  { id: 'g1', type: 'groupBy', keys: ['item'], aggs: [
      { fn: 'SUM', column: 'qty', out: 'sum_qty' },
      { fn: 'COUNT', column: 'qty', out: 'cnt' },
  ] },
] };
const r4 = W.executeWorkflow(wf4, { rows, columns: ['item','qty','price','note'] });
chk(r4.ok, 'groupBy workflow ok');
const gA = r4.rows.find(r => r.item === 'A');
eq(gA.sum_qty, 13, 'SUM qty for A = 10+3');
eq(gA.cnt, 2, 'COUNT for A = 2');
eq(r4.rows.length, 3, 'groupBy produces 3 groups (A,B,C)');

// empty group aggregation: SUM on all-null
const wf4b = { name: 'w4b', source: { type: 'memory' }, steps: [
  { id: 'g1', type: 'groupBy', keys: ['item'], aggs: [
      { fn: 'SUM', column: 'qty', out: 'sum_qty' },
      { fn: 'AVG', column: 'qty', out: 'avg_qty' },
  ] },
] };
const r4b = W.executeWorkflow(wf4b, { rows: [{ item: 'X', qty: null }], columns: ['item','qty'] });
chk(r4b.ok, 'groupBy with null ok');
eq(r4b.rows[0].sum_qty, 0, 'SUM of null -> 0');
eq(r4b.rows[0].avg_qty, null, 'AVG of null -> null');

// --- join with duplication warning ---
const left = [{ id: 1, key: 'k', val: 'a' }, { id: 2, key: 'k2', val: 'b' }];
const right = [{ key: 'k', extra: 1 }, { key: 'k', extra: 2 }]; // duplicate key on right
const wf5 = { name: 'w5', source: { type: 'memory' }, steps: [
  { id: 'j1', type: 'join', leftKey: 'key', rightKey: 'key', rightRows: right, joinType: 'left' },
] };
const r5 = W.executeWorkflow(wf5, { rows: left, columns: ['id','key','val'] });
chk(r5.ok, 'join workflow ok');
chk(r5.rows.length === 3, 'join produces 3 rows (1*2 + 1)');
chk(r5.steps[0].warnings && r5.steps[0].warnings.length > 0
  && r5.steps[0].warnings.some(w => /مفتاح غير فريد|تضخيم/.test(w)), 'join duplication warning present');

// inner join drops unmatched
const wf5b = { name: 'w5b', source: { type: 'memory' }, steps: [
  { id: 'j1', type: 'join', leftKey: 'key', rightKey: 'key', rightRows: right, joinType: 'inner' },
] };
const r5b = W.executeWorkflow(wf5b, { rows: [{ id: 3, key: 'nomatch', val: 'c' }], columns: ['id','key','val'] });
chk(r5b.ok, 'inner join ok');
eq(r5b.rows.length, 0, 'inner join drops unmatched');

// --- validation failure: no partial publish ---
const wf6 = { name: 'w6', source: { type: 'memory' }, steps: [
  { id: 's1', type: 'select', columns: ['item', 'qty'] },
  { id: 'bad', type: 'compute', newColumn: 'x', formula: 'qty *' }, // invalid formula
] };
const r6 = W.executeWorkflow(wf6, { rows, columns: ['item','qty','price','note'] });
chk(!r6.ok, 'invalid formula step fails workflow');
chk(r6.rows === null, 'no partial result published on failure');
chk(r6.steps.length === 2, 'trace records both steps');
chk(r6.steps[1].status === 'failed', 'second step marked failed');

// --- unknown column validation ---
const wf7 = { name: 'w7', source: { type: 'memory' }, steps: [
  { id: 's1', type: 'select', columns: ['nope'] },
] };
const r7 = W.executeWorkflow(wf7, { rows, columns: ['item','qty','price','note'] });
chk(!r7.ok, 'unknown column fails validation');

// --- preview ---
const wfp = { name: 'wp', source: { type: 'memory' }, steps: [
  { id: 's1', type: 'select', columns: ['item', 'qty'] },
] };
const rp = W.previewWorkflow(wfp, { rows, columns: ['item','qty','price','note'] }, 2);
chk(rp.ok && rp.preview === true, 'preview ok');
eq(rp.rows.length, 2, 'preview limited to 2');
eq(rp.totalRows, 4, 'preview totalRows = 4');

// --- chained steps ---
const wf8 = { name: 'w8', source: { type: 'memory' }, steps: [
  { id: 'f1', type: 'filter', column: 'item', op: 'eq', value: 'A' },
  { id: 'c1', type: 'compute', newColumn: 'total', formula: 'qty * price' },
  { id: 'g1', type: 'groupBy', keys: ['item'], aggs: [{ fn: 'SUM', column: 'total', out: 'sum_total' }] },
] };
const r8 = W.executeWorkflow(wf8, { rows, columns: ['item','qty','price','note'] });
chk(r8.ok, 'chained workflow ok');
eq(r8.rows[0].sum_total, 65, 'chained: A total 10*5 + 3*5 = 65');

// --- validation of workflow itself ---
const vwf = W.validateWorkflow({ name: 'x', source: { type: 'memory' }, steps: [] });
chk(vwf.ok, 'valid workflow passes');
const vwf2 = W.validateWorkflow({ name: 'x' });
chk(!vwf2.ok, 'workflow without source/steps fails');

// --- persistence (JSON) in temp dir ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
const id = W.saveWorkflow({ name: 'persisted', source: { type: 'memory' }, steps: [] }, tmp);
chk(typeof id === 'string' && id.length > 0, 'saveWorkflow returns id');
const loaded = W.loadWorkflow(id, tmp);
chk(loaded && loaded.name === 'persisted', 'loadWorkflow round-trips');
const listed = W.listWorkflows(tmp);
chk(Array.isArray(listed) && listed.length === 1, 'listWorkflows works');
const outPath = W.saveOutput('run1', r1, tmp);
chk(fs.existsSync(outPath), 'saveOutput writes file');
const outLoaded = W.loadOutput('run1', tmp);
chk(outLoaded && outLoaded.rowCount === 4, 'loadOutput round-trips rowCount');

// cleanup
fs.rmSync(tmp, { recursive: true, force: true });

chk(guard.count() === 0, 'no network connection');
console.log(`\nworkflow.test.js — pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);