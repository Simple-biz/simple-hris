import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { getPayrollDispatchLock } from "@/lib/supabase/payroll-dispatch-lock";
import { invalidateRateProfilesCache } from "@/lib/supabase/employee-rate-profiles";
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
      return NextResponse.json({ success: true, created: false });
    }

    return NextResponse.json({ error: explainEmployeeIdsError(insertError.message) }, { status: 500 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
