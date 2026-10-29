'use strict';
/**
 * محرّك إعادة إنتاج نموذج Power BI لعقود الاستيراد — بالمطابقة الحرفية.
 *
 * المصدر الوحيد للحقيقة: نموذج pbix_ready2.pbix (جداوله ومقاييسه وعلاقاته
 * واستعلامات Power Query). هذا الملف يعيد بناء نفس الجداول المشتقّة ونفس
 * صيغ DAX فوق قاعدة البيانات، فينتج نفس الأرقام.
 *
 * مرجع كامل: _handover/pbix-model/  (MODEL.txt + m-queries/ + dmv-json/)
 */

const { all, get } = require('./db');
const { clsKey, ceil1000, pad2 } = require('./pure');

/* ============================ أدوات عامة ============================ */

/** رقم آمن: الفراغ/غير الرقمى → 0 */
const n = v => (v === null || v === undefined || v === '' ? 0 : (Number.isFinite(Number(v)) ? Number(v) : 0));
/** رقم أو BLANK (null) — يحافظ على سلوك DAX فى التمييز بين 0 والفراغ */
const nOrNull = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const str = v => (v === null || v === undefined ? '' : String(v));
const r2 = v => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);

const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

/** تحويل قيمة تاريخ (نص ISO أو رقم تسلسلى Excel) إلى {y,m,d} أو null */
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const num = Number(s);
    if (num > 20000 && num < 90000) {
      const d = new Date(Math.round((num - 25569) * 86400000));
      return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
    }
    return null;
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return { y: +m[3], m: +m[2], d: +m[1] };
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}
const isoDate = p => (p ? `${p.y}-${pad2(p.m)}-${pad2(p.d)}` : null);
function minDate(vals) {
  let best = null;
  for (const v of vals) {
    const p = parseDate(v);
    if (!p) continue;
    const iso = isoDate(p);
    if (best === null || iso < best.iso) best = { iso, p };
  }
  return best ? best.p : null;
}
function minText(vals) {
  let best = null;
  for (const v of vals) {
    const s = str(v).trim();
    if (!s) continue;
    if (best === null || s < best) best = s;
  }
  return best;
}

/* ============================ بناء النموذج ============================ */

/**
 * يحمّل الجداول الأساسية من قاعدة البيانات ويعيد بناء جدول «تسجيل_العقود»
 * بكل أعمدته المشتقّة (نفس استعلام Power Query حرفياً).
 *
 * @param {object} opts
 * @param {string} [opts.balanceDate]  تاريخ الرصيد المختار (فلتر تقرير) — يطبَّق على «الارصدة»
 */
