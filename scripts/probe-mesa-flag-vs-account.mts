/**
 * READ-ONLY probe: who has an OPEN MESA account but is NOT flagged for the
 * payroll deduction — i.e. the program thinks they are saving, and payroll
 * never takes the PHP100.
 *
 * Found while investigating jimg@simple.biz (Kane, 2026-09-15). His MESA
 * identity is the ledger email `jim@simple.biz`; his rate rows, roster row and
 * Hubstaff rows are all `jimg@simple.biz`. `scripts/backfill-mesa-from-csv.mjs`
 * stamps `mesa_member` by matching the LEDGER email against rate rows and does
 * NOT consult src/data/mesa-email-aliases.json (grep: zero alias references),
 * so every aliased member was left unflagged.
 *
 * Reproduces both sides of the disagreement:
 *   - Accounting -> MESA -> Active Members uses `isActiveMember`, whose ledger
 *     leg IS alias-resolved (summarizeMembers -> resolveMesaEmail), so these
 *     people show as members with a balance.
 *   - The Payroll Wizard and the ledger writer gate on
 *     employee_hourly_rates.mesa_member, which is NOT alias-resolved.
 *
 * Usage: node --import tsx scripts/probe-mesa-flag-vs-account.mts
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import("../src/lib/supabase/server");
const { selectAllPaged } = await import("../src/lib/supabase/select-all-paged");
const { summarizeMembers } = await import("../src/lib/mesa/ledger");
const { resolveMesaEmail } = await import("../src/lib/mesa/email-aliases");

const supabase = createSupabaseServiceRoleClient();
if (!supabase) {
  console.error("No service-role client — check .env.local");
  process.exit(1);
}

const line = (s: string) => console.log("\n" + "-".repeat(78) + "\n" + s + "\n" + "-".repeat(78));
const norm = (e: unknown) => String(e ?? "").trim().toLowerCase();

type Account = { account_number: string; email: string; name: string | null; opened_on: string; closed_on: string | null };
type Rate = { "Work Email": string | null; "Personal Email": string | null; mesa_member: boolean | null; mesa_member_since: string | null; mesa_account_number: string | null; mesa_fpu_completed_on: string | null };

const { rows: accounts, error: aErr } = await selectAllPaged<Account>((from, to) =>
  supabase.from("mesa_accounts").select("account_number, email, name, opened_on, closed_on")
    .is("closed_on", null).order("account_number").range(from, to),
);
if (aErr) { console.error("mesa_accounts:", aErr); process.exit(1); }

const { rows: rates, error: rErr } = await selectAllPaged<Rate>((from, to) =>
  supabase.from("employee_hourly_rates_current")
    .select('"Work Email", "Personal Email", mesa_member, mesa_member_since, mesa_account_number, mesa_fpu_completed_on')
    .order("id").range(from, to),
);
if (rErr) { console.error("rates:", rErr); process.exit(1); }

const { rows: roster, error: roErr } = await selectAllPaged<Record<string, unknown>>((from, to) =>
  supabase.from("active_employees").select('"Work Email", "Name", "Department"').order("Work Email").range(from, to),
);
if (roErr) { console.error("active_employees:", roErr); process.exit(1); }

const { rows: events, error: lErr } = await selectAllPaged<any>((from, to) =>
  supabase.from("mesa_ledger")
    .select("id, email, name, department, status, worker_contribution_php, simple_match_php, total_daily_deposit_php, deposit_date, disbursement_amount_php, disbursement_date, disbursement_type, notes, additional_notes")
    .order("id").range(from, to),
);
if (lErr) { console.error("mesa_ledger:", lErr); process.exit(1); }

const rateByEmail = new Map<string, Rate>();
for (const r of rates) {
  const w = norm(r["Work Email"]);
  const p = norm(r["Personal Email"]);
  if (w) rateByEmail.set(w, r);
  if (p && !rateByEmail.has(p)) rateByEmail.set(p, r);
}
const rosterByEmail = new Map<string, Record<string, unknown>>();
for (const e of roster) rosterByEmail.set(norm(e["Work Email"]), e);

// The ledger rollup the Accounting tab sees — alias-resolved.
const summaries = summarizeMembers(events as any);
const summaryByEmail = new Map<string, any>();
for (const s of summaries) summaryByEmail.set(norm(s.email), s);

line("Inputs");
console.log("  open mesa_accounts: " + accounts.length);
console.log("  rate rows (current view): " + rates.length + "  ·  flagged mesa_member=true: " + rates.filter((r) => r.mesa_member === true).length);
console.log("  active roster: " + roster.length + "  ·  ledger members (alias-resolved): " + summaries.length);

line("OPEN MESA account, but NO rate row carries mesa_member=true -> payroll never deducts");
const broken: Array<{ acct: Account; resolved: string; rate: Rate | undefined; onRoster: boolean; balance: number; deposits: number; lastDeposit: string | null }> = [];
for (const a of accounts) {
  const ledgerEmail = norm(a.email);
  const resolved = norm(resolveMesaEmail(ledgerEmail));
  // Does ANY rate row for either address carry the flag?
  const direct = rateByEmail.get(ledgerEmail);
  const viaAlias = rateByEmail.get(resolved);
  const flagged = direct?.mesa_member === true || viaAlias?.mesa_member === true;
  if (flagged) continue;
  const s = summaryByEmail.get(resolved) ?? summaryByEmail.get(ledgerEmail);
  broken.push({
    acct: a,
    resolved,
    rate: viaAlias ?? direct,
    onRoster: rosterByEmail.has(resolved) || rosterByEmail.has(ledgerEmail),
    balance: s?.balance ?? 0,
    deposits: s?.depositCount ?? 0,
    lastDeposit: s?.lastDeposit ?? null,
  });
}
console.log("  " + broken.length + " of " + accounts.length + " open accounts are UNFLAGGED\n");
const aliased = broken.filter((b) => b.resolved !== norm(b.acct.email));
const noRate = broken.filter((b) => !b.rate);
const hasRateUnflagged = broken.filter((b) => b.rate && b.rate.mesa_member !== true);
console.log("  of those:");
console.log("    ledger email is an ALIAS of a different roster email: " + aliased.length);
console.log("    no rate row at all under either address:              " + noRate.length);
console.log("    HAS a rate row, flag is false/null:                   " + hasRateUnflagged.length);
console.log("    still on the ACTIVE roster (so still being paid):     " + broken.filter((b) => b.onRoster).length);

console.log("\n  Detail (on the active roster first):");
const sorted = [...broken].sort((a, b) => Number(b.onRoster) - Number(a.onRoster) || b.balance - a.balance);
for (const b of sorted) {
  const rosterRow = rosterByEmail.get(b.resolved) ?? rosterByEmail.get(norm(b.acct.email));
  console.log(
    "    " + (b.onRoster ? "ACTIVE " : "off-rstr") +
      "  acct " + b.acct.account_number +
      "  ledger=" + b.acct.email +
      (b.resolved !== norm(b.acct.email) ? "  -> roster=" + b.resolved : "") +
      "  opened " + b.acct.opened_on +
      "  balance PHP" + b.balance +
      "  deposits " + b.deposits +
      "  last " + (b.lastDeposit ?? "--"),
  );
  console.log(
    "              rateRow=" + (b.rate ? "yes (mesa_member=" + JSON.stringify(b.rate.mesa_member) + ", fpu=" + JSON.stringify(b.rate.mesa_fpu_completed_on) + ")" : "NONE") +
      (rosterRow ? "  name=" + JSON.stringify(rosterRow["Name"]) + "  dept=" + JSON.stringify(rosterRow["Department"]) : ""),
  );
}

line("Money: what the unflagged have NOT contributed since the backfill (2026-08-28)");
const CUTOFF = "2026-08-28";
let weeksMissed = 0;
for (const b of broken.filter((x) => x.onRoster)) {
  // Fridays between the cutoff and today that they were enrolled for.
  const start = Date.parse(CUTOFF + "T00:00:00Z");
  const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  let n = 0;
  for (let t = start; t <= today; t += 86_400_000) {
    if (new Date(t).getUTCDay() === 5) n += 1;
  }
  weeksMissed += n;
}
console.log("  " + broken.filter((x) => x.onRoster).length + " active people x Fridays since " + CUTOFF + " = " + weeksMissed + " member-weeks");
console.log("  worker contributions not taken: PHP" + (weeksMissed * 100).toLocaleString());
console.log("  company match not credited:     PHP" + (weeksMissed * 300).toLocaleString());
console.log("  (indicative — a week with no hours would not have been deducted anyway)");

line("Cross-check: does Accounting -> MESA -> Active Members SHOW these people?");
console.log("  isActiveMember = !ledgerOptedOut && (mesa_member || hasContributions)");
console.log("  The ledger leg is alias-resolved, so anyone above with deposits shows as an ACTIVE MEMBER");
console.log("  with a balance, while payroll takes nothing. That is the contradiction being reported.\n");
for (const b of sorted.filter((x) => x.onRoster && x.deposits > 0)) {
  console.log("    " + b.resolved + ": Active Members tab shows PHP" + b.balance + " (" + b.deposits + " deposits) · payroll deduction: NONE");
}
