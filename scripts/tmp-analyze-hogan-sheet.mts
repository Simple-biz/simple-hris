/**
 * READ-ONLY local analysis of the exported Hogan payroll sheet.
 * Maps spreadsheet column LETTERS to headers, verifies the pay formula
 *   =((AB*AC)+(AD*AE))+(AF*AG)+AJ+(AK*AL)
 * against real cells, and answers: is AK*AL ever nonzero? are AH/AI populated?
 */
import { readFileSync } from 'node:fs';

const FILE = 'NEW Payroll Dashboard - Hogan.csv';

/** Minimal RFC4180 parser: handles quoted fields, embedded commas, escaped quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { inQ = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** 0 -> A, 25 -> Z, 26 -> AA, 27 -> AB … */
function colLetter(i: number): string {
  let s = '';
  let n = i;
  for (;;) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return s;
}
const letterToIdx = new Map<string, number>();

const rows = parseCsv(readFileSync(FILE, 'utf8'));
const header = rows[0] ?? [];
for (let i = 0; i < header.length; i++) letterToIdx.set(colLetter(i), i);

console.log(`rows=${rows.length}  columns=${header.length}\n`);
console.log('=== COLUMN LETTER -> HEADER (A through BJ) ===');
for (let i = 0; i < Math.min(header.length, 62); i++) {
  const L = colLetter(i);
  const mark = ['AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ', 'AK', 'AL'].includes(L) ? '  <<<' : '';
  console.log(`  ${L.padEnd(3)} [${String(i).padStart(2)}]  ${(header[i] || '(blank)').slice(0, 52)}${mark}`);
}

const num = (v: unknown) => {
  const s = String(v ?? '').replace(/[₱,$\s]/g, '').replace(/,/g, '');
  if (s === '' || s === '-') return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};
const cell = (r: string[], L: string) => r[letterToIdx.get(L) ?? -1] ?? '';

// ---- the exact row the formula came from
const TARGET = 6379;
const r = rows[TARGET - 1]; // CSV line N == sheet row N (header is row 1)
console.log(`\n=== SHEET ROW ${TARGET} (the row the formula was quoted from) ===`);
if (!r) {
  console.log('  (row not present)');
} else {
  for (const L of ['AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ', 'AK', 'AL']) {
    console.log(`  ${L.padEnd(3)} ${(header[letterToIdx.get(L) ?? 0] || '?').slice(0, 34).padEnd(36)} = ${JSON.stringify(cell(r, L))}`);
  }
  const v = (L: string) => num(cell(r, L));
  const total = v('AB') * v('AC') + v('AD') * v('AE') + v('AF') * v('AG') + v('AJ') + v('AK') * v('AL');
  console.log(`\n  (AB*AC) = ${(v('AB') * v('AC')).toFixed(2)}`);
  console.log(`  (AD*AE) = ${(v('AD') * v('AE')).toFixed(2)}`);
  console.log(`  (AF*AG) = ${(v('AF') * v('AG')).toFixed(2)}`);
  console.log(`  AJ      = ${v('AJ').toFixed(2)}`);
  console.log(`  (AK*AL) = ${(v('AK') * v('AL')).toFixed(2)}`);
  console.log(`  TOTAL   = ${total.toFixed(2)}     (expected 16,617.75)`);
  // identify the person
  const nameIdxs = header.map((h, i) => ({ h, i })).filter((x) => /name|email/i.test(x.h)).slice(0, 4);
  console.log('  identity: ' + nameIdxs.map((x) => `${x.h}=${r[x.i]}`).join('  '));
}

// ---- find erjiee rows
console.log('\n=== rows mentioning erjiee ===');
let shown = 0;
for (let i = 1; i < rows.length && shown < 6; i++) {
  if (!rows[i].some((c) => /erjie/i.test(c))) continue;
  shown++;
  const v = (L: string) => num(cell(rows[i], L));
  const tot = v('AB') * v('AC') + v('AD') * v('AE') + v('AF') * v('AG') + v('AJ') + v('AK') * v('AL');
  console.log(
    `  row ${i + 1}: AB=${cell(rows[i], 'AB')} AC=${cell(rows[i], 'AC')} | AD=${cell(rows[i], 'AD')} AE=${cell(rows[i], 'AE')}` +
      ` | AF=${cell(rows[i], 'AF')} AG=${cell(rows[i], 'AG')} | AH=${cell(rows[i], 'AH')} AI=${cell(rows[i], 'AI')}` +
      ` | AJ=${cell(rows[i], 'AJ')} | AK=${cell(rows[i], 'AK')} AL=${cell(rows[i], 'AL')}  => ${tot.toFixed(2)}`,
  );
}

// ---- population stats for the ambiguous columns
console.log('\n=== how often is each column actually populated? (rows 2..end) ===');
for (const L of ['AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ', 'AK', 'AL']) {
  const idx = letterToIdx.get(L) ?? -1;
  let nonEmpty = 0, nonZero = 0;
  const samples: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const raw = String(rows[i][idx] ?? '').trim();
    if (raw === '') continue;
    nonEmpty++;
    if (num(raw) !== 0) {
      nonZero++;
      if (samples.length < 4) samples.push(raw);
    }
  }
  console.log(
    `  ${L.padEnd(3)} ${(header[idx] || '?').slice(0, 30).padEnd(32)} nonEmpty=${String(nonEmpty).padStart(5)}` +
      `  nonZero=${String(nonZero).padStart(5)}  e.g. ${samples.join(' , ') || '—'}`,
  );
}

// ---- is (AK*AL) ever nonzero? that decides whether it is a live term
console.log('\n=== (AK*AL) nonzero anywhere? ===');
let akal = 0;
const akalRows: string[] = [];
for (let i = 1; i < rows.length; i++) {
  const p = num(cell(rows[i], 'AK')) * num(cell(rows[i], 'AL'));
  if (p !== 0) {
    akal++;
    if (akalRows.length < 8) akalRows.push(`row ${i + 1}: ${cell(rows[i], 'AK')} x ${cell(rows[i], 'AL')} = ${p.toFixed(2)}`);
  }
}
console.log(`  rows where AK*AL != 0 : ${akal}`);
akalRows.forEach((s) => console.log('    ' + s));

console.log('\n=== AJ nonzero anywhere? ===');
let ajN = 0;
const ajRows: string[] = [];
for (let i = 1; i < rows.length; i++) {
  const p = num(cell(rows[i], 'AJ'));
  if (p !== 0) {
    ajN++;
    if (ajRows.length < 8) ajRows.push(`row ${i + 1}: ${cell(rows[i], 'AJ')}`);
  }
}
console.log(`  rows where AJ != 0 : ${ajN}`);
ajRows.forEach((s) => console.log('    ' + s));
