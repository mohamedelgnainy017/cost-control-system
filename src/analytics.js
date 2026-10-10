'use strict';
/**
 * محرك التحليل — PostgreSQL
 * مؤشرات الأداء، مطابقة المخزون، تحليل المبيعات والحركات.
 * كل الأرقام تُحسب من الجداول الخام داخل قاعدة البيانات (لا اعتماد على تقارير Excel).
 */
const { all, get, run, tx, setSetting, getSetting, delSetting } = require('./db');

/* ---------- قاعدة احتساب التكلفة ---------- */
/**
 * - 'indicator_L' : حركات مؤشر الحركة = L (تكلفة الوحدات المباعة)
 * - 'outbound'    : الحركات التي توجيهها صادر
 */
async function detectCostRule() {
  const saved = await getSetting('cost_rule');
  if (saved) return saved;

  let rule = 'outbound';
  const withL = await get(`SELECT COUNT(*)::int c FROM movements WHERE move_indicator = 'L'`);
  if (withL.c > 0) {
    rule = 'indicator_L';
  } else {
    const t = await get(`SELECT COUNT(*)::int c FROM movement_types WHERE direction LIKE '%صادر%'`);
    if (t.c > 0) rule = 'outbound';
  }
  await setSetting('cost_rule', rule);
  return rule;
}

async function costWhere() {
  const rule = await detectCostRule();
  if (rule === 'indicator_L') return `move_indicator = 'L'`;
  return `direction LIKE '%صادر%'`;
}

/* ---------- فلاتر مشتركة: من معاملات URL إلى شروط SQL ---------- */
/* علامة خاصة تُرسَل من القوائم المنسدلة للقيم الفارغة («غير محدد») */
const EMPTY = '__EMPTY__';

function parseFilters(q) {
  const get = k => { const v = q ? String(q.get(k) || '') : ''; return v.trim(); };
  return {
    from: get('from'), to: get('to'),
    place: get('place'), company: get('company'), unit: get('unit'),
    item: get('item'), cust: get('cust'), dir: get('dir'), mtype: get('mtype'),
    sev: get('sev'), ent: get('ent'),
  };
}

function hasFilters(F = {}) {
  return ['from', 'to', 'place', 'company', 'unit', 'item', 'cust', 'dir', 'mtype'].some(k => !!F[k]);
}

/* خريطة الأعمدة لكل جدول (بعامودها المؤهَّل بالاسم المستعار) */
const SALES_COLS = { date: 's.invoice_date', place: 's.place', item: 's.item', unit: 's.unit_code', cust: 's.beneficiary' };
const MOV_COLS = { date: 'm.post_date', place: 'm.place', item: 'm.item', unit: 'm.unit_code', company: 'm.company_code', mtype: 'm.move_type', dir: 'm.direction' };
const BAL_COLS = { date: 'b.balance_date', place: 'b.place', item: 'b.item', unit: 'b.unit_code', company: 'b.company_code' };

/* يبني الشروط من الفلاتر على حسب خريطة الأعمدة.
   start: رقم أول معامل (لتدمج شروط عدة استعلامات في استعلام واحد). */
function conds(F = {}, map = {}, start = 1) {
  const c = [], p = [];
  let i = start;
  const add = (col, v) => { if (v) { c.push(`${col} = $${i}`); p.push(v); i++; } };
  const addOrNone = (col, v) => {
    if (!col) return;
    if (v === EMPTY) { c.push(`(COALESCE(${col},'') = '')`); i++; }
    else add(col, v);
  };
  if (F.from) { c.push(`${map.date} >= $${i}`); p.push(F.from); i++; }
  if (F.to) { c.push(`${map.date} <= $${i}`); p.push(F.to); i++; }
  addOrNone(map.place, F.place);
  addOrNone(map.company, F.company);
  addOrNone(map.unit, F.unit);
  if (F.item) { c.push(`${map.item} ILIKE $${i}`); p.push('%' + F.item + '%'); i++; }
  addOrNone(map.cust, F.cust);
  addOrNone(map.dir, F.dir);
  add(map.mtype, F.mtype);
  return { sql: c.length ? c.join(' AND ') : '', params: p };
}

/* نسخة من الفلاتر بدون التاريخ — تُستخدم حيث التاريخ يكسر المنطق (مطابقة الأزواج) */
const noDates = F => ({ ...F, from: '', to: '' });

