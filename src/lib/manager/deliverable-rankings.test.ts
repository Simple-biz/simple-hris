import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALL_METRIC,
  applyMoneyOrder,
  kpiItemFromVars,
  projectDeliverableWeeks,
  totalItems,
  type DeliverableWeek,
  type MoneyOrder,
} from './deliverable-rankings';
import { computeLeaderboard, type LeaderboardRow } from './appointment-averages';
import type { ApptRosterMember } from './appointment-rankings';

/* Fixtures shaped from production, measured read-only 2026-09-26: PM Team is scored
 * on one-variable bonuses per person per week (eight of them, 923 rows each), plus
 * one "Scott Cameron" (PM Team - Manager) row a week with 15–17 keys of team totals. */

const member = (name: string, personal: string, work: string | null = null): ApptRosterMember => ({
  name,
  personal_email: personal,
  work_email: work,
  alternate_work_email: null,
  alternate_work_email_2: null,
  start_date: null,
});

describe('kpiItemFromVars — exactly one variable, any name (adaptable)', () => {
  it('reads a one-variable row, keeping half credits', () => {
    assert.deepEqual(kpiItemFromVars({ TrustPilot: 2 }), { kind: 'item', key: 'TrustPilot', count: 2 });
    assert.deepEqual(kpiItemFromVars({ Units: 1.5 }), { kind: 'item', key: 'Units', count: 1.5 });
    assert.deepEqual(kpiItemFromVars({ Site_Star_Ranking: '1' }), { kind: 'item', key: 'Site_Star_Ranking', count: 1 });
  });

  it('a bonus added tomorrow is a KPI with no code change', () => {
    assert.deepEqual(kpiItemFromVars({ GoogleReview: 3 }), { kind: 'item', key: 'GoogleReview', count: 3 });
  });

  it('a saved 0 is a real zero; negative or unreadable counts as 0', () => {
    assert.deepEqual(kpiItemFromVars({ BBB: 0 }), { kind: 'item', key: 'BBB', count: 0 });
    assert.deepEqual(kpiItemFromVars({ BBB: -2 }), { kind: 'item', key: 'BBB', count: 0 });
    assert.deepEqual(kpiItemFromVars({ BBB: 'n/a' }), { kind: 'item', key: 'BBB', count: 0 });
  });

  it("the manager's team-total row, and any row without exactly one variable, is skipped", () => {
    assert.deepEqual(kpiItemFromVars({ FB: 3, SP: 12, BBB: 5, TransUnion: 9, TrustPilot: 7 }), { kind: 'skip' });
    assert.deepEqual(kpiItemFromVars({}), { kind: 'skip' });
    assert.deepEqual(kpiItemFromVars(null), { kind: 'skip' });
  });
});

describe('projectDeliverableWeeks — the SHOWN figures', () => {
  const weeks: DeliverableWeek[] = [
    {
      periodStart: '2026-09-13',
      periodEnd: '2026-09-19',
      badge: 'with_accounting',
      rows: [
        { email: 'ann@gmail.com', counts: { TrustPilot: 1, Units: 2.5 } },
        { email: 'bea@gmail.com', counts: { Site_Star_Ranking: 2 } },
      ],
    },
    {
      periodStart: '2026-09-06',
      periodEnd: '2026-09-12',
      badge: 'finalized',
      rows: [
        { email: 'ann@gmail.com', counts: { TrustPilot: 0, Units: 0 } },
        { email: 'bea@gmail.com', counts: { TrustPilot: 3 } },
      ],
    },
  ];

  it('"all" = the unweighted item sum, with the per-KPI split as parts', () => {
    const all = projectDeliverableWeeks(weeks, ALL_METRIC);
    assert.deepEqual(all[0]!.rows, [
      { email: 'ann@gmail.com', appointments: 3.5, parts: { TrustPilot: 1, Units: 2.5 } },
      { email: 'bea@gmail.com', appointments: 2, parts: { Site_Star_Ranking: 2 } },
    ]);
    assert.equal(totalItems({ TrustPilot: 1, Units: 2.5, BBB: 4 }), 7.5);
  });

  it('one KPI keeps only person-weeks that HAVE that row — no entry is not zero', () => {
    const tp = projectDeliverableWeeks(weeks, 'TrustPilot');
    assert.deepEqual(tp[0]!.rows, [{ email: 'ann@gmail.com', appointments: 1 }]);
    assert.deepEqual(tp[1]!.rows, [
      { email: 'ann@gmail.com', appointments: 0 },
      { email: 'bea@gmail.com', appointments: 3 },
    ]);
    assert.deepEqual(projectDeliverableWeeks(weeks, 'Site_Star_Ranking')[1]!.rows, []);
  });

  it('keeps each week badge, so the leaderboard still averages settled weeks only', () => {
    assert.deepEqual(
      projectDeliverableWeeks(weeks, 'BBB').map((w) => [w.periodStart, w.badge]),
      [
        ['2026-09-13', 'with_accounting'],
        ['2026-09-06', 'finalized'],
      ],
    );
  });
});

