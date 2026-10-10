'use strict';
/**
 * قواعد جودة البيانات — تفحص الاستيراد وتسجل الملاحظات في جدول quality_issues
 * (كل القواعد التي كُشفت في تحليل ملفك الأصلي مُطبَّقة هنا تلقائياً)
 */
const { all, get, run, tx } = require('./db');

const RULES = [];

function rule(code, severity, title, fn) {
  RULES.push({ code, severity, title, fn });
}

/* ---------- القواعد ---------- */

rule('DUP_SALES_LINE', 'error', 'تكرار بنود المبيعات (نفس المستند والبند مكرر)', async () => {
  const rows = await all(`
    SELECT invoice_doc, line_no, sale_doc, sale_line, COUNT(*)::int c, SUM(signed_value) v
    FROM sales
    GROUP BY invoice_doc, line_no, sale_doc, sale_line
    HAVING COUNT(*) > 1`);
  if (!rows.length) return null;
  const dupRows = rows.reduce((s, r) => s + r.c, 0) - rows.length;
  const dupVal = rows.reduce((s, r) => s + r.v, 0);
  return {
    count: rows.length, dupRows,
    message: `${rows.length} مجموعة بنود مكررة (${dupRows} صف زائد) بإجمالي قيمة موقّعة ${fmt(dupVal)} — كل صف مكرر يضخّم المبيعات`,
    sample: rows.slice(0, 5).map(r => `${r.invoice_doc}/${r.line_no} ×${r.c}`),
  };
});

rule('MISSING_ITEM', 'error', 'أصناف غير موجودة في دليل الأصناف', async () => {
  const sales = await get(`SELECT COUNT(DISTINCT s.item)::int c FROM sales s LEFT JOIN items i ON i.code = s.item WHERE i.code IS NULL AND s.item <> ''`);
  const mov = await get(`SELECT COUNT(DISTINCT m.item)::int c FROM movements m LEFT JOIN items i ON i.code = m.item WHERE i.code IS NULL AND m.item <> ''`);
  const bal = await get(`SELECT COUNT(DISTINCT b.item)::int c FROM balances b LEFT JOIN items i ON i.code = b.item WHERE i.code IS NULL AND b.item <> ''`);
  const total = (sales.c || 0) + (mov.c || 0) + (bal.c || 0);
  if (!total) return null;
  const sample = await all(`SELECT s.item FROM sales s LEFT JOIN items i ON i.code = s.item WHERE i.code IS NULL AND s.item <> '' LIMIT 5`);
  return {
    count: total,
    message: `${total} كود صنف غير مسجَّل في دليل الأصناف (${sales.c} في المبيعات، ${mov.c} في الحركات، ${bal.c} في الأرصدة) — تقارير التصنيف ستستبعدها`,
    sample: sample.map(r => r.item),
  };
});

rule('NEG_BALANCE', 'error', 'أرصدة ختامية سالبة', async () => {
  const cnt = await get(`SELECT COUNT(*)::int c FROM balances WHERE close_qty < 0`);
  if (!cnt.c) return null;
  const rows = await all(`SELECT item, unit_code, storage_loc, close_qty FROM balances WHERE close_qty < 0 LIMIT 5`);
  return {
    count: cnt.c,
    message: `${cnt.c} صفاً برصيد كمي سالب في نهاية الفترة (خلل ترحيل أو تجميع تواريخ)`,
    sample: rows.map(r => `${r.item}@${r.storage_loc}=${r.close_qty}`),
  };
});

rule('NO_DATE', 'warning', 'حركات/مبيعات بدون تاريخ ترحيل', async () => {
  const m = await get(`SELECT COUNT(*)::int c FROM movements WHERE post_date IS NULL`);
  const s = await get(`SELECT COUNT(*)::int c FROM sales WHERE invoice_date IS NULL`);
  const total = m.c + s.c;
  if (!total) return null;
  return { count: total, message: `${total} صفاً بلا تاريخ (${m.c} حركة، ${s.c} فاتورة) لن تظهر في تقارير الفترات`, sample: [] };
});

