import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLeaveIndex,
  classifyZeroHours,
  summarizeZeroHoursGaps,
  zeroHoursDigestLine,
  type ZeroHoursLeave,
} from './zero-hours-gap';

// The live week this rule was measured against: Sun 2026-08-09 → Sat 2026-08-15.
const WEEK = { startISO: '2026-08-09', endISO: '2026-08-15' };
const TODAY = '2026-08-21';
const norm = (e: string) => e.trim().toLowerCase();
const noLeaves = new Map<string, ZeroHoursLeave[]>();

const leave = (over: Partial<ZeroHoursLeave> = {}): ZeroHoursLeave => ({
  email: 'someone@simple.biz',
  start: '2026-08-10',
  end: '2026-08-14',
  type: 'Vacation',
  status: 'approved',
  ...over,
});

const classify = (over: Parameters<typeof classifyZeroHours>[0] extends infer T ? Partial<T> : never) =>
  classifyZeroHours({
    department: 'AI/API Team',
    startDate: '03/09/26',
    emails: ['someone@simple.biz'],
    leavesByEmail: noLeaves,
    period: WEEK,
    todayISO: TODAY,
    ...over,
  });

// ── The case that started this: jvincec@simple.biz ──────────────────────────
// AI/API Team (tracked), started 2026-03-09, no leave on file, zero hours in the
// 2026-08-09 upload. Must read as a GAP — this is the row nobody saw.
test('an established tracked employee with no hours and no leave is a GAP', () => {
  const v = classify({ department: 'AI/API Team', startDate: '03/09/26' });
  assert.equal(v.exception, false);
  assert.match(v.reason, /No hours logged — reason unknown/);
  assert.equal(v.status, undefined);
});

// ── Branch 0: department untracked by nature ────────────────────────────────
test('an exempt department is an expected absence, not a gap', () => {
  for (const d of ['SMM Freelancer', 'Site Building (US - Freelance)', 'USEE', 'Sales']) {
    const v = classify({ department: d });
    assert.equal(v.exception, true, d);
    assert.match(v.reason, /no Hubstaff tracking by nature/);
  }
});

// Kane's Q1 ruling — Lead Gen is tracked, so its no-hours people are gaps.
test('Lead Gen no-hours is a GAP (Kane 2026-08-21)', () => {
  assert.equal(classify({ department: 'Lead Gen' }).exception, false);
});

// ── Branch 1: approved leave (Kane's Q2 — Vacation is legitimate) ───────────
test('approved leave overlapping the week is an exception, tagged On Leave', () => {
  const idx = buildLeaveIndex([leave()], norm);
  const v = classify({ leavesByEmail: idx });
  assert.equal(v.exception, true);
  assert.equal(v.status, 'On Leave');
  assert.match(v.reason, /On approved leave part of the period — Vacation 2026-08-10→2026-08-14/);
});

test('leave spanning the whole week says so', () => {
  const idx = buildLeaveIndex([leave({ start: '2026-08-03', end: '2026-08-20' })], norm);
  assert.match(classify({ leavesByEmail: idx }).reason, /On approved leave the entire period/);
});

test('a leave filed for a LATER week still explains this week', () => {
  const idx = buildLeaveIndex([leave({ start: '2026-08-20', end: '2026-08-25' })], norm);
  const v = classify({ leavesByEmail: idx });
  assert.equal(v.exception, true);
  assert.match(v.reason, /Upcoming approved leave/);
});

test('a leave that ENDED before the week excuses nothing', () => {
  const idx = buildLeaveIndex([leave({ start: '2026-07-01', end: '2026-08-08' })], norm);
  assert.equal(classify({ leavesByEmail: idx }).exception, false);
});

test('a leave that is not APPROVED excuses nothing', () => {
  for (const status of ['pending', 'rejected', 'cancelled']) {
    const idx = buildLeaveIndex([leave({ status })], norm);
    assert.equal(classify({ leavesByEmail: idx }).exception, false, status);
  }
});

test('a leave on the personal-email alias still matches', () => {
  const idx = buildLeaveIndex([leave({ email: 'Personal@Gmail.com' })], norm);
  const v = classify({ emails: ['someone@simple.biz', 'personal@gmail.com'], leavesByEmail: idx });
  assert.equal(v.exception, true);
});

test('an untyped leave prints as "Leave"', () => {
  const idx = buildLeaveIndex([leave({ type: '  ' })], norm);
  assert.match(classify({ leavesByEmail: idx }).reason, / Leave 2026-08-10→/);
});

test('the earliest relevant leave is the one reported', () => {
  const idx = buildLeaveIndex(
    [leave({ start: '2026-08-14', end: '2026-08-15' }), leave({ start: '2026-08-10', end: '2026-08-11' })],
    norm,
  );
  assert.match(classify({ leavesByEmail: idx }).reason, /2026-08-10→2026-08-11/);
});

