import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { work_email, personal_email, ...fields } = body as Record<string, unknown>;

    if (!work_email && !personal_email) {
      return NextResponse.json(
        { error: "work_email or personal_email is required to identify the employee" },
        { status: 400 },
      );
    }

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "Supabase client not initialized." },
        { status: 500 },
      );
    }

    // Build the update object from allowed fields
    const allowed = [
      "name", "personal_email",
      "bank_name", "account_holder_name", "account_number", "routing_number",
      "alt_bank_name", "alt_account_holder_name", "alt_account_number", "alt_routing_number",
      "preferred_processor",
      // Per-processor payout fields (employee-provided)
      "hurupay_email", "wepay_email", "higlobe_email", "higlobe_account_name",
      "wise_email", "wise_tag",
      "phone_number", "swift_code", "full_address",
    ];
    const ALLOWED_PROCESSORS = new Set([
      "hurupay", "wepay", "higlobe", "wise", "jeeves", "wires",
    ]);
    const update: Record<string, string | null> = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        const val = fields[key];
        const trimmed = val != null && String(val).trim() !== "" ? String(val).trim() : null;
        // Whitelist the processor server-side so a tampered request can't
        // sneak "gcash" past the dropdown — matches the DB CHECK constraint.
        if (key === "preferred_processor" && trimmed != null && !ALLOWED_PROCESSORS.has(trimmed)) {
          return NextResponse.json(
            { error: `Invalid preferred_processor: ${trimmed}` },
            { status: 400 },
          );
        }
        update[key] = trimmed;
      }
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    let q = supabase.from("employee_ids").update(update);
    q = work_email ? q.eq("work_email", work_email) : q.eq("personal_email", personal_email);

    const { error, count } = await q;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
