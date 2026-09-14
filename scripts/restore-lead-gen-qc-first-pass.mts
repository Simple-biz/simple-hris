/**
 * Copy the QC officers' first-pass counts into the manager's ₱0 applied rows for
 * one department-week.
 *
 * READ-ONLY WITHOUT `--apply`. With `--apply` it UPDATES `bonus_catalog_applied`
 * in PRODUCTION — the table the Payroll Wizard pays from — and refuses to start
 * until a full SELECT backup of every row it intends to change is on disk.
 *
 * ## Why these rows are ₱0
 *
 * Lead Gen week 2026-09-06 (measured 2026-09-14, `scripts/probe-lead-gen-*.mts`):
 * `bonus_catalog_applied` holds ₱38,000 / 218 rows / 18 non-zero, against 19
 * prior weeks of ₱150k–₱313k. `qc_kpi_submissions` for the same dept+week holds
 * ₱124,750 / 228 rows / 135 non-zero under the SAME keys. All 218 applied rows
 * were inserted in one write at 22:08:41Z, three seconds after a Compare
 * override, with `vars={"Appts_Set":0}` for 200 people QC had scored 1–17. The
 * QC→manager seed fires only while the week has zero saved rows, so it can never
 * fire again for this week: the money will not come back by reopening.
 *
 * It is a COUNT problem, not a price one — QC, this week and last week all pay
 * ₱250 × Appts_Set. This script copies QC's `vars` AND `amount` from the same QC
 * row, so the two stay consistent with each other. It never computes a rate.
 *
 * ## What it will not touch
 *
 *   - An applied row with amount > 0 — the 18 the override wrote, and anyone
 *     the manager has entered since. Their number stands.
 *   - An applied row whose QC row is ₱0 or absent. Absence is not a score.
 *   - A person whose QC row is under a DIFFERENT bonus than their applied row,
 *     or whose QC `vars` carry a different variable — listed, skipped.
 *   - A person with two conflicting QC rows for the same bonus — ambiguous,
 *     listed, skipped.
 *   - `qc_kpi_submissions` itself. It is read, never written.
 *
 * The UPDATE is pinned with `.eq('amount', 0)`: if someone types a value into a
 * cell between the plan and the apply, that row is left alone and counted.
 *
 * ## Refusals
 *
 *   - Week status is not `draft` → the plan prints, `--apply` refuses. A ready
 *     or locked week has a snapshot path; Kane reopens it first.
 *   - Staged paystub rows exist for this dept-week → printed as a warning; a
 *     re-lock in the wizard must follow the apply or the paystubs keep the old
 *     figure ([[paystub-staged-snapshot-stale]]). Not a refusal — the re-lock is
 *     the wizard's job, and it can only happen after this write.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/restore-lead-gen-qc-first-pass.mts            # plan
 *   node --import tsx scripts/restore-lead-gen-qc-first-pass.mts --apply    # writes
 *   … --dept=discovery --week=2026-09-13                                     # another dept-week
 */
import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const arg = (name: string, fallback: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DEPT = arg('dept', 'lead_gen');
const WEEK = arg('week', '2026-09-06');

if (!/^\d{4}-\d{2}-\d{2}$/.test(WEEK)) {
  console.error(`--week must be YYYY-MM-DD, got "${WEEK}"`);
  process.exit(1);
}

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');

const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('Supabase is not configured (.env.local)');
  process.exit(1);
}

type Row = Record<string, unknown>;
const peso = (n: number) => `₱${Math.round(n).toLocaleString('en-PH')}`;
const num = (v: unknown) => (v == null ? 0 : Number(v) || 0);
const key = (e: unknown) => String(e ?? '').trim().toLowerCase();

/** PostgREST truncates at 1000 rows even with .range() — always page. */
async function pageAll(table: string, select: string, filters: Array<[string, string]>): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb!.from(table).select(select);
    for (const [c, v] of filters) q = q.eq(c, v);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

console.log(`${APPLY ? 'APPLY' : 'PLAN (read-only)'} · ${DEPT} · week ${WEEK}\n`);

// ── Week status: the gate ────────────────────────────────────────────────────
const { data: statusRows, error: statusErr } = await sb
  .from('hsl_bonus_period_status')
  .select('department, period_start, status, updated_at, locked_at, locked_by')
  .eq('department', DEPT)
  .eq('period_start', WEEK);
