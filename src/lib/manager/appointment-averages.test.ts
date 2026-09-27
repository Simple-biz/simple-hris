import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDaysWorked,
  computeLeaderboard,
  daysWorkedInRow,
  weeklyHubstaffWeek,
  WEEKS_PER_MONTH,
  type DaysWorkedRow,
} from './appointment-averages';
import type { ApptRosterMember, AppointmentWeek } from './appointment-rankings';

/* Fixtures shaped from production, measured read-only 2026-09-26: Hubstaff rows are
 * one per person per weekly file, keyed on the WORK email, with Sunday–Saturday
 * duration strings ("7:21:14"); applied rows are keyed personal-email-first. */

describe('weeklyHubstaffWeek — a WEEKLY file, by its parsed range', () => {
  it('accepts 7- and 8-day files, including drifted names', () => {
    assert.equal(weeklyHubstaffWeek('simple-biz_daily_report_2026-09-13_to_2026-09-19.csv'), '2026-09-13');
    assert.equal(weeklyHubstaffWeek('simple-biz_daily_report_2026-08-30_to_2026-09-05 4.csv'), '2026-08-30');
    assert.equal(weeklyHubstaffWeek('simple-biz_daily_report_2026-04-19_to_2026-04-25 .csv'), '2026-04-19');
    assert.equal(weeklyHubstaffWeek('simple-biz_daily_report_2026-05-10_to_2026-05-17.csv'), '2026-05-10');
  });

  it('a Monday-anchored backfill lands on its Sunday week', () => {
    assert.equal(weeklyHubstaffWeek('backfill-may10_2026-05-04_to_2026-05-10.csv'), '2026-05-03');
  });

  it('refuses the 27-day time-activity report and undatable names', () => {
    assert.equal(weeklyHubstaffWeek('time-activity-report_2026-04-05_to_2026-05-02.csv'), null);
    assert.equal(weeklyHubstaffWeek('hand-named.csv'), null);
    assert.equal(weeklyHubstaffWeek(null), null);
  });
});

describe('days worked', () => {
  it('counts days with any tracked time, never the weekly total column', () => {
    assert.equal(
      daysWorkedInRow({
        'Total worked': '40:01:26',
        sunday: '0:00:00',
        monday: '7:21:14',
        tuesday: '8:29:43',
        wednesday: '0:00:01',
        thursday: '',
        friday: null,
        saturday: '0:00:00',
      }),
      3,
    );
  });

  it('dedupes a week across files and batches by MAX, never a sum, and matches case-insensitively', () => {
    const out = buildDaysWorked(
      [
        {
          sourceFile: 'simple-biz_daily_report_2026-05-03_to_2026-05-09.csv',
          rows: [{ Email: 'Alyson@simple.biz', monday: '8:00:00', tuesday: '8:00:00' }],
        },
        {
          sourceFile: 'backfill-may10_2026-05-04_to_2026-05-10.csv',
          rows: [
            { Email: 'alyson@simple.biz', monday: '8:00:00', tuesday: '8:00:00', wednesday: '1:00:00' },
            { Email: 'someone-else@simple.biz', monday: '8:00:00' },
          ],
        },
        {
          sourceFile: 'time-activity-report_2026-04-05_to_2026-05-02.csv',
          rows: [{ Email: 'alyson@simple.biz', monday: '8:00:00' }],
        },
      ],
      new Set(['alyson@simple.biz']),
    );
    assert.deepEqual(out, [{ email: 'alyson@simple.biz', weekStart: '2026-05-03', days: 3 }]);
  });
});

