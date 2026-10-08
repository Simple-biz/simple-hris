/**
 * READ-ONLY: how many intern hours the caps removed, per week (Open item 396).
 *
 *   node --import tsx scripts/measure-intern-capped-hours.mts
 *
 * The 2026-10-07 call (Carla, Alivia, Kane) said Hubstaff shows interns at 5.x and
 * 6.x hours while the HRIS "literally maxes them out at 5 hours", then said both
 * "we owe people a little bit" and "we did overpay them". Nothing was computed.
 * This measures it, so Ralph and Kane rule on counted hours instead of the call.
 *
 * Three sections, TOTALS ONLY on stdout (no name, no email):
 *
 *   A. The settings the pricer reads: the share mode, the cap values on every
 *      profile, and the audit trail of every intern lock-in / withdraw / config
 *      change (was a week EVER locked? was the share mode EVER set?).
 *   B. Locked or accepted weeks (`orphanage_intern_pay`, one week = one
 *      source_file): interns, raw hours, paid hours, hours removed by the caps,
 *      gross, the two shares, and how many dispatch rows are marked paid.
 *      `rejected` weeks are listed and left out of the totals.
 *   C. Uploaded reports that were NEVER locked in, priced exactly as the mini
 *      wizard's preview prices them on screen: the stored report row →
 *      `internDaysFromRow` → `priceInternWeek` with the profile's own caps and
 *      dated rates → `splitInternGross`. The ONE pricer, called, not copied.
 *      PAB is ₱0 here: a payout-week verdict needs every week of the PAB period
 *      locked, and a week with no locked row is `weeks_missing` → ₱0
 *      (intern-pab.ts `internPabVerdict`), which is what the preview showed.
 *
 * Per-intern detail (names, emails, per-day hours) goes to a gitignored JSON under
 * docs/audits/backups/, never to stdout and never to the repo.
 *
 * "Hours removed by the caps" = Σ round2(raw per day) − paid hours: the figure the
 * mini wizard shows (InternsWizard.tsx `fromStored`) and the pricer reports as
 * `cappedOffHours` (intern-week-pay.ts). It is a count of hours, NOT an amount
 * owed. Whether hours over the cap are payable, and at what, is Ralph's ruling and
 * then Kane's (plan W0.8). Nothing here prices the capped hours.
 *
 * READ-ONLY BY CONSTRUCTION: plain `select` only, every table read paged
 * (PostgREST truncates at 1000 rows). `.env.local` holds PRODUCTION credentials.
 * No bank column is selected.
 */
import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const { selectAllPaged } = await import('../src/lib/supabase/select-all-paged');
const { normEmail } = await import('../src/lib/email/norm-email');
const { internDaysFromRow } = await import('../src/lib/interns/intern-hours-csv');
const { priceInternWeek, splitInternGross } = await import('../src/lib/interns/intern-week-pay');

const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('No service-role client. Check .env.local');
  process.exit(1);
}

