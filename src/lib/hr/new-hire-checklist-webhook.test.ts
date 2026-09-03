import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLockWebhookPayload,
  fireNewHireChecklistLockWebhook,
  sanitizePersonalEmail,
} from "./new-hire-checklist-webhook";
import { resolveOrientationDate } from "./orientation-date";
import type { HrNewHireChecklistRow } from "@/lib/supabase/hr-new-hire-checklist";

const NO_HOLIDAYS = new Map<string, string>();

/**
 * The week's orientation day, resolved the way the route resolves it. These
 * tests are about WHO gets the email; the date walk itself is covered in
 * orientation-date.test.ts.
 */
function orient(periodStart: string, holidays: Map<string, string> = NO_HOLIDAYS) {
  const r = resolveOrientationDate(periodStart, holidays);
  if (!r.ok) throw new Error(`test fixture: ${periodStart} did not resolve (${r.reason})`);
  return r;
}

function row(over: Partial<HrNewHireChecklistRow>): HrNewHireChecklistRow {
  return {
    id: "r1",
    period_start: "2026-08-02",
    position: 1,
    name: 'Cruz, Juan "JC"',
    personal_email: "juan@gmail.com",
    location: null,
    phone_number: null,
    date_of_interview: null,
    source: null,
    hired_by: null,
    department: "Lead Gen",
    country: null,
    referred_by: null,
    cell_edits: null,
    created_by: null,
    created_at: "2026-07-30T00:00:00Z",
    updated_at: "2026-07-30T00:00:00Z",
    ...over,
  } as HrNewHireChecklistRow;
}

test("sanitizePersonalEmail keeps a clean address untouched", () => {
  assert.deepEqual(sanitizePersonalEmail("juan@gmail.com"), {
    email: "juan@gmail.com",
    changed: false,
  });
  assert.deepEqual(sanitizePersonalEmail("  juan@gmail.com  "), {
    email: "juan@gmail.com",
    changed: false,
  });
});

test("sanitizePersonalEmail salvages annotation-polluted cells", () => {
  // The exact cell that killed the 2026-08-02 send at n8n item 40.
  assert.deepEqual(
    sanitizePersonalEmail("stephanielongno89@gmail.com (Facebook)"),
    { email: "stephanielongno89@gmail.com", changed: true },
  );
  assert.deepEqual(sanitizePersonalEmail("(referral) ana@yahoo.com"), {
    email: "ana@yahoo.com",
    changed: true,
  });
  assert.deepEqual(sanitizePersonalEmail("ana@yahoo.com(Facebook)"), {
    email: "ana@yahoo.com",
    changed: true,
  });
});

test("sanitizePersonalEmail rejects cells with no usable address", () => {
  // The exact cell that would have killed the re-run at item 68.
  assert.deepEqual(sanitizePersonalEmail("annalizaalgadepe420"), {
    email: null,
    changed: false,
  });
  assert.deepEqual(sanitizePersonalEmail(null), { email: null, changed: false });
  assert.deepEqual(sanitizePersonalEmail("   "), { email: null, changed: false });
  assert.deepEqual(sanitizePersonalEmail("juan@gmail"), {
    email: null,
    changed: false,
  });
});

test("buildLockWebhookPayload sends sanitized rows and skips unsalvageable ones", () => {
  const rows = [
    row({ id: "a", position: 1 }),
    row({
      id: "b",
      position: 2,
      name: 'Longno, Stephanie "Steph"',
      personal_email: "steph@gmail.com (Facebook)",
    }),
    row({
      id: "c",
      position: 3,
      name: 'Algadepe, Annaliza "Ann"',
      personal_email: "annalizaalgadepe420",
    }),
  ];
  const { payload, skipped } = buildLockWebhookPayload({
    period: null,
    periodStart: "2026-08-02",
    orientation: orient("2026-08-02"),
    periodEnd: null,
    rows,
    lockedBy: "kaner@simple.biz",
  });

  const sent = payload.rows as Array<Record<string, unknown>>;
  assert.equal(sent.length, 2);
  assert.equal(payload.row_count, 2);
  assert.equal(sent[0]!.personal_email, "juan@gmail.com");
  assert.equal(sent[1]!.personal_email, "steph@gmail.com");
  // hire_index stays the row's position in the FULL week so a resend lines up
  // with the original run's item numbering.
  assert.equal(sent[1]!.hire_index, 2);

  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.id, "c");
  assert.equal(skipped[0]!.personal_email, "annalizaalgadepe420");
  assert.equal(skipped[0]!.reason, "invalid_email");

  // Week-level email fields: Monday after the Sun-anchored start, US format.
  assert.equal(payload.start_date, "08/03/2026");
  assert.equal(payload.orientation_weekday, "Monday");
  assert.equal(sent[0]!.orientation_date, "08/03/2026");
});

