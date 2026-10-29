'use strict';
/* رسوم بيانية SVG خفيفة — بدون أي مكتبات خارجية (تعمل دون إنترنت) */

const NS = 'http://www.w3.org/2000/svg';
const el = (n, attrs = {}) => { const e = document.createElementNS(NS, n); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const fmtN = (n, d = 0) => (n === null || n === undefined || isNaN(n)) ? '—'
  : new Intl.NumberFormat('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 }).format(n);
const fmtC = n => Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(2) + ' مليار'
  : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + ' مليون'
  : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + ' ألف' : fmtN(n);

let uid = 0;

/** خطوط شبكة + محور */
function grid(svg, W, H, pad, iw, ih, min, max, fmt) {
  for (let i = 0; i <= 4; i++) {
    const gy = pad.t + ih - (ih * i / 4);
    svg.appendChild(el('line', { x1: pad.l, x2: W - pad.r, y1: gy, y2: gy, class: 'grid-line' }));
    const t = el('text', { x: pad.l - 7, y: gy + 3, 'text-anchor': 'end' });
    t.textContent = fmt(min + (max - min) * i / 4);
    svg.appendChild(t);
  }
}

/** تدرّج لوني متكرر في التعريفات */
function defsGradient(svg, color, id, vertical = true) {
  const defs = el('defs');
  const g = el('linearGradient', { id, x1: 0, y1: 0, x2: vertical ? 0 : 1, y2: vertical ? 1 : 0 });
  g.appendChild(el('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': .45 }));
  g.appendChild(el('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }));
  defs.appendChild(g);
  svg.appendChild(defs);
}

/** رسم أعمدة رأسية */
function barChart(host, data, { x, y, label, color = '#5b8cff', fmt = fmtC, height = 230, maxBars = 24 } = {}) {
  host.innerHTML = '';
  const rows = data.slice(0, maxBars);
  if (!rows.length) { host.innerHTML = '<div class="muted">لا توجد بيانات</div>'; return; }
  const W = host.clientWidth || 600, H = height, pad = { t: 16, r: 8, b: 46, l: 58 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const vals = rows.map(r => Number(r[y]) || 0);
  const max = Math.max(...vals.map(Math.abs), 1);
  const gid = 'bg' + (++uid);
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, height: H });
  defsGradient(svg, typeof color === 'function' ? '#5b8cff' : color, gid);
  grid(svg, W, H, pad, iw, ih, 0, max, fmtC);
  const bw = iw / rows.length;
  rows.forEach((r, i) => {
    const v = Number(r[y]) || 0;
    const h = Math.max(2, Math.abs(v) / max * ih);
    const bx = pad.l + i * bw + bw * 0.18, by = pad.t + ih - h;
    const c = typeof color === 'function' ? color(r, i) : color;
    const rect = el('rect', {
      x: bx, y: by, width: bw * 0.64, height: h, rx: Math.min(6, bw * 0.2),
      fill: c, opacity: .92,
    });
    rect.style.cssText = 'transition:opacity .2s';
    rect.addEventListener('mouseenter', () => rect.setAttribute('opacity', '1'));
    rect.addEventListener('mouseleave', () => rect.setAttribute('opacity', '.92'));
    const title = el('title'); title.textContent = `${r[label || x]}: ${fmt(v)}`; rect.appendChild(title);
    svg.appendChild(rect);
    const t = el('text', { x: bx + bw * 0.32, y: H - pad.b + 15, 'text-anchor': 'middle' });
    t.textContent = String(r[x]).length > 9 ? String(r[x]).slice(0, 9) + '…' : r[x];
    t.setAttribute('transform', `rotate(-30 ${bx + bw * 0.32} ${H - pad.b + 15})`);
    svg.appendChild(t);
  });
  svg.appendChild(el('line', { x1: pad.l, x2: W - pad.r, y1: pad.t + ih, y2: pad.t + ih, class: 'axis-line' }));
  host.appendChild(svg);
}

/** أعمدة أفقية (للترتيب حسب مكان/صنف) */
function hBarChart(host, data, { label, value, fmt = fmtC, color, maxBars = 12 } = {}) {
  host.innerHTML = '';
  const rows = data.slice(0, maxBars);
  if (!rows.length) { host.innerHTML = '<div class="muted">لا توجد بيانات</div>'; return; }
  const max = Math.max(...rows.map(r => Math.abs(Number(r[value]) || 0)), 1);
  const wrap = document.createElement('div');
  wrap.className = 'hbar';
  rows.forEach((r, i) => {
    const v = Number(r[value]) || 0;
    const row = document.createElement('div');
    row.className = 'row-b';
    const name = document.createElement('div');
    name.className = 'nm';
    name.title = r[label]; name.textContent = r[label];
    const bar = document.createElement('div');
    bar.className = 'tr';
    const fill = document.createElement('i');
    const c = typeof color === 'function' ? color(r, i) : (color || null);
    fill.style.width = '2%';
    if (c) fill.style.background = c;
    bar.appendChild(fill);
    const num = document.createElement('div');
    num.className = 'vl';
    num.textContent = fmt(v);
    row.append(name, bar, num);
    wrap.appendChild(row);
    requestAnimationFrame(() => { fill.style.width = Math.max(2, Math.abs(v) / max * 100) + '%'; });
  });
  host.appendChild(wrap);
}

/** خط بياني متعدد السلاسل مع تعبئة متدرجة.
 *  zero=false: يضغط المحور الصادي على مدى البيانات الفعلي بدل البدء من الصفر —
 *  فتظهر الفروق الصغيرة (القروش والسنات) بين التسجيلات بوضوح. */
function lineChart(host, series, { height = 250, fmt = fmtC, area = true, zero = true } = {}) {
  host.innerHTML = '';
  if (!series.length || !series[0].points.length) { host.innerHTML = '<div class="muted">لا توجد بيانات</div>'; return; }
  const W = host.clientWidth || 600, H = height;
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const labels = series[0].points.map(p => p.x);
  const hasDate = labels.some(lb => ISO.test(String(lb)));
  /* عناوين التاريخ تُعرض رأسياً «يوم-شهر» — حيز سفلي أعمق كي لا تلامس منحنى الرسم */
  const pad = { t: 16, r: 12, b: hasDate ? 72 : 42, l: 62 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const all = series.flatMap(s => s.points.map(p => Number(p.y) || 0));
  let min, max;
  if (zero) {
    min = Math.min(...all, 0);
    max = Math.max(...all.map(Math.abs), 1);
  } else {
    min = Math.min(...all);
    max = Math.max(...all);
    if (min === max) { min -= 1; max += 1; }          // خط مسطّح تماماً
    const padY = (max - min) * 0.08 || Math.abs(max) * 0.02 || 1;
    min -= padY; max += padY;
  }
  const px = i => pad.l + (labels.length > 1 ? i * iw / (labels.length - 1) : iw / 2);
  const py = v => pad.t + ih - ((v - min) / (max - min || 1)) * ih;
  const gid = 'lg' + (++uid);
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, height: H });

  // تدرّج خطي أفقي للمحور
  const defs = el('defs');
  const lg = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 1, y2: 0 });
  series.forEach((s, i) => lg.appendChild(el('stop', { offset: (i / Math.max(1, series.length - 1) * 100) + '%', 'stop-color': s.color })));
  defs.appendChild(lg);
  svg.appendChild(defs);

  grid(svg, W, H, pad, iw, ih, min, max, fmt);

  /* سماكة الرأسية ~12px والتاريخ يُعرض يوم-شهر فقط — نُخفف الخطوة فقط إذا ضاق المكان:
     كلما زادت النقاط تُعرض كلها ما دامت متباعدة بلا تداخل */
  /* العنوان الرأسي «يوم-شهر» يشغل أفقياً قدر ارتفاع النص (~11px) ويكفيه ~20px حتى لا يتراكم */
  const step = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(iw / (hasDate ? 20 : 34)))));
  labels.forEach((lb, i) => {
    if (i % step) return;
    const s = String(lb), isDate = ISO.test(s);
    const tx = px(i), ty = H - pad.b + (isDate ? 15 : 17);
    /* التاريخ: «2026-10-12» ← «12-10» رأسي بقراءة من أعلى لأسفل — anchor=end
       يجعل النص يتدلى أسفل خط المحور فلا يلامس منحنى الرسم إطلاقاً */
    const t = el('text', { x: tx, y: ty, 'text-anchor': isDate ? 'end' : 'middle' });
    t.textContent = isDate ? (s.slice(8, 10) + '-' + s.slice(5, 7)) : s;
    if (isDate) t.setAttribute('transform', `rotate(-90 ${tx} ${ty})`);
    svg.appendChild(t);
  });

  series.forEach(s => {
    const pts = s.points.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(Number(p.y) || 0).toFixed(1)}`).join(' ');
    if (area) {
      const areaD = pts + ` L${px(s.points.length - 1).toFixed(1)},${(pad.t + ih).toFixed(1)} L${px(0).toFixed(1)},${(pad.t + ih).toFixed(1)} Z`;
      const ag = 'a' + (++uid);
      const defsA = el('defs');
      const g = el('linearGradient', { id: ag, x1: 0, y1: 0, x2: 0, y2: 1 });
      g.appendChild(el('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': .30 }));
      g.appendChild(el('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0 }));
      defsA.appendChild(g);
      svg.appendChild(defsA);
      svg.appendChild(el('path', { d: areaD, fill: `url(#${ag})`, stroke: 'none' }));
    }
    const path = el('path', { d: pts, fill: 'none', stroke: s.color, 'stroke-width': 2.4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    svg.appendChild(path);
    // حركة رسم الخط
    try {
      const len = path.getTotalLength();
      path.setAttribute('stroke-dasharray', len);
      path.setAttribute('stroke-dashoffset', len);
      path.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.22,.7,.3,1)';
      requestAnimationFrame(() => path.setAttribute('stroke-dashoffset', 0));
    } catch (_) {}
    s.points.forEach((p, i) => {
      const c = el('circle', { cx: px(i), cy: py(Number(p.y) || 0), r: 3.4, fill: '#0b1020', stroke: s.color, 'stroke-width': 2 });
      const t = el('title'); t.textContent = `${s.name} ${p.x}: ${fmt(p.y)}`; c.appendChild(t);
      svg.appendChild(c);
    });
  });
  svg.appendChild(el('line', { x1: pad.l, x2: W - pad.r, y1: py(min), y2: py(min), class: 'axis-line' }));
  host.appendChild(svg);
}

