import type { ReactNode } from 'react';
import { requirePageRoles } from '@/lib/auth/require-page-roles';
import { requiredRolesFor } from '@/lib/auth/route-access';

// Server-side authorization guard for the /manager tree (defense in depth on top
// of the edge proxy). Department managers hold the `manager` role (granted with
// the dashboard), so this does not lock them out.
export default async function ManagerLayout({ children }: { children: ReactNode }) {
  await requirePageRoles(requiredRolesFor('/manager') ?? ['admin']);
  return <>{children}</>;
}