// ── Priority: the dept exemption outranks a leave ───────────────────────────
test('an exempt dept wins over an approved leave (durable reason first)', () => {
  const idx = buildLeaveIndex([leave()], norm);
  const v = classify({ department: 'SMM Freelancer', leavesByEmail: idx });
  assert.match(v.reason, /no Hubstaff tracking by nature/);
  assert.equal(v.status, undefined);
});

// ── Branch 2: onboarding timing ────────────────────────────────────────────
test('hired after the week ends → not started yet', () => {
  const v = classify({ startDate: '2026-09-01' });
  assert.equal(v.exception, true);
  assert.match(v.reason, /Not started yet — hired 2026-09-01, after this period/);
});

test('hired inside the week → newly onboarded', () => {
  const v = classify({ startDate: '2026-08-12' });
  assert.equal(v.exception, true);
  assert.match(v.reason, /Newly onboarded — started 2026-08-12, mid-period/);
});

// Pins the INHERITED date semantics (ISO period bounds parse as UTC midnight,
// so an ISO start date exactly on the week start is >= pStart and reads as
// mid-period). Ported verbatim from the shipped Overview tile — see the note on
// classifyZeroHours. If this assertion ever needs to change, that is a
// deliberate re-classification, not a refactor.
test('boundary: an ISO start date equal to the week start reads as mid-period', () => {
  assert.match(classify({ startDate: '2026-08-09' }).reason, /mid-period/);
});

test('a start date before the week does not excuse anything', () => {
  assert.equal(classify({ startDate: '2026-01-05' }).exception, false);
});

test('an unparseable or missing start date falls through to the gap', () => {
  for (const s of [null, undefined, '', 'not a date']) {
    assert.equal(classify({ startDate: s }).exception, false, String(s));
  }
});

// ── All-Time scope (period === null) ───────────────────────────────────────
test('All-Time: currently on leave vs upcoming leave', () => {
  const current = buildLeaveIndex([leave({ start: '2026-08-18', end: '2026-08-25' })], norm);
  assert.match(classify({ period: null, leavesByEmail: current }).reason, /Currently on approved leave/);
  const upcoming = buildLeaveIndex([leave({ start: '2026-09-01', end: '2026-09-05' })], norm);
  assert.match(classify({ period: null, leavesByEmail: upcoming }).reason, /Upcoming approved leave/);
});

test('All-Time: a hire inside the last 30 days is recently onboarded', () => {
  assert.match(classify({ period: null, startDate: '2026-08-05' }).reason, /Recently onboarded/);
  assert.equal(classify({ period: null, startDate: '2026-01-05' }).exception, false);
});

test('All-Time: the gap wording drops the upload hint', () => {
  assert.equal(classify({ period: null }).reason, 'No hours on record — reason unknown');
});

// ── The digest the notification carries ───────────────────────────────────
const row = (department: string | null, email = 'x@simple.biz') => ({
  name: 'X',
  email,
  department,
  reason: 'No hours logged — reason unknown (check Hubstaff upload / time off)',
});

test('the digest counts and ranks departments, capped', () => {
  const s = summarizeZeroHoursGaps(
    [
      ...Array.from({ length: 168 }, () => row('Lead Gen')),
      ...Array.from({ length: 13 }, () => row('hsl:intake_specialist')),
      ...Array.from({ length: 2 }, () => row('AI/API Team')),
      row('Edit Team'),
    ],
    3,
  );
  assert.equal(s.total, 184);
  assert.deepEqual(s.byDepartment, [
    { department: 'Lead Gen', count: 168 },
    { department: 'hsl:intake_specialist', count: 13 },
    { department: 'AI/API Team', count: 2 },
  ]);
});

test('a blank department folds into "No department", never disappears', () => {
  const s = summarizeZeroHoursGaps([row(null), row('  '), row('Lead Gen')]);
  assert.equal(s.total, 3);
  assert.deepEqual(s.byDepartment[0], { department: 'No department', count: 2 });
});

test('ties break on department name so the digest is stable', () => {
  const s = summarizeZeroHoursGaps([row('Zeta'), row('Alpha')]);
  assert.deepEqual(
    s.byDepartment.map((d) => d.department),
    ['Alpha', 'Zeta'],
  );
});

test('the digest line reads as prose and handles zero + singular', () => {
  assert.equal(
    zeroHoursDigestLine(summarizeZeroHoursGaps([])),
    'Everyone on the roster logged hours this week.',
  );
  assert.match(zeroHoursDigestLine(summarizeZeroHoursGaps([row('AI/API Team')])), /1 person has no Hubstaff hours/);
  assert.match(
    zeroHoursDigestLine(summarizeZeroHoursGaps([row('Lead Gen'), row('Lead Gen')])),
    /2 people have no Hubstaff hours this week — mostly Lead Gen \(2\)\./,
  );
});
