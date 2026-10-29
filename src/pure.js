'use strict';
/**
 * وحدة الدوال الصِّرفة (Phase 0.3C) — الوحدة المستقلة عن قاعدة البيانات
 * =========================================================================
 * هذه الوحدة **بلا أي `require`** — لا قاعدة بيانات، لا ملفات، لا شبكة،
 * لا عمليات فرعية، لا مؤقتات. استيرادها لا يُنفّذ أي أثر جانبي إطلاقًا.
 *
 * تُنقل إلى هنا الدوال الصِّرفة **حرفيًا** (بلا تغيير سلوك أو أسماء).
 * ما نُقل حتى الآن:
 *   - `clsKey`  — Phase 0.3C-B1 (من src/analytics.js)
 *                 ومصدر مشترك لـ src/pbix.js — Phase 0.3C-B1b
 *                 (كانت متطابقة حرفيًا في الملفين قبل التوحيد)
 *   - `normAr`  — Phase 0.3C-B2a (من src/server.js)
 *   - `ceil1000` — Phase 0.3C-B3a (من src/pbix.js)
 *   - `pad2`    — Phase 0.3C-B4a (من src/pbix.js/server.js/borse-fetch.js)
 *                 النسخ الثلاث كانت متماثلة دلاليًا (اختلاف اسم المعامل فقط:
 *                 `x` في pbix.js و`n` في الآخرين)؛ اعتُمد اسم المعامل `n`.
 *   - `toUtc`, `shift`, `nextDay`, `eachDay` — Phase 0.3C-B5 (من src/cost-engine.js)
 *                 (حسابات UTC لتجنب التحوّل الصيفي؛ `pad` موحَّد مع `pad2`).
 *   - `numf`, `r2` — Phase 0.3C-B6 (من src/analytics.js)
 *                 (numf: null/undefined/'' -> 0؛ r2: تقريب 2 خانات، يعتمد على numf).
 *
 * لم يُنقل بعد (بانتظار موافقة): conds، parseFilters، PERIOD_EXPRS،
 * round، applyColFilters، pad.
 *
 * تنبيه: لا تُوحَّد `clsKey` مع `normAr` — عقدهما مختلف عمدًا
 * (انظر توثيق الفرق في تقرير المرحلة 0.3C).
 */

/** تطبيع اسم التصنيف: حذف التطويل والمسافات وتوحيد الهمزات/الياء/التاء المربوطة */
function clsKey(s) {
  return String(s || '')
    .replace(/[\u0640\s]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
}

/* تطبيع نصي عربي موحّد: توحيد الهمزات/الياء/التاء المربوطة + إسقاط التشكيل والفراغات والفواصل */
const normAr = s => String(s === null || s === undefined ? '' : s).toLowerCase()
  .replace(/[أإآٱ]/g, 'ا').replace(/[ىي]/g, 'ي').replace(/[ةه]/g, 'ه')
  .replace(/[\u064B-\u065F\u0670]/g, '').replace(/[\s,،_()\-]/g, '');

const ceil1000 = x => Math.ceil(x / 1000) * 1000;

/* تصفير رقم إلى خانتين (نص) — إن كان الطول ≥ 2 يُعاد كما هو */
const pad2 = n => String(n).padStart(2, '0');

/* ---------- مساعدات تواريخ UTC (Phase 0.3C-B5) ----------
   كل حسابات التواريخ هنا على UTC عمداً: في توقيت Africa/Cairo يُنزلق
   `new Date(iso + 'T00:00:00')` إلى 01:00 بعد التحوّل الصيفي، فتُخسر
   جملة `while (d <= end)` اليوم الأخير من المدى (مُختبَر: 1740 يوماً
   بدل 1741). UTC لا يعرف التحوّل الصيفي إطلاقاً.
   منقولة حرفيًا (مع توحيد `pad` → `pad2`) من src/cost-engine.js. */
const D_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const toUtc = s => { const m = D_RE.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };

/** إزاحة تاريخ بـ n يوم (UTC) */
function shift(s, n) {
  const t = toUtc(s);
  if (!isFinite(t)) return s;
  const d = new Date(t + n * 86400000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function nextDay(s) { return shift(s, 1); }

/** كل الأيام التقويمية من from إلى to (UTC) — إن كان النطاق غير صالح returns [] */
function eachDay(from, to) {
  const out = [];
  const s = toUtc(from), e = toUtc(to);
  if (!isFinite(s) || !isFinite(e) || s > e) return out;
  for (let t = s; t <= e; t += 86400000) {
    const d = new Date(t);
    out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`);
  }
  return out;
}

/* ---------- مساعدات رقمية (Phase 0.3C-B6) ----------
   منقولة حرفيًا من src/analytics.js (قبل B6).
   numf: null/undefined/'' -> 0، وإلا Number(v) || 0.
   r2: تقريب إلى خانتين (يعتمد على numf، لذا null/undefined/'' -> 0). */
const numf = v => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const r2 = n => Math.round(numf(n) * 100) / 100;

module.exports = { clsKey, normAr, ceil1000, pad2, toUtc, shift, nextDay, eachDay, numf, r2 };