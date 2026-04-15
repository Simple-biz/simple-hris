"use client";

import React, { useState, useRef, useEffect, useMemo, useTransition } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Check, 
  Upload, 
  Calculator, 
  ShieldCheck, 
  Send, 
  AlertCircle,
  Lock,
  ArrowRight,
  ArrowLeft,
  Trash2,
  Loader2,
  DollarSign,
  FileText,
  ChevronRight,
  CalendarDays,
  X,
  Info,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { MOCK_USERS, MOCK_TIME_RECORDS, MOCK_PAYMENTS } from '@/constants';
import { User, TimeRecord, PaymentLineItem, HubstaffRow, ReconciliationIssue } from '@/types';
import { parseHoursToDecimal } from '@/lib/supabase/hubstaff-hours';
import {
  groupDateColumnsByCalendarDay,
  pickPreferredHubstaffColumn,
  getPabMonthRange,
  inferPabMonthFromColumns,
  filterColumnGroupsByPabRange,
  countMonFriInclusiveInRange,
  resolveCanonicalColumnsToIso,
  columnsAreAllCanonical,
  parseDateRangeFromFilename,
  getLatestPabMonthFromColumns,
} from '@/lib/hubstaff/calendar-column-dedupe';
import type { EmployeeRow } from '@/lib/supabase/employees';
import { parseCsv } from '@/lib/csv/parse-csv';
import {
  indexHourlyRatesByEmail,
  type EmployeeHourlyRateRow,
} from '@/lib/supabase/employee-hourly-rates';
import { normEmail } from '@/lib/email/norm-email';
import { sortHubstaffColumnsForDisplay } from '@/lib/supabase/hubstaff-hours-db';
import { comparePayrollToMaster } from '@/lib/payroll/compare-to-master';
import {
  phpHourlyPayFromSeconds,
  roundWorkedHoursForPay,
  splitRegularOvertimeSeconds,
} from '@/lib/payroll/money-php';
import {
  OFFICIAL_USD_TO_PHP_RATE,
  PHILIPPINE_PESO_OFFICIAL,
  USD_TO_PHP_DECIMAL_SHIFT,
  effectiveUsdToPhpRateFromStored,
} from '@/lib/fx/usd-php';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

function findHeaderColumn(header: string[], ...labels: string[]): number {
  const norm = header.map((h) => h.trim().toLowerCase());
  for (const label of labels) {
    const l = label.trim().toLowerCase();
    const i = norm.indexOf(l);
    if (i >= 0) return i;
  }
  return -1;
}

function buildHubstaffDataFromParsedGrid(grid: string[][]): HubstaffRow[] {
  if (grid.length < 2) return [];
  const header = grid[0].map((h) => h.trim());
  const emailIdx = findHeaderColumn(header, 'Email', 'Work email', 'Work Email');
  const totalIdx = findHeaderColumn(
    header,
    'Total worked',
    'Total Worked',
    'Worked time',
    'Time worked',
    'Total hours',
    'Total Hours',
  );
  const memberIdx = findHeaderColumn(header, 'Member');
  const totalHoursIdx = findHeaderColumn(header, 'Total hours', 'Total Hours');
  // "Job type" is the Hubstaff column that holds the department/team name
  const jobTypeIdx = findHeaderColumn(header, 'Job type', 'Job Type', 'job_type', 'Department', 'department');
  const projectIdx = findHeaderColumn(header, 'Project');

  // Weekly summary format: has Email + Total worked
  const isWeeklyFormat = emailIdx >= 0 && totalIdx >= 0;
  // Daily report format: has Member + Total hours (no Email column)
  const isDailyFormat = memberIdx >= 0 && totalHoursIdx >= 0;

  if (!isWeeklyFormat && !isDailyFormat) return [];

  const parsedData: HubstaffRow[] = [];

  if (isWeeklyFormat) {
    for (let r = 1; r < grid.length; r++) {
      const row = grid[r];
      const email = (row[emailIdx] ?? '').trim();
      if (!email) continue;
      const totalCell = row[totalIdx] ?? '';
      const member = memberIdx >= 0 ? (row[memberIdx] ?? '').trim() : '';
      const jobType = jobTypeIdx >= 0 ? (row[jobTypeIdx] ?? '').trim() || null : null;
      parsedData.push({
        name: member || email,
        email,
        hours: String(totalCell).trim(),
        decimalHours: parseHoursToDecimal(totalCell),
        department: jobType,
      });
    }
  } else {
    // Daily format: aggregate total hours per member (member name is the key)
    const memberTotals = new Map<string, { hours: number; dept: string | null }>();
    for (let r = 1; r < grid.length; r++) {
      const row = grid[r];
      const member = (row[memberIdx] ?? '').trim();
      if (!member) continue;
      const totalCell = row[totalHoursIdx] ?? '';
      const hours = parseHoursToDecimal(totalCell);
      const dept = projectIdx >= 0 ? (row[projectIdx] ?? '').trim() || null : null;
      const existing = memberTotals.get(member);
      if (existing) {
        existing.hours += hours;
        if (!existing.dept && dept) existing.dept = dept;
      } else {
        memberTotals.set(member, { hours, dept });
      }
    }
    for (const [member, data] of memberTotals) {
      const h = Math.floor(data.hours);
      const m = Math.round((data.hours - h) * 60);
      parsedData.push({
        name: member,
        email: '',
        hours: `${h}:${String(m).padStart(2, '0')}`,
        decimalHours: data.hours,
        department: data.dept,
      });
    }
  }

  return parsedData;
}

function buildReconciliationIssues(parsedData: HubstaffRow[], userList: User[]): ReconciliationIssue[] {
  const newIssues: ReconciliationIssue[] = [];
  parsedData.forEach((row) => {
    const user = userList.find((u) => u.hubstaffEmail === row.email || u.email === row.email);
    if (!user) {
      newIssues.push({
        type: 'UNMATCHED_EMAIL',
        email: row.email,
        description: `Unmatched Hubstaff email: ${row.email}`,
      });
    } else if (!user.bankInfo) {
      newIssues.push({
        type: 'MISSING_BANK_INFO',
        workerId: user.id,
        description: `Missing bank info for ${user.name}`,
      });
    }
  });
  return newIssues;
}

function formatHubstaffCell(value: unknown): string {
  if (value == null || value === '') return '—';
  if (typeof value === 'object' && !(value instanceof Date)) {
    try {
      return JSON.stringify(value);
    } catch {
      return '—';
    }
  }
  return String(value);
}

/**
 * Parses a Hubstaff duration string (H:MM:SS, H:MM, or decimal hours) to total seconds
 * using pure integer arithmetic — no floating-point division, so no rounding drift.
 */
function rawValueToTotalSeconds(value: unknown): number {
  if (value == null) return 0;
  const s = String(value).trim();
  if (!s) return 0;

  const hms = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
  if (hms) {
    return parseInt(hms[1], 10) * 3600
         + parseInt(hms[2], 10) * 60
         + parseInt(hms[3], 10);
  }

  const hm = /^(\d+):(\d{2})$/.exec(s);
  if (hm) {
    return parseInt(hm[1], 10) * 3600 + parseInt(hm[2], 10) * 60;
  }

  const dec = parseFloat(s);
  return Number.isFinite(dec) ? Math.round(dec * 3600) : 0;
}

