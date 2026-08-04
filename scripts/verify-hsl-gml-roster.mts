/**
 * READ-ONLY verification for the HSL KPI Calculator's GML-merged roster.
 * See docs/superpowers/specs/2026-08-03-hsl-kpi-gml-roster-design.md.
 *
 * Confirms, against LIVE data:
 *   1. Every real hsl:<key>-tagged global_master_list row resolves via
 *      matchHslSubDeptKey (sanity: the namespaced form Department Transfers
 *      write is actually recognized).
 *   2. mergeHslRoster, given the SAME active-roster reader the production
 *      route (`/api/hsl-bonus/team-members`) actually calls —
 *      listActiveMasterListPeople(), not a raw global_master_list query,
 *      which would skip its active-roster filter, dept-label overrides, and
 *      dedup logic — plus the real hsl_team_members rows, produces no
 *      duplicate emails and never regresses an already-classified
 *      hsl_team_members dept_key to null. Also prints a per-branch breakdown
 *      of GML-derived-only rows for every HSL_DEPT_KEYS branch: this is the
 *      check that would have caught the 2026-08-03 "Callback Team" collision
 *      finding (matchHslSubDeptKey resolving a branch whose plain display
 *      name is ALSO claimed by an unrelated, pre-existing top-level
 *      department) — the earlier version of this script only printed
 *      aggregate counts, which showed nothing wrong even with 14 real people
 *      misfiled onto that branch.
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

const { matchHslSubDeptKey, HSL_DEPT_KEYS } = await import('../src/lib/hsl-bonus/schema');
const { mergeHslRoster } = await import('../src/lib/hsl-bonus/roster-merge');
const { selectAllPaged } = await import('../src/lib/supabase/select-all-paged');
// NOTE: global-master-list-db.ts is imported lazily inside section 2 below,
// NOT hoisted up here with the others. It's a large module (1200+ lines,
// with its own transitive imports) — empirically, compiling it via tsx
// before section 1's very first network call made that call intermittently
// fail with "fetch failed" (reproduced 3/3 runs with the import hoisted vs.
// 0/4 without it, in this environment) even though the query itself is
// fine in isolation. Deferring the import until section 2 (after section
// 1's request has already completed) avoids the timing interaction.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

let failed = false;

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
    const { rows: hslRows, error: hslErr } = await selectAllPaged<{
      email: string;
      full_name: string;
      hsl_name: string;
      role_raw: string;
      dept_key: string | null;
      sub_team: string;
      is_manager: boolean;
    }>((from, to) =>
      supabase
        .from('hsl_team_members')
        .select('email, full_name, hsl_name, role_raw, dept_key, sub_team, is_manager')
        .order('email', { ascending: true })
        .range(from, to),
    );

    // Use the SAME active-roster reader the production route calls — NOT a
    // raw global_master_list query, which would skip listActiveMasterListPeople's
    // active-roster filter, dept-label overrides, and dedup logic. Reading
    // raw is exactly the gap that let the "Callback Team" collision (Finding
    // 1, 2026-08-03) go undetected by an earlier version of this script.
    const { listActiveMasterListPeople } = await import('../src/lib/supabase/global-master-list-db');
    const { people: gmlPeople, error: gmlErr } = await listActiveMasterListPeople();

    if (hslErr || gmlErr) {
      console.error('ERROR', hslErr ?? gmlErr);
      failed = true;
    } else {
      const merged = mergeHslRoster(hslRows as never, gmlPeople, null);
      const emails = merged.map((m) => m.email);
      const dupes = emails.filter((e, i) => emails.indexOf(e) !== i);
      console.log(`hsl_team_members rows: ${hslRows.length}`);
      console.log(`active global_master_list people scanned: ${gmlPeople.length}`);
      console.log(`merged roster size: ${merged.length}`);

      // NOTE: The two checks below are regression guards, not independent correctness proofs.
      // mergeHslRoster uses a Map<string, HslRosterRow> keyed by lowercased email, so:
      // (1) duplicate emails are impossible — a Map cannot hold two values under one key.
      // (2) dept_key regressions are impossible for rows with truthy dept_key — the merge
      //     uses `dept_key: r.dept_key ?? existing?.dept_key ?? null`, so `??` short-circuits
      //     to `r.dept_key` itself.
      // These checks confirm the current implementation's Map-based invariants hold (useful
      // as a regression guard if mergeHslRoster is ever refactored away from this approach).
      // The real correctness tests for the merge precedence rules live in
      // src/lib/hsl-bonus/roster-merge.test.ts (hand-constructed conflicting fixtures).
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

      // Per-branch breakdown: for each HSL branch, how many merged rows are
      // GML-derived-only (i.e. resolved via GML and NOT already present in
      // the raw hsl_team_members read, by email). A real collision like
      // Finding 1 ("Callback Team" colliding with the unrelated top-level
      // 'callback' department) would show up here as a nonzero count against
      // a branch hsl_team_members has zero rows for today — exactly the
      // signal the old aggregate-counts-only output never surfaced.
      console.log('\nPer-branch breakdown (GML-derived-only = resolved via GML, not present in the raw hsl_team_members read):');
      const hslEmailSet = new Set(
        (hslRows as { email: string }[]).map((r) => (r.email ?? '').trim().toLowerCase()),
      );
      for (const key of HSL_DEPT_KEYS) {
        const gmlDerivedOnlyCount = merged.filter(
          (row) => row.dept_key === key && !hslEmailSet.has(row.email),
        ).length;
        console.log(`  ${key}: ${gmlDerivedOnlyCount} GML-derived-only`);
      }
    }
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
