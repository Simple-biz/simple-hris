/**
 * The Accounting Scoreboard's sections: the in-HRIS copy of the main tab of Carla's "Accounting
 * Scoreboard" Google Sheet (docs/notes/2026-10-01-accounting-scoreboard-analysis.md § 2).
 * Governing doc: docs/features/accounting-scoreboard.md.
 *
 * Pure: no imports, so the page, the routes and `node --test` all share it.
 *
 * The section keys and slots are ALSO in the SQL CHECKs (created in
 * references/sql/create/2026-10-01_accounting_scoreboard.sql, re-declared by
 * 2026-10-06_accounting_scoreboard_round3.sql). `sections.test.ts` pins the two lists together, so a
 * section added here without its SQL fails the suite.
 *
 * Built-in sections are code. A manager's CUSTOM section (Setup → Sections → New section, Carla
 * 2026-10-02) is a row of accounting_scoreboard_custom_sections, and its rows carry section_key
 * 'custom'. `BoardSection` is the one shape the page renders for both.
 */

export const SECTION_KEYS = [
  'buckets',
  'chargebacks',
  'chargeback_outcomes',
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

/** What a row's section_key may be: a built-in section, or 'custom' (its custom_section_id says which). */
export const ROW_SECTION_KEYS = [...SECTION_KEYS, 'custom'] as const;
export type RowSectionKey = (typeof ROW_SECTION_KEYS)[number];

/**
 * What one stored number is. `start`/`end` are minutes after midnight; `mtg` is 0/1; `usd` is a
 * dollar amount and `count` a whole number (Chargeback Outcomes).
 */
export const SLOTS = ['am', 'pm', 'day', 'mtg', 'start', 'end', 'usd', 'count'] as const;
export type Slot = (typeof SLOTS)[number];

/**
 * What a Chargeback Outcomes line counts as for the win ratio (accounting_scoreboard_rows.outcome; the
 * SQL CHECK acct_sb_rows_outcome_valid lists the same values). Pre-arb is neither: it is not decided.
 */
export const OUTCOMES = ['win', 'loss'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export function isOutcome(value: unknown): value is Outcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);
}

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

/** The board's working days. Every section keeps these, except Payroll Timing (its two deadlines). */
export const MON_FRI: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];

/**
 * - `am_pm`       two counts a day: start of day and end of day (buckets, chargebacks, inbox)
 * - `daily`       one count a day (onboarding, compliance, cancellations)
 * - `daily_flag`  one count a day plus a "had a meeting" tick (PM buckets)
 * - `time_span`   a start and an end time a day, giving hours. No section uses it since 2026-10-01
 *                 (Payroll Timing moved to `payroll_cycle`). It is kept because the SQL slot CHECK
 *                 still allows `start`/`end` and one entry of that shape exists (measured 10-01).
 * - `collections` nothing typed in a grid: points come from the collections log
 * - `payroll_cycle` nothing typed at all: started/closed come from HRIS's own audit log
 *                 (payroll-cycle.ts)
 * - `amount_count` a dollar amount and a count a day (Chargeback Outcomes: Pre-arb, Wins, Losses)
 * - `problem_log` nothing typed in a grid: problems are logged one line at a time, each with a type
 *                 (Payroll Problems since 2026-10-06). The grid's earlier `day` counts are read, never
 *                 written: they count as "No type".
 */
export type SectionKind =
  | 'am_pm'
  | 'daily'
  | 'daily_flag'
  | 'time_span'
  | 'collections'
  | 'payroll_cycle'
  | 'amount_count'
  | 'problem_log';

export const SLOTS_BY_KIND: Record<SectionKind, readonly Slot[]> = {
  am_pm: ['am', 'pm'],
  daily: ['day'],
  daily_flag: ['day', 'mtg'],
  time_span: ['start', 'end'],
  collections: [],
  payroll_cycle: [],
  amount_count: ['usd', 'count'],
  problem_log: [],
};

