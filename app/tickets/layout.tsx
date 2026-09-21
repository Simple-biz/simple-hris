import type { ReactNode } from 'react';
import { requirePageRoles } from '@/lib/auth/require-page-roles';
import { requiredRolesFor } from '@/lib/auth/route-access';

// Server-side authorization guard for /tickets — defense in depth on top of the
// edge proxy. The route now hosts two unrelated surfaces: the HRIS-updates
// Kanban board (`tickets` role) and Employee Support's live chat
// (`employee_support` role, Kane's Q3, 2026-09-19). Holding EITHER role (or
// admin) opens the route; neither one opens the other's surface.
//
// This layer answers "may you load this page", nothing more. Inside:
//   - the board's create/drag vs read-only still comes from the per-user
//     `tickets` feature grant (see /api/tickets), unchanged;
//   - which rail a holder sees is `ticketsHostAccess()`
//     (src/lib/rbac/view-tabs.ts), which gives a support-only holder no Overview
//     / Board / Archived at all.
//
// The fallback list mirrors ROUTE_REQUIRED_ROLES so the two can't drift apart
// silently; route-access.ts is the source of truth.
export default async function TicketsLayout({ children }: { children: ReactNode }) {
  await requirePageRoles(requiredRolesFor('/tickets') ?? ['tickets', 'employee_support', 'admin']);
  return <>{children}</>;
}
