/**
 * Auto-Threshold — anything under US$15.00 is held at Threshold automatically.
 *
 * Kane, 2026-09-29: *"Anything under 15 USD should automatically be flagged as
 * Threshold after the Payment Dispatch loads the data it will pop up that how
 * many are Threshold."* This superseded the 2026-04 "no automation" line in
 * payment-dispatch.md §1 for this one outcome (session answer (b)).
 *
 * A Threshold is the SAME `payment_dispatches` marker a clerk logs by hand from
 * Mark Paid (124 of them by 2026-09-29, 97 under $15): it takes the person out
 * of Pending, into the Threshold tab, and keeps them in the progress strip's
 * denominator as still owed. Nothing about what Threshold means changed — only
 * who writes it for the under-$15 rows.
 *
 * Pure and isomorphic: the page picks candidates with it, the route re-validates
 * every row with it and plans the write with it. One rule, both ends.
 */

import { PROCESSORS, type ProcessorId, type QueueRow } from '@/components/payroll-clerk/mock-queue';

/** The payout minimum. STRICTLY under: exactly $15.00 is paid. */
export const AUTO_THRESHOLD_LIMIT_USD = 15;

/** Stamped on the row's `created_by` after the clerk's email, the same
 *  `email (tag)` shape the dedupe script uses so `actorLabel()` splits it. A
 *  record the rule wrote must never read as a clerk's own call. */
export const AUTO_THRESHOLD_ACTOR_TAG = 'auto-threshold';

/** `bank_used` is NOT NULL. Nothing left any bank, so the column says so rather
 *  than naming a rail the money never went through. */
export const AUTO_THRESHOLD_BANK_USED = 'Not sent';

export const AUTO_THRESHOLD_NOTE =
  'Auto-flagged: under US$15.00 — held, not sent. Clear it from the Threshold tab to pay them this week.';

/** Audit action for the rule's own writes. `payment.` family in the registry. */
export const AUTO_THRESHOLD_AUDIT_ACTION = 'payment.auto_threshold';

/** One request never writes more than this many markers. A live week has ~20. */
export const AUTO_THRESHOLD_MAX_ROWS = 500;

const PROCESSOR_IDS: ReadonlySet<string> = new Set(PROCESSORS.map((p) => p.id));

/** Finite and strictly under the limit. `null`/NaN is UNKNOWN, never "small" —
 *  an unpriced row is not a $0 row. Zero and negative (a withholding that
 *  exceeds the week's pay) ARE under, as clerks already logged them. */
export function isUnderAutoThreshold(amountUSD: number | null | undefined): boolean {
  return typeof amountUSD === 'number' && Number.isFinite(amountUSD) && amountUSD < AUTO_THRESHOLD_LIMIT_USD;
}

/** What the page sends and the route writes, per person. */
export interface AutoThresholdCandidate {
  /** Lowercased WORK email — the key the pending lockout filters on (`r.id`). */
  recipient_email: string;
  recipient_name: string | null;
  processor: ProcessorId;
  bank_preferred_raw: string | null;
  amount_usd: number;
  amount_php: number | null;
  amount_cop: number | null;
  /** Which wizard carrier priced the row. A recomputed figure never qualifies. */
  values_source: 'snapshot' | 'lock';
}

type CandidateSource = Pick<
  QueueRow,
  | 'id'
  | 'name'
  | 'processor'
  | 'bankPreferredRaw'
  | 'amountUSD'
  | 'amountPHP'
  | 'amountCOP'
  | 'payeeKind'
  | 'valuesSource'
>;

/**
 * The pending rows the rule would hold. An employee, priced by the Payroll
 * Wizard (published snapshot or locked stage), with a known USD amount under
 * the limit.
 *
 * - **Contractors never.** A contractor Threshold leaves the invoice payable
 *   (the API only claims on `paid`), so the row would sit in Pending AND the
 *   Threshold tab at once.
 * - **A recomputed amount never.** `computeCurrentPay` knows nothing of Adj.,
 *   Orphanage, KPI/dept bonuses or MESA, so a ₱500 recompute can be a ₱5,000
 *   week. Holding someone's pay on a figure the wizard never produced is the
 *   exact failure §4.2.2 exists to prevent.
 */
