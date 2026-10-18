'use strict';
/**
 * محرك التحليل — PostgreSQL
 * مؤشرات الأداء، مطابقة المخزون، تحليل المبيعات والحركات.
 * كل الأرقام تُحسب من الجداول الخام داخل قاعدة البيانات (لا اعتماد على تقارير Excel).
 */
const { all, get, run, tx, setSetting, getSetting, delSetting } = require('./db');
const pbix = require('./pbix');

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
           l.company_code, l.company_name, l.unit_name, l.currency
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
  const get = k => { 
    const v = q ? String(q.get(k) || '') : ''; 
    try { return decodeURIComponent(v).trim(); } catch { return v.trim(); }
  };
  console.log('DEBUG parseFilters q.get(kind):', JSON.stringify(q.get('kind')));
  const F = {
    from: get('from'), to: get('to'),
    place: get('place'), company: get('company'), unit: get('unit'),
    item: get('item'), cust: get('cust'), dir: get('dir'), mtype: get('mtype'),
    storage: get('storage'), cls: get('cls'), grp: get('grp'),
    sev: get('sev'), ent: get('ent'),
    mode: get('mode'),
    by: get('by'), by2: get('by2'), per: get('per'),
    kind: get('kind'),
  };
  for (const k of RANGE_DIMS) { F[k + '_from'] = get(k + '_from'); F[k + '_to'] = get(k + '_to'); }
  return F;
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

/* ---------- مطابقة الأرصدة: رصيد نهاية التاريخ السابق ⇐ رصيد بداية التاريخ التالي ---------- */

/* ---------- تحليل المبيعات (مبنية على CTE الربحية الموحّد) ---------- */
/* تكلفة التجمع = مطلق صافي حركاته (المردودات تُخصم من الإصدارات) — نفس
   دلالة الطريقة القديمة: ABS على الإجمالي لا على السطر، وإلا تحول المردود
   إلى تكلفة موجبة ويُضخّم التكلفة (مُختبر: 283,121 بدل 130,919). */
const withProfit = rows => rows.map(r => ({
  ...r,
  profit: (r.value || 0) - (r.cost || 0),
  marginPct: r.value ? (((r.value || 0) - (r.cost || 0)) / r.value) * 100 : 0,
}));






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

/* ٣) تقرير الفترات — بالأشهر، وبالأعوام فوقها */
/* تقرير شاشة «المبيعات اليومية»: تفصيلي (كل الأبعاد) أو مجمّع على مستويين
   (أساسي {صنف/مجموعة/تصنيف} × تفصيل {مكان/شركة/عميل/مخزن/وحدة}) */
async function salesDaily(F = {}, by = 'detail', by2 = '', per = '', limit = 20000) {
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
  if (by === 'detail' && !by2) {
    return { level: 'detail', label: 'تفصيلي', rows: clean(await salesDetail(F, lim)) };
  }
  const t = await salesGroup(F, by === 'detail' ? 'item' : by, by2, per, lim);
  return { level: t.level, label: t.label, by2: t.by2, label2: t.label2, per: t.per, perLabel: t.perLabel, rows: clean(t.rows) };
}
/* ===== تجميع على مستوى الفترة: أسبوعي/شهري/ربع سنوي/نصف سنوي/3أرباع/سنوي =====
/* التواريخ نصية (YYYY-MM-DD) — نشتق منها الفترة بمقاطع وإلا اليوم الأسبوعي ب(Date) */
const PERIOD_EXPRS = {
  week:    d => `TO_CHAR(TO_DATE(SUBSTR(${d},1,10),'YYYY-MM-DD'),'IYYY-IW')`,
  month:   d => `SUBSTR(${d},1,7)`,
  quarter: d => `SUBSTR(${d},1,4) || '-Q' || ((CAST(SUBSTR(${d},6,2) AS integer) + 2) / 3)`,
  half:    d => `SUBSTR(${d},1,4) || '-H' || ((CAST(SUBSTR(${d},6,2) AS integer) + 5) / 6)`,
  q3:      d => `SUBSTR(${d},1,4) || '-9M' || ((CAST(SUBSTR(${d},6,2) AS integer) + 8) / 9)`,
  year:    d => `SUBSTR(${d},1,4)`,
};
const PERIOD_LABELS = { week: 'أسبوعي', month: 'شهري', quarter: 'ربع سنوي', half: 'نصف سنوي', q3: '3 أرباع', year: 'سنوي' };

