import test from "node:test";
import assert from "node:assert/strict";
import {
  NO_RECORD_NOTE,
  PROCESSING_GRACE_DAYS,
  employeePaymentStatus,
  isUnconfirmedNotUnpaid,
  type EmployeePaymentStatus,
} from "./pay-status";

/**
 * The reported bug and the two wrong fixes for it. Every case here is about one
 * question: what may an employee be told about a week whose paid mark is missing?
 */

const at = (o: Partial<Parameters<typeof employeePaymentStatus>[0]>) =>
  employeePaymentStatus({
    rawStatus: "pending",
    paidAt: null,
    scheduledPayDate: "2026-08-04",
    todayIso: "2026-08-19",
    ...o,
  });

/* ── The reported bug ────────────────────────────────────────────────────── */

test("BUG 2026-08-19: a pending week from seven weeks ago is NOT reported as owed", () => {
  // kaner@simple.biz, 2026-06-21 / 06-28 / 07-05: pending, no paid dispatch,
  // long past. Penny used to say "owed but not yet sent".
  const r = at({ scheduledPayDate: "2026-06-30", todayIso: "2026-08-19" });
  assert.equal(r.status, "not_recorded");
  assert.match(r.note, /no confirmed payment record/i);
  // The two forbidden readings:
  assert.equal(/owed/i.test(r.note), false, "must not claim the money is owed");
  assert.equal(/\bpaid\.$/i.test(r.note), false, "must not claim it was paid either");
});

test("the no-record note refuses BOTH conclusions and gives a next step", () => {
  assert.match(NO_RECORD_NOTE, /does NOT mean you were not paid/);
  assert.match(NO_RECORD_NOTE, /Accounting/);
  assert.match(NO_RECORD_NOTE, /Pay Stubs/);
});

/* ── Confirmed payments ──────────────────────────────────────────────────── */

test("a paid status is paid", () => {
  assert.equal(at({ rawStatus: "paid" }).status, "paid");
});

test("a disbursement timestamp outranks a stale status column", () => {
  // The status column is the unreliable half; a real paid_at is evidence.
  const r = at({ rawStatus: "pending", paidAt: "2026-08-13T14:40:44Z" });
  assert.equal(r.status, "paid");
});

test("an empty-string paid_at is not evidence", () => {
  assert.equal(at({ rawStatus: "pending", paidAt: "   " }).status, "not_recorded");
});

/* ── Nothing is late before its pay date ─────────────────────────────────── */

test("a week whose pay date is still ahead reads as SCHEDULED, not missing", () => {
  const r = at({ scheduledPayDate: "2026-08-25", todayIso: "2026-08-19" });
  assert.equal(r.status, "scheduled");
  assert.match(r.note, /Not due yet/);
  assert.match(r.note, /2026-08-25/);
  // This is the reassuring case — it must not carry the alarming note.
  assert.equal(r.note.includes("Accounting"), false);
});

test("the pay date itself still counts as due-today, not missing", () => {
  const r = at({ scheduledPayDate: "2026-08-19", todayIso: "2026-08-19" });
  assert.equal(r.status, "processing");
  assert.match(r.note, /not confirmed in the system yet/i);
});

/* ── The grace window ───────────────────────────────────────────────────── */

test("a just-passed pay date reads as PROCESSING through the grace window", () => {
  // A payroll run plus settlement takes a day or two. Calling Tuesday's pay
  // "unrecorded" on Wednesday manufactures the panic this module prevents.
  for (let d = 0; d <= PROCESSING_GRACE_DAYS; d++) {
    const today = new Date(Date.UTC(2026, 7, 4 + d)).toISOString().slice(0, 10);
    const r = at({ scheduledPayDate: "2026-08-04", todayIso: today });
    assert.equal(r.status, "processing", `${d} day(s) after the pay date`);
  }
  // One day past the window, it becomes an honest "no record".
  const after = new Date(Date.UTC(2026, 7, 4 + PROCESSING_GRACE_DAYS + 1))
    .toISOString()
    .slice(0, 10);
  assert.equal(at({ scheduledPayDate: "2026-08-04", todayIso: after }).status, "not_recorded");
});

