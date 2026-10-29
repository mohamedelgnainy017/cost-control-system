'use strict';
/**
 * تكامل Report Studio ↔ Workflow Studio (بيانات اصطناعية، معزولة).
 * يثبت: run → loadOutput → report def save/load → render (Python) → CSV.
 */
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const W = require('../../src/workflow');
const C = require('../../src/csv');
const RB = require('../../src/report-bridge');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);
const eq = (a, b, m) => chk(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const rows = [
  { id: 1, customerId: 1, qty: 10, price: 5, note: 'a' },
  { id: 2, customerId: 1, qty: 3, price: 5, note: null },
  { id: 3, customerId: 2, qty: 7, price: 2, note: 'b' },
];
const customers = [{ id: 1, name: 'Alice', region: 'North' }, { id: 2, name: 'Bob', region: 'South' }];

const wf = {
  name: 'int-wf', source: { type: 'memory', name: 'orders' },
  steps: [
    { id: 'j1', type: 'join', leftKey: 'customerId', rightKey: 'id', rightRows: customers, joinType: 'left' },
    { id: 'c1', type: 'compute', newColumn: 'total', formula: 'qty * price' },
    { id: 'g1', type: 'groupBy', keys: ['name'], aggs: [{ fn: 'SUM', column: 'total', out: 'sum_total' }] },
  ],
};

console.log('== report integration (synthetic, isolated) ==');

(async () => {

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-int-'));
const runId = 'int-run-' + Date.now();

/* 1) execute + saveOutput */
const data = { rows: rows.map(r => ({ ...r })), columns: ['id', 'customerId', 'qty', 'price', 'note'] };
const res = W.executeWorkflow(wf, data);
chk(res.ok, 'executeWorkflow ok');
const outPath = W.saveOutput(runId, res, tmp);
chk(fs.existsSync(outPath), 'saveOutput writes file');

/* 2) retrieve run */
const loaded = W.loadOutput(runId, tmp);
chk(loaded && loaded.runId === runId, 'loadOutput returns runId');
chk(Array.isArray(loaded.columns) && loaded.columns.includes('name') && loaded.columns.includes('sum_total'),
  'loadOutput columns include name, sum_total');
chk(loaded.rowCount === res.rows.length, 'loadOutput rowCount matches');
chk(loaded.rows.length === res.rows.length, 'loadOutput rows match full result (not preview)');

/* 3) missing run */
chk(W.loadOutput('no-such-run', tmp) === null, 'loadOutput missing -> null');

/* 4) report def save/load (simulate server logic) */
const reportDir = path.join(tmp, 'reports');
fs.mkdirSync(reportDir, { recursive: true });
const report = { name: 'int-report', runId, components: [
  { type: 'kpi', label: 'sum', column: 'sum_total', agg: 'sum' },
  { type: 'table', columns: ['name', 'sum_total'], limit: 10 },
] };
const rid = 'rep_' + Date.now();
fs.writeFileSync(path.join(reportDir, rid + '.json'), JSON.stringify(Object.assign({}, report, { id: rid, savedAt: new Date().toISOString() }), null, 2));
const loadedRep = JSON.parse(fs.readFileSync(path.join(reportDir, rid + '.json'), 'utf8'));
chk(loadedRep.name === 'int-report' && loadedRep.runId === runId, 'report def round-trips name + runId');
chk(Array.isArray(loadedRep.components) && loadedRep.components.length === 2, 'report def round-trips components');

/* 5) render via Python engine with run data */
const runData = { columns: loaded.columns, rows: loaded.rows };
const renderRes = await RB.renderReport(loadedRep, runData);
chk(renderRes.ok === true, 'renderReport ok');
chk(typeof renderRes.html === 'string' && renderRes.html.includes('<table'), 'rendered html has table');
chk(renderRes.rows === loaded.rows.length, 'render rows = run rows');

/* 6) missing run -> empty data (no crash) */
const renderRes2 = await RB.renderReport({ name: 'x', components: [{ type: 'kpi', label: 's', column: 'sum_total', agg: 'sum' }] }, { columns: [], rows: [] });
chk(renderRes2.ok === true, 'render with empty data ok (no crash)');

/* 7) عمود مفقود -> خطأ صريح (لا شرطة توهم بنجاح) */
const renderRes3 = await RB.renderReport({ name: 'x', components: [{ type: 'kpi', label: 's', column: 'nope', agg: 'sum' }] }, runData);
chk(renderRes3.ok === true && renderRes3.html.includes('comp-error'), 'عمود مفقود -> كتلة خطأ صريحة');
chk(renderRes3.errors && renderRes3.errors.length === 1 && /nope/.test(renderRes3.errors[0].message),
  'الخطأ مُبلَّغ في مصفوفة errors مع اسم العمود');

/* 8) CSV full results (beyond preview) */
const csv = C.safeToCsv(loaded.rows);
chk(csv.split('\r\n').length === loaded.rows.length + 1, 'CSV has all run rows (not preview)');
chk(csv.includes('\uFEFF'), 'CSV has BOM');

/* 9) guard */
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
chk(guard.count() === 0, 'صفر اتصال');
console.log(`\nreport_integration.test.js — pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
