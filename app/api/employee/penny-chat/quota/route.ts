import { NextResponse } from 'next/server';
import { authorizeEmailAccess, deniedResponse } from '@/lib/auth/authorize-email';
import { countUsedToday } from '@/lib/penny/employee-usage-db';
import { quotaFromUsed, quotaToWire } from '@/lib/penny/employee-quota';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Seeds the "questions left today" indicator on the employee Penny bubble.
 *
 * The client NEVER counts. It renders the number this route returns (and the one
 * the chat route echoes on `X-Penny-Quota`), so clearing browser storage buys
 * nothing — the meter is a row count in `penny_employee_usage`.
 *
 * Gated exactly like the chat route, so the indicator can't be used to probe
 * whether an arbitrary address exists: a plain employee asking about anyone but
 * themselves gets a 403 here too.
 */
export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get('email');
  const authz = await authorizeEmailAccess(requested);
  if (!authz.ok) return deniedResponse(authz);

  // Q3(a), Kane 2026-08-19: the SESSION holder's allowance is the one metered,
  // and an elevated viewer is exempt — a staff member reading an employee's
  // dashboard must not spend that employee's ten.
  const used = authz.elevated ? 0 : await countUsedToday(authz.sessionEmail);
  const quota = quotaFromUsed(used, { exempt: authz.elevated });

  return NextResponse.json(quotaToWire(quota), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