export function autoThresholdCandidates(rows: readonly CandidateSource[]): AutoThresholdCandidate[] {
  const out: AutoThresholdCandidate[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.payeeKind === 'contractor') continue;
    if (r.valuesSource !== 'snapshot' && r.valuesSource !== 'lock') continue;
    if (!isUnderAutoThreshold(r.amountUSD)) continue;
    const email = r.id.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({
      recipient_email: email,
      recipient_name: r.name?.trim() || null,
      processor: r.processor,
      bank_preferred_raw: r.bankPreferredRaw ?? null,
      amount_usd: r.amountUSD as number,
      amount_php: r.amountPHP,
      amount_cop: r.amountCOP,
      values_source: r.valuesSource,
    });
  }
  return out;
}

function nullableFinite(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Server-side re-validation of one posted row. Every field is re-checked —
 * the page is not trusted to have applied the rule, only to have priced the
 * row (the same trust Mark Paid already extends to the amount it posts).
 * Returns null for anything that does not qualify; never coerces.
 */
export function parseAutoThresholdCandidate(raw: unknown): AutoThresholdCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const email = typeof o.recipient_email === 'string' ? o.recipient_email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) return null;
  const processor = typeof o.processor === 'string' ? o.processor.trim().toLowerCase() : '';
  if (!PROCESSOR_IDS.has(processor)) return null;
  if (o.values_source !== 'snapshot' && o.values_source !== 'lock') return null;
  if (typeof o.amount_usd !== 'number' || !isUnderAutoThreshold(o.amount_usd)) return null;
  const amountPhp = nullableFinite(o.amount_php);
  const amountCop = nullableFinite(o.amount_cop);
  if (amountPhp === undefined || amountCop === undefined) return null;
  const name = typeof o.recipient_name === 'string' && o.recipient_name.trim() ? o.recipient_name.trim() : null;
  const bankRaw =
    typeof o.bank_preferred_raw === 'string' && o.bank_preferred_raw.trim() ? o.bank_preferred_raw.trim() : null;
  return {
    recipient_email: email,
    recipient_name: name,
    processor: processor as ProcessorId,
    bank_preferred_raw: bankRaw,
    amount_usd: o.amount_usd,
    amount_php: amountPhp,
    amount_cop: amountCop,
    values_source: o.values_source,
  };
}

export type AutoThresholdSkipReason =
  /** Any dispatch row this week — paid, a marker, or a Not Paid attempt. A human already acted. */
  | 'already_dispatched'
  /** Someone cleared a Threshold for them this week. Their call stands; never re-held. */
  | 'cleared'
  /** The rule already held them once this week (belt and braces over `cleared`). */
  | 'already_auto'
  /** Same person twice in one request. */
  | 'duplicate';

export interface AutoThresholdPlan {
  flag: AutoThresholdCandidate[];
  skipped: Record<AutoThresholdSkipReason, number>;
}

/**
 * Who the rule writes a marker for. The rule acts ONCE per person per week and
 * only on people nobody has touched: any dispatch row this week, any Threshold
 * someone cleared this week, and any earlier auto-hold all mean no.
 *
 * `cleared` is what makes a Clear stick. Without it the clerk clears a $14
 * person to pay them, the page reloads, and the rule re-holds them — a loop she
 * can never get out of.
 */
export function planAutoThreshold(args: {
  candidates: readonly AutoThresholdCandidate[];
  dispatchedEmails: ReadonlySet<string>;
  clearedEmails: ReadonlySet<string>;
  autoFlaggedEmails: ReadonlySet<string>;
}): AutoThresholdPlan {
  const skipped: Record<AutoThresholdSkipReason, number> = {
    already_dispatched: 0,
    cleared: 0,
    already_auto: 0,
    duplicate: 0,
  };
  const flag: AutoThresholdCandidate[] = [];
  const seen = new Set<string>();
  for (const c of args.candidates) {
    const email = c.recipient_email.trim().toLowerCase();
    if (seen.has(email)) {
      skipped.duplicate += 1;
      continue;
    }
    seen.add(email);
    if (args.dispatchedEmails.has(email)) skipped.already_dispatched += 1;
    else if (args.clearedEmails.has(email)) skipped.cleared += 1;
    else if (args.autoFlaggedEmails.has(email)) skipped.already_auto += 1;
    else flag.push(c);
  }
  return { flag, skipped };
}

