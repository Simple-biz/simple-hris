/**
 * READ-ONLY: probe the LIVE database and decide which "pending" migrations have actually run.
 *
 *   node --import tsx scripts/audit-pending-migrations.mts
 *
 * Why this exists: the repo has no migration runner and no applied-ledger, so every "PENDING" claim
 * in docs/ and memory is a claim, never a fact. Several are stale. This script replaces the claim
 * with an observation.
 *
 * READ-ONLY BY CONSTRUCTION — only `select` with `head: true` (no rows, just a count) and plain
 * counting selects. It never inserts, updates, deletes, or issues DDL. `.env.local` holds
 * PRODUCTION service-role credentials, so nothing here may write.
 *
 * What each verdict means:
 *   APPLIED       the object exists — the migration ran
 *   NOT APPLIED   the object is missing — the feature that needs it is dead
 *   INCONCLUSIVE  cannot be settled read-only through PostgREST (e.g. a CHECK constraint's allowed
 *                 values, when no row happens to use the value yet). Never reported as either.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey) {
  console.error('need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const db = createClient(url, serviceKey, { auth: { persistSession: false } });
const anon = anonKey ? createClient(url, anonKey, { auth: { persistSession: false } }) : null;

type Verdict = 'APPLIED' | 'NOT APPLIED' | 'INCONCLUSIVE';
const results: { migration: string; target: string; verdict: Verdict; detail: string }[] = [];
const record = (migration: string, target: string, verdict: Verdict, detail: string) => {
  results.push({ migration, target, verdict, detail });
  const mark = verdict === 'APPLIED' ? 'OK  ' : verdict === 'NOT APPLIED' ? 'MISS' : '??  ';
  console.log(`  ${mark} ${target.padEnd(52)} ${verdict.padEnd(13)} ${detail}`);
};

/** Does a table/view exist and how many rows? head:true fetches no rows. */
async function probeTable(migration: string, table: string) {
  const { error, count } = await db.from(table).select('*', { head: true, count: 'exact' });
  if (!error) return record(migration, `table ${table}`, 'APPLIED', `exists, ${count ?? 0} rows`);
  // 42P01 undefined_table · PGRST205 = not in PostgREST's schema cache (also "missing")
  if (error.code === '42P01' || error.code === 'PGRST205' || /does not exist|Could not find the table/i.test(error.message)) {
    return record(migration, `table ${table}`, 'NOT APPLIED', 'table does not exist');
  }
  return record(migration, `table ${table}`, 'INCONCLUSIVE', `${error.code}: ${error.message.slice(0, 70)}`);
}

/** Does a column exist on an existing table? */
async function probeColumn(migration: string, table: string, column: string) {
  const { error } = await db.from(table).select(`"${column}"`, { head: true, count: 'exact' });
  if (!error) return record(migration, `${table}.${column}`, 'APPLIED', 'column exists');
  if (error.code === '42703' || /column .* does not exist|Could not find the '.*' column/i.test(error.message)) {
    return record(migration, `${table}.${column}`, 'NOT APPLIED', 'column does not exist');
  }
  if (error.code === '42P01' || error.code === 'PGRST205') {
    return record(migration, `${table}.${column}`, 'NOT APPLIED', `parent table ${table} missing`);
  }
  return record(migration, `${table}.${column}`, 'INCONCLUSIVE', `${error.code}: ${error.message.slice(0, 70)}`);
}

/**
 * A CHECK-constraint widening cannot be read through PostgREST. The only read-only evidence is
 * whether a row already USES the value: if one does, the constraint permits it. Absence proves
 * nothing — the feature may simply not have fired yet — so that is INCONCLUSIVE, never NOT APPLIED.
 */
