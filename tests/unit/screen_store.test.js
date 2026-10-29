'use strict';
/**
 * مخزن الشاشات المخصّصة (src/screen-store.js) — اختبارات وحدة
 * ============================================================
 * مجلد مؤقت خارج المستودع ⇒ لا مساس بملفات data/ الأصلية.
 */
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('../../src/screen-store');
const AppScreen = require('../../src/app-screen');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

console.log('== مخزن الشاشات المخصّصة ==');

const DIR = path.join(os.tmpdir(), 'ccs_screens_test_' + Date.now().toString(36));
fs.mkdirSync(DIR, { recursive: true });

const def = {
  id: 'cs_store1',
  name: 'شاشة المخزون',
  desc: 'وصف مختصر',
  source: { runId: 'run_abc' },
  components: [{ id: 'c1', type: 'kpi', label: 'إجمالي', column: 'qty', agg: 'sum' }],
  inputs: [{ id: 'i1', type: 'select', column: 'item', op: '==' }],
  buttons: [{ id: 'b1', label: 'تحديث', action: { kind: 'refresh', id: 'refresh' } }],
};

/* ---------- الحفظ ---------- */
{
  const r = Store.saveScreen(def, DIR);
  chk(!r.error, 'الحفظ نجح: ' + (r.error || ''));
  eq_(r.id, 'cs_store1', 'المعرّف المُعاد');
  const file = path.join(DIR, 'cs_store1.json');
  chk(fs.existsSync(file), 'الملف أُنشئ داخل المجلد');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  eq_(raw.name, 'شاشة المخزون', 'الاسم محفوظ');
  eq_(raw.source.runId, 'run_abc', 'المصدر محفوظ');
  eq_(raw.components.length, 1, 'المكوّن محفوظ');
  eq_(raw.inputs.length, 1, 'المدخل محفوظ');
  eq_(raw.buttons.length, 1, 'الزر محفوظ');
  chk(!!raw.savedAt && !!raw.createdAt, 'تواريخ الإنشاء والحفظ موجودة');
}

/* ---------- الفتح ---------- */
{
  const s = Store.loadScreen('cs_store1', DIR);
  chk(!!s, 'الفتح نجح');
  eq_(s.components[0].column, 'qty', 'خصائص المكوّن محفوظة');
  eq_(Store.loadScreen('cs_missing', DIR), null, 'شاشة غير موجودة ⇒ null');
  eq_(Store.loadScreen('../../etc/passwd', DIR), null, 'معرّف غير آمن ⇒ null (لا خروج عن المجلد)');
}

/* ---------- القائمة ---------- */
{
  Store.saveScreen(Object.assign({}, def, { id: 'cs_store2', name: 'شاشة ثانية' }), DIR);
  const list = Store.listScreens(DIR);
  eq_(list.length, 2, 'القائمة تحتوي الشاشتين');
  const one = list.find(s => s.id === 'cs_store1');
  chk(!!one, 'الشاشة الأولى في القائمة');
  eq_(one.name, 'شاشة المخزون', 'اسم القائمة صحيح');
  eq_(one.components, 1, 'عدد المكوّنات في الملخّص');
  eq_(one.runId, 'run_abc', 'معرّف التشغيل في الملخّص');
  eq_(Store.listScreens(path.join(os.tmpdir(), 'ccs_no_dir_' + Date.now().toString(36))), [], 'مجلد غير موجود ⇒ قائمة فارغة');
}

/* ---------- رفض التعريفات غير الصالحة ---------- */
{
  const noName = Store.saveScreen({ id: 'cs_bad1', name: '' }, DIR);
  chk(!!noName.error, 'بلا اسم ⇒ رفض');
  const badId = Store.saveScreen({ id: 'bad_id', name: 'س' }, DIR);
  chk(!!badId.error, 'معرّف بلا بادئة cs_ ⇒ رفض');
  const reserved = Store.saveScreen({ id: 'dashboard', name: 'س' }, DIR);
  chk(!!reserved.error, 'معرّف محجوز (شاشة قائمة) ⇒ رفض');
  const reservedOpt = Store.saveScreen({ id: 'cs_ok1', name: 'س' }, DIR, { reservedIds: ['cs_ok1'] });
  chk(!!reservedOpt.error, 'معرّف محجوز صراحةً ⇒ رفض');
  const notObj = Store.saveScreen(null, DIR);
  chk(!!notObj.error, 'تعريف غير صالح ⇒ رفض');
}

/* ---------- الحفظ فوق تعريف موجود (تحديث بلا تكرار) ---------- */
{
  const before = fs.readdirSync(DIR).length;
  const r = Store.saveScreen(Object.assign({}, def, { name: 'اسم محدّث' }), DIR);
  chk(!r.error, 'التحديث نجح');
  eq_(fs.readdirSync(DIR).length, before, 'لا ملف مكرر بعد التحديث');
  eq_(Store.loadScreen('cs_store1', DIR).name, 'اسم محدّث', 'الاسم تحدّث');
}

/* ---------- النسخ ---------- */
{
  const r = Store.copyScreen('cs_store1', 'cs_copy1', DIR);
  chk(!r.error, 'النسخ نجح: ' + (r.error || ''));
  const c = Store.loadScreen('cs_copy1', DIR);
  chk(!!c, 'النسخة محفوظة');
  chk(c.name !== Store.loadScreen('cs_store1', DIR).name, 'النسخة باسم مختلف');
  eq_(c.components.length, 1, 'النسخة تحتفظ بمكوّناتها');
}

/* ---------- الحذف ---------- */
{
  chk(Store.deleteScreen('cs_copy1', DIR) === true, 'الحذف نجح');
  eq_(Store.loadScreen('cs_copy1', DIR), null, 'الملف حُذف');
  chk(Store.deleteScreen('cs_copy1', DIR) === false, 'حذف غير موجود ⇒ false');
  chk(Store.deleteScreen('../../x', DIR) === false, 'معرّف غير آمن ⇒ false');
}

/* ---------- ملف تالف ---------- */
{
  fs.writeFileSync(path.join(DIR, 'cs_broken.json'), '{ليس JSON', 'utf8');
  eq_(Store.loadScreen('cs_broken', DIR), null, 'ملف تالف ⇒ null (لا انهيار)');
  const list = Store.listScreens(DIR);
  chk(list.every(s => s.id !== 'cs_broken'), 'الملف التالف لا يظهر في القائمة');
}

function eq_(a, b, m) { chk(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

/* ---------- تنظيف ---------- */
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}

chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');
console.log('\nscreen_store.test.js — pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
