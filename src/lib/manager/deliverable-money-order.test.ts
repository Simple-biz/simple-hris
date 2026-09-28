import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildKpiData,
  buildMoneyOrder,
  classifyBonuses,
  isCountVariable,
  toClientPayload,
  type AppliedMoneyRow,
  type BonusAssignmentRow,
  type BonusDefRow,
} from './deliverable-money-order';
import {
  ALL_METRIC,
  applyMoneyOrder,
  metricShowsValues,
  projectDeliverableWeeks,
  weekRankLookup,
} from './deliverable-rankings';
import { computeLeaderboard } from './appointment-averages';
import type { ApptRosterMember } from './appointment-rankings';

/* Kane, 2026-09-26: *"based on their Bonus … hook the money like the highest money
 * value without displaying it"*; 2026-09-27: *"a rankings tab for OTHER Departments as
 * long as they were assigned a KPI Bonus"*. The pesos decide the order and must never
 * leave the server (`manager-my-team.md:13-17`; `employee-team-directory.md:177-179`).
 * Formulas, scopes and rates below are the LIVE catalog's (measured 2026-09-27). Every
 * amount ends in a SENTINEL fraction so a leak is findable in the serialized payload. */

const S = 0.37; // no count in these fixtures ends in .37
const row = (
  period_start: string,
  employee_email: string,
  bonus_id: string,
  bonus_name: string,
  vars: Record<string, unknown>,
  amount: number,
): AppliedMoneyRow => ({ period_start, period_end: '', employee_email, bonus_id, bonus_name, vars, amount });
const def = (id: string, formula: string, kind = 'formula'): BonusDefRow => ({ id, kind, formula });
const asg = (bonus_id: string, department_key: string, scope = 'department', shared_team = false): BonusAssignmentRow => ({
  bonus_id,
  scope,
  department_key,
  shared_team,
});

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
const statuses = [
  { period_start: '2026-09-13', status: 'ready' },
  { period_start: '2026-09-06', status: 'ready' },
];

// PM Team, as live: department-scoped count bonuses + Scott's EMPLOYEE-scoped manager bonus.
const PM_DEFS = [
  def('b_sc', '=SmartCustomer*500'),
  def('b_units', '=Units*2500'),
  def('b_tp', '=TrustPilot*1000'),
  def('b_scott', '=SmartCustomer*100+TrustPilot*150+BBB*150'),
];
const PM_ASG = [asg('b_sc', 'pm_team'), asg('b_units', 'pm_team'), asg('b_tp', 'pm_team'), asg('b_scott', 'pm_team', 'employee')];
// Ann: many cheap items (SmartCustomer ₱500). Bea: fewer, dearer ones (a Sale ₱2,500).
const PM_APPLIED: AppliedMoneyRow[] = [
  row('2026-09-13', 'ann@gmail.com', 'b_sc', 'SmartCustomer', { SmartCustomer: 4 }, 2000 + S),
  row('2026-09-13', 'bea@gmail.com', 'b_units', 'Total Sales and Referral', { Units: 2 }, 5000 + S),
  row('2026-09-06', 'ann@gmail.com', 'b_sc', 'SmartCustomer', { SmartCustomer: 4 }, 2000 + S),
  row('2026-09-06', 'bea@gmail.com', 'b_units', 'Total Sales and Referral', { Units: 1.5 }, 3750 + S),
  row('2026-09-06', 'bea@gmail.com', 'b_tp', 'TrustPilot', { TrustPilot: 1 }, 1000 + S),
  row('2026-09-13', 'scottcam000@gmail.com', 'b_scott', 'Scott Cameron', MANAGER, 99999 + S),
  row('2026-09-06', 'scottcam000@gmail.com', 'b_scott', 'Scott Cameron', MANAGER, 88888 + S),
];
const build = (applied: AppliedMoneyRow[], deptKey: string, defs: BonusDefRow[], assignments: BonusAssignmentRow[]) =>
  buildKpiData({ applied, statuses, locks: [], currentWeekStart: '2026-09-13', deptKey, defs, assignments });