async function loadModel(opts = {}) {
  const balanceDate = opts.balanceDate ? String(opts.balanceDate).slice(0, 10) : null;

  const [items, regs, details, hedges, pays, loads, rolls, releases, sells, bals, mdItems, whs] = await Promise.all([
    all(`SELECT code, name, direction, lot, factor FROM contract_items`),
    all(`SELECT * FROM contract_registrations ORDER BY source_row NULLS LAST, id`),
    all(`SELECT * FROM contract_details ORDER BY source_row NULLS LAST, id`),
    all(`SELECT * FROM contract_hedge ORDER BY source_row NULLS LAST, id`),
    all(`SELECT * FROM contract_payments ORDER BY source_row NULLS LAST, id`),
    all(`SELECT * FROM contract_loading ORDER BY source_row NULLS LAST, id`),
    all(`SELECT * FROM contract_roll ORDER BY source_row NULLS LAST, id`),
    all(`SELECT * FROM contract_release ORDER BY source_row NULLS LAST, id`),
    all(`SELECT * FROM contract_external_sales ORDER BY source_row NULLS LAST, id`),
    all(`SELECT * FROM contract_balances ORDER BY source_row NULLS LAST, id`),
    all(`SELECT code, group_code FROM items WHERE kind='item'`),
    all(`SELECT code, unit_code, report_active, is_transit FROM warehouses`),
  ]);

  /* ---- الاصناف ----
     الربط بالاسم متسامح مع اختلافات الكتابة التى تعالجها clsKey (تطويل/فراغات/
     همزات/ة/ى). نبنى:
       - itemByName:    المطابقة الحرفية السابقة كما هى (وتُصدَّر فى النموذج بلا تغيير).
       - itemByNormKey: المفتاح المطبَّع، للمفاتيح الفريدة فقط.
     عند تصادم مختلفين على نفس المفتاح المطبَّع نرفض المطابقة المطبَّعة لذلك المفتاح
     بدل اختيار صف اعتباطى، ويبقى الاحتياط الحرفى هو الحَكَم (سلوك متوافق مع السابق). */
  const itemByName = new Map();
  const itemByCode = new Map();
  const itemByNormKey = new Map();
  const ambiguousNorm = new Set();
  for (const it of items) {
    itemByName.set(str(it.name), it);
    itemByCode.set(str(it.code), it);
    const k = clsKey(it.name);
    if (!k) continue;
    if (itemByNormKey.has(k)) ambiguousNorm.add(k);
    else itemByNormKey.set(k, it);
  }
  /** يحلّ الصنف من قيمة classification: المفتاح المطبَّع أولاً (إن كان فريداً)،
   *  ثم المطابقة الحرفية احتياطاً. لا يتجاوز الاحتياط نتيجة مطبَّعة صحيحة. */
  const resolveItem = classification => {
    const raw = str(classification);
    const k = clsKey(raw);
    if (k && !ambiguousNorm.has(k)) {
      const hit = itemByNormKey.get(k);
      if (hit) return hit;
    }
    return itemByName.has(raw) ? itemByName.get(raw) : null;
  };

  /* ---- تفصيلى: تجميع بـ «الرقم داخلي» بأخذ MIN ---- */
  const detGroups = new Map();
  for (const d of details) {
    const k = str(d.internal_no);
    if (!detGroups.has(k)) detGroups.set(k, []);
    detGroups.get(k).push(d);
  }
  const detAgg = new Map();
  for (const [k, list] of detGroups) {
    const dur = list.map(d => nOrNull(d.loading_duration)).filter(v => v !== null);
    detAgg.set(k, {
      vessel: minText(list.map(d => d.vessel_name)),
      arrival_port: minText(list.map(d => d.arrival_port)),
      expected_arrival: minDate(list.map(d => d.expected_arrival)),
      operation_start: minDate(list.map(d => d.operation_start)),
      loading_duration: dur.length ? Math.min(...dur) : null,
      operation_end: minDate(list.map(d => d.operation_end)),
      vessel_status: minText(list.map(d => d.vessel_status)),
    });
  }

  /* ---- الربط ---- */
  const hedgeAgg = new Map();
  for (const h of hedges) {
    const k = str(h.internal_no);
    const o = hedgeAgg.get(k) || { sumQty: 0, anyQty: false, sp: [], rp: [], be: [] };
    const q = nOrNull(h.hedge_quantity);
    if (q !== null) { o.sumQty += Math.round(q); o.anyQty = true; }  // كمية الربط Int64
    const sp = nOrNull(h.exchange_price); if (sp !== null) o.sp.push(sp);
    const rp = nOrNull(h.hedge_price); if (rp !== null) o.rp.push(rp);
    const be = parseDate(h.hedge_exchange); if (be) o.be.push(isoDate(be));
    hedgeAgg.set(k, o);
  }

  /* ---- السداد ---- */
  const payAgg = new Map();
  for (const p of pays) {
    const k = str(p.internal_no);
    const o = payAgg.get(k) || { sumQty: 0, anyQty: false, pp: [], firstStatus: undefined };
    const q = nOrNull(p.payment_quantity);
    if (q !== null) { o.sumQty += q; o.anyQty = true; }
    const pp = nOrNull(p.payment_price); if (pp !== null) o.pp.push(pp);
    if (o.firstStatus === undefined) o.firstStatus = str(p.payment_status);
    payAgg.set(k, o);
  }

  /* ---- التحميل ---- */
  const loadAgg = new Map();
  for (const l of loads) {
    const k = str(l.internal_no);
    const o = loadAgg.get(k) || { sumQty: 0, anyQty: false };
    const q = nOrNull(l.loading_quantity);
    if (q !== null) { o.sumQty += q; o.anyQty = true; }
    loadAgg.set(k, o);
  }

  /* ---- بناء صفوف تسجيل_العقود ---- */
  const reg = [];
  let auto = 0;
  for (const g of regs) {
    auto += 1;
    const internalNo = str(g.internal_no);
    const classification = str(g.classification);
    const qty = nOrNull(g.quantity);
    const premium = nOrNull(g.contract_premium);
    const shipVal = nOrNull(g.shipping_value);
    const shipType = str(g.shipping_type);
    const cifExpected = nOrNull(g.expected_cif_price);

    const item = resolveItem(classification);
    const code = item ? str(item.code) : null;

    const det = detAgg.get(internalNo) || {};
    const h = hedgeAgg.get(internalNo);
    const p = payAgg.get(internalNo);
    const l = loadAgg.get(internalNo);

    const hedgeSum = h && h.anyQty ? h.sumQty : 0;
    const avgExchange = h && h.sp.length ? h.sp.reduce((a, b) => a + b, 0) / h.sp.length : null;
    const avgHedgePrice = h && h.rp.length ? h.rp.reduce((a, b) => a + b, 0) / h.rp.length : null;
    const maxHedgeExchange = h && h.be.length ? h.be.slice().sort().slice(-1)[0] : null;

    const paySum = p && p.anyQty ? p.sumQty : 0;
    const avgPayPrice = p && p.pp.length ? p.pp.reduce((a, b) => a + b, 0) / p.pp.length : null;
    const firstPayStatus = p ? (p.firstStatus === undefined ? '' : p.firstStatus) : '';

    const loadSum = l && l.anyQty ? l.sumQty : 0;

    const expectedArrival = det.expected_arrival || null;
    const ea = parseDate(expectedArrival);

    const monthQty = ea ? `كميات  ${pad2(ea.m)}-${String(ea.y).slice(2)}` : null;
    const monthAr = ea ? `${AR_MONTHS[ea.m - 1]} - ${String(ea.y).slice(2)}` : null;

    /* البريم CIF */
    let premCif = null;
    if (shipType === 'FOB') premCif = (shipVal || 0) / 0.393685 + (premium || 0);
    else if (shipType === 'CIF') premCif = premium || 0;

    /* السعر CIF = متوسط سعر السداد + قيمة الشحن */
    const priceCif = avgPayPrice === null ? null : avgPayPrice + (shipVal || 0);

    /* كمية الربط تقديرى */
    let hedgeEst;
    if (qty === null) hedgeEst = 0;
    else if (hedgeSum > qty) hedgeEst = qty;
    else if (Math.abs(hedgeSum - qty) <= 150) hedgeEst = qty;
    else hedgeEst = hedgeSum;

    /* موقف التسعير */
    let pricingStatus = null;
    if (hedgeSum !== 0) {
      if (hedgeSum > (qty || 0)) pricingStatus = 'مسعر بالكامل';
      else if (ceil1000(hedgeSum) === ceil1000(qty || 0)) pricingStatus = 'مسعر بالكامل';
      else if (hedgeSum < ceil1000(qty || 0)) pricingStatus = 'مسعر جزئى';
    }

    /* موقف السداد */
    let payStatus = null;
    if (firstPayStatus === 'منتظر') payStatus = null;
    else if (paySum !== 0) {
      if (paySum > (qty || 0)) payStatus = 'مسدد بالكامل';
      else if (ceil1000(paySum) === ceil1000(qty || 0)) payStatus = 'مسدد بالكامل';
      else if (paySum < ceil1000(qty || 0)) payStatus = 'مسدد جزئى';
    }

    /* كمية المطلوب سداده — العمود Int64 فى النموذج (تقريب صحيح) */
    let rawReq;
    if (firstPayStatus === 'منتظر') rawReq = paySum;
    else if (((qty || 0) - paySum) < 200) rawReq = 0;
    else rawReq = (qty || 0) - paySum;
    const requiredQty = Math.round(rawReq);
    /* قيمة المطلوب سداده = سعر CIF متوقع × الكمية الخام (قبل التقريب) — dt=8 */
    const requiredValue = (cifExpected || 0) * rawReq;

    /* حالة التجميع */
    let groupState;
    if (str(g.contract_status) !== 'FINISH' && classification === 'الصويا') groupState = 'SOYA - ' + str(cifExpected);
    else if (classification !== 'الصويا') groupState = internalNo;
    else groupState = 'مستبعد';

    reg.push({
      auto,
      internal_no: internalNo,
      contract_category: str(g.contract_category),
      contract_type: str(g.contract_type),
      contract_date: str(g.contract_date),
      classification,
      supplier: str(g.supplier),
      source: str(g.source_country),
      company: str(g.contracting_company),
      contract_no: str(g.contract_no),
      quantity: qty,
      premium,
      contract_exchange: str(g.contract_exchange),
      shipping_type: shipType,
      shipping_value: shipVal,
      initial_price: nOrNull(g.initial_price),
      expected_payment_date: str(g.expected_payment_date),
      contract_status: str(g.contract_status),
      expected_cif_price: cifExpected,
      notes: str(g.notes),
      code,
      /* تفصيلى */
      vessel: det.vessel || '',
      arrival_port: det.arrival_port || '',
      expected_arrival: expectedArrival,
      operation_start: det.operation_start || null,
      loading_duration: det.loading_duration,
      operation_end: det.operation_end || null,
      vessel_status: det.vessel_status || '',
      /* مشتقّات */
      month_qty: monthQty,
      month_ar: monthAr,
      prem_cif: premCif,
      hedge_sum: hedgeSum,
      avg_exchange: avgExchange,
      avg_hedge_price: avgHedgePrice,
      max_hedge_exchange: maxHedgeExchange,
      pay_sum: paySum,
      avg_pay_price: avgPayPrice,
      first_pay_status: firstPayStatus,
      price_cif: priceCif,
      load_sum: loadSum,
      hedge_est: hedgeEst,
      pricing_status: pricingStatus,
      pay_status: payStatus,
      required_qty: requiredQty,
      required_value: requiredValue,
      group_state: groupState,
    });
  }

  /* ---- الارصدة: التصنيف/التوجية عبر الدمج مع الاصناف بالكود ---- */
  const bal = bals.map(b => {
    const it = itemByCode.get(str(b.item_code));
    /* تحويلات النوع فى Power Query: Int64.Type → تقريب صحيح (اجمالى الرصيد/تعاقدات إضافات/المصاريف/سعر السوق) */
    const i64 = v => { const x = nOrNull(v); return x === null ? null : Math.round(x); };
    const total = i64(b.total_balance);
    const portAdd = nOrNull(b.port_additions);
    const contractAdd = i64(b.contract_additions);
    const cons = nOrNull(b.consumption);
    const available = (total || 0) + (portAdd || 0);
    const grand = available + (contractAdd || 0);
    const currentCost = (n(b.daily_rate) * n(b.price_usd)) + n(i64(b.expenses));
    return {
      report_date: str(b.report_date),
      item_code: str(b.item_code),
      item_name: str(b.item_name),
      name: it ? str(it.name) : str(b.item_name),
      classification: it ? str(it.name) : '',
      direction: it ? str(it.direction) : '',
      total_balance: total,
      consumption_rate: nOrNull(b.consumption_rate),
      days_enough: nOrNull(b.days_enough),
      enough_until: str(b.enough_until),
      contract_additions: contractAdd,
      port_additions: nOrNull(b.port_additions),
      consumption: nOrNull(b.consumption),
      lot: nOrNull(b.lot),
      factor: nOrNull(b.factor),
      daily_rate: nOrNull(b.daily_rate),
      expenses: i64(b.expenses),
      price_usd: nOrNull(b.price_usd),
      market_price: i64(b.market_price),
      available_add: available,
      total_add: grand,
      available_days: n(b.consumption) ? available / n(b.consumption) : null,
      total_days: n(b.consumption) ? grand / n(b.consumption) : null,
      current_cost: currentCost,
      diff: n(i64(b.market_price)) - currentCost,
    };
  });

  /* ---- أرصدة المصانع (أرصدة تقرير نشطة) من الأرصدة اليومية ----
     يُجمَع close_qty (رصيد نهاية اليوم) للمخازن المفعَّلة (أو ترانزيت الوحدة
     للأرصدة التي بلا مخزن) grouped by تصنيف الصنف، لتاريخ الرصيد المختار.
     يُستخدم لاحقاً لتجاوز «رصيد المصانع» (factory) في المقاييس. */
  const mdGroupByCode = new Map();
  for (const it of (mdItems || [])) if (it && it.code) mdGroupByCode.set(str(it.code), str(it.group_code));
  const activeWh = new Set();
  const transitByUnit = new Map();
  for (const w of (whs || [])) {
    if (w && w.report_active) activeWh.add(str(w.code));
    if (w && w.is_transit && w.report_active && !transitByUnit.has(str(w.unit_code))) {
      transitByUnit.set(str(w.unit_code), str(w.code));
    }
  }
  let dailyDate = null;
  if (activeWh.size) {
    try {
      const dr = await get(`SELECT COALESCE((SELECT MAX(balance_date) FROM balances WHERE balance_date <= $1),
                                             (SELECT MAX(balance_date) FROM balances)) AS d`,
        [balanceDate ? String(balanceDate).slice(0,10) : '9999-12-31']);
      dailyDate = dr && dr.d ? String(dr.d).slice(0,10) : null;
    } catch (e) { dailyDate = null; }
  }
  /* ربط استثنائى محصور فى مسار factory فقط: مجموعتا المخزن Z112-05-01
     («مضاد سموم سيلكيت» / class_desc «سموم سيلكا») و Z112-03-01
     («بريمكسات تسمين» / class_desc «بريمكس تسمين») غير موجودتين فى
     contract_items، فكانتا تُتخطّيان. نربطهما بالتصنيف المكافئ حسب
     group_desc/class_desc الفعليين: 2014 = سيلكا، 2009 = بريمكس تسمين.
     لأن الأكواد الأصلية غير مربوطة، فهذه الصفوف لم تكن تدخل الإجمالى
     مسبقاً؛ الربط على مستوى المجموعة كلها لا يكرر أى كمية. */
  const factoryGroupAlias = new Map([
    ['Z112-05-01', '2014'],
    ['Z112-03-01', '2009'],
  ]);
  /* توحيد الوحدة إلى طن: KG ÷ 1000، TO × 1. أى وحدة أخرى (PC/M/L/M3…)
     لا تُخمَّن ولا تُضاف إلى الإجمالى، ويُحصى عدد صفوفها المستبعدة. */
  const uomToTons = (uom, qty) => {
    const u = str(uom).trim().toUpperCase();
    if (u === 'KG') return n(qty) / 1000;
    if (u === 'TO') return n(qty);
    return null;
  };
  const factoryByClass = new Map();
  let factorySkippedUomRows = 0;
  if (dailyDate && activeWh.size) {
    const drows = await all(`SELECT item, unit_code, storage_loc, close_qty, base_uom FROM balances WHERE balance_date = $1`, [dailyDate]);
    for (const r of (drows || [])) {
      let grp = mdGroupByCode.get(str(r.item));
      if (!grp) continue;
      if (factoryGroupAlias.has(grp)) grp = factoryGroupAlias.get(grp);
      const it = itemByCode.get(grp);
      const cls = it ? str(it.name) : '';
      if (!cls) continue;
      const sl = str(r.storage_loc).trim();
      const effWh = sl ? sl : (transitByUnit.get(str(r.unit_code)) || '');
      if (!effWh || !activeWh.has(effWh)) continue;
      const tons = uomToTons(r.base_uom, r.close_qty);
      if (tons === null) { factorySkippedUomRows += 1; continue; }
      factoryByClass.set(cls, (factoryByClass.get(cls) || 0) + tons);
    }
  }
  const factoryMap = activeWh.size ? factoryByClass : null;

  const model = {
    items, itemByName, itemByCode,
    reg,
    bal: balanceDate ? bal.filter(b => str(b.report_date).slice(0, 10) === balanceDate) : bal,
    balAll: bal,
    factoryMap,
    dailyBalanceDate: dailyDate,
    factorySkippedUomRows,
    hedge: hedges,
    pay: pays, load: loads, roll: rolls, release: releases,
    sell: sells.map(s => ({ ...s, sale_quantity: (s.sale_quantity === null || s.sale_quantity === '' ? s.sale_quantity : Math.round(Number(s.sale_quantity))) })),
    regByNo: new Map(),
    balanceDate,
  };
  for (const r of reg) if (r.internal_no) model.regByNo.set(r.internal_no, r);

  return model;
}

