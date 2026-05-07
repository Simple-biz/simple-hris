import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "./server";

/**
 * Lookups against the `active_hsl_agents` view (the "current upload" of the
 * HSL pay-plan Google Sheet — see `references/hsl_agents_upload_archive.sql`
 * and `docs/csv-imports.md`).
 *
 * The view already returns rows with friendly column names like
 * `"Department/Role"` and `"KPI/Bonus"` — those columns are aliased from the
 * underlying `hsl_team_members` snake_case columns.
 */

interface ActiveHslAgentRow {
  email: string | null;
  full_name: string | null;
  hsl_name: string | null;
  "Department/Role": string | null;
  "KPI/Bonus": string | null;
  dept_key: string | null;
  is_manager: boolean | null;
  hourly_rate: number | string | null;
  ot_rate: number | string | null;
}

function lower(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  return t === "" ? null : t;
}

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^\d.\-]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface HslAgentDetails {
  /** "Department/Role" column value — e.g. "Case Manager", "Filing Specialist Asst TL". */
  role: string | null;
  /** Hourly rate in PHP. Null if the sheet didn't carry one for this agent. */
  hourlyRate: number | null;
  /** OT rate in PHP. Null if the sheet didn't carry one. */
  otRate: number | null;
}

/**
 * Map of `lower(email) → { role, hourlyRate, otRate }` for every active HSL
 * agent (rows in the `active_hsl_agents` view, i.e. the current sync of the
 * HOGAN SMITH AGENT PAY PLAN sheet).
 *
 * Used by routes that need to surface HSL-specific role + rate data alongside
 * the master-list employee record — currently just the manager team panel.
 *
 * Returns an empty Map and the error message if the view is unreachable
 * (migration not yet run, no service-role key, etc.). Callers should treat
 * that as "no HSL data available", not a hard error.
 */
export async function fetchActiveHslDetailsByEmail(): Promise<{
  byEmail: Map<string, HslAgentDetails>;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return {
      byEmail: new Map(),
      error: "Supabase client not configured (NEXT_PUBLIC_SUPABASE_URL / keys).",
    };
  }

  const { data, error } = await supabase
    .from("active_hsl_agents")
    .select('email, "Department/Role", hourly_rate, ot_rate')
    .range(0, 9999);

  if (error) {
    return { byEmail: new Map(), error: error.message };
  }

  const byEmail = new Map<string, HslAgentDetails>();
  for (const r of (data ?? []) as ActiveHslAgentRow[]) {
    const key = lower(r.email);
    if (!key) continue;
    const role = (r["Department/Role"] ?? "").trim() || null;
    const hourlyRate = toNumber(r.hourly_rate);
    const otRate = toNumber(r.ot_rate);
    // Skip entirely empty entries — nothing to surface.
    if (!role && hourlyRate == null && otRate == null) continue;
    byEmail.set(key, { role, hourlyRate, otRate });
  }
  return { byEmail, error: null };
}

/**
 * @deprecated Prefer `fetchActiveHslDetailsByEmail`, which also carries
 * hourly + OT rates. Kept as a thin shim in case other callers wire in later.
 */
export async function fetchActiveHslRoleByEmail(): Promise<{
  byEmail: Map<string, string>;
  error: string | null;
}> {
  const { byEmail: rich, error } = await fetchActiveHslDetailsByEmail();
  const byEmail = new Map<string, string>();
  for (const [k, v] of rich) {
    if (v.role) byEmail.set(k, v.role);
  }
  return { byEmail, error };
}
