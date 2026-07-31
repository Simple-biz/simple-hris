import test from "node:test";
import assert from "node:assert/strict";
import { hasThirtyDaysFromStart, parseMasterStartDate } from "./dispatch-bonuses";

test("parseMasterStartDate reads the master sheet's US short format", () => {
  // Kane's actual master cell — the format that silently killed the Tech gate.
  const d = parseMasterStartDate("11/10/25");
  assert.ok(d);
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 10); // November
  assert.equal(d.getDate(), 10);
});

test("parseMasterStartDate reads 4-digit-year US and ISO formats", () => {
  const us = parseMasterStartDate("3/4/2024");
  assert.ok(us);
  assert.equal(us.getFullYear(), 2024);
  assert.equal(us.getMonth(), 2);
  assert.equal(us.getDate(), 4);

  const iso = parseMasterStartDate("2024-03-04");
  assert.ok(iso);
  assert.equal(iso.getTime(), us.getTime());

  // ISO with a time suffix still parses to the date part.
  assert.equal(parseMasterStartDate("2024-03-04T00:00:00Z")?.getDate(), 4);
});

test("parseMasterStartDate rejects garbage instead of guessing", () => {
  assert.equal(parseMasterStartDate(null), null);
  assert.equal(parseMasterStartDate(""), null);
  assert.equal(parseMasterStartDate("   "), null);
  assert.equal(parseMasterStartDate("13/45/25"), null); // impossible M/D
  assert.equal(parseMasterStartDate("2026-02-30"), null); // impossible ISO day
  assert.equal(parseMasterStartDate("Nov 10 2025"), null);
});

test("parsed start date drives the 30-day Tech gate the same way the wizard's does", () => {
  const start = parseMasterStartDate("11/10/25");
  assert.ok(start);
  // Week Monday Apr 6, 2026 — well past Nov 10 + 30d → eligible.
  assert.equal(hasThirtyDaysFromStart(new Date(2026, 3, 6), start), true);
  // Week Monday Nov 24, 2025 — only 14 days in → not yet.
  assert.equal(hasThirtyDaysFromStart(new Date(2025, 10, 24), start), false);
});