/**
 * - `score`      the section's 0–10 score, never paced (buckets and Open Disputes: 10 × Σ completed ÷
 *                Σ(completed + open) over the scored lines; inbox: the score of the team's average
 *                end-of-day count, the sheet's R59)
 * - `team_week`  the section's whole-team total for the week (the only measure judged on pace)
 * - `cycle_score` Payroll Timing's 0–100 cycle score (payroll-cycle.ts)
 * - `average`    an average, never paced (PM Buckets: Σ of each PM's daily average)
 * - `ratio`      a 0–100 percentage, never paced (Outcomes: the win ratio)
 */
export type GoalMeasure = 'score' | 'team_week' | 'cycle_score' | 'average' | 'ratio';
export type GoalDirection = 'at_least' | 'below';

export interface GoalRule {
  value: number;
  direction: GoalDirection;
  measure: GoalMeasure;
  /** Printed after the number: "score", "points", "hours"; "%" prints as a percent. */
  unit: string;
}

/** What a goal is judged on, before anyone gives it a number. */
export type GoalShape = Omit<GoalRule, 'value'>;

/** The highest goal a measure can take: a score is 0–10, a percentage 0–100, anything else the table's 100,000. */
export function goalMax(shape: Pick<GoalShape, 'measure'>): number {
  switch (shape.measure) {
    case 'score':
      return 10;
    case 'ratio':
    case 'cycle_score':
      return 100;
    default:
      return 100000;
  }
}

/**
 * Per-row score:
 * - `cleared` Carla's rule of 2026-10-02: Completed = every decrease between back-to-back readings
 *             (overnight too), Open = the latest reading, Score = 10 × Completed ÷ (Completed + Open).
 *             It replaced the sheet's tiers on Σ(AM − PM).
 * - `inbox`   10 − the average PM count (the sheet's rule).
 */
export type ScoreRule = 'cleared' | 'inbox';

export interface SectionDef {
  key: SectionKey;
  title: string;
  /** Tab label. */
  tab: string;
  kind: SectionKind;
  /** The day columns, in order. */
  days: readonly Weekday[];
  score?: ScoreRule;
  /**
   * The default goal: the sheet's, or Carla's own (2026-10-07: PM Buckets, Outcomes). A manager can
   * override the number (accounting_scoreboard_sections.goal) and reset it to this.
   */
  goal?: GoalRule;
  /**
   * A section with no default goal: what a goal is judged on once a manager sets one in Setup (Carla,
   * 2026-10-07: "a button to set a goal for those without one"). Never set together with `goal`.
   */
  goalShape?: GoalShape;
  /** What one row is, singular ("bucket", "rep"). */
  rowNoun: string;
  /** One line telling people what to type. */
  help: string;
  /**
   * Shown inside another section's tab (no tab or menu entry of its own) while that section is on.
   * Chargeback Outcomes sits under Open Disputes on the Chargebacks tab. It keeps an Overview card.
   */
  hostTab?: SectionKey;
}

