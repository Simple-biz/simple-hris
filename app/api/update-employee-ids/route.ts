import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { getPayrollDispatchLock } from "@/lib/supabase/payroll-dispatch-lock";
import { invalidateRateProfilesCache } from "@/lib/supabase/employee-rate-profiles";
import { insertBankUpdateHistory } from "@/lib/supabase/bank-update-history";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { getSessionActor } from "@/lib/auth/session-actor";
import { normalizeSource, EMPLOYEE_DASHBOARD_SOURCE } from "@/lib/payroll/readiness-audit";
import { pulseBankChanges } from "@/lib/supabase/app-settings";
import { maskFieldValue } from "@/lib/bank-update/mask-field";
import {
  isBankPreferredChange,
  sendFromMismatch,
  sendFromMismatchSentence,
} from "@/lib/employee-payment-processors";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { authorizeEmailAccess, deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureEditAnyView } from "@/lib/auth/authorize-feature";

/** Fields blocked while Accounting has payroll dispatch locked (employees may still update personal_email). */
const BLOCKED_WHILE_PAYROLL_LOCKED = new Set([
  "preferred_processor",
  // Never writable on this route since 2026-09-24 (the sending bank is
  // Accounting's — see POST). Kept so the lock list stays the full payout set.
  "bank_preferred",
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
]);

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

/**
 * Notify Accounting/CEO/Admin that an employee self-updated their payout details
 * from the Employee Dashboard. Mirrors the external-link route's reviewer notify
 * (same `people.banking.self_updated` type) so both channels feed the same badge.
 *
 * `mismatch` is set when the save leaves the Accounting-set sending bank
 * incompatible with the receiving channel (the 1:1 rule). Since 2026-09-24 an
 * employee's receiving move never touches the sending bank, and this alert is
 * how Accounting hears it needs changing — so the title says so, not only the
 * message. Same type and `neutral` tone: the notifications CHECK rejects
 * anything else, silently.
 */
async function notifyReviewers(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
  workEmail: string,
  displayName: string | null,
  changedFields: string[],
  mismatch: ReturnType<typeof sendFromMismatch>,
): Promise<void> {
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
    const base = `${displayName || workEmail} updated their bank & payout details from the Employee Dashboard.`;
    await supabase.from("employee_notifications").insert(
      recipients.map((to) => ({
        recipient_email: to,
        type: "people.banking.self_updated",
        tone: "neutral",
        title: mismatch ? "Bank details updated — sending bank no longer matches" : "Bank details updated",
        message: mismatch ? `${base} ${sendFromMismatchSentence(mismatch)}` : base,
        details: {
          work_email: workEmail,
          via: "employee_dashboard",
          fields: changedFields,
          ...(mismatch ? { send_from_mismatch: { send_from: mismatch.sendFrom, receiving: mismatch.receiving } } : {}),
        },
      })),
    );
  } catch {
    // Notification failure must never fail the save.
  }
}

// `interceptBankPreferred` (which held an employee's sending-bank pick as a
// `bank_preferred_change_requests` row for Accounting → Issues) and its "needs
// approval" notifier were REMOVED 2026-09-24 with the approval gate itself: the
// sending bank is Accounting's alone, set in People → Banking, and POST below
// refuses a change to it. See bank-preferred-routing.md §3.

/**
 * After a successful Employee-Dashboard payout save, record it into the same
 * People-tab "Bank changes" surfaces the external-link route feeds: the audit
 * trail, the dedicated non-clearable history table, the reviewer notifications,
 * and the realtime pulse. All best-effort — none of it may fail the save. No-op
 * unless an actual bank/payout field changed.
 */
