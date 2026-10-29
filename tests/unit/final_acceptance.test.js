'use strict';
/**
 * اختبار القبول النهائي — 12 بندًا (بيانات اصطناعية · بلا DB · بلا شبكة)
 * =========================================================================
 * 1) استكشاف مصدر وأعمدته   2) حفظ معادلة   3) تشغيل بمعادلة   4) عمود النتيجة
 * 5) نقل أعمدة التشغيل تلقائيًا   6) تقرير يعرض النتيجة   7) معاينة/حفظ/إعادة فتح
 * 8) مرجع المعادلة وإصدارها   9) استكشاف تقرير قديم   10) لا خلط بين التشغيلات
 * 11) لا اتصال بقاعدة البيانات   12) الوظائف السابقة سليمة (انحدار)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const guard = require('./_guard');
guard.install();

const CAT = require('../../src/data-catalog');
const FS = require('../../src/formula-store');
const FR = require('../../src/formula-resolver');
const W = require('../../src/workflow');
const RS = require('../../src/report-store');
const S = require('../../src/report-schema');
const SR = require('../../src/screen-registry');

const IDX = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const AN = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'analysis.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
const RD = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'report-designer.js'), 'utf8');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-final-'));

console.log('== اختبار القبول النهائي ==');

/* ---------- 1) استكشاف مصدر وأعمدته ---------- */
{
  const daily = CAT.getSource('daily_balances');
  chk(!!daily, 'مصدر daily_balances موجود في الفهرس');
  chk(daily.canonical === true, 'daily_balances هو المرجع المعتمد للأرصدة');
  chk(daily.fields.length >= 19 && daily.fields.some(f => f.name === 'close_qty'), 'أعمدة المصدر متاحة (names + types)');
  const derived = daily.fields.filter(f => f.origin === 'derived');
  chk(derived.length === 2 && derived.every(f => !!f.formula), 'الأعمدة المشتقة تحمل معادلتها الموثّقة');
  const list = CAT.listSources();
  chk(list.length >= 34, 'الفهرس يغطي جداول المشروع: ' + list.length + ' مصدرًا');
  const allDocs = list.filter(s => s.fields && s.fields.length);
  chk(allDocs.every(s => s.fields.every(f => f.name && f.type)), 'كل مصدر يحمل أسماء الأعمدة وأنواعها');
  chk(CAT.getSource('contract_balances').canonical !== true, 'contract_balances ليس المرجع المعتمد');
}

/* ---------- 2) اكتشاف معادلة موثّقة وحفظها بالطريقة المدعومة ---------- */
{
  const dir = path.join(tmp, 'formulas');
  const saved = FS.saveFormula({
    name: 'قيمة الصف', expr: 'MUL(qty, price)',
    fields: [{ name: 'qty', type: 'number' }, { name: 'price', type: 'number' }], origin: 'visual',
  }, dir);
  chk(!saved.error && !!saved.id, 'حفظ معادلة عبر مخزن السجل المدعوم');
  chk(FS.loadFormula(saved.id, dir).version === 1, 'المعادلة المحفوظة لها نسخة (version)');
  chk(!!(FS.saveFormula({ name: 'سيئة', expr: 'NOPE(a)' }, dir).error), 'المعادلة غير الصالحة مرفوضة');
  const ref = SR.listReports().find(r => r.key === 'pbix-home');
  chk(!!ref && ref.measures.length > 0, 'قاموس التقارير يوفّر المقاييس المعرَّفة');
}

/* ---------- 3) تشغيل تحليل يستخدم المعادلة + 4) عمود النتيجة ---------- */
let runResult = null, formulaId = null, formulaVer = null;
{
  const dir = path.join(tmp, 'formulas');
  const f = FS.saveFormula({ name: 'قيمة الصف', expr: 'MUL(qty, price)', fields: [{ name: 'qty' }, { name: 'price' }] }, dir);
  formulaId = f.id; formulaVer = f.formula.version;
  const columns = ['item', 'qty', 'price'];
  const rows = [{ item: 'A', qty: 3, price: 5 }, { item: 'B', qty: 2, price: 10 }];
  const wf = { name: 'قبول', source: { type: 'memory', name: 'synthetic' }, steps: [
    { id: 's1', type: 'select', columns },
    { id: 'c1', type: 'compute', newColumn: 'line_total', formulaId: formulaId, formulaVersion: formulaVer },
  ] };
  const resolved = FR.resolveWorkflowFormulas(wf, dir, { columns, rows });
  chk(resolved.workflow.steps[1].formula === 'MUL(qty, price)', 'المعادلة حُلَّت من السجل إلى تعبيرها');
  const out = W.executeWorkflow(resolved.workflow, { columns, rows });
  runResult = out;
  chk(out.ok === true, 'التشغيل نجح');
  chk((out.columns || []).includes('line_total'), 'عمود النتيجة ظهر');
  const vals = (out.rows || []).map(r => r.line_total);
  chk(vals.includes(15) && vals.includes(20), 'قيم عمود النتيجة صحيحة: ' + JSON.stringify(vals));
  chk(resolved.formulaVersions[formulaId] === formulaVer, 'نسخة المعادلة مرتبطة بالخطوة');
}

/* ---------- 5) نقل أعمدة التشغيل تلقائيًا إلى المصمم ---------- */
{
  chk(/loadReportColumnsForRun/.test(APP) && /loadReportColumnsForRun/.test(RD), 'دالة النقل موجودة في الطرفين');
  chk(/wf-send-to-report/.test(APP) && /await window\.loadReportColumnsForRun\(d\.runId\)/.test(APP),
    'زر «استخدمه في استوديو التقارير» يستدعي النقل');
  chk(/columns = \[\];\s*\n\s*rsTrace = null;/.test(RD), 'الأعمدة القديمة تُفرَّغ قبل الجلب');
}

