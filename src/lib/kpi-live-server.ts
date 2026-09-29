import 'server-only';

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import {
  KPI_LIVE_EVENT,
  KPI_LIVE_TOPIC,
  bonusWriteAnnounces,
  type KpiLivePayload,
  type KpiLiveStatus,
} from '@/lib/kpi-live';

/**
 * Server half of the KPI live channel. Both announcers resolve, never reject,
 * and must never fail the write that called them. Routes hand the promise to
 * `after()` (next/server) rather than `void`-ing it: work left dangling after a
 * response can be frozen with the function, and a dropped Lock message is the
 * exact staleness this channel exists to remove. A message that still gets
 * lost costs each surface its own poll.
 */

/** Mark Ready / Lock / reopen — always announced, whatever the status. `null`
 *  = the status row itself was deleted (Bonus History's HSL dept-week delete). */
export async function announceKpiStatusChange(args: {
  department: string;
  periodStart: string;
  status: KpiLiveStatus | null;
}): Promise<void> {
  const payload: KpiLivePayload = {
    kind: 'status',
    department: args.department,
    periodStart: args.periodStart,
    status: args.status,
    ts: Date.now(),
  };
  await broadcastFromServer(KPI_LIVE_TOPIC, KPI_LIVE_EVENT, { ...payload });
}

/**
 * A bonus row was written or deleted. Announced once per dept-week, and only
 * when that week is ready / locked — a draft is invisible to every listener,
 * and the KPI Calculator autosaves drafts on every debounced edit. A failed
 * status read announces anyway: a spurious re-read costs one fetch, a missed
 * one leaves a published figure stale.
 */
export async function announceKpiBonusChange(
  weeks: Array<{ department: string | null | undefined; periodStart: string | null | undefined }>,
): Promise<void> {
  const seen = new Set<string>();
  const unique: Array<{ department: string; periodStart: string }> = [];
  for (const w of weeks) {
    if (!w.department || !w.periodStart) continue;
    const k = `${w.department}|${w.periodStart}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push({ department: w.department, periodStart: w.periodStart });
  }
  if (unique.length === 0) return;

  await Promise.all(
    unique.map(async (w) => {
      let status: string | null = null;
      let readFailed = false;
      try {
        const sb = createSupabaseServiceRoleClient();
        if (!sb) {
          readFailed = true;
        } else {
          const { data, error } = await sb
            .from('hsl_bonus_period_status')
            .select('status')
            .eq('department', w.department)
            .eq('period_start', w.periodStart)
            .maybeSingle();
          if (error) readFailed = true;
          else status = (data as { status?: string } | null)?.status ?? null;
        }
      } catch {
        readFailed = true;
      }
      if (!readFailed && !bonusWriteAnnounces(status)) return;
      const payload: KpiLivePayload = {
        kind: 'bonus',
        department: w.department,
        periodStart: w.periodStart,
        status: status === 'ready' || status === 'locked' ? status : null,
        ts: Date.now(),
      };
      await broadcastFromServer(KPI_LIVE_TOPIC, KPI_LIVE_EVENT, { ...payload });
    }),
  );
}
