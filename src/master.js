'use strict';
/**
 * البيانات الأساسية — الأصناف والمواقع والمصانع وأنواع الحركات
 *
 * كل بيانات الأصناف في جدول items واحد، والتسلسل داخله:
 *      التصنيف (أعلى)  ←  مجموعة المواد  ←  الصنف (أسفل، كود 9 خانات)
 * والمجموعات والتصنيفات صفوف داخل نفس الجدول بنوع kind ('group' / 'class')
 * تملآن قائمتي الاختيار في نموذج الصنف وتديرهما زرا «＋ مجموعة» و«＋ تصنيف».
 *
 * سياسة الأصناف (كما اتفقنا):
 *  1) أصنافي أنا (مسجّلة يدوياً أو من شيت الأصناف) تبقى بعلامة origin='mine'.
 *  2) مع كل استيراد للحركات يُفحص جدول الحركات: أي صنف جديد يظهر فيه يُسحب إلى
 *     جدول الأصناف بكوده ووصفه ووحدته كما هي origin='movement'.
 *  3) التسكين من الحركات لكل صنف موجود فيها:
 *       «مجموعة المواد» ووصفها   ← التصنيف  (class_code / class_desc)
 *       «المجموعة الخارجية» ووصفها ← مجموعة المواد (group_code / group_desc)
 *  4) الإضافة اليدوية: تُختار المجموعة والتصنيف من قائمتين (كود — اسم) في نموذج الصنف.
 *
 * المواقع: الشركة (أكبر) ← الوحدة ← المخزن (أصغر)؛ المخزن يُسند عليه الشركة
 * والوحدة والمكان. جدول locations هو مصدر الوحدات كما هو (تقارير تعمل عليه).
 *
 * أنواع الحركات: النوع والوصف الموجودان حالياً + وصف السيستم والتصنيف (جديد).
 */
const { all, get, run } = require('./db');

const str = v => (v === null || v === undefined ? '' : String(v).trim());
const CODE9 = /^\d{9}$/;           // كود الصنف: 9 خانات مكتملة

/* ================= الأصناف ================= */

async function listItems({ origin, q, limit = 500 } = {}) {
  const where = ["i.kind = 'item'"], p = [];
  if (origin && origin !== 'all') { p.push(origin); where.push(`i.origin = $${p.length}`); }
  if (q) {
    p.push('%' + q + '%');
    where.push(`(i.code ILIKE $${p.length} OR i.descr ILIKE $${p.length}
              OR i.group_desc ILIKE $${p.length} OR i.class_desc ILIKE $${p.length})`);
  }
  p.push(Math.min(Number(limit) || 500, 3000));
  return all(`
    SELECT i.code, i.descr, i.uom, i.group_code, i.group_desc, i.class_code, i.class_desc,
           COALESCE(i.origin,'mine') origin, i.source_file
    FROM items i
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY i.code
    LIMIT $${p.length}`, p);
}

/**
 * إضافة/تعديل صنف — كود 9 خانات إجباري في الإضافة،
 * وفي التعديل إذا غُيّر الكود (الأكواد القديمة تُعدَّل دون إعادة تسمية).
 * المجموعة والتصنيف يُختاران من قوائم الكتالوج (كود + اسم)؛
 * إذا أُدخلت مجموعة ولم يُدخل تصنيف → يُرث الصنف تصنيف مجموعته من باقي الأصناف.
 */
