'use strict';
/**
 * فهرس البيانات الموحّد (Data Catalog) — المنصة التحليلية 12
 * ============================================================
 * مصدر واحد لحقيقة «ما البيانات المتاحة في التطبيق، وكيف تُقرأ، وما مستواها».
 *
 * القواعد الحاكمة:
 * - كل مصدر هنا **مُتحقَّق منه في الكود القائم** (اسم جدول/دالة/استعلام فعلي)،
 *   ولا يُضاف مصدر إلا بوجود مسار قراءة مُنفَّذ. المصدر بلا مسار قراءة
 *   يُسجَّل `status: 'documented'` أو `'unavailable'` ولا يُعرض كقابل للتشغيل.
 * - «الأرصدة اليومية» (جدول balances) هي **المصدر المعتمد** للأرصدة في كل تحليل
 *   جديد. `contract_balances` (أرصدة ورقة العقود) مصدر **موثق فقط** ل契約 القياس
 *   القديم، ولا يُستخدم كبديل عن الأرصدة اليومية.
 * - لا SQL من المستخدم: أسماء الجداول والحقول من قوائم ثابتة، والفلاتر معاملات
 *   مُعلَّمة، وكل قراءة مقيّدة بحدّ صفوف وبصلاحية.
 * - الاستيراد كسول: لا اتصال ولا استعلام وقت التحميل.
 */

const A = require('./analytics');
const DB = require('./db');
const M = require('./master');
const W = require('./workflow');

/* =====================================================================
 * 1) حالات المصدر والمجالات
 * ===================================================================== */
const STATUS = {
  implemented: 'منفّذ',       // مسار قراءة فعلي داخل الكود
  documented: 'موثق فقط',    // معرّف ومخطط معروفان، بلا مسار قراءة مستقل
  unavailable: 'غير متاح',   // غير قابل للوصول من التطبيق
  verify: 'يحتاج تحقق',     // مسار موجود لكن نتيجته لم تُقاس بعد
};

const DOMAINS = {
  market: 'الأسعار والبورصة',
  inventory: 'المخزون والأرصدة',
  cost: 'التكلفة والاستهلاك',
  sales: 'المبيعات',
  movements: 'الحركات',
  master: 'البيانات الأساسية',
  contracts: 'عقود الاستيراد',
  reconciliation: 'التسويات والمطابقة',
  flows: 'مخرجات التدفقات',
};

/* =====================================================================
 * 2) جداول العقود — قائمة بيضاء للقراءة الخام (أعمدة من src/db.js)
 * ===================================================================== */
const CONTRACT_TABLES = {
  contract_registrations: ['internal_no', 'contract_category', 'contract_type', 'contract_date', 'classification',
    'supplier', 'source_country', 'contracting_company', 'contract_no', 'quantity', 'contract_premium',
    'shipping_type', 'shipping_value', 'initial_price', 'contract_exchange', 'expected_payment_date',
    'contract_status', 'expected_cif_price', 'notes'],
  contract_details: ['internal_no', 'classification', 'source_country', 'external_company', 'internal_company',
    'contract_no', 'detail_quantity', 'vessel_name', 'arrival_port', 'expected_arrival', 'operation_start',
    'loading_duration', 'operation_end', 'contract_status', 'vessel_status', 'notes'],
  contract_payments: ['internal_no', 'payment_date', 'payment_company', 'item', 'supplier', 'contract_no',
    'internal_company', 'payment_type', 'price_type', 'payment_status', 'payment_quantity', 'payment_price',
    'exchange_rate', 'responsible_person', 'notes'],
  contract_loading: ['internal_no', 'loading_date', 'contract_no', 'item', 'vessel_name', 'loading_type',
    'loading_quantity', 'notes'],
  contract_hedge: ['internal_no', 'hedge_date', 'supplier', 'contract_no', 'item', 'contract_exchange',
    'contract_count', 'hedge_quantity', 'exchange_price', 'hedge_exchange', 'hedge_premium', 'hedge_price',
    'hedge_value', 'notes'],
  contract_roll: ['internal_no', 'roll_date', 'contract_no', 'supplier', 'item', 'roll_quantity',
    'contract_exchange', 'hedge_exchange', 'previous_exchange', 'rolling_exchange', 'rolling_price', 'notes'],
  contract_release: ['internal_no', 'release_date', 'contract_no', 'item', 'vessel_name', 'release_quantity',
    'release_type', 'notes'],
  contract_external_sales: ['internal_no', 'sale_date', 'contract_no', 'item', 'vessel_name', 'sale_quantity', 'notes'],
  contract_balances: ['report_date', 'item_code', 'item_name', 'unit', 'qty_sawaki', 'qty_waha', 'qty_ameriya',
    'qty_sahlia', 'total_balance', 'consumption_rate', 'days_enough', 'enough_until', 'contract_additions',
    'port_additions', 'consumption', 'lot', 'factor', 'daily_rate', 'expenses', 'price_usd', 'market_price'],
  contract_items: ['code', 'name', 'direction', 'lot', 'factor', 'material_code', 'material_desc', 'unit',
    'group_code', 'group_desc', 'class_code', 'class_desc', 'status'],
};

/** قراءة خام آمنة لجدول عقود من القائمة البيضاء (SELECT فقط + LIMIT) */
async function fetchContractTable(table, limit) {
  const cols = CONTRACT_TABLES[table];
  if (!cols) throw new Error('جدول عقود غير مسموح: ' + table);
  const lim = Math.max(1, Math.min(Number(limit) || 5000, 20000));
  return DB.all(`SELECT ${cols.join(', ')} FROM ${table} ORDER BY id LIMIT ${lim}`);
}

/* =====================================================================
 * 3) الحقول — وصف ثابت (لا استعلام) لكل مصدر
 * ===================================================================== */
const f = (name, type, description, origin) => ({ name, type, description, origin: origin || 'source' });
const d = (name, type, description, formula) => ({ name, type, description, origin: 'derived', formula });

