import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMPLOYEE_CACHE_KEYS } from './tab-cache';

const SRC = readFileSync(join(process.cwd(), 'src/components/employee/EmployeeProfile.tsx'), 'utf8');

test('the bank/payout row is never cached', () => {
  // tab-cache.ts:343-345, verbatim: "Bank/payout rows are deliberately NOT
  // cached: account numbers stay out of storage."
  for (const state of ['bankInfo', 'payout', 'walletRailEffective', 'bankPreferred', 'pendingBankPreferred']) {
    const cached = new RegExp(`const\\s*\\[\\s*${state}\\b[^\\]]*\\]\\s*=\\s*useEmployeeCachedState`);
    assert.ok(!cached.test(SRC), `${state} is cached — it comes from /api/employee-ids and holds account numbers`);
  }
});

test('every declared Profile cache key still has a live call site', () => {
  // A key whose call site the merge collapsed must be DELETED, not left orphaned.
  for (const key of ['profileMaster', 'profileRate', 'paystubSummary', 'profileSkillSet'] as const) {
    assert.ok(
      SRC.includes(`EMPLOYEE_CACHE_KEYS.${key}`),
      `EMPLOYEE_CACHE_KEYS.${key} is declared but no longer used — delete the key or restore the call site`,
    );
    assert.ok(EMPLOYEE_CACHE_KEYS[key], `${key} missing from EMPLOYEE_CACHE_KEYS`);
  }
});

test('no skip/freshness flag has crept in', () => {
  // The employee store deliberately has none; tab-cache.test.ts:323 pins this at
  // the module level, and this pins it at the call site.
  assert.ok(!/hasFetchedThisSession|skipIfFresh|ttlHit/.test(SRC));
});
