import { NextRequest, NextResponse } from "next/server";
import { listRecentPaidDispatches } from "@/lib/supabase/payment-dispatches";
import { requireFeatureAccess } from "@/lib/auth/authorize-feature";
import { deniedResponse } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/payment-dispatches/recent-paid[?since=<iso>]
 *
 * The poll behind the lower-left "X paid Y $Z" toast — the fallback for a
 * payment logged by a browser that cannot broadcast it (an older build, a down
 * socket, a write outside this app). Without `since` it returns only the
 * watermark (`latest`, no rows); with it, PAID rows written after that instant,
 * oldest first, bounded by RECENT_PAID_LIMIT with `truncated` set so the client
 * continues at once.
 *
 * GATE = "Accounting VIEW access" (Kane, 2026-09-02): a `view`-or-better grant on
 * the Accounting dashboard's Payment Dispatch tab, on ANY dashboard the person
 * is standing on. Same gate as the other view-level dispatch reads (paystub,
 * arrears, orphanage-dispatches). Admin bypasses; a missing grant is 403, which
 * is also how the client learns it is not authorized — this route is the probe.
 */
export async function GET(req: NextRequest) {
  const authz = await requireFeatureAccess("accounting", "payment_dispatch", "view");
  if (!authz.ok) return deniedResponse(authz);

  const sinceRaw = req.nextUrl.searchParams.get("since");
  let since: string | null = null;
  if (sinceRaw !== null) {
    const t = Date.parse(sinceRaw);
    if (!Number.isFinite(t)) {
      return NextResponse.json(
        { rows: [], latest: null, truncated: false, error: "Invalid since" },
        { status: 400 },
      );
    }
    since = new Date(t).toISOString();
  }

  const result = await listRecentPaidDispatches(since);
  return NextResponse.json(result, { status: result.error ? 500 : 200 });
}
