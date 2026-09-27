import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appointmentsFromVars,
  buildAppointmentWeeks,
  finalizedWeeks,
  groupMonths,
  rankAppointments,
  tenureLabel,
  weekBadge,
  type AppliedApptRow,
  type ApptRosterMember,
  type AppointmentWeek,
  type LockSettingRow,
} from './appointment-rankings';

/* Fixtures shaped from production, measured read-only 2026-09-26:
 * lead_gen rows carry `{ Appts_Set }` (6,383) or, for the COP bonus, `{ Appts }` (4);
 * lock keys are `payroll.dispatch_lock.<hubstaff file>` with a JSON `{ locked }` value. */

const lock = (file: string, locked: boolean): LockSettingRow => ({
  key: `payroll.dispatch_lock.${file}`,
  value: JSON.stringify({ locked, lockedAt: locked ? '2026-09-22T20:43:23.030Z' : null, lockedBy: null }),
});

const row = (period_start: string, email: string, vars: Record<string, unknown>): AppliedApptRow => ({
  period_start,
  period_end: null,
  employee_email: email,
  vars,
});

describe('appointmentsFromVars — exact variable names only', () => {
  it('reads Appts_Set, then the COP Appts', () => {
    assert.equal(appointmentsFromVars({ Appts_Set: 7 }), 7);
    assert.equal(appointmentsFromVars({ Appts: '3' }), 3);
  });

  it("never reads client_va's Appt_Bonus — it is not a count", () => {
    assert.equal(appointmentsFromVars({ Appt_Bonus: 500 }), null);
    assert.equal(appointmentsFromVars({ SP: 12 }), null);
    assert.equal(appointmentsFromVars(null), null);
  });

  it('a saved zero is zero, and garbage or a negative is zero — never null', () => {
    assert.equal(appointmentsFromVars({ Appts_Set: 0 }), 0);
    assert.equal(appointmentsFromVars({ Appts_Set: 'abc' }), 0);
    assert.equal(appointmentsFromVars({ Appts_Set: -4 }), 0);
  });
});

describe('weekBadge — strongest evidence wins', () => {
  const base = {
    hasRows: true,
    status: null,
    finalized: false,
    beforeLockRecord: false,
    statusReadFailed: false,
    lockReadFailed: false,
  };

  it('no rows is not scored, whatever else is true', () => {
    assert.equal(weekBadge({ ...base, hasRows: false, finalized: true }), 'not_scored');
    assert.equal(weekBadge({ ...base, hasRows: false, lockReadFailed: true }), 'not_scored');
  });

  it('a locked wizard beats a draft status row (06-07 is exactly this)', () => {
    assert.equal(weekBadge({ ...base, status: 'draft', finalized: true }), 'finalized');
  });

  it('ready and locked statuses read as with Accounting', () => {
    assert.equal(weekBadge({ ...base, status: 'ready' }), 'with_accounting');
    assert.equal(weekBadge({ ...base, status: 'locked' }), 'with_accounting');
  });

  it('no status, or draft, is Draft', () => {
    assert.equal(weekBadge(base), 'draft');
    assert.equal(weekBadge({ ...base, status: 'draft' }), 'draft');
  });

  it('a week older than the lock record is no_record, never Draft', () => {
    assert.equal(weekBadge({ ...base, beforeLockRecord: true }), 'no_record');
  });

  it('a failed read is unknown, never a guessed state', () => {
    assert.equal(weekBadge({ ...base, lockReadFailed: true, status: 'ready' }), 'unknown');
    assert.equal(weekBadge({ ...base, statusReadFailed: true }), 'unknown');
  });
});

describe('finalizedWeeks — joined by the parsed date range, never the filename', () => {
  it('a duplicate-download suffix still finalizes its week', () => {
    const { finalized } = finalizedWeeks([lock('simple-biz_daily_report_2026-08-30_to_2026-09-05 4.csv', true)]);
    assert.ok(finalized.has('2026-08-30'));
  });

  it('any locked file for the week finalizes it (07-19 has a second, unlocked api_sync file)', () => {
    const { finalized } = finalizedWeeks([
      lock('simple-biz_api_sync_2026-07-19_to_2026-07-25.csv', false),
      lock('simple-biz_daily_report_2026-07-19_to_2026-07-25.csv', true),
    ]);
    assert.ok(finalized.has('2026-07-19'));
  });

  it('an unlocked key is a record but not finalized (07-05)', () => {
    const { finalized, earliestRecord } = finalizedWeeks([
      lock('simple-biz_daily_report_2026-07-05_to_2026-07-11.csv', false),
      lock('simple-biz_daily_report_2026-06-07_to_2026-06-14.csv', true),
    ]);
    assert.equal(finalized.has('2026-07-05'), false);
    assert.equal(earliestRecord, '2026-06-07');
  });

  it('ignores other settings and undatable names', () => {
    const { finalized, earliestRecord } = finalizedWeeks([
      { key: 'dispatch.cycle_closeout.x_2026-09-13_to_2026-09-19.csv', value: 'true' },
      lock('hand-named.csv', true),
    ]);
    assert.equal(finalized.size, 0);
    assert.equal(earliestRecord, null);
  });
});

