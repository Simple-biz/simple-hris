/**
 * Pins the step-6 PAB review's severity column to the engine that actually pays.
 *
 * The load-bearing property is an IDENTITY: `severity === 0` must mean exactly
 * membership in `computePabEligibleEmails`. The severity number is allowed to be
 * richer than the engine's boolean — that is the whole point of it — but it is
 * never allowed to DISAGREE about who passed.
 *
 * **If the identity test fails, PAB money has moved.** The review table would be
 * telling an accountant someone is fine while dispatch pays them nothing, or
 * offering a Forgive button to someone who never needed one. Same alarm as
 * `pab-calendar-sun-sat-display.test.ts`.
 *
 * Run: npx tsx --test src/lib/payroll/pab-ineligibility.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeHslWeekInfo,
  computePabIneligibility,
  hslCoverageStart,
  hslWeekStartIso,
  pabSeverityBand,
  type PabDayEntry,
} from './pab-ineligibility';
import { computePabEligibleEmails, getHslAdjustedEnd } from './dispatch-bonuses';

const H7 = 7 * 3600;

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Inclusive day walk. */
function eachDay(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  while (cur.getTime() <= end.getTime()) {
    out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/**
 * Build the two shapes the engine and this module each need from ONE source of
 * truth, so a fixture can never feed them different data — which would make the
 * identity test pass for the wrong reason.
 */
function fixture(
  start: Date,
  end: Date,
  secondsFor: (d: Date) => number,
  opts: { isHsl: boolean },
): { row: Record<string, string>; entries: PabDayEntry[] } {
  const row: Record<string, string> = { Email: 'x@simple.biz' };
  const entries: PabDayEntry[] = [];
  // The engine reads the whole Hubstaff row. It must cover at least everything
  // EITHER side evaluates, or the fixture — not the code — decides the verdict.
  // A week short on the row's far edge fails the engine while the entries pass.
  const rowFrom = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 10);
  const rowTo = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 10);
  for (const d of eachDay(rowFrom, rowTo)) {
    const sec = secondsFor(d);
    row[iso(d)] = String(sec / 3600);
  }
  // The evaluated window, NOT the PAB period: HSL anchors back to the Sunday
  // on/before the start and runs to the adjusted end. Supplying only
  // [start, end] is the under-coverage bug the module documents.
  const coverStart = hslCoverageStart(start, opts.isHsl, true);
  const coverEnd = opts.isHsl ? getHslAdjustedEnd(end, 'sun_sat') : end;
  for (const d of eachDay(coverStart, coverEnd)) {
    const dow = d.getDay();
    if (!opts.isHsl && (dow === 0 || dow === 6)) continue;
    const sec = secondsFor(d);
    entries.push({
      iso: iso(d),
      seconds: sec,
      passes: sec >= H7,
      forgivenByDispute: false,
      forgivenByHoliday: false,
    });
  }
  return { row, entries };
}

/** The live 2026-08 override, the 2026-07 override, and a default month. */
const RANGES: { label: string; start: Date; end: Date }[] = [
  { label: '2026-08 override (Sun Aug 2 → Sat Aug 29)', start: new Date(2026, 7, 2), end: new Date(2026, 7, 29) },
  { label: '2026-07 override (Mon Jul 6 → Fri Jul 31)', start: new Date(2026, 6, 6), end: new Date(2026, 6, 31) },
  { label: '2026-06 (Mon Jun 1 → Tue Jun 30)', start: new Date(2026, 5, 1), end: new Date(2026, 5, 30) },
];

/** Deterministic hour patterns, from "never misses" to "misses constantly". */
const PATTERNS: { label: string; secondsFor: (d: Date) => number }[] = [
  { label: 'always full', secondsFor: () => H7 + 600 },
  { label: 'one short Tuesday', secondsFor: (d) => (d.getDay() === 2 && d.getDate() < 10 ? 5 * 3600 : H7) },
  { label: 'every Friday short', secondsFor: (d) => (d.getDay() === 5 ? 3 * 3600 : H7) },
  { label: 'two weekdays off per week', secondsFor: (d) => (d.getDay() === 2 || d.getDay() === 4 ? 0 : H7 + 300) },
  { label: 'weekends worked, one weekday missed', secondsFor: (d) => (d.getDay() === 3 ? 0 : H7 + 900) },
  { label: 'nothing at all', secondsFor: () => 0 },
];

