'use strict';
/**
 * محرك الاستيراد — يقرأ ملف Excel، يكشف الجداول تلقائياً بحسب عناوين الأعمدة،
 * ويحمّلها إلى PostgreSQL مع:
 *  - إدراج مجمّع (batch) لمئات الآلاف من الصفوف في ثوانٍ
 *  - استبدال بيانات المصدر نفسه فقط (يدعم ربط ملفات/شيتات أخرى لاحقاً)
 *  - اشتقاق الحقول: المكان، توجيه الحركة، إشارة البيع
 */
const path = require('node:path');
const { all, get, run, tx, insertBatch, delSetting } = require('./db');
const { readWorkbook, readHeaderPreview, excelSerialToISO, num, numx, str } = require('./xlsx-reader');

/* توحيد مسار الملف: نفس الملف بفواصل / و\ يجب أن يكون مصدراً واحداً وإلا تراكمت صفوف مكررة */
const normPath = p => (p === null || p === undefined || p === '' ? p : path.normalize(String(p)));

/** تاريخ اليوم من اسم الملف (مثل 01-09-2026) — يُستخدم للأرصدة التي بلا عمود تاريخ */
function dateFromFileName(name) {
  const m = String(name || '').match(/(\d{1,2})[-_.](\d{1,2})[-_.](\d{2,4})/);
  if (!m) return null;
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

/** عمود تاريخ: يحوّل رقم Excel التسلسلي (أو نصاً) إلى ISO yyyy-mm-dd، وإلا '' */
const dt = v => excelSerialToISO(v) || '';

/* ---------------- كشف نوع الجدول ---------------- */
// كل عنصر = نمط يُطبَّق على أي عنصر في صف العناوين (بعدد من الأعمدة المطلوبة)
const SIGNATURES = {
  items: [/^التصنيف$/, /وصف التصنيف/, /وصف المادة/],
  locations: [/رمز الشركة/, /اسم الشركة/, /المكان$/],
  movement_types: [/^الحركة$/, /توج.*الحركة/],
  movements: [/تاريخ الترحيل/, /كمية$/, /مبلغ بعملةمحلية/, /نوع الحركة/],
  sales: [/تاريخ الفاتورة/, /صاف[ىي] القيم[ةه]/, /الكمية المفوترة|كمية الفاتور[ةه]/, /مستند مبيع|المستند المرجع/],

  /* جدول الأرصدة اليومي: عمودَا الكمية والقيمة للفترة (بداية/نهاية) — المطابقتان
     تكفيان لتحديد الجدول. المطابقة الثانية تقبل أيضاً «إجمالي كمية البضائع» /
     «كمية إصدار البضائع» من الإصدارات الأقدم من التقرير. */
  balances: [/كمية المخزون في (بداية|نهاية) الفترة/,
             /قيمة المخزون في (بداية|نهاية) الفترة|إجمالي كمية البضائع|كمية إصدار البضائع/],
  contract_registrations: [/الرقم داخلي/, /رقم العقد|كمية تفصيلى/],
  contract_details: [/الرقم داخلي/, /الباخرة/, /ميناء الوصول/],
  contract_payments: [/الرقم داخلي/, /تاريخ السداد/],
  contract_loading: [/الرقم داخلي/, /تاريخ التحميل/],
  contract_hedge: [/الرقم داخلي/, /تاريخ الربط/],
  contract_roll: [/الرقم داخلي/, /تاريخ الترويل/],
  contract_release: [/الرقم داخلي/, /تاريخ الافراج/],
  contract_external_sales: [/الرقم داخلي/, /تاريخ البيع/],
  contract_balances: [/تاريخ التقرير/, /كود الصنف/],
  contract_items: [/كود الصنف/, /اسم الصنف/],
  contract_suppliers: [/كود المورد/, /اسم المورد/],
  contract_ports: [/كود الميناء/, /اسم الميناء/],
  companies: [/كود الشركة/, /اسم الشركة/],
  contract_countries: [/كود المصدر/, /اسم المصدر/],
};

const DATASET_LABEL = {
  items: 'دليل الأصناف',
  locations: 'المواقع والشركات',
  movement_types: 'أنواع الحركات',
  movements: 'حركات المخزون',
  sales: 'المبيعات',
  balances: 'أرصدة المخزون',

  contract_registrations: 'عقود الاستيراد - التسجيل',
  contract_details: 'عقود الاستيراد - تفصيلى',
  contract_payments: 'عقود الاستيراد - السداد',
  contract_loading: 'عقود الاستيراد - التحميل',
  contract_hedge: 'عقود الاستيراد - الربط',
  contract_roll: 'عقود الاستيراد - الرول',
  contract_release: 'عقود الاستيراد - الافراج',
  contract_external_sales: 'عقود الاستيراد - بيع خارجى',
  contract_balances: 'عقود الاستيراد - الارصدة',
  contract_items: 'عقود الاستيراد - عناصر',
  contract_suppliers: 'عقود الاستيراد - الموردين',
  contract_ports: 'عقود الاستيراد - موانئ التحميل',
  companies: 'الشركات (المصدر الموحد)',
  contract_countries: 'عقود الاستيراد - المصادر',
  contract_arrival_ports: 'عقود الاستيراد - موانئ الوصول',
};

const TABLE_OF = {
  items: 'items', locations: 'locations', movement_types: 'movement_types',
  movements: 'movements', sales: 'sales', balances: 'balances',
  contract_registrations: 'contract_registrations',
  contract_details: 'contract_details',
  contract_payments: 'contract_payments',
  contract_loading: 'contract_loading',
  contract_hedge: 'contract_hedge',
  contract_roll: 'contract_roll',
  contract_release: 'contract_release',
  contract_external_sales: 'contract_external_sales',
  contract_balances: 'contract_balances',
  contract_items: 'contract_items',
  contract_suppliers: 'contract_suppliers',
  contract_ports: 'contract_ports',
  companies: 'companies',
  contract_countries: 'contract_countries',
  contract_arrival_ports: 'contract_arrival_ports',
};

// توحيد النص العربي: إزالة BOM والتشكيل والتطويل والمسافات
const norm = s => str(s)
  .replace(/^﻿/, '')
  .replace(/[ً-ٰٟـ]/g, '')
  .replace(/[_​-‏﻿]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

function scoreHeader(header) {
  let score = 0;
  for (const sig of Object.values(SIGNATURES)) {
    const hit = sig.filter(rx => header.some(h => rx.test(h))).length;
    if (hit >= 2) score += hit;
  }
  return score;
}

function findHeaderRow(rows, maxScan = 15) {
  let best = null;
  const limit = Math.min(maxScan, rows.length);
  for (let r = 0; r < limit; r++) {
    const row = rows[r] || [];
    const filled = row.filter(c => norm(c) !== '').length;
    if (filled < 3) continue;
    const header = row.map(norm);
    const score = scoreHeader(header);
    if (!best || score > best.score) best = { r, score, header };
    if (score >= 6) break;
  }
  return best;
}

/** يقسم صف العناوين إلى كتل فصلية (للشيتات التي تحوي عدة جداول جنباً إلى جنب) */
function splitBlocks(headerRow) {
  const blocks = [];
  let start = -1;
  for (let c = 0; c < headerRow.length + 1; c++) {
    const h = c < headerRow.length ? headerRow[c] : '';
    const filled = norm(h) !== '';
    if (filled && start === -1) start = c;
    if (!filled && start !== -1) { blocks.push({ start, end: c - 1 }); start = -1; }
  }
  if (start !== -1) blocks.push({ start, end: headerRow.length - 1 });
  return blocks;
}

function classify(headers) {
  const list = headers.map(norm).filter(Boolean);
  if (!list.length) return null;
  let best = null;
  for (const [ds, sig] of Object.entries(SIGNATURES)) {
    const hit = sig.filter(rx => list.some(h => rx.test(h))).length;
    const need = Math.max(2, Math.min(3, sig.length));
    if (hit >= need && (!best || hit > best.hit)) best = { ds, hit };
  }
  // fallback for contract tables - if has الرقم داخلي and a key field
  if (!best && list.some(h => /الرقم الداخلى|الرقم الداخلي/.test(h))) {
    if (list.some(h => /تاريخ السداد|كمية السداد|سعر السداد/.test(h))) return 'contract_payments';
    if (list.some(h => /تاريخ التحميل|كمية التحميل/.test(h))) return 'contract_loading';
    if (list.some(h => /تاريخ الربط|كمية الربط|قيمة الربط/.test(h))) return 'contract_hedge';
    if (list.some(h => /تاريخ الترويل|ترويل/.test(h))) return 'contract_roll';
    if (list.some(h => /تاريخ الافراج|كمية الافراج/.test(h))) return 'contract_release';
    if (list.some(h => /تاريخ البيع|كمية المبيعات/.test(h))) return 'contract_external_sales';
    if (list.some(h => /الباخرة|ميناء الوصول|كمية تفصيلى/.test(h))) return 'contract_details';
  }
  // try loose normalization
  const loose = list.map(s => s.replace(/[^\u0621-\u064A\u0660-\u0669a-zA-Z0-9]/g, ''));
  if (!best && loose.some(h => /الرقمداخلي/.test(h))) {
    if (loose.some(h => /تاريخالسداد|كميةالسداد|سعرالسداد/.test(h))) return 'contract_payments';
    if (loose.some(h => /تاريخالتحميل|كميةالتحميل/.test(h))) return 'contract_loading';
    if (loose.some(h => /تاريخالربط|عددالعقود|قيمةالربط/.test(h))) return 'contract_hedge';
    if (loose.some(h => /تاريخالترويل|كميةالترويل/.test(h))) return 'contract_roll';
    if (loose.some(h => /تاريخالافراج|كميةالافراج/.test(h))) return 'contract_release';
    if (loose.some(h => /تاريخالبيع|كميةالمبيعات/.test(h))) return 'contract_external_sales';
  }
  return best ? best.ds : null;
}

function headerIndex(headers) {
  const map = {};
  headers.forEach((h, i) => { const n = norm(h); if (n && map[n] === undefined) map[n] = i; });
  return map;
}

/**
 * تطبيع إضافي لأسماء الأعمدة العربية: توحيد الهمزات/الياء/التاء المربوطة
 * وإزالة «ال» التعريف والمسافات — يجعل «الرقم الداخلي» و«الرقم داخلي»
 * و«شركة خارجية» و«شركة خارجىة» متطابقة.
 */
function colNorm(s) {
  return norm(s)
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ال/g, '')
    .replace(/[^\u0621-\u064Aa-zA-Z0-9]/g, '');
}

/** يجد العمود بالمطابقة الجزئية أيضاً — يُرجع الإزاحة المطلقة داخل الصف (بالنسبة لبداية الكتلة) */
function col(t, ...names) {
  const map = t.map, off = t.start || 0;
  const raw = (n) => {
    if (map[n] !== undefined) return map[n];
    let key = Object.keys(map).find(k => k === n || k.includes(n));
    if (key !== undefined) return map[key];
    // مطابقة مطبّعة (همزات/ياء/تاء/«ال»)
    const cn = colNorm(n);
    key = Object.keys(map).find(k => colNorm(k) === cn || colNorm(k).includes(cn));
    return key === undefined ? -1 : map[key];
  };
  for (const n of names) {
    const i = raw(n);
    if (i >= 0) return i + off;
  }
  return -1;
}
/** يجد العمود بشرط دلالي على اسمه (مع الإزاحة المطلقة) */
function colFn(t, pred) {
  const key = Object.keys(t.map).find(pred);
  return key === undefined ? -1 : t.map[key] + (t.start || 0);
}

/* جداول المراجع في شيت «بيانات» — تُكتشف بعنوانها الفعلي (كود + اسم) في أي موضع،
   لأنها قد تشترك في الأعمدة فتُخلط بالكشف العام. */
const REF_BLOCKS = [
  { dataset: 'contract_suppliers',     code: 'كود المورد',       name: 'اسم المورد' },
  { dataset: 'contract_countries',     code: 'كود المصدر',       name: 'اسم المصدر' },
  { dataset: 'contract_arrival_ports', code: 'كود ميناء الوصول', name: 'اسم ميناء الوصول' },
  { dataset: 'contract_ports',         code: 'كود الميناء',      name: 'اسم الميناء' },
];

/** كتلة مرجعية (كود/اسم): يجد صف العنوان ثم يقرأ لأسفل حتى أول صف فارغ */
function findRefBlock(rows, codeHdr, nameHdr) {
  const cN = norm(codeHdr), nN = norm(nameHdr);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    for (let c = 0; c + 1 < row.length; c++) {
      if (norm(row[c]) === cN && norm(row[c + 1]) === nN) {
        let e = r + 1;
        while (e < rows.length) {
          const rr = rows[e] || [];
          if (norm(rr[c]) === '' && norm(rr[c + 1]) === '') break;
          e++;
        }
        const headers = [str(row[c]), str(row[c + 1])];
        return { dataset: null, headerRow: r, start: c, end: c + 1, rowEnd: e, headers, map: headerIndex(headers) };
      }
    }
  }
  return null;
}

