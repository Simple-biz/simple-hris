import { resolveWebhookUrl } from "@/lib/webhooks/resolve-webhook";
import { findRateConsistencyIssues } from "@/lib/payroll/paystub-rate-consistency";
import { mapPayloadToPayStub, type PayStubView } from "@/lib/payroll/paystub-view";
import {
  payStubEmailSubject,
  renderPayStubEmailHtml,
  type PayStubEmailOptions,
} from "@/lib/payroll/paystub-email-html";

/**
 * Forwards a paystub dispatch payload to the n8n paystub workflow webhook,
 * keeping the webhook URL server-side. Shared by:
 *   - POST /api/dispatch-paystubs  (manual / preview send)
 *   - POST /api/payment-dispatches (per-employee send when Lenny marks Paid)
 *
 * The n8n workflow does Split Out on `employees` + Loop (batchSize 1), so a
 * one-element `employees` array is the normal single-paystub case.
 *
 * Every employee item is decorated here with `paystub_html` + `paystub_subject`
 * — the fully-rendered email, built from the SAME `PayStubView` the wizard
 * preview and the in-app statement render. n8n only pipes it to Gmail. Doing it
 * in this shared helper (rather than at each call site) is deliberate: it is the
 * one place both dispatch paths pass through, so a new sender cannot forget to
 * render the document and silently fall back to n8n's stale hand-written HTML.
 */
export interface PaystubDispatchBody {
  pay_period?: Record<string, unknown> | null;
  employees: unknown[];
  cycle?: Record<string, unknown> | null;
  /**
   * Optional pre-resolved statement views, index-aligned with `employees`. The
   * mark-paid path passes its reconciled view (the one whose total matches the
   * money that actually moved, plus any COP decoration); anything left null is
   * derived from the employee payload itself.
   */
  views?: Array<PayStubView | null> | null;
  /** Paid pill state, applied to every statement in this send. */
  emailOptions?: PayStubEmailOptions;
}

/**
 * Attach the rendered statement to each employee item. Best-effort per person:
 * if one payload is malformed enough to throw, that item simply goes out without
 * `paystub_html` (n8n skips it and logs a failed send) rather than taking the
 * whole batch — and the rest of the run still delivers.
 */
function withRenderedStatements(
  employees: unknown[],
  views: Array<PayStubView | null> | null | undefined,
  emailOptions: PayStubEmailOptions | undefined,
): unknown[] {
  return employees.map((e, i) => {
    if (!e || typeof e !== "object") return e;
    try {
      const view = views?.[i] ?? mapPayloadToPayStub(e as Record<string, unknown>);
      return {
        ...(e as Record<string, unknown>),
        paystub_subject: payStubEmailSubject(view),
        paystub_html: renderPayStubEmailHtml(view, emailOptions ?? {}),
      };
    } catch (err) {
      console.error(
        `[paystub-dispatch] could not render the statement for employee #${i}:`,
        err instanceof Error ? err.message : String(err),
      );
      return e;
    }
  });
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
    // A prorated week stages per-day weekend segments, and the statement renders
    // THOSE rates rather than (rates_php + premium) — so they are what this guard
    // must check. Without them it validates a rate the stub never printed.
    const prorSegs = (emp.proration as { segments?: Record<string, unknown> } | null | undefined)
      ?.segments;
    const toSegs = (v: unknown) =>
      Array.isArray(v)
        ? v
            .map((s) => s as Record<string, unknown>)
            .map((s) => ({
              ratePhp: Number(s.rate_php),
              hours: Number(s.hours),
              payPhp: Number(s.pay_php),
            }))
            .filter((s) => [s.ratePhp, s.hours, s.payPhp].every(Number.isFinite))
        : [];
    const issues = findRateConsistencyIssues({
      hours: emp.hours as { regular?: number | null; ot?: number | null } | null,
      ratesPhp: emp.rates_php as { regular?: number | null; ot?: number | null } | null,
      payPhp: emp.pay_php as { regular?: number | null; ot?: number | null } | null,
      weekend: wknd
        ? {
            hours: wknd.hours ?? null,
            payPhp: wknd.pay_php ?? null,
            premiumPhpPerHour: wknd.premium_php_per_hour ?? null,
            segments: prorSegs
              ? {
                  regular: toSegs(prorSegs.weekend_regular),
                  ot: toSegs(prorSegs.weekend_ot),
                }
              : null,
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
      body: JSON.stringify({
        pay_period: body.pay_period ?? null,
        cycle: body.cycle ?? null,
        employees: withRenderedStatements(
          body.employees ?? [],
          body.views,
          body.emailOptions,
        ),
      }),
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
