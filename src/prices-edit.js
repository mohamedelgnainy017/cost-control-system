'use strict';
/**
 * شاشة الأسعار اليومية + قاعدة «التعديل يسري من تاريخه فما بعد»
 * ------------------------------------------------------------------
 * القيم الأساسية تأتي من استيراد شيت «الاسعار» في ملف اليوم
 * (التاريخ، كود الصنف، التكلفة، السوق) والنظام يحمّلها للأمام
 * لكل يوم حتى لو لم يكن هناك صف جديد في الملف، ثم يطبّق فوقها
 * جدول تعديلات مؤرخ في PostgreSQL (price_overrides).
 *
 * أربع قيم لكل صنف/يوم:
 *   تكلفة أرضه  = التكلفة الأساسية (أو تعديل المستخدم)
 *   سوق أرضه    = السوق الأساسي   (أو تعديل المستخدم)
 *   تكلفة وصال  = تكلفة أرضه + النولون
 *   سوق وصال    = سوق أرضه   + النولون
 *
 * النولون مأخوذ من جدول البورصة (down_payment) محمّلاً للأمام،
 * وهو موجود على الأصناف الثلاثة فقط (الذرة/الصويا/البذرة) —
 * وأي تعديل يدوي عليه يُعدَّل من شاشة البورصة بنفس القاعدة.
 */
const DB = require('./db');

/* الأعمدة القابلة للتعديل فوق القيم الأساسية المستوردة */
const FIELDS = {
  cost:   { col: 'cost_land',   label: 'التكلفة (أرضه)', numeric: true, dec: 2 },
  market: { col: 'market_land', label: 'السوق (أرضه)',   numeric: true, dec: 2 },
};
const FIELD_KEYS = Object.keys(FIELDS);

const iso = v => (v instanceof Date)
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : String(v || '').slice(0, 10);

const num = x => {
  if (x === null || x === undefined || x === '') return null;
  const n = typeof x === 'number' ? x : parseFloat(String(x).replace(/[,\s٬]/g, ''));
  return isFinite(n) ? n : null;
};

const round = (v, d) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

function pad(n) { return String(n).padStart(2, '0'); }
function today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function daysAgo(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/**
 * كل التواريخ من from حتى to تصاعدياً (بحد أقصى يمنع انفجار الشبكة).
 * الحساب على UTC لا المحلي: توقيت Africa/Cairo يُنزلق `new Date(iso+'T00:00:00')`
 * إلى 01:00 بعد يوم التحوّل الصيفي، فتُخسر الجملة `while (d <= end)` اليوم
 * الأخير من المدى — وهذا كان خلّاً خفياً في المرحلة 2.
 */
function dateRange(from, to, maxDays = 62) {
  const out = [];
  const re = /^(\d{4})-(\d{2})-(\d{2})$/;
  const f = re.exec(String(from || '')), t = re.exec(String(to || ''));
  if (!f || !t) return out;
  const s = Date.UTC(+f[1], +f[2] - 1, +f[3]);
  const e = Date.UTC(+t[1], +t[2] - 1, +t[3]);
  if (s > e) return out;
  for (let ms = s; ms <= e && out.length < maxDays; ms += 86400000) {
    const d = new Date(ms);
    out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }
  return out;
}

/** آخر عنصر في قائمة مرتّبة مفتاحه <= key (بحث ثنائي) */
function pickLE(arr, key) {
  if (!arr || !arr.length) return null;
  let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].k <= key) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best < 0 ? null : arr[best];
}

/** تجميع صفوف مرتّبة حسب صنف وعمود إلى Map<item|col, [{k, ...}]> */
function groupBy(rows, keyFn, kFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ ...r, k: kFn(r) });
  }
  return map;
}

/** تعديلات الأسعار السارية حتى تاريخ */
async function loadOverrides(to, item) {
  const rows = await DB.all(
    `SELECT o.item_code, o.eff_date, o.field, o.value, o.note,
            u.username AS by_name
       FROM price_overrides o
       LEFT JOIN users u ON u.id = o.created_by
      WHERE o.eff_date <= $1
        AND ($2::text IS NULL OR o.item_code = $2)
      ORDER BY o.eff_date ASC, o.id ASC`,
    [to, item || null]);
  return groupBy(rows.map(r => ({ ...r, eff: iso(r.eff_date) })),
                 r => `${r.item_code}|${r.field}`, r => iso(r.eff_date));
}

/**
 * شبكة العرض: صف لكل (تاريخ × صنف) بالقيمة بعد التعديلات + الحسابات الأربع
 */
