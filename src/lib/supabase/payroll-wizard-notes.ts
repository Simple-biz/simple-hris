import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "./server";
import { listActiveMasterListPeople } from "./global-master-list-db";
import { manilaMonthDayStamp, manilaWeekStart } from "@/lib/payroll/manila-week";
import { formatAdjustmentText } from "@/lib/payroll/adjustment-bridge";

/**
 * Data access for the Payroll Wizard's floating "Notes" checklist (see
 * references/sql/create/create_payroll_wizard_notes.sql).
 *
 * A running carry-over list for the next payroll week — missed bonuses, rate
 * changes, staged deductions. Deliberately simple: one flat table, every text
 * column free-form (so it pastes like the old spreadsheet), plus a Done flag
 * ticked once the item has been applied in a following week. Last write wins;
 * the volume here is a handful of rows a week, not a co-edited grid.
 */

const TABLE = "payroll_wizard_notes";

/** The free-text columns, in display order (Done is a boolean, kept apart). */
export const PAYROLL_WIZARD_NOTE_FIELDS = [
  "note_date",
  "payroll_clerk",
  "worker",
  "worker_email",
  "adjustment",
  "notes",
] as const;

export type PayrollWizardNoteField = (typeof PAYROLL_WIZARD_NOTE_FIELDS)[number];

export type PayrollWizardNoteRow = {
  id: string;
  note_date: string | null;
  payroll_clerk: string | null;
  done: boolean;
  worker: string | null;
  /** Work email behind the Worker text — set when the worker was picked from
   *  the suggestion list (or bridged from the wizard), cleared when the text
   *  is hand-edited away from a known person. Links the row to the wizard's
   *  Additions "Adj." override; never rendered as its own column. */
  worker_email: string | null;
  adjustment: string | null;
  notes: string | null;
  /** Monday (ISO date) of the payroll week the note was WRITTEN — stamped
   *  server-side, never client-editable. Null = a blank seeded line that
   *  hasn't been filled in yet. Drives the board's week selector. */
  week_start: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/** Text fields plus the Done flag, as accepted from the API. */
export type PayrollWizardNoteValues = Partial<
  Record<PayrollWizardNoteField, string | null> & { done: boolean }
>;

function client() {
  const sb = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!sb)
    throw new Error(
      "Supabase client missing — set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or anon key)",
    );
  return sb;
}

/** Trim a value; collapse blanks to null so empty cells stay empty. */
function clean(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

/** Split untrusted values into a clean column payload (unknown keys dropped). */
function toPayload(values: PayrollWizardNoteValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of PAYROLL_WIZARD_NOTE_FIELDS) {
    if (f in values) out[f] = clean(values[f]);
  }
  // Emails are matched case-insensitively everywhere else — store them lowered.
  if (typeof out.worker_email === "string") out.worker_email = out.worker_email.toLowerCase();
  if ("done" in values) out.done = values.done === true;
  return out;
}

/** Every note as a per-clerk board: grouped by Payroll Clerk (A→Z), open
 *  items before done ones within a clerk, then oldest-first. */
export async function listPayrollWizardNotes(): Promise<{
  rows: PayrollWizardNoteRow[];
  error: string | null;
}> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .order("payroll_clerk", { ascending: true })
    .order("done", { ascending: true })
    .order("created_at", { ascending: true })
    .range(0, 1999);
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as PayrollWizardNoteRow[], error: null };
}

/** Insert ONE note. Blank rows are allowed — "Add Row" creates an empty line
 *  the clerk fills in place, exactly like the spreadsheet did. Every added row
 *  is stamped with the current payroll week (the seeded blanks are not — they
 *  get their stamp when first filled in, see updatePayrollWizardNote). */
export async function insertPayrollWizardNote(
  values: PayrollWizardNoteValues,
  opts: { createdBy?: string | null } = {},
): Promise<{ row: PayrollWizardNoteRow | null; error: string | null }> {
  const sb = client();
  const payload = {
    ...toPayload(values),
    week_start: manilaWeekStart(),
    created_by: clean(opts.createdBy)?.toLowerCase() ?? null,
  };
  const { data, error } = await sb.from(TABLE).insert(payload).select("*").single();
  if (error) return { row: null, error: error.message };
  return { row: data as PayrollWizardNoteRow, error: null };
}

