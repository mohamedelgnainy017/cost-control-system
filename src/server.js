'use strict';
/**
 * خادم النظام — PostgreSQL + node:http
 * يعمل محلياً الآن ويمكن نقله كما هو إلى سيرفر أونلاين لاحقاً.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');

const DB = require('./db');
const { normAr, pad2 } = require('./pure');
const { analyzePreviewDeep } = require('./importer');
const DE = require('./daily-entry');
const A = require('./analytics');
const Auth = require('./auth');
const BE = require('./borse-edit');
const BF = require('./borse-fetch');
const PE = require('./prices-edit');
const CE = require('./cost-engine');
const M = require('./master');
const W = require('./workflow');
const WG = require('./workflow-graph');
const PY = require('./python-transform');
const F = require('./formulas');
const FV = require('./formula-verifier');
const D = require('./datasets');
const CAT = require('./data-catalog');
const ME = require('./model-explorer');
const SR = require('./screen-registry');
const R = require('./report-bridge');
const RS = require('./report-store');
const RP = require('./report-print');
const Schema = require('./report-schema');
const Policy = require('./route-policy');
const WC = require('./workcenter');
const LR = require('./legacy-report');
const FS = require('./formula-store');
const FRes = require('./formula-resolver');
const FormulaEngine = require('./formulas');
const AppScreen = require('./app-screen');
const ScreenStore = require('./screen-store');
const PLATFORM = require('./platform-screens');
function injectFixtureRights(wf, fix) {
  // clone workflow, inject rightRows/rightKey into join steps lacking them
  const clone = JSON.parse(JSON.stringify(wf));
  for (const s of (clone.steps || [])) {
    if (s.type === 'join' && (!s.rightRows || !s.rightRows.length)) {
      s.rightRows = fix.rightRows;
      if (!s.rightKey) s.rightKey = 'id';
    }
  }
  return clone;
}

/* ---------- الرسم البياني المرئي ----------
 * التعريف قد يحمل graph بدل steps (أو معها). هنا يُتحقق من الرسم ويُترجم إلى
 * نفس خطوات المحرك الخطي — لا محرك ثانٍ. التعريفات القديمة بلا graph تمر كما هي.
 */
function resolveGraphWorkflow(wf) {
  if (!wf || typeof wf !== 'object' || !wf.graph) return { ok: true, workflow: wf };
  const gv = WG.validateGraph(wf.graph);
  if (!gv.ok) {
    return {
      ok: false,
      status: 400,
      error: 'رسم التحليل غير صالح: ' + gv.errors.join(' · '),
      graphErrors: gv.errors,
      nodeErrors: gv.nodeErrors,
    };
  }
  const compiled = WG.compileGraph(wf.graph);
  if (!compiled.ok) {
    return {
      ok: false, status: 400,
      error: 'تعذّرت ترجمة الرسم: ' + compiled.errors.join(' · '),
      graphErrors: compiled.errors,
      nodeErrors: compiled.nodeErrors,
    };
  }
  return {
    ok: true,
    workflow: Object.assign({}, wf, {
      source: compiled.source,
      steps: compiled.steps,
      graph: WG.normalizeGraph(wf.graph),
      graphSchemaVersion: WG.GRAPH_SCHEMA_VERSION,
    }),
    graphInfo: { order: compiled.order, outputName: compiled.outputName },
  };
}

/* ---------- لا تدع خطأ غير معالج يُوقف الخادم (يُسجَّل في ملف بدلاً من الانهيار) ----------
   السبب (السابق): أي استثناء غير معالج كان يُخرج Node (exit 1) فتتوقف الخدمة وتظهر
   نافذة «Server is running» при перезапуске keep-alive. الآن نُسجّل الخطأ ونُبقي الخادم حيّاً. */
const ERR_LOG = path.join(__dirname, '..', 'data', 'server-errors.log');
process.on('uncaughtException', (err) => {
  const msg = `[${new Date().toISOString()}] uncaughtException: ${err && err.stack ? err.stack : err}\n`;
  try { fs.appendFileSync(ERR_LOG, msg); } catch (_) {}
  console.error(msg);
});
process.on('unhandledRejection', (reason) => {
  const msg = `[${new Date().toISOString()}] unhandledRejection: ${reason && reason.stack ? reason.stack : reason}\n`;
  try { fs.appendFileSync(ERR_LOG, msg); } catch (_) {}
  console.error(msg);
});

const PORT = Number(process.env.PORT || 4310);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
};

/* ---------- استيراد الملفات اليومية (حفظ + قائمة + استبدال) ----------
   الملف يُحفظ باسمه (عادةً تاريخ اليوم مثل 01-10-2026.xlsx) في
   data/uploads/<الفئة> — ورفع نفس الاسم مرة أخرى يستبدل الملف والبيانات. */
const UPLOADS_ROOT = path.join(__dirname, '..', 'data', 'uploads');
const WF_ROOT = path.join(__dirname, '..', 'data', 'workflows');
const REPORTS_ROOT = path.join(__dirname, '..', 'data', 'reports');
const FORMULA_ROOT = path.join(__dirname, '..', 'data', 'formulas');
/* الشاشات المخصّصة (مصمم الشاشات): ملف JSON لكل شاشة — نمط مخزن التقارير */
const SCREENS_ROOT = path.join(__dirname, '..', 'data', 'screens');
/* مجلد المرحلة المؤقتة: يُحفظ فيه الملف المرفوع للمعاينة قبل التأكيد،
   ويُنقل إلى مجلده النهائي عند commit — فلا يُستورد شيء لم يُعايَن. */
const STAGING_DIR = path.join(UPLOADS_ROOT, '.staging');
/* تنظيف ملفات المرحلة القديمة: معاينة أُلغيت بلا تأكيد تترك ملفاً مؤقتاً —
   نُزيل كل ما تجاوز 24 ساعة عند كل معاينة جديدة حتى لا تتراكم. */
