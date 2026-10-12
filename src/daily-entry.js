'use strict';
/**
 * الإدخال اليدوي للبيانات اليومية — حركات / مبيعات / أرصدة
 *
 * كل صف يدوي يُوسم source_file='manual' و import_id=NULL (افتراضي)، ولا يجوز
 * تعديله أو حذفه إلا من هذه الشاشة (الصفوف القادمة من ملفات محصّنة).
 *
 * تُشتق الحقول المعتمدة على الجداول الأساسية لحظة الحفظ:
 *   المكان   ← locations.place           (بكود الوحدة)
 *   الشركة   ← locations.company_code    (إن لم تُدخل صراحةً)
 *   التوجيه  ← movement_types.direction  (بنوع الحركة)
 *   إشارة البيع ← موجبة (كمية/صافي القيمة)
 *
 * شاشتان إضافيتان بلا ملف مصدر يُقرأ:
 *   البورصة اليومية ← صف (تاريخ × صنف) بقيم السوق ومدخلات التكلفة، وهدف
 *     سعر التكلفة يُحسب هنا بنفس معادلة src/borse-edit.js حتى لا يختلف الرقم
 *     بين الشاشتين. ولا يمسّها الجلب الذاتي (انظر src/borse-fetch.js).
 *   الأسعار اليومية ← صف (تاريخ × صنف) بقيمتي التكلفة والسوق.
 *
 * كل الأرقام تمرّ عبر num() نفسها المستخدمة في الاستيراد (تفهم الفواصل والأرقام العربية)،
 * وحقول البورصة/الأسعار تمرّ عبر numx() لتمييز «لا قيمة» (NULL) عن الصفر.
 */
const { all, get, run } = require('./db');
const { num, numx } = require('./xlsx-reader');

const MANUAL = 'manual';

/* أسماء أصناف البورصة الثلاثة — ثابت احتياطي فقط؛ الاسم الرسمي يُقرأ من القاعدة
   نفسها (borseItemName) حتى يطابق ما هو مُسجَّل تاريخياً في التقارير والشارتس */
const BORSE_LABELS = { '1001': 'الــــــــــذرة', '1002': 'الصويا', '1004': 'البذرة' };
const BORSE_CODES = Object.keys(BORSE_LABELS);

/* الاسم الرسمي للصنف حسب كوده كما هو مخزَّن غالباً في جدول البورصة.
   لو كُتب الاسم بكتابة مخالفة («بذرة» بدل «البذرة») يتشقق الصنف الواحد
   إلى اثنين في التقارير والشارتس — فالاسم يُشتق من القاعدة لا من الشاشة. */
async function borseItemName(code) {
  const r = await get(
    `SELECT item FROM borse WHERE item_code = $1 AND item IS NOT NULL
     GROUP BY item ORDER BY COUNT(*) DESC, item LIMIT 1`, [code]);
  return (r && r.item) || BORSE_LABELS[code] || null;
}
const str = v => (v === null || v === undefined ? '' : String(v).trim());

async function placeOf(unit) {
  if (!unit) return null;
  const r = await get('SELECT place FROM locations WHERE unit_code = $1', [unit]);
  return r && r.place ? r.place : null;
}
async function companyOf(unit) {
  if (!unit) return null;
  const r = await get('SELECT company_code FROM locations WHERE unit_code = $1', [unit]);
  return r && r.company_code ? r.company_code : null;
}
async function directionOf(mtype) {
  if (!mtype) return null;
  const r = await get('SELECT direction FROM movement_types WHERE type_code = $1', [mtype]);
  return r && r.direction ? r.direction : null;
}

/* أعمدة الإدراج لكل جدول (بلا id / import_id) — ترتيبها مطابق لصفوف buildRow.
   الحركات/المبيعات/الأرصدة من ملفات يومية؛ البورصة والأسعار بلا ملف مصدر. */
