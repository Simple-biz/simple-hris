/**
 * READ-ONLY: how many people are underpaid because a rate change's effective_from
 * landed MID-PAY-WEEK instead of on the pay week's start (Sunday)?
 *
 * THE BUG (found via erjiee@simple.biz, week 2026-07-26 -> 08-01)
 * Pay weeks run Sunday -> Saturday. A raise entered effective on a MONDAY leaves the
 * preceding SUNDAY of the same pay week resolving to the OLD rate, because
 * `resolveRateAsOfDate` picks the newest row with effective_from <= that day. The
 * engine is behaving exactly as designed; the effective DATE is misaligned to the
 * pay-week boundary. The Google Sheet that Accounting pays from instead pays the
 * whole week at the new rate.
 *
 * Made worse by the catalog-consistency rule: when the dated history agrees with the
 * Payment Catalog as of the last worked day, the flat catalog override STANDS DOWN and
 * the week prorates through history — so the correct catalog rate does not rescue the
 * stranded day.
 *
 * NOTE the HSL +P15/h weekend premium CANCELS in this arithmetic: paid is
 * hours x (oldReg + 15) and owed is hours x (newReg + 15), so the gap is exactly
 * hours x (newReg - oldReg) whether or not the day is a weekend.
 *
 * Days stranded at the START of a pay week are within the first 40 hours, so they are
 * REGULAR hours and the regular-rate delta is the right multiplier.
 *
 * STRICTLY READ-ONLY. No insert / update / delete / upsert.
 *   npx tsx scripts/audit-midweek-effective-date-underpay.mts
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { resolveRateAsOfDate, buildRateHistoryByEmail } = await import(
  '../src/lib/payroll/rate-history-resolve'
);
const { resolveCanonicalColumnsToIso, parseDateRangeFromFilename } = await import(
  '../src/lib/hubstaff/calendar-column-dedupe'
);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) { console.error('Missing Supabase env'); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function readAll(table: string, cols = '*'): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const peso = (n: number) =>
  '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function parseHmsToSec(v: unknown): number {
  if (v == null) return 0;
  const s = String(v).trim();
  if (!s) return 0;
  const hms = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
  if (hms) return +hms[1] * 3600 + +hms[2] * 60 + +hms[3];
  const hm = /^(\d+):(\d{2})$/.exec(s);
  if (hm) return +hm[1] * 3600 + +hm[2] * 60;
  const d = parseFloat(s);
  return Number.isFinite(d) ? Math.round(d * 3600) : 0;
}
/** Sunday on/before d — every department's pay week starts Sunday. */
function weekStartSunday(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay());
  return x;
}

// ---------------------------------------------------------- hours, keyed by email+date
console.log('Reading hubstaff_hours (resolving canonical weekday columns)…');
const hoursByEmailDate = new Map<string, Map<string, number>>();
for (const r of await readAll('hubstaff_hours')) {
  const em = norm(r['Email'] ?? r['email']);
  if (!em) continue;
  const sf = String(r.source_file ?? '');
  const resolved = sf && parseDateRangeFromFilename(sf) ? resolveCanonicalColumnsToIso(r, sf) : r;
  let m = hoursByEmailDate.get(em);
  if (!m) { m = new Map(); hoursByEmailDate.set(em, m); }
  for (const [k, v] of Object.entries(resolved)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k.trim())) continue;
    const sec = parseHmsToSec(v);
    if (sec <= 0) continue;
    // last-wins, mirroring the DB collapse
    m.set(k.trim(), sec);
  }
}
console.log(`  people with per-day hours: ${hoursByEmailDate.size}`);

// ---------------------------------------------------------------------- dept (HSL?)
const deptByEmail = new Map<string, string>();
for (const r of await readAll('global_master_list')) {
  const dept = String(
    Object.entries(r).find(([k]) => k.toLowerCase() === 'department')?.[1] ?? '',
  );
  for (const kk of ['Work Email', 'Personal Email']) {
    const e = norm(Object.entries(r).find(([k]) => k.toLowerCase() === kk.toLowerCase())?.[1]);
    if (e) deptByEmail.set(e, dept);
  }
}

// ------------------------------------------------------------------- rate history
const histRows = await readAll(
  'employee_rate_history',
  'employee_email, regular_rate, ot_rate, effective_from, note, created_by',
);
const byEmail = buildRateHistoryByEmail(histRows as never);
console.log(`  rate_history rows: ${histRows.length}, people: ${byEmail.size}`);

