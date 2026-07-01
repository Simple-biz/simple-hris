import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(url, key);

const EMAIL = 'kaner@simple.biz';
const PERSONAL = 'devkane2343@gmail.com';

async function main() {
  console.log('=== active_employees (by "Work Email") ===');
  const { data: ae, error: aeErr } = await supabase
    .from('active_employees')
    .select('*')
    .ilike('Work Email', EMAIL);
  if (aeErr) console.error(aeErr);
  console.log(JSON.stringify(ae, null, 2));

  console.log('=== global_master_list (by "Work Email") ===');
  const { data: gml, error: gmlErr } = await supabase
    .from('global_master_list')
    .select('*')
    .ilike('Work Email', EMAIL);
  if (gmlErr) console.error(gmlErr);
  console.log(JSON.stringify(gml, null, 2));

  console.log('=== employee_hourly_rates (by "Work Email") ===');
  const { data: ehr, error: ehrErr } = await supabase
    .from('employee_hourly_rates')
    .select('*')
    .ilike('Work Email', EMAIL);
  if (ehrErr) console.error(ehrErr);
  console.log(JSON.stringify(ehr, null, 2));

  console.log('=== ALL paystub_dispatch_queue rows for kaner (summary) ===');
  const { data: pdqAll, error: pdqAllErr } = await supabase
    .from('paystub_dispatch_queue')
    .select('cycle_source_file, recipient_email, department_key, amount_php, amount_usd, excluded, sent_at, locked_at')
    .or(`recipient_email.eq.${EMAIL},personal_email.eq.${PERSONAL}`)
    .order('locked_at', { ascending: false });
  if (pdqAllErr) console.error(pdqAllErr);
  console.log(JSON.stringify(pdqAll, null, 2));

  console.log('=== disbursement_records (recipient_email) ===');
  const { data: dr, error: drErr } = await supabase
    .from('disbursement_records')
    .select('*')
    .eq('recipient_email', EMAIL)
    .order('created_at', { ascending: false })
    .limit(15);
  if (drErr) console.error(drErr);
  console.log(JSON.stringify(dr, null, 2));

  console.log('=== mesa_requests (work_email) ===');
  const { data: mr, error: mrErr } = await supabase
    .from('mesa_requests')
    .select('*')
    .eq('work_email', EMAIL);
  if (mrErr) console.error(mrErr);
  console.log(JSON.stringify(mr, null, 2));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
