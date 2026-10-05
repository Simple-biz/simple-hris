import "server-only";

import { resolveWebhookDelivery } from "@/lib/webhooks/resolve-webhook";
import {
  applyRecipientOverride,
  mergePayloadOverrides,
  type WebhookRecipient,
} from "@/lib/webhooks/webhook-config";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { normEmail } from "@/lib/email/norm-email";
import {
  COE_REQUEST_DEFAULT_RECIPIENTS,
  COE_REQUEST_NOTIFY_SLUG,
  buildCoeRequestPayload,
  type CoeRequestNotifyRow,
} from "./coe-request-notify-payload";

/**
 * "COE requested" email — the server half (docs/features/coe-request-notify.md).
 *
 * ONE trigger: `notifyCoeRequested` is called by POST /api/employee/documents,
 * inside `after()`, right after an employee's COE row was filed. Accounting's
 * Generate COE does not call it — that row is signed in the same click, so
 * nothing is waiting for anyone.
 *
 * Strictly best-effort and it never throws: the employee's request is already
 * filed and visible in Accounting → Documents (plus the in-app
 * `documents.requested` ping); this email is an extra nudge. Every ATTEMPTED send
 * is audited as `webhook.coe_request_notify` so "did Jake get it?" has an answer.
 * An unwired environment (no URL) is silent — no audit row per request until the
 * workflow is imported.
 */

/** Admin → Webhooks slug first, env fallback. `null` = not wired up yet. */
export function resolveCoeRequestDelivery() {
  return resolveWebhookDelivery(COE_REQUEST_NOTIFY_SLUG, {
    envVars: ["N8N_COE_REQUEST_NOTIFY_WEBHOOK_URL"],
  });
}

/**
 * The code default (jakec@simple.biz) with display names looked up best-effort
 * — a targeted `.in()` on the default's handful of addresses, so the PostgREST
 * 1000-row cap cannot truncate it. A missing name is fine; the email greets
 * "Hi," and the editor shows the address.
 */
export async function listCoeRequestDefaultRecipients(): Promise<WebhookRecipient[]> {
  const emails = COE_REQUEST_DEFAULT_RECIPIENTS.map((r) => r.email);
  const nameByEmail = new Map<string, string>();
  try {
    const supabase = createSupabaseServiceRoleClient();
    if (supabase && emails.length) {
      const { data } = await supabase
        .from("employee_ids")
        .select("name, work_email")
        .in("work_email", emails);
      for (const r of (data ?? []) as { name?: string | null; work_email?: string | null }[]) {
        const nm = (r.name ?? "").trim();
        const we = normEmail(r.work_email ?? "") ?? "";
        if (nm && we && !nameByEmail.has(we)) nameByEmail.set(we, nm);
      }
    }
  } catch {
    /* names are best-effort */
  }
  return COE_REQUEST_DEFAULT_RECIPIENTS.map((r) => ({
    email: r.email,
    name: nameByEmail.get(r.email) ?? r.name ?? null,
  }));
}

/** POST to n8n. Optional shared secret pairs with REQUIRED_SECRET in the
 *  workflow's "Build COE Emails" node. */
export async function postCoeRequestWebhook(
  webhook: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number | null; detail: string | null }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = process.env.N8N_COE_REQUEST_NOTIFY_SECRET?.trim();
  if (secret) headers["x-webhook-secret"] = secret;
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: res.ok, status: res.status, detail: res.ok ? null : `Webhook responded ${res.status}` };
  } catch (e) {
    return { ok: false, status: null, detail: e instanceof Error ? e.message : String(e) };
  }
}

export type CoeRequestNotifyOutcome =
  | { sent: true; recipients: number }
  | { sent: false; reason: "not_configured" | "no_recipients" | "delivery_failed" | "threw"; detail: string | null };

/** THE trigger. Never throws. */
export async function notifyCoeRequested(row: CoeRequestNotifyRow): Promise<CoeRequestNotifyOutcome> {
  try {
    const delivery = await resolveCoeRequestDelivery();
    if (!delivery) return { sent: false, reason: "not_configured", detail: null };

    const defaults = await listCoeRequestDefaultRecipients();
    const { effective } = applyRecipientOverride(defaults, delivery.recipients);

    const audit = (details: Record<string, unknown>) =>
      insertAuditLog({
        user_name: "COE Request Notify",
        user_role: "System",
        action: "webhook.coe_request_notify",
        resource: "document_requests",
        resource_id: row.id,
        details: {
          slug: COE_REQUEST_NOTIFY_SLUG,
          employee: row.employee_email,
          webhook_source: delivery.source,
          ...details,
        },
      }).catch(() => undefined);

    // An override that resolves to nobody is a refusal, not an empty send —
    // same rule as the celebration. Logged so a bad edit is visible.
    if (effective.length === 0) {
      await audit({ ok: false, reason: "no_recipients" });
      return { sent: false, reason: "no_recipients", detail: null };
    }

    const { payload, rejected } = mergePayloadOverrides(
      buildCoeRequestPayload({ row, recipients: effective }),
      delivery.payloadOverrides,
    );
    const result = await postCoeRequestWebhook(delivery.url, payload);
    await audit({
      ok: result.ok,
      status: result.status,
      detail: result.detail,
      to: effective.map((r) => r.email),
      payload_overrides_rejected: rejected,
    });
    return result.ok
      ? { sent: true, recipients: effective.length }
      : { sent: false, reason: "delivery_failed", detail: result.detail };
  } catch (e) {
    return { sent: false, reason: "threw", detail: e instanceof Error ? e.message : String(e) };
  }
}
