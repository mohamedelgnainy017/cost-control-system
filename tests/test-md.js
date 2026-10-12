'use strict';
/* اختبار شاشات البيانات الأساسية: الأصناف والمواقع وأنواع الحركات
   التشغيل: السيرفر شغال أولاً (node src\server.js) ثم node tests\test-md.js */
const path = require('node:path');
const BASE = 'http://127.0.0.1:' + (process.env.TEST_PORT || 4310);
const DB = require(path.join(__dirname, '..', 'src', 'db'));
let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK  ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

async function req(method, path, body, cookie) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = {};
  try { j = await r.json(); } catch (_) {}
  return { status: r.status, j, setCookie: r.headers.get('set-cookie') };
}

(async () => {
  /* 1) صحة الخادم */
  const h = await req('GET', '/api/health');
  chk(h.status === 200, 'health = 200');

  /* 2) دخول المدير */
  const lg = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  chk(lg.status === 200, 'login admin = 200');
  const ck = (lg.setCookie || '').split(';')[0];
  if (!ck) { console.log('STOP: no cookie'); process.exit(1); }

  /* 3) الشاشات: 12 شاشة — أُزيل تبويب الاستيراد العام (الاستيراد صلاحية import لا شاشة) */
  const tabs = await req('GET', '/api/tabs', null, ck);
  const ids = (tabs.j.data && tabs.j.data.tabs || []).map(t => t.id);
  chk(ids.length === 12, 'tabs = 12 (الحالي ' + ids.length + ')');
  chk(['md-items', 'md-locations', 'md-movetypes'].every(t => ids.includes(t)), 'الشاشات الثلاث الجديدة مسجلة');
  chk(!ids.includes('import'), 'لا شاشة «import» — الاستيراد صلاحية بلا شاشة');
  const perms = tabs.j.data && tabs.j.data.perms;
  chk(perms && perms.accountant && perms.accountant.length === 11,
    'محاسب افتراضياً 11 شاشة (الحالي ' + (perms && perms.accountant && perms.accountant.length) + ')');
  chk(perms && perms.viewer && perms.viewer.length === 11,
    'مشاهد افتراضياً 11 شاشة (الحالي ' + (perms && perms.viewer && perms.viewer.length) + ')');

  /* 4) قراءة الشاشات الثلاث */
  const items = await req('GET', '/api/md/items?origin=all&limit=5', null, ck);
  chk(items.status === 200 && Array.isArray(items.j.data), 'GET /api/md/items = 200');
  const groups = await req('GET', '/api/md/items/groups', null, ck);
  chk(groups.status === 200, 'GET groups = 200');
  const classes = await req('GET', '/api/md/items/classes', null, ck);
  chk(classes.status === 200, 'GET classes = 200');
  const locs = await req('GET', '/api/md/locs', null, ck);
  chk(locs.status === 200 && locs.j.data.companies.length > 0, 'GET /api/md/locs = 200 والشركات (' +
    (locs.j.data.companies.length) + ')');
  chk(locs.j.data.units.length === 42, 'الوحدات 42 كما هي (' + locs.j.data.units.length + ')');
  const mts = await req('GET', '/api/md/mtypes', null, ck);
  chk(mts.status === 200 && mts.j.data.length > 0, 'GET /api/md/mtypes = 200 (' + mts.j.data.length + ' نوع)');

  /* 5) تحقق كود الصنف 9 خانات + كتالوج المجموعات/التصنيفات + الاختيار في نموذج الصنف */
  const short = await req('POST', '/api/md/items/save', { code: '1234567890', descr: 'اختبار', uom: 'KG' }, ck);
  chk(short.status === 400 && /9/.test(short.j.error || ''), 'كود 10 خانات مرفوض (400): ' + (short.j.error || ''));
  const short8 = await req('POST', '/api/md/items/save', { code: '12345678', descr: 'اختبار', uom: 'KG' }, ck);
  chk(short8.status === 400, 'كود 8 خانات مرفوض (400)');
  /* زرّا «＋ مجموعة» / «＋ تصنيف»: إضافة وتعديل من الكتالوج */
  const sg = await req('POST', '/api/md/items/groups/save', { code: 'ZZG', descr: 'مجموعة اختبار' }, ck);
  chk(sg.status === 200, 'إضافة مجموعة من زر ＋ مجموعة = 200');
  const sc = await req('POST', '/api/md/items/classes/save', { code: 'ZZC', descr: 'تصنيف اختبار' }, ck);
  chk(sc.status === 200, 'إضافة تصنيف من زر ＋ تصنيف = 200');
  const sg2 = await req('POST', '/api/md/items/groups/save', { code: 'ZZG', descr: 'مكرر' }, ck);
  chk(sg2.status === 400, 'تكرار كود المجموعة مرفوض');
  const sg3 = await req('POST', '/api/md/items/groups/save',
    { code: 'ZZG', descr: 'مجموعة اختبار معدّلة', editCode: 'ZZG' }, ck);
  const glist = await req('GET', '/api/md/items/groups', null, ck);
  const gZZG = (glist.j.data || []).find(x => x.code === 'ZZG');
  chk(sg3.status === 200 && gZZG && gZZG.descr === 'مجموعة اختبار معدّلة', 'تعديل مجموعة (كود واسم) = 200');
  const clist = await req('GET', '/api/md/items/classes', null, ck);
  chk((clist.j.data || []).some(x => x.code === 'ZZC'), 'التصنيف المضاف ظهر في قائمة الكتالوج');
  /* نموذج الصنف: اختيار فقط (كود) — الاسم يُجلب من الكتالوج */
  const tst = await req('POST', '/api/md/items/save', {
    code: '999888777', descr: 'صنف اختبار مؤقت', uom: 'KG',
    groupCode: 'ZZG', classCode: 'ZZC',
  }, ck);
  chk(tst.status === 200, 'إضافة صنف 9 خانات باختيار مجموعة وتصنيف = 200');
  const dup = await req('POST', '/api/md/items/save', { code: '999888777', descr: 'مكرر', uom: 'KG' }, ck);
  chk(dup.status === 400, 'تكرار الكود مرفوض (400)');
  const up = await req('POST', '/api/md/items/save',
    { code: '999888777', descr: 'صنف اختبار (عدّل)', uom: 'TO', editCode: '999888777',
      groupCode: 'ZZG', classCode: 'ZZC' }, ck);
  chk(up.status === 200, 'تعديل صنف بنفس الكود = 200');
  const tst2 = await req('GET', '/api/md/items?q=999888777', null, ck);
  const t2 = tst2.j.data && tst2.j.data[0];
  chk(t2 && t2.group_code === 'ZZG' && t2.group_desc === 'مجموعة اختبار معدّلة' &&
    t2.class_code === 'ZZC' && t2.class_desc === 'تصنيف اختبار',
    'كود واسم المجموعة/التصنيف المختارين محفوظان مع الصنف (' +
    (t2 && t2.group_code) + '/' + (t2 && t2.class_code) + ')');
  /* التصنيف الأب يُرث تلقائياً من مجموعة الصنف إن لم يُختار */
  const inherit = await req('POST', '/api/md/items/save', {
    code: '999888776', descr: 'صنف يرث التصنيف', uom: 'KG', groupCode: 'ZZG' }, ck);
  chk(inherit.status === 200, 'إضافة صنف بمجموعة فقط = 200');
  const tst3 = await req('GET', '/api/md/items?q=999888776', null, ck);
  const t3 = tst3.j.data && tst3.j.data[0];
  chk(t3 && t3.class_code === 'ZZC', 'صُنف المجموعة رُثَّ منها التصنيف تلقائياً (' + (t3 && t3.class_code) + ')');

  /* 6) المزامنة: جلب الأصناف من الحركات + التسكين */
  const sy = await req('POST', '/api/md/items/sync', {}, ck);
  chk(sy.status === 200, 'POST /api/md/items/sync = 200');
  const ins = sy.j.data && sy.j.data.inserted, stl = sy.j.data && sy.j.data.settled;
  console.log('       inserted=' + ins + ' settled=' + stl + ' (0/0 إذا كانت المزامنة سبقت)');

  const movAll = await req('GET', '/api/md/items?origin=movement&limit=3000', null, ck);
  const movCnt = (movAll.j.data || []).length;
  chk(movCnt > 1300, 'إجمالي الأصناف المجلوبة من الحركات > 1300 (' + movCnt + ')');

  const mov = await req('GET', '/api/md/items?origin=movement&limit=3', null, ck);
  chk(mov.status === 200 && mov.j.data.length === 3, 'فلتر «من الحركات» يرجع أصنافاً');
  const m0 = mov.j.data[0];
  chk(m0.origin === 'movement', 'أصل الصنف = movement');
  chk(!!(m0.group_code || m0.group_desc), 'مجموعة المواد مُسكَّنة من المجموعة الخارجية: ' + m0.group_code + '/' + m0.group_desc);
  chk(!!(m0.class_code || m0.class_desc), 'التصنيف مُسكَّن من مجموعة المواد: ' + m0.class_code + '/' + m0.class_desc);

  const grp2 = await req('GET', '/api/md/items/groups', null, ck);
  const zGroups = (grp2.j.data || []).filter(g => /^Z/.test(g.code));
  chk(zGroups.length > 0, 'قائمة المجموعات المشتقة تحتوي كودات Z من الأصناف (' + zGroups.length + ' منها)');
  /* مجموعة مشتقة لها أصناف فعلاً (بعض صفوف المجموعات المشتقة تبقى بلا أصناف) */
  const gZ = zGroups.find(g => g.items > 0);
  chk(!!gZ, 'المجموعة المشتقة معها عدد أصنافها (' + (gZ && gZ.code) + ' = ' + (gZ && gZ.items) + ' صنف)');
  const gZp = zGroups.find(g => g.class_code || g.class_desc);
  chk(!!gZp && !!(gZp.class_code || gZp.class_desc),
    'المجموعة المشتقة تحمل تصنيفها الأب (' + (gZp && gZp.code) + ' ← ' + (gZp && gZp.class_code) + ')');

  /* 7) المواقع: إضافة شركة + وحدة + مخزن (مع التسكين التلقائي) */
  const co = await req('POST', '/api/md/locs/company/save', { code: 'ZZT', name: 'شركة اختبار', currency: 'egp' }, ck);
  chk(co.status === 200, 'إضافة شركة = 200');
  const co2 = await req('POST', '/api/md/locs/company/save', { code: 'ZZT', name: 'مكررة', currency: 'EGP' }, ck);
  chk(co2.status === 400, 'تكرار الشركة مرفوض');
  const un = await req('POST', '/api/md/locs/unit/save',
    { code: 'ZZTU', name: 'وحدة اختبار', company: 'ZZT', place: 'الموقع التجريبي' }, ck);
  chk(un.status === 200, 'إضافة وحدة = 200');
  const wh = await req('POST', '/api/md/locs/warehouse/save',
    { code: 'ZZTW', name: 'مخزن اختبار', unit: 'ZZTU' }, ck);
  chk(wh.status === 200, 'إضافة مخزن = 200');
  const locs2 = await req('GET', '/api/md/locs', null, ck);
  const whx = locs2.j.data.warehouses.find(w => w.code === 'ZZTW');
  chk(whx && whx.company_code === 'ZZT', 'المخزن وُسند عليه الشركة تلقائياً (' + (whx && whx.company_code) + ')');
  chk(whx && whx.place === 'الموقع التجريبي', 'المكان وُرث من الوحدة (' + (whx && whx.place) + ')');
  /* تعديل شركة ينعكس على وحداتها */
  const co3 = await req('POST', '/api/md/locs/company/save',
    { code: 'ZZT', name: 'شركة اختبار معدّلة', currency: 'USD', editCode: 'ZZT' }, ck);
  const un2 = await req('GET', '/api/md/locs', null, ck);
  const uz = un2.j.data.units.find(u => u.code === 'ZZTU');
  chk(co3.status === 200 && uz && uz.company_name === 'شركة اختبار معدّلة' && uz.currency === 'USD',
    'تعديل الشركة انعكس على وحداتها (status=' + co3.status + ' err=' + (co3.j.error || '') +
    ' name=' + (uz && uz.company_name) + ' ccy=' + (uz && uz.currency) + ')');

  /* 7ب) مع كل استيراد حركات: الوحدة الجديدة وموقع التخزين الجديد يُجلبان تلقائياً
         (نُدرج حركة تجريبية كأنها وصلت بشيت جديد ثم نشغّل المزامنة) */
  await DB.run(`INSERT INTO movements(item, item_desc, uom, qty, company_code, unit_code, storage_loc, source_file)
                VALUES('155555555','صنف من حركة اختبار','KG',5,'ZZT','ZZN1','ZZW1','__test_md')`);
  const sy2 = await req('POST', '/api/md/items/sync', {}, ck);
  chk(sy2.status === 200 && sy2.j.data.inserted >= 1, 'مزامنة جُلبت الحركة التجريبية');
  const locs3 = await req('GET', '/api/md/locs', null, ck);
  const unN = (locs3.j.data.units || []).find(u => u.code === 'ZZN1');
  chk(!!unN && unN.company_code === 'ZZT', 'الوحدة الجديدة من الحركات ظهرت في المواقع تلقائياً');
  const whN = (locs3.j.data.warehouses || []).find(w => w.code === 'ZZW1');
  chk(!!whN && whN.unit_code === 'ZZN1' && whN.company_code === 'ZZT',
    'موقع التخزين الجديد من الحركات ظهر في المخازن تلقائياً (اسمه واسم الموقع معاً)');
  const itN = await req('GET', '/api/md/items?q=155555555', null, ck);
  chk((itN.j.data || []).some(x => x.code === '155555555' && x.origin === 'movement'),
    'صنف الحركة الجديدة اتحلب في الأصناف بعلامة «من الحركات»');

  /* 8) أنواع الحركات: إضافة وصف السيستم والتصنيف */
  const mt = await req('POST', '/api/md/mtypes/save',
    { code: 'ZZZ', descr: 'وصف اختبار', systemDesc: 'ينقل للمخزن', category: 'ترحيل' }, ck);
  chk(mt.status === 200, 'إضافة نوع حركة = 200');
  const mts2 = await req('GET', '/api/md/mtypes?q=ZZZ', null, ck);
  chk(mts2.j.data.length === 1 && mts2.j.data[0].system_desc === 'ينقل للمخزن', 'وصف السيستم والتصنيف محفوظان');

  /* 9) المشاهد: قراءة مفتوحة + كتابة ممنوعة (master) — يُنشأ مؤقتاً ثم يُحذف */
  await req('POST', '/api/users', { username: '__tstmd', full_name: 'اختبار', password: 'x123456', role: 'viewer' }, ck);
  const ulist = await req('GET', '/api/users', null, ck);
  const tu = (ulist.j.data || []).find(u => u.username === '__tstmd');
  const vlg = await req('POST', '/api/auth/login', { username: '__tstmd', password: 'x123456' });
  chk(!!tu && vlg.status === 200, 'إنشاء مشاهد مؤقت ودخوله');
  if (tu && vlg.status === 200) {
    const vck = (vlg.setCookie || '').split(';')[0];
    const vr = await req('GET', '/api/md/items?limit=2', null, vck);
    chk(vr.status === 200, 'مشاهد يقرأ الأصناف = 200 (status=' + vr.status + ' err=' + (vr.j.error || '') + ')');
    const vw = await req('POST', '/api/md/items/save', { code: '111222333', descr: 'x', uom: 'KG' }, vck);
    chk(vw.status === 403, 'مشاهد يضيف صنف = 403');
    const vwh = await req('POST', '/api/md/locs/warehouse/save', { code: 'Q', name: 'q', unit: 'ZZTU' }, vck);
    chk(vwh.status === 403, 'مشاهد يضيف مخزن = 403');
    const vm = await req('POST', '/api/md/mtypes/save', { code: 'Q' }, vck);
    chk(vm.status === 403, 'مشاهد يضيف نوع حركة = 403');
    /* حماية الشاشة: سحب شاشة الأصناف عن المشاهد → 403 على قراءتها */
    const permsNow = (await req('GET', '/api/tabs', null, ck)).j.data.perms;
    const bodyPerms = {
      accountant: permsNow.accountant,
      viewer: permsNow.viewer.filter(t => t !== 'md-items'),
    };
    await req('POST', '/api/tabs/save', { perms: bodyPerms }, ck);
    const blocked = await req('GET', '/api/md/items?limit=2', null, vck);
    chk(blocked.status === 403, 'سحب شاشة الأصناف عن المشاهد → 403 على API الشاشة');
    await req('POST', '/api/tabs/save', { perms: permsNow }, ck);   // استعادة
    await req('POST', '/api/users/delete', { id: tu.id }, ck);      // حذف الاختبار
    const gone = await req('GET', '/api/users', null, ck);
    chk(!(gone.j.data || []).some(u => u.username === '__tstmd'), 'حذف المشاهد التجريبي');
  } else {
    badTag('إعداد المشاهد التجريبي (status=' + vlg.status + ')');
  }

  /* 8) استيراد الملفات اليومية: قائمة + تاريخ اليوم من الاسم + الحذف */
  const dl = await req('GET', '/api/files/daily?cat=movements', null, ck);
  chk(dl.status === 200 && Array.isArray(dl.j.data && dl.j.data.files),
    'GET /api/files/daily?cat=movements = 200 (قائمة ملفات)');
  const dlSales = await req('GET', '/api/files/daily?cat=sales', null, ck);
  chk(dlSales.status === 200, 'GET /api/files/daily?cat=sales = 200');
  const dlBad = await req('GET', '/api/files/daily?cat=xxx', null, ck);
  chk(dlBad.status === 400, 'فئة يومية غير معروفة → 400');
  await DB.run(`INSERT INTO imports (file_path, file_name, dataset, sheet_name, rows_total, rows_inserted, status)
               VALUES ($1, $2, 'movements', 'fake', 5, 5, 'ok')`,
               ['X:\\DAILY\\01-10-2026.xlsx', '01-10-2026.xlsx']);
  const listed = await req('GET', '/api/files/daily?cat=movements', null, ck);
  const fakeRow = (listed.j.data && listed.j.data.files || []).find(f => (f.file_name || '') === '01-10-2026.xlsx');
  chk(!!fakeRow && fakeRow.date === '2026-10-01', 'قراءة تاريخ اليوم من اسم الملف (01-10-2026)');
  const del = await req('POST', '/api/files/delete', { cat: 'movements', file: 'X:\\DAILY\\01-10-2026.xlsx' }, ck);
  chk(del.status === 200, 'حذف ملف يومي = 200');
  const goneImp = await req('GET', '/api/files/daily?cat=movements', null, ck);
  chk(!(goneImp.j.data && goneImp.j.data.files || []).some(f => (f.file_name || '').startsWith('01-10-2026')),
    'الملف المحذوف اختفى من القائمة');

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');

  /* 10) تنظيف بيانات الاختبار */
  try {
    await DB.run("DELETE FROM items WHERE code IN ('999888777','999888776','155555555')");
    await DB.run("DELETE FROM items WHERE kind = 'group' AND code = 'ZZG'");
    await DB.run("DELETE FROM items WHERE kind = 'class' AND code = 'ZZC'");
    await DB.run("DELETE FROM movements WHERE item = '155555555'");
    await DB.run("DELETE FROM locations WHERE unit_code = 'ZZN1'");
    await DB.run("DELETE FROM warehouses WHERE code = 'ZZW1'");
    await DB.run("DELETE FROM warehouses WHERE code = 'ZZTW'");
    await DB.run("DELETE FROM locations WHERE unit_code = 'ZZTU'");
    await DB.run("DELETE FROM companies WHERE company_code = 'ZZT'");
    await DB.run("DELETE FROM movement_types WHERE type_code = 'ZZZ'");
    await DB.delSetting('tab_perms');
    await DB.run(`DELETE FROM imports WHERE file_path LIKE 'X:%'`);   // سجلات اليوم الوهمية
    console.log('cleanup done');
  } catch (e) { console.log('cleanup error: ' + e.message); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });