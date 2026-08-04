/**
 * Fix the HSL people whose stored OT rate is `regular + 15` instead of `regular x 1.5`
 * — the HSL weekend premium mis-keyed into the OT-rate column.
 *
 * Found by scripts/audit-hsl-ot-ratio.mts; confirmed live-underpaying by
 * scripts/audit-hsl-ot-ratio-resolve.mts. Their REGULAR rates are correct, which is why
 * the 2026-07-29 divergence sweep (which compares regular rates) never saw them, and why
 * the Hogan-sheet rate match did not touch them either.
 *
 * The Hogan sheet derives its "OT Differential" as regular x 0.5 on every one of its
 * 6,791 rows, i.e. an effective OT rate of exactly 1.5x. So 1.5x is the authority here.
 *
 * RAISES ONLY — this can only ever increase an OT rate toward policy. Anyone already at
 * or above 1.5x is skipped, so nobody's pay is reduced.
 *
 * SAFE BY DEFAULT:
 *   npx tsx scripts/fix-hsl-ot-ratio.mts            # dry run
 *   npx tsx scripts/fix-hsl-ot-ratio.mts --apply    # write (backup taken first)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { resolveRateAsOfDate, buildRateHistoryByEmail } = await import(
  '../src/lib/payroll/rate-history-resolve'
);
const { defaultOtRate, isAutoOtRate } = await import('../src/lib/payment-catalog/pay-structure');
const { snapEffectiveFromIso } = await import('../src/lib/payroll/pay-week-effective-date');

const APPLY = process.argv.includes('--apply');
const weekArg = process.argv[process.argv.indexOf('--week') + 1];
const WEEK = /^\d{4}-\d{2}-\d{2}$/.test(weekArg ?? '') ? weekArg : '2026-07-26';
const eff = snapEffectiveFromIso(WEEK).iso!;

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

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
const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
const peso = (n: number) => '₱' + n.toFixed(2);

// HSL roster, so we only ever touch HSL.
const hsl = new Set<string>();
for (const r of await readAll('global_master_list')) {
  const dept = String(Object.entries(r).find(([k]) => k.toLowerCase() === 'department')?.[1] ?? '');
  const l = dept.trim().toLowerCase();
  if (!(l.startsWith('hsl') || l.includes('hogan'))) continue;
  for (const kk of ['Work Email', 'Personal Email']) {
    const e = norm(Object.entries(r).find(([k]) => k.toLowerCase() === kk.toLowerCase())?.[1]);
    if (e) hsl.add(e);
  }
}

const histRows = await readAll('employee_rate_history', 'employee_email, regular_rate, ot_rate, effective_from');
const byEmail = buildRateHistoryByEmail(histRows as never);
const weekDate = new Date(+eff.slice(0, 4), +eff.slice(5, 7) - 1, +eff.slice(8, 10));

type Fix = { email: string; reg: number; badOt: number; goodOt: number; gapPerOtHour: number; isPlus15: boolean };
const fixes: Fix[] = [];

for (const email of byEmail.keys()) {
  if (!hsl.has(email)) continue;                       // HSL ONLY
  const r = resolveRateAsOfDate(byEmail.get(email), weekDate);
  const reg = r?.regularRate ?? null;
  const ot = r?.otRate ?? null;
  if (reg == null || ot == null || reg <= 0) continue;
  if (isAutoOtRate(reg, ot)) continue;                 // already 1.5x
  const good = defaultOtRate(reg);
  if (ot >= good - 0.005) continue;                    // at or ABOVE policy — never lower
  fixes.push({
    email, reg, badOt: ot, goodOt: good,
    gapPerOtHour: Math.round((good - ot) * 100) / 100,
    isPlus15: Math.abs(ot - (reg + 15)) < 0.005,
  });
}
fixes.sort((a, b) => b.gapPerOtHour - a.gapPerOtHour);

console.log(APPLY ? '*** APPLY MODE ***' : 'DRY RUN — nothing will be written');
console.log(`effective_from: ${eff}   (HSL only, raises only)\n`);
console.log('='.repeat(96));
console.log(`OT rate BELOW policy 1.5x — ${fixes.length} HSL people`);
console.log('='.repeat(96));
for (const f of fixes) {
  console.log(
    `  ${f.email.padEnd(28)} reg=${String(f.reg).padStart(7)}  ot ${String(f.badOt).padStart(7)} -> ${String(f.goodOt).padStart(7)}` +
      `   +${peso(f.gapPerOtHour)}/OT-hr${f.isPlus15 ? '   (was reg+15 — weekend premium in the OT column)' : ''}`,
  );
}
console.log('='.repeat(96));
if (!APPLY) {
  console.log(`DRY RUN — ${fixes.length} row(s) would be inserted. Re-run with --apply.`);
  process.exit(0);
}
if (fixes.length === 0) { console.log('Nothing to do.'); process.exit(0); }

mkdirSync('references/backups', { recursive: true });
const affected = new Set(fixes.map((f) => f.email));
const backup = `references/backups/hsl_ot_ratio_fix_${eff}.json`;
writeFileSync(backup, JSON.stringify({
  effectiveFrom: eff, plan: fixes,
  existingHistory: histRows.filter((h) => affected.has(norm(h.employee_email))),
}, null, 2));
console.log(`backup written: ${backup}`);

let ok = 0;
for (const f of fixes) {
  const { error } = await sb.from('employee_rate_history').insert({
    employee_email: f.email,
    regular_rate: String(f.reg),
    ot_rate: String(f.goodOt),
    effective_from: eff,
    note: 'OT rate corrected to policy 1.5x (was weekend premium mis-keyed into the OT column)',
    created_by: `hsl-ot-ratio fix ${eff}`,
  });
  if (error) console.log(`  FAILED ${f.email}: ${error.message}`);
  else { ok++; console.log(`  wrote ${f.email}  reg=${f.reg} ot=${f.goodOt}`); }
}
console.log(`\ninserted ${ok}/${fixes.length}. Re-lock the wizard for this cycle to restage.`);
