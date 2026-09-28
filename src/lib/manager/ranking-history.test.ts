import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeLeaderboard } from './appointment-averages';
import { indexRosterPeople, type AppointmentWeek, type AppointmentWeekBadge, type ApptRosterMember } from './appointment-rankings';
import {
  buildPersonHistory,
  competitionPositions,
  personForMember,
  rankWeek,
  type WeekRank,
} from './ranking-history';

/* Kane, 2026-09-28: *"an action button after tenure labeled "View" where we can see a
 * histogram via line graph on KPI Performance and Ranking Performance"*. The modal's
 * weeks, people and "no entry ≠ 0" rule are the leaderboard's; these tests pin that
 * the two cannot drift, and that a server-ranked board is never re-ranked here. */

const member = (name: string, personal: string, work: string | null = null): ApptRosterMember => ({
  name,
  personal_email: personal,
  work_email: work,
  alternate_work_email: null,
  alternate_work_email_2: null,
  start_date: null,
});
const ann = member('Ann', 'ann@gmail.com', 'ann@simple.biz');
const bea = member('Bea', 'bea@gmail.com', 'bea@simple.biz');
const cal = member('Cal', 'cal@gmail.com', 'cal@simple.biz');
const ROSTER = [ann, bea, cal];

const week = (
  periodStart: string,
  rows: [string, number][],
  badge: AppointmentWeekBadge = 'finalized',
): AppointmentWeek => ({
  periodStart,
  periodEnd: '',
  badge,
  rows: rows.map(([email, appointments]) => ({ email, appointments })),
});

// Newest first, as the payloads carry them. 09-20 is a draft; Cal has no entry on 09-06.
const WEEKS: AppointmentWeek[] = [
  week('2026-09-20', [['ann@gmail.com', 1], ['bea@gmail.com', 9]], 'draft'),
  week('2026-09-13', [['ann@gmail.com', 6], ['bea@gmail.com', 6], ['cal@gmail.com', 2]], 'with_accounting'),
  week('2026-09-06', [['ann@gmail.com', 4], ['bea@gmail.com', 7]]),
  week('2026-08-30', [['ann@gmail.com', 8], ['bea@gmail.com', 3], ['cal@gmail.com', 0]]),
  week('2026-08-23', [['ann@gmail.com', 5], ['gone@gmail.com', 11]]),
];

describe('competitionPositions — ties share, and the next place skips', () => {
  it('1, 2, 2, 4', () => {
    const p = competitionPositions(new Map([['a', 9], ['b', 5], ['c', 5], ['d', 1]]));
    assert.deepEqual([...p.entries()], [['a', 1], ['b', 2], ['c', 2], ['d', 4]]);
  });

  it('compares at cents, so a float sum of pesos never splits a real tie', () => {
    const p = competitionPositions(new Map([['a', 0.1 + 0.2], ['b', 0.3]]));
    assert.equal(p.get('a'), p.get('b'));
  });
});

describe('rankWeek — the roster decides who is ranked', () => {
  const { personByEmail } = indexRosterPeople(ROSTER);

  it('sums a person scored under two emails in one week', () => {
    const w = week('2026-09-13', [['ann@gmail.com', 2], ['ann@simple.biz', 5], ['bea@gmail.com', 6]]);
    const r = rankWeek(w, personByEmail);
    assert.equal(r.ranked, 2);
    assert.equal(r.positions.get(personForMember(ann, personByEmail)!), 1, 'Ann 2 + 5 = 7 beats Bea 6');
  });

  it('never ranks a leaver, and a saved 0 is an entry (ranked last)', () => {
    const r = rankWeek(WEEKS[3]!, personByEmail);
    assert.equal(r.ranked, 3);
    assert.equal(r.positions.get(personForMember(cal, personByEmail)!), 3);
    const leavers = rankWeek(WEEKS[4]!, personByEmail);
    assert.equal(leavers.ranked, 1, 'gone@ scored 11 and matches nobody on the roster');
    assert.equal(leavers.positions.get(personForMember(ann, personByEmail)!), 1);
  });
});

