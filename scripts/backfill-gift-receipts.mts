/**
 * [GIFT-RECEIPTS]
 * Backfill `employee_gift_receipts` from the "Work Anniversary Gift Tracker"
 * sheet export.
 *
 *   node --import tsx scripts/backfill-gift-receipts.mts            # REPORT ONLY (default)
 *   node --import tsx scripts/backfill-gift-receipts.mts --apply    # WRITE
 *   node --import tsx scripts/backfill-gift-receipts.mts --file "<path to csv>"
 *   node --import tsx scripts/backfill-gift-receipts.mts --out reports/
 *
 * SAFE BY DEFAULT: no flag reads, resolves, and writes a full report to disk
 * without touching a row. `--apply` is the only thing that writes.
 *
 * WHAT GETS WRITTEN, AND WHAT DELIBERATELY DOES NOT
 * -------------------------------------------------
 * The parsing and the selection rule live in
 * `src/lib/gift-tracker/receipt-import.ts` and are unit-tested there; this file
 * is the I/O around them. The rule in one line: a `Yes` always imports, a `No`
 * imports only when that milestone has ALREADY COME DUE, and anything else
 * imports nothing.
 *
 * The 8,398 `No` cells against milestones years away are the spreadsheet's
 * default, not anybody's statement. Writing them would put most of the company
 * on the owed list. They are counted in the report and skipped.
 *
 * DUE-NESS IS COMPUTED FROM THE MASTER LIST, NOT THE SHEET
 * --------------------------------------------------------
 * `global_master_list` owns `start_date`; the sheet's own Start Date column is
 * read only to report divergence (2 rows diverge as of 2026-09-11). Due-ness
 * runs through `isMilestoneDue` — the same predicate the Gift Tracker and the
 * roster export use — so an imported `owed` and a displayed `owed` cannot drift.
 *
 * OFF-ROSTER PEOPLE ARE IMPORTED, NOT DROPPED
 * -------------------------------------------
 * 95 of the sheet's people are offboarded (present in `global_master_list`, gone
 * from `active_employees`) and 13 resolve to no master row at all. A person who
 * left owed a gift is exactly the case the tracker could never see; dropping
 * them would rebuild that blind spot. They are imported and named in the report.
 * Someone with no master row has no authoritative start date, so only their
 * `Yes` cells can be judged — that is stated per person, never silently.
 *
 * BACKUP BEFORE WRITE
 * -------------------
 * Every existing row is SELECTed and written to disk before a single upsert
 * runs (CLAUDE.md § Data). On a first run that file is an empty array, which is
 * still the correct evidence that nothing was overwritten.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import importModule from '../src/lib/gift-tracker/receipt-import';
import milestonesModule from '../src/lib/gift-milestones';
import type {
  GiftReceiptAssertion,
  GiftReceiptProblem,
} from '../src/lib/gift-tracker/receipt-import';

// Default-import + cast: this is an `.mts` (true ESM) file and tsx transpiles the
// imported `.ts` to CJS, so named exports do not come through. Same pattern as
// scripts/audit-orphanage-pay-divergence.mts. Importing the SHIPPED modules is
// the point — the parse rule and the due-ness predicate must be the ones the
// Gift Tracker itself runs, never a copy that can drift.
const { parseGiftReceiptCsv, selectAssertions } =
  importModule as unknown as typeof import('../src/lib/gift-tracker/receipt-import');
const { fmtDateIso, parseStartDate } =
  milestonesModule as unknown as typeof import('../src/lib/gift-milestones');

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local') });
dotenv.config();

const DEFAULT_CSV =
  'references/docs/Work Anniversary Gift Tracker - Copy of HRIS Active Ppl.csv';

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const apply = process.argv.includes('--apply');
const csvArg = argValue('--file') ?? DEFAULT_CSV;
const csvPath = path.isAbsolute(csvArg) ? csvArg : path.join(REPO_ROOT, csvArg);
const outDir = path.join(REPO_ROOT, argValue('--out') ?? 'reports');

if (!existsSync(csvPath)) {
  console.error(`CSV not found: ${csvPath}`);
  process.exit(1);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

/** The file name is the provenance recorded on every imported row. */
const SOURCE_FILE = path.basename(csvPath);
const RECORDED_BY = argValue('--actor') ?? 'kaner@simple.biz';
const TODAY = new Date();

type MasterRaw = {
  Name: string | null;
  'Work Email': string | null;
  'Personal Email': string | null;
  'Start Date': string | null;
};

