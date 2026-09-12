/**
 * Paystub issues — deciding what to call a pay statement that goes out twice.
 *
 * Pure: no DB, no `server-only`, so the dispatch route, the resend route, the
 * email renderer, the clerk dialog and the employee dashboard all reach the same
 * verdict about the same statement. Two surfaces disagreeing about which issue an
 * employee is holding is the defect this module exists to prevent.
 *
 * **The word is never "attempt".** An attempt implies the previous one FAILED. In
 * the dominant case — Undo, then Mark Paid again — the first email arrived
 * correctly and was merely superseded, so "Attempt 2" tells an employee their
 * payroll is broken when it is not. The database refuses to store `'attempt'`
 * (see `references/sql/create/2026-09-12_paystub_issues.sql`).
 *
 *   figures unchanged  → **Reissued**   — the same statement, sent again
 *   figures moved      → **Amended**    — the numbers changed; re-read this one
 *   issue > 1, nothing recorded → the NUMBER ONLY, no word
 *
 * That third case is not a gap to be tidied away. 117 statements were already
 * sent more than once before any of this was recorded (measured 2026-09-12), and
 * we know their count but not their per-issue totals — so calling them Reissued
 * or Amended would be a guess printed on a pay document. They get "Issue 2" and
 * nothing more.
 */

/** What one emailed statement was, relative to the one before it. */
export type PaystubIssueKind =
  /** The first time this statement was emailed. No chip — this is the norm. */
  | 'original'
  /** Sent again, figures unchanged. */
  | 'reissued'
  /** Sent again and the figures MOVED. The only case the employee must re-read. */
  | 'amended'
  /**
   * Issue 2+, but the previous issue's total was not recorded — so whether the
   * figures moved is genuinely unknown. Renders as the number alone.
   *
   * Distinct from an ABSENT row, which also renders this way: absence means the
   * issue was never recorded at all (everything before 2026-09-12), while a
   * stored 'unrecorded' means we recorded this issue but could not compare it.
   * Storable on purpose — the row still snapshots what it emailed, which is what
   * lets the NEXT issue be classified properly.
   */
  | 'unrecorded';

/** The persisted shape (`public.paystub_issues`), as the app reads it. */
export type PaystubIssue = {
  cycleSourceFile: string;
  recipientEmail: string;
  issueNo: number;
  issuedAt: string;
  issuedBy: string | null;
  kind: PaystubIssueKind;
  amountPhp: number | null;
  amountUsd: number | null;
  previousAmountPhp: number | null;
  source: 'mark_paid' | 'resend' | 'other';
  reason: string | null;
};

/**
 * Peso tolerance for "did the figures move".
 *
 * Deliberately the SAME epsilon the dispatch route already uses to reconcile a
 * stub against the payment (`app/api/payment-dispatches/route.ts`). Two different
 * tolerances would let a statement be "unchanged" to one check and "changed" to
 * the other on the same centavo.
 */
export const AMOUNT_EPSILON = 0.01;

