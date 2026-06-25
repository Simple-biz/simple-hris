import { NextRequest, NextResponse } from "next/server";
import { deletePaymentDispatches } from "@/lib/supabase/payment-dispatches";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { getSessionActor } from "@/lib/auth/session-actor";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { pulsePaymentsLive } from "@/lib/supabase/app-settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Body {
  ids?: unknown;
}

/**
 * "Send back to the pay processor" — undo one or more logged payments by
 * deleting their payment_dispatches rows. The recipient drops out of paid and
 * reappears in the pending queue; the disbursement_records sync trigger flips
 * the matching record back to pending.
 */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('accounting', 'payment_dispatch');
  if (!authz.ok) return deniedResponse(authz);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ deleted: 0, error: "Invalid JSON body" }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ deleted: 0, error: "No dispatch ids provided" }, { status: 400 });
  }

  let actor: string | null = null;
  let actorRole = "user";
  try {
    const sessionActor = await getSessionActor();
    actor = sessionActor.user_name !== "anonymous" ? sessionActor.user_name : null;
    actorRole = sessionActor.user_role;
  } catch {
    /* ignore - audit trail is best-effort */
  }

  let deleted = 0;
  try {
    const result = await deletePaymentDispatches(ids);
    if (result.error) {
      console.error("[payment-dispatches/undo] delete returned error", result.error);
      return NextResponse.json({ deleted: result.deleted, error: result.error }, { status: 500 });
    }
    deleted = result.deleted;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[payment-dispatches/undo] unexpected error", e);
    return NextResponse.json({ deleted: 0, error: msg }, { status: 500 });
  }

  void insertAuditLog({
    user_name: actor ?? "unknown",
    user_role: actorRole,
    action: "payment.undone",
    resource: "payment_dispatches",
    resource_id: ids.join(","),
    details: { count: deleted, ids },
  });

  // Nudge the CEO live "payments to send" counter to refetch (count goes back up).
  void pulsePaymentsLive();

  return NextResponse.json({ deleted, error: null });
}
