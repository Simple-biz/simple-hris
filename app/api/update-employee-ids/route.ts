import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { getPayrollDispatchLock } from "@/lib/supabase/payroll-dispatch-lock";
import { invalidateRateProfilesCache } from "@/lib/supabase/employee-rate-profiles";
import { insertBankUpdateHistory } from "@/lib/supabase/bank-update-history";
import { createBankPreferredRequest } from "@/lib/supabase/bank-preferred-requests";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { pulseBankChanges } from "@/lib/supabase/app-settings";
import { maskFieldValue } from "@/lib/bank-update/mask-field";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { authorizeEmailAccess, deniedResponse } from "@/lib/auth/authorize-email";

/** Fields blocked while Accounting has payroll dispatch locked (employees may still update personal_email). */
const BLOCKED_WHILE_PAYROLL_LOCKED = new Set([
  "preferred_processor",
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
 */
async function notifyReviewers(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
  workEmail: string,
  displayName: string | null,
  changedFields: string[],
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
    await supabase.from("employee_notifications").insert(
      recipients.map((to) => ({
        recipient_email: to,
        type: "people.banking.self_updated",
        tone: "neutral",
        title: "Bank details updated",
        message: `${displayName || workEmail} updated their bank & payout details from the Employee Dashboard.`,
        details: { work_email: workEmail, via: "employee_dashboard", fields: changedFields },
      })),
    );
  } catch {
    // Notification failure must never fail the save.
  }
}

/**
 * Notify Accounting/CEO/Admin that an employee submitted a Bank Preferred change
 * that needs approval in the Issues tab. Best-effort; never fails the save.
 */
async function notifyReviewersOfBankPreferredRequest(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
  workEmail: string,
  displayName: string | null,
  fromValue: string | null,
  toValue: string,
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
    await supabase.from("employee_notifications").insert(
      recipients.map((to) => ({
        recipient_email: to,
        type: "people.banking.self_updated",
        tone: "neutral",
        title: "Bank Preferred change needs approval",
        message: `${displayName || workEmail} requested a Bank Preferred change (${fromValue ?? "none"} → ${toValue}). Approve or deny it in the Issues tab.`,
        details: { work_email: workEmail, via: "employee_dashboard", kind: "bank_preferred_request", from: fromValue, to: toValue },
      })),
    );
  } catch {
    // Notification failure must never fail the save.
  }
}

/**
 * Intercept a Bank Preferred change: instead of writing employee_ids.bank_preferred
 * directly, hold the new value as a pending request for Accounting to approve.
 *
 * Mutates `update` in place — removing `bank_preferred` so it is NOT written to
 * employee_ids by the caller. Returns whether a pending request was filed (so
 * the response can tell the UI to show "sent for approval"). A no-op change
 * (requested value equals the current live value) is dropped silently.
 */
