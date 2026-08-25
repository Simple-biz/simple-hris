import { NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import {
  fetchDepartmentTransferRows,
  buildHslTransferEffectiveMap,
} from '@/lib/payroll/hsl-transfer-effective';
import { buildTransferLegsByEmail } from '@/lib/payroll/department-transfer-legs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/payroll/hsl-transfers-bulk — the Payroll Wizard's department-transfer
 * feed. ONE paginated read of `department_transfer_requests`, two derived maps:
 *
 * - `effectiveByEmail` — effective dates of transfers INTO HSL
 *   (`{ email: 'YYYY-MM-DD' }`). Day-scopes the HSL Weekend Hours treatment in
 *   a transfer week (`resolveHslWeekScope`), matching the server dispatch
 *   compute (current-pay.ts) exactly.
 * - `legsByEmail` — EVERY applied/approved move a person has
 *   (`{ email: [{ from, to, effective_date }] }`). The wizard narrows this to
 *   the pay week and stages it as the paystub's `department_transfer` block —
 *   the "Lead Gen to HSL" disclosure under the statement's Department line.
 *   Unlike `effectiveByEmail` this keeps non-HSL moves and intra-HSL reshuffles:
 *   arrival-into-HSL is a premium question, disclosure is not.
 *
 * Both come from the same rows, so the wizard can never day-scope one week's
 * premium off a different snapshot than the one it discloses. Same gate as
 * rate-history-bulk: the wizard is a rate-visible surface (admin/accounting/ceo).
 */
export async function GET() {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  try {
    const rows = await fetchDepartmentTransferRows();
    return NextResponse.json({
      effectiveByEmail: Object.fromEntries(buildHslTransferEffectiveMap(rows)),
      legsByEmail: Object.fromEntries(buildTransferLegsByEmail(rows)),
      error: null,
    });
  } catch (e) {
    return NextResponse.json(
      {
        effectiveByEmail: {},
        legsByEmail: {},
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}
