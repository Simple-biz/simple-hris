import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALWAYS_COLUMNS,
  GML_CATALOG,
  GML_KNOWN_COLUMNS,
  NEVER_COLUMNS,
  OFFERABLE_COLUMNS,
  SENSITIVE_COLUMNS,
  isAlways,
  isNever,
  isOfferable,
} from './catalog';

/**
 * The live `global_master_list` column list, read with the service role on
 * 2026-09-17 (`select * limit 1` → Object.keys). If the table grows a column,
 * this test fails until someone decides which class the new column belongs to —
 * that decision is the whole point of the catalog, so it must not be silent.
 */
const LIVE_COLUMNS_2026_09_17 = [
  'id',
  'Department',
  'TeamIndex',
  'Name',
  'Personal Email',
  'Work Email',
  'Start Date',
  'Location',
  'Contact Number',
  'Tenure',
  'Employement Status',
  'created_at',
  'Profile Photo URL',
  'import_batch_id',
  'source_file',
  'first_seen_upload_id',
  'last_seen_upload_id',
  'street',
  'city',
  'province',
  'postal_code',
  'full_address',
  'google_photo_url',
  'off_boarded_at',
  'off_boarded_reason',
  'off_boarded_by',
  'off_boarded_note',
  'employee_id',
  'Alternate Work Email',
  'Alternate Work Email 2',
  'scheduled_deletion_at',
  'deletion_processed_at',
  'Phone Number',
];

test('every live column is classified exactly once, and nothing is classified that does not exist', () => {
  assert.deepEqual([...GML_KNOWN_COLUMNS].sort(), [...LIVE_COLUMNS_2026_09_17].sort());
  assert.equal(new Set(GML_KNOWN_COLUMNS).size, GML_KNOWN_COLUMNS.length, 'a column sits in two classes');
});

test('the three classes are disjoint', () => {
  for (const c of OFFERABLE_COLUMNS) {
    assert.ok(!isAlways(c) && !isNever(c), `${c} is offerable AND always/never`);
  }
  for (const c of NEVER_COLUMNS) assert.ok(!isOfferable(c) && !isAlways(c));
  for (const c of ALWAYS_COLUMNS) assert.ok(!isOfferable(c) && !isNever(c));
});

test('the cursor column is always on, and the off-boarding stamps are never offerable', () => {
  assert.deepEqual([...ALWAYS_COLUMNS], ['id']);
  for (const c of ['off_boarded_at', 'off_boarded_reason', 'off_boarded_by', 'off_boarded_note', 'scheduled_deletion_at', 'deletion_processed_at']) {
    assert.ok(isNever(c), `${c} must never be offerable`);
  }
});

test('personal contact, address and photo columns are marked sensitive; work identity is not', () => {
  for (const c of ['Personal Email', 'Contact Number', 'Phone Number', 'street', 'city', 'province', 'postal_code', 'full_address', 'Profile Photo URL', 'google_photo_url']) {
    assert.ok(SENSITIVE_COLUMNS.includes(c), `${c} should be sensitive`);
  }
  for (const c of ['Name', 'Department', 'Work Email', 'employee_id', 'Start Date']) {
    assert.ok(!SENSITIVE_COLUMNS.includes(c), `${c} should not be sensitive`);
  }
});

test('catalog names are unique and non-blank', () => {
  const names = GML_CATALOG.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.ok(n.trim() === n && n.length > 0);
});