/* يمسح حالة الترتيب والفلاتر المحفوظة — يُنادى مع كل تحميل جديد للبيانات
   فيعود الجدول لترتيبه الافتراضي (الصنف) وبدون أي فلتر أعمدة */
function resetSort() {
  closeThMenu();
  $$('.tblwrap').forEach(h => { h.__sort = null; h.__filters = null; h.__colSig = null; });
}

/* ================= ترتيب وفلاتر الجداول =================
   - ترتيب افتراضي على عمود الصنف/الكود، والضغط على أي عنوان يبدل تصاعدي/تنازلي.
   - فلتر ديناميكي في رأس كل عمود: زر مثلث صغير يفتح قائمة نوع الفلتر
     (يحتوي على / يبدأ بـ / ينتهي بـ / يساوي / لا يساوي / أكبر / أصغر /
      من-إلى / واحد من قائمة / ليس من قائمة / فارغ / غير فارغ) مع مربع للقيمة. */

/* الخطاف: يُنادى عند تغيّر فلترة أعمدة تقرير خام لاعادة الجلب من الخادم */
let onTableFilter = null;

/* انواع الفلترة المتاحة في رأس العمود */
/* أدوات فلترة الأعمدة: عوامل مقارنة + رموزها */
const TH_OP_GLYPH = { contains: '\u25be', startswith: '\u25b8', endswith: '\u25c2', eq: '=', ne: '\u2260', gt: '>', gte: '\u2265', lt: '<', lte: '\u2264', between: '\u2194', empty: '\u2205', notempty: '\u2295' };
const TH_OP_LABEL = { contains: 'يحتوي على', startswith: 'يبدأ بـ', endswith: 'ينتهي بـ', eq: 'يساوي', ne: 'لا يساوي', gt: 'أكبر من', gte: 'أكبر من أو يساوي', lt: 'أصغر من', lte: 'أصغر من أو يساوي', between: 'من / إلى', empty: 'فارغ', notempty: 'غير فارغ' };
const TH_ADV_OPS = ['contains', 'startswith', 'endswith', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'notempty'];
function filterRuleActive(r) {
  if (!r) return false;
  if (typeof r === 'string') return r.trim() !== '';
  const op = r.op || 'in';
  if (op === 'in' || op === 'notin') {
    return Array.isArray(r.set) ? r.set.length > 0 : String(r.v || '').trim() !== '';
  }
  if (op === 'empty' || op === 'notempty') return true;
  const v = String(r.v === null || r.v === undefined ? '' : r.v).trim();
  const v2 = String(r.v2 === null || r.v2 === undefined ? '' : r.v2).trim();
  return v !== '' || v2 !== '';
}

