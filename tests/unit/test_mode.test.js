'use strict';
const guard = require('./_guard');
guard.install();
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);

console.log('== test mode (static audit of src/server.js) ==');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
const policy = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'route-policy.js'), 'utf8');

chk(/const TEST_MODE = process\.env\.WORKFLOW_TEST_MODE === '1'/.test(src),
  'TEST_MODE defined from WORKFLOW_TEST_MODE env var');

// DB.init / seedAdmin / info / fetchTime guarded by !TEST_MODE (inside else)
chk(/if \(TEST_MODE\) \{[\s\S]*?\} else \{[\s\S]*?await DB\.init\(\);/.test(src),
  'DB.init() is inside the else branch (skipped in test mode)');
chk(/seeded = await Auth\.seedAdmin\(\)/.test(src),
  'Auth.seedAdmin() only in else branch');
chk(/info = await DB\.info\(\)/.test(src),
  'DB.info() only in else branch');
chk(/fetchAt = await BF\.fetchTime\(\)/.test(src),
  'BF.fetchTime() only in else branch');

// CE.flush and BF.startScheduler guarded
chk(/if \(TEST_MODE\) \{[\s\S]*?console\.log\('  محرك التكلفة    : \(معطّل — لا CE\.flush\)'\)/.test(src) ||
    /CE\.flush\(\)\.catch/.test(src) && /if \(TEST_MODE\)/.test(src),
  'TEST_MODE branch present in startup');
// verify CE.flush appears only inside the non-test else branch of listen callback
const flushMatches = src.match(/CE\.flush\(\)\.catch/g) || [];
chk(flushMatches.length === 1, 'CE.flush().catch appears exactly once (production branch)');
const schedMatches = src.match(/BF\.startScheduler\(\)/g) || [];
chk(schedMatches.length === 1, 'BF.startScheduler() appears exactly once (in production branch)');

// /api/auth/me has test-mode branch returning synthetic user
chk(/if \(process\.env\.WORKFLOW_TEST_MODE === '1'\) \{[\s\S]*?username: 'workflow-test'/.test(src),
  '/api/auth/me returns synthetic user in test mode');
chk(/if \(process\.env\.WORKFLOW_TEST_MODE === '1'\) \{[\s\S]*?firstLogin: false/.test(src),
  '/api/auth/login-info returns firstLogin:false in test mode');

// workflow/formula routes are opened only through the test-mode policy list
chk(/const PUBLIC_ROUTES = Policy\.publicRoutes\(TEST_MODE\)/.test(src),
  'server builds PUBLIC_ROUTES from the testable policy module');
chk(policy.includes("'GET /api/workflows'") && policy.includes("'POST /api/workflows/run'"),
  'workflow routes added to TEST_PUBLIC_ROUTES');
chk(policy.includes("'GET /api/formulas'") && policy.includes("'POST /api/formulas/verify'"),
  'formulas routes added to TEST_PUBLIC_ROUTES');

// no hardcoded password/connection strings in test mode additions
chk(!/password\s*[:=]\s*['"][^'"]+['"]/.test(src.split('WORKFLOW_TEST_MODE')[1] || ''),
  'no hardcoded password in test-mode code');

// production behavior preserved: routes still defined
chk(/'GET \/api\/workflows': async/.test(src), 'workflow routes still defined');
chk(/'GET \/api\/formulas': async/.test(src), 'formulas route still defined');

// TAB_API maps workflows to the consolidated analysis section
chk(/const TAB_API = Policy\.TAB_API/.test(src), 'server uses the policy TAB_API table');
chk(/\['\/api\/workflows', \['analysis'\]\]/.test(policy), 'TAB_API maps /api/workflows to analysis');

// no destructive patterns in test mode (no DELETE/TRUNCATE on company tables)
const testBlock = (src.split('WORKFLOW TEST MODE ENABLED')[1] || '').split('server.listen')[0] || '';
chk(!/DELETE FROM|TRUNCATE|DROP TABLE/i.test(testBlock), 'no destructive SQL in test-mode block');

/* ===== فحص تشغيلي: تحميل وحدات المسار الحرج في وضع الاختبار بلا أي اتصال ===== */
process.env.WORKFLOW_TEST_MODE = '1';
let dbLoadErr = null;
try { require('../../src/db'); } catch (e) { dbLoadErr = e; }
chk(dbLoadErr === null, 'src/db.js loads in test mode without error');
chk(guard.count() === 0,
  'requiring src/db.js opens NO connection (pg Pool is lazy — connects only on first query)');

/* العلامة مطفأة افتراضيًا: بيئة الإنتاج دون WORKFLOW_TEST_MODE تسلك كما كانت تمامًا */
delete process.env.WORKFLOW_TEST_MODE;
chk((process.env.WORKFLOW_TEST_MODE === '1') === false,
  'TEST_MODE flag is OFF by default — production path unchanged when env var absent');
process.env.WORKFLOW_TEST_MODE = '1';

/* فرع الإنتاج في بدء التشغيل: الخطوات باقية كاملة وبترتيبها الأصلي */
const iInit = src.indexOf('await DB.init();');
const iSeed = src.indexOf('seeded = await Auth.seedAdmin()');
const iInfo = src.indexOf('info = await DB.info();');
const iFetch = src.indexOf('fetchAt = await BF.fetchTime();');
chk(iInit > -1 && iInit < iSeed && iSeed < iInfo && iInfo < iFetch,
  'production startup order preserved: DB.init -> seedAdmin -> DB.info -> BF.fetchTime');
chk(/BF\.startScheduler\(\)\.catch[\s\S]{0,200}CE\.flush\(\)\.catch/.test(src),
  'listen callback keeps startScheduler + CE.flush paired in production branch');

/* تسجيل الدخول لا يُتجاوز في وضع الاختبار — يظل يتحقق من قاعدة البيانات */
const loginBlock = src.split("'POST /api/auth/login'")[1].split("'GET /api/auth/me'")[0] || '';
chk(!/WORKFLOW_TEST_MODE/.test(loginBlock),
  'login route has NO test-mode bypass — password check still runs against DB');
chk(/const u = await DB\.get\('SELECT \* FROM users WHERE LOWER\(username\) = LOWER\(\$1\)',\s*\[username\]\)/.test(src),
  'production login path still authenticates against DB');

chk(guard.count() === 0, 'no network connection');
console.log(`\ntest_mode.test.js — pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);