async function probeNotificationType(migration: string, type: string) {
  const { error, count } = await db
    .from('employee_notifications')
    .select('id', { head: true, count: 'exact' })
    .eq('type', type);
  if (error) return record(migration, `notification type ${type}`, 'INCONCLUSIVE', `${error.code}: ${error.message.slice(0, 60)}`);
  if ((count ?? 0) > 0) {
    return record(migration, `notification type ${type}`, 'APPLIED', `${count} row(s) exist, so the CHECK permits it`);
  }
  return record(migration, `notification type ${type}`, 'INCONCLUSIVE', 'no rows use this type — CHECK not readable via PostgREST');
}

console.log(`probing ${url}\n`);

console.log('#1/#2 employee_notifications type CHECK widenings');
await probeNotificationType('add_bank_preferred_type', 'bank_preferred.decided');
await probeNotificationType('add_bank_override_type', 'people.banking.overridden');
await probeNotificationType('add_payroll_paid_notification_type', 'payroll.paid');
await probeNotificationType('add_payroll_available_notification_type', 'payroll.available');
await probeNotificationType('pab_exclusion_notification_types', 'pab.excluded');
await probeNotificationType('pab_exclusion_notification_types', 'pab.restored');

console.log('\n#3 Bank Info Temporary Exemption');
await probeTable('create_payroll_bank_exemptions', 'payroll_bank_exemptions');

console.log('\n#4/#5 CallTools usernames');
await probeTable('2026-07-20_employee_calltools_usernames', 'employee_calltools_usernames');
await probeColumn('add_calltools_username_to_onboarding', 'hr_onboarding_submissions', 'calltools_username');
await probeColumn('add_calltools_username_to_onboarding', 'hr_onboarding_submissions', 'calltools_nickname');

console.log('\n#6 MESA per-stint accounts');
await probeTable('2026-07-16_mesa_accounts', 'mesa_accounts');
await probeColumn('2026-07-16_mesa_accounts', 'employee_hourly_rates', 'mesa_account_number');

console.log('\n#7 Onboarding IP assignment');
await probeColumn('add_ip_assignment_to_onboarding', 'hr_onboarding_submissions', 'ip_agreement_agreed');
await probeColumn('add_ip_assignment_to_onboarding', 'hr_onboarding_submissions', 'ip_assignment_file_path');

console.log('\n#8 Onboarding pay plans');
await probeTable('create_onboarding_pay_plans', 'onboarding_pay_plans');
await probeColumn('add_invite_country_to_onboarding', 'hr_onboarding_submissions', 'invite_country');

console.log('\n#9 Gmail surname');
await probeColumn('add_gmail_surname_to_onboarding', 'hr_onboarding_submissions', 'gmail_surname');

console.log('\n#10 MESA opt-in request cleanup (one-time DELETE)');
{
  const { error, count } = await db
    .from('mesa_requests')
    .select('id', { head: true, count: 'exact' })
    .eq('request_type', 'opt_in');
  if (error) record('delete_mesa_optin_requests', "mesa_requests request_type='opt_in'", 'INCONCLUSIVE', `${error.code}: ${error.message.slice(0, 60)}`);
  else if ((count ?? 0) === 0) record('delete_mesa_optin_requests', "mesa_requests request_type='opt_in'", 'APPLIED', 'zero opt_in rows remain');
  else record('delete_mesa_optin_requests', "mesa_requests request_type='opt_in'", 'NOT APPLIED', `${count} legacy opt_in row(s) still present`);
}

console.log('\n#11 active_employees definer restore (anon-key visibility)');
if (!anon) {
  record('restore_active_employees_definer', 'active_employees (anon)', 'INCONCLUSIVE', 'no anon key in env');
} else {
  const [{ count: anonCount, error: anonErr }, { count: svcCount }] = await Promise.all([
    anon.from('active_employees').select('*', { head: true, count: 'exact' }),
    db.from('active_employees').select('*', { head: true, count: 'exact' }),
  ]);
  if (anonErr) record('restore_active_employees_definer', 'active_employees (anon)', 'INCONCLUSIVE', `${anonErr.code}: ${anonErr.message.slice(0, 60)}`);
  else if ((anonCount ?? 0) === 0 && (svcCount ?? 0) > 0) {
    record('restore_active_employees_definer', 'active_employees (anon)', 'NOT APPLIED', `anon sees 0, service-role sees ${svcCount} — still security_invoker`);
  } else record('restore_active_employees_definer', 'active_employees (anon)', 'APPLIED', `anon sees ${anonCount}, service-role ${svcCount}`);
}

