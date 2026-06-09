import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";

/**
 * Offboarding RBAC snapshot + restore.
 *
 * When HR off-boards someone we strip every RBAC grant they hold so a stale
 * JWT (or a leftover row surfaced in Admin -> Roles) can never keep them
 * privileged. The grants are first snapshotted into `app_settings` under
 * `offboard.rbac.<email>` so that re-onboarding the same person from the HR
 * Offboarding section restores exactly the access they had.
 *
 * Three tables are covered, all keyed by email and all using the soft-delete
 * `revoked_at` idiom:
 *   - employee_roles            (work_email, role)
 *   - department_managers       (manager_email, department)
 *   - employee_feature_permissions (work_email, view_key, feature, access)
 *
 * No schema change: the snapshot lives in the generic key/value app_settings
 * table, and revoke/restore reuse the existing `revoked_at` column.
 */

type SupabaseClient = NonNullable<ReturnType<typeof createSupabaseServerClient>>;

function getClient(): SupabaseClient | null {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

function snapshotKey(email: string): string {
  return `offboard.rbac.${email.trim().toLowerCase()}`;
}

interface FeatureGrant {
  view_key: string;
  feature: string;
  access: string;
}

interface RbacSnapshot {
  email: string;
  snapshot_at: string;
  roles: string[];
  departments: string[];
  features: FeatureGrant[];
}

export interface OffboardRbacResult {
  roles: number;
  departments: number;
  features: number;
}

/**
 * Snapshots every active grant for `email`, writes it to app_settings, then
 * revokes all of them. Idempotent-ish: if the person already holds no active
 * grants, any existing snapshot is preserved (so a double off-board doesn't
 * clobber the original record with an empty one).
 */
export async function snapshotAndRevokeRbacGrants(
  email: string,
): Promise<OffboardRbacResult> {
  const supabase = getClient();
  const result: OffboardRbacResult = { roles: 0, departments: 0, features: 0 };
  if (!supabase) return result;

  const target = email.trim().toLowerCase();
  if (!target) return result;
  const nowIso = new Date().toISOString();

  // 1. Read the current active grants across all three tables.
  const [rolesRes, deptRes, featRes] = await Promise.all([
    supabase
      .from("employee_roles")
      .select("role")
      .ilike("work_email", target)
      .is("revoked_at", null),
    supabase
      .from("department_managers")
      .select("department")
      .ilike("manager_email", target)
      .is("revoked_at", null),
    supabase
      .from("employee_feature_permissions")
      .select("view_key, feature, access")
      .eq("work_email", target)
      .is("revoked_at", null),
  ]);

  const roles = Array.from(
    new Set(
      ((rolesRes.data as Array<{ role: string }> | null) ?? [])
        .map((r) => r.role)
        .filter(Boolean),
    ),
  );
  const departments = Array.from(
    new Set(
      ((deptRes.data as Array<{ department: string }> | null) ?? [])
        .map((d) => d.department)
        .filter(Boolean),
    ),
  );
  const features = ((featRes.data as Array<FeatureGrant> | null) ?? []).map(
    (f) => ({ view_key: f.view_key, feature: f.feature, access: f.access }),
  );

  result.roles = roles.length;
  result.departments = departments.length;
  result.features = features.length;

  // 2. Persist the snapshot (only when there is something to remember, so a
  //    repeat off-board can't overwrite a good snapshot with an empty one).
  if (roles.length || departments.length || features.length) {
    const snapshot: RbacSnapshot = {
      email: target,
      snapshot_at: nowIso,
      roles,
      departments,
      features,
    };
    await supabase
      .from("app_settings")
      .upsert(
        { key: snapshotKey(target), value: JSON.stringify(snapshot), updated_at: nowIso },
        { onConflict: "key" },
      );
  }

  // 3. Revoke every active grant. Each is a soft-delete so the row survives for
  //    history and for the restore path.
  await Promise.all([
    supabase
      .from("employee_roles")
      .update({ revoked_at: nowIso })
      .ilike("work_email", target)
      .is("revoked_at", null),
    supabase
      .from("department_managers")
      .update({ revoked_at: nowIso })
      .ilike("manager_email", target)
      .is("revoked_at", null),
    supabase
      .from("employee_feature_permissions")
      .update({ revoked_at: nowIso })
      .eq("work_email", target)
      .is("revoked_at", null),
  ]);

  return result;
}

/**
 * Restores the grants captured by {@link snapshotAndRevokeRbacGrants}. Re-grants
 * are idempotent and conflict-safe: an already-active grant is left alone, a
 * previously-revoked row is un-revoked, and a missing row is re-inserted. The
 * snapshot key is deleted once restore completes. Returns counts of what was
 * brought back; all-zero when there was no snapshot to restore.
 */
export async function restoreRbacGrants(
  email: string,
  actorEmail: string | null,
): Promise<OffboardRbacResult> {
  const supabase = getClient();
  const result: OffboardRbacResult = { roles: 0, departments: 0, features: 0 };
  if (!supabase) return result;

  const target = email.trim().toLowerCase();
  if (!target) return result;
  const key = snapshotKey(target);

  const { data: settingRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  const raw = (settingRow as { value: string } | null)?.value;
  if (!raw) return result;

  let snapshot: RbacSnapshot;
  try {
    snapshot = JSON.parse(raw) as RbacSnapshot;
  } catch {
    return result;
  }

  const actor = actorEmail?.trim() || null;
  const nowIso = new Date().toISOString();

  // Roles: at most one row per (email, role) thanks to the grant API's
  // un-revoke-or-insert behaviour.
  for (const role of snapshot.roles ?? []) {
    result.roles += await regrant(
      supabase,
      "employee_roles",
      "work_email",
      target,
      { role },
      { assigned_by: actor, assigned_at: nowIso },
    );
  }

  // Departments: unique (manager_email, department) constraint -> one row each.
  for (const department of snapshot.departments ?? []) {
    result.departments += await regrant(
      supabase,
      "department_managers",
      "manager_email",
      target,
      { department },
      { assigned_by: actor, assigned_at: nowIso },
    );
  }

  // Feature permissions: may have several revoked rows per (view, feature) from
  // prior edits, so re-grant the single latest one (or insert) with the
  // snapshotted access level.
  for (const f of snapshot.features ?? []) {
    result.features += await regrant(
      supabase,
      "employee_feature_permissions",
      "work_email",
      target,
      { view_key: f.view_key, feature: f.feature },
      { access: f.access, granted_by: actor, granted_at: nowIso },
    );
  }

  // Drop the snapshot — the grants are live again.
  await supabase.from("app_settings").delete().eq("key", key);

  return result;
}

/**
 * Idempotent single-row re-grant. The grant is identified by an email column
 * (matched case-insensitively, like the rest of the RBAC code) plus zero or
 * more exact-match columns; `extra` holds the columns to (re)write (assignment
 * metadata, access level). Returns 1 if a row was brought back / created, 0 if
 * it was already active.
 */
async function regrant(
  supabase: SupabaseClient,
  table: string,
  emailColumn: string,
  emailValue: string,
  match: Record<string, string>,
  extra: Record<string, string | null>,
): Promise<number> {
  // Is there already an active row for this exact grant? If so, nothing to do.
  let activeQ = supabase
    .from(table)
    .select("id")
    .ilike(emailColumn, emailValue)
    .is("revoked_at", null)
    .limit(1);
  for (const [col, val] of Object.entries(match)) activeQ = activeQ.eq(col, val);
  const { data: active } = await activeQ;
  if (active && active.length > 0) return 0;

  // Re-use the most recent revoked row when one exists; otherwise insert fresh.
  let revokedQ = supabase
    .from(table)
    .select("id")
    .ilike(emailColumn, emailValue)
    .not("revoked_at", "is", null)
    .order("revoked_at", { ascending: false })
    .limit(1);
  for (const [col, val] of Object.entries(match)) revokedQ = revokedQ.eq(col, val);
  const { data: revoked } = await revokedQ;

  if (revoked && revoked.length > 0) {
    await supabase
      .from(table)
      .update({ revoked_at: null, ...extra })
      .eq("id", (revoked[0] as { id: string }).id);
    return 1;
  }

  await supabase.from(table).insert({ [emailColumn]: emailValue, ...match, ...extra });
  return 1;
}
