'use strict';
const guard = require('./_guard');
guard.install();

const F = require('../../src/formulas');

let pass = 0, fail = 0;
const okTag = m => { pass++; console.log('  OK   ' + m); };
const badTag = m => { fail++; console.log('  FAIL ' + m); };
const chk = (cond, m) => (cond ? okTag : badTag)(m);
const eq = (a, b, m) => chk(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('== formulas.js ==');

// listFunctions returns metadata
const list = F.listFunctions();
chk(Array.isArray(list) && list.length >= 20, 'listFunctions returns array of >=20 functions');
chk(list.every(f => f.id && f.name && f.description && Array.isArray(f.params) && f.returnType && f.nullBehavior), 'every function has required metadata');

// getFunction
chk(F.getFunction('abs') !== null, 'getFunction("abs") exists');
chk(F.getFunction('nope') === null, 'getFunction("nope") is null');

// validateFormula
chk(F.validateFormula('qty * 2 + 1').ok, 'validate simple formula ok');
chk(!F.validateFormula('qty *').ok, 'validate incomplete formula fails');
chk(!F.validateFormula('').ok, 'validate empty formula fails');
chk(!F.validateFormula('foo()').ok, 'validate unknown function fails');

// evaluateFormula basic
eq(F.evaluateFormula('2 + 3', {}).value, 5, 'arith 2+3');
eq(F.evaluateFormula('10 / 2', {}).value, 5, 'arith 10/2');
eq(F.evaluateFormula('qty * 2', { qty: 5 }).value, 10, 'column ref + mul');
eq(F.evaluateFormula('IF(qty > 0, qty, 0)', { qty: 3 }).value, 3, 'IF true branch');
eq(F.evaluateFormula('IF(qty > 0, qty, 0)', { qty: -1 }).value, 0, 'IF false branch');
eq(F.evaluateFormula('COALESCE(val, 0)', { val: null }).value, 0, 'COALESCE null');
eq(F.evaluateFormula('UPPER(name)', { name: 'ali' }).value, 'ALI', 'UPPER');
eq(F.evaluateFormula('CONCAT(first, " ", last)', { first: 'a', last: 'b' }).value, 'a b', 'CONCAT');
eq(F.evaluateFormula('ABS(-5)', {}).value, 5, 'ABS');
eq(F.evaluateFormula('ROUND(3.14159, 2)', {}).value, 3.14, 'ROUND');
eq(F.evaluateFormula('LEN("abc")', {}).value, 3, 'LEN');

// null propagation
eq(F.evaluateFormula('qty + 1', { qty: null }).value, null, 'null propagation in +');
// divide by zero -> null + warning
const dz = F.evaluateFormula('DIV(10, 0)', {});
chk(dz.value === null, 'DIV by zero -> null');
chk(Array.isArray(dz.warnings) && dz.warnings.length > 0, 'DIV by zero produces warning');

// no eval / closed whitelist: unknown function throws
let threw = false;
try { F.evaluateFormula('eval("1+1")', {}); } catch (e) { threw = true; }
chk(threw, 'eval() is not available (throws)');

// unknown column throws
let threw2 = false;
try { F.evaluateFormula('nope_col + 1', {}); } catch (e) { threw2 = true; }
chk(threw2, 'unknown column throws');

// case-insensitive column lookup
eq(F.evaluateFormula('QTY * 2', { qty: 4 }).value, 8, 'case-insensitive column lookup');

// comparison
eq(F.evaluateFormula('qty >= 5', { qty: 5 }).value, true, 'cmp >=');
eq(F.evaluateFormula('qty < 5', { qty: 5 }).value, false, 'cmp <');

// and/or
eq(F.evaluateFormula('qty > 0 && qty < 10', { qty: 5 }).value, true, 'and');
eq(F.evaluateFormula('qty > 10 || qty < 3', { qty: 5 }).value, false, 'or false');

// NUMF/R2 wrappers
eq(F.evaluateFormula('NUMF(val)', { val: null }).value, 0, 'NUMF null -> 0');
eq(F.evaluateFormula('R2(val)', { val: 3.14159 }).value, 3.14, 'R2');

// aggregate not in formulas (formulas are per-row) — just check list includes core
chk(F.listFunctions().some(f => f.id === 'div'), 'div registered');
chk(F.listFunctions().some(f => f.id === 'coalesce'), 'coalesce registered');

chk(guard.count() === 0, 'no network connection');
console.log(`\nformulas.test.js — pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);