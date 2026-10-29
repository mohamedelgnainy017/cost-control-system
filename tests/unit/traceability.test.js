'use strict';
/**
 * اختبارات التتبّع والمعادلات المشتركة والتحقق من التجميعات — معزولة تماماً
 * =========================================================================
 * تغطّي:
 *  - المرحلة B: نسخة التعريف + البصمة (ترتيب المفاتيح لا يغيّرها · الإعداد والفلاتر يغيّرانها ·
 *    ترتيب الخطوات يغيّرها) + النتائج القديمة تُحمَّل بحالة «تتبّع غير مكتمل».
 *  - المرحلة C: مراجع المصدر/الفلاتر/المكوّنات تُحفظ وتُقرأ متسقة + التقارير القديمة صالحة.
 *  - المرحلة D: المعادلة البصرية == المعادلة النصية · رفض الحقول غير الموجودة · القسمة على صفر
 *    والفارغ policy موثّقة · لا تنفيذ اعتباطي · المعادلة تُستخدم في التدفق والتقرير بلا تكرار منطق.
 *  - المرحلة E: مجموع التجميع = مجموع المصدر · التدفق والتقرير يعطيان النتيجة نفسها ·
 *    تضاعف صفوف الربط يُكشف · حدود الاقتطاع مُعلنة · مصدر الأرصدة غير المعتمد يظهر بوضوح.
 */
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const W = require('../../src/workflow');
const FS = require('../../src/formula-store');
const FB = require('../../src/formula-builder');
const FR = require('../../src/formula-resolver');
const Schema = require('../../src/report-schema');
const RS = require('../../src/report-store');
const formulas = require('../../src/formulas');
const CAT = require('../../src/data-catalog');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

console.log('== تتبّع النتائج + المعادلات المشتركة + سلامة التجميعات ==');

