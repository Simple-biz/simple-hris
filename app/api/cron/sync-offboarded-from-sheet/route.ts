import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * RETIRED (Kane, 2026-08-07): offboarding no longer depends on the Google
 * Sheet's "Offboarded" tab.
 *
 * This route used to snapshot-REPLACE the `offboarded_sheet` table from that
 * tab and stamp matching `global_master_list` rows. Both made a hand-edited
 * spreadsheet the source of truth over the HRIS's own offboarding flow — and a
 * single typo'd cell (franm@simple.biz, off date entered as 2027-04-20 instead
 * of 2026) rode every offboarded surface for months and was un-fixable in the
 * DB because the next sync copied it right back.
 *
 * The intake had also been dead in practice: the last sync ran 2026-06-09, and
 * every offboard since goes through the HRIS (the offboard route inserts into
 * `offboarded_sheet` itself and stamps the master rows directly).
 *
 * `offboarded_sheet` is now an HRIS-owned ledger:
 *   · written by /api/hr/offboard (and maintained by reonboard / delete flows),
 *   · never bulk-replaced from the spreadsheet.
 * Writes TO the Google Sheet (append-offboarded-sheet, backfill, row deletes)
 * are unaffected — the sheet remains a convenience mirror, not a source.
 *
 * Tombstoned as 410 rather than deleted so a stale scheduler or an old admin
 * button logs an explanation instead of a bare 404.
 */
function retired(): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error:
        'Retired 2026-08-07: offboarding no longer syncs FROM the Google Sheet. ' +
        'The HRIS offboarding flow is the source of truth; offboarded_sheet is written by /api/hr/offboard.',
    },
    { status: 410 },
  );
}

export async function GET() {
  return retired();
}
export async function POST() {
  return retired();
}