for (const hsl of [false, true]) {
  test(`severity 0 === computePabEligibleEmails (${hsl ? 'HSL' : 'non-HSL'})`, () => {
    const weekModel = 'sun_sat' as const;
    let sawEligible = false;
    let sawIneligible = false;

    for (const { label: rangeLabel, start, end } of RANGES) {
      for (const { label: patLabel, secondsFor } of PATTERNS) {
        const { row, entries } = fixture(start, end, secondsFor, { isHsl: hsl });
        const hslAdjustedEnd = getHslAdjustedEnd(end, weekModel);

        const engineEligible = computePabEligibleEmails({
          rows: [row],
          pabRange: { start, end },
          pabRangeSunSat: { start, end },
          hslAdjustedEnd,
          hslEmails: hsl ? new Set(['x@simple.biz']) : new Set(),
          weekModel,
        }).has('x@simple.biz');

        const { severity } = computePabIneligibility({
          entries,
          isHsl: hsl,
          hslSunSat: true,
          periodStart: start,
          periodEnd: hsl ? hslAdjustedEnd : end,
        });

        assert.equal(
          severity === 0,
          engineEligible,
          `${hsl ? 'HSL' : 'non-HSL'} · ${rangeLabel} · ${patLabel}: severity ${severity} vs engine ${engineEligible}`,
        );

        if (engineEligible) sawEligible = true;
        else sawIneligible = true;
      }
    }

    // A test that only ever saw one verdict proves nothing.
    assert.ok(sawEligible, 'fixtures must produce at least one ELIGIBLE case');
    assert.ok(sawIneligible, 'fixtures must produce at least one INELIGIBLE case');
  });
}

test('non-HSL: one sub-7h weekday is severity 1, and names the day', () => {
  const start = new Date(2026, 7, 3); // Mon Aug 3
  const end = new Date(2026, 7, 28); // Fri Aug 28
  const short = new Date(2026, 7, 11); // Tue Aug 11
  const { entries } = fixture(start, end, (d) => (d.getTime() === short.getTime() ? 5 * 3600 : H7), {
    isHsl: false,
  });

  const result = computePabIneligibility({
    entries,
    isHsl: false,
    hslSunSat: true,
    periodStart: start,
    periodEnd: end,
  });

  assert.equal(result.severity, 1);
  assert.equal(result.failedDays[0].iso, '2026-08-11');
  assert.equal(result.failedDays[0].shortfallSec, 2 * 3600);
});

test('HSL: two short days in a week that still makes 5-of-7 cost nothing', () => {
  // Sun Aug 2 → Sat Aug 8. Five full days, two short — quota met, severity 0.
  const start = new Date(2026, 7, 2);
  const end = new Date(2026, 7, 8);
  const entries: PabDayEntry[] = eachDay(start, end).map((d, i) => {
    const sec = i < 2 ? 2 * 3600 : H7;
    return { iso: iso(d), seconds: sec, passes: sec >= H7, forgivenByDispute: false, forgivenByHoliday: false };
  });

  const result = computePabIneligibility({
    entries,
    isHsl: true,
    hslSunSat: true,
    periodStart: start,
    periodEnd: end,
  });

  assert.equal(result.severity, 0, 'a reconciled week must not produce failed days');
});

test('HSL: a week that misses quota reports only its WEEKDAY shortfalls', () => {
  // Sun Aug 2 → Sat Aug 8: only 3 qualifying days, so the week fails. The two
  // blank weekend cells must NOT be counted — that is the trap this guards.
  const start = new Date(2026, 7, 2);
  const end = new Date(2026, 7, 8);
  const entries: PabDayEntry[] = eachDay(start, end).map((d) => {
    const dow = d.getDay();
    const sec = dow >= 1 && dow <= 3 ? H7 : 0;
    return { iso: iso(d), seconds: sec, passes: sec >= H7, forgivenByDispute: false, forgivenByHoliday: false };
  });

  const result = computePabIneligibility({
    entries,
    isHsl: true,
    hslSunSat: true,
    periodStart: start,
    periodEnd: end,
  });

  // Thu + Fri failed; Sat + Sun are days off, not failures.
  assert.equal(result.severity, 2);
  assert.deepEqual(result.failedDays.map((f) => f.iso), ['2026-08-06', '2026-08-07']);
});

test('an overnight-qualifying day is never a failed day', () => {
  // Mon 4h + Tue 4h = an 8h shift split across midnight. Both days qualify via
  // the forward/backward credit, so neither is a failure.
  const start = new Date(2026, 7, 2); // Sun
  const end = new Date(2026, 7, 8); // Sat
  const entries: PabDayEntry[] = eachDay(start, end).map((d) => {
    const dow = d.getDay();
    const sec = dow === 1 || dow === 2 ? 4 * 3600 : dow === 0 || dow === 6 ? 0 : H7;
    return { iso: iso(d), seconds: sec, passes: sec >= H7, forgivenByDispute: false, forgivenByHoliday: false };
  });

  const info = computeHslWeekInfo(entries, { hslSunSat: true, periodStart: start, periodEnd: end });
  const week = info.get('2026-08-02');
  assert.ok(week, 'week must be anchored on the Sunday');
  assert.ok(week.overnightIsos.has('2026-08-03'), 'Monday should qualify via overnight credit');

  const result = computePabIneligibility({
    entries,
    isHsl: true,
    hslSunSat: true,
    periodStart: start,
    periodEnd: end,
  });
  assert.equal(result.severity, 0);
});

