/**
 * Rates & Profiles — CSV export builder.
 *
 * Combines the rates-summary roster with master-list (home address, start date,
 * Google photo) and employee_ids (bank / payment processor) into a single flat
 * row per employee. Column order is grouped by section — identity → comp →
 * address → contact → payment → media — so the export reads naturally in Excel
 * and Google Sheets.
 *
 * No per-week history (disbursement_records, payment_dispatches) is included —
 * this is a "current state" snapshot of who's on the roster and how they're paid.
 */

import type { EmployeeRow } from '@/lib/supabase/employees';
import type { EmployeeIdRow } from '@/lib/supabase/employee-ids';

/** Minimum shape a Rates summary row needs to provide. Keeps the helper portable
 *  whether called with the local or the lib's `EmployeeRateProfileSummary`. */
export type RatesExportSummary = {
  id: string;
  displayName: string;
  department: string | null;
  organization: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  employeeId: string | null;
  regularRate: string | null;
  otRate: string | null;
  suspended: boolean;
  hasRatesRow: boolean;
  profilePhotoUrl: string | null;
  googlePhotoUrl: string | null;
};

/** Output column definitions — `header` is the human-readable name written to
 *  row 1 of the CSV; `key` matches the field name on the row object below. The
 *  ORDER of this array IS the column order in the file. */
const COLUMNS: { key: string; header: string }[] = [
  // ── Identity (1–7) ──
  { key: 'employee_id',           header: 'Employee ID' },
  { key: 'name',                  header: 'Name' },
  { key: 'work_email',            header: 'Work Email' },
  { key: 'personal_email',        header: 'Personal Email' },
  { key: 'department',            header: 'Department' },
  { key: 'organization',          header: 'Organization' },
  { key: 'start_date',            header: 'Start Date' },

  // ── Status (8–9) ──
  { key: 'status',                header: 'Status' },
  { key: 'has_rates_row',         header: 'Has Rates Row' },

  // ── Compensation (10–11) ──
  { key: 'regular_rate',          header: 'Regular Rate (PHP/hr)' },
  { key: 'ot_rate',               header: 'OT Rate (PHP/hr)' },

  // ── Address (12–16) ──
  { key: 'street',                header: 'Street' },
  { key: 'city',                  header: 'City' },
  { key: 'province',              header: 'Province' },
  { key: 'postal_code',           header: 'Postal Code' },
  { key: 'full_address',          header: 'Full Address' },

  // ── Contact (17) ──
  { key: 'phone_number',          header: 'Phone Number' },

  // ── Payment routing (18–19) ──
  { key: 'preferred_processor',   header: 'Preferred Processor' },
  { key: 'preferred_bank_slot',   header: 'Preferred Bank Slot' },

  // ── Per-channel emails / handles (20–25) ──
  { key: 'hurupay_email',         header: 'HuruPay Email' },
  { key: 'wepay_email',           header: 'WePay Email' },
  { key: 'higlobe_email',         header: 'HiGlobe Email' },
  { key: 'higlobe_account_name',  header: 'HiGlobe Account Name' },
  { key: 'wise_email',            header: 'Wise Email' },
  { key: 'wise_tag',              header: 'Wise Tag' },

  // ── Wire / bank — primary (26–30) ──
  { key: 'primary_bank_name',     header: 'Primary Bank Name' },
  { key: 'primary_account_holder', header: 'Primary Account Holder' },
  { key: 'primary_account_number', header: 'Primary Account Number' },
  { key: 'primary_swift',         header: 'Primary SWIFT/BIC' },
  { key: 'primary_routing',       header: 'Primary Routing Number' },

  // ── Wire / bank — alternate (31–34) ──
  { key: 'alt_bank_name',         header: 'Alt Bank Name' },
  { key: 'alt_account_holder',    header: 'Alt Account Holder' },
  { key: 'alt_account_number',    header: 'Alt Account Number' },
  { key: 'alt_routing',           header: 'Alt Routing Number' },

  // ── Media (35–36) ──
  { key: 'profile_photo_url',     header: 'Profile Photo URL' },
  { key: 'google_photo_url',      header: 'Google Photo URL' },
];

type ExportRow = Record<string, string>;

