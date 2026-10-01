/**
 * The Accounting Scoreboard's sections: the in-HRIS copy of the main tab of Carla's "Accounting
 * Scoreboard" Google Sheet (docs/notes/2026-10-01-accounting-scoreboard-analysis.md § 2).
 * Governing doc: docs/features/accounting-scoreboard.md.
 *
 * Pure: no imports, so the page, the routes and `node --test` all share it.
 *
 * The section keys and slots are ALSO in the SQL CHECKs
 * (references/sql/create/2026-10-01_accounting_scoreboard.sql). `sections.test.ts` pins the two
 * lists together, so a section added here without its SQL fails the suite.
 */

export const SECTION_KEYS = [
  'buckets',
  'chargebacks',
  'pm_buckets',
  'collections',
  'onboarding',
  'compliance',
  'inbox',
  'cancellations',
  'payroll_timing',
  'payroll_problems',
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/** What one stored number is. `start`/`end` are minutes after midnight; `mtg` is 0/1. */
export const SLOTS = ['am', 'pm', 'day', 'mtg', 'start', 'end'] as const;
export type Slot = (typeof SLOTS)[number];

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABEL: Record<Weekday, string> = {
  sun: 'Sun',
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
};

/**
 * - `am_pm`       two counts a day: start of day and end of day (buckets, chargebacks, inbox)
 * - `daily`       one count a day (onboarding, compliance, cancellations, payroll problems)
 * - `daily_flag`  one count a day plus a "had a meeting" tick (PM buckets)
 * - `time_span`   a start and an end time a day, giving hours (payroll timing)
 * - `collections` nothing typed in a grid: points come from the collections log
 */
export type SectionKind = 'am_pm' | 'daily' | 'daily_flag' | 'time_span' | 'collections';

export const SLOTS_BY_KIND: Record<SectionKind, readonly Slot[]> = {
  am_pm: ['am', 'pm'],
  daily: ['day'],
  daily_flag: ['day', 'mtg'],
  time_span: ['start', 'end'],
  collections: [],
};

/**
 * - `avg_score`  the section's average 1–10 score (buckets: AVERAGE of the row scores; inbox: the
 *                score of the team's average end-of-day count, the sheet's R59)
 * - `team_week`  the section's whole-team total for the week
 */
export type GoalMeasure = 'avg_score' | 'team_week';
export type GoalDirection = 'at_least' | 'below';

export interface GoalRule {
  value: number;
  direction: GoalDirection;
  measure: GoalMeasure;
  /** Printed after the number: "score", "points", "hours". */
  unit: string;
}

/** Per-row score: `bucket` = the sheet's tiers on Σ(AM − PM); `inbox` = 10 − average PM count. */
export type ScoreRule = 'bucket' | 'inbox';

export interface SectionDef {
  key: SectionKey;
  title: string;
  /** Tab label. */
  tab: string;
  kind: SectionKind;
  /** The day columns, in order. */
  days: readonly Weekday[];
  score?: ScoreRule;
  /** The sheet's goal. A manager can override the number (accounting_scoreboard_sections.goal). */
  goal?: GoalRule;
  /** What one row is, singular ("bucket", "rep"). */
  rowNoun: string;
  /** One line telling people what to type. */
  help: string;
}

const MON_FRI: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];

