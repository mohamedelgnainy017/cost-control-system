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

/* ---------- طريقة ربط التكلفة بالمبيعات ---------- */
/**
 * إعداد `cost_link` يحدد كيف تُنسب تكلفة الحركات إلى بنود المبيعات:
 *   'doc_item' (الافتراضي) : ربط (المستند المرجع + الصنف) ← (مرجع + الصنف)
 *   'place'               : الطريقة القديمة — تجميع حركات التكلفة حسب المكان
 * الاختيار يبقى محفوظاً حتى يغيّره المستخدم (لا يُحذف مع الاستيراد مثل cost_rule)،
 * وهو نقطة التبديل الوحيدة — فأي تعديل مستقبلي على منطق التكلفة يُضاف هنا.
 */
const COST_LINKS = {
  doc_item: { label: 'المستند المرجع + الصنف', desc: 'ربط كل بند مبيعات بحركات نفس المستند المرجع ونفس الصنف' },
  place:    { label: 'المكان (الطريقة القديمة)', desc: 'تجميع حركات التكلفة حسب المكان ومقابلتها بإجمالي مبيعات المكان' },
};

async function detectCostLink() {
  const saved = await getSetting('cost_link');
  if (saved && COST_LINKS[saved]) return saved;
  await setSetting('cost_link', 'doc_item');
  return 'doc_item';
}

async function setCostLink(link) {
  if (!COST_LINKS[link]) throw new Error('طريقة ربط التكلفة غير معروفة');
  await setSetting('cost_link', link);
  return { ok: true, link };
}

/**
 * أساس الربحية — CTE باسم `sp` (صف لكل بند مبيعات بعد الفلاتر مع تكلفته المنسوبة).
 * أعمدة sp: invoice_date, invoice_doc, place, item, item_desc, beneficiary,
 *           doc_class, doc_status, value, qty, tax, cost, matched
 *
 * القاعدة الحاكمة (طريقة doc_item — الافتراضية والموصى بها):
 *   فلتر التاريخ في شاشة المبيعات على **تاريخ الفاتورة**، ولا يقيّد الحركات أبداً.
 *   فالبند يأخذ تكلفة حركات نفس **المستند المرجع + الصنف** سواءٌ كان تاريخ
 *   ترحيل الحركة قبل تاريخ الفاتورة أو بعده — فلا تُفقد تكلفة ولا تُنسب ليوم خاطئ.
 *
 * عند طريقة المستند: تُجمَّع حركات التكلفة لكل (مرجع، صنف) ثم تُوزَّع على بنود
 * المبيعات المشتركة في نفس (المستند المرجع، الصنف) بالتساوي — فلا تتكرر التكلفة
 * ولا تُفقد. البند بلا حركة مقابلة تكلفته 0 و`matched = false` (تظهره نسبة التغطية).
 * ملاحظة: في هذه الطريقة لا تُرشَّح الحركات بتاريخ/مكان، لأن التكلفة تتبع البند نفسه
 * أياً كان تاريخ ترحيل الحركة أو مكانها.
 */
async function profitCte(F = {}) {
  const method = await detectCostLink();
  const cw = await costWhere();

  let mvSql, joinSql, partSql, params, wsSql = '';
  if (method === 'place') {
    /* طريقة «المكان» تجمع الحركات على مستوى المكان فقط — فلا بدّ من تقييدها
       بمدى التواريخ، وإلا جاءت بتكلفة المكان على كل التاريخ مقابل مبيعات يوم
       واحد (مُثبت: 22,679,901 بدل 539.60). ولهذا فهي لا تضمن «التكلفة بالمرجع
       بغض النظر عن تاريخ الترحيل» — تضمنها طريقة doc_item وحدها (الافتراضية). */
    const wm = conds(F, MOV_COLS);
    const ws = conds(F, SALES_COLS, wm.params.length + 1);
    params = [...wm.params, ...ws.params];
    wsSql = ws.sql;
    mvSql = `SELECT m.place AS k, SUM(m.amount)::float AS amount
               FROM movements m
              WHERE ${cw}${wm.sql ? ' AND ' + wm.sql : ''}
              GROUP BY m.place`;
    joinSql = `COALESCE(mv.k,'') = COALESCE(s.place,'')`;
    partSql = `s.place`;
  } else {
    const ws = conds(F, SALES_COLS);
    params = ws.params;
    wsSql = ws.sql;
    mvSql = `SELECT m.doc_ref AS k, m.item AS it, SUM(m.amount)::float AS amount
               FROM movements m
              WHERE ${cw} AND m.doc_ref IS NOT NULL AND m.doc_ref <> ''
              GROUP BY m.doc_ref, m.item`;
    joinSql = `mv.k = s.ref_doc AND mv.it = s.item`;
    partSql = `s.ref_doc, s.item`;
  }

  const cte = `WITH mv AS (${mvSql}), sp AS (
    SELECT s.invoice_date, s.invoice_doc, s.place, s.item, s.item_desc,
           s.beneficiary, s.doc_class, s.doc_status,
           s.signed_value AS value, s.signed_qty AS qty, s.tax,
           CASE WHEN mv.amount IS NULL THEN 0
                ELSE -(mv.amount) / NULLIF(COUNT(*) OVER (PARTITION BY ${partSql}), 0)
           END AS cost,
           (mv.amount IS NOT NULL) AS matched,
           /* أبعاد مشتقة من locations/items — تخدم التفصيل والفلتر والمجموعة معاً */
           s.unit_code, s.storage_loc, COALESCE(NULLIF(s.price_uom,''), i.uom) uom,
           i.class_code, ${CLS_EXPR} cls, i.group_code, ${GRP_EXPR} grp,
           l.company_code, l.currency
      FROM sales s
      ${SALES_JOIN}
      LEFT JOIN mv ON ${joinSql}
      ${wsSql ? 'WHERE ' + wsSql : ''}
  )`;
  return { cte, params, method };
}

/* ---------- أبعاد المبيعات المشتقة من جداول أخرى ----------
   التصنيف والمجموعة والشركة وعملة الشركة ليست أعمدة في sales — تُجلب بربط:
     الشركة/العملة  ← locations (بكود الوحدة)
     التصنيف/المجموعة ← items (بكود الصنف)
   و«تصنيف/مجموعة» يُعرض باسمه مع كوده فلقينا تعبيراً واحداً يخدم القيمة المعروضة
   والفلتر والمجموعة في آن — فلا يختلف ما يُختار عمّا يُحسب. */
