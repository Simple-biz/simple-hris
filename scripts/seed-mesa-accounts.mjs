// Backfill the mesa_accounts registry (one row per MESA enrollment stint) and
// stamp every current member's OPEN account number onto their rates rows.
//
// Run AFTER references/sql/migrate/2026-07-16_mesa_accounts.sql (which creates
// the table + the employee_hourly_rates.mesa_account_number column).
//
// HOW STINTS ARE DERIVED (from mesa_ledger)
// -----------------------------------------
// A stint ends at a TERMINATION event: a status='Inactive' row or an
// 'Opt-out'/'Termination' disbursement. Terminations are resolved per sheet
// member id (opt_in_number) because the sheet re-issues ids — a re-join gets a
// new id (april@simple.biz: 16962080 opted out 2026-06-15, re-joined as
// 17828839), while some ids changed with NO termination (kristinec) or even
// run concurrently (joe) — those stay ONE account.
//
//   * CLOSED account: one per terminated member id — opened at that id's first
//     deposit, closed at its dated termination (fallback: the id's last event).
//   * OPEN account: only for emails currently flagged mesa_member=true on
//     employee_hourly_rates (the system of record for enrollment). Opened at
//     the first deposit AFTER the last termination on a non-terminated id
//     (fallback: first deposit ever when never terminated; then
//     mesa_member_since; then today Manila).
//
// ACCOUNT NUMBERS: "YY-MM-#####" — the opening month + a per-month serial,
// continuing after any serials already in mesa_accounts (idempotent: accounts
// already registered for an (email, opened_on) are left untouched, so re-runs
// never renumber).
//
// SAFE BY DEFAULT: dry-run unless you pass --apply.
//   node scripts/seed-mesa-accounts.mjs           # report only
//   node scripts/seed-mesa-accounts.mjs --apply   # write accounts + rates rows

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const APPLY = process.argv.includes('--apply');
const RATES_TABLE = process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const manilaToday = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const low = (s) => (s ?? '').trim().toLowerCase();
const eventDate = (r) => r.deposit_date ?? r.disbursement_date ?? '';
const isTermination = (r) =>
  r.status === 'Inactive' || /opt.?out|termination/i.test(r.disbursement_type ?? '');
const terminationDate = (r) =>
  r.inactive_payroll_notified ?? r.disbursement_date ?? r.deposit_date ?? null;

async function pageAll(table, select, decorate = (q) => q) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await decorate(
      supabase.from(table).select(select).range(from, from + 999),
    );
    if (error) throw new Error(`${table} read: ${error.message}`);
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

// ── 1. Inputs ────────────────────────────────────────────────────────────────
const ledger = await pageAll(
  'mesa_ledger',
  'email,name,opt_in_number,status,deposit_date,disbursement_date,disbursement_type,inactive_payroll_notified,total_daily_deposit_php',
);
const flaggedRows = await pageAll(
  RATES_TABLE,
  '"Work Email","Personal Email",mesa_member,mesa_member_since',
  (q) => q.eq('mesa_member', true),
);
let existing = [];
let accountsTableMissing = false;
try {
  existing = await pageAll('mesa_accounts', 'account_number,email,opened_on,closed_on');
} catch (e) {
  if (!/does not exist|schema cache/i.test(String(e.message))) throw e;
  accountsTableMissing = true;
  console.warn('mesa_accounts table not found — run references/sql/migrate/2026-07-16_mesa_accounts.sql first.' +
    (APPLY ? '' : ' Dry-run continues as if it were empty.'));
  if (APPLY) process.exit(1);
}

// flagged email -> mesa_member_since (any row; toggle/preload keep them in sync)
const flagged = new Map();
for (const r of flaggedRows) {
  for (const e of [r['Work Email'], r['Personal Email']]) {
    const n = low(e);
    if (n && !flagged.has(n)) flagged.set(n, r.mesa_member_since ?? null);
  }
}

const byEmail = new Map();
for (const r of ledger) {
  const e = low(r.email);
  if (!e) continue;
  if (!byEmail.has(e)) byEmail.set(e, []);
  byEmail.get(e).push(r);
}

