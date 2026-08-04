/**
 * READ-ONLY verification for the HSL KPI Calculator's GML-merged roster.
 * See docs/superpowers/specs/2026-08-03-hsl-kpi-gml-roster-design.md.
 *
 * Confirms, against LIVE data:
 *   1. Every real hsl:<key>-tagged global_master_list row resolves via
 *      matchHslSubDeptKey (sanity: the namespaced form Department Transfers
 *      write is actually recognized).
 *   2. mergeHslRoster, given the real active roster + real hsl_team_members
 *      rows, produces no duplicate emails and never regresses an
 *      already-classified hsl_team_members dept_key to null.
 *   3. Whether dangieg@simple.biz resolves to a branch today (expected: no,
 *      until her Department is set to a specific branch — this script
 *      documents that; it does not fix her data).
 *
 * This script performs SELECT-only operations. Run:
 *   npx tsx scripts/verify-hsl-gml-roster.mts
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { matchHslSubDeptKey } = await import('../src/lib/hsl-bonus/schema');
const { mergeHslRoster } = await import('../src/lib/hsl-bonus/roster-merge');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

let failed = false;

/**
 * Paginated SELECT to work around PostgREST 1000-row cap.
 * Accumulates all rows across pages until a page comes back shorter than PAGE_SIZE.
 */
async function selectAllPaged<T>(table: string, select: string): Promise<T[]> {
  const PAGE_SIZE = 1000;
  const all: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`${table}: ${error.message}`);
    }
    const page = (data ?? []) as T[];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

console.log('=== 1. Real hsl:<key> Department tags resolve ===');
{
  const { data, error } = await supabase
    .from('global_master_list')
    .select('"Work Email", "Department"')
    .ilike('"Department"', 'hsl:%')
    .limit(20);
  if (error) {
    console.error('ERROR', error.message);
    failed = true;
  } else {
    for (const row of (data ?? []) as Record<string, string | null>[]) {
      const dept = row['Department'];
      const resolved = matchHslSubDeptKey(dept);
      console.log(`${row['Work Email']}: "${dept}" -> ${resolved ?? 'NULL (unexpected!)'}`);
      if (!resolved) failed = true;
    }
    if ((data ?? []).length === 0) console.log('(no hsl:<key>-tagged rows found today)');
  }
}

console.log('\n=== 2. mergeHslRoster sanity over live data (no dept filter) ===');
{
  try {
    const hslRows = await selectAllPaged<{
      email: string;
      full_name: string;
      hsl_name: string;
      role_raw: string;
      dept_key: string | null;
      sub_team: string;
      is_manager: boolean;
    }>('hsl_team_members', 'email, full_name, hsl_name, role_raw, dept_key, sub_team, is_manager');

    const gmlRows = await selectAllPaged<Record<string, string | null>>(
      'global_master_list',
      '"Name", "Department", "Work Email"',
    );

    const gmlPeople = gmlRows.map((r) => ({
      name: r['Name'] ?? '',
      department: r['Department'],
      work_email: r['Work Email'],
    }));
    const merged = mergeHslRoster((hslRows ?? []) as never, gmlPeople, null);
    const emails = merged.map((m) => m.email);
    const dupes = emails.filter((e, i) => emails.indexOf(e) !== i);
    console.log(`hsl_team_members rows: ${hslRows.length}`);
    console.log(`global_master_list rows scanned: ${gmlRows.length}`);
    console.log(`merged roster size: ${merged.length}`);
    console.log(dupes.length === 0 ? 'OK: no duplicate emails in merged roster' : `FAIL: ${dupes.length} duplicate emails`);
    if (dupes.length > 0) failed = true;

    const regressed = (hslRows as { email: string; dept_key: string | null }[]).filter((r) => {
      if (!r.dept_key) return false;
      const m = merged.find((x) => x.email === r.email.toLowerCase());
      return m && m.dept_key !== r.dept_key;
    });
    console.log(
      regressed.length === 0
        ? 'OK: no classified hsl_team_members dept_key was overwritten'
        : `FAIL: ${regressed.length} rows had their dept_key changed: ${JSON.stringify(regressed)}`,
    );
    if (regressed.length > 0) failed = true;
  } catch (err) {
    console.error('ERROR', (err as Error).message);
    failed = true;
  }
}

console.log('\n=== 3. dangieg@simple.biz today ===');
{
  const { data, error } = await supabase
    .from('global_master_list')
    .select('"Department"')
    .ilike('"Work Email"', 'dangieg@simple.biz');
  if (error) {
    console.error('ERROR', error.message);
  } else {
    const dept = (data?.[0] as Record<string, string | null> | undefined)?.['Department'] ?? null;
    const resolved = matchHslSubDeptKey(dept);
    console.log(
      `Department: "${dept}" -> matchHslSubDeptKey: ${resolved ?? 'null (expected until her Department is set to a specific branch)'}`,
    );
  }
}

if (failed) {
  console.error('\nFAILED — see above.');
  process.exit(1);
}
console.log('\nAll checks passed.');