async function grid({ from, to, item } = {}) {
  to = to || today();
  from = from || to;                      // الافتراضي: يوم واحد (كل الأصناف)
  const dates = dateRange(from, to);
  if (!dates.length) throw new Error('المدى غير صالح (من > إلى)');
  const last = dates[dates.length - 1];

  /* 1) أصناف الأسعار: من الاستيراد ومن التعديلات اليدوية */
  const itemRows = await DB.all(
    `SELECT item_code, MAX(item) AS item FROM (
        SELECT item_code, item FROM prices
         WHERE ($1::text IS NULL OR item_code = $1)
        UNION ALL
        SELECT item_code, NULL::text FROM price_overrides
         WHERE ($1::text IS NULL OR item_code = $1)
     ) t GROUP BY item_code ORDER BY item_code`, [item || null]);

  /* 2) الصفوف الأساسية (مستمرة: يُحمَّل كل صنف إلى آخر صف قبله) */
  const baseRows = await DB.all(
    `SELECT price_date, item_code, item, cost_land, market_land, currency
       FROM prices
      WHERE price_date <= $1
        AND ($2::text IS NULL OR item_code = $2)
      ORDER BY price_date ASC, id ASC`,
    [last, item || null]);

  /* 3) تعديلات المستخدم فوق الأساسية */
  const ov = await loadOverrides(last, item);

  /* 4) النولون من البورصة (محمول للأمام + تعديلاته اليدوية) */
  const borseRows = await DB.all(
    `SELECT borse_date, item_code, down_payment
       FROM borse
      WHERE borse_date <= $1
        AND ($2::text IS NULL OR item_code = $2)
      ORDER BY borse_date ASC, id ASC`,
    [last, item || null]);
  const nolonOv = await DB.all(
    `SELECT item_code, eff_date, value
       FROM borse_overrides
      WHERE field = 'nolon' AND eff_date <= $1
        AND ($2::text IS NULL OR item_code = $2)
      ORDER BY eff_date ASC, id ASC`,
    [last, item || null]);

  const baseByItem = groupBy(baseRows, r => r.item_code, r => iso(r.price_date));
  const borseByItem = groupBy(borseRows, r => r.item_code, r => iso(r.borse_date));
  const nolonOvByItem = groupBy(nolonOv, r => r.item_code, r => iso(r.eff_date));

  const out = [];
  for (let i = dates.length - 1; i >= 0; i--) {          // تنازلي: الأحدث أولاً
    const d = dates[i];
    for (const ir of itemRows) {
      const code = ir.item_code;

      const b = pickLE(baseByItem.get(code), d);
      const nOv = pickLE(nolonOvByItem.get(code), d);
      const nRow = pickLE(borseByItem.get(code), d);
      const nolon = nOv ? num(nOv.value) : num(nRow && nRow.down_payment);

      const base = {}; const value = {}; const marks = {};
      for (const f of FIELD_KEYS) {
        const raw = b ? b[FIELDS[f].col] : null;
        base[f] = raw === null || raw === undefined ? '' : String(raw);
        const hit = pickLE(ov.get(`${code}|${f}`), d);
        value[f] = hit ? hit.value : base[f];
        if (hit) marks[f] = { eff: hit.eff, by: hit.by_name, note: hit.note };
      }

      const costLand = num(value.cost);
      const marketLand = num(value.market);
      const n = nolon === null || nolon === undefined ? 0 : nolon;

      out.push({
        date: d,
        item_code: code,
        item: ir.item || (b && b.item) || code,
        ccy: b ? b.currency : null,
        base,
        value,
        marks,
        calc: {
          cost_land: round(costLand, 2),
          market_land: round(marketLand, 2),
          nolon: round(n, 2),
          cost_wasal: costLand === null || costLand === undefined ? null : round(costLand + n, 2),
          market_wasal: marketLand === null || marketLand === undefined ? null : round(marketLand + n, 2),
        },
      });
    }
  }

  /* آخر تاريخ فعلي في المصدر — يُعرض كمرجع لحالة الاستيراد */
  const st = await DB.get(
    `SELECT MAX(price_date) AS last_date, COUNT(*)::int AS rows FROM prices`);
  const cnt = await DB.get(
    `SELECT COUNT(DISTINCT item_code)::int AS items FROM prices`);

  return {
    from, to, item: item || null,
    rows: out,
    meta: { last_date: st && st.last_date ? iso(st.last_date) : null,
            source_rows: st ? st.rows : 0,
            items: cnt ? cnt.items : 0,
            dates: dates.length },
  };
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
    return save(item_code, eff_date, field, String(n), note, user_id);
  }
  return save(item_code, eff_date, field, v, note, user_id);
}

async function save(item_code, eff_date, field, v, note, user_id) {
  await DB.run(
    `INSERT INTO price_overrides (item_code, eff_date, field, value, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (item_code, eff_date, field)
     DO UPDATE SET value = EXCLUDED.value, note = EXCLUDED.note,
                   created_by = EXCLUDED.created_by, created_at = now()`,
    [item_code, eff_date, field, v, note || null, user_id || null]);
  return { ok: true, item_code, eff_date, field, value: v };
}

/** إلغاء التعديل — تعود الخلية إلى القيمة الأساسية (المستوردة) */
async function remove({ item_code, eff_date, field } = {}) {
  if (!FIELD_KEYS.includes(field)) throw new Error('عمود غير معروف');
  const r = await DB.run(
    `DELETE FROM price_overrides
      WHERE item_code = $1 AND eff_date = $2 AND field = $3`,
    [item_code, eff_date, field]);
  return { ok: true, deleted: r.changes };
}

/** سجل كل التعديلات (تدقيق) */
async function history(limit = 300) {
  const rows = await DB.all(
    `SELECT o.id, o.item_code, o.eff_date, o.field, o.value,
            o.note, o.created_at, u.username AS by_name,
            (SELECT p.item FROM prices p WHERE p.item_code = o.item_code
              ORDER BY p.price_date DESC LIMIT 1) AS item_name
       FROM price_overrides o
       LEFT JOIN users u ON u.id = o.created_by
      ORDER BY o.eff_date DESC, o.created_at DESC
      LIMIT $1`, [limit]);
  return rows.map(r => ({ ...r, eff_date: iso(r.eff_date) }));
}

module.exports = {
  FIELDS, FIELD_KEYS,
  grid, set, remove, history,
  iso, num, today, daysAgo, dateRange,
};
