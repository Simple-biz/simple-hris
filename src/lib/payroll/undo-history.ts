/**
 * Undo history — turning `payment.undone` audit events into a readable record
 * of what each press of Undo actually changed.
 *
 * Undo DELETES the `payment_dispatches` row, so the audit event is the only
 * surviving copy of the payment. This module is the reader's half of that
 * contract: pure, no DB, no `server-only`, so the route and its tests share one
 * classifier.
 *
 * **One action name, five different things.** `payment.undone` is written by
 * the paid-row Undo, by the Problem/Threshold/Not-Paid "Clear" (same route —
 * payment-dispatch.md:242), by the urgent one-off/MESA/orphanage undo, by the
 * no-op trace when the rows were already gone, and by
 * `scripts/dedupe-payment-dispatches.mjs` deleting a duplicate paid row. The
 * kind is therefore derived from `details`, NEVER from the action name.
 */

/** What one `payment.undone` event actually did. */
export type UndoKind =
  /** A real payment was undone — money that had been logged as sent. */
  | 'payment'
  /** A Not-Paid / Threshold / Problem marker was cleared, not a payment. */
  | 'marker_clear'
  /** Undo pressed, but the rows were already gone. Nothing changed. */
  | 'no_op'
  /**
   * A duplicate `paid` row removed by `scripts/dedupe-payment-dispatches.mjs`.
   * The payment itself STANDS — the oldest row survives — so this is a cleanup,
   * not money being un-paid, and nobody returned to the pending queue.
   */
  | 'duplicate_cleanup'
  /**
   * Written before the full snapshot existed (`{count, ids}` only, 2026-06-08 →
   * 2026-07-29 — 59 events). The dispatch id survives; WHAT changed does not.
   */
  | 'unrecorded';

/** Statuses that mean "this was a marker, not money". */
const MARKER_STATUSES = new Set(['not_paid', 'threshold', 'problem']);

export type UndoHistoryEntry = {
  id: string;
  /** ISO stamp from `audit_log.created_at` — when Undo was pressed. */
  at: string;
  kind: UndoKind;
  /** Signed-in email that pressed it, or a script's own actor string. */
  actor: string;
  actorEmail: string;
  /** Non-null when the actor was a script run, e.g. `dedupe-payment-dispatches`. */
  actorScript: string | null;
  actorRole: string;
  ipAddress: string | null;
  /** The deleted dispatch row's id (audit `resource_id`). */
  dispatchId: string | null;

  // ── What was undone. All verbatim from the snapshot; never re-derived. ──
  recipientEmail: string | null;
  recipientName: string | null;
  processor: string | null;
  amountUsd: number | null;
  amountPhp: number | null;
  amountCop: number | null;
  transactionId: string | null;
  bankUsed: string | null;
  sentDate: string | null;
  note: string | null;
  /** The status the deleted row carried — what the undo reverted FROM. */
  originalStatus: string | null;
  originallyPaidBy: string | null;
  originallyPaidAt: string | null;
  /** Why a script removed the row, when a script did. */
  reason: string | null;
  /** For a duplicate cleanup: the row that SURVIVED and still marks the payment. */
  keptDispatchId: string | null;

  // ── Context ──
  cycleSourceFile: string | null;
  cyclePeriodStart: string | null;
  cyclePeriodEnd: string | null;
  /** Set when this event was one row of a multi-select undo. */
  batch: { requested: number; deleted: number } | null;
  /** Urgent-undo outcome, when the undo came from an urgent bucket. */
  urgent: { source: string; revived: boolean; warning: string | null } | null;
};

// ─── Narrowing helpers ────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  return null;
}

/**
 * Numbers arrive as `number` or as PostgREST numeric strings. A value that is
 * present but unparseable returns null rather than NaN — a NaN would render as
 * "₱NaN" on a money row.
 */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// ─── Classification ───────────────────────────────────────────────────────────

/**
 * What did this event do?
 *
 * Order matters. A no-op is checked first because it carries no status to
 * classify. `unrecorded` is the legacy shape — the ONLY positive signal is the
 * absence of a snapshot, so it is inferred last and never guessed at.
 */
export function classifyUndo(details: Record<string, unknown> | null): UndoKind {
  const d = details ?? {};
  if (d.no_rows_deleted === true) return 'no_op';

  // Checked BEFORE the status: the dedupe script writes original_status 'paid'
  // (it deletes a paid echo row), so status alone would render 82 live cleanup
  // events as 82 payments returned to the pending queue — which never happened.
  if (str(d.reason) === 'duplicate_paid_row') return 'duplicate_cleanup';

  const status = str(d.original_status);
  if (status) return MARKER_STATUSES.has(status) ? 'marker_clear' : 'payment';

  // No status. Either the legacy {count, ids} shape, or a snapshot whose status
  // went missing. Both are "we cannot say what changed" — same honest answer.
  return 'unrecorded';
}

