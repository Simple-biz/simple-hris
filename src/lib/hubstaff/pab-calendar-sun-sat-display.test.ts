/**
 * Pins the 2026-08-27 "all PAB calendars read Sunday–Saturday" change
 * (Aliviah's ticket) to the ruling that came with it: the GRID moves, the MONEY
 * does not.
 *
 * The load-bearing property is an IDENTITY — the scoring cells of the Sun–Sat
 * display grid must be exactly the cells the old Mon–Fri builder produced. If
 * that ever drifts, non-HSL PAB eligibility silently changes for the whole
 * company, which is the one outcome the ruling forbade.
 *
 * Run: npx tsx --test src/lib/hubstaff/pab-calendar-sun-sat-display.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPabCalendarWeeks,
  buildPabCalendarWeeksFullWeek,
  buildPabCalendarWeeksSunSatDisplay,
  getPabMonthRange,
  pabDateKey,
  type PabCalendarDay,
} from './calendar-column-dedupe';

const H7 = 7 * 3600;

/** A month of mixed hours, including weekend time (the trap: weekend hours must
 *  not become a non-HSL pass, and must not become a non-HSL failure either). */
function hoursFixture(start: Date, end: Date): Map<string, number> {
  const m = new Map<string, number>();
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7);
  const stop = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 7);
  let i = 0;
  while (cur.getTime() <= stop.getTime()) {
    // Deterministic spread: most days full, some short, some absent.
    const mod = i % 5;
    if (mod !== 3) m.set(pabDateKey(cur), mod === 1 ? 4 * 3600 : H7 + mod * 600);
    cur.setDate(cur.getDate() + 1);
    i += 1;
  }
  return m;
}

const identity = (d: PabCalendarDay) =>
  `${pabDateKey(d.date)}|${d.seconds}|${d.passes}|${d.hasData}`;

/** The live 2026-08 override (Sun Aug 2 → Sat Aug 29), the 2026-07 override
 *  (Mon Jul 6 → Fri Jul 31), plus defaults on both sides of the cutover. */
const RANGES: { label: string; start: Date; end: Date }[] = [
  { label: '2026-08 override (Sun→Sat)', start: new Date(2026, 7, 2), end: new Date(2026, 7, 29) },
  { label: '2026-07 override (Mon→Fri)', start: new Date(2026, 6, 6), end: new Date(2026, 6, 31) },
  { label: '2026-09 default', ...getPabMonthRange(2026, 8) },
  { label: '2026-05 default', ...getPabMonthRange(2026, 4) },
  { label: '2026-02 default (short month)', ...getPabMonthRange(2026, 1) },
];

test('Sun–Sat display grid scores EXACTLY the cells the Mon–Fri builder scored', () => {
  for (const { label, start, end } of RANGES) {
    const hours = hoursFixture(start, end);
    const legacy = buildPabCalendarWeeks(start, end, hours).flat();
    const display = buildPabCalendarWeeksSunSatDisplay(start, end, hours)
      .flat()
      .filter((d) => d.scoring);

    assert.deepEqual(
      display.map(identity),
      legacy.map(identity),
      `scoring set must be unchanged for ${label}`,
    );
    assert.ok(legacy.length > 0, `fixture should produce scoring days for ${label}`);
  }
});

test('the two builders agree on the VERDICT for every range, passing or failing', () => {
  for (const { label, start, end } of RANGES) {
    for (const variant of ['as-is', 'all-pass'] as const) {
      const hours = hoursFixture(start, end);
      if (variant === 'all-pass') {
        // Force every weekday to a pass; weekends stay short on purpose so a
        // leaked weekend cell would flip the verdict to false and fail here.
        const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        while (cur.getTime() <= end.getTime()) {
          const dow = cur.getDay();
          if (dow >= 1 && dow <= 5) hours.set(pabDateKey(cur), H7);
          else hours.set(pabDateKey(cur), 3600);
          cur.setDate(cur.getDate() + 1);
        }
      }
      const verdict = (days: PabCalendarDay[]) => days.length > 0 && days.every((d) => d.passes);
      const legacy = verdict(buildPabCalendarWeeks(start, end, hours).flat());
      const display = verdict(
        buildPabCalendarWeeksSunSatDisplay(start, end, hours).flat().filter((d) => d.scoring),
      );
      assert.equal(display, legacy, `verdict parity for ${label} (${variant})`);
      if (variant === 'all-pass') assert.equal(legacy, true, `all-pass should pass for ${label}`);
    }
  }
});