/* تجميع المبيعات على مستويين: أساسي (صنف/مجموعة/تصنيف) x تفصيل (مكان/شركة/عميل/مخزن/وحدة) */
const SALES_G1 = {
  item: { label: 'الصنف', expr: "COALESCE(NULLIF(sp.item,''),'(بدون صنف)')" },
  grp:  { label: 'المجموعة', expr: "COALESCE(NULLIF(sp.grp,''),'(غير محدد)')" },
  cls:  { label: 'التصنيف', expr: "COALESCE(NULLIF(sp.cls,''),'(غير محدد)')" },
};
const SALES_G2 = {
  place:   { label: 'المكان', expr: "COALESCE(NULLIF(sp.place,''),'(غير محدد)')" },
  company: { label: 'الشركة', expr: "COALESCE(NULLIF(sp.company_name,''), sp.company_code, '(بدون شركة)')" },
  cust:    { label: 'العميل', expr: "COALESCE(NULLIF(sp.beneficiary,''),'(غير محدد)')" },
  storage: { label: 'المخزن', expr: "COALESCE(NULLIF(sp.storage_loc,''),'(بدون مخزن)')" },
  unit:    { label: 'الوحدة', expr: "COALESCE(NULLIF(sp.unit_name,''), sp.unit_code, '(بدون وحدة)')" },
};
async function salesGroup(F = {}, by = 'item', by2 = '', per = '', limit = 20000) {
  const g1 = SALES_G1[by] || SALES_G1.item;
  const has2 = !!(by2 && SALES_G2[by2]);
  const g2 = has2 ? SALES_G2[by2] : null;
  const perE = per && PERIOD_EXPRS[per] ? PERIOD_EXPRS[per]("sp.invoice_date") : null;
  const { cte, params } = await profitCte(F);
  const lim = Math.max(1, Math.min(Number(limit) || 20000, 20000));
  const itemExtra = by === 'item' ? `, MAX(sp.item_desc) item_desc, COALESCE(MAX(NULLIF(sp.uom,'')),'') uom` : '';
  const sel = `${perE ? perE + ' per, ' : ''}${g1.expr} g1${has2 ? `, ${g2.expr} g2` : ''}${itemExtra}`;
  const grp = [perE, g1.expr, has2 ? g2.expr : null].filter(Boolean).join(", ");
  const rows = await all(`${cte}
    SELECT ${sel},
           COUNT(*)::int lines, COUNT(DISTINCT invoice_doc)::int docs,
           COALESCE(SUM(qty),0)::float qty, COALESCE(SUM(value),0)::float value,
           COALESCE(SUM(tax),0)::float tax,
           COALESCE(ABS(SUM(cost)),0)::float cost,
           COUNT(*) FILTER (WHERE matched)::int matched_lines
      FROM sp GROUP BY ${grp}
     ORDER BY 1 ASC, ABS(COALESCE(SUM(value),0)) DESC
     LIMIT ${lim}`, params);
  return { level: by, label: g1.label, by2: has2 ? by2 : '', label2: has2 ? g2.label : '',
    per: perE ? per : '', perLabel: perE ? PERIOD_LABELS[per] : '', rows: withProfit(rows) };
}

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
/* تجميع الحركات على مستويين: أساسي (صنف/مجموعة/تصنيف) x تفصيل (مكان/شركة/وحدة/مخزن) */
const MOV_G1 = {
  item: { label: 'الصنف', expr: "COALESCE(NULLIF(net.item,''),'(بدون صنف)')" },
  grp:  { label: 'المجموعة', expr: GRP_EXPR },
  cls:  { label: 'التصنيف', expr: CLS_EXPR },
};
const MOV_G2 = {
  place:   { label: 'المكان', expr: "COALESCE(NULLIF(net.place,''),'(غير محدد)')" },
  company: { label: 'الشركة', expr: "COALESCE(NULLIF(l.company_name,''), net.company_code, '(بدون شركة)')" },
  unit:    { label: 'الوحدة', expr: "COALESCE(NULLIF(l.unit_name,''), net.unit_code, '(بدون وحدة)')" },
  storage: { label: 'المخزن', expr: "COALESCE(NULLIF(net.storage_loc,''),'(بدون مخزن)')" },
};
async function movementsGroup(F = {}, by = 'item', by2 = '', per = '', limit = 20000) {
  const wm = conds(F, MOV_COLS);
  const g1 = MOV_G1[by] || MOV_G1.item;
  const has2 = !!(by2 && MOV_G2[by2]);
  const g2 = has2 ? MOV_G2[by2] : null;
  const perE = per && PERIOD_EXPRS[per] ? PERIOD_EXPRS[per]('net.post_date') : null;
  const lim = Math.max(1, Math.min(Number(limit) || 20000, 20000));
  const needJoin = by === 'cls' || by === 'grp' || by2 === 'cls' || by2 === 'grp' || by2 === 'company' || by2 === 'unit';
  const join = needJoin ? " LEFT JOIN items i ON i.code = net.item AND i.kind = 'item' LEFT JOIN locations l ON l.unit_code = net.unit_code" : '';
  const itemExtra = by === 'item' ? `, MAX(net.item_desc) item_desc, COALESCE(MAX(NULLIF(net.uom,'')),'') uom` : '';
  const sel = `${perE ? perE + ' per, ' : ''}${g1.expr} g1${has2 ? `, ${g2.expr} g2` : ''}${itemExtra}`;
  const grp = [perE, g1.expr, has2 ? g2.expr : null].filter(Boolean).join(", ");
  const rows = await all(`${movementsNetCte(wm)}
    SELECT ${sel}, COUNT(*)::int lines,
           ${MN_IN_Q}::float in_qty, ${MN_OUT_Q}::float out_qty,
           ${MN_IN_V}::float in_val, ${MN_OUT_V}::float out_val,
           SUM(net.qty)::float qty, SUM(net.amount)::float amount
      FROM net${join} GROUP BY ${grp}
     ORDER BY 1 ASC, ABS(COALESCE(SUM(net.amount),0)) DESC
     LIMIT ${lim}`, wm.params);
  return { level: by, label: g1.label, by2: has2 ? by2 : '', label2: has2 ? g2.label : '',
    per: perE ? per : '', perLabel: perE ? PERIOD_LABELS[per] : '', rows };
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
/* تجميع الأرصدة على مستويين: أساسي (صنف/مجموعة/تصنيف) x تفصيل (مكان/شركة/وحدة/مخزن) */
const INV_G1 = {
  item: { label: 'الصنف', expr: "COALESCE(NULLIF(b.item,''),'(بدون صنف)')" },
  grp:  { label: 'المجموعة', expr: GRP_EXPR },
  cls:  { label: 'التصنيف', expr: CLS_EXPR },
};
const INV_G2 = {
  place:   { label: 'المكان', expr: "COALESCE(NULLIF(b.place,''),'(غير محدد)')" },
  company: { label: 'الشركة', expr: "COALESCE(NULLIF(l.company_name,''), l.company_code, '(بدون شركة)')" },
  unit:    { label: 'الوحدة', expr: "COALESCE(NULLIF(l.unit_name,''), b.unit_code, '(بدون وحدة)')" },
  storage: { label: 'المخزن', expr: "COALESCE(NULLIF(b.storage_loc,''),'(بدون مخزن)')" },
};
async function inventoryGroup(F = {}, by = 'item', by2 = '', per = '', limit = 20000) {
  const wb = conds(F, BAL_COLS);
  const g1 = INV_G1[by] || INV_G1.item;
  const has2 = !!(by2 && INV_G2[by2]);
  const g2 = has2 ? INV_G2[by2] : null;
  const perE = per && PERIOD_EXPRS[per] ? PERIOD_EXPRS[per]('b.balance_date') : null;
  const lim = Math.max(1, Math.min(Number(limit) || 20000, 20000));
  const itemExtra = by === 'item' ? `, MAX(COALESCE(NULLIF(i.descr,''),NULLIF(b.item_desc,''))) item_desc, COALESCE(MAX(NULLIF(i.uom,'')),'') uom` : '';
  const sel = `${perE ? perE + ' per, ' : ''}${g1.expr} g1${has2 ? `, ${g2.expr} g2` : ''}${itemExtra}`;
  const grp = [perE, g1.expr, has2 ? g2.expr : null].filter(Boolean).join(", ");
  const rows = await all(`
    SELECT ${sel}, COUNT(*)::int lines, COUNT(DISTINCT b.balance_date)::int days,
           COALESCE(SUM(b.open_qty),0)::float open_qty,
           COALESCE(SUM(b.open_val),0)::float open_val,
           COALESCE(SUM(b.close_qty),0)::float close_qty,
           COALESCE(SUM(b.close_val),0)::float close_val
      FROM balances b
      LEFT JOIN items i ON i.code = b.item
      LEFT JOIN locations l ON l.unit_code = b.unit_code
      ${wb.sql ? 'WHERE ' + wb.sql : ''}
     GROUP BY ${grp}
     ORDER BY 1 ASC, ABS(COALESCE(SUM(b.close_val),0)) DESC
     LIMIT ${lim}`, wb.params);
  return { level: by, label: g1.label, by2: has2 ? by2 : '', label2: has2 ? g2.label : '',
    per: perE ? per : '', perLabel: perE ? PERIOD_LABELS[per] : '', rows };
}


/* ================= تقارير عقود الاستيراد ================= */
/* فلاتر العقود: التاريخ على «تاريخ التعاقد»، والتصنيف على classification،
   والبحث (item) على الرقم الداخلي. */
const CON_REG_COLS = { date: 'contract_date', cls: 'classification', item: 'internal_no' };
/* القيمة المتوقعة للعقد = الكمية × سعر CIF المتوقع */
const CON_EXPVAL = '(COALESCE(quantity,0) * COALESCE(expected_cif_price,0))';
/* مستويات التجميع (تُستخدم أساسياً وتفصيلياً) */
const CON_REG_GROUPS = {
  cls:   { label: 'التصنيف',       expr: "COALESCE(NULLIF(classification,''),'(غير محدد)')" },
  sup:   { label: 'المورد',        expr: "COALESCE(NULLIF(supplier,''),'(غير محدد)')" },
  src:   { label: 'المصدر',        expr: "COALESCE(NULLIF(source_country,''),'(غير محدد)')" },
  cat:   { label: 'تصنيف التعاقد', expr: "COALESCE(NULLIF(contract_category,''),'(غير محدد)')" },
  type:  { label: 'نوع التعاقد',   expr: "COALESCE(NULLIF(contract_type,''),'(غير محدد)')" },
  stat:  { label: 'حالة العقد',    expr: "COALESCE(NULLIF(contract_status,''),'(غير محدد)')" },
  ship:  { label: 'الشحن',         expr: "COALESCE(NULLIF(shipping_type,''),'(غير محدد)')" },
  ccomp: { label: 'شركة التعاقد',  expr: "COALESCE(NULLIF(contracting_company,''),'(غير محدد)')" },
};


/* ================= صفحات Power BI لعقود الاستيراد (إعادة بناء) =================
   تُبنى من جداول العقود المستوردة نفسها. المقاييس المحسوبة هنا مُعاد بناؤها من منطق
   البيانات وأوراق «متابعة الربط/التحميل» في ملف Excel — لأن مقاييس DAX داخل ملف
   الـPBIX مرتبطة بنموذج سحابي وغير قابلة للاستخراج محلياً. الأعمدة المباشرة
   (الأسعار/الأرصدة/الكميات) مطابقة للمصدر تماماً، والمشتقة موضّحة صيغتها.
   ============================================================================== */
const AR_MONTH_NAMES = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
/** «2026-07-01» ← «يوليو 2026» (شهر عربى للعرض والتجميع) */
function arMonthLabel(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
  return m ? `${AR_MONTH_NAMES[+m[2] - 1]} ${m[1]}` : '';
}
/** تطبيع اسم التصنيف: حذف التطويل والمسافات وتوحيد الهمزات/الياء/التاء المربوطة */
function clsKey(s) {
  return String(s || '')
    .replace(/[\u0640\s]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
}
const numf = v => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const r2 = n => Math.round(numf(n) * 100) / 100;

/* ---------- محور التصنيف الموحَّد (Canonical Class Axis) ----------
   الربط الصحيح بين عقود الاستيراد وبيانات النظام العام يجري **بالكود** لا بالاسم:
     contract_items.code  =  items.group_code   (كلاهما 1001..5002)
     contract_balances.item_code = نفس فضاء الأكواد
   ويُبنى منه المحور الموحَّد مرة واحدة لكل استدعاء، فيُستخدم في كل تقارير العقود.
   نوع التصنيف (رئيسي/إضافات/أخرى) يأتي من «اتجاه» العقد (خامات/إضافات/أخرى)،
   ويُستكمل من تصنيف النظام (items.class_code) للأكواد غير الموجودة في العقود. */
function kindOfDirection(dir) {
  const d = clsKey(dir);
  if (d.includes('اضافات') || d.includes('ادويه')) return 'additive';
  if (d.includes('خامات')) return 'main';
  if (d.includes('اخري')) return 'other';
  return null;
}
function kindOfClassCode(cc) {
  const c = String(cc || '').trim();
  if (c === '101' || c === '204') return 'main';    /* خامات / خامات معبأ */
  if (c === '102') return 'additive';               /* إضافات */
  if (c) return 'other';                            /* أخرى / علف / دشيشة / مركزات ... */
  return null;
}
async function classAxis() {
  const [ci, grps, cls] = await Promise.all([
    all(`SELECT code, name, direction FROM contract_items`),
    /* صفوف المجموعة نفسها بلا تصنيف — فيُشتق تصنيفها من صفوف الأصناف (كما في master.js) */
    all(`SELECT r.code, r.descr,
                (SELECT MAX(i.class_code) FROM items i WHERE i.kind='item' AND i.group_code=r.code) class_code,
                (SELECT MAX(i.class_desc) FROM items i WHERE i.kind='item' AND i.group_code=r.code) class_desc
           FROM items r WHERE r.kind='group'`),
    all(`SELECT code, descr FROM items WHERE kind='class'`),
  ]);
  const byCode = new Map();
  const byKey = new Map();
  const clsDesc = new Map(cls.map(c => [String(c.code).trim(), c.descr]));
  const reg = (code, name, extra = {}) => {
    const cd = String(code || '').trim();
    if (!cd) return;
    const cur = byCode.get(cd) || { code: cd };
    if (name && !cur.name) cur.name = String(name).trim();
    for (const k in extra) if (extra[k] !== undefined && extra[k] !== '') cur[k] = extra[k];
    cur.kind = kindOfDirection(cur.direction) || kindOfClassCode(cur.class_code);
    cur.class_desc = cur.class_desc || clsDesc.get(String(cur.class_code || '').trim()) || '';
    byCode.set(cd, cur);
  };
  /* عقود الاستيراد أولاً (اسمها واتجاهها هو المرجع)، ثم مجموعات النظام (تصنيفها) */
  for (const c of ci) reg(c.code, c.name, { direction: c.direction, ci: 1 });
  for (const g of grps) reg(g.code, g.descr, { class_code: g.class_code, class_desc: g.class_desc, erp: 1 });
  /* فهرسة الأسماء بعد اكتمالها */
  for (const m of byCode.values()) { const k = clsKey(m.name); if (k && !byKey.has(k)) byKey.set(k, m.code); }
  return { byCode, byKey, clsDesc };
}
/** يحلّ كوداً أو اسماً إلى بيانات التصنيف المعيارية (كود + اسم + نوع) */
function resolveClass(axis, codeOrName, fallbackName) {
  const raw = String(codeOrName == null ? '' : codeOrName).trim();
  let meta = raw ? axis.byCode.get(raw) : null;
  if (!meta && raw) { const c = axis.byKey.get(clsKey(raw)); if (c) meta = axis.byCode.get(c); }
  if (!meta && fallbackName) { const c = axis.byKey.get(clsKey(fallbackName)); if (c) meta = axis.byCode.get(c); }
  if (meta) return meta;
  return { code: '', name: (fallbackName || raw || '').trim(), direction: '', class_code: '', class_desc: '', kind: null };
}

/**
 * بناء مجموعة «تغطية الخامات» لكل تصنيف من كل جداول العقود في خطوة واحدة.
 * الربط بالكود (contract_items.code = items.group_code = contract_balances.item_code)، ثم
 * تُجمَّع المقاييس من محرّك Power BI (src/pbix.js) ليطابق الناتج النموذج حرفياً.
 */
/* ==============================================================================
   صفحات عقود الاستيراد — فوق «محرّك Power BI» (src/pbix.js)
   كل رقم هنا يُحسب بنفس Power Query + DAX فى النموذج، فيطابق Power BI حرفياً.
   فلتر التاريخ المفرد (بطاقة التاريخ أعلى الصفحة) يُطبَّق على «الارصدة» فقط،
   ولا يُطبَّق على «تاريخ التعاقد» (تطبيقه هو سبب اختلاف الأرقام سابقاً).
   المرجع: _handover/pbix-model/  (m-queries/ + MODEL.txt + DAX)
   ============================================================================== */

/** التاريخ المفرد المختار فى بطاقة التاريخ (from = to) أو '' */
function pbixDate(F = {}) {
  const f = F && F.from ? String(F.from).slice(0, 10) : '';
  const t = F && F.to ? String(F.to).slice(0, 10) : '';
  return (f && t && f === t) ? f : '';
}

/** يبني نموذج Power BI مع تطبيق فلتر التاريخ على الارصدة + فلاتر التصنيف/الصنف */
async function pbixModel(F = {}) {
  const model = await pbix.loadModel({ balanceDate: pbixDate(F) || null });
  if (F.cls) {
    const k = clsKey(F.cls);
    model.reg = model.reg.filter(r => clsKey(r.classification) === k);
    model.bal = model.bal.filter(b => clsKey(b.classification) === k);
  }
  if (F.item) {
    const it = String(F.item).toLowerCase();
    model.reg = model.reg.filter(r => String(r.internal_no).toLowerCase().includes(it));
  }
  model.regByNo = new Map();
  for (const r of model.reg) if (r.internal_no) model.regByNo.set(r.internal_no, r);
  return model;
}

/** تصنيفات الأرصدة مجمّعة على التصنيف (جانب المخزون — لا يعتمد على العقود) */
function balClasses(model) {
  const m = new Map();
  for (const b of model.bal) {
    const k = String(b.classification || '');
    const o = m.get(k) || { total: 0, consumption: 0, contract_add: 0, port_add: 0, total_add: 0,
      daily_rate: 0, price_usd: 0, market_price: 0, expenses: 0, days_enough: 0, enough_until: '' };
    o.total += numf(b.total_balance);
    o.consumption += numf(b.consumption);
    o.contract_add += numf(b.contract_additions);
    o.port_add += numf(b.port_additions);
    o.total_add += numf(b.total_add);
    o.daily_rate += numf(b.daily_rate);
    o.price_usd = o.price_usd || numf(b.price_usd);
    o.market_price = o.market_price || numf(b.market_price);
    o.expenses = o.expenses || numf(b.expenses);
    o.days_enough = o.days_enough || numf(b.days_enough);
    o.enough_until = o.enough_until || b.enough_until || '';
    m.set(k, o);
  }
  return m;
}

/**
 * تغطية الخامات: صف لكل تصنيف تجمع مقاييس Power BI (النشطة) + جانبالارصدة.
 * تُغذّي صفحات: ① الرئيسية ② موقف الربط ⑤ التكلفة ⑥ الخامات الرئيسية ⑦ الإضافات.
 */
async function contractCoverage(F = {}) {
  const axis = await classAxis();
  const model = await pbixModel(F);
  const balMap = balClasses(model);

  /* فلتر نوع التصنيف: "بورصة" (3 أصناف) / "خامات" / "اضافات" */
  const kindFilter = F && F.kind ? String(F.kind).trim() : '';
  console.log('DEBUG kindFilter:', JSON.stringify(kindFilter));

  /* التصنيفات: تصنيفات العقود أولاً (بترتيب التسجيل) ثم أرصدة بلا عقود */
  const order = [];
  const seen = new Set();
  for (const r of model.reg) { const c = String(r.classification || ''); if (c && !seen.has(c)) { seen.add(c); order.push(c); } }
  for (const b of model.bal) { const c = String(b.classification || ''); if (c && !seen.has(c)) { seen.add(c); order.push(c); } }

  const isMainName = cls => /ذره|صويا|بذره|دوارالشمس|دوارشمس|ديجياس|جلوتين|تفلبنجر|كسب|دريس|سيلاج/.test(clsKey(cls));

  /* تطبيق فلتر نوع التصنيف */
  let filteredOrder = order;
  if (kindFilter === 'بورصة') {
    filteredOrder = order.filter(cls => {
      const k = clsKey(cls);
      return k === 'الذره' || k === 'الصويا' || k === 'البذره';
    });
  } else if (kindFilter === 'خامات') {
    // خامات = التصنيفات الرئيسية (main)
    filteredOrder = order.filter(cls => isMainName(cls));
  } else if (kindFilter === 'اضافات') {
    // إضافات = التصنيفات غير الرئيسية (additive)
    filteredOrder = order.filter(cls => !isMainName(cls));
  }

  const zero = { total: 0, consumption: 0, contract_add: 0, port_add: 0, total_add: 0, daily_rate: 0,
    price_usd: 0, market_price: 0, expenses: 0, days_enough: 0, enough_until: '' };

  const rows = filteredOrder.map(cls => {
    const ctx = model.reg.filter(r => String(r.classification) === cls);
    const m = pbix.measures(model, ctx);
    const meta = resolveClass(axis, cls, cls);
    const b = balMap.get(cls) || zero;
    const nos = new Set(ctx.map(r => r.internal_no));
    const maxBourse = model.hedge.filter(h => nos.has(String(h.internal_no)))
      .reduce((mx, h) => Math.max(mx, numf(h.exchange_price)), 0);
    const premNum = ctx.reduce((s, r) => s + numf(r.avg_hedge_price) * numf(r.hedge_sum), 0);
    const premDen = ctx.reduce((s, r) => s + numf(r.hedge_sum), 0);
    const currentCost = b.price_usd * b.daily_rate + b.expenses;
    return {
      cls: cls || '(غير محدد)',
      class_code: meta.class_code || meta.code || '',
      class_desc: meta.class_desc || '',
      direction: meta.direction || '',
      contracts: new Set(ctx.map(r => r.internal_no).filter(Boolean)).size,
      contracted: r2(m.qtyContract),
      expected_value: r2(ctx.reduce((s, r) => s + numf(r.required_value), 0)),
      hedged: r2(ctx.reduce((s, r) => s + numf(r.hedge_sum), 0)),
      remaining_open: r2(m.remaining),
      paid: r2(m.paidActive),
      released: r2(m.releasedActive),
      paid_unpriced: r2(m.paidNoPricing),
      paid_not_opened: r2(m.paidUnopened),
      sold: r2(m.soldActive),
      balance: r2(m.totalBalance),
      factory: r2(m.factory),
      port: r2(m.portBalance),
      coverage_balance: r2(m.coverage),
      position: r2(m.totalBalance),
      consumption: r2(m.consumption),
      contract_additions: r2(b.contract_add),
      port_additions: r2(b.port_add),
      items_total: r2(b.total_add),
      balance_raw: r2(b.total),
      available_days: r2(m.availableDays),
      total_days: r2(m.totalDays),
      /* متوسط مرجّح لبريم الربط (عرض فقط — المقاييس المعتمدة تأتى من المحرّك) */
      net_premium: r2(premDen ? premNum / premDen : 0),
      max_bourse: r2(maxBourse),
      days_enough: r2(b.days_enough),
      enough_until: b.enough_until || '',
      daily_rate: r2(b.daily_rate),
      price_usd: r2(b.price_usd),
      current_cost: r2(currentCost),
      market_price: r2(b.market_price),
      diff: r2(b.market_price - currentCost),
      kind: meta.kind || (isMainName(cls) ? 'main' : 'additive'),
    };
  });
  return { rows };
}

/* صفحة ① الصفحة الرئيسية — بطاقات مؤشرات Power BI (مباشرة من المحرّك) */
async function contractPbixCards(F = {}) {
  const model = await pbixModel(F);
  const m = pbix.measures(model, null);
  /* رصيد التغطية للذرة/الصويا/البذرة بالمطابقة الحرفية كما فى DAX:
     «الذرة» بلا تطويل لا تطابق شيئاً → BLANK ≥ 0 → LONG، تماماً كـ Power BI */
  const cov = name => numf(pbix.coreMeasures(model,
    model.reg.filter(r => String(r.classification) === name)).coverage);
  const arrow = v => (v >= 0 ? 'LONG' : 'SHORT');
  return {
    hedge_position: 'الذرة ' + arrow(cov('الذرة')) +
      '\nالصويا ' + arrow(cov('الصويا')) +
      '\nالبذرة ' + arrow(cov('البذرة')),
    /* لون موقف الربط من نفس قياس Power BI */
    hedge_color: m.hedge_color,
    /* الريت اليومى: سعر الإغلاق من بنك مصر فى البورصة للتاريخ المحدد فى فلتر التاريخ */
    daily_rate_sum: await (async () => {
      const f = F && F.from ? String(F.from).slice(0, 10) : '';
      const t = F && F.to ? String(F.to).slice(0, 10) : '';
      const from = f || '1900-01-01';
      const to = t || '2100-01-01';
      const rows = await all(`SELECT usd_rate FROM borse WHERE usd_rate IS NOT NULL AND borse_date >= $1 AND borse_date <= $2 ORDER BY borse_date DESC, id DESC LIMIT 1`, [from, to]);
      return rows && rows[0] ? r2(rows[0].usd_rate) : 0;
    })(),
    /* عدد مراكب الذرة = COUNTROWS(تسجيل_العقود) للذرة غير FINISH وغير انتهاء التفريغ */
    corn_vessels: numf(m.activeCornCount),
    /* قيمة المطلوب سداده = Sum of قيمة المطلوب سداده */
    docs_value: r2(m.sumRequiredValue),
  };
}

/* صفحة ② موقف ربط الخامات — تصنيف × مقاييس الربط */
async function contractHedgePosition(F = {}) {
  const cov = await contractCoverage(F);
  return cov.rows.map(r => ({
    cls: r.cls, paid_unpriced: r.paid_unpriced, remaining_open: r.remaining_open,
    factory: r.factory, coverage_balance: r.coverage_balance, position: r.position,
    contracts: r.contracts, days_enough: r.days_enough, hedged: r.hedged, contracted: r.contracted,
  })).sort((a, b) => Math.abs(b.contracted) - Math.abs(a.contracted));
}

/* صفحة ③ تقرير مراكب الذرة — تفصيل + ملخص + بطاقات (من محرّك Power BI) */
async function contractCornVessels(F = {}) {
  const model = await pbixModel(F);
  const corn = model.reg.filter(r => clsKey(r.classification).includes('ذره'));

  const rows = corn.map(r => {
    const priced = numf(r.hedge_sum) > 0;
    const paid = numf(r.pay_sum) > 0;
    return {
      source: r.source || '', supplier: r.supplier || '',
      quantity: r2(r.quantity), shipping: r.shipping_type || '', shipping_value: r2(r.shipping_value),
      pricing_status: priced ? 'مسعر' : 'بدون تسعير', cif: r2(r.expected_cif_price),
      vessel: r.vessel || '', payment_status: paid ? 'مسدد' : 'بدون سداد',
      expected_arrival: r.expected_arrival || '', vessel_status: r.vessel_status || '',
      net_premium: r2(pbix.netPremium(model, r)), arrival_month: r.month_ar || arMonthLabel(r.expected_arrival),
      max_bourse: r2(numf(r.avg_exchange)), final_net_premium: r2(pbix.finalNetPremium(model, r)),
    };
  }).sort((a, b) => (a.expected_arrival < b.expected_arrival ? 1 : -1));

  const bySource = new Map();
  rows.forEach(r => {
    const o = bySource.get(r.source) || { source: r.source, qty: 0, vessels: new Set() };
    o.qty += r.quantity; if (r.vessel) o.vessels.add(r.vessel);
    bySource.set(r.source, o);
  });
  const summary = [...bySource.values()].map(o => ({ source: o.source, qty: r2(o.qty), vessels: o.vessels.size }));
  const allVessels = new Set(rows.map(r => r.vessel).filter(Boolean));
  const cards = {
    corn_qty: r2(rows.reduce((s, r) => s + r.quantity, 0)),
    corn_vessels: allVessels.size,
    priced_qty: r2(rows.filter(r => r.pricing_status === 'مسعر').reduce((s, r) => s + r.quantity, 0)),
    position: r2(rows.reduce((s, r) => s + r.quantity, 0) - rows.filter(r => r.payment_status === 'مسدد').reduce((s, r) => s + r.quantity, 0)),
    priced_unpaid_qty: r2(rows.filter(r => r.pricing_status === 'مسعر' && r.payment_status !== 'مسدد').reduce((s, r) => s + r.quantity, 0)),
  };
  return { rows, summary, cards };
}

/* صفحة ④ تقرير قيمة المستندات — قيمة المطلوب سداده (من محرّك Power BI) */
async function contractDocsValue(F = {}) {
  const model = await pbixModel(F);
  const rows = model.reg.map(r => ({
    supplier: r.supplier || '', classification: r.classification || '',
    expected_payment: r.expected_payment_date || '', status: r.contract_status || '',
    to_pay_qty: r2(r.required_qty), cif_actual: r2(r.expected_cif_price),
    /* قيمة المطلوب سداده = سعر CIF متوقع × كمية المطلوب سداده (خام) */
    value: r2(r.required_value),
    pay_month: arMonthLabel(r.expected_payment_date),
  }));
  const agg = (keyOf, keyName) => {
    const m = new Map();
    rows.forEach(r => {
      const k = keyOf(r);
      const o = m.get(k) || { key: k, value: 0, qty: 0, lines: 0 };
      o.value += r.value; o.qty += r.to_pay_qty; o.lines += 1; m.set(k, o);
    });
    return [...m.values()].map(o => ({ [keyName]: o.key, value: r2(o.value), qty: r2(o.qty), lines: o.lines }))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  };
  const m = new Map();
  rows.forEach(r => {
    const k = r.classification || '(غير محدد)';
    const o = m.get(k) || { cls: k, months: new Map(), total: 0 };
    o.months.set(r.pay_month || '(غير محدد)', (o.months.get(r.pay_month || '(غير محدد)') || 0) + r.value);
    o.total += r.value; m.set(k, o);
  });
  const byClassMonth = [...m.values()].map(o => ({
    cls: o.cls, total: r2(o.total),
    months: [...o.months.entries()].map(([month, value]) => ({ month, value: r2(value) }))
      .sort((a, b) => a.month.localeCompare(b.month)),
  })).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  return { rows, byClass: agg(r => r.classification || '(غير محدد)', 'cls'), byMonth: agg(r => r.pay_month || '(غير محدد)', 'month'), byClassMonth };
}

/* صفحة ⑤ تكلفة الخامات المسعرة — أسعار وأرصدة لكل تصنيف */
async function contractPricedCosts(F = {}) {
  const cov = await contractCoverage(F);
  return cov.rows.filter(r => r.daily_rate || r.price_usd || r.market_price)
    .map(r => ({ cls: r.cls, daily_rate: r.daily_rate, price_usd: r.price_usd, current_cost: r.current_cost, market_price: r.market_price, diff: r.diff }))
    .sort((a, b) => Math.abs(b.current_cost) - Math.abs(a.current_cost));
}

/* صفحة ⑥ تغطية خامات رئيسية */
async function contractMainCoverage(F = {}) {
  const cov = await contractCoverage(F);
  return cov.rows.filter(r => r.kind === 'main')
    .map(r => ({
      cls: r.cls, factory: r.factory, port: r.port, paid_not_opened: r.paid_not_opened,
      to_pay: r.paid, contracted: r.contracted, sold: r.sold, balance: r.balance,
      consumption: r.consumption, days_enough: r.days_enough, enough_until: r.enough_until,
    })).sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
}

/* صفحة ⑦ تغطية الادوية والاضافات */
async function contractAdditivesCoverage(F = {}) {
  const cov = await contractCoverage(F);
  return cov.rows.filter(r => r.kind === 'additive')
    .map(r => ({
      cls: r.cls, balance: r.balance_raw, port_additions: r.port_additions,
      contract_additions: r.contract_additions, items_total: r.items_total,
      consumption: r.consumption, days_enough: r.available_days || r.days_enough, enough_until: r.enough_until,
    })).sort((a, b) => Math.abs(b.items_total) - Math.abs(a.items_total));
}


/* ---------- تحليل الحركات ---------- */




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
async function movementsReport(F = {}, by = 'detail', by2 = '', per = '', limit = 2000) {
  const wm = conds(F, MOV_COLS);
  const cte = movementsLiveCte(wm);
  const lim = Math.max(1, Math.min(Number(limit) || 2000, 20000));
  if (by === 'detail' && !by2 && !per) {
    const rows = await all(`${cte}
      SELECT item, item_desc, uom, direction, storage_loc, place,
             SUM(${LIVE_CNT})::int lines, SUM(${LIVE_QTY})::float qty,
             SUM(${LIVE_VAL})::float amount
        FROM live
       GROUP BY item, item_desc, uom, direction, storage_loc, place
       HAVING SUM(${LIVE_CNT}) > 0
       ORDER BY ABS(SUM(${LIVE_VAL})) DESC, direction, item
       LIMIT ${lim}`, wm.params);
    return { level: 'detail', label: 'تفصيلي', rows, removedNote: 'أرقام صافية بعد إسقاط حركات الإلغاء' };
  }
  const t = await movementsGroup(F, by === 'detail' ? 'item' : by, by2, per, lim);
  return { level: t.level, label: t.label, by2: t.by2, label2: t.label2, per: t.per, perLabel: t.perLabel, rows: t.rows,
    removedNote: 'أرقام صافية بعد إسقاط حركات الإلغاء' };
}
async function inventoryReport(F = {}, by = 'detail', by2 = '', per = '', limit = 20000) {
  const wb = conds(F, BAL_COLS);
  const lim = Math.max(1, Math.min(Number(limit) || 20000, 20000));
  const base = () => `SELECT COALESCE(NULLIF(b.item,''),'(بدون صنف)') item,
    MAX(COALESCE(NULLIF(i.descr,''),NULLIF(b.item_desc,''))) item_desc,
    COALESCE(MAX(NULLIF(i.uom,'')),'') uom,
    COALESCE(NULLIF(b.place,''),'(غير محدد)') place,
    COALESCE(NULLIF(b.storage_loc,''),'(بدون مخزن)') storage_loc,
    COALESCE(NULLIF(b.unit_code,''),'(بدون وحدة)') unit_code,
    COALESCE(NULLIF(l.company_code,''),'(بدون شركة)') company_code,
    SUM(b.open_qty)::float open_qty, SUM(b.close_qty)::float close_qty,
    SUM(b.open_val)::float open_val, SUM(b.close_val)::float close_val,
    MAX(${CLS_EXPR}) cls,
    MAX(${GRP_EXPR}) grp
  FROM balances b
  LEFT JOIN items i ON i.code = b.item
  LEFT JOIN locations l ON l.unit_code = b.unit_code
  ${wb.sql ? 'WHERE ' + wb.sql : ''}
  GROUP BY 1, 4, 5, 6, 7, i.class_desc, i.class_code, i.group_desc, i.group_code`;
  if (by === 'detail' && !by2 && !per) {
    const rows = await all(`${base()} ORDER BY ABS(SUM(b.close_val)) DESC LIMIT ${lim}`, wb.params);
    return { level: 'detail', label: 'تفصيلي', rows };
  }
  const t = await inventoryGroup(F, by === 'detail' ? 'item' : by, by2, per, lim);
  return { level: t.level, label: t.label, by2: t.by2, label2: t.label2, per: t.per, perLabel: t.perLabel, rows: t.rows };
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
  const creg = await get("SELECT MIN(NULLIF(contract_date,'')) a, MAX(NULLIF(contract_date,'')) b FROM contract_registrations");
  return {
    movements: [mov.a, mov.b], sales: [sal.a, sal.b], balances: [bal.a, bal.b],
    borse: [borse.a, borse.b], prices: [prices.a, prices.b], costs: [costs.a, costs.b],
    contracts: [creg.a, creg.b],
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

/** نافذة زمنية للرسم/السجل: نطاق تاريخ صريح (من/إلى) إن حُدِّد، وإلا «آخر N يوم» */
async function borseWindow(days, from, to) {
  const span = await get('SELECT MIN(borse_date) a, MAX(borse_date) b FROM borse');
  const min = span && span.a ? String(span.a) : null;
  const max = span && span.b ? String(span.b) : null;
  if (!min) return null;
  let f = from ? String(from) : '';
  let t = to ? String(to) : '';
  /* بلا نطاق صريح → نرجع لحدّ «آخر N يوم» كما كان */
  if (!f && !t) return { from: await borseCutoff(days), to: max };
  /* طرف واحد فقط → نكمل الطرف الآخر من حدّي البيانات */
  if (!f) f = min;
  if (!t) t = max;
  if (f > t) { const x = f; f = t; t = x; }
  return { from: f, to: t };
}

/** سلسلة الإغلاق اليومي لكل صنف ضمن فترة */
async function borseSeries({ days = 120, item = '', from = '', to = '' } = {}) {
  const w = await borseWindow(days, from, to);
  if (!w || !w.from) return [];
  return all(`
    SELECT borse_date, item, item_code, close, usd_rate
    FROM borse
    WHERE close IS NOT NULL AND borse_date >= $1 AND borse_date <= $2
      AND ($3 = '' OR item = $3 OR item_code = $3)
    ORDER BY borse_date`, [w.from, w.to, item || '']);
}

/** ريت الدولار اليومي المسجَّل */
async function borseUsd(days = 120, from = '', to = '') {
  const w = await borseWindow(days, from, to);
  if (!w || !w.from) return [];
  return all(`
    SELECT DISTINCT ON (borse_date) borse_date, usd_rate
    FROM borse WHERE usd_rate IS NOT NULL AND borse_date >= $1 AND borse_date <= $2
    ORDER BY borse_date`, [w.from, w.to]);
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

/** سجل التسجيلات اليومية (آخر الصفوف كما في الملف) — ويحترم نطاق تاريخ إن حُدِّد */
async function borseRecent(limit = 60, from = '', to = '') {
  const f = from ? String(from) : '';
  const t = to ? String(to) : '';
  if (!f && !t) {
    return all(`SELECT * FROM borse ORDER BY borse_date DESC, id DESC LIMIT $1`, [limit]);
  }
  if (f && !t) {
    return all(`SELECT * FROM borse WHERE borse_date >= $1 ORDER BY borse_date DESC, id DESC LIMIT $2`, [f, limit]);
  }
  if (!f && t) {
    return all(`SELECT * FROM borse WHERE borse_date <= $1 ORDER BY borse_date DESC, id DESC LIMIT $2`, [t, limit]);
  }
  return all(`SELECT * FROM borse WHERE borse_date >= $1 AND borse_date <= $2 ORDER BY borse_date DESC, id DESC LIMIT $3`, [f, t, limit]);
}

/* ================= تقرير موحّد: تسجيل العقود + تفصيلها في جدول واحد =================
   قراءة من الجداول نفسها بالـ LEFT JOIN — لا تكرار ولا اشتقاق:
   - «تجميعى» (افتراضي): صف لكل عقد (تسجيل) + عدد التفصيلات.
   - «تفصيلي»: صف لكل بند تفصيلي (حقول التسجيل + حقول التفصيل). */
async function contractUnified(F = {}) {
  const w = conds(F, { date: 'r.contract_date', cls: 'r.classification', item: 'r.internal_no' });
  const where = w.sql ? ' WHERE ' + w.sql : '';
  if (F.mode === 'detail') {
    return all(`SELECT r.internal_no, r.contract_date, r.classification, r.supplier,
        r.source_country, r.contracting_company, r.contract_no, r.quantity,
        r.expected_cif_price, r.expected_payment_date, r.contract_status,
        d.internal_company, d.external_company, d.detail_quantity, d.vessel_name,
        d.arrival_port, d.expected_arrival, d.operation_start, d.operation_end, d.vessel_status
      FROM contract_registrations r
      LEFT JOIN contract_details d ON d.internal_no = r.internal_no
      ${where}
      ORDER BY r.internal_no, d.id`, w.params);
  }
  return all(`SELECT r.internal_no, r.contract_date, r.classification, r.supplier,
      r.source_country, r.contracting_company, r.contract_no, r.quantity,
      r.expected_cif_price, r.expected_payment_date, r.contract_status,
      (SELECT COUNT(*) FROM contract_details d WHERE d.internal_no = r.internal_no)::int AS detail_lines
    FROM contract_registrations r ${where}
    ORDER BY r.internal_no`, w.params);
}

module.exports = {
  detectCostRule, costWhere, dateSpan,
  detectCostLink, setCostLink, profitCte, COST_LINKS,
  parseFilters, dims,
  salesDetail, salesDaily, salesGroup,
  movementsReport,
  movementsDetail, movementsGroup,
  inventoryReport,
  inventoryDetail, inventoryGroup,
  contractPbixCards, contractHedgePosition, contractCornVessels, contractDocsValue,
  contractPricedCosts, contractMainCoverage, contractAdditivesCoverage,
  contractUnified,
  borseLatest, borseSeries, borseUsd, borseSummary, borseRecent, borseCutoff,
};