test('a forgiven day never counts as failed, for either cohort', () => {
  const start = new Date(2026, 7, 3);
  const end = new Date(2026, 7, 7);
  const entries: PabDayEntry[] = eachDay(start, end).map((d, i) => ({
    iso: iso(d),
    seconds: i === 1 ? 2 * 3600 : H7,
    // A forgiven day passes despite the hours — that is what forgiveness means.
    passes: true,
    forgivenByDispute: i === 1,
    forgivenByHoliday: false,
  }));

  for (const isHsl of [false, true]) {
    const result = computePabIneligibility({
      entries,
      isHsl,
      hslSunSat: true,
      periodStart: start,
      periodEnd: end,
    });
    assert.equal(result.severity, 0, `forgiven day must not count (isHsl=${isHsl})`);
  }
});

test('UNDER-COVERAGE: dropping the anchor Sunday manufactures a failure', () => {
  // The exact case the identity test caught. 2026-07 ran Mon Jul 6 → Fri Jul 31,
  // so the first sun_sat week anchors on Sun Jul 5 — OUTSIDE the period. Someone
  // who worked Sun/Mon/Wed/Fri/Sat makes 5-of-7. Omit the Sunday and they read
  // as 4-of-7 and lose ₱5,000 that dispatch would have paid.
  const start = new Date(2026, 6, 6);
  const end = new Date(2026, 6, 31);
  const worked = (d: Date) => (d.getDay() === 2 || d.getDay() === 4 ? 0 : H7);

  const build = (from: Date): PabDayEntry[] =>
    eachDay(from, getHslAdjustedEnd(end, 'sun_sat')).map((d) => ({
      iso: iso(d),
      seconds: worked(d),
      passes: worked(d) >= H7,
      forgivenByDispute: false,
      forgivenByHoliday: false,
    }));

  const anchored = computePabIneligibility({
    entries: build(hslCoverageStart(start, true, true)),
    isHsl: true,
    hslSunSat: true,
    periodStart: start,
    periodEnd: getHslAdjustedEnd(end, 'sun_sat'),
  });
  const truncated = computePabIneligibility({
    entries: build(start),
    isHsl: true,
    hslSunSat: true,
    periodStart: start,
    periodEnd: getHslAdjustedEnd(end, 'sun_sat'),
  });

  assert.equal(hslCoverageStart(start, true, true).getDate(), 5, 'anchor is Sun Jul 5');
  assert.equal(anchored.severity, 0, 'with the anchor day supplied, the week reconciles');
  assert.ok(
    truncated.severity > 0,
    'without it the opening week under-counts — do NOT "fix" this by padding zeros, widen the window',
  );
});

test('hslWeekStartIso anchors on the model, not the calendar', () => {
  const wed = new Date(2026, 7, 5); // Wed Aug 5 2026
  assert.equal(hslWeekStartIso(wed, true), '2026-08-02', 'sun_sat anchors back to Sunday');
  assert.equal(hslWeekStartIso(wed, false), '2026-08-03', 'mon_sun anchors back to Monday');
  const sun = new Date(2026, 7, 2);
  assert.equal(hslWeekStartIso(sun, true), '2026-08-02', 'a Sunday opens its own sun_sat week');
  assert.equal(hslWeekStartIso(sun, false), '2026-07-27', 'a Sunday CLOSES the prior mon_sun week');
});

test('severity bands: 1–2 is the review cohort', () => {
  assert.equal(pabSeverityBand(0), 'eligible');
  assert.equal(pabSeverityBand(1), 'review');
  assert.equal(pabSeverityBand(2), 'review');
  assert.equal(pabSeverityBand(3), 'high');
  assert.equal(pabSeverityBand(12), 'high');
});

test('no tracked time is NOT the worst attendance in the company', () => {
  // The live failure: Aaron Taguas resigned 2026-06-02, had no August hours, and
  // scored severity 15 — sorting him above every real 1–2-day case.
  assert.equal(pabSeverityBand(15, false), 'no-hours');
  assert.equal(pabSeverityBand(0, false), 'no-hours');
  // hasHours defaults true so existing callers are unchanged.
  assert.equal(pabSeverityBand(15), 'high');
});
