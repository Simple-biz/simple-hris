import test from "node:test";
import assert from "node:assert/strict";
import {
  formatPabMonthLabel,
  buildPabExclusionNotification,
  applyPabExclusionPatch,
  applyPabExclusionBatchPatch,
  parsePabExclusionRequest,
  parseStoredPabExclusionsForWrite,
  PAB_EXCLUSION_BATCH_MAX,
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

// ── Bulk Ignore (PAB step, 2026-10-05) ──────────────────────────────────────

test("applyPabExclusionBatchPatch: one patch adds every person, keeps the month's existing entries and other months", () => {
  const current = new Map([
    ["2026-08", new Set(["old@example.com"])],
    ["2026-09", new Set(["kept@example.com"])],
  ]);
  const { nextExclusions, outcomes } = applyPabExclusionBatchPatch(
    current,
    "2026-09",
    ["A@example.com", "b@example.com"],
    true,
  );
  assert.deepEqual(nextExclusions, {
    "2026-08": ["old@example.com"],
    "2026-09": ["kept@example.com", "a@example.com", "b@example.com"],
  });
  assert.deepEqual(outcomes, [
    { email: "a@example.com", wasExcluded: false, changed: true },
    { email: "b@example.com", wasExcluded: false, changed: true },
  ]);
});

test("applyPabExclusionBatchPatch: an already-excluded person is reported unchanged — no audit row, no second notification", () => {
  const current = new Map([["2026-09", new Set(["a@example.com"])]]);
  const { outcomes } = applyPabExclusionBatchPatch(current, "2026-09", ["a@example.com", "b@example.com"], true);
  assert.deepEqual(outcomes, [
    { email: "a@example.com", wasExcluded: true, changed: false },
    { email: "b@example.com", wasExcluded: false, changed: true },
  ]);
});

test("applyPabExclusionBatchPatch: a person listed twice is one outcome, judged against the state BEFORE the batch", () => {
  const { nextExclusions, outcomes } = applyPabExclusionBatchPatch(
    new Map(),
    "2026-09",
    ["a@example.com", " A@Example.com "],
    true,
  );
  assert.deepEqual(nextExclusions, { "2026-09": ["a@example.com"] });
  assert.deepEqual(outcomes, [{ email: "a@example.com", wasExcluded: false, changed: true }]);
});

test("applyPabExclusionBatchPatch: the single patch is the batch of one", () => {
  const current = new Map([["2026-09", new Set(["x@example.com"])]]);
  const single = applyPabExclusionPatch(current, "2026-09", "y@example.com", true);
  const batch = applyPabExclusionBatchPatch(current, "2026-09", ["y@example.com"], true);
  assert.deepEqual(single.nextExclusions, batch.nextExclusions);
  assert.equal(single.wasExcluded, batch.outcomes[0].wasExcluded);
  assert.equal(single.changed, batch.outcomes[0].changed);
});

test("applyPabExclusionPatch: a blank email stores nothing and changes nothing", () => {
  const current = new Map([["2026-09", new Set(["x@example.com"])]]);
  const r = applyPabExclusionPatch(current, "2026-09", "   ", true);
  assert.deepEqual(r.nextExclusions, { "2026-09": ["x@example.com"] });
  assert.equal(r.changed, false);
});

test("parsePabExclusionRequest: the single-email body keeps working unchanged", () => {
  const r = parsePabExclusionRequest({ email: " Jane@Example.com ", monthKey: "2026-09", excluded: true });
  assert.deepEqual(r, { ok: true, monthKey: "2026-09", emails: ["jane@example.com"], excluded: true, batch: false });
});

test("parsePabExclusionRequest: the batch body normalizes and dedupes", () => {
  const r = parsePabExclusionRequest({ emails: ["A@x.com", "b@x.com", "a@x.com"], monthKey: "2026-09", excluded: true });
  assert.deepEqual(r, { ok: true, monthKey: "2026-09", emails: ["a@x.com", "b@x.com"], excluded: true, batch: true });
});

test("parsePabExclusionRequest: refuses rather than trims a bad batch", () => {
  const base = { monthKey: "2026-09", excluded: true };
  for (const emails of [[], ["a@x.com", ""], ["a@x.com", 7], "a@x.com"]) {
    const r = parsePabExclusionRequest({ ...base, emails });
    assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(emails)}`);
  }
  const over = Array.from({ length: PAB_EXCLUSION_BATCH_MAX + 1 }, (_, i) => `p${i}@x.com`);
  assert.equal(parsePabExclusionRequest({ ...base, emails: over }).ok, false);
  const atCap = Array.from({ length: PAB_EXCLUSION_BATCH_MAX }, (_, i) => `p${i}@x.com`);
  assert.equal(parsePabExclusionRequest({ ...base, emails: atCap }).ok, true);
});

test("parsePabExclusionRequest: both forms at once, a bad month, or a non-boolean excluded are refused", () => {
  assert.equal(parsePabExclusionRequest({ email: "a@x.com", emails: ["b@x.com"], monthKey: "2026-09", excluded: true }).ok, false);
  assert.equal(parsePabExclusionRequest({ emails: ["a@x.com"], monthKey: "2026-13", excluded: true }).ok, false);
  assert.equal(parsePabExclusionRequest({ emails: ["a@x.com"], monthKey: "2026-09", excluded: "true" }).ok, false);
  assert.equal(parsePabExclusionRequest({ monthKey: "2026-09", excluded: true }).ok, false);
  assert.equal(parsePabExclusionRequest(null).ok, false);
  assert.equal(parsePabExclusionRequest([]).ok, false);
});

test("parseStoredPabExclusionsForWrite: an absent or empty setting is an empty map — a first write may proceed", () => {
  for (const raw of [null, "", "   "]) {
    const r = parseStoredPabExclusionsForWrite(raw);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.exclusions.size, 0);
  }
});

test("parseStoredPabExclusionsForWrite: a malformed blob REFUSES the write instead of reading as empty", () => {
  for (const raw of ["{not json", "[]", "null", "\"a string\"", "42"]) {
    assert.equal(parseStoredPabExclusionsForWrite(raw).ok, false, `expected refusal for ${raw}`);
  }
});

test("parseStoredPabExclusionsForWrite: a good blob parses exactly as the pay-path reader does", () => {
  const r = parseStoredPabExclusionsForWrite(JSON.stringify({ "2026-09": ["A@x.com"], "2026-08": ["b@x.com"] }));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual([...r.exclusions.get("2026-09")!], ["a@x.com"]);
    assert.deepEqual([...r.exclusions.get("2026-08")!], ["b@x.com"]);
  }
});