async function saveItem({ code, descr, uom, groupCode, groupDescr, classCode, classDescr, editCode }) {
  code = str(code); descr = str(descr); uom = str(uom);
  groupCode = str(groupCode); groupDescr = str(groupDescr);
  classCode = str(classCode); classDescr = str(classDescr);
  const editing = str(editCode);
  if (!code) throw new Error('كود الصنف مطلوب');
  if (!descr) throw new Error('اسم الصنف مطلوب');
  if (!uom) throw new Error('وحدة القياس مطلوبة');
  const grCat = await get(`SELECT descr d FROM items WHERE kind='group' AND code=$1`, [groupCode]);
  if (grCat) groupDescr = grCat.d;
  const clCat = await get(`SELECT descr d FROM items WHERE kind='class' AND code=$1`, [classCode]);
  if (clCat) classDescr = clCat.d;
  if (groupCode && !groupDescr) {
    const g = await get('SELECT group_desc d FROM items WHERE group_code=$1 AND COALESCE(group_desc,\'\')<>\'\' LIMIT 1', [groupCode]);
    if (g) groupDescr = g.d; else throw new Error('اسم المجموعة مطلوب (أول مرة تُستخدم)');
  }
  if (classCode && !classDescr) {
    const c = await get('SELECT class_desc d FROM items WHERE class_code=$1 AND COALESCE(class_desc,\'\')<>\'\' LIMIT 1', [classCode]);
    if (c) classDescr = c.d; else throw new Error('اسم التصنيف مطلوب (أول مرة تُستخدم)');
  }
  /* التصنيف الأب للمجموعة: يُرث من أصناف المجموعة نفسها إن لم يُدخل مباشرة */
  if (groupCode && !classCode) {
    const p = await get(`SELECT class_code c, class_desc d FROM items
                         WHERE group_code=$1 AND COALESCE(class_code,'') <> '' LIMIT 1`, [groupCode]);
    if (p) { classCode = p.c; classDescr = p.d; }
  }
  if (editing) {
    if (code !== editing && !CODE9.test(code))
      throw new Error('كود الصنف الجديد يجب أن يكون 9 خانات مكتملة');
    if (code !== editing) {
      const dup = await get('SELECT 1 x FROM items WHERE code = $1', [code]);
      if (dup) throw new Error('الكود الجديد مستخدم لصنف آخر');
    }
    const r = await run(`UPDATE items SET code=$1, descr=$2, uom=$3,
        group_code=$4, group_desc=$5, class_code=$6, class_desc=$7, updated_at=now()
      WHERE code=$8`,
      [code, descr, uom, groupCode, groupDescr, classCode, classDescr, editing]);
    if (!r.changes) throw new Error('الصنف غير موجود — حُذف أو تغيّر كوده');
    await ensureCats({ groupCode, groupDescr, classCode, classDescr });
    return { code };
  }
  if (!CODE9.test(code)) throw new Error('كود الصنف يجب أن يكون 9 خانات مكتملة');
  const dup = await get('SELECT 1 x FROM items WHERE code = $1', [code]);
  if (dup) throw new Error('كود الصنف موجود بالفعل');
  await run(`INSERT INTO items(code, descr, uom, group_code, group_desc, class_code, class_desc,
                               origin, updated_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,'mine',now())`,
    [code, descr, uom, groupCode, groupDescr, classCode, classDescr]);
  await ensureCats({ groupCode, groupDescr, classCode, classDescr });
  return { code };
}

/* ضمان وجود صف نوعي (كود + اسم) لكل مجموعة/تصنيف مستخدم حتى يظهر في القوائم المنسدلة —
   داخل جدول items نفسه؛ لا يُمسح صف صنف فعلي لو تعارض كود المجموعة معه */
async function ensureCats({ groupCode, groupDescr, classCode, classDescr }) {
  if (groupCode) await run(`INSERT INTO items(code, descr, kind, origin, updated_at)
    VALUES($1,$2,'group','catalog',now())
    ON CONFLICT (code) DO UPDATE SET descr=$2, updated_at=now()
    WHERE items.kind <> 'item'`, [groupCode, groupDescr]);
  if (classCode) await run(`INSERT INTO items(code, descr, kind, origin, updated_at)
    VALUES($1,$2,'class','catalog',now())
    ON CONFLICT (code) DO UPDATE SET descr=$2, updated_at=now()
    WHERE items.kind <> 'item'`, [classCode, classDescr]);
}