/* =====================================================================
 * 4) المصادر
 * ===================================================================== */
const SOURCES = [];
const add = s => { SOURCES.push(s); return s; };

/* ---------- 4.1) تجريبي (ذاكرة — بلا قاعدة بيانات) ---------- */
add({
  id: 'synthetic',
  label: 'بيانات تجريبية (synthetic)',
  technical: 'memory:orders',
  domain: DOMAINS.flows,
  description: 'مصدر ذاكرة اصطناعي (5 صفوف) لاختبار محرك التدفقات دون أي اتصال.',
  status: STATUS.implemented,
  perm: null,
  grain: 'طلب واحد',
  rowKey: ['id'],
  timeGrain: 'none',
  canonical: false,
  access: { module: 'src/workflow.js', fn: 'syntheticFixture' },
  fields: [f('id', 'number', 'معرّف الطلب'), f('customerId', 'number', 'معرّف العميل'),
    f('qty', 'number', 'الكمية'), f('price', 'number', 'السعر'), f('note', 'string', 'ملاحظة')],
  relations: [],
  fetch: async () => W.syntheticFixture().sourceRows,
});

/* ---------- 4.2) البورصة اليومية (أسعار السوق) ---------- */
add({
  id: 'borse',
  label: 'البورصة اليومية (سعر السوق)',
  technical: 'borse',
  domain: DOMAINS.market,
  description: 'سعر الإغلاق اليومي لكل صنف مع ريت الدولار — مصدر التسعير المرجعي لأسواق الخامات.',
  status: STATUS.implemented,
  perm: 'sync',
  grain: 'صنف × يوم',
  rowKey: ['borse_date', 'item_code'],
  timeGrain: 'daily',
  canonical: false,
  access: { module: 'src/analytics.js', fn: 'borseSeries' },
  fields: [f('borse_date', 'date', 'تاريخ سعر البورصة'), f('item', 'string', 'اسم الصنف'),
    f('item_code', 'string', 'كود الصنف'), f('close', 'number', 'سعر الإغلاق'),
    f('usd_rate', 'number', 'ريت الدولار')],
  relations: [
    { target: 'items', leftKey: 'item_code', rightKey: 'code', direction: 'many-to-one', confidence: 'proposed',
      note: 'كود البورصة (4 خانات مثل 1001) فضاء مختلف عن كود صنف النظام (9 خانات) — الربط مقترح لا مؤكد.' },
  ],
  /* عينة ثابتة (وضع الاختبار/الوصف — بلا اتصال) */
  sample: [
    { borse_date: '2026-10-20', item: 'الذرة', item_code: '1001', close: 410.5, usd_rate: 50 },
    { borse_date: '2026-10-20', item: 'الصويا', item_code: '1002', close: 300.2, usd_rate: 50 },
    { borse_date: '2026-10-20', item: 'البذرة', item_code: '1004', close: 1120.0, usd_rate: 50 },
  ],
  fetch: st => A.borseSeries({ days: st.days, item: st.item }),
});

/* ---------- 4.3) الأرصدة اليومية — المصدر المعتمد ---------- */
add({
  id: 'daily_balances',
  label: 'الأرصدة اليومية (المصدر المعتمد للأرصدة)',
  technical: 'balances',
  domain: DOMAINS.inventory,
  description: 'رصيد افتتاحي/ختامي لكل (صنف × مخزن × وحدة تشغيل) في كل تاريخ رصيد — المصدر الذي تعتمد عليه '
    + 'شاشة المخزون وكل تحليل التغطية والاستهلاك الجديد. مفتاح الصف: (balance_date, item, storage_loc, unit_code).',
  status: STATUS.implemented,
  perm: 'sync',
  grain: 'صنف × مخزن × وحدة تشغيل × تاريخ رصيد',
  rowKey: ['balance_date', 'item', 'storage_loc', 'unit_code'],
  timeGrain: 'daily',
  canonical: true,
  canonicalFor: 'الأرصدة، التغطية، الاستهلاك',
  access: { module: 'src/analytics.js', fn: 'inventoryDetail' },
  fields: [
    f('balance_date', 'date', 'تاريخ الرصيد'), f('item', 'string', 'كود الصنف'),
    f('item_desc', 'string', 'وصف الصنف'), f('uom', 'string', 'الوحدة الأساسية'),
    f('unit_code', 'string', 'وحدة التشغيل/المصنع'), f('storage_loc', 'string', 'المخزن'),
    f('place', 'string', 'المكان'), f('company_code', 'string', 'كود الشركة'), f('material_type', 'string', 'نوع المادة'),
    f('class_code', 'string', 'كود التصنيف'), f('cls', 'string', 'التصنيف (محسوب من items)'),
    f('group_code', 'string', 'كود المجموعة'), f('grp', 'string', 'المجموعة (محسوبة من items)'),
    f('open_qty', 'number', 'الرصيد الافتتاحي (كمية)'), f('open_val', 'number', 'الرصيد الافتتاحي (قيمة)'),
    f('close_qty', 'number', 'الرصيد الختامي (كمية)'), f('close_val', 'number', 'الرصيد الختامي (قيمة)'),
    d('move_qty', 'number', 'حركة اليوم = الرصيد الختامي − الافتتاحي', 'close_qty − open_qty'),
    d('move_val', 'number', 'قيمة حركة اليوم', 'close_val − open_val'),
  ],
  relations: [
    { target: 'items', leftKey: 'item', rightKey: 'code', direction: 'many-to-one', confidence: 'confirmed',
      note: 'مؤكد: src/analytics.js:450 (INV_JOIN) يربط balances.item = items.code.' },
    { target: 'locations', leftKey: 'unit_code', rightKey: 'unit_code', direction: 'many-to-one', confidence: 'confirmed',
      note: 'مؤكد: src/analytics.js:508 يربط b.unit_code = locations.unit_code.' },
  ],
  /* عينة ثابتة توضّح دلالة التاريخ والصنف والموقع والكمية (بلا اتصال) */
  sample: [
    { balance_date: '2026-10-12', item: '100100001', item_desc: 'ذرة', uom: 'KG', unit_code: 'EL01',
      storage_loc: 'Z112-05-01', place: 'السواقي', company_code: 'C01', material_type: 'خام',
      class_code: '101', cls: 'خامات', group_code: '1001', grp: 'الذرة',
      open_qty: 1200, open_val: 480000, close_qty: 1500, close_val: 600000, move_qty: 300, move_val: 120000 },
    { balance_date: '2026-10-12', item: '100200001', item_desc: 'صويا', uom: 'KG', unit_code: 'EL01',
      storage_loc: 'Z112-05-01', place: 'السواقي', company_code: 'C01', material_type: 'خام',
      class_code: '101', cls: 'خامات', group_code: '1002', grp: 'الصويا',
      open_qty: 800, open_val: 240000, close_qty: 640, close_val: 192000, move_qty: -160, move_val: -48000 },
  ],
  fetch: st => A.inventoryDetail(st.F || {}, st.limit),
});

