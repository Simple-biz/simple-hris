/** READ-ONLY: dump EVERY column/value on erjiee's current-week hubstaff_hours row. */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const FILE = 'simple-biz_daily_report_2026-07-26_to_2026-08-01.csv';

const { data: rows } = await sb
  .from('hubstaff_hours')
  .select('*')
  .eq('source_file', FILE)
  .ilike('Email', 'erjiee@simple.biz');

console.log(`rows for erjiee in ${FILE}: ${rows?.length ?? 0}\n`);
for (const r of (rows ?? []) as Record<string, unknown>[]) {
  console.log('--- ALL COLUMNS (non-empty first) ---');
  const entries = Object.entries(r);
  const nonEmpty = entries.filter(([, v]) => v !== null && String(v ?? '').trim() !== '');
  const empty = entries.filter(([, v]) => v === null || String(v ?? '').trim() === '');
  for (const [k, v] of nonEmpty) console.log(`  ${JSON.stringify(k)} = ${JSON.stringify(v)}`);
  console.log(`\n  --- ${empty.length} empty/null column(s): ---`);
  console.log('  ' + empty.map(([k]) => JSON.stringify(k)).join(', '));
}

// For comparison: does ANYONE in this upload have per-day columns populated?
const { data: sample } = await sb.from('hubstaff_hours').select('*').eq('source_file', FILE).limit(400);
const dateRe = /^\d{4}-\d{2}-\d{2}$/;
let withDays = 0;
let withoutDays = 0;
const seenDateCols = new Set<string>();
for (const r of (sample ?? []) as Record<string, unknown>[]) {
  const cols = Object.keys(r).filter((k) => dateRe.test(k.trim()));
  for (const c of cols) seenDateCols.add(c.trim());
  const any = cols.some((c) => String(r[c] ?? '').trim() !== '' && String(r[c]) !== '0');
  if (any) withDays++;
  else withoutDays++;
}
console.log(`\n=== upload-wide (sample ${sample?.length ?? 0} rows of ${FILE}) ===`);
console.log(`  rows WITH populated per-day values:    ${withDays}`);
console.log(`  rows WITHOUT populated per-day values: ${withoutDays}`);
console.log(`  date-shaped columns present on table:  ${[...seenDateCols].sort().join(', ') || '(none)'}`);
console.log('\nNothing was written.');
