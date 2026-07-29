import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findRateConsistencyIssues,
  hasBlockingRateIssue,
  totalRateShortfallPhp,
} from './paystub-rate-consistency';

// ── The bug this guards against ─────────────────────────────────────────────
// A Payroll Wizard pay statement for the Jul 19–25 2026 week read:
//
//     Regular Hours   40.00h × ₱225.00      ₱7,000.00
//     Overtime         4.14h × ₱337.50      ₱1,087.63
//     ...
//     TOTAL NET PAY                        ₱12,901.00
//
// 40 × 225 = ₱9,000, not ₱7,000. The amounts were computed at ₱175/h (from
// `employee_rate_history`, resolved as-of each day) while the displayed rate came
// from `employee_hourly_rates` (the current sheet, ₱225). The total tied out to
// the sum of the LINE AMOUNTS, so every downstream check passed and the ₱2,309.62
// shortfall shipped invisibly. These tests pin the detection.

const WEEK = { hours: { regular: 40, ot: 4.1434 } };

test('the real Jul 19–25 stub is flagged as an error on both hour lines', () => {
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 4.14 },
    ratesPhp: { regular: 225, ot: 337.5 },
    payPhp: { regular: 7000, ot: 1087.63 },
  });
  assert.equal(issues.length, 2);
  assert.equal(hasBlockingRateIssue(issues), true);

  const reg = issues.find((i) => i.line === 'regular')!;
  assert.equal(reg.severity, 'error');
  assert.equal(reg.payAtDisplayedRate, 9000);
  assert.equal(reg.actualPay, 7000);
  assert.equal(reg.deltaPhp, 2000); // positive = owed to the employee
  assert.equal(reg.impliedRate, 175); // exactly the stale history rate

  const ot = issues.find((i) => i.line === 'ot')!;
  assert.equal(ot.severity, 'error');
  assert.equal(ot.deltaPhp, 309.62);
});

test('the flagged shortfall totals the ₱2,309.62 actually owed', () => {
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 4.14 },
    ratesPhp: { regular: 225, ot: 337.5 },
    payPhp: { regular: 7000, ot: 1087.63 },
  });
  assert.equal(totalRateShortfallPhp(issues), 2309.62);
});

test('all three divergent staged weeks are caught, including the one already emailed', () => {
  // The real staged `paystub_dispatch_queue.payload` values for nathanr@simple.biz.
  // Every one shows rates_php 225/337.50 over amounts computed at 175/262.50.
  // The 07-12→18 stub was SENT (send_count=1) before anyone noticed.
  const weeks = [
    { week: '2026-07-05→07-11', regular: 40, ot: 1.515833, payReg: 7000, payOt: 397.91, short: 2113.68 },
    { week: '2026-07-12→07-18', regular: 40, ot: 1.864444, payReg: 7000, payOt: 489.42, short: 2139.83 },
    { week: '2026-07-19→07-25', regular: 40, ot: 4.143333, payReg: 7000, payOt: 1087.63, short: 2310.74 },
  ];
  let arrears = 0;
  for (const w of weeks) {
    const issues = findRateConsistencyIssues({
      hours: { regular: w.regular, ot: w.ot },
      ratesPhp: { regular: 225, ot: 337.5 },
      payPhp: { regular: w.payReg, ot: w.payOt },
    });
    assert.equal(issues.length, 2, `${w.week} should flag both lines`);
    assert.equal(hasBlockingRateIssue(issues), true, `${w.week} should block dispatch`);
    assert.equal(totalRateShortfallPhp(issues), w.short, `${w.week} shortfall`);
    arrears += totalRateShortfallPhp(issues);
  }
  assert.equal(round2(arrears), 6564.25); // total owed across the three weeks
});

test('a statement whose rate matches its amounts is clean', () => {
  // Same pay, but displaying the rate actually used.
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 4.1434 },
    ratesPhp: { regular: 175, ot: 262.5 },
    payPhp: { regular: 7000, ot: 1087.63 },
  });
  assert.deepEqual(issues, []);
});

test('a statement paid at the displayed 225 is clean', () => {
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 4.1434 },
    ratesPhp: { regular: 225, ot: 337.5 },
    payPhp: { regular: 9000, ot: 1398.38 },
  });
  assert.deepEqual(issues, []);
});

// ── Exact detection when the engine reports the rates it applied ──

