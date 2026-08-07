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

// ── The weekend-line hole (2026-08-04) ───────────────────────────────────────
// A preview stub for the Jul 26 – Aug 1 2026 week read:
//
//     Regular Hours   31.90h × ₱355.00     ₱11,323.61
//     Overtime         4.50h × ₱532.50      ₱2,395.07
//     Weekend Hours    8.10h × ₱370.00      ₱1,944.60   <-- 8.10 × 370 = ₱2,997.00
//
// ₱1,944.60 is 8.1025 × ₱240 — a stale ₱225 base plus the ₱15 premium — while the
// label had refreshed to ₱370 (the corrected ₱355 base + ₱15). A ₱1,053.33 shortfall
// on a stub about to be sent, and this guard passed it, because it only inspected the
// `regular` and `ot` lines. The weekend carve-out renders its own hours × rate.

test('erjiee regression: the weekend line that shipped a ₱1,053.33 shortfall is flagged', () => {
  // These are the PAYLOAD values, not the rendered ones: `hours.regular` is the full
  // 40h cap and `pay_php.regular` already contains the weekend money. The stub's
  // "31.90h" line is derived later, by subtraction, in paystub-view.ts.
  //
  // Note `ratesPaid.regular = [355, 225]` — 355 for the weekdays, 225 for the Sunday
  // stranded on a stale rate. The regular line is CLEARED by the exact path because 355
  // genuinely was used; only the weekend line exposes the 225.
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 4.497777777777777 },
    ratesPhp: { regular: 355, ot: 532.5 },
    payPhp: { regular: 13268.21, ot: 2395.07 },
    ratesPaid: { regular: [355, 225], ot: [532.5] },
    isHsl: true,
    weekend: {
      hours: { regular: 8.1025, ot: 0 },
      payPhp: { regular: 1944.6, ot: 0 },
      premiumPhpPerHour: 15,
    },
  });
  const wk = issues.find((i) => i.line === 'weekend');
  assert.ok(wk, 'the weekend line must be flagged');
  assert.equal(wk.displayedRate, 370); // derived as 355 + 15, exactly what the stub shows
  assert.ok(
    Math.abs(wk.deltaPhp - 1053.33) < 0.02,
    `expected ≈₱1,053.33 shortfall, got ${wk.deltaPhp}`,
  );
  assert.equal(wk.severity, 'error');
  assert.equal(hasBlockingRateIssue(issues), true, 'this must BLOCK dispatch');
  // Regular and OT pass on their own terms — the weekend line is the only tell.
  assert.equal(issues.filter((i) => i.line === 'regular' || i.line === 'ot').length, 0);
});

test('the weekend check is NOT cleared by ratesPaid containing the displayed rate', () => {
  // The subtle hole: on the regular line, `ratesPaid` clears a mismatch whenever the
  // displayed rate appears among the rates used — even if only SOME hours used it. If
  // that logic were applied to the weekend line, [355,225] -> [370,240] would "contain"
  // the displayed 370 and silently clear the shortfall. It must not.
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 0 },
    ratesPhp: { regular: 355, ot: 532.5 },
    payPhp: { regular: 13268.21, ot: 0 },
    ratesPaid: { regular: [355, 225], ot: [] },
    isHsl: true,
    weekend: { hours: { regular: 8.1025 }, payPhp: { regular: 1944.6 }, premiumPhpPerHour: 15 },
  });
  assert.ok(
    issues.some((i) => i.line === 'weekend'),
    'ratesPaid must not be able to clear the weekend line',
  );
});

test('a correct weekend line passes', () => {
  // The same week paid properly: every day at ₱355, so the weekend hours earn ₱370.
  // pay_php.regular = 40h × 355 + 8.1025h × ₱15 premium = 14,200 + 121.54.
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 4.497777777777777 },
    ratesPhp: { regular: 355, ot: 532.5 },
    payPhp: { regular: 14321.54, ot: 2395.07 },
    ratesPaid: { regular: [355], ot: [532.5] },
    isHsl: true,
    weekend: {
      hours: { regular: 8.1025, ot: 0 },
      payPhp: { regular: 2997.93, ot: 0 }, // 8.1025 × 370
      premiumPhpPerHour: 15,
    },
  });
  assert.deepEqual(issues, []);
});

test('the weekend line gets NO ₱15/h overpayment headroom — the premium is already in its rate', () => {
  // On the regular line an HSL employee may legitimately be paid up to ₱15/h ABOVE
  // hours × rate. On the weekend line that same slack would hide the very bug above,
  // so it must not apply: pay ₱15/h over the weekend rate is a surplus, and flagged.
  const issues = findRateConsistencyIssues({
    hours: { regular: 0, ot: 0 },
    ratesPhp: { regular: 355, ot: 532.5 },
    payPhp: { regular: 0, ot: 0 },
    isHsl: true,
    weekend: {
      hours: { regular: 10, ot: 0 },
      payPhp: { regular: 10 * (370 + 15) }, // paid a SECOND premium on top
      premiumPhpPerHour: 15,
    },
  });
  const wk = issues.find((i) => i.line === 'weekend');
  assert.ok(wk, 'double-counted premium must be flagged, not absorbed as headroom');
  assert.equal(round2(wk.deltaPhp), -150);
});

