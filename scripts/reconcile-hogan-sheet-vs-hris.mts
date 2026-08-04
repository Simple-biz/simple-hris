/**
 * READ-ONLY reconciliation: for every HSL person-week in the Hogan sheet, does the RATE
 * our HRIS would resolve match the rate the sheet actually paid?
 *
 * WHY THIS AND NOT THE FORMULA
 * The sheet's two-stage form and our collapsed form are algebraically identical — proven
 * on all 6,782 populated rows by scripts/verify-hogan-formula.mts (6782/6782 agree). So
 * restructuring the formula cannot change a single peso. Any HRIS-vs-sheet difference for
 * HSL must therefore come from the INPUTS: the regular rate, or the hours.
 *
 * This script isolates the rate. For each sheet row it parses the week ("Week 7/26/26"),
 * resolves what `resolveRateAsOfDate` would return for that week's Sunday from
 * employee_rate_history, and compares it to the sheet's "M-F Rate" (AC).
 *
 * STRICTLY READ-ONLY. No insert / update / delete / upsert.
 *   npx tsx scripts/reconcile-hogan-sheet-vs-hris.mts
 */
import { existsSync, readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { resolveRateAsOfDate, buildRateHistoryByEmail } = await import(
  '../src/lib/payroll/rate-history-resolve'
);
const { computeHoganWeekPay } = await import('../src/lib/payroll/hogan-week-pay');

const FILE = 'NEW Payroll Dashboard - Hogan.csv';
if (!existsSync(FILE)) { console.error(`Not found: ${FILE}`); process.exit(1); }

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
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
const num = (v: unknown) => {
  const s = String(v ?? '').replace(/[₱,$\s]/g, '');
  if (!s || s === '-') return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};
const peso = (n: number) =>
  '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "Week 7/26/26" / "Week 7/26/2026" -> local Date. */
function parseWeek(v: string): Date | null {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(String(v ?? ''));
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const d = new Date(y, Number(m[1]) - 1, Number(m[2]));
  return Number.isNaN(d.getTime()) ? null : d;
}
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function readAll(table: string, cols = '*'): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

const hist = await readAll('employee_rate_history', 'employee_email, regular_rate, ot_rate, effective_from');
const byEmail = buildRateHistoryByEmail(hist as never);
console.log(`employee_rate_history: ${hist.length} rows, ${byEmail.size} people\n`);

const rows = parseCsv(readFileSync(FILE, 'utf8'));
const I = { week: 26, mf: 27, rate: 28, we: 29, weRate: 30, ot: 31, otDiff: 32, orphanPay: 35, mwHours: 36, mwRate: 37, email: 1 };

type Div = { email: string; week: string; sheetRate: number; hrisRate: number | null; mf: number; we: number; sheetPay: number; hrisPay: number; delta: number };
const divs: Div[] = [];
let checked = 0, matched = 0, noHistory = 0;
const byWeek = new Map<string, { n: number; bad: number; pesos: number }>();

for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const email = String(r[I.email] ?? '').trim().toLowerCase();
  const sheetRate = num(r[I.rate]);
  const wk = parseWeek(String(r[I.week] ?? ''));
  if (!email || sheetRate <= 0 || !wk) continue;
  const mf = num(r[I.mf]), we = num(r[I.we]);
  if (mf <= 0 && we <= 0) continue;
  checked++;

  const resolved = resolveRateAsOfDate(byEmail.get(email), wk);
  const hrisRate = resolved?.regularRate ?? null;
  const wkKey = iso(wk);
  const agg = byWeek.get(wkKey) ?? { n: 0, bad: 0, pesos: 0 };
  agg.n++;

  if (hrisRate == null) { noHistory++; byWeek.set(wkKey, agg); continue; }
  if (Math.abs(hrisRate - sheetRate) < 0.005) { matched++; byWeek.set(wkKey, agg); continue; }

  // Price the SAME hours at each rate, using the sheet's own formula, so the delta is
  // purely the rate difference.
  const common = { mfHours: mf, weHours: we, orphanPayPhp: num(r[I.orphanPay]) };
  const sheetPay = computeHoganWeekPay({ ...common, regularRatePhp: sheetRate }).totalHourlyPayPhp;
  const hrisPay = computeHoganWeekPay({ ...common, regularRatePhp: hrisRate }).totalHourlyPayPhp;
  const delta = Math.round((sheetPay - hrisPay) * 100) / 100;
  divs.push({ email, week: wkKey, sheetRate, hrisRate, mf, we, sheetPay, hrisPay, delta });
  agg.bad++;
  agg.pesos += delta;
  byWeek.set(wkKey, agg);
}

const under = divs.filter((d) => d.delta > 0);
const over = divs.filter((d) => d.delta < 0);
const totalUnder = under.reduce((s, d) => s + d.delta, 0);
const totalOver = over.reduce((s, d) => s + d.delta, 0);

console.log('='.repeat(100));
console.log('HOGAN SHEET vs HRIS — RATE RECONCILIATION (HSL only)   READ-ONLY');
console.log('='.repeat(100));
console.log(`person-weeks compared          : ${checked}`);
console.log(`  rate MATCHES sheet           : ${matched}  (${((matched / checked) * 100).toFixed(1)}%)`);
console.log(`  no rate history at all       : ${noHistory}`);
console.log(`  rate DIVERGES                : ${divs.length}  (${((divs.length / checked) * 100).toFixed(1)}%)`);
console.log(`\nHRIS pays LESS than the sheet  : ${under.length} person-weeks, ${peso(totalUnder)}`);
console.log(`HRIS pays MORE than the sheet  : ${over.length} person-weeks, ${peso(Math.abs(totalOver))}`);
console.log(`NET                            : ${peso(totalUnder + totalOver)}`);

console.log('\n--- by week (most recent 12) ---');
for (const [wk, a] of [...byWeek.entries()].sort().slice(-12)) {
  console.log(
    `  ${wk}  rows=${String(a.n).padStart(4)}  rate-diverged=${String(a.bad).padStart(4)}  ${peso(a.pesos).padStart(15)}`,
  );
}

console.log('\n--- 15 largest single-week gaps ---');
for (const d of [...divs].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 15)) {
  console.log(
    `  ${peso(d.delta).padStart(13)}  ${d.email.padEnd(26)} ${d.week}` +
      `  sheet=${String(d.sheetRate).padStart(6)}  hris=${String(d.hrisRate).padStart(6)}` +
      `  (M-F ${d.mf.toFixed(2)}, WE ${d.we.toFixed(2)})`,
  );
}

// Which direction dominates per distinct rate pair? Tells us if HRIS simply lags.
console.log('\n--- most common (sheet -> hris) rate pairs ---');
const pairs = new Map<string, { n: number; pesos: number }>();
for (const d of divs) {
  const k = `${d.sheetRate} -> ${d.hrisRate}`;
  const p = pairs.get(k) ?? { n: 0, pesos: 0 };
  p.n++; p.pesos += d.delta;
  pairs.set(k, p);
}
for (const [k, p] of [...pairs.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) {
  console.log(`  ${k.padEnd(22)} n=${String(p.n).padStart(4)}  ${peso(p.pesos).padStart(15)}`);
}
console.log('\n' + '='.repeat(100));
console.log('Nothing was written to the database.');