function pruneStaging(maxAgeMs = 86400000) {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(STAGING_DIR)) {
      const p = path.join(STAGING_DIR, f);
      try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p); } catch (_) {}
    }
  } catch (_) { /* لا مجلد مرحلة بعد */ }
}
const DAILY_CATS = {
  movements: { table: 'movements', label: 'الحركات اليومية' },
  sales: { table: 'sales', label: 'المبيعات اليومية' },
  balances:  { table: 'balances', label: 'الأرصدة اليومية' },
};
const datasetsFor = cat => [cat];
const uploadsDir = cat => path.join(UPLOADS_ROOT, cat);
const sanitizeFileName = name => {
  const s = String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim();
  return s || 'file.xlsx';
};
/** يقرى تاريخ اليوم من اسم الملف (مثل 01-10-2026) إن وُجد */
function dateFromName(name) {
  const m = String(name || '').match(/(\d{1,2})[-_.](\d{1,2})[-_.](\d{2,4})/);
  if (!m) return null;
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  const iso = `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  const d = new Date(iso + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : iso;
}

/* فلترة صفوف تقرير حسب فلاتر رؤوس الأعمدة القادمة من الواجهة — تُطبَّق في الذاكرة.
   المدخل: كائن JSON مثل {"item":"1100","place":"اسيوط",">=amount":"100","qty":"100-500"}.
   - عملية مقارنة: >100 / >=100 / <100 / <=100 / =100
   - مدى رقمي: 100-500
   - خلاف ذلك: احتواء نصي بعد تطبيع عربي (الهمزات/الياء/التاء + إسقاط الفراغات والفواصل). */
/* تطبيع نصي عربي موحّد: توحيد الهمزات/الياء/التاء المربوطة + إسقاط التشكيل والفراغات والفواصل */

function applyColFilters(rows, param) {
  let flt = null;
  try { flt = param ? JSON.parse(param) : null; } catch (_) { flt = null; }
  if (!flt || typeof flt !== 'object' || Array.isArray(flt)) return rows;
  const norm = normAr;
  const toNum = s => {
    const t = String(s === null || s === undefined ? '' : s).replace(/[^\d.\-]/g, '');
    return /\d/.test(t) ? Number(t) : NaN;
  };
  const cmp = (a, b) => {
    const na = toNum(a), nb = toNum(b);
    if (isFinite(na) && isFinite(nb)) return na - nb;
    return String(norm(a)).localeCompare(String(norm(b)), 'ar', { numeric: true });
  };
  /* قاعدة الفلتر: كائن {op,v,v2} أو نص قديم (يُعامل كـ «يحتوي على») */
  const test = (val, rule) => {
    let r;
    if (typeof rule === 'string') {
      const t = rule.trim();
      let m = t.match(/^(>=|<=|>|<|=)\s*(-?\d+(?:[.,]\d+)?)$/);
      if (m) r = { op: m[1] === '>' ? 'gt' : m[1] === '>=' ? 'gte' : m[1] === '<' ? 'lt' : m[1] === '<=' ? 'lte' : 'eq', v: m[2] };
      else if ((m = t.match(/^(-?\d+(?:[.,]\d+)?)\s*(?:-|\u2013|\.\.)\s*(-?\d+(?:[.,]\d+)?)$/))) r = { op: 'between', v: m[1], v2: m[2] };
      else r = { op: 'contains', v: t };
    } else r = rule || {};
    const op = r.op || 'contains';
    const plain = String(val === null || val === undefined ? '' : val);
    const nd = norm(plain);
    const v = norm(r.v);
    const rawV = String(r.v === null || r.v === undefined ? '' : r.v).trim();
    const rawV2 = String(r.v2 === null || r.v2 === undefined ? '' : r.v2).trim();
    if (op === 'empty') return plain.trim() === '';
    if (op === 'notempty') return plain.trim() !== '';
    if (op === 'startswith') return v === '' || nd.indexOf(v) === 0;
    if (op === 'endswith') return v === '' || nd.slice(-v.length) === v;
    if (op === 'eq') return v === '' || cmp(plain, r.v) === 0;
    if (op === 'ne') return v === '' || cmp(plain, r.v) !== 0;
    if (op === 'gt') return v !== '' && cmp(plain, r.v) > 0;
    if (op === 'gte') return v !== '' && cmp(plain, r.v) >= 0;
    if (op === 'lt') return v !== '' && cmp(plain, r.v) < 0;
    if (op === 'lte') return v !== '' && cmp(plain, r.v) <= 0;
    if (op === 'between') {
      if (rawV === '' && rawV2 === '') return true;
      if (rawV !== '' && rawV2 === '') return cmp(plain, r.v) >= 0;
      if (rawV === '' && rawV2 !== '') return cmp(plain, r.v2) <= 0;
      const lo = cmp(r.v, r.v2) <= 0 ? r.v : r.v2, hi = cmp(r.v, r.v2) <= 0 ? r.v2 : r.v;
      return cmp(plain, lo) >= 0 && cmp(plain, hi) <= 0;
    }
    if (op === 'in' || op === 'notin') {
      let list;
      if (Array.isArray(r.set)) {
        list = r.set.map(x => norm(x));
      } else {
        list = String(r.v === null || r.v === undefined ? '' : r.v).split(/[,،;]/).map(x => norm(x)).filter(Boolean);
      }
      if (!list.length) return true;
      const hit = list.some(x => cmp(plain, x) === 0);
      return op === 'in' ? hit : !hit;
    }
    return v === '' || nd.indexOf(v) >= 0;
  };
  const entries = Object.keys(flt).filter(k => {
    const r = flt[k];
    if (r === null || r === undefined) return false;
    if (typeof r === 'string') return r.trim() !== '';
    const op = r.op || 'in';
    if (op === 'empty' || op === 'notempty') return true;
    if (op === 'in' || op === 'notin') {
      if (Array.isArray(r.set)) return r.set.length > 0;
      const v = String(r.v === null || r.v === undefined ? '' : r.v).trim();
      return v !== '';
    }
    const v = String(r.v === null || r.v === undefined ? '' : r.v).trim();
    const v2 = String(r.v2 === null || r.v2 === undefined ? '' : r.v2).trim();
    return v !== '' || v2 !== '';
  });
  if (!entries.length) return rows;
  return rows.filter(r => entries.every(k => test(r[k], flt[k])));
}

/* ---------- فلاتر شاشات عقود الاستيراد (بحث + تاريخ + حالة العقد) ----------
   تعمل على التقارير الخام لخطوات العقود. «الحالة» تُقرأ من عمود contract_status
   إن وُجد في الشاشة، وإلا تُحلّ من حالة العقد الأم عبر «الرقم داخلي» — فيعمل الفلتر
   على كل الخطوات (تسجيل عقد/تفصيلى/سداد/تحميل/ربط/ترويل/افراج) ومرتبط بالحالة الحقيقية. */
const CON_VIEW_DATE = {
  'contract-registrations-raw': 'contract_date',
  'contract-details-raw': 'expected_arrival',
  'contract-payments-raw': 'payment_date',
  'contract-loading-raw': 'loading_date',
  'contract-hedge-raw': 'hedge_date',
  'contract-roll-raw': 'roll_date',
  'contract-release-raw': 'release_date',
};
async function contractViewFilter(name, rows, q) {
  const dateCol = CON_VIEW_DATE[name];
  if (!dateCol || !rows.length) return rows;
  const status = (q.get('status') || '').trim();
  const search = (q.get('q') || '').trim();
  const from = (q.get('from') || '').trim();
  const to = (q.get('to') || '').trim();
  if (!status && !search && !from && !to) return rows;
  let out = rows;
  if (status) {
    /* إن كانت الشاشة تحمل عمود contract_status نفلتر عليه مباشرة؛ وإلا نربط بالرقم داخلي */
    let statusOf;
    if (Object.prototype.hasOwnProperty.call(rows[0], 'contract_status')) {
      statusOf = r => normAr(r.contract_status);
    } else {
      const map = new Map();
      for (const g of await DB.all('SELECT internal_no, contract_status FROM contract_registrations')) {
        const k = String(g.internal_no || '').trim();
        if (!k) continue;
        const v = normAr(g.contract_status);
        if (!map.has(k) || (v && !map.get(k))) map.set(k, v);
      }
      statusOf = r => map.get(String(r.internal_no || '').trim()) || '';
    }
    const want = normAr(status);
    out = out.filter(r => statusOf(r) === want);
  }
  if (search) {
    const s = normAr(search);
    out = out.filter(r => Object.values(r).some(v => normAr(v).includes(s)));
  }
  if (from) out = out.filter(r => String(r[dateCol] || '') >= from);
  if (to) out = out.filter(r => { const d = String(r[dateCol] || ''); return d !== '' && d <= to; });
  return out;
}

function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
const ok = (res, data, headers = {}) => send(res, 200, { ok: true, data }, headers);
const bad = (res, msg, code = 400) => send(res, code, { ok: false, error: String(msg) });
/** تغليف مسار: خطأ التحقق (throw) يعود 400 برسالة عربية بدل 500 */
const check = fn => async (q, res, body, req, me) => {
  try { await fn(q, res, body, req, me); }
  catch (e) { bad(res, e.message, 400); }
};

/** كوكيز الجلسة — HttpOnly فلا تقرأه جافاسكربت */
const sessionCookie = (token) =>
  `${Auth.COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Auth.SESSION_DAYS * 86400}`;

const Csv = require('./csv');

/* ---------- وظائف الاستيراد (عملية منفصلة حتى لا يتجمّد الخادم) ---------- */
const jobs = {};
let jobSeq = 0;

function startImportJob(filePath, opts = {}) {
  const id = ++jobSeq;
  const job = jobs[id] = {
    id, status: 'running', stage: 'بدء', started: Date.now(),
    result: null, error: null, log: [],
  };
  const args = [path.join(__dirname, 'cli-import.js'), filePath];
  if (opts.password) args.push('--password=' + opts.password);
  if (Array.isArray(opts.only) && opts.only.length) args.push('--only=' + opts.only.join(','));
  if (opts.asSource) args.push('--as=' + opts.asSource);
  const child = spawn(process.execPath, args, { cwd: path.join(__dirname, '..'), windowsHide: true });
  job.pid = child.pid;

  let buf = '';
  const handleLine = (line) => {
    if (line.startsWith('#PROG ')) {
      try { const p = JSON.parse(line.slice(6)); job.stage = p.stage; job.log.push(p.stage); } catch (_) {}
    } else if (line.startsWith('#RESULT ')) {
      try { const r = JSON.parse(line.slice(8)); job.rawResult = r; } catch (_) {}
    } else if (line.trim()) {
      job.stdout = (job.stdout || '') + line + '\n';
      if (line.trim()) job.stage = line.trim().slice(0, 120);
    }
  };
  child.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.on('data', d => { job.stderr = (job.stderr || '') + d.toString(); });

  child.on('error', e => { job.status = 'error'; job.error = e.message; job.stage = 'فشل'; });
  child.on('close', async (code) => {
    job.ms = Date.now() - job.started;
    if (code === 0 && job.rawResult && job.rawResult.ok) {
      job.result = job.rawResult.result;
      try {
        /* استيراد أرصدة يغيّر تكاليف اليوم نفسه وما بعده → يُعاد بناء المحرك من أول مصدر */
        const tbls = (job.rawResult && job.rawResult.result && job.rawResult.result.tables) || [];
        if (tbls.some(t => t && t.dataset === 'balances')) {
          await CE.markDirty(await CE.minDate());
        }
        /* البيانات الأساسية (الأصناف/المواقع) تُدار يدوياً من شاشاتها — لا مزامنة
           تلقائية من الحركات. زر «جلب من الحركات» (perm: master) متاح عند الطلب. */
      } catch (e) { job.postError = e.message; }
      job.status = 'done';
      job.stage = 'اكتمل';
    } else {
      job.status = 'error';
      job.stage = 'فشل';
      job.error = (job.rawResult && job.rawResult.error) || (job.stderr || '').trim().slice(-800) || ('خرج بالرمز ' + code);
    }
  });
  return id;
}

/* ---------- البورصة: جلب ذاتي داخل النظام (بلا أي ارتباط بملف Excel) ---------- */
const localStr = d => (d instanceof Date && !isNaN(d))
  ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  : (d || null);


/**
 * حالة البورصة = الأرشيف المستورد في القاعدة + آخر جلب ذاتي من مصادر خارجية
 * (Yahoo لأسعار الإغلاق، بنك مصر لريت الدولار) — انظر src/borse-fetch.js.
 * النظام لا يقرأ ولا يكتب أي ملف بورصة.
 */
async function borseStatus() {
  const [fetch, last] = await Promise.all([
    BF.status(),
    DB.get(`SELECT MAX(imported_at) t FROM imports WHERE dataset = 'borse'`),
  ]);
  return {
    ...fetch,
    archiveImport: localStr(last && last.t ? new Date(last.t) : null),
    source: { prices: 'Yahoo Finance', usd: 'بنك مصر', module: 'borse-fetch' },
  };
}

/* ---------- التقارير: مصدر واحد يخدم العرض في المتصفح والتصدير CSV ---------- */
/* hidden: يُبقى التقرير متاحاً للتصدير (CSV) لكنه لا يظهر في قائمة مركز التقارير
   — تُستخدم للتقارير التي استُبدلت بتقارير المبيعات الثلاثة */
const REPORTS = {
  'sales-total': { label: 'المبيعات', fn: F => (F.mode === 'detail' ? A.salesDetail(F) : F.mode === 'raw' ? DB.all(`SELECT * FROM sales ORDER BY id`) : A.salesGroup(F, F.by || 'item', F.by2 || '', F.per || '').then(r => r.rows)) },
  /* ---------- تقارير مخازن جديدة (تفصيلي • إجمالي بمستويات • فترات) ----------
      القديمة تبقى مخفية للتصدير فقط */
  'movements-total': { label: 'الحركات', fn: F => (F.mode === 'detail' ? A.movementsDetail(F) : F.mode === 'raw' ? DB.all(`SELECT * FROM movements ORDER BY id`) : A.movementsGroup(F, F.by || 'item', F.by2 || '', F.per || '').then(r => r.rows)) },
  /* ---------- تقارير أرصدة جديدة (تفصيلي • إجمالي بمستويات • فترات) ---------- */
  'inventory-total': { label: 'الأرصدة', fn: F => (F.mode === 'detail' ? A.inventoryDetail(F) : F.mode === 'raw' ? DB.all(`SELECT * FROM balances ORDER BY id`) : A.inventoryGroup(F, F.by || 'item', F.by2 || '', F.per || '').then(r => r.rows)) },
  /* تقرير شاشة «المبيعات اليومية» للتصدير: بدون التكلفة + «قيمة البيع للوحدة» */
  'sales-day': { hidden: true, label: 'مبيعات يومية (تجميع × تفصيل × فترة)', desc: 'by & by2 & per', fn: F => A.salesDaily(F, F.by || 'detail', F.by2 || '', F.per || '').then(r => r.rows) },
  'reconcile': { label: 'مطابقة الأرصدة', desc: 'رصيد نهاية كل تاريخ سابق مقابل بداية التاريخ التالي', fn: () => DB.all('SELECT * FROM recon ORDER BY ABS(diff_val) DESC') },
  'borse-latest': { label: 'أسعار البورصة الأخيرة', desc: 'آخر سعر لكل صنف مع التغير', fn: () => A.borseLatest() },
  'borse-raw': {
    label: 'سجل البورصة اليومي (خام)', desc: 'كل التسجيلات اليومية كما في الملف',
    fn: () => DB.all(`SELECT borse_date, contract, item_code, item, low, high, close, basis, borse_now,
             usd_rate, down_payment, fees, fx_factor, cost_price
             FROM borse ORDER BY borse_date DESC, item`),
  },
  /* ---------- تقارير عقود الاستيراد الخام: كل أوراق الملف المصدر ---------- */
  'contract-registrations-raw': {
    label: 'تسجيل العقود (خام)', desc: 'ورقة «التسجيل» — كل عقود الاستيراد وكل أعمدتها', raw: true, hidden: true,
    fn: () => DB.all(`SELECT * FROM contract_registrations ORDER BY id`),
  },
  'contract-details-raw': {
    label: 'تفصيلى العقود (خام)', desc: 'ورقة «تفصيلى» — بنود العقود ومراكبها وموانئ الوصول', raw: true, hidden: true,
    fn: () => DB.all(`SELECT * FROM contract_details ORDER BY id`),
  },
  'contract-payments-raw': {
    label: 'سداد العقود (خام)', desc: 'ورقة «السداد» — بنود السداد وأسعارها', raw: true, hidden: true,
    fn: () => DB.all(`SELECT * FROM contract_payments ORDER BY id`),
  },
  'contract-loading-raw': {
    label: 'تحميل العقود (خام)', desc: 'ورقة «التحميل» — كميات التحميل لكل مركب', raw: true, hidden: true,
    fn: () => DB.all(`SELECT * FROM contract_loading ORDER BY id`),
  },
  'contract-hedge-raw': {
    label: 'ربط العقود (خام)', desc: 'ورقة «الربط» — عمليات ربط البورصة', raw: true, hidden: true,
    fn: () => DB.all(`SELECT * FROM contract_hedge ORDER BY id`),
  },
  'contract-roll-raw': {
    label: 'رول العقود (خام)', desc: 'ورقة «الرول» — عمليات الترويل', raw: true, hidden: true,
    fn: () => DB.all(`SELECT * FROM contract_roll ORDER BY id`),
  },
  'contract-release-raw': {
    label: 'إفراج العقود (خام)', desc: 'ورقة «الافراج» — كميات الإفراج لكل مركب', raw: true, hidden: true,
    fn: () => DB.all(`SELECT * FROM contract_release ORDER BY id`),
  },
  'contract-external-sales-raw': {
    label: 'بيع خارجى (خام)', desc: 'ورقة «بيع خارجى» — مبيعات خارجية (فارغة في الملف الحالي)', raw: true, hidden: true,
    fn: () => DB.all(`SELECT * FROM contract_external_sales ORDER BY id`),
  },
  'contract-balances-raw': {
    label: 'أرصدة خامات العقود (خام)', desc: 'ورقة «الارصدة» — رصيد المصانع والموانى والتغطية', raw: true, hidden: true,
    fn: () => DB.all(`SELECT * FROM contract_balances ORDER BY id`),
  },
  'contract-items-raw': {
    label: 'أصناف العقود (خام)', desc: 'ورقة «البيانات» — جدول الأصناف', raw: true, hidden: true,
    fn: () => DB.all(`SELECT * FROM contract_items`),
  },
  'contract-suppliers-raw': {
    label: 'موردو العقود (خام)', desc: 'ورقة «البيانات» — جدول الموردين', raw: true, hidden: true,
    fn: () => DB.all(`SELECT * FROM contract_suppliers`),
  },
  'contract-ports-raw': {
    label: 'موانئ العقود (خام)', desc: 'ورقة «البيانات» — جدول الموانئ', raw: true, hidden: true,
    fn: () => DB.all(`SELECT * FROM contract_ports`),
  },
  'companies-raw': {
    label: 'الشركات (المصدر الموحد - خام)', desc: 'ورقة «البيانات» — جدول الشركات الموحّد', raw: true, hidden: true,
    fn: () => DB.all(`SELECT * FROM companies`),
  },
  /* ---------- صفحات Power BI لعقود الاستيراد (إعادة بناء داخل التطبيق) ---------- */
  'pbix-home': {
    label: '① الصفحة الرئيسية', desc: 'بطاقات: موقف ربط الخامات • الريت اليومى • عدد مراكب الذرة • قيمة المطلوب سداده',
    fn: F => A.contractPbixCards(F).then(o => [o]),
  },
  'pbix-hedge-position': {
    label: '🌾 موقف ربط وتغطية الخامات الرئيسية', desc: 'تصنيف × المدفوع بدون تسعير • المتبقى من الكمية المفتوحة • رصيد المصانع • رصيد التغطية • Position • عدد العقود • عدد الأيام',
    fn: F => A.contractHedgePosition(F),
  },
  'pbix-corn-vessels': {
    label: '③ تقرير مراكب الذرة — تفصيلى (Power BI)', desc: 'المصدر/المورد/الكمية/الشحن/قيمة الشحن/موقف التسعير/السعر CIF/الباخرة/موقف السداد/وصول متوقع/موقف المركب/صافي البريم',
    fn: F => A.contractCornVessels(F).then(r => r.rows),
  },
  'pbix-corn-summary': {
    label: '③ مراكب الذرة — ملخص حسب المصدر (Power BI)', desc: 'المصدر × كمية مراكب الذرة × عدد مراكب الذرة',
    fn: F => A.contractCornVessels(F).then(r => r.summary),
  },
  'pbix-docs-value': {
    label: '④ تقرير قيمة المستندات — تفصيلى (Power BI)', desc: 'المورد/التصنيف/متوقع سداد/حالة التجميع/كمية المطلوب سداده/سعر CIF المتوقع/قيمة المطلوب سداده',
    fn: F => A.contractDocsValue(F).then(r => r.rows),
  },
  'pbix-docs-class': {
    label: '④ قيمة المستندات حسب التصنيف (Power BI)', desc: 'التصنيف × إجمالي قيمة المطلوب سداده',
    fn: F => A.contractDocsValue(F).then(r => r.byClass),
  },
  'pbix-docs-month': {
    label: '④ قيمة المستندات حسب شهر السداد المتوقع (Power BI)', desc: 'شهر عربى سداد متوقع × إجمالي قيمة المطلوب سداده',
    fn: F => A.contractDocsValue(F).then(r => r.byMonth),
  },
  'pbix-priced-costs': {
    label: '⑤ تكلفة الخامات المسعرة (Power BI)', desc: 'التصنيف × الريت اليومى/السعر بالدولار/التكلفة الحالية/سعر السوق/الفرق',
    fn: F => A.contractPricedCosts(F),
  },
  'pbix-main-coverage': {
    label: '⑥ تغطية خامات رئيسية (Power BI)', desc: 'رصيد المصانع/رصيد متاح ميناء/مدفوعة وغير مفتوحة/مطلوب سدادها/تعاقدات/ما تم بيعه/إجمالى الرصيد/الاستهلاك/يكفى يوم',
    fn: F => A.contractMainCoverage(F),
  },
  'pbix-additives-coverage': {
    label: '⑦ تغطية الادوية والاضافات (Power BI)', desc: 'إجمالى الرصيد/ميناء إضافات/تعاقدات إضافات/الإجمالى الكلى/الاستهلاك/المتاح يكفى يوم حتى تاريخ',
    fn: F => A.contractAdditivesCoverage(F),
  },
  /* تسجيل العقود + تفصيلها في جدول واحد — خيار «تجميعى / تفصيلي» (بلا تكرار بيانات) */
  'contract-unified': {
    label: '⑧ عقود الاستيراد — تسجيل + تفصيل (موحّد)', desc: 'صف لكل عقد في «تجميعى»، وصف لكل بند تفصيلي (باخرة/ميناء وصول/شركات) في «تفصيلي»',
    fn: F => A.contractUnified(F),
  },
};
/* تقرير اصطناعي لاختبار مسار الاستيراد — في وضع الاختبار فقط (بلا قاعدة بيانات).
   لا يظهر ولا يعمل في التشغيل الفعلي. */
if (process.env.WORKFLOW_TEST_MODE === '1') {
  REPORTS['test-legacy'] = {
    label: 'تقرير اختباري (اصطناعي)',
    desc: 'مصدر ذاكرة اصطناعي — لاختبار استيراد تقرير قائم إلى المصمم دون أي اتصال بقاعدة البيانات',
    fn: () => {
      const f = W.syntheticFixture();
      return (f.sourceRows || []).map(r => ({ item: 'صنف ' + r.id, qty: r.qty, price: r.price, note: r.note }));
    },
  };
}

/* ---------- المسارات ---------- */
/* صف بورصة أو أرصدة يدوي يغيّر تكلفة يومه وما بعده → يُوسم المحرك ليعيد البناء من تاريخه */
const markCost = async r => {
  if (r && r.date && (r.cat === 'borse' || r.cat === 'balances')) await CE.markDirty(r.date);
};

  /* يحمّل تقريرًا محفوظًا + بيانات تشغيله (قراءة فقط) — مشترك بين المسارات */
  /* ---------- التقارير القديمة (31): تنفيذ + استخراج ---------- */
  let _legacyCodeCache = null;
  /** نصوص شيفرة التحليل وPower BI — لِلاستخراج الساكن فقط (قراءة ملفات) */
  function legacyCodeText() {
    if (_legacyCodeCache) return _legacyCodeCache;
    const read = f => { try { return fs.readFileSync(path.join(__dirname, f), 'utf8'); } catch (_) { return ''; } };
    _legacyCodeCache = { analytics: read('analytics.js'), pbix: read('pbix.js') };
    return _legacyCodeCache;
  }
  /** تنفيذ تقرير قديم بنفس دالة التطبيق (المصدر الحقيقي للأعمدة) */
  async function legacyRows(name, params) {
    const def = REPORTS[name];
    if (!def) return { error: 'تقرير غير معروف: ' + name };
    try {
      /* parseFilters يتوقّع كائن استعلام ⇒ نُبنيه من المعاملات المُمرَّرة */
      const src = (params && typeof params === 'object') ? params : {};
      const q = { get: k => (src[k] === undefined || src[k] === null ? '' : String(src[k])) };
      const F = A.parseFilters(q);
      const out = await def.fn(F);
      const rows = Array.isArray(out) ? out : (out && Array.isArray(out.rows) ? out.rows : []);
      return { rows };
    } catch (e) { return { error: (e && e.message) || String(e) }; }
  }
  /** أعمدة الصفوف (مفاتيح الصفوف) */
  function rowsColumns(rows) {
    const cols = [];
    const seen = new Set();
    for (const r of (rows || []).slice(0, 50)) {
      if (!r || typeof r !== 'object') continue;
      for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
    return cols;
  }
  /** بيانات تقرير قديم بشكل بيانات التشغيل (للتصيير في المحرك) */
  async function legacyData(name, params) {
    const r = await legacyRows(name, params);
    if (r.error) return { error: r.error };
    return { columns: rowsColumns(r.rows), rows: r.rows, formulaColumns: {}, traced: false, legacy: name };
  }

  /** مصدر نتيجة تشغيل محفوظة — قابل للقراءة كصفوف (Phase 2) */
  function outputSourceData(sourceName) {
    const runId = String(sourceName || '').replace(/^output:/, '').replace(/[^A-Za-z0-9_\-]/g, '');
    if (!runId) return { ok: false, status: 400, error: 'معرّف نتيجة التشغيل مطلوب' };
    const out = W.loadOutput(runId, WF_ROOT);
    if (!out) return { ok: false, status: 404, error: 'نتيجة التشغيل غير موجودة: ' + runId };
    const rows = Array.isArray(out.rows) ? out.rows : [];
    const columns = Array.isArray(out.columns) && out.columns.length ? out.columns : (rows.length ? Object.keys(rows[0]) : []);
    const types = W.colTypes(rows);
    const label = 'نتيجة سابقة — ' + runId + (out.workflowName ? ' · ' + out.workflowName : '');
    const notes = ['المصدر: نتيجة تشغيل محفوظة ' + runId + (out.workflowName ? ' («' + out.workflowName + '»)' : '')];
    if (out.definitionChanged) notes.push('تعريف التحليل تغيّر بعد هذا التشغيل — النتيجة محفوظة كما كانت عند التنفيذ');
    return {
      ok: true, status: 200,
      data: {
        name: 'output:' + runId, label, columns,
        fields: columns.map(c => ({ name: c, type: types[c] || 'string', description: '' })),
        sample: rows.slice(0, 8),
      },
      rows, columns, notes,
      source: { name: 'output:' + runId, label, domain: 'outputs', grain: 'صفوف نتيجة محفوظة', canonical: false },
      runId, truncated: false,
    };
  }

  /** وصف موحّد لأي مصدر: synthetic / dataset / file / workbook / output */
  async function sourceInfo(name, me) {
    const sid = String(name || '').trim();
    if (sid.indexOf('output:') === 0) return outputSourceData(sid);
    if (sid.indexOf('file:') === 0) {
      const r = await D.resolveFileSource({ type: 'file', name: sid.slice(5) });
      if (!r.ok) return r;
      return {
        ok: true, status: 200,
        data: {
          name: sid,
          label: (r.source && r.source.label) || sid,
          columns: r.columns, fields: r.fields, sample: r.sample,
        },
        notes: r.notes, source: r.source, truncated: r.truncated,
      };
    }
    if (sid.indexOf('workbook:') === 0) {
      const r = await D.resolveWorkbookSource({ type: 'workbook', name: sid.slice(9) }, me);
      if (!r.ok) return r;
      return {
        ok: true, status: 200,
        data: {
          name: sid,
          label: (r.source && r.source.label) || sid,
          columns: r.columns, fields: r.fields, sample: r.sample,
        },
        notes: r.notes, source: r.source, truncated: r.truncated,
      };
    }
    return D.sourceColumns(sid, me);
  }

  /** طرف ثانٍ للربط/الاتحاد/المقارنة — مصدر فهرس أو ملف أو نتيجة محفوظة */
  async function resolveRightSource(name, me, srcSt) {
    const sid = String(name || '').trim();
    if (sid.indexOf('output:') === 0) {
      const r = outputSourceData(sid);
      if (!r.ok) return r;
      return {
        ok: true, status: 200, rows: r.rows, columns: r.columns,
        label: r.source.label, grain: r.source.grain, limit: null, truncated: false,
      };
    }
    if (sid.indexOf('file:') === 0) {
      const r = await D.resolveFileSource({ type: 'file', name: sid.slice(5) });
      if (!r.ok) return r;
      return {
        ok: true, status: 200, rows: r.rows, columns: r.columns,
        label: r.source.label, grain: r.source.grain, limit: r.limit, truncated: r.truncated,
      };
    }
    if (sid.indexOf('workbook:') === 0) {
      const r = await D.resolveWorkbookSource({ type: 'workbook', name: sid.slice(9) }, me);
      if (!r.ok) return r;
      return {
        ok: true, status: 200, rows: r.rows, columns: r.columns,
        label: r.source.label, grain: r.source.grain, limit: r.limit, truncated: r.truncated,
      };
    }
    return D.resolveJoinSource(sid, me, srcSt);
  }

  function sendRunFailure(res, result) {
    const trace = (result && result.trace) || [];
    const failed = trace.find(t => t && t.status === 'failed');
    return send(res, 400, {
      ok: false,
      error: (result && result.error) || 'فشل التنفيذ',
      trace,
      failedStep: failed ? failed.id : null,
    });
  }

  /** قائمة مخرجات التشغيل (مشتركة بين المسارات) + مقارنة البصمة بالتعريف الحالي */
  function listOutputs() {
    const dir = path.join(WF_ROOT, '_outputs');
    const wfCache = new Map();
    const currentHash = (wid) => {
      if (!wid) return null;
      if (wfCache.has(wid)) return wfCache.get(wid);
      let h = null;
      try {
        const wf = W.loadWorkflow(wid, WF_ROOT);
        if (wf) h = W.definitionHash(W.definitionSnapshot(wf));
      } catch (_) { h = null; }
      wfCache.set(wid, h);
      return h;
    };
    if (!fs.existsSync(dir)) return { items: [] };
    /* بصمة محرّك المعادلات الحالية — تُحسب مرة واحدة لكل القائمة */
    const curEngineHash = FormulaEngine.formulaEngineHash();
    const items = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
      try {
        const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return {
          runId: o.runId, rowCount: o.rowCount, columns: o.columns, savedAt: o.savedAt,
          source: o.source || null, workflowName: o.workflowName || '', workflowId: o.workflowId || '',
          traced: !!o.definition, definitionHash: o.definitionHash || null,
          stepCount: (o.definition && o.definition.steps) ? o.definition.steps.length : 0,
          filters: (o.definition && o.definition.source && o.definition.source.settings) ? o.definition.source.settings : null,
          definitionChanged: (o.definition && currentHash(o.workflowId)) ? (currentHash(o.workflowId) !== o.definitionHash) : null,
          engineVersion: o.engineVersion || null,
          engineHash: o.engineHash || null,
          engineState: !o.engineHash ? 'unknown' : (o.engineHash === curEngineHash ? 'same' : 'changed'),
          currentEngineVersion: FormulaEngine.FORMULA_ENGINE_VERSION,
          currentEngineHash: curEngineHash,
          warnings: o.warnings || [], sourceNotes: o.sourceNotes || [],
          joinCompleteness: o.joinCompleteness || null,
        };
      } catch (_) { return null; }
    }).filter(Boolean);
    return { items };
  }

  function reportWithData(id) {
    const rep = RS.loadReport(id, REPORTS_ROOT);
    if (!rep) return null;
    const data = runData(rep.runId);
    return { report: rep, data };
  }

  /** بيانات نتيجة تشغيل محفوظة (مع خريطة أعمدة المعادلات وبيانات التتبّع) */
  function runData(runId) {
    const out = runId ? W.loadOutput(runId, WF_ROOT) : null;
    if (!out) return { columns: [], rows: [], formulaColumns: {}, traced: false };
    return {
      columns: out.columns || [],
      rows: out.rows || [],
      formulaColumns: out.formulaColumns || {},
      formulaVersions: out.formulaVersions || {},
      traced: !!out.definition,
      definitionHash: out.definitionHash || null,
      savedAt: out.savedAt || '',
      source: out.source || null,
      workflowName: out.workflowName || '',
      engineVersion: out.engineVersion || null,
      engineHash: out.engineHash || null,
      warnings: out.warnings || [],
      joinCompleteness: out.joinCompleteness || null,
    };
  }

  /* حلّ مراجع المعادلات — في src/formula-resolver.js (طبقة نقية قابلة للاختبار) */
  const resolveWorkflowFormulas = (wf, data) => FRes.resolveWorkflowFormulas(wf, FORMULA_ROOT, data);
  const resolveReportFormulas = (report, data) => FRes.resolveReportFormulas(report, data);

const routes = {
  /* ===== المصادقة والمستخدمون ===== */
  'GET /api/auth/login-info': async (q, res) => {
    if (process.env.WORKFLOW_TEST_MODE === '1') {
      return ok(res, {
        firstLogin: false,
        roles: Object.entries(Auth.ROLES).map(([id, v]) => ({ id, label: v.label, perms: v.perms })),
      });
    }
    const r = await DB.get(`SELECT EXISTS(SELECT 1 FROM users WHERE username = 'admin' AND must_change) AS x`);
    ok(res, {
      firstLogin: !!r.x,
      roles: Object.entries(Auth.ROLES).map(([id, v]) => ({ id, label: v.label, perms: v.perms })),
    });
  },

  'POST /api/auth/login': async (q, res, body, req) => {
    const username = String((body && body.username) || '').trim();
    const password = String((body && body.password) || '');
    if (!username || !password) return bad(res, 'أدخل اسم المستخدم وكلمة المرور');
    const ip = (req.socket && req.socket.remoteAddress) || '';
    const lockKey = `${ip}|${username.toLowerCase()}`;
    const wait = Auth.locked(lockKey);
    if (wait) return bad(res, `محاولات فاشلة كثيرة — أعد المحاولة بعد ${wait} ثانية`, 429);

    const u = await DB.get('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (!u || !u.active || !Auth.verifyPassword(password, u.salt, u.password_hash)) {
      Auth.badAttempt(lockKey);
      return bad(res, 'اسم المستخدم أو كلمة المرور غير صحيحة', 401);
    }
    Auth.goodAttempt(lockKey);
    const { token, expires } = await Auth.createSession(u, ip, req.headers['user-agent']);
    await DB.run('UPDATE users SET last_login = now() WHERE id = $1', [u.id]);
    ok(res, { user: await pubUser(u), expires }, { 'Set-Cookie': sessionCookie(token) });
  },

  'GET /api/auth/me': async (q, res, body, req) => {
    if (process.env.WORKFLOW_TEST_MODE === '1') {
      const testUser = {
        id: 0, username: 'workflow-test', full_name: 'Workflow Test (TEST MODE)',
        role: 'admin', roleLabel: 'مدير', mustChange: false,
        perms: (Auth.ROLES.admin && Auth.ROLES.admin.perms) || [],
        tabs: TAB_IDS.slice(),
      };
      return ok(res, { user: testUser });
    }
    const s = await Auth.getSession(Auth.readCookie(req, Auth.COOKIE));
    if (!s) return bad(res, 'انتهى الجلسة — سجّل الدخول', 401);
    ok(res, { user: await pubUser(s) });
  },

  'POST /api/auth/logout': async (q, res, body, req) => {
    await Auth.destroySession(Auth.readCookie(req, Auth.COOKIE));
    ok(res, { done: true }, { 'Set-Cookie': `${Auth.COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
  },

  'POST /api/auth/change-password': async (q, res, body, req, me) => {
    const oldPw = String((body && body.old) || '');
    const newPw = String((body && body.password) || '');
    if (newPw.length < 6) return bad(res, 'كلمة المرور الجديدة: 6 أحرف على الأقل');
    const u = await DB.get('SELECT * FROM users WHERE id = $1', [me.id]);
    // عند أول دخول (must_change) لا يُطلب الحالية
    if (!u.must_change && !Auth.verifyPassword(oldPw, u.salt, u.password_hash))
      return bad(res, 'كلمة المرور الحالية غير صحيحة', 401);
    const { salt, hash } = Auth.hashPassword(newPw);
    await DB.run(`UPDATE users SET password_hash = $1, salt = $2, must_change = FALSE, updated_at = now()
                  WHERE id = $3`, [hash, salt, u.id]);
    ok(res, { done: true });
  },

  /* ---------- صلاحيات الشاشات (يضبطها المدير لكل مستخدم على حدة) ---------- */
  'GET /api/tabs': async (q, res, body, req, me) => {
    /* وضع الاختبار: بلا قاعدة بيانات ⇒ لا قائمة مستخدمين (التبويبات فقط) */
    if (process.env.WORKFLOW_TEST_MODE === '1') return ok(res, { tabs: allTabs(), users: [], perms: {} });
    const users = await Auth.listUsers();
    const perms = {};
    const all = allTabs().map(t => t.id);
    for (const u of users) perms[u.id] = u.role === 'admin' ? all : tabsOfUser(u);
    ok(res, { tabs: allTabs(), users: users.map(u => ({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, roleLabel: Auth.roleLabel(u.role) })), perms });
  },

  'POST /api/tabs/save': async (q, res, body, req, me) => {
    const src = (body && body.perms) || {};
    const users = await Auth.listUsers();
    const byId = new Map(users.map(u => [u.id, u]));
    const KNOWN = allTabs().map(t => t.id);
    for (const [idKey, arr] of Object.entries(src)) {
      const uid = Number(idKey);
      const u = byId.get(uid);
      if (!u) continue;                                   // مستخدم غير معروف → تجاهُل
      if (u.role === 'admin') continue;                   // المدير يملك كل الشاشات دائماً
      /* ترشيح صارم ضد أي معرّفات شاشات غير معروفة */
      const clean = KNOWN.filter(t => (Array.isArray(arr) ? arr : []).map(String).includes(t));
      await DB.run('UPDATE users SET tabs = $1, updated_at = now() WHERE id = $2',
        [JSON.stringify(clean), uid]);
    }
    const users2 = await Auth.listUsers();
    const perms = {};
    const all = allTabs().map(t => t.id);
    for (const u of users2) perms[u.id] = u.role === 'admin' ? all : tabsOfUser(u);
    ok(res, { perms });
  },

  /* ---------- البيانات الأساسية: الأصناف (المجموعة والتصنيف أعمدة داخل items) ---------- */
  'GET /api/md/items': check(async (q, res) =>
    ok(res, await M.listItems({
      origin: q.get('origin'), q: q.get('q'), limit: q.get('limit'),
      group: q.get('group'), cls: q.get('cls'),
      groupFrom: q.get('group_from'), groupTo: q.get('group_to'),
      clsFrom: q.get('cls_from'), clsTo: q.get('cls_to'),
      clsState: q.get('clsstate'),
    }))),

  /* قائمة الأصناف الموحدة (قراءة فقط) — لأي مستخدم مسجل مهما كانت شاشاته.
     تستخدمها قوائم الاختيار في كل التقارير والإدخالات والفلاتر (بالقيمة الكود). */
  'GET /api/items/all': check(async (q, res) =>
    ok(res, await M.listItems({ limit: q.get('limit') || 20000 }))),

  'POST /api/md/items/save': check(async (q, res, body) => ok(res, await M.saveItem(body || {}))),

  'POST /api/md/items/delete': check(async (q, res, body) => ok(res, await M.deleteItem(body || {}))),

  /* قوائم الكتالوج (تُستخدم أيضاً لملء القوائم المنسدلة في نموذج الصنف) */
  'GET /api/md/items/groups': check(async (q, res) => ok(res, await M.listGroups())),

  'POST /api/md/items/groups/save': check(async (q, res, body) => ok(res, await M.saveGroup(body || {}))),

  'POST /api/md/items/groups/delete': check(async (q, res, body) => ok(res, await M.deleteGroup(body || {}))),

  'GET /api/md/items/classes': check(async (q, res) => ok(res, await M.listClasses())),

  'POST /api/md/items/classes/save': check(async (q, res, body) => ok(res, await M.saveClass(body || {}))),

  'POST /api/md/items/classes/delete': check(async (q, res, body) => ok(res, await M.deleteClass(body || {}))),

  /* ---------- البيانات الأساسية: المواقع والمصانع (شركة ← وحدة ← مخزن) ---------- */
  'GET /api/md/locs': check(async (q, res) => ok(res, await M.listLocations())),

  'POST /api/md/locs/company/save': check(async (q, res, body) => ok(res, await M.saveCompany(body || {}))),

  'POST /api/md/locs/company/delete': check(async (q, res, body) => ok(res, await M.deleteCompany(body || {}))),

  'POST /api/md/locs/unit/save': check(async (q, res, body) => ok(res, await M.saveUnit(body || {}))),

  'POST /api/md/locs/unit/delete': check(async (q, res, body) => ok(res, await M.deleteUnit(body || {}))),

  'POST /api/md/locs/warehouse/save': check(async (q, res, body) => ok(res, await M.saveWarehouse(body || {}))),

  'POST /api/md/locs/warehouse/delete': check(async (q, res, body) => ok(res, await M.deleteWarehouse(body || {}))),
  'POST /api/md/locs/warehouse/report-active': check(async (q, res, body) => ok(res, await M.setWarehouseReportActive((body || {}).code, (body || {}).active))),

  /* ---------- البيانات الأساسية: أنواع الحركات ---------- */
  'GET /api/md/mtypes': check(async (q, res) => ok(res, await M.listMtypes({ q: q.get('q'), catFrom: q.get('cat_from'), catTo: q.get('cat_to') }))),

  'POST /api/md/mtypes/save': check(async (q, res, body) => ok(res, await M.saveMtype(body || {}))),

  'POST /api/md/mtypes/delete': check(async (q, res, body) => ok(res, await M.deleteMtype(body || {}))),

  'GET /api/md/mtypes/categories': check(async (q, res) => ok(res, await M.listCategories())),

  'POST /api/md/mtypes/category/save': check(async (q, res, body) => ok(res, await M.saveCategory(body || {}))),

  'POST /api/md/mtypes/category/delete': check(async (q, res, body) => ok(res, await M.deleteCategory(body || {}))),

  /* ---------- البيانات الأساسية: مراجع عقود الاستيراد (موردين/مصادر/موانئ) ---------- */
  'GET /api/md/refs': check(async (q, res) => ok(res, await M.listRefs(q.get('kind')))),

  'POST /api/md/refs/save': check(async (q, res, body) => ok(res, await M.saveRef(body || {}))),

  'POST /api/md/refs/delete': check(async (q, res, body) => ok(res, await M.deleteRef(body || {}))),

  /* كل القوائم المرجعية دفعة واحدة — تغذّي القوائم المنسدلة في نماذج العقود */
  'GET /api/contracts/refs': check(async (q, res) => ok(res, await M.listAllRefs())),

  'GET /api/users': async (q, res) => ok(res, await Auth.listUsers()),

  'POST /api/users': async (q, res, body, req, me) => {
    const username = String((body && body.username) || '').trim();
    const fullName = String((body && body.full_name) || '').trim();
    const password = String((body && body.password) || '');
    const role = String((body && body.role) || 'viewer');
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username))
      return bad(res, 'اسم المستخدم: من 3 إلى 30 حرفاً (أحرف إنجليزية وأرقام _ - .)');
    if (password.length < 6) return bad(res, 'كلمة المرور: 6 أحرف على الأقل');
    if (!Auth.isRole(role)) return bad(res, 'دور غير معروف');
    const ex = await DB.get('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (ex) return bad(res, 'اسم المستخدم مستخدم من قبل');
    const pw = Auth.hashPassword(password);
    const r = await DB.run(
      `INSERT INTO users(username, full_name, password_hash, salt, role, must_change)
       VALUES($1,$2,$3,$4,$5,FALSE) RETURNING id`,
      [username, fullName || null, pw.hash, pw.salt, role]);
    ok(res, { id: r.lastInsertRowid });
  },

  'POST /api/users/update': async (q, res, body, req, me) => {
    const id = Number(body && body.id);
    if (!id) return bad(res, 'حدد المستخدم');
    const t = await DB.get('SELECT * FROM users WHERE id = $1', [id]);
    if (!t) return bad(res, 'المستخدم غير موجود', 404);
    const self = id === me.id;

    const sets = [], params = [];
    const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (body.full_name !== undefined) push('full_name', String(body.full_name).trim() || null);
    if (body.role !== undefined) {
      const role = String(body.role);
      if (!Auth.isRole(role)) return bad(res, 'دور غير معروف');
      if (self && role !== t.role) return bad(res, 'لا يمكنك تغيير دورك أنت');
      if (t.role === 'admin' && role !== 'admin' && await Auth.countRole('admin') <= 1)
        return bad(res, 'يجب أن يبقى هناك مدير واحد على الأقل');
      push('role', role);
    }
    if (body.active !== undefined) {
      const active = !!body.active;
      if (self && !active) return bad(res, 'لا يمكنك تعطيل حسابك أنت');
      if (t.role === 'admin' && !active && await Auth.countRole('admin') <= 1)
        return bad(res, 'يجب أن يبقى هناك مدير واحد على الأقل');
      push('active', active);
      if (!active) await Auth.destroyUserSessions(id);
    }
    if (body.password) {
      if (String(body.password).length < 6) return bad(res, 'كلمة المرور: 6 أحرف على الأقل');
      const { salt, hash } = Auth.hashPassword(String(body.password));
      sets.push(`password_hash = $${params.push(hash)}`, `salt = $${params.push(salt)}`, 'must_change = TRUE');
      await Auth.destroyUserSessions(id);
    }
    if (!sets.length) return bad(res, 'لا توجد تغييرات');
    params.push(id);
    await DB.run(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
    ok(res, { done: true });
  },

  'POST /api/users/delete': async (q, res, body, req, me) => {
    const id = Number(body && body.id);
    if (!id) return bad(res, 'حدد المستخدم');
    if (id === me.id) return bad(res, 'لا يمكنك حذف حسابك أنت');
    const t = await DB.get('SELECT * FROM users WHERE id = $1', [id]);
    if (!t) return bad(res, 'المستخدم غير موجود', 404);
    if (t.role === 'admin' && await Auth.countRole('admin') <= 1)
      return bad(res, 'يجب أن يبقى هناك مدير واحد على الأقل');
    await Auth.destroyUserSessions(id);
    await DB.run('DELETE FROM users WHERE id = $1', [id]);
    ok(res, { done: true });
  },

  'GET /api/health': async (q, res) => ok(res, { ...(await DB.info()), now: new Date().toISOString() }),

  'GET /api/dims': async (q, res) => ok(res, await A.dims(q)),

  /* تقرير شاشة المبيعات اليومية: تفصيلي/صنف/مكان/شركة/عميل — بدون التكلفة + قيمة البيع للوحدة */
  'GET /api/sales/day': async (q, res) => ok(res, await A.salesDaily(A.parseFilters(q), q.get('by') || 'detail', q.get('by2') || '', q.get('per') || '', Number(q.get('limit') || 20000))),

  /* طريقة ربط التكلفة بالمبيعات (المستند المرجع + الصنف / المكان) */
  'POST /api/settings/cost': check(async (q, res, body) => {
    const r = await A.setCostLink((body && body.link) || '');
    ok(res, r);
  }),

  'GET /api/movements/report': async (q, res) => ok(res, await A.movementsReport(A.parseFilters(q), q.get('by') || 'detail', q.get('by2') || '', q.get('per') || '', Number(q.get('limit') || 2000))),

  'GET /api/inventory/report': async (q, res) => ok(res, await A.inventoryReport(A.parseFilters(q), q.get('by') || 'detail', q.get('by2') || '', q.get('per') || '', Number(q.get('limit') || 20000))),
  'GET /api/span': async (q, res) => ok(res, await A.dateSpan()),
  'GET /api/formulas': async (q, res) => ok(res, { items: F.listFunctions() }),

  /* ---------- مصادر بيانات Workflow Studio: وصف فقط (قراءة، بلا جلب) ---------- */
  'GET /api/datasets': async (q, res) => ok(res, { items: D.listSources() }),
  'GET /api/datasets/fields': async (q, res, body, req, me) => {
    const name = String(q.get('name') || '').trim();
    if (!name) return bad(res, 'name required');
    const r = await sourceInfo(name, me);
    if (!r.ok) return bad(res, r.error, r.status || 400);
    ok(res, r.data);
  },
  'GET /api/datasets/files': async (q, res) => {
    const r = D.listFileSources();
    ok(res, { items: r.items, root: r.root, testOnly: true });
  },
  'GET /api/datasets/workbooks': async (q, res, body, req, me) => {
    const r = D.listWorkbookSources(me);
    ok(res, {
      items: r.items,
      configured: !!r.configured,
      denied: !!r.denied,
      status: r.status || (r.configured ? 'ready' : 'unset'),
      reason: r.reason || '',
      fileCount: r.fileCount || 0,
      sheetCount: r.sheetCount || (r.items || []).length,
      root: r.root || null,
      readOnly: true,
      testOnly: process.env.WORKFLOW_TEST_MODE === '1',
    });
  },
  'GET /api/datasets/workbooks/diagnostics': async (q, res, body, req, me) => {
    const r = D.workbookDiagnostics(me);
    ok(res, r);
  },

  /* ---------- فهرس البيانات الموحّد + قاموس المعادلات + مستكشف العلاقات ---------- */
  'GET /api/catalog': async (q, res) => ok(res, {
    summary: CAT.summary(),
    domains: CAT.DOMAINS,
    statuses: CAT.STATUS,
    sources: CAT.listSources(),
  }),
  'GET /api/catalog/source': async (q, res, body, req, me) => {
    const name = String(q.get('name') || '').trim();
    if (!name) return bad(res, 'name required');
    const src = CAT.getSource(name);
    if (!src) return bad(res, 'مصدر غير موجود في الفهرس: ' + name, 404);
    const r = await D.sourceColumns(name, me);
    const sample = r && r.ok ? (r.data.sample || []) : [];
    const fields = (r && r.ok ? r.data.fields : src.fields.map(f => ({ name: f.name, type: f.type, description: f.description, origin: f.origin })));
    ok(res, {
      id: src.id, label: src.label, technical: src.technical, domain: src.domain, description: src.description,
      status: src.status, perm: src.perm, grain: src.grain, rowKey: src.rowKey, timeGrain: src.timeGrain,
      canonical: !!src.canonical, canonicalFor: src.canonicalFor || null, canonicalNote: src.canonicalNote || null,
      access: src.access || null, fields, sample, relations: src.relations,
    });
  },
  'GET /api/model/formulas': async (q, res) => {
    const opts = {};
    const domain = q.get('domain'); if (domain) opts.domain = domain;
    const status = q.get('status'); if (status) opts.status = status;
    const table = q.get('table'); if (table) opts.table = table;
    ok(res, {
      items: ME.formulas(opts),
      summary: ME.summary(),
      importedVsComputed: ME.IMPORTED_VS_COMPUTED,
      balanceConversions: ME.BALANCE_CONVERSIONS,
    });
  },
  'GET /api/model/relations': async (q, res) => ok(res, { items: ME.relations() }),
  'GET /api/model/fields': async (q, res) => {
    const name = String(q.get('source') || '').trim();
    if (!name) return bad(res, 'source required');
    const rows = ME.fields(name);
    if (!rows.length) return bad(res, 'مصدر غير موجود في الفهرس: ' + name, 404);
    ok(res, { items: rows });
  },
  /* ---------- سجل الشاشات والتقارير ومصادرها ---------- */
  'GET /api/screens': async (q, res) => ok(res, {
    summary: SR.summary(),
    screens: SR.screensWithSources(),
    reports: SR.listReports(),
  }),

  /* ---------- الشاشات المخصّصة (مصمم الشاشات) ---------- */
  'GET /api/screens/custom': async (q, res) => ok(res, {
    items: ScreenStore.listScreens(SCREENS_ROOT),
  }),
  'GET /api/screens/custom/get': async (q, res) => {
    const id = String(q.get('id') || '').trim();
    if (!id) return bad(res, 'id required');
    const sc = ScreenStore.loadScreen(id, SCREENS_ROOT);
    if (!sc) return bad(res, 'not found', 404);
    ok(res, sc);
  },
  'POST /api/screens/custom/save': async (q, res, body) => {
    const def = body && body.screen;
    if (!def || typeof def !== 'object') return bad(res, 'screen required');
    const norm = AppScreen.normalizeScreen(def);
    /* التحقق من الروابط: مصدر البيانات يجب أن يكون تشغيلًا محفوظًا فعليًا */
    const runs = listOutputs();
    const v = AppScreen.validateScreen(norm, {
      runs: (runs.items || []).map(r => ({ runId: r.runId, columns: r.columns || [] })),
    });
    if (!v.ok) return bad(res, 'تعريف الشاشة غير صالح: ' + v.errors.join(' · '), 400);
    const r = ScreenStore.saveScreen(norm, SCREENS_ROOT, { reservedIds: TAB_IDS });
    if (r.error) return bad(res, r.error, 400);
    ok(res, { id: r.id, screen: r.screen });
  },
  'POST /api/screens/custom/delete': async (q, res, body) => {
    const id = String((body && body.id) || '').trim();
    if (!id) return bad(res, 'id required');
    if (!ScreenStore.deleteScreen(id, SCREENS_ROOT)) return bad(res, 'not found', 404);
    ok(res, { deleted: id });
  },

  /* ---------- Workflow Studio (MVP) ---------- */
  'GET /api/workflows': async (q, res) => {
    const list = W.listWorkflows(WF_ROOT);
    ok(res, { items: list });
  },
  'GET /api/workflows/get': async (q, res) => {
    const id = String(q.get('id') || '').trim().replace(/[^A-Za-z0-9_\-]/g, '');
    if (!id) return bad(res, 'id required');
    const wf = W.loadWorkflow(id, WF_ROOT);
    if (!wf) return bad(res, 'not found', 404);
    /* تحليل قديم بلا رسم: نشتق رسمًا للعرض فقط (ولا يُحفظ إلا إذا أعاد المستخدم الحفظ).
       هذا يجعل كل التحليلات المحفوظة قابلة للفتح في المحرّر المرئي. */
    if (!wf.graph) {
      wf.graph = WG.deriveGraphFromWorkflow(wf);
      wf.graphDerived = true;
      wf.graphSchemaVersion = WG.GRAPH_SCHEMA_VERSION;
    }
    ok(res, wf);
  },
  /* ---------- مركز العمل: تجميع حالة المنصة من مصادر فعلية ---------- */
  'GET /api/workcenter': async (q, res) => {
    const outputs = listOutputs();
    const [catalogSum, modelSum, screensSum] = await Promise.all([
      Promise.resolve(CAT.summary()),
      Promise.resolve(ME.summary()),
      Promise.resolve(SR.summary()),
    ]);
    ok(res, WC.buildWorkCenter({
      runs: outputs.items,
      reports: RS.listReports(REPORTS_ROOT),
      formulas: FS.listFormulas(FORMULA_ROOT),
      catalog: catalogSum,
      model: modelSum,
      screens: screensSum,
      savedScreens: ScreenStore.listScreens(SCREENS_ROOT),
    }));
  },
  'GET /api/workflows/outputs': async (q, res) => ok(res, listOutputs()),
  'GET /api/workflows/output': async (q, res) => {
    const id = String(q.get('id') || '').trim().replace(/[^A-Za-z0-9_\-]/g, '');
    if (!id) return bad(res, 'id required');
    const out = W.loadOutput(id, WF_ROOT);
    if (!out) return bad(res, 'output not found', 404);
    /* بصمة/إصدار المحرّك الحاليان ⇒ تستطيع الواجهة تبيّن تغيّر المحرّكsince التشغيل */
    ok(res, Object.assign({}, out, {
      currentEngineVersion: FormulaEngine.FORMULA_ENGINE_VERSION,
      currentEngineHash: FormulaEngine.formulaEngineHash(),
    }));
  },
  'GET /api/workflows/output/csv': async (q, res) => {
    const id = String(q.get('id') || '').trim().replace(/[^A-Za-z0-9_\-]/g, '');
    if (!id) return bad(res, 'id required');
    const out = W.loadOutput(id, WF_ROOT);
    if (!out) return bad(res, 'output not found', 404);
    const rows = Array.isArray(out.rows) ? out.rows : [];
    const csv = Csv.safeToCsv(rows);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="workflow-${id}.csv"`,
      'Content-Length': Buffer.byteLength(csv),
    });
    return res.end(csv);
  },
  'GET /report-schema.js': async (q, res) => {
    const p = path.join(__dirname, 'report-schema.js');
    if (!fs.existsSync(p)) return bad(res, 'schema not found', 404);
    const buf = fs.readFileSync(p);
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' });
    return res.end(buf);
  },
  'GET /formula-builder.js': async (q, res) => {
    const p = path.join(__dirname, 'formula-builder.js');
    if (!fs.existsSync(p)) return bad(res, 'builder not found', 404);
    const buf = fs.readFileSync(p);
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' });
    return res.end(buf);
  },
  /* نموذج الشاشات المخصّصة — نفس الملف الذي يخدمه Node (مصدر حقيقة واحد) */
  'GET /app-screen.js': async (q, res) => {
    const p = path.join(__dirname, 'app-screen.js');
    if (!fs.existsSync(p)) return bad(res, 'screen model not found', 404);
    const buf = fs.readFileSync(p);
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' });
    return res.end(buf);
  },
  /* فهرس العلاقات بين المصادر/المعادلات/التحليلات/التقارير/الشاشات
     (ملف عام في public/ — يُخدَم ثابتًا بلا حاجة لإعادة تشغيل الخادم) */
  'GET /workspace-links.js': async (q, res) => {
    const p = path.join(PUBLIC, 'workspace-links.js');
    if (!fs.existsSync(p)) return bad(res, 'workspace links not found', 404);
    const buf = fs.readFileSync(p);
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' });
    return res.end(buf);
  },
  /* الشاشات الثلاث للمنصة — مصدر واحد للحقيقة (src/platform-screens.js) يُخدَم للمتصفح */
  'GET /platform-screens.js': async (q, res) => {
    const body = '/* الشاشات الثلاث لمنصة التحليل — مولَّدة من src/platform-screens.js (مصدر واحد للحقيقة) */\n'
      + 'window.PlatformScreens = ' + JSON.stringify(PLATFORM.describe(), null, 1) + ';\n';
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' });
    return res.end(body);
  },
  /* فهرس الشاشات الثلاث (JSON) — للقراءة من الاختبارات والأدوات */
  'GET /api/platform/screens': async (q, res) => ok(res, PLATFORM.describe()),
  'GET /api/reports/saved': async (q, res) => {
    /* مستند إعدادات الواجهة العام ليس تقريرًا ⇒ لا يظهر في قائمة التقارير */
    const items = RS.listReports(REPORTS_ROOT).filter(r => r.id !== 'ui-layout');
    ok(res, { items });
  },
  'GET /api/reports/get': async (q, res) => {
    const id = String(q.get('id') || '').trim();
    if (!id) return bad(res, 'id required');
    const rep = RS.loadReport(id, REPORTS_ROOT);
    if (!rep) return bad(res, 'not found', 404);
    ok(res, rep);
  },
  'POST /api/reports/save': async (q, res, body, req, me) => {
    const rep = body && body.report;
    if (!rep || typeof rep !== 'object') return bad(res, 'report required');
    /* الإعدادات العامة (شاشات/قوائم/أزرار) ⇒ إعدادات لكل المستخدمين ⇒ تتطلّب صلاحية master */
    if (String(rep.id || '') === 'ui-layout') {
      /* في الإنتاج comes the session user; in TEST_MODE (public routes) the effective user is the test admin */
      const effective = me || (process.env.WORKFLOW_TEST_MODE === '1' ? { role: 'admin', active: true } : null);
      const allowed = (effective && effective.role === 'admin') || (typeof Auth.can === 'function' && Auth.can(effective, 'master'));
      if (!allowed) return bad(res, 'تعديل إعدادات التطبيق العامة يتطلّب صلاحية «مدير البيانات»', 403);
      if (!rep.settingsVersion) rep.settingsVersion = 1;
      try {
        const UILV = require('./ui-layout-validation');
        const v = UILV.validate(rep.ui);
        if (!v.ok) return bad(res, 'تخطيط الواجهة غير صالح: ' + v.errors.join(' · '), 400);
      } catch (_) {}
    }
    /* تحقق النموذج الموحّد أولًا (مصدر · تخطيط · نمط · شروط) ثم محرك Python */
    const sv = Schema.validateReport(rep);
    if (!sv.ok) return bad(res, 'تعريف التقرير غير صالح: ' + sv.errors.join(' · '), 400);
    const v = await R.validateReport(rep);
    if (!v.ok) return bad(res, v.error || 'invalid report', 400);
    const r = RS.saveReport(rep, REPORTS_ROOT);
    if (r.error) return bad(res, r.error, 400);
    ok(res, { id: r.id });
  },
  'POST /api/reports/render': async (q, res, body) => {
    const rep = body && body.report;
    const id = body && body.id ? String(body.id).trim().replace(/[^A-Za-z0-9_\-]/g, '') : '';
    let report = rep;
    let runId = body && body.runId;
    if (!report && id) {
      const p2 = path.join(__dirname, '..', 'data', 'reports', id + '.json');
      if (!fs.existsSync(p2)) return bad(res, 'report not found', 404);
      try { report = JSON.parse(fs.readFileSync(p2, 'utf8')); }
      catch (e) { return bad(res, 'corrupt report', 500); }
    }
    if (!report) return bad(res, 'report required');
    /* مصدر البيانات: نتيجة تشغيل محفوظة، أو تقرير قائم من التطبيق */
    const legacyName = (body && body.legacy && body.legacy.name)
      || (report.legacy && report.legacy.name) || '';
    let data;
    if (legacyName) {
      const ld = await legacyData(legacyName, (body && body.legacy && body.legacy.params) || (report.legacy && report.legacy.params));
      if (ld.error) return bad(res, 'تعذّر تنفيذ التقرير الأصلي: ' + ld.error, 400);
      data = ld;
    } else {
      if (!runId) runId = report.runId;
      data = runData(runId);
    }
    /* مراجع المعادلات ⇒ أعمدة حقيقية (أو رسالة خطأ واضحة) */
    const rf = resolveReportFormulas(report, data);
    if (rf.errors.length) return bad(res, rf.errors.join(' · '), 400);
    const result = await R.renderReport(rf.report, data, { standalone: false });
    if (!result.ok) return bad(res, result.error || 'render failed', 400);
    ok(res, result);
  },
  /* ---------- استيراد تقرير قائم من التطبيق إلى المصمم ---------- */
  'POST /api/reports/import-legacy': async (q, res, body) => {
    const name = String((body && body.name) || '').trim();
    const def = REPORTS[name];
    if (!def) return bad(res, 'تقرير غير معروف: ' + name, 404);
    const params = (body && body.params && typeof body.params === 'object') ? body.params : {};
    const lr = await legacyRows(name, params);
    const reg = SR.listReports().find(r => r.key === name) || null;
    const st = LR.staticFromCode(String(def.fn), legacyCodeText());
    const out = LR.convertToDesigner({
      name,
      label: def.label || name,
      desc: def.desc || '',
      rows: lr.error ? null : lr.rows,
      columns: lr.error ? null : rowsColumns(lr.rows),
      declared: reg ? (reg.fields || []) : [],
      staticMeta: st,
      params,
      runtimeError: lr.error || null,
    });
    ok(res, out);
  },
  'POST /api/reports/validate': async (q, res, body) => {
    const rep = body && body.report;
    if (!rep || typeof rep !== 'object') return bad(res, 'report required');
    const sv = Schema.validateReport(rep);
    /* إن حُدِّد تشغيل ⇒ تُفحص أعمدة التقرير مقابل أعمدة نتيجته (كشف مبكّر قبل الحفظ) */
    let columns = null;
    const runId = body && body.runId ? String(body.runId).trim() : '';
    if (runId) {
      const out = W.loadOutput(runId, WF_ROOT);
      if (out) columns = out.columns || [];
    } else {
      const lg = (body && body.legacy && body.legacy.name) || (rep.legacy && rep.legacy.name) || '';
      if (lg) {
        const ld = await legacyData(lg, (body && body.legacy && body.legacy.params) || (rep.legacy && rep.legacy.params));
        if (!ld.error) columns = ld.columns;
      }
    }
    const v = await R.validateReport(rep, { columns });
    const errors = [].concat(sv.errors || [], v.ok ? [] : [v.error || '']).filter(Boolean);
    ok(res, { ok: errors.length === 0, errors, error: errors.join(' · ') });
  },
  /* ---------- سجل المعادلات المحفوظة (مصدر واحد للتدفقات والتقارير) ---------- */
  'GET /api/formulas/saved': async (q, res) => ok(res, { items: FS.listFormulas(FORMULA_ROOT) }),
  /* تحقق فعلي: ينفّذ التعبير على صفوف عيّنة ويعيد القيم والأخطاء والاعتماديات */
  'POST /api/formulas/verify': async (q, res, body) => {
    const rows = (body && Array.isArray(body.rows)) ? body.rows : [];
    if (rows.length > FV.MAX_ROWS) return bad(res, 'عدد صفوف التحقق أكبر من الحد (' + FV.MAX_ROWS + ')', 400);
    let def = (body && body.formula && typeof body.formula === 'object') ? body.formula : null;
    const id = body && body.id ? String(body.id).trim() : '';
    if (!def && id) {
      const out = FV.verifySavedFormula(id, FORMULA_ROOT, rows);
      if (out.status === 'not-found') return bad(res, out.errors[0] || 'not found', 404);
      return ok(res, out);
    }
    if (!def) return bad(res, 'formula or id required');
    ok(res, FV.verifyFormula(def, rows));
  },
  'GET /api/formulas/saved/get': async (q, res) => {
    const id = String(q.get('id') || '').trim();
    if (!id) return bad(res, 'id required');
    const f = FS.loadFormula(id, FORMULA_ROOT);
    if (!f) return bad(res, 'not found', 404);
    ok(res, f);
  },
  'POST /api/formulas/save': async (q, res, body) => {
    const def = body && body.formula;
    if (!def || typeof def !== 'object') return bad(res, 'formula required');
    const r = FS.saveFormula(def, FORMULA_ROOT);
    if (r.error) return bad(res, r.error, 400);
    ok(res, { id: r.id, formula: r.formula });
  },
  'POST /api/formulas/delete': async (q, res) => {
    const id = String(q.get('id') || '').trim();
    if (!id) return bad(res, 'id required');
    if (!FS.deleteFormula(id, FORMULA_ROOT)) return bad(res, 'not found', 404);
    ok(res, { deleted: id });
  },
  'POST /api/reports/delete': async (q, res) => {
    const id = String(q.get('id') || '').trim();
    if (!id) return bad(res, 'id required');
    const done = RS.deleteReport(id, REPORTS_ROOT);
    if (!done) return bad(res, 'not found', 404);
    ok(res, { deleted: id });
  },
  'GET /api/reports/export/html': async (q, res) => {
    const id = String(q.get('id') || '').trim();
    if (!id) return bad(res, 'id required');
    const r = reportWithData(id);
    if (!r) return bad(res, 'not found', 404);
    const rf = resolveReportFormulas(r.report, r.data);
    if (rf.errors.length) return bad(res, rf.errors.join(' · '), 400);
    const result = await R.renderReport(rf.report, r.data, { standalone: true });
    if (!result.ok) return bad(res, result.error || 'render failed', 400);
    const html = result.html || '';
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'attachment; filename="report-' + id + '.html"',
      'Content-Length': Buffer.byteLength(html),
    });
    return res.end(html);
  },
  'GET /api/reports/capabilities': async (q, res) => {
    const cap = await R.capabilities();
    ok(res, cap.capabilities || cap);
  },
  'GET /api/reports/export/xlsx': async (q, res) => {
    const id = String(q.get('id') || '').trim();
    if (!id) return bad(res, 'id required');
    const r = reportWithData(id);
    if (!r) return bad(res, 'not found', 404);
    const tmpPath = path.join(os.tmpdir(), 'ccs-report-' + Date.now() + '.xlsx');
    const result = await R.exportReport(r.report, r.data, 'xlsx', { output_path: tmpPath });
    if (!result.ok) { try { fs.unlinkSync(tmpPath); } catch(_){} return bad(res, result.error || 'export failed', 400); }
    const buf = result.buffer || (fs.existsSync(tmpPath) ? fs.readFileSync(tmpPath) : null);
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    if (!buf) return bad(res, 'export failed', 500);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="report-' + id + '.xlsx"',
      'Content-Length': buf.length,
    });
    return res.end(buf);
  },
  /* عرض طباعة المتصفح: نفس مُصيِّر التقرير + CSS طباعة فقط (لا HTML متنكّرًا كـ PDF). */
  'GET /api/reports/export/print': async (q, res) => {
    const id = String(q.get('id') || '').trim();
    if (!id) return bad(res, 'id required');
    const r = reportWithData(id);
    if (!r) return bad(res, 'not found', 404);
    const rf = resolveReportFormulas(r.report, r.data);
    if (rf.errors.length) return bad(res, rf.errors.join(' · '), 400);
    const result = await R.renderReport(rf.report, r.data, { standalone: true });
    if (!result.ok) return bad(res, result.error || 'render failed', 400);
    const html = RP.buildPrintDocument(result.html || '', {
      title: String(r.report.title || r.report.name || 'تقرير'),
      autoPrint: String(q.get('auto') || '1') !== '0',
    });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(html),
    });
    return res.end(html);
  },
  'GET /api/reports/export/pdf': async (q, res) => {
    const id = String(q.get('id') || '').trim();
    if (!id) return bad(res, 'id required');
    const r = reportWithData(id);
    if (!r) return bad(res, 'not found', 404);
    const tmpPath = path.join(os.tmpdir(), 'ccs-report-' + Date.now() + '.pdf');
    const result = await R.exportReport(r.report, r.data, 'pdf', { output_path: tmpPath });
    if (!result.ok) { try { fs.unlinkSync(tmpPath); } catch(_){} return bad(res, result.error || 'export failed', 400); }
    const buf = result.buffer || (fs.existsSync(tmpPath) ? fs.readFileSync(tmpPath) : null);
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    if (!buf) return bad(res, 'export failed', 500);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="report-' + id + '.pdf"',
      'Content-Length': buf.length,
    });
    return res.end(buf);
  },
  'POST /api/workflows/save': async (q, res, body) => {
    const raw = body && body.workflow;
    const rg = resolveGraphWorkflow(raw);
    if (!rg.ok) return bad(res, rg.error, rg.status || 400);
    const wf = rg.workflow;
    const v = W.validateWorkflow(wf);
    if (!v.ok) return bad(res, 'invalid workflow: ' + v.errors.join('; '));
    // sanitize id (path traversal guard)
    const safeId = String(wf.id || '').replace(/[^A-Za-z0-9_\-]/g, '');
    const obj = Object.assign({}, wf, safeId ? { id: safeId } : {});
    const id = W.saveWorkflow(obj, WF_ROOT);
    ok(res, { id, graph: !!wf.graph, graphSchemaVersion: wf.graphSchemaVersion || null });
  },
  'POST /api/workflows/validate': async (q, res, body) => {
    const raw = body && body.workflow;
    const rg = resolveGraphWorkflow(raw);
    if (!rg.ok) {
      return ok(res, {
        ok: false,
        errors: [{ step: null, errors: rg.graphErrors || [rg.error] }],
        graphErrors: rg.graphErrors || [rg.error],
        nodeErrors: rg.nodeErrors || {},
      });
    }
    const wf = rg.workflow;
    const v = W.validateWorkflow(wf);
    if (!v.ok) return ok(res, { ok: false, errors: v.errors });
    const cols = (body && body.data && Array.isArray(body.data.columns)) ? body.data.columns : [];
    const stepErrors = [];
    if (Array.isArray(wf.steps)) {
      for (const s of wf.steps) {
        const sv = cols.length ? W.validateStep(s, cols) : W.validateStepShape(s);
        if (!sv.ok) stepErrors.push({ step: s.id || s.type, errors: sv.errors });
      }
    }
    const out = { ok: stepErrors.length === 0, errors: stepErrors };
    if (wf.graph) {
      out.graph = {
        ok: true,
        schemaVersion: wf.graphSchemaVersion || null,
        order: (rg.graphInfo && rg.graphInfo.order) || [],
        outputName: (rg.graphInfo && rg.graphInfo.outputName) || '',
      };
    }
    ok(res, out);
  },
  /* فحص الرسم مع أعمدة المصادر — يملأ قوائم الحقول في المحرّر المرئي.
     لا يجلب صفوفًا ولا ينفّذ شيئًا؛ قراءة وصف فقط وفق الصلاحيات. */
  'POST /api/workflows/graph/inspect': async (q, res, body, req, me) => {
    const graph = body && body.graph;
    if (!graph || typeof graph !== 'object') return bad(res, 'graph required');
    const sourceIds = Array.from(new Set((Array.isArray(graph.nodes) ? graph.nodes : [])
      .filter(n => n && n.type === 'source' && n.config && n.config.sourceId)
      .map(n => String(n.config.sourceId))));
    const columnsBySource = {};
    const sourceErrors = {};
    for (const sid of sourceIds) {
      if (sid === 'synthetic') {
        const fix = W.syntheticFixture();
        columnsBySource[sid] = fix.sourceColumns.map(c => ({ name: c, type: D.SYNTHETIC_TYPES[c] || 'string' }));
        continue;
      }
      const r = await sourceInfo(sid, me);
      if (r && r.ok) columnsBySource[sid] = (r.data && (r.data.fields || r.data.columns)) || [];
      else sourceErrors[sid] = (r && r.error) || 'تعذّر قراءة وصف المصدر';
    }
    const insp = WG.inspectGraph(graph, { columnsBySource });
    insp.sourceErrors = sourceErrors;
    /* الخطوات المترجمة تُعاد للواجهة كي تبقى «القائمة المتقدمة» وJSON متطابقين
       مع الرسم دون تنفيذ أي بيانات. */
    if (insp.ok) {
      const c = WG.compileGraph(graph, { columnsBySource });
      if (c.ok) insp.compiled = { source: c.source, steps: c.steps, order: c.order, outputName: c.outputName };
    }
    ok(res, insp);
  },
  'GET /api/workflows/graph/meta': async (q, res) => ok(res, {
    schemaVersion: WG.GRAPH_SCHEMA_VERSION,
    nodeTypes: WG.NODE_TYPES,
    categories: WG.CATEGORIES,
    filterOps: WG.FILTER_OPS,
    aggFns: WG.AGG_FNS,
    joinTypes: WG.JOIN_TYPES,
    unionModes: WG.UNION_MODES,
    dedupeKeep: WG.DEDUPE_KEEP,
    nullActions: WG.NULL_ACTIONS,
    windowOps: WG.WINDOW_OPS,
    outlierMethods: WG.OUTLIER_METHODS,
    outlierActions: WG.OUTLIER_ACTIONS,
    sortOrders: WG.SORT_ORDERS,
    pivotDefaultPrefix: WG.PIVOT_DEFAULT_PREFIX,
    unpivotDefaults: { keyName: WG.UNPIVOT_DEFAULT_KEY, valueName: WG.UNPIVOT_DEFAULT_VALUE },
    python: PY.pythonNodeStatus(),
    pythonOps: PY.OPERATION_META,
  }),
  'POST /api/workflows/preview': async (q, res, body, req, me) => {
    const raw = body && body.workflow;
    const rg = resolveGraphWorkflow(raw);
    if (!rg.ok) return bad(res, rg.error, rg.status || 400);
    const wf = rg.workflow;
    const v = W.validateWorkflow(wf);
    if (!v.ok) return bad(res, 'invalid workflow: ' + v.errors.join('; '));
    let data, notes = null, wf2 = wf;
    if (D.isDataset(wf)) {
      /* مصدر قائمة بيضاء: يُحسم عند الخادم فقط ويُتجاهَل ما يُرسله العميل من data */
      const r = await D.resolveDataset(wf.source, me);
      if (!r.ok) return bad(res, r.error, r.status || 400);
      data = r.data;
      notes = (r.notes && r.notes.length) ? r.notes : null;
      wf2.sourceMeta = r.source || null;
    } else if (D.isFileSource(wf)) {
      const r = await D.resolveFileSource(wf.source);
      if (!r.ok) return bad(res, r.error, r.status || 400);
      data = { rows: r.rows, columns: r.columns };
      notes = (r.notes && r.notes.length) ? r.notes : null;
      wf2.sourceMeta = r.source || null;
    } else if (D.isWorkbookSource(wf)) {
      const r = await D.resolveWorkbookSource(wf.source, me);
      if (!r.ok) return bad(res, r.error, r.status || 400);
      data = { rows: r.rows, columns: r.columns };
      notes = (r.notes && r.notes.length) ? r.notes : null;
      wf2.sourceMeta = r.source || null;
    } else if (wf.source && wf.source.type === 'output') {
      const r = outputSourceData('output:' + String(wf.source.name || ''));
      if (!r.ok) return bad(res, r.error, r.status || 400);
      data = { rows: r.rows, columns: r.columns };
      notes = (r.notes && r.notes.length) ? r.notes : null;
      wf2.sourceMeta = r.source || null;
    } else {
      const fix = (body && body.data) ? null : W.syntheticFixture();
      data = (body && body.data) ? body.data : { rows: fix.sourceRows, columns: fix.sourceColumns };
      wf2 = fix ? injectFixtureRights(wf, fix) : wf;
    }
    /* ربط بمصدر حقيقي مسجَّل في الفهرس (rightSource) — يُحَلّ هنا بصلاحيات وحدود */
    const srcSt = (wf2.source && wf2.source.settings) || {};
    const prep = await W.prepareWorkflow(wf2, async (name) => resolveRightSource(name, me, srcSt));
    wf2 = prep.workflow;
    if (prep.notes && prep.notes.length) notes = (notes || []).concat(prep.notes);
    /* معادلات محفوظة ⇒ تُحلّ إلى تعبيراتها (محرك واحد: src/formulas.js) */
    const fx = resolveWorkflowFormulas(wf2, data);
    wf2 = fx.workflow;
    if (fx.notes && fx.notes.length) notes = (notes || []).concat(fx.notes);
    const until = body && body.until ? String(body.until).trim() : '';
    if (until && wf2 && Array.isArray(wf2.steps)) {
      const idx = wf2.steps.findIndex(s => String(s.id || s.type) === until);
      if (idx >= 0) wf2 = Object.assign({}, wf2, { steps: wf2.steps.slice(0, idx + 1) });
    }
    const limit = Math.max(1, Math.min(Number((body && body.limit) || 20), 1000));
    const res2 = await W.previewWorkflowAsync(wf2, data, limit);
    if (!res2.ok) return sendRunFailure(res, res2);
    if (notes) res2.sourceNotes = notes;
    if (until) res2.previewedStep = until;
    ok(res, res2);
  },
  'POST /api/workflows/run': async (q, res, body, req, me) => {
    const raw = body && body.workflow;
    const rg = resolveGraphWorkflow(raw);
    if (!rg.ok) return bad(res, rg.error, rg.status || 400);
    const wf = rg.workflow;
    const v = W.validateWorkflow(wf);
    if (!v.ok) return bad(res, 'invalid workflow: ' + v.errors.join('; '));
    let data, notes = null, wf2 = wf;
    if (D.isDataset(wf)) {
      /* مصدر قائمة بيضاء: قراءة عند الخادم بعد الصلاحية — ما يُرسله العميل من data لا يُوثق */
      const r = await D.resolveDataset(wf.source, me);
      if (!r.ok) return bad(res, r.error, r.status || 400);
      data = r.data;
      notes = (r.notes && r.notes.length) ? r.notes : null;
      wf2.sourceMeta = r.source || null;
    } else if (D.isFileSource(wf)) {
      const r = await D.resolveFileSource(wf.source);
      if (!r.ok) return bad(res, r.error, r.status || 400);
      data = { rows: r.rows, columns: r.columns };
      notes = (r.notes && r.notes.length) ? r.notes : null;
      wf2.sourceMeta = r.source || null;
    } else if (D.isWorkbookSource(wf)) {
      const r = await D.resolveWorkbookSource(wf.source, me);
      if (!r.ok) return bad(res, r.error, r.status || 400);
      data = { rows: r.rows, columns: r.columns };
      notes = (r.notes && r.notes.length) ? r.notes : null;
      wf2.sourceMeta = r.source || null;
    } else if (wf.source && wf.source.type === 'output') {
      const r = outputSourceData('output:' + String(wf.source.name || ''));
      if (!r.ok) return bad(res, r.error, r.status || 400);
      data = { rows: r.rows, columns: r.columns };
      notes = (r.notes && r.notes.length) ? r.notes : null;
      wf2.sourceMeta = r.source || null;
    } else {
      const fix = (body && body.data) ? null : W.syntheticFixture();
      data = (body && body.data) ? body.data : { rows: fix.sourceRows, columns: fix.sourceColumns };
      wf2 = fix ? injectFixtureRights(wf, fix) : wf;
    }
    /* ربط بمصدر حقيقي مسجَّل في الفهرس (rightSource) */
    const srcSt = (wf2.source && wf2.source.settings) || {};
    const prep = await W.prepareWorkflow(wf2, async (name) => resolveRightSource(name, me, srcSt));
    wf2 = prep.workflow;
    if (prep.notes && prep.notes.length) notes = (notes || []).concat(prep.notes);
    /* معادلات محفوظة ⇒ تُحلّ إلى تعبيراتها (محرك واحد: src/formulas.js) */
    const fx = resolveWorkflowFormulas(wf2, data);
    wf2 = fx.workflow;
    if (fx.notes && fx.notes.length) notes = (notes || []).concat(prep.notes).concat(fx.notes);
    const res2 = await W.executeWorkflowAsync(wf2, data);
    if (!res2.ok) return sendRunFailure(res, res2);
    /* أعمدة المعادلات المحسوبة ونسخها ⇒ ليتمكّن التقرير من الإشارة إلى المعادلة (نفس التشغيل) */
    if (fx.formulaColumns && Object.keys(fx.formulaColumns).length) res2.formulaColumns = fx.formulaColumns;
    if (fx.formulaVersions && Object.keys(fx.formulaVersions).length) res2.formulaVersions = fx.formulaVersions;
    const runId = 'run_' + Date.now();
    /* النتيجة تُحفظ مع مصدرها واسم التدفق ⇒ استوديو التقارير يعرف من أين جاءت */
    if (wf2.sourceMeta) res2.source = wf2.sourceMeta;
    else if (wf && wf.source && wf.source.type === 'memory') {
      /* مصدر داخلي (synthetic): يُسجَّل من الفهرس نفسه حتى لا يكون المصدر مجهولاً */
      const s = CAT.getSource('synthetic');
      if (s) res2.source = { name: s.id, label: s.label, domain: s.domain, grain: s.grain, canonical: false };
    }
    res2.workflowName = wf.name || '';
    res2.workflowId = wf.id || '';
    /* نسخة مستقلة من التعريف المنفَّذ + بصمته ⇒ تتبّع كامل وإعادة إنتاج */
    try {
      const def = W.definitionSnapshot(wf2);
      res2.definition = def;
      res2.definitionHash = W.definitionHash(def);
    } catch (_) { /* لا يمنع التشغيل */ }
    if (fx.formulaColumns) res2.formulaColumns = fx.formulaColumns;
    if (fx.formulaVersions) res2.formulaVersions = fx.formulaVersions;
    /* تحذيرات المسار (اكتمال الربط) تُحفظ مع النتيجة — لا تُنتج نتيجة تبدو سليمة */
    const traceWarnings = (res2.trace || []).flatMap(t => (t.warnings || []).map(w => (t.id ? '[' + t.id + '] ' : '') + w));
    if (traceWarnings.length) res2.warnings = traceWarnings;
    const comps = (res2.trace || []).map(t => t.completeness).filter(Boolean);
    if (comps.length) {
      res2.joinCompleteness = comps.includes('incomplete') ? 'incomplete'
        : (comps.includes('possibly-truncated') ? 'possibly-truncated' : 'complete');
    }
    /* إصدار محرك المعادلات: لتعرف النتيجة أي محرّك أنتجها */
    res2.engineVersion = FormulaEngine.FORMULA_ENGINE_VERSION;
    res2.engineHash = FormulaEngine.formulaEngineHash();
    try { W.saveOutput(runId, res2, WF_ROOT); res2.runId = runId; } catch (_) {}
    if (notes) res2.sourceNotes = notes;
    ok(res, res2);
  },
  'GET /api/reconcile': async (q, res) => ok(res, await A.reconcile({
    limit: Number(q.get('limit') || 100),
    offset: Number(q.get('offset') || 0),
    onlyMismatch: q.get('all') ? false : true,
    F: A.parseFilters(q),
  })),

  /* ---------- البورصة اليومية ---------- */
  'GET /api/borse': async (q, res) => {
    const days = Number(q.get('days') || 120);
    const item = q.get('item') || '';
    const from = q.get('from') || '';
    const to = q.get('to') || '';
    const [summary, latest, series, usd, recent] = await Promise.all([
      A.borseSummary(), A.borseLatest(),
      A.borseSeries({ days, item, from, to }),
      A.borseUsd(days, from, to), A.borseRecent(60, from, to),
    ]);
    ok(res, { days, item, from, to, summary, latest, series, usd, recent });
  },

  'GET /api/borse/status': async (q, res) => ok(res, await borseStatus()),

  /* شبكة التعديل اليدوي — «التعديل يسري من تاريخه فما بعد» */
  'GET /api/borse/grid': async (q, res) => {
    const to = q.get('to') || BE.today();
    const from = q.get('from') || BE.daysAgo(to, 45);
    const item = q.get('item') || null;
    const rows = await BE.grid({ from, to, item });
    ok(res, { from, to, item, fields: BE.FIELDS, rows });
  },

  'GET /api/borse/overrides': async (q, res) =>
    ok(res, await BE.history(Number(q.get('limit') || 300))),

  'POST /api/borse/override': async (q, res, body, req, me) => {
    const r = await BE.set({ ...(body || {}), user_id: me && me.id });
    /* أي تعديل على البورصة يغيّر تكلفة اليوم نفسه وما بعده → أعد بناء المحرك من هناك */
    await CE.markDirty(r.eff_date || CE.today());
    ok(res, r);
  },

  'POST /api/borse/override/delete': async (q, res, body) => {
    const r = await BE.remove(body || {});
    await CE.markDirty((body && body.eff_date) || CE.today());
    ok(res, r);
  },

  /**
   * جلب فوري لأسعار البورصة وريت الدولار — الجلب الذاتي داخل النظام
   * (Yahoo + بنك مصر). يكتب الأيام الناقصة ويحدّث صف اليوم؛ لا ملف يُقرأ أو يُكتب.
   */
  'POST /api/borse/fetch': async (q, res) => {
    const r = await BF.run({ reason: 'manual' });
    /* الأيام التي كُتبت/حُدّثت للتو تغيّر تكلفتها → تُعاد بناؤها من أقدمها */
    const written = (r && r.dates) || [];
    if (written.length) await CE.markDirty(written.slice().sort()[0]);
    else if (r && r.ok) await CE.markDirty(CE.today());
    ok(res, { ...r, status: await borseStatus() });
  },

  /* ---------- شاشة الأسعار اليومية (أربع قيم لكل صنف/يوم) ---------- */
  'GET /api/prices/grid': async (q, res) => {
    const to = q.get('to') || PE.today();
    const from = q.get('from') || to;
    const item = q.get('item') || null;
    const g = await PE.grid({ from, to, item });
    ok(res, { from, to, item, fields: PE.FIELDS, ...g });
  },

  /* لوحة «نظرة» — آخر سعر مسجَّل لكل صنف */
  'GET /api/prices/latest': async (q, res) => ok(res, { rows: await PE.latest() }),

  'GET /api/prices/overrides': async (q, res) =>
    ok(res, await PE.history(Number(q.get('limit') || 300))),

  'POST /api/prices/override': async (q, res, body, req, me) =>
    ok(res, await PE.set({ ...(body || {}), user_id: me && me.id })),

  'POST /api/prices/override/delete': async (q, res, body) =>
    ok(res, await PE.remove(body || {})),

  /* ---------- محرك التكلفة اليومية (المرحلة 3) ---------- */
  'GET /api/costs/grid': async (q, res) => {
    const g = await CE.grid({
      from: q.get('from') || null,
      to: q.get('to') || null,
      item: q.get('item') || null,
      unit: q.get('unit') || null,
      level: q.get('level') || 'detail',
      itemFrom: q.get('item_from') || null,
      itemTo: q.get('item_to') || null,
      unitFrom: q.get('unit_from') || null,
      unitTo: q.get('unit_to') || null,
    });
    ok(res, g);
  },

  'GET /api/costs/status': async (q, res) => ok(res, await CE.status()),

  'GET /api/import/status': async (q, res) => {
    const id = Number(q.get('id'));
    const j = jobs[id];
    if (!j) return bad(res, 'المهمة غير موجودة', 404);
    ok(res, j);
  },

  /* تأكيد الاستيراد بعد المعاينة: ينقل الملف من .staging إلى مجلده النهائي ويبدأ المهمة.
     body: { token, cat, name, as?, pw? } — as = مسار الملف القديم عند الاستبدال. */
  'POST /api/import/commit': async (q, res, body) => {
    const { token, cat, name, as, pw } = body || {};
    if (!DAILY_CATS[cat]) return bad(res, 'فئة يومية غير معروفة');
    if (!token) return bad(res, 'انتهت جلسة الرفع — أعد اختيار الملف');
    let staged = null;
    try {
      const found = fs.readdirSync(STAGING_DIR).find(f => f.startsWith(token));
      if (found) staged = path.join(STAGING_DIR, found);
    } catch (_) { /* لا مجلد مرحلة */ }
    if (!staged || !fs.existsSync(staged)) return bad(res, 'انتهت صلاحية المعاينة — أعد اختيار الملف');
    const dir = uploadsDir(cat);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, sanitizeFileName(name));
    fs.copyFileSync(staged, dest);
    try { fs.unlinkSync(staged); } catch (_) {}
    const id = startImportJob(dest, {
      password: pw || undefined, only: datasetsFor(cat), asSource: as || undefined,
    });
    ok(res, { jobId: id, path: dest, replacing: !!as });
  },

  /* قائمة ملفات اليوم المفهرسة حسب الفئة (الحركات/المبيعات/الأرصدة) */
  'GET /api/files/daily': async (q, res) => {
    const cat = q.get('cat') || 'movements';
    if (!DAILY_CATS[cat]) return bad(res, 'فئة يومية غير معروفة');
    /* الترتيب: بتاريخ الملف «الاسم» من الأحدث للأقدم — لا بتاريخ الاستيراد أو الاستبدال */
    const files = await DB.all(`
      SELECT file_name, file_path,
             COUNT(*)::int imports_count,
             MAX(imported_at) last_imported,
             SUM(rows_inserted)::int rows_total,
             SUM(rows_skipped)::int rows_skipped
      FROM imports WHERE dataset = ANY($1)
      GROUP BY file_name, file_path`, [datasetsFor(cat)]);
    const up = uploadsDir(cat).toLowerCase();
    const list = (files || []).map(r => {
      const p = path.normalize(String(r.file_path || ''));
      const pl = p.toLowerCase();
      return {
        ...r,
        stored: pl.startsWith(up + '\\') || pl.startsWith(up + '/'),
        date: dateFromName(r.file_name),
        file: p,
      };
    });
    /* التاريخ من اسم الملف (dd-mm-yyyy) → iso (yyyy-mm-dd) للترتيب؛ الملفات بلا تاريخير تآخر */
    const iso = d => (d && d.length === 10 && d[4] === '-') ? d : '0000-00-00';
    list.sort((a, b) => {
      const d = iso(b.date).localeCompare(iso(a.date));
      return d !== 0 ? d : String(b.file_name || '').localeCompare(String(a.file_name || ''), 'ar');
    });
    ok(res, { cat, files: list });
  },

  /* حذف ملف مستورد سابقاً: صفوفه من الجداول + سجل الاستيراد + نسخته إن كانت محفوظة */
  'POST /api/files/delete': async (q, res, body) => {
    const { cat, file } = body || {};
    if (!DAILY_CATS[cat]) return bad(res, 'فئة يومية غير معروفة');
    if (!file) return bad(res, 'لم يُحدد الملف');
    const p = path.normalize(String(file));
    const cond = tbl => `regexp_replace(COALESCE(${tbl === 'imports' ? 'file_path' : 'source_file'},''), '/', chr(92),'g') =
      regexp_replace($1, '/', chr(92),'g')`;
    const agg = {};
    const tables = ['movements', 'sales', 'balances', 'prices'];
    for (const tbl of tables) {
      const r = await DB.get(`SELECT COUNT(*)::int c FROM ${tbl} WHERE ${cond(tbl)}`, [p]);
      if (r.c > 0) { await DB.run(`DELETE FROM ${tbl} WHERE ${cond(tbl)}`, [p]); }
      agg[tbl] = r.c;
    }
    await DB.run(`DELETE FROM imports WHERE ${cond('imports')}`, [p]);
    let deletedFile = null;
    const pl = p.toLowerCase();
    if (pl.startsWith(UPLOADS_ROOT.toLowerCase() + '\\') || pl.startsWith(UPLOADS_ROOT.toLowerCase() + '/')) {
      try { fs.unlinkSync(p); deletedFile = p; } catch (_) {}
    }
    ok(res, { ...agg, deletedFile });
  },

  /* ---------- الإدخال اليدوي للبيانات اليومية (حركات/مبيعات/أرصدة/بورصة/أسعار) ---------- */
  /* معاينة «الرقم داخلي» التالي لعقد جديد — نفس معادلة التوليد التلقائي */
  'GET /api/daily/preview-no': check(async (q, res) =>
    ok(res, { internal_no: await DE.generateInternalNo(q.get('classification') || '', q.get('date') || '') })),
  'GET /api/daily/list': check(async (q, res) => ok(res, await DE.list({
    cat: q.get('cat'), limit: q.get('limit'), from: q.get('from'), to: q.get('to'), item: q.get('item'),
  }))),

  'POST /api/daily/save': check(async (q, res, body) => {
    const r = await DE.save({
      cat: body && body.cat, data: (body && body.data) || {}, id: body && body.id,
    });
    await markCost(r);
    ok(res, r);
  }),

  'POST /api/daily/delete': check(async (q, res, body) => {
    const r = await DE.remove({
      cat: body && body.cat, id: body && body.id,
    });
    await markCost(r);
    ok(res, r);
  }),

  'GET /api/reports': async (q, res) =>
    ok(res, Object.entries(REPORTS).filter(([, r]) => !r.hidden)
      .map(([name, r]) => ({ name, label: r.label, desc: r.desc || '' }))),

  'GET /api/report': async (q, res) => {
    const name = q.get('name') || '';
    const def = REPORTS[name];
    if (!def) return bad(res, 'اسم تقرير غير معروف');
    const F = A.parseFilters(q);
    /* تقرير المطابقة: قراءة من balances (بدون recon) + فلترة/ترقيم في SQL */
    if (name === 'reconcile') {
      const limit = Math.max(1, Number(q.get('limit') || q.get('pageSize') || 500));
      const page = Math.max(1, Number(q.get('page') || 1));
      const offset = (page - 1) * limit;
      let r;
      try { r = await A.reconcileReport(F, limit, offset); }
      catch (e) { return bad(res, 'خطأ في التقرير: ' + (e && e.message ? e.message : e), 500); }
      const pages = Math.max(1, Math.ceil(r.total / limit));
      const p = Math.min(page, pages);
      return ok(res, { name, label: def.label, desc: def.desc, raw: true, total: r.total, page: p, pages, pageSize: limit, rows: r.rows });
    }
    let rows;
    try {
      rows = await def.fn(F);
    } catch (e) {
      return bad(res, 'خطأ في التقرير: ' + (e && e.message ? e.message : e), 500);
    }
    const isRaw = !!def.raw || String(name).endsWith('-raw') || F.mode === 'raw';
    /* فلترة فلاتر رؤوس الأعمدة القادمة من الواجهة (التقارير الخام) — في الذاكرة قبل الترقيم */
    let base = isRaw ? applyColFilters(rows, q.get('cols')) : rows;
    /* شاشات عقود الاستيراد: بحث + تاريخ + حالة العقد — في الذاكرة قبل الترقيم */
    if (isRaw) base = await contractViewFilter(name, base, q);
    /* التقارير الخام: ترقيم صفحات على مستوى الذاكرة (offset/limit) —
       والواجهة تطلب حجماً كبيراً جداً (100000) لعرض كل الصفوف دفعة واحدة،
       والحد الأعلى هنا أمان للذاكرة. والتصدير CSV يظل كامل الصفوف. */
    if (isRaw) {
      const size = Math.min(100000, Math.max(1, Number(q.get('pageSize') || 1000)));
      const pages = Math.max(1, Math.ceil(base.length / size));
      const page = Math.min(pages, Math.max(1, Number(q.get('page') || 1)));
      return ok(res, {
        name, label: def.label, desc: def.desc, raw: true,
        total: base.length, page, pages, pageSize: size,
        rows: base.slice((page - 1) * size, page * size),
      });
    }
    /* التقارير التحليلية: أول 500 صف (كما هو) */
    const limit = Math.max(1, Number(q.get('limit') || 500));
    ok(res, { name, label: def.label, desc: def.desc, total: rows.length, rows: rows.slice(0, limit), raw: false });
  },

  'GET /api/export': async (q, res) => {
    const name = q.get('name') || '';
    const def = REPORTS[name];
    if (!def) return bad(res, 'اسم تقرير غير معروف');
    const F = A.parseFilters(q);
    let rows;
    try {
      rows = await def.fn(F);
    } catch (e) {
      return bad(res, 'خطأ في التقرير: ' + (e && e.message ? e.message : e), 500);
    }
    rows = await contractViewFilter(name, rows, q);
    const csv = Csv.toCsv(rows);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}.csv"`,
      'Content-Length': Buffer.byteLength(csv),
    });
    res.end(csv);
  },
};

