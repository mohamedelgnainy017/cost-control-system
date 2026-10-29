'use strict';
/**
 * سجل المعادلات المحفوظة (Formula Store) — المصدر المركزي الوحيد للمعادلات القابلة للتنفيذ
 * =========================================================================
 * المعادلة تُعرَّف **مرة واحدة** هنا وتُستخدم في Workflow Studio (خطوة compute)
 * وفي Report Studio (مصدر قيمة لمكوّن) — بلا تكرار منطق الحساب.
 *
 * كل معادلة: معرّف ثابت · اسم · وصف · الحقول المعرَّفة · التعبير · نسخة (version)
 * + سجل نسخ (versions) يسمح بالرجوع إلى النسخة التي نُفِّذت بها نتيجة سابقة.
 *
 * التخزين: ملفات JSON محلية (data/formulas) — بلا قاعدة بيانات.
 * الأمان: التعبير يُفحص عبر src/formulas.js (قائمة دوال مغلقة، بلا eval).
 */
const fs = require('node:fs');
const path = require('node:path');
const formulas = require('./formulas');

const ID_SAFE = /[^A-Za-z0-9_\-]/g;
const NAME_MAX = 120;
const EXPR_MAX = 2000;

function sanitizeId(id) { return String(id || '').replace(ID_SAFE, ''); }
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); return dir; }
function formulasDir(baseDir) { return baseDir || path.join(__dirname, '..', 'data', 'formulas'); }

/** أنواع الحقول المسموحة في تعريف المعادلة */
const FIELD_TYPES = ['number', 'string', 'date', 'any'];

/** تطبيع تعريف الحقول (اسم + نوع) */
function normalizeFields(fields) {
  if (!Array.isArray(fields)) return [];
  const out = [];
  for (const f of fields.slice(0, 40)) {
    if (!f) continue;
    const name = String(f.name || '').trim().slice(0, 60);
    if (!name) continue;
    const type = FIELD_TYPES.indexOf(String(f.type)) >= 0 ? String(f.type) : 'any';
    out.push({ name, type });
  }
  return out;
}

function colKey(s) { return String(s || '').toLowerCase(); }

/** التحقق من تعريف معادلة قبل الحفظ */
function validateFormula(def) {
  const errors = [];
  if (!def || typeof def !== 'object') return { ok: false, errors: ['تعريف المعادلة مفقود'] };
  const name = String(def.name || '').trim();
  if (!name) errors.push('اسم المعادلة مطلوب');
  else if (name.length > NAME_MAX) errors.push('اسم المعادلة طويل جدًا');
  const expr = String(def.expr || '').trim();
  if (!expr) errors.push('تعبير المعادلة مطلوب');
  else if (expr.length > EXPR_MAX) errors.push('تعبير المعادلة طويل جدًا');
  else {
    const v = formulas.validateFormula(expr);
    if (!v.ok) errors.push(...v.errors.map(e => 'تعبير: ' + e));
    else {
      const fields = normalizeFields(def.fields);
      if (fields.length) {
        const allowed = new Set(fields.map(f => colKey(f.name)));
        const refs = formulas.referencedColumns ? formulas.referencedColumns(expr) : [];
        const missing = refs.filter(r => !allowed.has(colKey(r)));
        if (missing.length) errors.push('حقول غير معرّفة في المعادلة: ' + missing.join('، '));
      }
    }
  }
  const kind = def.kind === 'measure' ? 'measure' : 'column';
  const source = String(def.source || '').trim().slice(0, 80);
  const target = String(def.target || '').trim().slice(0, 60);
  if (target && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) errors.push('اسم العمود/المقياس غير صالح');
  return { ok: errors.length === 0, errors };
}

/** يحفظ معادلة (أو نسخة جديدة منها) — يزيد النسخة ولا يمسح النسخ السابقة */
function saveFormula(def, dir) {
  const v = validateFormula(def);
  if (!v.ok) return { error: v.errors.join(' · ') };
  const d = ensureDir(formulasDir(dir));
  const rawId = def.id || ('fml_' + Date.now().toString(36));
  const id = sanitizeId(rawId) || ('fml_' + Date.now().toString(36));
  const p = path.join(d, id + '.json');
  let prev = null;
  try { if (fs.existsSync(p)) prev = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { prev = null; }
  const version = prev && Number.isFinite(Number(prev.version)) ? Number(prev.version) + 1 : 1;
  const nowIso = new Date().toISOString();
  const kind = def.kind === 'measure' ? 'measure' : 'column';
  const source = String(def.source || '').trim().slice(0, 80);
  const target = String(def.target || '').trim().slice(0, 60);
  const formula = {
    id,
    name: String(def.name).trim(),
    description: String(def.description || '').trim().slice(0, 400),
    fields: normalizeFields(def.fields),
    expr: String(def.expr).trim(),
    spec: def.spec && typeof def.spec === 'object' ? def.spec : null,   /* الشكل البصري (اختياري) */
    origin: def.origin === 'visual' ? 'visual' : (def.origin === 'text' ? 'text' : 'text'),
    kind,
    source,
    target,
    version,
    createdAt: (prev && prev.createdAt) || nowIso,
    updatedAt: nowIso,
    /* سجل النسخ: يسمح بالرجوع إلى التعبير المنفَّذ في نتيجة سابقة */
    versions: (prev && Array.isArray(prev.versions) ? prev.versions.slice(-19) : []).concat([{
      version, expr: String(def.expr).trim(), fields: normalizeFields(def.fields), source, target, kind, savedAt: nowIso,
    }]),
  };
  fs.writeFileSync(p, JSON.stringify(formula, null, 2), 'utf8');
  return { id, formula };
}

/** يحمّل معادلة بمعرّفها (أو نسخة محددة) */
function loadFormula(id, dir, version) {
  const safe = sanitizeId(id);
  if (!safe) return null;
  const p = path.join(formulasDir(dir), safe + '.json');
  if (!fs.existsSync(p)) return null;
  let f;
  try { f = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
  if (version !== undefined && version !== null && Number.isFinite(Number(version))) {
    const v = Number(version);
    if (v === Number(f.version)) return f;
    const hist = (f.versions || []).find(x => Number(x.version) === v);
    if (!hist) return null;
    return Object.assign({}, f, { version: v, expr: hist.expr, fields: hist.fields || f.fields, spec: null, historic: true });
  }
  return f;
}

/** قائمة المعادلات (ملخص) */
function listFormulas(dir) {
  const d = formulasDir(dir);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(f => f.endsWith('.json')).map(f => {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
      return {
        id: o.id, name: o.name, description: o.description || '', version: o.version,
        fields: o.fields || [], expr: o.expr, origin: o.origin || 'text',
        kind: o.kind || 'column', source: o.source || '', target: o.target || '',
        updatedAt: o.updatedAt, createdAt: o.createdAt,
      };
    } catch (_) { return null; }
  }).filter(Boolean);
}

/** يحذف معادلة — true إن حُذفت */
function deleteFormula(id, dir) {
  const safe = sanitizeId(id);
  if (!safe) return false;
  const p = path.join(formulasDir(dir), safe + '.json');
  if (!fs.existsSync(p)) return false;
  try { fs.unlinkSync(p); return true; } catch (_) { return false; }
}

module.exports = {
  FIELD_TYPES, validateFormula, normalizeFields,
  saveFormula, loadFormula, listFormulas, deleteFormula, formulasDir,
};
