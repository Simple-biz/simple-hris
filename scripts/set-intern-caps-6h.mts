/**
 * Raise the orphanage interns' paid-hours caps from 5 to 6 (Open item 417, Ralph's
 * ruling relayed by Kane 2026-10-08).
 *
 * WHY: Kane, 2026-10-08: "instead of it being 5 hours capped, can you make it 6 …
 * where if any of it goes over its not paid … kaner@pathway worked 6.12 hrs have it
 * show the full total hours … but make it only pay out the correct amount, 6".
 * The caps are NOT constants in the pricer: `priceInternWeek` takes them as inputs and
 * `intern-week-server.ts` passes each intern's own `orphanage_interns.daily_cap_hours`
 * / `weekly_cap_hours`. All 9 profiles held 5 / 5 (measured 2026-10-07), so the change
 * is a data change on those two columns. Both move together: at 5 h/day a single
 * 6.12 h day would still pay 5, not the 6 Kane asked for.
 *
 * MONEY: yes. The wizard's preview of every UNLOCKED week reprices on its next read.
 * A locked week (`orphanage_intern_pay`) is untouched: it stores its own hours_by_day
 * and money, and `reconcileInternPayRow` re-derives from those, never from the caps.
 * The dry run prints the newest uploaded week priced at the old caps and the new.
 *
 * SAFE BY DEFAULT: the dry run prints every profile it would touch and writes a JSON
 * backup (no bank column is read) to docs/audits/backups/ (gitignored). `--apply`
 * writes. Idempotent: a converged table reports 0 rows and exits 0.
 *
 *   node --import tsx scripts/set-intern-caps-6h.mts            # dry run
 *   node --import tsx scripts/set-intern-caps-6h.mts --apply    # write
 *
 * GUARDS (fail closed):
 *   G1 target = profiles at exactly 5 h/day AND 5 h/week (the old default). A profile
 *      holding any other value was set on purpose and is listed, never overwritten.
 *   G2 each UPDATE is conditional on the row still reading 5 / 5 and must touch exactly
 *      one row; a row someone edited since the read is reported, never overwritten.
 *   G3 re-read after the writes: every changed row must read 6 / 6.
 *
 * Each changed row gets one `orphanage_intern.saved` audit row, the action the profile
 * dialog's own PATCH writes (`changed_fields`), plus previous / next caps.
 */
import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const ACTOR = 'kaner@simple.biz';
const SOURCE = 'scripts/set-intern-caps-6h.mts (Open item 417, Ralph via Kane 2026-10-08)';
const OLD_CAP = 5;
const NEW_CAP = 6;

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const { selectAllPaged } = await import('../src/lib/supabase/select-all-paged');
const { insertAuditLog } = await import('../src/lib/supabase/audit-log');
const { normEmail } = await import('../src/lib/email/norm-email');
const { internDaysFromRow } = await import('../src/lib/interns/intern-hours-csv');
const { priceInternWeek, splitInternGross } = await import('../src/lib/interns/intern-week-pay');

