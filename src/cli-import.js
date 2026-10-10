'use strict';
const path = require('node:path');
const DB = require('./db');
const { importFile, analyzePreview } = require('./importer');

const args = process.argv.slice(2);
if (!args.length) {
  console.log('الاستخدام:');
  console.log('  node src/cli-import.js --preview <ملف.xlsx>');
  console.log('  node src/cli-import.js <ملف.xlsx> [--password=كلمة_المرور] [--only=sales,movements]');
  process.exit(1);
}
const file = args.find(a => !a.startsWith('--'));
const preview = args.includes('--preview');
const pwArg = args.find(a => a.startsWith('--password='));
const password = pwArg ? pwArg.split('=').slice(1).join('=') : undefined;
const onlyArg = args.find(a => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean) : undefined;
const asArg = args.find(a => a.startsWith('--as='));
const asSource = asArg ? asArg.slice('--as='.length) : undefined;
const filePath = path.resolve(file);

(async () => {
  try {
    if (preview) {
      const out = analyzePreview(filePath);
      for (const sh of out) {
        console.log(`\n=== شيت: ${sh.name} (${sh.ref}) ===`);
        for (const t of sh.tables) {
          console.log(`  [${t.label}]`);
          console.log(`    ${t.headers.join(' | ')}`);
        }
        if (!sh.tables.length) console.log('  (لا جدول معروف)');
      }
      return;
    }

    await DB.init();   // تجهيز المخطط (جداول جديدة قد تُضاف لاحقاً)
    console.log('جاري الاستيراد...');
    const t0 = Date.now();
    const res = await importFile(filePath, { password, only, asSource });
    const ms = Date.now() - t0;

    // تحديث إحصاءات المُخطط بعد كل استيراد حتى يبقى المخطط ثابت الدقة
    // مع النمو المستمر (بدون ANALYZE تتراجع خطط الاستعلام تدريجياً على الجداول الكبيرة)
    try { await DB.run('ANALYZE'); } catch (e) { console.error('تحذير ANALYZE: ' + e.message); }

    const inserted = (res.tables || []).reduce((s, t) => s + (t.rows || 0), 0);
    console.log(`تم خلال ${(ms / 1000).toFixed(1)} ثانية (${inserted} صف ≈ ${ms ? Math.round(inserted / (ms / 1000)) : 0} صف/ثانية)`);
    if (res.protected) console.log('! الملف محمي — تمت القراءة عبر Excel (COM)');
    console.log('الشيتات:');
    for (const s of res.sheets) console.log(`  - ${s.name}: ${s.rows} صف [${s.tables.join(' , ') || 'لم يُكتشف'}]`);
    console.log('الجداول المحمّلة:');
    for (const t of res.tables) {
      if (t.error) console.log(`  ✗ ${t.label}: خطأ - ${t.error}`);
      else console.log(`  ✓ ${t.label}: ${t.rows} صف${t.skipped ? ` (تم تجاوز ${t.skipped})` : ''}`);
    }
    for (const i of res.issues) console.log(`  ! ${i.message}`);
    try { process.stdout.write('#RESULT ' + JSON.stringify({ ok: true, ms, result: res }) + '\n'); } catch (_) {}
  } catch (e) {
    console.error('خطأ: ' + e.message);
    try { process.stdout.write('#RESULT ' + JSON.stringify({ ok: false, error: e.message }) + '\n'); } catch (_) {}
    process.exitCode = 1;
  } finally {
    // إغلاق اتصالات PostgreSQL فوراً — وإلا تبقى العملية معلّقة ~30 ثا بعد انتهاء الاستيراد
    try { await DB.pool.end(); } catch (_) {}
  }
})();
