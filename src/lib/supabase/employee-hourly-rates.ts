import { normEmail } from "@/lib/email/norm-email";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "./server";

export type EmployeeHourlyRateRow = {
  work_email: string | null;
  personal_email: string | null;
  regular_rate: string | null;
  ot_rate: string | null;
  /** Primary department source — populated from the "Department" column in
   *  employee_hourly_rates. When present this overrides the global_master_list
   *  department lookup entirely. */
  department: string | null;
};

type RawRow = Record<string, unknown>;

function normCol(k: string): string {
  return k.toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
}

function indexRowKeys(row: RawRow): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) {
    const variants = [
      normCol(k),
      k.toLowerCase(),
      k.toLowerCase().replace(/\s+/g, ""),
      k.toLowerCase().replace(/\s+/g, "_"),
    ];
    for (const variant of variants) {
      m.set(variant, v);
    }
  }
  return m;
}

function getField(idx: Map<string, unknown>, aliases: string[]): unknown {
  for (const a of aliases) {
    const candidates = [
      normCol(a),
      a.toLowerCase(),
      a.toLowerCase().replace(/\s+/g, ""),
      a.toLowerCase().replace(/\s+/g, "_"),
    ];
    for (const c of candidates) {
      if (!idx.has(c)) continue;
      const v = idx.get(c);
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
  }
  return undefined;
}

function toStr(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export function mapEmployeeHourlyRateRow(row: RawRow): EmployeeHourlyRateRow {
  const idx = indexRowKeys(row);
  const work_email = getField(idx, [
    "Work Email",
    "work_email",
    "Work_Email",
    "workEmail",
  ]);
  const personal_email = getField(idx, [
    "Personal Email",
    "personal_email",
    "Personal_Email",
    "personalEmail",
  ]);
  const regular_rate = getField(idx, [
    "Regular Rate",
    "regular_rate",
    "Regular_Rate",
    "regular rate",
  ]);
  const ot_rate = getField(idx, [
    "OT Rate",
    "ot_rate",
    "OT_Rate",
    "ot rate",
    "Ot Rate",
  ]);
  const department = getField(idx, [
    "Department",
    "department",
    "dept",
    "Dept",
  ]);

  return {
    work_email: toStr(work_email),
    personal_email: toStr(personal_email),
    regular_rate: toStr(regular_rate),
    ot_rate: toStr(ot_rate),
    department: toStr(department),
  };
}

function isRowEmpty(row: EmployeeHourlyRateRow): boolean {
  return Object.values(row).every((v) => v == null || String(v).trim() === "");
}

/**
 * Hubstaff work email (normalized) → rate row. Indexes Work Email; also Personal Email when present.
 */
export function indexHourlyRatesByEmail(rows: EmployeeHourlyRateRow[]): Map<string, EmployeeHourlyRateRow> {
  const m = new Map<string, EmployeeHourlyRateRow>();
  for (const r of rows) {
    const w = normEmail(r.work_email);
    const p = normEmail(r.personal_email);
    if (w) m.set(w, r);
    if (p) m.set(p, r);
  }
  return m;
}

export async function getEmployeeHourlyRatesRows(): Promise<{
  rows: EmployeeHourlyRateRow[];
  error: string | null;
}> {
  const supabase =
    createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return {
      rows: [],
      error:
        "Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to your .env file.",
    };
  }

  const table =
    process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() ||
    "employee_hourly_rates";

  // PostgREST silently caps `.select("*")` at 1000 rows by default. The rates
  // table now exceeds that (multi-upload history), so we paginate to pull
  // everything. Without this, employees near the end of the table (by internal
  // id order) were missing from the Payroll Wizard's rate lookup.
  const PAGE = 1000;
  const raw: RawRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(from, from + PAGE - 1);
    if (error) return { rows: [], error: error.message };
    const page = (data ?? []) as RawRow[];
    raw.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }

  const rows = raw.map(mapEmployeeHourlyRateRow).filter((row) => !isRowEmpty(row));
  return { rows, error: null };
}

export async function updateEmployeeRates(params: {
  workEmail?: string | null;
  personalEmail?: string | null;
  regularRate: string;
  otRate: string;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { error: "Supabase client not initialized" };
  }

  const table =
    process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() ||
    "employee_hourly_rates";

  const { workEmail, personalEmail, regularRate, otRate } = params;

  // We update by work_email if available, otherwise by personal_email.
  // Using actual column names with spaces as observed in the table.
  let query = supabase.from(table).update({
    "Regular Rate": regularRate,
    "OT Rate": otRate,
  });

  if (workEmail) {
    query = query.eq("Work Email", workEmail);
  } else if (personalEmail) {
    query = query.eq("Personal Email", personalEmail);
  } else {
    return { error: "No email provided for identification" };
  }

  const { error } = await query;
  if (error) return { error: error.message };

  return { error: null };
}
