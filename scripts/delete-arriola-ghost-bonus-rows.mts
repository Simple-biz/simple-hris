/**
 * Delete the two Lead Gen KPI rows keyed on Mark Arriola's GHOST name key
 * (audit item 384; Kane's go on the recommendation, 2026-10-08).
 *
 * `global_master_list` 327a7857 was the name-in-email ghost of 5dba371f
 * (`marka@`, off-boarded 2026-07-16). While it sat on `active_employees`, Lead
 * Gen kept scoring it:
 *   - 09-20: ₱750 (`Appts_Set 3`). The 3 come only from shielar@'s QC first pass.
 *     Jackie's 09-20 sheet has no Arriola line, so Override never touched the row
 *     (`qc-scoring.md`: Override applies to MISMATCH and PASTE_ONLY only).
 *   - 09-27: ₱0 (`Appts_Set 0`).
 * He has no hours after 07-18, and nothing was ever paid on any of his keys
 * after the 07-12 cycle.
 *
 * ## What it deletes
 *
 * Exactly those two `bonus_catalog_applied` rows, one `.eq('id')` each. The ids
 * hold the name key's quotes and comma, and inside `.in()` that silently matches
 * nothing (gml-roster-source-of-truth.md).
 *
 * It does NOT touch: shielar@'s `qc_kpi_submissions` rows (the officer's record,
 * not money), the sticky `qc_score_assignments` slots, either week's period
 * status, or Evardo's uncredited 09-20 appointments (item 400, paid on their own
 * evidence).
 *
 * ## Why it cannot come back
 *
 * The ghost is stamped 07-16 `duplicate_cleanup`, so it is on no week's table
 * after 07-16, and *Add missing people* lists it as a PROBLEM instead of adding
 * it (qc-scoring.md § Add missing). Check 2 proves that stamp is in place.
 *
 * ## What stops it
 *
 * Every check must pass, and any read that fails REFUSES `--apply`:
 *   1. each row still holds exactly what was measured (key, week, bonus, count,
 *      amount), so a later edit is never deleted unseen,
 *   2. the ghost is stamped 07-16 `duplicate_cleanup`,
 *   3. no other applied row is on the ghost key,
 *   4. nothing was ever disbursed or dispatched on the ghost key,
 *   5. Jackie's sheet for each week, where one is stored, has no Arriola line,
 *   6. neither week is `locked` (a locked week is reopened first).
 * The DELETE repeats check 1 as filters.
 *
 * READ-ONLY WITHOUT A FLAG. `--apply` deletes, and `--revert <backup>`
 * re-inserts the rows an `--apply` backup recorded. Both write a SELECT backup
 * to `docs/audits/backups/` (gitignored) first.
 *
 * Usage (PowerShell):
 *   node --import tsx scripts/delete-arriola-ghost-bonus-rows.mts                  # plan only
 *   node --import tsx scripts/delete-arriola-ghost-bonus-rows.mts --apply          # delete
 *   node --import tsx scripts/delete-arriola-ghost-bonus-rows.mts --revert <file>  # re-insert
 */
import dotenv from 'dotenv';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const revertAt = process.argv.indexOf('--revert');
const REVERT_FILE = revertAt === -1 ? null : process.argv[revertAt + 1] ?? '';
if (APPLY && REVERT_FILE !== null) {
  console.error('Pass --apply or --revert <backup>, not both.');
  process.exit(1);
}
if (REVERT_FILE === '' || REVERT_FILE?.startsWith('--')) {
  console.error('--revert needs the path of the backup an --apply run wrote.');
  process.exit(1);
}

const GHOST_ID = '327a7857-eddd-491f-886c-f0058c6cb45b';
const GHOST_KEY = 'arriola, mark anthony  "mark"';
const BONUS_ID = 'bonus_mq9yxlmsyj7avdmc';
const DEPT = 'lead_gen';
const REDATE_ACTOR = 'system:arriola-ghost-redate-2026-10-07';
/** Measured 2026-10-08. Anything different on the live row means someone edited it since. */
const ROWS = [
  { periodStart: '2026-09-20', appts: 3, amount: 750 },
  { periodStart: '2026-09-27', appts: 0, amount: 0 },
].map((r) => ({ ...r, id: `app:${r.periodStart}:${DEPT}:${GHOST_KEY}:${BONUS_ID}` }));

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('Supabase is not configured (.env.local)');
  process.exit(1);
}