/**
 * The Q3 filter: is this event part of the money record?
 *
 * Excludes ONLY what is positively identified as a marker clear. An event that
 * cannot be classified (`unrecorded`) is KEPT — 59 of the 198 live events carry
 * no status, and dropping them would hide real undos behind a filter, the same
 * "a window posing as the whole history" failure fixed for Penny in
 * memory/penny-audit-log-visibility.md. Never hide an undo because its shape is
 * old.
 */
export function isMoneyUndo(details: Record<string, unknown> | null): boolean {
  return classifyUndo(details) !== 'marker_clear';
}

/**
 * Scripts write their own actor, e.g.
 * `kaner@simple.biz (dedupe-payment-dispatches)` — 82 of the 198 live events.
 * A bulk script run must never read as somebody pressing a button, so the tag
 * is split out rather than shown as part of the email.
 */
export function actorLabel(userName: string): { email: string; script: string | null } {
  const raw = (userName ?? '').trim();
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(raw);
  if (m && m[1] && m[2]) return { email: m[1].trim(), script: m[2].trim() };
  return { email: raw, script: null };
}

/**
 * Groups the per-row events of one multi-select undo. The route writes one
 * event per row with an identical `batch` block, so actor + second + batch size
 * is what ties them together — there is no batch id on the row to key off.
 */
export function batchKey(entry: UndoHistoryEntry): string | null {
  if (!entry.batch || entry.batch.requested <= 1) return null;
  const second = entry.at.slice(0, 19);
  return `${entry.actor}|${second}|${entry.batch.requested}`;
}

// ─── Shaping ──────────────────────────────────────────────────────────────────

type AuditRowLike = {
  id: string;
  user_name: string;
  user_role: string;
  resource_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
};

/** One audit row → one history entry. Amounts pass through verbatim. */
export function toUndoHistoryEntry(row: AuditRowLike): UndoHistoryEntry {
  const d = row.details ?? {};
  const cycle = obj(d.cycle) ?? {};
  const batchRaw = obj(d.batch);
  const urgentRaw = obj(d.urgent_undo);
  const { email, script } = actorLabel(row.user_name);

  const batchRequested = num(batchRaw?.requested);
  const batchDeleted = num(batchRaw?.deleted);

  return {
    id: row.id,
    at: row.created_at,
    kind: classifyUndo(row.details),
    actor: row.user_name,
    actorEmail: email,
    actorScript: script,
    actorRole: row.user_role,
    ipAddress: str(row.ip_address),
    dispatchId: str(row.resource_id),

    recipientEmail: str(d.recipient_email),
    recipientName: str(d.recipient_name),
    processor: str(d.processor),
    amountUsd: num(d.amount_usd),
    amountPhp: num(d.amount_php),
    amountCop: num(d.amount_cop),
    transactionId: str(d.transaction_id),
    bankUsed: str(d.bank_used),
    sentDate: str(d.sent_date),
    note: str(d.note),
    originalStatus: str(d.original_status),
    originallyPaidBy: str(d.originally_paid_by),
    originallyPaidAt: str(d.originally_paid_at),
    reason: str(d.reason),
    keptDispatchId: str(d.kept_dispatch_id),

    cycleSourceFile: str(cycle.source_file),
    cyclePeriodStart: str(cycle.period_start),
    cyclePeriodEnd: str(cycle.period_end),
    batch:
      batchRequested != null && batchDeleted != null
        ? { requested: batchRequested, deleted: batchDeleted }
        : null,
    urgent: urgentRaw
      ? {
          source: str(urgentRaw.source) ?? 'unknown',
          revived: urgentRaw.revived === true,
          warning: str(urgentRaw.warning),
        }
      : null,
  };
}

/**
 * One sentence naming what the undo reverted. Used as the entry's headline.
 *
 * An `unrecorded` entry says so outright — it must never render as an empty
 * payment row, which would read as "a payment of nothing to nobody".
 */
export function describeUndo(entry: UndoHistoryEntry): string {
  const who = entry.recipientName ?? entry.recipientEmail ?? 'an unnamed recipient';
  switch (entry.kind) {
    case 'no_op':
      return 'Undo pressed, but the records were already gone — nothing changed.';
    case 'unrecorded':
      return 'Undone before the full record was kept — only the dispatch id survives.';
    case 'duplicate_cleanup':
      return `A duplicate paid row for ${who} was removed by cleanup — the original payment stands.`;
    case 'marker_clear':
      return `Cleared ${who}'s ${entry.originalStatus ?? 'status'} marker — back to the pending queue.`;
    case 'payment':
      return `${who}'s payment was undone — removed from paid and returned to the pending queue.`;
  }
}
