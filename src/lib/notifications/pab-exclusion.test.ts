import test from "node:test";
import assert from "node:assert/strict";
import {
  formatPabMonthLabel,
  buildPabExclusionNotification,
  applyPabExclusionPatch,
} from "./pab-exclusion";

test("formatPabMonthLabel formats a YYYY-MM key as 'Month YYYY'", () => {
  assert.equal(formatPabMonthLabel("2026-08"), "August 2026");
  assert.equal(formatPabMonthLabel("2026-01"), "January 2026");
});

test("formatPabMonthLabel falls back to the raw key when unparseable", () => {
  assert.equal(formatPabMonthLabel("not-a-key"), "not-a-key");
  assert.equal(formatPabMonthLabel("2026-13"), "2026-13");
});

test("buildPabExclusionNotification: excluded=true builds the pab.excluded card", () => {
  const n = buildPabExclusionNotification(true, "2026-08");
  assert.equal(n.type, "pab.excluded");
  assert.equal(n.tone, "neutral");
  assert.equal(n.title, "Excluded from Perfect Attendance Bonus");
  assert.match(n.message, /August 2026/);
  assert.match(n.message, /₱0 PAB/);
});

test("buildPabExclusionNotification: excluded=false builds the pab.restored card", () => {
  const n = buildPabExclusionNotification(false, "2026-08");
  assert.equal(n.type, "pab.restored");
  assert.equal(n.tone, "positive");
  assert.equal(n.title, "Perfect Attendance Bonus Restored");
  assert.match(n.message, /August 2026/);
});

test("applyPabExclusionPatch: adding a new email to an empty map excludes it and reports changed", () => {
  const current = new Map();
  const result = applyPabExclusionPatch(current, "2026-08", "Jane@Example.com", true);
  assert.equal(result.wasExcluded, false);
  assert.equal(result.changed, true);
  assert.deepEqual(result.nextExclusions, { "2026-08": ["jane@example.com"] });
});

test("applyPabExclusionPatch: excluding an already-excluded email is a no-op state change", () => {
  const current = new Map([["2026-08", new Set(["jane@example.com"])]]);
  const result = applyPabExclusionPatch(current, "2026-08", "jane@example.com", true);
  assert.equal(result.wasExcluded, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.nextExclusions, { "2026-08": ["jane@example.com"] });
});

test("applyPabExclusionPatch: un-excluding removes the email and drops the month when empty", () => {
  const current = new Map([["2026-08", new Set(["jane@example.com"])]]);
  const result = applyPabExclusionPatch(current, "2026-08", "jane@example.com", false);
  assert.equal(result.wasExcluded, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.nextExclusions, {});
});

test("applyPabExclusionPatch: other months are preserved untouched", () => {
  const current = new Map([
    ["2026-07", new Set(["old@example.com"])],
    ["2026-08", new Set(["jane@example.com"])],
  ]);
  const result = applyPabExclusionPatch(current, "2026-08", "mark@example.com", true);
  assert.deepEqual(result.nextExclusions, {
    "2026-07": ["old@example.com"],
    "2026-08": ["jane@example.com", "mark@example.com"],
  });
});

test("applyPabExclusionPatch: un-excluding an email that isn't excluded is a no-op state change", () => {
  const current = new Map([["2026-08", new Set(["jane@example.com"])]]);
  const result = applyPabExclusionPatch(current, "2026-08", "mark@example.com", false);
  assert.equal(result.wasExcluded, false);
  assert.equal(result.changed, false);
  assert.deepEqual(result.nextExclusions, { "2026-08": ["jane@example.com"] });
});

test("applyPabExclusionPatch: removing one email from a month with several preserves the rest", () => {
  const current = new Map([["2026-08", new Set(["jane@example.com", "mark@example.com", "sam@example.com"])]]);
  const result = applyPabExclusionPatch(current, "2026-08", "mark@example.com", false);
  assert.equal(result.wasExcluded, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.nextExclusions, { "2026-08": ["jane@example.com", "sam@example.com"] });
});
