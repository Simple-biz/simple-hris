/**
 * READ-ONLY verifier for src/lib/payroll/payout-extras.ts — runs the REAL
 * computePayoutExtras() against the live cycle and cross-checks it against the
 * independently-audited sums from scripts/tmp-audit-total-payout.mts.
 *
 * Usage (PowerShell):
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"; node --import tsx scripts/tmp-verify-payout-extras.mts [source_file]
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const { createClient } = await import('@supabase/supabase-js');
const { computePayoutExtras, urgentBucketForCycle } = await import('../src/lib/payroll/payout-extras');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error('Missing env');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

let sourceFile = process.argv[2]?.trim() || null;
if (!sourceFile) {
  const { data, error } = await supabase
    .from('hubstaff_uploads')
    .select('source_file')
    .eq('is_current', true)
    .limit(1);
  if (error) throw new Error(error.message);
  sourceFile = data?.[0]?.source_file ?? null;
}
if (!sourceFile) throw new Error('no cycle');

console.log('cycle:', sourceFile);
console.log('urgent bucket:', urgentBucketForCycle(sourceFile));

const t0 = Date.now();
const extras = await computePayoutExtras(sourceFile);
console.log(`computePayoutExtras took ${Date.now() - t0}ms`);
console.log(JSON.stringify(extras, null, 2));

const php = (n: number) => '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2 });
const c = extras.components;
console.log('\nHero would now show (salary base + extras):');
console.log('  extrasTotalPhp =', php(extras.extrasTotalPhp));
console.log('  sanity: tech + other + adj + mesaDisb + orphanage − mesaDed + urgent =',
  php(Math.round((c.techPhp + c.otherBonusesPhp + c.adjustmentPhp + c.mesaDisbursementPhp + c.orphanagePhp - c.mesaDeductionPhp + extras.urgentPaidPhp) * 100) / 100));

// Edge cases for urgentBucketForCycle
for (const [f, want] of [
  ['simple-biz_daily_report_2026-07-19_to_2026-07-25.csv', 'urgent_2026-07-26_to_2026-08-01'],
  ['simple-biz_daily_report_2026-07-12_to_2026-07-18.csv', 'urgent_2026-07-19_to_2026-07-25'],
  ['no_period_here.csv', null],
] as const) {
  const got = urgentBucketForCycle(f);
  console.log(got === want ? 'OK ' : 'FAIL', f, '→', got);
}
process.exit(0);