// Same rounding as the pricer (intern-week-pay.ts): half-up on 2dp with the EPSILON nudge.
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const php = (n: number) => `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const h = (n: number) => n.toFixed(2);
const num = (v: unknown) => Number(v ?? 0);
const today = new Date().toISOString().slice(0, 10);
const detailPath = `docs/audits/backups/intern-capped-hours-${today}.json`;

interface DayEntry { raw: number; paid: number; rate_php: number | null }
interface PayRow {
  id: string;
  source_file: string;
  intern_id: string;
  intern_email: string;
  intern_name: string;
  week_start: string;
  week_end: string;
  hours_paid: number;
  hours_by_day: Record<string, DayEntry> | null;
  pay_php: number;
  pab_php: number;
  gross_php: number;
  orphanage_share_php: number;
  intern_share_php: number;
  share_mode: string;
  status: 'submitted' | 'accepted' | 'rejected';
}
interface ProfileRow {
  id: string;
  email: string;
  full_name: string;
  status: string;
  daily_cap_hours: number;
  weekly_cap_hours: number;
  orphanage_share_pct: number;
}
interface RateRow { intern_id: string; rate_php: number; effective_from: string }
interface DispatchRow { id: string; intern_pay_id: string; dispatch_type: string; status: string; amount_php: number }
interface UploadRow { source_file: string; week_start: string; week_end: string; row_count: number }
interface HoursRow { source_file: string; row_index: number; email: string; row: Record<string, unknown> }
interface AuditRow { id: string; created_at: string; action: string; details: Record<string, unknown> | null }

const fail = (what: string, error: string) => {
  console.error(`${what}: ${error}`);
  process.exit(1);
};

const [pay, profiles, rates, dispatches, uploads, hours, audit, config] = await Promise.all([
  selectAllPaged<PayRow>((from, to) =>
    sb.from('orphanage_intern_pay')
      .select('id, source_file, intern_id, intern_email, intern_name, week_start, week_end, hours_paid, hours_by_day, pay_php, pab_php, gross_php, orphanage_share_php, intern_share_php, share_mode, status')
      .order('week_start', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)),
  selectAllPaged<ProfileRow>((from, to) =>
    sb.from('orphanage_interns')
      .select('id, email, full_name, status, daily_cap_hours, weekly_cap_hours, orphanage_share_pct')
      .order('id', { ascending: true })
      .range(from, to)),
  selectAllPaged<RateRow>((from, to) =>
    sb.from('orphanage_intern_rates')
      .select('intern_id, rate_php, effective_from')
      .order('intern_id', { ascending: true })
      .order('effective_from', { ascending: true })
      .range(from, to)),
  selectAllPaged<DispatchRow>((from, to) =>
    sb.from('orphanage_dispatches')
      .select('id, intern_pay_id, dispatch_type, status, amount_php')
      .not('intern_pay_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to)),
  selectAllPaged<UploadRow>((from, to) =>
    sb.from('orphanage_intern_hours_uploads')
      .select('source_file, week_start, week_end, row_count')
      .order('week_start', { ascending: true })
      .order('source_file', { ascending: true })
      .range(from, to)),
  selectAllPaged<HoursRow>((from, to) =>
    sb.from('orphanage_intern_hours')
      .select('source_file, row_index, email, row')
      .order('source_file', { ascending: true })
      .order('row_index', { ascending: true })
      .range(from, to)),
  selectAllPaged<AuditRow>((from, to) =>
    sb.from('audit_log')
      .select('id, created_at, action, details')
      .like('action', 'orphanage_intern%')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)),
  sb.from('app_settings').select('value').eq('key', 'orphanage.interns.config').limit(1),
]);
if (pay.error) fail('orphanage_intern_pay', pay.error);
if (profiles.error) fail('orphanage_interns', profiles.error);
if (rates.error) fail('orphanage_intern_rates', rates.error);
if (dispatches.error) fail('orphanage_dispatches', dispatches.error);
if (uploads.error) fail('orphanage_intern_hours_uploads', uploads.error);
if (hours.error) fail('orphanage_intern_hours', hours.error);
if (audit.error) fail('audit_log', audit.error);
if (config.error) fail('app_settings', config.error.message);

const shareMode = (config.data?.[0]?.value as { shareMode?: string | null } | undefined)?.shareMode ?? null;

// ── A. Settings the pricer reads, and the audit trail ─────────────────────────
console.log(`\nIntern capped hours, measured ${today} (read-only, production)`);
console.log('\nA. Settings');
console.log(`  share mode (app_settings orphanage.interns.config): ${shareMode ?? 'NOT SET (Lock in is refused while unset)'}`);
console.log(`  profiles: ${profiles.rows.length} (${profiles.rows.filter((p) => p.status === 'active').length} active)`);
const capPairs = new Map<string, number>();
for (const p of profiles.rows) {
  const k = `${num(p.daily_cap_hours)}h/day · ${num(p.weekly_cap_hours)}h/week · ${num(p.orphanage_share_pct)}% to the orphanage`;
  capPairs.set(k, (capPairs.get(k) ?? 0) + 1);
}
for (const [k, n] of [...capPairs.entries()].sort()) console.log(`  caps on the profiles: ${k}: ${n}`);
const rateValues = new Map<number, number>();
for (const r of rates.rows) rateValues.set(num(r.rate_php), (rateValues.get(num(r.rate_php)) ?? 0) + 1);
console.log(`  rate rows: ${rates.rows.length} (${[...rateValues.entries()].sort(([a], [b]) => a - b).map(([v, n]) => `${php(v)}/h × ${n}`).join(', ') || 'none'})`);
const auditCounts = new Map<string, number>();
for (const a of audit.rows) auditCounts.set(a.action, (auditCounts.get(a.action) ?? 0) + 1);
console.log(`  audit trail (audit_log, action orphanage_intern*): ${audit.rows.length} rows`);
for (const [k, n] of [...auditCounts.entries()].sort()) console.log(`    ${k}: ${n}`);
for (const a of audit.rows.filter((x) => x.action === 'orphanage_interns.config_changed')) {
  console.log(`    config_changed ${a.created_at}: ${JSON.stringify(a.details ?? {})}`);
}

// ── B. Locked or accepted weeks ───────────────────────────────────────────────
const dispatchByPay = new Map<string, DispatchRow[]>();
for (const d of dispatches.rows) {
  const list = dispatchByPay.get(d.intern_pay_id) ?? [];
  list.push(d);
  dispatchByPay.set(d.intern_pay_id, list);
}
const stored = pay.rows.map((r) => {
  const days = Object.entries(r.hours_by_day ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const rawRounded = round2(days.reduce((s, [, d]) => s + round2(num(d.raw)), 0));
  const paid = num(r.hours_paid);
  return {
    r,
    days,
    rawRounded,
    paid,
    capped: round2(Math.max(0, rawRounded - paid)),
    disp: dispatchByPay.get(r.id) ?? [],
  };
});
type Stored = (typeof stored)[number];
const sumS = (rows: Stored[], f: (d: Stored) => number) => round2(rows.reduce((s, d) => s + f(d), 0));
const storedWeeks = groupBy(stored, (d) => d.r.source_file);

const header = ['week', 'status', 'interns', 'raw h', 'paid h', 'capped h', 'over cap', 'gross', 'to interns', 'to orphanage', 'dispatch paid'];
const bLines = storedWeeks.map(([, rows]) => {
  const disp = rows.flatMap((d) => d.disp);
  const paidDisp = disp.filter((x) => x.status === 'paid');
  return [
    `${rows[0].r.week_start}→${rows[0].r.week_end}`,
    [...new Set(rows.map((d) => d.r.status))].join('+'),
    String(rows.length),
    h(sumS(rows, (d) => d.rawRounded)),
    h(sumS(rows, (d) => d.paid)),
    h(sumS(rows, (d) => d.capped)),
    String(rows.filter((d) => d.capped > 0).length),
    php(sumS(rows, (d) => num(d.r.gross_php))),
    php(sumS(rows, (d) => num(d.r.intern_share_php))),
    php(sumS(rows, (d) => num(d.r.orphanage_share_php))),
    disp.length === 0 ? 'none' : `${paidDisp.length}/${disp.length} (${php(round2(paidDisp.reduce((s, x) => s + num(x.amount_php), 0)))})`,
  ];
});
console.log(`\nB. Locked or accepted weeks (orphanage_intern_pay): ${storedWeeks.length} week${storedWeeks.length === 1 ? '' : 's'}`);
printTable(header, bLines);
const counted = stored.filter((d) => d.r.status === 'submitted' || d.r.status === 'accepted');
const countedDisp = counted.flatMap((d) => d.disp);
const countedPaid = countedDisp.filter((x) => x.status === 'paid');
console.log(`  TOTAL, ${new Set(counted.map((d) => d.r.source_file)).size} locked or accepted weeks (rejected left out):`);
console.log(`    intern-weeks ${counted.length} (${new Set(counted.map((d) => d.r.intern_id)).size} interns) · raw ${h(sumS(counted, (d) => d.rawRounded))} h · paid ${h(sumS(counted, (d) => d.paid))} h · removed by caps ${h(sumS(counted, (d) => d.capped))} h (${counted.filter((d) => d.capped > 0).length} intern-weeks over)`);
console.log(`    pay ${php(sumS(counted, (d) => num(d.r.pay_php)))} · PAB ${php(sumS(counted, (d) => num(d.r.pab_php)))} · gross ${php(sumS(counted, (d) => num(d.r.gross_php)))} · to the interns ${php(sumS(counted, (d) => num(d.r.intern_share_php)))} · to the orphanage ${php(sumS(counted, (d) => num(d.r.orphanage_share_php)))}`);
console.log(`    dispatch rows paid ${countedPaid.length}/${countedDisp.length} (${php(round2(countedPaid.reduce((s, x) => s + num(x.amount_php), 0)))})`);

// ── C. Uploaded, never locked in — priced as the wizard's preview prices them ──
const lockedFiles = new Set(pay.rows.map((r) => r.source_file));
const profileByEmail = new Map(profiles.rows.map((p) => [normEmail(p.email) ?? p.email.toLowerCase(), p]));
const ratesByIntern = new Map<string, Array<{ ratePhp: number; effectiveFrom: string }>>();
for (const r of rates.rows) {
  const list = ratesByIntern.get(r.intern_id) ?? [];
  list.push({ ratePhp: num(r.rate_php), effectiveFrom: r.effective_from });
  ratesByIntern.set(r.intern_id, list);
}
const hoursByFile = new Map<string, HoursRow[]>();
for (const r of hours.rows) {
  const list = hoursByFile.get(r.source_file) ?? [];
  list.push(r);
  hoursByFile.set(r.source_file, list);
}

interface PreviewLine {
  email: string;
  name: string;
  outcome: 'priced' | 'no_profile' | 'ended' | 'no_day_columns' | string;
  rawRounded: number;
  paid: number;
  capped: number;
  payPhp: number;
  internPhp: number;
  orphanagePhp: number;
  ratesUsed: number[];
  hoursByDay: Record<string, unknown>;
}
const previews = uploads.rows
  .filter((u) => !lockedFiles.has(u.source_file))
  .map((u) => {
    const lines: PreviewLine[] = (hoursByFile.get(u.source_file) ?? []).map((row) => {
      const email = normEmail(row.email) ?? row.email.toLowerCase();
      const p = profileByEmail.get(email);
      const base = { email, name: p?.full_name ?? '', rawRounded: 0, paid: 0, capped: 0, payPhp: 0, internPhp: 0, orphanagePhp: 0, ratesUsed: [], hoursByDay: {} };
      if (!p) return { ...base, outcome: 'no_profile' };
      if (p.status === 'ended') return { ...base, outcome: 'ended' };
      const days = internDaysFromRow(row.row, u.source_file, u.week_start);
      if (!days) return { ...base, outcome: 'no_day_columns' };
      const priced = priceInternWeek({
        days,
        rates: ratesByIntern.get(p.id) ?? [],
        dailyCapHours: num(p.daily_cap_hours),
        weeklyCapHours: num(p.weekly_cap_hours),
      });
      if (!priced.ok) return { ...base, outcome: priced.code };
      // PAB ₱0: no week is locked, so a payout-week verdict is `weeks_missing` (see header).
      const split = splitInternGross(priced.payPhp, num(p.orphanage_share_pct));
      return {
        ...base,
        outcome: 'priced',
        rawRounded: round2(priced.hoursPaid + priced.cappedOffHours),
        paid: priced.hoursPaid,
        capped: priced.cappedOffHours,
        payPhp: priced.payPhp,
        internPhp: split.internPhp,
        orphanagePhp: split.orphanagePhp,
        ratesUsed: [...new Set(Object.values(priced.hoursByDay).filter((d) => d.paid > 0).map((d) => d.ratePhp ?? 0))],
        hoursByDay: priced.hoursByDay,
      };
    });
    return { upload: u, lines };
  });

const sumP = (rows: PreviewLine[], f: (d: PreviewLine) => number) => round2(rows.reduce((s, d) => s + f(d), 0));
const cHeader = ['week', 'rows', 'priced', 'raw h', 'paid h', 'capped h', 'over cap', 'pay = gross', 'to interns', 'to orphanage', 'not priced'];
const cLines = previews.map(({ upload, lines }) => {
  const priced = lines.filter((l) => l.outcome === 'priced');
  const refused = lines.filter((l) => l.outcome !== 'priced');
  const why = [...new Set(refused.map((l) => l.outcome))].map((o) => `${o} ${refused.filter((l) => l.outcome === o).length}`).join(', ');
  return [
    `${upload.week_start}→${upload.week_end}`,
    String(lines.length),
    String(priced.length),
    h(sumP(priced, (d) => d.rawRounded)),
    h(sumP(priced, (d) => d.paid)),
    h(sumP(priced, (d) => d.capped)),
    String(priced.filter((d) => d.capped > 0).length),
    php(sumP(priced, (d) => d.payPhp)),
    php(sumP(priced, (d) => d.internPhp)),
    php(sumP(priced, (d) => d.orphanagePhp)),
    why || '0',
  ];
});
console.log(`\nC. Uploaded but never locked in: ${previews.length} of ${uploads.rows.length} uploaded reports (priced as the wizard preview shows them; PAB ₱0)`);
printTable(cHeader, cLines);
const allPriced = previews.flatMap((p) => p.lines.filter((l) => l.outcome === 'priced'));
console.log(`  TOTAL, ${previews.length} never-locked weeks:`);
console.log(`    intern-weeks priced ${allPriced.length} (${new Set(allPriced.map((l) => l.email)).size} interns) · raw ${h(sumP(allPriced, (d) => d.rawRounded))} h · paid ${h(sumP(allPriced, (d) => d.paid))} h · removed by caps ${h(sumP(allPriced, (d) => d.capped))} h (${allPriced.filter((d) => d.capped > 0).length} intern-weeks over)`);
console.log(`    pay = gross ${php(sumP(allPriced, (d) => d.payPhp))} · to the interns ${php(sumP(allPriced, (d) => d.internPhp))} · to the orphanage ${php(sumP(allPriced, (d) => d.orphanagePhp))}`);
const usedRates = [...new Set(allPriced.flatMap((l) => l.ratesUsed))].sort((a, b) => a - b);
console.log(`    rates that priced these weeks: ${usedRates.map((r) => `${php(r)}/h`).join(', ') || 'none'}`);

// ── Per-intern detail → gitignored backup (names live here, never on stdout) ──
mkdirSync(dirname(detailPath), { recursive: true });
writeFileSync(detailPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  note: 'Open item 396. Read-only measurement. Capped hours are hours, not an amount owed.',
  shareMode,
  capPairs: Object.fromEntries(capPairs),
  audit: audit.rows,
  lockedWeeks: storedWeeks.map(([sourceFile, rows]) => ({
    sourceFile,
    weekStart: rows[0].r.week_start,
    weekEnd: rows[0].r.week_end,
    rows: rows.map((d) => ({
      intern_name: d.r.intern_name,
      intern_email: d.r.intern_email,
      status: d.r.status,
      hours_raw_rounded_by_day: d.rawRounded,
      hours_paid: d.paid,
      hours_capped: d.capped,
      hours_by_day: Object.fromEntries(d.days),
      pay_php: num(d.r.pay_php),
      pab_php: num(d.r.pab_php),
      gross_php: num(d.r.gross_php),
      intern_share_php: num(d.r.intern_share_php),
      orphanage_share_php: num(d.r.orphanage_share_php),
      share_mode: d.r.share_mode,
      dispatch: d.disp.map((x) => ({ type: x.dispatch_type, status: x.status, amount_php: num(x.amount_php) })),
    })),
  })),
  neverLockedWeeks: previews.map(({ upload, lines }) => ({ ...upload, lines })),
}, null, 2));
console.log(`\nPer-intern detail (gitignored): ${detailPath}\n`);

function groupBy<T>(rows: T[], key: (r: T) => string): Array<[string, T[]]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const list = m.get(key(r)) ?? [];
    list.push(r);
    m.set(key(r), list);
  }
  return [...m.entries()];
}

function printTable(head: string[], lines: string[][]) {
  if (lines.length === 0) {
    console.log('  (none)');
    return;
  }
  const widths = head.map((c, i) => Math.max(c.length, ...lines.map((l) => l[i].length)));
  const fmt = (cells: string[]) => '  ' + cells.map((c, i) => (i === 0 || (i === 1 && head[1] === 'status') ?c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  console.log(fmt(head));
  for (const l of lines) console.log(fmt(l));
}
