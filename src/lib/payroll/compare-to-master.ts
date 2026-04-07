import { normEmail } from "@/lib/email/norm-email";
import type { EmployeeRow } from "@/lib/supabase/employees";
import type { HubstaffRow } from "@/types";

export { normEmail };

export type PayrollMasterComparison = {
  /** Distinct Personal Emails on the global master list (non-empty). */
  totalOnMaster: number;
  /** Master-list employees with Total worked &gt; 0 in the uploaded hours file (matched by email, case-insensitive). */
  withHoursThisWeek: number;
  /** Master-list employees with no row or zero hours in the file. */
  missingHoursCount: number;
  /** File rows with hours whose email is not on the master list. */
  notOnMasterWithHoursInCsv: number;
  /** Sample of master emails missing hours (for UI table). */
  missingHoursSample: string[];
};

/**
 * Compares Hubstaff / daily-report rows to `global_master_list` (Personal Email).
 */
export function comparePayrollToMaster(
  employees: EmployeeRow[],
  hubstaffRows: HubstaffRow[],
): PayrollMasterComparison {
  const masterEmails = new Set<string>();
  for (const e of employees) {
    const em = normEmail(e.personal_email);
    if (em) masterEmails.add(em);
  }
  const totalOnMaster = masterEmails.size;

  const hoursByEmail = new Map<string, number>();
  for (const r of hubstaffRows) {
    const em = normEmail(r.email);
    if (!em) continue;
    const prev = hoursByEmail.get(em) ?? 0;
    hoursByEmail.set(em, Math.max(prev, r.decimalHours));
  }

  let withHoursThisWeek = 0;
  const missing: string[] = [];
  for (const em of masterEmails) {
    const h = hoursByEmail.get(em) ?? 0;
    if (h > 1e-6) withHoursThisWeek++;
    else missing.push(em);
  }
  missing.sort((a, b) => a.localeCompare(b));

  let notOnMasterWithHoursInCsv = 0;
  for (const [em, h] of hoursByEmail) {
    if (!masterEmails.has(em) && h > 1e-6) notOnMasterWithHoursInCsv++;
  }

  return {
    totalOnMaster,
    withHoursThisWeek,
    missingHoursCount: totalOnMaster - withHoursThisWeek,
    notOnMasterWithHoursInCsv,
    missingHoursSample: missing.slice(0, 75),
  };
}