const SALES_JOIN = `LEFT JOIN locations l ON l.unit_code = s.unit_code
   LEFT JOIN items i ON i.code = s.item AND i.kind = 'item'`;
const CLS_EXPR = `COALESCE(NULLIF(i.class_desc,''), i.class_code, '(غير محدد)')`;
const GRP_EXPR = `COALESCE(NULLIF(i.group_desc,''), i.group_code, '(غير محدد)')`;

/* ---------- فلاتر مشتركة: من معاملات URL إلى شروط SQL ---------- */
/* علامة خاصة تُرسَل من القوائم المنسدلة للقيم الفارغة («غير محدد») */
const EMPTY = '__EMPTY__';

/* الأبعاد التي تدعم صيغة «من / إلى» (نطاق قيم) بجانب القيمة المفردة */
const RANGE_DIMS = ['place', 'company', 'unit', 'item', 'cust', 'dir', 'mtype', 'storage', 'cls', 'grp'];

function parseFilters(q) {
  const get = k => { const v = q ? String(q.get(k) || '') : ''; return v.trim(); };
  const F = {
    from: get('from'), to: get('to'),
    place: get('place'), company: get('company'), unit: get('unit'),
    item: get('item'), cust: get('cust'), dir: get('dir'), mtype: get('mtype'),
    storage: get('storage'), cls: get('cls'), grp: get('grp'),
    sev: get('sev'), ent: get('ent'),
  };
  for (const k of RANGE_DIMS) { F[k + '_from'] = get(k + '_from'); F[k + '_to'] = get(k + '_to'); }
  return F;
}

function hasFilters(F = {}) {
  return ['from', 'to', 'place', 'company', 'unit', 'item', 'cust', 'dir', 'mtype', 'storage', 'cls', 'grp']
    .some(k => !!F[k])
    || RANGE_DIMS.some(k => F[k + '_from'] || F[k + '_to']);
}

/* خريطة الأعمدة لكل جدول (بعامودها المؤهَّل بالاسم المستعار) */
const SALES_COLS = {
  date: 's.invoice_date', place: 's.place', item: 's.item', unit: 's.unit_code',
  cust: 's.beneficiary', storage: 's.storage_loc',
  company: 'l.company_code', cls: CLS_EXPR, grp: GRP_EXPR,
};
const MOV_COLS = { date: 'm.post_date', place: 'm.place', item: 'm.item', unit: 'm.unit_code', company: 'm.company_code', mtype: 'm.move_type', dir: 'm.direction', storage: 'm.storage_loc' };
const BAL_COLS = { date: 'b.balance_date', place: 'b.place', item: 'b.item', unit: 'b.unit_code', company: 'b.company_code', storage: 'b.storage_loc' };

/* يبني الشروط من الفلاتر على حسب خريطة الأعمدة.
   القيمة المفردة: مطابقة تامة (والصنف مطابقة جزئية ILIKE).
   «من/إلى»: نطاق قيم (col >= from AND col <= to) ويتقدّم على القيمة المفردة.
   start: رقم أول معامل (لتدمج شروط عدة استعلامات في استعلام واحد). */
function conds(F = {}, map = {}, start = 1) {
  const c = [], p = [];
  let i = start;
  const ph = () => '$' + (i++);
  const addEq = (col, v, like) => {
    if (!col || !v) return;
    if (like) { c.push(`${col} ILIKE ${ph()}`); p.push('%' + v + '%'); }
    else { c.push(`${col} = ${ph()}`); p.push(v); }
  };
  const addOrNone = (col, v) => {
    if (!col || !v) return;
    if (v === EMPTY) { c.push(`(COALESCE(${col},'') = '')`); }
    else { c.push(`${col} = ${ph()}`); p.push(v); }
  };
  const addRange = (col, rf, rt) => {
    if (!col || (!rf && !rt)) return false;
    if (rf) { c.push(`${col} >= ${ph()}`); p.push(rf); }
    if (rt) { c.push(`${col} <= ${ph()}`); p.push(rt); }
    return true;
  };
  if (F.from) { c.push(`${map.date} >= ${ph()}`); p.push(F.from); }
  if (F.to) { c.push(`${map.date} <= ${ph()}`); p.push(F.to); }
  for (const k of ['place', 'company', 'unit', 'cust', 'dir', 'mtype', 'storage', 'cls', 'grp']) {
    if (!addRange(map[k], F[k + '_from'], F[k + '_to'])) addOrNone(map[k], F[k]);
  }
  if (!addRange(map.item, F.item_from, F.item_to)) addEq(map.item, F.item, true);
  return { sql: c.length ? c.join(' AND ') : '', params: p };
}

/* نسخة من الفلاتر بدون التاريخ — تُستخدم حيث التاريخ يكسر المنطق (مطابقة الأزواج) */
const noDates = F => ({ ...F, from: '', to: '' });

