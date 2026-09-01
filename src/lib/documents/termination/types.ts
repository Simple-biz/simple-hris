/** [TERMINATION-DOCS]
 * Termination Docs — the whole shared type surface.
 *
 * PURE and CLIENT-SAFE by contract: no `server-only`, no Supabase import, no
 * Node builtin. The client panel AND every server module import from here, so
 * there is exactly ONE definition of every field — deliberately unlike
 * `src/lib/documents/types.ts:41 CoePreviewFacts`, which is a hand-copied
 * mirror of `CoeFacts` that nothing keeps in sync.
 */

/** Currencies a rate can be quoted in. Mirrors PayCurrency
 *  (src/lib/payment-catalog/pay-structure.ts:12) without importing the
 *  payment-catalog module into client code.
 *
 *  Declared as a `const … as const` with the type DERIVED from it — the shape
 *  TERMINATION_DEPARTURE_REASONS already uses below — because the route has to
 *  validate a rep-CONFIRMED currency at runtime. A hand-written second copy of
 *  the three values could drift from the type; this cannot, and the DDL's
 *  `in ('PHP','USD','COP')` CHECK has exactly one thing to be pinned against. */
export const TERMINATION_CURRENCIES = ['PHP', 'USD', 'COP'] as const;
export type TerminationCurrency = (typeof TERMINATION_CURRENCIES)[number];

/** Runtime half of the union. A currency that is not one of the three can never
 *  reach a printed figure or the `*_currency` columns. */
export function isTerminationCurrency(v: unknown): v is TerminationCurrency {
  return typeof v === 'string' && (TERMINATION_CURRENCIES as readonly string[]).includes(v);
}

/** Where a resolved rate came from. Recorded for audit, NEVER printed. */
export type TerminationRateSource =
  | 'hr_pending'          // hr_pending_employees.regular_rate — the hire rate
  | 'rate_history'        // employee_rate_history, non-1970, non-sync-authored
  | 'rate_history_baseline' // employee_rate_history effective_from = 1970-01-01
  | 'wizard_snapshot'     // app_settings payroll.wizard.final_pay.<file>
  | 'paystub_locked'      // paystub_dispatch_queue payload.rates_php.regular
  | 'disbursement_record' // disbursement_records.regular_rate_php
  | 'rate_history_as_of'  // resolveRateAsOfDate(history, offDate)
  | 'rep_supplied';       // the rep typed it into a blank

/** A rate on the document. `amount === null` means BLANK — the rep must fill it. */
export interface TerminationRate {
  amount: number | null;
  /**
   * The currency this figure is denominated in — RESOLVED, never assumed.
   *
   * `null` means no carrier could state one (the Payment Catalog read failed),
   * and it is a legal state ONLY beside a null `amount`: a figure with no unit
   * is not a fact, and a peso reading of a COP salary is a ~57x misstatement on
   * a signed letter. When it is null the panel asks the rep for a currency along
   * with the amount, `resolveFilledRateCurrency` REQUIRES one, and the DDL's
   * `termination_documents_currency_present_with_rate` CHECK is the layer under
   * both. It was once hardcoded `'PHP'` at every construction site, which made
   * `TerminationCurrency` decorative and printed every USD/COP payee in pesos.
   */
  currency: TerminationCurrency | null;
  /** null only while amount is null and no carrier was consulted successfully. */
  source: TerminationRateSource | null;
  /** Why it is blank. null when amount !== null. */
  blankReason: TerminationBlankReason | null;
}

/** Every fact that can arrive empty and be filled by the rep. */
export type TerminationBlankField =
  | 'termination_date'
  | 'reason'
  | 'ending_department'
  | 'start_date'
  | 'starting_rate'
  | 'ending_rate';

export type TerminationBlankReason =
  | 'not_on_file'          // nothing in any carrier
  | 'date_failed_sanity'   // sanitizeOffboardDay() returned null (e.g. franm@'s 2027-04-20)
  | 'never_paid'           // no paid payment_dispatches row with a cycle_source_file
  | 'no_hire_record'       // no hr_pending_employees row (pre-digital-pipeline hire)
  | 'zero_rate'            // carrier held 0 — "a zero rate is not a rate"
  | 'non_php_payee'        // the payee is priced in USD/COP and the only carrier
                           // that held a figure is a PHP-EQUIVALENT column
                           // (`rates_php`, `regular_rate_php`) — an FX conversion
                           // of their rate, not their rate
  | 'currency_unresolved'  // a carrier held a figure but the Payment Catalog read
                           // failed, so nothing could state which currency it is in
  | 'read_degraded';       // the carrier read returned an error

/** REFUSALS. The document is not generatable. `code` is machine-readable;
 *  `message` is written for an INTERNAL REP looking at someone else's record —
 *  never reuse the COE's employee-voice strings (coe-facts.ts:108). */
