'use strict';
/**
 * اختبارات مصادر بيانات Workflow Studio (dataset:borse) — معزولة بالكامل
 * - a.borseSeries مبادَل بـ mock: لا قاعدة بيانات ولا خدمات تسعير.
 * - الحارس _guard يرمي استثناء عند أي محاولة اتصال شبكة — ثابتٌ في صفر اتصال.
 * - server/UI يُدقَقان بصمت (النمط المعتمد في test_mode.test.js) — استيراد server لا يبدأ الخادم.
 */
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const A = require('../../src/analytics');
const D = require('../../src/datasets');
const CAT = require('../../src/data-catalog');
const W = require('../../src/workflow');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

/* منفعة: mock المزوّد قطعي — يقبل صفوفاً (مصفوفة) أو دالة مورِدة */
let calls = [];
function installMock(data) {
  calls = [];
  A.borseSeries = async params => { calls.push({ params }); return typeof data === 'function' ? data(params) : data; };
}
const BORSE_PRED_COLS = ['borse_date', 'item', 'item_code', 'close', 'usd_rate'];

(async () => {
  console.log('== datasets (whitelist / permissions / limits / read-only) ==');

  /* 1) القائمة البيضاء */
  chk(D.DATASETS && D.DATASETS.borse && D.DATASETS.borse.perm === 'sync',
    'DATASETS تضم borse بصلاحية sync');
  chk(Object.keys(D.DATASETS).length >= 1
    && Object.keys(D.DATASETS).every(k => CAT.getSource(k) && typeof CAT.getSource(k).fetch === 'function'),
    'القائمة البيضاء = مصادر الفهرس المنفَّذة فقط (لا مصدر خارج الفهرس) — ' + Object.keys(D.DATASETS).length + ' مصدر');

  /* 2) رفض الأسماء غير المعروفة دون أي استدعاء للمزوّد */
  installMock([]);
  {
    const r = await D.resolveDataset({ type: 'dataset', name: 'users' }, { role: 'admin', active: true });
    chk(!r.ok && r.status === 400 && /غير مسموح/.test(r.error), 'مصدر غير مدرج مرفوض برسالة واضحة, status=400');
    chk(calls.length === 0, 'لا استدعاء للمزوّد عند رفض الاسم');
  }
  {
    const r = await D.resolveDataset({ type: 'dataset' }, { role: 'admin', active: true });
    chk(!r.ok && r.status === 400, 'مصدر بلا اسم مرفوض');
    chk(calls.length === 0, 'لا استدعاء للمزوّد عند غياب الاسم');
  }

  /* 3) الصلاحية قبل الجلب */
  installMock([{ borse_date: '2026-01-01', item: 'X', item_code: '1001', close: 5, usd_rate: 50 }]);
  {
    const r = await D.resolveDataset({ type: 'dataset', name: 'borse' }, { role: 'admin', active: true });
    chk(r.ok && r.data.sourceData.length === 1, 'admin بصلاحية sync يقرأ المصدر');
    chk(calls.length === 1, 'استدعاء واحد للمزوّد فقط');
  }
  installMock([]);
  {
    const r = await D.resolveDataset({ type: 'dataset', name: 'borse' }, { role: 'viewer', active: true });
    chk(!r.ok && r.status === 403 && /صلاحية/.test(r.error), 'viewer بلا sync مرفوض 403');
    chk(calls.length === 0, 'لا جلب بيانات قبل فحص الصلاحية (viewer)');
  }
  {
    const r = await D.resolveDataset({ type: 'dataset', name: 'borse' }, null);
    chk(!r.ok && r.status === 403, 'me=null مرفوض 403 (لا جلسة = لا قراءة)');
    chk(calls.length === 0, 'لا جلب بيانات لمستخدم مجهول');
  }
  /* محاسب يملك sync أيضاً */
  installMock([{ borse_date: '2026-01-01', item: 'X', item_code: '1001', close: 5, usd_rate: 50 }]);
  {
    const r = await D.resolveDataset({ type: 'dataset', name: 'borse' }, { role: 'accountant', active: true });
    chk(r.ok, 'accountant (sync) يقرأ المصدر');
    chk(calls.length === 1, 'استدعاء chased للـaccountant');
  }

  /* 4) وضع الاختبار: المصادر الحقيقية مرفوضة دائماً */
  installMock([]);
  {
    const saved = process.env.WORKFLOW_TEST_MODE;
    process.env.WORKFLOW_TEST_MODE = '1';
    const r = await D.resolveDataset({ type: 'dataset', name: 'borse' }, { role: 'admin', active: true });
    chk(!r.ok && r.status === 403 && /وضع الاختبار/.test(r.error), 'وضع الاختبار يرفض المصادر الحقيقية');
    chk(calls.length === 0, 'صفر جلب في وضع الاختبار (عزل اتصال مُثبت)');
    if (saved === undefined) delete process.env.WORKFLOW_TEST_MODE; else process.env.WORKFLOW_TEST_MODE = saved;
  }

  /* 5) الإعدادات: رفض الردء وتقييد الزائد وافتراض الغائب */
  {
    const b1 = await D.resolveDataset({ type: 'dataset', name: 'borse', settings: { days: 'abc' } }, { role: 'admin', active: true });
    chk(!b1.ok && /days/.test(b1.error), 'days غير رقمية ترفض بوضوح');
    const b2 = await D.resolveDataset({ type: 'dataset', name: 'borse', settings: { days: 0 } }, { role: 'admin', active: true });
    chk(!b2.ok && /days/.test(b2.error), 'days<=0 يرفض');
    const b3 = await D.resolveDataset({ type: 'dataset', name: 'borse', settings: { item: 'x'.repeat(41) } }, { role: 'admin', active: true });
    chk(!b3.ok && /item/.test(b3.error), 'item أطول من الحد يرفض');
    chk(calls.length === 0, 'إعدادات رديئة ترفض قبل أي جلب');
  }
  installMock(p => [{ got: JSON.stringify(p) }]);
  {
    const r = await D.resolveDataset({ type: 'dataset', name: 'borse' }, { role: 'admin', active: true });
    chk(r.ok && calls[0].params.days === 120 && calls[0].params.item === '',
      'غياب الإعدادات → الافتراضي days=120, item=\'\'');
  }
  installMock(p => [{ got: JSON.stringify(p) }]);
  {
    const r = await D.resolveDataset({ type: 'dataset', name: 'borse', settings: { days: 400, item: 'ذرة' } }, { role: 'admin', active: true });
    chk(r.ok && calls[0].params.days === D.MAX_DAYS, 'days المتجاوز يُقيَّد إلى ' + D.MAX_DAYS);
    chk(r.notes && r.notes.some(n => /تقييدها/.test(n)), 'عبارة واضحة عن تقييد الأيام');
    chk(calls[0].params.item === 'ذرة', 'item يُمرر معلماً كما هو');
  }
  installMock(p => [{ got: JSON.stringify(p) }]);
  {
    const r = await D.resolveDataset({ type: 'dataset', name: 'borse', settings: { days: '90' } }, { role: 'admin', active: true });
    chk(r.ok && calls[0].params.days === 90, 'days النصية الصالحة تعال عددياً');
  }

  /* 6) حد الصفوف + التحذير */
  installMock(() => Array.from({ length: D.ROW_LIMIT + 10 }, (_, i) => ({ i, close: i })));
  {
    const r = await D.resolveDataset({ type: 'dataset', name: 'borse' }, { role: 'admin', active: true });
    chk(r.ok && r.data.sourceData.length === D.ROW_LIMIT, 'الاقتطاع عند ROW_LIMIT=' + D.ROW_LIMIT);
    chk(r.notes && r.notes.some(n => n.includes('اقتطاع') && n.includes(String(D.ROW_LIMIT + 10))),
      'تحذير واضح بالعدد الأصلي (' + (D.ROW_LIMIT + 10) + ')');
  }

  /* 7) شكل الأعمدة — مطابقة حرفية */
  installMock(() => [
    { borse_date: '2026-01-05', item: 'ذرة', item_code: '1001', close: 431.25, usd_rate: 48.7 },
    { borse_date: '2026-01-06', item: 'ذرة', item_code: '1001', close: 432.5, usd_rate: 48.7 },
  ]);
  {
    const r = await D.resolveDataset({ type: 'dataset', name: 'borse' }, { role: 'admin', active: true });
    chk(r.ok && JSON.stringify(r.data.sourceColumns) === JSON.stringify(BORSE_PRED_COLS),
      'sourceColumns = أعمدة borseSeries المتوقعة بالترتيب');
    chk(r.data.sourceData[0].close === 431.25, 'الصفوف تُمرر دون معالجة');
  }

  /* 8) المرور بمحرك قائم دون تعديل — على sourceData */
  installMock(() => [
    { borse_date: '2026-01-01', item: 'ذرة', item_code: '1001', close: 100, usd_rate: 50 },
    { borse_date: '2026-01-01', item: 'صويا', item_code: '1002', close: 200, usd_rate: 50 },
    { borse_date: '2026-01-02', item: 'ذرة', item_code: '1001', close: 300, usd_rate: 50 },
  ]);
  {
    const wf = {
      name: 'ds-wf',
      source: { type: 'dataset', name: 'borse', settings: { days: 120 } },
      steps: [
        { id: 'f1', type: 'filter', column: 'close', op: 'gt', value: 80 },
        { id: 'c1', type: 'compute', newColumn: 'cost', formula: 'close * usd_rate' },
        { id: 'g1', type: 'groupBy', keys: ['item'], aggs: [{ fn: 'SUM', column: 'cost', out: 'sum_cost' }] },
      ],
    };
    chk(W.validateWorkflow(wf).ok, 'تعريف dataset يمر التحقق');
    const r = await D.resolveDataset(wf.source, { role: 'admin', active: true });
    const ex = W.executeWorkflow(wf, r.data);
    chk(ex.ok && ex.rowCount === 2, 'filter+compute+groupBy فوق dataset → مجموعتين');
    const grad = ex.rows.find(x => x.item === 'ذرة');
    chk(grad && grad.sum_cost === (100 * 50 + 300 * 50), 'ذرة: sum_cost = 100*50 + 300*50 = 20000');
  }

  /* 9) المصدر القديم memory محفوظ */
  chk(!D.isDataset({ source: { type: 'memory', name: 'synthetic' } }), 'isDataset(memory)=false — السلوك القديم محفوظ');

  /* 10) الحفظ والتحميل يحفظان نوع المصدر والإعدادات */
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-'));
    const wf = {
      name: 'ds-persist',
      source: { type: 'dataset', name: 'borse', settings: { days: 90, item: 'صويا' } },
      steps: [{ id: 's1', type: 'select', columns: ['borse_date', 'close'] }],
    };
    const id = W.saveWorkflow(wf, tmp);
    const back = W.loadWorkflow(id, tmp);
    chk(back.source.type === 'dataset' && back.source.name === 'borse', 'إعادة التحميل تحفظ النوع والاسم');
    chk(JSON.stringify(back.source.settings) === JSON.stringify({ days: 90, item: 'صويا' }), 'الإعدادات تُحفظ حرفياً');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* 11) تدقيق ساكن: datasets.js قراءة فقط */
  {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'datasets.js'), 'utf8');
    chk(!/insertBatch|startScheduler|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bTRUNCATE\s+(TABLE\b|\.)|\bDROP\s+TABLE\b/i.test(src),
      'datasets.js بلا تعليمات كتابة أو مجدولات');
    chk(!/require\(['"]\.\/borse-fetch['"]\)|require\(['"]\.\/cost-engine['"]\)/.test(src),
      'لا اعتماديات على الجلب الخارجي أو محرك التكلفة');
    chk(/Auth\.can\(me,\s*def\.perm\)/.test(src), 'فحص الصلاحية داخل resolveDataset (الترتيب مضمون ثابتاً)');
  }

  /* 12) تدقيق ساكن للخادم: الحسم في طبقة الخادم فقط مع الصلاحية، والسلوك القديم كما هو */
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
    chk(/require\(['"]\.\/datasets['"]\)/.test(srv), 'server.js يستورد وحدة القائمة البيضاء');
    chk((srv.match(/D\.resolveDataset\(/g) || []).length >= 2, 'preview وrun يحسمان المصدر عبر resolveDataset');
    chk((srv.match(/D\.isDataset\(wf\)/g) || []).length === 2, 'isDataset يُفحص في مسارين فقط');
    chk((srv.match(/body\.data\)\s*\?\s*null\s*:\s*W\.syntheticFixture\(\)/g) || []).length === 2,
      'سلوك الـfixture الاصطناعي للـmemory بقيا (فرعان: preview/run)');
    chk(/sourceNotes/.test(srv), 'التحذير (notes) يعرّ إلى الاستجابة');
  }

  /* 13) تدقيق ساكن للواجهة */
  {
    const appjs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
    chk(/function wfSource\(\)/.test(appjs), 'app.js يحوي wfSource');
    chk((appjs.match(/source:\s*wfSource\(\)/g) || []).length === 5,
      'الأزرار (save/validate/preview/run) + معاينة الخطوة ترسل المصدر عبر wfSource');
    chk(/sourceNotes/.test(appjs), 'renderResult يعرض تحذيرات المصدر');
    const idx = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
    chk((idx.match(/value="dataset\//g) || []).length === 0,
      'لا مصادر مثبَّتة في HTML — قائمة المصادر تُملأ من الفهرس وقت التشغيل');
    chk((idx.match(/value="synthetic"/g) || []).length === 1, 'الخيار الاصطناعي باقٍ مرة واحدة');
    chk(/loadSourceList\(\)/.test(appjs) && /api\/datasets/.test(appjs),
      'الواجهة تملأ قائمة المصادر من /api/datasets (كل المصادر المعتمدة)');
  }

  /* 14) بوابة LIVE READ-ONLY: فصل التشغيل الحي عن كل كتابات بدء التشغيل الخدمية */
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
    chk(/const LIVE = process\.env\.WORKFLOW_LIVE === '1'/.test(srv), 'بوابة WORKFLOW_LIVE معرفة صريحاً');
    chk((srv.match(/else if \(LIVE\) \{/g) || []).length === 2, 'فرعا الحي (بدء اللافتة + داخل listen) فقط');
    chk((srv.match(/BF\.startScheduler\(/g) || []).length === 1, 'المجدول في الفرع الاعتيادي فقط (لا مجدول في الحي)');
    chk((srv.match(/CE\.flush\(\)\.catch/g) || []).length === 1, 'CE.flush في الفرع الاعتيادي فقط (لا كتابة تكاليف في الحي)');
    chk((srv.match(/Auth\.seedAdmin\(\)/g) || []).length === 1, 'seedAdmin في الفرع الاعتيادي فقط (لا تهيئة/تنظيف جلسات في الحي)');
    chk((srv.match(/await DB\.init\(\)/g) || []).length === 1, 'DB.init (والـDDL معه) في الفرع الاعتيادي فقط');
  }

  /* 15) عقود الحقول: القائمة والأعمدة (وصف ثابت — لا جلب) */
  {
    installMock([]);
    const list = D.listSources();
    chk(Array.isArray(list) && list.some(s => s.name === 'synthetic' && s.perm === null),
      'listSources تعرض المصدر الاصطناعي بلا صلاحية');
    chk(list.some(s => s.name === 'borse' && s.perm === 'sync'), 'listSources تعرض borse بصلاحية sync');
    chk(list.length === Object.keys(D.DATASETS).length + 1, 'القائمة = المصادر الحقيقية + الاصطناعي');

    /* أعمدة borse الثابتة */
    const rb = await D.sourceColumns('borse', { role: 'admin', active: true });
    chk(rb.ok && JSON.stringify(rb.data.columns) === JSON.stringify(BORSE_PRED_COLS),
      'sourceColumns(borse) = الأعمدة الخمسة المتوقعة');
    chk(calls.length === 1, 'sourceColumns يجلب 5 صفوف عينة في الإنتاج (قراءة فقط)');

    /* رفض المصدر غير المسموح */
    installMock([]);
    const ru = await D.sourceColumns('users', { role: 'admin', active: true });
    chk(!ru.ok && ru.status === 400 && /غير مسموح/.test(ru.error), 'sourceColumns ترفض المصدر غير المدرج');
    chk(calls.length === 0, 'لا استدعاء عند رفض المصدر');

    /* الصلاحية قبل الإفصاح عن مصدر حقيقي */
    installMock([]);
    const rv = await D.sourceColumns('borse', { role: 'viewer', active: true });
    chk(!rv.ok && rv.status === 403 && /صلاحية/.test(rv.error), 'viewer مرفوض 403 قبل الإفصاح');
    chk(calls.length === 0, 'لا استدعاء للمزوّد عند رفض الصلاحية');
    {
      installMock([]);
      const rn = await D.sourceColumns('borse', null);
      chk(!rn.ok && rn.status === 403, 'me=null مرفوض 403 في الإنتاج');
      chk(calls.length === 0, 'لا استدعاء لمستخدم مجهول');
    }

    /* الاصطناعي: من نفس الـfixture التي ينفّذها المحرك */
    installMock([]);
    const rs = await D.sourceColumns('synthetic', null);
    chk(rs.ok && JSON.stringify(rs.data.columns) === JSON.stringify(['id', 'customerId', 'qty', 'price', 'note']),
      'sourceColumns(synthetic) = أعمدة الـfixture');
    chk(calls.length === 0, 'الاصطناعي بلا جلب');

    /* وضع الاختبار: أعمدة ثابتة بلا صلاحية وبلا اتصال خارجي */
    const saved = process.env.WORKFLOW_TEST_MODE;
    process.env.WORKFLOW_TEST_MODE = '1';
    installMock([]);
    const rt = await D.sourceColumns('borse', null);
    chk(rt.ok && JSON.stringify(rt.data.columns) === JSON.stringify(BORSE_PRED_COLS),
      'وضع الاختبار يوفر الأعمدة بلا اتصال خارجي');
    chk(calls.length === 0, 'صفر استدعاء في وضع الاختبار');
    if (saved === undefined) delete process.env.WORKFLOW_TEST_MODE; else process.env.WORKFLOW_TEST_MODE = saved;
  }

  /* 16) تدقيق ساكن: مسارا الخادم الجديدان + حمايتهما */
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
    const policy = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'route-policy.js'), 'utf8');
    chk(/'GET \/api\/datasets': async/.test(srv), 'مسار GET /api/datasets مسجّل');
    chk(/'GET \/api\/datasets\/fields': async/.test(srv), 'مسار GET /api/datasets/fields مسجّل');
    chk(/\['\/api\/datasets', \['analysis'\]\]/.test(policy), '/api/datasets محمي بشاشة analysis');
    chk(policy.includes("'GET /api/datasets'") && policy.includes("'GET /api/datasets/fields'"),
      'مسارا datasets عامّان في وضع الاختبار');
    chk(/D\.listSources\(\)/.test(srv) && /D\.sourceColumns\(/.test(srv), 'الخادم يستخدم listSources/sourceColumns');
    const dsBlock = srv.split("'GET /api/datasets'")[1].split("'GET /api/workflows'")[0] || '';
    chk(!/DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|TRUNCATE|DROP\s+TABLE/i.test(dsBlock),
      'كتلة datasets بلا كتابة');
  }

  /* 17) عقد الحقول المحسّن: fields (name,type,description) + sample (بدون DB في وضع الاختبار) */
  {
    installMock([]);
    const saved = process.env.WORKFLOW_TEST_MODE;
    process.env.WORKFLOW_TEST_MODE = '1';

    const rb = await D.sourceColumns('borse', null);
    chk(rb.ok, 'sourceColumns(borse) ok في وضع الاختبار');
    chk(Array.isArray(rb.data.fields) && rb.data.fields.length === 5, 'fields = 5 حقول');
    chk(rb.data.fields.every(f => f.name && f.type && typeof f.description === 'string'),
      'كل field has name/type/description');
    chk(rb.data.fields[0].name === 'borse_date' && rb.data.fields[0].type === 'date',
      'borse_date type=date');
    chk(rb.data.fields[3].name === 'close' && rb.data.fields[3].type === 'number',
      'close type=number');
    chk(Array.isArray(rb.data.sample) && rb.data.sample.length === 3, 'sample = 3 صفوف (وضع الاختبار)');
    chk(rb.data.sample[0].item === 'الذرة', 'عينة بورصة: الذرة');
    chk(calls.length === 0, 'صفر استدعاء في وضع الاختبار');

    const rs = await D.sourceColumns('synthetic', null);
    chk(rs.ok && Array.isArray(rs.data.fields) && rs.data.fields.length === 5, 'synthetic fields = 5');
    chk(rs.data.fields[0].name === 'id' && rs.data.fields[0].type === 'number', 'id type=number');
    chk(rs.data.fields[4].name === 'note' && rs.data.fields[4].type === 'string', 'note type=string');
    chk(Array.isArray(rs.data.sample) && rs.data.sample.length === 5, 'synthetic sample = 5 صفوف');
    chk(rs.data.sample[0].id === 1, 'synthetic sample: id=1');

    if (saved === undefined) delete process.env.WORKFLOW_TEST_MODE; else process.env.WORKFLOW_TEST_MODE = saved;
  }

  /* 18) تدقيق ساكن: مسارات Batch 3 (preview until + output + csv) */
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
    const policy = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'route-policy.js'), 'utf8');
    chk(/'GET \/api\/workflows\/output': async/.test(srv), 'مسار GET /api/workflows/output مسجّل');
    chk(/'GET \/api\/workflows\/output\/csv': async/.test(srv), 'مسار GET /api/workflows/output/csv مسجّل');
    chk(/W\.loadOutput\(/.test(srv), 'الخادم يستخدم loadOutput لاسترجاع التشغيل');
    chk(/Csv\.safeToCsv\(/.test(srv), 'الخادم يستخدم Csv.safeToCsv للتصدير');
    chk(/const Csv = require\(['"]\.\/csv['"]\)/.test(srv), 'server.js يستورد وحدة csv');
    chk(/until && wf2 && Array\.isArray\(wf2\.steps\)/.test(srv), 'preview يدعم until (معاينة خطوة)');
    chk(/res2\.previewedStep = until/.test(srv), 'preview يُعيد previewedStep');
    chk(policy.includes("'GET /api/workflows/output'"), 'output عام في وضع الاختبار');
    chk(policy.includes("'GET /api/workflows/output/csv'"), 'output/csv عام في وضع الاختبار');
  }

  chk(guard.count() === 0, 'صفر اتصال شبكة عبر كامل الاختبار');
  console.log(`\ndataset.test.js — pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