/**
 * مزامنة البيانات الأساسية مع الحركات — تُشغَّل تلقائياً بعد كل استيراد للحركات
 * ومن زر «جلب من الحركات» في شاشة الأصناف:
 *  - جلب الأصناف الجديدة + تسكين المجموعات والتصنيفات على الأصناف الموجودة
 *  - تحديث كتالوجي المجموعات والتصنيفات
 *  - جلب الوحدات (المواقع) الجديدة ومواقع التخزين (المخازن) الجديدة من الحركات
 * تُرجع عدد صفوف كل مرحلة.
 */
async function syncFromMovements() {
  /* 1) جلب الأصناف الجديدة: كود + وصف + وحدة كما هي في الحركات */
  const ins = await run(`
    WITH src AS (
      SELECT DISTINCT ON (m.item) m.item code, m.item_desc descr, m.uom uom, m.source_file sf
      FROM movements m
      WHERE COALESCE(m.item,'') <> ''
      ORDER BY m.item, m.id DESC
    )
    INSERT INTO items (code, descr, uom, origin, updated_at, source_file)
    SELECT s.code, s.descr, s.uom, 'movement', now(), s.sf
    FROM src s
    WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.code = s.code)
    ON CONFLICT (code) DO NOTHING`);

  /* 2) التسكين: مجموعة المواد ← التصنيف، المجموعة الخارجية ← مجموعة المواد
        (تُحدَّث فقط الحقول التى يملؤها المصدر — لا يُمسح قائم بما هو فارغ هناك) */
  const upd = await run(`
    WITH src AS (
      SELECT DISTINCT ON (m.item) m.item code,
             m.group_code, m.group_desc, m.ext_group_code, m.ext_group_desc
      FROM movements m
      WHERE COALESCE(m.item,'') <> ''
      ORDER BY m.item, m.id DESC
    )
    UPDATE items i SET
      class_code = CASE WHEN COALESCE(s.group_code,'')     <> '' THEN s.group_code     ELSE i.class_code END,
      class_desc = CASE WHEN COALESCE(s.group_desc,'')      <> '' THEN s.group_desc      ELSE i.class_desc END,
      group_code = CASE WHEN COALESCE(s.ext_group_code,'')  <> '' THEN s.ext_group_code  ELSE i.group_code END,
      group_desc = CASE WHEN COALESCE(s.ext_group_desc,'')  <> '' THEN s.ext_group_desc  ELSE i.group_desc END,
      updated_at = now()
    FROM src s
    WHERE i.code = s.code
      AND ( (COALESCE(s.ext_group_code,'') <> '' AND COALESCE(i.group_code,'') <> s.ext_group_code)
         OR (COALESCE(s.ext_group_desc,'') <> '' AND COALESCE(i.group_desc,'') <> s.ext_group_desc)
         OR (COALESCE(s.group_code,'')     <> '' AND COALESCE(i.class_code,'') <> s.group_code)
         OR (COALESCE(s.group_desc,'')     <> '' AND COALESCE(i.class_desc,'') <> s.group_desc) )`);

  /* 3) تحديث صفوف المجموعات والتصنيفات من أحدث ما في الأصناف
        (حتى تظهر أي مجموعة/تصنيف جديد في قوائم الاختيار) */
  await run(`INSERT INTO items(code, descr, kind, origin, updated_at)
             SELECT DISTINCT group_code, group_desc, 'group', 'catalog', now() FROM items
             WHERE COALESCE(group_code,'') <> ''
             ON CONFLICT (code) DO NOTHING`);
  await run(`INSERT INTO items(code, descr, kind, origin, updated_at)
             SELECT DISTINCT class_code, class_desc, 'class', 'catalog', now() FROM items
             WHERE COALESCE(class_code,'') <> ''
             ON CONFLICT (code) DO NOTHING`);

  /* 4) المواقع: كل وحدة جديدة تظهر في الحركات تُضاف إلى جدول locations
        (الوحدات مصدرها شيت «المواقع والشركات» — وهنا ضمان أن أي وحدة في
        الحركات دون أن تُرفع في شيتها تظهر تلقائياً في شاشة المواقع) */
  const loc = await run(`
    INSERT INTO locations(unit_code, company_code, company_name, currency, source_file)
    SELECT DISTINCT ON (m.unit_code)
           m.unit_code, m.company_code,
           COALESCE(c.company_name,''), COALESCE(c.currency,''),
           m.source_file
    FROM movements m
    LEFT JOIN companies c ON c.company_code = m.company_code
    WHERE COALESCE(m.unit_code,'') <> ''
      AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.unit_code = m.unit_code)
    ORDER BY m.unit_code, m.id DESC
    ON CONFLICT (unit_code) DO NOTHING`);

  /* 5) المخازن: كل «موقع تخزين» جديد تظهر في الحركات يُضاف إلى جدول warehouses
        (مع وحدته وشركته ومكان وحدته الوراثي) */
  const wh = await run(`
    INSERT INTO warehouses(code, name, unit_code, company_code, place, source_file)
    SELECT DISTINCT ON (m.storage_loc, m.unit_code)
           m.storage_loc, m.storage_loc, m.unit_code,
           COALESCE(NULLIF(m.company_code,''), l.company_code, ''),
           COALESCE(l.place, ''),
           m.source_file
    FROM movements m
    LEFT JOIN locations l ON l.unit_code = m.unit_code
    WHERE COALESCE(m.storage_loc,'') <> ''
      AND NOT EXISTS (SELECT 1 FROM warehouses w WHERE w.code = m.storage_loc)
    ORDER BY m.storage_loc, m.unit_code, m.id DESC
    ON CONFLICT (code) DO NOTHING`);

  return { inserted: ins.changes, settled: upd.changes,
           locations: loc.changes, warehouses: wh.changes };
}

