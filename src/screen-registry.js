'use strict';
/**
 * سجل الشاشات والتقارير ومصادرها (Screen & Report Registry)
 * ======================================================================
 * يربط كل شاشة/تقرير قائم بمصدره وحقوله ومقاييسه وفلاتره وتجميعه وحالة
 * إتاحته كمصدر قابل لإعادة الاستخدام داخل Workflow Studio.
 *
 * مبني على الكود القائم فعلياً:
 *   - التباويب: src/server.js (TABS)
 *   - التقارير: src/server.js (REPORTS) + دوال src/analytics.js
 *   - شاشات العقود: src/daily-entry.js + src/analytics.js (contract*)
 *
 * حالة إعادة الاستخدام:
 *   'catalog'  : له مصدر في فهرس البيانات ⇒ قابل لإعادة البناء داخل تدفق
 *   'composite': يحتاج تجميعاً/منطقاً متعدد ⇒ مصدر مقترح في ملاحظة
 *   'view-only' : عرض/تصدير فقط بلا مسار تدفق مستقل
 */

const CAT = require('./data-catalog');

const REUSE = { catalog: 'catalog', composite: 'composite', viewOnly: 'view-only' };

/* ---------- الشاشات (التبويبات) ---------- */
const SCREENS = [
  {
    id: 'dashboard', label: 'لوحة التحكم', group: 'عام',
    sources: ['items', 'locations', 'movements', 'sales', 'daily_balances'],
    fields: [], measures: ['عدد المستخدمين والصلاحيات', 'مؤشرات مجمّعة'],
    filters: [], grouping: 'مؤشرات فقط',
    reuse: REUSE.viewOnly, note: 'لوحة تجميعية — تعتمد على عدة استعلامات عدّدية، تُبنى كطبقة عرض لا كمصدر.',
  },
  {
    id: 'md-items', label: 'الأصناف الأساسية', group: 'البيانات الأساسية',
    sources: ['items'], fields: ['code', 'descr', 'kind', 'uom', 'group_code', 'group_desc', 'class_code', 'class_desc'],
    measures: [], filters: ['بحث'], grouping: 'حسب النوع (صنف/مجموعة/تصنيف)',
    reuse: REUSE.catalog, note: 'مصدرها items في الفهرس.',
  },
  {
    id: 'md-locations', label: 'المواقع والمصانع', group: 'البيانات الأساسية',
    sources: ['locations'], fields: ['unit_code', 'unit_name', 'company_code', 'company_name', 'place', 'currency'],
    measures: [], filters: [], grouping: 'حسب الشركة/المكان',
    reuse: REUSE.catalog, note: 'مصدرها locations في الفهرس + جدول warehouses (وحدة منفصلة في الشاشة).',
  },
  {
    id: 'md-movetypes', label: 'أنواع الحركات', group: 'البيانات الأساسية',
    sources: ['movement_types'], fields: ['type_code', 'direction'], measures: [], filters: [],
    grouping: 'حسب الاتجاه', reuse: REUSE.viewOnly,
    note: 'مرجع صغير — لم يُدرج كمصدر مستقل في الفهرس (يُدمج مع movements عند التحليل).',
  },
  {
    id: 'md-contractrefs', label: 'مراجع العقود', group: 'البيانات الأساسية',
    sources: ['contract_items', 'contract_suppliers', 'contract_countries', 'contract_arrival_ports'],
    fields: ['code', 'name'], measures: [], filters: ['نوع المرجع'],
    grouping: 'حسب نوع المرجع', reuse: REUSE.viewOnly,
    note: 'جداول مراجع صغيرة؛ منها contract_items في الفهرس (لأنه حلقة الوصل مع ERP).',
  },
  {
    id: 'inventory', label: 'المخزون والمطابقة', group: 'المخزون',
    sources: ['daily_balances', 'recon'],
    fields: ['balance_date', 'item', 'storage_loc', 'unit_code', 'open_qty', 'close_qty', 'open_val', 'close_val', 'move_qty', 'move_val'],
    measures: ['إجمالي الرصيد', 'حركة اليوم', 'فرق المطابقة'],
    filters: ['من/إلى (balance_date)', 'الصنف', 'المخزن', 'الوحدة', 'المكان', 'الشركة', 'التصنيف', 'المجموعة'],
    grouping: 'صنف/مجموعة/تصنيف × مكان/شركة/وحدة/مخزن × فترة',
    reuse: REUSE.catalog, note: 'مصدرها daily_balances — المرجع المعتمد للأرصدة.',
  },
  {
    id: 'sales', label: 'المبيعات والربحية', group: 'المبيعات',
    sources: ['sales', 'movements'],
    fields: ['item', 'uom', 'cls', 'grp', 'storage_loc', 'unit_code', 'place', 'company_code', 'qty', 'value', 'cost', 'profit', 'marginPct'],
    measures: ['قيمة المبيعات', 'التكلفة المنسوبة', 'الربح', 'نسبة الربح', 'نسبة تغطية المبيعات'],
    filters: ['من/إلى (invoice_date)', 'الصنف', 'المكان', 'الشركة', 'العميل', 'المخزن', 'الوحدة', 'التصنيف', 'المجموعة'],
    grouping: 'صنف/مجموعة/تصنيف × مكان/شركة/عميل/مخزن/وحدة × أسبوعي/شهري/ربع/نصف/3 أرباع/سنوي',
    reuse: REUSE.catalog, note: 'مصدرها sales (يشمل التكلفة والربح بعد الإسناد).',
  },
  {
    id: 'movements', label: 'الحركات', group: 'الحركات',
    sources: ['movements'],
    fields: ['post_date', 'item', 'move_type', 'direction', 'qty', 'amount', 'doc_ref', 'unit_code', 'storage_loc', 'place'],
    measures: ['وارد/صادر (كمية/قيمة)', 'الصافي'],
    filters: ['من/إلى (post_date)', 'الصنف', 'الوحدة', 'الشركة', 'نوع الحركة', 'الاتجاه', 'المخزن', 'المكان', 'التصنيف', 'المجموعة'],
    grouping: 'صنف/مجموعة/تصنيف × مكان/شركة/وحدة/مخزن × فترة',
    reuse: REUSE.catalog, note: 'مصدرها movements.',
  },
  {
    id: 'borse', label: 'البورصة اليومية', group: 'الأسعار',
    sources: ['borse'],
    fields: ['borse_date', 'item', 'item_code', 'low', 'high', 'close', 'usd_rate', 'basis', 'borse_now', 'fees', 'cost_price'],
    measures: ['أعلى/أدنى سعر', 'التغير اليومي', 'الريـت', 'سعر التكلفة'],
    filters: ['من/إلى', 'الصنف'], grouping: 'صنف × يوم',
    reuse: REUSE.catalog, note: 'مصدرها borse (المصدر الوحيد المسموح حالياً في Workflow Studio).',
  },
  {
    id: 'prices', label: 'الأسعار اليومية', group: 'الأسعار',
    sources: ['prices'], fields: ['price_date', 'item_code', 'item', 'cost_land', 'market_land', 'currency'],
    measures: ['سعر الأرض', 'سعر السوق'], filters: ['من/إلى', 'الصنف'], grouping: 'صنف × يوم',
    reuse: REUSE.viewOnly, note: 'جدول prices قابل للقراءة لكن لم يُدرج كمصدر في الفهرس بعد (يلزم مسار قراءة).',
  },
  {
    id: 'costs', label: 'التكلفة اليومية', group: 'التكلفة',
    sources: ['daily_costs'], fields: ['cost_date', 'item_code', 'item', 'unit_code', 'method', 'cost', 'qty', 'value', 'cost_usd', 'usd_rate', 'fees'],
    measures: ['تكلفة الوحدة', 'إجمالي التكلفة'], filters: ['من/إلى', 'الصنف', 'الوحدة'], grouping: 'صنف × تاريخ',
    reuse: REUSE.viewOnly,
    note: 'الشاشة نفسها تستدعي CE.grid() الذي قد يُعيد بناء daily_costs (كتابة) — لا يُستخدم كمصدر تدفق.',
  },
  {
    id: 'contracts', label: 'عقود الاستيراد', group: 'العقود',
    sources: ['contract_registrations', 'contract_details', 'contract_payments', 'contract_loading', 'contract_hedge', 'contract_roll', 'contract_release', 'contract_external_sales', 'contract_coverage', 'contract_balances'],
    fields: ['internal_no', 'classification', 'quantity', 'contract_status', 'expected_cif_price', 'required_qty', 'coverage_balance'],
    measures: ['تغطية العقود', 'رصيد التغطية', 'Position', 'صافي البريم', 'أعلى قيمة بورصة'],
    filters: ['من/إلى (تاريخ التعاقد)', 'التصنيف', 'الرقم الداخلي', 'نوع التصنيف'],
    grouping: 'تصنيف × قياس',
    reuse: REUSE.catalog, note: 'المصدر التحليلي: contract_coverage + جداول العقود الخام.',
  },
  {
    id: 'reports', label: 'التقارير', group: 'التقارير',
    sources: [], fields: [], measures: [], filters: ['حسب التقرير'], grouping: 'حسب التقرير',
    reuse: REUSE.viewOnly, note: 'مركز 17 تقريراً مرئياً (و14 خاماً للتصدير) — سجل التقارير أدناه.',
  },
  {
    id: 'workcenter', label: 'مركز العمل', group: 'التحليل', mergedInto: 'analysis',
    sources: [], fields: [], measures: ['آخر التشغيلات', 'آخر التقارير', 'المعادلات المحفوظة', 'صحة المنصة'],
    filters: [], grouping: 'حسب النوع',
    reuse: REUSE.viewOnly,
    note: 'دُمج داخل «البيانات والتحليل» — محتواه صار «شريط حالة» يظهر أعلى الشاشات الثلاث (لا شاشة مستقلة).',
  },
  {
    id: 'reports-manager', label: 'التقارير المحفوظة', group: 'التحليل', mergedInto: 'report-studio',
    sources: [], fields: [], measures: ['عدد التقارير المحفوظة'],
    filters: [], grouping: 'حسب المصدر',
    reuse: REUSE.viewOnly,
    note: 'دُمج داخل «التقارير» — التبويب «التقارير المحفوظة» في شاشة التقارير (لا شاشة مستقلة).',
  },
  {
    id: 'analysis', label: 'البيانات والعلاقات', group: 'التحليل',
    sources: [], fields: [], measures: ['فهرس المصادر', 'قاموس المعادلات', 'مستكشف العلاقات', 'سجل الشاشات', 'المعادلات المحفوظة'],
    filters: [], grouping: 'حسب المجال/الحالة',
    reuse: REUSE.viewOnly, note: 'واجهة استكشاف: فهرس المصادر وقاموس المعادلات ومستكشف العلاقات وسجل الشاشات وسجل المعادلات المحفوظة (مصدر واحد للاثنتين).',
  },
  {
    id: 'workflow', label: 'المعادلات والتحليل', group: 'التحليل', mergedInto: 'analysis',
    sources: [], fields: [], measures: [], filters: [], grouping: 'حسب التدفق',
    reuse: REUSE.viewOnly, note: 'دُمج داخل «البيانات والتحليل» — لوحة المعادلات وبناء التحليل والنتائج (لا شاشة مستقلة).',
  },
  {
    id: 'report-studio', label: 'التقارير', group: 'التحليل',
    sources: ['workflow_outputs'], fields: [], measures: [], filters: [], grouping: 'حسب المكون',
    reuse: REUSE.viewOnly, note: 'يستهلك مخرجات تشغيل التدفقات المحفوظة.',
  },
  {
    id: 'screen-studio', label: 'الشاشات والتحكم', group: 'التحليل',
    sources: ['workflow_outputs'], fields: [], measures: [], filters: [], grouping: 'حسب المكوّن',
    reuse: REUSE.viewOnly,
    note: 'إنشاء الشاشات المخصّصة وربطها بنتيجة تشغيل محفوظة — المكوّنات تُصيَّر بمحرّك التقارير نفسه (بلا حساب موازٍ).',
  },
];

