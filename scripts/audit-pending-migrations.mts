/**
 * READ-ONLY: probe the LIVE database and decide which "pending" migrations have actually run.
 *
 *   node --import tsx scripts/audit-pending-migrations.mts
 *
 * Why this exists: the repo has no migration runner and no applied-ledger, so every "PENDING" claim
 * in docs/ and memory is a claim, never a fact. Several are stale. This script replaces the claim
 * with an observation.
 *
 * READ-ONLY BY CONSTRUCTION — only `select`. It never inserts, updates, deletes, or issues DDL.
 * `.env.local` holds PRODUCTION service-role credentials, so nothing here may write.
 *
 * EXISTENCE IS NEVER PROBED WITH `head: true`. PostgREST answers a `head: true` select against a
 * table that does not exist with `error: null` and `count: null` — no `42P01`, no `PGRST205` — so
 * the old probe reported every table-creating migration that never ran as APPLIED, and a missing
 * COLUMN (which errors with an empty code AND an empty message) as INCONCLUSIVE. Existence is asked
 * with a plain `.select(...).limit(1)`, classified by `src/lib/db/probe-verdict.ts`, and a NEGATIVE
 * CONTROL runs first: if a table and a column that cannot exist are not both reported missing, this
 * script ABORTS rather than emit a report it has just proved it cannot trust.
 *
 * What each verdict means:
 *   APPLIED       the object exists — the migration ran
 *   NOT APPLIED   the object is missing — the feature that needs it is dead
 *   INCONCLUSIVE  cannot be settled read-only through PostgREST (e.g. a CHECK constraint's allowed
 *                 values, when no row happens to use the value yet). Never reported as either.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

/**
 * Dynamic, not static: a `.mts` script pulling NAMED exports out of a `.ts` module hits the same
 * CJS/ESM interop wall `monday.mts` documents, and every other script here resolves it this way.
 */
const { classifyColumnProbe, classifyTableProbe, readCount } = await import('../src/lib/db/probe-verdict');

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

/**
 * Does a table/view exist, and how many rows does it hold?
 *
 * TWO queries on purpose. Existence is decided by a plain `.limit(1)`, which errors correctly for a
 * missing object; the count is asked SEPARATELY and only once existence is settled, so `head: true`
 * can never be the thing that decides whether the migration ran.
 */
async function probeTable(migration: string, table: string) {
  const { error } = await db.from(table).select('*').limit(1);
  const existence = classifyTableProbe(error);
  if (existence === 'MISSING') return record(migration, `table ${table}`, 'NOT APPLIED', 'table does not exist');
  if (existence === 'UNKNOWN') {
    return record(migration, `table ${table}`, 'INCONCLUSIVE', `${error?.code ?? '(no code)'}: ${(error?.message ?? '').slice(0, 70)}`);
  }
  const { error: countErr, count } = await db.from(table).select('*', { head: true, count: 'exact' });
  const rows = readCount(countErr, count);
  return record(migration, `table ${table}`, 'APPLIED', rows === null ? 'exists, row count unavailable' : `exists, ${rows} rows`);
}

/** Does a column exist on a table? A missing PARENT table is reported as NOT APPLIED too. */
async function probeColumn(migration: string, table: string, column: string) {
  const { error } = await db.from(table).select(`"${column}"`).limit(1);
  const existence = classifyColumnProbe(error);
  if (existence === 'PRESENT') return record(migration, `${table}.${column}`, 'APPLIED', 'column exists');
  if (existence === 'MISSING') {
    const parentMissing = error?.code === '42P01' || error?.code === 'PGRST205';
    return record(migration, `${table}.${column}`, 'NOT APPLIED', parentMissing ? `parent table ${table} missing` : 'column does not exist');
  }
  return record(migration, `${table}.${column}`, 'INCONCLUSIVE', `${error?.code ?? '(no code)'}: ${(error?.message ?? '').slice(0, 70)}`);
}

/**
 * NEGATIVE CONTROL — the precondition for believing anything below.
 *
 * A probe that cannot detect absence produces a report indistinguishable from one that found none,
 * which is exactly how the `head: true` bug survived: it works perfectly for objects that DO exist,
 * so every passing case looked right. This asks for a table and a column that cannot exist and
 * requires both to come back missing. It writes no `results` entry — a control is not a finding —
 * and on failure it EXITS rather than degrade to a warning.
 */
