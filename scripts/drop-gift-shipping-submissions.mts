/**
 * [GIFT-RECEIPTS]
 * DESTRUCTIVE — deletes every row of `employee_gift_shipping_details`.
 *
 *   node --import tsx scripts/drop-gift-shipping-submissions.mts           # REPORT ONLY (default)
 *   node --import tsx scripts/drop-gift-shipping-submissions.mts --apply   # DELETE
 *
 * Kane's ruling 2026-09-11 (session brief, Conflict 3 option (a)): the gift
 * tracker starts fresh alongside the fulfilment backfill, so the address
 * submissions collected so far are cleared.
 *
 * WHAT IS ACTUALLY LOST — stated plainly, because it is not nothing
 * -----------------------------------------------------------------
 * `employee_gift_shipping_details` is the ADDRESS-REVIEW table, and it is the
 * only place a submitted delivery address exists. After this runs:
 *
 *   - every roster-export row falls back to the master-list home address, and
 *     the `Address Source` column reads `Master list` instead of `Submitted`
 *     (docs/features/gift-tracker-shipping-export.md § Two addresses);
 *   - off-roster submitters — people whose submission matches no roster row, the
 *     likeliest mis-ships — disappear from the export's appended block;
 *   - any approved (locked) row is unlocked, because the row that carried the
 *     lock is gone.
 *
 * Nothing about FULFILMENT is lost: `employee_gift_receipts` is a separate
 * table, keyed on work email, and this script does not touch it. That
 * separation is the reason this delete is survivable at all.
 *
 * THE BACKUP IS NOT OPTIONAL
 * --------------------------
 * Every row is SELECTed and written to disk BEFORE a single delete
 * (CLAUDE.md § Data), and a failed backup write ABORTS — an unsnapshotted
 * destructive path is the one thing docs/features/delete-authorization.md does
 * not allow. The snapshot also goes into `audit_log` before the delete, in the
 * same order the orphanage wipe uses: trail first, destruction second, because
 * the trail write needs the rows while they still exist.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local') });
dotenv.config();

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const apply = process.argv.includes('--apply');
const outDir = path.join(REPO_ROOT, argValue('--out') ?? 'reports');
const ACTOR = argValue('--actor') ?? 'kaner@simple.biz';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const TABLE = 'employee_gift_shipping_details';

type Row = Record<string, unknown> & {
  id: string;
  personal_email: string;
  milestone_index: number;
  status: string;
};

async function readAll(): Promise<Row[]> {
  const out: Row[] = [];
  const size = 1000;
  // Paged: PostgREST caps at 1000 even with .range(). A short read here would
  // produce a backup that silently omits rows this script then deletes.
  for (let from = 0; ; from += size) {
    const { data, error } = await sb
      .from(TABLE)
      .select('*')
      .order('personal_email', { ascending: true })
      .order('milestone_index', { ascending: true })
      .range(from, from + size - 1);
    if (error) throw new Error(`${TABLE}: ${error.message}`);
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

async function main() {
  console.log(
    [
      `${apply ? 'APPLY — DESTRUCTIVE' : 'REPORT ONLY'} — drop gift shipping submissions`,
      '',
      `  Table   : ${TABLE}`,
      `  Actor   : ${ACTOR}`,
      `  Backups : ${outDir}`,
      '',
      apply
        ? '  EVERY ROW WILL BE DELETED after the backup lands on disk.'
        : '  Nothing will be deleted. Re-run with --apply to commit.',
      '',
    ].join('\n'),
  );

  const rows = await readAll();
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const withAddress = rows.filter(
    (r) => String(r.preferred_delivery_location ?? '').trim() !== '',
  ).length;

  console.log(
    [
      `Rows on file: ${rows.length}`,
      `  by status: ${JSON.stringify(byStatus)}`,
      `  carrying a submitted delivery address: ${withAddress}`,
      '',
    ].join('\n'),
  );

  if (rows.length === 0) {
    console.log('Nothing to delete.');
    return;
  }

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(outDir, `gift-shipping-submissions-backup-${stamp}.json`);

  // Write, then READ BACK. A backup nobody verified is a claim, not a backup —
  // and this is the only copy of these addresses that will exist.
  writeFileSync(backupPath, JSON.stringify(rows, null, 2), 'utf8');
  let verified = 0;
  try {
    verified = (JSON.parse(readFileSync(backupPath, 'utf8')) as unknown[]).length;
  } catch (e) {
    console.error(`Backup at ${backupPath} could not be read back: ${(e as Error).message}`);
    console.error('ABORTING — nothing has been deleted.');
    process.exit(1);
  }
  if (verified !== rows.length) {
    console.error(
      `Backup holds ${verified} row(s) but ${rows.length} were read. ABORTING — nothing deleted.`,
    );
    process.exit(1);
  }
  console.log(`Backup written and verified (${verified} rows): ${backupPath}`);

  if (!apply) {
    console.log('\nREPORT ONLY — nothing was deleted. Re-run with --apply to commit.');
    return;
  }

  // TRAIL FIRST. delete-authorization.md: the snapshot must be written while the
  // rows still exist, and a failed trail write abandons the delete.
  const { error: auditError } = await sb.from('audit_log').insert({
    user_name: ACTOR,
    user_role: 'admin',
    action: 'employee_gift_shipping.period_cleared',
    resource: TABLE,
    resource_id: 'all',
    details: {
      reason: 'Gift tracker restart alongside the 2026-09-11 fulfilment backfill (Kane)',
      rows_deleted: rows.length,
      by_status: byStatus,
      with_submitted_address: withAddress,
      backup_file: path.basename(backupPath),
      rows,
    },
  });
  if (auditError) {
    console.error(`Audit snapshot FAILED: ${auditError.message}`);
    console.error('ABORTING — nothing has been deleted.');
    process.exit(1);
  }
  console.log('Audit snapshot written.');

  const { error: deleteError, count } = await sb
    .from(TABLE)
    .delete({ count: 'exact' })
    // PostgREST refuses an unfiltered DELETE; this predicate is true for every
    // row (`id` is a NOT NULL primary key) and is the explicit "yes, all of it".
    .not('id', 'is', null);
  if (deleteError) {
    console.error(`\nDelete failed: ${deleteError.message}`);
    console.error(`The backup is at ${backupPath}.`);
    process.exit(1);
  }

  const remaining = await readAll();
  console.log(`\nDeleted ${count ?? rows.length} row(s). Remaining: ${remaining.length}.`);
  if (remaining.length > 0) {
    console.error('Rows remain — investigate before re-running.');
    process.exit(1);
  }
  console.log(`Backup retained at ${backupPath}.`);
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