const data = build(PM_APPLIED, 'pm_team', PM_DEFS, PM_ASG);

describe('isCountVariable — a value may be SHOWN only when the formula multiplies it by a rate', () => {
  it('reads the live count formulas as counts', () => {
    assert.equal(isCountVariable('=Tickets_Completed*50', 'Tickets_Completed'), true);
    assert.equal(isCountVariable('AMP*1250', 'AMP'), true);
    assert.equal(isCountVariable('=sum(Site_Star_Ranking*1000)', 'Site_Star_Ranking'), true);
    assert.equal(isCountVariable('=IF(Appts_Set>=10, Appts_Set*500, Appts_Set*250)', 'Appts_Set'), true);
    assert.equal(isCountVariable('=100 * Units_Sold', 'Units_Sold'), true);
  });

  it('a variable that IS the pesos is not a count (Client VA =Appt_Bonus, AI/API =AI_Bonus)', () => {
    assert.equal(isCountVariable('=Appt_Bonus', 'Appt_Bonus'), false);
    assert.equal(isCountVariable('=AI_Bonus', 'AI_Bonus'), false);
    assert.equal(isCountVariable('=Appt_Bonus*1', 'Appt_Bonus'), false, 'a ×1 is still the pesos');
  });

  it('matches whole names, and fails closed on anything it cannot read', () => {
    assert.equal(isCountVariable('=Units_Sold*150', 'Units'), false, 'Units is not Units_Sold');
    assert.equal(isCountVariable('=units*IF(headcount < 6, 125, 150) / headcount', 'units'), false);
    assert.equal(isCountVariable(null, 'X'), false);
    assert.equal(isCountVariable('', 'X'), false);
  });
});

describe('classifyBonuses — a person\'s own KPI or a team split counts; a named person\'s bonus does not (on evidence)', () => {
  const c = classifyBonuses({
    deptKey: 'hr',
    defs: [def('hr', '=sum(New_Hires_After_4_Weeks*1000/HR_Team_Members)'), def('lr', '=Units_Sold*30')],
    assignments: [asg('hr', 'hr', 'department', true), asg('lr', 'hr', 'employee'), asg('lr', 'callback', 'employee')],
  });

  it('a department-scoped shared-team split is a TEAM bonus (Kane 2026-09-28, ruling (b)): counted, not personal', () => {
    assert.equal(c.get('hr')!.personal, false);
    assert.equal(c.get('hr')!.team, true);
  });

  it("an employee-scoped bonus is one person's own: neither personal nor team, so never counted", () => {
    assert.equal(c.get('lr')!.personal, false);
    assert.equal(c.get('lr')!.team, false);
  });

  it('a bonus with an unshared department assignment beside a shared one is personal, not team', () => {
    const r = classifyBonuses({
      deptKey: 'qc',
      defs: [def('x', '=units*10')],
      assignments: [asg('x', 'qc', 'department', true), asg('x', 'qc', 'department', false)],
    });
    assert.equal(r.get('x')!.personal, true);
    assert.equal(r.get('x')!.team, false);
  });

  it('a bonus with NO assignment for this department keeps counting (a retired bonus keeps its history)', () => {
    const r = classifyBonuses({ deptKey: 'edit', defs: [def('old', '=Tickets*50')], assignments: [asg('old', 'qc')] });
    assert.equal(r.get('old')!.personal, true);
  });
});

