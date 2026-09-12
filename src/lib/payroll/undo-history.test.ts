import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  actorLabel,
  batchKey,
  classifyUndo,
  describeUndo,
  isMoneyUndo,
  toUndoHistoryEntry,
} from './undo-history';

/**
 * Pins the Undo-history classifier against the payload shapes MEASURED in
 * production on 2026-09-12 (198 `payment.undone` events, 2026-06-08 →
 * 2026-09-11):
 *
 *   109  original_status: 'paid'          → money undone
 *    59  {count, ids} and nothing else    → legacy, unknowable, MUST NOT be hidden
 *    24  problem / threshold / not_paid   → marker clears, excluded per Q3
 *     6  no_rows_deleted: true            → nothing changed
 *    82  actor "kaner@… (dedupe-…)"       → script run, not a button press
 *
 * The failure classes closed here:
 *  1. a marker clear is never counted as money undone (and vice versa);
 *  2. a legacy event is never silently dropped by the money filter;
 *  3. a legacy event never renders as an empty payment row;
 *  4. a script run is never displayed as somebody pressing Undo;
 *  5. a dedupe cleanup never claims its recipient went back to the pending
 *     queue — it carries original_status 'paid' but un-paid nobody;
 *  6. numeric strings from PostgREST never reach the UI as NaN.
 */

const base = {
  id: 'evt-1',
  user_name: 'lenny@simple.biz',
  user_role: 'accounting',
  resource_id: '5313a0c1-6778-41aa-b82b-f2358fa34d60',
  ip_address: null,
  created_at: '2026-09-11T17:44:24.938Z',
};

/** The live shape written by /api/payment-dispatches/undo today. */
const paidDetails = {
  recipient_email: 'someone@simple.biz',
  recipient_name: 'Someone Real',
  processor: 'wise',
  amount_usd: 420.5,
  amount_php: 23_500,
  amount_cop: null,
  transaction_id: 'TXN-9001',
  bank_used: 'Wise',
  sent_date: '2026-09-10',
  original_status: 'paid',
  note: null,
  originally_paid_by: 'carla@simple.biz',
  originally_paid_at: '2026-09-10T04:00:00.000Z',
  batch: { requested: 3, deleted: 3 },
  cycle: {
    cycle_id: 'cyc-1',
    source_file: 'simple-biz_daily_report_2026-09-01_to_2026-09-07.csv',
    period_start: '2026-09-01',
    period_end: '2026-09-07',
    fx_rate: 55.88,
  },
};

// ── 1. Classification ────────────────────────────────────────────────────────

test('a paid row undone is a payment', () => {
  assert.equal(classifyUndo(paidDetails), 'payment');
});

test('every marker status classifies as a clear, not a payment', () => {
  for (const status of ['not_paid', 'threshold', 'problem']) {
    assert.equal(
      classifyUndo({ ...paidDetails, original_status: status }),
      'marker_clear',
      `${status} must not read as money`,
    );
  }
});

test('the legacy {count, ids} shape is unrecorded, never a payment', () => {
  // The exact newest legacy row from production (2026-07-29).
  assert.equal(classifyUndo({ ids: [base.resource_id], count: 1 }), 'unrecorded');
});

test('a no-op attempt is its own kind and outranks the missing status', () => {
  assert.equal(classifyUndo({ count: 0, ids: ['a', 'b'], no_rows_deleted: true }), 'no_op');
});

test('null details do not throw and do not claim a payment', () => {
  assert.equal(classifyUndo(null), 'unrecorded');
});

// ── 2. The money filter (Q3) ─────────────────────────────────────────────────

test('marker clears are the ONLY thing the money filter excludes', () => {
  assert.equal(isMoneyUndo(paidDetails), true);
  assert.equal(isMoneyUndo({ ...paidDetails, original_status: 'problem' }), false);
  assert.equal(isMoneyUndo({ ...paidDetails, original_status: 'threshold' }), false);
  assert.equal(isMoneyUndo({ ...paidDetails, original_status: 'not_paid' }), false);
});

