/**
 * Attestation tier verification (2026-07-27 threshold correction).
 *
 * 1) Verifies the Attestation tiers in src/lib/hsl-bonus/schema.ts reproduce the
 *    manager sheet formula
 *      =IF(Cases>=50,Cases*100,IF(Cases>=35,Cases*75,IF(Cases>=25,Cases*50,0)))
 *    for every case count 0..120 (band boundaries included).
 * 2) READ-ONLY DB scan: lists saved hsl_bonus_entries rows for dept 'attestation'
 *    whose stored calculated_bonus differs from what the current tiers produce —
 *    i.e. weeks saved under the old 30/40/50 thresholds (25–29 and 35–39 case
 *    bands) that would need a manager re-save or an explicit recalc decision.
 *    This script never writes.
 *
 * Run:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"; npx tsx scripts/verify-attestation-tiers.mts
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { HSL_DEPTS, calcBonus } = await import('../src/lib/hsl-bonus/schema');

// ── 1. boundary sweep against the sheet formula ───────────────────────────────
const sheet = (n: number) => (n >= 50 ? n * 100 : n >= 35 ? n * 75 : n >= 25 ? n * 50 : 0);
let bad = 0;
for (let n = 0; n <= 120; n++) {
  const app = calcBonus({ attested_cases: n }, HSL_DEPTS.attestation, false);
  if (app !== sheet(n)) {
    bad++;
    console.log(`MISMATCH n=${n}: app=${app} sheet=${sheet(n)}`);
  }
}
console.log(bad === 0 ? 'OK: attestation calcBonus == sheet formula for 0..120 cases' : `${bad} mismatches`);

const fil = HSL_DEPTS.filing_specialist.rules.find((r) => r.type === 'tiered');
if (fil && fil.type === 'tiered') {
  console.log('filing_specialist tiers (intentionally unchanged):', JSON.stringify(fil.tiers));
}

// ── 2. read-only DB scan of saved attestation entries ────────────────────────
const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.log('\nMissing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — skipped DB scan.');
  process.exit(0);
}
const db = createClient(url, key);
const { data, error } = await db
  .from('hsl_bonus_entries')
  .select('id, department, employee_email, employee_name, period_start, period_end, kpi_data, calculated_bonus, is_manager')
  .eq('department', 'attestation');
if (error) {
  console.error('DB error:', error.message);
  process.exit(1);
}
const rows = data ?? [];
console.log(`\nSaved attestation entries in DB: ${rows.length}`);
let stale = 0;
for (const r of rows) {
  const cases = Number((r.kpi_data as Record<string, unknown> | null)?.attested_cases ?? 0);
  const fresh = calcBonus(r.kpi_data ?? {}, HSL_DEPTS.attestation, r.is_manager);
  const stored = Number(r.calculated_bonus ?? 0);
  if (fresh !== stored) {
    stale++;
    console.log(
      `  STALE ${r.period_start}..${r.period_end} ${r.employee_name} <${r.employee_email}> cases=${cases} stored=P${stored} new-tiers=P${fresh}`,
    );
  }
}
console.log(stale === 0
  ? 'No saved entry changes under the new tiers (nobody stored in the 25–29 / 35–39 bands).'
  : `${stale} saved entr${stale === 1 ? 'y' : 'ies'} would change under the new tiers — needs re-save or recalc decision.`);
