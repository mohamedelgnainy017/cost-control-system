'use strict';
/**
 * عمود «العقد» في ورقة البورصة — خلية تاريخ لا نص
 * ------------------------------------------------
 * الصيغة في الملف:  [$-C01]B2\ \ \ yy* \ \ mmmm\ \   ← تُعرض في Excel هكذا:
 *      «   26     ديسمبر  »      (46357 = 2026-12-01)
 *
 * قراءة SheetJS المنسّقة تعطي «45 December» لأنها تفسّر رمز Lotus B2 تفسيراً
 * خاطئاً (النتيجة ثابتة = 45 مهما كانت الخلية)، لذلك نقرأ القيمة الخام من الخلية
 * ونعيد بناء العرض كما تفعله Excel تماماً: سنتان + اسم الشهر بالعربية المصرية.
 *
 * الصيغ المقبولة عند التعديل اليدوي:
 *   26 ديسمبر | 26 December | ديسمبر 2026 | December 2026 | 2026-12 | 2026-12-01 | 12/2026
 * التخزين: النص المعروض «26 ديسمبر»، والكتابة في الملف تتم كتاريخ (أول الشهر).
 */

const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];
const EN_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const EPOCH = Date.UTC(1899, 11, 30);   // epoch إكسل (1900 system)
const pad = n => String(n).padStart(2, '0');

/** أرقام هندية/فارسية → لاتينية + تنظيف المسافات والاتجاه */
function normalize(v) {
  let s = v === null || v === undefined ? '' : String(v);
  s = s.replace(/[\u200f\u200e\u00a0]/g, ' ')
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
  return s.replace(/\s+/g, ' ').trim();
}

/** «ديسمبر» | «December» | «Dec» → 12 */
function monthIndex(word) {
  const w = normalize(word).toLowerCase();
  if (!w) return null;
  const ar = AR_MONTHS.indexOf(w);
  if (ar >= 0) return ar + 1;
  const en = EN_MONTHS.indexOf(w);
  if (en >= 0) return en + 1;
  return EN_ABBR.indexOf(w) + 1 || null;
}

/** التسمية كما تعرضها Excel: «26 ديسمبر» */
function labelOf(year, month) {
  return `${String(year).slice(2)} ${AR_MONTHS[month - 1]}`;
}

function isoOf(year, month) { return `${year}-${pad(month)}-01`; }

/** سنتان رقميتان ← سنة كاملة (45 → 2045) */
function yearFrom2(yy) { return yy <= 60 ? 2000 + yy : 1900 + yy; }

/**
 * تحويل صيغة مكتوبة إلى { iso, label, year, month } — أو null إذا لم تُفهم.
 * اليوم يُهمَّل دائماً (العقد = سنة + شهر، والأصل في الملف أول الشهر).
 */
function parseContract(v) {
  const s = normalize(v);
  if (!s) return null;

  let m;
  // 2026-12 / 2026-12-01 / 2026/12/3
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/))) return pack(+m[1], +m[2]);
  // 12/2026 / 12-2026
  if ((m = s.match(/^(\d{1,2})[-/.](\d{4})$/))) return pack(+m[2], +m[1]);
  // 26 ديسمبر / 26 December
  if ((m = s.match(/^(\d{1,2})\s+(.+)$/))) return pack(yearFrom2(+m[1]), monthIndex(m[2]));
  // ديسمبر 2026 / December 2026
  if ((m = s.match(/^([^\d]{2,})\s+(\d{4})$/))) return pack(+m[2], monthIndex(m[1]));
  // ديسمبر 26
  if ((m = s.match(/^([^\d]{2,})\s+(\d{1,2})$/))) return pack(yearFrom2(+m[2]), monthIndex(m[1]));
  return null;
}

function pack(year, month) {
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;
  // حدود واقعية: العقود خلال شهور قليلة، و«45» في القاعدة هو أثر قراءة SheetJS الخاطئ
  // لرمز B2 — منع أي سنة بعد 2040 يوقف دخول تلك القيمة الخاطئة إلى الملف.
  if (year < 1990 || year > 2040) return null;
  return { year, month, iso: isoOf(year, month), label: labelOf(year, month) };
}

/** رقم إكسل (serial) ← «26 ديسمبر» */
function fromSerial(n) {
  if (!Number.isFinite(n) || n < 1) return null;
  const d = new Date(EPOCH + Math.round(n) * 86400000);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const p = pack(y, mo);
  return p ? p.label : null;
}

/**
 * قيمة خلية العقد كما هي في الملف (خام أو منسّق) ← قيمة للعرض/التخزين:
 * رقم (serial) يعاد بناؤه كتسمية Excel، ونص يُنظَّف كما هو.
 */
function fromCell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && isFinite(v)) {
    const lbl = fromSerial(v);
    if (lbl) return lbl;
    return normalize(String(v)) || null;
  }
  const s = normalize(v);
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {            // رقم مكتوب كنص داخل خلية نصية
    const n = Number(s);
    if (n > 20000 && n < 80000) return fromSerial(n) || s;
  }
  return s;
}

const HINT = 'صيغة العقد: (سنتان + اسم الشهر) مثل «26 ديسمبر»، أو «ديسمبر 2026»، أو «2026-12»';

module.exports = {
  AR_MONTHS, EN_MONTHS,
  normalize, monthIndex, labelOf, parseContract, fromSerial, fromCell, HINT,
};
