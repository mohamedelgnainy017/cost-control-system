'use strict';
/**
 * مصادر بيانات Workflow Studio — مبنية على فهرس البيانات الموحّد
 * ============================================================
 * - القائمة البيضاء = **فهرس البيانات** (src/data-catalog.js): كل مصدر هناك له
 *   معرّف ثابت ووصف وحقول ومستوى تفصيل وصلاحية. لا SQL ولا أسماء جداول ولا
 *   دوال حرة من المستخدم إطلاقًا.
 * - الفلاتر محققة النوع ومحصورة بالحدود، وتُمرَّر كمعاملات معلَّمة إلى دوال
 *   analytics الموجودة — لا يُبنى نص استعلام هنا.
 * - صلاحية القراءة (Auth.can) تُفحص **قبل** أي استدعاء لجلب البيانات.
 * - وضع الاختبار (WORKFLOW_TEST_MODE=1) لا يتصل بقاعدة البيانات إطلاقًا:
 *   المصادر الحقيقية مرفوضة فيه ويبقى المصدر التجريدي (synthetic) فقط.
 * - لا استدعاء ولا استيراد لأي وحدة كتابة أو لطبقة الجلب الخارجي أو محرك التكلفة.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./analytics');
const Auth = require('./auth');
const CAT = require('./data-catalog');
const X = require('./xlsx-reader');

const MAX_DAYS = 365;      // سقف النطاق الزمني المطلوب من المزوّد
const MAX_ITEM = 40;       // طول حقل الصنف (نص فقط — يمرَّر معلَّمًا $3 في borseSeries)
const ROW_LIMIT = 5000;    // الحد الأقصى للصفوف المُمرَّرة
const DIAG_MAX_FILES = 50; // سقف ملفات Excel في تقرير التشخيص
const DIAG_MAX_SHEETS = 200; // سقف أوراق العمل في تقرير التشخيص للمحرك
const FILE_PREFIX = 'file:';
const FILE_EXT = ['.xlsx', '.xlsm', '.xlsb', '.xls', '.csv', '.txt'];
const WORKBOOK_PREFIX = 'workbook:';
const WORKBOOK_EXT = ['.xlsx', '.xlsm', '.xlsb', '.xls'];
const WORKBOOK_PERM = 'import'; // نفس صلاحية الاستيراد القائمة — لا نموذج صلاحيات جديد

/* المصدر الاصطناعي (ذاكرة) — خارج القائمة البيضاء لأنه لا يقرأ قاعدة بيانات إطلاقًا.
   يُدار من هذه الوحدة ليكون عقدًا واحدًا لما تعرضه واجهة البناء. */
const SYNTHETIC_NAME = 'synthetic';
const SYNTHETIC_LABEL = 'بيانات تجريبية (synthetic)';

/* وصف/أنواع الحقول للـfixture (مصدر الحقيقة: W.syntheticFixture) */
const SYNTHETIC_DESCRIPTIONS = { id: 'معرّف الطلب', customerId: 'معرّف العميل', qty: 'الكمية', price: 'السعر', note: 'ملاحظة' };
const SYNTHETIC_TYPES = { id: 'number', customerId: 'number', qty: 'number', price: 'number', note: 'string' };

/* مراجع أحراج القص/التنبيه */
const TRUNCATE_NOTE = (total, limit) =>
  'تم اقتطاع النتائج من ' + total + ' إلى ' + limit + ' صف — الحد الأقصى المسموح للمصدر';
const EMPTY_NOTE = 'المصدر أعاد صفر صفوف في النطاق المحدد';

/**
 * تحقق إعدادات المصدر محققة النوع.
 * @returns {{days:number, item:string}} القيم المطباة
 * @throws عند قيم سليمة النوع لكن ملظّعة الصياغة، فيلزم رسالة واضحة للمستخدم
 */
