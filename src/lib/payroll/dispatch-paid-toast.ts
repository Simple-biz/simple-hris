/**
 * Payment Dispatch "paid" toast — the pure half.
 *
 * While processing is ON, every open Accounting dashboard shows one lower-left
 * card per PAID dispatch row: `lenny@simple.biz paid kaner@simple.biz $2,700.00`.
 * The paying browser announces from its own Mark Paid handler; every other
 * Accounting screen hears it over a Supabase Realtime **Broadcast** topic.
 *
 * Broadcast, never `postgres_changes`: the browser client is `anon` and
 * `payment_dispatches` is RLS-protected, so row events never reach it
 * (docs/features/payment-dispatch.md §5.1.1).
 *
 * OWN topic, never `payment-dispatch-sync`: realtime-js `channel()` returns the
 * EXISTING channel for a repeated topic, so sharing the queue's topic would let
 * this hook's `removeChannel` tear down the queue's live sync (and vice versa).
 */

/** Realtime Broadcast topic every Accounting shell subscribes to. */
export const PAID_TOAST_TOPIC = 'payment-dispatch-paid';
/** Broadcast event name on that topic. */
export const PAID_TOAST_EVENT = 'paid';
/** Same-document CustomEvent the Mark Paid handler fires so the shell-level
 *  hook can pick the payment up without prop-drilling through the tab tree
 *  (same pattern as useDispatchLock's `hris:dispatch-lock:optimistic`). */
export const PAID_TOAST_LOCAL_EVENT = 'hris:dispatch-paid';
/** Most cards visible at once — an arrears settle can land N legs in a burst. */
export const PAID_TOAST_MAX = 4;
/** How long a card rests before it slides away. */
export const PAID_TOAST_TTL_MS = 6000;
/** Gap between chimes when several remote payments land together. */
export const PAID_TOAST_CHIME_STAGGER_MS = 160;

export interface PaidToastEvent {
  /** The dispatch row id — the de-dupe key across local + broadcast delivery. */
  id: string;
  /** Who logged the payment (lowercased email — the same value the server stamps
   *  into `payment_dispatches.created_by`). */
  by: string;
  recipientEmail: string;
  recipientName: string | null;
  amountUsd: number | null;
  amountPhp: number | null;
  amountCop: number | null;
  processor: string | null;
  sourceFile: string | null;
  /** Sender's clock, ms. Display only. */
  ts: number;
}

/** Only a real `paid` row moved money. Problem / Not Paid / Threshold logs are
 *  markers, and an Undo is a delete — none of them toast. */
export function shouldAnnouncePaid(status: string | null | undefined): boolean {
  return String(status ?? '').trim().toLowerCase() === 'paid';
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function normalizeActorEmail(email: string | null | undefined): string {
  const e = (email ?? '').trim().toLowerCase();
  return e || 'accounting';
}

export interface BuildPaidToastInput {
  id: string | null | undefined;
  by: string | null | undefined;
  recipientEmail: string;
  recipientName?: string | null;
  amountUsd?: number | null;
  amountPhp?: number | null;
  amountCop?: number | null;
  processor?: string | null;
  sourceFile?: string | null;
  now?: number;
}

/** Shapes one event from the Mark Paid handler's knowledge of the row. A row
 *  id should always exist; the fallback key only keeps a missing id from
 *  swallowing the toast, and stays unique per leg. */
export function buildPaidToastEvent(input: BuildPaidToastInput): PaidToastEvent {
  const now = input.now ?? Date.now();
  const recipientEmail = input.recipientEmail.trim().toLowerCase();
  return {
    id: str(input.id) ?? `${recipientEmail}:${input.sourceFile ?? ''}:${now}`,
    by: normalizeActorEmail(input.by),
    recipientEmail,
    recipientName: str(input.recipientName),
    amountUsd: num(input.amountUsd),
    amountPhp: num(input.amountPhp),
    amountCop: num(input.amountCop),
    processor: str(input.processor),
    sourceFile: str(input.sourceFile),
    ts: now,
  };
}

/** Shape-guard a broadcast payload (or a CustomEvent detail) from anywhere.
 *  Anything without an id, actor and recipient is dropped — a toast naming
 *  nobody is worse than no toast. */
export function parsePaidToastPayload(payload: unknown): PaidToastEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const id = str(p.id);
  const by = str(p.by);
  const recipientEmail = str(p.recipientEmail);
  if (!id || !by || !recipientEmail) return null;
  return {
    id,
    by: by.toLowerCase(),
    recipientEmail: recipientEmail.toLowerCase(),
    recipientName: str(p.recipientName),
    amountUsd: num(p.amountUsd),
    amountPhp: num(p.amountPhp),
    amountCop: num(p.amountCop),
    processor: str(p.processor),
    sourceFile: str(p.sourceFile),
    ts: num(p.ts) ?? Date.now(),
  };
}