async function recordDashboardBankChange(opts: {
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>;
  req: Request;
  workEmail: string | null;
  displayName: string | null;
  bankChangedFields: string[];
  beforeRow: Record<string, unknown>;
  update: Record<string, string | null>;
  created: boolean;
  /** Where the change came from: "employee_dashboard" (self-service, default),
   *  "people_tab", or "payroll_wizard_readiness". Drives the audit `via` +
   *  the People-tab source label. */
  source: string;
  /** The signed-in actor who made the change (verified session). For a
   *  self-service edit this is the employee; for a staff-made fix it's the
   *  accountant — so the audit row is attributed to whoever actually acted. */
  actor: { user_name: string; user_role: string };
  /** The sending bank this save leaves mismatched with the receiving channel,
   *  if any — named in the reviewer alert (see `notifyReviewers`). */
  mismatch: ReturnType<typeof sendFromMismatch>;
}): Promise<void> {
  const { supabase, req, workEmail, displayName, bankChangedFields, beforeRow, update, created, source, actor, mismatch } = opts;
  if (bankChangedFields.length === 0 || !workEmail) return;

  const ip = clientIp(req);

  // Masked before→after per written field. Values are masked HERE so the trail
  // never stores a full account number. `changed` uses the RAW values so it's
  // exact even when two distinct values mask alike.
  const changes = bankChangedFields.map((field) => {
    const rawBefore = beforeRow[field] != null ? String(beforeRow[field]) : null;
    const rawAfter = update[field];
    return {
      field,
      before: maskFieldValue(field, rawBefore),
      after: maskFieldValue(field, rawAfter),
      changed: (rawBefore ?? "").trim() !== (rawAfter ?? "").trim(),
    };
  });

  // Best-effort: stamp the self-update time for the People tab (column may be
  // absent on an un-migrated env — resolves with { error }, which we ignore).
  await supabase
    .from("employee_ids")
    .update({ bank_last_self_updated_at: new Date().toISOString() })
    .eq("work_email", workEmail);

  // Attribute to whoever actually acted: the employee for a self-service edit,
  // the accountant for a People-tab / Payroll-Wizard fix. `subject_*` records
  // who the change is ABOUT so the trail keeps both. `via` = source so the
  // People-tab source label and the audit detail agree.
  const selfService = source === EMPLOYEE_DASHBOARD_SOURCE;
  await insertAuditLog({
    user_name: selfService ? displayName || workEmail : actor.user_name,
    user_role: selfService ? "employee (dashboard)" : actor.user_role,
    action: "bank_update.saved",
    resource: "employee_ids",
    resource_id: workEmail,
    details: {
      via: source,
      subject_name: displayName || workEmail,
      subject_email: workEmail,
      fields: bankChangedFields,
      processor: update.preferred_processor ?? null,
      created,
      changes,
    },
    ip_address: ip,
  }).catch(() => undefined);

  await insertBankUpdateHistory({
    work_email: workEmail,
    employee_name: displayName,
    fields: bankChangedFields,
    changes,
    processor: (update.preferred_processor as string | null) ?? null,
    created_new: created,
    via: source,
    ip_address: ip,
  }).catch(() => undefined);

  await notifyReviewers(supabase, workEmail, displayName, bankChangedFields, mismatch);

  // Nudge the People-tab "Bank changes" live feed to refetch instantly.
  await pulseBankChanges();
}

