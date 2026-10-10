import test from "node:test";
import assert from "node:assert/strict";
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  listOffboardedLedger,
  parseOffboardedListInput,
  type OffboardedListQuery,
  type PennyLedgerRow,
} from "./offboarded-list";
import type { ActiveHolder } from "./roster-match";

/**
 * `list_offboarded` (2026-10-09): the Offboarded ledger as a list. Each class
 * is a way a list answer could be wrong while looking right.
 */

let nextId = 1;
const row = (over: Partial<PennyLedgerRow> = {}): PennyLedgerRow => ({
  id: nextId++,
  name: "Moe, John",
  work_email: "johnm@simple.biz",
  personal_email: "john.moe@example.com",
  department: "Lead Gen",
  start_date: "3/4/2025",
  off_boarded_at: "2026-10-05T15:32:38.974+00:00",
  off_boarded_reason: "Performance",
  off_boarded_by: "jakec@simple.biz",
  origin: "hris",
  ...over,
});

const q = (over: Partial<OffboardedListQuery> = {}): OffboardedListQuery => ({
  since: null,
  until: null,
  department: null,
  reason: null,
  origin: null,
  search: null,
  limit: LIST_DEFAULT_LIMIT,
  ...over,
});

const parsed = (input: Record<string, unknown>) => {
  const p = parseOffboardedListInput(input);
  assert.equal(p.ok, true, JSON.stringify(p));
  return (p as { ok: true; query: OffboardedListQuery }).query;
};

/* ── CLASS 1: a filter that cannot be applied is an ERROR, never ignored ── */

test("CLASS 1: bad dates, an unknown reason or origin, and a one-letter search are refused by name", () => {
  for (const [input, field] of [
    [{ since: "2026-9-1" }, "since"],
    [{ until: "2026-02-30" }, "until"],
    [{ since: "2026-10-09", until: "2026-10-01" }, "since is after until"],
    [{ reason: "fired" }, "reason must be one of"],
    [{ origin: "csv" }, "origin must be one of"],
    [{ search: "a" }, "search must be at least 2"],
    [{ department: 7 }, "department must be a string"],
  ] as const) {
    const p = parseOffboardedListInput(input as Record<string, unknown>);
    assert.equal(p.ok, false, JSON.stringify(input));
    assert.match((p as { ok: false; errors: string[] }).errors.join("; "), new RegExp(field));
  }
});

test("CLASS 1: valid input parses; reason and origin accept any casing; limit is clamped to 1–50", () => {
  const v = parsed({ since: "2026-10-01", until: "2026-10-09", reason: "No Show", origin: "Google Sheet", department: " Lead Gen ", limit: 500 });
  assert.equal(v.reason, "no_show");
  assert.equal(v.origin, "google_sheet");
  assert.equal(v.department, "Lead Gen");
  assert.equal(v.limit, LIST_MAX_LIMIT);
  assert.equal(parsed({ limit: 0 }).limit, 1);
  assert.equal(parsed({}).limit, LIST_DEFAULT_LIMIT);
  assert.equal(parsed({ reason: "not_recorded" }).reason, "not_recorded");
});

/* ── CLASS 2: the window ───────────────────────────────────────────────── */

test("CLASS 2: since/until are inclusive on the UTC date; undated rows never match a window and are counted", () => {
  const rows = [
    row({ off_boarded_at: "2026-09-30T23:59:00Z" }),
    row({ off_boarded_at: "2026-10-01T00:00:00Z" }),
    row({ off_boarded_at: "2026-10-09T23:00:00Z" }),
    row({ off_boarded_at: "2026-10-10T00:00:01Z" }),
    row({ off_boarded_at: null }),
  ];
  const out = listOffboardedLedger(rows, q({ since: "2026-10-01", until: "2026-10-09" }), []);
  assert.equal(out.total, 2);
  assert.equal(out.undated_outside_date_filter, 1);
  assert.equal(out.undated_matches, 0);
  assert.deepEqual(out.by_month, { "2026-10": 2 });
  assert.equal(out.earliest, "2026-10-01");
  assert.equal(out.latest, "2026-10-09");
  // With no window the undated row IS a match, and is listed last.
  const all = listOffboardedLedger(rows, q(), []);
  assert.equal(all.total, 5);
  assert.equal(all.undated_matches, 1);
  assert.equal(all.rows.at(-1)!.off_boarded_at, null);
  assert.equal(all.rows[0]!.off_boarded_at, "2026-10-10");
});

/* ── CLASS 3: not-a-departure rows are counted apart, never as leavers ─── */

test("CLASS 3: temporary pauses and cleanup markers are excluded from the departures and counted separately", () => {
  const rows = [row(), row({ off_boarded_reason: "Temporary Pause" }), row({ off_boarded_reason: "duplicate_cleanup" }), row({ off_boarded_reason: "Active" })];
  const out = listOffboardedLedger(rows, q(), []);
  assert.equal(out.total, 1);
  assert.deepEqual(out.not_departures_excluded, { active: 1, duplicate_cleanup: 1, temporary_pause: 1 });
});

/* ── CLASS 4: the filters and the counts agree ─────────────────────────── */