test('legacy events survive the money filter — 59 live rows must not vanish', () => {
  // Regression guard for the tempting `original_status === 'paid'` filter,
  // which would silently hide 30% of the real history.
  assert.equal(isMoneyUndo({ ids: ['x'], count: 1 }), true);
  assert.equal(isMoneyUndo(null), true);
});

test('a no-op attempt survives the filter so a disputed disappearance is visible', () => {
  assert.equal(isMoneyUndo({ count: 0, ids: ['x'], no_rows_deleted: true }), true);
});

// ── 2b. The dedupe cleanup — 82 live events ──────────────────────────────────

/** Exactly what scripts/dedupe-payment-dispatches.mjs writes. */
const dedupeDetails = {
  ...paidDetails,
  reason: 'duplicate_paid_row',
  kept_dispatch_id: 'kept-row-uuid',
  script: 'scripts/dedupe-payment-dispatches.mjs',
  backup: 'references/backups/dupes.json',
};

test('a dedupe cleanup is NOT a payment undone, despite original_status paid', () => {
  // The script deletes a paid ECHO row and the oldest row survives, so nobody
  // went back to the pending queue. Classifying on status alone would claim 82
  // people were un-paid when none were.
  assert.equal(classifyUndo(dedupeDetails), 'duplicate_cleanup');
});

test('the cleanup reason outranks the status but not a no-op', () => {
  assert.equal(classifyUndo({ ...dedupeDetails, no_rows_deleted: true }), 'no_op');
});

test('a cleanup keeps the surviving row id so the payment stays traceable', () => {
  const e = toUndoHistoryEntry({ ...base, details: dedupeDetails });
  assert.equal(e.kind, 'duplicate_cleanup');
  assert.equal(e.reason, 'duplicate_paid_row');
  assert.equal(e.keptDispatchId, 'kept-row-uuid');
  assert.equal(e.recipientName, 'Someone Real', 'a cleanup still names its recipient');
});

test('a cleanup survives the money filter and never says "returned to pending"', () => {
  assert.equal(isMoneyUndo(dedupeDetails), true);
  const text = describeUndo(toUndoHistoryEntry({ ...base, details: dedupeDetails }));
  assert.match(text, /original payment stands/);
  assert.doesNotMatch(text, /pending queue/);
});

test('an ordinary payment undo carries no cleanup reason', () => {
  const e = toUndoHistoryEntry({ ...base, details: paidDetails });
  assert.equal(e.reason, null);
  assert.equal(e.keptDispatchId, null);
  assert.match(describeUndo(e), /pending queue/);
});

// ── 3. Actor integrity ───────────────────────────────────────────────────────

test('a script actor is split from the email it ran as', () => {
  assert.deepEqual(actorLabel('kaner@simple.biz (dedupe-payment-dispatches)'), {
    email: 'kaner@simple.biz',
    script: 'dedupe-payment-dispatches',
  });
});

test('a plain email carries no script tag', () => {
  assert.deepEqual(actorLabel('lenny@simple.biz'), {
    email: 'lenny@simple.biz',
    script: null,
  });
});

test('actor parsing tolerates padding and an empty string', () => {
  assert.deepEqual(actorLabel('  lenny@simple.biz  '), { email: 'lenny@simple.biz', script: null });
  assert.deepEqual(actorLabel(''), { email: '', script: null });
});

// ── 4. Shaping ───────────────────────────────────────────────────────────────

