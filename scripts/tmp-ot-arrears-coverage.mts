/** READ-ONLY throwaway: how far does disbursement_records coverage actually reach? */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const T = [
  'neliab@simple.biz', 'marie@simple.biz', 'karmina@simple.biz', 'ruffamaeg@simple.biz',
  'verag@simple.biz', 'aprill@simple.biz', 'carlo@simple.biz', 'josephr@simple.biz',
];

const { data: newest } = await sb
  .from('disbursement_records')
  .select('cycle_period_end')
  .order('cycle_period_end', { ascending: false })
  .limit(1);
console.log('disbursement_records NEWEST cycle_period_end (all people):', newest?.[0]?.cycle_period_end);

const { data: mine } = await sb
  .from('disbursement_records')
  .select('recipient_email, cycle_period_end, ot_hours, status')
  .in('recipient_email', T)
  .order('cycle_period_end', { ascending: false })
  .limit(5);
console.log('newest rows for the 8:', JSON.stringify(mine, null, 1));

const { data: pd } = await sb
  .from('payment_dispatches')
  .select('recipient_email, cycle_source_file, status')
  .in('recipient_email', T);
console.log('\npayment_dispatches rows for the 8:', pd?.length ?? 0);
const files = [...new Set((pd ?? []).map((r) => String(r.cycle_source_file ?? '')))].sort();
console.log('distinct cycle_source_file (newest 10):');
for (const f of files.slice(-10)) console.log('   ', f);
