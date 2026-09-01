'use client';

/** [TERMINATION-DOCS]
 * Accounting → Documents → Termination letters.
 *
 * Four things this panel is responsible for, in order:
 *   1. Find the person. A NAME or a PERSONAL email searches; a WORK email
 *      identifies — one inbox and one surname each back several master rows, so
 *      every match is listed and the rep picks. Nothing is ever auto-selected,
 *      not even a lone result. Two limits speak instead of lying: a fragment
 *      under TERMINATION_SEARCH_MIN_QUERY gets its own "type more" pane, and a
 *      capped list says how many matched, because a row the rep cannot see reads
 *      as "this person was never offboarded". The search runs as the rep types
 *      (debounced; Enter searches immediately; a seq guard drops any response a
 *      newer keystroke has outrun) and a mono console line narrates the request
 *      — the People → Offboarded search console, re-used with this route's own
 *      phase lines.
 *   2. Show the server-resolved facts sheet read-only, with where each fact
 *      came from, and turn every fact the server could NOT resolve into a
 *      required input. A blank is the normal state of an old leaver — this
 *      surface prompts, it does not refuse.
 *   3. Generate. One confirm dialog names the person, the printed date and the
 *      printed reason, says the letter is signed immediately and permanent, and
 *      lists any letters this person already has so a second one is deliberate.
 *   4. The permanent log. Searchable, newest first, one download per row.
 *      **There is no delete action here and there must never be one** — the log
 *      is the record that a signed legal document was issued.
 *   5. The one state a person must repair BY HAND. A write-back that changed a
 *      `global_master_list` cell while its undo record failed to save cannot be
 *      reversed by any script, so it is a non-dismissing banner naming the row,
 *      the column and the value, a marker on its log row, and an acknowledgement
 *      the rep clicks through before the letter opens in a new browser tab.
 *      Never a toast: a `toast.warning` fired straight after `window.open` is a
 *      sentence nobody is looking at.
 *
 * Both judgements this panel makes about a server response — which candidates
 * are selectable, and which write-back skip is a hand repair — live in
 * `@/lib/documents/termination/termination-panel-rules`, because `npm test`
 * never executes a `.tsx` file and both were once client-side copies that
 * drifted away from the server with every test still green.
 *
 * Renders its own header (icon tile / tracked eyebrow / 2xl title / lede) in the
 * same anatomy as the queue's, because the queue header does not describe this
 * tab.
 *
 * View-only reps (`canEdit === false`) get the log and its downloads and nothing
 * else: the whole search → facts → generate path is absent, not disabled, so
 * there is no dead control to reason about.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import {
  AlertTriangle,
  Ban,
  Download,
  FileSignature,
  FileText,
  Loader2,
  PencilLine,
  PenLine,
  RefreshCw,
  Search,
  SearchX,
  Sparkles,
  UserSearch,
  UserX,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import {
  formatDocumentDateTime,
  formatFileSize,
  formatRelativeTime,
  shortReferenceId,
  type DocumentSignatureRow,
} from '@/lib/documents/types';
import { OFFBOARD_REASON_LABELS } from '@/lib/hr/offboard-reasons';
import { CURRENCY_LOCALE, CURRENCY_SYMBOL } from '@/lib/payment-catalog/pay-structure';
import {
  TERMINATION_CURRENCIES,
  TERMINATION_DEPARTURE_REASONS,
  TERMINATION_SEARCH_MIN_QUERY,
  isTerminationCurrency,
  isTerminationDepartureReason,
  type TerminationBlankField,
  type TerminationBlankReason,
  type TerminationBlockedReason,
  type TerminationCurrency,
  type TerminationDepartureReason,
  type TerminationDocumentRow,
  type TerminationFacts,
  type TerminationFactsResponse,
  type TerminationFileResponse,
  type TerminationGenerateRequest,
  type TerminationGenerateResponse,
  type TerminationIdentity,
  type TerminationLogResponse,
  type TerminationRate,
  type TerminationRateSource,
  type TerminationSearchCandidate,
  type TerminationSearchMatchedColumn,
  type TerminationSearchResponse,
  type TerminationWritebackColumn,
} from '@/lib/documents/termination/types';
import {
  MANUAL_REPAIR_STORAGE_KEY,
  buildManualRepairs,
  dropManualRepair,
  isWritebackTrailLost,
  manualRepairKey,
  mergeManualRepairs,
  readManualRepairs,
  serializeManualRepairs,
  viewTerminationCandidate,
  type TerminationManualRepair,
} from '@/lib/documents/termination/termination-panel-rules';

// ── Copy tables ──────────────────────────────────────────────────────────────

/**
 * Rep-voice refusal prose, one sentence per refusal code.
 *
 * The search response carries only `blockedCode` — no message — and a greyed row
 * with no stated reason is exactly the "cannot generate" dead end this feature
 * is forbidden to ship. The facts pane prefers the server's own
 * `blocked.message`; this table is the candidate-list equivalent, and the
 * fallback whenever a message arrives empty.
 *
 * Written for an INTERNAL rep reading someone else's record — never the COE's
 * employee-voice strings.
 */
const REFUSAL_COPY: Record<TerminationBlockedReason['code'], string> = {
  no_master:
    'No master-list row carries this address, so there is no employment record to certify. HR has to repair the roster row first.',
  ambiguous_identity:
    'Two or more equally current master rows under this one work email name different people, so which person a letter would be about cannot be known. Compare the rows below and have HR repair the master list — it is never guessed for you.',
  still_active:
    'Still on the active roster: at least one master row for this address carries no off-board stamp. A termination letter here would state something untrue.',
  no_departure_evidence:
    'No departure stamp anywhere — the master list, the offboarded sheet and the offboarding queue are all silent for this address.',
  temporary_pause:
    'Recorded as a Temporary Pause. That is a suspension the person is expected to return from, not a departure, and it can never become a termination letter.',
  not_a_departure:
    'The stored off-board reason is not a departure — it is a bookkeeping or sync marker — so there is nothing a letter could state.',
  rehire_after_offboard:
    'Re-hired after that off-board date, so the stamp belongs to an earlier stint. The current departure has to be dated before a letter can be issued.',
  reengaged_after_departure:
    'One of this person’s master rows starts AFTER the departure a letter would document — they were taken back on, so that departure is not the current one. HR has to reconcile the rows first.',
  bad_name:
    'The Name cell cannot be rendered as a legal name — it is empty, quoted, comma-shaped, or an email address. Fix the master row, then come back.',
  evidence_read_failed:
    'The departure-evidence read failed, so nothing on this record is confirmed. Refresh; if it keeps failing, raise it with engineering before issuing anything.',
};

const BLANK_LABEL: Record<TerminationBlankField, string> = {
  termination_date: 'Off-board date',
  reason: 'Departure reason',
  ending_department: 'Department at departure',
  start_date: 'Start date',
  starting_rate: 'Starting rate',
  ending_rate: 'Ending rate',
};

/** Why a fact arrived empty, in the rep's words. Only the two rate objects carry
 *  a `blankReason`; the other four blanks are simply absent from source. */
const BLANK_REASON_COPY: Record<TerminationBlankReason, string> = {
  not_on_file: 'nothing usable was on file in any source',
  date_failed_sanity:
    'the stored date failed the sanity check — impossible, or far in the future — and an unchecked date must never print',
  never_paid: 'there is no paid payroll week on record for this person',
  no_hire_record: 'there is no digital hire record — the hire predates the onboarding pipeline',
  zero_rate: 'the source held 0, and a zero rate is not a rate',
  non_php_payee:
    'this person is priced in a currency other than pesos, and the only figure on file is a peso-equivalent of a payroll week — not their rate. Type the rate in their own currency.',
  currency_unresolved:
    'a figure is on file but the Payment Catalog could not be read, so nothing can say which currency it is in. Type the rate and pick its currency.',
  read_degraded: 'the source read failed',
};

/** Where a resolved rate came from. Shown to the rep for judgement; the PDF
 *  never prints it. */
const RATE_SOURCE_COPY: Record<TerminationRateSource, string> = {
  hr_pending: 'the digital hire record',
  rate_history: 'the rate-history ledger',
  rate_history_baseline: 'the rate-history baseline row',
  wizard_snapshot: 'the payroll wizard snapshot for the last paid week',
  paystub_locked: 'the locked paystub for the last paid week',
  disbursement_record: 'the disbursement record for the last paid week',
  rate_history_as_of: 'the rate-history ledger, as at the off-board date',
  rep_supplied: 'you typed it',
};

/** Which column the rep's query actually matched, in words. The raw column name
 *  ("Alternate Work Email 2", "offboarding_queue.employee_personal_email") is a
 *  DB identifier, not a sentence — and a rep reading "matched on
 *  offboarding_queue.employee_work_email" cannot tell whether that is where
 *  their search term was found or where the identity came from. */
const MATCHED_COLUMN_COPY: Record<TerminationSearchMatchedColumn, string> = {
  'Work Email': 'their work email',
  'Personal Email': 'their personal email',
  'Alternate Work Email': 'an alternate work email on the master row',
  'Alternate Work Email 2': 'a second alternate work email on the master row',
  Name: 'their name on the master row',
  'offboarded_sheet.work_email': 'the work email on the offboarded sheet',
  'offboarded_sheet.personal_email': 'the personal email on the offboarded sheet',
  'offboarded_sheet.name': 'their name on the offboarded sheet',
  'offboarding_queue.employee_work_email': 'the work email on the offboarding-queue entry',
  'offboarding_queue.employee_personal_email':
    'the personal email on the offboarding-queue entry',
  'offboarding_queue.employee_email': 'the contact email on the offboarding-queue entry',
  'offboarding_queue.employee_name': 'their name on the offboarding-queue entry',
};

/** The three write-back columns as a rep names them. The stored identifiers are
 *  DB column names — `off_boarded_at`, `"Start Date"` — and a toast is a
 *  sentence, not a schema dump. */
const WRITEBACK_COLUMN_COPY: Record<TerminationWritebackColumn, string> = {
  off_boarded_at: 'the off-board date',
  off_boarded_reason: 'the off-board reason',
  'Start Date': 'the Start Date',
};

const OFF_DATE_SOURCE_COPY: Record<TerminationIdentity['offDateSource'], string> = {
  global_master_list: 'the master-list off-board stamp',
  offboarded_sheet: 'the offboarded sheet',
  offboarding_queue: 'the completed offboarding-queue entry',
};

// ── Pure helpers ─────────────────────────────────────────────────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Format a DATE-ONLY value from its PARTS.
 *
 * `new Date('2026-08-18')` is UTC midnight, which renders as the 17th for any
 * viewer west of UTC — the same day-shift the document layer exists to avoid.
 * `formatDocumentDate` takes that route, so it is deliberately unused here; it
 * is only correct for a real timestamptz.
 */