function lc(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/** Build the flat per-employee rows by joining summaries with master + ids by email. */
export function buildExportRows(
  summaries: RatesExportSummary[],
  masterRows: EmployeeRow[],
  idRows: EmployeeIdRow[],
): ExportRow[] {
  const masterByEmail = new Map<string, EmployeeRow>();
  for (const e of masterRows) {
    const we = lc(e.work_email);
    const pe = lc(e.personal_email);
    if (we) masterByEmail.set(we, e);
    if (pe && !masterByEmail.has(pe)) masterByEmail.set(pe, e);
  }

  const idsByEmail = new Map<string, EmployeeIdRow>();
  for (const r of idRows) {
    const we = lc(r.work_email);
    const pe = lc(r.personal_email);
    if (we) idsByEmail.set(we, r);
    if (pe && !idsByEmail.has(pe)) idsByEmail.set(pe, r);
  }

  return summaries.map((p) => {
    const we = lc(p.workEmail);
    const pe = lc(p.personalEmail);
    const master =
      (we && masterByEmail.get(we)) ||
      (pe && masterByEmail.get(pe)) ||
      null;
    const ids =
      (we && idsByEmail.get(we)) ||
      (pe && idsByEmail.get(pe)) ||
      null;

    return {
      // Identity
      employee_id: p.employeeId ?? master?.employee_id ?? '',
      name: p.displayName ?? master?.name ?? '',
      work_email: p.workEmail ?? master?.work_email ?? '',
      personal_email: p.personalEmail ?? master?.personal_email ?? '',
      department: p.department ?? master?.department ?? '',
      organization: p.organization ?? '',
      start_date: master?.start_date ?? '',

      // Status
      status: p.suspended ? 'Suspended' : 'Active',
      has_rates_row: p.hasRatesRow ? 'Yes' : 'No',

      // Compensation
      regular_rate: p.regularRate ?? '',
      ot_rate: p.otRate ?? '',

      // Home address (from global_master_list)
      street: master?.street ?? '',
      city: master?.city ?? '',
      province: master?.province ?? '',
      postal_code: master?.postal_code ?? '',
      full_address: master?.full_address ?? '',

      // Contact
      phone_number: ids?.phone_number ?? '',

      // Payment routing
      preferred_processor: ids?.preferred_processor ?? '',
      preferred_bank_slot: ids?.preferred_bank_slot ?? '',

      // Per-channel
      hurupay_email: ids?.hurupay_email ?? '',
      wepay_email: ids?.wepay_email ?? '',
      higlobe_email: ids?.higlobe_email ?? '',
      higlobe_account_name: ids?.higlobe_account_name ?? '',
      wise_email: ids?.wise_email ?? '',
      wise_tag: ids?.wise_tag ?? '',

      // Wire — primary
      primary_bank_name: ids?.bank_name ?? '',
      primary_account_holder: ids?.account_holder_name ?? '',
      primary_account_number: ids?.account_number ?? '',
      primary_swift: ids?.swift_code ?? '',
      primary_routing: ids?.routing_number ?? '',

      // Wire — alt
      alt_bank_name: ids?.alt_bank_name ?? '',
      alt_account_holder: ids?.alt_account_holder_name ?? '',
      alt_account_number: ids?.alt_account_number ?? '',
      alt_routing: ids?.alt_routing_number ?? '',

      // Media
      profile_photo_url: p.profilePhotoUrl ?? '',
      google_photo_url: p.googlePhotoUrl ?? '',
    };
  });
}

/** Serialize a value to a CSV-safe string. RFC 4180 quoting:
 *  - Wrap in double-quotes if the value contains a comma, quote, CR, or LF
 *  - Double any internal quotes */
function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Build the CSV text body. Prepends a UTF-8 BOM so Excel auto-detects UTF-8
 *  and renders accented characters / em-dashes correctly. */
export function rowsToCsv(rows: ExportRow[]): string {
  const headerLine = COLUMNS.map((c) => csvEscape(c.header)).join(',');
  const dataLines = rows.map((row) =>
    COLUMNS.map((c) => csvEscape(row[c.key])).join(','),
  );
  return '﻿' + [headerLine, ...dataLines].join('\r\n');
}

/** Trigger a browser download of the CSV. Uses an in-memory Blob URL so we
 *  don't roundtrip the bytes through a server. */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof window === 'undefined') return;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke a tick so Safari has time to begin the download.
  setTimeout(() => URL.revokeObjectURL(url), 200);
}

/** Today's date as YYYY-MM-DD, for filename suffixes. */
export function todayFilenameSuffix(): string {
  return new Date().toISOString().slice(0, 10);
}
