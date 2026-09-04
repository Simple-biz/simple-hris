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
import type { CycleCloseoutRecord } from "@/lib/payroll/cycle-closeout";
import {
  CYCLE_COMPLETE_TRIGGER,
  cycleCompleteNotifiedKey,
  cycleCompleteStatsFromRecord,
  cycleReportSentKey,
  isReportableCycleComplete,
} from "@/lib/payroll/cycle-complete-trigger";
import {
  buildCycleCloseAttachments,
  describeAttachments,
  type CycleCloseAttachment,
} from "@/lib/payroll/cycle-close-attachments";

/**
 * "Payment cycle closed" celebration email to the Accounting team.
 *
 * ONE trigger (2026-09-04): `celebrateClosedCycle` is called by the close-out
 * route — and only by it — right after a FRESH close-out record was inserted.
 * Everything in the payload is read off that record; no request body can
 * influence a number. History and the two false firings that forced this:
 * `cycle-complete-trigger.ts`.
 *
 * The n8n workflow (references/n8n/payment-cycle-complete-celebration.workflow.json)
 * renders the HTML itself. We send the cycle's facts, the recipient list —
 * everyone holding the `accounting` role, as adjusted in Admin → Webhooks → Open
 * automation — and the three close-out files as base64 attachments.
 *
 * Two claims, both plain INSERTs on `app_settings` (key = primary key):
 *   - `dispatch.cycle_complete_notified.<file>` — the celebration, once per week
 *     EVER. Burned by a reopen, so a reopened week never celebrates again.
 *   - `dispatch.cycle_report_sent.<file>`      — the reports. DELETED by a reopen,
 *     so a re-close mails the new record's files, as a plain "close-out reports"
 *     email (`celebrate: false`).
 * Both claimed immediately before the fetch. Delivery failure releases whichever
 * claims this call inserted so the next close of the week can try again.
 */
export const PAYMENT_CYCLE_COMPLETE_SLUG = "payment_cycle_complete";

export type CycleCompleteRecipient = WebhookRecipient;

/**
 * Everyone currently holding the `accounting` role (revoked grants excluded),
 * with display names resolved best-effort from employee_ids. Same audience as
 * the CEO "Live payroll processing" directory (/api/ceo/accounting-team).
 */
export async function listAccountingCelebrationRecipients(): Promise<CycleCompleteRecipient[]> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return [];

  const { data: roleRows, error } = await supabase
    .from("employee_roles")
    .select("work_email")
    .eq("role", "accounting")
    .is("revoked_at", null);
  if (error || !roleRows) return [];

  const emails = Array.from(
    new Set(
      roleRows
        .map((r: { work_email?: string | null }) => normEmail(r.work_email ?? "") ?? "")
        .filter(Boolean),
    ),
  );
  if (emails.length === 0) return [];

  // Targeted name lookup — .in() on the handful of accounting emails, so the
  // PostgREST 1000-row cap can never truncate it. A missing name is fine; the
  // n8n template falls back to "Hi team,".
  const nameByEmail = new Map<string, string>();
  try {
    const { data: idRows } = await supabase
      .from("employee_ids")
      .select("name, work_email")
      .in("work_email", emails);
    for (const r of (idRows ?? []) as { name?: string | null; work_email?: string | null }[]) {
      const nm = (r.name ?? "").trim();
      const we = normEmail(r.work_email ?? "") ?? "";
      if (nm && we && !nameByEmail.has(we)) nameByEmail.set(we, nm);
    }
  } catch {
    /* names are best-effort */
  }

  return emails
    .map((email) => ({ email, name: nameByEmail.get(email) ?? null }))
    .sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
}

/** Resolve the configured celebration webhook (Admin -> Webhooks slug first,
 *  env fallback). `null` = feature not wired up yet. */
export function resolveCycleCompleteDelivery() {
  return resolveWebhookDelivery(PAYMENT_CYCLE_COMPLETE_SLUG, {
    envVars: ["N8N_PAYMENT_CYCLE_COMPLETE_WEBHOOK_URL"],
  });
}

export interface CycleCompletePayloadInput {
  record: CycleCloseoutRecord;
  /** false = the celebration claim was already burned (reopen → re-close); the
   *  workflow sends a plain "close-out reports" email instead of confetti. */
  celebrate: boolean;
  recipients: readonly WebhookRecipient[];
  attachments: readonly CycleCloseAttachment[];
  attachmentsError: string | null;
  /** Set on an Admin test run; the workflow may label the subject. */
  test?: boolean;
}

/**
 * The payload, built from the record and nothing else. Exported so the Admin
 * preview and test run send the exact shape production sends.
 */
export function buildCycleCompletePayload(input: CycleCompletePayloadInput): Record<string, unknown> {
  const { record } = input;
  const stats = cycleCompleteStatsFromRecord(record);
  return {
    event: "payment_cycle.completed",
    trigger: CYCLE_COMPLETE_TRIGGER,
    celebrate: input.celebrate,
    cycle: {
      source_file: record.source_file,
      cycle_id: record.cycle_id,
      label: record.label,
      period_start: record.period_start,
      period_end: record.period_end,
      completed_at: record.closed_at,
      completed_by: record.closed_by,
    },
    stats,
    recipients: input.recipients.map((r) => ({ email: r.email, name: r.name })),
    attachments: input.attachments,
    attachments_error: input.attachmentsError,
    sent_by: "system",
    ...(input.test ? { test: true } : {}),
  };
}