describe('buildAppointmentWeeks', () => {
  const locks = [
    lock('simple-biz_daily_report_2026-06-07_to_2026-06-14.csv', true),
    lock('simple-biz_daily_report_2026-09-06_to_2026-09-12.csv', true),
  ];

  it('is unavailable for a department with no appointment variable', () => {
    const out = buildAppointmentWeeks({
      applied: [row('2026-09-06', 'a@simple.biz', { SP: 10 })],
      statuses: [],
      locks,
      currentWeekStart: '2026-09-20',
    });
    assert.deepEqual(out, { available: false, weeks: [] });
  });

  it('sums an email across rows, newest week first, and fills forward to the current week', () => {
    const out = buildAppointmentWeeks({
      applied: [
        row('2026-09-06', 'A@simple.biz', { Appts_Set: 2 }),
        row('2026-09-06', 'a@simple.biz', { Appts: 1 }),
        row('2026-09-06', 'b@simple.biz', { Appts_Set: 5 }),
        row('2026-03-01', 'a@simple.biz', { Appts_Set: 4 }),
      ],
      statuses: [{ period_start: '2026-09-06', status: 'ready' }],
      locks,
      currentWeekStart: '2026-09-20',
    });
    assert.equal(out.available, true);
    assert.deepEqual(
      out.weeks.map((w) => [w.periodStart, w.badge]),
      [
        ['2026-09-20', 'not_scored'],
        ['2026-09-13', 'not_scored'],
        ['2026-09-06', 'finalized'],
        ['2026-03-01', 'no_record'],
      ],
      'recent gaps are shown as not scored; the old March→September gap is not listed',
    );
    const sep6 = out.weeks.find((w) => w.periodStart === '2026-09-06')!;
    assert.deepEqual(sep6.rows, [
      { email: 'b@simple.biz', appointments: 5 },
      { email: 'a@simple.biz', appointments: 3 },
    ]);
    assert.equal(sep6.periodEnd, '2026-09-12');
  });

  it('a draft week the manager is still scoring is visible, badged Draft (Kane, Q3)', () => {
    const out = buildAppointmentWeeks({
      applied: [row('2026-09-13', 'a@simple.biz', { Appts_Set: 1 })],
      statuses: [{ period_start: '2026-09-13', status: 'draft' }],
      locks,
      currentWeekStart: '2026-09-13',
    });
    assert.equal(out.weeks[0]!.badge, 'draft');
  });

  it('a failed status or lock read marks scored weeks unknown', () => {
    const applied = [row('2026-09-13', 'a@simple.biz', { Appts_Set: 1 })];
    for (const input of [
      { statuses: null, locks },
      { statuses: [], locks: null },
    ]) {
      const out = buildAppointmentWeeks({ applied, currentWeekStart: '2026-09-13', ...input });
      assert.equal(out.weeks[0]!.badge, 'unknown');
    }
  });
});

describe('groupMonths — the owning Monday decides the month', () => {
  const week = (periodStart: string, badge: AppointmentWeek['badge']): AppointmentWeek => ({
    periodStart,
    periodEnd: '',
    badge,
    rows: [],
  });

  it('May 31 → Jun 6 is a June week (Monday Jun 1); Aug 30 → Sep 5 stays in August (Monday Aug 31)', () => {
    const months = groupMonths([
      week('2026-08-30', 'finalized'),
      week('2026-05-31', 'no_record'),
      week('2026-05-24', 'no_record'),
    ]);
    assert.deepEqual(
      months.map((m) => [m.key, m.weeks.map((w) => w.periodStart)]),
      [
        ['2026-08', ['2026-08-30']],
        ['2026-06', ['2026-05-31']],
        ['2026-05', ['2026-05-24']],
      ],
    );
  });

  it('counts the weeks that may still change', () => {
    const [sep] = groupMonths([
      week('2026-09-20', 'not_scored'),
      week('2026-09-13', 'with_accounting'),
      week('2026-09-06', 'finalized'),
    ]);
    assert.equal(sep!.notFinal, 2);
  });
});

