'use strict';
/**
 * تخزين الشاشات المخصّصة (ملفات JSON محلية — بلا قاعدة بيانات)
 * ======================================================================
 * نمط التخزين مطابق لمخزن التقارير (src/report-store.js): ملف JSON لكل شاشة
 * داخل data/screens/ ⇒ لا استعلامات SQL ولا كتابة على بيانات الشركة.
 *
 * الوحدة نقية إلا الـ I/O الضروري (قراءة/كتابة ملف) => قابلة للاختبار بمجلد مؤقت.
 */
const fs = require('node:fs');
const path = require('node:path');
const AppScreen = require('./app-screen');

const ID_SAFE = /[^A-Za-z0-9_\-]/g;
const MAX_FILE_BYTES = 512 * 1024;

function sanitizeId(id) { return String(id || '').replace(ID_SAFE, ''); }
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** قائمة الشاشات المخصّصة (ملخص — بلا تحميل التعريف كاملًا) */
function listScreens(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const src = (o.source && typeof o.source === 'object') ? o.source : {};
      return {
        id: o.id || f.replace(/\.json$/, ''),
        name: o.name || '',
        desc: o.desc || '',
        runId: src.runId || '',
        components: Array.isArray(o.components) ? o.components.length : 0,
        inputs: Array.isArray(o.inputs) ? o.inputs.length : 0,
        buttons: Array.isArray(o.buttons) ? o.buttons.length : 0,
        savedAt: o.savedAt || '',
        createdAt: o.createdAt || '',
      };
    } catch (_) { return null; }
  }).filter(Boolean).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

/** تحميل تعريف شاشة — null إن لم يوجد */
function loadScreen(id, dir) {
  const safe = sanitizeId(id);
  if (!safe) return null;
  const p = path.join(dir, safe + '.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_) { return null; }
}

/**
 * يحفظ تعريف شاشة.
 * @param {object} def التعريف (يُطبَّع عبر AppScreen.normalizeScreen)
 * @param {string} dir المجلد
 * @param {object} opts { reservedIds: string[] } — معرّفات محجوزة (شاشات قائمة)
 * @returns {{id:string, screen:object}|{error:string}}
 */
function saveScreen(def, dir, opts) {
  const o = opts || {};
  if (!def || typeof def !== 'object') return { error: 'screen required' };
  const norm = AppScreen.normalizeScreen(def);
  if (!AppScreen.isScreenId(norm.id)) return { error: 'معرّف الشاشة غير صالح (يجب أن يبدأ بـ cs_ ثم حروف/أرقام)' };
  if (!norm.name) return { error: 'اسم الشاشة مطلوب' };
  const reserved = (o.reservedIds || []).concat(AppScreen.RESERVE_IDS);
  if (reserved.indexOf(norm.id) >= 0) return { error: 'معرّف الشاشة محجوز — اختر معرّفًا آخر' };
  ensureDir(dir);
  const now = new Date().toISOString();
  const prev = loadScreen(norm.id, dir);
  const obj = Object.assign({}, norm, {
    id: norm.id,
    savedAt: now,
    createdAt: (prev && prev.createdAt) || now,
  });
  const json = JSON.stringify(obj, null, 2);
  if (Buffer.byteLength(json) > MAX_FILE_BYTES) return { error: 'تعريف الشاشة كبير جدًا' };
  fs.writeFileSync(path.join(dir, norm.id + '.json'), json, 'utf8');
  return { id: norm.id, screen: obj };
}

/** حذف شاشة — true إن حُذفت */
function deleteScreen(id, dir) {
  const safe = sanitizeId(id);
  if (!safe) return false;
  const p = path.join(dir, safe + '.json');
  if (!fs.existsSync(p)) return false;
  try { fs.unlinkSync(p); return true; } catch (_) { return false; }
}

/** نسخة جديدة بمعرّف مختلف (نسخ/إعادة تسمية) */
function copyScreen(id, newId, dir) {
  const src = loadScreen(id, dir);
  if (!src) return { error: 'الشاشة غير موجودة' };
  const copy = Object.assign({}, src, { id: newId, name: (src.name || '') + ' (نسخة)' });
  delete copy.createdAt; delete copy.savedAt;
  return saveScreen(copy, dir);
}

module.exports = { sanitizeId, ensureDir, listScreens, loadScreen, saveScreen, deleteScreen, copyScreen };