/* ============ المجموعات والتصنيفات ============
   صفوف داخل جدول items بنوع kind='group'/'class' — هي مصدر القوائم المنسدلة،
   وتُعرَض مع العدد وبتصنيفها الأب المُقرأ من الأصناف التي تحملها. */

const listGroups = () => all(`
  SELECT r.code, r.descr,
         (SELECT COUNT(*)::int FROM items i WHERE i.kind = 'item' AND i.group_code = r.code) items,
         (SELECT MAX(i.class_code) FROM items i WHERE i.kind = 'item' AND i.group_code = r.code) class_code,
         (SELECT MAX(i.class_desc) FROM items i WHERE i.kind = 'item' AND i.group_code = r.code) class_desc
  FROM items r
  WHERE r.kind = 'group'
  ORDER BY r.code`);

const listClasses = () => all(`
  SELECT r.code, r.descr,
         (SELECT COUNT(*)::int FROM items i WHERE i.kind = 'item' AND i.class_code = r.code) items
  FROM items r
  WHERE r.kind = 'class'
  ORDER BY r.code`);

async function saveGroup({ code, descr, editCode }) {
  code = str(code); descr = str(descr); const editing = str(editCode);
  if (!code) throw new Error('كود المجموعة مطلوب');
  if (!descr) throw new Error('اسم المجموعة مطلوب');
  const dup = await get('SELECT kind FROM items WHERE code=$1', [code]);
  if (dup) {
    if (dup.kind === 'item') throw new Error('هذا الكود مستخدم لصنف فعلي — اختر كوداً آخر');
    if (!editing) throw new Error('كود المجموعة موجود بالفعل — استخدم «تعديل»');
    if (editing !== code) throw new Error('كود المجموعة مستخدم بالفعل');
  }
  await run(`INSERT INTO items(code, descr, kind, origin, updated_at) VALUES($1,$2,'group','catalog',now())
             ON CONFLICT (code) DO UPDATE SET descr=$2, updated_at=now()
             WHERE items.kind <> 'item'`, [code, descr]);
  return { code };
}