// Same rendering as Payment Dispatch's own formatters (mock-queue.ts) — kept
// local so this lib never imports from a component module.
function fmtUsd(n: number | null): string | null {
  if (n == null) return null;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPhp(n: number | null): string | null {
  if (n == null) return null;
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtCop(n: number | null): string | null {
  if (n == null) return null;
  return '$COP' + n.toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/** USD leads with ₱ beneath, like the CEO "Being paid now" rail; a COP-country
 *  payee with no USD figure leads with what was actually sent. */
export function paidAmountParts(e: Pick<PaidToastEvent, 'amountUsd' | 'amountPhp' | 'amountCop'>): {
  primary: string;
  secondary: string | null;
} {
  const usd = fmtUsd(e.amountUsd);
  const php = fmtPhp(e.amountPhp);
  const cop = fmtCop(e.amountCop);
  if (usd) return { primary: usd, secondary: php ?? cop };
  if (php) return { primary: php, secondary: cop };
  if (cop) return { primary: cop, secondary: null };
  return { primary: '—', secondary: null };
}

/** The one-line reading of a card, also used as its accessible label:
 *  `lenny@simple.biz paid kaner@simple.biz $2,700.00`. */
export function formatPaidLine(e: PaidToastEvent): string {
  return `${e.by} paid ${e.recipientEmail} ${paidAmountParts(e).primary}`;
}

/** Append newest-last, de-dupe by id (the same row can arrive locally AND over
 *  the wire), and cap the stack by dropping the oldest. Returns the same array
 *  when nothing changed so React can skip the render. */
export function pushPaidToast(
  stack: readonly PaidToastEvent[],
  evt: PaidToastEvent,
  max: number = PAID_TOAST_MAX,
): PaidToastEvent[] {
  if (stack.some((t) => t.id === evt.id)) return stack as PaidToastEvent[];
  const next = [...stack, evt];
  return next.length > max ? next.slice(next.length - max) : next;
}

// ── Poll fallback ─────────────────────────────────────────────────────────────
// Broadcast only reaches a screen while the PAYER's browser runs this code and
// the receiver's socket is up. A clerk on an older production build never
// broadcasts, so the shell also polls `GET /api/payment-dispatches/recent-paid`
// while processing is on and folds new PAID rows into the same stack.

/** Poll cadence while the tab is visible. */
export const PAID_TOAST_POLL_MS = 10_000;
/** A polled row older than this (by the SERVER clock) is history, not news: a
 *  tab hidden for an hour advances its watermark silently instead of replaying
 *  sixty payments. */
export const PAID_TOAST_FRESH_MS = 90_000;

/** Wire shape of one row from the recent-paid route. Kept `unknown`-tolerant:
 *  the fold below validates, the route type is not trusted across builds. */
export interface RecentPaidRowLike {
  id?: unknown;
  created_by?: unknown;
  recipient_email?: unknown;
  recipient_name?: unknown;
  amount_usd?: unknown;
  amount_php?: unknown;
  amount_cop?: unknown;
  processor?: unknown;
  cycle_source_file?: unknown;
  created_at?: unknown;
}

/**
 * Turn polled rows into toast events, oldest first.
 *  - OWN rows are skipped: the paying browser already showed and chimed them
 *    from its local path; the poll must never mint a second card.
 *  - Stale rows (older than `freshMs` against `serverNow`) are skipped: the
 *    caller still advances its watermark past them.
 *  - Rows without an id or recipient are dropped (a toast naming nobody).
 */
export function foldRecentPaidRows(
  rows: readonly RecentPaidRowLike[],
  opts: { selfEmail: string | null | undefined; serverNow: number; freshMs?: number },
): { events: PaidToastEvent[]; skippedOwn: number; skippedStale: number } {
  const self = (opts.selfEmail ?? '').trim().toLowerCase() || null;
  const freshMs = opts.freshMs ?? PAID_TOAST_FRESH_MS;
  const events: PaidToastEvent[] = [];
  let skippedOwn = 0;
  let skippedStale = 0;
  for (const r of rows) {
    const id = str(r.id);
    const recipientEmail = str(r.recipient_email);
    if (!id || !recipientEmail) continue;
    const ts = typeof r.created_at === 'string' ? Date.parse(r.created_at) : NaN;
    if (Number.isFinite(ts) && opts.serverNow - ts > freshMs) {
      skippedStale += 1;
      continue;
    }
    const by = normalizeActorEmail(str(r.created_by));
    if (self && by === self) {
      skippedOwn += 1;
      continue;
    }
    events.push({
      id,
      by,
      recipientEmail: recipientEmail.toLowerCase(),
      recipientName: str(r.recipient_name),
      amountUsd: num(r.amount_usd),
      amountPhp: num(r.amount_php),
      amountCop: num(r.amount_cop),
      processor: str(r.processor),
      sourceFile: str(r.cycle_source_file),
      ts: Number.isFinite(ts) ? ts : opts.serverNow,
    });
  }
  events.sort((a, b) => a.ts - b.ts);
  return { events, skippedOwn, skippedStale };
}

// ── Table sync ────────────────────────────────────────────────────────────────
// A toast for Employee A must never outrun the queue: the moment a REMOTE paid
// event is accepted, the toast hook fires this same-document event and the
// Payment Dispatch table hides A at the RENDER boundary until the next reload
// lands. `pending` itself is never touched — it feeds `isCycleFullyPaid`, and
// emptying it ahead of the server is exactly the 2026-08-18 false-100% bug.

/** Same-document CustomEvent for every remote paid event the toast hook accepts. */
export const PAID_TOAST_REMOTE_EVENT = 'hris:dispatch-paid-remote';

/** Does a remote paid event concern the cycle this table is showing? A missing
 *  sourceFile on either side is taken as "yes" — hiding one row a few seconds
 *  early is harmless (the reload restores it), hiding nothing is the bug. */
export function remotePaidHidesRow(
  evt: Pick<PaidToastEvent, 'sourceFile'>,
  tableSourceFile: string | null | undefined,
): boolean {
  if (!evt.sourceFile || !tableSourceFile) return true;
  return evt.sourceFile === tableSourceFile;
}

/** Render-boundary filter: drop rows whose recipient was just paid elsewhere. */
export function hidePaidElsewhere<T extends { email: string }>(
  rows: readonly T[],
  paidElsewhere: ReadonlySet<string>,
): T[] {
  if (paidElsewhere.size === 0) return rows as T[];
  return rows.filter((r) => !paidElsewhere.has(r.email.trim().toLowerCase()));
}

// ── The queue's own sync topic (owned by useDispatchQueue, mirrored here so the
// SERVER can announce a queue change without importing a 'use client' file) ──
/** Realtime Broadcast topic the Payment Dispatch queue reloads on. */
export const DISPATCH_SYNC_TOPIC = 'payment-dispatch-sync';
/** Its event name. Payload: `{ sourceFile, ts }`. */
export const DISPATCH_SYNC_QUEUE_CHANGED = 'queue-changed';