/* اعمدة مرشحة للترتيب الافتراضي بترتيب الاولويات */
const SORT_DEFAULT_KEYS = ['item', 'code', 'item_code', 'type_code', 'unit_code', 'storage_loc',
  'entity', 'entity_key', 'place', 'username', 'filename', 'file_name', 'ym', 'source_file', 'key', 'name'];

/* قيمة الترتيب: نفضل القيمة الخام من الصف، والا نستخرجها من دالة العرض */
function sortVal(r, c) {
  if (c.k && r[c.k] !== undefined && r[c.k] !== null) return r[c.k];
  if (typeof c.f === 'function') {
    const v = c.f(r);
    if (c.n) { const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? v : n; }
    return v;
  }
  return '';
}
/* مقارنة: الفارغ اخير، والارقام رقما والنصوص لغة عربية مع ارقام طبيعية */
function sortCmp(a, b, numeric) {
  const ea = a === null || a === undefined || a === '', eb = b === null || b === undefined || b === '';
  if (ea && eb) return 0;
  if (ea) return 1;
  if (eb) return -1;
  if (numeric) return (Number(a) || 0) - (Number(b) || 0);
  return String(a).localeCompare(String(b), 'ar', { numeric: true, sensitivity: 'base' });
}
/* عمود الترتيب الافتراضي: اول عمود نصوص غير مرقم بترتيب الاولويات */
function defSortKey(cols) {
  for (const want of SORT_DEFAULT_KEYS) {
    const c = cols.find(col => col.k === want);
    if (c) return want;
  }
  const first = cols.find(c => !c.n && c.k);
  return first ? first.k : null;
}

