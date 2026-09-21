import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { expandWorkEmailAliases } from "@/lib/email/work-email-aliases";

export const FEATURE_ACCESS_LEVELS = ["hidden", "view", "edit"] as const;
export type FeatureAccess = (typeof FEATURE_ACCESS_LEVELS)[number];

/** Every view that supports per-tab gating.
 *
 *  A FeatureViewKey is a PERMISSION CATALOG, not a URL. `tickets` and
 *  `employee_support` are two catalogs sharing one route (/tickets) and nothing
 *  else — see the note on the `employee_support` catalog below. */
export type FeatureViewKey = "accounting" | "manager" | "hr" | "orphanage" | "ceo" | "contractor" | "qc" | "tickets" | "employee_support";

/** Catalog of features per view — single source of truth for the admin grid
 *  and the runtime lookups. Adding a tab? Append it here and the AdminRoles
 *  permission grid + JWT shape pick it up automatically. */
export const FEATURE_CATALOG: Record<FeatureViewKey, readonly { key: string; label: string }[]> = {
  accounting: [
    { key: "overview",         label: "Overview" },
    { key: "people",           label: "People" },
    { key: "payroll_wizard",   label: "Payroll Wizard" },
    { key: "bonus_catalog",    label: "Payment Catalog" },
    { key: "payment_dispatch", label: "Payment Dispatch" },
    { key: "disputes",         label: "Issues" },
    { key: "transfers",        label: "Transfers" },
    { key: "mesa",             label: "MESA" },
    { key: "documents",        label: "Documents" },
    { key: "announcements",    label: "Announcements" },
    { key: "notifications",    label: "Notifications" },
    { key: "s_wall",           label: "S-Wall" },
    { key: "settings",         label: "Settings" },
  ],
  hr: [
    { key: "overview",            label: "Overview" },
    { key: "global_master_list",  label: "Global Master List" },
    { key: "screening",           label: "Screening" },
    { key: "new_hire_checklist",  label: "New Hire Checklist" },
    { key: "onboarding",          label: "Onboarding" },
    { key: "offboarding",         label: "Offboarding" },
    { key: "leaves",        label: "Leaves" },
    { key: "transfers",     label: "Transfers" },
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
    { key: "transfers",        label: "Transfers" },
    { key: "announcements",    label: "Announcements" },
    { key: "s_wall",           label: "S-Wall" },
    { key: "hsl_bonus",        label: "HSL Bonus" },
    { key: "bonus_history",    label: "Bonus History" },
    { key: "notifications",    label: "Notifications" },
  ],
  orphanage: [
    { key: "overview",            label: "Overview" },
    { key: "queue",               label: "Queue" },
    { key: "budget",              label: "Budget" },
    { key: "budget_history",      label: "Budget History" },
    { key: "third_party_vendors", label: "3rd Party Vendors" },
    { key: "interns",             label: "Interns" },
    { key: "s_wall",              label: "S-Wall" },
    { key: "notifications",       label: "Notifications" },
  ],
  ceo: [
    { key: "overview",          label: "Overview" },
    { key: "financial_reports", label: "Financial Reports" },
    { key: "biz_ai",        label: "Penny AI" },
    { key: "people",        label: "People" },
    { key: "announcements", label: "Announcements" },
    { key: "s_wall",        label: "S-Wall" },
    { key: "notifications", label: "Notifications" },
  ],
  contractor: [
    { key: "overview", label: "Overview" },
    { key: "profile",  label: "Profile" },
    { key: "invoices", label: "Invoices" },
  ],
  qc: [
    { key: "overview",       label: "Overview" },
    { key: "qc_calculator",  label: "QC Calculator" },
    { key: "notifications",  label: "Notifications" },
  ],
  // The standalone /tickets board for holders of the dedicated `tickets` role.
  // This is the ONLY catalog that carries the `tickets` feature: the board is a
  // dedicated-role surface, NOT a per-dashboard tab. Assigning Accounting / HR /
  // Manager / CEO no longer confers ticket access — the `tickets` role does.
  tickets: [
    { key: "tickets", label: "Ticket Board" },
  ],
  // Employee Support — the live-chat queue the five answerers work (Carla,
  // Claire, Ainsley, Grace, Alivia). Hosted at /tickets beside the dev Kanban
  // and sharing NOTHING with it.
  //
  // Kane's Q3, 2026-09-19 (docs/superpowers/plans/2026-09-19-employee-support-chat.md:26):
  // "a new employee_support role + FeatureViewKey ... Not a feature key under
  // the tickets view." The reason is mechanical, not stylistic: granting a role
  // auto-provisions `edit` on EVERY feature in that role's view
  // (provisionDashboardTabs, app/api/employee-roles/route.ts:41-85), so a
  // support key parked in the `tickets` catalog would have handed the five
  // answerers the HRIS dev board on the day they were granted. Carla signed
  // "the support team only sees support questions."
  //
  // THE KEYS HERE MUST NEVER COLLIDE WITH THE `tickets` CATALOG'S. That
  // disjointness IS the gate in both directions: requireFeatureAccessAnyView()
  // maps each of the caller's roles to ITS view and looks the feature up only
  // there (authorize-feature.ts:119-128), so an `employee_support` holder
  // resolves `tickets` to hidden (→ /api/tickets 403s them) and a `tickets`
  // holder resolves `support_chat` to hidden. Pinned by
  // src/lib/rbac/view-tabs.test.ts.
  //
  // TWO tabs since 2026-09-21. Kane: "there should be two tabs in ticket for
  // employee support one for chat and one for ticket" — so the ES- ticket queue
  // that was out of scope for the chat build now has its key, appended into the
  // SAME catalog rather than given a view of its own. That is the whole gate
  // change: `ticketsHostAccess` already returns every granted support tab and
  // lands on the first (view-tabs.ts:272-287), so a second tab is a catalog
  // entry plus a nav row — no new role, no new FeatureViewKey, no new guard.
  //
  // ORDER IS THE LANDING. `VIEW_TAB_IDS.employee_support` mirrors this list and
  // the host opens on its first granted id, so `support_chat` stays first: chat
  // is the intake channel and it is where the five answerers landed yesterday.
  //
  // ⚠ DEPLOY: the five answerers were granted `employee_support` BEFORE this key
  // existed. `provisionDashboardTabs` writes the catalog only at grant time
  // (app/api/employee-roles/route.ts:41-85), so their overlay has
  // `support_chat: edit` and NO `support_tickets` row — which resolves to
  // `hidden` and correctly hides the tab until an admin grants it in the grid.
  // Anyone granted the role after this ships gets both.
  employee_support: [
    { key: "support_chat",    label: "Support Chat" },
    { key: "support_tickets", label: "Support Tickets" },
  ],
};

