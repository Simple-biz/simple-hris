/**
 * Make HRIS's HSL rates match the Hogan sheet for the CURRENT pay week.
 *
 * The Hogan Google Sheet is the authority Accounting pays from. Where HRIS resolves a
 * LOWER rate than the sheet for the current week, HRIS would stage/pay less than the
 * sheet — so this writes an `employee_rate_history` row carrying the sheet's rate,
 * effective from the pay week's Sunday.
 *
 * SCOPE: HSL only (the sheet IS the Hogan dashboard) and ONE pay week at a time.
 *
 * SAFE BY DEFAULT — dry run prints what it would do and changes nothing:
 *   npx tsx scripts/fix-hsl-current-week-rates.mts                        # dry run
 *   npx tsx scripts/fix-hsl-current-week-rates.mts --week 2026-07-26      # pick the week
 *   npx tsx scripts/fix-hsl-current-week-rates.mts --apply                # write
 *
 * DELIBERATELY DOES NOT TOUCH:
 *   - anyone whose HRIS rate is HIGHER than the sheet. Those are usually legitimate
 *     manual raises NEWER than the sheet (the 2026-07-29 review reached the same
 *     conclusion), and auto-lowering them would cut real pay. They are listed for a
 *     human instead.
 *   - already-paid weeks. Paid stubs are frozen by the paystub snapshot, so a history
 *     write only re-prices not-yet-paid cycles.
 *
 * `--apply` writes a JSON backup of every affected person's existing history rows to
 * references/backups/ (gitignored) before inserting anything.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { resolveRateAsOfDate, buildRateHistoryByEmail } = await import(
  '../src/lib/payroll/rate-history-resolve'
);
const { computeHoganWeekPay } = await import('../src/lib/payroll/hogan-week-pay');
const { snapEffectiveFromIso } = await import('../src/lib/payroll/pay-week-effective-date');

const APPLY = process.argv.includes('--apply');
const weekArg = process.argv[process.argv.indexOf('--week') + 1];
const WEEK = /^\d{4}-\d{2}-\d{2}$/.test(weekArg ?? '') ? weekArg : '2026-07-26';
const FILE = 'NEW Payroll Dashboard - Hogan.csv';
const ACTOR = `hogan-sheet match ${new Date(WEEK).getFullYear()}-week-${WEEK}`;

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
function parseWeek(v: string): string | null {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(String(v ?? ''));
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  return `${y}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}
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

const snap = snapEffectiveFromIso(WEEK);
console.log(`${APPLY ? '*** APPLY MODE ***' : 'DRY RUN — nothing will be written'}`);
console.log(`pay week            : ${WEEK}` + (snap.moved ? `  (snapped to ${snap.iso})` : '  (already a week start)'));
console.log(`effective_from used : ${snap.iso}\n`);

const histRows = await readAll('employee_rate_history', 'employee_email, regular_rate, ot_rate, effective_from, note, created_by');
const byEmail = buildRateHistoryByEmail(histRows as never);

const catalog = new Map<string, { reg: number; ot: number }>();
for (const c of await readAll('payment_catalog_pay_structures', 'scope, employee_email, regular_rate, ot_rate, currency')) {
  if (String(c.scope ?? '').toLowerCase() !== 'employee') continue;
  const e = String(c.employee_email ?? '').trim().toLowerCase();
  if (e) catalog.set(e, { reg: num(c.regular_rate), ot: num(c.ot_rate) });
}

const rows = parseCsv(readFileSync(FILE, 'utf8'));
const I = { week: 26, mf: 27, rate: 28, we: 29, orphanPay: 35, email: 1, name: 20 };
const weekDate = new Date(+WEEK.slice(0, 4), +WEEK.slice(5, 7) - 1, +WEEK.slice(8, 10));

type Row = { email: string; name: string; sheetRate: number; hrisRate: number | null; catRate: number | null; mf: number; we: number; delta: number };
const below: Row[] = [], above: Row[] = [], missing: Row[] = [];

for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  if (parseWeek(String(r[I.week] ?? '')) !== WEEK) continue;
  const email = String(r[I.email] ?? '').trim().toLowerCase();
  const sheetRate = num(r[I.rate]);
  const mf = num(r[I.mf]), we = num(r[I.we]);
  if (!email || sheetRate <= 0 || (mf <= 0 && we <= 0)) continue;

  const resolved = resolveRateAsOfDate(byEmail.get(email), weekDate);
  const hrisRate = resolved?.regularRate ?? null;
  const cat = catalog.get(email) ?? null;
  const common = { mfHours: mf, weHours: we, orphanPayPhp: num(r[I.orphanPay]) };
  const sheetPay = computeHoganWeekPay({ ...common, regularRatePhp: sheetRate }).totalHourlyPayPhp;
  const hrisPay = hrisRate == null ? 0 : computeHoganWeekPay({ ...common, regularRatePhp: hrisRate }).totalHourlyPayPhp;
  const rec: Row = {
    email, name: String(r[I.name] ?? ''), sheetRate, hrisRate,
    catRate: cat ? cat.reg : null, mf, we,
    delta: Math.round((sheetPay - hrisPay) * 100) / 100,
  };
  if (hrisRate == null) missing.push(rec);
  else if (hrisRate < sheetRate - 0.005) below.push(rec);
  else if (hrisRate > sheetRate + 0.005) above.push(rec);
}

below.sort((a, b) => b.delta - a.delta);
const totalBelow = below.reduce((s, r) => s + r.delta, 0);

console.log('='.repeat(108));
console.log(`WOULD FIX — HRIS resolves BELOW the sheet (${below.length} people, ${peso(totalBelow)} this week)`);
console.log('='.repeat(108));
for (const r of below) {
  console.log(
    `  ${peso(r.delta).padStart(12)}  ${r.email.padEnd(28)} sheet=${String(r.sheetRate).padStart(6)}` +
      `  hris=${String(r.hrisRate).padStart(6)}  catalog=${String(r.catRate ?? '—').padStart(6)}` +
      `  (M-F ${r.mf.toFixed(2)}, WE ${r.we.toFixed(2)})`,
  );
  console.log(
    `                WRITE employee_rate_history: reg=${r.sheetRate}  ot=${r.sheetRate * 1.5}  eff=${snap.iso}`,
  );
}

if (above.length) {
  console.log('\n' + '='.repeat(108));
  console.log(`LEFT ALONE — HRIS is HIGHER than the sheet (${above.length}). Needs a human, never auto-lowered.`);
  console.log('='.repeat(108));
  for (const r of above) {
    console.log(
      `  ${r.email.padEnd(28)} sheet=${String(r.sheetRate).padStart(6)}  hris=${String(r.hrisRate).padStart(6)}` +
        `  catalog=${String(r.catRate ?? '—').padStart(6)}   (HRIS pays ${peso(Math.abs(r.delta))} MORE)`,
    );
  }
}
if (missing.length) {
  console.log(`\nNO RATE HISTORY AT ALL (${missing.length}) — would also be given the sheet's rate:`);
  for (const r of missing) console.log(`  ${r.email.padEnd(28)} sheet=${String(r.sheetRate).padStart(6)}`);
}

console.log('\n' + '='.repeat(108));
if (!APPLY) {
  console.log(`DRY RUN — nothing written. ${below.length + missing.length} row(s) would be inserted.`);
  console.log('Re-run with --apply to write (a JSON backup is taken first).');
  process.exit(0);
}

// ---------------------------------------------------------------- apply
const targets = [...below, ...missing];
if (targets.length === 0) { console.log('Nothing to do.'); process.exit(0); }

mkdirSync('references/backups', { recursive: true });
const backupPath = `references/backups/hsl_rate_match_${WEEK}.json`;
const affected = new Set(targets.map((t) => t.email));
writeFileSync(
  backupPath,
  JSON.stringify(
    { week: WEEK, effectiveFrom: snap.iso, takenAt: WEEK,
      existingHistory: histRows.filter((h) => affected.has(String(h.employee_email ?? '').toLowerCase())),
      plan: targets },
    null, 2,
  ),
);
console.log(`backup written: ${backupPath}`);

let okN = 0;
for (const t of targets) {
  const { error } = await sb.from('employee_rate_history').insert({
    employee_email: t.email,
    regular_rate: String(t.sheetRate),
    ot_rate: String(Math.round(t.sheetRate * 1.5 * 100) / 100),
    effective_from: snap.iso,
    note: 'Matched to Hogan sheet (authority Accounting pays from)',
    created_by: ACTOR,
  });
  if (error) console.log(`  FAILED ${t.email}: ${error.message}`);
  else { okN++; console.log(`  wrote ${t.email}  reg=${t.sheetRate} eff=${snap.iso}`); }
}
console.log(`\ninserted ${okN}/${targets.length}. Re-lock the wizard for this cycle to restage.`);