// ── Lead Gen only ─────────────────────────────────────────────────────────
// Orientation is a Lead Gen ritual and this email carries the Zoom link, so a
// hire in any other department must never receive it (2026-08-21: an HSL hire
// on the 2026-08-23 week did). The gate lives in the SENDER, not only in n8n.

test("buildLockWebhookPayload withholds hires who are not Lead Gen", () => {
  const rows = [
    row({ id: "a", position: 1, name: 'Cruz, Juan "JC"', department: "Lead Gen" }),
    row({
      id: "b",
      position: 2,
      name: 'Giducos, Vera "Vera"',
      personal_email: "veraargylle@gmail.com",
      department: "HSL",
    }),
    row({ id: "c", position: 3, name: 'Reyes, Ana "Ana"', department: "Accounting Team" }),
  ];
  const { payload, skipped } = buildLockWebhookPayload({
    period: null,
    periodStart: "2026-08-23",
    orientation: orient("2026-08-23"),
    periodEnd: null,
    rows,
    lockedBy: "teal@simple.biz",
  });

  const sent = payload.rows as Array<Record<string, unknown>>;
  assert.equal(sent.length, 1);
  assert.equal(payload.row_count, 1);
  assert.equal(sent[0]!.id, "a");
  // Every sent row states the decision explicitly for the n8n filter.
  assert.equal(sent[0]!.lead_gen, true);

  assert.deepEqual(
    skipped.map((s) => [s.id, s.department, s.reason]),
    [
      ["b", "HSL", "not_lead_gen"],
      ["c", "Accounting Team", "not_lead_gen"],
    ],
  );
});

test("buildLockWebhookPayload fails CLOSED on a blank or unrecognised department", () => {
  const rows = [
    row({ id: "blank", position: 1, department: "" }),
    row({ id: "null", position: 2, department: null }),
    row({ id: "junk", position: 3, department: "Lead Gen Team" }),
    row({ id: "typo", position: 4, department: "leadgen" }),
  ];
  const { payload, skipped } = buildLockWebhookPayload({
    period: null,
    periodStart: "2026-08-23",
    orientation: orient("2026-08-23"),
    periodEnd: null,
    rows,
    lockedBy: "teal@simple.biz",
  });

  assert.equal((payload.rows as unknown[]).length, 0);
  assert.equal(payload.row_count, 0);
  assert.equal(skipped.length, 4);
  assert.ok(skipped.every((s) => s.reason === "not_lead_gen"));
});

test("buildLockWebhookPayload accepts every label that resolves to lead_gen", () => {
  // Parity with the CallTools orientation gate (isLeadGenDepartment): casing and
  // surrounding space never decide whether a Lead Gen hire is invited.
  for (const dept of ["Lead Gen", "lead gen", "  LEAD GEN  ", "Lead Generation"]) {
    const { payload, skipped } = buildLockWebhookPayload({
      period: null,
      periodStart: "2026-08-23",
    orientation: orient("2026-08-23"),
      periodEnd: null,
      rows: [row({ id: "a", position: 1, department: dept })],
      lockedBy: "teal@simple.biz",
    });
    assert.equal((payload.rows as unknown[]).length, 1, `${dept} should send`);
    assert.equal(skipped.length, 0, `${dept} should not be withheld`);
  }
});

test("a non-Lead-Gen hire with a broken email reports the department, not the email", () => {
  // The reason drives which toast HR sees: "fix the cell" vs "expected".
  const { skipped } = buildLockWebhookPayload({
    period: null,
    periodStart: "2026-08-23",
    orientation: orient("2026-08-23"),
    periodEnd: null,
    rows: [row({ id: "a", position: 1, department: "HSL", personal_email: "not-an-address" })],
    lockedBy: "teal@simple.biz",
  });
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.reason, "not_lead_gen");
});

