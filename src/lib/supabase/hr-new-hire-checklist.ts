import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "./server";

/**
 * Data access for the HR "New Hire Checklist" tab — a free-form, spreadsheet
 * style intake grid (see references/sql/migrate/2026-06-26_hr_new_hire_checklist.sql).
 *
 * The tab lets HR paste columns of values straight from a spreadsheet, lock
 * them in with Save, and later drive a department-scoped "Bulk Invite" in the
 * onboarding Generate-link flow off these rows. Every data column is plain text
 * so a paste never fails on formatting.
 */

const TABLE = "hr_new_hire_checklist";
const PERIODS_TABLE = "hr_new_hire_checklist_periods";

/** The editable grid columns, in display order. Single source of truth shared
 *  by the API, the grid component, and the Bulk Invite mapping. */
export const HR_NEW_HIRE_CHECKLIST_FIELDS = [
  "name",
  "personal_email",
  "location",
  "phone_number",
  "date_of_interview",
  "source",
  "hired_by",
  "department",
  "country",
  "sources",
] as const;

export type HrNewHireChecklistField =
  (typeof HR_NEW_HIRE_CHECKLIST_FIELDS)[number];

export type HrNewHireChecklistRow = {
  id: string;
  /** The Sun–Sat week this row belongs to, anchored on its Sunday (YYYY-MM-DD). */
  period_start: string | null;
  position: number;
  name: string | null;
  personal_email: string | null;
  location: string | null;
  phone_number: string | null;
  date_of_interview: string | null;
  source: string | null;
  hired_by: string | null;
  department: string | null;
  country: string | null;
  sources: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/** One row as submitted from the grid. `id` present = an existing row to keep
 *  (update); absent/blank = a new row to insert. */
export type HrNewHireChecklistInput = {
  id?: string | null;
} & Partial<Record<HrNewHireChecklistField, string | null>>;

function client() {
  const sb = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!sb)
    throw new Error(
      "Supabase client missing — set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or anon key)",
    );
  return sb;
}

/** Trim a pasted value; collapse blanks to null so empty cells stay empty. */
function clean(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

/** True when every editable field of a row is blank — such rows are dropped on
 *  save so trailing empty grid rows never persist. */
function isBlankRow(r: HrNewHireChecklistInput): boolean {
  return HR_NEW_HIRE_CHECKLIST_FIELDS.every((f) => clean(r[f]) === null);
}

/** One week's grid, in row order (position, then insertion time). */
export async function listHrNewHireChecklist(periodStart: string): Promise<{
  rows: HrNewHireChecklistRow[];
  error: string | null;
}> {
  const period = clean(periodStart);
  if (!period) return { rows: [], error: null };
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .eq("period_start", period)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true })
    .range(0, 4999);
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as HrNewHireChecklistRow[], error: null };
}

/**
 * Full grid sync for ONE week ("Save" / "Lock in" saves straight to Supabase):
 * the payload is the complete desired grid for `periodStart` in row order.
 * Existing rows of that week (with a known `id`) are updated in place —
 * preserving their `created_at` — any DB row of that week not in the payload is
 * deleted, and rows without an `id` are inserted into that week. Every row's
 * `position` is rewritten to its index. Completely-blank rows are dropped first.
 * Scoped to `periodStart` throughout, so saving one week never touches another.
 */
