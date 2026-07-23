// READ-ONLY. Lists orphanage budget requests with visit_type='monthly' so we can
// identify the exact row to delete. Also reports whether each has a linked
// orphanage_dispatches row (payment record). No writes.
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!url || !key) {
  console.log("Missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: reqs, error } = await supabase
  .from("orphanage_budget_requests")
  .select(
    "id, submitter_email, submitted_at, visit_type, mission_trip, final_amount, status, decided_at, bank_name, bank_account_name",
  )
  .eq("visit_type", "monthly")
  .order("submitted_at", { ascending: false });

if (error) {
  console.log("Query error:", error.message);
  process.exit(1);
}

// For each request, see if it already has a dispatch row.
const ids = (reqs ?? []).map((r) => r.id);
let dispatchByReq = new Map();
if (ids.length) {
  const { data: disp } = await supabase
    .from("orphanage_dispatches")
    .select("id, budget_request_id, status, amount_php, paid_at")
    .in("budget_request_id", ids);
  for (const d of disp ?? []) dispatchByReq.set(d.budget_request_id, d);
}

console.log(`\nMonthly Visit budget requests: ${reqs?.length ?? 0}\n`);
for (const r of reqs ?? []) {
  const d = dispatchByReq.get(r.id);
  console.log(
    JSON.stringify(
      {
        id: r.id,
        submitter: r.submitter_email,
        submitted_at: r.submitted_at,
        status: r.status,
        final_amount: r.final_amount,
        mission_trip: r.mission_trip,
        bank: `${r.bank_name} / ${r.bank_account_name}`,
        dispatch: d
          ? { id: d.id, status: d.status, amount_php: d.amount_php, paid_at: d.paid_at }
          : null,
      },
      null,
      2,
    ),
  );
}
