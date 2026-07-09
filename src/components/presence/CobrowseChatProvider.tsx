'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSession } from 'next-auth/react';
import { AnimatePresence } from 'motion/react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { normEmail } from '@/lib/email/norm-email';
import { playPingChime, playPingSent } from '@/lib/sound/ping-chime';
import { useSelfEmail } from '@/components/presence/PresenceProvider';
import CobrowseChatWindow, { type ChatMessageView } from '@/components/collab/CobrowseChatWindow';

/**
 * Two-way live chat that rides alongside the app-wide "watch screen" cobrowse
 * ({@link CobrowseProvider}). When an Admin watches someone's screen from the
 * Global Master List, they get a docked chat window (rendered by CobrowseProvider
 * via {@link useCobrowseChat}); the person being watched gets a matching pop-up
 * window here the instant the admin sends their first message, so they can read
 * along and reply back — a live tutoring back-and-forth.
 *
 * Same trust/delivery model as the Admin "Ping": one shared Realtime broadcast
 * channel, LIVE-ONLY. Nothing is persisted; if the other side isn't connected
 * when a message is sent, it's simply never received. Threads live in memory for
 * the session and are keyed by the OTHER party's normalized email.
 *
 * A message is only ever revealed to the person being watched once the admin
 * actively types — so a pure silent watch stays silent, matching the existing
 * "they aren't notified" contract for the mirror itself.
 */
const CHAT_CHANNEL = 'hris-cobrowse-chat';

interface ChatWire {
  id: string;
  fromEmail: string;
  fromName: string | null;
  toEmail: string;
  text: string;
  ts: number;
}

interface StoredMessage extends ChatMessageView {
  /** Normalized email of the other party this message belongs to. */
  peer: string;
}

interface CobrowseChatApi {
  /** Send a chat message to a peer. Local-echoes into the peer's thread. */
  send: (peer: { email: string; name?: string | null }, text: string) => void;
  /** Ordered messages for a peer's thread (empty if none / null). */
  threadFor: (peerEmail: string | null | undefined) => ChatMessageView[];
  /** Unread count for a peer (cleared via {@link markRead}). */
  unreadFor: (peerEmail: string | null | undefined) => number;
  /** Clear a peer's unread count (call when that thread's window is open). */
  markRead: (peerEmail: string | null | undefined) => void;
  /** Best-known display name for a peer, from their most recent message. */
  nameFor: (peerEmail: string | null | undefined) => string | null;
}

const CobrowseChatContext = createContext<CobrowseChatApi>({
  send: () => {},
  threadFor: () => [],
  unreadFor: () => 0,
  markRead: () => {},
  nameFor: () => null,
});

/** Read/drive the cobrowse tutoring chat (observer side lives in CobrowseProvider). */
export function useCobrowseChat(): CobrowseChatApi {
  return useContext(CobrowseChatContext);
}

