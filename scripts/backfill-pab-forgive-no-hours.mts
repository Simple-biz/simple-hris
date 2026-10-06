/**
 * Clear the hours the Payroll Wizard's forgive paths used to STORE on a forgiven PAB day
 * (session log item 363, Kane's ruling (b), 2026-10-06).
 *
 * WHY: from 2026-07 to 2026-10-06 the wizard forgave a day by writing an hours override —
 * a flat 7 (PAB step "Forgive month" + the PAB Calendar's per-day Forgive) or, earlier, 5.
 * Kane: forgiveness must not add hours; a forgiven date keeps its original hours and
 * simply counts as forgiven. Since the ruling an approved issue with `override_hours`
 * NULL is forgiven outright (`approvedIssueForgivesDay`, src/lib/payroll/pab-forgiveness.ts),
 * and both wizard paths write null. The rows written BEFORE still carry 7/5, so every
 * employee-side calendar (Employee Dashboard, My Hours, People/Overview PAB Calendar)
 * shows them as `7:00`, and the People/Overview calendar reads them as plain passes
 * rather than forgiven. Measured 2026-10-06 (read-only): 19 rows — 15 Forgive-month
 * (Aug + Sep), 2 per-day at 5h (Jul 8–9), 2 per-day at 7h "schedule transition"
 * (Sep 25, Sep 30). None was an explicit hours decision.
 *
 * MONEY: NONE. Under the rule, 7 and 5 forgive (an explicit SET at >= 4h) and null
 * forgives (outright), so every row passes before AND after. Guard G2 asserts that per
 * row with the SAME function dispatch reads, and aborts if any row would change verdict.
 *
 * SAFE BY DEFAULT: the dry run prints every row it would touch and writes a JSON backup
 * of them to references/backups/ (gitignored). `--apply` writes. Idempotent: a converged
 * table reports 0 rows and exits 0.
 *
 *   npx tsx scripts/backfill-pab-forgive-no-hours.mts            # dry run
 *   npx tsx scripts/backfill-pab-forgive-no-hours.mts --apply    # write
 *
 * GUARDS (fail closed):
 *   G1 target = status 'approved', reason 'other', override_hours IN (5, 7) — the only
 *      shapes the wizard's forgive paths ever wrote; anything else is left alone and listed
 *   G2 approvedIssueForgivesDay(old) === approvedIssueForgivesDay(null) for every row
 *   G3 each UPDATE is conditional on the row still reading status 'approved' AND the old
 *      value, and must touch exactly one row — a row someone changed since the read is
 *      reported, never overwritten
 *   G4 re-read after the writes: every targeted row must now read null
 *
 * Each changed row gets one `pab_dispute.edited` audit row (previous / next), the action
 * the Issues queue's own Edit writes, so existing audit readers need nothing new.
 */
import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const ACTOR = 'kaner@simple.biz';
const SOURCE = 'scripts/backfill-pab-forgive-no-hours.mts (session log item 363)';
const TARGET_VALUES = new Set([5, 7]);

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const { insertAuditLog } = await import('../src/lib/supabase/audit-log');
const forgivenessMod: any = await import('../src/lib/payroll/pab-forgiveness');
const approvedIssueForgivesDay: (h: number | null) => boolean =
  (forgivenessMod.default ?? forgivenessMod).approvedIssueForgivesDay;

const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('Supabase service-role client unavailable — check .env.local');
  process.exit(1);
}
const die = (msg: string): never => {
  console.error(`\nABORT — ${msg}`);
  process.exit(2);
};

type Row = {
  id: string;
  work_email: string;
  dispute_date: string;
  reason: string;
  status: string;
  override_hours: number | null;
  explanation: string | null;
  decision_note: string | null;
  created_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  updated_at: string;
};

console.log(`${APPLY ? 'APPLY MODE' : 'DRY RUN (re-run with --apply to write)'} — clear stored hours on wizard-forgiven PAB days\n`);

// Every row carrying a numeric override, paged (PostgREST caps a read at 1000 rows).
const numeric: Row[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from('pab_day_disputes')
    .select('id, work_email, dispute_date, reason, status, override_hours, explanation, decision_note, created_by, decided_by, decided_at, updated_at')
    .not('override_hours', 'is', null)
    .order('id')
    .range(from, from + 999);
  if (error) die(`read failed: ${error.message}`);
  numeric.push(...((data ?? []) as Row[]));
  if ((data ?? []).length < 1000) break;
}