/* ============================ المقاييس الأساسية (بلا تداخل) ============================ */

/**
 * حساب كل المقاييس العددية فى سياق تصفية معطى — بلا أى استدعاء ذاتى.
 * @param {object} model
 * @param {Array|null} ctx  صفوف تسجيل_العقود ضمن السياق، أو null = بلا تصفية
 */
function coreMeasures(model, ctx) {
  const allMode = ctx == null;
  const ctxArr = allMode ? model.reg : ctx;
  const byNo = new Map();
  for (const r of ctxArr) if (r.internal_no) byNo.set(r.internal_no, r);
  const classes = new Set(ctxArr.map(r => str(r.classification)));

  const status = r => str(r.contract_status);
  const notFinish = r => str(r.vessel_status) !== 'انتهاء التفريغ' && status(r) !== 'FINISH';
  const underActive = r => status(r) === 'UNDER' || status(r) === 'ACTIVE';

  const factSum = (rows, valField, pred) => {
    let any = false, s = 0;
    for (const row of rows) {
      const r = byNo.get(str(row.internal_no));
      if (!r) continue;
      if (pred && !pred(r)) continue;
      const v = nOrNull(row[valField]);
      if (v === null) continue;
      any = true; s += v;
    }
    return any ? s : null;
  };
  const rawSum = (rows, valField) => {
    let any = false, s = 0;
    for (const row of rows) {
      const v = nOrNull(row[valField]);
      if (v === null) continue;
      any = true; s += v;
    }
    return any ? s : null;
  };
  const balSum = valField => {
    let any = false, s = 0;
    for (const b of model.bal) {
      if (!classes.has(str(b.classification))) continue;
      const v = nOrNull(b[valField]);
      if (v === null) continue;
      any = true; s += v;
    }
    return any ? s : null;
  };
  const sumReg = (field, pred) => {
    let any = false, s = 0;
    for (const r of ctxArr) {
      if (pred && !pred(r)) continue;
      const v = nOrNull(r[field]);
      if (v === null) continue;
      any = true; s += v;
    }
    return any ? s : null;
  };
  const countReg = pred => {
    let c = 0;
    for (const r of ctxArr) if (!pred || pred(r)) c += 1;
    return c || null;
  };

  /* أساسيات */
  const qtyContract = allMode ? rawSum(model.reg, 'quantity') : sumReg('quantity');
  const hedgeEst = sumReg('hedge_est');

  /* نشط */
  const paidActive = factSum(model.pay, 'payment_quantity', notFinish);
  const withdrawnActive = factSum(model.load, 'loading_quantity', notFinish);
  const hedgeEstActive = sumReg('hedge_est', notFinish);
  const remaining = n(paidActive) - n(withdrawnActive);
  const factory = (model.factoryMap && model.factoryMap instanceof Map)
    ? (() => { let any = false, s = 0;
        for (const c of classes) {
          const v = model.factoryMap.get(c);
          if (v === undefined || v === null) continue;
          any = true; s += v;
        }
        return any ? s : null;
      })()
    : balSum('total_balance');
  const paidNoPricing = n(paidActive) - n(hedgeEstActive);
  const coverage = (remaining + n(factory)) - paidNoPricing;

  const paidUA = factSum(model.pay, 'payment_quantity', underActive);
  const relUA = factSum(model.release, 'release_quantity', underActive);
  const paidUnopened = n(paidUA) - n(relUA);

  const dueActive = sumReg('required_qty', r => underActive(r) && str(r.first_pay_status) !== 'منتظر');
  const contractsQty = sumReg('quantity', r => status(r) === '');
  const portBalance = (paidUnopened === remaining ? 0 : remaining) - paidUnopened;

  const releasedActive = factSum(model.release, 'release_quantity', notFinish);
  const soldActive = factSum(model.sell, 'sale_quantity', notFinish);

  const consumption = balSum('consumption');
  const totalAvailable = portBalance + n(factory);
  const totalBalance = n(paidUnopened) + n(dueActive) + n(contractsQty) + portBalance + n(factory) - n(soldActive);

  const activeDueQty = sumReg('required_qty',
    r => str(r.group_state) !== 'مستبعد' && notFinish(r) && n(r.required_qty) > 200);

  const sumRequiredValue = (() => { const v = sumReg('required_value'); return (v === null || v === 0) ? null : v; })();

  return {
    qtyContract, hedgeEst, dueQty: sumReg('required_qty'),
    paidActive, withdrawnActive, remaining, factory, paidNoPricing, coverage,
    hedgeEstActive,
    paidUnopened, dueActive, contractsQty, portBalance,
    releasedActive, soldActive, consumption, totalAvailable, totalBalance,
    availableDays: n(consumption) ? totalAvailable / n(consumption) : null,
    totalDays: n(consumption) ? totalBalance / n(consumption) : null,
    activeDueQty, sumRequiredValue,
    activeCornPaidQty: sumReg('quantity', r => notFinish(r) && str(r.classification) === 'الــــــــــذرة'),
    activeCornCount: countReg(r => notFinish(r) && str(r.classification) === 'الــــــــــذرة'),
    contractCount: countReg(),
  };
}