test('a displayed rate absent from ratesPaid is an exact error, no tolerance guessing', () => {
  const issues = findRateConsistencyIssues({
    ...WEEK,
    ratesPhp: { regular: 225, ot: 337.5 },
    payPhp: { regular: 7000, ot: 1087.63 },
    ratesPaid: { regular: [175], ot: [262.5] },
  });
  assert.equal(issues.length, 2);
  assert.equal(issues[0].basis, 'rates-paid');
  assert.deepEqual(issues[0].ratesPaid, [175]);
  assert.match(issues[0].message, /computed at ₱175\.00\/h/);
});

test('a displayed rate present in ratesPaid is clean even when pay is a blend', () => {
  // Genuine mid-week change 175 → 225. Pay is a blend, but 225 WAS paid, and the
  // caller chose to display it. The exact signal must not false-positive here.
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 0 },
    ratesPhp: { regular: 225, ot: 337.5 },
    payPhp: { regular: 8000, ot: 0 },
    ratesPaid: { regular: [175, 225], ot: [262.5, 337.5] },
    hasMidPeriodChange: true,
  });
  assert.deepEqual(issues, []);
});

test('an exact ratesPaid conflict errors even during a mid-period change', () => {
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 0 },
    ratesPhp: { regular: 300, ot: 450 },
    payPhp: { regular: 8000, ot: 0 },
    ratesPaid: { regular: [175, 225], ot: [262.5, 337.5] },
    hasMidPeriodChange: true,
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error'); // not downgraded — 300 was never paid
});

// ── The two LEGITIMATE reasons pay ≠ hours × rate. Must not cry wolf. ──

test('HSL weekend premium lifts pay above hours × rate without being flagged', () => {
  // 40h at ₱200 = ₱8,000; 16 weekend hours earn +₱15/h = +₱240.
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 0 },
    ratesPhp: { regular: 200, ot: 300 },
    payPhp: { regular: 8240, ot: 0 },
    isHsl: true,
  });
  assert.deepEqual(issues, []);
});

test('an HSL employee paid BELOW the displayed rate is still flagged', () => {
  // The premium widens the overpayment side only — it must never mask a shortfall.
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 0 },
    ratesPhp: { regular: 225, ot: 337.5 },
    payPhp: { regular: 7000, ot: 0 },
    isHsl: true,
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error');
  assert.equal(issues[0].deltaPhp, 2000);
});

test('a mid-period rate change downgrades an inferred mismatch to a warning', () => {
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 0 },
    ratesPhp: { regular: 225, ot: 337.5 },
    payPhp: { regular: 8000, ot: 0 },
    hasMidPeriodChange: true,
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'warning');
  assert.equal(hasBlockingRateIssue(issues), false);
  assert.match(issues[0].message, /blended rate may be correct/);
});

// ── Absences are not mismatches ──

test('null rate, null pay, or zero hours produce no issues', () => {
  assert.deepEqual(
    findRateConsistencyIssues({
      hours: { regular: 40, ot: 0 },
      ratesPhp: { regular: null, ot: null },
      payPhp: { regular: null, ot: null },
    }),
    [],
  );
  // Bonus-only week: no hours, so no hours × rate claim to contradict.
  assert.deepEqual(
    findRateConsistencyIssues({
      hours: { regular: 0, ot: 0 },
      ratesPhp: { regular: 225, ot: 337.5 },
      payPhp: { regular: 0, ot: 0 },
    }),
    [],
  );
  // A zero displayed rate asserts nothing.
  assert.deepEqual(
    findRateConsistencyIssues({
      hours: { regular: 40, ot: 0 },
      ratesPhp: { regular: 0, ot: 0 },
      payPhp: { regular: 7000, ot: 0 },
    }),
    [],
  );
});

test('missing objects entirely are tolerated, never thrown on', () => {
  assert.deepEqual(findRateConsistencyIssues({ hours: null, ratesPhp: null, payPhp: null }), []);
  assert.deepEqual(
    findRateConsistencyIssues({} as Parameters<typeof findRateConsistencyIssues>[0]),
    [],
  );
});

test('sub-centavo rounding drift from per-day accumulation is not flagged', () => {
  // Per-day accrual rounds once at the end, so a cent or two of drift is expected.
  const issues = findRateConsistencyIssues({
    hours: { regular: 37.33, ot: 0 },
    ratesPhp: { regular: 225, ot: 337.5 },
    payPhp: { regular: round2(37.33 * 225) + 0.02, ot: 0 },
  });
  assert.deepEqual(issues, []);
});

test('a real shortfall just past the rounding tolerance IS flagged', () => {
  const issues = findRateConsistencyIssues({
    hours: { regular: 10, ot: 0 },
    ratesPhp: { regular: 225, ot: 337.5 },
    payPhp: { regular: 2249.9, ot: 0 }, // ₱0.10 short — beyond the ₱0.05 slack
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].deltaPhp, 0.1);
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
