/**
 * Tests for the Manager → Time adjustments review workspace derivations.
 *
 * The rules whose FAILURE DIRECTION matters are the point of this file:
 *
 *  - hours must round for display and never for math (the old UI printed
 *    `+4.566666666666666h req` on screen — see the handoff's `original-ui.png`);
 *  - a row reaching the viewer only as a named second approver must never land in
 *    the manager's own queue, because that queue renders the manager's controls;
 *  - the default segment must never be one that hides an outstanding countersign
 *    duty, since the tab IS the discovery path for it (no notification exists);
 *  - an undated decision must never be placed in the chronology.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { TimeAdjustmentRow } from '@/lib/supabase/time-adjustments';
import {
  EMPTY_TA_FILTERS,
  bucketOfRequest,
  buildQueueKpis,
  countBuckets,
  decisionTrail,
  defaultBucketFor,
  deriveQueue,
  filterRequests,
  fmtAdjustmentHours,
  hasActiveTaFilter,
  medianDecisionDays,
  periodOf,
  periodOptionsFrom,
  reasonOptionsFrom,
  requestRef,
  roundAdjustmentHours,
  rowStatusChip,
  taNeedsMyManagerDecision,
  taNeedsMySecondDecision,
} from './time-adjustment-queue';

const ME = 'carla@simple.biz';

function row(over: Partial<TimeAdjustmentRow> = {}): TimeAdjustmentRow {
  return {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    work_email: 'mirav@simple.biz',
    adjust_date: '2026-08-31',
    reason: 'forgot_tracker',
    explanation: 'Client call ran long.',
    requested_hours: 1.5,
    requested_segments: [{ time_in: '09:00', time_out: '10:30' }],
    image_paths: [],
    status: 'pending',
    approved_hours: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    manager_decided_by: null,
    manager_decided_at: null,
    manager_decision_note: null,
    manager_decision: null,
    second_approver_email: null,
    second_approver_assigned_by: null,
    second_approver_assigned_at: null,
    second_decision: null,
    second_decided_by: null,
    second_decided_at: null,
    second_decision_note: null,
    period_label: '2026-08',
    created_at: '2026-09-01T00:00:00.000Z',
    created_by: 'mirav@simple.biz',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const managed = (...ids: string[]) => new Set(ids);

// ── Hours: display rounds, math does not ───────────────────────────────────────

test('hours round to 2dp for display — the defect visible in the old UI', () => {
  assert.equal(fmtAdjustmentHours(4.566666666666666), '4.57 h');
  assert.equal(fmtAdjustmentHours(1.7333333333333334), '1.73 h');
  assert.equal(fmtAdjustmentHours(0.38333333333333336), '0.38 h');
  // Trailing zeros are not padded on: 1.5 stays 1.5, 7 stays 7.
  assert.equal(fmtAdjustmentHours(1.5), '1.5 h');
  assert.equal(fmtAdjustmentHours(7), '7 h');
});

test('no hours is an em dash, never 0 h', () => {
  // "0 h" would read as a request for nothing, which is a different claim.
  assert.equal(fmtAdjustmentHours(null), '—');
  assert.equal(fmtAdjustmentHours(undefined), '—');
  assert.equal(fmtAdjustmentHours(Number.NaN), '—');
});

test('rounding is display-only and returns a number for math', () => {
  assert.equal(roundAdjustmentHours(4.566666666666666), 4.57);
  assert.equal(typeof roundAdjustmentHours(1.5), 'number');
});

// ── The two hats ───────────────────────────────────────────────────────────────

test('a row outside managedIds never owes the viewer a MANAGER decision', () => {
  const r = row({ id: 'x' });
  assert.equal(taNeedsMyManagerDecision(r, managed('x')), true);
  // Reached them some other way (named as second approver) — the manager's
  // controls must not render, so it must not land in the manager bucket.
  assert.equal(taNeedsMyManagerDecision(r, managed()), false);
});

test('the second-approver duty keys on the assignment, not the status', () => {
  // Still `pending` because the manager has not acted; the approver may go first.
  const r = row({ second_approver_email: ME, status: 'pending' });
  assert.equal(taNeedsMySecondDecision(r, ME), true);
  assert.equal(bucketOfRequest(r, managed(), ME), 'countersign');

  const awaiting = row({ second_approver_email: ME, status: 'awaiting_second_approval' });
  assert.equal(taNeedsMySecondDecision(awaiting, ME), true);
});

test('second-approver matching is email-normalized', () => {
  const r = row({ second_approver_email: '  CARLA@Simple.BIZ ' });
  assert.equal(taNeedsMySecondDecision(r, ME), true);
  assert.equal(taNeedsMySecondDecision(r, 'someone@simple.biz'), false);
});

test('a blank viewer email never matches an unassigned row', () => {
  // Otherwise every row with a null approver would land in the countersign queue.
  const r = row({ second_approver_email: null });
  assert.equal(taNeedsMySecondDecision(r, ''), false);
  assert.equal(bucketOfRequest(r, managed(), ''), 'in-flight');
});

test('an already-countersigned pending row leaves the countersign queue', () => {
  const r = row({ second_approver_email: ME, second_decision: 'approved', status: 'pending' });
  assert.equal(taNeedsMySecondDecision(r, ME), false);
  // Not decided and not owed by this viewer: it is waiting on the manager.
  assert.equal(bucketOfRequest(r, managed(), ME), 'in-flight');
});

// ── Buckets ────────────────────────────────────────────────────────────────────

test('every status maps to exactly one bucket', () => {
  const cases: Array<[Partial<TimeAdjustmentRow>, string]> = [
    [{ id: 'm', status: 'pending' }, 'needs-you'],
    [{ status: 'awaiting_second_approval' }, 'in-flight'],
    [{ status: 'manager_approved' }, 'in-flight'],
    [{ status: 'approved' }, 'approved'],
    [{ status: 'denied' }, 'declined'],
    [{ status: 'manager_denied' }, 'declined'],
  ];
  for (const [over, expected] of cases) {
    assert.equal(bucketOfRequest(row(over), managed('m'), ME), expected, JSON.stringify(over));
  }
});

test('an owed decision outranks the status bucket', () => {
  // manager_denied is terminal, so even though the viewer is the named approver
  // it must not be presented as still needing their signature.
  const r = row({ status: 'manager_denied', second_approver_email: ME });
  assert.equal(bucketOfRequest(r, managed('m'), ME), 'declined');
});

// ── Row chips: a coarse bucket must never make a row lie ──────────────────────

test('an in-flight row says WHO it is parked on, not just "in review"', () => {
  const chip = (over: Partial<TimeAdjustmentRow>) => rowStatusChip(row(over), managed(), ME).label;
  assert.equal(chip({ status: 'awaiting_second_approval' }), 'Awaiting second approver');
  assert.equal(chip({ status: 'manager_approved' }), 'With Accounting');
  // Pending, already countersigned by this viewer: it is the manager's move.
  assert.equal(
    chip({ status: 'pending', second_approver_email: ME, second_decision: 'approved' }),
    'Awaiting the manager',
  );
});

test('the two terminal declines are distinguishable', () => {
  // "Declined in review" (a reviewer said no) is a different event from
  // "Denied by Accounting" (both signatures in, Accounting still said no).
  assert.equal(rowStatusChip(row({ status: 'manager_denied' }), managed(), ME).label, 'Declined in review');
  assert.equal(rowStatusChip(row({ status: 'denied' }), managed(), ME).label, 'Denied by Accounting');
});

test('only rows needing action carry the accent tone', () => {
  const tone = (over: Partial<TimeAdjustmentRow>, ids = managed()) =>
    rowStatusChip(row(over), ids, ME).tone;
  assert.equal(tone({ id: 'm' }, managed('m')), 'action');
  assert.equal(tone({ second_approver_email: ME }), 'action');
  assert.equal(tone({ status: 'manager_approved' }), 'flight');
  assert.equal(tone({ status: 'approved' }), 'resolved');
  assert.equal(tone({ status: 'denied' }), 'resolved');
  assert.equal(tone({ status: 'manager_denied' }), 'resolved');
});

test('a pending row the viewer does not manage never reads as their review', () => {
  // It reached them as a second approver who has already signed, or via elevated
  // scope. Either way "Needs your review" would be a false to-do.
  const chip = rowStatusChip(row({ status: 'pending' }), managed(), ME);
  assert.equal(chip.label, 'Awaiting the manager');
  assert.equal(chip.tone, 'flight');
});

// ── Default segment: the discovery path ────────────────────────────────────────

test('the default segment never hides an outstanding countersign duty', () => {
  const counts = countBuckets(
    [row({ id: 'a', second_approver_email: ME }), row({ id: 'b', status: 'approved' })],
    managed(),
    ME,
  );
  assert.equal(counts.countersign, 1);
  // There is no "you were named second approver" notification by design, so the
  // tab must open on the queue that carries it.
  assert.equal(defaultBucketFor(counts), 'countersign');
});

test('the manager hat wins the landing segment when both are owed', () => {
  const counts = countBuckets(
    [row({ id: 'm' }), row({ id: 'b', second_approver_email: ME })],
    managed('m'),
    ME,
  );
  assert.equal(defaultBucketFor(counts), 'needs-you');
});

test('with nothing owed the tab opens on everything, not an empty queue', () => {
  const counts = countBuckets([row({ status: 'approved' })], managed(), ME);
  assert.equal(defaultBucketFor(counts), 'all');
});

// ── Filters ────────────────────────────────────────────────────────────────────

test('filters are AND-combined', () => {
  const rows = [
    row({ id: 'a', work_email: 'mirav@simple.biz', reason: 'forgot_tracker', period_label: '2026-08' }),
    row({ id: 'b', work_email: 'kaner@simple.biz', reason: 'worked_offline', period_label: '2026-08' }),
    row({ id: 'c', work_email: 'mirav@simple.biz', reason: 'forgot_tracker', period_label: '2026-07' }),
  ];
  const got = filterRequests(
    rows,
    { ...EMPTY_TA_FILTERS, query: 'mirav', reason: 'forgot_tracker', period: '2026-08' },
    managed(),
    ME,
  );
  assert.deepEqual(got.map((r) => r.id), ['a']);
});

test('search reaches the reason LABEL, not just the stored code', () => {
  // A manager types what they can see on screen.
  const rows = [row({ id: 'a', reason: 'forgot_tracker' })];
  assert.equal(filterRequests(rows, { ...EMPTY_TA_FILTERS, query: 'Hubstaff' }, managed(), ME).length, 1);
  assert.equal(filterRequests(rows, { ...EMPTY_TA_FILTERS, query: 'forgot_tracker' }, managed(), ME).length, 1);
});

test('search reaches the explanation and the decision notes', () => {
  const rows = [
    row({ id: 'a', explanation: 'warehouse audit offsite' }),
    row({ id: 'b', explanation: null, manager_decision_note: 'no proof attached' }),
  ];
  assert.deepEqual(
    filterRequests(rows, { ...EMPTY_TA_FILTERS, query: 'warehouse' }, managed(), ME).map((r) => r.id),
    ['a'],
  );
  assert.deepEqual(
    filterRequests(rows, { ...EMPTY_TA_FILTERS, query: 'no proof' }, managed(), ME).map((r) => r.id),
    ['b'],
  );
});

test('search is case-insensitive and trims', () => {
  const rows = [row({ id: 'a', work_email: 'Mirav@Simple.biz' })];
  assert.equal(filterRequests(rows, { ...EMPTY_TA_FILTERS, query: '  MIRAV  ' }, managed(), ME).length, 1);
});

test('an empty filter set returns everything untouched', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b', status: 'approved' })];
  assert.equal(filterRequests(rows, EMPTY_TA_FILTERS, managed(), ME).length, 2);
  assert.equal(hasActiveTaFilter(EMPTY_TA_FILTERS), false);
  assert.equal(hasActiveTaFilter({ ...EMPTY_TA_FILTERS, bucket: 'approved' }), true);
  assert.equal(hasActiveTaFilter({ ...EMPTY_TA_FILTERS, query: ' ' }), false);
});

// ── Period resolution ──────────────────────────────────────────────────────────

test('a row with no period stamp falls back to its adjusted month', () => {
  // Never "unknown": that would hide a real row from a filter claiming to cover all.
  assert.equal(periodOf(row({ period_label: null, adjust_date: '2026-04-09' })), '2026-04');
  assert.equal(periodOf(row({ period_label: '  ', adjust_date: '2026-04-09' })), '2026-04');
  assert.equal(periodOf(row({ period_label: '2026-08', adjust_date: '2026-04-09' })), '2026-08');
});

test('period options are newest first and de-duplicated', () => {
  const rows = [
    row({ period_label: '2026-07' }),
    row({ period_label: '2026-08' }),
    row({ period_label: '2026-07' }),
    row({ period_label: null, adjust_date: '2026-04-09' }),
  ];
  assert.deepEqual(periodOptionsFrom(rows), ['2026-08', '2026-07', '2026-04']);
});

test('reason options follow the catalog order and keep unknown codes filterable', () => {
  const rows = [
    row({ reason: 'other' }),
    row({ reason: 'forgot_tracker' }),
    row({ reason: 'legacy_code_xyz' }),
  ];
  assert.deepEqual(reasonOptionsFrom(rows), ['forgot_tracker', 'other', 'legacy_code_xyz']);
});

// ── KPIs ───────────────────────────────────────────────────────────────────────

test('the accented number counts BOTH hats and sums their hours', () => {
  const rows = [
    row({ id: 'm1', requested_hours: 1.5 }),
    row({ id: 'm2', requested_hours: 3.25 }),
    row({ id: 's1', second_approver_email: ME, requested_hours: 0.75 }),
    row({ id: 'other', status: 'approved', requested_hours: 99 }),
  ];
  const k = buildQueueKpis(rows, managed('m1', 'm2'), ME);
  assert.equal(k.owedAsManager, 2);
  assert.equal(k.owedAsSecondApprover, 1);
  assert.equal(k.owedByMe, 3);
  assert.equal(k.owedHours, 5.5);
});

test('owed hours survive float noise', () => {
  const rows = [
    row({ id: 'm1', requested_hours: 4.566666666666666 }),
    row({ id: 'm2', requested_hours: 1.7333333333333334 }),
  ];
  assert.equal(buildQueueKpis(rows, managed('m1', 'm2'), ME).owedHours, 6.3);
});

test('"awaiting second approver" excludes the rows waiting on ME', () => {
  const rows = [
    // Parked on somebody else's signature — this is the cell's subject.
    row({ id: 'a', status: 'awaiting_second_approval', second_approver_email: 'other@simple.biz' }),
    // Parked on MY signature — that belongs to the accented to-do cell, not here,
    // or the same request would be counted twice on one strip.
    row({ id: 'b', status: 'awaiting_second_approval', second_approver_email: ME }),
  ];
  const k = buildQueueKpis(rows, managed(), ME);
  assert.equal(k.awaitingSecondApprover, 1);
  assert.equal(k.owedAsSecondApprover, 1);
});

test('the decided window is 30 days and the rate is of the window', () => {
  const now = Date.parse('2026-09-02T00:00:00.000Z');
  const rows = [
    row({ id: 'a', status: 'approved', created_at: '2026-08-30T00:00:00.000Z', decided_at: '2026-08-31T00:00:00.000Z' }),
    row({ id: 'b', status: 'denied', created_at: '2026-08-29T00:00:00.000Z', decided_at: '2026-08-30T00:00:00.000Z' }),
    // 90 days old: outside the window, so it must not move the rate.
    row({ id: 'c', status: 'approved', created_at: '2026-06-01T00:00:00.000Z', decided_at: '2026-06-02T00:00:00.000Z' }),
  ];
  const k = buildQueueKpis(rows, managed(), ME, now);
  assert.equal(k.decidedInWindow, 2);
  assert.equal(k.approvalRate, 50);
});

test('an empty decided window reports null, never 0%', () => {
  // 0% approved and "nothing decided yet" are different facts.
  const k = buildQueueKpis([row({ id: 'm' })], managed('m'), ME);
  assert.equal(k.decidedInWindow, 0);
  assert.equal(k.approvalRate, null);
});

// ── Median decision time ───────────────────────────────────────────────────────

test('median, not mean — one stale request cannot skew the headline', () => {
  const rows = [
    row({ id: 'a', status: 'approved', created_at: '2026-08-01T00:00:00.000Z', decided_at: '2026-08-02T00:00:00.000Z' }),
    row({ id: 'b', status: 'approved', created_at: '2026-08-01T00:00:00.000Z', decided_at: '2026-08-03T00:00:00.000Z' }),
    row({ id: 'c', status: 'approved', created_at: '2026-08-01T00:00:00.000Z', decided_at: '2026-11-01T00:00:00.000Z' }),
  ];
  // Mean would be ~31 days; the median says what a normal request actually takes.
  assert.equal(medianDecisionDays(rows), 2);
});

test('an even sample averages the two middle spans', () => {
  const rows = [
    row({ id: 'a', status: 'approved', created_at: '2026-08-01T00:00:00.000Z', decided_at: '2026-08-02T00:00:00.000Z' }),
    row({ id: 'b', status: 'approved', created_at: '2026-08-01T00:00:00.000Z', decided_at: '2026-08-05T00:00:00.000Z' }),
  ];
  assert.equal(medianDecisionDays(rows), 2.5);
});

test('undecided rows and impossible spans are excluded, not clamped', () => {
  const rows = [
    row({ id: 'm' }),
    // decided BEFORE created: corrupt, and clamping it to 0 would flatter the stat.
    row({ id: 'b', status: 'approved', created_at: '2026-08-10T00:00:00.000Z', decided_at: '2026-08-01T00:00:00.000Z' }),
  ];
  assert.equal(medianDecisionDays(rows), null);
  assert.equal(buildQueueKpis(rows, managed('m'), ME).medianDays, null);
});

// ── Decision trail ─────────────────────────────────────────────────────────────

test('the trail is one chronology across all four events', () => {
  const trail = decisionTrail(
    row({
      status: 'approved',
      created_at: '2026-08-17T00:00:00.000Z',
      created_by: 'earlv@simple.biz',
      second_approver_email: 'aliviah@simple.biz',
      second_approver_assigned_by: ME,
      second_approver_assigned_at: '2026-08-17T05:00:00.000Z',
      manager_decision: 'approved',
      manager_decided_by: ME,
      manager_decided_at: '2026-08-17T05:00:00.000Z',
      second_decision: 'approved',
      second_decided_by: 'aliviah@simple.biz',
      second_decided_at: '2026-08-18T00:00:00.000Z',
      decided_by: 'accounting@simple.biz',
      decided_at: '2026-08-19T00:00:00.000Z',
      approved_hours: 0.38333333333333336,
    }),
  );
  assert.deepEqual(
    trail.map((t) => t.what),
    [
      'submitted the request',
      'named aliviah@simple.biz as second approver',
      'approved as manager',
      'approved as second approver',
      'approved 0.38 h',
    ],
  );
  // Chronological, and the accounting entry rounds its hours like everywhere else.
  assert.ok(trail[0].at < trail[4].at);
});

test('an undated decision is dropped, never dated today', () => {
  // Placing an undated event in a chronology fabricates a fact.
  const trail = decisionTrail(
    row({ manager_decision: 'approved', manager_decided_at: null, manager_decided_by: ME }),
  );
  assert.deepEqual(trail.map((t) => t.what), ['submitted the request']);
});

test('a denial carries its note through to the trail', () => {
  const trail = decisionTrail(
    row({
      status: 'manager_denied',
      manager_decision: 'denied',
      manager_decided_at: '2026-08-27T00:00:00.000Z',
      manager_decided_by: ME,
      manager_decision_note: 'explanation not sufficient',
    }),
  );
  const entry = trail.find((t) => t.what === 'declined as manager');
  assert.equal(entry?.note, 'explanation not sufficient');
});

test('a pending row trail is just the submission', () => {
  assert.deepEqual(decisionTrail(row()).map((t) => t.what), ['submitted the request']);
});

// ── Payload derivation ─────────────────────────────────────────────────────────

test('deriveQueue rebuilds the Set that JSON cannot carry', () => {
  // `JSON.stringify(new Set(['a']))` is `{}`, so the Set is derived, never cached.
  const d = deriveQueue({ rows: [row()], viewerEmail: '  CARLA@simple.biz ', managedIds: ['a'] });
  assert.ok(d.managedIds instanceof Set);
  assert.equal(d.managedIds.has('a'), true);
  assert.equal(d.viewerEmail, ME);
});

test('deriveQueue survives a partial payload', () => {
  const d = deriveQueue({} as never);
  assert.deepEqual(d.rows, []);
  assert.equal(d.managedIds.size, 0);
  assert.equal(d.viewerEmail, '');
});

test('the request ref is the real id, not an invented sequence', () => {
  // The handoff shows "TA-2412"; no such column or numbering exists here.
  assert.equal(requestRef('aaaaaaaa-1111-2222-3333-444444444444'), 'AAAAAAAA');
  assert.equal(requestRef(''), '');
});