/* ============================ المقاييس المشتقّة ============================ */

/** الحرف بلا تطويل — تماماً كما فى DAX */
const CORN_LIT = 'الذرة';
const CORN_TAT = 'الــــــــــذرة';
const SOY = 'الصويا';
const SEED = 'البذرة';

/**
 * كل مقاييس «تسجيل_العقود» فى سياق تصفية (ctx = صفوف أو null).
 */
function measures(model, ctx) {
  const m = coreMeasures(model, ctx);
  const subOf = cls => coreMeasures(model, model.reg.filter(r => str(r.classification) === cls));

  const cornLit = subOf(CORN_LIT);
  const soy = subOf(SOY);
  const seed = subOf(SEED);
  const cornTat = subOf(CORN_TAT);

  const arrow = v => (n(v) >= 0 ? 'LO' : 'SH');
  m.hedge_position = 'الذرة ' + arrow(cornLit.coverage) +
    '     الصويا ' + arrow(soy.coverage) +
    '     البذرة ' + arrow(seed.coverage);
  m.hedge_color = (n(cornLit.coverage) < 0 || n(soy.coverage) < 0 || n(seed.coverage) < 0) ? '#F2ADAD' : '#B7D1C4';

  /* مقاييس الذرة (بالتطويل) */
  m.cornPricedCoverage = cornTat.coverage;
  m.cornPricedWithoutPay = cornTat.paidNoPricing;
  m.cornPricedLabel = cornTat.paidNoPricing === null ? null
    : (cornTat.paidNoPricing >= 0 ? 'مسعّر مع سداد' : 'مسعّر بدون سداد');

  /* أعلى قيمة بورصة فى السياق */
  m.maxBourse = highestExchange(model, ctx == null ? null : ctx);
  return m;
}