export async function syncHrNewHireChecklist(
  periodStart: string,
  inputRows: HrNewHireChecklistInput[],
  opts: { createdBy?: string | null } = {},
): Promise<{ rows: HrNewHireChecklistRow[]; error: string | null }> {
  const period = clean(periodStart);
  if (!period) return { rows: [], error: "A period (week) is required to save." };
  const sb = client();
  const createdBy = clean(opts.createdBy)?.toLowerCase() ?? null;

  // Drop blank rows, then number what remains by its grid position.
  const ordered = inputRows.filter((r) => !isBlankRow(r));

  // Which DB rows of THIS week currently exist (so we delete only the ones the
  // user removed from this week — never another week's rows).
  const { data: existing, error: existErr } = await sb
    .from(TABLE)
    .select("id")
    .eq("period_start", period);
  if (existErr) return { rows: [], error: existErr.message };
  const existingIds = new Set(
    ((existing ?? []) as { id: string }[]).map((r) => r.id),
  );

  const keepIds = new Set(
    ordered
      .map((r) => (r.id ?? "").trim())
      .filter((id) => id && existingIds.has(id)),
  );
  const toDelete = [...existingIds].filter((id) => !keepIds.has(id));
  if (toDelete.length > 0) {
    const { error: delErr } = await sb.from(TABLE).delete().in("id", toDelete);
    if (delErr) return { rows: [], error: delErr.message };
  }

  const fieldsPayload = (r: HrNewHireChecklistInput) => {
    const out: Record<string, unknown> = {};
    for (const f of HR_NEW_HIRE_CHECKLIST_FIELDS) out[f] = clean(r[f]);
    return out;
  };

  const inserts: Record<string, unknown>[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i]!;
    const id = (r.id ?? "").trim();
    if (id && existingIds.has(id)) {
      const { error: updErr } = await sb
        .from(TABLE)
        .update({ position: i, period_start: period, ...fieldsPayload(r) })
        .eq("id", id);
      if (updErr) return { rows: [], error: updErr.message };
    } else {
      inserts.push({
        position: i,
        period_start: period,
        created_by: createdBy,
        ...fieldsPayload(r),
      });
    }
  }

  if (inserts.length > 0) {
    const { error: insErr } = await sb.from(TABLE).insert(inserts);
    if (insErr) return { rows: [], error: insErr.message };
  }

  return listHrNewHireChecklist(period);
}

/**
 * Distinct, non-blank departments present in the checklist (case-insensitive
 * de-dupe, keeping the first-seen casing), each with its row count. Powers the
 * "Bulk Invite" department picker in the onboarding Generate-link flow.
 */
export async function listHrNewHireChecklistDepartments(): Promise<{
  departments: { department: string; count: number }[];
  error: string | null;
}> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select("department")
    .not("department", "is", null)
    .range(0, 4999);
  if (error) return { departments: [], error: error.message };
  const byKey = new Map<string, { department: string; count: number }>();
  for (const r of (data ?? []) as { department: string | null }[]) {
    const dept = clean(r.department);
    if (!dept) continue;
    const key = dept.toLowerCase();
    const hit = byKey.get(key);
    if (hit) hit.count += 1;
    else byKey.set(key, { department: dept, count: 1 });
  }
  const departments = [...byKey.values()].sort((a, b) =>
    a.department.localeCompare(b.department),
  );
  return { departments, error: null };
}

/**
 * Every checklist row for one department (case-insensitive match), in grid
 * order. Used by Bulk Invite to fan out one onboarding invite per row.
 */
export async function listHrNewHireChecklistByDepartment(
  department: string,
): Promise<{ rows: HrNewHireChecklistRow[]; error: string | null }> {
  const dept = clean(department);
  if (!dept) return { rows: [], error: null };
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .ilike("department", dept)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true })
    .range(0, 4999);
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as HrNewHireChecklistRow[], error: null };
}

/**
 * "Where did we hire people from" — counts hires per `sources` value across ALL
 * weeks (case-insensitive de-dupe, first-seen casing), newest-biggest first.
 * `total` is every tracked hire; `total - Σcount` is the unspecified remainder.
 * Powers the HR Overview hiring-sources pie + table.
 */
export async function listHrNewHireChecklistSourceCounts(): Promise<{
  sources: { source: string; count: number }[];
  total: number;
  error: string | null;
}> {
  const sb = client();
  const { data, error } = await sb.from(TABLE).select("sources").range(0, 9999);
  if (error) return { sources: [], total: 0, error: error.message };
  const rows = (data ?? []) as { sources: string | null }[];
  const byKey = new Map<string, { source: string; count: number }>();
  for (const r of rows) {
    const s = clean(r.sources);
    if (!s) continue;
    const key = s.toLowerCase();
    const hit = byKey.get(key);
    if (hit) hit.count += 1;
    else byKey.set(key, { source: s, count: 1 });
  }
  const sources = [...byKey.values()].sort(
    (a, b) => b.count - a.count || a.source.localeCompare(b.source),
  );
  return { sources, total: rows.length, error: null };
}

