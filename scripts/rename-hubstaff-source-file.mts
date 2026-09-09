/**
 * Rename a Hubstaff upload's `source_file` across EVERY table and app_settings key
 * that keys a payroll week by filename, then re-seed the week's disbursement_records.
 *
 * Why this exists instead of the shipped Payroll Wizard rename button:
 * `renameHubstaffSourceFile` (src/lib/supabase/hubstaff-hours-db.ts) migrates only
 * `payroll.wizard.final_pay.<file>` out of app_settings. A locked, already-paid week
 * carries six more filename-keyed settings — the per-cycle FX rate, the additions
 * blob, the paused-department set, the dispatch lock, the overview snapshot and the
 * cycle-complete flag. Renaming with the button strands all six: the wizard would
 * replay the week with no additions and FX 0 (Step 8 is hard-gated at 0), which is a
 * worse bug than the one being fixed. This script moves EVERY key whose suffix is the
 * old filename, discovered from the database rather than from a hardcoded list, so a
 * key nobody enumerated is caught instead of stranded.
 *
 * The immediate case (2026-09-09): the 2026-08-23 → 08-29 week landed as
 * `simple-biz_daily_report_2026-08-23_to_2026-08-29 (1).csv` — the browser's
 * duplicate-download suffix. Four independent copies of a junk-file heuristic,
 * /backfill|time-activity|\(\d+\)|copy/i, treat "(1)" as an accidental re-upload, so a
 * fully paid week (1,101 hour rows, 1,069 dispatches) was hidden from the Payment
 * Dispatch week selector and never seeded a single disbursement_record — leaving it
 * absent from Reports, CEO Financial Reports and People payroll history.
 *
 * SAFE BY DEFAULT: dry-run. It resolves the plan, writes the backup, and prints every
 * write it WOULD make. Re-run with --apply to perform them.
 *
 *   npx tsx scripts/rename-hubstaff-source-file.mts \
 *     --from "simple-biz_daily_report_2026-08-23_to_2026-08-29 (1).csv" \
 *     --to   "simple-biz_daily_report_2026-08-23_to_2026-08-29.csv"
 *
 *   ... --apply    # perform the writes
 *   ... --no-seed  # rename only, skip the disbursement_records re-seed
 *
 * ORDER IS LOAD-BEARING. disbursement_records is renamed BEFORE payment_dispatches:
 * the sync trigger on payment_dispatches matches disbursement_records on
 * cycle_source_file, so the disbursement rows must already carry the new name by the
 * time that trigger fires. The re-seed runs LAST, after payment_dispatches carries the
 * new name, so the 1,069 dispatch rows stamp the fresh records paid instead of
 * seeding a phantom fully-unpaid cycle.
 *
 * .env.local holds PRODUCTION service-role credentials. Nothing here writes without
 * --apply, and --apply refuses to run if the backup could not be written to disk.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

dotenv.config({ path: '.env.local' });
dotenv.config();

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const SEED = !argv.includes('--no-seed');
const argOf = (flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const FROM = argOf('--from');
const TO = argOf('--to');
if (!FROM || !TO) {
  console.error('usage: --from "<current filename>" --to "<new filename>" [--apply] [--no-seed]');
  process.exit(1);
}
if (FROM === TO) {
  console.error('--from and --to are identical; nothing to do.');
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const HOURS_TABLE = process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || 'hubstaff_hours';

/** The four filters that decide whether a week is visible at all. Kept here so the
 *  dry run can say out loud whether the NEW name actually clears them — a rename to
 *  another name that trips the same heuristic would "succeed" and fix nothing. */
const JUNK_HEURISTIC = /backfill|time-activity|\(\d+\)|copy/i;

const die = (msg: string): never => {
  console.error(`\nABORT — ${msg}`);
  process.exit(1);
};

/** Page through a filtered select. PostgREST caps a select at 1000 rows even with
 *  .range(), so a single read here would under-report the blast radius. */
