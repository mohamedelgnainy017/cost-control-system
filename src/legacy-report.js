'use strict';
/**
 * استيراد تقرير قائم من التطبيق إلى مصمم التقارير
 * =================================================================
 * وحدة نقية (بلا DB وبلا I/O) ⇒ قابلة للاختبار ببيانات اصطناعية.
 *
 * ثلاثة مصادر للدليل تُفصل صراحةً ولا تُخلط:
 *   runtime  : ناتج التقرير الحقيقي ⇒ الأعمدة دقيقة (المصدر الأول).
 *   code     : استخراج ساكن من الشيفرة ⇒ الدوال والجداول والمعاملات (استدلال).
 *   registry : الأعمدة المصرَّح بها في سجل الشاشات ⇒ تصريح (لا يُثبت).
 *
 * القاعدة: لا يُختلق عمود ولا قيمة ولا معادلة؛ ما لا يُستخرج يُذكر صراحةً.
 */

const MAX_KPI = 4;          // عدد بطاقات المؤشرات المولَّدة تلقائيًا
const MAX_TABLE_COLS = 12;  // أقصى عدد أعمدة في الجدول المولَّد

/* ---------------- أنواع الأعمدة من قيم العيّنة ---------------- */
function inferType(values) {
  let num = 0, str = 0, date = 0, other = 0, seen = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    seen++;
    if (typeof v === 'number') { if (Number.isFinite(v)) num++; else other++; continue; }
    if (typeof v === 'boolean') { other++; continue; }
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) { date++; continue; }
    if (/^-?\d+(\.\d+)?$/.test(s.replace(/,/g, ''))) { num++; continue; }
    str++;
  }
  if (!seen) return 'empty';
  const n = num + str + date + other;
  if (num / n >= 0.8) return 'number';
  if (date / n >= 0.8) return 'date';
  if (str / n >= 0.8) return 'string';
  return 'mixed';
}

/* ---------------- استخراج ساكن من الشيفرة (evidence: code) ---------------- */
function extractCalls(fnText) {
  const calls = [];
  const text = String(fnText || '');
  let m;
  const re1 = /\b([AP])\.(\w+)\s*\(/g;
  while ((m = re1.exec(text)) !== null) calls.push(m[1] + '.' + m[2]);
  const re2 = /\bDB\.(all|get|one)\s*\(/g;
  while ((m = re2.exec(text)) !== null) calls.push('DB.' + m[1]);
  return [...new Set(calls)];
}
function extractParams(text) {
  const out = new Set();
  const re = /\bF\.(\w+)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return [...out];
}
function extractTables(text) {
  const out = new Set();
  const re = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const t = m[1].toLowerCase();
    if (t === 'select' || t === 'lateral' || t === 'unnest') continue;
    out.add(t);
  }
  return [...out];
}
/** يستخرج جسم دالة من نص الشيفرة (عدّ الأقواس) — يُستعمل في الدوال المساعِدة */
function functionBody(codeText, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(codeText);
  if (!m) return '';
  /* بداية الجسم = القوس الذي يلي قوس المعاملات (لا القوس داخل القيم الافتراضية) */
  const pStart = codeText.indexOf('(', m.index);
  if (pStart < 0) return '';
  let pDepth = 0, pEnd = -1;
  for (let i = pStart; i < codeText.length; i++) {
    const c = codeText[i];
    if (c === '(') pDepth++;
    else if (c === ')') { pDepth--; if (!pDepth) { pEnd = i; break; } }
  }
  if (pEnd < 0) return '';
  const start = codeText.indexOf('{', pEnd);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < codeText.length; i++) {
    const c = codeText[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return codeText.slice(start, i + 1); }
  }
  return '';
}

/**
 * الاستخراج الساكن: دوال مُستدعاة · جداول SQL · معاملات الفلاتر.
 * @param {string} fnText نص دالة التنفيذ (def.fn.toString())
 * @param {object} code {analytics, pbix} نصوص الشيفرة المساعدة
 */
function staticFromCode(fnText, code) {
  const src = code || {};
  const all = [src.analytics || '', src.pbix || ''].join('\n');
  const calls = extractCalls(String(fnText || ''));
  const params = new Set(extractParams(String(fnText || '')));
  const tables = new Set(extractTables(String(fnText || '')));   /* SQL مكتوب داخل الدالة نفسها */
  let text = String(fnText || '');
  for (const c of calls) {
    const name = c.split('.').pop();
    const body = functionBody(all, name);
    if (!body) continue;
    text += '\n' + body;
    for (const p of extractParams(body)) params.add(p);
    for (const t of extractTables(body)) tables.add(t);
  }
  return {
    functions: calls,
    params: [...params].sort(),
    tables: [...tables].sort(),
    evidence: 'code',
    confidence: 'low',   // استدلالي: يُراجَع مقابل التنفيذ
  };
}

/* ---------------- التحويل إلى تعريف مصمم قابل للتحرير ---------------- */
/**
 * @param {object} input {name,label,desc,rows,columns,declared,staticMeta,params}
 * @returns {object} {report, extraction}
 */
