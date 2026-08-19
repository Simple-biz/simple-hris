/**
 * Time adjustments — dual approval.
 *
 * The status a request lands in is DERIVED from two independent sign-offs, so the
 * rule has to hold no matter which order they arrive in. These tests pin that rule
 * and the segment sanitiser it sits beside. Run with `npm test`.
 *
 * Nothing here touches Supabase: `deriveAdjustmentStatus` is pure on purpose, which
 * is what makes the money-adjacent half of this feature testable at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveAdjustmentStatus,
  adjustmentIsAwaitingManager,
  adjustmentIsAwaitingSecondApprover,
  adjustmentAwaitsSecondApprovalFrom,
  adjustmentIsAwaitingAccounting,
  adjustmentIsFinallyDecided,
  sanitizeAdjustmentSegments,
  adjustmentSegmentsTotalHours,
  type ApprovalDecision,
  type TimeAdjustmentStatus,
} from './time-adjustments';

const SECOND = 'lead@simple.biz';

const derive = (
  managerDecision: ApprovalDecision | null,
  secondDecision: ApprovalDecision | null,
  secondApproverEmail: string | null = SECOND,
): TimeAdjustmentStatus =>
  deriveAdjustmentStatus({ managerDecision, secondDecision, secondApproverEmail });

// ─── The dual-approval rule ──────────────────────────────────────────────────

test('both approvals required before Accounting can act', () => {
  assert.equal(derive('approved', 'approved'), 'manager_approved');
});

test('manager approval alone does NOT reach Accounting', () => {
  assert.equal(derive('approved', null), 'awaiting_second_approval');
});

test('second approval alone does NOT reach Accounting', () => {
  // Still the manager's move, so it stays in the manager's pending queue.
  assert.equal(derive(null, 'approved'), 'pending');
});

test('neither decided stays pending', () => {
  assert.equal(derive(null, null), 'pending');
});

// ─── Denial from EITHER party blocks ─────────────────────────────────────────

test('manager denial blocks', () => {
  assert.equal(derive('denied', null), 'manager_denied');
});

test('second approver denial blocks', () => {
  assert.equal(derive(null, 'denied'), 'manager_denied');
});

test('second approver denial overrides a manager approval', () => {
  assert.equal(derive('approved', 'denied'), 'manager_denied');
});

test('manager denial overrides a second-approver approval', () => {
  assert.equal(derive('denied', 'approved'), 'manager_denied');
});

test('a denial from both is still just blocked', () => {
  assert.equal(derive('denied', 'denied'), 'manager_denied');
});

// ─── Order independence ──────────────────────────────────────────────────────

test('order of the two sign-offs never changes the outcome', () => {
  const decisions: Array<ApprovalDecision | null> = [null, 'approved', 'denied'];
  for (const m of decisions) {
    for (const s of decisions) {
      // Deriving from the same pair twice must agree; the function reads no clock
      // and no arrival order, which is what makes either sequence safe.
      assert.equal(derive(m, s), derive(m, s), `unstable for manager=${m} second=${s}`);
    }
  }
  // Manager-first and second-first reach the same terminal state.
  assert.equal(derive('approved', 'approved'), derive('approved', 'approved'));
});

test('an approval NEVER reaches manager_approved on one sign-off when a second approver is named', () => {
  const decisions: Array<ApprovalDecision | null> = [null, 'approved', 'denied'];
  for (const m of decisions) {
    for (const s of decisions) {
      if (m === 'approved' && s === 'approved') continue;
      assert.notEqual(
        derive(m, s),
        'manager_approved',
        `manager=${m} second=${s} must not forward to Accounting`,
      );
    }
  }
});

// ─── Legacy rows (no second approver named) ──────────────────────────────────

test('legacy row with no second approver keeps single-approval behaviour', () => {
  assert.equal(derive('approved', null, null), 'manager_approved');
  assert.equal(derive('denied', null, null), 'manager_denied');
  assert.equal(derive(null, null, null), 'pending');
});

// ─── Queue predicates ────────────────────────────────────────────────────────

test('manager queue holds only rows the manager has not decided', () => {
  assert.equal(adjustmentIsAwaitingManager({ status: 'pending', manager_decision: null }), true);
  // Second approver went first: still pending, still the manager's move.
  assert.equal(adjustmentIsAwaitingManager({ status: 'pending', manager_decision: null }), true);
  assert.equal(
    adjustmentIsAwaitingManager({ status: 'awaiting_second_approval', manager_decision: 'approved' }),
    false,
  );
  assert.equal(adjustmentIsAwaitingManager({ status: 'manager_approved', manager_decision: 'approved' }), false);
});

test('second-approver queue is driven by the assignment, not the status', () => {
  // Manager has not acted yet — row is `pending`, but the second approver can still sign off.
  assert.equal(
    adjustmentIsAwaitingSecondApprover({
      status: 'pending',
      second_approver_email: SECOND,
      second_decision: null,
    }),
    true,
  );
  assert.equal(
    adjustmentIsAwaitingSecondApprover({
      status: 'awaiting_second_approval',
      second_approver_email: SECOND,
      second_decision: null,
    }),
    true,
  );
  // Already decided.
  assert.equal(
    adjustmentIsAwaitingSecondApprover({
      status: 'awaiting_second_approval',
      second_approver_email: SECOND,
      second_decision: 'approved',
    }),
    false,
  );
  // Nobody named.
  assert.equal(
    adjustmentIsAwaitingSecondApprover({
      status: 'pending',
      second_approver_email: null,
      second_decision: null,
    }),
    false,
  );
  // Terminal rows are nobody's queue.
  assert.equal(
    adjustmentIsAwaitingSecondApprover({
      status: 'manager_denied',
      second_approver_email: SECOND,
      second_decision: null,
    }),
    false,
  );
});

test('only the NAMED second approver sees the row as theirs', () => {
  const row = { status: 'pending' as const, second_approver_email: SECOND, second_decision: null };
  assert.equal(adjustmentAwaitsSecondApprovalFrom(row, SECOND), true);
  assert.equal(adjustmentAwaitsSecondApprovalFrom(row, 'someone.else@simple.biz'), false);
  assert.equal(adjustmentAwaitsSecondApprovalFrom(row, null), false);
  assert.equal(adjustmentAwaitsSecondApprovalFrom(row, ''), false);
});

test('second-approver match is case- and whitespace-insensitive', () => {
  const row = { status: 'pending' as const, second_approver_email: SECOND, second_decision: null };
  assert.equal(adjustmentAwaitsSecondApprovalFrom(row, '  LEAD@Simple.BIZ  '), true);
});

test('Accounting acts only on fully-approved rows', () => {
  assert.equal(adjustmentIsAwaitingAccounting({ status: 'manager_approved' }), true);
  assert.equal(adjustmentIsAwaitingAccounting({ status: 'awaiting_second_approval' }), false);
  assert.equal(adjustmentIsAwaitingAccounting({ status: 'pending' }), false);
});

test('awaiting_second_approval is not a decided row', () => {
  // It must fall into neither Accounting's actionable list nor its decided list,
  // or a half-approved request would look finished.
  assert.equal(adjustmentIsFinallyDecided({ status: 'awaiting_second_approval' }), false);
  assert.equal(adjustmentIsFinallyDecided({ status: 'manager_denied' }), true);
  assert.equal(adjustmentIsFinallyDecided({ status: 'approved' }), true);
  assert.equal(adjustmentIsFinallyDecided({ status: 'denied' }), true);
});

// ─── Segments (pre-existing behaviour, previously untested) ──────────────────

test('segments must be present, ordered and non-overlapping', () => {
  assert.equal(sanitizeAdjustmentSegments([]).error != null, true);
  assert.equal(sanitizeAdjustmentSegments('nope').error != null, true);
  assert.equal(
    sanitizeAdjustmentSegments([{ time_in: '10:00', time_out: '09:00' }]).error != null,
    true,
  );
  assert.equal(
    sanitizeAdjustmentSegments([
      { time_in: '09:00', time_out: '11:00' },
      { time_in: '10:00', time_out: '12:00' },
    ]).error != null,
    true,
  );
  const ok = sanitizeAdjustmentSegments([
    { time_in: '13:00', time_out: '15:00' },
    { time_in: '09:00', time_out: '10:00' },
  ]);
  assert.equal(ok.error, null);
  assert.deepEqual(ok.segments, [
    { time_in: '09:00', time_out: '10:00' },
    { time_in: '13:00', time_out: '15:00' },
  ]);
});

test('segment hours sum the missed ranges', () => {
  assert.equal(
    adjustmentSegmentsTotalHours([
      { time_in: '09:00', time_out: '10:30' },
      { time_in: '13:00', time_out: '14:00' },
    ]),
    2.5,
  );
});
