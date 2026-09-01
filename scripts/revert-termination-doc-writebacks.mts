/**
 * [TERMINATION-DOCS]
 * Reverse the ONE irreversible act in Termination Docs: the blank-only
 * write-back into `global_master_list`.
 *
 *   node --import tsx scripts/revert-termination-doc-writebacks.mts                            # DRY RUN (default)
 *   node --import tsx scripts/revert-termination-doc-writebacks.mts --apply                    # write
 *   node --import tsx scripts/revert-termination-doc-writebacks.mts --accept-skipped           # rehearse the abandonment
 *   node --import tsx scripts/revert-termination-doc-writebacks.mts --apply --accept-skipped   # abandon what cannot be reversed
 *
 * Everything else about the feature reverts with one `git revert` plus
 * references/sql/fix/drop_termination_docs.sql. This does not: generating a
 * document may fill a blank `off_boarded_at`, `off_boarded_reason` or
 * `"Start Date"` on a master row, and the ONLY record of what those cells held
 * beforehand is `public.termination_documents.field_writebacks` — the jsonb
 * array this script reads and then prunes. There is no second copy in the same
 * table; `audit_log` carries one (action `documents.termination_writeback`) but
 * it is not a fallback: clearAuditLog() (src/lib/supabase/audit-log.ts:179)
 * truncates the whole table behind DELETE /api/audit-log, which is exactly why
 * bank_update_history was split out.
 *
 * RUN THIS BEFORE references/sql/fix/drop_termination_docs.sql. That script
 * drops the table this one reads.
 *
 * ── The rules are IMPORTED, not reimplemented ─────────────────────────────────
 * `readStoredWritebackRecord` (validation + the restore value) and the column
 * allowlist come from src/lib/documents/termination/termination-writeback-rules.ts,
 * the same pure module `npm test` exercises and the app's write-back runs. When
 * this script owned a private copy they diverged — the copy REFUSED a record the
 * shared `reverseValueForRecord` happily answered `null` for — and only the copy
 * nobody executed had tests.
 *
 * ── What makes the reverse safe ───────────────────────────────────────────────
 * Per-record re-verification, never a blanket "the field is populated, so we must
 * have populated it". A master-list sheet sync between generation and revert can
 * already have overwritten `off_boarded_reason` or `"Start Date"` with something
 * a human meant to keep (memory hris-is-dept-source-of-truth,
 * transfer-sheet-sync-false-success). Each record is therefore reversed only
 * while the column still holds exactly what the write-back put there; anything
 * else is SKIPPED and reported.
 *
 * Where the equality test lives, and why: `record.after` is the plain string the
 * write-back sent, but `off_boarded_at` is TIMESTAMPTZ
 * (references/sql/alter/global_master_list_offboarded_columns.sql:17), so a
 * written 'YYYY-MM-DD' reads back as a full timestamp and a client-side string
 * compare would SKIP every date record while reporting nothing wrong. The test is
 * therefore always the `.eq(column, record.after)` FILTER, evaluated by Postgres
 * in the column's own type: carried on the UPDATE under --apply (atomic with the
 * write, so there is no read-then-write window) and carried on a read-only
 * `select('id')` with the identical filter in the dry run.
 *
 * ── The dry run predicts the real run ─────────────────────────────────────────
 * It performs exactly the same verification the write relies on and prints
 * WOULD-RESTORE / WOULD-SKIP per record. It differs from --apply in ONE respect:
 * it writes nothing. A rehearsal that printed "Will restore" for every record —
 * as this script once did — systematically overstates the revert, and the
 * rehearsal is the artefact the operator decides on.
 *
 * ── A skip is no longer permanent ─────────────────────────────────────────────
 * After a run, each document row's `field_writebacks` is rewritten to contain
 * ONLY the records that could NOT be reversed, each annotated with `revert_skipped`
 * (why, and what the cell held instead). Reverted records leave the array. So:
 *   · the array shrinks as the revert progresses and never re-reverses a cell;
 *   · the evidence for an unreversible record survives, in place, explained;
 *   · `--apply --accept-skipped` (run by a human AFTER reading those annotations)
 *     clears the remainder, printing exactly what it abandons, so the drop
 *     script's PRE-CHECK can reach 0 and step 5 of the revert is reachable.
 * A record whose cell no longer equals `after` can never verify again — without
 * an explicit abandonment step, one such record used to deadlock the documented
 * teardown for good.
 *
 * `--accept-skipped` retires only records that were CHECKED and cannot come back
 * (a SKIP), plus records this code cannot parse. A record whose check ERRORED —
 * a timed-out read, a dropped connection — proves nothing, so it is kept and
 * annotated for the next run no matter what flags are passed.
 *
 * Unusable (unparseable) records are kept too. Object-shaped ones are annotated;
 * anything that is not a plain object is preserved byte-for-byte, since there is
 * no safe place to put an annotation inside it.
 *
 * ── The prune is a COMPARE-AND-SET, never a blind overwrite ──────────────────
 * `field_writebacks` is rewritten from an array this run planned against, and
 * that plan is built from a read taken at SCAN START. Generation appends undo
 * records to the same column WHILE this script runs (route.ts persists the trail
 * incrementally, one patch per cell that lands), so writing the planned array
 * back with `.eq('id', …)` alone would silently destroy a record created in
 * between — the very read-then-write hazard the write-back itself was rewritten
 * to eliminate — and the run would still report a clean teardown. So the row is
 * RE-READ immediately before the write and compared, and the write then carries
 * the observed value as a filter (`.eq('field_writebacks', …)`), evaluated by
 * Postgres inside the statement that writes. A mismatch at either step leaves
 * the row exactly as it is, says so, and fails the run. Losing undo data is
 * impossible here, not unlikely.
 *
 * Every UPDATE ends `.select('id')`. A filtered UPDATE that matches no row
 * returns `{ data: [], error: null }` — success-shaped while writing nothing —
 * so zero returned rows is a SKIP, never a success.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.
 * Paths (.env.local, the backup directory) are resolved from THIS FILE's
 * location, so the script behaves identically from any working directory.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * The shared rules, imported across the `src/` boundary.
 *
 * The import SHAPE matters here. `npm test`'s files are `.ts` (CJS, since
 * package.json declares no `type: module`), so tsx hands this `.mts` module a
 * CJS module through Node's ESM interop and named-export detection FAILS for it:
 * `import { readStoredWritebackRecord } from '…'` throws
 * "does not provide an export named". The exports land on the synthetic default
 * instead — the shape scripts/audit-orphanage-pay-divergence.mts:47 already
 * relies on. The `?? namespace` fallback keeps this working unchanged if those
 * modules ever become real ESM, and neither form needs an `any`.
 */
