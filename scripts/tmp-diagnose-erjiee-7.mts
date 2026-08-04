/** READ-ONLY: why did erjiee's SUNDAY pay at 225+15 while his weekdays paid at 355? */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const EMAIL = 'erjiee@simple.biz';

const { resolveRateAsOfDate, buildRateHistoryByEmail } = await import(
  '../src/lib/payroll/rate-history-resolve'
);

async function readAll(table: string, cols = '*'): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + PAGE - 1);
    if (error) { console.log(`(${table}: ${error.message})`); return out; }
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

// ---- his full rate history, newest first
const hist = (await readAll('employee_rate_history',
  'employee_email, regular_rate, ot_rate, effective_from, note, created_by'))
  .filter((r) => String(r.employee_email ?? '').toLowerCase() === EMAIL);
console.log(`[A] employee_rate_history rows for ${EMAIL}: ${hist.length}`);
for (const h of hist.sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)))) {
  console.log(
    `    eff=${String(h.effective_from).slice(0, 10)}  reg=${String(h.regular_rate).padStart(8)}` +
      `  ot=${String(h.ot_rate).padStart(8)}  by=${String(h.created_by ?? '-')}  note=${String(h.note ?? '-')}`,
  );
}

// ---- resolve per DAY across the pay week, exactly as the engine does
const byEmail = buildRateHistoryByEmail(hist as never);
const emp = byEmail.get(EMAIL);
console.log(`\n[B] per-day resolution across 2026-07-26 -> 2026-08-01 (what the engine sees):`);
const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
for (let d = 26; d <= 32; d++) {
  const date = new Date(2026, 6, d); // July is month 6; JS rolls 32 -> Aug 1
  const r = resolveRateAsOfDate(emp, date);
  const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  console.log(
    `    ${iso} (${dow[date.getDay()]})  reg=${String(r?.regularRate ?? 'null').padStart(8)}` +
      `  ot=${String(r?.otRate ?? 'null').padStart(8)}` +
      (date.getDay() === 0 || date.getDay() === 6 ? '   <-- WEEKEND (+15 premium)' : ''),
  );
}

// ---- catalog structures for him
const cat = (await readAll('payment_catalog_pay_structures',
  'scope, employee_email, department_key, regular_rate, ot_rate, currency'))
  .filter((r) => String(r.employee_email ?? '').toLowerCase() === EMAIL);
console.log(`\n[C] payment_catalog_pay_structures (employee scope) for him: ${cat.length}`);
for (const c of cat) console.log(`    reg=${String(c.regular_rate)} ot=${String(c.ot_rate)} ccy=${String(c.currency)}`);

console.log(`
[D] the money at stake for THIS ONE WEEK
    weekend hours                 8.1025
    paid at    (225 + 15) = 240 -> ${(8.1025 * 240).toFixed(2)}
    sheet says (355 + 15) = 370 -> ${(8.1025 * 370).toFixed(2)}
    UNDERPAID                    ${(8.1025 * (370 - 240)).toFixed(2)}
    our final 15,563.28  vs sheet 16,617.75  -> gap 1,054.47 (incl. 1.14 rounding)
`);
console.log('Nothing was written.');
