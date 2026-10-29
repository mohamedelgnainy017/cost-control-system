'use strict';
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const path = require('node:path');

const RB = require('../../src/report-bridge');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

console.log('== report-bridge (Python engine integration) ==');

/* 1) findPython returns a working interpreter */
const bin = RB.findPython();
chk(typeof bin === 'string' && bin.length > 0, 'findPython returns a path');
chk(require('child_process').spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0,
  'interpreter runs --version');

/* 2) renderReport with synthetic data */
(async () => {
  const report = { title: 't', components: [
    { type: 'kpi', label: 'sum', column: 'qty', agg: 'sum' },
    { type: 'table', columns: ['item', 'qty'], limit: 2 },
    { type: 'bar', category: 'item', value: 'qty', agg: 'sum', title: 'bar' },
  ] };
  const data = { columns: ['item', 'qty'], rows: [{ item: 'A', qty: 10 }, { item: 'A', qty: 3 }, { item: 'B', qty: 7 }] };
  const r = await RB.renderReport(report, data);
  chk(r.ok === true, 'renderReport ok');
  chk(typeof r.html === 'string' && r.html.includes('20'), 'KPI sum=20 in html');
  chk(r.html.includes('<table'), 'table rendered');
  chk(r.html.includes('<svg'), 'bar chart rendered');
  chk(r.rows === 3, 'rows=3');

  /* 3) validate */
  const v = await RB.validateReport({ name: 'x', components: [{ type: 'kpi', column: 'qty', agg: 'sum' }] });
  chk(v.ok === true, 'validateReport ok');
  const v2 = await RB.validateReport({ name: 'x', components: [{ type: 'foo' }] });
  chk(v2.ok === false, 'validateReport rejects unknown type');

  /* 4) invalid report -> error */
  const r2 = await RB.renderReport({ components: 'bad' }, data);
  chk(r2.ok === false, 'renderReport rejects invalid report');

  /* 5) standalone export */
  const r3 = await RB.renderReport(report, data, { standalone: true });
  chk(r3.ok === true && r3.html.includes('<!DOCTYPE html>'), 'standalone export has DOCTYPE');

  /* 6) static audit: server routes + tabs + public routes */
  const srv = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
  chk(/'GET \/api\/reports': async/.test(srv), 'route GET /api/reports');
  chk(/'GET \/api\/reports\/get': async/.test(srv), 'route GET /api/reports/get');
  chk(/'POST \/api\/reports\/save': async/.test(srv), 'route POST /api/reports/save');
  chk(/'POST \/api\/reports\/render': async/.test(srv), 'route POST /api/reports/render');
  chk(/'POST \/api\/reports\/validate': async/.test(srv), 'route POST /api/reports/validate');
  chk(/'GET \/api\/reports\/export\/html': async/.test(srv), 'route GET /api/reports/export/html');
  chk(/R\.renderReport\(/.test(srv) && /R\.validateReport\(/.test(srv), 'server uses bridge');
  chk(/const R = require\(['"]\.\/report-bridge['"]\)/.test(srv), 'server requires report-bridge');
  chk(/'report-studio'/.test(srv), 'TABS includes report-studio');

  /* 7) UI: section + IIFE present */
  const idx = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  const appjs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
const designerjs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'report-designer.js'), 'utf8');
  chk(/id="tab-report-studio"/.test(idx), 'index.html has report-studio section');
  chk(/data-tab="report-studio"|data-goto="report-studio"/.test(idx), 'nav has report-studio entry (زر أو عنصر قائمة)');
  chk(/loadReportStudioTab/.test(appjs), 'app.js exposes loadReportStudioTab');
  chk(/api\/reports\/render/.test(appjs) || /api\/reports\/render/.test(designerjs), 'الواجهة تستدعي reports/render');

  chk(guard.count() === 0, 'صفر اتصال');
  console.log(`\nreport_bridge.test.js — pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
