import { getEmployeeIds, getEmployeeIdRowByEmail } from "@/lib/supabase/employee-ids";
import { authorizeEmailAccess, deniedResponse } from "@/lib/auth/authorize-email";
import { resolveWalletRailLock } from "@/lib/employee/wallet-rail-lock";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email")?.trim();
  if (email) {
    // employee_ids rows carry payment/bank details, so a per-email lookup is
    // self-or-elevated: a non-elevated caller may only read their own row and
    // the requested ?email= is resolved against the session, never trusted raw.
    const authz = await authorizeEmailAccess(email);
    if (!authz.ok) return deniedResponse(authz);
    const { row, error } = await getEmployeeIdRowByEmail(authz.effectiveEmail);
    // The WIRES lock for THIS person, resolved across all three routing tiers.
    // The Bank Preferred dropdown used to judge it from `bank_preferred` alone
    // and treat NULL as locked, which hid Kolan/HiGlobe from the ~920 payees
    // whose EFFECTIVE rail is already a wallet (tier 1 NULL, tier 2 a wallet) —
    // people who could not see the very rail they are paid on. Tier 1 alone
    // cannot tell "never assigned" from "on wires via the rates sheet";
    // `resolveWalletRailLock` can, and it FAILS CLOSED (a read error is
    // `locked: true` with the error attached). Only ever sent on the ?email=
    // branch: a caller with no payload must read as LOCKED, never as unlocked.
    // The row above is the SAME tier-1 read the resolver would make; hand it over
    // instead of paying for it twice. A failed read is NOT handed over — the
    // resolver must judge it itself (and fail closed), not inherit a null that
    // looks like "no row".
    const walletRail = await resolveWalletRailLock(
      authz.effectiveEmail,
      error ? undefined : { row },
    );
    return NextResponse.json({ rows: row ? [row] : [], error, walletRail });
  }
  const { rows, error } = await getEmployeeIds();
  return NextResponse.json({ rows, error });
}
