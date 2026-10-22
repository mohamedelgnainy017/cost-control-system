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

/* ---------------- الإدخال اليدوي لعقود الاستيراد ----------------
   مسار العقود اليومي: تسجيل العقد ← تفصيلى العقد ← التحميل/الربط/الرول/الافراج ← السداد.
   كل جدول يحمل «الرقم داخلي» كمفتاح الربط، ويُوسم الصف اليدوي source_file='manual'
   حتى يبقى مستقلاً عن صفوف الملفات المستوردة (تُعدَّل وتُحذف من الشاشة اليدوية فقط).
   الأعمدة مطابقة تماماً لأعمدة جدول الاستيراد في src/importer.js لتفادي أي انحراف. */
const CONTRACT_SPEC = {
  contract_registrations: {
    date: 'contract_date',
    required: ['contract_date', 'classification'],
    dates: ['contract_date', 'expected_payment_date'],
    nums: ['quantity', 'shipping_value', 'initial_price', 'expected_cif_price'],
    cols: ['internal_no', 'contract_category', 'contract_type', 'contract_date', 'classification',
      'supplier', 'source_country', 'contracting_company', 'contract_no', 'quantity', 'contract_premium',
      'shipping_type', 'shipping_value', 'initial_price', 'contract_exchange', 'expected_payment_date',
      'contract_status', 'expected_cif_price', 'notes', 'source_file'],
  },
  contract_details: {
    date: 'expected_arrival',
    required: ['internal_no'],
    dates: ['expected_arrival', 'operation_start', 'operation_end'],
    nums: ['detail_quantity'],
    cols: ['internal_no', 'classification', 'source_country', 'external_company', 'internal_company',
      'contract_no', 'detail_quantity', 'vessel_name', 'arrival_port', 'expected_arrival',
      'operation_start', 'loading_duration', 'operation_end', 'contract_status', 'vessel_status',
      'notes', 'source_file'],
  },
  contract_payments: {
    date: 'payment_date',
    required: ['internal_no', 'payment_date'],
    dates: ['payment_date'],
    nums: ['payment_quantity', 'payment_price', 'exchange_rate'],
    cols: ['internal_no', 'payment_date', 'payment_company', 'item', 'supplier', 'contract_no',
      'internal_company', 'payment_type', 'price_type', 'payment_status', 'payment_quantity',
      'payment_price', 'exchange_rate', 'responsible_person', 'notes', 'source_file'],
  },
  contract_loading: {
    date: 'loading_date',
    required: ['internal_no', 'loading_date'],
    dates: ['loading_date'],
    nums: ['loading_quantity'],
    cols: ['internal_no', 'loading_date', 'contract_no', 'item', 'vessel_name', 'loading_type',
      'loading_quantity', 'notes', 'source_file'],
  },
  contract_hedge: {
    date: 'hedge_date',
    required: ['internal_no', 'hedge_date'],
    dates: ['hedge_date'],
    nums: ['contract_count', 'hedge_quantity', 'exchange_price', 'hedge_premium', 'hedge_price', 'hedge_value'],
    cols: ['internal_no', 'hedge_date', 'supplier', 'contract_no', 'item', 'contract_exchange',
      'contract_count', 'hedge_quantity', 'exchange_price', 'hedge_exchange', 'hedge_premium',
      'hedge_price', 'hedge_value', 'notes', 'source_file'],
  },
  contract_roll: {
    date: 'roll_date',
    required: ['internal_no', 'roll_date'],
    dates: ['roll_date'],
    nums: ['roll_quantity', 'rolling_price'],
    cols: ['internal_no', 'roll_date', 'contract_no', 'supplier', 'item', 'roll_quantity',
      'contract_exchange', 'hedge_exchange', 'previous_exchange', 'rolling_exchange', 'rolling_price',
      'notes', 'source_file'],
  },
  contract_release: {
    date: 'release_date',
    required: ['internal_no', 'release_date'],
    dates: ['release_date'],
    nums: ['release_quantity'],
    cols: ['internal_no', 'release_date', 'contract_no', 'item', 'vessel_name', 'release_quantity',
      'release_type', 'notes', 'source_file'],
  },
};
for (const [cat, sp] of Object.entries(CONTRACT_SPEC)) { COLS[cat] = sp.cols; DATE_COL[cat] = sp.date; }

/** أي عمود يُستخدم لفلتر «الصنف» — بعض جداول العقود بلا عمود item */
const ITEM_COL = { contract_details: null, contract_registrations: null, contract_payments: 'item' };

/* ---------------- توليد «الرقم داخلي» تلقائياً (نفس معادلة ورقة Excel) ----------------
   <بادئة التصنيف><رقم الشهر MM>-<تسلسل 5 أرقام>  مثال: ذرة في أكتوبر ← CO10-00001
   التسلسل = أكبر رقم سابق بنفس البادئة والشهر + 1 (يُحسب من صفوف التسجيل المخزَّنة). */