// ── 2. Derive accounts per email ─────────────────────────────────────────────
const derived = []; // {email, name, opened_on, closed_on|null}
const skippedUnflaggedActive = [];

for (const [email, rows] of byEmail) {
  const name = rows.find((r) => r.name)?.name ?? null;
  const numericId = (r) => ((r.opt_in_number ?? '').trim().match(/^\d+$/) ? r.opt_in_number.trim() : null);

  // Group rows by sheet member id; collect per-id termination info.
  const idRows = new Map(); // id -> rows
  for (const r of rows) {
    const id = numericId(r);
    if (!id) continue;
    if (!idRows.has(id)) idRows.set(id, []);
    idRows.get(id).push(r);
  }
  const terminated = new Map(); // id -> closed_on
  for (const [id, group] of idRows) {
    const terms = group.filter(isTermination);
    if (!terms.length) continue;
    const dated = terms.map(terminationDate).filter(Boolean).sort().pop() ?? null;
    const lastEvent = group.map(eventDate).filter(Boolean).sort().pop() ?? null;
    terminated.set(id, dated ?? lastEvent ?? manilaToday);
  }
  // Terminations on rows with no member id (rare) still end the CURRENT stint.
  const idlessTerms = rows.filter((r) => isTermination(r) && !numericId(r));
  const idlessT = idlessTerms.map((r) => terminationDate(r)).filter(Boolean).sort().pop() ?? null;

  // Closed account per terminated id.
  for (const [id, closedOn] of terminated) {
    const deposits = idRows.get(id).filter((r) => (r.total_daily_deposit_php ?? 0) > 0 && r.deposit_date);
    const openedOn =
      deposits.map((r) => r.deposit_date).sort()[0] ??
      idRows.get(id).map(eventDate).filter(Boolean).sort()[0] ??
      closedOn;
    derived.push({ email, name, opened_on: openedOn, closed_on: closedOn });
  }

  // Open account — only for currently-enrolled (flagged) members.
  if (!flagged.has(email)) {
    const everTerminated = terminated.size > 0 || idlessTerms.length > 0;
    if (!everTerminated) skippedUnflaggedActive.push(email);
    continue;
  }
  const lastT = [...terminated.values(), ...(idlessT ? [idlessT] : [])].sort().pop() ?? null;
  const liveDeposits = rows.filter(
    (r) =>
      (r.total_daily_deposit_php ?? 0) > 0 &&
      r.deposit_date &&
      !(numericId(r) && terminated.has(numericId(r))) &&
      (!lastT || r.deposit_date > lastT),
  );
  const openedOn =
    liveDeposits.map((r) => r.deposit_date).sort()[0] ?? flagged.get(email) ?? manilaToday;
  derived.push({ email, name, opened_on: openedOn, closed_on: null });
}

// Flagged members with no ledger history at all still get an open account —
// per rate-row person (work email first), so a work+personal alias pair never
// mints two accounts.
const derivedOpen = new Set(derived.filter((a) => !a.closed_on).map((a) => a.email));
for (const r of flaggedRows) {
  const wk = low(r['Work Email']);
  const pe = low(r['Personal Email']);
  const primary = wk || pe;
  if (!primary) continue;
  const covered = [wk, pe].some((e) => e && (byEmail.has(e) || derivedOpen.has(e)));
  if (covered) continue;
  derivedOpen.add(primary);
  derived.push({ email: primary, name: null, opened_on: r.mesa_member_since ?? manilaToday, closed_on: null });
}

// ── 3. Number the new accounts (continue each month's serial) ───────────────
const monthKey = (openedOn) => `${openedOn.slice(2, 4)}-${openedOn.slice(5, 7)}`;
const maxSerial = new Map();
for (const a of existing) {
  const m = a.account_number.match(/^(\d{2}-\d{2})-(\d{5})$/);
  if (!m) continue;
  maxSerial.set(m[1], Math.max(maxSerial.get(m[1]) ?? 0, parseInt(m[2], 10)));
}
const existingKey = new Set(existing.map((a) => `${low(a.email)}|${a.opened_on}`));
const hasOpen = new Set(existing.filter((a) => !a.closed_on).map((a) => low(a.email)));

