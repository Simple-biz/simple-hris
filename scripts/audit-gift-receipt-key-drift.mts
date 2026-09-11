/**
 * [GIFT-RECEIPTS] READ-ONLY: find every receipt whose key the Gift Tracker
 * will never look up, and every receipt that may be attributed to the WRONG
 * person.
 *
 *   node --import tsx scripts/audit-gift-receipt-key-drift.mts
 *   node --import tsx scripts/audit-gift-receipt-key-drift.mts --json reports/key-drift.json
 *
 * WHY THIS EXISTS
 * ---------------
 * The 2026-09-11 backfill resolved the source sheet against the master list on
 * `work_email` ALONE. That is the right storage key, but it is the wrong
 * MATCHING key: a person whose work email changed, or whom the sheet spells
 * differently, resolves to nothing and their receipts land under an address the
 * roster does not use.
 *
 * The failure is SILENT and it reads as the opposite of what it is. The tracker
 * keys the roster row on the master list's `work_email`, finds no receipts, and
 * renders every due milestone as "Not recorded" — indistinguishable from a
 * person nobody has ever assessed. Meanwhile the real rows sit orphaned.
 *
 * Found via lennyt@simple.biz: the sheet says `lennyt@`, the master list says
 * `lenny@`, same name, same 2023-04-10 start date. Her 6 rows (5 received + the
 * 2026-04-10 miss) were invisible on the very screen built to show them.
 *
 * THREE CLASSES, REPORTED SEPARATELY AND NEVER NETTED
 * ---------------------------------------------------
 *  1. ORPHANED    receipts whose work_email matches no master row at all.
 *                 Candidate owners are proposed by NAME + START DATE, never by
 *                 email similarity — `lenny@`/`lennyt@` and `jo@`/`joe@` are the
 *                 same edit distance apart, and one of those is two people.
 *  2. MISATTRIBUTED  the receipt's email resolves to a master row whose NAME
 *                 disagrees with the sheet's name for that row. A recycled work
 *                 email would put one person's gift history on another.
 *  3. DATE DRIFT  the receipt resolves cleanly but the master start date
 *                 disagrees with the sheet's, so due-ness was computed from a
 *                 different clock than the tracker will use.
 *
 * NOTHING IS REPAIRED HERE. A proposed match is EVIDENCE, not a verdict —
 * merging two people's gift history is worse than leaving a gap visible.
 *
 * READ-ONLY BY CONSTRUCTION: plain `select` only. `.env.local` holds PRODUCTION
 * service-role credentials.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import importModule from '../src/lib/gift-tracker/receipt-import';
import milestonesModule from '../src/lib/gift-milestones';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local') });
dotenv.config();

// Default-import + cast: `.mts` is true ESM and tsx transpiles the imported
// `.ts` to CJS, so named exports do not come through.
const { parseGiftReceiptCsv } =
  importModule as unknown as typeof import('../src/lib/gift-tracker/receipt-import');
const { fmtDateIso, parseStartDate } =
  milestonesModule as unknown as typeof import('../src/lib/gift-milestones');

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const csvPath = path.join(
  REPO_ROOT,
  argValue('--file') ??
    'references/docs/Work Anniversary Gift Tracker - Copy of HRIS Active Ppl.csv',
);
const jsonOut = argValue('--json');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

type MasterRaw = {
  Name: string | null;
  'Work Email': string | null;
  'Personal Email': string | null;
  'Start Date': string | null;
};

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

type ReceiptRow = { work_email: string; milestone_index: number; received: boolean };

async function pageReceipts(): Promise<ReceiptRow[]> {
  const out: ReceiptRow[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await sb
      .from('employee_gift_receipts')
      .select('work_email, milestone_index, received')
      .order('work_email', { ascending: true })
      .order('milestone_index', { ascending: true })
      .range(from, from + size - 1);
    if (error) throw new Error(`employee_gift_receipts: ${error.message}`);
    const rows = (data ?? []) as unknown as ReceiptRow[];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

/**
 * Reduce a master-list display name to something comparable across sources.
 * `Tesalona, Maria Linda "Lenny"` → `tesalona maria linda`. The go-by nickname
 * is dropped because the sheet and the master list disagree about it constantly;
 * the legal part is what is stable.
 */
