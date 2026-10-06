import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MESA_DEPOSIT_WEEKDAY,
  MESA_WEEK_SPAN_DAYS,
  isoDayOfWeek,
  mesaDepositDateFor,
  mesaDepositDatesToReverse,
  mesaWeekStartFor,
} from './deposit-date';

// These tests exist because the MESA weekly deposit date used to be written in
// one place and matched in another, as two independent copies of the same
// expression. Moving one and not the other produces NO error: the reversal is a
// filtered DELETE, so a filter that matches nothing deletes nothing and reports
// success, leaving every member's ₱400 in their balance for a pay week that was
// cancelled. The contract below is what makes that impossible; if it changes,
// the reversal silently changes with it, so it is pinned here.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Every date in [from, from + count) — enough to cover leap days, month ends,
 *  year boundaries and all seven weekday alignments many times over. */
function isoRange(from: string, count: number): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
}

// A little over three years, spanning two leap years.
const EVERY_DATE = isoRange('2024-01-01', 1200);

test('the deposit date is ALWAYS a Friday, whatever weekday the week ends on', () => {
  for (const weekEnd of EVERY_DATE) {
    const deposit = mesaDepositDateFor(weekEnd);
    assert.equal(
      isoDayOfWeek(deposit),
      MESA_DEPOSIT_WEEKDAY,
      `weekEnd ${weekEnd} (${DAYS[isoDayOfWeek(weekEnd)]}) produced ${deposit} (${DAYS[isoDayOfWeek(deposit)]}), not a Friday`,
    );
  }
});

test('for a normal Sun–Sat week the deposit lands the day before the week end', () => {
  // 2026-08-29 is a Saturday.
  assert.equal(isoDayOfWeek('2026-08-29'), 6);
  assert.equal(mesaDepositDateFor('2026-08-29'), '2026-08-28');
  assert.equal(isoDayOfWeek('2026-08-28'), MESA_DEPOSIT_WEEKDAY);
});

test('an 8-day Sun→Sun span still yields a Friday, not a Saturday', () => {
  // Production carries both 7- and 8-day filename ranges: the span is
  // deliberately unchecked upstream. A naive `weekEnd - 1` would return the
  // Saturday here and quietly reintroduce the wrong-day bug.
  const sunday = '2026-08-30';
  assert.equal(isoDayOfWeek(sunday), 0);
  const deposit = mesaDepositDateFor(sunday);
  assert.equal(deposit, '2026-08-28');
  assert.equal(isoDayOfWeek(deposit), MESA_DEPOSIT_WEEKDAY);
  assert.notEqual(deposit, '2026-08-29', 'must not be the Saturday');
});

test('a week end that is already a Friday is left alone', () => {
  assert.equal(isoDayOfWeek('2026-08-28'), 5);
  assert.equal(mesaDepositDateFor('2026-08-28'), '2026-08-28');
});

test('THE INVARIANT: what the reverser matches always includes what the writer wrote', () => {
  // This is the whole point of the module. If it ever fails, deleting a pay
  // week silently orphans that week's deposits.
  for (const weekEnd of EVERY_DATE) {
    const written = mesaDepositDateFor(weekEnd);
    const matched = mesaDepositDatesToReverse(weekEnd);
    assert.ok(
      matched.includes(written),
      `weekEnd ${weekEnd}: writer produces ${written} but reverser looks for ${JSON.stringify(matched)}`,
    );
  }
});

test('the reverser also still matches pre-cutover deposits dated on the week end', () => {
  // Deposits written before the Friday move carry the week end itself. Dropping
  // this makes them permanently unreversible — the exact bug being fixed.
  const saturday = '2026-08-29';
  assert.ok(mesaDepositDatesToReverse(saturday).includes(saturday));
});

test('the reverser matches EXACT dates, never a range', () => {
  // A window match would also sweep up the historical deposits laid down by the
  // CSV backfill, which carry an identical shape (₱100/₱300, no tracker
  // provenance) and are not this week's to remove.
  for (const weekEnd of EVERY_DATE) {
    const matched = mesaDepositDatesToReverse(weekEnd);
    assert.ok(matched.length <= 2, `${weekEnd} produced ${matched.length} dates`);
    assert.equal(new Set(matched).size, matched.length, `${weekEnd} produced duplicates`);
  }
});

test('the deposit date always falls inside the dedupe window', () => {
  // Load-bearing for idempotency: the "already credited this week?" check scans
  // [weekStart, weekEnd]. A deposit dated outside it would be invisible to that
  // check and get written again on every single re-upload of the same week.
  for (const weekEnd of EVERY_DATE) {
    const deposit = mesaDepositDateFor(weekEnd);
    const weekStart = mesaWeekStartFor(weekEnd);
    assert.ok(
      deposit >= weekStart && deposit <= weekEnd,
      `weekEnd ${weekEnd}: deposit ${deposit} is outside [${weekStart}, ${weekEnd}]`,
    );
  }
});