/* القيمة المعروضة لخلية */
const tblDisp = (r, c) => (typeof c.f === 'function' ? c.f(r) : r[c.k]);
/* نص مجرد من وسوم HTML */
const tblPlain = v => (typeof v === 'string' ? v.replace(/<[^>]*>/g, ' ') : v);
/* تطبيع نص عربي للمقارنة */
function tblNorm(s) {
  return String(s === null || s === undefined ? '' : s).toLowerCase()
    .replace(/[أإآٱ]/g, 'ا').replace(/[ىي]/g, 'ي').replace(/[ةه]/g, 'ه')
    .replace(/[\u064B-\u065F\u0670]/g, '').replace(/[\s,،_()\-]/g, '');
}
function tblNum(s) {
  const t = String(s === null || s === undefined ? '' : s).replace(/[^\d.\-]/g, '');
  return /\d/.test(t) ? Number(t) : NaN;
}
/* مقارنة قيمة بقيمة مرجعية: رقمية ان امكن، والا نصية مطبعة */
function tblCmpVals(a, b) {
  const na = tblNum(a), nb = tblNum(b);
  if (isFinite(na) && isFinite(nb)) return na - nb;
  return String(tblNorm(a)).localeCompare(String(tblNorm(b)), 'ar', { numeric: true });
}
/* مطابقة قيمة خلية بقاعدة فلتر ديناميكية */
function matchRule(disp, rule) {
  if (!filterRuleActive(rule)) return true;
  const op = (rule && typeof rule === 'object' && rule.op) || 'contains';
  const pl = tblPlain(disp);
  const plain = String(pl === null || pl === undefined ? '' : pl);
  const nd = tblNorm(plain);
  const v = tblNorm(rule && rule.v);
  const rawV = String(rule && rule.v !== null && rule.v !== undefined ? rule.v : '').trim();
  const rawV2 = String(rule && rule.v2 !== null && rule.v2 !== undefined ? rule.v2 : '').trim();
  switch (op) {
    case 'empty': return plain.trim() === '';
    case 'notempty': return plain.trim() !== '';
    case 'startswith': return v === '' || nd.indexOf(v) === 0;
    case 'endswith': return v === '' || nd.slice(-v.length) === v;
    case 'eq': return v === '' || tblCmpVals(plain, rule.v) === 0;
    case 'ne': return v === '' || tblCmpVals(plain, rule.v) !== 0;
    case 'gt': return v !== '' && tblCmpVals(plain, rule.v) > 0;
    case 'gte': return v !== '' && tblCmpVals(plain, rule.v) >= 0;
    case 'lt': return v !== '' && tblCmpVals(plain, rule.v) < 0;
    case 'lte': return v !== '' && tblCmpVals(plain, rule.v) <= 0;
    case 'between': {
      if (rawV === '' && rawV2 === '') return true;
      if (rawV !== '' && rawV2 === '') return tblCmpVals(plain, rule.v) >= 0;
      if (rawV === '' && rawV2 !== '') return tblCmpVals(plain, rule.v2) <= 0;
      const lo = tblCmpVals(rule.v, rule.v2) <= 0 ? rule.v : rule.v2;
      const hi = tblCmpVals(rule.v, rule.v2) <= 0 ? rule.v2 : rule.v;
      return tblCmpVals(plain, lo) >= 0 && tblCmpVals(plain, hi) <= 0;
    }
    case 'in': case 'notin': {
      if (Array.isArray(rule.set)) {
        if (!rule.set.length) return true;
        const hit = rule.set.some(x => tblCmpVals(plain, x) === 0);
        return op === 'in' ? hit : !hit;
      }
      const list = String(rule && rule.v !== null && rule.v !== undefined ? rule.v : '')
        .split(/[,،;]/).map(x => tblNorm(x)).filter(Boolean);
      if (!list.length) return true;
      const hit = list.some(x => tblCmpVals(plain, x) === 0);
      return op === 'in' ? hit : !hit;
    }
    default: return v === '' || nd.indexOf(v) >= 0;
  }
}
/* توافق خلفي مع النداء القديم (نص فقط) */
function matchFilter(disp, term) { return matchRule(disp, typeof term === 'string' ? { op: 'contains', v: term } : term); }

/* ------- قائمة انواع الفلتر المنسدلة داخل رأس العمود ------- */
let thMenu = null;
function closeThMenu() {
  if (!thMenu) return;
  thMenu.remove(); thMenu = null;
  document.removeEventListener('mousedown', thMenuOutside, true);
  document.removeEventListener('keydown', thMenuEsc, true);
  window.removeEventListener('resize', closeThMenu, true);
  window.removeEventListener('scroll', thMenuScroll, true);
}
function thMenuOutside(e) { if (thMenu && !thMenu.contains(e.target)) closeThMenu(); }
function thMenuEsc(e) { if (e.key === 'Escape') closeThMenu(); }
/* يُغلق القائمة عند تمرير الصفحة، لكن يسمح بتمرير القائمة نفسها إن طالت */
function thMenuScroll(e) {
  if (thMenu && e.target && (e.target === thMenu || (thMenu.contains && thMenu.contains(e.target)))) return;
  closeThMenu();
}