async function saveClass({ code, descr, editCode }) {
  code = str(code); descr = str(descr); const editing = str(editCode);
  if (!code) throw new Error('كود التصنيف مطلوب');
  if (!descr) throw new Error('اسم التصنيف مطلوب');
  const dup = await get('SELECT kind FROM items WHERE code=$1', [code]);
  if (dup) {
    if (dup.kind === 'item') throw new Error('هذا الكود مستخدم لصنف فعلي — اختر كوداً آخر');
    if (!editing) throw new Error('كود التصنيف موجود بالفعل — استخدم «تعديل»');
    if (editing !== code) throw new Error('كود التصنيف مستخدم بالفعل');
  }
  await run(`INSERT INTO items(code, descr, kind, origin, updated_at) VALUES($1,$2,'class','catalog',now())
             ON CONFLICT (code) DO UPDATE SET descr=$2, updated_at=now()
             WHERE items.kind <> 'item'`, [code, descr]);
  return { code };
}

/* ================= المواقع والمصانع ================= */

async function listLocations() {
  const [companies, units, warehouses] = await Promise.all([
    all(`SELECT c.company_code code, c.company_name name, c.currency,
                (SELECT COUNT(*)::int FROM locations l WHERE l.company_code = c.company_code) units
         FROM companies c ORDER BY c.company_code`),
    all(`SELECT unit_code code, unit_name name, company_code, company_name, currency, place
         FROM locations ORDER BY unit_code`),
    all(`SELECT code, name, unit_code, company_code, place FROM warehouses ORDER BY code`),
  ]);
  return { companies, units, warehouses };
}

async function saveCompany({ code, name, currency, editCode }) {
  code = str(code); name = str(name); currency = str(currency).toUpperCase();
  const editing = str(editCode);
  if (!code) throw new Error('كود الشركة مطلوب');
  if (!name) throw new Error('اسم الشركة مطلوب');
  if (editing && editing !== code) {
    const dup = await get('SELECT 1 x FROM companies WHERE company_code=$1', [code]);
    if (dup) throw new Error('كود الشركة مستخدم بالفعل');
  }
  if (!editing) {
    const dup = await get('SELECT 1 x FROM companies WHERE company_code=$1', [code]);
    if (dup) throw new Error('كود الشركة موجود بالفعل — استخدم «تعديل»');
  }
  await run(`INSERT INTO companies(company_code, company_name, currency, updated_at)
             VALUES($1,$2,$3,now())
             ON CONFLICT (company_code)
             DO UPDATE SET company_name=$2, currency=$3, updated_at=now()`,
    [code, name, currency]);
  /* مزامنة الجدول المفكّك locations (كل وحدات الشركة تحمل كودها واسمها وعملتها) */
  await run(`UPDATE locations SET company_code=$1, company_name=$2, currency=$3
             WHERE company_code=$4`, [code, name, currency, editing || code]);
  return { code };
}

async function saveUnit({ code, name, company, place, editCode }) {
  code = str(code); name = str(name); company = str(company); place = str(place);
  const editing = str(editCode);
  if (!code) throw new Error('كود الوحدة مطلوب');
  if (!name) throw new Error('اسم الوحدة مطلوب');
  if (!company) throw new Error('اختر الشركة التابعة لها الوحدة');
  const c = await get('SELECT company_name, currency FROM companies WHERE company_code=$1', [company]);
  if (!c) throw new Error('الشركة غير موجودة — أضفها أولاً');
  if (editing && editing !== code) {
    const dup = await get('SELECT 1 x FROM locations WHERE unit_code=$1', [code]);
    if (dup) throw new Error('كود الوحدة مستخدم بالفعل');
  }
  if (!editing) {
    const dup = await get('SELECT 1 x FROM locations WHERE unit_code=$1', [code]);
    if (dup) throw new Error('كود الوحدة موجود بالفعل — استخدم «تعديل»');
  }
  await run(`INSERT INTO locations(unit_code, company_code, company_name, currency, unit_name, place, source_file)
             VALUES($1,$2,$3,$4,$5,$6,NULL)
             ON CONFLICT (unit_code) DO UPDATE
               SET company_code=$2, company_name=$3, currency=$4, unit_name=$5, place=$6`,
    [code, company, c.company_name, c.currency, name, place]);
  return { code };
}

