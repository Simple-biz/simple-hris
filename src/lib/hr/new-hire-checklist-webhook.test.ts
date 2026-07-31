import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLockWebhookPayload,
  sanitizePersonalEmail,
} from "./new-hire-checklist-webhook";
import type { HrNewHireChecklistRow } from "@/lib/supabase/hr-new-hire-checklist";

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
    department: null,
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

  // Week-level email fields: Monday after the Sun-anchored start, US format.
  assert.equal(payload.start_date, "08/03/2026");
  assert.equal(payload.orientation_weekday, "Monday");
  assert.equal(sent[0]!.orientation_date, "08/03/2026");
});
