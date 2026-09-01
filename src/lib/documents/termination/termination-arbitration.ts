/** [TERMINATION-DOCS]
 * The PURE half of the termination resolvers: given rows, decide the verdict.
 *
 * Split out of `termination-search.ts` and `termination-facts.ts` because both
 * of those open with `import 'server-only'`, and a `server-only` module cannot
 * be imported by `npm test` (`node --import tsx --test`) — the specifier does
 * not resolve outside a React Server Components graph. This is the shipped
 * precedent: `src/lib/payroll/readiness-score.ts` is the pure scoring half of
 * `payroll-readiness.ts` for exactly this reason.
 *
 * NO `server-only`, NO Supabase, NO Node builtin, NO I/O. Every refusal and
 * every printed fact is decided here, from injected rows, so the guards are
 * unit tests rather than a mocked client.
 *
 * ═══ THE G3 RULE — four independent tests, T1 reads → T2 record → T3 re-hire →
 * T4 hours, with the three timesheet states spelled out and the argument for why
 * an absent hours signal is not a fail-open — is written in full in
 * {@link arbitrateTerminationFacts}'s docstring, below. READ IT BEFORE CHANGING
 * AN ARM: two earlier shapes were wrong and both looked reasonable. ═══
 *
 * DATE ORDER IS LOAD-BEARING throughout:
 * `sanitizeOffboardDay(normalizeMasterDate(raw))`, in that order.
 * `sanitizeOffboardDay` only accepts an ISO-prefixed string
 * (offboard-date-sanity.ts:28-31), so a sheet's `5/4/2026` reversed would
 * silently become UNDATED; and `normalizeMasterDate` parses `M/D/YYYY` BY PARTS
 * because Node's `new Date('5/4/2026')` is locale-dependent and can read as
 * April 5. A null result is a BLANK the rep fills, NEVER a printed guess.
 *
 * THAT ORDER IS NECESSARY BUT NOT SUFFICIENT (G5). `normalizeMasterDate`'s last
 * resort is `new Date(s)` (master-date.ts:46), which FABRICATES the parts the
 * cell never stated: `"August 2026"` becomes 2026-08-01, `"Aug-24"` becomes
 * 2001-08-24, `"2024?"` becomes 2024-01-01, `"0"` becomes 2000-01-01. Each
 * result is a well-formed PAST day, so `sanitizeOffboardDay` cannot see the
 * invention, and the fabricated day would print as a precise calendar date on a
 * signed letter that the rep could not correct (a non-null fact is not a blank,
 * so the route refuses to accept a hand-typed replacement for it). `new Date`
 * also ROLLS an impossible day forward instead of refusing: `"Feb 30 2026"`
 * becomes March 2, `"2/29/2025"` becomes March 1, and `"2026-02-31"` survives
 * the shape regex outright. So every date this module accepts additionally goes
 * through {@link explicitMasterDay}: the RAW cell must independently state a
 * year, a month AND a day, and the result must round-trip as a real calendar
 * day. Anything else is a BLANK with `date_failed_sanity` — a question to the
 * rep, never a guess on the page. `master-date.ts` itself is deliberately NOT
 * changed: its callers (payroll readiness, the catalog off-board filter) treat
 * a null as "keep the person", and tightening it there would age people off
 * lists.
 */

import { normEmail } from '@/lib/email/norm-email';
import { normalizeMasterDate } from '@/lib/roster/master-date';
import { sanitizeOffboardDay } from '@/lib/roster/offboard-date-sanity';
import { parseNameParts } from '@/lib/name/name-parts';
import { formatCoeStartDate } from '@/lib/documents/coe-facts';
import { offboardReasonLabel } from '@/lib/hr/offboard-reasons';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import type {
  TerminationAmbiguousCandidate,
  TerminationBlankField,
  TerminationBlankReason,
  TerminationBlockedReason,
  TerminationDepartureReason,
  TerminationFacts,
  TerminationIdentity,
  TerminationRate,
  TerminationSearchCandidate,
} from './types';
import { reasonKey, TERMINATION_DEPARTURE_REASON_SET } from './reason-key';
import type { TerminationCycleHoursSignal } from './termination-cycle-hours';

// ─── Shared row shapes ───────────────────────────────────────────────────────

/** One `global_master_list` row, reduced to what arbitration needs. */
export interface TerminationMasterRow {
  id: string | null;
  name: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  alternateWorkEmail: string | null;
  alternateWorkEmail2: string | null;
  departmentRaw: string | null;
  startDateRaw: string | null;
  offBoardedAtRaw: string | null;
  offBoardedReason: string | null;
  /** Raw `last_seen_upload_id`, compared as a STRING against the current upload
   *  id (recently-offboarded.ts:320 does the same). */
  uploadId: string | null;
  /** Numeric `last_seen_upload_id`; 0 when unparseable (payroll-readiness.ts:794). */
  uploadSeq: number;
}

/** One `offboarded_sheet` row carrying this work email. */
export interface TerminationSheetRow {
  offBoardedAtRaw: string | null;
  offBoardedReason: string | null;
}

/** What `resolveTerminationRates` needs. Structurally identical to that
 *  module's `TerminationRatesArgs`; declared here so this pure module never
 *  imports a `server-only` one, not even for a type. */
export interface TerminationRateContext {
  workEmail: string;
  /**
   * WORK addresses only — this work email plus the winning master row's
   * `"Alternate Work Email"` / `"Alternate Work Email 2"`. There is NO field on
   * this type that can carry a personal address, and that is the point (G1).
   *
   * The field is named `workAliases`, not `aliases`, because the previous name
   * invited the personal email in and it got there: the rate resolver queried
   * `hr_pending_employees` on every alias and printed the row it found as the
   * STARTING RATE, so `carlath@simple.biz`'s letter could state the hire rate of
   * the ACTIVE `carla@simple.biz` — one gmail
   * (`carlathomas0112@gmail.com`) backs both master identities
   * (offboard-evidence.ts:41-48). An alternate work address is one human by
   * ruling (docs/features/identity-resolution.md); a personal inbox demonstrably
   * is not. `TerminationIdentity.personalEmail` keeps the personal address for
   * the log row and for SEARCH, where nothing prints it.
   *
   * {@link workAliasesForRateContext} builds this, and it additionally drops any
   * address that appears in ANY master row's `Personal Email` column — an
   * alternate-work cell holding someone's gmail is a data-entry shape, not a
   * licence to price a signed letter off it.
   */
  workAliases: string[];
  departmentRaw: string | null;
  offDate: string | null;
}

// ─── Dates: an explicit full calendar day, or a BLANK ─────────────────────────

