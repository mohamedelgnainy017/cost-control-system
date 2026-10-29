'use strict';
/**
 * مستكشف النموذج (Model Explorer) + قاموس المعادلات (Formula Dictionary)
 * ======================================================================
 * يربط «فهرس البيانات» (src/data-catalog.js) بمرجع DAX القديم
 * (src/dax-reference.js) وبمعادلات المشروع الأصلية في بقية المجالات
 * (الحركات/المبيعات/الأرصدة/التكلفة) — فيصير لكل معادلة:
 *   اسمها · معناها · منطقها · مصادرها · تبعياتها · موضع تنفيذها · DAX مكافئها (إن وُجد)
 *   · حالة المطابقة · الفرق بين القيمة المستوردة والقيمة المحسوبة.
 *
 * قاعدة الأمانة: لا تُوصف أي معادلة بأنها «مطابقة رقميًا» دون اختبار مقارنة فعلي
 * موثّق — لذلك كل قيد يحمل numericVerified=false افتراضيًا.
 */

const CAT = require('./data-catalog');
const DAX = require('./dax-reference');

const MATCH = DAX.MATCH;

/* جداول نموذج العقود ← معرّاتها في فهرس البيانات */
const DAX_TABLE_MAP = {
  'تسجيل_العقود': 'contract_registrations', 'السداد': 'contract_payments', 'التحميل': 'contract_loading',
  'الربط': 'contract_hedge', 'الرولينج': 'contract_roll', 'الافراج': 'contract_release',
  'بيع_خارجى': 'contract_external_sales', 'الارصدة': 'contract_balances', 'الاصناف': 'contract_items',
};

/* =====================================================================
 * 1) معادلات المشروع الأصلية (خارج نطاق نموذج العقود)
 *    كل بند: منطق حقيقي مستخرج من الكود مع مسار تنفيذه.
 * ===================================================================== */
