/**
 * Cycle close-out — Accounting declaring a pay week finished from Payment
 * Dispatch, including when money is still owed.
 *
 * ── Why this is NOT a published pay-cycle report ────────────────────────────
 * Accounting → Documents → Reports already freezes a cycle
 * (`documents.pay_cycle_report.<source_file>`), but only when the cycle is
 * genuinely complete: condition 1 of that gate requires zero not-paid /
 * threshold / problem / never-dispatched rows, precisely so a report can never
 * claim a week was settled while someone is owed money
 * (docs/features/documents-tab.md § "The completeness rule"). Kane's ask —
 * close the cycle and record it *even though N payable people were not paid* —
 * cannot ride that gate without relaxing it, and relaxing it is the one thing
 * that feature exists to prevent.
 *
 * So this is a different artifact with a different promise. A close-out says
 * "Accounting stopped processing this week on this date, this is what had gone
 * out, and these payable people had NOT been paid". It never pretends the week
 * was complete, and it leaves the publish gate untouched: a cycle that is
 * genuinely 100% can still be published as a real frozen report afterwards.
 *
 * ── Frozen headline, live detail ────────────────────────────────────────────
 * The paid TOTALS are frozen here (they are the numbers the clerk approved at
 * close time, and they must survive a later undo). The per-payee paid rows are
 * NOT copied: Payment Dispatch → Reports renders those live from
 * `payment_dispatches` and always has. Duplicating 800+ rows into a settings
 * value would add a second copy that can silently disagree with the first.
 *
 * The unpaid list is the opposite case and IS stored, because it cannot be
 * re-derived later: "payable but unpaid" is a fact about Payment Dispatch's
 * client-side queue (rates × staged paystubs × contractor invoices × the
 * Excluded carve-out), which no server-side table reproduces —
 * `disbursement_records` does not know who Accounting excluded.
 *
 * Storage: ONE `app_settings` row per cycle, `dispatch.cycle_closeout.<file>`.
 * No DDL, no migration, no deploy step — same reasoning as the pay-cycle
 * report, and the same reason it can ship without Kane running SQL.
 */

import { tallyPaidDispatches, type PayCycleDispatchLike } from '@/lib/accounting/pay-cycle-report-snapshot';

/** Bumped only if the stored shape changes incompatibly. Readers tolerate
 *  unknown versions (missing fields fall back) rather than throwing. */
export const CYCLE_CLOSEOUT_VERSION = 1;

export const CYCLE_CLOSEOUT_PREFIX = 'dispatch.cycle_closeout.';

export function cycleCloseoutKey(sourceFile: string): string {
  return `${CYCLE_CLOSEOUT_PREFIX}${sourceFile}`;
}

/**
 * Hard cap on stored unpaid rows. A week closed very early could carry the whole
 * roster, and one settings value should not grow without bound. Whatever the cap
 * drops is counted in `unpaid.truncated` and rendered — a silent truncation
 * would read as "that's everyone", which is the exact lie this record exists to
 * avoid.
 */
export const MAX_STORED_UNPAID = 1000;

/** Why this payable person did not get paid, in Payment Dispatch's own terms. */
export type CycleCloseoutUnpaidReason =
  /** Still sitting in the pending queue — never dispatched at all. */
  | 'pending'
  /** Logged Problem: out of the queue, money stuck, needs fixing. */
  | 'problem'
  /** Logged Threshold: deliberately held under the payout minimum this week. */
  | 'threshold';

export interface CycleCloseoutUnpaidPayee {
  name: string | null;
  email: string;
  payeeType: 'employee' | 'contractor';
  reason: CycleCloseoutUnpaidReason;
  amountUSD: number | null;
  amountPHP: number | null;
  processor: string | null;
}

export interface CycleCloseoutPaidTotals {
  /** Distinct employee emails + one per contractor invoice — Payment Dispatch's
   *  own headline rule, via the shared `tallyPaidDispatches`. */
  payeeCount: number;
  employeeCount: number;
  contractorCount: number;
  /** Raw paid row count (≥ payeeCount when someone was paid twice). */
  dispatchCount: number;
  paidUSD: number;
  paidPHP: number;
}

