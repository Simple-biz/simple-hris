/**
 * READ-ONLY probe: can an approved MESA disbursement be paid twice?
 *
 * Two rails pay an approved `disbursement` today:
 *   1. The Payroll Wizard folds every approved request with `dispatched_at IS NULL`
 *      into Final pay as `pay_php.mesa_disbursement` (PayrollWizard.tsx
 *      `fetchMesaDisbursements`), so it rides that week's paycheck.
 *   2. Payment Dispatch -> Urgent lists the same rows (`GET /api/urgent-payments`,
 *      `dispatched_at IS NULL`) and Send pays them on their own, stamping
 *      `dispatched_at`.
 * Nothing stamps the request when rail 1 pays it, so it stays in rail 2's queue
 * and is folded into the NEXT cycle's paycheck again.
 *
 * This measures, against production, whether that has happened: every
 * disbursement request, every staged/sent paystub row carrying a non-zero
 * `mesa_disbursement`, and every urgent `payment_dispatches` row, joined by
 * work email. Also prints how `return` requests are shaped today (amount or not).
 *
 * Found while scoping the 2026-10-05 Accounting > MESA ticket (returns and
 * disbursements to the paycheck).
 *
 * Usage: node --import tsx scripts/probe-mesa-disbursement-rails.mts
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import("../src/lib/supabase/server");
const { selectAllPaged } = await import("../src/lib/supabase/select-all-paged");

const supabase = createSupabaseServiceRoleClient();
if (!supabase) {
  console.error("No service-role client — check .env.local");
  process.exit(1);
}

const line = (s: string) => console.log("\n" + "-".repeat(78) + "\n" + s + "\n" + "-".repeat(78));
const norm = (e: unknown) => String(e ?? "").trim().toLowerCase();

type Req = {
  id: string;
  work_email: string | null;
  request_type: string;
  status: string;
  amount_needed: number | null;
  dispatched_at: string | null;
  created_at: string;
  reviewed_at: string | null;
  explanation: string | null;
};

const reqs = await selectAllPaged<Req>((from, to) =>
  supabase
    .from("mesa_requests")
    .select("id, work_email, request_type, status, amount_needed, dispatched_at, created_at, reviewed_at, explanation")
    .order("created_at", { ascending: true })
    .range(from, to),
);
if (reqs.error) {
  console.error("mesa_requests read failed:", reqs.error);
  process.exit(1);
}

line(`mesa_requests: ${reqs.rows.length} rows`);
const tally = new Map<string, number>();
for (const r of reqs.rows) {
  const k = `${r.request_type} · ${r.status}${r.dispatched_at ? " · dispatched" : ""}`;
  tally.set(k, (tally.get(k) ?? 0) + 1);
}
for (const [k, n] of [...tally.entries()].sort()) console.log(`  ${k.padEnd(40)} ${n}`);

const returns = reqs.rows.filter((r) => r.request_type === "return");
line(`return requests: ${returns.length}`);
for (const r of returns) {
  console.log(
    `  ${r.created_at.slice(0, 10)} ${norm(r.work_email).padEnd(32)} ${r.status.padEnd(9)} amount=${r.amount_needed ?? "null"} explanation=${JSON.stringify((r.explanation ?? "").slice(0, 60))}`,
  );
}

type Stub = {
  cycle_source_file: string;
  recipient_email: string;
  sent_at: string | null;
  locked_at: string | null;
  mesa_disb: number | string | null;
};
const stubs = await selectAllPaged<Stub>((from, to) =>
  supabase
    .from("paystub_dispatch_queue")
    .select("cycle_source_file, recipient_email, sent_at, locked_at, mesa_disb:payload->pay_php->mesa_disbursement")
    .order("cycle_source_file", { ascending: true })
    .order("recipient_email", { ascending: true })
    .range(from, to),
);
if (stubs.error) {
  console.error("paystub_dispatch_queue read failed:", stubs.error);
  process.exit(1);
}
const carrying = stubs.rows.filter((s) => Number(s.mesa_disb ?? 0) > 0);
line(`paystub_dispatch_queue: ${stubs.rows.length} rows scanned, ${carrying.length} carry mesa_disbursement > 0`);
for (const s of carrying) {
  console.log(
    `  ${s.cycle_source_file.padEnd(52)} ${norm(s.recipient_email).padEnd(32)} PHP ${Number(s.mesa_disb).toFixed(2)} ${s.sent_at ? "SENT " + s.sent_at.slice(0, 10) : "unsent"}`,
  );
}

type Disp = {
  id: string;
  recipient_email: string | null;
  amount_php: number | null;
  cycle_source_file: string | null;
  created_at: string;
};
const urgent = await selectAllPaged<Disp>((from, to) =>
  supabase
    .from("payment_dispatches")
    .select("id, recipient_email, amount_php, cycle_source_file, created_at")
    .like("cycle_source_file", "urgent_%")
    .order("created_at", { ascending: true })
    .range(from, to),
);
if (urgent.error) {
  console.error("payment_dispatches read failed:", urgent.error);
  process.exit(1);
}
line(`urgent payment_dispatches: ${urgent.rows.length}`);

const disb = reqs.rows.filter((r) => r.request_type === "disbursement" && r.status === "approved");
line(`approved disbursements: ${disb.length} (${disb.filter((r) => !r.dispatched_at).length} with dispatched_at NULL)`);
let both = 0;
for (const r of disb) {
  const em = norm(r.work_email);
  const onStubs = carrying.filter((s) => norm(s.recipient_email) === em);
  const onUrgent = urgent.rows.filter((u) => norm(u.recipient_email) === em);
  const flag = onStubs.length > 0 && (onUrgent.length > 0 || !r.dispatched_at) ? "  <-- paycheck carried it" : "";
  if (onStubs.length > 0) both++;
  console.log(
    `  ${r.created_at.slice(0, 10)} ${em.padEnd(32)} PHP ${String(r.amount_needed ?? "null").padEnd(8)} ` +
      `${r.dispatched_at ? "dispatched " + r.dispatched_at.slice(0, 10) : "NOT dispatched"} · ` +
      `stubs=${onStubs.length} urgentSends=${onUrgent.length}${flag}`,
  );
  for (const s of onStubs) {
    console.log(`      stub ${s.cycle_source_file} PHP ${Number(s.mesa_disb).toFixed(2)} ${s.sent_at ? "SENT" : "unsent"}`);
  }
}
line(`approved disbursements whose worker had a paystub carrying mesa_disbursement: ${both}`);

// The Wizard publishes its live figures to app_settings `payroll.wizard.final_pay.<sourceFile>`
// on a debounce, before anything is staged — so an undispatched disbursement can already be in
// the current cycle's numbers with no paystub row yet. Check the newest snapshots for each one.
const live = disb.filter((r) => !r.dispatched_at);
if (live.length > 0) {
  const { data: snaps, error: snapErr } = await supabase
    .from("app_settings")
    .select("key, updated_at, value")
    .like("key", "payroll.wizard.final_pay.%")
    .order("updated_at", { ascending: false })
    .limit(3);
  if (snapErr) {
    console.error("final_pay snapshot read failed:", snapErr);
    process.exit(1);
  }
  line(`newest final_pay snapshots vs ${live.length} undispatched approved disbursement(s)`);
  for (const s of snaps ?? []) {
    const parsed = (typeof s.value === "string" ? JSON.parse(s.value) : s.value) as {
      finals?: Record<string, { final?: number; mesaDisbursement?: number | null }>;
    } | null;
    const finals = parsed?.finals ?? {};
    console.log(`  ${s.key} (updated ${String(s.updated_at).slice(0, 16)})`);
    for (const r of live) {
      const em = norm(r.work_email);
      const entry = finals[em];
      console.log(
        entry
          ? `    ${em}: final=PHP ${entry.final} · mesaDisbursement=${entry.mesaDisbursement ?? "absent"}`
          : `    ${em}: not in this snapshot`,
      );
    }
  }
}