/* ---------- التقارير (server.js REPORTS) ---------- */
const REPORTS = [
  { key: 'sales-total', label: 'المبيعات', source: 'sales', fields: ['item', 'cls', 'grp', 'storage_loc', 'unit_code', 'place', 'company_code', 'qty', 'value', 'cost', 'profit'], measures: ['التكلفة', 'الربح'], filters: ['نفس فلاتر شاشة المبيعات'], grouping: 'حسب by/by2/per', reuse: REUSE.catalog },
  { key: 'movements-total', label: 'الحركات', source: 'movements', fields: ['item', 'cls', 'grp', 'place', 'company_code', 'storage_loc', 'unit_code', 'qty', 'amount'], measures: ['وارد/صادر', 'الصافي'], filters: ['نفس فلاتر شاشة الحركات'], grouping: 'حسب by/by2/per', reuse: REUSE.catalog },
  { key: 'inventory-total', label: 'الأرصدة', source: 'daily_balances', fields: ['item', 'cls', 'grp', 'place', 'company_code', 'storage_loc', 'unit_code', 'open_qty', 'close_qty', 'open_val', 'close_val'], measures: ['إجمالي الرصيد'], filters: ['نفس فلاتر شاشة المخزون'], grouping: 'حسب by/by2/per', reuse: REUSE.catalog },
  { key: 'sales-day', label: 'مبيعات يومية (تجميع × تفصيل × فترة)', hidden: true, source: 'sales', fields: ['qty', 'value', 'unit_value'], measures: ['قيمة البيع للوحدة'], filters: ['نفس فلاتر المبيعات'], grouping: 'مجمّع × تفصيل × فترة', reuse: REUSE.catalog },
  { key: 'reconcile', label: 'مطابقة الأرصدة', source: 'recon', fields: ['item', 'prev_date', 'next_date', 'open_val', 'close_val', 'moves_val', 'diff_val'], measures: ['فرق المطابقة'], filters: [], grouping: 'صنف × تاريخ', reuse: REUSE.catalog },
  { key: 'borse-latest', label: 'أسعار البورصة الأخيرة', source: 'borse', fields: ['item', 'close', 'usd_rate'], measures: ['التغير'], filters: [], grouping: 'صنف', reuse: REUSE.catalog },
  { key: 'borse-raw', label: 'سجل البورصة اليومي (خام)', source: 'borse', fields: ['borse_date', 'contract', 'item_code', 'item', 'low', 'high', 'close', 'basis', 'borse_now', 'usd_rate', 'down_payment', 'fees', 'fx_factor', 'cost_price'], measures: [], filters: [], grouping: 'صنف × يوم', reuse: REUSE.catalog },
  { key: 'contract-registrations-raw', label: 'تسجيل العقود (خام)', hidden: true, source: 'contract_registrations', fields: ['internal_no', 'classification', 'quantity', 'contract_status'], measures: [], filters: [], grouping: '—', reuse: REUSE.catalog },
  { key: 'contract-details-raw', label: 'تفصيلى العقود (خام)', hidden: true, source: 'contract_details', fields: ['internal_no', 'vessel_name', 'expected_arrival'], measures: [], filters: [], grouping: '—', reuse: REUSE.catalog },
  { key: 'contract-payments-raw', label: 'سداد العقود (خام)', hidden: true, source: 'contract_payments', fields: ['internal_no', 'payment_quantity', 'payment_status'], measures: [], filters: [], grouping: '—', reuse: REUSE.catalog },
  { key: 'contract-loading-raw', label: 'تحميل العقود (خام)', hidden: true, source: 'contract_loading', fields: ['internal_no', 'loading_quantity'], measures: [], filters: [], grouping: '—', reuse: REUSE.catalog },
  { key: 'contract-hedge-raw', label: 'ربط العقود (خام)', hidden: true, source: 'contract_hedge', fields: ['internal_no', 'hedge_quantity', 'hedge_price'], measures: [], filters: [], grouping: '—', reuse: REUSE.catalog },
  { key: 'contract-roll-raw', label: 'رول العقود (خام)', hidden: true, source: 'contract_roll', fields: ['internal_no', 'roll_quantity', 'rolling_price'], measures: [], filters: [], grouping: '—', reuse: REUSE.catalog },
  { key: 'contract-release-raw', label: 'إفراج العقود (خام)', hidden: true, source: 'contract_release', fields: ['internal_no', 'release_quantity'], measures: [], filters: [], grouping: '—', reuse: REUSE.catalog },
  { key: 'contract-external-sales-raw', label: 'بيع خارجى (خام)', hidden: true, source: 'contract_external_sales', fields: ['internal_no', 'sale_quantity'], measures: [], filters: [], grouping: '—', reuse: REUSE.catalog },
  { key: 'contract-balances-raw', label: 'أرصدة خامات العقود (خام)', hidden: true, source: 'contract_balances', fields: ['report_date', 'item_code', 'total_balance', 'consumption', 'days_enough'], measures: [], filters: [], grouping: 'صنف × تاريخ', reuse: REUSE.catalog },
  { key: 'contract-items-raw', label: 'أصناف العقود (خام)', hidden: true, source: 'contract_items', fields: ['code', 'name', 'direction'], measures: [], filters: [], grouping: '—', reuse: REUSE.catalog },
  { key: 'contract-suppliers-raw', label: 'موردو العقود (خام)', hidden: true, source: 'contract_suppliers', fields: ['code', 'name'], measures: [], filters: [], grouping: '—', reuse: REUSE.viewOnly },
  { key: 'contract-ports-raw', label: 'موانئ العقود (خام)', hidden: true, source: 'contract_ports', fields: ['code', 'name'], measures: [], filters: [], grouping: '—', reuse: REUSE.viewOnly },
  { key: 'companies-raw', label: 'الشركات (المصدر الموحد - خام)', hidden: true, source: 'companies', fields: ['company_code', 'company_name'], measures: [], filters: [], grouping: '—', reuse: REUSE.viewOnly },
  { key: 'pbix-home', label: '① الصفحة الرئيسية', source: 'contract_coverage', fields: ['hedge_position', 'daily_rate_sum', 'corn_vessels', 'docs_value'], measures: ['موقف ربط الخامات', 'عدد مراكب الذرة', 'قيمة المطلوب سداده'], filters: ['من/إلى'], grouping: 'بطاقات', reuse: REUSE.composite },
  { key: 'pbix-hedge-position', label: 'موقف ربط وتغطية الخامات الرئيسية', source: 'contract_coverage', fields: ['cls', 'paid_unpriced', 'remaining_open', 'factory', 'coverage_balance', 'position', 'contracts', 'days_enough'], measures: ['الكمية المدفوعة بدون تسعير', 'رصيد التغطية', 'Position', 'عدد العقود', 'عدد الأيام'], filters: ['نوع التصنيف'], grouping: 'تصنيف', reuse: REUSE.catalog },
  { key: 'pbix-corn-vessels', label: 'تقرير مراكب الذرة — تفصيلي', source: 'contract_coverage', fields: ['source', 'supplier', 'quantity', 'shipping_value', 'pricing_status', 'cif', 'vessel', 'payment_status', 'expected_arrival', 'net_premium'], measures: ['صافي البريم', 'صافي البريم النهائي'], filters: ['من/إلى'], grouping: 'مصدر', reuse: REUSE.composite },
  { key: 'pbix-corn-summary', label: 'مراكب الذرة — ملخص حسب المصدر', source: 'contract_coverage', fields: ['source', 'qty', 'vessels'], measures: ['كمية مراكب الذرة', 'عدد مراكب الذرة'], filters: [], grouping: 'مصدر', reuse: REUSE.composite },
  { key: 'pbix-docs-value', label: 'تقرير قيمة المستندات — تفصيلي', source: 'contract_coverage', fields: ['supplier', 'classification', 'expected_payment', 'status', 'to_pay_qty', 'cif_actual', 'value'], measures: ['قيمة المطلوب سداده'], filters: ['من/إلى'], grouping: 'مورد/تصنيف/شهر', reuse: REUSE.composite },
  { key: 'pbix-docs-class', label: 'قيمة المستندات حسب التصنيف', source: 'contract_coverage', fields: ['cls', 'value', 'qty', 'lines'], measures: ['قيمة المطلوب سداده'], filters: [], grouping: 'تصنيف', reuse: REUSE.composite },
  { key: 'pbix-docs-month', label: 'قيمة المستندات حسب شهر السداد', source: 'contract_coverage', fields: ['month', 'value', 'qty', 'lines'], measures: ['قيمة المطلوب سداده'], filters: [], grouping: 'شهر', reuse: REUSE.composite },
  { key: 'pbix-priced-costs', label: 'تكلفة الخامات المسعرة', source: 'contract_coverage', fields: ['cls', 'daily_rate', 'price_usd', 'current_cost', 'market_price', 'diff'], measures: ['التكلفة الحالية', 'الفرق'], filters: [], grouping: 'تصنيف', reuse: REUSE.composite },
  { key: 'pbix-main-coverage', label: 'تغطية خامات رئيسية', source: 'contract_coverage', fields: ['cls', 'factory', 'port', 'paid_not_opened', 'balance', 'consumption', 'days_enough', 'enough_until'], measures: ['رصيد المصانع', 'رصيد متاح الميناء', 'إجمالي الرصيد'], filters: ['نوع التصنيف'], grouping: 'تصنيف', reuse: REUSE.catalog },
  { key: 'pbix-additives-coverage', label: 'تغطية الأدوية والإضافات', source: 'contract_coverage', fields: ['cls', 'balance_raw', 'port_additions', 'contract_additions', 'items_total', 'consumption', 'days_enough'], measures: ['الإجمالي الكلي', 'أيام التغطية'], filters: ['نوع التصنيف'], grouping: 'تصنيف', reuse: REUSE.catalog },
  { key: 'contract-unified', label: 'عقود الاستيراد — تسجيل + تفصيل (موحّد)', source: 'contract_unified', fields: ['internal_no', 'contract_date', 'classification', 'supplier', 'contract_no', 'detail_lines'], measures: [], filters: ['من/إلى'], grouping: '—', reuse: REUSE.catalog },
];