test('every display weekend cell is non-scoring AND never reads as a pass', () => {
  const { start, end } = RANGES[0];
  // Give the weekends a full 7 h — the cell must STILL not pass, or a consumer
  // that forgets the `scoring` filter would hand out PAB on weekend hours.
  const hours = hoursFixture(start, end);
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  while (cur.getTime() <= end.getTime()) {
    if (cur.getDay() === 0 || cur.getDay() === 6) hours.set(pabDateKey(cur), 12 * 3600);
    cur.setDate(cur.getDate() + 1);
  }
  const all = buildPabCalendarWeeksSunSatDisplay(start, end, hours).flat();
  const weekends = all.filter((d) => d.date.getDay() === 0 || d.date.getDay() === 6);
  assert.ok(weekends.length > 0, 'grid must actually contain weekend cells');
  for (const d of weekends) {
    assert.equal(d.scoring, false, `${pabDateKey(d.date)} must be non-scoring`);
    assert.equal(d.passes, false, `${pabDateKey(d.date)} must never read as a pass`);
  }
  // Weekend cells still carry their real tracked time — they are shown, not faked.
  assert.ok(weekends.every((d) => d.seconds === 12 * 3600), 'weekend cells keep real hours');
});

test('display grid rows are full Sun→Sat weeks', () => {
  for (const { label, start, end } of RANGES) {
    const weeks = buildPabCalendarWeeksSunSatDisplay(start, end, hoursFixture(start, end));
    for (const [i, week] of weeks.entries()) {
      assert.equal(week.length, 7, `${label} week ${i} must have 7 cells`);
      assert.equal(week[0].date.getDay(), 0, `${label} week ${i} must open on Sunday`);
      assert.equal(week[6].date.getDay(), 6, `${label} week ${i} must close on Saturday`);
    }
    // Every scoring day of the period is present exactly once.
    const scoring = weeks.flat().filter((d) => d.scoring).map((d) => pabDateKey(d.date));
    assert.equal(new Set(scoring).size, scoring.length, `${label} must not duplicate a day`);
  }
});

test('buildPabCalendarWeeksFullWeek anchors on the model it is given', () => {
  const start = new Date(2026, 7, 2); // Sun Aug 2
  const end = new Date(2026, 7, 29); // Sat Aug 29
  const hours = hoursFixture(start, end);

  const sunSat = buildPabCalendarWeeksFullWeek(start, end, hours, 'sun_sat');
  for (const week of sunSat) {
    assert.equal(week[0].date.getDay(), 0, 'sun_sat rows open on Sunday');
    assert.equal(week[week.length - 1].date.getDay(), 6, 'sun_sat rows close on Saturday');
  }

  const monSun = buildPabCalendarWeeksFullWeek(new Date(2026, 7, 3), end, hours, 'mon_sun');
  for (const week of monSun) {
    assert.equal(week[0].date.getDay(), 1, 'mon_sun rows open on Monday');
    assert.equal(week[week.length - 1].date.getDay(), 0, 'mon_sun rows close on Sunday');
  }

  // Orphanage forgiveness picker: EVERY cell must stay selectable, weekends too.
  assert.ok(
    [...sunSat, ...monSun].flat().every((d) => d.scoring),
    'full-week grids score every cell — weekend days are forgivable',
  );
});