rule('UNVALUED_MOVES', 'warning', 'حركات بكمية دون قيمة مالية', async () => {
  const cnt = await get(`SELECT COUNT(*)::int c FROM movements WHERE qty <> 0 AND COALESCE(amount, 0) = 0`);
  if (!cnt.c) return null;
  const sample = await all(`SELECT item, move_type, qty FROM movements WHERE qty <> 0 AND COALESCE(amount, 0) = 0 LIMIT 5`);
  return {
    count: cnt.c,
    message: `${cnt.c} حركة بكمية لكن مبلغها صفر — إما حركة غير مقيَّمة أو مركز تكلفة غير مرتبط (تؤثر على مطابقة المخزون)`,
    sample: sample.map(r => `${r.item} ${r.move_type} ${r.qty}`),
  };
});

rule('FX_ODD', 'warning', 'صفوف مبيعات بعملة أجنبية أو سعر صرف غير منطقي', async () => {
  const foreign = await get(`SELECT COUNT(*)::int c FROM sales WHERE COALESCE(ccy_net,'') <> '' AND ccy_net <> 'EGP'`);
  const odd = await get(`SELECT COUNT(*)::int c FROM sales WHERE fx_rate IS NOT NULL AND fx_rate > 0 AND (fx_rate < 0.5 OR fx_rate > 200)`);
  const total = foreign.c + odd.c;
  if (!total) return null;
  const sample = await all(`SELECT invoice_doc, ccy_net, fx_rate FROM sales
      WHERE (COALESCE(ccy_net,'') <> '' AND ccy_net <> 'EGP') OR (fx_rate > 0 AND (fx_rate < 0.5 OR fx_rate > 200))
      LIMIT 5`);
  return {
    count: total,
    message: `${foreign.c} صفاً بعملة غير جنيه + ${odd.c} صفاً بسعر صرف خارج النطاق المنطقي (1..200) — قاعدة التحويل في النموذج القديم كانت معطوبة (/10×سعر)`,
    sample: sample.map(r => `${r.invoice_doc} ${r.ccy_net} ${r.fx_rate}`),
  };
});

rule('COST_COL_EMPTY', 'info', 'عمود التكلفة في جدول المبيعات فارغ', async () => {
  const tot = await get(`SELECT COUNT(*)::int n, SUM(ABS(COALESCE(raw_cost,0)))::float s FROM sales`);
  if (!tot.n || tot.s > 0) return null;
  return {
    count: tot.n,
    message: `عمود «التكلفة» في المبيعات = 0 في كل الصفوف (${tot.n}) — التكلفة يجب احتسابها من حركات «تكلفة الوحدات المباعة» (مؤشر L) وليس من هذا العمود`,
    sample: [],
  };
});

rule('TAX_ZERO', 'info', 'ضريبة المبيعات مصفّرة (عمود غير معبّأ)', async () => {
  const tot = await get(`SELECT COUNT(*)::int n, SUM(ABS(COALESCE(tax,0)))::float s FROM sales`);
  if (!tot.n || tot.s > 0) return null;
  return { count: tot.n, message: `مبلغ الضريبة = 0 في كل الصفوف (${tot.n}) — لا يمكن الاعتماد عليه في الضرائب`, sample: [] };
});

rule('MULTI_CCY_SALES', 'warning', 'مبيعات مسجّلة بعملات متعددة (خلل محتمل في التحويل)', async () => {
  const rows = await all(`SELECT COALESCE(ccy_net,'(فارغ)') ccy, COUNT(*)::int c, SUM(signed_value) v
                          FROM sales GROUP BY 1 ORDER BY c DESC`);
  if (rows.length <= 1) return null;
  return {
    count: rows.length,
    message: `المبيعات مقسّمة على ${rows.length} عملات: ` + rows.map(r => `${r.ccy}=${fmt(r.v)}`).join(' ، '),
    sample: [],
  };
});

rule('ORPHAN_LOC', 'warning', 'حركات بوحدة غير موجودة في جدول المواقع', async () => {
  const cnt = await get(`SELECT COUNT(*)::int c FROM movements m WHERE m.unit_code <> '' AND m.place IS NULL`);
  if (!cnt.c) return null;
  const sample = await all(`SELECT DISTINCT unit_code FROM movements m WHERE m.unit_code <> '' AND m.place IS NULL LIMIT 5`);
  return {
    count: cnt.c,
    message: `${cnt.c} حركة برمز وحدة غير معرّف في جدول المواقع — لن تظهر في تقارير «المكان»`,
    sample: sample.map(r => r.unit_code),
  };
});