test('the dedupe window spans exactly the Sun–Sat week', () => {
  assert.equal(MESA_WEEK_SPAN_DAYS, 6);
  assert.equal(mesaWeekStartFor('2026-08-29'), '2026-08-23');
  assert.equal(isoDayOfWeek('2026-08-23'), 0, 'a Saturday week end implies a Sunday start');
});

test('a malformed date is rejected rather than silently mis-dated', () => {
  // Failing loud beats writing a financial row on a date nobody meant.
  for (const bad of ['', '2026-8-29', '29/08/2026', '2026-08-29T00:00:00Z', 'not-a-date']) {
    assert.throws(() => mesaDepositDateFor(bad), /YYYY-MM-DD/, `accepted ${JSON.stringify(bad)}`);
  }
});

// ── mesaContributesForWeek — Kane's 2026-09-15 ruling ─────────────────────────
//
// "Friday should be the deposit dates." A member contributes for a pay week
// only when their enrollment date is on/before that week's Friday deposit
// date. Before this, the Wizard charged ₱100 for any week ENDING on/after the
// enrollment date while the writer dated the ₱400 on the Friday before it —
// for a Saturday enrollment the deposit landed before the account opened and
// the balance never showed it. Charged, nothing visible.

import { mesaContributesForWeek, NO_MESA_SUSPENSIONS as NONE } from './deposit-date';

// 2026-09-13 (Sun) … 2026-09-19 (Sat) is the pay week; its deposit is Fri 09-18.
const SAT_WEEK_END = '2026-09-19';
const FRI = '2026-09-18';

test('a legacy member (no enrollment date) always contributes', () => {
  for (const weekEnd of EVERY_DATE.slice(0, 60)) {
    assert.equal(mesaContributesForWeek(null, weekEnd, NONE), true);
    assert.equal(mesaContributesForWeek(undefined, weekEnd, NONE), true);
    assert.equal(mesaContributesForWeek('', weekEnd, NONE), true);
  }
});

test('no week yet → contributing (the Wizard fallback before a file is chosen)', () => {
  assert.equal(mesaContributesForWeek('2026-09-19', null, NONE), true);
  assert.equal(mesaContributesForWeek('2026-09-19', undefined, NONE), true);
});

test('enrolled on or before the Friday → charged for that week', () => {
  assert.equal(isoDayOfWeek(SAT_WEEK_END), 6);
  assert.equal(mesaDepositDateFor(SAT_WEEK_END), FRI);
  for (const since of ['2026-09-13', '2026-09-14', '2026-09-17', FRI, '2026-01-01']) {
    assert.equal(mesaContributesForWeek(since, SAT_WEEK_END, NONE), true, since);
  }
});

test('a SATURDAY enrollment is NOT charged for the week ending that day — the old rule was', () => {
  const oldRule = SAT_WEEK_END <= SAT_WEEK_END; // since <= weekEnd
  assert.equal(oldRule, true, 'the rule being replaced charged this week');
  assert.equal(mesaContributesForWeek(SAT_WEEK_END, SAT_WEEK_END, NONE), false);
});

test('a Saturday enrollment starts with the FOLLOWING week', () => {
  const nextWeekEnd = '2026-09-26';
  assert.equal(isoDayOfWeek(nextWeekEnd), 6);
  assert.equal(mesaContributesForWeek(SAT_WEEK_END, nextWeekEnd, NONE), true);
  // And a Sunday enrollment, likewise, waits for the week whose Friday it precedes.
  assert.equal(mesaContributesForWeek('2026-09-20', SAT_WEEK_END, NONE), false);
  assert.equal(mesaContributesForWeek('2026-09-20', nextWeekEnd, NONE), true);
});

test('an HSL Mon–Sun week is judged by ITS Friday too', () => {
  // HSL weeks end on Sunday 2026-09-20; the deposit date is still Fri 09-18.
  const sunWeekEnd = '2026-09-20';
  assert.equal(isoDayOfWeek(sunWeekEnd), 0);
  assert.equal(mesaDepositDateFor(sunWeekEnd), FRI);
  assert.equal(mesaContributesForWeek(FRI, sunWeekEnd, NONE), true);
  assert.equal(mesaContributesForWeek('2026-09-19', sunWeekEnd, NONE), false);
  assert.equal(mesaContributesForWeek(sunWeekEnd, sunWeekEnd, NONE), false);
});