/* ============================ تجميعات مساعدة ============================ */

/** صفوف لكل تصنيف فى «تسجيل_العقود» */
function classRows(model) {
  const seen = new Set();
  const out = [];
  for (const r of model.reg) {
    const c = str(r.classification);
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out.map(cls => {
    const rows = model.reg.filter(r => str(r.classification) === cls);
    return { cls, rows, m: measures(model, rows) };
  });
}

/** أعلى قيمة بورصة: COALESCE(MAX(الرولينج), MAX(الربط), MAX(تسجيل_العقود)) */
function highestExchange(model, ctx) {
  const allRows = ctx == null ? model.reg : ctx;
  const nos = new Set(allRows.map(r => r.internal_no));
  const maxOf = (rows, noOk, field) => {
    const v = [];
    for (const r of rows) {
      if (!noOk(r)) continue;
      const p = parseDate(r[field]);
      if (p) v.push(isoDate(p));
    }
    return v.length ? v.sort().slice(-1)[0] : null;
  };
  const rollMax = ctx == null
    ? maxOf(model.roll, () => true, 'rolling_exchange')
    : maxOf(model.roll, r => nos.has(r.internal_no), 'rolling_exchange');
  const hedgeMax = ctx == null
    ? maxOf(model.hedge, () => true, 'hedge_exchange')
    : maxOf(model.hedge, r => nos.has(r.internal_no), 'hedge_exchange');
  const regMax = maxOf(allRows, () => true, 'contract_exchange');
  return rollMax || hedgeMax || regMax || null;
}

/** صافي البريم النهائي لعقد واحد (نفس DAX SELECTEDVALUE) */
function finalNetPremium(model, regRow) {
  const internalNo = regRow.internal_no;
  const category = regRow.classification;
  const original = regRow.premium;

  const vals = model.reg
    .filter(r => r.internal_no === internalNo && str(r.classification) === category)
    .map(r => nOrNull(r.premium)).filter(v => v !== null);
  const rabtPremium = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const basePremium = rabtPremium === null ? original : rabtPremium;

  const rollRows = model.roll.filter(r => r.internal_no === internalNo && str(r.item) === category);
  const bourses = [...new Set(rollRows.map(r => str(r.rolling_exchange)).filter(Boolean))];
  let rollingImpact = 0;
  for (const bo of bourses) {
    const rs = rollRows.filter(r => str(r.rolling_exchange) === bo);
    const num = rs.reduce((a, r) => a + n(r.roll_quantity) * n(r.rolling_price), 0);
    const den = rs.reduce((a, r) => a + n(r.roll_quantity), 0);
    rollingImpact += den ? num / den : 0;
  }
  return n(basePremium) + rollingImpact;
}

/** صافي البريم = صافي البريم النهائي + قيمة الشحن/0.393685 */
function netPremium(model, regRow) {
  return finalNetPremium(model, regRow) + n(regRow.shipping_value) / 0.393685;
}

module.exports = {
  loadModel, measures, coreMeasures, classRows,
  finalNetPremium, netPremium, highestExchange,
  helpers: { n, nOrNull, str, r2, parseDate, isoDate, AR_MONTHS },
};