if (statusErr) throw new Error(`hsl_bonus_period_status: ${statusErr.message}`);
const status = statusRows?.[0] as Row | undefined;
const statusName = String(status?.status ?? 'draft (no row)');
console.log(`week status: ${statusName}${status?.locked_at ? `  locked_at=${String(status.locked_at)} by ${String(status.locked_by)}` : ''}`);

// ── Staged paystubs: not a gate, but the re-lock warning ─────────────────────
const staged = await pageAll(
  'paystub_dispatch_queue',
  'pay_period, cycle_source_file, locked_at, sent_at',
  [['department_key', DEPT]],
);
const stagedThisWeek = staged.filter(
  (r) => String(r.pay_period ?? '').includes(WEEK) || String(r.cycle_source_file ?? '').includes(WEEK),
);
if (stagedThisWeek.length > 0) {
  const locked = stagedThisWeek.filter((r) => r.locked_at).length;
  const sent = stagedThisWeek.filter((r) => r.sent_at).length;
  console.log(
    `\n!! ${stagedThisWeek.length} staged paystub rows already exist for this dept-week (${locked} locked, ${sent} sent).`,
  );
  console.log('   The applied fix will NOT reach them on its own — a wizard re-lock must follow the apply.');
  if (sent > 0) console.log('   Some are already SENT: those people would need a corrected paystub, not just a re-lock.');
} else {
  console.log(`staged paystubs for this dept-week: none (nothing downstream holds the old figure yet)`);
}

// ── The two tables ───────────────────────────────────────────────────────────
const applied = await pageAll('bonus_catalog_applied', '*', [['department', DEPT], ['period_start', WEEK]]);
const qc = await pageAll('qc_kpi_submissions', '*', [['department', DEPT], ['period_start', WEEK]]);
console.log(`\nbonus_catalog_applied: ${applied.length} rows · ${peso(applied.reduce((s, r) => s + num(r.amount), 0))}`);
console.log(`qc_kpi_submissions:    ${qc.length} rows · ${peso(qc.reduce((s, r) => s + num(r.amount), 0))}`);

// QC rows keyed (email, bonus_id). Two rows for one key with different figures
// are ambiguous and refused; identical duplicates collapse.
const qcByKey = new Map<string, Row>();
const ambiguous = new Set<string>();
for (const r of qc) {
  const k = `${key(r.employee_email)}|${String(r.bonus_id)}`;
  const prev = qcByKey.get(k);
  if (prev && (num(prev.amount) !== num(r.amount) || JSON.stringify(prev.vars) !== JSON.stringify(r.vars))) {
    ambiguous.add(k);
  }
  qcByKey.set(k, r);
}
const qcByEmail = new Map<string, Row[]>();
for (const r of qc) {
  const e = key(r.employee_email);
  qcByEmail.set(e, [...(qcByEmail.get(e) ?? []), r]);
}

// ── Decide, per applied row ──────────────────────────────────────────────────
type Change = { applied: Row; qc: Row };
const changes: Change[] = [];
const skipped: string[] = [];
let untouchedNonZero = 0;
let untouchedNoQc = 0;

for (const a of applied) {
  if (num(a.amount) > 0) {
    untouchedNonZero += 1; // the override's rows, and anything typed since
    continue;
  }
  const email = key(a.employee_email);
  const k = `${email}|${String(a.bonus_id)}`;
  const q = qcByKey.get(k);
  const who = String(a.employee_name ?? email);

  if (!q) {
    const other = (qcByEmail.get(email) ?? []).filter((r) => num(r.amount) > 0);
    if (other.length > 0) {
      skipped.push(`${who} — QC scored ${peso(num(other[0].amount))} under "${String(other[0].bonus_name)}", applied row is "${String(a.bonus_name)}" (bonus mismatch)`);
    } else {
      untouchedNoQc += 1;
    }
    continue;
  }
  if (num(q.amount) <= 0) {
    untouchedNoQc += 1; // QC said zero; zero it stays
    continue;
  }
  if (ambiguous.has(k)) {
    skipped.push(`${who} — two conflicting QC rows for the same bonus`);
    continue;
  }
  const aVars = Object.keys((a.vars as Row) ?? {}).sort().join(',');
  const qVars = Object.keys((q.vars as Row) ?? {}).sort().join(',');
  if (aVars && qVars && aVars !== qVars) {
    skipped.push(`${who} — variable mismatch: applied has {${aVars}}, QC has {${qVars}}`);
    continue;
  }
  changes.push({ applied: a, qc: q });
}