describe('buildKpiData — PM Team', () => {
  it('is available; every personal one-variable bonus is a KPI, shown because each is a count', () => {
    assert.equal(data.available, true);
    assert.equal(data.servedBy, null);
    assert.deepEqual(data.metrics, [
      { key: 'SmartCustomer', label: 'SmartCustomer', shown: true, team: false },
      { key: 'Units', label: 'Total Sales and Referral', shown: true, team: false },
      { key: 'TrustPilot', label: 'TrustPilot', shown: true, team: false },
    ]);
  });

  it("skips and counts Scott's employee-scoped, multi-variable manager rows", () => {
    assert.equal(data.skippedRows, 2);
    for (const w of data.moneyWeeks) assert.ok(w.rows.every((r) => r.email !== 'scottcam000@gmail.com'));
  });

  it('labels a KPI with its NEWEST bonus name, so a rename reads as renamed', () => {
    const renamed = build(
      [
        row('2026-09-06', 'a@b.c', 'tu', 'TransUnion', { TransUnion: 1 }, 1000),
        row('2026-09-13', 'a@b.c', 'tu', 'TransUnion Reviews', { TransUnion: 1 }, 1000),
      ],
      'pm_team',
      [def('tu', '=TransUnion*1000')],
      [asg('tu', 'pm_team')],
    );
    assert.deepEqual(renamed.metrics, [{ key: 'TransUnion', label: 'TransUnion Reviews', shown: true, team: false }]);
  });
});

describe('buildKpiData — the other departments', () => {
  it('Edit (one count bonus) lights up with no code change', () => {
    const edit = build(
      [row('2026-09-13', 'a@b.c', 'e', 'Edit', { Tickets_Completed: 12 }, 600)],
      'edit',
      [def('e', '=Tickets_Completed*50')],
      [asg('e', 'edit')],
    );
    assert.equal(edit.available, true);
    assert.deepEqual(edit.metrics, [{ key: 'Tickets_Completed', label: 'Edit', shown: true, team: false }]);
  });

  it('Client VA (=Appt_Bonus) is ranked but ORDER-ONLY: the value never reaches the client', () => {
    const cva = build(
      [
        row('2026-09-13', 'ann@gmail.com', 'cva', 'Client VA', { Appt_Bonus: 1750 + S }, 1750 + S),
        row('2026-09-06', 'ann@gmail.com', 'cva', 'Client VA', { Appt_Bonus: 1250 + S }, 1250 + S),
        row('2026-09-13', 'bea@gmail.com', 'cva', 'Client VA', { Appt_Bonus: 4000 + S }, 4000 + S),
        row('2026-09-06', 'bea@gmail.com', 'cva', 'Client VA', { Appt_Bonus: 3000 + S }, 3000 + S),
      ],
      'client_va',
      [def('cva', '=Appt_Bonus')],
      [asg('cva', 'client_va')],
    );
    assert.equal(cva.available, true);
    assert.deepEqual(cva.metrics, [{ key: 'Appt_Bonus', label: 'Client VA', shown: false, team: false }]);
    assert.equal(metricShowsValues(ALL_METRIC, cva.metrics), false);
    const w = cva.weeks.find((x) => x.periodStart === '2026-09-13')!;
    assert.deepEqual(w.rows[0], { email: 'ann@gmail.com', counts: {}, hidden: ['Appt_Bonus'] });

    const order = buildMoneyOrder({
      moneyWeeks: cva.moneyWeeks,
      metrics: cva.metrics,
      members: [ann, bea],
      days: null,
      basis: 'weekly',
      todayIso: '2026-09-26',
    });
    const json = JSON.stringify(toClientPayload(cva, order, '2026-09-13'));
    assert.doesNotMatch(json, /\.37|1750|1250|4000|3000/, 'Client VA’s peso-valued variable leaked');
    const beaAt = order.people.findIndex((e) => e.includes('bea@gmail.com'));
    assert.equal(order.positions.all[ALL_METRIC]![beaAt], 1, 'still ranked by the bonus');
  });

  it('a department with its own Rankings view is left to it — appointments or SP', () => {
    const lg = build([row('2026-09-13', 'a@b.c', 'lg', 'Lead Gen', { Appts_Set: 4 }, 1000)], 'lead_gen', [], []);
    assert.equal(lg.available, false);
    assert.equal(lg.servedBy, 'appointments');
    const cb = build(
      [
        row('2026-09-13', 'a@b.c', 'cb', 'Call Back', { Appts_Set: 4 }, 200),
        row('2026-09-13', 'b@b.c', 'lr', 'Lead Receptionist', { Units_Sold: 2 }, 60),
      ],
      'callback',
      [],
      [],
    );
    assert.equal(cb.servedBy, 'appointments');
    const devs = build(
      [
        row('2026-09-13', 'a@b.c', 'ai', 'AI Team Bonus', { SP: 30, Ranking: 1, Project_SP: 0 }, 3100),
        row('2026-09-13', 'a@b.c', 'tmp', 'AI Team (TEMP BONUS)', { AI_Bonus: 500 }, 500),
      ],
      'devs',
      [],
      [],
    );
    assert.equal(devs.available, false);
    assert.equal(devs.servedBy, 'sp');
  });

  it('a KPI scored by a count bonus AND a peso-valued one is order-only (fail closed)', () => {
    const mixed = build(
      [
        row('2026-09-13', 'a@b.c', 'n', 'Units', { Units_Sold: 2 }, 300),
        row('2026-09-06', 'a@b.c', 'm', 'Units (manual)', { Units_Sold: 450 }, 450),
      ],
      'sales_assistant',
      [def('n', '=Units_Sold*150'), def('m', '=Units_Sold')],
      [asg('n', 'sales_assistant'), asg('m', 'sales_assistant')],
    );
    assert.equal(mixed.metrics[0]!.shown, false);
  });

  it('a department of team splits only (HR / QC / Accounting) gets a TEAM board (Kane 2026-09-28, ruling (b))', () => {
    const hr = build(
      [row('2026-09-13', 'a@b.c', 'hr', 'HR', { HR_Team_Members: 9, New_Hires_After_4_Weeks: 78 }, 8666.67)],
      'hr',
      [def('hr', '=sum(New_Hires_After_4_Weeks*1000/HR_Team_Members)')],
      [asg('hr', 'hr', 'department', true)],
    );
    assert.equal(hr.available, true);
    assert.equal(hr.skippedRows, 0);
    assert.deepEqual(hr.metrics, [{ key: 'New_Hires_After_4_Weeks', label: 'HR', shown: true, team: true }]);
  });
});

