'use strict';
/**
 * اختبارات اكتمال الربط + حدود الصفوف + الفلاتر الموروثة — معزولة تماماً
 * =========================================================================
 * الهدف: ألا تُعرض مجاميع ناقصة باعتبارها صحيحة.
 * حالات: بيانات أقل من الحد · عند الحد · تتجاوزه · مفاتيح غير متطابقة · مفاتيح مكررة ·
 *         علاقات متعددة القيم · فلاتر زمنية موروثة.
 */
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const W = require('../../src/workflow');
const D = require('../../src/datasets');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

console.log('== اكتمال الربط + حدود الصفوف + الفلاتر الموروثة ==');

(async () => {

/* ---------- 1) حالة الاكتمال في خطوة join ---------- */
{
  const run = (rightRows, leftRows, extra) => {
    const wf = {
      name: 'j', source: { type: 'memory', name: 'synthetic' },
      steps: [Object.assign({ id: 'j1', type: 'join', leftKey: 'item', rightKey: 'item', joinType: 'left', rightRows }, extra || {})],
    };
    return W.executeWorkflow(wf, { rows: leftRows, columns: ['item'] });
  };

  /* (أ) الطرف الأيمن كامل ⇒ مكتمل */
  const okRes = run([{ item: 'A', v: 1 }], [{ item: 'A' }], { rightTruncated: false });
  chk(okRes.ok && okRes.trace[0].completeness === 'complete', 'طرف أيمن كامل ⇒ اكتمال «مكتمل»');
  chk(!(okRes.trace[0].warnings || []).length, 'لا تحذير في الحالة المكتملة');

  /* (ب) الطرف الأيمن مقتطع، وكل مفاتيح اليسار مطابقة، ولا تكرار ⇒ النتيجة غير متأثرة */
  const provable = run([{ item: 'A', v: 1 }], [{ item: 'A' }], { rightTruncated: true, rightLimit: 5000 });
  chk(provable.trace[0].completeness === 'possibly-truncated', 'اقتطاع مع إثبات عدم التأثير ⇒ «تحذير احتمال الاقتطاع»');
  chk((provable.trace[0].warnings || []).some(w => /غير متأثرة/.test(w)), 'تحذير يوضّح أن النتيجة غير متأثرة');

  /* (ج) الطرف الأيمن مقتطع ومفتاح يسار بلا مطابقة ⇒ غير مكتمل */
  const lost = run([{ item: 'B', v: 1 }], [{ item: 'A' }], { rightTruncated: true, rightLimit: 5000 });
  chk(lost.trace[0].completeness === 'incomplete', 'اقتطاع بلا إثبات ⇒ «غير مكتمل»');
  chk((lost.trace[0].warnings || []).some(w => /لا يجوز الاعتماد على مجاميع/.test(w)), 'تحذير صريح: لا يجوز الاعتماد على المجاميع');

  /* (د) مفتاح مكرر في الطرف الأيمن في علاقة متعدد-إلى-واحد ⇒ تضخيم */
  const dup = run([{ item: 'A', v: 1 }, { item: 'A', v: 2 }], [{ item: 'A' }], { relation: 'many-to-one' });
  chk(dup.trace[0].completeness === 'incomplete', 'مفتاح غير فريد في علاقة متعدد-إلى-واحد ⇒ «غير مكتمل»');
  chk(dup.rows.length === 2, 'التكرار يضخّم الصفوف فعلًا (' + dup.rows.length + ')');
  chk((dup.trace[0].warnings || []).some(w => /تضخيم المجاميع/.test(w)), 'تحذير تضخيم المجاميع');

  /* (هـ) نفس التكرار في علاقة متعددة القيم ⇒ سلوك متوقّع (ليس خطأ) */
  const mm = run([{ item: 'A', v: 1 }, { item: 'A', v: 2 }], [{ item: 'A' }], { relation: 'many-to-many' });
  chk(mm.trace[0].completeness === 'complete', 'تكرار متوقّع في علاقة متعددة القيم ⇒ يبقى «مكتمل»');
  chk((mm.trace[0].warnings || []).some(w => /متوقّع/.test(w)), 'ملاحظة (لا خطأ) توضح أن التكرار متوقّع');
  chk(mm.rows.length === 2, 'التعدد المتوقّع يبقى في الصفوف');

  /* (و) مفاتيح غير متطابقة مع inner ⇒ صفوف تُسقط (سلوك صحيح) */
  const innerWf = {
    name: 'j', source: { type: 'memory', name: 'synthetic' },
    steps: [{ id: 'j1', type: 'join', leftKey: 'item', rightKey: 'item', joinType: 'inner', rightRows: [{ item: 'B', v: 1 }] }],
  };
  const inner = W.executeWorkflow(innerWf, { rows: [{ item: 'A' }], columns: ['item'] });
  chk(inner.ok && inner.rows.length === 0, 'inner بلا مطابقة ⇒ لا صفوف (سلوك صحيح)');
}

/* ---------- 2) اكتشاف الاقتطاع في مصدر الطرف الأيمن (مصدر وهمي) ---------- */
{
  const fakeId = 'fake_join_source';
  const calls = [];
  D.DATASETS[fakeId] = {
    label: 'مصدر وهمي', perm: 'sync', domain: 'test', description: '', grain: 'صنف', rowKey: ['item'],
    timeGrain: 'daily', canonical: false,
    columns: ['item', 'v'], types: { item: 'string', v: 'number' },
    descriptions: { item: 'صنف', v: 'قيمة' },
    fetch: st => { calls.push(st); return Array.from({ length: st.limit }, (_, i) => ({ item: 'S' + i, v: i })); },
  };
  const me = { role: 'admin', active: true, perms: ['sync'] };
  const r = await D.resolveJoinSource(fakeId, me, { from: '2026-01-01', to: '2026-03-31', days: 90 });
  chk(r.ok && r.truncated === true, 'مصدر بلغ الحد ⇒ truncated=true');
  chk(r.limit === D.ROW_LIMIT, 'الحد لم يُرفع (يبقى ' + D.ROW_LIMIT + ')');
  chk(calls[0].from === '2026-01-01' && calls[0].to === '2026-03-31' && calls[0].days === 90,
    'الفلاتر الزمنية (from/to/days) تُورَّث للطرف الأيمن');
  chk(calls[0].F && calls[0].F.from === '2026-01-01', 'الفلاتر تُمرَّر أيضًا داخل F (لدوال analytics)');

  /* مصدر أصغر من الحد ⇒ لا اقتطاع */
  D.DATASETS[fakeId].fetch = st => { calls.push(st); return [{ item: 'A', v: 1 }]; };
  const r2 = await D.resolveJoinSource(fakeId, me, {});
  chk(r2.ok && r2.truncated === false, 'مصدر أصغر من الحد ⇒ لا اقتطاع');

  delete D.DATASETS[fakeId];
}

/* ---------- 3) prepareWorkflow ينقل حالة الاقتطاع ونوع العلاقة ---------- */
{
  const resolver = async (name, step) => ({
    ok: true, rows: [{ item: 'A', v: 1 }], columns: ['item', 'v'],
    label: 'مصدر وهمي', grain: 'صنف', limit: 5000, truncated: true,
  });
  const prep = await W.prepareWorkflow({
    name: 't', source: { type: 'memory', name: 'synthetic' },
    steps: [{ id: 'j1', type: 'join', rightSource: 'fake', leftKey: 'item', rightKey: 'item' }],
  }, resolver);
  const st = prep.workflow.steps[0];
  chk(st.rightTruncated === true && st.rightLimit === 5000, 'prepareWorkflow ينقل حالة الاقتطاع والحد');
  chk(st.relation === 'many-to-one', 'نوع العلاقة الافتراضي: متعدد-إلى-واحد');
  chk(prep.notes.some(n => /بلغ حد الصفوف/.test(n)), 'ملاحظة واضحة عن احتمال الاقتطاع');
}

/* ---------- 4) حدود الحماية لم تُخفَّض ---------- */
{
  chk(D.ROW_LIMIT === 5000, 'حد الصفوف في الذاكرة ثابت (' + D.ROW_LIMIT + ')');
  chk(W.STEP_TYPES.includes('join'), 'خطوة الربط ما زالت موجودة');
}

chk(guard.count() === 0, 'صفر اتصال شبكة (' + guard.count() + ')');
console.log('\njoin_completeness.test.js — pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
