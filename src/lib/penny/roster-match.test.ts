import test from "node:test";
import assert from "node:assert/strict";
import {
  collapseOffboardedRows,
  isoDay,
  matchesRosterQuery,
  rankRosterMatches,
  rosterMatchNote,
  type OffboardedMasterRow,
  type RosterCandidate,
} from "./roster-match";

/**
 * `find_employee` now sees leavers. Each class below is a way that could go
 * wrong: a leaver read as current, a current person read as a leaver, a
 * duplicate row counted twice, or the ranking putting a leaver above the
 * person who actually still works here.
 */

const active = (over: Partial<RosterCandidate> = {}): RosterCandidate => ({
  name: "Mondejar, Adrian",
  work_email: "adrianmo@simple.biz",
  personal_email: "hadrian137426@gmail.com",
  department: "hsl:filing_specialist",
  employee_id: "2607-0277",
  status: "active",
  off_boarded_at: null,
  off_boarded_reason: null,
  off_boarded_by: null,
  departments: ["hsl:filing_specialist"],
  ...over,
});

const stamped = (over: Partial<OffboardedMasterRow> = {}): OffboardedMasterRow => ({
  name: 'Manansala, Adrian Neil "Neil"',
  work_email: "adrianm@simple.biz",
  personal_email: "adrian.manansala1795@gmail.com",
  department: "Lead Gen",
  employee_id: "2606-0400",
  off_boarded_at: "2026-09-14T13:48:09.265+00:00",
  off_boarded_reason: "other",
  off_boarded_by: "jakec@simple.biz",
  ...over,
});

/* ── CLASS 1: the matching rule is unchanged ─────────────────────────────── */

test("CLASS 1: an email query matches work or personal address exactly, case-insensitively", () => {
  const c = active();
  assert.equal(matchesRosterQuery(c, "ADRIANMO@simple.biz"), true);
  assert.equal(matchesRosterQuery(c, "hadrian137426@gmail.com"), true);
  // Exact, never substring: "adrianm@" must not match "adrianmo@".
  assert.equal(matchesRosterQuery(c, "adrianm@simple.biz"), false);
  assert.equal(matchesRosterQuery(c, ""), false);
});

test("CLASS 1: a name query matches the name substring or the work-email local part", () => {
  const c = active();
  assert.equal(matchesRosterQuery(c, "mondejar"), true);
  assert.equal(matchesRosterQuery(c, "adrianmo"), true);
  assert.equal(matchesRosterQuery(c, "manansala"), false);
});

/* ── CLASS 2: duplicate stamped rows collapse to ONE person ──────────────── */

test("CLASS 2: two stamped rows for one work email become one candidate carrying both departments", () => {
  const out = collapseOffboardedRows(
    [stamped(), stamped({ department: "hsl:attestation", employee_id: "2606-0486" })],
    new Set(),
  );
  assert.equal(out.length, 1);
  const m = out[0]!;
  assert.equal(m.status, "offboarded");
  assert.equal(m.off_boarded_at, "2026-09-14");
  assert.equal(m.off_boarded_by, "jakec@simple.biz");
  assert.deepEqual(m.departments.sort(), ["Lead Gen", "hsl:attestation"]);
});

test("CLASS 2: the LATEST stamp wins for date, reason and actor", () => {
  const out = collapseOffboardedRows(
    [
      stamped({ off_boarded_at: "2026-06-03", off_boarded_reason: "resigned", off_boarded_by: "hr@simple.biz" }),
      stamped({ off_boarded_at: "2026-09-14T13:48:09Z", off_boarded_reason: "other", off_boarded_by: "jakec@simple.biz" }),
    ],
    new Set(),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.off_boarded_at, "2026-09-14");
  assert.equal(out[0]!.off_boarded_reason, "other");
  assert.equal(out[0]!.off_boarded_by, "jakec@simple.biz");
});

test("CLASS 2: rows with no work email fall back to the personal email as the person key", () => {
  const out = collapseOffboardedRows(
    [stamped({ work_email: null }), stamped({ work_email: null, department: "Client VA" })],
    new Set(),
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]!.departments.sort(), ["Client VA", "Lead Gen"]);
});

/* ── CLASS 3: a current employee can never read as a leaver ──────────────── */

test("CLASS 3: a stamped duplicate beside an ACTIVE row is dropped — the active roster is the authority", () => {
  const out = collapseOffboardedRows([stamped({ work_email: "adrianmo@simple.biz" })], new Set(["adrianmo@simple.biz"]));
  assert.equal(out.length, 0);
});

/* ── CLASS 4: ranking — active first, then newest departure ──────────────── */

test("CLASS 4: active matches rank above off-boarded ones; leavers rank newest departure first", () => {
  const leaverOld = collapseOffboardedRows([stamped({ name: "Aaa, Old", work_email: "old@simple.biz", off_boarded_at: "2026-06-01" })], new Set())[0]!;
  const leaverNew = collapseOffboardedRows([stamped({ name: "Zzz, New", work_email: "new@simple.biz", off_boarded_at: "2026-09-14" })], new Set())[0]!;
  const ranked = rankRosterMatches([leaverOld, leaverNew, active({ name: "Zzz, Current" })]);
  assert.deepEqual(
    ranked.map((m) => `${m.status}:${m.work_email}`),
    ["active:adrianmo@simple.biz", "offboarded:new@simple.biz", "offboarded:old@simple.biz"],
  );
});

/* ── CLASS 5: the note Penny reads names the status ───────────────────────── */

test("CLASS 5: a lone off-boarded match is labelled with date, reason and recorder", () => {
  const m = collapseOffboardedRows([stamped()], new Set())[0]!;
  const note = rosterMatchNote([m]) ?? "";
  assert.match(note, /OFF-BOARDED since 2026-09-14/);
  assert.match(note, /reason: other/);
  assert.match(note, /jakec@simple\.biz/);
  assert.match(note, /get_offboarding_info/);
  assert.match(note, /Never describe them as a current employee/);
});

test("CLASS 5: zero matches says the search covered leavers too; a lone active match needs no note", () => {
  assert.match(rosterMatchNote([]) ?? "", /active OR off-boarded/);
  assert.equal(rosterMatchNote([active()]), undefined);
});

test("CLASS 5: several matches ask for disambiguation and count the leavers among them", () => {
  const leaver = collapseOffboardedRows([stamped()], new Set())[0]!;
  const note = rosterMatchNote([active(), leaver]) ?? "";
  assert.match(note, /Multiple matches/);
  assert.match(note, /1 of them is OFF-BOARDED/);
});

/* ── CLASS 6: date normalisation ─────────────────────────────────────────── */

test("CLASS 6: isoDay keeps the calendar date of a timestamp and rejects junk", () => {
  assert.equal(isoDay("2026-09-14T13:48:09.265+00:00"), "2026-09-14");
  assert.equal(isoDay("2026-09-14"), "2026-09-14");
  assert.equal(isoDay("09/14/26"), null);
  assert.equal(isoDay(null), null);
});
