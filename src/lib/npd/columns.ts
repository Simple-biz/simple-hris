/**
 * NPD (Accounting → New Payroll Dashboard) — the two sheets and their columns.
 *
 * Each sheet's column list is EXACTLY the header row Accounting pasted from the
 * Google Sheet it replaces (Kane, 2026-10-01), in the same order, and each `key`
 * is the column of that sheet's row table in
 * references/sql/create/2026-10-01_npd_sheets.sql. The SQL, this file and the
 * apply script's column counts (30 / 32) move together.
 *
 * Headers keep the sheet's line breaks, so the grid's header row reads like the
 * sheet's. Two typos in the pasted headers are corrected on screen only:
 * "Conversoin" → "Conversion", "Perfornance" → "Performance". The paste-header
 * detector still recognises the misspelt forms (see `headerAliases`).
 *
 * Isomorphic and dependency-free: the route validates against it and the grid
 * renders from it.
 */

export const NPD_SHEETS = ['all_departments', 'hsl'] as const;
export type NpdSheetKind = (typeof NPD_SHEETS)[number];

export function isNpdSheetKind(v: unknown): v is NpdSheetKind {
  return v === 'all_departments' || v === 'hsl';
}

export const NPD_SHEET_LABELS: Record<NpdSheetKind, string> = {
  all_departments: 'All Departments',
  hsl: 'HSL',
};

export type NpdColumn = {
  /** Column name in the sheet's row table. */
  readonly key: string;
  /** Header as the sheet shows it, line breaks included. */
  readonly header: string;
  /** Other spellings a pasted header row may carry (the sheet's own typos). */
  readonly headerAliases?: readonly string[];
  /** Rendered width in px. */
  readonly width: number;
  /** Figures read right-aligned, like the sheet. Display only — cells stay text. */
  readonly align?: 'right';
};

const W_EMAIL = 230;
const W_NAME = 180;
const W_TEXT = 150;
const W_NOTE = 240;
const W_NUM = 104;
const W_FLAG = 96;

const C = {
  workEmail: { key: 'work_email', header: 'Work Email', width: W_EMAIL },
  name: { key: 'name', header: 'Name', width: W_NAME },
  department: { key: 'department', header: 'Department', width: W_TEXT },
  mesaParticipant: { key: 'mesa_participant', header: 'MESA\nParticipant', width: W_FLAG },
  position: { key: 'position', header: 'Position', width: W_TEXT },
  week: { key: 'week', header: 'Week', width: 140 },
  hoursUntilOt: { key: 'hours_until_ot', header: 'Hours Until OT', width: W_NUM, align: 'right' },
  orphanTotalHours: { key: 'orphan_total_hours', header: 'Orphan Total Hours', width: W_NUM, align: 'right' },
  orphanHoursTotalPay: { key: 'orphan_hours_total_pay', header: 'Orphan Hours Total Pay', width: W_NUM + 8, align: 'right' },
  midweekNewRateTotalHours: {
    key: 'midweek_new_rate_total_hours',
    header: 'Mid-week\nNew\nRate\nTotal\nHours',
    width: W_NUM,
    align: 'right',
  },
  notesHourlyRateChanges: { key: 'notes_hourly_rate_changes', header: 'Notes for hourly\nrate changes', width: W_NOTE },
  totalHourlyPay: { key: 'total_hourly_pay', header: 'Total\nHourly\nPay', width: W_NUM + 8, align: 'right' },
  mesaContribution: { key: 'mesa_contribution', header: 'MESA\nContribution\n(100PHP)', width: W_NUM + 8, align: 'right' },
  techBonus: { key: 'tech_bonus', header: 'Tech\nBonus', width: W_NUM, align: 'right' },
  attendanceBonus: { key: 'attendance_bonus', header: 'Attendance\nBonus', width: W_NUM, align: 'right' },
  performanceBonus: {
    key: 'performance_bonus',
    header: 'Performance\nBonus',
    headerAliases: ['Perfornance\nBonus'],
    width: W_NUM + 8,
    align: 'right',
  },
  additionalBonus: { key: 'additional_bonus', header: 'Additional\nBonus or\nUS Bonus', width: W_NUM + 8, align: 'right' },
  notesBonuses: { key: 'notes_bonuses', header: 'Notes explaining\nbonuses', width: W_NOTE },
  totalPayPhp: { key: 'total_pay_php', header: 'Total Pay\nPHP', width: W_NUM + 16, align: 'right' },
  phpUsdConversion: {
    key: 'php_usd_conversion',
    header: 'PHP\nUSD\nConversion',
    headerAliases: ['PHP\nUSD\nConversoin'],
    width: W_NUM + 8,
    align: 'right',
  },
  totalPayUsWorkers: { key: 'total_pay_us_workers', header: 'Total Pay\nUS\nWorkers', width: W_NUM + 8, align: 'right' },
  last4: { key: 'last4_preferred_acct', header: 'Last 4 of\npreferred\nacct #', width: W_FLAG },
  sendingBankUsed: { key: 'sending_bank_used', header: 'Sending\nbank used', width: W_TEXT },
  hris: { key: 'hris', header: 'HRIS', width: W_FLAG },
} satisfies Record<string, NpdColumn>;

