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
