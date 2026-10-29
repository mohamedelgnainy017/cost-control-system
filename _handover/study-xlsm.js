const fs = require('fs');
const XLSX = require('xlsx');

const dir = 'C:/Users/Aleman/OneDrive/Documents/Default Project/cost-control-system/_handover';
const target = process.argv[2];
const file = target ? target : fs.readdirSync(dir).find(f => /\.(xlsm|xlsx)$/i.test(f));
if (!file) { console.error('no excel file found'); process.exit(1); }

const wb = XLSX.readFile((target ? '' : dir + '/') + file, { cellDates: true });
console.log('FILE:', file);
console.log('SHEETS:', wb.SheetNames.map(s => s).join(' | '));

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const ref = ws['!ref'] || '(empty)';
  let range = { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
  if (ref !== '(empty)') range = XLSX.utils.decode_range(ref);
  const rows = ref === '(empty)' ? 0 : range.e.r - range.s.r + 1;
  const cols = ref === '(empty)' ? 0 : range.e.c - range.s.c + 1;
  const merges = (ws['!merges'] || []).length;
  console.log(`\n===== SHEET: ${name} | rows=${rows} cols=${cols} mergedCells=${merges} =====`);
  if (rows === 0) continue;
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
  const show = Math.min(rows, 14);
  for (let i = 0; i < show; i++) {
    const row = aoa[i] || [];
    let s = row.map(v => {
      if (v === null || v === undefined) return '·';
      let t = String(v);
      if (t.length > 26) t = t.slice(0, 26) + '…';
      return t;
    }).join(' | ');
    console.log('R' + String(i + 1).padStart(3) + ': ' + s);
  }
  if (rows > show) console.log('... +' + (rows - show) + ' rows more');
}