import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' }); dotenv.config();
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth:{persistSession:false,autoRefreshToken:false} });
const { data, error } = await sb.from('paystub_dispatch_queue').select('id,cycle_source_file,recipient_email,recipient_name,department_key,amount_php,pay_period,payload,created_at').eq('recipient_email','erjiee@simple.biz').order('created_at',{ascending:false}).limit(4);
if(error){ console.log('ERR',error.message); process.exit(0);}
for(const row of (data??[]) as any[]){
  console.log('\n============ cycle', row.cycle_source_file, '| period', row.pay_period, '| amount_php', row.amount_php, '|', row.created_at);
  console.log(JSON.stringify(row.payload, null, 1));
}