/* ---------- الشاشات وصلاحياتها ----------
   منصة التحليل = ثلاثة أقسام (src/platform-screens.js):
     البيانات والتحليل · التقارير ولوحات المعلومات · تصميم الشاشات والتحكم
   الصلاحيات المخزَّنة (users.tabs) لا تُكسر: التبويبات القديمة
   (analysis/workflow/workcenter/reports-manager) تُترجم عبر HOST_OF،
   فيبقى «workflow» مدخلًا إلى قسم «البيانات والتحليل» لا شاشة رابعة. */
const TABS = [
  { id: 'dashboard', label: 'لوحة التحكم' },
  { id: 'md-items', label: 'الأصناف الأساسية' },
  { id: 'md-locations', label: 'المواقع والمصانع' },
  { id: 'md-movetypes', label: 'أنواع الحركات' },
  { id: 'md-contractrefs', label: 'مراجع العقود' },
  { id: 'inventory', label: 'المخزون والمطابقة' },
  { id: 'sales', label: 'المبيعات والربحية' },
  { id: 'movements', label: 'الحركات' },
  { id: 'borse', label: 'البورصة اليومية' },
  { id: 'prices', label: 'الأسعار اليومية' },
  { id: 'costs', label: 'التكلفة اليومية' },
  { id: 'contracts', label: 'عقود الاستيراد' },
  { id: 'reports', label: 'التقارير' },
  { id: 'analysis', label: 'البيانات والتحليل' },
  { id: 'report-studio', label: 'التقارير ولوحات المعلومات' },
  { id: 'screen-studio', label: 'تصميم الشاشات والتحكم' },
];
const TAB_IDS = TABS.map(t => t.id);
const TAB_LABEL = Object.fromEntries(TABS.map(t => [t.id, t.label]));
/* الشاشات المخصّصة (من data/screens) تُعامَل كشاشات التطبيق نفسها:
   تظهر في قائمة الصلاحيات (المدير يفعّلها لكل مستخدم) وفي الشريط، بلا أي
   تجاوز لنظام الصلاحيات — الفهرس هنا قائمة، وال.Filter يتم في tabsOfUser. */