/** `YYYY-MM-DD`, exactly — no prefix match, no time part. */
const DAY_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Cells that state year, month AND day by SHAPE alone. */
const ISO_DAY_PREFIX = /^\d{4}-\d{2}-\d{2}/;
const SHEET_MDY = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

/**
 * True when `day` names a day that actually exists in the calendar.
 *
 * The shape regex is not enough: `2026-02-31`, `2026-04-31` and `2026-13-05` all
 * satisfy `^\d{4}-\d{2}-\d{2}$`, are legal `sanitizeOffboardDay` input, and then
 * either ROLL FORWARD when rendered (`formatCoeStartDate('2026-02-31')` prints
 * March 2) or blow up as an opaque `date/time field value out of range` on the
 * `date` column AFTER the storage object was uploaded. Both are refusals here.
 */
export function isRealCalendarDay(day: string | null | undefined): boolean {
  const m = DAY_PARTS.exec((day ?? '').trim());
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const dayOfMonth = Number(m[3]);
  // Local midnight, then read the parts back. `new Date(2026, 1, 31)` does not
  // reject the 31st of February, it silently becomes March 2 — so the round-trip
  // is the check.
  const probe = new Date(year, month - 1, dayOfMonth);
  return (
    probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === dayOfMonth
  );
}

/**
 * True when the RAW cell independently states a year, a month AND a day.
 *
 * `normalizeMasterDate` falls back to `new Date(s)` (master-date.ts:46), which
 * invents whichever parts the cell omitted — a missing year becomes 2001, a
 * missing day-of-month becomes the 1st — and the invented result is a
 * well-formed past day that no later sanitizer can distinguish from a real one.
 * The two recognised shapes state all three parts by construction; everything
 * else must PROVE them, which is what the digit runs do:
 *
 *   "Aug-24"       → 2001-08-24 → no run equals 2001            → refused
 *   "August 2024"  → 2024-08-01 → no 1-2 digit run equals 1     → refused
 *   "2024?"        → 2024-01-01 → same                          → refused
 *   "0"            → 2000-01-01 → no run equals 2000            → refused
 *   "Feb 30 2026"  → 2026-03-02 → no 1-2 digit run equals 2     → refused
 *                                 (the roll-over cannot hide behind the year)
 *   "July 20, 2026"→ 2026-07-20 → 2026 and 20 are both stated   → accepted
 */
function statesWholeDay(raw: string, day: string): boolean {
  if (ISO_DAY_PREFIX.test(raw) || SHEET_MDY.test(raw)) return true;
  const m = DAY_PARTS.exec(day);
  if (!m) return false;
  const runs: string[] = raw.match(/\d+/g) ?? [];
  const yearStated = runs.includes(m[1]);
  // A 3+ digit run is a year, never a day-of-month.
  const dayStated = runs.some((r) => r.length <= 2 && Number(r) === Number(m[3]));
  return yearStated && dayStated;
}

/**
 * The ONLY way a master date cell becomes a printed fact in this feature:
 * `sanitizeOffboardDay(normalizeMasterDate(raw))` — in that order, the contract's
 * G5 — plus the two positive checks the file header explains. A null is a BLANK
 * the rep is asked to fill, never a guess on a signed page.
 */
export function explicitMasterDay(raw: string | null | undefined, now: Date): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const normalized = normalizeMasterDate(s);
  if (!normalized) return null;
  if (!isRealCalendarDay(normalized)) return null;
  if (!statesWholeDay(s, normalized)) return null;
  return sanitizeOffboardDay(normalized, now);
}

/**
 * The rate-lookup alias set: WORK addresses only (G1).
 *
 * The work email always survives — it is the identity. An alternate work address
 * joins it because it is the same human. Anything that appears in a
 * `Personal Email` cell on ANY of this person's master rows is dropped, because
 * one personal inbox backs several master identities and a rate keyed on it can
 * belong to the other person behind it.
 */
export function workAliasesForRateContext(
  workEmail: string,
  rows: TerminationMasterRow[],
): string[] {
  const personal = new Set<string>();
  for (const r of rows) {
    const p = normEmail(r.personalEmail);
    if (p) personal.add(p);
  }
  const out: string[] = [];
  const add = (value: string | null): void => {
    const e = normEmail(value);
    if (!e || out.includes(e)) return;
    if (e !== workEmail && personal.has(e)) return;
    out.push(e);
  };
  add(workEmail);
  for (const r of rows) {
    add(r.alternateWorkEmail);
    add(r.alternateWorkEmail2);
  }
  return out;
}

function trimOrNull(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s ? s : null;
}

/** Distinct non-empty values of one field across a set of rows. Two rows that
 *  BOTH state a value and disagree is a real disagreement; a row that states
 *  nothing is not one, it is a duplicate. */
function distinctValues(values: Array<string | null>): string[] {
  const seen = new Set<string>();
  for (const v of values) {
    const s = trimOrNull(v);
    if (s) seen.add(s);
  }
  return [...seen];
}

// ─── Search: union the candidate set ─────────────────────────────────────────

/** Which table described a candidate. Higher wins the identity fields when two
 *  sources disagree; `global_master_list` is the roster of record. */
const SOURCE_RANK = { master: 2, sheet: 1, queue: 0 } as const;
export type TerminationObservationSource = keyof typeof SOURCE_RANK;

/** One row, from any of the three tables, reduced to what the union needs. */
export interface TerminationCandidateObservation {
  source: TerminationObservationSource;
  matchedColumn: TerminationSearchCandidate['matchedColumn'];
  /** Normalized. null means this row cannot BE an identity — it gets its own
   *  bucket and carries `no_master`, because merging it would invent one. */
  workEmail: string | null;
  personalEmail: string | null;
  name: string | null;
  departmentRaw: string | null;
  /** Raw date cell; sanitized here, never before. */
  rawOffDate: string | null;
  rawReason: string | null;
  /** `last_seen_upload_id === master_list_uploads.id where is_current`. */
  onCurrentUpload: boolean;
  /** Numeric `last_seen_upload_id`; 0 for the two non-master tables. */
  uploadSeq: number;
}

export interface TerminationCandidateInput {
  observations: TerminationCandidateObservation[];
  /** `fetchGmlStatusMap()`'s map. Its polarity is load-bearing: if ANY master
   *  row carrying an email is UNSTAMPED, that email is ACTIVE (G3). */
  gmlStatus: Map<string, { active: boolean }>;
  /** When the status map read failed, absence proves nothing: no candidate is
   *  stamped `no_master` on that basis, and — because the active check could not
   *  run at all — every candidate is stamped `evidence_read_failed` instead of
   *  rendering as issuable. */
  gmlStatusError: string | null;
  /** Injected clock for `sanitizeOffboardDay`. */
  now?: Date;
}

