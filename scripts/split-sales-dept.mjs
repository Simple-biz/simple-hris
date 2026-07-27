// Sales / Sales Assistant split (2026-07-27) — data-side companion to the code
// split (src/lib/departments/dept-email-overrides.ts + normalize-dept-key.ts).
//
// The sheet labels BOTH cohorts "Sales". Code-side, the PH 10 are re-read as
// "Sales Assistant" and the label "Sales" now maps to the NEW `sales` key.
// This script handles the live-data consequences:
//
//   1. department_managers — today a "Sales" grant scoped over all 20 people
//      (one dept). After the split it covers only the US cohort, so every
//      manager holding a "Sales" grant gets a SECOND "Sales Assistant" grant
//      (preserves exactly today's reach; prune later in Admin → Roles).
//   2. REPORT-ONLY probes for everything else the split could touch:
//      KPI history rows keyed 'sales_assistant' (whose emails are they?),
//      pending department transfers touching either label, the legacy
//      leave-managers JSON, PAB/Tech system-bonus allowlists, and Payment
//      Catalog pay structures.
//
// Dry-run by default; pass --apply to write. Backs up department_managers to
// references/backups/ before inserting.
//
//   node scripts/split-sales-dept.mjs           # probe + plan
//   node scripts/split-sales-dept.mjs --apply   # insert the dual grants

import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const APPLY = process.argv.includes('--apply');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(url, key);

const PH_SALES_ASSISTANT = new Set([
  'aleighshaa@simple.biz', 'mar@simple.biz', 'vine@simple.biz', 'markf@simple.biz',
  'deanm@simple.biz', 'debm@simple.biz', 'heartm@simple.biz', 'gladysp@simple.biz',
  'jcr@simple.biz', 'larat@simple.biz',
]);
const US_SALES = new Set([
  'dee@simple.biz', 'will@simple.biz', 'brad@simple.biz', 'shawn@simple.biz',
  'randy@simple.biz', 'chad@simple.biz', 'justin@simple.biz', 'locke@simple.biz',
]);
const norm = (v) => (v ?? '').trim().toLowerCase();

