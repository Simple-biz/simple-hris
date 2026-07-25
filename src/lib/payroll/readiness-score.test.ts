import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeReadinessScore } from './readiness-score';

/**
 * The Payroll Readiness score is blocker-weighted (rate 50 / kpi 25 / bank 25;
 * exceptions excluded). These tests lock the four invariants that make the
 * number trustworthy on the dashboard:
 *   1. The component breakdown ALWAYS sums to the headline value.
 *   2. It only reads 100 / "ready" when every dimension is truly clear — a
 *      single open item (even 1-of-500) floors it below 100.
 *   3. Any missing rate is a hard blocker: rate pinned low, grade "blocked",
 *      total well below 100 regardless of proportion.
 *   4. Any missing-bank person ON THIS WEEK'S PAYROLL is a hard blocker too
 *      (they will not get paid): bank pinned low, grade "blocked" — a big
 *      roster can never dilute a payday failure back up to the 90s.
 */

const CLEAR = {
  workerCount: 100,
  missingRates: 0,
  kpiDue: 10,
  kpiSubmitted: 10,
  bankEligibleCount: 100,
  missingBank: 0,
  missingBankOnPayroll: 0,
};

test('fully clear → 100 / ready, every dimension at its max', () => {
  const s = computeReadinessScore(CLEAR);
  assert.equal(s.value, 100);
  assert.equal(s.grade, 'ready');
  const byKey = Object.fromEntries(s.components.map((c) => [c.key, c]));
  assert.equal(byKey.rate.points, 50);
  assert.equal(byKey.kpi.points, 25);
  assert.equal(byKey.bank.points, 25);
});

test('the breakdown always reconciles to the headline value', () => {
  const cases = [
    CLEAR,
    { ...CLEAR, missingRates: 1 },
    { ...CLEAR, missingRates: 1, workerCount: 500 },
    { ...CLEAR, kpiSubmitted: 5 },
    { ...CLEAR, bankEligibleCount: 200, missingBank: 1 },
    { ...CLEAR, bankEligibleCount: 200, missingBank: 40, missingBankOnPayroll: 12 },
    { ...CLEAR, missingRates: 3, bankEligibleCount: 200, missingBank: 40, missingBankOnPayroll: 12 },
    { ...CLEAR, kpiDue: 100, kpiSubmitted: 50, bankEligibleCount: 6, missingBank: 1 },
    { ...CLEAR, missingRates: 100, kpiDue: 10, kpiSubmitted: 0, missingBank: 100, missingBankOnPayroll: 100 },
    { ...CLEAR, workerCount: 0, kpiDue: 0, kpiSubmitted: 0, bankEligibleCount: 0 },
  ];
  for (const c of cases) {
    const s = computeReadinessScore(c);
    const sum = s.components.reduce((acc, comp) => acc + comp.points, 0);
    assert.equal(sum, s.value, `breakdown ${sum} must equal value ${s.value} for ${JSON.stringify(c)}`);
  }
});

test('one open item never rounds back up to 100 / ready', () => {
  // 1 missing bank of 200 — proportionally tiny, must NOT read 100.
  const bank = computeReadinessScore({ ...CLEAR, workerCount: 10, bankEligibleCount: 200, missingBank: 1 });
  assert.ok(bank.value < 100, `expected < 100, got ${bank.value}`);
  assert.equal(bank.value, 99);
  assert.notEqual(bank.grade, 'ready');

  // 199 of 200 KPI depts submitted — same trap on the KPI axis.
  const kpi = computeReadinessScore({ ...CLEAR, kpiDue: 200, kpiSubmitted: 199 });
  assert.ok(kpi.value < 100, `expected < 100, got ${kpi.value}`);
  assert.notEqual(kpi.grade, 'ready');
});

test('any missing rate is a hard blocker regardless of proportion', () => {
  for (const workerCount of [100, 500, 5]) {
    const s = computeReadinessScore({ ...CLEAR, workerCount, missingRates: 1 });
    assert.equal(s.grade, 'blocked');
    const rate = s.components.find((c) => c.key === 'rate')!;
    assert.ok(rate.points <= 10, `rate points ${rate.points} should be pinned low for a blocker`);
    assert.equal(rate.blockerOpen, 1);
    assert.ok(s.value <= 60, `blocked score ${s.value} should be well below 100`);
  }
});

test('missing bank ON PAYROLL is a hard blocker: pinned, blocked, never diluted', () => {
  // One unpayable person with hours this week blocks, however big the roster.
  for (const bankEligibleCount of [100, 1000, 5]) {
    const s = computeReadinessScore({
      ...CLEAR,
      bankEligibleCount,
      missingBank: 1,
      missingBankOnPayroll: 1,
    });
    assert.equal(s.grade, 'blocked');
    const bank = s.components.find((c) => c.key === 'bank')!;
    assert.ok(bank.points <= 5, `bank points ${bank.points} should be pinned low for a blocker`);
    assert.equal(bank.blockerOpen, 1);
    assert.ok(s.value <= 80, `bank-blocked score ${s.value} should cap at 80`);
  }
});

