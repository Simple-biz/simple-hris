'use client';

import { SessionProvider } from 'next-auth/react';
import type { ReactNode } from 'react';
import PresenceProvider from '@/components/presence/PresenceProvider';

/**
 * Client wrapper so NextAuth's `useSession()` is available across the app.
 * Kept separate from the server-only root layout because `SessionProvider`
 * pulls in React Context.
 *
 * Also hosts {@link PresenceProvider} so every authenticated client broadcasts
 * online presence app-wide (powers the live status badges on the My Team tab).
 */
export default function NextAuthProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <PresenceProvider>{children}</PresenceProvider>
    </SessionProvider>
  );
}
