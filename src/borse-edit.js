'use strict';
/**
 * تعديلات البورصة اليدوية + قاعدة «التعديل يسري من تاريخه فما بعد»
 * ------------------------------------------------------------------
 * القيم الأساسية تأتي من الجلب الذاتي (src/borse-fetch.js: Yahoo + بنك مصر)،
 * والنظام يطبّق فوقها جدول تعديلات مؤرخ في PostgreSQL (borse_overrides).
 *
 * القراءة: لكل (صنف، عمود) آخر قيمة whose eff_date <= التاريخ المعروض.
 * أي تعديل بتاريخ D يغطي كل الأيام من D ولغاية ما ييجي تعديل جديد بعده.
 * الجلب لا يلمس هذا الجدول إطلاقاً: كلما كُتبت أيام جديدة بقيمتها الأساسية
 * بقي تعديل المستخدم سارياً فوقها.
 */
const DB = require('./db');
const Contract = require('./contract');

/* الأعمدة القابلة للتعديل فوق القيم الأساسية المجلوبة */
const FIELDS = {
  borse:    { col: 'contract',     label: 'العقد (بورصة)',      numeric: false, dec: 0 },
  prem:     { col: 'basis',        label: 'متوسط البريم',       numeric: true,  dec: 2 },
  price:    { col: 'borse_now',    label: 'سعر البورصة الحالي', numeric: true,  dec: 4 },
  usd:      { col: 'usd_rate',     label: 'ريت الدولار',        numeric: true,  dec: 4 },
  nolon:    { col: 'down_payment', label: 'النولون',            numeric: true,  dec: 2 },
  expenses: { col: 'fees',         label: 'المصاريف',           numeric: true,  dec: 2 },
  conv:     { col: 'fx_factor',    label: 'معامل التحويل',      numeric: true,  dec: 6 },
};
const FIELD_KEYS = Object.keys(FIELDS);

/* الجداول الثلاثة المدوّرة على البورصة (يُستخدم في حساب التكلفة لاحقاً) */
const BORSE_ITEMS = ['1001', '1002', '1004'];

const iso = v => (v instanceof Date)
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : String(v || '').slice(0, 10);

const num = x => {
  if (x === null || x === undefined || x === '') return null;
  const n = typeof x === 'number' ? x : parseFloat(String(x).replace(/[,\s٬]/g, ''));
  return isFinite(n) ? n : null;
};

const round = (v, d) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