/** Minimal audit-event shape the ledger reads. */
export interface AutoThresholdLedgerEvent {
  action: string;
  details: Record<string, unknown> | null;
}

function detailEmail(details: Record<string, unknown> | null): string | null {
  const v = details?.recipient_email;
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null;
}

/**
 * Emails whose Threshold was cleared this week — `payment.undone` events whose
 * deleted row was a `threshold`. Covers a Clear of a hand-logged Threshold too:
 * a person a human un-held is never re-held by the rule, whoever held them.
 * Caller scopes the events to the week (details->cycle->>source_file).
 */
export function clearedThresholdEmails(events: readonly AutoThresholdLedgerEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.action !== 'payment.undone') continue;
    if (e.details?.original_status !== 'threshold') continue;
    const email = detailEmail(e.details);
    if (email) out.add(email);
  }
  return out;
}

/** Emails the rule itself already held this week. */
export function autoFlaggedEmails(events: readonly AutoThresholdLedgerEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.action !== AUTO_THRESHOLD_AUDIT_ACTION) continue;
    const email = detailEmail(e.details);
    if (email) out.add(email);
  }
  return out;
}

/** `created_by` for a marker the rule wrote on `actorEmail`'s page load. */
export function autoThresholdCreatedBy(actorEmail: string): string {
  return `${actorEmail.trim()} (${AUTO_THRESHOLD_ACTOR_TAG})`;
}

/** True for a record the rule wrote (by its `created_by` tag). */
export function isAutoThresholdRecord(row: { status?: string | null; created_by?: string | null }): boolean {
  return row.status === 'threshold' && (row.created_by ?? '').trim().endsWith(`(${AUTO_THRESHOLD_ACTOR_TAG})`);
}

/**
 * The per-week lock the rule runs under — an `app_settings` row INSERTed as a
 * mutex (the primary key makes the insert the claim), holding only the actor
 * and a timestamp, never who is being held. Two clerks opening the page in the
 * same second otherwise both see "nobody dispatched" and both write a marker.
 * A claim older than {@link AUTO_THRESHOLD_RUN_STALE_MS} is a crashed run and
 * may be taken over.
 */
export function autoThresholdRunKey(sourceFile: string): string {
  return `dispatch.auto_threshold_run.${sourceFile}`;
}

export const AUTO_THRESHOLD_RUN_STALE_MS = 60_000;

export function isAutoThresholdRunStale(claimedAtIso: string | null | undefined, nowMs: number): boolean {
  if (!claimedAtIso) return true;
  const at = Date.parse(claimedAtIso);
  return !Number.isFinite(at) || nowMs - at > AUTO_THRESHOLD_RUN_STALE_MS;
}

/** The per-cycle wizard lock value (JSON, legacy bool, or blank) → locked? */
export function parseWizardLockedFlag(value: string | null | undefined): boolean {
  if (!value) return false;
  const t = value.trim();
  if (t === 'true') return true;
  if (t === 'false' || t === '') return false;
  try {
    return (JSON.parse(t) as { locked?: unknown }).locked === true;
  } catch {
    return false;
  }
}

/** The popup's person line. */
export interface AutoThresholdFlagged {
  email: string;
  name: string | null;
  processor: ProcessorId;
  amountUSD: number;
  amountPHP: number | null;
}

/** Response of `POST /api/payment-dispatches/auto-threshold`. */
export interface AutoThresholdResponse {
  flagged: AutoThresholdFlagged[];
  skipped: Record<AutoThresholdSkipReason, number>;
  /** Rows the route refused as not qualifying (bad amount, contractor, recomputed, …). */
  rejected: number;
  /** Another screen was mid-run; nothing was written by this call. */
  busy?: boolean;
  /** Set when the markers landed but their audit events did not. */
  warning?: string | null;
  error: string | null;
}
