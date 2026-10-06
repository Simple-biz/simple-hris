/**
 * READ-ONLY probe: reproduces Accounting -> MESA -> Active Members' "N members are saving but not being
 * deducted" banner EXACTLY — same three reads (`getEmployees` = /api/employees, `getEmployeeHourlyRatesRows`
 * = /api/employee-hourly-rates, the program-wide /api/mesa-ledger rollup), the same roster join as
 * `fetchMesaRoster` in src/components/payroll/AccountingMesa.tsx, and the same predicate
 * (`isMesaNeverCharged`) — then says, per flagged person, WHY no rate row carries mesa_member.
 *
 * Written 2026-10-06 when the banner read 8 while scripts/probe-mesa-flag-vs-account.mts (account-keyed)
 * read 0 on the active roster: the two count different things, so the banner gets its own instrument.
 *
 * Usage: node --import tsx scripts/probe-mesa-never-charged.mts
 * Writes nothing.
 */
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { getEmployees } = await import('../src/lib/supabase/employees');
const { getEmployeeHourlyRatesRows } = await import('../src/lib/supabase/employee-hourly-rates');
const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const { listOpenMesaAccounts } = await import('../src/lib/supabase/mesa-accounts');
const { summarizeMembers, MESA_LEDGER_SELECT } = await import('../src/lib/mesa/ledger');
const { isMesaNeverCharged } = await import('../src/lib/mesa/membership-drift');
const { mesaEmailAliasesFor, resolveMesaEmail } = await import('../src/lib/mesa/email-aliases');

type Rate = Awaited<ReturnType<typeof getEmployeeHourlyRatesRows>>['rows'][number];

const supabase = createSupabaseServiceRoleClient();
if (!supabase) throw new Error('no service-role client');

