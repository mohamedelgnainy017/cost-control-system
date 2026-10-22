'use strict';
/**
 * خادم النظام — PostgreSQL + node:http
 * يعمل محلياً الآن ويمكن نقله كما هو إلى سيرفر أونلاين لاحقاً.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');

const DB = require('./db');
const { analyzePreviewDeep } = require('./importer');
const DE = require('./daily-entry');
const A = require('./analytics');
const Auth = require('./auth');
const BE = require('./borse-edit');
const BF = require('./borse-fetch');
const PE = require('./prices-edit');
const CE = require('./cost-engine');
const M = require('./master');

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
const normAr = s => String(s === null || s === undefined ? '' : s).toLowerCase()
  .replace(/[أإآٱ]/g, 'ا').replace(/[ىي]/g, 'ي').replace(/[ةه]/g, 'ه')
  .replace(/[\u064B-\u065F\u0670]/g, '').replace(/[\s,،_()\-]/g, '');

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

function toCsv(rows) {
  if (!rows.length) return '\uFEFF';
  const cols = Object.keys(rows[0]);
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map(c => esc(r[c])).join(','));
  return '\uFEFF' + lines.join('\r\n');
}

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
const pad2 = n => String(n).padStart(2, '0');
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
  'contract-companies-raw': {
    label: 'شركات العقود الداخلية (خام)', desc: 'ورقة «البيانات» — جدول الشركات الداخلية', raw: true, hidden: true,
    fn: () => DB.all(`SELECT * FROM contract_companies_internal`),
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

/* ---------- المسارات ---------- */
/* صف بورصة أو أرصدة يدوي يغيّر تكلفة يومه وما بعده → يُوسم المحرك ليعيد البناء من تاريخه */
const markCost = async r => {
  if (r && r.date && (r.cat === 'borse' || r.cat === 'balances')) await CE.markDirty(r.date);
};

const routes = {
  /* ===== المصادقة والمستخدمون ===== */
  'GET /api/auth/login-info': async (q, res) => {
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
    const users = await Auth.listUsers();
    const perms = {};
    for (const u of users) perms[u.id] = u.role === 'admin' ? TAB_IDS.slice() : tabsOfUser(u);
    ok(res, { tabs: TABS, users: users.map(u => ({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, roleLabel: Auth.roleLabel(u.role) })), perms });
  },

  'POST /api/tabs/save': async (q, res, body, req, me) => {
    const src = (body && body.perms) || {};
    const users = await Auth.listUsers();
    const byId = new Map(users.map(u => [u.id, u]));
    for (const [idKey, arr] of Object.entries(src)) {
      const uid = Number(idKey);
      const u = byId.get(uid);
      if (!u) continue;                                   // مستخدم غير معروف → تجاهُل
      if (u.role === 'admin') continue;                   // المدير يملك كل الشاشات دائماً
      /* ترشيح صارم ضد أي معرّفات شاشات غير معروفة */
      const clean = TAB_IDS.filter(t => (Array.isArray(arr) ? arr : []).map(String).includes(t));
      await DB.run('UPDATE users SET tabs = $1, updated_at = now() WHERE id = $2',
        [JSON.stringify(clean), uid]);
    }
    const users2 = await Auth.listUsers();
    const perms = {};
    for (const u of users2) perms[u.id] = u.role === 'admin' ? TAB_IDS.slice() : tabsOfUser(u);
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
    const csv = toCsv(rows);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}.csv"`,
      'Content-Length': Buffer.byteLength(csv),
    });
    res.end(csv);
  },
};

/* ---------- الشاشات وصلاحياتها ---------- */
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
];
const TAB_IDS = TABS.map(t => t.id);
const TAB_LABEL = Object.fromEntries(TABS.map(t => [t.id, t.label]));
/* الافتراضي قبل أي تعديل من المدير: لوحة التحكم (المستخدمون والصلاحيات) للمدير فقط،
   والبقية للمحاسب كاملاً، والمشاهد للشاشات كلها عدا لوحة التحكم.
   الاستيراد ليس شاشة (أُزيل التبويب العام) بل صلاحية تُفعِّل أزرار الاستيراد اليومي.
   الافتراضي يُمنح للمستخدم عند أول إنشاء له (عمود users.tabs) — بعدها كل مستخدم
   يُضبط شاشاته على حدة، والدور لا يعدّلها. */
const DEFAULT_TABS = {
  admin: TAB_IDS.slice(),
  accountant: TAB_IDS.filter(t => t !== 'dashboard'),
  viewer: TAB_IDS.filter(t => t !== 'dashboard'),
};
function tabsForRole(role) { return (DEFAULT_TABS[role] || TAB_IDS).slice(); }
/** شاشات المستخدم المسموح بها: users.tabs (JSON) إن وُجد، وإلا افتراضي دوره */
function tabsOfUser(u) {
  if (!u) return TAB_IDS.slice();
  if (u.role === 'admin') return TAB_IDS.slice();
  if (u.tabs) {
    try {
      const arr = JSON.parse(u.tabs);
      if (Array.isArray(arr)) return TAB_IDS.filter(t => arr.includes(t));
    } catch (_) { /* عمود تالف → الافتراضي */ }
  }
  return tabsForRole(u.role);
}
/* مسارات API محمية بصلاحية الشاشة: بادئة المسار ← الشاشات التي تكفي للوصول.
   المسارات الشائعة (overview/health/span...) خارج القائمة عمداً،
   ومسارات الاستيراد اليومي/الإدخال اليدوي محمية بصلاحية «import» في PERM_ROUTES
   (بعد إزالة تبويب الاستيراد العام لم تبقَ شاشةٌ باسمه). */
