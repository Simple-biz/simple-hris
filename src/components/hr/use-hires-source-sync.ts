'use client';

/**
 * Client side of the New Hire Checklist's hiring-database sync
 * (docs/features/new-hire-source-sync.md).
 *
 * Kane, 2026-10-08: "I want this in Real Time". So, unlike the OMS tab (which
 * Kane ruled manual-only for OMS), this one POLLS while the checklist is open:
 *
 *   • on mount, then every SYNC_INTERVAL_MS while the page is VISIBLE, and at once
 *     when a hidden page becomes visible again past the interval;
 *   • "Sync now" runs one immediately.
 *
 * Single-flight: a tick that lands while a sync is out is dropped, never queued.
 * A sync that changed the checklist reports `touchedWeeks`; the grid refetches the
 * week it shows when that week is in the list (the server ALSO broadcasts `changed`
 * to each touched week's room, which is how every OTHER open grid hears of it).
 *
 * A session without edit rights gets 403 on the sync: it stops syncing and only
 * reads the status (GET) on the same timer — it still sees the held list, and the
 * room broadcast still refreshes its grid when an editor's poll places a hire.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { HeldHire } from '@/lib/hr/hires-source-map';

/** The HR tab cache's freshness window — the same 30 s the rest of HR uses. */
export const SYNC_INTERVAL_MS = 30_000;
/** The client stops WAITING after this; the server pass carries on regardless. */
const SYNC_TIMEOUT_MS = 45_000;

export type HiresSyncStatus =
  | { kind: 'starting' }
  | { kind: 'not_configured'; reason: string; missing: string[] }
  | { kind: 'not_ready'; reason: string }
  | { kind: 'source_error'; reason: string }
  | { kind: 'error'; reason: string }
  | { kind: 'live' }
  /** No edit rights: this session reads the status but never runs a sync. */
  | { kind: 'view_only' };

export type HiresSyncLast = {
  at: number;
  pulled: number;
  placed: number;
  linked: number;
  updatedCells: number;
  truncated: boolean;
  skippedNoId: number;
  errors: string[];
};

export interface HiresSourceSyncState {
  status: HiresSyncStatus;
  syncing: boolean;
  last: HiresSyncLast | null;
  held: HeldHire[];
  placing: string | null;
  syncNow: () => void;
  placeHeld: (sourceKey: string, period: string) => Promise<{ ok: boolean; error?: string }>;
}

type SyncBody = {
  status?: string;
  reason?: string;
  missing?: string[];
  summary?: {
    pulled: number;
    placed: number;
    linked: number;
    updatedCells: number;
    touchedWeeks: string[];
    truncated: boolean;
    skippedNoId: number;
    errors: string[];
  };
  held?: HeldHire[];
  error?: string;
};

type StatusBody = {
  configured?: boolean;
  configReason?: string | null;
  missing?: string[];
  tableReady?: boolean;
  tableReason?: string | null;
  held?: HeldHire[];
  error?: string;
};

export function useHiresSourceSync(opts: {
  enabled: boolean;
  /** A sync changed these weeks (and it is safe to refetch now). */
  onWeeksChanged: (weeks: string[]) => void;
}): HiresSourceSyncState {
  const [status, setStatus] = useState<HiresSyncStatus>({ kind: 'starting' });
  const [syncing, setSyncing] = useState(false);
  const [last, setLast] = useState<HiresSyncLast | null>(null);
  const [held, setHeld] = useState<HeldHire[]>([]);
  const [placing, setPlacing] = useState<string | null>(null);

  const inFlight = useRef(false);
  const lastRunAt = useRef(0);
  const viewOnly = useRef(false);
  const mounted = useRef(true);
  const onWeeksChangedRef = useRef(opts.onWeeksChanged);
  onWeeksChangedRef.current = opts.onWeeksChanged;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** View-only sessions: read the status + held list, never write. */
  const readStatus = useCallback(async (signal: AbortSignal) => {
    const res = await fetch('/api/hr/new-hire-checklist/source-sync', { cache: 'no-store', signal });
    const body = (await res.json().catch(() => ({}))) as StatusBody;
    if (!mounted.current) return;
    if (!res.ok) {
      setStatus({ kind: 'error', reason: body.error || `Status failed (${res.status})` });
      return;
    }
    if (!body.configured) {
      setStatus({ kind: 'not_configured', reason: body.configReason ?? 'Not set up', missing: body.missing ?? [] });
    } else if (!body.tableReady) {
      setStatus({ kind: 'not_ready', reason: body.tableReason ?? 'Not applied yet' });
    } else {
      setStatus({ kind: 'view_only' });
    }
    setHeld(body.held ?? []);
  }, []);

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    lastRunAt.current = Date.now();
    setSyncing(true);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SYNC_TIMEOUT_MS);
    try {
      if (viewOnly.current) {
        await readStatus(ctl.signal);
        return;
      }
      const res = await fetch('/api/hr/new-hire-checklist/source-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync' }),
        cache: 'no-store',
        signal: ctl.signal,
      });
      if (res.status === 401 || res.status === 403) {
        viewOnly.current = true;
        await readStatus(ctl.signal);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as SyncBody;
      if (!mounted.current) return;
      if (body.held) setHeld(body.held);
      const reason = body.reason || body.error || `Sync failed (${res.status})`;
      if (body.status === 'not_configured') setStatus({ kind: 'not_configured', reason, missing: body.missing ?? [] });
      else if (body.status === 'not_ready') setStatus({ kind: 'not_ready', reason });
      else if (body.status === 'source_error') setStatus({ kind: 'source_error', reason });
      else if (body.status === 'ok' && body.summary) {
        const s = body.summary;
        setStatus({ kind: 'live' });
        setLast({
          at: Date.now(),
          pulled: s.pulled,
          placed: s.placed,
          linked: s.linked,
          updatedCells: s.updatedCells,
          truncated: s.truncated,
          skippedNoId: s.skippedNoId,
          errors: s.errors,
        });
        if (s.touchedWeeks.length > 0) onWeeksChangedRef.current(s.touchedWeeks);
      } else {
        setStatus({ kind: 'error', reason });
      }
    } catch (e) {
      if (!mounted.current) return;
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      setStatus({
        kind: 'error',
        reason: aborted ? 'The sync took longer than 45 s — it will try again.' : e instanceof Error ? e.message : 'Sync failed',
      });
    } finally {
      clearTimeout(timer);
      inFlight.current = false;
      if (mounted.current) setSyncing(false);
    }
  }, [readStatus]);

  // Mount + interval + visibility. Never stacks: `run` is single-flight.
  useEffect(() => {
    if (!opts.enabled) return;
    void run();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void run();
    }, SYNC_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRunAt.current >= SYNC_INTERVAL_MS) void run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [opts.enabled, run]);

  const syncNow = useCallback(() => {
    void run();
  }, [run]);

  const placeHeld = useCallback(async (sourceKey: string, period: string) => {
    setPlacing(sourceKey);
    try {
      const res = await fetch('/api/hr/new-hire-checklist/source-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'place', source_key: sourceKey, period_start: period }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; held?: HeldHire[] };
      if (!res.ok) return { ok: false, error: body.error || `Add failed (${res.status})` };
      if (mounted.current && body.held) setHeld(body.held);
      onWeeksChangedRef.current([period]);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Add failed' };
    } finally {
      if (mounted.current) setPlacing(null);
    }
  }, []);

  return { status, syncing, last, held, placing, syncNow, placeHeld };
}