/** Maps each assignable role to the view its feature-permission catalog
 *  lives under. `admin` intentionally has no entry — admins bypass tab
 *  gating in every view. */
export const ROLE_TO_FEATURE_VIEW: Record<string, FeatureViewKey> = {
  accounting:         "accounting",
  hr_coordinator:     "hr",
  manager:            "manager",
  orphanage_manager:  "orphanage",
  ceo:                "ceo",
  contractor:         "contractor",
  qc:                 "qc",
  tickets:            "tickets",
  // A role with no entry here is INERT for every feature gate: the loop in
  // requireFeatureAccessAnyView (authorize-feature.ts:119-128) skips it and the
  // caller falls through to the default 403 — the grant would exist in
  // employee_roles and buy nothing. `employee_support` must be here for the
  // support routes to be reachable at all, and it must map to its OWN view so
  // it can never resolve a `tickets` feature.
  employee_support:   "employee_support",
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

  // Bridge alternate work emails: this returns a person's EFFECTIVE tab access,
  // and an alternate (second-inbox) address is the same human — so a grant on
  // their primary work email must apply when they're keyed on an alternate
  // (mutation authz, notification gating). Mirrors the role + self-read overlay
  // bridges. On a same (view, feature) collision across addresses, the most
  // permissive access wins (edit > view > hidden).
  const emails = await expandWorkEmailAliases(norm);
  const { data, error } = await supabase
    .from("employee_feature_permissions")
    .select("work_email, view_key, feature, access")
    .in("work_email", emails)
    .is("revoked_at", null);
  if (error || !data) return {};

  const rank: Record<FeatureAccess, number> = { hidden: 0, view: 1, edit: 2 };
  const out: FeaturePermissionsMap = {};
  for (const r of data as PermRow[]) {
    const view = r.view_key as FeatureViewKey;
    if (!out[view]) out[view] = {};
    const bucket = out[view] as Record<string, FeatureAccess>;
    const cur = bucket[r.feature];
    if (!cur || rank[r.access] > rank[cur]) bucket[r.feature] = r.access;
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