/* ---------- 4.4) الحركات ---------- */
add({
  id: 'movements',
  label: 'حركات المخزن',
  technical: 'movements',
  domain: DOMAINS.movements,
  description: 'كل حركات الترحيل (وارد/صادر) بإشاراتها وقيمها — الأساس الذي تُبنى منه مطابقة الأرصدة وتكلفة المبيعات.',
  status: STATUS.implemented,
  perm: 'sync',
  grain: 'حركة واحدة (بند مستند × صنف × وحدة × مخزن)',
  rowKey: ['doc_ref', 'item', 'unit_code', 'storage_loc', 'post_date'],
  timeGrain: 'daily',
  canonical: false,
  access: { module: 'src/analytics.js', fn: 'movementsDetail' },
  fields: [f('post_date', 'date', 'تاريخ الترحيل'), f('item', 'string', 'كود الصنف'),
    f('item_desc', 'string', 'وصف الصنف'), f('uom', 'string', 'الوحدة'), f('move_type', 'string', 'نوع الحركة'),
    f('direction', 'string', 'الاتجاه (وارد/صادر)'), f('qty', 'number', 'الكمية'), f('amount', 'number', 'القيمة'),
    f('doc_ref', 'string', 'المستند المرجع'), f('purchase_order', 'string', 'أمر الشراء'),
    f('supplier', 'string', 'المورد'), f('customer', 'string', 'العميل'),
    f('unit_code', 'string', 'وحدة التشغيل'), f('storage_loc', 'string', 'المخزن'), f('place', 'string', 'المكان'),
    f('company_code', 'string', 'كود الشركة'), f('currency', 'string', 'العملة'),
    d('net_qty', 'number', 'الكمية الصافية بعد إسقاط الإلغاءات', 'SUM(qty) مع حذف أزواج الإلغاء'),
    d('net_amount', 'number', 'القيمة الصافية بعد إسقاط الإلغاءات', 'SUM(amount) مع حذف أزواج الإلغاء')],
  relations: [
    { target: 'items', leftKey: 'item', rightKey: 'code', direction: 'many-to-one', confidence: 'confirmed',
      note: 'مؤكد: نفس بُعد الصنف في كل شاشات الحركات.' },
    { target: 'sales', leftKey: 'doc_ref', rightKey: 'ref_doc', direction: 'many-to-one', confidence: 'confirmed',
      note: 'مؤكد: src/analytics.js:102-106 (طريقة الربط doc_item) + secondary key item.' },
  ],
  fetch: st => A.movementsDetail(st.F || {}, st.limit),
});

/* ---------- 4.5) المبيعات ---------- */
add({
  id: 'sales',
  label: 'المبيعات (بنود الفواتير)',
  technical: 'sales',
  domain: DOMAINS.sales,
  description: 'بنود المبيعات بعد إسناد التكلفة بالطريقة المعتمدة (المستند المرجع + الصنف) — يشمل التكلفة والربح.',
  status: STATUS.implemented,
  perm: 'sync',
  grain: 'بند فاتورة × صنف × مخزن × وحدة',
  rowKey: ['invoice_doc', 'item', 'unit_code', 'storage_loc'],
  timeGrain: 'daily',
  canonical: false,
  access: { module: 'src/analytics.js', fn: 'salesDetail' },
  fields: [f('item', 'string', 'كود الصنف'), f('item_desc', 'string', 'وصف الصنف'), f('uom', 'string', 'الوحدة'),
    f('cls', 'string', 'التصنيف'), f('group_code', 'string', 'كود المجموعة'), f('grp', 'string', 'المجموعة'),
    f('storage_loc', 'string', 'المخزن'), f('unit_code', 'string', 'وحدة التشغيل'), f('place', 'string', 'المكان'),
    f('company_code', 'string', 'كود الشركة'), f('currency', 'string', 'العملة'),
    f('lines', 'number', 'عدد أسطر البند'), f('qty', 'number', 'الكمية'), f('value', 'number', 'القيمة'),
    f('cost', 'number', 'التكلفة المنسوبة'), f('matched_lines', 'number', 'أسطر لها حركة مقابلة'),
    d('profit', 'number', 'الربح', 'value − cost'),
    d('marginPct', 'number', 'نسبة الربح %', 'profit ÷ value')],
  relations: [
    { target: 'items', leftKey: 'item', rightKey: 'code', direction: 'many-to-one', confidence: 'confirmed',
      note: 'مؤكد: src/analytics.js:136-139 (SALES_JOIN).' },
    { target: 'locations', leftKey: 'unit_code', rightKey: 'unit_code', direction: 'many-to-one', confidence: 'confirmed',
      note: 'مؤكد: نفس الـJOIN.' },
    { target: 'movements', leftKey: 'ref_doc', rightKey: 'doc_ref', direction: 'one-to-many', confidence: 'confirmed',
      note: 'مؤكد: إسناد التكلفة بالمستند المرجع + الصنف (src/analytics.js:102-107).' },
  ],
  fetch: st => A.salesDetail(st.F || {}, st.limit),
});