function customTabs() {
  let list = [];
  try { list = ScreenStore.listScreens(SCREENS_ROOT); } catch (_) { list = []; }
  return list.map(s => ({ id: s.id, label: s.name || s.id, custom: true }));
}
/** كل الشاشات: الثابتة + المخصّصة */
function allTabs() { return TABS.concat(customTabs()); }
function isCustomTabId(id) { return String(id || '').indexOf('cs_') === 0; }
/* الافتراضي قبل أي تعديل من المدير: لوحة التحكم (المستخدمون والصلاحيات) للمدير فقط،
   والبقية للمحاسب كاملاً، والمشاهد للشاشات كلها عدا لوحة التحكم.
   الاستيراد ليس شاشة (أُزيل التبويب العام) بل صلاحية تُفعِّل أزرار الاستيراد اليومي.
   الافتراضي يُمنح للمستخدم عند أول إنشاء له (عمود users.tabs) — بعدها كل مستخدم
   يُضبط شاشاته على حدة، والدور لا يعدّلها. */
const DEFAULT_TABS = {
  admin: TAB_IDS.slice(),
  accountant: TAB_IDS.filter(t => t !== 'dashboard' && t !== 'screen-studio'),
  viewer: TAB_IDS.filter(t => t !== 'dashboard' && t !== 'screen-studio'),
};
function tabsForRole(role) { return (DEFAULT_TABS[role] || TAB_IDS).slice(); }
/** شاشات المستخدم المسموح بها: users.tabs (JSON) إن وُجد، وإلا افتراضي دوره.
    الشاشات المخصّصة (cs_*) لا تُمنح تلقائيًا لأي دور — المدير يفعّلها لكل مستخدم.
    التبويبات المدموجة (workcenter · workflow · reports-manager) تترجم إلى أقسامها
    المضيفة ⇒ الصلاحيات المخزَّنة قبل الدمج تبقى نافذة بلا كسر. */
