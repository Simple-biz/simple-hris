/**
 * Pins the PAB forgiveness rule (Kane 2026-10-06, session log item 363, ruling (b)):
 * an approved issue with NO hours set forgives its day outright, whatever was tracked;
 * an explicit hours SET forgives at ≥ 4h.
 *
 * Three layers, because the rule is read in three places that must agree:
 *   1. `approvedIssueForgivesDay` — the rule itself
 *   2. `applyPabAdjustments` / `computePabEligibleEmails` — what DISPATCH pays
 *   3. the wizard breakdown (`classifyPabBreakdownDay`) → `computePabIneligibility` —
 *      what the PAB step and the PAB Calendar show. Severity 0 must equal the engine's
 *      verdict with forgiveness in play, the same identity `pab-ineligibility.test.ts`
 *      pins without it.
 *
 * Run: npx tsx --test src/lib/payroll/pab-forgiveness.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { approvedIssueForgivesDay } from './pab-forgiveness';
import { applyPabAdjustments, computePabEligibleEmails, getHslAdjustedEnd } from './dispatch-bonuses';
import { classifyPabBreakdownDay } from './pab-breakdown-day';
import { computePabIneligibility, hslCoverageStart, type PabDayEntry } from './pab-ineligibility';
import { pabDateKey } from '../hubstaff/calendar-column-dedupe';

const H = 3600;
const H7 = 7 * H;

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function eachDay(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  while (cur.getTime() <= end.getTime()) {
    out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

test('the rule: null forgives outright; a number forgives at >= 4h', () => {
  assert.equal(approvedIssueForgivesDay(null), true);
  assert.equal(approvedIssueForgivesDay(4), true);
  assert.equal(approvedIssueForgivesDay(7), true);
  assert.equal(approvedIssueForgivesDay(3.99), false);
  assert.equal(approvedIssueForgivesDay(0), false, '0 is the intentional zero-out');
});

test('applyPabAdjustments: a null issue passes a 0–3h day; a SET under 4h stays failed', () => {
  const day = new Date(2026, 8, 9); // Wed Sep 9
  const key = pabDateKey(day);
  const hours = new Map<string, number>([[key, 2 * H]]);

  const forgivenNull = applyPabAdjustments(hours, new Map([[iso(day), null]]), undefined);
  assert.equal(forgivenNull.get(key), H7, 'null = forgiven outright');

  const noData = applyPabAdjustments(new Map(), new Map([[iso(day), null]]), undefined);
  assert.equal(noData.get(key), H7, 'a day with no tracked time at all is forgiven too');

  const setThree = applyPabAdjustments(hours, new Map([[iso(day), 3]]), undefined);
  assert.equal(setThree.get(key), 3 * H, 'an explicit 3h SET is a failing day');

  const setFive = applyPabAdjustments(hours, new Map([[iso(day), 5]]), undefined);
  assert.equal(setFive.get(key), H7);

  assert.equal(hours.get(key), 2 * H, 'the input map is never mutated');
});

/** Every scored weekday full, except Fridays at `fridaySec`. */
function rowAndDisputes(
  start: Date,
  end: Date,
  fridaySec: number,
  fridayOverride: number | null | undefined,
) {
  const row: Record<string, string> = { Email: 'x@simple.biz' };
  const disputes = new Map<string, number | null>();
  const from = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 10);
  const to = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 10);
  const secondsFor = (d: Date) => (d.getDay() === 5 ? fridaySec : H7 + 600);
  for (const d of eachDay(from, to)) {
    row[iso(d)] = String(secondsFor(d) / 3600);
    if (d.getDay() === 5 && fridayOverride !== undefined) disputes.set(iso(d), fridayOverride);
  }
  return { row, disputes, secondsFor };
}

for (const isHsl of [false, true]) {
  for (const [label, fridayOverride, expectEligible] of [
    ['no issue', undefined, false],
    ['issue, no hours set (null)', null, true],
    ['issue, explicit 3h SET', 3, false],
    ['issue, legacy 7h SET', 7, true],
  ] as const) {
    test(`${isHsl ? 'HSL' : 'non-HSL'} · 2h Fridays · ${label}: dispatch and the PAB step agree`, () => {
      // Kept to one Friday per week so HSL can only pass if the Friday counts.
      const start = new Date(2026, 7, 2); // Sun Aug 2
      const end = new Date(2026, 7, 29); // Sat Aug 29
      const { row, disputes, secondsFor } = rowAndDisputes(start, end, 2 * H, fridayOverride);
      // HSL: make every week sit exactly on the 5-of-7 edge — weekends off, so a
      // failing Friday drops the week to 4.
      if (isHsl) {
        for (const d of eachDay(new Date(2026, 6, 20), new Date(2026, 8, 10))) {
          if (d.getDay() === 0 || d.getDay() === 6) row[iso(d)] = '0';
        }
      }
      const weekModel = 'sun_sat' as const;
      const hslAdjustedEnd = getHslAdjustedEnd(end, weekModel);

      const engineEligible = computePabEligibleEmails({
        rows: [row],
        pabRange: { start, end },
        pabRangeSunSat: { start, end },
        hslAdjustedEnd,
        hslEmails: isHsl ? new Set(['x@simple.biz']) : new Set(),
        approvedDisputeDates: new Map([['x@simple.biz', disputes]]),
        weekModel,
      }).has('x@simple.biz');
      assert.equal(engineEligible, expectEligible, 'dispatch verdict');

      // The wizard side: breakdown entries built by the SAME classifier the memos use.
      const coverStart = hslCoverageStart(start, isHsl, true);
      const coverEnd = isHsl ? hslAdjustedEnd : end;
      const entries: PabDayEntry[] = [];
      for (const d of eachDay(coverStart, coverEnd)) {
        const dow = d.getDay();
        if (!isHsl && (dow === 0 || dow === 6)) continue;
        const raw = isHsl && (dow === 0 || dow === 6) ? 0 : secondsFor(d);
        const override = disputes.has(iso(d)) ? disputes.get(iso(d))! : undefined;
        const day = classifyPabBreakdownDay({ rawSeconds: raw, override, fromIssue: override !== undefined, isHoliday: false });
        entries.push({
          iso: iso(d),
          seconds: day.seconds,
          passes: day.passes,
          forgivenByDispute: day.forgivenByDispute,
          forgivenByHoliday: day.forgivenByHoliday,
        });
      }
      const { severity } = computePabIneligibility({
        entries,
        isHsl,
        hslSunSat: true,
        periodStart: start,
        periodEnd: coverEnd,
      });
      assert.equal(severity === 0, engineEligible, `severity ${severity} vs engine ${engineEligible}`);
    });
  }
}
