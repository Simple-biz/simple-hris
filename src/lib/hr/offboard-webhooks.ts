import { resolveWebhookUrl } from "@/lib/webhooks/resolve-webhook";
import { normalizeDeptToKey } from "@/lib/payroll/normalize-dept-key";

/**
 * Offboarding is a two-phase, department-aware teardown driven entirely by the
 * HRIS (n8n does no waiting):
 *
 *   Lead Gen        -> fire `offboarding_delete` immediately. No timer.
 *   Other depts     -> fire `offboarding_deactivate` immediately (suspend the
 *                      Workspace account, send the termination email, remove the
 *                      Hubstaff member at pay_rate 0) AND stamp
 *                      scheduled_deletion_at = now()+14d. The daily cron
 *                      (/api/cron/process-scheduled-deletions) fires
 *                      `offboarding_delete` once the timer elapses.
 *   temporary_pause -> fire `offboarding_deactivate` (suspend only) with
 *                      deletion_mode: "none" and NO scheduled_deletion_at, for
 *                      ANY department — the account is never deleted; the person
 *                      is expected back via re-onboarding.
 *
 * The legacy single 'offboarding' slug is retired. URL resolution still goes
 * through the Admin -> Webhooks slug registry (resolveWebhookUrl), so the
 * endpoints can be rotated from the UI without a redeploy.
 */

export const OFFBOARD_DEACTIVATE_SLUG = "offboarding_deactivate";
export const OFFBOARD_DELETE_SLUG = "offboarding_delete";
/** Fired when a manager submits team members to the HR offboarding queue;
 *  the n8n flow emails alissar@simple.biz the count only (no names). */
export const MANAGER_OFFBOARD_NOTIFY_SLUG = "manager_offboard_notify";
/** Fired by the Manager -> My Team list "Suspend" button: the n8n temp-pause
 *  flow disables (suspends) the person's Workspace account. Never deletes —
 *  no offboard stamps, no scheduled deletion; re-enable happens in n8n. */
export const MANAGER_SUSPEND_SLUG = "manager_suspend";

const DEACTIVATE_DEFAULT_URL =
  "https://simpledotbiz.app.n8n.cloud/webhook/offboarding-deactivate";
const DELETE_DEFAULT_URL =
  "https://simpledotbiz.app.n8n.cloud/webhook/offboarding-delete";
const MANAGER_OFFBOARD_NOTIFY_DEFAULT_URL =
  "https://simpledotbiz.app.n8n.cloud/webhook/manager-offboard-notify";
const MANAGER_SUSPEND_DEFAULT_URL =
  "https://simpledotbiz.app.n8n.cloud/webhook/reactivate-temp-pause";

/** Days a non-Lead-Gen account stays deactivated before the cron deletes it. */
export const DELETION_DELAY_DAYS = 14;

/**
 * Lead Gen is the only department deleted immediately. Anything that does not
 * normalize to the 'lead_gen' key (incl. unknown department strings) is treated
 * as non-Lead-Gen and gets the safer 14-day deferral.
 */
export function isLeadGenDepartment(department: string | null | undefined): boolean {
  return normalizeDeptToKey(department) === "lead_gen";
}

/** ISO timestamp `days` in the future, computed from `fromIso` (defaults caller-supplied). */
export function scheduledDeletionFrom(fromIso: string, days = DELETION_DELAY_DAYS): string {
  return new Date(new Date(fromIso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function resolveUrl(slug: string): Promise<string> {
  let defaultUrl: string;
  let envVars: string[];
  if (slug === OFFBOARD_DELETE_SLUG) {
    defaultUrl = DELETE_DEFAULT_URL;
    envVars = ["N8N_OFFBOARDING_DELETE_WEBHOOK_URL"];
  } else if (slug === MANAGER_OFFBOARD_NOTIFY_SLUG) {
    defaultUrl = MANAGER_OFFBOARD_NOTIFY_DEFAULT_URL;
    envVars = ["N8N_MANAGER_OFFBOARD_NOTIFY_WEBHOOK_URL"];
  } else if (slug === MANAGER_SUSPEND_SLUG) {
    defaultUrl = MANAGER_SUSPEND_DEFAULT_URL;
    envVars = ["N8N_MANAGER_SUSPEND_WEBHOOK_URL"];
  } else {
    defaultUrl = DEACTIVATE_DEFAULT_URL;
    envVars = ["N8N_OFFBOARDING_DEACTIVATE_WEBHOOK_URL"];
  }
  return resolveWebhookUrl(slug, { envVars, defaultUrl }).then((u) => u ?? defaultUrl);
}

export type OffboardWebhookResult = {
  fired: boolean;
  status: number | null;
  error: string | null;
};

/**
 * POSTs an offboard payload to the resolved n8n endpoint for `slug`. Never
 * throws -- callers treat the webhook as a best-effort side-effect (the DB write
 * is the source of truth). 25s timeout so a hanging webhook can't tie up the
 * request while still giving the respond-when-done n8n flow room to finish.
 */
export async function fireOffboardWebhook(
  slug: string,
  payload: Record<string, unknown>,
): Promise<OffboardWebhookResult> {
  let url: string;
  try {
    url = await resolveUrl(slug);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { fired: false, status: null, error: msg };
  }

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 25000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    if (!res.ok) {
      console.error(`[offboard] webhook ${slug} (${url}) returned ${res.status}`);
      return { fired: true, status: res.status, error: `HTTP ${res.status}` };
    }
    return { fired: true, status: res.status, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[offboard] webhook ${slug} threw: ${msg}`);
    return { fired: false, status: null, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}
