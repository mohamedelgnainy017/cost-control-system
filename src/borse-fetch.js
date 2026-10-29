'use strict';
/**
 * الجلب الذاتي لأسعار البورصة وريت الدولار (borse-fetch)
 * =====================================================
 * نقطة الانفصال عن ملف Excel: من هنا فصاعداً النظام لا يقرأ ولا يكتب أي ملف
 * بورصة — بل يجلب بنفسه:
 *   • منخفض/عالي/إغلاق كل صنف من Yahoo Finance (iClearing/CBOT عبر .CBT)
 *   • ريت الدولار (banknoteSell) من صفحة بنك مصر الرسمية
 * ثم يكتبها مباشرة في جدول `borse` كأيام جديدة تحت الأرشيف المستورد.
 *
 * القواعد كلها موروثة من أداة borse-tool (التي تبقى تعمل على الملف بشكل مستقل):
 *   1. تقريب الإغلاق: floor للذرة (ZC) والبذرة (ZS)، وعشري من منزلة واحدة
 *      بتقريب «نصف زوجي» للصويا (ZM) — مطابق لـ [Math]::Round في الأداة.
 *   2. التمرير التلقائي: أقرب عقد بتسليم قادم (ليس في شهر تسليمه) ولديه جلسة
 *      طازجة ≤4 أيام، مع إعادة محاولة البحث عند فقدان الحداثة — فيتحدّث عمود
 *      «العقد» تلقائياً مع أسعاره.
 *   3. العطلات: إن لم توجد جلسة في يوم المطلوب تُعاد آخر جلسة خلال 7 أيام
 *      (نفس ما تفعله الورقة دائماً في الجمعة/السبت).
 *   4. حماية تاريخ صفحة البنك: إن كان تاريخ الصفحة أحدث من يوم الجلب نحتفظ
 *      بقيمة الريت المخزنة لذلك اليوم (أو نرجع تاريخياً للأقرب السابق) بدل
 *      خلط رقم حديث بيوم قديم.
 *   5. أعمدة النولون/المصاريف/المعامل/سعر التكلفة تُحمَّل للأمام من آخر صف،
 *      تماماً كقاعدة carry في الأداة — فلا تتغيّر قاعدة «النولون أرضه».
 *   6. جدول التعديلات اليدوية (borse_overrides) يعلو الجلب دائماً: الجلب يكتب
 *      «القيمة الأساسية»، وتعديل المستخدم يبقى سارياً من تاريخه فما بعد.
 */
const DB = require('./db');
const Contract = require('./contract');
const { pad2 } = require('./pure');

/** بصمة الصفوف القادمة من الجلب في borse.source_file */
const SRC = 'borse-fetch';

/** بصمة صفوف الإدخال اليدوي (src/daily-entry.js) — لا يمسّها الجلب أبداً */
const MANUAL = 'manual';

const STATE_KEY = 'borse_fetch_state';
const TIME_KEY = 'borse_fetch_time';
const DEFAULT_TIME = '22:00';   // بعد اكتمال جلسة البورصة الأمريكية (18:20 UTC)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const USD_URL = 'https://www.banquemisr.com/Home/CAPITAL%20MARKETS/Exchange%20rates%20and%20currencies?sc_lang=ar-EG';
const USD_FLAG = 'usd.ashx';
const USD_FIELD = 'banknoteSell';

/* الصنوف الثلاثة المعروضة في البورصة + قاعدة تقريب إغلاقها */
const ITEMS = [
  { code: '1001', root: 'ZC', round: 'floor' },      // ذرة — corn
  { code: '1002', root: 'ZM', round: 'decimal1' },   // صويا (نولون) — soybean meal
  { code: '1004', root: 'ZS', round: 'floor' },      // بذرة — soybeans
];

const MONTH_CODES = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];
const FRESH_DAYS = 4;       // أقدم جلسة تُعدّ العقد «نشط» (نهاية أسبوع + عطلة)
const FALLBACK_DAYS = 7;    // حد إعادة استخدام آخر جلسة
const MAX_GAP = 60;         // أقدم يوم يُلتقط في عملية تعويض
const SCAN_MONTHS = 24;     // مدى بحث التمرير إلى الأمام
const RETRY_MS = 30 * 60000;   // إعادة محاولة بعد فشل
const SPACING_MS = 15 * 60000;  // لا محاولتين متتاليتين أقرب من ذلك
const EARLIEST = '06:00';   // التعويض لا يبدأ قبل صباح اليوم
const HTTP_TIMEOUT_MS = 30000;

