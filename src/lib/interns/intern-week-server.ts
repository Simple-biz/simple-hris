import 'server-only';

import { getAppSettings } from '@/lib/supabase/app-settings';
import { PAB_PERIOD_OVERRIDES_KEY, parsePabPeriodOverrides, yearMonthKey } from '@/lib/pab-period-settings';
import { getPabMonthRange } from '@/lib/hubstaff/calendar-column-dedupe';
import { isFinalPabWeek, pabMonthFromWeekStart } from '@/lib/payroll/dispatch-bonuses';
import { fetchInternHoursBySourceFile, getInternHoursUpload } from '@/lib/supabase/orphanage-intern-hours-db';
import { listInternRates, listInternsByEmail } from '@/lib/supabase/orphanage-interns-db';
import { listInternPayBetween, listInternPayBySourceFile, type InternPayUpsertInput } from '@/lib/supabase/orphanage-intern-pay-db';
import { normEmail } from '@/lib/email/norm-email';
import { INTERN_CONFIG_KEY, parseInternConfig, type InternConfig } from './intern-config';
import { internDaysFromRow } from './intern-hours-csv';
import { INTERN_PAB_MIN_WEEKLY_HOURS, internPabVerdict, type InternPabVerdict } from './intern-pab';
import { priceInternWeek, splitInternGross, type InternDayPriced, type InternPriceRefusalCode } from './intern-week-pay';
import type { OrphanageInternHoursUploadRow, OrphanageInternPayRow, OrphanageInternRow } from './intern-types';

/**
 * The server-side pricer for one intern week — the ONE path that turns a stored
 * intern report into money. Used by the mini wizard's preview, its Lock in
 * (which recomputes here and never trusts the client's figures), and nothing
 * else prices an intern week. Everything numeric comes from the pure modules
 * (`priceInternWeek`, `internPabVerdict`, `splitInternGross`).
 *
 * PAB period and payout week are resolved EXACTLY as `current-pay.ts` resolves
 * them for Simple: the week's owning month is `pabMonthFromWeekStart(Monday)`,
 * the window is the month's override in `pab_period_overrides` else
 * `getPabMonthRange`, and the payout week is the one that CONTAINS the period
 * end (`isFinalPabWeek`). "Same pay cycle as Simple" (Ralph) means the same
 * readers, not a second calendar.
 */

export interface InternWeekPricedRow {
  internId: string | null;
  email: string;
  name: string;
  hasProfile: boolean;
  refusal: { code: InternPriceRefusalCode | 'no_day_columns' | 'no_profile' | 'ended'; reason: string } | null;
  hoursRaw: number;
  hoursPaid: number;
  cappedOffHours: number;
  hoursByDay: Record<string, InternDayPriced>;
  ratePhp: number | null;
  mixedRates: boolean;
  payPhp: number;
  pab: { verdict: InternPabVerdict; month: string } | null;
  pabPhp: number;
  grossPhp: number;
  orphanageSharePct: number;
  orphanageSharePhp: number;
  internSharePhp: number;
}

export interface InternWeekPreview {
  sourceFile: string;
  weekStart: string;
  weekEnd: string;
  upload: OrphanageInternHoursUploadRow;
  rows: InternWeekPricedRow[];
  /** @pathway.ph rows in the file with no profile — a lock-in blocker. */
  unknownEmails: Array<{ email: string; name: string }>;
  /** Active interns absent from the file — informational. */
  internsWithoutHours: Array<{ id: string; email: string; name: string }>;
  config: InternConfig;
  pab: { payoutWeek: boolean; month: string; periodStart: string; periodEnd: string; minWeeklyHours: number };
  existing: { status: OrphanageInternPayRow['status'] | null; rows: OrphanageInternPayRow[] };
  totals: { interns: number; hoursPaid: number; payPhp: number; pabPhp: number; grossPhp: number; orphanagePhp: number; internPhp: number };
  /** Every reason Lock in is refused right now. Empty = lockable. */
  blockers: string[];
}

const isoLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseLocal = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export async function resolveInternPabWindow(weekStart: string, weekEnd: string): Promise<{
  payoutWeek: boolean;
  month: string;
  periodStart: string;
  periodEnd: string;
}> {
  const settings = await getAppSettings([PAB_PERIOD_OVERRIDES_KEY]);
  const overrides = parsePabPeriodOverrides(settings[PAB_PERIOD_OVERRIDES_KEY]);
  // The owning month is MONDAY-based for every week model (current-pay.ts).
  const monday = parseLocal(weekStart);
  monday.setDate(monday.getDate() + 1);
  const { year, month } = pabMonthFromWeekStart(monday);
  const key = yearMonthKey(year, month);
  const ov = overrides.get(key);
  const range = ov ? { start: ov.start, end: ov.end } : getPabMonthRange(year, month);
  return {
    payoutWeek: isFinalPabWeek(parseLocal(weekStart), parseLocal(weekEnd), range.end),
    month: key,
    periodStart: isoLocal(range.start),
    periodEnd: isoLocal(range.end),
  };
}

