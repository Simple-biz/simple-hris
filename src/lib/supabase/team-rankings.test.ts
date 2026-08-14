import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildRankingWeeks,
  hasSpRankings,
  type AppliedRow,
  type StatusRow,
} from './team-rankings';

/* ── Fixtures ────────────────────────────────────────────────────────────
 * Shaped from the live 2026-08-02 AI/API Team week: the "AI Team Bonus"
 * (`bonus_msnh45vwee38zn33`) writes `{ SP, Ranking, Project_SP }` per member,
 * with Ranking ∈ {1, 25, 50, 0}. */

const WEEK = '2026-08-02';
const OLDER = '2026-07-26';

function applied(over: Partial<AppliedRow> & { employee_email: string }): AppliedRow {
  return {
    period_start: WEEK,
    period_end: '2026-08-08',
    department: 'devs',
    employee_name: 'Someone',
    bonus_name: 'AI Team Bonus',
    vars: { SP: 0, Ranking: 0, Project_SP: 0 },
    ...over,
  };
}

const readyStatus: StatusRow = {
  department: 'devs',
  period_start: WEEK,
  period_end: '2026-08-08',
  status: 'ready',
};

describe('team rankings — visibility', () => {
  it('hides a week whose status row is still draft', () => {
    const weeks = buildRankingWeeks(
      [applied({ employee_email: 'a@simple.biz', vars: { SP: 10, Ranking: 1, Project_SP: 0 } })],
      [{ ...readyStatus, status: 'draft' }],
    );
    assert.deepEqual(weeks, [], 'a manager mid-scoring must never be visible to the team');
  });

  it('hides a week with no status row at all', () => {
    const weeks = buildRankingWeeks([applied({ employee_email: 'a@simple.biz' })], []);
    assert.deepEqual(weeks, []);
  });

  it('shows ready and locked weeks, and reports which', () => {
    for (const status of ['ready', 'locked'] as const) {
      const weeks = buildRankingWeeks(
        [applied({ employee_email: 'a@simple.biz' })],
        [{ ...readyStatus, status }],
      );
      assert.equal(weeks.length, 1);
      assert.equal(weeks[0]!.status, status);
    }
  });

  it('drops rows with no employee email rather than inventing an identity', () => {
    const weeks = buildRankingWeeks(
      [
        applied({ employee_email: '' }),
        applied({ employee_email: 'real@simple.biz' }),
      ],
      [readyStatus],
    );
    assert.equal(weeks[0]!.rows.length, 1);
    assert.equal(weeks[0]!.rows[0]!.email, 'real@simple.biz');
  });
});

describe('team rankings — never exposes pay', () => {
  it('a returned row carries SP and tier only, never an amount', () => {
    // A stray amount on the input row must not survive into the output.
    const withStrayAmount = {
      ...applied({
        employee_email: 'a@simple.biz',
        vars: { SP: 157, Ranking: 1, Project_SP: 0 },
      }),
      amount: 5005,
    } satisfies AppliedRow & { amount: number };

    const weeks = buildRankingWeeks([withStrayAmount], [readyStatus]);
    const row = weeks[0]!.rows[0]!;
    assert.deepEqual(
      Object.keys(row).sort(),
      ['email', 'name', 'position', 'projectSp', 'sp', 'tier'],
      'My Team surfaces are pay-free (manager-my-team.md:13-17) — adding a peso field here ' +
        'exposes every teammate’s bonus to the whole department',
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(row, 'amount'),
      'the stray input amount leaked into the returned row',
    );
  });

  it('the DB projection does not select `amount`', () => {
    // Guards the invariant at its real source: the row shape above can stay
    // clean while a widened SELECT still ships pay over the wire.
    const src = readFileSync(path.join(__dirname, 'team-rankings.ts'), 'utf8');
    const select = src.match(/\.select\(\s*'([^']*employee_email[^']*)'\s*\)/)?.[1];
    assert.ok(select, 'expected the bonus_catalog_applied projection to be findable');
    assert.ok(
      !/\bamount\b/.test(select),
      `bonus_catalog_applied projection must not select amount — got: ${select}`,
    );
  });
});

