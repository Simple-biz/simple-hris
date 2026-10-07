/**
 * Run: node --import tsx --test src/lib/accounting-scoreboard/team-score.test.ts
 *
 * Carla's "Team Score & Overview Edits Spec" (2026-10-07), its worked example (the week of Oct 5–9, on
 * Wednesday's numbers) and its edge cases. The example's numbers are the live board's on 10-07, read
 * through readBoard() (read-only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardScore, cycleCardScore, teamLight, teamScore, type TeamCard } from './team-score';
import { goalLight } from './stoplight';
import { resolveSections, sectionDef, type GoalRule, type SectionKey } from './sections';

const goal = (k: SectionKey): GoalRule => sectionDef(k).goal!;
const disputes8: GoalRule = { value: 8, direction: 'at_least', measure: 'score', unit: 'score' }; // Carla set 8 on 10-07
const WED = 0.4; // Mon and Tue are over

const r1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

test("card scores: Carla's worked example, Wednesday Oct 7", () => {
  assert.equal(cardScore(goal('buckets'), 7.4, WED).score, 92.5);
  assert.equal(cardScore(goal('collections'), 90, WED).score, 100);
  assert.equal(cardScore(goal('pm_buckets'), 29.33, WED).score, 100);
  assert.equal(cardScore(goal('inbox'), 9.796, WED).score, 100);
  assert.equal(cardScore(disputes8, 2.5, WED).score, 31.25);
  assert.equal(cardScore(goal('chargeback_outcomes'), 0, WED).score, 0);
  assert.equal(cardScore(goal('compliance'), 13, WED).score, 100, '13 done against a pace goal of 12');
  assert.equal(cycleCardScore({ start: 'on_time', close: 'pending' }).score, 100, 'started 11:59 AM, close still ahead');
});

test('Payroll Problems is paced like its light (CHOSEN): 9 by Wednesday is 8 ÷ 9 = 88.9, not 100', () => {
  const problems = goal('payroll_problems');
  assert.equal(r1(cardScore(problems, 9, WED).score), 88.9);
  assert.equal(goalLight(problems, 9, WED), 'amber', 'the card says Close, so the score is not 100');
  assert.equal(cardScore(problems, 9, 1).score, 100, 'a finished week with 9 is under 20: 100');
});

test('Team Score: groups average their cards, Chargebacks counts once, every group weighs 1', () => {
  const problems = goal('payroll_problems');
  const cards = (problemsScore: number): TeamCard[] => [
    { groupId: 'buckets', groupLabel: 'Buckets', card: cardScore(goal('buckets'), 7.4, WED) },
    { groupId: 'collections', groupLabel: 'Collections', card: cardScore(goal('collections'), 90, WED) },
    { groupId: 'pm_buckets', groupLabel: 'PM Buckets', card: cardScore(goal('pm_buckets'), 29.33, WED) },
    { groupId: 'onboarding', groupLabel: 'Sales Onboarding', card: cardScore(undefined, 42, WED) },
    { groupId: 'onboarding', groupLabel: 'Sales Onboarding', card: cardScore(undefined, null, WED) },
    { groupId: 'inbox', groupLabel: 'Inbox', card: cardScore(goal('inbox'), 9.796, WED) },
    { groupId: 'chargebacks', groupLabel: 'Chargebacks', card: cardScore(disputes8, 2.5, WED) },
    { groupId: 'chargebacks', groupLabel: 'Chargebacks', card: cardScore(goal('chargeback_outcomes'), 0, WED) },
    { groupId: 'compliance', groupLabel: 'Compliance', card: cardScore(goal('compliance'), 13, WED) },
    { groupId: 'payroll_timing', groupLabel: 'Payroll Timing', card: cycleCardScore({ start: 'on_time', close: 'pending' }) },
    { groupId: 'payroll_problems', groupLabel: 'Payroll Problems', card: cardScore(problems, problemsScore, WED) },
  ];
  const t = teamScore(cards(9));
  assert.equal(t.groups.length, 8, 'Sales Onboarding has no goal, so it drops out');
  assert.equal(r1(t.groups.find((g) => g.groupId === 'chargebacks')!.score), 15.6);
  assert.equal(t.groups.find((g) => g.groupId === 'chargebacks')!.cards, 2);
  assert.equal(t.score, 87.1, "(92.5 + 100 + 100 + 100 + 15.6 + 100 + 100 + 88.9) ÷ 8; Carla's 88.5 used 100 for Problems");
  assert.equal(t.light, 'amber');
  // With Problems at 100 (a finished week, or no problems logged), it is Carla's own 88.5.
  const carla = teamScore(cards(0));
  assert.equal(carla.score, 88.5);
  assert.deepEqual(
    t.groups.map((g) => g.label),
    ['Buckets', 'Collections', 'PM Buckets', 'Inbox', 'Chargebacks', 'Compliance', 'Payroll Timing', 'Payroll Problems'],
    'tab order',
  );
});

test('edge cases: no data and no goal are left out, never 0; divide by zero; Monday', () => {
  assert.deepEqual(cardScore(goal('buckets'), null, WED), { score: null, reason: 'waiting' });
  assert.deepEqual(cardScore(undefined, 12, WED), { score: null, reason: 'no_goal' });
  assert.deepEqual(cardScore({ ...goal('collections'), value: 0 }, 12, WED), { score: null, reason: 'no_goal' }, 'an at-least-0 goal is no goal');
  assert.equal(cardScore(goal('payroll_problems'), 0, WED).score, 100, 'lower is better and 0: 100');
  assert.equal(cardScore(goal('pm_buckets'), 0, WED).score, 100);
  // Monday: nothing is over, so a running total under its full goal has no pace goal yet ("No call yet").
  assert.deepEqual(cardScore(goal('collections'), 40, 0), { score: null, reason: 'too_early' });
  assert.equal(cardScore(goal('collections'), 90, 0).score, 100, 'already past the full goal');
  assert.deepEqual(cardScore(goal('payroll_problems'), 5, 0), { score: null, reason: 'too_early' });
  assert.equal(cardScore(goal('payroll_problems'), 25, 0).score, 80, 'over the full goal on day one: 20 ÷ 25');
  assert.equal(cardScore(goal('buckets'), 4, 0).score, 50, 'a score is never paced');
  // A group with no scored card drops out; nothing scored at all = no Team Score.
  assert.deepEqual(teamScore([{ groupId: 'a', groupLabel: 'A', card: cardScore(goal('buckets'), null, WED) }]), {
    score: null,
    light: 'none',
    groups: [],
  });
});

test('card scores are capped at 100 and agree with the light (green = 100; amber ≥ 80 for at-least goals)', () => {
  const c = goal('collections');
  for (const [v, p] of [[51, 0.6], [45, 0.6], [30, 0.6], [85, 1], [70, 1], [60, 1]] as const) {
    const s = cardScore(c, v, p).score!;
    const light = goalLight(c, v, p);
    assert.ok(s <= 100);
    assert.equal(light === 'green', s === 100, `${v} at ${p}: ${light} vs ${s}`);
    if (light === 'amber') assert.ok(s >= 80 && s < 100);
    if (light === 'red') assert.ok(s < 80);
  }
  const problems = goal('payroll_problems');
  let prev = 101;
  for (const v of [1, 5, 8, 9, 12, 15, 19, 20, 21, 30]) {
    const s = cardScore(problems, v, WED).score!;
    assert.ok(s <= prev, `more problems never score higher (${v}: ${s})`);
    prev = s;
  }
});

test('Payroll Timing: the share of judged checks on time, weighted 25 / 75; nothing judged is left out', () => {
  assert.equal(cycleCardScore({ start: 'late', close: 'pending' }).score, 0);
  assert.equal(cycleCardScore({ start: 'missed', close: 'pending' }).score, 0);
  assert.equal(cycleCardScore({ start: 'on_time', close: 'late' }).score, 25, 'the cycle score itself');
  assert.equal(cycleCardScore({ start: 'late', close: 'on_time' }).score, 75);
  assert.equal(cycleCardScore({ start: 'on_time', close: 'on_time' }).score, 100);
  assert.deepEqual(cycleCardScore({ start: 'pending', close: 'pending' }), { score: null, reason: 'waiting' });
  assert.deepEqual(cycleCardScore({ start: 'no_record', close: 'no_record' }), { score: null, reason: 'waiting' }, 'never judged');
});

test("the Team Score's bands: 90–100 On track, 75–89.9 Close, below 75 Behind", () => {
  assert.equal(teamLight(100), 'green');
  assert.equal(teamLight(90), 'green');
  assert.equal(teamLight(89.9), 'amber');
  assert.equal(teamLight(75), 'amber');
  assert.equal(teamLight(74.9), 'red');
  assert.equal(teamLight(null), 'none');
});

test('a goal set later joins on its own: Sales — Payments with a goal is a scored group', () => {
  const payments = resolveSections([{ sectionKey: 'onboarding', enabled: true, goal: 40 }]).find((s) => s.key === 'onboarding')!;
  const t = teamScore([{ groupId: 'onboarding', groupLabel: 'Sales Onboarding', card: cardScore(payments.goal, 42, 1) }]);
  assert.equal(t.score, 100);
  assert.equal(t.groups[0].label, 'Sales Onboarding');
});
