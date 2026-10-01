import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countNeedAction,
  needActionKey,
  notificationNeedsAction,
  resolveNotificationAction,
  type OffboardOutcome,
} from './notification-actions';
import type { AppView } from '@/lib/rbac/views';

type Row = { id: string; type: string; details: Record<string, unknown> | null; read_at: string | null };

const READ = '2026-10-01T12:00:00Z';

/** What the HR panel computes per card: the resolved action, plus a queue outcome. */
function hrState(outcomes: Record<string, OffboardOutcome> = {}) {
  return (n: Row) => ({
    action: resolveNotificationAction('hr', n.type, n.details),
    offboard: outcomes[n.id] ?? null,
  });
}

// ── Every resolver decides out loud (2026-10-01) ────────────────────────────
// `needsAction` is required on the type; this pins the current answers so a
// flip is a deliberate edit, not drift.
test('which buttons ask for an action', () => {
  const cases: Array<[AppView, string, Record<string, unknown>, boolean]> = [
    ['hr', 'onboarding.submitted', { submission_id: 's1' }, true],
    ['hr', 'offboarding.requested', { request_ids: ['q1'] }, true],
    ['employee', 'ticket.replied', { ticket_id: 't1' }, true],
    ['employee', 'ticket.assigned', { ticket_id: 't1' }, true],
    ['employee', 'ticket.moved', { ticket_id: 't1' }, false],
  ];
  for (const [view, type, details, expected] of cases) {
    const action = resolveNotificationAction(view, type, details);
    assert.ok(action, `${view}/${type} resolves`);
    assert.equal(action.needsAction, expected, `${view}/${type}`);
  }
});

test('no button, no count', () => {
  assert.equal(notificationNeedsAction(null, null, null), false);
  // A type with no resolver on this dashboard renders no button.
  assert.equal(resolveNotificationAction('accounting', 'onboarding.submitted', { submission_id: 's1' }), null);
});

test('unread actionable counts; read does not', () => {
  const action = resolveNotificationAction('hr', 'onboarding.submitted', { submission_id: 's1' });
  assert.equal(notificationNeedsAction(action, null, null), true);
  assert.equal(notificationNeedsAction(action, READ, null), false);
});

// The queue is the one outcome the HRIS can see, so it beats read_at both ways.
test('an offboarding request goes by its queue rows when they are known', () => {
  const action = resolveNotificationAction('hr', 'offboarding.requested', { request_ids: ['q1'] });
  assert.equal(notificationNeedsAction(action, READ, { resolved: false }), true, 'pending, already read');
  assert.equal(notificationNeedsAction(action, null, { resolved: true }), false, 'handled, still unread');
  assert.equal(notificationNeedsAction(action, null, null), true, 'status unknown → read_at');
});

test('a column move never counts, read or not', () => {
  const action = resolveNotificationAction('employee', 'ticket.moved', { ticket_id: 't1' });
  assert.equal(notificationNeedsAction(action, null, null), false);
});

// ── One thing to do counts once ─────────────────────────────────────────────
// Measured 2026-10-01: the onboarding backfill had written up to 49 copies of
// one submission's notification to the same reader.
test('duplicate notifications for one submission count once', () => {
  const rows: Row[] = Array.from({ length: 49 }, (_, i) => ({
    id: `n${i}`,
    type: 'onboarding.submitted',
    details: { submission_id: 's1' },
    read_at: null,
  }));
  rows.push({ id: 'n-other', type: 'onboarding.submitted', details: { submission_id: 's2' }, read_at: null });
  assert.equal(countNeedAction(rows, hrState()), 2);
});

test("a ticket's reply and its assignment are one ticket", () => {
  const rows: Row[] = [
    { id: 'a', type: 'ticket.replied', details: { ticket_id: 't1' }, read_at: null },
    { id: 'b', type: 'ticket.assigned', details: { ticket_id: 't1' }, read_at: null },
    { id: 'c', type: 'ticket.replied', details: { ticket_id: 't2' }, read_at: null },
  ];
  const state = (n: Row) => ({ action: resolveNotificationAction('employee', n.type, n.details), offboard: null });
  assert.equal(countNeedAction(rows, state), 2);
});

test('offboarding requests key on their request ids, order-insensitive', () => {
  const action = resolveNotificationAction('hr', 'offboarding.requested', {})!;
  assert.equal(
    needActionKey({ id: 'x', details: { request_ids: ['b', 'a'] } }, action),
    needActionKey({ id: 'y', details: { request_ids: ['a', 'b'] } }, action),
  );
  // No ids at all → each notification stands alone rather than all collapsing.
  assert.notEqual(
    needActionKey({ id: 'x', details: {} }, action),
    needActionKey({ id: 'y', details: {} }, action),
  );
});

test('the count mixes the rules: handled and read rows drop out', () => {
  const rows: Row[] = [
    { id: 'on-unread', type: 'onboarding.submitted', details: { submission_id: 's1' }, read_at: null },
    { id: 'on-read', type: 'onboarding.submitted', details: { submission_id: 's2' }, read_at: READ },
    { id: 'off-pending', type: 'offboarding.requested', details: { request_ids: ['q1'] }, read_at: READ },
    { id: 'off-done', type: 'offboarding.requested', details: { request_ids: ['q2'] }, read_at: null },
    { id: 'info', type: 'payroll.processing_started', details: null, read_at: null },
  ];
  const state = hrState({ 'off-pending': { resolved: false }, 'off-done': { resolved: true } });
  assert.equal(countNeedAction(rows, state), 2);
});
