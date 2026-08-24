/** READ-ONLY probe #2: registry membership, active_employees visibility, transfers, alt-email rows. */
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
  // 1. Payment-catalog department registry membership
  const { data: regRow } = await supabase
    .from('app_settings').select('value').eq('key', 'payment_catalog.departments.registry').maybeSingle();
  if (regRow) {
    const registry = JSON.parse((regRow as { value: string }).value) as Array<{ key: string; name: string; members?: Array<{ workEmail: string; isManager: boolean }> }>;
    console.log('== registry membership hits:');
    for (const dept of registry) {
      for (const m of dept.members ?? []) {
        if (EMAILS.includes(lower(m.workEmail))) {
          console.log(`   ${lower(m.workEmail)} -> registry dept "${dept.name}" (key=${dept.key}${m.isManager ? ', manager' : ''})`);
        }
      }
    }
  } else console.log('== no registry row');

  // 2. active_employees visibility
  console.log('\n== active_employees rows:');
  for (const email of EMAILS) {
    const { data, error } = await supabase
      .from('active_employees')
      .select('id, "Department", "Work Email"')
      .ilike('Work Email', email.replace(/([%_\\])/g, '\\$1'));
    if (error) { console.log(`   ${email}: ERROR ${error.message}`); continue; }
    const rows = (data ?? []).filter((r: Record<string, unknown>) => lower(r['Work Email']) === email);
    console.log(`   ${email}: ${rows.length === 0 ? 'NOT VISIBLE' : rows.map((r: Record<string, unknown>) => `"${r['Department']}"`).join(', ')}`);
  }

  // 3. department transfer records
  const { data: transfers, error: trErr } = await supabase
    .from('department_transfers')
    .select('*')
    .or(EMAILS.map((e) => `work_email.ilike.${e}`).join(','));
  if (trErr) console.log(`\n== department_transfers: ERROR ${trErr.message}`);
  else {
    console.log(`\n== department_transfers (${(transfers ?? []).length}):`);
    for (const t of (transfers ?? []) as Record<string, unknown>[]) console.log('  ', JSON.stringify(t));
  }

  // 4. Rows matched by Personal/Alternate email (identity dupes under other work emails)
  console.log('\n== rows matched via personal/alternate emails:');
  for (const email of EMAILS) {
    const esc = email.replace(/([%_\\])/g, '\\$1');
    const { data } = await supabase
      .from('global_master_list')
      .select('id, "Name", "Department", "Work Email", off_boarded_at')
      .or(`Personal Email.ilike.${esc},Alternate Work Email.ilike.${esc},Alternate Work Email 2.ilike.${esc}`.split(',').map(s => s).join(','));
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const r of rows) {
      if (lower(r['Work Email']) !== email) {
        console.log(`   ${email} also matches row ${r.id} workEmail="${r['Work Email']}" dept="${r['Department']}"`);
      }
    }
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
