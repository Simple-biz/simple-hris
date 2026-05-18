import { normEmail } from "@/lib/email/norm-email";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "./server";

export type EmployeeHourlyRateRow = {
  work_email: string | null;
  personal_email: string | null;
  regular_rate: string | null;
  ot_rate: string | null;
  /** From "Department" on the rates row — used for payroll / routing; not used for employee Profile employment. */
  department: string | null;
  /** Payment-dispatch fields, seeded from the All Dept payroll CSV. */
  bank_preferred: string | null;
  hurupay_email: string | null;
  higlobe_email: string | null;
  higlobe_account_name: string | null;
  phone_number: string | null;
  full_address: string | null;
  city: string | null;
  province_state: string | null;
  /** MESA Program member — ₱100 deducted from every paycheck when true. */
  mesa_member: boolean | null;
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
  const bank_preferred = getField(idx, [
    "Bank Preferred",
    "bank_preferred",
    "Bank preferred",
    "BankPreferred",
  ]);
  const hurupay_email = getField(idx, [
    "Hurupay Email",
    "hurupay_email",
    "HuruPay Email Account",
    "Hurupay Email Account",
  ]);
  const higlobe_email = getField(idx, [
    "HiGlobe Email",
    "higlobe_email",
    "HiGlobe  Email",
    "Higlobe Email",
  ]);
  const higlobe_account_name = getField(idx, [
    "HiGlobe Account Name",
    "higlobe_account_name",
    "HiGlobe \nAccount Name",
    "Higlobe Account Name",
  ]);
  const phone_number = getField(idx, [
    "Phone Number",
    "phone_number",
    "phone",
    "Phone",
  ]);
  const full_address = getField(idx, [
    "Full Address",
    "full_address",
    "Full\nAddress",
    "address",
  ]);
  const city = getField(idx, ["City", "city"]);
  const province_state = getField(idx, [
    "Province/State",
    "province_state",
    "Province /State",
    "Province\n/State",
    "province",
  ]);

  const mesa_member_raw = getField(idx, ['mesa_member', 'Mesa Member', 'MESA Member', 'mesa member']);

  return {
    work_email: toStr(work_email),
    personal_email: toStr(personal_email),
    regular_rate: toStr(regular_rate),
    ot_rate: toStr(ot_rate),
    department: toStr(department),
    bank_preferred: toStr(bank_preferred),
    hurupay_email: toStr(hurupay_email),
    higlobe_email: toStr(higlobe_email),
    higlobe_account_name: toStr(higlobe_account_name),
    phone_number: toStr(phone_number),
    full_address: toStr(full_address),
    city: toStr(city),
    province_state: toStr(province_state),
    mesa_member: mesa_member_raw === true || mesa_member_raw === 'true' ? true
      : mesa_member_raw === false || mesa_member_raw === 'false' ? false
      : null,
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

  // Prefer the deduplicated view (`employee_hourly_rates_current`) — one row
  // per email, picked by latest upload_id then created_at. See
  // references/create_employee_hourly_rates_current_view.sql. The full
  // history table only has ~2660 distinct emails out of ~9000 rows, so the
  // view drops the payload ~70% and avoids the pagination dance below.
  //
  // If the view doesn't exist (e.g. before the migration is run, or after
  // running drop_employee_hourly_rates_current_view.sql to revert), we fall
  // back to the original paginated read of the base table — no app deploy
  // needed to revert.
  const VIEW_NAME = "employee_hourly_rates_current";
  const viewResult = await supabase
    .from(VIEW_NAME)
    .select("*")
    .range(0, 4999);
  if (!viewResult.error) {
    const rows = ((viewResult.data ?? []) as RawRow[])
      .map(mapEmployeeHourlyRateRow)
      .filter((row) => !isRowEmpty(row));
    return { rows, error: null };
  }

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

/**
 * Server-side single-row lookup by email — used by the employee portal so it
 * doesn't have to download the entire rates table just to find itself.
 * Matches on `"Work Email"` first, then `"Personal Email"` (case-insensitive).
 */
export async function getEmployeeHourlyRateRowByEmail(
  email: string,
): Promise<{ row: EmployeeHourlyRateRow | null; error: string | null }> {
  const target = email.trim();
  if (!target) return { row: null, error: null };

  const supabase =
    createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return {
      row: null,
      error:
        "Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to your .env file.",
    };
  }

  const table =
    process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() ||
    "employee_hourly_rates";

  const tryColumn = async (col: string) =>
    supabase.from(table).select("*").ilike(col, target).limit(1).maybeSingle();

  let res = await tryColumn('"Work Email"');
  if (!res.data && !res.error) {
    res = await tryColumn('"Personal Email"');
  }
  if (res.error) return { row: null, error: res.error.message };
  if (!res.data) return { row: null, error: null };

  const mapped = mapEmployeeHourlyRateRow(res.data as RawRow);
  return { row: isRowEmpty(mapped) ? null : mapped, error: null };
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
