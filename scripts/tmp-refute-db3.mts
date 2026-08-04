import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' }); dotenv.config();
const url=process.env.NEXT_PUBLIC_SUPABASE_URL!.trim();
console.log('url=',url);
const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth:{persistSession:false,autoRefreshToken:false} });
for(let attempt=1;attempt<=4;attempt++){
  try{
    const { data, error } = await sb.from('paystub_dispatch_queue').select('*').limit(1);
    if(error){ console.log('attempt',attempt,'ERR',error.message); }
    else { console.log('COLUMNS:'); console.log(Object.keys((data as any[])[0]??{}).join('\n  ')); break; }
  }catch(e:any){ console.log('attempt',attempt,'THROW',e?.message, e?.cause?.message); }
}
