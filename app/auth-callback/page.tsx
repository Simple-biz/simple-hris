'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export default function AuthCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window !== 'undefined' && window.opener) {
      try {
        window.opener.postMessage({ type: 'oauth_done' }, window.location.origin);
      } catch {}
      window.close();
    } else {
      router.replace('/login');
    }
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-white">
      <div className="flex flex-col items-center gap-2 text-sm text-zinc-500">
        <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
        <span>Completing sign-in…</span>
      </div>
    </main>
  );
}
