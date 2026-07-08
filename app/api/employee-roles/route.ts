import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  authorizeEmailAccess,
  deniedResponse,
  requireElevatedSession,
} from '@/lib/auth/authorize-email';
import { bumpForceLogoutFor } from '@/lib/auth/force-logout';
import { expandWorkEmailAliases } from '@/lib/email/work-email-aliases';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VALID_ROLES = [
  'hr_coordinator',
  'accounting',
  'admin',
  'manager',
  'orphanage_manager',
  'contractor',
  'ceo',
  'qc',
] as const;
type Role = (typeof VALID_ROLES)[number];

import { getSessionActor } from '@/lib/auth/session-actor';
import {
  listDepartmentsForManager,
  revokeAllForManager,
} from '@/lib/supabase/department-managers';
import { FEATURE_CATALOG, ROLE_TO_FEATURE_VIEW } from '@/lib/rbac/feature-permissions';

function getClient() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

type Sb = NonNullable<ReturnType<typeof getClient>>;

/**
 * Assigning a dashboard role auto-provisions every tab of that dashboard to
 * `edit`, so a freshly-assigned dashboard is immediately usable. Admins then
 * downgrade a tab to `view` or hide it in the permission grid. Existing active
 * grants are left untouched (so a re-grant never clobbers admin customization);
 * a previously-revoked row is un-revoked, otherwise a fresh row is inserted.
 * No-op for `admin` and any role with no feature catalog.
 */
async function provisionDashboardTabs(sb: Sb, email: string, role: string, actorName: string): Promise<void> {
  const view = ROLE_TO_FEATURE_VIEW[role];
  if (!view) return;
  const features = FEATURE_CATALOG[view] ?? [];
  for (const f of features) {
    const { data: active } = await sb
      .from('employee_feature_permissions')
      .select('id')
      .eq('work_email', email)
      .eq('view_key', view)
      .eq('feature', f.key)
      .is('revoked_at', null)
      .limit(1);
    if (active && active.length > 0) continue;

    const { data: revoked } = await sb
      .from('employee_feature_permissions')
      .select('id')
      .eq('work_email', email)
      .eq('view_key', view)
      .eq('feature', f.key)
      .not('revoked_at', 'is', null)
      .order('granted_at', { ascending: false })
      .limit(1);

    if (revoked && revoked.length > 0) {
      await sb
        .from('employee_feature_permissions')
        .update({ revoked_at: null, access: 'edit', granted_by: actorName, granted_at: new Date().toISOString() })
        .eq('id', (revoked[0] as { id: string }).id);
    } else {
      await sb
        .from('employee_feature_permissions')
        .insert({ work_email: email, view_key: view, feature: f.key, access: 'edit', granted_by: actorName });
    }
  }
}

/** Revoking a dashboard role tears down its per-tab permissions too, so removing
 *  the dashboard fully removes access (and a re-grant re-provisions cleanly). */