/** One master row behind an AMBIGUOUS work email, described the way a rep can
 *  actually adjudicate it (contract §8 risk 7: "the rep adjudicates from a
 *  candidate list showing dept / off-date / reason / active-flag").
 *
 *  `rowId` is carried for the audit trail and for the precise repair request the
 *  rep hands HR; it is NEVER the only thing shown, because a bare
 *  `global_master_list` uuid is not something a rep can search, read or act on. */
export interface TerminationAmbiguousCandidate {
  /** global_master_list.id. Audit + repair reference only. */
  rowId: string;
  /** The Name cell verbatim — the disagreement that caused the refusal. */
  name: string | null;
  /** The one work email every row in this list shares. */
  workEmail: string;
  /** Already through formatDeptLabel — never a raw `hsl:*` key. */
  departmentLabel: string | null;
  /** Sanitized `YYYY-MM-DD`, or null (undated / failed sanity). */
  offDate: string | null;
  reasonLabel: string | null;
  /** THIS ROW carries no off-board stamp — which is exactly what makes
   *  `fetchGmlStatusMap` read the shared address as ACTIVE (G3). Per-row, not a
   *  per-person verdict: the address is one, the rows are several. */
  active: boolean;
}

export type TerminationBlockedReason =
  | { code: 'no_master';            message: string }
  | { code: 'ambiguous_identity';   message: string; candidates: TerminationAmbiguousCandidate[] }
  | { code: 'still_active';         message: string }
  | { code: 'no_departure_evidence';message: string }
  | { code: 'temporary_pause';      message: string }
  | { code: 'not_a_departure';      message: string; rawReason: string }
  | { code: 'rehire_after_offboard';message: string; offDate: string; startDate: string }
  /** ANY master row for this identity carries a Start Date LATER than the latest
   *  departure — the person was RE-ENGAGED after that departure. Distinct from
   *  `rehire_after_offboard`, which compares only the WINNING row: this one
   *  widens the same comparison to every row, and it is the guard that makes an
   *  empty or unreadable cycle timesheet survivable, because a re-hire is the
   *  case the timesheet was there to catch. `rowId` names the row that carries
   *  the later start date so the rep can hand HR a precise repair. */
  | {
      code: 'reengaged_after_departure';
      message: string;
      offDate: string;
      startDate: string;
      rowId: string | null;
    }
  | { code: 'bad_name';             message: string; rawName: string | null }
  | { code: 'evidence_read_failed'; message: string };

/** Which master row won the arbitration, and how. Audit only. */
export interface TerminationIdentity {
  /** THE identity. Lower-cased. Never a personal email. */
  workEmail: string;
  personalEmail: string | null;
  /** global_master_list.id of the row that supplied name/department/start_date. */
  masterRowId: string | null;
  /** true when that row sits on the CURRENT master_list_uploads upload. */
  onCurrentUpload: boolean;
  /** Every gml row id that carried this work email, newest-upload first. */
  candidateRowIds: string[];
  /** Which column the rep's query matched. Email columns only: the facts
   *  resolver is keyed on the WORK email by contract (G1), so the identity can
   *  only ever have been reached through an address. A NAME match narrows the
   *  candidate list (see {@link TerminationSearchMatchedColumn}); it never
   *  becomes an identity by itself. */
  matchedColumn:
    | 'Work Email' | 'Personal Email' | 'Alternate Work Email' | 'Alternate Work Email 2'
    | 'offboarded_sheet.work_email' | 'offboarded_sheet.personal_email'
    | 'offboarding_queue.employee_work_email';
  /** Which source supplied the winning off-board date. */
  offDateSource: 'global_master_list' | 'offboarded_sheet' | 'offboarding_queue';
}

/** The facts sheet the server resolves and the rep reviews. */
export interface TerminationFacts {
  identity: TerminationIdentity;

  /** Legal name, composed like coeWorkerName: first middle last [+ extension].
   *  Nickname DROPPED on purpose. Never null — a null name is a `bad_name` block. */
  workerName: string;

  /** `YYYY-MM-DD`, or null = BLANK. Already through
   *  sanitizeOffboardDay(normalizeMasterDate(raw)). */
  terminationDate: string | null;
  /** e.g. "August 18, 2026". null iff terminationDate is null. */
  terminationDateLabel: string | null;

  /** Normalized departure key, guaranteed NOT 'temporary_pause'. null = BLANK. */
  reasonKey: TerminationDepartureReason | null;
  /** Human label via OFFBOARD_REASON_LABELS. null iff reasonKey is null. */
  reasonLabel: string | null;
  /** Exactly what the DB held, for the audit row. Never printed. */
  rawReason: string | null;