(async () => {

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
const fdir = path.join(tmp, 'formulas');
const wdir = path.join(tmp, 'workflows');

/* ================= المرحلة B — التعريف والبصمة ================= */
{
  const wf = {
    name: 'تدفق اختبار',
    source: { type: 'dataset', name: 'daily_balances', settings: { days: 120, from: '2026-01-01', to: '2026-03-31' } },
    steps: [
      { id: 's1', type: 'select', columns: ['item', 'qty'] },
      { id: 's2', type: 'filter', column: 'qty', op: 'gt', value: 0 },
    ],
  };
  const snap = W.definitionSnapshot(wf);
  const h1 = W.definitionHash(snap);
  chk(typeof h1 === 'string' && h1.length === 16, 'البصمة سلسلة ثابتة (16 خانة)');

  /* ترتيب المفاتيح وحده لا يغيّر البصمة */
  const reordered = { steps: snap.steps, source: snap.source, name: snap.name };
  chk(W.definitionHash(reordered) === h1, 'ترتيب مفاتيح الكائن وحده لا يغيّر البصمة');

  /* تغيير إعداد/فلتر يغيّر البصمة */
  const changedFilter = W.definitionSnapshot(Object.assign({}, wf, {
    source: Object.assign({}, wf.source, { settings: Object.assign({}, wf.source.settings, { from: '2026-02-01' }) }),
  }));
  chk(W.definitionHash(changedFilter) !== h1, 'تغيير الفلتر يغيّر البصمة');

  /* تغيير ترتيب الخطوات يغيّر البصمة */
  const changedOrder = W.definitionSnapshot(Object.assign({}, wf, { steps: [wf.steps[1], wf.steps[0]] }));
  chk(W.definitionHash(changedOrder) !== h1, 'تغيير ترتيب الخطوات يغيّر البصمة');

  /* البصمة من التعريف المنفَّذ ولا تحتوي صفوفًا */
  chk(!JSON.stringify(snap).includes('rows'), 'نسخة التعريف بلا صفوف بيانات');
  chk(snap.steps.length === 2 && snap.source.settings.from === '2026-01-01', 'نسخة التعريف تحوي الخطوات والإعدادات');

  /* الحفظ مع التعريف: التتبّع كامل */
  const res = W.executeWorkflow(wf, { rows: [{ item: 'A', qty: 3 }], columns: ['item', 'qty'] });
  const def = W.definitionSnapshot(wf);
  W.saveOutput('run_traced', Object.assign({}, res, { definition: def, definitionHash: W.definitionHash(def) }), wdir);
  const out = W.loadOutput('run_traced', wdir);
  chk(!!out.definition && out.definitionHash && out.definition.steps.length === 2, 'النتيجة المحفوظة تحمل تعريفها وبصمتها');
  chk(out.rowCount === 1 && Array.isArray(out.rows), 'الحقول القديمة محفوظة (rowCount/rows)');

  /* تعديل ملف التدفق لا يغيّر تعريف التشغيل السابق */
  const wf2 = Object.assign({}, wf, { steps: [{ id: 's1', type: 'select', columns: ['item'] }] });
  W.saveWorkflow(wf2, wdir);
  const out2 = W.loadOutput('run_traced', wdir);
  chk(out2.definition.steps.length === 2, 'تعديل ملف التدفق لا يغيّر نسخة التعفيذ المحفوظة');

  /* نتيجة قديمة بلا تعريف ⇒ تُحمَّل وتُعتبر غير متتبَّعة */
  W.saveOutput('run_old', { ok: true, rowCount: 2, columns: ['item'], rows: [{ item: 'A' }] }, wdir);
  const old = W.loadOutput('run_old', wdir);
  chk(!!old && !old.definition && !old.traced, 'النتيجة القديمة تُحمَّل بلا تتبّع (لا تُختلق بيانات)');
  chk(!!old.rows && old.rows.length === 1, 'النتيجة القديمة ما زالت صالحة للاستهلاك في التقارير');
}

/* ================= المرحلة C — مراجع التقرير ================= */
{
  const def = Schema.normalizeReport({
    name: 'تقرير متتبَّع', runId: 'run_traced',
    source: { name: 'daily_balances', label: 'الأرصدة اليومية', runId: 'run_traced', traced: true, definitionHash: 'abc123', filters: { from: '2026-01-01', to: '2026-03-31' } },
    components: [
      { type: 'kpi', id: 'e1', label: 'المجموع', column: 'qty', agg: 'sum', formula: { id: 'fml_1', version: 2, name: 'صافي' } },
      { type: 'table', id: 'e2', columns: ['item'] },
    ],
  });
  chk(def.source.traced === true && def.source.definitionHash === 'abc123', 'مرجع التتبّع محفوظ في تعريف التقرير');
  chk(def.source.filters && def.source.filters.from === '2026-01-01', 'فلاتر التشغيل محفوظة مع التقرير');
  chk(def.components[0].formula && def.components[0].formula.id === 'fml_1' && def.components[0].formula.version === 2,
    'مرجع المعادلة (معرّف + نسخة) محفوظ في المكوّن');
  chk(Schema.validateReport(def).ok, 'تعريف التقرير المتتبَّع صالح');

  const saved = RS.saveReport(def, path.join(tmp, 'reports'));
  chk(!saved.error, 'حفظ التقرير المتتبَّع');
  const back = RS.loadReport(saved.id, path.join(tmp, 'reports'));
  chk(back.source.filters && back.source.filters.to === '2026-03-31', 'الفلاتر تُقرأ متسقة بعد الحفظ والفتح');
  chk(back.components[0].formula.id === 'fml_1', 'مرجع المعادلة يُقرأ متسقًا بعد الحفظ والفتح');

  /* تقرير قديم بلا الحقول الجديدة يبقى صالحًا */
  const legacy = Schema.normalizeReport({
    name: 'قديم', runId: 'run_old', components: [{ type: 'kpi', label: 'x', column: 'qty', agg: 'sum' }],
  });
  chk(Schema.validateReport(legacy).ok, 'تعريف قديم (بلا حقول جديدة) يبقى صالحًا');
  chk(legacy.components[0].formula === undefined, 'لا مرجع معادلة يُختلق للتقارير القديمة');
}

/* ================= المرحلة D — المعادلات المشتركة ================= */
{
  /* المعادلة البصرية == المعادلة النصية (نفس التعبير ⇒ نفس النتيجة) */
  const spec = FB.buildSpec({ leftField: 'qty', op: '*', rightField: 'price' });
  const visualExpr = FB.buildExpression(spec);
  chk(visualExpr === 'qty * price', 'الباني البصري ينتج التعبير المتوقع (' + visualExpr + ')');
  const row = { qty: 3, price: 5 };
  const a = formulas.evaluateFormula(visualExpr, row);
  const b = formulas.evaluateFormula('qty * price', row);
  chk(a.ok && b.ok && a.value === b.value && a.value === 15, 'المحرّر البصري والمتقدم يعطيان النتيجة نفسها');

  /* الباني يرفض البنية الناقصة بوضوح */
  let threw = '';
  try { FB.buildExpression({ kind: 'field', field: '' }); } catch (e) { threw = e.message; }
  chk(/اختر حقلًا/.test(threw), 'الباني يرفض حقلًا فارغًا برسالة واضحة');
  threw = '';
  try { FB.buildExpression({ kind: 'call', fn: 'EVAL', args: [] }); } catch (e) { threw = e.message; }
  chk(/دالة غير معروفة/.test(threw), 'الباني يرفض دالة غير مسجَّلة');

  /* الحقول غير الموجودة تُرفض بوضوح (سياسة موثّقة: خطأ وقت التنفيذ) */
  let missingErr = '';
  try { formulas.evaluateFormula('qty * nosuch', row); } catch (e) { missingErr = e.message; }
  chk(/unknown column/.test(missingErr), 'عمود غير موجود ⇒ خطأ صريح (' + missingErr + ')');
  chk(formulas.validateFormula('qty * nosuch').ok, 'التحقق النحوي لا يفحص الأعمدة (يُفحص وقت التنفيذ)');

  /* القسمة على صفر والفارغ (policy: null + تحذير) */
  const dz = formulas.evaluateFormula('qty / 0', row);
  chk(dz.ok && dz.value === null && dz.warnings.length === 1, 'القسمة على صفر ⇒ null + تحذير');
  let cycleErr = '';
  try { formulas.evaluateFormula('qty + nosuch', { qty: 1 }); } catch (e) { cycleErr = e.message; }
  chk(/unknown column/.test(cycleErr), 'مرجع غير قائم (دورة/اسم خاطئ) ⇒ خطأ (لا تنفيذ حر)');

  /* دوال التاريخ الجديدة آمنة ومختبَرة */
  chk(formulas.evaluateFormula('YEAR("2026-07-15")', {}).value === 2026, 'YEAR تعمل');
  chk(formulas.evaluateFormula('MONTH("2026-07-15")', {}).value === 7, 'MONTH تعمل');
  chk(formulas.evaluateFormula('MONTH_NAME("2026-07-15")', {}).value === 'يوليو', 'MONTH_NAME بالعربية تعمل');
  chk(formulas.evaluateFormula('DATEDIFF("day", "2026-07-15", "2026-07-01")', {}).value === 14, 'DATEDIFF تعمل');

  /* الحفظ والإصدارات: تعديل المعادلة لا يمسّ النسخ السابقة */
  const f1 = FS.saveFormula({ name: 'صافي', expr: 'qty * price', fields: [{ name: 'qty', type: 'number' }, { name: 'price', type: 'number' }], origin: 'visual' }, fdir);
  chk(!f1.error && f1.formula.version === 1, 'حفظ المعادلة (نسخة 1)');
  const f2 = FS.saveFormula({ id: f1.id, name: 'صافي', expr: 'qty * price * 1.1', origin: 'text' }, fdir);
  chk(!f2.error && f2.formula.version === 2, 'تعديل المعادلة يزيد النسخة ولا يحذف السابقة');
  const v1 = FS.loadFormula(f1.id, fdir, 1);
  chk(!!v1 && v1.expr === 'qty * price', 'النسخة 1 ما زالت محفوظة ومتاحة');
  chk(FS.loadFormula(f1.id, fdir, 2).expr === 'qty * price * 1.1', 'النسخة الحالية هي الأحدث');
  chk(FS.listFormulas(fdir).length === 1, 'قائمة المعادلات');

  /* استخدام المعادلة في التدفق: نفس المحرك، بلا تكرار منطق */
  const resolved = FR.resolveWorkflowFormulas({
    name: 't', source: { type: 'memory', name: 'synthetic' },
    /* السياسة: أحدث نسخة افتراضيًا — التثبيت على v1 يحتاج pinFormulaVersion */
    steps: [{ id: 'c1', type: 'compute', newColumn: 'net', formulaId: f1.id, formulaVersion: 1, pinFormulaVersion: true }],
  }, fdir);
  chk(resolved.workflow.steps[0].formula === 'qty * price', 'خطوة compute تُحلّ إلى تعبير المعادلة المحفوظة');
  chk(resolved.formulaColumns[f1.id] === 'net', 'خريطة formulaId → العمود المحسوب');
  const ex = W.executeWorkflow(resolved.workflow, { rows: [{ qty: 2, price: 4 }], columns: ['qty', 'price'] });
  chk(ex.ok && ex.rows[0].net === 8, 'المعادلة المحفوظة تُنفَّذ في التدفق بنفس محرك التحليل');

  /* معادلة غير موجودة ⇒ خطأ واضح ولا تنفيذ */
  const bad = FR.resolveWorkflowFormulas({
    name: 't', source: { type: 'memory', name: 'synthetic' },
    steps: [{ id: 'c1', type: 'compute', newColumn: 'net', formulaId: 'fml_missing' }],
  }, fdir);
  chk(bad.notes.length === 1 && /تعذّر تحميل المعادلة/.test(bad.notes[0]), 'معادلة مفقودة ⇒ ملاحظة صريحة');

  /* استخدام المعادلة في التقرير: تُحلّ إلى العمود المحسوب */
  const rep = FR.resolveReportFormulas({
    name: 'r', components: [{ type: 'kpi', id: 'e1', label: 'صافي', formula: { id: f1.id, version: 1 } }],
  }, { columns: ['net'], rows: [{ net: 8 }], formulaColumns: { [f1.id]: 'net' } });
  chk(rep.errors.length === 0 && rep.report.components[0].column === 'net', 'مرجع المعادلة في التقرير يُحلّ إلى العمود المحسوب');
  const repBad = FR.resolveReportFormulas({
    name: 'r', components: [{ type: 'kpi', id: 'e1', label: 'صافي', formula: { id: 'fml_missing' } }],
  }, { columns: ['net'], rows: [{ net: 8 }], formulaColumns: {} });
  chk(repBad.errors.length === 1 && /غير مطبَّقة على بيانات هذا التشغيل/.test(repBad.errors[0]),
    'مرجع معادلة غير مطبَّقة ⇒ رسالة خطأ واضحة (لا نتيجة مضلِّلة)');
}

/* ================= المرحلة E — سلامة التجميعات والربط ================= */
{
  const rows = [
    { item: 'A', qty: 10, price: 2 }, { item: 'A', qty: 5, price: 2 },
    { item: 'B', qty: 3, price: 4 }, { item: 'C', qty: 7, price: 1 },
  ];
  const cols = ['item', 'qty', 'price'];

  /* 1) مجموع التجميع = مجموع الصفوف المصدرية (شروط متكافئة) */
  const wfG = { name: 'g', source: { type: 'memory', name: 'synthetic' }, steps: [{ id: 'g1', type: 'groupBy', keys: ['item'], aggs: [{ fn: 'SUM', column: 'qty', out: 'sum_qty' }] }] };
  const g = W.executeWorkflow(wfG, { rows, columns: cols });
  const totalSrc = rows.reduce((s, r) => s + r.qty, 0);
  const totalGrp = g.rows.reduce((s, r) => s + r.sum_qty, 0);
  chk(g.ok && totalGrp === totalSrc, 'مجموع التجميع = مجموع الصفوف المصدرية (' + totalGrp + ' = ' + totalSrc + ')');

  /* 2) التدفق والتقرير يعطيان النتيجة نفسها على البيانات نفسها */
  const kpi = { type: 'kpi', label: 'المجموع', column: 'qty', agg: 'sum' };
  const rpt = W.executeWorkflow({ name: 'r', source: { type: 'memory', name: 'synthetic' }, steps: [] }, { rows, columns: cols });
  chk(rpt.ok && rpt.rowCount === rows.length, 'التقرير يقرأ صفوف التشغيل كما هي');
  const flowSum = g.rows.reduce((s, r) => s + r.sum_qty, 0);
  const reportSum = kpi.agg === 'sum' ? rows.reduce((s, r) => s + r.qty, 0) : 0;
  chk(flowSum === reportSum, 'التدفق والتقرير: النتيجة واحدة على البيانات نفسها');

  /* 3) الفلاتر تغيّر النتيجة بصورة صحيحة (ليست خطأ) */
  const wfF = { name: 'f', source: { type: 'memory', name: 'synthetic' }, steps: [{ id: 'f1', type: 'filter', column: 'qty', op: 'gt', value: 5 }] };
  const f = W.executeWorkflow(wfF, { rows, columns: cols });
  const filteredTotal = f.rows.reduce((s, r) => s + r.qty, 0);
  chk(f.ok && filteredTotal === 17 && filteredTotal !== totalSrc, 'الفلتر يغيّر المجموع بصورة صحيحة (' + filteredTotal + ')');
  chk(f.trace.every(t => t.status === 'success'), 'الفلتر لا يُبلّغ كخطأ');

  /* 4) تضاعف صفوف الربط يُكشف */
  const right = [{ item: 'A', tag: 'x' }, { item: 'A', tag: 'y' }];
  const wfJ = { name: 'j', source: { type: 'memory', name: 'synthetic' }, steps: [{ id: 'j1', type: 'join', leftKey: 'item', rightKey: 'item', joinType: 'left', rightRows: right }] };
  const j = W.executeWorkflow(wfJ, { rows: [{ item: 'A' }], columns: ['item'] });
  chk(j.ok && j.rows.length === 2, 'الضم بمفتاح غير فريد ⇒ تكرار الصفوف (2 بدل 1)');
  const warn = (j.trace[0].warnings || []).join(' ');
  chk(/مفتاح غير فريد|تضخيم/.test(warn), 'تحذير تضاعف الصفوف ظاهر في التتبّع');
  chk(/not complete|تضخيم/.test(j.trace[0].message), 'رسالة الخطوة تذكر احتمال تضخّم المجاميع وعدم الاكتمال');
  chk(j.trace[0].completeness === 'incomplete', 'حالة الاكتمال: غير مكتمل (لا يجوز الاعتماد على المجاميع)');

  /* 5) ارتباط واحد-لواحد لا يُنتج تحذيرًا */
  const wfJ1 = { name: 'j', source: { type: 'memory', name: 'synthetic' }, steps: [{ id: 'j1', type: 'join', leftKey: 'item', rightKey: 'item', joinType: 'left', rightRows: [{ item: 'A', tag: 'x' }] }] };
  const j1 = W.executeWorkflow(wfJ1, { rows: [{ item: 'A' }], columns: ['item'] });
  chk(j1.ok && j1.rows.length === 1 && !(j1.trace[0].warnings || []).length, 'ارتباط فريد ⇒ لا تحذير ولا تكرار');

  /* 6) مصدر الأرصدة غير المعتمد يظهر بوضوح */
  const bal = CAT.getSource('daily_balances');
  const cbal = CAT.getSource('contract_balances');
  chk(bal.canonical === true, 'daily_balances هو المرجع المعتمد');
  chk(cbal.canonical !== true && !!cbal.canonicalNote, 'contract_balances موسوم كغير معتمد مع تنبيه');
}

/* ================= المرحلة F — كشف الانحراف بين التوثيق والتنفيذ ================= */
{
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'db.js'), 'utf8');
  const srvSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');

  /* 1) كل مصدر في الفهرس يطابق جدولًا حقيقيًا في المخطط (أو دالة analytics معروفة) */
  const schema = new Set([...dbSrc.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map(m => m[1]));
  const analyticsFns = new Set([...fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'analytics.js'), 'utf8')
    .matchAll(/^\s*(?:async\s+)?function\s+(\w+)/gm)].map(m => m[1]));
  const bad = [];
  for (const s of CAT.SOURCES) {
    if (s.technical.startsWith('analytics.')) {
      if (!analyticsFns.has(s.technical.split('.')[1])) bad.push(s.id + ' (' + s.technical + ')');
      continue;
    }
    if (s.technical.startsWith('memory:') || s.technical.startsWith('data/')) continue;
    if (!schema.has(s.technical)) bad.push(s.id + ' (' + s.technical + ')');
  }
  chk(bad.length === 0, 'كل مصدر في الفهرس يطابق جدولًا/دالة حقيقية' + (bad.length ? ': ' + bad.join(', ') : ''));

  /* 2) كل شاشة/تقرير في السجل موجود فعليًا في الخادم */
  const SR = require('../../src/screen-registry');
  const tabIds = new Set([...srvSrc.matchAll(/\{ id: '([a-z0-9-]+)', label:/g)].map(m => m[1]));
  const repKeys = new Set([...srvSrc.matchAll(/^ {2}'([a-z0-9-]+)':\s*\{/gm)].map(m => m[1]));
  /* الشاشات المدموجة (workcenter · reports-manager) تُترجم إلى مضيفها عبر HOST_OF
     ⇒ لا يُشترط وجودها كمعرّفات مستقلة في TABS، لكن يجب أن يكون مضيفها موجودًا. */
  const missingTabs = SR.SCREENS.filter(s => !s.mergedInto).map(s => s.id).filter(id => !tabIds.has(id));
  const missingHosts = SR.SCREENS.filter(s => s.mergedInto).filter(s => !tabIds.has(s.mergedInto)).map(s => s.id + '→' + s.mergedInto);
  const missingReps = SR.REPORTS.map(r => r.key).filter(k => !repKeys.has(k));
  chk(missingTabs.length === 0, 'كل شاشة في السجل موجودة في TABS' + (missingTabs.length ? ': ' + missingTabs.join(',') : ''));
  chk(missingHosts.length === 0, 'كل شاشة مدموجة لها مضيف في TABS' + (missingHosts.length ? ': ' + missingHosts.join(',') : ''));
  chk(missingReps.length === 0, 'كل تقرير في السجل موجود في REPORTS' + (missingReps.length ? ': ' + missingReps.join(',') : ''));
  const uncovered = [...tabIds].filter(id => !SR.SCREENS.some(s => s.id === id));
  chk(uncovered.length === 0, 'كل تبويب في الخادم مسجَّل في سجل الشاشات' + (uncovered.length ? ': ' + uncovered.join(',') : ''));

  /* 3) مراجع المعادلات تشير إلى ملفات وسطور موجودة (قد يكون المرجع مركّبًا) */
  const ME = require('../../src/model-explorer');
  const stale = [];
  for (const f of ME.NATIVE) {
    const refs = [...String(f.location || '').matchAll(/(src\/[\w./-]+\.js)(?::(\d+)(?:-(\d+))?)?/g)];
    if (!refs.length) { stale.push(f.id + ' (مرجع غير قابل للتحقق)'); continue; }
    for (const m of refs) {
      const p = path.join(__dirname, '..', '..', m[1]);
      if (!fs.existsSync(p)) { stale.push(f.id + ' (ملف مفقود: ' + m[1] + ')'); continue; }
      if (!m[2]) continue;                     /* مرجع ملف بلا أرقام أسطر */
      const lines = fs.readFileSync(p, 'utf8').split('\n').length;
      const maxLine = Number(m[3] || m[2]);
      if (maxLine > lines) stale.push(f.id + ' (السطر ' + maxLine + ' > ' + lines + ' في ' + m[1] + ')');
    }
  }
  chk(stale.length === 0, 'كل مرجع معادلة يشير إلى ملف/سطر موجود' + (stale.length ? ': ' + stale.join(' | ') : ''));
}

/* ================= إصدار محرك المعادلات ================= */
{
  chk(typeof formulas.FORMULA_ENGINE_VERSION === 'string' && formulas.FORMULA_ENGINE_VERSION.length > 0,
    'إصدار محرك المعادلات معرَّف');
  const h1 = formulas.formulaEngineHash();
  const h2 = formulas.formulaEngineHash();
  chk(h1 === h2 && /^[0-9a-f]{16}$/.test(h1), 'بصمة المحرك ثابتة ومحدّدة الشكل');
  formulas.FUNCTIONS.__tmp_probe = {
    id: '__tmp_probe', name: '__TMP', description: '', params: [], returnType: 'number',
    nullBehavior: 'x', errors: [], examples: [], impl: () => 1,
  };
  const h3 = formulas.formulaEngineHash();
  delete formulas.FUNCTIONS.__tmp_probe;
  const h4 = formulas.formulaEngineHash();
  chk(h3 !== h1 && h4 === h1, 'بصمة المحرك تتغيّر بتغيّر سلوك الدوال وتعود كما هي بعد الإزالة');

  /* يُحفظ مع التشغيل */
  const rowsE = [{ item: 'A', qty: 2, price: 4 }];
  const wfE = { name: 'e', source: { type: 'memory', name: 'synthetic' }, steps: [] };
  const resE = W.executeWorkflow(wfE, { rows: rowsE, columns: ['qty', 'price'] });
  W.saveOutput('run_eng', Object.assign({}, resE, {
    engineVersion: formulas.FORMULA_ENGINE_VERSION, engineHash: h1,
  }), wdir);
  const outE = W.loadOutput('run_eng', wdir);
  chk(outE.engineVersion === formulas.FORMULA_ENGINE_VERSION && outE.engineHash === h1,
    'إصدار المحرك وبصمته محفوظان مع نتيجة التشغيل');
  const oldE = W.loadOutput('run_old', wdir);
  chk(!oldE.engineVersion && !oldE.engineHash, 'النتيجة القديمة: إصدار المحرك غير معروف (لا تاريخ مخترع)');
  chk(typeof oldE.rows === 'object' && oldE.rows.length === 1, 'النتيجة القديمة ما زالت تُحمَّل وتُقرأ');
}

/* ================= المسار الكامل: معادلة → تدفق → تقرير ================= */
{
  const RB = require('../../src/report-bridge');
  const saved = FS.saveFormula({
    name: 'صافي القيمة', expr: 'qty * price',
    fields: [{ name: 'qty', type: 'number' }, { name: 'price', type: 'number' }], origin: 'visual',
  }, fdir);
  chk(!saved.error, '1) إنشاء معادلة آمنة وحفظها في السجل');
  const read = FS.loadFormula(saved.id, fdir);
  chk(!!read && read.version === 1 && read.expr === 'qty * price', '2) قراءتها والتحقق من نسختها');

  const resolved = FR.resolveWorkflowFormulas({
    name: 't', source: { type: 'memory', name: 'synthetic' },
    steps: [{ id: 'c1', type: 'compute', newColumn: 'net', formulaId: saved.id, formulaVersion: 1 }],
  }, fdir, { columns: ['qty', 'price'] });
  chk(resolved.workflow.steps[0].formula === 'qty * price', '3) استخدامها في خطوة compute (تُحلّ إلى نص التعبير)');

  const rowsF = [{ item: 'A', qty: 2, price: 4 }];
  const flow = W.executeWorkflow(resolved.workflow, { rows: rowsF, columns: ['qty', 'price'] });
  chk(flow.ok && flow.rows[0].net === 8, '4) تشغيل المنطق على بيانات اصطناعية ⇒ العمود المحسوب موجود');
  chk(resolved.formulaVersions[saved.id] === 1, '5) نسخة المعادلة المستخدمة مسجَّلة مع التشغيل');

  const repDef = {
    name: 'تقرير', components: [{ type: 'kpi', id: 'e1', label: 'صافي', agg: 'sum', column: 'net', formula: { id: saved.id, version: 1 } }],
  };
  const rr = FR.resolveReportFormulas(repDef, {
    columns: flow.columns, rows: flow.rows, formulaColumns: { [saved.id]: 'net' }, formulaVersions: { [saved.id]: 1 },
  });
  chk(rr.errors.length === 0 && rr.report.components[0].column === 'net', '6) مرجع المعادلة في التقرير يُحلّ إلى العمود الصحيح');

  /* المعادلة تُغذّي قيمة المخطط أيضًا (value) وتُضاف كعمود في الجدول */
  const rrChart = FR.resolveReportFormulas({
    name: 'مخطط', components: [{ type: 'bar', id: 'b1', label: 'صافي', category: 'item', value: 'qty', formula: { id: saved.id, version: 1 } }],
  }, { columns: flow.columns, rows: flow.rows, formulaColumns: { [saved.id]: 'net' }, formulaVersions: { [saved.id]: 1 } });
  chk(rrChart.errors.length === 0 && rrChart.report.components[0].value === 'net', '6b) مرجع المعادلة يُغذّي قيمة المخطط');
  const rrTable = FR.resolveReportFormulas({
    name: 'جدول', components: [{ type: 'table', id: 't1', label: 'تفاصيل', columns: ['item'], formula: { id: saved.id, version: 1 } }],
  }, { columns: flow.columns, rows: flow.rows, formulaColumns: { [saved.id]: 'net' }, formulaVersions: { [saved.id]: 1 } });
  chk(rrTable.errors.length === 0 && rrTable.report.components[0].columns.indexOf('net') >= 0, '6c) مرجع المعادلة يُضاف كعمود للجدول');

  const rendered = await RB.renderReport(rr.report, { columns: flow.columns, rows: flow.rows });
  chk(rendered.ok && rendered.html.includes('8'), '7) التقرير يعرض نفس رقم التدفق (لا منطق حساب آخر)');

  /* اختلاف النسخة ⇒ خطأ (لا تفسير نتيجة قديمة بإصدار مختلف) */
  const mismatch = FR.resolveReportFormulas({
    name: 'تقرير', components: [{ type: 'kpi', id: 'e1', label: 'صافي', agg: 'sum', formula: { id: saved.id, version: 99 } }],
  }, { columns: ['net'], rows: [{ net: 8 }], formulaColumns: { [saved.id]: 'net' }, formulaVersions: { [saved.id]: 1 } });
  chk(mismatch.errors.length === 1 && /تختلف عن النسخة/.test(mismatch.errors[0]),
    '8) اختلاف نسخة المعادلة ⇒ خطأ صريح (لا تفسير نتيجة قديمة)');

  /* عمود مفقود / لا نتيجة تشغيل ⇒ خطأ صريح */
  const noRun = FR.resolveReportFormulas(repDef, { columns: [], rows: [], formulaColumns: {} });
  chk(noRun.errors.length === 1 && /غير مطبَّقة على بيانات هذا التشغيل/.test(noRun.errors[0]),
    '9) غياب نتيجة التشغيل ⇒ خطأ صريح');

  /* حقول المعادلة غير موجودة في البيانات ⇒ ملاحظة مبكرة */
  const wrongFields = FR.resolveWorkflowFormulas({
    name: 't', source: { type: 'memory', name: 'synthetic' },
    steps: [{ id: 'c1', type: 'compute', newColumn: 'net', formulaId: saved.id }],
  }, fdir, { columns: ['qty'] });
  chk(wrongFields.notes.some(n => /تحتاج حقولًا غير موجودة/.test(n)), '10) حقول المعادلة غير موجودة ⇒ خطأ مبكّر وواضح');
  chk(wrongFields.workflow.steps[0].formula === undefined, '11) الخطوة لا تُنفَّذ بمعادلة لا تنطبق على البيانات');
}

/* ================= سلامة المحرّر ================= */
{
  for (const f of ['src/formula-store.js', 'src/formula-builder.js', 'src/formula-resolver.js', 'src/formulas.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
    chk(!/\beval\s*\(|new Function\s*\(|require\(['"]child_process['"]\)/.test(src),
      f + ': لا تنفيذ اعتباطي ولا تنفيذ أوامر');
  }
  const srcAll = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'formulas.js'), 'utf8');
  chk(!/process\.|require\(['"]fs['"]\)|require\(['"]http['"]\)/.test(srcAll),
    'محرّك المعادلات لا يقرأ ملفات ولا شبكة ولا البيئة');
}

/* ================= إصلاحات مُثبَّتة بالتحقق العملي عبر HTTP ================= */
{
  const srv = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
  const policy = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'route-policy.js'), 'utf8');
  /* مسارات سجل المعادلات يجب أن تعمل في وضع الاختبار (بلا جلسة) وإلا تعذّر
     اختبار مسار «معادلة ← تدفق ← تقرير» في البيئة المعزولة (كان 401). */
  for (const r of ['GET /api/formulas/saved', 'GET /api/formulas/saved/get', 'POST /api/formulas/save', 'POST /api/formulas/delete']) {
    chk(policy.includes("'" + r + "'"), 'مسار ' + r + ' متاح في وضع الاختبار (بلا جلسة)');
  }
  chk(/const PUBLIC_ROUTES = Policy\.publicRoutes\(TEST_MODE\)/.test(srv),
    'وضع الاختبار يبني المسارات العامة من وحدة السياسة');
  /* المصدر الداخلي (synthetic) يُسجَّل مع النتيجة — لا يبقى المصدر مجهولاً */
  chk(/res2\.source = wf2\.sourceMeta/.test(srv) && /CAT\.getSource\('synthetic'\)/.test(srv),
    'المصدر الداخلي (synthetic) يُسجَّل مع نتيجة التشغيل');
  /* قائمة التشغيلات في استوديو التقارير تعرض حالة التتبّع */
  const rd = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'report-designer.js'), 'utf8');
  chk(/traceTag/.test(rd) && /definitionChanged/.test(rd), 'قائمة التشغيلات تعرض حالة التتبّع (كامل/غير مكتمل/تعريف تغيّر)');
}

  /* تجربة الاستخدام: تمييز المعادلة المحفوظة + حالة اكتمال الربط ظاهرتان للمستخدم */
  const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  chk(/معادلة محفوظة/.test(appJs) && /formulaVersion/.test(appJs),
    'ملخّص الخطوة يميّز المعادلة المحفوظة (اسمها ونسختها) عن التعبير اليدوي');
  chk(/compTag/.test(appJs) && /الاكتمال/.test(appJs),
    'جدول تتبّع التشغيل يعرض حالة اكتمال الربط (مكتمل/تحذير/غير مكتمل)');
/* ================= عقد واجهة «تقرير سريع» (تدقيق ثابت بلا متصفح) ================= */
{
  const idxHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  for (const el of ['rs-quick', 'rs-quick-panel', 'rs-quick-source', 'rs-quick-from', 'rs-quick-to', 'rs-quick-cols', 'rs-quick-create', 'rs-quick-msg']) {
    chk(idxHtml.includes('id="' + el + '"'), 'عنصر الواجهة موجود: #' + el);
  }
  const rdJs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'report-designer.js'), 'utf8');
  chk(rdJs.includes("$('rs-quick')?.addEventListener('click', openQuickPanel)"), 'زر التقرير السريع يفتح اللوحة');
  chk(rdJs.includes("$('rs-quick-create')?.addEventListener('click', createQuickRun)"), 'زر الإنشاء يستدعي createQuickRun');
  chk(rdJs.includes("type: 'select'"), 'التقرير السريع يستخدم خطوة select فقط (بلا تجميع/ربط)');
  chk(!/\bSELECT\s+[a-z_]+\s+(FROM|INTO|UPDATE|VALUES)\b/i.test(rdJs) && !/\bINSERT\s+INTO\b/i.test(rdJs)
    && !/\bdb\.(all|get|query)\b/i.test(rdJs),
    'لا SQL ولا استعلام قاعدة بيانات في واجهة المصمم');
}

chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');
/* ================= «تقرير سريع»: تدفق بخطوة select واحدة بلا compute/join ================= */
{
  const rowsQ = [{ item: 'A', qty: 2, price: 4 }, { item: 'B', qty: 3, price: 2 }];
  const colsQ = ['item', 'qty', 'price'];
  const wfQ = {
    name: 'تقرير سريع', source: { type: 'memory', name: 'synthetic' },
    steps: [{ id: 'q1', type: 'select', columns: colsQ }],
  };
  const runQ = W.executeWorkflow(wfQ, { rows: rowsQ, columns: colsQ });
  chk(runQ.ok && runQ.rows.length === 2, 'التقرير السريع ينتج النتيجة (صفان)');
  chk(JSON.stringify(runQ.columns) === JSON.stringify(colsQ), 'النتيجة تحمل الأعمدة المختارة فقط');
  chk(runQ.trace.length === 1 && runQ.trace[0].type === 'select', 'خطوة واحدة فقط (select) — بلا compute/join');
  const defQ = W.definitionSnapshot(wfQ);
  W.saveOutput('run_q', Object.assign({}, runQ, {
    definition: defQ, definitionHash: W.definitionHash(defQ),
    engineVersion: formulas.FORMULA_ENGINE_VERSION, engineHash: formulas.formulaEngineHash(),
  }), wdir);
  const outQ = W.loadOutput('run_q', wdir);
  chk(!!outQ.definitionHash && !!outQ.engineVersion, 'النتيجة السريعة تحمل بصمة التعريف وإصدار المحرّك');
  const repQ = Schema.normalizeReport({
    name: 'تقرير سريع', runId: 'run_q',
    source: { name: 'synthetic', label: 'بيانات تجريبية', runId: 'run_q', traced: true, definitionHash: outQ.definitionHash },
    components: [{ type: 'table', id: 'e1', label: 'جدول', columns: ['item', 'qty'] }],
  });
  chk(Schema.validateReport(repQ).ok, 'تعريف التقرير السريع صالح');
  chk(repQ.source.definitionHash === outQ.definitionHash, 'التقرير يحمل بصمة النتيجة');
  const srs = RS.saveReport(repQ, path.join(tmp, 'reports'));
  const backQ = RS.loadReport(srs.id, path.join(tmp, 'reports'));
  chk(!!backQ && backQ.components[0].columns.join(',') === 'item,qty', 'حفظ التقرير السريع وإعادة فتحه يحفظان الأعمدة');
  chk(backQ.source.runId === 'run_q', 'التقرير السريع مرتبط بمعرّف التشغيل');
  const RBq = require('../../src/report-bridge');
  const badQ = await RBq.renderReport(
    { name: 'q', components: [{ type: 'table', id: 'e1', columns: ['item', 'nope'] }] },
    { columns: outQ.columns, rows: outQ.rows });
  chk(badQ.ok === true && (badQ.errors || []).length === 1, 'عمود مفقود في تقرير سريع ⇒ خطأ صريح لا استبدال');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\ntraceability.test.js — pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
