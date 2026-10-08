/**
 * [Accounting Scoreboard: clear one week's untyped Payroll Problems grid counts]
 * Kane's ruling W0.2 = (a), 2026-10-07 (Open item 391). Carla: "the Monday ones have no type […] I don't have an option
 * to edit or delete the Monday problems because they're not under the log." The old grid takes no writes from the app,
 * so this one-off script deletes that week's old-grid counts (a cleared cell is a DELETED entry, never a stored 0), and
 * her team re-logs them with a type. Only a week in RULED_WEEKS can be cleared (problem-grid-clear.ts).
 *
 *   node --import tsx scripts/clear-accounting-scoreboard-problem-grid-week.mts --week 2026-10-04                 # rehearse, ROLL BACK
 *   node --import tsx scripts/clear-accounting-scoreboard-problem-grid-week.mts --week 2026-10-04 --apply         # backup, then DELETE
 *   node --import tsx scripts/clear-accounting-scoreboard-problem-grid-week.mts --revert <backup.json>            # rehearse the restore
 *   node --import tsx scripts/clear-accounting-scoreboard-problem-grid-week.mts --revert <backup.json> --apply    # restore them
 *
 * SAFE BY DEFAULT: without --apply everything runs inside a transaction that is always rolled back. The week's entries
 * are locked (FOR UPDATE) and checked by planGridClear: refused if the week is not ruled, holds no grid count, holds an
 * entry outside the week or in another slot, or holds one saved at or after the round-3 apply. --apply writes every
 * entry it will delete (with its saver and save time) to docs/audits/backups/ (gitignored) BEFORE the DELETE, deletes
 * exactly those keys, checks the week then holds none, and commits. --revert re-inserts a backup's entries as they were,
 * and refuses if any cell already exists or its row is no longer a Payroll Problems row.
 *
 * Output names a row by the first 8 characters of its id, never its label (a row label is a person's name).
 * Needs DATABASE_URL in .env.local: the SESSION POOLER (memory/migration-apply-needs-database-url).
 * Do not double-click this file: Windows opens .mts as video.
 * Governing doc: docs/features/accounting-scoreboard.md § Payroll Problems.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import dotenv from 'dotenv';
// tsx loads the .ts modules as CommonJS, so a named import fails here; take the namespace off the default.
import clearModule from '../src/lib/accounting-scoreboard/problem-grid-clear';
import weekModule from '../src/lib/accounting-scoreboard/week';

const { planGridClear, GRID_CUTOFF } = clearModule as unknown as typeof import('../src/lib/accounting-scoreboard/problem-grid-clear');
const { addDays } = weekModule as unknown as typeof import('../src/lib/accounting-scoreboard/week');
type GridEntry = import('../src/lib/accounting-scoreboard/problem-grid-clear').GridEntry;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });
dotenv.config({ quiet: true });

const ENTRIES = 'public.accounting_scoreboard_entries';
const ROWS = 'public.accounting_scoreboard_rows';

const argv = process.argv.slice(2);
const valueOf = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const apply = argv.includes('--apply');
const week = valueOf('--week');
const revertFile = valueOf('--revert');
if ((week === undefined) === (revertFile === undefined)) {
  console.error('Pass exactly one of --week <Sunday> or --revert <backup.json> (and --apply to commit).');
  process.exit(1);
}
const known = new Set(['--apply', '--week', '--revert', week, revertFile]);
const unknown = argv.filter((a) => !known.has(a));
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(' ')}`);
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error('DATABASE_URL is not set. Add the SESSION POOLER URI to .env.local (memory/migration-apply-needs-database-url).');
  process.exit(1);
}

/** A backup entry: the stored cell exactly as it was, so a revert puts it back unchanged. */
interface BackupEntry extends GridEntry {
  updatedBy: string;
}
interface Backup {
  kind: 'accounting-scoreboard-problem-grid-clear';
  takenAt: string;
  week: string;
  ruling: string;
  cutoff: string;
  entries: BackupEntry[];
}

const client = new Client({ connectionString });

const short = (id: string) => id.slice(0, 8);

async function readWeek(sunday: string): Promise<BackupEntry[]> {
  const { rows } = await client.query<{ row_id: string; date: string; slot: string; value: string; updated_at: Date; updated_by: string }>(
    `SELECT e.row_id, e.entry_date::text AS date, e.slot, e.value::text AS value, e.updated_at, e.updated_by
       FROM ${ENTRIES} e JOIN ${ROWS} r ON r.id = e.row_id
      WHERE r.section_key = 'payroll_problems' AND e.entry_date BETWEEN $1::date AND $2::date
      ORDER BY e.entry_date, e.row_id, e.slot
        FOR UPDATE OF e`,
    [sunday, addDays(sunday, 6)],
  );
  return rows.map((r) => ({
    rowId: r.row_id,
    date: r.date,
    slot: r.slot,
    value: Number(r.value),
    updatedAt: r.updated_at.toISOString(),
    updatedBy: r.updated_by,
  }));
}

