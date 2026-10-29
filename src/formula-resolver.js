'use strict';
/**
 * حلّ مراجع المعادلات المحفوظة — طبقة نقية (بلا خادم وبلا قاعدة بيانات)
 * =========================================================================
 * وظيفتان:
 *  1) resolveWorkflowFormulas: يحوّل خطوة compute المعتمدة على معادلة محفوظة
 *     إلى تعبيرها المحفوظ (نص فقط) — التقييم يبقى بمحرّك src/formulas.js (المحرك الواحد).
 *  2) resolveReportFormulas: يحوّل مرجع المعادلة في مكوّن التقرير إلى عمود حقيقي
 *     في بيانات التشغيل المحفوظة، أو يعيد رسالة خطأ واضحة.
 */
const FS = require('./formula-store');

/**
 * يحوّل خطوات compute المعتمدة على معادلات محفوظة إلى تعبيراتها.
 * @param {object} wf تعريف التدفق
 * @param {string} dir مجلد المعادلات المحفوظة
 * @returns {{workflow:object, formulaColumns:object, notes:string[]}}
 */
function resolveWorkflowFormulas(wf, dir, data) {
  const steps = (wf.steps || []).map(s => Object.assign({}, s));
  const formulaColumns = {};
  const formulaVersions = {};
  const notes = [];
  const cols = data && Array.isArray(data.columns) ? new Set(data.columns.map(String)) : null;
  for (const s of steps) {
    if (s.type !== 'compute' || !s.formulaId) continue;
    /* استخدام أحدث نسخة إلا إذا طُلب تثبيت صريح لإصدار سابق (سجل تاريخي) */
    const pinned = s.pinFormulaVersion === true && s.formulaVersion !== undefined && s.formulaVersion !== null;
    const f = FS.loadFormula(s.formulaId, dir, pinned ? s.formulaVersion : undefined);
    if (!f) {
      notes.push('تعذّر تحميل المعادلة «' + s.formulaId + '» — لن تُنفَّذ هذه الخطوة');
      continue;
    }
    /* حقول المعادلة يجب أن تكون في مخطط البيانات (خطأ مبكّر وواضح) */
    if (cols) {
      const missing = (f.fields || []).map(x => String(x.name)).filter(n => n && !cols.has(n));
      if (missing.length) {
        notes.push('المعادلة «' + f.name + '» تحتاج حقولًا غير موجودة في البيانات: ' + missing.join('، '));
        continue;
      }
    }
    s.formula = f.expr;
    s.formulaId = f.id;
    s.formulaVersion = f.version;
    s.formulaName = f.name;
    if (s.newColumn) formulaColumns[f.id] = s.newColumn;
    formulaVersions[f.id] = f.version;
  }
  return { workflow: Object.assign({}, wf, { steps }), formulaColumns, formulaVersions, notes };
}

/**
 * يحوّل مراجع المعادلات في مكونات التقرير إلى أعمدة موجودة في بيانات التشغيل.
 * مصدر مباشر (بلا تشغيل محفوظ) غير مدعوم في هذا المسار — يُقال صراحةً.
 * @param {object} report تعريف التقرير
 * @param {object} data بيانات التشغيل {columns, rows, formulaColumns}
 * @returns {{report:object, errors:string[]}}
 */
function resolveReportFormulas(report, data) {
  const cols = new Set((data && data.columns) || []);
  const map = (data && data.formulaColumns) || {};
  const versions = (data && data.formulaVersions) || {};
  const errors = [];
  const comps = (report.components || []).map(c => {
    const f = c && c.formula;
    if (!f || !f.id) return c;
    const col = map[f.id];
    if (!col || !cols.has(col)) {
      errors.push('المعادلة «' + (f.name || f.id) + '» غير مطبَّقة على بيانات هذا التشغيل — أعد تشغيل التدفق أو اختر عمودًا مباشرًا');
      return c;
    }
    /* نسخة المعادلة: لا تُفسّر نتيجة قديمة بإصدار مختلف */
    if (f.version !== undefined && f.version !== null && versions[f.id] !== undefined && Number(versions[f.id]) !== Number(f.version)) {
      errors.push('نسخة المعادلة «' + (f.name || f.id) + '» في التقرير (' + f.version + ') تختلف عن النسخة التي نُفِّذ بها التشغيل (' + versions[f.id] + ') — أعد تشغيل التدفق');
      return c;
    }
    /* المعادلة تُغذّي قيمة العنصر: KPI/جدول ⇒ column، مخططات ⇒ value */
    const next = Object.assign({}, c, { column: col });
    if (c.type === 'bar' || c.type === 'line' || c.type === 'pie') next.value = col;
    if (c.type === 'table') {
      const list = Array.isArray(c.columns) ? c.columns.slice() : [];
      if (list.indexOf(col) < 0) list.push(col);
      next.columns = list;
    }
    return next;
  });
  return { report: Object.assign({}, report, { components: comps }), errors };
}

module.exports = { resolveWorkflowFormulas, resolveReportFormulas };
