'use strict';
/**
 * محرك التكلفة اليومية — المرحلة 3
 * =================================
 * يبني الجدول `daily_costs` من مصدرين اثنين:
 *
 *  (1) الأصناف الثلاثة المدرجة في البورصة (1001 الذرة / 1002 الصويا / 1004 البذرة):
 *
 *          سعر التكلفة × ريت الدولار + المصاريف
 *
 *      حيث سعر التكلفة (بالدولار) = (سعر البورصة الحالي + متوسط البريم) × معامل التحويل
 *      — نفس معادلة src/borse-edit.js حرفياً حتى لا يختلف الرقم بين الشاشتين.
 *      القيم تُقرأ من جدول `borse` ثم يُطبَّق فوقها `borse_overrides` بقاعدة
 *      «التعديل يسري من تاريخه فما بعد»، مع إعادة التقييم في **يوم العرض** لا في
 *      يوم الصف المصدر (لأن اليوم قد يحمل لصف أقدم تعديلاً أحدث).
 *      unit_code = '' لأنها عقود تُتداول لا تُصنَّع في مصنع.
 *
 *  (2) باقي الأصناف من جدول `balances`:
 *
 *          تكلفة الوحدة = Σ قيمة الرصيد ÷ Σ كمية الرصيد      لكل (صنف، مصنع)
 *
 *      وتُحمَل للأمام إلى كل يوم حتى يصل رصيد أحدث لتلك الوحدة.
 *
 *  الإجمالي على مستوى (تاريخ × صنف) = SUM(value) ÷ SUM(qty) عبر المصانع،
 *  ويُشتق من VIEW `daily_costs_total` (بلا تخزين مكرر حتى لا يتضاعف العدّ).
 *
 *  إعادة الحساب: علامة `costs_dirty` في settings تُضبط من أي تعديل/جلب/استيراد
 *  وتُستهلك عند أول قراءة — فلا يبقى جدول قديم ولا يُعاد البناء بلا داعٍ.
 */
const DB = require('./db');
const BE = require('./borse-edit');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DIRTY_KEY = 'costs_dirty';

/* أعمدة الإدراج — ترتيب موحّد بين COLS وصفوف rebuild() */
const COLS = ['cost_date', 'item_code', 'item', 'unit_code', 'method',
              'cost', 'qty', 'value', 'cost_usd', 'usd_rate', 'fees'];

const today = () => BE.today();
const iso = BE.iso;
const num = BE.num;
const round = (v, d) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

/* مساعدات تواريخ UTC — منقولة إلى src/pure.js (Phase 0.3C-B5) */
const { toUtc, shift, nextDay, eachDay } = require('./pure');

/* ------------------------------------------------------------------ */
/* علامة «يحتاج إعادة بناء من تاريخ كذا»                               */
/* ------------------------------------------------------------------ */

/**
 * القيمة المخزّنة في `settings` بصيغة `<date>#<uuid>`:
 *  - `<date>` : أقدم تاريخ صالح ملوّن (نفس منطق `min` السابق).
 *  - `<uuid>` : إصدار فريد لكل استدعاء حتى لو تساوى التاريخ (يُولَّد بـ randomUUID).
 * الإصدار هو ما يميّز التحديث الجديد عن القديم عند تساوي التاريخ، فلا يمحوه `flush`
 * بخطأ سباق. القيم القديمة بلا `#` تُقرأ كما هي (توافق خلفي).
 */
const splitDirty = v => {
  const s = String(v ?? '');
  const i = s.indexOf('#');
  const date = i < 0 ? s : s.slice(0, i);
  return { date: ISO.test(date) ? date : null, raw: s };
};

/**
 * تُبقي أقدم تاريخ ملوّن (أي تعديل قديم يسبق تعديل حديث) وتُحدّث الإصدار،
 * في عملية PostgreSQL **ذرّية واحدة** — لا قراءة-ثم-كتابة.
 * تُعيد الواجهة التاريخ (كما كانت) لتبقى متوافقة مع المستهلكين الحاليين.
 */