test('THE INVARIANT: whenever a member is charged, the deposit is never dated before their enrollment', () => {
  // This is the ruling's whole point: the ₱400 the writer dates on the Friday
  // must fall inside the account (>= opened_on), or the balance never shows it.
  for (const weekEnd of EVERY_DATE) {
    const deposit = mesaDepositDateFor(weekEnd);
    for (let back = -8; back <= 8; back++) {
      const since = new Date(Date.parse(`${weekEnd}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
      const charged = mesaContributesForWeek(since, weekEnd, NONE);
      if (charged) {
        assert.ok(deposit >= since, `since ${since} charged for week ending ${weekEnd} but deposit ${deposit} predates it`);
      } else {
        assert.ok(deposit < since, `since ${since} NOT charged for week ending ${weekEnd} although deposit ${deposit} is on/after it`);
      }
    }
  }
});

// ── Suspensions (2026-10-06) ──────────────────────────────────────────────────
//
// Kane: "suspend the mesa contribution without having to opt-out to remove the
// -100". A suspension window is judged at the same FRIDAY the enrollment date
// is: suspended when suspendedFrom <= Friday < resumedOn. One predicate decides
// both the ₱100 and the ₱400, so these tests are also the writer's tests.

import { mesaSuspendedOn, type MesaSuspensionWindow } from './deposit-date';

const win = (suspendedFrom: string, resumedOn: string | null = null): MesaSuspensionWindow => ({
  suspendedFrom,
  resumedOn,
});

test('a suspension effective on or before the Friday skips that week', () => {
  for (const from of ['2026-09-13', '2026-09-14', '2026-09-17', FRI, '2026-01-01']) {
    assert.equal(mesaContributesForWeek('2026-01-01', SAT_WEEK_END, [win(from)]), false, from);
  }
});

test('a suspension effective on the SATURDAY starts with the FOLLOWING week (same rule as enrolling)', () => {
  assert.equal(mesaContributesForWeek('2026-01-01', SAT_WEEK_END, [win(SAT_WEEK_END)]), true);
  assert.equal(mesaContributesForWeek('2026-01-01', '2026-09-26', [win(SAT_WEEK_END)]), false);
});

test('an open-ended suspension skips every later week', () => {
  for (const weekEnd of EVERY_DATE.filter((d) => d >= '2026-09-19')) {
    assert.equal(mesaContributesForWeek('2026-01-01', weekEnd, [win(FRI)]), false, weekEnd);
  }
});

test('RESUME: the week whose Friday is on/after the resume date is charged again', () => {
  const s = [win('2026-09-14', '2026-09-28')]; // resume Mon 09-28 → week ending 10-03 (Fri 10-02)
  assert.equal(mesaContributesForWeek(null, SAT_WEEK_END, s), false); // Fri 09-18
  assert.equal(mesaContributesForWeek(null, '2026-09-26', s), false); // Fri 09-25
  assert.equal(mesaContributesForWeek(null, '2026-10-03', s), true); // Fri 10-02
});

test('a resume dated ON a Friday charges that Friday\'s week (half-open window)', () => {
  assert.equal(mesaContributesForWeek(null, SAT_WEEK_END, [win('2026-09-01', FRI)]), true);
  assert.equal(mesaSuspendedOn([win('2026-09-01', FRI)], FRI), false);
  assert.equal(mesaSuspendedOn([win('2026-09-01', FRI)], '2026-09-11'), true);
});

test('a CANCELLED suspension (resumed on its own start date) skips no week at all', () => {
  const cancelled = [win(FRI, FRI)];
  for (const weekEnd of EVERY_DATE) {
    assert.equal(mesaContributesForWeek(null, weekEnd, cancelled), true, weekEnd);
  }
});

test('a week before the suspension is untouched — suspending is never retroactive past its date', () => {
  assert.equal(mesaContributesForWeek(null, '2026-09-12', [win('2026-09-14')]), true); // Fri 09-11
});

test('two windows union; a gap between them is charged', () => {
  const s = [win('2026-09-01', '2026-09-14'), win('2026-09-21')];
  assert.equal(mesaContributesForWeek(null, '2026-09-12', s), false); // Fri 09-11 in the first
  assert.equal(mesaContributesForWeek(null, SAT_WEEK_END, s), true); // Fri 09-18 in the gap
  assert.equal(mesaContributesForWeek(null, '2026-09-26', s), false); // Fri 09-25 in the second
});

test('enrollment still wins when it is LATER than the week, suspension or not', () => {
  assert.equal(mesaContributesForWeek('2026-09-20', SAT_WEEK_END, [win('2026-12-01')]), false);
});

test('no week → contributing, suspended or not (no Friday to judge against)', () => {
  assert.equal(mesaContributesForWeek(null, null, [win('2026-01-01')]), true);
});

test('an HSL Mon–Sun week is suspended by ITS Friday too', () => {
  assert.equal(mesaContributesForWeek(null, '2026-09-20', [win(FRI)]), false);
  assert.equal(mesaContributesForWeek(null, '2026-09-20', [win('2026-09-19')]), true);
});

test('THE INVARIANT with suspensions: charged ⇔ enrolled by the Friday AND no window covers the Friday', () => {
  const windows = [win('2026-03-04', '2026-04-10'), win('2026-06-06', '2026-06-06'), win('2026-08-15')];
  for (const weekEnd of EVERY_DATE) {
    const deposit = mesaDepositDateFor(weekEnd);
    for (const since of [null, '2026-02-01', '2026-05-15']) {
      const charged = mesaContributesForWeek(since, weekEnd, windows);
      const expected =
        (since === null || since <= deposit) &&
        !windows.some((w) => w.suspendedFrom <= deposit && (w.resumedOn === null || deposit < w.resumedOn));
      assert.equal(charged, expected, `since ${since} week ${weekEnd}`);
    }
  }
});
