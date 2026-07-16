import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { getEmployeesForAuthorizedServerRoute, type EmployeeRow } from '@/lib/supabase/employees';
import type { TicketMember } from './types';

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

const ACCESS_RANK: Record<TicketMember['access'], number> = { view: 0, edit: 1, admin: 2 };

/**
 * Everyone with access to the /tickets board: each active `tickets` feature
 * grant (any view catalog, view or edit) plus every admin (admins bypass
 * feature gates, so they never get a grant row). Enriched with name /
 * department / photo from the master list; two grant emails that resolve to
 * the same master row collapse into one person keeping their most permissive
 * access. Sorted admins → edit → view, then by name.
 *
 * Shared by GET /api/tickets/members (the pickers' source) and by the ticket
 * write routes, which validate `assigned_to` against this same list — so "who
 * can be assigned" has exactly one definition. Throws on a query error.
 */
export async function listTicketMembers(supabase: SupabaseClient): Promise<TicketMember[]> {
  const [{ data: grants, error: grantsErr }, { data: adminRows }, { employees }] =
    await Promise.all([
      supabase
        .from('employee_feature_permissions')
        .select('work_email, access')
        .eq('feature', 'tickets')
        .is('revoked_at', null),
      supabase.from('employee_roles').select('work_email').eq('role', 'admin').is('revoked_at', null),
      getEmployeesForAuthorizedServerRoute(),
    ]);
  if (grantsErr) throw new Error(grantsErr.message);

  // Grant/role rows are keyed on (sometimes alternate) work emails — index the
  // roster by every address so each one resolves to its master row.
  const byEmail = new Map<string, EmployeeRow>();
  for (const e of employees) {
    for (const raw of [e.work_email, e.personal_email, e.alternate_work_email, e.alternate_work_email_2]) {
      const n = norm(raw);
      if (n && !byEmail.has(n)) byEmail.set(n, e);
    }
  }

  // person key (master row when matched, else the bare email) → member.
  const members = new Map<EmployeeRow | string, TicketMember>();
  const upsert = (email: string, access: TicketMember['access']) => {
    const row = byEmail.get(email) ?? null;
    const key = row ?? email;
    const cur = members.get(key);
    if (cur) {
      if (ACCESS_RANK[access] > ACCESS_RANK[cur.access]) cur.access = access;
      return;
    }
    members.set(key, {
      email: norm(row?.work_email) || email,
      name: row?.name?.trim() || null,
      department: row?.department?.trim() || null,
      photo_url: row?.profile_photo_url?.trim() || row?.google_photo_url?.trim() || null,
      access,
    });
  };

  for (const g of (grants ?? []) as Array<{ work_email: string; access: string }>) {
    if (g.access !== 'view' && g.access !== 'edit') continue; // explicit `hidden` rows
    const email = norm(g.work_email);
    if (email) upsert(email, g.access);
  }
  for (const r of (adminRows ?? []) as Array<{ work_email: string }>) {
    const email = norm(r.work_email);
    if (email) upsert(email, 'admin');
  }

  return [...members.values()].sort((a, b) => {
    const rank = ACCESS_RANK[b.access] - ACCESS_RANK[a.access];
    if (rank !== 0) return rank;
    const an = a.name ?? '';
    const bn = b.name ?? '';
    if (!an && bn) return 1;
    if (an && !bn) return -1;
    return an.localeCompare(bn, undefined, { sensitivity: 'base' }) || a.email.localeCompare(b.email);
  });
}
