/**
 * Accounting → Issues: time-adjustment rows.
 *
 * Pins the rules the Issues table needs and that used to live only in the Payroll
 * Wizard panel's JSX (untestable there). Failure direction first: each test names
 * the wrong behaviour it refuses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  ALL_TIME_ADJUSTMENT_STATUSES,
  approvedHoursFromInputs,
  canApproveTimeAdjustment,
  fmtTimeAdjustmentHours,
  timeAdjustmentHoursPrefill,
  timeAdjustmentIsDeletable,
  timeAdjustmentIssueCounts,
  timeAdjustmentIssuesUrl,
  timeAdjustmentRequestedLabel,
  timeAdjustmentSearchBlob,
  timeAdjustmentStatusesForFilter,
  timeAdjustmentTrail,
  TIME_ADJUSTMENT_STATUS_BADGE,
} from './issues-time-adjustments';
import type { TimeAdjustmentRow, TimeAdjustmentStatus } from '@/lib/supabase/time-adjustments';

const base: TimeAdjustmentRow = {
  id: 'ca7bb9a1-0000-0000-0000-000000000000',
  work_email: 'carla@simple.biz',
  adjust_date: '2026-09-10',
  reason: 'forgot_tracker',
  explanation: 'I accidentally paused my hubstaff for 5min',
  requested_hours: 0.08333333333333333,
  requested_segments: [{ time_in: '17:10', time_out: '17:15' }],
  image_paths: ['carla_simple_biz/x/0-1.png'],
  status: 'manager_approved',
  approved_hours: null,
  decided_by: null,
  decided_at: null,
  decision_note: null,
  manager_decided_by: 'carla@simple.biz',
  manager_decided_at: '2026-09-10T20:56:10.000Z',
  manager_decision_note: null,
  manager_decision: 'approved',
  second_approver_email: 'claire@simple.biz',
  second_approver_assigned_by: 'carla@simple.biz',
  second_approver_assigned_at: '2026-09-10T20:55:00.000Z',
  second_decision: 'approved',
  second_decided_by: 'claire@simple.biz',
  second_decided_at: '2026-09-10T20:56:40.000Z',
  second_decision_note: null,
  period_label: '2026-09',
  created_at: '2026-09-10T21:18:05.000Z',
  created_by: null,
  updated_at: '2026-09-10T21:18:05.000Z',
};

const withStatus = (status: TimeAdjustmentStatus): TimeAdjustmentRow => ({ ...base, status });

// ─── Filter → statuses ───────────────────────────────────────────────────────

test('Pending asks ONLY for rows Accounting can act on — never the upstream ones', () => {
  assert.deepEqual(timeAdjustmentStatusesForFilter('pending'), ['manager_approved']);
});

test('Denied folds in stage-1 declines — a manager_denied row is a terminal no', () => {
  assert.deepEqual(timeAdjustmentStatusesForFilter('denied').sort(), ['denied', 'manager_denied']);
});

test('All asks for every status, so a live upstream request is never invisible', () => {
  assert.deepEqual(timeAdjustmentStatusesForFilter('all'), [...ALL_TIME_ADJUSTMENT_STATUSES]);
  assert.equal(ALL_TIME_ADJUSTMENT_STATUSES.length, 6);
});

test('the list URL repeats ?status= per value and caps at 500 like the disputes fetch', () => {
  const url = timeAdjustmentIssuesUrl('denied');
  assert.ok(url.startsWith('/api/time-adjustments?'));
  assert.ok(url.includes('status=denied'));
  assert.ok(url.includes('status=manager_denied'));
  assert.ok(url.includes('limit=500'));
});

// ─── KPI counts ──────────────────────────────────────────────────────────────

test('Pending counts manager_approved ONLY — a row still owed a signature is not Accounting work', () => {
  const rows = [
    withStatus('pending'),
    withStatus('awaiting_second_approval'),
    withStatus('manager_approved'),
    withStatus('manager_approved'),
  ];
  assert.equal(timeAdjustmentIssueCounts(rows).pending, 2);
});

test('Total counts every row, upstream included — the table shows them, so the card owns them', () => {
  const rows = [withStatus('pending'), withStatus('approved'), withStatus('manager_denied')];
  const c = timeAdjustmentIssueCounts(rows);
  assert.equal(c.total, 3);
  assert.equal(c.approved, 1);
  assert.equal(c.denied, 1);
});

test('an empty dataset is all zeros, not NaN', () => {
  assert.deepEqual(timeAdjustmentIssueCounts([]), { total: 0, pending: 0, approved: 0, denied: 0 });
});

// ─── Badges ──────────────────────────────────────────────────────────────────

test('every status has badge copy, and manager_approved reads as Accounting\'s turn', () => {
  for (const s of ALL_TIME_ADJUSTMENT_STATUSES) {
    assert.ok(TIME_ADJUSTMENT_STATUS_BADGE[s].label.length > 0, `missing label for ${s}`);
    assert.ok(TIME_ADJUSTMENT_STATUS_BADGE[s].className.length > 0, `missing class for ${s}`);
  }
  assert.equal(TIME_ADJUSTMENT_STATUS_BADGE.manager_approved.label, 'Awaiting accounting');
});

// ─── Hours formatting ────────────────────────────────────────────────────────

test('zero approved hours prints "0h", never "—" — a zero-out is a decision, not an absence', () => {
  assert.equal(fmtTimeAdjustmentHours(0), '0h');
});

test('null and negative hours print nothing', () => {
  assert.equal(fmtTimeAdjustmentHours(null), null);
  assert.equal(fmtTimeAdjustmentHours(-1), null);
  assert.equal(fmtTimeAdjustmentHours(Number.NaN), null);
});

test('hours round to whole minutes for display: 0.0833h is "5m", 8.5h is "8h 30m"', () => {
  assert.equal(fmtTimeAdjustmentHours(0.08333333333333333), '5m');
  assert.equal(fmtTimeAdjustmentHours(8.5), '8h 30m');
  assert.equal(fmtTimeAdjustmentHours(8), '8h');
});

test('a segment row is labelled as MISSED time with its ranges, not as a day total', () => {
  const label = timeAdjustmentRequestedLabel(base);
  assert.ok(label && label.startsWith('+5m missing · '), label ?? '(null)');
});

test('a legacy row with no segments is labelled as a requested day total', () => {
  assert.equal(
    timeAdjustmentRequestedLabel({ requested_hours: 8, requested_segments: [] }),
    'requested 8h',
  );
});

// ─── Prefill rule ────────────────────────────────────────────────────────────

test('a SEGMENT row is never prefilled from requested_hours — that is the missed time, not the day total', () => {
  assert.deepEqual(timeAdjustmentHoursPrefill(base), { hours: '', minutes: '' });
});

test('a legacy row prefills its claimed day total, split into hours and minutes', () => {
  assert.deepEqual(
    timeAdjustmentHoursPrefill({ requested_hours: 7.5, requested_segments: [] }),
    { hours: '7', minutes: '30' },
  );
});

// ─── Inputs → approved_hours ─────────────────────────────────────────────────

test('two blank inputs are NO value, not zero — Approve must stay disabled', () => {
  assert.equal(approvedHoursFromInputs('', ''), null);
  assert.equal(approvedHoursFromInputs('  ', ''), null);
});

test('an explicit 0h 0m IS a value — zeroing the day is a decision the server accepts', () => {
  assert.equal(approvedHoursFromInputs('0', '0'), 0);
  assert.equal(approvedHoursFromInputs('0', ''), 0);
});

test('hours and minutes combine into decimal hours', () => {
  assert.equal(approvedHoursFromInputs('8', '30'), 8.5);
  assert.equal(approvedHoursFromInputs('', '45'), 0.75);
});

test('negative, fractional, non-numeric, 60+ minutes, or over 24h are refused as no value', () => {
  assert.equal(approvedHoursFromInputs('-1', '0'), null);
  assert.equal(approvedHoursFromInputs('8', '60'), null);
  assert.equal(approvedHoursFromInputs('8.5', '0'), null);
  assert.equal(approvedHoursFromInputs('eight', ''), null);
  assert.equal(approvedHoursFromInputs('25', '0'), null);
  assert.equal(approvedHoursFromInputs('24', '1'), null);
  assert.equal(approvedHoursFromInputs('24', '0'), 24);
});

// ─── Approve gate ────────────────────────────────────────────────────────────

test('Approve is refused without a day total, even for an authorized user on an actionable row', () => {
  const r = canApproveTimeAdjustment({ row: base, canApprove: true, approvedHours: null });
  assert.equal(r.ok, false);
});

test('Approve is refused on a row still owed a stage-1 signature', () => {
  const r = canApproveTimeAdjustment({ row: withStatus('awaiting_second_approval'), canApprove: true, approvedHours: 8 });
  assert.equal(r.ok, false);
});

test('Approve is refused for a viewer without an acting role', () => {
  const r = canApproveTimeAdjustment({ row: base, canApprove: false, approvedHours: 8 });
  assert.equal(r.ok, false);
});

test('Approve is allowed with all three: role, both signatures, a value (zero included)', () => {
  assert.equal(canApproveTimeAdjustment({ row: base, canApprove: true, approvedHours: 8 }).ok, true);
  assert.equal(canApproveTimeAdjustment({ row: base, canApprove: true, approvedHours: 0 }).ok, true);
});

// ─── Delete rule ─────────────────────────────────────────────────────────────

test('only denied rows are deletable — an approved row moved money and stays', () => {
  assert.equal(timeAdjustmentIsDeletable(withStatus('denied')), true);
  assert.equal(timeAdjustmentIsDeletable(withStatus('manager_denied')), true);
  assert.equal(timeAdjustmentIsDeletable(withStatus('approved')), false);
  assert.equal(timeAdjustmentIsDeletable(withStatus('manager_approved')), false);
  assert.equal(timeAdjustmentIsDeletable(withStatus('pending')), false);
});

// ─── Search ──────────────────────────────────────────────────────────────────

test('search matches the reason LABEL and the phrase "time adjustment", not just the code', () => {
  const blob = timeAdjustmentSearchBlob(base);
  assert.ok(blob.includes('time adjustment'));
  assert.ok(blob.includes('carla@simple.biz'));
  assert.ok(blob.includes('2026-09-10'));
  assert.ok(blob.includes('claire@simple.biz'));
});

// ─── Trail ───────────────────────────────────────────────────────────────────

test('the trail lists filing, naming, both signatures, in time order', () => {
  const trail = timeAdjustmentTrail(base);
  const whats = trail.map((s) => s.what);
  assert.ok(whats[0].includes('named claire@simple.biz'), whats.join(' | '));
  assert.ok(whats[1].includes('approved as manager'));
  assert.ok(whats[2].includes('countersigned'));
  assert.ok(whats[3].includes('submitted'));
});

test('an Accounting approval names the day total it set', () => {
  const trail = timeAdjustmentTrail({
    ...base,
    status: 'approved',
    approved_hours: 8,
    decided_by: 'aliviah@simple.biz',
    decided_at: '2026-09-15T10:00:00.000Z',
  });
  const last = trail[trail.length - 1];
  assert.equal(last.who, 'aliviah@simple.biz');
  assert.equal(last.what, 'approved — day set to 8h');
});

test('an undated step is never dated today — it keeps its slot with when=null', () => {
  const trail = timeAdjustmentTrail({ ...base, manager_decided_at: null });
  const mgr = trail.find((s) => s.what === 'approved as manager');
  assert.ok(mgr);
  assert.equal(mgr.when, null);
});

test('a manager-filed row explains its missing stage-1 steps in the trail', () => {
  const trail = timeAdjustmentTrail({
    ...base,
    manager_decision: null,
    manager_decided_by: null,
    manager_decided_at: null,
    second_approver_email: null,
    second_approver_assigned_by: null,
    second_approver_assigned_at: null,
    second_decision: null,
    second_decided_by: null,
    second_decided_at: null,
    stage1_waived_reason: 'manager_filed',
  });
  assert.equal(trail.length, 2);
  assert.ok(trail[1].what.includes('straight to Accounting'));
});

test('a manager-filed row still counts as Pending for Accounting at manager_approved', () => {
  const waived: TimeAdjustmentRow = { ...base, stage1_waived_reason: 'manager_filed' };
  const c = timeAdjustmentIssueCounts([waived]);
  assert.equal(c.pending, 1);
});

// ─── Source-shape guards: the surfaces actually use these rules ──────────────

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');

test('the Issues queue renders time adjustments as a third IssueRow kind and folds them into the KPIs', () => {
  const src = read('src', 'components', 'payroll', 'PabDisputeQueue.tsx');
  assert.ok(src.includes("kind: 'time_adjustment'"), 'IssueRow has no time_adjustment kind');
  assert.ok(src.includes('timeAdjustmentIssuesUrl('), 'the queue does not fetch time adjustments through the shared URL rule');
  assert.ok(src.includes('timeAdjustmentIssueCounts('), 'the KPI cards do not fold time adjustments in');
  assert.ok(!src.includes('hasFetchedThisSession'), 'a shared approval queue must never use the skip-fetch flag');

  // The row + dialogs live in their own file; the Approve button and the dialog's
  // submit both go through the shared gate, and the value through the shared parser.
  const rows = read('src', 'components', 'payroll', 'TimeAdjustmentIssueRows.tsx');
  assert.ok(rows.includes('canApproveTimeAdjustment('), 'Approve is not gated by the shared rule');
  assert.ok(rows.includes('approvedHoursFromInputs('), 'the day total is not parsed by the shared rule');
  assert.ok(rows.includes('timeAdjustmentHoursPrefill('), 'the prefill rule is not the shared one');
  assert.ok(!rows.includes('hasFetchedThisSession'));
});

test('the Overview "Needs your decision" tile counts time adjustments awaiting Accounting', () => {
  const src = read('src', 'components', 'Overview.tsx');
  assert.ok(
    src.includes('/api/time-adjustments?status=manager_approved'),
    'Overview does not ask for manager_approved time adjustments — the tile would disagree with the Issues page it opens',
  );
});
