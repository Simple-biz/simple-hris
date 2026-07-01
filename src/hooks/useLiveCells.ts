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
 * Messages ride one channel:
 *   • `f` (focus)  — this peer just selected (cid, col). Draw their ring + tag.
 *   • `e` (edit)   — this peer's cell now reads `v` (the FULL current value, so a
 *                    backspace is just a shorter string — the receiver sees the
 *                    text grow/shrink char-by-char). Coalesced to one send per
 *                    animation frame, so a fast typist floods nothing yet each
 *                    frame carries the latest keystroke — effectively instant.
 *   • `b` (blur)   — this peer left the cell. Clear their ring (pending edit is
 *                    flushed first so the final value always lands before it).
 *   • `x` (batch)  — a paste: many cells in one message so a fill-down never
 *                    floods the channel with one message per cell.
 *   • `s` (saved)  — this peer persisted the week; peers resync so a co-edited
 *                    new row can't be inserted twice by a second blind save.
 *
 * Row identity: every message carries the row's `cid` — a shared identity that
 * is the DB id once a row is saved, and a deterministic seed key (or a stable
 * client id) before then. Receivers match by cid (position-independent, so a
 * delete/insert on one client can't misalign another) and fall back to the
 * broadcast index only when no cid matches.
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
  /** Row index as broadcast by the peer (fallback locator when cid misses). */
  row: number;
  /** Shared row identity (DB id when saved, else a deterministic/seed key). */
  cid: string;
  /** Column key the peer is in. */
  col: string;
  /** Last live value the peer typed (null for a focus with no edit yet). */
  value: string | null;
  lastSeen: number;
}

/** One cell in a batch (paste) edit. */
export interface LiveCellValue {
  r: number;
  cid: string;
  c: string;
  v: string;
}

type CellWire =
  | { t: 'f'; e: string; n: string | null; r: number; cid: string; c: string }
  | { t: 'b'; e: string; r: number; cid: string; c: string }
  | { t: 'e'; e: string; n: string | null; r: number; cid: string; c: string; v: string }
  | { t: 'x'; e: string; n: string | null; cells: LiveCellValue[] }
  | { t: 's'; e: string; n: string | null };

// Backstop GC: drop a peer's ring only if their last signal is stale AND they
// are no longer in Realtime presence (a dropped blur/leave, a hard tab kill).
// Presence-leave handles the normal disconnect; this catches the rare miss
// without ever evicting an idle-but-still-present editor.
const PEER_TTL_MS = 45_000;

export interface UseLiveCellsResult {
  peers: LiveCellPeer[];
  sendFocus: (row: number, cid: string, col: string) => void;
  sendBlur: (row: number, cid: string, col: string) => void;
  sendEdit: (row: number, cid: string, col: string, value: string) => void;
  /** Broadcast many cells at once (a paste) in a single message. */
  sendEdits: (cells: LiveCellValue[]) => void;
  /** Announce that this client just saved the week (peers resync). */
  sendSaved: () => void;
}

export function useLiveCells(opts: {
  selfEmail: string | null | undefined;
  selfName: string | null | undefined;
  /** Realtime channel name; make it period-scoped so weeks stay isolated. */
  channel: string;
  enabled?: boolean;
  /** Called when a peer edits a cell, so the grid can merge the value into its
   *  own state (guarded against clobbering the locally-focused cell). */
  onRemoteEdit?: (row: number, cid: string, col: string, value: string, byEmail: string) => void;
  /** Called when a peer announces they saved the week. */
  onSaved?: (byEmail: string, byName: string | null) => void;
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
  const onSavedRef = useRef(opts.onSaved);
  selfRef.current = self;
  nameRef.current = selfName ?? null;
  onEditRef.current = opts.onRemoteEdit;
  onSavedRef.current = opts.onSaved;

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
        setPeer({ email, name: payload.n, color, row: payload.r, cid: payload.cid, col: payload.c, value: null, lastSeen: Date.now() });
      } else if (payload.t === 'e') {
        setPeer({ email, name: payload.n, color, row: payload.r, cid: payload.cid, col: payload.c, value: payload.v, lastSeen: Date.now() });
        onEditRef.current?.(payload.r, payload.cid, payload.c, payload.v, email);
      } else if (payload.t === 'x') {
        for (const cell of payload.cells) {
          onEditRef.current?.(cell.r, cell.cid, cell.c, cell.v, email);
        }
        const last = payload.cells[payload.cells.length - 1];
        if (last) {
          setPeer({ email, name: payload.n, color, row: last.r, cid: last.cid, col: last.c, value: last.v, lastSeen: Date.now() });
        }
      } else if (payload.t === 's') {
        onSavedRef.current?.(email, payload.n);
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
      // Flush any queued edit before dropping the channel (mirrors sendBlur), so a
      // last keystroke isn't lost on unmount / week switch when no blur fired.
      if (rafRef.current != null && typeof window !== 'undefined') {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      flush();
      void supabase.removeChannel(ch);
      chRef.current = null;
    };
  }, [enabled, self, channel, flush]);

  // Backstop GC: only evict a stale peer that is ALSO gone from presence, so an
  // idle-but-still-present focused editor keeps their ring/tag.
  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - PEER_TTL_MS;
      const ch = chRef.current;
      const present = ch
        ? new Set(
            Object.keys(ch.presenceState()).map(
              (k) => normEmail(k) ?? k.trim().toLowerCase(),
            ),
          )
        : null;
      setPeers((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [email, p] of prev) {
          if (p.lastSeen < cutoff && !present?.has(email)) {
            next.delete(email);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const sendFocus = useCallback((row: number, cid: string, col: string) => {
    const s = selfRef.current;
    if (!s) return;
    rawSend({ t: 'f', e: s, n: nameRef.current, r: row, cid, c: col });
  }, [rawSend]);

  const sendBlur = useCallback((row: number, cid: string, col: string) => {
    const s = selfRef.current;
    if (!s) return;
    // Land the final value before the ring clears: flush any queued edit now.
    if (rafRef.current != null && typeof window !== 'undefined') {
      cancelAnimationFrame(rafRef.current);
      flush();
    }
    rawSend({ t: 'b', e: s, r: row, cid, c: col });
  }, [rawSend, flush]);

  const sendEdit = useCallback((row: number, cid: string, col: string, value: string) => {
    const s = selfRef.current;
    if (!s) return;
    pendingRef.current = { t: 'e', e: s, n: nameRef.current, r: row, cid, c: col, v: value };
    if (rafRef.current == null && typeof window !== 'undefined') {
      rafRef.current = requestAnimationFrame(flush);
    }
  }, [flush]);

  const sendEdits = useCallback((cells: LiveCellValue[]) => {
    const s = selfRef.current;
    if (!s || cells.length === 0) return;
    rawSend({ t: 'x', e: s, n: nameRef.current, cells });
  }, [rawSend]);

  const sendSaved = useCallback(() => {
    const s = selfRef.current;
    if (!s) return;
    rawSend({ t: 's', e: s, n: nameRef.current });
  }, [rawSend]);

  const peerList = useMemo(() => Array.from(peers.values()), [peers]);

  return { peers: peerList, sendFocus, sendBlur, sendEdit, sendEdits, sendSaved };
}
