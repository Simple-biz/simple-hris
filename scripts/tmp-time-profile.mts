// Times the DB work behind each request the Employee Profile fires on mount.
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const sb = createClient(url, key, { auth: { persistSession: false } });

const BASE = 'Department,Name,"Personal Email","Work Email","Start Date","Profile Photo URL"';
const FULL = BASE + ',id,street,city,province,postal_code,full_address,google_photo_url,employee_id,"Alternate Work Email","Alternate Work Email 2"';
const EXT = FULL + ',"Phone Number","Location"';

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  const ms = Math.round(performance.now() - t0);
  const size = JSON.stringify(r ?? null).length;
  console.log(`${label.padEnd(46)} ${String(ms).padStart(6)} ms   payload ${(size / 1024).toFixed(0)} KB`);
  return r;
}

const email = process.argv[2] ?? 'kaner@simple.biz';

// 1. What GET /api/employees?email= actually does: paged FULL roster scan, then JS filter.
await time('/api/employees?email=  (full roster scan)', async () => {
  const out: unknown[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from('active_employees').select(EXT).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
    from += 1000;
  }
  // + the US-prefixed UNION query the same helper always runs
  await sb.from('employee_ids').select('work_email, personal_email').like('employee_id', 'US-%');
  return out;
});

// 2. What it COULD do: one filtered row from the same view.
await time('  ^ same data, server-side filtered (1 row)', async () =>
  (await sb.from('active_employees').select(EXT)
    .or(`"Work Email".ilike.${email},"Personal Email".ilike.${email}`).limit(1)).data);

// 3. /api/employee-master-record?email= — the sequential 2nd hop.
await time('/api/employee-master-record?email=', async () =>
  (await sb.from('global_master_list').select(FULL + ',last_seen_upload_id')
    .ilike('"Work Email"', email).is('off_boarded_at', null)
    .order('last_seen_upload_id', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()).data);

// 4. /api/employee-ids?email=
await time('/api/employee-ids?email=', async () =>
  (await sb.from('employee_ids').select('*').ilike('work_email', email).limit(1).maybeSingle()).data);

// 5. listPayStructures() — inside /api/employee-hourly-rates?email=
await time('pay_structures (in hourly-rates route)', async () =>
  (await sb.from('pay_structures').select('*')).data);

// 6. /api/bank-preferred-requests?email= — the sequential 3rd hop.
await time('/api/bank-preferred-requests?email=', async () =>
  (await sb.from('bank_preferred_requests').select('*').ilike('employee_email', email)
    .order('created_at', { ascending: false }).limit(5)).data);

// 7. skill sets / commendations / resignation
await time('/api/employee-skill-sets?email=', async () =>
  (await sb.from('employee_skill_sets').select('*').ilike('work_email', email).limit(1).maybeSingle()).data);
await time('/api/resignation-requests?employee_email=', async () =>
  (await sb.from('resignation_requests').select('*').ilike('employee_email', email)).data);
await time('payment_catalog_pay_structures (rates route)', async () =>
  (await sb.from('payment_catalog_pay_structures').select('*')).data);
