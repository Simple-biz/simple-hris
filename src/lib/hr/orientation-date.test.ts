import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveOrientationDate,
  describeOrientationShift,
  weekdayNameOf,
  addDaysIso,
} from "./orientation-date";

const none = new Map<string, string>();

/** The live case this shipped for: 2026-09-06 week, Monday is Labor Day. */
const LABOR_DAY = new Map([["2026-09-07", "Labor Day"]]);

test("no holidays: orientation is the Monday of the Sun-anchored week", () => {
  const r = resolveOrientationDate("2026-08-02", none);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.date, "2026-08-03");
  assert.equal(r.weekday, "Monday");
  assert.equal(r.shifted, false);
  assert.deepEqual(r.skipped, []);
});

test("Labor Day 2026: the 09-06 week moves Mon Sep 7 -> Tue Sep 8", () => {
  const r = resolveOrientationDate("2026-09-06", LABOR_DAY);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.baseDate, "2026-09-07");
  assert.equal(r.date, "2026-09-08");
  assert.equal(r.weekday, "Tuesday");
  assert.equal(r.shifted, true);
  assert.deepEqual(r.skipped, [{ date: "2026-09-07", name: "Labor Day" }]);
});

test("consecutive holidays keep advancing (Kane 2026-09-03)", () => {
  const back2back = new Map([
    ["2026-09-07", "Labor Day"],
    ["2026-09-08", "Company Holiday"],
  ]);
  const r = resolveOrientationDate("2026-09-06", back2back);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.date, "2026-09-09");
  assert.equal(r.weekday, "Wednesday");
  assert.equal(r.skipped.length, 2);
  assert.deepEqual(
    r.skipped.map((s) => s.name),
    ["Labor Day", "Company Holiday"],
  );
});

test("Mon-Thu all holidays still lands inside the week, on Friday", () => {
  const four = new Map([
    ["2026-09-07", "A"],
    ["2026-09-08", "B"],
    ["2026-09-09", "C"],
    ["2026-09-10", "D"],
  ]);
  const r = resolveOrientationDate("2026-09-06", four);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.date, "2026-09-11");
  assert.equal(r.weekday, "Friday");
});

test("REFUSES rather than rolling into the weekend when every weekday is a holiday", () => {
  const all = new Map([
    ["2026-09-07", "A"],
    ["2026-09-08", "B"],
    ["2026-09-09", "C"],
    ["2026-09-10", "D"],
    ["2026-09-11", "E"],
  ]);
  const r = resolveOrientationDate("2026-09-06", all);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "no_weekday_left");
  assert.equal(r.skipped.length, 5);
  // Never Saturday, never next week's Monday.
});

test("a disabled holiday does not move anything (empty map = no shift)", () => {
  // getEnabledHolidayMap drops `enabled:false` entries and returns an EMPTY map
  // when the master toggle is off — so both cases reach here as `none`.
  const r = resolveOrientationDate("2026-09-06", none);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.date, "2026-09-07");
  assert.equal(r.shifted, false);
});

test("a holiday that is NOT the Monday is ignored", () => {
  const midweek = new Map([["2026-09-09", "Wednesday Holiday"]]);
  const r = resolveOrientationDate("2026-09-06", midweek);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.date, "2026-09-07");
  assert.equal(r.shifted, false);
  assert.deepEqual(r.skipped, []);
});

test("a bad period is refused, never silently defaulted", () => {
  for (const bad of ["", "   ", "2026-9-6", "not-a-date", "20260906"]) {
    const r = resolveOrientationDate(bad, LABOR_DAY);
    assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
    if (r.ok) continue;
    assert.equal(r.reason, "bad_period");
  }
});

test("describeOrientationShift names every holiday it stepped over", () => {
  const shifted = resolveOrientationDate("2026-09-06", LABOR_DAY);
  assert.equal(describeOrientationShift(shifted), "Moved from Monday (Sep 7) — Labor Day");

  const unshifted = resolveOrientationDate("2026-08-02", none);
  assert.equal(describeOrientationShift(unshifted), null);

  const twice = resolveOrientationDate(
    "2026-09-06",
    new Map([
      ["2026-09-07", "Labor Day"],
      ["2026-09-08", "Company Holiday"],
    ]),
  );
  assert.equal(
    describeOrientationShift(twice),
    "Moved from Monday (Sep 7) — Labor Day, Company Holiday",
  );
});

test("date helpers are UTC and month/year safe", () => {
  assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysIso("2026-02-28", 1), "2026-03-01"); // 2026 is not a leap year
  assert.equal(addDaysIso("bad", 1), null);
  assert.equal(weekdayNameOf("2026-09-07"), "Monday");
  assert.equal(weekdayNameOf("2026-09-08"), "Tuesday");
  assert.equal(weekdayNameOf(null), null);
});