/* ---------------- تواريخ ---------------- */
const isoDate = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const iso = v => (v instanceof Date)
  ? isoDate(v)
  : String(v || '').slice(0, 10);
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(isoStr, n) {
  const d = new Date(isoStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dayDiff = (from, to) =>
  Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);

function stampNow() {
  const d = new Date();
  return `${isoDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
const log = (...a) => { try { console.log('[borse-fetch]', ...a); } catch (_) {} };

/** موعد الجلب اليومي: إعداد `borse_fetch_time` ← متغيّر البيئة ← الافتراضي */
async function fetchTime() {
  let v = '';
  try { v = String((await DB.getSetting(TIME_KEY, '')) || process.env.BORSE_FETCH_TIME || '').trim(); }
  catch (_) { v = ''; }
  return /^\d{2}:\d{2}$/.test(v) ? v : DEFAULT_TIME;
}

/* ---------------- HTTP ---------------- */
async function httpGet(url, asJson) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8' },
      signal: ctl.signal,
    });
    if (!r.ok) {
      const e = new Error(`HTTP ${r.status} من ${new URL(url).host}`);
      e.code = 'net';
      throw e;
    }
    const txt = await r.text();
    if (!asJson) return txt;
    try { return JSON.parse(txt); }
    catch (_) {
      const e = new Error(`رد غير متوقع (ليس JSON) من ${new URL(url).host}`);
      e.code = 'net';
      throw e;
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      const x = new Error(`انتهت مهلة الاتصال بـ ${new URL(url).host}`);
      x.code = 'net';
      throw x;
    }
    if (!e.code) e.code = 'net';
    throw e;
  } finally { clearTimeout(t); }
}

/* ---------------- أسعار البورصة (Yahoo) ---------------- */
async function yahooBars(symbol, range) {
  let lastErr = null;
  for (const host of YAHOO_HOSTS) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false`;
    let j;
    try { j = await httpGet(url, true); }
    catch (e) { lastErr = e; continue; }

    const err = j && j.chart && j.chart.error;
    if (err) {
      lastErr = Object.assign(new Error(err.description || err.code || 'خطأ من Yahoo'), { code: 'no_symbol' });
      continue;
    }
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res || !res.timestamp || !res.indicators || !res.indicators.quote) {
      lastErr = Object.assign(new Error(`لا توجد بيانات للعقد ${symbol}`), { code: 'no_symbol' });
      continue;
    }
    const q = res.indicators.quote[0] || {};
    const bars = [];
    for (let i = 0; i < res.timestamp.length; i++) {
      const lo = q.low[i], hi = q.high[i], cl = q.close[i];
      if (lo == null || hi == null || cl == null) continue;
      bars.push({
        date: new Date(res.timestamp[i] * 1000).toISOString().slice(0, 10),
        low: Number(lo), high: Number(hi), close: Number(cl),
        open: q.open[i] == null ? null : Number(q.open[i]),
      });
    }
    if (!bars.length) {
      lastErr = Object.assign(new Error(`سلسلة فارغة للعقد ${symbol}`), { code: 'no_symbol' });
      continue;
    }
    bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return bars;
  }
  throw lastErr || Object.assign(new Error('تعذّر جلب أسعار البورصة'), { code: 'net' });
}

/** جلسة يوم معيّن، وإلا آخر جلسة خلال 7 أيام (سلوك الورقة في العطلات) */
function pickBar(bars, target) {
  for (const b of bars) if (b.date === target) return { ...b, reused: false };
  const limit = addDays(target, -FALLBACK_DAYS);
  let best = null;
  for (const b of bars) if (b.date < target && b.date >= limit) best = b;
  if (best) return { ...best, reused: true };
  throw Object.assign(
    new Error(`لا توجد جلسة بورصة في ${target} ضمن آخر ${FALLBACK_DAYS} أيام`),
    { code: 'no_bar' });
}

