import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildKpiData,
  buildMoneyOrder,
  toClientPayload,
  type AppliedMoneyRow,
} from './deliverable-money-order';
import { ALL_METRIC, applyMoneyOrder, projectDeliverableWeeks } from './deliverable-rankings';
import { computeLeaderboard } from './appointment-averages';
import type { ApptRosterMember } from './appointment-rankings';

/* Kane, 2026-09-26: *"based on their Bonus … hook the money like the highest money
 * value without displaying it"*. The pesos decide the order and must never leave the
 * server (`manager-my-team.md:13-17`; `employee-team-directory.md:177-179`). Rates
 * below are PM Team's live ones (measured 2026-09-26): TrustPilot / BBB ₱1,000,
 * SmartCustomer ₱500, Units ₱2,500. Every amount ends in a SENTINEL fraction so a leak
 * is findable in the serialized payload. */

const S = 0.37; // no count in these fixtures ends in .37
const row = (
  period_start: string,
  employee_email: string,
  bonus_name: string,
  vars: Record<string, unknown>,
  amount: number,
): AppliedMoneyRow => ({ period_start, period_end: '', employee_email, bonus_name, vars, amount });

const member = (name: string, personal: string, work: string): ApptRosterMember => ({
  name,
  personal_email: personal,
  work_email: work,
  alternate_work_email: null,
  alternate_work_email_2: null,
  start_date: null,
});
const ann = member('Ann', 'ann@gmail.com', 'ann@simple.biz');
const bea = member('Bea', 'bea@gmail.com', 'bea@simple.biz');
const MANAGER = { FB: 3, SP: 12, BBB: 5, TransUnion: 9, TrustPilot: 7, SmartCustomer: 4 };

// Ann: many cheap items (SmartCustomer ₱500). Bea: fewer, dearer ones (a Sale ₱2,500).
const applied: AppliedMoneyRow[] = [
  row('2026-09-13', 'ann@gmail.com', 'SmartCustomer', { SmartCustomer: 4 }, 2000 + S),
  row('2026-09-13', 'bea@gmail.com', 'Total Sales and Referral', { Units: 2 }, 5000 + S),
  row('2026-09-06', 'ann@gmail.com', 'SmartCustomer', { SmartCustomer: 4 }, 2000 + S),
  row('2026-09-06', 'bea@gmail.com', 'Total Sales and Referral', { Units: 1.5 }, 3750 + S),
  row('2026-09-06', 'bea@gmail.com', 'TrustPilot', { TrustPilot: 1 }, 1000 + S),
  row('2026-09-13', 'scottcam000@gmail.com', 'Scott Cameron', MANAGER, 99999 + S),
  row('2026-09-06', 'scottcam000@gmail.com', 'Scott Cameron', MANAGER, 88888 + S),
];
const statuses = [
  { period_start: '2026-09-13', status: 'ready' },
  { period_start: '2026-09-06', status: 'ready' },
];
const data = buildKpiData({ applied, statuses, locks: [], currentWeekStart: '2026-09-13' });

describe('buildKpiData', () => {
  it('is available because a PM KPI variable is present; every one-variable bonus is a KPI', () => {
    assert.equal(data.available, true);
    assert.deepEqual(data.metrics, [
      { key: 'SmartCustomer', label: 'SmartCustomer' },
      { key: 'Units', label: 'Total Sales and Referral' },
      { key: 'TrustPilot', label: 'TrustPilot' },
    ]);
  });

  it("skips and counts the manager's team-total rows — they are nobody's own items or pesos", () => {
    assert.equal(data.skippedRows, 2);
    for (const w of data.moneyWeeks) assert.ok(w.rows.every((r) => r.email !== 'scottcam000@gmail.com'));
  });

  it('labels a KPI with its NEWEST bonus name, so a rename reads as renamed', () => {
    const renamed = buildKpiData({
      applied: [
        row('2026-09-06', 'a@b.c', 'TransUnion', { TransUnion: 1 }, 1000),
        row('2026-09-13', 'a@b.c', 'TransUnion Reviews', { TransUnion: 1 }, 1000),
      ],
      statuses: [],
      locks: [],
      currentWeekStart: '2026-09-13',
    });
    assert.deepEqual(renamed.metrics, [{ key: 'TransUnion', label: 'TransUnion Reviews' }]);
  });

  it('a department without any PM KPI variable does not get the view', () => {
    const other = buildKpiData({
      applied: [row('2026-09-13', 'a@b.c', 'Lead Gen', { Appts_Set: 4 }, 1000)],
      statuses: [],
      locks: [],
      currentWeekStart: '2026-09-13',
    });
    assert.equal(other.available, false);
  });
});

