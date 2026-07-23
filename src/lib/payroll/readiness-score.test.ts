import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeReadinessScore } from './readiness-score';

/**
 * The Payroll Readiness score is blocker-weighted (rate 50 / kpi 25 / bank 25;
 * exceptions excluded). These tests lock the three invariants that make the
 * number trustworthy on the dashboard:
 *   1. The component breakdown ALWAYS sums to the headline value.
 *   2. It only reads 100 / "ready" when every dimension is truly clear — a
 *      single open item (even 1-of-500) floors it below 100.
 *   3. Any missing rate is a hard blocker: rate pinned low, grade "blocked",
 *      total well below 100 regardless of proportion.
 */

const CLEAR = {
  workerCount: 100,
  missingRates: 0,
  kpiDue: 10,
  kpiSubmitted: 10,
  bankEligibleCount: 100,
  missingBank: 0,
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
    { workerCount: 100, missingRates: 0, kpiDue: 100, kpiSubmitted: 50, bankEligibleCount: 6, missingBank: 1 },
    { workerCount: 100, missingRates: 100, kpiDue: 10, kpiSubmitted: 0, bankEligibleCount: 100, missingBank: 100 },
    { workerCount: 0, missingRates: 0, kpiDue: 0, kpiSubmitted: 0, bankEligibleCount: 0, missingBank: 0 },
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
    assert.ok(s.value <= 60, `blocked score ${s.value} should be well below 100`);
  }
});

test('nothing-to-measure week reads 100 / ready (no false penalty)', () => {
  const s = computeReadinessScore({
    workerCount: 0,
    missingRates: 0,
    kpiDue: 0,
    kpiSubmitted: 0,
    bankEligibleCount: 0,
    missingBank: 0,
  });
  assert.equal(s.value, 100);
  assert.equal(s.grade, 'ready');
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
  });
  assert.ok(atRisk.value < 85);
  assert.equal(atRisk.grade, 'at_risk');
});
