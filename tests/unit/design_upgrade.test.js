'use strict';
/**
 * اختبارات ترقية المصمم — مكوّن «الشكل» + العنوان/الوصف + التراجع/الإعادة + المعاينة الحيّة
 * =========================================================================
 * بيانات اصطناعية فقط · بلا اتصال · بلا خادم.
 */
const path = require('path');
const fs = require('fs');
const guard = require('./_guard');
guard.install();

const S = require('../../src/report-schema');
const RS = require('../../src/report-store');
const RB = require('../../src/report-bridge');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

const IDX = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const RD = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'report-designer.js'), 'utf8');
const SRV = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');

console.log('== ترقية المصمم: شكل + عنوان/وصف + تراجع/إعادة + معاينة حيّة ==');

/* ---------- 1) النموذج: نوع «shape» مسموح ونصه محفوظ ---------- */
{
  chk(S.COMPONENT_TYPES.indexOf('shape') >= 0, 'النموذج يعرف نوع «shape»');
  const c = S.normalizeComponent({ type: 'shape', text: 'قسم' }, 0, []);
  chk(!!c && c.type === 'shape' && c.text === 'قسم', 'نص الشكل محفوظ بعد التطبيع');
  const cs = S.normalizeComponent({ type: 'shape', text: 'قسم', grid: { w: 6, h: 1 } }, 0, []);
  chk(!!cs && cs.grid && cs.grid.w === 6 && cs.grid.h === 1, 'أبعاد الشكل تُحفظ كما هي');
  const v = S.validateReport({ name: 'x', components: [{ type: 'shape', text: 'قسم' }] });
  chk(v.ok === true, 'تقرير يتكوّن من شكل فقط صالح');
}

/* ---------- 2) النموذج: عنوان ووصف التقرير محفوظان ---------- */
{
  const n = S.normalizeReport({ name: 'ت', title: 'عنوان', description: 'وصف', components: [] });
  chk(n.title === 'عنوان' && n.description === 'وصف', 'العنوان والوصف محفوظان في التعريف');
  const n2 = S.normalizeReport({ name: 'ت', components: [] });
  chk(n2.title === '' && n2.description === '', 'بلا عنوان/وصف ⇒ قيم فارغة (لا افتراضات)');
  const long = S.normalizeReport({ name: 'ت', title: 'x'.repeat(500), description: 'y'.repeat(900), components: [] });
  chk(long.title.length === 120 && long.description.length === 400, 'العنوان والوصف مقيَّدان بالطول');
}

