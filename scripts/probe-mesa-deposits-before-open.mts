/**
 * READ-ONLY probe: MESA deposits that fall BEFORE the open account they belong to.
 *
 * Kane's ruling, 2026-09-15: "Friday should be the deposit dates" — a member
 * contributes for a pay week only when their enrollment date is on/before that
 * week's Friday deposit date. Until now the Wizard charged ₱100 for any week
 * ENDING on/after the enrollment date, so a member effective on a Saturday was
 * charged for the week ending that day while the writer dated the ₱400 on the
 * Friday BEFORE it — a date `summarizeMemberAccount` drops as earlier than the
 * account's opened_on. Charged, nothing visible.
 *
 * Measures, never mutates:
 *   1. every OPEN account's deposits dated before its opened_on, split into
 *      "the join week" (within 6 days) and "older" (backfill history / a re-join)
 *   2. members whose mesa_member_since is a SATURDAY (the population the ruling
 *      changes going forward)
 *
 * Usage: node --import tsx scripts/probe-mesa-deposits-before-open.mts
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

const line = (s: string) => console.log(`\n${"─".repeat(74)}\n${s}\n${"─".repeat(74)}`);
const dow = (iso: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${iso}T00:00:00Z`).getUTCDay()];
const minusDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

type Account = { account_number: string; email: string; opened_on: string; closed_on: string | null };
type Deposit = { email: string | null; deposit_date: string | null; worker_contribution_php: number | null; simple_match_php: number | null; status: string | null };
type Rate = { "Work Email": string | null; mesa_member: boolean | null; mesa_member_since: string | null };

const { rows: accounts, error: aErr } = await selectAllPaged<Account>((from, to) =>
  supabase.from("mesa_accounts").select("account_number, email, opened_on, closed_on").order("account_number").range(from, to),
);
if (aErr) { console.error("mesa_accounts read failed:", aErr); process.exit(1); }

const { rows: deposits, error: dErr } = await selectAllPaged<Deposit>((from, to) =>
  supabase
    .from("mesa_ledger")
    .select("email, deposit_date, worker_contribution_php, simple_match_php, status")
    .not("deposit_date", "is", null)
    .order("id")
    .range(from, to),
);
if (dErr) { console.error("mesa_ledger read failed:", dErr); process.exit(1); }

const { rows: rates, error: rErr } = await selectAllPaged<Rate>((from, to) =>
  supabase
    .from("employee_hourly_rates_current")
    .select('"Work Email", mesa_member, mesa_member_since')
    .eq("mesa_member", true)
    .order("id")
    .range(from, to),
);
if (rErr) { console.error("rates read failed:", rErr); process.exit(1); }

line(`Inputs: ${accounts.length} accounts (${accounts.filter((a) => !a.closed_on).length} open) · ${deposits.length} dated ledger rows · ${rates.length} flagged members`);

const depositsByEmail = new Map<string, Deposit[]>();
for (const d of deposits) {
  const e = d.email?.trim().toLowerCase();
  if (!e) continue;
  if (!depositsByEmail.has(e)) depositsByEmail.set(e, []);
  depositsByEmail.get(e)!.push(d);
}

line("1. OPEN accounts with deposits dated BEFORE opened_on");
let joinWeekAccounts = 0, joinWeekRows = 0, joinWeekPhp = 0, olderAccounts = 0, olderRows = 0;
for (const a of accounts.filter((x) => !x.closed_on)) {
  const mine = depositsByEmail.get(a.email.toLowerCase()) ?? [];
  const before = mine.filter((d) => d.deposit_date! < a.opened_on);
  if (before.length === 0) continue;
  const floor = minusDays(a.opened_on, 6);
  const joinWeek = before.filter((d) => d.deposit_date! >= floor);
  const older = before.length - joinWeek.length;
  if (joinWeek.length) {
    joinWeekAccounts += 1;
    joinWeekRows += joinWeek.length;
    joinWeekPhp += joinWeek.reduce((s, d) => s + (d.worker_contribution_php ?? 0) + (d.simple_match_php ?? 0), 0);
    console.log(
      `  ${a.email}  ${a.account_number}  opened ${a.opened_on} (${dow(a.opened_on)})  join-week deposits: ` +
        joinWeek.map((d) => `${d.deposit_date} (${dow(d.deposit_date!)}) ₱${(d.worker_contribution_php ?? 0) + (d.simple_match_php ?? 0)}`).join(", ") +
        (older ? `  · +${older} older` : ""),
    );
  }
  if (older) { olderAccounts += 1; olderRows += older; }
}
console.log(`\n  join-week (within 6 days before opened_on): ${joinWeekAccounts} accounts · ${joinWeekRows} deposits · ₱${joinWeekPhp.toLocaleString()} invisible in balances`);
console.log(`  older than the join week (prior stints / backfill history): ${olderAccounts} accounts · ${olderRows} deposits — expected, not the ruling's class`);

line("2. Flagged members whose mesa_member_since is a SATURDAY");
const sat = rates.filter((r) => r.mesa_member_since && dow(r.mesa_member_since) === "Sat");
const byDow = new Map<string, number>();
for (const r of rates) { const k = r.mesa_member_since ? dow(r.mesa_member_since) : "null"; byDow.set(k, (byDow.get(k) ?? 0) + 1); }
console.log("  since by weekday:", Object.fromEntries([...byDow.entries()].sort()));
for (const r of sat) console.log(`  ${r["Work Email"]}  since ${r.mesa_member_since}`);
console.log(`\n  ${sat.length} Saturday-since members. Under the ruling their join week is the FOLLOWING week; nothing here is rewritten.`);
