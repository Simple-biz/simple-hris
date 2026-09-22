import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import { __RATE_CACHE_KEY_LISTS, toCachedEmployeeRate } from '@/lib/employee/rate-row-cache';

/**
 * A fully-populated row. Every routing field carries a value that would be
 * obvious in a storage dump, so a leak fails on the value as well as the key.
 */
const FULL_ROW: EmployeeHourlyRateRow = {
  work_email: 'jane@simple.biz',
  personal_email: 'jane@gmail.com',
  regular_rate: '175',
  ot_rate: '262.5',
  department: 'lead_gen',
  bank_preferred: 'wires',
  hurupay_email: 'jane-hurupay@example.com',
  higlobe_email: 'jane-higlobe@example.com',
  higlobe_account_name: 'JANE DELA CRUZ',
  phone_number: '+63 917 000 0000',
  full_address: '12 Mabini St, Barangay 5',
  city: 'Cebu City',
  province_state: 'Cebu',
  mesa_member: true,
  mesa_member_since: '2026-03-01',
  mesa_fpu_completed_on: '2026-02-14',
  mesa_account_number: '26-03-00123',
};

test('toCachedEmployeeRate keeps the pay identity and programme fields', () => {
  assert.deepEqual(toCachedEmployeeRate(FULL_ROW), {
    work_email: 'jane@simple.biz',
    personal_email: 'jane@gmail.com',
    regular_rate: '175',
    ot_rate: '262.5',
    department: 'lead_gen',
    mesa_member: true,
    mesa_member_since: '2026-03-01',
    mesa_fpu_completed_on: '2026-02-14',
  });
});

test('toCachedEmployeeRate drops every payment-routing and contact field', () => {
  const cached = toCachedEmployeeRate(FULL_ROW) as Record<string, unknown>;
  for (const key of __RATE_CACHE_KEY_LISTS.uncacheable) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(cached, key),
      `${key} must not survive the projection`,
    );
  }
});

test('no routing VALUE survives anywhere in the serialized projection', () => {
  // The real failure mode is a value riding under a different key, which a
  // per-key assertion would miss. Serialize and look for the strings.
  const serialized = JSON.stringify(toCachedEmployeeRate(FULL_ROW));
  for (const key of __RATE_CACHE_KEY_LISTS.uncacheable) {
    const value = FULL_ROW[key];
    if (typeof value !== 'string') continue;
    assert.ok(!serialized.includes(value), `${key}'s value leaked into the cached shape`);
  }
});

test('every key of the rate row is classified exactly once', () => {
  // The compiler already proves the partition COVERS `keyof
  // EmployeeHourlyRateRow`; this pins that the two lists are also DISJOINT,
  // which the type-level check alone does not catch.
  const overlap = __RATE_CACHE_KEY_LISTS.cacheable.filter((k) =>
    (__RATE_CACHE_KEY_LISTS.uncacheable as readonly string[]).includes(k),
  );
  assert.deepEqual(overlap, []);
  assert.equal(
    __RATE_CACHE_KEY_LISTS.cacheable.length + __RATE_CACHE_KEY_LISTS.uncacheable.length,
    Object.keys(FULL_ROW).length,
  );
});

test('a missing row projects to null, never an empty object', () => {
  assert.equal(toCachedEmployeeRate(null), null);
  assert.equal(toCachedEmployeeRate(undefined), null);
});

test('the projection is JSON round-trippable — no Date, Set or Map can enter it', () => {
  const cached = toCachedEmployeeRate(FULL_ROW);
  assert.deepEqual(JSON.parse(JSON.stringify(cached)), cached);
});