describe('rankAppointments', () => {
  const member = (over: Partial<ApptRosterMember> & { name: string }): ApptRosterMember => ({
    personal_email: null,
    work_email: null,
    alternate_work_email: null,
    alternate_work_email_2: null,
    start_date: null,
    ...over,
  });
  const wk = (periodStart: string, rows: [string, number][]): AppointmentWeek => ({
    periodStart,
    periodEnd: '',
    badge: 'finalized',
    rows: rows.map(([email, appointments]) => ({ email, appointments })),
  });

  it('ranks the roster by appointments; ties share a position', () => {
    const ann = member({ name: 'Ann', personal_email: 'ann@gmail.com', start_date: '1/15/25' });
    const bea = member({ name: 'Bea', work_email: 'bea@simple.biz', start_date: '2026-09-01' });
    const cy = member({ name: 'Cy', alternate_work_email: 'cy2@simple.biz' });
    const out = rankAppointments(
      [wk('2026-09-06', [['ann@gmail.com', 4], ['bea@simple.biz', 4], ['cy2@simple.biz', 1]])],
      [ann, bea, cy],
      '2026-09-26',
    );
    assert.deepEqual(
      out.rows.map((r) => [r.position, r.name, r.appointments, r.tenure]),
      [
        [1, 'Ann', 4, '1y 8m'],
        [1, 'Bea', 4, '25d'],
        [3, 'Cy', 1, '—'],
      ],
    );
  });

  it('sums a period across weeks and counts weeks scored, a saved 0 included', () => {
    const ann = member({ name: 'Ann', personal_email: 'ann@gmail.com' });
    const out = rankAppointments(
      [wk('2026-09-13', [['ann@gmail.com', 0]]), wk('2026-09-06', [['ann@gmail.com', 3]])],
      [ann],
      '2026-09-26',
    );
    assert.equal(out.rows[0]!.appointments, 3);
    assert.equal(out.rows[0]!.weeksScored, 2);
  });

  it('a scored email nobody on the roster carries is counted, never listed (Kane, Q4)', () => {
    const out = rankAppointments(
      [wk('2026-09-06', [['left@gmail.com', 9], ['gone@gmail.com', 2]])],
      [member({ name: 'Ann', personal_email: 'ann@gmail.com' })],
      '2026-09-26',
    );
    assert.equal(out.rows.length, 0);
    assert.equal(out.notOnRoster, 2);
    assert.equal(out.unscoredOnRoster, 1, 'no entry is not the same as zero');
  });

  it('duplicate roster rows are one person, with the latest start (current stint, Q5)', () => {
    const oldRow = member({ name: 'Ann', personal_email: 'ann@gmail.com', start_date: '3/1/24' });
    const rehire = member({ name: 'Ann R.', personal_email: 'ann@gmail.com', work_email: 'annr@simple.biz', start_date: '6/1/26' });
    const out = rankAppointments(
      [wk('2026-09-06', [['ann@gmail.com', 2], ['annr@simple.biz', 1]])],
      [oldRow, rehire],
      '2026-09-26',
    );
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]!.appointments, 3, 'both of her rows were credited');
    assert.equal(out.rows[0]!.startDate, '2026-06-01');
    assert.equal(out.unscoredOnRoster, 0);
  });

  it("a personal-email claim beats another person's alias for the same address", () => {
    const aliasHolder = member({ name: 'Zed', work_email: 'zed@simple.biz', alternate_work_email: 'x@simple.biz' });
    const owner = member({ name: 'Xan', personal_email: 'x@simple.biz' });
    const out = rankAppointments([wk('2026-09-06', [['x@simple.biz', 5]])], [aliasHolder, owner], '2026-09-26');
    assert.equal(out.rows[0]!.name, 'Xan');
  });
});

describe('tenureLabel', () => {
  it('reads years and months, months, days, New, and a dash', () => {
    assert.equal(tenureLabel('2024-06-26', '2026-09-26'), '2y 3m');
    assert.equal(tenureLabel('2024-09-26', '2026-09-26'), '2y');
    assert.equal(tenureLabel('2026-04-27', '2026-09-26'), '4mo');
    assert.equal(tenureLabel('2026-09-14', '2026-09-26'), '12d');
    assert.equal(tenureLabel('2026-09-26', '2026-09-26'), 'New');
    assert.equal(tenureLabel('2026-10-05', '2026-09-26'), 'New');
    assert.equal(tenureLabel(null, '2026-09-26'), '—');
  });
});
