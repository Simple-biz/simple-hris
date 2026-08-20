/**
 * Make a swallowed notification failure OBSERVABLE — without making it fatal.
 *
 * Why this exists, precisely: `kpi.scored` shipped 2026-08-17 and delivered
 * nothing for three days. Every insert was rejected by
 * `employee_notifications_type_check` because the DDL had not run, and all four
 * call sites treat a notify failure as ignorable ("best-effort: a notify failure
 * never fails the submission"). A CHECK rejection therefore looked *identical to
 * success*. `pab.excluded` / `pab.restored` were dead 17 days the same way. Zero
 * rows inserted, zero signals raised, and it surfaced only because someone pasted
 * `pg_get_constraintdef` while auditing something unrelated.
 *
 * Best-effort delivery is the RIGHT design and is not being changed: a
 * notification must never fail a payroll submission
 * (`docs/features/kpi-scored-notification.md`, "Every notify call is best-effort
 * in try/catch"). The bug was never that the failure was non-fatal — it was that
 * the failure was *invisible*. So this writes an `audit_log` row instead of a
 * console line nobody reads, and deliberately keeps the swallow.
 *
 * `audit_log` rather than a log line because that is the trail this product
 * already reads: the Admin Penny assistant queries it, Payroll Notes surfaces it,
 * and it survives past Vercel's log retention. A dead notification type is a
 * multi-week silence, so the signal has to outlive a log buffer.
 *
 * CANNOT THROW. It is called from inside the catch that protects a payroll save,
 * so a failure here must never become the thing that fails the request —
 * otherwise this hardening would introduce the exact class it exists to prevent.
 * `insertAuditLog` already returns `{ error }` rather than throwing, and the
 * try/catch below covers anything it might do in future.
 */
import { insertAuditLog } from '@/lib/supabase/audit-log';

/** The one action string for every notification-delivery failure. */
export const NOTIFY_FAILED_ACTION = 'notification.insert_failed';

export interface NotifyFailureContext {
  /** The notification type that failed to land, e.g. `kpi.scored`. */
  notificationType: string;
  /** Where it failed from, e.g. `hsl-bonus/period-status`. */
  origin: string;
  /** The error thrown or returned by the insert. */
  error: unknown;
  /** Who triggered the save. Falls back to `system` — never blocks on a lookup. */
  actor?: { user_name: string; user_role: string } | null;
  /** Anything that identifies the affected work, e.g. department + period. */
  details?: Record<string, unknown>;
}

/** Normalise any thrown value to a message without losing a non-Error. */
export function describeNotifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    // JSON.stringify(undefined) returns undefined, NOT a string — returning it
    // would make this function's `: string` contract a lie and put a null into
    // details.error. Narrow it here rather than widening the return type.
    const encoded = JSON.stringify(error);
    return typeof encoded === 'string' ? encoded : String(error);
  } catch {
    return String(error);
  }
}

/**
 * Record that a notification failed to insert. Returns whether the audit row
 * landed, so a caller MAY assert on it in a test — production callers ignore it.
 */
export async function recordNotifyFailure(ctx: NotifyFailureContext): Promise<{ recorded: boolean }> {
  try {
    const message = describeNotifyError(ctx.error);
    // A type-CHECK rejection is the specific footgun that caused two multi-week
    // outages, so it is called out in the row rather than left to be re-diagnosed.
    const looksLikeTypeCheck = /type_check|violates check constraint/i.test(message);
    const { error } = await insertAuditLog({
      user_name: ctx.actor?.user_name ?? 'system',
      user_role: ctx.actor?.user_role ?? 'system',
      action: NOTIFY_FAILED_ACTION,
      resource: 'employee_notifications',
      details: {
        notification_type: ctx.notificationType,
        origin: ctx.origin,
        error: message,
        likely_type_check_rejection: looksLikeTypeCheck,
        ...(ctx.details ?? {}),
      },
    });
    if (error) {
      // Last resort only. If even the audit write fails there is nowhere left to
      // put this, and it still must not break the caller.
      console.error(`[${NOTIFY_FAILED_ACTION}] could not record failure for ${ctx.notificationType}:`, error);
      return { recorded: false };
    }
    return { recorded: true };
  } catch (e) {
    console.error(`[${NOTIFY_FAILED_ACTION}] threw while recording ${ctx.notificationType}:`, e);
    return { recorded: false };
  }
}
