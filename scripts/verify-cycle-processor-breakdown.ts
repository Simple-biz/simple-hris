// READ-ONLY: run the REAL builder over the LIVE close-out records and assert the
// modal's numbers against the card's. No writes. No PII printed.
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import {
  parseCycleCloseout,
  aggregateUnpaidByProcessor,
  type CycleCloseoutRecord,
} from '@/lib/payroll/cycle-closeout';
import type { CycleCloseoutSummary } from '@/lib/payroll/cycle-closeout-store';
import { buildCyclePerformance } from '@/lib/admin/cycle-performance';

dotenv.config({ path: 'c:/Users/Kane/Desktop/simple-hris/.env' });
dotenv.config({ path: 'c:/Users/Kane/Desktop/simple-hris/.env.local' });

// Mirrors toCycleCloseoutSummary; that module is `server-only` and cannot be
// imported outside Next, so the 3-line projection is repeated here.
const toSummary = (rec: CycleCloseoutRecord): CycleCloseoutSummary => {
  const { payees, ...rest } = rec.unpaid;
  return { ...rec, unpaid: { ...rest, byProcessor: aggregateUnpaidByProcessor(payees) } };
};

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const rows: { key: string; value: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('app_settings').select('key, value')
      .like('key', 'dispatch.cycle_closeout.%')
      .order('key', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as { key: string; value: string }[]));
    if (!data || data.length < 1000) break;
  }

  const records = rows
    .map((r) => parseCycleCloseout(r.value))
    .filter((r): r is CycleCloseoutRecord => r !== null);
  const summaries = records.map(toSummary);

  const LABELS: Record<string, string> = {
    hurupay: 'Kolan', wires: 'x1153', wise: 'Wise', higlobe: 'HiGlobe', jeeves: 'Jeeves',
  };
  const perf = buildCyclePerformance(summaries, [], (id) => LABELS[id] ?? id);

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    console.log(`${ok ? '  OK  ' : ' FAIL '} ${msg}`);
    if (!ok) failures += 1;
  };

  for (const m of perf.months) {
    if (m.processors.length === 0) continue;
    console.log(`\n=== ${m.label} — the card reads ${(m.rate! * 100).toFixed(2)}% (${m.paid}/${m.payable})`);
    console.log('processor           paid PHP         paid USD  payments  pend  prob  thresh');
    for (const p of m.processors) {
      console.log(
        `${p.label.padEnd(10)} ${p.paidPHP.toFixed(2).padStart(18)} ${p.paidUSD.toFixed(2).padStart(16)} ` +
        `${String(p.paidPayments).padStart(9)} ${String(p.pending).padStart(5)} ${String(p.problem).padStart(5)} ${String(p.threshold).padStart(7)}`,
      );
    }
    const files = new Set(m.cycleBreakdowns.map((c) => c.sourceFile));
    const mine = records.filter((r) => files.has(r.source_file));
    const frozenUSD = mine.reduce((s, r) => s + r.paid.paidUSD, 0);
    const frozenPHP = mine.reduce((s, r) => s + r.paid.paidPHP, 0);
    const sumUSD = m.processors.reduce((s, p) => s + p.paidUSD, 0);
    const sumPHP = m.processors.reduce((s, p) => s + p.paidPHP, 0);
    const sumPay = m.processors.reduce((s, p) => s + p.paidPayments, 0);
    const sumUnpaid = m.processors.reduce((s, p) => s + p.unpaidPeople, 0);

    check(Math.abs(sumUSD - frozenUSD) < 0.005, `Sum processor USD ${sumUSD.toFixed(2)} === frozen paidUSD ${frozenUSD.toFixed(2)}`);
    check(Math.abs(sumPHP - frozenPHP) < 0.005, `Sum processor PHP ${sumPHP.toFixed(2)} === frozen paidPHP ${frozenPHP.toFixed(2)}`);
    check(sumPay === m.paidPayments, `Sum processor payments ${sumPay} === month paidPayments ${m.paidPayments}`);
    check(sumUnpaid === m.unpaid, `Sum processor unpaid people ${sumUnpaid} === month unpaid ${m.unpaid}`);
    check(m.paidPayments >= m.paid, `payments ${m.paidPayments} >= people ${m.paid} (gap ${m.paidPayments - m.paid})`);
    check(m.cycleBreakdowns.length === m.closedCycles, `${m.cycleBreakdowns.length} week rows === ${m.closedCycles} closed cycles`);
    check(!m.processors.some((p) => JSON.stringify(p).includes('@')), 'no email appears anywhere in a processor row');
  }

  const off = perf.months.filter((m) => m.processors.length === 0);
  console.log(`\nmonths with Open enabled: ${perf.months.length - off.length} · disabled: ${off.length}`);
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
