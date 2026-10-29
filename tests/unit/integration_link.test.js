'use strict';
/**
 * اختبارات ربط المكونات: سجل المعادلات · المستكشف · تدفق التحليل · مصمم التقارير
 * =========================================================================
 * بيانات اصطناعية فقط · بلا DB · بلا شبكة (حارس) · مجلدات مؤقتة فقط.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const guard = require('./_guard');
guard.install();

const FS = require('../../src/formula-store');
const F = require('../../src/formulas');
const FR = require('../../src/formula-resolver');
const W = require('../../src/workflow');
const S = require('../../src/report-schema');
const RS = require('../../src/report-store');

const IDX = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const AN = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'analysis.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
const RD = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'report-designer.js'), 'utf8');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-link-'));

console.log('== اختبارات ربط المكونات ==');

/* ---------- أ) سجل المعادلات ---------- */
{
  const dir = path.join(tmp, 'formulas');
  const good = FS.saveFormula({
    name: 'صافي القيمة', expr: 'SUB(value, cost)',
    fields: [{ name: 'value', type: 'number' }, { name: 'cost', type: 'number' }],
  }, dir);
  chk(!good.error, 'حفظ معادلة صحيحة: ' + (good.error || good.id));
  const loaded = FS.loadFormula(good.id, dir);
  chk(!!loaded && loaded.expr === 'SUB(value, cost)' && loaded.version >= 1, 'المعادلة تُقرأ بنسختها');
  chk(Array.isArray(loaded.fields) && loaded.fields.length === 2, 'حقول المعادلة محفوظة');
  const list = FS.listFormulas(dir);
  chk(list.length === 1 && list[0].id === good.id, 'قائمة المعادلات تعرضها');

  /* بنية غير صحيحة ⇒ مرفوضة */
  const noName = FS.saveFormula({ expr: 'SUB(a,b)' }, dir);
  chk(!!noName.error, 'بدون اسم ⇒ مرفوضة');
  const noExpr = FS.saveFormula({ name: 'x' }, dir);
  chk(!!noExpr.error, 'بدون تعبير ⇒ مرفوضة');
  const badFn = FS.saveFormula({ name: 'x', expr: 'NOTAFUNCTION(a)' }, dir);
  chk(!!badFn.error, 'دالة غير موجودة ⇒ مرفوضة: ' + (badFn.error || '').slice(0, 60));
  chk(FS.listFormulas(dir).length === 1, 'المحاولات الفاشلة لم تُخزَّن');

  /* التعبير على بيانات اصطناعية بنتائج متوقعة */
  const ev = F.evaluateFormula('SUB(value, cost)', { value: 50, cost: 20 });
  chk(ev.ok && ev.value === 30, 'نتيجة التعبير صحيحة: ' + ev.value);
  const ev2 = F.evaluateFormula('MUL(qty, price)', { qty: 3, price: 5 });
  chk(ev2.value === 15, 'نتيجة الضرب صحيحة');
  /* القيم الفارغة */
  const nullRes = F.evaluateFormula('SUB(value, cost)', { value: null, cost: 20 });
  chk(nullRes.value === -20, 'SUB null-safe (null⇒0): ' + nullRes.value);
  const divZero = F.evaluateFormula('DIV(a, b)', { a: 10, b: 0 });
  chk(divZero.value === null && divZero.warnings.length > 0, 'القسمة على صفر ⇒ null + تحذير');
  const divNull = F.evaluateFormula('DIV(a, b)', { a: 10, b: null });
  chk(divNull.value === null, 'القسمة على قيمة فارغة ⇒ null');
  const coalesce = F.evaluateFormula('COALESCE(a, 0)', { a: null });
  chk(coalesce.value === 0, 'COALESCE يعوّض الفارغ');
  /* دالة المحرك ليست معادلة أعمال: التحقق يرفض التعبير المجرّد بلا سياق */
  chk(F.validateFormula('ABS(-5)').ok === true, 'تعبير الدوال صالح كقاعدة عامة');
  chk(F.validateFormula('SUB(a,b)').ok === true, 'تعبير ثنائي صالح');
  chk(F.validateFormula('SUM(a)').ok === false, 'دالة غير مسجَّلة (SUM) مرفوضة — المحرك لا يخلط الدوال بالقواعد');
}