function pad(n) { return String(n).padStart(2, '0'); }
function today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function daysAgo(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** تحميل كل التعديلات السارية حتى تاريخ معيّن، مجمّعة لكل (صنف، عمود) تصاعدياً */
async function loadOverrides(to, item) {
  const rows = await DB.all(
    `SELECT o.item_code, o.eff_date, o.field, o.value, o.note, o.created_at,
            u.username AS by_name, u.full_name AS by_full
       FROM borse_overrides o
       LEFT JOIN users u ON u.id = o.created_by
      WHERE o.eff_date <= $1
        AND ($2::text IS NULL OR o.item_code = $2)
      ORDER BY o.eff_date ASC, o.id ASC`,
    [to, item || null]);

  const map = new Map();
  for (const r of rows) {
    const k = `${r.item_code}|${r.field}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ ...r, eff: iso(r.eff_date) });
  }
  return map;
}

/** آخر تعديل ساري بتاريخ d لصنف/عمود */
function pick(map, itemCode, field, d) {
  const arr = map.get(`${itemCode}|${field}`);
  if (!arr) return null;
  let found = null;
  for (const r of arr) { if (r.eff <= d) found = r; else break; }
  return found;
}

/**
 * شبكة العرض: صف لكل (تاريخ × صنف) بالقيمة بعد التعديلات + الحسابات
 */
async function grid({ from, to, item } = {}) {
  to = to || today();
  from = from || daysAgo(to, 45);
  const rows = await DB.all(
    `SELECT borse_date, item_code, item, contract, low, high, close,
            basis, borse_now, usd_rate, down_payment, fees, fx_factor, cost_price
       FROM borse
      WHERE borse_date >= $1 AND borse_date <= $2
        AND ($3::text IS NULL OR item_code = $3)
      ORDER BY borse_date DESC, item_code ASC`,
    [from, to, item || null]);

  const ov = await loadOverrides(to, item);

  return rows.map(r => {
    const d = iso(r.borse_date);
    const base = {}; const value = {}; const marks = {};
    for (const f of FIELD_KEYS) {
      const col = FIELDS[f].col;
      const raw = r[col];
      base[f] = raw === null || raw === undefined ? '' : String(raw);
      const hit = pick(ov, r.item_code, f, d);
      value[f] = hit ? hit.value : base[f];
      if (hit) marks[f] = { eff: hit.eff, by: hit.by_name, note: hit.note };
    }

    const price = num(value.price), prem = num(value.prem), conv = num(value.conv);
    const usd = num(value.usd);
    const fees = num(value.expenses) || 0;
    const nolon = num(value.nolon) || 0;

    const costUsd = (price !== null && prem !== null && conv !== null) ? (price + prem) * conv : null;
    const costLand = (costUsd !== null && usd !== null) ? costUsd * usd + fees : null;

    return {
      date: d,
      item_code: r.item_code,
      item: r.item,
      chart: { low: r.low, high: r.high, close: r.close },
      base,
      value,
      marks,
      calc: {
        cost_usd: round(costUsd, 4),
        cost_land: round(costLand, 2),
        cost_wasal: costLand === null ? null : round(costLand + nolon, 2),
        recorded_cost: round(num(r.cost_price), 4),
      },
    };
  });
}

/** حفظ/تحديث تعديل (يسري من eff_date فما بعد) */
async function set({ item_code, eff_date, field, value, note, user_id } = {}) {
  if (!FIELD_KEYS.includes(field)) throw new Error('عمود غير معروف');
  if (!item_code) throw new Error('حدد الصنف');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(eff_date || ''))) throw new Error('تاريخ غير صالح (YYYY-MM-DD)');
  const v = String(value === null || value === undefined ? '' : value).trim();
  if (!v) throw new Error('أدخل قيمة');

  if (FIELDS[field].numeric) {
    const n = num(v);
    if (n === null) throw new Error(`«${FIELDS[field].label}» يجب أن يكون رقماً`);
    // نحفظ الصورة النهائية منظّفة (بدون فواصل)
    return save(item_code, eff_date, field, String(n), note, user_id);
  }

  if (field === 'borse') {
    // صيغة العقد المقبولة (يُخزَّن كـ «26 ديسمبر») — نمنع أي صيغة لا تفهمها
    // حتى لا تتسرب قيمة مكسورة إلى صفوف الجلب.
    const p = Contract.parseContract(v);
    if (!p) throw new Error(Contract.HINT);
    return save(item_code, eff_date, field, p.label, note, user_id);
  }

  return save(item_code, eff_date, field, v, note, user_id);
}

async function save(item_code, eff_date, field, v, note, user_id) {
  await DB.run(
    `INSERT INTO borse_overrides (item_code, eff_date, field, value, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (item_code, eff_date, field)
     DO UPDATE SET value = EXCLUDED.value, note = EXCLUDED.note,
                   created_by = EXCLUDED.created_by, created_at = now()`,
    [item_code, eff_date, field, v, note || null, user_id || null]);
  return { ok: true, item_code, eff_date, field, value: v };
}

/** إلغاء التعديل — تعود الخلية إلى قيمة الجلب الأساسية */
async function remove({ item_code, eff_date, field } = {}) {
  if (!FIELD_KEYS.includes(field)) throw new Error('عمود غير معروف');
  const r = await DB.run(
    `DELETE FROM borse_overrides
      WHERE item_code = $1 AND eff_date = $2 AND field = $3`,
    [item_code, eff_date, field]);
  return { ok: true, deleted: r.changes };
}

/** سجل كل التعديلات (تدقيق) */
async function history(limit = 300) {
  const rows = await DB.all(
    `SELECT o.id, o.item_code, b.item AS item_name, o.eff_date, o.field, o.value,
            o.note, o.created_at, u.username AS by_name
       FROM borse_overrides o
       LEFT JOIN users u ON u.id = o.created_by
       LEFT JOIN (SELECT DISTINCT item_code, item FROM borse) b ON b.item_code = o.item_code
      ORDER BY o.eff_date DESC, o.created_at DESC
      LIMIT $1`, [limit]);
  return rows.map(r => ({ ...r, eff_date: iso(r.eff_date) }));
}

module.exports = {
  FIELDS, FIELD_KEYS, BORSE_ITEMS,
  grid, set, remove, history,
  /* يُستعمل في src/cost-engine.js لإعادة تطبيق التعديلات على أيام الحمل للأمام */
  loadOverrides, pick,
  iso, num, today, daysAgo,
};
