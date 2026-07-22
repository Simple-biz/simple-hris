// Clear employee_ids.preferred_processor for the people in the PD Data CSV, so
// Payment Dispatch routes each of them on their employee_hourly_rates
// "Bank Preferred" (the CSV send-FROM rail) instead of a stale employee-picked
// processor that would otherwise WIN over it (see buildQueueFromRates in
// src/components/payroll-clerk/mock-queue.ts).
//
// SCOPE — this ONLY touches employee_ids.preferred_processor. It does NOT touch:
//   * employee_ids.account_number / swift_code (the employee's RECEIVING account)
//   * employee_hourly_rates."Bank Preferred" or any payout-detail field
//
// SAFE-BY-DESIGN: writes a JSON backup of every value it will clear BEFORE
// clearing, so this is fully reversible (see --restore). Dry-run unless --apply.
//   node scripts/clear-preferred-processor-for-pd-csv.mjs            # report only
//   node scripts/clear-preferred-processor-for-pd-csv.mjs --apply    # backup + clear
//   node scripts/clear-preferred-processor-for-pd-csv.mjs --restore <backup.json>
//
// Optional: --csv "path"  (defaults to references/docs/PD Data.csv)

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const APPLY = process.argv.includes('--apply');
const restoreIdx = process.argv.indexOf('--restore');
const RESTORE = restoreIdx !== -1 ? process.argv[restoreIdx + 1] : null;
const csvArgIdx = process.argv.indexOf('--csv');
const CSV_PATH = csvArgIdx !== -1 ? process.argv[csvArgIdx + 1] : 'references/docs/PD Data.csv';
const IDS_TABLE = 'employee_ids';
const BACKUP_PATH = `references/docs/preferred_processor_backup_${new Date().toISOString().slice(0, 10)}.json`;

async function readAllIds() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(IDS_TABLE)
      .select('id, work_email, preferred_processor')
      .range(from, from + 999);
    if (error) throw new Error(`${IDS_TABLE} read: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

// --- RESTORE mode: put back exactly what a backup file recorded.
if (RESTORE) {
  const backup = JSON.parse(fs.readFileSync(path.resolve(RESTORE), 'utf8'));
  console.log(`RESTORE from ${RESTORE}: ${backup.length} rows`);
  let ok = 0, err = 0;
  for (const b of backup) {
    const { error } = await supabase
      .from(IDS_TABLE)
      .update({ preferred_processor: b.preferred_processor })
      .eq('id', b.id);
    if (error) { err++; console.error(`  FAIL ${b.work_email}: ${error.message}`); } else ok++;
  }
  console.log(`Restored ${ok} rows (errors: ${err}).`);
  process.exit(0);
}

// --- Parse CSV -> set of work emails present in it (col0 = email, quoted names skipped).
function csvEmails(csvPath) {
  const raw = fs.readFileSync(path.resolve(csvPath), 'utf8');
  const lines = raw.split(/\r?\n/);
  const set = new Set();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let email;
    if (line.startsWith('"')) { const end = line.indexOf('"', 1); email = line.slice(1, end); }
    else email = line.split(',')[0];
    email = (email ?? '').trim().toLowerCase();
    if (email && email.includes('@')) set.add(email);
  }
  return set;
}

const targetEmails = csvEmails(CSV_PATH);
const idRows = await readAllIds();
const toClear = idRows.filter(
  (r) => r.preferred_processor != null && targetEmails.has((r.work_email ?? '').trim().toLowerCase()),
);

console.log(`Mode: ${APPLY ? 'APPLY (backup + clear)' : 'DRY-RUN (no writes)'}`);
console.log(`CSV: ${CSV_PATH}`);
console.log(`Unique CSV work emails: ${targetEmails.size}`);
console.log(`employee_ids rows: ${idRows.length}`);
console.log(`Rows to clear (in CSV AND have a preferred_processor): ${toClear.length}`);
const tally = {};
for (const r of toClear) tally[r.preferred_processor] = (tally[r.preferred_processor] ?? 0) + 1;
console.log(`  by current value: ${JSON.stringify(tally)}`);
console.log('');

if (!APPLY) {
  console.log('DRY-RUN complete. No rows written. Re-run with --apply to backup + clear.');
  process.exit(0);
}

// 1) BACKUP the exact rows we will clear (reversible via --restore).
fs.writeFileSync(
  path.resolve(BACKUP_PATH),
  JSON.stringify(toClear.map((r) => ({ id: r.id, work_email: r.work_email, preferred_processor: r.preferred_processor })), null, 0),
);
console.log(`Backup written: ${BACKUP_PATH} (${toClear.length} rows). Restore with --restore ${BACKUP_PATH}`);

// 2) Clear preferred_processor by id.
let ok = 0, err = 0;
for (const r of toClear) {
  const { error } = await supabase.from(IDS_TABLE).update({ preferred_processor: null }).eq('id', r.id);
  if (error) { err++; console.error(`  FAIL ${r.work_email}: ${error.message}`); } else ok++;
}
console.log(`Cleared ${ok} of ${toClear.length} (errors: ${err}).`);
console.log('APPLY complete. Receiving accounts (account_number/swift) untouched.');
