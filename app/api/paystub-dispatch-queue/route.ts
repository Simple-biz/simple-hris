import { NextRequest, NextResponse } from "next/server";
import {
  listPaystubDispatchQueue,
  upsertPaystubDispatchQueue,
  type PaystubQueueEntryInput,
} from "@/lib/supabase/paystub-dispatch-queue";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { getSessionActor } from "@/lib/auth/session-actor";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureAccess, requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { loadAddressHolders } from "@/lib/supabase/paystub-address-holders";
import { guardPaystubEntries } from "@/lib/payroll/paystub-delivery-address";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/paystub-dispatch-queue?source_file=<file>
 * Lightweight list (no heavy payload) — drives the dispatch queue's routing of
 * wizard-excluded people into the Excluded tab + the per-row sent/error badges.
 */
export async function GET(req: NextRequest) {
  // View-level gate so the dispatch queue audience (Lenny + accounting) can read
  // it, but it isn't an open list of recipient emails + amounts. The list omits
  // bank creds + the full payload (see LIST_COLUMNS).
  const authz = await requireFeatureAccess("accounting", "payment_dispatch", "view");
  if (!authz.ok) return deniedResponse(authz);

  const sourceFile = req.nextUrl.searchParams.get("source_file")?.trim();
  if (!sourceFile) return NextResponse.json({ rows: [], error: null });
  const { rows, error } = await listPaystubDispatchQueue(sourceFile);
  return NextResponse.json({ rows, error });
}

interface PostBody {
  source_file?: string;
  pay_period?: Record<string, unknown> | null;
  entries?: PaystubQueueEntryInput[];
}

/**
 * POST /api/paystub-dispatch-queue
 * The Payroll Wizard's "Lock in Values & Send to Payment Dispatch" stages every
 * employee's authoritative paystub payload here (payable + excluded). Replaces
 * the prior staged set for that cycle.
 */
export async function POST(req: NextRequest) {
  // Staging is a Payroll Wizard (payroll/admin) write — gated the same way as
  // the wizard's other writes (additions, final-pay snapshot) so any operator
  // who can run the wizard can also lock + send to dispatch. Lenny's
  // `payment_dispatch` grant is a separate, narrower permission.
  const authz = await requireFeatureEdit("accounting", "payroll_wizard");
  if (!authz.ok) return deniedResponse(authz);

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ staged: 0, error: "Invalid JSON body" }, { status: 400 });
  }

  const sourceFile = body.source_file?.trim();
  if (!sourceFile) {
    return NextResponse.json({ staged: 0, error: "Missing source_file" }, { status: 400 });
  }
  const entries = Array.isArray(body.entries) ? body.entries : [];
  const filtered = entries.filter((e) => e && typeof e.recipient_email === "string" && e.recipient_email.trim());

  // A paystub is mailed to a PERSONAL email, and never one a previous holder of
  // this work email left behind (Open item 432, Kane ruled (b) 2026-10-09). The
  // wizard looks the address up BY the work email, so a recycled address used to
  // carry the old holder's inbox. Fail closed: without the holder read we cannot
  // tell, and staging the old address is the exact defect.
  const { holders, error: holdersError } = await loadAddressHolders(filtered.map((e) => e.recipient_email));
  if (!holders) {
    return NextResponse.json(
      { staged: 0, error: `Could not check paystub addresses against previous holders: ${holdersError ?? "unknown error"}` },
      { status: 500 },
    );
  }
  const { entries: valid, outcomes: delivery } = guardPaystubEntries(filtered, holders);

  let lockedBy: string | null = null;
  let lockedByRole = "user";
  try {
    const actor = await getSessionActor();
    lockedBy = actor.user_name !== "anonymous" ? actor.user_name : null;
    lockedByRole = actor.user_role;
  } catch {
    /* best-effort audit */
  }

  const { staged, error } = await upsertPaystubDispatchQueue({
    sourceFile,
    payPeriod: body.pay_period ?? null,
    lockedBy,
    entries: valid,
  });

  if (error) {
    return NextResponse.json({ staged: 0, error }, { status: 500 });
  }

  const excludedEmails = valid.filter((e) => e.excluded).map((e) => e.recipient_email);
  void insertAuditLog({
    user_name: lockedBy ?? "unknown",
    user_role: lockedByRole,
    action: "paystubs.staged",
    resource: "paystub_dispatch_queue",
    resource_id: null,
    details: {
      source_file: sourceFile,
      staged,
      payable: staged - excludedEmails.length,
      excluded: excludedEmails.length,
      // The "do not pay" set this lock recorded — the durable audit of who was
      // excluded each cycle (capped to keep the log row bounded).
      excluded_emails: excludedEmails.slice(0, 200),
      // Work emails whose staged address was a previous holder's (432). Work
      // emails and the verdict only; no personal address enters the log.
      delivery_address_guard: delivery.length > 0 ? delivery.slice(0, 200) : undefined,
    },
  });

  const replaced = delivery.filter((d) => d.kind === "replace").map((d) => d.recipient_email);
  const withheld = delivery.filter((d) => d.kind === "withhold").map((d) => d.recipient_email);
  return NextResponse.json({
    staged,
    excluded: excludedEmails.length,
    delivery: { replaced, withheld },
    error: null,
  });
}