function convertToDesigner(input) {
  const src = input || {};
  const name = String(src.name || '').trim();
  const label = String(src.label || name || 'تقرير');
  const rows = Array.isArray(src.rows) ? src.rows : null;
  const declaredList = Array.isArray(src.declared) ? src.declared : [];
  const declaredNames = declaredList.map(d => String(d && d.name ? d.name : d)).filter(Boolean);

  /* أعمدة حقيقية من ناتج التقرير (المصدر الأدق) */
  let runtimeCols = [];
  if (rows && rows.length) {
    const seen = new Set();
    for (const r of rows.slice(0, 50)) {
      if (!r || typeof r !== 'object') continue;
      for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); runtimeCols.push(k); }
    }
  } else if (Array.isArray(src.columns) && src.columns.length) {
    runtimeCols = src.columns.map(String);
  }

  const types = {};
  for (const c of runtimeCols) {
    const sample = rows ? rows.slice(0, 50).map(r => (r ? r[c] : null)) : [];
    types[c] = inferType(sample);
  }
  const numeric = runtimeCols.filter(c => types[c] === 'number');

  /* المكوّنات: عنوان + وصف + بطاقات مؤشرات للأعمدة الرقمية + جدول */
  const components = [];
  let n = 0;
  const nextId = p => p + (++n);
  components.push({ id: nextId('e'), type: 'heading', text: label, grid: { w: 12, h: 1 } });
  if (src.desc) components.push({ id: nextId('e'), type: 'text', text: String(src.desc).slice(0, 300), grid: { w: 12, h: 1 } });
  for (const c of numeric.slice(0, MAX_KPI)) {
    components.push({ id: nextId('k'), type: 'kpi', label: c, column: c, agg: 'sum', grid: { w: 3, h: 1 } });
  }
  const tableCols = runtimeCols.slice(0, MAX_TABLE_COLS);
  if (tableCols.length) {
    components.push({ id: nextId('t'), type: 'table', columns: tableCols, limit: 20, grid: { w: 12, h: 2 } });
  }

  /* الفروق بين التصريح والتنفيذ */
  const missingAtRuntime = declaredNames.filter(c => !runtimeCols.includes(c));
  const notDeclared = runtimeCols.filter(c => !declaredNames.includes(c));

  const notes = [];
  if (rows && rows.length) {
    notes.push('الأعمدة مستخرجة من ناتج التقرير الحقيقي: ' + runtimeCols.length + ' عمود من ' + rows.length + ' صف.');
  } else {
    notes.push('لم يُنفَّذ التقرير ⇒ لا أعمدة حقيقية؛ استُخدم التصريح المسجَّل فقط (غير مُثبت).');
  }
  if (numeric.length) notes.push('بطاقات المؤشرات مولَّدة من الأعمدة الرقمية (' + Math.min(numeric.length, MAX_KPI) + ' من ' + numeric.length + ').');
  if (runtimeCols.length > MAX_TABLE_COLS) notes.push('الجدول يعرض أول ' + MAX_TABLE_COLS + ' عمودًا من ' + runtimeCols.length + ' (الباقي متاح للإضافة يدويًا).');
  if (missingAtRuntime.length) notes.push('أعمدة مصرَّح بها في السجل ولم تظهر في الناتج: ' + missingAtRuntime.join('، ') + '.');
  if (notDeclared.length) notes.push('أعمدة في الناتج غير مصرَّح بها في السجل: ' + notDeclared.join('، ') + '.');
  const st = src.staticMeta || {};
  if (st.tables && st.tables.length) notes.push('جداول مرجَّحة من الشيفرة (استدلال): ' + st.tables.join('، ') + '.');
  if (st.params && st.params.length) notes.push('معاملات/فلاتر مدعومة (استدلال): ' + st.params.join('، ') + '.');
  notes.push('المكوّنات المولَّدة نقطة بداية قابلة للتحرير — لا تُعدّ بديلًا عن تعريف التقرير الأصلي.');

  const report = {
    name: label + ' — مستورد',
    title: label,
    description: String(src.desc || '').slice(0, 400),
    runId: '',
    legacy: { name, params: src.params || {} },
    source: { name, label },
    layout: { columns: 12, gap: 12, pageWidth: 1200 },
    components,
  };

  const extraction = {
    name, label, desc: src.desc || '',
    runtime: {
      ok: !!(rows && rows.length),
      rowCount: rows ? rows.length : 0,
      columns: runtimeCols.map(c => ({ name: c, type: types[c], evidence: rows && rows.length ? 'runtime' : 'declared' })),
      error: src.runtimeError || null,
    },
    code: st || { evidence: 'code', functions: [], params: [], tables: [] },
    declared: declaredNames.map(c => ({ name: c, evidence: 'registry' })),
    diff: { missingAtRuntime, notDeclared },
    notes,
  };

  return { report, extraction };
}

module.exports = {
  inferType, extractCalls, extractParams, extractTables, functionBody,
  staticFromCode, convertToDesigner,
  MAX_KPI, MAX_TABLE_COLS,
};
