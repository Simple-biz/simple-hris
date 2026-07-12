// Backfill MESA FPU dates for the 15 members whose LEDGER email is a short-form
// alias that didn't match a rate row directly. Each is a real, active employee
// (confirmed via global_master_list + a rate row on their owner email in the
// audit). We read the dates from the LEDGER row (keyed by the alias email) and
// stamp them onto the OWNER's rate rows.
//
// SAFE BY DEFAULT: dry-run unless you pass --apply.
//   node scripts/backfill-mesa-fpu-aliases.mjs           # dry-run
//   node scripts/backfill-mesa-fpu-aliases.mjs --apply    # write

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Missing SUPABASE env'); process.exit(1); }
const APPLY = process.argv.includes('--apply');
const RATES_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// ledger alias email  →  owner email that actually keys the rate rows
const ALIASES = {
  'jennb@simple.biz':      'jeanneb@simple.biz',
  'earl@simple.biz':       'earlc@simple.biz',
  'jay@simple.biz':        'genep@simple.biz',
  'carl@simple.biz':       'karln@simple.biz',
  'sebastian@simple.biz':  'iann@simple.biz',
  'jim@simple.biz':        'jimg@simple.biz',
  'eugene@simple.biz':     'eugeneg@simple.biz',
  'chloe@simple.biz':      'clangg@simple.biz',
  'amy@simple.biz':        'imeer@simple.biz',
  'luckyi@simple.biz':     'luckye@simple.biz',
  'ralfs@simple.biz':      'ralf@simple.biz',
  'dale@simple.biz':       'dales@simple.biz',
  'ivya@simple.biz':       'ivym@simple.biz',
  'brigel@simple.biz':     'brigitte@simple.biz',
  'shellye@simple.biz':    'shellys@simple.biz',
};

const toDate = (v) => { const s = String(v || '').trim(); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };
const earlier = (a, b) => (!a ? b : !b ? a : a < b ? a : b);

// Earliest FPU + opt-in confirmation from the ledger, for one alias email.
async function ledgerDates(aliasEmail) {
  const { data, error } = await supabase
    .from('mesa_ledger')
    .select('fpu_completion_date,optin_confirmation_sent')
    .ilike('email', aliasEmail);
  if (error) throw new Error(`ledger ${aliasEmail}: ${error.message}`);
  let fpu = null, optin = null;
  for (const r of data ?? []) {
    fpu = earlier(fpu, toDate(r.fpu_completion_date));
    optin = earlier(optin, toDate(r.optin_confirmation_sent));
  }
  return { fpu, optin };
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);
  let stamped = 0, rowsTouched = 0;
  const misses = [];

  for (const [alias, owner] of Object.entries(ALIASES)) {
    const { fpu, optin } = await ledgerDates(alias);
    const patch = { mesa_fpu_completed_on: fpu, mesa_optin_confirmation_sent: optin };

    const tryMatch = async (col) => {
      if (APPLY) {
        const { data, error } = await supabase.from(RATES_TABLE).update(patch).ilike(col, owner).select('id');
        if (error) throw new Error(`${owner} update(${col}): ${error.message}`);
        return data?.length ?? 0;
      }
      const { data, error } = await supabase.from(RATES_TABLE).select('id').ilike(col, owner);
      if (error) throw new Error(`${owner} read(${col}): ${error.message}`);
      return data?.length ?? 0;
    };

    let n = await tryMatch('Work Email');
    if (n === 0) n = await tryMatch('Personal Email');
    if (n > 0) { stamped += 1; rowsTouched += n; console.log(`  ${alias.padEnd(22)} → ${owner.padEnd(22)} fpu=${fpu} optin=${optin}  (${n} rows${APPLY ? ' updated' : ''})`); }
    else { misses.push({ alias, owner }); console.log(`  ${alias.padEnd(22)} → ${owner.padEnd(22)} ⚠️ NO RATE ROW`); }
  }

  console.log(`\nOwners ${APPLY ? 'stamped' : 'that would stamp'}: ${stamped}/${Object.keys(ALIASES).length}`);
  console.log(`Rate rows ${APPLY ? 'updated' : 'that would update'}: ${rowsTouched}`);
  if (misses.length) console.log(`Owner had no rate row: ${misses.map((m) => m.owner).join(', ')}`);
  console.log(APPLY ? '\nDone.' : '\nDry-run only. Re-run with --apply to write.');
}
main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
