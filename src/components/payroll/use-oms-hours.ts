'use client';

/**
 * Client state for the Orphanage Management System (OMS) tab.
 *
 * Two fetches, deliberately different in weight and trigger:
 *
 *   checkStatus  — `?mode=status`: an approved-row COUNT for the week (+ the newest
 *                  stamp). MANUAL ONLY — the Refresh button (Kane, 2026-09-16: "its not
 *                  a live polling just a manual polling button"). Nothing here runs on
 *                  a timer or on tab open; a pull refreshes the status as a by-product.
 *                  It never returns rows.
 *   load         — `?mode=pull`: the rows. Fires ONLY from the Load Orphanage Hours
 *                  button (Kane, 2026-09-16: "the querying should only load from the
 *                  button request not automatic").
 *
 * The last pull is kept per week: switching to the Paste tab and back does not throw
 * it away, and a new source file resets everything — rows from one week must never
 * be previewed against another.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { OrphanageHourRow } from '@/lib/payroll/orphanage-rows';

/** How long one OMS round trip may take before the button is handed back. */
const OMS_FETCH_TIMEOUT_MS = 15_000;

export type OmsStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'unconfigured'; reason: string }
  | { kind: 'error'; reason: string }
  | { kind: 'empty'; approvedCount: 0; latestUpdatedAt: string | null }
  | { kind: 'ready'; approvedCount: number; latestUpdatedAt: string | null };

export interface OmsPull {
  weekStart: string;
  rows: OrphanageHourRow[];
  approvedCount: number;
  latestUpdatedAt: string | null;
  truncated: boolean;
  pulledAt: number;
}

export interface OmsHoursState {
  status: OmsStatus;
  pull: OmsPull | null;
  pulling: boolean;
  pullError: string | null;
  checkStatus: () => Promise<void>;
  load: () => Promise<void>;
  clearPull: () => void;
}

type StatusJson = {
  configured?: boolean;
  reason?: string;
  error?: string;
  approvedCount?: number;
  latestUpdatedAt?: string | null;
  rows?: OrphanageHourRow[];
  truncated?: boolean;
};

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), OMS_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { cache: 'no-store', signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`OMS did not answer within ${OMS_FETCH_TIMEOUT_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function readJson(res: Response): Promise<StatusJson> {
  const text = await res.text();
  try {
    return JSON.parse(text) as StatusJson;
  } catch {
    // A non-JSON body means the request never reached the handler (proxy, auth
    // redirect, a crashed route). Say that instead of "Unexpected token".
    throw new Error(`OMS route answered ${res.status} without JSON — the request never reached the handler`);
  }
}

export function useOmsHours({ weekStart }: { weekStart: string | null }): OmsHoursState {
  const [status, setStatus] = useState<OmsStatus>({ kind: 'idle' });
  const [pull, setPull] = useState<OmsPull | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  /** Which week the current status/pull belong to — a week change invalidates both. */
  const weekRef = useRef<string | null>(null);
  const statusReq = useRef(0);

  useEffect(() => {
    if (weekRef.current === weekStart) return;
    weekRef.current = weekStart;
    setStatus({ kind: 'idle' });
    setPull(null);
    setPullError(null);
  }, [weekStart]);

  const checkStatus = useCallback(async () => {
    if (!weekStart) return;
    const reqId = ++statusReq.current;
    // Always visibly "checking": a manual refresh must show it did something.
    setStatus({ kind: 'checking' });
    try {
      const res = await fetchWithTimeout(`/api/orphanage-pay/oms?mode=status&week_start=${encodeURIComponent(weekStart)}`);
      const json = await readJson(res);
      if (reqId !== statusReq.current || weekRef.current !== weekStart) return;
      if (res.status === 503 || json.configured === false) {
        setStatus({ kind: 'unconfigured', reason: json.reason ?? 'OMS is not configured' });
        return;
      }
      if (!res.ok) {
        setStatus({ kind: 'error', reason: json.error ?? `HTTP ${res.status}` });
        return;
      }
      const count = Number(json.approvedCount ?? 0);
      setStatus(
        count > 0
          ? { kind: 'ready', approvedCount: count, latestUpdatedAt: json.latestUpdatedAt ?? null }
          : { kind: 'empty', approvedCount: 0, latestUpdatedAt: json.latestUpdatedAt ?? null },
      );
    } catch (e) {
      if (reqId !== statusReq.current) return;
      setStatus({ kind: 'error', reason: e instanceof Error ? e.message : 'OMS is unreachable' });
    }
  }, [weekStart]);

  const load = useCallback(async () => {
    if (!weekStart || pulling) return;
    setPulling(true);
    setPullError(null);
    try {
      const res = await fetchWithTimeout(`/api/orphanage-pay/oms?mode=pull&week_start=${encodeURIComponent(weekStart)}`);
      const json = await readJson(res);
      if (weekRef.current !== weekStart) return;
      if (res.status === 503 || json.configured === false) {
        setStatus({ kind: 'unconfigured', reason: json.reason ?? 'OMS is not configured' });
        setPullError(json.reason ?? 'OMS is not configured');
        return;
      }
      if (!res.ok) {
        const reason = json.error ?? `HTTP ${res.status}`;
        setStatus({ kind: 'error', reason });
        setPullError(reason);
        return;
      }
      const rows = Array.isArray(json.rows) ? json.rows : [];
      const approvedCount = Number(json.approvedCount ?? rows.length);
      setPull({
        weekStart,
        rows,
        approvedCount,
        latestUpdatedAt: json.latestUpdatedAt ?? null,
        truncated: json.truncated === true,
        pulledAt: Date.now(),
      });
      // The pull is the freshest status there is — no second round trip.
      setStatus(
        approvedCount > 0
          ? { kind: 'ready', approvedCount, latestUpdatedAt: json.latestUpdatedAt ?? null }
          : { kind: 'empty', approvedCount: 0, latestUpdatedAt: json.latestUpdatedAt ?? null },
      );
    } catch (e) {
      setPullError(e instanceof Error ? e.message : 'OMS is unreachable');
    } finally {
      setPulling(false);
    }
  }, [weekStart, pulling]);

  const clearPull = useCallback(() => {
    setPull(null);
    setPullError(null);
  }, []);

  return { status, pull, pulling, pullError, checkStatus, load, clearPull };
}