async function markDirty(date) {
  const b = (date && ISO.test(date)) ? date : null;
  if (!b) return null;
  /* إصدار فريد واحد لكل استدعاء — يُستخدم في الإدراج وفي التحديث معًا. */
  const uid = randomUUID();
  const tok = `${b}#${uid}`;
  const row = await DB.get(
    `INSERT INTO settings(key, value) VALUES($1, $2)
       ON CONFLICT (key) DO UPDATE
       SET value = COALESCE(
             LEAST(
               CASE WHEN split_part(settings.value, '#', 1) ~ '^\\d{4}-\\d{2}-\\d{2}$'
                    THEN split_part(settings.value, '#', 1) END,
               $3),
             $3) || '#' || $4
     RETURNING value`,
    [DIRTY_KEY, tok, b, uid]);
  const { date: d } = splitDirty(row && row.value);
  return d;
}

/** التاريخ الملوّن فقط (مُتفكَّك من الإصدار) — للعرض في status وتحديد نطاق البناء. */
async function dirty() {
  const { date } = splitDirty(await DB.getSetting(DIRTY_KEY, null));
  return date;
}

/** التاريخ + الإصدار الكامل (للحذف الذرّي المشروط في flush). */
async function dirtyTok() {
  const cur = await DB.getSetting(DIRTY_KEY, null);
  const { date, raw } = splitDirty(cur);
  return date ? { date, tok: raw } : null;
}

/* ------------------------------------------------------------------ */
/* مصادر التكلفة                                                        */
/* ------------------------------------------------------------------ */

async function minDate() {
  const r = await DB.get(
    `SELECT LEAST(
              (SELECT MIN(borse_date) FROM borse
                WHERE borse_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
              (SELECT MIN(balance_date) FROM balances
                WHERE balance_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')) AS d`);
  return r && r.d && ISO.test(r.d) ? r.d : null;
}

/**
 * تكلفة الأصناف الثلاثة لكل يوم في المدى.
 * نقرأ صفوف البورصة مُتراجعة (مع نظرة 21 يوماً خلفاً لتحمل الأيام الناقصة)
 * ثم لكل يوم نلتقط آخر صف ≤ ذلك اليوم ونعيد تقييم التعديلات فوقه.
 */
async function borseCosts(from, to) {
  const [raw, ov] = await Promise.all([
    DB.all(
      `SELECT borse_date, item_code, item, contract, basis, borse_now, usd_rate,
              down_payment, fees, fx_factor, cost_price
         FROM borse
        WHERE borse_date >= $1 AND borse_date <= $2
          AND item_code IN ('1001', '1002', '1004')
        ORDER BY borse_date ASC, id ASC`,
      [shift(from, -21), to]),
    BE.loadOverrides(to, null),
  ]);

  /* آخر صف لكل (صنف، تاريخ) مرتباً تصاعدياً لكل صنف */
  const byItem = new Map();
  for (const r of raw) {
    const d = iso(r.borse_date);
    if (!ISO.test(d)) continue;
    if (!byItem.has(r.item_code)) byItem.set(r.item_code, []);
    const arr = byItem.get(r.item_code);
    if (arr.length && arr[arr.length - 1].d === d) arr[arr.length - 1] = { d, r };
    else arr.push({ d, r });
  }

  const days = eachDay(from, to);
  const out = [];

  for (const [code, arr] of byItem) {
    let i = -1;
    for (const d of days) {
      while (i + 1 < arr.length && arr[i + 1].d <= d) i++;   // آخر صف ≤ يوم العرض
      if (i < 0) continue;                                    // لا مصدر بعد
      const r = arr[i].r;

      // القيمة بعد التعديلات المؤرخة (تقييماً بتاريخ يوم العرض)
      const v = f => {
        const hit = BE.pick(ov, code, f, d);
        if (hit) return hit.value;
        const rawV = r[BE.FIELDS[f].col];
        return rawV === null || rawV === undefined ? '' : String(rawV);
      };

      const price = num(v('price')), prem = num(v('prem')), conv = num(v('conv'));
      const usd = num(v('usd'));
      const fees = num(v('expenses')) || 0;

      const costUsd = (price !== null && prem !== null && conv !== null)
        ? (price + prem) * conv : null;
      const cost = (costUsd !== null && usd !== null) ? costUsd * usd + fees : null;
      if (cost === null) continue;

      out.push([d, code, r.item, '', 'borse',
                round(cost, 2), null, null, round(costUsd, 4), usd, fees]);
    }
  }
  return out;
}

