'use client';

import { SessionProvider } from 'next-auth/react';
import type { Session } from 'next-auth';
import type { ReactNode } from 'react';
import PresenceProvider from '@/components/presence/PresenceProvider';
import CobrowseProvider from '@/components/presence/CobrowseProvider';
import SessionInvalidationWatcher from '@/components/auth/SessionInvalidationWatcher';
import GlobalPingListener from '@/components/presence/GlobalPingListener';
import ImpersonationBanner from '@/components/auth/ImpersonationBanner';

/**
 * Client wrapper so NextAuth's `useSession()` is available across the app.
 * Kept separate from the server-only root layout because `SessionProvider`
 * pulls in React Context.
 *
 * Accepts `session` pre-fetched from the server layout so `useSession()` has
 * data during SSR instead of throwing "must be wrapped in SessionProvider".
 *
 * Also hosts {@link PresenceProvider} (app-wide online presence + current
 * dashboard/tab, powering the My Team badges and the Admin Global Master List),
 * {@link GlobalPingListener} (an Admin "Ping" lands as a toast wherever the
 * recipient is), and {@link CobrowseProvider} (an app-wide rrweb "watch screen"
 * driver so an Admin can live-mirror anyone's screen from the Global Master List).
 */
export default function NextAuthProvider({
  children,
  session,
}: {
  children: ReactNode;
  session: Session | null;
}) {
  return (
    <SessionProvider session={session} refetchOnWindowFocus={false}>
      <SessionInvalidationWatcher />
      <GlobalPingListener />
      <ImpersonationBanner />
      <PresenceProvider>
        <CobrowseProvider>{children}</CobrowseProvider>
      </PresenceProvider>
    </SessionProvider>
  );
}
