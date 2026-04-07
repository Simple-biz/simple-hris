import { normEmail } from "@/lib/email/norm-email";
import { createSupabaseServerClient } from "./server";

export type EmployeeIdRow = {
  employee_id: string;
  name: string;
  work_email: string | null;
  personal_email: string | null;
};

export async function getEmployeeIds(): Promise<{
  rows: EmployeeIdRow[];
  error: string | null;
}> {
  const supabase = createSupabaseServerClient();
  if (!supabase) {
    return { rows: [], error: "Supabase client not initialised." };
  }

  const { data, error } = await supabase
    .from("employee_ids")
    .select("employee_id, name, work_email, personal_email")
    .order("employee_id");

  if (error) return { rows: [], error: error.message };

  const rows = ((data ?? []) as EmployeeIdRow[]).filter(
    (r) => r.employee_id && r.name,
  );
  return { rows, error: null };
}

/**
 * Builds a map of normalised email → employee_id.
 * Both work_email and personal_email are indexed so any email match
 * from the profile will resolve to the correct ID.
 */
export function buildEmployeeIdMap(rows: EmployeeIdRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    const we = normEmail(r.work_email ?? "");
    const pe = normEmail(r.personal_email ?? "");
    if (we) map.set(we, r.employee_id);
    if (pe && !map.has(pe)) map.set(pe, r.employee_id);
  }
  return map;
}