/* ---------- ج) تدفق التحليل: معادلة محفوظة تُحسب فعلًا ---------- */
{
  const dir = path.join(tmp, 'formulas');
  const f = FS.saveFormula({
    name: 'صافي القيمة', expr: 'SUB(value, cost)',
    fields: [{ name: 'value', type: 'number' }, { name: 'cost', type: 'number' }],
  }, dir);
  const rows = [
    { item: 'A', value: 50, cost: 20 },
    { item: 'B', value: 10, cost: 4 },
  ];
  const columns = ['item', 'value', 'cost'];
  const wf = {
    name: 'تحليل تجريبي', source: { type: 'memory', name: 'synthetic' },
    steps: [
      { id: 's1', type: 'select', columns },
      { id: 'c1', type: 'compute', newColumn: 'net', formulaId: f.id, formulaVersion: 1 },
      { id: 'g1', type: 'groupBy', keys: ['item'], aggs: [{ fn: 'SUM', column: 'net', out: 'net_sum' }] },
    ],
  };
  const resolved = FR.resolveWorkflowFormulas(wf, dir, { columns, rows });
  chk(resolved.errors === undefined || resolved.errors.length === 0, 'حلّ المعادلة بلا أخطاء: ' + JSON.stringify(resolved.errors || []));
  chk(resolved.workflow.steps[1].formula === 'SUB(value, cost)', 'التعبير حُلَّ من السجل');
  chk(resolved.formulaVersions[f.id] === 1, 'نسخة المعادلة مرتبطة بالخطوة');
  const out = W.executeWorkflow(resolved.workflow, { columns, rows });
  chk(out.ok === true, 'تنفيذ التدفق نجح');
  const cols = out.columns || [];
  chk(cols.includes('net_sum'), 'عمود التجميع على العمود المحسوب ظهر: ' + cols.join(','));
  chk((out.trace || []).some(t => t.id === 'c1' && t.status === 'success'), 'خطوة الحساب نجحت (computed net)');
  const netVal = (out.rows || []).map(r => r.net_sum);
  chk(netVal.includes(30) && netVal.includes(6), 'قيم العمود المحسوب صحيحة: ' + JSON.stringify(netVal));

  /* معادلة تحتاج حقولًا غير موجودة ⇒ رسالة واضحة (لا تنفيذ صامت) */
  const missing = FR.resolveWorkflowFormulas({
    name: 'x', source: { type: 'memory', name: 'synthetic' },
    steps: [{ id: 'c1', type: 'compute', newColumn: 'n', formulaId: f.id }],
  }, dir, { columns: ['item'], rows: [{ item: 'A' }] });
  chk(missing.notes.length > 0 && /غير موجودة في البيانات/.test(missing.notes.join(' ')),
    'حقول ناقصة ⇒ ملاحظة صريحة: ' + (missing.notes[0] || '').slice(0, 70));
  chk(missing.workflow.steps[0].formula === undefined, 'لم يُنفَّذ التعبير بحقول ناقصة');
}

/* ---------- د) مصمم التقارير: مرجع المعادلة + الإصدارات ---------- */
{
  const dir = path.join(tmp, 'reports');
  const f = { name: 'صافي', expr: 'SUB(value, cost)', fields: [{ name: 'value' }, { name: 'cost' }] };
  const data = { columns: ['item', 'net'], rows: [{ item: 'A', net: 30 }], formulaColumns: { fml_1: 'net' }, formulaVersions: { fml_1: 1 } };
  const rep = {
    name: 'تقرير', runId: 'run_1', components: [
      { id: 'e1', type: 'kpi', label: 'الصافي', column: 'net', formula: { id: 'fml_1', version: 1 } },
    ],
  };
  const r1 = FR.resolveReportFormulas(rep, data);
  chk(r1.errors.length === 0, 'مرجع المعادلة يُحلّ بلا أخطاء');
  chk(r1.report.components[0].column === 'net', 'العمود المحسوب مربوط بالمكوّن');
  /* نسخة مختلفة ⇒ خطأ صريح (لا تفسير نتيجة قديمة) */
  const r2 = FR.resolveReportFormulas(
    { name: 'x', runId: 'run_1', components: [{ id: 'e1', type: 'kpi', column: 'net', formula: { id: 'fml_1', version: 2 } }] },
    { columns: ['net'], rows: [{ net: 1 }], formulaColumns: { fml_1: 'net' }, formulaVersions: { fml_1: 1 } });
  chk(r2.errors.length > 0 && /تختلف/.test(r2.errors.join(' ')), 'اختلاف نسخة المعادلة ⇒ خطأ صريح');
  /* معادلة غير مطبَّقة على هذا التشغيل ⇒ خطأ صريح */
  const r3 = FR.resolveReportFormulas(
    { name: 'x', runId: 'run_2', components: [{ id: 'e1', type: 'kpi', column: 'net', formula: { id: 'fml_9', version: 1 } }] },
    { columns: ['net'], rows: [{ net: 1 }], formulaColumns: {}, formulaVersions: {} });
  chk(r3.errors.length > 0 && /غير مطبَّقة/.test(r3.errors.join(' ')), 'مرجع غير مطبَّق ⇒ خطأ صريح');
  /* حفظ/إعادة فتح تقرير يحتفظ بمرجع المعادلة ونسختها */
  const saved = RS.saveReport(rep, dir);
  chk(!saved.error, 'حفظ التقرير');
  const back = RS.loadReport(saved.id, dir);
  chk(back.components[0].formula && back.components[0].formula.id === 'fml_1' && back.components[0].formula.version === 1,
    'مرجع المعادلة ونسختها محفوظان ويُستعادان');
  const norm = S.normalizeReport(back);
  chk(norm.components[0].formula && norm.components[0].formula.id === 'fml_1', 'التطبيع يحتفظ بمرجع المعادلة');
}

