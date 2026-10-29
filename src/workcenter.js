'use strict';
/**
 * مركز العمل — تجميع حالة المنصة من بيانات فعلية فقط
 * =====================================================================
 * لا بيانات اصطناعية ولا قيم افتراضية: كل عنصر إما قادم من مصدر حقيقي
 * أو حالة فارغة صريحة (empty) تُعرض للمستخدم بوضوح.
 *
 * الوحدة نقية (بلا DB وبلا I/O) ⇒ قابلة للاختبار ببيانات اصطناعية.
 */
const LIMIT = 5;   // عدد العناصر في بطاقات «الأحدث»

/** آخر التشغيلات (مع حالة التتبّع) */
function recentRuns(runs) {
  const list = Array.isArray(runs) ? runs : [];
  return list.slice(0, LIMIT).map(r => ({
    runId: r.runId || '',
    source: r.source ? (r.source.label || r.source.name || '') : '',
    workflowName: r.workflowName || '',
    rows: Number(r.rowCount) || 0,
    columns: Array.isArray(r.columns) ? r.columns.length : 0,
    savedAt: r.savedAt || '',
    traced: !!r.traced,
    definitionChanged: r.definitionChanged === true,
    engineState: r.engineState || 'unknown',
    warnings: Array.isArray(r.warnings) ? r.warnings.length : 0,
  }));
}

/** آخر التقارير المحفوظة */
function recentReports(reports) {
  const list = Array.isArray(reports) ? reports : [];
  return list.slice(0, LIMIT).map(r => ({
    id: r.id || '',
    name: r.name || '',
    runId: r.runId || '',
    source: r.source && r.source.label ? r.source.label : '',
    savedAt: r.savedAt || '',
    traced: !!(r.source && r.source.traced),
  }));
}

/** المعادلات المحفوظة */
function recentFormulas(formulas) {
  const list = Array.isArray(formulas) ? formulas : [];
  return list.slice(0, LIMIT).map(f => ({
    id: f.id || '',
    name: f.name || '',
    version: Number(f.version) || 1,
    origin: f.origin === 'visual' ? 'بصري' : 'نصّي',
    updatedAt: f.updatedAt || '',
  }));
}

/** صحة المنصة: ما هو مُنفَّذ فعلًا مقابل الموثَّق فقط */
function health(catalog, model, screens) {
  const cat = catalog || {};
  const st = cat.byStatus || {};
  const mod = model || {};
  const scr = screens || {};
  return {
    sources: {
      total: Number(cat.total) || 0,
      implemented: Number(st['منفّذ']) || 0,
      documented: Number(st['موثق فقط']) || 0,
      other: Math.max(0, (Number(cat.total) || 0) - (Number(st['منفّذ']) || 0) - (Number(st['موثق فقط']) || 0)),
      canonical: cat.canonicalBalance || '',
    },
    formulas: {
      total: Number((mod.formulas || {}).total) || 0,
      byStatus: (mod.formulas || {}).byStatus || {},
      numericVerified: Number(mod.numericVerified) || 0,
    },
    screens: {
      total: Number(scr.screens) || 0,
      reports: Number(scr.reports) || 0,
      visibleReports: Number(scr.visibleReports) || 0,
    },
  };
}