function normSettings(settings, notes) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const out = {};
  const days = Number(s.days);
  if (s.days === undefined || s.days === null || String(s.days).trim() === '') {
    out.days = 120;                      // defaultValue مبوّب العمل ساكن مع شاشة البورصة
  } else if (!Number.isFinite(days) || days < 1) {
    throw new Error('إعدادات المصدر: days يجب أن يكون عدداً صحيحاً ≥ 1');
  } else if (days > MAX_DAYS) {
    out.days = MAX_DAYS;
    notes.push('أيام DataSource ' + days + ' أكبر من الحد — تم تقييدها إلى ' + MAX_DAYS);
  } else {
    out.days = Math.floor(days);
  }
  if (s.item === undefined || s.item === null || String(s.item).trim() === '') {
    out.item = '';
  } else {
    const it = String(s.item);
    if (it.length > MAX_ITEM) throw new Error('إعدادات DataSource: item أطول من الحد (' + MAX_ITEM + ' خانة)');
    out.item = it;
  }
  /* نافذة اختيارية: من/إلى — تُستخدم في مصادر لها تاريخ */
  const from = s.from === undefined || s.from === null ? '' : String(s.from).slice(0, 10);
  const to = s.to === undefined || s.to === null ? '' : String(s.to).slice(0, 10);
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error('إعدادات المصدر: from يجب أن يكون تاريخاً YYYY-MM-DD');
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('إعدادات المصدر: to يجب أن يكون تاريخاً YYYY-MM-DD');
  out.from = from;
  out.to = to;
  out.limit = Math.max(1, Math.min(Number(s.limit) || ROW_LIMIT, ROW_LIMIT));
  return out;
}

/**
 * القائمة البيضاء للمصادر القابلة للتشغيل — مشتقّة من فهرس البيانات:
 * مصدر مُنفَّذ فقط (له مسار قراءة فعلي). لا مصدر واحد مخصّص لكل شاشة.
 */
const DATASETS = {};
for (const s of CAT.runnableSources()) {
  if (s.id === SYNTHETIC_NAME) continue;
  DATASETS[s.id] = {
    label: s.label,
    perm: s.perm,
    domain: s.domain,
    description: s.description,
    grain: s.grain,
    rowKey: s.rowKey,
    timeGrain: s.timeGrain,
    canonical: !!s.canonical,
    canonicalNote: s.canonicalNote || '',
    quickReport: s.quickReport !== false,
    columns: s.fields.map(f => f.name),
    types: Object.fromEntries(s.fields.map(f => [f.name, f.type])),
    descriptions: Object.fromEntries(s.fields.map(f => [f.name, f.description])),
    fetch: st => s.fetch(st),
  };
}

/** هل تعريف workflow يستخدم مصدر بيانات حقيقية (وليس memory/اصطناعي)؟ */
function isDataset(wf) {
  return !!(wf && wf.source && wf.source.type === 'dataset');
}
function isFileSource(wf) {
  return !!(wf && wf.source && wf.source.type === 'file');
}
function isWorkbookSource(wf) {
  return !!(wf && wf.source && wf.source.type === 'workbook');
}

/* ---------- مصادر ملفات محلية (وضع الاختبار فقط) ----------
 * لا مسار حر من المستخدم: مجلد واحد مسموح، أسماء ملفات فقط، امتدادات محددة،
 * ومنع الخروج من المجلد عبر realpath. لا يُفعّل في الإنتاج إطلاقًا. */
function fileSourceRoot() {
  if (process.env.WORKFLOW_TEST_MODE !== '1') return '';
  const raw = process.env.WORKFLOW_FILE_SOURCE_DIR || path.join(os.tmpdir(), 'ccs-workflow-sources');
  try { return fs.realpathSync(path.resolve(raw)); } catch (_) { return ''; }
}

function fileSourceName(file, sheet) {
  return FILE_PREFIX + file + (sheet ? '#' + sheet : '');
}

function listFileSources() {
  const root = fileSourceRoot();
  if (!root || !fs.existsSync(root)) return { items: [], root: null, testOnly: true };
  const items = [];
  for (const f of fs.readdirSync(root)) {
    const ext = path.extname(f).toLowerCase();
    if (!FILE_EXT.includes(ext)) continue;
    const full = path.join(root, f);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (!st.isFile()) continue;
    let sheets = [];
    if (ext === '.csv' || ext === '.txt') {
      sheets = [''];
    } else {
      try {
        const wb = X.readWorkbook(full, { sheetRows: 2, noCom: true });
        sheets = wb.map(s => s.name);
      } catch (_) { sheets = []; }
    }
    if (!sheets.length) sheets = [''];
    for (const sh of sheets) {
      items.push({
        name: fileSourceName(f, sh),
        label: f + (sh ? ' — ' + sh : ''),
        file: f, sheet: sh, size: st.size,
        domain: 'files', grain: 'ملف محلي', canonical: false,
        testOnly: true,
      });
    }
  }
  return { items, root, testOnly: true };
}

function inferFileType(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'string';
}

