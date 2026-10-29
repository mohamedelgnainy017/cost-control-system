'use strict';
/**
 * مرجع DAX القديم (نموذج Power BI لعقود الاستيراد) — مصدر موثَّق للمعادلات
 * ======================================================================
 * مستخرج من:
 *   _handover/DAX_Measures_and_Calculated_Columns.json  (49 مقياساً + 21 عموداً محسوباً)
 *   _handover/pbix-model/dmv-json/dmv__SYSTEM_TMSCHEMA_MEASURES.json  (تأكيد 49 من داخل الـPBIX)
 *   _handover/pbix-model/MODEL.txt  (الأعمدة المصدرية + 13 علاقة)
 *
 * **مهم:** هذا المرجع يوثّق نموذج العقود القديم فقط — ليس النموذج الكامل للتطبيق.
 *Areas الحركات والمبيعات والأرصدة اليومية والتكلفة لها معادلاتها في src/analytics.js
 * و src/cost-engine.js (تُوثَّق في src/model-explorer.js).
 *
 * قاعدة الأمانة: لا يُوصف أي قياس بأنه «مطابق رقمياً» دون اختبار مقارنة فعلي.
 * كل قيد هنا يحمل `numericVerified: false` ما لم يُجرَ اختبار مقارنة موثّق.
 */

const MATCH = {
  logical: 'مطابق منطقيًا',      // المعادلة نفسها مُنفَّذة بنفس المدخلات
  partial: 'جزئي',              // مُنفَّذ بمقادير/شروط مختلفة
  different: 'مختلف',           // معنى/صياغة مختلفة عن DAX
  documented: 'موثق فقط',       // موصوف، غير منفَّذ في الكود
  missing: 'غير منفَّذ',        // لا وجود له في الكود
  unverified: 'غير متحقق رقميًا', // المعادلة مطابقة لكن الأرقام لم تُقاس
  tested: 'متحقق باختبارات اصطناعية', // سلوكها مثبت باختبار معزول (لا مقارنة رقمية ببيانات الشركة)
  numeric: 'متحقق رقميًا',     // مقارنة فعلية بمصدر مرجعي معتمد (لا يوجد بعد)
};

/** مقياس DAX واحد */
const m = (table, name, dax, status, counterpart, location, note) => ({
  kind: 'measure', table, name, dax, status, counterpart, location, note: note || '', numericVerified: false,
});

/** عمود محسوب واحد */
const c = (table, name, dax, status, counterpart, location, note) => ({
  kind: 'calculated_column', table, name, dax, status, counterpart, location, note: note || '', numericVerified: false,
});