/**
 * العقد الأمامي: أقرب شهر تسليم قادم يملك جلسة طازجة.
 * الشهر نفسه مُستبعد دائماً (عقد في شهر تسليمه لا يُستخدم — التمرير التجاري).
 */
async function frontContract(root, range, today) {
  let fallback = null;
  let netErr = null;
  const m0 = Number(today.slice(5, 7)) - 1;
  const y0 = Number(today.slice(0, 4));
  for (let i = 0; i < SCAN_MONTHS; i++) {
    const off = m0 + i;
    const y = y0 + Math.floor(off / 12);
    const m = (off % 12) + 1;
    const delivery = `${y}-${pad2(m)}-01`;
    if (delivery <= today) continue;
    const symbol = `${root}${MONTH_CODES[m - 1]}${String(y).slice(2)}.CBT`;
    let bars;
    try { bars = await yahooBars(symbol, range); }
    catch (e) { if (e.code === 'net') netErr = e; continue; }
    const lastBar = bars[bars.length - 1].date;
    const cand = {
      symbol, year: y, month: m, label: Contract.labelOf(y, m),
      bars, lastBar, age: dayDiff(lastBar, today),
    };
    if (cand.age <= FRESH_DAYS) return cand;
    if (!fallback) fallback = cand;
  }
  if (fallback) return fallback;
  throw netErr ||
    Object.assign(new Error(`لا يوجد عقد نشط لـ ${root} خلال ${SCAN_MONTHS} شهراً`), { code: 'no_symbol' });
}

/* ---------------- التقريب ---------------- */
/** تقريب نصف زوجي (ToEven) — نفس سلوك [Math]::Round في أداة PowerShell */
function roundEven(x, digits) {
  const f = 10 ** digits;
  const s = x * f;
  const fl = Math.floor(s);
  const frac = s - fl;
  let r;
  if (Math.abs(frac - 0.5) < 1e-9) r = (fl % 2 === 0) ? fl : fl + 1;
  else r = Math.round(s);
  return r / f;
}

function roundVal(v, mode) {
  if (v === null || v === undefined || !isFinite(v)) return null;
  if (mode === 'floor') return Math.floor(v);
  if (mode === 'decimal1') return roundEven(v, 1);
  return v;
}

/* ---------------- ريت الدولار (بنك مصر) ---------------- */
async function fetchUsd() {
  const html = await httpGet(USD_URL, false);
  const flag = USD_FLAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rowRe = new RegExp(`<tr[^>]*>\\s*<td[^>]*>\\s*<img[^>]*${flag}[\\s\\S]*?</tr>`, 'i');
  const row = html.match(rowRe);
  if (!row) throw Object.assign(new Error('لم يُعثر على صف الدولار في صفحة بنك مصر — تغيّر شكل الصفحة؟'), { code: 'layout' });

  const nums = [];
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = cellRe.exec(row[0]))) {
    const txt = m[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (/^-?\d+([.,]\d+)?$/.test(txt)) nums.push(Number(txt.replace(',', '.')));
  }
  if (nums.length < 4) {
    throw Object.assign(new Error(`تنسيق صف العملة في صفحة بنك مصر غير متوقع (أرقام=${nums.length})`), { code: 'layout' });
  }
  const rates = { banknoteBuy: nums[0], banknoteSell: nums[1], transferBuy: nums[2], transferSell: nums[3] };
  if (!(USD_FIELD in rates)) throw new Error('حقل ريت غير معروف في الإعداد: ' + USD_FIELD);

  const sm = html.match(/generic-details-title[^>]*>\s*<p>([^<]+)<\/p>/i);
  const pageStamp = sm ? sm[1].replace(/\s+/g, ' ').trim() : '';
  const bm = html.match(/<h4>[^0-9]*(\d+)<\/h4>/i);
  const pd = pageStamp.match(/(\d{2})-(\d{2})-(\d{4})/);
  return {
    rate: rates[USD_FIELD],
    field: USD_FIELD,
    ...rates,
    pageDate: pd ? `${pd[3]}-${pd[2]}-${pd[1]}` : '',
    stamp: pageStamp,
    bulletin: bm ? bm[1] : '',
    fetched: stampNow(),
  };
}

