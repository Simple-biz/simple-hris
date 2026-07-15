import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "./server";
import { isReferralSource } from "@/lib/hr/referral-source";
import { nameTokens } from "@/lib/name/name-tokens";

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
  "referred_by",
  "hired_by",
  "department",
  "country",
] as const;

export type HrNewHireChecklistField =
  (typeof HR_NEW_HIRE_CHECKLIST_FIELDS)[number];

/** One entry in a cell's edit history: who changed it, when, and old -> new. */
export type CellEditEntry = {
  /** Editor's (lowercased) email. */
  by: string;
  /** ISO timestamp of the save that made this change. */
  at: string;
  /** Value before this edit (null = cell was blank / row was new). */
  from: string | null;
  /** Value after this edit (null = cell was cleared). */
  to: string | null;
};

/** Append-only edit history per column for one row (oldest first). Only columns
 *  that have actually changed at least once appear as keys. */
export type CellEdits = Partial<Record<HrNewHireChecklistField, CellEditEntry[]>>;

/** Cap each cell's stored history so an endlessly-edited cell can't grow the
 *  row's JSONB without bound. Keeps the most recent N changes. */
const MAX_CELL_HISTORY = 50;

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
  referred_by: string | null;
  hired_by: string | null;
  department: string | null;
  country: string | null;
  cell_edits: CellEdits | null;
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
 * Every checklist row across ALL weeks, newest week first then grid order.
 * Powers the multi-sheet workbook export (one sheet per week). Ordering matches
 * `listHrNewHireChecklist` within a week so a sheet reads identically to the tab.
 */
export async function listAllHrNewHireChecklist(): Promise<{
  rows: HrNewHireChecklistRow[];
  error: string | null;
}> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .not("period_start", "is", null)
    .order("period_start", { ascending: false })
    .order("position", { ascending: true })
    .order("created_at", { ascending: true })
    .range(0, 9999);
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
 *
 * Per-cell EDIT HISTORY: each field is diffed against the value CURRENTLY IN
 * THE DATABASE (not against whatever the client happened to have loaded) — so
 * the log stays correct even if two people have the grid open at once. Every
 * field whose value actually changes APPENDS a `{by, at, from, to}` entry to
 * that column's log (capped to the most recent MAX_CELL_HISTORY); untouched
 * cells keep their prior log verbatim. The editor is `opts.editedBy`, falling
 * back to `opts.createdBy` (the API route only ever has one acting session
 * email to give); if neither is set, cell_edits is left untouched entirely —
 * never attribute an edit to an unknown editor.
 */
