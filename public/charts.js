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

/** خط بياني متعدد السلاسل مع تعبئة متدرجة */
function lineChart(host, series, { height = 250, fmt = fmtC, area = true } = {}) {
  host.innerHTML = '';
  if (!series.length || !series[0].points.length) { host.innerHTML = '<div class="muted">لا توجد بيانات</div>'; return; }
  const W = host.clientWidth || 600, H = height, pad = { t: 16, r: 12, b: 42, l: 62 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const labels = series[0].points.map(p => p.x);
  const all = series.flatMap(s => s.points.map(p => Number(p.y) || 0));
  const max = Math.max(...all.map(Math.abs), 1), min = Math.min(...all, 0);
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

  labels.forEach((lb, i) => {
    if (labels.length > 14 && i % 2) return;
    const t = el('text', { x: px(i), y: H - pad.b + 17, 'text-anchor': 'middle' });
    t.textContent = lb; svg.appendChild(t);
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

/** جدول عام */
function table(host, cols, rows, { limit = 500, empty = 'لا توجد بيانات' } = {}) {
  if (!rows || !rows.length) { host.innerHTML = `<div class="muted" style="padding:16px">${empty}</div>`; return; }
  const t = document.createElement('table');
  const thead = document.createElement('thead'), tr = document.createElement('tr');
  cols.forEach(c => {
    const th = document.createElement('th');
    th.textContent = c.t; if (c.n) th.className = 'num';
    tr.appendChild(th);
  });
  thead.appendChild(tr); t.appendChild(thead);
  const tb = document.createElement('tbody');
  rows.slice(0, limit).forEach(r => {
    const row = document.createElement('tr');
    cols.forEach(c => {
      const td = document.createElement('td');
      const v = typeof c.f === 'function' ? c.f(r) : r[c.k];
      if (c.n) td.className = 'num';
      if (c.cls) { const k = c.cls(r); if (k) td.classList.add(k); }
      const txt = v === null || v === undefined || v === '' ? '—' : v;
      if (c.h) td.innerHTML = txt; else td.textContent = txt;
      if (c.title) td.title = c.title(r);
      row.appendChild(td);
    });
    tb.appendChild(row);
  });
  t.appendChild(tb);
  host.innerHTML = ''; host.appendChild(t);
}