/**
 * ريت يوم معيّن بحماية التاريخ:
 *  - الصفحة أحدث من اليوم ← نحترم القيمة المحفوظة لهذا اليوم، وإلا نرجع
 *    لأقرب قيمة سابقة (نفس منطق الأداة عند تعويض الأيام الفائتة).
 *  - الصفحة أقدم من اليوم (لم تُحدَّث بعد) ← نأخذ آخر رقم منشور مع تنبيه.
 */
async function usdForDate(target, f) {
  if (f.pageDate && f.pageDate > target) {
    const same = await DB.get(
      `SELECT usd_rate FROM borse WHERE borse_date = $1 AND usd_rate IS NOT NULL
        ORDER BY id DESC LIMIT 1`, [target]);
    if (same && same.usd_rate != null) return { rate: Number(same.usd_rate), kept: true, pageDate: f.pageDate };

    const prev = await DB.get(
      `SELECT usd_rate, borse_date FROM borse
        WHERE borse_date < $1 AND usd_rate IS NOT NULL
        ORDER BY borse_date DESC, id DESC LIMIT 1`, [target]);
    if (prev && prev.usd_rate != null) {
      log(`usd صفحة مؤرخة ${f.pageDate} > ${target} → نرجع لقيمة ${iso(prev.borse_date)} (${prev.usd_rate})`);
      return { rate: Number(prev.usd_rate), from: iso(prev.borse_date), backfilled: true, pageDate: f.pageDate };
    }
    throw new Error(`لا توجد قيمة ريت مخزنة ليوم ${target} (صفحة البنك مؤرخة ${f.pageDate})`);
  }
  const stale = f.pageDate && f.pageDate !== target;
  return { rate: f.rate, fresh: true, pageDate: f.pageDate || null, stalePage: stale ? f.pageDate : null };
}

/* ---------------- الحالة ---------------- */
async function loadState() {
  const raw = await DB.getSetting(STATE_KEY, null);
  if (!raw) return {};
  try {
    const s = JSON.parse(raw);
    return s && typeof s === 'object' ? s : {};
  } catch (_) { return {}; }
}

async function saveState(patch) {
  const next = { ...(await loadState()), ...patch };
  await DB.setSetting(STATE_KEY, JSON.stringify(next));
  return next;
}

/** آخر يوم رُفع بنجاح، أو حافة الأرشيف المستورد عند أول تشغيل */
async function floorOf(state, today) {
  let f = state.floor;
  if (!ISO_RE.test(String(f || ''))) {
    const mx = await DB.get('SELECT MAX(borse_date) a FROM borse');
    f = mx && mx.a ? iso(mx.a) : today;
  }
  if (f > today) f = today;
  return f;
}

/** الأيام من floor+1 حتى today (مع سقف تعويض) */
function pendingDates(floor, today) {
  const dates = [];
  const skippedOld = [];
  const minIso = addDays(today, -MAX_GAP);
  let d = addDays(floor, 1);
  while (d <= today) {
    (d < minIso ? skippedOld : dates).push(d);
    d = addDays(d, 1);
  }
  if (!dates.length || dates[dates.length - 1] !== today) dates.push(today);   // يوم اليوم يُجلَّل دائماً
  return { dates, skippedOld };
}