/* ------- قائمة قيم العمود المنسدلة: عرض القيم المختلفة واختيار منها ------- */
function openThValueMenu(host, btn, key, col, rule, onPick) {
  if (thMenu && thMenu.__btn === btn) { closeThMenu(); return; }
  closeThMenu();
  const rows = host.__rows || [];
  const counts = new Map();
  for (const r of rows) {
    const raw = tblPlain(tblDisp(r, col));
    const s = String(raw === null || raw === undefined ? '' : raw).trim();
    const k = tblNorm(s) || '\u0000';
    const e = counts.get(k) || { v: s, n: 0 };
    e.n++;
    counts.set(k, e);
  }
  let vals = [...counts.values()];
  vals.sort((a, b) => tblCmpVals(a.v, b.v));
  const m = document.createElement('div'); thMenu = m; m.className = 'thmenu thval-menu'; m.__btn = btn;
  /* ---- بحث ---- */
  const search = document.createElement('input');
  search.className = 'thval-q'; search.placeholder = 'بحث في القيم...';
  m.appendChild(search);
  /* ---- قائمة القيم ---- */
  const list = document.createElement('div'); list.className = 'thval-list';
  m.appendChild(list);
  function renderList(filter) {
    list.textContent = '';
    const frag = document.createDocumentFragment();
    let shown = 0;
    for (const v of vals) {
      if (filter && !tblNorm(v.v).includes(tblNorm(filter))) continue;
      if (shown >= 300) break;
      shown++;
      const lbl = document.createElement('label'); lbl.className = 'thval-item';
      const cb = document.createElement('input'); cb.type = 'checkbox';
      cb.checked = (rule.set || []).includes(v.v);
      cb.addEventListener('change', () => {
        const cur = new Set(rule.set || []);
        if (cb.checked) cur.add(v.v); else cur.delete(v.v);
        rule.set = [...cur];
        rule.op = rule.set.length ? 'in' : 'contains';
        rule.v = ''; rule.v2 = '';
        onPick();
      });
      const span = document.createElement('span'); span.textContent = v.v || '(فارغ)';
      const cnt = document.createElement('b'); cnt.className = 'thval-cnt'; cnt.textContent = String(v.n);
      lbl.appendChild(cb); lbl.appendChild(span); lbl.appendChild(cnt);
      frag.appendChild(lbl);
    }
    if (!shown) {
      const d = document.createElement('div'); d.className = 'muted'; d.style.padding = '8px'; d.textContent = 'لا قيم مطابقة';
      frag.appendChild(d);
    }
    list.appendChild(frag);
  }
  renderList('');
  search.addEventListener('input', () => renderList(search.value));
  search.addEventListener('click', e => e.stopPropagation());
  search.addEventListener('mousedown', e => e.stopPropagation());
  /* ---- إجراءات ---- */
  const actions = document.createElement('div'); actions.className = 'thval-actions';
  const selAll = document.createElement('button');
  selAll.type = 'button'; selAll.className = 'thop-item'; selAll.textContent = 'الكل';
  selAll.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); rule.set = vals.map(v => v.v); rule.op = 'in'; rule.v = ''; rule.v2 = ''; renderList(search.value); onPick(); });
  const clrAll = document.createElement('button');
  clrAll.type = 'button'; clrAll.className = 'thop-item thop-clear'; clrAll.textContent = '✕ فلتر';
  clrAll.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); rule.set = []; rule.op = 'contains'; rule.v = ''; rule.v2 = ''; renderList(search.value); onPick(); });
  actions.appendChild(selAll);
  const advBtn = document.createElement('button');
  advBtn.type = 'button'; advBtn.className = 'thop-item thval-adv-btn'; advBtn.textContent = 'متقدمة';
  actions.appendChild(advBtn);
  actions.appendChild(clrAll);
  const sortClr = document.createElement('button');
  sortClr.type = 'button'; sortClr.className = 'thop-item thop-clear'; sortClr.textContent = '✕ ترتيب';
  sortClr.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); host.__sort = null; tablePaint(host); });
  actions.appendChild(sortClr);
  m.appendChild(actions);
  const info = document.createElement('div'); info.className = 'thval-info';
  info.textContent = vals.length + ' قيمة مختلفة';
  m.appendChild(info);
  /* ---- فلترة متقدمة (عرض منفصل) ---- */
  const advBox = document.createElement('div'); advBox.className = 'thval-adv'; advBox.hidden = true;
  /* عوامل المقارنة */
  const opRow = document.createElement('div'); opRow.className = 'thval-ops';
  advBox.appendChild(opRow);
  TH_ADV_OPS.forEach(op => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'thop-item thval-op' + ((rule.op || 'contains') === op ? ' on' : '');
    b.textContent = (TH_OP_GLYPH[op] || '') + ' ' + TH_OP_LABEL[op];
    b.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      rule.op = op;
      rule.set = [];
      advBox.querySelectorAll('.thval-op').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      syncAdvInputs();
      onPick();
    });
    opRow.appendChild(b);
  });
  /* مربعات القيمة */
  const in1 = document.createElement('input'); in1.className = 'thf'; in1.type = 'text';
  in1.placeholder = 'القيمة';
  const in2 = document.createElement('input'); in2.className = 'thf thf2'; in2.type = 'text'; in2.placeholder = 'إلى';
  advBox.appendChild(in1); advBox.appendChild(in2);
  function syncAdvInputs() {
    const op = rule.op || 'contains';
    const noVal = op === 'empty' || op === 'notempty';
    in1.style.display = noVal ? 'none' : '';
    in2.style.display = op === 'between' ? '' : 'none';
    in1.placeholder = op === 'between' ? 'من' : 'القيمة';
    in1.value = rule.v === null || rule.v === undefined ? '' : rule.v;
    in2.value = rule.v2 === null || rule.v2 === undefined ? '' : rule.v2;
  }
  syncAdvInputs();
  in1.addEventListener('input', () => { rule.v = in1.value; rule.set = []; onPick(); });
  in2.addEventListener('input', () => { rule.v2 = in2.value; rule.set = []; onPick(); });
  /* ---- تبديل العرض: قيم ↔ متقدم ---- */
  const viewVals = document.createElement('div'); viewVals.className = 'thval-view';
  const viewAdv = document.createElement('div'); viewAdv.className = 'thval-view'; viewAdv.hidden = true;
  /* نقل العناصر إلى الحاويات */
  [search, list, actions, info].forEach(el => { if (el.parentNode === m) m.removeChild(el); viewVals.appendChild(el); });
  const backBtn = document.createElement('button');
  backBtn.type = 'button'; backBtn.className = 'thop-item thval-back'; backBtn.textContent = '← رجوع للقيم';
  if (advBox.parentNode === m) m.removeChild(advBox);
  viewAdv.appendChild(backBtn);
  viewAdv.appendChild(advBox);
  m.appendChild(viewVals);
  m.appendChild(viewAdv);
  advBtn.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    viewVals.hidden = true;
    viewAdv.hidden = false;
    syncAdvInputs();
  });
  backBtn.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    viewAdv.hidden = true;
    viewVals.hidden = false;
  });
  /* ---- positioning ---- */
  document.body.appendChild(m);
  const r = btn.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - mw - 8);
  if (left < 8) left = 8;
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  m.style.left = left + 'px'; m.style.top = top + 'px';
  setTimeout(() => {
    document.addEventListener('mousedown', thMenuOutside, true);
    document.addEventListener('keydown', thMenuEsc, true);
    window.addEventListener('resize', closeThMenu, true);
    window.addEventListener('scroll', thMenuScroll, true);
  }, 0);
}

