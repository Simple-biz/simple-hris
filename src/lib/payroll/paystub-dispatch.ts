import { resolveWebhookUrl } from "@/lib/webhooks/resolve-webhook";

/**
 * Forwards a paystub dispatch payload to the n8n paystub workflow webhook,
 * keeping the webhook URL server-side. Shared by:
 *   - POST /api/dispatch-paystubs  (manual / preview send)
 *   - POST /api/payment-dispatches (per-employee send when Lenny marks Paid)
 *
 * The n8n workflow does Split Out on `employees` + Loop (batchSize 1), so a
 * one-element `employees` array is the normal single-paystub case.
 */
export interface PaystubDispatchBody {
  pay_period?: Record<string, unknown> | null;
  employees: unknown[];
  cycle?: Record<string, unknown> | null;
}

export interface ForwardResult {
  ok: boolean;
  /** True only when no webhook is configured at all (distinct from a send error). */
  notConfigured?: boolean;
  status: number | null;
  detail: string | null;
  parsed?: unknown;
}

export async function forwardPaystubDispatch(
  body: PaystubDispatchBody,
): Promise<ForwardResult> {
  const webhookUrl = await resolveWebhookUrl("paystub_dispatch", {
    envVars: ["N8N_DISPATCH_WEBHOOK_URL"],
  });
  if (!webhookUrl) {
    return {
      ok: false,
      notConfigured: true,
      status: null,
      detail:
        "No paystub_dispatch webhook configured (Admin → Webhooks) and N8N_DISPATCH_WEBHOOK_URL env var unset",
    };
  }

  try {
    // Bound the call so a slow/unreachable n8n can't hang the caller (the
    // mark-paid response awaits this). 25s is generous for a single paystub.
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, detail: text.slice(0, 500) };
    }
    return { ok: true, status: res.status, detail: null, parsed: safeParse(text) };
  } catch (err) {
    return {
      ok: false,
      status: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