/* ---------- المؤشرات الرئيسية ---------- */
async function overview(F = {}) {
  const cw = await costWhere();
  const wm = conds(F, MOV_COLS);
  const wb = conds(F, BAL_COLS);
  const { cte, params, method } = await profitCte(F);

  /* المبيعات + تكلفة الربط + نسبة التغطية في استعلام واحد على CTE الربحية */
  const sales = await get(`${cte}
    SELECT COUNT(*)::int lines, COUNT(DISTINCT invoice_doc)::int docs,
           COALESCE(SUM(value),0)::float value, COALESCE(SUM(qty),0)::float qty,
           COALESCE(SUM(cost),0)::float cost,
           COUNT(*) FILTER (WHERE matched)::int matched_lines,
           COALESCE(SUM(value) FILTER (WHERE matched),0)::float matched_value,
           MIN(invoice_date) dmin, MAX(invoice_date) dmax
    FROM sp`, params);
  const costAll = await get(`SELECT COUNT(*)::int lines
                             FROM movements m WHERE ${cw}`);
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

  const cogs = Math.abs(sales.cost || 0);
  const revenue = sales.value || 0;
  return {
    period: { salesFrom: sales.dmin, salesTo: sales.dmax, movFrom: mov.dmin, movTo: mov.dmax },
    counts,
    revenue,
    revenueDocs: sales.docs,
    cogs,
    grossProfit: revenue - cogs,
    marginPct: revenue ? ((revenue - cogs) / revenue) * 100 : 0,
    /* نسبة التغطية: أي جزء من المبيعات وُجدت له حركة تكلفة مقابلة (شفافية الربط) */
    cost: {
      method,
      label: COST_LINKS[method].label,
      lines: sales.lines,
      matchedLines: sales.matched_lines,
      linesPct: sales.lines ? (sales.matched_lines / sales.lines) * 100 : 0,
      value: revenue,
      matchedValue: sales.matched_value,
      valuePct: revenue ? (sales.matched_value / revenue) * 100 : 0,
    },
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

/* ---------- تحليل المبيعات (مبنية على CTE الربحية الموحّد) ---------- */
/* تكلفة التجمع = مطلق صافي حركاته (المردودات تُخصم من الإصدارات) — نفس
   دلالة الطريقة القديمة: ABS على الإجمالي لا على السطر، وإلا تحول المردود
   إلى تكلفة موجبة ويُضخّم التكلفة (مُختبر: 283,121 بدل 130,919). */
const withProfit = rows => rows.map(r => ({
  ...r,
  profit: (r.value || 0) - (r.cost || 0),
  marginPct: r.value ? (((r.value || 0) - (r.cost || 0)) / r.value) * 100 : 0,
}));

async function salesByPlace(F = {}) {
  const { cte, params, method } = await profitCte(F);
  const rows = await all(`${cte}
    SELECT COALESCE(NULLIF(place,''),'(غير محدد)') place,
           COUNT(*)::int lines, COUNT(DISTINCT invoice_doc)::int docs,
           COALESCE(SUM(value),0)::float value, COALESCE(SUM(qty),0)::float qty,
           COALESCE(ABS(SUM(cost)),0)::float cost,
           COUNT(*) FILTER (WHERE matched)::int matched_lines
      FROM sp GROUP BY 1 ORDER BY ABS(COALESCE(SUM(value),0)) DESC`, params);
  return withProfit(rows).map(r => ({ ...r, method }));
}

async function salesByItem(F = {}, limit = 50) {
  const { cte, params } = await profitCte(F);
  const rows = await all(`${cte}
    SELECT item, MAX(item_desc) descr, MAX(place) place,
           COUNT(*)::int lines,
           COALESCE(SUM(value),0)::float value, COALESCE(SUM(qty),0)::float qty,
           COALESCE(ABS(SUM(cost)),0)::float cost
      FROM sp GROUP BY item ORDER BY ABS(COALESCE(SUM(value),0)) DESC LIMIT $${params.length + 1}`,
    [...params, limit]);
  return withProfit(rows);
}

async function salesByMonth(F = {}) {
  const { cte, params } = await profitCte(F);
  const rows = await all(`${cte}
    SELECT SUBSTR(invoice_date,1,7) ym, COUNT(*)::int lines,
           COALESCE(SUM(value),0)::float value, COALESCE(SUM(qty),0)::float qty,
           COALESCE(ABS(SUM(cost)),0)::float cost
      FROM sp GROUP BY 1 ORDER BY 1`, params);
  return withProfit(rows);
}

async function salesByCustomer(F = {}, limit = 50) {
  const { cte, params } = await profitCte(F);
  const rows = await all(`${cte}
    SELECT COALESCE(NULLIF(beneficiary,''),'(غير محدد)') customer, COUNT(*)::int lines,
           COALESCE(SUM(value),0)::float value, COALESCE(SUM(tax),0)::float tax,
           COALESCE(ABS(SUM(cost)),0)::float cost
      FROM sp GROUP BY 1 ORDER BY ABS(COALESCE(SUM(value),0)) DESC LIMIT $${params.length + 1}`,
    [...params, limit]);
  return withProfit(rows);
}

async function salesByClass(F = {}) {
  const { cte, params } = await profitCte(F);
  const rows = await all(`${cte}
    SELECT COALESCE(doc_class,'') || COALESCE(doc_status,'') combo, COUNT(*)::int lines,
           COALESCE(SUM(value),0)::float value, COALESCE(SUM(qty),0)::float qty,
           COALESCE(ABS(SUM(cost)),0)::float cost
      FROM sp GROUP BY 1 ORDER BY ABS(COALESCE(SUM(value),0)) DESC`, params);
  return withProfit(rows);
}

/* ================= تقارير المبيعات الثلاثة ================= */

/* ١) التقرير التفصيلي — كل بند بكل أبعاده: صنف/وحدة/تصنيف/مجموعة/مخزن/وحدة/مكان/شركة */
async function salesDetail(F = {}, limit = 5000) {
  const { cte, params } = await profitCte(F);
  const lim = Math.max(1, Math.min(Number(limit) || 5000, 20000));
  const rows = await all(`${cte}
    SELECT COALESCE(NULLIF(item,''),'(غير محدد)') item,
           MAX(item_desc) item_desc,
           COALESCE(MAX(NULLIF(uom,'')),'') uom,
           COALESCE(MAX(NULLIF(cls,'')),'(غير محدد)') cls,
           MAX(NULLIF(class_code,'')) class_code,
           COALESCE(MAX(NULLIF(grp,'')),'(غير محدد)') grp,
           MAX(NULLIF(group_code,'')) group_code,
           COALESCE(NULLIF(storage_loc,''),'(بدون مخزن)') storage_loc,
           COALESCE(NULLIF(unit_code,''),'(بدون وحدة)') unit_code,
           COALESCE(NULLIF(place,''),'(غير محدد)') place,
           COALESCE(MAX(NULLIF(company_code,'')),'(بدون شركة)') company_code,
           COALESCE(MAX(NULLIF(currency,'')),'') currency,
           COUNT(*)::int lines,
           COALESCE(SUM(qty),0)::float qty,
           COALESCE(SUM(value),0)::float value,
           COALESCE(ABS(SUM(cost)),0)::float cost,
           COUNT(*) FILTER (WHERE matched)::int matched_lines
      FROM sp
     GROUP BY item, item_desc, uom, cls, class_code, grp, group_code,
              storage_loc, unit_code, place, company_code, currency
     ORDER BY ABS(COALESCE(SUM(value),0)) DESC, item
     LIMIT ${lim}`, params);
  return withProfit(rows);
}

/* ٢) التقرير الإجمالي — نفس الأرقام مجمّعة على مستوى واحد يختاره المستخدم.
     المستويات: item (الصنف) • place (المكان) • company (الشركة) • cust (العميل) */
const TOTAL_LEVELS = {
  item:    { label: 'الصنف',    col: 'sp.item',        key: 'COALESCE(NULLIF(sp.item,\'\'),\'(غير محدد)\')', withDescr: true },
  place:   { label: 'المكان',   col: 'sp.place',       key: 'COALESCE(NULLIF(sp.place,\'\'),\'(غير محدد)\')' },
  company: { label: 'الشركة',   col: 'sp.company_code',key: 'COALESCE(NULLIF(sp.company_code,\'\'),\'(بدون شركة)\')' },
  cust:    { label: 'العميل',   col: 'sp.beneficiary', key: 'COALESCE(NULLIF(sp.beneficiary,\'\'),\'(غير محدد)\')' },
};
async function salesTotalBy(F = {}, by = 'item', limit = 2000) {
  const lv = TOTAL_LEVELS[by] ? by : 'item';
  const { cte, params } = await profitCte(F);
  const lim = Math.max(1, Math.min(Number(limit) || 2000, 20000));
  const rows = await all(`${cte}
    SELECT ${TOTAL_LEVELS[lv].key} k${TOTAL_LEVELS[lv].withDescr
      ? ', MAX(sp.item_desc) descr, MAX(NULLIF(sp.uom,\'\')) uom' : ''},
           COUNT(*)::int lines, COUNT(DISTINCT invoice_doc)::int docs,
           COALESCE(SUM(value),0)::float value, COALESCE(SUM(qty),0)::float qty,
           COALESCE(SUM(tax),0)::float tax,
           COALESCE(ABS(SUM(cost)),0)::float cost,
           COUNT(*) FILTER (WHERE matched)::int matched_lines
      FROM sp GROUP BY 1
     ORDER BY ABS(COALESCE(SUM(value),0)) DESC LIMIT ${lim}`, params);
  return { level: lv, label: TOTAL_LEVELS[lv].label, rows: withProfit(rows) };
}

/* ٣) تقرير الفترات — بالأشهر، وبالأعوام فوقها */
async function salesByPeriod(F = {}) {
  const { cte, params } = await profitCte(F);
  const months = await all(`${cte}
    SELECT SUBSTR(invoice_date,1,7) ym,
           COUNT(*)::int lines, COUNT(DISTINCT invoice_doc)::int docs,
           COALESCE(SUM(value),0)::float value, COALESCE(SUM(qty),0)::float qty,
           COALESCE(ABS(SUM(cost)),0)::float cost
      FROM sp WHERE invoice_date IS NOT NULL AND invoice_date <> ''
     GROUP BY 1 ORDER BY 1`, params);
  const years = await all(`${cte}
    SELECT SUBSTR(invoice_date,1,4) ym,
           COUNT(*)::int lines, COUNT(DISTINCT invoice_doc)::int docs,
           COALESCE(SUM(value),0)::float value, COALESCE(SUM(qty),0)::float qty,
           COALESCE(ABS(SUM(cost)),0)::float cost
      FROM sp WHERE invoice_date IS NOT NULL AND invoice_date <> ''
     GROUP BY 1 ORDER BY 1`, params);
  return {
    months: withProfit(months).map(r => ({ ...r, level: 'شهر' })),
    years: withProfit(years).map(r => ({ ...r, level: 'سنة' })),
  };
}

/* تقرير شاشة «المبيعات اليومية»: تفصيلي (كل الأبعاد) أو مجمّع على مستوى
   صنف/مكان/شركة/عميل/مخزن — بدون أي بنود خاصة بالتكلفة (تكلفة/ربح/هامش/ضريبة)
   مع إضافة «قيمة البيع للوحدة» = قيمة البيع ÷ الكمية */
async function salesDaily(F = {}, by = 'detail', limit = 20000) {
  const lim = Math.max(1, Math.min(Number(limit) || 20000, 20000));
  const clean = rows => rows.map(r => {
    const qty = Number(r.qty) || 0, value = Number(r.value) || 0;
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === 'cost' || k === 'matched_lines' || k === 'profit' || k === 'marginPct' || k === 'tax') continue;
      out[k] = v;
    }
    out.qty = qty;
    out.value = value;
    out.unit_value = qty ? Math.round((value / qty) * 100) / 100 : null;   // قيمة البيع للوحدة
    return out;
  });
  if (by === 'detail') {
    return { level: 'detail', label: 'تفصيلي', rows: clean(await salesDetail(F, lim)) };
  }
  if (by === 'item') {
    const t = await salesTotalBy(F, 'item', lim);
    return { level: 'item', label: t.label, rows: clean(t.rows) };
  }
  if (BREAKDOWN_GROUPS[by]) {
    const t = await salesBreakdown(F, by, lim);
    return { level: by, label: t.label, rows: clean(t.rows) };
  }
  return { level: 'detail', label: 'تفصيلي', rows: clean(await salesDetail(F, lim)) };
}

