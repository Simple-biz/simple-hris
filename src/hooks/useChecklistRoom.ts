'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { normEmail } from '@/lib/email/norm-email';
import { hashEmail } from '@/lib/collab/peer-color';

/**
 * Realtime "room" for the New Hire Checklist's modal-only intake model.
 *
 * Unlike the old keystroke-streaming co-editor, nothing here mutates the grid.
 * Every add/edit/delete is an atomic server write; this hook just keeps everyone
 * CONVERGED on that server truth and prevents two people from editing the same
 * hire at once:
 *
 *   • presence  — each client tracks `{ email, name, editingId }`. `editingId`
 *                 is the DB id of the row whose edit modal they currently have
 *                 open (or null). `editingByRowId` lets the grid disable a row's
 *                 Edit button while a peer is in it (a soft lock) and tag it with
 *                 their name.
 *   • broadcast `changed` — after a successful mutation a client calls
 *                 `broadcastChanged()`; peers fire `onChanged` and refetch the
 *                 week, so an added / edited / deleted hire shows up live on
 *                 every screen without any field-level merge guesswork.
 *
 * Channel is period-scoped (pass `hr-nhc-room:<week>`) so switching weeks starts
 * a clean room. Deliberately separate from the presence/cursor CollabLayer.
 */

export interface RoomPeer {
  /** Peer's normalized (lowercased) email. */
  email: string;
  /** Display name (falls back to the email local-part at render time). */
  name: string | null;
  /** Identity color hex — matches this person's cursor/avatar in CollabLayer. */
  color: string;
  /** DB id of the row whose edit modal this peer has open (null = none). */
  editingId: string | null;
}

interface PresenceMeta {
  email?: string;
  name?: string | null;
  editingId?: string | null;
}

export interface UseChecklistRoomResult {
  /** Everyone else currently on this week. */
  peers: RoomPeer[];
  /** rowId -> the peer currently editing that row (for the soft lock). */
  editingByRowId: Map<string, RoomPeer>;
  /** Tell peers the week's data changed (call after a successful mutation). */
  broadcastChanged: () => void;
  /** Announce which row (DB id) this client is editing, or null when done. */
  setEditing: (rowId: string | null) => void;
}

export function useChecklistRoom(opts: {
  selfEmail: string | null | undefined;
  selfName: string | null | undefined;
  /** Realtime channel name; make it period-scoped so weeks stay isolated. */
  channel: string;
  enabled?: boolean;
  /** Fired when a peer announces the week changed — refetch in response. */
  onChanged?: (byEmail: string) => void;
}): UseChecklistRoomResult {
  const { selfEmail, selfName, channel, enabled = true } = opts;
  const self = useMemo(
    () => (selfEmail ? normEmail(selfEmail) ?? selfEmail.trim().toLowerCase() : null),
    [selfEmail],
  );

  const [peers, setPeers] = useState<RoomPeer[]>([]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chRef = useRef<any>(null);
  const selfRef = useRef(self);
  const nameRef = useRef(selfName ?? null);
  const editingRef = useRef<string | null>(null);
  const onChangedRef = useRef(opts.onChanged);
  selfRef.current = self;
  nameRef.current = selfName ?? null;
  onChangedRef.current = opts.onChanged;

  // Push our current presence (email + name + which row we're editing).
  const track = useCallback(() => {
    const ch = chRef.current;
    const s = selfRef.current;
    if (ch && s) void ch.track({ email: s, name: nameRef.current, editingId: editingRef.current });
  }, []);

  useEffect(() => {
    if (!enabled || !self) {
      setPeers([]);
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    setPeers([]); // new channel (e.g. week switch) -> empty roster

    const ch = supabase.channel(channel, {
      config: { presence: { key: self }, broadcast: { self: false } },
    });
    chRef.current = ch;

    const sync = () => {
      const state = ch.presenceState() as Record<string, PresenceMeta[]>;
      const out: RoomPeer[] = [];
      for (const key of Object.keys(state)) {
        const metas = state[key];
        const meta = metas && metas.length > 0 ? metas[metas.length - 1] : undefined;
        const raw = meta?.email ?? key;
        const email = normEmail(raw) ?? raw.trim().toLowerCase();
        if (!email || email === self) continue;
        out.push({
          email,
          name: meta?.name ?? null,
          color: hashEmail(email).bg,
          editingId: meta?.editingId ?? null,
        });
      }
      setPeers(out);
    };

    ch.on('presence', { event: 'sync' }, sync)
      .on('presence', { event: 'join' }, sync)
      .on('presence', { event: 'leave' }, sync)
      .on('broadcast', { event: 'changed' }, ({ payload }: { payload: { e?: string } }) => {
        const raw = payload?.e;
        if (!raw) return;
        const by = normEmail(raw) ?? raw.trim().toLowerCase();
        if (by && by !== self) onChangedRef.current?.(by);
      })
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') track();
      });

    return () => {
      void supabase.removeChannel(ch);
      chRef.current = null;
    };
  }, [enabled, self, channel, track]);

  const broadcastChanged = useCallback(() => {
    const ch = chRef.current;
    const s = selfRef.current;
    if (ch && s) void ch.send({ type: 'broadcast', event: 'changed', payload: { e: s } });
  }, []);

  const setEditing = useCallback(
    (rowId: string | null) => {
      editingRef.current = rowId;
      track();
    },
    [track],
  );

  const editingByRowId = useMemo(() => {
    const m = new Map<string, RoomPeer>();
    for (const p of peers) if (p.editingId) m.set(p.editingId, p);
    return m;
  }, [peers]);

  return { peers, editingByRowId, broadcastChanged, setEditing };
}
