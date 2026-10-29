/* ============================================================
 * طبقة تعريف الواجهة القابلة للتحرير — الشاشات والقوائم والتبويبات والأزرار
 * ============================================================
 * المبدأ: كل تعديل = «تجاوز» على عنصر موجود في الواجهة:
 *   • معرّف العنصر ثابت (مسار DOM + نوع) ولا يتغيّر
 *   • الأحداث والوظائف والصلاحيات لا تُمَسّ — تجاوز فقط
 *   • الإخفاء فقط: لا يمكن إظهار ما أخفته الصلاحيات
 *   • الألوان من قوائم بيضاء · الحدود بنمط آمن · الأرقام محدودة
 *   • الأزرار الجديدة تُنشأ من إجراءات مسجَّلة فقط (بلا JavaScript حرّ)
 *   • الحالة الافتراضية تُلتقط عند أول تطبيق ⇒ «إعادة الضبط» تعيدها
 *
 * الوحدة تعمل في Node (module.exports) وفي المتصفح (window.UiLayout).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UiLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- عناصر التنقل (مجموعة ثابتة معرَّفة يدويًا) ---------------- */
  const NAV_ELEMENTS = [
    { id: 'nav:dashboard', type: 'navGroup', group: 'الشريط العلوي', label: 'لوحة التحكم', sel: 'nav button[data-tab="dashboard"]', host: '.nav-drop' },
    { id: 'nav:md', type: 'navGroup', group: 'الشريط العلوي', label: 'البيانات الأساسية', sel: '#nav-md-btn', host: '.nav-drop', allowedProps: ['label','visible','order','color','bg'] },
    { id: 'nav:daily', type: 'navGroup', group: 'الشريط العلوي', label: 'تسجيل البيانات', sel: '#nav-daily-btn', host: '.nav-drop', allowedProps: ['label','visible','order','color','bg'] },
    { id: 'nav:platform', type: 'navGroup', group: 'الشريط العلوي', label: 'منصة التحليل', sel: '#nav-platform-btn', host: '.nav-drop', allowedProps: ['label','visible','order','color','bg'] },

    { id: 'goto:analysis', type: 'navItem', group: 'قائمة منصة التحليل', label: 'البيانات والتحليل', sel: 'nav button[data-goto="analysis"]' },
    { id: 'goto:report-studio', type: 'navItem', group: 'قائمة منصة التحليل', label: 'التقارير ولوحات المعلومات', sel: 'nav button[data-goto="report-studio"]' },
    { id: 'goto:screen-studio', type: 'navItem', group: 'قائمة منصة التحليل', label: 'تصميم الشاشات والتحكم', sel: 'nav button[data-goto="screen-studio"]' },

    /* تصنيفات القائمة الموحدة للتقارير (داخل قسم التقارير — لا قائمة خارجية مكرّرة) */
    { id: 'repgrp:app', type: 'navItem', group: 'تصنيفات التقارير (داخل المنصة)', label: 'تقارير التطبيق', sel: '#rp-app-groups [data-pf-group="app"]' },
    { id: 'repgrp:saved', type: 'navItem', group: 'تصنيفات التقارير (داخل المنصة)', label: 'تقاريري المحفوظة', sel: '#rp-app-groups [data-pf-group="saved"]' },
    { id: 'repgrp:draft', type: 'navItem', group: 'تصنيفات التقارير (داخل المنصة)', label: 'المسودات', sel: '#rp-app-groups [data-pf-group="draft"]' },
    { id: 'repgrp:sales', type: 'navItem', group: 'تصنيفات التقارير (داخل المنصة)', label: 'مبيعات', sel: '#rp-app-groups [data-pf-group="sales"]' },
    { id: 'repgrp:store', type: 'navItem', group: 'تصنيفات التقارير (داخل المنصة)', label: 'مخازن', sel: '#rp-app-groups [data-pf-group="store"]' },
    { id: 'repgrp:bal', type: 'navItem', group: 'تصنيفات التقارير (داخل المنصة)', label: 'أرصدة', sel: '#rp-app-groups [data-pf-group="bal"]' },
    { id: 'repgrp:pbix', type: 'navItem', group: 'تصنيفات التقارير (داخل المنصة)', label: 'Power BI', sel: '#rp-app-groups [data-pf-group="pbix"]' },

    /* عناوين الأقسام (ترويسة الصفحة) */
    { id: 'screen:dashboard', type: 'screen', group: 'عناوين الشاشات', label: 'لوحة التحكم', tab: 'dashboard' },
    { id: 'screen:platform', type: 'screen', group: 'عناوين الشاشات', label: 'منصة التحليل', tab: 'platform' },
    { id: 'screen:analysis', type: 'screen', group: 'عناوين الشاشات', label: 'البيانات والتحليل', tab: 'analysis' },
    { id: 'screen:report-studio', type: 'screen', group: 'عناوين الشاشات', label: 'التقارير ولوحات المعلومات', tab: 'report-studio' },
    { id: 'screen:screen-studio', type: 'screen', group: 'عناوين الشاشات', label: 'تصميم الشاشات والتحكم', tab: 'screen-studio' },
  ];

  /* ---------------- قوائم بيضاء ---------------- */
  const COLORS = [
    { v: '', label: 'الافتراضي' },
    { v: '#5b8cff', label: 'أزرق (الأساسي)' },
    { v: '#22d3ee', label: 'سماوي' },
    { v: '#34d399', label: 'أخضر' },
    { v: '#fbbf24', label: 'كهرماني' },
    { v: '#fb7185', label: 'وردي' },
    { v: '#a78bfa', label: 'بنفسجي' },
    { v: '#e9eefb', label: 'أبيض نصّي' },
    { v: '#94a3b8', label: 'رمادي' },
  ];
  const COLOR_VALUES = new Set(COLORS.map(c => c.v).filter(Boolean));

  const MAX_LABEL = 60;
  const MAX_ITEMS = 1200;

  /* خصائص قابلة للتحرير حسب نوع العنصر */
  const KIND_PROPS = {
    text: ['label', 'visible', 'order', 'color', 'fontSize', 'align', 'bold'],
    card: ['visible', 'order', 'bg', 'border', 'radius', 'padding'],
    table: ['visible', 'order', 'color', 'fontSize', 'align', 'width'],
    button: ['label', 'visible', 'order', 'color', 'bg', 'fontSize', 'radius', 'action'],
    field: ['label', 'visible', 'order', 'color', 'fontSize'],
    input: ['visible', 'order', 'width', 'color'],
    navGroup: ['label', 'visible', 'order', 'color'],
    navItem: ['label', 'visible', 'order', 'color'],
    screen: ['label', 'visible'],
  };

  const ALIGN_VALUES = new Set(['start', 'center', 'end', 'justify']);
  const BORDER_RE = /^(?:none|(?:\d{1,3}px\s+)?(?:solid|dashed|dotted)\s+#[0-9a-fA-F]{3,8})$/;

  /* ---------------- أدوات التطبيع ---------------- */
  const cleanLabel = v => String(v === undefined || v === null ? '' : v).trim().slice(0, MAX_LABEL);
  const clampInt = (v, lo, hi, def) => {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n)) return def;
    return Math.max(lo, Math.min(hi, n));
  };
  const cleanColor = v => (COLOR_VALUES.has(String(v)) ? String(v) : '');
  const cleanBorder = v => {
    const s = String(v === undefined || v === null ? '' : v).trim();
    return BORDER_RE.test(s) ? s : '';
  };
  const cleanAlign = v => (ALIGN_VALUES.has(String(v)) ? String(v) : '');

  /* ---------------- اكتشاف عناصر الشاشات (آلي لكل الشاشات) ----------------
     الأنواع: عنوان/نص · بطاقة · جدول · زر · تسمية حقل (field) · حقل إدخال (input)
     «field» = وسم <label> الذي يحمل نص الفاتورة/الفلتر ⇒ تغيير الاسم يتم منه.
     «input» = عنصر الإدخال نفسه (إظهار/ترتيب/عرض) بلا تعديل وظيفته. */
  const EDITABLE = [
    { kind: 'text', sel: 'h3, h4', label: 'عنوان' },
    { kind: 'text', sel: '.card-h .muted, .card-h .muted.xs, .hint', label: 'نص توضيحي' },
    { kind: 'card', sel: '.card', label: 'بطاقة' },
    { kind: 'table', sel: 'table', label: 'جدول' },
    { kind: 'button', sel: 'button', label: 'زر' },
    { kind: 'field', sel: 'label', label: 'اسم حقل' },
    { kind: 'input', sel: 'input, select, textarea', label: 'حقل إدخال' },
  ];

  const $ = s => (typeof document !== 'undefined' && typeof document.querySelector === 'function') ? document.querySelector(s || '*') : null;
  const $$ = s => (typeof document !== 'undefined' ? Array.from(document.querySelectorAll(s)) : []);

  /** يكتشف عناصر كل شاشة: [{id, kind, label, screen, el}] — المعرّف ثابت (ترتيب DOM) */
  function discover() {
    const out = [];
    if (typeof document === 'undefined') return out;
    const sections = Array.from(document.querySelectorAll('section[id^="tab-"]'));
    for (const sec of sections) {
      const screen = sec.id.replace(/^tab-/, '');
      const head = sec.querySelector('.card-h h3') || sec.querySelector('h3');
      const screenLabel = (head ? head.textContent : screen).trim() || screen;
      const counters = {};
      for (const rule of EDITABLE) {
        let nodes = [];
        try { nodes = Array.from(sec.querySelectorAll(rule.sel)); } catch (e) { nodes = []; }
        for (const el of nodes) {
          if (typeof el.closest === 'function') {
            if (el.closest('.nav-tools')) continue;
            if (el.closest('[data-ui-exclude]')) continue;
          }
          if (el.dataset && el.dataset.uiCreated) continue;      /* أزرار مُنشأة (تُدار منفصلة) */
          const k = rule.kind;
          counters[k] = (counters[k] || 0) + 1;
          out.push({
            id: 'sc:' + screen + ':' + k + ':' + counters[k],
            kind: k, screen, screenLabel,
            label: (el.textContent || '').trim().slice(0, 60) || rule.label,
            el,
          });
        }
      }
    }
    return out;
  }

  /* خريطة المعرّف ← العنصر (تُبنى عند الاكتشاف) */
  let index = new Map();
  let defaults = null;      /* الحالة الافتراضية الملتقطة */
  let model = { items: {} };
  let styleEl = null;

  function buildIndex() {
    index = new Map();
    for (const d of discover()) index.set(d.id, d);
    for (const el of NAV_ELEMENTS) {
      const node = $(el.sel);
      if (node) index.set(el.id, { id: el.id, kind: el.type, screen: 'nav', screenLabel: el.group, label: el.label, el: node, nav: el });
    }
    return index;
  }

  const NAV_DEF = new Map(NAV_ELEMENTS.map(e => [e.id, e]));
  const isNav = id => NAV_DEF.has(id);

  /** ملتقط الحالة الافتراضية (النص · الأنماط المدارة · الإظهار · الترتيب) */
  const MANAGED_STYLE = ['color', 'background', 'border', 'borderRadius', 'padding', 'fontSize', 'textAlign', 'width', 'height', 'fontWeight'];
  function captureDefaults() {
    if (defaults) return defaults;
    defaults = {};
    buildIndex();
    /* التسلسل الأصلي لأبناء كل حاوية — يُلتقط قبل أي ترتيب ⇒ «إعادة الضبط» تعيده */
    defaults.__order = new Map();
    for (const [id, d] of index) {
      const el = d.el;
      const style = {};
      for (const p of MANAGED_STYLE) style[p] = el.style[p] || '';
      const txt = textTarget(d);
      const textParent = txt && txt.parentNode && txt.parentNode.style ? txt.parentNode : null;
      defaults[id] = {
        label: txt ? (txt.nodeValue || '').trim() : '',
        display: el.style.display || '',
        order: el.style.order || '',
        style,
        /* أنماط عقدة النص (span داخل الأزرار) — لازمة لإرجاع اللون/الحجم/السُمك عند الإزالة */
        textStyle: textParent ? {
          color: textParent.style.color || '',
          fontSize: textParent.style.fontSize || '',
          fontWeight: textParent.style.fontWeight || '',
        } : null,
      };
    }
    return defaults;
  }

  /** العقدة النصية القابلة للتعديل في العنصر (بدون المساس بالعناصر المتداخلة) */
  function textTarget(d) {
    const el = d.el; if (!el) return null;
    /* الأزرار (وأزرار الشريط) ⇒ النص داخل <span> */
    if (d.kind === 'button' || d.kind === 'navGroup' || d.kind === 'navItem') {
      const span = (typeof el.querySelector === 'function') ? el.querySelector('span') : null;
      if (span) {
        for (const n of span.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return n;
        return span.firstChild;
      }
    }
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return n;
    return null;
  }

  /** كل العناصر القابلة للتحرير (تنقّل + شاشات) */
  function allElements() {
    buildIndex();
    return Array.from(index.values());
  }

  /** الشاشات المكتشفة */
  function screens() {
    const seen = new Map();
    for (const d of allElements()) {
      if (d.screen === 'nav') continue;
      if (!seen.has(d.screen)) seen.set(d.screen, { id: d.screen, label: d.screenLabel, count: 0 });
      seen.get(d.screen).count++;
    }
    return Array.from(seen.values());
  }

  /* ---------------- التطبيع (نقي — قابل للاختبار) ---------------- */
  function normalizeItem(def, raw) {
    const props = KIND_PROPS[def.kind] || [];
    const item = {};
    for (const p of props) {
      const v = raw[p];
      if (v === undefined || v === null) continue;
      if (p === 'label') { const s = cleanLabel(v); if (s) item.label = s; }
      else if (p === 'visible') { if (v === false) item.visible = false; }
      else if (p === 'order') { if (Number.isFinite(Number(v))) item.order = Math.trunc(Number(v)); }
      else if (p === 'color' || p === 'bg') { const c = cleanColor(v); if (c) item[p] = c; }
      else if (p === 'border') { const b = cleanBorder(v); if (b) item.border = b; }
      else if (p === 'radius' || p === 'padding') { item[p] = clampInt(v, 0, 48, 12); }
      else if (p === 'fontSize') { item[p] = clampInt(v, 8, 48, 14); }
      else if (p === 'align') { const a = cleanAlign(v); if (a) item.align = a; }
      else if (p === 'width' || p === 'height') { item[p] = clampInt(v, 10, 100, 100); }
      else if (p === 'bold') { item.bold = v === true; }
      else if (p === 'action') { const a = String(v).slice(0, 60); if (a) item.action = a; }
    }
    return item;
  }

  /**
   * يطبّق نموذج التخطيط: عناصر معروفة فقط · نصوص محدودة · ألوان بيضاء.
   * @param {object} raw {items:{id:{...}}}
   */
  function normalizeLayout(raw) {
    const out = { items: {} };
    const src = (raw && raw.items && typeof raw.items === 'object') ? raw.items : {};
    buildIndex();
    let n = 0;
    for (const id of Object.keys(src)) {
      if (n >= MAX_ITEMS) break;
      const it = src[id];
      if (!it || typeof it !== 'object') continue;
      if (id.indexOf('new:') === 0) {
        /* زر جديد: يُنشأ بإجراء مسجَّل */
        const action = String(it.action || '').slice(0, 60);
        if (!action) continue;
        const item = { new: true, screen: String(it.screen || '').slice(0, 60), action, label: cleanLabel(it.label) };
        if (it.color) item.color = cleanColor(it.color);
        if (it.bg) item.bg = cleanColor(it.bg);
        if (it.fontSize !== undefined) item.fontSize = clampInt(it.fontSize, 8, 48, 13);
        if (it.visible === false) item.visible = false;
        if (Number.isFinite(Number(it.order))) item.order = Math.trunc(Number(it.order));
        out.items[id] = item;
        n++;
        continue;
      }
      const def = index.get(id);
      if (!def) continue;
      const item = normalizeItem(def, it);
      if (Object.keys(item).length) { out.items[id] = item; n++; }
    }
    return out;
  }

  /* ---------------- إنشاء الأزرار الجديدة ---------------- */
  function createdButtons() {
    return Object.entries(model.items || {}).filter(([id, it]) => it && it.new);
  }
  function makeButton(id, it) {
    const b = document.createElement('button');
    b.className = 'btn sm ui-added-btn';
    b.type = 'button';
    b.dataset.uiCreated = '1';
    b.dataset.uiAction = it.action;
    const span = document.createElement('span');
    span.textContent = it.label || it.action;
    b.appendChild(span);
    b.title = 'زر مُضاف من مصمم الشاشات — الإجراء: ' + it.action;
    return b;
  }

  /* ---------------- التطبيق على الواجهة ---------------- */

  /** ما يُخفى فعليًا عند إخفاء عنصر:
      إخفاء تسمية حقل (label) ⇒ تُخفى عناصر الإدخال داخلها أيضًا (حقل + فلت��). */
  function hideTargets(d, el) {
    const out = [el];
    if (!el) return out;
    if (d && d.kind === 'field' && typeof el.querySelector === 'function') {
      const c = el.querySelector('input, select, textarea');
      if (c) out.push(c);
    }
    return out;
  }

  function applyStyle(item, el, defs, def) {
    const d = defs || {};
    const orig = (d.style || {});
    const set = (prop, val, origVal) => {
      if (val === undefined || val === null || val === '') { el.style[prop] = origVal || ''; return; }
      el.style[prop] = val;
    };
    set('color', item.color, orig.color);
    set('background', item.bg, orig.background);
    set('border', item.border, orig.border);
    set('borderRadius', item.radius !== undefined ? item.radius + 'px' : '', orig.borderRadius);
    set('padding', item.padding !== undefined ? item.padding + 'px' : '', orig.padding);
    set('fontSize', item.fontSize !== undefined ? item.fontSize + 'px' : '', orig.fontSize);
    set('textAlign', item.align || '', orig.textAlign);
    set('width', item.width !== undefined ? item.width + '%' : '', orig.width);
    set('fontWeight', item.bold ? '700' : '', orig.fontWeight);
    // apply color/font to text target as well for better readability
    const tt = (def && typeof textTarget === 'function') ? textTarget(def) : null;
    if (tt && tt.parentNode) {
      const tpar = tt.parentNode;
      const ts = (d && d.textStyle) || {};
      if (item.color !== undefined && item.color !== null && item.color !== '') tpar.style.color = item.color;
      else tpar.style.color = ts.color || '';
      if (item.fontSize !== undefined && item.fontSize !== null && item.fontSize !== '') tpar.style.fontSize = item.fontSize + 'px';
      else tpar.style.fontSize = ts.fontSize || '';
      if (item.bold) tpar.style.fontWeight = '700';
      else tpar.style.fontWeight = ts.fontWeight || '';
    }
  }

  /**
   * ترتيب حقيقي داخل الحاوية: يُحسب الترتيب الهدف من التسلسل الأصلي
   * (مع ترتيب مستقر حسب قيمة order) ثم تُستبدل(Node) العناصر في خاناتها.
   * استبدال_NODE يحافظ على أحداثه (الأحداث على العنصر نفسه) ⇒ لا يُفقد أي ربط.
   */
  function applyContainerOrders() {
    const groups = new Map();
    for (const [id, d] of index) {
      const it = model.items[id];
      if (!it || it.order === undefined || it.order === null) continue;
      const el = d.el;
      const parent = el && el.parentElement;
      if (!parent) continue;
      if (!groups.has(parent)) groups.set(parent, new Map());
      groups.get(parent).set(el, Number(it.order) || 0);
    }
    /* الحاويات: كل ما تم التقاطه (لإعادة الضبط) + ما فيه تجاوز ترتيب الآن */
    const containers = new Set();
    if (defaults && defaults.__order) for (const p of defaults.__order.keys()) containers.add(p);
    for (const p of groups.keys()) containers.add(p);
    for (const parent of containers) {
      const orders = groups.get(parent) || new Map();
      const orig = (defaults && defaults.__order && defaults.__order.get(parent)) || Array.from(parent.children);
      const origIndex = new Map(orig.map((k, i) => [k, i]));
      const movableSet = new Set(orders.keys());
      /* الترتيب الهدف: نفس مواضع العناصر القابلة للتحريك، بعد فرزها stably حسب order
         (وبلا تجاوزات ⇒ يعود التسلسل الأصلي) */
      const sortedMovable = orig.filter(k => movableSet.has(k)).slice().sort((a, b) => {
        const oa = orders.has(a) ? orders.get(a) : origIndex.get(a);
        const ob = orders.has(b) ? orders.get(b) : origIndex.get(b);
        if (oa !== ob) return oa - ob;
        return origIndex.get(a) - origIndex.get(b);
      });
      let mi = 0;
      const finalOrder = orig.map(k => (movableSet.has(k) ? sortedMovable[mi++] : k));
      /* appendChild ينقل العنصر من موضعه ⇒ النتيجة = الترتيب النهائي بلا تكرار */
      for (const node of finalOrder) {
        if (!node) continue;
        try { if (parent.children && parent.children.indexOf(node) < 0) continue; } catch (e) { continue; }
        parent.appendChild(node);
      }
    }
  }

  function apply(layout) {
    model = normalizeLayout(layout || model);
    if (typeof document === 'undefined') return model;
    const defs = captureDefaults();
    buildIndex();
    /* التقاط التسلسل الأصلي قبل أي ترتيب (مرة واحدة) */
    if (defs && defs.__order && defs.__order.size === 0) {
      for (const [, d] of index) {
        const el = d.el;
        const parent = el && el.parentElement;
        if (!parent) continue;
        if (!defs.__order.has(parent)) defs.__order.set(parent, Array.from(parent.children));
      }
    }

    /* 1) الأزرار الجديدة (تُنشأ أولًا) */
    for (const [id, it] of createdButtons()) {
      let el = (typeof document.getElementById === 'function') ? document.getElementById(id) : null;
      if (!el) {
        const sec = it.screen ? document.getElementById('tab-' + it.screen) : null;
        const host = sec ? (sec.querySelector('.wf-toolbar') || sec.querySelector('.card')) : null;
        if (!host) continue;
        el = makeButton(id, it);
        el.id = id;
        host.appendChild(el);
      }
      const span = (typeof el.querySelector === 'function') ? el.querySelector('span') : null;
      if (span && it.label) span.textContent = it.label;
      applyStyle(it, el, {}, { el, kind: 'button' });
    }

    /* 2) العناصر المكتشفة + عناصر التنقل */
    for (const [id, d] of index) {
      const el = d.el;
      if (!el) continue;
      const it = model.items[id];
      const def = defs[id] || {};
      const target = textTarget(d);
      /* marker فقط للعناصر المعدَّلة (حجم أقل من الكتابة على كل عنصر) */
      if (it) { try { el.dataset.uiId = id; } catch (e) { /* تجاهل */ } }

      /* النص */
      if (target) {
        if (it && it.label !== undefined) target.nodeValue = it.label;
        else if (def.label) target.nodeValue = def.label;
      }
      /* الخصائص البصرية */
      applyStyle(it || {}, el, def, d);
      /* الإخفاء: فقط — والاستعادة بالقيمة الأصلية (صلاحية محفوظة) */
      const host = (d.nav && d.nav.host) ? ((typeof el.closest === 'function' ? el.closest(d.nav.host) : null) || el) : el;
      if (it && it.visible === false) {
        for (const t of hideTargets(d, host)) {
          if (!t.dataset.uiHiddenOrig) t.dataset.uiHiddenOrig = t.style.display || '';
          t.style.display = 'none';
          t.dataset.uiHidden = '1';
        }
      } else if (host.dataset.uiHidden === '1') {
        for (const t of hideTargets(d, host)) {
          if (t.dataset.uiHidden !== '1') continue;
          t.style.display = t.dataset.uiHiddenOrig || '';
          delete t.dataset.uiHidden;
          delete t.dataset.uiHiddenOrig;
        }
      }
      /* الترتيب: يُنفَّذ فعليًا داخل الحاوية (انظر applyContainerOrders) */
      if (it && it.order !== undefined) el.style.order = String(it.order);
      else if (d.nav === undefined) el.style.order = def.order || '';
    }

    /* 3) الترتيب الحقيقي داخل الحاويات (الشريط · القوائم · عناصر الشاشة) */
    try { applyContainerOrders(); } catch (e) { /* لا يمنع التطبيق */ }
    return model;
  }

  /** عنوان الشاشة بعد التجاوز (تستخدمه app.js عند عرض الترويسة) */
  function titleFor(tabId) {
    const def = NAV_ELEMENTS.find(e => e.type === 'screen' && e.tab === tabId);
    if (def) { const it = model.items[def.id]; return (it && it.label) ? it.label : ''; }
    for (const [id, d] of index) {
      if (d.kind === 'text' && d.screen === tabId) {
        const it = model.items[id];
        if (it && it.label) return it.label;
      }
    }
    return '';
  }

  /** نموذج مبدئي من الحالة الافتراضية (للمحرّر) */
  function baseline() {
    const out = { items: {} };
    const defs = captureDefaults();
    for (const [id, d] of index) {
      const def = defs[id] || {};
      out.items[id] = {
        label: d.label || def.label || '',
        visible: true,
        order: 0,
        color: '',
        bg: '',
        border: '',
        radius: undefined,
        padding: undefined,
        fontSize: undefined,
        align: '',
        width: undefined,
        bold: false,
      };
    }
    return out;
  }

  function current() { return JSON.parse(JSON.stringify(model)); }
  function setModel(m) { model = normalizeLayout(m); return model; }
  function itemFor(id) { return model.items[id] || null; }
  function isLoaded() { return !!defaults; }
  function reset() { defaults = null; index = new Map(); model = { items: {} }; }

  return {
    NAV_ELEMENTS, COLORS, KIND_PROPS, MAX_LABEL, MAX_ITEMS,
    discover, allElements, screens, buildIndex, captureDefaults, applyContainerOrders,
    normalizeLayout, cleanLabel, apply, titleFor, baseline, current, setModel, itemFor, isLoaded, reset,
  };
});