/* ---------- 4.6) التسويات والمطابقة ---------- */
add({
  id: 'recon',
  label: 'مطابقة الأرصدة (تسويات)',
  technical: 'recon',
  domain: DOMAINS.reconciliation,
  description: 'مطابقة رصيد نهاية كل تاريخ سابق مع بداية التاريخ التالي لكل صنف — جدول مُعبّأ خارج الكود (مرجع BASELINE §B5).',
  status: STATUS.implemented,
  perm: 'sync',
  grain: 'صنف × تاريخ',
  rowKey: ['item', 'prev_date'],
  timeGrain: 'daily',
  canonical: false,
  access: { module: 'src/analytics.js', fn: 'reconcile' },
  fields: [f('item', 'string', 'كود الصنف'), f('prev_date', 'date', 'تاريخ الرصيد السابق'),
    f('next_date', 'date', 'تاريخ الرصيد التالي'), f('open_val', 'number', 'قيمة الرصيد الافتتاحي'),
    f('close_val', 'number', 'قيمة الرصيد الختامي'), f('moves_val', 'number', 'قيمة حركات الفترة'),
    f('diff_val', 'number', 'الفرق بين الرصيد الافتتاحي وحركة الفترة')],
  relations: [],
  fetch: st => A.reconcile({ limit: st.limit || 500, F: st.F || {} }),
});

/* ---------- 4.7) تغطية العقود (مقاييس Power BI المعاد بناؤها) ---------- */
add({
  id: 'contract_coverage',
  label: 'تغطية عقود الاستيراد (مقاييس نموذج Power BI)',
  technical: 'analytics.contractCoverage',
  domain: DOMAINS.contracts,
  description: 'صف لكل تصنيف تعاقدي يجمع مقاييس النموذج: رصيد التغطية، المدفوع بدون تسعير، رصيد المصانع، '
    + 'المتاح/الإجمالي يكفى، التكلفة الحالية والفرق. هذه المقاييس تعتمد «رصيد المصانع» على أرصدة المستودع اليومية '
    + 'وعلى ورقة أرصدة العقود ⇒ راجع قاموس المعادلات قبل الاعتماد الرقمي.',
  status: STATUS.implemented,
  perm: 'sync',
  grain: 'تصنيف تعاقدي',
  rowKey: ['cls'],
  timeGrain: 'snapshot',
  canonical: false,
  access: { module: 'src/analytics.js', fn: 'contractCoverage' },
  fields: [f('cls', 'string', 'التصنيف'), f('class_code', 'string', 'كود التصنيف'), f('class_desc', 'string', 'وصف التصنيف'),
    f('direction', 'string', 'الاتجاه'), f('kind', 'string', 'نوع التصنيف (خامات/إضافات/أخرى)'),
    f('contracts', 'number', 'عدد العقود (عدد صفوف تسجيل) — ليس مقياس «Active عدد العقود»'),
    f('contracted', 'number', 'كمية التعاقد'), f('hedged', 'number', 'كمية الربط'),
    f('remaining_open', 'number', 'المتبقي من الكمية المفتوحة'), f('paid', 'number', 'المدفوع'),
    f('released', 'number', 'المفرج عنه'), f('paid_unpriced', 'number', 'المدفوع بدون تسعير'),
    f('paid_not_opened', 'number', 'المدفوع وغير المفتوح'), f('sold', 'number', 'المباع'),
    f('balance', 'number', 'إجمالي الرصيد'), f('factory', 'number', 'رصيد المصانع'),
    f('port', 'number', 'رصيد متاح الميناء'), f('coverage_balance', 'number', 'رصيد التغطية'),
    f('position', 'number', 'إجمالي الرصيد (ليس مقياس Position النصي)'),
    f('consumption', 'number', 'الاستهلاك'), f('contract_additions', 'number', 'تعاقدات إضافات'),
    f('port_additions', 'number', 'ميناء إضافات'), f('items_total', 'number', 'الإجمالي الكلي'),
    f('balance_raw', 'number', 'اجمالى الرصيد (من ورقة العقود)'),
    f('available_days', 'number', 'أيام التغطية المتاح'), f('total_days', 'number', 'أيام التغطية الإجمالي'),
    f('net_premium', 'number', 'متوسط مرجّح لبريم الربط (عرض فقط)'), f('max_bourse', 'number', 'أعلى سعر بورصة (متوسط)'),
    f('days_enough', 'number', 'يكفى لمدة (مستورد من ورقة العقود)'), f('enough_until', 'string', 'حتى تاريخ (مستورد)'),
    f('daily_rate', 'number', 'الريت اليومي'), f('price_usd', 'number', 'السعر بالدولار'),
    f('current_cost', 'number', 'التكلفة الحالية'), f('market_price', 'number', 'سعر السوق'), f('diff', 'number', 'الفرق')],
  relations: [
    { target: 'contract_registrations', leftKey: 'cls', rightKey: 'classification', direction: 'many-to-one',
      confidence: 'confirmed', note: 'مؤكد: src/analytics.js:743-744 (تصنيف العقود هو محور المحور).' },
    { target: 'items', leftKey: 'class_code', rightKey: 'group_code', direction: 'many-to-one', confidence: 'confirmed',
      note: 'مؤكد: v_class في src/db.js:821.' },
  ],
  fetch: st => A.contractCoverage(st.F || {}).then(r => r.rows),
});

