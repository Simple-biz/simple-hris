'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AnimatePresence } from 'motion/react';
import { normEmail } from '@/lib/email/norm-email';
import { useCobrowse, type CobrowseStatus } from '@/hooks/useCobrowse';
import CobrowseSurface from '@/components/collab/CobrowseSurface';
import { useSelfEmail } from '@/components/presence/PresenceProvider';

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

  const observedEmail = target ? normEmail(target.email) ?? target.email.trim().toLowerCase() : null;

  // One shared driver+observer instance. observedEmail stays null (observer half
  // inert) for every user except an admin actively watching someone; the driver
  // half is always live so this client can be mirrored on demand.
  const { setReplayContainer, status } = useCobrowse({
    selfEmail,
    observedEmail,
    channel: COBROWSE_CHANNEL,
  });

  const observe = useCallback((next: WatchTarget | null) => setTarget(next), []);

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
    </WatchScreenContext.Provider>
  );
}
