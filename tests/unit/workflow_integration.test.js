'use strict';
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('../../src/workflow');
const F = require('../../src/formulas');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);
const eq = (a, b, m) => chk(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('== workflow integration (UI-shaped definition) ==');

// Synthetic fixture: two small tables with numeric/string/null
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

// Workflow definition as UI would send (steps array)
const wf = {
  name: 'integration-wf',
  source: { type: 'memory', name: 'orders' },
  steps: [
    { id: 'join1', type: 'join', leftKey: 'customerId', rightKey: 'id', rightRows: customers, joinType: 'left' },
    { id: 'filter1', type: 'filter', column: 'qty', op: 'gt', value: 0 },
    { id: 'compute1', type: 'compute', newColumn: 'total', formula: 'qty * price' },
    { id: 'group1', type: 'groupBy', keys: ['name'], aggs: [
        { fn: 'SUM', column: 'total', out: 'sum_total' },
        { fn: 'COUNT', column: 'id', out: 'n' },
    ] },
  ],
};

// --- validation ---
const v = W.validateWorkflow(wf);
chk(v.ok, 'workflow validates');
const sv = W.validateStep(wf.steps[0], ['id','customerId','qty','price','note']);
chk(sv.ok, 'join step validates with columns');

// --- execute ---
const data = { rows: orders.map(r => ({...r})), columns: ['id','customerId','qty','price','note'] };
const res = W.executeWorkflow(wf, data);
chk(res.ok, 'executeWorkflow ok');
chk(res.rows !== null, 'result published (not null)');
eq(res.rows.length, 3, '3 groups (Alice, Bob, Carol; orphan dropped by inner? left join keeps orphan but filter qty>0 keeps it -> actually orphan qty=4>0 -> included with null name)');
// orphan has qty=4>0 and name=null (left join unmatched -> name null) -> group key null
const gAlice = res.rows.find(r => r.name === 'Alice');
chk(gAlice, 'Alice group exists');
eq(gAlice.sum_total, 10*5 + 3*5, 'Alice sum_total = 65');
eq(gAlice.n, 2, 'Alice count = 2');
const gBob = res.rows.find(r => r.name === 'Bob');
eq(gBob.sum_total, 7*2, 'Bob sum_total = 14');
// Carol's row qty=0 filtered out before groupBy, so no Carol group
chk(!res.rows.find(r => r.name === 'Carol'), 'Carol filtered out (qty=0)');
// orphan group (name null)
const gNull = res.rows.find(r => r.name === null || r.name === undefined);
chk(gNull, 'orphan group (name null) present');
eq(gNull.sum_total, 4*1, 'orphan sum_total = 4');

// --- trace ---
chk(Array.isArray(res.trace) && res.trace.length === 4, 'trace has 4 steps');
chk(res.trace.every(s => s.status === 'success'), 'all steps success');
eq(res.trace[0].rowCount, 5, 'join row count 5 (orphan included via left join)');
eq(res.trace[1].rowCount, 4, 'filter row count 4 (qty>0)');

// --- preview ---
const pv = W.previewWorkflow(wf, data, 2);
chk(pv.ok && pv.preview === true, 'preview ok');
chk(pv.rows.length <= 2, 'preview limited');

// --- failure: no partial publish ---
const wfBad = JSON.parse(JSON.stringify(wf));
wfBad.steps[2].formula = 'qty *'; // invalid
const resBad = W.executeWorkflow(wfBad, data);
chk(!resBad.ok, 'bad workflow fails');
chk(resBad.rows === null, 'no partial result on failure');

// --- validation ---
const vBad = W.validateWorkflow({ name: 'x' });
chk(!vBad.ok, 'invalid workflow (no source/steps) fails validation');
const vStep = W.validateStep({ type: 'compute', newColumn: 'x', formula: 'qty *' }, ['qty']);
chk(!vStep.ok, 'invalid step (bad formula) fails validation');

// --- persistence in temp dir ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wfint-'));
const id = W.saveWorkflow(wf, tmp);
chk(typeof id === 'string' && id.length > 0, 'saveWorkflow returns id');
const loaded = W.loadWorkflow(id, tmp);
chk(loaded && loaded.name === 'integration-wf', 'loadWorkflow round-trips name');
chk(Array.isArray(loaded.steps) && loaded.steps.length === 4, 'loadWorkflow round-trips steps');
const listed = W.listWorkflows(tmp);
chk(listed.some(x => x.id === id), 'listWorkflows includes saved');
const outPath = W.saveOutput('int-run-1', res, tmp);
chk(fs.existsSync(outPath), 'saveOutput writes file');
const outLoaded = W.loadOutput('int-run-1', tmp);
chk(outLoaded && outLoaded.rowCount === res.rows.length, 'loadOutput round-trips rowCount');

// --- function list (Formula Studio) ---
const fns = F.listFunctions();
chk(fns.length >= 20, 'formula list has >=20 functions');
chk(fns.every(f => f.id && f.name && f.params && f.returnType && f.nullBehavior), 'every fn has metadata');

// --- formula on synthetic data ---
eq(F.evaluateFormula('qty * price', { qty: 10, price: 5 }).value, 50, 'formula qty*price');
eq(F.evaluateFormula('IF(qty > 0, qty * price, 0)', { qty: 0, price: 5 }).value, 0, 'IF with zero');
const dz = F.evaluateFormula('DIV(qty, price)', { qty: 10, price: 0 });
chk(dz.value === null && dz.warnings.length > 0, 'DIV by zero -> null + warning');

// cleanup
fs.rmSync(tmp, { recursive: true, force: true });

chk(guard.count() === 0, 'no network connection');
console.log(`\nworkflow_integration.test.js — pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);