/** Update ONE note by id, touching only the fields the caller sent. */
export async function updatePayrollWizardNote(
  id: string,
  values: PayrollWizardNoteValues,
): Promise<{ row: PayrollWizardNoteRow | null; error: string | null }> {
  const rowId = clean(id);
  if (!rowId) return { row: null, error: "A row id is required." };
  const payload = toPayload(values);
  if (Object.keys(payload).length === 0) return { row: null, error: "Nothing to update." };
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .update(payload)
    .eq("id", rowId)
    .select("*")
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  if (!data) return { row: null, error: "That note no longer exists — it may have just been deleted." };

  // A blank seeded line gets its week stamp the moment it stops being blank —
  // the week it was WRITTEN, not the week its empty shell was seeded. (Never
  // re-stamped afterwards, so later edits/ticks don't move a note between weeks.)
  let row = data as PayrollWizardNoteRow;
  if (row.week_start === null && !isBlankNoteRow(row)) {
    const { data: stamped } = await sb
      .from(TABLE)
      .update({ week_start: manilaWeekStart() })
      .eq("id", rowId)
      .is("week_start", null)
      .select("*")
      .maybeSingle();
    if (stamped) row = stamped as PayrollWizardNoteRow;
  }
  return { row, error: null };
}

// ── Per-clerk blank-row seeding (the spreadsheet's "empty lines ready") ──────

/** How many blank rows each edit-granted clerk should always have waiting. */
const BLANK_ROWS_PER_CLERK = 5;

/** A seeded/unused line: nothing filled in yet and not ticked Done. */
function isBlankNoteRow(
  r: Pick<PayrollWizardNoteRow, "note_date" | "worker" | "adjustment" | "notes" | "done">,
): boolean {
  return (
    !r.done &&
    clean(r.note_date) === null &&
    clean(r.worker) === null &&
    clean(r.adjustment) === null &&
    clean(r.notes) === null
  );
}

/**
 * "First Last" from a master-list Name, which may be stored surname-first as
 * `Surname[ Suffix], Given... "GoBy"` (see src/lib/name/display-name.ts).
 * The quoted go-by is dropped; a plain "First Last" passes through unchanged.
 */
function firstLastFromMasterName(raw: string): string {
  const s = raw.replace(/"[^"]*"/g, "").replace(/\s+/g, " ").trim();
  const comma = s.indexOf(",");
  if (comma < 0) return s;
  const surname = s.slice(0, comma).trim();
  const given = s.slice(comma + 1).trim();
  return given ? `${given} ${surname}` : surname;
}

/** Readable fallback when someone isn't on the master list: "jan.kane" → "Jan Kane". */
function nameFromEmail(email: string): string {
  return email
    .split("@")[0]!
    .split(/[._-]+/)
    .filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join(" ");
}

/**
 * The ONE name a clerk goes by on the board: their master-list "First Last",
 * falling back to `fallbackName` (e.g. the session's Google name) and finally
 * a prettified email prefix. Add Row and the per-clerk seeding both resolve
 * through here — if they disagreed (Google says "Kane R", the master list says
 * "Jan Kane Reroma"), a clerk's added rows would land in a second section.
 */
export async function resolvePayrollClerkName(
  email: string | null | undefined,
  fallbackName?: string | null,
): Promise<string> {
  const norm = clean(email)?.toLowerCase() ?? "";
  if (!norm) return clean(fallbackName) ?? "";
  // One targeted row lookup — never page the whole roster for a single email
  // (Add Row sits on this path, so it must stay snappy).
  try {
    const sb = client();
    const { data } = await sb
      .from("active_employees")
      .select('"Name"')
      .ilike("Work Email", norm)
      .limit(1)
      .maybeSingle();
    const name = (data as { Name?: string | null } | null)?.Name?.trim();
    if (name) return firstLastFromMasterName(name);
  } catch {
    /* fall through to the fallbacks */
  }
  return clean(fallbackName) ?? nameFromEmail(norm);
}

