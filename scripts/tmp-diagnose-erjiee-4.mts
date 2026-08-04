/** READ-ONLY: re-check the master list WITH PAGING (my earlier read hit the 1000-row cap). */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function readAll(table: string): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select('*').range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = (data ?? []) as Record<string, unknown>[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

for (const tbl of ['global_master_list', 'employee_hourly_rates', 'employee_ids']) {
  const rows = await readAll(tbl);
  const hits = rows.filter((r) =>
    Object.values(r).some((v) => /estolonio|erjie/i.test(String(v ?? ''))),
  );
  console.log(`\n${tbl}: ${rows.length} rows total (PAGED) — ${hits.length} matching /estolonio|erjie/`);
  for (const h of hits) {
    const g = (names: string[]) => {
      for (const [k, v] of Object.entries(h))
        if (names.some((n) => n.toLowerCase() === k.toLowerCase())) return v;
      return undefined;
    };
    console.log(
      `    Name="${String(g(['Name']) ?? '-')}"  Dept="${String(g(['Department', 'department']) ?? '-')}"` +
        `  Work="${String(g(['Work Email', 'work_email']) ?? '-')}"` +
        `  reg=${String(g(['Regular Rate', 'regular_rate']) ?? '-')}` +
        `  ot=${String(g(['OT Rate', 'ot_rate']) ?? '-')}` +
        `  off_board=${String(g(['off_board']) ?? '-')}`,
    );
  }
}

// What the stub SHOULD show for the current week, per the carve-out contract.
const REG = 355, PREMIUM = 15, OT_RATE = 532.5;
const wkndSec = 8 * 3600 + 6 * 60 + 9;          // sunday 8:06:09
const totalSec = 44 * 3600 + 29 * 60 + 52;      // "Total worked" 44:29:52
const capSec = 40 * 3600;
const otSec = totalSec - capSec;
const weekdayRegSec = capSec - wkndSec;
const r2 = (n: number) => Math.round(n * 100) / 100;
const pay = (rate: number, sec: number) => r2((rate * sec) / 3600);

console.log('\n--- what the paystub SHOULD render (carve-out = 3 lines) ---');
console.log(`  Regular Hours  ${r2(weekdayRegSec / 3600).toFixed(2)}h x ${REG.toFixed(2)}      = ${pay(REG, weekdayRegSec).toFixed(2)}`);
console.log(`  Weekend Hours  ${r2(wkndSec / 3600).toFixed(2)}h x ${(REG + PREMIUM).toFixed(2)}      = ${pay(REG + PREMIUM, wkndSec).toFixed(2)}   <-- MISSING FROM THE STUB`);
console.log(`  Overtime       ${r2(otSec / 3600).toFixed(2)}h x ${OT_RATE.toFixed(2)}      = ${pay(OT_RATE, otSec).toFixed(2)}`);
console.log(
  `  hours shown ${r2((weekdayRegSec + otSec) / 3600).toFixed(2)} of ${r2(totalSec / 3600).toFixed(2)}` +
    `  -> ${r2(wkndSec / 3600).toFixed(2)}h invisible`,
);
console.log(
  `  earnings shown ${(pay(REG, weekdayRegSec) + pay(OT_RATE, otSec)).toFixed(2)}` +
    `  vs full ${(pay(REG, weekdayRegSec) + pay(REG + PREMIUM, wkndSec) + pay(OT_RATE, otSec)).toFixed(2)}` +
    `  -> ${pay(REG + PREMIUM, wkndSec).toFixed(2)} unshown`,
);
console.log('\nNothing was written.');