/**
 * PostgREST truncates at 1000 rows even with an explicit `.range()`, so every
 * roster read here pages. A truncated master list would not shorten the import
 * — it would silently strip people of their start date and reclassify their
 * whole gift history as unjudgeable.
 */
async function pageAll(table: string): Promise<MasterRaw[]> {
  const out: MasterRaw[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await sb
      .from(table)
      .select('Name,"Personal Email","Work Email","Start Date"')
      .order('Work Email', { ascending: true })
      .range(from, from + size - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as unknown as MasterRaw[];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

type Resolution = 'active' | 'offboarded' | 'unresolved';

async function main() {
  console.log(
    [
      `${apply ? 'APPLY' : 'REPORT ONLY'} — Gift receipts backfill`,
      '',
      `  CSV     : ${csvPath}`,
      `  Source  : ${SOURCE_FILE}`,
      `  Actor   : ${RECORDED_BY}`,
      `  Reports : ${outDir}`,
      '',
      apply
        ? '  Rows WILL be written to employee_gift_receipts.'
        : '  Nothing will be written. Re-run with --apply to commit.',
      '',
    ].join('\n'),
  );

  // ── Parse ────────────────────────────────────────────────────────────────
  const { rows: csvRows, problems: parseProblems } = parseGiftReceiptCsv(
    readFileSync(csvPath, 'utf8'),
  );
  console.log(`Parsed ${csvRows.length} people from the sheet.`);

  // ── Resolve against the master list ──────────────────────────────────────
  const active = await pageAll('active_employees');
  const gml = await pageAll('global_master_list');
  console.log(`Roster: ${active.length} active, ${gml.length} in the master list.`);

  const byWork = new Map<string, { row: MasterRaw; resolution: Resolution }>();
  for (const r of gml) {
    const k = r['Work Email']?.trim().toLowerCase();
    if (k) byWork.set(k, { row: r, resolution: 'offboarded' });
  }
  for (const r of active) {
    const k = r['Work Email']?.trim().toLowerCase();
    if (k) byWork.set(k, { row: r, resolution: 'active' });
  }

  // ── Select assertions ────────────────────────────────────────────────────
  const assertions: GiftReceiptAssertion[] = [];
  const problems: GiftReceiptProblem[] = [...parseProblems];
  const byResolution: Record<Resolution, number> = { active: 0, offboarded: 0, unresolved: 0 };
  const unresolved: string[] = [];
  const startDivergence: Array<{ workEmail: string; sheet: string | null; master: string | null }> = [];
  const noStartDate: string[] = [];
  let skippedNotDue = 0;
  let skippedUnreadable = 0;
  let owed = 0;
  let received = 0;

  for (const row of csvRows) {
    const hit = byWork.get(row.workEmail);
    const resolution: Resolution = hit?.resolution ?? 'unresolved';
    byResolution[resolution] += 1;
    if (!hit) unresolved.push(row.workEmail);

    // The master list owns start_date. Only when a person has no master row at
    // all does the sheet's own column stand in — and that is reported.
    const masterStart = hit ? parseStartDate(hit.row['Start Date']) : null;
    const start = masterStart ?? (hit ? null : row.startDate);
    if (hit && !masterStart) noStartDate.push(row.workEmail);

    if (masterStart && row.startDate) {
      const a = fmtDateIso(row.startDate);
      const b = fmtDateIso(masterStart);
      if (a !== b) startDivergence.push({ workEmail: row.workEmail, sheet: a, master: b });
    }

    const sel = selectAssertions({ row, start, today: TODAY });
    assertions.push(...sel.assertions);
    problems.push(...sel.problems);
    skippedNotDue += sel.skipped.notDue;
    skippedUnreadable += sel.skipped.unreadable;
    for (const a of sel.assertions) {
      if (a.received) received += 1;
      else owed += 1;
    }
  }

  console.log(
    [
      '',
      'Assertions selected:',
      `  received (Yes)            ${received}`,
      `  NOT received, due (owed)  ${owed}`,
      `  ── total rows to write    ${assertions.length}`,
      '',
      'Cells deliberately NOT imported:',
      `  No against a milestone not yet due   ${skippedNotDue}`,
      `  neither Yes nor No                   ${skippedUnreadable}`,
      '',
      'People:',
      `  on the active roster   ${byResolution.active}`,
      `  offboarded             ${byResolution.offboarded}`,
      `  no master row at all   ${byResolution.unresolved}`,
      '',
      `Start-date divergence (sheet vs master list): ${startDivergence.length}`,
      `Resolved people with NO start date on the master list: ${noStartDate.length}`,
      `Problems reported: ${problems.length}`,
      '',
    ].join('\n'),
  );

  if (unresolved.length) {
    console.log(`No master row (imported anyway, judged on the sheet's own start date):`);
    for (const e of unresolved) console.log(`  ${e}`);
    console.log('');
  }
  if (startDivergence.length) {
    console.log('Start-date divergence — the MASTER LIST was used:');
    for (const d of startDivergence) {
      console.log(`  ${d.workEmail}: sheet=${d.sheet} master=${d.master}`);
    }
    console.log('');
  }
  const notable = problems.filter(
    (p) => p.kind !== 'received_after_gap',
  );
  if (notable.length) {
    console.log('Problems:');
    for (const p of notable.slice(0, 60)) {
      console.log(`  [${p.kind}] line ${p.line} ${p.workEmail ?? ''} ${p.detail}`);
    }
    if (notable.length > 60) console.log(`  … and ${notable.length - 60} more (see the report)`);
    console.log('');
  }

  // ── Reports ──────────────────────────────────────────────────────────────
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(outDir, `gift-receipts-backfill-${stamp}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: apply ? 'apply' : 'report',
        sourceFile: SOURCE_FILE,
        csvPath,
        counts: {
          people: csvRows.length,
          assertions: assertions.length,
          received,
          owed,
          skippedNotDue,
          skippedUnreadable,
          ...byResolution,
        },
        unresolved,
        startDivergence,
        noStartDate,
        problems,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`Report written: ${reportPath}`);

  if (!apply) {
    console.log('\nREPORT ONLY — nothing was written. Re-run with --apply to commit.');
    return;
  }

  // ── Backup BEFORE any write (CLAUDE.md § Data) ───────────────────────────
  const existing: unknown[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('employee_gift_receipts')
      .select('*')
      .order('work_email', { ascending: true })
      .order('milestone_index', { ascending: true })
      .range(from, from + 999);
    if (error) {
      console.error(
        `\nCould not read employee_gift_receipts for the pre-write backup: ${error.message}\n` +
          'Run scripts/apply-gift-receipts-migration.mts --apply first. Refusing to write.',
      );
      process.exit(1);
    }
    const page = data ?? [];
    existing.push(...page);
    if (page.length < 1000) break;
  }
  const backupPath = path.join(outDir, `gift-receipts-backup-${stamp}.json`);
  writeFileSync(backupPath, JSON.stringify(existing, null, 2), 'utf8');
  console.log(`Pre-write backup of ${existing.length} existing row(s): ${backupPath}`);

  // ── Write ────────────────────────────────────────────────────────────────
  const nowIso = new Date().toISOString();
  const payload = assertions.map((a) => ({
    work_email: a.workEmail,
    milestone_index: a.milestoneIndex,
    received: a.received,
    source_milestone_date: a.sourceMilestoneDate,
    source: 'sheet_import' as const,
    source_file: SOURCE_FILE,
    note: '',
    recorded_by: RECORDED_BY,
    recorded_at: nowIso,
  }));

  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const chunk = payload.slice(i, i + CHUNK);
    const { error } = await sb
      .from('employee_gift_receipts')
      .upsert(chunk, { onConflict: 'work_email,milestone_index' });
    if (error) {
      console.error(`\nWrite failed at row ${i}: ${error.message}`);
      console.error(`${written} row(s) were already written. The backup is at ${backupPath}.`);
      process.exit(1);
    }
    written += chunk.length;
    console.log(`  upserted ${written}/${payload.length}`);
  }

  // The import is a bulk assertion about named people; it belongs in the trail
  // like any other. Registered under the `gift_receipt.` family.
  const { error: auditError } = await sb.from('audit_log').insert({
    user_name: RECORDED_BY,
    user_role: 'admin',
    action: 'gift_receipt.imported',
    resource: 'employee_gift_receipts',
    resource_id: SOURCE_FILE,
    details: {
      source_file: SOURCE_FILE,
      rows_written: written,
      received,
      owed,
      skipped_not_due: skippedNotDue,
      skipped_unreadable: skippedUnreadable,
      people: csvRows.length,
      unresolved: unresolved.length,
      report: path.basename(reportPath),
      backup: path.basename(backupPath),
    },
  });
  if (auditError) console.error(`Audit row failed (rows ARE written): ${auditError.message}`);

  console.log(`\nDone. ${written} receipt row(s) written.`);
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