function tabsOfUser(u) {
  const ALL = allTabs().map(t => t.id);
  if (!u) return ALL;
  if (u.role === 'admin') return ALL;
  if (u.tabs) {
    try {
      const arr = JSON.parse(u.tabs);
      if (Array.isArray(arr)) {
        const set = new Set(arr);
        for (const [oldId, hostId] of Object.entries(PLATFORM.HOST_OF)) {
          if (set.has(oldId)) set.add(hostId);
        }
        return ALL.filter(t => set.has(t));
      }
    } catch (_) { /* عمود تالف → الافتراضي */ }
  }
  return tabsForRole(u.role);
}
/* سياسة المسارات (قراءة/كتابة/شاشات) في src/route-policy.js — قابلة للاختبار بلا خادم. */
const TAB_API = Policy.TAB_API;
const CUSTOM_SCREEN_API = Policy.CUSTOM_SCREEN_API;

/* ---------- المصادقة ---------- */
async function pubUser(u) {
  const r = Auth.ROLES[u.role];
  return {
    id: u.id, username: u.username, full_name: u.full_name || '',
    role: u.role, roleLabel: Auth.roleLabel(u.role),
    mustChange: !!u.must_change,
    perms: r ? r.perms : [],
    tabs: tabsOfUser(u),
  };
}