function normName(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw)
    .replace(/"[^"]*"/g, ' ')
    .replace(/[^A-Za-z\s]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

function isoOf(raw: string | null | undefined): string | null {
  const d = parseStartDate(raw ?? null);
  return d ? fmtDateIso(d) : null;
}

async function main() {
  const active = await pageAll('active_employees');
  const gml = await pageAll('global_master_list');
  const receipts = await pageReceipts();
  const { rows: csvRows } = parseGiftReceiptCsv(readFileSync(csvPath, 'utf8'));

  console.log(
    `Roster: ${active.length} active / ${gml.length} master · Receipts: ${receipts.length} rows · Sheet: ${csvRows.length} people\n`,
  );

  // Every key the Gift Tracker will actually look receipts up under.
  const rosterKeys = new Set<string>();
  for (const r of active) {
    const k = r['Work Email']?.trim().toLowerCase();
    if (k) rosterKeys.add(k);
  }

  const masterByWork = new Map<string, MasterRaw>();
  for (const r of gml) {
    const k = r['Work Email']?.trim().toLowerCase();
    if (k) masterByWork.set(k, r);
  }
  const csvByWork = new Map(csvRows.map((r) => [r.workEmail, r]));

  // Candidate index: normalised legal name → master rows carrying it.
  const masterByName = new Map<string, MasterRaw[]>();
  for (const r of gml) {
    const n = normName(r.Name);
    if (!n) continue;
    const arr = masterByName.get(n) ?? [];
    arr.push(r);
    masterByName.set(n, arr);
  }

  // Receipts grouped by their stored key.
  const byKey = new Map<string, ReceiptRow[]>();
  for (const r of receipts) {
    const arr = byKey.get(r.work_email) ?? [];
    arr.push(r);
    byKey.set(r.work_email, arr);
  }

  const orphaned: unknown[] = [];
  const misattributed: unknown[] = [];
  const dateDrift: unknown[] = [];

  for (const [key, rows] of byKey) {
    const csv = csvByWork.get(key);
    const master = masterByWork.get(key);
    const summary = {
      workEmail: key,
      sheetName: csv?.name ?? null,
      receiptCount: rows.length,
      received: rows.filter((r) => r.received).length,
      owed: rows.filter((r) => !r.received).length,
      milestones: rows.map((r) => `${r.milestone_index}:${r.received ? 'Y' : 'N'}`).join(' '),
    };

    if (!master) {
      // CLASS 1 — nothing on the roster carries this address.
      const candidates = (masterByName.get(normName(csv?.name)) ?? []).map((m) => ({
        name: m.Name,
        workEmail: m['Work Email'],
        personalEmail: m['Personal Email'],
        masterStart: isoOf(m['Start Date']),
        sheetStart: csv ? isoOf(csv.startDateRaw) : null,
        startMatches: csv ? isoOf(csv.startDateRaw) === isoOf(m['Start Date']) : false,
        onActiveRoster: rosterKeys.has((m['Work Email'] ?? '').trim().toLowerCase()),
      }));
      orphaned.push({ ...summary, candidates });
      continue;
    }

    // CLASS 2 — the address resolves, but to a different human.
    const sheetName = normName(csv?.name);
    const masterName = normName(master.Name);
    if (sheetName && masterName && sheetName !== masterName) {
      misattributed.push({
        ...summary,
        masterName: master.Name,
        masterStart: isoOf(master['Start Date']),
        sheetStart: csv ? isoOf(csv.startDateRaw) : null,
      });
    }

    // CLASS 3 — resolves to the right person on a different clock.
    const a = csv ? isoOf(csv.startDateRaw) : null;
    const b = isoOf(master['Start Date']);
    if (a && b && a !== b) {
      dateDrift.push({ ...summary, sheetStart: a, masterStart: b, masterName: master.Name });
    }
  }

  const report = (label: string, rows: unknown[]) => {
    console.log(`\n${'='.repeat(72)}\n${label}: ${rows.length}\n${'='.repeat(72)}`);
    for (const r of rows) console.log(JSON.stringify(r));
  };

  report('CLASS 1 — ORPHANED receipts (no master row carries this address)', orphaned);
  report('CLASS 2 — MISATTRIBUTED (address resolves to a DIFFERENT name)', misattributed);
  report('CLASS 3 — START-DATE DRIFT (right person, different clock)', dateDrift);

  // How many people the tracker will show as "Not recorded" purely because of a
  // key mismatch — the number that makes this worth fixing.
  const strandedGifts = orphaned.reduce(
    (n, o) => n + (o as { receiptCount: number }).receiptCount,
    0,
  );
  const rescuable = orphaned.filter(
    (o) =>
      (o as { candidates: { startMatches: boolean; onActiveRoster: boolean }[] }).candidates.filter(
        (c) => c.startMatches,
      ).length === 1,
  );

  console.log(
    [
      '',
      '='.repeat(72),
      'SUMMARY',
      '='.repeat(72),
      `  orphaned keys                       ${orphaned.length}`,
      `  receipt rows stranded under them    ${strandedGifts}`,
      `  of those, EXACTLY ONE name+date match (rescuable)  ${rescuable.length}`,
      `  misattributed keys                  ${misattributed.length}`,
      `  start-date drift                    ${dateDrift.length}`,
      '',
      '  A proposed candidate is EVIDENCE, not a verdict. Nothing is repaired by',
      '  this script — merging two people’s gift history is worse than a visible gap.',
      '',
    ].join('\n'),
  );

  if (jsonOut) {
    const p = path.join(REPO_ROOT, jsonOut);
    if (!existsSync(path.dirname(p))) mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify(
        {
          generatedAt: null,
          counts: {
            orphanedKeys: orphaned.length,
            strandedGifts,
            rescuable: rescuable.length,
            misattributed: misattributed.length,
            dateDrift: dateDrift.length,
          },
          orphaned,
          misattributed,
          dateDrift,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`JSON written: ${p}`);
  }
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
