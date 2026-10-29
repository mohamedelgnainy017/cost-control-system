'use strict';
/**
 * اختبارات نموذج تعريف التقرير الموحّد (Report Schema) — معزولة تماماً
 * - لا قاعدة بيانات ولا شبكة (guard).
 * - تغطّي: التطبيع، التوافق مع التقارير القديمة، قائمة بيضاء النمط، تقييد التخطيط،
 *   الشروط، التحقق،|round-trip (حفظ/فتح) وعدم أثر التغييرات البصرية على الأرقام.
 */
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Schema = require('../../src/report-schema');
const RS = require('../../src/report-store');
const RB = require('../../src/report-bridge');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

console.log('== report schema (نموذج موحّد + توافق + أمان) ==');

/* ---------- 1) التعريفات الأساسية ---------- */
chk(Array.isArray(Schema.COMPONENT_TYPES) && Schema.COMPONENT_TYPES.includes('divider'),
  'أنواع المكونات تشمل الفاصل');
chk(Schema.GRID.columns === 12 && Schema.GRID.maxH === 6, 'الشبكة 12 عمودًا وارتفاع حتى 6');
chk(Schema.RULE_OPS.includes('>=') && Schema.RULE_OPS.length === 6, 'عمليات الشروط مسموحة ومحدودة');

/* ---------- 2) توافق مع التقارير القديمة (مسطّحة) ---------- */
{
  const legacy = {
    name: 'قديم', runId: 'run_1',
    components: [
      { type: 'kpi', label: 'إجمالي', column: 'amount', agg: 'sum', decimals: 2 },
      { type: 'table', columns: ['item', 'amount'], sort: 'amount', desc: true, limit: 25 },
      { type: 'bar', title: 'مخطط', category: 'item', value: 'amount', agg: 'sum', showTitle: false, xLabel: 'صنف', yLabel: 'قيمة' },
    ],
  };
  const norm = Schema.normalizeReport(legacy);
  chk(norm.components.length === 3, 'المكونات القديمة محفوظة');
  chk(norm.components[0].label === 'إجمالي' && norm.components[0].decimals === 2, 'مؤشر قديم: خصائصه كما هي');
  chk(norm.components[1].limit === 25 && norm.components[1].desc === true, 'جدول قديم: الترتيب والحد كما هي');
  chk(norm.components[2].showTitle === false && norm.components[2].xLabel === 'صنف', 'مخطط قديم: التسميات كما هي');
  chk(norm.components.every(c => !c.grid), 'المكوّن القديم بلا grid ⇒ يبقى بعرض كامل (توافق)');
  chk(norm.components.every(c => !c.style && !c.rules), 'لا خصائص نمط تُختلق للتقارير القديمة');
  chk(norm.version === 2 && norm.layout.columns === 12, 'التقرير المُطبَّع يحمل الإصدار والتخطيط');
  chk(Schema.validateReport(norm).ok, 'التقرير القديم يمر التحقق بعد التطبيع');
}

/* ---------- 3) قائمة بيضاء النمط (لا حقن CSS) ---------- */
{
  const s = Schema.normalizeStyle({
    bg: '#123456', color: 'rgb(10,20,30)', accent: '#abc', border: '1px solid #33415c',
    radius: 999, fontSize: 999, fontWeight: 'bold', align: 'center', padding: 999, shadow: true,
  });
  chk(s.bg === '#123456' && s.color === 'rgb(10,20,30)' && s.accent === '#abc', 'الألوان المقبولة تُحفظ');
  chk(s.border === '1px solid #33415c', 'الحد المقبول يُحفظ');
  chk(s.radius === 40 && s.fontSize === 72 && s.padding === 48, 'الأرقام تُقصَّر إلى الحدود');
  chk(s.fontWeight === 'bold' && s.align === 'center' && s.shadow === true, 'الوزن والمحاذاة والظل تُحفظ');

  const evil = Schema.normalizeStyle({
    bg: 'red; background-image:url(http://x/y)', color: 'expression(alert(1))',
    border: 'url(javascript:alert(1))', fontWeight: 'bolder; color:red', align: 'middle',
  });
  chk(!evil.bg && !evil.color && !evil.border, 'قيم النمط الخبيثة تُسقط بالكامل');
  chk(!evil.fontWeight && !evil.align, 'الوزن/المحاذاة غير المسموحتين تُسقط');
  chk(Object.keys(evil).length === 0, 'لا يتبقّى أي مفتاح بعد التنقية');
}

