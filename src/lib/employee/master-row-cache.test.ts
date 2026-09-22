import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EmployeeRow } from '@/lib/supabase/employees';
import {
  __MASTER_CACHE_KEY_LISTS,
  toCachedMasterRow,
  toCachedMasterRows,
} from '@/lib/employee/master-row-cache';

/** Every field populated, so a leak fails on the value as well as the key. */
const FULL_ROW: Required<EmployeeRow> = {
  id: 'f1e2d3c4',
  employee_id: 'SB-0042',
  department: 'lead_gen',
  name: 'Jane Dela Cruz',
  personal_email: 'jane@gmail.com',
  work_email: 'jane@simple.biz',
  alternate_work_email: 'j.delacruz@simple.biz',
  alternate_work_email_2: null,
  start_date: '2025-04-01',
  hourlyRate: 175,
  bankInfo: {
    accountName: 'JANE DELA CRUZ',
    accountNumber: '000123456789',
    bankName: 'BDO',
    routingNumber: '021000021',
  },
  street: '12 Mabini St',
  city: 'Cebu City',
  province: 'Cebu',
  postal_code: '6000',
  full_address: '12 Mabini St, Barangay 5, Cebu City',
  phone_number: '+63 917 000 0000',
  location: '12 Mabini St, Cebu',
  profile_photo_url: 'https://example.test/photo.png',
  google_photo_url: 'https://example.test/g.png',
  hsl_role: 'Intake Specialist',
  hsl_hourly_rate: 220,
  hsl_ot_rate: 330,
  regular_rate: 175,
  ot_rate: 262.5,
  mesa_member: true,
  calltools_username: 'jdelacruz',
};

test('the projection keeps identity, org placement and avatars', () => {
  const cached = toCachedMasterRow(FULL_ROW) as Record<string, unknown>;
  for (const key of __MASTER_CACHE_KEY_LISTS.cacheable) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(cached, key),
      `${key} should survive the projection`,
    );
  }
  assert.equal(cached.work_email, 'jane@simple.biz');
  assert.equal(cached.department, 'lead_gen');
});

test('the projection drops every address, phone, rate and bank field', () => {
  const cached = toCachedMasterRow(FULL_ROW) as Record<string, unknown>;
  for (const key of __MASTER_CACHE_KEY_LISTS.uncacheable) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(cached, key),
      `${key} must not survive the projection`,
    );
  }
});

test('no address, phone or account VALUE survives anywhere in the serialized row', () => {
  // The failure that matters is a value riding under a different key, which a
  // per-key assertion would miss.
  const serialized = JSON.stringify(toCachedMasterRow(FULL_ROW));
  for (const needle of [
    '000123456789',
    '021000021',
    'BDO',
    '12 Mabini St',
    '+63 917 000 0000',
    '6000',
  ]) {
    assert.ok(!serialized.includes(needle), `${needle} leaked into the cached shape`);
  }
});

test('every key of the row is classified exactly once', () => {
  // The compiler proves the partition COVERS `keyof EmployeeRow`; this pins that
  // the two lists are also DISJOINT and that neither has drifted from the type.
  const overlap = __MASTER_CACHE_KEY_LISTS.cacheable.filter((k) =>
    (__MASTER_CACHE_KEY_LISTS.uncacheable as readonly string[]).includes(k),
  );
  assert.deepEqual(overlap, []);
  assert.equal(
    __MASTER_CACHE_KEY_LISTS.cacheable.length + __MASTER_CACHE_KEY_LISTS.uncacheable.length,
    Object.keys(FULL_ROW).length,
  );
});

test('an absent optional field is dropped, not written as undefined', () => {
  const sparse = { employee_id: null, department: null, name: 'X', personal_email: null, start_date: null } as EmployeeRow;
  const cached = toCachedMasterRow(sparse) as Record<string, unknown>;
  assert.ok(!Object.prototype.hasOwnProperty.call(cached, 'work_email'));
  assert.equal(cached.name, 'X');
});

test('a whole roster projects row by row', () => {
  const rows = toCachedMasterRows([FULL_ROW, FULL_ROW]);
  assert.equal(rows.length, 2);
  assert.ok(!JSON.stringify(rows).includes('000123456789'));
});

test('the projection is JSON round-trippable — no Date, Set or Map can enter it', () => {
  const cached = toCachedMasterRow(FULL_ROW);
  assert.deepEqual(JSON.parse(JSON.stringify(cached)), cached);
});