/* ---------- 4.8) التسجيل والتفصيل الموحّد ---------- */
add({
  id: 'contract_unified',
  label: 'عقود الاستيراد — تسجيل + تفصيل (موحّد)',
  technical: 'analytics.contractUnified',
  domain: DOMAINS.contracts,
  description: 'صف لكل عقد في وضع «تجميعى»، أو صف لكل بند تفصيلي (باخرة/ميناء وصول/شركات) في وضع «تفصيلي».',
  status: STATUS.implemented,
  perm: 'sync',
  grain: 'عقد (تجميعي) أو بند تفصيلي',
  rowKey: ['internal_no'],
  timeGrain: 'event',
  canonical: false,
  access: { module: 'src/analytics.js', fn: 'contractUnified' },
  fields: [f('internal_no', 'string', 'الرقم الداخلي'), f('contract_date', 'date', 'تاريخ التعاقد'),
    f('classification', 'string', 'التصنيف'), f('supplier', 'string', 'المورد'),
    f('contract_no', 'string', 'رقم العقد'), f('detail_lines', 'number', 'عدد بنود التفصيل')],
  relations: [],
  fetch: st => A.contractUnified(st.F || {}),
});

/* ---------- 4.9) جداول العقود الخام (قراءة من القائمة البيضاء) ---------- */
for (const [table, cols] of Object.entries(CONTRACT_TABLES)) {
  if (table === 'contract_balances' || table === 'contract_items') continue;   /* لهما تعريفان خاصان أدناه */
  add({
    id: table,
    label: 'عقود — ' + table.replace('contract_', ''),
    technical: table,
    domain: DOMAINS.contracts,
    description: 'قراءة خام من جدول ' + table + ' (نفس مصدر ورقة Excel لعقود الاستيراد).',
    status: STATUS.implemented,
    perm: 'sync',
    grain: 'صف من الجدول',
    rowKey: table === 'contract_items' ? ['code'] : ['internal_no'],
    timeGrain: 'event',
    canonical: false,
    access: { module: 'src/data-catalog.js', fn: 'fetchContractTable' },
    fields: cols.map(c => f(c, 'string', 'عمود خام من ' + table)),
    relations: [
      { target: 'contract_registrations', leftKey: 'internal_no', rightKey: 'internal_no', direction: 'many-to-one',
        confidence: 'confirmed', note: 'مؤكد: الرقم الداخلي هو مفتاح الربط بين أوراق الملف (M_تسجيل_العقود.m).' },
    ],
    fetch: st => fetchContractTable(table, st.limit),
  });
}

/* ---------- 4.10) أرصدة ورقة العقود — موثق فقط (ليس المرجع) ---------- */
add({
  id: 'contract_balances',
  label: 'أرصدة ورقة العقود (موثق — ليس المرجع المعتمد)',
  technical: 'contract_balances',
  domain: DOMAINS.contracts,
  description: 'أرصدة ورقة «الارصدة» في ملف العقود (مصانع/موانئ/تغطية). تحتوي أعمدة يستوردها الملف (يكفى لمدة، '
    + 'حتى تاريخ) وأعمدة محسوبة (تكلفة حالية، الفرق). هذه ليست الأرصدة اليومية للمخزن — استخدم «الأرصدة اليومية» '
    + 'للتحليلات الجديدة. محفوظة لأن المقاييس القديمة تستند إليها.',
  status: STATUS.implemented,
  perm: 'sync',
  grain: 'صنف × تاريخ تقرير',
  rowKey: ['item_code', 'report_date'],
  timeGrain: 'daily',
  canonical: false,
  canonicalNote: 'غير معتمد — المرجع المعتمد هو daily_balances',
  /* مصدر قديم (ورقة العقود): لا يُعرض في «تقرير السريع» حتى لا يُبنى تقرير على غير المرجع */
  quickReport: false,
  access: { module: 'src/data-catalog.js', fn: 'fetchContractTable' },
  fields: [
    f('report_date', 'date', 'تاريخ التقرير'), f('item_code', 'string', 'كود الصنف'),
    f('item_name', 'string', 'اسم الصنف'), f('unit', 'string', 'الوحدة'),
    f('total_balance', 'number', 'اجمالى الرصيد'), f('consumption', 'number', 'الاستهلاك'),
    f('consumption_rate', 'number', 'معدل الاستهلاك'),
    f('days_enough', 'number', 'يكفى لمدة (بالايام) — قيمة مستوردة من الملف'),
    f('enough_until', 'string', 'حتى تاريخ — قيمة مستوردة من الملف'),
    f('contract_additions', 'number', 'تعاقدات إضافات'), f('port_additions', 'number', 'ميناء إضافات'),
    f('lot', 'number', 'اللوط'), f('factor', 'number', 'المعامل'),
    f('daily_rate', 'number', 'الريت اليومى'), f('expenses', 'number', 'المصاريف'),
    f('price_usd', 'number', 'السعر بالدولار'), f('market_price', 'number', 'سعر السوق'),
    d('available_add', 'number', 'كمية المتاح إضافات', 'total_balance + port_additions'),
    d('total_add', 'number', 'الاجمالى الكلى', 'available_add + contract_additions'),
    d('available_days', 'number', 'المتاح يكفى', 'available_add ÷ consumption'),
    d('total_days', 'number', 'الاجمالى يكفى', 'total_add ÷ consumption'),
    d('current_cost', 'number', 'تكلفة حالية', 'daily_rate × price_usd + expenses'),
    d('diff', 'number', 'الفرق', 'market_price − current_cost'),
  ],
  relations: [
    { target: 'contract_items', leftKey: 'item_code', rightKey: 'code', direction: 'many-to-one', confidence: 'confirmed',
      note: 'مؤكد: _handover/LINK-BASELINE.md §3.' },
  ],
  fetch: st => fetchContractTable('contract_balances', st.limit),
});

