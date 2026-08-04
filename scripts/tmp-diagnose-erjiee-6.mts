/**
 * READ-ONLY: does erjiee have bonuses for the current week? If yes AND the sheet's
 * 16,617.75 excludes them, the sheet cell is provably a SUBTOTAL, not a full paycheck.
 */
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
const FILE = 'simple-biz_daily_report_2026-07-26_to_2026-08-01.csv';

async function readAllWhere(table: string, cols = '*'): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + PAGE - 1);
    if (error) { console.log(`  (${table}: ${error.message})`); return out; }
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

const hit = (r: Record<string, unknown>) =>
  Object.values(r).some((v) => /erjiee@simple\.biz/i.test(String(v ?? '')));

// ---- applied bonuses
const bonuses = (await readAllWhere('bonus_catalog_applied')).filter(hit);
console.log(`[A] bonus_catalog_applied rows for erjiee: ${bonuses.length}`);
for (const b of bonuses.slice(-12)) {
  const keys = Object.keys(b).filter((k) =>
    /amount|code|period|week|source|created|dept/i.test(k),
  );
  console.log('    ' + keys.map((k) => `${k}=${String(b[k])}`).join('  '));
}

// ---- the staged paystub payload for the current cycle
const queue = (await readAllWhere('paystub_dispatch_queue')).filter(hit);
console.log(`\n[B] paystub_dispatch_queue rows for erjiee: ${queue.length}`);
const current = queue.filter((q) => String(q.cycle_source_file ?? '') === FILE);
console.log(`    of which current cycle (${FILE}): ${current.length}`);

const show = current.length > 0 ? current : queue.slice(-2);
for (const q of show) {
  console.log(`\n    --- cycle=${String(q.cycle_source_file ?? '?')} status=${String(q.status ?? '?')}`);
  let payload: Record<string, unknown> = {};
  try {
    payload = typeof q.payload === 'string' ? JSON.parse(q.payload) : ((q.payload ?? {}) as Record<string, unknown>);
  } catch { /* leave empty */ }
  const pay = (payload.pay_php ?? {}) as Record<string, unknown>;
  const hours = (payload.hours ?? {}) as Record<string, unknown>;
  const rates = (payload.rates_php ?? {}) as Record<string, unknown>;
  const weekend = payload.weekend as Record<string, unknown> | null | undefined;
  console.log(`      hours    : ${JSON.stringify(hours)}`);
  console.log(`      rates_php: ${JSON.stringify(rates)}`);
  console.log(`      weekend  : ${JSON.stringify(weekend ?? null)}`);
  console.log(`      pay_php  :`);
  for (const [k, v] of Object.entries(pay)) console.log(`         ${k.padEnd(26)} = ${String(v)}`);
}

console.log(`
--- the question this answers ---
  sheet formula total                      = 16,617.75
  = regular + OT + weekend + AJ + (AK*AL), with AJ+(AK*AL) = -100.00

  If pay_php.bonuses_total above is > 0 and is NOT inside 16,617.75, then the sheet
  cell is a SUBTOTAL and "follow the sheet" must NOT drop our bonus terms.
  If bonuses_total is 0 for this week, the single data point cannot distinguish the two.
`);
console.log('Nothing was written.');