const norm = (e: string | null | undefined): string | null =>
  e ? normEmail(e) ?? e.trim().toLowerCase() : null;

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function CobrowseChatProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const selfEmail = useSelfEmail();
  const normSelf = norm(selfEmail);
  const selfName = session?.user?.name ?? null;

  // Threads keyed by the OTHER party's normalized email.
  const [threads, setThreads] = useState<Record<string, StoredMessage[]>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  // Peers whose message popped a driver-side window open (incoming, unsolicited).
  const [driverPeers, setDriverPeers] = useState<string[]>([]);

  // Keep the latest identity in refs so the send/receive closures stay stable.
  const selfRef = useRef({ normSelf, selfName });
  selfRef.current = { normSelf, selfName };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channelRef = useRef<any>(null);
  const readyRef = useRef(false);

  const appendMessage = useCallback((peer: string, msg: StoredMessage) => {
    setThreads((prev) => {
      const list = prev[peer] ? [...prev[peer], msg] : [msg];
      return { ...prev, [peer]: list };
    });
  }, []);

  // ---- Channel: receive half ----
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !normSelf) return;

    const channel = supabase.channel(CHAT_CHANNEL, {
      config: { broadcast: { self: false } },
    });
    channelRef.current = channel;

    channel
      .on('broadcast', { event: 'msg' }, ({ payload }: { payload: ChatWire }) => {
        if (!payload?.text) return;
        const to = norm(payload.toEmail);
        const from = norm(payload.fromEmail);
        if (!to || !from || to !== selfRef.current.normSelf || from === selfRef.current.normSelf) return;

        const fromName = payload.fromName?.trim() || payload.fromEmail;
        appendMessage(from, {
          id: payload.id || newId(),
          peer: from,
          fromSelf: false,
          fromName,
          text: payload.text,
          ts: typeof payload.ts === 'number' ? payload.ts : Date.now(),
        });
        setNames((prev) => (prev[from] === fromName ? prev : { ...prev, [from]: fromName }));
        setUnread((prev) => ({ ...prev, [from]: (prev[from] ?? 0) + 1 }));
        setDriverPeers((prev) => (prev.includes(from) ? prev : [...prev, from]));
        playPingChime();
      })
      .subscribe((status: string) => {
        readyRef.current = status === 'SUBSCRIBED';
      });

    return () => {
      readyRef.current = false;
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [normSelf, appendMessage]);

  // ---- Send half ----
  const send = useCallback(
    (peer: { email: string; name?: string | null }, text: string) => {
      const trimmed = text.trim();
      const to = norm(peer.email);
      const { normSelf: from, selfName: fromName } = selfRef.current;
      if (!trimmed || !to || !from || !channelRef.current || !readyRef.current) return;

      const id = newId();
      const ts = Date.now();
      // Local echo into our own copy of the thread.
      appendMessage(to, {
        id,
        peer: to,
        fromSelf: true,
        fromName: fromName || 'You',
        text: trimmed,
        ts,
      });
      if (peer.name) setNames((prev) => (prev[to] === peer.name ? prev : { ...prev, [to]: peer.name as string }));

      void channelRef.current.send({
        type: 'broadcast',
        event: 'msg',
        payload: { id, fromEmail: from, fromName, toEmail: to, text: trimmed, ts } satisfies ChatWire,
      });
      playPingSent();
    },
    [appendMessage],
  );

  const threadFor = useCallback(
    (peerEmail: string | null | undefined): ChatMessageView[] => {
      const key = norm(peerEmail);
      return key ? threads[key] ?? [] : [];
    },
    [threads],
  );

  const unreadFor = useCallback(
    (peerEmail: string | null | undefined): number => {
      const key = norm(peerEmail);
      return key ? unread[key] ?? 0 : 0;
    },
    [unread],
  );

  const markRead = useCallback((peerEmail: string | null | undefined) => {
    const key = norm(peerEmail);
    if (!key) return;
    setUnread((prev) => (prev[key] ? { ...prev, [key]: 0 } : prev));
  }, []);

  const nameFor = useCallback(
    (peerEmail: string | null | undefined): string | null => {
      const key = norm(peerEmail);
      return key ? names[key] ?? null : null;
    },
    [names],
  );

  const closeDriverPeer = useCallback((peer: string) => {
    setDriverPeers((prev) => prev.filter((p) => p !== peer));
  }, []);

  const value = useMemo<CobrowseChatApi>(
    () => ({ send, threadFor, unreadFor, markRead, nameFor }),
    [send, threadFor, unreadFor, markRead, nameFor],
  );

  return (
    <CobrowseChatContext.Provider value={value}>
      {children}
      {/* Driver side: pop-up windows for whoever is chatting with (helping) us. */}
      <AnimatePresence>
        {driverPeers.map((peer, i) => {
          const peerName = names[peer] ?? peer;
          return (
            <CobrowseChatWindow
              key={peer}
              variant="driver"
              accent="#f97316"
              title={`${peerName}`}
              subtitle="is helping you — reply here"
              messages={threads[peer] ?? []}
              unread={unread[peer] ?? 0}
              offsetIndex={i}
              onOpen={() => markRead(peer)}
              onClose={() => closeDriverPeer(peer)}
              onSend={(text) => send({ email: peer, name: peerName }, text)}
              placeholder={`Reply to ${peerName.split(' ')[0] || 'them'}…`}
            />
          );
        })}
      </AnimatePresence>
    </CobrowseChatContext.Provider>
  );
}