function rowsFromMatrix(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  let headerIdx = rows.findIndex(r => Array.isArray(r) && r.some(v => v !== null && v !== undefined && String(v).trim() !== ''));
  if (headerIdx < 0) return { rows: [], columns: [] };
  const header = rows[headerIdx];
  const used = new Set();
  const columns = header.map((h, i) => {
    let name = h === null || h === undefined ? '' : String(h).trim();
    if (!name) name = 'col' + (i + 1);
    let base = name, n = 2;
    while (used.has(name)) name = base + '_' + (n++);
    used.add(name);
    return name;
  });
  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r) || !r.some(v => v !== null && v !== undefined && v !== '')) continue;
    const o = {};
    columns.forEach((c, j) => { o[c] = r[j] === undefined ? null : r[j]; });
    out.push(o);
  }
  return { rows: out, columns };
}

/**
 * حسم ملف محلي إلى صفوف/أعمدة. متاح فقط عند WORKFLOW_TEST_MODE=1.
 * @param {{name:string}} source اسم بصيغة file:<basename>[#<sheet>]
 */
async function resolveFileSource(source) {
  const root = fileSourceRoot();
  if (!root) return fail(403, 'مصادر الملفات المحلية معطلة خارج وضع الاختبار');
  const raw = String((source && source.name) || '').replace(/^file:/, '');
  const hash = raw.lastIndexOf('#');
  const file = hash >= 0 ? raw.slice(0, hash) : raw;
  const sheet = hash >= 0 ? raw.slice(hash + 1) : '';
  if (!file || file !== path.basename(file) || /[\\/]/.test(file) || file.indexOf('..') >= 0) {
    return fail(400, 'اسم ملف غير صالح — يُسمح باسم ملف داخل مجلد المصادر فقط');
  }
  const ext = path.extname(file).toLowerCase();
  if (!FILE_EXT.includes(ext)) return fail(400, 'امتداد ملف غير مدعوم: ' + ext);
  let full;
  try { full = fs.realpathSync(path.join(root, file)); }
  catch (_) { return fail(404, 'الملف غير موجود في مجلد المصادر: ' + file); }
  if (full !== root && full.indexOf(root + path.sep) !== 0) return fail(403, 'مسار الملف خارج مجلد المصادر المسموح');
  let wb;
  /* +2: صف العنوان + صف إضافي يثبت تجاوز الحد (وإلا تعذّر كشف الاقتطاع عند 5001 صفًا) */
  try { wb = X.readWorkbook(full, { sheetRows: ROW_LIMIT + 2, noCom: true }); }
  catch (e) { return fail(400, 'تعذّر قراءة الملف: ' + ((e && e.message) || 'خطأ غير معروف')); }
  const chosen = sheet ? wb.find(s => s.name === sheet) : wb[0];
  if (!chosen) return fail(404, 'ورقة العمل غير موجودة: ' + sheet);
  const parsed = rowsFromMatrix(chosen.rows);
  const isPlain = ext === '.csv' || ext === '.txt';
  const sheetLabel = isPlain ? '' : (chosen.name || '');
  const notes = ['مصدر ملف محلي (وضع الاختبار فقط): ' + file + (sheetLabel ? ' — ' + sheetLabel : '')];
  let rows = parsed.rows;
  const truncated = rows.length > ROW_LIMIT;
  if (truncated) {
    notes.push(TRUNCATE_NOTE(rows.length, ROW_LIMIT));
    rows = rows.slice(0, ROW_LIMIT);
  }
  if (!rows.length) notes.push(EMPTY_NOTE);
  const columns = parsed.columns.length ? parsed.columns : (rows.length ? Object.keys(rows[0]) : []);
  const types = {};
  for (const c of columns) {
    const found = rows.find(r => r[c] !== null && r[c] !== undefined);
    types[c] = found ? inferFileType(found[c]) : 'string';
  }
  return {
    ok: true, status: 200,
    data: { sourceData: rows, sourceColumns: columns },
    rows, columns,
    fields: columns.map(c => ({ name: c, type: types[c], description: '' })),
    sample: rows.slice(0, 8),
    notes,
    source: { name: fileSourceName(file, sheetLabel), label: file + (sheetLabel ? ' — ' + sheetLabel : ''), domain: 'files', grain: 'ملف محلي', canonical: false },
    truncated, limit: ROW_LIMIT,
  };
}

/* ---------- مصادر Excel حقيقية (قراءة فقط) ----------
 * ليست بديلًا عن الاستيراد ولا تكتب أي ملف. تُفعّل فقط عندما يضبط المشغّل
 * WORKFLOW_WORKBOOK_DIR على مجلد محصور؛ الاسم يُقبل كاسم ملف فقط، والقراءة
 * تمرّ عبر realpath containment. في الإنتاج تُشترط صلاحية الاستيراد القائمة.
 * الصيغ المدعومة: xlsx/xlsm/xlsb/xls. CSV يبقى في مصدر الملفات الاختباري. */