test("the 2026-08-23 week: 78 Lead Gen hires send, the HSL hire does not", () => {
  // Regression guard shaped like the live incident (79 rows, one HSL).
  const week = Array.from({ length: 79 }, (_, i) =>
    row({
      id: `r${i}`,
      position: i + 1,
      personal_email: `hire${i}@gmail.com`,
      department: i === 66 ? "HSL" : "Lead Gen",
    }),
  );
  const { payload, skipped } = buildLockWebhookPayload({
    period: null,
    periodStart: "2026-08-23",
    orientation: orient("2026-08-23"),
    periodEnd: null,
    rows: week,
    lockedBy: "teal@simple.biz",
  });
  const sent = payload.rows as Array<Record<string, unknown>>;
  assert.equal(sent.length, 78);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.id, "r66");
  assert.ok(!sent.some((r) => r.department === "HSL"));
  // hire_index still counts the FULL week, so a resend lines up with n8n's
  // original item numbering (the withheld hire leaves a gap, by design).
  assert.equal(sent[66]!.hire_index, 68);
});

// ── Holiday-shifted orientation (2026-09-03) ───────────────────────────────

const LABOR_DAY = new Map([["2026-09-07", "Labor Day"]]);

test("a holiday Monday moves the emailed date, on EVERY row and the top level", () => {
  const rows = [
    row({ id: "a", position: 1, personal_email: "a@gmail.com" }),
    row({ id: "b", position: 2, personal_email: "b@gmail.com" }),
  ];
  const { payload } = buildLockWebhookPayload({
    period: null,
    periodStart: "2026-09-06",
    orientation: orient("2026-09-06", LABOR_DAY),
    periodEnd: null,
    rows,
    lockedBy: "teal@simple.biz",
  });

  assert.equal(payload.orientation_date, "09/08/2026");
  assert.equal(payload.orientation_weekday, "Tuesday");
  // start_date moves WITH it — the email calls this day "your first day" and
  // prints the start date directly above the orientation row.
  assert.equal(payload.start_date, "09/08/2026");

  const sent = payload.rows as Array<Record<string, unknown>>;
  assert.equal(sent.length, 2);
  for (const r of sent) {
    assert.equal(r.orientation_date, "09/08/2026");
    assert.equal(r.orientation_weekday, "Tuesday");
    assert.equal(r.start_date, "09/08/2026");
  }
});

test("the payload records WHY the date moved", () => {
  const { payload } = buildLockWebhookPayload({
    period: null,
    periodStart: "2026-09-06",
    orientation: orient("2026-09-06", LABOR_DAY),
    periodEnd: null,
    rows: [row({ id: "a", position: 1 })],
    lockedBy: "teal@simple.biz",
  });
  assert.equal(payload.orientation_shifted, true);
  assert.equal(payload.orientation_default_date, "09/07/2026");
  assert.equal(payload.orientation_shift_reason, "Moved from Monday (Sep 7) — Labor Day");
});

test("an unshifted week carries no shift reason", () => {
  const { payload } = buildLockWebhookPayload({
    period: null,
    periodStart: "2026-08-02",
    orientation: orient("2026-08-02"),
    periodEnd: null,
    rows: [row({ id: "a", position: 1 })],
    lockedBy: "teal@simple.biz",
  });
  assert.equal(payload.orientation_shifted, false);
  assert.equal(payload.orientation_shift_reason, null);
  assert.equal(payload.orientation_date, "08/03/2026");
});

test("an UNRESOLVED orientation sends NOTHING — never a silent fallback to Monday", async () => {
  // A failed holiday read must not degrade to the plain Monday: that is the
  // exact date this feature exists to avoid. No POST is attempted.
  for (const reason of ["calendar_unavailable", "no_weekday_left", "bad_period"] as const) {
    const res = await fireNewHireChecklistLockWebhook({
      period: null,
      periodStart: "2026-09-06",
      periodEnd: null,
      rows: [row({ id: "a", position: 1, personal_email: "a@gmail.com" })],
      lockedBy: "teal@simple.biz",
      orientation: { ok: false, reason, baseDate: "2026-09-07", skipped: [] },
    });
    assert.equal(res.fired, false, `${reason} must not fire`);
    assert.equal(res.count, 0);
    assert.equal(res.status, null);
    assert.ok(res.error && res.error.startsWith("No orientation email sent"), `${reason} must explain itself`);
    assert.equal(res.orientation.date, null);
    assert.equal(res.orientation.shifted, false);
  }
});