async function deprovisionDashboardTabs(sb: Sb, email: string, role: string): Promise<void> {
  const view = ROLE_TO_FEATURE_VIEW[role];
  if (!view) return;
  await sb
    .from('employee_feature_permissions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('work_email', email)
    .eq('view_key', view)
    .is('revoked_at', null);
}

// GET /api/employee-roles            -> all active assignments
// GET /api/employee-roles?email=...  -> active roles for one employee
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email');

  // Listing all assignments is elevated-only; querying for one email is self-or-elevated.
  const authz = email
    ? await authorizeEmailAccess(email)
    : await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const supabase = getClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let q = supabase
    .from('employee_roles')
    .select('id, work_email, role, assigned_by, assigned_at, revoked_at')
    .is('revoked_at', null)
    .order('assigned_at', { ascending: false });

  // Bridge alternate work emails so the ViewSwitcher (which fetches the caller's
  // own roles here) shows the same dashboards whether the person signed in via
  // their primary work email or a linked alternate — roles granted to either
  // resolve to the same person. See expandWorkEmailAliases.
  if (email) q = q.in('work_email', await expandWorkEmailAliases(authz.effectiveEmail));

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

// POST /api/employee-roles { work_email, role }  -> grant
export async function POST(request: Request) {
  try {
    // Granting roles is admin-only. Without this, any caller could escalate
    // themselves (or anyone) to admin -- the keystone privilege-escalation hole.
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);
    if (!authz.roles?.includes('admin')) {
      return NextResponse.json({ error: 'Admin role required to grant roles' }, { status: 403 });
    }

    const { work_email, role } = (await request.json()) as { work_email?: string; role?: string };
    if (!work_email || !role) {
      return NextResponse.json({ error: 'Missing work_email or role' }, { status: 400 });
    }
    if (!VALID_ROLES.includes(role as Role)) {
      return NextResponse.json({ error: `Invalid role. Expected one of: ${VALID_ROLES.join(', ')}` }, { status: 400 });
    }

    const supabase = getClient();
    if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

    const email = work_email.trim().toLowerCase();

    // If a revoked row exists, un-revoke it; otherwise insert new.
    const { data: existing } = await supabase
      .from('employee_roles')
      .select('id, revoked_at')
      .ilike('work_email', email)
      .eq('role', role)
      .limit(1)
      .maybeSingle();

    const actor = await getSessionActor();
    let error: string | null = null;
    if (existing) {
      if (existing.revoked_at === null) {
        return NextResponse.json({ success: true, alreadyActive: true });
      }
      const { error: upErr } = await supabase
        .from('employee_roles')
        .update({ revoked_at: null, assigned_by: actor.user_name, assigned_at: new Date().toISOString() })
        .eq('id', existing.id);
      error = upErr?.message ?? null;
    } else {
      const { error: insErr } = await supabase
        .from('employee_roles')
        .insert({ work_email: email, role, assigned_by: actor.user_name });
      error = insErr?.message ?? null;
    }

    if (error) {
      const hint =
        /employee_roles_role_check|violates check constraint.*employee_roles/i.test(error)
          ? ' Run references/employee_roles_widen_role_check_orphanage_manager.sql (or widen employee_roles_role_check to include this role).'
          : '';
      return NextResponse.json({ error: `${error}${hint}` }, { status: 500 });
    }

    // Make the dashboard usable immediately by granting edit on all its tabs.
    await provisionDashboardTabs(supabase, email, role, actor.user_name);

    // Invalidate the target's live session so the NEW role reaches their JWT on
    // the next request. Every server-side gate (edge proxy + page layouts) reads
    // roles from the JWT, and getToken() only DECODES the cookie — it never
    // re-reads the DB. Without this, a freshly-granted dashboard role does not
    // take effect until the user happens to re-login: the proxy keeps bouncing
    // them off the new route using their stale token (even though the switcher,
    // which is DB-driven, already offers the new view). The revoke path below
    // already force-logs-out; granting must too. Skip a self-grant so an admin
    // granting themselves a role isn't logged out mid-request.
    if ((authz.sessionEmail ?? '').trim().toLowerCase() !== email) {
      void bumpForceLogoutFor(email);
    }

    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'rbac.role.granted',
      resource: 'employee_roles',
      resource_id: email,
      details: { target_email: email, role },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE /api/employee-roles?email=...&role=...  -> revoke
export async function DELETE(request: Request) {
  try {
    // Revoking roles is admin-only, same as granting.
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);
    if (!authz.roles?.includes('admin')) {
      return NextResponse.json({ error: 'Admin role required to revoke roles' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const work_email = searchParams.get('email');
    const role = searchParams.get('role');
    if (!work_email || !role) {
      return NextResponse.json({ error: 'Missing email or role' }, { status: 400 });
    }

    const supabase = getClient();
    if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

    const email = work_email.trim().toLowerCase();
    const { error } = await supabase
      .from('employee_roles')
      .update({ revoked_at: new Date().toISOString() })
      .ilike('work_email', email)
      .eq('role', role)
      .is('revoked_at', null);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Cascade: revoking the `manager` role must also clear the person's
    // department_managers assignments. Without this they stay registered as a
    // department manager (still gating /api/manager/* and surfacing on every
    // team member's "My Team" roster via getTeamRoster, even from another
    // home department). The dept-manager assignment carries no meaning once the
    // manager role is gone, so tear it down here. Best-effort: a cascade hiccup
    // must not fail the (already-applied) role revoke.
    let cascadedDepartments: string[] = [];
    if (role === 'manager') {
      const { rows: managed } = await listDepartmentsForManager(email);
      cascadedDepartments = managed.map((m) => m.department);
      if (cascadedDepartments.length > 0) {
        await revokeAllForManager(email);
      }
    }

    // Tear down the dashboard's per-tab permissions so the access is fully gone.
    await deprovisionDashboardTabs(supabase, email, role);

    // Invalidate the target's live session server-side. The proxy authorizes off
    // the roles baked into the JWT cookie (getToken only DECODES it — it never
    // re-reads the DB), so without this a revoked role lingers in an active
    // cookie until the throttled 60s jwt-callback refresh (which may not run on a
    // purely client-fetching dashboard) — up to JWT expiry. The Admin UI also
    // fires a best-effort force-logout, but authoritative invalidation must not
    // depend on a fire-and-forget browser request (closed tab / network blip /
    // script / direct API call). Skip a self-revoke so an admin removing their
    // own role isn't logged out mid-request.
    if ((authz.sessionEmail ?? '').trim().toLowerCase() !== email) {
      void bumpForceLogoutFor(email);
    }

    const actor2 = await getSessionActor();
    void insertAuditLog({
      user_name: actor2.user_name,
      user_role: actor2.user_role,
      action: 'rbac.role.revoked',
      resource: 'employee_roles',
      resource_id: email,
      details: { target_email: email, role, cascadedDepartments },
    });

    return NextResponse.json({ success: true, cascadedDepartments });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
