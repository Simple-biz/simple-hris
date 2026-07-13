import { resolveWebhookUrl } from "@/lib/webhooks/resolve-webhook";

/**
 * Fired when a manager marks a newly hired person as having ATTENDED
 * orientation (Manager -> Newly Hired tab; the bulk date-apply fires one event
 * per hire). The n8n flow provisions the hire's day-one accounts — for Lead
 * Gen that means the CallTools dialer agent, so the payload carries the dialer
 * fields captured on the onboarding paperwork:
 *
 *   calltools_nickname — the nickname the hire typed ("Mikey")
 *   calltools_username — the collision-safe minted username ("Mikey J. T.",
 *                        see src/lib/hr/calltools-username.ts)
 *
 * Both are null for non-Lead-Gen hires, and for rows submitted before the
 * add_calltools_username_to_onboarding.sql migration ran — n8n should branch
 * on `lead_gen` + a non-null `calltools_username`.
 *
 * Marking is IDEMPOTENT (re-marking just edits the orientation date), so a
 * re-mark re-fires this webhook with `already_marked: true` — the n8n flow
 * must treat that as "the date changed", NOT "create another account".
 *
 * URL resolution goes through the Admin -> Webhooks slug registry
 * (resolveWebhookUrl) so the endpoint can be rotated from the UI without a
 * redeploy; falls back to the env var, then the hardcoded default.
 */
export const ORIENTATION_ATTENDED_SLUG = "orientation_attended";

const DEFAULT_URL =
  "https://simpledotbiz.app.n8n.cloud/webhook/orientation-attended";

export type OrientationAttendedPayload = {
  event: "hire.orientation_attended";
  pending_employee_id: number;
  name: string | null;
  work_email: string | null;
  personal_email: string | null;
  department: string | null;
  lead_gen: boolean;
  calltools_nickname: string | null;
  calltools_username: string | null;
  /** Manila calendar date (YYYY-MM-DD) the manager picked — this is also the
   *  hire's Start Date on the master list. */
  attended_on: string | null;
  /** The stored timestamptz (start of `attended_on` in Manila, UTC ISO). */
  orientation_attended_at: string | null;
  marked_by: string;
  note: string | null;
  /** True when this mark overwrote an earlier one (date edit / bulk re-apply)
   *  — a dedupe signal so n8n doesn't provision twice. */
  already_marked: boolean;
};

export type OrientationWebhookResult = {
  fired: boolean;
  status: number | null;
  error: string | null;
};

/**
 * POSTs the attended payload to the resolved n8n endpoint. Best-effort, never
 * throws — the DB mark is the source of truth and must not be blocked by a
 * webhook hiccup. 25s timeout, mirroring the other n8n webhooks.
 */
export async function fireOrientationAttendedWebhook(
  payload: OrientationAttendedPayload,
): Promise<OrientationWebhookResult> {
  let url: string;
  try {
    url =
      (await resolveWebhookUrl(ORIENTATION_ATTENDED_SLUG, {
        envVars: ["N8N_ORIENTATION_ATTENDED_WEBHOOK_URL"],
        defaultUrl: DEFAULT_URL,
      })) ?? DEFAULT_URL;
  } catch (e) {
    return {
      fired: false,
      status: null,
      error: e instanceof Error ? e.message : String(e),
    };
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
      console.error(
        `[orientation] attended webhook (${url}) returned ${res.status}`,
      );
      return { fired: true, status: res.status, error: `HTTP ${res.status}` };
    }
    return { fired: true, status: res.status, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[orientation] attended webhook threw: ${msg}`);
    return { fired: false, status: null, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}