async function pageAll<T>(table: string, columns: string, col: string, val: string): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select(columns).eq(col, val).range(from, from + PAGE - 1);
    if (error) {
      if (/relation .* does not exist/i.test(error.message)) return [];
      die(`read ${table}.${col}: ${error.message}`);
    }
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

console.log(`\n${APPLY ? 'APPLY' : 'DRY RUN'} — rename Hubstaff source_file`);
console.log(`  from  ${FROM}`);
console.log(`  to    ${TO}\n`);

if (JUNK_HEURISTIC.test(TO)) {
  die(
    `the NEW name still matches the junk-file heuristic /backfill|time-activity|\\(\\d+\\)|copy/i.\n` +
      `        Renaming to it would keep the week hidden from the dispatch week selector, the\n` +
      `        disbursement seed, CEO Financial Reports and the People roster. Pick another name.`,
  );
}

// ── Preflight ───────────────────────────────────────────────────────────────────
const { data: fromUploads, error: fromErr } = await db
  .from('hubstaff_uploads')
  .select('id, source_file, uploaded_at, uploaded_by, row_count, is_current')
  .eq('source_file', FROM);
if (fromErr) die(`read hubstaff_uploads: ${fromErr.message}`);
if (!fromUploads || fromUploads.length === 0) die(`no hubstaff_uploads row named "${FROM}".`);
if (fromUploads.length > 1) {
  die(
    `${fromUploads.length} hubstaff_uploads rows share "${FROM}" — that is the double-ingest\n` +
      `        condition. Run scripts/cleanup-duplicate-hubstaff-uploads.mjs first; renaming a\n` +
      `        split batch would merge two upload_ids under one name permanently.`,
  );
}

// Collision guards — the new name must be free everywhere it becomes a key.
const { data: clashUpload } = await db.from('hubstaff_uploads').select('id').eq('source_file', TO).limit(1);
if (clashUpload && clashUpload.length > 0) die(`an upload named "${TO}" already exists.`);
const { data: clashHours } = await db.from(HOURS_TABLE).select('id').eq('source_file', TO).limit(1);
if (clashHours && clashHours.length > 0) die(`rows tagged "${TO}" already exist in ${HOURS_TABLE}.`);

// ── Gather everything that carries the old name ─────────────────────────────────
const hours = await pageAll<{ id: string; source_file: string }>(HOURS_TABLE, 'id, source_file', 'source_file', FROM);
const disbursements = await pageAll<{ id: string; source_file: string }>(
  'disbursement_records',
  'id, source_file',
  'source_file',
  FROM,
);
const dispatches = await pageAll<{ id: string; cycle_source_file: string }>(
  'payment_dispatches',
  'id, cycle_source_file',
  'cycle_source_file',
  FROM,
);

/**
 * app_settings keys are discovered, never enumerated. `_` is a single-character
 * wildcard in LIKE and the filename is full of them, so the LIKE is only a coarse
 * prefilter — the exact suffix match happens in JS.
 */
const likeNeedle = `%${FROM.replace(/[%_]/g, '_')}`;
const { data: settingCandidates, error: setErr } = await db
  .from('app_settings')
  .select('key, value, updated_at')
  .like('key', likeNeedle);
if (setErr) die(`read app_settings: ${setErr.message}`);
const settings = ((settingCandidates ?? []) as { key: string; value: string | null; updated_at: string | null }[])
  .filter((s) => s.key.endsWith(FROM))
  .map((s) => ({ ...s, newKey: `${s.key.slice(0, s.key.length - FROM.length)}${TO}` }));

// A destination key that already exists would be silently overwritten by an upsert.
const destKeys = settings.map((s) => s.newKey);
let destClashes: string[] = [];
if (destKeys.length > 0) {
  const { data: existing } = await db.from('app_settings').select('key').in('key', destKeys);
  destClashes = ((existing ?? []) as { key: string }[]).map((r) => r.key);
}

