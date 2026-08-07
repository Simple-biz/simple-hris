/**
 * READ-ONLY verification: run the REAL shipped view builder (mapPayloadToPayStub)
 * over every staged HSL payload and report which Weekend Hours lines display a
 * rate the statement cannot explain.
 *
 * A weekend line is "explained" when either
 *   - every basis rate is (rates_php.regular + premium) or (rates_php.ot + premium)
 *     — the headline rate and the ordinary reg/OT bucket mix; or
 *   - `view.proration.weekend` is non-null, so the row chips and states the change.
 *
 * Before the 2026-08-07 fix this reported 8 unexplained rows. After it: 0.
 *
 * STRICTLY READ-ONLY.  npx tsx scripts/tmp-verify-weekend-disclosure.mts
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
const { mapPayloadToPayStub } = await import('../src/lib/payroll/paystub-view.ts');

dotenv.config({ path: '.env.local' });
dotenv.config();

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const r2 = (n: number) => Math.round(n * 100) / 100;
const PAGE = 150;

async function pagedAll(table: string, cols: string) {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    let rows: Record<string, unknown>[] | null = null;
    for (let attempt = 0; attempt < 4 && rows == null; attempt++) {
      const { data, error } = await sb.from(table).select(cols).order('id').range(from, from + PAGE - 1);
      if (error) {
        if (attempt === 3) throw new Error(`${table}@${from}: ${error.message}`);
        continue;
      }
      rows = (data ?? []) as unknown as Record<string, unknown>[];
    }
    out.push(...rows!);
    if (rows!.length < PAGE) break;
  }
  return out;
}

const rows = await pagedAll(
  'paystub_dispatch_queue',
  'cycle_source_file, recipient_email, recipient_name, payload',
);

let weekendRows = 0;
let chipped = 0;
const unexplained: string[] = [];
const nowChipped: string[] = [];

for (const row of rows) {
  const p = (row.payload ?? null) as Record<string, unknown> | null;
  if (!p || !p.weekend) continue;

  let view;
  try {
    view = mapPayloadToPayStub(p);
  } catch (e) {
    console.log(`RENDER THREW for ${row.recipient_email} / ${row.cycle_source_file}: ${String(e)}`);
    continue;
  }
  if (!view.hasWeekend) continue;
  weekendRows++;

  const rates = (p.rates_php ?? {}) as Record<string, unknown>;
  const premium = Number((p.weekend as Record<string, unknown>).premium_php_per_hour ?? 15);
  const expReg = Number.isFinite(Number(rates.regular)) ? r2(Number(rates.regular) + premium) : null;
  const expOt = Number.isFinite(Number(rates.ot)) ? r2(Number(rates.ot) + premium) : null;

  const offHeadline = view.weekendBasis.some(
    (b) =>
      (expReg == null || Math.abs(b.ratePhp - expReg) > 0.005) &&
      (expOt == null || Math.abs(b.ratePhp - expOt) > 0.005),
  );
  const label = `${row.recipient_name} <${row.recipient_email}> ${row.cycle_source_file}`;

  if (view.proration?.weekend) {
    chipped++;
    if (offHeadline) {
      nowChipped.push(
        `${label}\n      basis ${view.weekendBasis.map((b) => `${b.hours}h @ P${b.ratePhp}`).join(' · ')}` +
          `  ->  chip P${view.proration.weekend.previousRate} -> P${view.proration.weekend.currentRate}` +
          ` effective ${view.proration.effectiveHuman || '(undated)'}`,
      );
    }
  } else if (offHeadline) {
    unexplained.push(
      `${label}\n      basis ${view.weekendBasis.map((b) => `${b.hours}h @ P${b.ratePhp}`).join(' · ')}` +
        `  headline expects P${expReg} (reg) / P${expOt} (ot)`,
    );
  }
}

console.log(`\nHSL weekend rows rendered: ${weekendRows}`);
console.log(`  weekend line chipped:    ${chipped}`);
console.log(`  off-headline AND chipped (now disclosed): ${nowChipped.length}`);
for (const s of nowChipped) console.log('    ' + s);
console.log(`\n  UNEXPLAINED off-headline rates (must be 0): ${unexplained.length}`);
for (const s of unexplained) console.log('    ' + s);

console.log('\nDone (read-only).');
