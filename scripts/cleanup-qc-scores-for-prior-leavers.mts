/**
 * Remove `qc_kpi_submissions` rows for people who had already LEFT before the
 * week the row scores.
 *
 * READ-ONLY WITHOUT `--apply`. With `--apply` it deletes from PRODUCTION, and
 * refuses to start until a full SELECT backup of every row it intends to remove
 * is on disk.
 *
 * ## Why these rows exist
 *
 * A sheet sync with `clearOffboarded` re-activated 178 leavers — all stamped
 * July 2026 — back onto the active roster with `off_boarded_at = null`. The QC
 * deal drew from that roster and dealt them scoring slots every week, and
 * officers scored them. Measured 2026-09-14 for week `2026-09-06`: **203 of the
 * 374 Lead Gen people QC scored were not on the manager's table**, worth ₱7,000
 * of a ₱151,750 first pass.
 *
 * Ingest can no longer un-write an offboard and the stamps are repaired
 * (`scripts/backfill-offboard-stamps.mts`), so no NEW rows of this shape can
 * appear. This removes the ones already written. Kane, 2026-09-14, choosing (b):
 * Compare goes quiet on them and the refusal list shrinks to real cases.
 *
 * ## What it will not touch
 *
 * Only a row whose person has a **dated departure record STRICTLY BEFORE the
 * week the row scores**, resolved on **work email** through the same
 * `loadOffboardEvidenceByEmail('work')` every other surface uses.
 *
 *   - Someone who left DURING or AFTER the scored week keeps their row — they
 *     worked it, and their final scores are owed.
 *   - No evidence, or an undated record, keeps the row. Absence is never
 *     treated as proof of departure.
 *   - `bonus_catalog_applied` is NEVER touched. That is the money table; this
 *     one is the QC first pass, which the wizard does not read.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/cleanup-qc-scores-for-prior-leavers.mts         # plan
 *   node --import tsx scripts/cleanup-qc-scores-for-prior-leavers.mts --apply # deletes
 */
import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const { loadOffboardEvidenceByEmail } = await import('../src/lib/roster/offboard-evidence');
const { normEmail } = await import('../src/lib/email/norm-email');

const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('Supabase is not configured (.env.local)');
  process.exit(1);
}

async function pageAll<T = Record<string, unknown>>(table: string, select: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb!.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

console.log(`${APPLY ? 'APPLY' : 'PLAN (read-only)'}\n`);

type Sub = {
  id: string;
  period_start: string;
  department: string;
  employee_email: string;
  employee_name: string | null;
  bonus_name: string | null;
  amount: number | null;
};
const subs = await pageAll<Sub>(
  'qc_kpi_submissions',
  'id, period_start, department, employee_email, employee_name, bonus_name, amount',
);
console.log(`qc_kpi_submissions: ${subs.length} rows`);

// Work-email keyed, like every other surface. A personal inbox is shared across
// duplicate identities and would import someone else's departure.
const evidence = await loadOffboardEvidenceByEmail('work');
console.log(`offboard evidence: ${evidence.size} work emails`);

// A QC row records the PERSONAL-first member email, so resolve each one back to
// a work email through the master list before asking the evidence map.
const master = await pageAll<Record<string, unknown>>(
  'global_master_list',
  '"Work Email","Personal Email"',
);
const workByAny = new Map<string, string>();
for (const m of master) {
  const work = normEmail((m['Work Email'] as string) ?? null);
  if (!work) continue;
  for (const k of ['Work Email', 'Personal Email']) {
    const e = normEmail((m[k] as string) ?? null);
    if (e && !workByAny.has(e)) workByAny.set(e, work);
  }
}

const doomed: Array<Sub & { offDate: string; reason: string | null }> = [];
for (const r of subs) {
  const member = normEmail(r.employee_email);
  if (!member) continue;
  const work = workByAny.get(member) ?? member;
  const ev = evidence.get(work);
  if (!ev?.offDate) continue;
  // STRICTLY BEFORE the scored week. Left during or after it and the row stands.
  if (ev.offDate >= r.period_start) continue;
  doomed.push({ ...r, offDate: ev.offDate, reason: ev.reason });
}

const byWeek = new Map<string, number>();
const byDept = new Map<string, number>();
let amount = 0;
for (const d of doomed) {
  byWeek.set(d.period_start, (byWeek.get(d.period_start) ?? 0) + 1);
  byDept.set(d.department, (byDept.get(d.department) ?? 0) + 1);
  amount += Number(d.amount ?? 0);
}
console.log(`\nWOULD DELETE: ${doomed.length} rows · ${amount.toLocaleString()} in staged first-pass amounts\n`);
console.log('by scored week:');
for (const [w, n] of [...byWeek].sort()) console.log(`   ${w}  ${n}`);
console.log('\nby department:');
for (const [d, n] of [...byDept].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${d}`);
console.log('\nfirst 12:');
for (const d of doomed.slice(0, 12)) {
  console.log(`   wk ${d.period_start} · left ${d.offDate} · ${d.employee_name ?? d.employee_email} · ${d.bonus_name ?? '?'} · ${d.amount ?? 0}`);
}

if (doomed.length === 0) {
  console.log('\nNothing to do.');
  process.exit(0);
}

const dir = join(process.cwd(), 'docs', 'audits', 'backups');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = join(dir, `${stamp}-qc-scores-prior-leavers.json`);
writeFileSync(backupPath, JSON.stringify({ takenAt: new Date().toISOString(), rows: doomed }, null, 2), 'utf8');
console.log(`\nBackup written: ${backupPath}  (${doomed.length} rows, complete)`);

if (!APPLY) {
  console.log('\nPLAN ONLY — nothing deleted. Re-run with --apply.');
  process.exit(0);
}

console.log('\nDeleting…');
let deleted = 0;
let failed = 0;
for (let i = 0; i < doomed.length; i += 100) {
  const ids = doomed.slice(i, i + 100).map((d) => d.id);
  const { data, error } = await sb.from('qc_kpi_submissions').delete().in('id', ids).select('id');
  if (error) {
    failed += ids.length;
    console.error(`   FAIL batch ${i}: ${error.message}`);
    continue;
  }
  deleted += (data ?? []).length;
}
console.log(`\nrows deleted: ${deleted} · failures: ${failed}`);
console.log(`backup: ${backupPath}`);
if (failed > 0) process.exit(1);
