import { createSupabaseServerClient } from "./server";

/** Normalized payroll row from `hubstaff_hours` (flexible source columns). */
export type PayrollHubstaffRow = {
  email: string | null;
  name: string | null;
  department: string | null;
  hoursDecimal: number;
  hoursDisplay: string;
  overtimeDecimal: number;
  overtimeDisplay: string;
  initialized: boolean;
};

type RawRow = Record<string, unknown>;

function pick(row: RawRow, keys: string[]): unknown {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      const v = row[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
  }
  return undefined;
}

/** Parses Hubstaff-style durations (e.g. 40:02:44), H:MM, or a decimal hour number. */
export function parseHoursToDecimal(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const s = String(value).trim();
  if (!s) return 0;

  const hms = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(s);
  if (hms) {
    const h = parseInt(hms[1], 10);
    const m = parseInt(hms[2], 10);
    const sec = parseInt(hms[3], 10);
    return h + m / 60 + sec / 3600;
  }

  const hm = /^(\d+):(\d{1,2})$/.exec(s);
  if (hm) {
    return parseInt(hm[1], 10) + parseInt(hm[2], 10) / 60;
  }

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function formatHoursLabel(decimal: number): string {
  const totalMinutes = Math.round(decimal * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = Math.abs(totalMinutes % 60);
  return `${h}:${m.toString().padStart(2, "0")}`;
}

export function mapHubstaffHoursRow(row: RawRow): PayrollHubstaffRow {
  const emailRaw = pick(row, ["Email", "email", "user_email", "work_email"]);
  const email = emailRaw != null ? String(emailRaw).trim() : null;

  const nameRaw = pick(row, ["Member", "member", "name", "Name", "full_name", "employee_name"]);
  const departmentRaw = pick(row, [
    "Job type",
    "job_type",
    "Job Type",
    "department",
    "Department",
    "dept",
  ]);

  const hoursVal = pick(row, [
    "Total worked", // exact DB match found in logs
    "Total Worked", 
    "total worked",
    "total_worked",
    "hours_worked",
    "Hours",
    "hours",
    "total_hours",
  ]);
  const fallbackDecimal = pick(row, ["decimal_hours", "hours_decimal", "total_hours_decimal"]);
  const hoursDecimal =
    hoursVal !== undefined
      ? parseHoursToDecimal(hoursVal)
      : parseHoursToDecimal(fallbackDecimal);

  const hoursDisplay =
    hoursVal != null && String(hoursVal).trim() !== ""
      ? String(hoursVal).trim()
      : formatHoursLabel(hoursDecimal);

  const overtimeDecimal = Math.max(0, hoursDecimal - 40);
  const overtimeDisplay =
    overtimeDecimal > 0 ? formatHoursLabel(overtimeDecimal) : "—";

  return {
    email,
    name: nameRaw != null ? String(nameRaw).trim() : null,
    department: departmentRaw != null ? String(departmentRaw).trim() : null,
    hoursDecimal,
    hoursDisplay,
    overtimeDecimal,
    overtimeDisplay,
    initialized: Boolean(email && email.length > 0),
  };
}

/**
 * Table: public.hubstaff_hours — expects columns compatible with Hubstaff / daily report exports
 * (Email, Member, Job type, Total worked, etc.). Override with NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE.
 */
export async function getHubstaffHoursPayrollRows(): Promise<{
  rows: PayrollHubstaffRow[];
  error: string | null;
}> {
  const supabase = createSupabaseServerClient();
  if (!supabase) {
    return {
      rows: [],
      error:
        "Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to your .env file.",
    };
  }

  const table =
    process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() ||
    "hubstaff_hours";

  const { data, error } = await supabase.from(table).select("*");

  if (error) {
    return { rows: [], error: error.message };
  }

  const raw = (data ?? []) as RawRow[];
  const rows = raw.map(mapHubstaffHoursRow);

  rows.sort((a, b) => {
    const an = (a.name ?? a.email ?? "").trim();
    const bn = (b.name ?? b.email ?? "").trim();
    if (!an && bn) return 1;
    if (an && !bn) return -1;
    return an.localeCompare(bn, undefined, { sensitivity: "base" });
  });

  return { rows, error: null };
}