describe('team rankings — ordering and tiers', () => {
  const rows: AppliedRow[] = [
    applied({ employee_email: 'kane@simple.biz', employee_name: 'Kane', vars: { SP: 77, Ranking: 50, Project_SP: 0 } }),
    applied({ employee_email: 'benedict@simple.biz', employee_name: 'Benedict', vars: { SP: 157, Ranking: 1, Project_SP: 0 } }),
    applied({ employee_email: 'karl@simple.biz', employee_name: 'Karl', vars: { SP: 98, Ranking: 25, Project_SP: 272 } }),
    applied({ employee_email: 'abby@simple.biz', employee_name: 'Abby', vars: { SP: 8, Ranking: 0, Project_SP: 0 } }),
  ];

  it('positions by SP descending', () => {
    const week = buildRankingWeeks(rows, [readyStatus])[0]!;
    assert.deepEqual(
      week.rows.map((r) => [r.position, r.name, r.sp]),
      [
        [1, 'Benedict', 157],
        [2, 'Karl', 98],
        [3, 'Kane', 77],
        [4, 'Abby', 8],
      ],
    );
  });

  it('carries the tier flag verbatim — it is a band, not a position', () => {
    const week = buildRankingWeeks(rows, [readyStatus])[0]!;
    assert.deepEqual(
      week.rows.map((r) => r.tier),
      [1, 25, 50, 0],
    );
  });

  it('breaks an SP tie on project SP, then name — a stable order across renders', () => {
    const tied: AppliedRow[] = [
      applied({ employee_email: 'z@simple.biz', employee_name: 'Zoe', vars: { SP: 20, Ranking: 0, Project_SP: 0 } }),
      applied({ employee_email: 'a@simple.biz', employee_name: 'Ana', vars: { SP: 20, Ranking: 0, Project_SP: 0 } }),
      applied({ employee_email: 'm@simple.biz', employee_name: 'Mo', vars: { SP: 20, Ranking: 0, Project_SP: 5 } }),
    ];
    const first = buildRankingWeeks(tied, [readyStatus])[0]!;
    const second = buildRankingWeeks([...tied].reverse(), [readyStatus])[0]!;
    assert.deepEqual(first.rows.map((r) => r.name), ['Mo', 'Ana', 'Zoe']);
    assert.deepEqual(
      first.rows.map((r) => r.name),
      second.rows.map((r) => r.name),
      'input order must not change the standings',
    );
  });

  it('an unknown Ranking value degrades to unranked, never a made-up tier', () => {
    const week = buildRankingWeeks(
      [applied({ employee_email: 'a@simple.biz', vars: { SP: 5, Ranking: 75, Project_SP: 0 } })],
      [readyStatus],
    )[0]!;
    assert.equal(week.rows[0]!.tier, 0);
  });

  it('sorts weeks newest first', () => {
    const weeks = buildRankingWeeks(
      [
        applied({ employee_email: 'a@simple.biz', period_start: OLDER, period_end: '2026-08-01' }),
        applied({ employee_email: 'a@simple.biz' }),
      ],
      [readyStatus, { ...readyStatus, period_start: OLDER, period_end: '2026-08-01' }],
    );
    assert.deepEqual(weeks.map((w) => w.periodStart), [WEEK, OLDER]);
  });
});

describe('team rankings — which departments get the tab', () => {
  it('is driven by the data, so a second team on the same bonus shape lights up', () => {
    assert.equal(hasSpRankings([{ vars: { SP: 3, Ranking: 0, Project_SP: 0 } }]), true);
  });

  it('is false for a department scored on something else (no SP key)', () => {
    assert.equal(hasSpRankings([{ vars: { tickets: 12 } }]), false);
    assert.equal(hasSpRankings([{ vars: null }]), false);
    assert.equal(hasSpRankings([]), false);
  });
});
