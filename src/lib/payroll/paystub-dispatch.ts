import { resolveWebhookUrl } from "@/lib/webhooks/resolve-webhook";
import { findRateConsistencyIssues } from "@/lib/payroll/paystub-rate-consistency";

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

/**
 * Reports any pay line whose displayed rate exceeds the rate its own amount was
 * computed at — the ₱225-shown / ₱175-paid defect. Does NOT block the send: payroll
 * must never be halted by a check, and the wizard now derives the displayed rate
 * FROM the rate actually paid, so a freshly-staged payload cannot contradict itself.
 * This only ever fires on payloads staged before that fix, and it is logged so a
 * stale queue row is visible rather than silently emailed.
 */
function findUnderpaidLines(employees: unknown[]): string[] {
  const out: string[] = [];
  for (const e of employees) {
    if (!e || typeof e !== "object") continue;
    const emp = e as Record<string, unknown>;
    // The staged payload's weekend carve-out (snake_case on the wire) mapped onto the
    // checker's shape. Without this the weekend line — which renders its own
    // hours × rate — is never validated, which is how a ₱1,053.33 shortfall reached a
    // preview stub with the guard reporting nothing.
    const wknd = emp.weekend as
      | {
          hours?: { regular?: number | null; ot?: number | null } | null;
          pay_php?: { regular?: number | null; ot?: number | null } | null;
          premium_php_per_hour?: number | null;
        }
      | null
      | undefined;
    const issues = findRateConsistencyIssues({
      hours: emp.hours as { regular?: number | null; ot?: number | null } | null,
      ratesPhp: emp.rates_php as { regular?: number | null; ot?: number | null } | null,
      payPhp: emp.pay_php as { regular?: number | null; ot?: number | null } | null,
      weekend: wknd
        ? {
            hours: wknd.hours ?? null,
            payPhp: wknd.pay_php ?? null,
            premiumPhpPerHour: wknd.premium_php_per_hour ?? null,
          }
        : null,
    }).filter((i) => i.deltaPhp > 0);
    if (issues.length === 0) continue;
    const who =
      (typeof emp.name === "string" && emp.name) ||
      (typeof emp.email === "string" && emp.email) ||
      "unknown recipient";
    for (const i of issues) out.push(`${who} — ${i.message}`);
  }
  return out;
}

export async function forwardPaystubDispatch(
  body: PaystubDispatchBody,
): Promise<ForwardResult> {
  const underpaid = findUnderpaidLines(body.employees ?? []);
  if (underpaid.length > 0) {
    // Visible in the server log, not fatal — see findUnderpaidLines.
    console.warn(
      `[paystub-dispatch] ${underpaid.length} stale pay line(s) show a rate above what was paid: ` +
        underpaid.slice(0, 5).join(" | "),
    );
  }

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
