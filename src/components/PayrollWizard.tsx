"use client";

import React, { useState, useRef, useEffect, useMemo, useTransition, useCallback } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { motion, AnimatePresence } from 'motion/react';
import * as XLSX from 'xlsx';
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
  ChevronLeft,
  CalendarDays,
  X,
  Info,
  Users,
  RefreshCw,
  Clock,
  Heart,
  Gift,
  BarChart3,
  Download,
  Timer,
  Play,
  StopCircle,
  HardHat,
} from 'lucide-react';
import { useDispatchLock } from '@/hooks/useDispatchLock';
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
  getCurrentPabMonth,
  filterColumnGroupsByPabRange,
  countMonFriInclusiveInRange,
  resolveCanonicalColumnsToIso,
  columnsAreAllCanonical,
  parseDateRangeFromFilename,
  checkHslPabEligibility,
  pabDateKey,
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
import { usePabPeriodSettings } from '@/hooks/usePabPeriodSettings';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { parseLocalDateFromIso } from '@/lib/pab-period-settings';
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
  /** ISO date (YYYY-MM-DD) when this paycheck is dispatched (Tuesday after the pay-period Sunday). */
  salary_date: string | null;
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
    mesa_deduction: number;
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

/**
 * Special bonus id whose amount is **per-employee** rather than a flat dept-wide
 * amount. The amount comes from the latest ready/locked SSD Medical Records KPI
 * sheet (`hsl_bonus_entries.calculated_bonus`). Surfaces on the Hogan Smith Law
 * tab; only members of the SSD Medical Records team are eligible.
 */
const KPI_BONUS_ID = 'kpi_bonus';