test('the 2026-07 miscalibration: 225 missing of 1091 (156 on payroll) can no longer read 94', () => {
  // The live numbers that scored 94/100 "almost" while 156 people on the
  // week's payroll had no payout rail. Now: bank pinned to 5 → 80 "blocked".
  const s = computeReadinessScore({
    workerCount: 1000,
    missingRates: 0,
    kpiDue: 10,
    kpiSubmitted: 10,
    bankEligibleCount: 1091,
    missingBank: 225,
    missingBankOnPayroll: 156,
  });
  assert.equal(s.value, 80);
  assert.equal(s.grade, 'blocked');
  const bank = s.components.find((c) => c.key === 'bank')!;
  assert.equal(bank.points, 5);
  assert.equal(bank.blockerOpen, 156);
});

test('roster-hygiene missing bank (none on payroll) stays proportional, not blocked', () => {
  // Same 225-missing roster but nobody being paid this week is affected:
  // proportional credit applies and the grade bands by value, as before.
  const s = computeReadinessScore({
    ...CLEAR,
    bankEligibleCount: 1091,
    missingBank: 225,
    missingBankOnPayroll: 0,
  });
  assert.equal(s.value, 94); // 50 + 25 + floor(0.7938 × 25) = 19
  assert.equal(s.grade, 'almost');
  assert.equal(s.components.find((c) => c.key === 'bank')!.blockerOpen, 0);
});

test('payroll-overlap larger than the missing list is clamped (caller bug guard)', () => {
  const s = computeReadinessScore({
    ...CLEAR,
    bankEligibleCount: 100,
    missingBank: 2,
    missingBankOnPayroll: 5,
  });
  const bank = s.components.find((c) => c.key === 'bank')!;
  assert.equal(bank.blockerOpen, 2);
  assert.equal(s.grade, 'blocked');
});

test('nothing-to-measure week reads 100 / ready (no false penalty)', () => {
  const s = computeReadinessScore({
    workerCount: 0,
    missingRates: 0,
    kpiDue: 0,
    kpiSubmitted: 0,
    bankEligibleCount: 0,
    missingBank: 0,
    missingBankOnPayroll: 0,
  });
  assert.equal(s.value, 100);
  assert.equal(s.grade, 'ready');
});

test('per-dimension percent: 100 only when clear, floored when anything is open', () => {
  // Fully clear → every dimension reads exactly 100%.
  for (const c of computeReadinessScore(CLEAR).components) {
    assert.equal(c.percent, 100, `${c.key} should read 100% when clear`);
  }

  // 1 missing bank of 500 — proportionally ~99.8%, must floor to 99, not 100.
  const bank = computeReadinessScore({ ...CLEAR, bankEligibleCount: 500, missingBank: 1 });
  const bankComp = bank.components.find((c) => c.key === 'bank')!;
  assert.equal(bankComp.percent, 99);

  // Setting that last bank account flips the dimension to a clean 100%.
  const fixed = computeReadinessScore({ ...CLEAR, bankEligibleCount: 500, missingBank: 0 });
  assert.equal(fixed.components.find((c) => c.key === 'bank')!.percent, 100);

  // Percent tracks coverage: 5 of 10 KPI depts submitted → 50%.
  const kpi = computeReadinessScore({ ...CLEAR, kpiSubmitted: 5 });
  assert.equal(kpi.components.find((c) => c.key === 'kpi')!.percent, 50);

  // Everything missing → 0%, and percent always stays within [0,100].
  const worst = computeReadinessScore({
    workerCount: 100,
    missingRates: 100,
    kpiDue: 10,
    kpiSubmitted: 0,
    bankEligibleCount: 100,
    missingBank: 100,
    missingBankOnPayroll: 100,
  });
  for (const c of worst.components) {
    assert.equal(c.percent, 0, `${c.key} should read 0% when fully missing`);
  }
});

test('value stays within [0,100] and grades band correctly with no blockers', () => {
  const halfKpi = computeReadinessScore({ ...CLEAR, kpiSubmitted: 5 }); // kpi 12/25
  assert.ok(halfKpi.value >= 0 && halfKpi.value <= 100);
  assert.equal(halfKpi.grade, 'almost'); // 87 → ≥85
  const atRisk = computeReadinessScore({
    workerCount: 100,
    missingRates: 0,
    kpiDue: 100,
    kpiSubmitted: 50,
    bankEligibleCount: 6,
    missingBank: 1,
    missingBankOnPayroll: 0,
  });
  assert.ok(atRisk.value < 85);
  assert.equal(atRisk.grade, 'at_risk');
});
