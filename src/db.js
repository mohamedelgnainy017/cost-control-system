'use strict';
/**
 * طبقة قاعدة البيانات — PostgreSQL 18
 * - الاتصال والإعدادات في data/config.json (محلي، لا يُرفع مع الكود)
 * - دعم المعاملات عبر AsyncLocalStorage (أي كود داخل tx() يعمل داخل المعاملة تلقائياً)
 * - دعم الإدراج المجمّع insertBatch لسرعة استيراد مئات الآلاف من الصفوف
 */
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  password: '',
  database: 'costcontrol',
};

let cfg = { ...DEFAULTS };
try {
  if (fs.existsSync(CONFIG_PATH)) cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
} catch (e) { console.error('تعذّر قراءة config.json:', e.message); }

// أولوية متغيرات البيئة
const envMap = { PGHOST: 'host', PGPORT: 'port', PGUSER: 'user', PGPASSWORD: 'password', PGDATABASE: 'database' };
for (const [e, k] of Object.entries(envMap)) if (process.env[e]) cfg[k] = process.env[e];
if (process.env.CCS_CONFIG && fs.existsSync(process.env.CCS_CONFIG)) {
  cfg = { ...cfg, ...JSON.parse(fs.readFileSync(process.env.CCS_CONFIG, 'utf8')) };
}

function saveConfig(newCfg) {
  cfg = { ...cfg, ...newCfg };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}
function getConfig() { return { ...cfg, password: cfg.password ? '••••••' : '' }; }

const pool = new Pool({
  host: cfg.host, port: Number(cfg.port), user: cfg.user,
  password: cfg.password, database: cfg.database,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', e => console.error('خطأ اتصال PostgreSQL:', e.message));

const als = new AsyncLocalStorage();
const client = () => als.getStore()?.client || null;

async function all(sql, params = []) {
  const c = client();
  const r = c ? await c.query(sql, params) : await pool.query(sql, params);
  return r.rows;
}
async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0];
}
async function run(sql, params = []) {
  const c = client();
  const r = c ? await c.query(sql, params) : await pool.query(sql, params);
  return { changes: r.rowCount, lastInsertRowid: r.rows && r.rows[0] ? r.rows[0].id : undefined };
}
async function exec(sql) {
  const c = client();
  if (c) return c.query(sql);
  return pool.query(sql);
}

/** تنفيذ داخل معاملة — أي استعلام يُستدعى داخل fn يدخل في نفس المعاملة */
async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await als.run({ client: c }, async () => {
      try { return await fn(); }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    });
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    c.release();
  }
}

/* حد PostgreSQL: 65535 معاملاً في الاستعلام الواحد (بروتوكول Bind) — نبقى تحته بهامش أمان.
   مهم: التقطيع يجب أن يحسب «أعمدة × صفوف» لا عدد الصفوف فقط، وإلا انفجر الاستيراد
   صامتاً عند إضافة عمود جديد (33 عموداً × 2000 صف = 66000 معاملاً > الحد). */
const MAX_PARAMS = 60000;
const chunkFor = (columns, want) =>
  Math.max(1, Math.min(Number(want) || 1000, Math.floor(MAX_PARAMS / Math.max(1, columns.length))));

/** إدراج مجمّع (سريع جداً لمئات الآلاف من الصفوف) */
async function insertBatch(table, columns, rows, chunk = 1000) {
  if (!rows || !rows.length) return 0;
  const cols = columns.join(', ');
  const size = chunkFor(columns, chunk);
  let total = 0;
  for (let i = 0; i < rows.length; i += size) {
    const part = rows.slice(i, i + size);
    const params = [];
    const tuples = part.map(r =>
      '(' + columns.map((c, ci) => {
        let v = r[ci];
        if (v === undefined) v = null;
        params.push(v);
        return '$' + params.length;
      }).join(', ') + ')'
    );
    await run(`INSERT INTO ${table} (${cols}) VALUES ${tuples.join(', ')}`, params);
    total += part.length;
  }
  return total;
}

