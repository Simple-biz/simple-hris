import { NextResponse } from "next/server";
import { getPayrollDispatchLock } from "@/lib/supabase/payroll-dispatch-lock";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Public, read-only payroll-lock probe for the external /update-bank-info page.
 *
 * Lives under /api/bank-update/* on purpose: that's the ONLY api prefix the
 * proxy exposes on the isolated public bank host (every other /api/* there 404s
 * — see proxy.ts), and it needs no session. The richer /api/payroll-dispatch-lock
 * route is behind SSO and unreachable from this page.
 *
 * Returns only whether the dispatch lock is on — never who set it or the full
 * state. When locked, the page greys out the email + "Send code" controls so an
 * employee can't even start the OTP flow. This is advisory UX only; the hard
 * gate is /api/bank-update/save, which still rejects writes with 423 while the
 * lock is on regardless of what this endpoint returned.
 */
export async function GET() {
  const { locked } = await getPayrollDispatchLock();
  return NextResponse.json({ locked });
}
