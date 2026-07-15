import type { ReactNode } from 'react';
import { requirePageRoles } from '@/lib/auth/require-page-roles';
import { requiredRolesFor } from '@/lib/auth/route-access';

// Server-side authorization guard for the /tickets HRIS-updates Kanban board —
// defense in depth on top of the edge proxy. Accounting, HR, managers, the CEO
// and admins can open it; the per-user `tickets` feature grant then decides
// create/drag vs read-only inside (see /api/tickets).
export default async function TicketsLayout({ children }: { children: ReactNode }) {
  await requirePageRoles(
    requiredRolesFor('/tickets') ?? ['accounting', 'hr_coordinator', 'manager', 'ceo', 'admin'],
  );
  return <>{children}</>;
}
