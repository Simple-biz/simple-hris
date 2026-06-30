import "server-only";

import { getEmployeeIdRowByEmail } from "@/lib/supabase/employee-ids";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { normEmail } from "@/lib/email/norm-email";
import { escapeLikePattern } from "@/lib/db/like-escape";

/**
 * Current payout details for the /update-bank-info form, shaped as an
 * employee_ids-style snake_case record so the browser can feed it straight into
 * `payoutDraftFromIdsRow()` (the same deserializer the in-app Profile uses).
 *
 * Source priority:
 *   1. employee_ids — the canonical, current payout record (what the People tab
 *      reads). For promoted hires this already holds their onboarding answers.
 *   2. hr_onboarding_submissions — best-effort fallback so "the details you
 *      filled in during onboarding" still appear for an active employee who has
 *      no employee_ids row yet. Matched on WORK email only — never personal
 *      email, which is documented as non-unique and could surface another
 *      person's bank details.
 */
export type PayoutPrefill = Record<string, string | null>;

export async function getPayoutPrefill(workEmail: string): Promise<PayoutPrefill | null> {
  const work = normEmail(workEmail);
  if (!work) return null;

  const { row } = await getEmployeeIdRowByEmail(work);
  if (row) {
    return {
      preferred_processor: row.preferred_processor,
      preferred_bank_slot: row.preferred_bank_slot,
      bank_name: row.bank_name,
      account_holder_name: row.account_holder_name,
      account_number: row.account_number,
      routing_number: row.routing_number,
      swift_code: row.swift_code,
      full_address: row.full_address,
      alt_bank_name: row.alt_bank_name,
      alt_account_holder_name: row.alt_account_holder_name,
      alt_account_number: row.alt_account_number,
      alt_routing_number: row.alt_routing_number,
      hurupay_email: row.hurupay_email,
      wepay_email: row.wepay_email,
      higlobe_email: row.higlobe_email,
      higlobe_account_name: row.higlobe_account_name,
      wise_email: row.wise_email,
      wise_tag: row.wise_tag,
      phone_number: row.phone_number,
    };
  }

  return onboardingPrefill(work);
}

/** Map a (non-archived) onboarding submission's bank fields to employee_ids keys. */
async function onboardingPrefill(workEmail: string): Promise<PayoutPrefill | null> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return null;

  const sel =
    "payment_method, hurupay_email, bank_full_name, bank_account_name, bank_account_number, bank_swift_code, bank_full_address, status, created_at";

  try {
    // Match on WORK email only — personal email is non-unique (could be shared
    // across people) so it must never key a sensitive-data prefill.
    const res = await supabase
      .from("hr_onboarding_submissions")
      .select(sel)
      .ilike("work_email", escapeLikePattern(workEmail))
      .neq("status", "archived")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (res.error || !res.data) return null;

    const sub = res.data as Record<string, unknown>;
    const method = ((sub.payment_method as string | null) ?? "").toLowerCase();
    const str = (k: string) => {
      const v = sub[k];
      const t = v == null ? "" : String(v).trim();
      return t || null;
    };

    return {
      preferred_processor: method === "hurupay" || method === "wires" ? method : null,
      hurupay_email: str("hurupay_email"),
      bank_name: str("bank_full_name"),
      account_holder_name: str("bank_account_name"),
      account_number: str("bank_account_number"),
      swift_code: str("bank_swift_code"),
      full_address: str("bank_full_address"),
    };
  } catch {
    return null;
  }
}