  /** RAW master `Department` cell — may be `hsl:intake_specialist` or `"A, B"`.
   *  Audit + rate resolution only. NEVER rendered. */
  endingDepartmentRaw: string | null;
  /** formatDeptLabel(endingDepartmentRaw). null = BLANK. This is what prints. */
  endingDepartmentLabel: string | null;

  /** `YYYY-MM-DD`, or null = BLANK. */
  startDate: string | null;
  startDateLabel: string | null;

  startingRate: TerminationRate;
  endingRate: TerminationRate;

  /** Which facts arrived empty. The panel renders an input for each. */
  blanks: TerminationBlankField[];

  /** Non-fatal degradation notes (a carrier read failed). Shown to the rep. */
  degraded: string[];
}

/** Departure reasons a termination document may state. This is
 *  VALID_OFFBOARD_REASONS minus 'temporary_pause' — G2, in the type system. */
export const TERMINATION_DEPARTURE_REASONS = [
  'ncns',
  'resigned',
  'end_of_contract',
  'performance',
  'attendance',
  'time_manipulation',
  'other',
] as const;
export type TerminationDepartureReason = (typeof TERMINATION_DEPARTURE_REASONS)[number];

export function isTerminationDepartureReason(
  v: string | null | undefined,
): v is TerminationDepartureReason {
  return !!v && (TERMINATION_DEPARTURE_REASONS as readonly string[]).includes(v);
}

/** 3-arm result. NEVER throws for a data problem — the COE contract
 *  (coe-facts.ts:116). */
export type TerminationFactsResult =
  | { facts: TerminationFacts; blocked: null; error: null }
  | { facts: null; blocked: TerminationBlockedReason; error: null }
  | { facts: null; blocked: null; error: string };

// ─── Search ─────────────────────────────────────────────────────────────────

/** Every column a rep's query may be matched against.
 *
 *  A superset of {@link TerminationIdentity.matchedColumn}: the three NAME
 *  columns can identify a candidate ROW for the rep to choose (a rep holding a
 *  reference request has a name, not an address), but the identity that comes
 *  back is always the work email on that row, and nothing downstream re-derives
 *  a fact from the query — G1. */
export type TerminationSearchMatchedColumn =
  | TerminationIdentity['matchedColumn']
  | 'Name'
  | 'offboarded_sheet.name'
  | 'offboarding_queue.employee_name'
  | 'offboarding_queue.employee_personal_email'
  | 'offboarding_queue.employee_email';

/** Most candidates one search may return. A rep cannot adjudicate a thousand
 *  rows, and a partial list that does not SAY it is partial reads as "this
 *  person is not on file" — the one wrong answer this search must never give.
 *  When the cap bites, `truncated` is set and the panel says so. */
export const TERMINATION_SEARCH_CANDIDATE_CAP = 50;

/** Shortest query a partial (`%…%`) search will run. `%a%` matches most of the
 *  master list, which is not a search result — it is a table dump with a cap on
 *  it, and the rep would be told the cap was hit rather than to type more. */
export const TERMINATION_SEARCH_MIN_QUERY = 3;

/** One candidate identity from a rep's query. A personal email is NOT an
 *  identity — one inbox backs several master rows (carlathomas0112@gmail.com,
 *  mariaa@/mariaar@) — so search returns a SET the rep disambiguates. */
export interface TerminationSearchCandidate {
  workEmail: string | null;
  personalEmail: string | null;
  name: string | null;
  /** Display-safe: already through formatDeptLabel. */
  departmentLabel: string | null;
  /** Sanitized `YYYY-MM-DD`, or null (UNDATED). */
  offDate: string | null;
  rawReason: string | null;
  reasonLabel: string | null;
  matchedColumn: TerminationSearchMatchedColumn;
  /** fetchGmlStatusMap says this email is ACTIVE — G3 will refuse it. */
  active: boolean;
  /** Precomputed refusal so the row renders greyed with the real reason. */
  blockedCode: TerminationBlockedReason['code'] | null;
}

// ─── Stored row ─────────────────────────────────────────────────────────────

/** ONE reversible field write. `before` distinguishes NULL from '' — the
 *  reverse script must restore the exact prior state. */
export interface TerminationWritebackRecord {
  table: 'global_master_list';
  /** global_master_list.id — NEVER an email. One work email owns several rows. */
  rowId: string;
  /** Reproduce the DB identifier VERBATIM, quoting included: 'off_boarded_at',
   *  'off_boarded_reason', 'Start Date'. */
  column: TerminationWritebackColumn;
  before: null | '';
  after: string;
  appliedAt: string;
}

/** The ONLY three columns the write-back may ever touch. */
export const TERMINATION_WRITEBACK_COLUMNS = [
  'off_boarded_at',
  'off_boarded_reason',
  'Start Date',
] as const;
export type TerminationWritebackColumn = (typeof TERMINATION_WRITEBACK_COLUMNS)[number];