/* يبني هيكل الجدول: شريط الفلاتر + رأس الاعمدة (ترتيب + فلتر ديناميكي) ثم tbody فارغ */
function tableBuild(host) {
  const cols = host.__cols || [];
  const opts = host.__opts || {};
  const keys = host.__keys || [];
  const filt = host.__filters || {};
  const refetch = () => { if (typeof onTableFilter === 'function' && host.dataset.report === '1') onTableFilter(host); };
  const schedule = () => {
    if (host.__ft) clearTimeout(host.__ft);
    host.__ft = setTimeout(() => { tablePaint(host); refetch(); }, 220);
  };

  const bar = document.createElement('div'); bar.className = 'tbar'; bar.hidden = true;
  const info = document.createElement('span'); info.className = 'tbar-i';
  bar.appendChild(info);
  host.__bar = bar; host.__barInfo = info;

  const tbl = document.createElement('table');
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  host.__ths = [];
  cols.forEach((c, i) => {
    const th = document.createElement('th');
    if (c.n) th.classList.add('num');
    const box = document.createElement('div'); box.className = 'thbox';
    const title = document.createElement('span'); title.className = 'th-t'; title.textContent = c.t;
    box.appendChild(title);
    if (opts.sort !== false) {
      th.classList.add('sortable');
      th.title = 'اضغط للترتيب';
      /* الخلية كلها قابلة للترتيب مع استثناء زر الفلتر ومربعات القيمة */
      th.addEventListener('click', e => {
        if (e.target && e.target.closest && e.target.closest('input,button')) return;
        const cur = host.__sort, k = keys[i];
        host.__sort = (cur && cur.key === k) ? { key: k, dir: -cur.dir } : { key: k, dir: 1 };
        tablePaint(host);
      });
    }
    if (opts.filters !== false) {
      const key = keys[i];
      if (!filt[key] || typeof filt[key] !== 'object') {
        filt[key] = { op: 'in', set: [] };
      }
      const rule = filt[key];
      const fbtn = document.createElement('button');
      fbtn.type = 'button'; fbtn.className = 'thfil-btn';
      fbtn.innerHTML = '<span class="thfil-ic">▼</span>';
      fbtn.title = 'فلتر: عرض قيم العمود والاختيار منها';
      function syncF() {
        const n = Array.isArray(rule.set) ? rule.set.length : 0;
        const hasAdv = rule.op && rule.op !== 'in' && rule.op !== 'contains' && filterRuleActive(rule);
        fbtn.classList.toggle('on', n > 0 || hasAdv);
      }
      fbtn.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        openThValueMenu(host, fbtn, key, c, rule, () => { syncF(); schedule(); });
      });
      th.__sync = syncF;
      box.appendChild(fbtn);
      syncF();
    }
    th.appendChild(box);
    host.__ths.push(th);
    tr.appendChild(th);
  });
  thead.appendChild(tr);
  tbl.appendChild(thead);
  const tb = document.createElement('tbody');
  tbl.appendChild(tb);
  host.__tbody = tb;
  host.innerHTML = '';
  host.appendChild(bar);
  host.appendChild(tbl);
}