/** POST to n8n. The caller has already claimed; this just delivers. */
export async function postCycleCompleteWebhook(
  webhook: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number | null; detail: string | null }> {
  // Optional shared-secret header — pair with REQUIRED_SECRET in the workflow's
  // "Build Celebration Emails" node to lock the endpoint to this server.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = process.env.N8N_PAYMENT_CYCLE_COMPLETE_SECRET?.trim();
  if (secret) headers["x-webhook-secret"] = secret;
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      // Three attachments ride along; give n8n room to accept the body.
      signal: AbortSignal.timeout(30_000),
    });
    return { ok: res.ok, status: res.status, detail: res.ok ? null : `Webhook responded ${res.status}` };
  } catch (e) {
    return { ok: false, status: null, detail: e instanceof Error ? e.message : String(e) };
  }
}

export type CelebrateClosedCycleOutcome =
  | { fired: true; celebrate: boolean; sent: number; attachments: number }
  | {
      fired: false;
      reason:
        | "not_configured"
        | "no_recipients"
        | "not_reportable"
        | "already"
        | "claim_failed"
        | "delivery_failed"
        | "no_db";
      detail: string | null;
    };

/**
 * THE trigger. Called from the close-out route after a fresh record was filed.
 *
 * Order: resolve webhook → audience → stats check → build attachments → CLAIM →
 * POST → audit. Pre-checks run before the claim so an unwired environment or an
 * empty audience never burns the week's one shot.
 */
export async function celebrateClosedCycle(
  record: CycleCloseoutRecord,
  actor: { user_name: string; user_role: string },
): Promise<CelebrateClosedCycleOutcome> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { fired: false, reason: "no_db", detail: "Supabase client unavailable" };

  const delivery = await resolveCycleCompleteDelivery();
  if (!delivery) return { fired: false, reason: "not_configured", detail: null };

  const defaults = await listAccountingCelebrationRecipients();
  const { effective: recipients } = applyRecipientOverride(defaults, delivery.recipients);
  if (recipients.length === 0) return { fired: false, reason: "no_recipients", detail: null };

  const stats = cycleCompleteStatsFromRecord(record);
  if (!isReportableCycleComplete({ paidCount: stats.paid_count, totalCount: stats.total_count })) {
    return {
      fired: false,
      reason: "not_reportable",
      detail: `record names ${stats.paid_count} paid of ${stats.total_count}`,
    };
  }

  // Attachments before the claim: a slow build must not hold a claim open, and
  // a failed build still ships the email (with `attachments_error`).
  const built = await buildCycleCloseAttachments(supabase, record);

  // ── CLAIMS, immediately before the send ────────────────────────────────────
  const now = new Date().toISOString();
  const celebrationKey = cycleCompleteNotifiedKey(record.source_file);
  const reportKey = cycleReportSentKey(record.source_file);
  const claimValue = (extra: Record<string, unknown>) =>
    JSON.stringify({
      at: now,
      by: actor.user_name,
      trigger: CYCLE_COMPLETE_TRIGGER,
      paid_count: stats.paid_count,
      total_count: stats.total_count,
      unpaid_count: stats.unpaid_count,
      notified: recipients.length,
      ...extra,
    });

  const inserted: string[] = [];
  const release = async () => {
    for (const key of inserted) {
      await supabase.from("app_settings").delete().eq("key", key);
    }
  };

  const { error: celErr } = await supabase
    .from("app_settings")
    .insert({ key: celebrationKey, value: claimValue({}), updated_at: now });
  let celebrate: boolean;
  if (!celErr) {
    celebrate = true;
    inserted.push(celebrationKey);
  } else if (celErr.code === "23505") {
    celebrate = false; // burned (reopen) or already mailed — reports may still go
  } else {
    return { fired: false, reason: "claim_failed", detail: celErr.message };
  }

  if (built.attachments.length > 0 || !celebrate) {
    const { error: repErr } = await supabase
      .from("app_settings")
      .insert({ key: reportKey, value: claimValue({ attachments: describeAttachments(built.attachments), celebrate }), updated_at: now });
    if (!repErr) {
      inserted.push(reportKey);
    } else if (repErr.code === "23505") {
      if (!celebrate) {
        // Neither claim is ours: this week already celebrated AND already got
        // its reports. Nothing to send.
        return { fired: false, reason: "already", detail: null };
      }
      // Celebration is ours but a reports row already exists (cannot happen on a
      // fresh close — the reopen deletes it — but if it did, the email still
      // carries the files; the row is informational).
    } else {
      await release();
      return { fired: false, reason: "claim_failed", detail: repErr.message };
    }
  }

  const { payload, rejected } = mergePayloadOverrides(
    buildCycleCompletePayload({
      record,
      celebrate,
      recipients,
      attachments: built.attachments,
      attachmentsError: built.error,
    }),
    delivery.payloadOverrides,
  );

  const result = await postCycleCompleteWebhook(delivery.url, payload);
  if (!result.ok) {
    // Nothing was emailed — release what we claimed so the next close can retry.
    // Best-effort: if the release itself fails the week stays claimed and stays
    // silent rather than risking a double-send.
    await release();
    return { fired: false, reason: "delivery_failed", detail: result.detail };
  }

  await insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: "payment_cycle.completed",
    resource: "payment_dispatches",
    resource_id: record.source_file,
    details: {
      source_file: record.source_file,
      cycle_id: record.cycle_id,
      trigger: CYCLE_COMPLETE_TRIGGER,
      via: "cycle_closeout",
      celebrate,
      ...stats,
      notified: recipients.length,
      recipients: recipients.map((r) => r.email),
      recipient_override: delivery.recipients ? delivery.recipients.mode : null,
      payload_overrides_rejected: rejected,
      attachments: describeAttachments(built.attachments),
      attachments_error: built.error,
      webhook_slug: PAYMENT_CYCLE_COMPLETE_SLUG,
      webhook_source: delivery.source,
    },
  }).catch(() => undefined);

  return { fired: true, celebrate, sent: recipients.length, attachments: built.attachments.length };
}