export interface CycleCloseoutUnpaid {
  /**
   * Where the list came from. `dispatch_screen` means the clerk's Payment
   * Dispatch queue reported it at close time — the server cannot re-derive it
   * (see the header). Recorded explicitly so a reader never mistakes it for a
   * server-authoritative figure the way `paid` is.
   */
  source: 'dispatch_screen';
  count: number;
  employeeCount: number;
  contractorCount: number;
  totalUSD: number;
  totalPHP: number;
  payees: CycleCloseoutUnpaidPayee[];
  /** Rows the MAX_STORED_UNPAID cap dropped. Counted, never silent. */
  truncated: number;
  /** Entries rejected at the boundary as malformed. Counted, never silent. */
  dropped: number;
}

/**
 * Server-side cross-check from `disbursement_records` — the same table the
 * publish gate's condition 1 reads. It counts people Payment Dispatch holds in
 * Excluded too, so it is normally LARGER than `unpaid.count`; it is stored for
 * audit, never shown as the headline. `null` when the read failed, which is
 * recorded rather than silently treated as zero.
 */
export interface CycleCloseoutRecordsOutstanding {
  notPaid: number;
  threshold: number;
  problem: number;
  neverDispatched: number;
  total: number;
}

export interface CycleCloseoutRecord {
  version: number;
  closed_at: string;
  closed_by: string;
  closed_by_email: string;
  source_file: string;
  cycle_id: string | null;
  label: string;
  period_start: string | null;
  period_end: string | null;
  paid: CycleCloseoutPaidTotals;
  byProcessor: Record<string, { count: number; usd: number; php: number }>;
  unpaid: CycleCloseoutUnpaid;
  records_outstanding: CycleCloseoutRecordsOutstanding | null;
}

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function optionalNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function trimOrNull(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

const REASONS: readonly CycleCloseoutUnpaidReason[] = ['pending', 'problem', 'threshold'];

/**
 * Validate the client-reported unpaid list at the boundary.
 *
 * An entry with no email is dropped rather than repaired: email is the only key
 * that makes a row traceable back to a person, and a nameless, emailless row in
 * a permanent record is worse than an honest "1 entry dropped". Every drop is
 * counted so the caller can surface it.
 */
export function normalizeReportedUnpaid(raw: unknown): {
  payees: CycleCloseoutUnpaidPayee[];
  truncated: number;
  dropped: number;
} {
  if (!Array.isArray(raw)) return { payees: [], truncated: 0, dropped: 0 };

  const payees: CycleCloseoutUnpaidPayee[] = [];
  let dropped = 0;

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      dropped += 1;
      continue;
    }
    const e = entry as Record<string, unknown>;
    const email = trimOrNull(e.email, 320)?.toLowerCase() ?? null;
    if (!email) {
      dropped += 1;
      continue;
    }
    const reason = REASONS.includes(e.reason as CycleCloseoutUnpaidReason)
      ? (e.reason as CycleCloseoutUnpaidReason)
      : 'pending';
    payees.push({
      name: trimOrNull(e.name, 160),
      email,
      payeeType: e.payeeType === 'contractor' ? 'contractor' : 'employee',
      reason,
      amountUSD: optionalNum(e.amountUSD),
      amountPHP: optionalNum(e.amountPHP),
      processor: trimOrNull(e.processor, 40),
    });
  }

  // Biggest money first — if the cap ever bites, the rows it keeps are the ones
  // worth chasing.
  payees.sort((a, b) => (b.amountPHP ?? 0) - (a.amountPHP ?? 0));

  const truncated = Math.max(0, payees.length - MAX_STORED_UNPAID);
  return { payees: payees.slice(0, MAX_STORED_UNPAID), truncated, dropped };
}

/**
 * Build the record. The paid half is computed HERE from the cycle's dispatch
 * rows via the shared `tallyPaidDispatches` — never taken from the client — so
 * the frozen headline is the same rule Payment Dispatch, the publish card and
 * the published report all count by.
 */
