import { createSupabaseServerClient } from "./server";

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
  address?: {
    street: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    country: string | null;
  } | null;
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
 *  2. Within each group sort alphabetically by first name (then full name as
 *     a tie-breaker so the result is stable).
 *  3. Assign serial numbers 001, 002, … in that order.
 *
 * Employees without a parseable start_date receive employee_id = null.
 *
 * Example: Kane, started 2025-11-10 → "2511-001"
 */
export function generateEmployeeIds(employees: EmployeeRow[]): void {
  const groups = new Map<string, EmployeeRow[]>();

  for (const emp of employees) {
    const yymm = extractYYMM(emp.start_date);
    if (!yymm) {
      emp.employee_id = null;
      continue;
    }
    if (!groups.has(yymm)) groups.set(yymm, []);
    groups.get(yymm)!.push(emp);
  }

  for (const [yymm, group] of groups) {
    group.sort((a, b) => {
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

    group.forEach((emp, idx) => {
      emp.employee_id = `${yymm}-${String(idx + 1).padStart(4, "0")}`;
    });
  }
}

// ─── Row mapping ──────────────────────────────────────────────────────────────

export function mapEmployeeRow(row: RawRow): EmployeeRow {
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

  return {
    employee_id: null, // populated later by generateEmployeeIds
    department: department != null ? String(department) : null,
    name: name != null ? String(name) : null,
    personal_email: personal_email != null ? String(personal_email) : null,
    work_email: work_email != null ? String(work_email) : null,
    start_date: start_date != null ? String(start_date) : null,
    hourlyRate: null,
    bankInfo: null,
    address: null,
  };
}

/**
 * Table: public.global_master_list — columns:
 * - Department
 * - Name
 * - Personal Email
 * - Start Date
 *
 * Extended fields (Hourly Rate, bank info, address) live in separate tables
 * and are NOT selected here to avoid PostgREST "column does not exist" errors.
 */
const GLOBAL_MASTER_SELECT = 'Department,Name,"Personal Email","Work Email","Start Date"';

/** True when every field is null, empty, or whitespace-only. */
function isRowEmptyOrWhitespace(row: EmployeeRow): boolean {
  const parts = [row.department, row.name, row.personal_email, row.start_date].map(
    (v) => (v == null ? "" : String(v).trim()),
  );
  return parts.every((p) => p === "");
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

  const table =
    process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() ||
    "global_master_list";

  const { data, error } = await supabase
    .from(table)
    .select(GLOBAL_MASTER_SELECT);

  if (error) {
    return { employees: [], error: error.message };
  }

  const raw = (data ?? []) as RawRow[];
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

  // Assign YYMM-SSS IDs after sorting so the display order is stable
  generateEmployeeIds(employees);

  return { employees, error: null };
}