function detectTables(rows) {
  const out = [];
  const hr = findHeaderRow(rows);
  if (hr) {
    const blocks = splitBlocks(hr.header);
    for (const b of blocks) {
      const headers = hr.header.slice(b.start, b.end + 1);
      const ds = classify(headers);
      if (!ds) continue;
      out.push({ dataset: ds, headerRow: hr.r, start: b.start, end: b.end, headers, map: headerIndex(headers) });
    }
  }
  /* كتل المراجع (موردين/مصادر/موانئ) تُكتشف بموقع عنوانها الحقيقي داخل الشيت لا بعنوان
     أول صف فقط، لأن عدة كتل تشترك في نفس الأعمدة (G:H) فيقرأ المحرك العام أولها
     ويبالغ في مدى الصفوف فيخلطها. الكتلة المرجعية تُقيَّد بأول صف فارغ بعد عنوانها. */
  for (const spec of REF_BLOCKS) {
    const rb = findRefBlock(rows, spec.code, spec.name);
    if (!rb) continue;
    rb.dataset = spec.dataset;
    for (let i = out.length - 1; i >= 0; i--) if (out[i].dataset === spec.dataset) out.splice(i, 1);
    out.push(rb);
  }
  return out;
}

/* ---------------- الاستيراد ---------------- */

