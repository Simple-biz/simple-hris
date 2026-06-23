import type { ReactNode } from 'react';
import { requirePageRoles } from '@/lib/auth/require-page-roles';
import { requiredRolesFor } from '@/lib/auth/route-access';

// Server-side authorization guard for the /payroll-clerk tree (money-dispatch
// surface) — defense in depth on top of the edge proxy.
export default async function PayrollClerkLayout({ children }: { children: ReactNode }) {
  await requirePageRoles(requiredRolesFor('/payroll-clerk') ?? ['admin']);
  return <>{children}</>;
}