describe('applyMoneyOrder — the server decides the order, the counts are what shows', () => {
  const ann = member('Ann', 'ann@gmail.com', 'ann@simple.biz');
  const bea = member('Bea', 'bea@gmail.com', 'bea@simple.biz');
  const cy = member('Cy', 'cy@gmail.com');
  const row = (m: ApptRosterMember, position: number): LeaderboardRow<ApptRosterMember> => ({
    position,
    member: m,
    name: m.name!,
    avgDaily: null,
    avgWeekly: 0,
    avgMonthly: 0,
    totalAppointments: 0,
    daysWorked: 0,
    weeksScored: 2,
    weeksWithoutDays: 0,
    startDate: null,
    tenureMonths: null,
    tenure: '—',
  });
  const byCounts = [row(ann, 1), row(bea, 2), row(cy, 3)];
  const order: MoneyOrder = {
    people: [['bea@gmail.com', 'bea@simple.biz'], ['ann@simple.biz'], ['cy@gmail.com']],
    positions: {
      last4w: { all: [1, 2, 2], TrustPilot: [null, 1, null] },
      last3m: { all: [1, 2, 3] },
      all: { all: [1, 2, 3] },
    },
  };

  it('reorders by the server positions and takes them as the positions shown, ties shared', () => {
    const out = applyMoneyOrder(byCounts, order, 'last4w', ALL_METRIC);
    assert.deepEqual(out.rows.map((r) => [r.position, r.name]), [[1, 'Bea'], [2, 'Ann'], [2, 'Cy']]);
    assert.equal(out.unplaced, 0);
  });

  it('matches a person through ANY email on their roster row (Ann is keyed by work email)', () => {
    const out = applyMoneyOrder([row(ann, 1)], order, 'last3m', ALL_METRIC);
    assert.equal(out.rows[0]!.position, 2);
  });

  it('a row the server did not place goes LAST and is counted, never silently ranked', () => {
    const out = applyMoneyOrder(byCounts, order, 'last4w', 'TrustPilot');
    assert.deepEqual(out.rows.map((r) => [r.position, r.name]), [[1, 'Ann'], [2, 'Bea'], [3, 'Cy']]);
    assert.equal(out.unplaced, 2);
  });

  it('no order at all → every row unplaced, in count order', () => {
    const out = applyMoneyOrder(byCounts, null, 'all', ALL_METRIC);
    assert.equal(out.unplaced, 3);
    assert.deepEqual(out.rows.map((r) => r.name), ['Ann', 'Bea', 'Cy']);
  });

  it('end to end with the shared leaderboard: counts shown, parts carried', () => {
    const weeks: DeliverableWeek[] = [
      { periodStart: '2026-09-13', periodEnd: '', badge: 'finalized', rows: [{ email: 'ann@gmail.com', counts: { BBB: 2 } }] },
      { periodStart: '2026-09-06', periodEnd: '', badge: 'finalized', rows: [{ email: 'ann@gmail.com', counts: { BBB: 1, Units: 1 } }] },
    ];
    const lb = computeLeaderboard({
      weeks: projectDeliverableWeeks(weeks, ALL_METRIC),
      days: [],
      members: [ann],
      basis: 'weekly',
      window: 'all',
      todayIso: '2026-09-26',
    });
    assert.deepEqual(lb.rows[0]!.parts, { BBB: 3, Units: 1 });
    assert.equal(lb.rows[0]!.avgWeekly, 2);
  });
});