/** Everyone with an ACTIVE `edit` grant on accounting/payroll_wizard (the
 *  clerks the Admin provisioned), lower-cased and de-duped.
 *
 *  A grant alone is NOT enough: the person must also hold at least one ACTIVE
 *  dashboard role. Grid grants can outlive their purpose (granted directly in
 *  the Admin permission grid, the role never given / later removed — e.g. a
 *  whole-dashboard `edit` provisioned by hand and forgotten), and without the
 *  role the person can't even open /accounting. Seeding board rows for such
 *  ghost clerks would be pure noise. */
export async function listPayrollWizardEditorEmails(): Promise<{
  emails: string[];
  error: string | null;
}> {
  const sb = client();
  const { data, error } = await sb
    .from("employee_feature_permissions")
    .select("work_email")
    .eq("view_key", "accounting")
    .eq("feature", "payroll_wizard")
    .eq("access", "edit")
    .is("revoked_at", null);
  if (error) return { emails: [], error: error.message };
  const granted = [
    ...new Set(
      ((data ?? []) as { work_email: string | null }[])
        .map((r) => clean(r.work_email)?.toLowerCase() ?? "")
        .filter(Boolean),
    ),
  ];
  if (granted.length === 0) return { emails: [], error: null };

  const { data: roleRows, error: roleErr } = await sb
    .from("employee_roles")
    .select("work_email")
    .in("work_email", granted)
    .is("revoked_at", null);
  if (roleErr) return { emails: [], error: roleErr.message };
  const withRole = new Set(
    ((roleRows ?? []) as { work_email: string | null }[]).map(
      (r) => clean(r.work_email)?.toLowerCase() ?? "",
    ),
  );
  return { emails: granted.filter((e) => withRole.has(e)), error: null };
}

/**
 * Top every edit-granted clerk up to {@link BLANK_ROWS_PER_CLERK} blank rows
 * (stamped with their real "First Last" name), so the board always has empty
 * lines ready — like the spreadsheet — without anyone clicking Add Row.
 *
 * Cheap when nothing is missing: the caller passes the rows it already
 * fetched, and the master-list name lookup only runs if a top-up is actually
 * needed. Returns whether anything was inserted so the caller can re-list.
 */
export async function ensurePayrollWizardNoteSeeds(
  existingRows: PayrollWizardNoteRow[],
): Promise<{ seeded: boolean; error: string | null }> {
  const { emails, error: emailsErr } = await listPayrollWizardEditorEmails();
  if (emailsErr) return { seeded: false, error: emailsErr };
  if (emails.length === 0) return { seeded: false, error: null };

  const blanksBy = new Map<string, PayrollWizardNoteRow[]>(emails.map((e) => [e, []]));
  for (const r of existingRows) {
    const owner = clean(r.created_by)?.toLowerCase();
    if (!owner || !blanksBy.has(owner) || !isBlankNoteRow(r)) continue;
    blanksBy.get(owner)!.push(r);
  }

  // Self-heal a double-seed: two simultaneous board loads can each top a clerk
  // up before seeing the other's inserts. Surplus BLANK rows (beyond the target,
  // newest first — the oldest ids are the ones clients already render) are
  // deleted; blank-only, so nobody's typed content is ever touched.
  const sb = client();
  const surplus = [...blanksBy.values()].flatMap((blanks) =>
    blanks
      .slice()
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(BLANK_ROWS_PER_CLERK)
      .map((r) => r.id),
  );
  if (surplus.length > 0) {
    const { error: trimErr } = await sb.from(TABLE).delete().in("id", surplus);
    if (trimErr) return { seeded: false, error: trimErr.message };
  }

  const needy = emails.filter(
    (e) => Math.min(blanksBy.get(e)?.length ?? 0, BLANK_ROWS_PER_CLERK) < BLANK_ROWS_PER_CLERK,
  );
  if (needy.length === 0) return { seeded: surplus.length > 0, error: null };

  // Resolve real names only when we actually have rows to create.
  const nameByEmail = new Map<string, string>();
  const { people } = await listActiveMasterListPeople();
  for (const p of people) {
    if (p.work_email && p.name) nameByEmail.set(p.work_email.toLowerCase(), firstLastFromMasterName(p.name));
  }

  const inserts: Record<string, unknown>[] = [];
  for (const email of needy) {
    const missing =
      BLANK_ROWS_PER_CLERK - Math.min(blanksBy.get(email)?.length ?? 0, BLANK_ROWS_PER_CLERK);
    const name = nameByEmail.get(email) ?? nameFromEmail(email);
    for (let i = 0; i < missing; i++) {
      inserts.push({ payroll_clerk: name, created_by: email });
    }
  }
  const { error } = await sb.from(TABLE).insert(inserts);
  if (error) return { seeded: false, error: error.message };
  return { seeded: true, error: null };
}