/* ---------- المؤشرات الرئيسية ---------- */
async function overview(F = {}) {
  const cw = await costWhere();
  const ws = conds(F, SALES_COLS);
  const wm = conds(F, MOV_COLS);
  const wb = conds(F, BAL_COLS);

  const sales = await get(`
    SELECT COUNT(*)::int lines, COUNT(DISTINCT invoice_doc)::int docs,
           SUM(signed_value)::float value, SUM(signed_qty)::float qty,
           MIN(invoice_date) dmin, MAX(invoice_date) dmax
    FROM sales s ${ws.sql ? 'WHERE ' + ws.sql : ''}`, ws.params);
  const costAll = await get(`SELECT COUNT(*)::int lines, COALESCE(SUM(amount),0)::float cost
                             FROM movements m WHERE ${cw}${wm.sql ? ' AND ' + wm.sql : ''}`,
    wm.params);
  const bal = await get(`
    SELECT COUNT(*)::int lines,
           COALESCE(SUM(open_val),0)::float open_val, COALESCE(SUM(close_val),0)::float close_val,
           COALESCE(SUM(open_qty),0)::float open_qty, COALESCE(SUM(close_qty),0)::float close_qty
    FROM balances b ${wb.sql ? 'WHERE ' + wb.sql : ''}`, wb.params);
  const mov = await get(`
    SELECT COUNT(*)::int lines, COALESCE(SUM(qty),0)::float qty, COALESCE(SUM(amount),0)::float amount,
           MIN(post_date) dmin, MAX(post_date) dmax
    FROM movements m ${wm.sql ? 'WHERE ' + wm.sql : ''}`, wm.params);

  const counts = {
    items: (await get(`SELECT COUNT(*)::int c FROM items WHERE kind='item'`)).c,
    locations: (await get('SELECT COUNT(*)::int c FROM locations')).c,
    movement_types: (await get('SELECT COUNT(*)::int c FROM movement_types')).c,
    movements: mov.lines,
    sales: sales.lines,
    balances: bal.lines,
    sources: (await get(`SELECT COUNT(DISTINCT source_file)::int c FROM movements`)).c,
  };

  const cogs = Math.abs(costAll.cost || 0);
  const revenue = sales.value || 0;
  return {
    period: { salesFrom: sales.dmin, salesTo: sales.dmax, movFrom: mov.dmin, movTo: mov.dmax },
    counts,
    revenue,
    revenueDocs: sales.docs,
    cogs,
    grossProfit: revenue - cogs,
    marginPct: revenue ? ((revenue - cogs) / revenue) * 100 : 0,
    inventory: {
      openVal: bal.open_val, closeVal: bal.close_val,
      openQty: bal.open_qty, closeQty: bal.close_qty,
      changeVal: bal.close_val - bal.open_val,
      lines: bal.lines,
    },
    movements: { lines: mov.lines, qty: mov.qty, amount: mov.amount },
    costRule: await detectCostRule(),
    costLines: costAll.lines,
  };
}