function explainEmployeeIdsError(message: string): string {
  const msg = message.trim();
  const lower = msg.toLowerCase();

  if (
    lower.includes("preferred_processor") ||
    lower.includes("hurupay_email") ||
    lower.includes("wepay_email") ||
    lower.includes("higlobe_email") ||
    lower.includes("higlobe_account_name") ||
    lower.includes("wise_email") ||
    lower.includes("wise_tag") ||
    lower.includes("phone_number") ||
    lower.includes("swift_code") ||
    lower.includes("full_address") ||
    lower.includes("preferred_bank_slot") ||
    lower.includes("schema cache") ||
    lower.includes("column") && lower.includes("employee_ids")
  ) {
    return [
      "Supabase employee_ids schema is missing one or more payout columns.",
      "Run references/add_preferred_processor.sql, references/add_processor_fields_to_employee_ids.sql, and references/add_preferred_bank_slot_to_employee_ids.sql in the Supabase SQL editor.",
      `Supabase said: ${msg}`,
    ].join(" ");
  }

  if (lower.includes("relation") && lower.includes("employee_ids")) {
    return `Supabase table employee_ids is missing. Supabase said: ${msg}`;
  }

  if (
    lower.includes("row-level security") ||
    lower.includes("permission denied") ||
    lower.includes("jwt")
  ) {
    return [
      "Supabase rejected the write due to permissions.",
      "Set SUPABASE_SERVICE_ROLE_KEY for this app's server environment or update your RLS policies.",
      `Supabase said: ${msg}`,
    ].join(" ");
  }

  return msg;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      work_email,
      personal_email,
      bootstrap_display_name: bootstrapDisplayNameRaw,
      source: sourceRaw,
      ...fields
    } = body as Record<string, unknown>;

    const bootstrap_display_name =
      typeof bootstrapDisplayNameRaw === "string" ? bootstrapDisplayNameRaw.trim() : "";
    // Where the edit originated. Defaults to self-service (the dashboard), which
    // preserves the existing behavior for every caller that doesn't send one.
    // NOTE: `source` is caller-supplied and only labels the change feed. It is
    // reconciled against the session below (a self edit can never claim to be
    // an accounting-made one), so it can't be used to forge attribution.
    const requestedSource = normalizeSource(sourceRaw, EMPLOYEE_DASHBOARD_SOURCE);

    if (!work_email && !personal_email) {
      return NextResponse.json(
        { error: "work_email or personal_email is required to identify the employee" },
        { status: 400 },
      );
    }

    // Self-or-elevated: an employee may only update their own bank/payout row;
    // elevated (HR/payroll/admin) roles may update anyone. Closes the
    // unauthenticated salary-redirect hole.
    const authz = await authorizeEmailAccess((work_email ?? personal_email) as string);
    if (!authz.ok) return deniedResponse(authz);

    // A CROSS-employee write here touches the same employee_ids bank columns as
    // PATCH /api/people/[email]/banking, which requires the `people` feature.
    // Plain elevation is too broad: hr_coordinator is elevated but is
    // deliberately excluded from rate visibility and the People tab, so without
    // this it could redirect anyone's salary through the back door.
    const isSelfEdit =
      authz.effectiveEmail.toLowerCase() === authz.sessionEmail.toLowerCase();
    if (!isSelfEdit) {
      const peopleAuthz = await requireFeatureEditAnyView('people');
      if (!peopleAuthz.ok) return deniedResponse(peopleAuthz);
    }

    // An employee editing their OWN row is always self-service, whatever the
    // body claimed — otherwise a self edit could pass source:"people_tab" and
    // show up in the People bank-changes feed as an accounting-made change.
    const source = isSelfEdit ? EMPLOYEE_DASHBOARD_SOURCE : requestedSource;

    // Verified actor (email + role) for attribution — the accountant on a
    // staff-made fix, the employee on a self-service edit.
    const actor = await getSessionActor();

    const supabase = createSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "SUPABASE_SERVICE_ROLE_KEY is required for /api/update-employee-ids writes." },
        { status: 500 },
      );
    }

    const allowed = [
      "name",
      "personal_email",
      "bank_name",
      "account_holder_name",
      "account_number",
      "routing_number",
      "alt_bank_name",
      "alt_account_holder_name",
      "alt_account_number",
      "alt_routing_number",
      // The RECEIVING channel. `bank_preferred` (the SENDING bank) is not on this
      // list: it is Accounting's alone since 2026-09-24 — see the check below.
      "preferred_processor",
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
    const ALLOWED_PROCESSORS = new Set([
      "hurupay",
      "wepay",
      "higlobe",
      "wise",
      "jeeves",
      "wires",
    ]);
    const ALLOWED_BANK_SLOTS = new Set(["primary", "alternative"]);
    const update: Record<string, string | null> = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        const val = fields[key];
        const trimmed = val != null && String(val).trim() !== "" ? String(val).trim() : null;
        if (key === "preferred_processor" && trimmed != null && !ALLOWED_PROCESSORS.has(trimmed)) {
          return NextResponse.json(
            { error: `Invalid preferred_processor: ${trimmed}` },
            { status: 400 },
          );
        }
        if (key === "preferred_bank_slot" && trimmed != null && !ALLOWED_BANK_SLOTS.has(trimmed)) {
          return NextResponse.json(
            { error: `Invalid preferred_bank_slot: ${trimmed}` },
            { status: 400 },
          );
        }
        update[key] = trimmed;
      }
    }

    const eqColumn = work_email ? "work_email" : "personal_email";
    const identifier = (work_email ?? personal_email) as string;

    // THE SENDING BANK IS ACCOUNTING'S (Kane, 2026-09-24): "all changes for the
    // sending bank should be here only in accounting and accounting will the
    // only one who will be responsible for changing it". Its one write path is
    // People → Banking (PATCH /api/people/[email]/banking), so this route
    // refuses a CHANGE from every caller, self-service and staff alike, out loud
    // rather than dropping it: no approval request is filed any more (the
    // Issues-tab gate is retired) and nothing is written. A page opened before the retirement
    // still posts the UNCHANGED stored value with every save; that is a no-op,
    // not a change, so it must not break the save. The check reads the live
    // value and fails CLOSED — an unreadable row is never assumed unchanged.
    if (fields.bank_preferred !== undefined) {
      const { data: storedRows, error: storedErr } = await supabase
        .from("employee_ids")
        .select("bank_preferred")
        .eq(eqColumn, identifier)
        .limit(1);
      if (storedErr) {
        return NextResponse.json(
          {
            error:
              "Could not check the current sending bank, so nothing was saved. Reload the page and try again.",
          },
          { status: 503 },
        );
      }
      const stored = (Array.isArray(storedRows) && storedRows[0]
        ? (storedRows[0] as { bank_preferred?: string | null }).bank_preferred
        : null) ?? null;
      if (isBankPreferredChange(fields.bank_preferred, stored)) {
        return NextResponse.json(
          {
            error:
              "The sending bank can only be changed by Accounting, in People → Banking. If this page was open before that change, reload it and save again.",
          },
          { status: 403 },
        );
      }
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const lock = await getPayrollDispatchLock();
    if (lock.locked) {
      const touchesBlocked = Object.keys(update).some((k) =>
        BLOCKED_WHILE_PAYROLL_LOCKED.has(k),
      );
      if (touchesBlocked) {
        return NextResponse.json(
          {
            error:
              "Payroll processing is in progress. Bank and payout details cannot be changed until accounting finishes.",
          },
          { status: 423 },
        );
      }
    }

    // Snapshot the CURRENT value of the bank fields being written, BEFORE the
    // update overwrites them, so the People-tab feed can show a masked
    // before→after. Best-effort.
    const snapshotFields = Object.keys(update).filter((k) =>
      BLOCKED_WHILE_PAYROLL_LOCKED.has(k),
    );
    // A receiving move no longer touches the sending bank (2026-09-24 — the
    // employee-side 1:1 mirror that FILED a matching change is gone), so read the
    // stored one alongside: the reviewer alert names a mismatch this save leaves.
    if ("preferred_processor" in update) snapshotFields.push("bank_preferred");
    let beforeRow: Record<string, unknown> = {};
    if (snapshotFields.length > 0) {
      const { data } = await supabase
        .from("employee_ids")
        .select([...snapshotFields, "name"].join(", "))
        .eq(eqColumn, identifier)
        .limit(1);
      beforeRow = (Array.isArray(data) && data[0] ? data[0] : {}) as Record<string, unknown>;
    }

    const displayNameForChange =
      bootstrap_display_name ||
      (typeof beforeRow.name === "string" ? beforeRow.name : "") ||
      null;

    // The 1:1 rule is enforced where the sending bank is SET — People → Banking.
    // Here it is only REPORTED: advisory, never a refusal, because the receiving
    // channel is the employee's own data. Rides the best-effort snapshot, so a
    // failed read just leaves the alert without the line.
    const mismatch =
      "preferred_processor" in update
        ? sendFromMismatch(
            update.preferred_processor,
            typeof beforeRow.bank_preferred === "string" ? beforeRow.bank_preferred : null,
          )
        : null;

    // Which of the fields actually being written are payout/bank fields (the same
    // set the payroll lock guards). Only these feed the People-tab "Bank changes"
    // flow — a pure name/personal_email edit shouldn't notify Accounting.
    // `bank_preferred` is never among them: it is not writable on this route.
    const bankChangedFields = Object.keys(update).filter((k) =>
      BLOCKED_WHILE_PAYROLL_LOCKED.has(k),
    );

    const { data: updatedRows, error: updateError } = await supabase
      .from("employee_ids")
      .update(update)
      .eq(eqColumn, identifier)
      .select("employee_id");

    if (updateError) {
      return NextResponse.json({ error: explainEmployeeIdsError(updateError.message) }, { status: 500 });
    }

    if (updatedRows && updatedRows.length > 0) {
      invalidateRateProfilesCache();
      await recordDashboardBankChange({
        supabase,
        req,
        workEmail: work_email ? String(work_email).trim() : null,
        displayName: displayNameForChange,
        bankChangedFields,
        beforeRow,
        update,
        created: false,
        source,
        actor,
        mismatch,
      });
      return NextResponse.json({
        success: true,
        created: false,
      });
    }

    // No row matched — bootstrap a new employee_ids row (e.g. employee profile / first payout save).
    if (!work_email) {
      return NextResponse.json(
        {
          error:
            "No payroll record found for this email. Contact HR, or save from the employee portal using your work email.",
        },
        { status: 404 },
      );
    }

    const workEmailStr = String(work_email).trim();
    const placeholderName =
      bootstrap_display_name ||
      derivePlaceholderName(workEmailStr);

    const employeeId = `SELF-${randomUUID().replace(/-/g, "").slice(0, 14).toUpperCase()}`;

    const insertRow: Record<string, string | null> = {
      employee_id: employeeId,
      name: placeholderName,
      work_email: workEmailStr,
      personal_email: personal_email ? String(personal_email).trim() || null : null,
      ...update,
    };

    const { error: insertError } = await supabase.from("employee_ids").insert(insertRow);

    if (!insertError) {
      invalidateRateProfilesCache();
      await recordDashboardBankChange({
        supabase,
        req,
        workEmail: workEmailStr,
        displayName: placeholderName,
        bankChangedFields,
        beforeRow,
        update,
        created: true,
        source,
        actor,
        mismatch,
      });
      return NextResponse.json({
        success: true,
        created: true,
      });
    }

    // Possible race: another request inserted the same work_email — retry update.
    const { data: retryRows, error: retryError } = await supabase
      .from("employee_ids")
      .update(update)
      .eq("work_email", workEmailStr)
      .select("employee_id");

    if (retryError) {
      return NextResponse.json({ error: explainEmployeeIdsError(retryError.message) }, { status: 500 });
    }
    if (retryRows && retryRows.length > 0) {
      invalidateRateProfilesCache();
      await recordDashboardBankChange({
        supabase,
        req,
        workEmail: workEmailStr,
        displayName: placeholderName,
        bankChangedFields,
        beforeRow,
        update,
        created: false,
        source,
        actor,
        mismatch,
      });
      return NextResponse.json({
        success: true,
        created: false,
      });
    }

    return NextResponse.json({ error: explainEmployeeIdsError(insertError.message) }, { status: 500 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