/** Tab order. */
export const SECTIONS: readonly SectionDef[] = [
  {
    key: 'buckets',
    title: 'Accounting Buckets',
    tab: 'Buckets',
    kind: 'am_pm',
    days: MON_FRI,
    score: 'bucket',
    goal: { value: 8, direction: 'at_least', measure: 'avg_score', unit: 'score' },
    rowNoun: 'bucket',
    help: 'How many items sit in the bucket at the start of the day (AM) and at the end (PM).',
  },
  {
    key: 'collections',
    title: 'Collections Scoreboard',
    tab: 'Collections',
    kind: 'collections',
    days: MON_FRI,
    goal: { value: 85, direction: 'at_least', measure: 'team_week', unit: 'points' },
    rowNoun: 'rep',
    help: 'Log every collected account. Points add up per rep and per day.',
  },
  {
    key: 'pm_buckets',
    title: 'PM Buckets',
    tab: 'PM Buckets',
    kind: 'daily_flag',
    days: MON_FRI,
    rowNoun: 'PM',
    help: "Items waiting in each PM's bucket that day, and whether you met with them.",
  },
  {
    key: 'onboarding',
    title: 'Customer Sales Onboarding',
    tab: 'Sales Onboarding',
    kind: 'daily',
    days: MON_FRI,
    rowNoun: 'line',
    help: 'Customers onboarded for each closer that day.',
  },
  {
    key: 'inbox',
    title: 'Email Inbox',
    tab: 'Inbox',
    kind: 'am_pm',
    days: MON_FRI,
    score: 'inbox',
    goal: { value: 9, direction: 'at_least', measure: 'avg_score', unit: 'score' },
    rowNoun: 'inbox',
    help: 'How many emails are in the inbox at the start of the day (AM) and at the end (PM).',
  },
  {
    key: 'chargebacks',
    title: 'Chargebacks',
    tab: 'Chargebacks',
    kind: 'am_pm',
    days: MON_FRI,
    rowNoun: 'line',
    help: 'Open disputes, disputes due in 7 days and pre-arb, at the start (AM) and end (PM) of the day.',
  },
  {
    key: 'compliance',
    title: 'Compliance Scoreboard',
    tab: 'Compliance',
    kind: 'daily',
    days: MON_FRI,
    goal: { value: 30, direction: 'at_least', measure: 'team_week', unit: 'done' },
    rowNoun: 'person',
    help: 'Compliance items each person completed that day.',
  },
  {
    key: 'cancellations',
    title: 'Cancellation Call Recordings',
    tab: 'Cancellations',
    kind: 'daily',
    days: MON_FRI,
    rowNoun: 'rating',
    help: 'Cancellation call recordings reviewed that day, by rating.',
  },
  {
    key: 'payroll_timing',
    title: 'Payroll Scoreboard — Timing',
    tab: 'Payroll Timing',
    kind: 'time_span',
    days: ['sun', 'mon', 'tue', 'wed', 'thu'],
    goal: { value: 20, direction: 'below', measure: 'team_week', unit: 'hours' },
    rowNoun: 'person',
    help: 'When payroll processing started and finished on each of your processing days.',
  },
  {
    key: 'payroll_problems',
    title: 'Payroll Scoreboard — Problems',
    tab: 'Payroll Problems',
    kind: 'daily',
    days: MON_FRI,
    goal: { value: 20, direction: 'below', measure: 'team_week', unit: 'problems' },
    rowNoun: 'person',
    help: 'Payroll problems each person handled that day.',
  },
];

const BY_KEY = new Map<SectionKey, SectionDef>(SECTIONS.map((s) => [s.key, s]));

export function isSectionKey(value: unknown): value is SectionKey {
  return typeof value === 'string' && BY_KEY.has(value as SectionKey);
}

export function sectionDef(key: SectionKey): SectionDef {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`Unknown scoreboard section: ${key}`);
  return def;
}

export function slotsFor(key: SectionKey): readonly Slot[] {
  return SLOTS_BY_KIND[sectionDef(key).kind];
}

/** A manager's stored switch for one section (accounting_scoreboard_sections). */
export interface SectionSetting {
  sectionKey: SectionKey;
  enabled: boolean;
  goal: number | null;
}

export interface ResolvedSection extends SectionDef {
  enabled: boolean;
  /** The goal in force: the manager's override, else the sheet's number. Absent = no goal. */
  goal?: GoalRule;
}

/** Every section in tab order, with the stored switches applied. A missing setting = on, default goal. */
export function resolveSections(settings: readonly SectionSetting[]): ResolvedSection[] {
  const byKey = new Map(settings.map((s) => [s.sectionKey, s]));
  return SECTIONS.map((def) => {
    const s = byKey.get(def.key);
    const goal =
      def.goal && s && s.goal !== null && Number.isFinite(s.goal) ? { ...def.goal, value: s.goal } : def.goal;
    return { ...def, enabled: s ? s.enabled : true, goal };
  });
}