/* ---------- 4.11) أصناف العقود (مرجع التصنيف التعاقدي) ---------- */
add({
  id: 'contract_items',
  label: 'أصناف العقود (التصنيف التعاقدي)',
  technical: 'contract_items',
  domain: DOMAINS.master,
  description: 'مرجع التصنيفات التعاقدية (اسم الصنف/الكود/الاتجاه/اللوط/المعامل) — حلقة الوصل بين أوراق العقود '
    + 'ومجموعات ERP عبر v_class.',
  status: STATUS.implemented,
  perm: 'sync',
  grain: 'تصنيف واحد',
  rowKey: ['code'],
  timeGrain: 'none',
  canonical: false,
  access: { module: 'src/data-catalog.js', fn: 'fetchContractTable' },
  fields: CONTRACT_TABLES.contract_items.map(c => f(c, 'string', 'عمود مرجعي من contract_items')),
  relations: [
    { target: 'items', leftKey: 'code', rightKey: 'group_code', direction: 'one-to-one', confidence: 'confirmed',
      note: 'مؤكد: _handover/LINK-BASELINE.md §2 + v_class (src/db.js:821).' },
  ],
  fetch: st => fetchContractTable('contract_items', st.limit),
});

/* ---------- 4.12) البيانات الأساسية ---------- */
add({
  id: 'items',
  label: 'أصناف النظام والمجموعات والتصنيفات',
  technical: 'items',
  domain: DOMAINS.master,
  description: 'كتالوج أصناف النظام (kind=item) — بُعد الصنف في كل شاشات الحركات والأرصدة والمبيعات. '
    + 'المجموعات والتصنيفات صفوف في نفس الجدول بـkind مختلف (تُقرأ بـlistGroups/listClasses).',
  status: STATUS.implemented,
  perm: 'sync',
  grain: 'صنف واحد',
  rowKey: ['code'],
  timeGrain: 'none',
  canonical: false,
  access: { module: 'src/master.js', fn: 'listItems' },
  fields: [f('code', 'string', 'كود الصنف'), f('descr', 'string', 'وصف الصنف'), f('uom', 'string', 'الوحدة'),
    f('group_code', 'string', 'كود المجموعة'), f('group_desc', 'string', 'المجموعة'),
    f('class_code', 'string', 'كود التصنيف'), f('class_desc', 'string', 'التصنيف'),
    f('origin', 'string', 'مصدر الصنف (mine/movement/erp)'), f('source_file', 'string', 'ملف المصدر')],
  relations: [],
  fetch: st => M.listItems({ limit: st.limit || 20000 }),
});