/* ---------- 4) تقييد التخطيط ---------- */
{
  chk(Schema.normalizeGrid({ w: 99, h: 99 }, 'kpi').w === 12, 'العرض يُقصَّر إلى 12');
  chk(Schema.normalizeGrid({ w: 0, h: 0 }, 'kpi').w === 1 && Schema.normalizeGrid({ w: 0, h: 0 }, 'kpi').h === 1, 'الحد الأدنى 1');
  chk(Schema.normalizeGrid({ w: 5, h: 3 }, 'kpi').h === 3, 'أبعاد صحيحة تُحفظ');
  chk(Schema.normalizeGrid(null, 'kpi') === null, 'بلا grid ⇒ null (لا تخطيط مفروض)');
  chk(Schema.defaultGrid('kpi').w === 3 && Schema.defaultGrid('table').w === 12, 'أحجام افتراضية حسب النوع');
}

/* ---------- 5) الشروط ---------- */
{
  const rules = Schema.normalizeRules([
    { column: 'amount', op: '>', value: 10, color: '#ff0000', bg: '#330000' },
    { column: 'amount', op: 'HACK', value: 5 },
    { op: '>' },
    'nope',
  ]);
  chk(rules.length === 2, 'الشروط غير الصالحة تُسقط (عمود مفقود / نوع غير صحيح)');
  chk(rules[1].op === '>', 'العملية غير المعروفة تُقصَّر إلى «>»');
  chk(rules[0].color === '#ff0000' && rules[0].bg === '#330000', 'ألوان الشرط تُحفظ');
  const many = Schema.normalizeRules(Array.from({ length: 30 }, () => ({ column: 'x', op: '>', value: 1 })));
  chk(many.length === 10, 'الحد الأقصى 10 شروط');
}

/* ---------- 6) التحقق من التقرير ---------- */
{
  const bad = Schema.validateReport({ name: '', components: [{ type: 'kpi' }] });
  chk(!bad.ok && bad.errors.some(e => /اسم/.test(e)), 'اسم مطلوب');
  chk(!bad.ok && bad.errors.some(e => /مؤشر/.test(e)), 'مؤشر بلا عنوان/عمود مرفوض');
  const badType = Schema.validateReport({ name: 'x', components: [{ type: 'evil' }] });
  chk(!badType.ok && /نوع غير معروف/.test(badType.errors.join(' ')), 'نوع مجهول مرفوض');
  const badGrid = Schema.validateReport({ name: 'x', components: [{ type: 'divider', grid: { w: 99, h: 99 } }] });
  chk(!badGrid.ok, 'أبعاد خارج الحدود مرفوضة');
  const okR = Schema.validateReport({ name: 'x', components: [{ type: 'divider' }] });
  chk(okR.ok, 'فاصل بلا حقول صالح');
  const notArr = Schema.validateReport({ name: 'x', components: 'nope' });
  chk(!notArr.ok, 'مكونات غير مصفوفة مرفوضة');
}