const NATIVE = [
  {
    id: 'cost.rule.detect', domain: CAT.DOMAINS.cost, name: 'قاعدة احتساب التكلفة',
    logic: 'إن كان عدد الحركات ذات move_indicator = \'L\' أكبر من صفر ⇒ القاعدة «مؤشر الحركة L»، وإلا «الحركات الصادرة» (direction LIKE \'%صادر%\').',
    inputs: ['movements.move_indicator', 'movement_types.direction'],
    sources: ['movements', 'movement_types'], location: 'src/analytics.js:16-35',
    status: MATCH.logical, note: 'قراءة فقط: لا تُكتب قاعدة التكلفة تلقائياً anymore.',
  },
  {
    id: 'cost.link', domain: CAT.DOMAINS.cost, name: 'طريقة إسناد التكلفة للمبيعات',
    logic: 'الطريقة الافتراضية doc_item: تُجمَّع حركات التكلفة لكل (المستند المرجع + الصنف) ثم تُوزَّع بالتساوي على بنود المبيعات المشتركة — فلا تتكرر التكلفة ولا تُفقد. طريقة place القديمة تجمع حسب المكان (وتقيّد الحركات بالمدى الزمني).',
    inputs: ['sales.ref_doc', 'sales.item', 'movements.doc_ref', 'movements.item'],
    sources: ['sales', 'movements'], location: 'src/analytics.js:78-128',
    status: MATCH.logical, note: 'الإعداد `cost_link` يُحفظ صراحةً من شاشة الإعدادات فقط (src/analytics.js:56).',
  },
  {
    id: 'sales.profit', domain: CAT.DOMAINS.sales, name: 'الربح ونسبة الربح',
    logic: 'profit = value − cost، marginPct = profit ÷ value (قيمة بند المبيعات بعد إسناد التكلفة).',
    inputs: ['value', 'cost'], sources: ['sales'], location: 'src/analytics.js:221-233',
    status: MATCH.logical,
  },
  {
    id: 'movements.net', domain: CAT.DOMAINS.movements, name: 'صافي الحركات بعد إسقاط الإلغاءات',
    logic: 'كل إلغاء يظهر كحركة لاحقة معاكسة بنفس القيم ⇒ تُجمَّع الحركات في «تسع دلاء» حسب (إشارة الكمية، إشارة القيمة) وتُلغى أزواج (++/--) و(+-/-+) و(+0/-0) و(0+/0-)؛ الباقي هو الحركة الحقيقية.',
    inputs: ['qty', 'amount', 'item', 'unit_code', 'storage_loc', 'place', 'move_type'],
    sources: ['movements'], location: 'src/analytics.js:336-395, 968-981',
    status: MATCH.logical, note: 'لا يغيّر صافي الكمية/القيمة — ينظّف العدد فقط.',
  },
  {
    id: 'inventory.move', domain: CAT.DOMAINS.inventory, name: 'حركة اليوم من الرصيد',
    logic: 'move_qty = close_qty − open_qty، move_val = close_val − open_val — على مستوى (صنف، مخزن، وحدة، تاريخ).',
    inputs: ['open_qty', 'close_qty', 'open_val', 'close_val'], sources: ['daily_balances'],
    location: 'src/analytics.js:471', status: MATCH.logical,
  },
  {
    id: 'cost.daily.engine', domain: CAT.DOMAINS.cost, name: 'محرك التكلفة اليومية',
    logic: 'للأصناف الثلاثة (1001 الذرة / 1002 الصويا / 1004 البذرة): سعر التكلفة × ريت الدولار + المصاريف، حيث سعر التكلفة بالدولار = (سعر البورصة + متوسط البريم) × معامل التحويل. لباقي الأصناف: Σ قيمة الرصيد ÷ Σ كمية الرصيد لكل (صنف، مصنع) في تاريخ الرصيد، وتُحمَّل للأمام حتى يصل رصيد أحدث.',
    inputs: ['borse.close', 'borse.usd_rate', 'balances.close_qty', 'balances.close_val', 'daily_costs.*'],
    sources: ['borse', 'daily_balances'], location: 'src/cost-engine.js + src/db.js:364-410',
    status: MATCH.logical, note: 'المُخرَج daily_costs (مفتاح: تاريخ × صنف × وحدة تشغيل)؛ الإجمالي daily_costs_total = متوسط مرجّح.',
  },
  {
    id: 'cost.daily.total', domain: CAT.DOMAINS.cost, name: 'إجمالي التكلفة اليومية (مصدر واحد)',
    logic: 'cost = Σ value ÷ Σ qty لكل (تاريخ × صنف) عبر المصانع؛ وإلا MAX(cost).',
    inputs: ['daily_costs.qty', 'daily_costs.value'], sources: ['daily_costs'], location: 'src/db.js:397-410 (VIEW daily_costs_total)',
    status: MATCH.logical, note: 'مصدر واحد لكل التحليلات ⇒ يمنع تكرار التكلفة عند دمج مستويات تفصيل مختلفة.',
  },
  {
    id: 'recon.diff', domain: CAT.DOMAINS.reconciliation, name: 'فرق مطابقة الرصيد',
    logic: 'مقارنة رصيد نهاية التاريخ السابق مع رصيد بداية التاريخ التالي لكل صنف + قيمة حركات الفترة؛ الفرق = الفرق بين الافتتاحي والمتحرك.',
    inputs: ['open_val', 'close_val', 'moves_val'], sources: ['recon', 'daily_balances'],
    location: 'src/analytics.js:1119-1216 + src/db.js:442-490',
    status: MATCH.logical, note: 'مُعبِّئ جدول recon غير معروف (مرجع BASELINE §B5) ⇒ يُقاس ولا يُفترض.',
  },
  {
    id: 'master.class.axis', domain: CAT.DOMAINS.master, name: 'محور التصنيف الموحّد (v_class)',
    logic: 'عرض يجمع التصنيف التعاقدي (contract_items.code) مع تصنيف ERP (items.group_code/class_code) ويحدّد kind (خامات/إضافات/أخرى) من الاتجاه ثم من class_erp_code (101/204=خامات، 102=إضافات).',
    inputs: ['contract_items.code', 'items.group_code', 'items.class_code'],
    sources: ['contract_items', 'items'], location: 'src/db.js:815-870 + src/analytics.js:611-655',
    status: MATCH.logical,
  },
  {
    id: 'formula.shared.registry', domain: CAT.DOMAINS.flows, name: 'طبقة المعادلات المشتركة (سجل مركزي)',
    logic: 'معادلة تُعرَّف مرة واحدة في سجل محفوظ (معرّف + نسخة + تعبير + حقول) وتُستخدم في Workflow Studio (خطوة compute) وفي Report Studio (مرجع قيمة لمكوّن) — بلا تكرار منطق الحساب. المحرّر البصري يبني نفس نص المحرّر المتقدم، والتقييم بمحرّك واحد (src/formulas.js — قائمة دوال مغلقة بلا eval).',
    inputs: ['حقول المصدر'], sources: ['daily_balances', 'movements', 'sales'],
    location: 'src/formula-store.js + src/formula-builder.js + src/formula-resolver.js',
    status: MATCH.tested,
    note: 'سلوك مثبت باختبارات اصطناعية (tests/unit/traceability.test.js) — لا مقارنة رقمية ببيانات الشركة.',
  },
  {
    id: 'contract.m.derivations', domain: CAT.DOMAINS.contracts, name: 'مشتقّات Power Query لعقود الاستيراد',
    logic: 'إعادة بناء ورقة «تسجيل العقود»: شهر كميات/شهر عربي، البريم CIF (FOB: الشحن÷0.393685 + البريم)، السعر CIF = متوسط سعر السداد + قيمة الشحن، كمية الربط التقديرى، موقف التسعير، موقف السداد، كمية/قيمة المطلوب سداده، حالة التجميع.',
    inputs: ['contract_registrations.*', 'contract_details.*', 'contract_hedge.*', 'contract_payments.*', 'contract_loading.*'],
    sources: ['contract_registrations', 'contract_details', 'contract_hedge', 'contract_payments', 'contract_loading'],
    location: 'src/pbix.js:125-264', status: MATCH.logical,
    note: 'مطابق لمنطق M في _handover/pbix-model/m-queries/M_تسجيل_العقود.m.',
  },
];

