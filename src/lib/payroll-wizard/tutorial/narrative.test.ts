import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProcessingNarrative,
  payrollWeekWindowFor,
  shiftWeekWindow,
  type NarrativeEventInput,
  type TimeFormatter,
} from './narrative';

// [WIZARD-TUTORIAL] Pins the two rules Kane set on 2026-08-17:
//  1. The trail window is the calendar Sun–Sat week — Start/Stop toggles are
//     ledgered against the week itself.
//  2. Stopping processing does NOT stop the trail: events recorded after a
//     lock_released stay in the same week's narrative, in an "off" segment.

const utcFmt: TimeFormatter = (iso) => iso; // deterministic in any TZ

function ev(
  id: string,
  createdAt: string,
  action: string,
  userName = 'Kane R',
  details: Record<string, unknown> | null = null,
): NarrativeEventInput {
  return {
    id,
    created_at: createdAt,
    user_name: userName,
    user_role: 'admin',
    action,
    resource: 'payroll_wizard',
    resource_id: null,
    details,
  };
}

test('payrollWeekWindowFor: Sun–Sat local week, 7 exact days, shift navigates whole weeks', () => {
  // 2026-08-17 is a Monday.
  const w = payrollWeekWindowFor(new Date(2026, 7, 17, 15, 30));
  assert.equal(w.startDateIso, '2026-08-16'); // Sunday
  assert.equal(w.endDateIso, '2026-08-22'); // Saturday
  const span = new Date(w.endIso).getTime() - new Date(w.startIso).getTime();
  assert.equal(span, 7 * 24 * 3600 * 1000);

  const prev = shiftWeekWindow(w, -1);
  assert.equal(prev.startDateIso, '2026-08-09');
  assert.equal(prev.endDateIso, '2026-08-15');
  // A Sunday belongs to the week it starts.
  const sunday = payrollWeekWindowFor(new Date(2026, 7, 16, 0, 0));
  assert.equal(sunday.startDateIso, '2026-08-16');
});

test('sessions split on lock toggles; the toggle ledger records every on/off', () => {
  const events = [
    ev('1', '2026-08-17T01:00:00Z', 'dispatch.lock_acquired', 'Kane R'),
    ev('2', '2026-08-17T01:05:00Z', 'wizard.bonus_edited', 'Kane R', { employee_email: 'a@simple.biz' }),
    ev('3', '2026-08-17T01:10:00Z', 'dispatch.lock_released', 'Kane R'),
    ev('4', '2026-08-18T02:00:00Z', 'dispatch.lock_acquired', 'Carla M'),
    ev('5', '2026-08-18T02:30:00Z', 'payment.dispatched', 'Carla M', { count: 142 }),
  ];
  const w = payrollWeekWindowFor(new Date(2026, 7, 17));
  const n = buildProcessingNarrative(events, w, utcFmt);

  assert.deepEqual(
    n.toggles.map((t) => t.kind),
    ['started', 'stopped', 'started'],
  );
  assert.equal(n.hasOpenSession, true);

  const sessions = n.segments.filter((s) => s.session != null);
  assert.equal(sessions.length, 2);
  assert.match(sessions[0].heading, /Session 1 — Kane started processing/);
  assert.match(sessions[0].heading, /stopped by Kane/);
  assert.match(sessions[1].heading, /Session 2 — Carla started processing/);
  assert.match(sessions[1].heading, /still running/);
  assert.match(sessions[1].lines.join(' '), /dispatched payments — 142 payees/);
});

test('the trail continues after Stop: off-session events land in an "off" segment', () => {
  const events = [
    ev('1', '2026-08-17T01:00:00Z', 'dispatch.lock_acquired'),
    ev('2', '2026-08-17T02:00:00Z', 'dispatch.lock_released'),
    ev('3', '2026-08-19T09:00:00Z', 'wizard.fx_rate_changed', 'Carla M', {
      old_value: '57.1',
      new_value: '57.4',
    }),
  ];
  const w = payrollWeekWindowFor(new Date(2026, 7, 17));
  const n = buildProcessingNarrative(events, w, utcFmt);

  const off = n.segments.find((s) => s.session == null);
  assert.ok(off, 'expected an off-session segment');
  assert.match(off.heading, /processing off/i);
  assert.match(off.lines.join(' '), /changed the FX rate from 57.1 to 57.4/);
  assert.equal(n.hasOpenSession, false);
});

test('events before the first start land in a pre-session segment; edits aggregate', () => {
  const events = [
    ev('1', '2026-08-16T08:00:00Z', 'wizard.edited', 'Kane R', { employee_email: 'a@simple.biz' }),
    ev('2', '2026-08-16T08:01:00Z', 'wizard.edited', 'Kane R', { employee_email: 'b@simple.biz' }),
    ev('3', '2026-08-16T08:02:00Z', 'wizard.addition_edited', 'Carla M', { employee_email: 'b@simple.biz' }),
    ev('4', '2026-08-17T01:00:00Z', 'dispatch.lock_acquired'),
  ];
  const w = payrollWeekWindowFor(new Date(2026, 7, 17));
  const n = buildProcessingNarrative(events, w, utcFmt);

  const pre = n.segments[0];
  assert.equal(pre.session, null);
  assert.match(pre.heading, /Before processing started/);
  assert.match(pre.lines.join(' '), /Kane, Carla made 3 pay edits touching 2 people/);
});

test('empty week narrates cleanly', () => {
  const w = payrollWeekWindowFor(new Date(2026, 7, 17));
  const n = buildProcessingNarrative([], w, utcFmt);
  assert.equal(n.totalEvents, 0);
  assert.equal(n.segments.length, 0);
  assert.equal(n.hasOpenSession, false);
  assert.match(n.weekLabel, /2026-08-16 \(Sun\) – 2026-08-22 \(Sat\)/);
});
