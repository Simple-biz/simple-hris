import 'server-only';

/** [TERMINATION-DOCS]
 * The LEDGER identity read: the `offboarded_sheet` rows for one work email, with
 * the cells a facts sheet is built from when NO master row exists (Kane,
 * 2026-09-28).
 *
 * Who needs it: anyone who left before the master list began (its first row is
 * 2026-04-21). Measured 2026-09-23, about 2,532 ledger addresses carry no master
 * row in any of the four email columns, so the ledger row is the only record of
 * the person — name, department, start date, departure.
 *
 * WHY IT IS NOT `./termination-evidence`. That module is the departure-evidence
 * read, and G1 pins that it never touches a personal-email column: a personal
 * address SEARCHES, it never sources a departure. This read DOES select
 * `personal_email` — as data, never as a filter — because the ledger arm needs
 * it to tell two people apart and to ask the in-memory roster map whether that
 * inbox is live (`ledgerOnlySubject`, termination-arbitration.ts). Keeping the
 * two reads apart keeps that guard exactly as strong as it was.
 *
 * It is called ONLY when the master identity read succeeded and returned no
 * row, so a person with a master row pays for no extra query and gains no new
 * failure mode. When it runs, it fails CLOSED: its error blocks the letter
 * (`evidence_read_failed`) rather than reading as "no ledger row".
 *
 * WORK-keyed, escaped, paged — the same three rules as every read in this
 * feature. PostgREST truncates at 1000 rows even with `.range()`.
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { normEmail } from '@/lib/email/norm-email';
import { escapeLikePattern } from './reason-key';
import type { TerminationLedgerRow } from './termination-arbitration';

type Row = Record<string, unknown>;
type ServiceClient = NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>;

/** Verbatim projection. `personal_email` is READ here and never filtered on. */
const LEDGER_SELECT =
  'id, work_email, name, personal_email, department, start_date, off_boarded_at, off_boarded_reason';

function trimOrNull(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s ? s : null;
}

export async function loadTerminationLedgerRows(
  supabase: ServiceClient,
  workEmail: string,
): Promise<{ rows: TerminationLedgerRow[]; error: string | null }> {
  const res = await selectAllPaged<Row>((from, to) =>
    supabase
      .from('offboarded_sheet')
      .select(LEDGER_SELECT)
      .ilike('work_email', escapeLikePattern(workEmail))
      .order('id', { ascending: true })
      .range(from, to),
  );
  return {
    rows: res.rows.map((r) => ({
      id: trimOrNull(r['id']),
      name: trimOrNull(r['name']),
      personalEmail: normEmail(trimOrNull(r['personal_email'])),
      departmentRaw: trimOrNull(r['department']),
      startDateRaw: trimOrNull(r['start_date']),
      offBoardedAtRaw: trimOrNull(r['off_boarded_at']),
      offBoardedReason: trimOrNull(r['off_boarded_reason']),
    })),
    error: res.error ? `offboarded_sheet (ledger identity): ${res.error}` : null,
  };
}
