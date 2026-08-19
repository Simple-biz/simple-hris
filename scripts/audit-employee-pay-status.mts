/**
 * READ-ONLY probe: why does every pay week read "pending"?
 *
 * Kane, 2026-08-19: *"All weeks should not be pending already"* — the employee
 * Penny assistant reported `status: pending` for weeks the employee had in fact
 * been paid for. `status` on those entries comes from `disbursement_records`,
 * overlaid with paid `payment_dispatches` rows by `getEmployeePay` in
 * `src/lib/anthropic/ceo-tools.ts`.
 *
 * This measures which of the two is out of step, per employee, so the fix is
 * aimed at the real cause rather than at the symptom:
 *
 *   A. dispatches say PAID but the week still reads pending  → the OVERLAY is
 *      failing (period-start mismatch, alias mismatch, payee_type, limit).
 *   B. no paid dispatch exists at all                        → the data is
 *      genuinely unpaid-marked; "pending" is faithful and the WORDING is what
 *      misleads an employee.
 *
 * Usage (no writes, no --apply gate needed — it never mutates):
 *   node --import tsx scripts/audit-employee-pay-status.mts [email] [weeks]
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const subject = process.argv[2] ?? null;
const weeks = Number(process.argv[3] ?? 8);

const { createSupabaseServiceRoleClient } = await import("../src/lib/supabase/server");
const { normEmail } = await import("../src/lib/email/norm-email");
const { selectAllPaged } = await import("../src/lib/supabase/select-all-paged");

const supabase = createSupabaseServiceRoleClient();
if (!supabase) {
  console.error("No service-role client — check .env.local");
  process.exit(1);
}

const line = (s: string) => console.log(`\n${"─".repeat(74)}\n${s}\n${"─".repeat(74)}`);

/* ── 1. Fleet-wide status distribution ─────────────────────────────────────── */

line("disbursement_records — status distribution");
{
  const PAGE = 1000;
  const tally = new Map<string, number>();
  let total = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("disbursement_records")
      .select("status")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("  read failed:", error.message);
      break;
    }
    const rows = (data ?? []) as { status: string | null }[];
    for (const r of rows) {
      const k = r.status ?? "(null)";
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    total += rows.length;
    if (rows.length < PAGE) break;
  }
  console.log(`  ${total} rows`);
  for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(12)} ${String(v).padStart(6)}  ${((v / total) * 100).toFixed(1)}%`);
  }
}

line("payment_dispatches — status distribution");
{
  const PAGE = 1000;
  const tally = new Map<string, number>();
  let total = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("payment_dispatches")
      .select("status")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("  read failed:", error.message);
      break;
    }
    const rows = (data ?? []) as { status: string | null }[];
    for (const r of rows) {
      const k = r.status ?? "(null)";
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    total += rows.length;
    if (rows.length < PAGE) break;
  }
  console.log(`  ${total} rows`);
  for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(12)} ${String(v).padStart(6)}  ${((v / total) * 100).toFixed(1)}%`);
  }
}

/* ── 2. Cycle-level overlap: do paid dispatches exist for pending weeks? ──── */

