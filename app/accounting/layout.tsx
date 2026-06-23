import type { ReactNode } from 'react';
import { requirePageRoles } from '@/lib/auth/require-page-roles';
import { requiredRolesFor } from '@/lib/auth/route-access';

// Server-side authorization guard for the /accounting tree (defense in depth on
// top of the edge proxy). NOTE: the page's own session read is only a prefetch
// optimization — it does not redirect; this layout is the actual server gate.
export default async function AccountingLayout({ children }: { children: ReactNode }) {
  await requirePageRoles(requiredRolesFor('/accounting') ?? ['admin']);
  return <>{children}</>;
}