describe('buildPersonHistory — ranked on the values (Lead Gen: the appointments ARE the order)', () => {
  const values = { kind: 'values' } as const;
  const all = buildPersonHistory({ weeks: WEEKS, members: ROSTER, member: cal, window: 'all', rankBy: values });

  it('plots settled weeks only, oldest first; the draft is named, not plotted', () => {
    assert.deepEqual(all.points.map((p) => p.periodStart), ['2026-08-23', '2026-08-30', '2026-09-06', '2026-09-13']);
    assert.deepEqual(all.leftOut.map((w) => w.periodStart), ['2026-09-20']);
  });

  it('a week with no entry is null — the line breaks — never 0', () => {
    const sep6 = all.points.find((p) => p.periodStart === '2026-09-06')!;
    assert.equal(sep6.value, null);
    assert.equal(sep6.position, null);
    assert.equal(sep6.ranked, 2, 'the week still says how many were ranked');
    const aug30 = all.points.find((p) => p.periodStart === '2026-08-30')!;
    assert.equal(aug30.value, 0, 'a saved 0 is an entry');
    assert.equal(aug30.position, 3);
  });

  it('ties share a position; the team average is over people with an entry', () => {
    const annH = buildPersonHistory({ weeks: WEEKS, members: ROSTER, member: ann, window: 'all', rankBy: values });
    const sep13 = annH.points.find((p) => p.periodStart === '2026-09-13')!;
    assert.deepEqual([sep13.value, sep13.position, sep13.ranked], [6, 1, 3], 'Ann and Bea both 6 → both #1');
    assert.equal(sep13.teamAverage, (6 + 6 + 2) / 3);
    assert.equal(annH.points[0]!.teamAverage, 5, 'a leaver is not in the team average either');
  });

  it("the average per week equals the board's for the same window", () => {
    for (const window of ['last4w', 'last3m', 'all'] as const) {
      const lb = computeLeaderboard({ weeks: WEEKS, days: null, members: ROSTER, window, basis: 'weekly', todayIso: '2026-09-28' });
      for (const row of lb.rows) {
        const h = buildPersonHistory({ weeks: WEEKS, members: ROSTER, member: row.member, window, rankBy: values });
        assert.equal(h.averagePerWeek, row.avgWeekly, `${row.name}, ${window}`);
        assert.equal(h.weeksScored, row.weeksScored, `${row.name}, ${window}`);
      }
    }
  });

  it('Last 4 weeks = the newest four SETTLED weeks', () => {
    const three = [...WEEKS, week('2026-08-16', [['ann@gmail.com', 1]])];
    const h = buildPersonHistory({ weeks: three, members: ROSTER, member: ann, window: 'last4w', rankBy: values });
    assert.deepEqual(h.points.map((p) => p.periodStart), ['2026-08-23', '2026-08-30', '2026-09-06', '2026-09-13']);
  });

  it('best week (the newest on a tie) and best rank with the weeks held', () => {
    const annH = buildPersonHistory({ weeks: WEEKS, members: ROSTER, member: ann, window: 'all', rankBy: values });
    assert.deepEqual(annH.bestWeek, { periodStart: '2026-08-30', value: 8 });
    assert.deepEqual(annH.bestRank, { position: 1, weeks: 3 }, '#1 on 08-23, 08-30 and (tied) 09-13');
  });

  it('finds the person by email when the roster was re-fetched (new objects)', () => {
    const fresh = ROSTER.map((m) => ({ ...m }));
    const h = buildPersonHistory({ weeks: WEEKS, members: fresh, member: bea, window: 'all', rankBy: values });
    assert.equal(h.weeksScored, 3);
  });
});

describe('buildPersonHistory — a server-ranked board (KPI: the order is the bonus)', () => {
  it('takes the server positions even where the counts would order it the other way', () => {
    // Counts: Ann 4, Bea 7 on 09-06. The server says Ann earned more (a dearer item).
    const server: Record<string, WeekRank> = {
      '2026-09-06': { position: 1, ranked: 2 },
      '2026-09-13': { position: 3, ranked: 3 },
    };
    const h = buildPersonHistory({
      weeks: WEEKS,
      members: ROSTER,
      member: ann,
      window: 'all',
      rankBy: { kind: 'server', lookup: (ps) => server[ps] ?? null },
    });
    const byWeek = Object.fromEntries(h.points.map((p) => [p.periodStart, [p.value, p.position, p.ranked]]));
    assert.deepEqual(byWeek['2026-09-06'], [4, 1, 2]);
    assert.deepEqual(byWeek['2026-09-13'], [6, 3, 3], 'not the #1 a count order would give');
    assert.deepEqual(byWeek['2026-08-30'], [8, null, 0], 'a week the server did not rank has no position');
    assert.equal(h.rankPending, false);
  });

  it('while the order has not arrived: no positions, pending — never ranked from the counts', () => {
    const h = buildPersonHistory({
      weeks: WEEKS,
      members: ROSTER,
      member: ann,
      window: 'all',
      rankBy: { kind: 'server', lookup: null },
    });
    assert.equal(h.rankPending, true);
    assert.ok(h.points.every((p) => p.position === null && p.ranked === 0));
    assert.equal(h.bestRank, null);
    assert.equal(h.averagePerWeek, (5 + 8 + 4 + 6) / 4, 'the counts still show');
  });
});