/**
 * استبدال بيانات المصدر:
 *  - للحركات والمبيعات/الأسعار/الدليل: يحذف فقط السجلات القادمة من نفس الملف
 *    (بمقارنة المسار موحّدة الفواصل حتى لا يُعامل `C:/x` و`C:\x` كمصدرَين).
 *  - للأرصدة (المرحلة 4): استبدال **حسب التاريخ والمفتاح** — الصفوف التي يغطيها
 *    الملف (تاريخ × صنف × شركة × وحدة × موقع) تُستبدل بمحتواها من أي مصدر، وما
 *    دون ذلك يبقى كما هو؛ فتتراكم الأيام يوماً بعد يوم (الشيت قد يكون نافذة
 *    متحركة) ولا يُحذف تاريخ قديم ولا يُخلط مفتاح من مصدر آخر.
 */
async function clearDataset(ds, sourceFile, built) {
  const table = TABLE_OF[ds];
  if (!table) return;

  if (ds === 'balances' && built && built.rows.length) {
    // أعمدة BAL_COLS: 0=balance_date 1=item 4=company_code 5=unit_code 6=storage_loc
    const dates = [], items = [], comps = [], units = [], stores = [];
    for (const r of built.rows) {
      if (!r[0]) continue;                       // بلا تاريخ: لا يمكن مطابقته
      dates.push(r[0]); items.push(r[1] || '');
      comps.push(r[4] || ''); units.push(r[5] || ''); stores.push(r[6] || '');
    }
    if (dates.length) {
      await run(
        `DELETE FROM balances
          WHERE (balance_date, item, COALESCE(company_code, ''), COALESCE(unit_code, ''), COALESCE(storage_loc, ''))
                IN (SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]))`,
        [dates, items, comps, units, stores]);
    }
    return;
  }

  if (sourceFile) {
    const p = normPath(sourceFile);
    await run(`DELETE FROM ${table}
               WHERE regexp_replace(COALESCE(source_file, ''), '/', chr(92), 'g') =
                     regexp_replace($1, '/', chr(92), 'g')`, [p]);
  } else await run(`DELETE FROM ${table}`);
}

/* ---- المُحمّلات: تُرجع صفوف جاهزة للإدراج المجمّع ---- */

function itemsRows(rows, t, importId, sourceFile) {
  const m = t.map;
  const ci = { cls: col(t, 'التصنيف'), clsD: col(t, 'وصف التصنيف'), code: col(t, 'المادة', 'كود المادة'),
               desc: col(t, 'وصف المادة'), uom: col(t, 'وحدة'), grp: col(t, 'مجموعة المواد'),
               grpD: col(t, 'وصف مجموعة المواد') };
  const out = []; let skipped = 0;
  for (let r = t.headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const code = str(row[ci.code]);
    if (!code) { skipped++; continue; }
    out.push([code, str(row[ci.desc]), str(row[ci.uom]), str(row[ci.grp]), str(row[ci.grpD]),
              str(row[ci.cls]), str(row[ci.clsD]), new Date().toISOString(), sourceFile]);
  }
  return { rows: out, skipped };
}

function locationRows(rows, t, importId, sourceFile) {
  const m = t.map;
  const ci = { code: col(t, 'رمز الشركة'), name: col(t, 'اسم الشركة'), ccy: col(t, 'العملة'),
               unit: col(t, 'الوحدة'), unitName: col(t, 'اسم الوحدة'), place: col(t, 'المكان') };
  const out = []; let skipped = 0;
  for (let r = t.headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const unit = str(row[ci.unit]);
    if (!unit) { skipped++; continue; }
    out.push([unit, str(row[ci.code]), str(row[ci.name]), str(row[ci.ccy]), str(row[ci.unitName]), str(row[ci.place]), sourceFile]);
  }
  return { rows: out, skipped };
}

function movementTypeRows(rows, t, importId, sourceFile) {
  const m = t.map;
  const dirCol = colFn(t, k => /توج/.test(k) && /حرك/.test(k));   // "توجيه الحركة" بأي إملاء
  const ci = { code: col(t, 'الحركة'), dir: dirCol >= 0 ? dirCol : colFn(t, k => /توج/.test(k)) };
  const out = []; let skipped = 0;
  for (let r = t.headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const code = str(row[ci.code]);
    if (!code || ci.dir < 0) { skipped++; continue; }
    out.push([code, str(row[ci.dir]), sourceFile]);
  }
  return { rows: out, skipped };
}

const MOV_COLS = ['item','item_desc','uom','qty','supplier','move_type','move_indicator','post_date','doc_ref',
  'purchase_order','customer','descr','company_code','unit_code','storage_loc','amount','currency','group_code',
  'group_desc','ext_group_code','ext_group_desc','place','direction','source_row','import_id','source_file'];

function movementRows(rows, t, importId, sourceFile) {
  const m = t.map;
  const ci = {
    item: col(t, 'المادة'), itemDesc: col(t, 'وصف المادة'), uom: col(t, 'وحدة'), qty: col(t, 'كمية'),
    supplier: col(t, 'المورد'), moveType: col(t, 'نوع الحركة'), indicator: col(t, 'مؤشر الحركة'),
    date: col(t, 'تاريخ الترحيل'), ref: col(t, 'مرجع'), po: col(t, 'أمر الشراء'), cust: col(t, 'العميل'),
    descr: col(t, 'الوصف'), company: col(t, 'رمز الشركة'), unit: col(t, 'الوحدة'),
    storage: col(t, 'موقع التخزين'), amount: col(t, 'مبلغ بعملةمحلية'), ccy: col(t, 'العملة'),
    grp: col(t, 'مجموعه المواد'), grpD: col(t, 'وصف مجموعه المواد'),
    extGrp: col(t, 'مجموعه المواد الخارجيه'), extGrpD: col(t, 'وصف مجموعه المواد الخارجيه'),
  };
  const out = []; let skipped = 0;
  for (let r = t.headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const item = str(row[ci.item]);
    if (!item) { skipped++; continue; }
    out.push([item, str(row[ci.itemDesc]), str(row[ci.uom]), num(row[ci.qty]), str(row[ci.supplier]),
      str(row[ci.moveType]), str(row[ci.indicator]), excelSerialToISO(row[ci.date]), str(row[ci.ref]),
      str(row[ci.po]), str(row[ci.cust]), str(row[ci.descr]), str(row[ci.company]), str(row[ci.unit]),
      str(row[ci.storage]), num(row[ci.amount]), str(row[ci.ccy]), str(row[ci.grp]), str(row[ci.grpD]),
      str(row[ci.extGrp]), str(row[ci.extGrpD]), null, null, r + 1, importId, sourceFile]);
  }
  return { rows: out, skipped };
}

const SALES_COLS = ['invoice_date','invoice_doc','line_no','qty','price_uom','fx_rate','net_value','ccy_net',
  'sale_doc','sale_line','item','item_desc','ref_doc','ref_line','unit_code','doc_class','doc_status',
  'beneficiary','tax','ccy_tax','credit_price','ccy_credit','subtotal','ccy_subtotal','raw_cost','ccy_cost',
  'place','signed_qty','signed_value','source_row','import_id','source_file','storage_loc'];