interface Bucket {
  workEmail: string | null;
  personalEmail: string | null;
  name: string | null;
  departmentRaw: string | null;
  /** Sanitized `YYYY-MM-DD`; the LATEST across every source that named this key. */
  offDate: string | null;
  /** The reason carried by the record that supplied {@link offDate}. */
  rawReason: string | null;
  matchedColumn: TerminationSearchCandidate['matchedColumn'];
  /** Rank of the source that currently owns the identity fields. */
  rank: readonly [number, number, number];
}

/** Identity-field precedence: on the current upload beats any other row, then
 *  the source table, then the upload sequence. Mirrors the PROMOTION rule at
 *  src/lib/roster/recently-offboarded.ts:497-520 — a retired row must never
 *  describe someone the sheet still carries differently. */
function outranks(
  next: readonly [number, number, number],
  cur: readonly [number, number, number],
): boolean {
  if (next[0] !== cur[0]) return next[0] > cur[0];
  if (next[1] !== cur[1]) return next[1] > cur[1];
  return next[2] > cur[2];
}

/**
 * Union the observations into one candidate per WORK email and stamp each with
 * the refusal `resolveTerminationFacts` will hit, in that resolver's order —
 * no_master, evidence_read_failed, still_active, temporary_pause,
 * not_a_departure — so a greyed row states the real reason instead of a generic
 * "unavailable".
 *
 * This list is ADVISORY and deliberately conservative in one direction only: it
 * has no timesheet, so where a departure IS recorded it leaves the active
 * question to `resolveTerminationFacts`, which does. It never invents a refusal
 * the resolver would not make, and it never hides one the resolver makes for a
 * reason this data can see.
 *
 * A personal email is never a bucket key. One inbox backs several master
 * identities (`carla@` / `carlath@` via `carlathomas0112@gmail.com`,
 * offboard-evidence.ts:41-48), and collapsing them would offer a termination
 * letter for a working employee.
 */
export function buildTerminationCandidates(
  input: TerminationCandidateInput,
): TerminationSearchCandidate[] {
  const now = input.now ?? new Date();
  const buckets = new Map<string, Bucket>();
  let anonSeq = 0;

  for (const o of input.observations) {
    const key = o.workEmail ?? ` no-work-email:${o.source}:${anonSeq++}`;
    const rank = [o.onCurrentUpload ? 1 : 0, SOURCE_RANK[o.source], o.uploadSeq] as const;
    // Same gate the facts sheet uses, so the list can never show a candidate an
    // off-date the letter would refuse to print (G5).
    const offDate = explicitMasterDay(o.rawOffDate, now);

    const cur = buckets.get(key);
    if (!cur) {
      buckets.set(key, {
        workEmail: o.workEmail,
        personalEmail: o.personalEmail,
        name: o.name,
        departmentRaw: o.departmentRaw,
        offDate,
        rawReason: o.rawReason,
        matchedColumn: o.matchedColumn,
        rank,
      });
      continue;
    }

    // Latest departure date wins, and the reason rides along with it — the same
    // rule loadOffboardEvidenceByEmail applies (offboard-evidence.ts:86-94).
    if (offDate && (!cur.offDate || offDate > cur.offDate)) {
      cur.offDate = offDate;
      cur.rawReason = o.rawReason;
    } else if (!cur.rawReason) {
      cur.rawReason = o.rawReason;
    }

    if (outranks(rank, cur.rank)) {
      cur.rank = rank;
      cur.matchedColumn = o.matchedColumn;
      if (o.name) cur.name = o.name;
      if (o.departmentRaw) cur.departmentRaw = o.departmentRaw;
      if (o.personalEmail) cur.personalEmail = o.personalEmail;
    } else {
      cur.name = cur.name ?? o.name;
      cur.departmentRaw = cur.departmentRaw ?? o.departmentRaw;
      cur.personalEmail = cur.personalEmail ?? o.personalEmail;
    }
  }

  const candidates: TerminationSearchCandidate[] = [];
  for (const b of buckets.values()) {
    const known = b.workEmail ? input.gmlStatus.get(b.workEmail) : undefined;
    const active = known?.active === true;
    const k = reasonKey(b.rawReason);

    // A departure RECORD exists for this bucket when some source stamped a date
    // or a reason on it. Both halves count: a stamp whose date failed sanity
    // still proves someone recorded a departure.
    const hasDepartureRecord = !!b.offDate || !!b.rawReason;

    let blockedCode: TerminationBlockedReason['code'] | null = null;
    if (!b.workEmail) {
      blockedCode = 'no_master';
    } else if (input.gmlStatusError) {
      // FAIL CLOSED. Without the status map nothing here knows whether this
      // person is working, and `active: false` by absence is exactly how a
      // broken read used to render every candidate as issuable.
      blockedCode = 'evidence_read_failed';
    } else if (!known) {
      // The status map indexes every email column of every master row, so an
      // absent entry means no `global_master_list` row carries this address.
      blockedCode = 'no_master';
    } else if (active && !hasDepartureRecord) {
      // NOT `active` alone. An unstamped duplicate row is the NORMAL shape of a
      // recent leaver — HR keeps them on the master sheet through final pay and
      // the off-board stamp lands on another row (measured 2026-08-21: 1,287
      // active rows, ZERO carrying off_boarded_at, while 294 of those people ARE
      // offboarded, offboard-evidence.ts:8-11) — so refusing on it greys out a
      // large share of this tab's real subjects. Where a departure IS recorded,
      // the authoritative call belongs to `resolveTerminationFacts`, which reads
      // the cycle timesheet this list has not got.
      blockedCode = 'still_active';
    } else if (k === 'temporary_pause') {
      blockedCode = 'temporary_pause';
    } else if (k !== null && !TERMINATION_DEPARTURE_REASON_SET.has(k)) {
      blockedCode = 'not_a_departure';
    }

    candidates.push({
      workEmail: b.workEmail,
      personalEmail: b.personalEmail,
      name: b.name,
      // formatDeptLabel is the only thing that may reach a human: the raw cell
      // can be `hsl:intake_specialist`.
      departmentLabel: b.departmentRaw ? formatDeptLabel(b.departmentRaw) || null : null,
      offDate: b.offDate,
      rawReason: b.rawReason,
      reasonLabel: b.rawReason ? offboardReasonLabel(k ?? b.rawReason) : null,
      matchedColumn: b.matchedColumn,
      active,
      blockedCode,
    });
  }

  // Newest departure first; undated candidates last, then alphabetical so the
  // list is stable across reads.
  candidates.sort((a, z) => {
    if (a.offDate !== z.offDate) {
      if (!a.offDate) return 1;
      if (!z.offDate) return -1;
      return z.offDate.localeCompare(a.offDate);
    }
    if (a.workEmail === z.workEmail) return 0;
    if (!a.workEmail) return 1;
    if (!z.workEmail) return -1;
    return a.workEmail.localeCompare(z.workEmail);
  });

  return candidates;
}