line("Per-cycle: pending weekly records vs. paid dispatches for the SAME cycle start");
{
  // PAGED, not `.limit(4000)`: PostgREST truncates at 1000 rows even with an
  // explicit limit, so the first version of this probe reported "consistent" for
  // every cycle older than the newest one — it had simply never seen them.
  const { rows: disb, error: disbErr } = await selectAllPaged<{
    cycle_period_start: string | null;
    status: string | null;
  }>((from, to) =>
    supabase
      .from("disbursement_records")
      .select("cycle_period_start, status")
      .order("cycle_period_start", { ascending: false })
      .range(from, to),
  );
  if (disbErr) console.error("  disbursement read failed:", disbErr);

  const { rows: disp, error: dispErr } = await selectAllPaged<{
    cycle_period_start: string | null;
  }>((from, to) =>
    supabase
      .from("payment_dispatches")
      .select("cycle_period_start, status")
      .eq("status", "paid")
      .order("cycle_period_start", { ascending: false })
      .range(from, to),
  );
  if (dispErr) console.error("  dispatch read failed:", dispErr);

  const byCycle = new Map<string, { pending: number; paid: number; dispatchesPaid: number }>();
  for (const r of (disb ?? []) as { cycle_period_start: string | null; status: string | null }[]) {
    const k = r.cycle_period_start ?? "(null)";
    const e = byCycle.get(k) ?? { pending: 0, paid: 0, dispatchesPaid: 0 };
    if (r.status === "paid") e.paid += 1;
    else e.pending += 1;
    byCycle.set(k, e);
  }
  for (const r of (disp ?? []) as { cycle_period_start: string | null }[]) {
    const k = r.cycle_period_start ?? "(null)";
    const e = byCycle.get(k) ?? { pending: 0, paid: 0, dispatchesPaid: 0 };
    e.dispatchesPaid += 1;
    byCycle.set(k, e);
  }

  console.log("  cycle start   rec-paid  rec-other  paid dispatches   reading");
  const cycles = [...byCycle.entries()]
    .filter(([k]) => k !== "(null)")
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 16);
  for (const [start, e] of cycles) {
    // A cycle with paid dispatches but non-paid weekly records is where the
    // overlay has to do its job — and where a failure shows as "pending".
    const reading =
      e.dispatchesPaid > 0 && e.pending > 0
        ? "OVERLAY territory (A)"
        : e.dispatchesPaid === 0 && e.pending > 0
          ? "genuinely unmarked (B)"
          : "consistent";
    console.log(
      `  ${start.padEnd(13)} ${String(e.paid).padStart(8)} ${String(e.pending).padStart(10)} ${String(e.dispatchesPaid).padStart(16)}   ${reading}`,
    );
  }
}

/* ── 3. One employee, end to end ───────────────────────────────────────────── */

if (subject) {
  const email = normEmail(subject) ?? subject;
  line(`One employee end-to-end: ${email} (last ${weeks} weeks)`);

  const { data: master } = await supabase
    .from("global_master_list")
    .select('"Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2"')
    .ilike('"Work Email"', email)
    .limit(1);
  const m = (master ?? [])[0] as Record<string, string | null> | undefined;
  const aliases = [
    email,
    normEmail(m?.["Work Email"] ?? null),
    normEmail(m?.["Personal Email"] ?? null),
    normEmail(m?.["Alternate Work Email"] ?? null),
    normEmail(m?.["Alternate Work Email 2"] ?? null),
  ].filter((v): v is string => !!v);
  const uniq = [...new Set(aliases)];
  console.log(`  aliases: ${uniq.join(", ")}`);

  const orFilter = uniq.map((a) => `recipient_email.ilike.${a}`).join(",");

  const { data: recs } = await supabase
    .from("disbursement_records")
    .select("cycle_period_start, cycle_period_end, status, amount_php, paid_amount_usd, paid_at")
    .or(orFilter)
    .order("cycle_period_start", { ascending: false })
    .limit(weeks);

  const { data: dispatches } = await supabase
    .from("payment_dispatches")
    .select("cycle_period_start, status, amount_php, amount_usd, sent_date, payee_type")
    .or(orFilter)
    .order("cycle_period_start", { ascending: false })
    .limit(40);

  const paidByStart = new Map<string, number>();
  for (const d of (dispatches ?? []) as Record<string, unknown>[]) {
    if (d.status !== "paid" || d.payee_type === "contractor") continue;
    const k = (d.cycle_period_start as string | null) ?? "";
    if (k) paidByStart.set(k, (paidByStart.get(k) ?? 0) + 1);
  }

  console.log("\n  week start    record status   paid dispatch?   what Penny would say");
  for (const r of (recs ?? []) as Record<string, unknown>[]) {
    const start = String(r.cycle_period_start ?? "");
    const hasPaid = (paidByStart.get(start) ?? 0) > 0;
    const effective = r.status === "paid" || hasPaid ? "paid" : String(r.status);
    console.log(
      `  ${start.padEnd(13)} ${String(r.status).padEnd(14)} ${(hasPaid ? "yes" : "no").padEnd(16)} ${effective}`,
    );
  }

  const allDispatchStatuses = new Map<string, number>();
  for (const d of (dispatches ?? []) as Record<string, unknown>[]) {
    const k = `${d.status}/${d.payee_type ?? "employee"}`;
    allDispatchStatuses.set(k, (allDispatchStatuses.get(k) ?? 0) + 1);
  }
  console.log(
    `\n  their dispatch rows by status/payee: ${
      [...allDispatchStatuses].map(([k, v]) => `${k}=${v}`).join(" ") || "(none)"
    }`,
  );
}

console.log("\nread-only probe complete — nothing was written.\n");
