import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "./server";

/**
 * View in Supabase that filters `global_master_list` down to rows whose
 * `last_seen_upload_id` matches the current `master_list_uploads` entry. Created by
 * the upload-archive migration (2026-04-22). This is the authoritative "who is active
 * right now" roster.
 */
const ACTIVE_EMPLOYEES_VIEW = "active_employees";

/** Normalized row for the UI (snake_case internally). */
export type EmployeeRow = {
  employee_id: string | null;
  department: string | null;
  name: string | null;
  personal_email: string | null;
  /** Work / company email from the "Work Email" column in global_master_list.
   *  Used as a secondary lookup key when personal_email matching fails. */
  work_email?: string | null;
  start_date: string | null;
  hourlyRate?: number | null;
  bankInfo?: {
    accountName: string | null;
    accountNumber: string | null;
    bankName: string | null;
    routingNumber: string | null;
  } | null;
  /** Flat address fields added 2026-05-02 — sourced from global_master_list columns
   *  street / city / province / postal_code / full_address (backfilled from payroll sheet). */
  street?: string | null;
  city?: string | null;
  province?: string | null;
  postal_code?: string | null;
  full_address?: string | null;
  /** Public URL from Supabase Storage when set (see references/supabase_employee_profile_photos.sql). */
  profile_photo_url?: string | null;
  /** Google Workspace profile picture URL — populated by NextAuth jwt callback on sign-in
   *  (see src/lib/auth/auth-options.ts). Used as the FIRST avatar source. */
  google_photo_url?: string | null;
  /** When this employee also appears in the synced HSL roster (`active_hsl_agents`),
   *  carries their narrower role-within-HSL string (e.g. "Case Manager",
   *  "Intake Specialist Manager", "Filing Specialist Asst TL").
   *  Populated server-side by routes that opt in to the HSL join, e.g.
   *  `/api/manager/department-members`. Other consumers leave it `undefined`. */
  hsl_role?: string | null;
  /** HSL-specific hourly rate (₱), pulled from `hsl_team_members.hourly_rate`
   *  via the `active_hsl_agents` view. Same opt-in surface as `hsl_role`. */
  hsl_hourly_rate?: number | null;
  /** HSL-specific overtime rate (₱). */
  hsl_ot_rate?: number | null;
  /** Payroll hourly rate, pulled from `employee_hourly_rates` by email for manager roster views. */
  regular_rate?: number | null;
  /** Payroll overtime rate, pulled from `employee_hourly_rates` by email for manager roster views. */
  ot_rate?: number | null;
  /** MESA Program member flag — ₱100 deducted from every paycheck when true. */
  mesa_member?: boolean | null;
};

type RawRow = Record<string, unknown>;

function pick(row: RawRow, keys: string[]): unknown {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      const v = row[k];
      if (v !== undefined && v !== null) return v;
    }
  }
  return undefined;
}

/**
 * Maps `global_master_list` (and similar) column names to EmployeeRow.
 * Use exact PostgREST/JSON keys as string literals. Multi-line arrays are normal JS;
 * do not paste literal `\\n` or `\\"` into source — that caused the earlier parse error.
 * Column names are not “escaped” with \\n unless the DB column is literally named that way (it should not be).
 */
// ─── Employee ID generation ───────────────────────────────────────────────────

/**
 * Extracts the 4-character YYMM prefix from a start-date string.
 * Returns null when the date is absent or unparseable.
 */