/** Formats a non-negative second count as H:MM:SS (or H:MM when seconds are zero). */
function formatSeconds(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  return s > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${h}:${mm}`;
}

/**
 * Priority-ordered column preferences for the Step 1 preview table.
 * Keys must match actual Supabase/CSV column names (case-sensitive, then case-insensitive fallback via pickPreviewValue).
 */
const HUBSTAFF_PREFERRED_COLS: { key: string; label: string }[] = [
  { key: 'Member',        label: 'Member' },
  { key: 'Email',         label: 'Work Email' },
  { key: 'Total worked',  label: 'Total Worked' },
  { key: '__overtime__',  label: 'Overtime Hours' },
  { key: 'Activity',      label: 'Activity' },
  { key: 'Spent total',   label: 'Spent Total' },
  { key: 'Organization',  label: 'Organization' },
  { key: 'Time zone',     label: 'Time Zone' },
];

const MAX_PREVIEW_COLS = 8;

/** Internal DB columns that shouldn't be shown to the user in data tables. */
const HIDDEN_COLS = new Set(['id', 'source_file']);

/** Build preview columns from the actual Supabase column list, preferring known-useful ones first. */
function buildPreviewCols(allCols: string[]): { key: string; label: string }[] {
  const colSet = new Set(allCols);
  const result: { key: string; label: string }[] = [];
  // Add preferred columns that actually exist in the table.
  // __overtime__ is a computed column — always include it if Total worked is present.
  const hasTotalWorked = colSet.has('Total worked');
  for (const pref of HUBSTAFF_PREFERRED_COLS) {
    if (pref.key === '__overtime__') {
      if (hasTotalWorked) result.push(pref);
    } else if (colSet.has(pref.key)) {
      result.push(pref);
    }
    if (result.length >= MAX_PREVIEW_COLS) break;
  }
  // Fill remaining slots with any other columns not already included
  if (result.length < MAX_PREVIEW_COLS) {
    const used = new Set(result.map((c) => c.key));
    for (const col of allCols) {
      if (!used.has(col) && !HIDDEN_COLS.has(col)) {
        result.push({ key: col, label: col });
        if (result.length >= MAX_PREVIEW_COLS) break;
      }
    }
  }
  return result;
}

/**
 * Build ALL columns for the uploaded file detail view (no column limit).
 * Hides internal DB columns (id, source_file) and puts preferred columns first,
 * followed by remaining columns in their original order.
 */
function buildFullCols(allCols: string[]): { key: string; label: string }[] {
  const colSet = new Set(allCols);
  const result: { key: string; label: string }[] = [];
  const used = new Set<string>();

  // Preferred columns first (in priority order)
  const hasTotalWorked = colSet.has('Total worked');
  for (const pref of HUBSTAFF_PREFERRED_COLS) {
    if (pref.key === '__overtime__') {
      if (hasTotalWorked) { result.push(pref); used.add(pref.key); }
    } else if (colSet.has(pref.key)) {
      result.push(pref); used.add(pref.key);
    }
  }

  // All remaining columns (preserving original order), excluding hidden + already used
  for (const col of allCols) {
    if (!used.has(col) && !HIDDEN_COLS.has(col)) {
      result.push({ key: col, label: col });
    }
  }
  return result;
}

/**
 * Normalize a name for comparison by extracting unique alphabetic tokens, sorting,
 * and joining. Handles "Last, First" vs "First Last" vs 'Last, First "Nick"'.
 * e.g. 'Arrieta, Ace "Ace"' → 'ace arrieta'  |  'Ace Arrieta' → 'ace arrieta'
 */
function normalizeNameTokens(name: string): string {
  const tokens = name
    .toLowerCase()
    .replace(/["'()]/g, '')
    .replace(/,/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 0);
  return [...new Set(tokens)].sort().join(' ');
}

function pickPreviewValue(row: Record<string, unknown>, key: string): string {
  // Try exact key first, then case-insensitive
  if (Object.prototype.hasOwnProperty.call(row, key)) return formatHubstaffCell(row[key]);
  const lower = key.toLowerCase();
  for (const k of Object.keys(row)) {
    if (k.toLowerCase() === lower) return formatHubstaffCell(row[k]);
  }
  return '—';
}

type CalcRow = {
  email: string;
  name: string;
  totalHours: number;
  regularHours: number;
  otHours: number;
  regularRate: number | null;
  otRate: number | null;
  regularPay: number | null;
  otPay: number | null;
  initialPay: number | null;
};

type PayPeriodPayload = {
  currency: 'PHP';
  hubstaff_source_file: string | null;
  /** Latest weekly pay-period range (ISO dates) derived from the source file or Hubstaff columns. */
  week: { start: string; end: string } | null;
  pab_evaluation: { month_label: string; range_start: string; range_end: string };
};

type DispatchEmployee = {
  name: string;
  email: string;
  personal_email: string;
  pay_period: PayPeriodPayload;
  department_key: string | null;
  department_name: string | null;
  hours: { total: number; regular: number; ot: number };
  rates_php: { regular: number | null; ot: number | null };
  pay_php: {
    regular: number | null;
    ot: number | null;
    initial: number | null;
    bonuses_total: number;
    perfect_attendance_bonus: number;
    tech_bonus: number;
    other_bonuses: number;
    final: number;
  };
};

function formatPHP(n: number): string {
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseRateField(v: string | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/,/g, '');
  if (s === '') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

const COMMON_BONUSES: { id: string; label: string; amount: number }[] = [
  { id: 'tech_bonus', label: 'Technology Bonus', amount: 1850 },
  { id: 'perfect_attendance', label: 'Perfect Attendance Bonus', amount: 5000 },
];

const DEPARTMENTS: {
  key: string;
  name: string;
  bonuses: { id: string; label: string; amount: number }[];
}[] = [
  { key: 'accounting',       name: 'Accounting',         bonuses: [] },
  { key: 'edit',             name: 'Edit',               bonuses: [] },
  { key: 'devs',             name: 'Devs',               bonuses: [] },
  { key: 'lead_gen',         name: 'Lead Gen',           bonuses: [] },
  {
    key: 'us_manager_bonus',
    name: 'US - Manager Bonus',
    bonuses: [
      { id: 'usmgr_leadership', label: 'Leadership Excellence Award', amount: 3500 },
      { id: 'usmgr_team',       label: 'Team Performance Bonus',      amount: 3000 },
    ],
  },
  { key: 'callback',         name: 'Callback',           bonuses: [] },
  { key: 'qc',               name: 'QC',                 bonuses: [] },
  { key: 'discovery',        name: 'Discovery',          bonuses: [] },
  { key: 'hr',               name: 'HR',                 bonuses: [] },
  { key: 'sales_assistant',  name: 'Sales Assistant',    bonuses: [] },
  { key: 'smart_staff',      name: 'Smart Staff',        bonuses: [] },
  {
    key: 'hogan_smith_law',
    name: 'Hogan Smith Law',
    bonuses: [
      { id: 'hsl_case',       label: 'Case Resolution Bonus',       amount: 3000 },
      { id: 'hsl_compliance', label: 'Compliance Achievement Award', amount: 2500 },
    ],
  },
  { key: 'smm',              name: 'Social Media',       bonuses: [] },
  { key: 'pm_team',          name: 'PM Team',            bonuses: [] },
  { key: 'client_va',        name: 'Client VA',          bonuses: [] },
  { key: 'site_building',    name: 'Site Building',      bonuses: [] },
];

/** Known non-date Hubstaff column names (lowercase). Used as a quick-reject before date parsing. */
const HUBSTAFF_NON_DATE_COLS = new Set([
  'id', 'member', 'email', 'total worked', 'activity', 'activity (%)', 'spent', 'spent total',
  'billable', 'earned', 'organization', 'time zone', 'timezone', 'overtime',
  'job title', 'job type', 'client', 'project', 'task', 'note', 'created_at', 'updated_at',
]);

/**
 * Tries to extract an actual calendar date from a Hubstaff daily column name.
 * Handles all known formats from Supabase + Hubstaff exports:
 *   • "Mon 7/1"           → month/day, year = current year
 *   • "Mon 07/01"         → same, zero-padded
 *   • "Mon 7/1/2025"      → month/day/year (4-digit)
 *   • "Mon 7/1/25"        → month/day/year (2-digit, +2000)
 *   • "Monday 7/1"        → full day name + date
 *   • "2025-07-01"        → ISO 8601
 */
function parseColDate(col: string): Date | null {
  const s = col.trim();

  // ISO 8601: "2025-07-01"
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const d = new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
    return isNaN(d.getTime()) ? null : d;
  }

  // Hubstaff format: <DayName> M/D[/YY|YYYY]
  // Matches "Mon 7/1", "Monday 7/1", "Tue 07/01/2025", etc.
  const hub = /^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/i.exec(s);
  if (hub) {
    const month = parseInt(hub[1], 10) - 1; // 0-indexed
    const day   = parseInt(hub[2], 10);
    let year = hub[3] ? parseInt(hub[3], 10) : new Date().getFullYear();
    if (year < 100) year += 2000;
    const d = new Date(year, month, day);
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/** Map short day-name prefixes to a canonical 3-letter label + sort order. */
const DAY_PREFIX_MAP: Record<string, { label: string; order: number; weekday: boolean }> = {
  mon: { label: 'Mon', order: 1, weekday: true },
  tue: { label: 'Tue', order: 2, weekday: true },
  wed: { label: 'Wed', order: 3, weekday: true },
  thu: { label: 'Thu', order: 4, weekday: true },
  fri: { label: 'Fri', order: 5, weekday: true },
  sat: { label: 'Sat', order: 6, weekday: false },
  sun: { label: 'Sun', order: 0, weekday: false },
};

/**
 * Extract a day-name match from the column header prefix.
 * Handles short ("Mon 3/24") and full ("Monday 3/24") names.
 */
function colDayPrefix(col: string): { label: string; order: number; weekday: boolean } | null {
  const m = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.exec(col.trim());
  return m ? DAY_PREFIX_MAP[m[1].toLowerCase()] ?? null : null;
}

/**
 * Returns true when a Hubstaff column name represents a Monday–Friday workday.
 *
 * Priority:
 *  1. If the column starts with a day name ("Mon …", "Friday …"), trust that name.
 *     The Hubstaff CSV header is always correct even when year is ambiguous.
 *  2. For ISO columns without a day-name prefix ("2025-07-01"), parse the date and
 *     use getDay() to determine weekday.
 */
function colIsWeekday(col: string): boolean {
  const s = col.trim();
  const lower = s.toLowerCase();

  // Quick reject: known non-date columns
  for (const nd of HUBSTAFF_NON_DATE_COLS) {
    if (lower === nd || lower.startsWith(nd + ' ')) return false;
  }

  // Day-name prefix takes priority (always correct regardless of year)
  const prefix = colDayPrefix(s);
  if (prefix !== null) return prefix.weekday;

  // ISO dates without day-name prefix: parse and check getDay()
  const date = parseColDate(s);
  if (date !== null) {
    const dow = date.getDay();
    return dow >= 1 && dow <= 5;
  }

  return false;
}

/** Day-of-week sort order (Mon=1, Tue=2, …, Fri=5). Uses column name prefix first, then parsed date. */
function colDayOrder(col: string): number {
  const prefix = colDayPrefix(col.trim());
  if (prefix) return prefix.order;
  const date = parseColDate(col.trim());
  if (date) return date.getDay();
  return 9;
}

/** Returns the short day label for a column (e.g. "Mon 7/1" → "Mon", "2025-07-01" → "Tue"). */
function dayLabel(col: string): string {
  const prefix = colDayPrefix(col.trim());
  if (prefix) return prefix.label;
  const date = parseColDate(col.trim());
  if (date) {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return names[date.getDay()] ?? '?';
  }
  return col.trim().slice(0, 3);
}

/** Returns the single-letter weekday label for a Hubstaff day column (e.g. "Mon 7/1" → "M"). */
function dayLetter(col: string): string {
  return dayLabel(col)[0]?.toUpperCase() ?? '?';
}

/**
 * Groups Mon–Fri column names that refer to the same calendar day (ISO + Hubstaff labels
 * + monday…friday DB columns). Uses shared calendar keys with EmployeeDashboard.
 */
function groupWeekdayColumnsByDate(cols: string[]): string[][] {
  const weekdayCols = cols.filter(colIsWeekday);
  return groupDateColumnsByCalendarDay(weekdayCols, cols);
}

function maxSecondsAcrossWeekdayGroup(row: Record<string, unknown>, group: string[]): number {
  let maxS = 0;
  for (const col of group) {
    maxS = Math.max(maxS, rawValueToTotalSeconds(row[col]));
  }
  return maxS;
}

/**
 * Lead Gen appointment-based bonus:
 *   1–9  appointments → ₱250 per appointment
 *   10+  appointments → ₱500 per appointment
 */
function calcLeadGenBonus(appointments: number): number {
  if (appointments <= 0) return 0;
  return appointments >= 10 ? appointments * 500 : appointments * 250;
}

/**
 * Returns true when every token in `pattern` appears in the tokenized employee name.
 * Case-insensitive; ignores punctuation. Supports both "Last, First" and "First Last" formats.
 */
function nameMatchesPattern(empName: string, pattern: string): boolean {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  const empTokens = new Set(normalize(empName));
  return normalize(pattern).every(t => empTokens.has(t));
}

/** DEVS — Site Delivery eligibles: Enriquez Harry Jr. and Lagundi Bryan */
function isDevsDelivery(name: string): boolean {
  return nameMatchesPattern(name, 'Enriquez Harry') || nameMatchesPattern(name, 'Lagundi Bryan');
}

/** DEVS — Site Checking eligibles: Ranis Christian, Velasco Anjeo, Felices John Carl */
function isDevsChecking(name: string): boolean {
  return (
    nameMatchesPattern(name, 'Ranis Christian') ||
    nameMatchesPattern(name, 'Velasco Anjeo') ||
    nameMatchesPattern(name, 'Felices John Carl')
  );
}

/** QC — Jerome Rosero receives a separate calculation and optional Callback bonuses */
function isJeromeRosero(name: string): boolean {
  return nameMatchesPattern(name, 'Jerome Rosero');
}

/** HR — "Teal" is excluded from the headcount multiplier */
function isTeal(name: string): boolean {
  return name.trim().toLowerCase().includes('teal');
}

/**
 * Departments that use formula-based bonus calculation instead of manual toggles.
 * Lead Gen is included but intentionally returns zero (department disregarded per policy).
 */
const FORMULA_DEPT_KEYS = new Set([
  'accounting', 'edit', 'devs', 'lead_gen',
  'callback', 'qc', 'discovery', 'hr', 'sales_assistant', 'smart_staff',
]);

/** Mon–Fri collection counts; sum drives Accounting weekly tier. Keys present ⇒ sum only; else legacy `collected` total. */
const ACCOUNTING_WEEKDAY_METRICS: { key: string; label: string }[] = [
  { key: 'collectedMon', label: 'Mon' },
  { key: 'collectedTue', label: 'Tue' },
  { key: 'collectedWed', label: 'Wed' },
  { key: 'collectedThu', label: 'Thu' },
  { key: 'collectedFri', label: 'Fri' },
];

function accountingWeeklyCollectedTotal(em: Record<string, number>): number {
  const hasDailyBreakdown = ACCOUNTING_WEEKDAY_METRICS.some(({ key }) =>
    Object.prototype.hasOwnProperty.call(em, key),
  );
  if (hasDailyBreakdown) {
    return ACCOUNTING_WEEKDAY_METRICS.reduce((sum, { key }) => sum + (em[key] ?? 0), 0);
  }
  return em.collected ?? 0;
}

/**
 * Computes department-specific bonuses for all employees in a single department.
 * Returns a map of email → bonus amount (does NOT include common bonuses).
 *
 * @param deptKey        - Department key from DEPARTMENTS
 * @param employees      - CalcRows assigned to this department
 * @param empMetrics     - Per-employee numeric metrics (tickets, collected, appts, etc.)
 * @param deptMetrics    - Department-level numeric metrics (unitsSold for QC, newHires for HR)
 */
function calculateDepartmentBonus(
  deptKey: string,
  employees: CalcRow[],
  empMetrics: Record<string, Record<string, number>>,
  deptMetrics: Record<string, Record<string, number>>,
): Record<string, number> {
  const result: Record<string, number> = {};
  const em = (email: string) => empMetrics[email] ?? {};
  const dm = deptMetrics[deptKey] ?? {};

  switch (deptKey) {
    // ── Accounting (tiered by collected count) ─────────────────────────────
    case 'accounting': {
      for (const emp of employees) {
        const collected = accountingWeeklyCollectedTotal(em(emp.email));
        let bonus = 0;
        if (collected >= 30)      bonus = 450;
        else if (collected >= 22) bonus = 300;
        else if (collected >= 17) bonus = 200;
        result[emp.email] = bonus;
      }
      break;
    }

    // ── Edit (₱50 per completed ticket) ────────────────────────────────────
    case 'edit': {
      for (const emp of employees) {
        result[emp.email] = (em(emp.email).tickets ?? 0) * 50;
      }
      break;
    }

    // ── Devs (tickets + site delivery or site checking) ────────────────────
    case 'devs': {
      for (const emp of employees) {
        const metrics = em(emp.email);
        let bonus = (metrics.tickets ?? 0) * 50;
        if (isDevsDelivery(emp.name)) {
          bonus += (metrics.siteDelivery ?? 0) * 50;
        } else if (isDevsChecking(emp.name)) {
          bonus += (metrics.siteChecking ?? 0) * 250;
        }
        result[emp.email] = bonus;
      }
      break;
    }

    // ── Callback (₱50/callback appt + lead gen tier inside callback) ───────
    case 'callback': {
      for (const emp of employees) {
        const metrics = em(emp.email);
        const callbackBonus = (metrics.callbackAppts ?? 0) * 50;
        const leadGenBonus  = calcLeadGenBonus(metrics.leadGenAppts ?? 0);
        result[emp.email] = callbackBonus + leadGenBonus;
      }
      break;
    }

    // ── QC (pool split + Jerome Rosero exception) ──────────────────────────
    case 'qc': {
      const unitsSold = dm.unitsSold ?? 0;
      const standardMembers = employees.filter(e => !isJeromeRosero(e.name));
      const standardCount = standardMembers.length;
      const poolRate = standardCount >= 6 ? 150 : 125;
      const pool = unitsSold * poolRate;
      const perMember = standardCount > 0 ? pool / standardCount : 0;

      for (const emp of employees) {
        if (isJeromeRosero(emp.name)) {
          const callbackBonus = (em(emp.email).callbackAppts ?? 0) * 50;
          result[emp.email] = unitsSold * 30 + callbackBonus;
        } else {
          result[emp.email] = perMember;
        }
      }
      break;
    }

    // ── Discovery (₱25 per unit sold prior week) ───────────────────────────
    case 'discovery': {
      for (const emp of employees) {
        result[emp.email] = (em(emp.email).unitsSoldPriorWeek ?? 0) * 25;
      }
      break;
    }

    // ── HR (pool ÷ new hires; Teal excluded from headcount multiplier) ─────
    case 'hr': {
      const newHires = dm.newHires ?? 0;
      const billableCount = employees.filter(e => !isTeal(e.name)).length;
      const pool = billableCount * 1000;
      const individual = newHires > 0 ? pool / newHires : 0;
      for (const emp of employees) {
        result[emp.email] = individual;
      }
      break;
    }

    // ── Sales Assistant (₱150 per sale last week) ──────────────────────────
    case 'sales_assistant': {
      for (const emp of employees) {
        result[emp.email] = (em(emp.email).salesLastWeek ?? 0) * 150;
      }
      break;
    }

    // ── SmartStaff (₱250 per appointment set) ──────────────────────────────
    case 'smart_staff': {
      for (const emp of employees) {
        result[emp.email] = (em(emp.email).appointmentsSet ?? 0) * 250;
      }
      break;
    }

    // ── Lead Gen (₱500/appt when ≥ 10, else ₱250/appt, 0 when zero) ───────
    case 'lead_gen': {
      for (const emp of employees) {
        result[emp.email] = calcLeadGenBonus(em(emp.email).leadGenAppts ?? 0);
      }
      break;
    }

    default:
      break;
  }

  return result;
}

/**
 * Maps a raw Supabase Department string to one of the DEPARTMENTS keys.
 * Case-insensitive and trims whitespace.
 */
function normalizeDeptToKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  const map: Record<string, string> = {
    // Accounting
    'accounting':               'accounting',
    'accounting team':          'accounting',
    // Edit
    'edit':                     'edit',
    'edit team':                'edit',
    // Devs / AI / Site Building
    'devs':                     'devs',
    'ai/api team':              'devs',
    'ai api team':              'devs',
    // Lead Gen
    'lead gen':                 'lead_gen',
    'lead generation':          'lead_gen',
    // US Manager Bonus
    'us - manager bonus':       'us_manager_bonus',
    'us manager bonus':         'us_manager_bonus',
    'manager bonus':            'us_manager_bonus',
    // Callback
    'callback':                 'callback',
    'callback team':            'callback',
    // QC
    'qc':                       'qc',
    'quality control':          'qc',
    // Discovery
    'discovery':                'discovery',
    // HR
    'hr':                       'hr',
    'human resources':          'hr',
    // Sales Assistant
    'sales assistant':          'sales_assistant',
    'sales':                    'sales_assistant',
    // SmartStaff
    'smart staff':              'smart_staff',
    'smartstaff':               'smart_staff',
    // Hogan Smith Law
    'hogan smith law':          'hogan_smith_law',
    'hogan':                    'hogan_smith_law',
    'hsl':                      'hogan_smith_law',
    // Social Media
    'smm':                      'smm',
    'smm freelancer':           'smm',
    'social media':             'smm',
    'social media team':        'smm',
    // PM Team
    'pm team':                  'pm_team',
    'pm':                       'pm_team',
    'project management':       'pm_team',
    'project management team':  'pm_team',
    // Client VA
    'client va':                'client_va',
    'client - va':              'client_va',
    'client-va':                'client_va',
    // Site Building
    'site building':            'site_building',
  };
  return map[s] ?? null;
}

const steps = [
  { id: 1, label: 'Upload CSV', icon: Upload, description: 'Hubstaff weekly report → public.hubstaff_hours' },
  { id: 2, label: 'Initial Calculation', icon: DollarSign, description: 'Hubstaff hours × employee_hourly_rates → Initial Pay' },
  { id: 3, label: 'Additions', icon: Calculator, description: 'Apply bonuses and adjustments' },
  { id: 4, label: 'Validation', icon: ShieldCheck, description: 'Pre-flight check and final review' },
  { id: 5, label: 'Dispatch', icon: Send, description: 'Trigger paystubs and payments' },
];

export default function PayrollWizard() {
  const [currentStep, setCurrentStep] = useState(1);
  const [users, setUsers] = useState<User[]>(MOCK_USERS);
  const [timeRecords, setTimeRecords] = useState<TimeRecord[]>(MOCK_TIME_RECORDS);
  const [payments, setPayments] = useState<PaymentLineItem[]>(MOCK_PAYMENTS);
  const [hubstaffData, setHubstaffData] = useState<HubstaffRow[]>([]);
  const [issues, setIssues] = useState<ReconciliationIssue[]>([]);
  const [isHoganCycle, setIsHoganCycle] = useState(false);
  const [masterEmployees, setMasterEmployees] = useState<EmployeeRow[]>([]);
  const [hubstaffDisplayColumns, setHubstaffDisplayColumns] = useState<string[] | null>(null);
  const [hubstaffDisplayRows, setHubstaffDisplayRows] = useState<Record<string, unknown>[] | null>(null);
  /** All rows across ALL uploaded CSVs — used for full-month PAB eligibility check. */
  const [pabAllRows, setPabAllRows] = useState<Record<string, unknown>[]>([]);
  const [pabAllColumns, setPabAllColumns] = useState<string[]>([]);
  /** False until the PAB merge effect finishes (avoids single-file Hubstaff fallback during fetch). */
  const [pabMergeLoaded, setPabMergeLoaded] = useState(false);
  const [hubstaffPreviewLoading, setHubstaffPreviewLoading] = useState(false);
  const [hubstaffPreviewError, setHubstaffPreviewError] = useState<string | null>(null);
  const [weeklyUploadLoading, setWeeklyUploadLoading] = useState(false);
  const [hubstaffPage, setHubstaffPage] = useState(1);
  const HUBSTAFF_PAGE_SIZE = 15;
  const SOURCE_FILE_PAGE_SIZE = 25;
  const [hubstaffSearch, setHubstaffSearch] = useState('');
  const [initialCalcSearch, setInitialCalcSearch] = useState('');
  const [approveUploadDialogOpen, setApproveUploadDialogOpen] = useState(false);
  const [previewPaystubsOpen, setPreviewPaystubsOpen] = useState(false);
  const [previewSelectedEmail, setPreviewSelectedEmail] = useState<string | null>(null);
  const [previewSearch, setPreviewSearch] = useState('');
  const [isDispatching, setIsDispatching] = useState(false);
  const [pendingWeekly, setPendingWeekly] = useState<{
    text: string;
    fileName: string;
  } | null>(null);

  // ── Uploaded-files browser tab state ──
  const [hubstaffActiveTab, setHubstaffActiveTab] = useState<'files' | 'upload'>('upload');
  const [uploadedSourceFiles, setUploadedSourceFiles] = useState<string[]>([]);
  const [sourceFilesLoading, setSourceFilesLoading] = useState(false);
  const [selectedSourceFile, setSelectedSourceFile] = useState<string | null>(null);
  const [sourceFileRows, setSourceFileRows] = useState<Record<string, unknown>[] | null>(null);
  const [sourceFileCols, setSourceFileCols] = useState<string[] | null>(null);
  const [sourceFileLoading, setSourceFileLoading] = useState(false);
  const [sourceFilePage, setSourceFilePage] = useState(1);
  const [sourceFileSearch, setSourceFileSearch] = useState('');
  const [deleteSourceFilePending, setDeleteSourceFilePending] = useState<string | null>(null);
  const [deleteSourceFileLoading, setDeleteSourceFileLoading] = useState(false);

  /** Source file selected for Initial Calculation (step 2). Defaults to latest uploaded file. */
  const [calcSourceFile, setCalcSourceFile] = useState<string | null>(null);
  const [calcSourceFileLoading, setCalcSourceFileLoading] = useState(false);
  /** True while fetching unfiltered hubstaff_hours (no source_file column / replace-only uploads). */
  const [unfilteredHubstaffLoading, setUnfilteredHubstaffLoading] = useState(false);

  const [hourlyRateRows, setHourlyRateRows] = useState<EmployeeHourlyRateRow[]>([]);
  const [hourlyRatesLoading, setHourlyRatesLoading] = useState(false);
  const [hourlyRatesError, setHourlyRatesError] = useState<string | null>(null);

  /** USD → PHP (PHP per $1). Saved in app_settings `usd_to_php_rate`; default is the official ₱100,000 ÷ 10⁵ rate. */
  const [usdToPhpRate, setUsdToPhpRate] = useState<number>(OFFICIAL_USD_TO_PHP_RATE);
  const [usdToPhpInput, setUsdToPhpInput] = useState<string>(String(OFFICIAL_USD_TO_PHP_RATE));
  const [usdToPhpSaving, setUsdToPhpSaving] = useState(false);
  const [usdToPhpEditing, setUsdToPhpEditing] = useState(false);

  const [activeDeptTab, setActiveDeptTab] = useState('accounting');
  const [accountingModalEmail, setAccountingModalEmail] = useState<string | null>(null);
  const [ticketsModalEmail, setTicketsModalEmail] = useState<string | null>(null);
  const [sitesModalEmail, setSitesModalEmail] = useState<string | null>(null);
  const [leadGenModalEmail, setLeadGenModalEmail] = useState<string | null>(null);
  const [callbackModalEmail, setCallbackModalEmail] = useState<string | null>(null);
  const [qcModalEmail, setQcModalEmail] = useState<string | null>(null);
  const [hrModalEmail, setHrModalEmail] = useState<string | null>(null);
  const [simpleMetricModal, setSimpleMetricModal] = useState<
    | null
    | {
        email: string;
        metric: 'unitsSoldPriorWeek' | 'salesLastWeek' | 'appointmentsSet' | 'callbackAppts';
        rate: number;
        title: string;
        inputLabel: string;
        unitLabel: string;
      }
  >(null);
  const [isRecalcPending, startRecalc] = useTransition();
  const [additionsSearch, setAdditionsSearch] = useState('');
  const [validationSearch, setValidationSearch] = useState('');
  const [employeeDepts, setEmployeeDepts] = useState<Record<string, string>>({});
  const [employeeBonuses, setEmployeeBonuses] = useState<Record<string, Record<string, boolean>>>({});
  /** Per-employee numeric metrics: email → { metric → value }. Used by formula-based departments. */
  const [employeeMetrics, setEmployeeMetrics] = useState<Record<string, Record<string, number>>>({});
  /** Department-level numeric metrics: deptKey → { metric → value }. Used for pool calculations (QC, HR). */
  const [deptMetrics, setDeptMetrics] = useState<Record<string, Record<string, number>>>({});

  // ── Overtime settings from System Settings ──────────────────────────────────
  const [otGlobalSuspended, setOtGlobalSuspended] = useState(false);
  const [otDeptEnabled, setOtDeptEnabled] = useState<Record<string, boolean>>(
    Object.fromEntries(DEPARTMENTS.map(d => [`ot_dept_${d.key}`, true])),
  );

  const fileInputWeeklyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/employees', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { employees: EmployeeRow[]; error: string | null };
        if (!cancelled) setMasterEmployees(json.employees ?? []);
      } catch {
        // payrollComparison degrades gracefully with an empty list
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/app-settings?key=usd_to_php_rate', { cache: 'no-store' });
        const json = (await res.json()) as { value: string | null; error: string | null };
        if (cancelled) return;
        const rate = effectiveUsdToPhpRateFromStored(json.value);
        setUsdToPhpRate(rate);
        setUsdToPhpInput(String(rate));
      } catch {
        // keep defaults
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch overtime settings (global + per-department) from System Settings
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const allKeys = ['ot_global_suspended', ...DEPARTMENTS.map(d => `ot_dept_${d.key}`)];
        const responses = await Promise.all(
          allKeys.map(key => fetch(`/api/app-settings?key=${encodeURIComponent(key)}`, { cache: 'no-store' })),
        );
        if (cancelled) return;
        const jsons = (await Promise.all(responses.map(r => r.json()))) as { value: string | null }[];
        setOtGlobalSuspended(jsons[0].value === 'true');
        const deptMap: Record<string, boolean> = {};
        DEPARTMENTS.forEach((d, i) => {
          const val = jsons[i + 1].value;
          deptMap[`ot_dept_${d.key}`] = val === null ? true : val === 'true';
        });
        setOtDeptEnabled(deptMap);
      } catch {
        // keep defaults (all OT enabled)
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loadEmployeeHourlyRates = React.useCallback(async () => {
    setHourlyRatesLoading(true);
    setHourlyRatesError(null);
    try {
      const res = await fetch('/api/employee-hourly-rates', { cache: 'no-store' });
      const json = (await res.json()) as { rows: EmployeeHourlyRateRow[]; error: string | null };
      if (json.error) setHourlyRatesError(json.error);
      setHourlyRateRows(json.rows ?? []);
    } catch (e) {
      setHourlyRatesError(e instanceof Error ? e.message : 'Failed to load employee_hourly_rates');
    } finally {
      setHourlyRatesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentStep === 2) {
      void loadEmployeeHourlyRates();
    }
  }, [currentStep, loadEmployeeHourlyRates]);

  // Auto-select latest uploaded source file as soon as the list is available.
  // If no source files exist, fall back to loading all rows.
  useEffect(() => {
    if (uploadedSourceFiles.length > 0 && !calcSourceFile) {
      const latest = uploadedSourceFiles[uploadedSourceFiles.length - 1];
      setCalcSourceFile(latest);
    }
  }, [uploadedSourceFiles, calcSourceFile]);

  // Fallback: if source files loaded but none exist, load all data unfiltered
  useEffect(() => {
    if (!sourceFilesLoading && uploadedSourceFiles.length === 0 && hubstaffData.length === 0) {
      let cancelled = false;
      setUnfilteredHubstaffLoading(true);
      (async () => {
        try {
          const res = await fetch(`/api/hubstaff-hours?_=${Date.now()}`, { cache: 'no-store' });
          const json = (await res.json()) as {
            payrollRows?: Array<{
              email: string | null; name: string | null;
              hoursDisplay: string; hoursDecimal: number; department?: string | null;
            }>;
          };
          if (cancelled) return;
          if (json.payrollRows?.length) {
            const hd: HubstaffRow[] = json.payrollRows.map((p) => ({
              name: p.name ?? p.email ?? '',
              email: p.email ?? '',
              hours: p.hoursDisplay,
              decimalHours: p.hoursDecimal,
              department: p.department ?? null,
            }));
            setHubstaffData(hd);
          }
        } catch { /* degrades gracefully */ }
        finally {
          if (!cancelled) setUnfilteredHubstaffLoading(false);
        }
      })();
      return () => {
        cancelled = true;
        setUnfilteredHubstaffLoading(false);
      };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFilesLoading, uploadedSourceFiles]);

  // Load hubstaff data filtered by the selected source file for Initial Calculation
  const loadCalcSourceFileData = React.useCallback(async (file: string) => {
    setCalcSourceFileLoading(true);
    try {
      const res = await fetch(
        `/api/hubstaff-hours?source_file=${encodeURIComponent(file)}&_=${Date.now()}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as {
        columns?: string[] | null;
        rows?: Record<string, unknown>[] | null;
        payrollRows?: Array<{
          email: string | null;
          name: string | null;
          hoursDisplay: string;
          hoursDecimal: number;
          department?: string | null;
        }>;
        error?: string | null;
      };
      if (json.error) {
        console.warn('[calc source file]', json.error);
      }
      if (json.columns?.length && json.rows) {
        setHubstaffDisplayColumns(json.columns);
        setHubstaffDisplayRows(json.rows);
        setHubstaffPage(1);
        setHubstaffSearch('');
      }
      if (json.payrollRows?.length) {
        const hd: HubstaffRow[] = json.payrollRows.map((p) => ({
          name: p.name ?? p.email ?? '',
          email: p.email ?? '',
          hours: p.hoursDisplay,
          decimalHours: p.hoursDecimal,
          department: p.department ?? null,
        }));
        setHubstaffData(hd);
        setIssues(buildReconciliationIssues(hd, users));
      }
    } catch (e) {
      console.error('[calc source file]', e);
    } finally {
      setCalcSourceFileLoading(false);
    }
  }, [users]);

  useEffect(() => {
    if (calcSourceFile) {
      void loadCalcSourceFileData(calcSourceFile);
    }
  }, [calcSourceFile, loadCalcSourceFileData]);

  // Fetch ALL rows for full-month PAB eligibility (Additions / Step 3).
  // - When `source_file` is tracked: merge every uploaded file (each has different date columns).
  // - When there is no file list (legacy / replace-only): merge ALL hubstaff_hours rows by email
  //   so PAB still uses the whole month, not only the selected calc file.
  useEffect(() => {
    if (sourceFilesLoading) return;
    setPabMergeLoaded(false);
    let cancelled = false;
    (async () => {
      try {
        const mergeRowsInto = (
          rows: Record<string, unknown>[],
          rowsByEmail: Map<string, Record<string, unknown>>,
          allCols: Set<string>,
          sourceFile?: string,
        ) => {
          for (let row of rows) {
            // Resolve canonical day columns to ISO dates when a source file is provided
            if (sourceFile && columnsAreAllCanonical(Object.keys(row))) {
              row = resolveCanonicalColumnsToIso(row, sourceFile);
            }
            for (const k of Object.keys(row)) allCols.add(k);
            const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
            const email = normEmail(rawEmail) ?? rawEmail.toLowerCase();
            if (!email) continue;
            const existing = rowsByEmail.get(email) ?? {};
            rowsByEmail.set(email, { ...existing, ...row });
          }
        };

        const allCols = new Set<string>();
        const rowsByEmail = new Map<string, Record<string, unknown>>();

        if (uploadedSourceFiles.length > 0) {
          for (const file of uploadedSourceFiles) {
            const res = await fetch(
              `/api/hubstaff-hours?source_file=${encodeURIComponent(file)}&_=${Date.now()}`,
              { cache: 'no-store' },
            );
            const json = (await res.json()) as {
              columns?: string[] | null;
              rows?: Record<string, unknown>[] | null;
            };
            if (cancelled) return;
            if (!json.columns || !json.rows) continue;
            for (const col of json.columns) allCols.add(col);
            mergeRowsInto(json.rows, rowsByEmail, allCols, file);
          }
        } else {
          const res = await fetch(`/api/hubstaff-hours?_=${Date.now()}`, { cache: 'no-store' });
          const json = (await res.json()) as {
            columns?: string[] | null;
            rows?: Record<string, unknown>[] | null;
          };
          if (cancelled) return;
          if (json.rows?.length) {
            if (json.columns?.length) {
              for (const col of json.columns) allCols.add(col);
            }
            mergeRowsInto(json.rows, rowsByEmail, allCols);
          }
        }

        if (cancelled) return;
        setPabAllColumns(sortHubstaffColumnsForDisplay([...allCols]));
        setPabAllRows([...rowsByEmail.values()]);
      } catch (e) {
        console.warn('[PAB all-files fetch]', e);
      } finally {
        if (!cancelled) setPabMergeLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [uploadedSourceFiles, sourceFilesLoading]);

  /**
   * Columns/rows used only for PAB on Additions. Does **not** fall back to the Step 2 calc-file
   * preview while merged data is loading, or when uploads are tracked by `source_file` (merge required).
   */
  const hubstaffColsForPab = useMemo(() => {
    if (sourceFilesLoading) return null;
    if (pabAllColumns.length > 0) return pabAllColumns;
    if (!pabMergeLoaded) return null;
    if (uploadedSourceFiles.length > 0) return null;
    return hubstaffDisplayColumns ?? null;
  }, [sourceFilesLoading, pabAllColumns, pabMergeLoaded, uploadedSourceFiles, hubstaffDisplayColumns]);

  const hubstaffRowsForPab = useMemo(() => {
    if (sourceFilesLoading) return null;
    if (pabAllRows.length > 0) return pabAllRows;
    if (!pabMergeLoaded) return null;
    if (uploadedSourceFiles.length > 0) return null;
    return hubstaffDisplayRows ?? null;
  }, [sourceFilesLoading, pabAllRows, pabMergeLoaded, uploadedSourceFiles, hubstaffDisplayRows]);

  const ratesByEmail = useMemo(
    () => indexHourlyRatesByEmail(hourlyRateRows),
    [hourlyRateRows],
  );

  /** Inferred PAB month + computed date range for display. */
  const pabMonthRange = useMemo(() => {
    const cols = hubstaffColsForPab;
    if (!cols?.length) return null;
    // Prefer the LATEST month present so an in-progress current month isn't masked
    // by a more column-dense prior month (fixes "Additions tab shows PAB eligible
    // from a concluded past month when only a partial current month is uploaded").
    const pabMonth = getLatestPabMonthFromColumns(cols) ?? inferPabMonthFromColumns(cols);
    if (!pabMonth) return null;
    const { start, end } = getPabMonthRange(pabMonth.year, pabMonth.month);
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return { ...pabMonth, start, end, monthName: monthNames[pabMonth.month] ?? '' };
  }, [hubstaffColsForPab]);

  /** One group per calendar weekday — dedupes ISO + Hubstaff labels for the same day across ALL CSVs, filtered to PAB month boundaries. */
  const weekdayColumnGroups = useMemo(() => {
    const cols = hubstaffColsForPab;
    if (!cols?.length) return [];
    const groups = groupWeekdayColumnsByDate(cols);
    if (!pabMonthRange) return groups;
    return filterColumnGroupsByPabRange(groups, cols, pabMonthRange.start, pabMonthRange.end);
  }, [hubstaffColsForPab, pabMonthRange]);

  /** Mon–Fri days in the PAB window; column groups must match this count for monthly PAB. */
  const pabExpectedMonFriCount = useMemo(() => {
    if (!pabMonthRange) return 0;
    return countMonFriInclusiveInRange(pabMonthRange.start, pabMonthRange.end);
  }, [pabMonthRange]);

  const pabMonthColumnCoverageComplete = useMemo(
    () =>
      pabExpectedMonFriCount > 0 &&
      weekdayColumnGroups.length === pabExpectedMonFriCount,
    [pabExpectedMonFriCount, weekdayColumnGroups.length],
  );

  /**
   * True when the Hubstaff data has weekday columns but every value is null/empty.
   * Uses merged PAB rows/cols when available.
   */
  const dailyDataMissing = useMemo<boolean>(() => {
    const rows = hubstaffRowsForPab;
    const cols = hubstaffColsForPab;
    if (!cols || !rows || rows.length === 0) return false;
    if (weekdayColumnGroups.length === 0) return false;
    return rows.every(row =>
      weekdayColumnGroups.every(group =>
        group.every(col => {
          const v = row[col];
          return v == null || String(v).trim() === '';
        }),
      ),
    );
  }, [hubstaffRowsForPab, hubstaffColsForPab, weekdayColumnGroups]);

  /**
   * Computes which employees qualify for Perfect Attendance. Requires a full month of daily
   * columns (merged uploads) covering every Mon–Fri in the PAB range, each ≥ 7 hours.
   */
  const perfectAttendanceEligible = useMemo<Set<string>>(() => {
    if (dailyDataMissing) return new Set();
    if (!pabMonthRange || !pabMonthColumnCoverageComplete) return new Set();
    const rows = hubstaffRowsForPab;
    if (!rows || rows.length === 0) return new Set();
    if (weekdayColumnGroups.length === 0) return new Set();

    const eligible = new Set<string>();
    for (const row of rows) {
      const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
      const email = normEmail(rawEmail) ?? rawEmail.toLowerCase();
      if (!email) continue;

      let perfect = true;
      for (const group of weekdayColumnGroups) {
        if (maxSecondsAcrossWeekdayGroup(row, group) < 7 * 3600) {
          perfect = false;
          break;
        }
      }
      if (perfect) eligible.add(email);
    }
    return eligible;
  }, [hubstaffRowsForPab, dailyDataMissing, pabMonthRange, pabMonthColumnCoverageComplete, weekdayColumnGroups]);

  /**
   * Per-employee weekday breakdown for the PAB period (merged month). Used in the PA cell.
   */
  const employeeWeekdayHours = useMemo<
    Map<string, { col: string; seconds: number; passes: boolean }[]>
  >(() => {
    const rows = hubstaffRowsForPab;
    if (!rows || rows.length === 0) return new Map();
    if (weekdayColumnGroups.length === 0) return new Map();

    const map = new Map<string, { col: string; seconds: number; passes: boolean }[]>();
    for (const row of rows) {
      const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
      const email = normEmail(rawEmail) ?? rawEmail.toLowerCase();
      if (!email) continue;
      map.set(
        email,
        weekdayColumnGroups.map(group => {
          const col = pickPreferredHubstaffColumn(group);
          const seconds = maxSecondsAcrossWeekdayGroup(row, group);
          return { col, seconds, passes: seconds >= 7 * 3600 };
        }),
      );
    }
    return map;
  }, [hubstaffRowsForPab, weekdayColumnGroups]);

  /**
   * Auto-apply / remove perfect_attendance toggle whenever eligibility is
   * recomputed. Only updates employees that are already assigned to a dept;
   * manual overrides made AFTER this effect are respected on next reload.
   */
  useEffect(() => {
    setEmployeeBonuses(prev => {
      const next = { ...prev };
      let changed = false;
      for (const email of Object.keys(employeeDepts)) {
        const normE = normEmail(email) ?? email.toLowerCase();
        const eligible = perfectAttendanceEligible.has(normE);
        const current = next[email]?.['perfect_attendance'] ?? false;
        if (eligible !== current) {
          next[email] = { ...(next[email] ?? {}), perfect_attendance: eligible };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perfectAttendanceEligible]);

  const toggleEmployeeBonus = React.useCallback((email: string, bonusId: string, enabled: boolean) => {
    setEmployeeBonuses(prev => ({
      ...prev,
      [email]: { ...(prev[email] ?? {}), [bonusId]: enabled },
    }));
  }, []);

  const assignToDept = React.useCallback((email: string, deptKey: string) => {
    setEmployeeDepts(prev => ({ ...prev, [email]: deptKey }));
  }, []);

  const removeFromDept = React.useCallback((email: string) => {
    setEmployeeDepts(prev => {
      const next = { ...prev };
      delete next[email];
      return next;
    });
  }, []);

  const applyBonusToAllInDept = React.useCallback((
    bonusId: string,
    _deptKey: string,
    enabled: boolean,
    emailsInDept: string[],
  ) => {
    setEmployeeBonuses(prev => {
      const next = { ...prev };
      for (const email of emailsInDept) {
        next[email] = { ...(next[email] ?? {}), [bonusId]: enabled };
      }
      return next;
    });
  }, []);

  const updateEmployeeMetric = React.useCallback((email: string, metric: string, value: number) => {
    setEmployeeMetrics(prev => ({
      ...prev,
      [email]: { ...(prev[email] ?? {}), [metric]: value },
    }));
  }, []);

  const updateDeptMetric = React.useCallback((deptKey: string, metric: string, value: number) => {
    setDeptMetrics(prev => ({
      ...prev,
      [deptKey]: { ...(prev[deptKey] ?? {}), [metric]: value },
    }));
  }, []);

  /**
   * Match Hubstaff Email to employee_hourly_rates Work Email (or Personal Email).
   * Reg Pay = Reg Rate × Reg Hrs, OT Pay = OT Rate × OT Hrs (Reg Hrs = min(Total, 40), OT = rest).
   * Total hours rounded to 2dp (Hubstaff-style) before split; pay uses whole seconds + centavo rounding.
   */
  const calcResults = useMemo<CalcRow[]>(() => {
    return hubstaffData.map((row) => {
      const totalH = roundWorkedHoursForPay(row.decimalHours);
      const { regularSec, otSec } = splitRegularOvertimeSeconds(totalH);
      const regularHours = regularSec / 3600;
      const otHours = otSec / 3600;

      const em = normEmail(row.email);
      let rateRow = em ? ratesByEmail.get(em) : undefined;

      // Fallback: match via masterEmployees when direct email lookup fails.
      // Hubstaff email → master (by work_email) → personal_email → ratesByEmail,
      // or Hubstaff name → master (by name) → personal_email / work_email → ratesByEmail.
      if (!rateRow && masterEmployees.length > 0) {
        let master: typeof masterEmployees[number] | undefined;

        // Try work_email match first
        if (em) {
          master = masterEmployees.find(e => normEmail(e.work_email) === em);
        }

        // Try name match (normalized: handles "First Last" vs "Last, First" vs nicknames)
        if (!master && row.name) {
          const hubstaffTokens = normalizeNameTokens(row.name);
          if (hubstaffTokens) {
            master = masterEmployees.find(
              e => e.name ? normalizeNameTokens(e.name) === hubstaffTokens : false,
            );
          }
        }

        if (master) {
          const pe = normEmail(master.personal_email);
          const we = normEmail(master.work_email);
          rateRow = (pe ? ratesByEmail.get(pe) : undefined)
                 ?? (we ? ratesByEmail.get(we) : undefined);
        }
      }

      // Rates stored in PHP; compute pay in PHP then derive USD equivalent
      const regularRate = parseRateField(rateRow?.regular_rate);
      const otRate = parseRateField(rateRow?.ot_rate);

      const regularPay =
        regularRate != null ? phpHourlyPayFromSeconds(regularRate, regularSec) : null;
      const otPay =
        otSec > 0 ? (otRate != null ? phpHourlyPayFromSeconds(otRate, otSec) : null) : 0;
      const initialPay =
        regularPay != null && otPay != null
          ? Math.round((regularPay + otPay) * 100) / 100
          : null;

      return {
        email: row.email,
        name: row.name,
        totalHours: totalH,
        regularHours,
        otHours,
        regularRate,
        otRate,
        regularPay,
        otPay,
        initialPay,
      };
    });
  }, [hubstaffData, ratesByEmail, masterEmployees]);

  /**
   * Applies per-department and global OT suspension from System Settings.
   * If a department's OT is turned off (or global OT is suspended), otHours/otPay
   * are zeroed and initialPay is recalculated as regularPay only.
   */
  const effectiveCalcResults = useMemo<CalcRow[]>(() => {
    return calcResults.map((row) => {
      const deptKey = employeeDepts[row.email];
      const deptOtOn = otGlobalSuspended
        ? false
        : (deptKey ? (otDeptEnabled[`ot_dept_${deptKey}`] ?? true) : true);

      if (deptOtOn) return row;

      return {
        ...row,
        otHours: 0,
        otPay: 0,
        initialPay: row.regularPay != null ? Math.round(row.regularPay * 100) / 100 : null,
      };
    });
  }, [calcResults, employeeDepts, otGlobalSuspended, otDeptEnabled]);

  const bonusTotals = useMemo(() => {
    const result: Record<string, number> = {};

    // Group assigned employees by department for formula-based dept calculations
    const deptEmployeeMap: Record<string, CalcRow[]> = {};
    for (const calcRow of effectiveCalcResults) {
      const deptKey = employeeDepts[calcRow.email];
      if (!deptKey) continue;
      if (!deptEmployeeMap[deptKey]) deptEmployeeMap[deptKey] = [];
      deptEmployeeMap[deptKey].push(calcRow);
    }

    // Department-specific bonus (formula-based or toggle-based)
    for (const [deptKey, employees] of Object.entries(deptEmployeeMap)) {
      if (FORMULA_DEPT_KEYS.has(deptKey)) {
        const deptBonuses = calculateDepartmentBonus(deptKey, employees, employeeMetrics, deptMetrics);
        for (const [email, bonus] of Object.entries(deptBonuses)) {
          result[email] = (result[email] ?? 0) + bonus;
        }
      } else {
        const dept = DEPARTMENTS.find(d => d.key === deptKey);
        if (!dept) continue;
        for (const emp of employees) {
          const toggles = employeeBonuses[emp.email] ?? {};
          let total = 0;
          for (const db of dept.bonuses) {
            if (toggles[db.id]) total += db.amount;
          }
          result[emp.email] = (result[emp.email] ?? 0) + total;
        }
      }
    }

    // Common bonuses (Technology, Perfect Attendance) — always toggle-based for every dept
    for (const [email, deptKey] of Object.entries(employeeDepts)) {
      if (!deptKey) continue;
      const toggles = employeeBonuses[email] ?? {};
      let commonTotal = 0;
      for (const cb of COMMON_BONUSES) {
        if (toggles[cb.id]) commonTotal += cb.amount;
      }
      result[email] = (result[email] ?? 0) + commonTotal;
    }

    return result;
  }, [effectiveCalcResults, employeeDepts, employeeBonuses, employeeMetrics, deptMetrics]);

  /** Enriched dispatch rows shared by Preview Paystubs + Confirm & Dispatch. */
  const dispatchData = useMemo(() => {
    const resolvePersonalEmail = (r: CalcRow): string | null => {
      const em = normEmail(r.email);
      const rateRow = em ? ratesByEmail.get(em) : undefined;
      const fromRate = normEmail(rateRow?.personal_email);
      if (fromRate) return fromRate;
      let master = em
        ? masterEmployees.find((e) => normEmail(e.work_email) === em)
        : undefined;
      if (!master && r.name) {
        const tokens = normalizeNameTokens(r.name);
        if (tokens) {
          master = masterEmployees.find(
            (e) => e.name && normalizeNameTokens(e.name) === tokens,
          );
        }
      }
      return normEmail(master?.personal_email) ?? null;
    };

    const commonBonusPhp = (id: string) =>
      COMMON_BONUSES.find((b) => b.id === id)?.amount ?? 0;

    // Derive the latest weekly pay period: prefer parsed range from the source filename,
    // otherwise compute Mon–Sun around the latest parseable date column in the dataset.
    const toIso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let week: { start: string; end: string } | null = null;
    const fromFile = calcSourceFile ? parseDateRangeFromFilename(calcSourceFile) : null;
    if (fromFile) {
      week = { start: toIso(fromFile.start), end: toIso(fromFile.end) };
    } else {
      const cols = hubstaffColsForPab ?? [];
      let latest: Date | null = null;
      for (const c of cols) {
        const d = parseColDate(c);
        if (d && (!latest || d.getTime() > latest.getTime())) latest = d;
      }
      if (latest) {
        const dow = latest.getDay();
        const daysBackToMon = dow === 0 ? 6 : dow - 1;
        const mon = new Date(latest.getFullYear(), latest.getMonth(), latest.getDate() - daysBackToMon);
        const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
        week = { start: toIso(mon), end: toIso(sun) };
      }
    }

    const payPeriodPayload = {
      currency: 'PHP' as const,
      hubstaff_source_file: calcSourceFile,
      week,
      pab_evaluation: pabMonthRange
        ? {
            month_label: `${pabMonthRange.monthName} ${pabMonthRange.year}`,
            range_start: pabMonthRange.start.toLocaleDateString('en-CA'),
            range_end: pabMonthRange.end.toLocaleDateString('en-CA'),
          }
        : { month_label: '—', range_start: '—', range_end: '—' },
    };

    // Bonus gating based on the weekly pay period:
    //  - PAB: a monthly bonus — only attach to the *final* weekly paystub of the PAB period.
    //  - Tech: unlocks on the 3rd calendar week of the PAB month (week 1 = Mon–Sun
    //    week containing the 1st, even if partial). Applies to that week and every
    //    week after within the PAB month.
    const parseIso = (s: string) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      if (!m) return null;
      return new Date(+m[1], +m[2] - 1, +m[3]);
    };
    // Derive the PAB month from the *current dispatch week*, not from merged uploads.
    // PAB month = month of the Monday of the week containing the pay period.
    const weekStartDate = week ? parseIso(week.start) : null;
    const weekEndDate = week ? parseIso(week.end) : null;
    const weekPabMonth = (() => {
      if (!weekStartDate) return null;
      const dow = weekStartDate.getDay();
      const daysBackToMon = dow === 0 ? 6 : dow - 1;
      const mon = new Date(
        weekStartDate.getFullYear(),
        weekStartDate.getMonth(),
        weekStartDate.getDate() - daysBackToMon,
      );
      return { year: mon.getFullYear(), month: mon.getMonth() };
    })();
    const weekPabRange = weekPabMonth
      ? getPabMonthRange(weekPabMonth.year, weekPabMonth.month)
      : null;

    const isFinalPabWeek = (() => {
      if (!weekEndDate || !weekPabRange) return false;
      return weekEndDate.getTime() >= new Date(
        weekPabRange.end.getFullYear(),
        weekPabRange.end.getMonth(),
        weekPabRange.end.getDate(),
      ).getTime();
    })();
    /**
     * Tech Bonus rule: paid in the *3rd paycheck* of the month (the weekly pay
     * period whose Monday is the 3rd calendar week of the month — week 1 = the
     * Mon–Sun week containing the 1st, even if partial). Equality, not ≥.
     */
    const isTechBonusWeek = (() => {
      if (!weekStartDate || !weekPabMonth) return false;
      const first = new Date(weekPabMonth.year, weekPabMonth.month, 1);
      const dow = first.getDay();
      const daysBack = dow === 0 ? 6 : dow - 1;
      const firstMon = new Date(first.getFullYear(), first.getMonth(), first.getDate() - daysBack);
      const thirdWeekMon = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate() + 14);
      const fourthWeekMon = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate() + 21);
      const t = weekStartDate.getTime();
      return t >= thirdWeekMon.getTime() && t < fourthWeekMon.getTime();
    })();
    /**
     * Build start_date lookup (work_email → Date). Employees need 30 days of
     * service before their first Tech Bonus; eligibleFrom = start_date + 30d.
     */
    const startDateByEmail = new Map<string, Date>();
    for (const emp of masterEmployees) {
      const sd = emp.start_date ? new Date(emp.start_date) : null;
      if (!sd || isNaN(sd.getTime())) continue;
      const we = normEmail(emp.work_email);
      const pe = normEmail(emp.personal_email);
      if (we) startDateByEmail.set(we, sd);
      if (pe) startDateByEmail.set(pe, sd);
    }
    const hasThirtyDaysByWeek = (workEmail: string) => {
      if (!weekStartDate) return false;
      const em = normEmail(workEmail);
      const sd = em ? startDateByEmail.get(em) : undefined;
      if (!sd) return false;
      const eligibleFrom = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate() + 30);
      return weekStartDate.getTime() >= eligibleFrom.getTime();
    };

    const rows: DispatchEmployee[] = [];
    const missing: string[] = [];
    for (const r of effectiveCalcResults) {
      const pe = resolvePersonalEmail(r);
      if (!pe) {
        missing.push(r.name || r.email);
        continue;
      }
      const deptKey = employeeDepts[r.email] ?? null;
      const deptName = deptKey
        ? DEPARTMENTS.find((d) => d.key === deptKey)?.name ?? null
        : null;
      const toggles = employeeBonuses[r.email] ?? {};
      const pabBonus = isFinalPabWeek && toggles.perfect_attendance
        ? commonBonusPhp('perfect_attendance')
        : 0;
      // Tech Bonus: paid in the 3rd paycheck of the month, but only after the
      // employee has completed 30 days of service from their start_date.
      // Manual toggle can opt-in earlier (still requires 30-day service).
      const hasThirtyDays = hasThirtyDaysByWeek(r.email);
      const techBonus =
        hasThirtyDays && (isTechBonusWeek || toggles.tech_bonus)
          ? commonBonusPhp('tech_bonus')
          : 0;
      const rawBonusTotal = bonusTotals[r.email] ?? 0;
      // Strip out the month-wide PAB/tech amounts that `bonusTotals` may include,
      // then re-add the week-gated versions so weekly paystubs get the right total.
      const toggledPab = toggles.perfect_attendance ? commonBonusPhp('perfect_attendance') : 0;
      const toggledTech = toggles.tech_bonus ? commonBonusPhp('tech_bonus') : 0;
      const otherBonuses = Math.max(0, rawBonusTotal - toggledPab - toggledTech);
      const bonusTotal = pabBonus + techBonus + otherBonuses;
      const finalPay = (r.initialPay ?? 0) + bonusTotal;

      rows.push({
        name: r.name,
        email: r.email,
        personal_email: pe,
        pay_period: payPeriodPayload,
        department_key: deptKey,
        department_name: deptName,
        hours: { total: r.totalHours, regular: r.regularHours, ot: r.otHours },
        rates_php: { regular: r.regularRate, ot: r.otRate },
        pay_php: {
          regular: r.regularPay,
          ot: r.otPay,
          initial: r.initialPay,
          bonuses_total: bonusTotal,
          perfect_attendance_bonus: pabBonus,
          tech_bonus: techBonus,
          other_bonuses: otherBonuses,
          final: finalPay,
        },
      });
    }
    return { rows, missing, payPeriodPayload };
  }, [
    effectiveCalcResults,
    ratesByEmail,
    masterEmployees,
    employeeDepts,
    employeeBonuses,
    bonusTotals,
    pabMonthRange,
    calcSourceFile,
    hubstaffColsForPab,
  ]);

  const filteredCalcResults = useMemo(() => {
    const needle = initialCalcSearch.toLowerCase().trim();
    if (!needle) return effectiveCalcResults;
    return effectiveCalcResults.filter((row) => {
      const haystack = [
        row.name,
        row.email,
        row.totalHours.toFixed(2),
        row.regularHours.toFixed(2),
        row.otHours.toFixed(2),
        row.regularRate != null ? row.regularRate.toString() : '',
        row.otRate != null ? row.otRate.toString() : '',
        row.regularPay != null ? row.regularPay.toString() : '',
        row.otPay != null ? row.otPay.toString() : '',
        row.initialPay != null ? row.initialPay.toString() : '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [effectiveCalcResults, initialCalcSearch]);

  const loadHubstaffPreview = React.useCallback(async () => {
    setHubstaffPreviewLoading(true);
    setHubstaffPreviewError(null);
    try {
      const res = await fetch(`/api/hubstaff-hours?_=${Date.now()}`, { cache: 'no-store' });
      const json = (await res.json()) as {
        columns?: string[] | null;
        rows?: Record<string, unknown>[] | null;
        payrollRows?: Array<{
          email: string | null;
          name: string | null;
          hoursDisplay: string;
          hoursDecimal: number;
          department?: string | null;
        }>;
        error?: string | null;
      };
      if (json.error) {
        setHubstaffPreviewError(json.error);
      }
      if (json.columns?.length && json.rows) {
        console.log('[hubstaff_hours] actual column names:', json.columns);
        let cols = json.columns as string[];
        let rows = json.rows as Record<string, unknown>[];

        // Check if weekday columns from Supabase actually have data.
        // If the table schema has stale date columns from a previous week,
        // daily values will be null. Fall back to the saved daily breakdown.
        const weekdayCols = cols.filter(colIsWeekday);
        const allDailyEmpty = weekdayCols.length === 0 || rows.every(row =>
          weekdayCols.every(col => {
            const v = row[col];
            return v == null || String(v).trim() === '';
          }),
        );
        if (allDailyEmpty) {
          try {
            const fbRes = await fetch('/api/app-settings?key=hubstaff_daily_breakdown', { cache: 'no-store' });
            const fbJson = (await fbRes.json()) as { value: string | null };
            if (fbJson.value) {
              const { dateCols, daily } = JSON.parse(fbJson.value) as {
                dateCols: string[];
                daily: Record<string, Record<string, string | null>>;
              };
              if (dateCols?.length && daily) {
                // Merge saved daily columns into the Supabase data
                const existingColSet = new Set(cols);
                const newCols = dateCols.filter(c => !existingColSet.has(c));
                cols = [...cols, ...newCols];
                rows = rows.map(row => {
                  const email = normEmail(String(row['Email'] ?? row['email'] ?? '')) ?? '';
                  const dayData = daily[email];
                  if (!dayData) return row;
                  return { ...row, ...dayData };
                });
                console.log('[hubstaff_hours] merged saved daily breakdown for PA detection:', dateCols);
              }
            }
          } catch {
            // saved breakdown unavailable — PA detection will show warning banner
          }
        }

        setHubstaffDisplayColumns(cols);
        setHubstaffDisplayRows(rows);
        setHubstaffPage(1);
        setHubstaffSearch('');
      } else {
        setHubstaffDisplayColumns(null);
        setHubstaffDisplayRows(null);
        setHubstaffPage(1);
        setHubstaffSearch('');
      }
      // hubstaffData is set exclusively by loadCalcSourceFileData (filtered by source file).
      // loadHubstaffPreview only sets display columns/rows for the step 1 preview table.
    } catch (e) {
      setHubstaffPreviewError(e instanceof Error ? e.message : 'Failed to load hubstaff_hours');
      setHubstaffDisplayColumns(null);
      setHubstaffDisplayRows(null);
    } finally {
      setHubstaffPreviewLoading(false);
    }
  }, [users]);

  useEffect(() => {
    void loadHubstaffPreview();
  }, [loadHubstaffPreview]);

  // ── Load list of uploaded source files ──
  const loadUploadedSourceFiles = React.useCallback(async (): Promise<string[]> => {
    setSourceFilesLoading(true);
    try {
      const res = await fetch(`/api/hubstaff-hours?source_files=1&_=${Date.now()}`, { cache: 'no-store' });
      const json = (await res.json()) as { files?: string[]; error?: string | null };
      const files = json.files ?? [];
      setUploadedSourceFiles(files);
      return files;
    } catch {
      setUploadedSourceFiles([]);
      return [];
    } finally {
      setSourceFilesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUploadedSourceFiles();
  }, [loadUploadedSourceFiles]);

  const confirmDeleteSourceFile = React.useCallback(async () => {
    if (!deleteSourceFilePending) return;
    setDeleteSourceFileLoading(true);
    try {
      const res = await fetch(
        `/api/hubstaff-hours?source_file=${encodeURIComponent(deleteSourceFilePending)}&_=${Date.now()}`,
        { method: 'DELETE', cache: 'no-store' },
      );
      const json = (await res.json()) as { success?: boolean; error?: string; deleted?: number };
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Delete failed');
      }
      const removed = json.deleted ?? 0;
      const label = deleteSourceFilePending;
      if (removed === 0) {
        toast.warning('Nothing removed in Supabase', {
          description: `No rows with source_file "${label}" were found. Older rows may lack source_file; add the column and re-upload, or remove rows in Supabase directly.`,
        });
      } else {
        toast.success('Removed from Supabase', {
          description: `${removed} row(s) deleted for ${label} in public.hubstaff_hours.`,
        });
      }
      if (selectedSourceFile === deleteSourceFilePending) {
        setSelectedSourceFile(null);
        setSourceFileRows(null);
        setSourceFileCols(null);
      }
      setDeleteSourceFilePending(null);
      await loadUploadedSourceFiles();
      await loadHubstaffPreview();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed';
      toast.error('Could not delete upload', { description: msg });
    } finally {
      setDeleteSourceFileLoading(false);
    }
  }, [deleteSourceFilePending, selectedSourceFile, loadUploadedSourceFiles, loadHubstaffPreview]);

  // ── Load rows for a specific source file ──
  const loadSourceFileRows = React.useCallback(async (file: string) => {
    setSelectedSourceFile(file);
    setSourceFileLoading(true);
    setSourceFilePage(1);
    setSourceFileSearch('');
    try {
      const res = await fetch(
        `/api/hubstaff-hours?source_file=${encodeURIComponent(file)}&_=${Date.now()}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as {
        columns?: string[] | null;
        rows?: Record<string, unknown>[] | null;
        error?: string | null;
      };
      setSourceFileCols(json.columns ?? null);
      setSourceFileRows(json.rows ?? null);
    } catch {
      setSourceFileCols(null);
      setSourceFileRows(null);
    } finally {
      setSourceFileLoading(false);
    }
  }, []);

  /**
   * Auto-populate employeeDepts whenever calcResults, masterEmployees, or
   * hubstaffData change. Existing manual assignments are preserved.
   *
   * Resolution order (first hit wins):
   *  1. personal_email chain  — Hubstaff work email → employee_hourly_rates
   *                             → personal_email → global_master_list
   *  2. Name match            — Hubstaff name → global_master_list name
   *  3. Work email direct     — Hubstaff email → global_master_list "Work Email"
   *                             (uses new work_email field fetched from DB)
   *  4. Hubstaff dept fallback — if still unresolved, use the "Job type" column
   *                             from hubstaff_hours as the department hint.
   *                             This covers employees absent from global_master_list.
   */
  useEffect(() => {
    if (calcResults.length === 0) return;

    setEmployeeDepts(prev => {
      const next = { ...prev };
      let changed = false;

      for (const calcRow of calcResults) {
        if (next[calcRow.email]) continue; // keep manual assignments

        const em = normEmail(calcRow.email);
        const rateRow = em ? ratesByEmail.get(em) : undefined;

        let deptRaw: string | null = null;

        // ── Tier 0: Department column in employee_hourly_rates (primary source)
        if (!deptRaw && rateRow?.department) {
          deptRaw = rateRow.department;
        }

        // ── Tier 1: personal_email from rate row → global_master_list ──────
        if (!deptRaw && rateRow?.personal_email) {
          const normPE = normEmail(rateRow.personal_email);
          const master = masterEmployees.find(
            e => normEmail(e.personal_email) === normPE,
          );
          deptRaw = master?.department ?? null;
        }

        // ── Tier 2: name match → global_master_list ─────────────────────────
        if (!deptRaw && calcRow.name) {
          const tokens = normalizeNameTokens(calcRow.name);
          if (tokens) {
            const master = masterEmployees.find(
              e => e.name ? normalizeNameTokens(e.name) === tokens : false,
            );
            deptRaw = master?.department ?? null;
          }
        }

        // ── Tier 3: direct work email → global_master_list "Work Email" ────
        if (!deptRaw && em) {
          const master = masterEmployees.find(
            e => normEmail(e.work_email) === em,
          );
          deptRaw = master?.department ?? null;
        }

        // ── Tier 4: Hubstaff "Job type" fallback (employee not in master list)
        if (!deptRaw) {
          const hubRow = hubstaffData.find(h => normEmail(h.email) === em);
          deptRaw = hubRow?.department ?? null;
        }

        const deptKey = normalizeDeptToKey(deptRaw);
        if (deptKey) {
          next[calcRow.email] = deptKey;
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [calcResults, masterEmployees, ratesByEmail, hubstaffData]);

  const payrollComparison = useMemo(
    () => comparePayrollToMaster(masterEmployees, hubstaffData),
    [masterEmployees, hubstaffData],
  );


  const nextStep = () => {
    if (currentStep < steps.length) setCurrentStep(currentStep + 1);
  };

  const prevStep = () => {
    if (currentStep > 1) setCurrentStep(currentStep - 1);
  };

  const handleWeeklyFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const buffer = await file.arrayBuffer();
    const text = new TextDecoder('utf-8').decode(buffer);
    let rawGrid: string[][];
    try {
      rawGrid = parseCsv(text);
    } catch (parseErr) {
      toast.error('Could not parse CSV', {
        description:
          parseErr instanceof Error ? parseErr.message : 'The file may be corrupted or not valid CSV text.',
      });
      return;
    }
    // Remove fully-empty rows before any validation
    const grid = [
      rawGrid[0],
      ...rawGrid.slice(1).filter((row) => row.some((cell) => cell.trim() !== '')),
    ];
    if (grid.length < 2) {
      toast.error('Invalid CSV', { description: 'The file needs a header row and at least one data row.' });
      return;
    }

    const header = grid[0].map((h) => h.trim());
    // Accept both weekly summary (Email + total) and daily report (Member + Total hours)
    const emailIdx = findHeaderColumn(header, 'Email', 'Work email', 'Work Email');
    const memberIdx = findHeaderColumn(header, 'Member');
    const totalHoursIdx = findHeaderColumn(header, 'Total hours', 'Total Hours');
    const totalForWeeklyIdx = findHeaderColumn(
      header,
      'Total worked',
      'Total Worked',
      'Worked time',
      'Time worked',
      'Total hours',
      'Total Hours',
    );
    const isWeeklyFormat = emailIdx >= 0 && totalForWeeklyIdx >= 0;
    const isDailyFormat = memberIdx >= 0 && totalHoursIdx >= 0;
    if (!isWeeklyFormat && !isDailyFormat) {
      toast.error('Not a Hubstaff report', {
        description:
          'Expected columns: Email plus Total worked / Total hours (weekly summary), or Member + Total hours (daily export).',
      });
      return;
    }

    setPendingWeekly({ text, fileName: file.name });
    setApproveUploadDialogOpen(true);
  };

  const confirmWeeklyUploadToDatabase = async () => {
    if (!pendingWeekly) return;
    setWeeklyUploadLoading(true);
    try {
      // ── 1. Save CSV text before clearing pendingWeekly ──
      const csvText = pendingWeekly.text;
      const uploadedFileName = pendingWeekly.fileName;

      const form = new FormData();
      form.append('file', new Blob([csvText], { type: 'text/csv' }), pendingWeekly.fileName);

      const res = await fetch('/api/hubstaff-hours', { method: 'POST', body: form });
      const json = (await res.json()) as { success?: boolean; error?: string; rowCount?: number };

      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Upload failed');
      }

      setPendingWeekly(null);
      setApproveUploadDialogOpen(false);

      // Persist daily breakdown for PA detection, then reload full table from Supabase
      // so the preview reflects every appended batch (not only the last file).
      let cleanGrid: string[][] = [];
      try {
        const rawGrid = parseCsv(csvText);
        cleanGrid = [
          rawGrid[0],
          ...rawGrid.slice(1).filter((row) => row.some((cell) => cell.trim() !== '')),
        ];
      } catch {
        // Rows are already in Supabase; preview will still refresh below.
      }

      if (cleanGrid.length >= 2) {
        const headers = cleanGrid[0].map((h) => h.trim());
        const csvRows: Record<string, unknown>[] = cleanGrid.slice(1).map((row) => {
          const obj: Record<string, unknown> = {};
          headers.forEach((h, i) => {
            const val = (row[i] ?? '').trim();
            obj[h] = val || null;
          });
          return obj;
        });
        const dateCols = headers.filter(colIsWeekday);
        if (dateCols.length > 0) {
          const daily: Record<string, Record<string, string | null>> = {};
          for (const r of csvRows) {
            const email = normEmail(String(r['Email'] ?? r['email'] ?? '')) ?? '';
            if (!email) continue;
            const dayData: Record<string, string | null> = {};
            for (const col of dateCols) {
              dayData[col] = r[col] != null ? String(r[col]) : null;
            }
            daily[email] = dayData;
          }
          await fetch('/api/app-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'hubstaff_daily_breakdown', value: JSON.stringify({ dateCols, daily }) }),
          }).catch(() => {});
        }
      }

      await loadHubstaffPreview();

      // Refresh source-file list (retry once so PostgREST read sees the new rows), then open that file
      let files = await loadUploadedSourceFiles();
      if (uploadedFileName && !files.includes(uploadedFileName)) {
        await new Promise((r) => setTimeout(r, 400));
        files = await loadUploadedSourceFiles();
      }
      if (uploadedFileName && files.includes(uploadedFileName)) {
        await loadSourceFileRows(uploadedFileName);
      }

      // Update calcSourceFile to the latest uploaded file so steps 2–4 use the new data
      if (files.length > 0) {
        setCalcSourceFile(files[files.length - 1]);
      }

      toast.success('Saved to hubstaff_hours', {
        description: `${json.rowCount ?? 0} rows appended to public.hubstaff_hours.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      toast.error('Upload failed', { description: msg });
    } finally {
      setWeeklyUploadLoading(false);
    }
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="space-y-6">
            {/* ── Tab switcher: Uploaded Files | Upload CSV ── */}
            <div className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-100 p-1 dark:border-zinc-800 dark:bg-zinc-900">
              <button
                type="button"
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  hubstaffActiveTab === 'files'
                    ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-white'
                    : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
                )}
                onClick={() => {
                  setHubstaffActiveTab('files');
                  void loadUploadedSourceFiles().then((files) => {
                    // Auto-select the latest uploaded file
                    if (files.length > 0 && !selectedSourceFile) {
                      void loadSourceFileRows(files[files.length - 1]);
                    }
                  });
                }}
              >
                <FileText className="h-3.5 w-3.5" />
                Uploaded Files
                {uploadedSourceFiles.length > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 min-w-[20px] justify-center px-1.5 text-[10px]">
                    {uploadedSourceFiles.length}
                  </Badge>
                )}
              </button>
              <button
                type="button"
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  hubstaffActiveTab === 'upload'
                    ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-white'
                    : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
                )}
                onClick={() => setHubstaffActiveTab('upload')}
              >
                <Upload className="h-3.5 w-3.5" />
                Upload CSV
              </button>
            </div>

            {/* ── TAB: Uploaded Files ── */}
            {hubstaffActiveTab === 'files' && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-semibold text-zinc-900 dark:text-white">Uploaded Files</h3>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    Browse uploads tracked by filename in the <span className="font-mono">source_file</span> column.
                    Delete removes only that batch; other files stay in{' '}
                    <span className="font-mono">hubstaff_hours</span>.
                  </p>
                </div>

                {sourceFilesLoading ? (
                  <div className="flex items-center justify-center gap-2 py-16 text-zinc-500">
                    <Loader2 className="h-6 w-6 animate-spin" />
                    <span>Loading uploaded files…</span>
                  </div>
                ) : uploadedSourceFiles.length === 0 ? (
                  <div className="flex flex-col items-center justify-center space-y-3 rounded-xl border-2 border-dashed border-zinc-300 p-12 text-center dark:border-zinc-800">
                    <FileText className="h-10 w-10 text-zinc-300 dark:text-zinc-700" />
                    <div>
                      <p className="font-medium text-zinc-600 dark:text-zinc-400">No uploaded files yet</p>
                      <p className="mt-1 text-xs text-zinc-500">
                        Switch to the <span className="font-medium">Upload CSV</span> tab to add Hubstaff data.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
                    {/* File list sidebar */}
                    <div className="space-y-1 rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950">
                      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                        Source Files ({uploadedSourceFiles.length})
                      </p>
                      <div className="max-h-[400px] overflow-y-auto">
                        {uploadedSourceFiles.map((file) => (
                          <div key={file} className="flex items-stretch gap-0.5">
                            <button
                              type="button"
                              className={cn(
                                'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors',
                                selectedSourceFile === file
                                  ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400'
                                  : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900',
                              )}
                              onClick={() => void loadSourceFileRows(file)}
                            >
                              <FileText
                                className={cn(
                                  'h-3.5 w-3.5 shrink-0',
                                  selectedSourceFile === file
                                    ? 'text-indigo-500 dark:text-indigo-400'
                                    : 'text-zinc-400',
                                )}
                              />
                              <span className="truncate font-mono">{file}</span>
                              {selectedSourceFile === file && (
                                <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-indigo-400" />
                              )}
                            </button>
                            <button
                              type="button"
                              className="shrink-0 rounded-md px-1.5 text-zinc-400 transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
                              title="Delete this upload from Supabase"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteSourceFilePending(file);
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* File data display */}
                    <div className="min-w-0">
                      {!selectedSourceFile ? (
                        <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-200 py-16 text-center dark:border-zinc-800">
                          <FileText className="h-8 w-8 text-zinc-300 dark:text-zinc-700" />
                          <p className="mt-2 text-sm text-zinc-500">Select a file to view its data</p>
                        </div>
                      ) : sourceFileLoading ? (
                        <div className="flex items-center justify-center gap-2 py-16 text-zinc-500">
                          <Loader2 className="h-6 w-6 animate-spin" />
                          <span>Loading data…</span>
                        </div>
                      ) : sourceFileRows && sourceFileRows.length > 0 ? (
                        (() => {
                          const activeCols = buildFullCols(sourceFileCols ?? Object.keys(sourceFileRows[0] ?? {}));
                          const needle = sourceFileSearch.toLowerCase().trim();
                          const filtered = needle
                            ? sourceFileRows.filter((row) =>
                                activeCols.some(({ key }) =>
                                  pickPreviewValue(row, key).toLowerCase().includes(needle),
                                ),
                              )
                            : sourceFileRows;
                          const totalPages = Math.max(1, Math.ceil(filtered.length / SOURCE_FILE_PAGE_SIZE));
                          const safePage = Math.min(sourceFilePage, totalPages);
                          const pageRows = filtered.slice(
                            (safePage - 1) * SOURCE_FILE_PAGE_SIZE,
                            safePage * SOURCE_FILE_PAGE_SIZE,
                          );
                          return (
                            <div className="space-y-3">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                                  <Check className="h-4 w-4 shrink-0" />
                                  {needle ? (
                                    <>{filtered.length} of {sourceFileRows.length} rows</>
                                  ) : (
                                    <>{sourceFileRows.length} rows · {activeCols.length} columns in <span className="font-mono text-xs">{selectedSourceFile}</span></>
                                  )}
                                </div>
                                <span className="text-xs text-zinc-500">
                                  Page {safePage} of {totalPages}
                                </span>
                              </div>

                              <div className="relative">
                                <svg
                                  className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400 pointer-events-none"
                                  fill="none" stroke="currentColor" strokeWidth="2"
                                  viewBox="0 0 24 24"
                                >
                                  <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                                </svg>
                                <Input
                                  placeholder="Search rows…"
                                  value={sourceFileSearch}
                                  onChange={(e) => { setSourceFileSearch(e.target.value); setSourceFilePage(1); }}
                                  className="h-8 pl-8 text-xs border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950"
                                />
                                {sourceFileSearch && (
                                  <button
                                    type="button"
                                    onClick={() => { setSourceFileSearch(''); setSourceFilePage(1); }}
                                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
                                  >
                                    ✕
                                  </button>
                                )}
                              </div>

                              <div className="overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800" style={{ maxHeight: 'min(60vh, calc(100dvh - 20rem))' }}>
                                <Table className="min-w-max">
                                  <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-20 [&_th]:bg-zinc-100/95 [&_th]:shadow-[0_1px_0_0_rgb(228_228_231)] dark:[&_th]:bg-zinc-900/95 dark:[&_th]:shadow-[0_1px_0_0_rgb(39_39_42)]">
                                    <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                                      {activeCols.map(({ key, label }) => (
                                        <TableHead key={key} className="whitespace-nowrap px-3 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                                          {label}
                                        </TableHead>
                                      ))}
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {pageRows.map((row, ri) => (
                                      <TableRow
                                        key={ri}
                                        className="border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/30"
                                      >
                                        {activeCols.map(({ key }) => {
                                          if (key === '__overtime__') {
                                            const totalSec = rawValueToTotalSeconds(row['Total worked']);
                                            const otSec = Math.max(0, totalSec - 40 * 3600);
                                            const otDisplay = otSec > 0 ? (otSec / 3600).toFixed(2) : '—';
                                            return (
                                              <TableCell key={key} className="whitespace-nowrap px-3 font-mono text-xs">
                                                <span className={otSec > 0 ? 'text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-zinc-400'}>
                                                  {otDisplay}
                                                </span>
                                              </TableCell>
                                            );
                                          }
                                          return (
                                            <TableCell key={key} className="whitespace-nowrap px-3 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                                              {pickPreviewValue(row, key)}
                                            </TableCell>
                                          );
                                        })}
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>

                              <div className="flex items-center justify-between pt-1">
                                <span className="text-xs text-zinc-400">
                                  {filtered.length === 0 ? 'No results' : (
                                    <>
                                      Showing {(safePage - 1) * SOURCE_FILE_PAGE_SIZE + 1}–
                                      {Math.min(safePage * SOURCE_FILE_PAGE_SIZE, filtered.length)} of{' '}
                                      {filtered.length}{needle ? ` (filtered from ${sourceFileRows.length})` : ''}
                                    </>
                                  )}
                                </span>
                                <div className="flex items-center gap-1">
                                  <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0 border-zinc-200 dark:border-zinc-800" disabled={safePage === 1} onClick={() => setSourceFilePage(1)}>«</Button>
                                  <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0 border-zinc-200 dark:border-zinc-800" disabled={safePage === 1} onClick={() => setSourceFilePage((p) => Math.max(1, p - 1))}>‹</Button>
                                  {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                                    const page = totalPages <= 5 ? i + 1 : safePage <= 3 ? i + 1 : safePage >= totalPages - 2 ? totalPages - 4 + i : safePage - 2 + i;
                                    return (
                                      <Button key={page} type="button" variant={safePage === page ? 'default' : 'outline'} size="sm" className={cn('h-7 w-7 p-0 text-xs', safePage === page ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'border-zinc-200 dark:border-zinc-800')} onClick={() => setSourceFilePage(page)}>{page}</Button>
                                    );
                                  })}
                                  <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0 border-zinc-200 dark:border-zinc-800" disabled={safePage === totalPages} onClick={() => setSourceFilePage((p) => Math.min(totalPages, p + 1))}>›</Button>
                                  <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0 border-zinc-200 dark:border-zinc-800" disabled={safePage === totalPages} onClick={() => setSourceFilePage(totalPages)}>»</Button>
                                </div>
                              </div>
                            </div>
                          );
                        })()
                      ) : (
                        <div className="flex items-center gap-2 rounded-lg border border-zinc-200 px-4 py-3 text-sm text-zinc-500 dark:border-zinc-800">
                          No data found for this file.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── TAB: Upload CSV (original content) ── */}
            {hubstaffActiveTab === 'upload' && (
              <div className="space-y-6">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-zinc-900 dark:text-white">Upload Hubstaff weekly report</h3>
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                      Choose your Hubstaff export CSV. After you confirm, the rows are appended to the{' '}
                      <span className="font-mono text-zinc-500">public.hubstaff_hours</span> table in Supabase (existing
                      data is preserved). Requires <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span> in{' '}
                      <span className="font-mono">.env</span>.
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-stretch gap-3 sm:flex-row sm:items-center">
                    <div className="flex items-center space-x-2 rounded-full border border-zinc-200 bg-zinc-100 px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
                      <Label htmlFor="hogan-switch" className="text-xs text-zinc-400">
                        Hogan cycle
                      </Label>
                      <Switch id="hogan-switch" checked={isHoganCycle} onCheckedChange={setIsHoganCycle} />
                    </div>

                    <Button
                      type="button"
                      disabled={weeklyUploadLoading}
                      onClick={() => fileInputWeeklyRef.current?.click()}
                      className="gap-2 bg-indigo-600 text-white hover:bg-indigo-700"
                    >
                      {weeklyUploadLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4" />
                      )}
                      Upload Hubstaff Weekly Report
                    </Button>

                    <input
                      type="file"
                      ref={fileInputWeeklyRef}
                      onChange={(ev) => void handleWeeklyFileChosen(ev)}
                      accept=".csv,.CSV,text/csv,application/csv,text/plain"
                      className="hidden"
                    />
                  </div>
                </div>

                <Card className="border-zinc-200 bg-zinc-50/80 ring-0 dark:border-zinc-800 dark:bg-zinc-900/40">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-zinc-800 dark:text-zinc-200">Supabase target</CardTitle>
                    <CardDescription className="text-xs text-zinc-600 dark:text-zinc-400">
                      Table <span className="font-mono">public.hubstaff_hours</span> — new uploads are appended without
                      overwriting existing data.
                    </CardDescription>
                  </CardHeader>
                </Card>

                {uploadedSourceFiles.length > 0 && (
                  <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                      Uploaded batches (delete removes rows in Supabase)
                    </p>
                    <ul className="max-h-[200px] space-y-1 overflow-y-auto">
                      {uploadedSourceFiles.map((file) => (
                        <li
                          key={file}
                          className="flex items-center gap-2 rounded-md border border-zinc-100 bg-zinc-50/80 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/50"
                        >
                          <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">
                            {file}
                          </span>
                          <button
                            type="button"
                            className="shrink-0 rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
                            title="Delete this batch from Supabase"
                            onClick={() => setDeleteSourceFilePending(file)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {hubstaffPreviewError && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{hubstaffPreviewError}</span>
                  </div>
                )}

                {hubstaffPreviewLoading ? (
                  <div className="flex items-center justify-center gap-2 py-16 text-zinc-500">
                    <Loader2 className="h-6 w-6 animate-spin" />
                    <span>Loading hubstaff_hours…</span>
                  </div>
                ) : hubstaffDisplayRows && hubstaffDisplayRows.length > 0 ? (
                  (() => {
                    const activeCols = buildPreviewCols(hubstaffDisplayColumns ?? Object.keys(hubstaffDisplayRows[0] ?? {}));
                    const needle = hubstaffSearch.toLowerCase().trim();
                    const filtered = needle
                      ? hubstaffDisplayRows.filter((row) =>
                          activeCols.some(({ key }) =>
                            pickPreviewValue(row, key).toLowerCase().includes(needle),
                          ),
                        )
                      : hubstaffDisplayRows;
                    const totalPages = Math.max(1, Math.ceil(filtered.length / HUBSTAFF_PAGE_SIZE));
                    const safePage = Math.min(hubstaffPage, totalPages);
                    const pageRows = filtered.slice(
                      (safePage - 1) * HUBSTAFF_PAGE_SIZE,
                      safePage * HUBSTAFF_PAGE_SIZE,
                    );
                    return (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                            <Check className="h-4 w-4 shrink-0" />
                            {needle ? (
                              <>{filtered.length} of {hubstaffDisplayRows.length} rows</>
                            ) : (
                              <>{hubstaffDisplayRows.length} rows in <span className="font-mono">public.hubstaff_hours</span></>
                            )}
                          </div>
                          <span className="text-xs text-zinc-500">
                            Page {safePage} of {totalPages}
                          </span>
                        </div>

                        <div className="relative">
                          <svg
                            className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400 pointer-events-none"
                            fill="none" stroke="currentColor" strokeWidth="2"
                            viewBox="0 0 24 24"
                          >
                            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                          </svg>
                          <Input
                            placeholder="Search member, email, hours…"
                            value={hubstaffSearch}
                            onChange={(e) => { setHubstaffSearch(e.target.value); setHubstaffPage(1); }}
                            className="h-8 pl-8 text-xs border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950"
                          />
                          {hubstaffSearch && (
                            <button
                              type="button"
                              onClick={() => { setHubstaffSearch(''); setHubstaffPage(1); }}
                              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
                            >
                              ✕
                            </button>
                          )}
                        </div>

                        <Table>
                          <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-20 [&_th]:bg-zinc-100/95 [&_th]:shadow-[0_1px_0_0_rgb(228_228_231)] dark:[&_th]:bg-zinc-900/95 dark:[&_th]:shadow-[0_1px_0_0_rgb(39_39_42)]">
                            <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                              {activeCols.map(({ key, label }) => (
                                <TableHead key={key} className="whitespace-nowrap text-xs font-medium text-zinc-600 dark:text-zinc-400">
                                  {label}
                                </TableHead>
                              ))}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {pageRows.map((row, ri) => (
                              <TableRow
                                key={ri}
                                className="border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/30"
                              >
                                {activeCols.map(({ key }) => {
                                  if (key === '__overtime__') {
                                    const totalSec = rawValueToTotalSeconds(row['Total worked']);
                                    const otSec = Math.max(0, totalSec - 40 * 3600);
                                    const otDisplay = otSec > 0
                                      ? (otSec / 3600).toFixed(2)
                                      : '—';
                                    return (
                                      <TableCell key={key} className="max-w-[200px] truncate font-mono text-xs">
                                        <span className={otSec > 0 ? 'text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-zinc-400'}>
                                          {otDisplay}
                                        </span>
                                      </TableCell>
                                    );
                                  }
                                  return (
                                    <TableCell key={key} className="max-w-[200px] truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">
                                      {pickPreviewValue(row, key)}
                                    </TableCell>
                                  );
                                })}
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>

                        <div className="flex items-center justify-between pt-1">
                          <span className="text-xs text-zinc-400">
                            {filtered.length === 0 ? 'No results' : (
                              <>
                                Showing {(safePage - 1) * HUBSTAFF_PAGE_SIZE + 1}–
                                {Math.min(safePage * HUBSTAFF_PAGE_SIZE, filtered.length)} of{' '}
                                {filtered.length}{needle ? ` (filtered from ${hubstaffDisplayRows.length})` : ''}
                              </>
                            )}
                          </span>
                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 w-7 p-0 border-zinc-200 dark:border-zinc-800"
                              disabled={safePage === 1}
                              onClick={() => setHubstaffPage(1)}
                            >
                              «
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 w-7 p-0 border-zinc-200 dark:border-zinc-800"
                              disabled={safePage === 1}
                              onClick={() => setHubstaffPage((p) => Math.max(1, p - 1))}
                            >
                              ‹
                            </Button>
                            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                              const page = totalPages <= 5
                                ? i + 1
                                : safePage <= 3
                                  ? i + 1
                                  : safePage >= totalPages - 2
                                    ? totalPages - 4 + i
                                    : safePage - 2 + i;
                              return (
                                <Button
                                  key={page}
                                  type="button"
                                  variant={safePage === page ? 'default' : 'outline'}
                                  size="sm"
                                  className={cn(
                                    'h-7 w-7 p-0 text-xs',
                                    safePage === page
                                      ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                                      : 'border-zinc-200 dark:border-zinc-800',
                                  )}
                                  onClick={() => setHubstaffPage(page)}
                                >
                                  {page}
                                </Button>
                              );
                            })}
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 w-7 p-0 border-zinc-200 dark:border-zinc-800"
                              disabled={safePage === totalPages}
                              onClick={() => setHubstaffPage((p) => Math.min(totalPages, p + 1))}
                            >
                              ›
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 w-7 p-0 border-zinc-200 dark:border-zinc-800"
                              disabled={safePage === totalPages}
                              onClick={() => setHubstaffPage(totalPages)}
                            >
                              »
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })()
                ) : hubstaffDisplayRows && hubstaffDisplayRows.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-lg border border-zinc-200 px-4 py-3 text-sm text-zinc-500 dark:border-zinc-800">
                    <Check className="h-4 w-4 shrink-0 text-emerald-500" />
                    Table is empty — upload a weekly CSV to populate{' '}
                    <span className="font-mono text-zinc-700 dark:text-zinc-300">public.hubstaff_hours</span>.
                  </div>
                ) : (
                  <div
                    className="flex cursor-pointer flex-col items-center justify-center space-y-4 rounded-xl border-2 border-dashed border-zinc-300 p-12 text-center transition-colors hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-700"
                    onClick={() => fileInputWeeklyRef.current?.click()}
                  >
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-900">
                      <Upload className="h-6 w-6 text-zinc-500" />
                    </div>
                    <div>
                      <p className="font-medium text-zinc-700 dark:text-zinc-300">Upload Hubstaff weekly report CSV</p>
                      <p className="mt-1 text-xs text-zinc-500">
                        Rows will be appended to existing data — previous uploads are preserved.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      case 2: {
        const initialCalcDataLoading =
          hourlyRatesLoading ||
          calcSourceFileLoading ||
          sourceFilesLoading ||
          unfilteredHubstaffLoading ||
          (uploadedSourceFiles.length > 0 && calcSourceFile == null);
        return (
          <div className="space-y-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-white">Initial Calculation</h3>
                {calcSourceFile && (
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-indigo-600 dark:text-indigo-400">
                    <FileText className="h-3 w-3 shrink-0" />
                    <span className="font-mono">{calcSourceFile}</span>
                  </div>
                )}
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  <span className="font-mono">Reg Hrs</span> = min(Total Hrs, 40),{' '}
                  <span className="font-mono">OT Hrs</span> = max(0, Total Hrs − 40). Hours from{' '}
                  <span className="font-mono text-zinc-500">hubstaff_hours</span>. Match Hubstaff{' '}
                  <span className="font-mono">Email</span> to <span className="font-mono">Work Email</span> in{' '}
                  <span className="font-mono text-zinc-500">employee_hourly_rates</span> (Personal Email also used if present).
                  <span className="font-mono"> Reg Pay</span> = Reg Rate × Reg Hrs, <span className="font-mono">OT Pay</span> = OT Rate × OT Hrs,{' '}
                  <span className="font-mono">Initial Pay</span> = Reg Pay + OT Pay.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5 border-zinc-200 dark:border-zinc-800"
                disabled={hourlyRatesLoading}
                onClick={() => void loadEmployeeHourlyRates()}
              >
                {hourlyRatesLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <DollarSign className="h-3.5 w-3.5" />
                )}
                Refresh rates
              </Button>
            </div>

            {/* Source file selector */}
            {uploadedSourceFiles.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50/60 px-4 py-3 dark:border-indigo-800/50 dark:bg-indigo-950/30">
                <FileText className="h-4 w-4 shrink-0 text-indigo-500" />
                <div className="flex flex-1 flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-indigo-900 dark:text-indigo-200">Source CSV</span>
                  <span className="text-xs text-indigo-700/70 dark:text-indigo-400/70">(latest uploaded file selected by default)</span>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={calcSourceFile ?? ''}
                    onChange={(e) => setCalcSourceFile(e.target.value || null)}
                    className="h-8 rounded-md border border-indigo-300 bg-white px-2 pr-7 font-mono text-xs dark:border-indigo-700 dark:bg-zinc-950 dark:text-zinc-200"
                  >
                    {uploadedSourceFiles.map((file) => (
                      <option key={file} value={file}>{file}</option>
                    ))}
                  </select>
                  {calcSourceFileLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />}
                </div>
              </div>
            )}

            {/* USD → PHP exchange rate */}
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-200 bg-blue-50/60 px-4 py-3 dark:border-blue-800/50 dark:bg-blue-950/30">
              <DollarSign className="h-4 w-4 shrink-0 text-blue-500" />
              <div className="flex flex-1 flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-blue-900 dark:text-blue-200">USD → PHP Rate</span>
                <span className="text-xs text-blue-700/70 dark:text-blue-400/70">(1 USD =)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm font-medium text-blue-600 dark:text-blue-400">
                    ₱
                  </span>
                  <Input
                    type="number"
                    min="0.00001"
                    step="0.00001"
                    value={usdToPhpInput}
                    readOnly={!usdToPhpEditing}
                    onChange={(e) => setUsdToPhpInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && usdToPhpEditing) {
                        const parsed = parseFloat(usdToPhpInput);
                        if (Number.isFinite(parsed) && parsed > 0) {
                          setUsdToPhpRate(parsed);
                          setUsdToPhpSaving(true);
                          fetch('/api/app-settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ key: 'usd_to_php_rate', value: String(parsed) }),
                          })
                            .then(async (res) => {
                              const json = (await res.json()) as { error: string | null };
                              if (!res.ok || json.error) throw new Error(json.error ?? 'Save failed');
                              toast.success(`Rate saved: ₱${parsed.toFixed(2)} / USD`);
                              setUsdToPhpEditing(false);
                            })
                            .catch((err: unknown) =>
                              toast.error(`Failed to save rate: ${err instanceof Error ? err.message : 'Unknown error'}`),
                            )
                            .finally(() => setUsdToPhpSaving(false));
                        }
                      }
                    }}
                    className={`h-8 min-w-[7rem] border-blue-300 pl-6 pr-2 font-mono text-sm tabular-nums dark:border-blue-700 ${usdToPhpEditing ? 'bg-white dark:bg-zinc-950' : 'cursor-default bg-blue-50 dark:bg-blue-950/40'}`}
                  />
                </div>
                {!usdToPhpEditing ? (
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 dark:text-white"
                    onClick={() => setUsdToPhpEditing(true)}
                  >
                    Edit rate
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    disabled={usdToPhpSaving}
                    className="h-8 bg-green-600 px-3 text-xs font-semibold text-white hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-400 dark:text-white"
                    onClick={() => {
                      const parsed = parseFloat(usdToPhpInput);
                      if (!Number.isFinite(parsed) || parsed <= 0) {
                        toast.error('Enter a valid positive rate');
                        return;
                      }
                      setUsdToPhpRate(parsed);
                      setUsdToPhpSaving(true);
                      fetch('/api/app-settings', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ key: 'usd_to_php_rate', value: String(parsed) }),
                      })
                        .then(async (res) => {
                          const json = (await res.json()) as { error: string | null };
                          if (!res.ok || json.error) throw new Error(json.error ?? 'Save failed');
                          toast.success(`Rate saved: ₱${parsed.toFixed(2)} / USD`);
                          setUsdToPhpEditing(false);
                        })
                        .catch((err: unknown) =>
                          toast.error(`Failed to save rate: ${err instanceof Error ? err.message : 'Unknown error'}`),
                        )
                        .finally(() => setUsdToPhpSaving(false));
                    }}
                  >
                    {usdToPhpSaving ? <Loader2 className="h-3 w-3 animate-spin text-white" /> : 'Apply & Save'}
                  </Button>
                )}
              </div>
              <p className="w-full text-xs text-blue-700/60 dark:text-blue-400/60">
                Divides PHP Initial Pay by this rate for the USD column. Default official rate: ₱
                {OFFICIAL_USD_TO_PHP_RATE.toFixed(USD_TO_PHP_DECIMAL_SHIFT)} per $1 (₱
                {PHILIPPINE_PESO_OFFICIAL.toLocaleString('en-PH')} ÷ 10^{USD_TO_PHP_DECIMAL_SHIFT}). Current:{' '}
                <span className="font-mono font-semibold">₱{usdToPhpRate.toFixed(5)}</span> = $1 USD.
                {usdToPhpEditing && (
                  <>
                    {' '}
                    Press{' '}
                    <kbd className="rounded border border-blue-300 bg-blue-100 px-1 py-0.5 font-mono text-[10px] dark:border-blue-700 dark:bg-blue-900">
                      Enter
                    </kbd>{' '}
                    or Apply &amp; Save to confirm.
                  </>
                )}
              </p>
            </div>

            {hourlyRatesError && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{hourlyRatesError}</span>
              </div>
            )}

            {/* Warning banner for employees missing rates */}
            {(() => {
              if (initialCalcDataLoading) return null;
              const missingCount = effectiveCalcResults.filter(r => r.regularRate == null).length;
              if (missingCount === 0 || effectiveCalcResults.length === 0) return null;
              return (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <div>
                    <span className="font-semibold">{missingCount} of {effectiveCalcResults.length} employees</span>{' '}
                    have no matching rate in <span className="font-mono text-xs">employee_hourly_rates</span>.
                    Their Hubstaff email was not found as a <span className="font-mono text-xs">Work Email</span> or{' '}
                    <span className="font-mono text-xs">Personal Email</span> in the rates table.
                    Add their rates in Supabase to calculate pay.
                  </div>
                </div>
              );
            })()}

            {initialCalcDataLoading ? (
              <div
                role="status"
                aria-busy="true"
                aria-label="Loading initial calculation"
                className="min-h-0 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800"
              >
                <span className="sr-only">Loading initial calculation…</span>
                <div className="max-h-[min(70vh,calc(100dvh-13rem))] overflow-auto">
                  <Table className="w-full min-w-[1100px] table-fixed">
                    <colgroup>
                      <col className="w-[10%]" />
                      <col className="w-[18%]" />
                      <col className="w-[7%]" />
                      <col className="w-[7%]" />
                      <col className="w-[7%]" />
                      <col className="w-[8%]" />
                      <col className="w-[8%]" />
                      <col className="w-[9%]" />
                      <col className="w-[9%]" />
                      <col className="w-[9%]" />
                    </colgroup>
                    <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-20 [&_th]:bg-zinc-100/95 [&_th]:shadow-[0_1px_0_0_rgb(228_228_231)] dark:[&_th]:bg-zinc-900/95 dark:[&_th]:shadow-[0_1px_0_0_rgb(39_39_42)]">
                      <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                        <TableHead className="px-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-400">Member</TableHead>
                        <TableHead className="px-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-400">Work Email</TableHead>
                        <TableHead className="px-2 text-right text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-400">Total Hrs</TableHead>
                        <TableHead className="px-2 text-right text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-400">Reg Hrs</TableHead>
                        <TableHead className="px-2 text-right text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-400">OT Hrs</TableHead>
                        <TableHead className="px-2 text-right text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-400">Reg Rate</TableHead>
                        <TableHead className="px-2 text-right text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-400">OT Rate</TableHead>
                        <TableHead className="px-2 text-right text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-400">Reg Pay</TableHead>
                        <TableHead className="px-2 text-right text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-400">OT Pay</TableHead>
                        <TableHead className="px-2 text-right text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-400">
                          <div>Initial Pay</div>
                          <div className="text-[10px] font-normal text-blue-500 dark:text-blue-400">≈ USD</div>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {Array.from({ length: 8 }).map((_, i) => (
                        <TableRow key={i} className="border-zinc-200 dark:border-zinc-800">
                          {/* Member */}
                          <TableCell className="px-2 py-3 align-middle">
                            <div className="initial-calc-skeleton-bar h-3 w-20 rounded-full" />
                          </TableCell>
                          {/* Work Email */}
                          <TableCell className="px-2 py-3 align-middle">
                            <div
                              className="initial-calc-skeleton-bar h-3 max-w-full rounded-full"
                              style={{ width: `${60 + (i % 4) * 10}%` }}
                            />
                          </TableCell>
                          {/* Total Hrs */}
                          <TableCell className="px-2 py-3 align-middle">
                            <div className="initial-calc-skeleton-bar ml-auto h-3 w-10 rounded-full" />
                          </TableCell>
                          {/* Reg Hrs */}
                          <TableCell className="px-2 py-3 align-middle">
                            <div className="initial-calc-skeleton-bar ml-auto h-3 w-10 rounded-full" />
                          </TableCell>
                          {/* OT Hrs */}
                          <TableCell className="px-2 py-3 align-middle">
                            <div className="initial-calc-skeleton-bar ml-auto h-3 w-8 rounded-full" />
                          </TableCell>
                          {/* Reg Rate */}
                          <TableCell className="px-2 py-3 align-middle">
                            <div className="initial-calc-skeleton-bar ml-auto h-3 w-14 rounded-full" />
                          </TableCell>
                          {/* OT Rate */}
                          <TableCell className="px-2 py-3 align-middle">
                            <div className="initial-calc-skeleton-bar ml-auto h-3 w-14 rounded-full" />
                          </TableCell>
                          {/* Reg Pay */}
                          <TableCell className="px-2 py-3 align-middle">
                            <div className="initial-calc-skeleton-bar ml-auto h-3 w-16 rounded-full" />
                          </TableCell>
                          {/* OT Pay */}
                          <TableCell className="px-2 py-3 align-middle">
                            <div className="initial-calc-skeleton-bar ml-auto h-3 w-16 rounded-full" />
                          </TableCell>
                          {/* Initial Pay (two lines) */}
                          <TableCell className="px-2 py-3 align-middle">
                            <div className="flex flex-col items-end gap-1.5">
                              <div className="initial-calc-skeleton-bar h-3 w-20 rounded-full" />
                              <div className="initial-calc-skeleton-bar h-2.5 w-14 rounded-full" />
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ) : effectiveCalcResults.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-zinc-200 px-4 py-3 text-sm text-zinc-500 dark:border-zinc-800">
                <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />
                No Hubstaff hours data found. Go back to step 1 and upload a weekly report first.
              </div>
            ) : (
              <div className="flex min-h-0 flex-col gap-0">
                {/* Detached from table: stays visible while the sheet scrolls; not inside the table scrollport */}
                <div className="sticky top-0 z-30 -mx-4 mb-3 flex shrink-0 flex-col gap-2 rounded-xl border border-zinc-200 bg-white/95 px-4 py-2.5 shadow-sm backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between md:-mx-8 md:px-8 dark:border-zinc-800 dark:bg-zinc-950/95">
                  <div className="text-sm text-zinc-600 dark:text-zinc-400">
                    {initialCalcSearch.trim() ? (
                      <>
                        Showing <span className="font-medium text-zinc-800 dark:text-zinc-200">{filteredCalcResults.length}</span> of{' '}
                        {effectiveCalcResults.length} rows
                      </>
                    ) : (
                      <>
                        {effectiveCalcResults.length} {effectiveCalcResults.length === 1 ? 'row' : 'rows'}
                        {(() => {
                          const matched = effectiveCalcResults.filter(r => r.regularRate != null).length;
                          const missing = effectiveCalcResults.length - matched;
                          if (missing === 0) return (
                            <span className="ml-2 text-emerald-600 dark:text-emerald-400">— all matched</span>
                          );
                          return (
                            <>
                              <span className="ml-2 text-emerald-600 dark:text-emerald-400">{matched} matched</span>
                              <span className="ml-1 text-amber-600 dark:text-amber-400">· {missing} missing rate</span>
                            </>
                          );
                        })()}
                      </>
                    )}
                  </div>
                  <div className="relative w-full sm:max-w-sm">
                    <svg
                      className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400 pointer-events-none"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                    >
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.35-4.35" />
                    </svg>
                    <Input
                      placeholder="Search member, email, hours, rates, pay…"
                      value={initialCalcSearch}
                      onChange={(e) => setInitialCalcSearch(e.target.value)}
                      className="h-8 border-zinc-200 bg-white pl-8 pr-8 text-xs dark:border-zinc-800 dark:bg-zinc-950"
                    />
                    {initialCalcSearch && (
                      <button
                        type="button"
                        onClick={() => setInitialCalcSearch('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                        aria-label="Clear search"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>

                {/* Only the grid scrolls; header cells stay pinned inside this region */}
                <div className="min-h-0 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
                  <div className="max-h-[min(70vh,calc(100dvh-13rem))] overflow-auto">
                  <Table className="w-full min-w-[1100px] table-fixed">
                    <colgroup>
                      <col className="w-[10%]" />
                      <col className="w-[18%]" />
                      <col className="w-[7%]" />
                      <col className="w-[7%]" />
                      <col className="w-[7%]" />
                      <col className="w-[8%]" />
                      <col className="w-[8%]" />
                      <col className="w-[9%]" />
                      <col className="w-[9%]" />
                      <col className="w-[9%]" />
                    </colgroup>
                    <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-20 [&_th]:bg-zinc-100/95 [&_th]:shadow-[0_1px_0_0_rgb(228_228_231)] dark:[&_th]:bg-zinc-900/95 dark:[&_th]:shadow-[0_1px_0_0_rgb(39_39_42)]">
                      <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                        <TableHead className="px-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-400">
                          Member
                        </TableHead>
                        <TableHead className="px-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-400">
                          Work Email
                        </TableHead>
                        <TableHead className="px-2 text-right text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-400">
                          Total Hrs
                        </TableHead>
                        <TableHead className="px-2 text-right text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-400">
                          Reg Hrs
                        </TableHead>
                        <TableHead className="px-2 text-right text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-400">
                          OT Hrs
                        </TableHead>
                        <TableHead className="px-2 text-right text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-400">
                          Reg Rate
                        </TableHead>
                        <TableHead className="px-2 text-right text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-400">
                          OT Rate
                        </TableHead>
                        <TableHead className="px-2 text-right text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-400">
                          Reg Pay
                        </TableHead>
                        <TableHead className="px-2 text-right text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-400">
                          OT Pay
                        </TableHead>
                        <TableHead className="px-2 text-right text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-400">
                          <div>Initial Pay</div>
                          <div className="text-[10px] font-normal text-blue-500 dark:text-blue-400">≈ USD</div>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredCalcResults.length === 0 ? (
                        <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                          <TableCell
                            colSpan={10}
                            className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400"
                          >
                            No rows match &quot;{initialCalcSearch.trim()}&quot;
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredCalcResults.map((row, i) => (
                        <TableRow
                          key={`${row.email}-${i}`}
                          className={cn(
                            "border-zinc-200 dark:border-zinc-800",
                            row.regularRate == null
                              ? "bg-amber-50/60 hover:bg-amber-50 dark:bg-amber-950/20 dark:hover:bg-amber-950/30"
                              : "hover:bg-zinc-50 dark:hover:bg-zinc-900/30",
                          )}
                        >
                          <TableCell className="px-2 align-middle text-xs font-medium text-zinc-800 dark:text-zinc-200">
                            <span className="block truncate" title={row.name || undefined}>
                              {row.name || '—'}
                            </span>
                          </TableCell>
                          <TableCell className="px-2 align-middle text-xs text-zinc-500">
                            <span className="min-w-0 break-all font-mono text-[11px] leading-snug sm:text-xs">
                              {row.email}
                            </span>
                          </TableCell>
                          <TableCell className="px-2 text-right align-middle font-mono text-xs tabular-nums text-zinc-700 dark:text-zinc-300">
                            {row.totalHours.toFixed(2)}
                          </TableCell>
                          <TableCell className="px-2 text-right align-middle font-mono text-xs tabular-nums text-zinc-700 dark:text-zinc-300">
                            {row.regularHours.toFixed(2)}
                          </TableCell>
                          <TableCell className="px-2 text-right align-middle font-mono text-xs tabular-nums">
                            {row.otHours > 0 ? (
                              <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                                {row.otHours.toFixed(2)}
                              </span>
                            ) : (
                              <span className="text-zinc-400">—</span>
                            )}
                          </TableCell>
                          <TableCell className="px-2 text-right align-middle font-mono text-xs tabular-nums text-zinc-700 dark:text-zinc-300">
                            {row.regularRate != null ? formatPHP(row.regularRate) : (
                              <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">No rate</span>
                            )}
                          </TableCell>
                          <TableCell className="px-2 text-right align-middle font-mono text-xs tabular-nums text-zinc-700 dark:text-zinc-300">
                            {row.otRate != null ? formatPHP(row.otRate) : (
                              <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">No rate</span>
                            )}
                          </TableCell>
                          <TableCell className="px-2 text-right align-middle font-mono text-xs tabular-nums text-zinc-800 dark:text-zinc-200">
                            {row.regularPay != null ? formatPHP(row.regularPay) : (
                              <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">—</span>
                            )}
                          </TableCell>
                          <TableCell className="px-2 text-right align-middle font-mono text-xs tabular-nums">
                            {row.otHours > 0 ? (
                              row.otPay != null ? (
                                <span className="font-medium text-indigo-600 dark:text-indigo-400">
                                  {formatPHP(row.otPay)}
                                </span>
                              ) : (
                                <span className="text-zinc-400">—</span>
                              )
                            ) : (
                              <span className="text-zinc-400">—</span>
                            )}
                          </TableCell>
                          <TableCell className="px-2 text-right align-middle tabular-nums">
                            {row.initialPay != null ? (
                              <div className="flex flex-col items-end gap-0.5">
                                <span className="font-mono text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                                  {formatPHP(row.initialPay)}
                                </span>
                                <span className="font-mono text-[10px] text-blue-500 dark:text-blue-400">
                                  ≈&nbsp;${(row.initialPay / usdToPhpRate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </span>
                              </div>
                            ) : (
                              <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">Missing rate</span>
                            )}
                          </TableCell>
                        </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      }
      case 3: {
        const activeDept = DEPARTMENTS.find(d => d.key === activeDeptTab) ?? DEPARTMENTS[0]!;
        const deptEmployees = effectiveCalcResults.filter(r => employeeDepts[r.email] === activeDeptTab);
        const unassignedEmployees = effectiveCalcResults.filter(r => !employeeDepts[r.email]);
        const totalBonusesAdded = Object.values(bonusTotals).reduce((sum, v) => sum + v, 0);
        const assignedEmployees = effectiveCalcResults.filter(r => employeeDepts[r.email]);
        const totalFinalPay = assignedEmployees.reduce(
          (sum, r) => sum + (r.initialPay ?? 0) + (bonusTotals[r.email] ?? 0),
          0,
        );
        // QC derived values (used in both left panel and table)
        const qcUnitsSold = deptMetrics['qc']?.unitsSold ?? 0;
        const standardQcMembers = activeDeptTab === 'qc'
          ? deptEmployees.filter(e => !isJeromeRosero(e.name))
          : [];
        const qcPoolRate = standardQcMembers.length >= 6 ? 150 : 125;
        const qcPoolPerMember = standardQcMembers.length > 0
          ? (qcUnitsSold * qcPoolRate) / standardQcMembers.length
          : 0;
        // HR derived values (used in both left panel and table)
        const hrNewHires = deptMetrics['hr']?.newHires ?? 0;
        const hrBillableMembers = activeDeptTab === 'hr'
          ? deptEmployees.filter(e => !isTeal(e.name))
          : [];
        const hrPoolShare = hrBillableMembers.length > 0 && hrNewHires > 0
          ? (hrBillableMembers.length * 1000) / hrNewHires
          : 0;

        return (
          <div className="flex min-w-0 flex-col gap-5">
            {/* Header */}
            <div className="flex flex-col gap-4 rounded-xl border border-zinc-200/90 bg-gradient-to-br from-white via-zinc-50/80 to-indigo-50/30 p-4 shadow-sm sm:p-5 dark:border-zinc-800 dark:from-zinc-950/50 dark:via-zinc-900/40 dark:to-indigo-950/20">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-white">
                  Additions — Department Bonuses
                </h3>
                {calcSourceFile && (
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-indigo-600 dark:text-indigo-400">
                    <FileText className="h-3 w-3 shrink-0" />
                    <span className="font-mono">{calcSourceFile}</span>
                  </div>
                )}
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  Assign employees to departments and apply bonuses. All 12 departments share a{' '}
                  <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                    Technology Bonus (₱1,850)
                  </span>{' '}
                  and a{' '}
                  <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                    Perfect Attendance Bonus (₱5,000)
                  </span>.
                </p>
                {pabMonthRange && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs text-indigo-600 dark:text-indigo-400">
                    <CalendarDays className="h-3 w-3 shrink-0" />
                    <span>
                      PAB period: <span className="font-semibold">{pabMonthRange.monthName} {pabMonthRange.year}</span>
                      {' '}({pabMonthRange.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      {' – '}
                      {pabMonthRange.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})
                      {' · '}
                      {weekdayColumnGroups.length}/{pabExpectedMonFriCount} Mon–Fri day
                      {pabExpectedMonFriCount !== 1 ? 's' : ''} in range
                      {pabMonthColumnCoverageComplete ? ' (complete)' : ' (need full month)'}
                    </span>
                  </div>
                )}
                {pabMonthRange && hubstaffColsForPab && !pabMonthColumnCoverageComplete && (
                  <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-400">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      <strong>Monthly PAB needs all workdays in range.</strong> Hubstaff has{' '}
                      {weekdayColumnGroups.length} of {pabExpectedMonFriCount} Mon–Fri columns merged. Append or re-upload
                      weekly exports in <strong>Step 1</strong> until every weekday in the PAB period is present—PAB will not
                      use the single &quot;calc file&quot; week alone.
                    </span>
                  </div>
                )}
                {dailyDataMissing && (
                  <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      <strong>Perfect Attendance cannot be detected.</strong> The daily hours breakdown (Mon–Fri columns) is empty in Supabase.
                      PAB is evaluated monthly (all uploaded CSVs). Go back to <strong>Step 1</strong> and <strong>re-upload the Hubstaff CSVs</strong> — daily data will be stored correctly.
                    </span>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {unassignedEmployees.length > 0 && (
                  <div className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {unassignedEmployees.length} unassigned
                  </div>
                )}
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-right">
                  <div className="text-[10px] text-emerald-600 dark:text-emerald-400">Total Bonuses</div>
                  <div className="font-mono text-sm font-bold text-emerald-700 dark:text-emerald-300">
                    +{formatPHP(totalBonusesAdded)}
                  </div>
                </div>
                {totalFinalPay > 0 && (
                  <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-3 py-2 text-right">
                    <div className="text-[10px] text-indigo-600 dark:text-indigo-400">Assigned Final Pay</div>
                    <div className="font-mono text-sm font-bold text-indigo-700 dark:text-indigo-300">
                      {formatPHP(totalFinalPay)}
                    </div>
                  </div>
                )}
              </div>
              </div>
            </div>

            {/* Department Tabs */}
            <div className="flex gap-1.5 overflow-x-auto pb-1 [-ms-overflow-style:none] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-300/80 dark:[&::-webkit-scrollbar-thumb]:bg-zinc-600">
              {DEPARTMENTS.map(dept => {
                const count = effectiveCalcResults.filter(r => employeeDepts[r.email] === dept.key).length;
                return (
                  <button
                    key={dept.key}
                    type="button"
                    onClick={() => { setActiveDeptTab(dept.key); setAdditionsSearch(''); }}
                    className={cn(
                      'flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                      activeDeptTab === dept.key
                        ? 'border-indigo-500/50 bg-indigo-600/10 text-indigo-700 dark:text-indigo-300'
                        : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/50',
                    )}
                  >
                    {dept.name}
                    {count > 0 && (
                      <span
                        className={cn(
                          'rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none',
                          activeDeptTab === dept.key
                            ? 'bg-indigo-600 text-white'
                            : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400',
                        )}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Main layout — single page scroll (wizard ScrollArea); wide table uses horizontal scroll only when needed */}
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,220px)_minmax(0,1fr)] xl:items-start xl:gap-4">
              {/* Left column: Bonus config + Assign panel */}
              <div className="min-w-0 space-y-4">
                {/* Common Bonuses card removed — PAB counters live per-row in the dept table */}

                {/* Dept-specific Bonus Panel — hover-info for formulas, action card for toggles */}
                <DeptFormulaInfo deptKey={activeDeptTab} deptName={activeDept.name} />
                {FORMULA_DEPT_KEYS.has(activeDeptTab) ? null : activeDeptTab === 'lead_gen' ? (
                  <Card className="border-zinc-200 bg-zinc-50/80 ring-0 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <CardHeader className="pb-3 pt-4">
                      <CardTitle className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-violet-100 dark:bg-violet-950">
                          <Calculator className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                        </span>
                        Lead Gen — Appointments Bonus
                      </CardTitle>
                      <CardDescription className="text-xs text-zinc-500">
                        Rate scales with the number of appointments set this period.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-1.5 pb-4">
                      {([
                        ['10 or more appts', '₱500 × appts'],
                        ['1 – 9 appts',       '₱250 × appts'],
                        ['0 appts',           '₱0'],
                      ] as [string, string][]).map(([label, amount]) => (
                        <div key={label} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900">
                          <span className="text-xs text-zinc-600 dark:text-zinc-400">{label}</span>
                          <span className="font-mono text-xs font-bold text-violet-600 dark:text-violet-400">{amount}</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ) : activeDeptTab === 'accounting' ? (
                  <Card className="border-zinc-200 bg-zinc-50/80 ring-0 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <CardHeader className="pb-3 pt-4">
                      <CardTitle className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-violet-100 dark:bg-violet-950">
                          <Calculator className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                        </span>
                        Accounting — Tiered Bonus
                      </CardTitle>
                      <CardDescription className="text-xs text-zinc-500">
                        Enter collections per weekday (Mon–Fri); the week total sets the tier. If you do not use per-day fields, the legacy single total still applies.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-1.5 pb-4">
                      {([['≥ 30 collected', '₱450'], ['22 – 29 collected', '₱300'], ['17 – 21 collected', '₱200'], ['< 17 collected', '₱0']] as [string, string][]).map(([label, amount]) => (
                        <div key={label} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900">
                          <span className="text-xs text-zinc-600 dark:text-zinc-400">{label}</span>
                          <span className="font-mono text-xs font-bold text-violet-600 dark:text-violet-400">{amount}</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ) : activeDeptTab === 'edit' ? (
                  <Card className="border-zinc-200 bg-zinc-50/80 ring-0 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <CardHeader className="pb-3 pt-4">
                      <CardTitle className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-violet-100 dark:bg-violet-950">
                          <Calculator className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                        </span>
                        Edit — Ticket-Based Bonus
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pb-4">
                      <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-900">
                        <span className="text-xs text-zinc-600 dark:text-zinc-400">Per completed ticket</span>
                        <span className="font-mono text-xs font-bold text-violet-600 dark:text-violet-400">₱50 × tickets</span>
                      </div>
                    </CardContent>
                  </Card>
                ) : activeDeptTab === 'devs' ? (
                  <Card className="border-zinc-200 bg-zinc-50/80 ring-0 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <CardHeader className="pb-3 pt-4">
                      <CardTitle className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-violet-100 dark:bg-violet-950">
                          <Calculator className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                        </span>
                        Devs — Ticket + Site Bonus
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1.5 pb-4">
                      <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900">
                        <span className="text-xs text-zinc-600 dark:text-zinc-400">Completed tickets (all)</span>
                        <span className="font-mono text-xs font-bold text-violet-600 dark:text-violet-400">₱50 × tickets</span>
                      </div>
                      <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Site Delivery</div>
                        <div className="text-[10px] text-zinc-500">Enriquez, Harry Jr. · Lagundi, Bryan</div>
                        <div className="font-mono text-xs font-bold text-violet-600 dark:text-violet-400">₱50 / site</div>
                      </div>
                      <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Site Checking</div>
                        <div className="text-[10px] text-zinc-500">Ranis, Christian · Velasco, Anjeo · Felices, John Carl</div>
                        <div className="font-mono text-xs font-bold text-violet-600 dark:text-violet-400">₱250 / site</div>
                      </div>
                    </CardContent>
                  </Card>
                ) : activeDeptTab === 'callback' ? (
                  <Card className="border-zinc-200 bg-zinc-50/80 ring-0 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <CardHeader className="pb-3 pt-4">
                      <CardTitle className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-violet-100 dark:bg-violet-950">
                          <Calculator className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                        </span>
                        Callback — Hybrid Bonus
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1.5 pb-4">
                      <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900">
                        <span className="text-xs text-zinc-600 dark:text-zinc-400">Callback appointments</span>
                        <span className="font-mono text-xs font-bold text-violet-600 dark:text-violet-400">₱50 × appts</span>
                      </div>
                      <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Lead Gen within Callback</div>
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-zinc-500">1 – 9 appts</span>
                          <span className="font-mono font-bold text-violet-600 dark:text-violet-400">₱250 × appts</span>
                        </div>
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-zinc-500">10+ appts</span>
                          <span className="font-mono font-bold text-violet-600 dark:text-violet-400">₱500 × appts</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ) : activeDeptTab === 'qc' ? (
                  <Card className="border-zinc-200 bg-zinc-50/80 ring-0 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <CardHeader className="pb-3 pt-4">
                      <CardTitle className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-violet-100 dark:bg-violet-950">
                          <Calculator className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                        </span>
                        QC — Pool & Exceptions
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 pb-4">
                      <div>
                        <Label className="mb-1.5 block text-xs text-zinc-600 dark:text-zinc-400">Units Sold (this period)</Label>
                        <Input
                          type="number"
                          min={0}
                          value={qcUnitsSold === 0 ? '' : qcUnitsSold}
                          placeholder="0"
                          onChange={e => {
                            const v = parseInt(e.target.value, 10);
                            updateDeptMetric('qc', 'unitsSold', Number.isFinite(v) && v >= 0 ? v : 0);
                          }}
                          className="h-8 border-violet-200 bg-white font-mono text-xs dark:border-violet-800/50 dark:bg-zinc-900"
                        />
                      </div>
                      {qcUnitsSold > 0 && (
                        <div className="space-y-1 rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Pool Preview</div>
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-zinc-500">Rate ({standardQcMembers.length} std. members)</span>
                            <span className="font-mono font-bold text-violet-600 dark:text-violet-400">₱{qcPoolRate}/unit</span>
                          </div>
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-zinc-500">Pool total</span>
                            <span className="font-mono font-bold text-zinc-700 dark:text-zinc-300">{formatPHP(qcUnitsSold * qcPoolRate)}</span>
                          </div>
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-zinc-500">Per member</span>
                            <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">{formatPHP(qcPoolPerMember)}</span>
                          </div>
                        </div>
                      )}
                      <div className="rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Jerome Rosero</div>
                        <div className="mt-0.5 text-[11px] text-zinc-500">Units × ₱30 + Callback appts × ₱50</div>
                      </div>
                    </CardContent>
                  </Card>
                ) : activeDeptTab === 'discovery' ? (
                  <Card className="border-zinc-200 bg-zinc-50/80 ring-0 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <CardHeader className="pb-3 pt-4">
                      <CardTitle className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-violet-100 dark:bg-violet-950">
                          <Calculator className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                        </span>
                        Discovery — Unit Bonus
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pb-4">
                      <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-900">
                        <span className="text-xs text-zinc-600 dark:text-zinc-400">Per unit sold (prior week)</span>
                        <span className="font-mono text-xs font-bold text-violet-600 dark:text-violet-400">₱25 × units</span>
                      </div>
                    </CardContent>
                  </Card>
                ) : activeDeptTab === 'hr' ? (
                  <Card className="border-zinc-200 bg-zinc-50/80 ring-0 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <CardHeader className="pb-3 pt-4">
                      <CardTitle className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-violet-100 dark:bg-violet-950">
                          <Calculator className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                        </span>
                        HR — Pool-Based Bonus
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 pb-4">
                      <div>
                        <Label className="mb-1.5 block text-xs text-zinc-600 dark:text-zinc-400">New Hires after 4 weeks</Label>
                        <Input
                          type="number"
                          min={0}
                          value={hrNewHires === 0 ? '' : hrNewHires}
                          placeholder="0"
                          onChange={e => {
                            const v = parseInt(e.target.value, 10);
                            updateDeptMetric('hr', 'newHires', Number.isFinite(v) && v >= 0 ? v : 0);
                          }}
                          className="h-8 border-violet-200 bg-white font-mono text-xs dark:border-violet-800/50 dark:bg-zinc-900"
                        />
                      </div>
                      {hrBillableMembers.length > 0 && (
                        <div className="space-y-1 rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Pool Preview</div>
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-zinc-500">Billable members (excl. Teal)</span>
                            <span className="font-mono font-bold text-zinc-700 dark:text-zinc-300">{hrBillableMembers.length}</span>
                          </div>
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-zinc-500">Pool ({hrBillableMembers.length} × ₱1,000)</span>
                            <span className="font-mono font-bold text-zinc-700 dark:text-zinc-300">{formatPHP(hrBillableMembers.length * 1000)}</span>
                          </div>
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-zinc-500">÷ {hrNewHires > 0 ? hrNewHires : '?'} new hires</span>
                            <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">{hrNewHires > 0 ? formatPHP(hrPoolShare) : '—'}</span>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ) : activeDeptTab === 'sales_assistant' ? (
                  <Card className="border-zinc-200 bg-zinc-50/80 ring-0 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <CardHeader className="pb-3 pt-4">
                      <CardTitle className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-violet-100 dark:bg-violet-950">
                          <Calculator className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                        </span>
                        Sales Asst. — Sale Bonus
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pb-4">
                      <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-900">
                        <span className="text-xs text-zinc-600 dark:text-zinc-400">Per sale (last week scoreboard)</span>
                        <span className="font-mono text-xs font-bold text-violet-600 dark:text-violet-400">₱150 × sales</span>
                      </div>
                    </CardContent>
                  </Card>
                ) : activeDeptTab === 'smart_staff' ? (
                  <Card className="border-zinc-200 bg-zinc-50/80 ring-0 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <CardHeader className="pb-3 pt-4">
                      <CardTitle className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-violet-100 dark:bg-violet-950">
                          <Calculator className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                        </span>
                        SmartStaff — Appointment Bonus
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pb-4">
                      <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-900">
                        <span className="text-xs text-zinc-600 dark:text-zinc-400">Per appointment set</span>
                        <span className="font-mono text-xs font-bold text-violet-600 dark:text-violet-400">₱250 × appts</span>
                      </div>
                    </CardContent>
                  </Card>
                ) : (
                  /* Toggle-based departments: US Manager Bonus, Hogan Smith Law */
                  <Card className="border-zinc-200 bg-zinc-50/80 ring-0 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <CardHeader className="pb-3 pt-4">
                      <CardTitle className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-violet-100 dark:bg-violet-950">
                          <Calculator className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                        </span>
                        {activeDept.name}
                      </CardTitle>
                      <CardDescription className="text-xs text-zinc-500">
                        Department-specific bonuses
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3 pb-4">
                      {activeDept.bonuses.map(bonus => {
                        const allChecked =
                          deptEmployees.length > 0 &&
                          deptEmployees.every(e => employeeBonuses[e.email]?.[bonus.id]);
                        return (
                          <div key={bonus.id} className="flex items-center justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">
                                {bonus.label}
                              </div>
                              <div className="font-mono text-xs font-bold text-violet-600 dark:text-violet-400">
                                {formatPHP(bonus.amount)}
                              </div>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className={cn(
                                'h-7 shrink-0 border px-2 text-[10px] font-semibold',
                                allChecked
                                  ? 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400'
                                  : 'border-zinc-200 text-zinc-600 hover:border-violet-300 hover:text-violet-600 dark:border-zinc-700 dark:text-zinc-400',
                              )}
                              disabled={deptEmployees.length === 0}
                              onClick={() =>
                                applyBonusToAllInDept(
                                  bonus.id,
                                  activeDeptTab,
                                  !allChecked,
                                  deptEmployees.map(e => e.email),
                                )
                              }
                            >
                              {allChecked ? 'Remove All' : 'Apply All'}
                            </Button>
                          </div>
                        );
                      })}
                    </CardContent>
                  </Card>
                )}

              </div>

              {/* Right column: Employee bonus table */}
              <div className="flex min-w-0 flex-col gap-2">
                {deptEmployees.length === 0 ? (
                  <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-zinc-200 bg-zinc-50/50 text-center dark:border-zinc-800 dark:bg-zinc-950/30">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-900">
                      <Calculator className="h-5 w-5 text-zinc-400" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                        No employees in {activeDept.name}
                      </div>
                      <div className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                        Employees are auto-assigned from Supabase department data
                      </div>
                    </div>
                  </div>
                ) : (() => {
                  const additionsNeedle = additionsSearch.toLowerCase().trim();
                  const filteredDeptEmployees = additionsNeedle
                    ? deptEmployees.filter(emp => {
                        const haystack = [emp.name, emp.email, emp.initialPay != null ? emp.initialPay.toString() : ''].join(' ').toLowerCase();
                        return haystack.includes(additionsNeedle);
                      })
                    : deptEmployees;
                  const totalFiltered = filteredDeptEmployees.length;
                  return (
                  <div className="flex flex-col gap-2">
                    {/* Search bar */}
                    <div className="relative">
                      <svg
                        className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
                        fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
                      >
                        <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                      </svg>
                      <Input
                        placeholder="Search employee name or email…"
                        value={additionsSearch}
                        onChange={(e) => setAdditionsSearch(e.target.value)}
                        className="h-9 rounded-lg border-zinc-200 bg-white pl-8 pr-8 text-xs shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                      />
                      {additionsSearch && (
                        <button
                          type="button"
                          onClick={() => setAdditionsSearch('')}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                          aria-label="Clear search"
                        >
                          ✕
                        </button>
                      )}
                    </div>

                    <div className="rounded-xl border border-zinc-200 bg-white/50 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/25">
                    <div className="w-full min-w-0 overflow-x-auto [-ms-overflow-style:none] [scrollbar-gutter:stable]">
                      <Table className="w-full min-w-[720px] text-xs">
                        <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-20 [&_th]:bg-zinc-100/95 [&_th]:shadow-[0_1px_0_0_rgb(228_228_231)] dark:[&_th]:bg-zinc-900/95 dark:[&_th]:shadow-[0_1px_0_0_rgb(39_39_42)]">
                          <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                            <TableHead className="min-w-[96px] max-w-[140px] px-1.5 py-2 text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                              Employee
                            </TableHead>
                            <TableHead className="min-w-[72px] px-1 py-2 text-right text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                              Init
                            </TableHead>
                            <TableHead className="min-w-[96px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-indigo-600 dark:text-indigo-400">
                              PAB<br />
                              <span className="font-mono font-normal text-zinc-400">M T W T F · 7h+</span>
                            </TableHead>
                            {/* Formula-based dept metric columns */}
                            {activeDeptTab === 'accounting' && (
                              <TableHead className="min-w-[120px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                Weekly bonus<br />
                                <span className="font-mono font-normal text-zinc-400">Σ→≥30 ₱450 · 22–29 ₱300 · 17–21 ₱200</span>
                              </TableHead>
                            )}
                            {activeDeptTab === 'edit' && (
                              <TableHead className="min-w-[56px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                Tix<br /><span className="font-mono font-normal text-zinc-400">×₱50</span>
                              </TableHead>
                            )}
                            {activeDeptTab === 'lead_gen' && (
                              <TableHead className="min-w-[120px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                Appts<br /><span className="font-mono font-normal text-zinc-400">1–9 ×₱250 · 10+ ×₱500</span>
                              </TableHead>
                            )}
                            {activeDeptTab === 'devs' && (
                              <>
                                <TableHead className="min-w-[56px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                  Tix<br /><span className="font-mono font-normal text-zinc-400">×₱50</span>
                                </TableHead>
                                <TableHead className="min-w-[72px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                  Sites<br /><span className="font-mono font-normal text-zinc-400">Del/Chk</span>
                                </TableHead>
                              </>
                            )}
                            {activeDeptTab === 'callback' && (
                              <TableHead className="min-w-[140px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                Callback + LeadGen<br />
                                <span className="font-mono font-normal text-zinc-400">CB ×₱50 · LG 1–9 ×₱250 · 10+ ×₱500</span>
                              </TableHead>
                            )}
                            {activeDeptTab === 'qc' && (
                              <>
                                <TableHead className="min-w-[64px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                  Role
                                </TableHead>
                                <TableHead className="min-w-[52px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                  CB<br /><span className="font-mono font-normal text-zinc-400">J only</span>
                                </TableHead>
                              </>
                            )}
                            {activeDeptTab === 'discovery' && (
                              <TableHead className="min-w-[56px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                Units<br /><span className="font-mono font-normal text-zinc-400">×₱25</span>
                              </TableHead>
                            )}
                            {activeDeptTab === 'hr' && (
                              <TableHead className="min-w-[64px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                HR pool
                              </TableHead>
                            )}
                            {activeDeptTab === 'sales_assistant' && (
                              <TableHead className="min-w-[56px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                Sales<br /><span className="font-mono font-normal text-zinc-400">×₱150</span>
                              </TableHead>
                            )}
                            {activeDeptTab === 'smart_staff' && (
                              <TableHead className="min-w-[56px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                Appts<br /><span className="font-mono font-normal text-zinc-400">×₱250</span>
                              </TableHead>
                            )}
                            {/* Toggle-based dept bonus columns */}
                            {!FORMULA_DEPT_KEYS.has(activeDeptTab) && activeDept.bonuses.map(b => (
                              <TableHead
                                key={b.id}
                                className="min-w-[68px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-violet-600 dark:text-violet-400"
                              >
                                <span className="line-clamp-2">{b.label}</span><br />
                                <span className="font-mono font-bold">{formatPHP(b.amount)}</span>
                              </TableHead>
                            ))}
                            <TableHead className="min-w-[72px] px-1 py-2 text-right text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                              Bonus
                            </TableHead>
                            <TableHead className="min-w-[72px] px-1 py-2 text-right text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                              Final
                            </TableHead>
                            <TableHead className="w-7 px-0.5" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filteredDeptEmployees.length === 0 ? (
                            <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                              <TableCell colSpan={20} className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                                No employees match &quot;{additionsSearch.trim()}&quot;
                              </TableCell>
                            </TableRow>
                          ) : filteredDeptEmployees.map((emp) => {
                            const bonusTotal = bonusTotals[emp.email] ?? 0;
                            const finalPay = (emp.initialPay ?? 0) + bonusTotal;
                            const empM = employeeMetrics[emp.email] ?? {};
                            const isJerome = isJeromeRosero(emp.name);
                            return (
                              <TableRow
                                key={emp.email}
                                className="border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/30"
                              >
                                <TableCell className="max-w-[140px] px-1.5 py-1.5">
                                  <div className="truncate text-[11px] font-medium leading-tight text-zinc-800 dark:text-zinc-200">
                                    {emp.name || '—'}
                                  </div>
                                  <div className="truncate font-mono text-[9px] leading-tight text-zinc-400">
                                    {emp.email}
                                  </div>
                                </TableCell>
                                <TableCell className="px-1 py-1.5 text-right font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                                  {emp.initialPay != null ? formatPHP(emp.initialPay) : '—'}
                                </TableCell>
                                {/* PAB date counters per-employee */}
                                {(() => {
                                  const normEmpEmail = normEmail(emp.email) ?? emp.email.toLowerCase();
                                  const paEligible = perfectAttendanceEligible.has(normEmpEmail);
                                  const weekdayBreakdown = employeeWeekdayHours.get(normEmpEmail) ?? null;
                                  return (
                                    <TableCell className="px-1 py-1.5 text-center">
                                      <div className="flex flex-col items-center gap-0.5">
                                        {weekdayBreakdown && weekdayBreakdown.length > 0 ? (
                                          <div className="flex flex-wrap justify-center gap-px">
                                            {weekdayBreakdown.map(({ col, seconds, passes }) => {
                                              const colDate = parseColDate(col);
                                              const dateStr = colDate
                                                ? `${colDate.getMonth() + 1}/${colDate.getDate()}`
                                                : '';
                                              return (
                                                <span
                                                  key={col}
                                                  title={`${dayLabel(col)}${dateStr ? ` ${dateStr}` : ''}: ${formatSeconds(seconds)} logged${passes ? ' ✓' : ' — needs 7 h'}`}
                                                  className={cn(
                                                    'flex h-3.5 cursor-default items-center justify-center rounded-sm px-0.5 text-[7px] font-bold leading-none select-none',
                                                    passes
                                                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                                                      : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
                                                  )}
                                                >
                                                  {dayLetter(col)}
                                                </span>
                                              );
                                            })}
                                          </div>
                                        ) : (
                                          <span className="text-[9px] italic text-zinc-400">—</span>
                                        )}
                                        <span className={cn(
                                          'text-[9px] font-semibold leading-none',
                                          paEligible ? 'text-emerald-500' : 'text-zinc-400',
                                        )}>
                                          {paEligible ? '✓ Eligible' : '✗ Ineligible'}
                                        </span>
                                      </div>
                                    </TableCell>
                                  );
                                })()}
                                {/* Accounting: Mon–Fri collections (sum = week tier) */}
                                {activeDeptTab === 'accounting' && (() => {
                                  const weekSum = accountingWeeklyCollectedTotal(empM);
                                  const tierLabel =
                                    weekSum >= 30 ? '₱450' : weekSum >= 22 ? '₱300' : weekSum >= 17 ? '₱200' : '₱0';
                                  const hasData = ACCOUNTING_WEEKDAY_METRICS.some(({ key }) =>
                                    Object.prototype.hasOwnProperty.call(empM, key),
                                  );
                                  return (
                                    <TableCell className="px-1 py-1 align-middle">
                                      <div className="flex flex-col items-center gap-1">
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          onClick={() => setAccountingModalEmail(emp.email)}
                                          className="h-6 border-violet-200 bg-white px-2 text-[10px] font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-800/50 dark:bg-zinc-900 dark:text-violet-300 dark:hover:bg-violet-950/40"
                                        >
                                          {hasData ? 'Edit Bonus' : 'Set Bonus'}
                                        </Button>
                                        <div className="flex items-center gap-1">
                                          <span className="text-[9px] text-zinc-500 dark:text-zinc-400">
                                            Σ{' '}
                                            <span className="font-mono font-bold text-zinc-700 dark:text-zinc-200">
                                              {weekSum}
                                            </span>
                                          </span>
                                          <span className="text-[9px] font-semibold text-violet-600 dark:text-violet-400">
                                            {tierLabel}
                                          </span>
                                        </div>
                                      </div>
                                    </TableCell>
                                  );
                                })()}
                                {/* Edit: tickets via modal */}
                                {activeDeptTab === 'edit' && (() => {
                                  const tix = empM.tickets ?? 0;
                                  const bonus = tix * 50;
                                  return (
                                    <TableCell className="px-1 py-1 align-middle">
                                      <div className="flex flex-col items-center gap-1">
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          onClick={() => setTicketsModalEmail(emp.email)}
                                          className="h-6 border-violet-200 bg-white px-2 text-[10px] font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-800/50 dark:bg-zinc-900 dark:text-violet-300 dark:hover:bg-violet-950/40"
                                        >
                                          {tix > 0 ? 'Edit Bonus' : 'Set Bonus'}
                                        </Button>
                                        <div className="flex items-center gap-1 text-[9px]">
                                          <span className="text-zinc-500 dark:text-zinc-400">
                                            {tix} tix
                                          </span>
                                          <span className="font-semibold text-violet-600 dark:text-violet-400">
                                            {formatPHP(bonus)}
                                          </span>
                                        </div>
                                      </div>
                                    </TableCell>
                                  );
                                })()}
                                {/* Lead Gen: appts (modal) — tiered ₱250 / ₱500 */}
                                {activeDeptTab === 'lead_gen' && (() => {
                                  const appts = empM.leadGenAppts ?? 0;
                                  const bonus = calcLeadGenBonus(appts);
                                  const rateLabel = appts >= 10 ? '₱500 × appts' : appts > 0 ? '₱250 × appts' : '—';
                                  return (
                                    <TableCell className="px-1 py-1 align-middle">
                                      <div className="flex flex-col items-center gap-1">
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          onClick={() => setLeadGenModalEmail(emp.email)}
                                          className="h-6 border-violet-200 bg-white px-2 text-[10px] font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-800/50 dark:bg-zinc-900 dark:text-violet-300 dark:hover:bg-violet-950/40"
                                        >
                                          {appts > 0 ? 'Edit Bonus' : 'Set Bonus'}
                                        </Button>
                                        <div className="flex flex-wrap items-center justify-center gap-x-1 text-[9px]">
                                          <span className="text-zinc-500 dark:text-zinc-400">
                                            {appts} appt{appts !== 1 ? 's' : ''}
                                          </span>
                                          <span className={cn(
                                            'font-semibold',
                                            appts >= 10 ? 'text-violet-600 dark:text-violet-400' : 'text-zinc-500 dark:text-zinc-500',
                                          )}>
                                            {rateLabel}
                                          </span>
                                        </div>
                                        {bonus > 0 && (
                                          <span className="font-mono text-[10px] font-bold text-violet-600 dark:text-violet-400">
                                            {formatPHP(bonus)}
                                          </span>
                                        )}
                                      </div>
                                    </TableCell>
                                  );
                                })()}
                                {/* Devs: tickets (modal) + site delivery/checking */}
                                {activeDeptTab === 'devs' && (
                                  <>
                                    <TableCell className="px-1 py-1 align-middle">
                                      {(() => {
                                        const tix = empM.tickets ?? 0;
                                        const bonus = tix * 50;
                                        return (
                                          <div className="flex flex-col items-center gap-1">
                                            <Button
                                              type="button"
                                              size="sm"
                                              variant="outline"
                                              onClick={() => setTicketsModalEmail(emp.email)}
                                              className="h-6 border-violet-200 bg-white px-2 text-[10px] font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-800/50 dark:bg-zinc-900 dark:text-violet-300 dark:hover:bg-violet-950/40"
                                            >
                                              {tix > 0 ? 'Edit Bonus' : 'Set Bonus'}
                                            </Button>
                                            <div className="flex items-center gap-1 text-[9px]">
                                              <span className="text-zinc-500 dark:text-zinc-400">{tix} tix</span>
                                              <span className="font-semibold text-violet-600 dark:text-violet-400">
                                                {formatPHP(bonus)}
                                              </span>
                                            </div>
                                          </div>
                                        );
                                      })()}
                                    </TableCell>
                                    <TableCell className="px-1 py-1 align-middle">
                                      {(() => {
                                        const isDel = isDevsDelivery(emp.name);
                                        const isChk = isDevsChecking(emp.name);
                                        if (!isDel && !isChk) {
                                          return <span className="block text-center text-xs text-zinc-400">—</span>;
                                        }
                                        const count = isDel ? (empM.siteDelivery ?? 0) : (empM.siteChecking ?? 0);
                                        const rate = isDel ? 50 : 250;
                                        const bonus = count * rate;
                                        const roleLbl = isDel ? 'Delivery · ₱50' : 'Checking · ₱250';
                                        return (
                                          <div className="flex flex-col items-center gap-1">
                                            <Button
                                              type="button"
                                              size="sm"
                                              variant="outline"
                                              onClick={() => setSitesModalEmail(emp.email)}
                                              className="h-6 border-violet-200 bg-white px-2 text-[10px] font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-800/50 dark:bg-zinc-900 dark:text-violet-300 dark:hover:bg-violet-950/40"
                                            >
                                              {count > 0 ? 'Edit Bonus' : 'Set Bonus'}
                                            </Button>
                                            <span className="text-[9px] text-violet-500">{roleLbl}</span>
                                            <div className="flex items-center gap-1 text-[9px]">
                                              <span className="text-zinc-500 dark:text-zinc-400">{count} site{count !== 1 ? 's' : ''}</span>
                                              <span className="font-semibold text-violet-600 dark:text-violet-400">
                                                {formatPHP(bonus)}
                                              </span>
                                            </div>
                                          </div>
                                        );
                                      })()}
                                    </TableCell>
                                  </>
                                )}
                                {/* Callback: CB appts + LG appts (modal) */}
                                {activeDeptTab === 'callback' && (() => {
                                  const cb = empM.callbackAppts ?? 0;
                                  const lg = empM.leadGenAppts ?? 0;
                                  const cbBonus = cb * 50;
                                  const lgBonus = calcLeadGenBonus(lg);
                                  const total = cbBonus + lgBonus;
                                  return (
                                    <TableCell className="px-1 py-1 align-middle">
                                      <div className="flex flex-col items-center gap-1">
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          onClick={() => setCallbackModalEmail(emp.email)}
                                          className="h-6 border-violet-200 bg-white px-2 text-[10px] font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-800/50 dark:bg-zinc-900 dark:text-violet-300 dark:hover:bg-violet-950/40"
                                        >
                                          {cb > 0 || lg > 0 ? 'Edit Bonus' : 'Set Bonus'}
                                        </Button>
                                        <div className="flex items-center gap-1 text-[9px] text-zinc-500 dark:text-zinc-400">
                                          <span>CB {cb}</span>
                                          <span>·</span>
                                          <span>LG {lg}</span>
                                        </div>
                                        {total > 0 && (
                                          <span className="font-mono text-[10px] font-bold text-violet-600 dark:text-violet-400">
                                            {formatPHP(total)}
                                          </span>
                                        )}
                                      </div>
                                    </TableCell>
                                  );
                                })()}
                                {/* QC: single Set/Edit Bonus button for every member */}
                                {activeDeptTab === 'qc' && (() => {
                                  const unitsSold = deptMetrics['qc']?.unitsSold ?? 0;
                                  const cb = empM.callbackAppts ?? 0;
                                  const perMemberRate = standardQcMembers.length >= 6 ? 150 : 125;
                                  const share = isJerome
                                    ? unitsSold * 30 + cb * 50
                                    : (standardQcMembers.length > 0
                                        ? (unitsSold * perMemberRate) / standardQcMembers.length
                                        : 0);
                                  return (
                                    <TableCell className="px-1 py-1 align-middle" colSpan={2}>
                                      <div className="flex flex-col items-center gap-1">
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          onClick={() => setQcModalEmail(emp.email)}
                                          className="h-6 border-violet-200 bg-white px-2 text-[10px] font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-800/50 dark:bg-zinc-900 dark:text-violet-300 dark:hover:bg-violet-950/40"
                                        >
                                          {isJerome ? (cb > 0 || unitsSold > 0 ? 'Edit Bonus' : 'Set Bonus') : 'View Share'}
                                        </Button>
                                        <div className="flex items-center gap-1 text-[9px]">
                                          {isJerome ? (
                                            <>
                                              <span className="rounded-full bg-amber-100 px-1.5 py-0 font-bold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                                                Jerome · ₱30/u
                                              </span>
                                              <span className="text-zinc-500 dark:text-zinc-400">CB {cb}</span>
                                            </>
                                          ) : (
                                            <span className="text-zinc-500 dark:text-zinc-400">
                                              Pool ÷ {standardQcMembers.length}
                                            </span>
                                          )}
                                        </div>
                                        <span className="font-mono text-[10px] font-bold text-violet-600 dark:text-violet-400">
                                          {formatPHP(share)}
                                        </span>
                                      </div>
                                    </TableCell>
                                  );
                                })()}
                                {/* Discovery: units sold prior week — modal */}
                                {activeDeptTab === 'discovery' && (() => {
                                  const units = empM.unitsSoldPriorWeek ?? 0;
                                  const bonus = units * 25;
                                  return (
                                    <TableCell className="px-1 py-1 align-middle">
                                      <div className="flex flex-col items-center gap-1">
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          onClick={() =>
                                            setSimpleMetricModal({
                                              email: emp.email,
                                              metric: 'unitsSoldPriorWeek',
                                              rate: 25,
                                              title: 'Discovery — Units Sold (Prior Week)',
                                              inputLabel: 'Units sold (prior week)',
                                              unitLabel: 'unit',
                                            })
                                          }
                                          className="h-6 border-violet-200 bg-white px-2 text-[10px] font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-800/50 dark:bg-zinc-900 dark:text-violet-300 dark:hover:bg-violet-950/40"
                                        >
                                          {units > 0 ? 'Edit Bonus' : 'Set Bonus'}
                                        </Button>
                                        <div className="flex items-center gap-1 text-[9px]">
                                          <span className="text-zinc-500 dark:text-zinc-400">{units} units</span>
                                          <span className="font-semibold text-violet-600 dark:text-violet-400">
                                            {formatPHP(bonus)}
                                          </span>
                                        </div>
                                      </div>
                                    </TableCell>
                                  );
                                })()}
                                {/* HR: Set/Edit Bonus button — edits dept newHires */}
                                {activeDeptTab === 'hr' && (() => {
                                  const teal = isTeal(emp.name);
                                  const share = teal ? 0 : (hrNewHires > 0 ? hrPoolShare : 0);
                                  return (
                                    <TableCell className="px-1 py-1 align-middle">
                                      <div className="flex flex-col items-center gap-1">
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          onClick={() => setHrModalEmail(emp.email)}
                                          className="h-6 border-violet-200 bg-white px-2 text-[10px] font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-800/50 dark:bg-zinc-900 dark:text-violet-300 dark:hover:bg-violet-950/40"
                                        >
                                          {hrNewHires > 0 ? 'Edit Bonus' : 'Set Bonus'}
                                        </Button>
                                        <span className="text-[9px] text-zinc-500 dark:text-zinc-400">
                                          {teal ? 'Teal · excluded' : `Pool ÷ ${hrNewHires > 0 ? hrNewHires : '?'} hires`}
                                        </span>
                                        <span className="font-mono text-[10px] font-bold text-violet-600 dark:text-violet-400">
                                          {formatPHP(share)}
                                        </span>
                                      </div>
                                    </TableCell>
                                  );
                                })()}
                                {/* Sales Assistant: sales last week — modal */}
                                {activeDeptTab === 'sales_assistant' && (() => {
                                  const sales = empM.salesLastWeek ?? 0;
                                  const bonus = sales * 150;
                                  return (
                                    <TableCell className="px-1 py-1 align-middle">
                                      <div className="flex flex-col items-center gap-1">
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          onClick={() =>
                                            setSimpleMetricModal({
                                              email: emp.email,
                                              metric: 'salesLastWeek',
                                              rate: 150,
                                              title: 'Sales Assistant — Sales Last Week',
                                              inputLabel: 'Sales last week',
                                              unitLabel: 'sale',
                                            })
                                          }
                                          className="h-6 border-violet-200 bg-white px-2 text-[10px] font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-800/50 dark:bg-zinc-900 dark:text-violet-300 dark:hover:bg-violet-950/40"
                                        >
                                          {sales > 0 ? 'Edit Bonus' : 'Set Bonus'}
                                        </Button>
                                        <div className="flex items-center gap-1 text-[9px]">
                                          <span className="text-zinc-500 dark:text-zinc-400">{sales} sales</span>
                                          <span className="font-semibold text-violet-600 dark:text-violet-400">
                                            {formatPHP(bonus)}
                                          </span>
                                        </div>
                                      </div>
                                    </TableCell>
                                  );
                                })()}
                                {/* SmartStaff: appointments set — modal */}
                                {activeDeptTab === 'smart_staff' && (() => {
                                  const appts = empM.appointmentsSet ?? 0;
                                  const bonus = appts * 250;
                                  return (
                                    <TableCell className="px-1 py-1 align-middle">
                                      <div className="flex flex-col items-center gap-1">
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          onClick={() =>
                                            setSimpleMetricModal({
                                              email: emp.email,
                                              metric: 'appointmentsSet',
                                              rate: 250,
                                              title: 'SmartStaff — Appointments Set',
                                              inputLabel: 'Appointments set',
                                              unitLabel: 'appt',
                                            })
                                          }
                                          className="h-6 border-violet-200 bg-white px-2 text-[10px] font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-800/50 dark:bg-zinc-900 dark:text-violet-300 dark:hover:bg-violet-950/40"
                                        >
                                          {appts > 0 ? 'Edit Bonus' : 'Set Bonus'}
                                        </Button>
                                        <div className="flex items-center gap-1 text-[9px]">
                                          <span className="text-zinc-500 dark:text-zinc-400">{appts} appts</span>
                                          <span className="font-semibold text-violet-600 dark:text-violet-400">
                                            {formatPHP(bonus)}
                                          </span>
                                        </div>
                                      </div>
                                    </TableCell>
                                  );
                                })()}
                                {/* Toggle-based dept bonus switches */}
                                {!FORMULA_DEPT_KEYS.has(activeDeptTab) && activeDept.bonuses.map(bonus => (
                                  <TableCell key={bonus.id} className="px-1 py-1.5 text-center">
                                    <Switch
                                      checked={employeeBonuses[emp.email]?.[bonus.id] ?? false}
                                      onCheckedChange={v => toggleEmployeeBonus(emp.email, bonus.id, v)}
                                      className="data-[state=checked]:bg-indigo-600"
                                    />
                                  </TableCell>
                                ))}
                                <TableCell className="px-1 py-1.5 text-right font-mono text-[11px] font-bold">
                                  {isRecalcPending ? (
                                    <span className="inline-block h-3 w-12 animate-pulse rounded bg-emerald-200/60 dark:bg-emerald-900/40" />
                                  ) : bonusTotal > 0 ? (
                                    <span className="text-emerald-600 dark:text-emerald-400">
                                      +{formatPHP(bonusTotal)}
                                    </span>
                                  ) : (
                                    <span className="text-zinc-400">—</span>
                                  )}
                                </TableCell>
                                <TableCell className="px-1 py-1.5 text-right font-mono text-[11px] font-semibold text-zinc-900 dark:text-white">
                                  {isRecalcPending ? (
                                    <span className="inline-block h-3 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                                  ) : (
                                    formatPHP(finalPay)
                                  )}
                                </TableCell>
                                <TableCell className="px-0.5 py-1.5">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-zinc-400 hover:text-red-500"
                                    onClick={() => removeFromDept(emp.email)}
                                    title="Remove from department"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>

                    {/* Dept footer totals */}
                    <div className="flex flex-col gap-2 border-t border-zinc-200 bg-zinc-50/80 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                        <span className="text-xs text-zinc-500">
                          {additionsNeedle
                            ? <>{totalFiltered} of {deptEmployees.length} match</>
                            : <>{deptEmployees.length} employee{deptEmployees.length !== 1 ? 's' : ''} in {activeDept.name}</>
                          }
                          {totalFiltered > 0 && (
                            <span className="text-zinc-400">
                              {' · '}
                              {totalFiltered} row{totalFiltered !== 1 ? 's' : ''} shown
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-4">
                        <span className="text-xs text-zinc-500">
                          Dept Bonuses:{' '}
                          {isRecalcPending ? (
                            <span className="inline-block h-3 w-20 animate-pulse rounded bg-emerald-200/60 align-middle dark:bg-emerald-900/40" />
                          ) : (
                            <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                              +{formatPHP(
                                deptEmployees.reduce((sum, e) => sum + (bonusTotals[e.email] ?? 0), 0),
                              )}
                            </span>
                          )}
                        </span>
                        <span className="text-xs text-zinc-500">
                          Dept Final Pay:{' '}
                          <span className="font-mono font-bold text-zinc-900 dark:text-white">
                            {formatPHP(
                              deptEmployees.reduce(
                                (sum, e) => sum + (e.initialPay ?? 0) + (bonusTotals[e.email] ?? 0),
                                0,
                              ),
                            )}
                          </span>
                        </span>
                      </div>
                    </div>
                  </div>
                  </div>
                  );
                })()}
              </div>
            </div>
          </div>
        );
      }
      case 4: {
        const finalPayRows = effectiveCalcResults
          .map(r => ({
            ...r,
            deptKey: employeeDepts[r.email] ?? null,
            deptName: DEPARTMENTS.find(d => d.key === employeeDepts[r.email])?.name ?? '—',
            bonusTotal: bonusTotals[r.email] ?? 0,
            finalPay: (r.initialPay ?? 0) + (bonusTotals[r.email] ?? 0),
          }))
          .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        const grandInitial = finalPayRows.reduce((s, r) => s + (r.initialPay ?? 0), 0);
        const grandBonuses = finalPayRows.reduce((s, r) => s + r.bonusTotal, 0);
        const grandFinal   = finalPayRows.reduce((s, r) => s + r.finalPay, 0);
        const unassignedCount = finalPayRows.filter(r => !r.deptKey).length;

        return (
          <div className="flex min-w-0 flex-col gap-5">
            {/* Header */}
            <div className="rounded-xl border border-zinc-200/90 bg-gradient-to-br from-white via-zinc-50/80 to-emerald-50/25 p-4 shadow-sm sm:p-5 dark:border-zinc-800 dark:from-zinc-950/50 dark:via-zinc-900/40 dark:to-emerald-950/15">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-white">Pre-Flight Validation</h3>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">Final review before dispatching payments</p>
                {calcSourceFile && (
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-indigo-600 dark:text-indigo-400">
                    <FileText className="h-3 w-3 shrink-0" />
                    <span className="font-mono">{calcSourceFile}</span>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {unassignedCount > 0 && (
                  <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                    {unassignedCount} unassigned
                  </Badge>
                )}
                <Badge className="border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                  Ready for Dispatch
                </Badge>
              </div>
              </div>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Card className="border-zinc-200/90 bg-white/90 shadow-sm ring-0 dark:border-zinc-800 dark:bg-zinc-900/50">
                <CardContent className="pt-4 pb-4">
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">Total Initial Pay</div>
                  <div className="mt-1 font-mono text-xl font-bold text-zinc-900 dark:text-white">
                    {formatPHP(grandInitial)}
                  </div>
                  <div className="mt-1 text-[10px] text-zinc-400">
                    {finalPayRows.length} employee{finalPayRows.length !== 1 ? 's' : ''}
                    {' · '}
                    {hubstaffData.reduce((a, c) => a + c.decimalHours, 0).toFixed(1)} total hrs
                  </div>
                </CardContent>
              </Card>
              <Card className="border-emerald-200/60 bg-emerald-50/60 shadow-sm ring-0 dark:border-emerald-800/30 dark:bg-emerald-950/20">
                <CardContent className="pt-4 pb-4">
                  <div className="text-xs text-emerald-600 dark:text-emerald-400">Total Bonuses Added</div>
                  <div className="mt-1 font-mono text-xl font-bold text-emerald-700 dark:text-emerald-300">
                    +{formatPHP(grandBonuses)}
                  </div>
                  <div className="mt-1 text-[10px] text-emerald-600/70 dark:text-emerald-400/70">
                    {finalPayRows.filter(r => r.bonusTotal > 0).length} employees with bonuses
                  </div>
                </CardContent>
              </Card>
              <Card className="border-indigo-200/60 bg-indigo-50/60 shadow-sm ring-0 dark:border-indigo-800/30 dark:bg-indigo-950/20">
                <CardContent className="pt-4 pb-4">
                  <div className="text-xs text-indigo-600 dark:text-indigo-400">Grand Total Payout</div>
                  <div className="mt-1 font-mono text-xl font-bold text-indigo-700 dark:text-indigo-300">
                    {formatPHP(grandFinal)}
                  </div>
                  <div className="mt-1 text-[10px] text-indigo-600/70 dark:text-indigo-400/70">
                    {payrollComparison.totalOnMaster > 0
                      ? `${payrollComparison.withHoursThisWeek}/${payrollComparison.totalOnMaster} on master list`
                      : 'Initial Pay + Bonuses'}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Final Pay Table */}
            {(() => {
              const vNeedle = validationSearch.toLowerCase().trim();
              const filteredFinalRows = vNeedle
                ? finalPayRows.filter(row => [row.name, row.email, row.deptName].join(' ').toLowerCase().includes(vNeedle))
                : finalPayRows;
              return (
              <div className="space-y-3">
                <div className="relative">
                  <svg
                    className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
                    fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
                  >
                    <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                  </svg>
                  <Input
                    placeholder="Search name, email, department…"
                    value={validationSearch}
                    onChange={(e) => setValidationSearch(e.target.value)}
                    className="h-9 rounded-lg border-zinc-200 bg-white pl-8 pr-8 text-xs shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                  />
                  {validationSearch && (
                    <button
                      type="button"
                      onClick={() => setValidationSearch('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                      aria-label="Clear search"
                    >
                      ✕
                    </button>
                  )}
                </div>

              <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white/50 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/25">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50/90 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/50">
                <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                  Final Pay Breakdown
                  {vNeedle && <span className="ml-1 font-normal text-zinc-400">— {filteredFinalRows.length} of {finalPayRows.length}</span>}
                </span>
                <span className="max-w-full truncate text-[10px] text-zinc-400">
                  {finalPayRows.length} employees
                  {calcSourceFile && <> · <span className="font-mono">{calcSourceFile}</span></>}
                </span>
              </div>
              <div
                className="overflow-auto [-ms-overflow-style:none] [scrollbar-gutter:stable]"
                style={{ maxHeight: 'min(62vh, calc(100dvh - 26rem))' }}
              >
                <Table>
                  <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-20 [&_th]:bg-zinc-100/95 [&_th]:shadow-[0_1px_0_0_rgb(228_228_231)] dark:[&_th]:bg-zinc-900/95 dark:[&_th]:shadow-[0_1px_0_0_rgb(39_39_42)]">
                    <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                      <TableHead className="min-w-[140px] px-3 text-xs font-medium text-zinc-600 dark:text-zinc-400">Employee</TableHead>
                      <TableHead className="min-w-[100px] px-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">Department</TableHead>
                      <TableHead className="min-w-[70px] px-2 text-right text-xs font-medium text-zinc-600 dark:text-zinc-400">Hrs</TableHead>
                      <TableHead className="min-w-[110px] px-2 text-right text-xs font-medium text-zinc-600 dark:text-zinc-400">Initial Pay</TableHead>
                      <TableHead className="min-w-[110px] px-2 text-right text-xs font-medium text-emerald-600 dark:text-emerald-400">Bonuses</TableHead>
                      <TableHead className="min-w-[120px] px-2 text-right text-xs font-semibold text-indigo-600 dark:text-indigo-400">Final Pay</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredFinalRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-10 text-center text-sm text-zinc-400">
                          {vNeedle ? <>No employees match &quot;{vNeedle}&quot;</> : 'No Hubstaff data. Complete Steps 1–3 first.'}
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredFinalRows.map((row, i) => (
                        <TableRow
                          key={`${row.email}-${i}`}
                          className="border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/30"
                        >
                          <TableCell className="px-3 py-2.5">
                            <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">
                              {row.name || '—'}
                            </div>
                            <div className="font-mono text-[10px] text-zinc-400 truncate">{row.email}</div>
                          </TableCell>
                          <TableCell className="px-2 py-2.5">
                            {row.deptKey ? (
                              <Badge
                                variant="outline"
                                className="border-indigo-500/30 text-[10px] text-indigo-600 dark:border-indigo-500/20 dark:text-indigo-400"
                              >
                                {row.deptName}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="border-amber-500/30 text-[10px] text-amber-600 dark:text-amber-400">
                                Unassigned
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="px-2 py-2.5 text-right font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                            {row.totalHours.toFixed(1)}
                          </TableCell>
                          <TableCell className="px-2 py-2.5 text-right font-mono text-xs tabular-nums text-zinc-700 dark:text-zinc-300">
                            {row.initialPay != null ? formatPHP(row.initialPay) : '—'}
                          </TableCell>
                          <TableCell className="px-2 py-2.5 text-right font-mono text-xs tabular-nums font-semibold">
                            {row.bonusTotal > 0 ? (
                              <span className="text-emerald-600 dark:text-emerald-400">+{formatPHP(row.bonusTotal)}</span>
                            ) : (
                              <span className="text-zinc-400">—</span>
                            )}
                          </TableCell>
                          <TableCell className="px-2 py-2.5 text-right font-mono text-xs tabular-nums font-bold text-indigo-700 dark:text-indigo-300">
                            {formatPHP(row.finalPay)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                  {/* Grand total footer */}
                  {finalPayRows.length > 0 && (
                    <tfoot>
                      <tr className="border-t-2 border-zinc-300 bg-zinc-100/80 dark:border-zinc-700 dark:bg-zinc-900/60">
                        <td colSpan={3} className="px-3 py-2.5 text-xs font-bold text-zinc-700 dark:text-zinc-300">
                          Grand Total ({finalPayRows.length} employees)
                        </td>
                        <td className="px-2 py-2.5 text-right font-mono text-xs font-bold tabular-nums text-zinc-800 dark:text-zinc-200">
                          {formatPHP(grandInitial)}
                        </td>
                        <td className="px-2 py-2.5 text-right font-mono text-xs font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                          +{formatPHP(grandBonuses)}
                        </td>
                        <td className="px-2 py-2.5 text-right font-mono text-xs font-bold tabular-nums text-indigo-700 dark:text-indigo-300">
                          {formatPHP(grandFinal)}
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </Table>
              </div>
            </div>
            </div>
              );
            })()}

            {/* Validation Checks */}
            <Card className="border-zinc-200/90 bg-white/90 shadow-sm ring-0 dark:border-zinc-800 dark:bg-zinc-900/50">
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm font-medium text-zinc-900 dark:text-white">Validation Checks</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2 pb-4 sm:grid-cols-2 sm:gap-3">
                {[
                  { label: 'Hubstaff Hours Uploaded', pass: hubstaffData.length > 0 },
                  { label: 'Initial Calculations Complete', pass: effectiveCalcResults.some(r => r.initialPay != null) },
                  { label: 'All Employees Dept-Assigned', pass: unassignedCount === 0 },
                  {
                    label: 'Perfect Attendance Evaluated',
                    pass: !pabMonthRange || pabMonthColumnCoverageComplete,
                  },
                  { label: 'Cycle Separation (Standard vs Hogan)', pass: true },
                ].map((check, i) => (
                  <div
                    key={i}
                    className="flex min-h-[2.75rem] items-center justify-between gap-3 rounded-lg border border-zinc-100 bg-zinc-50/80 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40"
                  >
                    <span className="min-w-0 flex-1 text-sm leading-snug text-zinc-600 dark:text-zinc-400">{check.label}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={cn('text-[10px] font-bold uppercase', check.pass ? 'text-emerald-500' : 'text-amber-500')}>
                        {check.pass ? 'Pass' : 'Warn'}
                      </span>
                      <div className={cn(
                        'flex h-4 w-4 items-center justify-center rounded-full',
                        check.pass ? 'bg-emerald-500/10' : 'bg-amber-500/10',
                      )}>
                        <Check className={cn('h-3 w-3', check.pass ? 'text-emerald-500' : 'text-amber-500')} />
                      </div>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        );
      }
      case 5:
        return (
          <div
            className={cn(
              'relative flex flex-col items-center justify-center py-12 space-y-6 text-center rounded-2xl',
              isDispatching && 'dispatch-running-light',
            )}
          >
            {isDispatching && (
              <style>{`
                @keyframes dispatch-spin { to { transform: rotate(360deg); } }
                .dispatch-running-light { position: relative; isolation: isolate; overflow: hidden; }
                .dispatch-running-light::before {
                  content: '';
                  position: absolute;
                  inset: -150%;
                  background: conic-gradient(from 0deg, transparent 0%, transparent 80%, #ef4444 90%, #fca5a5 95%, #ef4444 100%);
                  animation: dispatch-spin 1.6s linear infinite;
                  z-index: -2;
                }
                .dispatch-running-light::after {
                  content: '';
                  position: absolute;
                  inset: 3px;
                  border-radius: 14px;
                  background: inherit;
                  background-color: #ffffff;
                  z-index: -1;
                }
                .dark .dispatch-running-light::after { background-color: #09090b; }
              `}</style>
            )}
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="w-20 h-20 bg-indigo-600 rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(79,70,229,0.4)]"
            >
              <Send className="w-10 h-10 text-white" />
            </motion.div>
            <div className="space-y-2">
              <h3 className="text-2xl font-bold text-zinc-900 dark:text-white">Ready to Dispatch</h3>
              <p className="max-w-md text-zinc-600 dark:text-zinc-400">
                This will trigger paystubs for {payrollComparison.withHoursThisWeek} workers with hours this week
                {payrollComparison.totalOnMaster > 0 ? (
                  <>
                    {' '}
                    ({payrollComparison.withHoursThisWeek}/{payrollComparison.totalOnMaster} against the master list)
                  </>
                ) : null}{' '}
                and initiate bank transfers. An audit log will be created for this session.
              </p>
            </div>
            <a
              href="https://simpledotbiz.app.n8n.cloud/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-[#ea4b71]/30 bg-[#ea4b71]/10 px-3.5 py-1.5 text-xs font-medium text-[#ea4b71] transition hover:bg-[#ea4b71]/15 hover:shadow-[0_0_12px_rgba(234,75,113,0.25)]"
              title="Clicking Confirm & Dispatch will trigger the paystub workflow in n8n"
            >
              <img
                src="https://n8n.io/favicon.ico"
                alt="n8n"
                className="h-4 w-4"
              />
              <span>Triggers n8n automation</span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[#ea4b71]/80">· Accounting heads up</span>
            </a>
            <div className="flex gap-4">
              <Button
                variant="outline"
                className="border-zinc-200 px-8 text-zinc-600 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:text-white"
                onClick={() => {
                  if (dispatchData.rows.length === 0) {
                    toast.error('No paystubs to preview', {
                      description: 'No employees have a personal email on file.',
                    });
                    return;
                  }
                  setPreviewSelectedEmail(null);
                  setPreviewPaystubsOpen(true);
                }}
              >
                Preview Paystubs
              </Button>
              <Button
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-12 font-bold"
                onClick={async () => {
                  const { rows: employees, missing, payPeriodPayload } = dispatchData;
                  if (employees.length === 0) {
                    toast.error('Dispatch blocked', {
                      description: 'No employees have a personal email on file.',
                    });
                    return;
                  }
                  if (missing.length > 0) {
                    toast.warning(
                      `Skipping ${missing.length} employee${missing.length === 1 ? '' : 's'} without personal email`,
                      {
                        description:
                          missing.slice(0, 5).join(', ') + (missing.length > 5 ? '…' : ''),
                      },
                    );
                  }
                  setIsDispatching(true);
                  try {
                    const res = await fetch('/api/dispatch-paystubs', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ pay_period: payPeriodPayload, employees }),
                    });
                    const data = await res.json();
                    if (!res.ok) {
                      const detail =
                        typeof data?.detail === 'string' && data.detail.trim()
                          ? data.detail.trim().slice(0, 500)
                          : undefined;
                      toast.error('Dispatch failed', {
                        description: [data?.error ?? `HTTP ${res.status}`, detail]
                          .filter(Boolean)
                          .join(' — '),
                      });
                      return;
                    }
                    toast.success('Payroll Dispatched', {
                      description: `Sent ${employees.length} paystub request${employees.length === 1 ? '' : 's'} to n8n.`,
                    });
                    setCurrentStep(1);
                  } catch (err) {
                    toast.error('Dispatch failed', {
                      description: err instanceof Error ? err.message : String(err),
                    });
                  } finally {
                    setIsDispatching(false);
                  }
                }}
                disabled={isDispatching}
              >
                {isDispatching ? 'Dispatching…' : 'Confirm & Dispatch'}
              </Button>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-zinc-50 p-4 md:p-8 dark:bg-zinc-950">
      <Dialog
        open={deleteSourceFilePending !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteSourceFilePending(null);
        }}
      >
        <DialogContent className="border-zinc-200 bg-white sm:max-w-md dark:border-zinc-800 dark:bg-zinc-950">
          <DialogHeader>
            <DialogTitle className="text-zinc-900 dark:text-white">Delete this upload?</DialogTitle>
            <DialogDescription className="text-zinc-600 dark:text-zinc-400">
              This removes every row in{' '}
              <span className="font-mono text-zinc-700 dark:text-zinc-300">public.hubstaff_hours</span> tagged with{' '}
              <span className="font-mono">{deleteSourceFilePending ?? ''}</span>. Other CSV batches are not affected.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="border-zinc-200 dark:border-zinc-800"
              disabled={deleteSourceFileLoading}
              onClick={() => setDeleteSourceFilePending(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteSourceFileLoading || !deleteSourceFilePending}
              className="gap-2"
              onClick={() => void confirmDeleteSourceFile()}
            >
              {deleteSourceFileLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Delete from database
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={approveUploadDialogOpen}
        onOpenChange={(open) => {
          setApproveUploadDialogOpen(open);
          if (!open) setPendingWeekly(null);
        }}
      >
        <DialogContent className="border-zinc-200 bg-white sm:max-w-md dark:border-zinc-800 dark:bg-zinc-950">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-zinc-900 dark:text-white">
              <Lock className="h-5 w-5 shrink-0 text-indigo-600 dark:text-indigo-400" />
              Confirm upload to database
            </DialogTitle>
            <DialogDescription className="text-zinc-600 dark:text-zinc-400">
              This will append rows to{' '}
              <span className="font-mono text-zinc-700 dark:text-zinc-300">public.hubstaff_hours</span> from the CSV you
              selected
              {pendingWeekly ? (
                <>
                  {' '}
                  (<span className="font-mono">{pendingWeekly.fileName}</span>).
                </>
              ) : (
                '.'
              )}{' '}
              Existing data will not be overwritten. Approve only if this is the correct week&apos;s export.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="border-zinc-200 dark:border-zinc-800"
              disabled={weeklyUploadLoading}
              onClick={() => {
                setPendingWeekly(null);
                setApproveUploadDialogOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="gap-2 bg-indigo-600 text-white hover:bg-indigo-700"
              disabled={weeklyUploadLoading || !pendingWeekly}
              onClick={() => void confirmWeeklyUploadToDatabase()}
            >
              {weeklyUploadLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Lock className="h-4 w-4" />
              )}
              Approve & upload
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={previewPaystubsOpen}
        onOpenChange={(open) => {
          setPreviewPaystubsOpen(open);
          if (!open) {
            setPreviewSelectedEmail(null);
            setPreviewSearch('');
          }
        }}
      >
        <DialogContent className="overflow-hidden rounded-2xl border-zinc-200 bg-white p-0 sm:max-w-md dark:border-zinc-800 dark:bg-zinc-950">
          {(() => {
            const selected = previewSelectedEmail
              ? dispatchData.rows.find((e) => e.email === previewSelectedEmail)
              : null;
            if (selected) {
              const pp = selected.pay_php;
              const fmt = (n: number | null) =>
                n == null ? '—' : '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              return (
                <>
                  <DialogHeader className="sr-only">
                    <DialogTitle>Paystub Preview · {selected.name}</DialogTitle>
                    <DialogDescription>{selected.personal_email}</DialogDescription>
                  </DialogHeader>
                  <div className="flex flex-col bg-white">
                    <div className="flex shrink-0 items-center justify-between border-b border-zinc-100 bg-white/80 px-4 py-2 backdrop-blur">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-zinc-700"
                        onClick={() => setPreviewSelectedEmail(null)}
                      >
                        ← Back
                      </Button>
                      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-orange-700">
                        Preview · Not yet sent
                      </span>
                    </div>
                    <div className="min-h-0 flex-1 overflow-hidden">
                      {/* Header — full width, centered, vertical like email */}
                      <div
                        className="px-6 py-4 text-center"
                        style={{
                          background:
                            'linear-gradient(to top right, #3b82f6 0%, #ffffff 50%, #f97316 100%)',
                        }}
                      >
                        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-800">
                          Simple HRIS · Paystub
                        </div>
                        <div className="mt-2 text-lg font-bold tracking-tight text-slate-900">
                          Hi {selected.name},
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-700">
                          Your paystub has been prepared.
                        </div>
                      </div>

                      {/* Recipient */}
                      <div className="px-4 pt-3">
                        <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-orange-600">
                          Recipient
                        </div>
                        <div
                          className="mt-0.5 h-0.5 w-12 rounded-sm"
                          style={{
                            background:
                              'linear-gradient(to top right, #3b82f6 0%, #ffffff 50%, #f97316 100%)',
                          }}
                        />
                        <div
                          className="mt-1.5 rounded-lg border border-orange-100 px-3 py-2"
                          style={{
                            background:
                              'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)',
                          }}
                        >
                          <div className="space-y-0.5 text-[11px]">
                            <div className="flex gap-2"><span className="w-20 shrink-0 text-amber-800/70">Dept</span><span className="truncate font-semibold text-zinc-900">{selected.department_name ?? '—'}</span></div>
                            <div className="flex gap-2"><span className="w-20 shrink-0 text-amber-800/70">Week</span><span className="truncate font-mono text-zinc-900">{selected.pay_period.week ? `${selected.pay_period.week.start} → ${selected.pay_period.week.end}` : '—'}</span></div>
                            <div className="flex gap-2"><span className="w-20 shrink-0 text-amber-800/70">PAB Month</span><span className="truncate text-zinc-900">{selected.pay_period.pab_evaluation.month_label}</span></div>
                            <div className="flex gap-2"><span className="w-20 shrink-0 text-amber-800/70">Email</span><span className="truncate font-mono font-semibold text-blue-600">{selected.personal_email}</span></div>
                          </div>
                        </div>
                      </div>

                      {/* Earnings */}
                      <div className="px-4 pt-2.5">
                        <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-orange-600">
                          Earnings
                        </div>
                        <div
                          className="mt-0.5 h-0.5 w-12 rounded-sm"
                          style={{
                            background:
                              'linear-gradient(to top right, #3b82f6 0%, #ffffff 50%, #f97316 100%)',
                          }}
                        />
                        <div
                          className="mt-1.5 rounded-lg border border-orange-100 px-3 py-2"
                          style={{
                            background:
                              'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)',
                          }}
                        >
                          <div className="space-y-0.5 font-mono text-[11px]">
                            <div className="flex justify-between"><span className="text-amber-800/70">Regular</span><span>{selected.hours.regular.toFixed(2)}h · {fmt(pp.regular)}</span></div>
                            <div className="flex justify-between"><span className="text-amber-800/70">Overtime</span><span>{selected.hours.ot.toFixed(2)}h · {fmt(pp.ot)}</span></div>
                            <div className="mt-1 border-t border-orange-100 pt-1" />
                            <div className="flex justify-between"><span className="text-amber-800/70">Initial Pay</span><span className="font-semibold">{fmt(pp.initial)}</span></div>
                          </div>
                        </div>
                      </div>

                      {/* Bonuses */}
                      <div className="px-4 pt-2.5">
                        <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-orange-600">
                          Bonuses
                        </div>
                        <div
                          className="mt-0.5 h-0.5 w-12 rounded-sm"
                          style={{
                            background:
                              'linear-gradient(to top right, #3b82f6 0%, #ffffff 50%, #f97316 100%)',
                          }}
                        />
                        <div
                          className="mt-1.5 rounded-lg border border-orange-100 px-3 py-2"
                          style={{
                            background:
                              'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)',
                          }}
                        >
                          <div className="space-y-0.5 font-mono text-[11px]">
                            <div className="flex justify-between"><span className="text-amber-800/70">Perfect Attendance</span><span className="font-semibold text-indigo-600">+{fmt(pp.perfect_attendance_bonus)}</span></div>
                            <div className="flex justify-between"><span className="text-amber-800/70">Tech Bonus</span><span className="font-semibold text-sky-600">+{fmt(pp.tech_bonus)}</span></div>
                            <div className="flex justify-between"><span className="text-amber-800/70">Other</span><span className="font-semibold text-violet-600">+{fmt(pp.other_bonuses)}</span></div>
                            <div className="mt-1 border-t border-orange-100 pt-1" />
                            <div className="flex justify-between"><span className="text-amber-800/70">Bonus Total</span><span className="font-bold">{fmt(pp.bonuses_total)}</span></div>
                          </div>
                        </div>
                      </div>

                      {/* Total bar */}
                      <div className="px-4 pt-2.5">
                        <div
                          className="flex items-center justify-between rounded-lg px-4 py-2.5"
                          style={{
                            background:
                              'linear-gradient(to top right, #1d4ed8 0%, #ffffff 50%, #ea580c 100%)',
                          }}
                        >
                          <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-800">
                            Total Pay
                          </div>
                          <div className="text-lg font-extrabold tracking-tight text-slate-900">
                            {fmt(pp.final)} <span className="text-[10px] font-semibold text-slate-600">PHP</span>
                          </div>
                        </div>
                      </div>

                      {/* Footer */}
                      <div
                        className="mt-2 flex items-center justify-center gap-2 px-4 py-2"
                        style={{
                          background:
                            'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)',
                        }}
                      >
                        <img
                          src="https://host.simple.biz/email/simplelogo.png"
                          alt="Simple"
                          className="h-5 w-auto"
                        />
                        <div className="text-[9px] text-slate-400">© Simple · Confidential</div>
                      </div>
                    </div>
                  </div>
                </>
              );
            }
            const needle = previewSearch.trim().toLowerCase();
            const filtered = needle
              ? dispatchData.rows.filter(
                  (e) =>
                    e.name.toLowerCase().includes(needle) ||
                    e.personal_email.toLowerCase().includes(needle),
                )
              : dispatchData.rows;
            return (
              <>
                <DialogHeader className="px-6 pt-6">
                  <DialogTitle className="text-zinc-900 dark:text-white">Preview Paystubs</DialogTitle>
                  <DialogDescription className="text-zinc-600 dark:text-zinc-400">
                    {dispatchData.rows.length} employee{dispatchData.rows.length === 1 ? '' : 's'} queued for this batch.
                    Click View to inspect a paystub.
                  </DialogDescription>
                </DialogHeader>
                <div className="px-6 pt-3">
                  <input
                    type="text"
                    value={previewSearch}
                    onChange={(ev) => setPreviewSearch(ev.target.value)}
                    placeholder="Search by name or email…"
                    className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white"
                  />
                </div>
                <div className="max-h-[60vh] overflow-y-auto px-6 pb-6 pt-2">
                  {filtered.length === 0 ? (
                    <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                      No employees match &ldquo;{previewSearch}&rdquo;.
                    </div>
                  ) : (
                    <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                      {filtered.map((e) => (
                        <div key={e.email} className="flex items-center justify-between gap-3 py-3">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-zinc-900 dark:text-white">
                              {e.name}
                            </div>
                            <div className="truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
                              {e.personal_email}
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 shrink-0"
                            onClick={() => setPreviewSelectedEmail(e.email)}
                          >
                            View
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      <div className="mb-8 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">Payroll Wizard</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-500">The "Friday Path" Automated Workflow</p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-100 p-1 dark:border-zinc-800 dark:bg-zinc-900">
          <Button variant="ghost" size="sm" className="text-xs h-8">History</Button>
          <Button variant="ghost" size="sm" className="text-xs h-8">Templates</Button>
        </div>
      </div>

      <div className="flex gap-8 flex-1 overflow-hidden min-h-0">
        {/* Stepper Sidebar */}
        <div className="w-64 flex flex-col gap-4 overflow-y-auto min-h-0 pr-2 scrollbar-none">
          {steps.map((step) => (
            <div 
              key={step.id}
              className={cn(
                "relative flex items-start gap-4 p-4 rounded-xl border transition-all duration-300",
                currentStep === step.id 
                  ? "bg-indigo-600/10 border-indigo-600/50 shadow-[0_0_20px_rgba(79,70,229,0.1)]" 
                  : currentStep > step.id
                    ? "border border-emerald-500/20 bg-emerald-50/80 opacity-60 dark:bg-zinc-900/50"
                    : "border border-zinc-200 bg-zinc-100/80 opacity-40 dark:border-zinc-800 dark:bg-zinc-900/30"
              )}
            >
              <div className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors",
                currentStep === step.id ? "bg-indigo-600 text-white" : 
                currentStep > step.id ? "bg-emerald-500 text-white" : "bg-zinc-300 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-500"
              )}>
                {currentStep > step.id ? <Check className="w-4 h-4" /> : <step.icon className="w-4 h-4" />}
              </div>
              <div className="flex flex-col min-w-0">
                <span className={cn(
                  "text-sm font-bold truncate",
                  currentStep === step.id ? "text-zinc-900 dark:text-white" : "text-zinc-500 dark:text-zinc-400"
                )}>
                  {step.label}
                </span>
                <span className="text-[10px] text-zinc-500 truncate leading-tight mt-0.5">
                  {step.description}
                </span>
              </div>
              {currentStep === step.id && (
                <motion.div 
                  layoutId="active-indicator"
                  className="absolute -left-1 top-1/2 -translate-y-1/2 w-2 h-8 bg-indigo-600 rounded-full"
                />
              )}
            </div>
          ))}
        </div>

        {/* Main Content Area */}
        <div className="flex flex-1 flex-col overflow-hidden min-h-0 rounded-2xl border border-zinc-200 bg-white/80 dark:border-zinc-800 dark:bg-zinc-900/30">
          <ScrollArea className="flex-1 p-4 md:p-8 min-h-0">
            <AnimatePresence mode="wait">
              <motion.div
                key={currentStep}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="min-w-0 max-w-full"
              >
                {renderStepContent()}
              </motion.div>
            </AnimatePresence>
          </ScrollArea>

          <div className="flex items-center justify-between border-t border-zinc-200 bg-zinc-50 p-6 dark:border-zinc-800 dark:bg-zinc-900/50">
            <Button 
              variant="ghost" 
              onClick={prevStep} 
              disabled={currentStep === 1}
              className="gap-2 text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </Button>
            <div className="flex items-center gap-4">
              <span className="text-xs text-zinc-500 font-mono">Step {currentStep} of {steps.length}</span>
              <Button
                onClick={nextStep}
                disabled={currentStep === steps.length}
                className="bg-indigo-600 hover:bg-indigo-700 text-white gap-2 px-8"
              >
                {currentStep === steps.length - 1 ? 'Review' : 'Continue'}
                <ArrowRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Accounting weekly-collections modal */}
      {accountingModalEmail && (() => {
        const emp = calcResults.find((e) => e.email === accountingModalEmail);
        const empM = employeeMetrics[accountingModalEmail] ?? {};
        const weekSum = accountingWeeklyCollectedTotal(empM);
        const tierAmount =
          weekSum >= 30 ? 450 : weekSum >= 22 ? 300 : weekSum >= 17 ? 200 : 0;
        const tierLabel =
          weekSum >= 30 ? '≥ 30 collected' :
          weekSum >= 22 ? '22 – 29 collected' :
          weekSum >= 17 ? '17 – 21 collected' : '< 17 collected';
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={() => setAccountingModalEmail(null)}
          >
            <div
              className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-white">
                    <Calculator className="h-4 w-4 text-violet-500" />
                    Accounting Weekly Bonus
                  </h2>
                  <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {emp?.name || accountingModalEmail}
                  </p>
                </div>
                <button
                  onClick={() => setAccountingModalEmail(null)}
                  className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="mb-3 grid grid-cols-5 gap-2">
                {ACCOUNTING_WEEKDAY_METRICS.map(({ key, label }) => (
                  <div key={key} className="flex flex-col items-center gap-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
                      {label}
                    </span>
                    <Input
                      type="number"
                      min={0}
                      value={empM[key] && empM[key] > 0 ? empM[key] : ''}
                      placeholder="0"
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        const n = Number.isFinite(v) && v >= 0 ? v : 0;
                        startRecalc(() => {
                          setEmployeeMetrics((prev) => ({
                            ...prev,
                            [accountingModalEmail]: {
                              ...(prev[accountingModalEmail] ?? {}),
                              [key]: n,
                            },
                          }));
                        });
                      }}
                      className="h-9 border-violet-200 bg-white text-center font-mono text-sm dark:border-violet-800/50 dark:bg-zinc-900"
                    />
                  </div>
                ))}
              </div>

              <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">Week total</span>
                  <span className="font-mono text-lg font-bold text-zinc-900 dark:text-white">{weekSum}</span>
                </div>
                <div className="space-y-1">
                  {([
                    ['≥ 30 collected', '₱450', 30],
                    ['22 – 29 collected', '₱300', 22],
                    ['17 – 21 collected', '₱200', 17],
                    ['< 17 collected', '₱0', 0],
                  ] as [string, string, number][]).map(([lbl, amt, threshold]) => {
                    const active = lbl === tierLabel;
                    return (
                      <div
                        key={lbl}
                        className={cn(
                          'flex items-center justify-between rounded-md border px-2.5 py-1.5 text-xs transition',
                          active
                            ? 'border-violet-500/50 bg-violet-50 font-semibold text-violet-800 dark:border-violet-500/40 dark:bg-violet-950/40 dark:text-violet-200'
                            : 'border-transparent text-zinc-500 dark:text-zinc-500',
                        )}
                      >
                        <span>{lbl}</span>
                        <span className="font-mono">{amt}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 flex items-center justify-between border-t border-zinc-200 pt-2 dark:border-zinc-800">
                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Bonus awarded</span>
                  <span className="font-mono text-base font-bold text-violet-600 dark:text-violet-400">
                    {formatPHP(tierAmount)}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setEmployeeMetrics((prev) => {
                      const copy = { ...(prev[accountingModalEmail] ?? {}) };
                      for (const { key } of ACCOUNTING_WEEKDAY_METRICS) delete copy[key];
                      return { ...prev, [accountingModalEmail]: copy };
                    });
                  }}
                  className="text-xs"
                >
                  Clear days
                </Button>
                <Button
                  onClick={() => setAccountingModalEmail(null)}
                  className="bg-violet-600 text-xs text-white hover:bg-violet-700"
                >
                  Done
                </Button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Tickets modal — shared by Edit and Devs (₱50 × tickets) */}
      {ticketsModalEmail && (() => {
        const emp = calcResults.find((e) => e.email === ticketsModalEmail);
        const empM = employeeMetrics[ticketsModalEmail] ?? {};
        const tickets = empM.tickets ?? 0;
        const bonus = tickets * 50;
        const deptLabel = activeDeptTab === 'devs' ? 'Devs' : 'Edit';
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={() => setTicketsModalEmail(null)}
          >
            <div
              className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-white">
                    <Calculator className="h-4 w-4 text-violet-500" />
                    {deptLabel} Ticket Bonus
                  </h2>
                  <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {emp?.name || ticketsModalEmail}
                  </p>
                </div>
                <button
                  onClick={() => setTicketsModalEmail(null)}
                  className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="mb-3">
                <Label className="mb-1.5 block text-xs text-zinc-600 dark:text-zinc-400">
                  Tickets completed
                </Label>
                <Input
                  type="number"
                  min={0}
                  autoFocus
                  value={tickets > 0 ? tickets : ''}
                  placeholder="0"
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    const n = Number.isFinite(v) && v >= 0 ? v : 0;
                    startRecalc(() => {
                      setEmployeeMetrics((prev) => ({
                        ...prev,
                        [ticketsModalEmail]: { ...(prev[ticketsModalEmail] ?? {}), tickets: n },
                      }));
                    });
                  }}
                  className="h-10 border-violet-200 bg-white text-center font-mono text-base dark:border-violet-800/50 dark:bg-zinc-900"
                />
              </div>

              <div className="mb-4 space-y-2 rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-500 dark:text-zinc-400">Rate</span>
                  <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                    ₱50 / ticket
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-500 dark:text-zinc-400">Tickets</span>
                  <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                    × {tickets}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t border-zinc-200 pt-2 dark:border-zinc-800">
                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    Bonus awarded
                  </span>
                  <span className="font-mono text-base font-bold text-violet-600 dark:text-violet-400">
                    {formatPHP(bonus)}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    setEmployeeMetrics((prev) => ({
                      ...prev,
                      [ticketsModalEmail]: { ...(prev[ticketsModalEmail] ?? {}), tickets: 0 },
                    }))
                  }
                  className="text-xs"
                >
                  Clear
                </Button>
                <Button
                  onClick={() => setTicketsModalEmail(null)}
                  className="bg-violet-600 text-xs text-white hover:bg-violet-700"
                >
                  Done
                </Button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Devs — Site Delivery / Checking modal */}
      {sitesModalEmail && (() => {
        const emp = calcResults.find((e) => e.email === sitesModalEmail);
        const empM = employeeMetrics[sitesModalEmail] ?? {};
        const isDel = emp ? isDevsDelivery(emp.name) : false;
        const isChk = emp ? isDevsChecking(emp.name) : false;
        const metricKey = isDel ? 'siteDelivery' : isChk ? 'siteChecking' : null;
        const rate = isDel ? 50 : isChk ? 250 : 0;
        const roleLabel = isDel ? 'Site Delivery' : isChk ? 'Site Checking' : '—';
        const count = metricKey ? (empM[metricKey] ?? 0) : 0;
        const bonus = count * rate;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={() => setSitesModalEmail(null)}
          >
            <div
              className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-white">
                    <Calculator className="h-4 w-4 text-violet-500" />
                    Devs — {roleLabel}
                  </h2>
                  <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {emp?.name || sitesModalEmail}
                  </p>
                </div>
                <button
                  onClick={() => setSitesModalEmail(null)}
                  className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {!metricKey ? (
                <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                  This employee isn&apos;t assigned to site delivery or checking. Add them to the pool first.
                </p>
              ) : (
                <>
                  <div className="mb-3">
                    <Label className="mb-1.5 block text-xs text-zinc-600 dark:text-zinc-400">
                      Sites {isDel ? 'delivered' : 'checked'}
                    </Label>
                    <Input
                      type="number"
                      min={0}
                      autoFocus
                      value={count > 0 ? count : ''}
                      placeholder="0"
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        const n = Number.isFinite(v) && v >= 0 ? v : 0;
                        startRecalc(() => {
                          setEmployeeMetrics((prev) => ({
                            ...prev,
                            [sitesModalEmail]: { ...(prev[sitesModalEmail] ?? {}), [metricKey]: n },
                          }));
                        });
                      }}
                      className="h-10 border-violet-200 bg-white text-center font-mono text-base dark:border-violet-800/50 dark:bg-zinc-900"
                    />
                  </div>

                  <div className="mb-4 space-y-2 rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-500 dark:text-zinc-400">Rate</span>
                      <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                        {formatPHP(rate)} / site
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-500 dark:text-zinc-400">Sites</span>
                      <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">× {count}</span>
                    </div>
                    <div className="flex items-center justify-between border-t border-zinc-200 pt-2 dark:border-zinc-800">
                      <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Bonus awarded</span>
                      <span className="font-mono text-base font-bold text-violet-600 dark:text-violet-400">
                        {formatPHP(bonus)}
                      </span>
                    </div>
                    <p className="pt-1 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
                      Delivery pool: Enriquez Harry Jr., Lagundi Bryan. Checking pool: Ranis Christian, Velasco Anjeo, Felices John Carl.
                    </p>
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() =>
                        setEmployeeMetrics((prev) => ({
                          ...prev,
                          [sitesModalEmail]: { ...(prev[sitesModalEmail] ?? {}), [metricKey]: 0 },
                        }))
                      }
                      className="text-xs"
                    >
                      Clear
                    </Button>
                    <Button
                      onClick={() => setSitesModalEmail(null)}
                      className="bg-violet-600 text-xs text-white hover:bg-violet-700"
                    >
                      Done
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* Lead Gen appointments modal */}
      {leadGenModalEmail && (() => {
        const emp = calcResults.find((e) => e.email === leadGenModalEmail);
        const empM = employeeMetrics[leadGenModalEmail] ?? {};
        const appts = empM.leadGenAppts ?? 0;
        const bonus = calcLeadGenBonus(appts);
        const activeTier =
          appts === 0 ? 'zero' : appts >= 10 ? 'hi' : 'lo';
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={() => setLeadGenModalEmail(null)}
          >
            <div
              className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-white">
                    <Calculator className="h-4 w-4 text-violet-500" />
                    Lead Gen — Appointments
                  </h2>
                  <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {emp?.name || leadGenModalEmail}
                  </p>
                </div>
                <button
                  onClick={() => setLeadGenModalEmail(null)}
                  className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="mb-3">
                <Label className="mb-1.5 block text-xs text-zinc-600 dark:text-zinc-400">
                  Appointments set
                </Label>
                <Input
                  type="number"
                  min={0}
                  autoFocus
                  value={appts > 0 ? appts : ''}
                  placeholder="0"
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    const n = Number.isFinite(v) && v >= 0 ? v : 0;
                    startRecalc(() => {
                      setEmployeeMetrics((prev) => ({
                        ...prev,
                        [leadGenModalEmail]: { ...(prev[leadGenModalEmail] ?? {}), leadGenAppts: n },
                      }));
                    });
                  }}
                  className="h-10 border-violet-200 bg-white text-center font-mono text-base dark:border-violet-800/50 dark:bg-zinc-900"
                />
              </div>

              <div className="mb-4 space-y-1 rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                {([
                  ['10 or more appts', '₱500 × appts', 'hi'],
                  ['1 – 9 appts',       '₱250 × appts', 'lo'],
                  ['0 appts',           '₱0',           'zero'],
                ] as [string, string, string][]).map(([lbl, amt, tier]) => {
                  const active = tier === activeTier;
                  return (
                    <div
                      key={tier}
                      className={cn(
                        'flex items-center justify-between rounded-md border px-2.5 py-1.5 text-xs transition',
                        active
                          ? 'border-violet-500/50 bg-violet-50 font-semibold text-violet-800 dark:border-violet-500/40 dark:bg-violet-950/40 dark:text-violet-200'
                          : 'border-transparent text-zinc-500 dark:text-zinc-500',
                      )}
                    >
                      <span>{lbl}</span>
                      <span className="font-mono">{amt}</span>
                    </div>
                  );
                })}
                <div className="mt-2 flex items-center justify-between border-t border-zinc-200 pt-2 dark:border-zinc-800">
                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Bonus awarded</span>
                  <span className="font-mono text-base font-bold text-violet-600 dark:text-violet-400">
                    {formatPHP(bonus)}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    setEmployeeMetrics((prev) => ({
                      ...prev,
                      [leadGenModalEmail]: { ...(prev[leadGenModalEmail] ?? {}), leadGenAppts: 0 },
                    }))
                  }
                  className="text-xs"
                >
                  Clear
                </Button>
                <Button
                  onClick={() => setLeadGenModalEmail(null)}
                  className="bg-violet-600 text-xs text-white hover:bg-violet-700"
                >
                  Done
                </Button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Callback modal — CB ×₱50 + LG tiered */}
      {callbackModalEmail && (() => {
        const emp = calcResults.find((e) => e.email === callbackModalEmail);
        const empM = employeeMetrics[callbackModalEmail] ?? {};
        const cb = empM.callbackAppts ?? 0;
        const lg = empM.leadGenAppts ?? 0;
        const cbBonus = cb * 50;
        const lgBonus = calcLeadGenBonus(lg);
        const total = cbBonus + lgBonus;
        const lgTier = lg === 0 ? 'zero' : lg >= 10 ? 'hi' : 'lo';
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={() => setCallbackModalEmail(null)}
          >
            <div
              className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-white">
                    <Calculator className="h-4 w-4 text-violet-500" />
                    Callback Bonus
                  </h2>
                  <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {emp?.name || callbackModalEmail}
                  </p>
                </div>
                <button
                  onClick={() => setCallbackModalEmail(null)}
                  className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="mb-3 grid grid-cols-2 gap-3">
                <div>
                  <Label className="mb-1.5 block text-xs text-zinc-600 dark:text-zinc-400">
                    Callback appts
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    autoFocus
                    value={cb > 0 ? cb : ''}
                    placeholder="0"
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      const n = Number.isFinite(v) && v >= 0 ? v : 0;
                      startRecalc(() => {
                        setEmployeeMetrics((prev) => ({
                          ...prev,
                          [callbackModalEmail]: { ...(prev[callbackModalEmail] ?? {}), callbackAppts: n },
                        }));
                      });
                    }}
                    className="h-10 border-violet-200 bg-white text-center font-mono text-base dark:border-violet-800/50 dark:bg-zinc-900"
                  />
                </div>
                <div>
                  <Label className="mb-1.5 block text-xs text-zinc-600 dark:text-zinc-400">
                    LeadGen appts
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    value={lg > 0 ? lg : ''}
                    placeholder="0"
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      const n = Number.isFinite(v) && v >= 0 ? v : 0;
                      startRecalc(() => {
                        setEmployeeMetrics((prev) => ({
                          ...prev,
                          [callbackModalEmail]: { ...(prev[callbackModalEmail] ?? {}), leadGenAppts: n },
                        }));
                      });
                    }}
                    className="h-10 border-violet-200 bg-white text-center font-mono text-base dark:border-violet-800/50 dark:bg-zinc-900"
                  />
                </div>
              </div>

              <div className="mb-4 space-y-2 rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Callback</p>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-500 dark:text-zinc-400">{cb} × ₱50</span>
                  <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                    {formatPHP(cbBonus)}
                  </span>
                </div>

                <p className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">LeadGen</p>
                {([
                  ['10 or more appts', '₱500 × appts', 'hi'],
                  ['1 – 9 appts',       '₱250 × appts', 'lo'],
                  ['0 appts',           '₱0',           'zero'],
                ] as [string, string, string][]).map(([lbl, amt, tier]) => {
                  const active = tier === lgTier;
                  return (
                    <div
                      key={tier}
                      className={cn(
                        'flex items-center justify-between rounded-md border px-2.5 py-1 text-xs transition',
                        active
                          ? 'border-violet-500/50 bg-violet-50 font-semibold text-violet-800 dark:border-violet-500/40 dark:bg-violet-950/40 dark:text-violet-200'
                          : 'border-transparent text-zinc-500 dark:text-zinc-500',
                      )}
                    >
                      <span>{lbl}</span>
                      <span className="font-mono">{amt}</span>
                    </div>
                  );
                })}
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-500 dark:text-zinc-400">LeadGen subtotal</span>
                  <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                    {formatPHP(lgBonus)}
                  </span>
                </div>

                <div className="mt-2 flex items-center justify-between border-t border-zinc-200 pt-2 dark:border-zinc-800">
                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Total bonus</span>
                  <span className="font-mono text-base font-bold text-violet-600 dark:text-violet-400">
                    {formatPHP(total)}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    setEmployeeMetrics((prev) => ({
                      ...prev,
                      [callbackModalEmail]: {
                        ...(prev[callbackModalEmail] ?? {}),
                        callbackAppts: 0,
                        leadGenAppts: 0,
                      },
                    }))
                  }
                  className="text-xs"
                >
                  Clear
                </Button>
                <Button
                  onClick={() => setCallbackModalEmail(null)}
                  className="bg-violet-600 text-xs text-white hover:bg-violet-700"
                >
                  Done
                </Button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* QC modal — pool math for everyone, plus Jerome's per-unit + callback */}
      {qcModalEmail && (() => {
        const emp = calcResults.find((e) => e.email === qcModalEmail);
        const empM = employeeMetrics[qcModalEmail] ?? {};
        const isJerome = emp ? isJeromeRosero(emp.name) : false;
        const qcRoster = calcResults.filter(
          (e) => employeeDepts[e.email] === 'qc' && !isJeromeRosero(e.name),
        );
        const qcMemberCount = qcRoster.length;
        const unitsSold = deptMetrics['qc']?.unitsSold ?? 0;
        const cb = empM.callbackAppts ?? 0;
        const perMemberRate = qcMemberCount >= 6 ? 150 : 125;
        const rateNote = qcMemberCount >= 6 ? '≥ 6 members' : '< 6 members';
        const pool = unitsSold * perMemberRate;
        const poolShare = qcMemberCount > 0 ? pool / qcMemberCount : 0;
        const jeromeCore = unitsSold * 30;
        const jeromeCb = cb * 50;
        const total = isJerome ? jeromeCore + jeromeCb : poolShare;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={() => setQcModalEmail(null)}
          >
            <div
              className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-white">
                    <Calculator className="h-4 w-4 text-violet-500" />
                    QC — {isJerome ? 'Jerome Rosero' : 'Pool Share'}
                  </h2>
                  <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {emp?.name || qcModalEmail}
                  </p>
                </div>
                <button
                  onClick={() => setQcModalEmail(null)}
                  className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className={cn('grid gap-3', isJerome ? 'grid-cols-2' : 'grid-cols-1')}>
                <div>
                  <Label className="mb-1.5 block text-xs text-zinc-600 dark:text-zinc-400">
                    Units sold (team-wide)
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    autoFocus
                    value={unitsSold > 0 ? unitsSold : ''}
                    placeholder="0"
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      const n = Number.isFinite(v) && v >= 0 ? v : 0;
                      startRecalc(() => {
                        setDeptMetrics((prev) => ({
                          ...prev,
                          qc: { ...(prev.qc ?? {}), unitsSold: n },
                        }));
                      });
                    }}
                    className="h-10 border-violet-200 bg-white text-center font-mono text-base dark:border-violet-800/50 dark:bg-zinc-900"
                  />
                </div>
                {isJerome && (
                  <div>
                    <Label className="mb-1.5 block text-xs text-zinc-600 dark:text-zinc-400">
                      Callback appts (Jerome)
                    </Label>
                    <Input
                      type="number"
                      min={0}
                      value={cb > 0 ? cb : ''}
                      placeholder="0"
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        const n = Number.isFinite(v) && v >= 0 ? v : 0;
                        startRecalc(() => {
                          setEmployeeMetrics((prev) => ({
                            ...prev,
                            [qcModalEmail]: { ...(prev[qcModalEmail] ?? {}), callbackAppts: n },
                          }));
                        });
                      }}
                      className="h-10 border-violet-200 bg-white text-center font-mono text-base dark:border-violet-800/50 dark:bg-zinc-900"
                    />
                  </div>
                )}
              </div>

              <div className="mt-3 mb-4 space-y-1.5 rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                {isJerome ? (
                  <>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                      Per-unit QC
                    </p>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-500 dark:text-zinc-400">{unitsSold} × ₱30</span>
                      <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                        {formatPHP(jeromeCore)}
                      </span>
                    </div>
                    <p className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                      Callback add-on
                    </p>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-500 dark:text-zinc-400">{cb} × ₱50</span>
                      <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                        {formatPHP(jeromeCb)}
                      </span>
                    </div>
                    <p className="pt-1 text-[9px] italic text-zinc-500 dark:text-zinc-500">
                      Jerome is excluded from the QC pool and paid per-unit instead.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                      Pool formula
                    </p>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-500 dark:text-zinc-400">
                        Rate per unit ({rateNote})
                      </span>
                      <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                        {formatPHP(perMemberRate)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-500 dark:text-zinc-400">
                        Pool ({unitsSold} × {formatPHP(perMemberRate)})
                      </span>
                      <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                        {formatPHP(pool)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-500 dark:text-zinc-400">
                        ÷ {qcMemberCount} member
                        {qcMemberCount !== 1 ? 's' : ''}
                      </span>
                      <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                        {formatPHP(poolShare)}
                      </span>
                    </div>
                    <p className="pt-1 text-[9px] italic text-zinc-500 dark:text-zinc-500">
                      The pool is split equally across every QC member except Jerome.
                    </p>
                  </>
                )}
                <div className="mt-2 flex items-center justify-between border-t border-zinc-200 pt-2 dark:border-zinc-800">
                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    Bonus awarded
                  </span>
                  <span className="font-mono text-base font-bold text-violet-600 dark:text-violet-400">
                    {formatPHP(total)}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  onClick={() => setQcModalEmail(null)}
                  className="bg-violet-600 text-xs text-white hover:bg-violet-700"
                >
                  Done
                </Button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* HR modal — pool math (billable × ₱1000) ÷ new hires */}
      {hrModalEmail && (() => {
        const emp = calcResults.find((e) => e.email === hrModalEmail);
        const teal = emp ? isTeal(emp.name) : false;
        const hrRoster = calcResults.filter((e) => employeeDepts[e.email] === 'hr');
        const billable = hrRoster.filter((e) => !isTeal(e.name));
        const newHires = deptMetrics['hr']?.newHires ?? 0;
        const pool = billable.length * 1000;
        const share = newHires > 0 ? pool / newHires : 0;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={() => setHrModalEmail(null)}
          >
            <div
              className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-white">
                    <Calculator className="h-4 w-4 text-violet-500" />
                    HR — Pool Share
                  </h2>
                  <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {emp?.name || hrModalEmail}
                  </p>
                </div>
                <button
                  onClick={() => setHrModalEmail(null)}
                  className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="mb-3">
                <Label className="mb-1.5 block text-xs text-zinc-600 dark:text-zinc-400">
                  New hires after 4 weeks (team-wide)
                </Label>
                <Input
                  type="number"
                  min={0}
                  autoFocus
                  value={newHires > 0 ? newHires : ''}
                  placeholder="0"
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    const n = Number.isFinite(v) && v >= 0 ? v : 0;
                    startRecalc(() => {
                      setDeptMetrics((prev) => ({
                        ...prev,
                        hr: { ...(prev.hr ?? {}), newHires: n },
                      }));
                    });
                  }}
                  className="h-10 border-violet-200 bg-white text-center font-mono text-base dark:border-violet-800/50 dark:bg-zinc-900"
                />
              </div>

              <div className="mb-4 space-y-1.5 rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Pool</p>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-500 dark:text-zinc-400">
                    Billable HR members ({billable.length}) × ₱1,000
                  </span>
                  <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                    {formatPHP(pool)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-500 dark:text-zinc-400">
                    ÷ {newHires > 0 ? newHires : '?'} new hires
                  </span>
                  <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                    {newHires > 0 ? formatPHP(share) : '—'}
                  </span>
                </div>
                <p className="pt-1 text-[9px] italic text-zinc-500 dark:text-zinc-500">
                  Teal is excluded from the headcount and receives no pool share.
                </p>

                <div className="mt-2 flex items-center justify-between border-t border-zinc-200 pt-2 dark:border-zinc-800">
                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    Bonus awarded
                  </span>
                  <span className="font-mono text-base font-bold text-violet-600 dark:text-violet-400">
                    {formatPHP(teal ? 0 : (newHires > 0 ? share : 0))}
                  </span>
                </div>
                {teal && (
                  <p className="rounded-md bg-amber-50 px-2 py-1 text-[10px] text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                    Teal is excluded from this pool — bonus is ₱0.
                  </p>
                )}
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  onClick={() => setHrModalEmail(null)}
                  className="bg-violet-600 text-xs text-white hover:bg-violet-700"
                >
                  Done
                </Button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Generic single-metric modal — Discovery, Sales Asst, SmartStaff */}
      {simpleMetricModal && (() => {
        const cfg = simpleMetricModal;
        const emp = calcResults.find((e) => e.email === cfg.email);
        const empM = employeeMetrics[cfg.email] ?? {};
        const count = empM[cfg.metric] ?? 0;
        const bonus = count * cfg.rate;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={() => setSimpleMetricModal(null)}
          >
            <div
              className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-white">
                    <Calculator className="h-4 w-4 text-violet-500" />
                    {cfg.title}
                  </h2>
                  <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {emp?.name || cfg.email}
                  </p>
                </div>
                <button
                  onClick={() => setSimpleMetricModal(null)}
                  className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="mb-3">
                <Label className="mb-1.5 block text-xs text-zinc-600 dark:text-zinc-400">
                  {cfg.inputLabel}
                </Label>
                <Input
                  type="number"
                  min={0}
                  autoFocus
                  value={count > 0 ? count : ''}
                  placeholder="0"
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    const n = Number.isFinite(v) && v >= 0 ? v : 0;
                    startRecalc(() => {
                      setEmployeeMetrics((prev) => ({
                        ...prev,
                        [cfg.email]: { ...(prev[cfg.email] ?? {}), [cfg.metric]: n },
                      }));
                    });
                  }}
                  className="h-10 border-violet-200 bg-white text-center font-mono text-base dark:border-violet-800/50 dark:bg-zinc-900"
                />
              </div>

              <div className="mb-4 space-y-2 rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-500 dark:text-zinc-400">Rate</span>
                  <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                    {formatPHP(cfg.rate)} / {cfg.unitLabel}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-500 dark:text-zinc-400">Count</span>
                  <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">× {count}</span>
                </div>
                <div className="flex items-center justify-between border-t border-zinc-200 pt-2 dark:border-zinc-800">
                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Bonus awarded</span>
                  <span className="font-mono text-base font-bold text-violet-600 dark:text-violet-400">
                    {formatPHP(bonus)}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    setEmployeeMetrics((prev) => ({
                      ...prev,
                      [cfg.email]: { ...(prev[cfg.email] ?? {}), [cfg.metric]: 0 },
                    }))
                  }
                  className="text-xs"
                >
                  Clear
                </Button>
                <Button
                  onClick={() => setSimpleMetricModal(null)}
                  className="bg-violet-600 text-xs text-white hover:bg-violet-700"
                >
                  Done
                </Button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Dept formula hover-info chip — shown in Step 3 in place of the old big cards.
// Hover the (i) icon to read the bonus rules for the active department.
// ────────────────────────────────────────────────────────────────────────────
const DEPT_FORMULA_INFO: Record<string, { title: string; lines: string[] }> = {
  accounting: {
    title: 'Accounting — Tiered weekly bonus',
    lines: [
      '≥ 30 collected → ₱450',
      '22 – 29 collected → ₱300',
      '17 – 21 collected → ₱200',
      '< 17 collected → ₱0',
      'Enter per-weekday collections; sum sets the tier.',
    ],
  },
  edit: {
    title: 'Edit — Ticket bonus',
    lines: ['₱50 per completed ticket.'],
  },
  devs: {
    title: 'Devs — Tickets + Sites',
    lines: [
      '₱50 per completed ticket (all devs).',
      'Delivery (Harry Jr., Bryan): ₱50 per site delivered.',
      'Checking (Chris, Joe, John Carl): ₱250 per site checked.',
      'Total = tickets + sites.',
    ],
  },
  callback: {
    title: 'Callback — CB + LeadGen',
    lines: [
      'Callback: ₱50 per appointment.',
      'LeadGen 1–9 appts → ₱250 each.',
      'LeadGen 10+ appts → ₱500 each.',
      'Total = Callback + LeadGen.',
    ],
  },
  lead_gen: {
    title: 'Lead Gen — Tiered appointments',
    lines: [
      '10+ appts → ₱500 × appts.',
      '1 – 9 appts → ₱250 × appts.',
      '0 appts → ₱0.',
    ],
  },
  qc: {
    title: 'QC — Pool + Jerome exception',
    lines: [
      '₱150 per unit sold (₱125 if <6 QC members).',
      'Pool = units × rate, split equally among non-Jerome members.',
      'Jerome Rosero: units × ₱30 + his callback × ₱50 (excluded from pool).',
    ],
  },
  discovery: {
    title: 'Discovery — Units sold',
    lines: ['₱25 per unit sold in the prior week.'],
  },
  hr: {
    title: 'HR — Pool ÷ New Hires',
    lines: [
      'Pool = (HR members excluding Teal) × ₱1,000.',
      '÷ number of new hires after 4 weeks = per-person share.',
      'Teal is excluded from the pool.',
    ],
  },
  sales_assistant: {
    title: 'Sales Asst — Sales Bonus',
    lines: ['₱150 per sale last week (from the live scoreboard).'],
  },
  smart_staff: {
    title: 'SmartStaff — Appointments',
    lines: ['₱250 per appointment set.'],
  },
};

function DeptFormulaInfo({ deptKey, deptName }: { deptKey: string; deptName: string }) {
  const info = DEPT_FORMULA_INFO[deptKey];
  if (!info) return null;
  return (
    <div className="relative inline-flex items-center gap-1.5 self-start rounded-full border border-violet-200 bg-violet-50/60 px-2.5 py-1 text-[11px] text-violet-700 dark:border-violet-800/50 dark:bg-violet-950/20 dark:text-violet-300 [&:hover_.dept-formula-pop]:opacity-100 [&:hover_.dept-formula-pop]:pointer-events-auto">
      <Info className="h-3.5 w-3.5" />
      <span className="font-medium">{deptName} bonus rules</span>
      <div className="dept-formula-pop pointer-events-none absolute left-0 top-full z-20 mt-1 w-72 rounded-lg border border-zinc-200 bg-white p-3 text-zinc-700 opacity-0 shadow-lg transition-opacity dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
        <p className="mb-1.5 text-xs font-semibold text-zinc-900 dark:text-white">{info.title}</p>
        <ul className="space-y-0.5 text-[11px] leading-snug">
          {info.lines.map((line, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-violet-500">•</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
