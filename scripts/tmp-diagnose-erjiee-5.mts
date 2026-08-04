/** READ-ONLY: is erjiee a MESA member? (tests the -100 term in the sheet formula) */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const PAGE = 1000;
const rows: Record<string, unknown>[] = [];
for (let from = 0; ; from += PAGE) {
  const { data } = await sb.from('employee_hourly_rates').select('*').range(from, from + PAGE - 1);
  const page = (data ?? []) as Record<string, unknown>[];
  rows.push(...page);
  if (page.length < PAGE) break;
}
const mine = rows.filter((r) =>
  Object.values(r).some((v) => /erjiee@simple\.biz/i.test(String(v ?? ''))),
);
console.log(`employee_hourly_rates rows for erjiee: ${mine.length}`);
for (const r of mine) {
  const g = (n: string) => {
    for (const [k, v] of Object.entries(r)) if (k.toLowerCase().replace(/\s+/g, '_') === n) return v;
    return undefined;
  };
  console.log(
    `  mesa_member=${String(g('mesa_member'))}  since=${String(g('mesa_member_since'))}` +
      `  acct=${String(g('mesa_account_number'))}  bank_preferred=${String(g('bank_preferred'))}`,
  );
}

// ---- reconcile the sheet formula against the two rounding conventions
const H = { reg: 31.9, wknd: 8.1, ot: 4.5 };
const R = { reg: 355, wknd: 370, ot: 532.5 };
const sheet = H.reg * R.reg + H.ot * R.ot + H.wknd * R.wknd;
console.log('\n--- reconciling =((AB*AC)+(AD*AE))+(AF*AG)+AJ+(AK*AL) = 16,617.75 ---');
console.log(`  (AB*AC) regular  ${H.reg} x ${R.reg}    = ${(H.reg * R.reg).toFixed(2)}`);
console.log(`  (AD*AE) overtime ${H.ot} x ${R.ot}  = ${(H.ot * R.ot).toFixed(2)}`);
console.log(`  (AF*AG) weekend  ${H.wknd} x ${R.wknd}    = ${(H.wknd * R.wknd).toFixed(2)}`);
console.log(`                            earnings = ${sheet.toFixed(2)}`);
console.log(`  target                             = 16617.75`);
console.log(`  => AJ + (AK*AL)                    = ${(16617.75 - sheet).toFixed(2)}`);

// exact-seconds equivalent (what the app computes)
const secReg = 40 * 3600 - (8 * 3600 + 6 * 60 + 9);
const secWknd = 8 * 3600 + 6 * 60 + 9;
const secOt = 44 * 3600 + 29 * 60 + 52 - 40 * 3600;
const p = (rate: number, sec: number) => Math.round((rate * 100 * sec) / 3600) / 100;
const appEarn = p(R.reg, secReg) + p(R.wknd, secWknd) + p(R.ot, secOt);
console.log(`\n  app (whole-seconds) earnings        = ${appEarn.toFixed(2)}`);
console.log(`  sheet (2dp-hours) earnings         = ${sheet.toFixed(2)}   (delta ${(sheet - appEarn).toFixed(2)} = rounding)`);
console.log(`  app visible on stub (no weekend)   = ${(p(R.reg, secReg) + p(R.ot, secOt)).toFixed(2)}`);
console.log('\nNothing was written.');
