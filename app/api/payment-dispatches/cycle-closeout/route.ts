import { NextRequest, NextResponse } from "next/server";
import {
  requireFeatureEdit,
  requireRateVisibilityOrFeatureEdit,
} from "@/lib/auth/authorize-feature";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { getSessionActor } from "@/lib/auth/session-actor";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth/auth-options";
import { CYCLE_REOPEN_ROLES, canReopenCycle } from "@/lib/payroll/cycle-closeout";
import {
  closeCycle,
  getCycleCloseout,
  listCycleCloseouts,
  reopenCycle,
} from "@/lib/payroll/cycle-closeout-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Cycle close-out — Accounting declaring a pay week finished from Payment
 * Dispatch, INCLUDING when payable people were never paid.
 *
 * Historical note: until 2026-08-12 a separate published pay-cycle report
 * existed (`/api/accounting/pay-cycle-reports`) that refused any cycle with
 * money still owed; this route was deliberately NOT that. Both report tabs
 * are gone now — the close-out is the ONLY per-cycle record, and it is still
 * allowed to record failure. See `src/lib/payroll/cycle-closeout.ts`.
 *
 * GET    — every close-out (summaries; unpaid rows omitted) — the Stop dialog's
 *          "already closed" state; `?source_file=` returns one full record.
 * POST   — close one cycle. Plain INSERT, so the first close of a week wins and a
 *          double-click reports `already` instead of overwriting the record.
 * DELETE — reopen one cycle (2026-08-14). Archives the filed record, frees the
 *          live key, and permanently suppresses the celebration email. Narrower
 *          than POST: `CYCLE_REOPEN_ROLES` only.
 */

interface PostBody {
  source_file?: unknown;
  cycle_id?: unknown;
  label?: unknown;
  period_start?: unknown;
  period_end?: unknown;
  unpaid?: unknown;
}

function cleanStr(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export async function GET(req: NextRequest) {
  // Same gate as the other dispatch-queue reads: whoever can see the queue can
  // see whether its week was declared closed.
  const authz = await requireRateVisibilityOrFeatureEdit("accounting", "payment_dispatch");
  if (!authz.ok) return deniedResponse(authz);

  // `?source_file=` returns ONE close-out in full, unpaid rows included — the
  // report detail view needs the names. The bare list omits them so badging a
  // page of cards doesn't drag every payee across the wire.
  const sourceFile = cleanStr(req.nextUrl.searchParams.get("source_file"), 300);
  if (sourceFile) {
    const { closeout, error } = await getCycleCloseout(sourceFile);
    return NextResponse.json({ closeout, error });
  }

  const { closeouts, unreadable, error } = await listCycleCloseouts();
  return NextResponse.json({ closeouts, unreadable, error });
}

export async function POST(req: NextRequest) {
  // Closing a cycle WRITES a permanent declaration, so it needs edit — not the
  // read gate the progress strip rides.
  const authz = await requireFeatureEdit("accounting", "payment_dispatch");
  if (!authz.ok) return deniedResponse(authz);

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ closeout: null, error: "Invalid JSON body" }, { status: 400 });
  }

  const sourceFile = cleanStr(body.source_file, 300);
  if (!sourceFile) {
    return NextResponse.json(
      { closeout: null, error: "source_file is required" },
      { status: 400 },
    );
  }

  const actor = await getSessionActor();
  const actorEmail = actor.user_name !== "anonymous" ? actor.user_name : "";

  // Pretty "closed by" credit, same treatment as the cycle-complete route.
  // employee_ids can hold duplicate rows per person, so limit(1) not maybeSingle.
  let closedBy = actorEmail;
  if (closedBy) {
    try {
      const supabase = createSupabaseServiceRoleClient();
      if (supabase) {
        const { data } = await supabase
          .from("employee_ids")
          .select("name")
          .eq("work_email", closedBy)
          .limit(1);
        const nm = ((data?.[0] as { name?: string | null } | undefined)?.name ?? "").trim();
        closedBy = nm || closedBy.split("@")[0];
      }
    } catch {
      closedBy = closedBy.split("@")[0];
    }
  }

  const { closeout, already, error } = await closeCycle({
    sourceFile,
    cycleId: cleanStr(body.cycle_id),
    label: cleanStr(body.label, 120) ?? sourceFile,
    periodStart: cleanStr(body.period_start, 40),
    periodEnd: cleanStr(body.period_end, 40),
    closedBy: closedBy || "—",
    closedByEmail: actorEmail,
    reportedUnpaid: body.unpaid,
  });

  if (error) {
    return NextResponse.json({ closeout, already, error }, { status: 500 });
  }
  if (already) {
    return NextResponse.json({ closeout, already: true, error: null });
  }
  if (!closeout) {
    return NextResponse.json(
      { closeout: null, already: false, error: "Close-out could not be written" },
      { status: 500 },
    );
  }

  // Awaited, not fire-and-forget: this is the audit trail for a declaration that
  // money was left unpaid, and it must not lose the race to the response.
  await insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: "payment_cycle.closed",
    resource: "app_settings",
    resource_id: sourceFile,
    details: {
      source_file: sourceFile,
      cycle_id: closeout.cycle_id,
      label: closeout.label,
      paid_payee_count: closeout.paid.payeeCount,
      paid_usd: closeout.paid.paidUSD,
      paid_php: closeout.paid.paidPHP,
      unpaid_count: closeout.unpaid.count,
      unpaid_truncated: closeout.unpaid.truncated,
      unpaid_dropped: closeout.unpaid.dropped,
      unpaid_php: closeout.unpaid.totalPHP,
      records_outstanding: closeout.records_outstanding,
    },
  });

  return NextResponse.json({ closeout, already: false, error: null });
}

