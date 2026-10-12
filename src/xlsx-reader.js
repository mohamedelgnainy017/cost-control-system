'use strict';
/**
 * قارئ ملفات Excel
 * - المسار الأول: قراءة مباشرة (SheetJS) لأي xlsx / xlsm / xlsb / csv
 * - المسار الثاني (احتياطي): عند وجود كلمة مرور على الملف، يُقرأ عبر
 *   Excel نفسه (COM) من النسخة المفتوحة على الجهاز، ثم يُحوَّل إلى CSV مؤقت
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const XLSX = require('xlsx');

const EPOCH = Date.UTC(1899, 11, 30);

function excelSerialToISO(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const n = Number(s);
    if (Number.isFinite(n)) return excelSerialToISO(n);
    const d = new Date(s);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return null;
  return new Date(EPOCH + Math.round(n) * 86400000).toISOString().slice(0, 10);
}

function num(v, def = 0) {
  if (v === null || v === undefined) return def;
  if (typeof v === 'number') return Number.isFinite(v) ? v : def;
  let s = String(v).trim();
  if (s === '') return def;
  s = s.replace(/,/g, '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  const n = Number(s);
  return Number.isFinite(n) ? n : def;
}
function str(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/**
 * رقم يتحمّل تنسيق العملات: "$  1,278.0" / "¢  215.90" / "52.48" / "1,102.315"
 * يُرجع null إذا كان الحقل فارغاً (لتمييز "لا قيمة" عن صفر حقيقي)
 */
function numx(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (s === '') return null;
  s = s.replace(/[$¢£€¥؋]/g, '')
       .replace(/[%°]/g, '')
       .replace(/[\u00A0\u200f\u200e\s]/g, '')
       .replace(/,/g, '')
       .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  if (s === '' || s === '-' || s === '—') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** يحوّل CSV نصي إلى مصفوفة صفوف (يدعم التنصيص والأسطر المركبة) */
function csvToRows(text) {
  const wb = XLSX.read(text, { type: 'string', raw: true, dense: true });
  const name = wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, raw: true, defval: null });
}

/** قراءة عبر Excel COM (للملفات المحمية بكلمة مرور) */
function readViaCom(filePath, password, maxRows = 0, noCopy = false) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-'));
  const script = path.join(__dirname, 'com-export.ps1');
  const args = [ '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-FilePath', filePath, '-OutDir', outDir, '-MaxRows', String(maxRows || 0) ];
  if (password) args.push('-Password', password);
  if (noCopy || maxRows > 0) args.push('-NoCopy');
  let out;
  try {
    out = execFileSync('powershell.exe', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64, timeout: 30 * 60 * 1000 });
  } catch (e) {
    const msg = (e.stdout || '') + (e.stderr || '') + (e.message || '');
    throw new Error('تعذّرت القراءة عبر Excel: ' + msg.slice(-1200));
  }
  const manifest = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(manifest)) throw new Error('لم يُنشأ ملف من Excel: ' + out.slice(-800));
  const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  // ConvertTo-Json قد يُخرج كائناً بدل مصفوفة عند وجود عنصر واحد
  const list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? Object.values(parsed) : []);

  const cleanup = () => {
    try {
      for (const it of list) { if (it.csv) fs.unlinkSync(it.csv); if (it.copy) fs.unlinkSync(it.copy); }
      fs.unlinkSync(manifest); fs.rmdirSync(outDir);
    } catch (_) {}
  };

  // المسار السريع: نسخة غير محمية من الملف كاملاً
  const first = Array.isArray(list) ? list[0] : null;
  if (first && first.mode === 'copy' && first.copy && fs.existsSync(first.copy)) {
    try {
      const wb = XLSX.readFile(first.copy, { dense: true, cellDates: false, codepage: 65001 });
      const sheets = wb.SheetNames.map(n => ({
        name: n,
        rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false, raw: true, defval: null }),
        via: 'com',
      }));
      cleanup();
      return sheets;
    } catch (e) {
      // النسخة ما زالت محمية → أعد المحاولة بمسار CSV
      cleanup();
      return readViaCom(filePath, password, maxRows, true);
    }
  }

  const sheets = [];
  for (const it of list) {
    const text = fs.readFileSync(it.csv, 'utf8');
    sheets.push({ name: it.name, rows: csvToRows(text), via: 'com' });
  }
  cleanup();
  return sheets;
}

/**
 * @returns {Array<{name:string, rows:Array<Array<any>>}>}
 */
function readWorkbook(filePath, opts = {}) {
  if (!fs.existsSync(filePath)) throw new Error('الملف غير موجود: ' + filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.csv' || ext === '.txt') {
    const text = fs.readFileSync(filePath, 'utf8');
    return [{ name: path.basename(filePath), rows: csvToRows(text), via: 'csv' }];
  }

  try {
    const wb = XLSX.readFile(filePath, {
      dense: true,
      cellDates: false,
      sheetRows: opts.sheetRows || 0,
      codepage: 65001,
    });
    return wb.SheetNames.map(n => ({
      name: n,
      rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false, raw: true, defval: null }),
      via: 'sheetjs',
    }));
  } catch (e) {
    const m = String(e.message || '');
    if (/password/i.test(m) || /password/i.test(String(e))) {
      if (opts.noCom) throw new Error('الملف محمي بكلمة مرور. افتحه في Excel أو أدخل كلمة المرور.');
      return readViaCom(filePath, opts.password);
    }
    throw e;
  }
}

/** قراءة صفوف رأس فقط للكشف (سريعة) */
function readHeaderPreview(filePath, maxRows = 5, password) {
  try {
    const wb = XLSX.readFile(filePath, { dense: true, sheetRows: maxRows, codepage: 65001 });
    return wb.SheetNames.map(n => ({
      name: n,
      rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false, raw: true, defval: null }),
      ref: wb.Sheets[n]['!ref'] || '',
    }));
  } catch (e) {
    if (/password/i.test(String(e.message || ''))) {
      const sheets = readViaCom(filePath, password || undefined, maxRows + 2);
      return sheets.map(s => ({ name: s.name, rows: s.rows.slice(0, maxRows), ref: '(protected)' }));
    }
    throw e;
  }
}

module.exports = { readWorkbook, readHeaderPreview, excelSerialToISO, num, numx, str, csvToRows };
