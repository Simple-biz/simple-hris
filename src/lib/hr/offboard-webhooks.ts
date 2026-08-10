import { resolveWebhookUrl } from "@/lib/webhooks/resolve-webhook";
import { normalizeDeptToKey } from "@/lib/payroll/normalize-dept-key";

/**
 * Two n8n pathways, routed by WHAT happened — not by reason or department:
 *
 *   Offboard (ANY reason, ANY department, incl. no-shows)
 *                   -> fire `offboarding_delete` immediately. No timer, no
 *                      14-day deferral — the delete-button pathway in n8n IS
 *                      the offboard automation. (The old deactivate-then-cron
 *                      deferral is retired; /api/cron/process-scheduled-deletions
 *                      only drains rows stamped before the 2026-08-07 change.)
 *   Suspend / temporary_pause
 *                   -> fire `offboarding_deactivate` (suspend only) with
 *                      deletion_mode: "none" and NO scheduled_deletion_at —
 *                      the account is never deleted; the person is expected
 *                      back (re-onboard or Manager "Reactivation"). This flow
 *                      is exclusively the suspend/temporary pathway now.
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
/** Manager -> My Team list "Suspend" button. Defaults to the SAME
 *  offboarding-deactivate flow HR temp pauses ride (the payload mirrors that
 *  envelope: deletion_mode "none", reason temporary_pause) — suspend only,
 *  never deletes, no offboard stamps. Own slug so the endpoint can be
 *  repointed independently in Admin -> Webhooks. */
export const MANAGER_SUSPEND_SLUG = "manager_suspend";
/** Manager -> My Team list "Reactivation" button: the n8n
 *  hris-reactivate-suspended flow re-enables a previously suspended Workspace
 *  account and emails a confirmation. Its own envelope, not the offboard one —
 *  see buildManagerReactivatePayload. */
export const MANAGER_REACTIVATE_SLUG = "manager_reactivate";

const DEACTIVATE_DEFAULT_URL =
  "https://simpledotbiz.app.n8n.cloud/webhook/offboarding-deactivate";
const DELETE_DEFAULT_URL =
  "https://simpledotbiz.app.n8n.cloud/webhook/offboarding-delete";
const MANAGER_OFFBOARD_NOTIFY_DEFAULT_URL =
  "https://simpledotbiz.app.n8n.cloud/webhook/manager-offboard-notify";
const MANAGER_SUSPEND_DEFAULT_URL = DEACTIVATE_DEFAULT_URL;
const MANAGER_REACTIVATE_DEFAULT_URL =
  "https://simpledotbiz.app.n8n.cloud/webhook/hris-reactivate-suspended";

/**
 * True when the department normalizes to the 'lead_gen' key. No longer part of
 * the offboard routing (every offboard deletes immediately) — still used by the
 * orientation flow for Lead-Gen-only behavior (CallTools provisioning).
 */
export function isLeadGenDepartment(department: string | null | undefined): boolean {
  return normalizeDeptToKey(department) === "lead_gen";
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
  } else if (slug === MANAGER_REACTIVATE_SLUG) {
    defaultUrl = MANAGER_REACTIVATE_DEFAULT_URL;
    envVars = ["N8N_MANAGER_REACTIVATE_WEBHOOK_URL"];
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