const CLS_PREFIX = [
  ['الذرة', 'CO'], ['الصويا', 'SO'], ['صويا 44', 'S4'], ['البذرة', 'SE'],
  ['دى جى اس', 'DG'], ['دوار الشمس', 'SF'], ['جلوتين', 'GL'],
];
/** تطبيع اسم التصنيف: حذف التطويل والمسافات وتوحيد الهمزات/الياء/التاء المربوطة */
function normCls(s) {
  return String(s || '').replace(/[\u0640\s]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
}
/** بادئة التصنيف (XX لغير المعروف) */
function contractPrefix(classification) {
  const k = normCls(classification);
  const hit = CLS_PREFIX.find(([name]) => normCls(name) === k);
  return hit ? hit[1] : 'XX';
}
/** توحيد اسم التصنيف المُدخل إلى الصيغة المخزَّنة فعلاً (لمطابقة صفوف الاستيراد) */
async function canonicalClassification(raw) {
  const s = str(raw);
  if (!s) return null;
  const k = normCls(s);
  const rows = await all(`SELECT classification FROM contract_registrations
     WHERE classification IS NOT NULL AND classification <> '' GROUP BY classification`);
  const hit = rows.find(r => normCls(r.classification) === k);
  return hit ? hit.classification : s;
}
/** الرقم داخلي التالي: <بادئة><شهر>-<تسلسل 5> */
async function generateInternalNo(classification, contractDate) {
  const m = /^(\d{4})-(\d{2})/.exec(str(contractDate));
  if (!m) return null;
  const stamp = contractPrefix(classification) + m[2] + '-';
  const r = await get(
    `SELECT MAX(CAST(RIGHT(internal_no, 5) AS INTEGER)) AS mx
       FROM contract_registrations
      WHERE internal_no LIKE $1 || '%' AND RIGHT(internal_no, 5) ~ '^[0-9]+$'`, [stamp]);
  const next = Number((r && r.mx) || 0) + 1;
  return stamp + String(next).padStart(5, '0');
}

/* رسائل الحقول الإلزامية بالعربية */
const REQ_LABEL = {
  internal_no: 'الرقم داخلي', contract_date: 'تاريخ التعاقد', classification: 'التصنيف',
  payment_date: 'تاريخ السداد', loading_date: 'تاريخ التحميل', hedge_date: 'تاريخ الربط',
  roll_date: 'تاريخ الترويل', release_date: 'تاريخ الافراج',
};

/** بناء صف عقد يدوي من حقول الشاشة — التحقق من الإلزام وتحويل الأنواع/التواريخ */
async function buildContractRow(cat, d) {
  const sp = CONTRACT_SPEC[cat];
  d = { ...(d || {}) };
  /* توحيد التصنيف مع المخزَّن، ثم توليد «الرقم داخلي» لتسجيل عقد جديد بلا رقم */
  if (cat === 'contract_registrations') {
    if (sp.required.includes('classification')) {
      const canon = await canonicalClassification(d.classification);
      if (canon) d.classification = canon;
    }
    if (!str(d.internal_no)) {
      const gen = await generateInternalNo(str(d.classification), str(d.contract_date));
      if (gen) d.internal_no = gen;
    }
  }
  for (const k of sp.required) {
    if (!str(d[k])) throw new Error('حقل مطلوب: ' + (REQ_LABEL[k] || k));
  }
  const row = sp.cols.map(c => {
    if (c === 'source_file') return MANUAL;
    if (sp.dates.includes(c)) return str(d[c]) || null;
    if (sp.nums.includes(c)) return num(d[c]);
    return str(d[c]) || null;
  });
  /* قيمة الربط = كمية الربط × سعر الربط (إن لم تُدخَل صراحةً) — نفس منطق تقرير الربط */
  if (cat === 'contract_hedge') {
    const i = sp.cols.indexOf('hedge_value');
    if ((row[i] === null || row[i] === 0) && row[sp.cols.indexOf('hedge_quantity')] && row[sp.cols.indexOf('hedge_price')]) {
      row[i] = Math.round(row[sp.cols.indexOf('hedge_quantity')] * row[sp.cols.indexOf('hedge_price')] * 100) / 100;
    }
  }
  return row;
}

/** يبني صف الإدراج/التحديث بعد التحقق — يُرجع مصفوفة القيم بترتيب COLS[cat] */
async function buildRow(cat, d) {
  if (CONTRACT_SPEC[cat]) return await buildContractRow(cat, d);
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
  if (item) {
    const icol = Object.prototype.hasOwnProperty.call(ITEM_COL, cat) ? ITEM_COL[cat] : 'item';
    if (icol && COLS[cat].includes(icol)) { p.push('%' + str(item) + '%'); where.push(`${icol} ILIKE $${p.length}`); }
  }
  const lim = Math.max(1, Math.min(Number(limit) || 300, 2000));
  const rows = await all(
    `SELECT * FROM ${cat} WHERE ${where.join(' AND ')}
     ORDER BY ${dateCol} DESC NULLS LAST, id DESC LIMIT ${lim}`, p);
  return { cat, rows };
}

module.exports = { save, remove, list, COLS, MANUAL, BORSE_LABELS,
  contractPrefix, generateInternalNo, canonicalClassification, normCls };