import terminationTypesDefault, * as terminationTypesNamespace from '../src/lib/documents/termination/types';
import writebackRulesDefault, * as writebackRulesNamespace from '../src/lib/documents/termination/termination-writeback-rules';
import type { StoredWritebackTarget } from '../src/lib/documents/termination/termination-writeback-rules';

const terminationTypes = terminationTypesDefault ?? terminationTypesNamespace;
const writebackRules = writebackRulesDefault ?? writebackRulesNamespace;

const { TERMINATION_WRITEBACK_COLUMNS } = terminationTypes;
const { TERMINATION_WRITEBACK_TABLE, readStoredWritebackRecord } = writebackRules;

/**
 * The repo root, derived from this file's own location — never from `cwd`.
 * `.gitignore:27` ignores `references/backups/`, and that pattern contains a
 * slash, so it is anchored to the repo root ONLY. A relative
 * `path.join('references','backups')` therefore wrote whole global_master_list
 * rows — real names, addresses, employee ids — into `scripts/references/backups/`
 * when the script was run from `scripts/`, a path git does NOT ignore, and the
 * next `git status` offered that PII for commit.
 */
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const BACKUP_DIR = path.join(REPO_ROOT, 'references', 'backups');
const GITIGNORE_PATH = path.join(REPO_ROOT, '.gitignore');

dotenv.config({ path: path.join(REPO_ROOT, '.env.local') });
dotenv.config();

