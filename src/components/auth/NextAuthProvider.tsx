'use client';

import { SessionProvider } from 'next-auth/react';
import type { ReactNode } from 'react';

/**
 * Client wrapper so NextAuth's `useSession()` is available across the app.
 * Kept separate from the server-only root layout because `SessionProvider`
 * pulls in React Context.
 */
export default function NextAuthProvider({ children }: { children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
