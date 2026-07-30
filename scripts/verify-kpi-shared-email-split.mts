/**
 * READ-ONLY verifier for shared-email KPI attribution (manager-bonus-attribution).
 *
 * One email sitting on TWO master-list rows used to merge both people's KPI
 * Calculator bonuses into a single per-email sum, paying the combined figure
 * to BOTH (2026-07-30 incident: Rhocel Bencito + John Marc Corpuz sharing
 * corpuzmachacon@gmail.com → 11,167 staged on each paystub).
 *
 * This script runs the REAL production module — buildSharedEmailOwners +
 * attributeKpiRows, the exact functions the Payroll Wizard resolves KPI Sub.
 * with — against the live master list and the live week's applied rows, and
 * prints, for every flagged email: the old merged sum vs the per-person split
 * and any unattributable rows (paid to nobody).
 *
 * Usage:
 *   node --import tsx scripts/verify-kpi-shared-email-split.mts [period_start]
 *
 * Omitted [period_start] = the pay week of the current Hubstaff upload.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const { createClient } = await import('@supabase/supabase-js');
const { buildSharedEmailOwners, attributeKpiRows, roundedKpiTotals, summarizeSharedEmail } = await import(
  '../src/lib/payroll/manager-bonus-attribution'
);
const { MANAGER_BONUS_DEPT_KEYS } = await import('../src/lib/payroll/department-bonus');
const { isFinalPayrollWeekOfMonth } = await import('../src/lib/payroll/bonus-cadence');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (.env/.env.local)');
  process.exit(1);
}
const supabase = createClient(url, key);

// ── Which week? ───────────────────────────────────────────────────────────────
let periodStart = process.argv[2] ?? null;
if (!periodStart) {
  const up = await supabase
    .from('hubstaff_uploads')
    .select('source_file')
    .eq('is_current', true)
    .limit(1)
    .maybeSingle();
  const m = /(\d{4}-\d{2}-\d{2})_to_\d{4}-\d{2}-\d{2}/.exec(up.data?.source_file ?? '');
  if (m) {
    const [y, mo, d] = m[1].split('-').map(Number);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
    periodStart = dt.toISOString().slice(0, 10);
  }
}
if (!periodStart) {
  console.error('Could not resolve a pay week — pass one: verify-kpi-shared-email-split.mts 2026-07-19');
  process.exit(1);
}
console.log(`Pay week: ${periodStart}`);

// ── The live master list → shared-email owners (the wizard's exact inputs) ────
const master: {
  name: string | null;
  work_email: string | null;
  personal_email: string | null;
  alternate_work_email: string | null;
  alternate_work_email_2: string | null;
}[] = [];
for (let from = 0; ; from += 1000) {
  const page = await supabase
    .from('active_employees')
    .select('"Name", "Work Email", "Personal Email", "Alternate Work Email", "Alternate Work Email 2"')
    .is('off_boarded_at', null)
    .range(from, from + 999);
  if (page.error) {
    console.error('active_employees:', page.error.message);
    process.exit(1);
  }
  for (const r of (page.data ?? []) as Record<string, string | null>[]) {
    master.push({
      name: r['Name'] ?? null,
      work_email: r['Work Email'] ?? null,
      personal_email: r['Personal Email'] ?? null,
      alternate_work_email: r['Alternate Work Email'] ?? null,
      alternate_work_email_2: r['Alternate Work Email 2'] ?? null,
    });
  }
  if ((page.data ?? []).length < 1000) break;
}
const shared = buildSharedEmailOwners(master);
console.log(`Master rows: ${master.length} · emails on 2+ differently-named rows: ${shared.size}`);
for (const [email, owners] of shared) {
  console.log(`  ${email} → ${owners.map((o) => o.displayName).join('  |  ')}`);
}

// ── The week's applied rows for ready/locked manager-KPI departments ──────────
const status = await supabase
  .from('hsl_bonus_period_status')
  .select('department, status')
  .eq('period_start', periodStart)
  .in('status', ['ready', 'locked'])
  .in('department', [...MANAGER_BONUS_DEPT_KEYS]);
const depts = (status.data ?? []).map((r) => r.department);
console.log(`Ready/locked KPI departments for ${periodStart}: ${depts.join(', ') || '(none)'}`);

const applied = await supabase
  .from('bonus_catalog_applied')
  .select('department, employee_email, employee_name, amount, cadence')
  .eq('period_start', periodStart)
  .in('department', depts.length > 0 ? depts : ['__none__']);
const isFinalWeek = isFinalPayrollWeekOfMonth(periodStart);
const rowsByEmail = new Map<string, { dept: string; name: string | null; amount: number }[]>();
for (const r of applied.data ?? []) {
  const em = (r.employee_email ?? '').toLowerCase();
  if (!em) continue;
  if (r.cadence === 'monthly' && !isFinalWeek) continue;
  const list = rowsByEmail.get(em) ?? [];
  list.push({ dept: r.department, name: (r.employee_name ?? '').trim() || null, amount: Number(r.amount ?? 0) });
  rowsByEmail.set(em, list);
}

// ── The verdicts ──────────────────────────────────────────────────────────────
let flagged = 0;
for (const [email, rows] of rowsByEmail) {
  const owners = shared.get(email);
  if (!owners) continue;
  flagged++;
  const merged = Math.round(rows.reduce((s, r) => s + r.amount, 0));
  const summary = summarizeSharedEmail(rows, owners);
  console.log(`\n⚠ ${email} — OLD behavior paid EVERY claimant the merged ${merged}. New split:`);
  for (const o of summary.perOwner) {
    const mine = attributeKpiRows(rows, owners, o.displayName).mine;
    const t = roundedKpiTotals(mine);
    console.log(
      `   ${o.displayName}: ${t.total}  (${Object.entries(t.byDept)
        .map(([d, a]) => `${d}: ${a}`)
        .join(', ') || 'no rows'})`,
    );
  }
  if (summary.unattributed.length > 0) {
    console.log(`   UNATTRIBUTED (paid to nobody, fix the master list):`);
    for (const r of summary.unattributed) console.log(`     ${r.dept} "${r.name ?? '(blank)'}" = ${r.amount}`);
  }
}
if (flagged === 0) {
  console.log(`\nNo shared-email KPI rows for ${periodStart} — nothing to split. ✔`);
}