/* مسارات عامة وصلاحيات الكتابة — من وحدة السياسة القابلة للاختبار. */
const TEST_MODE = process.env.WORKFLOW_TEST_MODE === '1';
const PUBLIC_ROUTES = Policy.publicRoutes(TEST_MODE);
const PERM_ROUTES = Policy.WRITE_PERM_ROUTES;
const PERM_LABEL = Policy.PERM_LABEL;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = `${req.method} ${u.pathname}`;
  const route = routes[key];

  const guard = async () => {
    if (PUBLIC_ROUTES.has(key)) return null;              // مسارات عامة
    if (!u.pathname.startsWith('/api/')) return null;     // ملفات الواجهة
    const me = await Auth.getSession(Auth.readCookie(req, Auth.COOKIE)).catch(() => null);
    if (!me) {
      send(res, 401, { ok: false, error: 'unauthorized', message: 'انتهى الجلسة — سجّل الدخول' });
      return 'stop';
    }
    let need = PERM_ROUTES[key] || null;
    if (need && !Auth.can(me, need)) {
      send(res, 403, {
        ok: false, error: 'forbidden',
        message: `دورك (${Auth.roleLabel(me.role)}) لا يملك صلاحية «${PERM_LABEL[need] || need}»`,
      });
      return 'stop';
    }
    /* حماية الشاشات: دور غير المدير لا يقرأ API شاشة مُغلقة عليه */
    if (me.role !== 'admin') {
      const hit = TAB_API.find(([p]) => u.pathname === p || u.pathname.startsWith(p + '/'));
      if (hit) {
        const allowed = tabsOfUser(me);
        if (!hit[1].some(t => allowed.includes(t))) {
          /* استثناء الشاشات المخصّصة: تقرأ نتيجة التشغيل المحفوظة وتصيّر مكوّناتها فقط */
          const customOk = CUSTOM_SCREEN_API.has(u.pathname) && allowed.some(t => isCustomTabId(t));
          if (!customOk) {
            send(res, 403, {
              ok: false, error: 'forbidden',
              message: `دورك لا يملك صلاحية شاشة «${TAB_LABEL[hit[1][0]] || hit[1][0]}» — اطلب من المدير تفعيلها`,
            });
            return 'stop';
          }
        }
      }
    }
    return me;
  };

  const finish = (fn) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 5e6) req.destroy(); });
    req.on('end', async () => {
      let body = null;
      if (raw) { try { body = JSON.parse(raw); } catch (_) { body = raw; } }
      try {
        const me = await guard();
        if (me === 'stop') return;
        await fn(u.searchParams, res, body, req, me);
      }
      catch (e) { console.error(e); bad(res, e.message, 500); }
    });
  };

  if (key === 'POST /api/import/preview') {
    /* معاينة ملف يومي: الـ body هو بايتات الملف مباشرة (cat و name و pw في query)
       يُحفظ مؤقتاً في data/uploads/.staging/<token><ext> ثم يُحلَّل ويُعاد للواجهة،
       وعند التأكيد ينقله commit إلى مجلده النهائي ويبدأ الاستيراد. */
    const chunks = [];
    let size = 0;
    req.on('data', c => { chunks.push(c); size += c.length; if (size > 300e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const me = await guard();
        if (me === 'stop') return;
        const cat = u.searchParams.get('cat');
        if (!DAILY_CATS[cat]) return bad(res, 'فئة يومية غير معروفة');
        const name = sanitizeFileName(u.searchParams.get('name'));
        const pw = u.searchParams.get('pw') || '';
        fs.mkdirSync(STAGING_DIR, { recursive: true });
        pruneStaging();
        const token = crypto.randomBytes(16).toString('hex');
        const ext = path.extname(name) || '.xlsx';
        const staged = path.join(STAGING_DIR, token + ext);
        fs.writeFileSync(staged, Buffer.concat(chunks));
        let analysis;
        try {
          analysis = analyzePreviewDeep(staged, { maxRows: 8, only: datasetsFor(cat), password: pw || undefined });
        } catch (e) {
          try { fs.unlinkSync(staged); } catch (_) {}
          return bad(res, 'تعذّرت قراءة الملف: ' + (e.message || 'خطأ'));
        }
        ok(res, { token, cat, name, analysis });
      } catch (e) { console.error(e); bad(res, e.message, 500); }
    });
    return;
  }

  if (route) return finish(route);

  if (req.method === 'GET') {
    let p = u.pathname === '/' ? '/index.html' : u.pathname;
    const file = path.join(PUBLIC, path.normalize(p).replace(/^([.\\/])+/, ''));
    if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const buf = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store, must-revalidate' });
      return res.end(buf);
    }
    return send(res, 404, { ok: false, error: 'Not found' });
  }
  send(res, 405, { ok: false, error: 'Method not allowed' });
});

