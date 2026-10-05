/**
 * An orientation mark may only re-date the hire's OWN master row and Sheet row.
 *
 * 2026-09-28: Jackie marked orientation for the five Lead Gen hires minted a
 * recycled work email (`johnt@`, `justinem@`, `maryt@`, `marial@`, `marief@`).
 * None was promoted — promote refuses another person's off-boarded row — yet
 * `syncStartDateToMaster` found each address's (Work Email, Department) row,
 * which was the PREVIOUS holder's, and wrote 2026-09-28 onto all five, plus
 * three of their Sheet rows. Audit item 344.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideStartDateSyncTarget } from './start-date-sync';
import { planSheetStartDateRows } from '../google-sheets/update-master-sheet-start-date';

const ROW = '6e24b138-2e46-419d-88bd-9401b6eee02b';

test('a promoted hire re-dates the row promote linked them to', () => {
  assert.equal(
    decideStartDateSyncTarget(
      { promotedToMasterId: ROW, personalEmail: 'Angel@Example.com ' },
      { id: ROW, personalEmail: 'angel@example.com' },
    ),
    ROW,
  );
});

test('a hire promote never linked re-dates nothing — the 2026-09-28 failure', () => {
  // Tudtud: failed_to_promote, promoted_to_master_id null. The previous
  // holder's row exists for the same (maryt@, Lead Gen) pair.
  assert.equal(
    decideStartDateSyncTarget(
      { promotedToMasterId: null, personalEmail: 'angel@example.com' },
      { id: ROW, personalEmail: 'rose@example.com' },
    ),
    null,
  );
});

test("a link to someone else's row (pre-2026-09-24 reuse) re-dates nothing", () => {
  // Tamala #1072 was promoted onto Torculas's row before decideMasterRowReuse.
  assert.equal(
    decideStartDateSyncTarget(
      { promotedToMasterId: ROW, personalEmail: 'tamala@example.com' },
      { id: ROW, personalEmail: 'torculas@example.com' },
    ),
    null,
  );
});

test('a missing personal email on either side cannot prove ownership', () => {
  assert.equal(
    decideStartDateSyncTarget(
      { promotedToMasterId: ROW, personalEmail: 'a@example.com' },
      { id: ROW, personalEmail: null },
    ),
    null,
  );
  assert.equal(
    decideStartDateSyncTarget(
      { promotedToMasterId: ROW, personalEmail: '' },
      { id: ROW, personalEmail: 'a@example.com' },
    ),
    null,
  );
});

test('a vanished or different master row re-dates nothing', () => {
  assert.equal(
    decideStartDateSyncTarget({ promotedToMasterId: ROW, personalEmail: 'a@example.com' }, null),
    null,
  );
  assert.equal(
    decideStartDateSyncTarget(
      { promotedToMasterId: ROW, personalEmail: 'a@example.com' },
      { id: 'other-id', personalEmail: 'a@example.com' },
    ),
    null,
  );
});

const HEADER = ['Department', 'Personal Email', 'Name', 'Work Email', 'Start Date'];
const sheet = (...rows: string[][]): unknown[][] => [['MASTERLIST', '', '', '', ''], HEADER, ...rows];

test("the Sheet planner skips the previous holder's row on a recycled address", () => {
  const plan = planSheetStartDateRows(
    sheet(
      ['Lead Gen', 'rose@example.com', 'Tronco, Mary Rose', 'maryt@simple.biz', '08/10/26'],
      ['Lead Gen', 'angel@example.com', 'Tudtud, Mary Angelie', 'maryt@simple.biz', ''],
    ),
    { workEmail: 'MARYT@simple.biz', personalEmail: 'angel@example.com' },
  );
  assert.deepEqual(plan, { startCol: 4, rows: [3] });
});

test("the Sheet planner writes nothing when only the previous holder's row exists", () => {
  const plan = planSheetStartDateRows(
    sheet(['Lead Gen', 'rose@example.com', 'Tronco, Mary Rose', 'maryt@simple.biz', '08/10/26']),
    { workEmail: 'maryt@simple.biz', personalEmail: 'angel@example.com' },
  );
  assert.deepEqual(plan, { reason: 'not found in sheet' });
});

test('the Sheet planner skips a row with no personal email, and needs both keys', () => {
  assert.deepEqual(
    planSheetStartDateRows(sheet(['Lead Gen', '', 'X', 'maryt@simple.biz', '']), {
      workEmail: 'maryt@simple.biz',
      personalEmail: 'angel@example.com',
    }),
    { reason: 'not found in sheet' },
  );
  assert.deepEqual(
    planSheetStartDateRows(sheet(['Lead Gen', 'angel@example.com', 'X', 'maryt@simple.biz', '']), {
      workEmail: null,
      personalEmail: 'angel@example.com',
    }),
    { reason: 'work email and personal email are both required to match a row' },
  );
});

test('syncStartDateToMaster targets the linked row, never the (Work Email, Department) pair', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/supabase/hr-pending-employees.ts'), 'utf8');
  const start = src.indexOf('async function syncStartDateToMaster(');
  assert.ok(start > 0, 'syncStartDateToMaster not found');
  const end = src.indexOf('\n}\n', start);
  const body = src.slice(start, end);
  assert.match(body, /decideStartDateSyncTarget\(/);
  assert.match(body, /\.eq\("id", row\.promoted_to_master_id\)/);
  assert.doesNotMatch(body, /ilike\("Work Email"/);
  assert.doesNotMatch(body, /ilike\("Department"/);
});
