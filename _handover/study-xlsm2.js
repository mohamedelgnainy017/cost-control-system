const fs = require('fs');
const XLSX = require('xlsx');
const dir = 'C:/Users/Aleman/OneDrive/Documents/Default Project/cost-control-system/_handover';
const file = fs.readdirSync(dir).find(f => /\.(xlsm|xlsx)$/i.test(f));
const wb = XLSX.readFile(dir + '/' + file, { cellDates: true });
const out = [];
const h = s => out.push(s);
const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

function aoaOf(name) {
  const ws = wb.Sheets[name];
  return ws ? XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false }) : null;
}

h('FILE: ' + file);
h('SHEETS: ' + wb.SheetNames.join(' | '));

for (const name of wb.SheetNames) {
  const aoa = aoaOf(name);
  if (!aoa) continue;
  const hdr = aoa[0] || [];
  h('\n===== SHEET ' + name + ' (rows=' + aoa.length + ') =====');
  hdr.forEach((v, i) => {
    const c = clean(v);
    if (c !== '') h('   [' + XLSX.utils.encode_col(i) + '] ' + c);
  });
}

// Distinct values helper
function distinct(name, colName, cap) {
  const aoa = aoaOf(name); if (!aoa) return;
  const hdr = (aoa[0] || []).map(clean);
  const idx = hdr.findIndex(x => x === colName);
  if (idx < 0) { h('  (' + name + ' / ' + colName + ': not found)'); return; }
  const m = new Map();
  for (let i = 1; i < aoa.length; i++) {
    const v = clean(aoa[i] && aoa[i][idx]);
    if (v !== '') m.set(v, (m.get(v) || 0) + 1);
  }
  h('\n[' + name + '] <' + colName + '>: ' + m.size + ' distinct');
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap || 50).forEach(([k, c]) => h('    ' + k + '  (' + c + ')'));
}

h('\n\n########## DIMENSIONS ##########');
distinct('التسجيل', 'التصنيف');
distinct('التسجيل', 'نوع التعاقد');
distinct('التسجيل', 'تصنيف التعاقد');
distinct('التسجيل', 'المصدر');
distinct('التسجيل', 'شركة التعاقد', 40);
distinct('التسجيل', 'المورد', 40);
distinct('التسجيل', 'الشحن');
distinct('التسجيل', 'موقف العقد');
distinct('التسجيل', 'بورصة التعاقد', 60);
distinct('السداد', 'نوع السداد');
distinct('السداد', 'نوع السعر');
distinct('السداد', 'موقف السداد');
distinct('السداد', 'شركة السداد', 40);
distinct('السداد', 'الشركة الداخلية', 40);
distinct('التحميل', 'نوع التحميل');
distinct('الافراج', 'نوع الافراج');
distinct('تفصيلى', 'موقف العقد');
distinct('تفصيلى', 'موقف المركب');
distinct('تفصيلى', 'ميناء الوصول', 40);
distinct('تفصيلى', 'مدة التحميل', 40);

// بيانات sheet: master reference blocks
h('\n\n########## MASTER SHEET "بيانات" BLOCKS ##########');
{
  const aoa = aoaOf('بيانات');
  const hdr = aoa[0] || [];
  for (let c = 0; c < hdr.length; c++) {
    const label = clean(hdr[c]);
    if (label === '') continue;
    const m = new Map();
    for (let r = 1; r < aoa.length; r++) {
      const v = clean(aoa[r] && aoa[r][c]);
      if (v !== '') m.set(v, (m.get(v) || 0) + 1);
    }
    if (m.size === 0) continue;
    h('\n[بيانات] col ' + XLSX.utils.encode_col(c) + ' <' + label + '>: ' + m.size + ' values');
    if (m.size <= 60) [...m.keys()].forEach(k => h('    ' + k));
    else h('    (too many: ' + m.size + ') sample: ' + [...m.keys()].slice(0, 30).join(' , '));
  }
}

fs.writeFileSync('C:/Users/Aleman/AppData/Local/Temp/opencode/xlsm-structure.txt', out.join('\n'), 'utf8');
console.log('written', out.length, 'lines');
