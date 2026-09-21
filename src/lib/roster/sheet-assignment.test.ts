/**
 * The corpse engine, pinned.
 *
 * The master sync keys a roster row on `(personal_email, department)`. A
 * department transfer therefore did not MOVE a person — the new department
 * missed the key, so the sync INSERTED a second row and left the first one
 * active forever. Measured on production 2026-09-21: **301 people carried a
 * corpse row**, and 304 of the 314 duplicate groups differed only by Department.
 * `active_employees` hid them (their `last_seen_upload_id` was stale) but the
 * external API served them, which is the whole of the 1,723-vs-1,215 gap.
 *
 * Kane, 2026-09-21: keep the composite key — it is what lets a genuine dual-role
 * person hold two rows — and stop the fork instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideSheetAssignment } from './sheet-assignment';

test('an exact department match updates that row — unchanged behaviour', () => {
  const d = decideSheetAssignment({
    department: 'lead gen',
    csvDepartments: ['lead gen'],
    existing: [{ id: 'a', department: 'lead gen' }],
  });
  assert.deepEqual(d, { action: 'update', id: 'a' });
});

test('a person the sheet lists ONCE never forks a second row — the corpse engine', () => {
  // The sheet now says Client VA; the HRIS row says Lead Gen. Before this fix
  // the sync inserted a Client VA row and left Lead Gen active forever.
  const d = decideSheetAssignment({
    department: 'client va',
    csvDepartments: ['client va'],
    existing: [{ id: 'a', department: 'lead gen' }],
  });
  assert.deepEqual(d, { action: 'adopt', id: 'a' });
});

test('adopting NEVER rewrites Department — the HRIS value stands', () => {
  // Kane, 2026-09-21: the sheet is input-only and never overwrites Department.
  // `adopt` is a distinct action from `update` precisely so the caller cannot
  // write the sheet's department onto a row the HRIS owns.
  const d = decideSheetAssignment({
    department: 'client va',
    csvDepartments: ['client va'],
    existing: [{ id: 'a', department: 'lead gen' }],
  });
  assert.equal(d.action, 'adopt', 'an adopted row keeps its own Department');
});

test('a genuine dual-role person still gets both rows', () => {
  // yong092734@ is Manager AND USEE on the current sheet. The sheet listing a
  // person twice is it ASSERTING a multi-role set, so inserts are allowed.
  const csvDepartments = ['manager', 'usee'];
  const existing = [{ id: 'a', department: 'manager' }];
  assert.deepEqual(
    decideSheetAssignment({ department: 'manager', csvDepartments, existing }),
    { action: 'update', id: 'a' },
  );
  assert.deepEqual(
    decideSheetAssignment({ department: 'usee', csvDepartments, existing }),
    { action: 'insert' },
  );
});

test('a person with no existing active row is inserted', () => {
  assert.deepEqual(
    decideSheetAssignment({ department: 'hr', csvDepartments: ['hr'], existing: [] }),
    { action: 'insert' },
  );
});

test('two existing active rows and ONE sheet row is ambiguous — insert, never guess', () => {
  // Adopting would have to pick one of two rows with nothing to choose on.
  // Falling back to INSERT keeps today's behaviour; the extra row is caught by
  // the duplicate_cleanup sweep rather than by a coin flip here.
  const d = decideSheetAssignment({
    department: 'hr',
    csvDepartments: ['hr'],
    existing: [{ id: 'a', department: 'lead gen' }, { id: 'b', department: 'usee' }],
  });
  assert.deepEqual(d, { action: 'insert' });
});

test('department comparison is case- and whitespace-insensitive', () => {
  assert.deepEqual(
    decideSheetAssignment({
      department: 'Lead Gen',
      csvDepartments: ['  lead gen '],
      existing: [{ id: 'a', department: 'LEAD GEN' }],
    }),
    { action: 'update', id: 'a' },
  );
});

test('an offboarded row is not in `existing` — a leaver is never adopted', () => {
  // The caller passes ACTIVE rows only. Stated as a test so the contract is not
  // lost: adopting a stamped row would silently un-offboard someone, which is
  // the defect master-sync-never-un-offboards.md exists to prevent.
  const d = decideSheetAssignment({ department: 'hr', csvDepartments: ['hr'], existing: [] });
  assert.deepEqual(d, { action: 'insert' });
});

/**
 * The pure decision above cannot enforce what the CALLER does with an `adopt`.
 * `replaceGlobalMasterListFromCsvText` is a long Supabase write path with no
 * seam to fake, so the wiring is pinned by a source scan — the same technique,
 * and the same reason, as `master-sync-never-reactivates.test.ts`.
 */
test('CONTROL: the sync strips Department on an adopted row', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/supabase/global-master-list-db.ts'), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

  assert.match(code, /decideSheetAssignment\(/, 'the sync must route unmatched rows through the decision');
  assert.match(
    code,
    /if \(adopted\) delete updatePayload\["Department"\]/,
    'an adopted row must keep its own Department — the sheet never overwrites it',
  );
  // The offboard columns are stripped on EVERY update; adopting must not have
  // introduced a path that writes one.
  for (const col of ['off_boarded_at', 'off_boarded_reason']) {
    assert.match(code, new RegExp(`delete updatePayload\\["${col}"\\]`), `${col} must stay stripped`);
  }
});