describe('buildKpiData — team splits (HR / QC / Accounting), live formulas measured 2026-09-28', () => {
  const HR_DEFS = [
    def('hr', '=sum(New_Hires_After_4_Weeks*1000/HR_Team_Members)'),
    def('si', '=sum(10000*Sales_Rep_Hires)+(5000*Other_Hires)'),
  ];
  const HR_ASG = [asg('hr', 'hr', 'department', true), asg('si', 'hr', 'employee')];
  const HR_TEAM = { HR_Team_Members: 9, New_Hires_After_4_Weeks: 78 };
  const HR_ROWS: AppliedMoneyRow[] = [
    row('2026-09-13', 'ann@gmail.com', 'hr', 'HR', HR_TEAM, 8666 + S),
    row('2026-09-13', 'bea@gmail.com', 'hr', 'HR', HR_TEAM, 8666 + S),
    row('2026-09-06', 'ann@gmail.com', 'hr', 'HR', { HR_Team_Members: 9, New_Hires_After_4_Weeks: 45 }, 5000 + S),
    row('2026-09-06', 'bea@gmail.com', 'hr', 'HR', { HR_Team_Members: 9, New_Hires_After_4_Weeks: 45 }, 5000 + S),
    row('2026-09-13', 'arli@gmail.com', 'si', 'HR - Special Interviewer', { Sales_Rep_Hires: 1, Other_Hires: 2 }, 20000 + S),
  ];
  const hr = build(HR_ROWS, 'hr', HR_DEFS, HR_ASG);

  it("HR ranks on its new hires: the team-size divisor is not a KPI, and the named person's bonus is skipped", () => {
    assert.equal(hr.available, true);
    assert.deepEqual(hr.metrics, [{ key: 'New_Hires_After_4_Weeks', label: 'HR', shown: true, team: true }]);
    assert.equal(hr.skippedRows, 1, 'HR - Special Interviewer is employee-scoped');
    assert.deepEqual(
      hr.weeks.map((w) => w.rows),
      [
        [
          { email: 'ann@gmail.com', counts: { New_Hires_After_4_Weeks: 78 } },
          { email: 'bea@gmail.com', counts: { New_Hires_After_4_Weeks: 78 } },
        ],
        [
          { email: 'ann@gmail.com', counts: { New_Hires_After_4_Weeks: 45 } },
          { email: 'bea@gmail.com', counts: { New_Hires_After_4_Weeks: 45 } },
        ],
      ],
    );
  });

  it('every member carries the same team figure, so everyone ties — on the board AND in each week', () => {
    const order = buildMoneyOrder({
      moneyWeeks: hr.moneyWeeks,
      metrics: hr.metrics,
      members: [ann, bea],
      days: null,
      basis: 'weekly',
      todayIso: '2026-09-26',
    });
    assert.deepEqual(order.positions.all[ALL_METRIC], [1, 1]);
    assert.deepEqual(order.positions.all.New_Hires_After_4_Weeks, [1, 1]);
    for (const w of order.weeks!) assert.deepEqual(w.positions[ALL_METRIC], [1, 1]);
  });

  it('the team payload carries no peso, no rate and no team size', () => {
    const order = buildMoneyOrder({
      moneyWeeks: hr.moneyWeeks,
      metrics: hr.metrics,
      members: [ann, bea],
      days: null,
      basis: 'weekly',
      todayIso: '2026-09-26',
    });
    const json = JSON.stringify(toClientPayload(hr, order, '2026-09-13'));
    assert.doesNotMatch(json, /amount|money|formula|HR_Team_Members|\.37/i);
    for (const n of ['8666', '5000', '1000', '20000', '10000']) {
      assert.ok(!new RegExp(`\\b${n}\\b`).test(json), `peso figure or rate ${n} leaked into the payload`);
    }
  });

  it('QC ranks on units, ORDER-ONLY: its rate is conditional, so isCountVariable fails closed', () => {
    const qc = build(
      [
        row('2026-09-13', 'ann@gmail.com', 'qc', 'QC', { units: 290, headcount: 9 }, 4833 + S),
        row('2026-09-13', 'bea@gmail.com', 'qc', 'QC', { units: 290, headcount: 9 }, 4833 + S),
      ],
      'qc',
      [def('qc', '=units*IF(headcount < 6, 125, 150) / headcount')],
      [asg('qc', 'qc', 'department', true)],
    );
    assert.deepEqual(qc.metrics, [{ key: 'units', label: 'QC', shown: false, team: true }]);
    assert.deepEqual(qc.weeks[0]!.rows[0], { email: 'ann@gmail.com', counts: {}, hidden: ['units'] });
  });

  it("Accounting's five day counts are ONE team item, keyed in formula order, and order-only (tiered)", () => {
    const DAYS = { Friday: 20, Monday: 31, Tuesday: 25, Thursday: 18, Wednesday: 16 };
    const acc = build(
      [row('2026-09-13', 'ann@gmail.com', 'dq', 'Dancing Queen Bonus', DAYS, 1150 + S)],
      'accounting',
      [
        def(
          'dq',
          '=SUM(IF(Monday>=30, 450, IF(Monday>=22, 300, 0)), IF(Tuesday>=30, 450, 0), IF(Wednesday>=30, 450, 0), IF(Thursday>=30, 450, 0), IF(Friday>=30, 450, 0))',
        ),
      ],
      [asg('dq', 'accounting', 'department', true)],
    );
    const key = 'Monday+Tuesday+Wednesday+Thursday+Friday';
    assert.deepEqual(acc.metrics, [{ key, label: 'Dancing Queen Bonus', shown: false, team: true }]);
    assert.deepEqual(acc.moneyWeeks[0]!.rows[0]!.counts, { [key]: 110 });
  });

  it('fails closed: a multi-variable team row with no readable formula is skipped, never summed with its team size', () => {
    const blind = build(
      [row('2026-09-13', 'ann@gmail.com', 'qc', 'QC', { units: 290, headcount: 9 }, 4833 + S)],
      'qc',
      [],
      [asg('qc', 'qc', 'department', true)],
    );
    assert.equal(blind.available, false);
    assert.equal(blind.skippedRows, 1);
  });

  it('a variable the formula never uses is not a team KPI', () => {
    const extra = build(
      [row('2026-09-13', 'ann@gmail.com', 'hr', 'HR', { ...HR_TEAM, Notes_Count: 4 }, 8666 + S)],
      'hr',
      HR_DEFS,
      HR_ASG,
    );
    assert.deepEqual(extra.weeks[0]!.rows[0]!.counts, { New_Hires_After_4_Weeks: 78 });
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

describe("buildMoneyOrder — each settled week's own order, for the Rankings View modal", () => {
  const order = buildMoneyOrder({
    moneyWeeks: data.moneyWeeks,
    metrics: data.metrics,
    members: [ann, bea],
    days: null,
    basis: 'weekly',
    todayIso: '2026-09-26',
  });
  const payload = toClientPayload(data, order, '2026-09-13');
  const rankOf = (m: ApptRosterMember, metric: string, week: string) => weekRankLookup(payload.order, m, metric)?.(week);

  it('ranks each week on its PESOS, not its counts (09-13: Ann 4 items ₱2,000, Bea 2 items ₱5,000)', () => {
    assert.deepEqual(rankOf(bea, ALL_METRIC, '2026-09-13'), { position: 1, ranked: 2 });
    assert.deepEqual(rankOf(ann, ALL_METRIC, '2026-09-13'), { position: 2, ranked: 2 });
  });

  it('a single KPI week ranks only the people who have it; others have no position', () => {
    assert.deepEqual(rankOf(ann, 'SmartCustomer', '2026-09-06'), { position: 1, ranked: 1 });
    assert.deepEqual(rankOf(bea, 'SmartCustomer', '2026-09-06'), { position: null, ranked: 1 });
    assert.deepEqual(
      rankOf(bea, 'TrustPilot', '2026-09-06'),
      { position: 1, ranked: 1 },
      'one week of TrustPilot still has a weekly place, though not a board place',
    );
  });

  it("Scott's skipped manager rows are in no week's order", () => {
    assert.ok(order.people.every((emails) => !emails.includes('scottcam000@gmail.com')));
    for (const w of order.weeks!) assert.equal(w.ranked[ALL_METRIC], 2);
  });

  it('is newest first, weekly basis only; the daily order carries none', () => {
    assert.deepEqual(order.weeks!.map((w) => w.periodStart), ['2026-09-13', '2026-09-06']);
    const daily = buildMoneyOrder({
      moneyWeeks: data.moneyWeeks,
      metrics: data.metrics,
      members: [ann, bea],
      days: [],
      basis: 'daily',
      todayIso: '2026-09-26',
    });
    assert.equal(daily.weeks, undefined);
  });

  it('a payload without it (cached before it existed) gives no lookup, so the modal waits', () => {
    const { weeks: _dropped, ...old } = order;
    assert.equal(weekRankLookup(old, ann, ALL_METRIC), null);
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

  it("serializes the weekly order too, so the sentinel checks below cover it", () => {
    assert.match(json, /"weeks":\[\{"periodStart":"2026-09-13","ranked"/);
  });

  it('carries no amount, no money field, no formula, and none of the sentinel pesos', () => {
    assert.doesNotMatch(json, /amount|money|formula/i);
    assert.doesNotMatch(json, /\.37/, 'a sentinel peso fraction leaked into the payload');
    for (const n of ['2000', '5000', '3750', '1000', '4000', '9750', '99999', '88888', '2500', '500']) {
      assert.ok(!new RegExp(`\\b${n}\\b`).test(json), `peso figure or rate ${n} leaked into the payload`);
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

  it("nor the HSL money module (it reads calculated_bonus, the card's whole pay)", () => {
    const offenders = [...walk(path.join(ROOT, 'src', 'components')), ...walk(path.join(ROOT, 'app'))].filter((f) =>
      readFileSync(f, 'utf8').includes('hsl-kpi-money-order'),
    );
    assert.deepEqual(offenders, []);
  });
});