// ── Per-week lock ("Lock in" / "Reopen") — its own table, no bonus/payroll tie ─

export type HrChecklistPeriodStatus = "open" | "locked";

export type HrChecklistPeriod = {
  period_start: string;
  period_end: string | null;
  status: HrChecklistPeriodStatus;
  locked_at: string | null;
  locked_by: string | null;
};

/** Lock state for one week. A week with no lock row defaults to `open`. */
export async function getHrChecklistPeriod(
  periodStart: string,
): Promise<{ period: HrChecklistPeriod | null; error: string | null }> {
  const period = clean(periodStart);
  if (!period) return { period: null, error: null };
  const sb = client();
  const { data, error } = await sb
    .from(PERIODS_TABLE)
    .select("period_start, period_end, status, locked_at, locked_by")
    .eq("period_start", period)
    .maybeSingle();
  if (error) return { period: null, error: error.message };
  if (!data) {
    return {
      period: { period_start: period, period_end: null, status: "open", locked_at: null, locked_by: null },
      error: null,
    };
  }
  return { period: data as HrChecklistPeriod, error: null };
}

/** Set a week's lock state (upsert). `locked` stamps who/when; `open` clears them. */
export async function setHrChecklistPeriodStatus(
  periodStart: string,
  args: { status: HrChecklistPeriodStatus; periodEnd?: string | null; by?: string | null },
): Promise<{ period: HrChecklistPeriod | null; error: string | null }> {
  const period = clean(periodStart);
  if (!period) return { period: null, error: "A period (week) is required." };
  const sb = client();
  const locking = args.status === "locked";
  const payload: Record<string, unknown> = {
    period_start: period,
    period_end: clean(args.periodEnd ?? null),
    status: args.status,
    locked_at: locking ? new Date().toISOString() : null,
    locked_by: locking ? clean(args.by)?.toLowerCase() ?? null : null,
  };
  const { data, error } = await sb
    .from(PERIODS_TABLE)
    .upsert(payload, { onConflict: "period_start" })
    .select("period_start, period_end, status, locked_at, locked_by")
    .single();
  if (error) return { period: null, error: error.message };
  return { period: data as HrChecklistPeriod, error: null };
}

/**
 * Every week that has rows and/or a lock row, newest-first, with its row count
 * and lock status. Powers the header period selector (so weeks with saved data
 * or a lock are always selectable alongside the generated rolling weeks).
 */
export async function listHrChecklistPeriods(): Promise<{
  periods: (HrChecklistPeriod & { row_count: number })[];
  error: string | null;
}> {
  const sb = client();

  const [{ data: rowsData, error: rowsErr }, { data: periodsData, error: periodsErr }] =
    await Promise.all([
      sb.from(TABLE).select("period_start").not("period_start", "is", null).range(0, 9999),
      sb.from(PERIODS_TABLE).select("period_start, period_end, status, locked_at, locked_by"),
    ]);
  if (rowsErr) return { periods: [], error: rowsErr.message };
  if (periodsErr) return { periods: [], error: periodsErr.message };

  const counts = new Map<string, number>();
  for (const r of (rowsData ?? []) as { period_start: string | null }[]) {
    const p = r.period_start;
    if (!p) continue;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }

  const byStart = new Map<string, HrChecklistPeriod & { row_count: number }>();
  for (const p of (periodsData ?? []) as HrChecklistPeriod[]) {
    byStart.set(p.period_start, { ...p, row_count: counts.get(p.period_start) ?? 0 });
  }
  // Weeks that have rows but no explicit lock row default to open.
  for (const [start, count] of counts) {
    if (!byStart.has(start)) {
      byStart.set(start, {
        period_start: start,
        period_end: null,
        status: "open",
        locked_at: null,
        locked_by: null,
        row_count: count,
      });
    }
  }

  const periods = [...byStart.values()].sort((a, b) =>
    b.period_start.localeCompare(a.period_start),
  );
  return { periods, error: null };
}
