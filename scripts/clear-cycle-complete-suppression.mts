/**
 * Clear a week's `payment_cycle_complete` claim so the celebration can fire again.
 *
 * WHY THIS EXISTS
 * The claim key `dispatch.cycle_complete_notified.<source_file>` is once-per-cycle
 * EVER by design. Reopening a cycle deliberately BURNS it (`suppressed_by: 'reopen'`)
 * so a reopened week can never re-celebrate — see docs/features/cycle-closeout.md
 * § Reopening. When Kane explicitly wants a reopened week to celebrate on its
 * re-close, that marker has to go, and this is the only sanctioned way to remove it.
 *
 * SAFETY
 *  - Dry-run by default. `--apply` is required to write.
 *  - Writes a JSON backup of every row it will delete to reports/ BEFORE deleting,
 *    so the exact prior value can be restored by hand.
 *  - Refuses to touch a claim that records a REAL delivery (`notified > 0`): that
 *    week's email actually went out, and clearing it would double-mail the team.
 *    Override needs `--force-sent`, which prints a loud warning.
 *
 * USAGE
 *   npx tsx scripts/clear-cycle-complete-suppression.mts --source-file "<file.csv>"
 *   npx tsx scripts/clear-cycle-complete-suppression.mts --source-file "<file.csv>" --apply
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE_SENT = args.includes('--force-sent');
const sfIdx = args.indexOf('--source-file');
const SOURCE_FILE = sfIdx >= 0 ? args[sfIdx + 1] : undefined;

if (!SOURCE_FILE) {
  console.error('Missing --source-file "<cycle csv name>"');
  process.exit(1);
}

const env = readFileSync('.env.local', 'utf8');
const envVar = (k: string) =>
  env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';

const supabase = createClient(
  envVar('NEXT_PUBLIC_SUPABASE_URL'),
  envVar('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false } },
);

const KEY = `dispatch.cycle_complete_notified.${SOURCE_FILE}`;

const { data, error } = await supabase
  .from('app_settings')
  .select('key, value, updated_at')
  .eq('key', KEY)
  .limit(1);

if (error) {
  console.error('Read failed:', error.message);
  process.exit(1);
}

const row = data?.[0];
if (!row) {
  console.log(`No claim for this week (${KEY}) — nothing to clear.`);
  console.log('The celebration is already free to fire.');
  process.exit(0);
}

let parsed: { notified?: number; suppressed_by?: string; at?: string; by?: string } = {};
try {
  parsed = JSON.parse(row.value ?? '{}');
} catch {
  /* an unparseable claim still blocks the email, so it is still clearable */
}

console.log('Found claim:');
console.log('  key      ', row.key);
console.log('  value    ', row.value);
console.log('  updated  ', row.updated_at);
console.log(
  '  verdict  ',
  parsed.suppressed_by === 'reopen'
    ? 'SUPPRESSION from a reopen — no email was ever sent for this week'
    : `records a delivery to ${parsed.notified ?? '?'} recipients`,
);

const wasReallySent = (parsed.notified ?? 0) > 0;
if (wasReallySent && !FORCE_SENT) {
  console.error(
    '\nREFUSING: this claim records a real delivery. Clearing it would mail the team a\n' +
      'second time for the same week. Re-run with --force-sent if that is genuinely wanted.',
  );
  process.exit(1);
}
if (wasReallySent && FORCE_SENT) {
  console.warn('\n!! --force-sent: clearing a claim whose email ALREADY WENT OUT. Expect a re-send.');
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to delete this claim.');
  process.exit(0);
}

// Backup to disk BEFORE the delete (project rule: every destructive write gets a
// SELECT backup on disk first).
mkdirSync('reports', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `reports/backup_cycle_complete_claim_${stamp}.json`;
writeFileSync(
  backupPath,
  JSON.stringify({ backed_up_at: new Date().toISOString(), rows: [row] }, null, 2),
);
console.log(`\nBackup written: ${backupPath}`);

const { error: delErr } = await supabase.from('app_settings').delete().eq('key', KEY);
if (delErr) {
  console.error('Delete failed:', delErr.message);
  process.exit(1);
}

const { data: after } = await supabase.from('app_settings').select('key').eq('key', KEY).limit(1);
if ((after ?? []).length > 0) {
  console.error('Delete reported success but the row is still present — investigate.');
  process.exit(1);
}

console.log('Cleared. This week can celebrate again on its next qualifying trigger.');
console.log('Restore by re-inserting the row from the backup above.');