const KNOWN_FLAGS = ['--apply', '--accept-skipped'] as const;
const args = process.argv.slice(2);
const unknown = args.filter((a) => !(KNOWN_FLAGS as readonly string[]).includes(a));
if (unknown.length) {
  // A silently-ignored typo on a flag that ABANDONS undo data is not survivable:
  // `--accept-skips` would look like it worked and clear nothing.
  console.error(
    `Unknown argument(s): ${unknown.join(' ')}\nUsage: [--apply] [--accept-skipped]  (no flag = dry run)`,
  );
  process.exit(1);
}
const APPLY = args.includes('--apply');
const ACCEPT_SKIPPED = args.includes('--accept-skipped');

/**
 * Refuse to run if the backup directory is not the gitignored one. These files
 * carry whole global_master_list rows, so "the path looked right" is not good
 * enough — the ignore rule itself is checked.
 */
function assertBackupDirIsGitignored(): void {
  const problems: string[] = [];

  const rel = path.relative(REPO_ROOT, BACKUP_DIR).split(path.sep).join('/');
  if (rel !== 'references/backups') {
    problems.push(`resolved backup dir is ${BACKUP_DIR}, expected <repo root>/references/backups`);
  }
  if (!existsSync(path.join(REPO_ROOT, 'package.json'))) {
    problems.push(
      `no package.json at ${REPO_ROOT} — the repo root could not be derived from the script's location`,
    );
  }
  if (!existsSync(GITIGNORE_PATH)) {
    problems.push(`no .gitignore at ${GITIGNORE_PATH}`);
  } else {
    const ignored = readFileSync(GITIGNORE_PATH, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => line === 'references/backups/' || line === '/references/backups/' || line === 'references/backups');
    if (!ignored) {
      problems.push(
        `'references/backups/' is not ignored by ${GITIGNORE_PATH} — the backup holds whole global_master_list rows and must never be committable`,
      );
    }
  }

  if (problems.length) {
    console.error('Refusing to run — the backup destination is not provably gitignored:');
    for (const p of problems) console.error(`  · ${p}`);
    process.exit(1);
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(
    `Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (${path.join(REPO_ROOT, '.env.local')})`,
  );
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const DOC_TABLE = 'termination_documents';
/** Imported, so this script and the write-back can never name two tables. */
const MASTER_TABLE = TERMINATION_WRITEBACK_TABLE;

type DocRow = {
  id: string;
  work_email: string | null;
  master_row_id: string | null;
  generated_at: string | null;
  field_writebacks: unknown;
};

type Target = StoredWritebackTarget & {
  doc: DocRow;
  /** Position in the doc row's field_writebacks array, so a line is traceable. */
  index: number;
  /** The stored entry verbatim, so an unreversed record can be kept as-is. */
  raw: unknown;
};

type Refusal = { doc: DocRow; index: number; raw: unknown; why: string };

/** What happened (or would happen) to one target. */
type Result = {
  target: Target;
  status: 'reverted' | 'skipped' | 'failed';
  why: string;
  /** The cell as it reads now, for the report and the annotation. */
  observed: string | null;
};

const PAGE = 1000;

/**
 * KEYSET paging on the uuid primary key. PostgREST truncates a result set at
 * 1000 rows even with `.range()`, and this is a permanent log with one row per
 * generated letter, so it will cross that cap. Keyset rather than offset because
 * a row inserted mid-run shifts every later offset and would make the scan skip
 * a row silently.
 *
 * The jsonb filter is applied in JS on purpose: `jsonb_array_length()` is not
 * expressible as a PostgREST filter, and a `neq('field_writebacks','[]')`
 * comparison depends on jsonb text normalisation that would quietly match
 * nothing. Reading every row and filtering here cannot under-report.
 */
async function loadDocRows(): Promise<DocRow[]> {
  const out: DocRow[] = [];
  let cursor = '';
  for (;;) {
    let q = sb
      .from(DOC_TABLE)
      .select('id, work_email, master_row_id, generated_at, field_writebacks')
      .order('id', { ascending: true })
      .limit(PAGE);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) throw new Error(`${DOC_TABLE} read failed: ${error.message}`);
    const rows = (data ?? []) as DocRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    cursor = rows[rows.length - 1].id;
  }
  return out;
}

/**
 * Re-read ONE document row's `field_writebacks`, for the compare-and-set the
 * prune performs. The array read at scan start is a stale snapshot: generation
 * appends undo records to this column while this script runs, so the prune must
 * prove the row still holds what it was planned against.
 *
 * The value is returned RAW (never coerced to an array): a shape this code did
 * not expect is a difference, and a difference must stop the write.
 */
async function readWritebackArray(
  docId: string,
): Promise<{ value: unknown; missing: boolean; error: string | null }> {
  const { data, error } = await sb
    .from(DOC_TABLE)
    .select('id, field_writebacks')
    .eq('id', docId)
    .maybeSingle();
  if (error) return { value: null, missing: false, error: error.message };
  if (!data) return { value: null, missing: true, error: null };
  return { value: (data as DocRow).field_writebacks, missing: false, error: null };
}

/**
 * Whether two reads of the same jsonb column describe the same stored value.
 * Both sides come from PostgREST's rendering of ONE column, so jsonb's own key
 * normalisation has already been applied to each and a text comparison of the
 * re-serialised values is exact. Deliberately strict: anything this cannot prove
 * identical counts as CHANGED, which skips the row rather than overwriting it.
 */
function sameStoredValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** How many records a re-read holds, for the SKIP line. */
function describeStoredLength(value: unknown): string {
  return Array.isArray(value) ? `${value.length} record(s)` : 'a non-array value';
}

/** How `before` prints in the plan. NULL and '' must never look the same. */
function renderBefore(before: null | ''): string {
  return before === null ? 'NULL' : "''";
}

function renderCell(value: unknown): string {
  return value === null || value === undefined ? 'NULL' : JSON.stringify(String(value));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The verification, identical in both modes: does the cell still hold exactly
 * what the write-back put there? The `.eq(column, after)` filter is evaluated by
 * Postgres in the column's own type — the same coercion the original write used —
 * so a date written into a TIMESTAMPTZ column compares correctly.
 *
 * Also reads the cell itself, which is what names the current value on a SKIP
 * line and how a vanished master row is told apart from a changed one.
 */
async function probe(t: Target): Promise<{
  found: boolean;
  current: unknown;
  matched: boolean;
  error: string | null;
}> {
  const read = await sb
    .from(MASTER_TABLE)
    .select(`id,"${t.column}"`)
    .eq('id', t.rowId)
    .maybeSingle();
  if (read.error) return { found: false, current: null, matched: false, error: read.error.message };
  if (!read.data) return { found: false, current: null, matched: false, error: null };

  const current = (read.data as Record<string, unknown>)[t.column];

  const verify = await sb
    .from(MASTER_TABLE)
    .select('id')
    .eq('id', t.rowId)
    .eq(t.column, t.after)
    .maybeSingle();
  if (verify.error) return { found: true, current, matched: false, error: verify.error.message };

  return { found: true, current, matched: !!verify.data, error: null };
}

/**
 * Why a record could not be reversed, worded the same in both modes so the
 * rehearsal and the real run read alike.
 */
function skipReason(found: boolean, current: unknown): string {
  if (!found) return 'master row is gone';
  if (current === null || current === undefined || String(current).trim() === '') {
    return 'already blank — reverted previously, or cleared by a sheet sync';
  }
  return `changed since generation (${renderCell(current)})`;
}

/** One record that did NOT come back, ready to be written into the row again. */
type RemainingEntry = {
  index: number;
  value: unknown;
  /** 'failed' = an operation errored, so NOTHING about it was proven. Those are
   *  never abandoned by --accept-skipped: only reviewed, unverifiable records
   *  ('skipped') and records this code cannot parse ('unusable') are. */
  status: 'skipped' | 'failed' | 'unusable';
};

/**
 * Rewrite one document row's `field_writebacks` to hold ONLY what was not
 * reversed. Reverted records leave; skipped, failed and unusable ones stay, with
 * `revert_skipped` explaining why and what the cell held instead.
 */
function remainingRecordsFor(
  doc: DocRow,
  results: Result[],
  refusals: Refusal[],
  stampedAt: string,
): RemainingEntry[] {
  const keep: RemainingEntry[] = [];

  for (const r of results) {
    if (r.target.doc.id !== doc.id) continue;
    if (r.status === 'reverted') continue;
    keep.push({
      index: r.target.index,
      status: r.status,
      value: annotate(r.target.raw, {
        at: stampedAt,
        status: r.status,
        why: r.why,
        observed: r.observed,
        column: r.target.column,
      }),
    });
  }

  for (const f of refusals) {
    if (f.doc.id !== doc.id) continue;
    keep.push({
      index: f.index,
      status: 'unusable',
      value: annotate(f.raw, {
        at: stampedAt,
        status: 'unusable',
        why: f.why,
        observed: null,
        column: null,
      }),
    });
  }

  // Original array order, so a stored record stays findable by eye.
  keep.sort((a, b) => a.index - b.index);
  return keep;
}

/**
 * Attach `revert_skipped` to a stored record without touching anything else.
 * A record that is not a plain object is returned VERBATIM: there is no safe
 * place to put an annotation inside it, and the evidence matters more than the
 * explanation, which the run output and the backup file also carry.
 */
function annotate(
  raw: unknown,
  note: {
    at: string;
    status: string;
    why: string;
    observed: string | null;
    column: string | null;
  },
): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  return {
    ...(raw as Record<string, unknown>),
    revert_skipped: {
      at: note.at,
      status: note.status,
      why: note.why,
      observed: note.observed,
      column: note.column,
      script: 'scripts/revert-termination-doc-writebacks.mts',
    },
  };
}

async function main() {
  const mode = APPLY ? 'APPLY' : 'DRY RUN';
  const accepting = ACCEPT_SKIPPED ? ' + ACCEPT-SKIPPED' : '';
  console.log(`${mode}${accepting} — revert Termination Docs field write-backs`);
  console.log(`Repo root: ${REPO_ROOT}\n`);

  // Checked in BOTH modes: the dry run is also the rehearsal for "can the real
  // run write its backup somewhere git will never offer for commit?".
  assertBackupDirIsGitignored();

  const docRows = await loadDocRows();
  const withWritebacks = docRows.filter(
    (d) => Array.isArray(d.field_writebacks) && d.field_writebacks.length > 0,
  );

  const targets: Target[] = [];
  const refusals: Refusal[] = [];
  for (const doc of withWritebacks) {
    const records = doc.field_writebacks as unknown[];
    for (let i = 0; i < records.length; i++) {
      const parsed = readStoredWritebackRecord(records[i]);
      if (typeof parsed === 'string') {
        refusals.push({ doc, index: i, raw: records[i], why: parsed });
      } else {
        targets.push({ ...parsed, doc, index: i, raw: records[i] });
      }
    }
  }

  console.log(`${DOC_TABLE} rows scanned            : ${docRows.length}`);
  console.log(`Rows carrying write-backs           : ${withWritebacks.length}`);
  console.log(`Field write-backs to reverse        : ${targets.length}`);
  console.log(`Unusable records (REFUSED)          : ${refusals.length}`);
  console.log(`Allowlisted columns                 : ${TERMINATION_WRITEBACK_COLUMNS.join(', ')}\n`);

  if (refusals.length) {
    console.log('REFUSED — these records are left exactly as they are:');
    for (const r of refusals) {
      console.log(`  doc ${r.doc.id} field_writebacks[${r.index}]: ${r.why}`);
    }
    console.log('');
  }

  if (!targets.length && !refusals.length) {
    console.log('Nothing to reverse.');
    process.exit(0);
  }

  // ── Backup, before any write ───────────────────────────────────────────────
  // Two things go in: every affected global_master_list row (what is about to
  // change) AND the field_writebacks arrays themselves (the only copy of the
  // undo data in this table, which this run then prunes). Backing up only the
  // master rows would leave a partially-successful run with nothing to retry
  // from. Taken whenever this run could write ANYTHING — including a run whose
  // only write is `--accept-skipped` retiring records that never verified, which
  // has no master-list target at all and must still leave a copy behind.
  let backupPath: string | null = null;
  if (APPLY) {
    const rowIds = [...new Set(targets.map((t) => t.rowId))];
    const masterRows: Record<string, unknown>[] = [];
    for (const ids of chunk(rowIds, 100)) {
      const { data, error } = await sb.from(MASTER_TABLE).select('*').in('id', ids);
      if (error) {
        console.error(`Backup read failed (${MASTER_TABLE}): ${error.message} — nothing written.`);
        process.exit(1);
      }
      masterRows.push(...((data ?? []) as Record<string, unknown>[]));
    }

    mkdirSync(BACKUP_DIR, { recursive: true });
    // FULL ISO stamp, not a date: two runs on the same day must not overwrite
    // each other's backup, and the first run holds the pre-revert state.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = path.join(BACKUP_DIR, `termination_writeback_revert_${stamp}.json`);
    writeFileSync(
      backupPath,
      JSON.stringify(
        {
          taken_at: new Date().toISOString(),
          script: 'scripts/revert-termination-doc-writebacks.mts',
          accept_skipped: ACCEPT_SKIPPED,
          global_master_list: masterRows,
          termination_documents: withWritebacks,
        },
        null,
        2,
      ),
    );
    console.log(`Backup written: ${backupPath}`);
    console.log(
      `  ${masterRows.length} of ${rowIds.length} master row(s), ${withWritebacks.length} document row(s)\n`,
    );
  }

  // ── Verify, then (only under --apply) restore ───────────────────────────────
  const results: Result[] = [];
  for (const t of targets) {
    const label = `${t.rowId}.${t.column}`;
    const seen = await probe(t);

    if (seen.error) {
      results.push({ target: t, status: 'failed', why: `re-read failed (${seen.error})`, observed: null });
      console.error(`  FAIL ${label}: re-read failed (${seen.error})`);
      continue;
    }

    const observed = seen.found ? renderCell(seen.current) : null;

    if (!seen.matched) {
      const why = skipReason(seen.found, seen.current);
      results.push({ target: t, status: 'skipped', why, observed });
      console.log(`  ${APPLY ? 'SKIP' : 'WOULD-SKIP'} ${label}: ${why} — untouched`);
      continue;
    }

    if (!APPLY) {
      results.push({ target: t, status: 'reverted', why: 'verified', observed });
      console.log(
        `  WOULD-RESTORE ${label}: ${JSON.stringify(t.after)} -> ${renderBefore(t.before)}`,
      );
      continue;
    }

    // Guarded restore. `.eq(t.column, t.after)` is the "still holds what we
    // wrote" test, atomic with the write. `t.before` is passed through exactly —
    // null stays null, '' stays ''.
    const { data, error } = await sb
      .from(MASTER_TABLE)
      .update({ [t.column]: t.before })
      .eq('id', t.rowId)
      .eq(t.column, t.after)
      .select('id');
    if (error) {
      results.push({ target: t, status: 'failed', why: error.message, observed });
      console.error(`  FAIL ${label}: ${error.message}`);
      continue;
    }
    if (!data?.length) {
      // The probe said it matched and the UPDATE says it did not: someone wrote
      // between the two. The UPDATE is the authority.
      const why = 'changed between verification and write — untouched';
      results.push({ target: t, status: 'skipped', why, observed });
      console.log(`  SKIP ${label}: ${why}`);
      continue;
    }
    results.push({ target: t, status: 'reverted', why: 'restored', observed });
    console.log(`  OK   ${label}: ${JSON.stringify(t.after)} -> ${renderBefore(t.before)}`);
  }

  const reverted = results.filter((r) => r.status === 'reverted').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const errors = results.filter((r) => r.status === 'failed').length;

  // ── Prune field_writebacks: keep ONLY what was not reversed ─────────────────
  const stampedAt = new Date().toISOString();
  let cleared = 0;
  let pruned = 0;
  let clearFailed = 0;
  let concurrent = 0;
  const abandoning: Array<{ doc: DocRow; records: unknown[] }> = [];

  console.log('');
  for (const doc of withWritebacks) {
    const remaining = remainingRecordsFor(doc, results, refusals, stampedAt);
    const scanned = doc.field_writebacks as unknown[];
    const originalLength = scanned.length;

    // --accept-skipped retires records that CANNOT verify again. It never
    // retires one whose check merely errored: nothing about those was proven, so
    // they stay, annotated, for the next run.
    const abandonable = ACCEPT_SKIPPED ? remaining.filter((e) => e.status !== 'failed') : [];
    const retained = ACCEPT_SKIPPED ? remaining.filter((e) => e.status === 'failed') : remaining;

    // A row whose remaining count equals its original count is still rewritten:
    // the `revert_skipped` annotation is what tells the next operator why the
    // record is still there.
    const next = retained.map((e) => e.value);

    if (!APPLY) {
      if (abandonable.length) abandoning.push({ doc, records: abandonable.map((e) => e.value) });
      const verb =
        abandonable.length > 0 ? 'WOULD ABANDON' : next.length === 0 ? 'WOULD CLEAR' : 'WOULD KEEP';
      console.log(
        `  ${verb} doc ${doc.id}: ${originalLength} record(s) -> ${next.length} remaining` +
          (abandonable.length ? `, ${abandonable.length} abandoned` : '') +
          (next.length ? ` (unreversible, annotated with revert_skipped)` : ''),
      );
      continue;
    }

    // COMPARE-AND-SET. `next` is built from the array read at SCAN START, and
    // writing it back with `.eq('id', …)` alone is a blind whole-array overwrite:
    // a generation that lands an undo record between the scan and this write
    // (route.ts persists the trail incrementally, one patch per cell) would be
    // silently erased — the exact read-then-write hazard the write-back itself
    // was rewritten to eliminate — while this run still reported a clean
    // teardown. So the row is re-read first, and the write carries the observed
    // value as a FILTER, evaluated by Postgres inside the statement that writes.
    // Any mismatch, at either step, leaves the row untouched and fails the run.
    const fresh = await readWritebackArray(doc.id);
    if (fresh.error) {
      clearFailed++;
      console.error(
        `  FAIL prune ${doc.id}: could not re-read field_writebacks (${fresh.error}) — left untouched`,
      );
      continue;
    }
    if (fresh.missing) {
      clearFailed++;
      console.error(`  FAIL prune ${doc.id}: no row updated — the document row may be gone`);
      continue;
    }
    if (!sameStoredValue(scanned, fresh.value)) {
      concurrent++;
      console.error(
        `  SKIP prune ${doc.id}: field_writebacks CHANGED since this run started ` +
          `(${originalLength} record(s) scanned, ${describeStoredLength(fresh.value)} now) — ` +
          'left exactly as it is so a record written during this run cannot be lost. Re-run.',
      );
      continue;
    }

    const { data, error } = await sb
      .from(DOC_TABLE)
      .update({ field_writebacks: next })
      .eq('id', doc.id)
      .eq('field_writebacks', JSON.stringify(fresh.value))
      .select('id');
    if (error) {
      clearFailed++;
      console.error(`  FAIL prune ${doc.id}: ${error.message}`);
      continue;
    }
    if (!data?.length) {
      // The guard did not match. Either someone wrote in the moment between the
      // re-read and this statement, or the row went away. Re-read to say which;
      // either way nothing was written and nothing was lost.
      const after = await readWritebackArray(doc.id);
      const why = after.error
        ? `and the row could not be re-read (${after.error})`
        : after.missing
          ? 'and the document row is gone'
          : sameStoredValue(scanned, after.value)
            ? 'while the row still reads exactly as it did — nothing was written; re-run, and if this repeats the guard filter itself needs fixing'
            : 'because field_writebacks changed between the re-read and the write';
      concurrent++;
      console.error(`  SKIP prune ${doc.id}: the compare-and-set matched no row ${why}.`);
      continue;
    }
    if (abandonable.length) abandoning.push({ doc, records: abandonable.map((e) => e.value) });
    if (next.length === 0) cleared++;
    else pruned++;
  }

  if (abandoning.length) {
    console.log('');
    console.log(
      `--accept-skipped: ${APPLY ? 'ABANDONING' : 'WOULD ABANDON'} the following undo records. ` +
        'After this they are gone from the document row; the printed lines and the backup file are the only remaining copy.',
    );
    for (const a of abandoning) {
      for (const rec of a.records) {
        console.log(`  doc ${a.doc.id}: ${JSON.stringify(rec)}`);
      }
    }
  }

  console.log('');
  console.log(`${APPLY ? 'Reverted' : 'Would restore'}      : ${reverted}`);
  console.log(`${APPLY ? 'Skipped (untouched)' : 'Would skip'}    : ${skipped}`);
  console.log(`Errors              : ${errors}`);
  console.log(`Refused             : ${refusals.length}`);
  if (APPLY) {
    console.log(`field_writebacks cleared : ${cleared}`);
    console.log(`field_writebacks pruned  : ${pruned} (unreversible records kept + annotated)`);
    if (clearFailed) console.log(`field_writebacks prune failed : ${clearFailed}`);
    if (concurrent) {
      console.log(`field_writebacks prune skipped : ${concurrent} (changed under the run)`);
    }
    if (backupPath) console.log(`\nBackup: ${backupPath}`);
  } else {
    console.log('\nDry run — nothing written. Re-run with --apply to write.');
  }

  /** Records that were reviewed and genuinely did not come back. */
  const unreversed = skipped + refusals.length;
  /** Things that went WRONG, as opposed to records that simply cannot verify.
   *  A row whose `field_writebacks` moved under the run counts here: nothing was
   *  written, the array still holds every record it held, and the operator must
   *  re-run rather than read the summary as a completed teardown. */
  const failures = errors + clearFailed + concurrent;

  if (failures) {
    console.error(
      `\n${failures} operation(s) FAILED (see FAIL lines above). Nothing about them is abandoned or` +
        ' assumed — re-run once the cause is fixed.',
    );
  }

  if (concurrent) {
    console.error(
      `\n${concurrent} document row(s) had their field_writebacks CHANGED while this run was in` +
        ' flight — a letter was almost certainly generated with a write-back at the same time. Those' +
        ' rows were left byte-for-byte as they are: pruning them from the stale array read at scan' +
        ' start would have destroyed the undo record written in between. Re-run when generation is' +
        ' quiet.',
    );
  }

  if (unreversed && !(APPLY && ACCEPT_SKIPPED)) {
    console.error(
      `\n${unreversed} record(s) were not reversed. Each one is named above and left exactly as it was.` +
        `\n${APPLY ? 'Each' : 'After --apply each'} unreversible record is the only thing left in its` +
        ' document row\'s field_writebacks, annotated with `revert_skipped` (why, and what the cell holds' +
        ' instead) — read those, fix what can be fixed, and re-run.' +
        '\nWhen a record genuinely cannot verify again (a sheet sync clobbered the cell), retire it with:' +
        '\n  node --import tsx scripts/revert-termination-doc-writebacks.mts --apply --accept-skipped' +
        "\nThat is what lets the drop script's PRE-CHECK reach 0. Do not run" +
        ' references/sql/fix/drop_termination_docs.sql before it does.',
    );
  }

  if (APPLY && ACCEPT_SKIPPED && !failures) {
    const abandoned = abandoning.reduce((n, a) => n + a.records.length, 0);
    console.log(
      `\n${abandoned} record(s) ABANDONED at your instruction and every field_writebacks array cleared.` +
        ` The lines above and ${backupPath ?? 'the backup file'} are the only remaining copy of them.` +
        " references/sql/fix/drop_termination_docs.sql's PRE-CHECK will now return 0.",
    );
  } else if (APPLY && !failures && !unreversed) {
    console.log(
      '\nEvery record reversed and every field_writebacks array cleared —' +
        " references/sql/fix/drop_termination_docs.sql's PRE-CHECK will return 0.",
    );
  }

  // Exit 0 only when the teardown state was actually reached: everything
  // reversed, or the operator deliberately retired the remainder with
  // --accept-skipped and no operation failed while doing it.
  const exitCode = failures || (unreversed && !(APPLY && ACCEPT_SKIPPED)) ? 1 : 0;
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exit(1);
});