// ─── Facts: the refusal ladder ───────────────────────────────────────────────

export interface TerminationArbitrationInput {
  /** THE identity. Lower-cased work email. */
  workEmail: string;
  /** EVERY master row carrying this work email — stamped and unstamped alike.
   *  There is deliberately NO `off_boarded_at` filter upstream. */
  masterRows: TerminationMasterRow[];
  /** `master_list_uploads.id where is_current`, or null when it cannot be
   *  resolved (then no row is promoted for being "current"). */
  currentUploadId: string | null;
  /** `fetchGmlStatusMap()`'s verdict: true when at least one master row carrying
   *  this email — in ANY of its four email columns, on ANY upload — is
   *  UNSTAMPED. Corroborates the master rows below; it is never the whole of the
   *  G3 decision, because the map keys the shared PERSONAL column too, so
   *  someone else's live row can raise this flag for a genuine leaver. */
  gmlActive: boolean;
  /** `fetchGmlStatusMap()`'s error, verbatim. Non-null means the active check
   *  COULD NOT RUN, which is a hard `evidence_read_failed` block (T1): "not
   *  active" by absence is the one reading a failed read may never get. */
  gmlStatusError: string | null;
  /** The `global_master_list` identity read's error, verbatim. Non-null means
   *  the row set below is not the row set — `no_master` and every count taken
   *  off it would be a statement about a read that failed (T1). */
  masterReadError: string | null;
  /** This feature's OWN departure-evidence read
   *  (`loadTerminationDepartureEvidence`), verbatim. The shared
   *  `loadOffboardEvidenceByEmail` cannot report this: all three of its source
   *  reads end in `.catch(() => {})` and it returns a bare Map (T1). */
  evidenceReadError: string | null;
  /**
   * The current cycle's Hubstaff timesheet — a REFUSAL-ONLY signal, in three
   * explicitly distinguished states (T4, `./termination-cycle-hours`):
   *
   *   · `unreadable`  → BLOCK. An absolute refusal may never rest on a read that
   *                     did not happen.
   *   · `unavailable` → the index read fine and is EMPTY OVERALL. NOT "nobody
   *                     worked": the signal is absent, it is recorded on
   *                     `degraded`, and T2 + T3 carry the decision.
   *   · `ready`       → a real signal. A HIT refuses; a MISS is information.
   *
   * `worked` is structurally unreachable on the first two states, which is what
   * stops an empty index reading as a confident `false`.
   */
  cycleHours: TerminationCycleHoursSignal;
  /** The latest departure record across master + `offboarded_sheet` +
   *  `offboarding_queue`, WORK-keyed and normalized but NOT sanitized (franm@'s
   *  hand-typed 2027-04-20 must arrive so it can be refused). */
  evidence: { offDate: string; reason: string | null } | null;
  /** `offboarded_sheet` rows for this work email — the cross-check that tells
   *  "no departure" apart from "the evidence read broke". */
  sheetRows: TerminationSheetRow[];
  /** True when a NON-fatal read reported an error (the current-upload lookup,
   *  say). The four reads that must succeed have their own fields above. */
  readsDegraded: boolean;
  /** Non-fatal notes to carry onto the facts sheet. */
  degraded: string[];
  /** Injected clock for `sanitizeOffboardDay`. */
  now?: Date;
}

export type TerminationArbitration =
  | { blocked: TerminationBlockedReason; facts: null; rateContext: null; blankReasons: null }
  | {
      blocked: null;
      facts: TerminationFacts;
      rateContext: TerminationRateContext;
      /** WHY each non-rate blank is blank. `TerminationFacts` carries a
       *  `blankReason` only on its two rates, so the date / reason / department
       *  provenance lives here — the panel has to tell "nothing on file" apart
       *  from "the date on file was impossible" (franm@'s 2027-04-20). */
      blankReasons: Partial<Record<TerminationBlankField, TerminationBlankReason>>;
    };

/** Every departure stamp this person carries, from whichever table held it. */
interface DepartureRecord {
  source: TerminationIdentity['offDateSource'];
  /** Sanitized `YYYY-MM-DD`, or null when the raw value failed sanity. */
  day: string | null;
  reason: string | null;
}

/** Tie-break when two sources stamp the same day: the roster of record wins. */
const SOURCE_PRECEDENCE: Record<TerminationIdentity['offDateSource'], number> = {
  global_master_list: 2,
  offboarded_sheet: 1,
  offboarding_queue: 0,
};

/**
 * Which facts arrived empty. The panel renders one input per entry, and the
 * route rejects a `filled` key that is not in this list.
 */
export function computeTerminationBlanks(facts: TerminationFacts): TerminationBlankField[] {
  const blanks: TerminationBlankField[] = [];
  if (!facts.terminationDate) blanks.push('termination_date');
  if (!facts.reasonKey) blanks.push('reason');
  if (!facts.endingDepartmentLabel) blanks.push('ending_department');
  if (!facts.startDate) blanks.push('start_date');
  if (facts.startingRate.amount == null) blanks.push('starting_rate');
  if (facts.endingRate.amount == null) blanks.push('ending_rate');
  return blanks;
}

/** Merge resolved rates onto an arbitrated facts sheet and recompute `blanks`. */
export function applyTerminationRates(
  facts: TerminationFacts,
  rates: { starting: TerminationRate; ending: TerminationRate; degraded: string[] },
): TerminationFacts {
  const next: TerminationFacts = {
    ...facts,
    startingRate: rates.starting,
    endingRate: rates.ending,
    degraded: [...facts.degraded, ...rates.degraded],
  };
  next.blanks = computeTerminationBlanks(next);
  return next;
}

function blocked(reason: TerminationBlockedReason): TerminationArbitration {
  return { blocked: reason, facts: null, rateContext: null, blankReasons: null };
}