const toInsert = [];
for (const a of derived.sort((x, y) => (x.opened_on + x.email).localeCompare(y.opened_on + y.email))) {
  if (existingKey.has(`${a.email}|${a.opened_on}`)) continue; // already registered
  if (!a.closed_on && hasOpen.has(a.email)) continue; // an open account already exists
  const mk = monthKey(a.opened_on);
  const serial = (maxSerial.get(mk) ?? 0) + 1;
  maxSerial.set(mk, serial);
  toInsert.push({ ...a, account_number: `${mk}-${String(serial).padStart(5, '0')}` });
}

const openAccounts = new Map(); // email -> {account_number, opened_on} (existing open kept)
for (const a of existing) if (!a.closed_on) openAccounts.set(low(a.email), a);
for (const a of toInsert) if (!a.closed_on) openAccounts.set(a.email, a);

// ── 4. Report ────────────────────────────────────────────────────────────────
console.log(`Ledger emails: ${byEmail.size} | flagged members: ${flagged.size}`);
console.log(`Derived accounts: ${derived.length} (${derived.filter((a) => !a.closed_on).length} open / ${derived.filter((a) => a.closed_on).length} closed)`);
console.log(`Already registered: ${existing.length} | to insert now: ${toInsert.length}`);
if (skippedUnflaggedActive.length) {
  console.log(`\nLedger-active but NOT flagged on rates (no account created — reconcile emails first): ${skippedUnflaggedActive.length}`);
  skippedUnflaggedActive.forEach((e) => console.log(`  - ${e}`));
}
const show = (email) => {
  const accts = [...toInsert, ...existing.map((a) => ({ ...a, email: low(a.email) }))].filter((a) => a.email === email);
  console.log(`  ${email}: ${accts.map((a) => `${a.account_number} [${a.opened_on} → ${a.closed_on ?? 'open'}]`).join(', ') || '(none)'}`);
};
console.log('\nSpot checks:');
['april@simple.biz', 'joang@simple.biz', 'joe@simple.biz', 'juliar@simple.biz', 'kristinec@simple.biz'].forEach(show);
const byMonth = new Map();
for (const a of toInsert) byMonth.set(monthKey(a.opened_on), (byMonth.get(monthKey(a.opened_on)) ?? 0) + 1);
console.log('\nNew accounts per opening month:', [...byMonth.entries()].sort().map(([m, n]) => `${m}:${n}`).join('  '));

if (!APPLY) {
  console.log('\nDry-run only. Re-run with --apply to write.');
  process.exit(0);
}

// ── 5. Write accounts ────────────────────────────────────────────────────────
for (let i = 0; i < toInsert.length; i += 200) {
  const chunk = toInsert.slice(i, i + 200).map(({ email, name, opened_on, closed_on, account_number }) => ({
    email, name, opened_on, closed_on, account_number,
  }));
  const { error } = await supabase.from('mesa_accounts').insert(chunk);
  if (error) {
    console.error(`mesa_accounts insert failed at ${i}: ${error.message}`);
    process.exit(1);
  }
  console.log(`inserted ${Math.min(i + 200, toInsert.length)}/${toInsert.length}`);
}

// ── 6. Stamp open account numbers (+ corrected since) onto rates rows ────────
let stamped = 0;
const unmatchedRates = [];
for (const [email, acct] of openAccounts) {
  if (!flagged.has(email)) continue;
  const update = { mesa_account_number: acct.account_number, mesa_member_since: acct.opened_on };
  const tryCol = async (col) => {
    const { data, error } = await supabase.from(RATES_TABLE).update(update).ilike(col, email).select('id');
    if (error) throw new Error(`${email} rates update(${col}): ${error.message}`);
    return data?.length ?? 0;
  };
  let n = await tryCol('Work Email');
  if (n === 0) n = await tryCol('Personal Email');
  if (n > 0) stamped += 1;
  else unmatchedRates.push(email);
}
console.log(`\nRates rows stamped for ${stamped} member(s).`);
if (unmatchedRates.length) {
  console.log(`No rate row matched for: ${unmatchedRates.join(', ')}`);
}
console.log('Done.');
