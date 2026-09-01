/** [TERMINATION-DOCS]
 * Pinning tests for the shared type surface.
 *
 * Everything here is a PIN, not a behaviour probe: each assertion exists to
 * FAIL when someone later widens a set that a guard depends on. The type layer
 * is G2's first line and G7's allowlist, and `tsc` alone cannot notice a value
 * being ADDED to a `const … as const`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { VALID_OFFBOARD_REASONS } from '@/lib/hr/offboard-reasons';
import {
  TERMINATION_DEPARTURE_REASONS,
  TERMINATION_WRITEBACK_COLUMNS,
  isBlankCell,
  isTerminationDepartureReason,
} from './types';

/** The five spellings of a suspension that the free-text `off_boarded_reason`
 *  column is known to hold. G2's corpus. */
const PAUSE_CORPUS = [
  'temporary_pause',
  'Temporary Pause',
  'TEMPORARY_PAUSE',
  ' temporary-pause ',
  'Temporary  Pause',
];

test('G2: the departure allowlist is exactly the seven reasons — temporary_pause is absent', () => {
  assert.deepEqual(
    [...TERMINATION_DEPARTURE_REASONS],
    ['ncns', 'resigned', 'end_of_contract', 'performance', 'attendance', 'time_manipulation', 'other'],
  );
  assert.equal(TERMINATION_DEPARTURE_REASONS.length, 7);
  assert.equal(
    (TERMINATION_DEPARTURE_REASONS as readonly string[]).includes('temporary_pause'),
    false,
    'a suspension is not a departure — a paused person must not be representable',
  );
});

test('G2: the allowlist is VALID_OFFBOARD_REASONS minus temporary_pause, in the same order', () => {
  // A drift pin. When HR adds an eighth offboard reason this fails, forcing a
  // decision about whether it is a DEPARTURE rather than letting the new reason
  // silently become un-documentable.
  assert.deepEqual(
    [...TERMINATION_DEPARTURE_REASONS],
    VALID_OFFBOARD_REASONS.filter((r) => r !== 'temporary_pause'),
  );
});

test('G2: isTerminationDepartureReason refuses every spelling of a suspension', () => {
  for (const raw of PAUSE_CORPUS) {
    assert.equal(isTerminationDepartureReason(raw), false, `accepted ${JSON.stringify(raw)}`);
  }
  // The normalized key is refused too — the predicate is the last gate after
  // reasonKey(), not a pre-normalization filter.
  assert.equal(isTerminationDepartureReason('temporary_pause'), false);
});

test('G2 negative control: a real departure is accepted, so the predicate is not refusing everything', () => {
  assert.equal(isTerminationDepartureReason('resigned'), true);
  for (const r of TERMINATION_DEPARTURE_REASONS) {
    assert.equal(isTerminationDepartureReason(r), true, `refused the canonical ${r}`);
  }
});

test('isTerminationDepartureReason refuses null, undefined and empty rather than throwing', () => {
  assert.equal(isTerminationDepartureReason(null), false);
  assert.equal(isTerminationDepartureReason(undefined), false);
  assert.equal(isTerminationDepartureReason(''), false);
  // Synthetic non-departures that really do sit in the column.
  assert.equal(isTerminationDepartureReason('duplicate_cleanup'), false);
  assert.equal(isTerminationDepartureReason('sheet_sync'), false);
  assert.equal(isTerminationDepartureReason('Active'), false);
});

test('G7: the write-back allowlist is exactly three columns — never Department, never a rate', () => {
  // THE POINT OF THIS TEST: it must fail if anyone appends "Department" (the
  // most-clobbered cell in the system, reverted by the next master sync) or a
  // rate column (employee_rate_history and employee_hourly_rates are live pay
  // paths — a filled-in historical rate silently re-prices past weeks).
  assert.deepEqual(
    [...TERMINATION_WRITEBACK_COLUMNS],
    ['off_boarded_at', 'off_boarded_reason', 'Start Date'],
  );
  assert.equal(TERMINATION_WRITEBACK_COLUMNS.length, 3);
  for (const forbidden of [
    'Department',
    'Regular Rate',
    'OT Rate',
    'regular_rate',
    'ending_rate',
    'starting_rate',
    'Name',
    'Work Email',
  ]) {
    assert.equal(
      (TERMINATION_WRITEBACK_COLUMNS as readonly string[]).includes(forbidden),
      false,
      `${forbidden} entered the write-back allowlist`,
    );
  }
});

test('G7: the write-back column names reproduce the DB identifiers verbatim, quoting and casing included', () => {
  // `Start Date` is a QUOTED capitalised column; the other two are snake_case.
  // A "tidied" `start_date` here would write to a column that does not exist.
  assert.ok((TERMINATION_WRITEBACK_COLUMNS as readonly string[]).includes('Start Date'));
  assert.equal((TERMINATION_WRITEBACK_COLUMNS as readonly string[]).includes('start_date'), false);
});

test('G7: isBlankCell treats null, absent and whitespace-only as blank — and 0 as a value', () => {
  const inputs: unknown[] = [null, undefined, '', '   ', '\t', 0, 'x', ' x '];
  const expected = [true, true, true, true, true, false, false, false];
  assert.deepEqual(inputs.map(isBlankCell), expected);
});

test('G7: isBlankCell never reports a real cell blank, whatever shape it arrives in', () => {
  // The guard decides whether a cell may be OVERWRITTEN. Every false negative
  // here is a destroyed master value, so the bias is toward "not blank".
  for (const v of ['2026-08-18', 'resigned', '0', 0, false, ' - ', 'n/a', 'TBD']) {
    assert.equal(isBlankCell(v), false, `${JSON.stringify(v)} was called blank`);
  }
  assert.equal(isBlankCell('\n\r\t  '), true);
});

test('types.ts stays PURE and CLIENT-SAFE — it imports nothing at all', () => {
  // The panel is a `use client` file and imports this module. A single
  // `server-only`, Supabase or Node-builtin import would break the build for
  // the whole tab, and would do it at the point of USE, far from here.
  const file = path.resolve(process.cwd(), 'src/lib/documents/termination/types.ts');
  const src = fs.readFileSync(file, 'utf8');
  const offenders = src
    .split(/\r?\n/)
    .filter((line) => /^\s*(import|export\s+.*\bfrom\b|const\s+.*\brequire\()/.test(line));
  assert.deepEqual(offenders, [], `types.ts must import nothing; found: ${offenders.join(' | ')}`);
  assert.equal(/'server-only'/.test(src), false);
});