console.log('\nOther claimed-pending objects');
await probeTable('seed_paystub_dispatch_queue', 'paystub_dispatch_queue');
await probeTable('add_urgent_payment_requests', 'urgent_payment_requests');
await probeTable('create_mesa_notes', 'mesa_notes');
await probeColumn('2026-07-20_split_onboarding_name_columns', 'hr_onboarding_submissions', 'first_name');
await probeColumn('2026-07-20_split_onboarding_name_columns', 'hr_onboarding_submissions', 'last_name');
await probeTable('2026-07-29_mesa_request_receipts', 'mesa_request_receipts');

/**
 * A CHECK constraint's allowed values are unreadable through PostgREST, but trivially readable over a
 * direct Postgres connection. With DATABASE_URL set, this settles the three INCONCLUSIVE rows above
 * for good. Still read-only: a SELECT against pg_constraint.
 */
if (process.env.DATABASE_URL?.trim()) {
  console.log('\nDATABASE_URL present — reading the real CHECK constraint (read-only)');
  const { Client } = await import('pg');
  // Supabase requires TLS and its cert chain is not in Node's default store.
  const client = new Client({ connectionString: process.env.DATABASE_URL.trim(), ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    const { rows } = await client.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def
         from pg_constraint
        where conrelid = 'public.employee_notifications'::regclass and contype = 'c'`,
    );
    const allDefs = rows.map((r) => r.def).join(' ');
    for (const [migration, type] of [
      ['add_bank_override_type', 'people.banking.overridden'],
      ['pab_exclusion_notification_types', 'pab.excluded'],
      ['pab_exclusion_notification_types', 'pab.restored'],
    ] as [string, string][]) {
      // Replace the earlier INCONCLUSIVE verdict with a real one.
      const i = results.findIndex((r) => r.target === `notification type ${type}`);
      if (i >= 0) results.splice(i, 1);
      const permitted = allDefs.includes(`'${type}'`);
      record(migration, `notification type ${type}`, permitted ? 'APPLIED' : 'NOT APPLIED', permitted ? 'present in the CHECK definition' : 'ABSENT from the CHECK — inserts are rejected');
    }
  } catch (e) {
    console.log(`  could not connect: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
    console.log('  (use the DIRECT connection on port 5432, not the pooler)');
  } finally {
    await client.end().catch(() => {});
  }
} else {
  console.log('\nSet DATABASE_URL in .env.local to settle the CHECK-constraint rows definitively.');
  console.log('  Supabase dashboard -> Project Settings -> Database -> Connection string -> URI (port 5432).');
}

const by = (v: Verdict) => results.filter((r) => r.verdict === v);
console.log('\n' + '─'.repeat(92));
console.log(`APPLIED ${by('APPLIED').length} · NOT APPLIED ${by('NOT APPLIED').length} · INCONCLUSIVE ${by('INCONCLUSIVE').length}`);
if (by('NOT APPLIED').length) {
  console.log('\nSTILL NOT APPLIED — the feature depending on each of these is dead:');
  for (const r of by('NOT APPLIED')) console.log(`  ${r.migration.padEnd(46)} ${r.target} — ${r.detail}`);
}
if (by('INCONCLUSIVE').length) {
  console.log('\nNOT SETTLEABLE READ-ONLY (do not record either way):');
  for (const r of by('INCONCLUSIVE')) console.log(`  ${r.migration.padEnd(46)} ${r.target} — ${r.detail}`);
}
