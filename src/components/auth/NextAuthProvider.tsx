'use client';

import { SessionProvider } from 'next-auth/react';
import type { Session } from 'next-auth';
import type { ReactNode } from 'react';
import PresenceProvider from '@/components/presence/PresenceProvider';

/**
 * Client wrapper so NextAuth's `useSession()` is available across the app.
 * Kept separate from the server-only root layout because `SessionProvider`
 * pulls in React Context.
 *
 * Accepts `session` pre-fetched from the server layout so `useSession()` has
 * data during SSR instead of throwing "must be wrapped in SessionProvider".
 *
 * Also hosts {@link PresenceProvider} so every authenticated client broadcasts
 * online presence app-wide (powers the live status badges on the My Team tab).
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
      <PresenceProvider>{children}</PresenceProvider>
    </SessionProvider>
  );
}