(async () => {
  try {
    const LIVE = process.env.WORKFLOW_LIVE === '1';
    let info = null, fetchAt = null, seeded = false;
    if (TEST_MODE) {
      console.log('==================================================');
      console.log('  ⚠  WORKFLOW TEST MODE ENABLED');
      console.log('  - Database (PostgreSQL) is NOT connected');
      console.log('  - CE.flush() / BF scheduler / Auth.seedAdmin skipped');
      console.log('  - Workflow & Formula routes use synthetic data only');
      console.log('  - Auth bypassed for workflow/formula routes (test user)');
      console.log('  - NOT for production use');
      console.log('==================================================');
    } else if (LIVE) {
      /* وضع الحي للقراءة فقط (Workflow Studio): فحص اتصال فقط — بلا migrate
         (لا DDL) ولا seedAdmin ولا مجدول جلب ولا CE.flush — صفر كتابة خدمية.
         الدخول حقيقي بالصلاحيات الموجودة، ومصادر datasets بورصة القراءة فقط. */
      await DB.pool.query('SELECT 1');
      console.log('==================================================');
      console.log('  ⚠  WORKFLOW LIVE READ-ONLY MODE');
      console.log('  - PostgreSQL connected: connection check only (no schema migration, no DDL)');
      console.log('  - No seedAdmin / BF scheduler / CE.flush — zero service-side writes');
      console.log('  - Workflow Studio dataset sources enabled: borse (read-only, ≤5000 rows)');
      console.log('  - Login flow unchanged (sessions/last_login are auth-lifecycle writes)');
      console.log('  - NOT for general production use');
      console.log('==================================================');
    } else {
      await DB.init();
      seeded = await Auth.seedAdmin();   // إنشاء مدير النظام عند أول تشغيل
      info = await DB.info();
      fetchAt = await BF.fetchTime();
    }
    const wbStatus = D.workbookConfigStatus();
    const pyStatus = PY.pythonNodeStatus();
    server.on('error', e => {
      if (e.code === 'EADDRINUSE') {
        console.error(`المنفذ ${PORT} مشغول — خادم آخر يعمل على http://${HOST}:${PORT} بالفعل`);
        console.error('أوقفه ثم أعد التشغيل، أو غيّر PORT في ملف الإعداد.');
      } else {
        console.error('!!! خطأ في الخادم:', e.message);
      }
      process.exit(1);
    });
    server.listen(PORT, HOST, () => {
      console.log('==============================================');
      console.log('  نظام متابعة الاستهلاك والتكاليف');
      console.log(`  الرابط          : http://${HOST}:${PORT}`);
      if (wbStatus.code === 'ready') {
        console.log('  مصدر Excel      : ' + wbStatus.fileCount + ' ملفًا في ' + wbStatus.root + ' (قراءة فقط)');
      } else if (wbStatus.code === 'empty') {
        console.log('  مصدر Excel      : المجلد مهيأ لكنه بلا ملفات مدعومة — ' + wbStatus.root);
      } else {
        console.log('  مصدر Excel      : معطّل — ' + wbStatus.reason);
      }
      console.log('  عقدة Python     : ' + (pyStatus.enabled
        ? 'مقيّدة ومتاحة (عمليات بيضاء فقط)'
        : 'معطّلة — ' + pyStatus.reason));
      if (TEST_MODE) {
        console.log('  وضع              : WORKFLOW TEST MODE (DB disabled)');
        console.log('  قاعدة البيانات  : (غير متصلة)');
        console.log('  جلب البورصة     : (معطّل)');
        console.log('  محرك التكلفة    : (معطّل — لا CE.flush)');
      } else if (LIVE) {
        console.log('  وضع              : WORKFLOW LIVE READ-ONLY (datasets: borse)');
        console.log('  قاعدة البيانات  : متصلة — قراءة فقط (بلا migrate/seed/مجدول)');
        console.log('  جلب البورصة     : (معطّل في هذا النسخ)');
        console.log('  محرك التكلفة    : (معطّل — لا CE.flush)');
      } else {
        console.log(`  قاعدة البيانات  : PostgreSQL — ${info.database} @ ${info.host}:${info.port}`);
        console.log(`  جلب البورصة     : يومياً الساعة ${fetchAt} (Yahoo + بنك مصر)`);
        if (seeded) console.log('  حساب المدير     : admin / admin123  (غيّره بعد أول دخول)');
        BF.startScheduler().catch(e => console.error('  ! تعذّر بدء مجدول الجلب: ' + e.message));
        /* تأكد من اكتمال «سمكة اليوم» في محرك التكلفة دون أن يعطّل بدء الخادم */
        CE.flush().catch(e => console.error('  ! تعذّر تهيئة محرك التكلفة: ' + e.message));
      }
      console.log('==============================================');
    });
  } catch (e) {
    if (TEST_MODE) {
      console.error('\n!!! خطأ أثناء بدء WORKFLOW TEST MODE');
      console.error('    ' + e.message);
    } else {
      console.error('\n!!! تعذّر الاتصال بقاعدة البيانات PostgreSQL');
      console.error('    ' + e.message);
    }
    console.error('    تأكد أن خدمة postgresql تعمل، وكلمة المرور صحيحة في:');
    console.error('    ' + DB.CONFIG_PATH);
    console.error('    ثم أعد التشغيل.\n');
    process.exit(1);
  }
})();

module.exports = { server, startImportJob, jobs };