test('the OT bucket of the merged weekend line is checked at otRate + premium', () => {
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 6 },
    ratesPhp: { regular: 355, ot: 532.5 },
    payPhp: { regular: 14200, ot: 3195 },
    isHsl: true,
    weekend: {
      hours: { regular: 0, ot: 6 },
      payPhp: { regular: 0, ot: 6 * 400 }, // should be 6 × 547.50
      premiumPhpPerHour: 15,
    },
  });
  const wk = issues.find((i) => i.line === 'weekend');
  assert.ok(wk);
  assert.equal(wk.displayedRate, 547.5); // 532.50 + 15 — matches the basis the stub shows
  assert.equal(round2(wk.deltaPhp), round2(6 * 547.5 - 6 * 400));
  // The statement has ONE weekend line — the message must carry its label.
  assert.match(wk.message, /^Weekend Hours:/);
});

test('both weekend buckets wrong → two issues, both on the merged Weekend Hours line', () => {
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 6 },
    ratesPhp: { regular: 355, ot: 532.5 },
    payPhp: { regular: 14200, ot: 3195 },
    isHsl: true,
    weekend: {
      hours: { regular: 4, ot: 6 },
      payPhp: { regular: 4 * 350, ot: 6 * 400 }, // should be 4 × 370 and 6 × 547.50
      premiumPhpPerHour: 15,
    },
  });
  const weekendIssues = issues.filter((i) => i.line === 'weekend');
  assert.equal(weekendIssues.length, 2, 'each bucket keeps its own tight arithmetic check');
  for (const i of weekendIssues) assert.match(i.message, /^Weekend Hours:/);
});

test('omitting the weekend block leaves behaviour exactly as before', () => {
  const base = {
    hours: { regular: 40, ot: 0 },
    ratesPhp: { regular: 225, ot: 337.5 },
    payPhp: { regular: 7000, ot: 0 },
  };
  const withoutWeekend = findRateConsistencyIssues(base);
  const withNullWeekend = findRateConsistencyIssues({ ...base, weekend: null });
  assert.equal(withoutWeekend.length, 1);
  assert.deepEqual(withNullWeekend, withoutWeekend);
});

test('a weekend block with no hours is not a mismatch', () => {
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 0 },
    ratesPhp: { regular: 355, ot: 532.5 },
    payPhp: { regular: 14200, ot: 0 },
    isHsl: true,
    weekend: { hours: { regular: 0, ot: 0 }, payPhp: { regular: 0, ot: 0 } },
  });
  assert.deepEqual(issues, []);
});

test('the weekend premium defaults to ₱15 when the payload omits it', () => {
  // Underpay the line so it flags, then read back the rate the guard derived: ₱305 base
  // + the default ₱15 = ₱320, which is what the statement would print.
  const issues = findRateConsistencyIssues({
    hours: { regular: 0, ot: 0 },
    ratesPhp: { regular: 305, ot: 457.5 },
    payPhp: { regular: 0, ot: 0 },
    isHsl: true,
    weekend: { hours: { regular: 4, ot: 0 }, payPhp: { regular: 4 * 300 } }, // should be 4 × 320
  });
  const wk = issues.find((i) => i.line === 'weekend');
  assert.ok(wk, 'an underpaid weekend line must flag');
  assert.equal(wk.displayedRate, 320); // 305 + 15 by default — premium omitted from payload
  assert.equal(round2(wk.deltaPhp), 80); // 4 × (320 − 300)
});

test('a correct weekend line passes with the premium omitted too', () => {
  const issues = findRateConsistencyIssues({
    hours: { regular: 0, ot: 0 },
    ratesPhp: { regular: 305, ot: 457.5 },
    payPhp: { regular: 0, ot: 0 },
    isHsl: true,
    weekend: { hours: { regular: 4, ot: 0 }, payPhp: { regular: 4 * 320 } },
  });
  assert.deepEqual(issues, []);
});

test('the total shortfall includes the weekend line', () => {
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 4.497777777777777 },
    ratesPhp: { regular: 355, ot: 532.5 },
    payPhp: { regular: 13268.21, ot: 2395.07 },
    ratesPaid: { regular: [355, 225], ot: [532.5] },
    isHsl: true,
    weekend: { hours: { regular: 8.1025 }, payPhp: { regular: 1944.6 }, premiumPhpPerHour: 15 },
  });
  assert.ok(
    Math.abs(totalRateShortfallPhp(issues) - 1053.33) < 0.02,
    `expected ≈₱1,053.33, got ${totalRateShortfallPhp(issues)}`,
  );
});