test('a live paid event maps field-for-field, verbatim', () => {
  const e = toUndoHistoryEntry({ ...base, details: paidDetails });
  assert.equal(e.kind, 'payment');
  assert.equal(e.at, '2026-09-11T17:44:24.938Z');
  assert.equal(e.actorEmail, 'lenny@simple.biz');
  assert.equal(e.actorScript, null);
  assert.equal(e.dispatchId, base.resource_id);
  assert.equal(e.recipientName, 'Someone Real');
  assert.equal(e.processor, 'wise');
  assert.equal(e.amountUsd, 420.5);
  assert.equal(e.amountPhp, 23_500);
  assert.equal(e.transactionId, 'TXN-9001');
  assert.equal(e.originalStatus, 'paid');
  assert.equal(e.originallyPaidBy, 'carla@simple.biz');
  assert.equal(e.cyclePeriodStart, '2026-09-01');
  assert.deepEqual(e.batch, { requested: 3, deleted: 3 });
});

test('numeric strings become numbers, and junk becomes null rather than NaN', () => {
  const e = toUndoHistoryEntry({
    ...base,
    details: { ...paidDetails, amount_php: '23500.75', amount_usd: 'not-a-number' },
  });
  assert.equal(e.amountPhp, 23_500.75);
  assert.equal(e.amountUsd, null, 'unparseable money must be null, never NaN');
});

test('a legacy event yields an entry with no invented payment data', () => {
  const e = toUndoHistoryEntry({ ...base, details: { ids: [base.resource_id], count: 1 } });
  assert.equal(e.kind, 'unrecorded');
  assert.equal(e.recipientEmail, null);
  assert.equal(e.amountPhp, null);
  assert.equal(e.processor, null);
  assert.equal(e.dispatchId, base.resource_id, 'the one surviving fact is kept');
});

test('empty strings in the snapshot read as absent, not as a blank name', () => {
  const e = toUndoHistoryEntry({
    ...base,
    details: { ...paidDetails, recipient_name: '   ', transaction_id: '' },
  });
  assert.equal(e.recipientName, null);
  assert.equal(e.transactionId, null);
});

test('an urgent undo carries its source and revived flag', () => {
  const e = toUndoHistoryEntry({
    ...base,
    details: {
      ...paidDetails,
      urgent_undo: { source: 'mesa', revived: true, warning: null },
    },
  });
  assert.deepEqual(e.urgent, { source: 'mesa', revived: true, warning: null });
});

test('a malformed batch block is dropped rather than half-read', () => {
  const e = toUndoHistoryEntry({
    ...base,
    details: { ...paidDetails, batch: { requested: 3 } },
  });
  assert.equal(e.batch, null);
});

// ── 5. Grouping + headline ───────────────────────────────────────────────────

test('single-row undos get no batch key; multi-select rows share one', () => {
  const single = toUndoHistoryEntry({
    ...base,
    details: { ...paidDetails, batch: { requested: 1, deleted: 1 } },
  });
  assert.equal(batchKey(single), null);

  const a = toUndoHistoryEntry({ ...base, id: 'a', details: paidDetails });
  const b = toUndoHistoryEntry({
    ...base,
    id: 'b',
    created_at: '2026-09-11T17:44:24.999Z',
    details: paidDetails,
  });
  assert.equal(batchKey(a), batchKey(b), 'same press, same second → one group');
});

test('a different actor never joins another actor’s batch', () => {
  const a = toUndoHistoryEntry({ ...base, details: paidDetails });
  const b = toUndoHistoryEntry({ ...base, user_name: 'carla@simple.biz', details: paidDetails });
  assert.notEqual(batchKey(a), batchKey(b));
});

test('a legacy entry never describes itself as a payment', () => {
  const e = toUndoHistoryEntry({ ...base, details: { ids: ['x'], count: 1 } });
  const text = describeUndo(e);
  assert.match(text, /only the dispatch id survives/);
  assert.doesNotMatch(text, /unnamed recipient/);
});

test('a no-op says plainly that nothing changed', () => {
  const e = toUndoHistoryEntry({ ...base, details: { count: 0, ids: ['x'], no_rows_deleted: true } });
  assert.match(describeUndo(e), /nothing changed/i);
});

test('a payment headline names the recipient', () => {
  const e = toUndoHistoryEntry({ ...base, details: paidDetails });
  assert.match(describeUndo(e), /Someone Real/);
});
