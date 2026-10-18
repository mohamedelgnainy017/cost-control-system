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

async function listItems({ origin, q, limit = 500, group, cls, groupFrom, groupTo, clsFrom, clsTo, clsState } = {}) {
  const where = ["i.kind = 'item'"], p = [];
  if (origin && origin !== 'all') { p.push(origin); where.push(`i.origin = $${p.length}`); }
  if (q) {
    p.push('%' + q + '%');
    where.push(`(i.code ILIKE $${p.length} OR i.descr ILIKE $${p.length}
              OR i.group_desc ILIKE $${p.length} OR i.class_desc ILIKE $${p.length})`);
  }
  /* حالة التصنيف: مصنّفة/مسجّلة يدوياً مقابل جلبها السيستم من الحركات بلا تصنيف */
  if (clsState === 'done') { where.push(`(COALESCE(i.group_code,'') <> '' OR COALESCE(i.class_code,'') <> '' OR i.origin = 'mine')`); }
  if (clsState === 'none') { where.push(`(COALESCE(i.group_code,'') = '' AND COALESCE(i.class_code,'') = '' AND i.origin = 'movement')`); }
  if (group) { p.push(group); where.push(`i.group_code = $${p.length}`); }
  if (cls) { p.push(cls); where.push(`i.class_code = $${p.length}`); }
  /* نطاق القيم «من / إلى» للمجموعة والتصنيف (مقارنة نصية بترتيب الأكواد) */
  if (groupFrom) { p.push(groupFrom); where.push(`COALESCE(i.group_code,'') >= $${p.length}`); }
  if (groupTo) { p.push(groupTo); where.push(`COALESCE(i.group_code,'') <= $${p.length}`); }
  if (clsFrom) { p.push(clsFrom); where.push(`COALESCE(i.class_code,'') >= $${p.length}`); }
  if (clsTo) { p.push(clsTo); where.push(`COALESCE(i.class_code,'') <= $${p.length}`); }
  p.push(Math.min(Number(limit) || 500, 20000));
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
        group_code=$4, group_desc=$5, class_code=$6, class_desc=$7, origin='mine', updated_at=now()
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

/* ============ الحذف (من قائمة «إضافة بيانات») ============ */

async function deleteItem({ code }) {
  code = str(code);
  if (!code) throw new Error('كود الصنف مطلوب');
  const r = await run(`DELETE FROM items WHERE code=$1 AND kind='item'`, [code]);
  if (!r.changes) throw new Error('الصنف غير موجود — أو حُذف مسبقاً');
  return { code };
}

async function deleteGroup({ code }) {
  code = str(code);
  if (!code) throw new Error('كود المجموعة مطلوب');
  const used = await get(`SELECT COUNT(*)::int n FROM items WHERE kind='item' AND group_code=$1`, [code]);
  if (used && used.n) throw new Error(`لا يمكن حذف المجموعة — مازالت مستخدمة من ${used.n} صنف (غيّر مجموعاتها أولاً)`);
  const r = await run(`DELETE FROM items WHERE code=$1 AND kind='group'`, [code]);
  if (!r.changes) throw new Error('المجموعة غير موجودة — أو حُذفت مسبقاً');
  return { code };
}

async function deleteClass({ code }) {
  code = str(code);
  if (!code) throw new Error('كود التصنيف مطلوب');
  const used = await get(`SELECT COUNT(*)::int n FROM items WHERE kind='item' AND class_code=$1`, [code]);
  if (used && used.n) throw new Error(`لا يمكن حذف التصنيف — مازال مستخدماً من ${used.n} صنف (غيّر تصنيفاتها أولاً)`);
  const r = await run(`DELETE FROM items WHERE code=$1 AND kind='class'`, [code]);
  if (!r.changes) throw new Error('التصنيف غير موجود — أو حُذف مسبقاً');
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
    all(`SELECT code, name, unit_code, company_code, place, location_name, classification, warehouse_group, report_active, is_transit FROM warehouses ORDER BY code`),
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
async function saveWarehouse({ code, name, unit, company, place, locationName, classification, warehouseGroup, editCode, reportActive, isTransit }) {
  code = str(code); name = str(name); unit = str(unit); place = str(place);
  locationName = str(locationName); classification = str(classification); warehouseGroup = str(warehouseGroup);
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
  await run(`INSERT INTO warehouses(code, name, unit_code, company_code, place, location_name, classification, warehouse_group, report_active, is_transit, updated_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
             ON CONFLICT (code) DO UPDATE
               SET name=$2, unit_code=$3, company_code=$4, place=$5, location_name=$6, classification=$7, warehouse_group=$8, report_active=$9, is_transit=$10, updated_at=now()`,
    [code, name, unit, company, place, locationName, classification, warehouseGroup, !!reportActive, !!isTransit]);
  return { code };
}

async function setWarehouseReportActive(code, active) {
  code = str(code);
  if (!code) throw new Error('كود المخزن مطلوب');
  const r = await get('SELECT 1 x FROM warehouses WHERE code=$1', [code]);
  if (!r) throw new Error('المخزن غير موجود');
  await run('UPDATE warehouses SET report_active=$1, updated_at=now() WHERE code=$2', [!!active, code]);
  return { code, report_active: !!active };
}

/* ================= أنواع الحركات ================= */

async function listMtypes({ q, catFrom, catTo } = {}) {
  const where = ["COALESCE(kind,'movement') = 'movement'"], p = [];
  if (q) {
    p.push('%' + q + '%');
    where.push(`(type_code ILIKE $${p.length} OR direction ILIKE $${p.length}
              OR system_desc ILIKE $${p.length} OR category ILIKE $${p.length})`);
  }
  /* نطاق التصنيف «من / إلى» */
  if (catFrom) { p.push(catFrom); where.push(`COALESCE(category,'') >= $${p.length}`); }
  if (catTo) { p.push(catTo); where.push(`COALESCE(category,'') <= $${p.length}`); }
  return all(`
    SELECT type_code code, COALESCE(direction,'') descr,
           COALESCE(system_desc,'') system_desc, COALESCE(category,'') category
    FROM movement_types
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY type_code`, p);
}

/* التصنيفات — صفوف داخل نفس جدول  movement_types بلا جدول منفصل */
async function listCategories() {
  return all(`
    SELECT type_code code, category name, COALESCE(system_desc,'') descr
    FROM movement_types
    WHERE kind = 'category' AND COALESCE(category,'') <> ''
    ORDER BY category`);
}

async function saveCategory({ code, name, descr, editCode }) {
  code = str(code); name = str(name); descr = str(descr);
  const editing = str(editCode);
  if (!code) throw new Error('كود التصنيف مطلوب');
  if (!name) throw new Error('اسم التصنيف مطلوب');
  const dup = await get(`SELECT 1 x FROM movement_types WHERE type_code=$1 AND kind='category'`, [code]);
  if (dup && (!editing || editing !== code)) throw new Error('كود التصنيف مستخدم بالفعل');
  await run(`INSERT INTO movement_types(type_code, direction, system_desc, category, kind, source_file)
             VALUES($1, NULL, $2, $3, 'category', NULL)
             ON CONFLICT (type_code) DO UPDATE
               SET direction=NULL, system_desc=$2, category=$3, kind='category'`,
    [code, descr, name]);
  return { code };
}

async function deleteCategory({ code }) {
  code = str(code);
  if (!code) throw new Error('كود التصنيف مطلوب');
  const r = await run(`DELETE FROM movement_types WHERE type_code=$1 AND kind='category'`, [code]);
  if (!r.changes) throw new Error('التصنيف غير موجود — أو حُذف مسبقاً');
  return { code };
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
  await run(`INSERT INTO movement_types(type_code, direction, system_desc, category, kind, source_file)
             VALUES($1,$2,$3,$4,'movement',NULL)
             ON CONFLICT (type_code) DO UPDATE
               SET direction=$2, system_desc=$3, category=$4, kind='movement'`,
    [code, descr, systemDesc, category]);
  return { code };
}

async function deleteMtype({ code }) {
  code = str(code);
  if (!code) throw new Error('نوع الحركة مطلوب');
  const used = await get(`SELECT COUNT(*)::int n FROM movements WHERE move_type=$1`, [code]);
  if (used && used.n) throw new Error(`لا يمكن حذف نوع الحركة — مستخدم في ${used.n} حركة`);
  const r = await run(`DELETE FROM movement_types WHERE type_code=$1`, [code]);
  if (!r.changes) throw new Error('نوع الحركة غير موجود — أو حُذف مسبقاً');
  return { code };
}

/* ---------- حذف المواقع (شركة/وحدة/مخزن) مع حماية المرتبطات ---------- */

async function deleteCompany({ code }) {
  code = str(code);
  if (!code) throw new Error('كود الشركة مطلوب');
  const u = await get(`SELECT COUNT(*)::int n FROM locations WHERE company_code=$1`, [code]);
  const m = await get(`SELECT COUNT(*)::int n FROM movements WHERE company_code=$1`, [code]);
  const b = await get(`SELECT COUNT(*)::int n FROM balances  WHERE company_code=$1`, [code]);
  const w = await get(`SELECT COUNT(*)::int n FROM warehouses WHERE company_code=$1`, [code]);
  if ((u.n || 0) + (m.n || 0) + (b.n || 0) + (w.n || 0))
    throw new Error(`لا يمكن حذف الشركة — مرتبطة بـ ${u.n} وحدة و ${w.n} مخزن و ${m.n} حركة و ${b.n} رصيد`);
  const r = await run(`DELETE FROM companies WHERE company_code=$1`, [code]);
  if (!r.changes) throw new Error('الشركة غير موجودة — أو حُذفت مسبقاً');
  return { code };
}

async function deleteUnit({ code }) {
  code = str(code);
  if (!code) throw new Error('كود الوحدة مطلوب');
  const w = await get(`SELECT COUNT(*)::int n FROM warehouses WHERE unit_code=$1`, [code]);
  const m = await get(`SELECT COUNT(*)::int n FROM movements  WHERE unit_code=$1`, [code]);
  const b = await get(`SELECT COUNT(*)::int n FROM balances   WHERE unit_code=$1`, [code]);
  const s = await get(`SELECT COUNT(*)::int n FROM sales      WHERE unit_code=$1`, [code]);
  if ((w.n || 0) + (m.n || 0) + (b.n || 0) + (s.n || 0))
    throw new Error(`لا يمكن حذف الوحدة — مرتبطة بـ ${w.n} مخزن و ${m.n} حركة و ${b.n} رصيد و ${s.n} سطر مبيعات`);
  const r = await run(`DELETE FROM locations WHERE unit_code=$1`, [code]);
  if (!r.changes) throw new Error('الوحدة غير موجودة — أو حُذفت مسبقاً');
  return { code };
}

async function deleteWarehouse({ code }) {
  code = str(code);
  if (!code) throw new Error('كود المخزن مطلوب');
  const m = await get(`SELECT COUNT(*)::int n FROM movements WHERE storage_loc=$1`, [code]);
  const b = await get(`SELECT COUNT(*)::int n FROM balances  WHERE storage_loc=$1`, [code]);
  if ((m.n || 0) + (b.n || 0))
    throw new Error(`لا يمكن حذف المخزن — مستخدم في ${m.n} حركة و ${b.n} رصيد`);
  const r = await run(`DELETE FROM warehouses WHERE code=$1`, [code]);
  if (!r.changes) throw new Error('المخزن غير موجود — أو حُذف مسبقاً');
  return { code };
}

/* ================= مراجع عقود الاستيراد =================
   أربع قوائم (موردين S — مصادر C — موانئ وصول PN — موانئ تحميل PX) في جداول مستقلة.
   تُدار من شاشة «البيانات الأساسية ← مراجع العقود» وتغذّي القوائم المنسدلة في نماذج العقود. */
const REF_KINDS = {
  supplier:     { table: 'contract_suppliers',     label: 'الموردين',      prefix: 'S',  pad: 3 },
  source:       { table: 'contract_countries',     label: 'المصادر',        prefix: 'C',  pad: 3 },
  arrival_port: { table: 'contract_arrival_ports', label: 'موانئ الوصول',  prefix: 'PN', pad: 3 },
  loading_port: { table: 'contract_ports',         label: 'موانئ التحميل', prefix: 'PX', pad: 3 },
};
/* أعمدة الاستخدام بالاسم داخل جداول العقود — لحماية الحذف */
const REF_USAGE = {
  supplier: [['contract_registrations', 'supplier'], ['contract_payments', 'supplier'],
             ['contract_hedge', 'supplier'], ['contract_roll', 'supplier']],
  source: [['contract_registrations', 'source_country'], ['contract_details', 'source_country']],
  arrival_port: [['contract_details', 'arrival_port']],
  loading_port: [],
};
const refDef = kind => {
  const d = REF_KINDS[kind];
  if (!d) throw new Error('نوع مرجع غير معروف');
  return d;
};

const listRefs = async kind => {
  const d = refDef(kind);
  return all(`SELECT code, name FROM ${d.table} ORDER BY code`);
};

async function listAllRefs() {
  const out = {};
  for (const kind of Object.keys(REF_KINDS)) out[kind] = await listRefs(kind);
  return out;
}

/** الكود التالي بالبادئة (S015 / C009 / PN005 / PX018) — أكبر رقم سابق + 1 */
async function nextRefCode(kind) {
  const d = refDef(kind);
  const rows = await all(`SELECT code FROM ${d.table} WHERE code ILIKE $1`, [d.prefix + '%']);
  const rx = new RegExp('^' + d.prefix + '(\\d+)$', 'i');
  let mx = 0;
  for (const r of rows) { const m = rx.exec(str(r.code)); if (m) mx = Math.max(mx, parseInt(m[1], 10)); }
  return d.prefix + String(mx + 1).padStart(d.pad, '0');
}

async function saveRef({ kind, code, name, editCode } = {}) {
  const d = refDef(kind);
  name = str(name); code = str(code); const editing = str(editCode);
  if (!name) throw new Error('الاسم مطلوب');
  if (!code) code = await nextRefCode(kind);
  if (editing) {
    if (code !== editing) {
      const dup = await get(`SELECT 1 x FROM ${d.table} WHERE code=$1`, [code]);
      if (dup) throw new Error('الكود مستخدم بالفعل');
    }
    const r = await run(`UPDATE ${d.table} SET code=$1, name=$2, updated_at=now() WHERE code=$3`,
      [code, name, editing]);
    if (!r.changes) throw new Error('السجل غير موجود — قد يكون حُذف');
    return { code };
  }
  const dup = await get(`SELECT 1 x FROM ${d.table} WHERE code=$1`, [code]);
  if (dup) throw new Error('الكود موجود بالفعل — استخدم «تعديل»');
  await run(`INSERT INTO ${d.table}(code, name, updated_at) VALUES($1,$2,now())`, [code, name]);
  return { code };
}

async function deleteRef({ kind, code } = {}) {
  const d = refDef(kind);
  code = str(code);
  if (!code) throw new Error('حدد السجل المطلوب حذفه');
  const row = await get(`SELECT name FROM ${d.table} WHERE code=$1`, [code]);
  if (!row) throw new Error('السجل غير موجود — أو حُذف مسبقاً');
  const name = str(row.name);
  let used = 0;
  for (const [tab, col] of (REF_USAGE[kind] || [])) {
    const u = await get(`SELECT COUNT(*)::int n FROM ${tab} WHERE ${col} = $1`, [name]);
    used += (u && u.n) || 0;
  }
  if (used) throw new Error(`لا يمكن الحذف — «${name}» مستخدم في ${used} سجل بجداول العقود`);
  await run(`DELETE FROM ${d.table} WHERE code=$1`, [code]);
  return { code };
}

module.exports = {
  listItems, saveItem,
  listGroups, saveGroup, listClasses, saveClass,
  deleteItem, deleteGroup, deleteClass,
  listLocations, saveCompany, saveUnit, saveWarehouse, setWarehouseReportActive,
  deleteCompany, deleteUnit, deleteWarehouse,
  listMtypes, saveMtype, deleteMtype,
  listCategories, saveCategory, deleteCategory,
  REF_KINDS, listRefs, listAllRefs, saveRef, deleteRef,
};