/* ── Held rows ──────────────────────────────────────────────────────────── */

test("threshold and problem surface as ON HOLD, not as silence", () => {
  for (const raw of ["threshold", "problem", "THRESHOLD"]) {
    const r = at({ rawStatus: raw });
    assert.equal(r.status, "on_hold", raw);
    assert.match(r.note, /flagged/i);
    assert.match(r.note, /ask them/i);
  }
});

/* ── Degradation ────────────────────────────────────────────────────────── */

test("an underivable pay date falls to no-record, never to 'scheduled'", () => {
  // Claiming a week is upcoming when we cannot compute its schedule would be a
  // guess dressed as reassurance.
  for (const bad of [null, undefined, "", "   ", "not-a-date"]) {
    const r = at({ scheduledPayDate: bad as string | null });
    assert.equal(r.status, "not_recorded", `pay date ${JSON.stringify(bad)}`);
  }
});

test("an unknown status string is treated as unconfirmed, not as paid", () => {
  for (const raw of [null, undefined, "", "weird_new_value"]) {
    const r = at({ rawStatus: raw as string | null, scheduledPayDate: "2026-06-30" });
    assert.equal(r.status, "not_recorded", `status ${JSON.stringify(raw)}`);
  }
});

/* ── The classifier used by the prompt/field notes ──────────────────────── */

test("isUnconfirmedNotUnpaid marks exactly the two states Penny must hedge", () => {
  const all: EmployeePaymentStatus[] = [
    "paid",
    "scheduled",
    "processing",
    "not_recorded",
    "on_hold",
  ];
  const hedged = all.filter(isUnconfirmedNotUnpaid);
  assert.deepEqual(hedged, ["processing", "not_recorded"]);
});

/* ── The real production shape ──────────────────────────────────────────── */

test("kaner@simple.biz's eight measured weeks map as intended", () => {
  // Taken verbatim from the read-only probe on 2026-08-19 (Tuesday rail, so the
  // pay date is the Tuesday after each Saturday week-end).
  const weeks: { start: string; raw: string; paidAt: string | null; payDate: string }[] = [
    { start: "2026-08-09", raw: "pending", paidAt: null, payDate: "2026-08-18" },
    { start: "2026-08-02", raw: "paid", paidAt: "2026-08-13T14:40:44", payDate: "2026-08-11" },
    { start: "2026-07-26", raw: "paid", paidAt: "2026-08-06", payDate: "2026-08-04" },
    { start: "2026-07-19", raw: "paid", paidAt: "2026-07-28", payDate: "2026-07-28" },
    { start: "2026-07-12", raw: "paid", paidAt: "2026-07-24", payDate: "2026-07-21" },
    { start: "2026-07-05", raw: "pending", paidAt: null, payDate: "2026-07-14" },
    { start: "2026-06-28", raw: "pending", paidAt: null, payDate: "2026-07-07" },
    { start: "2026-06-21", raw: "pending", paidAt: null, payDate: "2026-06-30" },
  ];
  const got = weeks.map(
    (w) =>
      employeePaymentStatus({
        rawStatus: w.raw,
        paidAt: w.paidAt,
        scheduledPayDate: w.payDate,
        todayIso: "2026-08-19",
      }).status,
  );
  assert.deepEqual(got, [
    "processing", // 08-18 pay date, one day ago — a run may still be landing
    "paid",
    "paid",
    "paid",
    "paid",
    "not_recorded", // the three that used to read "owed but not yet sent"
    "not_recorded",
    "not_recorded",
  ]);
  // And not one of the eight reads as a debt owed to him.
  assert.equal(got.includes("scheduled"), false);
});