function salesRows(rows, t, importId, sourceFile) {
  const m = t.map;
  const ci = {
    date: col(t, 'تاريخ الفاتورة'),
    inv: col(t, 'مستندفوترة', 'مستند فاتورة', 'المستند المرجع'), line: col(t, 'البند'),
    qty: col(t, 'الكمية المفوترة', 'كمية الفاتوره'),
    uom: col(t, 'و.م', 'الوحده', 'الوحدة'), rate: col(t, 'سعر الصرف'),
    net: col(t, 'صافي القيمة', 'صافى القيمه'),
    ccy1: col(t, 'عملة المستند', 'عملة'), ccy2: col(t, 'عملة2'),
    saleDoc: col(t, 'مستند مبيع'), saleLine: col(t, 'بند'),
    item: col(t, 'كود الصنف', 'المادة'), itemDesc: col(t, 'وصف البند', 'اسم الصنف'),
    refDoc: col(t, 'مستند مرجع', 'المستند المرجع'), refLine: col(t, 'RefItm'),
    unit: col(t, 'وحدة'), cls: col(t, 'فئة مستند'), status: col(t, 'الحالة'),
    ben: col(t, 'المستفيد', 'اسم العميل الاساسي'),
    tax: col(t, 'مبلغ الضريبة'), ccy3: col(t, 'عملة3'), credit: col(t, 'سعر الائتمان'), ccy4: col(t, 'عملة4'),
    sub: col(t, 'الإجمالي الفرعي'), ccy5: col(t, 'عملة5'), cost: col(t, 'التكلفة'), ccy6: col(t, 'عملة6'),
    storage: col(t, 'كود المخزن', 'موقع التخزين'),
  };
  const out = []; let skipped = 0;
  for (let r = t.headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const item = str(row[ci.item]);
    const inv = str(row[ci.inv]);
    if (!item && !inv) { skipped++; continue; }
    const cls = str(ci.cls >= 0 ? row[ci.cls] : ''), status = str(ci.status >= 0 ? row[ci.status] : '');
    /* بلا عمودي الفئة/الحالة (ملف المبيعات اليومي): كل الصفوف مبيعات موجبة */
    const sign = (ci.cls < 0 && ci.status < 0)
      ? 1
      : (cls + status === 'CA' || cls + status === 'HC') ? 1 : -1;
    const qty = num(row[ci.qty]);
    const net = num(row[ci.net]);
    out.push([
      excelSerialToISO(row[ci.date]), inv, Math.round(num(row[ci.line])), qty, str(row[ci.uom]),
      num(row[ci.rate], 1), net,
      (ci.ccy2 >= 0 ? str(row[ci.ccy2]) : '') || (ci.ccy1 >= 0 ? str(row[ci.ccy1]) : ''),
      str(row[ci.saleDoc]), Math.round(num(row[ci.saleLine])), item, str(row[ci.itemDesc]),
      str(row[ci.refDoc]), Math.round(num(row[ci.refLine])), str(row[ci.unit]), cls, status,
      str(row[ci.ben]), num(row[ci.tax]), str(row[ci.ccy3]), num(row[ci.credit]), str(row[ci.ccy4]),
      num(row[ci.sub]), str(row[ci.ccy5]), num(row[ci.cost]), str(row[ci.ccy6]),
      null, sign * qty, sign * net, r + 1, importId, sourceFile, str(row[ci.storage]),
    ]);
  }
  return { rows: out, skipped };
}

const BAL_COLS = ['balance_date','item','item_desc','base_uom','company_code','unit_code','storage_loc',
  'currency','material_type','open_qty','open_val','close_qty','close_val','place','source_row','import_id','source_file'];

function balanceRows(rows, t, importId, sourceFile) {
  const m = t.map;
  const ci = {
    date: col(t, 'تاريخ الرصيد'), item: col(t, 'المادة'), desc: col(t, 'وصف المادة'),
    uom: col(t, 'وحدة القياس الأساسية'), company: col(t, 'رمز الشركة'), unit: col(t, 'الوحدة'),
    storage: col(t, 'موقع التخزين'), ccy: col(t, 'العملة'), mtype: col(t, 'نوع المادة'),
    oq: col(t, 'كمية المخزون في بداية الفترة'), ov: col(t, 'القيمة في بداية الفترة'),
    cq: col(t, 'كمية المخزون في نهاية الفترة'), cv: col(t, 'قيمة المخزون في نهاية الفترة'),
  };
  const out = []; let skipped = 0;
  const fileDate = dateFromFileName(sourceFile);   // شيت الأرصدة اليومي بلا عمود تاريخ — التاريخ من اسم الملف
  for (let r = t.headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const item = str(row[ci.item]);
    if (!item) { skipped++; continue; }
    const date = ci.date >= 0 ? excelSerialToISO(row[ci.date]) : (fileDate || '');
    out.push([date, item, str(row[ci.desc]), str(row[ci.uom]), str(row[ci.company]),
      str(row[ci.unit]), str(row[ci.storage]), str(row[ci.ccy]), str(row[ci.mtype]),
      num(row[ci.oq]), num(row[ci.ov]), num(row[ci.cq]), num(row[ci.cv]), null, r + 1, importId, sourceFile]);
  }
  return { rows: out, skipped };
}




function contractItemsRows(rows, t, importId, sourceFile) {
  const ci = {
    code: col(t, 'كود الصنف'),
    name: col(t, 'اسم الصنف'),
    dir: col(t, 'التوجية'),
    lot: col(t, 'لوط'),
    factor: col(t, 'معامل'),
    mcode: col(t, 'المادة'),
    mdesc: col(t, 'وصف المادة'),
    unit: col(t, 'وحدة'),
    mtype: col(t, 'نوع المادة'),
    gcode: col(t, 'مجموعة المواد'),
    gdesc: col(t, 'وصف مجموعة المواد'),
    cls: col(t, 'التصنيف'),
    clsdesc: col(t, 'وصف التصنيف'),
    ptype: col(t, 'نوع المنتج'),
    loc: col(t, 'موقع'),
    old: col(t, 'كود قديم'),
    status: col(t, 'الحالة'),
  };
  const out = []; let skipped = 0;
  for (let r = t.headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const code = str(row[ci.code]);
    if (!code) { skipped++; continue; }
    out.push([code, str(row[ci.name]), str(row[ci.dir]), num(row[ci.lot]), num(row[ci.factor]), str(row[ci.mcode]), str(row[ci.mdesc]), str(row[ci.unit]), str(row[ci.mtype]), str(row[ci.gcode]), str(row[ci.gdesc]), str(row[ci.cls]), str(row[ci.clsdesc]), str(row[ci.ptype]), str(row[ci.loc]), str(row[ci.old]), str(row[ci.status]), sourceFile, new Date().toISOString()]);
  }
  return { rows: out, skipped };
}