/* ---------- مطابقة الأرصدة: رصيد نهاية التاريخ السابق ⇐ رصيد بداية التاريخ التالي ---------- */
async function reconcile({ limit = 100, offset = 0, onlyMismatch = true, F = {} } = {}) {
  /* فلاتر غير التاريخية تُطبَّق في SQL؛ والتاريخ يُرشِّح الأزواج في الذاكرة حسب تاريخ الزوج اللاحق */
  const wb = conds(noDates(F), BAL_COLS);
  const rows = await all(`
    WITH per AS (
      /* المفتاح قد يحمل أكثر من سطر في الملف نفسه (107 مفاتيح مكررة بقيم مختلفة)
         → نجمّع القيم بمجموع SUM كما فعل الكود القديم، ووصفياً MAX */
      SELECT item, company_code, unit_code, storage_loc, balance_date,
             MAX(item_desc) item_desc, MAX(place) place,
             SUM(open_qty)::float open_qty, SUM(open_val)::float open_val,
             SUM(close_qty)::float close_qty, SUM(close_val)::float close_val
      FROM balances b ${wb.sql ? 'WHERE ' + wb.sql : ''}
      GROUP BY item, company_code, unit_code, storage_loc, balance_date
    ), seq AS (
      SELECT p.*,
             LAG(balance_date) OVER w AS prev_date,
             LAG(close_qty)    OVER w AS prev_close_qty,
             LAG(close_val)    OVER w AS prev_close_val
      FROM per p
      WINDOW w AS (PARTITION BY item, company_code, unit_code, storage_loc ORDER BY balance_date)
    )
    SELECT item, item_desc, company_code, unit_code, storage_loc, place,
           prev_date, balance_date AS next_date,
           prev_close_qty, prev_close_val, open_qty, open_val
    FROM seq
    WHERE prev_date IS NOT NULL
  `, wb.params);

  let norm = rows.map(r => ({
    ...r,
    close_val: r.prev_close_val || 0,    // نهاية التاريخ السابق
    close_qty: r.prev_close_qty || 0,
    mv_val: 0, mv_qty: 0,                // لا تدخل الحركات في هذه المطابقة
    diff_val: (r.prev_close_val || 0) - (r.open_val || 0),
    diff_qty: (r.prev_close_qty || 0) - (r.open_qty || 0),
  }));

  /* فلتر التاريخ: يعرض الأزواج التي يقع تاريخها اللاحق ضمن النطاق */
  if (F.from) norm = norm.filter(r => !r.next_date || r.next_date >= F.from);
  if (F.to) norm = norm.filter(r => !r.next_date || r.next_date <= F.to);

  const mismatches = norm.filter(r => Math.abs(r.diff_val) > 1 || Math.abs(r.diff_qty) > 0.001);
  const totalDiff = norm.reduce((s, r) => s + r.diff_val, 0);

  await tx(async () => {
    await run('DELETE FROM recon');
    if (norm.length) {
      const chunk = 2000;
      for (let i = 0; i < norm.length; i += chunk) {
        const part = norm.slice(i, i + chunk);
        const params = [];
        const tuples = part.map(r => {
          const vals = [
            `${r.item}|${r.company_code}|${r.unit_code}|${r.storage_loc}|${r.prev_date}->${r.next_date}`,
            r.item, r.item_desc, r.company_code, r.unit_code, r.storage_loc, r.place,
            r.prev_date, r.next_date,
            r.open_val, 0, r.close_val, r.diff_val,
            r.open_qty, 0, r.close_qty, r.diff_qty, new Date().toISOString(),
          ];
          return '(' + vals.map(v => { params.push(v === undefined ? null : v); return '$' + params.length; }).join(', ') + ')';
        });
        await run(`INSERT INTO recon
          (key,item,item_desc,company_code,unit_code,storage_loc,place,prev_date,next_date,open_val,moves_val,close_val,diff_val,
           open_qty,moves_qty,close_qty,diff_qty,calc_at) VALUES ${tuples.join(', ')}`, params);
      }
    }
  });

  const filtered = onlyMismatch ? mismatches : norm;
  filtered.sort((a, b) => Math.abs(b.diff_val) - Math.abs(a.diff_val));
  return {
    keys: norm.length,
    matched: norm.length - mismatches.length,
    mismatches: mismatches.length,
    totalDiff,
    sample: filtered.slice(offset, offset + limit),
  };
}

/* ---------- تحليل المبيعات ---------- */
async function salesByPlace(F = {}) {
  const cw = await costWhere();
  const wm = conds(F, MOV_COLS);                                  // التكلفة من الحركات بنفس الفلاتر
  const ws = conds(F, SALES_COLS, wm.params.length + 1);
  const rows = await all(`
    WITH cost AS (
      SELECT m.place, SUM(m.amount)::float cost FROM movements m
      WHERE ${cw}${wm.sql ? ' AND ' + wm.sql : ''} GROUP BY 1
    )
    SELECT COALESCE(NULLIF(s.place,''),'(غير محدد)') place,
           COUNT(*)::int lines, COUNT(DISTINCT s.invoice_doc)::int docs,
           SUM(s.signed_value)::float value, SUM(s.signed_qty)::float qty,
           COALESCE(MAX(ABS(cost.cost)),0)::float cost
    FROM sales s
    LEFT JOIN cost ON cost.place = s.place
    ${ws.sql ? 'WHERE ' + ws.sql : ''}
    GROUP BY 1 ORDER BY ABS(COALESCE(SUM(s.signed_value),0)) DESC`,
    [...wm.params, ...ws.params]);
  return rows.map(r => ({
    ...r,
    profit: r.value - (r.cost || 0),
    marginPct: r.value ? ((r.value - r.cost) / r.value) * 100 : 0,
  }));
}

