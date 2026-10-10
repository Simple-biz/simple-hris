import test from "node:test";
import assert from "node:assert/strict";
import {
  collapseOffboardedRows,
  isoDay,
  ledgerAddresses,
  matchesRosterQuery,
  mergeLedgerLeavers,
  rankRosterMatches,
  rosterMatchNote,
  samePerson,
  type ActiveHolder,
  type LedgerLeaverRow,
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

/* ── The Offboarded LEDGER (2026-10-09) ──────────────────────────────────────
 * Kane: "Admin - Penny AI - Does not know about the Offboarded data". Measured
 * that day: the master-list stamps reached 1,520 of the ledger's 4,462 rows, so
 * 2,810 recorded departures were "not in the system". Each class below is a way
 * the merge could go wrong.
 */

const ledger = (over: Partial<LedgerLeaverRow> = {}): LedgerLeaverRow => ({
  name: "Moe, John",
  work_email: "johnm@simple.biz",
  personal_email: "john.moe@example.com",
  department: null,
  off_boarded_at: "2026-03-02T00:00:00+00:00",
  off_boarded_reason: "Performance",
  off_boarded_by: null,
  ...over,
});

const holder = (over: Partial<ActiveHolder> = {}): ActiveHolder => ({
  name: "Mondejar, Adrian",
  work_email: "adrianmo@simple.biz",
  personal_email: "adrian.mondejar@example.com",
  ...over,
});

test("CLASS 7: a leaver recorded ONLY on the ledger is findable, labelled, and its note says there is no master row", () => {
  const out = mergeLedgerLeavers([ledger()], [], [holder()]);
  assert.equal(out.length, 1);
  const m = out[0]!;
  assert.equal(m.status, "offboarded");
  assert.equal(m.off_boarded_at, "2026-03-02");
  assert.equal(m.off_boarded_reason, "Performance");
  assert.deepEqual(m.recorded_in, ["offboarded_ledger"]);
  assert.equal(m.work_email_now_held_by, undefined);
  assert.equal(matchesRosterQuery(m, "moe, john"), true);
  assert.equal(matchesRosterQuery(m, "johnm@simple.biz"), true);
  const note = rosterMatchNote([m]) ?? "";
  assert.match(note, /OFF-BOARDED since 2026-03-02/);
  assert.match(note, /ONLY on the Offboarded ledger/);
  assert.match(note, /does not mean they are unknown/);
});

test("CLASS 7: an undated ledger departure is still a leaver, and the note says the date is not recorded", () => {
  const m = mergeLedgerLeavers([ledger({ off_boarded_at: null })], [], [])[0]!;
  assert.equal(m.off_boarded_at, null);
  assert.match(rosterMatchNote([m]) ?? "", /departure date not recorded/);
});

test("CLASS 8: a ledger row for someone already stamped JOINS their record — one person, both sources, latest departure wins", () => {
  const master = collapseOffboardedRows([stamped()], new Set());
  const out = mergeLedgerLeavers(
    [
      ledger({ name: "Manansala, Adrian Neil", work_email: "adrianm@simple.biz", personal_email: null, department: "Lead Gen", off_boarded_at: "2026-09-14T13:48:10Z", off_boarded_reason: "Other", off_boarded_by: "jakec@simple.biz" }),
      ledger({ name: "Adrian Neil Manansala", work_email: "ADRIANM@simple.biz", personal_email: null, department: "Client VA", off_boarded_at: "2025-11-02", off_boarded_reason: "Resigned" }),
    ],
    master,
    [],
  );
  assert.equal(out.length, 1);
  const m = out[0]!;
  assert.deepEqual(m.recorded_in, ["master_list", "offboarded_ledger"]);
  assert.equal(m.off_boarded_at, "2026-09-14");
  assert.equal(m.off_boarded_by, "jakec@simple.biz");
  assert.deepEqual([...m.departments].sort(), ["Client VA", "Lead Gen"]);
  // The input candidates are not mutated.
  assert.deepEqual(master[0]!.recorded_in, ["master_list"]);
  assert.deepEqual(master[0]!.departments, ["Lead Gen"]);
});

test("CLASS 8: with no company work email, the same personal inbox is the same person", () => {
  const out = mergeLedgerLeavers(
    [ledger({ work_email: null, off_boarded_at: "2025-01-05" }), ledger({ work_email: null, name: "John M.", off_boarded_at: "2025-06-01" })],
    [],
    [],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.off_boarded_at, "2025-06-01");
});

test("CLASS 9: a ledger row for someone ACTIVE on that same address is dropped — the active match answers for it", () => {
  // Same address, same name: their earlier departure, not a leaver today.
  assert.equal(mergeLedgerLeavers([ledger({ name: "Adrian Mondejar", work_email: "adrianmo@simple.biz", personal_email: null })], [], [holder()]).length, 0);
  // No company work email, same personal inbox as an active person: the active match answers a query for it.
  assert.equal(mergeLedgerLeavers([ledger({ work_email: null, personal_email: "adrian.mondejar@example.com" })], [], [holder()]).length, 0);
});

test("CLASS 9: a re-hire under a NEW address keeps the earlier stint, labelled now_active_as — never 'not in the system', never a leaver", () => {
  // Measured 2026-10-09: 44 ledger rows; dropping them left 26 old addresses unreachable.
  const out = mergeLedgerLeavers([ledger({ name: "Someone Else Entirely", work_email: "old@simple.biz", personal_email: "ADRIAN.MONDEJAR@example.com" })], [], [holder()]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]!.now_active_as, ["adrianmo@simple.biz"]);
  assert.equal(out[0]!.work_email_now_held_by, undefined);
  assert.equal(matchesRosterQuery(out[0]!, "old@simple.biz"), true);
  const note = rosterMatchNote(out) ?? "";
  assert.match(note, /EARLIER STINT, not a leaver today/);
  assert.match(note, /ACTIVE again as adrianmo@simple\.biz/);
  assert.doesNotMatch(note, /Never describe them as a current employee/);
  assert.match(rosterMatchNote([active(), ...out]) ?? "", /EARLIER STINT of someone ACTIVE again/);
  // If the old address was ALSO re-issued, both facts are said.
  const both = mergeLedgerLeavers(
    [ledger({ name: "Adrian Mondejar", work_email: "krisd@simple.biz", personal_email: "adrian.mondejar@example.com" })],
    [],
    [holder(), holder({ name: "Roe, Kris Ann", work_email: "krisd@simple.biz", personal_email: "kris.roe@example.com" })],
  );
  assert.deepEqual(both[0]!.now_active_as, ["adrianmo@simple.biz"]);
  assert.deepEqual(both[0]!.work_email_now_held_by, ["Roe, Kris Ann"]);
  assert.match(rosterMatchNote(both) ?? "", /also RE-ISSUED to Roe, Kris Ann/);
});