const COLS = {
  movements: ['item', 'item_desc', 'uom', 'qty', 'move_type', 'post_date', 'doc_ref', 'customer', 'descr',
    'company_code', 'unit_code', 'storage_loc', 'amount', 'currency', 'place', 'direction', 'source_file'],
  sales: ['invoice_date', 'invoice_doc', 'ref_doc', 'item', 'item_desc', 'qty', 'net_value', 'unit_code', 'beneficiary',
    'tax', 'place', 'signed_qty', 'signed_value', 'source_file', 'storage_loc'],
  balances: ['balance_date', 'item', 'item_desc', 'base_uom', 'company_code', 'unit_code', 'storage_loc',
    'currency', 'material_type', 'open_qty', 'open_val', 'close_qty', 'close_val', 'place', 'source_file'],
  borse: ['borse_date', 'contract', 'item_code', 'item', 'low', 'high', 'close',
    'basis', 'borse_now', 'usd_rate', 'down_payment', 'fees', 'fx_factor', 'cost_price', 'source_file'],
  prices: ['price_date', 'item_code', 'item', 'cost_land', 'market_land', 'currency', 'source_file'],
};

const DATE_COL = {
  movements: 'post_date', sales: 'invoice_date', balances: 'balance_date',
  borse: 'borse_date', prices: 'price_date',
};

/** يبني صف الإدراج/التحديث بعد التحقق — يُرجع مصفوفة القيم بترتيب COLS[cat] */
async function buildRow(cat, d) {
  if (cat === 'movements') {
    const item = str(d.item), date = str(d.post_date);
    if (!item) throw new Error('كود الصنف مطلوب');
    if (!date) throw new Error('تاريخ الترحيل مطلوب');
    const unit = str(d.unit_code);
    return [
      item, str(d.item_desc), str(d.uom), num(d.qty), str(d.move_type), date, str(d.doc_ref),
      str(d.customer), str(d.descr), str(d.company_code) || await companyOf(unit) || null,
      unit || null, str(d.storage_loc), num(d.amount), str(d.currency),
      await placeOf(unit), await directionOf(str(d.move_type)), MANUAL,
    ];
  }
  if (cat === 'sales') {
    const item = str(d.item), date = str(d.invoice_date);
    if (!item) throw new Error('كود الصنف مطلوب');
    if (!date) throw new Error('تاريخ الفاتورة مطلوب');
    const unit = str(d.unit_code);
    const qty = num(d.qty), net = num(d.net_value);
    return [
      date, str(d.invoice_doc), str(d.ref_doc), item, str(d.item_desc), qty, net, unit || null,
      str(d.beneficiary), num(d.tax), await placeOf(unit), qty, net, MANUAL, str(d.storage_loc) || null,
    ];
  }
  if (cat === 'balances') {
    const item = str(d.item), date = str(d.balance_date);
    if (!item) throw new Error('كود الصنف مطلوب');
    if (!date) throw new Error('تاريخ الرصيد مطلوب');
    const unit = str(d.unit_code);
    return [
      date, item, str(d.item_desc), str(d.base_uom), str(d.company_code) || await companyOf(unit) || null,
      unit || null, str(d.storage_loc), str(d.currency), str(d.material_type),
      num(d.open_qty), num(d.open_val), num(d.close_qty), num(d.close_val),
      await placeOf(unit), MANUAL,
    ];
  }
  if (cat === 'borse') {
    const item = str(d.item_code), date = str(d.borse_date);
    if (!item) throw new Error('كود الصنف مطلوب');
    if (!date) throw new Error('تاريخ التسعير مطلوب');
    const price = numx(d.borse_now), prem = numx(d.basis), conv = numx(d.fx_factor);
    const usd = numx(d.usd_rate), fees = numx(d.fees);
    /* نفس معادلة src/borse-edit.js: (السعر + البريم) × معامل التحويل × الريت + المصاريف */
    const costUsd = (price !== null && prem !== null && conv !== null) ? (price + prem) * conv : null;
    const costLand = (costUsd !== null && usd !== null) ? costUsd * usd + (fees || 0) : null;
    return [
      date, str(d.contract) || null, item, await borseItemName(item),
      numx(d.low), numx(d.high), numx(d.close), prem, price, usd,
      numx(d.down_payment), fees, conv,
      costLand === null ? null : Math.round(costLand * 100) / 100, MANUAL,
    ];
  }
  if (cat === 'prices') {
    const itemCode = str(d.item_code), date = str(d.price_date);
    if (!itemCode) throw new Error('كود الصنف مطلوب');
    if (!date) throw new Error('تاريخ السعر مطلوب');
    const cost = numx(d.cost_land), market = numx(d.market_land);
    if (cost === null && market === null) throw new Error('أدخل التكلفة أو السوق على الأقل');
    /* الأصناف الثلاثة للبورصة تُعتمد على الاسم الرسمي من القاعدة (لا ما يُكتب بالشاشة)
       حتى لا تتشقق «البذرة» اليدوية عن «البذرة» التاريخية في التقارير */
    const itemName = BORSE_CODES.includes(itemCode) ? await borseItemName(itemCode) : str(d.item) || null;
    return [date, itemCode, itemName, cost, market, str(d.currency) || null, MANUAL];
  }
  throw new Error('فئة يومية غير معروفة');
}