/**
 * DELETE /api/payment-dispatches/cycle-closeout?source_file=…
 *
 * Reopen a closed pay cycle. Deliberately NOT gated like POST: closing is
 * something anyone running payroll may do, unseating a filed declaration is not.
 * Same narrow tier as a destructive delete (`docs/features/delete-authorization.md`),
 * checked from the session's roles exactly like the PAB admin-delete path.
 *
 * The audit entry is AWAITED and carries the whole prior record — after this the
 * live key is gone, so the log plus the archive row are the trail.
 */
export async function DELETE(req: NextRequest) {
  // Feature gate first (must be able to edit Payment Dispatch at all), then the
  // narrower role gate on top of it.
  const authz = await requireFeatureEdit("accounting", "payment_dispatch");
  if (!authz.ok) return deniedResponse(authz);

  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  const roles = user?.roles ?? [];
  if (!canReopenCycle(roles)) {
    return NextResponse.json(
      {
        reopened: false,
        error: `Reopening a closed cycle requires one of: ${CYCLE_REOPEN_ROLES.join(", ")}`,
      },
      { status: 403 },
    );
  }

  const sourceFile = cleanStr(req.nextUrl.searchParams.get("source_file"), 300);
  if (!sourceFile) {
    return NextResponse.json(
      { reopened: false, error: "source_file is required" },
      { status: 400 },
    );
  }

  const actor = await getSessionActor();
  const { reopened, notFound, prior, archiveKey, error } = await reopenCycle({
    sourceFile,
    reopenedByEmail: actor.user_name !== "anonymous" ? actor.user_name : "",
  });

  if (notFound) {
    // Nothing was touched: the week has no close-out, so it is already open.
    return NextResponse.json(
      { reopened: false, notFound: true, error: "This pay cycle has no close-out record." },
      { status: 404 },
    );
  }
  if (error || !reopened) {
    return NextResponse.json(
      { reopened: false, error: error ?? "Could not reopen the pay cycle" },
      { status: 500 },
    );
  }

  await insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: "payment_cycle.reopened",
    resource: "app_settings",
    resource_id: sourceFile,
    details: {
      source_file: sourceFile,
      archive_key: archiveKey,
      celebration_suppressed: true,
      prior_closed_at: prior?.closed_at ?? null,
      prior_closed_by: prior?.closed_by ?? null,
      prior_label: prior?.label ?? null,
      prior_paid_payee_count: prior?.paid.payeeCount ?? null,
      prior_paid_usd: prior?.paid.paidUSD ?? null,
      prior_paid_php: prior?.paid.paidPHP ?? null,
      prior_unpaid_count: prior?.unpaid.count ?? null,
      prior_unpaid_php: prior?.unpaid.totalPHP ?? null,
      /** null when the stored JSON was unreadable — the raw value is archived regardless. */
      prior_record_readable: prior !== null,
    },
  });

  return NextResponse.json({ reopened: true, notFound: false, archiveKey, error: null });
}
