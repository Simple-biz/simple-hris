import { Suspense } from 'react';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import AppShell from '@/App';
import DashboardSwitchLoader from '@/components/common/DashboardSwitchLoader';
import {
  hasAccountingRole,
  prefetchAccountingData,
  type InitialAccountingData,
} from '@/lib/accounting/prefetch';

// Server-fetch the accounting seed data BELOW the Suspense boundary so the route
// streams: the skeleton flushes to the browser immediately and the shell fills in
// once the DB read resolves, instead of the whole navigation blocking server-side
// with the previous page frozen. (`getEmployees` alone is several sequential
// Supabase round-trips — see src/lib/accounting/prefetch.ts.)
//
// The /accounting layout is the real auth gate (`requirePageRoles`); the role
// check here only decides whether to prefetch — unauthorized users never reach
// this component.
async function AccountingShell() {
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

  return <AppShell initialData={initialData} />;
}

export default function AccountingPage() {
  return (
    <Suspense fallback={<DashboardSwitchLoader view="accounting" />}>
      <AccountingShell />
    </Suspense>
  );
}
