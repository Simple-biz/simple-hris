/**
 * READ-ONLY verifier for the two pagination fixes:
 *   - src/lib/supabase/bonus-catalog-applied-db.ts listApplied()
 *   - app/api/hsl-bonus/period-summary/route.ts query shape (replicated here
 *     with selectAllPaged to confirm full row counts now come back).
 *
 * Usage: node --import tsx scripts/tmp-verify-pagination-fixes.mts
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const { createClient } = await import('@supabase/supabase-js');
const { listApplied } = await import('../src/lib/supabase/bonus-catalog-applied-db');
const { selectAllPaged } = await import('../src/lib/supabase/select-all-paged');
const { HSL_DEPT_KEYS } = await import('../src/lib/hsl-bonus/schema');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) { console.error('Missing env'); process.exit(1); }
const supabase = createClient(url, key, { auth: { persistSession: false } });

console.log('=== bonus_catalog_applied: listApplied() for period_start=2026-07-12 ===');
{
  const { count } = await supabase
    .from('bonus_catalog_applied')
    .select('*', { count: 'exact', head: true })
    .eq('period_start', '2026-07-12');
  const rows = await listApplied({ periodStart: '2026-07-12' });
  console.log(`true count (count=exact): ${count}`);
  console.log(`listApplied() returned:   ${rows.length}`);
  console.log(rows.length === count ? 'OK — matches' : 'FAIL — mismatch');
}

console.log('\n=== hsl_bonus_entries: period-summary query shape for depts, period_start=2026-06-01 ===');
{
  const { count: trueCount } = await supabase
    .from('hsl_bonus_entries')
    .select('*', { count: 'exact', head: true })
    .in('department', HSL_DEPT_KEYS)
    .eq('period_start', '2026-06-01');

  type EntryRow = { department: string; period_start: string };
  const { rows, error } = await selectAllPaged<EntryRow>((from, to) =>
    supabase
      .from('hsl_bonus_entries')
      .select('department, period_start')
      .in('department', HSL_DEPT_KEYS)
      .order('period_start', { ascending: true })
      .order('department', { ascending: true })
      .range(from, to),
  );
  if (error) throw new Error(error);
  const matching = rows.filter((r) => r.period_start === '2026-06-01').length;
  console.log(`true count (count=exact) for 2026-06-01: ${trueCount}`);
  console.log(`selectAllPaged total rows fetched (all periods): ${rows.length}`);
  console.log(`matching 2026-06-01 after fetch-all + client filter: ${matching}`);
  console.log(matching === trueCount ? 'OK — matches' : 'FAIL — mismatch');
}
process.exit(0);
