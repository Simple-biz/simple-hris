/**
 * READ-ONLY follow-up to scripts/audit-hsl-ot-ratio.mts.
 *
 * That audit found 11 HSL people whose stored OT rate is `regular + 15` rather
 * than `regular x 1.5` — i.e. someone put the HSL WEEKEND PREMIUM (+P15/h) into
 * the OT-RATE column. This script answers the only question that matters next:
 *
 *   Does the pay engine actually PAY that wrong rate, or does a correct Payment
 *   Catalog structure override it?
 *
 * It reproduces the precedence in `computeProratedRowPay`
 * (src/lib/payroll/current-pay.ts) for each named person:
 *
 *   catalog override  -- wins, UNLESS the dated history is catalog-consistent
 *                        as of the last worked day (historyMatchesCatalogAsOf),
 *                        in which case the week prorates through history
 *   rate history      -- resolveRateAsOfDate for the day
 *   sheet cache       -- employee_hourly_rates fallback
 *
 * STRICTLY READ-ONLY. No insert / update / delete / upsert.
 *
 *   npx tsx scripts/audit-hsl-ot-ratio-resolve.mts
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { defaultOtRate, isAutoOtRate } = await import('../src/lib/payment-catalog/pay-structure');
const { mapEmployeeHourlyRateRow } = await import('../src/lib/supabase/employee-hourly-rates');
const { resolveRateAsOfDate, buildRateHistoryByEmail } = await import(
  '../src/lib/payroll/rate-history-resolve'
);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const TARGETS = [
  'joy@hogansmith.com',
  'neliab@simple.biz',
  'marie@simple.biz',
  'karmina@simple.biz',
  'ruffamaeg@simple.biz',
  'verag@simple.biz',
  'aprill@simple.biz',
  'carlo@simple.biz',
  'vanp@simple.biz',
  'josephr@simple.biz',
  'jemt@simple.biz',
];

async function readAll(table: string, columns = '*'): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
function parseRate(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/,/g, '');
  if (s === '') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
const fmt = (n: number | null | undefined) =>
  n == null || Number.isNaN(n) ? '     —   ' : n.toFixed(2).padStart(9);

// ---- catalog (employee scope), keyed by email
const structures = await readAll('payment_catalog_pay_structures');
const catalogByEmail = new Map<string, Record<string, unknown>>();
for (const s of structures) {
  if (norm(s.scope) !== 'employee') continue;
  const e = norm(s.employee_email);
  if (e) catalogByEmail.set(e, s);
}

// ---- dated history, indexed exactly as the engine does
const historyRows = await readAll(
  'employee_rate_history',
  'employee_email, regular_rate, ot_rate, effective_from',
);
const historyByEmail = buildRateHistoryByEmail(historyRows);

// ---- sheet cache
const sheetByEmail = new Map<string, ReturnType<typeof mapEmployeeHourlyRateRow>>();
for (const raw of await readAll('employee_hourly_rates')) {
  const r = mapEmployeeHourlyRateRow(raw);
  for (const e of [norm(r.work_email), norm(r.personal_email)]) {
    if (!e) continue;
    // Later rows win, mirroring a last-write cache refresh.
    sheetByEmail.set(e, r);
  }
}

const today = new Date();
console.log('HSL OT-ratio RESOLUTION — READ-ONLY. Nothing is written.');
console.log(`Resolving each store as of ${today.toISOString().slice(0, 10)}.\n`);
console.log(
  'person'.padEnd(30) +
    'store'.padEnd(14) +
    '  reg'.padEnd(11) +
    '   ot'.padEnd(11) +
    'expected'.padEnd(11) +
    'verdict',
);
console.log('-'.repeat(104));

let liveUnderpaid = 0;
let shielded = 0;

for (const email of TARGETS) {
  const cat = catalogByEmail.get(email);
  const catReg = cat ? parseRate(cat.regular_rate) : null;
  const catOt = cat ? parseRate(cat.ot_rate) : null;

  const hist = resolveRateAsOfDate(historyByEmail.get(email), today);
  const histReg = hist?.regularRate ?? null;
  const histOt = hist?.otRate ?? null;

  const sheet = sheetByEmail.get(email);
  const sheetReg = sheet ? parseRate(sheet.regular_rate) : null;
  const sheetOt = sheet ? parseRate(sheet.ot_rate) : null;

  // Engine precedence: catalog override, else history, else sheet cache.
  let effReg: number | null;
  let effOt: number | null;
  let source: string;
  if (catReg != null) {
    effReg = catReg;
    effOt = catOt;
    source = 'catalog';
  } else if (histReg != null) {
    effReg = histReg;
    effOt = histOt;
    source = 'rate_history';
  } else {
    effReg = sheetReg;
    effOt = sheetOt;
    source = 'sheet_cache';
  }

  console.log(`\n${email}`);
  const rows: Array<[string, number | null, number | null]> = [
    ['catalog', catReg, catOt],
    ['rate_history', histReg, histOt],
    ['sheet_cache', sheetReg, sheetOt],
  ];
  for (const [label, reg, ot] of rows) {
    if (reg == null && ot == null) {
      console.log(`  ${label.padEnd(14)}${'(no record)'.padStart(9)}`);
      continue;
    }
    const exp = reg != null ? defaultOtRate(reg) : null;
    const ok = reg != null && ot != null && isAutoOtRate(reg, ot);
    const plus15 = reg != null && ot != null && Math.abs(ot - (reg + 15)) < 0.005;
    console.log(
      `  ${label.padEnd(14)}${fmt(reg)} ${fmt(ot)} ${fmt(exp)}   ` +
        (ok ? 'OK 1.5x' : plus15 ? '<-- reg+15 (weekend premium in OT column)' : 'off-ratio'),
    );
  }
  const effExp = effReg != null ? defaultOtRate(effReg) : null;
  const effOk = effReg != null && effOt != null && isAutoOtRate(effReg, effOt);
  if (effOk) {
    shielded++;
    console.log(`  => ENGINE USES ${source}: ot ${fmt(effOt)} — correct 1.5x, no underpayment.`);
  } else if (effReg != null && effOt != null && effExp != null) {
    liveUnderpaid++;
    const gap = Math.round((effExp - effOt) * 100) / 100;
    console.log(
      `  => ENGINE USES ${source}: ot ${fmt(effOt)} vs expected ${fmt(effExp)}` +
        `  ** UNDERPAID ${gap.toFixed(2)} PER OT HOUR **`,
    );
  } else {
    console.log(`  => ENGINE USES ${source}: incomplete rate — needs a human.`);
  }
}

console.log('\n' + '='.repeat(104));
console.log(
  `Live underpayment on overtime: ${liveUnderpaid} of ${TARGETS.length}.` +
    `  Shielded by a correct higher-precedence rate: ${shielded}.`,
);
console.log('Nothing was written to the database.');
console.log('='.repeat(104));