function contractDetailsRows(rows, t, importId, sourceFile) {
  const ci = {internal:col(t,'الرقم داخلي'),cls:col(t,'التصنيف'),src:col(t,'المصدر'),ext:col(t,'شركة خارجية'),intc:col(t,'شركة داخلية'),cno:col(t,'رقم العقد'),qty:col(t,'كمية تفصيلى'),vessel:col(t,'الباخرة'),port:col(t,'ميناء الوصول'),exp:col(t,'وصول متوقع'),opstart:col(t,'بداية تشغيل'),ldur:col(t,'مدة التحميل'),opend:col(t,'نهاية تشغيل'),cstat:col(t,'موقف العقد'),vstat:col(t,'موقف المركب'),notes:col(t,'ملاحظات التسجيل')};
  const out=[]; let skip=0;
  for(let r=t.headerRow+1;r<rows.length;r++){const row=rows[r]||[];const inr=str(row[ci.internal]);if(!inr){skip++;continue;} out.push([inr,str(row[ci.cls]),str(row[ci.src]),str(row[ci.ext]),str(row[ci.intc]),str(row[ci.cno]),num(row[ci.qty]),str(row[ci.vessel]),str(row[ci.port]),dt(row[ci.exp]),dt(row[ci.opstart]),str(row[ci.ldur]),dt(row[ci.opend]),str(row[ci.cstat]),str(row[ci.vstat]),str(row[ci.notes]),r+1,importId,sourceFile]);}
  return {rows:out,skipped:skip};
}
function contractRegistrationsRows(rows, t, importId, sourceFile) {
  const ci = {
    internal: col(t, 'الرقم داخلي'),
    cat: col(t, 'تصنيف التعاقد'),
    type: col(t, 'نوع التعاقد'),
    date: col(t, 'تاريخ التعاقد'),
    cls: col(t, 'التصنيف'),
    sup: col(t, 'المورد'),
    src: col(t, 'المصدر'),
    ccomp: col(t, 'شركة التعاقد'),
    cno: col(t, 'رقم العقد'),
    qty: col(t, 'الكمية'),
    prem: col(t, 'بريم التعاقد'),
    ship: col(t, 'الشحن'),
    sval: col(t, 'قيمة الشحن'),
    iprice: col(t, 'سعر مبدئى'),
    cex: col(t, 'بورصة التعاقد'),
    expd: col(t, 'متوقع سداد'),
    stat: col(t, 'موقف العقد'),
    ecif: col(t, 'سعر CIF متوقع'),
    notes: col(t, 'ملاحظات التسجيل'),
  };
  const out = []; let skipped = 0;
  for (let r = t.headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const internal = str(row[ci.internal]);
    if (!internal) { skipped++; continue; }
    out.push([internal, str(row[ci.cat]), str(row[ci.type]), dt(row[ci.date]), str(row[ci.cls]), str(row[ci.sup]), str(row[ci.src]), str(row[ci.ccomp]), str(row[ci.cno]), num(row[ci.qty]), str(row[ci.prem]), str(row[ci.ship]), num(row[ci.sval]), num(row[ci.iprice]), str(row[ci.cex]), dt(row[ci.expd]), str(row[ci.stat]), num(row[ci.ecif]), str(row[ci.notes]), r+1, importId, sourceFile]);
  }
  return { rows: out, skipped };
}


const BUILDERS = {
  items: { cols: ['code','descr','uom','group_code','group_desc','class_code','class_desc','updated_at','source_file'], fn: itemsRows, pk: 'code' },
  locations: { cols: ['unit_code','company_code','company_name','currency','unit_name','place','source_file'], fn: locationRows, pk: 'unit_code' },
  movement_types: { cols: ['type_code','direction','source_file'], fn: movementTypeRows, pk: 'type_code' },
  movements: { cols: MOV_COLS, fn: movementRows, pk: null },
  sales: { cols: SALES_COLS, fn: salesRows, pk: null },
  balances: { cols: BAL_COLS, fn: balanceRows, pk: null },

  contract_items: { cols: ['code','name','direction','lot','factor','material_code','material_desc','unit','material_type','group_code','group_desc','class_code','class_desc','product_type','location','old_code','status','source_file','updated_at'], fn: contractItemsRows, pk: 'code' },
  contract_registrations: { cols: ['internal_no','contract_category','contract_type','contract_date','classification','supplier','source_country','contracting_company','contract_no','quantity','contract_premium','shipping_type','shipping_value','initial_price','contract_exchange','expected_payment_date','contract_status','expected_cif_price','notes','source_row','import_id','source_file'], fn: contractRegistrationsRows, pk: null },
  contract_details: { cols: ['internal_no','classification','source_country','external_company','internal_company','contract_no','detail_quantity','vessel_name','arrival_port','expected_arrival','operation_start','loading_duration','operation_end','contract_status','vessel_status','notes','source_row','import_id','source_file'], fn: contractDetailsRows, pk: null },
  contract_payments: { cols: ['internal_no','payment_date','payment_company','item','supplier','contract_no','internal_company','payment_type','price_type','payment_status','payment_quantity','payment_price','exchange_rate','responsible_person','notes','source_row','import_id','source_file'], fn: contractPaymentsRows, pk: null },
  contract_loading: { cols: ['internal_no','loading_date','contract_no','item','vessel_name','loading_type','loading_quantity','notes','source_row','import_id','source_file'], fn: contractLoadingRows, pk: null },
  contract_hedge: { cols: ['internal_no','hedge_date','supplier','contract_no','item','contract_exchange','contract_count','hedge_quantity','exchange_price','hedge_exchange','hedge_premium','hedge_price','hedge_value','notes','source_row','import_id','source_file'], fn: contractHedgeRows, pk: null },
  contract_roll: { cols: ['internal_no','roll_date','contract_no','supplier','item','roll_quantity','contract_exchange','hedge_exchange','previous_exchange','rolling_exchange','rolling_price','notes','source_row','import_id','source_file'], fn: contractRollRows, pk: null },
  contract_release: { cols: ['internal_no','release_date','contract_no','item','vessel_name','release_quantity','release_type','notes','source_row','import_id','source_file'], fn: contractReleaseRows, pk: null },
  contract_external_sales: { cols: ['internal_no','sale_date','contract_no','item','vessel_name','sale_quantity','notes','source_row','import_id','source_file'], fn: contractExternalSalesRows, pk: null },
  contract_balances: { cols: ['report_date','item_code','item_name','unit','qty_sawaki','qty_waha','qty_ameriya','qty_sahlia','total_balance','consumption_rate','days_enough','enough_until','contract_additions','port_additions','consumption','lot','factor','daily_rate','expenses','price_usd','market_price','source_row','import_id','source_file'], fn: contractBalancesRows, pk: null },
  contract_suppliers: { cols: ['code','name','source_file','updated_at'], fn: contractSuppliersRows, pk: 'code' },
  contract_ports: { cols: ['code','name','source_file','updated_at'], fn: contractPortsRows, pk: 'code' },
  companies: { cols: ['company_code','company_name','source_file','updated_at'], fn: contractCompaniesInternalRows, pk: 'company_code' },
  contract_countries: { cols: ['code','name','source_file','updated_at'], fn: contractCountriesRows, pk: 'code' },
  contract_arrival_ports: { cols: ['code','name','source_file','updated_at'], fn: contractArrivalPortsRows, pk: 'code' },
};

/** إدراج مجمّع مع دعم upsert للمفتاح الأساسي */
async function insertRows(ds, cols, rows, upsertPk) {
  if (!rows.length) return 0;
  if (!upsertPk) return insertBatch(TABLE_OF[ds], cols, rows, 2000);

  // upsert للأصناف/المواقع/أنواع الحركات (تحديث عند التكرار)
  // ملاحظة: يجب استبعاد التكرارات داخل الدفعة نفسها وإلا يفشل ON CONFLICT
  const pkIdx = cols.indexOf(upsertPk);
  const dedup = new Map();
  for (const r of rows) dedup.set(String(r[pkIdx]), r);   // يحتفظ بآخر ظهور
  const uniq = [...dedup.values()];

  const chunk = 2000; let total = 0;
  /* نفس حد معاملات PostgreSQL: أعمدة × صفوف ≤ 65535 */
  const size = Math.max(1, Math.min(chunk, Math.floor(60000 / Math.max(1, cols.length))));
  for (let i = 0; i < uniq.length; i += size) {
    const part = uniq.slice(i, i + size);
    const params = [];
    const tuples = part.map(r => '(' + cols.map((c, ci) => { params.push(r[ci] === undefined ? null : r[ci]); return '$' + params.length; }).join(', ') + ')');
    const updates = cols.filter(c => c !== upsertPk).map(c => `${c} = EXCLUDED.${c}`).join(', ');
    await run(
      `INSERT INTO ${TABLE_OF[ds]} (${cols.join(', ')}) VALUES ${tuples.join(', ')}
       ON CONFLICT (${upsertPk}) DO UPDATE SET ${updates}`, params);
    total += part.length;
  }
  return total;
}