async function pageAll(table, select, filter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

// ── 1. department_managers: plan the dual grants ────────────────────────────
const grants = await pageAll('department_managers', '*');
const salesGrants = grants.filter((g) => norm(g.department) === 'sales');
const saGrants = grants.filter((g) => norm(g.department) === 'sales assistant');
const saHolders = new Set(saGrants.map((g) => norm(g.manager_email)));
const toInsert = salesGrants
  .filter((g) => !saHolders.has(norm(g.manager_email)))
  .map((g) => ({ manager_email: g.manager_email, department: 'Sales Assistant' }));

console.log('=== department_managers ===');
console.log(`"Sales" grants: ${salesGrants.length}`, salesGrants.map((g) => g.manager_email));
console.log(`"Sales Assistant" grants already present: ${saGrants.length}`);
console.log(`PLAN: insert ${toInsert.length} "Sales Assistant" grant(s):`, toInsert.map((g) => g.manager_email));

// ── 2. KPI history keyed 'sales_assistant' — whose rows are they? ───────────
console.log('\n=== KPI history under department=sales_assistant ===');
try {
  const applied = await pageAll('bonus_catalog_applied', 'employee_email, period_start, amount, department', (q) =>
    q.eq('department', 'sales_assistant'));
  const phRows = applied.filter((r) => PH_SALES_ASSISTANT.has(norm(r.employee_email)));
  const usRows = applied.filter((r) => US_SALES.has(norm(r.employee_email)));
  const otherRows = applied.length - phRows.length - usRows.length;
  console.log(`bonus_catalog_applied: ${applied.length} rows — PH ${phRows.length} · US ${usRows.length} · other ${otherRows}`);
  if (usRows.length > 0) {
    console.log('  !! US-cohort rows exist under sales_assistant (would need a re-key decision):');
    for (const r of usRows) console.log(`     ${r.employee_email}  ${r.period_start}  ₱${r.amount}`);
  } else {
    console.log('  OK: no US-cohort rows — history stays on sales_assistant, nothing to re-key.');
  }
} catch (e) {
  console.log('  (skipped:', e.message, ')');
}
for (const t of ['hsl_bonus_period_status', 'hsl_bonus_entries']) {
  try {
    const rows = await pageAll(t, '*', (q) => q.eq('department', 'sales_assistant'));
    console.log(`${t}: ${rows.length} rows keyed sales_assistant (dept-level; stays with the PH cohort)`);
  } catch (e) {
    console.log(`${t}: (skipped: ${e.message})`);
  }
}

// ── 3. Pending transfers touching either label ───────────────────────────────
console.log('\n=== department_transfer_requests (pending, sales-family) ===');
try {
  const pending = await pageAll('department_transfer_requests', '*', (q) => q.eq('status', 'pending'));
  const touching = pending.filter((r) =>
    ['from_department', 'to_department'].some((c) => norm(r[c]).includes('sales')));
  console.log(`${touching.length} of ${pending.length} pending transfers touch a sales label`);
  for (const r of touching) {
    console.log(`  #${r.id} ${r.employee_email ?? r.employee_name}: ${r.from_department} → ${r.to_department}`);
  }
} catch (e) {
  console.log('  (skipped:', e.message, ')');
}

// ── 4. Legacy leave-managers JSON ────────────────────────────────────────────
console.log('\n=== app_settings: leave_department_managers_json ===');
try {
  const { data } = await sb.from('app_settings').select('key, value').eq('key', 'leave_department_managers_json').maybeSingle();
  if (!data?.value) console.log('  absent — nothing to audit.');
  else {
    const map = JSON.parse(data.value);
    const salesish = Object.keys(map).filter((k) => norm(k).includes('sales'));
    console.log(salesish.length ? `  sales-family keys: ${JSON.stringify(salesish)} — check routing intent` : '  no sales-family keys.');
  }
} catch (e) {
  console.log('  (skipped:', e.message, ')');
}

// ── 5. PAB/Tech allowlists + pay structures (report-only) ────────────────────
console.log('\n=== payment_catalog_system_bonuses.department_keys ===');
try {
  const { data } = await sb.from('payment_catalog_system_bonuses').select('code, department_keys');
  for (const r of data ?? []) {
    const has = (r.department_keys ?? []).includes('sales');
    console.log(`  ${r.code}: 'sales' ${has ? 'PRESENT' : 'absent'} (${(r.department_keys ?? []).length} keys) — US team intentionally NOT PAB/Tech eligible; sales_assistant unaffected`);
  }
} catch (e) {
  console.log('  (skipped:', e.message, ')');
}
console.log('\n=== payment_catalog_pay_structures (department scope, sales-family) ===');
try {
  const { data } = await sb.from('payment_catalog_pay_structures').select('department_key, scope').eq('scope', 'department');
  const salesish = (data ?? []).filter((r) => norm(r.department_key).includes('sales'));
  console.log(salesish.length ? salesish : '  none — fine: neither cohort is paid from a dept-scope catalog rate today.');
} catch (e) {
  console.log('  (skipped:', e.message, ')');
}

// ── apply ────────────────────────────────────────────────────────────────────
if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to insert the dual grants.');
  process.exit(0);
}
if (toInsert.length === 0) {
  console.log('\nAPPLY: nothing to insert — every Sales manager already holds a Sales Assistant grant.');
  process.exit(0);
}

// Backup before writing.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join('references', 'backups');
mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `department_managers_${stamp}.json`);
writeFileSync(backupPath, JSON.stringify(grants, null, 2));
console.log(`\nBackup: ${backupPath} (${grants.length} rows)`);

const { error: insErr } = await sb.from('department_managers').insert(toInsert);
if (insErr) {
  console.error('INSERT failed:', insErr.message);
  process.exit(1);
}
console.log(`APPLIED: inserted ${toInsert.length} "Sales Assistant" grant(s). Prune in Admin → Roles & permissions when ownership is decided.`);