const TAB_API = [
  ['/api/md/items', ['md-items']],
  ['/api/md/locs', ['md-locations']],
  ['/api/md/mtypes', ['md-movetypes']],
  ['/api/md/mtypes/categories', ['md-movetypes']],
  ['/api/md/refs', ['md-contractrefs']],
  ['/api/inventory', ['inventory']],
  ['/api/sales', ['sales']],
  ['/api/movements', ['movements']],
  ['/api/borse', ['borse']],
  ['/api/prices', ['prices']],
  ['/api/costs', ['costs']],
  ['/api/reports', ['reports']],
  ['/api/report', ['reports']],
  ['/api/export', ['reports']],
  ['/api/contracts', ['contracts']],
];

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

/* مسارات عامة (قبل الدخول) */
const PUBLIC_ROUTES = new Set([
  'GET /api/auth/login-info',
  'POST /api/auth/login',
  'GET /api/auth/me',
  'GET /api/health',
]);

/* صلاحيات إضافية فوق «تسجيل الدخول» */
const PERM_ROUTES = {
  /* الاستيراد اليومي + الإدخال اليدوي (صلاحية import — لا شاشة) */
  'POST /api/import/preview': 'import',
  'POST /api/import/commit': 'import',
  'GET /api/import/status': 'import',
  'GET /api/files/daily': 'import',
  'POST /api/files/delete': 'import',
  'GET /api/daily/list': 'import',
  'GET /api/daily/preview-no': 'import',
  'POST /api/daily/save': 'import',
  'POST /api/daily/delete': 'import',
  'POST /api/borse/fetch': 'sync',
  'POST /api/borse/override': 'sync',
  'POST /api/borse/override/delete': 'sync',
  'POST /api/prices/override': 'sync',
  'POST /api/prices/override/delete': 'sync',
  'POST /api/settings/cost': 'master',
  'GET /api/users': 'users',
  'POST /api/users': 'users',
  'POST /api/users/update': 'users',
  'POST /api/users/delete': 'users',
  'POST /api/tabs/save': 'users',
  /* البيانات الأساسية: الإضافة والتعديل بصلاحية master */
  'POST /api/md/items/save': 'master',
  'POST /api/md/items/delete': 'master',
  'POST /api/md/items/groups/save': 'master',
  'POST /api/md/items/groups/delete': 'master',
  'POST /api/md/items/classes/save': 'master',
  'POST /api/md/items/classes/delete': 'master',
  'POST /api/md/locs/company/save': 'master',
  'POST /api/md/locs/company/delete': 'master',
  'POST /api/md/locs/unit/save': 'master',
  'POST /api/md/locs/unit/delete': 'master',
  'POST /api/md/locs/warehouse/save': 'master',
  'POST /api/md/locs/warehouse/delete': 'master',
  'POST /api/md/locs/warehouse/report-active': 'master',
  'POST /api/md/mtypes/save': 'master',
  'POST /api/md/mtypes/delete': 'master',
  'POST /api/md/mtypes/category/save': 'master',
  'POST /api/md/mtypes/category/delete': 'master',
  'POST /api/md/refs/save': 'master',
  'POST /api/md/refs/delete': 'master',
};

const PERM_LABEL = {
  import: 'استيراد', sync: 'جلب البورصة والتعديل اليدوي على الأسعار',
  users: 'إدارة المستخدمين',
  master: 'الإضافة والتعديل في البيانات الأساسية',
};

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
          send(res, 403, {
            ok: false, error: 'forbidden',
            message: `دورك لا يملك صلاحية شاشة «${TAB_LABEL[hit[1][0]] || hit[1][0]}» — اطلب من المدير تفعيلها`,
          });
          return 'stop';
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
    await DB.init();
    const seeded = await Auth.seedAdmin();   // إنشاء مدير النظام عند أول تشغيل
    const info = await DB.info();
    const fetchAt = await BF.fetchTime();
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
      console.log(`  قاعدة البيانات  : PostgreSQL — ${info.database} @ ${info.host}:${info.port}`);
      console.log(`  جلب البورصة     : يومياً الساعة ${fetchAt} (Yahoo + بنك مصر)`);
      if (seeded) console.log('  حساب المدير     : admin / admin123  (غيّره بعد أول دخول)');
      console.log('==============================================');
      BF.startScheduler().catch(e => console.error('  ! تعذّر بدء مجدول الجلب: ' + e.message));
      /* تأكد من اكتمال «سمكة اليوم» في محرك التكلفة دون أن يعطّل بدء الخادم */
      CE.flush().catch(e => console.error('  ! تعذّر تهيئة محرك التكلفة: ' + e.message));
    });
  } catch (e) {
    console.error('\n!!! تعذّر الاتصال بقاعدة البيانات PostgreSQL');
    console.error('    ' + e.message);
    console.error('    تأكد أن خدمة postgresql تعمل، وكلمة المرور صحيحة في:');
    console.error('    ' + DB.CONFIG_PATH);
    console.error('    ثم أعد التشغيل.\n');
    process.exit(1);
  }
})();

module.exports = { server, startImportJob, jobs };
