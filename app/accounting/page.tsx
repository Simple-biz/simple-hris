import { Suspense } from 'react';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import AppShell from '@/App';
import {
  hasAccountingRole,
  prefetchAccountingData,
  type InitialAccountingData,
} from '@/lib/accounting/prefetch';

function AppShellFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-white dark:bg-[#0d1117]">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-orange-500 border-t-transparent"
        aria-hidden
      />
    </div>
  );
}

export default async function AccountingPage() {
  let initialData: InitialAccountingData | null = null;

  try {
    const session = await getServerSession(authOptions);
    const roles = ((session?.user as { roles?: string[] })?.roles) ?? [];

    if (hasAccountingRole(roles)) {
      initialData = await prefetchAccountingData();
    }
  } catch {
    // Prefetch is best-effort — never block the page
  }

  return (
    <Suspense fallback={<AppShellFallback />}>
      <AppShell initialData={initialData} />
    </Suspense>
  );
}