async function salesByItem(F = {}, limit = 50) {
  const ws = conds(F, SALES_COLS);
  return all(`
    SELECT s.item, MAX(s.item_desc) descr, MAX(s.place) place,
           COUNT(*)::int lines, SUM(s.signed_value)::float value, SUM(s.signed_qty)::float qty
    FROM sales s ${ws.sql ? 'WHERE ' + ws.sql : ''}
    GROUP BY s.item ORDER BY ABS(COALESCE(SUM(s.signed_value),0)) DESC LIMIT $${ws.params.length + 1}`,
    [...ws.params, limit]);
}

async function salesByMonth(F = {}) {
  const ws = conds(F, SALES_COLS);
  return all(`
    SELECT SUBSTR(s.invoice_date,1,7) ym, COUNT(*)::int lines,
           SUM(s.signed_value)::float value, SUM(s.signed_qty)::float qty
    FROM sales s ${ws.sql ? 'WHERE ' + ws.sql : ''}
    GROUP BY 1 ORDER BY 1`, ws.params);
}

async function salesByCustomer(F = {}, limit = 50) {
  const ws = conds(F, SALES_COLS);
  return all(`
    SELECT COALESCE(NULLIF(s.beneficiary,''),'(غير محدد)') customer, COUNT(*)::int lines,
           SUM(s.signed_value)::float value, SUM(s.tax)::float tax
    FROM sales s ${ws.sql ? 'WHERE ' + ws.sql : ''}
    GROUP BY 1 ORDER BY ABS(COALESCE(SUM(s.signed_value),0)) DESC LIMIT $${ws.params.length + 1}`,
    [...ws.params, limit]);
}

async function salesByClass(F = {}) {
  const ws = conds(F, SALES_COLS);
  return all(`
    SELECT COALESCE(s.doc_class,'') || COALESCE(s.doc_status,'') combo, COUNT(*)::int lines,
           SUM(s.signed_value)::float value, SUM(s.signed_qty)::float qty
    FROM sales s ${ws.sql ? 'WHERE ' + ws.sql : ''}
    GROUP BY 1 ORDER BY ABS(COALESCE(SUM(s.signed_value),0)) DESC`, ws.params);
}

async function costByMonth(F = {}) {
  const cw = await costWhere();
  const wm = conds(F, MOV_COLS);
  return all(`
    SELECT SUBSTR(m.post_date,1,7) ym, ABS(SUM(m.amount))::float cost, COUNT(*)::int lines
    FROM movements m WHERE ${cw} AND m.post_date IS NOT NULL${wm.sql ? ' AND ' + wm.sql : ''}
    GROUP BY 1 ORDER BY 1`, wm.params);
}

/* ---------- تحليل الحركات ---------- */
async function movementsByDirection(F = {}) {
  const wm = conds(F, MOV_COLS);
  return all(`
    SELECT COALESCE(NULLIF(m.direction,''),'(غير محدد)') direction,
           COUNT(*)::int lines, SUM(m.qty)::float qty, SUM(m.amount)::float amount,
           SUM(CASE WHEN m.amount > 0 THEN m.amount ELSE 0 END)::float inbound,
           SUM(CASE WHEN m.amount < 0 THEN m.amount ELSE 0 END)::float outbound
    FROM movements m ${wm.sql ? 'WHERE ' + wm.sql : ''}
    GROUP BY 1 ORDER BY COUNT(*) DESC`, wm.params);
}

async function movementsByMonth(F = {}) {
  const wm = conds(F, MOV_COLS);
  return all(`
    SELECT SUBSTR(m.post_date,1,7) ym,
           SUM(CASE WHEN m.amount > 0 THEN m.amount ELSE 0 END)::float inbound,
           SUM(CASE WHEN m.amount < 0 THEN m.amount ELSE 0 END)::float outbound,
           SUM(m.amount)::float net, COUNT(*)::int lines
    FROM movements m WHERE m.post_date IS NOT NULL${wm.sql ? ' AND ' + wm.sql : ''}
    GROUP BY 1 ORDER BY 1`, wm.params);
}

async function movementsByPlace(F = {}) {
  const wm = conds(F, MOV_COLS);
  return all(`
    SELECT COALESCE(NULLIF(m.place,''),'(غير محدد)') place, COUNT(*)::int lines,
           SUM(CASE WHEN m.amount > 0 THEN m.amount ELSE 0 END)::float inbound,
           SUM(CASE WHEN m.amount < 0 THEN m.amount ELSE 0 END)::float outbound,
           SUM(m.amount)::float net
    FROM movements m ${wm.sql ? 'WHERE ' + wm.sql : ''}
    GROUP BY 1 ORDER BY COUNT(*) DESC`, wm.params);
}