/** Tab order. */
export const SECTIONS: readonly SectionDef[] = [
  {
    key: 'buckets',
    title: 'Accounting Buckets',
    tab: 'Buckets',
    kind: 'am_pm',
    days: MON_FRI,
    score: 'cleared',
    goal: { value: 8, direction: 'at_least', measure: 'score', unit: 'score' },
    rowNoun: 'bucket',
    help: 'Items in the bucket at the start (AM) and end (PM) of each day. Score = 10 × completed ÷ (completed + open).',
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
    // Carla, 2026-10-07: "Goal is less than 30 avg in the buckets weekly". The headline is the Σ of the
    // PMs' daily averages (24.6 and 28.5 on the weeks of 09-27 and 10-04), an average: never paced.
    goal: { value: 30, direction: 'below', measure: 'average', unit: 'avg' },
    rowNoun: 'PM',
    help: "Items waiting in each PM's bucket that day, and whether you met with them.",
  },
  {
    key: 'onboarding',
    // Carla, 2026-10-07: this section is "Sales - Payments" (its live lines are Scheduled and Urgent);
    // "Sales - Projects Onboarded" is a custom section shown in this tab. It was "Customer Sales
    // Onboarding" (the sheet's name; the weeks before 2026-10-01 hold its per-closer counts).
    title: 'Sales — Payments',
    tab: 'Sales Onboarding',
    kind: 'daily',
    days: MON_FRI,
    goalShape: { direction: 'at_least', measure: 'team_week', unit: 'payments' },
    rowNoun: 'line',
    help: 'Sales payments each day, one number per line.',
  },
  {
    key: 'inbox',
    title: 'Email Inbox',
    tab: 'Inbox',
    kind: 'am_pm',
    days: MON_FRI,
    score: 'inbox',
    goal: { value: 9, direction: 'at_least', measure: 'score', unit: 'score' },
    rowNoun: 'inbox',
    help: 'How many emails are in the inbox at the start of the day (AM) and at the end (PM).',
  },
  {
    key: 'chargebacks',
    title: 'Open Disputes',
    tab: 'Chargebacks',
    kind: 'am_pm',
    days: MON_FRI,
    // Carla, 2026-10-07: "productivity formula same as the regular buckets". The "due in 7 days" line
    // is part of open, so it is called out and never scored or added (scoring.ts).
    score: 'cleared',
    goalShape: { direction: 'at_least', measure: 'score', unit: 'score' },
    rowNoun: 'line',
    help: 'Open disputes at the start (AM) and end (PM) of the day, scored like Buckets: 10 × completed ÷ (completed + open). The "due in 7 days" line is called out, not scored.',
  },
  {
    key: 'chargeback_outcomes',
    title: 'Outcomes',
    tab: 'Chargebacks',
    // Carla, 2026-10-02: per outcome, per day, the dollar amount and the number of chargebacks
    // ("one dispute won for $99 → Wins: $99 / 1").
    kind: 'amount_count',
    days: MON_FRI,
    // Carla, 2026-10-07: "a win ratio of 50% or higher each week". Wins ÷ (wins + losses), by count; a
    // line counts as a win or a loss by its row flag (rows.outcome), never by its label.
    goal: { value: 50, direction: 'at_least', measure: 'ratio', unit: '%' },
    rowNoun: 'outcome',
    help: 'Pre-arb, wins and losses each day: the dollar amount and how many chargebacks. Win ratio = wins ÷ (wins + losses), by count.',
    hostTab: 'chargebacks',
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
    goalShape: { direction: 'at_least', measure: 'team_week', unit: 'reviewed' },
    rowNoun: 'rating',
    help: 'Cancellation call recordings reviewed that day, by rating.',
  },
  {
    key: 'payroll_timing',
    title: 'Payroll Scoreboard — Timing',
    tab: 'Payroll Timing',
    // Kane, 2026-10-01 (Carla's sheet): one row per pay CYCLE, started by Tuesday noon and closed by
    // Friday noon, filled from HRIS's own Start Processing and Close Pay Cycle. Replaced the same
    // day's per-person start/end times (kind `time_span`, goal "< 20 hours").
    kind: 'payroll_cycle',
    days: ['tue', 'fri'],
    goal: { value: 100, direction: 'at_least', measure: 'cycle_score', unit: '%' },
    rowNoun: 'cycle',
    help: "Filled from HRIS: the Payroll Wizard's first Start Processing on each week's pay cycle, and Close Pay Cycle in Payment Dispatch.",
  },
  {
    key: 'payroll_problems',
    title: 'Payroll Scoreboard — Problems',
    tab: 'Payroll Problems',
    // Carla, 2026-10-02: a Problem Type on every problem logged. A daily count grid until 2026-10-06.
    kind: 'problem_log',
    days: MON_FRI,
    goal: { value: 20, direction: 'below', measure: 'team_week', unit: 'problems' },
    rowNoun: 'person',
    help: "Log each payroll problem with its type. Each person's day adds up from the log.",
  },
];

