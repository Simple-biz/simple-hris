/**
 * Parse the "Work Anniversary Gift Tracker" sheet export into tenure-gift
 * fulfilment assertions.
 *
 * Pure and total — no I/O, no Supabase, no `Date.now()`. `scripts/backfill-gift-
 * receipts.mts` does the reading and the writing; everything that can be
 * decided from the file alone is decided (and tested) here.
 *
 * THE FILE'S SHAPE IS ASSERTED, NOT SNIFFED
 * -----------------------------------------
 * `Employee ID, Name, <junk>, Work Email, Start Date,` then eight
 * `<N> Mo Gift Date, Received?` pairs — 21 columns. A header that does not
 * match is REFUSED rather than best-guessed: this file decides who the company
 * owes a gift, and a silently mis-mapped column would move that answer without
 * anything looking wrong.
 *
 * Column 2 ("Email Not found on Gift Tracker") is a lookup scratch column and
 * is deliberately ignored — it holds `#N/A` and free text like "not on gift
 * tracker, never received anything". The key is the WORK email in column 3,
 * which is unique across all 1,229 rows and is the only column that resolves
 * against the master list. See references/sql/migrate/2026-09-11_gift_receipts.sql
 * for why fulfilment is not keyed on personal_email.
 *
 * NOTHING IS DEFAULTED
 * --------------------
 * A cell that is neither Yes nor No produces a PROBLEM and no assertion. An
 * unparseable date produces a problem and a null `sourceMilestoneDate`. The
 * importer never invents a value to keep a row moving — an absent assertion is
 * a representable state downstream (`unknown`), so there is no pressure to.
 */
import { fmtDateIso, parseStartDate } from '@/lib/gift-milestones';
import { isMilestoneDue, MAX_MILESTONE_INDEX } from './receipts';

/** The eight milestone pairs the sheet carries: 6 Mo … 48 Mo. */
export const MILESTONE_COLUMN_COUNT = 8;

/** 5 leading columns + 8 (date, received) pairs. */
export const EXPECTED_COLUMN_COUNT = 5 + MILESTONE_COLUMN_COUNT * 2;

const COL_EMPLOYEE_ID = 0;
const COL_NAME = 1;
// Column 2 is the ignored lookup scratch column.
const COL_WORK_EMAIL = 3;
const COL_START_DATE = 4;
const FIRST_MILESTONE_COL = 5;

/**
 * RFC-4180 CSV reader. Philippine addresses and `"Surname, First ""Nick"""`
 * names are full of commas and embedded quotes, so a `split(',')` is not an
 * option.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A trailing newline leaves one empty trailing field, not a row.
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

export type GiftReceiptProblemKind =
  | 'blank_work_email'
  | 'duplicate_work_email'
  | 'unreadable_received_value'
  | 'unreadable_milestone_date'
  | 'unreadable_start_date'
  | 'wrong_column_count'
  | 'received_after_gap'
  | 'received_before_due';

export interface GiftReceiptProblem {
  kind: GiftReceiptProblemKind;
  /** 1-based line in the file, counting the header as line 1. */
  line: number;
  workEmail: string | null;
  milestoneIndex: number | null;
  detail: string;
}

export interface GiftReceiptCsvCell {
  milestoneIndex: number;
  /** The cell verbatim, for the problem report. */
  rawReceived: string;
  /** `null` when the cell was neither Yes nor No. */
  received: boolean | null;
  /** ISO date the SHEET asserted for this milestone. Evidence only. */
  sourceMilestoneDate: string | null;
}

export interface GiftReceiptCsvRow {
  line: number;
  employeeId: string;
  name: string;
  workEmail: string;
  startDateRaw: string;
  /** Parsed from the sheet's own Start Date column; the master list overrides. */
  startDate: Date | null;
  cells: GiftReceiptCsvCell[];
}

