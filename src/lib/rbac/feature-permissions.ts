import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";

export const FEATURE_ACCESS_LEVELS = ["hidden", "view", "edit"] as const;
export type FeatureAccess = (typeof FEATURE_ACCESS_LEVELS)[number];

/** Every view that supports per-tab gating. */
export type FeatureViewKey = "accounting" | "manager" | "hr" | "orphanage" | "ceo" | "contractor";

/** Catalog of features per view — single source of truth for the admin grid
 *  and the runtime lookups. Adding a tab? Append it here and the AdminRoles
 *  permission grid + JWT shape pick it up automatically. */
export const FEATURE_CATALOG: Record<FeatureViewKey, readonly { key: string; label: string }[]> = {
  accounting: [
    { key: "overview",         label: "Overview" },
    { key: "rates",            label: "Rates & Profiles" },
    { key: "payroll_wizard",   label: "Payroll Wizard" },
    { key: "payment_dispatch", label: "Payment Dispatch" },
    { key: "disputes",         label: "Disputes" },
    { key: "announcements",    label: "Announcements" },
    { key: "notifications",    label: "Notifications" },
    { key: "s_wall",           label: "S-Wall" },
    { key: "settings",         label: "Settings" },
  ],
  hr: [
    { key: "overview",      label: "Overview" },
    { key: "onboarding",    label: "Onboarding" },
    { key: "offboarding",   label: "Offboarding" },
    { key: "leaves",        label: "Leaves" },
    { key: "gift_tracker",  label: "Gift Tracker" },
    { key: "mesa",          label: "MESA" },
    { key: "announcements", label: "Announcements" },
    { key: "s_wall",        label: "S-Wall" },
    { key: "notifications", label: "Notifications" },
  ],
  manager: [
    { key: "overview",         label: "Overview" },
    { key: "time_adjustments", label: "Time Adjustments" },
    { key: "leaves",           label: "Leaves" },
    { key: "team",             label: "Team" },
    { key: "announcements",    label: "Announcements" },
    { key: "s_wall",           label: "S-Wall" },
    { key: "hsl_bonus",        label: "HSL Bonus" },
    { key: "bonus_history",    label: "Bonus History" },
    { key: "notifications",    label: "Notifications" },
  ],
  orphanage: [
    { key: "overview",       label: "Overview" },
    { key: "queue",          label: "Queue" },
    { key: "budget",         label: "Budget" },
    { key: "budget_history", label: "Budget History" },
    { key: "s_wall",         label: "S-Wall" },
    { key: "notifications",  label: "Notifications" },
  ],
  ceo: [
    { key: "overview",      label: "Overview" },
    { key: "announcements", label: "Announcements" },
    { key: "s_wall",        label: "S-Wall" },
    { key: "notifications", label: "Notifications" },
  ],
  contractor: [
    { key: "overview", label: "Overview" },
    { key: "profile",  label: "Profile" },
    { key: "invoices", label: "Invoices" },
  ],
};

/** Maps each assignable role to the view its feature-permission catalog
 *  lives under. `admin` intentionally has no entry — admins bypass tab
 *  gating in every view. */
export const ROLE_TO_FEATURE_VIEW: Record<string, FeatureViewKey> = {
  finance:            "accounting",
  hr_coordinator:     "hr",
  manager:            "manager",
  orphanage_manager:  "orphanage",
  ceo:                "ceo",
  contractor:         "contractor",
};

export type FeaturePermissionsMap = Partial<Record<FeatureViewKey, Record<string, FeatureAccess>>>;

interface PermRow {
  work_email: string;
  view_key: string;
  feature: string;
  access: FeatureAccess;
}

/**
 * Returns the user's per-feature access map. Missing entries = `hidden`.
 * Callers may use the safer {@link resolveFeatureAccess} helper instead of
 * indexing the map by hand.
 */
export async function fetchFeaturePermissionsForEmail(
  email: string,
): Promise<FeaturePermissionsMap> {
  const norm = email.trim().toLowerCase();
  if (!norm) return {};
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return {};

  const { data, error } = await supabase
    .from("employee_feature_permissions")
    .select("work_email, view_key, feature, access")
    .eq("work_email", norm)
    .is("revoked_at", null);
  if (error || !data) return {};

  const out: FeaturePermissionsMap = {};
  for (const r of data as PermRow[]) {
    const view = r.view_key as FeatureViewKey;
    if (!out[view]) out[view] = {};
    (out[view] as Record<string, FeatureAccess>)[r.feature] = r.access;
  }
  return out;
}

/** Reads from a pre-fetched map. Defaults to `hidden`. */
export function resolveFeatureAccess(
  perms: FeaturePermissionsMap | undefined | null,
  view: FeatureViewKey,
  feature: string,
): FeatureAccess {
  const access = perms?.[view]?.[feature];
  return access ?? "hidden";
}

/** Convenience: returns true if access is at least `view`. */
export function canSeeFeature(
  perms: FeaturePermissionsMap | undefined | null,
  view: FeatureViewKey,
  feature: string,
): boolean {
  return resolveFeatureAccess(perms, view, feature) !== "hidden";
}

/** Convenience: returns true if access is `edit`. */
export function canEditFeature(
  perms: FeaturePermissionsMap | undefined | null,
  view: FeatureViewKey,
  feature: string,
): boolean {
  return resolveFeatureAccess(perms, view, feature) === "edit";
}