const BY_KEY = new Map<SectionKey, SectionDef>(SECTIONS.map((s) => [s.key, s]));

export function isSectionKey(value: unknown): value is SectionKey {
  return typeof value === 'string' && BY_KEY.has(value as SectionKey);
}

export function isRowSectionKey(value: unknown): value is RowSectionKey {
  return value === 'custom' || isSectionKey(value);
}

export function sectionDef(key: SectionKey): SectionDef {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`Unknown scoreboard section: ${key}`);
  return def;
}

export function slotsFor(key: SectionKey): readonly Slot[] {
  return SLOTS_BY_KIND[sectionDef(key).kind];
}

/** What a built-in section's goal is judged on: its default goal's shape, or the one a manager can set. */
export function goalShapeOf(def: Pick<SectionDef, 'goal' | 'goalShape'>): GoalShape | undefined {
  if (def.goal) {
    const { direction, measure, unit } = def.goal;
    return { direction, measure, unit };
  }
  return def.goalShape;
}

/** A manager's stored switch for one section (accounting_scoreboard_sections). */
export interface SectionSetting {
  sectionKey: SectionKey;
  enabled: boolean;
  goal: number | null;
}

export interface ResolvedSection extends SectionDef {
  enabled: boolean;
  /**
   * The goal in force: the manager's number, else the default. A section with no default (a `goalShape`)
   * has a goal only once a manager sets one. Absent = no goal.
   */
  goal?: GoalRule;
}

/** Every section in tab order, with the stored switches applied. A missing setting = on, default goal. */
export function resolveSections(settings: readonly SectionSetting[]): ResolvedSection[] {
  const byKey = new Map(settings.map((s) => [s.sectionKey, s]));
  return SECTIONS.map((def) => {
    const s = byKey.get(def.key);
    const shape = goalShapeOf(def);
    const set = s && s.goal !== null && Number.isFinite(s.goal) ? s.goal : null;
    const goal: GoalRule | undefined = shape && set !== null ? { ...shape, value: set } : def.goal;
    return { ...def, enabled: s ? s.enabled : true, goal };
  });
}

// ---------------------------------------------------------------------------
// Custom sections
// ---------------------------------------------------------------------------

/** The two shapes a manager can give a custom section (the SQL CHECK acct_sb_custom_kind_valid). */
export const CUSTOM_KINDS = ['daily', 'am_pm'] as const;
export type CustomKind = (typeof CUSTOM_KINDS)[number];

export const CUSTOM_KIND_LABEL: Record<CustomKind, string> = {
  daily: 'One number a day',
  am_pm: 'Start and end of day, scored like Buckets',
};

/**
 * The built-in sections a custom section may be shown inside (Carla, 2026-10-07: "Sales - Projects
 * Onboarded" on the Sales Onboarding tab). Every built-in that has a tab of its own, so not one that
 * is itself shown inside another (Outcomes). The SQL CHECK acct_sb_custom_host_valid lists the same
 * keys (pinned in sections.test.ts).
 */
export const HOST_SECTION_KEYS = SECTIONS.filter((s) => s.hostTab === undefined).map((s) => s.key);

export function isHostSectionKey(value: unknown): value is SectionKey {
  return isSectionKey(value) && HOST_SECTION_KEYS.includes(value);
}

/** A row of accounting_scoreboard_custom_sections, as the board reads it. */
export interface CustomSection {
  id: string;
  title: string;
  kind: CustomKind;
  /** Null = no goal. Always set together with goalDirection. */
  goal: number | null;
  goalDirection: GoalDirection | null;
  enabled: boolean;
  sortOrder: number;
  /** The built-in tab it is shown inside; null = a tab of its own. */
  hostSectionKey: SectionKey | null;
}

/**
 * A section as the page renders it: a built-in section, or a custom one. `id` is unique on the
 * board (the built-in key, or `custom:<uuid>`); tabs, React keys and row lookups use it.
 */