export function buildCycleCloseoutRecord(input: {
  sourceFile: string;
  cycleId: string | null;
  label: string;
  periodStart: string | null;
  periodEnd: string | null;
  closedBy: string;
  closedByEmail: string;
  closedAt: string;
  /** EVERY dispatch row for the cycle — the superseded-marker rule needs the
   *  non-paid rows too, exactly as `tallyPaidDispatches` documents. */
  dispatches: readonly (PayCycleDispatchLike & { processor?: string | null })[];
  reportedUnpaid: unknown;
  recordsOutstanding: CycleCloseoutRecordsOutstanding | null;
}): CycleCloseoutRecord {
  const tally = tallyPaidDispatches(input.dispatches);

  const byProcessor: Record<string, { count: number; usd: number; php: number }> = {};
  for (const d of input.dispatches) {
    if (d.status !== 'paid') continue;
    const key = trimOrNull(d.processor, 40) ?? 'unknown';
    const acc = byProcessor[key] ?? { count: 0, usd: 0, php: 0 };
    acc.count += 1;
    acc.usd += num(d.amount_usd);
    acc.php += num(d.amount_php);
    byProcessor[key] = acc;
  }

  const { payees, truncated, dropped } = normalizeReportedUnpaid(input.reportedUnpaid);
  let unpaidEmployees = 0;
  let unpaidContractors = 0;
  let totalUSD = 0;
  let totalPHP = 0;
  for (const p of payees) {
    if (p.payeeType === 'contractor') unpaidContractors += 1;
    else unpaidEmployees += 1;
    totalUSD += p.amountUSD ?? 0;
    totalPHP += p.amountPHP ?? 0;
  }

  return {
    version: CYCLE_CLOSEOUT_VERSION,
    closed_at: input.closedAt,
    closed_by: input.closedBy,
    closed_by_email: input.closedByEmail,
    source_file: input.sourceFile,
    cycle_id: input.cycleId,
    label: input.label,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    paid: {
      payeeCount: tally.payeeCount,
      employeeCount: tally.employeeCount,
      contractorCount: tally.contractorCount,
      dispatchCount: tally.dispatchCount,
      paidUSD: tally.paidUSD,
      paidPHP: tally.paidPHP,
    },
    byProcessor,
    unpaid: {
      source: 'dispatch_screen',
      // The stored rows are what this record can stand behind. `truncated`
      // carries the rest, so count + truncated is the number the clerk saw.
      count: payees.length,
      employeeCount: unpaidEmployees,
      contractorCount: unpaidContractors,
      totalUSD,
      totalPHP,
      payees,
      truncated,
      dropped,
    },
    records_outstanding: input.recordsOutstanding,
  };
}

/**
 * Parse a stored value, returning null (not throwing) on anything malformed —
 * one corrupt row must not blank the Reports tab. Anything the UI dereferences
 * unconditionally is checked here; softer fields are repaired.
 */
export function parseCycleCloseout(value: string): CycleCloseoutRecord | null {
  try {
    const parsed = JSON.parse(value) as CycleCloseoutRecord;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.source_file !== 'string' || !parsed.source_file) return null;
    if (typeof parsed.closed_at !== 'string' || !parsed.closed_at) return null;
    if (!parsed.paid || typeof parsed.paid !== 'object') return null;
    for (const k of ['payeeCount', 'dispatchCount', 'paidUSD', 'paidPHP'] as const) {
      if (typeof parsed.paid[k] !== 'number' || !Number.isFinite(parsed.paid[k])) return null;
    }
    if (!parsed.unpaid || typeof parsed.unpaid !== 'object') return null;
    if (typeof parsed.unpaid.count !== 'number' || !Number.isFinite(parsed.unpaid.count)) return null;
    if (!Array.isArray(parsed.unpaid.payees)) parsed.unpaid.payees = [];
    if (typeof parsed.unpaid.truncated !== 'number') parsed.unpaid.truncated = 0;
    if (typeof parsed.unpaid.dropped !== 'number') parsed.unpaid.dropped = 0;
    if (!parsed.byProcessor || typeof parsed.byProcessor !== 'object') parsed.byProcessor = {};
    if (typeof parsed.label !== 'string' || !parsed.label) parsed.label = parsed.source_file;
    if (typeof parsed.closed_by !== 'string' || !parsed.closed_by) {
      parsed.closed_by =
        typeof parsed.closed_by_email === 'string' && parsed.closed_by_email
          ? parsed.closed_by_email
          : '—';
    }
    return parsed;
  } catch {
    return null;
  }
}