/* ---------- 3) المحرك: الشكل يُصيَّر ونصّه يُهرَّب ---------- */
(async () => {
  const data = { columns: ['item', 'qty'], rows: [{ item: 'A', qty: 3 }] };

  const sh = await RB.renderReport({ name: 'x', components: [{ type: 'shape', text: 'قسم' }] }, data);
  chk(sh.ok === true && sh.html.includes('rep-shape'), 'الشكل يُصيَّر في المعاينة');
  chk(sh.html.includes('قسم'), 'نص الشكل ظاهر');

  const bad = await RB.renderReport({ name: 'x', components: [{ type: 'shape', text: '<script>alert(1)</script>' }] }, data);
  chk(bad.html.indexOf('<script>') < 0, 'نص الشكل مُهرَّب (لا حقن HTML)');

  const emptyShape = await RB.renderReport({ name: 'x', components: [{ type: 'shape' }] }, data);
  chk(emptyShape.ok === true && emptyShape.html.includes('rep-shape'), 'شكل بلا نص يُصيَّر كعنصر فارغ');

  const frag = await RB.renderReport({ name: 'اسمي', title: 'عنوان', components: [{ type: 'text', text: 'x' }] }, data);
  chk(frag.html.indexOf('<h1>') < 0, 'المقطع المضمَّن بلا عنوان (توافق مع التقارير القديمة)');

  const exp = await RB.renderReport({ name: 'اسمي', title: 'عنوان', description: 'وصف', components: [{ type: 'text', text: 'x' }] }, data, { standalone: true });
  chk(exp.ok === true && exp.html.includes('عنوان') && exp.html.includes('وصف'), 'الملف المُصدَّر يحمل العنوان والوصف');
  chk(exp.html.includes('rep-desc'), 'وصف التقرير يظهر كفقرة مستقلة');

  const expNoTitle = await RB.renderReport({ name: 'اسمي', components: [{ type: 'text', text: 'x' }] }, data, { standalone: true });
  chk(expNoTitle.ok === true && expNoTitle.html.includes('اسمي'), 'الملف المُصدَّر يتراجع لاسم التقرير عند غياب العنوان');

  /* ---------- 4) المخزن: ملخّص المصدر في القائمة ---------- */
  {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ccs-store-'));
    RS.saveReport({
      name: 'ت', runId: 'r1', source: { name: 'daily_balances', label: 'الأرصدة اليومية', traced: true },
      components: [{ type: 'kpi', column: 'q', agg: 'sum' }],
    }, tmp);
    const list = RS.listReports(tmp);
    chk(list.length === 1, 'التقرير المحفوظ يظهر في القائمة');
    chk(list[0].source && list[0].source.label === 'الأرصدة اليومية', 'القائمة تحمل اسم المصدر');
    chk(list[0].source && list[0].source.traced === true, 'القائمة تحمل حالة التتبّع');
    chk(list[0].components === 1, 'القائمة تحمل عدد المكوّنات');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ---------- 5) المصمم: عقود التراجع/الإعادة والمعاينة الحيّة ---------- */
  {
    chk(/function undo\(\)/.test(RD) && /function redo\(\)/.test(RD), 'دالتا التراجع والإعادة موجودتان');
    chk(/const past = \[\]/.test(RD) && /const future = \[\]/.test(RD) && /stateSnapshot/.test(RD),
      'السجل يحفظ لقطة الحالة (محتوى + تخطيط + تحديد)');
    chk(/restoreState\(json\)/.test(RD) && /JSON\.parse\(json\)/.test(RD), 'الاستعادة تُعيد بناء الحالة فعليًا');
    chk(/id="rs-undo"/.test(IDX) && /id="rs-redo"/.test(IDX), 'أزرار التراجع/الإعادة في الواجهة');
    chk(/rs-undo'\)\?\.addEventListener/.test(RD) && /rs-redo'\)\?\.addEventListener/.test(RD), 'الأزرار موصولة بالوظائف');
    chk(/k === 'y' \|\| e\.shiftKey\) redo\(\); else undo\(\)/.test(RD), 'اختصارات Ctrl+Z / Ctrl+Y موصولة');
    chk(/liveOn/.test(RD) && /scheduleLivePreview/.test(RD) && /setTimeout/.test(RD), 'المعاينة الحيّة مجدولة (مؤجَّلة)');
    chk(/if \(!runId && !hasLegacy\) return;/.test(RD),
    'المعاينة الحيّة تشترط مصدرًا (نتيجة تشغيل أو تقرير قائم) — بلا بيانات مفترضة');
    chk(/id="rs-live"/.test(IDX) && /toggleLive/.test(RD), 'زر المعاينة الحيّة موصول');
    chk(/id="rs-add-shape"/.test(IDX) && /'rs-add-shape': 'shape'/.test(RD), 'زر «شكل» في اللوحة وموصول');
    chk(/window\.confirm\('حذف العنصر/.test(RD), 'حذف العنصر يطلب تأكيدًا');
    chk(/rs-title/.test(RD) && /rs-description/.test(RD) && /rs-title/.test(IDX) && /rs-description/.test(IDX),
      'حقول العنوان/الوصف موجودة في الواجهة وفي التعريف');
  }

  /* ---------- 6) الخادم: مسار مركز العمل + التبويبان ---------- */
  {
    chk(/'GET \/api\/workcenter'/.test(SRV), 'مسار مركز العمل مسجَّل في الخادم');
    chk(/WC\.buildWorkCenter\(/.test(SRV), 'مركز العمل يبني العرض من الوحدة النقية');
    chk(/id: 'analysis'/.test(SRV) && /id: 'report-studio'/.test(SRV)
      && /id: 'screen-studio'/.test(SRV) && !/id: 'workflow'/.test(SRV),
      'الأقسام الثلاثة في قائمة التبويبات (workflow مدموج لا شاشة رابعة)');
  }

  /* ---------- 7) حراسة: لا مسار مكرّر في جدول المسارات (عيب سابق حجب مسار محفوظ) ---------- */
  {
    const start = SRV.indexOf('const routes = {');
    const end = SRV.indexOf('const TAB_API = Policy.TAB_API;');
    chk(start > 0 && end > start, 'جدول المسارات محدَّد في الملف');
    const block = SRV.slice(start, end);
    const keys = [];
    const re = /'((?:GET|POST|PUT|DELETE|PATCH) [^']+)'\s*:/g;
    let m;
    while ((m = re.exec(block)) !== null) keys.push(m[1]);
    const dupes = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
    chk(dupes.length === 0, 'لا مفتاح مسار مكرّر داخل جدول المسارات: ' + JSON.stringify(dupes));
    chk(keys.indexOf('GET /api/reports/saved') >= 0 && keys.indexOf('GET /api/reports') >= 0,
      'مسار قائمة التقارير المحفوظة مستقل عن فهرس التقارير الجاهزة');
    chk(/apiCall\('\/api\/reports\/saved'\)/.test(RD), 'المصمم يطلب التقارير المحفوظة من المسار المستقل');
    chk(!/apiCall\('\/api\/reports'\)/.test(
      fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'workcenter.js'), 'utf8')),
      'مركز العمل يطلب التقارير المحفوظة من المسار المستقل');
    chk(/apiCall\('\/api\/reports'\)/.test(RD),
      'المصمم يقرأ فهرس التقارير القائمة (catalog) عبر مسار الفهرس — منفصل عن المحفوظة');
  }

  chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');
  console.log('\ndesign_upgrade.test.js — pass=' + pass + ' fail=' + fail);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