/* تفصيل الأصناف داخل كل مجموعة (مكان/شركة/عميل/مخزن):
   كل مجموعة مع كل صنف بيع تحتها — يعطي دلالة فعلية بدل الإجمالي الواحد */
const BREAKDOWN_GROUPS = {
  place:   { label: 'المكان', expr: "COALESCE(NULLIF(sp.place,''),'(غير محدد)') g" },
  company: { label: 'الشركة', expr: "COALESCE(NULLIF(sp.company_code,''),'(بدون شركة)') g" },
  cust:    { label: 'العميل', expr: "COALESCE(NULLIF(sp.beneficiary,''),'(غير محدد)') g" },
  storage: { label: 'المخزن', expr: "COALESCE(NULLIF(sp.storage_loc,''),'(بدون مخزن)') g" },
};
async function salesBreakdown(F = {}, by = 'place', limit = 20000) {
  const lv = BREAKDOWN_GROUPS[by] ? by : 'place';
  const g = BREAKDOWN_GROUPS[lv];
  const { cte, params } = await profitCte(F);
  const lim = Math.max(1, Math.min(Number(limit) || 20000, 20000));
  const rows = await all(`${cte}
    SELECT ${g.expr}, sp.item item, MAX(sp.item_desc) item_desc, MAX(NULLIF(sp.uom,'')) uom,
           COUNT(*)::int lines, COUNT(DISTINCT invoice_doc)::int docs,
           COALESCE(SUM(qty),0)::float qty, COALESCE(SUM(value),0)::float value,
           COALESCE(SUM(tax),0)::float tax,
           COALESCE(ABS(SUM(cost)),0)::float cost,
           COUNT(*) FILTER (WHERE matched)::int matched_lines
      FROM sp GROUP BY 1, sp.item
     ORDER BY 1 ASC, ABS(COALESCE(SUM(value),0)) DESC, sp.item
     LIMIT ${lim}`, params);
  return { level: lv, label: g.label, rows: withProfit(rows) };
}

/* ================= تقارير مخازن (الحركات) الثلاث ================= */

/* صفوف الحركات الحية بعد إسقاط الإلغاء — مطابقة دقيقة بترتيب زمني (FIFO) داخل
   نفس المفتاح، وهي نفس نتيجة دلاء التسع في movementsReport: أول min(|أ|,|ب|)
   صف يُلغى والبقية تبقى **بتاريخها** — فتقارير الفترة والتفصيل تبقى على نفس
   الأرقام الصافية المعروضة في شاشة الحركات. */
function movementsNetCte(wm) {
  const w = wm && wm.sql ? 'WHERE ' + wm.sql : '';
  return `
    WITH f AS (
      SELECT m.id, m.item, m.item_desc, m.uom, m.move_type, m.unit_code, m.company_code,
             m.post_date,
             COALESCE(NULLIF(TRIM(m.direction),''),'(غير محدد)') direction,
             COALESCE(NULLIF(TRIM(m.storage_loc),''),'(بدون مخزن)') storage_loc,
             COALESCE(NULLIF(TRIM(m.place),''),'(غير محدد)') place,
             COALESCE(m.qty,0)::float qty, COALESCE(m.amount,0)::float amount
        FROM movements m ${w}
    ), b AS (
      SELECT f.*,
        CASE WHEN qty > 0 AND amount > 0 THEN 'pp' WHEN qty < 0 AND amount < 0 THEN 'mm'
             WHEN qty > 0 AND amount < 0 THEN 'pm' WHEN qty < 0 AND amount > 0 THEN 'mp'
             WHEN qty > 0 AND amount = 0 THEN 'p0' WHEN qty < 0 AND amount = 0 THEN 'm0'
             WHEN qty = 0 AND amount > 0 THEN '0p' WHEN qty = 0 AND amount < 0 THEN '0m'
             ELSE '00' END::text kt,
        CASE WHEN qty > 0 AND amount > 0 THEN 'mm' WHEN qty < 0 AND amount < 0 THEN 'pp'
             WHEN qty > 0 AND amount < 0 THEN 'mp' WHEN qty < 0 AND amount > 0 THEN 'pm'
             WHEN qty > 0 AND amount = 0 THEN 'm0' WHEN qty < 0 AND amount = 0 THEN 'p0'
             WHEN qty = 0 AND amount > 0 THEN '0m' WHEN qty = 0 AND amount < 0 THEN '0p'
             ELSE '00' END::text opp
      FROM f
    ), w AS (
      SELECT b.*,
             ROW_NUMBER() OVER w_bkt::int rn,
             COUNT(*) FILTER (WHERE kt = 'pp') OVER w_key::int c_pp,
             COUNT(*) FILTER (WHERE kt = 'mm') OVER w_key::int c_mm,
             COUNT(*) FILTER (WHERE kt = 'pm') OVER w_key::int c_pm,
             COUNT(*) FILTER (WHERE kt = 'mp') OVER w_key::int c_mp,
             COUNT(*) FILTER (WHERE kt = 'p0') OVER w_key::int c_p0,
             COUNT(*) FILTER (WHERE kt = 'm0') OVER w_key::int c_m0,
             COUNT(*) FILTER (WHERE kt = '0p') OVER w_key::int c_0p,
             COUNT(*) FILTER (WHERE kt = '0m') OVER w_key::int c_0m,
             COUNT(*) FILTER (WHERE kt = '00') OVER w_key::int c_00
        FROM b
      WINDOW w_bkt AS (PARTITION BY item, item_desc, uom, direction, storage_loc,
                                  place, ABS(qty)::float, ABS(amount)::float, kt),
             w_key AS (PARTITION BY item, item_desc, uom, direction, storage_loc,
                                  place, ABS(qty)::float, ABS(amount)::float)
    ), net AS (
      SELECT id, item, item_desc, uom, move_type, unit_code, company_code, post_date,
             direction, storage_loc, place, qty, amount
        FROM w
       WHERE rn > CASE kt
              WHEN 'pp' THEN LEAST(c_pp, c_mm) WHEN 'mm' THEN LEAST(c_mm, c_pp)
              WHEN 'pm' THEN LEAST(c_pm, c_mp) WHEN 'mp' THEN LEAST(c_mp, c_pm)
              WHEN 'p0' THEN LEAST(c_p0, c_m0) WHEN 'm0' THEN LEAST(c_m0, c_p0)
              WHEN '0p' THEN LEAST(c_0p, c_0m) WHEN '0m' THEN LEAST(c_0m, c_0p)
              ELSE 0 END
    )
  `;
}
/* مقاييس وارد/صادر/صافي — تُستخدم في التقارير الثلاثة على نفس الصفوف الحية */
const MN_IN_Q = '(SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END))';
const MN_OUT_Q = '(SUM(CASE WHEN qty < 0 THEN -qty ELSE 0 END))';
const MN_IN_V = '(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END))';
const MN_OUT_V = '(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END))';