/* ---------- 7) round-trip: حفظ/فتح يحفظان الخصائص ---------- */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-schema-'));
  const def = Schema.normalizeReport({
    name: 'تصميم كامل', runId: 'run_9',
    source: { name: 'daily_balances', label: 'الأرصدة اليومية', runId: 'run_9', rowCount: 12 },
    layout: { columns: 12, gap: 16 },
    components: [
      { type: 'kpi', label: 'المجموع', column: 'amount', agg: 'sum', grid: { w: 4, h: 1 }, style: { bg: '#101a30', color: '#ffffff', radius: 16, shadow: true } },
      { type: 'table', columns: ['item'], grid: { w: 12, h: 2 }, rules: [{ column: 'amount', op: '>', value: 5, color: '#fb7185' }] },
      { type: 'divider', grid: { w: 12, h: 1 } },
    ],
  });
  const saved = RS.saveReport(def, tmp);
  chk(!saved.error, 'حفظ التعريف الكامل');
  const back = RS.loadReport(saved.id, tmp);
  chk(!!back, 'فتح التعريف');
  chk(back.components[0].style.bg === '#101a30' && back.components[0].style.radius === 16, 'النمط محفوظ');
  chk(back.components[0].grid.w === 4 && back.components[0].grid.h === 1, 'التخطيط محفوظ');
  chk(back.components[1].rules && back.components[1].rules[0].op === '>', 'الشروط محفوظة');
  chk(back.components[2].type === 'divider', 'نوع الفاصل محفوظ');
  chk(back.source && back.source.name === 'daily_balances', 'مصدر التقرير محفوظ');
  chk(back.layout.gap === 16, 'إعدادات شبكة التقرير محفوظة');
  const renorm = Schema.normalizeReport(back);
  chk(JSON.stringify(renorm.components) === JSON.stringify(Schema.normalizeReport(def).components),
    'التطبيع بعد الفتح يبقى ثابتًا (لا فقد ولا تحويل)');
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ---------- 8) النسخ ---------- */
{
  const c = Schema.newComponent('kpi', { id: 'e1', label: 'س', column: 'x' });
  const d = Schema.duplicateComponent(c, [c]);
  chk(!!d && d.id !== c.id, 'النسخة تحصل على معرّف جديد');
  chk(d.label === c.label && d.type === c.type, 'النسخة تحتفظ بالمحتوى');
  d.label = 'معدّل';
  chk(c.label === 'س', 'تعديل النسخة لا يمس الأصل');
}