function extractYYMM(startDate: string | null): string | null {
  if (!startDate) return null;
  const d = new Date(startDate);
  if (Number.isNaN(d.getTime())) return null;
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yy}${mm}`;
}

/** Returns the lower-cased first token of a full name (the "first name"). */
function getFirstName(name: string | null): string {
  if (!name) return "";
  return name.trim().split(/\s+/)[0].toLowerCase();
}

/**
 * Assigns employee_id to every row **in-place**.
 *
 * Algorithm:
 *  1. Group employees by YYMM derived from their start_date.
 *  2. Within each group, partition by who already has a persisted ID. Persisted
 *     IDs are NEVER changed — they're the stable identity (see
 *     references/add_employee_id_to_global_master_list.sql). The remaining
 *     un-numbered rows fill in the next available NNNN slots, sorted by first
 *     name (then full name as tie-breaker) for deterministic results.
 *  3. Assign serial numbers starting after the existing max within the bucket.
 *
 * Employees without a parseable start_date receive employee_id = null.
 *
 * Example: Kane, started 2025-11-10 → "2511-0001"
 */
export function generateEmployeeIds(employees: EmployeeRow[]): void {
  const groups = new Map<string, EmployeeRow[]>();

  for (const emp of employees) {
    const yymm = extractYYMM(emp.start_date);
    if (!yymm) {
      // Don't clobber a persisted ID even if start_date is unparseable now —
      // it may have been computed against a valid prior value.
      if (!emp.employee_id) emp.employee_id = null;
      continue;
    }
    if (!groups.has(yymm)) groups.set(yymm, []);
    groups.get(yymm)!.push(emp);
  }

  for (const [yymm, group] of groups) {
    // Highest NNNN already claimed in this bucket — new rows start one above.
    let maxSeq = 0;
    for (const emp of group) {
      if (!emp.employee_id) continue;
      const match = /^(\d{4})-(\d{4})$/.exec(emp.employee_id);
      if (match && match[1] === yymm) {
        const n = parseInt(match[2], 10);
        if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
      }
    }

    const unassigned = group.filter((e) => !e.employee_id);
    unassigned.sort((a, b) => {
      const firstCmp = getFirstName(a.name).localeCompare(
        getFirstName(b.name),
        undefined,
        { sensitivity: "base" },
      );
      if (firstCmp !== 0) return firstCmp;
      return (a.name ?? "").localeCompare(b.name ?? "", undefined, {
        sensitivity: "base",
      });
    });

    unassigned.forEach((emp, idx) => {
      emp.employee_id = `${yymm}-${String(maxSeq + idx + 1).padStart(4, "0")}`;
    });
  }
}

// ─── Row mapping ──────────────────────────────────────────────────────────────

export function mapEmployeeRow(row: RawRow): EmployeeRow {
  const employee_id = pick(row, ["employee_id", "Employee ID", "Employee_ID"]);
  const department = pick(row, ["Department", "department"]);
  const name = pick(row, ["Name", "name"]);
  const personal_email = pick(row, ["Personal Email", "personal_email", "Personal_Email", "personal email"]);
  const work_email = pick(row, ["Work Email", "work_email", "Work_Email", "work email", "WorkEmail"]);
  const start_date = pick(row, [
    "Start Date",
    "Start_date",
    "start_date",
    "StartDate",
    "start date",
  ]);
  const profile_photo_url = pick(row, [
    "Profile Photo URL",
    "profile_photo_url",
    "Profile_Photo_URL",
    "profile photo url",
  ]);
  const street = pick(row, ["street", "Street"]);
  const city = pick(row, ["city", "City"]);
  const province = pick(row, ["province", "Province"]);
  const postal_code = pick(row, ["postal_code", "Postal Code", "PostalCode", "postal"]);
  const full_address = pick(row, ["full_address", "Full Address", "FullAddress"]);
  const google_photo_url = pick(row, ["google_photo_url", "Google Photo URL", "google_picture"]);

  return {
    // Persisted YYMM-NNNN from global_master_list.employee_id. When the column
    // is null (legacy rows that pre-date the persistence migration), the value
    // stays null here and generateEmployeeIds() fills it in downstream.
    employee_id: employee_id != null ? String(employee_id).trim() || null : null,
    department: department != null ? String(department) : null,
    name: name != null ? String(name) : null,
    personal_email: personal_email != null ? String(personal_email) : null,
    work_email: work_email != null ? String(work_email) : null,
    start_date: start_date != null ? String(start_date) : null,
    hourlyRate: null,
    bankInfo: null,
    street: street != null ? String(street).trim() || null : null,
    city: city != null ? String(city).trim() || null : null,
    province: province != null ? String(province).trim() || null : null,
    postal_code: postal_code != null ? String(postal_code).trim() || null : null,
    full_address: full_address != null ? String(full_address).trim() || null : null,
    profile_photo_url:
      profile_photo_url != null ? String(profile_photo_url).trim() || null : null,
    google_photo_url:
      google_photo_url != null ? String(google_photo_url).trim() || null : null,
  };
}

/**
 * Table: public.global_master_list — columns:
 * - Department
 * - Name
 * - Personal Email
 * - Start Date
 * - Profile Photo URL (optional; add via references/supabase_employee_profile_photos.sql)
 *
 * Extended fields (Hourly Rate, bank info, address) live in separate tables
 * and are NOT selected here to avoid PostgREST "column does not exist" errors.
 */
/** Base columns that have always been on global_master_list. Safe to query whether or
 *  not the address-columns migration has run + the active_employees view recreated. */
const GLOBAL_MASTER_SELECT_BASE =
  'Department,Name,"Personal Email","Work Email","Start Date","Profile Photo URL"';

/** Includes the home-address columns added 2026-05-02, the Google SSO photo
 *  column added 2026-05-02, and the persisted employee_id column added
 *  2026-05-14. The active_employees view must be refreshed
 *  (see references/seed_global_master_list_addresses.sql,
 *  references/seed_global_master_list_google_photo.sql, and
 *  references/add_employee_id_to_global_master_list.sql) before this select
 *  shape resolves successfully against the view. */
const GLOBAL_MASTER_SELECT =
  GLOBAL_MASTER_SELECT_BASE +
  ',street,city,province,postal_code,full_address,google_photo_url,employee_id';

/** True when every field is null, empty, or whitespace-only. */
function isRowEmptyOrWhitespace(row: EmployeeRow): boolean {
  const parts = [row.department, row.name, row.personal_email, row.start_date].map(
    (v) => (v == null ? "" : String(v).trim()),
  );
  return parts.every((p) => p === "");
}

async function fetchActiveEmployees(
  supabase: NonNullable<ReturnType<typeof createSupabaseServerClient>>,
): Promise<{ employees: EmployeeRow[]; error: string | null }> {
  // Try the full select first (includes address columns added 2026-05-02). If the
  // active_employees view hasn't been refreshed since the ALTER TABLE, PostgREST
  // returns "column does not exist" — fall back to the base select so the dashboard
  // keeps working. Address fields are still served via /api/employee-master-record,
  // which queries global_master_list directly.
  // Paginate — PostgREST caps a single response at db.max-rows (1000 on this
  // project), so a bare .range(0, 9999) silently drops every employee past row
  // 1000 once the active roster grows beyond it (it feeds masterEmployees, the
  // Payroll Wizard's department source-of-truth + rate-match bridge). Loop until
  // a short page.
  const queryView = async (
    sel: string,
  ): Promise<{ data: RawRow[] | null; error: { message: string } | null }> => {
    const PAGE = 1000;
    const out: RawRow[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from(ACTIVE_EMPLOYEES_VIEW)
        .select(sel)
        .range(from, from + PAGE - 1);
      if (error) return { data: null, error };
      const page = (data ?? []) as unknown as RawRow[];
      out.push(...page);
      if (page.length < PAGE) break;
      from += PAGE;
    }
    return { data: out, error: null };
  };

  let res = await queryView(GLOBAL_MASTER_SELECT);
  let select = GLOBAL_MASTER_SELECT;
  if (res.error && /does not exist/i.test(res.error.message ?? "")) {
    res = await queryView(GLOBAL_MASTER_SELECT_BASE);
    select = GLOBAL_MASTER_SELECT_BASE;
  }

  if (res.error) {
    return { employees: [], error: res.error.message };
  }

  const raw = ((res.data ?? []) as unknown as RawRow[]).slice();

  // UNION in every US-prefixed employee from global_master_list. They were
  // seeded manually (migration #18) and aren't part of the Google Sheet master
  // sync, so the view's upload filter drops them on every re-sync — yet they
  // need to appear in Roles & Permissions, HR, and every other surface that
  // calls /api/employees. Identified by `employee_ids.employee_id LIKE 'US-%'`,
  // cross-referenced to master rows by Work/Personal Email. Deduped by id.
  const { data: usIds } = await supabase
    .from("employee_ids")
    .select("work_email, personal_email")
    .like("employee_id", "US-%");
  if (usIds && usIds.length > 0) {
    const usEmails = new Set<string>();
    for (const r of usIds as Array<{ work_email?: string | null; personal_email?: string | null }>) {
      const we = r.work_email?.trim();
      const pe = r.personal_email?.trim();
      if (we) usEmails.add(we);
      if (pe) usEmails.add(pe);
    }
    if (usEmails.size > 0) {
      const list = [...usEmails];
      const orClause = [
        `"Work Email".in.(${list.map((e) => `"${e}"`).join(",")})`,
        `"Personal Email".in.(${list.map((e) => `"${e}"`).join(",")})`,
      ].join(",");
      const { data: usMasters, error: usErr } = await supabase
        .from('global_master_list')
        .select(select)
        .or(orClause)
        .is("off_boarded_at", null);
      if (!usErr && usMasters) {
        const seen = new Set(
          raw.map((r) => (r as { id?: unknown }).id).filter((v) => v != null),
        );
        for (const r of usMasters as unknown as RawRow[]) {
          const id = (r as { id?: unknown }).id;
          if (id != null && seen.has(id)) continue;
          raw.push(r);
        }
      }
    }
  }

  const employees = raw
    .map(mapEmployeeRow)
    .filter((row) => !isRowEmptyOrWhitespace(row));

  employees.sort((a, b) => {
    const an = (a.name ?? "").trim();
    const bn = (b.name ?? "").trim();
    // Rows with no name sort to the bottom so “blank” rows are not at the top
    if (!an && bn) return 1;
    if (an && !bn) return -1;
    return an.localeCompare(bn, undefined, { sensitivity: "base" });
  });

  generateEmployeeIds(employees);
  return { employees, error: null };
}

/**
 * Looks up a single record from `global_master_list` by Work Email or Personal Email,
 * regardless of whether the row is in the current upload (i.e. visible in `active_employees`).
 *
 * Used as a fallback for the employee Profile page so identity (name, department, start
 * date, employee_id) still renders for people who fell off the latest master-list upload —
 * e.g. internal staff like devs who aren't part of the regular CSV reconciliation.
 *
 * Returns the most recent row (by `last_seen_upload_id` desc when multiple). The
 * employee_id is generated locally via the same yymm-NNNN scheme used by `getEmployees`,
 * but only against this single row — IDs aren't authoritative without the full roster context.
 */
export async function getEmployeeMasterRecord(
  email: string | null | undefined,
): Promise<{ employee: EmployeeRow | null; error: string | null }> {
  const target = email?.trim().toLowerCase();
  if (!target) return { employee: null, error: null };

  const supabase = createSupabaseServerClient();
  if (!supabase) {
    return {
      employee: null,
      error:
        "Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to your .env file.",
    };
  }

  // Query the underlying table (not the active view) so people who fell off the latest
  // upload still resolve. Try Work Email first, then Personal Email. Falls back to the
  // base select (no address columns) if the address migration hasn't been applied yet.
  const fullSelect = `${GLOBAL_MASTER_SELECT},last_seen_upload_id`;
  const baseSelect = `${GLOBAL_MASTER_SELECT_BASE},last_seen_upload_id`;
  const queryFor = async (column: string, sel: string) =>
    supabase
      .from('global_master_list')
      .select(sel)
      .ilike(column, target)
      .order('last_seen_upload_id', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

  const tryWith = async (sel: string) => {
    let r = await queryFor('"Work Email"', sel);
    if (!r.data && !r.error) {
      r = await queryFor('"Personal Email"', sel);
    }
    return r;
  };

  let res = await tryWith(fullSelect);
  if (res.error && /does not exist/i.test(res.error.message ?? "")) {
    res = await tryWith(baseSelect);
  }
  if (res.error) return { employee: null, error: res.error.message };
  if (!res.data) return { employee: null, error: null };

  const row = mapEmployeeRow(res.data as unknown as RawRow);
  if (isRowEmptyOrWhitespace(row)) return { employee: null, error: null };
  // Generate a single-row employee_id placeholder so the Profile can show "2511-0001" style.
  generateEmployeeIds([row]);
  return { employee: row, error: null };
}

export async function getEmployees(): Promise<{
  employees: EmployeeRow[];
  error: string | null;
}> {
  const supabase = createSupabaseServerClient();
  if (!supabase) {
    return {
      employees: [],
      error:
        "Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to your .env file.",
    };
  }
  return fetchActiveEmployees(supabase);
}

/**
 * Reads `active_employees` with the service role when configured so API routes used by
 * managers see the full roster even when RLS blocks the anon key. Falls back to the anon
 * client (same as {@link getEmployees}) if the service key is missing.
 */
export async function getEmployeesForAuthorizedServerRoute(): Promise<{
  employees: EmployeeRow[];
  error: string | null;
}> {
  const sr = createSupabaseServiceRoleClient();
  const supabase = sr ?? createSupabaseServerClient();
  if (!supabase) {
    return {
      employees: [],
      error:
        "Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to your .env file.",
    };
  }
  return fetchActiveEmployees(supabase);
}