rule('ITEM_ORPHAN_MOVE', 'warning', 'حركات بصنف غير مصنّف (بلا مجموعة مواد)', async () => {
  const cnt = await get(`SELECT COUNT(DISTINCT item)::int c FROM movements WHERE COALESCE(group_code,'') = ''`);
  if (!cnt.c) return null;
  return { count: cnt.c, message: `${cnt.c} صنفاً بلا «مجموعة المواد» — تقارير التجميع ستستبعدها`, sample: [] };
});

rule('MULTI_SOURCE', 'info', 'مصادر بيانات متعددة محمّلة', async () => {
  const rows = await all(`SELECT source_file, COUNT(*)::int c FROM movements GROUP BY 1 ORDER BY c DESC`);
  if (rows.length <= 1) return null;
  return {
    count: rows.length,
    message: `${rows.length} ملفات مصادر للحركات: ` + rows.map(r => `${r.source_file || '؟'} (${fmt(r.c)})`).join(' ، '),
    sample: [],
  };
});

/* المرحلة 4: قاعدة المطابقة — رصيد نهاية اليوم = رصيد بداية اليوم التالي */
rule('BAL_CONTINUITY', 'error', 'استمرارية الأرصدة (نهاية سابق ≠ بداية لاحق)', async () => {
  const rows = await all(`
    WITH per AS (
      SELECT item, company_code, unit_code, storage_loc, balance_date,
             SUM(close_qty)::float cq, SUM(close_val)::float cv,
             SUM(open_qty)::float oq, SUM(open_val)::float ov
      FROM balances
      GROUP BY 1, 2, 3, 4, 5
    ), seq AS (
      SELECT *, LAG(balance_date) OVER w pd,
                LAG(cq) OVER w pcq, LAG(cv) OVER w pcv
      FROM per
      WINDOW w AS (PARTITION BY item, company_code, unit_code, storage_loc ORDER BY balance_date)
    )
    SELECT item, COALESCE(storage_loc, '') st, balance_date, pd, cq, oq, cv, ov, pcq, pcv
    FROM seq
    WHERE pd IS NOT NULL
      AND (ABS(cq - oq) > 0.001 OR ABS(cv - ov) > 0.5)
    ORDER BY ABS(cv - ov) DESC`);
  if (!rows.length) return null;
  const tot = rows.reduce((s, r) => s + Math.abs(r.cv - r.ov), 0);
  return {
    count: rows.length,
    message: `${rows.length} مفتاحاً تكسر فيه استمرارية الأرصدة بين يومين (نهاية سابق ≠ بداية لاحق) بإجمالي فرق قيمة ${fmt(tot)}`,
    sample: rows.slice(0, 5).map(r => `${r.item}${r.st ? '@' + r.st : ''} ${r.pd}→${r.balance_date}`),
  };
});

function fmt(n) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(n || 0));
}

/* ---------- التشغيل ---------- */

async function runRules() {
  const results = [];
  await tx(async () => {
    await run('DELETE FROM quality_issues');
    for (const r of RULES) {
      let out = null;
      try { out = await r.fn(); }
      catch (e) { out = { count: 0, message: 'تعذّر تنفيذ القاعدة: ' + e.message, error: true }; }
      if (!out) continue;
      await run('INSERT INTO quality_issues(code, severity, entity, message, details) VALUES($1,$2,$3,$4,$5)',
        [r.code, r.severity, r.title, out.message, JSON.stringify({ count: out.count, sample: out.sample || [] })]);
      results.push({ code: r.code, severity: r.severity, title: r.title, count: out.count, message: out.message, sample: out.sample || [] });
    }
  });
  return results;
}

async function listIssues(filter = {}) {
  const c = [], p = [];
  if (filter.sev) { p.push(filter.sev); c.push(`severity = $${p.length}`); }
  if (filter.ent) { p.push('%' + filter.ent + '%'); c.push(`entity ILIKE $${p.length}`); }
  return all(`SELECT * FROM quality_issues
              ${c.length ? 'WHERE ' + c.join(' AND ') : ''}
              ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, code`, p);
}

module.exports = { runRules, listIssues };
