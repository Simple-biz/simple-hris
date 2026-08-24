import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
for (const t of ['global_master_list', 'payment_catalog_pay_structures', 'hsl_team_members', 'employee_notifications', 'department_transfer_requests', 'offboarding_queue', 'paystub_dispatch_queue', 'audit_log']) {
  const { data, error } = await sb.from(t).select('*').limit(1);
  console.log('### ' + t + (error ? '  ERROR ' + error.code + ' ' + error.message : ''));
  if (data && data[0]) console.log('   ' + Object.keys(data[0]).join(', '));
  else if (!error) console.log('   (empty table)');
}
