import { NextRequest, NextResponse } from "next/server";
import { requireRateVisibilityOrFeatureEdit } from "@/lib/auth/authorize-feature";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { getSessionActor } from "@/lib/auth/session-actor";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import {
  listAccountingCelebrationRecipients,
  postCycleCompleteCelebration,
  resolveCycleCompleteWebhook,
} from "@/lib/payroll/cycle-complete-notify";
import {
  asCycleCompleteTrigger,
  cycleCompleteNotifiedKey,
  isReportableCycleComplete,
} from "@/lib/payroll/cycle-complete-trigger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/payment-dispatches/cycle-complete
 *
 * The Payment Dispatch screen calls this when its progress strip reaches 100%
 * (no pending payments, nobody blocked, ≥1 paid). The server then emails every
 * `accounting`-role holder a confetti congratulations via the
 * `payment_cycle_complete` n8n webhook.
 *
 * ONCE-PER-CYCLE: before sending we INSERT a per-source-file marker into
 * app_settings. `key` is unique, so when several clerks' browsers all see 100%
 * at the same moment exactly one insert wins — the rest get a duplicate-key
 * error and report `already: true` without sending. An undo → re-pay later the
 * same week finds the marker and stays silent too: one celebration per cycle,
 * ever. The marker is only released if the webhook delivery itself fails, so a
 * transient n8n outage can be retried by reopening the screen.
 *
 * Pre-checks (webhook configured? any accounting recipients?) run BEFORE the
 * claim so an unconfigured environment doesn't burn the cycle's one shot.
 */

interface PostBody {
  source_file?: unknown;
  cycle_id?: unknown;
  label?: unknown;
  period_start?: unknown;
  period_end?: unknown;
  paid_count?: unknown;
  total_count?: unknown;
  total_paid_usd?: unknown;
  total_paid_php?: unknown;
  /** 'fully_paid' (strip hit 100%) | 'cycle_closed' (Accounting closed the week). */
  trigger?: unknown;
  /** Payable people left unpaid — only meaningful on the `cycle_closed` arm. */
  unpaid_count?: unknown;
}

// One spelling of the claim key, shared with `reopenCycle` (which burns it so a
// reopened week can never celebrate again). See cycle-complete-trigger.ts.
const claimKeyFor = cycleCompleteNotifiedKey;