/* =====================================================================
 * 2) قيم مستوردة مقابل قيم محسوبة (في مصدر الأرصدة)
 * ===================================================================== */
const IMPORTED_VS_COMPUTED = [
  { field: 'days_enough', source: 'contract_balances', kind: 'مستورد', note: '«يكفى لمدة (بالايام)» من ورقة العقود — لا يُحسب من اليوم.' },
  { field: 'enough_until', source: 'contract_balances', kind: 'مستورد', note: '«حتى تاريخ» من ورقة العقود.' },
  { field: 'available_days', source: 'contract_balances', kind: 'محسوب', note: 'المتاح ÷ الاستهلاك (DAX: DIVIDE).' },
  { field: 'total_days', source: 'contract_balances', kind: 'محسوب', note: 'الإجمالي ÷ الاستهلاك.' },
  { field: 'available_add', source: 'contract_balances', kind: 'محسوب', note: 'اجمالى الرصيد + ميناء إضافات.' },
  { field: 'total_add', source: 'contract_balances', kind: 'محسوب', note: 'المتاح + تعاقدات إضافات.' },
  { field: 'current_cost', source: 'contract_balances', kind: 'محسوب', note: 'الريت اليومى × السعر بالدولار + المصاريف.' },
  { field: 'diff', source: 'contract_balances', kind: 'محسوب', note: 'سعر السوق − التكلفة الحالية.' },
  { field: 'move_qty', source: 'daily_balances', kind: 'محسوب', note: 'الرصيد الختامي − الافتتاحي (المصدر اليومي المعتمد).' },
  { field: 'move_val', source: 'daily_balances', kind: 'محسوب', note: 'قيمة الرصيد الختامي − الافتتاحي.' },
];