/* ١) تفصيلي — كل حركة بتاريخها وأبعادها (صنف/وحدة/توجيه/مخزن/مكان/وحدة/شركة/نوع) */
async function movementsDetail(F = {}, limit = 20000) {
  const wm = conds(F, MOV_COLS);
  const lim = Math.max(1, Math.min(Number(limit) || 20000, 20000));
  return all(`${movementsNetCte(wm)}
    SELECT post_date, item, MAX(item_desc) item_desc, COALESCE(MAX(NULLIF(uom,'')),'') uom,
           direction, storage_loc, place, unit_code, company_code, move_type,
           COUNT(*)::int lines,
           ${MN_IN_Q}::float in_qty, ${MN_OUT_Q}::float out_qty,
           ${MN_IN_V}::float in_val, ${MN_OUT_V}::float out_val,
           SUM(qty)::float qty, SUM(amount)::float amount
      FROM net
     GROUP BY post_date, item, direction, storage_loc, place, unit_code, company_code, move_type
     ORDER BY post_date, ABS(COALESCE(SUM(amount),0)) DESC, item
     LIMIT ${lim}`, wm.params);
}

/* ٢) إجمالي — تجميع على مستوى يختاره المستخدم، مفصل على الصنف (مجموعة × صنف) */
const MOV_GROUPS = {
  item:    { label: 'الصنف',      expr: "COALESCE(NULLIF(item,''),'(غير محدد)')" },
  place:   { label: 'المكان',     expr: 'place' },
  company: { label: 'الشركة',     expr: "COALESCE(NULLIF(company_code,''),'(بدون شركة)')" },
  storage: { label: 'المخزن',     expr: 'storage_loc' },
  unit:    { label: 'الوحدة',     expr: "COALESCE(NULLIF(unit_code,''),'(بدون وحدة)')" },
  dir:     { label: 'التوجيه',    expr: 'direction' },
  mtype:   { label: 'نوع الحركة', expr: "COALESCE(NULLIF(move_type,''),'(غير محدد)')" },
};
async function movementsBreakdown(F = {}, by = 'place', limit = 20000) {
  const wm = conds(F, MOV_COLS);
  const lv = MOV_GROUPS[by] ? by : 'place';
  const g = MOV_GROUPS[lv];
  const lim = Math.max(1, Math.min(Number(limit) || 20000, 20000));
  const isItem = lv === 'item';
  const sel = isItem
    ? `item k, MAX(item_desc) descr, COALESCE(MAX(NULLIF(uom,'')),'') uom`
    : `${g.expr} g, item, MAX(item_desc) descr, COALESCE(MAX(NULLIF(uom,'')),'') uom`;
  const key = isItem ? 'item' : `${g.expr}, item`;
  const ord = isItem ? 'ABS(COALESCE(SUM(amount),0)) DESC, item'
                     : '1 ASC, ABS(COALESCE(SUM(amount),0)) DESC, item';
  const rows = await all(`${movementsNetCte(wm)}
    SELECT ${sel}, COUNT(*)::int lines,
           ${MN_IN_Q}::float in_qty, ${MN_OUT_Q}::float out_qty,
           ${MN_IN_V}::float in_val, ${MN_OUT_V}::float out_val,
           SUM(qty)::float qty, SUM(amount)::float amount
      FROM net GROUP BY ${key}
     ORDER BY ${ord} LIMIT ${lim}`, wm.params);
  return { level: lv, label: g.label, rows };
}

/* ٣) فترات — بالأشهر ثم بالأعوام */
async function movementsPeriods(F = {}) {
  const wm = conds(F, MOV_COLS);
  const q = len => `${movementsNetCte(wm)}
    SELECT SUBSTR(post_date,1,${len}) ym,
           COUNT(*)::int lines, COUNT(DISTINCT item)::int items,
           ${MN_IN_Q}::float in_qty, ${MN_OUT_Q}::float out_qty,
           ${MN_IN_V}::float in_val, ${MN_OUT_V}::float out_val,
           SUM(qty)::float qty, SUM(amount)::float amount
      FROM net WHERE post_date IS NOT NULL AND post_date <> ''
     GROUP BY 1 ORDER BY 1`;
  const months = await all(q(7), wm.params);
  const years = await all(q(4), wm.params);
  return {
    months: months.map(r => ({ ...r, level: 'شهر' })),
    years: years.map(r => ({ ...r, level: 'سنة' })),
  };
}

/* ================= تقارير أرصدة المخازن الثلاثة ================= */
const INV_JOIN = `LEFT JOIN items i ON i.code = b.item AND i.kind = 'item'`;
const INV_GROUPS = {
  item:    { label: 'الصنف',    expr: 'b.item' },
  place:   { label: 'المكان',   expr: "COALESCE(NULLIF(b.place,''),'(غير محدد)')" },
  company: { label: 'الشركة',   expr: "COALESCE(NULLIF(b.company_code,''),'(بدون شركة)')" },
  storage: { label: 'المخزن',   expr: "COALESCE(NULLIF(b.storage_loc,''),'(بدون مخزن)')" },
  unit:    { label: 'الوحدة',   expr: "COALESCE(NULLIF(b.unit_code,''),'(بدون وحدة)')" },
  cls:     { label: 'التصنيف',  expr: CLS_EXPR },
  grp:     { label: 'المجموعة', expr: GRP_EXPR },
};

/* ١) تفصيلي — كل سجل رصيد بأبعاده + حركة اليوم (ختامي − افتتاحي) */
async function inventoryDetail(F = {}, limit = 20000) {
  const wb = conds(F, BAL_COLS);
  const lim = Math.max(1, Math.min(Number(limit) || 20000, 20000));
  return all(`
    SELECT b.balance_date, b.item, b.item_desc, COALESCE(NULLIF(b.base_uom,''),'') uom,
           b.unit_code, b.storage_loc, b.place, b.company_code, b.material_type,
           i.class_code, ${CLS_EXPR} cls, i.group_code, ${GRP_EXPR} grp,
           COALESCE(b.open_qty,0)::float open_qty, COALESCE(b.open_val,0)::float open_val,
           COALESCE(b.close_qty,0)::float close_qty, COALESCE(b.close_val,0)::float close_val,
           (COALESCE(b.close_qty,0) - COALESCE(b.open_qty,0))::float move_qty,
           (COALESCE(b.close_val,0) - COALESCE(b.open_val,0))::float move_val
      FROM balances b ${INV_JOIN}
      ${wb.sql ? 'WHERE ' + wb.sql : ''}
     ORDER BY b.balance_date DESC, b.item
     LIMIT ${lim}`, wb.params);
}

