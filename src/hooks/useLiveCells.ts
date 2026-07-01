'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { normEmail } from '@/lib/email/norm-email';
import { hashEmail } from '@/lib/collab/peer-color';

/**
 * Live, keystroke-level cell co-editing over Supabase Realtime broadcast.
 *
 * A grid mounts this with its OWN channel (period-scoped, so switching weeks
 * starts a clean room and you only ever co-edit within the same dataset). It is
 * deliberately separate from the presence/cursor `CollabLayer` channel so the
 * two concerns never entangle.
 *
 * Three broadcast messages ride one channel:
 *   • `f` (focus)  — this peer just selected (row, col). Draw their ring + tag.
 *   • `e` (edit)   — this peer's cell now reads `v` (the FULL current value, so a
 *                    backspace is just a shorter string — the receiver sees the
 *                    text grow/shrink char-by-char). Coalesced to one send per
 *                    animation frame, so a fast typist floods nothing yet each
 *                    frame carries the latest keystroke — effectively instant.
 *   • `b` (blur)   — this peer left the cell. Clear their ring (pending edit is
 *                    flushed first so the final value always lands before it).
 *
 * Row identity: every message carries BOTH the row's DB `id` (stable across
 * clients once saved — the reliable key) and its current row index (the only
 * handle a brand-new, unsaved row has). Receivers prefer the id and fall back to
 * the index, so co-editing saved rows survives inserts/reorders and new rows
 * still line up on the common path (everyone seeded/loaded the same grid).
 *
 * `broadcast.self=false` means we never hear our own messages, so there is no
 * echo loop; applying a remote edit is a plain state write that fires no input
 * event and thus re-broadcasts nothing.
 */

export interface LiveCellPeer {
  /** Editor's normalized (lowercased) email. */
  email: string;
  /** Display name (falls back to the email local-part at render time). */
  name: string | null;
  /** Identity color hex — matches this person's cursor/avatar in CollabLayer. */
  color: string;
  /** Row index as broadcast by the peer (fallback locator for new rows). */
  row: number;
  /** DB row id when the row is saved (preferred, stable cross-client locator). */
  id: string | null;
  /** Column key the peer is in. */
  col: string;
  /** Last live value the peer typed (null for a focus with no edit yet). */
  value: string | null;
  lastSeen: number;
}

/** One cell in a batch (paste) edit. */
export interface LiveCellValue {
  r: number;
  id: string | null;
  c: string;
  v: string;
}

type CellWire =
  | { t: 'f'; e: string; n: string | null; r: number; id: string | null; c: string }
  | { t: 'b'; e: string; r: number; id: string | null; c: string }
  | { t: 'e'; e: string; n: string | null; r: number; id: string | null; c: string; v: string }
  // Batch edit (a paste): many cells at once in a single message, so a fill-down
  // never floods the channel with one message per cell.
  | { t: 'x'; e: string; n: string | null; cells: LiveCellValue[] };

// Backstop GC: drop a peer's ring if we somehow never got their blur/leave (a
// dropped packet, a hard tab kill before presence sync). Presence-leave handles
// the normal disconnect; this only catches the rare miss.
const PEER_TTL_MS = 45_000;

export interface UseLiveCellsResult {
  peers: LiveCellPeer[];
  sendFocus: (row: number, id: string | null, col: string) => void;
  sendBlur: (row: number, id: string | null, col: string) => void;
  sendEdit: (row: number, id: string | null, col: string, value: string) => void;
  /** Broadcast many cells at once (a paste) in a single message. */
  sendEdits: (cells: LiveCellValue[]) => void;
}

