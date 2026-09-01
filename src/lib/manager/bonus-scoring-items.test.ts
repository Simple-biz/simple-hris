import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBonusScoringItems,
  isOutstanding,
  type BonusCatalogPayload,
  type BonusScoringSummaries,
} from './use-bonus-scoring-queue';

/**
 * `buildBonusScoringItems` is the Overview "Bonuses to score" state machine,
 * pulled out of the hook's effect so the tab cache can re-derive the panel from
 * raw payloads instead of caching the rendered rows
 * (`docs/features/manager-dashboard-cache.md`).
 *
 * It mirrors Payroll Readiness (`buildKpiReadiness`) — the manager's Overview
 * and the accountant's Readiness tab must never disagree about who is still
 * pending — so these pin the mapping itself, not the plumbing:
 *
 *   locked / ready      -> done; payroll has it
 *   scored, not ready   -> in_progress
 *   nothing scored      -> todo
 *   no bonus assigned   -> nothing
 *   monthly, off-week   -> not_due
 *
 * Plus the two rules whose failure direction is the point: an unreadable
 * catalog must NOT clear departments off the list, and a monthly branch must
 * key on the 1st of the month rather than the pay week.
 */

const WEEK = '2026-08-23'; // a Sunday inside August
const MONTH_START = '2026-08-01';

/** `2026-08-23` is not August's final payroll week; `2026-08-30` is. */
const FINAL_WEEK_OF_MONTH = '2026-08-30';

function summaries(over: Partial<BonusScoringSummaries> = {}): BonusScoringSummaries {
  return {
    weekStart: WEEK,
    hslSummary: null,
    weekStatus: null,
    applied: null,
    ...over,
  };
}

/** A catalog that assigns one weekly bonus to `care_coordinators`. */
const CATALOG: BonusCatalogPayload = {
  bonuses: [{ id: 'b1', cadence: 'weekly' } as unknown as NonNullable<BonusCatalogPayload['bonuses']>[number]],
  assignments: [
    { bonusId: 'b1', departmentKey: 'care_coordinators' } as unknown as NonNullable<
      BonusCatalogPayload['assignments']
    >[number],
  ],
};

test('a catalog dept with nothing scored reads todo', () => {
  const items = buildBonusScoringItems({
    hslDepts: [],
    catalogDepts: ['care_coordinators'],
    summaries: summaries(),
    catalog: CATALOG,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]!.state, 'todo');
  assert.equal(items[0]!.scoredCount, 0);
  assert.ok(isOutstanding(items[0]!.state));
});

test('scored but never marked ready reads in_progress, and still counts as outstanding', () => {
  const items = buildBonusScoringItems({
    hslDepts: [],
    catalogDepts: ['care_coordinators'],
    summaries: summaries({
      applied: {
        rows: [
          { department: 'care_coordinators', period_start: WEEK, employee_count: 4, total_bonus: 1200 },
        ],
      },
    }),
    catalog: CATALOG,
  });
  assert.equal(items[0]!.state, 'in_progress');
  assert.equal(items[0]!.scoredCount, 4);
  assert.equal(items[0]!.totalBonus, 1200);
  assert.ok(isOutstanding(items[0]!.state));
});

test('ready reads submitted and locked reads locked — neither is outstanding', () => {
  for (const [status, expected] of [
    ['ready', 'submitted'],
    ['locked', 'locked'],
  ] as const) {
    const items = buildBonusScoringItems({
      hslDepts: [],
      catalogDepts: ['care_coordinators'],
      summaries: summaries({ weekStatus: { rows: [{ department: 'care_coordinators', status }] } }),
      catalog: CATALOG,
    });
    assert.equal(items[0]!.state, expected, `${status} must read ${expected}`);
    assert.equal(isOutstanding(items[0]!.state), false);
  }
});

test('applied rows for a DIFFERENT week are ignored — the dept still reads todo', () => {
  const items = buildBonusScoringItems({
    hslDepts: [],
    catalogDepts: ['care_coordinators'],
    summaries: summaries({
      applied: {
        rows: [
          // Last week's scores. `(department, period_start)` is the row's only
          // address, so reading these as this week's is exactly the key drift
          // the panel exists to avoid.
          { department: 'care_coordinators', period_start: '2026-08-16', employee_count: 9, total_bonus: 9999 },
        ],
      },
    }),
    catalog: CATALOG,
  });
  assert.equal(items[0]!.state, 'todo');
  assert.equal(items[0]!.scoredCount, 0);
  assert.equal(items[0]!.totalBonus, 0);
});

test('a dept with no catalog bonus this week reads nothing, not a false to-do', () => {
  const items = buildBonusScoringItems({
    hslDepts: [],
    catalogDepts: ['care_coordinators'],
    summaries: summaries(),
    catalog: { bonuses: [], assignments: [] },
  });
  assert.equal(items[0]!.state, 'nothing');
  assert.equal(isOutstanding(items[0]!.state), false);
});

test('an UNREADABLE catalog assumes every dept has bonuses — never clears the list', () => {
  // The failure direction is the whole point: a failed catalog read must not
  // silently mark a department "Nothing to score" and let a real week slip.
  const items = buildBonusScoringItems({
    hslDepts: [],
    catalogDepts: ['care_coordinators'],
    summaries: summaries(),
    catalog: null,
  });
  assert.equal(items[0]!.state, 'todo');
});

test('a monthly HSL branch keys on the 1st of the month, not the pay week', () => {
  const items = buildBonusScoringItems({
    hslDepts: ['collections'],
    catalogDepts: [],
    summaries: summaries({
      weekStart: FINAL_WEEK_OF_MONTH,
      hslSummary: {
        rows: [
          {
            department: 'collections',
            period_start: MONTH_START,
            status: 'draft',
            scored_count: 3,
            total_bonus: 7500,
          },
        ],
      },
    }),
    catalog: null,
  });
  assert.equal(items[0]!.periodStart, MONTH_START);
  assert.equal(items[0]!.scoredCount, 3, 'a month-keyed row must be found');
  assert.equal(items[0]!.state, 'in_progress');
});

test('a monthly branch outside the month’s pay week reads not_due', () => {
  const items = buildBonusScoringItems({
    hslDepts: ['collections'],
    catalogDepts: [],
    summaries: summaries({ weekStart: WEEK }),
    catalog: null,
  });
  assert.equal(items[0]!.state, 'not_due');
  assert.equal(isOutstanding(items[0]!.state), false);
});

test('a weekly HSL branch is due every week', () => {
  const items = buildBonusScoringItems({
    hslDepts: ['callback_team'],
    catalogDepts: [],
    summaries: summaries(),
    catalog: null,
  });
  assert.equal(items[0]!.cadence, 'weekly');
  assert.equal(items[0]!.periodStart, WEEK);
  assert.equal(items[0]!.state, 'todo');
});

test('what still needs the manager floats to the top', () => {
  const items = buildBonusScoringItems({
    hslDepts: ['callback_team', 'collections'],
    catalogDepts: ['care_coordinators'],
    summaries: summaries({
      weekStatus: { rows: [{ department: 'care_coordinators', status: 'locked' }] },
    }),
    catalog: CATALOG,
  });
  const states = items.map((i) => i.state);
  assert.deepEqual(states, ['todo', 'locked', 'not_due'], `got ${states.join(', ')}`);
});

test('empty in, empty out — no dept invents a row', () => {
  assert.deepEqual(
    buildBonusScoringItems({
      hslDepts: [],
      catalogDepts: [],
      summaries: summaries(),
      catalog: null,
    }),
    [],
  );
});