function formatDayOnly(iso: string | null | undefined): string {
  const m = ISO_DAY.exec((iso ?? '').trim());
  if (!m) return '—';
  const month = MONTH_NAMES[Number(m[2]) - 1];
  if (!month) return '—';
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

/** Local calendar day, `offsetDays` from today. Built from local parts so it
 *  agrees with the day on the rep's own clock. */
function localIsoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Money in the currency the SERVER recorded.
 *
 * A value with no currency prints as a bare number: a peso sign here would
 * assert a currency nobody stored, and USD/COP payees exist.
 */
function formatMoney(
  amount: string | number | null | undefined,
  currency: TerminationCurrency | null | undefined,
): string {
  if (amount == null || amount === '') return '—';
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return '—';
  const digits = { minimumFractionDigits: 2, maximumFractionDigits: 2 } as const;
  if (!currency) return n.toLocaleString('en-US', digits);
  const body = n.toLocaleString(CURRENCY_LOCALE[currency], digits);
  // COP's symbol already carries its code ("$COP"), so it needs the space.
  return currency === 'COP'
    ? `${CURRENCY_SYMBOL[currency]} ${body}`
    : `${CURRENCY_SYMBOL[currency]}${body}`;
}

/** A typed "1,234.50" is a rate. `Number()` alone returns NaN on the grouping
 *  comma — the same trap `parseRateText` closes server-side. */
function parseRateInput(raw: string): number | null {
  const v = (raw ?? '').replace(/,/g, '').trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Per-blank validation: the rep-facing problem, or null when the value is good.
 *  Every rule here mirrors a server guard or a DB CHECK — none may be relaxed to
 *  unblock a generation. */
function blankError(field: TerminationBlankField, raw: string): string | null {
  const v = (raw ?? '').trim();
  if (!v) return 'Required — the letter cannot be generated while this is blank.';
  switch (field) {
    case 'termination_date':
    case 'start_date':
      return ISO_DAY.test(v) ? null : 'Pick a calendar day.';
    case 'reason':
      return isTerminationDepartureReason(v) ? null : 'Choose one of the seven departure reasons.';
    case 'ending_department':
      if (/^hsl:/i.test(v)) {
        return 'Type the readable label (for example "HSL — Intake Specialist"), never the raw hsl: key — a raw key is rejected on the way into the log.';
      }
      return v.length >= 2 ? null : 'Too short to read as a department.';
    case 'starting_rate':
    case 'ending_rate': {
      const n = parseRateInput(v);
      if (n == null) return 'Numbers only.';
      if (n <= 0) return 'A zero rate is not a rate — enter the amount that was actually paid.';
      return null;
    }
  }
  return null;
}

type BlankDraft = Partial<Record<TerminationBlankField, string>>;

/** The two blanks that carry money, and the only ones a currency applies to. */
type RateBlankField = Extract<TerminationBlankField, 'starting_rate' | 'ending_rate'>;
type RateCurrencyDraft = Partial<Record<RateBlankField, TerminationCurrency>>;

/**
 * The currency a rate blank will be submitted in: the one the SERVER resolved,
 * or — only when it resolved none — the one the rep picked.
 *
 * Null means the amount cannot be sent yet. A figure with no unit is not a fact:
 * the route refuses it, `describeUnloggableFacts` refuses it, and the DDL's
 * `termination_documents_currency_present_with_rate` CHECK refuses it. Better to
 * ask here than to bounce a generation.
 */
function effectiveRateCurrency(
  rate: TerminationRate | null | undefined,
  picked: TerminationCurrency | undefined,
): TerminationCurrency | null {
  return rate?.currency ?? picked ?? null;
}

/** The log route's search parameter name is not pinned by the contract (only the
 *  sibling `/search?q=` is), so both spellings ride along — and the client-side
 *  filter below is the guarantee: whichever the server honours, or neither, the
 *  rep still sees a correctly narrowed list. */
function logUrl(q?: string): string {
  const term = (q ?? '').trim();
  if (!term) return '/api/accounting/documents/termination';
  const p = encodeURIComponent(term);
  return `/api/accounting/documents/termination?q=${p}&query=${p}`;
}

// ── Search console (the People → Offboarded pattern) ────────────────────────

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_PHASE_MS = 850;

/** The searched term as the readout speaks it — trimmed and capped so a pasted
 *  novel can't wrap the console line. */
function spokenTerm(q: string): string {
  const t = q.trim();
  return t.length > 24 ? `${t.slice(0, 24)}…` : t;
}

/**
 * What the console readout says while a query is in flight. The lines walk in
 * the rough order the search route reads its sources — master list, offboarded
 * sheet, completed offboarding queue, then the screens — and the LAST line
 * holds until the response lands (never loops back, which would claim progress
 * that isn't happening).
 */
function searchPhases(q: string): string[] {
  const term = spokenTerm(q);
  return [
    `Looking for “${term}”…`,
    `Searching the master list for “${term}”…`,
    'Searching the offboarded sheet…',
    'Checking the completed offboarding queue…',
    'Screening alternate and personal emails…',
    'Weighing departure evidence…',
  ];
}

/**
 * The mono console line under the person-search field. While loading it walks
 * the phase lines; otherwise it states the result plainly — including the cap,
 * because a capped count that reads as complete says "this person was never
 * offboarded". aria-live so screen readers hear the search progress without
 * watching the animation.
 */
function SearchConsoleReadout({
  loading,
  failed,
  tooShort,
  searched,
  count,
  matched,
  truncated,
  query,
}: {
  loading: boolean;
  failed: boolean;
  tooShort: boolean;
  /** A response has landed for the current query (the too-short state wins). */
  searched: boolean;
  count: number;
  /** How many identities matched before the server's cap. */
  matched: number;
  truncated: boolean;
  /** The term being searched — spoken back in the first phase lines. */
  query: string;
}) {
  const reduceMotion = useReducedMotion();
  const [phase, setPhase] = useState(0);
  const phases = searchPhases(query);

  // Restart the phase walk on every new request; hold on the final line.
  useEffect(() => {
    if (!loading) return;
    setPhase(0);
    const t = setInterval(
      () => setPhase((p) => Math.min(p + 1, searchPhases('').length - 1)),
      SEARCH_PHASE_MS,
    );
    return () => clearInterval(t);
  }, [loading]);

  let text: string;
  if (loading) text = phases[Math.min(phase, phases.length - 1)];
  else if (failed) text = 'The search failed — see the message below.';
  else if (tooShort)
    text = `Need at least ${TERMINATION_SEARCH_MIN_QUERY} characters — nothing was searched.`;
  else if (searched && count > 0)
    text = truncated
      ? `${count} of ${matched.toLocaleString('en-US')} matching identities shown`
      : `${count} matching identit${count === 1 ? 'y' : 'ies'}`;
  else if (searched) text = 'No matching records.';
  else text = 'Standing by — type a name, a work email or a personal email.';

  return (
    <div
      aria-live="polite"
      className="mt-1.5 flex items-center gap-1.5 font-mono text-[11px] tracking-tight text-zinc-500 dark:text-zinc-400"
    >
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          loading
            ? cn('bg-orange-500', !reduceMotion && 'animate-pulse')
            : failed
              ? 'bg-rose-500'
              : 'bg-zinc-300 dark:bg-zinc-600',
        )}
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={text}
          initial={reduceMotion ? false : { opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? undefined : { opacity: 0, y: -2 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
      {loading && (
        <span
          aria-hidden
          className={cn(
            'ml-0.5 inline-block h-3 w-[5px] rounded-[1px] bg-orange-500',
            !reduceMotion && 'animate-pulse',
          )}
        />
      )}
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

interface PriorDocsState {
  rows: TerminationDocumentRow[];
  truncated: boolean;
  loading: boolean;
  failed: boolean;
}

const NO_PRIOR: PriorDocsState = { rows: [], truncated: false, loading: false, failed: false };

export default function TerminationDocsPanel({
  canEdit,
  sessionEmail,
  signature,
  signatureLoaded,
  onSetUpSignature,
}: {
  canEdit: boolean;
  sessionEmail: string | null;
  signature: DocumentSignatureRow | null;
  signatureLoaded: boolean;
  /** Opens the queue tab's signature-capture dialog. It lives outside this
   *  component and stays mounted on both tabs, which is the only reason it can
   *  be reached from here. */
  onSetUpSignature: () => void;
}) {
  const reduce = useReducedMotion();

  // ── Person search ──
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  /** The query that produced `candidates`. The no-match pane quotes it, and it
   *  must be the SEARCHED string, not whatever is in the box right now. */
  const [searchedFor, setSearchedFor] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<TerminationSearchCandidate[] | null>(null);
  const [searchDegraded, setSearchDegraded] = useState<string[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  /** How many identities matched before the server's cap, and whether the list
   *  below is only part of them. A capped list that does not SAY it is capped
   *  reads as "this person was never offboarded". */
  const [searchMatched, setSearchMatched] = useState(0);
  const [searchTruncated, setSearchTruncated] = useState(false);
  /** The fragment was too short to search on — a state of its own, because it is
   *  neither "nothing searched yet" nor "nothing matched". */
  const [searchTooShort, setSearchTooShort] = useState(false);
  /** Drops answers that arrive after a newer keystroke's request — required now
   *  that the search runs as the rep types: without it a slow older response
   *  overwrites a newer one and the list silently describes the wrong query. */
  const searchSeqRef = useRef(0);
  /** The typing debounce timer. Armed ONLY in handleQueryChange (a keystroke),
   *  never in an effect — so a mount/remount can never fire a search. */
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    },
    [],
  );

  // ── Facts sheet ──
  const [selected, setSelected] = useState<string | null>(null);
  const [factsLoading, setFactsLoading] = useState(false);
  const [facts, setFacts] = useState<TerminationFacts | null>(null);
  const [factsBlocked, setFactsBlocked] = useState<TerminationBlockedReason | null>(null);
  const [factsError, setFactsError] = useState<string | null>(null);
  const [draft, setDraft] = useState<BlankDraft>({});
  /** The currency the rep picked for a rate the RECORD could not denominate.
   *  Only reachable when `facts.<rate>.currency` is null (the Payment Catalog
   *  read failed): a currency the server resolved is shown, never chosen. */
  const [currencyDraft, setCurrencyDraft] = useState<RateCurrencyDraft>({});
  const [writeBack, setWriteBack] = useState(false);

  // ── Generation ──
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [prior, setPrior] = useState<PriorDocsState>(NO_PRIOR);

  // ── Permanent log ──
  const [log, setLog] = useState<TerminationDocumentRow[]>([]);
  const [logLoading, setLogLoading] = useState(true);
  const [logBusy, setLogBusy] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [logTruncated, setLogTruncated] = useState(false);
  const [logQuery, setLogQuery] = useState('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const logLoadedRef = useRef(false);

  // ── The one state a human must repair by hand ──
  /**
   * Write-backs that CHANGED a `global_master_list` cell while their undo record
   * failed to reach the document row. No script can reverse one: the reverse
   * reads `field_writebacks`, and this record never got there — a person has to
   * blank the cell again.
   *
   * Kept in `localStorage` rather than fetched, because there is nothing on the
   * server to fetch: the state IS the record that did not land. It therefore
   * survives a reload, a closed tab and a killed browser on the machine of the
   * rep who has to act, which a toast never did. `audit_log`
   * (`documents.termination_writeback`) carries engineering's copy.
   */
  const [manualRepairs, setManualRepairs] = useState<TerminationManualRepair[]>([]);
  /** Set once the stored list has been read, so the persist effect below cannot
   *  write an empty array over it on first paint. */
  const repairsLoadedRef = useRef(false);
  /** Two-step clear: one stray click must not retire the record of an
   *  unreversed master-list write. */
  const [confirmingRepair, setConfirmingRepair] = useState<string | null>(null);
  /** Held open until the rep acknowledges the hand-repair. The letter is NOT
   *  opened before that: `window.open` moves focus to another browser tab, which
   *  is exactly how this state used to be missed. */
  const [repairPrompt, setRepairPrompt] = useState<{
    repairs: TerminationManualRepair[];
    url: string | null;
  } | null>(null);

  useEffect(() => {
    try {
      setManualRepairs(readManualRepairs(window.localStorage.getItem(MANUAL_REPAIR_STORAGE_KEY)));
    } catch {
      // Site data blocked, a private window, a browser that throws on access:
      // the panel still has to render, and the banner then lives for this tab
      // only. Never a reason to fail the screen.
    } finally {
      repairsLoadedRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!repairsLoadedRef.current) return;
    try {
      window.localStorage.setItem(MANUAL_REPAIR_STORAGE_KEY, serializeManualRepairs(manualRepairs));
    } catch {
      // Storage full or blocked. The banner still renders from state.
    }
  }, [manualRepairs]);

  /** Log rows carrying an unrepaired cell, so the table can mark them. */
  const repairsByDocument = useMemo(() => {
    const byDoc = new Map<string, TerminationManualRepair[]>();
    for (const r of manualRepairs) {
      const list = byDoc.get(r.documentId);
      if (list) list.push(r);
      else byDoc.set(r.documentId, [r]);
    }
    return byDoc;
  }, [manualRepairs]);

  const setDraftField = useCallback((field: TerminationBlankField, value: string) => {
    setDraft((d) => ({ ...d, [field]: value }));
  }, []);

  const fetchLog = useCallback(async (opts?: { q?: string; silent?: boolean }) => {
    if (opts?.silent) setLogBusy(true);
    else setLogLoading(true);
    setLogError(null);
    try {
      const res = await fetch(logUrl(opts?.q), { cache: 'no-store' });
      const json = (await res.json()) as TerminationLogResponse;
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      setLog(json.rows ?? []);
      setLogTruncated(!!json.truncated);
    } catch (e) {
      setLogError(e instanceof Error ? e.message : 'Failed to load the termination log');
    } finally {
      logLoadedRef.current = true;
      setLogLoading(false);
      setLogBusy(false);
    }
  }, []);

  // The first load is immediate; every later keystroke is debounced and silent,
  // so the table does not flash a skeleton while the rep is still typing.
  useEffect(() => {
    const first = !logLoadedRef.current;
    const t = window.setTimeout(
      () => {
        void fetchLog({ q: logQuery, silent: !first });
      },
      first ? 0 : 350,
    );
    return () => window.clearTimeout(t);
  }, [logQuery, fetchLog]);

  useLiveRefresh({
    tables: ['termination_documents'],
    onRefresh: () => void fetchLog({ q: logQuery, silent: true }),
    channel: 'accounting-termination-docs',
    pollMs: 60_000,
  });

  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim();
    const seq = ++searchSeqRef.current;
    if (!q) {
      // The box was emptied: back to the prompt state, and bumping the seq above
      // already retired any answer still in flight.
      setSearching(false);
      setCandidates(null);
      setSearchedFor(null);
      setSearchDegraded([]);
      setSearchError(null);
      setSearchMatched(0);
      setSearchTruncated(false);
      setSearchTooShort(false);
      return;
    }
    // The server runs no read on a fragment this short either — `%a%` matches
    // most of the master list. Checking here as well means the rep is told to
    // type more instead of waiting for a round trip to say nothing.
    if (q.length < TERMINATION_SEARCH_MIN_QUERY) {
      setSearching(false);
      setCandidates([]);
      setSearchDegraded([]);
      setSearchError(null);
      setSearchMatched(0);
      setSearchTruncated(false);
      setSearchTooShort(true);
      setSearchedFor(q);
      return;
    }
    setSearching(true);
    setSearchError(null);
    setSearchTooShort(false);
    try {
      const res = await fetch(
        `/api/accounting/documents/termination/search?q=${encodeURIComponent(q)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as TerminationSearchResponse;
      if (seq !== searchSeqRef.current) return;
      if (!res.ok || json.error) throw new Error(json.error || `Search failed (${res.status})`);
      // INVARIANT: never auto-select, not even a single result. A personal email
      // backs several master identities, so "the only match" is a property of
      // this query, not proof of who the letter is about.
      const found = json.candidates ?? [];
      setCandidates(found);
      setSearchDegraded(json.degraded ?? []);
      setSearchMatched(json.matched ?? found.length);
      setSearchTruncated(!!json.truncated);
      setSearchTooShort(!!json.tooShort);
    } catch (e) {
      if (seq !== searchSeqRef.current) return;
      setCandidates([]);
      setSearchDegraded([]);
      setSearchMatched(0);
      setSearchTruncated(false);
      setSearchError(e instanceof Error ? e.message : 'The search failed');
    } finally {
      // A stale response never writes anything — including `searchedFor`, which
      // must stay the string that produced the candidates on screen.
      if (seq === searchSeqRef.current) {
        setSearchedFor(q);
        setSearching(false);
      }
    }
  }, []);

  const handleQueryChange = useCallback(
    (v: string) => {
      setQuery(v);
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = setTimeout(() => void runSearch(v), SEARCH_DEBOUNCE_MS);
    },
    [runSearch],
  );

  /** Enter — search right now, ahead of the debounce. */
  const searchNow = useCallback(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    void runSearch(query);
  }, [runSearch, query]);

  const clearSearch = useCallback(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    setQuery('');
    void runSearch('');
  }, [runSearch]);

  const loadFacts = useCallback(async (workEmail: string) => {
    setSelected(workEmail);
    setFacts(null);
    setFactsBlocked(null);
    setFactsError(null);
    setDraft({});
    setCurrencyDraft({});
    setWriteBack(false);
    setPrior(NO_PRIOR);
    setFactsLoading(true);
    try {
      const res = await fetch(
        `/api/accounting/documents/termination/facts?work_email=${encodeURIComponent(workEmail)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as TerminationFactsResponse;
      // A refusal arrives with a non-ok status, so `blocked` is read BEFORE
      // res.ok — otherwise a real, explainable refusal reads as a fetch failure.
      if (json.blocked) setFactsBlocked(json.blocked);
      else if (!res.ok || json.error || !json.facts) {
        throw new Error(json.error || `Could not load the facts sheet (${res.status})`);
      } else setFacts(json.facts);
    } catch (e) {
      setFactsError(e instanceof Error ? e.message : 'Could not load the facts sheet');
    } finally {
      setFactsLoading(false);
    }
  }, []);

  // Earlier letters for the selected person, so the confirm dialog can name
  // them. Fetched on its own rather than read off the log table, which the rep's
  // own log search may have narrowed to something unrelated.
  const factsWorkEmail = facts?.identity.workEmail ?? null;
  useEffect(() => {
    if (!factsWorkEmail) {
      setPrior(NO_PRIOR);
      return;
    }
    let cancelled = false;
    setPrior({ ...NO_PRIOR, loading: true });
    (async () => {
      try {
        const res = await fetch(logUrl(factsWorkEmail), { cache: 'no-store' });
        const json = (await res.json()) as TerminationLogResponse;
        if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
        if (cancelled) return;
        const key = factsWorkEmail.toLowerCase();
        setPrior({
          rows: (json.rows ?? [])
            .filter((r) => (r.work_email ?? '').toLowerCase() === key)
            .sort((a, b) => (a.generated_at < b.generated_at ? 1 : a.generated_at > b.generated_at ? -1 : 0)),
          truncated: !!json.truncated,
          loading: false,
          failed: false,
        });
      } catch {
        if (!cancelled) setPrior({ ...NO_PRIOR, failed: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [factsWorkEmail]);

  const download = useCallback(async (row: TerminationDocumentRow) => {
    setDownloadingId(row.id);
    try {
      const res = await fetch(`/api/accounting/documents/termination/${row.id}`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as TerminationFileResponse;
      if (!res.ok || !json.url) throw new Error(json.error || `Could not open the file (${res.status})`);
      window.open(json.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open the file');
    } finally {
      setDownloadingId(null);
    }
  }, []);

  // ── Derived ──

  const signatureBlocked = !signature || !signature.enabled;

  const effectiveOffDate = facts ? facts.terminationDate ?? (draft.termination_date ?? '').trim() : '';
  const effectiveStartDate = facts ? facts.startDate ?? (draft.start_date ?? '').trim() : '';

  /** G4, restated in the browser: an off-board date on or before the start date
   *  is a re-hire, and the DB CHECK rejects it anyway. */
  const orderError =
    ISO_DAY.test(effectiveOffDate) &&
    ISO_DAY.test(effectiveStartDate) &&
    effectiveOffDate <= effectiveStartDate
      ? 'The off-board date has to fall after the start date. If it does not, this record is a re-hire and the current departure needs dating first.'
      : null;

  const missingBlanks = useMemo(
    () => (facts ? facts.blanks.filter((b) => blankError(b, draft[b] ?? '') != null) : []),
    [facts, draft],
  );

  /** A rate blank whose currency NOBODY has stated yet. The record could not
   *  denominate it (the Payment Catalog read failed) and the rep has not picked
   *  one, so the amount cannot be sent: an undenominated figure is refused by the
   *  route, by the log gate and by the DDL. */
  const missingRateCurrencies = useMemo<RateBlankField[]>(() => {
    if (!facts) return [];
    const out: RateBlankField[] = [];
    if (
      facts.blanks.includes('starting_rate') &&
      !effectiveRateCurrency(facts.startingRate, currencyDraft.starting_rate)
    ) {
      out.push('starting_rate');
    }
    if (
      facts.blanks.includes('ending_rate') &&
      !effectiveRateCurrency(facts.endingRate, currencyDraft.ending_rate)
    ) {
      out.push('ending_rate');
    }
    return out;
  }, [facts, currencyDraft]);

  const draftReason = (draft.reason ?? '').trim();
  const effectiveReasonKey: TerminationDepartureReason | null =
    facts?.reasonKey ?? (isTerminationDepartureReason(draftReason) ? draftReason : null);
  const effectiveReasonLabel =
    facts?.reasonLabel ??
    (effectiveReasonKey ? OFFBOARD_REASON_LABELS[effectiveReasonKey] ?? effectiveReasonKey : null);
  const effectiveDeptLabel =
    facts?.endingDepartmentLabel ?? ((draft.ending_department ?? '').trim() || null);

  const readyToGenerate =
    !!facts &&
    canEdit &&
    missingBlanks.length === 0 &&
    missingRateCurrencies.length === 0 &&
    !orderError;

  const logMatches = useMemo(() => {
    const q = logQuery.trim().toLowerCase();
    const rows = !q
      ? log
      : log.filter((r) =>
          [
            r.worker_name,
            r.work_email,
            r.personal_email,
            r.reason_label,
            r.reason_key,
            r.ending_department_label,
            r.generated_by,
            r.generated_by_name,
          ]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q)),
        );
    // Newest first is a promise this table makes, so it is enforced here rather
    // than assumed of the response ordering. Ties break on id, matching the
    // keyset the server pages on.
    return [...rows].sort((a, b) => {
      if (a.generated_at !== b.generated_at) return a.generated_at < b.generated_at ? 1 : -1;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
  }, [log, logQuery]);

  const logStats = useMemo(() => {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    return {
      listed: logMatches.length,
      people: new Set(logMatches.map((r) => (r.work_email ?? '').toLowerCase())).size,
      thisMonth: logMatches.filter((r) => {
        const t = new Date(r.generated_at).getTime();
        return !Number.isNaN(t) && t >= monthStart.getTime();
      }).length,
      repFilled: logMatches.filter((r) => (r.filled_by_rep ?? []).length > 0).length,
      writtenBack: logMatches.filter((r) => (r.field_writebacks ?? []).length > 0).length,
    };
  }, [logMatches]);

  const generate = useCallback(async () => {
    if (!facts || !canEdit) return;
    const filled: TerminationGenerateRequest['filled'] = {};
    // Only the fields the SERVER declared blank may be sent — any other key is a
    // 400 by contract, and building the body from `facts.blanks` keeps it honest.
    for (const b of facts.blanks) {
      const raw = (draft[b] ?? '').trim();
      switch (b) {
        case 'termination_date':
          filled.termination_date = raw;
          break;
        case 'start_date':
          filled.start_date = raw;
          break;
        case 'ending_department':
          filled.ending_department = raw;
          break;
        case 'reason':
          if (isTerminationDepartureReason(raw)) filled.reason = raw;
          break;
        case 'starting_rate': {
          const n = parseRateInput(raw);
          const currency = effectiveRateCurrency(facts.startingRate, currencyDraft.starting_rate);
          // An amount with no currency is never sent. `readyToGenerate` already
          // blocks the button on it; this is the same rule where the body is
          // built, so no path can post a figure with no unit.
          if (n != null && currency) {
            filled.starting_rate = n;
            // The currency the rep just CONFIRMED: the badge rendered beside this
            // input, which is the currency the server resolved from the carrier —
            // or, when it resolved none, the one the rep chose there. Sent so the
            // server can prove the figure was priced against the currency the
            // record still holds; the route rejects a mismatch rather than
            // re-denominating a number a human is about to sign.
            filled.starting_rate_currency = currency;
          }
          break;
        }
        case 'ending_rate': {
          const n = parseRateInput(raw);
          const currency = effectiveRateCurrency(facts.endingRate, currencyDraft.ending_rate);
          if (n != null && currency) {
            filled.ending_rate = n;
            filled.ending_rate_currency = currency;
          }
          break;
        }
      }
    }

    setGenerating(true);
    try {
      const res = await fetch('/api/accounting/documents/termination', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: facts.identity.workEmail,
          filled,
          write_back: writeBack,
        } satisfies TerminationGenerateRequest),
      });
      const json = (await res.json()) as TerminationGenerateResponse;

      // The facts are re-resolved server-side on every POST, so a refusal can
      // land here even though the sheet loaded cleanly a minute ago.
      if (json.blocked) {
        setConfirmOpen(false);
        setFacts(null);
        setFactsBlocked(json.blocked);
        return;
      }
      if (res.status === 412) {
        // No usable signature. Same steer as the queue: straight into capture.
        setConfirmOpen(false);
        onSetUpSignature();
        throw new Error(json.error || 'Your signature is not available to sign with');
      }
      if (!res.ok || json.error || !json.row) {
        throw new Error(json.error || `Generation failed (${res.status})`);
      }

      setConfirmOpen(false);
      toast.success('Termination letter generated and signed', {
        description: `${json.row.worker_name} — ${json.row.reason_label}, off-boarded ${formatDayOnly(json.row.termination_date)}. It is in the log below for good.`,
      });

      // A write-back whose undo record did not land is the ONE state a human
      // must act on or the master-list edit is unrecoverable. It is separated
      // from the ordinary skips here and never toasted: it becomes a
      // non-dismissing banner, a marker on the log row, and an acknowledgement
      // the rep has to click through before the letter opens.
      const allSkips = json.writeback_skipped ?? [];
      const trailLost = allSkips.filter(isWritebackTrailLost);
      const otherSkips = allSkips.filter((s) => !isWritebackTrailLost(s));

      // A skipped write-back is never silent: the cell it wanted already held a
      // value, and the rep is the only one who can judge that.
      for (const s of otherSkips) {
        toast.warning(`Left ${WRITEBACK_COLUMN_COPY[s.column] ?? s.column} alone`, {
          description: s.reason,
        });
      }

      if (trailLost.length > 0) {
        const fresh = buildManualRepairs({
          row: json.row,
          skipped: trailLost,
          detectedAt: new Date().toISOString(),
        });
        setManualRepairs((prev) => mergeManualRepairs(prev, fresh));
        // NOT opened yet. Focus stays on this tab until the rep has seen which
        // cell has to be put back by hand.
        setRepairPrompt({ repairs: fresh, url: json.url ?? null });
      } else if (json.url) {
        window.open(json.url, '_blank', 'noopener,noreferrer');
      }
      setDraft({});
      setCurrencyDraft({});
      setWriteBack(false);
      void fetchLog({ q: logQuery, silent: true });
      // Re-read the sheet: a write-back may have filled cells that were blank.
      void loadFacts(facts.identity.workEmail);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }, [facts, canEdit, draft, currencyDraft, writeBack, onSetUpSignature, fetchLog, logQuery, loadFacts]);

  const maxOffDate = localIsoDay(1);

  return (
    <div className="space-y-5">
      {/* ── Header (its own — the queue's header does not describe this tab) ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-100 to-amber-100 text-orange-700 ring-1 ring-orange-100 dark:from-orange-950/60 dark:to-amber-950/40 dark:text-orange-300 dark:ring-orange-900/60">
            <UserX className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-orange-700 dark:text-orange-300">
              Termination letters
            </p>
            <h2 className="mt-0.5 text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
              Documents — Termination Letters
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              Look someone up by name, work email or personal email — part of any of them is
              enough — check the facts the system resolved, fill in anything it could not find, and
              generate a one-page letter signed with your own saved signature. Nothing is emailed —
              you download it and send it from your own inbox. Every generation is recorded in the
              permanent log below.
            </p>
          </div>
        </div>
      </div>

      {/* ── Cells only a human can put back ────────────────────────────────
          NOT a toast, and there is no dismiss. Each entry names the master row,
          the column and the value now sitting in it. An entry leaves only when a
          rep states the cell has been blanked again, and the list is stored in
          this browser, so it survives a reload, a new tab and a closed window —
          the three ways the toast this replaces was missed. Rendered above
          everything, and outside the `canEdit` gate, because it is a fact about
          the roster, not part of the generate path. */}
      {manualRepairs.length > 0 && (
        <div
          role="alert"
          className="rounded-2xl border-2 border-rose-400 bg-rose-50 px-4 py-3.5 shadow-sm dark:border-rose-500/60 dark:bg-rose-950/30"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-rose-700 dark:text-rose-300">
                {manualRepairs.length} master-list cell{manualRepairs.length === 1 ? '' : 's'} must
                be put back by hand
              </p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-rose-900 dark:text-rose-200">
                The write-back changed the cells below and its undo record never reached the
                document row, so the revert script cannot see them and{' '}
                <strong className="font-semibold">no script can reverse them</strong>. Every one of
                them was <strong className="font-semibold">empty</strong> before the letter was
                generated — that is the only state the write-back can fill. Clear each cell in
                People (or ask HR to), then mark it done here. Nothing removes this notice on its
                own.
              </p>
              <ul className="mt-2.5 space-y-2">
                {manualRepairs.map((r) => {
                  const key = manualRepairKey(r);
                  const confirming = confirmingRepair === key;
                  return (
                    <li
                      key={key}
                      className="rounded-xl border border-rose-300 bg-white px-3 py-2.5 dark:border-rose-500/40 dark:bg-zinc-950/60"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100">
                            {r.workerName || r.workEmail || 'Unnamed record'} —{' '}
                            {WRITEBACK_COLUMN_COPY[r.column] ?? r.column}
                          </p>
                          {/* The DB identifiers verbatim: this is an instruction
                              to change one cell of one row, and a paraphrase of
                              either would send the repair to the wrong place. */}
                          <p className="mt-1 break-all font-mono text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                            global_master_list.id = {r.masterRowId || '(not reported)'}
                          </p>
                          <p className="mt-0.5 break-all font-mono text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                            {r.column} = {r.wroteValue ?? '(the value printed on the letter)'}{' '}
                            <span className="text-rose-700 dark:text-rose-300">
                              → restore to blank
                            </span>
                          </p>
                          <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                            {r.workEmail} · letter {shortReferenceId(r.documentId)} · reported{' '}
                            {formatDocumentDateTime(r.detectedAt)}
                          </p>
                          <p className="mt-1 text-[11px] italic leading-relaxed text-zinc-500 dark:text-zinc-400">
                            {r.reason}
                          </p>
                        </div>
                        <div className="shrink-0">
                          {confirming ? (
                            <div className="flex items-center gap-1.5">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => setConfirmingRepair(null)}
                                className="h-7 text-xs"
                              >
                                Not yet
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => {
                                  setManualRepairs((prev) => dropManualRepair(prev, key));
                                  setConfirmingRepair(null);
                                }}
                                className="h-7 bg-rose-600 text-xs font-semibold text-white hover:bg-rose-700"
                              >
                                The cell is blank again
                              </Button>
                            </div>
                          ) : (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setConfirmingRepair(key)}
                              className="h-7 gap-1 border-rose-300 text-xs text-rose-700 hover:bg-rose-50 dark:border-rose-500/50 dark:text-rose-300 dark:hover:bg-rose-950/40"
                            >
                              <PencilLine className="h-3 w-3" />
                              Mark restored
                            </Button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
      )}

      {canEdit && signatureLoaded && signatureBlocked && (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-amber-300 bg-amber-50/70 px-4 py-3 dark:border-amber-500/40 dark:bg-amber-950/20">
          <p className="flex min-w-0 items-start gap-2 text-[12.5px] leading-relaxed text-amber-900 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {!signature
                ? 'No signature on file. A termination letter is signed the moment it is generated, so nothing can be issued until yours is saved.'
                : 'Your signature is switched off. A termination letter is signed at generation, so issuing stays blocked until you switch it back on.'}
            </span>
          </p>
          <Button
            type="button"
            size="sm"
            onClick={onSetUpSignature}
            className="h-8 shrink-0 gap-1.5 bg-orange-500 text-xs font-semibold text-white hover:bg-orange-600"
          >
            <PenLine className="h-3.5 w-3.5" />
            {signature ? 'Manage my signature' : 'Set up my signature'}
          </Button>
        </div>
      )}

      {!canEdit && (
        <p className="rounded-2xl border border-orange-100/80 bg-white/80 px-4 py-3 text-[12.5px] leading-relaxed text-zinc-500 dark:border-orange-950/40 dark:bg-zinc-950 dark:text-zinc-400">
          <span className="font-medium text-zinc-700 dark:text-zinc-200">View-only access.</span>{' '}
          The permanent log is fully readable and every letter can be downloaded. Issuing a new
          letter needs edit access on Accounting &rarr; Documents.
        </p>
      )}

      {/* ── Step 1 · find the person (absent entirely without edit) ────────── */}
      {canEdit && (
        <Card className="border-orange-100/80 py-0 shadow-sm dark:border-orange-950/40">
          <CardHeader className="border-b border-orange-100/80 bg-orange-50/40 px-5 py-3 dark:border-orange-950/40 dark:bg-orange-950/20">
            <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
              Step 1 — find the person
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            {/* Search console — debounced live input plus the mono readout that
                narrates it (the People → Offboarded pattern). Enter searches
                immediately; the seq guard in runSearch drops any answer a newer
                keystroke has outrun. */}
            <div className="sm:max-w-2xl">
              <div
                className={cn(
                  'relative overflow-hidden rounded-xl border bg-white transition-shadow dark:bg-zinc-950',
                  searching
                    ? 'border-orange-300 shadow-[0_0_0_3px_rgba(249,115,22,0.08)] dark:border-orange-800'
                    : 'border-zinc-200 dark:border-zinc-800',
                )}
              >
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={query}
                  onChange={(e) => handleQueryChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      searchNow();
                    }
                  }}
                  placeholder="Search a name, a surname, a work email or a personal email…"
                  aria-label="Search offboarded people by name, work email or personal email"
                  className="h-10 border-0 pl-9 pr-8 text-sm shadow-none focus-visible:ring-1 focus-visible:ring-orange-500/40"
                />
                {query && (
                  <button
                    type="button"
                    onClick={clearSearch}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                {/* Scan line — a gradient comet along the bottom edge while a
                    request is in flight. It fades in and out rather than
                    snapping, its soft edges hide the loop restart (which
                    happens off-screen anyway), and easeInOut lets it glide
                    through the visible middle. Transform/opacity only; absent
                    under reduced motion (the readout TEXT is the
                    reduced-motion signal). */}
                <AnimatePresence>
                  {searching && !reduce && (
                    <motion.span
                      aria-hidden
                      className="absolute bottom-0 left-0 h-[2px] w-1/2 bg-gradient-to-r from-transparent via-orange-500 to-transparent"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1, x: ['-100%', '300%'] }}
                      exit={{ opacity: 0 }}
                      transition={{
                        opacity: { duration: 0.25, ease: 'easeOut' },
                        x: { repeat: Infinity, duration: 1.6, ease: 'easeInOut' },
                      }}
                    />
                  )}
                </AnimatePresence>
              </div>
              <SearchConsoleReadout
                loading={searching}
                failed={!!searchError}
                tooShort={searchTooShort}
                searched={candidates != null}
                count={candidates?.length ?? 0}
                matched={searchMatched}
                truncated={searchTruncated}
                query={query}
              />
            </div>

            <p className="text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              Results appear as you type. A name or a personal email{' '}
              <strong className="font-semibold text-zinc-700 dark:text-zinc-200">searches</strong>; a
              work email{' '}
              <strong className="font-semibold text-zinc-700 dark:text-zinc-200">identifies</strong>{' '}
              — one inbox can sit behind several master records, so every match is listed, including
              the ones that cannot be used and why, and you pick the person yourself. Words match in
              any order (“carla thomas” finds “Thomas, Carla”); at least{' '}
              {TERMINATION_SEARCH_MIN_QUERY} characters are needed.
            </p>

            {searchDegraded.length > 0 && (
              <div className="rounded-xl border border-amber-300 bg-amber-50/70 px-3 py-2.5 dark:border-amber-500/40 dark:bg-amber-950/20">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-800 dark:text-amber-300">
                  Some sources did not answer
                </p>
                <ul className="mt-1 space-y-0.5">
                  {searchDegraded.map((d, i) => (
                    <li
                      key={`${i}-${d}`}
                      className="text-[12px] leading-relaxed text-amber-900 dark:text-amber-200"
                    >
                      {d}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-[11.5px] italic text-amber-800/80 dark:text-amber-300/70">
                  The list below may therefore be incomplete — someone missing here is not proof
                  they were never offboarded.
                </p>
              </div>
            )}

            {searchError && (
              <p className="flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {searchError}
              </p>
            )}

            {/* No skeleton while a search is in flight: the scan line and the
                console readout carry the loading state, and the previous
                result set stays on screen instead of flashing away under a
                rep who is still typing. */}
            {searchTooShort ? (
              /* Too short to search — distinct from both "nothing searched yet"
                 and "nothing matched", because the fix is different: type more.
                 No read was run, so this is not evidence about anybody. */
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-amber-300 py-10 text-center dark:border-amber-500/40">
                <Search className="h-7 w-7 text-amber-400 dark:text-amber-700" />
                <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Type at least {TERMINATION_SEARCH_MIN_QUERY} characters
                </p>
                <p className="max-w-md text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  A one- or two-letter fragment matches most of the master list, so nothing was
                  searched — this is not a result about anyone. Add a few more letters of the name or
                  the address.
                </p>
              </div>
            ) : candidates == null ? (
              /* Nothing searched yet — a prompt, not an empty state. */
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-orange-200 py-10 text-center dark:border-orange-900/50">
                <UserSearch className="h-7 w-7 text-orange-300 dark:text-orange-800" />
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                  Start with a name or an email
                </p>
                <p className="max-w-md text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  Offboarded people are searched by name and by every email column across the master
                  list, the offboarded sheet and the completed offboarding queue — a surname on its
                  own is a fine place to start.
                </p>
              </div>
            ) : candidates.length === 0 ? (
              /* No-results state, distinct from the prompt above (ui-standards §12.2).
                 Keyed by the searched term so each answered query pops in. */
              <motion.div
                key={searchedFor ?? 'no-match'}
                initial={reduce ? false : { opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={
                  reduce
                    ? { duration: 0 }
                    : { type: 'spring', stiffness: 420, damping: 30, mass: 0.7 }
                }
                className="flex flex-col items-center gap-2 py-10 text-center"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-zinc-400 to-zinc-500 text-white shadow-md">
                  <SearchX className="h-6 w-6" />
                </div>
                <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Nothing matched that search
                </p>
                <p className="font-mono text-[11.5px]">
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    {searchedFor}
                  </span>
                </p>
                <p className="max-w-md text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  No name or email column in the master list, the offboarded sheet or the completed
                  offboarding queue contains that fragment. Try a surname on its own, a different
                  spelling, or the other email you have for them.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={clearSearch}
                  className="h-7 text-xs"
                >
                  Clear search
                </Button>
              </motion.div>
            ) : (
              /* Keyed by the SEARCHED term, so a fresh result set remounts and
                 replays the pop-in — entrance only, exit-free, per the house
                 no-exit-churn rule on list panes. */
              <motion.div
                key={searchedFor ?? 'results'}
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                className="space-y-2"
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-orange-700 dark:text-orange-300">
                  {searchTruncated
                    ? `${candidates.length} of ${searchMatched} matches — pick one`
                    : `${candidates.length} match${candidates.length === 1 ? '' : 'es'} — pick one`}
                </p>
                {searchTruncated && (
                  /* The cap is stated, never silent: a row a rep cannot see reads
                     as "this person was never offboarded". */
                  <div className="rounded-xl border border-amber-300 bg-amber-50/70 px-3 py-2.5 dark:border-amber-500/40 dark:bg-amber-950/20">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-800 dark:text-amber-300">
                      This list is capped
                    </p>
                    <p className="mt-1 text-[12px] leading-relaxed text-amber-900 dark:text-amber-200">
                      {searchMatched.toLocaleString('en-US')} records matched and only the first{' '}
                      {candidates.length} are listed, newest departure first. Someone missing from
                      this list is <strong className="font-semibold">not</strong> proof they were
                      never offboarded — narrow the search with a surname, a fuller name, or the
                      full email address.
                    </p>
                  </div>
                )}
                {candidates.map((c, i) => {
                  // THE SERVER DECIDES. `blockedCode === null` means the facts
                  // route will answer for this person; a code means a greyed row
                  // stating that code's reason. `c.active` is DISPLAY METADATA
                  // for the chip below and never a veto: the second, weaker copy
                  // of G3 that used to live on this line refused every candidate
                  // `fetchGmlStatusMap` calls ACTIVE, which greys out the 294
                  // offboarded people still carrying an unstamped master row —
                  // the commonest leaver shape there is, and the majority of
                  // this tab's real subjects.
                  const view = viewTerminationCandidate(c);
                  const workEmail = view.workEmail;
                  const refusal = view.refusalCode ? REFUSAL_COPY[view.refusalCode] : null;
                  const usable = view.selectable;
                  const isSelected = !!workEmail && workEmail === selected;
                  return (
                    <motion.div
                      key={workEmail ?? `${c.matchedColumn}:${c.personalEmail ?? c.name ?? i}`}
                      initial={reduce ? false : { opacity: 0, y: 10, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={
                        reduce
                          ? { duration: 0 }
                          : {
                              type: 'spring',
                              stiffness: 480,
                              damping: 30,
                              mass: 0.7,
                              // Staggered, but capped so a full page of matches
                              // never keeps the last row waiting.
                              delay: Math.min(i * 0.05, 0.35),
                            }
                      }
                      className={cn(
                        'rounded-xl border p-3 transition-colors',
                        usable
                          ? isSelected
                            ? 'border-orange-400 bg-orange-50/60 dark:border-orange-700 dark:bg-orange-950/20'
                            : 'border-zinc-200 bg-white hover:border-orange-300 hover:bg-orange-50/40 dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:border-orange-800 dark:hover:bg-orange-950/10'
                          : 'border-dashed border-zinc-300 bg-zinc-50/70 dark:border-zinc-700 dark:bg-zinc-900/30',
                      )}
                    >
                      <div
                        className={cn(
                          'flex flex-wrap items-start justify-between gap-3',
                          !usable && 'opacity-60',
                        )}
                      >
                        <div className="min-w-0">
                          <div className="text-[13.5px] font-medium text-zinc-900 dark:text-zinc-100">
                            {c.name || workEmail || c.personalEmail || 'Unnamed record'}
                          </div>
                          <div className="mt-0.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                            {workEmail ?? 'no work email on this record'}
                            {c.personalEmail && (
                              <span className="text-zinc-400 dark:text-zinc-500">
                                {' '}
                                · {c.personalEmail}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-zinc-600 dark:text-zinc-300">
                            {/* Department only ever renders through the label the
                                server formatted — never a raw hsl:* value. */}
                            <span>{c.departmentLabel ?? 'Department not on file'}</span>
                            <span>
                              {c.offDate
                                ? `Off-boarded ${formatDayOnly(c.offDate)}`
                                : 'No usable off-board date'}
                            </span>
                            <span>
                              {c.reasonLabel ??
                                (c.rawReason
                                  ? `Recorded as “${c.rawReason}”`
                                  : 'No reason recorded')}
                            </span>
                            {view.showActiveChip && (
                              /* A fact about the roster, not a verdict on this
                                 row: HR keeps a leaver on the master sheet
                                 through final pay and the off-board stamp lands
                                 on another row, so an unstamped live row is the
                                 normal shape of a recent departure. Whether a
                                 letter can be issued is the server's call
                                 above. */
                              <span
                                title="At least one master row for this address carries no off-board stamp. That is normal for a recent leaver — whether a letter can be issued is decided on the facts sheet."
                                className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
                              >
                                Still on the roster
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">
                            found by {MATCHED_COLUMN_COPY[c.matchedColumn] ?? c.matchedColumn}
                          </div>
                        </div>
                        <div className="shrink-0">
                          {usable ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                if (workEmail) void loadFacts(workEmail);
                              }}
                              disabled={factsLoading}
                              className="h-7 gap-1 border-orange-200 text-xs text-orange-700 hover:bg-orange-50 dark:border-orange-800 dark:text-orange-300 dark:hover:bg-orange-950/30"
                            >
                              <FileText className="h-3 w-3" />
                              {isSelected ? 'Reload facts' : 'Load facts'}
                            </Button>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                              <Ban className="h-3 w-3" />
                              Cannot be used
                            </span>
                          )}
                        </div>
                      </div>
                      {refusal && (
                        <p className="mt-2 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-[12px] leading-relaxed text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>{refusal}</span>
                        </p>
                      )}
                    </motion.div>
                  );
                })}
              </motion.div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Step 2 · the facts sheet ───────────────────────────────────────── */}
      {canEdit && (factsLoading || facts || factsBlocked || factsError) && (
        <motion.div
          initial={{ opacity: 0, y: reduce ? 0 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduce ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
          <Card className="border-orange-100/80 py-0 shadow-sm dark:border-orange-950/40">
            <CardHeader className="border-b border-orange-100/80 bg-orange-50/40 px-5 py-3 dark:border-orange-950/40 dark:bg-orange-950/20">
              <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
                Step 2 — check the facts
                {selected && (
                  <span className="ml-1.5 font-mono text-[11.5px] font-normal text-orange-900/65 dark:text-orange-200/70">
                    {selected}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-5">
              {factsLoading ? (
                <div className="space-y-3">
                  <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-400">
                    Reading the record
                  </p>
                  {[1, 2, 3, 4].map((i) => (
                    <div
                      key={i}
                      className="h-14 w-full animate-pulse rounded-xl bg-zinc-100 motion-reduce:animate-none dark:bg-zinc-800"
                    />
                  ))}
                </div>
              ) : factsError ? (
                <div className="flex flex-col items-center gap-3 py-10 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-lg shadow-rose-500/30">
                    <AlertTriangle className="h-6 w-6" />
                  </div>
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    The record could not be read
                  </p>
                  <p className="max-w-xl text-[12.5px] leading-relaxed text-zinc-600 dark:text-zinc-300">
                    {factsError}
                  </p>
                  {selected && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void loadFacts(selected)}
                      className="h-7 gap-1 text-xs"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Try again
                    </Button>
                  )}
                </div>
              ) : factsBlocked ? (
                <div className="flex flex-col items-center gap-3 py-10 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-lg shadow-rose-500/30">
                    <Ban className="h-6 w-6" />
                  </div>
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    No letter can be issued for this record
                  </p>
                  {/* The server's own words first; the local table is the
                      fallback, so this pane is never a bare refusal. */}
                  <p className="max-w-xl text-[12.5px] leading-relaxed text-zinc-600 dark:text-zinc-300">
                    {factsBlocked.message?.trim() || REFUSAL_COPY[factsBlocked.code]}
                  </p>
                  {factsBlocked.code === 'ambiguous_identity' &&
                    factsBlocked.candidates.length > 0 && (
                      /* Risk 7: the rep adjudicates from a list showing
                         department / off-board date / reason / active flag. The
                         master row ids stay on the server payload — a raw uuid
                         is not searchable, not readable, and every row here
                         shares the one work email, so there is no other address
                         to look up. What the rep can do is name the wrong row
                         precisely when asking HR to repair it. */
                      <div className="w-full max-w-2xl rounded-xl border border-zinc-200 bg-zinc-50/70 px-3 py-2.5 text-left dark:border-zinc-800 dark:bg-zinc-900/40">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                          {factsBlocked.candidates.length} master rows under{' '}
                          <span className="font-mono normal-case tracking-normal">
                            {factsBlocked.candidates[0]?.workEmail ?? selected}
                          </span>
                        </p>
                        <ul className="mt-1.5 space-y-1.5">
                          {factsBlocked.candidates.map((cand, i) => (
                            <li
                              key={`${cand.name ?? 'unnamed'}-${i}`}
                              className="rounded-lg border border-zinc-200 bg-white px-2.5 py-2 dark:border-zinc-800 dark:bg-zinc-900/60"
                            >
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="text-[12.5px] font-medium text-zinc-900 dark:text-zinc-100">
                                  {cand.name ?? 'Name cell empty'}
                                </span>
                                {cand.active && (
                                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                                    No off-board stamp
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-zinc-600 dark:text-zinc-300">
                                <span>{cand.departmentLabel ?? 'Department not on file'}</span>
                                <span>
                                  {cand.offDate
                                    ? `Off-boarded ${formatDayOnly(cand.offDate)}`
                                    : 'No usable off-board date'}
                                </span>
                                <span>{cand.reasonLabel ?? 'No reason recorded'}</span>
                              </div>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-1.5 text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                          These rows are equally current and they name different people, so the
                          letter has no subject. Ask HR to correct or retire the row that is wrong —
                          quoting the names, the departments and the off-board dates above — then
                          load the facts again. Nothing is picked for you here, and no letter is
                          issued until one person is left.
                        </p>
                      </div>
                    )}
                  {factsBlocked.code === 'not_a_departure' && (
                    <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
                      Stored reason:{' '}
                      <span className="font-mono text-zinc-700 dark:text-zinc-300">
                        {factsBlocked.rawReason}
                      </span>
                    </p>
                  )}
                  {factsBlocked.code === 'rehire_after_offboard' && (
                    <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
                      Off-board stamp {formatDayOnly(factsBlocked.offDate)}, start date{' '}
                      {formatDayOnly(factsBlocked.startDate)} — the start falls on or after the
                      stamp.
                    </p>
                  )}
                  {/* The row that carries the later start date is named in the
                      server's own message; this states the two dates the rep
                      has to compare. The uuid is deliberately NOT rendered from
                      here — a raw master-row id is not something a rep can
                      search or act on. */}
                  {factsBlocked.code === 'reengaged_after_departure' && (
                    <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
                      Departure {formatDayOnly(factsBlocked.offDate)}, and a master row for this
                      person starts {formatDayOnly(factsBlocked.startDate)} — after it.
                    </p>
                  )}
                  {factsBlocked.code === 'bad_name' && (
                    <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
                      Name cell holds:{' '}
                      <span className="font-mono text-zinc-700 dark:text-zinc-300">
                        {factsBlocked.rawName == null
                          ? '(empty)'
                          : `“${factsBlocked.rawName}”`}
                      </span>
                    </p>
                  )}
                </div>
              ) : facts ? (
                <div className="space-y-5">
                  {facts.degraded.length > 0 && (
                    <div className="rounded-xl border border-amber-300 bg-amber-50/70 px-3 py-2.5 dark:border-amber-500/40 dark:bg-amber-950/20">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-800 dark:text-amber-300">
                        Read partially degraded
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {facts.degraded.map((d, i) => (
                          <li
                            key={`${i}-${d}`}
                            className="text-[12px] leading-relaxed text-amber-900 dark:text-amber-200"
                          >
                            {d}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1 text-[11.5px] italic text-amber-800/80 dark:text-amber-300/70">
                        A fact shown as blank below may exist in a source that did not answer. Check
                        before you type over it.
                      </p>
                    </div>
                  )}

                  {/* Resolved facts — read-only, each with its source. */}
                  <div>
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-orange-700 dark:text-orange-300">
                      Resolved by the system
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      <FactRow
                        label="Legal name"
                        value={facts.workerName}
                        source={
                          facts.identity.onCurrentUpload
                            ? 'the master-list row on the current upload'
                            : 'the newest master-list row carrying this work email'
                        }
                      />
                      <FactRow
                        label="Work email"
                        value={facts.identity.workEmail}
                        source="the identity you picked"
                        mono
                      />
                      {facts.identity.personalEmail && (
                        <FactRow
                          label="Personal email"
                          value={facts.identity.personalEmail}
                          source="the same master-list row"
                          mono
                        />
                      )}
                      {facts.terminationDate && (
                        <FactRow
                          label="Off-board date"
                          value={facts.terminationDateLabel ?? formatDayOnly(facts.terminationDate)}
                          source={OFF_DATE_SOURCE_COPY[facts.identity.offDateSource]}
                        />
                      )}
                      {facts.reasonLabel && (
                        <FactRow
                          label="Departure reason"
                          value={facts.reasonLabel}
                          source={OFF_DATE_SOURCE_COPY[facts.identity.offDateSource]}
                        />
                      )}
                      {facts.endingDepartmentLabel && (
                        <FactRow
                          label="Department at departure"
                          value={facts.endingDepartmentLabel}
                          source="the master-list Department cell"
                        />
                      )}
                      {facts.startDate && (
                        <FactRow
                          label="Start date"
                          value={facts.startDateLabel ?? formatDayOnly(facts.startDate)}
                          source="the master-list Start Date cell"
                        />
                      )}
                      {facts.startingRate.amount != null && (
                        <FactRow
                          label="Starting rate"
                          value={formatMoney(facts.startingRate.amount, facts.startingRate.currency)}
                          source={
                            facts.startingRate.source
                              ? RATE_SOURCE_COPY[facts.startingRate.source]
                              : 'an unrecorded source'
                          }
                          mono
                        />
                      )}
                      {facts.endingRate.amount != null && (
                        <FactRow
                          label="Ending rate"
                          value={formatMoney(facts.endingRate.amount, facts.endingRate.currency)}
                          source={
                            facts.endingRate.source
                              ? RATE_SOURCE_COPY[facts.endingRate.source]
                              : 'an unrecorded source'
                          }
                          mono
                        />
                      )}
                    </div>
                  </div>

                  {/* Blanks — one required input each. */}
                  {facts.blanks.length > 0 && (
                    <div>
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
                        {facts.blanks.length} fact{facts.blanks.length === 1 ? '' : 's'} the system
                        could not find — you supply {facts.blanks.length === 1 ? 'it' : 'them'}
                      </p>
                      <p className="mb-2 text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                        A blank is normal for an older leaver. Each one is recorded on the signed
                        letter as rep-supplied, under your name.
                      </p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {facts.blanks.map((field) => {
                          const raw = draft[field] ?? '';
                          const err = blankError(field, raw);
                          const rate =
                            field === 'starting_rate'
                              ? facts.startingRate
                              : field === 'ending_rate'
                                ? facts.endingRate
                                : null;
                          const inputId = `termination-blank-${field}`;
                          /** Narrowed once, so the currency draft is keyed by a
                           *  MONEY field and never by a date or a department. */
                          const rateField: RateBlankField | null =
                            field === 'starting_rate'
                              ? 'starting_rate'
                              : field === 'ending_rate'
                                ? 'ending_rate'
                                : null;
                          const pickedCurrency = rateField ? currencyDraft[rateField] : undefined;
                          const rateCurrency = effectiveRateCurrency(rate, pickedCurrency);
                          return (
                            <div
                              key={field}
                              className="rounded-xl border border-amber-200 bg-amber-50/50 px-3 py-3 dark:border-amber-500/30 dark:bg-amber-950/15"
                            >
                              <label
                                htmlFor={inputId}
                                className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-800 dark:text-amber-300"
                              >
                                {BLANK_LABEL[field]}
                                <span className="ml-1 text-amber-600 dark:text-amber-400">
                                  · required
                                </span>
                              </label>
                              <p className="mt-0.5 text-[11px] leading-relaxed text-amber-900/80 dark:text-amber-200/70">
                                Blank because{' '}
                                {rate?.blankReason
                                  ? BLANK_REASON_COPY[rate.blankReason]
                                  : 'nothing usable was on file in any source'}
                                .
                              </p>
                              <div className="mt-2">
                                {field === 'termination_date' || field === 'start_date' ? (
                                  <DatePicker
                                    id={inputId}
                                    value={raw}
                                    onChange={(iso) => setDraftField(field, iso)}
                                    /* An off-board date past tomorrow is nulled
                                       server-side, so the picker never offers one. */
                                    max={field === 'termination_date' ? maxOffDate : undefined}
                                    placeholder="Pick the day"
                                    aria-label={BLANK_LABEL[field]}
                                    className="h-9 border-zinc-200 bg-white text-sm dark:border-zinc-800 dark:bg-zinc-900/60"
                                  />
                                ) : field === 'reason' ? (
                                  <select
                                    id={inputId}
                                    value={raw}
                                    onChange={(e) => setDraftField(field, e.target.value)}
                                    aria-label="Departure reason"
                                    className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-800 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-200"
                                  >
                                    <option value="">Choose a reason…</option>
                                    {TERMINATION_DEPARTURE_REASONS.map((r) => (
                                      <option key={r} value={r}>
                                        {OFFBOARD_REASON_LABELS[r] ?? r}
                                      </option>
                                    ))}
                                  </select>
                                ) : rate ? (
                                  <div className="flex items-center gap-2">
                                    {/* The currency the SERVER resolved for this
                                        rate — shown, not chosen, and never assumed
                                        to be pesos. It is a PICKER only when the
                                        record states no currency at all (the
                                        Payment Catalog read failed): an amount
                                        with no unit can never be printed, so the
                                        rep states it rather than the code guessing
                                        pesos. */}
                                    {rate.currency ? (
                                      <span
                                        className="inline-flex h-9 shrink-0 items-center rounded-md border border-zinc-200 bg-zinc-50 px-2.5 font-mono text-[12px] font-semibold text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                                        title={`Currency recorded for this rate: ${rate.currency}`}
                                      >
                                        {CURRENCY_SYMBOL[rate.currency]} {rate.currency}
                                      </span>
                                    ) : (
                                      <select
                                        value={pickedCurrency ?? ''}
                                        onChange={(e) => {
                                          const next = e.target.value;
                                          if (!rateField) return;
                                          setCurrencyDraft((d) => {
                                            const patch: RateCurrencyDraft = { ...d };
                                            // Anything outside the union clears the
                                            // pick rather than being stored: the
                                            // route validates it again anyway, and a
                                            // cleared pick keeps the button disabled.
                                            patch[rateField] = isTerminationCurrency(next)
                                              ? next
                                              : undefined;
                                            return patch;
                                          });
                                        }}
                                        aria-label={`Currency for the ${BLANK_LABEL[field].toLowerCase()}`}
                                        title="The record does not state a currency for this rate — choose the one it was paid in."
                                        className="h-9 shrink-0 rounded-md border border-amber-300 bg-white px-2 font-mono text-[12px] font-semibold text-zinc-700 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 dark:border-amber-500/40 dark:bg-zinc-900/60 dark:text-zinc-200"
                                      >
                                        <option value="">Currency…</option>
                                        {TERMINATION_CURRENCIES.map((c) => (
                                          <option key={c} value={c}>
                                            {CURRENCY_SYMBOL[c]} {c}
                                          </option>
                                        ))}
                                      </select>
                                    )}
                                    <Input
                                      id={inputId}
                                      value={raw}
                                      onChange={(e) => setDraftField(field, e.target.value)}
                                      inputMode="decimal"
                                      placeholder="0.00"
                                      aria-label={
                                        rateCurrency
                                          ? `${BLANK_LABEL[field]} in ${rateCurrency}`
                                          : `${BLANK_LABEL[field]} — choose a currency first`
                                      }
                                      className="h-9 border-zinc-200 bg-white text-sm focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900/60"
                                    />
                                  </div>
                                ) : (
                                  <Input
                                    id={inputId}
                                    value={raw}
                                    onChange={(e) => setDraftField(field, e.target.value)}
                                    placeholder="e.g. HSL — Intake Specialist"
                                    aria-label={BLANK_LABEL[field]}
                                    maxLength={120}
                                    className="h-9 border-zinc-200 bg-white text-sm focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900/60"
                                  />
                                )}
                              </div>
                              {raw.trim().length > 0 && err && (
                                <p className="mt-1.5 text-[11.5px] font-medium text-rose-600 dark:text-rose-400">
                                  {err}
                                </p>
                              )}
                              {rate && !rateCurrency && raw.trim().length > 0 && (
                                <p className="mt-1.5 text-[11.5px] font-medium text-rose-600 dark:text-rose-400">
                                  Choose the currency this rate was paid in — a figure with no
                                  currency cannot be printed or stored.
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Blank-only write-back opt-in. */}
                  <div className="flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-white px-3 py-3 dark:border-zinc-800 dark:bg-zinc-900/50">
                    {/* The Checkbox renders a role="checkbox" SPAN, not an
                        input, so `htmlFor` would associate with nothing —
                        aria-labelledby is the only correct wiring here. */}
                    <Checkbox
                      checked={writeBack}
                      onCheckedChange={(c) => setWriteBack(c === true)}
                      disabled={!canEdit}
                      aria-labelledby="termination-writeback-label"
                      className="mt-0.5"
                    />
                    <div
                      id="termination-writeback-label"
                      className="min-w-0 text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300"
                    >
                      <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                        Also save what I typed back into the master list
                      </span>
                      <span className="mt-1 block text-zinc-600 dark:text-zinc-400">
                        Writes whichever of the off-board date, the off-board reason and the Start
                        Date <strong className="font-semibold">you filled in above</strong>, and{' '}
                        <strong className="font-semibold">
                          only into cells that are empty right now
                        </strong>
                        . A fact the system already resolved is never re-written, a cell holding
                        anything at all is left exactly as it is and reported back to you as
                        skipped, and Department and every rate are never written — a rate you type
                        lives only on this document. Each write is recorded on the log row with its
                        previous value, so engineering can reverse it with the revert script. In the
                        one case where a cell is written but that record cannot be saved, this
                        screen names the row and the value and keeps naming them until you say the
                        cell has been cleared by hand. There is no undo button here.
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200/70 pt-4 dark:border-zinc-800/70">
                    <div className="min-w-0 text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                      {orderError ? (
                        <span className="font-medium text-rose-600 dark:text-rose-400">
                          {orderError}
                        </span>
                      ) : missingBlanks.length > 0 ? (
                        <>Still needed: {missingBlanks.map((b) => BLANK_LABEL[b]).join(', ')}.</>
                      ) : missingRateCurrencies.length > 0 ? (
                        <>
                          Still needed: a currency for{' '}
                          {missingRateCurrencies.map((b) => BLANK_LABEL[b].toLowerCase()).join(' and ')}.
                          The record does not state one, and an amount with no currency cannot be
                          printed on a legal document.
                        </>
                      ) : (
                        <>
                          Everything the letter prints is filled in. Generating signs it with your
                          saved signature straight away.
                        </>
                      )}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => setConfirmOpen(true)}
                      disabled={!readyToGenerate}
                      className="h-9 shrink-0 gap-1.5 bg-orange-500 text-xs font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
                    >
                      <FileSignature className="h-3.5 w-3.5" />
                      Generate the letter
                    </Button>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* ── The permanent log ──────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <LogStat
          Icon={FileText}
          tone="orange"
          label="Letters listed"
          value={logLoading ? null : logStats.listed.toLocaleString('en-US')}
          sub={
            logStats.people === 0
              ? 'nothing issued yet'
              : `${logStats.people} ${logStats.people === 1 ? 'person' : 'people'}`
          }
        />
        <LogStat
          Icon={FileSignature}
          tone="sky"
          label="Issued this month"
          value={logLoading ? null : logStats.thisMonth.toLocaleString('en-US')}
          sub="signed at generation"
        />
        <LogStat
          Icon={PencilLine}
          tone="amber"
          label="Rep-supplied facts"
          value={logLoading ? null : logStats.repFilled.toLocaleString('en-US')}
          sub="letters with a hand-filled fact"
        />
        <LogStat
          Icon={RefreshCw}
          tone="sky"
          label="Master write-backs"
          value={logLoading ? null : logStats.writtenBack.toLocaleString('en-US')}
          sub="reversible cell fills"
        />
      </div>

      <Card className="overflow-hidden border-orange-100/80 py-0 shadow-sm dark:border-orange-950/40">
        <CardHeader className="gap-3 border-b border-orange-100/80 bg-orange-50/40 px-5 py-3 dark:border-orange-950/40 dark:bg-orange-950/20">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
              {logLoading
                ? 'Loading…'
                : `${logMatches.length} letter${logMatches.length === 1 ? '' : 's'} issued`}
              {!logLoading && logQuery.trim() && (
                <span className="ml-1.5 font-normal text-orange-900/65 dark:text-orange-200/70">
                  matching &ldquo;{logQuery.trim()}&rdquo;
                </span>
              )}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[220px]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                {/* Only the three columns the LOG ROUTE actually matches are
                    promised here: `listTerminationDocuments` ilikes work_email,
                    personal_email and worker_name and nothing else, so a reason
                    or a rep name typed here would come back from the server as
                    zero rows and read as "no such letter". The client-side
                    narrowing below is a superset of these three; it can only
                    ever filter rows the server already returned. */}
                <Input
                  value={logQuery}
                  onChange={(e) => setLogQuery(e.target.value)}
                  placeholder="Search a name, a work email or a personal email…"
                  aria-label="Search the termination letter log by name or email"
                  className="h-9 border-zinc-200 bg-white pl-9 pr-8 text-sm focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900/60"
                />
                {logQuery && (
                  <button
                    type="button"
                    onClick={() => setLogQuery('')}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void fetchLog({ q: logQuery })}
                disabled={logLoading || logBusy}
                className="h-9 gap-1.5 border-orange-200 text-orange-700 hover:bg-orange-50 dark:border-orange-800 dark:text-orange-300"
              >
                <RefreshCw
                  className={cn('h-3.5 w-3.5', (logLoading || logBusy) && 'animate-spin')}
                />
                Refresh
              </Button>
            </div>
          </div>
          <p className="text-[11.5px] leading-relaxed text-orange-900/70 dark:text-orange-200/70">
            Permanent by design — a generated letter is never removed from this log, so there is no
            delete here.
            {logTruncated && ' This page does not hold every row yet; narrow it with the search box.'}
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {logLoading ? (
            <div className="space-y-2 p-5">
              {[1, 2, 3, 4, 5].map((i) => (
                <div
                  key={i}
                  className="h-10 w-full animate-pulse rounded-lg bg-zinc-100 motion-reduce:animate-none dark:bg-zinc-800"
                />
              ))}
            </div>
          ) : logError ? (
            <div className="flex flex-col items-center gap-2 py-14 text-center text-sm text-rose-600 dark:text-rose-400">
              <AlertTriangle className="h-6 w-6" />
              {logError}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void fetchLog({ q: logQuery })}
                className="h-7 gap-1 text-xs"
              >
                <RefreshCw className="h-3 w-3" />
                Try again
              </Button>
            </div>
          ) : logMatches.length === 0 && logQuery.trim() ? (
            /* No-results (ui-standards §12.2) — distinct from the empty log below. */
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-zinc-400 to-zinc-500 text-white shadow-md">
                <SearchX className="h-6 w-6" />
              </div>
              <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                No letter in the log matches that
              </p>
              <p className="font-mono text-[11.5px]">
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  {logQuery.trim()}
                </span>
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setLogQuery('')}
                className="h-7 text-xs"
              >
                Clear search
              </Button>
            </div>
          ) : logMatches.length === 0 ? (
            /* Empty (ui-standards §12.1) — an empty termination log is good news. */
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-500 text-white shadow-md">
                <Sparkles className="h-6 w-6" />
              </div>
              <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                No termination letters have been issued
              </p>
              <p className="max-w-md text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                {canEdit
                  ? 'Nobody has needed one yet. Search for someone above to issue the first.'
                  : 'Nobody has needed one yet.'}
              </p>
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <table className="w-full min-w-[1080px] text-left text-sm">
                <thead className="border-b border-orange-100/80 bg-orange-50/30 text-[10px] font-semibold uppercase tracking-[0.12em] text-orange-900/60 dark:border-orange-950/40 dark:bg-orange-950/10 dark:text-orange-200/65">
                  <tr>
                    <th className="px-4 py-2.5">Person</th>
                    <th className="px-4 py-2.5">Printed on the letter</th>
                    <th className="px-4 py-2.5">Department</th>
                    <th className="px-4 py-2.5">Rate start &rarr; end</th>
                    <th className="px-4 py-2.5">Issued</th>
                    <th className="px-4 py-2.5">Provenance</th>
                    <th className="px-4 py-2.5 text-right">Document</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-orange-100/70 dark:divide-orange-950/40">
                  {logMatches.map((r) => {
                    const mine =
                      !!sessionEmail &&
                      (r.generated_by ?? '').toLowerCase() === sessionEmail.toLowerCase();
                    const repFilled = (r.filled_by_rep ?? []).length;
                    const wrote = (r.field_writebacks ?? []).length;
                    // Cells this letter changed that no script can put back. The
                    // banner above carries the instruction; this marks the row it
                    // belongs to, and it survives a reload because the list is
                    // stored in the browser rather than derived from the
                    // response — the row cannot carry a record that never
                    // reached the database.
                    const repairsForRow = repairsByDocument.get(r.id) ?? [];
                    return (
                      <tr
                        key={r.id}
                        className={cn(
                          'align-top transition-colors hover:bg-orange-50/40 dark:hover:bg-orange-950/10',
                          repairsForRow.length > 0 &&
                            'bg-rose-50/70 hover:bg-rose-50 dark:bg-rose-950/20 dark:hover:bg-rose-950/30',
                        )}
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium text-zinc-900 dark:text-zinc-100">
                            {r.worker_name}
                          </div>
                          <div className="font-mono text-[11px] text-zinc-400">{r.work_email}</div>
                          {r.personal_email && (
                            <div className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                              {r.personal_email}
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-600 dark:text-zinc-300">
                          <div>{formatDayOnly(r.termination_date)}</div>
                          <div className="text-[11px] text-zinc-400">{r.reason_label}</div>
                          {r.start_date && (
                            <div className="text-[11px] text-zinc-400">
                              from {formatDayOnly(r.start_date)}
                            </div>
                          )}
                        </td>
                        <td className="max-w-[220px] px-4 py-3 text-xs text-zinc-600 dark:text-zinc-300">
                          {/* Only the formatted label the server stored. */}
                          {r.ending_department_label}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 font-mono text-[11.5px] text-zinc-600 dark:text-zinc-300">
                          {formatMoney(r.starting_rate, r.starting_rate_currency)}
                          <span className="mx-1 text-zinc-400">&rarr;</span>
                          {formatMoney(r.ending_rate, r.ending_rate_currency)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-600 dark:text-zinc-300">
                          <div>{formatDocumentDateTime(r.generated_at)}</div>
                          <div className="text-[11px] text-zinc-400">
                            {formatRelativeTime(r.generated_at)}
                          </div>
                          <div className="text-[11px] text-zinc-400">
                            by {r.generated_by_name || r.generated_by}
                            {mine ? ' (you)' : ''}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-1">
                            {repFilled > 0 && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                                {repFilled} rep-filled
                              </span>
                            )}
                            {wrote > 0 && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
                                {wrote} written back
                              </span>
                            )}
                            {repairsForRow.length > 0 && (
                              <span
                                title={repairsForRow
                                  .map(
                                    (rep) =>
                                      `${rep.column} on global_master_list.id ${rep.masterRowId || '(not reported)'} — restore to blank`,
                                  )
                                  .join(' · ')}
                                className="inline-flex items-center gap-1 rounded-full border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300"
                              >
                                <AlertTriangle className="h-3 w-3" />
                                {repairsForRow.length} to revert by hand
                              </span>
                            )}
                          </div>
                          <div className="mt-1 font-mono text-[10.5px] text-zinc-400">
                            {shortReferenceId(r.id)} · {formatFileSize(r.file_size)}
                          </div>
                        </td>
                        {/* No delete action, by design — see the header note. */}
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void download(r)}
                              disabled={downloadingId === r.id}
                              className="h-7 gap-1 border-orange-200 text-xs text-orange-700 hover:bg-orange-50 dark:border-orange-900/50 dark:text-orange-300 dark:hover:bg-orange-950/30"
                            >
                              {downloadingId === r.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Download className="h-3 w-3" />
                              )}
                              Download
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Confirm dialog ─────────────────────────────────────────────────── */}
      <Dialog open={confirmOpen} onOpenChange={(o) => !o && setConfirmOpen(false)}>
        <DialogContent className="max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain sm:max-h-[92dvh] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Generate and sign this termination letter?</DialogTitle>
            <DialogDescription>
              It is signed with your saved signature the moment it is generated. There is no draft
              step, no edit and no delete — the letter and its log row are permanent.
            </DialogDescription>
          </DialogHeader>
          {facts && (
            <div className="space-y-3 text-sm">
              <div className="space-y-1 rounded-xl border border-zinc-200 bg-zinc-50/70 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <ConfirmRow label="Person" value={facts.workerName} />
                <ConfirmRow label="Work email" value={facts.identity.workEmail} mono />
                <ConfirmRow label="Off-board date" value={formatDayOnly(effectiveOffDate)} />
                <ConfirmRow label="Reason printed" value={effectiveReasonLabel ?? '—'} />
                <ConfirmRow label="Department printed" value={effectiveDeptLabel ?? '—'} />
              </div>
              <p className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Signed immediately and permanent. The lines above print verbatim on a legal page
                under your signature — check the date and the reason now, because they cannot be
                corrected afterwards.
              </p>

              {prior.loading ? (
                <p className="flex items-center gap-2 text-[12px] text-zinc-500 dark:text-zinc-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Checking the log for earlier letters…
                </p>
              ) : prior.failed ? (
                <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50/70 px-3 py-2.5 text-[12px] leading-relaxed text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/20 dark:text-amber-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  The log read failed, so whether this person already has a letter could not be
                  checked. Generating still records this one.
                </p>
              ) : prior.rows.length > 0 ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50/70 px-3 py-2.5 dark:border-amber-500/40 dark:bg-amber-950/20">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-800 dark:text-amber-300">
                    {prior.rows.length} letter{prior.rows.length === 1 ? '' : 's'} already issued for
                    this person
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {prior.rows.map((p) => (
                      <li
                        key={p.id}
                        className="text-[12px] leading-relaxed text-amber-900 dark:text-amber-200"
                      >
                        {formatDocumentDateTime(p.generated_at)} — {p.reason_label}, off-boarded{' '}
                        {formatDayOnly(p.termination_date)}, by{' '}
                        {p.generated_by_name || p.generated_by}
                      </li>
                    ))}
                  </ul>
                  {prior.truncated && (
                    <p className="mt-1.5 text-[11px] italic text-amber-800/80 dark:text-amber-300/70">
                      The log runs past one page, so there may be older letters not listed here.
                    </p>
                  )}
                  <p className="mt-1.5 text-[12px] leading-relaxed text-amber-900 dark:text-amber-200">
                    A second letter is allowed and both stay in the log for good. Generate only if
                    you mean to issue another one.
                  </p>
                </div>
              ) : null}

              {writeBack && (
                <p className="rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-[12px] leading-relaxed text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300">
                  Whichever of the off-board date, the off-board reason and the Start Date you
                  filled in above will also be written into the master list, and only where that
                  cell is empty right now. Anything already holding a value is left alone and
                  reported back to you.
                </p>
              )}

              {signatureBlocked && (
                <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50/70 px-3 py-2.5 text-[12px] leading-relaxed text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/20 dark:text-amber-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {!signature
                    ? 'You have no signature on file, and this letter is signed at generation — set one up first.'
                    : 'Your signature is switched off, and this letter is signed at generation — switch it back on first.'}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={generating}
            >
              Cancel
            </Button>
            {/* Dialogs portal outside the read-only wrapper, so every mutating
                control in here is gated on canEdit independently. */}
            {canEdit &&
              (signatureBlocked ? (
                <Button
                  type="button"
                  onClick={() => {
                    setConfirmOpen(false);
                    onSetUpSignature();
                  }}
                  className="gap-1.5 bg-orange-500 text-white hover:bg-orange-600"
                >
                  <PenLine className="h-3.5 w-3.5" />
                  Set up signature
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={() => void generate()}
                  disabled={generating || !readyToGenerate}
                  className="gap-1.5 bg-orange-500 text-white hover:bg-orange-600"
                >
                  {generating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileSignature className="h-3.5 w-3.5" />
                  )}
                  Generate &amp; sign
                </Button>
              ))}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Acknowledge the hand-repair, THEN the letter opens ──────────────
          `window.open` moves the browser to another tab, and firing it first is
          exactly how this state used to go unseen. The letter is already
          generated, stored and logged — it is downloadable from the log
          whatever happens here — so nothing is lost by holding the new tab back
          until the rep has read which cell has to be put back. Closing without
          acknowledging simply does not open it; the banner behind this dialog
          stays either way. */}
      <Dialog
        open={repairPrompt !== null}
        onOpenChange={(o) => {
          if (!o) setRepairPrompt(null);
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain sm:max-h-[92dvh] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>The letter is issued — a master-list cell needs your hand</DialogTitle>
            <DialogDescription>
              The write-back changed the master list and its undo record could not be saved onto the
              document row. The revert script reads that record, so it cannot see this change:
              nothing can reverse it automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <ul className="space-y-2">
              {(repairPrompt?.repairs ?? []).map((r) => (
                <li
                  key={manualRepairKey(r)}
                  className="rounded-xl border border-rose-300 bg-rose-50/70 px-3 py-2.5 dark:border-rose-500/40 dark:bg-rose-950/25"
                >
                  <p className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100">
                    {r.workerName || r.workEmail} — {WRITEBACK_COLUMN_COPY[r.column] ?? r.column}
                  </p>
                  <p className="mt-1 break-all font-mono text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                    global_master_list.id = {r.masterRowId || '(not reported)'}
                  </p>
                  <p className="mt-0.5 break-all font-mono text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                    {r.column} = {r.wroteValue ?? '(the value printed on the letter)'}{' '}
                    <span className="text-rose-700 dark:text-rose-300">→ restore to blank</span>
                  </p>
                </li>
              ))}
            </ul>
            <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-300">
              Each cell was empty before this letter — the write-back only ever fills an empty cell
              — so putting it back means clearing it in People, or asking HR to. This list stays on
              the screen behind this dialog, and in this browser after a reload, until you mark it
              done.
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                const url = repairPrompt?.url ?? null;
                setRepairPrompt(null);
                if (url) window.open(url, '_blank', 'noopener,noreferrer');
              }}
              className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700"
            >
              {repairPrompt?.url
                ? 'I have noted this — open the letter'
                : 'I have noted this'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Local pieces ─────────────────────────────────────────────────────────────

/** One resolved fact: the value plus where it came from. The source is shown for
 *  the rep's judgement only — the PDF never prints it. */
function FactRow({
  label,
  value,
  source,
  mono,
}: {
  label: string;
  value: string;
  source: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/50">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
        {label}
      </p>
      <p
        className={cn(
          'mt-0.5 break-words text-[13.5px] font-semibold text-zinc-900 dark:text-zinc-100',
          mono && 'font-mono text-[12px]',
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[10.5px] leading-snug text-zinc-400 dark:text-zinc-500">
        from {source}
      </p>
    </div>
  );
}

function ConfirmRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="text-[12.5px] leading-relaxed">
      <span className="text-zinc-500 dark:text-zinc-400">{label}:</span>{' '}
      <span
        className={cn(
          'font-medium text-zinc-800 dark:text-zinc-200',
          mono && 'font-mono text-[11.5px]',
        )}
      >
        {value}
      </span>
    </div>
  );
}

type LogStatTone = 'orange' | 'amber' | 'sky';

/** Duplicate of the queue's `DocStat` tile (ui-standards §6.3). The original is
 *  file-private in AccountingDocuments.tsx and exporting it would mean editing a
 *  pre-existing line, so the palette is copied instead. Amber stays reserved for
 *  caution — it is never used here to mean "termination". */
const LOG_STAT_PALETTE: Record<LogStatTone, { ring: string; icon: string; text: string }> = {
  orange: {
    ring: 'from-orange-200/40 to-rose-200/40 dark:from-orange-900/25 dark:to-rose-900/20',
    icon: 'from-orange-500 to-rose-500',
    text: 'text-orange-700 dark:text-orange-300',
  },
  amber: {
    ring: 'from-amber-200/40 to-orange-200/40 dark:from-amber-900/25 dark:to-orange-900/20',
    icon: 'from-amber-500 to-orange-500',
    text: 'text-amber-700 dark:text-amber-300',
  },
  sky: {
    ring: 'from-sky-200/40 to-blue-200/40 dark:from-sky-900/25 dark:to-blue-900/20',
    icon: 'from-sky-500 to-blue-500',
    text: 'text-sky-700 dark:text-sky-300',
  },
};

function LogStat({
  Icon,
  tone,
  label,
  value,
  sub,
}: {
  Icon: ComponentType<{ className?: string }>;
  tone: LogStatTone;
  label: string;
  /** `null` while the log is still loading — pulses in place. */
  value: string | null;
  sub: string;
}) {
  const palette = LOG_STAT_PALETTE[tone];
  return (
    <div className="relative overflow-hidden rounded-xl border border-white/60 bg-white/70 p-3 shadow-sm backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-900/60">
      <div
        className={cn('absolute inset-0 bg-gradient-to-br opacity-60', palette.ring)}
        aria-hidden
      />
      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={cn('text-[9px] font-semibold uppercase tracking-[0.14em]', palette.text)}>
            {label}
          </div>
          {value == null ? (
            <div className="mt-1.5 h-6 w-14 animate-pulse rounded bg-zinc-200/80 motion-reduce:animate-none dark:bg-zinc-700/60" />
          ) : (
            <div className="mt-0.5 font-mono text-xl font-bold tabular-nums tracking-tight text-zinc-900 sm:text-2xl dark:text-zinc-100">
              {value}
            </div>
          )}
          <div className="mt-0.5 truncate text-[10px] text-zinc-500 dark:text-zinc-400" title={sub}>
            {sub}
          </div>
        </div>
        <div
          className={cn(
            'hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white sm:flex',
            palette.icon,
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
}
