import 'server-only';

/** [TERMINATION-DOCS]
 * This feature's OWN departure-evidence read — the one with an error channel.
 *
 * WHY IT IS NOT `loadOffboardEvidenceByEmail`. That helper is the house's one
 * enumeration of the three off-board sources and it is right for its callers,
 * but every one of its three reads ends in `.catch(() => {})`
 * (offboard-evidence.ts:123, :136, :155) and it returns a BARE `Map` with no
 * error field. A source that timed out is therefore indistinguishable from a
 * source that had nothing — and every consumer treats missing evidence as
 * "still here", which is the safe direction THERE (a leaver lingers a week) and
 * exactly the wrong one HERE (an unreadable source reads as "no departure", or,
 * worse, a partial map hands the ladder a departure it cannot corroborate).
 * Round-2 finding; the shared module is deliberately NOT changed, because its
 * callers depend on the fail-open direction and tightening it would age people
 * off money surfaces.
 *
 * So this module reads the same sources, SCOPED TO ONE WORK EMAIL, and reports
 * failure. A failure BLOCKS generation (`evidence_read_failed`) rather than
 * degrading into silence.
 *
 * WORK EMAIL ONLY (G1). `offboarded_sheet.personal_email` and
 * `offboarding_queue.employee_email` / `employee_personal_email` are all
 * PERSONAL addresses, and one personal inbox backs several master identities —
 * `carla@simple.biz` (active) would inherit `carlath@simple.biz`'s `resigned`
 * stamp through `carlathomas0112@gmail.com` (offboard-evidence.ts:41-48). A
 * personal address SEARCHES (termination-search.ts); it never sources a
 * departure.
 *
 * Every `.ilike` value goes through `escapeLikePattern`: unescaped, `_` is an
 * ILIKE single-character wildcard and `a_b@x.com` matches `axb@x.com`, a
 * DIFFERENT PERSON. Every read is paged: PostgREST truncates at db.max-rows
 * (1000) even with `.range()`.
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { normalizeMasterDate } from '@/lib/roster/master-date';
import { escapeLikePattern } from './reason-key';
import type { TerminationSheetRow } from './termination-arbitration';

type Row = Record<string, unknown>;
type ServiceClient = NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>;

function trimOrNull(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s ? s : null;
}

/** One stamped record, from whichever source held it. `raw` is the cell
 *  verbatim — sanitizing belongs to the arbitration, never to a read. */
export interface TerminationEvidenceEntry {
  offBoardedAtRaw: string | null;
  offBoardedReason: string | null;
}

export interface TerminationDepartureEvidence {
  /** `offboarded_sheet` rows carrying this WORK email. */
  sheetRows: TerminationSheetRow[];
  /** Completed `offboarding_queue` rows carrying this WORK email. */
  queueRows: TerminationSheetRow[];
  /** Non-null when ANY source read failed. The ladder BLOCKS on it. */
  error: string | null;
}

/**
 * The latest stamped record across a set of entries.
 *
 * Pure, and exported so the "latest wins, and the reason rides along with it"
 * rule (offboard-evidence.ts:86-94) is a unit test rather than a claim.
 */
export function latestDepartureRecord(
  entries: TerminationEvidenceEntry[],
): { offDate: string; reason: string | null } | null {
  let best: { offDate: string; reason: string | null } | null = null;
  for (const e of entries) {
    const raw = trimOrNull(e.offBoardedAtRaw);
    if (!raw) continue;
    const day = normalizeMasterDate(raw);
    if (!day) continue;
    if (best && day <= best.offDate) continue;
    best = { offDate: day, reason: trimOrNull(e.offBoardedReason) };
  }
  return best;
}

/**
 * Read `offboarded_sheet` and `offboarding_queue` for one WORK email.
 *
 * The third source — the caller's already-read `global_master_list` stamps — is
 * folded in by the caller through {@link latestDepartureRecord}, so this read
 * runs in PARALLEL with the master read instead of after it. Together the three
 * reproduce what `loadOffboardEvidenceByEmail('work')` would have said, with the
 * failure that helper cannot report.
 */
export async function loadTerminationDepartureEvidence(
  supabase: ServiceClient,
  workEmail: string,
): Promise<TerminationDepartureEvidence> {
  const pat = escapeLikePattern(workEmail);

  const [sheet, queue] = await Promise.all([
    selectAllPaged<Row>((from, to) =>
      supabase
        .from('offboarded_sheet')
        .select('work_email, off_boarded_at, off_boarded_reason')
        .ilike('work_email', pat)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    // `employee_work_email` is the ONLY identity column on this table — the
    // other two hold personal addresses on all 460 completed rows.
    selectAllPaged<Row>((from, to) =>
      supabase
        .from('offboarding_queue')
        .select('employee_work_email, decided_at, reason')
        .eq('status', 'completed')
        .ilike('employee_work_email', pat)
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ]);

  const sheetRows: TerminationSheetRow[] = sheet.rows.map((r) => ({
    offBoardedAtRaw: trimOrNull(r['off_boarded_at']),
    offBoardedReason: trimOrNull(r['off_boarded_reason']),
  }));
  const queueRows: TerminationSheetRow[] = queue.rows.map((r) => ({
    offBoardedAtRaw: trimOrNull(r['decided_at']),
    offBoardedReason: trimOrNull(r['reason']),
  }));

  const errors: string[] = [];
  if (sheet.error) errors.push(`offboarded_sheet: ${sheet.error}`);
  if (queue.error) errors.push(`offboarding_queue: ${queue.error}`);

  return {
    sheetRows,
    queueRows,
    error: errors.length ? errors.join('; ') : null,
  };
}
