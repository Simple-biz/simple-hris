import type { ReactNode } from 'react';
import { requirePageRoles } from '@/lib/auth/require-page-roles';
import { requiredRolesFor } from '@/lib/auth/route-access';

// Server-side authorization guard for the /hr tree (defense in depth on top of
// the edge proxy). Roles come from the single source of truth, ROUTE_REQUIRED_ROLES.
export default async function HrLayout({ children }: { children: ReactNode }) {
  await requirePageRoles(requiredRolesFor('/hr') ?? ['admin']);
  return <>{children}</>;
}
