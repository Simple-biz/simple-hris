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
 *
 * Saves (`orphanage_oms_hours`, the HRIS's own append-only table — NOT money):
 *   save            — POST the current pull + resolution as one snapshot. Manual.
 *   loadLatestSave  — GET the week's newest save. Runs with Refresh, after a Load and
 *                     after a Save — the same manual moments; nothing polls.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { OrphanageHourRow } from '@/lib/payroll/orphanage-rows';
import { omsChangedSincePull } from '@/lib/oms/oms-diff';
import type { OmsSavePayload } from '@/lib/oms/oms-save';
import type { OmsSaveSummary } from '@/lib/supabase/orphanage-oms-hours-db';

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

export type OmsSavesState =
  | { kind: 'unknown' }
  | { kind: 'table_missing'; reason: string }
  | { kind: 'error'; reason: string }
  | { kind: 'ready'; latest: OmsSaveSummary | null };

export interface OmsHoursState {
  status: OmsStatus;
  saves: OmsSavesState;
  saving: boolean;
  saveError: string | null;
  /** The save_id the last successful Save produced this session. */
  lastSaveId: string | null;
  loadLatestSave: () => Promise<void>;
  save: (payload: OmsSavePayload) => Promise<boolean>;
  pull: OmsPull | null;
  /** The pull before `pull`, same week — what a re-load is compared against. */
  previousPull: OmsPull | null;
  /** Refresh saw OMS move since `pull`: count delta and/or a newer stamp. Null = no
   *  pull yet, or nothing moved. Cleared by the next Load. */
  changedSincePull: { countDelta: number; stampMoved: boolean } | null;
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
  const [previousPull, setPreviousPull] = useState<OmsPull | null>(null);
  const [pulling, setPulling] = useState(false);
  const [saves, setSaves] = useState<OmsSavesState>({ kind: 'unknown' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSaveId, setLastSaveId] = useState<string | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  /** Which week the current status/pull belong to — a week change invalidates both. */
  const weekRef = useRef<string | null>(null);
  const statusReq = useRef(0);

  useEffect(() => {
    if (weekRef.current === weekStart) return;
    weekRef.current = weekStart;
    setStatus({ kind: 'idle' });
    setPull(null);
    setPreviousPull(null);
    setPullError(null);
    setSaves({ kind: 'unknown' });
    setSaveError(null);
    setLastSaveId(null);
  }, [weekStart]);

  const loadLatestSave = useCallback(async () => {
    if (!weekStart) return;
    try {
      const res = await fetchWithTimeout(`/api/orphanage-pay/oms/saves?week_start=${encodeURIComponent(weekStart)}`);
      const json = (await readJson(res)) as StatusJson & { tableReady?: boolean; latest?: OmsSaveSummary | null };
      if (weekRef.current !== weekStart) return;
      if (res.status === 503 || json.tableReady === false) {
        setSaves({ kind: 'table_missing', reason: json.reason ?? 'The orphanage_oms_hours table is not applied yet' });
        return;
      }
      if (!res.ok) {
        setSaves({ kind: 'error', reason: json.error ?? `HTTP ${res.status}` });
        return;
      }
      setSaves({ kind: 'ready', latest: json.latest ?? null });
    } catch (e) {
      setSaves({ kind: 'error', reason: e instanceof Error ? e.message : 'Could not read saves' });
    }
  }, [weekStart]);

  const checkStatus = useCallback(async () => {
    if (!weekStart) return;
    const reqId = ++statusReq.current;
    // Always visibly "checking": a manual refresh must show it did something.
    setStatus({ kind: 'checking' });
    void loadLatestSave();
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
  }, [weekStart, loadLatestSave]);

  const load = useCallback(async () => {
    if (!weekStart || pulling) return;
    setPulling(true);
    setPullError(null);
    void loadLatestSave();
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
      const next: OmsPull = {
        weekStart,
        rows,
        approvedCount,
        latestUpdatedAt: json.latestUpdatedAt ?? null,
        truncated: json.truncated === true,
        pulledAt: Date.now(),
      };
      // Keep the pull being replaced so the panel can say WHAT changed.
      setPreviousPull(pull);
      setPull(next);
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
  }, [weekStart, pulling, pull, loadLatestSave]);

  const save = useCallback(async (payload: OmsSavePayload): Promise<boolean> => {
    if (!weekStart || saving) return false;
    setSaving(true);
    setSaveError(null);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), OMS_FETCH_TIMEOUT_MS * 2);
      let res: Response;
      try {
        res = await fetch('/api/orphanage-pay/oms/saves', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(t);
      }
      const json = (await readJson(res)) as StatusJson & { tableReady?: boolean; saveId?: string; saved?: number };
      if (res.status === 503 || json.tableReady === false) {
        const reason = json.reason ?? 'The orphanage_oms_hours table is not applied yet';
        setSaves({ kind: 'table_missing', reason });
        setSaveError(reason);
        return false;
      }
      if (!res.ok) {
        setSaveError(json.error ?? `HTTP ${res.status}`);
        return false;
      }
      setLastSaveId(json.saveId ?? null);
      await loadLatestSave();
      return true;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed');
      return false;
    } finally {
      setSaving(false);
    }
  }, [weekStart, saving, loadLatestSave]);

  const clearPull = useCallback(() => {
    setPull(null);
    setPreviousPull(null);
    setPullError(null);
  }, []);

  // Derived, never stored: a Refresh after a pull compares count + stamp. A Load
  // replaces `pull` with the fresh numbers, so this clears itself.
  const changedSincePull =
    pull && (status.kind === 'ready' || status.kind === 'empty')
      ? omsChangedSincePull(pull, status)
      : null;

  return {
    status, saves, saving, saveError, lastSaveId, loadLatestSave, save,
    pull, previousPull, changedSincePull, pulling, pullError, checkStatus, load, clearPull,
  };
}