/* ---------- 9) التغييرات البصرية لا تغيّر الأرقام ---------- */
(async () => {
  const rows = [{ item: 'A', amount: 10 }, { item: 'B', amount: 5 }];
  const cols = ['item', 'amount'];
  const base = { type: 'kpi', label: 'المجموع', column: 'amount', agg: 'sum' };
  const styled = Object.assign({}, base, { style: { bg: '#123456', color: '#fff', radius: 20, padding: 18 }, grid: { w: 3, h: 1 } });
  const r1 = await RB.renderReport({ name: 'a', components: [base] }, { columns: cols, rows });
  const r2 = await RB.renderReport({ name: 'b', components: [styled] }, { columns: cols, rows });
  chk(r1.ok && r2.ok, 'التصيير بنمط وبدون نمط يعمل');
  chk(r1.html.includes('15') && r2.html.includes('15'), 'الرقم نفسه في الحالتين (النمط لا يغيّر الأرقام)');
  chk(r2.html.includes('#123456') && r2.html.includes('border-radius:20px'), 'النمط مُطبَّق في المخرج');
  chk(r2.html.includes('grid-column:span 3'), 'التخطيط مُطبَّق في المخرج');

  /* قواعد التنسيق الشرطي: تلوين الصفوف المطابقة دون تغيير القيمة */
  const withRules = await RB.renderReport({
    name: 'c',
    components: [{ type: 'table', columns: ['item', 'amount'], rules: [{ column: 'amount', op: '>', value: 8, bg: '#330000' }] }],
  }, { columns: cols, rows });
  chk(withRules.ok && withRules.html.includes('#330000'), 'التنسيق الشرطي مُطبَّق');
  chk(withRules.html.includes('10') && withRules.html.includes('5'), 'قيم الصفوف لم تتغير');

  /* الفاصل */
  const div = await RB.renderReport({ name: 'd', components: [{ type: 'divider' }] }, { columns: cols, rows });
  chk(div.ok && div.html.includes('rep-divider'), 'الفاصل يُصيَّر');

  /* ورشة: تخطيط بلا grid يبقى بعرض كامل (توافق مع القديم) */
  const legacy = await RB.renderReport({ name: 'l', components: [{ type: 'kpi', label: 'x', column: 'amount', agg: 'sum' }] }, { columns: cols, rows });
  chk(legacy.html.includes('grid-column:span 12'), 'المكوّن القديم يبقى بعرض كامل');

  /* ---------- 10) تدقيق ساكن لواجهة المصمم والخادم ---------- */
  const idx = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  const rd = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'report-designer.js'), 'utf8');
  const srv = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
  chk(/<section id="tab-report-studio"/.test(idx), 'قسم مصمم التقارير موجود');
  chk(/id="rs-canvas"/.test(idx) && /id="rs-inspector"/.test(idx) && /id="rs-tabs"/.test(idx),
    'اللوحة + لوحة الخصائص موجودة');
  chk(/data-rt="data"/.test(idx) && /data-rt="layout"/.test(idx) && /data-rt="style"/.test(idx) && /data-rt="rules"/.test(idx),
    'أربعة تبويبات للخصائص (بيانات · تخطيط · نمط · شروط)');
  chk(/id="rs-add-divider"/.test(idx), 'زر إضافة الفاصل');
  chk(/<script src="\/report-schema\.js"><\/script>/.test(idx) && /<script src="\/report-designer\.js"><\/script>/.test(idx),
    'وسوم المخطط والمصمم محمَّلة');
  chk(/renderCanvas\(\)/.test(rd) && /grid-column:span /.test(rd), 'اللوحة ترسم العناصر على شبكة');
  chk(/draggable="true"/.test(rd) && /dragstart/.test(rd) && /drop/.test(rd), 'سحب لإعادة الترتيب');
  chk(/data-resize/.test(rd) && /startResize/.test(rd), 'مقبض تغيير العرض بالسحب');
  chk(/data-act="dup"/.test(rd), 'نسخ العنصر');
  chk(/id="rs-delete"/.test(idx) && /api\/reports\/delete/.test(rd), 'حذف التقرير');
  chk(/style\.bg|style\.color|style\.radius|style\.fontSize|style\.align|style\.padding|style\.border/.test(rd),
    'خصائص النمط قابلة للتحرير (خلفية · نص · زوايا · خط · محاذاة · حشو · حدود)');
  chk(/data-r="op"|data-r="column"|rs-add-rule/.test(rd), 'التنسيق الشرطي قابل للتحرير');
  chk(/window\.ReportSchema/.test(rd), 'المصمم يستعمل النموذج الموحّد');
  chk(!/\beval\s*\(/.test(rd) && !/new Function\s*\(/.test(rd), 'لا تنفيذ كود اعتباطي في المصمم');
  chk(/'GET \/report-schema\.js'/.test(srv), 'الخادم يقدّم المخطط للمتصفح');
  chk(/'POST \/api\/reports\/delete'/.test(srv), 'مسار حذف التقرير');
  chk(/Schema\.validateReport\(rep\)/.test(srv), 'الخادم يتحقق من النموذج قبل الحفظ');

  /* ---------- 11) تدقيق ساكن: لا استبدال صامت + الأخطاء تصل إلى المستخدم ---------- */
  const py = fs.readFileSync(path.join(__dirname, '..', '..', 'python', 'report_engine.py'), 'utf8');
  const bridge = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'report-bridge.js'), 'utf8');
  const srv2 = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
  chk(!/cols = \[c for c in columns\]\[:6\]/.test(py), 'المحرك: لا استبدال صامت للأعمدة المفقودة');
  chk(/def component_missing_columns/.test(py) && /def component_error_text/.test(py),
    'المحرك: فحص الأعمدة ورسالة خطأ صريحة');
  chk(/component_error_html\(comp, missing\)/.test(py), 'المحرك: المكوّن الفاشل يُعرض كخطأ لا كنتيجة');
  chk(/errors = \[\]/.test(py) && /"errors": errors/.test(py), 'المحرك: الأخطاء تُعاد مع النتيجة (لا تُخفى)');
  chk(/if \(Array\.isArray\(opts\.columns\)\)/.test(bridge), 'الجسر: التحقق يمرّر أعمدة البيانات');
  chk(/R\.validateReport\(rep, \{ columns \}\)/.test(srv2), 'الخادم: التحقق يaware بالأعمدة عبر runId');
  chk(/errorListHtml/.test(rd) && /r\.errors/.test(rd), 'الواجهة: أخطاء العناصر معروضة في المعاينة');
  chk(/comp-error/.test(py) && /rep-errors/.test(py), 'CSS/HTML: كتلة خطأ ولافتة علوية في المخرج');

  chk(guard.count() === 0, 'صفر اتصال (' + guard.count() + ')');
  console.log('\nreport_schema.test.js — pass=' + pass + ' fail=' + fail);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