test("CLASS 4: department is exact and case-insensitive; reason is the CATEGORY; a blank reason is not_recorded", () => {
  const rows = [
    row({ department: "Lead Gen", off_boarded_reason: "NCNS" }),
    row({ department: "lead gen", off_boarded_reason: "ncns" }),
    row({ department: "Lead Gen QC", off_boarded_reason: "Resigned" }),
    row({ department: null, off_boarded_reason: "No Show During Orientation" }),
    row({ department: "Client VA", off_boarded_reason: null }),
  ];
  assert.equal(listOffboardedLedger(rows, q({ department: "LEAD GEN" }), []).total, 2);
  assert.equal(listOffboardedLedger(rows, q({ reason: "ncns" }), []).total, 2);
  assert.equal(listOffboardedLedger(rows, q({ reason: "no_show" }), []).total, 1);
  assert.equal(listOffboardedLedger(rows, q({ reason: "not_recorded" }), []).total, 1);
  const all = listOffboardedLedger(rows, q(), []);
  assert.deepEqual(all.by_reason, { ncns: 2, no_show: 1, not_recorded: 1, resigned: 1 });
  assert.deepEqual(all.by_department.at(-1), { department: "not_recorded", count: 1 });
  // Every bucket adds back up to the total.
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  assert.equal(sum(all.by_reason), all.total);
  assert.equal(all.by_department.reduce((a, d) => a + d.count, 0), all.total);
  assert.equal(sum(all.by_origin), all.total);
  assert.equal(all.recorded_by.reduce((a, d) => a + d.count, 0), all.total);
});

test("CLASS 4: search matches name, work and personal address; origin filters hris vs google_sheet", () => {
  const rows = [row(), row({ name: "Doe, Jane", work_email: "krisd@simple.biz", personal_email: "jane.doe.prev@example.com", origin: "google_sheet" })];
  assert.equal(listOffboardedLedger(rows, q({ search: "doe" }), []).total, 1);
  assert.equal(listOffboardedLedger(rows, q({ search: "jane.doe.prev" }), []).total, 1);
  assert.equal(listOffboardedLedger(rows, q({ search: "johnm@" }), []).total, 1);
  assert.equal(listOffboardedLedger(rows, q({ origin: "google_sheet" }), []).total, 1);
});

/* ── CLASS 5: the page is honest about what it left out ────────────────── */

test("CLASS 5: limit caps the rows, never the counts — truncated says so", () => {
  const rows = Array.from({ length: 30 }, () => row());
  const out = listOffboardedLedger(rows, q({ limit: 5 }), []);
  assert.equal(out.rows.length, 5);
  assert.equal(out.total, 30);
  assert.equal(out.truncated, true);
  assert.equal(listOffboardedLedger(rows, q({ limit: 50 }), []).truncated, false);
});

/* ── CLASS 6: a recorded departure is never today's status ─────────────── */

const holder = (over: Partial<ActiveHolder> = {}): ActiveHolder => ({ name: "Roe, Kris Ann", work_email: "krisd@simple.biz", personal_email: "kris.roe@example.com", ...over });

test("CLASS 6: a row for someone back on the roster says so; a re-issued address names who holds it now", () => {
  const rows = [
    row({ name: "Doe, Jane Marie", work_email: "krisd@simple.biz", personal_email: "jane.doe.prev@example.com" }),
    row({ name: "Kris Ann Roe", work_email: "krisd@simple.biz", personal_email: null }),
    row(),
  ];
  const out = listOffboardedLedger(rows, q(), [holder()]);
  const byName = new Map(out.rows.map((r) => [r.name, r]));
  assert.deepEqual(byName.get("Doe, Jane Marie")!.work_email_now_held_by, ["Roe, Kris Ann"]);
  assert.equal(byName.get("Doe, Jane Marie")!.back_on_active_roster, undefined);
  assert.equal(byName.get("Kris Ann Roe")!.back_on_active_roster, true);
  assert.equal(byName.get("Moe, John")!.back_on_active_roster, undefined);
  assert.equal(byName.get("Moe, John")!.work_email_now_held_by, undefined);
  // Still a recorded departure — the roster labels it, never hides it.
  assert.equal(out.total, 3);
  assert.equal(out.back_on_active_roster, 1);
});

/* ── CLASS 7: what a row shows ─────────────────────────────────────────── */

test("CLASS 7: a personal inbox is never shown as the work email; a long sheet label is cut; start date is normalised", () => {
  const long = "Underperformance and repeated lateness after three coaching sessions with the team lead, see notes";
  const out = listOffboardedLedger([row({ work_email: "John.Moe@Example.com", personal_email: null, off_boarded_reason: long, start_date: "3/4/2025" })], q(), []);
  const r = out.rows[0]!;
  assert.equal(r.work_email, null);
  assert.equal(r.personal_email, "john.moe@example.com");
  assert.equal(r.reason, "other");
  assert.ok(r.reason_label!.length <= 80);
  assert.ok(r.reason_label!.endsWith("…"));
  assert.equal(r.start_date, "2025-03-04");
  // With a company work email the personal address is not repeated.
  assert.equal("personal_email" in listOffboardedLedger([row()], q(), []).rows[0]!, false);
});