async function topMovementItems(F = {}, limit = 30) {
  const wm = conds(F, MOV_COLS);
  return all(`
    SELECT m.item, MAX(m.item_desc) descr, MAX(m.place) place,
           COUNT(*)::int lines, SUM(m.qty)::float qty, SUM(m.amount)::float amount
    FROM movements m ${wm.sql ? 'WHERE ' + wm.sql : ''}
    GROUP BY m.item ORDER BY ABS(COALESCE(SUM(m.amount),0)) DESC LIMIT $${wm.params.length + 1}`,
    [...wm.params, limit]);
}

/* ---------- توزيع المخزون ---------- */
async function inventoryByPlace(F = {}) {
  const wb = conds(F, BAL_COLS);
  return all(`
    SELECT COALESCE(NULLIF(b.place,''),'(غير محدد)') place,
           SUM(b.open_qty)::float open_qty, SUM(b.close_qty)::float close_qty,
           SUM(b.open_val)::float open_val, SUM(b.close_val)::float close_val
    FROM balances b ${wb.sql ? 'WHERE ' + wb.sql : ''}
    GROUP BY 1 ORDER BY COALESCE(SUM(b.close_val),0) DESC`, wb.params);
}

async function inventoryByClass(F = {}) {
  const wb = conds(F, BAL_COLS);
  return all(`
    SELECT COALESCE(i.class_desc,'(غير مصنف)') cls,
           SUM(b.close_val)::float close_val, SUM(b.close_qty)::float close_qty
    FROM balances b LEFT JOIN items i ON i.code = b.item
    ${wb.sql ? 'WHERE ' + wb.sql : ''}
    GROUP BY 1 ORDER BY COALESCE(SUM(b.close_val),0) DESC`, wb.params);
}

/* ---------- قوائم الفلاتر: القيم المميزة لبُعد معين في جدول معين ---------- */
const DIM_TABLES = {
  sales:     { place: 's.place',        unit: 's.unit_code',    cust: 's.beneficiary' },
  movements: { place: 'm.place',        unit: 'm.unit_code',    company: 'm.company_code',
               mtype: 'm.move_type',    dir: 'm.direction' },
  balances:  { place: 'b.place',        unit: 'b.unit_code',    company: 'b.company_code' },
};
const DIM_SRC = { sales: 'sales s', movements: 'movements m', balances: 'balances b' };

async function dims(q) {
  const dim = String(q.get('dim') || '');
  const src = String(q.get('src') || '');
  const map = DIM_TABLES[src];
  const col = map && map[dim];
  if (!col) return [];
  const rows = await all(`
    SELECT DISTINCT ${col} v FROM ${DIM_SRC[src]}
    WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY 1 LIMIT 1000`);
  return rows.map(r => r.v);
}

async function dateSpan() {
  const mov = await get('SELECT MIN(post_date) a, MAX(post_date) b FROM movements');
  const sal = await get('SELECT MIN(invoice_date) a, MAX(invoice_date) b FROM sales');
  const bal = await get('SELECT MIN(balance_date) a, MAX(balance_date) b FROM balances');
  return { movements: [mov.a, mov.b], sales: [sal.a, sal.b], balances: bal };
}

async function sources() {
  return all(`
    SELECT source_file,
           SUM(mov)::int movements,
           SUM(sal)::int sales,
           SUM(bor)::int borse,
           MAX(last_import) last_import
    FROM (
      SELECT m.source_file, COUNT(*)::int mov, 0::int sal, 0::int bor, MAX(i.imported_at) last_import
      FROM movements m LEFT JOIN imports i ON i.id = m.import_id
      GROUP BY 1
      UNION ALL
      SELECT s.source_file, 0::int, COUNT(*)::int, 0::int, MAX(i.imported_at)
      FROM sales s LEFT JOIN imports i ON i.id = s.import_id
      GROUP BY 1
      UNION ALL
      SELECT b.source_file, 0::int, 0::int, COUNT(*)::int, MAX(i.imported_at)
      FROM borse b LEFT JOIN imports i ON i.id = b.import_id
      GROUP BY 1
    ) t
    GROUP BY source_file
    ORDER BY SUM(mov) DESC`);
}