const mode = APPLY ? 'APPLY' : REVERT_FILE !== null ? 'REVERT' : 'PLAN (read-only)';
console.log(`${mode} · bonus_catalog_applied rows on the Arriola ghost key ${JSON.stringify(GHOST_KEY)}\n`);

const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};
type Applied = Record<string, unknown> & { id: string; vars?: { Appts_Set?: unknown } | null };

// Every live row, read one `.eq('id')` at a time, before anything else.
const live: Array<Applied | null> = [];
for (const r of ROWS) {
  const { data, error } = await sb.from('bonus_catalog_applied').select('*').eq('id', r.id).maybeSingle();
  if (error) {
    console.error(`bonus_catalog_applied read failed (${r.periodStart}): ${error.message}`);
    process.exit(1);
  }
  live.push((data as Applied | null) ?? null);
}

// The SELECT backup, before anything can write. CLAUDE.md § Data.
const dir = join(process.cwd(), 'docs', 'audits', 'backups');
mkdirSync(dir, { recursive: true });
const backupPath = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-arriola-ghost-bonus-delete.json`);
writeFileSync(backupPath, JSON.stringify({ mode, takenAt: new Date().toISOString(), rows: live }, null, 2), 'utf8');
console.log(`Backup written: ${backupPath}\n`);

// ── --revert: re-insert what an --apply backup recorded ──────────────────────
if (REVERT_FILE !== null) {
  let applied: { mode?: string; rows?: Array<Applied | null> };
  try {
    applied = JSON.parse(readFileSync(REVERT_FILE, 'utf8'));
  } catch (e) {
    console.error(`Cannot read ${REVERT_FILE}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  const rows = (applied.rows ?? []).filter((r): r is Applied => !!r);
  console.log('guards:');
  check(applied.mode === 'APPLY', `backup is from an --apply run (mode = ${applied.mode ?? 'missing'})`);
  check(rows.length > 0 && rows.every((r) => ROWS.some((x) => x.id === r.id)), `backup holds only this script's rows (${rows.length})`);
  check(live.every((r) => r === null), 'none of them exists now (a re-insert never overwrites)');
  if (failures.length > 0) {
    console.error(`\nREFUSING: ${failures.length} guard(s) failed. Nothing written.`);
    process.exit(1);
  }
  const { data, error } = await sb.from('bonus_catalog_applied').insert(rows).select('id');
  if (error || (data ?? []).length !== rows.length) {
    console.error(`Re-insert failed: ${error?.message ?? `${(data ?? []).length} of ${rows.length} rows written`}`);
    process.exit(1);
  }
  console.log(`\nRe-inserted ${rows.length} row(s).`);
  process.exit(0);
}

// ── plan / --apply ───────────────────────────────────────────────────────────
console.log('guards:');

// 1. Each row still holds exactly what was measured.
ROWS.forEach((r, i) => {
  const row = live[i];
  check(
    !!row &&
      row.employee_email === GHOST_KEY &&
      row.department === DEPT &&
      row.period_start === r.periodStart &&
      row.bonus_id === BONUS_ID &&
      Number(row.amount) === r.amount &&
      row.vars?.Appts_Set === r.appts,
    `${r.periodStart} row is the measured one (₱${r.amount}, Appts_Set ${r.appts})` +
      (row ? ` — live: ₱${row.amount}, Appts_Set ${JSON.stringify(row.vars?.Appts_Set)}, by ${row.applied_by}` : ' — live: MISSING'),
  );
});

// 2. The ghost is retired, so nothing can deal it back onto a week's table.
const ghost = await sb.from('global_master_list').select('off_boarded_at, off_boarded_reason, off_boarded_by').eq('id', GHOST_ID).maybeSingle();
if (ghost.error || !ghost.data) check(false, `ghost master row readable (${ghost.error?.message ?? 'missing'})`);
else {
  const g = ghost.data as { off_boarded_at: string | null; off_boarded_reason: string | null; off_boarded_by: string | null };
  check(
    String(g.off_boarded_at ?? '').startsWith('2026-07-16') && g.off_boarded_reason === 'duplicate_cleanup' && g.off_boarded_by === REDATE_ACTOR,
    `ghost is stamped 07-16 duplicate_cleanup (${g.off_boarded_at ?? 'unstamped'} ${g.off_boarded_reason ?? ''})`,
  );
}

