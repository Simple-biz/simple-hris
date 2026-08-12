/** STRICTLY READ-ONLY: confirm the two people the migration would actually hurt. */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

for (const email of ['sheenab@simple.biz', 'josec@simple.biz', 'laurenc@simple.biz']) {
  console.log(`\n===== ${email} =====`);
  const { data: emp } = await db
    .from('active_employees')
    .select('"Work Email", "Name", "Department"')
    .ilike('Work Email', email);
  console.log('roster:', JSON.stringify(emp));
  const { data: st } = await db
    .from('payment_catalog_pay_structures')
    .select('scope, department_key, regular_rate, ot_rate, currency, created_at')
    .ilike('employee_email', email);
  console.log('catalog structures:', JSON.stringify(st));
  const { data: hist } = await db
    .from('employee_rate_history')
    .select('regular_rate, effective_from')
    .ilike('employee_email', email)
    .order('effective_from', { ascending: false })
    .limit(3);
  console.log('rate history:', JSON.stringify(hist));
  const { data: hr } = await db
    .from('employee_hourly_rates')
    .select('"Work Email", "Department", "Regular Rate"')
    .ilike('Work Email', email);
  console.log('hourly rates:', JSON.stringify(hr));
}
console.log('\n(read-only)\n');
