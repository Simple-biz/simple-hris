import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildHslKpiData, classifyHslKpiKey, type HslCatalogDef, type HslEntryMoneyRow } from './hsl-kpi-money-order';
import { buildMoneyOrder, toClientPayload } from './deliverable-money-order';
import {
  ALL_METRIC,
  applyMoneyOrder,
  hslBranchFromRailKey,
  projectDeliverableWeeks,
  weekRankLookup,
} from './deliverable-rankings';
import { computeLeaderboard } from './appointment-averages';
import type { ApptRosterMember } from './appointment-rankings';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';

/* HSL KPI Rankings (Kane, 2026-09-28: *"HR, QC, and some others that have KPI Bonus dont
 * have the rankings and the view modal performance"* → Q2 "B", HSL). The order is the
 * stored `calculated_bonus` — what the Payroll Wizard pays — ranked on the server, and it
 * must never leave it (`manager-my-team.md:13-17`). Keys and formulas below are the LIVE
 * shapes (measured read-only 2026-09-28). Every amount ends in a SENTINEL fraction so a
 * leak is findable in the serialized payload. */

const S = 0.37;
const row = (
  period_start: string,
  employee_email: string,
  kpi_data: Record<string, unknown>,
  calculated_bonus: number,
  period_type = 'weekly',
): HslEntryMoneyRow => ({ period_start, period_end: null, period_type, employee_email, kpi_data, calculated_bonus });
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
const statuses = [
  { period_start: '2026-09-13', status: 'ready' },
  { period_start: '2026-09-06', status: 'ready' },
];
const INTAKE_LIB: HslCatalogDef = { id: 'bonus_in', kind: 'formula', formula: '=Signups*250+Reviews*100' };
const build = (entries: HslEntryMoneyRow[], branch: string, catalog: HslCatalogDef[] = []) =>
  buildHslKpiData({ entries, statuses, locks: [], currentWeekStart: '2026-09-13', branch, catalog });

describe('hslBranchFromRailKey — only a namespaced sub-team rail key is an HSL branch', () => {
  it('reads the branch from hsl:<key>', () => {
    assert.equal(hslBranchFromRailKey('hsl:intake_specialist'), 'intake_specialist');
    assert.equal(hslBranchFromRailKey(' HSL:Care_Team '), 'care_team');
  });

  it('the formatted label, the parent and any other department are not ("HSL — …" normalizes to nothing)', () => {
    assert.equal(hslBranchFromRailKey('HSL — Intake Specialist'), null);
    assert.equal(hslBranchFromRailKey('HSL'), null);
    assert.equal(hslBranchFromRailKey('hogan_smith_law'), null);
    assert.equal(hslBranchFromRailKey('PM Team'), null);
    assert.equal(hslBranchFromRailKey('hsl:'), null);
    assert.equal(hslBranchFromRailKey('hsl:../x'), null);
  });
});

describe('classifyHslKpiKey — a KPI is a count only when its rule or formula makes it one', () => {
  const lib = new Map([
    ['bonus_in', INTAKE_LIB],
    ['bonus_cva', { id: 'bonus_cva', kind: 'formula', formula: '=Amount' }],
    ['bonus_fx', { id: 'bonus_fx', kind: 'fixed', formula: null }],
  ]);

  it('a retired per_unit or tiered code rule is a count (its value is items)', () => {
    assert.deepEqual(classifyHslKpiKey('intake_specialist', 'signed_rep_docs', lib), { kind: 'count', label: 'Signed Rep Docs' });
    assert.deepEqual(classifyHslKpiKey('attestation', 'attested_cases', lib), { kind: 'count', label: 'Attested Cases' });
  });

  it("a manual rule is ORDER-ONLY: its value IS pesos (Medical Records' RFC)", () => {
    assert.deepEqual(classifyHslKpiKey('medical_records', 'rfc_form', lib), { kind: 'hidden', label: 'RFC' });
  });

  it('a flat checkbox, a team split and an unknown key are not KPIs', () => {
    assert.equal(classifyHslKpiKey('collections', 'monthly_flat', lib).kind, 'skip');
    assert.equal(classifyHslKpiKey('ssd_medical_records', 'sub_team', lib).kind, 'skip');
    assert.equal(classifyHslKpiKey('ssd_medical_records', 'team_split', lib).kind, 'skip');
    assert.equal(classifyHslKpiKey('hsl_managers', 'signups_weekly', lib).kind, 'skip', 'bespoke manager bands are not a team KPI');
    assert.equal(classifyHslKpiKey('intake_specialist', 'mystery_key', lib).kind, 'skip');
  });

  it('a Library variable is a count only when its formula multiplies it by a rate', () => {
    assert.deepEqual(classifyHslKpiKey('intake_specialist', 'catalog:bonus_in:Signups', lib), { kind: 'count', label: 'Signups' });
    assert.equal(classifyHslKpiKey('x', 'catalog:bonus_cva:Amount', lib).kind, 'hidden', '=Amount IS the pesos');
    assert.equal(classifyHslKpiKey('x', 'catalog:bonus_fx:Units', lib).kind, 'hidden', 'a fixed bonus fails closed');
    assert.equal(classifyHslKpiKey('x', 'catalog:bonus_gone:Units', lib).kind, 'hidden', 'an unreadable bonus fails closed');
  });

  it("a Library bonus's on/off flag is not a KPI", () => {
    assert.equal(classifyHslKpiKey('intake_specialist', 'catalog:bonus_in', lib).kind, 'skip');
  });
});