/**
 * The whole refusal ladder and every printed fact, with no I/O.
 *
 * ═══ THE SETTLED RULE (round 3, the lead's ruling). Read this before changing
 * an arm — two earlier shapes were wrong and both looked reasonable. ═══
 *
 * THE INSIGHT THAT SETTLES IT: cycle hours are used ONLY to REFUSE. A positive
 * hours hit blocks a document; an absent or unreadable hours signal must
 * therefore NEVER, on its own, PERMIT one. So an unavailable hours signal is not
 * a fail-open PROVIDED some other guard catches the case hours was there to
 * catch — and the case it was there to catch is a RE-HIRE: someone with an old
 * departure record who is working again. `reengaged_after_departure` (T3) is
 * that guard, and it needs no timesheet at all.
 *
 * FOUR INDEPENDENT TESTS, in this order. Reaching a facts sheet means passing
 * ALL FOUR; the order only decides which refusal a rep is shown when several
 * apply.
 *
 *   T1 · READS THAT MUST SUCCEED — fail CLOSED. The status-map read
 *        (`gmlStatusError`), the master identity read (`masterReadError`), this
 *        feature's own departure-evidence read (`evidenceReadError`) and the
 *        cycle timesheet (`cycleHours.state === 'unreadable'`) each BLOCK with
 *        `evidence_read_failed`. The departure-evidence read is this feature's
 *        OWN (`./termination-evidence`) precisely because the shared
 *        `loadOffboardEvidenceByEmail` swallows all three of its source errors
 *        with `.catch(() => {})` and returns a bare Map with NO error channel —
 *        it CANNOT report failure, so nothing here pretends that it does.
 *
 *   T2 · A FIRST-PARTY DEPARTURE RECORD must exist and be VALID: a record exists
 *        (`no_departure_evidence`, or `still_active` when the roster also still
 *        carries the person and NOTHING first-party records a departure), the
 *        reason is on the departure allowlist (`temporary_pause`,
 *        `not_a_departure`), and the record POST-DATES the person's own Start
 *        Date (`rehire_after_offboard`). This is the Payment Catalog conjunction
 *        (`isOffboardedForPaymentCatalog`, catalog-roster-visibility.ts:121) and
 *        it stays.
 *
 *   T3 · RE-HIRE TEST — `reengaged_after_departure`. If ANY master row for this
 *        identity carries a Start Date LATER than the latest departure date, the
 *        person was re-engaged after that departure. It is the same comparison
 *        T2's last arm makes, WIDENED from the winning row to every row, and it
 *        is what makes an empty or unreadable timesheet survivable — it catches
 *        the re-hire without depending on Hubstaff at all.
 *
 *   T4 · HOURS, as a REFUSAL-ONLY signal, in three explicitly distinguished
 *        states (`./termination-cycle-hours`):
 *          · index read ERRORED              → BLOCK (taken in T1).
 *          · index read OK and NON-EMPTY     → a real signal. A hit REFUSES
 *                                              (`still_active`); a miss informs.
 *          · index read OK but EMPTY overall → signal UNAVAILABLE. NOT "no
 *            hours". It is recorded on `degraded` so the rep sees it, and T2+T3
 *            carry the decision. The old code spelled this state
 *            `hours.error ? null : personWorkedCycle(...)`, which turned an
 *            empty index into a CONFIDENT `false` for every person on the roster
 *            — the round-2 blocker. The signal union cannot express `worked`
 *            outside `ready`, so that particular collapse cannot recur.
 *
 * WHAT IS *NOT* A REFUSAL: the roster "unstamped duplicate row" signal on its
 * own. That is the NORMAL leaver — measured 2026-08-21
 * (offboard-evidence.ts:8-11): 1,287 active rows, ZERO carrying
 * `off_boarded_at`, while 294 of those people ARE offboarded. It refuses only
 * when NOTHING first-party records a departure at all (T2 empty).
 *
 * Never throws for a data problem — a refusal is data, and the caller wraps this
 * in the 3-arm `TerminationFactsResult`.
 */