async function setSetting(k, v) {
  await run(`INSERT INTO settings(key, value) VALUES($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, String(v)]);
}
async function getSetting(k, def = null) {
  const r = await get(`SELECT value FROM settings WHERE key = $1`, [k]);
  return r ? r.value : def;
}
async function delSetting(k) { await run(`DELETE FROM settings WHERE key = $1`, [k]); }

/* ---------------- المخطط ---------------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS imports (
  id            BIGSERIAL PRIMARY KEY,
  file_path     TEXT,
  file_name     TEXT,
  dataset       TEXT,
  sheet_name    TEXT,
  imported_at   TIMESTAMP NOT NULL DEFAULT LOCALTIMESTAMP,
  rows_total    INTEGER DEFAULT 0,
  rows_inserted INTEGER DEFAULT 0,
  rows_skipped  INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'ok',
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS items (
  code        TEXT PRIMARY KEY,
  descr       TEXT,
  uom         TEXT,
  group_code  TEXT,
  group_desc  TEXT,
  class_code  TEXT,
  class_desc  TEXT,
  updated_at  TIMESTAMP,
  source_file TEXT
);

CREATE TABLE IF NOT EXISTS locations (
  unit_code    TEXT PRIMARY KEY,
  company_code TEXT,
  company_name TEXT,
  currency     TEXT,
  unit_name    TEXT,
  place        TEXT,
  source_file  TEXT
);

CREATE TABLE IF NOT EXISTS movement_types (
  type_code   TEXT PRIMARY KEY,
  direction   TEXT,
  source_file TEXT
);

CREATE TABLE IF NOT EXISTS movements (
  id             BIGSERIAL PRIMARY KEY,
  item           TEXT,
  item_desc      TEXT,
  uom            TEXT,
  qty            DOUBLE PRECISION,
  supplier       TEXT,
  move_type      TEXT,
  move_indicator TEXT,
  post_date      TEXT,
  doc_ref        TEXT,
  purchase_order TEXT,
  customer       TEXT,
  descr          TEXT,
  company_code   TEXT,
  unit_code      TEXT,
  storage_loc    TEXT,
  amount         DOUBLE PRECISION,
  currency       TEXT,
  group_code     TEXT,
  group_desc     TEXT,
  ext_group_code TEXT,
  ext_group_desc TEXT,
  place          TEXT,
  direction      TEXT,
  source_row     INTEGER,
  import_id      BIGINT,
  source_file    TEXT
);
CREATE INDEX IF NOT EXISTS idx_mov_item ON movements(item);
CREATE INDEX IF NOT EXISTS idx_mov_date ON movements(post_date);
CREATE INDEX IF NOT EXISTS idx_mov_type ON movements(move_type);
CREATE INDEX IF NOT EXISTS idx_mov_unit ON movements(unit_code);
CREATE INDEX IF NOT EXISTS idx_mov_ind  ON movements(move_indicator);
CREATE INDEX IF NOT EXISTS idx_mov_file ON movements(source_file);
CREATE INDEX IF NOT EXISTS idx_mov_dir  ON movements(direction);
/* ربط الربحية: (مرجع الحركة + الصنف) يقابل (المستند المرجع + الصنف) في المبيعات */
CREATE INDEX IF NOT EXISTS idx_mov_ref_item ON movements(doc_ref, item);

CREATE TABLE IF NOT EXISTS sales (
  id            BIGSERIAL PRIMARY KEY,
  invoice_date  TEXT,
  invoice_doc   TEXT,
  line_no       INTEGER,
  qty           DOUBLE PRECISION,
  price_uom     TEXT,
  fx_rate       DOUBLE PRECISION,
  net_value     DOUBLE PRECISION,
  ccy_net       TEXT,
  sale_doc      TEXT,
  sale_line     INTEGER,
  item          TEXT,
  item_desc     TEXT,
  ref_doc       TEXT,
  ref_line      INTEGER,
  unit_code     TEXT,
  doc_class     TEXT,
  doc_status    TEXT,
  beneficiary   TEXT,
  tax           DOUBLE PRECISION,
  ccy_tax       TEXT,
  credit_price  DOUBLE PRECISION,
  ccy_credit    TEXT,
  subtotal      DOUBLE PRECISION,
  ccy_subtotal  TEXT,
  raw_cost      DOUBLE PRECISION,
  ccy_cost      TEXT,
  place         TEXT,
  storage_loc   TEXT,
  signed_qty    DOUBLE PRECISION,
  signed_value  DOUBLE PRECISION,
  source_row    INTEGER,
  import_id     BIGINT,
  source_file   TEXT
);
/* كود المخزن يُضاف لملفات المبيعات الجديدة — ترقية لقواعد قائمة */
ALTER TABLE sales ADD COLUMN IF NOT EXISTS storage_loc TEXT;
CREATE INDEX IF NOT EXISTS idx_sales_item ON sales(item);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(invoice_date);
CREATE INDEX IF NOT EXISTS idx_sales_doc  ON sales(invoice_doc);
CREATE INDEX IF NOT EXISTS idx_sales_unit ON sales(unit_code);
CREATE INDEX IF NOT EXISTS idx_sales_storage ON sales(storage_loc);
CREATE INDEX IF NOT EXISTS idx_sales_file ON sales(source_file);
CREATE INDEX IF NOT EXISTS idx_sales_ref  ON sales(ref_doc, item);

CREATE TABLE IF NOT EXISTS balances (
  id             BIGSERIAL PRIMARY KEY,
  balance_date   TEXT,
  item           TEXT,
  item_desc      TEXT,
  base_uom       TEXT,
  company_code   TEXT,
  unit_code      TEXT,
  storage_loc    TEXT,
  currency       TEXT,
  material_type  TEXT,
  open_qty       DOUBLE PRECISION,
  open_val       DOUBLE PRECISION,
  close_qty      DOUBLE PRECISION,
  close_val      DOUBLE PRECISION,
  place          TEXT,
  source_row     INTEGER,
  import_id      BIGINT,
  source_file    TEXT
);
CREATE INDEX IF NOT EXISTS idx_bal_item ON balances(item);
CREATE INDEX IF NOT EXISTS idx_bal_file ON balances(source_file);

CREATE TABLE IF NOT EXISTS borse (
  id            BIGSERIAL PRIMARY KEY,
  borse_date    TEXT,
  contract      TEXT,
  item_code     TEXT,
  item          TEXT,
  low           DOUBLE PRECISION,
  high          DOUBLE PRECISION,
  close         DOUBLE PRECISION,
  basis         DOUBLE PRECISION,
  borse_now     DOUBLE PRECISION,
  usd_rate      DOUBLE PRECISION,
  down_payment  DOUBLE PRECISION,
  fees          DOUBLE PRECISION,
  fx_factor     DOUBLE PRECISION,
  cost_price    DOUBLE PRECISION,
  source_row    INTEGER,
  import_id     BIGINT,
  source_file   TEXT
);
CREATE INDEX IF NOT EXISTS idx_borse_date ON borse(borse_date);
CREATE INDEX IF NOT EXISTS idx_borse_item ON borse(item_code);
CREATE INDEX IF NOT EXISTS idx_borse_file ON borse(source_file);

/* تعديلات البورصة اليدوية — قاعدة «التعديل يسري من تاريخه فما بعد»
   القراءة: آخر قيمة لكل (صنف، عمود) حيث eff_date <= التاريخ المطلوب */
CREATE TABLE IF NOT EXISTS borse_overrides (
  id          BIGSERIAL PRIMARY KEY,
  item_code   TEXT NOT NULL,
  eff_date    DATE NOT NULL,
  field       TEXT NOT NULL,      -- borse|prem|price|usd|nolon|expenses|conv
  value       TEXT NOT NULL,      -- نص: يقبل أرقاماً و«العقد» نصاً (45 December)
  note        TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_code, eff_date, field)
);
CREATE INDEX IF NOT EXISTS idx_bo_key ON borse_overrides(item_code, field, eff_date);

/* أسعار الأصناف اليومية — قاعدة «التعديل يسري من تاريخه فما بعد»
   القيم الأساسية تأتي من شيت «الاسعار» في ملف اليوم (استيراد متعدد المصادر)،
   والنظام يحملها للأمام ثم يطبّق فوقها price_overrides. */
CREATE TABLE IF NOT EXISTS prices (
  id           BIGSERIAL PRIMARY KEY,
  price_date   TEXT,
  item_code    TEXT,
  item         TEXT,
  cost_land    DOUBLE PRECISION,   -- التكلفة (أرضه)
  market_land  DOUBLE PRECISION,   -- السوق (أرضه)
  currency     TEXT,
  source_row   INTEGER,
  import_id    BIGINT,
  source_file  TEXT
);
CREATE INDEX IF NOT EXISTS idx_prices_date ON prices(price_date);
CREATE INDEX IF NOT EXISTS idx_prices_item ON prices(item_code);
CREATE INDEX IF NOT EXISTS idx_prices_file ON prices(source_file);

/* تعديلات الأسعار اليدوية — نفس قاعدة السريان للأمام تماماً كـ borse_overrides */
CREATE TABLE IF NOT EXISTS price_overrides (
  id          BIGSERIAL PRIMARY KEY,
  item_code   TEXT NOT NULL,
  eff_date    DATE NOT NULL,
  field       TEXT NOT NULL,      -- cost | market
  value       TEXT NOT NULL,      -- نص: يقبل أرقاماً وفواصل
  note        TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_code, eff_date, field)
);
CREATE INDEX IF NOT EXISTS idx_po_key ON price_overrides(item_code, field, eff_date);

/* محرك التكلفة اليومية — المرحلة 3
   المفتاح المفصّل = (تاريخ × صنف × وحدة تشغيل/مصنع)؛ الإجمالي على مستوى
   (تاريخ × صنف) يُشتق بالمتوسط المرجّح في VIEW daily_costs_total.
   المعادلتن:
     الأصناف الثلاثة (1001 الذرة / 1002 الصويا / 1004 البذرة):
         سعر التكلفة × ريت الدولار + المصاريف
       حيث سعر التكلفة (بالدولار) = (سعر البورصة + متوسط البريم) × معامل التحويل
       وقيمة unit_code = '' لأنها عقود تُتداول لا تُصنع في مصنع.
     باقي الأصناف = Σ قيمة الرصيد ÷ Σ كمية الرصيد لكل (صنف، مصنع) في تاريخ الرصيد
       وتُحمَل للأمام حتى يصل رصيد أحدث.
   الحساب يُعاد بناؤه من تاريخ أي تعديل/جلب/استيراد حتى اليوم (src/cost-engine.js). */
CREATE TABLE IF NOT EXISTS daily_costs (
  id          BIGSERIAL PRIMARY KEY,
  cost_date   TEXT NOT NULL,
  item_code   TEXT NOT NULL,
  item        TEXT,
  unit_code   TEXT NOT NULL DEFAULT '',  -- وحدة التشغيل (المصنع)؛ فارغ = عقد بورصة
  method      TEXT NOT NULL,             -- borse | balance
  cost        DOUBLE PRECISION,          -- تكلفة الوحدة (جنيه)
  qty         DOUBLE PRECISION,          -- كمية الرصيد المحمولة
  value       DOUBLE PRECISION,          -- قيمة الرصيد المحمولة
  cost_usd    DOUBLE PRECISION,          -- سعر التكلفة بالدولار (borse)
  usd_rate    DOUBLE PRECISION,          -- ريت الدولار المستخدم
  fees        DOUBLE PRECISION,          -- المصاريف المضافة
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cost_date, item_code, unit_code)
);
CREATE INDEX IF NOT EXISTS idx_dc_date ON daily_costs(cost_date);
CREATE INDEX IF NOT EXISTS idx_dc_item ON daily_costs(item_code, cost_date);
CREATE INDEX IF NOT EXISTS idx_dc_unit ON daily_costs(unit_code);
CREATE INDEX IF NOT EXISTS idx_dc_meth ON daily_costs(method);

/* الإجمالي: تكلفة واحدة لكل (تاريخ × صنف) = Σ القيم ÷ Σ الكميات عبر المصانع */
CREATE OR REPLACE VIEW daily_costs_total AS
SELECT cost_date,
       item_code,
       MAX(item)     AS item,
       MAX(method)   AS method,
       CASE WHEN COALESCE(SUM(qty), 0) <> 0
            THEN SUM(value) / SUM(qty)
            ELSE MAX(cost) END AS cost,
       SUM(qty)      AS qty,
       SUM(value)    AS value,
       MAX(cost)     AS cost_max,
       MIN(cost)     AS cost_min
  FROM daily_costs
 GROUP BY cost_date, item_code;

/* سجل «ما كُتب في ملف Excel» — أُلغي بالانفصال عن الملف؛ يُحذف إن وُجد */
DROP TABLE IF EXISTS borse_written;

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  full_name     TEXT,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  must_change   BOOLEAN NOT NULL DEFAULT FALSE,
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS recon (
  key         TEXT PRIMARY KEY,
  item        TEXT,
  item_desc   TEXT,
  company_code TEXT,
  unit_code   TEXT,
  storage_loc TEXT,
  place       TEXT,
  open_val    DOUBLE PRECISION,
  moves_val   DOUBLE PRECISION,
  close_val   DOUBLE PRECISION,
  diff_val    DOUBLE PRECISION,
  open_qty    DOUBLE PRECISION,
  moves_qty   DOUBLE PRECISION,
  close_qty   DOUBLE PRECISION,
  diff_qty    DOUBLE PRECISION,
  calc_at     TIMESTAMP
);
ALTER TABLE recon ADD COLUMN IF NOT EXISTS prev_date TEXT;   -- تاريخ الرصيد السابق (نهايته تُقارن)
ALTER TABLE recon ADD COLUMN IF NOT EXISTS next_date TEXT;   -- تاريخ الرصيد اللاحق (بدايته تُقارن)

/* ===== البيانات الأساسية: الأصناف والمواقع والمصانع وأنواع الحركات ===== */
-- أصل الصنف: 'mine' مسجّل يدوياً أو جاء من شيت الأصناف | 'movement' مُجلب تلقائياً من الحركات
ALTER TABLE items ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'mine';
-- وصف السيستم والتصنيف: نوع حركة واحد قد يُصنَّف لبند آخر بناءً على وصف السيستم
ALTER TABLE movement_types ADD COLUMN IF NOT EXISTS system_desc TEXT;
ALTER TABLE movement_types ADD COLUMN IF NOT EXISTS category TEXT;
-- نوع الصف داخل نفس جدول بيانات الحركات: 'movement' نوع حركة | 'category' تصنيف (بلا جدول منفصل)
ALTER TABLE movement_types ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'movement';

-- جدول واحد للأصناف: المجموعات والتصنيفات صفوف داخل نفس الجدول بنوع kind:
--   'class'   تصنيف (أعلى)      — 'group' مجموعة مواد — 'item' صنف فعلي (أسفل، كود 9 خانات)
-- قيم (group_code / class_code) على كل صنف + صف نوعي واحد لكل مجموعة/تصنيف
-- يملأ قائمتي الاختيار في نموذج الصنف ويديرهما زرا «＋ مجموعة» و«＋ تصنيف».
ALTER TABLE items ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'item';

-- تاريخ شيت الحركات الذي جُلب منه بيانات الصنف (للأصناف origin='movement')
ALTER TABLE items ADD COLUMN IF NOT EXISTS movement_sheet_date TEXT;
-- اسم شيت الحركات (اسم الورقة داخل ملف Excel) الذي جُلب منه بيانات الصنف — بديل/مكمل للتاريخ
ALTER TABLE items ADD COLUMN IF NOT EXISTS movement_sheet_name TEXT;
-- حال الصنف: SUB=صب, PACKED=معبأ, TANK=تنك, JUMBO=جامبو, BULK=سايب (اختياري)
ALTER TABLE items ADD COLUMN IF NOT EXISTS status TEXT;

/* صلاحيات الشاشات لكل مستخدم (JSON array من معرّفات الشاشات، أو NULL = افتراضي الدور) */
ALTER TABLE users ADD COLUMN IF NOT EXISTS tabs TEXT;
/* ترقية: منح شاشة «مراجع العقود» الجديدة لمن كانت له شاشات البيانات الأساسية
   (يملك md-movetypes) ولم تُمنح له بعد — الهدف: لا تختفي الشاشة الجديدة عن المستخدمين
   القائمين. لا تُمسّ شاشات المدير. تُنفَّذ مرة واحدة فعّالة (لا تتكرر). */
UPDATE users
   SET tabs = replace(tabs, '"md-movetypes"', '"md-movetypes","md-contractrefs"')
 WHERE role <> 'admin'
   AND tabs IS NOT NULL
   AND tabs LIKE '%"md-movetypes"%'
   AND tabs NOT LIKE '%"md-contractrefs"%';

-- (ترقية إصدارات سابقة) كتالوجا المجموعات والتصنيفات المنفصلان: ننشئهما مؤقتاً
-- فقط لننقل بياناتهما إلى صفوف kind داخل items ثم نحذفهما نهائياً.
CREATE TABLE IF NOT EXISTS item_groups (
  code       TEXT PRIMARY KEY,
  descr      TEXT,
  updated_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS item_classes (
  code       TEXT PRIMARY KEY,
  descr      TEXT,
  updated_at TIMESTAMP
);

-- سجل الشركات (كود + اسم + عملة) — يظل جدول locations هو مصدر الوحدات
CREATE TABLE IF NOT EXISTS companies (
  company_code TEXT PRIMARY KEY,
  company_name TEXT,
  currency     TEXT,
  updated_at   TIMESTAMP
);
-- المخازن: أصغر مستوى في التسلسل (شركة ← وحدة ← مخزن) وتُسند عليه الشركة والوحدة والمكان
CREATE TABLE IF NOT EXISTS warehouses (
  code         TEXT PRIMARY KEY,
  name         TEXT,
  unit_code    TEXT,
  company_code TEXT,
  place        TEXT,
  updated_at   TIMESTAMP,
  source_file  TEXT
);
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS report_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS is_transit BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS location_name TEXT;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS classification TEXT;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS warehouse_group TEXT;

-- تهيئة: الأصناف الحالية كلها «مسجّلة»؛ والمجموعات والتصنيفات صفوف داخل items
-- وسجل الشركات من وحدات locations القائمة
UPDATE items SET origin = 'mine' WHERE origin IS NULL;
INSERT INTO items(code, descr, kind, origin, updated_at)
  SELECT DISTINCT group_code, group_desc, 'group', 'catalog', now() FROM items WHERE COALESCE(group_code,'') <> ''
  ON CONFLICT (code) DO NOTHING;
INSERT INTO items(code, descr, kind, origin, updated_at)
  SELECT DISTINCT class_code, class_desc, 'class', 'catalog', now() FROM items WHERE COALESCE(class_code,'') <> ''
  ON CONFLICT (code) DO NOTHING;
-- نقل كتالوجي الإصدارات القديمة (حتى مجموعة/تصنيف مسجّل بلا أصناف يبقى موجوداً) ثم حذفهما
INSERT INTO items(code, descr, kind, origin, updated_at)
  SELECT code, descr, 'group', 'catalog', now() FROM item_groups
  ON CONFLICT (code) DO NOTHING;
INSERT INTO items(code, descr, kind, origin, updated_at)
  SELECT code, descr, 'class', 'catalog', now() FROM item_classes
  ON CONFLICT (code) DO NOTHING;
DROP TABLE IF EXISTS item_groups;
DROP TABLE IF EXISTS item_classes;
INSERT INTO companies(company_code, company_name, currency)
  SELECT DISTINCT company_code, company_name, currency FROM locations WHERE COALESCE(company_code,'') <> ''
  ON CONFLICT (company_code) DO NOTHING;

-- مخازن «ترانزيت» لكل وحدة — تُجمع عليها الأرصدة التي لا مخزن لها
INSERT INTO warehouses(code, name, unit_code, company_code, place, report_active, is_transit, updated_at, source_file)
  SELECT 'TR01','مخزن ترانزيت السواقي','EL01','1001','اعلاف السواقى',TRUE,TRUE,now(),'transit'
  WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE code='TR01');
INSERT INTO warehouses(code, name, unit_code, company_code, place, report_active, is_transit, updated_at, source_file)
  SELECT 'TR02','مخزن ترانزيت الواحة','WF01','1002','اعلاف الواحة',TRUE,TRUE,now(),'transit'
  WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE code='TR02');
INSERT INTO warehouses(code, name, unit_code, company_code, place, report_active, is_transit, updated_at, source_file)
  SELECT 'TR03','مخزن ترانزيت العامرية','EL02','1001','اعلاف العامرية',TRUE,TRUE,now(),'transit'
  WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE code='TR03');
INSERT INTO warehouses(code, name, unit_code, company_code, place, report_active, is_transit, updated_at, source_file)
  SELECT 'TR04','مخزن ترانزيت الصالحية','BF02','1005','مواشى المزرعة',TRUE,TRUE,now(),'transit'
  WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE code='TR04');

/* ============ عقود الاستيراد (مخطط إضافي لا يمسّ الجداول القائمة) ============ */
/* استبدال نسخة قديمة ناقصة من contract_items إن وُجدت (بلا عمود name) */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='contract_items')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='contract_items' AND column_name='name') THEN
    DROP TABLE IF EXISTS contract_items;
  END IF;
END $$;

-- جداول المراجع (لوك-أب)
CREATE TABLE IF NOT EXISTS contract_items(
  code TEXT PRIMARY KEY,
  name TEXT,
  direction TEXT,
  lot NUMERIC,
  factor NUMERIC,
  material_code TEXT,
  material_desc TEXT,
  unit TEXT,
  material_type TEXT,
  group_code TEXT,
  group_desc TEXT,
  class_code TEXT,
  class_desc TEXT,
  product_type TEXT,
  location TEXT,
  old_code TEXT,
  status TEXT,
  source_file TEXT,
  updated_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS contract_suppliers(
  code TEXT PRIMARY KEY, name TEXT, source_file TEXT, updated_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS contract_ports(
  code TEXT PRIMARY KEY, name TEXT, source_file TEXT, updated_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS contract_companies_internal(
  code TEXT PRIMARY KEY, name TEXT, source_file TEXT, updated_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS contract_countries(
  code TEXT PRIMARY KEY, name TEXT, source_file TEXT, updated_at TIMESTAMPTZ
);
-- موانئ الوصول (PN) — كانت مخلوطة داخل contract_suppliers قبل التنظيم
CREATE TABLE IF NOT EXISTS contract_arrival_ports(
  code TEXT PRIMARY KEY, name TEXT, source_file TEXT, updated_at TIMESTAMPTZ
);
/* ===== تظبيط جداول المراجع المختلطة (مرة واحدة فعّالة) =====
   contract_suppliers كان يحمل: موردين S + مصادر C + موانئ وصول PN + صفوف عناوين.
   ننقل C → contract_countries و PN → contract_arrival_ports ثم نُبقي S فقط.
   تُنفَّذ في كل إقلاع لكنها لا تؤثر بعد أول مرة (لا يبقى ما يُنقل/يُحذف). */
INSERT INTO contract_countries(code, name, source_file, updated_at)
  SELECT code, name, source_file, updated_at FROM contract_suppliers
  WHERE code ~ '^C[0-9]+$'
  ON CONFLICT (code) DO NOTHING;
INSERT INTO contract_arrival_ports(code, name, source_file, updated_at)
  SELECT code, name, source_file, updated_at FROM contract_suppliers
  WHERE code ~ '^PN[0-9]+$'
  ON CONFLICT (code) DO NOTHING;
DELETE FROM contract_suppliers
  WHERE code ~ '^C[0-9]+$' OR code ~ '^PN[0-9]+$' OR code !~ '^[A-Za-z0-9]+$';

-- جداول البيانات
CREATE TABLE IF NOT EXISTS contract_registrations(
  id BIGSERIAL PRIMARY KEY,
  internal_no TEXT,
  contract_category TEXT,
  contract_type TEXT,
  contract_date TEXT,
  classification TEXT,
  supplier TEXT,
  source_country TEXT,
  contracting_company TEXT,
  internal_company TEXT,
  contract_no TEXT,
  quantity NUMERIC,
  detail_quantity NUMERIC,
  vessel_name TEXT,
  arrival_port TEXT,
  expected_arrival TEXT,
  operation_start TEXT,
  loading_duration TEXT,
  operation_end TEXT,
  vessel_status TEXT,
  contract_premium TEXT,
  shipping_type TEXT,
  shipping_value NUMERIC,
  initial_price NUMERIC,
  contract_exchange TEXT,
  expected_payment_date TEXT,
  contract_status TEXT,
  expected_cif_price NUMERIC,
  notes TEXT,
  source_row INT,
  import_id BIGINT,
  source_file TEXT
);
CREATE TABLE IF NOT EXISTS contract_details(
  id BIGSERIAL PRIMARY KEY,
  internal_no TEXT,
  classification TEXT,
  source_country TEXT,
  external_company TEXT,
  internal_company TEXT,
  contract_no TEXT,
  detail_quantity NUMERIC,
  vessel_name TEXT,
  arrival_port TEXT,
  expected_arrival TEXT,
  operation_start TEXT,
  loading_duration TEXT,
  operation_end TEXT,
  contract_status TEXT,
  vessel_status TEXT,
  notes TEXT,
  source_row INT,
  import_id BIGINT,
  source_file TEXT
);
CREATE TABLE IF NOT EXISTS contract_payments(
  id BIGSERIAL PRIMARY KEY,
  internal_no TEXT,
  payment_date TEXT,
  payment_company TEXT,
  item TEXT,
  supplier TEXT,
  contract_no TEXT,
  internal_company TEXT,
  payment_type TEXT,
  price_type TEXT,
  payment_status TEXT,
  payment_quantity NUMERIC,
  payment_price NUMERIC,
  exchange_rate NUMERIC,
  responsible_person TEXT,
  notes TEXT,
  source_row INT,
  import_id BIGINT,
  source_file TEXT
);
CREATE TABLE IF NOT EXISTS contract_loading(
  id BIGSERIAL PRIMARY KEY,
  internal_no TEXT,
  loading_date TEXT,
  contract_no TEXT,
  item TEXT,
  vessel_name TEXT,
  loading_type TEXT,
  loading_quantity NUMERIC,
  notes TEXT,
  source_row INT,
  import_id BIGINT,
  source_file TEXT
);
CREATE TABLE IF NOT EXISTS contract_hedge(
  id BIGSERIAL PRIMARY KEY,
  internal_no TEXT,
  hedge_date TEXT,
  supplier TEXT,
  contract_no TEXT,
  item TEXT,
  contract_exchange TEXT,
  contract_count NUMERIC,
  hedge_quantity NUMERIC,
  exchange_price NUMERIC,
  hedge_exchange TEXT,
  hedge_premium NUMERIC,
  hedge_price NUMERIC,
  hedge_value NUMERIC,
  notes TEXT,
  source_row INT,
  import_id BIGINT,
  source_file TEXT
);
CREATE TABLE IF NOT EXISTS contract_roll(
  id BIGSERIAL PRIMARY KEY,
  internal_no TEXT,
  roll_date TEXT,
  contract_no TEXT,
  supplier TEXT,
  item TEXT,
  roll_quantity NUMERIC,
  contract_exchange TEXT,
  hedge_exchange TEXT,
  previous_exchange TEXT,
  rolling_exchange TEXT,
  rolling_price NUMERIC,
  notes TEXT,
  source_row INT,
  import_id BIGINT,
  source_file TEXT
);
CREATE TABLE IF NOT EXISTS contract_release(
  id BIGSERIAL PRIMARY KEY,
  internal_no TEXT,
  release_date TEXT,
  contract_no TEXT,
  item TEXT,
  vessel_name TEXT,
  release_quantity NUMERIC,
  release_type TEXT,
  notes TEXT,
  source_row INT,
  import_id BIGINT,
  source_file TEXT
);
CREATE TABLE IF NOT EXISTS contract_external_sales(
  id BIGSERIAL PRIMARY KEY,
  internal_no TEXT,
  sale_date TEXT,
  contract_no TEXT,
  item TEXT,
  vessel_name TEXT,
  sale_quantity NUMERIC,
  notes TEXT,
  source_row INT,
  import_id BIGINT,
  source_file TEXT
);
CREATE TABLE IF NOT EXISTS contract_balances(
  id BIGSERIAL PRIMARY KEY,
  report_date TEXT,
  item_code TEXT,
  item_name TEXT,
  unit TEXT,
  qty_sawaki NUMERIC,
  qty_waha NUMERIC,
  qty_ameriya NUMERIC,
  qty_sahlia NUMERIC,
  total_balance NUMERIC,
  consumption_rate NUMERIC,
  days_enough NUMERIC,
  enough_until TEXT,
  contract_additions NUMERIC,
  port_additions NUMERIC,
  consumption NUMERIC,
  lot NUMERIC,
  factor NUMERIC,
  daily_rate NUMERIC,
  expenses NUMERIC,
  price_usd NUMERIC,
  market_price NUMERIC,
  source_row INT,
  import_id BIGINT,
  source_file TEXT
);

/* ============ دمج مصدر الشركات الموحّد (تسوية نهائية) ============
   الهدف: جدول companies هو المصدر الوحيد للشركات — كل الشركات الداخلية
   للعقود تنتقل إليه، وأي تعديل فيها يصلك من مكان واحد فقط. */
-- 1) نقل الشركات الداخلية للعقود إلى جدول الشركات الموحّد companies
--    (المطابقة بالكود، والاسم يُحدّث من مرجع الشركات الداخلية إن وُجد)
INSERT INTO companies(company_code, company_name, updated_at)
  SELECT ci.code, ci.name, now()
  FROM contract_companies_internal ci
  WHERE COALESCE(ci.code,'') <> ''
  ON CONFLICT (company_code) DO UPDATE
    SET company_name = EXCLUDED.company_name, updated_at = now();

-- 2) توحيد قيم حالة العقد في جداول العقود إلى ACTIVE / FINISH / UNDER
--    (ACTIVE = نشط، FINISH = منتهي، UNDER = تحت التشغيل)
--    تُنفَّذ في كل إقلاع، فتلتقط أي قيم قديمة أو مترجمة تصل من ملفات الاستيراد.
UPDATE contract_registrations SET contract_status = 'ACTIVE'
  WHERE COALESCE(contract_status,'') IN ('نشط','فعال','جاري','ACTIVE','A','أكتيف','جارى');
UPDATE contract_registrations SET contract_status = 'FINISH'
  WHERE COALESCE(contract_status,'') IN ('منتهي','منتهية','مغلق','انتهى','CLOSED','FINISHED','FINISH','F','منتهى');
UPDATE contract_registrations SET contract_status = 'UNDER'
  WHERE COALESCE(contract_status,'') IN ('تحت التشغيل','تحت التجهيز','جاري التنفيذ','UNDER','U','تحت التشغيل');

-- 3) ملء البيانات الناقصة في سجل العقد من جدول التفاصيل (دمج موحد)
-- إضافة أعمدة جديدة (idempotent) إذا لم تكن موجودة
ALTER TABLE contract_registrations ADD COLUMN IF NOT EXISTS internal_company TEXT;
ALTER TABLE contract_registrations ADD COLUMN IF NOT EXISTS detail_quantity NUMERIC;
ALTER TABLE contract_registrations ADD COLUMN IF NOT EXISTS vessel_name TEXT;
ALTER TABLE contract_registrations ADD COLUMN IF NOT EXISTS arrival_port TEXT;
ALTER TABLE contract_registrations ADD COLUMN IF NOT EXISTS expected_arrival TEXT;
ALTER TABLE contract_registrations ADD COLUMN IF NOT EXISTS operation_start TEXT;
ALTER TABLE contract_registrations ADD COLUMN IF NOT EXISTS loading_duration TEXT;
ALTER TABLE contract_registrations ADD COLUMN IF NOT EXISTS operation_end TEXT;
ALTER TABLE contract_registrations ADD COLUMN IF NOT EXISTS vessel_status TEXT;

UPDATE contract_registrations cr
SET internal_company = det.internal_company,
    detail_quantity = det.detail_quantity,
    vessel_name = det.vessel_name,
    arrival_port = det.arrival_port,
    expected_arrival = det.expected_arrival,
    operation_start = det.operation_start,
    loading_duration = det.loading_duration,
    operation_end = det.operation_end,
    vessel_status = det.vessel_status
FROM contract_details det
WHERE cr.internal_no = det.internal_no
  AND (cr.internal_company IS NULL OR cr.internal_company = '')
  AND det.internal_company IS NOT NULL;
UPDATE contract_details SET contract_status = 'ACTIVE'
  WHERE COALESCE(contract_status,'') IN ('نشط','فعال','جاري','ACTIVE','A','أكتيف','جارى');
UPDATE contract_details SET contract_status = 'FINISH'
  WHERE COALESCE(contract_status,'') IN ('منتهي','منتهية','مغلق','انتهى','CLOSED','FINISHED','FINISH','F','منتهى');
UPDATE contract_details SET contract_status = 'UNDER'
  WHERE COALESCE(contract_status,'') IN ('تحت التشغيل','تحت التجهيز','جاري التنفيذ','UNDER','U','تحت التشغيل');

-- 3) تسوية اسم الشركة الداخلية في التفاصيل لتطابق الاسم الرسمي في companies
--    (الربط بالاسم كما في البيانات القديمة، لكن المصدر الموحّد للقيمة هو companies)
UPDATE contract_details cd
SET internal_company = c.company_name
FROM companies c
WHERE COALESCE(cd.internal_company,'') <> ''
  AND c.company_name = cd.internal_company;

CREATE INDEX IF NOT EXISTS idx_contract_registrations_no ON contract_registrations(internal_no);
CREATE INDEX IF NOT EXISTS idx_contract_registrations_cno ON contract_registrations(contract_no);
CREATE INDEX IF NOT EXISTS idx_contract_details_no ON contract_details(internal_no);
CREATE INDEX IF NOT EXISTS idx_contract_details_cno ON contract_details(contract_no);
CREATE INDEX IF NOT EXISTS idx_contract_payments_no ON contract_payments(internal_no);
CREATE INDEX IF NOT EXISTS idx_contract_loading_no ON contract_loading(internal_no);
CREATE INDEX IF NOT EXISTS idx_contract_hedge_no ON contract_hedge(internal_no);
CREATE INDEX IF NOT EXISTS idx_contract_roll_no ON contract_roll(internal_no);
CREATE INDEX IF NOT EXISTS idx_contract_release_no ON contract_release(internal_no);
CREATE INDEX IF NOT EXISTS idx_contract_external_sales_no ON contract_external_sales(internal_no);
CREATE INDEX IF NOT EXISTS idx_contract_balances_item ON contract_balances(item_code, report_date);
`;

/* ===== عرض موحّد للتصنيفات: v_class =====
   المصدر الأساسي: contract_items.code/name/direction (التصنيف التعاقدي).
   تكملة من ERP: items (kind='group' و kind='item') عبر group_code، مع جلب
   تصنيف ERP (class_code/class_desc) وعدد أصناف ERP لكل مجموعة.
   kind: يُشتق من direction أولاً، ثم من class_erp_code (101/204=main، 102=additive).
   source: contract (تعاقدي فقط) | erp (ERP فقط) | both (الاثنان). */
const CLASS_VIEW = `
CREATE OR REPLACE VIEW v_class AS
WITH cls AS (
  SELECT NULLIF(BTRIM(group_code), '') AS group_code,
         NULLIF(BTRIM(class_code), '') AS class_erp_code,
         NULLIF(BTRIM(class_desc), '') AS class_erp_desc,
         COUNT(*) AS cnt,
         ROW_NUMBER() OVER (PARTITION BY NULLIF(BTRIM(group_code), '')
                            ORDER BY COUNT(*) DESC, NULLIF(BTRIM(class_code), '')) AS rn
  FROM items
  WHERE kind = 'item'
    AND NULLIF(BTRIM(group_code), '') IS NOT NULL
    AND NULLIF(BTRIM(class_code), '') IS NOT NULL
  GROUP BY 1, 2, 3
),
erp AS (SELECT group_code, class_erp_code, class_erp_desc FROM cls WHERE rn = 1),
item_cnt AS (
  SELECT NULLIF(BTRIM(group_code), '') AS group_code, COUNT(*) AS n
  FROM items WHERE kind = 'item' AND NULLIF(BTRIM(group_code), '') IS NOT NULL
  GROUP BY 1
),
ci AS (SELECT NULLIF(BTRIM(code), '') AS code, name, direction FROM contract_items WHERE NULLIF(BTRIM(code), '') IS NOT NULL),
grp AS (SELECT NULLIF(BTRIM(code), '') AS code, descr FROM items WHERE kind = 'group' AND NULLIF(BTRIM(code), '') IS NOT NULL),
keys AS (SELECT code FROM ci UNION SELECT code FROM grp UNION SELECT group_code FROM item_cnt)
SELECT
  k.code                                       AS class_code,
  COALESCE(NULLIF(BTRIM(ci.name), ''), grp.descr, k.code) AS class_name,
  ci.direction                                 AS direction,
  CASE
    WHEN ci.direction = 'خامات'  THEN 'main'
    WHEN ci.direction = 'إضافات' THEN 'additive'
    WHEN ci.direction = 'أخرى'   THEN 'other'
    WHEN erp.class_erp_code IN ('101', '204') THEN 'main'
    WHEN erp.class_erp_code = '102'           THEN 'additive'
    ELSE 'other'
  END                                          AS kind,
  erp.class_erp_code                           AS class_erp_code,
  erp.class_erp_desc                           AS class_erp_desc,
  COALESCE(ic.n, 0)                            AS erp_item_count,
  CASE
    WHEN ci.code IS NOT NULL AND erp.class_erp_code IS NOT NULL THEN 'both'
    WHEN ci.code IS NOT NULL THEN 'contract'
    ELSE 'erp'
  END                                          AS source
FROM keys k
LEFT JOIN ci      ON ci.code = k.code
LEFT JOIN grp     ON grp.code = k.code
LEFT JOIN erp     ON erp.group_code = k.code
LEFT JOIN item_cnt ic ON ic.group_code = k.code;
`;

let migrated = false;
async function migrate() {
  if (migrated) return;
  await pool.query(SCHEMA);
  await pool.query(CLASS_VIEW);
  migrated = true;
}

/** اختبار الاتصال + تجهيز المخطط */
async function init() {
  await pool.query('SELECT 1');
  await migrate();
  return true;
}

async function info() {
  const r = await get(`SELECT current_database() db, version() v`);
  return { database: cfg.database, host: cfg.host, port: cfg.port, user: cfg.user, version: (r.v || '').split(' ').slice(0, 2).join(' ') };
}

module.exports = {
  pool, all, get, run, exec, tx, insertBatch, init, migrate, info,
  setSetting, getSetting, delSetting, saveConfig, getConfig, CONFIG_PATH,
};