const DEPARTMENTS: {
  key: string;
  name: string;
  bonuses: { id: string; label: string; amount: number }[];
}[] = [
  { key: 'accounting',       name: 'Accounting',         bonuses: [] },
  { key: 'edit',             name: 'Edit',               bonuses: [] },
  { key: 'devs',             name: 'AI/API Team',         bonuses: [] },
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
    // The KPI Bonus amount is sourced from `hsl_bonus_entries` per employee
    // (latest ready/locked SSD Medical Records week). The `amount: 0` here is
    // a sentinel; the actual value is read from `ssdKpiAmounts[email]`.
    bonuses: [
      { id: KPI_BONUS_ID, label: 'KPI Bonus', amount: 0 },
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

/**
 * Extracts {year, month, day} from a Hubstaff or ISO column header without
 * going through a Date object. Prefer this over `parseColDate` when deriving
 * an ISO date string — Date round-trips can drift across timezones/DST.
 */
function parseColDateParts(col: string): { year: number; month: number; day: number } | null {
  const s = col.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    return { year: parseInt(iso[1], 10), month: parseInt(iso[2], 10), day: parseInt(iso[3], 10) };
  }
  const hub = /^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/i.exec(s);
  if (hub) {
    const month = parseInt(hub[1], 10);
    const day = parseInt(hub[2], 10);
    let year = hub[3] ? parseInt(hub[3], 10) : new Date().getFullYear();
    if (year < 100) year += 2000;
    return { year, month, day };
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

function isoDateFromColumnGroup(group: string[]): string | null {
  for (const col of group) {
    const parts = parseColDateParts(col);
    if (parts) {
      return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    }
  }
  return null;
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
    // ── Accounting (dept-level daily counts → same bonus for everyone) ──────
    case 'accounting': {
      const hasDailyBreakdown = ACCOUNTING_WEEKDAY_METRICS.some(({ key }) =>
        Object.prototype.hasOwnProperty.call(dm, key),
      );
      let sharedBonus = 0;
      if (hasDailyBreakdown) {
        for (const { key } of ACCOUNTING_WEEKDAY_METRICS) {
          const day = dm[key] ?? 0;
          if (day >= 30)      sharedBonus += 450;
          else if (day >= 22) sharedBonus += 300;
          else if (day >= 17) sharedBonus += 200;
        }
      } else {
        const collected = dm.collected ?? 0;
        if (collected >= 30)      sharedBonus = 450;
        else if (collected >= 22) sharedBonus = 300;
        else if (collected >= 17) sharedBonus = 200;
      }
      for (const emp of employees) {
        result[emp.email] = sharedBonus;
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

const steps = [
  {
    id: 1,
    label: 'Initialize Payroll Data',
    icon: Upload,
    description: 'Global master list + Hubstaff weekly → Supabase',
  },
  { id: 2, label: 'Initial Calculation', icon: DollarSign, description: 'Hubstaff hours × employee_hourly_rates → Initial Pay' },
  { id: 3, label: 'Additions', icon: Calculator, description: 'Apply bonuses and adjustments' },
  { id: 4, label: 'Orphanage', icon: Heart, description: 'Approved orphanage visits and the hours/wages they cover' },
  { id: 5, label: 'Tenure Gifts', icon: Gift, description: 'Tenure gifts approved by HR this PAB month' },
  { id: 6, label: 'Contractors', icon: HardHat, description: 'Pending contractor invoices — review and approve before dispatch' },
  { id: 7, label: 'Validation', icon: ShieldCheck, description: 'Pre-flight check and final review' },
  { id: 8, label: 'Dispatch', icon: Send, description: 'Trigger paystubs and payments' },
  { id: 9, label: 'Reports', icon: BarChart3, description: 'Dispatch summary — salaries, budget requests, and gift payments' },
];

export default function PayrollWizard({
  sessionEmail,
  initialData,
}: {
  sessionEmail?: string | null;
  initialData?: import('@/lib/accounting/prefetch').InitialAccountingData | null;
}) {
  const [currentStep, setCurrentStep] = useState(1);
  const [wizardStartedAt] = useState<Date>(() => new Date());
  const [reportSnapshot, setReportSnapshot] = useState<{
    startedAt: Date;
    dispatchedAt: Date;
    employees: DispatchEmployee[];
    budgetRequests: { id: string; submitter_email: string; submitted_at: string; decided_at: string | null; decided_by: string | null; visit_type: string; final_amount: number | string | null; status: string }[];
    giftPayments: { id: string; period_label: string; batch_label: string; vendor_name: string; total_usd: number; date_sent: string | null; status: string }[];
    tenureGifts: { id: string; personal_email: string; milestone_index: number; milestone_date: string; decided_at: string; decided_by: string | null; gift_name: string | null; gift_price_php: number | null }[];
    usdToPhpRate: number;
  } | null>(null);
  const [reportsTab, setReportsTab] = useState<'salaries' | 'budget' | 'gifts'>('salaries');
  const [users, setUsers] = useState<User[]>(MOCK_USERS);
  const [timeRecords, setTimeRecords] = useState<TimeRecord[]>(MOCK_TIME_RECORDS);
  const [payments, setPayments] = useState<PaymentLineItem[]>(MOCK_PAYMENTS);
  const [hubstaffData, setHubstaffData] = useState<HubstaffRow[]>([]);
  const [issues, setIssues] = useState<ReconciliationIssue[]>([]);
  const [isHoganCycle, setIsHoganCycle] = useState(false);
  const [masterEmployees, setMasterEmployees] = useState<EmployeeRow[]>(
    initialData?.employees ?? [],
  );
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
  const [masterListUploadLoading, setMasterListUploadLoading] = useState(false);
  const [ratesUploadLoading, setRatesUploadLoading] = useState(false);
  const { state: lockState, setLocked } = useDispatchLock();
  const [togglingLock, setTogglingLock] = useState(false);
  const [confirmingLockToggle, setConfirmingLockToggle] = useState(false);
  const [hslSyncLoading, setHslSyncLoading] = useState(false);
  const [hslSyncResult, setHslSyncResult] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const [masterSyncPct, setMasterSyncPct] = useState<{ pct: number } | null>(null);
  const [ratesSyncPct, setRatesSyncPct] = useState<{ pct: number } | null>(null);
  const [hslSyncPct, setHslSyncPct] = useState<{ pct: number } | null>(null);
  const syncTimers = useRef<{ master?: ReturnType<typeof setInterval>; rates?: ReturnType<typeof setInterval>; hsl?: ReturnType<typeof setInterval> }>({});
  const [hubstaffPage, setHubstaffPage] = useState(1);
  const HUBSTAFF_PAGE_SIZE = 15;
  const SOURCE_FILE_PAGE_SIZE = 25;
  const [hubstaffSearch, setHubstaffSearch] = useState('');
  const [initialCalcSearch, setInitialCalcSearch] = useState('');
  const [initialCalcPage, setInitialCalcPage] = useState(1);
  const [approveUploadDialogOpen, setApproveUploadDialogOpen] = useState(false);
  const [previewPaystubsOpen, setPreviewPaystubsOpen] = useState(false);
  const [previewSelectedEmail, setPreviewSelectedEmail] = useState<string | null>(null);
  const [previewSearch, setPreviewSearch] = useState('');
  const [previewTab, setPreviewTab] = useState<'paystubs' | 'orphanage' | 'contractors'>('paystubs');
  const [previewSelectedOrphanageId, setPreviewSelectedOrphanageId] = useState<string | null>(null);
  const [isDispatching, setIsDispatching] = useState(false);
  const [pendingWeekly, setPendingWeekly] = useState<{
    text: string;
    fileName: string;
  } | null>(null);

  // ── Uploaded-files browser tab state ──
  const [hubstaffActiveTab, setHubstaffActiveTab] = useState<'files' | 'upload'>('upload');
  const [uploadedSourceFiles, setUploadedSourceFiles] = useState<string[]>(
    initialData?.sourceFiles ?? [],
  );
  const [hubstaffUploads, setHubstaffUploads] = useState<
    {
      id: string;
      source_file: string | null;
      uploaded_at: string;
      row_count: number | null;
      is_current: boolean;
    }[]
  >(initialData?.hubstaffUploads ?? []);

  // Look up upload metadata (timestamp, row count, is_current) by filename. If
  // multiple uploads share the same source_file, the newest wins (backend orders
  // uploaded_at DESC).
  const uploadMetaByFile = React.useMemo(() => {
    const map = new Map<string, { uploaded_at: string; row_count: number | null; is_current: boolean }>();
    for (const u of hubstaffUploads) {
      const f = (u.source_file ?? '').trim();
      if (!f || map.has(f)) continue;
      map.set(f, {
        uploaded_at: u.uploaded_at,
        row_count: u.row_count,
        is_current: u.is_current,
      });
    }
    return map;
  }, [hubstaffUploads]);

  /** Short human-readable timestamp. Returns null on invalid input. */
  const formatUploadStamp = React.useCallback((iso: string | null | undefined): string | null => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }, []);
  const [sourceFilesLoading, setSourceFilesLoading] = useState(true);
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

  const [hourlyRateRows, setHourlyRateRows] = useState<EmployeeHourlyRateRow[]>(
    initialData?.hourlyRates ?? [],
  );
  const [hourlyRatesLoading, setHourlyRatesLoading] = useState(false);
  const [hourlyRatesError, setHourlyRatesError] = useState<string | null>(null);

  // ── Orphanage step (id=4): all orphanage_visit + ceo_visitation disputes
  // inside the active PAB month range. Fetched lazily when the user lands on
  // the step; keyed by `pabMonthRange` so changing the month re-fetches.
  const [orphanageRows, setOrphanageRows] = useState<{
    work_email: string;
    dispute_date: string;
    reason: string;
    status: string;
    override_hours: number | null;
    explanation: string | null;
  }[]>([]);
  const [orphanageLoading, setOrphanageLoading] = useState(false);
  const [orphanageError, setOrphanageError] = useState<string | null>(null);
  const [orphanageSearch, setOrphanageSearch] = useState('');

  // ── Orphanage budget requests for Accounting approval/dispatch. Amounts are
  // already in PHP; only approved rows are added to the payroll outflow.
  const [budgetRequestRows, setBudgetRequestRows] = useState<{
    id: string;
    submitter_email: string;
    submitted_at: string;
    created_at: string | null;
    updated_at: string | null;
    decided_at: string | null;
    decided_by: string | null;
    visit_type: string;
    mission_trip: boolean;
    subtotal: number | string | null;
    leftover: number | string | null;
    final_amount: number | string | null;
    status: 'pending' | 'approved' | 'rejected';
  }[]>([]);
  const [budgetRequestsLoading, setBudgetRequestsLoading] = useState(false);
  const [budgetRequestsError, setBudgetRequestsError] = useState<string | null>(null);
  const [budgetRequestDecidingId, setBudgetRequestDecidingId] = useState<string | null>(null);

  // ── Gift payments (vendor payouts) for the active PAB month. Amounts are
  // USD; converted to PHP for the outflow total via `usdToPhpRate`.
  const [giftPaymentRows, setGiftPaymentRows] = useState<{
    id: string;
    period_label: string;
    batch_label: string;
    vendor_name: string;
    total_usd: number;
    date_sent: string | null;
    created_at: string;
    status: string;
  }[]>([]);
  const [giftPaymentsLoading, setGiftPaymentsLoading] = useState(false);
  const [giftPaymentsError, setGiftPaymentsError] = useState<string | null>(null);

  // ── Approved tenure gifts (from Gift Tracker shipping submissions) in the active
  // PAB month. Each approved row carries a gift_name + gift_price_php (PHP) that
  // flows into the Accounting weekly outflow.
  const [tenureGiftRows, setTenureGiftRows] = useState<{
    id: string;
    personal_email: string;
    milestone_index: number;
    milestone_date: string;
    decided_at: string;
    decided_by: string | null;
    gift_name: string;
    gift_price_php: number;
  }[]>([]);
  const [tenureGiftsLoading, setTenureGiftsLoading] = useState(false);
  const [tenureGiftsError, setTenureGiftsError] = useState<string | null>(null);
  const [tenureGiftAccountingStatus, setTenureGiftAccountingStatus] = useState<Record<string, 'approved' | 'rejected'>>({});

  type OrphanageTab = 'visits' | 'wages' | 'budgets';
  const [orphanageTab, setOrphanageTab] = useState<OrphanageTab>('visits');

  // ── Step 5: Contractor invoices ──────────────────────────────────────────────
  const [contractorInvoices, setContractorInvoices] = useState<{
    id: string;
    contractor_email: string;
    invoice_number: string;
    invoice_date: string;
    due_date: string;
    from_entity_name: string;
    from_name: string;
    total: number;
    status: string;
  }[]>([]);
  const [contractorInvoicesLoading, setContractorInvoicesLoading] = useState(false);
  const [contractorInvoicesUpdating, setContractorInvoicesUpdating] = useState<string | null>(null);

  /** USD → PHP (PHP per $1). Saved in app_settings `usd_to_php_rate`; default is the official ₱100,000 ÷ 10⁵ rate. */
  const [usdToPhpRate, setUsdToPhpRate] = useState<number>(OFFICIAL_USD_TO_PHP_RATE);
  const [usdToPhpInput, setUsdToPhpInput] = useState<string>(String(OFFICIAL_USD_TO_PHP_RATE));
  const [usdToPhpSaving, setUsdToPhpSaving] = useState(false);
  const [usdToPhpEditing, setUsdToPhpEditing] = useState(false);

  const [activeDeptTab, setActiveDeptTab] = useState('accounting');
  const [accountingDeptModalOpen, setAccountingDeptModalOpen] = useState(false);
  const [ticketsModalEmail, setTicketsModalEmail] = useState<string | null>(null);
  const [sitesModalEmail, setSitesModalEmail] = useState<string | null>(null);
  const [leadGenModalEmail, setLeadGenModalEmail] = useState<string | null>(null);
  const [callbackModalEmail, setCallbackModalEmail] = useState<string | null>(null);
  const [qcModalEmail, setQcModalEmail] = useState<string | null>(null);
  const [hrModalEmail, setHrModalEmail] = useState<string | null>(null);
  const [pabCalendarModalEmail, setPabCalendarModalEmail] = useState<string | null>(null);
  // ── Inline PAB period setter: per-month memory + active-month selector ──────
  /** Local YYYY-MM-DD for the active month's start/end date inputs (mirrors the hook after each refresh). */
  const [pabStartLocal, setPabStartLocal] = useState('');
  const [pabEndLocal, setPabEndLocal] = useState('');
  /** Year shown in the 12-month strip (defaults to today's year; arrows shift ±1 year). */
  const [pabPickerYear, setPabPickerYear] = useState<number>(() => new Date().getFullYear());
  const [pabSaveState, setPabSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [pabRefreshing, setPabRefreshing] = useState(false);
  const [pabSettingsOpen, setPabSettingsOpen] = useState(false);
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
  /** Accounting-side per-employee bonus overrides. When present, replaces the auto-computed total. */
  const [bonusOverrides, setBonusOverrides] = useState<Record<string, number>>({});
  /** Session-only row deletes for the Orphanage step tables. */
  const [hiddenVisitIds, setHiddenVisitIds] = useState<Set<string>>(new Set());
  const [hiddenWageEmails, setHiddenWageEmails] = useState<Set<string>>(new Set());
  const [hiddenBudgetIds, setHiddenBudgetIds] = useState<Set<string>>(new Set());
  /** Per-employee numeric metrics: email → { metric → value }. Used by formula-based departments. */
  const [employeeMetrics, setEmployeeMetrics] = useState<Record<string, Record<string, number>>>({});
  /** Department-level numeric metrics: deptKey → { metric → value }. Used for pool calculations (QC, HR). */
  const [deptMetrics, setDeptMetrics] = useState<Record<string, Record<string, number>>>({});

  /**
   * SSD Medical Records KPI Bonus pull. Sourced from the latest `ready` or
   * `locked` SSD weekly entries in `hsl_bonus_entries`. Only employees in
   * `hsl_team_members` with `dept_key='ssd_medical_records'` are eligible.
   * Powers the Hogan Smith Law tab's KPI Bonus column.
   */
  const [ssdMemberEmails, setSsdMemberEmails] = useState<Set<string>>(new Set());
  const [ssdKpiAmounts, setSsdKpiAmounts] = useState<Record<string, number>>({});
  const [ssdKpiPeriod, setSsdKpiPeriod] = useState<{
    period_start: string;
    period_end: string;
    status: 'ready' | 'locked';
  } | null>(null);
  const [ssdKpiLoading, setSsdKpiLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setSsdKpiLoading(true);
    (async () => {
      try {
        const [membersRes, statusRes] = await Promise.all([
          fetch('/api/hsl-bonus/team-members?dept=ssd_medical_records', { cache: 'no-store' }),
          fetch('/api/hsl-bonus/period-status?dept=ssd_medical_records', { cache: 'no-store' }),
        ]);
        const membersJson = (await membersRes.json()) as {
          rows?: { email: string }[];
        };
        const statusJson = (await statusRes.json()) as {
          rows?: { period_start: string; period_end: string; status: 'draft' | 'ready' | 'locked' }[];
        };
        if (cancelled) return;

        const memberSet = new Set<string>();
        for (const m of membersJson.rows ?? []) {
          if (m.email) memberSet.add(m.email.toLowerCase());
        }
        setSsdMemberEmails(memberSet);

        // Pick the latest ready/locked period — prefer locked over ready when
        // they tie on date (locked is the harder commit).
        const periods = (statusJson.rows ?? []).filter(
          (p) => p.status === 'ready' || p.status === 'locked',
        );
        if (periods.length === 0) {
          setSsdKpiPeriod(null);
          setSsdKpiAmounts({});
          return;
        }
        periods.sort((a, b) => {
          if (a.period_start !== b.period_start) {
            return b.period_start.localeCompare(a.period_start);
          }
          // Same date: locked beats ready
          return a.status === 'locked' ? -1 : b.status === 'locked' ? 1 : 0;
        });
        const latest = periods[0]!;
        setSsdKpiPeriod({
          period_start: latest.period_start,
          period_end: latest.period_end,
          status: latest.status as 'ready' | 'locked',
        });

        const entriesRes = await fetch(
          `/api/hsl-bonus/entries?dept=ssd_medical_records&period_start=${latest.period_start}`,
          { cache: 'no-store' },
        );
        const entriesJson = (await entriesRes.json()) as {
          rows?: { employee_email: string; calculated_bonus: number }[];
        };
        if (cancelled) return;
        const amounts: Record<string, number> = {};
        for (const e of entriesJson.rows ?? []) {
          if (e.employee_email) {
            amounts[e.employee_email.toLowerCase()] = Math.round(e.calculated_bonus ?? 0);
          }
        }
        setSsdKpiAmounts(amounts);
      } catch {
        // Silent — empty state is fine; the column will show "no week ready".
      } finally {
        if (!cancelled) setSsdKpiLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Overtime settings from System Settings ──────────────────────────────────
  const [otGlobalSuspended, setOtGlobalSuspended] = useState(false);
  const [otDeptEnabled, setOtDeptEnabled] = useState<Record<string, boolean>>(
    Object.fromEntries(DEPARTMENTS.map(d => [`ot_dept_${d.key}`, true])),
  );

  const pabPeriodSettings = usePabPeriodSettings();

  /**
   * Sync hook → local form state whenever the hook refreshes (initial load, save, refresh button).
   * Local inputs always reflect the active month's resolved range (override or default).
   */
  useEffect(() => {
    if (pabPeriodSettings.loading) return;
    const toIso = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    setPabStartLocal(toIso(pabPeriodSettings.activeRange.start));
    setPabEndLocal(toIso(pabPeriodSettings.activeRange.end));
    setPabPickerYear(pabPeriodSettings.activeMonthResolved.year);
  }, [
    pabPeriodSettings.loading,
    pabPeriodSettings.activeRange.start,
    pabPeriodSettings.activeRange.end,
    pabPeriodSettings.activeMonthResolved.year,
  ]);

  const savePabSetting = React.useCallback(async (key: string, value: string) => {
    const res = await fetch('/api/app-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    const json = (await res.json()) as { error: string | null };
    if (json.error) throw new Error(json.error);
  }, []);

  /**
   * Serialize the overrides map (Date-based) back to the JSON shape stored in app_settings.
   * Optionally patches a single month's entry (pass `null` to remove that month's override).
   */
  const writeOverridesBlob = React.useCallback(
    async (patchKey: string, patch: { start: string; end: string } | null) => {
      const next: Record<string, { start: string; end: string }> = {};
      for (const [k, v] of pabPeriodSettings.overrides.entries()) {
        if (k === patchKey) continue;
        next[k] = {
          start: `${v.start.getFullYear()}-${String(v.start.getMonth() + 1).padStart(2, '0')}-${String(v.start.getDate()).padStart(2, '0')}`,
          end: `${v.end.getFullYear()}-${String(v.end.getMonth() + 1).padStart(2, '0')}-${String(v.end.getDate()).padStart(2, '0')}`,
        };
      }
      if (patch) next[patchKey] = patch;
      await savePabSetting('pab_period_overrides', JSON.stringify(next));
    },
    [pabPeriodSettings.overrides, savePabSetting],
  );

  /** Save a start/end override for the *active* month only. */
  const saveActiveMonthOverride = React.useCallback(
    async (start: string, end: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return;
      const sd = parseLocalDateFromIso(start);
      const ed = parseLocalDateFromIso(end);
      if (!sd || !ed || sd.getTime() > ed.getTime()) {
        toast.error('Invalid PAB period', { description: 'End date must be on or after start date.' });
        return;
      }
      setPabSaveState('saving');
      try {
        await writeOverridesBlob(pabPeriodSettings.activeMonthResolved.key, { start, end });
        await pabPeriodSettings.refresh();
        setPabSaveState('saved');
        toast.success('PAB override saved', { description: `${start} → ${end}` });
        setTimeout(() => setPabSaveState('idle'), 2000);
      } catch (e) {
        setPabSaveState('error');
        toast.error('Save failed', { description: e instanceof Error ? e.message : 'Unknown error' });
        setTimeout(() => setPabSaveState('idle'), 3000);
      }
    },
    [writeOverridesBlob, pabPeriodSettings],
  );

  /**
   * Auto-calculate the active month's PAB window from the canonical rule
   * (first Mon on/after the 1st → Friday of the last week whose Monday falls in the month)
   * and save it as that month's override. Useful to explicitly re-anchor a drifted custom range.
   */
  const autoCalcActiveMonth = React.useCallback(async () => {
    const { year, month } = pabPeriodSettings.activeMonthResolved;
    const r = getPabMonthRange(year, month);
    const startIso = `${r.start.getFullYear()}-${String(r.start.getMonth() + 1).padStart(2, '0')}-${String(r.start.getDate()).padStart(2, '0')}`;
    const endIso = `${r.end.getFullYear()}-${String(r.end.getMonth() + 1).padStart(2, '0')}-${String(r.end.getDate()).padStart(2, '0')}`;
    setPabSaveState('saving');
    try {
      await writeOverridesBlob(pabPeriodSettings.activeMonthResolved.key, { start: startIso, end: endIso });
      await pabPeriodSettings.refresh();
      setPabSaveState('saved');
      toast.success('PAB dates auto-calculated', { description: `${startIso} → ${endIso}` });
      setTimeout(() => setPabSaveState('idle'), 2000);
    } catch (e) {
      setPabSaveState('error');
      toast.error('Save failed', { description: e instanceof Error ? e.message : 'Unknown error' });
      setTimeout(() => setPabSaveState('idle'), 3000);
    }
  }, [pabPeriodSettings, writeOverridesBlob]);

  /** Remove the override for the active month; the default `getPabMonthRange` takes over. */
  const resetActiveMonthOverride = React.useCallback(async () => {
    setPabSaveState('saving');
    try {
      await writeOverridesBlob(pabPeriodSettings.activeMonthResolved.key, null);
      await pabPeriodSettings.refresh();
      setPabSaveState('saved');
      toast.success('Override removed', { description: 'Reverted to the default Mon–Fri window for this month.' });
      setTimeout(() => setPabSaveState('idle'), 2000);
    } catch (e) {
      setPabSaveState('error');
      toast.error('Save failed', { description: e instanceof Error ? e.message : 'Unknown error' });
      setTimeout(() => setPabSaveState('idle'), 3000);
    }
  }, [writeOverridesBlob, pabPeriodSettings]);

  /** Switch which month the Additions tab evaluates. */
  const selectPabMonth = React.useCallback(
    async (year: number, month: number) => {
      const key = `${year}-${String(month + 1).padStart(2, '0')}`;
      setPabSaveState('saving');
      try {
        await savePabSetting('pab_period_active_month', key);
        await pabPeriodSettings.refresh();
        setPabSaveState('saved');
        setTimeout(() => setPabSaveState('idle'), 1500);
      } catch (e) {
        setPabSaveState('error');
        toast.error('Save failed', { description: e instanceof Error ? e.message : 'Unknown error' });
        setTimeout(() => setPabSaveState('idle'), 3000);
      }
    },
    [savePabSetting, pabPeriodSettings],
  );

  const [approvedDisputeDates, setApprovedDisputeDates] = useState<Map<string, Map<string, number | null>>>(new Map());

  const fileInputWeeklyRef = useRef<HTMLInputElement>(null);
  const masterListFileInputRef = useRef<HTMLInputElement>(null);
  const ratesFileInputRef = useRef<HTMLInputElement>(null);

  const reloadMasterEmployees = React.useCallback(async () => {
    try {
      const res = await fetch('/api/employees', { cache: 'no-store' });
      if (!res.ok) return;
      const json = (await res.json()) as { employees: EmployeeRow[]; error: string | null };
      setMasterEmployees(json.employees ?? []);
    } catch {
      // payrollComparison degrades gracefully with an empty list
    }
  }, []);

  // Skip the first reload when the server already shipped employees via
  // initialData. Step navigation / sync buttons still call reloadMasterEmployees
  // directly when they need fresh data.
  const skipInitialEmployeesFetchRef = useRef(Boolean(initialData?.employees?.length));
  useEffect(() => {
    if (skipInitialEmployeesFetchRef.current) {
      skipInitialEmployeesFetchRef.current = false;
      return;
    }
    void reloadMasterEmployees();
  }, [reloadMasterEmployees]);

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

  // Fetch overtime settings (global + per-department) — single bulk call to
  // /api/app-settings?keys=… instead of one round-trip per key.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const allKeys = ['ot_global_suspended', ...DEPARTMENTS.map(d => `ot_dept_${d.key}`)];
        const res = await fetch(
          `/api/app-settings?keys=${encodeURIComponent(allKeys.join(','))}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as { values?: Record<string, string | null> };
        if (cancelled) return;
        const values = json.values ?? {};
        setOtGlobalSuspended(values['ot_global_suspended'] === 'true');
        const deptMap: Record<string, boolean> = {};
        DEPARTMENTS.forEach((d) => {
          const val = values[`ot_dept_${d.key}`];
          deptMap[`ot_dept_${d.key}`] = val == null ? true : val === 'true';
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

  // Step 2 needs the rates table. Skip the first call when initialData
  // already shipped it — manual re-load buttons inside step 2 still re-fetch.
  const skipInitialRatesFetchRef = useRef(Boolean(initialData?.hourlyRates?.length));
  useEffect(() => {
    if (currentStep !== 2) return;
    if (skipInitialRatesFetchRef.current) {
      skipInitialRatesFetchRef.current = false;
      return;
    }
    void loadEmployeeHourlyRates();
  }, [currentStep, loadEmployeeHourlyRates]);

  // Auto-select latest uploaded source file as soon as the list is available.
  // If no source files exist, fall back to loading all rows.
  // Hubstaff: newest upload is always the payroll source of truth (files[0] from API).
  useEffect(() => {
    if (uploadedSourceFiles.length === 0) {
      setCalcSourceFile(null);
      return;
    }
    setCalcSourceFile(uploadedSourceFiles[0]);
  }, [uploadedSourceFiles]);

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

  // PAB eligibility (Additions / Step 3) merges **every** archived Hubstaff upload so the
  // full PAB month has data, not just the latest weekly CSV. Matches the Employee Dashboard.
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
          // Fetch every archived upload in parallel and merge by email so canonical
          // weekday columns from different weeks don't overwrite each other (each week
          // resolves `monday`..`sunday` to distinct ISO dates via the source filename).
          const responses = await Promise.all(
            uploadedSourceFiles.map((file) =>
              fetch(
                `/api/hubstaff-hours?source_file=${encodeURIComponent(file)}&_=${Date.now()}`,
                { cache: 'no-store' },
              )
                .then(async (res) => {
                  const json = (await res.json()) as {
                    columns?: string[] | null;
                    rows?: Record<string, unknown>[] | null;
                  };
                  return { file, json };
                })
                .catch(() => ({ file, json: { columns: null, rows: null } as { columns: null; rows: null } })),
            ),
          );
          if (cancelled) return;
          for (const { file, json } of responses) {
            if (!json.columns?.length || !json.rows?.length) continue;
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

  // Lookup maps over masterEmployees, built once per roster change. The Step 2
  // calc, the department auto-assign effect, and dispatchData each need to match
  // a Hubstaff row to its master record; doing that with `masterEmployees.find()`
  // inside a per-employee loop is O(employees × roster) and re-runs
  // normalizeNameTokens for every comparison — that synchronous work is what made
  // the Initial Calculation skeleton stutter. Map lookups make each match O(1).
  // First occurrence wins, mirroring `.find()` semantics.
  const masterIndex = useMemo(() => {
    type M = typeof masterEmployees[number];
    const byWorkEmail = new Map<string, M>();
    const byPersonalEmail = new Map<string, M>();
    const byNameTokens = new Map<string, M>();
    for (const e of masterEmployees) {
      const we = normEmail(e.work_email);
      if (we && !byWorkEmail.has(we)) byWorkEmail.set(we, e);
      const pe = normEmail(e.personal_email);
      if (pe && !byPersonalEmail.has(pe)) byPersonalEmail.set(pe, e);
      if (e.name) {
        const t = normalizeNameTokens(e.name);
        if (t && !byNameTokens.has(t)) byNameTokens.set(t, e);
      }
    }
    return { byWorkEmail, byPersonalEmail, byNameTokens };
  }, [masterEmployees]);

  const hubstaffByEmail = useMemo(() => {
    type H = typeof hubstaffData[number];
    const m = new Map<string, H>();
    for (const h of hubstaffData) {
      const e = normEmail(h.email);
      if (e && !m.has(e)) m.set(e, h);
    }
    return m;
  }, [hubstaffData]);

  /**
   * PAB month + computed date range for the Additions tab.
   *
   * Sourced from `usePabPeriodSettings` — the hook resolves the active month (defaulting
   * to today's PAB month) and picks a saved override when present, otherwise the default
   * `getPabMonthRange(year, month)` window per docs §"PAB month period".
   */
  const pabMonthRange = useMemo(() => {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const { year, month } = pabPeriodSettings.activeMonthResolved;
    const { start, end } = pabPeriodSettings.activeRange;
    return { year, month, start, end, monthName: monthNames[month] ?? '' };
  }, [
    pabPeriodSettings.activeMonthResolved,
    pabPeriodSettings.activeRange,
  ]);

  // Load orphanage disputes (orphanage_visit + ceo_visitation) for the active
  // PAB range when the user lands on step 4. Re-fetches if the range changes.
  useEffect(() => {
    if ((currentStep !== 4 && !previewPaystubsOpen) || !pabMonthRange) return;
    const ctrl = new AbortController();
    setOrphanageLoading(true);
    setOrphanageError(null);
    const params = new URLSearchParams({
      from: pabMonthRange.start.toLocaleDateString('en-CA'),
      to: pabMonthRange.end.toLocaleDateString('en-CA'),
      _: String(Date.now()),
    });
    fetch(`/api/pab-disputes/orphanage-overlap?${params}`, {
      cache: 'no-store',
      signal: ctrl.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          rows?: {
            work_email: string;
            dispute_date: string;
            reason: string;
            status: string;
            override_hours: number | null;
            explanation: string | null;
          }[];
        };
        setOrphanageRows(json.rows ?? []);
      })
      .catch((e) => {
        if ((e as { name?: string })?.name === 'AbortError') return;
        setOrphanageError(e instanceof Error ? e.message : 'Failed to load orphanage disputes');
        setOrphanageRows([]);
      })
      .finally(() => setOrphanageLoading(false));
    return () => ctrl.abort();
  }, [currentStep, pabMonthRange, previewPaystubsOpen]);

  // ── Budget requests for Accounting approval/dispatch ──
  // Pull all rows so pending Orphanage-side requests can be approved here. Approved
  // rows count toward dispatch; pending rows stay visible so Accounting can close them.
  useEffect(() => {
    if ((currentStep !== 4 && currentStep !== 5 && currentStep !== 7 && currentStep !== 9 && !previewPaystubsOpen) || !pabMonthRange) return;
    const ctrl = new AbortController();
    setBudgetRequestsLoading(true);
    setBudgetRequestsError(null);
    const monthStart = new Date(pabMonthRange.year, pabMonthRange.month, 1).getTime();
    const monthEnd = new Date(
      pabMonthRange.year,
      pabMonthRange.month + 1,
      0,
      23,
      59,
      59,
      999,
    ).getTime();
    const rangeStart = new Date(
      pabMonthRange.start.getFullYear(),
      pabMonthRange.start.getMonth(),
      pabMonthRange.start.getDate(),
    ).getTime();
    const rangeEnd = new Date(
      pabMonthRange.end.getFullYear(),
      pabMonthRange.end.getMonth(),
      pabMonthRange.end.getDate(),
      23,
      59,
      59,
      999,
    ).getTime();
    const isInActiveWindow = (iso: string | null | undefined): boolean => {
      if (!iso) return false;
      const t = new Date(iso).getTime();
      return Number.isFinite(t) && (
        (t >= monthStart && t <= monthEnd) ||
        (t >= rangeStart && t <= rangeEnd)
      );
    };
    fetch(`/api/orphanage-budget-requests`, {
      cache: 'no-store',
      signal: ctrl.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          rows?: {
            id: string;
            submitter_email: string;
            submitted_at: string;
            created_at: string | null;
            updated_at: string | null;
            decided_at: string | null;
            decided_by: string | null;
            visit_type: string;
            mission_trip: boolean;
            subtotal: number | string | null;
            leftover: number | string | null;
            final_amount: number | string | null;
            status: 'pending' | 'approved' | 'rejected';
          }[];
        };
        const filtered = (json.rows ?? []).filter((r) => {
          if (r.status === 'pending') return true;
          if (r.status !== 'approved') return false;
          return (
            isInActiveWindow(r.decided_at) ||
            isInActiveWindow(r.submitted_at) ||
            isInActiveWindow(r.created_at) ||
            isInActiveWindow(r.updated_at)
          );
        });
        setBudgetRequestRows(filtered);
      })
      .catch((e) => {
        if ((e as { name?: string })?.name === 'AbortError') return;
        setBudgetRequestsError(e instanceof Error ? e.message : 'Failed to load budget requests');
        setBudgetRequestRows([]);
      })
      .finally(() => setBudgetRequestsLoading(false));
    return () => ctrl.abort();
  }, [currentStep, pabMonthRange, previewPaystubsOpen]);

  const decideBudgetRequest = useCallback(async (
    id: string,
    status: 'approved' | 'rejected',
  ) => {
    setBudgetRequestDecidingId(id);
    try {
      const res = await fetch(`/api/orphanage-budget-requests/${encodeURIComponent(id)}/decide`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          decided_by: sessionEmail || 'Payroll Wizard',
        }),
      });
      const json = (await res.json()) as {
        row?: typeof budgetRequestRows[number] | null;
        error?: string | null;
      };
      if (!res.ok || json.error || !json.row) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setBudgetRequestRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, ...json.row } : r)),
      );
      toast.success(
        status === 'approved'
          ? 'Budget request approved for payroll dispatch.'
          : 'Budget request rejected.',
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update budget request');
    } finally {
      setBudgetRequestDecidingId(null);
    }
  }, []);

  // ── Gift payments (sent/paid, in PAB month) ──
  // No status filter at the API; we keep rows whose status is sent|paid and
  // whose date_sent (or created_at as fallback) lands inside the PAB month.
  useEffect(() => {
    if ((currentStep !== 4 && currentStep !== 5 && currentStep !== 7 && currentStep !== 9 && !previewPaystubsOpen) || !pabMonthRange) return;
    const ctrl = new AbortController();
    setGiftPaymentsLoading(true);
    setGiftPaymentsError(null);
    const startMid = new Date(
      pabMonthRange.start.getFullYear(),
      pabMonthRange.start.getMonth(),
      pabMonthRange.start.getDate(),
    ).getTime();
    const endMid = new Date(
      pabMonthRange.end.getFullYear(),
      pabMonthRange.end.getMonth(),
      pabMonthRange.end.getDate(),
      23,
      59,
      59,
      999,
    ).getTime();
    fetch(`/api/gift-payments`, {
      cache: 'no-store',
      signal: ctrl.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          rows?: {
            id: string;
            period_label: string;
            batch_label: string;
            vendor: { name: string };
            total_usd: number;
            date_sent: string | null;
            created_at: string;
            status: string;
          }[];
        };
        const filtered = (json.rows ?? [])
          .filter((r) => r.status === 'sent' || r.status === 'paid')
          .filter((r) => {
            const refDate = r.date_sent ?? r.created_at;
            const t = new Date(refDate).getTime();
            return Number.isFinite(t) && t >= startMid && t <= endMid;
          })
          .map((r) => ({
            id: r.id,
            period_label: r.period_label,
            batch_label: r.batch_label,
            vendor_name: r.vendor?.name ?? '—',
            total_usd: r.total_usd,
            date_sent: r.date_sent,
            created_at: r.created_at,
            status: r.status,
          }));
        setGiftPaymentRows(filtered);
      })
      .catch((e) => {
        if ((e as { name?: string })?.name === 'AbortError') return;
        setGiftPaymentsError(e instanceof Error ? e.message : 'Failed to load gift payments');
        setGiftPaymentRows([]);
      })
      .finally(() => setGiftPaymentsLoading(false));
    return () => ctrl.abort();
  }, [currentStep, pabMonthRange, previewPaystubsOpen]);

  // ── Tenure gifts (approved shipping submissions, in PAB month by decided_at) ──
  // We keep rows even when gift_name / gift_price_php are null (legacy approvals
  // from before the gift-pick dialog) so the user sees them with a warning rather
  // than silently nothing.
  /**
   * Refetches and filters approved tenure-gift rows to the active PAB month.
   * Hoisted via `useCallback` so the Realtime subscription below can call it.
   */
  const refetchTenureGifts = useCallback(
    async (signal?: AbortSignal) => {
      if (!pabMonthRange) return;
      const startMid = new Date(
        pabMonthRange.start.getFullYear(),
        pabMonthRange.start.getMonth(),
        pabMonthRange.start.getDate(),
      ).getTime();
      const endMid = new Date(
        pabMonthRange.end.getFullYear(),
        pabMonthRange.end.getMonth(),
        pabMonthRange.end.getDate(),
        23,
        59,
        59,
        999,
      ).getTime();
      try {
        const res = await fetch(`/api/employee-gift-shipping`, { cache: 'no-store', signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          rows?: {
            id: string;
            personal_email: string;
            milestone_index: number;
            milestone_date: string;
            status: string;
            decided_at: string | null;
            decided_by: string | null;
            gift_name: string | null;
            gift_price_php: number | null;
          }[];
        };
        const filtered = (json.rows ?? [])
          .filter((r) => r.status === 'approved' && r.decided_at)
          .filter((r) => {
            const t = new Date(r.decided_at!).getTime();
            return Number.isFinite(t) && t >= startMid && t <= endMid;
          })
          .map((r) => ({
            id: r.id,
            personal_email: r.personal_email,
            milestone_index: r.milestone_index,
            milestone_date: r.milestone_date,
            decided_at: r.decided_at!,
            decided_by: r.decided_by,
            // Render legacy/incomplete rows so the user can spot them rather
            // than them being silently dropped.
            gift_name: r.gift_name ?? '(no gift assigned)',
            gift_price_php:
              r.gift_price_php != null && Number.isFinite(Number(r.gift_price_php))
                ? Number(r.gift_price_php)
                : 0,
          }));
        setTenureGiftRows(filtered);
        setTenureGiftsError(null);
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') return;
        setTenureGiftsError(e instanceof Error ? e.message : 'Failed to load tenure gifts');
        setTenureGiftRows([]);
      }
    },
    [pabMonthRange],
  );

  useEffect(() => {
    if ((currentStep !== 4 && currentStep !== 5 && currentStep !== 7 && currentStep !== 9 && !previewPaystubsOpen) || !pabMonthRange) return;
    const ctrl = new AbortController();
    setTenureGiftsLoading(true);
    void refetchTenureGifts(ctrl.signal).finally(() => setTenureGiftsLoading(false));
    return () => ctrl.abort();
  }, [currentStep, pabMonthRange, refetchTenureGifts, previewPaystubsOpen]);

  // ── Realtime: refresh tenure gifts the moment the Orphanage team approves
  // a submission. Subscribes to `employee_gift_shipping_details` while the
  // user is on step 4, unsubscribes when they leave. Mirrors the dispatch-lock
  // pattern (also has a focus-refresh as a safety net).
  useEffect(() => {
    if (currentStep !== 4) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const channel = supabase
      .channel(`tenure-gifts-${pabMonthRange?.year ?? 'na'}-${pabMonthRange?.month ?? 'na'}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'employee_gift_shipping_details',
        },
        () => {
          // Any insert/update/delete on the table may have approved a new row
          // (or unapproved an existing one). Cheaper to refetch the full list
          // than reconcile per-event.
          void refetchTenureGifts();
        },
      )
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // eslint-disable-next-line no-console
          console.warn(`[tenure-gifts] Realtime ${status}. Tab-focus refresh stays as fallback.`, err);
        }
      });

    const onFocus = () => void refetchTenureGifts();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);

    return () => {
      void supabase.removeChannel(channel);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [currentStep, pabMonthRange, refetchTenureGifts]);

  // Fetch all contractor invoices when on step 5 (Contractors)
  useEffect(() => {
    if (currentStep !== 6) return;
    let cancelled = false;
    setContractorInvoicesLoading(true);
    fetch('/api/contractor/invoices', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { invoices?: typeof contractorInvoices }) => {
        if (!cancelled) setContractorInvoices(j.invoices ?? []);
      })
      .catch(() => { if (!cancelled) setContractorInvoices([]); })
      .finally(() => { if (!cancelled) setContractorInvoicesLoading(false); });
    return () => { cancelled = true; };
  }, [currentStep]);

  /**
   * HSL payroll weeks run Mon–Sun, so the effective PAB end is extended to the
   * Sunday that closes the last week. E.g. if pabMonthRange.end is Saturday May 2,
   * hslAdjustedPabEnd becomes Sunday May 3 so the full week is evaluated.
   */
  const hslAdjustedPabEnd = useMemo(() => {
    if (!pabMonthRange) return null;
    const d = new Date(pabMonthRange.end);
    const dow = d.getDay(); // Sun=0 … Sat=6
    if (dow !== 0) d.setDate(d.getDate() + (7 - dow));
    return d;
  }, [pabMonthRange]);

  /**
   * Per-month Hubstaff data availability for the month picker. For each YYYY-MM key,
   * counts how many parseable date columns in merged uploads fall inside that month's
   * default PAB range (`getPabMonthRange`). Months with `count === 0` are disabled in
   * the picker — the user can't select a PAB period for a month that has no data.
   */
  const pabMonthDataCoverage = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    const cols = hubstaffColsForPab;
    if (!cols?.length) return map;
    for (const col of cols) {
      const d = parseColDate(col);
      if (!d) continue;
      const y = d.getFullYear();
      // Figure out which PAB month this date belongs to: use the Monday of that week.
      const dow = d.getDay();
      const daysBackToMon = dow === 0 ? 6 : dow - 1;
      const mon = new Date(y, d.getMonth(), d.getDate() - daysBackToMon);
      const key = `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, '0')}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [hubstaffColsForPab]);

  /** One group per calendar weekday — dedupes ISO + Hubstaff labels for the same day across ALL CSVs, filtered to PAB month boundaries. */
  const weekdayColumnGroups = useMemo(() => {
    const cols = hubstaffColsForPab;
    if (!cols?.length) return [];
    const groups = groupWeekdayColumnsByDate(cols);
    if (!pabMonthRange) return groups;
    return filterColumnGroupsByPabRange(groups, cols, pabMonthRange.start, pabMonthRange.end);
  }, [hubstaffColsForPab, pabMonthRange]);

  /** All date-column groups (Mon–Sun) within the PAB range — used for HSL eligibility.
   *  Uses hslAdjustedPabEnd so Sunday of the last Mon–Sun week is always included. */
  const allDaysColumnGroups = useMemo(() => {
    const cols = hubstaffColsForPab;
    if (!cols?.length) return [];
    const allDateCols = cols.filter(col => {
      const s = col.trim();
      const lower = s.toLowerCase();
      for (const nd of HUBSTAFF_NON_DATE_COLS) {
        if (lower === nd || lower.startsWith(nd + ' ')) return false;
      }
      return parseColDate(s) !== null;
    });
    const groups = groupDateColumnsByCalendarDay(allDateCols, cols);
    if (!pabMonthRange) return groups;
    const effectiveEnd = hslAdjustedPabEnd ?? pabMonthRange.end;
    return filterColumnGroupsByPabRange(groups, cols, pabMonthRange.start, effectiveEnd);
  }, [hubstaffColsForPab, pabMonthRange, hslAdjustedPabEnd]);

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

  useEffect(() => {
    if (!pabMonthRange) return;
    const s = pabMonthRange.start;
    const e = pabMonthRange.end;
    const from = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
    const dayAfterEnd = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1);
    const to = `${dayAfterEnd.getFullYear()}-${String(dayAfterEnd.getMonth() + 1).padStart(2, '0')}-${String(dayAfterEnd.getDate()).padStart(2, '0')}`;
    fetch(`/api/pab-disputes?status=approved&status=accounting_approved&from=${from}&to=${to}`, { cache: 'no-store' })
      .then(r => r.json())
      .then((json: { rows: { work_email: string; dispute_date: string; reason: string; override_hours: number | null }[] }) => {
        const map = new Map<string, Map<string, number | null>>();
        for (const row of json.rows ?? []) {
          const em = (row.work_email ?? '').trim().toLowerCase();
          if (!em) continue;
          if (!map.has(em)) map.set(em, new Map());
          map.get(em)!.set(row.dispute_date, row.override_hours);
        }
        setApprovedDisputeDates(map);
      })
      .catch(() => setApprovedDisputeDates(new Map()));
  }, [pabMonthRange]);

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

      const forgivenDates = approvedDisputeDates.get(email);
      // Check both raw and normalized keys since employeeDepts is keyed by raw Hubstaff email
      const isHsl =
        employeeDepts[rawEmail] === 'hogan_smith_law' ||
        employeeDepts[rawEmail.toLowerCase()] === 'hogan_smith_law';

      if (isHsl) {
        // HSL rule: Mon–Sun weeks, ≥5 days at ≥7 h per week.
        // Approved disputes with ≥4 h effective floor are treated as a passing day.
        const hoursByDateKey = new Map<string, number>();
        for (const group of allDaysColumnGroups) {
          const rawSeconds = maxSecondsAcrossWeekdayGroup(row, group);
          const groupDate = isoDateFromColumnGroup(group);
          if (!groupDate) continue;
          const overrideHours = forgivenDates?.get(groupDate);
          const effectiveSeconds = overrideHours != null ? overrideHours * 3600 : rawSeconds;
          // Force-pass forgiven days so they count toward the 5-day quota
          const isForgiven = !!(forgivenDates?.has(groupDate) && effectiveSeconds >= 4 * 3600);
          const recordedSeconds = isForgiven ? 7 * 3600 : effectiveSeconds;
          const [y, m, d] = groupDate.split('-').map(Number);
          hoursByDateKey.set(pabDateKey(new Date(y, m - 1, d)), recordedSeconds);
        }
        if (checkHslPabEligibility(pabMonthRange.start, hslAdjustedPabEnd ?? pabMonthRange.end, hoursByDateKey)) {
          eligible.add(email);
        }
      } else {
        // Standard rule: all Mon–Fri days must be ≥7 h (dispute forgiveness applied).
        let perfect = true;
        for (const group of weekdayColumnGroups) {
          const rawSeconds = maxSecondsAcrossWeekdayGroup(row, group);
          const groupDate = isoDateFromColumnGroup(group);
          const overrideHours = groupDate != null ? forgivenDates?.get(groupDate) : undefined;
          // SET semantics: override_hours replaces Hubstaff hours for the day. `null` means the
          // dispute floor-drops without changing hours (e.g. orphanage visit); `0` intentionally
          // zeros out the day. Only `undefined` (no dispute on this date) falls back to Hubstaff.
          const effectiveSeconds =
            overrideHours != null ? overrideHours * 3600 : rawSeconds;
          if (effectiveSeconds < 7 * 3600) {
            const forgiven = !!(groupDate && forgivenDates?.has(groupDate) && effectiveSeconds >= 4 * 3600);
            if (!forgiven) {
              perfect = false;
              break;
            }
          }
        }
        if (perfect) eligible.add(email);
      }
    }
    return eligible;
  }, [
    hubstaffRowsForPab,
    dailyDataMissing,
    pabMonthRange,
    hslAdjustedPabEnd,
    pabMonthColumnCoverageComplete,
    weekdayColumnGroups,
    allDaysColumnGroups,
    approvedDisputeDates,
    employeeDepts,
  ]);

  /**
   * Per-employee weekday breakdown for the PAB period (merged month). Used in the PA cell.
   */
  const employeeWeekdayHours = useMemo<
    Map<string, { col: string; seconds: number; passes: boolean; forgivenByDispute: boolean }[]>
  >(() => {
    const rows = hubstaffRowsForPab;
    if (!rows || rows.length === 0) return new Map();
    if (weekdayColumnGroups.length === 0) return new Map();

    const map = new Map<string, { col: string; seconds: number; passes: boolean; forgivenByDispute: boolean }[]>();
    for (const row of rows) {
      const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
      const email = normEmail(rawEmail) ?? rawEmail.toLowerCase();
      if (!email) continue;
      const forgivenDates = approvedDisputeDates.get(email);
      map.set(
        email,
        weekdayColumnGroups.map(group => {
          const col = pickPreferredHubstaffColumn(group);
          const rawSeconds = maxSecondsAcrossWeekdayGroup(row, group);
          const groupDate = isoDateFromColumnGroup(group);
          const overrideHours = groupDate != null ? forgivenDates?.get(groupDate) : undefined;
          // SET semantics: override_hours replaces Hubstaff hours for the day. `null` dispute
          // falls through to Hubstaff hours (floor-drop marker); `0` zeros the day out.
          const seconds =
            overrideHours != null ? overrideHours * 3600 : rawSeconds;
          const forgiven = !!(groupDate && forgivenDates?.has(groupDate) && seconds >= 4 * 3600 && seconds < 7 * 3600);
          return { col, seconds, passes: seconds >= 7 * 3600 || forgiven, forgivenByDispute: forgiven };
        }),
      );
    }
    return map;
  }, [hubstaffRowsForPab, weekdayColumnGroups, approvedDisputeDates]);

  /**
   * Per-employee Mon–Sun breakdown for HSL PAB display. Same structure as
   * employeeWeekdayHours but uses allDaysColumnGroups so Sat/Sun are included.
   */
  const employeeAllDaysHours = useMemo<
    Map<string, { col: string; seconds: number; passes: boolean; forgivenByDispute: boolean }[]>
  >(() => {
    const rows = hubstaffRowsForPab;
    if (!rows || rows.length === 0) return new Map();
    if (allDaysColumnGroups.length === 0) return new Map();

    const map = new Map<string, { col: string; seconds: number; passes: boolean; forgivenByDispute: boolean }[]>();
    for (const row of rows) {
      const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
      const email = normEmail(rawEmail) ?? rawEmail.toLowerCase();
      if (!email) continue;
      const forgivenDates = approvedDisputeDates.get(email);
      map.set(
        email,
        allDaysColumnGroups.map(group => {
          const col = pickPreferredHubstaffColumn(group);
          const rawSeconds = maxSecondsAcrossWeekdayGroup(row, group);
          const groupDate = isoDateFromColumnGroup(group);
          const overrideHours = groupDate != null ? forgivenDates?.get(groupDate) : undefined;
          const seconds = overrideHours != null ? overrideHours * 3600 : rawSeconds;
          const forgiven = !!(groupDate && forgivenDates?.has(groupDate) && seconds >= 4 * 3600 && seconds < 7 * 3600);
          return { col, seconds, passes: seconds >= 7 * 3600 || forgiven, forgivenByDispute: forgiven };
        }),
      );
    }
    return map;
  }, [hubstaffRowsForPab, allDaysColumnGroups, approvedDisputeDates]);

  /**
   * Tri-state PAB display status per employee:
   *  - `ineligible`: at least one past weekday in the PAB range failed the 7h threshold (not forgiven).
   *    Verdict is locked — future days can no longer salvage the month.
   *  - `in_progress`: today is on/before the PAB period end AND no past failures recorded yet.
   *    The month is still winnable.
   *  - `eligible`: the PAB period has ended AND every weekday passed.
   *
   * Used by the PAB cell in the Additions table so in-progress months don't render as "Ineligible"
   * just because future weekdays haven't happened yet.
   */
  const pabStatusByEmail = useMemo<Map<string, 'eligible' | 'ineligible' | 'in_progress'>>(() => {
    const map = new Map<string, 'eligible' | 'ineligible' | 'in_progress'>();
    if (!pabMonthRange) return map;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endDay = new Date(pabMonthRange.end);
    endDay.setHours(0, 0, 0, 0);
    const periodEnded = today.getTime() > endDay.getTime();

    for (const [email, breakdown] of employeeWeekdayHours.entries()) {
      // HSL uses Mon–Sun / 5-of-7 rule — Mon-Fri breakdown doesn't apply.
      // Use perfectAttendanceEligible (already computed with HSL logic) for the
      // period-ended verdict; show in_progress while the period is still open.
      const isHsl =
        employeeDepts[email] === 'hogan_smith_law' ||
        employeeDepts[email.toLowerCase()] === 'hogan_smith_law';

      if (isHsl) {
        if (periodEnded) {
          map.set(email, perfectAttendanceEligible.has(email) ? 'eligible' : 'ineligible');
        } else {
          map.set(email, 'in_progress');
        }
        continue;
      }

      // Standard departments: any past Mon–Fri day below threshold → locked ineligible.
      let hasPastFailure = false;
      for (const entry of breakdown) {
        if (entry.passes) continue;
        const d = parseColDate(entry.col);
        if (!d) continue;
        const entryDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        if (entryDay.getTime() <= today.getTime()) {
          hasPastFailure = true;
          break;
        }
      }
      if (hasPastFailure) {
        map.set(email, 'ineligible');
      } else if (!periodEnded) {
        map.set(email, 'in_progress');
      } else {
        map.set(email, 'eligible');
      }
    }
    return map;
  }, [pabMonthRange, employeeWeekdayHours, perfectAttendanceEligible, employeeDepts]);

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

      // Fallback: match via masterIndex when direct email lookup fails.
      // Hubstaff email → master (by work_email OR personal_email) → other email → ratesByEmail,
      // or Hubstaff name → master (by name) → personal_email / work_email → ratesByEmail.
      if (!rateRow) {
        // Try work email, then personal email, then normalized name.
        let master = em ? masterIndex.byWorkEmail.get(em) : undefined;
        if (!master && em) master = masterIndex.byPersonalEmail.get(em);
        if (!master && row.name) {
          const hubstaffTokens = normalizeNameTokens(row.name);
          if (hubstaffTokens) master = masterIndex.byNameTokens.get(hubstaffTokens);
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
  }, [hubstaffData, ratesByEmail, masterIndex]);

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

  /**
   * Unified preview items for the "Preview Emails → Orphanage" tab. Pulls
   * from all four Orphanage-step data streams in the active PAB month so the
   * dispatch dialog can show every outbound orphanage receipt:
   *
   *   1. visit_wages    — per-employee approved orphanage_visit/ceo_visitation
   *                       summed into hours × regular rate.
   *   2. budget_request — accounting-approved orphanage budget requests
   *                       (one per submitter / mission trip).
   *   3. gift_payment   — sent/paid vendor gift payments (USD → PHP).
   *   4. tenure_gift    — approved tenure-gift shipping submissions
   *                       (PHP price snapshot at approval).
   */
  const orphanagePreviewItems = useMemo(() => {
    type VisitWagesData = {
      kind: 'visit_wages';
      id: string;
      email: string;
      name: string;
      visitCount: number;
      totalHours: number;
      regularRate: number | null;
      wages: number | null;
      visits: { date: string; hours: number; reason: string }[];
    };
    type BudgetReqData = {
      kind: 'budget_request';
      id: string;
      submitterEmail: string;
      visitType: string;
      missionTrip: boolean;
      subtotal: number;
      leftover: number;
      finalAmount: number;
      submittedAt: string;
      decidedAt: string | null;
      decidedBy: string | null;
    };
    type GiftPaymentData = {
      kind: 'gift_payment';
      id: string;
      periodLabel: string;
      batchLabel: string;
      vendorName: string;
      totalUSD: number;
      totalPHP: number;
      dateSent: string | null;
      status: string;
    };
    type TenureGiftData = {
      kind: 'tenure_gift';
      id: string;
      personalEmail: string;
      milestoneIndex: number;
      milestoneDate: string;
      decidedAt: string;
      decidedBy: string | null;
      giftName: string;
      pricePHP: number;
    };
    type Item = VisitWagesData | BudgetReqData | GiftPaymentData | TenureGiftData;

    const items: Item[] = [];

    // ── 1. Visit wages ───────────────────────────────────────────────────
    const isApprovedVisit = (s: string) => s === 'accounting_approved' || s === 'approved';
    const rateByEmail = new Map<string, number>();
    const nameByEmail = new Map<string, string>();
    for (const r of effectiveCalcResults) {
      const em = (r.email ?? '').trim().toLowerCase();
      if (!em) continue;
      if (r.regularRate != null) rateByEmail.set(em, r.regularRate);
      if (r.name) nameByEmail.set(em, r.name);
    }
    const visitMap = new Map<string, VisitWagesData>();
    for (const row of orphanageRows) {
      if (!isApprovedVisit(row.status)) continue;
      const em = (row.work_email ?? '').trim().toLowerCase();
      if (!em) continue;
      if (hiddenVisitIds.has(`${em}|${row.dispute_date}`)) continue;
      if (hiddenWageEmails.has(em)) continue;
      const hours = row.override_hours ?? 8;
      const existing = visitMap.get(em);
      if (existing) {
        existing.visitCount += 1;
        existing.totalHours += hours;
        existing.wages =
          existing.regularRate != null ? existing.totalHours * existing.regularRate : null;
        existing.visits.push({ date: row.dispute_date, hours, reason: row.reason });
      } else {
        const rate = rateByEmail.get(em)
          ?? (() => { const r = ratesByEmail.get(em); return r ? parseRateField(r.regular_rate) : null; })()
          ?? null;
        visitMap.set(em, {
          kind: 'visit_wages',
          id: `visit:${em}`,
          email: em,
          name: nameByEmail.get(em) ?? '—',
          visitCount: 1,
          totalHours: hours,
          regularRate: rate,
          wages: rate != null ? hours * rate : null,
          visits: [{ date: row.dispute_date, hours, reason: row.reason }],
        });
      }
    }
    for (const v of visitMap.values()) {
      v.visits.sort((a, b) => a.date.localeCompare(b.date));
      items.push(v);
    }

    // ── 2. Budget requests (approved only) ───────────────────────────────
    for (const r of budgetRequestRows) {
      if (r.status !== 'approved') continue;
      if (hiddenBudgetIds.has(r.id)) continue;
      const toNum = (v: number | string | null): number => {
        if (v == null) return 0;
        const n = typeof v === 'number' ? v : parseFloat(v);
        return Number.isFinite(n) ? n : 0;
      };
      items.push({
        kind: 'budget_request',
        id: `budget:${r.id}`,
        submitterEmail: r.submitter_email,
        visitType: r.visit_type,
        missionTrip: !!r.mission_trip,
        subtotal: toNum(r.subtotal),
        leftover: toNum(r.leftover),
        finalAmount: toNum(r.final_amount),
        submittedAt: r.submitted_at,
        decidedAt: r.decided_at,
        decidedBy: r.decided_by,
      });
    }

    // ── 3. Gift payments (sent/paid) ─────────────────────────────────────
    for (const g of giftPaymentRows) {
      items.push({
        kind: 'gift_payment',
        id: `gift:${g.id}`,
        periodLabel: g.period_label,
        batchLabel: g.batch_label,
        vendorName: g.vendor_name,
        totalUSD: g.total_usd,
        totalPHP: g.total_usd * usdToPhpRate,
        dateSent: g.date_sent,
        status: g.status,
      });
    }

    // ── 4. Tenure gifts ──────────────────────────────────────────────────
    for (const t of tenureGiftRows) {
      items.push({
        kind: 'tenure_gift',
        id: `tenure:${t.id}`,
        personalEmail: t.personal_email,
        milestoneIndex: t.milestone_index,
        milestoneDate: t.milestone_date,
        decidedAt: t.decided_at,
        decidedBy: t.decided_by,
        giftName: t.gift_name,
        pricePHP: t.gift_price_php,
      });
    }

    return items;
  }, [
    orphanageRows,
    effectiveCalcResults,
    budgetRequestRows,
    giftPaymentRows,
    tenureGiftRows,
    usdToPhpRate,
    hiddenVisitIds,
    hiddenWageEmails,
    hiddenBudgetIds,
  ]);

  /**
   * Subtitle/amount helpers for the unified Orphanage preview list. Kept as a
   * separate function so the list row and the receipt template stay in sync.
   */
  const orphanagePreviewItemMeta = (item: typeof orphanagePreviewItems[number]) => {
    switch (item.kind) {
      case 'visit_wages':
        return {
          title: item.name,
          subtitle: `${item.email} · ${item.visitCount} visit${item.visitCount === 1 ? '' : 's'} · ${item.totalHours.toFixed(1)}h`,
          amount: item.wages,
          amountCurrency: 'PHP' as const,
          typeLabel: 'Visit wages',
        };
      case 'budget_request':
        return {
          title: item.submitterEmail,
          subtitle: `Budget · ${item.visitType}${item.missionTrip ? ' · mission trip' : ''}`,
          amount: item.finalAmount,
          amountCurrency: 'PHP' as const,
          typeLabel: 'Budget request',
        };
      case 'gift_payment':
        return {
          title: item.vendorName || '(no vendor name)',
          subtitle: `Gift payment · ${item.batchLabel || item.periodLabel || '—'}`,
          amount: item.totalPHP,
          amountCurrency: 'PHP' as const,
          typeLabel: 'Gift payment',
        };
      case 'tenure_gift':
        return {
          title: item.giftName || `Tenure gift #${item.milestoneIndex}`,
          subtitle: `${item.personalEmail} · milestone ${item.milestoneIndex}`,
          amount: item.pricePHP,
          amountCurrency: 'PHP' as const,
          typeLabel: 'Tenure gift',
        };
    }
  };

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
            if (!toggles[db.id]) continue;
            // KPI Bonus: per-employee amount from the latest SSD KPI sheet.
            // Non-SSD members resolve to 0, so toggling is a no-op.
            if (db.id === KPI_BONUS_ID) {
              total += ssdKpiAmounts[emp.email.toLowerCase()] ?? 0;
            } else {
              total += db.amount;
            }
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
  }, [effectiveCalcResults, employeeDepts, employeeBonuses, employeeMetrics, deptMetrics, ssdKpiAmounts]);

  /** Effective bonus per employee: accounting override wins over the auto-computed total. */
  const getEffectiveBonus = useCallback(
    (email: string): number => bonusOverrides[email] ?? bonusTotals[email] ?? 0,
    [bonusOverrides, bonusTotals],
  );

  /** Enriched dispatch rows shared by Preview Paystubs + Confirm & Dispatch. */
  const dispatchData = useMemo(() => {
    const resolvePersonalEmail = (r: CalcRow): string | null => {
      const em = normEmail(r.email);
      const rateRow = em ? ratesByEmail.get(em) : undefined;
      const fromRate = normEmail(rateRow?.personal_email);
      if (fromRate) return fromRate;
      let master = em ? masterIndex.byWorkEmail.get(em) : undefined;
      if (!master && r.name) {
        const tokens = normalizeNameTokens(r.name);
        if (tokens) master = masterIndex.byNameTokens.get(tokens);
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

    const salaryDateIso = (() => {
      if (!week?.start) return null;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(week.start);
      if (!m) return null;
      const d = new Date(+m[1], +m[2] - 1, +m[3] + 8);
      return d.toLocaleDateString('en-CA');
    })();

    const payPeriodPayload = {
      currency: 'PHP' as const,
      hubstaff_source_file: calcSourceFile,
      week,
      salary_date: salaryDateIso,
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
      if (!weekEndDate) return false;
      const manualEnd = pabPeriodSettings.validManualRange?.end;
      const periodEnd = manualEnd ?? weekPabRange?.end;
      if (!periodEnd) return false;
      return weekEndDate.getTime() >= new Date(
        periodEnd.getFullYear(),
        periodEnd.getMonth(),
        periodEnd.getDate(),
      ).getTime();
    })();
    /**
     * Tech Bonus rule: paid in the *3rd paycheck* of the month (the weekly pay
     * period whose Monday is the 3rd calendar week of the month — week 1 = the
     * Mon–Sun week containing the 1st, even if partial). Equality, not ≥.
     */
    /**
     * Salary date = the Tuesday after the pay period's Sunday (i.e. weekStart + 8).
     * Tech bonus attaches to the paycheck whose salary date lands in the **3rd
     * full Mon–Sun week** of its month — "full week" = a week whose Monday is
     * on or after the 1st. Per Carla (May 2026 meeting), this lands tech bonus
     * two weeks out from PAB.
     *
     * Examples:
     *   March 2026 (1st = Sun) → first full week Mar 2–8 → 3rd week Mar 16–22
     *     → salary Tue Mar 17 pays pay-period Mar 9–15 ✅
     *   May 2026 (1st = Fri)   → first full week May 4–10 → 3rd week May 18–24
     *     → salary Tue May 19 ("week of the 22nd") pays pay-period May 11–17 ✅
     *   June 2026 (1st = Mon)  → first full week Jun 1–7 → 3rd week Jun 15–21
     *     → salary Tue Jun 16 pays pay-period Jun 8–14 ✅
     */
    const salaryDate = weekStartDate
      ? new Date(weekStartDate.getFullYear(), weekStartDate.getMonth(), weekStartDate.getDate() + 8)
      : null;
    const isTechBonusWeek = (() => {
      if (!salaryDate) return false;
      const techMonth = { year: salaryDate.getFullYear(), month: salaryDate.getMonth() };
      const first = new Date(techMonth.year, techMonth.month, 1);
      const dow = first.getDay();
      // Days forward to first Monday ≥ the 1st. Sun=0→1, Mon=1→0, Tue=2→6, …
      const daysForward = (8 - dow) % 7;
      const firstMon = new Date(first.getFullYear(), first.getMonth(), first.getDate() + daysForward);
      const thirdWeekMon = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate() + 14);
      const fourthWeekMon = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate() + 21);
      const t = salaryDate.getTime();
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
      // No rates in Supabase → employee is US / paid externally / unseeded.
      // Strip every PH-side bonus (PAB, Tech, dept performance / attendance).
      // The paystub pipeline is PHP-only; attaching bonuses without a rate
      // produces misleading totals.
      const hasRates = r.regularRate != null || r.otRate != null;
      const pabBonus = hasRates && isFinalPabWeek && toggles.perfect_attendance
        ? commonBonusPhp('perfect_attendance')
        : 0;
      // Tech Bonus: paid in the 3rd paycheck of the month, but only after the
      // employee has completed 30 days of service from their start_date.
      // Manual toggle can opt-in earlier (still requires 30-day service).
      const hasThirtyDays = hasThirtyDaysByWeek(r.email);
      const techBonus =
        hasRates && hasThirtyDays && (isTechBonusWeek || toggles.tech_bonus)
          ? commonBonusPhp('tech_bonus')
          : 0;
      const hasAccountingOverride = bonusOverrides[r.email] !== undefined;
      const rawBonusTotal = hasRates ? (bonusTotals[r.email] ?? 0) : 0;
      // Strip out the month-wide PAB/tech amounts that `bonusTotals` may include,
      // then re-add the week-gated versions so weekly paystubs get the right total.
      const toggledPab = toggles.perfect_attendance ? commonBonusPhp('perfect_attendance') : 0;
      const toggledTech = toggles.tech_bonus ? commonBonusPhp('tech_bonus') : 0;
      const autoOtherBonuses = hasRates ? Math.max(0, rawBonusTotal - toggledPab - toggledTech) : 0;
      // Accounting override replaces the whole bonus total: treat it as "other_bonuses"
      // and skip PAB/tech gating for this row.
      const otherBonuses = hasAccountingOverride ? (bonusOverrides[r.email] ?? 0) : autoOtherBonuses;
      const bonusTotal = hasAccountingOverride ? otherBonuses : (pabBonus + techBonus + otherBonuses);

      // MESA Program deduction — ₱100 per paycheck for enrolled members.
      const em = normEmail(r.email);
      const rateRowForMesa = em ? ratesByEmail.get(em) : undefined;
      const mesaDeduction = (hasRates && rateRowForMesa?.mesa_member) ? 100 : 0;

      const finalPay = (r.initialPay ?? 0) + bonusTotal - mesaDeduction;

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
          mesa_deduction: mesaDeduction,
          final: finalPay,
        },
      });
    }
    return { rows, missing, payPeriodPayload };
  }, [
    effectiveCalcResults,
    ratesByEmail,
    masterEmployees,
    masterIndex,
    employeeDepts,
    employeeBonuses,
    bonusTotals,
    bonusOverrides,
    pabMonthRange,
    calcSourceFile,
    hubstaffColsForPab,
    pabPeriodSettings.validManualRange,
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
    if (sourceFilesLoading) return;
    setHubstaffPreviewLoading(true);
    setHubstaffPreviewError(null);
    try {
      const latest = uploadedSourceFiles[0];
      const res = await fetch(
        uploadedSourceFiles.length > 0
          ? `/api/hubstaff-hours?source_file=${encodeURIComponent(latest)}&_=${Date.now()}`
          : `/api/hubstaff-hours?_=${Date.now()}`,
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
  }, [users, uploadedSourceFiles, sourceFilesLoading]);

  useEffect(() => {
    void loadHubstaffPreview();
  }, [loadHubstaffPreview]);

  // ── Load list of uploaded source files ──
  const loadUploadedSourceFiles = React.useCallback(async (): Promise<string[]> => {
    setSourceFilesLoading(true);
    try {
      const res = await fetch(`/api/hubstaff-hours?source_files=1&_=${Date.now()}`, { cache: 'no-store' });
      const json = (await res.json()) as {
        files?: string[];
        uploads?: {
          id: string;
          source_file: string | null;
          uploaded_at: string;
          row_count: number | null;
          is_current: boolean;
        }[];
        error?: string | null;
      };
      const files = json.files ?? [];
      const uploads = json.uploads ?? [];
      setUploadedSourceFiles(files);
      setHubstaffUploads(uploads);
      return files;
    } catch {
      setUploadedSourceFiles([]);
      setHubstaffUploads([]);
      return [];
    } finally {
      setSourceFilesLoading(false);
    }
  }, []);

  // Skip the initial load when initialData already shipped both the file list
  // and the rich uploads metadata. Manual refresh buttons + post-upload reloads
  // still call loadUploadedSourceFiles() directly.
  const skipInitialSourceFilesFetchRef = useRef(
    Boolean(initialData?.sourceFiles?.length && initialData?.hubstaffUploads?.length),
  );
  useEffect(() => {
    if (skipInitialSourceFilesFetchRef.current) {
      skipInitialSourceFilesFetchRef.current = false;
      return;
    }
    void loadUploadedSourceFiles();
  }, [loadUploadedSourceFiles]);

  /** Inline refresh for the Additions tab PAB control: re-syncs period settings + re-fetches Hubstaff uploads. */
  const refreshPabInline = React.useCallback(async () => {
    setPabRefreshing(true);
    try {
      await Promise.all([
        pabPeriodSettings.refresh(),
        loadUploadedSourceFiles(),
      ]);
      toast.success('PAB data refreshed', { description: 'Period settings and Hubstaff uploads re-fetched.' });
    } catch (e) {
      toast.error('Refresh failed', { description: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setPabRefreshing(false);
    }
  }, [pabPeriodSettings, loadUploadedSourceFiles]);

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
   * The Global Master List (active_employees) Department is the SOURCE OF TRUTH.
   * Resolution order (first hit wins):
   *  1. Master list department — match the employee to their global_master_list
   *                              row by work email → personal email → rate-row
   *                              personal email → name, then use its Department.
   *  2. Rates table fallback   — employee_hourly_rates "Department" column, only
   *                              when the employee isn't in the master list.
   *  3. Hubstaff dept fallback — Hubstaff "Job type" column, for employees in
   *                              neither the master list nor the rates table.
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

        // ── Source of truth: resolve this employee's global_master_list row,
        // trying the most reliable identity keys first (O(1) map lookups).
        let master = em ? masterIndex.byWorkEmail.get(em) : undefined;
        if (!master && em) master = masterIndex.byPersonalEmail.get(em);
        if (!master && rateRow?.personal_email) {
          const normPE = normEmail(rateRow.personal_email);
          if (normPE) master = masterIndex.byPersonalEmail.get(normPE);
        }
        if (!master && calcRow.name) {
          const tokens = normalizeNameTokens(calcRow.name);
          if (tokens) master = masterIndex.byNameTokens.get(tokens);
        }

        // Tier 1: master-list Department (authoritative).
        let deptRaw: string | null = master?.department ?? null;

        // Tier 2: rates-table Department — only when not in the master list.
        if (!deptRaw && rateRow?.department) {
          deptRaw = rateRow.department;
        }

        // Tier 3: Hubstaff "Job type" — employee in neither source.
        if (!deptRaw) {
          const hubRow = em ? hubstaffByEmail.get(em) : undefined;
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
  }, [calcResults, masterIndex, ratesByEmail, hubstaffByEmail]);

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
        setCalcSourceFile(files[0]);
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

  const handleMasterListFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setMasterListUploadLoading(true);
    try {
      const form = new FormData();
      form.set('file', file);
      const res = await fetch('/api/global-master-list', { method: 'POST', body: form });
      const json = (await res.json()) as {
        success?: boolean;
        rowCount?: number;
        error?: string;
        ratesReconcile?: { hint: string | null; ratesFewerThanMaster?: boolean } | null;
      };
      if (!res.ok || !json.success) {
        toast.error('Master list upload failed', { description: json.error ?? res.statusText });
        return;
      }
      toast.success('Master list replaced in Supabase', {
        description: `${(json.rowCount ?? 0).toLocaleString()} rows from ${file.name}`,
      });
      if (json.ratesReconcile?.hint) {
        toast.warning('Hourly rates coverage', { description: json.ratesReconcile.hint });
      }
      await reloadMasterEmployees();
    } catch (err) {
      toast.error('Master list upload failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setMasterListUploadLoading(false);
    }
  };

  const handleRatesFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setRatesUploadLoading(true);
    try {
      const form = new FormData();
      form.set('file', file);
      const res = await fetch('/api/employee-hourly-rates-upload', {
        method: 'POST',
        body: form,
      });
      const json = (await res.json()) as {
        success?: boolean;
        rowCount?: number;
        inserted?: number;
        updated?: number;
        uniqueEmployees?: number;
        skippedNoWorkEmail?: number;
        skippedNoRate?: number;
        error?: string;
      };
      if (!res.ok || !json.success) {
        toast.error('Payroll rates upload failed', { description: json.error ?? res.statusText });
        return;
      }
      toast.success('Payroll rates imported', {
        description: [
          `${(json.uniqueEmployees ?? 0).toLocaleString()} employees`,
          `${json.updated ?? 0} updated`,
          `${json.inserted ?? 0} new`,
        ].join(' · '),
      });
      if ((json.skippedNoWorkEmail ?? 0) > 0 || (json.skippedNoRate ?? 0) > 0) {
        toast.warning('Some rows skipped', {
          description: `No work email: ${json.skippedNoWorkEmail ?? 0} · No rate: ${json.skippedNoRate ?? 0}`,
        });
      }
    } catch (err) {
      toast.error('Payroll rates upload failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRatesUploadLoading(false);
    }
  };

  const handleLockToggle = async () => {
    if (togglingLock) return;
    setTogglingLock(true);
    const goingLocked = !lockState.locked;
    try {
      await setLocked(goingLocked);
      toast.success(
        goingLocked
          ? 'Processing started — employee disputes are paused'
          : 'Processing stopped — employees can dispute again',
        { icon: goingLocked ? '🔒' : '🔓' },
      );
      setConfirmingLockToggle(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update lock');
    } finally {
      setTogglingLock(false);
    }
  };

  const startSyncProgress = (key: 'master' | 'rates' | 'hsl', setter: (v: { pct: number } | null) => void) => {
    const existing = syncTimers.current[key];
    if (existing !== undefined) clearInterval(existing);
    let pct = 0;
    setter({ pct });
    const timer = setInterval(() => {
      pct = Math.min(88, pct + (pct < 35 ? 3.5 : pct < 65 ? 1.5 : pct < 82 ? 0.6 : 0.15));
      setter({ pct });
    }, 80);
    syncTimers.current[key] = timer;
    return () => {
      clearInterval(timer);
      delete syncTimers.current[key];
    };
  };

  const handleMasterSheetSync = async () => {
    setMasterListUploadLoading(true);
    const stopProgress = startSyncProgress('master', setMasterSyncPct);
    let succeeded = false;
    try {
      const res = await fetch('/api/cron/sync-master-from-sheet', { method: 'POST', body: JSON.stringify({ clearOffboarded: true }), headers: { 'Content-Type': 'application/json' } });
      const json = (await res.json()) as { success?: boolean; rowCount?: number; activeCount?: number | null; inserted?: number; updated?: number; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Master list sync failed');
      succeeded = true;
      setMasterSyncPct({ pct: 100 });
      const activeCount = json.activeCount ?? json.rowCount ?? 0;
      toast.success('Master list synced from Google Sheet', { description: `${activeCount} active employees (${json.inserted ?? 0} new · ${json.updated ?? 0} updated)` });
      await reloadMasterEmployees();
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('rates-profiles-stale'));
    } catch (err) {
      toast.error('Master list sync failed', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      stopProgress();
      setMasterListUploadLoading(false);
      if (succeeded) setTimeout(() => setMasterSyncPct(null), 1500);
      else setMasterSyncPct(null);
    }
  };

  const handleRatesSheetSync = async () => {
    setRatesUploadLoading(true);
    const stopProgress = startSyncProgress('rates', setRatesSyncPct);
    let succeeded = false;
    try {
      const res = await fetch('/api/cron/sync-rates-from-sheet', { method: 'POST' });
      const json = (await res.json()) as { success?: boolean; rowCount?: number; uniqueEmployees?: number; inserted?: number; updated?: number; skippedNoWorkEmail?: number; skippedNoRate?: number; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Rates sync failed');
      succeeded = true;
      setRatesSyncPct({ pct: 100 });
      toast.success('Payroll rates synced from Google Sheet', {
        description: [
          `${(json.uniqueEmployees ?? 0).toLocaleString()} employees`,
          `${json.updated ?? 0} updated`,
          `${json.inserted ?? 0} new`,
        ].join(' · '),
      });
      // Pull the freshly-synced rates into the wizard's in-memory rate map so
      // the Initial Calculation reflects them immediately — without this, the
      // calc keeps using the page-load snapshot and newly-rated employees show
      // "No rate" until a manual refresh. Mirrors handleMasterSheetSync's
      // reloadMasterEmployees() call.
      await loadEmployeeHourlyRates();
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('rates-profiles-stale'));
    } catch (err) {
      toast.error('Rates sync failed', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      stopProgress();
      setRatesUploadLoading(false);
      if (succeeded) setTimeout(() => setRatesSyncPct(null), 1500);
      else setRatesSyncPct(null);
    }
  };

  const handleHslSheetSync = async () => {
    setHslSyncLoading(true);
    setHslSyncResult(null);
    const stopProgress = startSyncProgress('hsl', setHslSyncPct);
    let succeeded = false;
    try {
      const res = await fetch('/api/cron/sync-hsl-from-sheet', { method: 'POST' });
      const json = (await res.json()) as { success?: boolean; rowCount?: number; inserted?: number; updated?: number; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? 'HSL sync failed');
      succeeded = true;
      setHslSyncPct({ pct: 100 });
      setHslSyncResult({ kind: 'success', message: `${json.rowCount ?? 0} agents synced (${json.inserted ?? 0} new · ${json.updated ?? 0} updated)` });
      toast.success('Hogan Smith Pay Plan synced');
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('rates-profiles-stale'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setHslSyncResult({ kind: 'error', message });
      toast.error('HSL sync failed', { description: message });
    } finally {
      stopProgress();
      setHslSyncLoading(false);
      if (succeeded) setTimeout(() => setHslSyncPct(null), 1500);
      else setHslSyncPct(null);
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
                      void loadSourceFileRows(files[0]);
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
                        {uploadedSourceFiles.map((file) => {
                          const meta = uploadMetaByFile.get(file);
                          const stamp = formatUploadStamp(meta?.uploaded_at);
                          return (
                          <div key={file} className="flex items-stretch gap-0.5">
                            <button
                              type="button"
                              className={cn(
                                'flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors',
                                selectedSourceFile === file
                                  ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400'
                                  : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900',
                              )}
                              onClick={() => void loadSourceFileRows(file)}
                            >
                              <FileText
                                className={cn(
                                  'h-3.5 w-3.5 mt-0.5 shrink-0',
                                  selectedSourceFile === file
                                    ? 'text-indigo-500 dark:text-indigo-400'
                                    : 'text-zinc-400',
                                )}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5">
                                  <span className="truncate font-mono">{file}</span>
                                  {meta?.is_current && (
                                    <span className="shrink-0 rounded border border-emerald-300 bg-emerald-50 px-1 py-0 text-[9px] font-bold uppercase tracking-wide text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-400">
                                      Current
                                    </span>
                                  )}
                                </span>
                                {(stamp || meta?.row_count != null) && (
                                  <span className="mt-0.5 block text-[10px] text-zinc-500 dark:text-zinc-500">
                                    {stamp ?? ''}
                                    {stamp && meta?.row_count != null ? ' · ' : ''}
                                    {meta?.row_count != null ? `${meta.row_count.toLocaleString()} rows` : ''}
                                  </span>
                                )}
                              </span>
                              {selectedSourceFile === file && (
                                <ChevronRight className="ml-auto mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-400" />
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
                          );
                        })}
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
                {/* ── 3 upload types in a uniform grid: roster · rates · timesheet ── */}
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  {/* 1. Master list (employee roster) */}
                  <section className="flex flex-col gap-3 rounded-xl border border-emerald-200/80 bg-emerald-50/40 p-4 dark:border-emerald-900/40 dark:bg-emerald-950/20">
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-emerald-200/90 bg-white dark:border-emerald-800/60 dark:bg-emerald-950/50">
                        <Users className="h-5 w-5 text-emerald-700 dark:text-emerald-400" aria-hidden />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-800/90 dark:text-emerald-400/90">
                          Global master list
                        </p>
                        <h3 className="text-base font-semibold leading-tight text-zinc-900 dark:text-white">
                          Employee Roster
                        </h3>
                      </div>
                    </div>
                    <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                      Pulls the <span className="font-medium">Global Master List</span> sheet via Google Sheets API
                      and replaces every row in{' '}
                      <span className="font-mono text-zinc-700 dark:text-zinc-300">
                        {process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE ?? 'global_master_list'}
                      </span>. Does not touch{' '}
                      <span className="font-mono text-zinc-600 dark:text-zinc-400">employee_hourly_rates</span>.
                    </p>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-500">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        {masterEmployees.length}
                      </span>{' '}
                      employees loaded from Supabase for this payroll run.
                    </p>
                    {masterSyncPct !== null && (
                      <div className="rounded-lg border border-zinc-200 bg-white/80 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
                        <div className="mb-1 flex items-center justify-between text-[10.5px]">
                          <span className="text-zinc-500 dark:text-zinc-400">Syncing master list…</span>
                          <span className="tabular-nums text-zinc-400 dark:text-zinc-600">{Math.round(masterSyncPct.pct)}%</span>
                        </div>
                        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700/60">
                          <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-100 ease-linear" style={{ width: `${masterSyncPct.pct}%` }} />
                        </div>
                      </div>
                    )}
                    <div className="mt-auto flex flex-col gap-2 pt-1">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={masterListUploadLoading}
                        onClick={() => void handleMasterSheetSync()}
                        className="w-full gap-2 border-emerald-300/80 bg-white text-emerald-900 hover:bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100 dark:hover:bg-emerald-950/70"
                      >
                        {masterListUploadLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                        Sync from Google Sheet
                      </Button>
                    </div>
                  </section>

                  {/* 2. Payroll rates (All Dept) */}
                  <section className="flex flex-col gap-3 rounded-xl border border-sky-200/80 bg-sky-50/40 p-4 dark:border-sky-900/40 dark:bg-sky-950/20">
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-sky-200/90 bg-white dark:border-sky-800/60 dark:bg-sky-950/50">
                        <DollarSign className="h-5 w-5 text-sky-700 dark:text-sky-400" aria-hidden />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-sky-800/90 dark:text-sky-400/90">
                          Payroll rates
                        </p>
                        <h3 className="text-base font-semibold leading-tight text-zinc-900 dark:text-white">
                          All Dept Payroll CSV
                        </h3>
                      </div>
                    </div>
                    <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                      Pulls the <span className="font-medium">All Dept</span> sheet via Google Sheets API and upserts{' '}
                      <span className="font-mono text-zinc-700 dark:text-zinc-300">employee_hourly_rates</span>{' '}
                      by work email. Multiple weekly rows per employee are expected — the latest week wins.
                    </p>
                    {ratesSyncPct !== null && (
                      <div className="rounded-lg border border-zinc-200 bg-white/80 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
                        <div className="mb-1 flex items-center justify-between text-[10.5px]">
                          <span className="text-zinc-500 dark:text-zinc-400">Syncing payroll rates…</span>
                          <span className="tabular-nums text-zinc-400 dark:text-zinc-600">{Math.round(ratesSyncPct.pct)}%</span>
                        </div>
                        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700/60">
                          <div className="h-full rounded-full bg-sky-500 transition-[width] duration-100 ease-linear" style={{ width: `${ratesSyncPct.pct}%` }} />
                        </div>
                      </div>
                    )}
                    <div className="mt-auto flex flex-col gap-2 pt-1">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={ratesUploadLoading}
                        onClick={() => void handleRatesSheetSync()}
                        className="w-full gap-2 border-sky-300/80 bg-white text-sky-900 hover:bg-sky-50 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100 dark:hover:bg-sky-950/70"
                      >
                        {ratesUploadLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                        Sync from Google Sheet
                      </Button>
                    </div>
                  </section>

                  {/* 3. Hogan Smith Pay Plan */}
                  <section className="flex flex-col gap-3 rounded-xl border border-violet-200/80 bg-violet-50/40 p-4 dark:border-violet-900/40 dark:bg-violet-950/20">
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-violet-200/90 bg-white dark:border-violet-800/60 dark:bg-violet-950/50">
                        <RefreshCw className="h-5 w-5 text-violet-700 dark:text-violet-400" aria-hidden />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-violet-800/90 dark:text-violet-400/90">
                          Hogan Smith
                        </p>
                        <h3 className="text-base font-semibold leading-tight text-zinc-900 dark:text-white">
                          Hogan Pay Plan
                        </h3>
                      </div>
                    </div>
                    <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                      Pulls the <span className="font-medium">Hogan Smith Pay Plan</span> sheet via Google Sheets API
                      and syncs agent rows into Supabase. No file needed — sync pulls directly from the linked
                      spreadsheet.
                    </p>
                    {hslSyncPct !== null && (
                      <div className="rounded-lg border border-zinc-200 bg-white/80 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
                        <div className="mb-1 flex items-center justify-between text-[10.5px]">
                          <span className="text-zinc-500 dark:text-zinc-400">Syncing Hogan pay plan…</span>
                          <span className="tabular-nums text-zinc-400 dark:text-zinc-600">{Math.round(hslSyncPct.pct)}%</span>
                        </div>
                        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700/60">
                          <div className="h-full rounded-full bg-violet-500 transition-[width] duration-100 ease-linear" style={{ width: `${hslSyncPct.pct}%` }} />
                        </div>
                      </div>
                    )}
                    {hslSyncResult && hslSyncPct === null && (
                      <p className={`text-xs font-medium ${hslSyncResult.kind === 'success' ? 'text-violet-700 dark:text-violet-300' : 'text-red-600 dark:text-red-400'}`}>
                        {hslSyncResult.kind === 'success' ? '✓' : '✗'} {hslSyncResult.message}
                      </p>
                    )}
                    <div className="mt-auto flex flex-col gap-2 pt-1">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={hslSyncLoading}
                        onClick={() => void handleHslSheetSync()}
                        className="w-full gap-2 border-violet-300/80 bg-white text-violet-900 hover:bg-violet-50 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-100 dark:hover:bg-violet-950/70"
                      >
                        {hslSyncLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                        Sync from Google Sheet
                      </Button>
                    </div>
                  </section>

                  {/* 4. Hubstaff weekly timesheet */}
                  <section className="flex flex-col gap-3 rounded-xl border border-indigo-200/80 bg-indigo-50/40 p-4 dark:border-indigo-900/40 dark:bg-indigo-950/20">
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-indigo-200/90 bg-white dark:border-indigo-800/60 dark:bg-indigo-950/50">
                        <Clock className="h-5 w-5 text-indigo-700 dark:text-indigo-400" aria-hidden />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-800/90 dark:text-indigo-400/90">
                          Hubstaff timesheets
                        </p>
                        <h3 className="text-base font-semibold leading-tight text-zinc-900 dark:text-white">
                          Hubstaff weekly report
                        </h3>
                      </div>
                    </div>
                    <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                      Choose your Hubstaff export CSV. After you confirm, the rows are appended to{' '}
                      <span className="font-mono text-zinc-500">public.hubstaff_hours</span> in Supabase
                      (existing data is preserved). Requires{' '}
                      <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span> in{' '}
                      <span className="font-mono">.env</span>.
                    </p>
                    <div className="flex items-center justify-between gap-2 rounded-full border border-zinc-200 bg-white/70 px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/60">
                      <Label htmlFor="hogan-switch" className="text-xs text-zinc-600 dark:text-zinc-400">
                        Hogan cycle
                      </Label>
                      <Switch id="hogan-switch" checked={isHoganCycle} onCheckedChange={setIsHoganCycle} />
                    </div>
                    <div className="mt-auto flex flex-col gap-2 pt-1">
                      <Button
                        type="button"
                        disabled={weeklyUploadLoading}
                        onClick={() => fileInputWeeklyRef.current?.click()}
                        className="w-full gap-2 bg-indigo-600 text-white hover:bg-indigo-700"
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
                  </section>
                </div>

                {/* ── Start / Stop Processing ── */}
                <div className={cn(
                  'flex items-center justify-between gap-4 rounded-xl border px-4 py-3 transition-colors',
                  lockState.locked
                    ? 'border-rose-200/80 bg-rose-50/60 dark:border-rose-900/40 dark:bg-rose-950/20'
                    : 'border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/30',
                )}>
                  <div className="flex items-center gap-2.5">
                    {lockState.locked ? (
                      <>
                        <span className="relative flex h-2.5 w-2.5">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-70" />
                          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
                        </span>
                        <div>
                          <p className="text-sm font-semibold text-rose-700 dark:text-rose-300">Processing active</p>
                          <p className="text-xs text-rose-600/80 dark:text-rose-400/70">Employee disputes are paused</p>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="flex h-2.5 w-2.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
                        <div>
                          <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Not processing</p>
                          <p className="text-xs text-zinc-500 dark:text-zinc-500">Start to lock disputes and begin payroll</p>
                        </div>
                      </>
                    )}
                  </div>
                  <motion.button
                    type="button"
                    onClick={() => setConfirmingLockToggle(true)}
                    disabled={togglingLock}
                    whileHover={{ y: -1 }}
                    whileTap={{ scale: 0.95 }}
                    transition={{ type: 'spring', stiffness: 380, damping: 26 }}
                    className={cn(
                      'relative inline-flex h-9 min-w-[8.5rem] items-center justify-center gap-2 overflow-hidden rounded-md px-4 text-sm font-semibold text-white shadow-sm transition-[background-image] duration-300 disabled:opacity-60',
                      lockState.locked
                        ? 'bg-gradient-to-br from-rose-500 to-red-600 shadow-rose-500/30 hover:from-rose-600 hover:to-red-700'
                        : 'bg-gradient-to-br from-emerald-500 to-teal-600 shadow-emerald-500/30 hover:from-emerald-600 hover:to-teal-700',
                    )}
                  >
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.span
                        key={lockState.locked ? 'stop' : 'start'}
                        initial={{ opacity: 0, y: 6, scale: 0.92 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6, scale: 0.92 }}
                        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                        className="flex items-center gap-2"
                      >
                        {togglingLock ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : lockState.locked ? (
                          <StopCircle className="h-4 w-4" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                        {lockState.locked ? 'Stop processing' : 'Start processing'}
                      </motion.span>
                    </AnimatePresence>
                  </motion.button>
                </div>

                {/* Confirm toggle dialog */}
                <Dialog open={confirmingLockToggle} onOpenChange={setConfirmingLockToggle}>
                  <DialogContent className="max-w-sm">
                    <DialogHeader>
                      <DialogTitle>{lockState.locked ? 'Stop processing?' : 'Start processing?'}</DialogTitle>
                      <DialogDescription>
                        {lockState.locked
                          ? 'This will unlock employee disputes. Employees will be able to file disputes again.'
                          : 'This will lock employee disputes and signal that payroll is being processed. Employees will not be able to file disputes until you stop.'}
                      </DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2 pt-2">
                      <Button variant="outline" onClick={() => setConfirmingLockToggle(false)}>
                        Cancel
                      </Button>
                      <Button
                        disabled={togglingLock}
                        onClick={() => void handleLockToggle()}
                        className={cn(
                          lockState.locked
                            ? 'bg-rose-600 hover:bg-rose-700'
                            : 'bg-emerald-600 hover:bg-emerald-700',
                          'text-white',
                        )}
                      >
                        {togglingLock && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {lockState.locked ? 'Stop processing' : 'Start processing'}
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>

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
                      {uploadedSourceFiles.map((file) => {
                        const meta = uploadMetaByFile.get(file);
                        const stamp = formatUploadStamp(meta?.uploaded_at);
                        return (
                          <li
                            key={file}
                            className="flex items-start gap-2 rounded-md border border-zinc-100 bg-zinc-50/80 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/50"
                          >
                            <FileText className="h-3.5 w-3.5 mt-0.5 shrink-0 text-zinc-400" />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">
                                  {file}
                                </span>
                                {meta?.is_current && (
                                  <span className="shrink-0 rounded border border-emerald-300 bg-emerald-50 px-1 py-0 text-[9px] font-bold uppercase tracking-wide text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-400">
                                    Current
                                  </span>
                                )}
                              </span>
                              {(stamp || meta?.row_count != null) && (
                                <span className="mt-0.5 block text-[10px] text-zinc-500 dark:text-zinc-500">
                                  {stamp ?? ''}
                                  {stamp && meta?.row_count != null ? ' · ' : ''}
                                  {meta?.row_count != null ? `${meta.row_count.toLocaleString()} rows` : ''}
                                </span>
                              )}
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
                        );
                      })}
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
        // Paginate the calc table. Rendering all ~764 rows (10 cells each) at
        // once — and re-rendering them on every search keystroke — is the main
        // remaining source of jank; cap the DOM to one page.
        const INITIAL_CALC_PAGE_SIZE = 50;
        const calcTotalPages = Math.max(1, Math.ceil(filteredCalcResults.length / INITIAL_CALC_PAGE_SIZE));
        const calcSafePage = Math.min(initialCalcPage, calcTotalPages);
        const pagedCalcResults = filteredCalcResults.slice(
          (calcSafePage - 1) * INITIAL_CALC_PAGE_SIZE,
          calcSafePage * INITIAL_CALC_PAGE_SIZE,
        );
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
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
                  <span className="text-sm font-medium text-indigo-900 dark:text-indigo-200">Active Hubstaff upload</span>
                  <span className="font-mono text-xs text-indigo-800 dark:text-indigo-300">{uploadedSourceFiles[0]}</span>
                  <span className="text-xs text-indigo-700/80 dark:text-indigo-400/80">
                    Newest file in Supabase is the source of truth; older uploads are kept for reference in Step 1.
                  </span>
                </div>
                {calcSourceFileLoading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-indigo-500" />}
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
                      onChange={(e) => { setInitialCalcSearch(e.target.value); setInitialCalcPage(1); }}
                      className="h-8 border-zinc-200 bg-white pl-8 pr-8 text-xs dark:border-zinc-800 dark:bg-zinc-950"
                    />
                    {initialCalcSearch && (
                      <button
                        type="button"
                        onClick={() => { setInitialCalcSearch(''); setInitialCalcPage(1); }}
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
                        pagedCalcResults.map((row, i) => (
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
                {!initialCalcDataLoading && filteredCalcResults.length > INITIAL_CALC_PAGE_SIZE && (
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-xs text-zinc-400">
                      Showing {(calcSafePage - 1) * INITIAL_CALC_PAGE_SIZE + 1}-
                      {Math.min(calcSafePage * INITIAL_CALC_PAGE_SIZE, filteredCalcResults.length)} of {filteredCalcResults.length}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 w-7 p-0 border-zinc-200 dark:border-zinc-800"
                        disabled={calcSafePage === 1}
                        onClick={() => setInitialCalcPage((p) => Math.max(1, p - 1))}
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </Button>
                      {Array.from({ length: Math.min(calcTotalPages, 5) }, (_, i) => {
                        const page = calcTotalPages <= 5
                          ? i + 1
                          : calcSafePage <= 3
                            ? i + 1
                            : calcSafePage >= calcTotalPages - 2
                              ? calcTotalPages - 4 + i
                              : calcSafePage - 2 + i;
                        return (
                          <Button
                            key={page}
                            type="button"
                            variant={calcSafePage === page ? 'default' : 'outline'}
                            size="sm"
                            className={cn(
                              'h-7 w-7 p-0 text-xs',
                              calcSafePage === page
                                ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                                : 'border-zinc-200 dark:border-zinc-800',
                            )}
                            onClick={() => setInitialCalcPage(page)}
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
                        disabled={calcSafePage === calcTotalPages}
                        onClick={() => setInitialCalcPage((p) => Math.min(calcTotalPages, p + 1))}
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      }
      case 3: {
        const activeDept = DEPARTMENTS.find(d => d.key === activeDeptTab) ?? DEPARTMENTS[0]!;
        const deptEmployees = effectiveCalcResults.filter(r => employeeDepts[r.email] === activeDeptTab);
        const unassignedEmployees = effectiveCalcResults.filter(r => !employeeDepts[r.email]);
        const assignedEmployees = effectiveCalcResults.filter(r => employeeDepts[r.email]);
        const totalBonusesAdded = assignedEmployees.reduce((sum, r) => sum + getEffectiveBonus(r.email), 0);
        const totalFinalPay = assignedEmployees.reduce(
          (sum, r) => sum + (r.initialPay ?? 0) + getEffectiveBonus(r.email),
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

                {/* PAB period picker + availability warnings render full-width below the flex-row. */}
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

              {/* ── PAB settings trigger — opens the full picker in a modal so the Additions table has more room ── */}
              {(() => {
                const activeHasOverride = pabPeriodSettings.activeRange.isOverride;
                return (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-indigo-200/70 bg-white/60 px-3 py-2 dark:border-indigo-900/50 dark:bg-zinc-900/40">
                    <button
                      type="button"
                      onClick={() => setPabSettingsOpen(true)}
                      className="inline-flex items-center gap-2 rounded-md border border-indigo-300 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 shadow-sm transition hover:bg-indigo-50 dark:border-indigo-800/60 dark:bg-zinc-900 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                      title="Open PAB period settings"
                    >
                      <CalendarDays className="h-3.5 w-3.5" />
                      <span>PAB settings</span>
                    </button>
                    <span className="text-xs text-zinc-600 dark:text-zinc-400">
                      <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                        {pabMonthRange.monthName} {pabMonthRange.year}
                      </span>
                      <span className="mx-1.5 text-zinc-400">·</span>
                      <span className="font-mono">
                        {pabMonthRange.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        {' – '}
                        {pabMonthRange.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                      {activeHasOverride && (
                        <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                          Custom
                        </span>
                      )}
                    </span>
                    <div className="ml-auto flex items-center gap-1.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => void refreshPabInline()}
                        disabled={pabRefreshing || pabSaveState === 'saving'}
                        title="Re-fetch PAB settings and Hubstaff uploads"
                        className={cn(
                          'inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium transition',
                          'border-indigo-200 bg-white text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60',
                          'dark:border-indigo-800/60 dark:bg-zinc-900 dark:text-indigo-300 dark:hover:bg-indigo-950/40',
                        )}
                      >
                        <RefreshCw className={cn('h-3 w-3', pabRefreshing && 'animate-spin')} />
                        <span>{pabRefreshing ? 'Refreshing…' : 'Refresh'}</span>
                      </button>
                    </div>
                  </div>
                );
              })()}

              {/* Hidden container preserving the original picker content — rendered in a modal below */}
              {pabSettingsOpen && (() => {
                const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
                const today = new Date();
                const todayPm = getCurrentPabMonth(today);
                const activeKey = pabPeriodSettings.activeMonthResolved.key;
                const activeHasOverride = pabPeriodSettings.activeRange.isOverride;
                return (
                  <Dialog open={pabSettingsOpen} onOpenChange={setPabSettingsOpen}>
                    <DialogContent className="flex max-h-[92vh] w-[95vw] max-w-[1200px] flex-col gap-0 overflow-hidden border-zinc-200 bg-white p-0 dark:border-zinc-800 dark:bg-zinc-950 sm:!max-w-[1200px]">
                      <DialogHeader className="shrink-0 border-b border-zinc-200 bg-gradient-to-br from-white via-zinc-50/70 to-indigo-50/40 px-6 py-4 dark:border-zinc-800 dark:from-zinc-950 dark:via-zinc-900/40 dark:to-indigo-950/30">
                        <DialogTitle className="flex items-center gap-2 text-base text-zinc-900 dark:text-white">
                          <CalendarDays className="h-5 w-5 text-indigo-500" />
                          PAB period settings
                        </DialogTitle>
                        <DialogDescription className="text-xs text-zinc-500 dark:text-zinc-400">
                          Pick which month Additions evaluates, edit its start/end, or auto-calculate the canonical Mon–Fri window.
                        </DialogDescription>
                      </DialogHeader>
                      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                    {/* Header row */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <CalendarDays className="h-4 w-4 shrink-0 text-indigo-500 dark:text-indigo-400" />
                        <span className="truncate text-sm font-semibold text-zinc-800 dark:text-zinc-100">PAB month</span>
                      </div>
                      <div className="inline-flex items-center rounded-md border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
                        <button
                          type="button"
                          onClick={() => setPabPickerYear((y) => y - 1)}
                          className="rounded-l p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          aria-label="Previous year"
                        >
                          <ArrowLeft className="h-3.5 w-3.5" />
                        </button>
                        <span className="min-w-[4ch] border-x border-zinc-200 px-2 text-center font-mono text-xs font-semibold text-zinc-700 dark:border-zinc-700 dark:text-zinc-200">
                          {pabPickerYear}
                        </span>
                        <button
                          type="button"
                          onClick={() => setPabPickerYear((y) => y + 1)}
                          className="rounded-r p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          aria-label="Next year"
                        >
                          <ArrowRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="ml-auto flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                        {pabSaveState === 'saving' && (
                          <span className="flex items-center gap-1">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            <span>Saving…</span>
                          </span>
                        )}
                        {pabSaveState === 'saved' && (
                          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                            <Check className="h-3.5 w-3.5" />
                            <span>Saved</span>
                          </span>
                        )}
                        {pabSaveState === 'error' && (
                          <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                            <AlertCircle className="h-3.5 w-3.5" />
                            <span>Save failed</span>
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => void refreshPabInline()}
                          disabled={pabRefreshing || pabSaveState === 'saving'}
                          title="Re-fetch PAB settings and Hubstaff uploads"
                          className={cn(
                            'inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-medium transition',
                            'border-indigo-200 bg-white text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60',
                            'dark:border-indigo-800/60 dark:bg-zinc-900 dark:text-indigo-300 dark:hover:bg-indigo-950/40',
                          )}
                        >
                          <RefreshCw className={cn('h-3.5 w-3.5', pabRefreshing && 'animate-spin')} />
                          <span>{pabRefreshing ? 'Refreshing…' : 'Refresh'}</span>
                        </button>
                      </div>
                    </div>

                    {/* 12-month grid — full names, breathable pills */}
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                      {MONTH_NAMES.map((lbl, m) => {
                        const key = `${pabPickerYear}-${String(m + 1).padStart(2, '0')}`;
                        const dataCount = pabMonthDataCoverage.get(key) ?? 0;
                        const hasData = dataCount > 0;
                        const hasOverride = pabPeriodSettings.overrides.has(key);
                        const isActive = key === activeKey;
                        const isToday = pabPickerYear === todayPm.year && m === todayPm.month;
                        const selectable = hasData || isToday;
                        return (
                          <button
                            key={key}
                            type="button"
                            disabled={!selectable || pabSaveState === 'saving'}
                            onClick={() => { if (selectable) void selectPabMonth(pabPickerYear, m); }}
                            title={
                              !selectable
                                ? `${lbl} ${pabPickerYear} — no Hubstaff data uploaded yet`
                                : `${lbl} ${pabPickerYear}${hasOverride ? ' · custom range saved' : ''}${isToday ? ' · current PAB month' : ''}`
                            }
                            className={cn(
                              'group flex min-w-0 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition',
                              isActive
                                ? 'border-indigo-500 bg-indigo-50 text-indigo-700 shadow-sm ring-1 ring-indigo-500/25 dark:border-indigo-400 dark:bg-indigo-950/60 dark:text-indigo-200'
                                : selectable
                                  ? 'border-zinc-200 bg-white text-zinc-700 hover:border-indigo-300 hover:bg-indigo-50/60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/20'
                                  : 'cursor-not-allowed border-dashed border-zinc-200 bg-zinc-50/60 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-600',
                              'disabled:cursor-not-allowed',
                            )}
                          >
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate">{lbl}</span>
                              {isToday && (
                                <span className="shrink-0 rounded bg-indigo-600 px-1 py-[1px] text-[9px] font-bold uppercase leading-none text-white dark:bg-indigo-500">
                                  Now
                                </span>
                              )}
                            </span>
                            <span className="flex shrink-0 items-center gap-1">
                              <span
                                className={cn(
                                  'h-2 w-2 rounded-full',
                                  hasData
                                    ? 'bg-emerald-500 dark:bg-emerald-400'
                                    : 'bg-zinc-300 dark:bg-zinc-700',
                                )}
                              />
                              {hasOverride && (
                                <span
                                  className="h-2 w-2 rounded-full bg-amber-500 dark:bg-amber-400"
                                  title="Custom override saved"
                                />
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Active-month editor */}
                    <div className="mt-3 border-t border-indigo-200/60 pt-3 dark:border-indigo-900/40">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <span className="rounded-md bg-indigo-600/10 px-2 py-1 text-xs font-bold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200">
                          Active: {pabMonthRange.monthName} {pabMonthRange.year}
                        </span>
                        <div className="flex min-w-0 items-center gap-2">
                          <Input
                            type="date"
                            value={pabStartLocal}
                            onChange={(ev) => {
                              const v = ev.target.value;
                              setPabStartLocal(v);
                              if (v && pabEndLocal) void saveActiveMonthOverride(v, pabEndLocal);
                            }}
                            disabled={pabSaveState === 'saving'}
                            className="h-8 w-[150px] shrink-0 text-xs"
                          />
                          <span className="text-zinc-400">→</span>
                          <Input
                            type="date"
                            value={pabEndLocal}
                            onChange={(ev) => {
                              const v = ev.target.value;
                              setPabEndLocal(v);
                              if (pabStartLocal && v) void saveActiveMonthOverride(pabStartLocal, v);
                            }}
                            disabled={pabSaveState === 'saving'}
                            className="h-8 w-[150px] shrink-0 text-xs"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => void autoCalcActiveMonth()}
                          disabled={pabSaveState === 'saving'}
                          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-indigo-300 bg-white px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-indigo-800/60 dark:bg-zinc-900 dark:text-indigo-300 dark:hover:bg-indigo-950/30"
                          title="Auto-calculate this month's PAB window: first Monday on/after the 1st → Friday of the last week whose Monday falls in the month"
                        >
                          <Calculator className="h-3.5 w-3.5" />
                          <span>Auto-calc</span>
                        </button>
                        {activeHasOverride ? (
                          <button
                            type="button"
                            onClick={() => void resetActiveMonthOverride()}
                            disabled={pabSaveState === 'saving'}
                            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-800/60 dark:bg-zinc-900 dark:text-amber-300 dark:hover:bg-amber-950/30"
                            title="Delete this month's custom range"
                          >
                            <X className="h-3.5 w-3.5" />
                            <span>Reset override</span>
                          </button>
                        ) : (
                          <span className="text-xs italic text-zinc-500 dark:text-zinc-400">
                            Using default (first Mon → last Fri)
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Legend */}
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-500">
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-emerald-500" /> Has Hubstaff data
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-amber-500" /> Custom override saved
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-700" /> No data — not selectable
                      </span>
                    </div>
                      </div>
                    </DialogContent>
                  </Dialog>
                );
              })()}

              {/* PAB coverage / data warnings — full width */}
              {pabMonthRange && hubstaffColsForPab && !pabMonthColumnCoverageComplete && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-400">
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
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    <strong>Perfect Attendance cannot be detected.</strong> The daily hours breakdown (Mon–Fri columns) is empty in Supabase.
                    PAB is evaluated monthly (all uploaded CSVs). Go back to <strong>Step 1</strong> and <strong>re-upload the Hubstaff CSVs</strong> — daily data will be stored correctly.
                  </span>
                </div>
              )}
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
                        One set of daily counts for the whole team — every accounting employee receives the same bonus.
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
                        AI/API Team — Ticket + Site Bonus
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
                        // KPI Bonus: only SSD members are eligible. Apply All
                        // restricts the bulk action to that subset.
                        const eligibleEmails = bonus.id === KPI_BONUS_ID
                          ? deptEmployees
                              .filter(e => ssdMemberEmails.has(e.email.toLowerCase()))
                              .map(e => e.email)
                          : deptEmployees.map(e => e.email);
                        const allChecked =
                          eligibleEmails.length > 0 &&
                          eligibleEmails.every(em => employeeBonuses[em]?.[bonus.id]);
                        const ssdReady = bonus.id === KPI_BONUS_ID && ssdKpiPeriod != null;
                        return (
                          <div key={bonus.id} className="flex items-center justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-zinc-800 dark:text-zinc-200">
                                <span className="truncate">{bonus.label}</span>
                                {bonus.id === KPI_BONUS_ID && (
                                  <span className="rounded bg-emerald-100 px-1 py-0.5 font-mono text-[8px] uppercase tracking-wider text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                                    SSD only
                                  </span>
                                )}
                              </div>
                              <div className="font-mono text-xs font-bold text-violet-600 dark:text-violet-400">
                                {bonus.id === KPI_BONUS_ID ? (
                                  ssdReady ? (
                                    <>
                                      wk of {ssdKpiPeriod!.period_start}
                                      <span className="ml-1 font-normal text-zinc-500">
                                        · {eligibleEmails.length} eligible
                                      </span>
                                    </>
                                  ) : ssdKpiLoading ? (
                                    <span className="text-zinc-400">loading…</span>
                                  ) : (
                                    <span className="text-amber-600 dark:text-amber-400">no KPI ready yet</span>
                                  )
                                ) : (
                                  formatPHP(bonus.amount)
                                )}
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
                              disabled={eligibleEmails.length === 0}
                              onClick={() =>
                                applyBonusToAllInDept(
                                  bonus.id,
                                  activeDeptTab,
                                  !allChecked,
                                  eligibleEmails,
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
                            <TableHead className="min-w-[200px] px-2 py-2 text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                              Employee
                            </TableHead>
                            <TableHead className="min-w-[64px] px-1 py-2 text-right text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                              Init
                            </TableHead>
                            <TableHead className="min-w-[96px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-indigo-600 dark:text-indigo-400">
                              PAB<br />
                              <span className="font-mono font-normal text-zinc-400">M T W T F · 7h+</span>
                            </TableHead>
                            {/* Formula-based dept metric columns */}
                            {activeDeptTab === 'accounting' && (() => {
                              const acctDm = deptMetrics['accounting'] ?? {};
                              const hasAcctData = ACCOUNTING_WEEKDAY_METRICS.some(({ key }) =>
                                Object.prototype.hasOwnProperty.call(acctDm, key),
                              );
                              return (
                                <TableHead className="min-w-[130px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                  <div className="flex flex-col items-center gap-1">
                                    <span>Weekly bonus (shared)</span>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      onClick={() => setAccountingDeptModalOpen(true)}
                                      className="h-5 border-violet-300 bg-violet-50 px-2 text-[9px] font-semibold text-violet-700 hover:bg-violet-100 dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-300"
                                    >
                                      {hasAcctData ? 'Edit Counts' : 'Set Counts'}
                                    </Button>
                                  </div>
                                </TableHead>
                              );
                            })()}
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
                                className={cn(
                                  'px-1 py-2 text-center text-[9px] font-medium leading-tight text-violet-600 dark:text-violet-400',
                                  b.id === KPI_BONUS_ID ? 'min-w-[96px]' : 'min-w-[68px]',
                                )}
                              >
                                {b.id === KPI_BONUS_ID ? (
                                  <>
                                    <span className="line-clamp-2">{b.label}</span>
                                    <br />
                                    <span className="font-mono text-[8px] font-normal text-zinc-500 dark:text-zinc-400">
                                      {ssdKpiPeriod
                                        ? `wk ${ssdKpiPeriod.period_start.slice(5)} · ${ssdKpiPeriod.status}`
                                        : ssdKpiLoading
                                          ? 'loading…'
                                          : 'no KPI ready'}
                                    </span>
                                  </>
                                ) : (
                                  <>
                                    <span className="line-clamp-2">{b.label}</span>
                                    <br />
                                    <span className="font-mono font-bold">{formatPHP(b.amount)}</span>
                                  </>
                                )}
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
                            const autoBonus = bonusTotals[emp.email] ?? 0;
                            const hasOverride = bonusOverrides[emp.email] !== undefined;
                            const bonusTotal = hasOverride ? (bonusOverrides[emp.email] ?? 0) : autoBonus;
                            const empRateRow = ratesByEmail.get(normEmail(emp.email) ?? '');
                            const empMesaDeduction = (emp.initialPay != null && empRateRow?.mesa_member) ? 100 : 0;
                            const finalPay = (emp.initialPay ?? 0) + bonusTotal - empMesaDeduction;
                            const empM = employeeMetrics[emp.email] ?? {};
                            const isJerome = isJeromeRosero(emp.name);
                            return (
                              <TableRow
                                key={emp.email}
                                className="border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/30"
                              >
                                <TableCell className="px-2 py-1.5">
                                  <div className="whitespace-normal break-words text-[12px] font-semibold leading-tight text-zinc-800 dark:text-zinc-200">
                                    {emp.name || '—'}
                                  </div>
                                  <div className="truncate font-mono text-[9px] leading-tight text-zinc-400">
                                    {emp.email}
                                  </div>
                                </TableCell>
                                <TableCell className="px-1 py-1.5 text-right font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                                  {emp.initialPay != null ? formatPHP(emp.initialPay) : '—'}
                                </TableCell>
                                {/* PAB — tri-state pill (Eligible / Ineligible / In Progress); click to open calendar modal */}
                                {(() => {
                                  const normEmpEmail = normEmail(emp.email) ?? emp.email.toLowerCase();
                                  const status = pabStatusByEmail.get(normEmpEmail) ?? 'in_progress';
                                  const label =
                                    status === 'eligible' ? '✓ Eligible'
                                    : status === 'ineligible' ? '✗ Ineligible'
                                    : '⏳ In Progress';
                                  const titleText =
                                    status === 'eligible' ? 'Passed every Mon–Fri in the PAB period — click to see the calendar.'
                                    : status === 'ineligible' ? 'Already failed at least one past weekday — locked for this period. Click to see which day.'
                                    : 'PAB period is still running and no past failures yet. Click to see the calendar.';
                                  return (
                                    <TableCell className="px-1 py-1.5 text-center">
                                      <button
                                        type="button"
                                        onClick={() => setPabCalendarModalEmail(emp.email)}
                                        title={titleText}
                                        className={cn(
                                          'group inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none transition-all duration-200',
                                          'hover:scale-105 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-offset-1 dark:focus:ring-offset-zinc-900',
                                          status === 'eligible'
                                            ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-400/40 hover:bg-emerald-200 focus:ring-emerald-400 dark:bg-emerald-900/40 dark:text-emerald-300 dark:ring-emerald-500/30 dark:hover:bg-emerald-900/60'
                                            : status === 'ineligible'
                                              ? 'bg-red-100 text-red-600 ring-1 ring-red-400/40 hover:bg-red-200 focus:ring-red-400 dark:bg-red-900/30 dark:text-red-300 dark:ring-red-500/30 dark:hover:bg-red-900/50'
                                              : 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-400/40 hover:bg-indigo-200 focus:ring-indigo-400 dark:bg-indigo-900/40 dark:text-indigo-300 dark:ring-indigo-500/30 dark:hover:bg-indigo-900/60',
                                        )}
                                      >
                                        <span>{label}</span>
                                      </button>
                                    </TableCell>
                                  );
                                })()}
                                {/* Accounting: shared dept bonus (read-only per row) */}
                                {activeDeptTab === 'accounting' && (() => {
                                  const acctDm = deptMetrics['accounting'] ?? {};
                                  const dayBonus = (count: number) =>
                                    count >= 30 ? 450 : count >= 22 ? 300 : count >= 17 ? 200 : 0;
                                  const hasDailyBreakdown = ACCOUNTING_WEEKDAY_METRICS.some(({ key }) =>
                                    Object.prototype.hasOwnProperty.call(acctDm, key),
                                  );
                                  const sharedBonus = hasDailyBreakdown
                                    ? ACCOUNTING_WEEKDAY_METRICS.reduce((s, { key }) => s + dayBonus(acctDm[key] ?? 0), 0)
                                    : dayBonus(acctDm.collected ?? 0);
                                  return (
                                    <TableCell className="px-1 py-1 text-center align-middle">
                                      {hasDailyBreakdown ? (
                                        <span className="font-mono text-xs font-bold text-violet-600 dark:text-violet-400">
                                          {formatPHP(sharedBonus)}
                                        </span>
                                      ) : (
                                        <span className="text-[9px] text-zinc-400 dark:text-zinc-600">—</span>
                                      )}
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
                                {!FORMULA_DEPT_KEYS.has(activeDeptTab) && activeDept.bonuses.map(bonus => {
                                  if (bonus.id === KPI_BONUS_ID) {
                                    const lc = emp.email.toLowerCase();
                                    const isSSD = ssdMemberEmails.has(lc);
                                    const amount = ssdKpiAmounts[lc] ?? 0;
                                    if (!isSSD) {
                                      return (
                                        <TableCell
                                          key={bonus.id}
                                          className="px-1 py-1.5 text-center"
                                          title="Not in SSD Medical Records team — KPI Bonus only applies to SSD"
                                        >
                                          <span className="font-mono text-[10px] text-zinc-300 dark:text-zinc-700">—</span>
                                        </TableCell>
                                      );
                                    }
                                    return (
                                      <TableCell key={bonus.id} className="px-1 py-1.5 text-center">
                                        <div className="flex flex-col items-center gap-0.5">
                                          <Switch
                                            checked={employeeBonuses[emp.email]?.[bonus.id] ?? false}
                                            onCheckedChange={v => toggleEmployeeBonus(emp.email, bonus.id, v)}
                                            className="data-[state=checked]:bg-indigo-600"
                                            disabled={amount === 0}
                                          />
                                          <span
                                            className={cn(
                                              'font-mono text-[9px] tabular-nums',
                                              amount > 0
                                                ? 'text-emerald-600 dark:text-emerald-400'
                                                : 'text-zinc-400 dark:text-zinc-600',
                                            )}
                                            title={
                                              amount === 0
                                                ? 'No KPI score recorded for this employee in the current week'
                                                : `KPI calculated bonus`
                                            }
                                          >
                                            {amount > 0 ? formatPHP(amount) : '₱0'}
                                          </span>
                                        </div>
                                      </TableCell>
                                    );
                                  }
                                  return (
                                    <TableCell key={bonus.id} className="px-1 py-1.5 text-center">
                                      <Switch
                                        checked={employeeBonuses[emp.email]?.[bonus.id] ?? false}
                                        onCheckedChange={v => toggleEmployeeBonus(emp.email, bonus.id, v)}
                                        className="data-[state=checked]:bg-indigo-600"
                                      />
                                    </TableCell>
                                  );
                                })}
                                <TableCell className="px-1 py-1.5 text-right font-mono text-[11px] font-bold">
                                  {isRecalcPending ? (
                                    <span className="inline-block h-3 w-12 animate-pulse rounded bg-emerald-200/60 dark:bg-emerald-900/40" />
                                  ) : (
                                    <div className="flex items-center justify-end gap-1">
                                      <input
                                        type="number"
                                        inputMode="decimal"
                                        step="0.01"
                                        value={bonusTotal}
                                        onChange={(e) => {
                                          const raw = e.target.value;
                                          const next = raw === '' ? 0 : Number(raw);
                                          if (!Number.isFinite(next)) return;
                                          setBonusOverrides((prev) => ({ ...prev, [emp.email]: next }));
                                        }}
                                        title={hasOverride ? `Auto-computed: ${formatPHP(autoBonus)}` : 'Auto-computed bonus — edit to override'}
                                        className={cn(
                                          'h-6 w-[88px] rounded border bg-white px-1.5 text-right font-mono text-[11px] font-bold tabular-nums focus:outline-none focus:ring-1 dark:bg-zinc-900',
                                          hasOverride
                                            ? 'border-amber-400/70 text-amber-700 focus:ring-amber-400 dark:border-amber-700/60 dark:text-amber-300'
                                            : bonusTotal > 0
                                              ? 'border-emerald-300/70 text-emerald-600 focus:ring-emerald-400 dark:border-emerald-700/40 dark:text-emerald-400'
                                              : 'border-zinc-200 text-zinc-500 focus:ring-zinc-300 dark:border-zinc-700',
                                        )}
                                      />
                                      {hasOverride && (
                                        <button
                                          type="button"
                                          onClick={() => setBonusOverrides((prev) => {
                                            const next = { ...prev };
                                            delete next[emp.email];
                                            return next;
                                          })}
                                          title={`Revert to auto: ${formatPHP(autoBonus)}`}
                                          className="text-zinc-400 hover:text-red-500"
                                        >
                                          <X className="h-3 w-3" />
                                        </button>
                                      )}
                                    </div>
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
                                deptEmployees.reduce((sum, e) => sum + getEffectiveBonus(e.email), 0),
                              )}
                            </span>
                          )}
                        </span>
                        <span className="text-xs text-zinc-500">
                          Dept Final Pay:{' '}
                          <span className="font-mono font-bold text-zinc-900 dark:text-white">
                            {formatPHP(
                              deptEmployees.reduce(
                                (sum, e) => sum + (e.initialPay ?? 0) + getEffectiveBonus(e.email),
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
        // ──────────── Orphanage step ────────────
        // Two sections:
        //   1. Approved orphanage visits in the active PAB month range.
        //   2. Per-employee summary of orphanage hours and the wages those
        //      hours represent (override_hours × regularRate from rates).
        const isApprovedOrphanage = (s: string) =>
          s === 'accounting_approved' || s === 'approved';

        const orphanageQuery = orphanageSearch.trim().toLowerCase();
        const rateByEmail = new Map<string, number>();
        const nameByEmailOrph = new Map<string, string>();
        for (const r of effectiveCalcResults) {
          const em = (r.email ?? '').trim().toLowerCase();
          if (!em) continue;
          if (r.regularRate != null) rateByEmail.set(em, r.regularRate);
          if (r.name) nameByEmailOrph.set(em, r.name);
        }

        // Session-only delete key for visit rows (no DB id available).
        const visitKey = (row: { work_email: string; dispute_date: string }) =>
          `${(row.work_email ?? '').trim().toLowerCase()}|${row.dispute_date}`;
        // Section 1 rows — every dispute in the range, with a normalized email key.
        const orphanageVisitRows = orphanageRows
          .filter((row) => !hiddenVisitIds.has(visitKey(row)))
          .map((row) => {
            const em = (row.work_email ?? '').trim().toLowerCase();
            return {
              ...row,
              email: em,
              name: nameByEmailOrph.get(em) ?? '—',
              isApproved: isApprovedOrphanage(row.status),
              _key: visitKey(row),
            };
          })
          .filter((r) => {
            if (!orphanageQuery) return true;
            return (
              r.email.includes(orphanageQuery) ||
              r.name.toLowerCase().includes(orphanageQuery) ||
              r.dispute_date.includes(orphanageQuery)
            );
          })
          .sort((a, b) =>
            a.dispute_date.localeCompare(b.dispute_date) ||
            (a.name || '').localeCompare(b.name || ''),
          );

        // Section 2 rows — aggregate approved hours per employee, multiply by rate.
        type WageRow = {
          email: string;
          name: string;
          visitCount: number;
          totalHours: number;
          regularRate: number | null;
          wages: number | null;
        };
        const wageMap = new Map<string, WageRow>();
        for (const r of orphanageVisitRows) {
          if (!r.isApproved) continue;
          const em = r.email;
          if (!em) continue;
          const hours = r.override_hours ?? 8;
          const existing = wageMap.get(em);
          if (existing) {
            existing.visitCount += 1;
            existing.totalHours += hours;
            existing.wages =
              existing.regularRate != null ? existing.totalHours * existing.regularRate : null;
          } else {
            // rateByEmail is keyed by Hubstaff email; orphanage disputes store work_email.
            // Fall back to ratesByEmail (indexed by both work + personal email from rates
            // table) so employees whose Hubstaff account uses personal email still resolve.
            const rate = rateByEmail.get(em)
              ?? (() => { const row = ratesByEmail.get(em); return row ? parseRateField(row.regular_rate) : null; })()
              ?? null;
            wageMap.set(em, {
              email: em,
              name: r.name,
              visitCount: 1,
              totalHours: hours,
              regularRate: rate,
              wages: rate != null ? hours * rate : null,
            });
          }
        }
        const orphanageWageRows = Array.from(wageMap.values())
          .filter((w) => !hiddenWageEmails.has(w.email))
          .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        const totalOrphanageHours = orphanageWageRows.reduce((s, r) => s + r.totalHours, 0);
        const totalOrphanageWages = orphanageWageRows.reduce(
          (s, r) => s + (r.wages ?? 0),
          0,
        );
        const totalApprovedVisits = orphanageVisitRows.filter((r) => r.isApproved).length;
        const totalPendingVisits = orphanageVisitRows.length - totalApprovedVisits;

        // Budget request totals — only Accounting-approved rows are payable.
        // Session-deleted rows are excluded from both display totals and dispatch.
        const visibleBudgetRequestRows = budgetRequestRows.filter((r) => !hiddenBudgetIds.has(r.id));
        const approvedBudgetRequestRows = visibleBudgetRequestRows.filter((r) => r.status === 'approved');
        const pendingBudgetRequestRows = visibleBudgetRequestRows.filter((r) => r.status === 'pending');
        const totalBudgetRequestsPHP = approvedBudgetRequestRows.reduce((s, r) => {
          const amount = Number(r.final_amount ?? 0);
          return s + (Number.isFinite(amount) ? amount : 0);
        }, 0);

        // Gift payment totals — total_usd × usdToPhpRate.
        const totalGiftsUSD = giftPaymentRows.reduce(
          (s, r) => s + (Number.isFinite(r.total_usd) ? r.total_usd : 0),
          0,
        );
        const totalGiftsPHP = totalGiftsUSD * usdToPhpRate;

        // Tenure-gift totals (PHP, snapshot at approval time).
        const totalTenureGiftsPHP = tenureGiftRows.reduce(
          (s, r) => s + (Number.isFinite(r.gift_price_php) ? r.gift_price_php : 0),
          0,
        );

        const monthLabelOrph = pabMonthRange
          ? `${pabMonthRange.monthName} ${pabMonthRange.year}`
          : 'Active PAB month';

        return (
          <div className="flex min-w-0 flex-col gap-5">
            {/* Header banner */}
            <div className="flex flex-col gap-1 rounded-2xl border border-rose-200/70 bg-gradient-to-br from-rose-50 via-white to-pink-50/40 p-5 shadow-sm dark:border-rose-900/40 dark:from-rose-950/30 dark:via-zinc-950 dark:to-rose-950/15">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-rose-700 dark:text-rose-300">
                <Heart className="h-3.5 w-3.5" /> Orphanage · {monthLabelOrph}
              </div>
              <h2 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-white">
                Approved orphanage visits and the wages they cover
              </h2>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                Visits with status <span className="font-mono">accounting_approved</span> or{' '}
                <span className="font-mono">approved</span> are paid as worked time.
                Hours fall back to <span className="font-mono">8</span> when no override is set.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                <span className="rounded-full border border-emerald-300/70 bg-emerald-50 px-2.5 py-0.5 font-medium text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-200">
                  {totalApprovedVisits} approved
                </span>
                {totalPendingVisits > 0 && (
                  <span className="rounded-full border border-amber-300/70 bg-amber-50 px-2.5 py-0.5 font-medium text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
                    {totalPendingVisits} pending / denied
                  </span>
                )}
                <span className="text-zinc-500 dark:text-zinc-400">
                  {totalOrphanageHours.toFixed(1)} hrs · {formatPHP(totalOrphanageWages)} wages
                </span>
                <span className="rounded-full border border-rose-300/70 bg-rose-50 px-2.5 py-0.5 font-medium text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                  {approvedBudgetRequestRows.length} approved budget request{approvedBudgetRequestRows.length === 1 ? '' : 's'} · {formatPHP(totalBudgetRequestsPHP)}
                </span>
                {pendingBudgetRequestRows.length > 0 && (
                  <span className="rounded-full border border-amber-300/70 bg-amber-50 px-2.5 py-0.5 font-medium text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
                    {pendingBudgetRequestRows.length} budget pending approval
                  </span>
                )}
              </div>
            </div>

            {/* Tab strip */}
            {(() => {
              const tabs: { key: OrphanageTab; label: string; icon: React.ReactNode; count: number; accent: string }[] = [
                {
                  key: 'visits',
                  label: 'Visits',
                  icon: <CalendarDays className="h-3.5 w-3.5" />,
                  count: orphanageVisitRows.length,
                  accent: 'rose',
                },
                {
                  key: 'wages',
                  label: 'Wages',
                  icon: <DollarSign className="h-3.5 w-3.5" />,
                  count: orphanageWageRows.length,
                  accent: 'rose',
                },
                {
                  key: 'budgets',
                  label: 'Budget requests',
                  icon: <DollarSign className="h-3.5 w-3.5" />,
                  count: budgetRequestRows.length,
                  accent: 'rose',
                },
              ];
              return (
                <div className="flex flex-wrap gap-1.5">
                  {tabs.map((t) => {
                    const active = orphanageTab === t.key;
                    return (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => setOrphanageTab(t.key)}
                        className={cn(
                          'flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                          active
                            ? t.accent === 'fuchsia'
                              ? 'border-fuchsia-500/50 bg-fuchsia-600/10 text-fuchsia-700 dark:text-fuchsia-300'
                              : t.accent === 'pink'
                                ? 'border-pink-500/50 bg-pink-600/10 text-pink-700 dark:text-pink-300'
                                : 'border-rose-500/50 bg-rose-600/10 text-rose-700 dark:text-rose-300'
                            : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/50',
                        )}
                      >
                        {t.icon}
                        {t.label}
                        <span
                          className={cn(
                            'rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none',
                            active
                              ? t.accent === 'fuchsia'
                                ? 'bg-fuchsia-600 text-white'
                                : t.accent === 'pink'
                                  ? 'bg-pink-600 text-white'
                                  : 'bg-rose-600 text-white'
                              : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400',
                          )}
                        >
                          {t.count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })()}

            {/* Section 1 — Orphanage visits list */}
            {orphanageTab === 'visits' && (
            <Card className="overflow-hidden shadow-sm ring-1 ring-zinc-200 dark:ring-zinc-800">
              <CardHeader className="flex flex-col gap-3 border-b border-zinc-200/90 bg-zinc-50/60 pb-3 dark:border-zinc-800 dark:bg-zinc-900/40 sm:flex-row sm:items-center sm:justify-between">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <CalendarDays className="h-4 w-4 text-rose-600 dark:text-rose-400" />
                  Orphanage visits
                </CardTitle>
                <div className="flex items-center gap-3">
                  <div className="relative w-full max-w-[260px]">
                    <Input
                      value={orphanageSearch}
                      onChange={(e) => setOrphanageSearch(e.target.value)}
                      placeholder="Search name, email, date…"
                      className="h-8 pl-3 text-xs"
                    />
                  </div>
                  <span className="shrink-0 text-[10px] text-zinc-500 dark:text-zinc-400">
                    {orphanageVisitRows.length} of {orphanageRows.length}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {orphanageLoading ? (
                  <div className="flex items-center justify-center py-10 text-zinc-500">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
                  </div>
                ) : orphanageError ? (
                  <p className="p-6 text-center text-xs text-rose-600 dark:text-rose-400">
                    {orphanageError}
                  </p>
                ) : orphanageVisitRows.length === 0 ? (
                  <p className="p-8 text-center text-xs text-zinc-400">
                    No orphanage visits recorded for this period.
                  </p>
                ) : (
                  <div className="max-h-[420px] overflow-y-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="sticky top-0 z-[1] border-b border-rose-100 bg-rose-50/80 text-[11px] font-semibold uppercase tracking-wider text-rose-700 backdrop-blur dark:border-rose-900/40 dark:bg-rose-950/40 dark:text-rose-300">
                        <tr>
                          <th className="px-4 py-2.5">Date</th>
                          <th className="px-4 py-2.5">Employee</th>
                          <th className="px-4 py-2.5">Email</th>
                          <th className="px-4 py-2.5">Reason</th>
                          <th className="px-4 py-2.5 text-right">Hours</th>
                          <th className="px-4 py-2.5">Status</th>
                          <th className="w-10 px-2 py-2.5" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-rose-50 dark:divide-rose-950/30">
                        {orphanageVisitRows.map((r, i) => (
                          <tr
                            key={`${r.email}-${r.dispute_date}-${i}`}
                            className={cn(
                              'transition-colors hover:bg-rose-50/40 dark:hover:bg-rose-950/15',
                              !r.isApproved && 'opacity-60',
                            )}
                          >
                            <td className="px-4 py-2 font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                              {r.dispute_date}
                            </td>
                            <td className="px-4 py-2 font-medium text-zinc-800 dark:text-zinc-200">
                              {r.name}
                            </td>
                            <td className="px-4 py-2 font-mono text-zinc-500 dark:text-zinc-400">
                              {r.email}
                            </td>
                            <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">
                              {r.reason === 'orphanage_visit' ? 'Orphanage' : r.reason === 'ceo_visitation' ? 'CEO visitation' : r.reason}
                            </td>
                            <td className="px-4 py-2 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                              {(r.override_hours ?? 8).toFixed(1)}
                            </td>
                            <td className="px-4 py-2">
                              <span
                                className={cn(
                                  'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                                  r.isApproved
                                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                                    : 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
                                )}
                              >
                                {r.status.replace(/_/g, ' ')}
                              </span>
                            </td>
                            <td className="px-2 py-2 text-right">
                              <button
                                type="button"
                                onClick={() => setHiddenVisitIds((prev) => new Set(prev).add(r._key))}
                                title="Remove from this payroll run"
                                className="text-zinc-400 hover:text-red-500"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
            )}

            {/* Section 2 — Hours and wages summary */}
            {orphanageTab === 'wages' && (
            <Card className="overflow-hidden shadow-sm ring-1 ring-zinc-200 dark:ring-zinc-800">
              <CardHeader className="border-b border-zinc-200/90 bg-zinc-50/60 pb-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <DollarSign className="h-4 w-4 text-rose-600 dark:text-rose-400" />
                  Orphanage hours & wages
                </CardTitle>
                <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                  Approved visits only · wages = total hours × employee&apos;s regular rate.
                </p>
              </CardHeader>
              <CardContent className="p-0">
                {orphanageWageRows.length === 0 ? (
                  <p className="p-8 text-center text-xs text-zinc-400">
                    No approved orphanage visits → no wages to compute.
                  </p>
                ) : (
                  <div className="max-h-[420px] overflow-y-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="sticky top-0 z-[1] border-b border-rose-100 bg-rose-50/80 text-[11px] font-semibold uppercase tracking-wider text-rose-700 backdrop-blur dark:border-rose-900/40 dark:bg-rose-950/40 dark:text-rose-300">
                        <tr>
                          <th className="px-4 py-2.5">Employee</th>
                          <th className="px-4 py-2.5">Email</th>
                          <th className="px-4 py-2.5 text-right">Visits</th>
                          <th className="px-4 py-2.5 text-right">Hours</th>
                          <th className="px-4 py-2.5 text-right">Reg rate</th>
                          <th className="px-4 py-2.5 text-right">Wages</th>
                          <th className="w-10 px-2 py-2.5" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-rose-50 dark:divide-rose-950/30">
                        {orphanageWageRows.map((r) => (
                          <tr
                            key={r.email}
                            className="transition-colors hover:bg-rose-50/40 dark:hover:bg-rose-950/15"
                          >
                            <td className="px-4 py-2 font-medium text-zinc-800 dark:text-zinc-200">
                              {r.name}
                            </td>
                            <td className="px-4 py-2 font-mono text-zinc-500 dark:text-zinc-400">
                              {r.email}
                            </td>
                            <td className="px-4 py-2 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                              {r.visitCount}
                            </td>
                            <td className="px-4 py-2 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                              {r.totalHours.toFixed(1)}
                            </td>
                            <td className="px-4 py-2 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-400">
                              {r.regularRate != null ? formatPHP(r.regularRate) : <span className="text-amber-600 dark:text-amber-400">no rate</span>}
                            </td>
                            <td className="px-4 py-2 text-right font-mono font-semibold tabular-nums text-zinc-900 dark:text-white">
                              {r.wages != null ? formatPHP(r.wages) : '—'}
                            </td>
                            <td className="px-2 py-2 text-right">
                              <button
                                type="button"
                                onClick={() => setHiddenWageEmails((prev) => new Set(prev).add(r.email))}
                                title="Remove this employee's wages from this payroll run"
                                className="text-zinc-400 hover:text-red-500"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="border-t-2 border-rose-200/60 bg-rose-50/40 dark:border-rose-800/40 dark:bg-rose-950/30">
                        <tr>
                          <td className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-300" colSpan={3}>
                            Total
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono font-bold tabular-nums text-zinc-900 dark:text-white">
                            {totalOrphanageHours.toFixed(1)}
                          </td>
                          <td />
                          <td className="px-4 py-2.5 text-right font-mono font-bold tabular-nums text-zinc-900 dark:text-white">
                            {formatPHP(totalOrphanageWages)}
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
            )}

            {/* Section 3 — Orphanage budget requests for Accounting approval */}
            {orphanageTab === 'budgets' && (
            <Card className="overflow-hidden shadow-sm ring-1 ring-zinc-200 dark:ring-zinc-800">
              <CardHeader className="border-b border-zinc-200/90 bg-zinc-50/60 pb-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <DollarSign className="h-4 w-4 text-rose-600 dark:text-rose-400" />
                  Orphanage budget requests
                </CardTitle>
                <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                  Pending requests can be approved here. Only approved requests are added to payroll dispatch.
                </p>
              </CardHeader>
              <CardContent className="p-0">
                {budgetRequestsLoading ? (
                  <div className="flex items-center justify-center py-10 text-zinc-500">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
                  </div>
                ) : budgetRequestsError ? (
                  <p className="p-6 text-center text-xs text-rose-600 dark:text-rose-400">
                    {budgetRequestsError}
                  </p>
                ) : visibleBudgetRequestRows.length === 0 ? (
                  <p className="p-8 text-center text-xs text-zinc-400">
                    No budget requests ready for this payroll period.
                  </p>
                ) : (
                  <div className="max-h-[420px] overflow-y-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="sticky top-0 z-[1] border-b border-rose-100 bg-rose-50/80 text-[11px] font-semibold uppercase tracking-wider text-rose-700 backdrop-blur dark:border-rose-900/40 dark:bg-rose-950/40 dark:text-rose-300">
                        <tr>
                          <th className="px-4 py-2.5">Status</th>
                          <th className="px-4 py-2.5">Date</th>
                          <th className="px-4 py-2.5">Submitter</th>
                          <th className="px-4 py-2.5">Visit type</th>
                          <th className="px-4 py-2.5 text-right">Subtotal</th>
                          <th className="px-4 py-2.5 text-right">Leftover</th>
                          <th className="px-4 py-2.5 text-right">Final</th>
                          <th className="px-4 py-2.5 text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-rose-50 dark:divide-rose-950/30">
                        {visibleBudgetRequestRows.map((r) => {
                          const displayDate = r.decided_at ?? r.submitted_at;
                          const isDeciding = budgetRequestDecidingId === r.id;
                          return (
                            <tr
                              key={r.id}
                              className="transition-colors hover:bg-rose-50/40 dark:hover:bg-rose-950/15"
                            >
                              <td className="px-4 py-2">
                                <span
                                  className={cn(
                                    'inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ring-inset',
                                    r.status === 'approved' && 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:ring-emerald-800/60',
                                    r.status === 'pending' && 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-800/60',
                                    r.status === 'rejected' && 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/30 dark:text-rose-300 dark:ring-rose-800/60',
                                  )}
                                >
                                  {r.status}
                                </span>
                              </td>
                              <td className="px-4 py-2 font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                                <div>{displayDate.slice(0, 10)}</div>
                                {r.decided_at && r.submitted_at && r.submitted_at.slice(0, 10) !== r.decided_at.slice(0, 10) && (
                                  <div className="mt-0.5 text-[10px] text-zinc-400">
                                    submitted {r.submitted_at.slice(0, 10)}
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-2 font-mono text-zinc-600 dark:text-zinc-400">
                                {r.submitter_email}
                              </td>
                              <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                                {r.visit_type}
                                {r.mission_trip && (
                                  <span className="ml-1 rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
                                    mission
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-2 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-400">
                                {formatPHP(Number(r.subtotal ?? 0))}
                              </td>
                              <td className="px-4 py-2 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-400">
                                {formatPHP(Number(r.leftover ?? 0))}
                              </td>
                              <td className="px-4 py-2 text-right font-mono font-semibold tabular-nums text-zinc-900 dark:text-white">
                                {formatPHP(Number(r.final_amount ?? 0))}
                              </td>
                              <td className="px-4 py-2 text-right">
                                <div className="flex items-center justify-end gap-1.5">
                                  {r.status === 'pending' ? (
                                    <>
                                      <Button
                                        type="button"
                                        size="sm"
                                        className="h-7 gap-1 bg-emerald-600 px-2 text-[11px] text-white hover:bg-emerald-700"
                                        disabled={isDeciding}
                                        onClick={() => void decideBudgetRequest(r.id, 'approved')}
                                      >
                                        {isDeciding ? (
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                          <Check className="h-3 w-3" />
                                        )}
                                        Approve
                                      </Button>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="h-7 gap-1 px-2 text-[11px] text-rose-700 hover:text-rose-800 dark:text-rose-300"
                                        disabled={isDeciding}
                                        onClick={() => void decideBudgetRequest(r.id, 'rejected')}
                                      >
                                        <X className="h-3 w-3" />
                                        Reject
                                      </Button>
                                    </>
                                  ) : (
                                    <span className="text-[11px] text-zinc-400">
                                      {r.decided_by ? `by ${r.decided_by}` : 'closed'}
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => setHiddenBudgetIds((prev) => new Set(prev).add(r.id))}
                                    title="Remove from this payroll run"
                                    className="text-zinc-400 hover:text-red-500"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot className="border-t-2 border-rose-200/60 bg-rose-50/40 dark:border-rose-800/40 dark:bg-rose-950/30">
                        <tr>
                          <td className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-300" colSpan={6}>
                            Approved total ({approvedBudgetRequestRows.length})
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono font-bold tabular-nums text-zinc-900 dark:text-white">
                            {formatPHP(totalBudgetRequestsPHP)}
                          </td>
                          <td className="px-4 py-2.5" />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
            )}

          </div>
        );
      }
      case 5: {
        // ── Tenure Gifts ───────────────────────────────────────────────────────
        const totalTenureGiftsPHP = tenureGiftRows.reduce(
          (s, r) => s + (Number.isFinite(r.gift_price_php) ? r.gift_price_php : 0),
          0,
        );
        const setTenureStatus = (id: string, status: 'approved' | 'rejected' | 'pending') => {
          setTenureGiftAccountingStatus((prev) => {
            const next = { ...prev };
            if (status === 'pending') delete next[id];
            else next[id] = status;
            return next;
          });
        };
        const approvedCount = tenureGiftRows.filter((r) => tenureGiftAccountingStatus[r.id] === 'approved').length;
        const pendingCount = tenureGiftRows.filter((r) => !tenureGiftAccountingStatus[r.id]).length;
        const approvedTotalPHP = tenureGiftRows
          .filter((r) => tenureGiftAccountingStatus[r.id] === 'approved')
          .reduce((s, r) => s + (Number.isFinite(r.gift_price_php) ? r.gift_price_php : 0), 0);
        const monthLabelTenure = pabMonthRange
          ? `${pabMonthRange.monthName} ${pabMonthRange.year}`
          : 'Active PAB month';
        return (
          <div className="flex min-w-0 flex-col gap-5">
            {/* Header banner */}
            <div className="flex flex-col gap-1 rounded-2xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50 via-white to-teal-50/40 p-5 shadow-sm dark:border-emerald-900/40 dark:from-emerald-950/30 dark:via-zinc-950 dark:to-emerald-950/15">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300">
                <Gift className="h-3.5 w-3.5" /> Tenure Gifts · {monthLabelTenure}
              </div>
              <h2 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-white">
                HR-approved tenure gifts queued for this payroll
              </h2>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                Each gift needs an Accounting <span className="font-mono">approve</span> to reach dispatch. Rejected and pending gifts are skipped at validation.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                <span className="rounded-full border border-emerald-300/70 bg-emerald-50 px-2.5 py-0.5 font-medium text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-200">
                  {approvedCount} of {tenureGiftRows.length} approved · {formatPHP(approvedTotalPHP)}
                </span>
                {pendingCount > 0 && (
                  <span className="rounded-full border border-amber-300/70 bg-amber-50 px-2.5 py-0.5 font-medium text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
                    {pendingCount} pending
                  </span>
                )}
                <span className="text-zinc-500 dark:text-zinc-400">
                  Period total: {formatPHP(totalTenureGiftsPHP)}
                </span>
              </div>
            </div>

            {tenureGiftsLoading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-zinc-500">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-sm">Loading tenure gifts…</span>
              </div>
            ) : tenureGiftsError ? (
              <p className="p-6 text-center text-xs text-rose-600 dark:text-rose-400">
                {tenureGiftsError}
              </p>
            ) : tenureGiftRows.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center text-zinc-500 dark:text-zinc-400">
                <Gift className="h-10 w-10 opacity-25" />
                <p className="text-sm">No tenure gifts approved in this period.</p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-emerald-200/70 ring-1 ring-emerald-500/8 dark:border-emerald-900/50 dark:ring-emerald-400/10">
                <table className="w-full text-sm">
                  <thead className="border-b border-emerald-100 bg-emerald-50/80 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 backdrop-blur dark:border-emerald-900/40 dark:bg-emerald-950/40 dark:text-emerald-300">
                    <tr>
                      <th className="px-4 py-2.5 text-left">Recipient</th>
                      <th className="px-3 py-2.5 text-left">Milestone</th>
                      <th className="px-3 py-2.5 text-left">Gift</th>
                      <th className="px-3 py-2.5 text-left">Approved by</th>
                      <th className="px-3 py-2.5 text-left">Issued</th>
                      <th className="px-3 py-2.5 text-right">Amount</th>
                      <th className="px-3 py-2.5 text-center">Status</th>
                      <th className="px-3 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-emerald-50 bg-white dark:divide-emerald-950/30 dark:bg-zinc-950/40">
                    {tenureGiftRows.map((r) => {
                      const status: 'approved' | 'rejected' | 'pending' =
                        (tenureGiftAccountingStatus[r.id] as 'approved' | 'rejected' | undefined) ?? 'pending';
                      return (
                        <tr key={r.id} className="transition-colors hover:bg-emerald-50/40 dark:hover:bg-emerald-950/15">
                          <td className="px-4 py-3 font-mono text-xs text-zinc-700 dark:text-zinc-300">{r.personal_email}</td>
                          <td className="px-3 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                            {r.milestone_index * 6}-month · #{r.milestone_index}
                          </td>
                          <td className="px-3 py-3 text-sm text-zinc-800 dark:text-zinc-200">{r.gift_name}</td>
                          <td className="px-3 py-3 text-xs text-zinc-600 dark:text-zinc-400">{r.decided_by || '—'}</td>
                          <td className="px-3 py-3 text-xs text-zinc-600 dark:text-zinc-400 tabular-nums">
                            {new Date(r.decided_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                          </td>
                          <td className="px-3 py-3 text-right font-medium text-zinc-900 dark:text-white">
                            {formatPHP(r.gift_price_php)}
                          </td>
                          <td className="px-3 py-3 text-center">
                            <span className={cn(
                              'rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                              status === 'approved'
                                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700/50 dark:bg-emerald-950/30 dark:text-emerald-300'
                                : status === 'rejected'
                                ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-700/50 dark:bg-red-950/30 dark:text-red-300'
                                : 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-300',
                            )}>
                              {status}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex items-center justify-end gap-2">
                              {status !== 'approved' && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 border-emerald-500/40 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
                                  onClick={() => setTenureStatus(r.id, 'approved')}
                                >
                                  Approve
                                </Button>
                              )}
                              {status !== 'rejected' && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 border-red-500/40 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                                  onClick={() => setTenureStatus(r.id, 'rejected')}
                                >
                                  Reject
                                </Button>
                              )}
                              {status !== 'pending' && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-zinc-500"
                                  onClick={() => setTenureStatus(r.id, 'pending')}
                                >
                                  Reset
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="border-t-2 border-emerald-200/60 bg-emerald-50/40 dark:border-emerald-800/40 dark:bg-emerald-950/30">
                    <tr>
                      <td colSpan={5} className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                        Approved total ({approvedCount} of {tenureGiftRows.length})
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                        {formatPHP(approvedTotalPHP)}
                      </td>
                      <td colSpan={2} className="px-3 py-2.5 text-right text-[11px] text-zinc-500 dark:text-zinc-500 tabular-nums">
                        Period total: {formatPHP(totalTenureGiftsPHP)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        );
      }
      case 6: {
        // ── Contractors ────────────────────────────────────────────────────────
        const updateInvoiceStatus = async (id: string, status: 'approved' | 'rejected' | 'pending') => {
          setContractorInvoicesUpdating(id);
          try {
            const res = await fetch(`/api/contractor/invoices/${id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setContractorInvoices((prev) =>
              prev.map((inv) => (inv.id === id ? { ...inv, status } : inv)),
            );
          } catch (err) {
            toast.error('Failed to update invoice', { description: err instanceof Error ? err.message : String(err) });
          } finally {
            setContractorInvoicesUpdating(null);
          }
        };

        const pendingInvoices  = contractorInvoices.filter((i) => i.status === 'pending');
        const approvedInvoices = contractorInvoices.filter((i) => i.status === 'approved');
        const rejectedInvoices = contractorInvoices.filter((i) => i.status === 'rejected');
        const approvedTotal = approvedInvoices.reduce((s, i) => s + (i.total ?? 0), 0);

        const monthLabelContractors = pabMonthRange
          ? `${pabMonthRange.monthName} ${pabMonthRange.year}`
          : 'Active PAB month';
        return (
          <div className="flex min-w-0 flex-col gap-5">
            {/* Header banner */}
            <div className="flex flex-col gap-1 rounded-2xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50 via-white to-teal-50/40 p-5 shadow-sm dark:border-emerald-900/40 dark:from-emerald-950/30 dark:via-zinc-950 dark:to-emerald-950/15">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300">
                <HardHat className="h-3.5 w-3.5" /> Contractors · {monthLabelContractors}
              </div>
              <h2 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-white">
                Contractor invoices queued for this payroll
              </h2>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                Review pending invoices and approve them before dispatch. Rejected and pending invoices are skipped.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                <span className="rounded-full border border-emerald-300/70 bg-emerald-50 px-2.5 py-0.5 font-medium text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-200">
                  {approvedInvoices.length} approved · {formatPHP(approvedTotal)}
                </span>
                {pendingInvoices.length > 0 && (
                  <span className="rounded-full border border-amber-300/70 bg-amber-50 px-2.5 py-0.5 font-medium text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
                    {pendingInvoices.length} pending
                  </span>
                )}
                {rejectedInvoices.length > 0 && (
                  <span className="rounded-full border border-rose-300/70 bg-rose-50 px-2.5 py-0.5 font-medium text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                    {rejectedInvoices.length} rejected
                  </span>
                )}
              </div>
            </div>

            {contractorInvoicesLoading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-zinc-500">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-sm">Loading invoices…</span>
              </div>
            ) : contractorInvoices.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center text-zinc-500 dark:text-zinc-400">
                <HardHat className="h-10 w-10 opacity-25" />
                <p className="text-sm">No contractor invoices have been submitted yet.</p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-emerald-200/70 ring-1 ring-emerald-500/8 dark:border-emerald-900/50 dark:ring-emerald-400/10">
                <table className="w-full text-sm">
                  <thead className="border-b border-emerald-100 bg-emerald-50/80 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 backdrop-blur dark:border-emerald-900/40 dark:bg-emerald-950/40 dark:text-emerald-300">
                    <tr>
                      <th className="px-4 py-2.5 text-left">Contractor</th>
                      <th className="px-3 py-2.5 text-left">Invoice #</th>
                      <th className="px-3 py-2.5 text-left">Date</th>
                      <th className="px-3 py-2.5 text-right">Total</th>
                      <th className="px-3 py-2.5 text-center">Status</th>
                      <th className="px-3 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-emerald-50 bg-white dark:divide-emerald-950/30 dark:bg-zinc-950/40">
                    {contractorInvoices.map((inv) => (
                      <tr key={inv.id} className="transition-colors hover:bg-emerald-50/40 dark:hover:bg-emerald-950/15">
                        <td className="px-4 py-3">
                          <div className="font-medium text-zinc-900 dark:text-white">{inv.from_entity_name || inv.from_name || '—'}</div>
                          <div className="font-mono text-[11px] text-zinc-500">{inv.contractor_email}</div>
                        </td>
                        <td className="px-3 py-3 font-mono text-xs text-zinc-700 dark:text-zinc-300">{inv.invoice_number}</td>
                        <td className="px-3 py-3 text-xs text-zinc-600 dark:text-zinc-400">{inv.invoice_date || '—'}</td>
                        <td className="px-3 py-3 text-right font-medium text-zinc-900 dark:text-white">{formatPHP(inv.total ?? 0)}</td>
                        <td className="px-3 py-3 text-center">
                          <span className={cn(
                            'rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                            inv.status === 'approved'
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700/50 dark:bg-emerald-950/30 dark:text-emerald-300'
                              : inv.status === 'rejected'
                              ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-700/50 dark:bg-red-950/30 dark:text-red-300'
                              : 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-300',
                          )}>
                            {inv.status}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex items-center justify-end gap-2">
                            {inv.status !== 'approved' && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 border-emerald-500/40 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
                                disabled={contractorInvoicesUpdating === inv.id}
                                onClick={() => void updateInvoiceStatus(inv.id, 'approved')}
                              >
                                {contractorInvoicesUpdating === inv.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Approve'}
                              </Button>
                            )}
                            {inv.status !== 'rejected' && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 border-red-500/40 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                                disabled={contractorInvoicesUpdating === inv.id}
                                onClick={() => void updateInvoiceStatus(inv.id, 'rejected')}
                              >
                                {contractorInvoicesUpdating === inv.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Reject'}
                              </Button>
                            )}
                            {inv.status !== 'pending' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 text-zinc-500"
                                disabled={contractorInvoicesUpdating === inv.id}
                                onClick={() => void updateInvoiceStatus(inv.id, 'pending')}
                              >
                                Reset
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {approvedInvoices.length > 0 && (
                    <tfoot className="border-t-2 border-emerald-200/60 bg-emerald-50/40 dark:border-emerald-800/40 dark:bg-emerald-950/30">
                      <tr>
                        <td colSpan={3} className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                          Approved total ({approvedInvoices.length} invoice{approvedInvoices.length !== 1 ? 's' : ''})
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                          {formatPHP(approvedTotal)}
                        </td>
                        <td colSpan={2} />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </div>
        );
      }
      case 7: {
        const finalPayRows = effectiveCalcResults
          .map(r => {
          const rr = ratesByEmail.get(normEmail(r.email) ?? '');
          const mesaDed = ((r.initialPay != null) && rr?.mesa_member) ? 100 : 0;
          return {
            ...r,
            deptKey: employeeDepts[r.email] ?? null,
            deptName: DEPARTMENTS.find(d => d.key === employeeDepts[r.email])?.name ?? '—',
            bonusTotal: getEffectiveBonus(r.email),
            mesaDeduction: mesaDed,
            finalPay: (r.initialPay ?? 0) + getEffectiveBonus(r.email) - mesaDed,
          };
          })
          .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        const grandInitial = finalPayRows.reduce((s, r) => s + (r.initialPay ?? 0), 0);
        const grandBonuses = finalPayRows.reduce((s, r) => s + r.bonusTotal, 0);
        const grandMesaDeductions = finalPayRows.reduce((s, r) => s + (r.mesaDeduction ?? 0), 0);
        const grandFinal   = finalPayRows.reduce((s, r) => s + r.finalPay, 0);
        const unassignedCount = finalPayRows.filter(r => !r.deptKey).length;

        // Non-payroll outflows fetched in step 4 (approved budgets, sent/paid gifts,
        // approved orphanage visit wages). All in PHP — gifts converted at the
        // wizard's active USD→PHP rate.
        const stepOrphanageWagesPHP = (() => {
          const rateByEmail = new Map<string, number>();
          for (const r of effectiveCalcResults) {
            const em = (r.email ?? '').trim().toLowerCase();
            if (!em || r.regularRate == null) continue;
            rateByEmail.set(em, r.regularRate);
          }
          const hoursByEmail = new Map<string, number>();
          for (const row of orphanageRows) {
            if (row.status !== 'accounting_approved' && row.status !== 'approved') continue;
            const em = (row.work_email ?? '').trim().toLowerCase();
            if (!em) continue;
            // Session-only deletes from the Orphanage step.
            if (hiddenVisitIds.has(`${em}|${row.dispute_date}`)) continue;
            if (hiddenWageEmails.has(em)) continue;
            hoursByEmail.set(em, (hoursByEmail.get(em) ?? 0) + (row.override_hours ?? 8));
          }
          let total = 0;
          for (const [em, hrs] of hoursByEmail) {
            const rate = rateByEmail.get(em);
            if (rate != null) total += hrs * rate;
          }
          return total;
        })();
        const approvedStepBudgetRequestRows = budgetRequestRows.filter(
          (r) => r.status === 'approved' && !hiddenBudgetIds.has(r.id),
        );
        const stepBudgetRequestsPHP = approvedStepBudgetRequestRows.reduce((s, r) => {
          const amount = Number(r.final_amount ?? 0);
          return s + (Number.isFinite(amount) ? amount : 0);
        }, 0);
        const stepGiftsPHP =
          giftPaymentRows.reduce(
            (s, r) => s + (Number.isFinite(r.total_usd) ? r.total_usd : 0),
            0,
          ) * usdToPhpRate;
        const stepTenureGiftsPHP = tenureGiftRows
          .filter((r) => tenureGiftAccountingStatus[r.id] === 'approved')
          .reduce(
            (s, r) => s + (Number.isFinite(r.gift_price_php) ? r.gift_price_php : 0),
            0,
          );
        const stepContractorsPHP = contractorInvoices
          .filter((i) => i.status === 'approved')
          .reduce((s, i) => s + (i.total ?? 0), 0);
        const totalWeeklyOutflow =
          grandFinal +
          stepOrphanageWagesPHP +
          stepBudgetRequestsPHP +
          stepGiftsPHP +
          stepTenureGiftsPHP +
          stepContractorsPHP;

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
                  <div className="text-xs text-indigo-600 dark:text-indigo-400">Total Weekly Outflow</div>
                  <div className="mt-1 font-mono text-xl font-bold text-indigo-700 dark:text-indigo-300">
                    {formatPHP(totalWeeklyOutflow)}
                  </div>
                  <div className="mt-1.5 space-y-0.5 text-[10px] text-indigo-700/80 dark:text-indigo-300/80">
                    <div className="flex items-center justify-between gap-2">
                      <span>Payroll (salaries + bonuses)</span>
                      <span className="font-mono tabular-nums">{formatPHP(grandFinal)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span>Orphanage wages</span>
                      <span className="font-mono tabular-nums">{formatPHP(stepOrphanageWagesPHP)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span>Budget requests ({approvedStepBudgetRequestRows.length})</span>
                      <span className="font-mono tabular-nums">{formatPHP(stepBudgetRequestsPHP)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span>Gift payments ({giftPaymentRows.length})</span>
                      <span className="font-mono tabular-nums">{formatPHP(stepGiftsPHP)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span>Tenure gifts ({tenureGiftRows.filter((r) => tenureGiftAccountingStatus[r.id] === 'approved').length} approved)</span>
                      <span className="font-mono tabular-nums">{formatPHP(stepTenureGiftsPHP)}</span>
                    </div>
                    {stepContractorsPHP > 0 && (
                      <div className="flex items-center justify-between gap-2">
                        <span>Contractor invoices ({contractorInvoices.filter(i => i.status === 'approved').length})</span>
                        <span className="font-mono tabular-nums">{formatPHP(stepContractorsPHP)}</span>
                      </div>
                    )}
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
                  {
                    label: `Contractor Invoices Reviewed (${contractorInvoices.filter(i => i.status === 'pending').length} pending)`,
                    pass: contractorInvoices.filter(i => i.status === 'pending').length === 0,
                  },
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
      case 8:
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
                  setPreviewSelectedOrphanageId(null);
                  setPreviewTab('paystubs');
                  setPreviewPaystubsOpen(true);
                }}
              >
                Preview Emails
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
                    setReportSnapshot({
                      startedAt: wizardStartedAt,
                      dispatchedAt: new Date(),
                      employees: dispatchData.rows,
                      budgetRequests: budgetRequestRows.filter(r => r.status === 'approved' && !hiddenBudgetIds.has(r.id)),
                      giftPayments: giftPaymentRows,
                      tenureGifts: tenureGiftRows.filter((r) => tenureGiftAccountingStatus[r.id] === 'approved'),
                      usdToPhpRate,
                    });
                    setReportsTab('salaries');
                    setCurrentStep(9);
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
      case 9: {
        const isDraft = reportSnapshot == null;
        // When dispatch hasn't happened, synthesize a live preview from the same
        // sources the dispatch call would package up. Displayed with a DRAFT
        // watermark — once dispatch fires, the real snapshot replaces it.
        const snap = reportSnapshot ?? {
          startedAt: wizardStartedAt,
          dispatchedAt: new Date(),
          employees: dispatchData.rows,
          budgetRequests: budgetRequestRows.filter(
            (r) => r.status === 'approved' && !hiddenBudgetIds.has(r.id),
          ),
          giftPayments: giftPaymentRows,
          tenureGifts: tenureGiftRows.filter(
            (r) => tenureGiftAccountingStatus[r.id] === 'approved',
          ),
          usdToPhpRate,
        };

        const durationMs = snap.dispatchedAt.getTime() - snap.startedAt.getTime();
        const durationMins = Math.floor(durationMs / 60000);
        const durationSecs = Math.floor((durationMs % 60000) / 1000);
        const durationLabel = durationMins > 0
          ? `${durationMins}m ${durationSecs}s`
          : `${durationSecs}s`;

        const fmt = (d: Date) => d.toLocaleString('en-PH', {
          month: 'short', day: 'numeric', year: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        });

        const totalSalaries = snap.employees.reduce((s, e) => s + (e.pay_php.final ?? 0), 0);
        const totalBudget = snap.budgetRequests.reduce((s, r) => s + Number(r.final_amount ?? 0), 0);
        const totalGifts = snap.giftPayments.reduce((s, g) => s + g.total_usd * snap.usdToPhpRate, 0);
        const totalTenureGifts = snap.tenureGifts.reduce((s, t) => s + (t.gift_price_php ?? 0), 0);

        const tabs = [
          { id: 'salaries' as const, label: 'Salaries / Wages', count: snap.employees.length, total: totalSalaries },
          { id: 'budget' as const, label: 'Orphanage Budget Requests', count: snap.budgetRequests.length, total: totalBudget },
          { id: 'gifts' as const, label: 'Gift Payments', count: snap.giftPayments.length + snap.tenureGifts.length, total: totalGifts + totalTenureGifts },
        ] as const;

        return (
          <div className={cn("relative flex min-w-0 flex-col gap-5", isDraft && "isolate")}>
            {/* Simple Biz logo watermark — visible only in draft mode */}
            {isDraft && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 -z-0 select-none overflow-hidden"
              >
                <div
                  className="absolute inset-0 grid place-items-center opacity-[0.06] dark:opacity-[0.08]"
                  style={{ transform: 'rotate(-22deg) scale(1.4)', transformOrigin: 'center' }}
                >
                  <div className="grid grid-cols-3 gap-x-32 gap-y-24">
                    {Array.from({ length: 12 }).map((_, i) => (
                      <img
                        key={i}
                        src="/simple-logo.png"
                        alt=""
                        className="h-24 w-auto object-contain"
                        draggable={false}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Timestamp banner */}
            <Card className={cn(
              isDraft
                ? "border-amber-300/70 bg-amber-50/60 dark:border-amber-700/40 dark:bg-amber-950/20"
                : "border-indigo-200/60 bg-indigo-50/60 dark:border-indigo-800/30 dark:bg-indigo-950/20",
            )}>
              <CardContent className="flex flex-wrap items-center gap-6 px-5 py-4">
                {isDraft && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/70 bg-amber-100 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em] text-amber-800 dark:border-amber-600/50 dark:bg-amber-950/60 dark:text-amber-200">
                    <Clock className="size-3 shrink-0" />
                    Draft · not yet dispatched
                  </span>
                )}
                <div className={cn("flex items-center gap-2 text-xs", isDraft ? "text-amber-800 dark:text-amber-300" : "text-indigo-700 dark:text-indigo-300")}>
                  <Clock className="size-3.5 shrink-0" />
                  <span className="font-medium">Started</span>
                  <span className="font-mono">{fmt(snap.startedAt)}</span>
                </div>
                {!isDraft && (
                  <>
                    <div className="flex items-center gap-2 text-xs text-indigo-700 dark:text-indigo-300">
                      <Send className="size-3.5 shrink-0" />
                      <span className="font-medium">Dispatched</span>
                      <span className="font-mono">{fmt(snap.dispatchedAt)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
                      <Timer className="size-3.5 shrink-0" />
                      <span className="font-medium">Duration</span>
                      <span className="font-mono font-semibold">{durationLabel}</span>
                    </div>
                  </>
                )}
                <div className={cn("ml-auto flex items-center gap-2 text-xs", isDraft ? "text-amber-700 dark:text-amber-300" : "text-indigo-600 dark:text-indigo-400")}>
                  <span className="font-medium">{isDraft ? 'Projected Outflow' : 'Total Outflow'}</span>
                  <span className="font-mono font-bold text-sm">{formatPHP(totalSalaries + totalBudget + totalGifts + totalTenureGifts)}</span>
                </div>
              </CardContent>
            </Card>

            {/* Sub-tabs */}
            <div className="flex gap-1 rounded-xl border border-zinc-200 bg-zinc-100/80 p-1 dark:border-zinc-800 dark:bg-zinc-900/60">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setReportsTab(t.id)}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-all",
                    reportsTab === t.id
                      ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200",
                  )}
                >
                  <span>{t.label}</span>
                  <span className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                    reportsTab === t.id ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300" : "bg-zinc-200 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400",
                  )}>{t.count}</span>
                  <span className="font-mono text-[10px] opacity-70">{formatPHP(t.total)}</span>
                </button>
              ))}
            </div>

            {/* Export toolbar — CSV download for the active sub-tab */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-zinc-500 dark:text-zinc-500">
                {isDraft
                  ? 'Draft preview · numbers reflect current wizard state.'
                  : `Dispatched ${fmt(snap.dispatchedAt)}.`}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-2 border-emerald-300/70 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700/50 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                onClick={() => {
                  const salariesAoa: (string | number | null)[][] = [
                    ['Employee', 'Email', 'Department', 'Hours', 'Regular', 'OT', 'Bonuses', 'MESA', 'Net Pay'],
                    ...snap.employees.map((e) => [
                      e.name ?? '',
                      e.email,
                      e.department_name ?? '',
                      e.hours.total,
                      e.pay_php.regular ?? null,
                      e.pay_php.ot ?? null,
                      e.pay_php.bonuses_total,
                      e.pay_php.mesa_deduction,
                      e.pay_php.final,
                    ]),
                  ];
                  const budgetAoa: (string | number | null)[][] = [
                    ['Submitter', 'Visit Type', 'Submitted', 'Approved By', 'Approved On', 'Amount (PHP)'],
                    ...snap.budgetRequests.map((r) => [
                      r.submitter_email,
                      r.visit_type,
                      r.submitted_at,
                      r.decided_by ?? '',
                      r.decided_at ?? '',
                      Number(r.final_amount ?? 0),
                    ]),
                  ];
                  const giftsAoa: (string | number | null)[][] = [
                    ['Kind', 'Recipient/Vendor', 'Detail', 'Date', 'Status/Approved By', 'Amount (USD)', 'Amount (PHP)'],
                    ...snap.giftPayments.map((g) => [
                      'vendor',
                      g.vendor_name,
                      `${g.period_label} · ${g.batch_label}`,
                      g.date_sent ?? '',
                      g.status,
                      g.total_usd,
                      g.total_usd * snap.usdToPhpRate,
                    ]),
                    ...snap.tenureGifts.map((t) => [
                      'tenure',
                      t.personal_email,
                      t.gift_name ?? '',
                      t.decided_at,
                      t.decided_by ?? '',
                      null,
                      t.gift_price_php ?? null,
                    ]),
                  ];

                  const wb = XLSX.utils.book_new();
                  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(salariesAoa), 'Salaries');
                  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(budgetAoa), 'Budget Requests');
                  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(giftsAoa), 'Gifts');

                  // Timestamp like "2026-05-14 09-32-18" — filesystem-safe (no colons).
                  const d = snap.startedAt;
                  const pad = (n: number) => String(n).padStart(2, '0');
                  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
                  const filename = `Payroll Wizard - ${isDraft ? 'Draft' : 'Official'} - ${stamp}.xlsx`;
                  XLSX.writeFile(wb, filename);
                  toast.success(`Downloaded ${filename}`);
                }}
              >
                <Download className="size-3.5" />
                Export XLSX{isDraft && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">Draft</span>}
              </Button>
            </div>

            {/* Salaries / Wages */}
            {reportsTab === 'salaries' && (
              <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                <div className="max-h-[520px] overflow-auto">
                  <table className="w-full border-collapse text-[12.5px]">
                    <thead className="sticky top-0 z-10">
                      <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
                        {['Employee', 'Department', 'Hours', 'Regular', 'OT', 'Bonuses', 'MESA', 'Net Pay'].map(h => (
                          <th key={h} className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {snap.employees.map((e, i) => (
                        <tr key={e.email} className={cn("border-b border-zinc-100 last:border-0 dark:border-zinc-800/60", i % 2 === 1 && "bg-zinc-50/50 dark:bg-zinc-900/20")}>
                          <td className="px-3 py-2">
                            <p className="font-medium text-zinc-900 dark:text-zinc-100">{e.name}</p>
                            <p className="text-[10px] font-mono text-zinc-400">{e.email}</p>
                          </td>
                          <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">{e.department_name ?? '—'}</td>
                          <td className="px-3 py-2 font-mono tabular-nums text-zinc-700 dark:text-zinc-300">{e.hours.total.toFixed(2)}</td>
                          <td className="px-3 py-2 font-mono tabular-nums text-zinc-700 dark:text-zinc-300">{e.pay_php.regular != null ? formatPHP(e.pay_php.regular) : '—'}</td>
                          <td className="px-3 py-2 font-mono tabular-nums text-zinc-700 dark:text-zinc-300">{e.pay_php.ot != null ? formatPHP(e.pay_php.ot) : '—'}</td>
                          <td className="px-3 py-2 font-mono tabular-nums text-emerald-700 dark:text-emerald-400">{e.pay_php.bonuses_total > 0 ? `+${formatPHP(e.pay_php.bonuses_total)}` : '—'}</td>
                          <td className="px-3 py-2 font-mono tabular-nums text-rose-600 dark:text-rose-400">{e.pay_php.mesa_deduction > 0 ? `-${formatPHP(e.pay_php.mesa_deduction)}` : '—'}</td>
                          <td className="px-3 py-2 font-mono tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">{formatPHP(e.pay_php.final)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900">
                        <td colSpan={7} className="px-3 py-2.5 text-xs font-semibold text-zinc-600 dark:text-zinc-400">Total ({snap.employees.length} employees)</td>
                        <td className="px-3 py-2.5 font-mono font-bold text-zinc-900 dark:text-zinc-100">{formatPHP(totalSalaries)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            {/* Orphanage Budget Requests */}
            {reportsTab === 'budget' && (
              <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                {snap.budgetRequests.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-12 text-zinc-400">
                    <Heart className="size-8 opacity-40" />
                    <p className="text-sm">No approved budget requests this cycle.</p>
                  </div>
                ) : (
                  <div className="max-h-[520px] overflow-auto">
                    <table className="w-full border-collapse text-[12.5px]">
                      <thead className="sticky top-0 z-10">
                        <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
                          {['Submitter', 'Visit Type', 'Submitted', 'Approved By', 'Approved On', 'Amount'].map(h => (
                            <th key={h} className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {snap.budgetRequests.map((r, i) => (
                          <tr key={r.id} className={cn("border-b border-zinc-100 last:border-0 dark:border-zinc-800/60", i % 2 === 1 && "bg-zinc-50/50 dark:bg-zinc-900/20")}>
                            <td className="px-3 py-2 font-mono text-xs text-zinc-700 dark:text-zinc-300">{r.submitter_email}</td>
                            <td className="px-3 py-2 capitalize text-zinc-600 dark:text-zinc-400">{r.visit_type}</td>
                            <td className="px-3 py-2 font-mono text-xs text-zinc-500">{new Date(r.submitted_at).toLocaleDateString('en-PH')}</td>
                            <td className="px-3 py-2 text-xs text-zinc-500">{r.decided_by ?? '—'}</td>
                            <td className="px-3 py-2 font-mono text-xs text-zinc-500">{r.decided_at ? new Date(r.decided_at).toLocaleDateString('en-PH') : '—'}</td>
                            <td className="px-3 py-2 font-mono font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{formatPHP(Number(r.final_amount ?? 0))}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900">
                          <td colSpan={5} className="px-3 py-2.5 text-xs font-semibold text-zinc-600 dark:text-zinc-400">Total ({snap.budgetRequests.length} requests)</td>
                          <td className="px-3 py-2.5 font-mono font-bold text-zinc-900 dark:text-zinc-100">{formatPHP(totalBudget)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Gift Payments */}
            {reportsTab === 'gifts' && (
              <div className="flex flex-col gap-4">
                {/* Vendor gift payments */}
                <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                  <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
                    <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Vendor Gift Payments</p>
                    <span className="font-mono text-xs text-zinc-500">{formatPHP(totalGifts)}</span>
                  </div>
                  {snap.giftPayments.length === 0 ? (
                    <p className="px-4 py-8 text-center text-sm text-zinc-400">No gift payments this cycle.</p>
                  ) : (
                    <div className="max-h-[360px] overflow-auto">
                      <table className="w-full border-collapse text-[12.5px]">
                        <thead className="sticky top-0 z-10">
                          <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
                            {['Vendor', 'Period', 'Batch', 'Date Sent', 'Status', 'Amount (USD)', 'Amount (PHP)'].map(h => (
                              <th key={h} className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {snap.giftPayments.map((g, i) => (
                            <tr key={g.id} className={cn("border-b border-zinc-100 last:border-0 dark:border-zinc-800/60", i % 2 === 1 && "bg-zinc-50/50 dark:bg-zinc-900/20")}>
                              <td className="px-3 py-2 font-medium text-zinc-800 dark:text-zinc-200">{g.vendor_name}</td>
                              <td className="px-3 py-2 text-zinc-500">{g.period_label}</td>
                              <td className="px-3 py-2 text-zinc-500">{g.batch_label}</td>
                              <td className="px-3 py-2 font-mono text-xs text-zinc-500">{g.date_sent ? new Date(g.date_sent).toLocaleDateString('en-PH') : '—'}</td>
                              <td className="px-3 py-2"><span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold capitalize text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">{g.status}</span></td>
                              <td className="px-3 py-2 font-mono tabular-nums text-zinc-700 dark:text-zinc-300">${g.total_usd.toFixed(2)}</td>
                              <td className="px-3 py-2 font-mono font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{formatPHP(g.total_usd * snap.usdToPhpRate)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Tenure gifts */}
                <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                  <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
                    <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Tenure Gifts</p>
                    <span className="font-mono text-xs text-zinc-500">{formatPHP(totalTenureGifts)}</span>
                  </div>
                  {snap.tenureGifts.length === 0 ? (
                    <p className="px-4 py-8 text-center text-sm text-zinc-400">No tenure gifts this cycle.</p>
                  ) : (
                    <div className="max-h-[360px] overflow-auto">
                      <table className="w-full border-collapse text-[12.5px]">
                        <thead className="sticky top-0 z-10">
                          <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
                            {['Employee', 'Gift', 'Milestone', 'Approved By', 'Approved On', 'Amount'].map(h => (
                              <th key={h} className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {snap.tenureGifts.map((t, i) => (
                            <tr key={t.id} className={cn("border-b border-zinc-100 last:border-0 dark:border-zinc-800/60", i % 2 === 1 && "bg-zinc-50/50 dark:bg-zinc-900/20")}>
                              <td className="px-3 py-2 font-mono text-xs text-zinc-700 dark:text-zinc-300">{t.personal_email}</td>
                              <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">{t.gift_name ?? <span className="italic text-zinc-400">Unknown</span>}</td>
                              <td className="px-3 py-2 text-zinc-500">Year {t.milestone_index + 1} · {new Date(t.milestone_date).toLocaleDateString('en-PH')}</td>
                              <td className="px-3 py-2 text-xs text-zinc-500">{t.decided_by ?? '—'}</td>
                              <td className="px-3 py-2 font-mono text-xs text-zinc-500">{new Date(t.decided_at).toLocaleDateString('en-PH')}</td>
                              <td className="px-3 py-2 font-mono font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{t.gift_price_php != null ? formatPHP(t.gift_price_php) : <span className="italic text-zinc-400 text-xs">—</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Back to start */}
            <div className="flex justify-end pt-2">
              <Button variant="outline" size="sm" onClick={() => setCurrentStep(1)} className="gap-2 text-zinc-600 dark:text-zinc-400">
                <ArrowLeft className="size-3.5" />
                Start New Payroll Run
              </Button>
            </div>
          </div>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-zinc-50 p-2 sm:p-4 md:p-8 dark:bg-zinc-950">
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
            setPreviewSelectedOrphanageId(null);
            setPreviewSearch('');
            setPreviewTab('paystubs');
          }
        }}
      >
        <DialogContent className="overflow-hidden rounded-2xl border-zinc-200 bg-white p-0 sm:max-w-md dark:border-zinc-800 dark:bg-zinc-950">
          {(() => {
            const selectedOrphanage = previewSelectedOrphanageId
              ? orphanagePreviewItems.find((r) => r.id === previewSelectedOrphanageId) ?? null
              : null;
            const selected = previewSelectedEmail
              ? dispatchData.rows.find((e) => e.email === previewSelectedEmail)
              : null;
            if (selectedOrphanage) {
              const o = selectedOrphanage;
              const meta = orphanagePreviewItemMeta(o);
              const fmtPHP = (n: number | null) =>
                n == null ? '—' : '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              const fmtRate = (n: number | null) =>
                n == null ? '—' : n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              const fmtUSD = (n: number) =>
                '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              // "2026-04-01" / "2026-04-01T12:00:00Z" → "April 1, 2026"
              const fmtLongDate = (raw: string | null | undefined): string => {
                if (!raw) return '—';
                const s = String(raw).trim();
                if (!s) return '—';
                const isoOnly = s.length >= 10 ? s.slice(0, 10) : s;
                const d = new Date(`${isoOnly}T00:00:00`);
                if (Number.isNaN(d.getTime())) return s;
                return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
              };
              const monthLabel = pabMonthRange
                ? `${pabMonthRange.monthName} ${pabMonthRange.year}`
                : '—';
              const headerEyebrow = (() => {
                switch (o.kind) {
                  case 'visit_wages':    return `Simple HRIS · Orphanage Visit Receipt · ${monthLabel}`;
                  case 'budget_request': return `Simple HRIS · Orphanage Budget Receipt · ${monthLabel}`;
                  case 'gift_payment':   return `Simple HRIS · Orphanage Gift Payment Receipt · ${monthLabel}`;
                  case 'tenure_gift':    return `Simple HRIS · Orphanage Tenure Gift Receipt · ${monthLabel}`;
                }
              })();
              const headerGreeting = (() => {
                switch (o.kind) {
                  case 'visit_wages':    return `Hi ${o.name},`;
                  case 'budget_request': return `Hi ${o.submitterEmail},`;
                  case 'gift_payment':   return `Hi ${o.vendorName || 'Vendor'},`;
                  case 'tenure_gift':    return `Hi ${o.personalEmail},`;
                }
              })();
              const headerSubline = (() => {
                switch (o.kind) {
                  case 'visit_wages':
                    return <>{o.visitCount} approved visit{o.visitCount === 1 ? '' : 's'} · <strong>{o.totalHours.toFixed(1)}h</strong> credited</>;
                  case 'budget_request':
                    return <>{o.visitType}{o.missionTrip ? ' · mission trip' : ''}</>;
                  case 'gift_payment':
                    return <>Batch: <strong>{o.batchLabel || '—'}</strong></>;
                  case 'tenure_gift':
                    return <>Milestone <strong>#{o.milestoneIndex}</strong> · {fmtLongDate(o.milestoneDate)}</>;
                }
              })();
              return (
                <>
                  <DialogHeader className="sr-only">
                    <DialogTitle>{meta.typeLabel} · {meta.title}</DialogTitle>
                    <DialogDescription>{meta.subtitle}</DialogDescription>
                  </DialogHeader>
                  <div className="paystub-body relative flex flex-col bg-white">
                    <style>{`
                      .paystub-body::before {
                        content: "";
                        position: absolute;
                        top: 110px; left: 0; right: 0; bottom: 70px;
                        overflow: hidden;
                        background-image:
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png');
                        background-repeat: no-repeat;
                        background-size:
                          120px, 120px, 120px, 120px,
                          70px, 70px, 70px, 70px,
                          40px, 40px, 40px, 40px;
                        background-position:
                          10% 8%, 75% 22%, 25% 55%, 85% 78%,
                          50% 12%, 12% 38%, 65% 48%, 38% 85%,
                          90% 10%, 5% 72%, 55% 30%, 92% 55%;
                        transform: rotate(-28deg);
                        opacity: 0.08;
                        pointer-events: none;
                        z-index: 2;
                      }
                    `}</style>
                    <div className="flex shrink-0 items-center justify-between border-b border-zinc-100 bg-white/80 px-4 py-2 backdrop-blur">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-zinc-700"
                        onClick={() => setPreviewSelectedOrphanageId(null)}
                      >
                        ← Back
                      </Button>
                      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-orange-700">
                        Preview · Not yet sent
                      </span>
                    </div>
                    <div
                      className="min-h-0 flex-1 overflow-auto"
                      style={{
                        background:
                          'linear-gradient(to top right, #c7d2fe 0%, #ffffff 50%, #ffedd5 100%)',
                      }}
                    >
                      <div className="px-4 py-4 sm:px-6">
                        <div
                          className="mx-auto max-w-[480px] overflow-hidden rounded-xl bg-white"
                          style={{ boxShadow: '0 4px 20px rgba(59,130,246,0.15)' }}
                        >
                          {/* Header */}
                          <div
                            className="px-7 py-6 text-center"
                            style={{
                              background:
                                'linear-gradient(to top right, #4338ca 0%, #ffffff 50%, #f97316 100%)',
                            }}
                          >
                            <div className="text-[11px] font-bold uppercase tracking-[0.15em] text-slate-800">
                              {headerEyebrow}
                            </div>
                            <div className="mt-2 text-xl font-bold tracking-tight text-slate-900">
                              {headerGreeting}
                            </div>
                            <div className="mt-1 text-[12px] text-slate-700">
                              {headerSubline}
                            </div>
                          </div>

                          {/* Type-specific receipt body */}
                          {o.kind === 'visit_wages' && (
                            <>
                              <div className="px-6 pt-4">
                                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-orange-600">Recipient</div>
                                <div className="mt-1.5 h-[3px] w-[60px] rounded-sm" style={{ background: 'linear-gradient(to top right, #4338ca 0%, #ffffff 50%, #f97316 100%)' }} />
                              </div>
                              <div className="px-6 pt-2">
                                <div className="rounded-lg border px-4 py-3" style={{ background: 'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)', borderColor: '#fde4cb' }}>
                                  <table className="w-full border-collapse"><tbody>
                                    <tr><td className="w-[110px] py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Name</td><td className="py-[3px] text-[13px] font-semibold text-zinc-900">{o.name}</td></tr>
                                    <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Work Email</td><td className="py-[3px] text-[13px] font-mono font-semibold text-blue-600">{o.email}</td></tr>
                                    <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>PAB Period</td><td className="py-[3px] text-[13px] text-zinc-900">{monthLabel}</td></tr>
                                  </tbody></table>
                                </div>
                              </div>

                              <div className="px-6 pt-4">
                                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-orange-600">Approved Visits</div>
                                <div className="mt-1.5 h-[3px] w-[60px] rounded-sm" style={{ background: 'linear-gradient(to top right, #4338ca 0%, #ffffff 50%, #f97316 100%)' }} />
                              </div>
                              <div className="px-6 pt-2">
                                <div className="rounded-lg border px-4 py-3" style={{ background: 'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)', borderColor: '#fde4cb' }}>
                                  <table className="w-full border-collapse"><tbody>
                                    {o.visits.length === 0 ? (
                                      <tr><td className="py-[3px] text-[12px] italic" style={{ color: '#9a6b3f' }}>No approved visits.</td></tr>
                                    ) : (
                                      o.visits.map((v, i) => (
                                        <tr key={i}>
                                          <td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>{fmtLongDate(v.date)}</td>
                                          <td className="py-[3px] text-right text-[13px] font-bold" style={{ color: '#2563eb' }}>{v.hours.toFixed(1)}h × ₱{fmtRate(o.regularRate)}</td>
                                        </tr>
                                      ))
                                    )}
                                  </tbody></table>
                                </div>
                              </div>

                              <div className="px-6 pt-4">
                                <div className="text-[11px] font-bold uppercase tracking-[0.12em]" style={{ color: '#7c3aed' }}>Wage Breakdown</div>
                                <div className="mt-1.5 h-[3px] w-[60px] rounded-sm" style={{ background: 'linear-gradient(to top right, #4338ca 0%, #ffffff 50%, #f97316 100%)' }} />
                              </div>
                              <div className="px-6 pt-2">
                                <div className="rounded-lg border px-4 py-3" style={{ background: 'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)', borderColor: '#fde4cb' }}>
                                  <table className="w-full border-collapse"><tbody>
                                    <tr><td className="w-[150px] py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Visits</td><td className="py-[3px] text-right text-[13px] font-semibold text-zinc-900">{o.visitCount}</td></tr>
                                    <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Total Hours</td><td className="py-[3px] text-right text-[13px] font-semibold text-zinc-900">{o.totalHours.toFixed(1)}h</td></tr>
                                    <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Regular Rate</td><td className="py-[3px] text-right text-[13px] font-semibold text-zinc-900">{o.regularRate != null ? `₱${fmtRate(o.regularRate)} / h` : '—'}</td></tr>
                                  </tbody></table>
                                </div>
                              </div>

                              <div className="px-6 pt-4 pb-2">
                                <div className="rounded-[10px] px-5 py-4" style={{ background: 'linear-gradient(to top right, #3730a3 0%, #ffffff 50%, #ea580c 100%)' }}>
                                  <div className="flex items-center justify-between">
                                    <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-800">Total Wages</span>
                                    <span className="text-[22px] font-extrabold tracking-tight text-slate-900">{fmtPHP(o.wages)} <span className="text-[12px] font-semibold text-slate-600">PHP</span></span>
                                  </div>
                                  {o.wages == null && (
                                    <div className="mt-1 text-right text-[10px] text-slate-700">Rate not on file — wages will resolve once the Rates CSV includes this employee.</div>
                                  )}
                                </div>
                              </div>
                            </>
                          )}

                          {o.kind === 'budget_request' && (
                            <>
                              <div className="px-6 pt-4">
                                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-orange-600">Submitter</div>
                                <div className="mt-1.5 h-[3px] w-[60px] rounded-sm" style={{ background: 'linear-gradient(to top right, #4338ca 0%, #ffffff 50%, #f97316 100%)' }} />
                              </div>
                              <div className="px-6 pt-2">
                                <div className="rounded-lg border px-4 py-3" style={{ background: 'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)', borderColor: '#fde4cb' }}>
                                  <table className="w-full border-collapse"><tbody>
                                    <tr><td className="w-[130px] py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Email</td><td className="py-[3px] text-[13px] font-mono font-semibold text-blue-600">{o.submitterEmail}</td></tr>
                                    <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Visit Type</td><td className="py-[3px] text-[13px] font-semibold text-zinc-900">{o.visitType}{o.missionTrip ? ' (mission trip)' : ''}</td></tr>
                                    <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Submitted</td><td className="py-[3px] text-[13px] text-zinc-900">{fmtLongDate(o.submittedAt)}</td></tr>
                                    {o.decidedAt && <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Approved</td><td className="py-[3px] text-[13px] text-zinc-900">{fmtLongDate(o.decidedAt)}{o.decidedBy ? ` · ${o.decidedBy}` : ''}</td></tr>}
                                  </tbody></table>
                                </div>
                              </div>

                              <div className="px-6 pt-4">
                                <div className="text-[11px] font-bold uppercase tracking-[0.12em]" style={{ color: '#7c3aed' }}>Budget Breakdown</div>
                                <div className="mt-1.5 h-[3px] w-[60px] rounded-sm" style={{ background: 'linear-gradient(to top right, #4338ca 0%, #ffffff 50%, #f97316 100%)' }} />
                              </div>
                              <div className="px-6 pt-2">
                                <div className="rounded-lg border px-4 py-3" style={{ background: 'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)', borderColor: '#fde4cb' }}>
                                  <table className="w-full border-collapse"><tbody>
                                    <tr><td className="w-[150px] py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Subtotal</td><td className="py-[3px] text-right text-[13px] font-semibold text-zinc-900">{fmtPHP(o.subtotal)}</td></tr>
                                    <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Leftover Carry-in</td><td className="py-[3px] text-right text-[13px] font-semibold text-zinc-900">{fmtPHP(o.leftover)}</td></tr>
                                  </tbody></table>
                                </div>
                              </div>

                              <div className="px-6 pt-4 pb-2">
                                <div className="rounded-[10px] px-5 py-4" style={{ background: 'linear-gradient(to top right, #3730a3 0%, #ffffff 50%, #ea580c 100%)' }}>
                                  <div className="flex items-center justify-between">
                                    <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-800">Final Amount</span>
                                    <span className="text-[22px] font-extrabold tracking-tight text-slate-900">{fmtPHP(o.finalAmount)} <span className="text-[12px] font-semibold text-slate-600">PHP</span></span>
                                  </div>
                                </div>
                              </div>
                            </>
                          )}

                          {o.kind === 'gift_payment' && (
                            <>
                              <div className="px-6 pt-4">
                                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-orange-600">Vendor</div>
                                <div className="mt-1.5 h-[3px] w-[60px] rounded-sm" style={{ background: 'linear-gradient(to top right, #4338ca 0%, #ffffff 50%, #f97316 100%)' }} />
                              </div>
                              <div className="px-6 pt-2">
                                <div className="rounded-lg border px-4 py-3" style={{ background: 'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)', borderColor: '#fde4cb' }}>
                                  <table className="w-full border-collapse"><tbody>
                                    <tr><td className="w-[110px] py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Name</td><td className="py-[3px] text-[13px] font-semibold text-zinc-900">{o.vendorName || '—'}</td></tr>
                                    <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Period</td><td className="py-[3px] text-[13px] text-zinc-900">{o.periodLabel || '—'}</td></tr>
                                    <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Batch</td><td className="py-[3px] text-[13px] text-zinc-900">{o.batchLabel || '—'}</td></tr>
                                    <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Status</td><td className="py-[3px] text-[13px] text-zinc-900 capitalize">{o.status}</td></tr>
                                    {o.dateSent && <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Date Sent</td><td className="py-[3px] text-[13px] text-zinc-900">{fmtLongDate(o.dateSent)}</td></tr>}
                                  </tbody></table>
                                </div>
                              </div>

                              <div className="px-6 pt-4">
                                <div className="text-[11px] font-bold uppercase tracking-[0.12em]" style={{ color: '#7c3aed' }}>Conversion</div>
                                <div className="mt-1.5 h-[3px] w-[60px] rounded-sm" style={{ background: 'linear-gradient(to top right, #4338ca 0%, #ffffff 50%, #f97316 100%)' }} />
                              </div>
                              <div className="px-6 pt-2">
                                <div className="rounded-lg border px-4 py-3" style={{ background: 'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)', borderColor: '#fde4cb' }}>
                                  <table className="w-full border-collapse"><tbody>
                                    <tr><td className="w-[150px] py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Amount (USD)</td><td className="py-[3px] text-right text-[13px] font-bold" style={{ color: '#2563eb' }}>{fmtUSD(o.totalUSD)}</td></tr>
                                    <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>USD → PHP rate</td><td className="py-[3px] text-right text-[13px] text-zinc-900">₱{fmtRate(usdToPhpRate)}</td></tr>
                                  </tbody></table>
                                </div>
                              </div>

                              <div className="px-6 pt-4 pb-2">
                                <div className="rounded-[10px] px-5 py-4" style={{ background: 'linear-gradient(to top right, #3730a3 0%, #ffffff 50%, #ea580c 100%)' }}>
                                  <div className="flex items-center justify-between">
                                    <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-800">Total Paid</span>
                                    <span className="text-[22px] font-extrabold tracking-tight text-slate-900">{fmtPHP(o.totalPHP)} <span className="text-[12px] font-semibold text-slate-600">PHP</span></span>
                                  </div>
                                </div>
                              </div>
                            </>
                          )}

                          {o.kind === 'tenure_gift' && (
                            <>
                              <div className="px-6 pt-4">
                                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-orange-600">Recipient</div>
                                <div className="mt-1.5 h-[3px] w-[60px] rounded-sm" style={{ background: 'linear-gradient(to top right, #4338ca 0%, #ffffff 50%, #f97316 100%)' }} />
                              </div>
                              <div className="px-6 pt-2">
                                <div className="rounded-lg border px-4 py-3" style={{ background: 'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)', borderColor: '#fde4cb' }}>
                                  <table className="w-full border-collapse"><tbody>
                                    <tr><td className="w-[130px] py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Personal Email</td><td className="py-[3px] text-[13px] font-mono font-semibold text-blue-600">{o.personalEmail}</td></tr>
                                    <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Milestone</td><td className="py-[3px] text-[13px] font-semibold text-zinc-900">#{o.milestoneIndex}</td></tr>
                                    <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Milestone Date</td><td className="py-[3px] text-[13px] text-zinc-900">{fmtLongDate(o.milestoneDate)}</td></tr>
                                    <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Approved</td><td className="py-[3px] text-[13px] text-zinc-900">{fmtLongDate(o.decidedAt)}{o.decidedBy ? ` · ${o.decidedBy}` : ''}</td></tr>
                                  </tbody></table>
                                </div>
                              </div>

                              <div className="px-6 pt-4">
                                <div className="text-[11px] font-bold uppercase tracking-[0.12em]" style={{ color: '#7c3aed' }}>Gift</div>
                                <div className="mt-1.5 h-[3px] w-[60px] rounded-sm" style={{ background: 'linear-gradient(to top right, #4338ca 0%, #ffffff 50%, #f97316 100%)' }} />
                              </div>
                              <div className="px-6 pt-2">
                                <div className="rounded-lg border px-4 py-3" style={{ background: 'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)', borderColor: '#fde4cb' }}>
                                  <table className="w-full border-collapse"><tbody>
                                    <tr><td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>{o.giftName || `Milestone #${o.milestoneIndex} gift`}</td><td className="py-[3px] text-right text-[13px] font-bold" style={{ color: '#2563eb' }}>{fmtPHP(o.pricePHP)}</td></tr>
                                  </tbody></table>
                                </div>
                              </div>

                              <div className="px-6 pt-4 pb-2">
                                <div className="rounded-[10px] px-5 py-4" style={{ background: 'linear-gradient(to top right, #3730a3 0%, #ffffff 50%, #ea580c 100%)' }}>
                                  <div className="flex items-center justify-between">
                                    <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-800">Gift Value</span>
                                    <span className="text-[22px] font-extrabold tracking-tight text-slate-900">{fmtPHP(o.pricePHP)} <span className="text-[12px] font-semibold text-slate-600">PHP</span></span>
                                  </div>
                                </div>
                              </div>
                            </>
                          )}

                          {/* Footer */}
                          <div
                            className="px-6 py-3.5"
                            style={{
                              background:
                                'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)',
                            }}
                          >
                            <div className="flex items-center justify-between">
                              <img
                                src="https://host.simple.biz/email/simplelogo.png"
                                alt="Simple"
                                className="block h-auto w-[42px]"
                              />
                              <div className="pl-3 text-right">
                                <div className="text-[12px] font-bold text-slate-800">Simple · Confidential</div>
                                <div className="text-[10px] text-slate-400">Automated dispatch from Simple HRIS</div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              );
            }
            if (selected) {
              const pp = selected.pay_php;
              const fmt = (n: number | null) =>
                n == null ? '—' : '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              const fmtRate = (n: number | null) =>
                n == null ? '—' : n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              const weekHuman = (() => {
                const w = selected.pay_period.week;
                if (!w) return '—';
                const s = new Date(w.start + 'T00:00:00');
                const e = new Date(w.end + 'T00:00:00');
                if (isNaN(s.getTime()) || isNaN(e.getTime())) return `${w.start} → ${w.end}`;
                const mon = (d: Date) => d.toLocaleString('en-US', { month: 'short' });
                const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
                return sameMonth
                  ? `${mon(s)} ${s.getDate()} – ${e.getDate()}, ${e.getFullYear()}`
                  : `${mon(s)} ${s.getDate()} – ${mon(e)} ${e.getDate()}, ${e.getFullYear()}`;
              })();
              return (
                <>
                  <DialogHeader className="sr-only">
                    <DialogTitle>Paystub Preview · {selected.name}</DialogTitle>
                    <DialogDescription>{selected.personal_email}</DialogDescription>
                  </DialogHeader>
                  <div className="paystub-body relative flex flex-col bg-white">
                    <style>{`
                      .paystub-body::before {
                        content: "";
                        position: absolute;
                        top: 110px; left: 0; right: 0; bottom: 70px;
                        overflow: hidden;
                        background-image:
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png'),
                          url('https://host.simple.biz/email/simplelogo.png');
                        background-repeat: no-repeat;
                        background-size:
                          120px, 120px, 120px, 120px,
                          70px, 70px, 70px, 70px,
                          40px, 40px, 40px, 40px;
                        background-position:
                          10% 8%, 75% 22%, 25% 55%, 85% 78%,
                          50% 12%, 12% 38%, 65% 48%, 38% 85%,
                          90% 10%, 5% 72%, 55% 30%, 92% 55%;
                        transform: rotate(-28deg);
                        opacity: 0.08;
                        pointer-events: none;
                        z-index: 2;
                      }
                    `}</style>
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
                    <div
                      className="min-h-0 flex-1 overflow-hidden"
                      style={{
                        background:
                          'linear-gradient(to top right, #c7d2fe 0%, #ffffff 50%, #ffedd5 100%)',
                      }}
                    >
                      <div className="px-4 py-4 sm:px-6">
                        <div
                          className="mx-auto max-w-[480px] overflow-hidden rounded-xl bg-white"
                          style={{ boxShadow: '0 4px 20px rgba(59,130,246,0.15)' }}
                        >
                          {/* Header */}
                          <div
                            className="px-7 py-6 text-center"
                            style={{
                              background:
                                'linear-gradient(to top right, #4338ca 0%, #ffffff 50%, #f97316 100%)',
                            }}
                          >
                            <div className="text-[11px] font-bold uppercase tracking-[0.15em] text-slate-800">
                              Simple HRIS · Paystub · {weekHuman}
                            </div>
                            <div className="mt-2 text-xl font-bold tracking-tight text-slate-900">
                              Hi {selected.name},
                            </div>
                            <div className="mt-1 text-[12px] text-slate-700">
                              Pay period: <strong>{weekHuman}</strong>
                            </div>
                          </div>

                          {/* Recipient */}
                          <div className="px-6 pt-4">
                            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-orange-600">
                              Recipient
                            </div>
                            <div
                              className="mt-1.5 h-[3px] w-[60px] rounded-sm"
                              style={{
                                background:
                                  'linear-gradient(to top right, #4338ca 0%, #ffffff 50%, #f97316 100%)',
                              }}
                            />
                          </div>
                          <div className="px-6 pt-2">
                            <div
                              className="rounded-lg border px-4 py-3"
                              style={{
                                background:
                                  'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)',
                                borderColor: '#fde4cb',
                              }}
                            >
                              <table className="w-full border-collapse">
                                <tbody>
                                  <tr>
                                    <td className="w-[110px] py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Name</td>
                                    <td className="py-[3px] text-[13px] font-semibold text-zinc-900">{selected.name}</td>
                                  </tr>
                                  <tr>
                                    <td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Department</td>
                                    <td className="py-[3px] text-[13px] font-semibold text-zinc-900">{selected.department_name ?? '—'}</td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          </div>

                          {/* Earnings */}
                          <div className="px-6 pt-4">
                            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-orange-600">
                              Earnings
                            </div>
                            <div
                              className="mt-1.5 h-[3px] w-[60px] rounded-sm"
                              style={{
                                background:
                                  'linear-gradient(to top right, #4338ca 0%, #ffffff 50%, #f97316 100%)',
                              }}
                            />
                          </div>
                          <div className="px-6 pt-2">
                            <div
                              className="rounded-lg border px-4 py-3"
                              style={{
                                background:
                                  'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)',
                                borderColor: '#fde4cb',
                              }}
                            >
                              <table className="w-full border-collapse">
                                <tbody>
                                  <tr>
                                    <td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>
                                      Regular ({selected.hours.regular.toFixed(2)}h × ₱{fmtRate(selected.rates_php.regular)})
                                    </td>
                                    <td className="py-[3px] text-right text-[13px] font-bold" style={{ color: '#2563eb' }}>
                                      {fmt(pp.regular)}
                                    </td>
                                  </tr>
                                  <tr>
                                    <td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>
                                      OT ({selected.hours.ot.toFixed(2)}h × ₱{fmtRate(selected.rates_php.ot)})
                                    </td>
                                    <td className="py-[3px] text-right text-[13px] font-bold" style={{ color: '#2563eb' }}>
                                      {fmt(pp.ot)}
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          </div>

                          {/* Bonuses */}
                          <div className="px-6 pt-4">
                            <div className="text-[11px] font-bold uppercase tracking-[0.12em]" style={{ color: '#7c3aed' }}>
                              Bonuses
                            </div>
                            <div
                              className="mt-1.5 h-[3px] w-[60px] rounded-sm"
                              style={{
                                background:
                                  'linear-gradient(to top right, #4338ca 0%, #ffffff 50%, #f97316 100%)',
                              }}
                            />
                          </div>
                          <div className="px-6 pt-2">
                            <div
                              className="rounded-lg border px-4 py-3"
                              style={{
                                background:
                                  'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)',
                                borderColor: '#fde4cb',
                              }}
                            >
                              <table className="w-full border-collapse">
                                <tbody>
                                  <tr>
                                    <td className="w-[150px] py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Tech Bonus</td>
                                    <td className="py-[3px] text-right text-[13px] font-bold" style={{ color: '#7c3aed' }}>
                                      {fmt(pp.tech_bonus)}
                                    </td>
                                  </tr>
                                  <tr>
                                    <td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Attendance Bonus</td>
                                    <td className="py-[3px] text-right text-[13px] font-bold" style={{ color: '#7c3aed' }}>
                                      {fmt(pp.perfect_attendance_bonus)}
                                    </td>
                                  </tr>
                                  <tr>
                                    <td className="py-[3px] text-[12px]" style={{ color: '#9a6b3f' }}>Performance Bonus</td>
                                    <td className="py-[3px] text-right text-[13px] font-bold" style={{ color: '#7c3aed' }}>
                                      {fmt(pp.other_bonuses)}
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          </div>

                          {/* Total bar */}
                          <div className="px-6 pt-4 pb-2">
                            <div
                              className="rounded-[10px] px-5 py-4"
                              style={{
                                background:
                                  'linear-gradient(to top right, #3730a3 0%, #ffffff 50%, #ea580c 100%)',
                              }}
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-800">
                                  Total Pay
                                </span>
                                <span className="text-[22px] font-extrabold tracking-tight text-slate-900">
                                  {fmt(pp.final)}{' '}
                                  <span className="text-[12px] font-semibold text-slate-600">PHP</span>
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Footer */}
                          <div
                            className="px-6 py-3.5"
                            style={{
                              background:
                                'linear-gradient(to top right, #eff6ff 0%, #ffffff 50%, #fffaf3 100%)',
                            }}
                          >
                            <div className="flex items-center justify-between">
                              <img
                                src="https://host.simple.biz/email/simplelogo.png"
                                alt="Simple"
                                className="block h-auto w-[42px]"
                              />
                              <div className="pl-3 text-right">
                                <div className="text-[12px] font-bold text-slate-800">Simple · Confidential</div>
                                <div className="text-[10px] text-slate-400">Automated dispatch from Simple HRIS</div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              );
            }
            const needle = previewSearch.trim().toLowerCase();
            const filteredPaystubs = needle
              ? dispatchData.rows.filter(
                  (e) =>
                    e.name.toLowerCase().includes(needle) ||
                    e.personal_email.toLowerCase().includes(needle),
                )
              : dispatchData.rows;
            const filteredOrphanage = needle
              ? orphanagePreviewItems.filter((r) => {
                  const meta = orphanagePreviewItemMeta(r);
                  return (
                    meta.title.toLowerCase().includes(needle) ||
                    meta.subtitle.toLowerCase().includes(needle) ||
                    meta.typeLabel.toLowerCase().includes(needle)
                  );
                })
              : orphanagePreviewItems;
            return (
              <>
                <DialogHeader className="px-6 pt-6">
                  <DialogTitle className="text-zinc-900 dark:text-white">Preview Emails</DialogTitle>
                  <DialogDescription className="text-zinc-600 dark:text-zinc-400">
                    {previewTab === 'paystubs'
                      ? `${dispatchData.rows.length} paystub${dispatchData.rows.length === 1 ? '' : 's'} queued for this batch.`
                      : previewTab === 'orphanage'
                      ? `${orphanagePreviewItems.length} orphanage receipt${orphanagePreviewItems.length === 1 ? '' : 's'} queued — visit wages, budget requests, gift payments, tenure gifts.`
                      : `${contractorInvoices.filter(i => i.status === 'approved').length} approved contractor invoice${contractorInvoices.filter(i => i.status === 'approved').length === 1 ? '' : 's'} queued.`}
                    {' '}Click View to inspect the email.
                  </DialogDescription>
                </DialogHeader>
                <div className="px-6 pt-3">
                  <div className="inline-flex w-full rounded-md border border-zinc-200 bg-zinc-100 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
                    <button
                      type="button"
                      onClick={() => setPreviewTab('paystubs')}
                      className={cn(
                        'flex-1 rounded-[5px] px-3 py-1.5 text-xs font-semibold transition',
                        previewTab === 'paystubs'
                          ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-white'
                          : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
                      )}
                    >
                      Paystubs
                      <span className="ml-1.5 rounded bg-zinc-200 px-1 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                        {dispatchData.rows.length}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewTab('orphanage')}
                      className={cn(
                        'flex-1 rounded-[5px] px-3 py-1.5 text-xs font-semibold transition',
                        previewTab === 'orphanage'
                          ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-white'
                          : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
                      )}
                    >
                      Orphanage
                      <span className="ml-1.5 rounded bg-zinc-200 px-1 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                        {orphanagePreviewItems.length}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewTab('contractors')}
                      className={cn(
                        'flex-1 rounded-[5px] px-3 py-1.5 text-xs font-semibold transition',
                        previewTab === 'contractors'
                          ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-white'
                          : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
                      )}
                    >
                      Contractors
                      <span className="ml-1.5 rounded bg-zinc-200 px-1 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                        {contractorInvoices.filter(i => i.status === 'approved').length}
                      </span>
                    </button>
                  </div>
                </div>
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
                  {previewTab === 'paystubs' ? (
                    filteredPaystubs.length === 0 ? (
                      <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                        {dispatchData.rows.length === 0
                          ? 'No employees queued for dispatch.'
                          : `No employees match “${previewSearch}”.`}
                      </div>
                    ) : (
                      <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                        {filteredPaystubs.map((e) => (
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
                    )
                  ) : previewTab === 'contractors' ? (
                    contractorInvoices.filter(i => i.status === 'approved').length === 0 ? (
                      <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                        No approved contractor invoices queued for dispatch.
                      </div>
                    ) : (
                      <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                        {contractorInvoices.filter(i => i.status === 'approved').filter(inv =>
                          !previewSearch.trim() ||
                          [inv.contractor_email, inv.from_entity_name, inv.from_name, inv.invoice_number]
                            .join(' ').toLowerCase().includes(previewSearch.trim().toLowerCase())
                        ).map((inv) => (
                          <div key={inv.id} className="flex items-center justify-between gap-3 py-3">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-zinc-900 dark:text-white">
                                {inv.from_entity_name || inv.from_name || inv.contractor_email}
                              </div>
                              <div className="truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
                                {inv.invoice_number} · {formatPHP(inv.total ?? 0)}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  ) : orphanageLoading || budgetRequestsLoading || giftPaymentsLoading || tenureGiftsLoading ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500 dark:text-zinc-400">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading orphanage receipts…
                    </div>
                  ) : filteredOrphanage.length === 0 ? (
                    <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                      {orphanagePreviewItems.length === 0
                        ? 'No orphanage receipts queued for this PAB period.'
                        : `No receipts match “${previewSearch}”.`}
                    </div>
                  ) : (
                    <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                      {filteredOrphanage.map((r) => {
                        const meta = orphanagePreviewItemMeta(r);
                        const typeAccent = (() => {
                          switch (r.kind) {
                            case 'visit_wages':    return 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-700/50 dark:bg-indigo-950/30 dark:text-indigo-300';
                            case 'budget_request': return 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-300';
                            case 'gift_payment':   return 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700/50 dark:bg-violet-950/30 dark:text-violet-300';
                            case 'tenure_gift':    return 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-300';
                          }
                        })();
                        return (
                          <div key={r.id} className="flex items-center justify-between gap-3 py-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', typeAccent)}>
                                  {meta.typeLabel}
                                </span>
                                <span className="truncate text-sm font-medium text-zinc-900 dark:text-white">
                                  {meta.title}
                                </span>
                              </div>
                              <div className="mt-0.5 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
                                {meta.subtitle}
                                {meta.amount != null ? ` · ${formatPHP(meta.amount)}` : ''}
                              </div>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 shrink-0"
                              onClick={() => setPreviewSelectedOrphanageId(r.id)}
                            >
                              View
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      <div className="mb-3 flex items-start justify-between gap-2 sm:mb-6 md:mb-8">
        <div className="min-w-0">
          <h2 className="text-lg font-bold tracking-tight text-zinc-900 sm:text-xl md:text-2xl dark:text-white">Payroll Wizard</h2>
          <p className="hidden text-xs text-zinc-600 sm:block sm:text-sm dark:text-zinc-500">The &quot;Friday Path&quot; Automated Workflow</p>
          <p className="text-[10px] text-zinc-500 sm:hidden dark:text-zinc-500">
            Step {currentStep} of {steps.length} · {steps.find((s) => s.id === currentStep)?.label}
          </p>
        </div>
        <div className="hidden items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-100 p-1 sm:flex dark:border-zinc-800 dark:bg-zinc-900">
          <Button variant="ghost" size="sm" className="text-xs h-8">History</Button>
          <Button variant="ghost" size="sm" className="text-xs h-8">Templates</Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 flex-1 overflow-hidden min-h-0 md:flex-row md:gap-8">
        {/* Stepper — horizontal scroll-strip on mobile, vertical sidebar on desktop */}
        <div
          className="flex shrink-0 gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:w-64 md:flex-col md:gap-4 md:overflow-y-auto md:overflow-x-visible md:pr-2 md:pb-0"
        >
          {steps.map((step) => (
            <button
              type="button"
              key={step.id}
              onClick={() => setCurrentStep(step.id)}
              className={cn(
                "relative flex shrink-0 items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-all duration-300 md:items-start md:gap-4 md:p-4",
                currentStep === step.id
                  ? "bg-indigo-600/10 border-indigo-600/50 shadow-[0_0_20px_rgba(79,70,229,0.1)]"
                  : currentStep > step.id
                    ? "border-emerald-500/20 bg-emerald-50/80 opacity-70 dark:bg-zinc-900/50"
                    : "border-zinc-200 bg-zinc-100/80 opacity-50 dark:border-zinc-800 dark:bg-zinc-900/30",
              )}
            >
              <div className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors md:h-8 md:w-8",
                currentStep === step.id ? "bg-indigo-600 text-white" :
                currentStep > step.id ? "bg-emerald-500 text-white" : "bg-zinc-300 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-500",
              )}>
                {currentStep > step.id ? <Check className="h-3 w-3 md:h-4 md:w-4" /> : <step.icon className="h-3 w-3 md:h-4 md:w-4" />}
              </div>
              <div className="flex min-w-0 flex-col">
                <span className={cn(
                  "truncate text-[11px] font-bold md:text-sm",
                  currentStep === step.id ? "text-zinc-900 dark:text-white" : "text-zinc-500 dark:text-zinc-400",
                )}>
                  {step.label}
                </span>
                <span className="mt-0.5 hidden truncate text-[10px] leading-tight text-zinc-500 md:block">
                  {step.description}
                </span>
              </div>
              {currentStep === step.id && (
                <motion.div
                  layoutId="active-indicator"
                  className="absolute -bottom-1 left-1/2 h-1 w-6 -translate-x-1/2 rounded-full bg-indigo-600 md:-left-1 md:bottom-auto md:top-1/2 md:h-8 md:w-2 md:-translate-x-0 md:-translate-y-1/2"
                />
              )}
            </button>
          ))}
        </div>

        {/* Main Content Area */}
        <div className="flex flex-1 flex-col overflow-hidden min-h-0 rounded-2xl border border-zinc-200 bg-white/80 dark:border-zinc-800 dark:bg-zinc-900/30">
          <ScrollArea className="flex-1 p-3 sm:p-4 md:p-8 min-h-0">
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

      {/* Accounting dept-level weekly-collections modal */}
      {accountingDeptModalOpen && (() => {
        const acctDm = deptMetrics['accounting'] ?? {};
        const dayBonus = (count: number) =>
          count >= 30 ? 450 : count >= 22 ? 300 : count >= 17 ? 200 : 0;
        const dailyResults = ACCOUNTING_WEEKDAY_METRICS.map(({ key, label }) => {
          const count = acctDm[key] ?? 0;
          return { key, label, count, bonus: dayBonus(count) };
        });
        const totalBonus = dailyResults.reduce((sum, d) => sum + d.bonus, 0);
        const weekSum = dailyResults.reduce((sum, d) => sum + d.count, 0);
        const acctEmployees = calcResults.filter((e) => {
          const dept = employeeDepts[e.email];
          return dept === 'accounting';
        });
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={() => setAccountingDeptModalOpen(false)}
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
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    Applies to all {acctEmployees.length} accounting employee{acctEmployees.length !== 1 ? 's' : ''}
                  </p>
                </div>
                <button
                  onClick={() => setAccountingDeptModalOpen(false)}
                  className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Day inputs */}
              <div className="mb-3 grid grid-cols-5 gap-2">
                {ACCOUNTING_WEEKDAY_METRICS.map(({ key, label }) => (
                  <div key={key} className="flex flex-col items-center gap-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
                      {label}
                    </span>
                    <Input
                      type="number"
                      min={0}
                      value={acctDm[key] && acctDm[key] > 0 ? acctDm[key] : ''}
                      placeholder="0"
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        const n = Number.isFinite(v) && v >= 0 ? v : 0;
                        startRecalc(() => {
                          setDeptMetrics((prev) => ({
                            ...prev,
                            accounting: { ...(prev['accounting'] ?? {}), [key]: n },
                          }));
                        });
                      }}
                      className="h-9 border-violet-200 bg-white text-center font-mono text-sm dark:border-violet-800/50 dark:bg-zinc-900"
                    />
                  </div>
                ))}
              </div>

              {/* Per-day breakdown */}
              <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">Week total collected</span>
                  <span className="font-mono text-sm font-bold text-zinc-900 dark:text-white">{weekSum}</span>
                </div>
                <div className="space-y-1.5">
                  <div className="mb-2 grid grid-cols-4 gap-1 rounded-md bg-zinc-100 px-2 py-1.5 dark:bg-zinc-800/60">
                    {([['≥30', '₱450'], ['22–29', '₱300'], ['17–21', '₱200'], ['<17', '₱0']] as [string, string][]).map(([t, a]) => (
                      <div key={t} className="flex flex-col items-center gap-0.5">
                        <span className="text-[9px] font-semibold text-zinc-500 dark:text-zinc-400">{t}</span>
                        <span className="font-mono text-[10px] font-bold text-zinc-700 dark:text-zinc-300">{a}</span>
                      </div>
                    ))}
                  </div>
                  {dailyResults.map(({ key, label, count, bonus }) => (
                    <div
                      key={key}
                      className={cn(
                        'flex items-center justify-between rounded-md border px-2.5 py-1.5 text-xs',
                        bonus > 0
                          ? 'border-violet-200/60 bg-violet-50/60 dark:border-violet-800/40 dark:bg-violet-950/20'
                          : 'border-zinc-100 bg-white dark:border-zinc-800 dark:bg-zinc-900/30',
                      )}
                    >
                      <span className="w-8 font-semibold text-zinc-700 dark:text-zinc-300">{label}</span>
                      <span className="font-mono text-zinc-600 dark:text-zinc-400">{count} collected</span>
                      <span className={cn('font-mono font-semibold', bonus > 0 ? 'text-violet-600 dark:text-violet-400' : 'text-zinc-400')}>
                        {bonus > 0 ? `₱${bonus}` : '—'}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex items-center justify-between border-t border-zinc-200 pt-2 dark:border-zinc-800">
                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Bonus per employee</span>
                  <span className="font-mono text-base font-bold text-violet-600 dark:text-violet-400">
                    {formatPHP(totalBonus)}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    startRecalc(() => {
                      setDeptMetrics((prev) => {
                        const copy = { ...(prev['accounting'] ?? {}) };
                        for (const { key } of ACCOUNTING_WEEKDAY_METRICS) delete copy[key];
                        return { ...prev, accounting: copy };
                      });
                    });
                  }}
                  className="text-xs"
                >
                  Clear days
                </Button>
                <Button
                  onClick={() => setAccountingDeptModalOpen(false)}
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
        const deptLabel = activeDeptTab === 'devs' ? 'AI/API Team' : 'Edit';
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
                    AI/API Team — {roleLabel}
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

      {/* PAB Calendar modal — full-month view for a single employee */}
      <AnimatePresence>
        {pabCalendarModalEmail && (() => {
          const emp = calcResults.find((e) => e.email === pabCalendarModalEmail);
          const normEmpEmail = normEmail(pabCalendarModalEmail) ?? pabCalendarModalEmail.toLowerCase();
          const paEligible = perfectAttendanceEligible.has(normEmpEmail);
          const paStatus = pabStatusByEmail.get(normEmpEmail) ?? (paEligible ? 'eligible' : 'ineligible');
          const isHsl =
            employeeDepts[pabCalendarModalEmail] === 'hogan_smith_law' ||
            employeeDepts[pabCalendarModalEmail.toLowerCase()] === 'hogan_smith_law';
          const breakdown = isHsl
            ? (employeeAllDaysHours.get(normEmpEmail) ?? [])
            : (employeeWeekdayHours.get(normEmpEmail) ?? []);
          // Map ISO date → breakdown entry so we can look up per-cell data quickly.
          const byIso = new Map<string, { seconds: number; passes: boolean; forgivenByDispute: boolean }>();
          for (const entry of breakdown) {
            const d = parseColDate(entry.col);
            if (!d) continue;
            const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            byIso.set(iso, { seconds: entry.seconds, passes: entry.passes, forgivenByDispute: entry.forgivenByDispute });
          }

          // Helper: return ISO string of the Monday that starts the Mon–Sun week containing `date`.
          const getWeekMondayIso = (date: Date): string => {
            const d = new Date(date);
            const dow = d.getDay(); // Sun=0 … Sat=6
            const daysBack = dow === 0 ? 6 : dow - 1;
            d.setDate(d.getDate() - daysBack);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          };

          // For HSL: extend the effective period end to the Sunday closing the last Mon–Sun week.
          const effectivePabEnd = isHsl && pabMonthRange
            ? (hslAdjustedPabEnd ?? pabMonthRange.end)
            : pabMonthRange?.end;

          // For HSL: precompute per Mon–Sun week reconciliation data so cells can be coloured correctly.
          type HslWeekData = { goodWeekdays: number; satOk: boolean; sunOk: boolean; weekPasses: boolean };
          const hslWeekInfo = new Map<string, HslWeekData>();
          if (isHsl && pabMonthRange && effectivePabEnd) {
            const endT = effectivePabEnd.getTime();
            const wCur = new Date(pabMonthRange.start);
            const wDow = wCur.getDay();
            const wToMon = wDow === 0 ? 1 : wDow === 1 ? 0 : 8 - wDow;
            wCur.setDate(wCur.getDate() + wToMon);
            while (wCur.getTime() <= endT) {
              const weekIso = `${wCur.getFullYear()}-${String(wCur.getMonth() + 1).padStart(2, '0')}-${String(wCur.getDate()).padStart(2, '0')}`;
              let goodWeekdays = 0, satSec = 0, sunSec = 0;
              const tempCur = new Date(wCur);
              for (let d = 0; d < 7; d++) {
                if (tempCur.getTime() > endT) break;
                const dayDow = tempCur.getDay();
                const dayIso = `${tempCur.getFullYear()}-${String(tempCur.getMonth() + 1).padStart(2, '0')}-${String(tempCur.getDate()).padStart(2, '0')}`;
                const dayEntry = byIso.get(dayIso);
                // Forgiven days count as passing (treat as ≥ 7h)
                const sec = dayEntry ? (dayEntry.forgivenByDispute ? 7 * 3600 : dayEntry.seconds) : 0;
                if (dayDow === 6) satSec = sec;
                else if (dayDow === 0) sunSec = sec;
                else if (sec >= 7 * 3600) goodWeekdays++;
                tempCur.setDate(tempCur.getDate() + 1);
                wCur.setDate(wCur.getDate() + 1);
              }
              const satOk = satSec >= 7 * 3600;
              const sunOk = sunSec >= 7 * 3600;
              hslWeekInfo.set(weekIso, {
                goodWeekdays,
                satOk,
                sunOk,
                weekPasses: goodWeekdays + (satOk && sunOk ? 2 : 0) >= 5,
              });
            }
          }

          // Build calendar grid (weeks × 7 days) spanning the PAB period.
          type Cell = { date: Date; iso: string; inRange: boolean; isWeekday: boolean; data: { seconds: number; passes: boolean; forgivenByDispute: boolean } | null };
          const cells: Cell[] = [];
          if (pabMonthRange) {
            // HSL weeks run Mon–Sun; standard weeks run Sun–Sat.
            const gridStart = new Date(pabMonthRange.start);
            if (isHsl) {
              const dow = gridStart.getDay();
              gridStart.setDate(gridStart.getDate() - (dow === 0 ? 6 : dow - 1));
            } else {
              gridStart.setDate(gridStart.getDate() - gridStart.getDay());
            }
            const gridEnd = new Date(pabMonthRange.end);
            if (isHsl) {
              const dow = gridEnd.getDay();
              gridEnd.setDate(gridEnd.getDate() + (dow === 0 ? 0 : 7 - dow));
            } else {
              gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));
            }
            const cursor = new Date(gridStart);
            while (cursor <= gridEnd) {
              const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
              const rangeEnd = effectivePabEnd ?? pabMonthRange.end;
              const inRange = cursor >= pabMonthRange.start && cursor <= rangeEnd;
              const dow = cursor.getDay();
              const isWeekday = dow >= 1 && dow <= 5;
              cells.push({
                date: new Date(cursor),
                iso,
                inRange,
                isWeekday,
                data: byIso.get(iso) ?? null,
              });
              cursor.setDate(cursor.getDate() + 1);
            }
          }

          const totalDays = breakdown.length;
          const passedDays = breakdown.filter((b) => b.passes && !b.forgivenByDispute).length;
          const forgivenDays = breakdown.filter((b) => b.forgivenByDispute).length;
          // For HSL: Sat/Sun are not "failed" and reconciled weekdays are not "failed"
          const failedDays = breakdown.filter((b) => {
            if (b.passes) return false;
            if (isHsl) {
              const d = parseColDate(b.col);
              if (!d) return false;
              const dow = d.getDay();
              if (dow === 0 || dow === 6) return false; // Sat/Sun never count as failed
              const weekData = hslWeekInfo.get(getWeekMondayIso(d));
              if (weekData?.weekPasses) return false; // reconciled
            }
            return true;
          }).length;
          // HSL weeks run Mon–Sun; standard weeks run Sun–Sat
          const WEEKDAY_LABELS = isHsl
            ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
            : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

          // Failed date list — for the "Why Ineligible?" panel.
          const failedDetails = breakdown
            .filter((b) => {
              if (b.passes) return false;
              if (isHsl) {
                const d = parseColDate(b.col);
                if (!d) return false;
                const dow = d.getDay();
                if (dow === 0 || dow === 6) return false;
                const weekData = hslWeekInfo.get(getWeekMondayIso(d));
                if (weekData?.weekPasses) return false;
              }
              return true;
            })
            .map((b) => {
              const d = parseColDate(b.col);
              return {
                date: d,
                iso: d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : b.col,
                seconds: b.seconds,
                shortfallSec: Math.max(0, 7 * 3600 - b.seconds),
              };
            })
            .sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));

          const formatShortfall = (sec: number) => {
            if (sec <= 0) return '0m';
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            if (h > 0 && m > 0) return `${h}h ${m}m`;
            if (h > 0) return `${h}h`;
            return `${m}m`;
          };

          return (
            <motion.div
              key="pab-cal-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
              onClick={() => setPabCalendarModalEmail(null)}
            >
              <motion.div
                key="pab-cal-panel"
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, y: 6 }}
                transition={{ type: 'spring', stiffness: 340, damping: 28, mass: 0.6 }}
                className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header — compact, doesn't scroll */}
                <div className="relative flex items-start justify-between gap-3 border-b border-zinc-200 bg-gradient-to-br from-indigo-50 via-white to-violet-50 px-5 py-3.5 dark:border-zinc-800 dark:from-indigo-950/30 dark:via-zinc-950 dark:to-violet-950/30">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <div className="flex items-center gap-1.5">
                        <CalendarDays className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" />
                        <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">
                          PAB Calendar
                        </h2>
                      </div>
                      <motion.span
                        initial={{ scale: 0.7, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ delay: 0.12, type: 'spring', stiffness: 400, damping: 22 }}
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                          paStatus === 'eligible'
                            ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-400/40 dark:bg-emerald-900/40 dark:text-emerald-300'
                            : paStatus === 'ineligible'
                              ? 'bg-red-100 text-red-700 ring-1 ring-red-400/40 dark:bg-red-900/40 dark:text-red-300'
                              : 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-400/40 dark:bg-indigo-900/40 dark:text-indigo-300',
                        )}
                      >
                        {paStatus === 'eligible' ? '✓ Eligible' : paStatus === 'ineligible' ? '✗ Ineligible' : '⏳ In Progress'}
                      </motion.span>
                    </div>
                    <p className="mt-0.5 truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">
                      {emp?.name || pabCalendarModalEmail}
                    </p>
                    {pabMonthRange && (
                      <p className="truncate text-[10px] text-indigo-700 dark:text-indigo-300">
                        {pabMonthRange.monthName} {pabMonthRange.year}
                        {' · '}
                        {pabMonthRange.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        {' – '}
                        {pabMonthRange.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => setPabCalendarModalEmail(null)}
                    className="shrink-0 rounded-md p-1 text-zinc-400 transition hover:bg-zinc-200/60 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                    aria-label="Close"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {/* Scrollable body */}
                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                  {!pabMonthRange ? (
                    <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-300">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                      <span>PAB period is not available — upload Hubstaff CSVs or set a manual PAB period.</span>
                    </div>
                  ) : (
                    <>
                      {/* No-data diagnostic — shown when the employee is in the roster but Hubstaff has no rows for them */}
                      {breakdown.length === 0 && (
                        <motion.div
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.25 }}
                          className="mb-3 flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200"
                        >
                          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <div className="min-w-0">
                            <div className="font-semibold">No Hubstaff rows for this employee</div>
                            <div className="mt-0.5 text-amber-700/90 dark:text-amber-300/90">
                              {weekdayColumnGroups.length === 0
                                ? `Hubstaff has 0 Mon–Fri columns for this PAB period — upload the ${pabMonthRange.monthName} CSVs in Step 1.`
                                : `Hubstaff covers ${weekdayColumnGroups.length} Mon–Fri in ${pabMonthRange.monthName}, but this employee's work email (${pabCalendarModalEmail}) isn't in any uploaded row. Check the Hubstaff email on their master-list record.`}
                            </div>
                          </div>
                        </motion.div>
                      )}
                      {/* Partial-coverage diagnostic — breakdown exists but < expected weekdays */}
                      {breakdown.length > 0 && weekdayColumnGroups.length < pabExpectedMonFriCount && (
                        <motion.div
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.25 }}
                          className="mb-3 flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200"
                        >
                          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>
                            Partial month — Hubstaff has <strong>{weekdayColumnGroups.length}/{pabExpectedMonFriCount}</strong> Mon–Fri columns for {pabMonthRange.monthName} {pabMonthRange.year}. Missing days show as dashed "No data yet" cells.
                          </span>
                        </motion.div>
                      )}
                      {/* Stats strip */}
                      <motion.div
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.08, duration: 0.25 }}
                        className="mb-3 grid grid-cols-4 gap-1.5"
                      >
                        <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-2 py-1.5 text-center dark:border-emerald-800/50 dark:bg-emerald-950/30">
                          <div className="font-mono text-base font-bold leading-none text-emerald-700 dark:text-emerald-300">{passedDays}</div>
                          <div className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-700/70 dark:text-emerald-400/80">Passed</div>
                        </div>
                        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-2 py-1.5 text-center dark:border-amber-800/50 dark:bg-amber-950/30">
                          <div className="font-mono text-base font-bold leading-none text-amber-700 dark:text-amber-300">{forgivenDays}</div>
                          <div className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700/70 dark:text-amber-400/80">Forgiven</div>
                        </div>
                        <div className="rounded-lg border border-red-200 bg-red-50/70 px-2 py-1.5 text-center dark:border-red-800/50 dark:bg-red-950/30">
                          <div className="font-mono text-base font-bold leading-none text-red-700 dark:text-red-300">{failedDays}</div>
                          <div className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide text-red-700/70 dark:text-red-400/80">Failed</div>
                        </div>
                        <div className="rounded-lg border border-zinc-200 bg-zinc-50/70 px-2 py-1.5 text-center dark:border-zinc-800 dark:bg-zinc-900/40">
                          <div className="font-mono text-base font-bold leading-none text-zinc-700 dark:text-zinc-200">{totalDays}</div>
                          <div className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Tracked</div>
                        </div>
                      </motion.div>

                      {/* Weekday header */}
                      <div className="grid grid-cols-7 gap-1 text-center">
                        {WEEKDAY_LABELS.map((lbl, i) => (
                          <div
                            key={lbl}
                            className={cn(
                              'pb-1 text-[10px] font-semibold uppercase tracking-wide',
                              (isHsl ? i === 5 || i === 6 : i === 0 || i === 6)
                                ? 'text-zinc-400 dark:text-zinc-600'
                                : 'text-zinc-500 dark:text-zinc-400',
                            )}
                          >
                            {lbl}
                          </div>
                        ))}
                      </div>

                      {/* Day cells */}
                      <div className="grid grid-cols-7 gap-1">
                        {cells.map((cell, idx) => {
                          const dim = !cell.inRange;
                          const weekend = !cell.isWeekday;
                          const data = cell.data;
                          // Determine cell state with HSL-specific rules.
                          let state: 'idle' | 'passed' | 'forgiven' | 'reconciled' | 'failed' | 'missing';
                          if (!cell.inRange) {
                            state = 'idle';
                          } else if (data?.forgivenByDispute) {
                            state = 'forgiven';
                          } else if (weekend) {
                            if (isHsl) {
                              // HSL Sat/Sun: green if ≥ 7h, neutral gray if not — NEVER red
                              state = data && data.seconds >= 7 * 3600 ? 'passed' : 'idle';
                            } else {
                              state = 'idle';
                            }
                          } else if (data?.passes) {
                            state = 'passed';
                          } else if (data) {
                            if (isHsl) {
                              // Weekday < 7h: amber "reconciled" if the week passes via Sat+Sun, else red
                              const weekData = hslWeekInfo.get(getWeekMondayIso(cell.date));
                              state = weekData?.weekPasses ? 'reconciled' : 'failed';
                            } else {
                              state = 'failed';
                            }
                          } else {
                            state = 'missing';
                          }
                          const stateClasses: Record<typeof state, string> = {
                            idle: 'bg-zinc-100/70 text-zinc-400 ring-1 ring-zinc-200/70 dark:bg-zinc-900/50 dark:text-zinc-600 dark:ring-zinc-800/60',
                            passed: 'bg-emerald-200 text-emerald-900 ring-1 ring-emerald-500/70 shadow-[0_1px_2px_rgba(16,185,129,0.15)] dark:bg-emerald-600/40 dark:text-emerald-50 dark:ring-emerald-400/50',
                            forgiven: 'bg-amber-200 text-amber-900 ring-1 ring-amber-500/70 shadow-[0_1px_2px_rgba(245,158,11,0.18)] dark:bg-amber-600/40 dark:text-amber-50 dark:ring-amber-400/50',
                            reconciled: 'bg-orange-100 text-orange-900 ring-1 ring-orange-400/60 shadow-[0_1px_2px_rgba(234,88,12,0.10)] dark:bg-orange-700/30 dark:text-orange-50 dark:ring-orange-400/40',
                            failed: 'relative bg-red-200 text-red-900 ring-2 ring-red-500/80 shadow-[0_1px_2px_rgba(239,68,68,0.22)] dark:bg-red-600/40 dark:text-red-50 dark:ring-red-400/70',
                            missing: 'bg-zinc-100 text-zinc-400 border border-dashed border-zinc-300 dark:bg-zinc-900/50 dark:text-zinc-500 dark:border-zinc-700',
                          };
                          const shortfall = data && !data.passes ? Math.max(0, 7 * 3600 - data.seconds) : 0;
                          return (
                            <motion.div
                              key={cell.iso}
                              initial={{ opacity: 0, y: 4, scale: 0.92 }}
                              animate={{ opacity: dim ? 0.3 : 1, y: 0, scale: 1 }}
                              transition={{ delay: 0.04 + idx * 0.008, duration: 0.2, ease: 'easeOut' }}
                              whileHover={dim || state === 'idle' ? undefined : { scale: 1.06, y: -1 }}
                              title={
                                !cell.inRange
                                  ? `${cell.date.toDateString()} — outside PAB period`
                                  : (weekend && !isHsl)
                                    ? `${cell.date.toDateString()} — weekend`
                                    : data
                                      ? `${cell.date.toDateString()} · ${formatSeconds(data.seconds)} logged${
                                          data.forgivenByDispute
                                            ? ' · ★ forgiven by dispute'
                                            : state === 'reconciled'
                                              ? ' · ~ reconciled via Sat+Sun'
                                              : data.passes
                                                ? ' · ✓ passes 7h threshold'
                                                : ` · short by ${formatShortfall(shortfall)}`
                                        }`
                                      : `${cell.date.toDateString()} — no Hubstaff data`
                              }
                              className={cn(
                                'flex h-[46px] cursor-default flex-col items-center justify-center overflow-hidden rounded-md px-0.5 text-center transition-shadow',
                                stateClasses[state],
                              )}
                            >
                              <span className="text-[10px] font-bold leading-none">
                                {cell.date.getDate()}
                              </span>
                              {cell.inRange && (!weekend || isHsl) && data && state !== 'idle' && (
                                <span className="mt-0.5 font-mono text-[9px] leading-none opacity-85">
                                  {formatSeconds(data.seconds)}
                                </span>
                              )}
                              {state === 'passed' && (
                                <span className="mt-0.5 text-[8px] leading-none opacity-80">✓</span>
                              )}
                              {state === 'forgiven' && (
                                <span className="mt-0.5 text-[8px] leading-none opacity-80">★</span>
                              )}
                              {state === 'reconciled' && (
                                <span className="mt-0.5 text-[8px] leading-none opacity-80">~</span>
                              )}
                              {state === 'failed' && (
                                <>
                                  <span className="mt-0.5 font-mono text-[8px] font-bold leading-none text-red-800 dark:text-red-100">
                                    −{formatShortfall(shortfall)}
                                  </span>
                                  <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-red-600 shadow-[0_0_0_2px_rgba(255,255,255,0.95)] dark:bg-red-400 dark:shadow-[0_0_0_2px_rgba(24,24,27,0.85)]" />
                                </>
                              )}
                              {cell.inRange && (!weekend || isHsl) && !data && state !== 'idle' && (
                                <span className="mt-0.5 text-[9px] leading-none opacity-60">—</span>
                              )}
                            </motion.div>
                          );
                        })}
                      </div>

                      {/* Legend */}
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.1 + cells.length * 0.008, duration: 0.25 }}
                        className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-md border border-zinc-200 bg-zinc-50/60 px-2 py-1.5 text-[10px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400"
                      >
                        <span className="flex items-center gap-1">
                          <span className="h-2.5 w-2.5 rounded-sm bg-emerald-200 ring-1 ring-emerald-500/70 dark:bg-emerald-600/40 dark:ring-emerald-400/50" /> ≥ 7h
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="h-2.5 w-2.5 rounded-sm bg-amber-200 ring-1 ring-amber-500/70 dark:bg-amber-600/40 dark:ring-amber-400/50" /> Forgiven ★
                        </span>
                        {isHsl && (
                          <span className="flex items-center gap-1">
                            <span className="h-2.5 w-2.5 rounded-sm bg-orange-100 ring-1 ring-orange-400/60 dark:bg-orange-700/30 dark:ring-orange-400/40" /> Reconciled ~
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <span className="h-2.5 w-2.5 rounded-sm bg-red-200 ring-1 ring-red-500/80 dark:bg-red-600/40 dark:ring-red-400/70" /> &lt; 7h
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="h-2.5 w-2.5 rounded-sm border border-dashed border-zinc-300 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900/50" /> No data yet
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="h-2.5 w-2.5 rounded-sm bg-zinc-100/70 ring-1 ring-zinc-200/70 dark:bg-zinc-900/50 dark:ring-zinc-800/60" />
                          {isHsl ? 'Sat/Sun < 7h / out-of-range' : 'Weekend / out-of-range'}
                        </span>
                      </motion.div>

                      {/* Verdict — clear pass/fail/in-progress explanation */}
                      <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.14 + cells.length * 0.008, duration: 0.3 }}
                        className={cn(
                          'mt-3 rounded-xl border p-3',
                          paStatus === 'eligible'
                            ? 'border-emerald-300/60 bg-emerald-50/80 dark:border-emerald-800/50 dark:bg-emerald-950/30'
                            : paStatus === 'ineligible'
                              ? 'border-red-300/60 bg-red-50/80 dark:border-red-800/50 dark:bg-red-950/30'
                              : 'border-indigo-300/60 bg-indigo-50/80 dark:border-indigo-800/50 dark:bg-indigo-950/30',
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <div
                            className={cn(
                              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold',
                              paStatus === 'eligible'
                                ? 'bg-emerald-500 text-white shadow-[0_0_0_3px_rgba(16,185,129,0.15)]'
                                : paStatus === 'ineligible'
                                  ? 'bg-red-500 text-white shadow-[0_0_0_3px_rgba(239,68,68,0.15)]'
                                  : 'bg-indigo-500 text-white shadow-[0_0_0_3px_rgba(79,70,229,0.18)]',
                            )}
                          >
                            {paStatus === 'eligible' ? '✓' : paStatus === 'ineligible' ? '✗' : '⏳'}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div
                              className={cn(
                                'text-xs font-bold',
                                paStatus === 'eligible'
                                  ? 'text-emerald-800 dark:text-emerald-200'
                                  : paStatus === 'ineligible'
                                    ? 'text-red-800 dark:text-red-200'
                                    : 'text-indigo-800 dark:text-indigo-200',
                              )}
                            >
                              {paStatus === 'eligible'
                                ? 'Eligible for Perfect Attendance Bonus'
                                : paStatus === 'ineligible'
                                  ? (failedDetails.length > 0
                                      ? `Ineligible — ${failedDetails.length} day${failedDetails.length === 1 ? '' : 's'} under the 7-hour threshold`
                                      : 'Ineligible — insufficient data for this period')
                                  : isHsl
                                    ? 'In Progress — PAB period is still running'
                                    : 'In Progress — PAB period is still running'}
                            </div>
                            <div
                              className={cn(
                                'mt-0.5 text-[11px] leading-snug',
                                paStatus === 'eligible'
                                  ? 'text-emerald-700/80 dark:text-emerald-300/80'
                                  : paStatus === 'ineligible'
                                    ? 'text-red-700/80 dark:text-red-300/80'
                                    : 'text-indigo-700/80 dark:text-indigo-300/80',
                              )}
                            >
                              {isHsl
                                ? paStatus === 'eligible'
                                  ? `Logged ≥ 7h on at least 5 of 7 days per week across the PAB period${forgivenDays > 0 ? ` (${forgivenDays} day${forgivenDays === 1 ? '' : 's'} forgiven)` : ''}. Short weekdays are covered when both Sat and Sun reach ≥ 7h.`
                                  : paStatus === 'ineligible'
                                    ? 'HSL rule: every Mon–Sun week needs ≥ 5 days at ≥ 7h. A short weekday can be covered only if BOTH Saturday AND Sunday also reach ≥ 7h.'
                                    : 'No week has failed the 5-of-7 rule yet — verdict locks when the period ends.'
                                : paStatus === 'eligible'
                                  ? `Logged ≥ 7h on every Mon–Fri in the PAB period${forgivenDays > 0 ? ` (${forgivenDays} day${forgivenDays === 1 ? '' : 's'} forgiven by dispute)` : ''}.`
                                  : paStatus === 'ineligible'
                                    ? 'Every Mon–Fri in the PAB period must reach 7 h of logged time (or be forgiven via an approved dispute).'
                                    : 'No past weekdays failed yet — verdict locks once the period ends or the first sub-7h weekday is logged.'}
                            </div>
                          </div>
                        </div>

                        {paStatus === 'ineligible' && failedDetails.length > 0 && (
                          <div className="mt-3 border-t border-red-300/40 pt-2.5 dark:border-red-800/40">
                            <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-red-700 dark:text-red-300">
                              Failed days ({failedDetails.length})
                            </div>
                            <div className="space-y-1">
                              {failedDetails.map((f, i) => (
                                <motion.div
                                  key={f.iso}
                                  initial={{ opacity: 0, x: -4 }}
                                  animate={{ opacity: 1, x: 0 }}
                                  transition={{ delay: 0.2 + cells.length * 0.008 + i * 0.03, duration: 0.2 }}
                                  className="flex items-center justify-between gap-2 rounded-md bg-white/60 px-2 py-1 text-[11px] dark:bg-zinc-950/40"
                                >
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                                    <span className="font-mono text-red-800 dark:text-red-200">
                                      {f.date
                                        ? f.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                                        : f.iso}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    <span className="font-mono text-red-700 dark:text-red-300">
                                      {formatSeconds(f.seconds)}
                                    </span>
                                    <span className="rounded-sm bg-red-200/70 px-1.5 py-0.5 font-mono text-[10px] font-bold text-red-800 dark:bg-red-900/60 dark:text-red-200">
                                      −{formatShortfall(f.shortfallSec)}
                                    </span>
                                  </div>
                                </motion.div>
                              ))}
                            </div>
                          </div>
                        )}
                      </motion.div>
                    </>
                  )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-2 border-t border-zinc-200 bg-zinc-50/60 px-6 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                  <Button
                    onClick={() => setPabCalendarModalEmail(null)}
                    className="h-8 bg-indigo-600 text-xs text-white hover:bg-indigo-700"
                  >
                    Close
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
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
    title: 'AI/API Team — Tickets + Sites',
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