export interface BoardSection extends Omit<ResolvedSection, 'key'> {
  id: string;
  key: RowSectionKey;
  /** Set on a custom section only. */
  customId: string | null;
}

export function customSectionId(customId: string): string {
  return `custom:${customId}`;
}

/** The board id of the section a row belongs to. */
export function rowSectionId(row: { sectionKey: RowSectionKey; customSectionId: string | null }): string {
  return row.sectionKey === 'custom' && row.customSectionId ? customSectionId(row.customSectionId) : row.sectionKey;
}

export function builtInBoardSection(s: ResolvedSection): BoardSection {
  return { ...s, id: s.key, customId: null };
}

export function customBoardSection(c: CustomSection): BoardSection {
  const goal: GoalRule | undefined =
    c.goal === null || c.goalDirection === null
      ? undefined
      : c.kind === 'am_pm'
        ? { value: c.goal, direction: 'at_least', measure: 'score', unit: 'score' }
        : { value: c.goal, direction: c.goalDirection, measure: 'team_week', unit: 'total' };
  return {
    id: customSectionId(c.id),
    key: 'custom',
    customId: c.id,
    title: c.title,
    tab: c.title,
    kind: c.kind,
    days: MON_FRI,
    score: c.kind === 'am_pm' ? 'cleared' : undefined,
    goal,
    rowNoun: 'line',
    help:
      c.kind === 'am_pm'
        ? 'A reading at the start (AM) and end (PM) of each day. Score = 10 × completed ÷ (completed + open).'
        : 'One number a day for each line.',
    enabled: c.enabled,
    hostTab: c.hostSectionKey ?? undefined,
  };
}

/** How Setup names a section: a hosted one says whose tab it sits in ("Chargebacks — Outcomes"). */
export function sectionLabel(s: Pick<BoardSection, 'title' | 'hostTab'>): string {
  return s.hostTab ? `${sectionDef(s.hostTab).tab} — ${s.title}` : s.title;
}

/**
 * Built-in sections in tab order, then the custom sections in their own order: lowest sort order first,
 * and a new one is given one below the lowest, so the newest is first (Kane, 2026-10-06).
 */
export function boardSections(settings: readonly SectionSetting[], custom: readonly CustomSection[]): BoardSection[] {
  return [
    ...resolveSections(settings).map(builtInBoardSection),
    ...[...custom].sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title)).map(customBoardSection),
  ];
}

/**
 * The sections that get a tab of their own: every enabled one, except a hosted section whose host
 * is on (Chargeback Outcomes shows inside Chargebacks). If the host is switched off, the hosted
 * section takes a tab of its own, so it never disappears silently.
 */
export function tabSections(sections: readonly BoardSection[]): BoardSection[] {
  const on = new Set(sections.filter((s) => s.enabled).map((s) => s.id));
  return sections.filter((s) => s.enabled && !(s.hostTab && on.has(s.hostTab)));
}

/**
 * The enabled sections shown inside `host`'s tab, under the host: the built-in ones first (Outcomes),
 * then the custom ones, newest first (the board order).
 */
export function hostedSections(sections: readonly BoardSection[], host: BoardSection): BoardSection[] {
  return sections.filter((s) => s.enabled && s.hostTab !== undefined && s.hostTab === host.id);
}

/**
 * The Overview's cards: one per tab, each followed by the sections shown inside it. A section shown
 * inside another tab has its own number and goal (a custom section's total or score; Outcomes' win
 * ratio since 2026-10-07), so where its grid sits never takes its card away.
 */
export function overviewSections(sections: readonly BoardSection[]): BoardSection[] {
  return tabSections(sections).flatMap((t) => [t, ...hostedSections(sections, t)]);
}

/** The tab a section's grid is on: its own, or its host's while it sits inside the host's tab. */
export function tabIdFor(sections: readonly BoardSection[], section: BoardSection): string {
  const tabs = tabSections(sections);
  if (tabs.some((t) => t.id === section.id)) return section.id;
  return tabs.find((t) => t.id === section.hostTab)?.id ?? section.id;
}
