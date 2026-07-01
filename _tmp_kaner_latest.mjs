import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data, error } = await supabase
  .from('paystub_dispatch_queue')
  .select('*')
  .eq('recipient_email', 'kaner@simple.biz')
  .eq('cycle_source_file', 'simple-biz_daily_report_2026-06-21_to_2026-06-27.csv')
  .maybeSingle();
if (error) console.error(error);
console.log(JSON.stringify(data, null, 2));
