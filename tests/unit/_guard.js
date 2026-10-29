'use strict';
/**
 * حارس أمان لوحدات الاختبار الصِّرفة (Phase 0.3A)
 * ------------------------------------------------
 * يمنع أي اختبار وحدة من فتح اتصال شبكة (قاعدة بيانات / خادم) عن طريق اعتراض
 * دوال الشبكة الأساسية في Node قبل تحميل أي وحدة إنتاج. يُحمَّل **أولًا** في كل
 * ملف اختبار، وقبل أي require لملفات src.
 *
 * الاستخدام:
 *   const guard = require('./_guard');
 *   guard.install();            // يفعّل الحارس (رمي استثناء عند أي اتصال)
 *   ...
 *   guard.assertNoConnection(); // يفشل الاختبار إذا حصل اتصال
 *
 * الحارس لا يجري أي اتصال بنفسه، ويُختبر في contract.test.js عبر فعله المعطَّل
 * يدويًا على كائن وهمي ثم التأكد من بقاء العدّاد صفرًا.
 */
const net = require('node:net');
const dns = require('node:dns');
const tls = require('node:tls');

let connects = 0;
let installed = false;

/** فعّل الاعتراض على connect وlookup */
function install() {
  if (installed) return;
  installed = true;

  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function () {
    connects++;
    throw new Error('BLOCKED: اختبار وحدة حاول فتح اتصال شبكة — ممنوع في Phase 0.3A');
  };
  net.Socket.prototype.__realConnect = realConnect;

  try {
    const realLookup = dns.lookup;
    dns.lookup = function () {
      connects++;
      throw new Error('BLOCKED: اختبار وحدة حاول حلّ اسم شبكة — ممنوع في Phase 0.3A');
    };
    dns.__realLookup = realLookup;
  } catch (_) { /* لا شيء */ }

  try {
    if (tls && tls.connect) {
      const realTls = tls.connect;
      tls.connect = function () {
        connects++;
        throw new Error('BLOCKED: اختبار وحدة حاول فتح TLS — ممنوع في Phase 0.3A');
      };
      tls.__realConnect = realTls;
    }
  } catch (_) { /* لا شيء */ }
}

/** عدد محاولات الاتصال المرصودة */
function count() { return connects; }

/** فشل صريح إذا حصل أي اتصال */
function assertNoConnection(label = '') {
  if (connects !== 0) {
    throw new Error(`انفتح اتصال شبكة (${connects}) أثناء ${label || 'الاختبار'} — ممنوع`);
  }
}

module.exports = { install, count, assertNoConnection };