/* ---------- أسعار البورصة اليومية ---------- */
/** حدّ الزمن = آخر تاريخ مسجَّل ناقص عدّ الأيام المطلوبة */
async function borseCutoff(days) {
  const d = await get('SELECT MAX(borse_date) a FROM borse');
  if (!d || !d.a) return null;
  const ms = Date.parse(d.a + 'T00:00:00Z');
  if (!Number.isFinite(ms)) return d.a;
  return new Date(ms - Math.max(0, Number(days) || 0) * 86400000).toISOString().slice(0, 10);
}

/** آخر سعر لكل صنف + السعر السابق للمقارنة */
async function borseLatest() {
  return all(`
    WITH c AS (
      SELECT borse_date, item, item_code, contract, close, low, high, borse_now, usd_rate, cost_price,
             ROW_NUMBER() OVER (PARTITION BY COALESCE(item, item_code, '') ORDER BY borse_date DESC, id DESC) rn
      FROM borse WHERE close IS NOT NULL
    )
    SELECT item, MAX(item_code) item_code,
           MAX(borse_date) FILTER (WHERE rn = 1) borse_date,
           MAX(contract)    FILTER (WHERE rn = 1) contract,
           MAX(close)       FILTER (WHERE rn = 1) close,
           MAX(low)         FILTER (WHERE rn = 1) low,
           MAX(high)        FILTER (WHERE rn = 1) high,
           MAX(borse_now)   FILTER (WHERE rn = 1) borse_now,
           MAX(usd_rate)    FILTER (WHERE rn = 1) usd_rate,
           MAX(cost_price)  FILTER (WHERE rn = 1) cost_price,
           MAX(close)       FILTER (WHERE rn = 2) prev_close
    FROM c GROUP BY 1 ORDER BY 1`);
}

/** سلسلة الإغلاق اليومي لكل صنف ضمن فترة */
async function borseSeries({ days = 120, item = '' } = {}) {
  const cutoff = await borseCutoff(days);
  if (!cutoff) return [];
  return all(`
    SELECT borse_date, item, item_code, close, usd_rate
    FROM borse
    WHERE close IS NOT NULL AND borse_date >= $1
      AND ($2 = '' OR item = $2 OR item_code = $2)
    ORDER BY borse_date`, [cutoff, item || '']);
}

/** ريت الدولار اليومي المسجَّل */
async function borseUsd(days = 120) {
  const cutoff = await borseCutoff(days);
  if (!cutoff) return [];
  return all(`
    SELECT DISTINCT ON (borse_date) borse_date, usd_rate
    FROM borse WHERE usd_rate IS NOT NULL AND borse_date >= $1
    ORDER BY borse_date`, [cutoff]);
}

/** ملخص الورقة + قائمة الأصناف للفلتر */
async function borseSummary() {
  const s = await get(`
    SELECT COUNT(*)::int rows, COUNT(DISTINCT borse_date)::int days,
           MIN(borse_date) from_d, MAX(borse_date) to_d
    FROM borse`);
  const items = await all(`
    SELECT item, MAX(item_code) item_code FROM borse
    WHERE item IS NOT NULL GROUP BY item ORDER BY 1`);
  const usd = await get(`SELECT usd_rate, borse_date FROM borse
    WHERE usd_rate IS NOT NULL ORDER BY borse_date DESC, id DESC LIMIT 1`);
  const lastDaily = await get(`
    SELECT borse_date, COUNT(*)::int rows FROM borse
    GROUP BY 1 ORDER BY 1 DESC LIMIT 1`);
  return {
    rows: s.rows, days: s.days, from: s.from_d, to: s.to_d,
    items, usdRate: usd ? usd.usd_rate : null, usdDate: usd ? usd.borse_date : null,
    lastDate: lastDaily ? lastDaily.borse_date : null,
    lastRows: lastDaily ? lastDaily.rows : 0,
  };
}

/** سجل التسجيلات اليومية (آخر الصفوف كما في الملف) */
async function borseRecent(limit = 60) {
  return all(`SELECT * FROM borse ORDER BY borse_date DESC, id DESC LIMIT $1`, [limit]);
}

module.exports = {
  overview, reconcile, detectCostRule, costWhere, dateSpan, sources,
  parseFilters, hasFilters, dims,
  salesByPlace, salesByItem, salesByMonth, salesByCustomer, salesByClass, costByMonth,
  movementsByDirection, movementsByMonth, movementsByPlace, topMovementItems,
  inventoryByPlace, inventoryByClass,
  borseLatest, borseSeries, borseUsd, borseSummary, borseRecent, borseCutoff,
};
