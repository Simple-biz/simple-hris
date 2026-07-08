// New Hire Checklist -> multi-sheet Excel workbook export.
//
// Builds one .xlsx workbook with ONE SHEET PER WEEK, each sheet titled with its
// Sun-Sat week and listing that week's hires in the same column order as the HR
// tab. Used by /api/hr/new-hire-checklist/export for both "this week" (a single
// sheet) and "all weeks" (every week that has saved rows).
//
// Generated server-side (nodejs runtime) so the whole roster never has to be
// pulled down to the browser; the route streams the workbook back as a download.

import * as XLSX from "xlsx";
import {
  HR_NEW_HIRE_CHECKLIST_FIELDS,
  type HrNewHireChecklistField,
  type HrNewHireChecklistRow,
} from "@/lib/supabase/hr-new-hire-checklist";

/** Column headers, in the tab's display order (keyed 1:1 to the DB fields). */
const COLUMN_LABELS: Record<HrNewHireChecklistField, string> = {
  name: "Names",
  personal_email: "Personal Email",
  location: "Location",
  phone_number: "Phone Number",
  date_of_interview: "Date of Interview",
  source: "Source",
  referred_by: "Referred By",
  hired_by: "Hired By",
  department: "Department",
  country: "Country",
};

/** Per-column widths (chars) so the sheet is readable without manual resizing. */
const COLUMN_WIDTHS: Record<HrNewHireChecklistField, number> = {
  name: 22,
  personal_email: 28,
  location: 18,
  phone_number: 16,
  date_of_interview: 16,
  source: 16,
  referred_by: 20,
  hired_by: 18,
  department: 18,
  country: 16,
};

export type ExportWeek = {
  periodStart: string;
  periodEnd?: string | null;
  status?: "open" | "locked";
  rows: HrNewHireChecklistRow[];
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "Jun 28 - Jul 4, 2026" for a Sun-anchored week start (server-locale-free so
 *  UTC vs Manila can't shift the day). */
export function formatWeekRangeLabel(startIso: string): string {
  const [y, m, d] = startIso.split("-").map(Number);
  if (!y || !m || !d) return startIso;
  // Build the Saturday end from the raw parts (day arithmetic, no timezone).
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(Date.UTC(y, m - 1, d + 6));
  const sM = MONTHS[start.getUTCMonth()];
  const eM = MONTHS[end.getUTCMonth()];
  return `${sM} ${start.getUTCDate()} - ${eM} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
}

/** True when a row carries any data (skip fully-blank grid rows). */
function rowHasData(r: HrNewHireChecklistRow): boolean {
  return HR_NEW_HIRE_CHECKLIST_FIELDS.some((f) => ((r[f] ?? "") as string).trim() !== "");
}

/** A valid, unique Excel sheet name: <=31 chars, none of []:*?/\, de-duped. */
function safeSheetName(desired: string, used: Set<string>): string {
  const base = (desired.replace(/[[\]:*?/\\]/g, " ").trim() || "Week").slice(0, 31);
  let name = base;
  let i = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${i++})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

/**
 * Build the workbook. Each week becomes its own sheet — a title row (week label +
 * hire count + lock state), a blank spacer, a header row, then one row per hire.
 * Weeks are added in the order given (the route sorts newest-first).
 */
export function buildNewHireChecklistWorkbook(weeks: ExportWeek[]): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  const headers = HR_NEW_HIRE_CHECKLIST_FIELDS.map((f) => COLUMN_LABELS[f]);

  if (weeks.length === 0) {
    const ws = XLSX.utils.aoa_to_sheet([["No hires have been recorded yet."]]);
    XLSX.utils.book_append_sheet(wb, ws, "New Hires");
    return wb;
  }

  for (const wk of weeks) {
    const label = formatWeekRangeLabel(wk.periodStart);
    const filled = wk.rows.filter(rowHasData);
    const countText = `${filled.length} hire${filled.length === 1 ? "" : "s"}`;
    const status = wk.status === "locked" ? " · Locked" : "";

    const aoa: (string | number)[][] = [
      [`New Hire Checklist — ${label}`],
      [`${countText}${status}`],
      [],
      ["#", ...headers],
    ];
    filled.forEach((r, i) => {
      aoa.push([i + 1, ...HR_NEW_HIRE_CHECKLIST_FIELDS.map((f) => (r[f] ?? "") as string)]);
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [
      { wch: 4 },
      ...HR_NEW_HIRE_CHECKLIST_FIELDS.map((f) => ({ wch: COLUMN_WIDTHS[f] })),
    ];
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(label, used));
  }

  return wb;
}

/** Serialize the workbook to .xlsx bytes (Node Buffer) for a file response. */
export function workbookToBuffer(wb: XLSX.WorkBook): Buffer {
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
