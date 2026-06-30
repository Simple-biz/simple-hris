'use client';

import { useSession, signOut } from 'next-auth/react';
import { ShieldAlert, LogOut } from 'lucide-react';

/**
 * Floating "you are impersonating someone" indicator.
 *
 * Shown app-wide (mounted inside {@link NextAuthProvider}) whenever the current
 * session was minted via the super-admin impersonation backdoor — i.e. the JWT
 * carries `impersonated: true` (set in `auth-options.ts`). It makes it
 * unmistakable that the dashboard you're looking at is NOT your own account, and
 * gives a one-click way out (sign out → back to /login).
 *
 * Renders nothing for normal Google-SSO sessions, so it's a no-op for everyone
 * except an admin who is actively impersonating.
 */
export default function ImpersonationBanner() {
  const { data: session } = useSession();
  const user = session?.user as
    | { email?: string | null; impersonated?: boolean }
    | undefined;

  if (!user?.impersonated) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[120] flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-[92vw] items-center gap-3 rounded-full border border-amber-300/70 bg-amber-50/95 px-4 py-2 text-[12px] text-amber-900 shadow-[0_10px_30px_rgba(120,53,15,0.18)] backdrop-blur-md">
        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" />
        <span className="truncate">
          Impersonating{' '}
          <span className="font-semibold">{user.email}</span>
          <span className="hidden sm:inline"> — super-admin session</span>
        </span>
        <button
          type="button"
          onClick={() => void signOut({ callbackUrl: '/login' })}
          className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-600 px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-amber-700"
        >
          <LogOut className="h-3 w-3" />
          Exit
        </button>
      </div>
    </div>
  );
}
