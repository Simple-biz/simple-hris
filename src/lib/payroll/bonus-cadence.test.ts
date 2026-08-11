import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isFinalPayrollWeekOfMonth,
  payrollWeekMonthOrdinal,
  calendarMonthOrdinal,
  relateMonthlyPeriodToWeek,
  normalizeCadence,
  DEFAULT_BONUS_CADENCE,
} from './bonus-cadence';

// ── cadence coercion ─────────────────────────────────────────────────────────

test('cadence defaults to weekly for anything that is not "monthly"', () => {
  assert.equal(DEFAULT_BONUS_CADENCE, 'weekly');
  assert.equal(normalizeCadence('monthly'), 'monthly');
  assert.equal(normalizeCadence('weekly'), 'weekly');
  assert.equal(normalizeCadence(undefined), 'weekly');
  assert.equal(normalizeCadence(null), 'weekly');
  assert.equal(normalizeCadence('MONTHLY'), 'weekly', 'casing is not coerced — legacy rows read weekly');
});

// ── isFinalPayrollWeekOfMonth (pre-existing rule, pinned) ────────────────────

test('the final payroll week of a month is the one whose next Monday rolls over', () => {
  // July 2026 Mondays: 6, 13, 20, 27. Jul 27 + 7 = Aug 3 → final week.
  assert.equal(isFinalPayrollWeekOfMonth('2026-07-27'), true);
  assert.equal(isFinalPayrollWeekOfMonth('2026-07-20'), false);
  assert.equal(isFinalPayrollWeekOfMonth('2026-07-06'), false);
});

test('an unparseable date is never the final week', () => {
  assert.equal(isFinalPayrollWeekOfMonth(''), false);
  assert.equal(isFinalPayrollWeekOfMonth('not-a-date'), false);
});

// ── payrollWeekMonthOrdinal ──────────────────────────────────────────────────

test('a Sunday week-start is walked FORWARD to its owning Monday', () => {
  // The Jul 26 – Aug 1 2026 file: Sunday Jul 26 → owning Monday Jul 27 → JULY.
  // Walking backward (the old fileMonth bug) would land on Jul 20 — still July
  // here, but on a month boundary it attributed the Jul 5–11 file to June.
  assert.equal(payrollWeekMonthOrdinal('2026-07-26'), 2026 * 12 + 6);
  // Sunday Jul 5 2026 → Monday Jul 6 → July, NOT June.
  assert.equal(payrollWeekMonthOrdinal('2026-07-05'), 2026 * 12 + 6);
});

test('a Monday week-start is used as-is', () => {
  assert.equal(payrollWeekMonthOrdinal('2026-07-27'), 2026 * 12 + 6);
});

test('a Sunday that is the last day of a month owns the NEXT month', () => {
  // Sunday Nov 30 2025 → owning Monday Dec 1 → December. The owning-Monday rule
  // is what decides this, not the file's own start date.
  assert.equal(payrollWeekMonthOrdinal('2025-11-30'), 2025 * 12 + 11);
});

test('an unparseable date has no month', () => {
  assert.equal(payrollWeekMonthOrdinal(''), null);
  assert.equal(payrollWeekMonthOrdinal('2026-13'), null);
});

// ── calendarMonthOrdinal ─────────────────────────────────────────────────────

test('a month anchor keeps its own calendar month, whatever weekday it is', () => {
  // Aug 1 2026 is a SATURDAY. Running it through the owning-Monday rule lands on
  // Jul 27 and reports July for a period the UI labels "August 2026" — which is
  // exactly the mistake that made the first cut of this fix silently do nothing.
  assert.equal(payrollWeekMonthOrdinal('2026-08-01'), 2026 * 12 + 6, 'week rule pulls it into July');
  assert.equal(calendarMonthOrdinal('2026-08-01'), 2026 * 12 + 7, 'month rule keeps August');
});

test('a Monday month anchor lands on the same month either way', () => {
  assert.equal(calendarMonthOrdinal('2026-08-03'), 2026 * 12 + 7);
  assert.equal(payrollWeekMonthOrdinal('2026-08-03'), 2026 * 12 + 7);
});

test('calendarMonthOrdinal has no month for an unparseable date', () => {
  assert.equal(calendarMonthOrdinal(''), null);
  assert.equal(calendarMonthOrdinal('nope'), null);
});

// ── relateMonthlyPeriodToWeek ────────────────────────────────────────────────
//
// The bug: monthly HSL periods were picked as "the latest ready/locked, full
// stop", so replaying Jul 26 – Aug 1 2026 showed SSD Medical Records' AUGUST
// card and its ₱463,750 total.

test('a later month than the viewed week is "after" — never that run\'s bonus', () => {
  assert.equal(relateMonthlyPeriodToWeek('2026-08-01', '2026-07-26'), 'after');
  assert.equal(relateMonthlyPeriodToWeek('2026-08-03', '2026-07-26'), 'after');
  assert.equal(relateMonthlyPeriodToWeek('2027-01-04', '2026-07-26'), 'after');
});

