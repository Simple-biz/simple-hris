/** READ-ONLY probe: master-list rows + dept labels for the six dept-fix people. */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const EMAILS = [
  'ralphl@simple.biz',
  'zigfredoa@simple.biz',
  'zent@simple.biz',
  'johnca@simple.biz',
  'laurenc@simple.biz',
  'lykac@simple.biz',
];

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !serviceKey) { console.error('missing env'); process.exit(1); }
const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const lower = (v: unknown) => String(v ?? '').trim().toLowerCase();

async function main() {
  const { data: uploadRow } = await supabase
    .from('master_list_uploads').select('id').eq('is_current', true).limit(1).maybeSingle();
  console.log('current upload:', (uploadRow as { id?: string } | null)?.id ?? '(none)');

  for (const email of EMAILS) {
    const { data, error } = await supabase
      .from('global_master_list')
      .select('id, "Name", "Department", "Work Email", "Personal Email", off_boarded_at, last_seen_upload_id')
      .ilike('Work Email', email.replace(/([%_\\])/g, '\\$1'));
    if (error) { console.log(`${email}: ERROR ${error.message}`); continue; }
    const rows = (data ?? []).filter((r: Record<string, unknown>) => lower(r['Work Email']) === email);
    console.log(`\n== ${email} (${rows.length} row(s))`);
    for (const r of rows as Record<string, unknown>[]) {
      const stale = r.last_seen_upload_id !== (uploadRow as { id?: string } | null)?.id;
      console.log(`   ${r.id} | dept="${r['Department']}" | name="${r['Name']}" | offboarded=${r.off_boarded_at ?? 'no'} | upload=${stale ? 'STALE' : 'current'}`);
    }
    if (rows.length === 0) console.log('   !! no master row with this Work Email');
  }

  // Distinct dept labels containing hsl/lead for exact target labels
  const { data: depts } = await supabase
    .from('global_master_list')
    .select('"Department"')
    .or('Department.ilike.%hsl%,Department.ilike.%lead%,Department.ilike.%hogan%');
  const uniq = [...new Set((depts ?? []).map((d: Record<string, unknown>) => String(d['Department'])))];
  console.log('\nDept labels matching hsl/lead/hogan:', uniq);
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