function cleanStr(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function cleanNum(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function POST(req: NextRequest) {
  // Same gate as the dispatch-queue reads: whoever can watch the progress strip
  // reach 100% may report it.
  const authz = await requireRateVisibilityOrFeatureEdit("accounting", "payment_dispatch");
  if (!authz.ok) return deniedResponse(authz);

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ fired: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const sourceFile = cleanStr(body.source_file, 300);
  const paidCount = cleanNum(body.paid_count);
  const totalCount = cleanNum(body.total_count);
  if (!sourceFile) {
    return NextResponse.json({ fired: false, error: "source_file is required" }, { status: 400 });
  }
  // Defensive server-side sanity, per arm (`cycle-complete-trigger.ts`):
  // `fully_paid` still demands paid === total; `cycle_closed` accepts a real
  // shortfall — Accounting closed the week — but still refuses a report naming
  // nobody paid, or more paid than the cycle ever held.
  const trigger = asCycleCompleteTrigger(body.trigger);
  if (
    paidCount === null ||
    totalCount === null ||
    !isReportableCycleComplete({ trigger, paidCount, totalCount })
  ) {
    return NextResponse.json(
      {
        fired: false,
        error:
          trigger === "cycle_closed"
            ? "paid_count must be > 0 and total_count >= paid_count"
            : "paid_count and total_count must be equal and > 0",
      },
      { status: 400 },
    );
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({ fired: false, error: "Supabase client unavailable" }, { status: 500 });
  }

  // ── Pre-checks BEFORE the claim ─────────────────────────────────────────────
  // With no webhook or no audience there's nothing to send — leave the cycle's
  // marker unclaimed so wiring the webhook up later can still celebrate a week
  // that completes afterwards.
  const webhook = await resolveCycleCompleteWebhook();
  if (!webhook) {
    return NextResponse.json({ fired: false, reason: "not_configured", error: null });
  }
  const recipients = await listAccountingCelebrationRecipients();
  if (recipients.length === 0) {
    return NextResponse.json({ fired: false, reason: "no_recipients", error: null });
  }

  // ── CLAIM BEFORE CONFETTI ───────────────────────────────────────────────────
  // Plain INSERT (never upsert): app_settings.key is unique, so exactly one of
  // any number of simultaneous 100% reports wins the right to send.
  const completedAt = new Date().toISOString();
  const actor = await getSessionActor();
  const claim = {
    key: claimKeyFor(sourceFile),
    value: JSON.stringify({
      at: completedAt,
      by: actor.user_name,
      trigger,
      paid_count: paidCount,
      total_count: totalCount,
      unpaid_count: cleanNum(body.unpaid_count) ?? 0,
      notified: recipients.length,
    }),
    updated_at: completedAt,
  };
  const { error: claimErr } = await supabase.from("app_settings").insert(claim);
  if (claimErr) {
    if (claimErr.code === "23505") {
      return NextResponse.json({ fired: false, already: true, error: null });
    }
    return NextResponse.json(
      { fired: false, error: `Could not claim cycle marker: ${claimErr.message}` },
      { status: 500 },
    );
  }

  // Pretty "wrapped up by" credit: display name when we have one, else the
  // email's local part. employee_ids can hold duplicate rows per person (gml
  // dupes), so limit(1) instead of maybeSingle.
  let completedBy: string | null = actor.user_name !== "anonymous" ? actor.user_name : null;
  if (completedBy) {
    try {
      const { data } = await supabase
        .from("employee_ids")
        .select("name")
        .eq("work_email", completedBy)
        .limit(1);
      const nm = ((data?.[0] as { name?: string | null } | undefined)?.name ?? "").trim();
      completedBy = nm || completedBy.split("@")[0];
    } catch {
      completedBy = completedBy.split("@")[0];
    }
  }

  const result = await postCycleCompleteCelebration(
    webhook,
    {
      sourceFile,
      trigger,
      cycleId: cleanStr(body.cycle_id),
      label: cleanStr(body.label, 120),
      periodStart: cleanStr(body.period_start, 40),
      periodEnd: cleanStr(body.period_end, 40),
      completedBy,
      completedAt,
      stats: {
        paid_count: paidCount,
        total_count: totalCount,
        total_paid_usd: cleanNum(body.total_paid_usd),
        total_paid_php: cleanNum(body.total_paid_php),
        unpaid_count: cleanNum(body.unpaid_count) ?? 0,
      },
    },
    recipients,
  );

  if (!result.ok) {
    // Nothing was emailed — release the marker so a later visit can retry.
    // Best-effort: if the release itself fails the cycle stays claimed and the
    // celebration is skipped rather than risking a double-send.
    await supabase.from("app_settings").delete().eq("key", claim.key);
    return NextResponse.json(
      { fired: false, error: result.detail ?? "Webhook delivery failed" },
      { status: 502 },
    );
  }

  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: "payment_cycle.completed",
    resource: "payment_dispatches",
    resource_id: sourceFile,
    details: {
      source_file: sourceFile,
      cycle_id: cleanStr(body.cycle_id),
      trigger,
      paid_count: paidCount,
      total_count: totalCount,
      unpaid_count: cleanNum(body.unpaid_count) ?? 0,
      total_paid_usd: cleanNum(body.total_paid_usd),
      total_paid_php: cleanNum(body.total_paid_php),
      notified: recipients.length,
      webhook_slug: "payment_cycle_complete",
    },
  });

  return NextResponse.json({ fired: true, sent: result.sent, error: null });
}
