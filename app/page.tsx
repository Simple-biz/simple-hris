'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

/**
 * Root `/` lands authenticated users on the Employee view by default. Users who also hold
 * admin/accounting roles switch via the in-app view switcher; the app no longer auto-hops
 * them into the accounting dashboard on every visit.
 *
 * Unauthenticated users never see this — the middleware bounces them to `/login` first.
 */
function RootRedirectInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const qs = searchParams?.toString() ?? '';
    router.replace(qs ? `/employee?${qs}` : '/employee');
  }, [router, searchParams]);

  return (
    <div className="flex h-screen items-center justify-center bg-white dark:bg-[#0d1117]">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-orange-500 border-t-transparent"
        aria-hidden
      />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <RootRedirectInner />
    </Suspense>
  );
}