export async function syncHrNewHireChecklist(
  periodStart: string,
  inputRows: HrNewHireChecklistInput[],
  opts: { createdBy?: string | null; editedBy?: string | null } = {},
): Promise<{ rows: HrNewHireChecklistRow[]; error: string | null }> {
  const period = clean(periodStart);
  if (!period) return { rows: [], error: "A period (week) is required to save." };
  const sb = client();
  const createdBy = clean(opts.createdBy)?.toLowerCase() ?? null;
  const editedBy = clean(opts.editedBy ?? opts.createdBy)?.toLowerCase() ?? null;
  const nowIso = new Date().toISOString();

  // Drop blank rows, then number what remains by its grid position.
  const ordered = inputRows.filter((r) => !isBlankRow(r));

  // Which DB rows of THIS week currently exist (so we delete only the ones the
  // user removed from this week — never another week's rows). Fetches full
  // field values + cell_edits too, so updates can diff against the DB's
  // current state rather than trusting the client's copy.
  type ExistingRow = { id: string; cell_edits: CellEdits | null } & Record<
    HrNewHireChecklistField,
    string | null
  >;
  const { data: existing, error: existErr } = await sb
    .from(TABLE)
    .select(["id", "cell_edits", ...HR_NEW_HIRE_CHECKLIST_FIELDS].join(", "))
    .eq("period_start", period);
  if (existErr) return { rows: [], error: existErr.message };
  const existingById = new Map<string, ExistingRow>(
    ((existing ?? []) as unknown as ExistingRow[]).map((r) => [r.id, r]),
  );
  const existingIds = new Set(existingById.keys());

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
    const out: Record<string, string | null> = {};
    for (const f of HR_NEW_HIRE_CHECKLIST_FIELDS) out[f] = clean(r[f]);
    return out;
  };

  const inserts: Record<string, unknown>[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i]!;
    const id = (r.id ?? "").trim();
    const fields = fieldsPayload(r);
    if (id && existingIds.has(id)) {
      const updatePayload: Record<string, unknown> = { position: i, period_start: period, ...fields };
      if (editedBy) {
        const prev = existingById.get(id)!;
        const nextCellEdits: CellEdits = { ...(prev.cell_edits ?? {}) };
        let changed = false;
        for (const f of HR_NEW_HIRE_CHECKLIST_FIELDS) {
          const before = prev[f] ?? null;
          const after = fields[f];
          if (after !== before) {
            const priorLog = Array.isArray(nextCellEdits[f]) ? nextCellEdits[f]! : [];
            const log = priorLog.concat({ by: editedBy, at: nowIso, from: before, to: after });
            nextCellEdits[f] = log.slice(-MAX_CELL_HISTORY);
            changed = true;
          }
        }
        if (changed) updatePayload.cell_edits = nextCellEdits;
      }
      const { error: updErr } = await sb.from(TABLE).update(updatePayload).eq("id", id);
      if (updErr) return { rows: [], error: updErr.message };
    } else {
      const insertPayload: Record<string, unknown> = {
        position: i,
        period_start: period,
        created_by: createdBy,
        ...fields,
      };
      if (editedBy) {
        const cellEdits: CellEdits = {};
        for (const f of HR_NEW_HIRE_CHECKLIST_FIELDS) {
          if (fields[f] != null) cellEdits[f] = [{ by: editedBy, at: nowIso, from: null, to: fields[f] }];
        }
        if (Object.keys(cellEdits).length > 0) insertPayload.cell_edits = cellEdits;
      }
      inserts.push(insertPayload);
    }
  }

  if (inserts.length > 0) {
    const { error: insErr } = await sb.from(TABLE).insert(inserts);
    if (insErr) return { rows: [], error: insErr.message };
  }

  return listHrNewHireChecklist(period);
}

// ── Atomic per-row ops (the modal-only intake model) ──────────────────────────
// Every add/edit/delete is its own scoped write, so two people working the same
// week can never clobber each other the way a whole-grid "make the DB match my
// copy" save does. Nothing here ever deletes a row the caller didn't name.

/** Append a `{by,at,from,to}` entry to a column's history log (capped), and
 *  return the new log. Pure — the caller decides whether the field changed. */
function pushCellEdit(
  prior: CellEditEntry[] | undefined,
  entry: CellEditEntry,
): CellEditEntry[] {
  return (Array.isArray(prior) ? prior : []).concat(entry).slice(-MAX_CELL_HISTORY);
}

/**
 * Insert ONE hire at the end of a week (position after the current max). Blank
 * adds are refused. Seeds each non-blank field's edit history with a `from:null`
 * entry. Returns the freshly-inserted row (with its DB id) so the client can
 * drop it straight into the grid.
 */
