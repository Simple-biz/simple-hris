import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeHubstaffUploadsForPab,
  createPabMergeAccumulator,
  mergeUploadRowsInto,
  finishPabMerge,
  type PabMergeUpload,
} from './pab-merge';
import {
  columnsAreAllCanonical,
  resolveCanonicalColumnsToIso,
} from '@/lib/hubstaff/calendar-column-dedupe';
import { normEmail } from '@/lib/email/norm-email';
import { sortHubstaffColumnsForDisplay } from '@/lib/supabase/hubstaff-hours-db';

// ── The oracle ───────────────────────────────────────────────────────────────
// The wizard's merge as it ran inline in `PayrollWizard.tsx` until 2026-09-26,
// copied VERBATIM (only the setState calls replaced by a return). Step 2's pay
// hours read this merge, so the new module must reproduce it exactly — same
// rows, same keys in the same order, same values. Never "update" this copy to
// match the module: it is the thing the module is measured against.
function legacyMerge(
  responses: { file: string; json: { columns?: string[] | null; rows?: Record<string, unknown>[] | null } }[],
): { columns: string[]; rows: Record<string, unknown>[] } {
  const mergeRowsInto = (
    rows: Record<string, unknown>[],
    rowsByEmail: Map<string, Record<string, unknown>>,
    allCols: Set<string>,
    sourceFile?: string,
  ) => {
    for (let row of rows) {
      // Resolve canonical day columns to ISO dates when a source file is provided
      if (sourceFile && columnsAreAllCanonical(Object.keys(row))) {
        row = resolveCanonicalColumnsToIso(row, sourceFile);
      }
      for (const k of Object.keys(row)) allCols.add(k);
      const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
      const email = normEmail(rawEmail) ?? rawEmail.toLowerCase();
      if (!email) continue;
      const existing = rowsByEmail.get(email) ?? {};
      rowsByEmail.set(email, { ...existing, ...row });
    }
  };

  const allCols = new Set<string>();
  const rowsByEmail = new Map<string, Record<string, unknown>>();
  for (const { file, json } of responses) {
    if (!json.columns?.length || !json.rows?.length) continue;
    mergeRowsInto(json.rows, rowsByEmail, allCols, file);
  }
  return { columns: sortHubstaffColumnsForDisplay([...allCols]), rows: [...rowsByEmail.values()] };
}

const asUploads = (
  responses: { file: string; json: { columns?: string[] | null; rows?: Record<string, unknown>[] | null } }[],
): PabMergeUpload[] => responses.map(({ file, json }) => ({ file, columns: json.columns, rows: json.rows }));

/** Byte-level identity: JSON.stringify fixes key ORDER as well as values. */
function assertIdentical(
  responses: { file: string; json: { columns?: string[] | null; rows?: Record<string, unknown>[] | null } }[],
) {
  const expected = JSON.stringify(legacyMerge(structuredClone(responses)));
  const actual = JSON.stringify(mergeHubstaffUploadsForPab(asUploads(structuredClone(responses))));
  assert.equal(actual, expected);
}

const COLS = ['id', 'Member', 'Email', 'Total worked', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'source_file', 'upload_id'];

function weekRow(email: string, member: string, day: string, extra: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {};
  for (const c of COLS) row[c] = null;
  return { ...row, id: `${email}-${day}`, Member: member, Email: email, monday: day, sunday: `${day}-sun`, ...extra };
}

// ── identity with the old inline merge ───────────────────────────────────────

test('identical to the legacy merge across canonical weeks, 8-day Sun→Sun overlaps and file order', () => {
  const responses = [
    // is_current first, then newest-first — the wizard's order.
    { file: 'simple-biz_daily_report_2026-05-31_to_2026-06-07.csv', json: { columns: COLS, rows: [
      weekRow('Ruth@Simple.biz', 'Ruth G', '1:00'), weekRow('ann@simple.biz', 'Ann', '2:00'),
    ] } },
    { file: 'simple-biz_daily_report_2026-05-24_to_2026-05-31.csv', json: { columns: COLS, rows: [
      // May 31 is the TRAILING Sunday here and the LEADING Sunday of the file above.
      weekRow('ruth@simple.biz', 'Ruth Gonzaga', '3:00', { sunday: '1:15:00' }),
      weekRow('bob@simple.biz', 'Bob', '4:00', { 'Total worked': null }),
    ] } },
    { file: 'backfill-may10_2026-05-04_to_2026-05-10.csv', json: { columns: COLS, rows: [
      weekRow('ann@simple.biz', 'Ann B', '5:00', { tuesday: null }),
    ] } },
  ];
  assertIdentical(responses);
});

test('a LATER upload\'s null replaces an earlier value — last-wins includes nulls', () => {
  const responses = [
    { file: 'a_2026-09-13_to_2026-09-19.csv', json: { columns: COLS, rows: [weekRow('x@simple.biz', 'X', '7:00', { Member: 'Newest Name' })] } },
    { file: 'b_2026-09-13_to_2026-09-19.csv', json: { columns: COLS, rows: [weekRow('x@simple.biz', 'X', '7:00', { monday: null, Member: 'Oldest Name' })] } },
  ];
  assertIdentical(responses);
  const merged = mergeHubstaffUploadsForPab(asUploads(responses));
  assert.equal(merged.rows[0]['2026-09-14'], null, 'the older upload\'s null survives');
  assert.equal(merged.rows[0].Member, 'Oldest Name');
});

