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

/* ---------- المؤشرات الرئيسية ---------- */
async function overview() {
  const cw = await costWhere();
  const sales = await get(`
    SELECT COUNT(*)::int lines, COUNT(DISTINCT invoice_doc)::int docs,
           SUM(signed_value)::float value, SUM(signed_qty)::float qty,
           MIN(invoice_date) dmin, MAX(invoice_date) dmax
    FROM sales`);
  const costAll = await get(`SELECT COUNT(*)::int lines, COALESCE(SUM(amount),0)::float cost
                             FROM movements WHERE ${cw}`);
  const bal = await get(`
    SELECT COUNT(*)::int lines,
           COALESCE(SUM(open_val),0)::float open_val, COALESCE(SUM(close_val),0)::float close_val,
           COALESCE(SUM(open_qty),0)::float open_qty, COALESCE(SUM(close_qty),0)::float close_qty
    FROM balances`);
  const mov = await get(`
    SELECT COUNT(*)::int lines, COALESCE(SUM(qty),0)::float qty, COALESCE(SUM(amount),0)::float amount,
           MIN(post_date) dmin, MAX(post_date) dmax FROM movements`);

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
async function reconcile({ limit = 100, offset = 0, onlyMismatch = true } = {}) {
  const rows = await all(`
    WITH per AS (
      /* المفتاح قد يحمل أكثر من سطر في الملف نفسه (107 مفاتيح مكررة بقيم مختلفة)
         → نجمّع القيم بمجموع SUM كما فعل الكود القديم، ووصفياً MAX */
      SELECT item, company_code, unit_code, storage_loc, balance_date,
             MAX(item_desc) item_desc, MAX(place) place,
             SUM(open_qty)::float open_qty, SUM(open_val)::float open_val,
             SUM(close_qty)::float close_qty, SUM(close_val)::float close_val
      FROM balances
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
  `);

  const norm = rows.map(r => ({
    ...r,
    close_val: r.prev_close_val || 0,    // نهاية التاريخ السابق
    close_qty: r.prev_close_qty || 0,
    mv_val: 0, mv_qty: 0,                // لا تدخل الحركات في هذه المطابقة
    diff_val: (r.prev_close_val || 0) - (r.open_val || 0),
    diff_qty: (r.prev_close_qty || 0) - (r.open_qty || 0),
  }));

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
async function salesByPlace() {
  const cw = await costWhere();
  const rows = await all(`
    WITH cost AS (
      SELECT place, SUM(amount)::float cost FROM movements
      WHERE ${cw} GROUP BY place
    )
    SELECT COALESCE(NULLIF(s.place,''),'(غير محدد)') place,
           COUNT(*)::int lines, COUNT(DISTINCT invoice_doc)::int docs,
           SUM(s.signed_value)::float value, SUM(s.signed_qty)::float qty,
           COALESCE(MAX(ABS(cost.cost)),0)::float cost
    FROM sales s
    LEFT JOIN cost ON cost.place = s.place
    GROUP BY 1 ORDER BY ABS(COALESCE(SUM(s.signed_value),0)) DESC`);
  return rows.map(r => ({
    ...r,
    profit: r.value - (r.cost || 0),
    marginPct: r.value ? ((r.value - r.cost) / r.value) * 100 : 0,
  }));
}

async function salesByItem(limit = 50) {
  return all(`
    SELECT s.item, MAX(s.item_desc) descr, MAX(s.place) place,
           COUNT(*)::int lines, SUM(s.signed_value)::float value, SUM(s.signed_qty)::float qty
    FROM sales s GROUP BY s.item ORDER BY ABS(COALESCE(SUM(s.signed_value),0)) DESC LIMIT $1`, [limit]);
}

async function salesByMonth() {
  return all(`
    SELECT SUBSTR(invoice_date,1,7) ym, COUNT(*)::int lines,
           SUM(signed_value)::float value, SUM(signed_qty)::float qty
    FROM sales WHERE invoice_date IS NOT NULL
    GROUP BY 1 ORDER BY 1`);
}

async function salesByCustomer(limit = 50) {
  return all(`
    SELECT COALESCE(NULLIF(beneficiary,''),'(غير محدد)') customer, COUNT(*)::int lines,
           SUM(signed_value)::float value, SUM(tax)::float tax
    FROM sales GROUP BY 1 ORDER BY ABS(COALESCE(SUM(signed_value),0)) DESC LIMIT $1`, [limit]);
}

async function salesByClass() {
  return all(`
    SELECT COALESCE(doc_class,'') || COALESCE(doc_status,'') combo, COUNT(*)::int lines,
           SUM(signed_value)::float value, SUM(signed_qty)::float qty
    FROM sales GROUP BY 1 ORDER BY ABS(COALESCE(SUM(signed_value),0)) DESC`);
}

async function costByMonth() {
  const cw = await costWhere();
  return all(`
    SELECT SUBSTR(post_date,1,7) ym, ABS(SUM(amount))::float cost, COUNT(*)::int lines
    FROM movements WHERE ${cw} AND post_date IS NOT NULL
    GROUP BY 1 ORDER BY 1`);
}

/* ---------- تحليل الحركات ---------- */
async function movementsByDirection() {
  return all(`
    SELECT COALESCE(NULLIF(direction,''),'(غير محدد)') direction,
           COUNT(*)::int lines, SUM(qty)::float qty, SUM(amount)::float amount,
           SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)::float inbound,
           SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END)::float outbound
    FROM movements GROUP BY 1 ORDER BY COUNT(*) DESC`);
}

async function movementsByMonth() {
  return all(`
    SELECT SUBSTR(post_date,1,7) ym,
           SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)::float inbound,
           SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END)::float outbound,
           SUM(amount)::float net, COUNT(*)::int lines
    FROM movements WHERE post_date IS NOT NULL
    GROUP BY 1 ORDER BY 1`);
}

async function movementsByPlace() {
  return all(`
    SELECT COALESCE(NULLIF(place,''),'(غير محدد)') place, COUNT(*)::int lines,
           SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)::float inbound,
           SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END)::float outbound,
           SUM(amount)::float net
    FROM movements GROUP BY 1 ORDER BY COUNT(*) DESC`);
}

async function topMovementItems(limit = 30) {
  return all(`
    SELECT item, MAX(item_desc) descr, MAX(place) place,
           COUNT(*)::int lines, SUM(qty)::float qty, SUM(amount)::float amount
    FROM movements GROUP BY item ORDER BY ABS(COALESCE(SUM(amount),0)) DESC LIMIT $1`, [limit]);
}

/* ---------- توزيع المخزون ---------- */
async function inventoryByPlace() {
  return all(`
    SELECT COALESCE(NULLIF(place,''),'(غير محدد)') place,
           SUM(open_qty)::float open_qty, SUM(close_qty)::float close_qty,
           SUM(open_val)::float open_val, SUM(close_val)::float close_val
    FROM balances GROUP BY 1 ORDER BY COALESCE(SUM(close_val),0) DESC`);
}

async function inventoryByClass() {
  return all(`
    SELECT COALESCE(i.class_desc,'(غير مصنف)') cls,
           SUM(b.close_val)::float close_val, SUM(b.close_qty)::float close_qty
    FROM balances b LEFT JOIN items i ON i.code = b.item
    GROUP BY 1 ORDER BY COALESCE(SUM(b.close_val),0) DESC`);
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
  salesByPlace, salesByItem, salesByMonth, salesByCustomer, salesByClass, costByMonth,
  movementsByDirection, movementsByMonth, movementsByPlace, topMovementItems,
  inventoryByPlace, inventoryByClass,
  borseLatest, borseSeries, borseUsd, borseSummary, borseRecent, borseCutoff,
};
