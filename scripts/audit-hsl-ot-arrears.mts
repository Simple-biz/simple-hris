/**
 * READ-ONLY: size the peso arrears from the "weekend premium in the OT-rate
 * column" bug found by scripts/audit-hsl-ot-ratio.mts.
 *
 * Those 8 people have `employee_rate_history.ot_rate = regular + 15` instead of
 * `regular x 1.5`, with `effective_from = 1970-01-01` and no employee-scope
 * Payment Catalog structure to override it — so the wrong OT rate applied for
 * their entire history, not just recently.
 *
 * WHY THE ARITHMETIC IS THIS SIMPLE
 * The per-OT-hour gap is CONSTANT, including on weekends: the engine adds the
 * +P15 weekend premium to whichever rate applies
 * (`(dayOtSec/3600) * (ot + weekendBonus)` in current-pay.ts), so a weekend OT
 * hour is (320+15) paid vs (457.50+15) owed — the same 137.50 gap as a weekday
 * hour. So arrears = (sum of OT hours) x (correct OT rate - stored OT rate),
 * with no need to separate weekday from weekend hours.
 *
 * Rates are re-derived from the live DB, never hardcoded, so this stays correct
 * if someone fixes a rate between runs.
 *
 * DELIBERATELY IGNORES the rate columns on disbursement_records — per the
 * 2026-07-29 finding those are mislabeled BY this class of bug. Only `ot_hours`
 * (a Hubstaff-derived quantity) and `status` are read from it.
 *
 * STRICTLY READ-ONLY. No insert / update / delete / upsert.
 *
 *   npx tsx scripts/audit-hsl-ot-arrears.mts
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { defaultOtRate, isAutoOtRate } = await import('../src/lib/payment-catalog/pay-structure');
const { resolveRateAsOfDate, buildRateHistoryByEmail } = await import(
  '../src/lib/payroll/rate-history-resolve'
);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

/** The 8 confirmed live-underpaid by audit-hsl-ot-ratio-resolve.mts. */
const TARGETS = [
  'neliab@simple.biz',
  'marie@simple.biz',
  'karmina@simple.biz',
  'ruffamaeg@simple.biz',
  'verag@simple.biz',
  'aprill@simple.biz',
  'carlo@simple.biz',
  'josephr@simple.biz',
];

async function readAll(table: string, columns = '*'): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
const num = (v: unknown) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const peso = (n: number) =>
  '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---- re-derive each person's live effective OT gap from the DB
const historyRows = await readAll(
  'employee_rate_history',
  'employee_email, regular_rate, ot_rate, effective_from',
);
const historyByEmail = buildRateHistoryByEmail(historyRows);

type Gap = { reg: number; storedOt: number; correctOt: number; perHour: number };
const gapByEmail = new Map<string, Gap>();
for (const email of TARGETS) {
  const r = resolveRateAsOfDate(historyByEmail.get(email), new Date());
  const reg = r?.regularRate ?? null;
  const ot = r?.otRate ?? null;
  if (reg == null || ot == null) {
    console.log(`!! ${email}: no resolvable history rate — skipped, needs a human.`);
    continue;
  }
  if (isAutoOtRate(reg, ot)) {
    console.log(`✓  ${email}: already 1.5x — appears FIXED since the audit. Excluded.`);
    continue;
  }
  const correctOt = defaultOtRate(reg);
  gapByEmail.set(email, {
    reg,
    storedOt: ot,
    correctOt,
    perHour: Math.round((correctOt - ot) * 100) / 100,
  });
}

// ---- OT hours actually recorded per cycle
const disb = await readAll(
  'disbursement_records',
  'recipient_email, recipient_name, cycle_period_start, cycle_period_end, ot_hours, regular_hours, status',
);

type Row = { start: string; end: string; otHours: number; status: string };
const byEmail = new Map<string, Row[]>();
for (const d of disb) {
  const e = norm(d.recipient_email);
  if (!gapByEmail.has(e)) continue;
  const otHours = num(d.ot_hours);
  if (otHours <= 0) continue; // no OT that cycle → no exposure
  const list = byEmail.get(e) ?? [];
  list.push({
    start: String(d.cycle_period_start ?? '?'),
    end: String(d.cycle_period_end ?? '?'),
    otHours,
    status: norm(d.status) || '(none)',
  });
  byEmail.set(e, list);
}

console.log('\nHSL OT arrears — READ-ONLY. Nothing is written.');
console.log('Source: disbursement_records.ot_hours (rate columns deliberately ignored).\n');
console.log('='.repeat
  ? '='.repeat(100)
  : '');

const PAID = new Set(['paid', 'sent', 'complete', 'completed']);
let grandPaid = 0;
let grandUnpaid = 0;
let grandOtHoursPaid = 0;

for (const email of TARGETS) {
  const gap = gapByEmail.get(email);
  if (!gap) continue;
  const rows = (byEmail.get(email) ?? []).sort((a, b) => a.start.localeCompare(b.start));
  const otPaid = rows.filter((r) => PAID.has(r.status)).reduce((s, r) => s + r.otHours, 0);
  const otOther = rows.filter((r) => !PAID.has(r.status)).reduce((s, r) => s + r.otHours, 0);
  const owedPaid = Math.round(otPaid * gap.perHour * 100) / 100;
  const owedOther = Math.round(otOther * gap.perHour * 100) / 100;
  grandPaid += owedPaid;
  grandUnpaid += owedOther;
  grandOtHoursPaid += otPaid;

  console.log(`\n${email}`);
  console.log(
    `  reg ${gap.reg.toFixed(2)}   paid-at OT ${gap.storedOt.toFixed(2)}` +
      `   owed-at OT ${gap.correctOt.toFixed(2)}   gap ${peso(gap.perHour)}/OT-hr`,
  );
  if (rows.length === 0) {
    console.log('  no disbursement_records rows with OT hours — nothing to size here.');
    continue;
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  console.log(
    `  ${rows.length} cycle(s) with OT, ${first.start} → ${last.end}` +
      `   OT hrs: ${otPaid.toFixed(2)} paid / ${otOther.toFixed(2)} not-yet-paid`,
  );
  console.log(
    `  ARREARS: ${peso(owedPaid)} on already-paid cycles` +
      (owedOther > 0 ? `   (+ ${peso(owedOther)} still correctable before payment)` : ''),
  );
}

console.log('\n' + '='.repeat(100));
console.log(`TOTAL arrears on already-paid cycles: ${peso(grandPaid)}`);
console.log(`  across ${grandOtHoursPaid.toFixed(2)} paid OT hours, ${gapByEmail.size} people.`);
if (grandUnpaid > 0) {
  console.log(
    `Still correctable (staged / not yet paid):  ${peso(grandUnpaid)} — fixing the rate now avoids this.`,
  );
}
console.log('='.repeat(100));
console.log(
  '\nCAVEAT: this is bounded BY disbursement_records coverage. That table has had gaps\n' +
    '(the 2026-07-29 case found a person with no rows at all from 07-05 onward), so treat\n' +
    'this as a FLOOR on the arrears, not a settled figure. Nothing was written.',
);
