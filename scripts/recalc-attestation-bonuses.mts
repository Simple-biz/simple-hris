/**
 * One-off recalc after the 2026-07-27 Attestation tier-threshold correction
 * (30/40/50 → 25/35/50 to match the manager sheet formula).
 *
 * Recomputes `hsl_bonus_entries.calculated_bonus` from each row's own kpi_data
 * for dept 'attestation' ONLY, and only where the stored amount differs from
 * the current schema.ts tiers. kpi_data (manager-entered case counts), period
 * keys and status rows are never touched. Rows already matching are skipped,
 * so the script is idempotent.
 *
 * Safety: refuses to touch a period whose hsl_bonus_period_status is 'locked'
 * (locked = payroll consumed it; correcting those needs an explicit decision).
 * Writes a full-row JSON backup to references/backups/ (gitignored) before
 * updating anything.
 *
 * Dry run (default):  $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"; npx tsx scripts/recalc-attestation-bonuses.mts
 * Apply:              ... npx tsx scripts/recalc-attestation-bonuses.mts --apply
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'node:fs';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');

const { HSL_DEPTS, calcBonus } = await import('../src/lib/hsl-bonus/schema');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const db = createClient(url, key);

const { data: entries, error } = await db
  .from('hsl_bonus_entries')
  .select('*')
  .eq('department', 'attestation');
if (error) { console.error('read err:', error.message); process.exit(1); }

const { data: statuses, error: e2 } = await db
  .from('hsl_bonus_period_status')
  .select('period_start, period_end, status')
  .eq('department', 'attestation');
if (e2) { console.error('status err:', e2.message); process.exit(1); }
const lockedPeriods = new Set(
  (statuses ?? []).filter((s) => s.status === 'locked').map((s) => `${s.period_start}..${s.period_end}`),
);

type Row = { id: string; period_start: string; period_end: string; employee_email: string; employee_name: string; is_manager: boolean; kpi_data: Record<string, unknown> | null; calculated_bonus: number | string | null };
const stale: { row: Row; fresh: number; stored: number }[] = [];
let skippedLocked = 0;
for (const row of (entries ?? []) as Row[]) {
  const fresh = calcBonus((row.kpi_data ?? {}) as Record<string, number | boolean>, HSL_DEPTS.attestation, row.is_manager);
  const stored = Number(row.calculated_bonus ?? 0);
  if (fresh === stored) continue;
  if (lockedPeriods.has(`${row.period_start}..${row.period_end}`)) {
    skippedLocked++;
    console.log(`LOCKED — skipped ${row.period_start}..${row.period_end} ${row.employee_name}: stored=${stored} would-be=${fresh}`);
    continue;
  }
  stale.push({ row, fresh, stored });
}

console.log(`attestation entries: ${entries?.length ?? 0}; stale (unlocked): ${stale.length}; stale-but-locked: ${skippedLocked}`);
for (const s of stale) {
  console.log(`  ${s.row.period_start}..${s.row.period_end} ${s.row.employee_name} <${s.row.employee_email}> cases=${Number(s.row.kpi_data?.attested_cases ?? 0)} P${s.stored} -> P${s.fresh}`);
}
const delta = stale.reduce((t, s) => t + (s.fresh - s.stored), 0);
console.log(`total delta: P${delta}`);

if (!APPLY) { console.log('\nDry run — re-run with --apply to write.'); process.exit(0); }
if (stale.length === 0) { console.log('Nothing to update.'); process.exit(0); }

mkdirSync('references/backups', { recursive: true });
const backupPath = `references/backups/attestation-recalc-backup-${stale.length}-rows.json`;
writeFileSync(backupPath, JSON.stringify(stale.map((s) => s.row), null, 2));
console.log(`backup written: ${backupPath}`);

let ok = 0;
for (const s of stale) {
  const { error: ue } = await db
    .from('hsl_bonus_entries')
    .update({ calculated_bonus: s.fresh })
    .eq('id', s.row.id);
  if (ue) { console.error(`UPDATE FAILED id=${s.row.id} (${s.row.employee_email}): ${ue.message}`); continue; }
  ok++;
}
console.log(`updated ${ok}/${stale.length} rows.`);
