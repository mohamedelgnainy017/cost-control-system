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
const quality = require('./quality');
const A = require('./analytics');
const Auth = require('./auth');
const BE = require('./borse-edit');
const BF = require('./borse-fetch');
const PE = require('./prices-edit');
const CE = require('./cost-engine');
const M = require('./master');

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
  balances: { table: 'balances', label: 'الأرصدة اليومية' },
};
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
function applyColFilters(rows, param) {
  let flt = null;
  try { flt = param ? JSON.parse(param) : null; } catch (_) { flt = null; }
  if (!flt || typeof flt !== 'object' || Array.isArray(flt)) return rows;
  const norm = s => String(s === null || s === undefined ? '' : s).toLowerCase()
    .replace(/[أإآٱ]/g, 'ا').replace(/[ىي]/g, 'ي').replace(/[ةه]/g, 'ه')
    .replace(/[\u064B-\u065F\u0670]/g, '').replace(/[\s,،_()\-]/g, '');
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
      const list = String(r.v === null || r.v === undefined ? '' : r.v).split(/[,،;]/).map(x => norm(x)).filter(Boolean);
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
    const op = r.op || 'contains';
    if (op === 'empty' || op === 'notempty') return true;
    const v = String(r.v === null || r.v === undefined ? '' : r.v).trim();
    const v2 = String(r.v2 === null || r.v2 === undefined ? '' : r.v2).trim();
    return v !== '' || v2 !== '';
  });
  if (!entries.length) return rows;
  return rows.filter(r => entries.every(k => test(r[k], flt[k])));
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
    result: null, error: null, log: [], quality: [],   // quality تُملأ قبل إعلان الاكتمال
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
      /* بعد الاستيراد لا نشغّل الفحص الكامل (12 قاعدة بمسح الجداول كلها —
         1.7 ث اليوم وقد تصبح دقائق مع نمو 40 ألف صف/يوم): نعرض آخر نتائج
         محفوظة فوراً، والفحص الكامل من زر «إعادة الفحص» (صلاحية quality)
         أو جولة ليلية لاحقاً. نعلن الاكتمال بعد تعبئتها لتفادي سباق القراءة. */
      job.stage = 'تحضير نتائج الجودة';
      try {
        job.quality = await quality.listIssues();
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
      overviewCached().catch(() => {});   // تحديث ذاكرة المؤشرات في الخلفية حتى تفتح اللوحة فوراً
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

/**
 * المؤشرات (overview) مُخزَّنة: البيانات لا تتغير إلا بالاستيراد، فنخزّن
 * النتيجة بعد كل استيراد ونتحقق بمطابقة آخر استيراد (MAX(id) من imports).
 * بدون كاش: لوحة المؤشرات تستهلك مسح الجداول كاملة (0.9 ث اليوم، وستطول
 * تدريجياً مع نمو 40 ألف صف/يوم حتى تصبح بالعشرات من الثواني).
 */
async function overviewCached() {
  try {
    const [cache, lastImp, link] = await Promise.all([
      DB.getSetting('overview_cache'),
      DB.get(`SELECT MAX(id) id FROM imports`),
      A.detectCostLink(),
    ]);
    const lastId = lastImp && lastImp.id !== null && lastImp.id !== undefined ? String(lastImp.id) : null;
    if (cache) {
      const c = JSON.parse(cache);
      /* الكاش صالح فقط إن لم يتغيّر آخر استيراد ولا طريقة ربط التكلفة */
      if (c.importId !== undefined && String(c.importId) === lastId && c.costLink === link) return c.data;
    }
    const data = await A.overview();
    await DB.setSetting('overview_cache', JSON.stringify({ importId: lastId, costLink: link, at: new Date().toISOString(), data }));
    return data;
  } catch (e) {
    return A.overview();   // أي فشل في الكاش → حساب مباشر (السلوك القديم)
  }
}

/* ---------- التقارير: مصدر واحد يخدم العرض في المتصفح والتصدير CSV ---------- */
/* hidden: يُبقى التقرير متاحاً للتصدير (CSV) لكنه لا يظهر في قائمة مركز التقارير
   — تُستخدم للتقارير التي استُبدلت بتقارير المبيعات الثلاثة */
const REPORTS = {
  'sales-place': { hidden: true, label: 'مبيعات وربحية حسب المكان', desc: 'الإيراد • التكلفة • مجمل الربح • الهامش', fn: F => A.salesByPlace(F) },
  'sales-item': { hidden: true, label: 'مبيعات وربحية حسب الصنف', desc: 'الإيراد والتكلفة ومجمل الربح لكل صنف', fn: F => A.salesByItem(F, 1000) },
  'sales-month': { hidden: true, label: 'المبيعات والربحية شهرياً', desc: 'اتجاه الإيراد والتكلفة ومجمل الربح الشهري', fn: F => A.salesByMonth(F) },
  'sales-customer': { hidden: true, label: 'المبيعات والربحية حسب العميل', desc: 'الإيراد والتكلفة ومجمل الربح والضريبة لكل عميل', fn: F => A.salesByCustomer(F, 1000) },
  'sales-class': { hidden: true, label: 'المبيعات حسب فئة المستند', desc: 'الفئة والحالة والقيمة الموقّعة', fn: F => A.salesByClass(F) },
  'sales-detail': { label: 'التقرير التفصيلي للمبيعات', desc: 'كل بند بأبعاده: صنف/وحدة قياس/تصنيف/مجموعة/مخزن/وحدة/مكان/شركة', fn: F => A.salesDetail(F) },
  'sales-total-item': { hidden: true, label: 'إجمالي المبيعات على مستوى الصنف', desc: 'الإيراد والتكلفة والربح مجمّعاً لكل صنف', fn: F => A.salesTotalBy(F, 'item').then(r => r.rows) },
  'sales-total-place': { hidden: true, label: 'إجمالي المبيعات حسب المكان', desc: 'كل مكان مع تفصيل الأصناف المباعة تحته', fn: F => A.salesBreakdown(F, 'place').then(r => r.rows) },
  'sales-total-company': { hidden: true, label: 'إجمالي المبيعات حسب الشركة', desc: 'كل شركة مع تفصيل الأصناف المباعة تحتها', fn: F => A.salesBreakdown(F, 'company').then(r => r.rows) },
  'sales-total-cust': { hidden: true, label: 'إجمالي المبيعات حسب العميل', desc: 'كل عميل مع تفصيل الأصناف المباعة له', fn: F => A.salesBreakdown(F, 'cust').then(r => r.rows) },
  'sales-total-storage': { hidden: true, label: 'إجمالي المبيعات حسب المخزن', desc: 'كل مخزن مع تفصيل الأصناف المباعة منه', fn: F => A.salesBreakdown(F, 'storage').then(r => r.rows) },
  'sales-periods': {
    label: 'المبيعات على مستوى الفترات', desc: 'مجموع كل سنة ثم كل شهر (الأشهر = الإجمالي)',
    fn: async F => {
      const p = await A.salesByPeriod(F);
      return [...p.years, ...p.months];
    },
  },
  'costs-month': { hidden: true, label: 'تكلفة المبيعات شهرياً', desc: 'الإجمالي الشهري لتكلفة الوحدات المباعة', fn: F => A.costByMonth(F) },
  /* ---------- تقارير مخازن جديدة (تفصيلي • إجمالي بمستويات • فترات) ----------
      القديمة تبقى مخفية للتصدير فقط */
  'movements-detail': {
    label: 'الحركات التفصيلية', desc: 'كل حركة بأبعادها: تاريخ/صنف/وحدة/توجيه/مخزن/مكان/شركة/نوع — بأرقام صافية',
    fn: F => A.movementsDetail(F),
  },
  'movements-periods': {
    label: 'حركات المخازن بالفترات', desc: 'وارد وصادر وصافي لكل سنة ثم كل شهر',
    fn: async F => { const p = await A.movementsPeriods(F); return [...p.years, ...p.months]; },
  },
  'movements-total-item': { hidden: true, label: 'إجمالي الحركات على مستوى الصنف', desc: 'وارد وصادر وصافي لكل صنف', fn: F => A.movementsBreakdown(F, 'item').then(r => r.rows) },
  'movements-total-place': { hidden: true, label: 'إجمالي الحركات حسب المكان', desc: 'كل مكان مع تفصيل الأصناف', fn: F => A.movementsBreakdown(F, 'place').then(r => r.rows) },
  'movements-total-company': { hidden: true, label: 'إجمالي الحركات حسب الشركة', desc: 'كل شركة مع تفصيل الأصناف', fn: F => A.movementsBreakdown(F, 'company').then(r => r.rows) },
  'movements-total-storage': { hidden: true, label: 'إجمالي الحركات حسب المخزن', desc: 'كل مخزن مع تفصيل الأصناف', fn: F => A.movementsBreakdown(F, 'storage').then(r => r.rows) },
  'movements-total-unit': { hidden: true, label: 'إجمالي الحركات حسب الوحدة', desc: 'كل وحدة مع تفصيل الأصناف', fn: F => A.movementsBreakdown(F, 'unit').then(r => r.rows) },
  'movements-total-dir': { hidden: true, label: 'إجمالي الحركات حسب التوجيه', desc: 'كل توجيه مع تفصيل الأصناف', fn: F => A.movementsBreakdown(F, 'dir').then(r => r.rows) },
  'movements-total-mtype': { hidden: true, label: 'إجمالي الحركات حسب نوع الحركة', desc: 'كل نوع حركة مع تفصيل الأصناف', fn: F => A.movementsBreakdown(F, 'mtype').then(r => r.rows) },
  /* ---------- تقارير أرصدة جديدة (تفصيلي • إجمالي بمستويات • فترات) ---------- */
  'inventory-detail': {
    label: 'الأرصدة التفصيلية', desc: 'كل سجل رصيد: تاريخ/صنف/مخزن/وحدة/مكان/شركة/تصنيف/مجموعة + افتتاحي وختامي وحركة اليوم',
    fn: F => A.inventoryDetail(F),
  },
  'inventory-periods': {
    label: 'أرصدة المخازن بالفترات', desc: 'الرصيد الافتتاحي في أول كل سنة/شهر والختامي في آخرها',
    fn: async F => { const p = await A.inventoryPeriods(F); return [...p.years, ...p.months]; },
  },
  'inventory-total-item': { hidden: true, label: 'إجمالي الأرصدة على مستوى الصنف', desc: 'افتتاحي وختامي لكل صنف', fn: F => A.inventoryBreakdown(F, 'item').then(r => r.rows) },
  'inventory-total-place': { hidden: true, label: 'إجمالي الأرصدة حسب المكان', desc: 'كل مكان مع تفصيل الأصناف', fn: F => A.inventoryBreakdown(F, 'place').then(r => r.rows) },
  'inventory-total-company': { hidden: true, label: 'إجمالي الأرصدة حسب الشركة', desc: 'كل شركة مع تفصيل الأصناف', fn: F => A.inventoryBreakdown(F, 'company').then(r => r.rows) },
  'inventory-total-storage': { hidden: true, label: 'إجمالي الأرصدة حسب المخزن', desc: 'كل مخزن مع تفصيل الأصناف', fn: F => A.inventoryBreakdown(F, 'storage').then(r => r.rows) },
  'inventory-total-unit': { hidden: true, label: 'إجمالي الأرصدة حسب الوحدة', desc: 'كل وحدة مع تفصيل الأصناف', fn: F => A.inventoryBreakdown(F, 'unit').then(r => r.rows) },
  'inventory-total-cls': { hidden: true, label: 'إجمالي الأرصدة حسب التصنيف', desc: 'كل تصنيف مع تفصيل الأصناف', fn: F => A.inventoryBreakdown(F, 'cls').then(r => r.rows) },
  'inventory-total-grp': { hidden: true, label: 'إجمالي الأرصدة حسب المجموعة', desc: 'كل مجموعة مع تفصيل الأصناف', fn: F => A.inventoryBreakdown(F, 'grp').then(r => r.rows) },
  /* تقرير شاشة «المبيعات اليومية» للتصدير: بدون التكلفة + «قيمة البيع للوحدة» */
  'sales-day-detail': { hidden: true, label: 'مبيعات يومية تفصيلية', desc: 'قيمة البيع والكمية وقيمة البيع للوحدة — بدون التكلفة', fn: F => A.salesDaily(F, 'detail').then(r => r.rows) },
  'sales-day-item': { hidden: true, label: 'مبيعات يومية على مستوى الصنف', desc: 'قيمة البيع والكمية وقيمة البيع للوحدة — بدون التكلفة', fn: F => A.salesDaily(F, 'item').then(r => r.rows) },
  'sales-day-place': { hidden: true, label: 'مبيعات يومية على مستوى المكان', desc: 'قيمة البيع والكمية وقيمة البيع للوحدة — بدون التكلفة', fn: F => A.salesDaily(F, 'place').then(r => r.rows) },
  'sales-day-company': { hidden: true, label: 'مبيعات يومية على مستوى الشركة', desc: 'قيمة البيع والكمية وقيمة البيع للوحدة — بدون التكلفة', fn: F => A.salesDaily(F, 'company').then(r => r.rows) },
  'sales-day-cust': { hidden: true, label: 'مبيعات يومية على مستوى العميل', desc: 'قيمة البيع والكمية وقيمة البيع للوحدة — بدون التكلفة', fn: F => A.salesDaily(F, 'cust').then(r => r.rows) },
  'sales-day-storage': { hidden: true, label: 'مبيعات يومية على مستوى المخزن', desc: 'قيمة البيع والكمية وقيمة البيع للوحدة — بدون التكلفة', fn: F => A.salesDaily(F, 'storage').then(r => r.rows) },
  'movements-direction': { hidden: true, label: 'الحركات حسب التوجيه', desc: 'وارد وصادر لكل توجيه', fn: F => A.movementsByDirection(F) },
  'movements-month': { hidden: true, label: 'الحركات شهرياً', desc: 'تدفق الوارد والصادر شهرياً', fn: F => A.movementsByMonth(F) },
  'movements-place': { hidden: true, label: 'الحركات حسب المكان', desc: 'الوارد والصادر لكل وحدة', fn: F => A.movementsByPlace(F) },
  'movements-items': { hidden: true, label: 'أعلى الأصناف حركةً', desc: 'الأصناف الأعلى حركةً بالقيمة', fn: F => A.topMovementItems(F, 200) },
  'inventory-place': { hidden: true, label: 'المخزون حسب المكان', desc: 'الافتتاحي والختامي لكل مكان', fn: F => A.inventoryByPlace(F) },
  'inventory-class': { hidden: true, label: 'المخزون حسب التصنيف', desc: 'توزيع قيمة المخزون على التصنيفات', fn: F => A.inventoryByClass(F) },
  'reconcile': { label: 'مطابقة الأرصدة', desc: 'رصيد نهاية كل تاريخ سابق مقابل بداية التاريخ التالي', fn: () => DB.all('SELECT * FROM recon ORDER BY ABS(diff_val) DESC') },
  'quality': { label: 'جودة البيانات', desc: 'كل الملاحظات والفحوص', fn: () => quality.listIssues() },
  'borse-latest': { label: 'أسعار البورصة الأخيرة', desc: 'آخر سعر لكل صنف مع التغير', fn: () => A.borseLatest() },
  'borse-raw': {
    label: 'سجل البورصة اليومي (خام)', desc: 'كل التسجيلات اليومية كما في الملف',
    fn: () => DB.all(`SELECT borse_date, contract, item_code, item, low, high, close, basis, borse_now,
             usd_rate, down_payment, fees, fx_factor, cost_price
             FROM borse ORDER BY borse_date DESC, item`),
  },
  /* ---------- التقارير الخام: كل الأعمدة وكل الصفوف كما في قاعدة البيانات ----------
     «بدون قائمة أعمدة صريحة» حتى أي عمود جديد في الجدول يظهر تلقائياً */
  'sales-raw': {
    label: 'بيانات المبيعات الخام', desc: 'كل بنود المبيعات وكل أعمدتها', raw: true,
    fn: () => DB.all(`SELECT * FROM sales ORDER BY id`),
  },
  'movements-raw': {
    label: 'بيانات الحركات الخام', desc: 'كل حركات المخزون وكل أعمدتها', raw: true,
    fn: () => DB.all(`SELECT * FROM movements ORDER BY id`),
  },
  'balances-raw': {
    label: 'بيانات الأرصدة الخام', desc: 'كل أرصدة المخزون وكل أعمدتها', raw: true,
    fn: () => DB.all(`SELECT * FROM balances ORDER BY id`),
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

  /* ---------- صلاحيات الشاشات (يضبطها المدير لكل دور) ---------- */
  'GET /api/tabs': async (q, res, body, req, me) => ok(res, {
    tabs: TABS,
    perms: { admin: TAB_IDS.slice(), accountant: await tabsOf('accountant'), viewer: await tabsOf('viewer') },
  }),

  'POST /api/tabs/save': async (q, res, body) => {
    const src = (body && body.perms) || {};
    const clean = {};
    for (const role of ['accountant', 'viewer']) {
      const arr = Array.isArray(src[role]) ? src[role].map(String) : [];
      clean[role] = TAB_IDS.filter(t => arr.includes(t));   // ترشيح صارم ضد أي مدخلات غير معروفة
    }
    await DB.setSetting('tab_perms', JSON.stringify(clean));
    ok(res, { perms: { admin: TAB_IDS.slice(), ...clean } });
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

  'POST /api/md/items/save': check(async (q, res, body) => ok(res, await M.saveItem(body || {}))),

  'POST /api/md/items/sync': check(async (q, res) => ok(res, await M.syncFromMovements())),

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

  /* ---------- البيانات الأساسية: أنواع الحركات ---------- */
  'GET /api/md/mtypes': check(async (q, res) => ok(res, await M.listMtypes({ q: q.get('q'), catFrom: q.get('cat_from'), catTo: q.get('cat_to') }))),

  'POST /api/md/mtypes/save': check(async (q, res, body) => ok(res, await M.saveMtype(body || {}))),

  'POST /api/md/mtypes/delete': check(async (q, res, body) => ok(res, await M.deleteMtype(body || {}))),

  'GET /api/md/mtypes/categories': check(async (q, res) => ok(res, await M.listCategories())),

  'POST /api/md/mtypes/category/save': check(async (q, res, body) => ok(res, await M.saveCategory(body || {}))),

  'POST /api/md/mtypes/category/delete': check(async (q, res, body) => ok(res, await M.deleteCategory(body || {}))),

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

  'GET /api/overview': async (q, res) => {
    const F = A.parseFilters(q);
    ok(res, A.hasFilters(F) ? await A.overview(F) : await overviewCached());
  },

  'GET /api/quality': async (q, res) => {
    if (q.get('run') === '1') await quality.runRules();
    ok(res, await quality.listIssues(A.parseFilters(q)));
  },

  'GET /api/reconcile': async (q, res) => ok(res, await A.reconcile({
    limit: Number(q.get('limit') || 100),
    offset: Number(q.get('offset') || 0),
    onlyMismatch: q.get('all') !== '1',
    F: A.parseFilters(q),
  })),

  'GET /api/dims': async (q, res) => ok(res, await A.dims(q)),

  /* تقرير شاشة المبيعات اليومية: تفصيلي/صنف/مكان/شركة/عميل — بدون التكلفة + قيمة البيع للوحدة */
  'GET /api/sales/day': async (q, res) => ok(res, await A.salesDaily(A.parseFilters(q), q.get('by') || 'detail', Number(q.get('limit') || 20000))),

  /* طريقة ربط التكلفة بالمبيعات (المستند المرجع + الصنف / المكان) */
  'POST /api/settings/cost': check(async (q, res, body) => {
    const r = await A.setCostLink((body && body.link) || '');
    await DB.delSetting('overview_cache');   // تغيير الطريقة يغيّر أرقام المؤشرات → لا كاش قديم
    ok(res, r);
  }),

  'GET /api/movements/report': async (q, res) => ok(res, await A.movementsReport(A.parseFilters(q), Number(q.get('limit') || 2000))),

  /* ---------- تقارير مخازن: تفصيلي • إجمالي (بمستوى) • فترات ---------- */
  'GET /api/movements/detail': async (q, res) => ok(res, await A.movementsDetail(A.parseFilters(q), Number(q.get('limit') || 20000))),
  'GET /api/movements/total': async (q, res) => ok(res, await A.movementsBreakdown(A.parseFilters(q), q.get('by') || 'place', Number(q.get('limit') || 20000))),
  'GET /api/movements/periods': async (q, res) => ok(res, await A.movementsPeriods(A.parseFilters(q))),

  'GET /api/inventory/place': async (q, res) => ok(res, await A.inventoryByPlace(A.parseFilters(q))),
  'GET /api/inventory/class': async (q, res) => ok(res, await A.inventoryByClass(A.parseFilters(q))),

  /* ---------- تقارير أرصدة: تفصيلي • إجمالي (بمستوى) • فترات ---------- */
  'GET /api/inventory/detail': async (q, res) => ok(res, await A.inventoryDetail(A.parseFilters(q), Number(q.get('limit') || 20000))),
  'GET /api/inventory/total': async (q, res) => ok(res, await A.inventoryBreakdown(A.parseFilters(q), q.get('by') || 'place', Number(q.get('limit') || 20000))),
  'GET /api/inventory/periods': async (q, res) => ok(res, await A.inventoryPeriods(A.parseFilters(q))),
  'GET /api/span': async (q, res) => ok(res, await A.dateSpan()),

  /* ---------- البورصة اليومية ---------- */
  'GET /api/borse': async (q, res) => {
    const days = Number(q.get('days') || 120);
    const item = q.get('item') || '';
    const [summary, latest, series, usd, recent] = await Promise.all([
      A.borseSummary(), A.borseLatest(), A.borseSeries({ days, item }),
      A.borseUsd(days), A.borseRecent(60),
    ]);
    ok(res, { days, item, summary, latest, series, usd, recent });
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

  'POST /api/costs/rebuild': async (q, res, body) => {
    const full = !body || body.full !== false;
    const r = full ? await CE.rebuildAll() : await CE.flush();
    ok(res, { ...r, status: await CE.status() });
  },

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
      password: pw || undefined, only: [cat], asSource: as || undefined,
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
      FROM imports WHERE dataset = $1
      GROUP BY file_name, file_path`, [cat]);
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
    const agg = { movements: 0, sales: 0, balances: 0, prices: 0 };
    for (const tbl of ['movements', 'sales', 'balances', 'prices']) {
      const r = await DB.get(`SELECT COUNT(*)::int c FROM ${tbl} WHERE ${cond(tbl)}`, [p]);
      if (r.c > 0) { await DB.run(`DELETE FROM ${tbl} WHERE ${cond(tbl)}`, [p]); agg[tbl] = r.c; }
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
    const isRaw = !!def.raw || String(name).endsWith('-raw');
    const rows = await def.fn(F);
    /* فلترة فلاتر رؤوس الأعمدة القادمة من الواجهة (التقارير الخام) — في الذاكرة قبل الترقيم */
    const base = isRaw ? applyColFilters(rows, q.get('cols')) : rows;
    /* التقارير الخام: ترقيم صفحات على مستوى الذاكرة (offset/limit)
       حتى لا تُجَمّد الشاشة بعشرات الآلاف من الصفوف في جدول واحد.
       pageSize الافتراضي 1000 صف — والتصدير CSV يظل كامل الصفوف. */
    if (isRaw) {
      const size = Math.min(5000, Math.max(1, Number(q.get('pageSize') || 1000)));
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
    const rows = await def.fn(F);
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
  { id: 'inventory', label: 'المخزون والمطابقة' },
  { id: 'sales', label: 'المبيعات والربحية' },
  { id: 'movements', label: 'الحركات' },
  { id: 'borse', label: 'البورصة اليومية' },
  { id: 'prices', label: 'الأسعار اليومية' },
  { id: 'costs', label: 'التكلفة اليومية' },
  { id: 'quality', label: 'جودة البيانات' },
  { id: 'reports', label: 'التقارير' },
];
const TAB_IDS = TABS.map(t => t.id);
const TAB_LABEL = Object.fromEntries(TABS.map(t => [t.id, t.label]));
/* الافتراضي قبل أي تعديل من المدير: لوحة التحكم (المستخدمون والصلاحيات) للمدير فقط،
   والبقية للمحاسب كاملاً، والمشاهد للشاشات كلها عدا لوحة التحكم.
   الاستيراد ليس شاشة (أُزيل التبويب العام) بل صلاحية تُفعِّل أزرار الاستيراد اليومي. */
const DEFAULT_TABS = {
  admin: TAB_IDS.slice(),
  accountant: TAB_IDS.filter(t => t !== 'dashboard'),
  viewer: TAB_IDS.filter(t => t !== 'dashboard'),
};
async function tabsOf(role) {
  if (role === 'admin') return TAB_IDS.slice();
  try {
    const raw = await DB.getSetting('tab_perms');
    const saved = raw ? JSON.parse(raw) : null;
    if (saved && Array.isArray(saved[role]))
      return TAB_IDS.filter(t => saved[role].includes(t));
  } catch (_) { /* إعداد تالف → الافتراضي */ }
  return (DEFAULT_TABS[role] || TAB_IDS).slice();
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
  ['/api/inventory', ['inventory']],
  ['/api/reconcile', ['inventory']],
  ['/api/sales', ['sales']],
  ['/api/movements', ['movements']],
  ['/api/borse', ['borse']],
  ['/api/prices', ['prices']],
  ['/api/costs', ['costs']],
  ['/api/quality', ['quality']],
  ['/api/reports', ['reports']],
  ['/api/report', ['reports']],
  ['/api/export', ['reports']],
];

/* ---------- المصادقة ---------- */
async function pubUser(u) {
  const r = Auth.ROLES[u.role];
  return {
    id: u.id, username: u.username, full_name: u.full_name || '',
    role: u.role, roleLabel: Auth.roleLabel(u.role),
    mustChange: !!u.must_change,
    perms: r ? r.perms : [],
    tabs: await tabsOf(u.role),
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
  'POST /api/daily/save': 'import',
  'POST /api/daily/delete': 'import',
  'POST /api/borse/fetch': 'sync',
  'POST /api/borse/override': 'sync',
  'POST /api/borse/override/delete': 'sync',
  'POST /api/prices/override': 'sync',
  'POST /api/prices/override/delete': 'sync',
  'POST /api/costs/rebuild': 'sync',
  'POST /api/settings/cost': 'master',
  'GET /api/users': 'users',
  'POST /api/users': 'users',
  'POST /api/users/update': 'users',
  'POST /api/users/delete': 'users',
  'POST /api/tabs/save': 'users',
  /* البيانات الأساسية: الإضافة والتعديل بصلاحية master */
  'POST /api/md/items/save': 'master',
  'POST /api/md/items/sync': 'master',
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
  'POST /api/md/mtypes/save': 'master',
  'POST /api/md/mtypes/delete': 'master',
  'POST /api/md/mtypes/category/save': 'master',
  'POST /api/md/mtypes/category/delete': 'master',
};

const PERM_LABEL = {
  import: 'استيراد', sync: 'جلب البورصة والتعديل اليدوي على الأسعار',
  quality: 'إعادة فحص الجودة', users: 'إدارة المستخدمين',
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
    if (key === 'GET /api/quality' && u.searchParams.get('run') === '1') need = 'quality';
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
        const allowed = await tabsOf(me.role);
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
          analysis = analyzePreviewDeep(staged, { maxRows: 8, only: [cat], password: pw || undefined });
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
