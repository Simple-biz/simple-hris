import test from 'node:test';
import assert from 'node:assert/strict';

import { planSheetDepartmentUpdate } from './update-master-sheet-department';

/**
 * These tests exist because `sheet_synced=true` used to be set from a fact about
 * the DATABASE (`master.resolution === 'satisfied'`), which silently asserted the
 * Google Sheet was correct when it had never been read. Measured 2026-08-25 that
 * drifted 9 rows and made 6 working people invisible to `active_employees`.
 *
 * The planner must keep three outcomes distinguishable, forever:
 *   flipped (updated > 0) · already correct (alreadyTarget) · DRIFTED (neither).
 */

const TAB = "'Master List'";
const HEADER = ['Department', 'Personal Email', 'Name', 'Work Email'];

function sheet(...rows: string[][]): unknown[][] {
  return [['MASTERLIST', '', '', ''], HEADER, ...rows];
}

const plan = (values: unknown[][], from: string, to: string) =>
  planSheetDepartmentUpdate(values, {
    workEmail: 'kimerl@simple.biz',
    personalEmail: 'krplauron@gmail.com',
    from,
    to,
    quotedTab: TAB,
  });

test('a row sitting in the source department yields a cell range to flip', () => {
  const r = plan(
    sheet(['hsl:intake_specialist', 'krplauron@gmail.com', 'Lauron, Kimer', 'kimerl@simple.biz']),
    'hsl:intake_specialist',
    'Lead Gen',
  );
  assert.equal(r.cellRanges.length, 1);
  // Department is column A; the row is the 3rd sheet row (1-based).
  assert.equal(r.cellRanges[0], `${TAB}!A3`);
  assert.equal(r.alreadyTarget, false);
  assert.equal(r.matchedEmail, true);
  assert.equal(r.reason, undefined);
});

test('a row already in the target reports alreadyTarget, NOT a flip', () => {
  const r = plan(
    sheet(['Lead Gen', 'krplauron@gmail.com', 'Lauron, Kimer', 'kimerl@simple.biz']),
    'hsl:intake_specialist',
    'Lead Gen',
  );
  assert.equal(r.cellRanges.length, 0);
  assert.equal(r.alreadyTarget, true);
  assert.equal(r.matchedEmail, true);
  // No reason: this outcome is a legitimate success, so callers must not record
  // a sheet error and must not raise a false "Retry" badge.
  assert.equal(r.reason, undefined);
});

test('a row in a THIRD department is drift — never alreadyTarget', () => {
  const r = plan(
    sheet(['Client VA', 'krplauron@gmail.com', 'Lauron, Kimer', 'kimerl@simple.biz']),
    'hsl:intake_specialist',
    'Lead Gen',
  );
  assert.equal(r.cellRanges.length, 0);
  assert.equal(r.alreadyTarget, false);
  assert.equal(r.matchedEmail, true);
  assert.deepEqual(r.otherDepartments, ['client va']);
  assert.match(r.reason ?? '', /neither the source nor the target/);
});

test('no email match at all is reported as drift, not success', () => {
  const r = plan(
    sheet(['Lead Gen', 'someoneelse@gmail.com', 'Other Person', 'other@simple.biz']),
    'hsl:intake_specialist',
    'Lead Gen',
  );
  assert.equal(r.cellRanges.length, 0);
  assert.equal(r.alreadyTarget, false);
  assert.equal(r.matchedEmail, false);
  assert.equal(r.reason, 'no matching row in source department');
});

test('matching is case- and whitespace-insensitive on both dept and email', () => {
  const r = plan(
    sheet(['  HSL:Intake_Specialist ', ' KRPLauron@Gmail.com ', 'Lauron, Kimer', '']),
    'hsl:intake_specialist',
    'Lead Gen',
  );
  assert.equal(r.cellRanges.length, 1);
});

test('a person with rows in BOTH source and target flips only the source row', () => {
  const r = plan(
    sheet(
      ['hsl:intake_specialist', 'krplauron@gmail.com', 'Lauron, Kimer', 'kimerl@simple.biz'],
      ['Lead Gen', 'krplauron@gmail.com', 'Lauron, Kimer', 'kimerl@simple.biz'],
    ),
    'hsl:intake_specialist',
    'Lead Gen',
  );
  assert.equal(r.cellRanges.length, 1);
  assert.equal(r.cellRanges[0], `${TAB}!A3`);
  assert.equal(r.alreadyTarget, true);
});

test('a missing header row is reported, not treated as no-match', () => {
  const r = planSheetDepartmentUpdate([['just', 'some', 'junk']], {
    workEmail: 'kimerl@simple.biz',
    personalEmail: null,
    from: 'a',
    to: 'b',
    quotedTab: TAB,
  });
  assert.equal(r.headerIdx, -1);
  assert.equal(r.reason, 'header row not found in sheet');
  assert.equal(r.alreadyTarget, false);
});

test('the work-email-only identity still matches (personal email absent)', () => {
  const r = planSheetDepartmentUpdate(
    sheet(['hsl:intake_specialist', '', 'Lauron, Kimer', 'kimerl@simple.biz']),
    { workEmail: 'kimerl@simple.biz', personalEmail: null, from: 'hsl:intake_specialist', to: 'Lead Gen', quotedTab: TAB },
  );
  assert.equal(r.cellRanges.length, 1);
  assert.equal(r.matchedEmail, true);
});