describe('buildHslKpiData — weekly rows, KPI counts shown, ONE stored amount per row', () => {
  const ENTRIES: HslEntryMoneyRow[] = [
    // Ann: many cheap items. Bea: fewer, dearer ones. The stored amount decides.
    row('2026-09-13', 'ann@simple.biz', { 'catalog:bonus_in': true, 'catalog:bonus_in:Signups': 1, 'catalog:bonus_in:Reviews': 9 }, 1150 + S),
    row('2026-09-13', 'bea@simple.biz', { 'catalog:bonus_in': true, 'catalog:bonus_in:Signups': 6 }, 1500 + S),
    row('2026-09-06', 'ann@simple.biz', { signed_rep_docs: 2, five_star_reviews: 8 }, 1300 + S),
    row('2026-09-06', 'bea@simple.biz', { signed_rep_docs: 7 }, 1750 + S),
    // A monthly row is not a week's KPI.
    row('2026-09-01', 'ann@simple.biz', { signed_rep_docs: 40 }, 9999 + S, 'monthly'),
  ];
  const data = build(ENTRIES, 'intake_specialist', [INTAKE_LIB]);

  it('is available, All-only, and labels every KPI item it found', () => {
    assert.equal(data.available, true);
    assert.equal(data.allOnly, true);
    assert.deepEqual(
      data.metrics.map((m) => [m.label, m.shown]),
      [
        ['5-Star Reviews', true],
        ['Reviews', true],
        ['Signed Rep Docs', true],
        ['Signups', true],
      ],
    );
    assert.ok(data.metrics.every((m) => m.team === false));
  });

  it('weekly rows only: the monthly row is in no week', () => {
    assert.deepEqual(data.weeks.map((w) => w.periodStart), ['2026-09-13', '2026-09-06']);
  });

  it('no entry ≠ 0, and the on/off flag and booleans are never counted', () => {
    const w13 = data.weeks[0]!;
    const beaRow = w13.rows.find((r) => r.email === 'bea@simple.biz')!;
    assert.deepEqual(beaRow.counts, { signups: 6 }, 'Bea has no Reviews entry that week, and the flag is no KPI');
  });

  it('ranks on the STORED amount — Bea first with fewer items (the order is the bonus)', () => {
    const order = buildMoneyOrder({
      moneyWeeks: data.moneyWeeks,
      metrics: [],
      members: [ann, bea],
      days: null,
      basis: 'weekly',
      todayIso: '2026-09-26',
    });
    const payload = toClientPayload(data, order, '2026-09-13');
    const lb = computeLeaderboard({
      weeks: projectDeliverableWeeks(payload.weeks, ALL_METRIC),
      days: [],
      members: [ann, bea],
      basis: 'weekly',
      window: 'all',
      todayIso: '2026-09-26',
    });
    assert.deepEqual(lb.rows.map((r) => r.name), ['Ann', 'Bea'], 'by counts Ann would lead (20 vs 13 items)');
    const shown = applyMoneyOrder(lb.rows, payload.order, 'all', ALL_METRIC);
    assert.deepEqual(shown.rows.map((r) => [r.position, r.name]), [
      [1, 'Bea'],
      [2, 'Ann'],
    ]);
    assert.equal(shown.unplaced, 0);
    assert.deepEqual(Object.keys(order.positions.all), [ALL_METRIC], 'All is the only order');
    assert.deepEqual(weekRankLookup(payload.order, ann, ALL_METRIC)?.('2026-09-13'), { position: 2, ranked: 2 });
  });

  it('the payload carries no stored amount, no formula and no rate', () => {
    const order = buildMoneyOrder({ moneyWeeks: data.moneyWeeks, metrics: [], members: [ann, bea], days: null, basis: 'weekly', todayIso: '2026-09-26' });
    const json = JSON.stringify(toClientPayload(data, order, '2026-09-13'));
    assert.match(json, /"allOnly":true/);
    assert.doesNotMatch(json, /amount|money|formula|calculated|total|\.37/i);
    for (const n of ['1150', '1500', '1300', '1750', '9999', '250', '100']) {
      assert.ok(!new RegExp(`\\b${n}\\b`).test(json), `peso figure or rate ${n} leaked into the payload`);
    }
  });
});