// 3. No other applied row is on the ghost key.
const all = await sb.from('bonus_catalog_applied').select('id').eq('employee_email', GHOST_KEY);
if (all.error) check(false, `applied rows on the ghost key readable (${all.error.message})`);
else {
  const extra = (all.data ?? []).filter((r: { id: string }) => !ROWS.some((x) => x.id === r.id));
  check(extra.length === 0, `no other applied row on the ghost key (${extra.length} found)`);
}

// 4. Nothing was ever paid on the ghost key.
const paid = await Promise.all([
  sb.from('disbursement_records').select('id').eq('recipient_email', GHOST_KEY),
  sb.from('payment_dispatches').select('id').eq('recipient_email', GHOST_KEY),
]);
const paidErr = paid.find((p) => p.error)?.error;
const paidCount = paid.reduce((n, p) => n + (p.data ?? []).length, 0);
if (paidErr) check(false, `disbursement_records / payment_dispatches readable (${paidErr.message})`);
else check(paidCount === 0, `nothing ever disbursed or dispatched on the ghost key (${paidCount} found)`);

// 5. Jackie's sheet has no Arriola line, for each week that has one stored.
for (const r of ROWS) {
  const s = await sb.from('app_settings').select('value').eq('key', `qc.compare_paste.${DEPT}.${r.periodStart}`).maybeSingle();
  if (s.error) {
    check(false, `${r.periodStart} sheet readable (${s.error.message})`);
    continue;
  }
  if (!s.data) {
    console.log(`  --    ${r.periodStart}: no sheet stored (nothing to check against)`);
    continue;
  }
  let text = '';
  try {
    const v = (s.data as { value: unknown }).value;
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    text = String((parsed as { text?: unknown })?.text ?? '');
  } catch {
    text = '';
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const hits = lines.filter((l) => /arriola|marka@simple\.biz|markarriola\.sos@/i.test(l));
  check(lines.length > 0 && hits.length === 0, `${r.periodStart} sheet (${lines.length} lines) has no Arriola line (${hits.length} found)`);
}

// 6. Neither week is locked.
const status = await sb.from('hsl_bonus_period_status').select('period_start, status').eq('department', DEPT).in('period_start', ROWS.map((r) => r.periodStart));
if (status.error) check(false, `period status readable (${status.error.message})`);
else
  for (const r of ROWS) {
    const st = (status.data ?? []).find((x: { period_start: string }) => x.period_start === r.periodStart)?.status ?? 'none';
    check(st !== 'locked', `${r.periodStart} week is not locked (${st})`);
  }

console.log('\nWOULD DELETE from bonus_catalog_applied:');
ROWS.forEach((r, i) => console.log(`  ${r.id}  (₱${live[i]?.amount ?? '?'}, applied_by ${live[i]?.applied_by ?? '?'})`));

if (failures.length > 0) {
  console.error(`\nREFUSING: ${failures.length} guard(s) failed. Nothing deleted.`);
  process.exit(1);
}
if (!APPLY) {
  console.log('\nPLAN ONLY — nothing deleted. Re-run with --apply to delete both rows.');
  process.exit(0);
}

// ── Delete, one exact row at a time ──────────────────────────────────────────
for (const r of ROWS) {
  const { data, error } = await sb
    .from('bonus_catalog_applied')
    .delete()
    .eq('id', r.id)
    .eq('employee_email', GHOST_KEY)
    .eq('period_start', r.periodStart)
    .eq('amount', r.amount)
    .select('id');
  if (error || (data ?? []).length !== 1) {
    console.error(`\nDelete failed on ${r.periodStart}: ${error?.message ?? `${(data ?? []).length} rows matched, expected 1`}. Backup: ${backupPath}`);
    process.exit(1);
  }
  console.log(`Deleted ${r.periodStart} (₱${r.amount}).`);
}
const left = await sb.from('bonus_catalog_applied').select('id').eq('employee_email', GHOST_KEY);
console.log(`Applied rows left on the ghost key: ${left.error ? `unreadable (${left.error.message})` : (left.data ?? []).length}`);
console.log(`Undo: node --import tsx scripts/delete-arriola-ghost-bonus-rows.mts --revert ${backupPath}`);