function finite(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * What to call this issue.
 *
 * `previousAmountPhp` is the total that was ON THE LAST EMAIL — not the staged
 * payload and not the payment. Comparing against either of those answers a
 * different question: the route's stub-vs-payment reconciliation asks "does this
 * statement describe the money that moved", while this asks "has what we told
 * this person changed since we last told them".
 */
export function classifyIssue(params: {
  issueNo: number;
  previousAmountPhp: number | null;
  newAmountPhp: number | null;
}): PaystubIssueKind {
  const { issueNo } = params;
  if (!Number.isFinite(issueNo) || issueNo <= 1) return 'original';

  const prev = finite(params.previousAmountPhp);
  const next = finite(params.newAmountPhp);
  // Either side missing ⇒ the comparison cannot be made. Say so; do not default
  // to 'reissued', which would assert the figures matched when nobody checked.
  if (prev === null || next === null) return 'unrecorded';

  return Math.abs(next - prev) < AMOUNT_EPSILON ? 'reissued' : 'amended';
}

/**
 * The issue number a send is about to become.
 *
 * `send_count` is the count of sends that ALREADY happened, so the next one is
 * count + 1. A null/absent count is treated as zero sends: the first email is
 * issue 1, never issue 0 and never issue 2.
 */
export function nextIssueNo(sendCount: number | null | undefined): number {
  const n = finite(sendCount ?? 0) ?? 0;
  return Math.max(0, Math.floor(n)) + 1;
}

/**
 * Does the clerk get asked before this send?
 *
 * Kane, 2026-09-12: only when a statement ALREADY went for this (cycle, person),
 * and then defaulting to NOT sending. A first payment must not grow an extra
 * click — that is the overwhelmingly common case and nothing is at risk in it.
 *
 * Keyed on `sentAt`, not on `sendCount` alone: a row can carry a count from a
 * send that later failed, and the timestamp is what proves an email actually
 * left. A failed send leaves `last_error` and no `sent_at`, so re-sending after a
 * failure is not a reissue and is not prompted.
 */
export function shouldPromptBeforeSend(params: {
  sentAt: string | null | undefined;
  sendCount?: number | null;
}): boolean {
  return Boolean(params.sentAt);
}

/**
 * The chip that goes on the statement and in the employee's list.
 * `null` for an original — the overwhelming majority of statements, which must
 * not be decorated with a badge saying they are normal.
 */
export function issueChipText(kind: PaystubIssueKind, issueNo: number): string | null {
  if (kind === 'original' || issueNo <= 1) return null;
  if (kind === 'amended') return `Amended · Issue ${issueNo}`;
  if (kind === 'reissued') return `Reissued · Issue ${issueNo}`;
  return `Issue ${issueNo}`;
}

/** Manila-pinned statement date. A pay document is read across timezones. */
export function formatIssueDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleDateString('en-PH', {
      timeZone: 'Asia/Manila',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return null;
  }
}

/**
 * The sentence under the chip, addressed to the employee.
 *
 * Only ever says "replaces the copy sent <date>" when that date is actually
 * known. A superseding claim with no date behind it is the kind of half-fact
 * that makes someone go looking through their inbox for an email we cannot
 * prove we sent.
 */
export function issueNote(params: {
  kind: PaystubIssueKind;
  issueNo: number;
  previousIssuedAt?: string | null;
}): string | null {
  const { kind, issueNo } = params;
  if (kind === 'original' || issueNo <= 1) return null;

  const when = formatIssueDate(params.previousIssuedAt);
  const replaces = when ? ` It replaces the copy sent ${when}.` : '';

  if (kind === 'amended') {
    return `The figures on this statement have changed since it was last sent.${replaces}`;
  }
  if (kind === 'reissued') {
    return `This is the same statement, sent again — the figures are unchanged.${replaces}`;
  }
  // 'unrecorded' — we know it went out before; we do NOT know whether anything
  // moved, and must not imply either way.
  return `This statement has been sent ${issueNo} times. Earlier copies were not recorded in detail.`;
}

/**
 * The verdict for a statement the employee is looking at, given whatever issue
 * history exists for it.
 *
 * `sendCount` is the fallback that makes the 117 pre-existing repeat sends
 * legible: with no rows recorded, a count of 2 still yields "Issue 2" — just
 * without a word in front of it.
 */
export function resolveIssueForDisplay(params: {
  issues: PaystubIssue[];
  sendCount: number | null | undefined;
}): { kind: PaystubIssueKind; issueNo: number; chip: string | null; note: string | null } {
  const issues = [...params.issues].sort((a, b) => a.issueNo - b.issueNo);
  const latest = issues[issues.length - 1] ?? null;
  const previous = issues.length > 1 ? issues[issues.length - 2] : null;

  // Recorded history wins. Fall back to the bare counter for everything sent
  // before this table existed.
  const countFallback = Math.max(1, finite(params.sendCount ?? 0) ?? 0);
  const issueNo = latest ? latest.issueNo : countFallback;

  if (issueNo <= 1) {
    return { kind: 'original', issueNo: 1, chip: null, note: null };
  }

  const kind: PaystubIssueKind = latest ? latest.kind : 'unrecorded';
  return {
    kind,
    issueNo,
    chip: issueChipText(kind, issueNo),
    note: issueNote({ kind, issueNo, previousIssuedAt: previous?.issuedAt ?? null }),
  };
}