export async function insertHrNewHireChecklistRow(
  periodStart: string,
  values: Partial<Record<HrNewHireChecklistField, string | null>>,
  opts: { createdBy?: string | null; editedBy?: string | null } = {},
): Promise<{ row: HrNewHireChecklistRow | null; error: string | null }> {
  const period = clean(periodStart);
  if (!period) return { row: null, error: "A period (week) is required." };
  const sb = client();
  const createdBy = clean(opts.createdBy)?.toLowerCase() ?? null;
  const editedBy = clean(opts.editedBy ?? opts.createdBy)?.toLowerCase() ?? null;
  const nowIso = new Date().toISOString();

  const fields: Record<string, string | null> = {};
  for (const f of HR_NEW_HIRE_CHECKLIST_FIELDS) fields[f] = clean(values[f]);
  if (HR_NEW_HIRE_CHECKLIST_FIELDS.every((f) => fields[f] === null)) {
    return { row: null, error: "Nothing to add — the hire has no details." };
  }

  // Append after the current last row of this week.
  const { data: maxRow, error: maxErr } = await sb
    .from(TABLE)
    .select("position")
    .eq("period_start", period)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxErr) return { row: null, error: maxErr.message };
  const position = ((maxRow?.position as number | undefined) ?? -1) + 1;

  const insertPayload: Record<string, unknown> = {
    position,
    period_start: period,
    created_by: createdBy,
    ...fields,
  };
  if (editedBy) {
    const cellEdits: CellEdits = {};
    for (const f of HR_NEW_HIRE_CHECKLIST_FIELDS) {
      if (fields[f] != null) cellEdits[f] = [{ by: editedBy, at: nowIso, from: null, to: fields[f] }];
    }
    if (Object.keys(cellEdits).length > 0) insertPayload.cell_edits = cellEdits;
  }

  const { data, error } = await sb.from(TABLE).insert(insertPayload).select("*").single();
  if (error) return { row: null, error: error.message };
  return { row: data as HrNewHireChecklistRow, error: null };
}

/**
 * Update ONE row by id, touching ONLY the fields the caller passes (so a
 * bulk-apply of one column can't wipe another). Optimistic concurrency: if
 * `expectedUpdatedAt` is given and the row has moved since the client loaded it,
 * this returns `{ conflict: true }` with the current row instead of overwriting
 * a co-editor's change. Each changed field appends a `cell_edits` entry, diffed
 * against the value CURRENTLY IN THE DB. `updated_at` is advanced explicitly so
 * concurrency detection never depends on a DB trigger.
 */
export async function updateHrNewHireChecklistRow(
  id: string,
  values: Partial<Record<HrNewHireChecklistField, string | null>>,
  opts: { editedBy?: string | null; expectedUpdatedAt?: string | null } = {},
): Promise<{ row: HrNewHireChecklistRow | null; conflict?: boolean; error: string | null }> {
  const rowId = clean(id);
  if (!rowId) return { row: null, error: "A row id is required." };
  const sb = client();
  const editedBy = clean(opts.editedBy)?.toLowerCase() ?? null;
  const nowIso = new Date().toISOString();

  const { data: current, error: curErr } = await sb
    .from(TABLE)
    .select(["id", "updated_at", "cell_edits", ...HR_NEW_HIRE_CHECKLIST_FIELDS].join(", "))
    .eq("id", rowId)
    .maybeSingle();
  if (curErr) return { row: null, error: curErr.message };
  if (!current) {
    return { row: null, error: "That hire no longer exists — it may have just been deleted." };
  }
  const cur = current as unknown as {
    id: string;
    updated_at: string | null;
    cell_edits: CellEdits | null;
  } & Record<HrNewHireChecklistField, string | null>;

  const expected = clean(opts.expectedUpdatedAt ?? null);
  if (expected && cur.updated_at && cur.updated_at !== expected) {
    const { data: full } = await sb.from(TABLE).select("*").eq("id", rowId).maybeSingle();
    return { row: (full ?? null) as HrNewHireChecklistRow | null, conflict: true, error: null };
  }

  const updatePayload: Record<string, unknown> = {};
  const nextCellEdits: CellEdits = { ...(cur.cell_edits ?? {}) };
  let changed = false;
  for (const f of HR_NEW_HIRE_CHECKLIST_FIELDS) {
    if (!(f in values)) continue; // only the fields the caller sent
    const after = clean(values[f]);
    const before = cur[f] ?? null;
    if (after === before) continue;
    updatePayload[f] = after;
    if (editedBy) nextCellEdits[f] = pushCellEdit(nextCellEdits[f], { by: editedBy, at: nowIso, from: before, to: after });
    changed = true;
  }
  if (!changed) {
    const { data: full } = await sb.from(TABLE).select("*").eq("id", rowId).maybeSingle();
    return { row: (full ?? null) as HrNewHireChecklistRow | null, error: null };
  }
  updatePayload.updated_at = nowIso;
  if (editedBy) updatePayload.cell_edits = nextCellEdits;

  const { data, error } = await sb.from(TABLE).update(updatePayload).eq("id", rowId).select("*").single();
  if (error) return { row: null, error: error.message };
  return { row: data as HrNewHireChecklistRow, error: null };
}