/** A master cell counts BLANK when it is null, absent, or nothing but
 *  whitespace. Lives here — not in the server-only write-back module — so the
 *  guard that decides whether a cell may be overwritten is unit-testable
 *  without a Supabase client. `0` is NOT blank: a numeric zero is a value the
 *  write-back must refuse to clobber. */
export function isBlankCell(v: unknown): boolean {
  return String(v ?? '').trim() === '';
}

/** Row shape of `termination_documents`. Snake_case = DB column names verbatim. */
export interface TerminationDocumentRow {
  id: string;
  work_email: string;
  personal_email: string | null;
  master_row_id: string | null;
  worker_name: string;
  termination_date: string;           // DATE, 'YYYY-MM-DD'
  reason_key: TerminationDepartureReason;
  reason_label: string;
  ending_department_raw: string | null;
  ending_department_label: string;
  start_date: string | null;
  starting_rate: string | number | null;   // numeric → PostgREST may hand back a string
  starting_rate_currency: TerminationCurrency | null;
  starting_rate_source: TerminationRateSource | null;
  ending_rate: string | number | null;
  ending_rate_currency: TerminationCurrency | null;
  ending_rate_source: TerminationRateSource | null;
  facts: TerminationFacts;                       // jsonb — full snapshot
  filled_by_rep: TerminationBlankField[];        // text[]
  field_writebacks: TerminationWritebackRecord[];// jsonb
  generated_by: string;
  generated_by_name: string | null;
  generated_by_title: string | null;
  generated_at: string;
  file_path: string;
  file_name: string;
  file_size: number | null;
  created_at: string;
}

// ─── API bodies ─────────────────────────────────────────────────────────────

/** GET /api/accounting/documents/termination/search?q= */
export interface TerminationSearchResponse {
  candidates: TerminationSearchCandidate[];
  degraded: string[];
  /** Distinct identities that matched BEFORE the cap was applied. */
  matched: number;
  /** true when `matched` exceeded {@link TERMINATION_SEARCH_CANDIDATE_CAP} and
   *  `candidates` is only the first page of them. Silently truncating here would
   *  tell a rep somebody is not on file, so this is a REQUIRED field: a caller
   *  that forgets it cannot compile. */
  truncated: boolean;
  /** true when the query was shorter than
   *  {@link TERMINATION_SEARCH_MIN_QUERY} and no read was run at all — a
   *  distinct state from "nothing matched". */
  tooShort: boolean;
  error?: string;
}

/** GET /api/accounting/documents/termination/facts?work_email= */
export interface TerminationFactsResponse {
  facts: TerminationFacts | null;
  blocked: TerminationBlockedReason | null;
  error?: string;
}

/** POST /api/accounting/documents/termination */
export interface TerminationGenerateRequest {
  /** The IDENTITY. Must be a work email the search returned. */
  work_email: string;
  /** Only the blanks the rep filled. A key not in `facts.blanks` is REJECTED 400. */
  filled: {
    termination_date?: string;                  // 'YYYY-MM-DD'
    reason?: TerminationDepartureReason;
    ending_department?: string;
    start_date?: string;                        // 'YYYY-MM-DD'
    starting_rate?: number;
    /** The currency the rep CONFIRMED for `starting_rate`: the badge the panel
     *  rendered beside the input, which is the currency the server itself
     *  resolved from the carrier. Sent so the server can prove the figure was
     *  priced against the currency the record still holds — a mismatch is a 400
     *  and a reload, never a silent re-denomination of a number a human signs.
     *  Omitted ⇒ the record's currency. NOT a rep-chosen override: no currency
     *  picker exists, and inventing one would be a rate fact with no carrier. */
    starting_rate_currency?: TerminationCurrency;
    ending_rate?: number;
    /** As `starting_rate_currency`, for `ending_rate`. */
    ending_rate_currency?: TerminationCurrency;
  };
  /** Rep opted the blank-only write-back on for this generation. Default false. */
  write_back: boolean;
}

export interface TerminationGenerateResponse {
  row: TerminationDocumentRow | null;
  /** Immediately usable download URL, 3600 s TTL. */
  url: string | null;
  blocked: TerminationBlockedReason | null;
  /** What the write-back actually did — [] when write_back was false or all
   *  targets were already filled. */
  writebacks: TerminationWritebackRecord[];
  /** Targets skipped because the column was filled since selection. */
  writeback_skipped: Array<{ column: TerminationWritebackColumn; rowId: string; reason: string }>;
  error?: string;
}

/** GET /api/accounting/documents/termination (the permanent log) */
export interface TerminationLogResponse {
  rows: TerminationDocumentRow[];
  /** true when the page cap was hit — the caller must pass `before` to continue. */
  truncated: boolean;
  error?: string;
}

/** GET /api/accounting/documents/termination/[id] */
export interface TerminationFileResponse {
  url: string | null;
  error?: string;
}
