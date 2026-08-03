import 'server-only';

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';

/** Per-email verdict against the FULL `global_master_list` table (every row
 *  ever synced, not just the current upload). */
export interface GmlEmailStatus {
  /** True when at least one global_master_list row carrying this email is
   *  NOT offboarded (`off_boarded_at IS NULL`) — active regardless of whether
   *  that row is part of the latest CSV upload. The `active_employees` view
   *  additionally requires a latest-upload match, which internal devs/
   *  founders seeded outside the sheet sync never satisfy (see
   *  app/api/employees/route.ts's getEmployeeMasterRecord fallback comment) —
   *  this check deliberately does NOT apply that extra requirement. */
  active: boolean;
  /** Set only when `active` is false and a stamped row was found. */
  offBoardedAt: string | null;
  offBoardedReason: string | null;
}

const EMAIL_COLUMNS = ['Work Email', 'Personal Email', 'Alternate Work Email', 'Alternate Work Email 2'];

/**
 * Build an email -> GML status map from every row of `global_master_list`.
 * Read via the service-role client — the anon key's RLS on the
 * `active_employees` VIEW returns zero rows (confirmed 2026-08-03; the plain
 * `global_master_list` TABLE is anon-readable, the view isn't), which is why
 * fetchRosterEmailSet()'s old /api/employees-based roster came back nearly
 * empty and false-flagged real, active people as "off GML".
 *
 * A stamped duplicate row must never shadow the same person's active row —
 * if ANY row containing an email is unstamped, that email counts active,
 * full stop (mirrors listRecentlyOffboardedPeople's active-email guard).
 */
export async function fetchGmlStatusMap(): Promise<{
  map: Map<string, GmlEmailStatus>;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { map: new Map(), error: 'Supabase not configured' };

  type Row = Record<string, unknown>;
  const PAGE = 1000;
  const rows: Row[] = [];
  let from = 0;
  // PostgREST caps a single response at db.max-rows (1000 here) — loop until
  // a short page so a master list past 1000 rows doesn't silently truncate.
  while (true) {
    const { data, error } = await supabase
      .from('global_master_list')
      .select(
        '"Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2",off_boarded_at,off_boarded_reason',
      )
      .range(from, from + PAGE - 1);
    if (error) return { map: new Map(), error: error.message };
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }

  const map = new Map<string, GmlEmailStatus>();
  // Pass 1: any unstamped row wins — mark its emails active unconditionally.
  for (const raw of rows) {
    if (raw['off_boarded_at']) continue;
    for (const col of EMAIL_COLUMNS) {
      const em = normEmail(String(raw[col] ?? ''));
      if (em) map.set(em, { active: true, offBoardedAt: null, offBoardedReason: null });
    }
  }
  // Pass 2: only for emails NOT already active, record the newest stamp.
  for (const raw of rows) {
    const offAt = raw['off_boarded_at'] ? String(raw['off_boarded_at']) : null;
    if (!offAt) continue;
    const reason = raw['off_boarded_reason'] ? String(raw['off_boarded_reason']) : null;
    for (const col of EMAIL_COLUMNS) {
      const em = normEmail(String(raw[col] ?? ''));
      if (!em) continue;
      const existing = map.get(em);
      if (existing?.active) continue;
      if (!existing || !existing.offBoardedAt || offAt > existing.offBoardedAt) {
        map.set(em, { active: false, offBoardedAt: offAt, offBoardedReason: reason });
      }
    }
  }
  return { map, error: null };
}