function workbookConfigStatus() {
  const raw = String(process.env.WORKFLOW_WORKBOOK_DIR || '').trim();
  if (!raw) {
    return {
      configured: false, code: 'unset', root: null, fileCount: 0,
      reason: 'مصدر Excel غير مهيأ — اضبط WORKFLOW_WORKBOOK_DIR على مجلد قراءة مخصص ثم أعد تشغيل الخادم.',
    };
  }
  let root;
  try {
    root = fs.realpathSync(path.resolve(raw));
  } catch (_) {
    return {
      configured: true, code: 'missing', root: null, fileCount: 0,
      reason: 'مجلد WORKFLOW_WORKBOOK_DIR غير موجود أو لا يمكن الوصول إليه: ' + raw,
    };
  }
  let st;
  try { st = fs.statSync(root); } catch (_) {
    return {
      configured: true, code: 'inaccessible', root: null, fileCount: 0,
      reason: 'تعذّر الوصول إلى مجلد WORKFLOW_WORKBOOK_DIR: ' + root,
    };
  }
  if (!st.isDirectory()) {
    return {
      configured: true, code: 'not-directory', root: null, fileCount: 0,
      reason: 'WORKFLOW_WORKBOOK_DIR يشير إلى ملف وليس مجلدًا: ' + root,
    };
  }
  let names;
  try { names = fs.readdirSync(root); } catch (_) {
    return {
      configured: true, code: 'inaccessible', root: null, fileCount: 0,
      reason: 'المجلد موجود لكن لا توجد صلاحية قراءته: ' + root,
    };
  }
  const files = names.filter(f => WORKBOOK_EXT.includes(path.extname(f).toLowerCase()));
  if (!files.length) {
    return {
      configured: true, code: 'empty', root, fileCount: 0,
      reason: 'المجلد المهيأ لا يحتوي أي ملف Excel مدعوم (' + WORKBOOK_EXT.join('، ') + '): ' + root,
    };
  }
  return { configured: true, code: 'ready', root, fileCount: files.length, reason: '' };
}

function workbookSourceRoot() {
  const s = workbookConfigStatus();
  return (s.code === 'ready' || s.code === 'empty') ? s.root : '';
}

function workbookAuthorized(me) {
  return process.env.WORKFLOW_TEST_MODE === '1' || Auth.can(me, WORKBOOK_PERM);
}

