'use strict';
/**
 * المصادقة والصلاحيات — المستخدمون والجلسات
 * - تجزئة كلمات المرور بـ scrypt (مدمجة في Node، بلا مكتبات خارجية)
 * - جلسات برموز عشوائية 256-bit محفوظة في PostgreSQL (مدة 7 أيام)
 * - ثلاثة أدوار: admin (مدير) • accountant (محاسب) • viewer (مشاهد)
 */
const crypto = require('node:crypto');
const { all, get, run } = require('./db');

const SESSION_DAYS = 7;
const COOKIE = 'ccs_token';

const ROLES = {
  /* master = إضافة وتعديل البيانات الأساسية (الأصناف والمواقع وأنواع الحركات) */
  admin:      { label: 'مدير',   perms: ['import', 'sync', 'quality', 'users', 'master'] },
  accountant: { label: 'محاسب',  perms: ['import', 'sync', 'quality', 'master'] },
  viewer:     { label: 'مشاهد',  perms: [] },
};

const roleLabel = r => (ROLES[r] && ROLES[r].label) || r;
const isRole = r => Object.prototype.hasOwnProperty.call(ROLES, r);

/* ---------- كلمات المرور ---------- */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  try {
    if (!salt || !hash) return false;
    const a = crypto.scryptSync(String(password), salt, 64);
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}

/* ---------- الصلاحيات ---------- */
function can(user, perm) {
  if (!user || !user.active) return false;
  const r = ROLES[user.role];
  return !!(r && r.perms.includes(perm));
}

/* ---------- الجلسات ---------- */
async function createSession(user, ip, ua) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await run(
    `INSERT INTO sessions(token, user_id, role, ip, user_agent, expires_at)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [token, user.id, user.role, ip || null, String(ua || '').slice(0, 200) || null, expires]);
  return { token, expires };
}

async function getSession(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  return get(`
    SELECT s.token, s.expires_at, u.id, u.username, u.full_name, u.role, u.active, u.must_change
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = $1 AND s.expires_at > now() AND u.active`, [token]);
}

async function destroySession(token) {
  if (token) await run('DELETE FROM sessions WHERE token = $1', [token]);
}

async function destroyUserSessions(userId) {
  await run('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

/** تجزئة كوكيز الطلب */
function readCookie(req, name) {
  const h = req && req.headers && req.headers.cookie;
  if (!h) return null;
  for (const part of String(h).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/* ---------- المستخدمون ---------- */
async function listUsers() {
  return all(`
    SELECT id, username, full_name, role, active, must_change,
           to_char(last_login, 'YYYY-MM-DD HH24:MI') last_login,
           to_char(created_at, 'YYYY-MM-DD') created_at
    FROM users ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'accountant' THEN 1 ELSE 2 END, username`);
}

async function countRole(role) {
  const r = await get(`SELECT COUNT(*)::int c FROM users WHERE role = $1 AND active`, [role]);
  return r.c;
}

async function seedAdmin() {
  const c = await get('SELECT COUNT(*)::int c FROM users');
  if (!c.c) {
    const { salt, hash } = hashPassword('admin123');
    await run(
      `INSERT INTO users(username, full_name, password_hash, salt, role, active, must_change)
       VALUES('admin', 'مدير النظام', $1, $2, 'admin', TRUE, TRUE)`, [hash, salt]);
  }
  // تنظيف المنتهية الصلاحية
  await run('DELETE FROM sessions WHERE expires_at < now()');
  return !c.c;
}

/** حماية بسيطة من محاولات الدخول المتكررة (في الذاكرة) */
const attempts = new Map();
function locked(key) {
  const a = attempts.get(key);
  return a && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 1000) : 0;
}
function badAttempt(key) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= 8) { a.until = Date.now() + 30000; a.n = 0; }
  attempts.set(key, a);
}
function goodAttempt(key) { attempts.delete(key); }

module.exports = {
  ROLES, COOKIE, SESSION_DAYS, roleLabel, isRole,
  hashPassword, verifyPassword, can,
  createSession, getSession, destroySession, destroyUserSessions, readCookie,
  listUsers, countRole, seedAdmin, locked, badAttempt, goodAttempt,
};