async function interceptBankPreferred(opts: {
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>;
  update: Record<string, string | null>;
  workEmail: string | null;
  displayName: string | null;
  currentValue: string | null;
}): Promise<{ requested: boolean }> {
  const { supabase, update, workEmail, displayName, currentValue } = opts;
  if (!("bank_preferred" in update)) return { requested: false };

  const requested = update.bank_preferred; // already trimmed/validated, or null
  // Always take it out of the immediate employee_ids write — it only lands there
  // on approval.
  delete update.bank_preferred;

  // No work email → can't key a request (bootstrap by personal_email only). Drop.
  if (!workEmail) return { requested: false };

  const current = (currentValue ?? "").trim() || null;
  const target = (requested ?? "").trim() || null;

  // No actual change (incl. clearing an already-empty value) → nothing to gate.
  if (current === target) return { requested: false };
  // Clearing the value doesn't need approval — but there's no UI path to clear
  // it, and a null target has no processor to route to. Treat null target as a
  // no-op request to avoid filing an empty approval. (Set requires a value.)
  if (!target) return { requested: false };

  const { error } = await createBankPreferredRequest({
    workEmail,
    employeeName: displayName,
    fromValue: current,
    toValue: target,
  });
  if (error) {
    // Un-migrated env or DB hiccup — do NOT silently write the value (that would
    // bypass the gate). Surface via a thrown error the caller converts to 500.
    throw new Error(`Could not file Bank Preferred change for approval: ${error}`);
  }

  await notifyReviewersOfBankPreferredRequest(supabase, workEmail, displayName, current, target);
  return { requested: true };
}

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
}): Promise<void> {
  const { supabase, req, workEmail, displayName, bankChangedFields, beforeRow, update, created } = opts;
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

  await insertAuditLog({
    user_name: displayName || workEmail,
    user_role: "employee (dashboard)",
    action: "bank_update.saved",
    resource: "employee_ids",
    resource_id: workEmail,
    details: {
      via: "employee_dashboard",
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
    via: "employee_dashboard",
    ip_address: ip,
  }).catch(() => undefined);

  await notifyReviewers(supabase, workEmail, displayName, bankChangedFields);

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
      ...fields
    } = body as Record<string, unknown>;

    const bootstrap_display_name =
      typeof bootstrapDisplayNameRaw === "string" ? bootstrapDisplayNameRaw.trim() : "";

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
      "preferred_processor",
      "bank_preferred",
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
        if (key === "bank_preferred" && trimmed != null && !ALLOWED_PROCESSORS.has(trimmed)) {
          return NextResponse.json(
            { error: `Invalid bank_preferred: ${trimmed}` },
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

    const eqColumn = work_email ? "work_email" : "personal_email";
    const identifier = (work_email ?? personal_email) as string;

    // Snapshot the CURRENT value of the bank fields being written (incl.
    // bank_preferred, which is in BLOCKED_WHILE_PAYROLL_LOCKED), BEFORE the update
    // overwrites them, so the People-tab feed can show a masked before→after and
    // the Bank Preferred gate can compare old vs requested. Best-effort.
    const preInterceptBankFields = Object.keys(update).filter((k) =>
      BLOCKED_WHILE_PAYROLL_LOCKED.has(k),
    );
    let beforeRow: Record<string, unknown> = {};
    if (preInterceptBankFields.length > 0) {
      const { data } = await supabase
        .from("employee_ids")
        .select([...preInterceptBankFields, "name"].join(", "))
        .eq(eqColumn, identifier)
        .limit(1);
      beforeRow = (Array.isArray(data) && data[0] ? data[0] : {}) as Record<string, unknown>;
    }

    const displayNameForChange =
      bootstrap_display_name ||
      (typeof beforeRow.name === "string" ? beforeRow.name : "") ||
      null;

    // Bank Preferred changes go through Accounting approval: hold the requested
    // value as a pending request and REMOVE it from `update` so it is not written
    // to employee_ids until approved. Everything else saves immediately.
    const bankPreferred = await interceptBankPreferred({
      supabase,
      update,
      workEmail: work_email ? String(work_email).trim() : null,
      displayName: displayNameForChange,
      currentValue:
        typeof beforeRow.bank_preferred === "string" ? beforeRow.bank_preferred : null,
    });

    // If Bank Preferred was the ONLY thing submitted, there's nothing left to
    // write to employee_ids — the request is filed; report it and return.
    if (Object.keys(update).length === 0) {
      return NextResponse.json({
        success: true,
        created: false,
        bankPreferredRequested: bankPreferred.requested,
      });
    }

    // Which of the fields actually being written are payout/bank fields (the same
    // set the payroll lock guards). Only these feed the People-tab "Bank changes"
    // flow — a pure name/personal_email edit shouldn't notify Accounting. Computed
    // AFTER the intercept so bank_preferred (now held for approval) is excluded.
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
      });
      return NextResponse.json({
        success: true,
        created: false,
        bankPreferredRequested: bankPreferred.requested,
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
      });
      return NextResponse.json({
        success: true,
        created: true,
        bankPreferredRequested: bankPreferred.requested,
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
      });
      return NextResponse.json({
        success: true,
        created: false,
        bankPreferredRequested: bankPreferred.requested,
      });
    }

    return NextResponse.json({ error: explainEmployeeIdsError(insertError.message) }, { status: 500 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