/* يرسم صفوف الجدول حسب الترتيب والفلاتر الحالية */
function tablePaint(host) {
  const cols = host.__cols || [];
  const opts = host.__opts || {};
  const keys = host.__keys || [];
  const rows = host.__rows || [];
  const filt = host.__filters || {};

  /* الترتيب الافتراضي (الصنف) عند اول عرض */
  let st = opts.sort !== false ? (host.__sort || null) : null;
  if (opts.sort !== false && !st) {
    const dk = defSortKey(cols);
    if (dk) st = host.__sort = { key: dk, dir: 1 };
  }

  const rules = keys.map(k => filt[k]);
  const active = rules.map(r => filterRuleActive(r));
  const anyFilter = active.some(Boolean);

  let out = rows;
  /* تقارير خام: الخادم يفلتر كل الشيت مسبقاً، فلا نعيد الفلترة على الصفحة */
  const serverFiltered = host.dataset && host.dataset.report === '1';
  if (anyFilter && !serverFiltered) {
    out = rows.filter(r => {
      for (let i = 0; i < cols.length; i++) if (active[i] && !matchRule(tblDisp(r, cols[i]), rules[i])) return false;
      return true;
    });
  }
  if (st) {
    const idx = keys.indexOf(st.key);
    if (idx >= 0) {
      const c = cols[idx];
      out = out.slice().sort((a, b) => st.dir * sortCmp(sortVal(a, c), sortVal(b, c), !!c.n));
    } else st = null;
  }
  const shown = (opts.limit > 0) ? out.slice(0, opts.limit) : out;

  const tb = host.__tbody;
  if (tb) {
    tb.textContent = '';
    const frag = document.createDocumentFragment();
    const gbKey = host.__groupBy || '';
    const gbCol = gbKey ? cols.find(c => c.k === gbKey) : null;
    if (gbCol) {
      /* تجميع: صفوف مجمّعة + صف إجمالي فرعي + إجمالي كلي */
      const groups = new Map();
      for (const r of shown) {
        const gv = String(tblPlain(tblDisp(r, gbCol)) ?? '').trim() || '(فارغ)';
        if (!groups.has(gv)) groups.set(gv, []);
        groups.get(gv).push(r);
      }
      let grandTotals = cols.map(c => c.n ? 0 : null);
      for (const [gv, grows] of groups) {
        const subTotals = cols.map(c => c.n ? 0 : null);
        for (const r of grows) {
          const tr = document.createElement('tr');
          for (let i = 0; i < cols.length; i++) {
            const c = cols[i];
            const td = document.createElement('td');
            const v = tblDisp(r, c);
            if (c.n) td.classList.add('num');
            if (c.cls) { const k = c.cls(r); if (k) td.classList.add(k); }
            const txt = (v === null || v === undefined || v === '') ? '—' : v;
            if (c.h) td.innerHTML = txt; else td.textContent = txt;
            if (c.title) td.title = c.title(r);
            tr.appendChild(td);
            if (c.n && typeof sortVal(r, c) === 'number') subTotals[i] += sortVal(r, c);
          }
          frag.appendChild(tr);
        }
        /* صف إجمالي فرعي */
        const subRow = document.createElement('tr');
        subRow.className = 'subtotal-row';
        for (let i = 0; i < cols.length; i++) {
          const c = cols[i];
          const td = document.createElement('td');
          if (i === 0) {
            td.textContent = 'إجمالي ' + gv + ' (' + grows.length + ' صف)';
            td.style.fontWeight = '700';
          } else if (c.n && subTotals[i] !== null) {
            const v = subTotals[i];
            td.textContent = c.f ? c.f({ [c.k]: v }) : (c.n ? (Math.abs(v - Math.round(v)) < 1e-9 ? v.toLocaleString('en-US') : v.toFixed(2)) : v);
            td.classList.add('num');
            td.style.fontWeight = '700';
            grandTotals[i] += subTotals[i];
          } else {
            td.textContent = '';
          }
          subRow.appendChild(td);
        }
        frag.appendChild(subRow);
      }
      /* إجمالي كلي */
      const grandRow = document.createElement('tr');
      grandRow.className = 'grandtotal-row';
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        const td = document.createElement('td');
        if (i === 0) {
          td.textContent = 'الإجمالي الكلي (' + shown.length + ' صف)';
          td.style.fontWeight = '800';
        } else if (c.n && grandTotals[i] !== null) {
          const v = grandTotals[i];
          td.textContent = c.f ? c.f({ [c.k]: v }) : (Math.abs(v - Math.round(v)) < 1e-9 ? v.toLocaleString('en-US') : v.toFixed(2));
          td.classList.add('num');
          td.style.fontWeight = '800';
        } else {
          td.textContent = '';
        }
        grandRow.appendChild(td);
      }
      frag.appendChild(grandRow);
    } else {
      for (const r of shown) {
        const row = document.createElement('tr');
        for (const c of cols) {
          const td = document.createElement('td');
          const v = tblDisp(r, c);
          if (c.n) td.classList.add('num');
          if (c.cls) { const k = c.cls(r); if (k) td.classList.add(k); }
          const txt = (v === null || v === undefined || v === '') ? '—' : v;
          if (c.h) td.innerHTML = txt; else td.textContent = txt;
          if (c.title) td.title = c.title(r);
          row.appendChild(td);
        }
        frag.appendChild(row);
      }
      /* إجمالي كلي (بدون تجميع) — يُلغى عند totals=false */
      const hasNum = cols.some(c => c.n) && opts.totals !== false;
      if (hasNum && shown.length > 0) {
        const grandTotals = cols.map(c => c.n ? 0 : null);
        for (const r of shown) {
          for (let i = 0; i < cols.length; i++) {
            const c = cols[i];
            if (c.n && typeof sortVal(r, c) === 'number') grandTotals[i] += sortVal(r, c);
          }
        }
        const grandRow = document.createElement('tr');
        grandRow.className = 'grandtotal-row';
        for (let i = 0; i < cols.length; i++) {
          const c = cols[i];
          const td = document.createElement('td');
          if (i === 0) {
            td.textContent = 'الإجمالي (' + shown.length + ' صف)';
            td.style.fontWeight = '800';
          } else if (c.n && grandTotals[i] !== null) {
            const v = grandTotals[i];
            td.textContent = c.f ? c.f({ [c.k]: v }) : (Math.abs(v - Math.round(v)) < 1e-9 ? v.toLocaleString('en-US') : v.toFixed(2));
            td.classList.add('num');
            td.style.fontWeight = '800';
          } else {
            td.textContent = '';
          }
          grandRow.appendChild(td);
        }
        frag.appendChild(grandRow);
      }
    }
    tb.appendChild(frag);
  }

  if (host.__ths) host.__ths.forEach((th, i) => {
    const on = !!(st && st.key === keys[i]);
    th.classList.toggle('sorted', on);
    th.classList.toggle('asc', on && st.dir > 0);
    th.classList.toggle('desc', on && st.dir < 0);
  });

  if (host.__bar) {
    if (anyFilter) {
      host.__bar.hidden = false;
      if (host.__barInfo) {
        host.__barInfo.textContent = 'مطابق ' + fmtN(out.length) + ' من ' + fmtN(rows.length) + ' صف'
          + (opts.limit > 0 && out.length > shown.length ? ' — يُعرض ' + fmtN(shown.length) : '');
      }
    } else {
      host.__bar.hidden = true;
    }
  }
}

