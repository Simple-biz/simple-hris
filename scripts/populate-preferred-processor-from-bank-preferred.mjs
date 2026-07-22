// Populate employee_ids.preferred_processor (the Employee Profile "Bank
// Preferred" dropdown) FROM each CSV person's current employee_hourly_rates
// "Bank Preferred" (the send-FROM rail PD routes on). This makes the employee's
// dropdown SHOW their real routing and keeps the two in agreement.
//
// Source of the target value = the LIVE "Bank Preferred" already written to
// employee_hourly_rates (CSV values + any manual override like kaner=Wise), so
// the dropdown matches PD exactly. Scope = only people present in the PD CSV.
//
// Does NOT touch receiving accounts (account_number / swift_code).
//
//   node scripts/populate-preferred-processor-from-bank-preferred.mjs           # dry-run
//   node scripts/populate-preferred-processor-from-bank-preferred.mjs --apply    # backup + write
//
// Optional: --csv "path" (defaults references/docs/PD Data.csv)

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Missing Supabase env'); process.exit(1); }
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const APPLY = process.argv.includes('--apply');
const csvArgIdx = process.argv.indexOf('--csv');
const CSV_PATH = csvArgIdx !== -1 ? process.argv[csvArgIdx + 1] : 'references/docs/PD Data.csv';
const RATES = process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';
const IDS = 'employee_ids';
const BACKUP = `references/docs/preferred_processor_populate_backup_${new Date().toISOString().slice(0, 10)}.json`;

// MIRROR of processorIdFromBankPreferred (mock-queue.ts). Result is one of the
// CHECK-allowed ids: hurupay|wepay|higlobe|wise|jeeves|wires. x1161/x1153->wires.
function processorId(rawVal) {
  if (!rawVal) return null;
  const v = String(rawVal).trim().toLowerCase().replace(/\s+/g, '');
  if (!v) return null;
  if (['hurupay', 'huru', 'huropay'].includes(v)) return 'hurupay';
  if (v === 'wepay') return 'wepay';
  if (['higlobe', 'higloble', 'higlobel'].includes(v)) return 'higlobe';
  if (['wise', 'transferwise'].includes(v)) return 'wise';
  if (v === 'jeeves') return 'jeeves';
  if (/^x?\d{3,5}$/.test(v) || v.startsWith('wire')) return 'wires';
  return null;
}

// CSV work-email set (who is in scope)
function csvEmails(csvPath) {
  const raw = fs.readFileSync(path.resolve(csvPath), 'utf8');
  const set = new Set();
  for (const line of raw.split(/\r?\n/).slice(1)) {
    if (!line || !line.trim()) continue;
    let email;
    if (line.startsWith('"')) { const end = line.indexOf('"', 1); email = line.slice(1, end); }
    else email = line.split(',')[0];
    email = (email ?? '').trim().toLowerCase();
    if (email.includes('@')) set.add(email);
  }
  return set;
}

async function pageAll(table, select) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table} read: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const targetEmails = csvEmails(CSV_PATH);

// Current Bank Preferred per email (from live rates rows). Dedup: any row for
// the email — they were all set to the same value by the seed/override.
const rateRows = await pageAll(RATES, '"Work Email","Bank Preferred"');
const bankByEmail = new Map();
for (const r of rateRows) {
  const e = (r['Work Email'] ?? '').trim().toLowerCase();
  if (e && r['Bank Preferred']) bankByEmail.set(e, r['Bank Preferred']);
}

// employee_ids rows in scope
const idRows = await pageAll(IDS, 'id, work_email, preferred_processor');

const plan = [];
const noBank = [];
const unmapped = [];
for (const row of idRows) {
  const e = (row.work_email ?? '').trim().toLowerCase();
  if (!targetEmails.has(e)) continue; // only CSV people
  const bank = bankByEmail.get(e);
  if (!bank) { noBank.push(e); continue; }
  const pid = processorId(bank);
  if (!pid) { unmapped.push(`${e} -> "${bank}"`); continue; }
  if (row.preferred_processor === pid) continue; // already correct
  plan.push({ id: row.id, email: e, from: row.preferred_processor, to: pid, bank });
}

console.log(`Mode: ${APPLY ? 'APPLY (backup + write)' : 'DRY-RUN'}`);
console.log(`CSV people: ${targetEmails.size} | employee_ids in scope w/ a Bank Preferred`);
console.log(`Rows to set: ${plan.length}`);
const tally = {};
for (const p of plan) tally[p.to] = (tally[p.to] ?? 0) + 1;
console.log(`  by target processor: ${JSON.stringify(tally)}`);
console.log(`CSV people with NO employee_ids row: (can't populate a dropdown that has no row)`);
const idEmails = new Set(idRows.map((r) => (r.work_email ?? '').trim().toLowerCase()));
const missingIds = [...targetEmails].filter((e) => !idEmails.has(e));
console.log(`  count: ${missingIds.length}`);
if (noBank.length) console.log(`CSV people in employee_ids but NO Bank Preferred on rates: ${noBank.length}`);
if (unmapped.length) console.log(`Unmapped bank values (skipped): ${unmapped.join(', ')}`);
// spot-check kaner
const k = plan.find((p) => p.email === 'kaner@simple.biz');
console.log(`kaner: ${k ? `${k.from} -> ${k.to} (bank=${k.bank})` : '(already correct or not in plan)'}`);
console.log('');

if (!APPLY) { console.log('DRY-RUN complete. No writes. Re-run with --apply.'); process.exit(0); }

fs.writeFileSync(path.resolve(BACKUP), JSON.stringify(plan.map((p) => ({ id: p.id, email: p.email, before: p.from })), null, 0));
console.log(`Backup written: ${BACKUP} (${plan.length} rows; restore = set preferred_processor back to 'before')`);

let ok = 0, err = 0;
for (const p of plan) {
  const { error } = await supabase.from(IDS).update({ preferred_processor: p.to }).eq('id', p.id);
  if (error) { err++; console.error(`  FAIL ${p.email} -> ${p.to}: ${error.message}`); } else ok++;
}
console.log(`Set ${ok} of ${plan.length} (errors: ${err}). Receiving accounts untouched.`);
