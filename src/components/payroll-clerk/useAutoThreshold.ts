'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  autoThresholdCandidates,
  type AutoThresholdFlagged,
  type AutoThresholdResponse,
} from '@/lib/payroll/auto-threshold';
import type { QueueRow } from './mock-queue';

interface Period {
  cycleId: string | null;
  start: string | null;
  end: string | null;
  sourceFile: string | null;
}

export interface AutoThresholdRun {
  /** The week this run settled for. */
  sourceFile: string;
  /** Who THIS run held (empty when there was nobody new, or the viewer can't edit). */
  flagged: AutoThresholdFlagged[];
  warning: string | null;
  /** Bumps on every settle, so the notice can tell a new run from a re-render. */
  seq: number;
}

/**
 * Runs the under-US$15 Threshold rule after Payment Dispatch loads the live week.
 *
 * Fires only on a load that came back from the NETWORK (`freshAt`), never on the
 * cached copy the screen paints first — that copy can carry last hour's amounts.
 * Posts each person at most once per mount: the 15 s poll and every broadcast
 * reload would otherwise re-post whoever the server just declined (a cleared
 * hold, a Not Paid attempt), forever. The SERVER is the rule's authority — this
 * hook only proposes candidates; `/api/payment-dispatches/auto-threshold`
 * re-validates every row and decides.
 *
 * After it writes, it awaits `refresh()` so the Threshold count the notice shows
 * already includes the people it just held.
 */
export function useAutoThreshold(args: {
  enabled: boolean;
  freshAt: number | null;
  period: Period;
  pending: readonly QueueRow[];
  refresh: () => Promise<void>;
}): AutoThresholdRun | null {
  const { enabled, freshAt, period, pending, refresh } = args;
  const [run, setRun] = useState<AutoThresholdRun | null>(null);
  const attemptedRef = useRef<Map<string, Set<string>>>(new Map());
  const inFlightRef = useRef(false);
  const seqRef = useRef(0);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const { sourceFile, cycleId, start, end } = period;

  useEffect(() => {
    if (!enabled || freshAt == null || !sourceFile || !cycleId) return;
    if (inFlightRef.current) return;

    const attempted = attemptedRef.current.get(sourceFile) ?? new Set<string>();
    attemptedRef.current.set(sourceFile, attempted);
    const candidates = autoThresholdCandidates(pendingRef.current).filter(
      (c) => !attempted.has(c.recipient_email),
    );
    const settle = (flagged: AutoThresholdFlagged[], warning: string | null) => {
      seqRef.current += 1;
      setRun({ sourceFile, flagged, warning, seq: seqRef.current });
    };
    if (candidates.length === 0) {
      settle([], null);
      return;
    }
    for (const c of candidates) attempted.add(c.recipient_email);

    inFlightRef.current = true;
    void (async () => {
      try {
        const res = await fetch('/api/payment-dispatches/auto-threshold', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cycle_id: cycleId,
            cycle_source_file: sourceFile,
            cycle_period_start: start,
            cycle_period_end: end,
            rows: candidates,
          }),
        });
        // No edit grant: this viewer writes nothing, and says nothing about it.
        if (res.status === 401 || res.status === 403) {
          settle([], null);
          return;
        }
        const json = (await res.json().catch(() => null)) as AutoThresholdResponse | null;
        if (!res.ok || !json || json.error) {
          // Let the next fresh load try these people again.
          for (const c of candidates) attempted.delete(c.recipient_email);
          toast.error(
            `Couldn't auto-flag the under-$15 payees: ${json?.error ?? `HTTP ${res.status}`}. They're still in Pending.`,
          );
          settle([], null);
          return;
        }
        if (json.busy) {
          // Another screen is holding them right now; its broadcast reloads us.
          for (const c of candidates) attempted.delete(c.recipient_email);
          return;
        }
        if (json.flagged.length > 0) await refreshRef.current();
        settle(json.flagged, json.warning ?? null);
      } catch (e) {
        for (const c of candidates) attempted.delete(c.recipient_email);
        toast.error(
          `Couldn't auto-flag the under-$15 payees: ${e instanceof Error ? e.message : String(e)}. They're still in Pending.`,
        );
        settle([], null);
      } finally {
        inFlightRef.current = false;
      }
    })();
    // `freshAt` is the trigger: one pass per network load.
  }, [enabled, freshAt, sourceFile, cycleId, start, end]);

  return run;
}