/* ---------- مصادر مذكورة في السجل لكنها ليست في الفهرس بعد (فجوات موثّقة) ---------- */
const PENDING_SOURCES = [
  { id: 'movement_types', label: 'أنواع الحركات', note: 'مرجع صغير — يُدمج مع movements في التحليل.' },
  { id: 'prices', label: 'الأسعار اليومية', note: 'جدول prices قابل للقراءة — يحتاج مسار قراءة مستقلاً في الفهرس.' },
  { id: 'daily_costs', label: 'التكلفة اليومية', note: 'يوجد الجدول — لكن شاشة التكلفة تستدعي CE.grid() الذي قد يُعيد البناء (كتابة) ⇒ لا يُستخدم كمصدر تدفق.' },
  { id: 'contract_suppliers', label: 'موردو العقود', note: 'جدول مرجع.' },
  { id: 'contract_countries', label: 'مصادر العقود', note: 'جدول مرجع.' },
  { id: 'contract_arrival_ports', label: 'موانئ الوصول', note: 'جدول مرجع.' },
  { id: 'contract_ports', label: 'موانئ العقود', note: 'جدول مرجع.' },
  { id: 'contract_companies_internal', label: 'شركات العقود الداخلية', note: 'جدول مرجع.' },
];

/* ---------- الواجهة ---------- */
function listScreens() { return SCREENS.map(s => ({ ...s })); }
function listReports() { return REPORTS.map(r => ({ ...r })); }