export function arbitrateTerminationFacts(
  input: TerminationArbitrationInput,
): TerminationArbitration {
  const now = input.now ?? new Date();
  const workEmail = normEmail(input.workEmail) ?? input.workEmail;
  const day = (raw: string | null | undefined): string | null => explicitMasterDay(raw, now);
  // Non-fatal notes. T4's `unavailable` state lands here, and it has to reach
  // the FACTS SHEET — a signal the rep never learns was missing is worth exactly
  // as much as one that silently read `false`.
  const degraded = [...input.degraded];

  // ── T1. READS THAT MUST SUCCEED (fail CLOSED) ─────────────────────────
  // Before ANY verdict is taken off these rows. `no_master` is a statement about
  // the table and a failed identity read cannot make it; "not active" is a
  // statement about the roster and a failed status map cannot make it.
  if (input.masterReadError) {
    return blocked({
      code: 'evidence_read_failed',
      message: `The master-list read for ${workEmail} failed (${input.masterReadError}), so the rows behind this person are unknown. Retry — "no master row" and "this person is not on the roster" are verdicts a failed read may never produce.`,
    });
  }
  if (input.gmlStatusError) {
    return blocked({
      code: 'evidence_read_failed',
      message: `The active-roster check for ${workEmail} could not run (${input.gmlStatusError}), so there is no way to tell whether this person is still working. Retry — a failed status read must never be read as "not active".`,
    });
  }
  if (input.evidenceReadError) {
    return blocked({
      code: 'evidence_read_failed',
      message: `A departure-evidence read for ${workEmail} failed (${input.evidenceReadError}), so this person cannot be confirmed as a leaver. Retry — an empty result from a broken read must never be treated as "never left".`,
    });
  }
  // Narrowed through a local: the union is discriminated on `state`, and reading
  // it off a parameter property twice is how a `worked` sneaks back into a
  // branch that has no business having one.
  const cycleHours = input.cycleHours;
  if (cycleHours.state === 'unreadable') {
    return blocked({
      code: 'evidence_read_failed',
      message: `The current pay cycle's timesheet could not be read (${cycleHours.error}), so whether ${workEmail} is still working cannot be established. Retry — an unreadable timesheet removes the one signal a stale off-board stamp cannot forge.`,
    });
  }
  if (cycleHours.state === 'unavailable') {
    // NOT a block, and NOT "nobody worked". The timesheet cannot answer, the rep
    // is told so on the facts sheet, and T3 covers the case hours was there to
    // catch. See the four-test rule in this function's docstring.
    degraded.push(
      "The current pay cycle's timesheet is EMPTY, so it could not be asked whether this person worked. This letter rests on the departure record and the re-engagement check instead — read the dates before issuing.",
    );
  }

  // ── 1. no_master ──────────────────────────────────────────────────────────
  if (input.masterRows.length === 0) {
    return blocked({
      code: 'no_master',
      message: `No global_master_list row carries ${workEmail}. Search again — this tab is keyed on the WORK email, and a personal address only ever narrows the candidate list.`,
    });
  }

  // Newest-upload first: on the current upload beats everything, then the upload
  // sequence, then the row id so the order is stable across reads. This is the
  // PROMOTION rule (recently-offboarded.ts:497-520) — vano@ carried a retired
  // "Sales" row and a live "Lead Gen" row, both stamped, and only the upload id
  // separates them.
  const ordered = [...input.masterRows].sort((a, z) => {
    const ac = a.uploadId !== null && a.uploadId === input.currentUploadId ? 1 : 0;
    const zc = z.uploadId !== null && z.uploadId === input.currentUploadId ? 1 : 0;
    if (ac !== zc) return zc - ac;
    if (a.uploadSeq !== z.uploadSeq) return z.uploadSeq - a.uploadSeq;
    return (a.id ?? '').localeCompare(z.id ?? '');
  });
  const winner = ordered[0];
  const onCurrentUpload = winner.uploadId !== null && winner.uploadId === input.currentUploadId;
  const candidateRowIds = ordered.map((r) => r.id).filter((id): id is string => !!id);

  // ── 2. ambiguous_identity ─────────────────────────────────────────────────
  // Rows in the winning tier are equally authoritative and the promotion rule
  // has nothing left to separate them. Two of them NAMING TWO DIFFERENT PEOPLE
  // is the one disagreement that cannot be picked: it is the shadow-identity
  // class (memory `maria-argote-split-identity`,
  // `lawang-rate-shadow-duplicate-identity`), and auto-picking would put a
  // coin-flip legal name on a signed page.
  //
  // Deliberately NARROW. Department and start-date drift across duplicate rows
  // is ordinary — the same person routinely carries several master rows — and
  // the promotion order above resolves it exactly as the shipped precedent does.
  // Widening this to those fields would refuse the commonest shape in the table
  // and would hide the `still_active` refusal behind it.
  const tier = ordered.filter(
    (r) =>
      (r.uploadId !== null && r.uploadId === input.currentUploadId) === onCurrentUpload &&
      r.uploadSeq === winner.uploadSeq,
  );
  const tierNames = distinctValues(tier.map((r) => r.name));
  const tierDepts = distinctValues(tier.map((r) => r.departmentRaw));
  const tierStarts = distinctValues(tier.map((r) => r.startDateRaw));
  if (tierNames.length > 1) {
    // Risk 7's ruling: "the rep adjudicates from a candidate list showing dept /
    // off-date / reason / active-flag". So the refusal SHOWS those rows, in
    // words — a bare list of `global_master_list` uuids is not something a rep
    // can read, search or act on, and every row here shares the SAME work
    // email, so there is no second address to look up either. What the rep can
    // do with this list is name the wrong row precisely when asking HR to fix
    // it. Still never auto-picked: a coin-flip legal name on a signed page is
    // the outcome this arm exists to prevent.
    const ambiguous: TerminationAmbiguousCandidate[] = [];
    for (const r of tier) {
      // A row with no id cannot be named in a repair request; the message above
      // still states every conflicting name.
      if (!r.id) continue;
      const rowReason = trimOrNull(r.offBoardedReason);
      const rowKey = reasonKey(rowReason);
      ambiguous.push({
        rowId: r.id,
        name: r.name,
        workEmail,
        // Only the LABEL may reach a human — the raw cell can be `hsl:*`.
        departmentLabel: r.departmentRaw ? formatDeptLabel(r.departmentRaw) || null : null,
        offDate: day(r.offBoardedAtRaw),
        reasonLabel: rowReason ? offboardReasonLabel(rowKey ?? rowReason) : null,
        // Per ROW, and deliberately so: an unstamped row is precisely what makes
        // fetchGmlStatusMap read this shared address as ACTIVE (G3), so it is
        // the row the rep has to explain.
        active: !trimOrNull(r.offBoardedAtRaw),
      });
    }
    return blocked({
      code: 'ambiguous_identity',
      message: `${workEmail} is carried by ${tier.length} equally current master rows naming different people (${tierNames.join(' / ')}). Every one of them shares this single work email, so there is no other address to search: compare the rows below and have HR repair the master list. Which person a letter is about is never auto-resolved.`,
      candidates: ambiguous,
    });
  }

  // ── T2 (part 1). A FIRST-PARTY DEPARTURE RECORD MUST EXIST ────────────────
  //
  // WHAT "ACTIVE" MEANS HERE, and why it is not the status map's own polarity.
  //
  // `fetchGmlStatusMap` says ACTIVE if ANY row carrying an email is unstamped,
  // and that is right for its own callers. Copied verbatim it refuses a LARGE
  // SHARE of this tab's real subjects, because an unstamped duplicate row is the
  // NORMAL shape of a recent leaver: HR keeps a leaver on the master sheet
  // through final pay, and the off-board stamp lands on a DUPLICATE row.
  // Measured 2026-08-21 (offboard-evidence.ts:8-11): 1,287 active rows, ZERO
  // carrying `off_boarded_at`, while 294 of those people ARE offboarded. A
  // refusal that fires on the common case is worse than useless — it trains the
  // rep to distrust the guard, and the workaround is a roster write made to
  // satisfy a document.
  //
  // So the unstamped duplicate row is NEVER a refusal on its own. It refuses
  // only in conjunction with the thing it is evidence about: NOTHING first-party
  // records a departure AT ALL. That is the genuinely-still-here shape.
  const unstampedRows = ordered.filter((r) => !trimOrNull(r.offBoardedAtRaw));
  const liveOnCurrentUpload = unstampedRows.filter(
    (r) => r.uploadId !== null && r.uploadId === input.currentUploadId,
  );
  // FIRST-PARTY departure records only: the master rows and the `offboarded_sheet`
  // rows, both of which this feature's own reads scoped to THIS WORK EMAIL.
  // `input.evidence` is deliberately excluded — it also carries the completed
  // `offboarding_queue` row, and letting a queue row alone vouch for a departure
  // would hand a person the roster still shows as working a facts sheet.
  const firstPartyDeparture =
    input.masterRows.some((r) => !!trimOrNull(r.offBoardedAtRaw)) ||
    input.sheetRows.some((r) => !!trimOrNull(r.offBoardedAtRaw));

  if (!firstPartyDeparture && (liveOnCurrentUpload.length > 0 || input.gmlActive)) {
    // Nothing FIRST-PARTY records a departure and the roster still carries this
    // person: that is the active case. Name the rows, because "someone is
    // unstamped somewhere" is not something a rep can hand to HR.
    const naming = (liveOnCurrentUpload.length ? liveOnCurrentUpload : unstampedRows).map(
      (r) => `${r.id ?? '(row with no id)'} on upload ${r.uploadId ?? '(none)'}`,
    );
    const which = naming.length
      ? `Unstamped master ${naming.length === 1 ? 'row' : 'rows'}: ${naming.join(' · ')}.`
      : 'The roster status map still counts this address ACTIVE from a row on an older upload.';
    return blocked({
      code: 'still_active',
      message: `${workEmail} is on the live roster and NOTHING records a departure — no off_boarded_at on any master row carrying this work email, and no offboarded_sheet row. ${which} Offboard them first, or have HR stamp the row that actually left: a termination letter for a working employee is the one outcome this tab exists to prevent.`,
    });
  }

  // ── T2 (part 2). …AND THE RECORD MUST BE READABLE ──────────────────────────────────
  const records: DepartureRecord[] = [];
  for (const r of input.masterRows) {
    if (!trimOrNull(r.offBoardedAtRaw)) continue;
    records.push({
      source: 'global_master_list',
      day: day(r.offBoardedAtRaw),
      reason: trimOrNull(r.offBoardedReason),
    });
  }
  for (const r of input.sheetRows) {
    if (!trimOrNull(r.offBoardedAtRaw)) continue;
    records.push({
      source: 'offboarded_sheet',
      day: day(r.offBoardedAtRaw),
      reason: trimOrNull(r.offBoardedReason),
    });
  }
  if (input.evidence) {
    // The map is already normalized but NOT sanitized (offboard-evidence.ts:81),
    // which is exactly how franm@'s hand-typed 2027-04-20 rides through every
    // recency window in the pipeline. Attribute it to whichever table stamped
    // the same day; anything left is the completed queue row, the only other
    // source `'work'` indexes (offboard-evidence.ts:133-152).
    const mapped = day(input.evidence.offDate);
    const attributed =
      records.find((r) => r.day && r.day === mapped)?.source ?? 'offboarding_queue';
    records.push({ source: attributed, day: mapped, reason: trimOrNull(input.evidence.reason) });
  }

  if (records.length === 0) {
    return blocked(
      input.readsDegraded
        ? {
            code: 'evidence_read_failed',
            message: `A departure-evidence read failed, so ${workEmail} cannot be confirmed as a leaver. Retry — an empty result from a broken read must never be treated as "never left".`,
          }
        : {
            code: 'no_departure_evidence',
            message: `Nothing stamps ${workEmail} as having left — no master stamp, no offboarded_sheet row, no completed offboarding_queue row. There is no departure to document.`,
          },
    );
  }

  // Latest departure day wins, and the reason rides along with it.
  const dated = records.filter((r) => r.day);
  let winningDay: string | null = null;
  let offDateSource: TerminationIdentity['offDateSource'] = records[0].source;
  for (const r of dated) {
    const day1 = r.day as string;
    if (
      !winningDay ||
      day1 > winningDay ||
      (day1 === winningDay && SOURCE_PRECEDENCE[r.source] > SOURCE_PRECEDENCE[offDateSource])
    ) {
      winningDay = day1;
      offDateSource = r.source;
    }
  }
  const onWinningDay = winningDay ? dated.filter((r) => r.day === winningDay) : records;
  const rawReason = onWinningDay.map((r) => r.reason).find((v) => !!v) ?? null;

  // ── T2 (part 3). …AND ITS REASON MUST BE A DEPARTURE (G2) ──────────────────────────────────────────────────
  const k = reasonKey(rawReason);
  if (k === 'temporary_pause') {
    // Returned BEFORE any rate read and any render. `off_boarded_reason` is free
    // text with no CHECK constraint and holds both `temporary_pause` and
    // "Temporary Pause"; reasonKey collapses every spelling.
    return blocked({
      code: 'temporary_pause',
      message: `${workEmail}'s latest offboard record is a TEMPORARY PAUSE — a suspension with a return, not a departure. A paused employee can never be issued a termination letter.`,
    });
  }

  // ── T2 (part 4). …AND THE REASON MUST BE ON THE ALLOWLIST ───────────────────────────────────────────────────────
  if (k !== null && !TERMINATION_DEPARTURE_REASON_SET.has(k)) {
    // An ALLOWLIST, by ruling. The column also holds synthetic non-departures
    // (`duplicate_cleanup` on 94 rows, `sheet_sync` on 2) and sheet-authored
    // labels; a denylist would let the next one through.
    return blocked({
      code: 'not_a_departure',
      message: `${workEmail}'s latest offboard reason is "${rawReason}", which is not one of the seven departure reasons a termination letter may state.`,
      rawReason: rawReason ?? '',
    });
  }

  const terminationDate = winningDay;
  // Fields the winning tier agrees on, then first-non-null across the remaining
  // rows — that is how a duplicate row full of blanks stops erasing a real value.
  const pickTier = (values: string[], fallback: Array<string | null>): string | null =>
    values[0] ?? distinctValues(fallback)[0] ?? null;
  const startDateRaw =
    winner.startDateRaw ?? pickTier(tierStarts, ordered.map((r) => r.startDateRaw));
  // The start date runs the SAME sanitize as the offboard date: a start date more
  // than a day in the future is garbage on a signed page, and left unsanitized it
  // would also fire a bogus re-hire refusal below.
  const startDate = day(startDateRaw);

  // ── T2 (part 5). …AND IT MUST POST-DATE THE START DATE (G4) ──────────────────────────────────────────
  // The boundary is `<=`, and that is a KNOWN, ACCEPTED REFUSAL, not an
  // oversight: a same-day engagement-and-departure (a day-one NCNS stamped on
  // the start date) is refused as a re-hire even though the record is correct.
  // The frozen contract states the rule as `offDate <= startDate` and the
  // migration restates it as data — `check (start_date is null or
  // termination_date > start_date)` — so code and DDL say the same thing, and
  // narrowing one without the other would let a row through the app that the
  // database then rejects. If the day-one case ever has to be issuable, BOTH
  // sides move together and the CHECK becomes `termination_date >= start_date`;
  // until then the rep's exit is a master-row repair, never a falsified date.
  if (terminationDate && startDate && terminationDate <= startDate) {
    return blocked({
      code: 'rehire_after_offboard',
      message: `${workEmail} started on ${startDate}, on or after the ${terminationDate} offboard stamp — this record describes a RE-HIRE, and the stamp belongs to the previous stint. Fix the master row before documenting a departure.`,
      offDate: terminationDate,
      startDate,
    });
  }

  // ── T3. RE-HIRE TEST — reengaged_after_departure ──────────────────────────
  //
  // THE GUARD THAT REPLACES THE ROSTER-SIGNAL ARGUMENT, and the reason an empty
  // or unreadable timesheet is survivable. Hours existed to catch ONE case: a
  // person with an old departure record who is working again. A re-engagement
  // leaves a mark the roster cannot hide and Hubstaff is not needed to read it —
  // a master row whose Start Date is LATER than the departure being documented.
  //
  // It is T2's last arm (`rehire_after_offboard`) widened from the WINNING row
  // to EVERY row: the promotion rule picks one row to speak for the person, and
  // a re-hire's new row is routinely not that one (a retired row on the current
  // upload outranks it; memory `rehire-invisible-offboard-reuse`). The strongest
  // row wins the message — the LATEST such start date — so the rep is handed the
  // clearest evidence rather than whichever row happened to sort first.
  if (terminationDate) {
    let reengaged: { row: TerminationMasterRow; startDate: string } | null = null;
    for (const r of ordered) {
      const rowStart = day(r.startDateRaw);
      if (!rowStart || rowStart <= terminationDate) continue;
      if (!reengaged || rowStart > reengaged.startDate) reengaged = { row: r, startDate: rowStart };
    }
    if (reengaged) {
      return blocked({
        code: 'reengaged_after_departure',
        message: `${workEmail} carries a master row (${reengaged.row.id ?? 'row with no id'}${reengaged.row.uploadId ? ` on upload ${reengaged.row.uploadId}` : ''}) whose Start Date is ${reengaged.startDate} — AFTER the ${terminationDate} departure this letter would document. That is a RE-ENGAGEMENT: the stamp belongs to a previous stint and the person was taken back on. Have HR reconcile the rows before anything is issued.`,
        offDate: terminationDate,
        startDate: reengaged.startDate,
        rowId: reengaged.row.id,
      });
    }
  }

  // ── T4. HOURS — a REFUSAL-ONLY signal ─────────────────────────────────────
  // The three states are distinguished in `./termination-cycle-hours` and the
  // other two were handled in T1 (`unreadable` blocks) and above (`unavailable`
  // became a degraded note). Only a READY index can refuse, and only on a HIT.
  //
  // This is the shipped precedent's guard 4 (`isOffboardedForPaymentCatalog`,
  // catalog-roster-visibility.ts:111-116): a stale stamp cannot forge a
  // timesheet row, and 18 people carrying evidence that clears every date guard
  // logged hours in the Aug 9-15 file. The match behind it is deliberately the
  // widest reasonable one — a hit only ever REFUSES, so widening can only cost a
  // letter that is issued after a master-row repair, while narrowing it prints a
  // termination letter for someone who worked this week.
  if (cycleHours.state === 'ready' && cycleHours.worked) {
    const via = cycleHours.matchedBy ? ` (matched on ${cycleHours.matchedBy})` : '';
    return blocked({
      code: 'still_active',
      message: `${workEmail} logged hours in the current pay cycle's timesheet${via}, so this person is WORKING whatever the off-board stamps say. A stale stamp cannot forge a timesheet row. Nothing is issued for someone who is still on the clock.`,
    });
  }

  // ── bad_name ──────────────────────────────────────────────────────────────
  const parts = parseNameParts(winner.name);
  const core = [parts.first, parts.middle, parts.last].filter(Boolean).join(' ').trim();
  const composed = (core && parts.extension ? `${core} ${parts.extension}` : core)
    .replace(/\s+/g, ' ')
    .trim();
  // The nickname is dropped on purpose — a legal page states the legal name.
  // The `@` clause is this feature's ADDITION to the COE's guard: parseNameParts
  // returns an '@'-address parked in the Name column whole in `first`
  // (name-parts.ts:163), and it sails through the comma/quote test, so
  // `jasminec@simple.biz` would print as somebody's legal name.
  if (!composed || /[,"“”]/.test(composed) || composed.includes('@')) {
    return blocked({
      code: 'bad_name',
      message: `The master row for ${workEmail} does not compose to a printable legal name. Fix the master list — printing a malformed name on a legal document is worse than declining to issue it.`,
      rawName: winner.name,
    });
  }

  // ── Facts ─────────────────────────────────────────────────────────────────
  const endingDepartmentRaw = pickTier(
    tierDepts,
    ordered.map((r) => r.departmentRaw),
  );
  const personalEmail =
    normEmail(winner.personalEmail) ??
    normEmail(distinctValues(ordered.map((r) => r.personalEmail))[0] ?? null) ??
    null;

  // Only the LABEL may reach a human: the raw cell can be
  // `hsl:intake_specialist`, and the raw is kept for audit + rate resolution.
  const endingDepartmentLabel = endingDepartmentRaw
    ? formatDeptLabel(endingDepartmentRaw) || null
    : null;

  const identity: TerminationIdentity = {
    workEmail,
    personalEmail,
    masterRowId: winner.id,
    onCurrentUpload,
    candidateRowIds,
    // This resolver is keyed on the work email by contract (G1); the rep's
    // original query column is recorded on the search candidate, not here.
    matchedColumn: 'Work Email',
    offDateSource,
  };

  const facts: TerminationFacts = {
    identity,
    workerName: composed,
    terminationDate,
    terminationDateLabel: terminationDate ? formatCoeStartDate(terminationDate) : null,
    reasonKey: (k as TerminationDepartureReason | null) ?? null,
    reasonLabel: k ? offboardReasonLabel(k) : null,
    rawReason,
    endingDepartmentRaw,
    endingDepartmentLabel,
    startDate,
    startDateLabel: startDate ? formatCoeStartDate(startDate) : null,
    // Placeholders: the rates are resolved outside this pure core and merged by
    // applyTerminationRates, which recomputes `blanks`. The currency is `null`
    // rather than 'PHP' because nothing here has read the Payment Catalog — a
    // placeholder that named a currency is what let an unresolved figure print
    // as pesos.
    startingRate: { amount: null, currency: null, source: null, blankReason: null },
    endingRate: { amount: null, currency: null, source: null, blankReason: null },
    blanks: [],
    degraded: [...degraded],
  };

  const blankReasons: Partial<Record<TerminationBlankField, TerminationBlankReason>> = {};
  if (!terminationDate) {
    // Step 4 proved a departure stamp EXISTS, so a null day here can only mean
    // the stamped value failed one of the three date gates: it claimed the
    // future (franm@'s hand-typed 2027-04-20), it named a day that does not
    // exist (2026-02-31, which `new Date` would ROLL to March 2), or the cell
    // never stated a whole day at all ("August 2026", which the parser would
    // have INVENTED a day-of-month for).
    blankReasons.termination_date = 'date_failed_sanity';
    facts.degraded.push(
      'The offboard date on file is not a usable calendar day — it claims the future, names a day that does not exist, or states only a month and a year. It is blank for you to fill rather than guessed at.',
    );
  }
  if (!facts.reasonKey) blankReasons.reason = 'not_on_file';
  if (!endingDepartmentLabel) blankReasons.ending_department = 'not_on_file';
  if (!startDate) blankReasons.start_date = startDateRaw ? 'date_failed_sanity' : 'not_on_file';
  facts.blanks = computeTerminationBlanks(facts);

  // WORK addresses only (G1). `personalEmail` above stays on the identity for
  // the log row and for search; it is structurally absent from the rate context,
  // because a rate resolved through a shared inbox printed the OTHER identity's
  // hire rate as this person's STARTING RATE.
  const workAliases = workAliasesForRateContext(workEmail, ordered);

  return {
    blocked: null,
    facts,
    rateContext: {
      workEmail,
      workAliases,
      departmentRaw: endingDepartmentRaw,
      offDate: terminationDate,
    },
    blankReasons,
  };
}