/* ---------- 6) تقرير يعرض النتيجة + 7) معاينة/حفظ/إعادة فتح ---------- */
{
  const rep = {
    name: 'تقرير القبول', runId: 'run_final',
    components: [{ id: 'e1', type: 'kpi', label: 'إجمالي الصف', column: 'line_total', agg: 'sum' }],
  };
  const norm = S.normalizeReport(rep);
  chk(norm.components.length === 1 && norm.components[0].column === 'line_total', 'المكوّن يشير إلى عمود النتيجة');
  const dir = path.join(tmp, 'reports');
  const saved = RS.saveReport(rep, dir);
  chk(!saved.error, 'حفظ التقرير');
  const back = RS.loadReport(saved.id, dir);
  chk(back.components[0].column === 'line_total', 'إعادة الفتح تحتفظ بالعمود');
  const list = RS.listReports(dir);
  chk(list.some(r => r.id === saved.id), 'التقرير يظهر في القائمة');
  const v = S.validateReport(back);
  chk(v.ok === true, 'التقرير المحفوظ صالح');
}

/* ---------- 8) مرجع المعادلة وإصدارها في التقرير ---------- */
{
  const data = { columns: ['line_total'], rows: [{ line_total: 15 }], formulaColumns: { [formulaId]: 'line_total' }, formulaVersions: { [formulaId]: formulaVer } };
  const rep = { name: 'r', runId: 'run_final', components: [{ id: 'e1', type: 'kpi', label: 'x', column: 'line_total', agg: 'sum', formula: { id: formulaId, version: formulaVer } }] };
  const r = FR.resolveReportFormulas(rep, data);
  chk(r.errors.length === 0 && r.report.components[0].column === 'line_total', 'مرجع المعادلة يُحلّ إلى العمود المحسوب');
  const dir = path.join(tmp, 'reports');
  const saved = RS.saveReport(rep, dir);
  const back = RS.loadReport(saved.id, dir);
  chk(back.components[0].formula.id === formulaId && back.components[0].formula.version === formulaVer,
    'مرجع المعادلة ونسختها محفوظان ويُستعادان');
  const badVer = FR.resolveReportFormulas(rep, { ...data, formulaVersions: { [formulaId]: formulaVer + 1 } });
  chk(badVer.errors.length > 0, 'اختلاف النسخة ⇒ خطأ صريح (لا تفسير نتيجة قديمة)');
}

/* ---------- 9) استكشاف تقرير قديم + توضيح سبب التعذر ---------- */
{
  const reps = SR.listReports();
  chk(reps.length === 31, 'التقارير المسجَّلة: ' + reps.length);
  const withSource = reps.filter(r => r.source).length;
  chk(withSource >= 25, 'التقارير المرتبطة بمصدر: ' + withSource);
  chk(reps.every(r => r.key && r.label), 'كل تقرير له معرّف وعنوان');
  chk(/function reportGaps\(/.test(AN), 'المستكشف يوضّح ما ينقص في كل تقرير');
  chk(/probeLegacyImport/.test(RD) && /rs-legacy-cap/.test(IDX), 'فحص توفّر مسار الاستيراد معروض للمستخدم');
  chk(/data-open-report=/.test(AN), 'زر فتح تقرير قديم في المصمم');
}

/* ---------- 10) لا خلط بين التشغيلات ---------- */
{
  chk(/columns = \[\];/.test(RD), 'تفريغ الأعمدة قبل كل جلب');
  const idel = IDX.match(/id="([^"]+)"/g) || [];
  const names = idel.map(x => x.replace(/id="|"/g, ''));
  const dupes = [...new Set(names.filter((x, i) => names.indexOf(x) !== i))];
  chk(dupes.length === 0, 'لا معرّفات HTML مكرّرة (تشويش على الربط): ' + (dupes.join(',') || 'لا شيء'));
  const UIL = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'ui-layout.js'), 'utf8');
  chk(/it\.visible === false/.test(UIL) && /uiHiddenOrig/.test(UIL) && !/style\.display = ''/.test(UIL),
    'الإخفاء في تخطيط الواجهة لا يُلغي إخفاء الصلاحية (يستعيد القيمة الأصلية فقط)');
}

/* ---------- 11) لا اتصال بقاعدة البيانات ---------- */
{
  chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');
  chk(process.env.PGPORT === '1' || process.env.PGPORT === undefined, 'اختبار без أي مسار إلى PostgreSQL');
}

/* ---------- 12) الوظائف السابقة سليمة (عقد) ---------- */
{
  chk(/COMPONENT_TYPES/.test(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'report-schema.js'), 'utf8')), 'نموذج التقرير سليم');
  chk(/ALLOWED_COMPONENTS/.test(fs.readFileSync(path.join(__dirname, '..', '..', 'python', 'report_engine.py'), 'utf8')), 'محرك التصيير سليم');
  chk(/const DROPS/.test(APP) || /DROP_SUBS/.test(APP), 'آلية التنقل في الشريط سليمة');
  chk(/id="tab-platform"/.test(IDX) && /id="tab-report-studio"/.test(IDX) && /id="tab-analysis"/.test(IDX)
    && /id="tab-screen-studio"/.test(IDX) && !/id="tab-workflow"/.test(IDX),
    'أقسام المنصة الثلاثة موجودة بلا شاشة رابعة');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* مجلد اختبار */ }
console.log('\nfinal_acceptance.test.js — pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
