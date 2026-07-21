import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { getPayrollDispatchLock } from "@/lib/supabase/payroll-dispatch-lock";
import { invalidateRateProfilesCache } from "@/lib/supabase/employee-rate-profiles";
import { insertBankUpdateHistory } from "@/lib/supabase/bank-update-history";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { pulseBankChanges } from "@/lib/supabase/app-settings";
import { maskFieldValue } from "@/lib/bank-update/mask-field";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { authorizeEmailAccess, deniedResponse } from "@/lib/auth/authorize-email";

/** Fields blocked while Accounting has payroll dispatch locked (employees may still update personal_email). */
const BLOCKED_WHILE_PAYROLL_LOCKED = new Set([
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

    // Which of the fields being written are payout/bank fields (the same set the
    // payroll lock guards). Only these feed the People-tab "Bank changes" flow —
    // a pure name/personal_email edit shouldn't notify Accounting.
    const bankChangedFields = Object.keys(update).filter((k) =>
      BLOCKED_WHILE_PAYROLL_LOCKED.has(k),
    );

    // Snapshot the CURRENT value of just the bank fields being written, BEFORE the
    // update overwrites them, so the People-tab feed can show a masked before→after.
    // Also grab the name for the notification/history display. Best-effort.
    let beforeRow: Record<string, unknown> = {};
    if (bankChangedFields.length > 0) {
      const { data } = await supabase
        .from("employee_ids")
        .select([...bankChangedFields, "name"].join(", "))
        .eq(eqColumn, identifier)
        .limit(1);
      beforeRow = (Array.isArray(data) && data[0] ? data[0] : {}) as Record<string, unknown>;
    }

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
        displayName:
          bootstrap_display_name ||
          (typeof beforeRow.name === "string" ? beforeRow.name : "") ||
          null,
        bankChangedFields,
        beforeRow,
        update,
        created: false,
      });
      return NextResponse.json({ success: true, created: false });
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
      return NextResponse.json({ success: true, created: true });
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
      return NextResponse.json({ success: true, created: false });
    }

    return NextResponse.json({ error: explainEmployeeIdsError(insertError.message) }, { status: 500 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
