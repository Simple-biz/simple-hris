import type { ReactNode } from 'react';
import { requirePageRoles } from '@/lib/auth/require-page-roles';
import { requiredRolesFor } from '@/lib/auth/route-access';

// Server-side authorization guard for the /qc tree (QC officer KPI scoring) —
// defense in depth on top of the edge proxy.
export default async function QcLayout({ children }: { children: ReactNode }) {
  await requirePageRoles(requiredRolesFor('/qc') ?? ['qc', 'admin']);
  return <>{children}</>;
}
