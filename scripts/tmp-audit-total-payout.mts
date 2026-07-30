/**
 * READ-ONLY audit: does the Accounting Overview "Total Payout" hero match
 * everything that is actually paid for the cycle — salary, bonuses (PAB, Tech,
 * KPI/catalog, Notes Adjustment), MESA, orphanage, and urgent one-offs?
 *
 * Replicates the hero EXACTLY as src/components/Overview.tsx computes it
 * (raw hubstaff_hours "Total worked" × sheet-only employee_hourly_rates_current,
 * 40h regular/OT split, centavo rounding, duplicate-batch collapse), then
 * reconciles against:
 *   - paystub_dispatch_queue (the wizard's authoritative staged payloads)
 *   - the published hero snapshot  app_settings accounting.overview.snapshot.<file>
 *   - the wizard final_pay snapshot app_settings payroll.wizard.final_pay.<file>
 *   - payment_dispatches for the cycle (what was actually marked paid)
 *   - urgent_payment_requests + urgent_* payment_dispatches (never in the hero)
 *
 * Usage:  node --import tsx scripts/tmp-audit-total-payout.mts [source_file]
 * Omitted [source_file] = the is_current Hubstaff upload (what the hero shows).
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const { createClient } = await import('@supabase/supabase-js');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── plumbing ────────────────────────────────────────────────────────────────
const PAGE = 1000;
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw last;
}
async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await withRetry(async () => {
      const res = await build(from, from + PAGE - 1);
      if (res.error) throw new Error(res.error.message);
      return res;
    });
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const php = (n: number | null | undefined) =>
  n == null ? '—' : '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (n: number) => Math.round(n * 100) / 100;
const normEmail = (s: unknown): string | null => {
  const v = typeof s === 'string' ? s.trim().toLowerCase() : '';
  return v || null;
};

// ── exact replicas of the hero's math (src/lib/…) ──────────────────────────
function parseHoursToDecimal(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const s = String(value).trim();
  if (!s) return 0;
  const hms = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(s);
  if (hms) return parseInt(hms[1], 10) + parseInt(hms[2], 10) / 60 + parseInt(hms[3], 10) / 3600;
  const hm = /^(\d+):(\d{1,2})$/.exec(s);
  if (hm) return parseInt(hm[1], 10) + parseInt(hm[2], 10) / 60;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
function splitRegularOvertimeSeconds(totalHours: number): { regularSec: number; otSec: number } {
  const h = !Number.isFinite(totalHours) || totalHours <= 0 ? 0 : Math.round(totalHours * 100) / 100;
  if (h <= 0) return { regularSec: 0, otSec: 0 };
  const totalSec = Math.round(h * 3600);
  const regularSec = Math.min(totalSec, 40 * 3600);
  return { regularSec, otSec: Math.max(0, totalSec - regularSec) };
}
function phpHourlyPayFromSeconds(ratePhp: number, seconds: number): number {
  if (!Number.isFinite(ratePhp) || seconds <= 0) return 0;
  return Math.round((ratePhp * 100 * seconds) / 3600) / 100;
}
// Overview.tsx parseRate (strips thousands commas)
const parseRate = (v: string | null | undefined): number | null => {
  if (v == null) return null;
  const n = parseFloat(String(v).trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

// ── which cycle ─────────────────────────────────────────────────────────────
type UploadRow = { id: string; source_file: string; is_current: boolean | null; uploaded_at: string | null };
const uploads = await pageAll<UploadRow>((from, to) =>
  supabase.from('hubstaff_uploads').select('id, source_file, is_current, uploaded_at').order('uploaded_at', { ascending: false }).range(from, to),
);
const currentUpload = uploads.find((u) => u.is_current) ?? null;
const newestUpload = uploads[0] ?? null;
const cliFile = process.argv[2]?.trim() || null;
const heroFile = cliFile ?? currentUpload?.source_file ?? newestUpload?.source_file ?? null;
if (!heroFile) {
  console.error('No Hubstaff uploads found.');
  process.exit(1);
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('TOTAL PAYOUT AUDIT — Accounting Overview hero vs everything else');
console.log('══════════════════════════════════════════════════════════════════');
console.log(`is_current upload : ${currentUpload ? `${currentUpload.source_file} (uploaded ${currentUpload.uploaded_at})` : '(none)'}`);
console.log(`newest upload     : ${newestUpload ? `${newestUpload.source_file} (uploaded ${newestUpload.uploaded_at})` : '(none)'}`);
if (currentUpload && newestUpload && currentUpload.source_file !== newestUpload.source_file) {
  console.log('⚠ is_current ≠ newest: server-prefetch users see the is_current file, cold-client users default to the newest file.');
}
console.log(`auditing cycle    : ${heroFile}${cliFile ? ' (from argv)' : ''}`);

// ── rates index (exactly what the hero's bulk /api/employee-hourly-rates returns) ──
type RateRow = Record<string, unknown>;
let ratesRows: RateRow[] = [];
let ratesSource = 'employee_hourly_rates_current (view)';
try {
  ratesRows = await pageAll<RateRow>((from, to) =>
    supabase.from('employee_hourly_rates_current').select('*').order('id').range(from, to),
  );
} catch (e) {
  ratesSource = 'employee_hourly_rates (base table fallback — view unreadable: ' + (e as Error).message + ')';
  ratesRows = await pageAll<RateRow>((from, to) =>
    supabase.from('employee_hourly_rates').select('*').order('id').range(from, to),
  );
}
// index by normalized work + personal email, last row wins (indexHourlyRatesByEmail parity)
const ratesByEmail = new Map<string, RateRow>();
for (const r of ratesRows) {
  const w = normEmail(r['Work Email'] ?? (r as Record<string, unknown>)['work_email']);
  const p = normEmail(r['Personal Email'] ?? (r as Record<string, unknown>)['personal_email']);
  if (w) ratesByEmail.set(w, r);
  if (p) ratesByEmail.set(p, r);
}

// ── audit one cycle ─────────────────────────────────────────────────────────
async function auditCycle(sourceFile: string, opts: { heroIsLive: boolean }) {
  console.log('\n────────────────────────────────────────────────────────────────');
  console.log(`CYCLE: ${sourceFile}`);
  console.log('────────────────────────────────────────────────────────────────');

  // 1) hours rows, duplicate-batch collapsed like fetchHubstaffRowsBySourceFile
  type HoursRow = Record<string, unknown>;
  const hoursRaw = await pageAll<HoursRow>((from, to) =>
    supabase.from('hubstaff_hours').select('id, "Email", "Member", "Job type", "Total worked", upload_id').eq('source_file', sourceFile).order('id').range(from, to),
  );
  const byBatch = new Map<string, HoursRow[]>();
  for (const r of hoursRaw) {
    const b = String(r.upload_id ?? 'null');
    if (!byBatch.has(b)) byBatch.set(b, []);
    byBatch.get(b)!.push(r);
  }
  let hoursRows = hoursRaw;
  if (byBatch.size > 1) {
    const fileUploads = uploads.filter((u) => u.source_file === sourceFile);
    const preferred = fileUploads.find((u) => u.is_current) ?? fileUploads[0] ?? null;
    const chosen = preferred && byBatch.has(preferred.id)
      ? preferred.id
      : [...byBatch.entries()].sort((a, b) => b[1].length - a[1].length)[0][0];
    hoursRows = byBatch.get(chosen)!;
    console.log(`⚠ duplicate upload batches for this file: ${byBatch.size} batches (${[...byBatch.values()].map((v) => v.length).join('/')} rows) — collapsed to ${chosen} (${hoursRows.length} rows), hero does the same.`);
  }

  // 2) hero recompute
  let heroBase = 0;
  let payableRows = 0;
  const heroPerEmail = new Map<string, { name: string; hours: number; pay: number | null }>();
  const noRate: { email: string; name: string; hours: number }[] = [];
  for (const row of hoursRows) {
    const em = normEmail(row['Email']);
    const name = String(row['Member'] ?? '').trim();
    const hoursDecimal = parseHoursToDecimal(row['Total worked']);
    const { regularSec, otSec } = splitRegularOvertimeSeconds(hoursDecimal);
    const rateRow = em ? ratesByEmail.get(em) : undefined;
    const regularRate = parseRate(rateRow?.['Regular Rate'] as string | undefined ?? (rateRow as Record<string, unknown>)?.['regular_rate'] as string | undefined);
    const otRate = parseRate(rateRow?.['OT Rate'] as string | undefined ?? (rateRow as Record<string, unknown>)?.['ot_rate'] as string | undefined);
    const regularPay = regularRate != null ? phpHourlyPayFromSeconds(regularRate, regularSec) : null;
    const otPay = otSec > 0 ? (otRate != null ? phpHourlyPayFromSeconds(otRate, otSec) : null) : 0;
    const initialPay = regularPay != null && otPay != null ? round2(regularPay + otPay) : null;
    if (em) heroPerEmail.set(em, { name, hours: hoursDecimal, pay: initialPay });
    if (initialPay != null) {
      heroBase += initialPay;
      payableRows++;
    } else if (em) {
      noRate.push({ email: em, name, hours: hoursDecimal });
    }
  }
  heroBase = round2(heroBase);

  console.log(`\nHERO RECOMPUTE (what Overview.tsx sums before PAB):`);
  console.log(`  Hubstaff rows: ${hoursRows.length}   priced: ${payableRows}   NO-RATE (excluded from hero): ${noRate.length}`);
  console.log(`  Σ initialPay (hero base) = ${php(heroBase)}`);

  // 3) app_settings artifacts for this cycle
  const keys = [
    `accounting.overview.snapshot.${sourceFile}`,
    `payroll.wizard.final_pay.${sourceFile}`,
    `payroll.wizard.additions.${sourceFile}`,
    `payroll.dispatch_lock.${sourceFile}`,
    'usd_to_php_rate',
  ];
  const { data: settingsData, error: settingsErr } = await withRetry(async () => {
    const res = await supabase.from('app_settings').select('key, value, updated_at').in('key', keys);
    if (res.error) throw new Error(res.error.message);
    return res;
  });
  if (settingsErr) throw new Error(settingsErr.message);
  const settings = new Map((settingsData ?? []).map((r) => [r.key as string, r]));
  const parseJson = (k: string): Record<string, unknown> | null => {
    const raw = settings.get(k)?.value;
    if (typeof raw !== 'string' || !raw) return null;
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  };

  const snap = parseJson(`accounting.overview.snapshot.${sourceFile}`);
  const snapMeta = settings.get(`accounting.overview.snapshot.${sourceFile}`);
  console.log(`\nPUBLISHED HERO SNAPSHOT (accounting.overview.snapshot.*):`);
  if (snap) {
    const t = Number(snap['totalPayoutPhp']);
    console.log(`  totalPayoutPhp = ${php(Number.isFinite(t) ? t : null)}   (updated ${snapMeta?.updated_at})`);
    const delta = Number.isFinite(t) ? round2(t - heroBase) : null;
    console.log(`  minus recomputed hero base = ${php(delta)}  ← this is the PAB the hero currently includes (0 if PAB period still open) + any hours/rates drift since publish`);
  } else {
    console.log(`  (no snapshot published for this cycle — hero not opened on the live cycle yet, or key parse failed)`);
  }

  const lockRaw = settings.get(`payroll.dispatch_lock.${sourceFile}`)?.value;
  console.log(`  dispatch lock: ${lockRaw ? String(lockRaw).slice(0, 120) : '(absent — cycle not sent to Payment Dispatch)'}`);

  // 4) staged paystubs — the wizard's authoritative "everything" for the cycle
  type QueueRow = {
    recipient_email: string; recipient_name: string | null; department_key: string | null;
    amount_php: number | null; excluded: boolean | null; exclude_reason: string | null;
    sent_at: string | null; locked_at: string | null; payload: Record<string, unknown> | null;
  };
  const staged = await pageAll<QueueRow>((from, to) =>
    supabase.from('paystub_dispatch_queue')
      .select('recipient_email, recipient_name, department_key, amount_php, amount_usd, excluded, exclude_reason, sent_at, locked_at, payload')
      .eq('cycle_source_file', sourceFile).order('recipient_email').range(from, to),
  );
  const stagedActive = staged.filter((r) => !r.excluded);
  const stagedExcluded = staged.filter((r) => r.excluded);

  const comp = {
    regular: 0, ot: 0, initial: 0, bonuses_total: 0, perfect_attendance_bonus: 0, tech_bonus: 0,
    other_bonuses: 0, adjustment: 0, mesa_deduction: 0, mesa_disbursement: 0, orphanage_pay: 0, final: 0,
  };
  let payloadMissing = 0;
  for (const r of stagedActive) {
    const payPhp = (r.payload as Record<string, unknown> | null)?.['pay_php'] as Record<string, unknown> | undefined;
    if (!payPhp) { payloadMissing++; continue; }
    for (const k of Object.keys(comp) as (keyof typeof comp)[]) {
      const v = Number(payPhp[k]);
      if (Number.isFinite(v)) comp[k] = round2(comp[k] + v);
    }
  }
  const stagedTotal = round2(stagedActive.reduce((s, r) => s + (Number(r.amount_php) || 0), 0));
  const excludedTotal = round2(stagedExcluded.reduce((s, r) => s + (Number(r.amount_php) || 0), 0));

  console.log(`\nSTAGED PAYSTUBS (paystub_dispatch_queue — wizard truth incl. every bonus/deduction):`);
  if (staged.length === 0) {
    console.log('  (cycle not locked — no staged rows)');
  } else {
    console.log(`  people: ${stagedActive.length} payable + ${stagedExcluded.length} excluded (${php(excludedTotal)} withheld)${payloadMissing ? `; ${payloadMissing} rows missing pay_php payload` : ''}`);
    console.log(`  Σ amount_php (payable)          = ${php(stagedTotal)}`);
    console.log(`  Σ payload.pay_php breakdown:`);
    console.log(`    regular        ${php(comp.regular)}`);
    console.log(`    ot             ${php(comp.ot)}`);
    console.log(`    initial        ${php(comp.initial)}   ← salary (incl. proration/weekend/time-adjustments)`);
    console.log(`    PAB            ${php(comp.perfect_attendance_bonus)}`);
    console.log(`    tech           ${php(comp.tech_bonus)}`);
    console.log(`    other bonuses  ${php(comp.other_bonuses)}   ← KPI / catalog bonuses`);
    console.log(`    adjustment     ${php(comp.adjustment)}   ← Payroll Notes bridge (signed)`);
    console.log(`    bonuses_total  ${php(comp.bonuses_total)}   (= PAB + tech + other + adjustment)`);
    console.log(`    MESA deduction −${php(comp.mesa_deduction).slice(1)}`);
    console.log(`    MESA disburse  ${php(comp.mesa_disbursement)}`);
    console.log(`    orphanage      ${php(comp.orphanage_pay)}`);
    console.log(`    final          ${php(comp.final)}   (Σ amount_php should match: ${php(stagedTotal)})`);
  }

  // wizard final_pay snapshot total (dedup by entry object identity via work-email preference)
  const finalPaySnap = parseJson(`payroll.wizard.final_pay.${sourceFile}`);
  if (finalPaySnap && finalPaySnap['finals'] && typeof finalPaySnap['finals'] === 'object') {
    const finals = finalPaySnap['finals'] as Record<string, Record<string, unknown>>;
    // finals is keyed by BOTH work and personal email → dedup identical entry references by JSON identity
    const seen = new Set<string>();
    let sum = 0; let n = 0;
    for (const entry of Object.values(finals)) {
      const sig = JSON.stringify(entry);
      if (seen.has(sig)) continue;
      seen.add(sig);
      const f = Number(entry['final']);
      if (Number.isFinite(f)) { sum += f; n++; }
    }
    console.log(`  wizard final_pay snapshot: ${n} unique entries, Σ final = ${php(round2(sum))} (updated ${settings.get(`payroll.wizard.final_pay.${sourceFile}`)?.updated_at})`);
  }

  // 5) dispatches for the cycle (what was actually paid)
  type DispatchRow = { recipient_email: string; amount_php: number | null; amount_usd: number | null; status: string; payee_type: string | null; sent_date: string | null };
  const dispatches = await pageAll<DispatchRow>((from, to) =>
    supabase.from('payment_dispatches').select('recipient_email, amount_php, amount_usd, status, payee_type, sent_date')
      .eq('cycle_source_file', sourceFile).order('id').range(from, to),
  );
  const empDispatches = dispatches.filter((d) => (d.payee_type ?? 'employee') === 'employee');
  const byStatus = new Map<string, { n: number; php: number }>();
  for (const d of empDispatches) {
    const b = byStatus.get(d.status) ?? { n: 0, php: 0 };
    b.n++; b.php = round2(b.php + (Number(d.amount_php) || 0));
    byStatus.set(d.status, b);
  }
  console.log(`\nPAYMENT DISPATCHES for cycle (employee rows): ${empDispatches.length}`);
  for (const [st, b] of byStatus) console.log(`    ${st.padEnd(10)} ${String(b.n).padStart(4)}  ${php(b.php)}`);
  const contractorRows = dispatches.length - empDispatches.length;
  if (contractorRows > 0) console.log(`    (+${contractorRows} contractor rows excluded)`);

  // 6) per-person reconciliation: hero initial vs staged initial
  if (stagedActive.length > 0) {
    const diffs: { email: string; name: string; hero: number | null; staged: number; d: number }[] = [];
    let stagedNotInHero = 0; let stagedNotInHeroSum = 0;
    for (const r of stagedActive) {
      const em = normEmail(r.recipient_email)!;
      const payPhp = (r.payload as Record<string, unknown> | null)?.['pay_php'] as Record<string, unknown> | undefined;
      const stagedInitial = Number(payPhp?.['initial']);
      if (!Number.isFinite(stagedInitial)) continue;
      const hero = heroPerEmail.get(em);
      if (!hero) { stagedNotInHero++; stagedNotInHeroSum = round2(stagedNotInHeroSum + stagedInitial); continue; }
      const heroPay = hero.pay;
      const d = round2(stagedInitial - (heroPay ?? 0));
      if (Math.abs(d) >= 0.01) diffs.push({ email: em, name: r.recipient_name ?? hero.name, hero: heroPay, staged: stagedInitial, d });
    }
    const sumStagedInitial = comp.initial;
    console.log(`\nSALARY RECONCILIATION (hero Σ initialPay vs staged Σ pay_php.initial):`);
    console.log(`  hero base ${php(heroBase)}  vs  staged initial ${php(sumStagedInitial)}  →  Δ ${php(round2(sumStagedInitial - heroBase))}`);
    if (stagedNotInHero) console.log(`  staged people with no Hubstaff row under the same email: ${stagedNotInHero} (Σ initial ${php(stagedNotInHeroSum)}) — alias emails or roster-only additions`);
    console.log(`  people where hero salary ≠ wizard salary: ${diffs.length}`);
    diffs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    for (const x of diffs.slice(0, 15)) {
      console.log(`    ${(x.name || x.email).padEnd(30).slice(0, 30)} hero ${x.hero == null ? 'NO RATE (excluded!)' : php(x.hero)}  wizard ${php(x.staged)}  Δ ${php(x.d)}`);
    }
    if (diffs.length > 15) console.log(`    … +${diffs.length - 15} more`);
  }

  if (noRate.length > 0) {
    const stagedByEmail = new Map(stagedActive.map((r) => [normEmail(r.recipient_email)!, r]));
    console.log(`\nNO-RATE Hubstaff people (in the CSV, EXCLUDED from the hero sum entirely):`);
    let noRateStagedSum = 0;
    for (const p of noRate.sort((a, b) => b.hours - a.hours).slice(0, 20)) {
      const st = stagedByEmail.get(p.email);
      const amt = st ? Number(st.amount_php) || 0 : null;
      if (amt != null) noRateStagedSum = round2(noRateStagedSum + amt);
      console.log(`    ${(p.name || p.email).padEnd(30).slice(0, 30)} ${String(p.hours.toFixed(2)).padStart(7)}h  staged: ${amt == null ? '(not staged)' : php(amt)}`);
    }
    if (noRate.length > 20) console.log(`    … +${noRate.length - 20} more`);
    console.log(`  Σ staged pay of no-rate people = ${php(noRateStagedSum)} ← money invisible to the hero`);
  }

  return { heroBase, stagedTotal, comp, stagedCount: stagedActive.length, snapTotal: snap ? Number(snap['totalPayoutPhp']) : null };
}

const live = await auditCycle(heroFile, { heroIsLive: true });

// If the live cycle isn't locked yet, also audit the most recently locked cycle.
let lockedResult = live;
let lockedFile = heroFile;
if (live.stagedCount === 0) {
  const { data } = await withRetry(async () => {
    const res = await supabase.from('paystub_dispatch_queue').select('cycle_source_file, created_at').order('created_at', { ascending: false }).limit(1);
    if (res.error) throw new Error(res.error.message);
    return res;
  });
  const lastLocked = data?.[0]?.cycle_source_file as string | undefined;
  if (lastLocked && lastLocked !== heroFile) {
    console.log(`\n(live cycle has no staged rows — also auditing the last locked cycle for the full comparison)`);
    lockedResult = await auditCycle(lastLocked, { heroIsLive: false });
    lockedFile = lastLocked;
  }
}

// ── urgent payments (never part of the hero) ────────────────────────────────
type UrgentReq = { work_email: string; full_name: string | null; amount_php: number | null; status: string; requested_at: string | null; dispatched_at: string | null };
const urgentReqs = await pageAll<UrgentReq>((from, to) =>
  supabase.from('urgent_payment_requests').select('work_email, full_name, amount_php, status, requested_at, dispatched_at').order('id').range(from, to),
);
const reqByStatus = new Map<string, { n: number; php: number }>();
for (const r of urgentReqs) {
  const b = reqByStatus.get(r.status) ?? { n: 0, php: 0 };
  b.n++; b.php = round2(b.php + (Number(r.amount_php) || 0));
  reqByStatus.set(r.status, b);
}

type UrgentDisp = { cycle_source_file: string; recipient_email: string; recipient_name?: string | null; amount_php: number | null; status: string; sent_date: string | null };
const urgentDispRaw = await pageAll<UrgentDisp>((from, to) =>
  supabase.from('payment_dispatches').select('cycle_source_file, recipient_email, recipient_name, amount_php, status, sent_date')
    .like('cycle_source_file', 'urgent%').order('id').range(from, to),
);
const urgentDisp = urgentDispRaw.filter((d) => d.cycle_source_file.startsWith('urgent_'));
// current Sun–Sat UTC week bucket (urgent-cycle.ts parity)
const now = new Date();
const utcToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const sun = new Date(utcToday); sun.setUTCDate(sun.getUTCDate() - sun.getUTCDay());
const sat = new Date(sun); sat.setUTCDate(sat.getUTCDate() + 6);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const thisWeekBucket = `urgent_${iso(sun)}_to_${iso(sat)}`;

console.log('\n────────────────────────────────────────────────────────────────');
console.log('URGENT ONE-OFF PAYMENTS (by design NEVER included in the hero):');
console.log('────────────────────────────────────────────────────────────────');
for (const [st, b] of reqByStatus) console.log(`  requests ${st.padEnd(11)} ${String(b.n).padStart(3)}  ${php(b.php)}`);
const byBucket = new Map<string, { n: number; php: number; paid: number }>();
for (const d of urgentDisp) {
  const b = byBucket.get(d.cycle_source_file) ?? { n: 0, php: 0, paid: 0 };
  b.n++; b.php = round2(b.php + (Number(d.amount_php) || 0));
  if (d.status === 'paid') b.paid = round2(b.paid + (Number(d.amount_php) || 0));
  byBucket.set(d.cycle_source_file, b);
}
console.log(`  dispatched urgent rows (all time): ${urgentDisp.length}, Σ ${php(round2(urgentDisp.reduce((s, d) => s + (Number(d.amount_php) || 0), 0)))}`);
for (const [bucket, b] of [...byBucket.entries()].sort()) {
  console.log(`    ${bucket}${bucket === thisWeekBucket ? '  ← current week' : ''}: ${b.n} rows, Σ ${php(b.php)} (paid ${php(b.paid)})`);
}
const pendingUrgent = reqByStatus.get('pending');

// ── verdict ────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════════');
console.log('VERDICT');
console.log('══════════════════════════════════════════════════════════════════');
const c = lockedResult.comp;
console.log(`cycle ${lockedFile}`);
console.log(`  Hero (recomputed base)                    ${php(lockedResult.heroBase)}`);
if (lockedResult.snapTotal != null && Number.isFinite(lockedResult.snapTotal)) {
  console.log(`  Hero (as published/displayed)             ${php(lockedResult.snapTotal)}`);
}
console.log(`  Wizard "everything" total (staged final)  ${php(lockedResult.stagedTotal)}`);
console.log(`  Gap components the hero does NOT include:`);
console.log(`    salary engine diff (proration/OT/adj)   ${php(round2(c.initial - lockedResult.heroBase))}`);
console.log(`    PAB (in wizard only on final PAB week)  ${php(c.perfect_attendance_bonus)}`);
console.log(`    Tech bonus                              ${php(c.tech_bonus)}`);
console.log(`    KPI / catalog bonuses                   ${php(c.other_bonuses)}`);
console.log(`    Notes adjustments (signed)              ${php(c.adjustment)}`);
console.log(`    MESA deduction                          −${php(c.mesa_deduction).slice(1)}`);
console.log(`    MESA disbursements                      ${php(c.mesa_disbursement)}`);
console.log(`    orphanage pay                           ${php(c.orphanage_pay)}`);
if (pendingUrgent) console.log(`  Urgent pending (outside any cycle)        ${php(pendingUrgent.php)} (${pendingUrgent.n} requests)`);
const wk = byBucket.get(thisWeekBucket);
if (wk) console.log(`  Urgent dispatched this week               ${php(wk.php)}`);
console.log('\nDone (read-only — nothing was modified).');
process.exit(0);