// ── The plan ─────────────────────────────────────────────────────────────────
const total = changes.reduce((s, c) => s + num(c.qc.amount), 0);
console.log(`\nWOULD UPDATE: ${changes.length} applied rows · +${peso(total)}`);
console.log(`untouched: ${untouchedNonZero} rows already > 0 · ${untouchedNoQc} rows where QC is ₱0/absent · ${skipped.length} skipped`);

const hist = new Map<string, number>();
for (const c of changes) {
  const v = (c.qc.vars as Row) ?? {};
  const name = Object.keys(v)[0] ?? '?';
  const label = `${name}=${String(v[name])} → ${peso(num(c.qc.amount))}`;
  hist.set(label, (hist.get(label) ?? 0) + 1);
}
console.log('\nby count (what each row becomes):');
for (const [label, n] of [...hist].sort((x, y) => Number(x[0].split('=')[1]) - Number(y[0].split('=')[1]))) {
  console.log(`   ${String(n).padStart(4)}×  ${label}`);
}

console.log('\nfirst 12:');
for (const c of changes.slice(0, 12)) {
  console.log(
    `   ${String(c.applied.employee_name ?? c.applied.employee_email).slice(0, 34).padEnd(35)} ${JSON.stringify(c.applied.vars)} ₱0  →  ${JSON.stringify(c.qc.vars)} ${peso(num(c.qc.amount))}   (QC by ${String(c.qc.scored_by ?? '?')})`,
  );
}
if (skipped.length) {
  console.log('\nskipped — needs a human:');
  for (const s of skipped) console.log(`   ${s}`);
}

const after = applied.reduce((s, r) => s + num(r.amount), 0) + total;
console.log(`\nweek total after: ${peso(after)}  (now ${peso(applied.reduce((s, r) => s + num(r.amount), 0))})`);

if (changes.length === 0) {
  console.log('\nNothing to do.');
  process.exit(0);
}

// ── Backup FIRST — the rows as they are now, and the QC rows they come from ──
const dir = join(process.cwd(), 'docs', 'audits', 'backups');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = join(dir, `${stamp}-${DEPT}-${WEEK}-qc-first-pass-restore.json`);
writeFileSync(
  backupPath,
  JSON.stringify(
    {
      takenAt: new Date().toISOString(),
      department: DEPT,
      periodStart: WEEK,
      weekStatus: status ?? null,
      before: changes.map((c) => c.applied),
      source: changes.map((c) => c.qc),
    },
    null,
    2,
  ),
  'utf8',
);
console.log(`\nBackup written: ${backupPath}  (${changes.length} applied rows + their QC sources, complete)`);

if (!APPLY) {
  console.log('\nPLAN ONLY — nothing written. Re-run with --apply.');
  process.exit(0);
}

if (statusName !== 'draft' && statusName !== 'draft (no row)') {
  console.error(`\nREFUSED: week status is "${statusName}", not draft. Reopen the week in the KPI Calculator first, then re-run.`);
  process.exit(1);
}

// ── Apply — one row at a time, pinned to amount = 0 ──────────────────────────
console.log('\nUpdating…');
let updated = 0;
let raced = 0;
let failed = 0;
for (const c of changes) {
  const { data, error } = await sb
    .from('bonus_catalog_applied')
    .update({ vars: c.qc.vars, amount: c.qc.amount })
    .eq('id', c.applied.id as string)
    .eq('amount', 0)
    .select('id');
  if (error) {
    failed += 1;
    console.error(`   FAIL ${String(c.applied.employee_email)}: ${error.message}`);
    continue;
  }
  if ((data ?? []).length === 0) {
    raced += 1; // someone typed a value since the plan — theirs stands
    console.log(`   left alone (no longer ₱0): ${String(c.applied.employee_name ?? c.applied.employee_email)}`);
    continue;
  }
  updated += 1;
}
console.log(`\nrows updated: ${updated} · left alone because no longer ₱0: ${raced} · failures: ${failed}`);
console.log(`backup: ${backupPath}`);
if (stagedThisWeek.length > 0) console.log('\nREMINDER: staged paystubs exist for this dept-week — re-lock in the wizard so they pick up the new figures.');
if (failed > 0) process.exit(1);
