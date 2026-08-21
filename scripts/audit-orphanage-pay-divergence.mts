/**
 * READ-ONLY: find every orphanage-pay amount that disagrees with its own hours.
 *
 *   node --import tsx scripts/audit-orphanage-pay-divergence.mts
 *   node --import tsx scripts/audit-orphanage-pay-divergence.mts --file simple-biz_daily_report_2026-08-09_to_2026-08-15.csv
 *   node --import tsx scripts/audit-orphanage-pay-divergence.mts --json reports/orphanage-divergence.json
 *
 * Two carriers hold a week's orphanage pay and nothing has ever compared them:
 *
 *   `orphanage_pay`                                the first-class record — hours,
 *                                                  the reg/OT split, both rates, the amount
 *   `app_settings['payroll.wizard.additions.<f>']` the working value, `orphanageAmounts`,
 *                                                  and the one that actually PAYS
 *
 * Three ways they go wrong, all of them silent in the UI before 2026-08-21:
 *
 *  1. OT priced at the weekly 0.5× DIFFERENTIAL instead of the full 1.5× rate.
 *     Live between `e0028b8d` (2026-08-11, HSL pay became the Hogan sheet's column
 *     AN, which made `CalcRow.otRate` the differential) and `41a21ae1` (2026-08-18,
 *     the paste tool started deriving regular × 1.5). Orphanage hours have no base
 *     leg, so the differential pays a third of the hour.
 *  2. The blob and the record disagree on the amount. The additions blob is written
 *     as a WHOLE object, so a save from a stale tab reverts every person in it —
 *     which is how a corrected week went back to its pre-fix numbers.
 *  3. The record has hours and the blob has no amount at all: those hours pay ₱0.
 *
 * SCOPE: this compares the RECORD against the COLUMN. It deliberately does NOT judge
 * which carrier ends up pricing a row — the snapshot-vs-staged precedence needs the
 * Payment Catalog to evaluate, and an approximation of it here produced two separate
 * six-figure false alarms before being removed (2026-08-21). For that question use
 * `scripts/verify-dispatch-carryover.mts`; after repairing amounts, unlock and re-lock
 * the cycle so the staged stubs re-stage.
 *
 * READ-ONLY BY CONSTRUCTION — plain `select` only. `.env.local` holds PRODUCTION
 * service-role credentials, so nothing here may write. Repairs are made by a human
 * in the wizard's Orphanage step ("Re-price"), which re-runs the same pricing
 * function a paste would.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Default-import + cast: this is an `.mts` (true ESM) file and tsx transpiles the
// imported `.ts` to CJS, so named exports do not come through. Same pattern as
// scripts/fix-dept-transfers-2026-08-07.mts.
import pricingModule from '../src/lib/payroll/orphanage-pay-pricing';
const { ORPHANAGE_OT_MULTIPLIER, reconcileLockedOrphanageAmount } =
  pricingModule as unknown as typeof import('../src/lib/payroll/orphanage-pay-pricing');

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

const argv = process.argv.slice(2);
const argOf = (flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const onlyFile = argOf('--file');
const jsonOut = argOf('--json');

const php = (n: number) =>
  `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

interface OrphRow {
  source_file: string;
  employee_email: string;
  employee_name: string | null;
  hours: number;
  reg_hours: number;
  ot_hours: number;
  regular_rate_php: number | null;
  ot_rate_php: number | null;
  amount_php: number;
  locked_by: string | null;
  locked_at: string | null;
}

/** PostgREST truncates at 1000 rows even with `.range()` — page everything. */
async function selectAllPaged<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

const rows = await selectAllPaged<OrphRow>((from, to) => {
  let q = sb
    .from('orphanage_pay')
    .select('source_file,employee_email,employee_name,hours,reg_hours,ot_hours,regular_rate_php,ot_rate_php,amount_php,locked_by,locked_at')
    // Deterministic order across pages (the composite PK) so paging can neither
    // drop nor duplicate a person's week.
    .order('source_file', { ascending: true })
    .order('employee_email', { ascending: true })
    .range(from, to);
  if (onlyFile) q = q.eq('source_file', onlyFile);
  return q;
});

const files = [...new Set(rows.map((r) => r.source_file))].sort();
console.log(`orphanage_pay: ${rows.length} rows across ${files.length} pay ${files.length === 1 ? 'week' : 'weeks'}\n`);

