/* ============================================================
 * طبقة الربط بين مساحات العمل الخمس (Workspace Links — الواجهة)
 * ============================================================
 * الهدف: الانتقال بين (مصدر → عمود/معادلة → تحليل → تقرير → شاشة)
 * مع الحفاظ على السياق، وبناء الروابط من بيانات النظام الفعلية فقط.
 *
 * مصدر الحقيقة للعلاقات: src/workspace-links.js (نفس الملف يُخدَم للمتصفح
 * ويُختبَر في Node) ⇒ لا منطق تكرار ولا تخمين.
 */
(function () {
  'use strict';
  const apiCall = (typeof api === 'function') ? api : (async (u, o) => {
    const r = await fetch(u, o); const j = await r.json();
    if (!r.ok || !j.ok) throw new Error((j && (j.message || j.error)) || r.statusText);
    return (j && j.data) ? j.data : j;
  });
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const L = () => (window.WorkspaceLinks || null);

  /* ---------- السياق الجاري ---------- */
  const state = {
    sourceId: '', sourceName: '', runId: '', runLabel: '',
    workflowId: '', workflowName: '',
    reportId: '', reportName: '',
    screenId: '', screenName: '',
    formulaId: '', formulaName: '',
    column: '',
  };

  /* ---------- فهرس العلاقات (من بيانات النظام) ---------- */
  let index = null;
  let loading = null;
  const subscribers = [];

  async function loadIndex(force) {
    if (index && !force) return index;
    if (loading) return loading;
    loading = (async () => {
      const [cat, mod, outs, savedReps, wfs, scr] = await Promise.all([
        apiCall('/api/catalog').catch(() => ({ sources: [] })),
        apiCall('/api/model/formulas').catch(() => ({ items: [] })),
        apiCall('/api/workflows/outputs').catch(() => ({ items: [] })),
        apiCall('/api/reports/saved').catch(() => ({ items: [] })),
        apiCall('/api/workflows').catch(() => ({ items: [] })),
        apiCall('/api/screens/custom').catch(() => ({ items: [] })),
      ]);
      const idx = (L() || { buildIndex: () => ({}) }).buildIndex({
        sources: cat.sources || [],
        formulas: mod.items || [],
        runs: outs.items || [],
        reports: savedReps.items || [],
        workflows: wfs.items || [],
        screens: scr.items || [],
      });
      index = idx;
      subscribers.forEach(fn => { try { fn(idx); } catch (e) { /* تجاهل */ } });
      return idx;
    })();
    return loading;
  }
  function onIndex(fn) { subscribers.push(fn); return fn; }
  function getIndex() { return index; }

  /* ---------- شريط السياق ---------- */
  function chain() {
    const out = [];
    if (state.sourceId) out.push({ k: 'مصدر', id: state.sourceId, label: state.sourceName || state.sourceId, to: 'analysis' });
    if (state.workflowId) out.push({ k: 'تحليل', id: state.workflowId, label: state.workflowName || state.workflowId, to: 'analysis' });
    if (state.runId) out.push({ k: 'تشغيل', id: state.runId, label: state.runLabel || state.runId, to: 'report-studio' });
    if (state.reportId) out.push({ k: 'تقرير', id: state.reportId, label: state.reportName || state.reportId, to: 'report-studio' });
    if (state.screenId) out.push({ k: 'شاشة', id: state.screenId, label: state.screenName || state.screenId, to: 'screen-studio' });
    return out;
  }

  function renderContext(hostId) {
    const host = $(hostId); if (!host) return;
    const items = chain();
    if (!items.length) { host.innerHTML = ''; host.hidden = true; return; }
    host.hidden = false;
    host.innerHTML = '<span class="ws-ctx-l">المسار:</span>' + items.map((it, i) =>
      (i ? '<span class="ws-ctx-sep">←</span>' : '')
      + '<button type="button" class="ws-ctx-item" data-ws-goto="' + esc(it.to) + '" data-ws-id="' + esc(it.id) + '" title="' + esc(it.k) + '">'
      + '<b>' + esc(it.k) + '</b><span>' + esc(it.label) + '</span></button>').join('');
    host.querySelectorAll('[data-ws-goto]').forEach(b => b.addEventListener('click', () => {
      go(b.getAttribute('data-ws-goto'), { id: b.getAttribute('data-ws-id') });
    }));
  }

  /* ---------- الانتقال بين الشاشات مع حفظ السياق ---------- */
  function setContext(patch) {
    if (!patch) return;
    Object.keys(patch).forEach(k => { state[k] = patch[k] === undefined || patch[k] === null ? '' : patch[k]; });
    ['ws-context-analysis', 'ws-context-report-studio', 'ws-context-screen-studio']
      .forEach(id => renderContext(id));
    if (typeof window.onWorkspaceContext === 'function') { try { window.onWorkspaceContext(state); } catch (e) { /* تجاهل */ } }
  }
  function getContext() { return Object.assign({}, state); }

  const PLATFORM_TABS = {
    'analysis': 'analysis', 'explorer': 'analysis',
    'workflow': 'analysis', 'workcenter': 'analysis',
    'report-studio': 'report-studio', 'reports-manager': 'report-studio', 'reports': 'report-studio',
    'screen-studio': 'screen-studio',
  };
  function go(tab, payload) {
    const p = payload || {};
    if (p.sourceId) setContext({ sourceId: p.sourceId, sourceName: p.sourceName || state.sourceName });
    if (p.runId) setContext({ runId: p.runId, runLabel: p.runLabel || state.runLabel });
    if (p.workflowId) setContext({ workflowId: p.workflowId, workflowName: p.workflowName || state.workflowName });
    if (p.reportId) setContext({ reportId: p.reportId, reportName: p.reportName || state.reportName });
    if (p.screenId) setContext({ screenId: p.screenId, screenName: p.screenName || state.screenName });
    if (p.formulaId) setContext({ formulaId: p.formulaId, formulaName: p.formulaName || state.formulaName });
    if (p.column !== undefined) setContext({ column: p.column || '' });
    const target = PLATFORM_TABS[tab] || tab;
    try {
      if (typeof gotoGroupSub === 'function') gotoGroupSub('platform', target);
      else if (typeof goTab === 'function') goTab(target);
    } catch (e) { /* تجاهل */ }
    /* اختيار اللوحة المناسبة داخل الشاشة (بدل الاكتفاء باللوحة الافتراضية) */
    const panel = p.screenId ? 'custom'
      : p.openReportId ? 'designer'
      : p.reportId ? 'saved'
      : p.formulaId ? 'formulas'
      : p.workflowId ? 'build'
      : p.sourceId ? 'sources'
      : null;
    if (panel && window.PlatformShell && typeof window.PlatformShell.show === 'function') {
      try { window.PlatformShell.show(target, panel); } catch (e) { /* تجاهل */ }
    }
    /* تمرير التركيز للعنصر المطلوب (تفاصيل عمود/معادلة) */
    if (p.focusFormula && typeof window.focusExplorerFormula === 'function') window.focusExplorerFormula(p.focusFormula);
    if (p.focusColumn && typeof window.focusExplorerColumn === 'function') window.focusExplorerColumn(p.focusColumn, p.sourceId);
    if (p.openReportId && typeof window.loadReportIntoDesigner === 'function') {
      Promise.resolve(window.loadReportIntoDesigner(p.openReportId)).catch(() => {});
    }
  }

  /* ---------- أدوات العرض المشتركة ---------- */
  /** قائمة «الاستخدام» (تشغيلات/تقارير/تحليلات) بأدلة */
  function usageHtml(usage, opts) {
    const o = opts || {};
    const runs = (usage.runs || []).map(r =>
      '<li><button type="button" class="btn xs ghost" data-ws-run="' + esc(r.runId) + '">'
      + esc(r.workflowName || r.runId) + '</button>'
      + '<span class="muted xs">' + esc(r.runId) + (r.column ? ' · عمود: ' + esc(r.column) : '') + '</span></li>').join('');
    const reps = (usage.reports || []).map(r =>
      '<li><button type="button" class="btn xs ghost" data-ws-report="' + esc(r.id) + '">فتح التقرير</button> '
      + '<span class="muted xs">' + esc(r.name || r.id) + '</span></li>').join('');
    const ans = (usage.analyses || []).map(a =>
      '<li><button type="button" class="btn xs ghost" data-ws-analysis="' + esc(a.id) + '">فتح التحليل</button> '
      + '<span class="muted xs">' + esc(a.name || a.id) + '</span></li>').join('');
    const scs = (usage.screens || []).map(s =>
      '<li><button type="button" class="btn xs ghost" data-ws-screen="' + esc(s.id) + '">فتح الشاشة</button> '
      + '<span class="muted xs">' + esc(s.name || s.id) + (s.via ? ' · ' + esc(s.via) : '') + '</span></li>').join('');
    if (!runs && !reps && !ans && !scs) {
      return '<div class="hint">' + esc(o.empty || 'لا علاقات موثّقة في النظام لهذه العلاقة بعد.') + '</div>';
    }
    let html = '';
    if (runs) html += '<div class="ws-usage-h">تشغيلات</div><ul class="ws-usage">' + runs + '</ul>';
    if (reps) html += '<div class="ws-usage-h">تقارير</div><ul class="ws-usage">' + reps + '</ul>';
    if (ans) html += '<div class="ws-usage-h">تحليلات</div><ul class="ws-usage">' + ans + '</ul>';
    if (scs) html += '<div class="ws-usage-h">شاشات</div><ul class="ws-usage">' + scs + '</ul>';
    return html;
  }

  /** ربط أزرار الاستخدام (يُستدعى بعد إدراج HTML) */
  function wireUsage(host) {
    if (!host) return;
    host.querySelectorAll('[data-ws-run]').forEach(b => b.addEventListener('click', () => {
      const id = b.getAttribute('data-ws-run');
      const run = index && index.byRun ? index.byRun.get(id) : null;
      go('report-studio', { runId: id, runLabel: run ? (run.workflowName || id) : id, workflowId: run ? run.workflowId : '', workflowName: run ? run.workflowName : '' });
    }));
    host.querySelectorAll('[data-ws-report]').forEach(b => b.addEventListener('click', () => {
      const id = b.getAttribute('data-ws-report');
      const rep = index && index.reports ? index.reports.find(r => r.id === id) : null;
      go('report-studio', { reportId: id, reportName: rep ? rep.name : id, openReportId: id });
    }));
    host.querySelectorAll('[data-ws-analysis]').forEach(b => b.addEventListener('click', () => {
      const id = b.getAttribute('data-ws-analysis');
      const wf = index && index.wfById ? index.wfById.get(id) : null;
      go('workflow', { workflowId: id, workflowName: wf ? wf.name : id });
      if (typeof window.openWorkflowById === 'function') window.openWorkflowById(id);
    }));
    host.querySelectorAll('[data-ws-screen]').forEach(b => b.addEventListener('click', () => {
      const id = b.getAttribute('data-ws-screen');
      const sc = index && index.screens ? index.screens.find(s => s.id === id) : null;
      go('screen-studio', { screenId: id, screenName: sc ? sc.name : id });
    }));
  }

  window.Workspace = {
    state, setContext, getContext, go, chain, renderContext,
    loadIndex, onIndex, getIndex, usageHtml, wireUsage,
  };
})();
