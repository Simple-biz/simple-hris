import type { ReactNode } from 'react';
import { requirePageRoles } from '@/lib/auth/require-page-roles';

/**
 * Server-side authorization guard for the ENTIRE /admin tree (defense in depth).
 *
 * Layouts wrap every nested route, so this covers /admin, /admin/ and any future
 * /admin/* sub-route. The edge proxy (proxy.ts → evaluateRouteAccess) is the
 * primary gate that blocks non-admins; this re-checks on the server so the admin
 * shell — a client component that fetches roster/role data on mount — can never
 * render for a non-admin even if the proxy matcher is later edited.
 *
 * Unauthenticated users are bounced to /login by the proxy before reaching here;
 * an authenticated non-admin is redirected to their own portal by requirePageRoles.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requirePageRoles(['admin']);
  return <>{children}</>;
}