interface Finding {
  sourceFile: string;
  email: string;
  name: string | null;
  kind:
    | 'ot_underpriced'
    | 'amount_mismatch'
    | 'missing_from_column'
    | 'record_amount_underpriced';
  hours: number;
  regHours: number;
  otHours: number;
  regularRatePhp: number | null;
  otRatePhp: number | null;
  blobAmountPhp: number | null;
  recordAmountPhp: number;
  expectedAmountPhp: number | null;
  shortfallPhp: number;
  lockedBy: string | null;
  lockedAt: string | null;
  note: string;
}

const findings: Finding[] = [];

for (const file of files) {
  const fileRows = rows.filter((r) => r.source_file === file);

  const { data: setting, error: settingErr } = await sb
    .from('app_settings')
    .select('value,updated_at')
    .eq('key', `payroll.wizard.additions.${file}`)
    .maybeSingle();
  if (settingErr) {
    // A read error is not "no divergence" — say so and move on rather than
    // reporting a clean week we never actually measured.
    console.log(`  ${file}\n    ! could not read the additions blob: ${settingErr.message}\n`);
    continue;
  }

  let amounts: Record<string, number> = {};
  let blobPresent = false;
  if (setting?.value) {
    try {
      const parsed = JSON.parse(setting.value as string) as { orphanageAmounts?: Record<string, number> };
      amounts = parsed.orphanageAmounts ?? {};
      blobPresent = true;
    } catch {
      console.log(`  ${file}\n    ! additions blob is not valid JSON\n`);
      continue;
    }
  }

  const lowerAmounts = new Map(Object.entries(amounts).map(([k, v]) => [k.toLowerCase(), Number(v)]));
  const fileFindings: Finding[] = [];

  for (const r of fileRows) {
    const blobAmount = lowerAmounts.has(r.employee_email.toLowerCase())
      ? (lowerAmounts.get(r.employee_email.toLowerCase()) as number)
      : null;

    // (1) + (2): does the RECORD's own amount stand up, and does the blob agree?
    const recordCheck = reconcileLockedOrphanageAmount({
      storedAmountPhp: r.amount_php,
      record: {
        hours: r.hours,
        regHours: r.reg_hours,
        otHours: r.ot_hours,
        regularRatePhp: r.regular_rate_php,
        otRatePhp: r.ot_rate_php,
      },
    });

    const base = {
      sourceFile: file,
      email: r.employee_email,
      name: r.employee_name,
      hours: r.hours,
      regHours: r.reg_hours,
      otHours: r.ot_hours,
      regularRatePhp: r.regular_rate_php,
      otRatePhp: r.ot_rate_php,
      blobAmountPhp: blobAmount,
      recordAmountPhp: r.amount_php,
      lockedBy: r.locked_by,
      lockedAt: r.locked_at,
    };

    if (recordCheck.status === 'ot_underpriced') {
      fileFindings.push({
        ...base,
        kind: 'record_amount_underpriced',
        expectedAmountPhp: recordCheck.expectedAmountPhp,
        shortfallPhp: recordCheck.shortfallPhp,
        note: recordCheck.message,
      });
      continue;
    }

    if (blobAmount == null) {
      if (!blobPresent) continue; // no blob for this week at all — nothing to compare
      fileFindings.push({
        ...base,
        kind: 'missing_from_column',
        expectedAmountPhp: r.amount_php,
        shortfallPhp: r.amount_php,
        note: 'hours on record, no amount on the Additions Orphanage column — these hours pay ₱0',
      });
      continue;
    }

    // The blob's own figure, checked against the record's hours and rates.
    const blobCheck = reconcileLockedOrphanageAmount({
      storedAmountPhp: blobAmount,
      record: {
        hours: r.hours,
        regHours: r.reg_hours,
        otHours: r.ot_hours,
        regularRatePhp: r.regular_rate_php,
        otRatePhp: r.ot_rate_php,
      },
    });
    if (blobCheck.status === 'ot_underpriced' || blobCheck.status === 'amount_mismatch') {
      fileFindings.push({
        ...base,
        kind: blobCheck.status,
        expectedAmountPhp: blobCheck.expectedAmountPhp,
        shortfallPhp: blobCheck.shortfallPhp,
        note: blobCheck.message,
      });
    }
  }

  if (fileFindings.length === 0) {
    console.log(`  ${file}\n    clean — ${fileRows.length} rows, blob ${blobPresent ? 'present' : 'ABSENT'}\n`);
    continue;
  }

  // NEVER net the two directions together. An underpayment and an overpayment do
  // not cancel: they are two different conversations, and a single netted figure
  // is how a report claims a week is nearly fine when two people are wrong.
  const under = round2(fileFindings.filter((f) => f.shortfallPhp > 0).reduce((s, f) => s + f.shortfallPhp, 0));
  const over = round2(fileFindings.filter((f) => f.shortfallPhp < 0).reduce((s, f) => s - f.shortfallPhp, 0));
  console.log(`  ${file}`);
  console.log(
    `    ${fileFindings.length} of ${fileRows.length} rows diverge · ` +
      `${php(under)} UNDERpaid` +
      (over > 0 ? ` · ${php(over)} OVERpaid` : ''),
  );
  for (const f of fileFindings.sort((a, b) => b.shortfallPhp - a.shortfallPhp)) {
    const rate = f.regularRatePhp;
    const shouldOt = rate != null ? round2(rate * ORPHANAGE_OT_MULTIPLIER) : null;
    const dir = f.shortfallPhp >= 0 ? 'UNDER' : 'OVER ';
    console.log(
      `      ${f.email.padEnd(28)} ${f.kind.padEnd(26)} ` +
        `on the column ${php(f.blobAmountPhp ?? 0).padStart(13)} → should be ${php(f.expectedAmountPhp ?? 0).padStart(13)} ` +
        `(${dir} by ${php(Math.abs(f.shortfallPhp))})`,
    );
    console.log(
      `        ${f.hours.toFixed(2)} h = ${f.regHours.toFixed(4)} reg + ${f.otHours.toFixed(4)} OT · ` +
        `reg ${rate != null ? php(rate) : '—'} · OT on record ${f.otRatePhp != null ? php(f.otRatePhp) : '—'}` +
        (shouldOt != null ? ` · OT should be ${php(shouldOt)}` : ''),
    );
    if (f.note) console.log(`        ${f.note}`);
  }
  console.log('');
  findings.push(...fileFindings);
}