/**
 * Delete rows by id (one or many). Scoped by primary key, so it removes exactly
 * the rows named and nothing else. Returns how many were deleted.
 */
export async function deleteHrNewHireChecklistRows(
  ids: string[],
): Promise<{ deleted: number; error: string | null }> {
  const cleanIds = [...new Set(ids.map((i) => (i ?? "").trim()).filter(Boolean))];
  if (cleanIds.length === 0) return { deleted: 0, error: null };
  const sb = client();
  const { data, error } = await sb.from(TABLE).delete().in("id", cleanIds).select("id");
  if (error) return { deleted: 0, error: error.message };
  return { deleted: (data ?? []).length, error: null };
}

/**
 * Set ONE field on many rows (the bulk-apply department / country action). Only
 * that column is written per row, so it can't clobber a co-editor's other cells;
 * each row that actually changes appends a `cell_edits` entry. Returns the fresh
 * rows so the client reconciles exactly. Volume is a manual multi-select, so a
 * per-row update loop keeps the history correct without a bulk-diff dance.
 */
export async function bulkSetHrNewHireChecklistField(
  ids: string[],
  field: HrNewHireChecklistField,
  value: string | null,
  opts: { editedBy?: string | null } = {},
): Promise<{ rows: HrNewHireChecklistRow[]; error: string | null }> {
  if (!HR_NEW_HIRE_CHECKLIST_FIELDS.includes(field)) return { rows: [], error: "Unknown field." };
  const cleanIds = [...new Set(ids.map((i) => (i ?? "").trim()).filter(Boolean))];
  if (cleanIds.length === 0) return { rows: [], error: null };
  const sb = client();
  const editedBy = clean(opts.editedBy)?.toLowerCase() ?? null;
  const nowIso = new Date().toISOString();
  const v = clean(value);

  const { data: existing, error: exErr } = await sb
    .from(TABLE)
    .select(`id, cell_edits, ${field}`)
    .in("id", cleanIds);
  if (exErr) return { rows: [], error: exErr.message };

  for (const raw of (existing ?? []) as Array<{ id: string; cell_edits: CellEdits | null } & Record<string, unknown>>) {
    const before = (raw[field] as string | null) ?? null;
    if (before === v) continue; // already at the target value
    const payload: Record<string, unknown> = { [field]: v, updated_at: nowIso };
    if (editedBy) {
      const ce: CellEdits = { ...(raw.cell_edits ?? {}) };
      ce[field] = pushCellEdit(ce[field], { by: editedBy, at: nowIso, from: before, to: v });
      payload.cell_edits = ce;
    }
    const { error: upErr } = await sb.from(TABLE).update(payload).eq("id", raw.id);
    if (upErr) return { rows: [], error: upErr.message };
  }

  const { data, error } = await sb.from(TABLE).select("*").in("id", cleanIds).order("position", { ascending: true });
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as HrNewHireChecklistRow[], error: null };
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
 * When `periodStart` (a Sun-anchored week, YYYY-MM-DD) is given, the result is
 * scoped to just that week — Bulk Invite passes next week's Sunday so it only
 * pulls the upcoming start cohort. Omitted = every week (legacy all-weeks read).
 */