const MEASURES = [
  m('تسجيل_العقود', 'Active ما تم دفعه وفتحه فعليا (السداد)',
    'CALCULATE([كمية سداد], \'تسجيل_العقود\'[موقف العقد] <> "FINISH")',
    MATCH.partial, 'paidActive', 'src/pbix.js:511',
    'الكود يضيف شرط vessel_status <> \'انتهاء التفريغ\' فوق شرط DAX ⇒ قد يختلف الرقم عن Power BI.'),
  m('تسجيل_العقود', 'Active ما تم سحبه',
    'CALCULATE([كمية تحميل], \'تسجيل_العقود\'[موقف العقد] <> "FINISH")',
    MATCH.partial, 'withdrawnActive', 'src/pbix.js:512', 'نفس الفلتر الإضافي.'),
  m('تسجيل_العقود', 'Active المتبقى من الكمية المفتوحة',
    '[Active ما تم دفعه وفتحه فعليا (السداد)] - [Active ما تم سحبه]', MATCH.logical, 'remaining', 'src/pbix.js:514'),
  m('تسجيل_العقود', 'Active رصيد المصانع',
    'CALCULATE([كمية رصيد], TREATAS(VALUES(\'تسجيل_العقود\'[التصنيف]), \'الارصدة\'[التصنيف]))',
    MATCH.partial, 'factory', 'src/pbix.js:515-524',
    'مصدر مختلف: DAX من ورقة «الارصدة»؛ الكود من أرصدة المستودع اليومية (factoryMap) مع بديل balSum.'),
  m('تسجيل_العقود', 'Active الكميات المدفوعة بدون تسعير',
    '[Active ما تم دفعه وفتحه فعليا (السداد)] - [Active كمية ربط تقديرى]', MATCH.logical, 'paidNoPricing', 'src/pbix.js:525'),
  m('تسجيل_العقود', 'Active رصيد التغطية',
    '([Active المتبقى من الكمية المفتوحة] + [Active رصيد المصانع]) - [Active الكميات المدفوعة بدون تسعير]',
    MATCH.logical, 'coverage', 'src/pbix.js:526'),
  m('تسجيل_العقود', 'Active Position',
    'IF([Active رصيد التغطية] < 0, "Position SHORT", "Position LONG")',
    MATCH.logical, 'Position (عمود واجهة)', 'public/app.js:3625',
    'منفَّذ في طبقة العرض لا في المحرك ⇒ غير قابل لإعادة الاستخدام داخل تدفق.'),
  m('تسجيل_العقود', 'Active عدد الايام',
    'CALCULATE(SUMX(\'الارصدة\', DIVIDE(CALCULATE([Active رصيد التغطية]), \'الارصدة\'[الاستهلاك])), '
    + 'TREATAS(VALUES(\'تسجيل_العقود\'[التصنيف]), \'الارصدة\'[التصنيف]), KEEPFILTERS(\'تسجيل_العقود\'[موقف العقد] <> "FINISH"))',
    MATCH.missing, '—', '—',
    'المتاح/الإجمالي يكفى في الكود = قسمة على مستوى السياق، لا SUMX على صفوف الأرصدة.'),
  m('تسجيل_العقود', 'Active عدد العقود',
    'CALCULATE(SUMX(\'الارصدة\', DIVIDE(CALCULATE([Active رصيد التغطية]), \'الارصدة\'[اللوط])), '
    + 'TREATAS(VALUES(\'تسجيل_العقود\'[التصنيف]), \'الارصدة\'[التصنيف]), KEEPFILTERS(\'تسجيل_العقود\'[موقف العقد] <> "FINISH"))',
    MATCH.different, 'contracts (عدد صفوف)', 'src/analytics.js:780',
    'الكود يعرض عدد الصفوف/الأرقام الداخلية لا عدد العقود المرجّح باللوط.'),
  m('تسجيل_العقود', 'Activeكمية مراكب الذرة',
    'CALCULATE([كمية التعاقد], \'تسجيل_العقود\'[موقف العقد] <> "FINISH", \'تسجيل_العقود\'[التصنيف] = "الــــــــــذرة")',
    MATCH.partial, 'activeCornPaidQty', 'src/pbix.js:557', 'فلتر vessel_status الإضافي.'),
  m('تسجيل_العقود', 'كمية التعاقد', 'SUM([الكمية])', MATCH.logical, 'qtyContract', 'src/pbix.js:507'),
  m('تسجيل_العقود', 'Active عدد مراكب الذرة',
    'CALCULATE(COUNTROWS(\'تسجيل_العقود\'), \'تسجيل_العقود\'[موقف العقد] <> "FINISH", '
    + '\'تسجيل_العقود\'[التصنيف] = "الــــــــــذرة")', MATCH.partial, 'activeCornCount', 'src/pbix.js:558', 'فلتر vessel_status الإضافي.'),
  m('تسجيل_العقود', 'Activeاجمالي كميات مسعرة الذرة',
    'CALCULATE([Active رصيد التغطية], \'تسجيل_العقود\'[التصنيف] = "الــــــــــذرة")',
    MATCH.logical, 'cornPricedCoverage', 'src/pbix.js:590'),
  m('تسجيل_العقود', 'Active كميات مسعرة بدون سداد الذرة',
    'CALCULATE([Active الكميات المدفوعة بدون تسعير], \'تسجيل_العقود\'[التصنيف] = "الــــــــــذرة")',
    MATCH.logical, 'cornPricedWithoutPay', 'src/pbix.js:591'),
  m('تسجيل_العقود', 'Active كمية المطلوب سداده',
    'CALCULATE(SUM(\'تسجيل_العقود\'[كمية المطلوب سداده]), \'تسجيل_العقود\'[حالة التجميع] <> "مستبعد", '
    + '\'تسجيل_العقود\'[موقف العقد] <> "FINISH", FILTER(VALUES(\'تسجيل_العقود\'), [كمية المطلوب سداده] > 200))',
    MATCH.logical, 'activeDueQty', 'src/pbix.js:543-544'),
  m('تسجيل_العقود', 'كمية مطلوب سدادها', 'SUM([كمية المطلوب سداده])', MATCH.logical, 'dueQty', 'src/pbix.js:549'),
  m('تسجيل_العقود', 'Active سعر CIF المتوقع الفعلي',
    'CALCULATE(SELECTEDVALUE(\'تسجيل_العقود\'[سعر CIF متوقع]), \'تسجيل_العقود\'[حالة التجميع] <> "مستبعد", '
    + '\'تسجيل_العقود\'[موقف العقد] <> "FINISH", FILTER(VALUES(\'تسجيل_العقود\'), [كمية المطلوب سداده] > 200))',
    MATCH.partial, 'cif_actual', 'src/analytics.js:902',
    'الكود يعرض القيمة الخام بلا فلاتر التجميع/الموقف/>200.'),
  m('تسجيل_العقود', 'Active كمية ربط تقديرى',
    'CALCULATE([ربط تقديرى], \'تسجيل_العقود\'[موقف العقد] <> "FINISH")', MATCH.logical, 'hedgeEstActive', 'src/pbix.js:513'),
  m('تسجيل_العقود', 'ربط تقديرى', 'SUM([كمية الربط تقديرى])', MATCH.logical, 'hedgeEst', 'src/pbix.js:508'),
  m('تسجيل_العقود', 'Active كمية مدفوعة وغير مفتوحة',
    'CALCULATE(CALCULATE([Active ما تم دفعه وفتحه فعليا (السداد)] - [Active ما تم الافراج عنه], '
    + '\'تسجيل_العقود\'[موقف العقد] = "UNDER" || \'تسجيل_العقود\'[موقف العقد] = "ACTIVE"))',
    MATCH.logical, 'paidUnopened', 'src/pbix.js:528-530'),
  m('تسجيل_العقود', 'Active كمية مطلوب سدادها',
    'CALCULATE([كمية مطلوب سدادها], \'تسجيل_العقود\'[موقف العقد] IN { "UNDER", "ACTIVE" }, '
    + '\'تسجيل_العقود\'[موقف سداد] <> "منتظر")',
    MATCH.logical, 'dueActive', 'src/pbix.js:532'),
  m('تسجيل_العقود', 'Active كمية تعاقدات',
    'CALCULATE([كمية التعاقد], \'تسجيل_العقود\'[موقف العقد] = "")', MATCH.logical, 'contractsQty', 'src/pbix.js:533'),
  m('تسجيل_العقود', 'Active رصيد متاح ميناء',
    'IF([Active كمية مدفوعة وغير مفتوحة] = [Active المتبقى من الكمية المفتوحة], BLANK(), '
    + '[Active المتبقى من الكمية المفتوحة]) - [Active كمية مدفوعة وغير مفتوحة]',
    MATCH.logical, 'portBalance', 'src/pbix.js:534'),
  m('تسجيل_العقود', 'Active اجمالى الرصيد',
    'IF(ISBLANK([Active كمية مدفوعة وغير مفتوحة]), 0, [Active كمية مدفوعة وغير مفتوحة]) '
    + '+ IF(ISBLANK([Active كمية مطلوب سدادها]), 0, [Active كمية مطلوب سدادها]) '
    + '+ IF(ISBLANK([Active كمية تعاقدات]), 0, [Active كمية تعاقدات]) '
    + '+ IF(ISBLANK([Active رصيد متاح ميناء]), 0, [Active رصيد متاح ميناء]) '
    + '+ IF(ISBLANK([Active رصيد المصانع]), 0, [Active رصيد المصانع]) - [Activeما تم بيعه]',
    MATCH.logical, 'totalBalance', 'src/pbix.js:541'),
  m('تسجيل_العقود', 'Active كمية الاستهلاك',
    'CALCULATE(SUM(\'الارصدة\'[الاستهلاك]), TREATAS(VALUES(\'تسجيل_العقود\'[التصنيف]), \'الارصدة\'[التصنيف]))',
    MATCH.logical, 'consumption', 'src/pbix.js:539'),
  m('تسجيل_العقود', 'Active اجمالى المتاح', '[Active رصيد متاح ميناء] + [Active رصيد المصانع]',
    MATCH.logical, 'totalAvailable', 'src/pbix.js:540'),
  m('تسجيل_العقود', 'Active المتاح يكفى', 'DIVIDE([Active اجمالى المتاح], [Active كمية الاستهلاك])',
    MATCH.logical, 'availableDays', 'src/pbix.js:554'),
  m('تسجيل_العقود', 'Active الاجمالى يكفى', 'DIVIDE([Active اجمالى الرصيد], [Active كمية الاستهلاك])',
    MATCH.logical, 'totalDays', 'src/pbix.js:555'),
  m('تسجيل_العقود', 'Active ما تم الافراج عنه',
    'CALCULATE([كمية افراج], \'تسجيل_العقود\'[موقف العقد] <> "FINISH")', MATCH.partial, 'releasedActive', 'src/pbix.js:536', 'فلتر vessel_status الإضافي.'),
  m('تسجيل_العقود', 'Activeما تم بيعه',
    'CALCULATE([كمية بيع], \'تسجيل_العقود\'[موقف العقد] <> "FINISH")', MATCH.partial, 'soldActive', 'src/pbix.js:537',
    'صحيح منطقياً لكن contract_external_sales فارغ في خط الأساس ⇒ النتيجة صفر.'),
  m('السداد', 'كمية سداد', 'SUM([كمية السداد])', MATCH.logical, 'factSum(model.pay, payment_quantity)', 'src/pbix.js:511'),
  m('التحميل', 'كمية تحميل', 'SUM([كمية التحميل])', MATCH.logical, 'factSum(model.load, loading_quantity)', 'src/pbix.js:512'),
  m('الارصدة', 'كمية رصيد', 'SUM([اجمالى الرصيد])', MATCH.logical, 'balSum(total_balance)', 'src/pbix.js:524'),
  m('الافراج', 'كمية افراج', 'SUM([كمية الافراج])', MATCH.logical, 'factSum(model.release, release_quantity)', 'src/pbix.js:529'),
  m('بيع_خارجى', 'كمية بيع', 'SUM([كمية المبيعات])', MATCH.logical, 'factSum(model.sell, sale_quantity)', 'src/pbix.js:537'),
  m('تسجيل_العقود', 'Sum of قيمة المطلوب سداده',
    'VAR CurrentSum = SUM(\'تسجيل_العقود\'[قيمة المطلوب سداده]) RETURN IF(CurrentSum = 0, BLANK(), CurrentSum)',
    MATCH.logical, 'sumRequiredValue', 'src/pbix.js:546'),
  m('تسجيل_العقود', 'موقف ربط الخامات',
    'VAR Corn = CALCULATE([Active رصيد التغطية], \'تسجيل_العقود\'[التصنيف] = "الذرة") ... '
    + 'RETURN "الذرة " & CornArrow & "     الصويا " & SoyArrow & "     البذرة " & SeedArrow',
    MATCH.logical, 'hedge_position', 'src/pbix.js:583-586', 'نفس منطق LO/SH بنفس ترتيب النص.'),
  m('تسجيل_العقود', 'موقف ربط الخامات لون',
    'IF(ShortCount > 0, "#F2ADAD", "#B7D1C4")', MATCH.logical, 'hedge_color', 'src/pbix.js:587'),
  m('تسجيل_العقود', 'مسمى كميات مسعرة',
    'SWITCH(TRUE(), ISBLANK(CurrentValue), "لا توجد بيانات", CurrentValue >= 0, "كميات مسددة بدون تسعير", '
    + 'CurrentValue < 0, "كميات مسعرة بدون سداد")', MATCH.different, 'cornPricedLabel', 'src/pbix.js:592-593',
    'الكود: «مسعّر مع سداد / مسعّر بدون سداد / null» — الصياغة والمعنى معكوسان عن DAX.'),
  m('تسجيل_العقود', 'لون اعلى قيمة بورصة', 'MONTH([أعلى قيمة بورصة])', MATCH.missing, '—', '—', 'لا دالة شهر/لون في المشروع.'),
  m('تسجيل_العقود', 'المتاح خامات يكفى حتى', 'VAR DaysCount = INT([Active المتاح يكفى]) RETURN TODAY() + DaysCount',
    MATCH.partial, 'enough_until (مستورد)', 'src/analytics.js:806',
    'المشروع يعرض تاريخاً مستورداً من ورقة العقود بدل حسابه من اليوم.'),
  m('تسجيل_العقود', 'الاجمالى خامات يكفى حتى', 'VAR DaysCount = INT([Active الاجمالى يكفى]) RETURN TODAY() + DaysCount',
    MATCH.partial, 'enough_until (مستورد)', 'src/analytics.js:947', 'نفس الفارق الدلالي.'),
  m('تسجيل_العقود', 'أعلى قيمة بورصة',
    'COALESCE(CALCULATE(MAX(\'الرولينج\'[بورصة الرولينج])), CALCULATE(MAX(\'الربط\'[بورصة الربط])), '
    + 'CALCULATE(MAX(\'تسجيل_العقود\'[بورصة التعاقد])))', MATCH.logical, 'maxBourse / highestExchange', 'src/pbix.js:596,619-639'),
  m('تسجيل_العقود', 'صافي البريم',
    '[صافي البريم النهائي] + COALESCE(SELECTEDVALUE(\'تسجيل_العقود\'[قيمة الشحن]) / 0.393685, 0)',
    MATCH.logical, 'netPremium', 'src/pbix.js:666-668'),
  m('تسجيل_العقود', 'صافي البريم النهائي',
    'متوسط بريم التعاقد لنفس (الرقم داخلي، التصنيف) + مجموع المتوسطات المرجّحة لبورصة الترويل',
    MATCH.logical, 'finalNetPremium', 'src/pbix.js:642-663'),
  m('تسجيل_العقود', 'الاجمالى خامات يكفى يوم  حتى تاريخ',
    'INT(\'تسجيل_العقود\'[Active الاجمالى يكفى]) & " DAY  " & FORMAT(\'تسجيل_العقود\'[الاجمالى خامات يكفى حتى], "YYYY-MM-DD")',
    MATCH.missing, '—', '—'),
  m('تسجيل_العقود', 'المتاح خامات يكفى يوم  حتى تاريخ',
    'INT(\'تسجيل_العقود\'[Active المتاح يكفى]) & " DAY  " & FORMAT(\'تسجيل_العقود\'[المتاح خامات يكفى حتى], "YYYY-MM-DD")',
    MATCH.missing, '—', '—'),
  m('تسجيل_العقود', 'لون شهر الوصول',
    'SWITCH(MOD((YEAR(Max([وصول متوقع])) * 12) + MONTH(Max([وصول متوقع])), 5), 0, "#5DADE2", 1, "#48C9B0", '
    + '2, "#F4D03F", 3, "#EB984E", 4, "#AF7AC5")', MATCH.missing, '—', '—'),
  m('تسجيل_العقود', 'لون فترة السداد',
    'SWITCH(MOD((YEAR(Max([متوقع سداد])) * 12) + MONTH(Max([متوقع سداد])), 5), 0, "#5DADE2", 1, "#48C9B0", '
    + '2, "#F4D03F", 3, "#EB984E", 4, "#AF7AC5")', MATCH.missing, '—', '—'),
];

