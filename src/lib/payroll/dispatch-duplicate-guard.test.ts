import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  alreadyPaidMessage,
  duplicateGuardApplies,
  findDuplicatePaid,
  sameDispatchCycle,
  type DuplicateGuardInput,
  type PriorDispatch,
} from './dispatch-duplicate-guard';

/**
 * Pins the server-side double-pay guard added 2026-09-03 after 82 people were
 * logged paid twice in one cycle (cobb@ was the reported case: two identical
 * rows 50 s apart, same txn id). The failure classes closed here:
 *  1. a second `paid` POST for the same cycle + person is refused;
 *  2. non-paid outcomes and contractor settlements are never refused;
 *  3. the arrears "Settle" legs (cycle_id null, source file set) are keyed by
 *     file so they can neither slip through nor block a DIFFERENT cycle.
 */

const FILE = 'simple-biz_daily_report_2026-08-23_to_2026-08-29 (1).csv';
const CYCLE = 'f3a2227d-d718-42cc-ad1d-c3ef3999cce5';

function prior(over: Partial<PriorDispatch> = {}): PriorDispatch {
  return {
    id: '16922b92-30b9-4051-84e1-2fcc9dff5c3f',
    status: 'paid',
    payee_type: 'employee',
    recipient_email: 'cobb@simple.biz',
    cycle_source_file: FILE,
    cycle_id: CYCLE,
    created_by: 'graceh@simple.biz',
    created_at: '2026-09-03T15:55:02.567067+00:00',
    transaction_id: '2349842097',
    ...over,
  };
}

function input(over: Partial<DuplicateGuardInput> = {}): DuplicateGuardInput {
  return {
    status: 'paid',
    payeeType: 'employee',
    recipientEmail: 'cobb@simple.biz',
    cycleSourceFile: FILE,
    cycleId: CYCLE,
    ...over,
  };
}

test('the reported case: a second paid POST for the same cycle + person is a duplicate', () => {
  const dup = findDuplicatePaid(input(), [prior()]);
  assert.ok(dup);
  assert.equal(dup.id, '16922b92-30b9-4051-84e1-2fcc9dff5c3f');
});

test('status defaults to paid — an omitted status is still guarded', () => {
  assert.equal(duplicateGuardApplies(input({ status: undefined })), true);
  assert.ok(findDuplicatePaid(input({ status: undefined }), [prior()]));
});

test('email match is case- and whitespace-insensitive', () => {
  assert.ok(findDuplicatePaid(input({ recipientEmail: '  Cobb@Simple.biz ' }), [prior()]));
});

test('oldest paid row wins when several already exist', () => {
  const dup = findDuplicatePaid(input(), [
    prior({ id: 'newer', created_at: '2026-09-03T15:55:52.646594+00:00' }),
    prior({ id: 'oldest', created_at: '2026-09-03T15:55:02.567067+00:00' }),
  ]);
  assert.equal(dup?.id, 'oldest');
});

test('not_paid / threshold / problem POSTs are log entries, never blocked', () => {
  for (const status of ['not_paid', 'threshold', 'problem']) {
    assert.equal(duplicateGuardApplies(input({ status })), false, status);
    assert.equal(findDuplicatePaid(input({ status }), [prior()]), null, status);
  }
});

test('a prior not_paid / threshold / problem row does not block a real payment', () => {
  for (const status of ['not_paid', 'threshold', 'problem']) {
    assert.equal(findDuplicatePaid(input(), [prior({ status })]), null, status);
  }
});

test('contractor settlements are outside the guard (the invoice claim owns them)', () => {
  assert.equal(duplicateGuardApplies(input({ payeeType: 'contractor' })), false);
  // A paid INVOICE for the same email never blocks that person's salary row.
  assert.equal(findDuplicatePaid(input(), [prior({ payee_type: 'contractor' })]), null);
});

test('pre-migration rows with no payee_type count as employee rows', () => {
  assert.ok(findDuplicatePaid(input(), [prior({ payee_type: undefined })]));
  assert.ok(findDuplicatePaid(input(), [prior({ payee_type: null })]));
});

test('a different cycle is never a duplicate', () => {
  const lastWeek = prior({
    cycle_source_file: 'simple-biz_daily_report_2026-08-16_to_2026-08-22.csv',
    cycle_id: '750f66bb-817c-4181-8d6e-11d93f2f8aa4',
  });
  assert.equal(findDuplicatePaid(input(), [lastWeek]), null);
});

test('arrears Settle legs (cycle_id null, source file set) are keyed by the file', () => {
  const leg = input({ cycleId: null });
  // Same file already paid → blocked, even though the leg carries no cycle id.
  assert.ok(findDuplicatePaid(leg, [prior()]));
  // A held cycle paid under a different file is NOT blocked by this week's row.
  const olderLeg = input({
    cycleId: null,
    cycleSourceFile: 'simple-biz_daily_report_2026-08-16_to_2026-08-22.csv',
  });
  assert.equal(findDuplicatePaid(olderLeg, [prior()]), null);
});

test('source file outranks cycle id when both are present and disagree', () => {
  // Same cycle id but a re-uploaded "(1)" file: the file names the cycle.
  assert.equal(
    sameDispatchCycle(
      { cycle_source_file: 'simple-biz_daily_report_2026-08-23_to_2026-08-29.csv', cycle_id: CYCLE },
      { cycleSourceFile: FILE, cycleId: CYCLE },
    ),
    false,
  );
});

test('cycle id is the fallback when the body names no source file', () => {
  assert.ok(findDuplicatePaid(input({ cycleSourceFile: null }), [prior({ cycle_source_file: null })]));
  assert.equal(
    findDuplicatePaid(input({ cycleSourceFile: null }), [prior({ cycle_source_file: null, cycle_id: 'other' })]),
    null,
  );
});

test('a body with neither source file nor cycle id cannot be checked and is not blocked', () => {
  assert.equal(duplicateGuardApplies(input({ cycleSourceFile: null, cycleId: null })), false);
  assert.equal(findDuplicatePaid(input({ cycleSourceFile: '  ', cycleId: undefined }), [prior()]), null);
});

test('409 message names the first payer, time and txn id', () => {
  const msg = alreadyPaidMessage(prior());
  assert.match(msg, /graceh@simple\.biz/);
  assert.match(msg, /2026-09-03 15:55 UTC/);
  assert.match(msg, /txn 2349842097/);
  assert.match(msg, /No second payment was logged/);
  // Kolan/HiGlobe rows have a blank txn — no dangling "(txn )".
  assert.doesNotMatch(alreadyPaidMessage(prior({ transaction_id: '' })), /txn/);
});
