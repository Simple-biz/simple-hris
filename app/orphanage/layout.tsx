import type { ReactNode } from 'react';
import { requirePageRoles } from '@/lib/auth/require-page-roles';
import { requiredRolesFor } from '@/lib/auth/route-access';

// Server-side authorization guard for the /orphanage tree (defense in depth on
// top of the edge proxy). Roles come from the single source of truth.
export default async function OrphanageLayout({ children }: { children: ReactNode }) {
  await requirePageRoles(requiredRolesFor('/orphanage') ?? ['admin']);
  return <>{children}</>;
}