add({
  id: 'locations',
  label: 'المواقع والمصانع والوحدات',
  technical: 'locations',
  domain: DOMAINS.master,
  description: 'وحدات التشغيل/المصانع وربطها بالشركة والمكان والعملة — بُعد الشركة في كل شاشات الحركات والأرصدة والمبيعات.',
  status: STATUS.implemented,
  perm: 'sync',
  grain: 'وحدة تشغيل واحدة',
  rowKey: ['unit_code'],
  timeGrain: 'none',
  canonical: false,
  access: { module: 'src/master.js', fn: 'listLocations' },
  fields: [f('unit_code', 'string', 'كود الوحدة'), f('unit_name', 'string', 'اسم الوحدة'),
    f('company_code', 'string', 'كود الشركة'), f('company_name', 'string', 'اسم الشركة'),
    f('place', 'string', 'المكان'), f('currency', 'string', 'العملة')],
  relations: [],
  /* listLocations() يعيد {companies, units, warehouses} — نُبقي صف الوحدة فقط (صفوف فعلية) */
  fetch: async st => {
    const o = await M.listLocations();
    return (o.units || []).map(u => ({
      unit_code: u.code, unit_name: u.unit_name, company_code: u.company_code,
      company_name: u.company_name, currency: u.currency, place: u.place,
    }));
  },
});

  /* =====================================================================
   4.12.b) جداول موثّقة من مخطط المشروع (DDL في src/db.js) — بلا مسار قراءة مستقل
   ---------------------------------------------------------------------
   أُضيفت لفهرسة الأصول المتاحة في النظام: تعريفها وأعمدتها مثبتة من مخطط
   الكود (بلا اتصال بقاعدة البيانات)، وتُقرأ عبر مسارات التطبيق القائمة
   (الأسعار والتكلفة والبيانات الأساسية) أو عبر تقارير العقود الخام.
   ===================================================================== */
  add({
    id: 'prices',
    label: 'الأسعار اليومية (التكلفة)',
    technical: 'prices',
    domain: DOMAINS.market,
    description: 'سجل الأسعار اليومية (التكلفة الواردة) لكل صنف — يُقرأ عبر مسارات الأسعار/الاستيراد.',
    status: STATUS.documented,
    perm: 'sync',
    grain: 'صنف × تاريخ سعر',
    rowKey: ['price_date', 'item_code'],
    timeGrain: 'daily',
    canonical: false,
    access: { module: 'src/db.js', fn: 'prices' },
    fields: [
      f('id', 'number', 'معرّف السجل'), f('price_date', 'string', 'تاريخ السعر'),
      f('item_code', 'string', 'كود الصنف'), f('item', 'string', 'اسم الصنف'),
      f('cost_land', 'number', 'التكلفة'), f('source_row', 'number', 'رقم الصف في الملف'),
      f('import_id', 'number', 'معرّف عملية الاستيراد'), f('source_file', 'string', 'ملف المصدر'),
    ],
    relations: [],
  });
  add({
    id: 'price_overrides',
    label: 'تعديلات الأسعار اليدوية',
    technical: 'price_overrides',
    domain: DOMAINS.market,
    description: 'تعديلات يدوية على الأسعار بتاريخ سريان — تُقرأ عبر مسارات الأسعار.',
    status: STATUS.documented,
    perm: 'sync',
    grain: 'صنف × حقل × تاريخ سريان',
    rowKey: ['item_code', 'field', 'eff_date'],
    timeGrain: 'daily',
    canonical: false,
    access: { module: 'src/db.js', fn: 'price_overrides' },
    fields: [
      f('id', 'number', 'معرّف التعديل'), f('item_code', 'string', 'كود الصنف'),
      f('eff_date', 'date', 'تاريخ السريان'), f('field', 'string', 'الحقل المعدَّل'),
      f('created_by', 'number', 'أنشأه المستخدم'), f('created_at', 'date', 'وقت الإنشاء'),
    ],
    relations: [],
  });
  add({
    id: 'borse_overrides',
    label: 'تعديلات البورصة اليدوية',
    technical: 'borse_overrides',
    domain: DOMAINS.market,
    description: 'تعديلات يدوية على أسعار البورصة بتاريخ سريان.',
    status: STATUS.documented,
    perm: 'sync',
    grain: 'صنف × حقل × تاريخ سريان',
    rowKey: ['item_code', 'field', 'eff_date'],
    timeGrain: 'daily',
    canonical: false,
    access: { module: 'src/db.js', fn: 'borse_overrides' },
    fields: [
      f('id', 'number', 'معرّف التعديل'), f('item_code', 'string', 'كود الصنف'),
      f('eff_date', 'date', 'تاريخ السريان'), f('field', 'string', 'الحقل المعدَّل'),
      f('created_by', 'number', 'أنشأه المستخدم'), f('created_at', 'date', 'وقت الإنشاء'),
    ],
    relations: [],
  });
  add({
    id: 'daily_costs',
    label: 'تكلفة يومية (مصدر مستورد)',
    technical: 'daily_costs',
    domain: DOMAINS.cost,
    description: 'التكلفة اليومية المستوردة لكل صنف — مصدر بديل لأسعار التكلفة (ليس المرجع المعتمد للأرصدة).',
    status: STATUS.documented,
    perm: 'sync',
    grain: 'صنف × تاريخ تكلفة',
    rowKey: ['cost_date', 'item_code'],
    timeGrain: 'daily',
    canonical: false,
    access: { module: 'src/db.js', fn: 'daily_costs' },
    fields: [
      f('id', 'number', 'معرّف السجل'), f('cost_date', 'string', 'تاريخ التكلفة'),
      f('item_code', 'string', 'كود الصنف'), f('item', 'string', 'اسم الصنف'),
      f('unit_code', 'string', 'كود الوحدة'),
    ],
    relations: [],
  });
  add({
    id: 'movement_types',
    label: 'أنواع الحركات',
    technical: 'movement_types',
    domain: DOMAINS.master,
    description: 'أنواع الحركات واتجاهها — بيانات أساسية تُقرأ عبر مسارات البيانات الأساسية.',
    status: STATUS.documented,
    perm: null,
    grain: 'نوع حركة',
    rowKey: ['type_code'],
    timeGrain: 'none',
    canonical: false,
    access: { module: 'src/master.js', fn: 'listMovementTypes' },
    fields: [
      f('type_code', 'string', 'كود نوع الحركة'), f('direction', 'string', 'الاتجاه'),
      f('source_file', 'string', 'ملف المصدر'),
    ],
    relations: [],
  });
  add({
    id: 'item_groups',
    label: 'مجموعات الأصناف',
    technical: 'item_groups',
    domain: DOMAINS.master,
    description: 'مجموعات الأصناف (التصنيف الأعلى) — تُقرأ عبر مسارات البيانات الأساسية.',
    status: STATUS.documented,
    perm: null,
    grain: 'مجموعة',
    rowKey: ['code'],
    timeGrain: 'none',
    canonical: false,
    access: { module: 'src/master.js', fn: 'listItemGroups' },
    fields: [
      f('code', 'string', 'كود المجموعة'), f('descr', 'string', 'الوصف'),
      f('updated_at', 'date', 'آخر تحديث'),
    ],
    relations: [],
  });
  add({
    id: 'item_classes',
    label: 'تصنيفات الأصناف',
    technical: 'item_classes',
    domain: DOMAINS.master,
    description: 'تصنيفات الأصناف — تُقرأ عبر مسارات البيانات الأساسية.',
    status: STATUS.documented,
    perm: null,
    grain: 'تصنيف',
    rowKey: ['code'],
    timeGrain: 'none',
    canonical: false,
    access: { module: 'src/master.js', fn: 'listItemClasses' },
    fields: [
      f('code', 'string', 'كود التصنيف'), f('descr', 'string', 'الوصف'),
      f('updated_at', 'date', 'آخر تحديث'),
    ],
    relations: [],
  });
  add({
    id: 'companies',
    label: 'الشركات (المصدر الموحد)',
    technical: 'companies',
    domain: DOMAINS.master,
    description: 'الشركات الداخلية والخارجية — المصدر الموحّد لجميع العقود والمواقع.',
    status: STATUS.documented,
    perm: null,
    grain: 'شركة',
    rowKey: ['company_code'],
    timeGrain: 'none',
    canonical: false,
    access: { module: 'src/master.js', fn: 'listCompanies' },
    fields: [
      f('company_code', 'string', 'كود الشركة'), f('company_name', 'string', 'اسم الشركة'),
      f('currency', 'string', 'العملة'), f('updated_at', 'date', 'آخر تحديث'),
    ],
    relations: [],
  });
  add({
    id: 'warehouses',
    label: 'المخازن',
    technical: 'warehouses',
    domain: DOMAINS.master,
    description: 'المخازن ووحداتها التشغيلية — تُقرأ عبر مسارات البيانات الأساسية.',
    status: STATUS.documented,
    perm: null,
    grain: 'مخزن',
    rowKey: ['code'],
    timeGrain: 'none',
    canonical: false,
    access: { module: 'src/master.js', fn: 'listWarehouses' },
    fields: [
      f('code', 'string', 'كود المخزن'), f('name', 'string', 'الاسم'),
      f('unit_code', 'string', 'الوحدة التشغيلية'), f('company_code', 'string', 'الشركة'),
      f('place', 'string', 'المكان'), f('updated_at', 'date', 'آخر تحديث'),
      f('source_file', 'string', 'ملف المصدر'),
    ],
    relations: [],
  });
  add({
    id: 'contract_suppliers',
    label: 'موردو العقود',
    technical: 'contract_suppliers',
    domain: DOMAINS.contracts,
    description: 'موردو العقود (مرجع تصنيفي) — تُقرأ عبر تقرير «موردو العقود (خام)».',
    status: STATUS.documented,
    perm: null,
    grain: 'مورد',
    rowKey: ['code'],
    timeGrain: 'none',
    canonical: false,
    access: { module: 'src/server.js', fn: 'contract-suppliers-raw' },
    fields: [
      f('code', 'string', 'كود المورد'), f('name', 'string', 'الاسم'),
      f('source_file', 'string', 'ملف المصدر'), f('updated_at', 'date', 'آخر تحديث'),
    ],
    relations: [],
  });
  add({
    id: 'contract_ports',
    label: 'موانئ العقود',
    technical: 'contract_ports',
    domain: DOMAINS.contracts,
    description: 'موانئ العقود (مرجع تصنيفي) — تُقرأ عبر تقرير «موانئ العقود (خام)».',
    status: STATUS.documented,
    perm: null,
    grain: 'ميناء',
    rowKey: ['code'],
    timeGrain: 'none',
    canonical: false,
    access: { module: 'src/server.js', fn: 'contract-ports-raw' },
    fields: [
      f('code', 'string', 'كود الميناء'), f('name', 'string', 'الاسم'),
      f('source_file', 'string', 'ملف المصدر'), f('updated_at', 'date', 'آخر تحديث'),
    ],
    relations: [],
  });
  add({
    id: 'contract_countries',
    label: 'دول العقود',
    technical: 'contract_countries',
    domain: DOMAINS.contracts,
    description: 'دول العقود (مرجع تصنيفي يُستخدم في تفاصيل العقود).',
    status: STATUS.documented,
    perm: null,
    grain: 'دولة',
    rowKey: ['code'],
    timeGrain: 'none',
    canonical: false,
    access: { module: 'src/db.js', fn: 'contract_countries' },
    fields: [
      f('code', 'string', 'كود الدولة'), f('name', 'string', 'الاسم'),
      f('source_file', 'string', 'ملف المصدر'), f('updated_at', 'date', 'آخر تحديث'),
    ],
    relations: [],
  });
  add({
    id: 'contract_arrival_ports',
    label: 'موانئ وصول العقود',
    technical: 'contract_arrival_ports',
    domain: DOMAINS.contracts,
    description: 'موانئ وصول العقود (مرجع تصنيفي يُستخدم في تفاصيل العقود).',
    status: STATUS.documented,
    perm: null,
    grain: 'ميناء وصول',
    rowKey: ['code'],
    timeGrain: 'none',
    canonical: false,
    access: { module: 'src/db.js', fn: 'contract_arrival_ports' },
    fields: [
      f('code', 'string', 'كود الميناء'), f('name', 'string', 'الاسم'),
      f('source_file', 'string', 'ملف المصدر'), f('updated_at', 'date', 'آخر تحديث'),
    ],
    relations: [],
  });

