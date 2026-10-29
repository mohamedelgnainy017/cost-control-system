'use strict';
/**
 * اختبارات المنصة التحليلية: فهرس البيانات · قاموس المعادلات · سجل الشاشات · محرك التدفقات
 * ==========================================================================
 * - معزولة تماماً: الحارس يمنع أي اتصال شبكة ⇒ صفر اتصال.
 * - مزوّد الربط في الاختبار دالة وهمية (لا استدعاء لأي مصدر حقيقي).
 * - الثوابت: الأرصدة اليومية (daily_balances) هي المرجع المعتمد،
 *   وcontract_balances مصدر موثق غير معتمد.
 */
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CAT = require('../../src/data-catalog');
const D = require('../../src/datasets');
const W = require('../../src/workflow');
const ME = require('../../src/model-explorer');
const SR = require('../../src/screen-registry');
const DAX = require('../../src/dax-reference');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

console.log('== المنصة التحليلية: الفهرس والقاموس والسجل ==');

(async () => {

/* ---------- 1) سلامة الفهرس ---------- */
{
  const ids = CAT.SOURCES.map(s => s.id);
  chk(new Set(ids).size === ids.length, 'لا معرّفات مكرّرة في الفهرس (' + ids.length + ' مصدر)');
  chk(CAT.SOURCES.every(s => s.label && s.domain && s.status && s.grain && Array.isArray(s.fields) && s.fields.length),
    'كل مصدر يحمل اسمًا ومجالًا وحالة ومستوى تفصيل وحقولًا');
  chk(CAT.SOURCES.every(s => Array.isArray(s.rowKey) && s.rowKey.length), 'كل مصدر يعلن مفتاح صفه');
  chk(CAT.SOURCES.filter(s => s.status === CAT.STATUS.implemented).every(s => typeof s.fetch === 'function'),
    'كل مصدر «منفّذ» له مسار قراءة فعلي');
  chk(CAT.SOURCES.every(s => s.fields.every(f => f.name && f.type && f.description && f.origin)),
    'كل حقل يحمل اسمًا ونوعًا ووصفًا وأصله (مصدر/محسوب)');
  chk(CAT.SOURCES.filter(s => s.status === CAT.STATUS.implemented).every(s => s.access && s.access.module),
    'كل مصدر «منفّذ» يوثّق وحدة التنفيذ');
}

/* ---------- 2) الأرصدة اليومية هي المرجع المعتمد ---------- */
{
  const bal = CAT.getSource('daily_balances');
  chk(!!bal && bal.canonical === true, 'daily_balances معرَّف كمصدر معتمد (canonical)');
  chk(!!bal && bal.technical === 'balances', 'المرجع المعتمد هو جدول الأرصدة اليومية (balances)');
  chk(!!bal && bal.grain.includes('تاريخ رصيد'), 'مستوى المرجع يذكر تاريخ الرصيد');
  chk(!!bal && bal.rowKey.includes('balance_date'), 'مفتاح صف المرجع يذكر تاريخ الرصيد');
  const cb = CAT.getSource('contract_balances');
  chk(!!cb && cb.canonical !== true, 'contract_balances ليس المرجع المعتمد');
  chk(!!cb && !!cb.canonicalNote, 'contract_balances يحمل تنويه «غير معتمد»');
  /* قاعدة المرجع المعتمد: أرصدة العقود لا تُعرض في «تقرير سريع» */
  chk(cb.quickReport === false, 'contract_balances مستثنى من التقرير السريع (quickReport=false)');
  chk(bal.quickReport !== false, 'daily_balances مؤهّل للتقرير السريع (المرجع المعتمد)');
  chk(CAT.SOURCES.filter(s => s.quickReport === false).every(s => s.canonical !== true),
    'كل مصدر مستثنى من التقرير السريع ليس مرجعًا معتمدًا');
  const Dl = require('../../src/datasets');
  const listed = Dl.listSources();
  chk(listed.some(s => s.name === 'contract_balances' && s.quickReport === false),
    'قائمة المصادر تنقل علامة quickReport للواجهة');
  chk(listed.find(s => s.name === 'daily_balances').quickReport !== false,
    'daily_balances في القائمة مؤهّل للتقرير السريع');
  /* السياسة: المصدر غير المعتمد يبقى متاحًا في استوديو التدفقات مع تحذير واضح */
  chk(listed.find(s => s.name === 'contract_balances').canonicalNote.includes('daily_balances'),
    'قائمة المصادر تحمل تنويه المصدر غير المعتمد (يُعرض كتحذير للمستخدم)');
  const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  chk(/canonicalNote/.test(appJs) && /غير المرجع المعتمد/.test(appJs),
    'استوديو التدفقات يعرض علامة تحذير للمصدر غير المعتمد (يبقى متاحًا)');
  const canonicalCount = CAT.SOURCES.filter(s => s.canonical).length;
  chk(canonicalCount === 1, 'مرجع معتمد واحد فقط في الفهرس (' + canonicalCount + ')');
}

/* ---------- 3) القائمة البيضاء = الفهرس ---------- */
{
  const runnable = CAT.runnableSources().map(s => s.id).filter(x => x !== 'synthetic');
  const white = Object.keys(D.DATASETS);
  chk(white.length === runnable.length && white.every(k => runnable.includes(k)),
    'القائمة البيضاء = مصادر الفهرس المنفّذة (' + white.length + ')');
  chk(Object.values(D.DATASETS).every(d => d.perm && d.columns.length && d.types && d.grain),
    'كل مصدر في القائمة البيضاء يحمل صلاحية وحقولاً وأنواعاً ومستوى');
  chk(!!D.DATASETS.daily_balances && D.DATASETS.daily_balances.canonical === true,
    'الأرصدة اليومية متاحة للتدفقات ومرجعها معتمد');
  chk(Object.values(D.DATASETS).every(d => d.columns.every(c => Object.prototype.hasOwnProperty.call(d.types, c))),
    'كل عمود معلَن له نوع');
}

/* ---------- 4) محرك التدفقات: ترتيب + ربط بمصدر مسجَّل ---------- */
{
  const rows = [
    { item: 'B', qty: 2, grp: 'x' },
    { item: 'A', qty: 3, grp: 'x' },
    { item: 'C', qty: 1, grp: 'y' },
  ];
  const wf = { name: 't', source: { type: 'memory', name: 'synthetic' }, steps: [{ id: 's1', type: 'sort', by: ['qty'], order: 'desc' }] };
  const res = W.executeWorkflow(wf, { rows, columns: ['item', 'qty', 'grp'] });
  chk(res.ok && res.rows.map(r => r.qty).join(',') === '3,2,1', 'خطوة sort تنزلياً تعمل');
  const wf2 = { name: 't', source: { type: 'memory', name: 'synthetic' }, steps: [{ id: 's1', type: 'sort', by: ['qty'], order: 'asc' }] };
  const res2 = W.executeWorkflow(wf2, { rows, columns: ['item', 'qty', 'grp'] });
  chk(res2.ok && res2.rows.map(r => r.qty).join(',') === '1,2,3', 'خطوة sort تصاعدياً تعمل');
  const bad = W.validateStep({ type: 'sort', by: ['nope'] }, ['item', 'qty']);
  chk(!bad.ok && /unknown column/.test(bad.errors.join(' ')), 'sort يرفض عموداً غير موجود');
  chk(W.STEP_TYPES.includes('sort'), 'sort ضمن أنواع الخطوات');

  /* ربط بمصدر مسجَّل — مزوِّد وهمي (بلا قاعدة بيانات) */
  const right = [{ item: 'A', extra: 'e1' }, { item: 'B', extra: 'e2' }];
  const resolver = async (name) => ({ ok: true, rows: right, columns: ['item', 'extra'], label: 'مصدر وهمي', grain: 'صنف' });
  const wfJoin = {
    name: 't', source: { type: 'memory', name: 'synthetic' },
    steps: [{ id: 's1', type: 'join', rightSource: 'daily_balances', leftKey: 'item', rightKey: 'item', joinType: 'left' }],
  };
  const prep = await W.prepareWorkflow(wfJoin, resolver);
  chk(prep.notes.length === 1 && /مصدر وهمي/.test(prep.notes[0]), 'prepareWorkflow يسجّل ملاحظة مصدر الربط ومستواه');
  const joined = W.executeWorkflow(prep.workflow, { rows, columns: ['item', 'qty', 'grp'] });
  chk(joined.ok && joined.rows.length === 3 && joined.rows.find(r => r.item === 'A').extra === 'e1',
    'الربط بمصدر مسجَّل ينتج أعمدة مدمجة');
  chk(joined.ok && joined.rows.find(r => r.item === 'C').extra === null, 'نوع left يحافظ على الصفوف غير المطابقة');
  const v = W.validateStep({ type: 'join', rightSource: 'x', leftKey: 'item', rightKey: 'item' }, ['item']);
  chk(v.ok, 'validateStep يقبل join بمصدر مسجَّل بلا rightRows');
  const v2 = W.validateStep({ type: 'join', leftKey: 'item', rightKey: 'item' }, ['item']);
  chk(!v2.ok, 'join بلا مصدر وبلا صفوف حرفية مرفوض');
}

/* ---------- 5) قاموس المعادلات ---------- */
{
  chk(DAX.MEASURES.length === 49, 'مرجع DAX: 49 مقياسًا (' + DAX.MEASURES.length + ')');
  chk(DAX.COLUMNS.length === 21, 'مرجع DAX: 21 عمودًا محسوبًا (' + DAX.COLUMNS.length + ')');
  const all = ME.formulas();
  chk(all.length >= 49 + 21 + 10, 'قاموس المعادلات يجمع DAX + معادلات المشروع (' + all.length + ')');
  chk(all.every(f => f.status && f.name), 'كل معادلة لها اسم وحالة');
  chk(all.every(f => f.numericVerified === false), 'لا معادلة تُوصف بأنها متحقق منها رقميًا');
  chk(all.filter(f => f.kind === 'مقياس').length === 49 && all.filter(f => f.kind === 'عمود محسوب').length === 21,
    'التصنيف: 49 مقياسًا و21 عمودًا محسوبًا');
  chk(ME.NATIVE.every(n => n.location && n.logic && n.sources.length), 'كل معادلة مشروع لها منطق وموضع ومصادر');
  const balConv = ME.BALANCE_CONVERSIONS;
  chk(balConv.length >= 3 && balConv.every(c => c.proposedSource.includes('daily_balances')),
    'تحويلات الأرصدة إلى المصدر اليومي موثّقة (لا مطبَّقة)');
  chk(ME.IMPORTED_VS_COMPUTED.some(x => x.kind === 'مستورد') && ME.IMPORTED_VS_COMPUTED.some(x => x.kind === 'محسوب'),
    'قاموس يميّز القيمة المستوردة عن المحسوبة');
}

/* ---------- 6) العلاقات ---------- */
{
  const rel = ME.relations();
  chk(rel.length >= 20, 'مستكشف العلاقات يعرض العلاقات المؤكدة والمقترحة (' + rel.length + ')');
  chk(rel.some(r => r.from === 'daily_balances' && r.to === 'items' && r.confidence === 'confirmed'),
    'علاقة الأرصدة اليومية بالأصناف مؤكدة');
  chk(rel.some(r => r.from === 'sales' && r.to === 'movements' && r.confidence === 'confirmed'),
    'علاقة المبيعات بالحركات (إسناد التكلفة) مؤكدة');
  chk(rel.every(r => r.from && r.to && r.leftKey && r.rightKey), 'كل علاقة بمفتاحين واتجاه');
}

/* ---------- 7) سجل الشاشات والتقارير ---------- */
{
  const known = new Set(CAT.SOURCES.map(s => s.id));
  const pending = new Set(SR.PENDING_SOURCES.map(p => p.id));
  const screenRefs = SR.SCREENS.flatMap(s => s.sources);
  const reportRefs = SR.REPORTS.map(r => r.source).filter(Boolean);
  const unknownS = screenRefs.filter(x => !known.has(x) && !pending.has(x));
  const unknownR = reportRefs.filter(x => !known.has(x) && !pending.has(x));
  chk(unknownS.length === 0, 'كل مصدر في الشاشات معرَّف في الفهرس أو موثَّق كفجوة' + (unknownS.length ? ': ' + unknownS.join(',') : ''));
  chk(unknownR.length === 0, 'كل مصدر في التقارير معرَّف في الفهرس أو موثَّق كفجوة' + (unknownR.length ? ': ' + unknownR.join(',') : ''));
  chk(SR.SCREENS.length >= 15, 'سجل الشاشات يغطي كل التبويبات (' + SR.SCREENS.length + ')');
  chk(SR.REPORTS.length >= 30, 'سجل التقارير يغطي كل تقارير الخادم (' + SR.REPORTS.length + ')');
  const sum = SR.summary();
  chk(sum.visibleReports === SR.REPORTS.filter(r => !r.hidden).length, 'ملخص السجل: عدد التقارير المرئية متسق');
  chk(sum.screensByReuse.catalog > 0, 'شاشات قابلة لإعادة الاستخدام كمصادر: ' + sum.screensByReuse.catalog);
}

/* ---------- 8) حفظ المخرجات بمصدرها ---------- */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'));
  const runId = 'run_test';
  W.saveOutput(runId, { ok: true, rows: [{ a: 1 }], columns: ['a'], source: { name: 'daily_balances', label: 'الأرصدة اليومية' }, workflowName: 'w1' }, tmp);
  const back = W.loadOutput(runId, tmp);
  chk(!!back && back.source && back.source.name === 'daily_balances', 'النتيجة المحفوظة تحمل مصدرها');
  chk(!!back && back.workflowName === 'w1', 'النتيجة المحفوظة تحمل اسم التدفق');
}

/* ---------- 10) تدقيق ساكن لواجهة المنصة والخادم ---------- */
{
  const idx = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  const appjs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
  const anjs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'analysis.js'), 'utf8');
  const srv = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
  chk(/<section id="tab-analysis"/.test(idx), 'قسم منظومة التحليل موجود في HTML');
  chk(/data-grp="platform" data-goto="analysis"/.test(idx), 'مستكشف البيانات داخل مجموعة «منصة التحليل»');
  chk(!/data-tab="analysis"/.test(idx), 'لا زر مستقل للمنصة في الشريط (ضمن مجموعة منصة التحليل)');
  chk(/id="nav-platform-menu"/.test(idx) && /data-goto="analysis"/.test(idx)
    && /data-goto="report-studio"/.test(idx) && /data-goto="screen-studio"/.test(idx),
    'مجموعة «منصة التحليل» تحوي الأقسام الثلاثة');
  {
    const iA = idx.indexOf('data-goto="analysis"');
    const iR = idx.indexOf('data-goto="report-studio"');
    const iS = idx.indexOf('data-goto="screen-studio"');
    chk(iA > -1 && iR > iA && iS > iR, 'ترتيب القائمة: البيانات والتحليل ← التقارير ← تصميم الشاشات');
  }
  chk(/<section id="tab-platform"/.test(idx) && /id="platform-home-grid"/.test(idx),
    'الصفحة الرئيسية للمنصة موجودة (مدخل واحد)');
  chk(/<script src="\/analysis\.js"><\/script>/.test(idx), 'analysis.js محمّل في الصفحة');
  chk(/id="an-sources"/.test(idx) && /id="an-formulas"/.test(idx) && /id="an-relations"/.test(idx)
    && /id="an-screens"/.test(idx), 'أربعة لوحات: المصادر/المعادلات/العلاقات/الشاشات');
  chk(/ed-sortby/.test(appjs) && /ed-sortorder/.test(appjs), 'محرّر الخطوات يدعم الترتيب');
  chk(/ed-rightsource/.test(appjs) && /rightSource/.test(appjs), 'محرّر الخطوات يدعم الربط بمصدر مسجَّل');
  chk(/loadAnalysisTab/.test(appjs) && /loadAnalysisTab/.test(anjs), 'المنصة تُحمَّل عند فتح التبويب');
  chk(/\/api\/catalog/.test(anjs) && /\/api\/model\/formulas/.test(anjs) && /\/api\/screens/.test(anjs)
    && /\/api\/model\/relations/.test(anjs), 'المنصة تقرأ مسارات الخادم الأربعة');
  chk(/'GET \/api\/catalog'/.test(srv) && /'GET \/api\/model\/formulas'/.test(srv)
    && /'GET \/api\/model\/relations'/.test(srv) && /'GET \/api\/screens'/.test(srv), 'الخادم يقدّم مسارات المنصة');
  chk(/id: 'analysis'/.test(srv), 'تبويب المنصة ضمن صلاحيات الخادم');
  const designerjs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'report-designer.js'), 'utf8');
  chk(/it\.source/.test(designerjs) && /it\.savedAt/.test(designerjs), 'قائمة مخرجات استوديو التقارير تعرض المصدر والتاريخ');
}

/* ---------- 11) لا اتصال شبكة ---------- */
chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');

console.log('pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
})();
