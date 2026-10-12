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

/* ---------------- كشف نوع الجدول ---------------- */
// كل عنصر = نمط يُطبَّق على أي عنصر في صف العناوين (بعدد من الأعمدة المطلوبة)
const SIGNATURES = {
  items: [/^التصنيف$/, /وصف التصنيف/, /وصف المادة/],
  locations: [/رمز الشركة/, /اسم الشركة/, /المكان$/],
  movement_types: [/^الحركة$/, /توج.*الحركة/],
  movements: [/تاريخ الترحيل/, /كمية$/, /مبلغ بعملةمحلية/, /نوع الحركة/],
  sales: [/تاريخ الفاتورة/, /صاف[ىي] القيم[ةه]/, /الكمية المفوترة|كمية الفاتور[ةه]/, /مستند مبيع|المستند المرجع/],
  prices: [/تاريخ السعر/, /كود الصنف/, /التكلفة/, /السوق/],
  /* جدول الأرصدة اليومي: عمودَا الكمية والقيمة للفترة (بداية/نهاية) — المطابقتان
     تكفيان لتحديد الجدول. المطابقة الثانية تقبل أيضاً «إجمالي كمية البضائع» /
     «كمية إصدار البضائع» من الإصدارات الأقدم من التقرير. */
  balances: [/كمية المخزون في (بداية|نهاية) الفترة/,
             /قيمة المخزون في (بداية|نهاية) الفترة|إجمالي كمية البضائع|كمية إصدار البضائع/],
};

const DATASET_LABEL = {
  items: 'دليل الأصناف',
  locations: 'المواقع والشركات',
  movement_types: 'أنواع الحركات',
  movements: 'حركات المخزون',
  sales: 'المبيعات',
  balances: 'أرصدة المخزون',
  prices: 'الأسعار اليومية',
};

const TABLE_OF = {
  items: 'items', locations: 'locations', movement_types: 'movement_types',
  movements: 'movements', sales: 'sales', balances: 'balances', prices: 'prices',
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
  return best ? best.ds : null;
}

function headerIndex(headers) {
  const map = {};
  headers.forEach((h, i) => { const n = norm(h); if (n && map[n] === undefined) map[n] = i; });
  return map;
}

/** يجد العمود بالمطابقة الجزئية أيضاً — يُرجع الإزاحة المطلقة داخل الصف (بالنسبة لبداية الكتلة) */
function col(t, ...names) {
  const map = t.map, off = t.start || 0;
  const raw = (n) => {
    if (map[n] !== undefined) return map[n];
    const key = Object.keys(map).find(k => k === n || k.includes(n));
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

function detectTables(rows) {
  const hr = findHeaderRow(rows);
  if (!hr) return [];
  const blocks = splitBlocks(hr.header);
  const out = [];
  for (const b of blocks) {
    const headers = hr.header.slice(b.start, b.end + 1);
    const ds = classify(headers);
    if (!ds) continue;
    out.push({ dataset: ds, headerRow: hr.r, start: b.start, end: b.end, headers, map: headerIndex(headers) });
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

const PRICES_COLS = ['price_date','item_code','item','cost_land','market_land','currency',
  'source_row','import_id','source_file'];

function priceRows(rows, t, importId, sourceFile) {
  const ci = {
    date: col(t, 'تاريخ السعر'), code: col(t, 'كود الصنف'), name: col(t, 'اسم الصنف'),
    cost: col(t, 'التكلفة'), market: col(t, 'السوق'), ccy: col(t, 'العملة'),
  };
  const out = []; let skipped = 0;
  for (let r = t.headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const code = str(row[ci.code]);
    const d = excelSerialToISO(row[ci.date]);
    // صفوف ناقصة: بلا كود/تاريخ، أو صف ختامي فارغ، أو صنف بقيم null (46293)
    const cost = numx(row[ci.cost]), market = numx(row[ci.market]);
    if (!code || !d || (cost === null && market === null)) { skipped++; continue; }
    out.push([d, code, str(row[ci.name]), cost, market, str(row[ci.ccy]),
              r + 1, importId, sourceFile]);
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
  prices: { cols: PRICES_COLS, fn: priceRows, pk: null },
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

  const order = ['items', 'locations', 'movement_types', 'balances', 'movements', 'sales', 'prices'];
  detected.sort((a, b) => order.indexOf(a.t.dataset) - order.indexOf(b.t.dataset));

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
      });
    } catch (e) {
      await run(`UPDATE imports SET status = 'error', notes = $1 WHERE id = $2`, [String(e.message).slice(0, 500), importId]);
      result.tables.push({ dataset: ds, label: DATASET_LABEL[ds], rows: 0, error: e.message });
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