/** المخزن: يُسند عليه الشركة والوحدة (تُجلب من الوحدة) والمكان */
async function saveWarehouse({ code, name, unit, company, place, editCode }) {
  code = str(code); name = str(name); unit = str(unit); place = str(place);
  const editing = str(editCode);
  if (!code) throw new Error('كود المخزن مطلوب');
  if (!name) throw new Error('اسم المخزن مطلوب');
  company = str(company);
  if (unit) {
    const u = await get('SELECT company_code, place FROM locations WHERE unit_code=$1', [unit]);
    if (!u) throw new Error('الوحدة غير موجودة — أضفها أولاً');
    company = u.company_code;
    if (!place) place = u.place || '';       // المكان يُرثه من الوحدة إن لم يُحدَّد
  } else if (!company) {
    throw new Error('اختر الوحدة التي ينتمي إليها المخزن');
  }
  if (editing && editing !== code) {
    const dup = await get('SELECT 1 x FROM warehouses WHERE code=$1', [code]);
    if (dup) throw new Error('كود المخزن مستخدم بالفعل');
  }
  if (!editing) {
    const dup = await get('SELECT 1 x FROM warehouses WHERE code=$1', [code]);
    if (dup) throw new Error('كود المخزن موجود بالفعل — استخدم «تعديل»');
  }
  await run(`INSERT INTO warehouses(code, name, unit_code, company_code, place, updated_at)
             VALUES($1,$2,$3,$4,$5,now())
             ON CONFLICT (code) DO UPDATE
               SET name=$2, unit_code=$3, company_code=$4, place=$5, updated_at=now()`,
    [code, name, unit, company, place]);
  return { code };
}

/* ================= أنواع الحركات ================= */

async function listMtypes({ q } = {}) {
  const where = [], p = [];
  if (q) {
    p.push('%' + q + '%');
    where.push(`(type_code ILIKE $${p.length} OR direction ILIKE $${p.length}
              OR system_desc ILIKE $${p.length} OR category ILIKE $${p.length})`);
  }
  return all(`
    SELECT type_code code, COALESCE(direction,'') descr,
           COALESCE(system_desc,'') system_desc, COALESCE(category,'') category
    FROM movement_types
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY type_code`, p);
}

async function saveMtype({ code, descr, systemDesc, category, editCode }) {
  code = str(code); descr = str(descr);
  systemDesc = str(systemDesc); category = str(category);
  const editing = str(editCode);
  if (!code) throw new Error('نوع الحركة مطلوب');
  if (editing && editing !== code) {
    const dup = await get('SELECT 1 x FROM movement_types WHERE type_code=$1', [code]);
    if (dup) throw new Error('نوع الحركة مستخدم بالفعل');
  }
  if (!editing) {
    const dup = await get('SELECT 1 x FROM movement_types WHERE type_code=$1', [code]);
    if (dup) throw new Error('نوع الحركة موجود بالفعل — استخدم «تعديل»');
  }
  await run(`INSERT INTO movement_types(type_code, direction, system_desc, category, source_file)
             VALUES($1,$2,$3,$4,NULL)
             ON CONFLICT (type_code) DO UPDATE
               SET direction=$2, system_desc=$3, category=$4`,
    [code, descr, systemDesc, category]);
  return { code };
}

module.exports = {
  listItems, saveItem, syncFromMovements,
  listGroups, saveGroup, listClasses, saveClass,
  listLocations, saveCompany, saveUnit, saveWarehouse,
  listMtypes, saveMtype,
};
