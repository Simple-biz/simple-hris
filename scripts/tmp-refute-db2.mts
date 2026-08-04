/** READ-ONLY */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' }); dotenv.config();
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth:{persistSession:false,autoRefreshToken:false} });
const { data, error } = await sb.from('paystub_dispatch_queue').select('*').limit(1);
if(error) console.log('ERR',error.message); else console.log('COLUMNS:',Object.keys((data as any[])[0]??{}).join('\n  '));