async function assertProbesDetectAbsence() {
  const fakeTable = 'definitely_not_a_table_xyz';
  const fakeColumn = 'definitely_not_a_column_xyz';
  const { error: tableErr } = await db.from(fakeTable).select('*').limit(1);
  const { error: columnErr } = await db.from('employee_notifications').select(`"${fakeColumn}"`).limit(1);
  const tableVerdict = classifyTableProbe(tableErr);
  const columnVerdict = classifyColumnProbe(columnErr);
  console.log(`negative control: table ${fakeTable} -> ${tableVerdict} · employee_notifications.${fakeColumn} -> ${columnVerdict}`);
  if (tableVerdict !== 'MISSING' || columnVerdict !== 'MISSING') {
    console.error('\nABORT: the probes cannot detect absence, so every APPLIED below would be unfalsifiable.');
    console.error(`  table control  ${tableVerdict}  ${tableErr ? `${tableErr.code}: ${tableErr.message}` : '(no error returned)'}`);
    console.error(`  column control ${columnVerdict}  ${columnErr ? `${columnErr.code}: ${columnErr.message}` : '(no error returned)'}`);
    process.exit(1);
  }
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
  const rows = readCount(error, count);
  if (rows === null) {
    return record(migration, `notification type ${type}`, 'INCONCLUSIVE', 'count came back null with no error — unreadable, NOT a zero');
  }
  if (rows > 0) {
    return record(migration, `notification type ${type}`, 'APPLIED', `${rows} row(s) exist, so the CHECK permits it`);
  }
  return record(migration, `notification type ${type}`, 'INCONCLUSIVE', 'no rows use this type — CHECK not readable via PostgREST');
}

console.log(`probing ${url}\n`);
await assertProbesDetectAbsence();
console.log('');

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
  const rows = readCount(error, count);
  if (error) record('delete_mesa_optin_requests', "mesa_requests request_type='opt_in'", 'INCONCLUSIVE', `${error.code}: ${error.message.slice(0, 60)}`);
  // A null count with no error is what a MISSING table returns — reading it as "zero remain" would
  // have closed this migration on the absence of the table it deletes from.
  else if (rows === null) record('delete_mesa_optin_requests', "mesa_requests request_type='opt_in'", 'INCONCLUSIVE', 'count null with no error — mesa_requests may not exist');
  else if (rows === 0) record('delete_mesa_optin_requests', "mesa_requests request_type='opt_in'", 'APPLIED', 'zero opt_in rows remain');
  else record('delete_mesa_optin_requests', "mesa_requests request_type='opt_in'", 'NOT APPLIED', `${rows} legacy opt_in row(s) still present`);
}

console.log('\n#11 active_employees definer restore (anon-key visibility)');
if (!anon) {
  record('restore_active_employees_definer', 'active_employees (anon)', 'INCONCLUSIVE', 'no anon key in env');
} else {
  const [{ count: anonCount, error: anonErr }, { count: svcCount }] = await Promise.all([
    anon.from('active_employees').select('*', { head: true, count: 'exact' }),
    db.from('active_employees').select('*', { head: true, count: 'exact' }),
  ]);
  const anonRows = readCount(anonErr, anonCount);
  const svcRows = readCount(null, svcCount);
  if (anonErr) record('restore_active_employees_definer', 'active_employees (anon)', 'INCONCLUSIVE', `${anonErr.code}: ${anonErr.message.slice(0, 60)}`);
  // Only a REAL zero is the security_invoker symptom. A null count is the shape of an unreadable
  // object, and calling it 0 would blame the view definition for a probe that never resolved.
  else if (anonRows === null || svcRows === null) {
    record('restore_active_employees_definer', 'active_employees (anon)', 'INCONCLUSIVE', `count null with no error (anon=${anonCount}, service=${svcCount}) — unreadable, NOT a zero`);
  } else if (anonRows === 0 && svcRows > 0) {
    record('restore_active_employees_definer', 'active_employees (anon)', 'NOT APPLIED', `anon sees 0, service-role sees ${svcRows} — still security_invoker`);
  } else record('restore_active_employees_definer', 'active_employees (anon)', 'APPLIED', `anon sees ${anonRows}, service-role ${svcRows}`);
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