// ── The three reads the tab makes ────────────────────────────────────────────
const [{ employees, error: empErr }, { rows: rates, error: rateErr }, openAccounts] = await Promise.all([
  getEmployees(),
  getEmployeeHourlyRatesRows(),
  listOpenMesaAccounts(),
]);
if (empErr) throw new Error(`employees: ${empErr}`);
if (rateErr) throw new Error(`rates: ${rateErr}`);
const ledgerRows: Record<string, unknown>[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase.from('mesa_ledger').select(MESA_LEDGER_SELECT).range(from, from + 999);
  if (error) throw new Error(`mesa_ledger: ${error.message}`);
  ledgerRows.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const members = summarizeMembers(ledgerRows as any, openAccounts);

// ── fetchMesaRoster's join, verbatim ─────────────────────────────────────────
const ledgerByEmail = new Map<string, (typeof members)[number]>();
for (const m of members) if (m.email) ledgerByEmail.set(m.email.toLowerCase(), m);
const rateByEmail = new Map<string, Rate>();
for (const r of rates) {
  const we = r.work_email?.toLowerCase().trim();
  const pe = r.personal_email?.toLowerCase().trim();
  if (we) rateByEmail.set(we, r);
  if (pe) rateByEmail.set(pe, r);
}
const low = (s: string | null | undefined) => s?.toLowerCase().trim() || null;

console.log(`roster ${employees.length} · rate rows ${rates.length} · ledger members ${members.length} · open accounts ${openAccounts?.size ?? 'n/a'}\n`);

let n = 0;
for (const e of employees) {
  const we = low(e.work_email);
  const pe = low(e.personal_email);
  if (!we && !pe) continue;
  const emails = [we, pe, low(e.alternate_work_email), low(e.alternate_work_email_2)].filter((x): x is string => !!x);
  let rate: Rate | null = null;
  let rateKey: string | null = null;
  let ledger: (typeof members)[number] | null = null;
  for (const em of emails) {
    if (!rate && rateByEmail.get(em)) { rate = rateByEmail.get(em)!; rateKey = em; }
    if (!ledger) ledger = ledgerByEmail.get(em) ?? null;
  }
  const mesaMember = rate?.mesa_member === true;
  if (!isMesaNeverCharged({ mesaMember, ledger })) continue;
  n++;

  // Every rate row under any of the person's addresses, and every open account under any of them or an alias.
  const allRates = rates.filter((r) => emails.includes(low(r.work_email) ?? '') || emails.includes(low(r.personal_email) ?? ''));
  const accountEmails = new Set(emails.flatMap((x) => mesaEmailAliasesFor(x)));
  const accounts = [...(openAccounts?.values() ?? [])].filter((a) => accountEmails.has(a.email.toLowerCase()));

  console.log(`${n}. ${e.name}  [${e.department ?? '-'}]`);
  console.log(`   roster emails : ${emails.join(' · ')}`);
  console.log(`   ledger        : ${ledger?.email} (resolves to ${resolveMesaEmail(ledger?.email)}) acct=${ledger?.accountNumber ?? '-'} deposits=${ledger?.depositCount} balance=${ledger?.balance} last=${ledger?.lastDeposit}`);
  console.log(`   rate matched  : ${rate ? `via ${rateKey} -> work=${rate.work_email} personal=${rate.personal_email} mesa_member=${rate.mesa_member} since=${rate.mesa_member_since} acct=${rate.mesa_account_number}` : 'NONE'}`);
  for (const r of allRates) {
    console.log(`     rate row    : work=${r.work_email} personal=${r.personal_email} dept=${r.department} mesa_member=${r.mesa_member} since=${r.mesa_member_since} acct=${r.mesa_account_number}`);
  }
  console.log(`   open accounts : ${accounts.length ? accounts.map((a) => `${a.account_number} (${a.email}, opened ${a.opened_on})`).join(' · ') : 'NONE'}`);
  console.log('');
}
console.log(`${n} roster member(s) the banner counts as saving but not deducted.`);

// ── The opposite, and the one that costs people money: FLAGGED (payroll takes ₱100) with NO open account ──
// Opt Out closes the account and clears mesa_member in one call; if the flag survived on the row payroll
// reads, the person keeps being charged after leaving. Checked on the same rows the tab and Wizard read.
const openByResolved = new Set(
  [...(openAccounts?.values() ?? [])].map((a) => resolveMesaEmail(a.email) ?? a.email.toLowerCase()),
);
const rosterByEmail = new Map<string, (typeof employees)[number]>();
for (const e of employees) {
  for (const x of [e.work_email, e.personal_email, e.alternate_work_email, e.alternate_work_email_2]) {
    const k = low(x);
    if (k) rosterByEmail.set(k, e);
  }
}
let charged = 0;
const seen = new Set<string>();
for (const r of rates) {
  if (r.mesa_member !== true) continue;
  const we = low(r.work_email);
  const pe = low(r.personal_email);
  const person = (we && rosterByEmail.get(we)) || (pe && rosterByEmail.get(pe)) || null;
  const key = person ? (low(person.work_email) ?? low(person.personal_email) ?? '') : (we ?? pe ?? '');
  if (seen.has(key)) continue;
  seen.add(key);
  const addresses = [we, pe, low(person?.work_email), low(person?.personal_email), low(person?.alternate_work_email), low(person?.alternate_work_email_2)]
    .filter((x): x is string => !!x);
  const hasOpen = addresses.some((x) => openByResolved.has(resolveMesaEmail(x) ?? x));
  if (hasOpen) continue;
  charged++;
  console.log(`  FLAGGED, NO OPEN ACCOUNT: ${person?.name ?? '(not on roster)'}  work=${r.work_email} since=${r.mesa_member_since} acct=${r.mesa_account_number}${person ? '' : '  [off roster]'}`);
}
console.log(`${charged} flagged rate identit${charged === 1 ? 'y has' : 'ies have'} no open MESA account (payroll charges them; nothing receives the money).`);