console.log('  Carrying the old name');
console.log(`    hubstaff_uploads       ${String(fromUploads.length).padStart(5)}`);
console.log(`    ${HOURS_TABLE.padEnd(22)} ${String(hours.length).padStart(5)}`);
console.log(`    disbursement_records   ${String(disbursements.length).padStart(5)}`);
console.log(`    payment_dispatches     ${String(dispatches.length).padStart(5)}`);
console.log(`    app_settings           ${String(settings.length).padStart(5)}`);
for (const s of settings) {
  const embeds = s.value?.includes(FROM) ? '  [value also embeds the filename]' : '';
  console.log(`      · ${s.key.slice(0, s.key.length - FROM.length)}<file>${embeds}`);
}
if (destClashes.length > 0) {
  die(
    `these destination app_settings keys already exist and would be overwritten:\n` +
      destClashes.map((k) => `          ${k}`).join('\n'),
  );
}

// ── Backup, before any write ────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(process.cwd(), 'references', 'backups');
const backupFile = path.join(backupDir, `hubstaff-rename_${TO.replace(/[^\w.-]/g, '_')}_${stamp}.json`);
try {
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(
    backupFile,
    JSON.stringify(
      {
        takenAt: new Date().toISOString(),
        from: FROM,
        to: TO,
        note:
          'Restore set for a Hubstaff source_file rename. Only the keyed column changed in ' +
          'hubstaff_uploads/hubstaff_hours/disbursement_records/payment_dispatches, so id + the ' +
          'old value is a complete restore. app_settings rows are captured in FULL because the ' +
          'rename deletes the old key.',
        hubstaff_uploads: fromUploads,
        [HOURS_TABLE]: hours,
        disbursement_records: disbursements,
        payment_dispatches: dispatches,
        app_settings: settings,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\n  Backup written → ${path.relative(process.cwd(), backupFile)}`);
} catch (e) {
  die(`could not write the backup (${e instanceof Error ? e.message : String(e)}). No writes attempted.`);
}

if (!APPLY) {
  console.log('\n  DRY RUN — nothing written. Re-run with --apply to perform the rename.');
  if (SEED) {
    console.log(`  --apply would then re-seed disbursement_records for "${TO}".`);
  }
  process.exit(0);
}

// ── Apply ───────────────────────────────────────────────────────────────────────
console.log('\n  Applying…');

{
  const { error } = await db.from('hubstaff_uploads').update({ source_file: TO }).eq('source_file', FROM);
  if (error) die(`hubstaff_uploads: ${error.message}`);
  console.log(`    hubstaff_uploads       renamed`);
}
{
  const { error, count } = await db
    .from(HOURS_TABLE)
    .update({ source_file: TO }, { count: 'exact' })
    .eq('source_file', FROM);
  if (error) die(`${HOURS_TABLE}: ${error.message}`);
  console.log(`    ${HOURS_TABLE.padEnd(22)} ${String(count ?? 0).padStart(5)} rows`);
}
// BEFORE payment_dispatches — the dispatch sync trigger matches on cycle_source_file.
{
  const { error, count } = await db
    .from('disbursement_records')
    .update({ source_file: TO }, { count: 'exact' })
    .eq('source_file', FROM);
  if (error && !/relation .* does not exist/i.test(error.message)) die(`disbursement_records: ${error.message}`);
  console.log(`    disbursement_records   ${String(count ?? 0).padStart(5)} rows`);
}
{
  const { error, count } = await db
    .from('payment_dispatches')
    .update({ cycle_source_file: TO }, { count: 'exact' })
    .eq('cycle_source_file', FROM);
  if (error && !/relation .* does not exist/i.test(error.message)) die(`payment_dispatches: ${error.message}`);
  console.log(`    payment_dispatches     ${String(count ?? 0).padStart(5)} rows`);
}

/**
 * app_settings: move every discovered key. A value that embeds the filename is
 * rewritten too — the cycle key appears inside the final_pay snapshot's
 * `source_file` field, and the shipped rename already rewrites that. Occurrences are
 * replaced verbatim rather than by field name so a blob that names the cycle
 * somewhere else does not keep pointing at a filename that no longer exists.
 */
for (const s of settings) {
  const value = s.value && s.value.includes(FROM) ? s.value.split(FROM).join(TO) : s.value;
  const { error: upErr } = await db
    .from('app_settings')
    .upsert({ key: s.newKey, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (upErr) die(`app_settings upsert ${s.newKey}: ${upErr.message}`);
  const { error: delErr } = await db.from('app_settings').delete().eq('key', s.key);
  if (delErr) die(`app_settings delete ${s.key}: ${delErr.message}`);
}
console.log(`    app_settings           ${String(settings.length).padStart(5)} keys moved`);

// ── Verify: nothing may still carry the old name ────────────────────────────────
console.log('\n  Verifying…');
const leftovers: string[] = [];
for (const [table, col] of [
  ['hubstaff_uploads', 'source_file'],
  [HOURS_TABLE, 'source_file'],
  ['disbursement_records', 'source_file'],
  ['payment_dispatches', 'cycle_source_file'],
] as const) {
  const rows = await pageAll<{ id: string }>(table, 'id', col, FROM);
  const after = await pageAll<{ id: string }>(table, 'id', col, TO);
  console.log(`    ${table.padEnd(22)} old=${String(rows.length).padStart(5)}  new=${String(after.length).padStart(5)}`);
  if (rows.length > 0) leftovers.push(`${table}.${col}`);
}
{
  const { data: stale } = await db.from('app_settings').select('key').like('key', likeNeedle);
  const still = ((stale ?? []) as { key: string }[]).filter((s) => s.key.endsWith(FROM));
  console.log(`    app_settings           old=${String(still.length).padStart(5)}`);
  if (still.length > 0) leftovers.push('app_settings');
}
if (leftovers.length > 0) {
  die(`these still carry the old name: ${leftovers.join(', ')}. Backup is at ${backupFile}.`);
}

// ── Audit ───────────────────────────────────────────────────────────────────────
{
  const { error } = await db.from('audit_log').insert({
    user_name: 'script:rename-hubstaff-source-file',
    user_role: 'service',
    action: 'csv.rename',
    resource: 'hubstaff_hours',
    resource_id: TO,
    details: {
      from: FROM,
      to: TO,
      uploads: fromUploads.length,
      hours: hours.length,
      disbursements: disbursements.length,
      dispatches: dispatches.length,
      app_settings: settings.map((s) => s.key),
      backup: path.relative(process.cwd(), backupFile),
    },
  });
  if (error) console.warn(`    audit_log insert failed (rename still applied): ${error.message}`);
  else console.log('    audit_log              csv.rename recorded');
}

// ── Re-seed the week's disbursement_records ─────────────────────────────────────
if (!SEED) {
  console.log('\n  --no-seed: skipping the disbursement_records re-seed.');
  console.log(`  Reports / CEO Financial Reports stay blank for this week until it is seeded.`);
  process.exit(0);
}

console.log('\n  Re-seeding disbursement_records (uses the wizard calculator; may take a minute)…');
try {
  const { seedMissingDisbursementRecords } = await import('../src/lib/payroll/disbursement-reports');
  const result = await seedMissingDisbursementRecords({ sourceFiles: [TO] });
  if (result.error) die(`seed failed: ${result.error}. The rename itself is applied and verified.`);
  console.log(`    seeded ${result.seeded} record(s)`);
  const after = await pageAll<{ id: string }>('disbursement_records', 'id', 'source_file', TO);
  console.log(`    disbursement_records for "${TO}": ${after.length}`);
  if (after.length === 0) {
    console.warn('    WARNING: still zero. Check isSeedableWeeklyUpload against the new filename.');
  }
} catch (e) {
  console.error(`\n  Seed step could not run: ${e instanceof Error ? e.message : String(e)}`);
  console.error('  The rename IS applied and verified. Seed the week from the Reports tab instead.');
  process.exit(1);
}

console.log('\n  Done.');
