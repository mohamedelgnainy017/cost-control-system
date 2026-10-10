'use strict';
/**
 * قياس سرعة الإدراج المجمّع (insertBatch) على مخططات الحركات والمبيعات
 * - يولّد 40,000 صف اصطناعي لكل جدول (المعدل اليومي المتوقع تقريباً)
 * - يقارن الدفعة القديمة (2000) بالدفعة المحسّنة (أقصى حد آمن لوسائط PostgreSQL)
 * - قياس عادل: مساران بالتناوب مع VACUUM بينهما (يحيد أثر bloat/autovacuum)
 * - آمن 100%: كل الصفوف بوسم source_file='__bench__' وتُحذف بعد كل جولة
 * الاستخدام: node scripts/bench-insert.js
 */
const DB = require('../src/db');

const MOV_COLS = ['item','item_desc','uom','qty','supplier','move_type','move_indicator','post_date','doc_ref',
  'purchase_order','customer','descr','company_code','unit_code','storage_loc','amount','currency','group_code',
  'group_desc','ext_group_code','ext_group_desc','place','direction','source_row','import_id','source_file'];
const SALES_COLS = ['invoice_date','invoice_doc','line_no','qty','price_uom','fx_rate','net_value','ccy_net',
  'sale_doc','sale_line','item','item_desc','ref_doc','ref_line','unit_code','doc_class','doc_status',
  'beneficiary','tax','ccy_tax','credit_price','ccy_credit','subtotal','ccy_subtotal','raw_cost','ccy_cost',
  'place','signed_qty','signed_value','source_row','import_id','source_file'];

const TODAY = '2026-10-07';

/** يولّد صفوفاً بنوع كل عمود حسب اسمه (حتى لا تصل قيم نصية لحقول رقمية) */
function genRows(cols, n, tag) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const r = cols.map(name => {
      if (name === 'source_file') return '__bench__';
      if (name === 'source_row') return i + 1;
      if (name === 'import_id') return 1 + (i % 20);
      if (name === 'line_no' || name === 'sale_line' || name === 'ref_line') return Math.round(i % 997);
      if (/qty|amount|rate|tax|cost|price|credit|subtotal|value|fx_|net_/.test(name)) return ((i % 11) * 3.25 + i % 3);
      if (/date/.test(name)) return TODAY;
      if (/^(item|uom|ccy|currency|place)$/.test(name)) return tag + (i % 500);
      return name === 'doc_ref' || name === 'invoice_doc' || name === 'sale_doc' || name === 'ref_doc'
        ? 'DOC-' + String(i % 4000).padStart(5, '0')
        : 'قيمة-' + tag + '-' + i;
    });
    rows.push(r);
  }
  return rows;
}

/** جولة واحدة: تنظيف + VACUUM (خارج التوقيت) + إدراج مقاس + تنظيف */
async function runOnce(table, cols, rows, chunk) {
  await DB.run(`DELETE FROM ${table} WHERE source_file = '__bench__'`);
  await DB.run(`VACUUM (ANALYZE) ${table}`);
  const t0 = Date.now();
  const n = await DB.insertBatch(table, cols, rows, chunk);
  const ms = Date.now() - t0;
  const rps = ms ? Math.round(n / (ms / 1000)) : 0;
  await DB.run(`DELETE FROM ${table} WHERE source_file = '__bench__'`);
  return { ms, rps, n };
}

async function bench(table, cols, rows) {
  const adaptive = Math.max(500, Math.floor(64000 / cols.length));
  const configs = [[2000, 'قديمة'], [adaptive, 'محسنة'], [2000, 'قديمة'], [adaptive, 'محسنة']];
  const best = { 2000: Infinity, [adaptive]: Infinity };
  let i = 0;
  for (const [chunk, label] of configs) {
    i++;
    const { ms, rps, n } = await runOnce(table, cols, rows, chunk);
    if (ms < best[chunk]) best[chunk] = ms;
    console.log(`  ${table.padEnd(10)} جولة ${i} — الدفعة ${String(chunk).padStart(4)} (${label}) → ${n} صف في ${(ms / 1000).toFixed(2)} ثانية  ≈ ${rps.toLocaleString('en-US')} صف/ثانية`);
  }
  const gain = Math.round((1 - best[adaptive] / best[2000]) * 100);
  console.log(`  ↳ ${table}: أفضل 2000=${(best[2000] / 1000).toFixed(2)} ث · أفضل ${adaptive}=${(best[adaptive] / 1000).toFixed(2)} ث (${gain >= 0 ? 'أسرع' : 'أخطر بـ'} ${Math.abs(gain)}%)`);
}

(async () => {
  try {
    await DB.init();
    const MOV = genRows(MOV_COLS, 40000, 'BM');
    const SAL = genRows(SALES_COLS, 40000, 'BS');
    console.log(`قياس 40,000 صف لكل جدول — دفعة قديمة (2000) مقابل محسّنة (${Math.floor(64000 / MOV_COLS.length)} حركات / ${Math.floor(64000 / SALES_COLS.length)} مبيعات):`);
    await bench('movements', MOV_COLS, MOV);
    await bench('sales', SALES_COLS, SAL);
    console.log('اكتمل القياس — لا توجد بيانات متبقية (حُذف وسم __bench__).');
  } catch (e) {
    console.error('خطأ: ' + e.message);
    process.exitCode = 1;
  } finally {
    try { await DB.pool.end(); } catch (_) {}
  }
})();