async function clearWeek(sunday: string): Promise<void> {
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — clear the old-grid Payroll Problems counts of the week of ${sunday}\n`);
  const entries = await readWeek(sunday);
  const plan = planGridClear(sunday, entries);
  if (!plan.ok) throw new Error(`REFUSED: ${plan.refusal}`);

  console.log(`Old-grid counts in the week: ${plan.entries.length} entries, ${plan.total} problems (all read as "No type").`);
  for (const d of plan.byDay) console.log(`  ${d.date}: ${d.entries} entries, ${d.total} problems`);
  for (const r of plan.byRow) console.log(`  row ${r.row}…: ${r.entries} entries, ${r.total} problems`);
  const zeros = plan.entries.filter((e) => e.value === 0).length;
  if (zeros) console.log(`  (${zeros} of them a typed 0: a real "0 problems". It is cleared too; re-log it as a 0 line if it should stay.)`);
  const logged = await client.query<{ n: string; total: string | null }>(
    `SELECT count(*)::text AS n, sum(problem_count)::text AS total FROM public.accounting_scoreboard_problems
      WHERE deleted_at IS NULL AND entry_date BETWEEN $1::date AND $2::date`,
    [sunday, addDays(sunday, 6)],
  );
  console.log(`Typed log lines already in the week (untouched): ${logged.rows[0]?.n ?? 0}, ${logged.rows[0]?.total ?? 0} problems.\n`);

  if (apply) {
    const dir = path.join(REPO_ROOT, 'docs', 'audits', 'backups');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `accounting-scoreboard-problem-grid-${sunday}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const backup: Backup = {
      kind: 'accounting-scoreboard-problem-grid-clear',
      takenAt: new Date().toISOString(),
      week: sunday,
      ruling: 'Kane, W0.2 = (a), 2026-10-07 (Open item 391)',
      cutoff: GRID_CUTOFF,
      entries,
    };
    writeFileSync(file, JSON.stringify(backup, null, 2));
    console.log(`Backup: ${path.relative(REPO_ROOT, file)} (${entries.length} entries). Revert with --revert <that file> --apply.\n`);
  }

  const del = await client.query(
    `DELETE FROM ${ENTRIES} e
      USING unnest($1::uuid[], $2::date[], $3::text[]) AS k(row_id, entry_date, slot)
      WHERE e.row_id = k.row_id AND e.entry_date = k.entry_date AND e.slot = k.slot`,
    [plan.entries.map((e) => e.rowId), plan.entries.map((e) => e.date), plan.entries.map((e) => e.slot)],
  );
  if (del.rowCount !== plan.entries.length) throw new Error(`the DELETE removed ${del.rowCount} entries, not ${plan.entries.length}`);
  const left = await readWeek(sunday);
  if (left.length) throw new Error(`${left.length} old-grid entries are still in the week after the DELETE`);
  console.log(`Deleted ${del.rowCount} entries; the week now holds no old-grid count (checked).`);
}

function readBackup(file: string): Backup {
  if (!existsSync(file)) throw new Error(`No backup at ${file}`);
  const b = JSON.parse(readFileSync(file, 'utf8')) as Partial<Backup>;
  if (b.kind !== 'accounting-scoreboard-problem-grid-clear' || !Array.isArray(b.entries) || typeof b.week !== 'string') {
    throw new Error(`${file} is not a backup written by this script`);
  }
  for (const e of b.entries) {
    if (typeof e.rowId !== 'string' || typeof e.date !== 'string' || e.slot !== 'day' || typeof e.value !== 'number' || typeof e.updatedAt !== 'string' || typeof e.updatedBy !== 'string') {
      throw new Error(`${file} holds an entry that is not an old-grid day count`);
    }
  }
  return b as Backup;
}

async function revert(file: string): Promise<void> {
  const b = readBackup(path.resolve(file));
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — restore ${b.entries.length} old-grid entries of the week of ${b.week} from ${file}\n`);
  const rows = await client.query<{ id: string }>(
    `SELECT id FROM ${ROWS} WHERE section_key = 'payroll_problems' AND id = ANY($1::uuid[])`,
    [[...new Set(b.entries.map((e) => e.rowId))]],
  );
  const live = new Set(rows.rows.map((r) => r.id));
  const missing = b.entries.filter((e) => !live.has(e.rowId));
  if (missing.length) throw new Error(`REFUSED: ${missing.length} entries belong to a row that is no longer a Payroll Problems row`);
  const ins = await client.query(
    `INSERT INTO ${ENTRIES} (row_id, entry_date, slot, value, updated_at, updated_by)
     SELECT * FROM unnest($1::uuid[], $2::date[], $3::text[], $4::numeric[], $5::timestamptz[], $6::text[])`,
    [
      b.entries.map((e) => e.rowId),
      b.entries.map((e) => e.date),
      b.entries.map((e) => e.slot),
      b.entries.map((e) => e.value),
      b.entries.map((e) => e.updatedAt),
      b.entries.map((e) => e.updatedBy),
    ],
  ).catch((e: { code?: string; message?: string }) => {
    throw new Error(e.code === '23505' ? 'REFUSED: a cell in the backup already holds a value; nothing was restored' : (e.message ?? String(e)));
  });
  if (ins.rowCount !== b.entries.length) throw new Error(`the INSERT restored ${ins.rowCount} entries, not ${b.entries.length}`);
  for (const e of b.entries) console.log(`  ${e.date} row ${short(e.rowId)}…: ${e.value}`);
  console.log(`\nRestored ${ins.rowCount} entries.`);
}

async function main(): Promise<void> {
  await client.connect();
  await client.query('BEGIN');
  // Never queue behind a long board read, and never make the board wait on us for long.
  await client.query("SET LOCAL lock_timeout = '10s'");
  try {
    if (week !== undefined) await clearWeek(week);
    else await revert(revertFile!);
  } catch (e) {
    await client.query('ROLLBACK');
    await client.end();
    console.error(`\n${e instanceof Error ? e.message : String(e)}\nRolled back — nothing was changed.`);
    process.exit(1);
  }
  if (apply) {
    await client.query('COMMIT');
    console.log('\nCommitted.');
  } else {
    await client.query('ROLLBACK');
    console.log('\nRolled back — production is unchanged. Re-run with --apply to commit.');
  }
  await client.end();
}

main().catch(async (e) => {
  console.error('\nFailed:', e instanceof Error ? e.message : String(e));
  try {
    await client.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