export async function listHrNewHireChecklistByDepartment(
  department: string,
  periodStart?: string | null,
): Promise<{ rows: HrNewHireChecklistRow[]; error: string | null }> {
  const dept = clean(department);
  if (!dept) return { rows: [], error: null };
  const sb = client();
  let query = sb.from(TABLE).select("*").ilike("department", dept);
  const period = clean(periodStart ?? null);
  if (period) query = query.eq("period_start", period);
  const { data, error } = await query
    .order("position", { ascending: true })
    .order("created_at", { ascending: true })
    .range(0, 4999);
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as HrNewHireChecklistRow[], error: null };
}

/**
 * "Where did we hire people from" — counts hires per `source` value (case-
 * insensitive de-dupe, first-seen casing), newest-biggest first. `total` is
 * every tracked hire; `total - Σcount` is the unspecified remainder. Scoped to
 * ALL weeks by default, or one Sun-anchored week when `periodStart` is given.
 * Powers the HR Overview hiring-sources pie + table.
 */
export async function listHrNewHireChecklistSourceCounts(periodStart?: string): Promise<{
  sources: { source: string; count: number }[];
  total: number;
  error: string | null;
}> {
  const sb = client();
  const period = clean(periodStart ?? null);
  let query = sb.from(TABLE).select("source").range(0, 9999);
  if (period) query = query.eq("period_start", period);
  const { data, error } = await query;
  if (error) return { sources: [], total: 0, error: error.message };
  const rows = (data ?? []) as { source: string | null }[];
  const byKey = new Map<string, { source: string; count: number }>();
  for (const r of rows) {
    const s = clean(r.source);
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

/**
 * Hires grouped by their `hired_by` value — a recruiter scorecard. For each
 * named recruiter:
 *   • `hires`       = how many checklist rows they're credited on
 *   • `interviewed` = how many of those rows carry a `date_of_interview`
 * Rows with a blank `hired_by` are pooled under no recruiter and excluded from
 * the list (but still counted toward `totalHires`). Scoped to ALL weeks by
 * default, or one Sun-anchored week when `periodStart` is given. Powers the HR
 * Overview "Hiring by recruiter" card.
 */
export async function listHrNewHireChecklistRecruiterCounts(periodStart?: string): Promise<{
  recruiters: { recruiter: string; hires: number; interviewed: number }[];
  totalHires: number;
  totalInterviewed: number;
  error: string | null;
}> {
  const sb = client();
  const period = clean(periodStart ?? null);
  let query = sb.from(TABLE).select("hired_by, date_of_interview").range(0, 9999);
  if (period) query = query.eq("period_start", period);
  const { data, error } = await query;
  if (error)
    return { recruiters: [], totalHires: 0, totalInterviewed: 0, error: error.message };
  const rows = (data ?? []) as { hired_by: string | null; date_of_interview: string | null }[];
  const byKey = new Map<string, { recruiter: string; hires: number; interviewed: number }>();
  let totalHires = 0;
  let totalInterviewed = 0;
  for (const r of rows) {
    const interviewed = clean(r.date_of_interview) !== null;
    totalHires += 1;
    if (interviewed) totalInterviewed += 1;
    const who = clean(r.hired_by);
    if (!who) continue;
    const key = who.toLowerCase();
    const hit = byKey.get(key);
    if (hit) {
      hit.hires += 1;
      if (interviewed) hit.interviewed += 1;
    } else {
      byKey.set(key, { recruiter: who, hires: 1, interviewed: interviewed ? 1 : 0 });
    }
  }
  const recruiters = [...byKey.values()].sort(
    (a, b) => b.hires - a.hires || b.interviewed - a.interviewed || a.recruiter.localeCompare(b.recruiter),
  );
  return { recruiters, totalHires, totalInterviewed, error: null };
}

export type ResolvedReferrerEmail = { email: string; offboarded: boolean };

/** One name→email index. `byLiteral` keys the verbatim (case/whitespace-folded)
 *  name; `byExactKey` the full-token-set key; `entries` backs subset matching.
 *  A null map value = two DIFFERENT emails share that key (ambiguous). */
type ReferrerNameIndex = {
  byLiteral: Map<string, string | null>;
  byExactKey: Map<string, string | null>;
  entries: { tokens: Set<string>; email: string }[];
};

/** Verbatim-name key: case + whitespace folded, punctuation KEPT — so a
 *  referred_by pasted straight off a master row hits that exact row even when
 *  a duplicate row for the same human token-collides with it. */
function literalNameKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function addNameIndexEntry(
  index: ReferrerNameIndex,
  name: string | null,
  email: string | null,
): void {
  const n = clean(name);
  const e = clean(email)?.toLowerCase();
  if (!n || !e) return;
  const tokens = nameTokens(n);
  if (tokens.length === 0) return;
  const lit = literalNameKey(n);
  index.byLiteral.set(lit, index.byLiteral.has(lit) && index.byLiteral.get(lit) !== e ? null : e);
  const key = tokens.join(" ");
  index.byExactKey.set(key, index.byExactKey.has(key) && index.byExactKey.get(key) !== e ? null : e);
  index.entries.push({ tokens: new Set(tokens), email: e });
}

/** Verbatim full-name match wins, then exact token-set match, then tokens that
 *  are a subset of EXACTLY ONE entry. A single-letter token is treated as an
 *  initial ("Rudith C" matches a "Rudith Cabana"), still subject to uniqueness.
 *  `ambiguous` = the name fits 2+ different people, so the caller must NOT fall
 *  through to a weaker tier (it could pick the wrong one). */
function matchNameIndex(
  index: ReferrerNameIndex,
  name: string,
  tokens: string[],
): { hit: string | null; ambiguous: boolean } {
  const literal = index.byLiteral.get(literalNameKey(name));
  if (literal !== undefined) return { hit: literal, ambiguous: literal === null };
  const exact = index.byExactKey.get(tokens.join(" "));
  if (exact !== undefined) return { hit: exact, ambiguous: exact === null };
  const tokenFits = (t: string, entryTokens: Set<string>): boolean =>
    t.length === 1
      ? [...entryTokens].some((et) => et.startsWith(t))
      : entryTokens.has(t);
  let hit: string | null = null;
  for (const e of index.entries) {
    if (!tokens.every((t) => tokenFits(t, e.tokens))) continue;
    if (hit !== null && hit !== e.email) return { hit: null, ambiguous: true };
    hit = e.email;
  }
  return { hit, ambiguous: false };
}

/**
 * Resolve free-text referrer names to @simple.biz work emails by token-matching
 * against the master list, in two tiers: ACTIVE employees first, then
 * OFFBOARDED ones (master rows stamped `off_boarded_at` + the `offboarded_sheet`
 * snapshot, which also covers people already deleted from the master), so a
 * referrer who has since left still shows their address — flagged
 * `offboarded: true`. Within a tier an exact token-set match wins, then a
 * unique-subset match (so "Kane Reroma" finds "Jan Kane Reroma"); a name fitting
 * 2+ people resolves blank rather than guessing. Degrades to an all-blank
 * resolver on a master query error — the referrals table must not fail because
 * the email join did.
 */
async function buildReferrerEmailResolver(
  sb: ReturnType<typeof client>,
): Promise<(name: string) => ResolvedReferrerEmail> {
  const NONE: ResolvedReferrerEmail = { email: "", offboarded: false };
  const PAGE = 1000; // PostgREST caps a response at db.max-rows; paginate past it
  const fetchAll = async (table: string, select: string): Promise<Record<string, unknown>[] | null> => {
    const out: Record<string, unknown>[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await sb.from(table).select(select).range(from, from + PAGE - 1);
      if (error) return null;
      const page = (data ?? []) as unknown as Record<string, unknown>[];
      out.push(...page);
      if (page.length < PAGE) break;
      from += PAGE;
    }
    return out;
  };

  const masterRows = await fetchAll("global_master_list", 'Name,"Work Email",off_boarded_at');
  if (!masterRows) return () => NONE;

  const active: ReferrerNameIndex = { byLiteral: new Map(), byExactKey: new Map(), entries: [] };
  const offboarded: ReferrerNameIndex = { byLiteral: new Map(), byExactKey: new Map(), entries: [] };
  for (const r of masterRows) {
    const tier = r.off_boarded_at ? offboarded : active;
    addNameIndexEntry(tier, r.Name as string | null, r["Work Email"] as string | null);
  }
  // Offboarded-sheet snapshot — best-effort (a failure just loses this tier's extras).
  const sheetRows = await fetchAll("offboarded_sheet", "name, work_email");
  for (const r of sheetRows ?? []) {
    addNameIndexEntry(offboarded, r.name as string | null, r.work_email as string | null);
  }

  return (name: string): ResolvedReferrerEmail => {
    const tokens = nameTokens(name);
    if (tokens.length === 0) return NONE;
    const a = matchNameIndex(active, name, tokens);
    if (a.hit) return { email: a.hit, offboarded: false };
    if (a.ambiguous) return NONE;
    const o = matchNameIndex(offboarded, name, tokens);
    if (o.hit) return { email: o.hit, offboarded: true };
    return NONE;
  };
}

/**
 * Employee referrals — one row per REFERRAL hire (a checklist row whose `source`
 * is a referral, see `isReferralSource`; every other channel + blank source is
 * dropped). Each entry pairs the new hire's name with WHO referred them
 * (`referred_by`, blank if not filled in) and the referrer's @simple.biz work
 * email token-matched off the master list — active employees first, falling
 * back to offboarded ones (`referredByOffboarded: true`); blank when unmatched
 * or ambiguous. Scoped to ALL weeks by default, or one Sun-anchored week when
 * `periodStart` (YYYY-MM-DD) is given. Sorted by referrer then hire so a
 * referrer's people group together. Powers the HR Overview "Referrals" table
 * (New Hire that was Referred · Referred By · Referrer Simple.biz Email).
 */
export async function listHrNewHireChecklistReferrals(periodStart?: string): Promise<{
  referrals: {
    hire: string;
    referredBy: string;
    referredByEmail: string;
    referredByOffboarded: boolean;
  }[];
  total: number;
  error: string | null;
}> {
  const sb = client();
  const period = clean(periodStart ?? null);
  let query = sb.from(TABLE).select("source, name, referred_by").range(0, 9999);
  if (period) query = query.eq("period_start", period);
  const [{ data, error }, resolveEmail] = await Promise.all([
    query,
    buildReferrerEmailResolver(sb),
  ]);
  if (error) return { referrals: [], total: 0, error: error.message };
  const rows = (data ?? []) as { source: string | null; name: string | null; referred_by: string | null }[];
  const referrals: {
    hire: string;
    referredBy: string;
    referredByEmail: string;
    referredByOffboarded: boolean;
  }[] = [];
  for (const r of rows) {
    if (!isReferralSource(r.source ?? "")) continue; // ONLY referral hires
    const referredBy = clean(r.referred_by) ?? "";
    const resolved = referredBy ? resolveEmail(referredBy) : { email: "", offboarded: false };
    referrals.push({
      hire: clean(r.name) ?? "",
      referredBy,
      referredByEmail: resolved.email,
      referredByOffboarded: resolved.offboarded,
    });
  }
  referrals.sort(
    (a, b) => a.referredBy.localeCompare(b.referredBy) || a.hire.localeCompare(b.hire),
  );
  return { referrals, total: rows.length, error: null };
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