describe('computeLeaderboard', () => {
  const member = (over: Partial<ApptRosterMember> & { name: string }): ApptRosterMember => ({
    personal_email: null,
    work_email: null,
    alternate_work_email: null,
    alternate_work_email_2: null,
    start_date: null,
    ...over,
  });
  const ann = member({ name: 'Ann', personal_email: 'ann@gmail.com', work_email: 'ann@simple.biz', start_date: '1/15/25' });
  const bea = member({ name: 'Bea', personal_email: 'bea@gmail.com', work_email: 'bea@simple.biz' });
  const cy = member({ name: 'Cy', personal_email: 'cy@gmail.com', work_email: 'cy@simple.biz' });

  const week = (
    periodStart: string,
    badge: AppointmentWeek['badge'],
    rows: [string, number][],
  ): AppointmentWeek => ({
    periodStart,
    periodEnd: '',
    badge,
    rows: rows.map(([email, appointments]) => ({ email, appointments })),
  });
  const d = (email: string, weekStart: string, days: number): DaysWorkedRow => ({ email, weekStart, days });

  const weeks = [
    week('2026-09-20', 'draft', [['ann@gmail.com', 0], ['bea@gmail.com', 0]]),
    week('2026-09-13', 'finalized', [['ann@gmail.com', 10], ['bea@gmail.com', 6], ['cy@gmail.com', 9]]),
    week('2026-09-06', 'with_accounting', [['ann@gmail.com', 4], ['bea@gmail.com', 6]]),
    week('2026-08-30', 'finalized', [['ann@gmail.com', 1], ['bea@gmail.com', 3], ['left@gmail.com', 7]]),
  ];
  const days = [
    d('ann@simple.biz', '2026-09-13', 5),
    d('ann@simple.biz', '2026-09-06', 4),
    d('ann@simple.biz', '2026-08-30', 5),
    d('bea@simple.biz', '2026-09-13', 5),
    d('bea@simple.biz', '2026-09-06', 2),
    d('cy@simple.biz', '2026-09-13', 5),
  ];
  const run = (basis: 'daily' | 'weekly' | 'monthly', window: 'last4w' | 'last3m' | 'all' = 'all') =>
    computeLeaderboard({ weeks, days, members: [ann, bea, cy], basis, window, todayIso: '2026-09-26' });

  it('averages only counted weeks, and names the draft it left out (Kane, Q5)', () => {
    const lb = run('weekly');
    assert.deepEqual(lb.windowWeeks.map((w) => w.periodStart), ['2026-09-13', '2026-09-06', '2026-08-30']);
    assert.deepEqual(lb.leftOut.map((w) => w.periodStart), ['2026-09-20']);
  });

  it('weekly = total ÷ weeks scored; monthly = weekly × 52/12 (Kane, Q6)', () => {
    const lb = run('weekly');
    const bea_ = lb.rows.find((r) => r.name === 'Bea')!;
    assert.equal(bea_.totalAppointments, 15);
    assert.equal(bea_.weeksScored, 3);
    assert.equal(bea_.avgWeekly, 5);
    assert.equal(bea_.avgMonthly, 5 * WEEKS_PER_MONTH);
  });

  it('daily = appointments ÷ Hubstaff days worked, found through the work email', () => {
    const lb = run('daily');
    const annRow = lb.rows.find((r) => r.name === 'Ann')!;
    assert.equal(annRow.daysWorked, 14);
    assert.equal(annRow.avgDaily, 15 / 14);
  });

  it('a week with appointments but no Hubstaff days is left out of DAILY only, never ÷ 0', () => {
    const lb = run('daily');
    const beaRow = lb.rows.find((r) => r.name === 'Bea')!;
    assert.equal(beaRow.weeksWithoutDays, 1, '08-30 has appointments and no Hubstaff row');
    assert.equal(beaRow.avgDaily, 12 / 7, '09-13 (6/5) + 09-06 (6/2) only');
    assert.equal(beaRow.avgWeekly, 5, 'the weekly figure still counts all three weeks');
  });

  it('ranks on the chosen basis; a single scored week is not enough history (Kane, Q4)', () => {
    const daily = run('daily');
    assert.deepEqual(daily.rows.map((r) => [r.position, r.name]), [[1, 'Bea'], [2, 'Ann']]);
    const weekly = run('weekly');
    assert.deepEqual(weekly.rows.map((r) => [r.position, r.name]), [[1, 'Ann'], [1, 'Bea']]);
    assert.deepEqual(
      weekly.notRanked.map((r) => [r.name, r.reason, r.weeksScored]),
      [['Cy', 'history', 1]],
    );
  });

  it('ties share a position on the SHOWN precision, then order by total', () => {
    const weekly = run('weekly');
    assert.equal(weekly.rows[0]!.avgWeekly, 5);
    assert.equal(weekly.rows[1]!.avgWeekly, 5);
    assert.equal(weekly.rows[1]!.position, 1);
  });

  it('the window takes the newest N COUNTED weeks, skipping the draft', () => {
    const lb = run('weekly', 'last4w');
    assert.equal(lb.windowWeeks.length, 3, 'only three counted weeks exist');
    const two = computeLeaderboard({
      weeks: weeks.slice(0, 3),
      days,
      members: [ann, bea, cy],
      basis: 'weekly',
      window: 'last4w',
      todayIso: '2026-09-26',
    });
    assert.deepEqual(two.windowWeeks.map((w) => w.periodStart), ['2026-09-13', '2026-09-06']);
  });

  it('a scored email nobody on the roster carries is counted, never ranked', () => {
    assert.equal(run('weekly').notOnRoster, 1);
  });

  it('a failed days read leaves daily empty, never guessed', () => {
    const lb = computeLeaderboard({
      weeks,
      days: null,
      members: [ann, bea, cy],
      basis: 'daily',
      window: 'all',
      todayIso: '2026-09-26',
    });
    assert.equal(lb.rows.length, 0);
    assert.deepEqual(lb.notRanked.map((r) => [r.name, r.reason]).sort(), [
      ['Ann', 'no_days'],
      ['Bea', 'no_days'],
      ['Cy', 'history'],
    ]);
  });

  it('carries tenure from the roster (current stint)', () => {
    assert.equal(run('weekly').rows.find((r) => r.name === 'Ann')!.tenure, '1y 8m');
  });
});