describe('buildMoneyOrder — ranked on pesos, returned as positions', () => {
  const order = buildMoneyOrder({
    moneyWeeks: data.moneyWeeks,
    metrics: data.metrics,
    members: [ann, bea],
    days: null,
    basis: 'weekly',
    todayIso: '2026-09-26',
  });
  const posOf = (email: string, window: 'last4w' | 'last3m' | 'all', metric: string) => {
    const i = order.people.findIndex((emails) => emails.includes(email));
    return i < 0 ? null : order.positions[window][metric]![i];
  };

  it('the highest bonus is #1 even with FEWER items (Kane: "the highest money value")', () => {
    // Items: Ann 8, Bea 4.5 → by counts Ann leads. Pesos: Ann ₱4,000, Bea ₱9,750 → Bea leads.
    assert.equal(posOf('bea@gmail.com', 'all', ALL_METRIC), 1);
    assert.equal(posOf('ann@gmail.com', 'all', ALL_METRIC), 2);
  });

  it('a single KPI ranks only the people who have it, on its pesos', () => {
    assert.equal(posOf('ann@gmail.com', 'all', 'SmartCustomer'), 1);
    assert.equal(posOf('bea@gmail.com', 'all', 'SmartCustomer'), null);
    assert.equal(posOf('bea@gmail.com', 'all', 'TrustPilot'), null, 'one week of TrustPilot is not enough history');
  });

  it('carries every email a ranked person owns, so the pane can match any of them', () => {
    assert.deepEqual(order.people, [
      ['ann@gmail.com', 'ann@simple.biz'],
      ['bea@gmail.com', 'bea@simple.biz'],
    ]);
  });

  it('the pane, applying it to the COUNT leaderboard, shows Bea first with her counts', () => {
    const payload = toClientPayload(data, order, '2026-09-13');
    const lb = computeLeaderboard({
      weeks: projectDeliverableWeeks(payload.weeks, ALL_METRIC),
      days: [],
      members: [ann, bea],
      basis: 'weekly',
      window: 'all',
      todayIso: '2026-09-26',
    });
    assert.deepEqual(lb.rows.map((r) => r.name), ['Ann', 'Bea'], 'by counts Ann would lead');
    const shown = applyMoneyOrder(lb.rows, payload.order, 'all', ALL_METRIC);
    assert.deepEqual(
      shown.rows.map((r) => [r.position, r.name, r.totalAppointments]),
      [
        [1, 'Bea', 4.5],
        [2, 'Ann', 8],
      ],
    );
    assert.equal(shown.unplaced, 0);
  });
});

describe('toClientPayload — no peso ever leaves the server', () => {
  const order = buildMoneyOrder({
    moneyWeeks: data.moneyWeeks,
    metrics: data.metrics,
    members: [ann, bea],
    days: null,
    basis: 'weekly',
    todayIso: '2026-09-26',
  });
  const json = JSON.stringify(toClientPayload(data, order, '2026-09-13'));

  it('carries no amount, no money field, and none of the sentinel pesos', () => {
    assert.doesNotMatch(json, /amount|money/i);
    assert.doesNotMatch(json, /\.37/, 'a sentinel peso fraction leaked into the payload');
    for (const n of ['2000', '5000', '3750', '1000', '4000', '9750', '99999', '88888']) {
      assert.ok(!json.includes(n), `peso figure ${n} leaked into the payload`);
    }
  });

  it('is built field by field — no spread that could carry moneyWeeks along', () => {
    const src = readFileSync(path.join(__dirname, 'deliverable-money-order.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export function toClientPayload'));
    assert.doesNotMatch(fn, /\.\.\.data\b|moneyWeeks/);
  });
});

describe('the money module is server-only', () => {
  const ROOT = path.join(__dirname, '..', '..', '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) return f === 'node_modules' || f === 'api' ? [] : walk(p);
      return /\.(tsx?|jsx?)$/.test(f) ? [p] : [];
    });

  it('no component or page imports it (only the Supabase read does)', () => {
    const offenders = [...walk(path.join(ROOT, 'src', 'components')), ...walk(path.join(ROOT, 'app'))].filter((f) =>
      readFileSync(f, 'utf8').includes('deliverable-money-order'),
    );
    assert.deepEqual(offenders, []);
  });
});