const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('Supabase service-role client unavailable — check .env.local');
  process.exit(1);
}
const die = (msg: string): never => {
  console.error(`\nABORT — ${msg}`);
  process.exit(2);
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const php = (n: number) => `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: unknown) => Number(v ?? 0);

interface ProfileRow {
  id: string;
  email: string;
  full_name: string;
  status: string;
  daily_cap_hours: number;
  weekly_cap_hours: number;
  orphanage_share_pct: number;
  updated_at: string;
}
interface RateRow { intern_id: string; rate_php: number; effective_from: string }
interface UploadRow { source_file: string; week_start: string; week_end: string }
interface HoursRow { source_file: string; row_index: number; email: string; row: Record<string, unknown> }

console.log(`${APPLY ? 'APPLY MODE' : 'DRY RUN (re-run with --apply to write)'} — intern caps ${OLD_CAP} h → ${NEW_CAP} h (day and week)\n`);

const [profiles, rates, uploads, payRows] = await Promise.all([
  selectAllPaged<ProfileRow>((from, to) =>
    sb.from('orphanage_interns')
      .select('id, email, full_name, status, daily_cap_hours, weekly_cap_hours, orphanage_share_pct, updated_at')
      .order('id', { ascending: true })
      .range(from, to)),
  selectAllPaged<RateRow>((from, to) =>
    sb.from('orphanage_intern_rates')
      .select('intern_id, rate_php, effective_from')
      .order('intern_id', { ascending: true })
      .order('effective_from', { ascending: true })
      .range(from, to)),
  selectAllPaged<UploadRow>((from, to) =>
    sb.from('orphanage_intern_hours_uploads')
      .select('source_file, week_start, week_end')
      .order('week_start', { ascending: true })
      .order('source_file', { ascending: true })
      .range(from, to)),
  selectAllPaged<{ id: string; source_file: string; status: string }>((from, to) =>
    sb.from('orphanage_intern_pay')
      .select('id, source_file, status')
      .order('id', { ascending: true })
      .range(from, to)),
]);
if (profiles.error) die(`orphanage_interns: ${profiles.error}`);
if (rates.error) die(`orphanage_intern_rates: ${rates.error}`);
if (uploads.error) die(`orphanage_intern_hours_uploads: ${uploads.error}`);
if (payRows.error) die(`orphanage_intern_pay: ${payRows.error}`);

// G1
const isOld = (p: ProfileRow) => num(p.daily_cap_hours) === OLD_CAP && num(p.weekly_cap_hours) === OLD_CAP;
const targets = profiles.rows.filter(isOld);
const leftAlone = profiles.rows.filter((p) => !isOld(p));
console.log(`G1 profiles: ${profiles.rows.length} · targeted (${OLD_CAP}/${OLD_CAP}): ${targets.length} · left alone: ${leftAlone.length}`);
for (const p of leftAlone) {
  console.log(`   left alone: ${p.email.padEnd(28)} ${num(p.daily_cap_hours)} h/day · ${num(p.weekly_cap_hours)} h/week (${p.status})`);
}
for (const p of targets) {
  console.log(`   ${p.email.padEnd(28)} ${OLD_CAP}/${OLD_CAP} → ${NEW_CAP}/${NEW_CAP}  (${p.status})`);
}
const locked = new Set(payRows.rows.map((r) => r.source_file));
console.log(`\nLocked weeks (orphanage_intern_pay): ${locked.size} week(s), ${payRows.rows.length} row(s) — stored money, NOT repriced by this change.`);

// What the newest uploaded, never-locked week pays at the old caps and the new — the ONE pricer.
const unlocked = uploads.rows.filter((u) => !locked.has(u.source_file));
const newest = unlocked[unlocked.length - 1];
if (newest) {
  const hours = await selectAllPaged<HoursRow>((from, to) =>
    sb.from('orphanage_intern_hours')
      .select('source_file, row_index, email, row')
      .eq('source_file', newest.source_file)
      .order('row_index', { ascending: true })
      .range(from, to));
  if (hours.error) die(`orphanage_intern_hours: ${hours.error}`);
  const byEmail = new Map(profiles.rows.map((p) => [normEmail(p.email) ?? p.email.toLowerCase(), p]));
  const ratesBy = new Map<string, Array<{ ratePhp: number; effectiveFrom: string }>>();
  for (const r of rates.rows) {
    const list = ratesBy.get(r.intern_id) ?? [];
    list.push({ ratePhp: num(r.rate_php), effectiveFrom: r.effective_from });
    ratesBy.set(r.intern_id, list);
  }
  const at = (cap: number) => {
    let paid = 0, capped = 0, pay = 0, toInterns = 0, priced = 0;
    for (const row of hours.rows) {
      const p = byEmail.get(normEmail(row.email) ?? row.email.toLowerCase());
      if (!p || p.status === 'ended') continue;
      const days = internDaysFromRow(row.row, newest.source_file, newest.week_start);
      if (!days) continue;
      const r = priceInternWeek({ days, rates: ratesBy.get(p.id) ?? [], dailyCapHours: cap, weeklyCapHours: cap });
      if (!r.ok) continue;
      priced += 1;
      paid += r.hoursPaid;
      capped += r.cappedOffHours;
      pay += r.payPhp;
      toInterns += splitInternGross(r.payPhp, num(p.orphanage_share_pct)).internPhp;
    }
    return { priced, paid: round2(paid), capped: round2(capped), pay: round2(pay), toInterns: round2(toInterns) };
  };
  const before = at(OLD_CAP);
  const after = at(NEW_CAP);
  console.log(`\nNewest unlocked week ${newest.week_start} → ${newest.week_end} (${before.priced} interns priced, PAB left out):`);
  console.log(`   at ${OLD_CAP} h: paid ${before.paid.toFixed(2)} h · capped ${before.capped.toFixed(2)} h · pay ${php(before.pay)} · to the interns ${php(before.toInterns)}`);
  console.log(`   at ${NEW_CAP} h: paid ${after.paid.toFixed(2)} h · capped ${after.capped.toFixed(2)} h · pay ${php(after.pay)} · to the interns ${php(after.toInterns)}`);
}

if (targets.length === 0) {
  console.log(`\nCONVERGED — no profile still holds ${OLD_CAP}/${OLD_CAP}. Nothing to do.`);
  process.exit(0);
}

// Backup BEFORE any write, in both modes.
mkdirSync('docs/audits/backups', { recursive: true });
const backupPath = `docs/audits/backups/intern-caps-pre-6h-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(backupPath, JSON.stringify({ source: SOURCE, apply: APPLY, rows: targets }, null, 2));
console.log(`\nBackup written: ${backupPath} (${targets.length} rows)`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to set the caps.');
  process.exit(0);
}

// G2 — conditional, one row at a time
const changed: ProfileRow[] = [];
const conflicts: string[] = [];
for (const p of targets) {
  const { data, error } = await sb
    .from('orphanage_interns')
    .update({ daily_cap_hours: NEW_CAP, weekly_cap_hours: NEW_CAP })
    .eq('id', p.id)
    .eq('daily_cap_hours', OLD_CAP)
    .eq('weekly_cap_hours', OLD_CAP)
    .select('id');
  if (error) {
    conflicts.push(`${p.email}: ${error.message}`);
    continue;
  }
  if ((data ?? []).length !== 1) {
    conflicts.push(`${p.email}: changed since the read (touched ${(data ?? []).length} rows) — left as it is`);
    continue;
  }
  changed.push(p);
  const audit = await insertAuditLog({
    user_name: ACTOR,
    user_role: 'admin',
    action: 'orphanage_intern.saved',
    resource: 'orphanage_interns',
    resource_id: p.id,
    details: {
      created: false,
      email: p.email,
      full_name: p.full_name,
      status: p.status,
      changed_fields: ['daily_cap_hours', 'weekly_cap_hours'],
      previous: { daily_cap_hours: OLD_CAP, weekly_cap_hours: OLD_CAP },
      next: { daily_cap_hours: NEW_CAP, weekly_cap_hours: NEW_CAP },
      source: SOURCE,
      why: 'Ralph (via Kane, 2026-10-08): pay up to 6 hours a week; hours over 6 are shown, never paid.',
    },
  });
  if (audit.error) console.warn(`   audit write failed for ${p.email}: ${audit.error} (the row change stands; see backup)`);
}

// G3 — re-read
const { data: after, error: afterErr } = await sb
  .from('orphanage_interns')
  .select('id, daily_cap_hours, weekly_cap_hours')
  .in('id', changed.map((p) => p.id));
if (afterErr) die(`G3: re-read failed: ${afterErr.message}`);
const wrong = (after ?? []).filter(
  (r: { daily_cap_hours: number; weekly_cap_hours: number }) => num(r.daily_cap_hours) !== NEW_CAP || num(r.weekly_cap_hours) !== NEW_CAP,
);

console.log(`\nChanged: ${changed.length} of ${targets.length}`);
for (const c of conflicts) console.log(`   NOT changed — ${c}`);
if (wrong.length > 0 || (after ?? []).length !== changed.length) die(`G3: ${wrong.length} changed row(s) do not read ${NEW_CAP}/${NEW_CAP} on re-read`);
console.log(`G3 ok — every changed row now reads ${NEW_CAP} h/day · ${NEW_CAP} h/week.`);
process.exit(conflicts.length > 0 ? 3 : 0);
