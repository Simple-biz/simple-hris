'use client';

/**
 * Client state for "Send to OMS" — the Orphanage step returning the HRIS's figures to
 * the Orphanage Management System. One small state machine the modal renders:
 *
 *   closed → preparing (GET: what a send carries + what OMS already holds)
 *          → ready     (summary, warnings, Send)
 *          → sending   (POST: ONE insert on the server — all rows or none)
 *          → sent | error
 *
 * The loading lives in the MODAL, never in the button (Kane, 2026-09-26: "I want the
 * loading not to be in the button but in a small modal"). Nothing here polls: the GET
 * runs when the modal opens and again after a send, and nowhere else.
 *
 * The tab never sends money. The server rebuilds every row from the saved carriers;
 * the only thing this hook contributes is `aliases` — OMS's own address for a person,
 * taken from the current pull, which relabels a row and never changes it.
 *
 * Doc: docs/features/orphanage-oms-pull.md § Sending to OMS
 */

import { useCallback, useRef, useState } from 'react';

import type { OmsReturnBuild } from '@/lib/oms/oms-return';
import type { OmsReturnSummary } from '@/lib/oms/oms-return-write';

const PREPARE_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 30_000;

export interface OmsReturnInfo {
  configured: boolean;
  tableReady: boolean;
  /** Why sending is not possible right now — the variable, the table, or the grant. */
  reason: string | null;
  preview: OmsReturnBuild & { cycleLocked: boolean; weekStart: string };
  latest: OmsReturnSummary | null;
  latestError: string | null;
}

export interface OmsReturnResult {
  pushId: string;
  pushedAt: string;
  sent: number;
  totalPhp: number;
  cycleLocked: boolean;
}

export type OmsReturnPhase =
  | { kind: 'closed' }
  | { kind: 'preparing' }
  | { kind: 'ready'; info: OmsReturnInfo }
  | { kind: 'sending'; info: OmsReturnInfo; startedAt: number }
  | { kind: 'sent'; info: OmsReturnInfo; result: OmsReturnResult }
  | { kind: 'error'; info: OmsReturnInfo | null; reason: string; during: 'prepare' | 'send' };

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ res: Response; json: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: 'no-store', signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`No answer within ${timeoutMs / 1000}s`);
    throw e;
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  try {
    return { res, json: JSON.parse(text) as Record<string, unknown> };
  } catch {
    // A non-JSON body means the request never reached the handler.
    throw new Error(`The send route answered ${res.status} without JSON — the request never reached the handler`);
  }
}

export interface OmsReturnState {
  phase: OmsReturnPhase;
  open: () => void;
  close: () => void;
  send: (aliases: Record<string, string>) => Promise<void>;
}

export function useOmsReturn({ sourceFile, weekStart }: { sourceFile: string | null; weekStart: string | null }): OmsReturnState {
  const [phase, setPhase] = useState<OmsReturnPhase>({ kind: 'closed' });
  const req = useRef(0);

  const prepare = useCallback(async (): Promise<OmsReturnInfo | null> => {
    if (!sourceFile || !weekStart) return null;
    const id = ++req.current;
    const qs = `source_file=${encodeURIComponent(sourceFile)}&week_start=${encodeURIComponent(weekStart)}`;
    try {
      const { res, json } = await fetchJson(`/api/orphanage-pay/oms/return?${qs}`, {}, PREPARE_TIMEOUT_MS);
      if (id !== req.current) return null;
      if (!res.ok) {
        setPhase({ kind: 'error', info: null, reason: String(json.error ?? `HTTP ${res.status}`), during: 'prepare' });
        return null;
      }
      return json as unknown as OmsReturnInfo;
    } catch (e) {
      if (id !== req.current) return null;
      setPhase({ kind: 'error', info: null, reason: e instanceof Error ? e.message : 'Could not prepare the send', during: 'prepare' });
      return null;
    }
  }, [sourceFile, weekStart]);

  const open = useCallback(() => {
    setPhase({ kind: 'preparing' });
    void prepare().then((info) => {
      if (info) setPhase({ kind: 'ready', info });
    });
  }, [prepare]);

  const close = useCallback(() => {
    req.current += 1;
    setPhase((p) => (p.kind === 'sending' ? p : { kind: 'closed' }));
  }, []);

  const send = useCallback(async (aliases: Record<string, string>) => {
    const current = phase;
    if (current.kind !== 'ready' && !(current.kind === 'error' && current.during === 'send' && current.info)) return;
    const info = current.info!;
    if (!sourceFile || !weekStart) return;
    setPhase({ kind: 'sending', info, startedAt: performance.now() });
    try {
      const { res, json } = await fetchJson(
        '/api/orphanage-pay/oms/return',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_file: sourceFile, week_start: weekStart, aliases }),
        },
        SEND_TIMEOUT_MS,
      );
      if (!res.ok) {
        setPhase({ kind: 'error', info, reason: String(json.error ?? json.reason ?? `HTTP ${res.status}`), during: 'send' });
        return;
      }
      const result = json as unknown as OmsReturnResult;
      // Re-read what OMS now holds so "Last sent" is OMS's answer, not our assumption.
      const fresh = await prepare();
      setPhase({ kind: 'sent', info: fresh ?? info, result });
    } catch (e) {
      // A timeout here is ambiguous — the insert may have landed. Say so.
      const reason = e instanceof Error ? e.message : 'Send failed';
      setPhase({
        kind: 'error',
        info,
        reason: /within/.test(reason)
          ? `${reason}. OMS may or may not have received it — reopen to see OMS's newest copy before sending again.`
          : reason,
        during: 'send',
      });
    }
  }, [phase, sourceFile, weekStart, prepare]);

  return { phase, open, close, send };
}
