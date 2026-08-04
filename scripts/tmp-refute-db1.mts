/** READ-ONLY evidence gathering */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' }); dotenv.config();
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth:{persistSession:false,autoRefreshToken:false} });
const EMAIL='erjiee@simple.biz';
const { data, error } = await sb.from('paystub_dispatch_queue').select('*').eq('work_email',EMAIL).limit(10);
if(error) console.log('ERR',error.message);
const arr=(data??[]) as any[];
console.log('rows:',arr.length);
if(arr.length) console.log('COLUMNS:',Object.keys(arr[0]).join(', '));
for(const row of arr){
  console.log('\n=== row', row.id, 'cycle=',row.cycle_source_file, 'status=',row.status, 'period=',row.period_start,'->',row.period_end);
  const p=row.paystub_payload??row.payload;
  if(p) console.log(JSON.stringify(p).slice(0,3000));
}