/** ملخص: ما الذي يمكن إعادة بناؤه داخل تدفق، وما يحتاج مصدراً مقترحاً */
function summary() {
  const byReuse = { catalog: 0, composite: 0, 'view-only': 0 };
  for (const s of SCREENS) byReuse[s.reuse] = (byReuse[s.reuse] || 0) + 1;
  const byReuseReports = { catalog: 0, composite: 0, 'view-only': 0 };
  for (const r of REPORTS) byReuseReports[r.reuse] = (byReuseReports[r.reuse] || 0) + 1;
  return {
    screens: SCREENS.length,
    reports: REPORTS.length,
    visibleReports: REPORTS.filter(r => !r.hidden).length,
    screensByReuse: byReuse,
    reportsByReuse: byReuseReports,
    domains: [...new Set(SCREENS.flatMap(s => s.sources).map(id => (CAT.getSource(id) || {}).domain).filter(Boolean))],
  };
}

/** تقرير «الشاشة ⇒ المصدر» مع حالة كل مصدر في الفهرس */
function screensWithSources() {
  return SCREENS.map(s => ({
    ...s,
    sources: s.sources.map(id => {
      const src = CAT.getSource(id);
      return { id, label: (src || {}).label || id, status: (src || {}).status || 'غير متاح', canonical: !!(src || {}).canonical };
    }),
  }));
}

module.exports = { REUSE, SCREENS, REPORTS, PENDING_SOURCES, listScreens, listReports, summary, screensWithSources };