// employee_rate_history contains EXACT DUPLICATE rows (same email+date+rates) — e.g. the
// duplicated 1970 baselines, and several 2026 rows written twice. Counting both would
// double-count the same stranded day, so collapse identical rows before pricing.
// NOTE overlapping DISTINCT changes are left alone on purpose: their deltas telescope
// (175->210 then 210->225 on the same stranded day sums to the correct 175->225 gap).
const seenRow = new Set<string>();
const uniqueRows = histRows.filter((r) => {
  const k = [
    norm(r.employee_email),
    String(r.effective_from ?? '').slice(0, 10),
    String(r.regular_rate ?? ''),
    String(r.ot_rate ?? ''),
  ].join('|');
  if (seenRow.has(k)) return false;
  seenRow.add(k);
  return true;
});
console.log(
  `  after collapsing exact duplicates: ${uniqueRows.length} rows ` +
    `(${histRows.length - uniqueRows.length} duplicate row(s) dropped)\n`,
);

type Finding = {
  email: string; dept: string; eff: string; dow: string;
  oldReg: number; newReg: number; delta: number;
  strandedDays: Array<{ date: string; hours: number }>;
  owed: number; author: string;
};
const findings: Finding[] = [];
let nonSundayChanges = 0;
let raisesChecked = 0;

for (const row of uniqueRows) {
  const eff = String(row.effective_from ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eff)) continue;
  if (eff.startsWith('1970')) continue;                    // baseline backfills, not changes
  if (eff < '2026-01-01') continue;                         // recent history only
  const [y, m, d] = eff.split('-').map(Number);
  const effDate = new Date(y, m - 1, d);
  if (effDate.getDay() === 0) continue;                     // already aligned to Sunday
  nonSundayChanges++;

  const email = norm(row.employee_email);
  const newReg = parseFloat(String(row.regular_rate ?? ''));
  if (!Number.isFinite(newReg)) continue;

  // the rate in force the day BEFORE the change
  const dayBefore = new Date(effDate.getFullYear(), effDate.getMonth(), effDate.getDate() - 1);
  const prev = resolveRateAsOfDate(byEmail.get(email), dayBefore);
  const oldReg = prev?.regularRate ?? null;
  if (oldReg == null) continue;                             // no prior rate => nothing stranded
  if (newReg <= oldReg + 0.005) continue;                   // not a raise
  raisesChecked++;

  // days in the SAME pay week that fall before the effective date
  const ws = weekStartSunday(effDate);
  const hoursMap = hoursByEmailDate.get(email);
  const stranded: Array<{ date: string; hours: number }> = [];
  for (let cur = new Date(ws); cur < effDate; cur.setDate(cur.getDate() + 1)) {
    const key = iso(cur);
    const sec = hoursMap?.get(key) ?? 0;
    if (sec > 0) stranded.push({ date: key, hours: sec / 3600 });
  }
  if (stranded.length === 0) continue;                      // stranded days, but no hours worked

  const totalH = stranded.reduce((s, x) => s + x.hours, 0);
  const delta = Math.round((newReg - oldReg) * 100) / 100;
  findings.push({
    email,
    dept: deptByEmail.get(email) ?? '(not on master)',
    eff,
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][effDate.getDay()],
    oldReg, newReg, delta,
    strandedDays: stranded,
    owed: Math.round(totalH * delta * 100) / 100,
    author: String(row.created_by ?? '-'),
  });
}

findings.sort((a, b) => b.owed - a.owed);
const total = findings.reduce((s, f) => s + f.owed, 0);

console.log('='.repeat(104));
console.log('MID-WEEK EFFECTIVE-DATE UNDERPAYMENT — READ-ONLY');
console.log('='.repeat(104));
console.log(`Rate changes in 2026 NOT effective on a Sunday : ${nonSundayChanges}`);
console.log(`  …of those that were RAISES with a prior rate : ${raisesChecked}`);
console.log(`  …that stranded days the person actually worked: ${findings.length}`);
console.log(`\nTOTAL UNDERPAID: ${peso(total)}\n`);

for (const f of findings) {
  const dayTxt = f.strandedDays.map((s) => `${s.date}=${s.hours.toFixed(2)}h`).join(' ');
  console.log(
    `${peso(f.owed).padStart(12)}  ${f.email.padEnd(28)} [${f.dept}]\n` +
      `              eff ${f.eff} (${f.dow})  ${f.oldReg} -> ${f.newReg}  (Δ${f.delta}/h)  by ${f.author}\n` +
      `              stranded: ${dayTxt}`,
  );
}

console.log('\n' + '='.repeat(104));
console.log('THE FIX (two parts, both needed):');
console.log('  1. DATA  — move each effective_from above back to its pay-week Sunday, so the');
console.log('             stranded day resolves to the new rate. Re-staging then re-prices it.');
console.log('  2. CODE  — snap effective_from to the pay-week start when a rate is written, so');
console.log('             this cannot recur. Entry points: /api/payment-catalog/pay-structures,');
console.log('             /api/update-employee-rates, insertRateHistoryRow (rate-history.ts).');
console.log('Already-PAID weeks are frozen by the paystub snapshot, so a history fix only');
console.log('re-prices NOT-YET-PAID cycles — reimburse paid weeks separately.');
console.log('='.repeat(104));
console.log('\nNothing was written to the database.');