/** أيام فائتة بلا صف (تُعرض في الواجهة كتنبيه) */
async function missingDays(floor, today) {
  const out = [];
  const minIso = addDays(today, -MAX_GAP);
  let d = addDays(floor, 1);
  while (d < today) {
    if (d < minIso) break;
    const r = await DB.get('SELECT 1 x FROM borse WHERE borse_date = $1 LIMIT 1', [d]);
    if (!r) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

/* ---------------- التنفيذ ---------------- */
let busy = false;

async function run({ reason = 'manual' } = {}) {
  if (busy) throw new Error('عملية جلب جارية بالفعل — انتظر حتى تنتهي');
  busy = true;
  const t0 = Date.now();
  const today = isoDate(new Date());
  try {
    const state = await loadState();
    const floor = await floorOf(state, today);
    const { dates, skippedOld } = pendingDates(floor, today);

    /* 1) جلب كل البيانات أولاً — فشل أي منها يعني عدم الكتابة في القاعدة */
    const span = dayDiff(dates[0], today) + 1;
    const range = span <= 20 ? '1mo' : span <= 80 ? '3mo' : '6mo';
    const prices = {};
    const items = [];
    for (const it of ITEMS) {
      const fc = await frontContract(it.root, range, today);
      const perDate = {};
      for (const d of dates) {
        const b = pickBar(fc.bars, d);
        perDate[d] = {
          low: roundVal(b.low, it.round),
          high: roundVal(b.high, it.round),
          close: roundVal(b.close, it.round),
          bar: b.date,
          reused: !!b.reused,
        };
      }
      prices[it.code] = perDate;
      items.push({
        code: it.code, symbol: fc.symbol, contract: fc.label,
        lastBar: fc.lastBar, barAge: fc.age,
        reused: perDate[dates[dates.length - 1]].reused,
      });
      log(`${it.code} ${fc.symbol} (${fc.label}) — جلسة ${perDate[dates[dates.length - 1]].bar}` +
        (perDate[dates[dates.length - 1]].reused ? ' [استخدام جلسة سابقة]' : ''));
    }

    const usdRaw = await fetchUsd();
    const usdByDate = {};
    for (const d of dates) usdByDate[d] = await usdForDate(d, usdRaw);
    log(`usd ${USD_FIELD} = ${usdRaw.rate} (صفحة ${usdRaw.pageDate || 'بلا تاريخ'}، ${dates.length} يوم)`);

    /* 2) الكتابة: صفوف الأيام الجديدة تحمل قيم الصف السابق، والأيام الموجودة تُحدَّث */
    const labelByCode = {};
    for (const x of items) labelByCode[x.code] = x.contract;

    let written = 0, updated = 0, keptArchive = 0;
    for (const d of dates) {
      const existing = await DB.all(
        `SELECT item_code, source_file FROM borse WHERE borse_date = $1 AND item_code IS NOT NULL`, [d]);
      const srcOf = new Map(existing.map(r => [r.item_code, r.source_file]));
      const rate = usdByDate[d].rate;

      for (const it of ITEMS) {
        const p = prices[it.code][d];
        const label = labelByCode[it.code];
        const sf = srcOf.get(it.code);
        if (sf !== undefined) {
          // صف أرشيفي قديم لا نعيد كتابته — الاستثناء الوحيد صف اليوم
          // (الجلب اليومي يقرّر إغلاقه حتى يستقر)؛ ولا يُمَس أي تاريخ قبل اليوم.
          // والصف اليدوي (source_file='manual') محصّن تماماً: «التعديل يعلو الجلب».
          if (sf === MANUAL) { keptArchive++; continue; }
          if (sf !== SRC && d !== today) { keptArchive++; continue; }
          await DB.run(
            `UPDATE borse SET contract = $1, low = $2, high = $3, close = $4, usd_rate = $5
              WHERE borse_date = $6 AND item_code = $7`,
            [label, p.low, p.high, p.close, rate, d, it.code]);
          updated++;
        } else {
          const prev = await DB.get(
            `SELECT * FROM borse WHERE item_code = $1 AND borse_date < $2
              ORDER BY borse_date DESC, id DESC LIMIT 1`, [it.code, d]);
          if (!prev) throw new Error(`لا يوجد صف سابق للصنف ${it.code} لحمل القيم — الأرشيف فارغ؟`);
          await DB.run(
            `INSERT INTO borse (borse_date, contract, item_code, item, low, high, close,
                                basis, borse_now, usd_rate, down_payment, fees, fx_factor,
                                cost_price, source_row, import_id, source_file)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [d, label, it.code, prev.item, p.low, p.high, p.close,
             prev.basis, prev.borse_now, rate, prev.down_payment, prev.fees, prev.fx_factor,
             prev.cost_price, null, null, SRC]);
          written++;
        }
      }
    }

    const out = {
      at: stampNow(), atMs: Date.now(), ok: true, day: today, reason,
      floor: today, dates, skipped: skippedOld, ms: Date.now() - t0,
      items, written, updated, keptArchive,
      usd: { rate: usdRaw.rate, pageDate: usdRaw.pageDate, stamp: usdRaw.stamp, bulletin: usdRaw.bulletin },
    };
    await saveState({ floor: today, lastRun: out });
    log(`اكتمل (${reason}) — ${dates.length} يوم، ${written} صف جديد، ${updated} صف محدَّث، ` +
      `${keptArchive} صف أرشيفي محفوظ، ${out.ms}ms`);
    return out;
  } catch (e) {
    try {
      await saveState({
        lastRun: {
          at: stampNow(), atMs: Date.now(), ok: false, day: today, reason,
          error: String(e.message || e).slice(0, 400),
        },
      });
    } catch (_) {}
    log(`فشل (${reason}): ${e.message}`);
    throw e;
  } finally { busy = false; }
}

/** واجهة حالة الجلب لـ /api/borse/status */
async function status() {
  const state = await loadState();
  const today = isoDate(new Date());
  const floor = await floorOf(state, today);
  const rows = await DB.get('SELECT COUNT(*)::int c, MAX(borse_date) last FROM borse');
  const { dates, skippedOld } = pendingDates(floor, today);
  const lr = state.lastRun || null;
  return {
    rows: rows.c,
    lastDate: rows.last ? iso(rows.last) : null,
    floor,
    pending: dates.filter(d => d !== today),
    missing: await missingDays(floor, today),
    skippedOld: skippedOld.length,
    time: await fetchTime(),
    source: { prices: 'Yahoo Finance', usd: 'بنك مصر' },
    items: (lr && lr.items) || [],
    usd: (lr && lr.usd) || null,
    running: busy,
    lastRun: lr ? {
      at: lr.at, ok: lr.ok !== false, day: lr.day, reason: lr.reason || null,
      dates: lr.dates || [], written: lr.written || 0, updated: lr.updated || 0,
      keptArchive: lr.keptArchive || 0,
      ms: lr.ms || null, error: lr.error || null,
    } : null,
  };
}

/* ---------------- المجدول اليومي ---------------- */
let timer = null;

async function tick() {
  if (busy) return;
  try {
    const state = await loadState();
    const today = isoDate(new Date());
    const time = await fetchTime();
    const now = new Date();
    const hm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

    const lr = state.lastRun;
    const failed = !!lr && lr.ok === false;
    const since = lr && lr.atMs ? Date.now() - lr.atMs : Number.POSITIVE_INFINITY;
    // «جلب موعد اليوم» يُعدّ منجزاً فقط إذا انتهى جلب السبب (وليس تعويضاً سابقاً صباحاً)
    const scheduledDone = !!lr && lr.ok !== false && lr.day === today && lr.reason === 'schedule';
    const scheduled = hm >= time;
    const floor = await floorOf(state, today);
    const gap = floor < today;                       // أيام بلا صف حتى الأمس

    const ready = !failed || since >= RETRY_MS;
    const spaced = !lr || since >= SPACING_MS;
    const due = spaced && ready && !scheduledDone &&
      (scheduled || (gap && hm >= EARLIEST));
    if (!due) return;

    await run({ reason: scheduled ? 'schedule' : 'catchup' });
  } catch (e) {
    log('المجدول: ' + (e && e.message));
  }
}

/** بدء المجدول — يُستدعى بعد إقلاع الخادم */
async function startScheduler(firstDelayMs = 15000) {
  if (timer) return timer;
  const loop = setInterval(() => { tick().catch(() => {}); }, 60000);
  if (loop.unref) loop.unref();
  timer = loop;
  const first = setTimeout(() => { tick().catch(() => {}); }, firstDelayMs);
  if (first.unref) first.unref();
  const time = await fetchTime();
  log(`المجدول يعمل — موعد الجلب اليومي ${time}`);
  return timer;
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  run, status, startScheduler, stopScheduler, tick, fetchTime,
  fetchUsd, frontContract, pickBar, roundVal, roundEven, pendingDates, usdForDate,
  ITEMS, SRC, TIME_KEY, STATE_KEY, DEFAULT_TIME,
};
