import { normEmail } from "@/lib/email/norm-email";
import { createSupabaseServerClient } from "./server";

export type EmployeeIdRow = {
  employee_id: string;
  name: string;
  work_email: string | null;
  personal_email: string | null;
  preferred_bank_slot: string | null;
  bank_name: string | null;
  account_holder_name: string | null;
  account_number: string | null;
  routing_number: string | null;
  alt_bank_name: string | null;
  alt_account_holder_name: string | null;
  alt_account_number: string | null;
  alt_routing_number: string | null;
  /**
   * Employee-chosen payment processor. One of the known processor IDs (see
   * src/components/payroll-clerk/mock-queue.ts ProcessorId). NULL when the
   * employee hasn't picked yet — the constrained dropdown lives in
   * EmployeeSettings.tsx.
   */
  preferred_processor: string | null;
  // ── Per-processor payout fields, employee-provided. Dispatch queue
  //    prefers these over the rates-side equivalents when present.
  hurupay_email: string | null;
  wepay_email: string | null;
  higlobe_email: string | null;
  higlobe_account_name: string | null;
  wise_email: string | null;
  wise_tag: string | null;
  phone_number: string | null;
  swift_code: string | null;
  full_address: string | null;
};

function explainEmployeeIdsReadError(message: string): string {
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
    lower.includes("schema cache")
  ) {
    return [
      "Supabase employee_ids schema is missing one or more payout columns.",
      "Run references/add_preferred_processor.sql, references/add_processor_fields_to_employee_ids.sql, and references/add_preferred_bank_slot_to_employee_ids.sql in Supabase.",
      `Supabase said: ${msg}`,
    ].join(" ");
  }

  return msg;
}

/**
 * Single-row lookup by email — used by the employee portal so it doesn't have
 * to download the full `employee_ids` table just to read its own row. Matches
 * `work_email` first, then `personal_email` (case-insensitive).
 */
export async function getEmployeeIdRowByEmail(
  email: string,
): Promise<{ row: EmployeeIdRow | null; error: string | null }> {
  const target = email.trim();
  if (!target) return { row: null, error: null };

  const supabase = createSupabaseServerClient();
  if (!supabase) {
    return { row: null, error: "Supabase client not initialised." };
  }

  const cols =
    "employee_id, name, work_email, personal_email, preferred_bank_slot, bank_name, account_holder_name, account_number, routing_number, alt_bank_name, alt_account_holder_name, alt_account_number, alt_routing_number, preferred_processor, hurupay_email, wepay_email, higlobe_email, higlobe_account_name, wise_email, wise_tag, phone_number, swift_code, full_address";

  const tryColumn = async (col: string) =>
    supabase.from("employee_ids").select(cols).ilike(col, target).limit(1).maybeSingle();

  let res = await tryColumn("work_email");
  if (!res.data && !res.error) {
    res = await tryColumn("personal_email");
  }
  if (res.error) return { row: null, error: explainEmployeeIdsReadError(res.error.message) };
  if (!res.data) return { row: null, error: null };

  const row = res.data as EmployeeIdRow;
  if (!row.employee_id || !row.name) return { row: null, error: null };
  return { row, error: null };
}

export async function getEmployeeIds(): Promise<{
  rows: EmployeeIdRow[];
  error: string | null;
}> {
  const supabase = createSupabaseServerClient();
  if (!supabase) {
    return { rows: [], error: "Supabase client not initialised." };
  }

  const { data, error } = await supabase
    .from("employee_ids")
    .select("employee_id, name, work_email, personal_email, preferred_bank_slot, bank_name, account_holder_name, account_number, routing_number, alt_bank_name, alt_account_holder_name, alt_account_number, alt_routing_number, preferred_processor, hurupay_email, wepay_email, higlobe_email, higlobe_account_name, wise_email, wise_tag, phone_number, swift_code, full_address")
    .order("employee_id");

  if (error) return { rows: [], error: explainEmployeeIdsReadError(error.message) };

  const rows = ((data ?? []) as EmployeeIdRow[]).filter(
    (r) => r.employee_id && r.name,
  );
  return { rows, error: null };
}

/**
 * Builds a map of normalised email → employee_id.
 * Both work_email and personal_email are indexed so any email match
 * from the profile will resolve to the correct ID.
 */
export function buildEmployeeIdMap(rows: EmployeeIdRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    const we = normEmail(r.work_email ?? "");
    const pe = normEmail(r.personal_email ?? "");
    if (we) map.set(we, r.employee_id);
    if (pe && !map.has(pe)) map.set(pe, r.employee_id);
  }
  return map;
}