/* =====================================================================
 * 3) تحويل المقاييس إلى مصدر الأرصدة اليومية (مقترح — غير مطبَّق)
 * ===================================================================== */
const BALANCE_CONVERSIONS = [
  {
    measure: 'Active رصيد المصانع', currentSource: 'contract_balances (اجمالى الرصيد) + أرصدة المستودع اليومية (fallback)',
    proposedSource: 'daily_balances.close_qty',
    impact: 'يتغيّر رقم «رصيد التغطية» ⇒ يتغيّر معه Position وعدد الأيام وعدد العقود. تغيير جوهري في النتائج — لا يُطبَّق بلا موافقة.',
    status: 'مقترح — بانتظار قرار',
  },
  {
    measure: 'Active كمية الاستهلاك', currentSource: "contract_balances.الاستهلاك",
    proposedSource: 'daily_balances (close_qty − open_qty) كاستهلاك يومي للوحدة',
    impact: 'تغيير دلالي: «الاستهلاك» في ورقة العقود كمية مخزنية مُستوردة، وفي الأرصدة اليومية حركة اليوم. يلزم تعريف معتمد قبل التطبيق.',
    status: 'مقترح — بانتظار تعريف معتمد',
  },
  {
    measure: 'Active المتاح يكفى / Active الاجمالى يكفى',
    currentSource: 'قسمة على استهلاك ورقة العقود', proposedSource: 'قسمة على الاستهلاك اليومي من daily_balances',
    impact: 'مشتقّ عن القياسين السابقين — ينتقل أثرهما كما هو.', status: 'مقترح — بانتظار القياسين',
  },
];

/* =====================================================================
 * 4) العلاقات (مؤكدة / مقترحة)
 * ===================================================================== */
const PBIX_RELATIONS = [
  { from: 'السداد', to: 'تسجيل_العقود', key: 'الرقم الداخلي → الرقم داخلي', confidence: 'confirmed' },
  { from: 'السداد', to: 'الاصناف', key: 'الصنف → اسم الصنف', confidence: 'confirmed' },
  { from: 'التحميل', to: 'تسجيل_العقود', key: 'الرقم الداخلي → الرقم داخلي', confidence: 'confirmed' },
  { from: 'التحميل', to: 'الاصناف', key: 'الصنف → اسم الصنف', confidence: 'confirmed' },
  { from: 'الربط', to: 'تسجيل_العقود', key: 'الرقم الداخلي → الرقم داخلي', confidence: 'confirmed' },
  { from: 'الربط', to: 'الاصناف', key: 'الصنف → اسم الصنف', confidence: 'confirmed' },
  { from: 'الرولينج', to: 'تسجيل_العقود', key: 'الرقم الداخلي → الرقم داخلي', confidence: 'confirmed' },
  { from: 'الرولينج', to: 'الاصناف', key: 'الصنف → اسم الصنف', confidence: 'confirmed' },
  { from: 'الافراج', to: 'تسجيل_العقود', key: 'الرقم الداخلي → الرقم داخلي', confidence: 'confirmed' },
  { from: 'الافراج', to: 'الاصناف', key: 'الصنف → اسم الصنف', confidence: 'confirmed' },
  { from: 'بيع_خارجى', to: 'تسجيل_العقود', key: 'الرقم الداخلي → الرقم داخلي', confidence: 'confirmed' },
  { from: 'بيع_خارجى', to: 'الاصناف', key: 'الصنف → اسم الصنف', confidence: 'confirmed' },
  { from: 'الارصدة', to: 'الاصناف', key: 'كود الصنف → كود الصنف', confidence: 'confirmed' },
];

/* =====================================================================
 * 5) الواجهة العامة
 * ===================================================================== */