// ── Worker suggestions (Global Master List + recently offboarded) ───────────

/** One pickable person for the board's Worker cell. */
export type PayrollWorkerOption = {
  /** "First Last" display name (master-list surname-first form unwound). */
  name: string;
  department: string | null;
  work_email: string | null;
  /** Set ONLY for recently offboarded people (ISO timestamp) — they're off the
   *  active master list but still need Last Pay handling on the board. */
  off_boarded_at: string | null;
};

/** How far back "recently offboarded" reaches. Last pays settle within a few
 *  payroll cycles; 90 days is a generous ceiling without dredging the full
 *  3000-row offboard history into every picker load. */
const OFFBOARDED_LOOKBACK_DAYS = 90;

/**
 * Everyone the Worker cell should suggest: the active Global Master List
 * (A→Z), plus people offboarded in the last {@link OFFBOARDED_LOOKBACK_DAYS}
 * days (newest first) — offboarded folks drop off `active_employees`, but
 * their Last Pays are exactly what the board tracks. A person on both lists
 * (re-hired) counts as active. The offboarded read is best-effort: if it
 * fails, the active list alone still serves the picker.
 */
export async function listPayrollWorkerOptions(): Promise<{
  workers: PayrollWorkerOption[];
  error: string | null;
}> {
  const { people, error: activeErr } = await listActiveMasterListPeople();
  if (activeErr) return { workers: [], error: activeErr };

  const byKey = new Map<string, PayrollWorkerOption>();
  for (const p of people) {
    const display = firstLastFromMasterName(p.name);
    if (!display) continue;
    const key = display.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      // Same human on the list under several departments — one suggestion.
      if (p.department && existing.department && !existing.department.includes(p.department)) {
        existing.department += ` / ${p.department}`;
      } else if (!existing.department) {
        existing.department = p.department;
      }
      if (!existing.work_email) existing.work_email = p.work_email;
    } else {
      byKey.set(key, {
        name: display,
        department: p.department,
        work_email: p.work_email,
        off_boarded_at: null,
      });
    }
  }

  const sb = client();
  const since = new Date(Date.now() - OFFBOARDED_LOOKBACK_DAYS * 86_400_000).toISOString();
  const { data: off } = await sb
    .from("offboarded_sheet")
    .select("name, department, work_email, off_boarded_at")
    .gte("off_boarded_at", since)
    .order("off_boarded_at", { ascending: false })
    .range(0, 499);
  for (const r of (off ?? []) as {
    name: string | null;
    department: string | null;
    work_email: string | null;
    off_boarded_at: string | null;
  }[]) {
    const display = firstLastFromMasterName((r.name ?? "").trim());
    if (!display) continue;
    const key = display.toLowerCase();
    if (byKey.has(key)) continue; // re-hired — already suggested as active
    byKey.set(key, {
      name: display,
      department: clean(r.department),
      work_email: clean(r.work_email)?.toLowerCase() ?? null,
      off_boarded_at: r.off_boarded_at,
    });
  }

  return { workers: [...byKey.values()], error: null };
}

/**
 * "First Last" for a worker by work email — like {@link resolvePayrollClerkName}
 * but offboarding-aware: someone in their Last Pay week has already left
 * `active_employees`, so the offboarded sheet is checked next. Falls back to
 * the caller-provided name, then a prettified email prefix.
 */
