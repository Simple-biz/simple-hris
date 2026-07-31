import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalWeekKey,
  dedupeOneRowPerWeek,
  type WeekIdentity,
} from "./paystub-week-dedupe";

interface Row extends WeekIdentity {
  label: string;
}

const identify = (r: Row): WeekIdentity => r;
const labels = (rows: Row[]) => rows.map((r) => r.label);

test("canonicalWeekKey anchors Sun–Sat and Mon–Sun ranges of the same pay week to one Sunday", () => {
  // The real May pair: weekly Sun–Sat file vs the backfill's Mon–Sun range.
  assert.equal(canonicalWeekKey("2026-05-03", "2026-05-09"), "2026-05-03");
  assert.equal(canonicalWeekKey("2026-05-04", "2026-05-10"), "2026-05-03");
  // 8-day filename label (boundary day carried twice) still resolves.
  assert.equal(canonicalWeekKey("2026-06-07", "2026-06-14"), "2026-06-07");
  // Adjacent weeks stay distinct.
  assert.equal(canonicalWeekKey("2026-06-14", "2026-06-21"), "2026-06-14");
});

test("canonicalWeekKey refuses non-week shapes", () => {
  // 4-week time-activity export — not a pay week.
  assert.equal(canonicalWeekKey("2026-04-05", "2026-05-02"), null);
  assert.equal(canonicalWeekKey(null, "2026-05-02"), null);
  assert.equal(canonicalWeekKey("2026-04-05", null), null);
  assert.equal(canonicalWeekKey("garbage", "2026-04-11"), null);
  // Inverted range.
  assert.equal(canonicalWeekKey("2026-04-11", "2026-04-05"), null);
});

test("identical twin staged weeks collapse to the PAID one (Jul 19–25 api_sync vs daily_report)", () => {
  const rows: Row[] = [
    { label: "api_sync", weekStart: "2026-07-19", weekEnd: "2026-07-25", paid: false, staged: true, rank: 0 },
    { label: "daily_report", weekStart: "2026-07-19", weekEnd: "2026-07-25", paid: true, paidAt: "2026-07-28", staged: true, rank: 1 },
  ];
  assert.deepEqual(labels(dedupeOneRowPerWeek(rows, identify)), ["daily_report"]);
});

test("shifted-boundary duplicates collapse; newest upload (lowest rank) wins the tie", () => {
  const rows: Row[] = [
    { label: "weekly", weekStart: "2026-05-03", weekEnd: "2026-05-09", paid: false, staged: false, rank: 5 },
    { label: "backfill", weekStart: "2026-05-04", weekEnd: "2026-05-10", paid: false, staged: false, rank: 2 },
  ];
  assert.deepEqual(labels(dedupeOneRowPerWeek(rows, identify)), ["backfill"]);
});

test("staged beats engine-recovered when neither is paid", () => {
  const rows: Row[] = [
    { label: "recovered", weekStart: "2026-07-19", weekEnd: "2026-07-25", paid: false, staged: false, rank: 0 },
    { label: "staged", weekStart: "2026-07-19", weekEnd: "2026-07-25", paid: false, staged: true, rank: 9 },
  ];
  assert.deepEqual(labels(dedupeOneRowPerWeek(rows, identify)), ["staged"]);
});

test("both paid → later paidAt wins", () => {
  const rows: Row[] = [
    { label: "first-pay", weekStart: "2026-07-19", weekEnd: "2026-07-25", paid: true, paidAt: "2026-07-28", staged: true },
    { label: "corrected-pay", weekStart: "2026-07-19", weekEnd: "2026-07-25", paid: true, paidAt: "2026-07-30", staged: true },
  ];
  assert.deepEqual(labels(dedupeOneRowPerWeek(rows, identify)), ["corrected-pay"]);
});

test("distinct weeks all survive, order preserved, winner keeps the group's slot", () => {
  const rows: Row[] = [
    { label: "jul19-sync", weekStart: "2026-07-19", weekEnd: "2026-07-25", paid: false, staged: true, rank: 1 },
    { label: "jul12", weekStart: "2026-07-12", weekEnd: "2026-07-18", paid: true, paidAt: "2026-07-24", staged: true },
    { label: "jul19-report", weekStart: "2026-07-19", weekEnd: "2026-07-25", paid: true, paidAt: "2026-07-28", staged: true, rank: 0 },
    { label: "jul5", weekStart: "2026-07-05", weekEnd: "2026-07-11", paid: false, staged: true },
  ];
  // jul19 group occupies the FIRST slot (where the group first appeared).
  assert.deepEqual(labels(dedupeOneRowPerWeek(rows, identify)), [
    "jul19-report",
    "jul12",
    "jul5",
  ]);
});

test("non-week rows (multi-week files, missing dates) pass through untouched", () => {
  const rows: Row[] = [
    { label: "4-week-aggregate", weekStart: "2026-04-05", weekEnd: "2026-05-02", paid: false, staged: false },
    { label: "apr5-weekly", weekStart: "2026-04-05", weekEnd: "2026-04-11", paid: false, staged: false },
    { label: "dateless", weekStart: null, weekEnd: null, paid: true, paidAt: "2026-04-20" },
  ];
  assert.deepEqual(labels(dedupeOneRowPerWeek(rows, identify)), [
    "4-week-aggregate",
    "apr5-weekly",
    "dateless",
  ]);
});