/** جدول عام — ترتيب افتراضي على الصنف + ترتيب يدوي + فلتر ديناميكي في رأس كل عمود */
function table(host, cols, rows, { limit = 500, empty = 'لا توجد بيانات', sort = true, filters = true, totals = true } = {}) {
  const sig = (cols || []).map(c => c.k || ('t:' + c.t)).join('|') + '#' + (sort ? 1 : 0) + (filters ? 1 : 0) + (totals ? 1 : 0);
  /* هل هيكل الجدول الحالي صالح لنفس الأعمدة؟ نبقي الرأس (ورأس الفلاتر) بدل مسحه */
  const keep = host.__colSig === sig && host.__tbody && host.contains(host.__tbody);
  if (!rows || !rows.length) {
    /* لا نتائج بعد فلتر: نُبقي رأس الجدول والفلاتر حتى يستطيع المستخدم تعديل الفلتر،
       ونعرض رسالة الفراغ داخل tbody بدل مسح الشاشة بالكامل. */
    if (keep) {
      host.__rows = [];
      host.__cols = cols;
      host.__keys = (cols || []).map(c => c.k || ('t:' + c.t));
      host.__opts = { limit, empty, sort, filters, totals };
      tablePaint(host);
      const tb = host.__tbody;
      if (tb) {
        tb.textContent = '';
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = (cols || []).length || 1;
        td.className = 'muted';
        td.style.padding = '16px';
        td.textContent = empty;
        tr.appendChild(td); tb.appendChild(tr);
      }
      return;
    }
    closeThMenu();
    host.innerHTML = '<div class="muted" style="padding:16px">' + empty + '</div>';
    host.__rows = null; host.__sort = null; host.__filters = null; host.__colSig = null;
    host.__tbody = null; host.__ths = null; host.__bar = null; host.__barInfo = null;
    return;
  }
  host.__rows = rows;
  host.__cols = cols;
  host.__keys = (cols || []).map(c => c.k || ('t:' + c.t));
  host.__opts = { limit, empty, sort, filters, totals };
  /* نعيد البناء فقط عند تغيّر الاعمدة، او اذا مُسح هيكل الجدول من الخارج */
  if (!keep) {
    host.__colSig = sig;
    /* نحافظ على الفلاتر والترتيب عند إعادة البناء (يُصفّران في resetSort عند تحميل الشاشة) */
    host.__filters = host.__filters || {};
    tableBuild(host);
  }
  tablePaint(host);
}
