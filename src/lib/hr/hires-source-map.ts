/**
 * The hiring-database sync's decisions, kept PURE so every rule is test-pinned.
 * Doc: docs/features/new-hire-source-sync.md
 *
 *   mapSourceRow          a source row → the ten checklist values (+ its key and stamps)
 *   interviewCalendarDate an interview timestamp → its US EASTERN calendar date
 *   targetWeekFor         interview date → the checklist week it belongs to
 *   decidePlacement       place it / link it to a row HR already typed / hold it, and why
 *   mergeSourceIntoRow    which cells the sync may write on an existing row
 *
 * The rules the next editor is most likely to break are restated in the doc; the
 * short version is: the sync never writes a locked week, never fills a past
 * week on its own, never lists a hire twice, never overwrites a cell HR typed,
 * and never blanks a cell.
 */

import { createHash } from 'node:crypto';

import { resolveOnboardingCountry } from '@/lib/onboarding/countries';
import { BASE_SOURCE_OPTIONS, normalizeSource } from '@/lib/hr/referral-source';

import { HIRES_SOURCE_FIELDS, type HiresSourceConfig, type HiresSourceField } from './hires-source-config';

export type HireValues = Record<HiresSourceField, string | null>;

export interface MappedSourceHire {
  sourceKey: string;
  values: HireValues;
  /** The source's raw interview timestamp, when it parsed as one (ISO). */
  interviewAt: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
const DAY_MS = 86_400_000;

/** A hire already on the checklist this many days BEFORE the target week (or any
 *  time after it) is the same listing, so the sync links instead of adding. */
export const LINK_LOOKBACK_DAYS = 28;

/** The actor the sync writes into `cell_edits` (`by`) and `created_by`. */
export const HIRES_SYNC_ACTOR = 'hires-sync';

function clean(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

/**
 * The zone an interview's calendar date is read in: US EASTERN (DST-aware).
 *
 * Measured 2026-10-08 on the 23 portal hires HR had also typed by hand: HR's date
 * equals the portal timestamp's New York date on 20 of 23, its Manila date on only
 * 11. The portal's interviews sit at 13:00–18:30Z = 9 AM–2:30 PM New York, so
 * reading them in Manila (the first cut, from Kane's two sample rows) put every
 * interview after 16:00Z on the NEXT day, and a Saturday-afternoon one a whole
 * week late. Kane: "put the interview date properly". Never switch this back to
 * Manila without re-measuring against HR's own dates.
 */
export const INTERVIEW_TIME_ZONE = 'America/New_York';

/** The YYYY-MM-DD of an instant on a zone's wall clock. */
function ymdIn(ms: number, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/**
 * The interview's calendar date, in INTERVIEW_TIME_ZONE (US Eastern). A plain
 * date (no time) has no zone and is taken as written; "8/14/2026" is read
 * month-first, the way 765 existing checklist rows are written.
 */
export function interviewCalendarDate(raw: unknown): { date: string | null; at: string | null } {
  const s = clean(raw);
  if (!s) return { date: null, at: null };
  if (ISO_DATE.test(s)) return { date: s, at: null };
  const us = s.match(US_DATE);
  if (us) {
    const y = us[3]!.length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    const m = Number(us[1]);
    const d = Number(us[2]);
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return { date: null, at: null };
    return { date: probe.toISOString().slice(0, 10), at: null };
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return { date: null, at: null };
  return { date: ymdIn(ms, INTERVIEW_TIME_ZONE), at: new Date(ms).toISOString() };
}

function addDays(isoDate: string, n: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** The Sunday that starts the Sun–Sat week containing `isoDate`. */
export function sundayOfDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return addDays(isoDate, -dow);
}

/**
 * This week's Sunday on the MANILA calendar — the "current week" the sync compares
 * against. Deliberately not INTERVIEW_TIME_ZONE: it matches the grid's own "Start
 * Week" badge, which is the HR browser's local Sunday, and HR works from Manila.
 */
export function currentManilaSunday(nowMs: number = Date.now()): string {
  return sundayOfDate(ymdIn(nowMs, 'Asia/Manila'));
}

/**
 * The checklist week a hire belongs to: the week AFTER the interview week.
 * Measured 2026-10-08 over every live row: 1,640 of the 1,747 rows with an
 * interview date (94%) sit exactly one week after it; 753 of 790 since August.
 */
export function targetWeekFor(interviewDate: string): string {
  return addDays(sundayOfDate(interviewDate), 7);
}

function stamp(raw: unknown): string | null {
  const s = clean(raw);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * One source row → the ten checklist values. Returns null when the row has no
 * usable id (it can never be keyed, so it can never be de-duplicated — it is
 * counted and skipped, never guessed).
 */
export function mapSourceRow(raw: Record<string, unknown>, cfg: HiresSourceConfig): MappedSourceHire | null {
  const sourceKey = clean(raw[cfg.idColumn]);
  if (!sourceKey) return null;
  const values = {} as HireValues;
  for (const f of HIRES_SOURCE_FIELDS) values[f] = clean(raw[cfg.cols[f]]);
  const interview = interviewCalendarDate(raw[cfg.cols.date_of_interview]);
  // An unparseable interview cell is KEPT as written (the checklist column is free
  // text); it simply cannot place the hire, which is held as `no_interview_date`.
  values.date_of_interview = interview.date ?? values.date_of_interview;
  if (values.personal_email) values.personal_email = values.personal_email.toLowerCase();
  return {
    sourceKey,
    values,
    interviewAt: interview.at,
    sourceCreatedAt: cfg.createdAtColumn ? stamp(raw[cfg.createdAtColumn]) : null,
    sourceUpdatedAt: cfg.updatedAtColumn ? stamp(raw[cfg.updatedAtColumn]) : null,
  };
}

/** Stable digest of what the checklist would show. Changes ⇔ a cell changed at the source. */
export function contentHash(values: HireValues): string {
  const ordered = HIRES_SOURCE_FIELDS.map((f) => values[f] ?? null);
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex').slice(0, 32);
}

/**
 * Snap the free-text values to the spellings the rest of the HRIS keys on — the
 * same snaps the New Hire modal applies before a manual write: department to an
 * existing department's casing, country to its onboarding name (Bulk Invite
 * routes on it), source to a known source's spelling. Anything unrecognised is
 * KEPT as written, never dropped.
 */
export function canonicalizeHireValues(
  values: HireValues,
  known: { departments: readonly string[]; sources: readonly string[] },
): HireValues {
  const out = { ...values };
  const dept = values.department;
  if (dept) out.department = known.departments.find((d) => d.toLowerCase() === dept.toLowerCase()) ?? dept;
  const country = values.country;
  if (country) out.country = resolveOnboardingCountry(country)?.name ?? country;
  const src = values.source;
  if (src) {
    const key = normalizeSource(src);
    out.source = [...BASE_SOURCE_OPTIONS, ...known.sources].find((s) => normalizeSource(s) === key) ?? src;
  }
  return out;
}

export type HoldReason = 'week_locked' | 'past_week' | 'no_interview_date';

/** A held hire as the sync route hands it to the checklist's sync strip. */
export type HeldHire = {
  source_key: string;
  name: string | null;
  personal_email: string | null;
  department: string | null;
  date_of_interview: string | null;
  target_period_start: string | null;
  hold_reason: HoldReason | null;
  first_pulled_at: string;
  source_created_at: string | null;
};

/**
 * One hire in the HRIS copy, as the strip's "Synced data" list shows it: what came in,
 * when, and where it went. `onChecklist` false with placement placed/linked = HR has
 * since deleted that checklist row (placed hires are never re-placed).
 */
export type SyncedHire = {
  source_key: string;
  name: string | null;
  personal_email: string | null;
  department: string | null;
  date_of_interview: string | null;
  first_pulled_at: string;
  last_changed_at: string;
  placement: 'pending' | 'placed' | 'linked' | 'held';
  hold_reason: HoldReason | null;
  /** The checklist week it was added to / matched in (or the week a hold names). */
  week: string | null;
  onChecklist: boolean;
};

/** One checklist row as the placement decision sees it. */
export interface ChecklistIndexRow {
  id: string;
  period_start: string;
  personal_email: string | null;
  name: string | null;
}

export type PlacementDecision =
  | { kind: 'place'; period: string }
  | { kind: 'link'; period: string; rowId: string }
  /** Waits in "Not placed" for HR's one-click Add: no interview date, its week is past, or its week is locked. */
  | { kind: 'hold'; period: string | null; reason: HoldReason }
  /** Another week's hire, still ahead: left undecided until that week is on the week selector. */
  | { kind: 'defer'; period: string };

function foldName(s: string | null): string | null {
  const t = (s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return t || null;
}

/**
 * The week a hire is left for, or null when this pass decides it: a DATED hire whose checklist week (the week after
 * the interview) is NOT the week on the selector and has not passed yet. Kane, 2026-10-08: "align the date of
 * interview to the week selector … that we can only sync that data for that specific week period", ruled (b).
 */
export function deferredToWeek(interviewDate: string | null, selectedWeek: string, currentSunday: string): string | null {
  if (!interviewDate || !ISO_DATE.test(interviewDate)) return null;
  const target = targetWeekFor(interviewDate);
  return target !== selectedWeek && target >= currentSunday ? target : null;
}

/**
 * Where a new source hire goes, for ONE week: the week on the HR week selector (`selectedWeek`). Kane, 2026-10-08,
 * ruled "(b) Only the week on screen", which REPLACED that day's "automatically added to this week" ("A"). Order:
 *  0. A dated hire of ANOTHER week still ahead → DEFER: untouched until that week is selected (`deferredToWeek`).
 *  1. Already listed → LINK, before any week check, so a hire HR typed into a past or locked week is "on the
 *     checklist", never added twice. Same personal email in any week from LINK_LOOKBACK_DAYS before the reference
 *     week onward (prefer the reference week, then the latest); with no email, the exact name in the reference week
 *     only. The reference week is the target week, or THIS week for a hire with no interview date. A duplicate
 *     listing is two orientation emails; a false link costs HR one click, so ties lean toward linking.
 *  2. No usable interview date → HOLD `no_interview_date`: it belongs to no week, so it is never put in one on its own.
 *  3. Its week (the week after the interview) already past → HOLD `past_week`. A past week is never written.
 *  4. Its week is the selected week but locked → HOLD `week_locked`. A locked week is never written
 *     (new-hire-checklist.md: "A locked week refuses every mutating verb").
 *  5. Otherwise (its week IS the selected week, this week or later, open) → PLACE there.
 * A held hire is re-decided every pass (it links once HR types it in), and HR can add it by hand under "Not placed".
 */
export function decidePlacement(args: {
  values: HireValues;
  /** The week on the HR week selector (its Sunday): the only week a pass writes. */
  selectedWeek: string;
  currentSunday: string;
  isWeekLocked: (period: string) => boolean;
  checklist: readonly ChecklistIndexRow[];
}): PlacementDecision {
  const date = args.values.date_of_interview;
  const deferred = deferredToWeek(date, args.selectedWeek, args.currentSunday);
  if (deferred) return { kind: 'defer', period: deferred };
  const target = date && ISO_DATE.test(date) ? targetWeekFor(date) : null;
  const reference = target ?? args.currentSunday;

  const email = args.values.personal_email?.toLowerCase() ?? null;
  if (email) {
    const floor = addDays(reference, -LINK_LOOKBACK_DAYS);
    const hits = args.checklist
      .filter((r) => (r.personal_email ?? '').trim().toLowerCase() === email && r.period_start >= floor)
      .sort((a, b) =>
        a.period_start === reference
          ? -1
          : b.period_start === reference
            ? 1
            : b.period_start.localeCompare(a.period_start),
      );
    if (hits[0]) return { kind: 'link', period: hits[0].period_start, rowId: hits[0].id };
  } else {
    const name = foldName(args.values.name);
    const hit = name
      ? args.checklist.find((r) => r.period_start === reference && foldName(r.name) === name)
      : undefined;
    if (hit) return { kind: 'link', period: reference, rowId: hit.id };
  }

  if (target === null) return { kind: 'hold', period: null, reason: 'no_interview_date' };
  if (target < args.currentSunday) return { kind: 'hold', period: target, reason: 'past_week' };
  if (args.isWeekLocked(target)) return { kind: 'hold', period: target, reason: 'week_locked' };
  return { kind: 'place', period: target };
}

/**
 * Which cells the sync may write on an existing checklist row, given what is in
 * the cell now (`current`), what the sync itself last wrote there (`applied`,
 * null for a row HR typed) and the source's latest values (`incoming`).
 *
 * A cell is written when it is BLANK and the sync never wrote it, or when it still
 * holds exactly what the sync last wrote (HR has not touched it) and the source
 * now says something else. A cell HR typed or changed is never overwritten, a cell
 * the sync filled and HR then CLEARED stays clear (HR wins for good; since
 * 2026-10-08 the selected week is merged every pass, so a refill would undo HR
 * within 30 s), and the sync never blanks a cell (a value removed at the source
 * stays here).
 */
export function mergeSourceIntoRow(args: {
  current: Partial<Record<HiresSourceField, string | null>>;
  applied: Partial<Record<HiresSourceField, string | null>> | null;
  incoming: HireValues;
}): { updates: Partial<HireValues>; nextApplied: Partial<HireValues> } {
  const updates: Partial<HireValues> = {};
  const nextApplied: Partial<HireValues> = { ...(args.applied ?? {}) };
  for (const f of HIRES_SOURCE_FIELDS) {
    const next = clean(args.incoming[f]);
    if (next === null) continue;
    const cur = clean(args.current[f]);
    const mine = clean(args.applied?.[f]);
    if (cur === next) {
      if (mine !== null) nextApplied[f] = next;
      continue;
    }
    if ((cur === null && mine === null) || (mine !== null && cur === mine)) {
      updates[f] = next;
      nextApplied[f] = next;
    }
  }
  return { updates, nextApplied };
}

/**
 * Does the source hold something the sync has not applied to its row yet? A field with a value whose `applied` entry
 * differs (or is missing). Decides, without reading the checklist, whether a synced row of the selected week needs
 * its cells read and merged this pass. True forever for a field HR owns (it never becomes `applied`): that costs one
 * read of the week's rows, never a write.
 */
export function sourceAheadOfApplied(incoming: HireValues, applied: Partial<Record<HiresSourceField, string | null>> | null): boolean {
  return HIRES_SOURCE_FIELDS.some((f) => {
    const next = clean(incoming[f]);
    return next !== null && clean(applied?.[f]) !== next;
  });
}

/** The `applied_values` for a row the sync inserted: every non-blank value it wrote. */
export function appliedFromValues(values: HireValues): Partial<HireValues> {
  const out: Partial<HireValues> = {};
  for (const f of HIRES_SOURCE_FIELDS) if (values[f] !== null) out[f] = values[f];
  return out;
}