// G1
const targets = numeric.filter(
  (r) => r.status === 'approved' && r.reason === 'other' && r.override_hours != null && TARGET_VALUES.has(r.override_hours),
);
const leftAlone = numeric.filter((r) => !targets.includes(r));
console.log(`G1 numeric-override rows: ${numeric.length} · targeted: ${targets.length} · left alone: ${leftAlone.length}`);
for (const r of leftAlone) {
  console.log(`   left alone: ${r.dispute_date} ${r.work_email} status=${r.status} reason=${r.reason} override=${r.override_hours}`);
}
if (targets.length === 0) {
  console.log('\nCONVERGED — no wizard-forgiven row still stores hours. Nothing to do.');
  process.exit(0);
}

// G2 — verdict-neutral, by the rule dispatch reads
for (const r of targets) {
  if (approvedIssueForgivesDay(r.override_hours) !== approvedIssueForgivesDay(null)) {
    die(`G2: ${r.id} (${r.dispute_date} ${r.work_email}) override ${r.override_hours} would change PAB verdict`);
  }
}
console.log('G2 ok — every targeted row forgives its day before AND after (no PAB money moves)\n');

for (const r of [...targets].sort((a, b) => a.dispute_date.localeCompare(b.dispute_date))) {
  console.log(
    `   ${r.dispute_date}  ${r.work_email.padEnd(32)} ${String(r.override_hours).padStart(2)}h → null   "${(r.explanation ?? '').slice(0, 60)}"`,
  );
}

// Backup BEFORE any write, in both modes.
mkdirSync('references/backups', { recursive: true });
const backupPath = `references/backups/pab_forgive_override_pre_null_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(backupPath, JSON.stringify({ source: SOURCE, apply: APPLY, rows: targets }, null, 2));
console.log(`\nBackup written: ${backupPath} (${targets.length} rows)`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to clear the stored hours.');
  process.exit(0);
}

// G3 — conditional, one row at a time
const nowIso = new Date().toISOString();
const changed: Row[] = [];
const conflicts: string[] = [];
for (const r of targets) {
  const { data, error } = await sb
    .from('pab_day_disputes')
    .update({ override_hours: null, updated_at: nowIso })
    .eq('id', r.id)
    .eq('status', 'approved')
    .eq('override_hours', r.override_hours as number)
    .select('id');
  if (error) {
    conflicts.push(`${r.id}: ${error.message}`);
    continue;
  }
  if ((data ?? []).length !== 1) {
    conflicts.push(`${r.id}: changed since the read (touched ${(data ?? []).length} rows) — left as it is`);
    continue;
  }
  changed.push(r);
  const audit = await insertAuditLog({
    user_name: ACTOR,
    user_role: 'admin',
    action: 'pab_dispute.edited',
    resource: 'pab_day_disputes',
    resource_id: r.id,
    details: {
      employee: r.work_email,
      dispute_date: r.dispute_date,
      reason: r.reason,
      previous: { status: r.status, override_hours: r.override_hours, decision_note: r.decision_note, decided_by: r.decided_by },
      next: { status: r.status, override_hours: null, decision_note: r.decision_note, decided_by: r.decided_by },
      source: SOURCE,
      why: 'Forgiveness stores no hours (Kane 2026-10-06); verdict unchanged — the day was and is forgiven.',
    },
  });
  if (audit.error) console.warn(`   audit write failed for ${r.id}: ${audit.error} (the row change stands; see backup)`);
}

// G4 — re-read
const { data: after, error: afterErr } = await sb
  .from('pab_day_disputes')
  .select('id, override_hours')
  .in('id', changed.map((r) => r.id));
if (afterErr) die(`G4: re-read failed: ${afterErr.message}`);
const stillNumeric = (after ?? []).filter((r: { override_hours: number | null }) => r.override_hours !== null);

console.log(`\nChanged: ${changed.length} of ${targets.length}`);
for (const c of conflicts) console.log(`   NOT changed — ${c}`);
if (stillNumeric.length > 0) die(`G4: ${stillNumeric.length} changed row(s) still read a number on re-read`);
console.log('G4 ok — every changed row now reads null.');
process.exit(conflicts.length > 0 ? 3 : 0);