export function useLiveCells(opts: {
  selfEmail: string | null | undefined;
  selfName: string | null | undefined;
  /** Realtime channel name; make it period-scoped so weeks stay isolated. */
  channel: string;
  enabled?: boolean;
  /** Called when a peer edits a cell, so the grid can merge the value into its
   *  own state (guarded against clobbering the locally-focused cell). */
  onRemoteEdit?: (row: number, id: string | null, col: string, value: string, byEmail: string) => void;
}): UseLiveCellsResult {
  const { selfEmail, selfName, channel, enabled = true } = opts;
  const self = useMemo(
    () => (selfEmail ? normEmail(selfEmail) ?? selfEmail.trim().toLowerCase() : null),
    [selfEmail],
  );

  const [peers, setPeers] = useState<Map<string, LiveCellPeer>>(() => new Map());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chRef = useRef<any>(null);
  const selfRef = useRef(self);
  const nameRef = useRef(selfName ?? null);
  const onEditRef = useRef(opts.onRemoteEdit);
  selfRef.current = self;
  nameRef.current = selfName ?? null;
  onEditRef.current = opts.onRemoteEdit;

  // Coalesced edit send: keep only the latest pending edit, flush once per frame.
  const pendingRef = useRef<CellWire | null>(null);
  const rafRef = useRef<number | null>(null);

  const rawSend = useCallback((msg: CellWire) => {
    const ch = chRef.current;
    if (ch) void ch.send({ type: 'broadcast', event: 'cell', payload: msg });
  }, []);

  const flush = useCallback(() => {
    rafRef.current = null;
    const p = pendingRef.current;
    pendingRef.current = null;
    if (p) rawSend(p);
  }, [rawSend]);

  // --- subscribe (once per channel) -----------------------------------------
  useEffect(() => {
    if (!enabled || !self) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    // New channel (e.g. week switch) -> start from an empty roster.
    setPeers(new Map());

    const ch = supabase.channel(channel, {
      config: { broadcast: { self: false }, presence: { key: self } },
    });
    chRef.current = ch;

    const setPeer = (p: LiveCellPeer) =>
      setPeers((prev) => {
        const next = new Map(prev);
        next.set(p.email, p);
        return next;
      });
    const dropPeer = (email: string) =>
      setPeers((prev) => {
        if (!prev.has(email)) return prev;
        const next = new Map(prev);
        next.delete(email);
        return next;
      });

    ch.on('broadcast', { event: 'cell' }, ({ payload }: { payload: CellWire }) => {
      if (!payload?.e) return;
      const email = normEmail(payload.e) ?? payload.e.trim().toLowerCase();
      if (!email || email === self) return;
      const color = hashEmail(email).bg;
      if (payload.t === 'f') {
        setPeer({ email, name: payload.n, color, row: payload.r, id: payload.id, col: payload.c, value: null, lastSeen: Date.now() });
      } else if (payload.t === 'e') {
        setPeer({ email, name: payload.n, color, row: payload.r, id: payload.id, col: payload.c, value: payload.v, lastSeen: Date.now() });
        onEditRef.current?.(payload.r, payload.id, payload.c, payload.v, email);
      } else if (payload.t === 'x') {
        for (const cell of payload.cells) {
          onEditRef.current?.(cell.r, cell.id, cell.c, cell.v, email);
        }
        const last = payload.cells[payload.cells.length - 1];
        if (last) {
          setPeer({ email, name: payload.n, color, row: last.r, id: last.id, col: last.c, value: last.v, lastSeen: Date.now() });
        }
      } else if (payload.t === 'b') {
        dropPeer(email);
      }
    });

    // Presence -> prune anyone who has left the channel (disconnect / tab close /
    // week switch), so a ring can never outlive its editor.
    const prune = () => {
      const state = ch.presenceState();
      const present = new Set(
        Object.keys(state).map((k) => normEmail(k) ?? k.trim().toLowerCase()),
      );
      setPeers((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const email of prev.keys()) {
          if (!present.has(email)) {
            next.delete(email);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    ch.on('presence', { event: 'sync' }, prune)
      .on('presence', { event: 'leave' }, prune)
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') void ch.track({ email: self });
      });

    return () => {
      if (rafRef.current != null && typeof window !== 'undefined') {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pendingRef.current = null;
      void supabase.removeChannel(ch);
      chRef.current = null;
    };
  }, [enabled, self, channel]);

  // Backstop GC for a missed blur/leave.
  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - PEER_TTL_MS;
      setPeers((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [email, p] of prev) {
          if (p.lastSeen < cutoff) {
            next.delete(email);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const sendFocus = useCallback((row: number, id: string | null, col: string) => {
    const s = selfRef.current;
    if (!s) return;
    rawSend({ t: 'f', e: s, n: nameRef.current, r: row, id, c: col });
  }, [rawSend]);

  const sendBlur = useCallback((row: number, id: string | null, col: string) => {
    const s = selfRef.current;
    if (!s) return;
    // Land the final value before the ring clears: flush any queued edit now.
    if (rafRef.current != null && typeof window !== 'undefined') {
      cancelAnimationFrame(rafRef.current);
      flush();
    }
    rawSend({ t: 'b', e: s, r: row, id, c: col });
  }, [rawSend, flush]);

  const sendEdit = useCallback((row: number, id: string | null, col: string, value: string) => {
    const s = selfRef.current;
    if (!s) return;
    pendingRef.current = { t: 'e', e: s, n: nameRef.current, r: row, id, c: col, v: value };
    if (rafRef.current == null && typeof window !== 'undefined') {
      rafRef.current = requestAnimationFrame(flush);
    }
  }, [flush]);

  const sendEdits = useCallback((cells: LiveCellValue[]) => {
    const s = selfRef.current;
    if (!s || cells.length === 0) return;
    rawSend({ t: 'x', e: s, n: nameRef.current, cells });
  }, [rawSend]);

  const peerList = useMemo(() => Array.from(peers.values()), [peers]);

  return { peers: peerList, sendFocus, sendBlur, sendEdit, sendEdits };
}
