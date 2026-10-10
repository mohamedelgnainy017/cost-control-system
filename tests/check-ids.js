'use strict';
/* فحص: كل مُعرّف يُطلب في app.js موجود في index.html + لا مُعرّفات مكررة */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', 'public') + path.sep;
const js = fs.readFileSync(ROOT + 'app.js', 'utf8');
const html = fs.readFileSync(ROOT + 'index.html', 'utf8');

const refs = new Set();
for (const m of js.matchAll(/\$\('#([\w-]+)'\)/g)) refs.add(m[1]);
for (const m of js.matchAll(/getElementById\('([\w-]+)'\)/g)) refs.add(m[1]);
for (const m of js.matchAll(/querySelector\('#([\w-]+)'\)/g)) refs.add(m[1]);

const htmlIds = new Set();
for (const m of html.matchAll(/id="([\w-]+)"/g)) htmlIds.add(m[1]);

let missing = 0;
for (const id of [...refs].sort()) {
  if (!htmlIds.has(id)) { console.log('MISSING in HTML: #' + id); missing++; }
}

const counts = {};
for (const m of html.matchAll(/id="([\w-]+)"/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
let dup = 0;
for (const [id, n] of Object.entries(counts)) if (n > 1) { console.log('DUPLICATE id: #' + id + ' x' + n); dup++; }

console.log('refs=' + refs.size + ' htmlIds=' + htmlIds.size + ' missing=' + missing + ' dup=' + dup);
process.exit(missing + dup ? 1 : 0);