/** قاموس المعادلات: مرجع DAX + معادلات المشروع الأصلية */
function formulas(opts = {}) {
  const daxRows = [...DAX.MEASURES, ...DAX.COLUMNS].map(x => ({
    id: (x.kind === 'measure' ? 'dax.m.' : 'dax.c.') + x.table + '.' + x.name,
    kind: x.kind === 'measure' ? 'مقياس' : 'عمود محسوب',
    domain: CAT.DOMAINS.contracts,
    name: x.name, table: x.table, dax: x.dax, status: x.status, counterpart: x.counterpart,
    location: x.location, note: x.note, numericVerified: x.numericVerified,
    sources: x.kind === 'measure' ? ['contract_coverage'] : [DAX_TABLE_MAP[x.table] || 'contract_registrations'],
  }));
  const nativeRows = NATIVE.map(x => ({
    id: x.id, kind: 'معادلة مشروع', domain: x.domain, name: x.name, dax: null, status: x.status,
    counterpart: x.name, location: x.location, note: x.note || '', numericVerified: false,
    logic: x.logic, inputs: x.inputs, sources: x.sources,
  }));
  let all = [...daxRows, ...nativeRows];
  if (opts.domain) all = all.filter(x => x.domain === opts.domain);
  if (opts.status) all = all.filter(x => x.status === opts.status);
  if (opts.table) all = all.filter(x => x.table === opts.table);
  return all;
}

/** العلاقات: من الفهرس (كل مصدر) + علاقات نموذج العقود */
function relations() {
  const out = [];
  for (const s of CAT.SOURCES) {
    for (const r of s.relations) {
      out.push({
        from: s.id, fromLabel: s.label, to: r.target, toLabel: (CAT.getSource(r.target) || {}).label || r.target,
        leftKey: r.leftKey, rightKey: r.rightKey, direction: r.direction, confidence: r.confidence, note: r.note || '',
        scope: 'التطبيق',
      });
    }
  }
  for (const r of PBIX_RELATIONS) {
    const idMap = {
      'تسجيل_العقود': 'contract_registrations', 'الاصناف': 'contract_items', 'السداد': 'contract_payments',
      'التحميل': 'contract_loading', 'الربط': 'contract_hedge', 'الرولينج': 'contract_roll',
      'الافراج': 'contract_release', 'بيع_خارجى': 'contract_external_sales', 'الارصدة': 'contract_balances',
    };
    const from = idMap[r.from], to = idMap[r.to];
    if (!from || !to) continue;
    out.push({
      from, fromLabel: (CAT.getSource(from) || {}).label || from,
      to, toLabel: (CAT.getSource(to) || {}).label || to,
      leftKey: r.key.split('→')[0].trim(), rightKey: r.key.split('→')[1].trim(),
      direction: 'many-to-one', confidence: r.confidence,
      note: 'علاقة من نموذج Power BI القديم (13 علاقة) — أعيد بناؤها في src/pbix.js عبر تجميع الرقم الداخلي.',
      scope: 'نموذج العقود (Power BI)',
    });
  }
  return out;
}

/** حقول كل مصدر + أعمدة محسوبة */
function fields(sourceId) {
  const s = CAT.getSource(sourceId);
  if (!s) return [];
  return s.fields.map(f => ({
    ...f, source: s.id, sourceLabel: s.label, domain: s.domain,
    canonical: !!s.canonical,
  }));
}

/** ملخص شامل */
function summary() {
  const st = DAX.stats();
  return {
    sources: CAT.summary(),
    formulas: {
      total: formulas().length,
      daxMeasures: DAX.MEASURES.length,
      daxColumns: DAX.COLUMNS.length,
      native: NATIVE.length,
      byStatus: st.measures,
    },
    relations: relations().length,
    importedVsComputed: IMPORTED_VS_COMPUTED.length,
    numericVerified: 0,
  };
}

module.exports = {
  MATCH, NATIVE, IMPORTED_VS_COMPUTED, BALANCE_CONVERSIONS, PBIX_RELATIONS,
  formulas, relations, fields, summary,
};