/** Accounting's "All Dept." header row — 30 columns. */
const ALL_DEPARTMENTS_COLUMNS: readonly NpdColumn[] = [
  C.workEmail,
  C.name,
  C.department,
  C.mesaParticipant,
  C.position,
  C.week,
  { key: 'regular_total_hours', header: 'Regular\nTotal\nHours', width: W_NUM, align: 'right' },
  { key: 'regular_rate', header: 'Regular\nRate', width: W_NUM, align: 'right' },
  { key: 'ot_total_hours', header: 'OT\nTotal\nHours', width: W_NUM, align: 'right' },
  { key: 'ot_rate', header: 'OT\nRate', width: W_NUM, align: 'right' },
  C.hoursUntilOt,
  C.orphanTotalHours,
  C.orphanHoursTotalPay,
  C.midweekNewRateTotalHours,
  { key: 'midweek_new_hourly_rate', header: 'Mid-week\nNew\nHourly\nRate', width: W_NUM, align: 'right' },
  C.notesHourlyRateChanges,
  C.totalHourlyPay,
  C.mesaContribution,
  C.techBonus,
  C.attendanceBonus,
  C.performanceBonus,
  C.additionalBonus,
  C.notesBonuses,
  C.totalPayPhp,
  C.phpUsdConversion,
  C.totalPayUsWorkers,
  { key: 'bank_preferred', header: 'Bank preferred', width: W_TEXT },
  C.last4,
  C.sendingBankUsed,
  C.hris,
];

/** Accounting's HSL header row — 32 columns. */
const HSL_COLUMNS: readonly NpdColumn[] = [
  C.workEmail,
  C.name,
  C.department,
  C.mesaParticipant,
  C.position,
  C.week,
  { key: 'mf_total_hours', header: 'M-F\nTotal Hours', width: W_NUM, align: 'right' },
  { key: 'mf_rate', header: 'M-F\nRate', width: W_NUM, align: 'right' },
  { key: 'we_hours', header: 'WE Hours', width: W_NUM, align: 'right' },
  { key: 'hogan_we_rate', header: 'Hogan\nWE\nRate', width: W_NUM, align: 'right' },
  { key: 'total_ot_hours', header: 'Total OT Hours', width: W_NUM, align: 'right' },
  { key: 'ot_differential', header: 'OT\nDifferential', width: W_NUM + 8, align: 'right' },
  C.hoursUntilOt,
  C.orphanTotalHours,
  C.orphanHoursTotalPay,
  C.midweekNewRateTotalHours,
  {
    key: 'midweek_transition_hourly_rate',
    header: 'Mid-week\nTransition\nHourly\nRate',
    width: W_NUM + 8,
    align: 'right',
  },
  C.notesHourlyRateChanges,
  C.totalHourlyPay,
  C.mesaContribution,
  C.techBonus,
  C.attendanceBonus,
  C.performanceBonus,
  C.additionalBonus,
  C.notesBonuses,
  C.totalPayPhp,
  C.phpUsdConversion,
  C.totalPayUsWorkers,
  { key: 'bank_preferred', header: 'Bank\npreferred', width: W_TEXT },
  C.last4,
  C.sendingBankUsed,
  C.hris,
];

export const NPD_COLUMNS: Record<NpdSheetKind, readonly NpdColumn[]> = {
  all_departments: ALL_DEPARTMENTS_COLUMNS,
  hsl: HSL_COLUMNS,
};

/** Row table per sheet. Read by the server only; listed here so the two names live beside their columns. */
export const NPD_ROW_TABLES: Record<NpdSheetKind, string> = {
  all_departments: 'npd_all_departments_rows',
  hsl: 'npd_hsl_rows',
};

/** Header text for matching a pasted header row: case, spacing and punctuation ignored. */
export function normalizeHeaderText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
