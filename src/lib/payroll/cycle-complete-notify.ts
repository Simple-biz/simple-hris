import "server-only";

import { resolveWebhookUrl } from "@/lib/webhooks/resolve-webhook";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { normEmail } from "@/lib/email/norm-email";

/**
 * "Payment cycle 100% complete" celebration email to the Accounting team.
 *
 * Fired (via /api/payment-dispatches/cycle-complete) when the Payment Dispatch
 * progress strip reaches 100% — nothing pending, nothing blocked, everyone in
 * the cycle paid. The n8n workflow (references/n8n/
 * payment-cycle-complete-celebration.workflow.json) renders the full
 * confetti-and-balloons HTML itself, so all we send is the cycle's facts plus
 * the recipient list — everyone currently holding the `accounting` role.
 *
 * Strictly best-effort: a webhook hiccup never breaks the dispatch screen. The
 * ROUTE owns the once-per-cycle guarantee (an app_settings claim); this module
 * only knows how to find the audience and deliver the payload.
 *
 * Uses its own webhook (slug `payment_cycle_complete`) configured in Admin ->
 * Webhooks or via N8N_PAYMENT_CYCLE_COMPLETE_WEBHOOK_URL. With nothing
 * configured this no-ops.
 */
export const PAYMENT_CYCLE_COMPLETE_SLUG = "payment_cycle_complete";

export interface CycleCompleteRecipient {
  email: string;
  name: string | null;
}

export interface CycleCompleteCelebrationInput {
  sourceFile: string;
  cycleId?: string | null;
  /** Human cycle label, e.g. "Jul 19 – 25, 2026" (client-formatted). */
  label?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  /** Who logged the final payment (session actor of the triggering request). */
  completedBy?: string | null;
  /** ISO timestamp of when 100% was reached. */
  completedAt: string;
  stats: {
    paid_count: number;
    total_count: number;
    total_paid_usd?: number | null;
    total_paid_php?: number | null;
  };
}

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

/** Resolve the configured celebration webhook URL (Admin -> Webhooks slug first,
 *  env fallback). `null` = feature not wired up yet. */
export async function resolveCycleCompleteWebhook(): Promise<string | null> {
  return resolveWebhookUrl(PAYMENT_CYCLE_COMPLETE_SLUG, {
    envVars: ["N8N_PAYMENT_CYCLE_COMPLETE_WEBHOOK_URL"],
  });
}

/**
 * POST the celebration to n8n. The caller has already resolved the webhook and
 * the audience (and claimed the once-per-cycle marker) — this just delivers.
 */
export async function postCycleCompleteCelebration(
  webhook: string,
  input: CycleCompleteCelebrationInput,
  recipients: CycleCompleteRecipient[],
): Promise<{ ok: boolean; sent: number; detail: string | null }> {
  if (recipients.length === 0) return { ok: false, sent: 0, detail: "No recipients" };

  // Optional shared-secret header — pair with REQUIRED_SECRET in the workflow's
  // "Build Celebration Emails" node to lock the endpoint to this server.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = process.env.N8N_PAYMENT_CYCLE_COMPLETE_SECRET?.trim();
  if (secret) headers["x-webhook-secret"] = secret;

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers,
      body: JSON.stringify({
        event: "payment_cycle.completed",
        cycle: {
          source_file: input.sourceFile,
          cycle_id: input.cycleId ?? null,
          label: input.label ?? null,
          period_start: input.periodStart ?? null,
          period_end: input.periodEnd ?? null,
          completed_at: input.completedAt,
          completed_by: input.completedBy ?? null,
        },
        stats: {
          paid_count: input.stats.paid_count,
          total_count: input.stats.total_count,
          total_paid_usd: input.stats.total_paid_usd ?? null,
          total_paid_php: input.stats.total_paid_php ?? null,
        },
        recipients,
        sent_by: "system",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return {
      ok: res.ok,
      sent: res.ok ? recipients.length : 0,
      detail: res.ok ? null : `Webhook responded ${res.status}`,
    };
  } catch (e) {
    return { ok: false, sent: 0, detail: e instanceof Error ? e.message : String(e) };
  }
}
