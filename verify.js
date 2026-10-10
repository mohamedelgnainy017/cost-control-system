'use strict';
/** تحقق: مقارنة أرقام النظام بالأرقام المعروفة من التحليل السابق لملفك */
const { all, get, info } = require('./src/db');
const A = require('./src/analytics');
const Q = require('./src/quality');

const n = v => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(v || 0));
const line = (k, v) => console.log(String(k).padEnd(44) + ' = ' + v);

(async () => {
  console.log('\nDB:', JSON.stringify(await info()));

  console.log('\n===== 1) العدّادات =====');
  for (const t of ['items', 'locations', 'movement_types', 'movements', 'sales', 'balances']) {
    line(t, n((await get(`SELECT COUNT(*)::int c FROM ${t}`)).c));
  }
  line('مصادر', (await all(`SELECT DISTINCT source_file FROM movements`)).map(r => r.source_file).join(' | ') || '—');

  console.log('\n===== 2) المؤشرات (overview) =====');
  const ov = await A.overview();
  line('قيمة المبيعات الموقّعة', n(ov.revenue));
  line('تكلفة المبيعات (cogs)', n(ov.cogs));
  line('مجمل الربح', n(ov.grossProfit));
  line('الهامش %', (ov.marginPct || 0).toFixed(2));
  line('قيمة افتتاحي / ختامي المخزون', n(ov.inventory.openVal) + ' / ' + n(ov.inventory.closeVal));
  line('قاعدة التكلفة', ov.costRule);
  line('عدد حركات التكلفة', n(ov.costLines));

  console.log('\n===== 3) المبيعات =====');
  line('صافي قيمة المبيعات (موقّعة)', n((await get('SELECT SUM(signed_value)::float s FROM sales')).s));
  line('عدد الفواتير', n((await get('SELECT COUNT(DISTINCT invoice_doc)::int c FROM sales')).c));
  const ccys = await all('SELECT ccy_net, COUNT(*)::int c, SUM(signed_value)::float v FROM sales GROUP BY 1 ORDER BY c DESC');
  line('العملات', ccys.map(r => `${r.ccy_net || 'فارغ'}: ${n(r.v)} (${n(r.c)})`).join(' | ') || '—');
  const cls = await all("SELECT doc_class||doc_status k, COUNT(*)::int c, SUM(signed_value)::float v FROM sales GROUP BY 1 ORDER BY c DESC");
  line('فئات المستند', cls.map(r => `${r.k}: ${n(r.v)}`).join(' | ') || '—');
  line('مجموعات بنود مكررة', n((await get(`SELECT COUNT(*)::int c FROM (SELECT invoice_doc,line_no,sale_doc,sale_line FROM sales GROUP BY 1,2,3,4 HAVING COUNT(*)>1) x`)).c));

  console.log('\n===== 4) الحركات — التوجيه =====');
  for (const r of await all(`SELECT direction, COUNT(*)::int c, SUM(amount)::float a FROM movements GROUP BY 1 ORDER BY ABS(COALESCE(SUM(amount),0)) DESC`)) {
    line('  ' + (r.direction || 'فارغ'), `${n(r.a)}  (${n(r.c)})`);
  }
  line('مؤشّر الحركة', (await all(`SELECT COALESCE(NULLIF(move_indicator,''),'(null)') k, COUNT(*)::int c, SUM(amount)::float a FROM movements GROUP BY 1 ORDER BY c DESC`))
    .map(r => `${r.k}: ${n(r.a)} (${n(r.c)})`).join(' | '));

  console.log('\n===== 5) المرجع المتوقع (تكلفة المبيعات = 5,209,905,382) =====');
  for (const [label, w] of [
    ["direction = 'الصادر'", `direction = 'الصادر'`],
    ["direction LIKE '%صادر%'", `direction LIKE '%صادر%'`],
    ["indicator = 'L'", `move_indicator = 'L'`],
    ["كل السالب", `amount < 0`],
    ["صادر وكمية سالبة", `direction LIKE '%صادر%' AND qty < 0`],
    ["أنواع 201/261/601", `move_type IN ('201','261','601','262','202')`],
  ]) {
    try {
      const a = await get(`SELECT COUNT(*)::int c, COALESCE(SUM(-amount),0)::float v FROM movements WHERE ${w} AND amount < 0`);
      const b = await get(`SELECT COUNT(*)::int c, COALESCE(SUM(amount),0)::float v FROM movements WHERE ${w}`);
      line('  ' + label, `سالب: ${n(a.v)} | صافي: ${n(b.v)} (${n(b.c)})`);
    } catch (e) { line('  ' + label, 'خطأ: ' + e.message); }
  }

  console.log('\n===== 6) المطابقة =====');
  const rec = await A.reconcile({ limit: 10, onlyMismatch: true });
  line('مفاتيح', n(rec.keys));
  line('مطابقة', n(rec.matched));
  line('غير مطابق', n(rec.mismatches));
  line('إجمالي الفرق', n(rec.totalDiff));

  console.log('\n===== 7) الجودة =====');
  const qi = await Q.runRules();
  for (const q of qi) line(`[${q.severity}] ${q.code}`, q.message.slice(0, 160));

  console.log('\n===== 8) تحليلات =====');
  const sp = await A.salesByPlace();
  line('أماكن البيع', sp.length ? sp.slice(0, 5).map(r => `${r.place}: ${n(r.value)} (ربح ${n(r.profit)} / ${r.marginPct.toFixed(1)}%)`).join(' | ') : '—');
  const md = await A.movementsByDirection();
  line('اتجاهات الحركة', md.length ? md.slice(0, 6).map(r => `${r.direction}: ${n(r.amount)}`).join(' | ') : '—');
  const mm = await A.movementsByMonth();
  line('أشهر الحركة', mm.length ? mm.slice(0, 4).map(r => `${r.ym}: ${n(r.net)}`).join(' | ') : '—');
  const ip = await A.inventoryByPlace();
  line('مخزون حسب المكان', ip.length ? ip.slice(0, 4).map(r => `${r.place}: ${n(r.close_val)}`).join(' | ') : '—');
  console.log('');
})().catch(e => { console.error('\n!!! خطأ:', e.message, '\n', e.stack); process.exit(1); });