test('a mid-week rate change downgrades a weekend mismatch to a warning', () => {
  // A genuine dated change inside the week blends two rates, so one displayed weekend
  // rate legitimately may not reproduce the pay. Still surfaced — but not a blocker.
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 0 },
    ratesPhp: { regular: 355, ot: 532.5 },
    payPhp: { regular: 13268.21, ot: 0 },
    isHsl: true,
    hasMidPeriodChange: true,
    weekend: { hours: { regular: 8.1025 }, payPhp: { regular: 1944.6 }, premiumPhpPerHour: 15 },
  });
  const wk = issues.find((i) => i.line === 'weekend');
  assert.ok(wk);
  assert.equal(wk.severity, 'warning');
  assert.equal(hasBlockingRateIssue(issues.filter((i) => i.line === 'weekend')), false);
});

// ── Checking the rate the statement ACTUALLY displays (2026-08-07) ──────────
// The weekend check derives its displayed rate as `ratesPhp.regular + premium`.
// That is only the rate the stub shows when the weekend basis comes from the
// BUCKETS. When a mid-week change staged per-day weekend segments, the stub
// renders those instead — `weekendBasis` in paystub-view.ts prefers them — so
// the guard was validating a number nobody could see: it warned on reat@'s
// correct ₱250 line (against a phantom ₱240) and would have stayed silent had
// the ₱250 segment itself been wrong. Passing the segments closes both halves.

test('weekend segments: a correct off-headline weekend line is NOT flagged', () => {
  // reat@simple.biz, cycle 2026-07-26 → 08-01. Rate cut ₱235 → ₱225 effective
  // Mon Jul 27; she worked only Sunday Jul 26, so the weekend paid ₱235 + ₱15.
  // 8.098 × 250 = ₱2,024.51 — the line reconciles exactly at what it displays.
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 1.6797 },
    ratesPhp: { regular: 225, ot: 337.5 },
    payPhp: { regular: 9202.45, ot: 566.91 },
    isHsl: true,
    hasMidPeriodChange: true,
    weekend: {
      hours: { regular: 8.0981, ot: 0 },
      payPhp: { regular: 2024.51, ot: 0 },
      premiumPhpPerHour: 15,
      segments: {
        regular: [{ ratePhp: 235, hours: 8.0981, payPhp: 2024.51 }],
        ot: [],
      },
    },
  });
  assert.deepEqual(
    issues.filter((i) => i.line === 'weekend'),
    [],
    'the displayed ₱250 basis reproduces the pay — nothing to report',
  );
});

test('weekend segments: a segment whose own arithmetic is wrong IS flagged', () => {
  // Same shape, but the money is short of what the ₱250 line advertises.
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 0 },
    ratesPhp: { regular: 225, ot: 337.5 },
    payPhp: { regular: 9000, ot: 0 },
    isHsl: true,
    hasMidPeriodChange: true,
    weekend: {
      hours: { regular: 8, ot: 0 },
      payPhp: { regular: 1920, ot: 0 },
      premiumPhpPerHour: 15,
      segments: {
        // Displays 8h @ ₱250 = ₱2,000 but only ₱1,920 was paid.
        regular: [{ ratePhp: 235, hours: 8, payPhp: 1920 }],
        ot: [],
      },
    },
  });
  const wk = issues.find((i) => i.line === 'weekend');
  assert.ok(wk, 'the segment the employee can see must be checked');
  assert.equal(wk.displayedRate, 250);
  assert.equal(wk.deltaPhp, 80);
});

test('weekend segments: each segment is checked on its own, not netted', () => {
  // A shortfall on one rate must not hide behind a surplus on another.
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 0 },
    ratesPhp: { regular: 225, ot: 337.5 },
    payPhp: { regular: 9000, ot: 0 },
    isHsl: true,
    weekend: {
      hours: { regular: 8, ot: 0 },
      payPhp: { regular: 2000, ot: 0 },
      premiumPhpPerHour: 15,
      segments: {
        regular: [
          { ratePhp: 235, hours: 4, payPhp: 920 }, // shows 4h @ ₱250 = ₱1,000
          { ratePhp: 225, hours: 4, payPhp: 1080 }, // shows 4h @ ₱240 = ₱960
        ],
        ot: [],
      },
    },
  });
  const wk = issues.filter((i) => i.line === 'weekend');
  assert.equal(wk.length, 2, 'both segments reported, neither netted away');
  assert.equal(wk[0].displayedRate, 250);
  assert.equal(wk[0].deltaPhp, 80);
  assert.equal(wk[1].displayedRate, 240);
  assert.equal(wk[1].deltaPhp, -120);
});

test('weekend segments: empty segments fall back to the bucket check', () => {
  // No staged segments (single-rate week) → behaviour is exactly as before.
  const issues = findRateConsistencyIssues({
    hours: { regular: 40, ot: 0 },
    ratesPhp: { regular: 225, ot: 337.5 },
    payPhp: { regular: 9000, ot: 0 },
    isHsl: true,
    weekend: {
      hours: { regular: 8, ot: 0 },
      payPhp: { regular: 1800, ot: 0 },
      premiumPhpPerHour: 15,
      segments: { regular: [], ot: [] },
    },
  });
  const wk = issues.find((i) => i.line === 'weekend');
  assert.ok(wk);
  assert.equal(wk.displayedRate, 240);
  assert.equal(wk.deltaPhp, 120);
});
