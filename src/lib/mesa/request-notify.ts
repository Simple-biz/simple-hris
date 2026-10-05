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
  MESA_REQUEST_DEFAULT_RECIPIENTS,
  MESA_REQUEST_NOTIFY_SLUG,
  buildMesaRequestPayload,
  type MesaRequestNotifyRow,
} from "./request-notify-payload";

/**
 * "New MESA request" email — the server half (docs/features/mesa-request-notify.md).
 *
 * ONE trigger: `notifyMesaRequested` is called by POST /api/mesa-requests,
 * inside `after()`, right after a member's opt-out / disbursement / return row
 * was filed. Nothing Accounting does (approve, deny, archive) fires it.
 *
 * Strictly best-effort and it never throws: the request is already filed and
 * visible in Accounting → MESA → Requests; this email is an extra nudge. Every
 * ATTEMPTED send is audited as `webhook.mesa_request_notify`. An unwired
 * environment (no URL) is silent — no audit row per request until the workflow
 * is imported.
 */

/**
 * Admin → Webhooks slug ONLY — deliberately no env fallback. `null` = not wired up yet.
 *
 * The recipients are edited in Admin → Webhooks → Open automation and saved on the
 * slug's `webhooks.config` entry. `resolveWebhookDelivery` applies those edits only
 * when the URL also comes from that entry: an env-var URL carries no overrides, so
 * the email would go to the code defaults while the editor showed the edited list
 * (Kane, 2026-10-05: "make sure that in ADMIN we can edit the recipients"). With the
 * card as the only source, an edited list is always the list that is mailed.
 */
export function resolveMesaRequestDelivery() {
  return resolveWebhookDelivery(MESA_REQUEST_NOTIFY_SLUG);
}

/**
 * The code default (carla@ + april@) with display names looked up best-effort —
 * a targeted `.in()` on the default's two addresses, so the PostgREST 1000-row
 * cap cannot truncate it. A missing name is fine; the email greets "Hi,".
 */
export async function listMesaRequestDefaultRecipients(): Promise<WebhookRecipient[]> {
  const emails = MESA_REQUEST_DEFAULT_RECIPIENTS.map((r) => r.email);
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
  return MESA_REQUEST_DEFAULT_RECIPIENTS.map((r) => ({
    email: r.email,
    name: nameByEmail.get(r.email) ?? r.name ?? null,
  }));
}

/** POST to n8n. Optional shared secret pairs with REQUIRED_SECRET in the
 *  workflow's "Build MESA Emails" node. */
export async function postMesaRequestWebhook(
  webhook: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number | null; detail: string | null }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = process.env.N8N_MESA_REQUEST_NOTIFY_SECRET?.trim();
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

export type MesaRequestNotifyOutcome =
  | { sent: true; recipients: number }
  | { sent: false; reason: "not_configured" | "no_recipients" | "delivery_failed" | "threw"; detail: string | null };

/** THE trigger. Never throws. */
export async function notifyMesaRequested(row: MesaRequestNotifyRow): Promise<MesaRequestNotifyOutcome> {
  try {
    const delivery = await resolveMesaRequestDelivery();
    if (!delivery) return { sent: false, reason: "not_configured", detail: null };

    const defaults = await listMesaRequestDefaultRecipients();
    const { effective } = applyRecipientOverride(defaults, delivery.recipients);

    const audit = (details: Record<string, unknown>) =>
      insertAuditLog({
        user_name: "MESA Request Notify",
        user_role: "System",
        action: "webhook.mesa_request_notify",
        resource: "mesa_requests",
        resource_id: row.id,
        details: {
          slug: MESA_REQUEST_NOTIFY_SLUG,
          employee: row.work_email,
          request_type: row.request_type,
          webhook_source: delivery.source,
          ...details,
        },
      }).catch(() => undefined);

    // An override that resolves to nobody is a refusal, not an empty send.
    if (effective.length === 0) {
      await audit({ ok: false, reason: "no_recipients" });
      return { sent: false, reason: "no_recipients", detail: null };
    }

    const { payload, rejected } = mergePayloadOverrides(
      buildMesaRequestPayload({ row, recipients: effective }),
      delivery.payloadOverrides,
    );
    const result = await postMesaRequestWebhook(delivery.url, payload);
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