/** تنبيهات: ما يستحق انتباه المستخدم فعلًا */
function alerts(runs, catalog, model) {
  const out = [];
  const truncated = (Array.isArray(runs) ? runs : []).filter(r => (Array.isArray(r.warnings) ? r.warnings.length : 0) > 0);
  if (truncated.length) {
    out.push({
      kind: 'warn', title: 'نتائج تحتاج انتباهًا',
      detail: truncated.length + ' نتيجة تحمل تحذيرات (اقتطاع أو ربط غير مكتمل) — راجع «تتبّع النتيجة» قبل الاعتماد عليها.',
      count: truncated.length, target: 'workflow',
    });
  }
  const untraced = (Array.isArray(runs) ? runs : []).filter(r => !r.traced);
  if (untraced.length) {
    out.push({
      kind: 'info', title: 'نتائج قديمة بلا تتبّع كامل',
      detail: untraced.length + ' نتيجة سابقة لا تحمل تعريف تشغيلها — لا يمكن التحقق منها آليًا.',
      count: untraced.length, target: 'workflow',
    });
  }
  const engineChanged = (Array.isArray(runs) ? runs : []).filter(r => r.engineState === 'changed');
  if (engineChanged.length) {
    out.push({
      kind: 'warn', title: 'نتائج حُسبت بمحرّك معادلات أقدم',
      detail: engineChanged.length + ' نتيجة استخدمت إصدارًا أقدم من محرّك المعادلات — لا تُقارن أرقامها بالنتيجة الحالية دون إعادة التشغيل.',
      count: engineChanged.length, target: 'analysis',
    });
  }
  const docOnly = Number(((catalog || {}).byStatus || {})['موثق فقط']) || 0;
  if (docOnly) {
    out.push({
      kind: 'info', title: 'مصادر موثّقة بلا تنفيذ',
      detail: docOnly + ' مصدر مُوثَّق في الفهرس بلا مسار قراءة في محرّك التدفقات.',
      count: docOnly, target: 'analysis',
    });
  }
  const st = ((model || {}).formulas || {}).byStatus || {};
  const missing = Number(st['غير منفَّذ']) || 0;
  if (missing) {
    out.push({
      kind: 'info', title: 'معادلات مسجّلة غير منفَّذة',
      detail: missing + ' معادلة مسجّلة في مرجع DAX بلا تنفيذ في الكود.',
      count: missing, target: 'analysis',
    });
  }
  return out;
}

/** الإجراءات السريعة (روابط داخلية فقط — لا مسارات API جديدة) */
function quickActions() {
  return [
    { id: 'workflow', label: 'تحليل جديد', hint: 'استوديو التدفقات: مصدر ← خطوات ← تشغيل', target: 'workflow' },
    { id: 'quick-report', label: 'تقرير سريع', hint: 'مصدر + أعمدة ⇒ نتيجة جاهزة للتقرير', target: 'report-studio', action: 'quick' },
    { id: 'explorer', label: 'مستكشف البيانات', hint: 'المصادر والحقول والمعادلات والعلاقات', target: 'analysis' },
    { id: 'reports', label: 'التقارير المحفوظة', hint: 'فتح وتعديل ونسخ وتصدير', target: 'reports-manager' },
  ];
}

/** الشاشات المخصّصة المحفوظة (مصمم الشاشات) */
function recentScreens(screens) {
  const list = Array.isArray(screens) ? screens : [];
  return list.slice(0, LIMIT).map(s => ({
    id: s.id || '',
    name: s.name || '',
    runId: s.runId || '',
    components: Number(s.components) || 0,
    buttons: Number(s.buttons) || 0,
    savedAt: s.savedAt || '',
  }));
}

/**
 * يبني عرض مركز العمل من استجابات API الفعلية.
 * @param {object} p {runs, reports, formulas, catalog, model, screens, savedScreens}
 */
function buildWorkCenter(p) {
  const src = p || {};
  const runs = recentRuns(src.runs);
  const reports = recentReports(src.reports);
  const formulas = recentFormulas(src.formulas);
  const h = health(src.catalog, src.model, src.screens);
  const screens = recentScreens(src.savedScreens);
  return {
    generatedAt: new Date().toISOString(),
    runs, reports, formulas, screens,
    health: h,
    alerts: alerts(src.runs, src.catalog, src.model),
    actions: quickActions(),
    empty: {
      runs: runs.length === 0,
      reports: reports.length === 0,
      formulas: formulas.length === 0,
      screens: screens.length === 0,
    },
  };
}

module.exports = { buildWorkCenter, recentRuns, recentReports, recentFormulas, recentScreens, health, alerts, quickActions, LIMIT };
