'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { MessageCircle } from 'lucide-react';
import { normEmail } from '@/lib/email/norm-email';
import { useCobrowse, type CobrowseStatus } from '@/hooks/useCobrowse';
import CobrowseSurface from '@/components/collab/CobrowseSurface';
import CobrowseChatWindow from '@/components/collab/CobrowseChatWindow';
import { useSelfEmail } from '@/components/presence/PresenceProvider';
import { useCobrowseChat } from '@/components/presence/CobrowseChatProvider';

/**
 * App-wide live "watch screen" (screen mirroring), so an Admin can observe ANY
 * signed-in user's screen from the Global Master List — regardless of which
 * dashboard that person is on.
 *
 * The per-dashboard collab layers (Accounting / HR) already run rrweb cobrowse
 * DRIVERS, but only on their own scoped channels (`accounting-cobrowse` /
 * `hr-cobrowse`), so they can only be watched by peers inside that same
 * dashboard. This provider runs ONE additional driver for every authenticated
 * client on a shared channel (`hris-cobrowse`) — recording stays OFF until
 * someone actually watches (the hook only imports rrweb + records on demand), so
 * it's zero-cost when nobody is observing.
 *
 * Only the (admin-gated) Global Master List calls {@link useWatchScreen}.observe,
 * so no non-admin surface ever triggers an observe session; the full-screen
 * mirror is rendered here so it survives the admin navigating between tabs.
 */
const COBROWSE_CHANNEL = 'hris-cobrowse';

export interface WatchTarget {
  email: string;
  name: string;
}

interface WatchScreenApi {
  /** Start (target) or stop (null) mirroring someone's screen. */
  observe: (target: WatchTarget | null) => void;
  /** Normalized email currently being observed, or null. */
  observedEmail: string | null;
  status: CobrowseStatus;
}

const WatchScreenContext = createContext<WatchScreenApi>({
  observe: () => {},
  observedEmail: null,
  status: 'idle',
});

/** Admin-only: control the app-wide "watch screen" session. */
export function useWatchScreen(): WatchScreenApi {
  return useContext(WatchScreenContext);
}

export default function CobrowseProvider({ children }: { children: ReactNode }) {
  const selfEmail = useSelfEmail();
  const [target, setTarget] = useState<WatchTarget | null>(null);
  // Whether the admin's tutoring chat window is docked (true) or minimized to a
  // bubble after they ended it (false). Resets whenever a new watch starts.
  const [chatOpen, setChatOpen] = useState(true);
  const chat = useCobrowseChat();

  const observedEmail = target ? normEmail(target.email) ?? target.email.trim().toLowerCase() : null;

  // Track the current target so stopping/switching can terminate the old chat.
  const targetRef = useRef<WatchTarget | null>(target);
  targetRef.current = target;

  // One shared driver+observer instance. observedEmail stays null (observer half
  // inert) for every user except an admin actively watching someone; the driver
  // half is always live so this client can be mirrored on demand.
  const { setReplayContainer, status } = useCobrowse({
    selfEmail,
    observedEmail,
    channel: COBROWSE_CHANNEL,
  });

  const observe = useCallback(
    (next: WatchTarget | null) => {
      const prev = targetRef.current;
      const prevEmail = prev ? normEmail(prev.email) ?? prev.email.trim().toLowerCase() : null;
      const nextEmail = next ? normEmail(next.email) ?? next.email.trim().toLowerCase() : null;
      // Ending or switching who we watch: terminate the chat with the previous
      // person so their popup doesn't linger on their screen.
      if (prevEmail && prevEmail !== nextEmail) chat.terminate(prevEmail);
      setTarget(next);
      setChatOpen(true);
    },
    [chat],
  );

  const value = useMemo<WatchScreenApi>(
    () => ({ observe, observedEmail, status }),
    [observe, observedEmail, status],
  );

  return (
    <WatchScreenContext.Provider value={value}>
      {children}
      <AnimatePresence>
        {target && (
          <CobrowseSurface
            key={observedEmail}
            driverName={target.name || target.email}
            accent={{ bg: '#f97316', glow: 'rgba(249,115,22,0.55)' }}
            status={status}
            setReplayContainer={setReplayContainer}
            onStop={() => setTarget(null)}
            surfaceLabel="their dashboard"
          />
        )}
      </AnimatePresence>

      {/* Observer side: while watching someone, dock a chat so the admin can
          talk them through it. Their reply pops up on their own screen (driver
          windows are rendered by CobrowseChatProvider). The admin can End the
          chat (× on the window), which closes it on both screens, clears the
          messages, and minimizes to a bubble they can reopen — all without
          stopping the screen mirror. */}
      <AnimatePresence>
        {target && observedEmail && chatOpen && (
          <CobrowseChatWindow
            key={`chat-${observedEmail}`}
            variant="observer"
            accent="#f97316"
            title={`Tutoring ${target.name || target.email}`}
            subtitle="Live chat · they can reply"
            messages={chat.threadFor(observedEmail)}
            unread={chat.unreadFor(observedEmail)}
            onOpen={() => chat.markRead(observedEmail)}
            onClose={() => {
              chat.terminate(observedEmail);
              setChatOpen(false);
            }}
            closeTitle="End chat"
            onSend={(text) => chat.send({ email: target.email, name: target.name }, text)}
            placeholder={`Message ${(target.name || target.email).split(' ')[0] || 'them'}…`}
          />
        )}
      </AnimatePresence>

      {/* Chat ended but still watching: a bubble to start a fresh chat. */}
      <AnimatePresence>
        {target && observedEmail && !chatOpen && (
          <motion.button
            key={`chat-bubble-${observedEmail}`}
            type="button"
            onClick={() => {
              chat.markRead(observedEmail);
              setChatOpen(true);
            }}
            className="rr-block fixed bottom-4 right-4 z-[130] flex h-12 w-12 items-center justify-center rounded-full text-white shadow-2xl"
            style={{ background: '#f97316' }}
            initial={{ opacity: 0, scale: 0.8, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 12 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            title={`Chat with ${target.name || target.email}`}
          >
            <MessageCircle className="h-5 w-5" aria-hidden />
            {chat.unreadFor(observedEmail) > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-white px-1 text-[11px] font-bold text-orange-600">
                {chat.unreadFor(observedEmail) > 9 ? '9+' : chat.unreadFor(observedEmail)}
              </span>
            )}
          </motion.button>
        )}
      </AnimatePresence>
    </WatchScreenContext.Provider>
  );
}
