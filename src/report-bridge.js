'use strict';
/**
 * Bridge between Node.js and the Python Report Engine.
 * - Spawns python with a fixed script path (no shell, no user input in argv).
 * - Passes JSON via stdin, reads JSON from stdout.
 * - Timeout + error handling. No new DB connection.
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const CANDIDATES = [
  process.env.PYTHON_BIN,
  'C:/Users/Aleman/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',
  'python',
  'python3',
].filter(Boolean);

let cached = null;
function findPython() {
  if (cached) return cached;
  for (const bin of CANDIDATES) {
    try {
      const r = spawnSync(bin, ['--version'], { timeout: 3000, encoding: 'utf8', windowsHide: true });
      if (r.status === 0) { cached = bin; return bin; }
    } catch (_) {}
  }
  return null;
}

function runPython(payload, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const bin = findPython();
    if (!bin) return resolve({ ok: false, error: 'Python interpreter not found' });
    const script = path.join(__dirname, '..', 'python', 'report_engine.py');
    if (!fs.existsSync(script)) return resolve({ ok: false, error: 'report_engine.py not found' });
    const child = spawn(bin, [script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, opts.timeout || 20000);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', () => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch (_) {}
      if (!parsed) resolve({ ok: false, error: 'invalid python output', stderr: stderr.slice(0, 300) });
      else resolve(parsed);
    });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function renderReport(report, data, opts) {
  opts = opts || {};
  return runPython({ action: opts.standalone ? 'export' : 'render', report: report || {}, data: data || {}, standalone: !!opts.standalone }, opts);
}

function validateReport(report, opts) {
  opts = opts || {};
  const payload = { action: 'validate', report: report || {} };
  /* أعمدة البيانات (إن توفّرت) ⇒ يتحقق المحرك من الأعمدة المطلوبة مقابلها */
  if (Array.isArray(opts.columns)) payload.data = { columns: opts.columns, rows: [] };
  return runPython(payload, { timeout: 10000 });
}

function exportReport(report, data, format, opts) {
  opts = opts || {};
  const os = require('os');
  const pathMod = require('path');
  const crypto = require('crypto');
  const tmpDir = pathMod.join(os.tmpdir(), 'ccs-reports');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
  const ext = format === 'xlsx' ? 'xlsx' : 'pdf';
  const tmpPath = pathMod.join(tmpDir, 'rep_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex') + '.' + ext);
  return runPython({ action: 'export_' + (format === 'xlsx' ? 'xlsx' : 'pdf'), report: report || {}, data: data || {}, output_path: tmpPath }, opts).then(res => {
    if (!res || !res.ok) { try { fs.unlinkSync(tmpPath); } catch (_) {} return res || { ok: false, error: 'no response' }; }
    let buf = null;
    try { buf = fs.readFileSync(res.path || tmpPath); } catch (e) { try { fs.unlinkSync(tmpPath); } catch(_){} return { ok: false, error: e.message }; }
    try { fs.unlinkSync(res.path || tmpPath); } catch (_) {}
    return { ok: true, buffer: buf, rows: res.rows };
  });
}

function capabilities() {
  return runPython({ action: 'capabilities' }, { timeout: 10000 });
}

module.exports = { findPython, renderReport, validateReport, exportReport, capabilities };