export async function buildInternWeekPreview(sourceFile: string): Promise<{ preview: InternWeekPreview | null; error: string | null }> {
  const { upload, error: upErr } = await getInternHoursUpload(sourceFile);
  if (upErr) return { preview: null, error: upErr };
  if (!upload) return { preview: null, error: `No intern report has been uploaded as "${sourceFile}".` };

  const [{ rows: stored, error: rowsErr }, { byEmail, error: profErr }, { rows: existing, error: exErr }, settings] = await Promise.all([
    fetchInternHoursBySourceFile(sourceFile),
    listInternsByEmail(),
    listInternPayBySourceFile(sourceFile),
    getAppSettings([INTERN_CONFIG_KEY]),
  ]);
  if (rowsErr) return { preview: null, error: rowsErr };
  if (profErr) return { preview: null, error: profErr };
  if (exErr) return { preview: null, error: exErr };
  const config = parseInternConfig(settings[INTERN_CONFIG_KEY]);

  const profiles = [...byEmail.values()];
  const { byIntern: ratesByIntern, error: ratesErr } = await listInternRates(profiles.map((p) => p.id));
  if (ratesErr) return { preview: null, error: ratesErr };

  const pabWindow = await resolveInternPabWindow(upload.week_start, upload.week_end);

  // Every locked week that could count toward this month's PAB, for every intern at once.
  let priorWeeks: OrphanageInternPayRow[] = [];
  if (pabWindow.payoutWeek) {
    const { rows, error } = await listInternPayBetween(pabWindow.periodStart, pabWindow.periodEnd);
    if (error) return { preview: null, error };
    priorWeeks = rows.filter((r) => r.source_file !== sourceFile);
  }

  const rows: InternWeekPricedRow[] = [];
  const unknownEmails: InternWeekPreview['unknownEmails'] = [];
  const seenInternIds = new Set<string>();

  for (const r of stored) {
    const email = normEmail(r.email) ?? r.email.toLowerCase();
    const nameFromRow = String(r.row['Member'] ?? r.row['member'] ?? r.row['Name'] ?? r.row['name'] ?? '').trim();
    const profile = byEmail.get(email);
    if (!profile) {
      unknownEmails.push({ email, name: nameFromRow });
      rows.push(emptyRow(null, email, nameFromRow || email, false, { code: 'no_profile', reason: 'No intern profile for this email — add them in Profiles.' }));
      continue;
    }
    seenInternIds.add(profile.id);
    if (profile.status === 'ended') {
      rows.push(emptyRow(profile.id, email, profile.full_name, true, { code: 'ended', reason: `Internship ended${profile.ended_on ? ` on ${profile.ended_on}` : ''}. Reactivate the profile to pay this week.` }));
      continue;
    }

    const days = internDaysFromRow(r.row, sourceFile, upload.week_start);
    if (!days) {
      rows.push(emptyRow(profile.id, email, profile.full_name, true, { code: 'no_day_columns', reason: 'This row has no per-day hours columns, so the daily cap cannot be applied. Re-export the report with the weekday columns.' }));
      continue;
    }

    const rates = (ratesByIntern.get(profile.id) ?? []).map((x) => ({ ratePhp: x.rate_php, effectiveFrom: x.effective_from }));
    const priced = priceInternWeek({ days, rates, dailyCapHours: profile.daily_cap_hours, weeklyCapHours: profile.weekly_cap_hours });
    if (!priced.ok) {
      rows.push(emptyRow(profile.id, email, profile.full_name, true, { code: priced.code, reason: priced.reason }));
      continue;
    }

    let pab: InternWeekPricedRow['pab'] = null;
    let pabPhp = 0;
    if (pabWindow.payoutWeek) {
      const weeks = priorWeeks
        .filter((w) => w.intern_id === profile.id)
        .map((w) => ({ weekStart: w.week_start, weekEnd: w.week_end, hoursPaid: w.hours_paid }));
      weeks.push({ weekStart: upload.week_start, weekEnd: upload.week_end, hoursPaid: priced.hoursPaid });
      const verdict = internPabVerdict({
        period: { start: pabWindow.periodStart, end: pabWindow.periodEnd },
        weeks,
        minWeeklyHours: INTERN_PAB_MIN_WEEKLY_HOURS,
        bonusPhp: profile.pab_bonus_php,
      });
      pab = { verdict, month: pabWindow.month };
      pabPhp = verdict.amountPhp;
    }

    const grossPhp = round2(priced.payPhp + pabPhp);
    const split = splitInternGross(grossPhp, profile.orphanage_share_pct);
    rows.push({
      internId: profile.id,
      email,
      name: profile.full_name,
      hasProfile: true,
      refusal: null,
      hoursRaw: priced.hoursRaw,
      hoursPaid: priced.hoursPaid,
      cappedOffHours: priced.cappedOffHours,
      hoursByDay: priced.hoursByDay,
      ratePhp: priced.ratePhp,
      mixedRates: priced.mixedRates,
      payPhp: priced.payPhp,
      pab,
      pabPhp,
      grossPhp,
      orphanageSharePct: profile.orphanage_share_pct,
      orphanageSharePhp: split.orphanagePhp,
      internSharePhp: split.internPhp,
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const internsWithoutHours = profiles
    .filter((p) => p.status === 'active' && !seenInternIds.has(p.id))
    .map((p) => ({ id: p.id, email: p.email, name: p.full_name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const priced = rows.filter((r) => !r.refusal);
  const totals = {
    interns: priced.length,
    hoursPaid: round2(priced.reduce((s, r) => s + r.hoursPaid, 0)),
    payPhp: round2(priced.reduce((s, r) => s + r.payPhp, 0)),
    pabPhp: round2(priced.reduce((s, r) => s + r.pabPhp, 0)),
    grossPhp: round2(priced.reduce((s, r) => s + r.grossPhp, 0)),
    orphanagePhp: round2(priced.reduce((s, r) => s + r.orphanageSharePhp, 0)),
    internPhp: round2(priced.reduce((s, r) => s + r.internSharePhp, 0)),
  };

  const blockers: string[] = [];
  if (!config.shareMode) blockers.push('Accounting has not set how the orphanage share is paid (Setup in the Payroll Wizard → Interns).');
  if (unknownEmails.length > 0) blockers.push(`${unknownEmails.length} @pathway.ph row${unknownEmails.length === 1 ? '' : 's'} in the file ${unknownEmails.length === 1 ? 'has' : 'have'} no intern profile.`);
  const refusedPriced = rows.filter((r) => r.hasProfile && r.refusal && r.refusal.code !== 'ended');
  if (refusedPriced.length > 0) blockers.push(`${refusedPriced.length} row${refusedPriced.length === 1 ? '' : 's'} could not be priced.`);
  if (priced.length === 0) blockers.push('Nothing to lock in — no intern row priced.');
  const existingStatus = existing[0]?.status ?? null;
  if (existingStatus === 'accepted') blockers.push('This week has been accepted by Accounting. Ask them to reopen it before locking in again.');

  return {
    preview: {
      sourceFile,
      weekStart: upload.week_start,
      weekEnd: upload.week_end,
      upload,
      rows,
      unknownEmails,
      internsWithoutHours,
      config,
      pab: { ...pabWindow, minWeeklyHours: INTERN_PAB_MIN_WEEKLY_HOURS },
      existing: { status: existingStatus, rows: existing },
      totals,
      blockers,
    },
    error: null,
  };
}

function emptyRow(
  internId: string | null,
  email: string,
  name: string,
  hasProfile: boolean,
  refusal: InternWeekPricedRow['refusal'],
): InternWeekPricedRow {
  return {
    internId,
    email,
    name,
    hasProfile,
    refusal,
    hoursRaw: 0,
    hoursPaid: 0,
    cappedOffHours: 0,
    hoursByDay: {},
    ratePhp: null,
    mixedRates: false,
    payPhp: 0,
    pab: null,
    pabPhp: 0,
    grossPhp: 0,
    orphanageSharePct: 0,
    orphanageSharePhp: 0,
    internSharePhp: 0,
  };
}

/** The rows a lock-in writes: only priced rows, with the decided share mode stamped on. */
export function internPayRowsFromPreview(preview: InternWeekPreview, profilesById: Map<string, OrphanageInternRow>): InternPayUpsertInput[] {
  const mode = preview.config.shareMode;
  if (!mode) return [];
  const out: InternPayUpsertInput[] = [];
  for (const r of preview.rows) {
    if (r.refusal || !r.internId) continue;
    const p = profilesById.get(r.internId);
    if (!p) continue;
    out.push({
      source_file: preview.sourceFile,
      intern_id: r.internId,
      intern_email: r.email,
      intern_name: r.name,
      week_start: preview.weekStart,
      week_end: preview.weekEnd,
      hours_raw: r.hoursRaw,
      hours_paid: r.hoursPaid,
      hours_by_day: Object.fromEntries(Object.entries(r.hoursByDay).map(([k, v]) => [k, { raw: v.raw, paid: v.paid, rate_php: v.ratePhp }])),
      rate_php: r.ratePhp ?? 0,
      pay_php: r.payPhp,
      pab_php: r.pabPhp,
      pab_mode: preview.pab.payoutWeek ? 'weekly_hours' : 'not_payout_week',
      pab_month: r.pabPhp > 0 ? preview.pab.month : null,
      gross_php: r.grossPhp,
      orphanage_share_pct: r.orphanageSharePct,
      orphanage_share_php: r.orphanageSharePhp,
      intern_share_php: r.internSharePhp,
      share_mode: mode,
      submitted_by: null,
    });
  }
  return out;
}