/** تكلفة باقي الأصناف: Σ قيمة الرصيد ÷ Σ كمية الرصيد لكل (صنف، مصنع)، محمولة للأمام */
async function balanceCosts(from, to) {
  /* الحد الأدنى = أول رصيد في الجدول لا `shift(from,-1)`:
     عند إعادة بناء مدى جزئي يبدأ بعد تاريخ آخر رصيد (مثلاً اليوم فقط)،
     صفوف الحمل للأمام لن تُستعاد أبداً إن لم نقرأ من أول مصدر — فتُفقد
     (اختُبر: إعادة بناء من 2026-10-03 أفقدت صفوف الأرصدة لتلك الأيام). */
  const raw = await DB.all(
    `SELECT balance_date, item, MAX(item_desc) AS item_desc, unit_code,
            SUM(close_qty) AS qty, SUM(close_val) AS val
       FROM balances
      WHERE balance_date >= (SELECT MIN(balance_date) FROM balances)
        AND balance_date <= $1
        AND close_qty IS NOT NULL AND close_qty <> 0
        AND close_val IS NOT NULL
      GROUP BY balance_date, item, unit_code`,
    [to]);

  /* تجميع الأحداث لكل (صنف، مصنع) مرتباً بالتاريخ */
  const groups = new Map();
  for (const r of raw) {
    const d = iso(r.balance_date);
    if (!ISO.test(d)) continue;
    const k = `${r.item}\u0000${r.unit_code || ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ d, r });
  }

  const days = eachDay(from, to);
  /* لا داعي لبناء الأيام التي تسبق أول حدث رصيد على الإطلاق */
  let minD = null;
  for (const arr of groups.values()) if (!minD || arr[0].d < minD) minD = arr[0].d;
  let startIdx = 0;
  if (minD) while (startIdx < days.length && days[startIdx] < minD) startIdx++;

  const out = [];
  for (const arr of groups.values()) {
    let i = -1;
    for (let j = startIdx; j < days.length; j++) {
      const d = days[j];
      while (i + 1 < arr.length && arr[i + 1].d <= d) i++;
      if (i < 0) continue;
      const r = arr[i].r;
      if (!r.qty) continue;
      out.push([d, r.item, r.item_desc, r.unit_code || '', 'balance',
                round(r.val / r.qty, 4), r.qty, r.val, null, null, null]);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* البناء                                                              */
/* ------------------------------------------------------------------ */

/* مُسلسِل إعادة البناء داخل عملية Node.js: أي عمليتي بناء متعارضتين
   (flush / rebuildAll / rebuild مباشر) تنتظران واحدة تلو الأخرى فلا
   تتداخل معاملتا DELETE+INSERT على المدى المتقاطع. قابل لإعادة الدخول
   (reentrant) عبر AsyncLocalStorage — فلا deadlock حين تستدعي إحداها الأخرى،
   ولا يستطيع نداء خارجي متزامن تجاوز القفل. */
const buildAls = new AsyncLocalStorage();
let buildChain = Promise.resolve();

function withBuildLock(fn) {
  /* إعادة الدخول داخل نفس سياق async: نداء داخلي (flush → rebuildLocked لا يحتاج
     القفل أصلًا، لكن هذا يحمي أي استدعاء متداخل مستقبلي) لا ينتظر القفل ثانيةً. */
  if (buildAls.getStore()) return Promise.resolve().then(fn);
  return buildAls.run(true, () => {
    const run = buildChain.then(
      () => fn(),
      () => fn()
    );
    /* السلسلة تبقى حيّة حتى لو فشل البناء (لا تُرفض إلى الأبد) */
    buildChain = run.then(() => {}, () => {});
    return run;
  });
}

/**
 * إعادة بناء المدى [from, to] كاملاً: حذف ثم حساب المصدرين ثم إدراج.
 * (يُنفَّذ داخل معاملة واحدة حتى لا يُرى الجدول نصف مبني.)
 * القفل في `rebuild()` العام فقط؛ الدوال الداخلية تستدعي `rebuildLocked` مباشرة.
 */
async function rebuildLocked(from, to) {
  to = to || today();
  if (!from) from = await minDate();
  if (!from || from > to) return { from, to, rows: 0, balance: 0, borse: 0, built: false };

  const [bal, bse] = await Promise.all([
    balanceCosts(from, to),
    borseCosts(from, to),
  ]);

  /* الأسبقية للبورصة إن التقاطأ صنف في المصدرين (لا يحدث today: 0 تقاطع) */
  const map = new Map();
  for (const r of bal) map.set(`${r[0]}\u0000${r[1]}\u0000${r[3]}`, r);
  for (const r of bse) map.set(`${r[0]}\u0000${r[1]}\u0000${r[3]}`, r);
  const rows = [...map.values()];

  await DB.tx(async () => {
    await DB.run('DELETE FROM daily_costs WHERE cost_date >= $1 AND cost_date <= $2', [from, to]);
    await DB.insertBatch('daily_costs', COLS, rows, 800);
  });

  return { from, to, rows: rows.length, balance: map.size - bse.length, borse: bse.length, built: true };
}

/** الواجهة العامة: تُسلسِل أي إعادة بناء مع غيرها (بما فيها الاستدعاء المباشر). */
function rebuild(from, to) {
  return withBuildLock(() => rebuildLocked(from, to));
}

/** بناء كامل من أقدم مصدر حتى اليوم — لا يحذف العلم إلا بعد نجاح البناء وبشرط مطابقته. */
async function rebuildAll() {
  const flag = await dirtyTok();
  const from = await minDate();
const r = await withBuildLock(() => rebuildLocked(from, today()));
  /* لا تحذف العلم إلا إذا نُفّذت إعادة بناء فعلية (built) وبشرط مطابقة القيمة الكاملة */
  if (flag && r && r.built) {
    await DB.run(
      `DELETE FROM settings WHERE key = $1 AND value = $2 RETURNING key`,
      [DIRTY_KEY, flag.tok]);
  }
  return r;
}

/**
 * استهلاك علامة القِدَم قبل أي قراءة:
 *  - العلامة ملوّنة  → أعد البناء من تاريخها.
 *  - الجدول فارغ     → بناء كامل.
 *  - المدى يمتد يوماً جديداً → أضف الأيام الناقصة فقط.
 */
/* مُسلسِل flush داخل العملية: (١) نداءان متزامنان بنفس to يشتركان الوعد نفسه
   فلا يتكرر البناء؛ (٢) أي flush آخر (to مختلف) ينتظر انتهاء الجاري — فلا
   يتداخل بناءان على مدى متقاطع. المرجع يُصفَّر في finally عند النجاح والفشل. */
const inflight = new Map();
let flushChain = Promise.resolve();

async function flush(to) {
  to = to || today();
  const running = inflight.get(to);
  if (running) return running;
  const p = flushChain.then(
    () => doFlush(to),
    () => doFlush(to)
  ).finally(() => { inflight.delete(to); });
  inflight.set(to, p);
  flushChain = p.then(() => {}, () => {});
  return p;
}

async function doFlush(to) {
  const flag = await dirtyTok();
  const d = flag ? flag.date : null;
  const st = await DB.get(
    'SELECT COUNT(*)::int n, MIN(cost_date) a, MAX(cost_date) b FROM daily_costs');

  let from;
  if (!st || !st.n) {
    from = d || await minDate();          // جدول فارغ → بناء كامل
  } else if (d) {
    from = d;                             // تعديل/جلب/استيراد مؤرخ
  } else if (st.b && st.b < to) {
    from = nextDay(st.b);                 // يوم جديد بلا صفوف
  } else {
    return { skipped: true, built: st };  // كل شيء محدَّث
  }

  const min = await minDate();
  if (min && from < min) from = min;
  if (from > to) return { skipped: true, pending: d || null };

  /* withBuildLock قابل لإعادة الدخول: rebuild() الداخلي لا ينتظر القفل ثانيةً */
  const r = await withBuildLock(() => rebuildLocked(from, to));
  /* حذف العلم شرطًا بمطابقة القيمة الكاملة المقروءة + RETURNING key — فلا يمحو
     تحديثًا وصل أثناء البناء (حتى لو تساوى تاريخه). عدم المطابقة ليس خطأً. */
  /* لا تحذف العلم إلا إذا نُفّذت إعادة بناء فعلية (built) وبشرط مطابقة القيمة الكاملة */
  if (flag && r && r.built) {
    await DB.run(
      `DELETE FROM settings WHERE key = $1 AND value = $2 RETURNING key`,
      [DIRTY_KEY, flag.tok]);
  }
  return r;
}

/* ------------------------------------------------------------------ */
/* القراءة                                                             */
/* ------------------------------------------------------------------ */

/**
 * الشبكة: مستوى تفصيلي (صنف × مصنع × تاريخ) أو إجمالي (صنف × تاريخ).
 * `level = 'total'` يقرأ VIEW الإجمالي: متوسط مرجّح عبر المصانع.
 */
async function grid({ from, to, item, unit, level, itemFrom, itemTo, unitFrom, unitTo } = {}) {
  to = to || today();
  from = from || to;
  if (from > to) { const t = from; from = to; to = t; }
  /* نُحدِّث الجدول حتى اليوم دائماً قبل القراءة — لا حتى يُمسح علم القِدَم
     قبل أن يغطي كل الأيام (وإلا بقيت أيام قديمة سليمة ظاهراً وهي متقادمة) */
  await flush();

  if (String(level || 'detail') === 'total') {
    const rows = await DB.all(
      `SELECT cost_date, item_code, item, method, cost, qty, value, cost_min, cost_max
         FROM daily_costs_total
        WHERE cost_date >= $1 AND cost_date <= $2
          AND ($3::text IS NULL OR item_code = $3)
          AND ($5::text IS NULL OR item_code >= $5)
          AND ($6::text IS NULL OR item_code <= $6)
        ORDER BY cost_date DESC, item_code ASC`,
      [from, to, item || null, unit || null, itemFrom || null, itemTo || null]);
    return { from, to, level: 'total', rows };
  }

  const rows = await DB.all(
    `SELECT d.cost_date, d.item_code, d.item, d.unit_code,
            l.unit_name, l.company_name, l.place,
            d.method, d.cost, d.qty, d.value, d.cost_usd, d.usd_rate, d.fees
       FROM daily_costs d
       LEFT JOIN locations l ON l.unit_code = d.unit_code
      WHERE d.cost_date >= $1 AND d.cost_date <= $2
        AND ($3::text IS NULL OR d.item_code = $3)
        AND ($4::text IS NULL OR d.unit_code = $4)
        AND ($5::text IS NULL OR d.item_code >= $5)
        AND ($6::text IS NULL OR d.item_code <= $6)
        AND ($7::text IS NULL OR d.unit_code >= $7)
        AND ($8::text IS NULL OR d.unit_code <= $8)
      ORDER BY d.cost_date DESC, d.item_code ASC, d.unit_code ASC`,
    [from, to, item || null, unit || null, itemFrom || null, itemTo || null, unitFrom || null, unitTo || null]);
  return { from, to, level: 'detail', rows };
}

/** حالة المحرك + مصادر البيانات (للعرض والتشخيص) */
async function status() {
  const [built, byMethod, src, min, d, zeroCost] = await Promise.all([
    DB.get(`SELECT COUNT(*)::int rows, MIN(cost_date) from_d, MAX(cost_date) to_d,
                   COUNT(DISTINCT item_code)::int items,
                   COUNT(DISTINCT unit_code)::int units,
                   COUNT(DISTINCT cost_date)::int dates,
                   MAX(computed_at) last_at
              FROM daily_costs`),
    DB.all('SELECT method, COUNT(*)::int rows FROM daily_costs GROUP BY method ORDER BY method'),
    DB.get(`SELECT (SELECT MIN(borse_date) FROM borse)    AS bmin,
                   (SELECT MAX(borse_date) FROM borse)    AS bmax,
                   (SELECT COUNT(DISTINCT borse_date)::int FROM borse) AS bdays,
                   (SELECT COUNT(DISTINCT item_code)::int FROM borse WHERE item_code IN ('1001','1002','1004')) AS bitems,
                   (SELECT MIN(balance_date) FROM balances) AS lmin,
                   (SELECT MAX(balance_date) FROM balances) AS lmax,
                   (SELECT COUNT(DISTINCT balance_date)::int FROM balances) AS ldates,
                   (SELECT COUNT(DISTINCT item)::int FROM balances
                      WHERE close_qty IS NOT NULL AND close_qty <> 0 AND close_val IS NOT NULL) AS litems,
                   (SELECT COUNT(*)::int FROM
                      (SELECT DISTINCT item, unit_code FROM balances
                        WHERE close_qty IS NOT NULL AND close_qty <> 0
                          AND close_val IS NOT NULL) t) AS lpairs`),
    minDate(),
    dirty(),
    DB.get(`SELECT COUNT(*)::int rows, COUNT(DISTINCT item_code)::int items,
                   COUNT(*) FILTER (WHERE method = 'balance')::int balance
              FROM daily_costs WHERE cost IS NULL OR cost <= 0`),
  ]);

  /* تحذيرات: تكلفة صفرية (رصيد له كمية بلا قيمة) — لا تُحذف بل تُصنَّف في الواجهة */
  const warnings = [];
  if (zeroCost && zeroCost.rows > 0) {
    warnings.push({
      code: 'zero_cost',
      title: 'أصناف بقيمة رصيد صفرية (تكلفة = 0)',
      detail: `${zeroCost.items} صنفاً/أصناف لدى ${zeroCost.balance} صف تكلفته صفر لأن قيمة الرصيد = 0 رغم وجود كمية.`,
      rows: zeroCost.rows,
    });
  }
  if (built && built.from_d && src && src.bmin && src.bmin < built.from_d) {
    warnings.push({
      code: 'borse_history_gap',
      title: 'تكلفة بورصة التاريخ القديم غير قابلة للحساب',
      detail: `صفوف البورصة قبل ${built.from_d} ليس بها ريت دولار ولا معامل تحويل ولا مصاريف (قيمها فارغة منذ 2022) فتُركت بلا تكلفة في المحرك.`,
    });
  }

  return {
    built: built || { rows: 0 },
    methods: byMethod,
    dirty: d,
    minDate: min,
    today: today(),
    warnings,
    sources: {
      borse: {
        from: src && src.bmin ? iso(src.bmin) : null,
        to: src && src.bmax ? iso(src.bmax) : null,
        dates: src ? src.bdays : 0,
        items: src ? src.bitems : 0,
        formula: 'سعر التكلفة × ريت الدولار + المصاريف',
      },
      balances: {
        from: src && src.lmin ? iso(src.lmin) : null,
        to: src && src.lmax ? iso(src.lmax) : null,
        dates: src ? src.ldates : 0,
        items: src ? src.litems : 0,
        pairs: src ? src.lpairs : 0,
        formula: 'قيمة الرصيد ÷ كمية الرصيد',
      },
    },
  };
}

module.exports = {
  DIRTY_KEY, COLS,
  rebuild, rebuildAll, flush, markDirty, dirty, minDate,
  grid, status,
  today, iso, shift, nextDay, eachDay,
};