test("CLASS 9: on an active address, a row with no name to tell the two apart is dropped, never shown as a leaver", () => {
  assert.equal(mergeLedgerLeavers([ledger({ name: null, work_email: "adrianmo@simple.biz", personal_email: null })], [], [holder()]).length, 0);
  assert.equal(mergeLedgerLeavers([ledger({ work_email: "adrianmo@simple.biz", personal_email: null })], [], [holder({ name: null })]).length, 0);
});

test("CLASS 10: the PREVIOUS holder of a re-issued address is their own leaver, naming who holds it now", () => {
  const out = mergeLedgerLeavers(
    [ledger({ name: "Doe, Jane Marie", work_email: "krisd@simple.biz", personal_email: "jane.doe.prev@example.com", off_boarded_at: "2026-01-12" })],
    [],
    [holder({ name: "Roe, Kris Ann", work_email: "krisd@simple.biz", personal_email: "kris.roe@example.com" })],
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]!.work_email_now_held_by, ["Roe, Kris Ann"]);
  const note = rosterMatchNote(out) ?? "";
  assert.match(note, /RE-ISSUED and now belongs to Roe, Kris Ann/);
  assert.match(note, /never attribute/);
  assert.match(rosterMatchNote([...out, active()]) ?? "", /RE-ISSUED to someone active/);
});

test("CLASS 10: two DIFFERENT names on one work email are two people, never collapsed into one (jamesc@ = three people)", () => {
  const out = mergeLedgerLeavers(
    [
      ledger({ name: "Cruz, James", work_email: "jamesc@simple.biz", personal_email: null, off_boarded_at: "2025-02-01" }),
      ledger({ name: "Castro, James Paul", work_email: "jamesc@simple.biz", personal_email: null, off_boarded_at: "2025-08-01" }),
    ],
    [],
    [],
  );
  assert.equal(out.length, 2);
});

test("CLASS 11: not-a-departure ledger rows (temporary pause, 'Active', cleanup markers) are never presented as leavers", () => {
  for (const reason of ["Temporary Pause", "temporary_pause", "Active", "duplicate_cleanup", "sheet_sync"]) {
    assert.equal(mergeLedgerLeavers([ledger({ off_boarded_reason: reason })], [], []).length, 0, reason);
  }
  assert.equal(mergeLedgerLeavers([ledger({ off_boarded_reason: null })], [], []).length, 1, "a blank reason is still a departure");
});

test("CLASS 12: a personal inbox in the work-email column is the PERSONAL address, never handed out as a work email", () => {
  assert.deepEqual(ledgerAddresses({ work_email: "John.Moe@Example.com", personal_email: null }), { work: null, personal: "john.moe@example.com" });
  assert.deepEqual(ledgerAddresses({ work_email: "johnm@simplesitecompany.com", personal_email: "p@x.com" }), { work: "johnm@simplesitecompany.com", personal: "p@x.com" });
  const m = mergeLedgerLeavers([ledger({ work_email: "john.moe@example.com", personal_email: null, name: "someone@gmail.com" })], [], [])[0]!;
  assert.equal(m.work_email, null);
  assert.equal(m.personal_email, "john.moe@example.com");
  assert.equal(m.name, null, "a name holding an @ is not a name");
});

test("CLASS 12: a row with no name and no address at all is skipped", () => {
  assert.equal(mergeLedgerLeavers([ledger({ name: null, work_email: null, personal_email: null })], [], []).length, 0);
});

test("CLASS 13: samePerson — the inbox, or the name by the paystub guard's token rule; a shared surname is not enough", () => {
  assert.equal(samePerson({ name: "Aireen Pinili", personal_email: null }, { name: "Pinili, Aireen Grace", personal_email: null }), true);
  assert.equal(samePerson({ name: "Sarmiento, Rodney Clark", personal_email: null }, { name: "Sarmiento, Rodney Ken", personal_email: null }), false);
  assert.equal(samePerson({ name: null, personal_email: "A@x.com" }, { name: "Z", personal_email: "a@x.com" }), true);
  assert.equal(samePerson({ name: null, personal_email: null }, { name: null, personal_email: null }), false);
});
