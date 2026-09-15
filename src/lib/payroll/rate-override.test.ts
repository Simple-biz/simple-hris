import test from 'node:test';
import assert from 'node:assert/strict';
import { historySupersedeFloor, rateWriteEmail, shadowEmployeeStructures } from './rate-override';
import type { PayStructureSlot } from '@/lib/payment-catalog/pay-structure';

// ── 1. the write is keyed to the identity payroll pays ───────────────────────

test('rateWriteEmail prefers the Hubstaff email, then work, then personal', () => {
  assert.equal(rateWriteEmail('LawangC@simple.biz', 'chrisl@simple.biz', 'axl@gmail.com'), 'lawangc@simple.biz');
  assert.equal(rateWriteEmail(null, 'chrisl@simple.biz', 'axl@gmail.com'), 'chrisl@simple.biz');
  assert.equal(rateWriteEmail(null, null, ' AXL@gmail.com '), 'axl@gmail.com');
  assert.equal(rateWriteEmail('', '', ''), null, 'no email anywhere ⇒ null, never a guess');
});

// ── 2. every other individual structure is a shadow ──────────────────────────

const slot = (id: string, dept: string, email?: string, scope: 'employee' | 'department' = 'employee'): PayStructureSlot => ({
  id,
  scope,
  departmentKey: dept,
  employeeEmail: email,
});

test('shadowEmployeeStructures returns the OTHER employee rows for the same person, any department', () => {
  const rows = [
    slot('keep', 'lead_gen', 'gracechellem@simple.biz'),
    slot('hogan', 'hogan_smith_law', 'GraceChelleM@simple.biz'),
    slot('other-person', 'hogan_smith_law', 'markm@simple.biz'),
    slot('dept-base', 'lead_gen', undefined, 'department'),
  ];
  const shadows = shadowEmployeeStructures('gracechellem@simple.biz', 'keep', rows);
  assert.deepEqual(shadows.map((s) => s.id), ['hogan'], 'case-insensitive on email, the kept row excluded, department bases untouched');
});

test('shadowEmployeeStructures never touches another person or a department structure', () => {
  const rows = [slot('a', 'lead_gen', 'a_b@x.com'), slot('b', 'lead_gen', 'aXb@x.com')];
  // `_` is a LIKE wildcard — the JS compare must NOT treat a_b as matching aXb.
  assert.deepEqual(shadowEmployeeStructures('a_b@x.com', 'zzz', rows).map((s) => s.id), ['a']);
  assert.deepEqual(shadowEmployeeStructures('', 'zzz', rows), [], 'no email ⇒ nothing to retire');
});

// ── 3. the supersede floor ───────────────────────────────────────────────────

test('historySupersedeFloor is the earlier of today and the chosen date', () => {
  assert.equal(historySupersedeFloor('2026-09-15', '2026-08-30'), '2026-08-30', 'back-dated: clears the newer past rows too');
  assert.equal(historySupersedeFloor('2026-09-15', '2026-09-15'), '2026-09-15');
  assert.equal(historySupersedeFloor('2026-09-15', '2026-10-01'), '2026-09-15', 'future-dated: still clears every pending row from today');
});

test('the gracechellem@ case: a ₱175 eff 08-30 save retires the useless 09-01 / 09-08 / 09-11 rows', () => {
  const floor = historySupersedeFloor('2026-09-15', '2026-08-30');
  const history = ['2026-07-20', '2026-09-01', '2026-09-08', '2026-09-11'];
  const kept = history.filter((d) => d < floor);
  assert.deepEqual(kept, ['2026-07-20'], 'only the baseline that precedes the new effective date survives');
});