test('reordering the uploads changes the result — the order is part of the input, never sorted inside', () => {
  const a = { file: 'a_2026-09-13_to_2026-09-19.csv', json: { columns: COLS, rows: [weekRow('x@simple.biz', 'A', '1:00')] } };
  const b = { file: 'b_2026-09-13_to_2026-09-19.csv', json: { columns: COLS, rows: [weekRow('x@simple.biz', 'B', '2:00')] } };
  const ab = mergeHubstaffUploadsForPab(asUploads([a, b]));
  const ba = mergeHubstaffUploadsForPab(asUploads([b, a]));
  assert.equal(ab.rows[0].Member, 'B');
  assert.equal(ba.rows[0].Member, 'A');
  assertIdentical([a, b]);
  assertIdentical([b, a]);
});

test('uploads with no columns or no rows are skipped, exactly as before', () => {
  assertIdentical([
    { file: 'a_2026-09-06_to_2026-09-12.csv', json: { columns: null, rows: null } },
    { file: 'b_2026-09-06_to_2026-09-12.csv', json: { columns: [], rows: [weekRow('x@simple.biz', 'X', '1:00')] } },
    { file: 'c_2026-09-06_to_2026-09-12.csv', json: { columns: COLS, rows: [] } },
    { file: 'd_2026-09-06_to_2026-09-12.csv', json: { columns: COLS, rows: [weekRow('y@simple.biz', 'Y', '1:00')] } },
  ]);
});

test('rows with no email are dropped but their columns still count; lowercase `email` is read too', () => {
  assertIdentical([
    { file: 'a_2026-09-06_to_2026-09-12.csv', json: { columns: COLS, rows: [
      { ...weekRow('', 'Nobody', '1:00'), Extra: 'only-here' },
      { Member: 'Lower', email: ' LOWER@simple.biz ', monday: '2:00' },
    ] } },
  ]);
});

test('ISO-dated (non-canonical) uploads and unparseable filenames pass through untouched', () => {
  const isoRow = { Member: 'I', Email: 'i@simple.biz', '2026-09-14': '7:00', '2026-09-15': '6:00' };
  assertIdentical([
    { file: 'a_2026-09-13_to_2026-09-19.csv', json: { columns: Object.keys(isoRow), rows: [isoRow] } },
    { file: 'no-date-range.csv', json: { columns: COLS, rows: [weekRow('i@simple.biz', 'I2', '3:00')] } },
  ]);
});

test('input rows are never mutated', () => {
  const rows = [weekRow('x@simple.biz', 'X', '1:00')];
  const before = JSON.stringify(rows);
  mergeHubstaffUploadsForPab([
    { file: 'no-date-range.csv', columns: COLS, rows },
    { file: 'no-date-range-2.csv', columns: COLS, rows: [weekRow('x@simple.biz', 'X2', '9:00')] },
  ]);
  assert.equal(JSON.stringify(rows), before);
});

test('the no-upload-list branch (seeded columns, no filename) matches its old inline shape', () => {
  // Old branch: add json.columns to allCols, then merge rows WITHOUT a source file.
  const columns = ['Email', 'Member', 'monday'];
  const rows = [{ Email: 'a@simple.biz', Member: 'A', monday: '1:00' }, { Email: 'A@simple.biz', Member: 'A2', monday: null }];
  const oldCols = new Set<string>(columns);
  const oldBy = new Map<string, Record<string, unknown>>();
  for (const row of structuredClone(rows)) {
    for (const k of Object.keys(row)) oldCols.add(k);
    const raw = String(row.Email ?? '').trim();
    const email = normEmail(raw) ?? raw.toLowerCase();
    oldBy.set(email, { ...(oldBy.get(email) ?? {}), ...row });
  }
  const expected = JSON.stringify({ columns: sortHubstaffColumnsForDisplay([...oldCols]), rows: [...oldBy.values()] });

  const acc = createPabMergeAccumulator();
  for (const c of columns) acc.allCols.add(c);
  mergeUploadRowsInto(acc, structuredClone(rows));
  assert.equal(JSON.stringify(finishPabMerge(acc)), expected);
});

test('randomized: 200 generated upload sets are identical to the legacy merge', () => {
  let seed = 20260926;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const emails = ['a@simple.biz', 'A@Simple.biz', ' b@simple.biz', 'c@simple.biz', '', 'd@hogansmith.com'];
  const files = [
    'simple-biz_daily_report_2026-05-10_to_2026-05-17.csv',
    'simple-biz_daily_report_2026-05-17_to_2026-05-24.csv',
    'simple-biz_daily_report_2026-08-30_to_2026-09-05 4.csv',
    'simple-biz_daily_report_2026-08-23_to_2026-08-29 (1).csv',
    'time-activity-report_2026-04-05_to_2026-05-02.csv',
    'weird.csv',
  ];
  const values = [null, '0:00', '7:00:00', '3:15', '', 8, 0];
  for (let i = 0; i < 200; i++) {
    const responses = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => {
      const cols = rand() < 0.2 ? ['Email', 'Member', '2026-05-11', '2026-05-12'] : COLS;
      const rows = rand() < 0.1 ? [] : Array.from({ length: Math.floor(rand() * 6) }, () => {
        const r: Record<string, unknown> = {};
        for (const c of cols) r[c] = pick(values);
        r.Email = pick(emails);
        r.Member = `M${Math.floor(rand() * 9)}`;
        return r;
      });
      return { file: pick(files), json: { columns: rand() < 0.05 ? null : cols, rows } };
    });
    assertIdentical(responses);
  }
});
