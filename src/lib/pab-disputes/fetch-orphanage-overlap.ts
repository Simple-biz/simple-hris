/**
 * Fetch existing orphanage-style disputes (orphanage_visit + ceo_visitation) for the
 * Create-Disputes dialog's calendar. Returns a `Map<email → Map<dispute_date → row>>`
 * so the dialog can show each day's *real* forgiveness status (green/amber/red+disabled)
 * instead of just hours.
 *
 * Browser-only. Hits `/api/pab-disputes/orphanage-overlap` (gated to orphanage_manager
 * or accounting roles). Caller should pre-fetch on mount of OrphanageApp / OrphanageVisits
 * so the dialog opens with this data already in hand.
 */

import { normEmail } from '@/lib/email/norm-email';
import type { PabDayDisputeRow } from '@/lib/supabase/pab-day-disputes';

export type DisputesByEmployee = Map<string, Map<string, PabDayDisputeRow>>;

export async function fetchOrphanageOverlap(opts?: {
  /** Optional ISO YYYY-MM-DD lower bound. */
  from?: string;
  /** Optional ISO YYYY-MM-DD upper bound. */
  to?: string;
  /** AbortSignal for clean unmount cleanup. */
  signal?: AbortSignal;
}): Promise<DisputesByEmployee> {
  const out: DisputesByEmployee = new Map();
  try {
    const params = new URLSearchParams();
    if (opts?.from) params.set('from', opts.from);
    if (opts?.to) params.set('to', opts.to);
    params.set('_', String(Date.now()));
    const res = await fetch(`/api/pab-disputes/orphanage-overlap?${params}`, {
      cache: 'no-store',
      signal: opts?.signal,
    });
    if (!res.ok) return out;
    const json = (await res.json()) as { rows?: PabDayDisputeRow[] };
    const rows = json.rows ?? [];
    for (const row of rows) {
      const em = normEmail(row.work_email);
      if (!em) continue;
      if (!out.has(em)) out.set(em, new Map());
      out.get(em)!.set(row.dispute_date, row);
    }
  } catch {
    // swallow — caller falls back to empty map
  }
  return out;
}