async function deriveColumns(sourceFile) {
  const p = sourceFile ? [normPath(sourceFile)] : [];
  const w = sourceFile
    ? `WHERE regexp_replace(COALESCE(source_file, ''), '/', chr(92), 'g') = regexp_replace($1, '/', chr(92), 'g')`
    : '';
  await run(`UPDATE movements m SET
      place = COALESCE((SELECT l.place FROM locations l WHERE l.unit_code = m.unit_code), m.place),
      direction = (SELECT t.direction FROM movement_types t WHERE t.type_code = m.move_type)
    ${w}`, p);
  await run(`UPDATE sales s SET
      place = COALESCE((SELECT l.place FROM locations l WHERE l.unit_code = s.unit_code), s.place)
    ${w}`, p);
  await run(`UPDATE balances b SET
      place = COALESCE((SELECT l.place FROM locations l WHERE l.unit_code = b.unit_code), b.place)
    ${w}`, p);
}

function progress(stage, extra = {}) {
  try { process.stdout.write('#PROG ' + JSON.stringify({ stage, ...extra }) + '\n'); } catch (_) {}
}

/**
 * استيراد ملف كامل
 * @returns {{fileName, sheets, tables, issues, protected}}
 */
async function importFile(filePath, opts = {}) {
  /* asSource: عند استبدال ملفٍ قائم (نفس «اسم اليوم») يُستورد المحتوى الجديد
     بهوية الملف القديم نفسه حتى يُمسح صفوفه القديمة ثم تُدرج الجديدة مكانها */
  const sourceFile = opts.asSource ? normPath(opts.asSource) : normPath(filePath);
  const only = Array.isArray(opts.only) && opts.only.length ? opts.only : null;
  progress('قراءة الملف');
  const sheets = readWorkbook(filePath, { password: opts.password });
  const result = {
    fileName: path.basename(filePath), filePath,
    sheets: [], tables: [], issues: [], only: only || undefined,
    protected: sheets.some(s => s.via === 'com'),
  };

  const detected = [];
  for (const sh of sheets) {
    /* شيتات المتابعة (تقارير/ملخّصات محسوبة داخل Excel) لا تُستورد — بياناتها مشتقة
       وتكرارها يخالف جداول المصدر نفسها. */
    if (/^متابعة/.test((sh.name || '').trim())) {
      result.sheets.push({ name: sh.name, rows: (sh.rows || []).length, tables: [], skipped: 'report' });
      continue;
    }
    const tables = detectTables(sh.rows || []);
    result.sheets.push({ name: sh.name, rows: (sh.rows || []).length, tables: tables.map(t => DATASET_LABEL[t.dataset]) });
    for (const t of tables) {
      if (only && !only.includes(t.dataset)) continue;
      detected.push({ sheet: sh.name, rows: sh.rows, t });
    }
  }
  if (!detected.length) {
    result.issues.push({
      code: 'NO_TABLES', severity: 'error',
      message: only
        ? `لم يُعثر على جدول من نوع (${only.map(d => DATASET_LABEL[d] || d).join('، ')}) داخل الملف`
        : 'لم يتم العثور على جداول معروفة داخل الملف (تحقق من عناوين الأعمدة)',
    });
    return result;
  }

  const order = ['items', 'locations', 'movement_types', 'balances', 'movements', 'sales'];
  detected.sort((a, b) => order.indexOf(a.t.dataset) - order.indexOf(b.t.dataset));

/* تجميع الأصناف المستخرجة من شيتات الحركات (كود + اسم + وحدة + مجموعة) لمزامنتها
   لاحقاً مع جدول items — منع التكرار بالكود (PK) مع ON CONFLICT DO NOTHING */
const movementDerivedItems = new Map();

  for (const d of detected) {
    const ds = d.t.dataset;
    const builder = BUILDERS[ds];
    if (!builder) continue;

    progress('استيراد ' + DATASET_LABEL[ds], { dataset: ds });
    const totalRows = Math.max(0, d.rows.length - d.t.headerRow - 1);

    const importId = Number((await run(
      `INSERT INTO imports(file_path, file_name, dataset, sheet_name, rows_total) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [sourceFile, path.basename(sourceFile), ds, d.sheet, totalRows])).lastInsertRowid);

    try {
      await tx(async () => {
        /* يُبنى أولاً لأن الأرصدة تحتاج معرفة التواريخ/المفاتيح قبل الاستبدال */
        const built = builder.fn(d.rows, d.t, importId, sourceFile);
        await clearDataset(ds, sourceFile, built);
        const inserted = await insertRows(ds, builder.cols, built.rows, builder.pk);
        await run(`UPDATE imports SET rows_inserted = $1, rows_skipped = $2 WHERE id = $3`, [inserted, built.skipped, importId]);
        result.tables.push({ dataset: ds, label: DATASET_LABEL[ds], sheet: d.sheet, rows: inserted, skipped: built.skipped, importId });

      /* استخراج الأصناف من شيت الحركات (كود، اسم، وحدة، مجموعة) */
      if (ds === 'movements' && Array.isArray(built.rows)) {
        const sheetName = str(d.sheet || path.basename(sourceFile) || '');
        for (const row of built.rows) {
          const code = str(row[0]);
          if (!code) continue;
          if (!movementDerivedItems.has(code)) {
            movementDerivedItems.set(code, [
              code,                              // code
              str(row[1]),                       // descr
              str(row[2]),                       // uom
              str(row[19]),                      // group_code (من 'مجموعه المواد الخارجيه')
              str(row[20]),                      // group_desc
              str(row[17]),                      // class_code (من 'مجموعه المواد')
              str(row[18]),                      // class_desc
              new Date().toISOString(),          // updated_at
              sourceFile,                        // source_file
              'movement',                        // origin
              'item',                            // kind
              sheetName,                         // movement_sheet_name (اسم شيت الحركات)
              dateFromFileName(path.basename(sourceFile)), // movement_sheet_date (تاريخ الشيت)
              null,                              // status (محفوظ من المستخدم)
            ]);
          }
        }
      }
      });
    } catch (e) {
      await run(`UPDATE imports SET status = 'error', notes = $1 WHERE id = $2`, [String(e.message).slice(0, 500), importId]);
      result.tables.push({ dataset: ds, label: DATASET_LABEL[ds], rows: 0, error: e.message });
    }
  }

  /* ===== مزامنة الأصناف من الحركات (دائم) ===== */
  if (movementDerivedItems.size > 0) {
    progress('مزامنة الأصناف من الحركات');
    /* الاستعلام عن الأكواد الموجودة */
    const existingRows = await all('SELECT code FROM items');
    const existingSet = new Set((existingRows || []).map(r => String(r.code || '').trim()));
    const newItems = [];
    for (const [code, itemRow] of movementDerivedItems) {
      if (!existingSet.has(code)) newItems.push(itemRow);
    }
    result.itemSync = {
      totalExtracted: movementDerivedItems.size,
      alreadyExisting: movementDerivedItems.size - newItems.length,
      newItems: newItems.length,
      newCodes: newItems.map(r => r[0]),
      dryRun: !!opts.dryRun,
    };
    if (newItems.length > 0 && !opts.dryRun) {
      const itemCols = ['code','descr','uom','group_code','group_desc','class_code','class_desc','updated_at','source_file','origin','kind','movement_sheet_name','movement_sheet_date','status'];
      /* إدراج مع ON CONFLICT DO NOTHING لمنع تكرار/تحديث الأصناف المُسجّلة يدوياً */
      const chunk = 2000;
      const size = Math.max(1, Math.min(chunk, Math.floor(60000 / Math.max(1, itemCols.length))));
      let total = 0;
      for (let i = 0; i < newItems.length; i += size) {
        const part = newItems.slice(i, i + size);
        const params = [];
        const tuples = part.map(r => '(' + itemCols.map((c, ci) => { params.push(r[ci] === undefined ? null : r[ci]); return '$' + params.length; }).join(', ') + ')');
        await run(
          `INSERT INTO items (${itemCols.join(', ')}) VALUES ${tuples.join(', ')}
           ON CONFLICT (code) DO UPDATE SET
           movement_sheet_name = CASE
             WHEN EXCLUDED.movement_sheet_name IS NOT NULL AND EXCLUDED.movement_sheet_name <> ''
              THEN EXCLUDED.movement_sheet_name
              ELSE items.movement_sheet_name
           END,
           movement_sheet_date = CASE
             WHEN EXCLUDED.movement_sheet_date IS NOT NULL
              AND (items.movement_sheet_date IS NULL OR EXCLUDED.movement_sheet_date > items.movement_sheet_date)
             THEN EXCLUDED.movement_sheet_date
             ELSE items.movement_sheet_date
           END,
           updated_at = now()
         WHERE items.origin = 'movement'`, params);
        total += part.length;
      }
      result.itemSync.inserted = total;
    }
  }

  progress('اشتقاق الحقول');
  /* اشتقاق المكان/التوجيه يجري دائماً، ودائماً بعد استيراد يومي (حركات/مبيعات/
     أرصدة) لأن حقول place/direction/signed_* تُبنى منه؛ ويُعاد كشف قاعدة
     التكلفة بعد أي استيراد يؤثر على التكلفة. الإدخال اليدوي يشتق حقوله لحظة
     الحفظ (انظر src/daily-entry.js). */
  await deriveColumns(sourceFile);
  await delSetting('cost_rule');   // إعادة كشف قاعدة التكلفة بعد كل استيراد

  progress('اكتمل');
  return result;
}

function analyzePreview(filePath) {
  const sheets = readHeaderPreview(filePath, 8);
  const out = [];
  for (const sh of sheets) {
    const tables = detectTables(sh.rows || []);
    out.push({ name: sh.name, ref: sh.ref, tables: tables.map(t => ({ label: DATASET_LABEL[t.dataset], headers: t.headers })) });
  }
  return out;
}

/**
 * معاينة موسّعة قبل الاستيراد: تعرض لكل شيت كل جداول البيانات المكتشفة مع عناوين
 * الأعمدة وعيّنة من أول الصفوف داخل نطاق الجدول نفسه (كل صف مقتطع بعرض كتلته).
 * @param {string} filePath
 * @param {{maxRows?:number, only?:string[], password?:string}} opts
 * @returns {Array<{name:string, ref:string, tables:Array<{dataset,label,headers,rows}>}>}
 */
function analyzePreviewDeep(filePath, opts = {}) {
  const maxRows = Math.max(1, Math.min(Number(opts.maxRows) || 8, 50));
  const only = Array.isArray(opts.only) && opts.only.length ? opts.only : null;
  // 80 صفاً تكفي لاكتشاف العناوين (أول 15) واستخراج عيّنة مريحة لكل جدول
  const sheets = readHeaderPreview(filePath, 80, opts.password);
  const out = [];
  for (const sh of sheets) {
    const rows = sh.rows || [];
    /* شيتات المتابعة (تقارير/ملخّصات) لا تُعرض في المعاينة — لا تُستورد. */
    if (/^متابعة/.test((sh.name || '').trim())) { out.push({ name: sh.name, ref: sh.ref, tables: [] }); continue; }
    const tables = detectTables(rows)
      .filter(t => !only || only.includes(t.dataset))
      .map(t => {
        const sample = [];
        for (let r = t.headerRow + 1; r < rows.length && sample.length < maxRows; r++) {
          const row = rows[r] || [];
          const slice = [];
          let filled = false;
          for (let c = t.start; c <= t.end; c++) {
            const v = row[c];
            if (norm(v) !== '') filled = true;
            slice.push(v === null || v === undefined ? '' : v);
          }
          if (!filled) continue;   // نتخطى الصفوف الفارغة داخل الكتلة
          sample.push(slice);
        }
        return { dataset: t.dataset, label: DATASET_LABEL[t.dataset], headers: t.headers, rows: sample };
      });
    out.push({ name: sh.name, ref: sh.ref, tables });
  }
  return out;
}

module.exports = { importFile, analyzePreview, analyzePreviewDeep, detectTables, DATASET_LABEL, deriveColumns };

function contractPaymentsRows(rows,t,importId,sourceFile){const ci={internal:col(t,'الرقم داخلي'),pdate:col(t,'تاريخ السداد'),pcomp:col(t,'شركة السداد'),item:col(t,'الصنف'),sup:col(t,'المورد'),cno:col(t,'رقم العقد'),icomp:col(t,'الشركة الداخلية'),ptype:col(t,'نوع السداد'),prtype:col(t,'نوع السعر'),pstat:col(t,'موقف السداد'),pqty:col(t,'كمية السداد'),pprice:col(t,'سعر السداد'),rate:col(t,'ريت السداد'),resp:col(t,'مسئول السداد'),notes:col(t,'ملاحظات السداد')};const out=[];let skip=0;for(let r=t.headerRow+1;r<rows.length;r++){const row=rows[r]||[];const inr=str(row[ci.internal]);if(!inr){skip++;continue;}out.push([inr,dt(row[ci.pdate]),str(row[ci.pcomp]),str(row[ci.item]),str(row[ci.sup]),str(row[ci.cno]),str(row[ci.icomp]),str(row[ci.ptype]),str(row[ci.prtype]),str(row[ci.pstat]),num(row[ci.pqty]),num(row[ci.pprice]),num(row[ci.rate]),str(row[ci.resp]),str(row[ci.notes]),r+1,importId,sourceFile]);}return {rows:out,skipped:skip};}
function contractLoadingRows(rows,t,importId,sourceFile){const ci={internal:col(t,'الرقم داخلي'),ldate:col(t,'تاريخ التحميل'),cno:col(t,'رقم العقد'),item:col(t,'الصنف'),vessel:col(t,'اسم المركب'),ltype:col(t,'نوع التحميل'),lqty:col(t,'كمية التحميل'),notes:col(t,'ملاحظات التحميل')};const out=[];let skip=0;for(let r=t.headerRow+1;r<rows.length;r++){const row=rows[r]||[];const inr=str(row[ci.internal]);if(!inr){skip++;continue;}out.push([inr,dt(row[ci.ldate]),str(row[ci.cno]),str(row[ci.item]),str(row[ci.vessel]),str(row[ci.ltype]),num(row[ci.lqty]),str(row[ci.notes]),r+1,importId,sourceFile]);}return {rows:out,skipped:skip};}
function contractHedgeRows(rows,t,importId,sourceFile){const ci={internal:col(t,'الرقم داخلي'),hdate:col(t,'تاريخ الربط'),sup:col(t,'المورد'),cno:col(t,'رقم العقد'),item:col(t,'الصنف'),cex:col(t,'بورصة التعاقد'),ccount:col(t,'عدد العقود'),hqty:col(t,'كمية الربط'),eprice:col(t,'سعر البورصة'),hex:col(t,'بورصة الربط'),hprem:col(t,'بريم الربط'),hprice:col(t,'سعر الربط'),hval:col(t,'قيمة الربط'),notes:col(t,'ملاحظات الربط')};const out=[];let skip=0;for(let r=t.headerRow+1;r<rows.length;r++){const row=rows[r]||[];const inr=str(row[ci.internal]);if(!inr){skip++;continue;}out.push([inr,dt(row[ci.hdate]),str(row[ci.sup]),str(row[ci.cno]),str(row[ci.item]),str(row[ci.cex]),num(row[ci.ccount]),num(row[ci.hqty]),num(row[ci.eprice]),str(row[ci.hex]),num(row[ci.hprem]),num(row[ci.hprice]),num(row[ci.hval]),str(row[ci.notes]),r+1,importId,sourceFile]);}return {rows:out,skipped:skip};}

function contractRollRows(rows,t,importId,sourceFile){const ci={internal:col(t,'الرقم داخلي'),rdate:col(t,'تاريخ الترويل'),cno:col(t,'رقم العقد'),sup:col(t,'المورد'),item:col(t,'الصنف'),rqty:col(t,'كمية الترويل'),cex:col(t,'بورصة التعاقد'),hex:col(t,'بورصة الربط'),pex:col(t,'بورصة سابقة'),rex:col(t,'بورصة الرولينج'),rprice:col(t,'سعر الرولينج'),notes:col(t,'ملاحظات الرولينج')};const out=[];let skip=0;for(let r=t.headerRow+1;r<rows.length;r++){const row=rows[r]||[];const inr=str(row[ci.internal]);if(!inr){skip++;continue;}out.push([inr,dt(row[ci.rdate]),str(row[ci.cno]),str(row[ci.sup]),str(row[ci.item]),num(row[ci.rqty]),str(row[ci.cex]),str(row[ci.hex]),str(row[ci.pex]),str(row[ci.rex]),num(row[ci.rprice]),str(row[ci.notes]),r+1,importId,sourceFile]);}return {rows:out,skipped:skip};}
function contractReleaseRows(rows,t,importId,sourceFile){const ci={internal:col(t,'الرقم داخلي'),rdate:col(t,'تاريخ الافراج'),cno:col(t,'رقم العقد'),item:col(t,'الصنف'),vessel:col(t,'اسم المركب'),rqty:col(t,'كمية الافراج'),rtype:col(t,'نوع الافراج')};const out=[];let skip=0;for(let r=t.headerRow+1;r<rows.length;r++){const row=rows[r]||[];const inr=str(row[ci.internal]);if(!inr){skip++;continue;}out.push([inr,dt(row[ci.rdate]),str(row[ci.cno]),str(row[ci.item]),str(row[ci.vessel]),num(row[ci.rqty]),str(row[ci.rtype]),'',r+1,importId,sourceFile]);}return {rows:out,skipped:skip};}
function contractExternalSalesRows(rows,t,importId,sourceFile){const ci={internal:col(t,'الرقم داخلي'),sdate:col(t,'تاريخ البيع'),cno:col(t,'رقم العقد'),item:col(t,'الصنف'),vessel:col(t,'اسم المركب'),sqty:col(t,'كمية المبيعات')};const out=[];let skip=0;for(let r=t.headerRow+1;r<rows.length;r++){const row=rows[r]||[];const inr=str(row[ci.internal]);if(!inr){skip++;continue;}out.push([inr,dt(row[ci.sdate]),str(row[ci.cno]),str(row[ci.item]),str(row[ci.vessel]),num(row[ci.sqty]),'',r+1,importId,sourceFile]);}return {rows:out,skipped:skip};}

function contractBalancesRows(rows,t,importId,sourceFile){const ci={rdate:col(t,'تاريخ التقرير'),icode:col(t,'كود الصنف'),iname:col(t,'اسم الصنف'),unit:col(t,'الوحدة'),qs:col(t,'السواقي'),qw:col(t,'الواحة'),qa:col(t,'العامرية'),qsh:col(t,'الصالحية'),tb:col(t,'اجمالى الرصيد'),crate:col(t,'معدل الاستهلاك'),de:col(t,'يكفى لمدة'),eu:col(t,'حتي تاريخ'),cadd:col(t,'تعاقدات إضافات'),padd:col(t,'ميناء إضافات'),cons:col(t,'الاستهلاك'),lot:col(t,'اللوط'),fac:col(t,'المعامل'),drate:col(t,'الريت اليومى'),exp:col(t,'المصاريف'),pusd:col(t,'السعر بالدولار'),mprice:col(t,'سعر السوق')};const out=[];let skip=0;const fd=dateFromFileName(sourceFile);for(let r=t.headerRow+1;r<rows.length;r++){const row=rows[r]||[];const ic=str(row[ci.icode]);if(!ic){skip++;continue;}const d=ci.rdate>=0?excelSerialToISO(row[ci.rdate]):(fd||'');out.push([d,ic,str(row[ci.iname]),str(row[ci.unit]),num(row[ci.qs]),num(row[ci.qw]),num(row[ci.qa]),num(row[ci.qsh]),num(row[ci.tb]),num(row[ci.crate]),num(row[ci.de]),dt(row[ci.eu]),num(row[ci.cadd]),num(row[ci.padd]),num(row[ci.cons]),num(row[ci.lot]),num(row[ci.fac]),num(row[ci.drate]),num(row[ci.exp]),num(row[ci.pusd]),num(row[ci.mprice]),r+1,importId,sourceFile]);}return {rows:out,skipped:skip};}

/* جداول المراجع (كود + اسم): تُقرأ من موضع العنوان حتى أول صف فارغ (t.rowEnd).
   كانت تقرأ لآخر الشيت فتلتقط كتل المراجع المجاورة في نفس الأعمدة (المصادر/موانئ الوصول). */
function refRows(rows, t, importId, sourceFile) {
  const codeIdx = t.start, nameIdx = t.start + 1;
  const end = (t.rowEnd != null && t.rowEnd > t.headerRow) ? t.rowEnd : rows.length;
  const out = []; let skip = 0;
  for (let r = t.headerRow + 1; r < end; r++) {
    const row = rows[r] || [];
    const c = str(row[codeIdx]), n = str(row[nameIdx]);
    if (!c && !n) break;                        // نهاية الكتلة عند أول صف فارغ
    if (!c || !/^[A-Za-z0-9]/.test(c)) { skip++; continue; }  // نتخطى صفوف العناوين/بلا كود
    out.push([c, n, sourceFile, new Date().toISOString()]);
  }
  return { rows: out, skipped: skip };
}
function contractSuppliersRows(rows, t, i, sf) { return refRows(rows, t, i, sf); }
function contractPortsRows(rows, t, i, sf) { return refRows(rows, t, i, sf); }
function contractCompaniesInternalRows(rows, t, i, sf) { return refRows(rows, t, i, sf); }
function contractCountriesRows(rows, t, i, sf) { return refRows(rows, t, i, sf); }
function contractArrivalPortsRows(rows, t, i, sf) { return refRows(rows, t, i, sf); }