/* ٢) إجمالي — تجميع على مستوى يختاره المستخدم، مفصل على الصنف (مجموعة × صنف) */
async function inventoryBreakdown(F = {}, by = 'place', limit = 20000) {
  const wb = conds(F, BAL_COLS);
  const lv = INV_GROUPS[by] ? by : 'place';
  const g = INV_GROUPS[lv];
  const lim = Math.max(1, Math.min(Number(limit) || 20000, 20000));
  const isItem = lv === 'item';
  const sel = isItem
    ? `b.item k, MAX(b.item_desc) descr`
    : `${g.expr} g, b.item, MAX(b.item_desc) descr`;
  const key = isItem ? 'b.item' : `${g.expr}, b.item`;
  const ord = isItem ? 'ABS(COALESCE(SUM(b.close_val),0)) DESC, b.item'
                     : '1 ASC, ABS(COALESCE(SUM(b.close_val),0)) DESC, b.item';
  const rows = await all(`
    SELECT ${sel}, COUNT(*)::int lines, COUNT(DISTINCT b.balance_date)::int days,
           COALESCE(SUM(b.open_qty),0)::float open_qty,
           COALESCE(SUM(b.open_val),0)::float open_val,
           COALESCE(SUM(b.close_qty),0)::float close_qty,
           COALESCE(SUM(b.close_val),0)::float close_val
      FROM balances b ${INV_JOIN}
      ${wb.sql ? 'WHERE ' + wb.sql : ''}
     GROUP BY ${key}
     ORDER BY ${ord} LIMIT ${lim}`, wb.params);
  return { level: lv, label: g.label, rows };
}