const underRows = findings.filter((f) => f.shortfallPhp > 0);
const overRows = findings.filter((f) => f.shortfallPhp < 0);
const underTotal = round2(underRows.reduce((s, f) => s + f.shortfallPhp, 0));
const overTotal = round2(overRows.reduce((s, f) => s - f.shortfallPhp, 0));
console.log('─'.repeat(72));
console.log(`TOTAL: ${findings.length} diverging rows`);
console.log(`  UNDERpaid  ${String(underRows.length).padStart(4)} rows · ${php(underTotal)}`);
console.log(`  OVERpaid   ${String(overRows.length).padStart(4)} rows · ${php(overTotal)}`);
const byKind = new Map<string, { n: number; under: number; over: number }>();
for (const f of findings) {
  const cur = byKind.get(f.kind) ?? { n: 0, under: 0, over: 0 };
  byKind.set(f.kind, {
    n: cur.n + 1,
    under: round2(cur.under + Math.max(0, f.shortfallPhp)),
    over: round2(cur.over + Math.max(0, -f.shortfallPhp)),
  });
}
for (const [kind, agg] of [...byKind].sort((a, b) => b[1].under - a[1].under)) {
  console.log(
    `  ${kind.padEnd(28)} ${String(agg.n).padStart(4)} rows · under ${php(agg.under)} · over ${php(agg.over)}`,
  );
}
const sentStale = findings.filter((f) => /already SENT|ALREADY SENT/.test(f.note));
if (sentStale.length > 0) {
  console.log(
    `\n!! ${sentStale.length} of the stale stubs have ALREADY BEEN SENT — those people were ` +
      `told a number the column no longer agrees with.`,
  );
}
console.log(
  findings.length > 0
    ? '\nRepair in the wizard: Payroll Wizard → Orphanage → "Re-price". It re-runs the\n' +
        'same pricing a paste would, is audited, and never runs on its own.\n' +
        'A `missing_from_column` row has no amount to re-price — paste those hours again.\n' +
        '\nThis script does NOT answer whether a repaired column reached the paystub: a staged\n' +
        'stub is frozen at stage time, and the snapshot supersedes it only when it qualifies\n' +
        '(payment-dispatch.md, three carriers), which needs the Payment Catalog to evaluate.\n' +
        'After repairing amounts, UNLOCK and RE-LOCK the cycle so the stubs re-stage, and use\n' +
        'scripts/verify-dispatch-carryover.mts for the carrier question.'
    : '\nNothing to repair.',
);

if (jsonOut) {
  mkdirSync(dirname(jsonOut), { recursive: true });
  // Split, never netted — same reason as the console summary.
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        underpaidRows: underRows.length,
        underpaidTotalPhp: underTotal,
        overpaidRows: overRows.length,
        overpaidTotalPhp: overTotal,
        findings,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${findings.length} findings to ${jsonOut}`);
}