test('the viewed week\'s own month is "same"', () => {
  assert.equal(relateMonthlyPeriodToWeek('2026-07-01', '2026-07-26'), 'same');
  assert.equal(relateMonthlyPeriodToWeek('2026-07-27', '2026-07-26'), 'same');
});

test('an earlier month is "before" — still selectable, just outranked', () => {
  assert.equal(relateMonthlyPeriodToWeek('2026-06-01', '2026-07-26'), 'before');
  assert.equal(relateMonthlyPeriodToWeek('2025-12-01', '2026-07-26'), 'before');
});

test('no week to compare against means "unknown" — the caller must not scope', () => {
  // No Hubstaff file loaded. Dropping candidates here would hide a real bonus.
  assert.equal(relateMonthlyPeriodToWeek('2026-08-01', null), 'unknown');
});

test('an unparseable date on either side is "unknown", never "after"', () => {
  // Failing OPEN matters: a parse failure must not silently remove a card.
  assert.equal(relateMonthlyPeriodToWeek('garbage', '2026-07-26'), 'unknown');
  assert.equal(relateMonthlyPeriodToWeek('2026-08-01', 'garbage'), 'unknown');
});

test('the two sides use different month rules, deliberately', () => {
  // Viewed week Sunday Nov 30 2025 owns DECEMBER (owning Monday Dec 1). The
  // period side is a plain calendar month, so December reads "same" and November
  // "before" — not the reverse.
  assert.equal(relateMonthlyPeriodToWeek('2025-12-01', '2025-11-30'), 'same');
  assert.equal(relateMonthlyPeriodToWeek('2025-11-03', '2025-11-30'), 'before');
});

test('a Saturday-anchored month period is still placed in its own month', () => {
  // The regression this fix shipped with once: Aug 1 2026 (Saturday) must read
  // "after" a July week, not get walked back into July and kept.
  assert.equal(relateMonthlyPeriodToWeek('2026-08-01', '2026-07-26'), 'after');
  // ...and must read "same" against an August week.
  assert.equal(relateMonthlyPeriodToWeek('2026-08-01', '2026-08-02'), 'same');
});

// ── the picking rule the wizard's HSL step applies ────────────────────────────
//
// Mirrors the tiebreak in PayrollWizard's step-4 loader so the ordering is
// pinned somewhere runnable: 'after' is never a candidate, an exact month
// outranks an earlier one, and otherwise the later period_start wins with
// locked beating ready on a tie.

type Row = { period_start: string; status: 'ready' | 'locked' };

function pickMonthly(rows: Row[], weekStart: string | null): Row | null {
  let cur: (Row & { rel: string }) | null = null;
  for (const row of rows) {
    const rel = relateMonthlyPeriodToWeek(row.period_start, weekStart);
    if (rel === 'after') continue;
    const beats =
      !cur ||
      (rel === 'same' && cur.rel === 'before') ||
      (!(rel === 'before' && cur.rel === 'same') &&
        (row.period_start > cur.period_start ||
          (row.period_start === cur.period_start && row.status === 'locked')));
    if (beats) cur = { ...row, rel };
  }
  return cur ? { period_start: cur.period_start, status: cur.status } : null;
}

test('replaying July never picks the August period — the reported bug', () => {
  const picked = pickMonthly(
    [{ period_start: '2026-07-01', status: 'ready' }, { period_start: '2026-08-01', status: 'ready' }],
    '2026-07-26',
  );
  assert.equal(picked?.period_start, '2026-07-01');
});

test('an exact-month period outranks an earlier one with a later period_start', () => {
  // Guards the ordering directly: a plain "latest period_start wins" would have
  // to be fed the rows in a lucky order to get this right.
  const rows: Row[] = [
    { period_start: '2026-07-15', status: 'ready' },
    { period_start: '2026-06-01', status: 'locked' },
  ];
  assert.equal(pickMonthly(rows, '2026-07-26')?.period_start, '2026-07-15');
  assert.equal(pickMonthly([...rows].reverse(), '2026-07-26')?.period_start, '2026-07-15');
});

test('with no period for the viewed month, the latest EARLIER one still shows', () => {
  // Deliberate: this preserves the pre-fix behaviour for a month nobody
  // submitted, so the fix only ever removes FUTURE months.
  const picked = pickMonthly(
    [{ period_start: '2026-05-01', status: 'locked' }, { period_start: '2026-06-01', status: 'ready' }],
    '2026-07-26',
  );
  assert.equal(picked?.period_start, '2026-06-01');
});

test('locked beats ready on the same period_start', () => {
  assert.equal(
    pickMonthly(
      [{ period_start: '2026-07-01', status: 'ready' }, { period_start: '2026-07-01', status: 'locked' }],
      '2026-07-26',
    )?.status,
    'locked',
  );
});

test('a future-only month leaves NO card rather than showing the wrong one', () => {
  assert.equal(pickMonthly([{ period_start: '2026-08-01', status: 'locked' }], '2026-07-26'), null);
});

test('with no file loaded, latest-wins still applies (nothing to scope to)', () => {
  assert.equal(
    pickMonthly(
      [{ period_start: '2026-07-01', status: 'ready' }, { period_start: '2026-08-01', status: 'ready' }],
      null,
    )?.period_start,
    '2026-08-01',
  );
});