/* ٣) فترات — افتتاحي أول تاريخ + ختامي آخر تاريخ لكل سنة ثم كل شهر */
async function inventoryPeriods(F = {}) {
  const wb = conds(F, BAL_COLS);
  const w = wb.sql ? 'WHERE ' + wb.sql : '';
  const q = len => `
    WITH f AS (SELECT b.* FROM balances b ${w}),
    fl AS (SELECT SUBSTR(balance_date,1,${len}) ym, MIN(balance_date) mn, MAX(balance_date) mx
             FROM f WHERE balance_date IS NOT NULL AND balance_date <> '' GROUP BY 1)
    SELECT fl.ym,
      (SELECT COALESCE(SUM(f2.open_qty),0)::float  FROM f f2 WHERE f2.balance_date = fl.mn) open_qty,
      (SELECT COALESCE(SUM(f2.open_val),0)::float  FROM f f2 WHERE f2.balance_date = fl.mn) open_val,
      (SELECT COALESCE(SUM(f2.close_qty),0)::float FROM f f2 WHERE f2.balance_date = fl.mx) close_qty,
      (SELECT COALESCE(SUM(f2.close_val),0)::float FROM f f2 WHERE f2.balance_date = fl.mx) close_val,
      (SELECT COUNT(*)::int FROM f f2 WHERE f2.balance_date BETWEEN fl.mn AND fl.mx) lines,
      (SELECT COUNT(DISTINCT f2.item)::int FROM f f2 WHERE f2.balance_date BETWEEN fl.mn AND fl.mx) items
    FROM fl ORDER BY fl.ym`;
  const months = await all(q(7), wb.params);
  const years = await all(q(4), wb.params);
  return {
    months: months.map(r => ({ ...r, level: 'شهر' })),
    years: years.map(r => ({ ...r, level: 'سنة' })),
  };
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

/* ---------- تقرير حركات السيستم: إسقاط الإلغاءات + صافي كل توجيه ---------- */
/**
 * السيستم لا يحذف صفوفاً: إلغاء أي حركة يظهر كحركة لاحقة **بعكس الإشارة** وقيمة
 * مطابقة تماماً. فكل زوج من هذا النوع ملغى صافياً — نفس الأبعاد (صنف/وحدة/توجيه/
 * مخزن/مكان) ونفس المقدار المطلق للكمية والقيمة بإشارتين متعاكستين.
 *
 * المطابقة تجري داخل «مفتاح إلغاء» واحد: (الأبعاد، |الكمية|، |القيمة|) — والزَميل
 * المعاكس لأي صف يحمل نفس المقدار المطلق بإشارتين معاكستين. فبدل ربط ذاتي بين كل
 * زوج، نعدّ صفوف المفتاح في **تسع دلاء** بحسب (إشارة الكمية، إشارة القيمة) — ولكل
 * دَلّي زميله المعاكس: (+,+)↔(−,−) و(+,−)↔(−,+) و(+,0)↔(−,0) و(0,+)↔(0,−). الصفر
 * يحتاج دلاءً خاصة به وإلا لما ألغى نظيره (قيمة 0 ليست موجبة ولا سالبة).
 * المتبقّي بعد الأزواج هو الحركة الحقيقية — وصافي الكمية/القيمة لا يتأثر بالإلغاء
 * (الزوجان يلغي أحدهما الآخر)، أما عدد الحركات فينظف.
 */
function movementsLiveCte(wm) {
  const w = wm && wm.sql ? 'WHERE ' + wm.sql : '';
  return `
    WITH f AS (
      SELECT m.item, m.item_desc, m.uom,
             COALESCE(NULLIF(TRIM(m.direction),''),'(غير محدد)') direction,
             COALESCE(NULLIF(TRIM(m.storage_loc),''),'(بدون مخزن)') storage_loc,
             COALESCE(NULLIF(TRIM(m.place),''),'(غير محدد)') place,
             COALESCE(m.qty,0)::float qty, COALESCE(m.amount,0)::float amount
        FROM movements m ${w}
    ),
    k AS (
      SELECT item, item_desc, uom, direction, storage_loc, place,
             ABS(qty)::float aq, ABS(amount)::float aa,
             SUM(CASE WHEN qty >  0 AND amount >  0 THEN 1 ELSE 0 END)::int c_pp,
             SUM(CASE WHEN qty <  0 AND amount <  0 THEN 1 ELSE 0 END)::int c_mm,
             SUM(CASE WHEN qty >  0 AND amount <  0 THEN 1 ELSE 0 END)::int c_pm,
             SUM(CASE WHEN qty <  0 AND amount >  0 THEN 1 ELSE 0 END)::int c_mp,
             SUM(CASE WHEN qty >  0 AND amount =  0 THEN 1 ELSE 0 END)::int c_p0,
             SUM(CASE WHEN qty <  0 AND amount =  0 THEN 1 ELSE 0 END)::int c_m0,
             SUM(CASE WHEN qty =  0 AND amount >  0 THEN 1 ELSE 0 END)::int c_0p,
             SUM(CASE WHEN qty =  0 AND amount <  0 THEN 1 ELSE 0 END)::int c_0m,
             SUM(CASE WHEN qty =  0 AND amount =  0 THEN 1 ELSE 0 END)::int c_00
        FROM f GROUP BY 1,2,3,4,5,6,7,8
    ),
    live AS (
      SELECT item, item_desc, uom, direction, storage_loc, place, aq, aa,
             c_pp - LEAST(c_pp, c_mm) l_pp, c_mm - LEAST(c_pp, c_mm) l_mm,
             c_pm - LEAST(c_pm, c_mp) l_pm, c_mp - LEAST(c_pm, c_mp) l_mp,
             c_p0 - LEAST(c_p0, c_m0) l_p0, c_m0 - LEAST(c_p0, c_m0) l_m0,
             c_0p - LEAST(c_0p, c_0m) l_0p, c_0m - LEAST(c_0p, c_0m) l_0m,
             c_00                        l_00
        FROM k
    )`;
}

/* صافي الحركة الحقيقية من الدلاء التسع — الكمية والقيمة على حدة.
   بصمة كل دَلّي:  (إشارة الكمية، إشارة القيمة)  →  مساهمته في (qty, amount)
     pp(+,+) → (+aq,+aa)   mm(−,−) → (−aq,−aa)   pm(+,−) → (+aq,−aa)
     mp(−,+) → (−aq,+aa)   p0(+,0) → (+aq,0)     m0(−,0) → (−aq,0)
     0p(0,+) → (0,+aa)     0m(0,−) → (0,−aa)     00(0,0) → (0,0)          */
const Q_POS = '(l_pp + l_pm + l_p0)';        // كمية بإشارة موجبة
const Q_NEG = '(l_mm + l_mp + l_m0)';        // كمية بإشارة سالبة
const V_POS = '(l_pp + l_mp + l_0p)';        // قيمة بإشارة موجبة
const V_NEG = '(l_mm + l_pm + l_0m)';        // قيمة بإشارة سالبة
const LIVE_QTY = `(${Q_POS} * aq - ${Q_NEG} * aq)`;
const LIVE_VAL = `(${V_POS} * aa - ${V_NEG} * aa)`;
const LIVE_CNT = `(l_pp + l_mm + l_pm + l_mp + l_p0 + l_m0 + l_0p + l_0m + l_00)`;

async function movementsReport(F = {}, limit = 2000) {
  const wm = conds(F, MOV_COLS);
  const cte = movementsLiveCte(wm);
  const lim = Math.max(1, Math.min(Number(limit) || 2000, 20000));
  const directions = await all(`${cte}
    SELECT direction,
           SUM(${LIVE_CNT})::int lines,
           SUM(${Q_POS} * aq)::float in_qty,
           SUM(${V_POS} * aa)::float in_val,
           SUM(${Q_NEG} * aq)::float out_qty,
           SUM(${V_NEG} * aa)::float out_val,
           SUM(${LIVE_QTY})::float qty,
           SUM(${LIVE_VAL})::float amount
      FROM live GROUP BY direction
      ORDER BY SUM(${LIVE_CNT}) DESC`, wm.params);
  const rows = await all(`${cte}
    SELECT item, item_desc, uom, direction, storage_loc, place,
           SUM(${LIVE_CNT})::int lines,
           SUM(${LIVE_QTY})::float qty,
           SUM(${LIVE_VAL})::float amount
      FROM live
     GROUP BY item, item_desc, uom, direction, storage_loc, place
    HAVING SUM(${LIVE_CNT}) > 0
     ORDER BY ABS(SUM(${LIVE_VAL})) DESC, direction, item
     LIMIT ${lim}`, wm.params);
  return { directions, rows, removedNote: 'أرقام صافية بعد إسقاط حركات الإلغاء' };
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
/* المبيعات تُقرأ مع locations/items — فأبعاد الشركة والتصنيف والمجموعة تُشتق منهما */
const DIM_TABLES = {
  sales:     { place: 's.place',        unit: 's.unit_code',    cust: 's.beneficiary', storage: 's.storage_loc',
               company: 'l.company_code', cls: CLS_EXPR,        grp: GRP_EXPR },
  movements: { place: 'm.place',        unit: 'm.unit_code',    company: 'm.company_code',
               mtype: 'm.move_type',    dir: 'm.direction',      storage: 'm.storage_loc' },
  balances:  { place: 'b.place',        unit: 'b.unit_code',    company: 'b.company_code', storage: 'b.storage_loc' },
};
const DIM_SRC = {
  sales: `sales s ${SALES_JOIN}`.replace(/\s+/g, ' '),
  movements: 'movements m', balances: 'balances b',
};

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
  const borse = await get('SELECT MIN(borse_date) a, MAX(borse_date) b FROM borse');
  const prices = await get('SELECT MIN(price_date) a, MAX(price_date) b FROM prices');
  const costs = await get('SELECT MIN(cost_date) a, MAX(cost_date) b FROM daily_costs');
  return {
    movements: [mov.a, mov.b], sales: [sal.a, sal.b], balances: [bal.a, bal.b],
    borse: [borse.a, borse.b], prices: [prices.a, prices.b], costs: [costs.a, costs.b],
  };
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
  overview, reconcile, detectCostRule, costWhere, dateSpan,
  detectCostLink, setCostLink, profitCte, COST_LINKS,
  parseFilters, hasFilters, dims,
  salesByPlace, salesByItem, salesByMonth, salesByCustomer, salesByClass, costByMonth,
  salesDetail, salesTotalBy, salesByPeriod, TOTAL_LEVELS, salesDaily,
  salesBreakdown, BREAKDOWN_GROUPS,
  movementsByDirection, movementsByMonth, movementsByPlace, topMovementItems, movementsReport,
  movementsDetail, movementsBreakdown, movementsPeriods, MOV_GROUPS,
  inventoryByPlace, inventoryByClass,
  inventoryDetail, inventoryBreakdown, inventoryPeriods, INV_GROUPS,
  borseLatest, borseSeries, borseUsd, borseSummary, borseRecent, borseCutoff,
};