export interface GiftReceiptCsvParse {
  rows: GiftReceiptCsvRow[];
  problems: GiftReceiptProblem[];
}

function readReceived(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === 'yes') return true;
  if (v === 'no') return false;
  return null;
}

/**
 * Parse the whole file. Throws only on a header that is not this file — every
 * other defect is reported as a problem so one bad cell cannot cost 1,228 good
 * rows.
 */
export function parseGiftReceiptCsv(text: string): GiftReceiptCsvParse {
  const table = parseCsv(text);
  if (table.length === 0) throw new Error('The gift tracker CSV is empty.');

  const header = table[0];
  if (header.length !== EXPECTED_COLUMN_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_COLUMN_COUNT} columns in the gift tracker CSV, found ${header.length}. ` +
        'Refusing to guess the column mapping — this file decides who is owed a gift.',
    );
  }
  if (header[COL_WORK_EMAIL].trim().toLowerCase() !== 'work email') {
    throw new Error(
      `Column ${COL_WORK_EMAIL + 1} should be "Work Email" but reads ` +
        `"${header[COL_WORK_EMAIL]}". Refusing to guess the column mapping.`,
    );
  }
  for (let m = 0; m < MILESTONE_COLUMN_COUNT; m += 1) {
    const got = header[FIRST_MILESTONE_COL + m * 2 + 1].trim().toLowerCase();
    if (got !== 'received?') {
      throw new Error(
        `Expected "Received?" at column ${FIRST_MILESTONE_COL + m * 2 + 2}, found "${got}". ` +
          'Refusing to guess the column mapping.',
      );
    }
  }

  const rows: GiftReceiptCsvRow[] = [];
  const problems: GiftReceiptProblem[] = [];
  const seen = new Map<string, number>();

  for (let r = 1; r < table.length; r += 1) {
    const line = r + 1;
    const raw = table[r];
    if (raw.length !== EXPECTED_COLUMN_COUNT) {
      problems.push({
        kind: 'wrong_column_count',
        line,
        workEmail: null,
        milestoneIndex: null,
        detail: `${raw.length} columns, expected ${EXPECTED_COLUMN_COUNT} — row skipped`,
      });
      continue;
    }

    const workEmail = raw[COL_WORK_EMAIL].trim().toLowerCase();
    if (!workEmail) {
      problems.push({
        kind: 'blank_work_email',
        line,
        workEmail: null,
        milestoneIndex: null,
        detail: `"${raw[COL_NAME]}" has no work email — row skipped`,
      });
      continue;
    }
    const priorLine = seen.get(workEmail);
    if (priorLine !== undefined) {
      problems.push({
        kind: 'duplicate_work_email',
        line,
        workEmail,
        milestoneIndex: null,
        detail: `already seen on line ${priorLine} — row skipped`,
      });
      continue;
    }
    seen.set(workEmail, line);

    const startDateRaw = raw[COL_START_DATE].trim();
    const startDate = parseStartDate(startDateRaw);
    if (!startDate) {
      problems.push({
        kind: 'unreadable_start_date',
        line,
        workEmail,
        milestoneIndex: null,
        detail: `start date "${startDateRaw}" is unreadable`,
      });
    }

    const cells: GiftReceiptCsvCell[] = [];
    let sawNotReceived = false;
    for (let m = 0; m < MILESTONE_COLUMN_COUNT; m += 1) {
      const milestoneIndex = m + 1;
      const rawDate = raw[FIRST_MILESTONE_COL + m * 2].trim();
      const rawReceived = raw[FIRST_MILESTONE_COL + m * 2 + 1];

      const parsedDate = parseStartDate(rawDate);
      if (rawDate && !parsedDate) {
        problems.push({
          kind: 'unreadable_milestone_date',
          line,
          workEmail,
          milestoneIndex,
          detail: `"${rawDate}" is not a date`,
        });
      }

      const received = readReceived(rawReceived);
      if (received === null) {
        problems.push({
          kind: 'unreadable_received_value',
          line,
          workEmail,
          milestoneIndex,
          detail: `"${rawReceived}" is neither Yes nor No — no assertion recorded`,
        });
      } else if (received) {
        if (sawNotReceived) {
          problems.push({
            kind: 'received_after_gap',
            line,
            workEmail,
            milestoneIndex,
            detail: 'marked received after an earlier milestone was not — imported as stated',
          });
        }
      } else {
        sawNotReceived = true;
      }

      cells.push({
        milestoneIndex,
        rawReceived,
        received,
        sourceMilestoneDate: parsedDate ? fmtDateIso(parsedDate) : null,
      });
    }

    rows.push({
      line,
      employeeId: raw[COL_EMPLOYEE_ID].trim(),
      name: raw[COL_NAME].trim(),
      workEmail,
      startDateRaw,
      startDate,
      cells,
    });
  }

  return { rows, problems };
}

export interface GiftReceiptAssertion {
  workEmail: string;
  milestoneIndex: number;
  received: boolean;
  sourceMilestoneDate: string | null;
}

export interface GiftReceiptSelection {
  assertions: GiftReceiptAssertion[];
  problems: GiftReceiptProblem[];
  /** Cells deliberately not imported, by reason. Counted, not listed. */
  skipped: { notDue: number; unreadable: number };
}

/**
 * Decide which of a row's eight cells become rows in `employee_gift_receipts`.
 *
 * THE RULE, and the reason it is not "import everything":
 *
 *   received = Yes  →  always imported. A stated receipt is a fact regardless
 *                      of whether the milestone has arrived (one cell in the
 *                      2026-09-11 file is exactly that, and it is flagged, not
 *                      dropped).
 *   received = No   →  imported ONLY when the milestone has already come due.
 *                      A "No" against a milestone years away is the
 *                      spreadsheet's default, not somebody's assertion; writing
 *                      it would manufacture 8,398 findings out of blank cells
 *                      and make `owed` meaningless.
 *   anything else   →  nothing is written. Absence reads as `unknown`
 *                      downstream, which is the truth.
 *
 * `start` is the AUTHORITATIVE start date — the master list's, not the sheet's.
 * Due-ness is computed by `isMilestoneDue`, the same predicate the roster and
 * the export use, so an imported `owed` and a displayed `owed` cannot diverge.
 * A person with no authoritative start date has no computable due milestone, so
 * only their `Yes` cells import.
 */
export function selectAssertions(args: {
  row: GiftReceiptCsvRow;
  start: Date | null;
  today: Date;
}): GiftReceiptSelection {
  const { row, start, today } = args;
  const assertions: GiftReceiptAssertion[] = [];
  const problems: GiftReceiptProblem[] = [];
  const skipped = { notDue: 0, unreadable: 0 };

  for (const cell of row.cells) {
    if (cell.milestoneIndex > MAX_MILESTONE_INDEX) continue;
    if (cell.received === null) {
      skipped.unreadable += 1;
      continue;
    }
    const due = isMilestoneDue(start, cell.milestoneIndex, today);
    if (cell.received) {
      if (!due) {
        problems.push({
          kind: 'received_before_due',
          line: row.line,
          workEmail: row.workEmail,
          milestoneIndex: cell.milestoneIndex,
          detail:
            `recorded as received but the ${cell.milestoneIndex * 6}-month milestone ` +
            `${start ? 'has not arrived' : 'cannot be dated (no start date on the master list)'}` +
            ' — imported as stated',
        });
      }
    } else if (!due) {
      skipped.notDue += 1;
      continue;
    }
    assertions.push({
      workEmail: row.workEmail,
      milestoneIndex: cell.milestoneIndex,
      received: cell.received,
      sourceMilestoneDate: cell.sourceMilestoneDate,
    });
  }

  return { assertions, problems, skipped };
}
