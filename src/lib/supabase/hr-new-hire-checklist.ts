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

/** The editable grid columns, in display order. Single source of truth shared
 *  by the API, the grid component, and the Bulk Invite mapping. */
export const HR_NEW_HIRE_CHECKLIST_FIELDS = [
  "name",
  "personal_email",
  "start_date",
  "location",
  "phone_number",
  "date_of_interview",
  "source",
  "hired_by",
  "department",
  "country",
] as const;

export type HrNewHireChecklistField =
  (typeof HR_NEW_HIRE_CHECKLIST_FIELDS)[number];

export type HrNewHireChecklistRow = {
  id: string;
  position: number;
  name: string | null;
  personal_email: string | null;
  start_date: string | null;
  location: string | null;
  phone_number: string | null;
  date_of_interview: string | null;
  source: string | null;
  hired_by: string | null;
  department: string | null;
  country: string | null;
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

/** The grid, in row order (position, then insertion time). */
export async function listHrNewHireChecklist(): Promise<{
  rows: HrNewHireChecklistRow[];
  error: string | null;
}> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .order("position", { ascending: true })
    .order("created_at", { ascending: true })
    .range(0, 4999);
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as HrNewHireChecklistRow[], error: null };
}

/**
 * Full grid sync ("Save"): the payload is the complete desired grid in row
 * order. Existing rows (with a known `id`) are updated in place — preserving
 * their `created_at` — any DB row not in the payload is deleted, and rows
 * without an `id` are inserted. Every row's `position` is rewritten to its
 * index in the ordered payload so the grid round-trips in the same order.
 * Completely-blank rows are dropped first.
 */
export async function syncHrNewHireChecklist(
  inputRows: HrNewHireChecklistInput[],
  opts: { createdBy?: string | null } = {},
): Promise<{ rows: HrNewHireChecklistRow[]; error: string | null }> {
  const sb = client();
  const createdBy = clean(opts.createdBy)?.toLowerCase() ?? null;

  // Drop blank rows, then number what remains by its grid position.
  const ordered = inputRows.filter((r) => !isBlankRow(r));

  // Which DB rows currently exist (so we can delete the ones the user removed).
  const { data: existing, error: existErr } = await sb
    .from(TABLE)
    .select("id");
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
        .update({ position: i, ...fieldsPayload(r) })
        .eq("id", id);
      if (updErr) return { rows: [], error: updErr.message };
    } else {
      inserts.push({ position: i, created_by: createdBy, ...fieldsPayload(r) });
    }
  }

  if (inserts.length > 0) {
    const { error: insErr } = await sb.from(TABLE).insert(inserts);
    if (insErr) return { rows: [], error: insErr.message };
  }

  return listHrNewHireChecklist();
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