async function resolveWorkerDisplayName(
  email: string,
  fallbackName?: string | null,
): Promise<string> {
  const sb = client();
  try {
    const { data } = await sb
      .from("active_employees")
      .select('"Name"')
      .ilike("Work Email", email)
      .limit(1)
      .maybeSingle();
    const name = (data as { Name?: string | null } | null)?.Name?.trim();
    if (name) return firstLastFromMasterName(name);
  } catch {
    /* fall through */
  }
  try {
    const { data } = await sb
      .from("offboarded_sheet")
      .select("name")
      .ilike("work_email", email)
      .order("off_boarded_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const name = (data as { name?: string | null } | null)?.name?.trim();
    if (name) return firstLastFromMasterName(name);
  } catch {
    /* fall through */
  }
  return clean(fallbackName) ?? nameFromEmail(email);
}

// ── Wizard → board adjustment bridge ─────────────────────────────────────────

/**
 * Mirror a wizard Additions "Adj." override onto the notes board, so the two
 * surfaces hold the adjustment together (the other direction — board → wizard
 * — is a pull: the wizard pre-fills its Adj. cells from open board rows).
 *
 * Targets the LIVE week's row for that worker (matched on worker_email, open
 * rows first, newest last-written): updates its Adjustment text, or creates a
 * fresh stamped row when the worker has none this week. Clearing the override
 * (amount=null) clears the linked row's Adjustment text but never deletes the
 * row — the trail of "someone touched this worker's pay" stays on the board.
 */
export async function bridgeWizardAdjustment(params: {
  workEmail: string;
  amount: number | null;
  /** Session identity — the created row's clerk stamp and owner. */
  sessionEmail: string | null;
  sessionName?: string | null;
  /** Display name for a fresh row when the master list doesn't know the email. */
  workerName?: string | null;
}): Promise<{ row: PayrollWizardNoteRow | null; created: boolean; error: string | null }> {
  const email = clean(params.workEmail)?.toLowerCase();
  if (!email) return { row: null, created: false, error: "A worker email is required." };

  const sb = client();
  const week = manilaWeekStart();
  const { data: existing, error: findErr } = await sb
    .from(TABLE)
    .select("*")
    .eq("worker_email", email)
    .eq("week_start", week)
    .order("done", { ascending: true })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (findErr) return { row: null, created: false, error: findErr.message };

  const adjustment = params.amount === null ? null : formatAdjustmentText(params.amount);

  if (existing) {
    const { data, error } = await sb
      .from(TABLE)
      .update({ adjustment })
      .eq("id", (existing as PayrollWizardNoteRow).id)
      .select("*")
      .maybeSingle();
    if (error) return { row: null, created: false, error: error.message };
    return { row: (data ?? existing) as PayrollWizardNoteRow, created: false, error: null };
  }

  // Clearing an override the board never heard about needs no row; nor does a
  // bare 0 (the wizard's "—" click opens the input with a 0 placeholder — only
  // an EXISTING linked row should mirror an explicit zero).
  if (adjustment === null || params.amount === 0) return { row: null, created: false, error: null };

  // A fresh board line, shaped exactly like one the clerk would have written.
  const [clerk, worker] = await Promise.all([
    resolvePayrollClerkName(params.sessionEmail, params.sessionName),
    resolveWorkerDisplayName(email, params.workerName),
  ]);
  const { data, error } = await sb
    .from(TABLE)
    .insert({
      note_date: manilaMonthDayStamp(),
      payroll_clerk: clerk,
      worker,
      worker_email: email,
      adjustment,
      notes: "Adjustment set in the Payroll Wizard (Additions tab).",
      week_start: week,
      created_by: clean(params.sessionEmail)?.toLowerCase() ?? null,
    })
    .select("*")
    .single();
  if (error) return { row: null, created: false, error: error.message };
  return { row: data as PayrollWizardNoteRow, created: true, error: null };
}

/** Delete notes by id (one or many). When `ownedBy` is given, only rows that
 *  person created are deleted (owner-only delete) — the rest are left alone
 *  and counted in `denied`. Returns how many were deleted. */
export async function deletePayrollWizardNotes(
  ids: string[],
  opts: { ownedBy?: string | null } = {},
): Promise<{ deleted: number; denied: number; error: string | null }> {
  const cleanIds = [...new Set(ids.map((i) => (i ?? "").trim()).filter(Boolean))];
  if (cleanIds.length === 0) return { deleted: 0, denied: 0, error: null };
  const sb = client();
  const owner = clean(opts.ownedBy)?.toLowerCase() ?? null;

  let query = sb.from(TABLE).delete().in("id", cleanIds);
  if (owner) query = query.eq("created_by", owner);
  const { data, error } = await query.select("id");
  if (error) return { deleted: 0, denied: 0, error: error.message };
  const deleted = (data ?? []).length;
  return { deleted, denied: cleanIds.length - deleted, error: null };
}