/* ---------- ب) المستكشف والفهرس ---------- */
{
  const ids = [...IDX.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const dupes = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
  chk(!dupes.includes('an-formulas') && !dupes.includes('an-savedFormulas'), 'معرّفات لوحات المستكشف فريدة');
  chk(IDX.includes('data-an="savedFormulas"'), 'تبويب المعادلات المحفوظة بمعرّف فريد');
  chk(!/data-an="formulas"[^>]*>المعادلات المحفوظة/.test(IDX), 'لم يعد هناك تبويب مكرّر');
  chk(/function renderSavedFormulas\(\)/.test(AN), 'دالة عرض المعادلات المحفوظة موجودة');
  chk(/function renderSources\(\)/.test(AN) && /function renderFormulas\(\)/.test(AN), 'دوال العرض قائمة');
  chk(/function columnKind\(/.test(AN) && /مشتق موثق/.test(AN) && /محسوب أثناء التشغيل/.test(AN) && /غير معروف/.test(AN),
    'تصنيف العمود يغطّي: أصلي · مشتق موثق · محسوب أثناء التشغيل · غير معروف');
  chk(/sourceColumnsBlock\(/.test(AN) && /an-cols/.test(AN), 'تفاصيل الأعمدة داخل لوحة المصادر (قابلة للطي)');
  chk(/canonicalNote/.test(AN) && /canonicalFor/.test(AN), 'تمييز المرجع المعتمد与非 المرجع');
  chk(/data-open-source=/.test(AN) && /data-open-report=/.test(AN), 'روابط الانتقال موجودة');
  chk(/openWorkflowForSource/.test(APP) && /openLegacyImport/.test(RD), 'الوجهة الحقيقية للروابط موجودة في المكوّنين');
  chk(/apiCall\('\/api\/formulas\/saved'\)/.test(AN), 'المستكشف يقرأ السجل المحفوظ');
  chk(!/renderSavedFormulas/.test(AN) || /function renderSavedFormulas/.test(AN), 'لا استدعاء لدالة غير معرَّفة');
}

/* ---------- د) التوصيل: الاستوديو ⇒ المصمم ---------- */
{
  chk(/ed-save-formula/.test(APP) && /saveStepFormula/.test(APP), 'حفظ المعادلة متاح داخل خطوة الحساب');
  chk(/apiCall\('\/api\/formulas\/save'/.test(APP), 'الحفظ عبر مسار السجل المشترك');
  chk(/loadReportColumnsForRun/.test(APP) && /loadReportColumnsForRun/.test(RD), 'التوصيل باستخدام دالة مشتركة');
  chk(/columns = \[\];/.test(RD), 'الأعمدة القديمة تُفرَّغ قبل جلب جديد (لا خلط بين تشغيلين)');
  chk(/rsFormulaCols/.test(RD) && /مرجع موثّق/.test(RD), 'المصمم يعرض حالة مرجع المعادلة');
  chk(/لا يوجد مرجع معادلة موثّق/.test(RD), 'حالة صريحة عند غياب المرجع');
}

chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* لا حذف لملفات المستخدم — هذا مجلد اختبار */ }
console.log('\nintegration_link.test.js — pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
