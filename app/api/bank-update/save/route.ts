import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { getPayrollDispatchLock } from "@/lib/supabase/payroll-dispatch-lock";
import { invalidateRateProfilesCache } from "@/lib/supabase/employee-rate-profiles";
import { resolveSessionToken, findActiveEmployeeByEmail } from "@/lib/bank-update/otp";
import { sendBankUpdatePayrollEmail } from "@/lib/bank-update/notify-email";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { insertBankUpdateHistory } from "@/lib/supabase/bank-update-history";
import { pulseBankChanges } from "@/lib/supabase/app-settings";
import { escapeLikePattern } from "@/lib/db/like-escape";
import { maskFieldValue } from "@/lib/bank-update/mask-field";
import { sendFromMismatch, sendFromMismatchSentence } from "@/lib/employee-payment-processors";
import { resolveEffectivePayoutProcessor } from "@/lib/employee/payout-completeness";
import { readPayoutTrackRecord } from "@/lib/supabase/payout-track-record";
import {
  SELF_SERVICE_PAYOUT_FIELDS,
  assessPayoutChange,
  attestationAlertSentences,
  buildPayoutAttestation,
  judgePayoutChange,
  type PayoutChangeAttestation,
  type PayoutSafetyAnswers,
} from "@/lib/banking/payout-change-safety";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Payout fields an employee may set via the external link. These are exactly
 * the bank/payout columns of employee_ids — name, work_email and personal_email
 * are NOT editable here (identity is fixed by the verified session). This list
 * also mirrors the fields blocked while payroll is locked.
 */
const ALLOWED_FIELDS = [
  "preferred_processor",
  "bank_name",
  "account_holder_name",
  "account_number",
  "routing_number",
  "alt_bank_name",
  "alt_account_holder_name",
  "alt_account_number",
  "alt_routing_number",
  "hurupay_email",
  "wepay_email",
  "higlobe_email",
  "higlobe_account_name",
  "wise_email",
  "wise_tag",
  "phone_number",
  "swift_code",
  "full_address",
  "preferred_bank_slot",
];
const ALLOWED_PROCESSORS = new Set(["hurupay", "wepay", "higlobe", "wise", "jeeves", "wires"]);
const ALLOWED_BANK_SLOTS = new Set(["primary", "alternative"]);

function derivePlaceholderName(email: string): string {
  const local = email.split("@")[0]?.trim() ?? "employee";
  const parts = local.split(/[._\-+]+/).filter(Boolean);
  if (parts.length === 0) return "Employee";
  return parts.map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()).join(" ");
}

function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || null;
  return req.headers.get("x-real-ip");
}

/** Notify Accounting/CEO/Admin that an employee self-updated their payout details.
 *  `mismatch` names an Accounting-set sending bank this save leaves out of step
 *  with the receiving channel (the 1:1 rule) — this page never touches the
 *  sending bank, so the alert is how Accounting hears it needs changing. Same
 *  wording as the dashboard route's alert (`sendFromMismatchSentence`).
 *  `attestation` adds what the employee confirmed about a flagged account (a
 *  card-shaped number, a holder who is not them) and the record of the account
 *  they left, as sentences and flags, never values. The mismatch title keeps
 *  precedence; a flagged change without one is titled "check the new account". */
