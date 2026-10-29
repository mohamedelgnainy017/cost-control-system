'use strict';
/**
 * تخزين تعريفات التقارير (ملفات JSON محلية — بلا قاعدة بيانات).
 * وحدة مستقلة чтобы يكون سلوك الحفظ/الفتح قابلًا للاختبار بلا تشغيل الخادم.
 */
const fs = require('node:fs');
const path = require('node:path');

const ID_SAFE = /[^A-Za-z0-9_\-]/g;

function sanitizeId(id) { return String(id || '').replace(ID_SAFE, ''); }

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** يحمّل تعريف تقرير بالمعرّف — null إن لم يوجد */
function loadReport(id, dir) {
  const safe = sanitizeId(id);
  if (!safe) return null;
  const p = path.join(dir, safe + '.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_) { return null; }
}

/** يحفظ تعريف تقرير — يُرجع {id, report} أو {error} */
function saveReport(report, dir) {
  if (!report || typeof report !== 'object') return { error: 'report required' };
  if (!report.name || typeof report.name !== 'string' || !report.name.trim()) return { error: 'report requires name' };
  if (!Array.isArray(report.components)) return { error: 'components must be array' };
  ensureDir(dir);
  const rawId = report.id || ('rep_' + Date.now());
  const id = sanitizeId(rawId) || ('rep_' + Date.now());
  const obj = Object.assign({}, report, { id, savedAt: new Date().toISOString() });
  if (!obj.createdAt) obj.createdAt = obj.savedAt;
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(obj, null, 2), 'utf8');
  return { id, report: obj };
}

/** قائمة التقارير المحفوظة (ملخص فقط) */
function listReports(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const src = (o.source && typeof o.source === 'object') ? o.source : {};
      const comps = Array.isArray(o.components) ? o.components : [];
      const types = [];
      for (const c of comps) {
        const t = c && c.type ? String(c.type) : '';
        if (t && types.indexOf(t) < 0) types.push(t);
      }
      return {
        id: o.id, name: o.name, runId: o.runId, savedAt: o.savedAt,
        /* ملخّص المصدر وحالة التتبّع + عدد المكوّنات (لعرض التقارير دون فتح كل تقرير) */
        source: {
          name: src.name ? String(src.name).slice(0, 80) : '',
          label: src.label ? String(src.label).slice(0, 120) : '',
          traced: !!src.traced,
          runId: src.runId ? String(src.runId).slice(0, 80) : (o.runId || ''),
        },
        components: comps.length,
        componentTypes: types,
        hasKpi: types.indexOf('kpi') >= 0,
        filters: Array.isArray(o.filters) ? o.filters.length : 0,
      };
    } catch (_) { return null; }
  }).filter(Boolean);
}

/** يحذف تعريف تقرير — true إن حُذف */
function deleteReport(id, dir) {
  const safe = sanitizeId(id);
  if (!safe) return false;
  const p = path.join(dir, safe + '.json');
  if (!fs.existsSync(p)) return false;
  try { fs.unlinkSync(p); return true; } catch (_) { return false; }
}

module.exports = { sanitizeId, ensureDir, loadReport, saveReport, listReports, deleteReport };