function encodeSheetPart(sheet) {
  return String(sheet || '').replace(/%/g, '%25').replace(/#/g, '%23');
}
function decodeSheetPart(sheet) {
  return String(sheet || '').replace(/%23/g, '#').replace(/%25/g, '%');
}

function workbookSourceName(file, sheet) {
  return WORKBOOK_PREFIX + file + (sheet ? '#' + encodeSheetPart(sheet) : '');
}

/** قائمة ملفات Excel المتاحة — وصف فقط، بلا تحميل بيانات كاملة */
function listWorkbookSources(me) {
  const status = workbookConfigStatus();
  if (status.code === 'unset' || status.code === 'missing' || status.code === 'not-directory' || status.code === 'inaccessible') {
    return {
      items: [], configured: status.configured, readOnly: true,
      status: status.code, reason: status.reason, root: status.root || null, fileCount: status.fileCount || 0,
    };
  }
  const root = status.root;
  if (!workbookAuthorized(me)) {
    return {
      items: [], configured: true, denied: true, readOnly: true,
      status: 'denied', root, fileCount: status.fileCount || 0,
      reason: 'ليس لديك صلاحية قراءة ملفات Excel — صلاحية الاستيراد (import) مطلوبة.',
    };
  }
  const items = [];
  let unreadable = 0;
  for (const f of fs.readdirSync(root)) {
    const ext = path.extname(f).toLowerCase();
    if (!WORKBOOK_EXT.includes(ext)) continue;
    const full = path.join(root, f);
    let st;
    try { st = fs.statSync(full); } catch (_) { unreadable++; continue; }
    if (!st.isFile()) continue;
    let sheets = [];
    try {
      const wb = X.readWorkbook(full, { sheetRows: 2, noCom: true });
      sheets = wb.map(s => s.name).filter(Boolean);
    } catch (_) { sheets = []; unreadable++; }
    if (!sheets.length) continue;
    for (const sh of sheets) {
      items.push({
        name: workbookSourceName(f, sh),
        label: f + ' — ' + sh,
        file: f, sheet: sh, size: st.size,
        domain: 'workbooks', grain: 'ملف Excel', canonical: false,
        readOnly: true,
        testOnly: process.env.WORKFLOW_TEST_MODE === '1',
      });
    }
  }
  items.sort((a, b) => a.label.localeCompare(b.label, 'ar', { numeric: true }));
  if (!items.length) {
    return {
      items: [], configured: true, readOnly: true,
      status: status.code === 'empty' ? 'empty' : 'no-sheets',
      root, fileCount: status.fileCount || 0,
      reason: status.code === 'empty'
        ? status.reason
        : 'ملفات Excel موجودة لكن لا توجد أوراق عمل قابلة للقراءة'
          + (unreadable ? ' (تعذّر قراءة ' + unreadable + ' ملفًا)' : '') + '.',
    };
  }
  return {
    items, configured: true, readOnly: true,
    status: 'ready', root, fileCount: status.fileCount || 0, sheetCount: items.length,
    reason: unreadable ? ('تعذّر قراءة ' + unreadable + ' ملف Excel — بقية الأوراق متاحة.') : '',
  };
}

/**
 * تشخيص مجلد Excel — وصف فقط (أسماء/أحجام/أبعاد)، بلا إرجاع صفوف أو قيم.
 * يقرأ بحد ROW_LIMIT+2 لاكتشاف الاقتطاع (عنوان + صف زائد)، ويحدّ عدد الملفات/الأوراق لحماية الخادم.
 * لا يتصل بقاعدة البيانات، ويخضع لنفس صلاحية قراءة ملفات Excel.
 */
function workbookDiagnostics(me) {
  const status = workbookConfigStatus();
  const ready = status.code === 'ready' || status.code === 'empty';
  if (!ready) {
    return {
      ok: false, status: status.code, configured: status.configured,
      root: status.root || null, readOnly: true,
      reason: status.reason || 'مصدر Excel غير مهيأ',
      limits: { files: DIAG_MAX_FILES, sheets: DIAG_MAX_SHEETS, rowsPerSheet: ROW_LIMIT },
      summary: { files: 0, sheets: 0, emptySheets: 0, truncatedSheets: 0, unreadableFiles: 0, rows: 0 },
      files: [],
    };
  }
  if (!workbookAuthorized(me)) {
    return {
      ok: false, status: 'denied', configured: true, denied: true,
      root: status.root, readOnly: true,
      reason: 'ليس لديك صلاحية قراءة ملفات Excel — صلاحية الاستيراد (import) مطلوبة.',
      limits: { files: DIAG_MAX_FILES, sheets: DIAG_MAX_SHEETS, rowsPerSheet: ROW_LIMIT },
      summary: { files: 0, sheets: 0, emptySheets: 0, truncatedSheets: 0, unreadableFiles: 0, rows: 0 },
      files: [],
    };
  }
  const root = status.root;
  let names;
  try { names = fs.readdirSync(root); }
  catch (_) {
    return {
      ok: false, status: 'inaccessible', configured: true, root, readOnly: true,
      reason: 'تعذّرت قراءة مجلد المصادر.',
      limits: { files: DIAG_MAX_FILES, sheets: DIAG_MAX_SHEETS, rowsPerSheet: ROW_LIMIT },
      summary: { files: 0, sheets: 0, emptySheets: 0, truncatedSheets: 0, unreadableFiles: 0, rows: 0 },
      files: [],
    };
  }
  const candidates = names
    .filter(f => WORKBOOK_EXT.includes(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'ar', { numeric: true }));
  const files = [];
  const summary = { files: 0, sheets: 0, emptySheets: 0, truncatedSheets: 0, unreadableFiles: 0, rows: 0 };
  let sheetBudget = DIAG_MAX_SHEETS;
  for (const file of candidates) {
    if (files.length >= DIAG_MAX_FILES || sheetBudget <= 0) break;
    const full = path.join(root, file);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (!st.isFile()) continue;
    summary.files += 1;
    let wb;
    /* +2: صف العنوان + صف إضافي يثبت تجاوز الحد */
    try { wb = X.readWorkbook(full, { sheetRows: ROW_LIMIT + 2, noCom: true }); }
    catch (e) {
      summary.unreadableFiles += 1;
      files.push({ file, size: st.size, ok: false, error: 'تعذّرت قراءة الملف: ' + ((e && e.message) || 'خطأ غير معروف'), sheets: [] });
      continue;
    }
    const sheets = [];
    for (const sh of wb) {
      if (sheetBudget <= 0) break;
      sheetBudget -= 1;
      const parsed = rowsFromMatrix(sh.rows);
      const rawRows = parsed.rows.length;
      const truncated = rawRows > ROW_LIMIT;
      const rowCount = truncated ? ROW_LIMIT : rawRows;
      const columns = parsed.columns.slice(0, 100);
      const item = {
        name: String(sh.name || ''),
        rowCount,
        rawRowCount: rawRows,
        columnCount: columns.length,
        columns,
        truncated,
        empty: rowCount === 0,
        readOnly: true,
      };
      if (item.empty) summary.emptySheets += 1;
      if (truncated) summary.truncatedSheets += 1;
      summary.sheets += 1;
      summary.rows += rowCount;
      sheets.push(item);
    }
    files.push({ file, size: st.size, ok: true, sheets });
  }
  return {
    ok: true,
    status: summary.sheets ? 'ready' : (status.code === 'empty' ? 'empty' : 'no-sheets'),
    configured: true, root, readOnly: true,
    generatedAt: new Date().toISOString(),
    limits: { files: DIAG_MAX_FILES, sheets: DIAG_MAX_SHEETS, rowsPerSheet: ROW_LIMIT },
    summary,
    files,
    reason: summary.sheets
      ? (summary.unreadableFiles ? ('تعذّرت قراءة ' + summary.unreadableFiles + ' ملف — بقية الملفات مشخّصة.') : '')
      : 'لا توجد أوراق عمل قابلة للقراءة في مجلد المصادر.',
  };
}

/**
 * حسم مصدر Excel إلى صفوف/أعمدة. قراءة فقط، ومحصورة داخل WORKFLOW_WORKBOOK_DIR.
 * @param {{name:string}} source اسم بصيغة workbook:<basename>[#<sheet>]
 */
async function resolveWorkbookSource(source, me) {
  const status = workbookConfigStatus();
  const root = (status.code === 'ready' || status.code === 'empty') ? status.root : '';
  if (!root) return fail(403, status.reason || 'مصدر Excel غير مهيأ — اضبط WORKFLOW_WORKBOOK_DIR على مجلد قراءة مخصص');
  if (!workbookAuthorized(me)) return fail(403, 'ليس لديك صلاحية قراءة ملفات Excel (صلاحية الاستيراد مطلوبة)');
  const raw = String((source && source.name) || '').replace(/^workbook:/, '');
  const hash = raw.lastIndexOf('#');
  const file = hash >= 0 ? raw.slice(0, hash) : raw;
  const sheet = hash >= 0 ? decodeSheetPart(raw.slice(hash + 1)) : '';
  if (!file || file !== path.basename(file) || /[\\/]/.test(file) || file.indexOf('..') >= 0 || file.indexOf('#') >= 0 || file.indexOf('\0') >= 0) {
    return fail(400, 'اسم ملف Excel غير صالح — يُسمح باسم ملف داخل مجلد المصادر فقط');
  }
  const ext = path.extname(file).toLowerCase();
  if (!WORKBOOK_EXT.includes(ext)) return fail(400, 'امتداد Excel غير مدعوم: ' + ext);
  let full;
  try { full = fs.realpathSync(path.join(root, file)); }
  catch (_) { return fail(404, 'ملف Excel غير موجود في مجلد المصادر: ' + file); }
  if (full !== root && full.indexOf(root + path.sep) !== 0) return fail(403, 'مسار الملف خارج مجلد المصادر المسموح');
  let wb;
  /* +2: صف العنوان + صف إضافي يثبت تجاوز الحد (وإلا تعذّر كشف الاقتطاع عند 5001 صفًا) */
  try { wb = X.readWorkbook(full, { sheetRows: ROW_LIMIT + 2, noCom: true }); }
  catch (e) { return fail(400, 'تعذّر قراءة ملف Excel: ' + ((e && e.message) || 'خطأ غير معروف')); }
  const chosen = sheet ? wb.find(s => s.name === sheet) : wb[0];
  if (!chosen) return fail(404, 'ورقة العمل غير موجودة: ' + sheet);
  const parsed = rowsFromMatrix(chosen.rows);
  const sheetLabel = chosen.name || '';
  const notes = [
    'مصدر Excel للقراءة فقط: ' + file + (sheetLabel ? ' — ' + sheetLabel : ''),
    'تُقرأ القيم المخزنة في الملف؛ الصيغ غير المحسوبة مسبقًا قد تظهر فارغة (لا يعيد المحرك حساب صيغ Excel).',
  ];
  let rows = parsed.rows;
  const truncated = rows.length > ROW_LIMIT;
  if (truncated) {
    notes.push(TRUNCATE_NOTE(rows.length, ROW_LIMIT));
    rows = rows.slice(0, ROW_LIMIT);
  }
  if (!rows.length) notes.push(EMPTY_NOTE);
  const columns = parsed.columns.length ? parsed.columns : (rows.length ? Object.keys(rows[0]) : []);
  const types = {};
  for (const c of columns) {
    const found = rows.find(r => r[c] !== null && r[c] !== undefined);
    types[c] = found ? inferFileType(found[c]) : 'string';
  }
  return {
    ok: true, status: 200,
    data: { sourceData: rows, sourceColumns: columns },
    rows, columns,
    fields: columns.map(c => ({ name: c, type: types[c], description: '' })),
    sample: rows.slice(0, 8),
    notes,
    source: {
      name: workbookSourceName(file, sheetLabel),
      label: file + (sheetLabel ? ' — ' + sheetLabel : ''),
      domain: 'workbooks', grain: 'ملف Excel', canonical: false, readOnly: true,
    },
    truncated, limit: ROW_LIMIT,
  };
}

/** صفحة رفض موحدة برمز حالة */
function fail(status, error) { return { ok: false, status, error }; }

/**
 * قائمة المصادر المتاحة لواجهة البناء (وصف فقط — لا جلب بيانات).
 * الاصطناعي بلا صلاحية (ذاكرة)، وكل مصدر حقيقية يحمل صلاحيته.
 */
function listSources() {
  const out = [{ name: SYNTHETIC_NAME, label: SYNTHETIC_LABEL, perm: null, domain: 'flows', grain: 'طلب واحد' }];
  for (const [name, def] of Object.entries(DATASETS)) {
    out.push({
      name, label: def.label, perm: def.perm, domain: def.domain, grain: def.grain,
      rowKey: def.rowKey, timeGrain: def.timeGrain, canonical: def.canonical,
      canonicalNote: def.canonicalNote || '', quickReport: def.quickReport !== false,
      description: def.description,
    });
  }
  return out;
}

/**
 * أعمدة/حقول/عينة مصدر لوصفه في الواجهة — **وصف ثابت لا يستدعي المزوّد** (إلا عينة الإنتاج).
 * - الاصطناعي: من تعريف الـfixture (نفس المصدر الذي ينفّذه المحرك).
 * - الحقيقي: من مخطط الفهرس، وبعد فحص الصلاحية في الإنتاج.
 * في وضع الاختبار تُعاد الأعمدة/الحقول/العينة دون فحص صلاحية ودون أي اتصال.
 */
async function sourceColumns(name, me) {
  if (name === SYNTHETIC_NAME) {
    const fix = require('./workflow').syntheticFixture();
    const cols = fix.sourceColumns;
    const sample = fix.sourceRows.slice(0, 5);
    const fields = cols.map(c => ({ name: c, type: SYNTHETIC_TYPES[c] || 'string', description: SYNTHETIC_DESCRIPTIONS[c] || '' }));
    return { ok: true, status: 200, data: { name: SYNTHETIC_NAME, label: SYNTHETIC_LABEL, columns: cols, fields, sample } };
  }
  const def = DATASETS[name];
  if (!def) return fail(400, 'مصدر بيانات غير مسموح: ' + String(name));
  /* فحص الصلاحية قبل أي إفصاح عن مصدر حقيقية (في الإنتاج فقط) */
  if (process.env.WORKFLOW_TEST_MODE !== '1' && !Auth.can(me, def.perm)) {
    return fail(403, 'ليس لديك صلاحية قراءة DataSource «' + def.label + '»');
  }
  const cols = def.columns;
  const fields = Object.keys(def.types).map(c => ({ name: c, type: def.types[c], description: def.descriptions[c] || '' }));
  /* عينة: في وضع الاختبار ثابتة (من الفهرس)؛ في الإنتاج 5 صفوف (قراءة فقط) */
  let sample = (CAT.getSource(name) || {}).sample || [];
  if (process.env.WORKFLOW_TEST_MODE !== '1') {
    try {
      const rows = await def.fetch({ days: 5, item: '', from: '', to: '', limit: 5, F: {} });
      sample = Array.isArray(rows) ? rows.slice(0, 5) : [];
    } catch (_) { sample = []; }
  }
  return { ok: true, status: 200, data: { name, label: def.label, columns: cols, fields, sample } };
}

/**
 * حسم مصدر نوع dataset إلى {sourceData, sourceColumns} لمحرك Workflow.
 * يعيد {ok:false, status, error} عند الرفض دون أي استدعاء لبنية بيانات.
 */
async function resolveDataset(source, me) {
  try {
    if (process.env.WORKFLOW_TEST_MODE === '1') {
      return fail(403, 'مصادر البيانات معطلة في وضع الاختبار (لا قاعدة بيانات) — استخدم المصدر التجريبي');
    }
    if (!source || typeof source !== 'object') return fail(400, 'تعريف DataSource مفقود');
    const def = DATASETS[source.name];
    if (!def) return fail(400, 'مصدر بيانات غير مسموح: ' + String(source.name));
    const notes = [];
    let st;
    try { st = normSettings(source.settings, notes); }
    catch (e) { return fail(400, e.message); }
    /* فحص الصلاحية قبل أي جلب بيانات */
    if (!Auth.can(me, def.perm)) {
      return fail(403, 'ليس لديك صلاحية قراءة DataSource «' + def.label + '»');
    }
    /* فلاتر التاريخ تُمرَّر كمعاملات معلَّمة إلى دوال analytics (لا نص استعلام) */
    const F = { from: st.from, to: st.to, item: st.item };
    let rows = await def.fetch({ days: st.days, item: st.item, from: st.from, to: st.to, limit: st.limit, F });
    if (!Array.isArray(rows)) return fail(400, 'DataSource «' + source.name + '» لم يُعد بيانات متوقعة');
    if (rows.length > ROW_LIMIT) {
      notes.unshift(TRUNCATE_NOTE(rows.length, ROW_LIMIT));
      rows = rows.slice(0, ROW_LIMIT);
    } else if (rows.length >= st.limit) {
      /* بلغ حد الصفوف ⇒ النتيجة قد تكون مقتطعة (تُعلن صراحةً) */
      notes.push('بلغت النتيجة حد الصفوف (' + st.limit + ') — قد تكون مقتطعة ولا تمثل كامل المصدر');
    }
    if (!rows.length) notes.push(EMPTY_NOTE);
    return {
      ok: true,
      status: 200,
      data: { sourceData: rows, sourceColumns: rows.length ? Object.keys(rows[0]) : [] },
      notes,
      source: { name: source.name, label: def.label, domain: def.domain, grain: def.grain, canonical: def.canonical },
    };
  } catch (e) {
    return fail(400, (e && e.message) || 'تعذّر قراءة DataSource');
  }
}

/**
 * مزوِّد الربط بمصدر حقيقي (rightSource) لخطوة join.
 * يفحص الصلاحية والحدود مثل أي مصدر، ويعيد الصفوف مع مستواها.
 */
async function resolveJoinSource(name, me, params) {
  if (process.env.WORKFLOW_TEST_MODE === '1') {
    return fail(403, 'مصادر البيانات معطلة في وضع الاختبار (لا قاعدة بيانات)');
  }
  const def = DATASETS[name];
  if (!def) return fail(400, 'مصدر ربط غير مسموح: ' + String(name));
  if (!Auth.can(me, def.perm)) return fail(403, 'ليس لديك صلاحية قراءة مصدر الربط «' + def.label + '»');
  try {
    /* نفس نافذة الطرف الأيسر (من/إلى) ⇒ الطرفان على الفترة نفسها */
    const p = (params && typeof params === 'object') ? params : {};
    const from = String(p.from || '').slice(0, 10);
    const to = String(p.to || '').slice(0, 10);
    const days = Number(p.days) || 30;
    const rows = await def.fetch({ days, item: String(p.item || ''), from, to, limit: ROW_LIMIT, F: { from, to, item: String(p.item || '') } });
    const list = Array.isArray(rows) ? rows.slice(0, ROW_LIMIT) : [];
    /* بلغ الحد ⇒ قد يكون المصدر مقتطعًا (لا نرفع الحد: حدود الذاكرة تبقى) */
    const truncated = list.length >= ROW_LIMIT;
    return {
      ok: true, status: 200,
      rows: list,
      columns: list.length ? Object.keys(list[0]) : def.columns,
      label: def.label, grain: def.grain,
      limit: ROW_LIMIT, truncated,
    };
  } catch (e) {
    return fail(400, (e && e.message) || 'تعذّر جلب مصدر الربط');
  }
}

module.exports = {
  DATASETS, ROW_LIMIT, MAX_DAYS, MAX_ITEM,
  SYNTHETIC_NAME, SYNTHETIC_LABEL,
  SYNTHETIC_DESCRIPTIONS, SYNTHETIC_TYPES,
  normSettings, isDataset, isFileSource, isWorkbookSource, resolveDataset, resolveJoinSource,
  fileSourceRoot, listFileSources, resolveFileSource,
  workbookSourceRoot, workbookConfigStatus, listWorkbookSources, workbookDiagnostics, resolveWorkbookSource, WORKBOOK_PERM,
  listSources, sourceColumns,
};