describe('buildHslKpiData — the live branch shapes', () => {
  it("Medical Records: portal logins shown, the manual RFC (pesos) order-only", () => {
    const mr = build([row('2026-09-13', 'ann@simple.biz', { portal_login: 4, rfc_form: 350 }, 750 + S)], 'medical_records');
    assert.deepEqual(
      mr.metrics.map((m) => [m.label, m.shown]),
      [
        ['Patient Portal Log Ins', true],
        ['RFC', false],
      ],
    );
    const json = JSON.stringify(toClientPayload(mr, null, '2026-09-13'));
    assert.doesNotMatch(json, /\b350\b/, 'the manual RFC amount is pesos and never leaves');
  });

  it('Attestation: the retired code KPI and its Library successor with the SAME name are one item', () => {
    const at = build(
      [
        row('2026-09-06', 'ann@simple.biz', { attested_cases: 30 }, 1500 + S),
        row('2026-09-13', 'ann@simple.biz', { 'catalog:bonus_at': true, 'catalog:bonus_at:Attested_Cases': 41 }, 3075 + S),
      ],
      'attestation',
      // The live Attestation formula (measured 2026-09-28).
      [
        {
          id: 'bonus_at',
          kind: 'formula',
          formula:
            '=IF(Attested_Cases>=50,Attested_Cases*100,IF(Attested_Cases>=35,Attested_Cases*75,IF(Attested_Cases>=25,Attested_Cases*50,0))) +(Referral_Leads*250) + (SSA_gov*250)',
        },
      ],
    );
    assert.equal(at.metrics.length, 1);
    assert.equal(at.metrics[0]!.label, 'Attested Cases');
    const key = at.metrics[0]!.key;
    assert.deepEqual(at.weeks.map((w) => w.rows[0]!.counts[key]), [41, 30]);
  });

  it("Filing: the live formula's (BBB + Referral_Leads) * 250 and Filed_Cases * IF(…) fail closed to order-only; PPL shows", () => {
    const FILING: HslCatalogDef = {
      id: 'bonus_fi',
      kind: 'formula',
      formula: 'Filed_Cases * IF(Filed_Cases >= 40, 100, IF(Filed_Cases >= 30, 75, IF(Filed_Cases >= 20, 50, 0))) + PPL* 100 + (BBB + Referral_Leads) * 250',
    };
    const fi = build(
      [row('2026-09-13', 'ann@simple.biz', { 'catalog:bonus_fi:Filed_Cases': 24, 'catalog:bonus_fi:PPL': 3, 'catalog:bonus_fi:BBB': 1 }, 1550 + S)],
      'filing_specialist',
      [FILING],
    );
    assert.deepEqual(
      fi.metrics.map((m) => [m.label, m.shown]),
      [
        ['BBB', false],
        ['Filed Cases', false],
        ['PPL', true],
      ],
    );
  });

  it('SSD (only its sub-team stored) and Managers Weekly (bespoke bands) get no board', () => {
    assert.equal(build([row('2026-09-13', 'ann@simple.biz', { sub_team: 'BLUE' }, 900 + S)], 'ssd_medical_records').available, false);
    assert.equal(
      build([row('2026-09-13', 'ann@simple.biz', { signups_weekly: 120, csm_9000: true }, 5000 + S)], 'hsl_managers').available,
      false,
    );
  });

  it('a row with a stored amount but no KPI item still ranks on All (a saved row is an entry)', () => {
    const d = build(
      [
        row('2026-09-13', 'ann@simple.biz', { signed_rep_docs: 2 }, 500 + S),
        row('2026-09-13', 'bea@simple.biz', { 'catalog:bonus_in': true }, 800 + S),
      ],
      'intake_specialist',
      [INTAKE_LIB],
    );
    assert.deepEqual(d.weeks[0]!.rows.map((r) => r.email).sort(), ['ann@simple.biz', 'bea@simple.biz']);
  });
});

describe('who is ranked: the HSL FAMILY roster, not the sub-team placement', () => {
  it('a scorer placed on another HSL sub-team matches (Medical Records: 47 of 64 are placed in SSD)', () => {
    assert.equal(departmentMatchesManagedAssignments('hsl:ssd_medical_records', ['hsl:medical_records']), true);
    assert.equal(departmentMatchesManagedAssignments('HSL', ['hsl:medical_records']), true);
  });

  it('a person placed outside HSL does not (Lead Gen doing HSL work is not on this roster)', () => {
    assert.equal(departmentMatchesManagedAssignments('Lead Gen', ['hsl:medical_records']), false);
  });
});