async function notifyReviewers(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  workEmail: string,
  displayName: string | null,
  changedFields: string[],
  mismatch: ReturnType<typeof sendFromMismatch>,
  attestation: PayoutChangeAttestation | null,
): Promise<void> {
  if (!supabase) return;
  try {
    const { data: roleRows } = await supabase
      .from("employee_roles")
      .select("work_email")
      .in("role", ["admin", "accounting", "ceo"])
      .is("revoked_at", null);
    const recipients = Array.from(
      new Set(
        (roleRows ?? [])
          .map((r: { work_email?: string | null }) => (r.work_email ?? "").trim().toLowerCase())
          .filter(Boolean),
      ),
    );
    if (recipients.length === 0) return;
    const base = `${displayName || workEmail} updated their bank & payout details via the external link.`;
    const sentences = [
      base,
      ...(mismatch ? [sendFromMismatchSentence(mismatch)] : []),
      ...(attestation ? attestationAlertSentences(attestation) : []),
    ];
    const title = mismatch
      ? "Bank details updated — sending bank no longer matches"
      : attestation && attestation.flags.length > 0
        ? "Bank details updated — check the new account"
        : "Bank details updated";
    await supabase.from("employee_notifications").insert(
      recipients.map((to) => ({
        recipient_email: to,
        type: "people.banking.self_updated",
        tone: "neutral",
        title,
        message: sentences.join(" "),
        details: {
          work_email: workEmail,
          via: "external_link",
          fields: changedFields,
          ...(mismatch ? { send_from_mismatch: { send_from: mismatch.sendFrom, receiving: mismatch.receiving } } : {}),
          ...(attestation ? { safety: attestation } : {}),
        },
      })),
    );
  } catch {
    // Notification failure must never fail the save.
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const ip = clientIp(req);

    // Identity comes ONLY from the verified session token — never from the
    // client — so a guessed work email can't redirect anyone's salary.
    const workEmail = await resolveSessionToken(String(body.session_token ?? ""));
    if (!workEmail) {
      return NextResponse.json(
        { error: "Your verification expired. Please request a new code and try again." },
        { status: 401 },
      );
    }

    const supabase = createSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "SUPABASE_SERVICE_ROLE_KEY is required to save bank details." },
        { status: 500 },
      );
    }

    // Build + validate the update from the allowed payout fields only.
    const update: Record<string, string | null> = {};
    for (const key of ALLOWED_FIELDS) {
      if (body[key] === undefined) continue;
      const val = body[key];
      const trimmed = val != null && String(val).trim() !== "" ? String(val).trim() : null;
      if (key === "preferred_processor" && trimmed != null && !ALLOWED_PROCESSORS.has(trimmed)) {
        return NextResponse.json({ error: `Invalid payment method: ${trimmed}` }, { status: 400 });
      }
      if (key === "preferred_bank_slot" && trimmed != null && !ALLOWED_BANK_SLOTS.has(trimmed)) {
        return NextResponse.json({ error: `Invalid bank slot: ${trimmed}` }, { status: 400 });
      }
      update[key] = trimmed;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "No payout details to save." }, { status: 400 });
    }

    // Every field here is a payroll-relevant field, so any save is blocked while
    // Accounting has the dispatch locked (prevents mid-cycle salary redirects).
    const lock = await getPayrollDispatchLock();
    if (lock.locked) {
      return NextResponse.json(
        {
          error:
            "Payroll is being processed right now, so bank details are temporarily locked. Please try again later.",
        },
        { status: 423 },
      );
    }

    const changedFields = Object.keys(update);
    // Resolve the active employee once (reused for bootstrap, audit, notify).
    const match = await findActiveEmployeeByEmail(workEmail);
    // Escaped, case-insensitive exact match on the verified work email.
    const emailPattern = escapeLikePattern(workEmail);

    // Snapshot the CURRENT payout record BEFORE the update overwrites it — so the
    // People-tab feed can show a masked before→after, and so the safety gate below
    // can tell what this save actually changes. The WHOLE record is read (not just
    // the posted fields): which account the money goes to depends on the slot and
    // the rail too. Best-effort: on an un-migrated env (missing column) or a
    // first-time setup (no row) this resolves empty, every "before" is null, and
    // the gate reads everything as changed, so it asks rather than skips.
    // `.limit(1)` (not maybeSingle) tolerates the known same-email row collisions.
    // The stored sending bank rides along for the reviewer alert's mismatch line
    // and the effective rail — never into `changes`.
    const beforeRow: Record<string, unknown> = await (async () => {
      const { data } = await supabase
        .from("employee_ids")
        .select([...SELF_SERVICE_PAYOUT_FIELDS, "bank_preferred", "name", "personal_email"].join(", "))
        .ilike("work_email", emailPattern)
        .limit(1);
      return (Array.isArray(data) && data[0] ? data[0] : {}) as Record<string, unknown>;
    })();

    // PAYOUT CHANGE SAFETY (Kane, 2026-10-07). A change is refused unless the
    // employee acknowledged the CURRENT bank-change notice, and — when the new
    // account looks like a card number, or its holder does not read as them —
    // confirmed that separately. The names judged against are the roster's and
    // the payout row's own, never anything from the body. See
    // payout-change-safety.ts and update-bank-info.md § Payout change safety.
    const answers: PayoutSafetyAnswers = {
      payout_notice_ack: body.payout_notice_ack,
      confirm_holder_is_self: body.confirm_holder_is_self,
      confirm_not_card_number: body.confirm_not_card_number,
    };
    const verdict = judgePayoutChange(
      assessPayoutChange(beforeRow, update, [
        match?.name ?? null,
        typeof beforeRow.name === "string" ? beforeRow.name : null,
      ]),
      answers,
    );
    if (!verdict.ok) {
      // The record that the employee WAS warned, even though nothing was saved.
      await insertAuditLog({
        user_name: match?.name || workEmail,
        user_role: "employee (external link)",
        action: "bank_update.safety_refused",
        resource: "employee_ids",
        resource_id: workEmail,
        details: { via: "external_link", code: verdict.code, flags: verdict.assessment.flags },
        ip_address: ip,
      });
      return NextResponse.json(
        { error: verdict.error, code: verdict.code, flags: verdict.assessment.flags },
        { status: 400 },
      );
    }
    // How the account being LEFT had done — counts only, for the attestation and
    // Accounting's alert. Read only when the destination actually moves.
    const previousTrack = verdict.assessment.destinationChanged
      ? await readPayoutTrackRecord({
          emails: [workEmail, match?.personalEmail, beforeRow.personal_email as string | null | undefined],
          row: beforeRow,
          rail: resolveEffectivePayoutProcessor(beforeRow),
        })
      : null;
    const attestation = verdict.assessment.changed
      ? buildPayoutAttestation(verdict.assessment, answers, previousTrack)
      : null;
    // Advisory, like the dashboard route: the 1:1 rule is enforced where the
    // sending bank is SET (People → Banking); a save here only reports it.
    const mismatch =
      "preferred_processor" in update
        ? sendFromMismatch(
            update.preferred_processor,
            typeof beforeRow.bank_preferred === "string" ? beforeRow.bank_preferred : null,
          )
        : null;

    // Update the canonical employee_ids row.
    const { data: updatedRows, error: updateError } = await supabase
      .from("employee_ids")
      .update(update)
      .ilike("work_email", emailPattern)
      .select("employee_id");

    if (updateError) {
      return NextResponse.json({ error: explain(updateError.message) }, { status: 500 });
    }

    let created = false;
    if (!updatedRows || updatedRows.length === 0) {
      // Active employee without an employee_ids row yet — bootstrap one.
      const insertRow: Record<string, string | null> = {
        employee_id: `SELF-${randomUUID().replace(/-/g, "").slice(0, 14).toUpperCase()}`,
        name: match?.name || derivePlaceholderName(workEmail),
        work_email: workEmail,
        personal_email: match?.personalEmail ?? null,
        ...update,
      };
      const { error: insertError } = await supabase.from("employee_ids").insert(insertRow);
      if (insertError) {
        // Possible race: a row appeared — retry the update once.
        const { data: retry, error: retryErr } = await supabase
          .from("employee_ids")
          .update(update)
          .ilike("work_email", emailPattern)
          .select("employee_id");
        if (retryErr) return NextResponse.json({ error: explain(retryErr.message) }, { status: 500 });
        if (!retry || retry.length === 0) {
          return NextResponse.json({ error: explain(insertError.message) }, { status: 500 });
        }
      } else {
        created = true;
      }
    }

    // Best-effort: stamp the self-update time for the People tab. The query
    // builder RESOLVES (doesn't throw) with { error } when the column is absent
    // on an un-migrated env, so we capture and ignore it — the bank details
    // above are already saved either way.
    const { error: stampErr } = await supabase
      .from("employee_ids")
      .update({ bank_last_self_updated_at: new Date().toISOString() })
      .ilike("work_email", emailPattern);
    if (stampErr) {
      /* column may not exist yet (pre-migration) — non-fatal */
    }

    invalidateRateProfilesCache();

    // Masked before→after for each written field (values are masked HERE, so the
    // audit trail never stores a full account number). `changed` is computed on
    // the RAW values so it stays accurate even if two distinct values mask alike.
    const changes = changedFields.map((field) => {
      const rawBefore = beforeRow[field] != null ? String(beforeRow[field]) : null;
      const rawAfter = update[field];
      return {
        field,
        before: maskFieldValue(field, rawBefore),
        after: maskFieldValue(field, rawAfter),
        changed: (rawBefore ?? "").trim() !== (rawAfter ?? "").trim(),
      };
    });

    // Awaited, but best-effort BY RULING (Kane, 2026-10-08, item 266 #3): a
    // payout change still lands when its trail cannot be written, because a
    // logging outage must never stop someone changing where they are paid. The
    // attestation is on this row AND the history row below, so it is lost only
    // when both writes fail. See update-bank-info.md § Failure modes.
    await insertAuditLog({
      user_name: match?.name || workEmail,
      user_role: "employee (external link)",
      action: "bank_update.saved",
      resource: "employee_ids",
      resource_id: workEmail,
      details: {
        via: "external_link",
        fields: changedFields,
        processor: update.preferred_processor ?? null,
        created,
        changes,
        ...(attestation ? { safety: attestation } : {}),
      },
      ip_address: ip,
    });
    // Best-effort: the dedicated, non-clearable history table (unlike audit_log,
    // which any admin can truncate). Must not fail the save on an un-migrated env.
    await insertBankUpdateHistory({
      work_email: workEmail,
      employee_name: match?.name ?? null,
      fields: changedFields,
      changes,
      processor: (update.preferred_processor as string | null) ?? null,
      created_new: created,
      via: "external_link",
      ip_address: ip,
      safety: attestation,
    }).catch(() => undefined);
    await notifyReviewers(supabase, workEmail, match?.name ?? null, changedFields, mismatch, attestation);
    // Nudge the People-tab "Bank changes" live feed to refetch instantly. The
    // audit row above is the feed's source; this pulse just makes it real-time.
    await pulseBankChanges();

    // Email the payroll team (field names only — never account values). Best-effort.
    await sendBankUpdatePayrollEmail({
      employeeName: match?.name ?? null,
      workEmail,
      fields: changedFields,
      processor: update.preferred_processor ?? null,
      createdNew: created,
    }).catch(() => undefined);

    return NextResponse.json({ success: true, created });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function explain(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("schema cache") || (lower.includes("column") && lower.includes("employee_ids"))) {
    return "The payout columns aren't fully set up yet. Please contact HR/Accounting.";
  }
  if (lower.includes("row-level security") || lower.includes("permission denied")) {
    return "The server couldn't save your details due to a permissions issue. Please contact HR/Accounting.";
  }
  return "We couldn't save your details. Please try again, or contact HR/Accounting.";
}