/** إضافة (id غير موجود) أو تعديل (id موجود) — التعديل للصفوف اليدوية فقط */
async function save({ cat, data, id } = {}) {
  if (!COLS[cat]) throw new Error('فئة يومية غير معروفة');
  const row = await buildRow(cat, data || {});
  /* تاريخ الصف — يُعاد للخادم ليعرف من أي تاريخ يعيد بناء محرك التكلفة */
  const date = row[COLS[cat].indexOf(DATE_COL[cat])] || null;
  if (id) {
    const cur = await get(`SELECT source_file FROM ${cat} WHERE id = $1`, [id]);
    if (!cur) throw new Error('السجل غير موجود — قد يكون حُذف');
    if (str(cur.source_file) !== MANUAL) throw new Error('لا يمكن تعديل سجل قادم من ملف — اليدوي فقط');
    const set = COLS[cat].map((c, i) => `${c} = $${i + 1}`).join(', ');
    await run(`UPDATE ${cat} SET ${set} WHERE id = $${row.length + 1}`, [...row, id]);
    return { id: Number(id), cat, date };
  }
  const ph = COLS[cat].map((_, i) => `$${i + 1}`).join(', ');
  const r = await run(`INSERT INTO ${cat} (${COLS[cat].join(', ')}) VALUES (${ph}) RETURNING id`, row);
  return { id: Number(r.lastInsertRowid), cat, date };
}

async function remove({ cat, id } = {}) {
  if (!COLS[cat]) throw new Error('فئة يومية غير معروفة');
  if (!id) throw new Error('حدد السجل المطلوب حذفه');
  const col = DATE_COL[cat];
  const cur = await get(`SELECT ${col} AS d FROM ${cat} WHERE id = $1 AND COALESCE(source_file,'') = $2`, [id, MANUAL]);
  if (!cur) throw new Error('لا يمكن حذف سجل قادم من ملف — اليدوي فقط');
  const r = await run(`DELETE FROM ${cat} WHERE id = $1 AND COALESCE(source_file,'') = $2`, [id, MANUAL]);
  if (!r.changes) throw new Error('لا يمكن حذف سجل قادم من ملف — اليدوي فقط');
  return { id: Number(id), cat, date: cur.d || null };
}

async function list({ cat, limit = 300, from, to, item } = {}) {
  if (!COLS[cat]) throw new Error('فئة يومية غير معروفة');
  const dateCol = DATE_COL[cat];
  const where = [`COALESCE(source_file,'') = $1`];
  const p = [MANUAL];
  if (from) { p.push(str(from)); where.push(`${dateCol} >= $${p.length}`); }
  if (to) { p.push(str(to)); where.push(`${dateCol} <= $${p.length}`); }
  if (item) { p.push('%' + str(item) + '%'); where.push(`item ILIKE $${p.length}`); }
  const lim = Math.max(1, Math.min(Number(limit) || 300, 2000));
  const rows = await all(
    `SELECT * FROM ${cat} WHERE ${where.join(' AND ')}
     ORDER BY ${dateCol} DESC NULLS LAST, id DESC LIMIT ${lim}`, p);
  return { cat, rows };
}

module.exports = { save, remove, list, COLS, MANUAL, BORSE_LABELS };
