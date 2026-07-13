import { resolveWebhookUrl } from "@/lib/webhooks/resolve-webhook";

/**
 * CallTools-creation webhook — fired when a manager marks a LEAD GEN hire as
 * having ATTENDED orientation (Manager -> Newly Hired tab; the bulk date-apply
 * fires one event per hire). Non-Lead-Gen hires fire nothing: this webhook
 * exists solely so n8n can provision the CallTools dialer agent, so the
 * payload carries the dialer identity captured on the onboarding paperwork
 * plus the hire's Payment Catalog rates:
 *
 *   calltools_nickname — the nickname the hire typed ("Mikey")
 *   calltools_username — the collision-safe minted username ("Mikey J. T.",
 *                        see src/lib/hr/calltools-username.ts; minted at mark
 *                        time for paperwork that predates the feature)
 *   pay_rate / regular_rate / ot_rate — same convention as the
 *                        create-workspace-account payload (pay_rate falls back
 *                        to 0 when Accounting hasn't set the rate yet)
 *
 * Marking is IDEMPOTENT (re-marking just edits the orientation date), so a
 * re-mark re-fires this webhook with `already_marked: true` — the n8n flow
 * must treat that as "the date changed", NOT "create another account".
 *
 * URL resolution goes through the Admin -> Webhooks slug registry
 * (resolveWebhookUrl, slug `call_tools_creation` — registered from the Admin
 * dashboard) so the endpoint can be rotated from the UI without a redeploy;
 * falls back to the env var, then the hardcoded default.
 */
export const CALLTOOLS_CREATION_SLUG = "call_tools_creation";

const DEFAULT_URL =
  "https://simpledotbiz.app.n8n.cloud/webhook/calltools-creation";

export type CallToolsCreationPayload = {
  event: "hire.orientation_attended";
  pending_employee_id: number;
  name: string | null;
  work_email: string | null;
  personal_email: string | null;
  department: string | null;
  /** Always true — the webhook only fires for Lead Gen. Kept for mapping
   *  stability with the other webhook payloads. */
  lead_gen: boolean;
  calltools_nickname: string | null;
  calltools_username: string | null;
  /** Regular rate as a number, 0 when Accounting hasn't set it yet — mirrors
   *  the create-workspace-account payload convention. */
  pay_rate: number;
  regular_rate: number | null;
  ot_rate: number | null;
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
 * POSTs the CallTools-creation payload to the resolved n8n endpoint.
 * Best-effort, never throws — the DB mark is the source of truth and must not
 * be blocked by a webhook hiccup. 25s timeout, mirroring the other n8n
 * webhooks.
 */
export async function fireCallToolsCreationWebhook(
  payload: CallToolsCreationPayload,
): Promise<OrientationWebhookResult> {
  let url: string;
  try {
    url =
      (await resolveWebhookUrl(CALLTOOLS_CREATION_SLUG, {
        envVars: ["N8N_CALLTOOLS_CREATION_WEBHOOK_URL"],
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
        `[calltools] creation webhook (${url}) returned ${res.status}`,
      );
      return { fired: true, status: res.status, error: `HTTP ${res.status}` };
    }
    return { fired: true, status: res.status, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[calltools] creation webhook threw: ${msg}`);
    return { fired: false, status: null, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}
