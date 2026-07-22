// Targeted one-off overrides of "Bank Preferred" (the SEND-FROM rail) for
// specific people the PD Data CSV got wrong. Backs up prior values first, then
// sets the new value on ALL of that person's employee_hourly_rates rows, and
// ensures employee_ids.preferred_processor is NULL so the override wins in PD.
//
// Does NOT touch receiving accounts (employee_ids.account_number / swift_code).
//
//   node scripts/override-bank-preferred.mjs            # dry-run, shows current vs target
//   node scripts/override-bank-preferred.mjs --apply    # backup + write
//
// Edit OVERRIDES below. Value must be a real bank label PD understands:
//   Hurupay | HiGlobe | Wise | Jeeves | x1161 | x1153 (wire codes verbatim)

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: '.env.local' });
dotenv.config();

const OVERRIDES = [
  { email: 'kaner@simple.biz', bank: 'Wise' },
];

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Missing Supabase env'); process.exit(1); }
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const APPLY = process.argv.includes('--apply');
const RATES = process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';
const IDS = 'employee_ids';
const BACKUP = `references/docs/bank_preferred_override_backup_${new Date().toISOString().slice(0, 10)}.json`;

// mirror of processorIdFromBankPreferred — validate the target is routable
const proc = (v) => {
  const t = String(v).trim().toLowerCase().replace(/\s+/g, '');
  if (['hurupay','huru','huropay'].includes(t)) return 'hurupay';
  if (t === 'wepay') return 'wepay';
  if (['higlobe','higloble','higlobel'].includes(t)) return 'higlobe';
  if (['wise','transferwise'].includes(t)) return 'wise';
  if (t === 'jeeves') return 'jeeves';
  if (/^x?\d{3,5}$/.test(t) || t.startsWith('wire')) return 'wires';
  return null;
};

const backup = [];
for (const o of OVERRIDES) {
  if (!proc(o.bank)) { console.error(`SKIP ${o.email}: "${o.bank}" is not a routable bank label`); continue; }
  const { data: rows } = await supabase
    .from(RATES).select('id,"Work Email","Bank Preferred"').ilike('Work Email', o.email);
  const { data: idRow } = await supabase
    .from(IDS).select('id,work_email,preferred_processor').ilike('work_email', o.email).limit(1);
  const cur = [...new Set((rows || []).map((r) => r['Bank Preferred']))];
  console.log(`${o.email}: current=${JSON.stringify(cur)} (${(rows||[]).length} rows) -> target="${o.bank}"; preferred_processor=${JSON.stringify(idRow?.[0]?.preferred_processor ?? null)}`);
  backup.push({ email: o.email, target: o.bank, before_bank_preferred: cur, before_preferred_processor: idRow?.[0]?.preferred_processor ?? null, id_row_id: idRow?.[0]?.id ?? null });
}

if (!APPLY) { console.log('\nDRY-RUN. Re-run with --apply to backup + write.'); process.exit(0); }

fs.writeFileSync(path.resolve(BACKUP), JSON.stringify(backup, null, 0));
console.log(`\nBackup written: ${BACKUP}`);

for (const o of OVERRIDES) {
  if (!proc(o.bank)) continue;
  const { error: e1, count } = await supabase
    .from(RATES).update({ 'Bank Preferred': o.bank }, { count: 'exact' }).ilike('Work Email', o.email);
  if (e1) console.error(`  bank FAIL ${o.email}: ${e1.message}`);
  else console.log(`  ${o.email}: Bank Preferred -> "${o.bank}" on ${count} rows`);
  // ensure preferred_processor is null so this override wins
  const { error: e2 } = await supabase
    .from(IDS).update({ preferred_processor: null }).ilike('work_email', o.email);
  if (e2) console.error(`  clear FAIL ${o.email}: ${e2.message}`);
}
console.log('APPLY complete. Receiving accounts untouched.');