/* ---------- 4.13) مخرجات التدفقات (مصدر Report Studio) ---------- */
add({
  id: 'workflow_outputs',
  label: 'مخرجات التدفقات المحفوظة',
  technical: 'data/workflows/_outputs',
  domain: DOMAINS.flows,
  description: 'نتائج تشغيل التدفقات المحفوظة على القرص — المصدر الذي يستهلكه استوديو التقارير.',
  status: STATUS.documented,
  perm: null,
  grain: 'صف نتيجة تشغيل',
  rowKey: ['runId'],
  timeGrain: 'none',
  canonical: false,
  access: { module: 'src/workflow.js', fn: 'loadOutput' },
  note: 'يُقرأ عبر /api/workflows/output (لا كصفوف للبناء) — مصدر موثّق لا مصدر تدفق.',
  fields: [f('runId', 'string', 'معرّف التشغيل'), f('rowCount', 'number', 'عدد الصفوف'),
    f('columns', 'array', 'أعمدة النتيجة'), f('savedAt', 'string', 'وقت الحفظ')],
  relations: [],
  fetch: null,   /* يُقرأ عبر مسار النتائج مباشرة، لا عبر جلب جدول */
});

/* =====================================================================
 * 5) واجهة الفهرس
 * ===================================================================== */
const BY_ID = new Map(SOURCES.map(s => [s.id, s]));

/** كل المصادر (نسخة قابلة للإرسال للواجهة — بلا دوال) */
function listSources() {
  return SOURCES.map(s => ({
    id: s.id, label: s.label, technical: s.technical, domain: s.domain, description: s.description,
    status: s.status, perm: s.perm, grain: s.grain, rowKey: s.rowKey, timeGrain: s.timeGrain,
    canonical: !!s.canonical, canonicalFor: s.canonicalFor || null, canonicalNote: s.canonicalNote || null,
    access: s.access || null, fields: s.fields.map(x => ({ ...x })), relations: s.relations.map(r => ({ ...r })),
    fieldCount: s.fields.length,
  }));
}

/** مصدر بمعرّفه (مع الدوال) أو null */
function getSource(id) { return BY_ID.get(String(id || '')) || null; }

/** مصادر قابلة للتشغيل فعلياً في الـWorkflow (لها مسار قراءة) */
function runnableSources() { return SOURCES.filter(s => s.status === STATUS.implemented && typeof s.fetch === 'function'); }

/** ملخص الفهرس حسب المجال والحالة */
function summary() {
  const byDomain = {};
  const byStatus = {};
  for (const s of SOURCES) {
    byDomain[s.domain] = (byDomain[s.domain] || 0) + 1;
    byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  }
  return {
    total: SOURCES.length,
    runnable: runnableSources().length,
    fields: SOURCES.reduce((n, s) => n + s.fields.length, 0),
    relations: SOURCES.reduce((n, s) => n + s.relations.length, 0),
    byDomain, byStatus,
    canonicalBalance: (BY_ID.get('daily_balances') || {}).id || null,
  };
}

module.exports = {
  STATUS, DOMAINS, SOURCES, CONTRACT_TABLES,
  listSources, getSource, runnableSources, summary, fetchContractTable,
};