const COLUMNS = [
  c('تسجيل_العقود', 'وصول متوقع (Month)', 'FORMAT(\'تسجيل_العقود\'[وصول متوقع], "MM - yyyy")',
    MATCH.partial, 'month_qty / month_ar', 'src/pbix.js:216-217',
    'المقابل عمودا Power Query («شهر كميات»/«شهر عربي») لا عمود DAX هذا.'),
  c('تسجيل_العقود', 'سداد متوقع (Month)', 'MONTH([متوقع سداد])', MATCH.partial, 'pay_month', 'src/analytics.js:905',
    '«يوليو 2026» بدل رقم الشهر.'),
  c('تسجيل_العقود', 'شهر عربى سداد متوقع', 'SWITCH(MONTH([متوقع سداد]), 1, "يناير", ... 12, "ديسمبر") & " - " & FORMAT([متوقع سداد], "yy")',
    MATCH.partial, 'pay_month', 'src/analytics.js:905', '«يوليو 2026» مقابل «يوليو - 26».'),
  c('تسجيل_العقود', 'وصول متوقع (Month Index)', 'MONTH([وصول متوقع])', MATCH.missing, '—', '—'),
  c('تسجيل_العقود', 'وصول متوقع على الصنف',
    'YEAR([وصول متوقع]) * 10000 + MONTH([وصول متوقع]) * 100 + DAY([وصول متوقع]) & [AUTO] & [الرقم داخلي]',
    MATCH.missing, '—', '—'),
  c('تسجيل_العقود', 'بداية تشغيل (Month Index)', 'MONTH([بداية تشغيل])', MATCH.missing, '—', '—'),
  c('تسجيل_العقود', 'بداية تشغيل (Month)', 'FORMAT([بداية تشغيل], "MMM")', MATCH.missing, '—', '—'),
  c('الربط', 'الكمية التراكمية',
    'CALCULATE(SUM(\'الربط\'[كمية الربط]), FILTER(ALL(\'الربط\'), \'الربط\'[الصنف] = EARLIER(\'الربط\'[الصنف]) '
    + '&& \'الربط\'[Index] >= EARLIER(\'الربط\'[Index])))', MATCH.missing, '—', '—',
    'يتطلب عمود Index الموجود في Power Query (M_الربط.m:12) وغير موجود في جدول contract_hedge.'),
  c('الربط', 'الكمية السابقة', '[الكمية التراكمية] - [كمية الربط]', MATCH.missing, '—', '—', 'تعتمد على العمود السابق.'),
  c('الارصدة', 'كمية المتاح اضافات', '[اجمالى الرصيد] + [ميناء إضافات]', MATCH.logical, 'available_add', 'src/pbix.js:350'),
  c('الارصدة', 'المتاح يكفى حتى', 'VAR DaysAvailable = [المتاح يكفى] RETURN TODAY() + DaysAvailable',
    MATCH.partial, 'enough_until (مستورد)', 'src/pbix.js:339', 'تاريخ مستورد لا محسوب من اليوم.'),
  c('الارصدة', 'الاجمالى الكلى', '[كمية المتاح اضافات] + [تعاقدات إضافات]', MATCH.logical, 'total_add', 'src/pbix.js:351'),
  c('الارصدة', 'الاجمالى يكفى حتى', 'VAR DaysAvailable = [الاجمالى يكفى] RETURN TODAY() + DaysAvailable',
    MATCH.partial, 'enough_until (مستورد)', 'src/pbix.js:339'),
  c('الارصدة', 'المتاح يكفى', 'DIVIDE([كمية المتاح اضافات], \'الارصدة\'[الاستهلاك])', MATCH.logical, 'available_days', 'src/pbix.js:352'),
  c('الارصدة', 'الاجمالى يكفى', 'DIVIDE([الاجمالى الكلى], \'الارصدة\'[الاستهلاك])', MATCH.logical, 'total_days', 'src/pbix.js:353'),
  c('الارصدة', 'المتاح يكفى يوم  حتى تاريخ',
    'INT(\'الارصدة\'[المتاح يكفى]) & " DAY " & FORMAT(\'الارصدة\'[المتاح يكفى حتى], "YYYY-MM-DD")', MATCH.missing, '—', '—'),
  c('الارصدة', 'الاجمالى يكفى يوم  حتى تاريخ',
    'INT(\'الارصدة\'[الاجمالى يكفى]) & " DAY " & FORMAT(\'الارصدة\'[الاجمالى يكفى حتى], "YYYY-MM-DD")', MATCH.missing, '—', '—'),
  c('الارصدة', 'تكلفة حالية', '[الريت اليومى] * [السعر بالدولار] + [المصاريف]', MATCH.logical, 'current_cost', 'src/pbix.js:354'),
  c('الارصدة', 'الفرق', '[سعر السوق] - [تكلفة حالية]', MATCH.logical, 'diff', 'src/pbix.js:355'),
  c('تسجيل_العقود', 'رقم الشهر الفريد وصول', 'IF(ISBLANK([وصول متوقع]), BLANK(), INT(FORMAT([وصول متوقع], "YYYYMM")))',
    MATCH.missing, '—', '—'),
  c('تسجيل_العقود', 'رقم الشهر الفريد سدلد', 'IF(ISBLANK([متوقع سداد]), BLANK(), INT(FORMAT([متوقع سداد], "YYYYMM")))',
    MATCH.missing, '—', '—'),
];

/** إحصاء الحالة لكل صنف */
function stats() {
  const count = list => {
    const o = {};
    for (const x of list) o[x.status] = (o[x.status] || 0) + 1;
    return o;
  };
  return { measures: count(MEASURES), columns: count(COLUMNS) };
}

module.exports = { MATCH, MEASURES, COLUMNS, stats };
