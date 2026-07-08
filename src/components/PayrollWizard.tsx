"use client";

import React, { useState, useRef, useEffect, useMemo, useTransition, useCallback } from 'react';
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
  LockOpen,
  ArrowRight,
  ArrowLeft,
  Trash2,
  Pencil,
  Loader2,
  DollarSign,
  FileText,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  CalendarDays,
  X,
  Info,
  Users,
  RefreshCw,
  Clock,
  Heart,
  BarChart3,
  Building2,
  Download,
  Timer,
  Play,
  StopCircle,
  HardHat,
  Flag,
  AlertTriangle,
  Plus,
  Sparkles,
  CheckCircle2,
  Search,
  Eye,
  Radio,
  Zap,
  UserX,
} from 'lucide-react';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import { useWizardDispatchLock } from '@/hooks/useWizardDispatchLock';
import { useWizardFollow } from '@/hooks/useWizardFollow';
import { cn } from '@/lib/utils';
import { formatMoney, normalizeCurrency, sumByCurrency, CONTRACTOR_CURRENCIES } from '@/lib/contractor-currency';
import { InvoiceViewDialog, type SavedInvoice } from '@/components/contractor/InvoiceReceiptDialog';
import { KPI_BONUS_ID, DEPARTMENTS, FORMULA_DEPT_KEYS, MANAGER_BONUS_DEPT_KEYS, ACCOUNTING_WEEKDAY_METRICS, calcLeadGenBonus, isDevsDelivery, isDevsChecking, isJeromeRosero, isTeal } from '@/lib/payroll/department-bonus';
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
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import {
  groupDateColumnsByCalendarDay,
  pickPreferredHubstaffColumn,
  getPabMonthRange,
  getCurrentPabMonth,
  filterColumnGroupsByPabRange,
  countMonFriInclusiveInRange,
  resolveCanonicalColumnsToIso,
  payWeekFromUploadStart,
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
import {
  buildCatalogRateIndex,
  resolveEmployeeCatalogRate,
  resolveDeptCatalogRate,
} from '@/lib/payroll/resolve-rate';
import type { PayStructure } from '@/lib/payment-catalog/pay-structure';
import { resolveSystemBonuses, isDeptEligible } from '@/lib/payment-catalog/system-bonus';
import { normEmail } from '@/lib/email/norm-email';
import { TIME_ADJUSTMENT_REASONS, type TimeAdjustmentRow } from '@/lib/supabase/time-adjustments';
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
  OFFICIAL_USD_TO_COP_RATE,
  effectiveUsdToCopRateFromStored,
  copPerPhp,
  phpPerCop,
  type FxRates,
} from '@/lib/fx/currency-fx';
import { logAudit, valuesDiffer } from '@/lib/audit/client-log';
import type { AuditCycleContext } from '@/lib/supabase/audit-log';
import AuditTrailPanel from '@/components/payroll-clerk/AuditTrailPanel';
import TimeAdjustmentReviewPanel from '@/components/payroll/TimeAdjustmentReviewPanel';
import {
  auditEventsToAoa,
  type ClientAuditEvent,
} from '@/lib/audit/client-format';
import { usePabPeriodSettings } from '@/hooks/usePabPeriodSettings';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { isFinalPayrollWeekOfMonth } from '@/lib/payroll/bonus-cadence';
import { parseLocalDateFromIso, resolvePabRangeForMonth, yearMonthKey, PAB_PERIOD_EXCLUSIONS_KEY } from '@/lib/pab-period-settings';
import {
  US_HOLIDAYS_ENABLED_KEY,
  US_HOLIDAYS_LIST_KEY,
  parseUsHolidaysList,
  serializeUsHolidaysList,
  getEnabledHolidayMap,
  computeFederalHolidays,
  type UsHoliday,
} from '@/lib/us-holidays';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { HSL_DEPT_KEYS, HSL_DEPTS } from '@/lib/hsl-bonus/schema';
import WizardCursorOverlay, { type WizardCursorOverlayHandle } from '@/components/payroll/WizardCursorOverlay';

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
    // Fold "fancy" Unicode (math-italic/bold, full-width, etc.) to plain ASCII
    // BEFORE lowercasing — otherwise a hire whose name was saved as styled
    // glyphs (e.g. 𝐾𝑎𝑡ℎ𝑒𝑟𝑖𝑛𝑒) never token-matches a Hubstaff/master row and
    // silently drops out of the payroll run.
    .normalize('NFKC')
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

/** A pasted Orphanage row resolved to an Additions-table employee + PHP amount. */
type OrphanagePasteOk = {
  line: number;
  payWeek: string;
  /** The Additions row's literal `.email` — the key {@link orphanageAmounts} uses. */
  emailKey: string;
  matchedEmail: string;
  name: string;
  hours: number;
  /** Regular hourly rate (PHP). */
  rate: number;
  /** OT hourly rate (PHP), or null when none on file. */
  otRate: number | null;
  /** Split of the pasted hours after stacking on worked hours against the 40h/week cap. */
  regH: number;
  otH: number;
  amount: number;
};
type OrphanagePasteErr = { line: number; email: string; reason: string };
type OrphanagePasteParse = { ok: OrphanagePasteOk[]; errors: OrphanagePasteErr[] };

type PayPeriodPayload = {
  currency: 'PHP';
  hubstaff_source_file: string | null;
  /** Latest weekly pay-period range (ISO dates) derived from the source file or Hubstaff columns. */
  week: { start: string; end: string } | null;
  /** ISO date (YYYY-MM-DD) when this paycheck is dispatched (Tuesday after the pay-period Sunday). */
  salary_date: string | null;
  /** USD→PHP rate (PHP per $1) effective for this cycle — the paystub converts the
   *  PHP total to USD with this "that-week" rate instead of a hardcoded fallback. */
  fx_rate: number;
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
    /** Accounting Adj. column — signed delta, itemized separately from other_bonuses. */
    adjustment: number;
    mesa_deduction: number;
    mesa_disbursement: number;
    orphanage_pay: number;
    final: number;
  };
  /** Free-text reason for the accounting Adj. delta (the Adj. column note), or null. */
  adjustment_note: string | null;
};

/**
 * An employee accounting flagged "do not pay" in the Validation step. Staged to
 * Payment Dispatch as excluded (carrying the full `payload` when a personal
 * email resolved, so they can still be paid + emailed later from the Excluded
 * tab once cleared).
 */
type ExcludedDispatchEntry = {
  email: string;
  personal_email: string | null;
  name: string;
  department_key: string | null;
  amount_php: number | null;
  payload: DispatchEmployee | null;
  reason: 'do_not_pay';
};

function formatPHP(n: number): string {
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** USD-equivalent of a PHP amount at the given rate, e.g. "$1,234.56". Empty
 *  when the rate is unusable. USD is the org's conversion anchor (see currency-fx). */
function formatUsdFromPhp(php: number, usdToPhp: number): string {
  if (!Number.isFinite(php) || !(usdToPhp > 0)) return '';
  return '$' + (php / usdToPhp).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * A PHP money figure stacked above its ≈USD equivalent — the two-line treatment
 * used by the wizard's Initial Pay column. Reused for Total Pay (HSL), Final pay
 * (Additions) and Net Pay (Reports) so every pay total surfaces both currencies.
 * The USD line is omitted only when the rate is unusable.
 */
function PhpWithUsd({
  php,
  usdToPhp,
  phpClassName,
  usdClassName,
  align = 'end',
}: {
  php: number;
  usdToPhp: number;
  phpClassName?: string;
  usdClassName?: string;
  align?: 'start' | 'end';
}) {
  const usd = formatUsdFromPhp(php, usdToPhp);
  return (
    <div className={cn('flex flex-col gap-0.5', align === 'end' ? 'items-end' : 'items-start')}>
      <span className={phpClassName}>{formatPHP(php)}</span>
      {usd && (
        <span className={cn('font-mono text-[10px] font-normal text-blue-500 dark:text-blue-400', usdClassName)}>
          ≈&nbsp;{usd}
        </span>
      )}
    </div>
  );
}

function parseRateField(v: string | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/,/g, '');
  if (s === '') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}



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


const steps = [
  {
    id: 1,
    label: 'Initialize Payroll Data',
    icon: Upload,
    description: 'Global master list + Hubstaff weekly → Supabase',
  },
  { id: 2, label: 'Initial Calculation', icon: DollarSign, description: 'Hubstaff hours × employee_hourly_rates → Initial Pay' },
  { id: 3, label: 'Orphanage', icon: Heart, description: 'Approved orphanage visits and the hours/wages they cover' },
  { id: 4, label: 'HSL', icon: Building2, description: 'Hogan Smith Law — initial pay, KPI bonuses, and accounting overrides' },
  { id: 5, label: 'Additions', icon: Calculator, description: 'Apply bonuses and adjustments' },
  { id: 6, label: 'Contractors', icon: HardHat, description: 'Pending contractor invoices — review and approve before dispatch' },
  { id: 7, label: 'Validation', icon: ShieldCheck, description: 'Pre-flight check and final review' },
  { id: 8, label: 'Dispatch', icon: Send, description: 'Trigger paystubs and payments' },
  { id: 9, label: 'Reports', icon: BarChart3, description: 'Dispatch summary — salaries, budget requests, and gift payments' },
];

export default function PayrollWizard({
  sessionEmail,
  sessionRole,
  initialData,
}: {
  sessionEmail?: string | null;
  sessionRole?: string | null;
  initialData?: import('@/lib/accounting/prefetch').InitialAccountingData | null;
}) {
  const [currentStep, setCurrentStep] = useState(1);
  const [wizardStartedAt] = useState<Date>(() => new Date());
  const [reportSnapshot, setReportSnapshot] = useState<{
    startedAt: Date;
    dispatchedAt: Date;
    employees: DispatchEmployee[];
    usdToPhpRate: number;
  } | null>(null);
  const [reportsTab, setReportsTab] = useState<'salaries'>('salaries');
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
  const wizardContainerRef = useRef<HTMLDivElement>(null);
  const cursorOverlayRef = useRef<WizardCursorOverlayHandle>(null);
  const [togglingLock, setTogglingLock] = useState(false);
  const [confirmingLockToggle, setConfirmingLockToggle] = useState(false);

  // ── Collaborative "oversee" / follow mode ─────────────────────────────────
  // When processing is started, the operator who toggled it is the "driver".
  // Everyone else viewing the wizard follows along in a read-only, third-person
  // view that mirrors the driver's active step — so the accounting head can
  // watch how the operator works. You are never a spectator of your own lock.
  // localDriver: optimistic override set when a lock_acquired broadcast arrives,
  // before Postgres Realtime confirms lockState.lockedBy (~400ms later).
  const [localDriver, setLocalDriver] = useState<string | null>(null);
  // Clear the override once Realtime has confirmed the real value.
  useEffect(() => {
    if (lockState.lockedBy) setLocalDriver(null);
  }, [lockState.lockedBy]);

  const driverEmail = lockState.lockedBy ?? localDriver ?? null;
  const selfKey = (sessionEmail ?? '').trim().toLowerCase();
  const driverKey = (driverEmail ?? '').trim().toLowerCase();
  const isLockDriver =
    lockState.locked && !!driverKey && !!selfKey && driverKey === selfKey;
  const canSpectate =
    (lockState.locked || !!localDriver) && !!driverKey && !!selfKey && driverKey !== selfKey;
  // Local opt-out so an overseer can drop follow mode and click around freely.
  const [observing, setObserving] = useState(true);
  // Reset the opt-out each time a new processing session starts (or ends).
  useEffect(() => {
    setObserving(true);
  }, [driverEmail, lockState.locked]);
  const isSpectator = canSpectate && observing;
  const driverLabel = driverEmail ? driverEmail.split('@')[0] : 'operator';

  const { broadcastLockAcquired } = useWizardFollow({
    selfEmail: sessionEmail,
    driverEmail,
    isDriver: isLockDriver,
    isSpectator,
    currentStep,
    onRemoteStep: setCurrentStep,
    onLockAcquired: (email, step) => {
      setLocalDriver(email);
      setCurrentStep(step);
    },
  });

  // While spectating, forward wheel scrolling to the step's ScrollArea viewport
  // so the read-only overlay (which swallows clicks) doesn't trap the page.
  const handleSpectatorWheel = useCallback((e: React.WheelEvent) => {
    const viewport = wizardContainerRef.current?.querySelector(
      '[data-slot="scroll-area-viewport"]',
    ) as HTMLElement | null;
    if (viewport) viewport.scrollTop += e.deltaY;
  }, []);
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
  const [hslSearch, setHslSearch] = useState('');
  const [hslPage, setHslPage] = useState(1);
  const HSL_PAGE_SIZE = 50;
  const [approveUploadDialogOpen, setApproveUploadDialogOpen] = useState(false);
  const [previewPaystubsOpen, setPreviewPaystubsOpen] = useState(false);
  const [previewSelectedEmail, setPreviewSelectedEmail] = useState<string | null>(null);
  const [previewSearch, setPreviewSearch] = useState('');
  const [previewTab, setPreviewTab] = useState<'paystubs' | 'contractors'>('paystubs');
  const [previewPage, setPreviewPage] = useState(1);
  // Reset pagination whenever the active tab or search query changes so the
  // user always lands back on the first page of the new result set.
  useEffect(() => {
    setPreviewPage(1);
  }, [previewTab, previewSearch]);
  const [isDispatching, setIsDispatching] = useState(false);
  /**
   * Work emails (lowercased) accounting flagged "do not pay" in the Validation
   * step. Dropped from the payable dispatch set and staged to Payment Dispatch
   * as excluded so they surface in the Excluded tab for later reconciliation.
   * Persisted per pay-period under `payroll.wizard.exclusions.<sourceFile>`.
   */
  const [excludedEmails, setExcludedEmails] = useState<Set<string>>(new Set());
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

  /** Human-readable pay-period label parsed from a Hubstaff filename's date range.
   *  Falls back to the raw filename when the range can't be parsed. */
  const formatPeriodLabel = React.useCallback((file: string | null | undefined): string => {
    if (!file) return '—';
    const r = parseDateRangeFromFilename(file);
    if (!r) return file;
    const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${fmt(r.start)} – ${fmt(r.end)}, ${r.end.getFullYear()}`;
  }, []);

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
  /** Batch currently being renamed (the original filename), the editable full-name draft, and save state. */
  const [renameSourceFilePending, setRenameSourceFilePending] = useState<string | null>(null);
  const [renameNameDraft, setRenameNameDraft] = useState('');
  const [renameSourceFileLoading, setRenameSourceFileLoading] = useState(false);
  /** Batch currently being promoted to the active source of truth (filename), for the loading animation. */
  const [initializingSourceFile, setInitializingSourceFile] = useState<string | null>(null);

  /** Source file selected for Initial Calculation (step 2). Defaults to latest uploaded file. */
  const [calcSourceFile, setCalcSourceFile] = useState<string | null>(null);
  const [calcSourceFileLoading, setCalcSourceFileLoading] = useState(false);
  // Per-cycle "values locked" flag for Payment Dispatch (realtime). Lock = send
  // values to dispatch; Unlock = pull them back (dispatch shows nothing).
  const dispatchValuesLock = useWizardDispatchLock(calcSourceFile);
  const [togglingValuesLock, setTogglingValuesLock] = useState(false);
  /** The newest upload is the live payroll period. Selecting any older Hubstaff report
   *  enters read-only "replay" mode: the wizard preloads everything saved for that period
   *  (adjustments, notes, bonuses, final pay) for review, but blocks any save/dispatch so a
   *  closed period's records can never be overwritten. */
  const newestSourceFile = uploadedSourceFiles[0] ?? null;
  const isReplay = calcSourceFile != null && newestSourceFile != null && calcSourceFile !== newestSourceFile;
  /** Mirror of {@link isReplay} for use inside `[]`-dep handlers (matches the auditCtxRef pattern),
   *  so every per-employee mutation can short-circuit in view-only replay without rebuilding callbacks. */
  const isReplayRef = useRef(false);
  isReplayRef.current = isReplay;
  /** True when the replayed period already has a dispatched final-pay snapshot on file. */
  const [replayDispatched, setReplayDispatched] = useState(false);
  /** The dispatched per-employee finals saved for the replayed period (keyed by lowercased
   *  work/personal email). Overlaid onto the recomputed Reports rows so salary figures match
   *  exactly what was dispatched, even if rates have since changed. Null when none on file. */
  const [replaySnapshotFinals, setReplaySnapshotFinals] = useState<Record<string, {
    final: number; regularPay: number | null; otPay: number | null;
    regularHours: number; otHours: number; totalHours: number; initial: number | null;
    mesaDeduction?: number; mesaDisbursement?: number;
  }> | null>(null);
  /** True while fetching unfiltered hubstaff_hours (no source_file column / replace-only uploads). */
  const [unfilteredHubstaffLoading, setUnfilteredHubstaffLoading] = useState(false);

  const [hourlyRateRows, setHourlyRateRows] = useState<EmployeeHourlyRateRow[]>(
    initialData?.hourlyRates ?? [],
  );
  const [hourlyRatesLoading, setHourlyRatesLoading] = useState(false);
  const [hourlyRatesError, setHourlyRatesError] = useState<string | null>(null);
  // Payment Catalog pay structures — the source of truth for rates. Overlaid on
  // top of the sheet-synced `hourlyRateRows` in `ratesByEmail` below (live cycle
  // only: skipped while replaying a past period).
  const [payStructures, setPayStructures] = useState<PayStructure[]>([]);

  // ── HSL step: per-dept KPI bonus data loaded on demand (step 4) ─────────────
  const [hslStepBonusByEmail, setHslStepBonusByEmail] = useState<Record<string, number>>({});
  const [hslStepPeriods, setHslStepPeriods] = useState<{
    department: string;
    period_start: string;
    period_end: string;
    period_type: string;
    status: string;
    total_bonus: number;
    entries: { employee_email: string; employee_name: string; is_manager: boolean; calculated_bonus: number }[];
  }[]>([]);
  const [hslStepLoading, setHslStepLoading] = useState(false);
  const [hslStepError, setHslStepError] = useState<string | null>(null);
  const [hslRefreshKey, setHslRefreshKey] = useState(0);
  // Active HSL sub-department in the wizard HSL tab rail ('all' = every HSL employee).
  const [activeHslDept, setActiveHslDept] = useState<string>('all');
  // lower(email) → HSL sub-department key, from the hsl_team_members roster. Powers
  // the HSL tab's per-department rail (mirrors the Additions tab's dept grouping).
  const [hslDeptByEmail, setHslDeptByEmail] = useState<Record<string, string>>({});

  // ── Step 5: Contractor invoices ──────────────────────────────────────────────
  // The /api/contractor/invoices endpoint returns the full invoice row (line
  // items, addresses, logo, notes), so we hold the complete SavedInvoice shape
  // here — that lets the Preview Emails → Contractors tab render the exact same
  // receipt the contractor sees in their own dashboard.
  const [contractorInvoices, setContractorInvoices] = useState<(SavedInvoice & { status: string })[]>([]);
  const [contractorInvoicesLoading, setContractorInvoicesLoading] = useState(false);
  const [contractorInvoicesUpdating, setContractorInvoicesUpdating] = useState<string | null>(null);
  // Invoice whose receipt is open in the Preview Emails → Contractors tab.
  const [previewSelectedInvoiceId, setPreviewSelectedInvoiceId] = useState<string | null>(null);

  /** USD → PHP (PHP per $1). Saved in app_settings `usd_to_php_rate`; default is the official ₱100,000 ÷ 10⁵ rate. */
  const [usdToPhpRate, setUsdToPhpRate] = useState<number>(OFFICIAL_USD_TO_PHP_RATE);
  const [usdToPhpInput, setUsdToPhpInput] = useState<string>(String(OFFICIAL_USD_TO_PHP_RATE));
  const [usdToPhpSaving, setUsdToPhpSaving] = useState(false);
  const [usdToPhpEditing, setUsdToPhpEditing] = useState(false);

  /** USD → COP (COP per $1). Saved in app_settings `usd_to_cop_rate`. The USD-
   *  anchored second rate; PHP↔COP is derived from this + usdToPhpRate. */
  const [usdToCopRate, setUsdToCopRate] = useState<number>(OFFICIAL_USD_TO_COP_RATE);
  const [usdToCopInput, setUsdToCopInput] = useState<string>(String(OFFICIAL_USD_TO_COP_RATE));
  const [usdToCopSaving, setUsdToCopSaving] = useState(false);
  const [usdToCopEditing, setUsdToCopEditing] = useState(false);
  /** The two USD-anchored rates bundled for resolve-rate.ts. */
  const fxRates = useMemo<FxRates>(
    () => ({ usdToPhp: usdToPhpRate, usdToCop: usdToCopRate }),
    [usdToPhpRate, usdToCopRate],
  );

  const [activeDeptTab, setActiveDeptTab] = useState('accounting');
  const [accountingDeptModalOpen, setAccountingDeptModalOpen] = useState(false);
  const [ticketsModalEmail, setTicketsModalEmail] = useState<string | null>(null);
  const [sitesModalEmail, setSitesModalEmail] = useState<string | null>(null);
  const [leadGenModalEmail, setLeadGenModalEmail] = useState<string | null>(null);
  const [callbackModalEmail, setCallbackModalEmail] = useState<string | null>(null);
  const [qcModalEmail, setQcModalEmail] = useState<string | null>(null);
  const [hrModalEmail, setHrModalEmail] = useState<string | null>(null);
  const [pabCalendarModalEmail, setPabCalendarModalEmail] = useState<string | null>(null);
  const [pabForgiveActiveIso, setPabForgiveActiveIso] = useState<string | null>(null);
  const [pabForgiveNote, setPabForgiveNote] = useState('');
  const [pabForgiveLoadingIso, setPabForgiveLoadingIso] = useState<string | null>(null);
  const [pabForgiveError, setPabForgiveError] = useState<string | null>(null);
  const [pabRevokeActiveIso, setPabRevokeActiveIso] = useState<string | null>(null);
  const [pabRevokeLoadingIso, setPabRevokeLoadingIso] = useState<string | null>(null);
  const [pabRevokeError, setPabRevokeError] = useState<string | null>(null);
  const [techBonusManualGrants, setTechBonusManualGrants] = useState<Set<string>>(new Set());
  const [techBonusManualRevokes, setTechBonusManualRevokes] = useState<Set<string>>(new Set());
  // ── Inline PAB period setter: per-month memory + active-month selector ──────
  /** Local YYYY-MM-DD for the active month's start/end date inputs (mirrors the hook after each refresh). */
  const [pabStartLocal, setPabStartLocal] = useState('');
  const [pabEndLocal, setPabEndLocal] = useState('');
  /**
   * Month the PAB settings modal is currently inspecting/editing. The selector
   * drives this directly so clicking a pill always moves the highlight + dates,
   * independent of the loaded Hubstaff file's month. Null → defaults to the
   * effective month (reset whenever the modal opens).
   */
  const [pabEditMonth, setPabEditMonth] = useState<{ year: number; month: number } | null>(null);
  /** Year shown in the 12-month strip (defaults to today's year; arrows shift ±1 year). */
  const [pabPickerYear, setPabPickerYear] = useState<number>(() => new Date().getFullYear());
  const [pabSaveState, setPabSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [pabRefreshing, setPabRefreshing] = useState(false);
  const [pabSettingsOpen, setPabSettingsOpen] = useState(false);
  const [pabHolSaveState, setPabHolSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [pabHolNewDate, setPabHolNewDate] = useState('');
  const [pabHolNewName, setPabHolNewName] = useState('');
  /** Search text for the "Exclude from PAB" person picker inside the PAB settings modal. */
  const [pabExclusionSearch, setPabExclusionSearch] = useState('');
  /** Zero-based page for the "Exclude from PAB" list (5 people per page). */
  const [pabExclusionPage, setPabExclusionPage] = useState(0);
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
  const [additionsSaving, setAdditionsSaving] = useState(false);
  const [additionsSavedAt, setAdditionsSavedAt] = useState<Date | null>(null);
  const [lockedPabSnapshot, setLockedPabSnapshot] = useState<Record<string, 'eligible' | 'ineligible' | 'in_progress'> | null>(null);
  const [validationSearch, setValidationSearch] = useState('');
  /** Active department in the Validation step's per-department final-pay view. */
  const [validationDeptTab, setValidationDeptTab] = useState<string | null>(null);
  const [pendingDisputeRows, setPendingDisputeRows] = useState<Array<{
    id: string;
    work_email: string;
    dispute_date: string;
    reason: string;
    explanation: string | null;
    created_by: string | null;
    status: string;
  }>>([]);
  const [decidingDispute, setDecidingDispute] = useState<string | null>(null);
  const [employeeDepts, setEmployeeDepts] = useState<Record<string, string>>({});
  const [employeeBonuses, setEmployeeBonuses] = useState<Record<string, Record<string, boolean>>>({});
  /** Accounting-side per-employee bonus overrides. When present, replaces the auto-computed total. */
  const [bonusOverrides, setBonusOverrides] = useState<Record<string, number>>({});
  /** Free-text note explaining each adjustment, keyed by Hubstaff email like {@link bonusOverrides}. */
  const [bonusOverrideNotes, setBonusOverrideNotes] = useState<Record<string, string>>({});
  /** When on, reveals the per-adjustment note inputs in the Adj. column. */
  const [showAdjNotes, setShowAdjNotes] = useState(false);
  /** Accounting-side per-employee Orphanage pay (PHP). A positive amount added on top of final pay,
   *  shown as its own "Orphanage" paystub line. Keyed by Hubstaff email like {@link bonusOverrides}. */
  const [orphanageAmounts, setOrphanageAmounts] = useState<Record<string, number>>({});
  /** Orphanage step (id=3) paste tool: raw pasted "Pay week ⇥ Work email ⇥ Hours" TSV
   *  and the in-progress lock-in state. The parsed preview is derived (see orphanagePasteParse). */
  const [orphanagePaste, setOrphanagePaste] = useState('');
  const [orphanageLockingIn, setOrphanageLockingIn] = useState(false);
  /** Hours / OT-split detail for the locked-in orphanage pay, keyed by lower-cased email.
   *  Enriches the "Locked in this period" list; loaded from the orphanage_pay table on
   *  step entry and merged optimistically on lock-in (works even before migration #78). */
  const [orphanagePayDetail, setOrphanagePayDetail] = useState<Record<string, {
    hours: number; regH: number; otH: number; rate: number | null; otRate: number | null; payWeek: string | null;
  }>>({});
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

  /** ISO week-start (YYYY-MM-DD) of the active Hubstaff source file.
   *  Both KPI load effects pin to this week when it is known. */
  const hubstaffWeekStart = useMemo(() => {
    if (!calcSourceFile) return null;
    const r = parseDateRangeFromFilename(calcSourceFile);
    if (!r) return null;
    const d = r.start;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, [calcSourceFile]);

  /**
   * Manager-applied department bonuses (KPI Calculator → Additions bridge).
   * Each manager-bonus department's KPI week is gated `ready`/`locked` in
   * `hsl_bonus_period_status`; the payout amounts come from the catalog-driven
   * `bonus_catalog_applied` table (one row per applied bonus, summed per
   * employee). Indexed by the stored email (personal/work, lowercased) and
   * resolved to each wizard row's identity in `resolvedManagerBonus`. Surfaces
   * in the Additions "KPI Sub." column; the accountant can still override per row.
   */
  const [managerBonusRaw, setManagerBonusRaw] = useState<Record<string, number>>({});
  // Per-employee KPI amount BROKEN DOWN by source department, so the KPI Sub.
  // column can show on hover where each part came from — important for people
  // who were transferred mid-cycle and earned a KPI in two departments.
  const [managerBonusByDeptRaw, setManagerBonusByDeptRaw] = useState<Record<string, Record<string, number>>>({});
  const [managerBonusMeta, setManagerBonusMeta] = useState<Record<string, { period_start: string; status: string }>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const statusRes = await fetch('/api/hsl-bonus/period-status', { cache: 'no-store' });
        const statusJson = (await statusRes.json()) as {
          rows?: { department: string; period_start: string; period_end: string; status: string }[];
        };
        const managerKeys = new Set(MANAGER_BONUS_DEPT_KEYS);
        // When the Hubstaff week is known, pin to that week.
        // Otherwise take the latest ready/locked per department (locked beats ready).
        const chosen = new Map<string, { period_start: string; status: string }>();
        for (const row of statusJson.rows ?? []) {
          if (!managerKeys.has(row.department)) continue;
          if (row.status !== 'ready' && row.status !== 'locked') continue;
          if (hubstaffWeekStart) {
            if (row.period_start !== hubstaffWeekStart) continue;
            const cur = chosen.get(row.department);
            if (!cur || (cur.status !== 'locked' && row.status === 'locked')) {
              chosen.set(row.department, { period_start: row.period_start, status: row.status });
            }
          } else {
            const cur = chosen.get(row.department);
            if (
              !cur ||
              row.period_start > cur.period_start ||
              (row.period_start === cur.period_start && row.status === 'locked')
            ) {
              chosen.set(row.department, { period_start: row.period_start, status: row.status });
            }
          }
        }
        if (cancelled) return;

        const meta: Record<string, { period_start: string; status: string }> = {};
        const raw: Record<string, number> = {};
        const byDept: Record<string, Record<string, number>> = {};
        await Promise.all(
          Array.from(chosen.entries()).map(async ([dept, info]) => {
            meta[dept] = info;
            // Amounts come from the catalog-applied table; an employee may have
            // several applied bonuses in the week, so sum them per email — and
            // keep a per-department tally so the KPI Sub. hover can show the source
            // (a transferred person can have a KPI in two departments).
            const res = await fetch(
              `/api/bonus-catalog-applied?dept=${dept}&period_start=${info.period_start}`,
              { cache: 'no-store' },
            );
            const json = (await res.json()) as {
              rows?: { employee_email: string; amount: number | string | null; cadence?: 'weekly' | 'monthly' | null }[];
            };
            // Monthly bonuses pay once per month, on the LAST payroll week of the
            // month (mirrors PAB). Only sum them into that final week's paycheck —
            // a backstop even though the KPI Calculator already prevents a monthly
            // bonus from being applied outside the final week.
            const isFinalWeekOfMonth = isFinalPayrollWeekOfMonth(info.period_start);
            for (const r of json.rows ?? []) {
              const em = (r.employee_email ?? '').toLowerCase();
              if (!em) continue;
              if (r.cadence === 'monthly' && !isFinalWeekOfMonth) continue;
              const amt = r.amount == null ? 0 : Number(r.amount);
              raw[em] = Math.round((raw[em] ?? 0) + amt);
              const bucket = (byDept[em] ??= {});
              bucket[dept] = Math.round((bucket[dept] ?? 0) + amt);
            }
          }),
        );
        if (cancelled) return;
        setManagerBonusMeta(meta);
        setManagerBonusRaw(raw);
        setManagerBonusByDeptRaw(byDept);
      } catch {
        // Silent — no manager submissions surface; depts fall back to local entry.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hubstaffWeekStart]);

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

        // When the Hubstaff week is known, pin to that exact week.
        // Fall back to latest ready/locked only if no source file is loaded yet.
        const periods = (statusJson.rows ?? []).filter(
          (p) => p.status === 'ready' || p.status === 'locked',
        );
        let pick: { period_start: string; period_end: string; status: string } | null = null;
        if (hubstaffWeekStart) {
          pick = periods.find((p) => p.period_start === hubstaffWeekStart) ?? null;
        } else if (periods.length > 0) {
          periods.sort((a, b) => {
            if (a.period_start !== b.period_start) {
              return b.period_start.localeCompare(a.period_start);
            }
            return a.status === 'locked' ? -1 : b.status === 'locked' ? 1 : 0;
          });
          pick = periods[0]!;
        }
        if (!pick) {
          setSsdKpiPeriod(null);
          setSsdKpiAmounts({});
          return;
        }
        setSsdKpiPeriod({
          period_start: pick.period_start,
          period_end: pick.period_end,
          status: pick.status as 'ready' | 'locked',
        });

        const entriesRes = await fetch(
          `/api/hsl-bonus/entries?dept=ssd_medical_records&period_start=${pick.period_start}`,
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
  }, [hubstaffWeekStart]);

  // ── Overtime settings from System Settings ──────────────────────────────────
  const [otGlobalSuspended, setOtGlobalSuspended] = useState(false);
  const [otDeptEnabled, setOtDeptEnabled] = useState<Record<string, boolean>>(
    Object.fromEntries(DEPARTMENTS.map(d => [`ot_dept_${d.key}`, true])),
  );

  const pabPeriodSettings = usePabPeriodSettings();

  // ── Pay-period month — the selected Hubstaff report drives it ──
  // PAB month = the month containing the Monday of the selected file's week (matches
  // getPabMonthRange's week-ownership rule and the dispatch-week logic). The Hubstaff
  // selector is the single source of truth for the period, so every month-scoped section
  // (orphanage, budget requests, gifts, time adjustments), the PAB calendar, eligibility,
  // and pay all follow the chosen report. Falls back to the PAB picker's active month only
  // when no file is selected.
  const fileMonth = useMemo(() => {
    if (!calcSourceFile) return null;
    const r = parseDateRangeFromFilename(calcSourceFile);
    if (!r) return null;
    const dow = r.start.getDay();
    const daysBackToMon = dow === 0 ? 6 : dow - 1;
    const mon = new Date(r.start.getFullYear(), r.start.getMonth(), r.start.getDate() - daysBackToMon);
    return { year: mon.getFullYear(), month: mon.getMonth() };
  }, [calcSourceFile]);

  /**
   * ISO date window (YYYY-MM-DD keys) covered by the active/initialized Hubstaff
   * batch, parsed from its filename. The wizard is initialized on one batch
   * (`calcSourceFile`, the `is_current` upload); its filename encodes the pay
   * period. Null when no batch is selected or the filename has no parseable
   * range — callers then fall back to showing everything.
   */
  const activeBatchDateRange = useMemo(() => {
    if (!calcSourceFile) return null;
    const r = parseDateRangeFromFilename(calcSourceFile);
    if (!r) return null;
    const key = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { startKey: key(r.start), endKey: key(r.end) };
  }, [calcSourceFile]);

  /**
   * Contractor invoices whose billing date falls inside the active batch's pay
   * period — the only invoices that belong to this payroll run. Matches on
   * `invoice_date` (falling back to `created_at` when a contractor left the date
   * blank), compared as YYYY-MM-DD strings to sidestep timezone drift. Falls
   * back to the full list when the active batch has no parseable date range.
   */
  const contractorInvoicesInPeriod = useMemo(() => {
    if (!activeBatchDateRange) return contractorInvoices;
    const { startKey, endKey } = activeBatchDateRange;
    return contractorInvoices.filter((inv) => {
      const key = (inv.invoice_date || inv.created_at || '').slice(0, 10);
      if (!key) return false;
      return key >= startKey && key <= endKey;
    });
  }, [contractorInvoices, activeBatchDateRange]);

  /** {year, month} actually in effect: the file's month when one is selected, else the picker's. */
  const effectiveMonth = useMemo(
    () => fileMonth ?? { year: pabPeriodSettings.activeMonthResolved.year, month: pabPeriodSettings.activeMonthResolved.month },
    [fileMonth, pabPeriodSettings.activeMonthResolved.year, pabPeriodSettings.activeMonthResolved.month],
  );
  const effectiveMonthKey = yearMonthKey(effectiveMonth.year, effectiveMonth.month);
  /**
   * Lower-cased emails the accountant has excluded from the *evaluated* month's
   * PAB. Drives the wizard's PAB display + (via `perfectAttendanceEligible`) the
   * actual ₱0 payout, mirroring the dispatch path.
   */
  const pabExcludedActiveMonth = useMemo<Set<string>>(
    () => new Set(pabPeriodSettings.exclusions.get(effectiveMonthKey) ?? []),
    [pabPeriodSettings.exclusions, effectiveMonthKey],
  );
  const isPabExcluded = useCallback(
    (email: string) => {
      if (pabExcludedActiveMonth.size === 0) return false;
      const norm = normEmail(email) ?? (email ?? '').toLowerCase();
      return pabExcludedActiveMonth.has(norm);
    },
    [pabExcludedActiveMonth],
  );
  /** Resolved date window for the effective month: saved override if present, else the default rule. */
  const effectiveMonthRange = useMemo(() => {
    const override = pabPeriodSettings.overrides.get(effectiveMonthKey);
    if (override) return { start: override.start, end: override.end };
    if (!fileMonth) return { start: pabPeriodSettings.activeRange.start, end: pabPeriodSettings.activeRange.end };
    return getPabMonthRange(effectiveMonth.year, effectiveMonth.month);
  }, [pabPeriodSettings.overrides, pabPeriodSettings.activeRange.start, pabPeriodSettings.activeRange.end, effectiveMonthKey, effectiveMonth.year, effectiveMonth.month, fileMonth]);

  /**
   * Month the PAB settings modal edits: the user's picker selection when set,
   * else the effective month. Drives the modal highlight, date inputs, readout,
   * and the save/auto-calc/reset handlers — so clicking a pill always moves them,
   * even while a Hubstaff file pins `effectiveMonth` to its own month.
   */
  const editMonth = useMemo(
    () => pabEditMonth ?? { year: effectiveMonth.year, month: effectiveMonth.month },
    [pabEditMonth, effectiveMonth.year, effectiveMonth.month],
  );
  const editMonthKey = yearMonthKey(editMonth.year, editMonth.month);
  const editMonthRange = useMemo(
    () => resolvePabRangeForMonth(editMonth.year, editMonth.month, pabPeriodSettings.overrides),
    [editMonth.year, editMonth.month, pabPeriodSettings.overrides],
  );

  // Reset the modal's edit month to the effective month each time it opens, so it
  // always lands on the currently-evaluated month rather than a stale selection.
  useEffect(() => {
    if (pabSettingsOpen) {
      setPabEditMonth(null);
      setPabExclusionSearch('');
      setPabExclusionPage(0);
    }
  }, [pabSettingsOpen]);

  /**
   * Sync hook → local form state. Local inputs reflect the modal's edit month's
   * resolved range (override or default), following picker selections live.
   */
  useEffect(() => {
    if (pabPeriodSettings.loading) return;
    const toIso = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    setPabStartLocal(toIso(editMonthRange.start));
    setPabEndLocal(toIso(editMonthRange.end));
    setPabPickerYear(editMonth.year);
  }, [
    pabPeriodSettings.loading,
    editMonthRange.start,
    editMonthRange.end,
    editMonth.year,
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

  const loadAdditionsProgress = React.useCallback(async (sourceFile: string) => {
    try {
      const res = await fetch(`/api/app-settings?key=payroll.wizard.additions.${sourceFile}`);
      const json = await res.json();
      // Every Additions input is scoped to the Hubstaff file (= pay period). Reset each
      // period-specific field to this file's saved value, or to empty if it has none, so
      // adjustments/notes/bonuses never bleed from a previously-viewed pay period.
      const data = json.value ? JSON.parse(json.value) : {};
      setBonusOverrides(data.bonusOverrides ?? {});
      setBonusOverrideNotes(data.bonusOverrideNotes ?? {});
      setOrphanageAmounts(data.orphanageAmounts ?? {});
      setEmployeeMetrics(data.employeeMetrics ?? {});
      setDeptMetrics(data.deptMetrics ?? {});
      setEmployeeBonuses(data.employeeBonuses ?? {});
      setTechBonusManualGrants(new Set(data.techBonusManualGrants ?? []));
      setTechBonusManualRevokes(new Set(data.techBonusManualRevokes ?? []));
      setLockedPabSnapshot((data.pabStatusSnapshot ?? {}) as Record<string, 'eligible' | 'ineligible' | 'in_progress'>);
      if (data.employeeDepts) setEmployeeDepts(data.employeeDepts);
      if (json.value) {
        setAdditionsSavedAt(new Date()); // Mark as having a saved state
        toast.info('Restored locked-in additions progress');
      } else {
        setAdditionsSavedAt(null);
      }
    } catch (e) {
      console.error('Failed to load additions progress', e);
    }
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
      if (isReplay) { toast.error('Replaying a past period is view-only'); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return;
      const sd = parseLocalDateFromIso(start);
      const ed = parseLocalDateFromIso(end);
      if (!sd || !ed || sd.getTime() > ed.getTime()) {
        toast.error('Invalid PAB period', { description: 'End date must be on or after start date.' });
        return;
      }
      // The window must intersect the month it's keyed to — a PAB period can spill
      // a few days into the next month (the canonical Friday can land there) but it
      // can never be an entirely different month. Blocks e.g. saving June's
      // Jun 1–Jul 3 default under the May key.
      const mStart = new Date(editMonth.year, editMonth.month, 1);
      const mEnd = new Date(editMonth.year, editMonth.month + 1, 0);
      if (sd.getTime() > mEnd.getTime() || ed.getTime() < mStart.getTime()) {
        const monthName = mStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        toast.error('PAB period is outside the selected month', {
          description: `${monthName}'s window must include at least one day in ${monthName}. Pick dates inside the month, or use Auto-calc.`,
        });
        return;
      }
      setPabSaveState('saving');
      try {
        await writeOverridesBlob(editMonthKey, { start, end });
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
    [writeOverridesBlob, pabPeriodSettings, editMonth.year, editMonth.month, editMonthKey, isReplay],
  );

  /**
   * Auto-calculate the active month's PAB window from the canonical rule
   * (first Mon on/after the 1st → Friday of the last week whose Monday falls in the month)
   * and save it as that month's override. Useful to explicitly re-anchor a drifted custom range.
   */
  const autoCalcActiveMonth = React.useCallback(async () => {
    if (isReplay) { toast.error('Replaying a past period is view-only'); return; }
    const { year, month } = editMonth;
    const r = getPabMonthRange(year, month);
    const startIso = `${r.start.getFullYear()}-${String(r.start.getMonth() + 1).padStart(2, '0')}-${String(r.start.getDate()).padStart(2, '0')}`;
    const endIso = `${r.end.getFullYear()}-${String(r.end.getMonth() + 1).padStart(2, '0')}-${String(r.end.getDate()).padStart(2, '0')}`;
    setPabSaveState('saving');
    try {
      await writeOverridesBlob(editMonthKey, { start: startIso, end: endIso });
      await pabPeriodSettings.refresh();
      setPabSaveState('saved');
      toast.success('PAB dates auto-calculated', { description: `${startIso} → ${endIso}` });
      setTimeout(() => setPabSaveState('idle'), 2000);
    } catch (e) {
      setPabSaveState('error');
      toast.error('Save failed', { description: e instanceof Error ? e.message : 'Unknown error' });
      setTimeout(() => setPabSaveState('idle'), 3000);
    }
  }, [pabPeriodSettings, writeOverridesBlob, editMonth, editMonthKey, isReplay]);

  /** Remove the override for the active month; the default `getPabMonthRange` takes over. */
  const resetActiveMonthOverride = React.useCallback(async () => {
    if (isReplay) { toast.error('Replaying a past period is view-only'); return; }
    setPabSaveState('saving');
    try {
      await writeOverridesBlob(editMonthKey, null);
      await pabPeriodSettings.refresh();
      setPabSaveState('saved');
      toast.success('Override removed', { description: 'Reverted to the default Mon–Fri window for this month.' });
      setTimeout(() => setPabSaveState('idle'), 2000);
    } catch (e) {
      setPabSaveState('error');
      toast.error('Save failed', { description: e instanceof Error ? e.message : 'Unknown error' });
      setTimeout(() => setPabSaveState('idle'), 3000);
    }
  }, [writeOverridesBlob, pabPeriodSettings, editMonthKey, isReplay]);

  /**
   * Serialize the exclusions map back to the JSON shape stored in app_settings,
   * patching a single month's email list. Empty lists are dropped so the blob
   * stays compact.
   */
  const writeExclusionsBlob = React.useCallback(
    async (patchKey: string, emails: Set<string>) => {
      const next: Record<string, string[]> = {};
      for (const [k, set] of pabPeriodSettings.exclusions.entries()) {
        if (k === patchKey) continue;
        if (set.size > 0) next[k] = Array.from(set);
      }
      if (emails.size > 0) next[patchKey] = Array.from(emails);
      await savePabSetting(PAB_PERIOD_EXCLUSIONS_KEY, JSON.stringify(next));
    },
    [pabPeriodSettings.exclusions, savePabSetting],
  );

  /**
   * Toggle a single person's PAB exclusion for the month the modal is editing.
   * Excluded employees earn ₱0 PAB for that period regardless of attendance —
   * the dispatch path (`current-pay.ts`) honors the same list.
   */
  const togglePabExclusion = React.useCallback(
    async (email: string, excluded: boolean) => {
      if (isReplay) { toast.error('Replaying a past period is view-only'); return; }
      const norm = normEmail(email) ?? email.toLowerCase();
      if (!norm) return;
      const set = new Set(pabPeriodSettings.exclusions.get(editMonthKey) ?? []);
      if (excluded) set.add(norm);
      else set.delete(norm);
      setPabSaveState('saving');
      try {
        await writeExclusionsBlob(editMonthKey, set);
        await pabPeriodSettings.refresh();
        setPabSaveState('saved');
        setTimeout(() => setPabSaveState('idle'), 1500);
      } catch (e) {
        setPabSaveState('error');
        toast.error('Save failed', { description: e instanceof Error ? e.message : 'Unknown error' });
        setTimeout(() => setPabSaveState('idle'), 3000);
      }
    },
    [pabPeriodSettings, writeExclusionsBlob, editMonthKey, isReplay],
  );

  /** Switch which month the Additions tab evaluates. */
  const selectPabMonth = React.useCallback(
    async (year: number, month: number) => {
      if (isReplay) { toast.error('Replaying a past period is view-only'); return; }
      const key = `${year}-${String(month + 1).padStart(2, '0')}`;
      // Move the modal highlight + date readout to the clicked month immediately,
      // independent of the loaded file's month.
      setPabEditMonth({ year, month });
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
    [savePabSetting, pabPeriodSettings, isReplay],
  );

  const [approvedDisputeDates, setApprovedDisputeDates] = useState<Map<string, Map<string, number | null>>>(new Map());
  const [approvedDisputeIds, setApprovedDisputeIds] = useState<Map<string, Map<string, string>>>(new Map());
  /** Approved time-adjustment overrides: normalized work_email -> (ISO date -> SET hours). */
  const [approvedTimeAdjustments, setApprovedTimeAdjustments] = useState<Map<string, Map<string, number>>>(new Map());
  /**
   * Approved, not-yet-dispatched MESA disbursements: normalized work_email -> total PHP.
   * Surfaced in the Additions MESA column and added to Final pay. Excludes already
   * dispatched payouts (dispatched_at set) so they aren't double-counted with the
   * Urgent Payments queue that pays them out.
   */
  const [mesaDisbursements, setMesaDisbursements] = useState<Map<string, number>>(new Map());
  /** Pending + approved time-adjustment requests (for the Additions review panel). */
  const [timeAdjustmentRows, setTimeAdjustmentRows] = useState<TimeAdjustmentRow[]>([]);
  const [timeAdjustmentSignedUrls, setTimeAdjustmentSignedUrls] = useState<Record<string, string>>({});
  const [decidingAdjustmentId, setDecidingAdjustmentId] = useState<string | null>(null);
  const [deletingAdjustmentId, setDeletingAdjustmentId] = useState<string | null>(null);
  const [adjustmentHoursDraft, setAdjustmentHoursDraft] = useState<Record<string, string>>({});
  /** ISO date (YYYY-MM-DD) -> holiday name. Built from app_settings; empty when disabled. */
  const [usHolidayDates, setUsHolidayDates] = useState<Map<string, string>>(new Map());
  /** Full holiday list (enabled + disabled) — used for validation-section display. */
  const [usHolidaysListFull, setUsHolidaysListFull] = useState<UsHoliday[]>([]);
  const [usHolidaysMasterEnabled, setUsHolidaysMasterEnabled] = useState<boolean>(true);

  // Fetch US holiday forgiveness settings — same shape as SystemSettings uses.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/app-settings?keys=${encodeURIComponent([US_HOLIDAYS_ENABLED_KEY, US_HOLIDAYS_LIST_KEY].join(','))}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as { values?: Record<string, string | null> };
        if (cancelled) return;
        const values = json.values ?? {};
        const enabledVal = values[US_HOLIDAYS_ENABLED_KEY];
        const enabled = enabledVal === null || enabledVal === undefined ? true : enabledVal === 'true';
        const list = parseUsHolidaysList(values[US_HOLIDAYS_LIST_KEY] ?? null);
        setUsHolidayDates(getEnabledHolidayMap(list, enabled));
        setUsHolidaysListFull(list);
        setUsHolidaysMasterEnabled(enabled);
      } catch {
        if (!cancelled) setUsHolidayDates(new Map());
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const saveHolidaysList = React.useCallback(async (list: UsHoliday[], masterEnabled?: boolean) => {
    setPabHolSaveState('saving');
    try {
      await savePabSetting(US_HOLIDAYS_LIST_KEY, serializeUsHolidaysList(list));
      const enabled = masterEnabled ?? usHolidaysMasterEnabled;
      setUsHolidaysListFull(list);
      setUsHolidayDates(getEnabledHolidayMap(list, enabled));
      setPabHolSaveState('saved');
      setTimeout(() => setPabHolSaveState('idle'), 2000);
    } catch {
      setPabHolSaveState('error');
      setTimeout(() => setPabHolSaveState('idle'), 3000);
    }
  }, [savePabSetting, usHolidaysMasterEnabled]);

  const saveHolidaysEnabled = React.useCallback(async (enabled: boolean) => {
    setPabHolSaveState('saving');
    try {
      await savePabSetting(US_HOLIDAYS_ENABLED_KEY, String(enabled));
      setUsHolidaysMasterEnabled(enabled);
      setUsHolidayDates(getEnabledHolidayMap(usHolidaysListFull, enabled));
      setPabHolSaveState('saved');
      setTimeout(() => setPabHolSaveState('idle'), 2000);
    } catch {
      setPabHolSaveState('error');
      setTimeout(() => setPabHolSaveState('idle'), 3000);
    }
  }, [savePabSetting, usHolidaysListFull]);

  const addPabHoliday = React.useCallback(async () => {
    if (!pabHolNewDate || !pabHolNewName.trim()) return;
    const next = [...usHolidaysListFull, { date: pabHolNewDate, name: pabHolNewName.trim(), enabled: true }]
      .sort((a, b) => a.date.localeCompare(b.date));
    await saveHolidaysList(next);
    setPabHolNewDate('');
    setPabHolNewName('');
  }, [pabHolNewDate, pabHolNewName, usHolidaysListFull, saveHolidaysList]);

  const removePabHoliday = React.useCallback(async (date: string) => {
    await saveHolidaysList(usHolidaysListFull.filter(h => h.date !== date));
  }, [usHolidaysListFull, saveHolidaysList]);

  const togglePabHoliday = React.useCallback(async (date: string, enabled: boolean) => {
    await saveHolidaysList(usHolidaysListFull.map(h => h.date === date ? { ...h, enabled } : h));
  }, [usHolidaysListFull, saveHolidaysList]);

  const seedPabFederalHolidays = React.useCallback(async () => {
    const year = pabPickerYear;
    const seeds = computeFederalHolidays(year);
    const existingDates = new Set(usHolidaysListFull.map(h => h.date));
    const toAdd = seeds.filter(h => !existingDates.has(h.date));
    if (toAdd.length === 0) return;
    const next = [...usHolidaysListFull, ...toAdd].sort((a, b) => a.date.localeCompare(b.date));
    await saveHolidaysList(next);
  }, [pabPickerYear, usHolidaysListFull, saveHolidaysList]);

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
        const res = await fetch('/api/app-settings?keys=usd_to_php_rate,usd_to_cop_rate', { cache: 'no-store' });
        const json = (await res.json()) as { values?: Record<string, string | null>; error: string | null };
        if (cancelled) return;
        const values = json.values ?? {};
        const phpRate = effectiveUsdToPhpRateFromStored(values['usd_to_php_rate']);
        setUsdToPhpRate(phpRate);
        setUsdToPhpInput(String(phpRate));
        const copRate = effectiveUsdToCopRateFromStored(values['usd_to_cop_rate']);
        setUsdToCopRate(copRate);
        setUsdToCopInput(String(copRate));
      } catch {
        // keep defaults
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Audit: derive the current cycle context attached to every wizard event.
  // Includes the active Hubstaff source file (cycle key), the period parsed
  // from its filename, and the snapshot USD->PHP rate at the moment of the
  // event. Consumed by the Reports tab drill-down + CSV export.
  const auditCycle = useMemo<AuditCycleContext>(() => {
    const file = calcSourceFile;
    if (!file) {
      return {
        source_file: null,
        period_start: null,
        period_end: null,
        fx_rate: usdToPhpRate,
      };
    }
    const range = parseDateRangeFromFilename(file);
    const toIso = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    return {
      source_file: file,
      period_start: range ? toIso(range.start) : null,
      period_end: range ? toIso(range.end) : null,
      fx_rate: usdToPhpRate,
    };
  }, [calcSourceFile, usdToPhpRate]);

  // ── Audit: fire wizard.opened exactly once when the wizard hydrates.
  // Waits until the wizard knows its operator (sessionEmail) or has at least
  // surfaced a cycle hint, so the event isn't logged with empty context.
  const wizardOpenedAuditRef = useRef(false);
  useEffect(() => {
    if (wizardOpenedAuditRef.current) return;
    if (!sessionEmail && !calcSourceFile) return;
    wizardOpenedAuditRef.current = true;
    void logAudit({
      user_name: sessionEmail ?? 'anonymous',
      user_role: sessionRole ?? 'user',
      action: 'wizard.opened',
      resource: 'payroll_wizard',
      cycle: auditCycle,
      details: {
        session_started_at: wizardStartedAt.toISOString(),
      },
    });
  }, [sessionEmail, calcSourceFile, auditCycle, wizardStartedAt]);

  // ── Audit: log every cycle switch (after the initial value settles).
  const lastAuditedCycleFileRef = useRef<string | null>(null);
  useEffect(() => {
    if (!calcSourceFile) return;
    if (lastAuditedCycleFileRef.current === calcSourceFile) return;
    const prev = lastAuditedCycleFileRef.current;
    lastAuditedCycleFileRef.current = calcSourceFile;
    if (prev === null) return; // first settle — already covered by wizard.opened
    void logAudit({
      user_name: sessionEmail ?? 'anonymous',
      user_role: sessionRole ?? 'user',
      action: 'wizard.cycle_selected',
      resource: 'payroll_wizard',
      cycle: auditCycle,
      details: {
        previous_source_file: prev,
        new_source_file: calcSourceFile,
      },
    });
  }, [calcSourceFile, auditCycle, sessionEmail]);

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

  const loadPayStructures = React.useCallback(async () => {
    try {
      const res = await fetch('/api/payment-catalog/pay-structures', { cache: 'no-store' });
      const json = (await res.json()) as { structures?: PayStructure[]; error?: string | null };
      setPayStructures(json.structures ?? []);
    } catch {
      // Non-fatal: without the catalog, ratesByEmail falls back to the sheet rates.
      setPayStructures([]);
    }
  }, []);

  // Load the Payment Catalog once on mount so the Step 2 calc can overlay it.
  useEffect(() => {
    void loadPayStructures();
  }, [loadPayStructures]);

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
    // Keep a user-chosen replay selection; only auto-pick the newest when nothing valid
    // is selected yet (initial mount) or the selected file was deleted from the list.
    setCalcSourceFile((cur) => (cur && uploadedSourceFiles.includes(cur) ? cur : uploadedSourceFiles[0]));
  }, [uploadedSourceFiles]);

  // Load locked additions progress on mount / source-file change
  useEffect(() => {
    if (!calcSourceFile) return;
    void loadAdditionsProgress(calcSourceFile);
  }, [calcSourceFile, loadAdditionsProgress]);

  // ── "Do not pay" exclusions (Validation step) ─────────────────────────────
  // Per-pay-period set of work emails accounting excluded from payment.
  const loadExclusions = React.useCallback(async (sourceFile: string) => {
    try {
      const res = await fetch(`/api/app-settings?key=payroll.wizard.exclusions.${sourceFile}`);
      const json = await res.json();
      const arr: string[] = json.value ? (JSON.parse(json.value) as string[]) : [];
      setExcludedEmails(new Set(arr.map((e) => normEmail(e) ?? e.trim().toLowerCase()).filter(Boolean)));
    } catch {
      setExcludedEmails(new Set());
    }
  }, []);

  useEffect(() => {
    if (!calcSourceFile) { setExcludedEmails(new Set()); return; }
    void loadExclusions(calcSourceFile);
  }, [calcSourceFile, loadExclusions]);

  const persistExclusions = React.useCallback(async (next: Set<string>) => {
    if (!calcSourceFile || isReplay) return;
    try {
      await savePabSetting(`payroll.wizard.exclusions.${calcSourceFile}`, JSON.stringify(Array.from(next)));
    } catch (e) {
      console.warn('[persistExclusions]', e);
    }
  }, [calcSourceFile, isReplay, savePabSetting]);

  /** Toggle an employee in/out of the "do not pay" set (Validation step). */
  const toggleExcluded = React.useCallback((email: string) => {
    const key = normEmail(email) ?? email.trim().toLowerCase();
    if (!key) return;
    setExcludedEmails((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      void persistExclusions(next);
      return next;
    });
  }, [persistExclusions]);

  /**
   * Bulk-set the "do not pay" flag for many employees at once (Validation step's
   * per-department "exclude all" master tickbox). `exclude=true` flags everyone
   * in the list, `false` clears them.
   */
  const setExcludedMany = React.useCallback((emails: string[], exclude: boolean) => {
    const keys = emails
      .map((e) => normEmail(e) ?? e.trim().toLowerCase())
      .filter(Boolean) as string[];
    if (keys.length === 0) return;
    setExcludedEmails((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (exclude) next.add(k);
        else next.delete(k);
      }
      void persistExclusions(next);
      return next;
    });
  }, [persistExclusions]);

  // When replaying a past period, surface whether it was already dispatched (its
  // final-pay snapshot exists) so the replay banner can label it accordingly.
  useEffect(() => {
    if (!isReplay || !calcSourceFile) { setReplayDispatched(false); setReplaySnapshotFinals(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/app-settings?key=payroll.wizard.final_pay.${calcSourceFile}`);
        const json = await res.json();
        if (cancelled) return;
        if (json.value) {
          const parsed = JSON.parse(json.value) as { finals?: NonNullable<typeof replaySnapshotFinals> };
          setReplayDispatched(true);
          setReplaySnapshotFinals(parsed.finals ?? null);
        } else {
          setReplayDispatched(false);
          setReplaySnapshotFinals(null);
        }
      } catch {
        if (!cancelled) { setReplayDispatched(false); setReplaySnapshotFinals(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [isReplay, calcSourceFile]);

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

  const ratesByEmail = useMemo(() => {
    const idx = indexHourlyRatesByEmail(hourlyRateRows);
    // Bridge alternate work emails. A rate row can be keyed on an employee's
    // alternate gsuite alias (e.g. kevin@simple.biz) while the roster + Hubstaff
    // match on their primary work email (kevt@simple.biz). For each roster
    // employee, if any of their emails resolves to a rate row, alias ALL of
    // their emails to that row — so the rate attaches under the primary work
    // email the rest of the wizard looks up by. The Global Master List is the
    // source of truth for which addresses belong to one human.
    for (const e of masterEmployees) {
      const emails = [e.work_email, e.personal_email, e.alternate_work_email, e.alternate_work_email_2]
        .map((x) => normEmail(x ?? ''))
        .filter((x): x is string => !!x);
      if (emails.length < 2) continue;
      const hit = emails.map((em) => idx.get(em)).find(Boolean);
      if (!hit) continue;
      for (const em of emails) if (!idx.has(em)) idx.set(em, hit);
    }

    // Payment Catalog overlay. Priority: individual (employee) structure → sheet
    // rate → department base. The individual rate overrides the sheet; the
    // department rate only fills in for an employee with no sheet rate at all.
    // PHP-equivalent (USD converted at the FX rate). Skipped during replay so
    // historical periods keep the rates that were in effect then ("live cycle
    // only").
    if (!isReplay && payStructures.length > 0) {
      const catIdx = buildCatalogRateIndex(payStructures);
      // 1) Overlay onto employees who ALREADY have a sheet-cache rate row: the
      //    individual catalog rate overrides the sheet; the department base only
      //    fills in when the row carries no sheet rate at all.
      for (const [em, row] of idx) {
        const empCat = resolveEmployeeCatalogRate(
          catIdx,
          [em, row.work_email ?? '', row.personal_email ?? ''],
          fxRates,
        );
        const hasSheet =
          (row.regular_rate != null && row.regular_rate !== '') ||
          (row.ot_rate != null && row.ot_rate !== '');
        const deptCat = hasSheet ? null : resolveDeptCatalogRate(catIdx, row.department, fxRates);
        const applied = empCat ?? deptCat;
        if (applied) {
          idx.set(em, { ...row, regular_rate: String(applied.regPhp), ot_rate: String(applied.otPhp) });
        }
      }
      // 2) Catalog-only employees. Someone can be paid entirely from the Payment
      //    Catalog (an individual structure, or their department's base) with NO
      //    legacy `employee_hourly_rates` row — e.g. anyone onboarded after the
      //    Google-Sheet rates sync was disabled. Step 1 never created an `idx`
      //    entry for them, so the overlay above skipped them and the wizard
      //    showed "No rate". Synthesize a rate row from the catalog, keyed on all
      //    of their aliases, so they compute + pay correctly. The catalog is the
      //    source of truth: individual structure wins, department base is the
      //    fallback.
      for (const e of masterEmployees) {
        const emails = [e.work_email, e.personal_email, e.alternate_work_email, e.alternate_work_email_2]
          .map((x) => normEmail(x ?? ''))
          .filter((x): x is string => !!x);
        if (emails.length === 0) continue;
        if (emails.some((em) => idx.has(em))) continue; // already covered by a (possibly overlaid) sheet row
        const empCat = resolveEmployeeCatalogRate(catIdx, emails, fxRates);
        const deptCat = empCat ? null : resolveDeptCatalogRate(catIdx, e.department, fxRates);
        const applied = empCat ?? deptCat;
        if (!applied) continue;
        const synthetic: EmployeeHourlyRateRow = {
          work_email: e.work_email ?? null,
          personal_email: e.personal_email ?? null,
          regular_rate: String(applied.regPhp),
          ot_rate: String(applied.otPhp),
          department: e.department ?? null,
          bank_preferred: null,
          hurupay_email: null,
          higlobe_email: null,
          higlobe_account_name: null,
          phone_number: null,
          full_address: null,
          city: null,
          province_state: null,
          mesa_member: null,
          mesa_member_since: null,
        };
        for (const em of emails) idx.set(em, synthetic);
      }
    }
    return idx;
  }, [hourlyRateRows, masterEmployees, payStructures, isReplay, fxRates]);

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
    // Second pass: index alternate work emails as byWorkEmail aliases so a
    // Hubstaff row keyed on an alias (e.g. kevin@simple.biz) still resolves to
    // this master record. Runs after every primary is mapped and never
    // overwrites a primary match — primary work email always wins.
    for (const e of masterEmployees) {
      for (const alt of [e.alternate_work_email, e.alternate_work_email_2]) {
        const a = normEmail(alt);
        if (a && !byWorkEmail.has(a)) byWorkEmail.set(a, e);
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
    return {
      year: effectiveMonth.year,
      month: effectiveMonth.month,
      start: effectiveMonthRange.start,
      end: effectiveMonthRange.end,
      monthName: monthNames[effectiveMonth.month] ?? '',
    };
  }, [effectiveMonth.year, effectiveMonth.month, effectiveMonthRange.start, effectiveMonthRange.end]);

  // Real-time: when a manager marks a dept ready/unready, update accounting's view live.
  useEffect(() => {
    if (currentStep !== 4) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel('payroll-wizard-hsl-status')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hsl_bonus_period_status' }, () => {
        setHslRefreshKey((k) => k + 1);
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [currentStep]);

  // ── HSL step (4): load all dept KPI bonus entries when accounting enters the step
  useEffect(() => {
    if (currentStep !== 4) return;
    let cancelled = false;
    setHslStepLoading(true);
    setHslStepError(null);
    const hslKeys = new Set<string>(HSL_DEPT_KEYS);
    (async () => {
      try {
        const [statusRes, membersRes] = await Promise.all([
          fetch('/api/hsl-bonus/period-status', { cache: 'no-store' }),
          fetch('/api/hsl-bonus/team-members', { cache: 'no-store' }).catch(() => null),
        ]);
        if (!statusRes.ok) throw new Error(`Period status fetch failed: HTTP ${statusRes.status}`);
        const statusJson = (await statusRes.json()) as {
          rows?: { department: string; period_start: string; period_end: string; period_type: string; status: string }[];
        };
        // Roster: lower(email) → HSL sub-department. Best-effort — a failure just
        // leaves employees ungrouped ("Unassigned") rather than breaking the cards.
        if (membersRes && membersRes.ok) {
          try {
            const membersJson = (await membersRes.json()) as { rows?: { email: string; dept_key: string }[] };
            const deptMap: Record<string, string> = {};
            for (const m of membersJson.rows ?? []) {
              const em = (m.email ?? '').toLowerCase();
              if (em && m.dept_key) deptMap[em] = m.dept_key;
            }
            if (!cancelled) setHslDeptByEmail(deptMap);
          } catch { /* roster unavailable — keep the existing map */ }
        }
        // Pick latest ready/locked period per HSL dept (locked beats ready on tie)
        const chosen = new Map<string, { period_start: string; period_end: string; period_type: string; status: string }>();
        for (const row of statusJson.rows ?? []) {
          if (!hslKeys.has(row.department)) continue;
          if (row.status !== 'ready' && row.status !== 'locked') continue;
          const cur = chosen.get(row.department);
          if (!cur || row.period_start > cur.period_start || (row.period_start === cur.period_start && row.status === 'locked')) {
            chosen.set(row.department, { period_start: row.period_start, period_end: row.period_end, period_type: row.period_type, status: row.status });
          }
        }
        if (cancelled) return;
        type HslEntry = { employee_email: string; employee_name: string; is_manager: boolean; calculated_bonus: number };
        const periods: typeof hslStepPeriods = [];
        const bonusMap: Record<string, number> = {};
        await Promise.all(
          Array.from(chosen.entries()).map(async ([dept, info]) => {
            const res = await fetch(`/api/hsl-bonus/entries?dept=${dept}&period_start=${info.period_start}`, { cache: 'no-store' });
            const json = (await res.json()) as { rows?: HslEntry[] };
            const entries = (json.rows ?? []).filter(r => r.employee_email && r.employee_email !== '__dept_meta__');
            let total = 0;
            for (const e of entries) {
              const em = (e.employee_email ?? '').toLowerCase();
              if (!em) continue;
              const amt = Math.round(e.calculated_bonus ?? 0);
              bonusMap[em] = (bonusMap[em] ?? 0) + amt;
              total += amt;
            }
            periods.push({ department: dept, ...info, total_bonus: total, entries });
          }),
        );
        if (cancelled) return;
        periods.sort((a, b) => a.department.localeCompare(b.department));
        setHslStepPeriods(periods);
        setHslStepBonusByEmail(bonusMap);
      } catch (e) {
        if (!cancelled) setHslStepError(e instanceof Error ? e.message : 'Failed to load HSL bonus data');
      } finally {
        if (!cancelled) setHslStepLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentStep, hslRefreshKey]);

  // Fetch all contractor invoices when on step 6 (Contractors)
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
      .then((json: { rows: { id: string; work_email: string; dispute_date: string; reason: string; override_hours: number | null }[] }) => {
        const map = new Map<string, Map<string, number | null>>();
        const idMap = new Map<string, Map<string, string>>();
        for (const row of json.rows ?? []) {
          const em = (row.work_email ?? '').trim().toLowerCase();
          if (!em) continue;
          if (!map.has(em)) map.set(em, new Map());
          map.get(em)!.set(row.dispute_date, row.override_hours);
          if (row.id) {
            if (!idMap.has(em)) idMap.set(em, new Map());
            idMap.get(em)!.set(row.dispute_date, row.id);
          }
        }
        setApprovedDisputeDates(map);
        setApprovedDisputeIds(idMap);
      })
      .catch(() => { setApprovedDisputeDates(new Map()); setApprovedDisputeIds(new Map()); });
  }, [pabMonthRange]);

  // Approved time-adjustment overrides for the PAB period — folded into pay + PAB.
  const refreshApprovedAdjustmentOverrides = useCallback(() => {
    if (!pabMonthRange) return;
    const s = pabMonthRange.start;
    const e = pabMonthRange.end;
    const from = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
    const dayAfterEnd = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1);
    const to = `${dayAfterEnd.getFullYear()}-${String(dayAfterEnd.getMonth() + 1).padStart(2, '0')}-${String(dayAfterEnd.getDate()).padStart(2, '0')}`;
    fetch(`/api/time-adjustments?status=approved&from=${from}&to=${to}`, { cache: 'no-store' })
      .then(r => r.json())
      .then((json: { rows?: TimeAdjustmentRow[] }) => {
        const map = new Map<string, Map<string, number>>();
        for (const row of json.rows ?? []) {
          if (row.approved_hours == null) continue;
          const em = (row.work_email ?? '').trim().toLowerCase();
          if (!em) continue;
          if (!map.has(em)) map.set(em, new Map());
          map.get(em)!.set(row.adjust_date, row.approved_hours);
        }
        setApprovedTimeAdjustments(map);
      })
      .catch(() => setApprovedTimeAdjustments(new Map()));
  }, [pabMonthRange]);

  useEffect(() => {
    refreshApprovedAdjustmentOverrides();
  }, [refreshApprovedAdjustmentOverrides]);

  // All time-adjustment requests for the Additions review panel (step 3).
  // No date restriction — requests from any past period are shown to Accounting.
  // Accounting can only ACT on manager_approved rows; pending rows are shown read-only.
  const fetchTimeAdjustmentReview = useCallback(() => {
    fetch(
      `/api/time-adjustments?status=pending&status=manager_approved&status=manager_denied&status=approved&status=denied&limit=500`,
      { cache: 'no-store' },
    )
      .then(r => r.json())
      .then((json: { rows?: TimeAdjustmentRow[]; signedUrls?: Record<string, string> }) => {
        setTimeAdjustmentRows(json.rows ?? []);
        setTimeAdjustmentSignedUrls(json.signedUrls ?? {});
      })
      .catch(() => { setTimeAdjustmentRows([]); setTimeAdjustmentSignedUrls({}); });
  }, []);

  useEffect(() => {
    if (currentStep !== 5) return;
    fetchTimeAdjustmentReview();
  }, [currentStep, fetchTimeAdjustmentReview]);

  // Approved MESA disbursements (accounting-approved, not yet paid out via the
  // Urgent Payments queue) — folded into the Additions MESA column + Final pay.
  const fetchMesaDisbursements = useCallback(() => {
    fetch('/api/mesa-requests?request_type=disbursement&status=approved&limit=500', { cache: 'no-store' })
      .then(r => r.json())
      .then((json: { rows?: Array<{ work_email?: string; amount_needed?: number | null; dispatched_at?: string | null }> }) => {
        const map = new Map<string, number>();
        for (const row of json.rows ?? []) {
          if (row.dispatched_at) continue; // already paid via Urgent Payments
          const em = (row.work_email ?? '').trim().toLowerCase();
          const amt = row.amount_needed ?? 0;
          if (!em || amt <= 0) continue;
          map.set(em, (map.get(em) ?? 0) + amt);
        }
        setMesaDisbursements(map);
      })
      .catch(() => setMesaDisbursements(new Map()));
  }, []);

  // Load approved MESA disbursements as soon as the wizard mounts — and keep them fresh
  // as accounting navigates — NOT only on the Additions step. The final-pay snapshot
  // auto-publishes (debounced) from whatever step is active; gating this fetch on step 5
  // meant a publish fired from any other step saw an empty map → it dropped the ₱100
  // deduction + the disbursement, so the Employee dashboard showed the un-deducted figure
  // even though the wizard's Additions step had it right. Loading it unconditionally keeps
  // every published snapshot consistent with what the wizard computes.
  useEffect(() => {
    fetchMesaDisbursements();
  }, [currentStep, fetchMesaDisbursements]);

  /**
   * Override lookup the PAB memos consume: approved PAB disputes overlaid by approved
   * time adjustments (time adjustments win on a same day — they are the explicit
   * "this is the real number" decision). SET semantics, hours-or-null per date.
   */
  const effectiveOverrides = useMemo<Map<string, Map<string, number | null>>>(() => {
    const map = new Map<string, Map<string, number | null>>();
    for (const [em, dates] of approvedDisputeDates) {
      map.set(em, new Map(dates));
    }
    for (const [em, dates] of approvedTimeAdjustments) {
      if (!map.has(em)) map.set(em, new Map());
      const target = map.get(em)!;
      for (const [d, h] of dates) target.set(d, h);
    }
    return map;
  }, [approvedDisputeDates, approvedTimeAdjustments]);

  /**
   * Raw per-day worked hours per employee (NO overrides applied) for the PAB period.
   * Used to value an approved time adjustment as a pay delta: (SET hours - raw hours)
   * for each in-period adjustment date. Keyed by normalized + raw Hubstaff email.
   */
  const rawDayHoursByEmail = useMemo<Map<string, Map<string, number>>>(() => {
    const map = new Map<string, Map<string, number>>();
    const rows = hubstaffRowsForPab;
    if (!rows || rows.length === 0 || allDaysColumnGroups.length === 0) return map;
    for (const row of rows) {
      const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
      const email = normEmail(rawEmail) ?? rawEmail.toLowerCase();
      if (!email) continue;
      const byDate = new Map<string, number>();
      for (const group of allDaysColumnGroups) {
        const groupDate = isoDateFromColumnGroup(group);
        if (!groupDate) continue;
        byDate.set(groupDate, maxSecondsAcrossWeekdayGroup(row, group) / 3600);
      }
      map.set(email, byDate);
    }
    return map;
  }, [hubstaffRowsForPab, allDaysColumnGroups]);

  /**
   * Per-employee pay delta (in hours) from approved time adjustments: sum of
   * (approved_hours - raw tracked hours) over adjustment dates that fall within the
   * current pay period. Positive values increase pay; folded into initialPay below.
   * Dates outside the period are not credited here (they belong to another cycle).
   */
  const timeAdjustDeltaHoursByEmail = useMemo<Map<string, number>>(() => {
    const delta = new Map<string, number>();
    if (approvedTimeAdjustments.size === 0) return delta;
    const periodDates = new Set<string>();
    for (const group of allDaysColumnGroups) {
      const d = isoDateFromColumnGroup(group);
      if (d) periodDates.add(d);
    }
    for (const [em, dates] of approvedTimeAdjustments) {
      const raw = rawDayHoursByEmail.get(em);
      let d = 0;
      for (const [date, setHours] of dates) {
        if (periodDates.size > 0 && !periodDates.has(date)) continue;
        const rawHours = raw?.get(date) ?? 0;
        d += setHours - rawHours;
      }
      if (d !== 0) delta.set(em, d);
    }
    return delta;
  }, [approvedTimeAdjustments, rawDayHoursByEmail, allDaysColumnGroups]);

  const decideTimeAdjustmentRequest = useCallback(
    async (id: string, action: 'approve' | 'deny', approvedHours: number | null, note?: string) => {
      setDecidingAdjustmentId(id);
      try {
        const res = await fetch(`/api/time-adjustments/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            approved_hours: action === 'approve' ? approvedHours : null,
            decision_note: note ?? null,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'Failed to update request');
        toast.success(action === 'approve' ? 'Time adjustment approved' : 'Time adjustment denied');
        fetchTimeAdjustmentReview();
        refreshApprovedAdjustmentOverrides();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to update request');
      } finally {
        setDecidingAdjustmentId(null);
      }
    },
    [fetchTimeAdjustmentReview, refreshApprovedAdjustmentOverrides],
  );

  const deleteTimeAdjustmentRequest = useCallback(
    async (id: string) => {
      setDeletingAdjustmentId(id);
      try {
        const res = await fetch(`/api/time-adjustments/${id}`, { method: 'DELETE' });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'Failed to delete request');
        toast.success('Request deleted');
        fetchTimeAdjustmentReview();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to delete request');
      } finally {
        setDeletingAdjustmentId(null);
      }
    },
    [fetchTimeAdjustmentReview],
  );

  useEffect(() => {
    if (currentStep !== 5 || !pabMonthRange) return;
    const s = pabMonthRange.start;
    const e = pabMonthRange.end;
    const from = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
    const dayAfterEnd = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1);
    const to = `${dayAfterEnd.getFullYear()}-${String(dayAfterEnd.getMonth() + 1).padStart(2, '0')}-${String(dayAfterEnd.getDate()).padStart(2, '0')}`;
    fetch(`/api/pab-disputes?status=pending&status=approved&status=accounting_approved&from=${from}&to=${to}&limit=500`, { cache: 'no-store' })
      .then(r => r.json())
      .then((json: { rows?: Array<{ id: string; work_email: string; dispute_date: string; reason: string; explanation: string | null; created_by: string | null; status: string }> }) => {
        setPendingDisputeRows(json.rows ?? []);
      })
      .catch(() => setPendingDisputeRows([]));
  }, [currentStep, pabMonthRange]);

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

      const forgivenDates = effectiveOverrides.get(email);
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
          const isHoliday = usHolidayDates.has(groupDate);
          const recordedSeconds = (isForgiven || isHoliday) ? 7 * 3600 : effectiveSeconds;
          const [y, m, d] = groupDate.split('-').map(Number);
          hoursByDateKey.set(pabDateKey(new Date(y, m - 1, d)), recordedSeconds);
        }
        if (checkHslPabEligibility(pabMonthRange.start, hslAdjustedPabEnd ?? pabMonthRange.end, hoursByDateKey)) {
          eligible.add(email);
        }
      } else {
        // Standard rule: all Mon–Fri days must be ≥7 h (dispute / holiday forgiveness applied).
        let perfect = true;
        for (const group of weekdayColumnGroups) {
          const rawSeconds = maxSecondsAcrossWeekdayGroup(row, group);
          const groupDate = isoDateFromColumnGroup(group);
          // US holidays auto-pass — no override hours needed, the day just doesn't count against PAB.
          if (groupDate && usHolidayDates.has(groupDate)) continue;
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
    // Accountant exclusions for this month forfeit PAB regardless of attendance.
    // Dropping them here cascades to the auto-applied `perfect_attendance` toggle
    // (→ ₱0 in bonusTotals + dispatch), matching the authoritative pay path.
    if (pabExcludedActiveMonth.size > 0) {
      for (const ex of pabExcludedActiveMonth) eligible.delete(ex);
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
    effectiveOverrides,
    usHolidayDates,
    employeeDepts,
    pabExcludedActiveMonth,
  ]);

  /**
   * Per-employee weekday breakdown for the PAB period (merged month). Used in the PA cell.
   */
  const employeeWeekdayHours = useMemo<
    Map<string, { col: string; seconds: number; passes: boolean; forgivenByDispute: boolean; forgivenByHoliday: boolean; holidayName: string | null }[]>
  >(() => {
    const rows = hubstaffRowsForPab;
    if (!rows || rows.length === 0) return new Map();
    if (weekdayColumnGroups.length === 0) return new Map();

    const map = new Map<string, { col: string; seconds: number; passes: boolean; forgivenByDispute: boolean; forgivenByHoliday: boolean; holidayName: string | null }[]>();
    for (const row of rows) {
      const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
      const email = normEmail(rawEmail) ?? rawEmail.toLowerCase();
      if (!email) continue;
      const forgivenDates = effectiveOverrides.get(email);
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
          const holidayName = groupDate ? (usHolidayDates.get(groupDate) ?? null) : null;
          const isHoliday = holidayName !== null;
          const disputeForgiven = !!(groupDate && forgivenDates?.has(groupDate) && seconds >= 4 * 3600 && seconds < 7 * 3600);
          // Holidays take precedence over dispute classification — a holiday day passes regardless of hours
          const holidayForgiven = isHoliday && seconds < 7 * 3600;
          return {
            col,
            seconds,
            passes: seconds >= 7 * 3600 || disputeForgiven || isHoliday,
            forgivenByDispute: disputeForgiven && !holidayForgiven,
            forgivenByHoliday: holidayForgiven,
            holidayName,
          };
        }),
      );
    }
    return map;
  }, [hubstaffRowsForPab, weekdayColumnGroups, effectiveOverrides, usHolidayDates]);

  /**
   * Per-employee Mon–Sun breakdown for HSL PAB display. Same structure as
   * employeeWeekdayHours but uses allDaysColumnGroups so Sat/Sun are included.
   */
  const employeeAllDaysHours = useMemo<
    Map<string, { col: string; seconds: number; passes: boolean; forgivenByDispute: boolean; forgivenByHoliday: boolean; holidayName: string | null }[]>
  >(() => {
    const rows = hubstaffRowsForPab;
    if (!rows || rows.length === 0) return new Map();
    if (allDaysColumnGroups.length === 0) return new Map();

    const map = new Map<string, { col: string; seconds: number; passes: boolean; forgivenByDispute: boolean; forgivenByHoliday: boolean; holidayName: string | null }[]>();
    for (const row of rows) {
      const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
      const email = normEmail(rawEmail) ?? rawEmail.toLowerCase();
      if (!email) continue;
      const forgivenDates = effectiveOverrides.get(email);
      map.set(
        email,
        allDaysColumnGroups.map(group => {
          const col = pickPreferredHubstaffColumn(group);
          const rawSeconds = maxSecondsAcrossWeekdayGroup(row, group);
          const groupDate = isoDateFromColumnGroup(group);
          const overrideHours = groupDate != null ? forgivenDates?.get(groupDate) : undefined;
          const seconds = overrideHours != null ? overrideHours * 3600 : rawSeconds;
          const holidayName = groupDate ? (usHolidayDates.get(groupDate) ?? null) : null;
          const isHoliday = holidayName !== null;
          const disputeForgiven = !!(groupDate && forgivenDates?.has(groupDate) && seconds >= 4 * 3600 && seconds < 7 * 3600);
          const holidayForgiven = isHoliday && seconds < 7 * 3600;
          return {
            col,
            seconds,
            passes: seconds >= 7 * 3600 || disputeForgiven || isHoliday,
            forgivenByDispute: disputeForgiven && !holidayForgiven,
            forgivenByHoliday: holidayForgiven,
            holidayName,
          };
        }),
      );
    }
    return map;
  }, [hubstaffRowsForPab, allDaysColumnGroups, effectiveOverrides, usHolidayDates]);

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
      // Accountant-excluded → locked ineligible for this month (the PA cell shows
      // a distinct "Excluded" badge; this keeps the saved snapshot honest).
      if (pabExcludedActiveMonth.has(email)) {
        map.set(email, 'ineligible');
        continue;
      }
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
  }, [pabMonthRange, employeeWeekdayHours, perfectAttendanceEligible, employeeDepts, pabExcludedActiveMonth]);

  // When a locked snapshot exists, use it so values don't change on refresh.
  const effectivePabStatus = useMemo<Map<string, 'eligible' | 'ineligible' | 'in_progress'>>(() => {
    if (!lockedPabSnapshot) return pabStatusByEmail;
    const snap = new Map(Object.entries(lockedPabSnapshot)) as Map<string, 'eligible' | 'ineligible' | 'in_progress'>;
    // A snapshot frozen mid-period carries 'in_progress' verdicts. Once the PAB
    // period has ended, those employees are locked-in eligible for the rest of the
    // interim (until the next PAB is initiated) — "In Progress" is now stale. Resolve
    // them from the live computation so the pill, its +₱ amount, and the PAB total all
    // read "Eligible" instead. Live eligible/ineligible verdicts stay frozen.
    if (pabMonthRange) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const endDay = new Date(pabMonthRange.end);
      endDay.setHours(0, 0, 0, 0);
      if (today.getTime() > endDay.getTime()) {
        for (const [email, status] of snap.entries()) {
          if (status === 'in_progress') snap.set(email, pabStatusByEmail.get(email) ?? 'eligible');
        }
      }
    }
    return snap;
  }, [lockedPabSnapshot, pabStatusByEmail, pabMonthRange]);

  const saveAdditionsProgress = React.useCallback(async (opts?: { orphanageAmounts?: Record<string, number> }) => {
    if (!calcSourceFile) {
      toast.error('No source file selected to lock progress against.');
      return;
    }
    if (isReplay) {
      toast.error('Replaying a past period is view-only', { description: 'Return to the current period to make changes.' });
      return;
    }
    setAdditionsSaving(true);
    try {
      // Callers that just batch-wrote orphanageAmounts (e.g. the Orphanage paste tool)
      // pass the fresh map explicitly — the closure's `orphanageAmounts` is a render behind.
      const orphanageAmountsToSave = opts?.orphanageAmounts ?? orphanageAmounts;
      const payload = {
        bonusOverrides,
        bonusOverrideNotes,
        orphanageAmounts: orphanageAmountsToSave,
        employeeMetrics,
        deptMetrics,
        employeeDepts,
        employeeBonuses,
        techBonusManualGrants: Array.from(techBonusManualGrants),
        techBonusManualRevokes: Array.from(techBonusManualRevokes),
        pabStatusSnapshot: Object.fromEntries(pabStatusByEmail),
      };
      await savePabSetting(`payroll.wizard.additions.${calcSourceFile}`, JSON.stringify(payload));
      setAdditionsSavedAt(new Date());
      setLockedPabSnapshot(Object.fromEntries(pabStatusByEmail) as Record<string, 'eligible' | 'ineligible' | 'in_progress'>);
      toast.success('Additions progress locked in');
    } catch (e) {
      toast.error('Failed to lock in additions', { description: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setAdditionsSaving(false);
    }
  }, [calcSourceFile, isReplay, bonusOverrides, bonusOverrideNotes, orphanageAmounts, employeeMetrics, deptMetrics, employeeDepts, employeeBonuses, techBonusManualGrants, techBonusManualRevokes, pabStatusByEmail, savePabSetting]);

  /**
   * US-holiday forgiveness summary scoped to the current pay-period WEEK: for each
   * holiday that falls inside the week being dispatched, which employees had that day
   * waived (zero/under-7h hours that no longer block PAB). Used by the Validation step
   * to show what was forgiven.
   */
  const usHolidayForgivenSummary = useMemo<
    { iso: string; name: string; date: Date; forgivenEmails: string[]; workedThroughEmails: string[]; isForgivenEnabled: boolean }[]
  >(() => {
    if (!pabMonthRange) return [];
    // Scope to the CURRENT pay-period week, not the whole PAB month: a holiday only
    // belongs in the Validation banner if it actually falls inside the week being
    // dispatched. The week's date span comes from the selected Hubstaff source file
    // (e.g. `...2026-05-24_to_2026-05-30.csv`). Month-wide scoping was the old bug —
    // e.g. Memorial Day (last Mon of May) kept showing on every later May/June report.
    // Falls back to the active PAB month only when no source file is selected (no
    // concrete week to scope to).
    const weekRange = calcSourceFile ? parseDateRangeFromFilename(calcSourceFile) : null;
    let startT: number;
    let endT: number;
    if (weekRange) {
      const lo = weekRange.start;
      const hi = weekRange.end;
      startT = new Date(lo.getFullYear(), lo.getMonth(), lo.getDate()).getTime();
      endT   = new Date(hi.getFullYear(), hi.getMonth(), hi.getDate()).getTime();
    } else {
      startT = new Date(pabMonthRange.year, pabMonthRange.month, 1).getTime();
      endT   = new Date(pabMonthRange.year, pabMonthRange.month + 1, 0).getTime();
    }

    // Use the full list so accounting sees every holiday in the period,
    // even if auto-forgiveness is disabled for that entry.
    const inRangeHolidays: { iso: string; name: string; date: Date; isForgivenEnabled: boolean }[] = [];
    for (const h of usHolidaysListFull) {
      const [y, m, d] = h.date.split('-').map(Number);
      if (!y || !m || !d) continue;
      const date = new Date(y, m - 1, d);
      const t = date.getTime();
      if (t < startT || t > endT) continue;
      inRangeHolidays.push({ iso: h.date, name: h.name, date, isForgivenEnabled: usHolidaysMasterEnabled && h.enabled });
    }
    inRangeHolidays.sort((a, b) => a.date.getTime() - b.date.getTime());

    if (inRangeHolidays.length === 0) return [];

    const out: { iso: string; name: string; date: Date; forgivenEmails: string[]; workedThroughEmails: string[]; isForgivenEnabled: boolean }[] = [];
    for (const h of inRangeHolidays) {
      const forgiven: string[] = [];
      const worked: string[] = [];
      // Walk both breakdown maps — HSL employees live in allDaysHours, standard in weekdayHours
      const visited = new Set<string>();
      const consider = (email: string, breakdown: { col: string; seconds: number; forgivenByHoliday: boolean }[]) => {
        if (visited.has(email)) return;
        visited.add(email);
        for (const entry of breakdown) {
          const d = parseColDate(entry.col);
          if (!d) continue;
          const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          if (iso !== h.iso) continue;
          if (entry.forgivenByHoliday) forgiven.push(email);
          else if (entry.seconds >= 7 * 3600) worked.push(email);
          break;
        }
      };
      for (const [email, bd] of employeeAllDaysHours.entries()) consider(email, bd);
      for (const [email, bd] of employeeWeekdayHours.entries()) consider(email, bd);
      out.push({ ...h, forgivenEmails: forgiven, workedThroughEmails: worked });
    }
    return out;
  }, [pabMonthRange, calcSourceFile, usHolidaysListFull, usHolidaysMasterEnabled, employeeWeekdayHours, employeeAllDaysHours]);

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

  // ── Audit: stable ref holding the latest values referenced by the
  // additions/adjustments handlers. Lets handlers stay `useCallback([])`
  // while still reading fresh state for old-vs-new diffing.
  const auditCtxRef = useRef({
    sessionEmail: sessionEmail ?? null,
    auditCycle,
    employeeBonuses,
    employeeDepts,
    bonusOverrides,
    orphanageAmounts,
    employeeMetrics,
    deptMetrics,
  });
  useEffect(() => {
    auditCtxRef.current = {
      sessionEmail: sessionEmail ?? null,
      auditCycle,
      employeeBonuses,
      employeeDepts,
      bonusOverrides,
      orphanageAmounts,
      employeeMetrics,
      deptMetrics,
    };
  }, [
    sessionEmail,
    auditCycle,
    employeeBonuses,
    employeeDepts,
    bonusOverrides,
    orphanageAmounts,
    employeeMetrics,
    deptMetrics,
  ]);

  const toggleEmployeeBonus = React.useCallback((email: string, bonusId: string, enabled: boolean) => {
    if (isReplayRef.current) return; // view-only replay of a past period
    const ctx = auditCtxRef.current;
    const prevValue = ctx.employeeBonuses[email]?.[bonusId] ?? false;
    setEmployeeBonuses(prev => ({
      ...prev,
      [email]: { ...(prev[email] ?? {}), [bonusId]: enabled },
    }));
    if (valuesDiffer(prevValue, enabled)) {
      void logAudit({
        user_name: ctx.sessionEmail ?? 'anonymous',
        user_role: sessionRole ?? 'user',
        action: 'wizard.bonus_edited',
        resource: 'employee_bonus',
        resource_id: email,
        cycle: ctx.auditCycle,
        details: {
          employee_email: email,
          field: bonusId,
          previous_value: prevValue,
          new_value: enabled,
        },
      });
    }
  }, []);

  const assignToDept = React.useCallback((email: string, deptKey: string) => {
    const ctx = auditCtxRef.current;
    const prevValue = ctx.employeeDepts[email] ?? null;
    setEmployeeDepts(prev => ({ ...prev, [email]: deptKey }));
    if (valuesDiffer(prevValue, deptKey)) {
      void logAudit({
        user_name: ctx.sessionEmail ?? 'anonymous',
        user_role: sessionRole ?? 'user',
        action: 'wizard.addition_edited',
        resource: 'employee_department',
        resource_id: email,
        cycle: ctx.auditCycle,
        details: {
          employee_email: email,
          field: 'department',
          previous_value: prevValue,
          new_value: deptKey,
        },
      });
    }
  }, []);

  const removeFromDept = React.useCallback((email: string) => {
    const ctx = auditCtxRef.current;
    const prevValue = ctx.employeeDepts[email] ?? null;
    setEmployeeDepts(prev => {
      const next = { ...prev };
      delete next[email];
      return next;
    });
    if (prevValue !== null) {
      void logAudit({
        user_name: ctx.sessionEmail ?? 'anonymous',
        user_role: sessionRole ?? 'user',
        action: 'wizard.addition_edited',
        resource: 'employee_department',
        resource_id: email,
        cycle: ctx.auditCycle,
        details: {
          employee_email: email,
          field: 'department',
          previous_value: prevValue,
          new_value: null,
        },
      });
    }
  }, []);

  const applyBonusToAllInDept = React.useCallback((
    bonusId: string,
    _deptKey: string,
    enabled: boolean,
    emailsInDept: string[],
  ) => {
    const ctx = auditCtxRef.current;
    const changedEmails: string[] = [];
    for (const email of emailsInDept) {
      const prev = ctx.employeeBonuses[email]?.[bonusId] ?? false;
      if (valuesDiffer(prev, enabled)) changedEmails.push(email);
    }
    setEmployeeBonuses(prev => {
      const next = { ...prev };
      for (const email of emailsInDept) {
        next[email] = { ...(next[email] ?? {}), [bonusId]: enabled };
      }
      return next;
    });
    if (changedEmails.length > 0) {
      void logAudit({
        user_name: ctx.sessionEmail ?? 'anonymous',
        user_role: sessionRole ?? 'user',
        action: 'wizard.bonus_edited',
        resource: 'employee_bonus_bulk',
        resource_id: _deptKey,
        cycle: ctx.auditCycle,
        details: {
          department: _deptKey,
          field: bonusId,
          new_value: enabled,
          changed_count: changedEmails.length,
          total_count: emailsInDept.length,
          changed_emails: changedEmails,
        },
      });
    }
  }, []);

  const updateEmployeeMetric = React.useCallback((email: string, metric: string, value: number) => {
    if (isReplayRef.current) return; // view-only replay of a past period
    const ctx = auditCtxRef.current;
    const prevValue = ctx.employeeMetrics[email]?.[metric];
    setEmployeeMetrics(prev => ({
      ...prev,
      [email]: { ...(prev[email] ?? {}), [metric]: value },
    }));
    if (valuesDiffer(prevValue ?? 0, value)) {
      void logAudit({
        user_name: ctx.sessionEmail ?? 'anonymous',
        user_role: sessionRole ?? 'user',
        action: 'wizard.addition_edited',
        resource: 'employee_metric',
        resource_id: email,
        cycle: ctx.auditCycle,
        details: {
          employee_email: email,
          field: metric,
          previous_value: prevValue ?? null,
          new_value: value,
        },
      });
    }
  }, []);

  const updateDeptMetric = React.useCallback((deptKey: string, metric: string, value: number) => {
    if (isReplayRef.current) return; // view-only replay of a past period
    const ctx = auditCtxRef.current;
    const prevValue = ctx.deptMetrics[deptKey]?.[metric];
    setDeptMetrics(prev => ({
      ...prev,
      [deptKey]: { ...(prev[deptKey] ?? {}), [metric]: value },
    }));
    if (valuesDiffer(prevValue ?? 0, value)) {
      void logAudit({
        user_name: ctx.sessionEmail ?? 'anonymous',
        user_role: sessionRole ?? 'user',
        action: 'wizard.addition_edited',
        resource: 'dept_metric',
        resource_id: deptKey,
        cycle: ctx.auditCycle,
        details: {
          department: deptKey,
          field: metric,
          previous_value: prevValue ?? null,
          new_value: value,
        },
      });
    }
  }, []);

  /**
   * Updates a per-employee manual bonus override.
   *   - value=number → set the override
   *   - value=null   → clear the override (revert to auto-computed)
   * Audited as `wizard.bonus_edited` with the old → new diff so reviewers can
   * see exactly which manual overrides changed.
   */
  const updateBonusOverride = React.useCallback((email: string, value: number | null) => {
    if (isReplayRef.current) return; // view-only replay of a past period
    const ctx = auditCtxRef.current;
    const prevValue = ctx.bonusOverrides[email] ?? null;
    setBonusOverrides(prev => {
      const next = { ...prev };
      if (value === null) delete next[email];
      else next[email] = value;
      return next;
    });
    // Clearing the adjustment also drops its note — they have no meaning apart.
    if (value === null) {
      setBonusOverrideNotes(prev => {
        if (!(email in prev)) return prev;
        const next = { ...prev };
        delete next[email];
        return next;
      });
    }
    if (valuesDiffer(prevValue, value)) {
      void logAudit({
        user_name: ctx.sessionEmail ?? 'anonymous',
        user_role: sessionRole ?? 'user',
        action: 'wizard.bonus_edited',
        resource: 'bonus_override',
        resource_id: email,
        cycle: ctx.auditCycle,
        details: {
          employee_email: email,
          field: 'bonus_override_php',
          previous_value: prevValue,
          new_value: value,
        },
      });
    }
  }, []);

  /** Set/clear the free-text note attached to an employee's adjustment. Empty text removes it. */
  const updateBonusOverrideNote = React.useCallback((email: string, note: string) => {
    if (isReplayRef.current) return; // view-only replay of a past period
    setBonusOverrideNotes(prev => {
      const next = { ...prev };
      if (note.trim() === '') delete next[email];
      else next[email] = note;
      return next;
    });
  }, []);

  /** Set/clear the per-employee Orphanage pay (PHP). A positive amount added on top of
   *  final pay; `null` clears it. Mirrors {@link updateBonusOverride}. */
  const updateOrphanageAmount = React.useCallback((email: string, value: number | null) => {
    if (isReplayRef.current) return; // view-only replay of a past period
    const ctx = auditCtxRef.current;
    const prevValue = ctx.orphanageAmounts[email] ?? null;
    setOrphanageAmounts(prev => {
      const next = { ...prev };
      if (value === null) delete next[email];
      else next[email] = value;
      return next;
    });
    if (valuesDiffer(prevValue, value)) {
      void logAudit({
        user_name: ctx.sessionEmail ?? 'anonymous',
        user_role: sessionRole ?? 'user',
        action: 'wizard.addition_edited',
        resource: 'orphanage_pay',
        resource_id: email,
        cycle: ctx.auditCycle,
        details: {
          employee_email: email,
          field: 'orphanage_pay_php',
          previous_value: prevValue,
          new_value: value,
        },
      });
    }
  }, []);

  /**
   * Single source of truth for which calendar days each employee is paid for in
   * this cycle. Hogan (HSL) is paid Monday→Sunday; every other department is paid
   * Sunday→Saturday. Hubstaff exports a Sunday→Sunday span (one overlap day), so we
   * read the daily columns and keep only the dates that fall inside the employee's
   * own week — the leading Sunday belongs to HSL's week, the trailing Sunday to the
   * next non-HSL week. Days are returned chronologically.
   */
  const payDaysByEmail = useMemo<Map<string, { isHsl: boolean; days: Array<{ date: Date; seconds: number }> }>>(() => {
    const map = new Map<string, { isHsl: boolean; days: Array<{ date: Date; seconds: number }> }>();
    // Prefer the cross-upload merged rows (one row per employee, every upload
    // resolved to its TRUE ISO dates via its own filename) so a pay week's
    // boundary Sunday is sourced from the adjacent upload — e.g. the non-HSL
    // week May 31–Jun 6 gets May 31's hours from the "May 24→31" upload, since
    // the current "May 31→Jun 7" upload's lone `sunday` column holds Jun 7 after
    // the DB's last-wins collapse. Falls back to the single current file while
    // the merge is still loading.
    const rows = hubstaffRowsForPab ?? hubstaffDisplayRows;
    if (!rows || rows.length === 0) return map;
    const fileRange = calcSourceFile ? parseDateRangeFromFilename(calcSourceFile) : null;

    for (const row of rows) {
      const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
      const em = normEmail(rawEmail) ?? rawEmail.toLowerCase();
      if (!em) continue;
      const deptKey = employeeDepts[rawEmail] ?? employeeDepts[rawEmail.toLowerCase()];
      const isHsl = deptKey === 'hogan_smith_law';

      // Resolve canonical weekday columns (sunday/monday/…) onto the file's TRUE
      // ISO dates, then let the pay-week window below clamp to this employee's
      // 7 days. Resolving straight onto the dept pay week (the old approach) forced
      // the lone `sunday` slot — which holds the file's TRAILING Sunday after the
      // DB's last-wins collapse — onto whatever Sunday sat in the window, so a
      // Mon→Sun upload leaked the trailing Sunday's hours into the non-HSL
      // (Sun→Sat) week. Mapping to real dates lets the window exclude it instead.
      const anchor = fileRange?.start ?? null;
      let resolvedRow: Record<string, unknown> = row;
      if (anchor && calcSourceFile && columnsAreAllCanonical(Object.keys(row))) {
        resolvedRow = resolveCanonicalColumnsToIso(row, calcSourceFile);
      }

      const allDays: Array<{ date: Date; seconds: number }> = [];
      for (const [k, v] of Object.entries(resolvedRow)) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k.trim());
        if (!m) continue;
        const hrs = parseHoursToDecimal(v);
        if (hrs <= 0) continue;
        allDays.push({ date: new Date(+m[1], +m[2] - 1, +m[3]), seconds: Math.round(hrs * 3600) });
      }
      if (allDays.length === 0) continue;

      // The employee's pay week, anchored on the upload's start date.
      const start = anchor ?? allDays.reduce((min, d) => (d.date < min ? d.date : min), allDays[0].date);
      const week = payWeekFromUploadStart(start, isHsl);
      const lo = week.start.getTime();
      const hi = week.end.getTime();
      const days = allDays
        .filter((d) => {
          const t = new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate()).getTime();
          return t >= lo && t <= hi;
        })
        .sort((a, b) => a.date.getTime() - b.date.getTime());
      if (days.length > 0) map.set(em, { isHsl, days });
    }
    return map;
  }, [hubstaffRowsForPab, hubstaffDisplayRows, calcSourceFile, employeeDepts]);

  /**
   * Paid hours per employee = sum of their pay-week days, with the 40 h/week
   * regular cap applied chronologically (the rest is OT). Used as the authoritative
   * hours for the dispatch when daily columns are available; rows with no daily
   * columns fall back to the CSV "Total worked" aggregate in calcResults.
   */
  const payHoursByEmail = useMemo<Map<string, { totalSec: number; regularSec: number; otSec: number }>>(() => {
    const map = new Map<string, { totalSec: number; regularSec: number; otSec: number }>();
    const REG_CAP_SEC = 40 * 3600;
    for (const [em, { days }] of payDaysByEmail) {
      let usedReg = 0, totalSec = 0, regularSec = 0, otSec = 0;
      for (const d of days) {
        const remaining = Math.max(0, REG_CAP_SEC - usedReg);
        const dayReg = Math.min(d.seconds, remaining);
        usedReg += dayReg;
        totalSec += d.seconds;
        regularSec += dayReg;
        otSec += d.seconds - dayReg;
      }
      map.set(em, { totalSec, regularSec, otSec });
    }
    return map;
  }, [payDaysByEmail]);

  /**
   * HSL weekend pay premium: +15 PHP/h for Saturday and Sunday hours within the
   * HSL (Mon→Sun) pay week, split between the regular and OT buckets chronologically.
   */
  const weekendPremiumByEmail = useMemo<Map<string, { regPremiumPHP: number; otPremiumPHP: number }>>(() => {
    const map = new Map<string, { regPremiumPHP: number; otPremiumPHP: number }>();
    const REG_CAP_SEC = 40 * 3600;
    for (const [em, { isHsl, days }] of payDaysByEmail) {
      if (!isHsl) continue;
      let usedRegSec = 0, wkndRegSec = 0, wkndOtSec = 0;
      for (const d of days) {
        const remaining = Math.max(0, REG_CAP_SEC - usedRegSec);
        const dayRegSec = Math.min(d.seconds, remaining);
        const dayOtSec = d.seconds - dayRegSec;
        usedRegSec += dayRegSec;
        const dow = d.date.getDay();
        if (dow === 0 || dow === 6) {
          wkndRegSec += dayRegSec;
          wkndOtSec += dayOtSec;
        }
      }
      const regPremiumPHP = phpHourlyPayFromSeconds(15, wkndRegSec);
      const otPremiumPHP = phpHourlyPayFromSeconds(15, wkndOtSec);
      if (regPremiumPHP !== 0 || otPremiumPHP !== 0) {
        map.set(em, { regPremiumPHP, otPremiumPHP });
      }
    }
    return map;
  }, [payDaysByEmail]);

  /**
   * Match Hubstaff Email to employee_hourly_rates Work Email (or Personal Email).
   * Reg Pay = Reg Rate × Reg Hrs, OT Pay = OT Rate × OT Hrs (Reg Hrs = min(Total, 40), OT = rest).
   * Total hours rounded to 2dp (Hubstaff-style) before split; pay uses whole seconds + centavo rounding.
   * HSL employees receive an additional +15 PHP/h for Saturday and Sunday hours.
   */
  const calcResults = useMemo<CalcRow[]>(() => {
    return hubstaffData.map((row) => {
      const em = normEmail(row.email);

      // Authoritative hours = the employee's pay-week days (Mon→Sun for HSL,
      // Sun→Sat for everyone else). Falls back to the CSV "Total worked" aggregate
      // only when the row has no daily columns to read.
      const paid = em ? payHoursByEmail.get(em) : undefined;
      let totalH: number;
      let regularSec: number;
      let otSec: number;
      if (paid) {
        totalH = roundWorkedHoursForPay(paid.totalSec / 3600);
        regularSec = paid.regularSec;
        otSec = paid.otSec;
      } else {
        totalH = roundWorkedHoursForPay(row.decimalHours);
        ({ regularSec, otSec } = splitRegularOvertimeSeconds(totalH));
      }
      const regularHours = regularSec / 3600;
      const otHours = otSec / 3600;

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

      let regularPay =
        regularRate != null ? phpHourlyPayFromSeconds(regularRate, regularSec) : null;
      let otPay =
        otSec > 0 ? (otRate != null ? phpHourlyPayFromSeconds(otRate, otSec) : null) : 0;

      // Apply HSL weekend premium (+15 PHP/h for Sat/Sun hours, split by reg/OT bucket)
      const wknd = em ? weekendPremiumByEmail.get(em) : undefined;
      if (wknd) {
        if (regularPay != null) regularPay = Math.round((regularPay + wknd.regPremiumPHP) * 100) / 100;
        if (otPay != null) otPay = Math.round((otPay + wknd.otPremiumPHP) * 100) / 100;
      }

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
  }, [hubstaffData, ratesByEmail, masterIndex, weekendPremiumByEmail, payHoursByEmail]);

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

      let base = row;
      if (!deptOtOn) {
        base = {
          ...row,
          otHours: 0,
          otPay: 0,
          initialPay: row.regularPay != null ? Math.round(row.regularPay * 100) / 100 : null,
        };
      }

      // Approved time-adjustment pay delta: (corrected - raw) hours for in-period dates,
      // valued at the regular rate, folded into initialPay so all downstream totals
      // (final pay, dispatch) reflect the corrected time. Never mutates Hubstaff data.
      const em = normEmail(row.email) ?? row.email.toLowerCase();
      const adjHours =
        timeAdjustDeltaHoursByEmail.get(em) ?? timeAdjustDeltaHoursByEmail.get(row.email) ?? 0;
      if (adjHours !== 0 && base.regularRate != null && base.initialPay != null) {
        const adjPesos =
          adjHours >= 0
            ? phpHourlyPayFromSeconds(base.regularRate, adjHours * 3600)
            : -phpHourlyPayFromSeconds(base.regularRate, -adjHours * 3600);
        base = { ...base, initialPay: Math.round((base.initialPay + adjPesos) * 100) / 100 };
      }
      return base;
    });
  }, [calcResults, employeeDepts, otGlobalSuspended, otDeptEnabled, timeAdjustDeltaHoursByEmail]);

  /**
   * Orphanage paste tool (step 3): parse pasted "Pay week ⇥ Work email ⇥ Hours" TSV
   * and resolve each row to an Additions employee + a PHP amount (hours × regular rate).
   * Pay week is informational only — every matched row applies to the period being
   * edited. Matching is by work email (case-insensitive, trimmed), bridged through the
   * master list so a person's alternate / personal / Hubstaff email still finds their row.
   */
  const orphanagePasteParse = useMemo<OrphanagePasteParse>(() => {
    const ok: OrphanagePasteOk[] = [];
    const errors: OrphanagePasteErr[] = [];
    if (!orphanagePaste.trim()) return { ok, errors };

    // Index every Additions row by each normalized email we can attach to it.
    const rowByEmail = new Map<string, CalcRow>();
    for (const r of effectiveCalcResults) {
      const k = normEmail(r.email) ?? r.email.trim().toLowerCase();
      if (k && !rowByEmail.has(k)) rowByEmail.set(k, r);
    }

    const seenKeys = new Set<string>();
    let headerHandled = false;
    const lines = orphanagePaste.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw || !raw.trim()) continue;
      // Spreadsheet paste is tab-delimited. Fall back to comma / 2+ spaces only when
      // the line has no tabs at all (hand-typed input).
      const cells = (raw.includes('\t') ? raw.split('\t') : raw.split(/,|\s{2,}/)).map((c) => c.trim());
      const payWeekRaw = cells[0] ?? '';
      const emailRaw = cells[1] ?? '';
      const hoursRaw = cells[2] ?? '';

      // Treat only the first content line as a possible header ("Pay week / Email / Hours").
      if (!headerHandled) {
        headerHandled = true;
        if (!emailRaw.includes('@') && (/pay\s*week/i.test(payWeekRaw) || /e-?mail/i.test(emailRaw))) continue;
      }

      if (cells.filter(Boolean).length < 3) {
        errors.push({ line: i + 1, email: emailRaw, reason: 'Expected 3 columns: Pay week, Work email, Hours' });
        continue;
      }

      const emKey = normEmail(emailRaw);
      if (!emKey) {
        errors.push({ line: i + 1, email: emailRaw, reason: 'Missing or invalid email' });
        continue;
      }

      const hours = Number(hoursRaw.replace(/,/g, ''));
      if (!Number.isFinite(hours) || hours < 0) {
        errors.push({ line: i + 1, email: emailRaw, reason: `Invalid hours: "${hoursRaw}"` });
        continue;
      }

      // Resolve the pasted work email → an Additions row. Direct hit first, then
      // bridge through the master list (alternate / personal / Hubstaff-email mismatches).
      let row = rowByEmail.get(emKey) ?? null;
      if (!row) {
        const master = masterIndex.byWorkEmail.get(emKey) ?? masterIndex.byPersonalEmail.get(emKey);
        if (master) {
          const candidates = [master.work_email, master.personal_email, master.alternate_work_email, master.alternate_work_email_2]
            .map((x) => normEmail(x ?? ''))
            .filter((x): x is string => !!x);
          for (const c of candidates) {
            const hit = rowByEmail.get(c);
            if (hit) { row = hit; break; }
          }
        }
      }
      if (!row) {
        errors.push({ line: i + 1, email: emailRaw, reason: 'No employee in this pay period matches that work email' });
        continue;
      }

      // The Orphanage column holds one value per person, so a repeat in the paste is an error.
      if (seenKeys.has(row.email)) {
        errors.push({ line: i + 1, email: emailRaw, reason: 'Duplicate — this employee already appears above in the paste' });
        continue;
      }

      // PHP regular rate. Prefer the row's computed rate; fall back to the rates index.
      let rate: number | null = row.regularRate;
      if (rate == null) {
        const rr = ratesByEmail.get(normEmail(row.email) ?? row.email.toLowerCase()) ?? ratesByEmail.get(emKey);
        rate = rr ? parseRateField(rr.regular_rate) : null;
      }
      if (rate == null) {
        errors.push({ line: i + 1, email: emailRaw, reason: 'No pay rate on file — set their rate, then re-paste' });
        continue;
      }

      // Overtime awareness: the orphanage hours stack on the employee's already-worked
      // hours against the 40h/week regular cap. Hours that still fit under 40 pay at the
      // regular rate; anything beyond crosses into OT (e.g. worked 39h → 1 orphanage hour
      // is regular, the rest is OT). Honors the same global / per-department OT switches as
      // the Initial Calculation. When OT is off for their dept, every hour stays regular.
      const deptKey = employeeDepts[row.email];
      const deptOtOn = otGlobalSuspended
        ? false
        : (deptKey ? (otDeptEnabled[`ot_dept_${deptKey}`] ?? true) : true);
      const otRate = row.otRate;
      let regH = hours;
      let otH = 0;
      if (deptOtOn) {
        const regCapacityLeft = Math.max(0, 40 - row.regularHours);
        regH = Math.min(hours, regCapacityLeft);
        otH = Math.round((hours - regH) * 1e6) / 1e6; // de-noise float subtraction
      }
      if (otH > 0 && otRate == null) {
        errors.push({ line: i + 1, email: emailRaw, reason: `Hours cross into overtime (over 40h) but no OT rate on file` });
        continue;
      }

      seenKeys.add(row.email);
      ok.push({
        line: i + 1,
        payWeek: payWeekRaw,
        emailKey: row.email,
        matchedEmail: emKey,
        name: row.name || row.email,
        hours,
        rate,
        otRate,
        regH,
        otH,
        amount: Math.round((regH * rate + otH * (otRate ?? 0)) * 100) / 100,
      });
    }
    return { ok, errors };
  }, [orphanagePaste, effectiveCalcResults, masterIndex, ratesByEmail, employeeDepts, otGlobalSuspended, otDeptEnabled]);

  /**
   * Tech Bonus week detection — mirrors the logic inside `dispatchData` but
   * lifted to component scope so the Additions table + Validation totals can
   * see it. The dispatch step's per-row formula still works because it ORs in
   * `toggles.tech_bonus`, which the auto-toggle effect below flips on.
   *
   * Salary date = weekStart + 8 days (Tuesday after the pay-period Sunday).
   * The 3rd full Mon-Sun week of salaryDate's month = the Tech Bonus week.
   */
  const techBonusWeekInfo = useMemo(() => {
    const fromFile = calcSourceFile ? parseDateRangeFromFilename(calcSourceFile) : null;
    const weekStartDate = fromFile?.start ?? null;
    if (!weekStartDate) return { isTechBonusWeek: false, weekStartDate: null as Date | null, salaryDate: null as Date | null };
    const salaryDate = new Date(weekStartDate.getFullYear(), weekStartDate.getMonth(), weekStartDate.getDate() + 8);
    const first = new Date(salaryDate.getFullYear(), salaryDate.getMonth(), 1);
    const dow = first.getDay();
    const daysForward = (8 - dow) % 7;
    const firstMon = new Date(first.getFullYear(), first.getMonth(), first.getDate() + daysForward);
    const thirdWeekMon = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate() + 14);
    const fourthWeekMon = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate() + 21);
    const t = salaryDate.getTime();
    const isTechBonusWeek = t >= thirdWeekMon.getTime() && t < fourthWeekMon.getTime();
    return { isTechBonusWeek, weekStartDate, salaryDate };
  }, [calcSourceFile]);

  /**
   * Per-employee `start_date + 30d` map. An employee needs 30 days of service
   * before their first Tech Bonus cycle. `masterEmployees` is the master-list
   * roster the wizard already fetches in Step 2.
   */
  const startDateByEmail = useMemo(() => {
    const map = new Map<string, Date>();
    for (const emp of masterEmployees) {
      const sd = emp.start_date ? new Date(emp.start_date) : null;
      if (!sd || isNaN(sd.getTime())) continue;
      const we = normEmail(emp.work_email);
      const pe = normEmail(emp.personal_email);
      if (we) map.set(we, sd);
      if (pe) map.set(pe, sd);
      // Bridge alternate work emails the same way ratesByEmail/masterIndex do.
      // The Global Master List is the source of truth for which addresses
      // belong to one person, so a Hubstaff row keyed on an alias (e.g.
      // sheeng@simple.biz when the primary work email is shannong@simple.biz)
      // still resolves its start date — required for the Tech Bonus
      // 30-day-service gate. Never overwrites a primary (primary wins).
      for (const alt of [emp.alternate_work_email, emp.alternate_work_email_2]) {
        const a = normEmail(alt);
        if (a && !map.has(a)) map.set(a, sd);
      }
    }
    return map;
  }, [masterEmployees]);

  /**
   * Set of work emails who should receive the Tech Bonus on the current
   * dispatch cycle. Used by:
   *  - the auto-toggle effect below (so `bonusTotals` and the Validation
   *    grandBonuses pick it up)
   *  - the Additions table's new Tech column (status pill)
   */
  const techBonusEligible = useMemo<Set<string>>(() => {
    const set = new Set<string>();
    if (techBonusWeekInfo.weekStartDate) {
      const weekStart = techBonusWeekInfo.weekStartDate;
      if (techBonusWeekInfo.isTechBonusWeek) {
        for (const r of effectiveCalcResults) {
          const hasRates = r.regularRate != null || r.otRate != null;
          if (!hasRates) continue;
          const em = normEmail(r.email);
          const sd = em ? startDateByEmail.get(em) : undefined;
          if (!sd) continue;
          const eligibleFrom = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate() + 30);
          if (weekStart.getTime() < eligibleFrom.getTime()) continue;
          set.add(r.email);
        }
      }
    }
    for (const email of techBonusManualGrants) set.add(email);
    for (const email of techBonusManualRevokes) set.delete(email);
    return set;
  }, [techBonusWeekInfo, effectiveCalcResults, startDateByEmail, techBonusManualGrants, techBonusManualRevokes]);

  /**
   * Auto-apply / remove tech_bonus toggle whenever the week-eligibility set
   * changes. Mirrors the perfect_attendance auto-toggle. Without this, the
   * Additions tab + Validation totals never reflect the week-detected bonus.
   */
  useEffect(() => {
    setEmployeeBonuses(prev => {
      const next = { ...prev };
      let changed = false;
      for (const email of Object.keys(employeeDepts)) {
        const eligible = techBonusEligible.has(email);
        const current = next[email]?.['tech_bonus'] ?? false;
        if (eligible !== current) {
          next[email] = { ...(next[email] ?? {}), tech_bonus: eligible };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [techBonusEligible]);

  /**
   * Manager-submitted bonuses resolved to each wizard row's identity. The wizard
   * keys rows by Hubstaff email; manager entries are keyed by personal/work email,
   * so we bridge via `masterIndex` (work email → personal email → name tokens),
   * mirroring how rates are resolved.
   */
  const resolvedManagerBonus = useMemo(() => {
    const out: Record<string, number> = {};
    if (Object.keys(managerBonusRaw).length === 0) return out;
    for (const row of effectiveCalcResults) {
      const e = normEmail(row.email);
      let amt = e ? managerBonusRaw[e] : undefined;
      if (amt === undefined) {
        let master = e ? masterIndex.byWorkEmail.get(e) : undefined;
        if (!master && e) master = masterIndex.byPersonalEmail.get(e);
        if (!master && row.name) {
          const toks = normalizeNameTokens(row.name);
          if (toks) master = masterIndex.byNameTokens.get(toks);
        }
        if (master) {
          const pe = normEmail(master.personal_email);
          const we = normEmail(master.work_email);
          amt = (pe ? managerBonusRaw[pe] : undefined) ?? (we ? managerBonusRaw[we] : undefined);
        }
      }
      if (amt !== undefined) out[row.email] = amt;
    }
    return out;
  }, [managerBonusRaw, effectiveCalcResults, masterIndex]);

  /** Same identity resolution as {@link resolvedManagerBonus}, but the per-source-
   *  department breakdown so the KPI Sub. cell can show where each KPI came from
   *  (e.g. a transferred person with a Leadgen AND a Callback KPI). */
  const resolvedManagerBonusByDept = useMemo(() => {
    const out: Record<string, Record<string, number>> = {};
    if (Object.keys(managerBonusByDeptRaw).length === 0) return out;
    for (const row of effectiveCalcResults) {
      const e = normEmail(row.email);
      let bd = e ? managerBonusByDeptRaw[e] : undefined;
      if (bd === undefined) {
        let master = e ? masterIndex.byWorkEmail.get(e) : undefined;
        if (!master && e) master = masterIndex.byPersonalEmail.get(e);
        if (!master && row.name) {
          const toks = normalizeNameTokens(row.name);
          if (toks) master = masterIndex.byNameTokens.get(toks);
        }
        if (master) {
          const pe = normEmail(master.personal_email);
          const we = normEmail(master.work_email);
          bd = (pe ? managerBonusByDeptRaw[pe] : undefined) ?? (we ? managerBonusByDeptRaw[we] : undefined);
        }
      }
      if (bd !== undefined) out[row.email] = bd;
    }
    return out;
  }, [managerBonusByDeptRaw, effectiveCalcResults, masterIndex]);

  // PAB + Tech amounts + per-department allowlist come from the Payment Catalog
  // System Bonuses tab (prefetched into initialData). Falls back to the legacy
  // constants + "applies to everyone" when no rows exist (pre-migration).
  const sysBonusCfg = useMemo(
    () => resolveSystemBonuses(initialData?.systemBonuses ?? []),
    [initialData],
  );
  const pabAmountPhp = sysBonusCfg.pab.amountPHP;
  const techAmountPhp = sysBonusCfg.tech.amountPHP;
  // employeeDepts is keyed by the raw Hubstaff email; some rows match only the
  // lower-cased key, so check both (mirrors the existing HSL dept checks).
  const deptKeyForEmail = useCallback(
    (email: string): string | null =>
      employeeDepts[email] ?? employeeDepts[(email ?? '').toLowerCase()] ?? null,
    [employeeDepts],
  );
  const isPabDeptEligible = useCallback(
    (email: string) => isDeptEligible(sysBonusCfg.pab, deptKeyForEmail(email)),
    [sysBonusCfg, deptKeyForEmail],
  );
  const isTechDeptEligible = useCallback(
    (email: string) => isDeptEligible(sysBonusCfg.tech, deptKeyForEmail(email)),
    [sysBonusCfg, deptKeyForEmail],
  );

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

    // Department-specific bonus (formula-based or toggle-based). A manager's
    // ready/locked KPI submission, when present for an employee, is authoritative
    // for that department bonus (the accountant can still override per row).
    for (const [deptKey, employees] of Object.entries(deptEmployeeMap)) {
      if (FORMULA_DEPT_KEYS.has(deptKey)) {
        // Per-department performance bonuses (tickets/sites/appts/units/sales/HR/
        // accounting-daily/QC) are no longer computed in the wizard — the KPI
        // Calculator owns them now and submits via `resolvedManagerBonus`
        // (the "KPI Sub." column). Dept bonus here = that submission only.
        for (const emp of employees) {
          const mgr = resolvedManagerBonus[emp.email];
          if (mgr !== undefined) result[emp.email] = (result[emp.email] ?? 0) + mgr;
        }
      } else {
        const dept = DEPARTMENTS.find(d => d.key === deptKey);
        if (!dept) continue;
        for (const emp of employees) {
          const mgr = resolvedManagerBonus[emp.email];
          if (mgr !== undefined) {
            result[emp.email] = (result[emp.email] ?? 0) + mgr;
            continue;
          }
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

    // Common bonuses (Technology, Perfect Attendance) — toggle-based, with the
    // amount + per-department allowlist resolved from the Payment Catalog
    // System Bonuses tab. A department excluded from a bonus contributes 0 even
    // when the toggle is on.
    for (const [email, deptKey] of Object.entries(employeeDepts)) {
      if (!deptKey) continue;
      const toggles = employeeBonuses[email] ?? {};
      let commonTotal = 0;
      if (toggles['perfect_attendance'] && isDeptEligible(sysBonusCfg.pab, deptKey)) {
        commonTotal += pabAmountPhp;
      }
      if (toggles['tech_bonus'] && isDeptEligible(sysBonusCfg.tech, deptKey)) {
        commonTotal += techAmountPhp;
      }
      result[email] = (result[email] ?? 0) + commonTotal;
    }

    return result;
  }, [effectiveCalcResults, employeeDepts, employeeBonuses, employeeMetrics, deptMetrics, ssdKpiAmounts, resolvedManagerBonus, sysBonusCfg, pabAmountPhp, techAmountPhp]);

  /**
   * Effective bonus per employee: the auto-computed subtotal (PAB + Tech + KPI +
   * dept bonuses) PLUS the accounting Adj. delta. The Adj. value is a signed
   * adjustment added on top — it never replaces the auto subtotal, so KPI/PAB/Tech
   * always remain in the final figure.
   */
  const getEffectiveBonus = useCallback(
    (email: string): number => (bonusTotals[email] ?? 0) + (bonusOverrides[email] ?? 0),
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
      id === 'perfect_attendance' ? pabAmountPhp : id === 'tech_bonus' ? techAmountPhp : 0;

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
      fx_rate: usdToPhpRate,
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
      // The week's OWNING Monday. Hubstaff files start on Sunday → the week's
      // Monday is the next day (this matches both the non-HSL Sun–Sat week and the
      // HSL Mon–Sun week, which drops the leading Sunday). A Monday start (no-file
      // fallback / HSL) is already the Monday. Walking *back* from a Sunday (the old
      // bug) wrongly attributed e.g. the May 31–Jun 6 week to May instead of June.
      // Mirrors `member-monthly-pay.ts` → `weekMonForPab`.
      const dow = weekStartDate.getDay();
      const mon =
        dow === 0
          ? new Date(weekStartDate.getFullYear(), weekStartDate.getMonth(), weekStartDate.getDate() + 1)
          : new Date(weekStartDate.getFullYear(), weekStartDate.getMonth(), weekStartDate.getDate() - (dow - 1));
      return { year: mon.getFullYear(), month: mon.getMonth() };
    })();
    const weekPabRange = weekPabMonth
      ? resolvePabRangeForMonth(weekPabMonth.year, weekPabMonth.month, pabPeriodSettings.overrides)
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
     * Reuse the component-scoped `startDateByEmail` (work/personal/alternate
     * work emails → Date) so the 30-day Tech Bonus gate here matches the
     * Additions table's eligibility set exactly. Employees need 30 days of
     * service before their first Tech Bonus; eligibleFrom = start_date + 30d.
     */
    const hasThirtyDaysByWeek = (workEmail: string) => {
      if (!weekStartDate) return false;
      const em = normEmail(workEmail);
      const sd = em ? startDateByEmail.get(em) : undefined;
      if (!sd) return false;
      const eligibleFrom = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate() + 30);
      return weekStartDate.getTime() >= eligibleFrom.getTime();
    };

    const rows: DispatchEmployee[] = [];
    const excludedRows: ExcludedDispatchEntry[] = [];
    const missing: string[] = [];
    for (const r of effectiveCalcResults) {
      const exclKey = normEmail(r.email) ?? '';
      const isExcluded = exclKey !== '' && excludedEmails.has(exclKey);
      const pe = resolvePersonalEmail(r);
      if (!pe) {
        if (isExcluded) {
          // Accounting said "do not pay" but we can't email them either — stage
          // as excluded with no payload so they still show in the Excluded tab.
          excludedRows.push({
            email: r.email,
            personal_email: null,
            name: r.name,
            department_key: employeeDepts[r.email] ?? null,
            amount_php: r.initialPay ?? null,
            payload: null,
            reason: 'do_not_pay',
          });
        } else {
          missing.push(r.name || r.email);
        }
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
      // Department allowlist (Payment Catalog System Bonuses) — a department not
      // assigned a bonus gets 0 regardless of attendance/service (e.g. US managers).
      const pabDeptOk = isPabDeptEligible(r.email);
      const techDeptOk = isTechDeptEligible(r.email);
      // Accountant exclusion forfeits PAB for this month — explicit guard so a
      // momentarily-stale perfect_attendance toggle can never leak the bonus.
      const pabBonus = hasRates && isFinalPabWeek && toggles.perfect_attendance && pabDeptOk && !isPabExcluded(r.email)
        ? commonBonusPhp('perfect_attendance')
        : 0;
      // Tech Bonus: paid in the 3rd paycheck of the month, but only after the
      // employee has completed 30 days of service from their start_date.
      // Manual toggle can opt-in earlier (still requires 30-day service).
      const hasThirtyDays = hasThirtyDaysByWeek(r.email);
      const techBonus =
        hasRates && hasThirtyDays && (isTechBonusWeek || toggles.tech_bonus) && techDeptOk
          ? commonBonusPhp('tech_bonus')
          : 0;
      const rawBonusTotal = hasRates ? (bonusTotals[r.email] ?? 0) : 0;
      // Strip out the month-wide PAB/tech amounts that `bonusTotals` may include,
      // then re-add the week-gated versions so weekly paystubs get the right total.
      // Mirror the dept-eligibility gate used in bonusTotals so the strip matches.
      const toggledPab = toggles.perfect_attendance && pabDeptOk ? commonBonusPhp('perfect_attendance') : 0;
      const toggledTech = toggles.tech_bonus && techDeptOk ? commonBonusPhp('tech_bonus') : 0;
      const autoOtherBonuses = hasRates ? Math.max(0, rawBonusTotal - toggledPab - toggledTech) : 0;
      // Accounting Adj. is a signed delta added on top — it never replaces the auto
      // bonuses, so PAB/Tech/KPI/dept amounts remain. It's carried as its own
      // `adjustment` field (kept OUT of other_bonuses) so the paystub can itemize it
      // separately from earned KPI/dept "Performance" bonuses. bonuses_total still
      // sums pab + tech + other + adjustment, so `final` is unchanged.
      const accountingAdj = hasRates ? (bonusOverrides[r.email] ?? 0) : 0;
      const otherBonuses = autoOtherBonuses;
      const bonusTotal = pabBonus + techBonus + otherBonuses + accountingAdj;

      // MESA Program deduction — ₱100 per paycheck for enrolled members.
      const em = normEmail(r.email);
      const rateRowForMesa = em ? ratesByEmail.get(em) : undefined;
      // Accounting-approved disbursement (not yet paid via Urgent Payments) — paid out this run.
      const mesaDisbursement = em ? (mesaDisbursements.get(em) ?? 0) : 0;
      // A member only contributes for pay weeks on/after their enrollment date —
      // so back weeks (and replayed periods before they joined) are NOT charged.
      // A null enrollment date = legacy member (enrolled before we tracked it) →
      // treated as always contributing, preserving prior behavior. `week.end` and
      // `mesa_member_since` are both YYYY-MM-DD, so the compare is lexical.
      const mesaSince = rateRowForMesa?.mesa_member_since ?? null;
      const enrolledForThisWeek =
        !!rateRowForMesa?.mesa_member && (!mesaSince || !week?.end || mesaSince <= week.end);
      // Always deduct the ₱100 contribution when enrolled (for this week) OR when a disbursement is being paid out.
      const mesaDeduction = (hasRates && (enrolledForThisWeek || mesaDisbursement > 0)) ? 100 : 0;

      // Accounting Orphanage pay — a positive amount added on top of final pay,
      // shown as its own paystub line (not folded into bonuses).
      const orphanagePay = hasRates ? (orphanageAmounts[r.email] ?? 0) : 0;

      const finalPay = (r.initialPay ?? 0) + bonusTotal - mesaDeduction + mesaDisbursement + orphanagePay;

      const emp: DispatchEmployee = {
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
          adjustment: accountingAdj,
          mesa_deduction: mesaDeduction,
          mesa_disbursement: mesaDisbursement,
          orphanage_pay: orphanagePay,
          final: finalPay,
        },
        adjustment_note: accountingAdj !== 0 ? (bonusOverrideNotes[r.email]?.trim() || null) : null,
      };

      if (isExcluded) {
        // Staged with its full payload so a later "Pay now" from the Excluded
        // tab still emails the right paystub.
        excludedRows.push({
          email: r.email,
          personal_email: pe,
          name: r.name,
          department_key: deptKey,
          amount_php: finalPay,
          payload: emp,
          reason: 'do_not_pay',
        });
      } else {
        rows.push(emp);
      }
    }
    return { rows, excludedRows, missing, payPeriodPayload };
  }, [
    effectiveCalcResults,
    ratesByEmail,
    masterEmployees,
    masterIndex,
    startDateByEmail,
    employeeDepts,
    employeeBonuses,
    bonusTotals,
    bonusOverrides,
    bonusOverrideNotes,
    orphanageAmounts,
    mesaDisbursements,
    excludedEmails,
    pabMonthRange,
    calcSourceFile,
    hubstaffColsForPab,
    pabPeriodSettings.validManualRange,
    pabAmountPhp,
    techAmountPhp,
    isPabDeptEligible,
    isTechDeptEligible,
    isPabExcluded,
    usdToPhpRate,
  ]);

  /**
   * Publish the wizard's per-employee final pay so the Employee Dashboard's
   * "Estimated Take-Home" matches exactly what payroll computed (incl. KPI/dept
   * bonuses, the Adj. delta, Orphanage pay, MESA deduction + disbursement).
   * Sourced from `dispatchData.rows` (the authoritative dispatched amount) and
   * keyed by BOTH work and personal email (lowercased) so the dashboard can match
   * on whichever it holds. Written to `payroll.wizard.final_pay.<sourceFile>` when
   * accounting locks the Additions step and on dispatch. Best-effort — never blocks.
   */
  const publishFinalPaySnapshot = React.useCallback(async () => {
    if (!calcSourceFile) return;
    // Replaying a past period is view-only — never re-write its historical snapshot
    // (the live debounce effect would otherwise clobber it with recomputed figures).
    if (isReplay) return;
    // email -> the wizard's authoritative figures. Includes the Regular/OT split +
    // hours (not just `final`) so the Employee Dashboard's Regular + Overtime stats
    // reconcile exactly with the Estimated Take-Home. Keyed by BOTH work and personal
    // email (lowercased).
    const finals: Record<string, {
      final: number;
      regularPay: number | null;
      otPay: number | null;
      regularHours: number;
      otHours: number;
      totalHours: number;
      initial: number | null;
      mesaDeduction: number;
      mesaDisbursement: number;
    }> = {};
    for (const r of dispatchData.rows) {
      const entry = {
        final: r.pay_php.final,
        regularPay: r.pay_php.regular,
        otPay: r.pay_php.ot,
        regularHours: r.hours.regular,
        otHours: r.hours.ot,
        totalHours: r.hours.total,
        initial: r.pay_php.initial,
        // MESA breakdown so the Employee dashboard can itemize the ₱100 weekly
        // contribution and surface an approved emergency disbursement separately
        // (instead of the disbursement silently inflating the headline take-home).
        mesaDeduction: r.pay_php.mesa_deduction ?? 0,
        mesaDisbursement: r.pay_php.mesa_disbursement ?? 0,
      };
      const we = r.email?.trim().toLowerCase();
      const pe = r.personal_email?.trim().toLowerCase();
      if (we) finals[we] = entry;
      if (pe) finals[pe] = entry;
    }
    try {
      await savePabSetting(
        `payroll.wizard.final_pay.${calcSourceFile}`,
        JSON.stringify({ source_file: calcSourceFile, finals }),
      );
    } catch (e) {
      console.warn('[publishFinalPaySnapshot]', e);
    }
  }, [calcSourceFile, dispatchData, savePabSetting, isReplay]);

  /**
   * Lock in the parsed Orphanage paste: write each resolved amount into the per-employee
   * Orphanage column (orphanageAmounts) and persist the Additions blob. The fresh map is
   * passed to saveAdditionsProgress explicitly because the state set below is a render behind.
   */
  const lockInOrphanagePaste = React.useCallback(async () => {
    if (isReplay) {
      toast.error('Replaying a past period is view-only', { description: 'Return to the current period to make changes.' });
      return;
    }
    const { ok } = orphanagePasteParse;
    if (ok.length === 0) {
      toast.error('Nothing to lock in', { description: 'Paste rows that resolve to an employee first.' });
      return;
    }
    setOrphanageLockingIn(true);
    try {
      const next = { ...orphanageAmounts };
      for (const r of ok) {
        next[r.emailKey] = r.amount;
        updateOrphanageAmount(r.emailKey, r.amount); // updates state + writes the audit log
      }
      await saveAdditionsProgress({ orphanageAmounts: next });
      void publishFinalPaySnapshot();

      // Also persist a first-class record (see references/create_orphanage_pay.sql).
      // Best-effort: the durable working value already lives in the additions blob
      // saved above, so a failure here never loses the locked-in amounts.
      if (calcSourceFile) {
        try {
          const res = await fetch('/api/orphanage-pay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source_file: calcSourceFile,
              rows: ok.map((r) => ({
                employeeEmail: r.emailKey,
                employeeName: r.name,
                payWeek: r.payWeek,
                hours: r.hours,
                regHours: r.regH,
                otHours: r.otH,
                regularRatePhp: r.rate,
                otRatePhp: r.otRate,
                amountPhp: r.amount,
              })),
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (e) {
          console.warn('[orphanage-pay] record write failed (amounts still saved in additions blob)', e);
        }
      }

      // Keep the hours/OT-split detail for the "Locked in this period" list in sync
      // immediately (so it shows even before migration #78 makes the table readable).
      setOrphanagePayDetail((prev) => {
        const next = { ...prev };
        for (const r of ok) {
          next[r.emailKey.toLowerCase()] = {
            hours: r.hours, regH: r.regH, otH: r.otH, rate: r.rate, otRate: r.otRate, payWeek: r.payWeek,
          };
        }
        return next;
      });

      toast.success(
        `Locked in ${ok.length} orphanage ${ok.length === 1 ? 'amount' : 'amounts'}`,
        { description: 'Saved to this period — see "Locked in this period" below.' },
      );
      setOrphanagePaste('');
    } finally {
      setOrphanageLockingIn(false);
    }
  }, [isReplay, orphanagePasteParse, orphanageAmounts, updateOrphanageAmount, saveAdditionsProgress, publishFinalPaySnapshot, calcSourceFile]);

  /** Load the locked-in orphanage pay detail (hours / OT split) for the active period
   *  when the user lands on the Orphanage step, so the "Locked in this period" list shows
   *  the full breakdown across reloads. Best-effort — the amounts themselves come from
   *  `orphanageAmounts` (the additions blob), so this only enriches; failure is harmless. */
  useEffect(() => {
    if (currentStep !== 3 || !calcSourceFile) return;
    const ctrl = new AbortController();
    fetch(`/api/orphanage-pay?source_file=${encodeURIComponent(calcSourceFile)}`, { cache: 'no-store', signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : { rows: [] }))
      .then((json: { rows?: Record<string, unknown>[] }) => {
        const map: Record<string, { hours: number; regH: number; otH: number; rate: number | null; otRate: number | null; payWeek: string | null }> = {};
        for (const row of json.rows ?? []) {
          const email = String(row.employee_email ?? '').toLowerCase();
          if (!email) continue;
          map[email] = {
            hours: Number(row.hours ?? 0),
            regH: Number(row.reg_hours ?? 0),
            otH: Number(row.ot_hours ?? 0),
            rate: row.regular_rate_php == null ? null : Number(row.regular_rate_php),
            otRate: row.ot_rate_php == null ? null : Number(row.ot_rate_php),
            payWeek: (row.pay_week as string | null) ?? null,
          };
        }
        // Merge under any optimistic entries already set this session (don't clobber fresher locals).
        setOrphanagePayDetail((prev) => ({ ...map, ...prev }));
      })
      .catch(() => { /* table may not exist yet (migration #78) — amounts still render */ });
    return () => ctrl.abort();
  }, [currentStep, calcSourceFile]);

  /** Remove one locked-in orphanage amount from this period (clears the Additions Orphanage
   *  column for that person + best-effort deletes the record row). */
  const removeOrphanageLocked = React.useCallback(async (email: string) => {
    if (isReplay) {
      toast.error('Replaying a past period is view-only');
      return;
    }
    const next = { ...orphanageAmounts };
    delete next[email];
    updateOrphanageAmount(email, null);
    setOrphanagePayDetail((prev) => {
      const n = { ...prev };
      delete n[email.toLowerCase()];
      return n;
    });
    await saveAdditionsProgress({ orphanageAmounts: next });
    void publishFinalPaySnapshot();
    if (calcSourceFile) {
      try {
        await fetch(`/api/orphanage-pay?source_file=${encodeURIComponent(calcSourceFile)}&email=${encodeURIComponent(email)}`, { method: 'DELETE' });
      } catch { /* best-effort — the additions blob is already updated */ }
    }
  }, [isReplay, orphanageAmounts, updateOrphanageAmount, saveAdditionsProgress, publishFinalPaySnapshot, calcSourceFile]);

  /**
   * Live publish: while accounting edits the wizard (Adj./Orphanage/bonus/metric
   * changes flow into `dispatchData`), debounce-write the final-pay snapshot so the
   * Employee Dashboard and Payment Dispatch reflect the wizard's number in near
   * real-time — not only on Lock/Dispatch. 1.5s debounce keeps DB writes bounded.
   */
  useEffect(() => {
    if (!calcSourceFile || dispatchData.rows.length === 0) return;
    const t = setTimeout(() => { void publishFinalPaySnapshot(); }, 1500);
    return () => clearTimeout(t);
  }, [calcSourceFile, dispatchData, publishFinalPaySnapshot]);

  const filteredCalcResults = useMemo(() => {
    const needle = initialCalcSearch.toLowerCase().trim();
    const nonHsl = effectiveCalcResults.filter(row => employeeDepts[row.email] !== 'hogan_smith_law');
    if (!needle) return nonHsl;
    return nonHsl.filter((row) => {
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
  }, [effectiveCalcResults, initialCalcSearch, employeeDepts]);

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
      // The public endpoint returns newest-first (so employee/manager dashboards
      // always show the latest upload). The wizard, however, follows the Initialized
      // batch: re-sort is_current first here so the wizard's active week (files[0],
      // newestSourceFile, loadHubstaffPreview) tracks the source of truth.
      const uploads = [...(json.uploads ?? [])].sort(
        (a, b) => Number(b.is_current) - Number(a.is_current),
      );
      const currentFirst = new Set<string>();
      const files: string[] = [];
      for (const u of uploads) {
        const f = (u.source_file ?? '').trim();
        if (!f || currentFirst.has(f)) continue;
        currentFirst.add(f);
        files.push(f);
      }
      // Fall back to the endpoint's file list if uploads metadata was empty.
      const finalFiles = files.length > 0 ? files : (json.files ?? []);
      setUploadedSourceFiles(finalFiles);
      setHubstaffUploads(uploads);
      return finalFiles;
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
      // Prefetch shipped the list, so we skip the fetch — but loadUploadedSourceFiles'
      // finally is the only thing that clears sourceFilesLoading (init true). Clear it
      // here too, or the Step 2 calc table hangs on its skeleton on production. (Dev
      // hides this: Strict Mode double-fires the effect, so the 2nd run does fetch.)
      setSourceFilesLoading(false);
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
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        deleted?: number;
        uploadsDeleted?: number;
        repointedTo?: string | null;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Delete failed');
      }
      const removed = json.deleted ?? 0;
      const batchesRemoved = json.uploadsDeleted ?? 0;
      const label = deleteSourceFilePending;
      if (removed === 0 && batchesRemoved === 0) {
        toast.warning('Nothing removed in Supabase', {
          description: `No batch or rows matching "${label}" were found.`,
        });
      } else {
        const parts: string[] = [];
        if (removed) parts.push(`${removed} hour row(s)`);
        if (batchesRemoved) parts.push(`${batchesRemoved} batch record(s)`);
        toast.success('Batch deleted', {
          description:
            `Removed ${parts.join(' + ')} for ${label}.` +
            (json.repointedTo ? ` Active week is now ${json.repointedTo}.` : ''),
        });
      }
      if (selectedSourceFile === deleteSourceFilePending) {
        setSelectedSourceFile(json.repointedTo ?? null);
        setSourceFileRows(null);
        setSourceFileCols(null);
      }
      // If the deleted batch was the calc target, follow the re-pointed week.
      setCalcSourceFile((cur) => (cur === deleteSourceFilePending ? (json.repointedTo ?? cur) : cur));
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

  // Extracts the embedded YYYY-MM-DD_to_YYYY-MM-DD date block from a filename, if any.
  // The whole filename is freely editable, but this is used to warn the operator when
  // an edit changes (or removes) the date range, since period parsing keys off it.
  const dateBlockOf = React.useCallback((name: string): string | null => {
    const m = /(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})/.exec(name);
    return m ? m[0] : null;
  }, []);

  const renameTargetName = renameNameDraft;

  // True when the original carried a date range and the edited name no longer has the
  // same one (changed or dropped) — surfaced as a warning, not a hard block.
  const renameDateRangeChanged = React.useMemo(() => {
    if (renameSourceFilePending === null) return false;
    const orig = dateBlockOf(renameSourceFilePending);
    if (!orig) return false;
    return dateBlockOf(renameNameDraft) !== orig;
  }, [renameSourceFilePending, renameNameDraft, dateBlockOf]);

  const openRenameSourceFile = React.useCallback((file: string) => {
    setRenameNameDraft(file);
    setRenameSourceFilePending(file);
  }, []);

  const confirmRenameSourceFile = React.useCallback(async () => {
    if (!renameSourceFilePending) return;
    const from = renameSourceFilePending;
    const to = renameTargetName.trim();
    if (!to || to === from) {
      setRenameSourceFilePending(null);
      return;
    }
    setRenameSourceFileLoading(true);
    try {
      const res = await fetch(`/api/hubstaff-hours?_=${Date.now()}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ from, to }),
      });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        hours?: number;
        disbursements?: number;
        dispatches?: number;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Rename failed');
      }
      const extra: string[] = [];
      if (json.disbursements) extra.push(`${json.disbursements} report row(s)`);
      if (json.dispatches) extra.push(`${json.dispatches} dispatch(es)`);
      toast.success('Renamed upload', {
        description: `${from} -> ${to}. Updated ${json.hours ?? 0} hour row(s)${
          extra.length ? `, ${extra.join(', ')}` : ''
        }.`,
      });
      // Keep the wizard pointed at the renamed week.
      if (selectedSourceFile === from) setSelectedSourceFile(to);
      setCalcSourceFile((cur) => (cur === from ? to : cur));
      setRenameSourceFilePending(null);
      await loadUploadedSourceFiles();
      await loadHubstaffPreview();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Rename failed';
      toast.error('Could not rename upload', { description: msg });
    } finally {
      setRenameSourceFileLoading(false);
    }
  }, [renameSourceFilePending, renameTargetName, selectedSourceFile, loadUploadedSourceFiles, loadHubstaffPreview]);

  // Initialize: promote a batch to the active source of truth (is_current=true).
  // The accounting surfaces (this Payroll Wizard + Accounting Overview) sort the
  // upload list current-first, so this re-points THEM at the chosen week. Employee
  // My Hours + manager dashboards intentionally stay on the latest upload and are
  // not affected. Shows a blocking loading overlay while data reloads.
  const initializeSourceFile = React.useCallback(async (file: string) => {
    setInitializingSourceFile(file);
    try {
      const res = await fetch(`/api/hubstaff-hours?_=${Date.now()}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ action: 'set_current', source_file: file }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Initialize failed');
      }
      // Point the wizard at the freshly activated week, then reload everything.
      setSelectedSourceFile(file);
      setCalcSourceFile(file);
      await loadUploadedSourceFiles();
      await loadHubstaffPreview();
      toast.success('Initialized as source of truth', {
        description: `${file} is now the active payroll week for the Wizard + Accounting Overview. Employee & manager dashboards still show the latest upload.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Initialize failed';
      toast.error('Could not initialize batch', { description: msg });
    } finally {
      setInitializingSourceFile(null);
    }
  }, [loadUploadedSourceFiles, loadHubstaffPreview]);

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

  // Step 1's file preview follows the header pay-period selector: load the selected
  // file when landing on Step 1 or when the period changes. A ref tracks the last
  // synced file so manual clicks on other files in the browser aren't overridden.
  const step1PreviewSyncRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentStep !== 1 || !calcSourceFile) return;
    if (step1PreviewSyncRef.current === calcSourceFile) return;
    step1PreviewSyncRef.current = calcSourceFile;
    void loadSourceFileRows(calcSourceFile);
  }, [currentStep, calcSourceFile, loadSourceFileRows]);

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
      if (sessionEmail) form.append('uploaded_by', sessionEmail);

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
      cursorOverlayRef.current?.broadcastSave();
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
      cursorOverlayRef.current?.broadcastSave();
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
      cursorOverlayRef.current?.broadcastSave();
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
      // Instantly notify peers via broadcast before Postgres Realtime catches up.
      if (goingLocked) broadcastLockAcquired(currentStep);
      toast.success(
        goingLocked
          ? 'Processing started — employee issues are paused'
          : 'Processing stopped — employees can file issues again',
        { icon: goingLocked ? '🔒' : '🔓' },
      );
      setConfirmingLockToggle(false);
      void logAudit({
        user_name: sessionEmail ?? 'anonymous',
        user_role: sessionRole ?? 'user',
        action: goingLocked ? 'dispatch.lock_acquired' : 'dispatch.lock_released',
        resource: 'dispatch_lock',
        cycle: auditCycle,
        details: {
          previous_value: !goingLocked,
          new_value: goingLocked,
          // Step the operator was on when they triggered the toggle —
          // helps reviewers reconstruct what stage of the wizard the
          // lock acquire/release happened during.
          wizard_step: currentStep,
          wizard_step_label: steps[currentStep - 1]?.label ?? null,
          // Lock metadata observed in the prior state — useful for
          // audits where ownership of the lock changed.
          previous_locked_by: lockState.lockedBy ?? null,
          previous_locked_at: lockState.lockedAt ?? null,
        },
      });
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
                              className="shrink-0 rounded-md px-1.5 text-zinc-400 transition-colors hover:bg-indigo-500/10 hover:text-indigo-600 dark:hover:text-indigo-400"
                              title="Rename this upload (source of truth for the week)"
                              onClick={(e) => {
                                e.stopPropagation();
                                openRenameSourceFile(file);
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
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
                          <p className="text-xs text-rose-600/80 dark:text-rose-400/70">Employee issues are paused</p>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="flex h-2.5 w-2.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
                        <div>
                          <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Not processing</p>
                          <p className="text-xs text-zinc-500 dark:text-zinc-500">Start to lock issues and begin payroll</p>
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
                          ? 'This will unlock employee issues. Employees will be able to file issues again.'
                          : 'This will lock employee issues and signal that payroll is being processed. Employees will not be able to file issues until you stop.'}
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
                  <div className="relative rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                      Uploaded batches &mdash; Initialize sets the payroll-processing week (Accounting only; employee &amp; manager always see the latest)
                    </p>
                    <ul className="max-h-[240px] space-y-1 overflow-y-auto">
                      {uploadedSourceFiles.map((file) => {
                        const meta = uploadMetaByFile.get(file);
                        const stamp = formatUploadStamp(meta?.uploaded_at);
                        const isActive = !!meta?.is_current;
                        const busy = initializingSourceFile !== null;
                        const thisBusy = initializingSourceFile === file;
                        return (
                          <li
                            key={file}
                            className={cn(
                              'flex items-start gap-2 rounded-md border px-2 py-1.5',
                              isActive
                                ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-800/60 dark:bg-emerald-950/20'
                                : 'border-zinc-100 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/50',
                            )}
                          >
                            <FileText className={cn('h-3.5 w-3.5 mt-0.5 shrink-0', isActive ? 'text-emerald-500' : 'text-zinc-400')} />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">
                                  {file}
                                </span>
                                {isActive && (
                                  <span className="shrink-0 rounded border border-emerald-300 bg-emerald-50 px-1 py-0 text-[9px] font-bold uppercase tracking-wide text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-400">
                                    Source of truth
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
                            {isActive ? (
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Active
                              </span>
                            ) : (
                              <button
                                type="button"
                                disabled={busy}
                                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 text-[11px] font-semibold text-indigo-600 transition-colors hover:bg-indigo-100 disabled:opacity-40 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-400 dark:hover:bg-indigo-500/20"
                                title="Make this batch the active payroll-processing week (Wizard + Accounting Overview). Employee & manager dashboards still show the latest upload."
                                onClick={() => void initializeSourceFile(file)}
                              >
                                {thisBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                                Initialize
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={busy}
                              className="shrink-0 rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-indigo-500/10 hover:text-indigo-600 disabled:opacity-40 dark:hover:text-indigo-400"
                              title="Rename this batch (source of truth for the week)"
                              onClick={() => openRenameSourceFile(file)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              className="shrink-0 rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40 dark:hover:text-red-400"
                              title="Delete this batch from Supabase"
                              onClick={() => setDeleteSourceFilePending(file)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>

                    {/* Blocking loading animation while a batch is promoted + data reloads. */}
                    <AnimatePresence>
                      {initializingSourceFile !== null && (
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.15 }}
                          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-xl bg-white/85 backdrop-blur-sm dark:bg-zinc-950/85"
                        >
                          <span className="relative flex h-10 w-10 items-center justify-center">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400/30" />
                            <Loader2 className="h-7 w-7 animate-spin text-indigo-600 dark:text-indigo-400" />
                          </span>
                          <div className="px-4 text-center">
                            <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                              Initializing source of truth&hellip;
                            </p>
                            <p className="mt-0.5 max-w-xs break-all font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                              {initializingSourceFile}
                            </p>
                            <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                              Pointing the Wizard + Accounting Overview at this week&hellip;
                            </p>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
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
                <div className="mt-2 flex items-center gap-1.5 rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1.5 dark:border-violet-800/50 dark:bg-violet-950/20">
                  <Building2 className="h-3 w-3 shrink-0 text-violet-500 dark:text-violet-400" />
                  <p className="text-[11px] text-violet-700 dark:text-violet-300">
                    Hogan Smith Law employees are not listed here &mdash; see the <span className="font-semibold">HSL</span> tab (step 4) for their initial pay and KPI bonuses.
                  </p>
                </div>
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
                          const prevRate = usdToPhpRate;
                          setUsdToPhpRate(parsed);
                          setUsdToPhpSaving(true);
                          void logAudit({
                            user_name: sessionEmail ?? 'anonymous',
                            user_role: sessionRole ?? 'user',
                            action: 'wizard.fx_rate_changed',
                            resource: 'usd_to_php_rate',
                            cycle: auditCycle,
                            details: { previous_value: prevRate, new_value: parsed },
                          });
                          fetch('/api/app-settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ key: 'usd_to_php_rate', value: String(parsed) }),
                          })
                            .then(async (res) => {
                              const json = (await res.json()) as { error: string | null };
                              if (!res.ok || json.error) throw new Error(json.error ?? 'Save failed');
                              toast.success(`Rate saved: ₱${parsed.toFixed(2)} / USD`);
                              cursorOverlayRef.current?.broadcastSave();
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
                      const prevRate = usdToPhpRate;
                      setUsdToPhpRate(parsed);
                      setUsdToPhpSaving(true);
                      void logAudit({
                        user_name: sessionEmail ?? 'anonymous',
                        user_role: sessionRole ?? 'user',
                        action: 'wizard.fx_rate_changed',
                        resource: 'usd_to_php_rate',
                        cycle: auditCycle,
                        details: { previous_value: prevRate, new_value: parsed },
                      });
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

            {/* USD → COP exchange rate (the second USD-anchored leg) */}
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 dark:border-amber-800/50 dark:bg-amber-950/30">
              <DollarSign className="h-4 w-4 shrink-0 text-amber-500" />
              <div className="flex flex-1 flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-amber-900 dark:text-amber-200">USD → COP Rate</span>
                <span className="text-xs text-amber-700/70 dark:text-amber-400/70">(1 USD =)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                    $COP
                  </span>
                  <Input
                    type="number"
                    min="0.01"
                    step="1"
                    value={usdToCopInput}
                    readOnly={!usdToCopEditing}
                    onChange={(e) => setUsdToCopInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && usdToCopEditing) {
                        const parsed = parseFloat(usdToCopInput);
                        if (Number.isFinite(parsed) && parsed > 0) {
                          const prevRate = usdToCopRate;
                          setUsdToCopRate(parsed);
                          setUsdToCopSaving(true);
                          void logAudit({
                            user_name: sessionEmail ?? 'anonymous',
                            user_role: sessionRole ?? 'user',
                            action: 'wizard.fx_rate_changed',
                            resource: 'usd_to_cop_rate',
                            cycle: auditCycle,
                            details: { previous_value: prevRate, new_value: parsed },
                          });
                          fetch('/api/app-settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ key: 'usd_to_cop_rate', value: String(parsed) }),
                          })
                            .then(async (res) => {
                              const json = (await res.json()) as { error: string | null };
                              if (!res.ok || json.error) throw new Error(json.error ?? 'Save failed');
                              toast.success(`Rate saved: $COP${parsed.toLocaleString('es-CO')} / USD`);
                              cursorOverlayRef.current?.broadcastSave();
                              setUsdToCopEditing(false);
                            })
                            .catch((err: unknown) =>
                              toast.error(`Failed to save rate: ${err instanceof Error ? err.message : 'Unknown error'}`),
                            )
                            .finally(() => setUsdToCopSaving(false));
                        }
                      }
                    }}
                    className={`h-8 min-w-[8rem] border-amber-300 pl-11 pr-2 font-mono text-sm tabular-nums dark:border-amber-700 ${usdToCopEditing ? 'bg-white dark:bg-zinc-950' : 'cursor-default bg-amber-50 dark:bg-amber-950/40'}`}
                  />
                </div>
                {!usdToCopEditing ? (
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 bg-amber-600 px-3 text-xs font-semibold text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-400 dark:text-white"
                    onClick={() => setUsdToCopEditing(true)}
                  >
                    Edit rate
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    disabled={usdToCopSaving}
                    className="h-8 bg-green-600 px-3 text-xs font-semibold text-white hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-400 dark:text-white"
                    onClick={() => {
                      const parsed = parseFloat(usdToCopInput);
                      if (!Number.isFinite(parsed) || parsed <= 0) {
                        toast.error('Enter a valid positive rate');
                        return;
                      }
                      const prevRate = usdToCopRate;
                      setUsdToCopRate(parsed);
                      setUsdToCopSaving(true);
                      void logAudit({
                        user_name: sessionEmail ?? 'anonymous',
                        user_role: sessionRole ?? 'user',
                        action: 'wizard.fx_rate_changed',
                        resource: 'usd_to_cop_rate',
                        cycle: auditCycle,
                        details: { previous_value: prevRate, new_value: parsed },
                      });
                      fetch('/api/app-settings', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ key: 'usd_to_cop_rate', value: String(parsed) }),
                      })
                        .then(async (res) => {
                          const json = (await res.json()) as { error: string | null };
                          if (!res.ok || json.error) throw new Error(json.error ?? 'Save failed');
                          toast.success(`Rate saved: $COP${parsed.toLocaleString('es-CO')} / USD`);
                          setUsdToCopEditing(false);
                        })
                        .catch((err: unknown) =>
                          toast.error(`Failed to save rate: ${err instanceof Error ? err.message : 'Unknown error'}`),
                        )
                        .finally(() => setUsdToCopSaving(false));
                    }}
                  >
                    {usdToCopSaving ? <Loader2 className="h-3 w-3 animate-spin text-white" /> : 'Apply & Save'}
                  </Button>
                )}
              </div>
              <p className="w-full text-xs text-amber-700/60 dark:text-amber-400/60">
                Colombian-paid people are converted from USD at this rate for the COP dispatch tab.
                Current: <span className="font-mono font-semibold">$COP{usdToCopRate.toLocaleString('es-CO')}</span> = $1 USD.{' '}
                Derived PHP ↔ COP:{' '}
                <span className="font-mono font-semibold">
                  ₱1 = $COP{copPerPhp(fxRates).toLocaleString('es-CO', { maximumFractionDigits: 2 })}
                </span>{' '}
                ·{' '}
                <span className="font-mono font-semibold">
                  $COP1 = ₱{phpPerCop(fxRates).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 5 })}
                </span>
                {' '}(USD is the anchor — PHP↔COP is computed, not set directly).
              </p>
            </div>

            {hourlyRatesError && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{hourlyRatesError}</span>
              </div>
            )}

            {/* Warning banner for employees missing rates — expandable list */}
            {(() => {
              if (initialCalcDataLoading) return null;
              const missingRows = effectiveCalcResults.filter(r => r.regularRate == null);
              if (missingRows.length === 0 || effectiveCalcResults.length === 0) return null;
              return (
                <details className="group rounded-lg border border-amber-400/40 bg-amber-50/70 dark:border-amber-600/30 dark:bg-amber-950/20">
                  <summary className="flex cursor-pointer select-none list-none items-center gap-2.5 px-4 py-3 [&::-webkit-details-marker]:hidden">
                    <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />
                    <span className="flex-1 text-sm text-amber-900 dark:text-amber-200">
                      <span className="font-semibold">{missingRows.length} employee{missingRows.length !== 1 ? 's' : ''}</span>
                      {' '}missing rates &mdash; pay cannot be calculated
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-amber-500 transition-transform group-open:rotate-90" />
                  </summary>
                  <div className="border-t border-amber-400/30 px-4 py-3 dark:border-amber-600/20">
                    <p className="mb-2.5 text-xs text-amber-800/80 dark:text-amber-300/70">
                      No matching row found in <span className="font-mono">employee_hourly_rates</span> for these Hubstaff emails.
                      Add their rates in Supabase to fix.
                    </p>
                    <div className="overflow-hidden rounded-lg border border-amber-300/50 dark:border-amber-700/30">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-amber-300/40 bg-amber-100/60 dark:border-amber-700/20 dark:bg-amber-900/20">
                            <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">Name</th>
                            <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">Hubstaff Email</th>
                            <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">Hours</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-amber-200/50 dark:divide-amber-800/20">
                          {missingRows.map(r => (
                            <tr key={r.email} className="bg-white/60 dark:bg-zinc-950/30">
                              <td className="px-3 py-2 font-medium text-zinc-800 dark:text-zinc-200">
                                {r.name || <span className="italic text-zinc-400">Unknown</span>}
                              </td>
                              <td className="px-3 py-2 font-mono text-zinc-600 dark:text-zinc-400">{r.email}</td>
                              <td className="px-3 py-2 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-400">
                                {r.totalHours.toFixed(2)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </details>
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
      case 5: {
        // ──────────── Additions step ────────────
        // (Defined here after the Orphanage block; Orphanage = step 3, HSL = step 4, Additions = step 5.)
        const activeDept = DEPARTMENTS.find(d => d.key === activeDeptTab) ?? DEPARTMENTS[0]!;
        // Hide the PAB / Tech columns entirely for a department that the bonus
        // is not assigned to (or is globally disabled) — no empty placeholder.
        const pabColShown = isDeptEligible(sysBonusCfg.pab, activeDeptTab);
        const techColShown = isDeptEligible(sysBonusCfg.tech, activeDeptTab);
        const deptEmployees = effectiveCalcResults.filter(r => employeeDepts[r.email] === activeDeptTab);
        // Resolve each assigned employee's department by normalized email so time-adjustment
        // rows (keyed by work_email) can be grouped under the active department.
        const normEmailToDeptKey = new Map<string, string>();
        for (const r of effectiveCalcResults) {
          const em = normEmail(r.email);
          const d = employeeDepts[r.email];
          if (em && d) normEmailToDeptKey.set(em, d);
        }
        const adjustmentDeptKey = (workEmail: string): string | undefined =>
          normEmailToDeptKey.get(normEmail(workEmail) ?? (workEmail ?? '').trim().toLowerCase());
        const pendingAdjustmentCountByDept = new Map<string, number>();
        for (const a of timeAdjustmentRows) {
          if (a.status !== 'pending') continue;
          const d = adjustmentDeptKey(a.work_email);
          if (d) pendingAdjustmentCountByDept.set(d, (pendingAdjustmentCountByDept.get(d) ?? 0) + 1);
        }
        const deptAdjustments = timeAdjustmentRows
          .filter(a => adjustmentDeptKey(a.work_email) === activeDeptTab)
          .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1));
        const unassignedEmployees = effectiveCalcResults.filter(r => !employeeDepts[r.email]);
        const assignedEmployees = effectiveCalcResults.filter(r => employeeDepts[r.email]);
        const totalBonusesAdded = assignedEmployees.reduce((sum, r) => sum + getEffectiveBonus(r.email), 0);
        const totalFinalPay = assignedEmployees.reduce(
          (sum, r) => sum + (r.initialPay ?? 0) + getEffectiveBonus(r.email) + (orphanageAmounts[r.email] ?? 0),
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
                  Assign employees to departments and apply bonuses. Assigned departments share a{' '}
                  <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                    Technology Bonus ({formatPHP(techAmountPhp)})
                  </span>{' '}
                  and a{' '}
                  <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                    Perfect Attendance Bonus ({formatPHP(pabAmountPhp)})
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
                const activeHasOverride = pabPeriodSettings.overrides.has(effectiveMonthKey);
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
                        key={additionsSavedAt ? 'locked' : 'unlocked'}
                        type="button"
                        onClick={async () => { await saveAdditionsProgress(); void publishFinalPaySnapshot(); }}
                        disabled={additionsSaving || !calcSourceFile || isReplay}
                        title={isReplay
                          ? 'Replaying a past period — view-only'
                          : additionsSavedAt
                            ? `Locked in at ${additionsSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                            : 'Lock in your additions progress'}
                        className={cn(
                          'inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 font-semibold transition-colors duration-300',
                          'disabled:cursor-not-allowed disabled:opacity-60',
                          additionsSaving
                            ? 'border-zinc-300 bg-zinc-50 text-zinc-500'
                            : additionsSavedAt
                              ? 'border-emerald-400 bg-emerald-50 text-emerald-700 lock-btn-success hover:bg-emerald-100'
                              : 'border-amber-400 bg-amber-50 text-amber-800 lock-btn-unglow hover:bg-amber-100',
                        )}
                      >
                        {additionsSaving ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : additionsSavedAt ? (
                          <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                        ) : (
                          <LockOpen className="h-3.5 w-3.5 lock-icon-wobble" />
                        )}
                        <span>
                          {additionsSaving ? 'Locking…' : additionsSavedAt ? 'Locked In' : 'Lock In Progress'}
                        </span>
                        {additionsSavedAt && (
                          <span className="opacity-60">
                            · {additionsSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                      </button>
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
                // Highlight + editor follow the modal's edit month (the clicked pill),
                // not the file-pinned effective month.
                const activeKey = editMonthKey;
                const activeHasOverride = pabPeriodSettings.overrides.has(editMonthKey);
                /** Short, locale-friendly date (e.g. "May 4, 2026") for period readouts. */
                const fmtPab = (d: Date) =>
                  d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                // Resolved window for the edit month + its weekday count, shown as a
                // plain-language readout so clicking a month tells you its exact PAB period.
                const activeRangeResolved = editMonthRange;
                const activeWeekdayCount = countMonFriInclusiveInRange(
                  activeRangeResolved.start,
                  activeRangeResolved.end,
                );
                // Only holidays whose date falls inside the edited month's PAB
                // window are shown — they're the only ones that affect this PAB
                // calendar. (Add/Seed/Toggle still operate on the full list.)
                const pabRangeStartMs = new Date(
                  activeRangeResolved.start.getFullYear(),
                  activeRangeResolved.start.getMonth(),
                  activeRangeResolved.start.getDate(),
                ).getTime();
                const pabRangeEndMs = new Date(
                  activeRangeResolved.end.getFullYear(),
                  activeRangeResolved.end.getMonth(),
                  activeRangeResolved.end.getDate(),
                ).getTime();
                const holidaysInPab = usHolidaysListFull.filter((h) => {
                  const d = parseLocalDateFromIso(h.date);
                  if (!d) return false;
                  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
                  return t >= pabRangeStartMs && t <= pabRangeEndMs;
                });
                // Flag a saved override that lands entirely outside its own month
                // (e.g. June's Jun 1–Jul 3 stored under May) so it can be reset.
                const editMStart = new Date(editMonth.year, editMonth.month, 1);
                const editMEnd = new Date(editMonth.year, editMonth.month + 1, 0);
                const rangeOutsideMonth =
                  activeRangeResolved.isOverride &&
                  (activeRangeResolved.start.getTime() > editMEnd.getTime() ||
                    activeRangeResolved.end.getTime() < editMStart.getTime());
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
                        const pillRange = resolvePabRangeForMonth(pabPickerYear, m, pabPeriodSettings.overrides);
                        return (
                          <button
                            key={key}
                            type="button"
                            disabled={!selectable || pabSaveState === 'saving'}
                            onClick={() => { if (selectable) void selectPabMonth(pabPickerYear, m); }}
                            title={
                              !selectable
                                ? `${lbl} ${pabPickerYear} — no Hubstaff data uploaded yet`
                                : `${lbl} ${pabPickerYear} · PAB period ${fmtPab(pillRange.start)} – ${fmtPab(pillRange.end)} (${hasOverride ? 'custom override' : 'default Mon–Fri'})${isToday ? ' · current PAB month' : ''}`
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
                      {/* Plain-language readout of the selected month's PAB period. */}
                      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-indigo-50/70 px-3 py-2 text-xs dark:bg-indigo-950/30">
                        <CalendarDays className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
                        <span className="font-semibold text-indigo-800 dark:text-indigo-200">
                          {MONTH_NAMES[editMonth.month]} {editMonth.year} PAB period:
                        </span>
                        <span className="font-mono font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
                          {fmtPab(activeRangeResolved.start)} – {fmtPab(activeRangeResolved.end)}
                        </span>
                        <span className="text-zinc-500 dark:text-zinc-400">
                          · {activeWeekdayCount} weekday{activeWeekdayCount === 1 ? '' : 's'} evaluated
                        </span>
                        <span
                          className={cn(
                            'rounded px-1.5 py-px text-[10px] font-bold uppercase tracking-wide',
                            activeRangeResolved.isOverride
                              ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                              : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
                          )}
                        >
                          {activeRangeResolved.isOverride ? 'Custom override' : 'Default Mon–Fri'}
                        </span>
                        {rangeOutsideMonth && (
                          <span
                            className="rounded px-1.5 py-px text-[10px] font-bold uppercase tracking-wide bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300"
                            title={`This saved window is entirely outside ${MONTH_NAMES[editMonth.month]} — it belongs to another month. Use Auto-calc or Reset override to fix it.`}
                          >
                            ⚠ Outside {MONTH_NAMES[editMonth.month]} — fix it
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <span className="rounded-md bg-indigo-600/10 px-2 py-1 text-xs font-bold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200">
                          Editing: {MONTH_NAMES[editMonth.month]} {editMonth.year}
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

                    {/* Exclude + Holidays sit side by side on wide screens, stacking on mobile. */}
                    <div className="mt-5 grid grid-cols-1 items-start gap-x-6 gap-y-5 lg:grid-cols-2">
                    {/* ── Exclude people from this month's PAB ──────────────────────────
                        Accounting can forfeit a person's PAB for the selected month via a
                        tick box; excluded people earn ₱0 PAB regardless of attendance, and
                        the dispatch path honors the same per-month list. */}
                    {(() => {
                      const monthExcluded = pabPeriodSettings.exclusions.get(editMonthKey) ?? new Set<string>();
                      // Roster = everyone evaluated this period, de-duped by normalized email.
                      const byNorm = new Map<string, { email: string; name: string; norm: string }>();
                      for (const r of effectiveCalcResults) {
                        const norm = normEmail(r.email) ?? (r.email ?? '').toLowerCase();
                        if (!norm || byNorm.has(norm)) continue;
                        byNorm.set(norm, { email: r.email, name: r.name, norm });
                      }
                      // Surface any already-excluded email no longer in the roster so it can be cleared.
                      for (const norm of monthExcluded) {
                        if (!byNorm.has(norm)) byNorm.set(norm, { email: norm, name: norm, norm });
                      }
                      const q = pabExclusionSearch.trim().toLowerCase();
                      const people = Array.from(byNorm.values())
                        .filter((p) => !q || (p.name ?? '').toLowerCase().includes(q) || p.norm.includes(q))
                        .sort((a, b) => {
                          // Excluded float to the top; then alphabetical by name.
                          const ax = monthExcluded.has(a.norm) ? 0 : 1;
                          const bx = monthExcluded.has(b.norm) ? 0 : 1;
                          if (ax !== bx) return ax - bx;
                          return (a.name || a.norm).localeCompare(b.name || b.norm);
                        });
                      const excludedCount = monthExcluded.size;
                      const busy = pabSaveState === 'saving' || isReplay;
                      // Paginate to 5 people per page. Clamp the page on the fly so
                      // shrinking the list (un-excluding / searching) never strands us.
                      const PAB_EXCL_PER_PAGE = 5;
                      const totalPages = Math.max(1, Math.ceil(people.length / PAB_EXCL_PER_PAGE));
                      const page = Math.min(pabExclusionPage, totalPages - 1);
                      const pageStart = page * PAB_EXCL_PER_PAGE;
                      const pageItems = people.slice(pageStart, pageStart + PAB_EXCL_PER_PAGE);
                      // Condensed page tokens: always 1 + last, current ±1, with '…'
                      // gaps — so 100 pages render as "1 … 49 50 51 … 100", never 100 dots.
                      const cur1 = page + 1; // 1-based
                      const pageTokens: (number | 'gap')[] = [];
                      {
                        const mid: number[] = [];
                        for (let i = Math.max(2, cur1 - 1); i <= Math.min(totalPages - 1, cur1 + 1); i++) mid.push(i);
                        pageTokens.push(1);
                        if (mid.length && mid[0] > 2) pageTokens.push('gap');
                        pageTokens.push(...mid);
                        if (mid.length && mid[mid.length - 1] < totalPages - 1) pageTokens.push('gap');
                        if (totalPages > 1) pageTokens.push(totalPages);
                      }
                      return (
                        <div className="border-t border-rose-200/60 pt-4 dark:border-rose-900/40">
                          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-rose-50 dark:bg-rose-950/30">
                                <UserX className="h-3.5 w-3.5 text-rose-500" />
                              </div>
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                                  Exclude from PAB
                                </p>
                                <p className="text-[10px] text-zinc-400 dark:text-zinc-500">
                                  Ticked people earn ₱0 PAB for{' '}
                                  <span className="font-semibold text-rose-600 dark:text-rose-400">
                                    {MONTH_NAMES[editMonth.month]} {editMonth.year}
                                  </span>{' '}
                                  — regardless of attendance.
                                </p>
                              </div>
                            </div>
                            <AnimatePresence initial={false}>
                              {excludedCount > 0 && (
                                <motion.span
                                  key="excl-count"
                                  initial={{ opacity: 0, scale: 0.85 }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.85 }}
                                  transition={{ duration: 0.18 }}
                                  className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-700 dark:bg-rose-950/60 dark:text-rose-300"
                                >
                                  <UserX className="h-3 w-3" />
                                  {excludedCount} excluded
                                </motion.span>
                              )}
                            </AnimatePresence>
                          </div>

                          {/* Search */}
                          <div className="relative mb-2.5">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                            <Input
                              type="text"
                              value={pabExclusionSearch}
                              onChange={(e) => { setPabExclusionSearch(e.target.value); setPabExclusionPage(0); }}
                              placeholder="Search a person by name or email…"
                              className="h-9 pl-8 pr-8 text-xs"
                            />
                            <AnimatePresence>
                              {pabExclusionSearch && (
                                <motion.button
                                  type="button"
                                  initial={{ opacity: 0 }}
                                  animate={{ opacity: 1 }}
                                  exit={{ opacity: 0 }}
                                  onClick={() => { setPabExclusionSearch(''); setPabExclusionPage(0); }}
                                  className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
                                  aria-label="Clear search"
                                >
                                  <X className="h-3 w-3" />
                                </motion.button>
                              )}
                            </AnimatePresence>
                          </div>

                          {/* People list */}
                          {people.length === 0 ? (
                            <div className="flex items-center gap-2 rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-4 py-4 text-xs text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/40">
                              <Users className="h-4 w-4 shrink-0" />
                              {q
                                ? `No one matches “${pabExclusionSearch}”.`
                                : 'No employees in this period yet — load a Hubstaff report in Step 1.'}
                            </div>
                          ) : (
                            <div className="space-y-1.5">
                              <AnimatePresence initial={false}>
                                {pageItems.map((p) => {
                                  const isExcl = monthExcluded.has(p.norm);
                                  return (
                                    <motion.button
                                      key={p.norm}
                                      type="button"
                                      layout
                                      initial={{ opacity: 0, y: -4 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                                      transition={{ duration: 0.18, ease: 'easeOut' }}
                                      onClick={() => { if (!busy) void togglePabExclusion(p.email, !isExcl); }}
                                      disabled={busy}
                                      title={isExcl ? 'Click to restore PAB for this person' : 'Click to exclude this person from PAB this month'}
                                      className={cn(
                                        'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors duration-200',
                                        'disabled:cursor-not-allowed disabled:opacity-60',
                                        isExcl
                                          ? 'border-rose-300 bg-rose-50/70 dark:border-rose-900/50 dark:bg-rose-950/25'
                                          : 'border-zinc-200 bg-white hover:border-rose-200 hover:bg-rose-50/40 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-rose-900/40 dark:hover:bg-rose-950/15',
                                      )}
                                    >
                                      {/* Tick box */}
                                      <span
                                        className={cn(
                                          'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border transition-colors duration-200',
                                          isExcl
                                            ? 'border-rose-500 bg-rose-500 text-white'
                                            : 'border-zinc-300 bg-white dark:border-zinc-600 dark:bg-zinc-800',
                                        )}
                                      >
                                        <AnimatePresence initial={false}>
                                          {isExcl && (
                                            <motion.span
                                              key="tick"
                                              initial={{ scale: 0, opacity: 0 }}
                                              animate={{ scale: 1, opacity: 1 }}
                                              exit={{ scale: 0, opacity: 0 }}
                                              transition={{ duration: 0.14 }}
                                              className="flex items-center justify-center"
                                            >
                                              <Check className="h-3 w-3" strokeWidth={3} />
                                            </motion.span>
                                          )}
                                        </AnimatePresence>
                                      </span>
                                      <span className="min-w-0 flex-1">
                                        <span className={cn(
                                          'block truncate text-xs font-semibold',
                                          isExcl ? 'text-rose-700 dark:text-rose-300' : 'text-zinc-800 dark:text-zinc-100',
                                        )}>
                                          {p.name || p.norm}
                                        </span>
                                        <span className="block truncate font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                                          {p.norm}
                                        </span>
                                      </span>
                                      <span className={cn(
                                        'shrink-0 text-[10px] font-bold uppercase tracking-wide transition-colors',
                                        isExcl ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-300 dark:text-zinc-600',
                                      )}>
                                        {isExcl ? 'Excluded' : 'Exclude'}
                                      </span>
                                    </motion.button>
                                  );
                                })}
                              </AnimatePresence>
                            </div>
                          )}

                          {/* Pager — 5 per page */}
                          {totalPages > 1 && (
                            <div className="mt-2.5 flex items-center justify-between gap-2">
                              <button
                                type="button"
                                onClick={() => setPabExclusionPage((p) => Math.max(0, p - 1))}
                                disabled={page === 0}
                                className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-600 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                              >
                                <ChevronLeft className="h-3.5 w-3.5" />
                                Prev
                              </button>
                              <div className="flex items-center gap-1">
                                {pageTokens.map((tok, i) =>
                                  tok === 'gap' ? (
                                    <span key={`gap-${i}`} className="px-0.5 text-[11px] leading-none text-zinc-400 dark:text-zinc-600">…</span>
                                  ) : (
                                    <button
                                      key={tok}
                                      type="button"
                                      onClick={() => setPabExclusionPage(tok - 1)}
                                      aria-label={`Page ${tok}`}
                                      aria-current={tok - 1 === page ? 'page' : undefined}
                                      className={cn(
                                        'flex h-6 min-w-[24px] items-center justify-center rounded-md px-1.5 text-[11px] font-semibold tabular-nums transition-colors duration-200',
                                        tok - 1 === page
                                          ? 'bg-rose-500 text-white dark:bg-rose-500'
                                          : 'border border-zinc-200 bg-white text-zinc-600 hover:bg-rose-50 hover:text-rose-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-rose-950/30',
                                      )}
                                    >
                                      {tok}
                                    </button>
                                  ),
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={() => setPabExclusionPage((p) => Math.min(totalPages - 1, p + 1))}
                                disabled={page >= totalPages - 1}
                                className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-600 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                              >
                                Next
                                <ChevronRight className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                          <p className="mt-2 text-[10px] text-zinc-400 dark:text-zinc-500">
                            {excludedCount > 0
                              ? `${excludedCount} excluded from ${MONTH_NAMES[editMonth.month]} ${editMonth.year} PAB · `
                              : `No one excluded from ${MONTH_NAMES[editMonth.month]} ${editMonth.year} PAB · `}
                            {people.length > PAB_EXCL_PER_PAGE
                              ? `showing ${pageStart + 1}–${pageStart + pageItems.length} of ${people.length}`
                              : `${people.length} shown`}
                          </p>
                        </div>
                      );
                    })()}

                    {/* PAB Calendar — Holidays */}
                    <div className="border-t border-violet-200/60 pt-4 dark:border-violet-900/40">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-violet-50 dark:bg-violet-950/30">
                            <Flag className="h-3.5 w-3.5 text-violet-500" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">PAB Calendar Holidays</p>
                            <p className="text-[10px] text-zinc-400 dark:text-zinc-500">
                              Within {MONTH_NAMES[editMonth.month]} {editMonth.year}&apos;s PAB period ({fmtPab(activeRangeResolved.start)} – {fmtPab(activeRangeResolved.end)}) — shown in violet on the employee calendar, attendance auto-forgiven.
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {pabHolSaveState === 'saving' && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
                          {pabHolSaveState === 'saved' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
                          {pabHolSaveState === 'error' && <AlertCircle className="h-3.5 w-3.5 text-red-500" />}
                          <div className={cn(
                            'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-all duration-200',
                            usHolidaysMasterEnabled
                              ? 'border-violet-300 bg-violet-50 dark:border-violet-700 dark:bg-violet-950/30'
                              : 'border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/40',
                          )}>
                            <span className={cn('text-[11px] font-semibold', usHolidaysMasterEnabled ? 'text-violet-700 dark:text-violet-300' : 'text-zinc-500 dark:text-zinc-400')}>
                              {usHolidaysMasterEnabled ? 'Enabled' : 'Disabled'}
                            </span>
                            <Switch
                              checked={usHolidaysMasterEnabled}
                              onCheckedChange={(v) => void saveHolidaysEnabled(v)}
                              disabled={pabHolSaveState === 'saving'}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Add-holiday form */}
                      <div className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-violet-200 bg-violet-50/40 px-3 py-2.5 dark:border-violet-900/40 dark:bg-violet-950/15">
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Date</label>
                          <Input
                            type="date"
                            value={pabHolNewDate}
                            onChange={(e) => setPabHolNewDate(e.target.value)}
                            className="h-8 w-[150px] shrink-0 text-xs"
                          />
                        </div>
                        <div className="flex flex-1 flex-col gap-1">
                          <label className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Name</label>
                          <Input
                            type="text"
                            value={pabHolNewName}
                            onChange={(e) => setPabHolNewName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') void addPabHoliday(); }}
                            placeholder="e.g. Memorial Day"
                            className="h-8 text-xs"
                          />
                        </div>
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => void addPabHoliday()}
                            disabled={!pabHolNewDate || !pabHolNewName.trim() || pabHolSaveState === 'saving'}
                            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-violet-600 px-3 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50 dark:bg-violet-700 dark:hover:bg-violet-600"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Add
                          </button>
                          <button
                            type="button"
                            onClick={() => void seedPabFederalHolidays()}
                            disabled={pabHolSaveState === 'saving'}
                            title={`Seed US federal holidays for ${pabPickerYear}`}
                            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          >
                            <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                            Seed {pabPickerYear}
                          </button>
                        </div>
                      </div>

                      {/* Holiday list — scoped to the edited month's PAB period */}
                      {holidaysInPab.length === 0 ? (
                        <div className="flex items-center gap-2 rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-4 py-4 text-xs text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/40">
                          <CalendarDays className="h-4 w-4 shrink-0" />
                          {usHolidaysListFull.length === 0
                            ? <>No holidays configured. Add one above or click &quot;Seed {pabPickerYear}&quot; to load US federal holidays.</>
                            : <>No holidays fall within {MONTH_NAMES[editMonth.month]} {editMonth.year}&apos;s PAB period. {usHolidaysListFull.length} configured on other dates.</>}
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          {holidaysInPab.map((h) => {
                            const hd = new Date(h.date + 'T00:00:00');
                            const weekday = hd.toLocaleDateString('en-US', { weekday: 'short' });
                            const friendly = hd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                            return (
                              <div
                                key={h.date}
                                className={cn(
                                  'flex items-center gap-3 rounded-lg border px-3 py-2 transition-all',
                                  h.enabled && usHolidaysMasterEnabled
                                    ? 'border-violet-200 bg-violet-50/40 dark:border-violet-900/40 dark:bg-violet-950/15'
                                    : 'border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800/30',
                                )}
                              >
                                <div className="flex w-12 shrink-0 flex-col items-center rounded-md border border-zinc-200 bg-white px-1 py-1 dark:border-zinc-700 dark:bg-zinc-900">
                                  <span className="text-[9px] font-semibold uppercase tracking-wide text-zinc-400">{weekday}</span>
                                  <span className="font-mono text-xs font-bold text-zinc-800 dark:text-zinc-100">
                                    {hd.toLocaleDateString('en-US', { month: 'short' })} {hd.getDate()}
                                  </span>
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-xs font-semibold text-zinc-800 dark:text-zinc-100">{h.name}</p>
                                  <p className="text-[10px] text-zinc-400 dark:text-zinc-500">{friendly}</p>
                                </div>
                                <Switch
                                  checked={h.enabled}
                                  onCheckedChange={(v) => void togglePabHoliday(h.date, v)}
                                  disabled={pabHolSaveState === 'saving' || !usHolidaysMasterEnabled}
                                />
                                <button
                                  type="button"
                                  onClick={() => void removePabHoliday(h.date)}
                                  disabled={pabHolSaveState === 'saving'}
                                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-50 dark:hover:bg-red-950/30"
                                  aria-label={`Remove ${h.name}`}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <p className="mt-2 text-[10px] text-zinc-400 dark:text-zinc-500">
                        {holidaysInPab.filter(h => h.enabled).length} active · {holidaysInPab.length} in this PAB period · {usHolidaysListFull.length} total
                      </p>
                    </div>
                    {/* /grid: Exclude + Holidays */}
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

            {/* Department workspace: vertical rail (left) + content (right). On mobile the
                rail collapses to a horizontal scroller above the content. */}
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
              {/* Department rail */}
              <div className="flex gap-1.5 overflow-x-auto pb-1 xl:w-48 xl:shrink-0 xl:flex-col xl:gap-1 xl:overflow-visible xl:pb-0 [-ms-overflow-style:none] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-300/80 dark:[&::-webkit-scrollbar-thumb]:bg-zinc-600">
                <p className="hidden px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 xl:block dark:text-zinc-500">
                  Departments
                </p>
                {DEPARTMENTS.filter(dept => dept.key !== 'hogan_smith_law').map(dept => {
                  const count = effectiveCalcResults.filter(r => employeeDepts[r.email] === dept.key).length;
                  const pendingAdj = pendingAdjustmentCountByDept.get(dept.key) ?? 0;
                  const isActive = activeDeptTab === dept.key;
                  return (
                    <motion.button
                      key={dept.key}
                      type="button"
                      onClick={() => { setActiveDeptTab(dept.key); setAdditionsSearch(''); }}
                      whileTap={{ scale: 0.97 }}
                      className={cn(
                        'relative flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium xl:w-full xl:justify-between',
                        isActive
                          ? 'border-indigo-500/50 text-indigo-700 dark:text-indigo-300'
                          : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/50',
                      )}
                    >
                      {isActive && (
                        <motion.span
                          layoutId="additions-dept-active-bg"
                          className="absolute inset-0 rounded-[7px] bg-indigo-600/10 dark:bg-indigo-500/15"
                          transition={{ type: 'spring', stiffness: 400, damping: 34 }}
                        />
                      )}
                      <span className="relative truncate">{dept.name}</span>
                      <span className="relative flex shrink-0 items-center gap-1">
                        {pendingAdj > 0 && (
                          <span
                            className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white"
                            title={`${pendingAdj} pending time adjustment${pendingAdj === 1 ? '' : 's'}`}
                          >
                            {pendingAdj}
                          </span>
                        )}
                        {count > 0 && (
                          <span
                            className={cn(
                              'rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none',
                              isActive
                                ? 'bg-indigo-600 text-white'
                                : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400',
                            )}
                          >
                            {count}
                          </span>
                        )}
                      </span>
                    </motion.button>
                  );
                })}
              </div>

              {/* Content: review panel + employee table */}
              <div className="min-w-0 flex-1">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={activeDeptTab}
                    initial={{ opacity: 0, y: 8, filter: 'blur(2px)' }}
                    animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, y: -6, filter: 'blur(2px)' }}
                    transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    className="space-y-4"
                  >
                <TimeAdjustmentReviewPanel
                  deptName={activeDept.name}
                  adjustments={deptAdjustments}
                  signedUrls={timeAdjustmentSignedUrls}
                  decidingId={decidingAdjustmentId}
                  hoursDraft={adjustmentHoursDraft}
                  setHoursDraft={setAdjustmentHoursDraft}
                  onDecide={decideTimeAdjustmentRequest}
                  onDelete={deleteTimeAdjustmentRequest}
                  deletingId={deletingAdjustmentId}
                  locked={lockState.locked}
                />

            {/* Left bonus-rules panel hidden — table now spans full width */}
            <div className="hidden">
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
                          disabled={isReplay}
                          className="h-8 border-violet-200 bg-white font-mono text-xs disabled:cursor-not-allowed disabled:opacity-60 dark:border-violet-800/50 dark:bg-zinc-900"
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
                          disabled={isReplay}
                          className="h-8 border-violet-200 bg-white font-mono text-xs disabled:cursor-not-allowed disabled:opacity-60 dark:border-violet-800/50 dark:bg-zinc-900"
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

                {/* Pending disputes for this department */}
                {(() => {
                  if (pendingDisputeRows.length === 0) return null;

                  // Build a set of all normalized emails that belong to the active dept.
                  // Include direct Hubstaff email matches AND alias resolution via masterIndex
                  // so that disputes filed with a personal/alternate email still surface here.
                  const deptEmailSet = new Set(deptEmployees.map(e => normEmail(e.email) ?? e.email.toLowerCase()));

                  // Also build full email→dept from ALL calc results (not just active dept) for alias resolution.
                  const allNormEmailToDept = new Map<string, string>();
                  for (const r of effectiveCalcResults) {
                    const em = normEmail(r.email);
                    const dept = employeeDepts[r.email];
                    if (em && dept) allNormEmailToDept.set(em, dept);
                  }

                  const resolveInDept = (disputeEmail: string): boolean => {
                    const em = normEmail(disputeEmail) ?? disputeEmail.trim().toLowerCase();
                    if (deptEmailSet.has(em)) return true;
                    // Resolve via masterIndex: dispute email → master record → other emails
                    const master = masterIndex.byWorkEmail.get(em) ?? masterIndex.byPersonalEmail.get(em);
                    if (!master) return false;
                    const we = normEmail(master.work_email);
                    const pe = normEmail(master.personal_email);
                    if (we && deptEmailSet.has(we)) return true;
                    if (pe && deptEmailSet.has(pe)) return true;
                    if (we && allNormEmailToDept.get(we) === activeDeptTab) return true;
                    if (pe && allNormEmailToDept.get(pe) === activeDeptTab) return true;
                    return false;
                  };

                  const deptDisputes = pendingDisputeRows.filter(r => resolveInDept(r.work_email));
                  if (deptDisputes.length === 0) return null;

                  const nameByEmail = new Map(deptEmployees.map(e => [normEmail(e.email) ?? e.email.toLowerCase(), e.name]));
                  const resolveName = (disputeEmail: string): string => {
                    const em = normEmail(disputeEmail) ?? disputeEmail.trim().toLowerCase();
                    if (nameByEmail.has(em)) return nameByEmail.get(em)!;
                    const master = masterIndex.byWorkEmail.get(em) ?? masterIndex.byPersonalEmail.get(em);
                    return master?.name ?? disputeEmail;
                  };

                  const refetchApproved = () => {
                    if (!pabMonthRange) return;
                    const s = pabMonthRange.start;
                    const e = pabMonthRange.end;
                    const from = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
                    const dayAfterEnd = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1);
                    const to = `${dayAfterEnd.getFullYear()}-${String(dayAfterEnd.getMonth() + 1).padStart(2, '0')}-${String(dayAfterEnd.getDate()).padStart(2, '0')}`;
                    fetch(`/api/pab-disputes?status=approved&status=accounting_approved&from=${from}&to=${to}`, { cache: 'no-store' })
                      .then(r2 => r2.json())
                      .then((json2: { rows: { id: string; work_email: string; dispute_date: string; override_hours: number | null }[] }) => {
                        const map = new Map<string, Map<string, number | null>>();
                        const idMap = new Map<string, Map<string, string>>();
                        for (const row of json2.rows ?? []) {
                          const em = (row.work_email ?? '').trim().toLowerCase();
                          if (!em) continue;
                          if (!map.has(em)) map.set(em, new Map());
                          map.get(em)!.set(row.dispute_date, row.override_hours);
                          if (row.id) {
                            if (!idMap.has(em)) idMap.set(em, new Map());
                            idMap.get(em)!.set(row.dispute_date, row.id);
                          }
                        }
                        setApprovedDisputeDates(map);
                        setApprovedDisputeIds(idMap);
                      })
                      .catch(() => {});
                  };

                  const pendingCount = deptDisputes.filter(r => r.status === 'pending' || r.status === 'pending_orphanage_manager' || r.status === 'orphanage_manager_approved').length;
                  const approvedCount = deptDisputes.filter(r => r.status === 'approved' || r.status === 'accounting_approved').length;

                  return (
                    <div className="rounded-xl border border-amber-200 bg-amber-50/60 dark:border-amber-800/50 dark:bg-amber-950/20">
                      <div className="flex items-center gap-2 border-b border-amber-200 px-3 py-2.5 dark:border-amber-800/50">
                        {pendingCount > 0 && (
                          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-400 text-[9px] font-bold text-white dark:bg-amber-600">
                            {pendingCount}
                          </span>
                        )}
                        {approvedCount > 0 && (
                          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-[9px] font-bold text-white dark:bg-emerald-600">
                            {approvedCount}
                          </span>
                        )}
                        <span className="text-[11px] font-semibold text-amber-800 dark:text-amber-300">Attendance Issues</span>
                      </div>
                      <div className="divide-y divide-amber-100 dark:divide-amber-900/30">
                        {deptDisputes.map((r) => {
                          const name = resolveName(r.work_email);
                          const reasonLabel = r.reason.replace(/_/g, ' ');
                          const isDeciding = decidingDispute === r.id;
                          const isApproved = r.status === 'approved' || r.status === 'accounting_approved';
                          const handleRevoke = async () => {
                            setDecidingDispute(r.id);
                            try {
                              const res = await fetch(`/api/pab-disputes/${r.id}?mode=admin`, {
                                method: 'DELETE',
                              });
                              if (res.ok) {
                                setPendingDisputeRows(prev => prev.filter(d => d.id !== r.id));
                                refetchApproved();
                              }
                            } finally {
                              setDecidingDispute(null);
                            }
                          };
                          const handleDecide = async (action: 'approve' | 'deny') => {
                            setDecidingDispute(r.id);
                            try {
                              const res = await fetch(`/api/pab-disputes/${r.id}`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  action,
                                  decided_by: sessionEmail ?? 'Accounting',
                                }),
                              });
                              if (res.ok) {
                                if (action === 'approve') {
                                  // Keep row in panel with updated status so Revoke button appears
                                  setPendingDisputeRows(prev => prev.map(d =>
                                    d.id === r.id ? { ...d, status: 'approved' } : d,
                                  ));
                                } else {
                                  setPendingDisputeRows(prev => prev.filter(d => d.id !== r.id));
                                }
                                refetchApproved();
                              }
                            } finally {
                              setDecidingDispute(null);
                            }
                          };
                          return (
                            <div key={r.id} className="px-3 py-2">
                              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                <span className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-200">{name}</span>
                                <span className="font-mono text-[11px] text-amber-700 dark:text-amber-400">{r.dispute_date}</span>
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">{reasonLabel}</span>
                                {isApproved && (
                                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Forgiven</span>
                                )}
                              </div>
                              {r.explanation && (
                                <p className="mt-0.5 text-[11px] italic text-zinc-500 dark:text-zinc-400">{r.explanation}</p>
                              )}
                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                {!isApproved && (
                                  <button
                                    type="button"
                                    disabled={isDeciding}
                                    onClick={() => void handleDecide('approve')}
                                    className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-700 dark:hover:bg-emerald-600"
                                  >
                                    {isDeciding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                    Forgive
                                  </button>
                                )}
                                {!isApproved && (
                                  <button
                                    type="button"
                                    disabled={isDeciding}
                                    onClick={() => void handleDecide('deny')}
                                    className="flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-zinc-600 transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
                                  >
                                    <X className="h-3 w-3" />
                                    Deny
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={isDeciding}
                                  onClick={() => void handleRevoke()}
                                  className="flex items-center gap-1 rounded-md border border-red-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:bg-zinc-900 dark:text-red-400 dark:hover:bg-red-950/30"
                                >
                                  {isDeciding ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                                  Revoke
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

              </div>{/* end hidden bonus-rules panel */}

              {/* Employee bonus table */}
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

                    {/* Reveal the note attached to each adjustment in the Adj. column. */}
                    <div className="flex items-center justify-end gap-2">
                      <FileText className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                      <Label htmlFor="show-adj-notes" className="cursor-pointer text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                        Show adjustment notes
                      </Label>
                      <Switch
                        id="show-adj-notes"
                        checked={showAdjNotes}
                        onCheckedChange={setShowAdjNotes}
                        className="data-[state=checked]:bg-amber-600"
                      />
                    </div>

                    {/* Manager-submitted bonus note — explains why metric inputs may be
                        blank while the Bonus column is populated from the KPI Calculator. */}
                    {managerBonusMeta[activeDeptTab] && (
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-emerald-300/70 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-200">
                        <Check className="h-3.5 w-3.5 shrink-0" />
                        <span className="font-semibold">Bonuses submitted by the department manager.</span>
                        <span className="opacity-80">
                          From the KPI Calculator · week of {managerBonusMeta[activeDeptTab]!.period_start} · {managerBonusMeta[activeDeptTab]!.status}. Amounts appear in the KPI Sub. column — use Adj. to override the total.
                        </span>
                      </div>
                    )}

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
                            {pabColShown && (
                              <TableHead className="min-w-[96px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-indigo-600 dark:text-indigo-400">
                                PAB<br />
                                <span className="font-mono font-normal text-zinc-400">M T W T F · 7h+</span>
                              </TableHead>
                            )}
                            {techColShown && (
                              <TableHead className="min-w-[80px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-sky-600 dark:text-sky-400">
                                Tech<br />
                                <span className="font-mono font-normal text-zinc-400">
                                  {techBonusWeekInfo.isTechBonusWeek ? 'week 3 - ' : ''}
                                  {formatPHP(techAmountPhp)}
                                </span>
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
                            {managerBonusMeta[activeDeptTab] && (
                              <TableHead
                                className="min-w-[80px] px-1 py-2 text-center text-[9px] font-medium leading-tight text-emerald-600 dark:text-emerald-400"
                                title="Bonus amounts submitted by the department manager via the KPI Calculator"
                              >
                                KPI Sub.<br />
                                <span className="font-mono font-normal text-zinc-400">{managerBonusMeta[activeDeptTab]!.period_start}</span>
                              </TableHead>
                            )}
                            <TableHead
                              className="min-w-[60px] px-1 py-2 text-right text-[9px] font-medium leading-tight text-rose-600 dark:text-rose-400"
                              title="MESA deduction — applied automatically to employees enrolled in MESA (mesa_member=true on their rates row)"
                            >
                              MESA<br />
                              <span className="font-mono font-normal text-zinc-400">-{formatPHP(100)}</span>
                            </TableHead>
                            <TableHead className="min-w-[72px] px-1 py-2 text-right text-[11px] font-medium text-amber-600 dark:text-amber-400">
                              Adj.
                            </TableHead>
                            <TableHead
                              className="min-w-[80px] px-1 py-2 text-right text-[11px] font-medium text-pink-600 dark:text-pink-400"
                              title="Orphanage pay — a manual amount added on top of final pay; appears as its own paystub line."
                            >
                              Orphanage
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
                            // Adj. is a signed delta added on top of the auto subtotal
                            // (PAB + Tech + KPI + dept bonuses), never a replacement.
                            const adj = bonusOverrides[emp.email] ?? 0;
                            const bonusTotal = autoBonus + adj;
                            const empRateRow = ratesByEmail.get(normEmail(emp.email) ?? '');
                            // Accounting-approved disbursement (not yet paid via Urgent Payments) — paid out in this run.
                            const empMesaDisbursement = mesaDisbursements.get(normEmail(emp.email) ?? '') ?? 0;
                            // Always deduct the ₱100 contribution when enrolled OR when a disbursement is being
                            // paid out this run (a disbursement implies an active MESA member).
                            const empMesaDeduction = (emp.initialPay != null && (empRateRow?.mesa_member || empMesaDisbursement > 0)) ? 100 : 0;
                            // Orphanage pay — manual positive amount added on top of final pay.
                            const hasOrphanage = orphanageAmounts[emp.email] !== undefined;
                            const orphanagePay = orphanageAmounts[emp.email] ?? 0;
                            const finalPay = (emp.initialPay ?? 0) + bonusTotal - empMesaDeduction + empMesaDisbursement + orphanagePay;
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
                                {pabColShown && (() => {
                                  const normEmpEmail = normEmail(emp.email) ?? emp.email.toLowerCase();
                                  // Accountant-excluded → distinct pill; ₱0 PAB regardless of attendance.
                                  if (isPabExcluded(emp.email)) {
                                    return (
                                      <TableCell className="px-1 py-1.5 text-center">
                                        <button
                                          type="button"
                                          onClick={() => setPabSettingsOpen(true)}
                                          title="Excluded from PAB this month by Accounting — earns ₱0 PAB. Click to manage exclusions."
                                          className={cn(
                                            'group inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none transition-all duration-200',
                                            'hover:scale-105 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-offset-1 dark:focus:ring-offset-zinc-900',
                                            'bg-rose-100 text-rose-700 ring-1 ring-rose-400/40 hover:bg-rose-200 focus:ring-rose-400 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-500/30 dark:hover:bg-rose-950/60',
                                          )}
                                        >
                                          <UserX className="h-3 w-3" />
                                          <span>Excluded</span>
                                        </button>
                                      </TableCell>
                                    );
                                  }
                                  const rawStatus = effectivePabStatus.get(normEmpEmail) ?? 'in_progress';
                                  // "In progress" means no weekday has been failed yet — the employee is
                                  // effectively eligible for this period and stays eligible until the next PAB
                                  // is initiated. Show it green with the Payment-Catalog PAB amount rather than
                                  // a neutral "In Progress"; only an actual failed day locks it to Ineligible.
                                  const status = rawStatus === 'in_progress' ? 'eligible' : rawStatus;
                                  const label =
                                    status === 'eligible' ? '✓ Eligible'
                                    : status === 'ineligible' ? '✗ Ineligible'
                                    : '⏳ In Progress';
                                  const titleText =
                                    rawStatus === 'ineligible' ? 'Already failed at least one past weekday — locked for this period. Click to see which day.'
                                    : rawStatus === 'in_progress' ? 'No failed weekday so far — eligible for this period until the next PAB is initiated. Click to see the calendar.'
                                    : 'Passed every Mon–Fri in the PAB period — click to see the calendar.';
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
                                        <span>{status === 'eligible' ? (isPabDeptEligible(emp.email) ? `+${formatPHP(pabAmountPhp)}` : label) : label}</span>
                                      </button>
                                    </TableCell>
                                  );
                                })()}
                                {/* Tech Bonus — week-detected pill; accounting can manually grant */}
                                {techColShown && (() => {
                                  const em = normEmail(emp.email);
                                  const sd = em ? startDateByEmail.get(em) : undefined;
                                  const hasRates = emp.regularRate != null || emp.otRate != null;
                                  const techOn = techBonusEligible.has(emp.email);
                                  const isManualGrant = techBonusManualGrants.has(emp.email);
                                  const isManualRevoke = techBonusManualRevokes.has(emp.email);
                                  const titleText = techOn
                                    ? isManualGrant
                                      ? 'Manually granted by Accounting this session.'
                                      : `Auto-applied: salary date ${techBonusWeekInfo.salaryDate?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) ?? ''} lands in the 3rd full Mon–Sun week.`
                                    : isManualRevoke
                                      ? 'Manually revoked this session — click to restore.'
                                      : !techBonusWeekInfo.isTechBonusWeek
                                        ? 'Not the Tech Bonus week — click to grant manually.'
                                        : !hasRates
                                          ? 'No PH rate — click to grant manually.'
                                          : !sd
                                            ? 'No start date — click to grant manually.'
                                            : 'Less than 30 days of service — click to grant manually.';
                                  return (
                                    <TableCell className="px-1 py-1.5 text-center">
                                      {techOn && isTechDeptEligible(emp.email) ? (
                                        <span className="inline-flex items-center gap-1">
                                          <span
                                            title={titleText}
                                            className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold leading-none text-sky-700 ring-1 ring-sky-400/40 dark:bg-sky-900/40 dark:text-sky-300 dark:ring-sky-500/30"
                                          >
                                            +{formatPHP(techAmountPhp)}
                                          </span>
                                          <button
                                            type="button"
                                            title="Revoke Tech Bonus for this employee"
                                            onClick={() => {
                                              if (isManualGrant) {
                                                setTechBonusManualGrants(prev => { const next = new Set(prev); next.delete(emp.email); return next; });
                                              } else {
                                                setTechBonusManualRevokes(prev => { const next = new Set(prev); next.add(emp.email); return next; });
                                              }
                                            }}
                                            className="inline-flex items-center justify-center rounded-full w-3.5 h-3.5 bg-red-100 text-red-500 ring-1 ring-red-300/50 transition-colors hover:bg-red-200 hover:text-red-700 dark:bg-red-900/30 dark:text-red-400 dark:ring-red-700/40 dark:hover:bg-red-900/60"
                                          >
                                            <X className="w-2 h-2" />
                                          </button>
                                        </span>
                                      ) : (
                                        <button
                                          type="button"
                                          title={titleText}
                                          onClick={() => {
                                            setTechBonusManualRevokes(prev => { const next = new Set(prev); next.delete(emp.email); return next; });
                                            setTechBonusManualGrants(prev => { const next = new Set(prev); next.add(emp.email); return next; });
                                          }}
                                          className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold leading-none text-zinc-400 ring-1 ring-zinc-300/40 transition-colors hover:bg-amber-100 hover:text-amber-700 hover:ring-amber-400/50 dark:bg-zinc-800/60 dark:text-zinc-500 dark:ring-zinc-700/40 dark:hover:bg-amber-900/30 dark:hover:text-amber-300"
                                        >
                                          Grant
                                        </button>
                                      )}
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
                                            disabled={amount === 0 || isReplay}
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
                                        disabled={isReplay}
                                      />
                                    </TableCell>
                                  );
                                })}
                                {/* KPI Submission — manager-submitted per-employee bonus from the KPI Calculator */}
                                {managerBonusMeta[activeDeptTab] && (() => {
                                  const kpiAmt = resolvedManagerBonus[emp.email];
                                  // Per-source-department breakdown for the hover. When a person
                                  // earned a KPI in more than one department (e.g. transferred
                                  // mid-cycle), each source + amount is listed.
                                  const breakdown = resolvedManagerBonusByDept[emp.email];
                                  const parts = breakdown
                                    ? Object.entries(breakdown)
                                        .filter(([, v]) => v)
                                        .map(([d, v]) => `${DEPARTMENTS.find((x) => x.key === d)?.name ?? d} — ${formatPHP(v)}`)
                                    : [];
                                  const multi = parts.length > 1;
                                  const title = parts.length > 0
                                    ? `KPI from ${parts.length === 1 ? 'department' : `${parts.length} departments`}:\n${parts.join('\n')}\n(submitted by manager · ${managerBonusMeta[activeDeptTab]!.status})`
                                    : `Submitted by manager · ${managerBonusMeta[activeDeptTab]!.status}`;
                                  return (
                                    <TableCell className="px-1 py-1.5 text-center">
                                      {kpiAmt != null ? (
                                        <span
                                          title={title}
                                          className={cn(
                                            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none ring-1',
                                            multi
                                              ? 'cursor-help bg-amber-100 text-amber-800 ring-amber-400/50 dark:bg-amber-900/40 dark:text-amber-200 dark:ring-amber-500/30'
                                              : 'bg-emerald-100 text-emerald-700 ring-emerald-400/40 dark:bg-emerald-900/40 dark:text-emerald-300 dark:ring-emerald-500/30',
                                          )}
                                        >
                                          {formatPHP(kpiAmt)}
                                          {multi && <span className="font-mono text-[8px] opacity-70">×{parts.length}</span>}
                                        </span>
                                      ) : (
                                        <span className="text-[9px] text-zinc-300 dark:text-zinc-700">—</span>
                                      )}
                                    </TableCell>
                                  );
                                })()}
                                {/* MESA — automatic -PHP100 contribution for members, plus any accounting-approved
                                    disbursement (paid out this run). Both fold into Final pay. */}
                                <TableCell
                                  className={cn(
                                    'px-1 py-1.5 text-right font-mono text-[11px] tabular-nums',
                                    empMesaDisbursement > 0
                                      ? 'font-semibold text-emerald-600 dark:text-emerald-400'
                                      : empMesaDeduction > 0
                                        ? 'font-semibold text-rose-600 dark:text-rose-400'
                                        : 'text-zinc-300 dark:text-zinc-700',
                                  )}
                                  title={[
                                    empMesaDisbursement > 0 ? `Approved disbursement +${formatPHP(empMesaDisbursement)} (added to Final pay)` : null,
                                    empMesaDeduction > 0 ? `MESA member — ${formatPHP(empMesaDeduction)} contribution deducted` : null,
                                  ].filter(Boolean).join(' · ') || 'Not enrolled in MESA'}
                                >
                                  {empMesaDisbursement > 0 ? (
                                    <div className="flex flex-col items-end leading-tight">
                                      <span>+{formatPHP(empMesaDisbursement)}</span>
                                      {empMesaDeduction > 0 && (
                                        <span className="text-[9px] text-rose-500 dark:text-rose-400">-{formatPHP(empMesaDeduction)}</span>
                                      )}
                                    </div>
                                  ) : empMesaDeduction > 0 ? (
                                    `-${formatPHP(empMesaDeduction)}`
                                  ) : (
                                    '—'
                                  )}
                                </TableCell>
                                <TableCell className="px-1 py-1.5 text-right font-mono text-[11px] font-bold">
                                  {isRecalcPending ? (
                                    <span className="inline-block h-3 w-12 animate-pulse rounded bg-amber-200/60 dark:bg-amber-900/40" />
                                  ) : hasOverride ? (
                                    <div className="flex flex-col items-end gap-1">
                                      <div className="flex items-center justify-end gap-1">
                                        <input
                                          type="number"
                                          inputMode="decimal"
                                          step="0.01"
                                          value={bonusOverrides[emp.email] ?? ''}
                                          onChange={(e) => {
                                            const raw = e.target.value;
                                            const next = raw === '' ? 0 : Number(raw);
                                            if (!Number.isFinite(next)) return;
                                            updateBonusOverride(emp.email, next);
                                          }}
                                          disabled={isReplay}
                                          title={`Signed adjustment added on top of auto-computed bonuses (${formatPHP(autoBonus)}). Use a negative value to deduct.`}
                                          className="h-6 w-[88px] rounded border border-amber-400/70 bg-white px-1.5 text-right font-mono text-[11px] font-bold tabular-nums text-amber-700 focus:outline-none focus:ring-1 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-700/60 dark:bg-zinc-900 dark:text-amber-300"
                                        />
                                        {/* When notes are hidden, flag rows that have one so it isn't forgotten. */}
                                        {!showAdjNotes && (bonusOverrideNotes[emp.email]?.trim() ?? '') !== '' && (
                                          <span title={bonusOverrideNotes[emp.email]} className="inline-flex shrink-0">
                                            <FileText className="h-3 w-3 text-amber-500 dark:text-amber-400" />
                                          </span>
                                        )}
                                        {!isReplay && (
                                          <button
                                            type="button"
                                            onClick={() => updateBonusOverride(emp.email, null)}
                                            title={`Clear adjustment (auto bonuses: ${formatPHP(autoBonus)})`}
                                            className="text-zinc-400 hover:text-red-500"
                                          >
                                            <X className="h-3 w-3" />
                                          </button>
                                        )}
                                      </div>
                                      {showAdjNotes && (
                                        <input
                                          type="text"
                                          value={bonusOverrideNotes[emp.email] ?? ''}
                                          onChange={(e) => updateBonusOverrideNote(emp.email, e.target.value)}
                                          disabled={isReplay}
                                          placeholder={isReplay ? 'No note' : 'Add a note…'}
                                          title="Why was this adjustment made? Saved with the adjustment for this pay period."
                                          className="h-6 w-[140px] rounded border border-zinc-200 bg-white px-1.5 text-right text-[10px] font-normal text-zinc-700 placeholder:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-70 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:placeholder:text-zinc-600"
                                        />
                                      )}
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      disabled={isReplay}
                                      title={isReplay ? `Auto bonuses: ${formatPHP(autoBonus)}` : `Auto bonuses: ${formatPHP(autoBonus)} — click to add a signed adjustment`}
                                      onClick={() => updateBonusOverride(emp.email, 0)}
                                      className="text-zinc-300 hover:text-amber-600 disabled:cursor-default disabled:hover:text-zinc-300 dark:text-zinc-700 dark:hover:text-amber-400 dark:disabled:hover:text-zinc-700"
                                    >
                                      —
                                    </button>
                                  )}
                                </TableCell>
                                {/* Orphanage pay — manual positive amount added to final pay; own paystub line */}
                                <TableCell className="px-1 py-1.5 text-right font-mono text-[11px] font-bold">
                                  {hasOrphanage ? (
                                    <div className="flex items-center justify-end gap-1">
                                      <input
                                        type="number"
                                        inputMode="decimal"
                                        step="0.01"
                                        min={0}
                                        value={orphanageAmounts[emp.email] ?? ''}
                                        onChange={(e) => {
                                          const raw = e.target.value;
                                          const next = raw === '' ? 0 : Number(raw);
                                          if (!Number.isFinite(next) || next < 0) return;
                                          updateOrphanageAmount(emp.email, next);
                                        }}
                                        disabled={isReplay}
                                        title="Orphanage pay (PHP) added on top of final pay"
                                        className="h-6 w-[88px] rounded border border-pink-400/70 bg-white px-1.5 text-right font-mono text-[11px] font-bold tabular-nums text-pink-700 focus:outline-none focus:ring-1 focus:ring-pink-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-pink-700/60 dark:bg-zinc-900 dark:text-pink-300"
                                      />
                                      {!isReplay && (
                                        <button
                                          type="button"
                                          onClick={() => updateOrphanageAmount(emp.email, null)}
                                          title="Clear orphanage pay"
                                          className="text-zinc-400 hover:text-red-500"
                                        >
                                          <X className="h-3 w-3" />
                                        </button>
                                      )}
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      disabled={isReplay}
                                      title={isReplay ? 'No orphanage pay' : 'Click to add orphanage pay'}
                                      onClick={() => updateOrphanageAmount(emp.email, 0)}
                                      className="text-zinc-300 hover:text-pink-600 disabled:cursor-default disabled:hover:text-zinc-300 dark:text-zinc-700 dark:hover:text-pink-400 dark:disabled:hover:text-zinc-700"
                                    >
                                      —
                                    </button>
                                  )}
                                </TableCell>
                                <TableCell className="px-1 py-1.5 text-right font-mono text-[11px] font-semibold text-zinc-900 dark:text-white">
                                  {isRecalcPending ? (
                                    <span className="inline-block h-3 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                                  ) : (
                                    <PhpWithUsd php={finalPay} usdToPhp={usdToPhpRate} />
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
                      {(() => {
                        // Pre-compute dept-level totals once so we can both
                        // surface MESA in the summary AND subtract it from the
                        // final-pay total (previously the footer overstated
                        // pay by ignoring MESA — only the per-row Final cell
                        // and the exported XLSX got it right).
                        const deptMesaTotal = deptEmployees.reduce((sum, e) => {
                          const rr = ratesByEmail.get(normEmail(e.email) ?? '');
                          return sum + (e.initialPay != null && rr?.mesa_member ? 100 : 0);
                        }, 0);
                        const deptMesaCount = deptEmployees.reduce((n, e) => {
                          const rr = ratesByEmail.get(normEmail(e.email) ?? '');
                          return n + (e.initialPay != null && rr?.mesa_member ? 1 : 0);
                        }, 0);
                        const deptBonusTotal = deptEmployees.reduce(
                          (sum, e) => sum + getEffectiveBonus(e.email),
                          0,
                        );
                        const deptFinalTotal = deptEmployees.reduce(
                          (sum, e) => sum + (e.initialPay ?? 0) + getEffectiveBonus(e.email) + (orphanageAmounts[e.email] ?? 0),
                          0,
                        ) - deptMesaTotal;
                        return (
                          <div className="flex flex-wrap items-center gap-4">
                            <span
                              className="text-xs text-zinc-500"
                              title={
                                deptMesaCount === 0
                                  ? 'No MESA members in this department'
                                  : `${deptMesaCount} MESA member${deptMesaCount === 1 ? '' : 's'} × ${formatPHP(100)}`
                              }
                            >
                              MESA:{' '}
                              {deptMesaTotal > 0 ? (
                                <span className="font-mono font-bold text-rose-600 dark:text-rose-400">
                                  -{formatPHP(deptMesaTotal)}
                                </span>
                              ) : (
                                <span className="font-mono text-zinc-400 dark:text-zinc-500">—</span>
                              )}
                            </span>
                            <span className="text-xs text-zinc-500">
                              Dept Bonuses:{' '}
                              {isRecalcPending ? (
                                <span className="inline-block h-3 w-20 animate-pulse rounded bg-emerald-200/60 align-middle dark:bg-emerald-900/40" />
                              ) : (
                                <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                                  +{formatPHP(deptBonusTotal)}
                                </span>
                              )}
                            </span>
                            <span className="text-xs text-zinc-500">
                              Dept Final Pay:{' '}
                              <span className="font-mono font-bold text-zinc-900 dark:text-white">
                                {formatPHP(deptFinalTotal)}
                              </span>
                              {usdToPhpRate > 0 && (
                                <span className="ml-1.5 font-mono text-[10px] font-normal text-blue-500 dark:text-blue-400">
                                  ≈&nbsp;{formatUsdFromPhp(deptFinalTotal, usdToPhpRate)}
                                </span>
                              )}
                            </span>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                  </div>
                  );
                })()}
              </div>
                  </motion.div>
                </AnimatePresence>
              </div>{/* content: review panel + table */}
            </div>{/* department workspace flex-row */}
          </div>
        );
      }
      case 3: {
        // ──────────── Orphanage step ────────────
        // Paste-driven per-employee orphanage pay. Paste three columns from a sheet —
        // Pay week ⇥ Work email ⇥ Hours — and lock in. Each row is matched to an
        // employee by work email (case-insensitive) and valued at hours × their PHP
        // regular rate, then written to the per-employee Orphanage column in the
        // Additions tab (orphanageAmounts). See orphanagePasteParse / lockInOrphanagePaste.
        const { ok: orphOk, errors: orphErrors } = orphanagePasteParse;
        const orphTotal = orphOk.reduce((s, r) => s + r.amount, 0);
        const orphPeriodLabel = formatPeriodLabel(calcSourceFile);
        const orphReady = !isReplay && orphOk.length > 0 && !orphanageLockingIn;

        // "Locked in this period" — the orphanage amounts currently on the Orphanage
        // column for this period (orphanageAmounts = the durable additions blob), so the
        // locked-in values stay visible here after locking in / across reloads. Enriched
        // with hours/OT split from the orphanage_pay record when available.
        const orphNameByEmail = new Map<string, string>();
        for (const r of effectiveCalcResults) {
          if (r.email && !orphNameByEmail.has(r.email)) orphNameByEmail.set(r.email, r.name || r.email);
        }
        const orphLocked = Object.entries(orphanageAmounts)
          .map(([email, amount]) => ({
            email,
            name: orphNameByEmail.get(email) ?? email,
            amount,
            detail: orphanagePayDetail[email.toLowerCase()] ?? null,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const orphLockedTotal = orphLocked.reduce((s, e) => s + (e.amount ?? 0), 0);
        return (
          <div className="flex min-w-0 flex-col gap-5">
            {/* Header banner */}
            <div className="flex flex-col gap-1.5 rounded-2xl border border-rose-200/70 bg-gradient-to-br from-rose-50 via-white to-pink-50/40 p-5 shadow-sm dark:border-rose-900/40 dark:from-rose-950/30 dark:via-zinc-950 dark:to-rose-950/15">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-rose-700 dark:text-rose-300">
                <Heart className="h-3.5 w-3.5" /> Orphanage pay
              </div>
              <h2 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-white">
                Paste orphanage hours, lock in the pay
              </h2>
              <p className="max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
                Paste three columns straight from your sheet — <span className="font-medium text-zinc-800 dark:text-zinc-200">Pay week</span>, <span className="font-medium text-zinc-800 dark:text-zinc-200">Work email</span>, and <span className="font-medium text-zinc-800 dark:text-zinc-200">Hours</span>. Each person is matched by work email. Hours <span className="font-medium text-zinc-800 dark:text-zinc-200">stack on their worked hours against the 40h/week cap</span>, so anything past 40 pays at the <span className="font-medium text-zinc-800 dark:text-zinc-200">OT rate</span>. Locking in writes the amount to the <span className="font-medium text-zinc-800 dark:text-zinc-200">Orphanage</span> column in the Additions tab.
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px]">
                <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-white/70 px-2.5 py-1 font-medium text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
                  <CalendarDays className="h-3.5 w-3.5" /> Pay period · {orphPeriodLabel}
                </span>
                <span className="text-zinc-500 dark:text-zinc-500">The pay-week column is informational — every matched row is applied to this period.</span>
              </div>
            </div>

            {isReplay && (
              <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                <Info className="h-4 w-4 shrink-0" />
                You&apos;re replaying a past period — the Orphanage paste tool is view-only here.
              </div>
            )}

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              {/* Paste input */}
              <Card className="border-zinc-200 dark:border-zinc-800">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <FileText className="h-4 w-4 text-rose-600 dark:text-rose-400" /> Paste data
                  </CardTitle>
                  <CardDescription>One row per person: Pay week, Work email, Hours (tab-separated).</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <textarea
                    value={orphanagePaste}
                    onChange={(e) => setOrphanagePaste(e.target.value)}
                    disabled={isReplay}
                    spellCheck={false}
                    rows={12}
                    placeholder={'6/8- 6/14\teulap@simple.biz\t12.57\n6/8- 6/14\tjenl@simple.biz\t12.57'}
                    className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2.5 font-mono text-[13px] leading-relaxed text-zinc-900 shadow-sm outline-none transition focus:border-rose-400 focus:ring-2 focus:ring-rose-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-rose-600 dark:focus:ring-rose-900/40"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3 text-[13px]">
                      <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="h-4 w-4" /> {orphOk.length} ready
                      </span>
                      {orphErrors.length > 0 && (
                        <span className="inline-flex items-center gap-1.5 font-medium text-rose-700 dark:text-rose-400">
                          <AlertTriangle className="h-4 w-4" /> {orphErrors.length} skipped
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {orphanagePaste.trim() !== '' && (
                        <Button variant="ghost" size="sm" onClick={() => setOrphanagePaste('')} disabled={orphanageLockingIn} className="text-zinc-500">
                          Clear
                        </Button>
                      )}
                      <Button
                        size="sm"
                        onClick={() => void lockInOrphanagePaste()}
                        disabled={!orphReady}
                        className="gap-2 bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
                      >
                        {orphanageLockingIn ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
                        Lock in values
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Preview */}
              <Card className="border-zinc-200 dark:border-zinc-800">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Sparkles className="h-4 w-4 text-rose-600 dark:text-rose-400" /> Preview
                  </CardTitle>
                  <CardDescription>
                    {orphOk.length > 0
                      ? <>Total to add: <span className="font-semibold text-zinc-800 dark:text-zinc-200">{formatPHP(orphTotal)}</span> across {orphOk.length} {orphOk.length === 1 ? 'person' : 'people'}.</>
                      : 'Matched rows and their computed amounts appear here.'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  {orphanagePaste.trim() === '' ? (
                    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-300 py-10 text-center text-sm text-zinc-400 dark:border-zinc-700 dark:text-zinc-600">
                      <Heart className="h-6 w-6 opacity-40" />
                      Paste your three columns to see the preview.
                    </div>
                  ) : (
                    <>
                      {orphOk.length > 0 && (
                        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                          <table className="w-full text-[13px]">
                            <thead>
                              <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
                                <th className="px-3 py-2">Employee</th>
                                <th className="px-3 py-2 text-right">Hours</th>
                                <th className="px-3 py-2 text-right">Rate</th>
                                <th className="px-3 py-2 text-right">Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {orphOk.map((r) => {
                                const prev = orphanageAmounts[r.emailKey];
                                const changed = prev !== undefined && Math.abs(prev - r.amount) > 0.005;
                                return (
                                  <tr key={`${r.line}-${r.emailKey}`} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                                    <td className="px-3 py-2" data-label="Employee">
                                      <div className="font-medium text-zinc-800 dark:text-zinc-200">{r.name}</div>
                                      <div className="text-[11px] text-zinc-400 dark:text-zinc-500">{r.matchedEmail}{r.payWeek ? ` · ${r.payWeek}` : ''}</div>
                                    </td>
                                    <td className="px-3 py-2 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-400" data-label="Hours">
                                      {r.hours.toFixed(2)}
                                      {r.otH > 0 && (
                                        <div className="text-[10px] font-normal text-amber-600 dark:text-amber-400">{r.regH.toFixed(2)} reg + {r.otH.toFixed(2)} OT</div>
                                      )}
                                    </td>
                                    <td className="px-3 py-2 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-400" data-label="Rate">
                                      {formatPHP(r.rate)}
                                      {r.otH > 0 && r.otRate != null && (
                                        <div className="text-[10px] font-normal text-amber-600 dark:text-amber-400">OT {formatPHP(r.otRate)}</div>
                                      )}
                                    </td>
                                    <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-zinc-900 dark:text-white" data-label="Amount">
                                      {formatPHP(r.amount)}
                                      {changed && <div className="text-[10px] font-normal text-amber-600 dark:text-amber-400">was {formatPHP(prev)}</div>}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                            <tfoot>
                              <tr className="border-t border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
                                <td className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-300" colSpan={3}>Total</td>
                                <td className="px-3 py-2 text-right font-mono font-bold tabular-nums text-zinc-900 dark:text-white">{formatPHP(orphTotal)}</td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      )}

                      {orphErrors.length > 0 && (
                        <div className="rounded-lg border border-rose-200 bg-rose-50/60 p-3 dark:border-rose-900/40 dark:bg-rose-950/20">
                          <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-300">
                            <AlertTriangle className="h-3.5 w-3.5" /> {orphErrors.length} row{orphErrors.length === 1 ? '' : 's'} skipped
                          </div>
                          <ul className="flex flex-col gap-1 text-[12.5px] text-rose-800 dark:text-rose-300">
                            {orphErrors.map((e, idx) => (
                              <li key={idx} className="flex gap-2">
                                <span className="shrink-0 font-mono text-rose-400 dark:text-rose-500">L{e.line}</span>
                                <span className="min-w-0">
                                  {e.email && <span className="font-medium">{e.email}</span>}{e.email ? ' — ' : ''}{e.reason}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Locked in this period — keeps locked-in orphanage pay visible in this tab */}
            <Card className="border-zinc-200 dark:border-zinc-800">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Lock className="h-4 w-4 text-rose-600 dark:text-rose-400" /> Locked in this period
                </CardTitle>
                <CardDescription>
                  {orphLocked.length > 0
                    ? <>{orphLocked.length} {orphLocked.length === 1 ? 'person' : 'people'} · <span className="font-semibold text-zinc-800 dark:text-zinc-200">{formatPHP(orphLockedTotal)}</span> on the Additions Orphanage column for {orphPeriodLabel}.</>
                    : 'Amounts you lock in stay here for this pay period.'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {orphLocked.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-300 py-8 text-center text-sm text-zinc-400 dark:border-zinc-700 dark:text-zinc-600">
                    <Heart className="h-5 w-5 opacity-40" />
                    Nothing locked in yet for this period.
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
                          <th className="px-3 py-2">Employee</th>
                          <th className="px-3 py-2 text-right">Hours</th>
                          <th className="px-3 py-2 text-right">Amount</th>
                          {!isReplay && <th className="w-10 px-3 py-2" />}
                        </tr>
                      </thead>
                      <tbody>
                        {orphLocked.map((e) => (
                          <tr key={e.email} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                            <td className="px-3 py-2" data-label="Employee">
                              <div className="font-medium text-zinc-800 dark:text-zinc-200">{e.name}</div>
                              <div className="text-[11px] text-zinc-400 dark:text-zinc-500">{e.email}{e.detail?.payWeek ? ` · ${e.detail.payWeek}` : ''}</div>
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-400" data-label="Hours">
                              {e.detail ? (
                                <>
                                  {e.detail.hours.toFixed(2)}
                                  {e.detail.otH > 0 && (
                                    <div className="text-[10px] font-normal text-amber-600 dark:text-amber-400">{e.detail.regH.toFixed(2)} reg + {e.detail.otH.toFixed(2)} OT</div>
                                  )}
                                </>
                              ) : (
                                <span className="text-zinc-300 dark:text-zinc-600">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-zinc-900 dark:text-white" data-label="Amount">{formatPHP(e.amount)}</td>
                            {!isReplay && (
                              <td className="px-2 py-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => void removeOrphanageLocked(e.email)}
                                  title="Remove this orphanage amount"
                                  className="rounded p-1 text-zinc-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30 dark:hover:text-rose-400"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
                          <td className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-300">Total</td>
                          <td className="px-3 py-2" />
                          <td className="px-3 py-2 text-right font-mono font-bold tabular-nums text-zinc-900 dark:text-white">{formatPHP(orphLockedTotal)}</td>
                          {!isReplay && <td className="px-3 py-2" />}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        );
      }
      case 4: {
        // ── HSL (Hogan Smith Law) ─────────────────────────────────────────────
        const hslCalcRows = effectiveCalcResults.filter(
          r => employeeDepts[r.email] === 'hogan_smith_law',
        ).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        // Hide the PAB / Tech columns when HSL is not assigned the bonus (or it's disabled).
        const pabColShownHsl = isDeptEligible(sysBonusCfg.pab, 'hogan_smith_law');
        const techColShownHsl = isDeptEligible(sysBonusCfg.tech, 'hogan_smith_law');

        const totalHslInitialPay = hslCalcRows.reduce((s, r) => s + (r.initialPay ?? 0), 0);
        const totalHslKpiBonuses = Object.values(hslStepBonusByEmail).reduce((s, v) => s + v, 0);

        const monthLabelHsl = pabMonthRange
          ? `${pabMonthRange.monthName} ${pabMonthRange.year}`
          : 'Active PAB month';

        const fmtPeriod = (p: { period_type: string; period_start: string }) => {
          if (p.period_type === 'monthly') {
            const d = new Date(`${p.period_start}T12:00:00`);
            return d.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
          }
          return `Wk of ${p.period_start}`;
        };

        // ── HSL sub-department grouping (mirrors the Additions dept rail) ──────────
        // Each Hogan employee is mapped to an HSL sub-department via the
        // hsl_team_members roster (hslDeptByEmail); rows with no roster match fall
        // into an "Unassigned" bucket. The rail drives BOTH the employee table and
        // the KPI Bonus Period cards — selecting a department shows only its people
        // and only its KPI period card.
        const hslKeySet = new Set<string>(HSL_DEPT_KEYS);
        const hslDeptOfRow = (email: string): string => {
          const k = hslDeptByEmail[(email ?? '').toLowerCase()];
          return k && hslKeySet.has(k) ? k : 'unassigned';
        };
        const hslDeptCounts = new Map<string, number>();
        for (const r of hslCalcRows) {
          const d = hslDeptOfRow(r.email);
          hslDeptCounts.set(d, (hslDeptCounts.get(d) ?? 0) + 1);
        }
        const hslPeriodDeptSet = new Set(hslStepPeriods.map(p => p.department));
        // Rail order follows canonical HSL_DEPT_KEYS; a dept appears if it has people
        // this cycle OR a ready/locked KPI period.
        const hslRailDeptKeys = HSL_DEPT_KEYS.filter(
          k => (hslDeptCounts.get(k) ?? 0) > 0 || hslPeriodDeptSet.has(k),
        );
        const hslHasUnassigned = (hslDeptCounts.get('unassigned') ?? 0) > 0;
        const hslValidDeptKeys = new Set<string>([
          'all',
          ...hslRailDeptKeys,
          ...(hslHasUnassigned ? ['unassigned'] : []),
        ]);
        // Guard against a stale selection (dept emptied out between refreshes).
        const activeHslDeptSafe = hslValidDeptKeys.has(activeHslDept) ? activeHslDept : 'all';
        const visibleHslRows = activeHslDeptSafe === 'all'
          ? hslCalcRows
          : hslCalcRows.filter(r => hslDeptOfRow(r.email) === activeHslDeptSafe);
        const visibleHslPeriods = activeHslDeptSafe === 'all'
          ? hslStepPeriods
          : hslStepPeriods.filter(p => p.department === activeHslDeptSafe);
        const activeHslDeptName = activeHslDeptSafe === 'all'
          ? 'All HSL Departments'
          : activeHslDeptSafe === 'unassigned'
            ? 'Unassigned'
            : (HSL_DEPTS as Record<string, { name: string }>)[activeHslDeptSafe]?.name ?? activeHslDeptSafe;

        return (
          <div className="flex min-w-0 flex-col gap-5">

            {/* Header banner */}
            <div className="flex flex-col gap-1 rounded-2xl border border-violet-200/70 bg-gradient-to-br from-violet-50 via-white to-indigo-50/40 p-5 shadow-sm dark:border-violet-900/40 dark:from-violet-950/30 dark:via-zinc-950 dark:to-indigo-950/15">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-violet-700 dark:text-violet-300">
                <Building2 className="h-3.5 w-3.5" /> Hogan Smith Law &middot; {monthLabelHsl}
              </div>
              <h2 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-white">
                HSL Payroll &mdash; Initial Pay + KPI Bonuses
              </h2>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                HSL runs Mon&ndash;Sun weeks (&ge;5 days at &ge;7 h). KPI bonuses are pulled from the manager KPI Calculator.
                PAB ({formatPHP(pabAmountPhp)}) and Tech Bonus ({formatPHP(techAmountPhp)}) are shown per-row and included in Total Pay.
                Use the Adjustment column to adjust any employee&apos;s bonus before dispatch.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                <span className="rounded-full border border-violet-300/70 bg-violet-50 px-2.5 py-0.5 font-medium text-violet-800 dark:border-violet-700/60 dark:bg-violet-950/40 dark:text-violet-200">
                  {hslCalcRows.length} employees
                </span>
                <span className="rounded-full border border-zinc-200 bg-white px-2.5 py-0.5 font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                  Initial pay: {formatPHP(totalHslInitialPay)}
                </span>
                <span className="rounded-full border border-emerald-300/70 bg-emerald-50 px-2.5 py-0.5 font-medium text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-200">
                  KPI bonuses: +{formatPHP(totalHslKpiBonuses)}
                </span>
                {hslStepPeriods.length > 0 && (
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {hslStepPeriods.length} dept period{hslStepPeriods.length !== 1 ? 's' : ''} ready
                  </span>
                )}
              </div>
            </div>

            {/* Department workspace: HSL sub-dept rail (left) + content (right).
                Mirrors the Additions tab. The rail filters BOTH the KPI Bonus
                Period cards and the employee table to the selected department. */}
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
              {/* HSL department rail */}
              <div className="flex gap-1.5 overflow-x-auto pb-1 xl:w-48 xl:shrink-0 xl:flex-col xl:gap-1 xl:overflow-visible xl:pb-0 [-ms-overflow-style:none] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-300/80 dark:[&::-webkit-scrollbar-thumb]:bg-zinc-600">
                <p className="hidden px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 xl:block dark:text-zinc-500">
                  HSL Departments
                </p>
                {(() => {
                  const railItems: { key: string; name: string; count: number; color?: string }[] = [
                    { key: 'all', name: 'All HSL', count: hslCalcRows.length },
                    ...hslRailDeptKeys.map(k => ({
                      key: k as string,
                      name: (HSL_DEPTS as Record<string, { name: string; color?: string }>)[k]?.name ?? k,
                      count: hslDeptCounts.get(k) ?? 0,
                      color: (HSL_DEPTS as Record<string, { name: string; color?: string }>)[k]?.color,
                    })),
                    ...(hslHasUnassigned
                      ? [{ key: 'unassigned', name: 'Unassigned', count: hslDeptCounts.get('unassigned') ?? 0 }]
                      : []),
                  ];
                  return railItems.map(item => {
                    const isActive = activeHslDeptSafe === item.key;
                    return (
                      <motion.button
                        key={item.key}
                        type="button"
                        onClick={() => { setActiveHslDept(item.key); setHslSearch(''); setHslPage(1); }}
                        whileTap={{ scale: 0.97 }}
                        className={cn(
                          'relative flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium xl:w-full xl:justify-between',
                          isActive
                            ? 'border-violet-500/50 text-violet-700 dark:text-violet-300'
                            : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/50',
                        )}
                        style={!isActive && item.color ? { borderLeftColor: item.color, borderLeftWidth: 3 } : undefined}
                      >
                        {isActive && (
                          <motion.span
                            layoutId="hsl-dept-active-bg"
                            className="absolute inset-0 rounded-[7px] bg-violet-600/10 dark:bg-violet-500/15"
                            transition={{ type: 'spring', stiffness: 400, damping: 34 }}
                          />
                        )}
                        <span className="relative truncate">{item.name}</span>
                        {item.count > 0 && (
                          <span
                            className={cn(
                              'relative shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none',
                              isActive
                                ? 'bg-violet-600 text-white'
                                : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400',
                            )}
                          >
                            {item.count}
                          </span>
                        )}
                      </motion.button>
                    );
                  });
                })()}
              </div>

              {/* Content: KPI cards + employee table (filtered to the active dept) */}
              <div className="min-w-0 flex-1">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={activeHslDeptSafe}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15, ease: 'easeOut' }}
                    className="flex flex-col gap-5"
                  >

            {/* KPI Bonus summary per department */}
            {hslStepLoading ? (
              <div className="flex items-center justify-center gap-2 rounded-xl border border-violet-100 bg-violet-50/50 py-8 dark:border-violet-900/30 dark:bg-violet-950/20">
                <Loader2 className="h-4 w-4 animate-spin text-violet-500" />
                <span className="text-sm text-violet-700 dark:text-violet-300">Loading KPI bonus data&hellip;</span>
              </div>
            ) : hslStepError ? (
              <p className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-700 dark:border-rose-800/50 dark:bg-rose-950/20 dark:text-rose-400">
                {hslStepError}
              </p>
            ) : visibleHslPeriods.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                  {activeHslDeptSafe === 'all'
                    ? 'KPI Bonus Periods (from manager submissions)'
                    : `${activeHslDeptName} — KPI Bonus Period`}
                </p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {visibleHslPeriods.map(p => {
                    const cfg = (HSL_DEPTS as Record<string, { name: string; color?: string }>)[p.department];
                    const deptColor = cfg?.color ?? '#6d28d9';
                    return (
                      <div
                        key={p.department}
                        className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950/60"
                        style={{ borderLeftColor: deptColor, borderLeftWidth: 3 }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                            {cfg?.name ?? p.department}
                          </div>
                          <div className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                            {fmtPeriod(p)} &middot; {p.entries.length} employee{p.entries.length !== 1 ? 's' : ''}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="font-mono text-sm font-bold text-emerald-700 dark:text-emerald-400">
                            {formatPHP(p.total_bonus)}
                          </div>
                          <span className={cn(
                            'inline-block rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide',
                            p.status === 'locked'
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                              : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
                          )}>
                            {p.status}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-violet-200 bg-violet-50/30 px-4 py-6 text-center text-xs text-violet-600 dark:border-violet-800/40 dark:bg-violet-950/10 dark:text-violet-400">
                {activeHslDeptSafe === 'all'
                  ? 'No ready or locked KPI periods found. Managers submit bonuses via the HSL Bonus Calculator.'
                  : `No ready or locked KPI period for ${activeHslDeptName} yet.`}
              </div>
            )}

            {/* Employee table: initial pay + KPI bonus + override */}
            {visibleHslRows.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center text-zinc-500 dark:text-zinc-400">
                <Building2 className="h-10 w-10 opacity-25" />
                <p className="text-sm">
                  {activeHslDeptSafe === 'all'
                    ? 'No HSL employees found in this payroll cycle.'
                    : `No employees in ${activeHslDeptName} for this cycle.`}
                </p>
              </div>
            ) : (() => {
              const needle = hslSearch.toLowerCase().trim();
              const filteredHsl = needle
                ? visibleHslRows.filter(r =>
                    (r.name ?? '').toLowerCase().includes(needle) ||
                    (r.email ?? '').toLowerCase().includes(needle),
                  )
                : visibleHslRows;
              const totalHslPages = Math.max(1, Math.ceil(filteredHsl.length / HSL_PAGE_SIZE));
              const safePage = Math.min(hslPage, totalHslPages);
              const pagedHsl = filteredHsl.slice((safePage - 1) * HSL_PAGE_SIZE, safePage * HSL_PAGE_SIZE);

              return (
                <div className="flex flex-col gap-0">
                  {/* Sticky search bar */}
                  <div className="sticky top-0 z-10 rounded-t-xl border border-b-0 border-zinc-200 bg-white/95 px-3 py-2.5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400 dark:text-zinc-500" />
                      <Input
                        type="search"
                        placeholder="Search by name or email..."
                        value={hslSearch}
                        onChange={e => { setHslSearch(e.target.value); setHslPage(1); }}
                        className="h-8 w-full pl-8 text-xs"
                      />
                      {hslSearch && (
                        <button
                          type="button"
                          onClick={() => { setHslSearch(''); setHslPage(1); }}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    {needle && (
                      <p className="mt-1.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                        {filteredHsl.length} of {visibleHslRows.length} employees
                      </p>
                    )}
                  </div>

                  {/* Table */}
                  <div className="overflow-hidden rounded-b-xl border border-zinc-200 dark:border-zinc-800">
                    {filteredHsl.length === 0 ? (
                      <p className="py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
                        No employees match &ldquo;{hslSearch}&rdquo;.
                      </p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead className="border-b border-zinc-200 bg-zinc-50/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
                          <tr>
                            <th className="px-4 py-2.5 text-left">Employee</th>
                            <th className="px-3 py-2.5 text-right">Hours</th>
                            <th className="px-3 py-2.5 text-right" title="+15 PHP/h for Saturday and Sunday hours (included in Initial Pay)">Wknd +</th>
                            <th className="px-3 py-2.5 text-right">Initial Pay</th>
                            <th className="px-3 py-2.5 text-right">KPI Bonus</th>
                            {pabColShownHsl && <th className="px-3 py-2.5 text-center">PAB</th>}
                            {techColShownHsl && <th className="px-3 py-2.5 text-center">Tech Bonus</th>}
                            <th className="px-3 py-2.5 text-right">Adjustment</th>
                            <th className="px-3 py-2.5 text-right" title="Orphanage pay — a manual amount added on top of total pay; appears as its own paystub line.">Orphanage</th>
                            <th className="px-3 py-2.5 text-right">Total Pay</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100 bg-white dark:divide-zinc-800/60 dark:bg-zinc-950/40">
                          {pagedHsl.map(r => {
                            const em = (r.email ?? '').toLowerCase();
                            const kpiBonus = hslStepBonusByEmail[em] ?? 0;
                            const override = bonusOverrides[r.email] ?? null;
                            // Adj. is a signed delta added on top of the KPI bonus, never a replacement.
                            const effectiveBonus = kpiBonus + (override ?? 0);
                            const paStatus = effectivePabStatus.get(em) ?? 'in_progress';
                            const pabExcluded = isPabExcluded(r.email);
                            const pabDeptOk = isPabDeptEligible(r.email);
                            const techDeptOk = isTechDeptEligible(r.email);
                            const pabAmt = paStatus === 'eligible' && pabDeptOk && !pabExcluded ? pabAmountPhp : 0;
                            const techOn = techBonusEligible.has(r.email) && techDeptOk;
                            const techAmt = techOn ? techAmountPhp : 0;
                            // Orphanage pay — manual positive amount added on top of total pay.
                            const hasOrphanage = orphanageAmounts[r.email] !== undefined;
                            const orphanagePay = orphanageAmounts[r.email] ?? 0;
                            const totalPay = (r.initialPay ?? 0) + effectiveBonus + pabAmt + techAmt + orphanagePay;

                            return (
                              <tr key={r.email} className="transition-colors hover:bg-violet-50/30 dark:hover:bg-violet-950/10">
                                <td className="px-4 py-3">
                                  <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.name}</div>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500">{r.email}</span>
                                  </div>
                                </td>
                                <td className="px-3 py-3 text-right font-mono text-xs text-zinc-600 tabular-nums dark:text-zinc-400">
                                  {r.totalHours != null ? r.totalHours.toFixed(2) : '—'}
                                </td>
                                {(() => {
                                  const wp = weekendPremiumByEmail.get(em);
                                  const wkndTotal = wp ? Math.round((wp.regPremiumPHP + wp.otPremiumPHP) * 100) / 100 : 0;
                                  return (
                                    <td className="px-3 py-3 text-right font-mono text-xs tabular-nums" title="+15 PHP/h for Sat/Sun hours">
                                      {wkndTotal > 0 ? (
                                        <span className="font-semibold text-amber-600 dark:text-amber-400">+{formatPHP(wkndTotal)}</span>
                                      ) : (
                                        <span className="text-zinc-300 dark:text-zinc-600">—</span>
                                      )}
                                    </td>
                                  );
                                })()}
                                <td className="px-3 py-3 text-right font-mono text-xs font-semibold tabular-nums text-zinc-800 dark:text-zinc-200">
                                  {r.initialPay != null ? formatPHP(r.initialPay) : '—'}
                                </td>
                                <td className="px-3 py-3 text-right font-mono text-xs tabular-nums">
                                  {kpiBonus > 0 ? (
                                    <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                                      +{formatPHP(kpiBonus)}
                                    </span>
                                  ) : (
                                    <span className="text-zinc-400 dark:text-zinc-600">—</span>
                                  )}
                                </td>
                                {/* PAB — tri-state pill, click opens calendar modal */}
                                {pabColShownHsl && (
                                <td className="px-3 py-3 text-center">
                                  {pabExcluded ? (
                                    <button
                                      type="button"
                                      onClick={() => setPabSettingsOpen(true)}
                                      title="Excluded from PAB this month by Accounting — earns ₱0 PAB. Click to manage exclusions."
                                      className={cn(
                                        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none transition-all duration-200',
                                        'hover:scale-105 focus:outline-none focus:ring-2 focus:ring-offset-1 dark:focus:ring-offset-zinc-900',
                                        'bg-rose-100 text-rose-700 ring-1 ring-rose-400/40 hover:bg-rose-200 focus:ring-rose-400 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-500/30 dark:hover:bg-rose-950/60',
                                      )}
                                    >
                                      <UserX className="h-3 w-3" />
                                      Excluded
                                    </button>
                                  ) : (
                                  <button
                                    type="button"
                                    onClick={() => setPabCalendarModalEmail(r.email)}
                                    title={
                                      paStatus === 'eligible' ? 'Passed all Mon–Sun weeks in the PAB period — click to see the calendar.'
                                      : paStatus === 'ineligible' ? 'Already failed at least one week — locked for this period. Click to see which day.'
                                      : 'PAB period is still running. Click to see the calendar.'
                                    }
                                    className={cn(
                                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none transition-all duration-200',
                                      'hover:scale-105 focus:outline-none focus:ring-2 focus:ring-offset-1 dark:focus:ring-offset-zinc-900',
                                      paStatus === 'eligible'
                                        ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-400/40 hover:bg-emerald-200 focus:ring-emerald-400 dark:bg-emerald-900/40 dark:text-emerald-300 dark:ring-emerald-500/30 dark:hover:bg-emerald-900/60'
                                        : paStatus === 'ineligible'
                                          ? 'bg-red-100 text-red-600 ring-1 ring-red-400/40 hover:bg-red-200 focus:ring-red-400 dark:bg-red-900/30 dark:text-red-300 dark:ring-red-500/30 dark:hover:bg-red-900/50'
                                          : 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-400/40 hover:bg-indigo-200 focus:ring-indigo-400 dark:bg-indigo-900/40 dark:text-indigo-300 dark:ring-indigo-500/30 dark:hover:bg-indigo-900/60',
                                    )}
                                  >
                                    {paStatus === 'eligible' ? (pabDeptOk ? `+${formatPHP(pabAmountPhp)}` : '✓ Eligible') : paStatus === 'ineligible' ? '✗ Ineligible' : '⏳ In Progress'}
                                  </button>
                                  )}
                                </td>
                                )}
                                {/* Tech Bonus — auto-detected; accounting can manually grant */}
                                {techColShownHsl && (
                                <td className="px-3 py-3 text-center">
                                  {techOn ? (
                                    <span
                                      title={techBonusManualGrants.has(r.email) ? 'Manually granted by Accounting this session.' : 'Auto-applied: salary date lands in the 3rd full Mon–Sun week.'}
                                      className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold leading-none text-sky-700 ring-1 ring-sky-400/40 dark:bg-sky-900/40 dark:text-sky-300 dark:ring-sky-500/30"
                                    >
                                      +{formatPHP(techAmountPhp)}
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      title="Not the Tech Bonus week or tenure/rate requirements not met — click to grant manually."
                                      onClick={() => setTechBonusManualGrants(prev => { const next = new Set(prev); next.add(r.email); return next; })}
                                      className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold leading-none text-zinc-400 ring-1 ring-zinc-300/40 transition-colors hover:bg-amber-100 hover:text-amber-700 hover:ring-amber-400/50 dark:bg-zinc-800/60 dark:text-zinc-500 dark:ring-zinc-700/40 dark:hover:bg-amber-900/30 dark:hover:text-amber-300"
                                    >
                                      Grant
                                    </button>
                                  )}
                                </td>
                                )}
                                <td className="px-3 py-3 text-right">
                                  {override !== null ? (
                                    <div className="flex items-center justify-end gap-1">
                                      <input
                                        type="number"
                                        inputMode="decimal"
                                        step="0.01"
                                        value={override}
                                        onChange={e => {
                                          const raw = e.target.value;
                                          const next = raw === '' ? 0 : Number(raw);
                                          if (!Number.isFinite(next)) return;
                                          updateBonusOverride(r.email, next);
                                        }}
                                        title={`Signed adjustment added on top of the KPI bonus (${formatPHP(kpiBonus)}). Use a negative value to deduct.`}
                                        className="h-6 w-[88px] rounded border border-amber-400/70 bg-white px-1.5 text-right font-mono text-[11px] font-bold tabular-nums text-amber-700 focus:outline-none focus:ring-1 focus:ring-amber-400 dark:border-amber-700/60 dark:bg-zinc-900 dark:text-amber-300"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => updateBonusOverride(r.email, null)}
                                        title={`Clear adjustment (KPI bonus: ${formatPHP(kpiBonus)})`}
                                        className="text-zinc-400 hover:text-red-500"
                                      >
                                        <X className="h-3 w-3" />
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      title={`KPI bonus: ${formatPHP(kpiBonus)} — click to add a signed adjustment`}
                                      onClick={() => updateBonusOverride(r.email, 0)}
                                      className="text-zinc-300 hover:text-amber-600 dark:text-zinc-700 dark:hover:text-amber-400"
                                    >
                                      —
                                    </button>
                                  )}
                                </td>
                                {/* Orphanage pay — manual positive amount added to total pay; own paystub line */}
                                <td className="px-3 py-3 text-right">
                                  {hasOrphanage ? (
                                    <div className="flex items-center justify-end gap-1">
                                      <input
                                        type="number"
                                        inputMode="decimal"
                                        step="0.01"
                                        min={0}
                                        value={orphanageAmounts[r.email] ?? ''}
                                        onChange={e => {
                                          const raw = e.target.value;
                                          const next = raw === '' ? 0 : Number(raw);
                                          if (!Number.isFinite(next) || next < 0) return;
                                          updateOrphanageAmount(r.email, next);
                                        }}
                                        title="Orphanage pay (PHP) added on top of total pay"
                                        className="h-6 w-[88px] rounded border border-pink-400/70 bg-white px-1.5 text-right font-mono text-[11px] font-bold tabular-nums text-pink-700 focus:outline-none focus:ring-1 focus:ring-pink-400 dark:border-pink-700/60 dark:bg-zinc-900 dark:text-pink-300"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => updateOrphanageAmount(r.email, null)}
                                        title="Clear orphanage pay"
                                        className="text-zinc-400 hover:text-red-500"
                                      >
                                        <X className="h-3 w-3" />
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      title="Click to add orphanage pay"
                                      onClick={() => updateOrphanageAmount(r.email, 0)}
                                      className="text-zinc-300 hover:text-pink-600 dark:text-zinc-700 dark:hover:text-pink-400"
                                    >
                                      —
                                    </button>
                                  )}
                                </td>
                                <td className="px-3 py-3 text-right">
                                  <PhpWithUsd
                                    php={totalPay}
                                    usdToPhp={usdToPhpRate}
                                    phpClassName="font-mono text-sm font-bold tabular-nums text-zinc-900 dark:text-zinc-100"
                                  />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot className="border-t-2 border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40">
                          {(() => {
                            let totalInitialPay = 0, totalPab = 0, totalTech = 0, totalKpi = 0, totalAdj = 0, totalOrphanage = 0, totalWkndPremium = 0;
                            for (const r of visibleHslRows) {
                              const em = (r.email ?? '').toLowerCase();
                              totalInitialPay += r.initialPay ?? 0;
                              totalKpi += hslStepBonusByEmail[em] ?? 0;
                              totalAdj += bonusOverrides[r.email] ?? 0;
                              totalOrphanage += orphanageAmounts[r.email] ?? 0;
                              const st = effectivePabStatus.get(em) ?? 'in_progress';
                              if (st === 'eligible' && isPabDeptEligible(r.email) && !isPabExcluded(r.email)) totalPab += pabAmountPhp;
                              if (techBonusEligible.has(r.email) && isTechDeptEligible(r.email)) totalTech += techAmountPhp;
                              const wp = weekendPremiumByEmail.get(em);
                              if (wp) totalWkndPremium += wp.regPremiumPHP + wp.otPremiumPHP;
                            }
                            return (
                              <tr>
                                <td colSpan={2} className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                                  Totals ({visibleHslRows.length} employees)
                                </td>
                                <td className="px-3 py-2.5 text-right font-mono text-sm font-bold tabular-nums text-amber-600 dark:text-amber-400">
                                  {totalWkndPremium > 0 ? `+${formatPHP(Math.round(totalWkndPremium * 100) / 100)}` : <span className="text-zinc-400 dark:text-zinc-600">—</span>}
                                </td>
                                <td className="px-3 py-2.5 text-right font-mono text-sm font-bold tabular-nums text-zinc-700 dark:text-zinc-300">
                                  {formatPHP(totalInitialPay)}
                                </td>
                                <td className="px-3 py-2.5 text-right font-mono text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                                  {totalKpi > 0 ? `+${formatPHP(totalKpi)}` : <span className="text-zinc-400 dark:text-zinc-600">—</span>}
                                </td>
                                {pabColShownHsl && (
                                <td className="px-3 py-2.5 text-center font-mono text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                                  {totalPab > 0 ? `+${formatPHP(totalPab)}` : <span className="text-zinc-400 dark:text-zinc-600">—</span>}
                                </td>
                                )}
                                {techColShownHsl && (
                                <td className="px-3 py-2.5 text-center font-mono text-sm font-bold tabular-nums text-sky-700 dark:text-sky-400">
                                  {totalTech > 0 ? `+${formatPHP(totalTech)}` : <span className="text-zinc-400 dark:text-zinc-600">—</span>}
                                </td>
                                )}
                                <td className="px-3 py-2.5 text-right font-mono text-sm font-bold tabular-nums text-amber-600 dark:text-amber-400">
                                  {totalAdj !== 0 ? `${totalAdj > 0 ? '+' : ''}${formatPHP(totalAdj)}` : <span className="text-zinc-400 dark:text-zinc-600">—</span>}
                                </td>
                                <td className="px-3 py-2.5 text-right font-mono text-sm font-bold tabular-nums text-pink-600 dark:text-pink-400">
                                  {totalOrphanage > 0 ? `+${formatPHP(totalOrphanage)}` : <span className="text-zinc-400 dark:text-zinc-600">—</span>}
                                </td>
                                <td className="px-3 py-2.5 text-right">
                                  <PhpWithUsd
                                    php={totalInitialPay + totalKpi + totalAdj + totalOrphanage + totalPab + totalTech}
                                    usdToPhp={usdToPhpRate}
                                    phpClassName="font-mono text-sm font-bold tabular-nums text-zinc-900 dark:text-zinc-100"
                                  />
                                </td>
                              </tr>
                            );
                          })()}
                        </tfoot>
                      </table>
                    )}
                  </div>

                  {/* Pagination */}
                  {totalHslPages > 1 && (
                    <div className="flex items-center justify-between border border-t-0 border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/60">
                      <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                        Page {safePage} of {totalHslPages} &middot; {filteredHsl.length} employee{filteredHsl.length !== 1 ? 's' : ''}
                      </span>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs disabled:opacity-40"
                          disabled={safePage <= 1}
                          onClick={() => setHslPage(1)}
                        >
                          <ChevronLeft className="h-3 w-3" /><ChevronLeft className="h-3 w-3 -ml-1.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs disabled:opacity-40"
                          disabled={safePage <= 1}
                          onClick={() => setHslPage(p => Math.max(1, p - 1))}
                        >
                          <ChevronLeft className="h-3 w-3" />
                        </Button>
                        {Array.from({ length: totalHslPages }, (_, i) => i + 1)
                          .filter(p => Math.abs(p - safePage) <= 2 || p === 1 || p === totalHslPages)
                          .reduce<(number | 'gap')[]>((acc, p, i, arr) => {
                            if (i > 0 && p - (arr[i - 1] as number) > 1) acc.push('gap');
                            acc.push(p);
                            return acc;
                          }, [])
                          .map((p, i) =>
                            p === 'gap' ? (
                              <span key={`gap-${i}`} className="px-1 text-xs text-zinc-400">…</span>
                            ) : (
                              <Button
                                key={p}
                                type="button"
                                variant={p === safePage ? 'default' : 'outline'}
                                size="sm"
                                className={cn('h-7 min-w-[28px] px-2 text-xs', p === safePage && 'bg-violet-600 hover:bg-violet-700 border-violet-600')}
                                onClick={() => setHslPage(p as number)}
                              >
                                {p}
                              </Button>
                            ),
                          )}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs disabled:opacity-40"
                          disabled={safePage >= totalHslPages}
                          onClick={() => setHslPage(p => Math.min(totalHslPages, p + 1))}
                        >
                          <ChevronRight className="h-3 w-3" />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs disabled:opacity-40"
                          disabled={safePage >= totalHslPages}
                          onClick={() => setHslPage(totalHslPages)}
                        >
                          <ChevronRight className="h-3 w-3" /><ChevronRight className="h-3 w-3 -ml-1.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
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

        const pendingInvoices  = contractorInvoicesInPeriod.filter((i) => i.status === 'pending');
        const approvedInvoices = contractorInvoicesInPeriod.filter((i) => i.status === 'approved');
        const rejectedInvoices = contractorInvoicesInPeriod.filter((i) => i.status === 'rejected');
        const approvedByCurrency = sumByCurrency(approvedInvoices);

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
                  {approvedInvoices.length} approved · {CONTRACTOR_CURRENCIES.filter((c) => approvedByCurrency[c] !== 0).map((c) => formatMoney(approvedByCurrency[c], c)).join(' + ') || formatMoney(0, 'PHP')}
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
            ) : contractorInvoicesInPeriod.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center text-zinc-500 dark:text-zinc-400">
                <HardHat className="h-10 w-10 opacity-25" />
                <p className="text-sm">
                  {contractorInvoices.length === 0
                    ? 'No contractor invoices have been submitted yet.'
                    : 'No contractor invoices fall within this pay period.'}
                </p>
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
                    {contractorInvoicesInPeriod.map((inv) => (
                      <tr key={inv.id} className="transition-colors hover:bg-emerald-50/40 dark:hover:bg-emerald-950/15">
                        <td className="px-4 py-3">
                          <div className="font-medium text-zinc-900 dark:text-white">{inv.from_entity_name || inv.from_name || '—'}</div>
                          <div className="font-mono text-[11px] text-zinc-500">{inv.contractor_email}</div>
                        </td>
                        <td className="px-3 py-3 font-mono text-xs text-zinc-700 dark:text-zinc-300">{inv.invoice_number}</td>
                        <td className="px-3 py-3 text-xs text-zinc-600 dark:text-zinc-400">{inv.invoice_date || '—'}</td>
                        <td className="px-3 py-3 text-right font-medium text-zinc-900 dark:text-white">
                          <span>{formatMoney(inv.total ?? 0, normalizeCurrency(inv.currency))}</span>
                          <span className="ml-1.5 rounded border border-zinc-300 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">{normalizeCurrency(inv.currency)}</span>
                        </td>
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
                            {inv.status === 'pending' && (
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
                            {inv.status === 'pending' && (
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
                      {CONTRACTOR_CURRENCIES.filter((c) => approvedByCurrency[c] !== 0).map((c) => (
                        <tr key={c}>
                          <td colSpan={3} className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                            Approved total ({c})
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                            {formatMoney(approvedByCurrency[c], c)}
                          </td>
                          <td colSpan={2} />
                        </tr>
                      ))}
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
          const orphanagePay = orphanageAmounts[r.email] ?? 0;
          return {
            ...r,
            deptKey: employeeDepts[r.email] ?? null,
            deptName: DEPARTMENTS.find(d => d.key === employeeDepts[r.email])?.name ?? '—',
            bonusTotal: getEffectiveBonus(r.email),
            mesaDeduction: mesaDed,
            orphanagePay,
            excluded: excludedEmails.has(normEmail(r.email) ?? ''),
            finalPay: (r.initialPay ?? 0) + getEffectiveBonus(r.email) - mesaDed + orphanagePay,
          };
          })
          .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        // Grand totals + outflow count only PAYABLE rows — anyone accounting
        // flagged "do not pay" is staged to Payment Dispatch → Excluded instead.
        const payableFinalRows = finalPayRows.filter(r => !r.excluded);
        const excludedCount = finalPayRows.length - payableFinalRows.length;
        const grandInitial = payableFinalRows.reduce((s, r) => s + (r.initialPay ?? 0), 0);
        const grandBonuses = payableFinalRows.reduce((s, r) => s + r.bonusTotal, 0);
        const grandMesaDeductions = payableFinalRows.reduce((s, r) => s + (r.mesaDeduction ?? 0), 0);
        const grandFinal   = payableFinalRows.reduce((s, r) => s + r.finalPay, 0);
        const unassignedCount = payableFinalRows.filter(r => !r.deptKey).length;

        // Contractor invoices are kept in their own currency — USD invoices are
        // NOT converted into the peso outflow. Only PHP invoices feed the peso
        // total; USD is surfaced separately.
        const approvedContractorsByCurrency = sumByCurrency(
          contractorInvoicesInPeriod.filter((i) => i.status === 'approved'),
        );
        const stepContractorsPHP = approvedContractorsByCurrency.PHP;
        const stepContractorsUSD = approvedContractorsByCurrency.USD;
        const totalWeeklyOutflow = grandFinal + stepContractorsPHP;

        return (
          <div className="flex min-w-0 flex-col gap-5">
            {/* Header */}
            <div className="rounded-xl border border-zinc-200/90 bg-gradient-to-br from-white via-zinc-50/80 to-emerald-50/25 p-4 shadow-sm sm:p-5 dark:border-zinc-800 dark:from-zinc-950/50 dark:via-zinc-900/40 dark:to-emerald-950/15">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-white">Pre-Flight Validation</h3>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">Final review before dispatching payments</p>
                {calcSourceFile && (
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-indigo-600 dark:text-indigo-400">
                    <FileText className="h-3 w-3 shrink-0" />
                    <span className="truncate font-mono">{calcSourceFile}</span>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {unassignedCount > 0 && (
                  <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                    {unassignedCount} unassigned
                  </Badge>
                )}
                {excludedCount > 0 && (
                  <Badge className="border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400">
                    {excludedCount} excluded from pay
                  </Badge>
                )}
                <Badge className="border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                  {payableFinalRows.length} ready for dispatch
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
                    {payableFinalRows.length} payable employee{payableFinalRows.length !== 1 ? 's' : ''}
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
                    {payableFinalRows.filter(r => r.bonusTotal > 0).length} payable employees with bonuses
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
                    {stepContractorsPHP > 0 && (
                      <div className="flex items-center justify-between gap-2">
                        <span>Contractor invoices (PHP)</span>
                        <span className="font-mono tabular-nums">{formatMoney(stepContractorsPHP, 'PHP')}</span>
                      </div>
                    )}
                    {stepContractorsUSD > 0 && (
                      <div className="flex items-center justify-between gap-2">
                        <span>Contractor invoices (USD, paid separately)</span>
                        <span className="font-mono tabular-nums">{formatMoney(stepContractorsUSD, 'USD')}</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* US Holidays in this pay-period week — shown only when a holiday falls inside the dispatched week */}
            {usHolidayForgivenSummary.length > 0 && (() => {
              const enabledHolidays = usHolidayForgivenSummary.filter((h) => h.isForgivenEnabled);
              const totalForgiven = enabledHolidays.reduce((s, h) => s + h.forgivenEmails.length, 0);
              const totalWorkedThrough = enabledHolidays.reduce((s, h) => s + h.workedThroughEmails.length, 0);
              const totalEmps = totalForgiven + totalWorkedThrough;
              const overallPct = totalEmps > 0 ? Math.round((totalForgiven / totalEmps) * 100) : 0;
              const holidayWord = `holiday${usHolidayForgivenSummary.length !== 1 ? 's' : ''}`;
              const disabledCount = usHolidayForgivenSummary.length - enabledHolidays.length;
              return (
                <Card className="relative overflow-hidden border-sky-200/70 bg-gradient-to-br from-sky-50/80 via-white to-indigo-50/30 shadow-sm ring-0 dark:border-sky-900/40 dark:from-sky-950/25 dark:via-zinc-950 dark:to-indigo-950/15">
                  {/* Soft top-right glow */}
                  <div className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-sky-400/10 blur-3xl dark:bg-sky-500/10" />
                  <CardHeader className="relative pb-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-500 text-white shadow-md shadow-sky-500/25 dark:shadow-sky-500/15">
                          <Flag className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
                            US Holidays in this Pay Period
                          </CardTitle>
                          <CardDescription className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            {`${usHolidayForgivenSummary.length} ${holidayWord}`}
                            {enabledHolidays.length > 0 && ` · ${enabledHolidays.length} with auto-forgiveness on`}
                            {disabledCount > 0 && ` · ${disabledCount} need manual review`}
                          </CardDescription>
                        </div>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-1.5">
                        {totalForgiven > 0 ? (
                          <Badge className="border-sky-300/60 bg-sky-100 font-medium text-sky-700 dark:border-sky-700/50 dark:bg-sky-950/50 dark:text-sky-200">
                            <Users className="mr-1 h-3 w-3" />
                            {totalForgiven} forgiven
                          </Badge>
                        ) : (
                          <Badge className="border-emerald-300/50 bg-emerald-100 font-medium text-emerald-700 dark:border-emerald-700/40 dark:bg-emerald-950/40 dark:text-emerald-300">
                            <Check className="mr-1 h-3 w-3" />
                            All clear
                          </Badge>
                        )}
                      </div>
                    </div>

                    {/* Mini-stats — stacked label-value rows on mobile, 3-card grid on sm+ */}
                    {totalEmps > 0 && (
                      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <div className="flex items-center justify-between gap-2 rounded-lg border border-sky-200/70 bg-white/70 px-2.5 py-1.5 backdrop-blur-sm sm:block dark:border-sky-900/40 dark:bg-zinc-900/40">
                          <div className="text-[9px] font-semibold uppercase tracking-wide text-sky-700/70 dark:text-sky-400/70">Forgiven</div>
                          <div className="font-mono text-base font-bold leading-none text-sky-700 sm:mt-0.5 dark:text-sky-300">{totalForgiven}</div>
                        </div>
                        <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-200/70 bg-white/70 px-2.5 py-1.5 backdrop-blur-sm sm:block dark:border-emerald-900/40 dark:bg-zinc-900/40">
                          <div className="text-[9px] font-semibold uppercase tracking-wide text-emerald-700/70 dark:text-emerald-400/70">Worked through</div>
                          <div className="font-mono text-base font-bold leading-none text-emerald-700 sm:mt-0.5 dark:text-emerald-300">{totalWorkedThrough}</div>
                        </div>
                        <div className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200/70 bg-white/70 px-2.5 py-1.5 backdrop-blur-sm sm:block dark:border-zinc-700/60 dark:bg-zinc-900/40">
                          <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Forgive rate</div>
                          <div className="font-mono text-base font-bold leading-none text-zinc-700 sm:mt-0.5 dark:text-zinc-200">{overallPct}%</div>
                        </div>
                      </div>
                    )}
                  </CardHeader>

                  <CardContent className="relative pt-1 pb-4">
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                      {usHolidayForgivenSummary.map((h, idx) => {
                        const dayLabel = h.date.toLocaleDateString('en-US', { weekday: 'short' });
                        const monthLabel = h.date.toLocaleDateString('en-US', { month: 'short' });
                        const dayNum = h.date.getDate();
                        const disabled = !h.isForgivenEnabled;
                        const allClear = h.forgivenEmails.length === 0;

                        return (
                          <motion.div
                            key={h.iso}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.05 + idx * 0.04, duration: 0.25, ease: 'easeOut' }}
                            className={cn(
                              'group flex flex-col rounded-xl border bg-white/85 p-3 backdrop-blur-sm transition-all duration-200',
                              'hover:shadow-md hover:-translate-y-0.5',
                              disabled
                                ? 'border-amber-200/70 hover:border-amber-300 dark:border-amber-900/40 dark:bg-amber-950/15 dark:hover:border-amber-800/60'
                                : allClear
                                  ? 'border-emerald-200/70 hover:border-emerald-300 dark:border-emerald-900/40 dark:bg-emerald-950/15 dark:hover:border-emerald-800/60'
                                  : 'border-sky-200/70 hover:border-sky-300 dark:border-sky-900/40 dark:bg-sky-950/15 dark:hover:border-sky-800/60',
                            )}
                          >
                            {/* Header row */}
                            <div className="flex items-start gap-3">
                              {/* Date block — calendar-tear style */}
                              <div className={cn(
                                'flex h-14 w-12 flex-shrink-0 flex-col items-center justify-center overflow-hidden rounded-lg border shadow-sm',
                                disabled
                                  ? 'border-amber-200 bg-gradient-to-b from-amber-50 to-white dark:border-amber-800/40 dark:from-amber-950/30 dark:to-zinc-900/40'
                                  : allClear
                                    ? 'border-emerald-200 bg-gradient-to-b from-emerald-50 to-white dark:border-emerald-800/40 dark:from-emerald-950/30 dark:to-zinc-900/40'
                                    : 'border-sky-200 bg-gradient-to-b from-sky-50 to-white dark:border-sky-800/40 dark:from-sky-950/30 dark:to-zinc-900/40',
                              )}>
                                <div className={cn(
                                  'w-full py-0.5 text-center text-[8px] font-bold uppercase tracking-wider text-white',
                                  disabled ? 'bg-amber-500 dark:bg-amber-600/80' : allClear ? 'bg-emerald-500 dark:bg-emerald-600/80' : 'bg-sky-500 dark:bg-sky-600/80',
                                )}>
                                  {monthLabel}
                                </div>
                                <div className="font-mono text-lg font-extrabold leading-none text-zinc-800 dark:text-zinc-100">
                                  {dayNum}
                                </div>
                                <div className="text-[8px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                                  {dayLabel}
                                </div>
                              </div>

                              {/* Name + status */}
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100">{h.name}</p>
                                <p className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                                  {h.date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                                </p>
                                <div className={cn(
                                  'mt-1.5 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold',
                                  disabled
                                    ? 'border-amber-300/50 bg-amber-100/80 text-amber-700 dark:border-amber-700/40 dark:bg-amber-950/40 dark:text-amber-300'
                                    : allClear
                                      ? 'border-emerald-300/50 bg-emerald-100/80 text-emerald-700 dark:border-emerald-700/40 dark:bg-emerald-950/40 dark:text-emerald-300'
                                      : 'border-sky-300/50 bg-sky-100/80 text-sky-700 dark:border-sky-700/40 dark:bg-sky-950/40 dark:text-sky-300',
                                )}>
                                  {disabled ? (
                                    <><AlertTriangle className="h-2.5 w-2.5" /> Forgiveness off — review manually</>
                                  ) : allClear ? (
                                    <><Check className="h-2.5 w-2.5" /> All worked 7h+</>
                                  ) : (
                                    <><Users className="h-2.5 w-2.5" /> {h.forgivenEmails.length} forgiven</>
                                  )}
                                </div>
                              </div>
                            </div>
                          </motion.div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              );
            })()}

            {/* Final Pay Table — separated per department (mirrors the Additions
                step's department rail). Each department has its own table plus a
                master "exclude all" tickbox in the Exclude header. */}
            {(() => {
              const vNeedle = validationSearch.toLowerCase().trim();
              const UNASSIGNED = '__unassigned__';

              // Bucket every final-pay row by department (DEPARTMENTS order; an
              // "Unassigned" bucket collects anyone without a department).
              const groupMap = new Map<string, typeof finalPayRows>();
              for (const row of finalPayRows) {
                const k = row.deptKey ?? UNASSIGNED;
                const arr = groupMap.get(k);
                if (arr) arr.push(row);
                else groupMap.set(k, [row]);
              }
              const deptGroups: { key: string; name: string; rows: typeof finalPayRows }[] = [
                ...DEPARTMENTS.filter(d => groupMap.has(d.key)).map(d => ({
                  key: d.key,
                  name: d.name,
                  rows: groupMap.get(d.key)!,
                })),
                ...(groupMap.has(UNASSIGNED)
                  ? [{ key: UNASSIGNED, name: 'Unassigned', rows: groupMap.get(UNASSIGNED)! }]
                  : []),
              ];

              if (deptGroups.length === 0) {
                return (
                  <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white/50 py-10 text-center text-sm text-zinc-400 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/25">
                    No Hubstaff data. Complete Steps 1–3 first.
                  </div>
                );
              }

              const activeKey = deptGroups.some(g => g.key === validationDeptTab)
                ? (validationDeptTab as string)
                : deptGroups[0].key;
              const activeGroup = deptGroups.find(g => g.key === activeKey)!;

              const filteredRows = vNeedle
                ? activeGroup.rows.filter(row => [row.name, row.email].join(' ').toLowerCase().includes(vNeedle))
                : activeGroup.rows;

              // Master "exclude all" state for the active department (operates on
              // the whole department, not just the search-filtered subset).
              const deptEmails = activeGroup.rows.map(r => r.email);
              const deptExcludedCount = activeGroup.rows.filter(r => r.excluded).length;
              const allDeptExcluded = activeGroup.rows.length > 0 && deptExcludedCount === activeGroup.rows.length;
              const someDeptExcluded = deptExcludedCount > 0 && !allDeptExcluded;

              // Per-department payable subtotal for the table footer.
              const deptPayable = activeGroup.rows.filter(r => !r.excluded);
              const deptInitial = deptPayable.reduce((s, r) => s + (r.initialPay ?? 0), 0);
              const deptBonuses = deptPayable.reduce((s, r) => s + r.bonusTotal, 0);
              const deptFinal = deptPayable.reduce((s, r) => s + r.finalPay, 0);

              return (
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
                  {/* Department rail */}
                  <div className="flex gap-1.5 overflow-x-auto pb-1 xl:w-48 xl:shrink-0 xl:flex-col xl:gap-1 xl:overflow-visible xl:pb-0 [-ms-overflow-style:none] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-300/80 dark:[&::-webkit-scrollbar-thumb]:bg-zinc-600">
                    <p className="hidden px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 xl:block dark:text-zinc-500">
                      Departments
                    </p>
                    {deptGroups.map(g => {
                      const isActive = g.key === activeKey;
                      const exCount = g.rows.filter(r => r.excluded).length;
                      return (
                        <motion.button
                          key={g.key}
                          type="button"
                          onClick={() => { setValidationDeptTab(g.key); setValidationSearch(''); }}
                          whileTap={{ scale: 0.97 }}
                          className={cn(
                            'relative flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium xl:w-full xl:justify-between',
                            isActive
                              ? 'border-indigo-500/50 text-indigo-700 dark:text-indigo-300'
                              : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/50',
                          )}
                        >
                          {isActive && (
                            <motion.span
                              layoutId="validation-dept-active-bg"
                              className="absolute inset-0 rounded-[7px] bg-indigo-600/10 dark:bg-indigo-500/15"
                              transition={{ type: 'spring', stiffness: 400, damping: 34 }}
                            />
                          )}
                          <span className="relative truncate">{g.name}</span>
                          <span className="relative flex shrink-0 items-center gap-1">
                            {exCount > 0 && (
                              <span
                                className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white"
                                title={`${exCount} excluded from pay`}
                              >
                                {exCount}
                              </span>
                            )}
                            <span
                              className={cn(
                                'rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none',
                                isActive
                                  ? 'bg-indigo-600 text-white'
                                  : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400',
                              )}
                            >
                              {g.rows.length}
                            </span>
                          </span>
                        </motion.button>
                      );
                    })}
                  </div>

                  {/* Active department's final-pay table */}
                  <div className="min-w-0 flex-1 space-y-3">
                    <div className="relative">
                      <svg
                        className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
                        fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
                      >
                        <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                      </svg>
                      <Input
                        placeholder={`Search ${activeGroup.name} by name or email…`}
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
                          {activeGroup.name} — Final Pay
                          {vNeedle && <span className="ml-1 font-normal text-zinc-400">— {filteredRows.length} of {activeGroup.rows.length}</span>}
                        </span>
                        <span className="max-w-full truncate text-[10px] text-zinc-400">
                          {activeGroup.rows.length} employee{activeGroup.rows.length !== 1 ? 's' : ''}
                          {deptExcludedCount > 0 && <> · <span className="font-semibold text-rose-600 dark:text-rose-400">{deptExcludedCount} excluded</span></>}
                        </span>
                      </div>

                      <div
                        className="overflow-auto [-ms-overflow-style:none] [scrollbar-gutter:stable]"
                        style={{ maxHeight: 'min(62vh, calc(100dvh - 26rem))' }}
                      >
                        <Table>
                          <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-20 [&_th]:bg-zinc-100/95 [&_th]:shadow-[0_1px_0_0_rgb(228_228_231)] dark:[&_th]:bg-zinc-900/95 dark:[&_th]:shadow-[0_1px_0_0_rgb(39_39_42)]">
                            <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                              <TableHead className="min-w-[160px] px-3 text-xs font-medium text-zinc-600 dark:text-zinc-400">Employee</TableHead>
                              <TableHead className="min-w-[70px] px-2 text-right text-xs font-medium text-zinc-600 dark:text-zinc-400">Hrs</TableHead>
                              <TableHead className="min-w-[110px] px-2 text-right text-xs font-medium text-zinc-600 dark:text-zinc-400">Initial Pay</TableHead>
                              <TableHead className="min-w-[110px] px-2 text-right text-xs font-medium text-emerald-600 dark:text-emerald-400">Bonuses</TableHead>
                              <TableHead className="min-w-[120px] px-2 text-right text-xs font-semibold text-indigo-600 dark:text-indigo-400">Final Pay</TableHead>
                              <TableHead className="min-w-[96px] px-2 text-center text-xs font-medium text-zinc-600 dark:text-zinc-400">
                                <div className="flex items-center justify-center gap-1.5">
                                  <input
                                    type="checkbox"
                                    checked={allDeptExcluded}
                                    ref={(el) => { if (el) el.indeterminate = someDeptExcluded; }}
                                    onChange={() => setExcludedMany(deptEmails, !allDeptExcluded)}
                                    disabled={isReplay || activeGroup.rows.length === 0}
                                    aria-label={`Exclude all employees in ${activeGroup.name} from pay`}
                                    title={allDeptExcluded
                                      ? `Include all ${activeGroup.name} in pay`
                                      : `Exclude all ${activeGroup.name} from pay (do not pay this cycle)`}
                                    className="h-4 w-4 cursor-pointer rounded border-zinc-300 accent-rose-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600"
                                  />
                                  <span>Exclude</span>
                                </div>
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {filteredRows.length === 0 ? (
                              <TableRow>
                                <TableCell colSpan={6} className="py-10 text-center text-sm text-zinc-400">
                                  {vNeedle ? <>No employees match &quot;{vNeedle}&quot;</> : 'No employees in this department.'}
                                </TableCell>
                              </TableRow>
                            ) : (
                              filteredRows.map((row, i) => (
                                <TableRow
                                  key={`${row.email}-${i}`}
                                  className={cn(
                                    'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/30',
                                    row.excluded && 'bg-rose-50/40 dark:bg-rose-950/15',
                                  )}
                                >
                                  <TableCell className={cn('px-3 py-2.5', row.excluded && 'opacity-55')}>
                                    <div className="flex items-center gap-1.5">
                                      <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">
                                        {row.name || '—'}
                                      </div>
                                      {row.excluded && (
                                        <Badge className="shrink-0 border-rose-500/30 bg-rose-500/10 text-[9px] uppercase tracking-wide text-rose-600 dark:text-rose-400">
                                          Do not pay
                                        </Badge>
                                      )}
                                    </div>
                                    <div className="font-mono text-[10px] text-zinc-400 truncate">{row.email}</div>
                                  </TableCell>
                                  <TableCell className={cn('px-2 py-2.5 text-right font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-400', row.excluded && 'opacity-55')}>
                                    {row.totalHours.toFixed(1)}
                                  </TableCell>
                                  <TableCell className={cn('px-2 py-2.5 text-right font-mono text-xs tabular-nums text-zinc-700 dark:text-zinc-300', row.excluded && 'opacity-55')}>
                                    {row.initialPay != null ? formatPHP(row.initialPay) : '—'}
                                  </TableCell>
                                  <TableCell className={cn('px-2 py-2.5 text-right font-mono text-xs tabular-nums font-semibold', row.excluded && 'opacity-55')}>
                                    {row.bonusTotal > 0 ? (
                                      <span className="text-emerald-600 dark:text-emerald-400">+{formatPHP(row.bonusTotal)}</span>
                                    ) : (
                                      <span className="text-zinc-400">—</span>
                                    )}
                                  </TableCell>
                                  <TableCell className={cn('px-2 py-2.5 text-right font-mono text-xs tabular-nums font-bold', row.excluded ? 'text-zinc-400 line-through dark:text-zinc-600' : 'text-indigo-700 dark:text-indigo-300')}>
                                    {formatPHP(row.finalPay)}
                                  </TableCell>
                                  <TableCell className="px-2 py-2.5 text-center">
                                    <input
                                      type="checkbox"
                                      checked={row.excluded}
                                      onChange={() => toggleExcluded(row.email)}
                                      disabled={isReplay}
                                      aria-label={`Exclude ${row.name || row.email} from pay`}
                                      title={row.excluded ? 'Excluded from pay — untick to pay' : 'Tick to exclude from pay (do not pay this cycle)'}
                                      className="h-4 w-4 cursor-pointer rounded border-zinc-300 accent-rose-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600"
                                    />
                                  </TableCell>
                                </TableRow>
                              ))
                            )}
                          </TableBody>
                          {/* Department subtotal footer (payable rows only) */}
                          {activeGroup.rows.length > 0 && (
                            <tfoot>
                              <tr className="border-t-2 border-zinc-300 bg-zinc-100/80 dark:border-zinc-700 dark:bg-zinc-900/60">
                                <td colSpan={2} className="px-3 py-2.5 text-xs font-bold text-zinc-700 dark:text-zinc-300">
                                  {activeGroup.name} Subtotal ({deptPayable.length} payable{deptExcludedCount > 0 ? ` · ${deptExcludedCount} excluded` : ''})
                                </td>
                                <td className="px-2 py-2.5 text-right font-mono text-xs font-bold tabular-nums text-zinc-800 dark:text-zinc-200">
                                  {formatPHP(deptInitial)}
                                </td>
                                <td className="px-2 py-2.5 text-right font-mono text-xs font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                                  +{formatPHP(deptBonuses)}
                                </td>
                                <td className="px-2 py-2.5 text-right font-mono text-xs font-bold tabular-nums text-indigo-700 dark:text-indigo-300">
                                  {formatPHP(deptFinal)}
                                </td>
                                <td className="px-2 py-2.5" />
                              </tr>
                            </tfoot>
                          )}
                        </Table>
                      </div>
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
                    label: `Contractor Invoices Reviewed (${contractorInvoicesInPeriod.filter(i => i.status === 'pending').length} pending)`,
                    pass: contractorInvoicesInPeriod.filter(i => i.status === 'pending').length === 0,
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
              <h3 className="text-2xl font-bold text-zinc-900 dark:text-white">Lock in Values &amp; Send to Payment Dispatch</h3>
              <p className="max-w-md text-zinc-600 dark:text-zinc-400">
                Locks this cycle&apos;s pay and stages each paystub to Payment Dispatch.{' '}
                <span className="font-semibold text-zinc-800 dark:text-zinc-200">{dispatchData.rows.length}</span> payable
                {dispatchData.excludedRows.length > 0 && (
                  <> · <span className="font-semibold text-rose-600 dark:text-rose-400">{dispatchData.excludedRows.length}</span> excluded (do not pay)</>
                )}.
                The Dispatch office emails each paystub as it marks the person Paid.
              </p>
            </div>
            <a
              href="https://simpledotbiz.app.n8n.cloud/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-[#ea4b71]/30 bg-[#ea4b71]/10 px-3.5 py-1.5 text-xs font-medium text-[#ea4b71] transition hover:bg-[#ea4b71]/15 hover:shadow-[0_0_12px_rgba(234,75,113,0.25)]"
              title="Paystub emails fire one-by-one as the Dispatch office marks each person Paid in Payment Dispatch"
            >
              <img
                src="https://n8n.io/favicon.ico"
                alt="n8n"
                className="h-4 w-4"
              />
              <span>Paystubs send 1-by-1 from Payment Dispatch</span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[#ea4b71]/80">· n8n on Mark Paid</span>
            </a>

            {/* Realtime lock state for this cycle. Locked → Payment Dispatch is
                live; Unlock pulls the values back (dispatch empties in realtime). */}
            {!dispatchValuesLock.loading && (
              dispatchValuesLock.state.locked ? (
                <div className="flex w-full max-w-md flex-col items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 dark:border-emerald-900/40 dark:bg-emerald-950/20">
                  <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                    <Lock className="h-4 w-4" />
                    Locked — Payment Dispatch is live for this cycle
                  </div>
                  <p className="text-center text-xs text-emerald-700/80 dark:text-emerald-300/70">
                    The Dispatch office can pay + email paystubs now. Unlock to pull the values back —
                    Payment Dispatch clears in real time.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={togglingValuesLock || isReplay}
                    onClick={async () => {
                      setTogglingValuesLock(true);
                      try {
                        await dispatchValuesLock.setLocked(false, sessionEmail ?? null);
                        toast.success('Unlocked — Payment Dispatch cleared', {
                          description: 'The queue is empty until you lock this cycle again.',
                        });
                      } catch (e) {
                        toast.error('Could not unlock', {
                          description: e instanceof Error ? e.message : undefined,
                        });
                      } finally {
                        setTogglingValuesLock(false);
                      }
                    }}
                    className="gap-1.5 border-emerald-300 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-700/50 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
                  >
                    {togglingValuesLock ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <LockOpen className="h-3.5 w-3.5" />
                    )}
                    Unlock Payment Dispatch
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-xl border border-amber-200/80 bg-amber-50/70 px-3.5 py-2 text-xs font-medium text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
                  <LockOpen className="h-3.5 w-3.5" />
                  Unlocked — Payment Dispatch stays empty until you lock this cycle.
                </div>
              )
            )}

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
                  setPreviewTab('paystubs');
                  setPreviewPaystubsOpen(true);
                }}
              >
                Preview Emails
              </Button>
              <Button
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-12 font-bold"
                onClick={async () => {
                  if (isReplay) {
                    toast.error('Replaying a past period is view-only', { description: 'Return to the current period to dispatch.' });
                    return;
                  }
                  if (!calcSourceFile) {
                    toast.error('No pay-period file selected');
                    return;
                  }
                  const { rows: employees, excludedRows, missing, payPeriodPayload } = dispatchData;
                  if (employees.length === 0 && excludedRows.length === 0) {
                    toast.error('Nothing to send', {
                      description: 'No employees resolved for this cycle.',
                    });
                    return;
                  }
                  if (missing.length > 0) {
                    toast.warning(
                      `${missing.length} payable employee${missing.length === 1 ? '' : 's'} without a personal email — no paystub will be emailed`,
                      {
                        description:
                          missing.slice(0, 5).join(', ') + (missing.length > 5 ? '…' : ''),
                      },
                    );
                  }
                  // Stage each employee's AUTHORITATIVE paystub payload (payable +
                  // excluded). No batch emails — Payment Dispatch fires each one as
                  // the Dispatch office marks the person Paid.
                  const entries = [
                    ...employees.map((e) => ({
                      recipient_email: e.email,
                      personal_email: e.personal_email,
                      recipient_name: e.name,
                      department_key: e.department_key,
                      amount_php: e.pay_php.final,
                      amount_usd: usdToPhpRate > 0 ? Math.round((e.pay_php.final / usdToPhpRate) * 100) / 100 : null,
                      payload: e,
                      excluded: false,
                    })),
                    ...excludedRows.map((x) => ({
                      recipient_email: x.email,
                      personal_email: x.personal_email,
                      recipient_name: x.name,
                      department_key: x.department_key,
                      amount_php: x.amount_php,
                      amount_usd: x.amount_php != null && usdToPhpRate > 0 ? Math.round((x.amount_php / usdToPhpRate) * 100) / 100 : null,
                      payload: x.payload,
                      excluded: true,
                      exclude_reason: x.reason,
                    })),
                  ];
                  setIsDispatching(true);
                  try {
                    const res = await fetch('/api/paystub-dispatch-queue', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        source_file: calcSourceFile,
                        pay_period: payPeriodPayload,
                        entries,
                      }),
                    });
                    const data = await res.json();
                    if (!res.ok || data?.error) {
                      toast.error('Send to Payment Dispatch failed', {
                        description: data?.error ?? `HTTP ${res.status}`,
                      });
                      return;
                    }
                    // Flip the realtime "values locked" flag so Payment Dispatch
                    // goes live for this cycle (and stays empty until then).
                    try {
                      await dispatchValuesLock.setLocked(true, sessionEmail ?? null);
                    } catch {
                      /* staging succeeded; lock write is best-effort + retryable */
                    }
                    void publishFinalPaySnapshot();
                    cursorOverlayRef.current?.broadcastSave();
                    setReportSnapshot({
                      startedAt: wizardStartedAt,
                      dispatchedAt: new Date(),
                      employees: dispatchData.rows,
                      usdToPhpRate,
                    });
                    setReportsTab('salaries');
                    setCurrentStep(9);
                  } catch (err) {
                    toast.error('Send to Payment Dispatch failed', {
                      description: err instanceof Error ? err.message : String(err),
                    });
                  } finally {
                    setIsDispatching(false);
                  }
                }}
                disabled={isDispatching || isReplay}
              >
                {isDispatching ? 'Sending to Dispatch…' : isReplay ? 'View-only (past period)' : 'Lock in Values & Send to Payment Dispatch'}
              </Button>
            </div>
          </div>
        );
      case 9: {
        // Replaying a past period: reconstruct the report from that period's recomputed
        // data (hours, additions, monthly sections all follow the selected file) and
        // overlay the dispatched per-employee finals saved in the snapshot so salary
        // figures match exactly what was paid. Treated as a real report (not a draft)
        // when the period was actually dispatched.
        const replayEmployees = isReplay && replaySnapshotFinals
          ? dispatchData.rows.map((e) => {
              const saved = replaySnapshotFinals[e.email?.trim().toLowerCase() ?? '']
                ?? replaySnapshotFinals[e.personal_email?.trim().toLowerCase() ?? ''];
              if (!saved) return e;
              return {
                ...e,
                hours: { total: saved.totalHours, regular: saved.regularHours, ot: saved.otHours },
                pay_php: {
                  ...e.pay_php,
                  regular: saved.regularPay,
                  ot: saved.otPay,
                  initial: saved.initial,
                  final: saved.final,
                },
              };
            })
          : null;

        const isDraft = isReplay ? !replayDispatched : reportSnapshot == null;
        // When dispatch hasn't happened, synthesize a live preview from the same
        // sources the dispatch call would package up. Displayed with a DRAFT
        // watermark — once dispatch fires, the real snapshot replaces it.
        const snap = isReplay
          ? {
              startedAt: wizardStartedAt,
              dispatchedAt: new Date(),
              employees: replayEmployees ?? dispatchData.rows,
              usdToPhpRate,
            }
          : reportSnapshot ?? {
              startedAt: wizardStartedAt,
              dispatchedAt: new Date(),
              employees: dispatchData.rows,
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

        const tabs = [
          { id: 'salaries' as const, label: 'Salaries / Wages', count: snap.employees.length, total: totalSalaries },
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
                {!isDraft && isReplay && (
                  <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
                    <Eye className="size-3.5 shrink-0" />
                    <span className="font-medium">Replay</span>
                    <span className="font-mono">past period · salaries from the dispatched snapshot</span>
                  </div>
                )}
                {!isDraft && !isReplay && (
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
                  <span className="font-mono font-bold text-sm">{formatPHP(totalSalaries)}</span>
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
                  ? (isReplay
                      ? 'Past period · never dispatched. Numbers reconstructed from this period’s saved state.'
                      : 'Draft preview · numbers reflect current wizard state.')
                  : isReplay
                    ? `Replay of ${formatPeriodLabel(calcSourceFile)} · salaries from the dispatched snapshot.`
                    : `Dispatched ${fmt(snap.dispatchedAt)}.`}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-2 border-emerald-300/70 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700/50 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                onClick={async () => {
                  const salariesAoa: (string | number | null)[][] = [
                    ['Employee', 'Email', 'Department', 'Hours', 'Regular', 'OT', 'Bonuses', 'MESA', 'Net Pay', 'Net Pay (USD)'],
                    ...snap.employees.map((e) => [
                      e.name ?? '',
                      e.email,
                      e.department_name ?? '',
                      e.hours.total,
                      e.pay_php.regular ?? null,
                      e.pay_php.ot ?? null,
                      e.pay_php.bonuses_total,
                      (e.pay_php.mesa_disbursement ?? 0) - e.pay_php.mesa_deduction,
                      e.pay_php.final,
                      snap.usdToPhpRate > 0 ? Math.round((e.pay_php.final / snap.usdToPhpRate) * 100) / 100 : null,
                    ]),
                  ];
                  // Fetch the audit trail for this cycle so it can be embedded
                  // as an "Audit Log" sheet alongside the other three. Best-effort:
                  // if the fetch fails the rest of the workbook still downloads.
                  let auditAoa: (string | number | null)[][] = [];
                  if (auditCycle.source_file) {
                    try {
                      const params = new URLSearchParams({ source_file: auditCycle.source_file });
                      if (auditCycle.period_start) params.set('period_start', auditCycle.period_start);
                      if (auditCycle.period_end) params.set('period_end', auditCycle.period_end);
                      const res = await fetch(`/api/payroll-wizard/audit?${params.toString()}`, { cache: 'no-store' });
                      const json = (await res.json()) as { bundle?: { events?: ClientAuditEvent[] }; error?: string | null };
                      if (!json.error && json.bundle?.events) {
                        auditAoa = auditEventsToAoa(json.bundle.events);
                      }
                    } catch {
                      // non-fatal — XLSX still gets a header-only Audit Log sheet below
                    }
                  }
                  if (auditAoa.length === 0) {
                    auditAoa = auditEventsToAoa([]); // header-only fallback
                  }

                  const wb = XLSX.utils.book_new();
                  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(salariesAoa), 'Salaries');
                  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(auditAoa), 'Audit Log');

                  // Timestamp like "2026-05-14 09-32-18" — filesystem-safe (no colons).
                  const d = snap.startedAt;
                  const pad = (n: number) => String(n).padStart(2, '0');
                  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
                  const filename = `Payroll Wizard - ${isDraft ? 'Draft' : 'Official'} - ${stamp}.xlsx`;
                  XLSX.writeFile(wb, filename);
                  const auditCount = Math.max(0, auditAoa.length - 1);
                  toast.success(`Downloaded ${filename}`, {
                    description: `Includes Audit Log sheet (${auditCount} event${auditCount === 1 ? '' : 's'})`,
                  });
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
                          {(() => {
                            const disb = e.pay_php.mesa_disbursement ?? 0;
                            const ded = e.pay_php.mesa_deduction;
                            const net = disb - ded;
                            if (disb > 0) return <td className="px-3 py-2 font-mono tabular-nums text-emerald-600 dark:text-emerald-400">{net >= 0 ? '+' : ''}{formatPHP(net)}</td>;
                            if (ded > 0) return <td className="px-3 py-2 font-mono tabular-nums text-rose-600 dark:text-rose-400">-{formatPHP(ded)}</td>;
                            return <td className="px-3 py-2 font-mono tabular-nums text-zinc-400">—</td>;
                          })()}
                          <td className="px-3 py-2 font-mono tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                            <PhpWithUsd php={e.pay_php.final} usdToPhp={snap.usdToPhpRate} align="start" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900">
                        <td colSpan={7} className="px-3 py-2.5 text-xs font-semibold text-zinc-600 dark:text-zinc-400">Total ({snap.employees.length} employees)</td>
                        <td className="px-3 py-2.5 font-mono font-bold text-zinc-900 dark:text-zinc-100">
                          <PhpWithUsd php={totalSalaries} usdToPhp={snap.usdToPhpRate} align="start" />
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            {/* Audit Trail — everything recorded against this cycle: who started
                the wizard, every edit (additions / bonuses / orphanage / tenure /
                gifts), contractor approvals/rejections, lock toggles, FX rate
                snapshots, and the final dispatch event with success/failure. */}
            {auditCycle.source_file && (
              <AuditTrailPanel
                sourceFile={auditCycle.source_file}
                periodStart={auditCycle.period_start ?? null}
                periodEnd={auditCycle.period_end ?? null}
                showExportButton
              />
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
    <div ref={wizardContainerRef} className="relative flex h-full flex-col overflow-hidden bg-zinc-50 p-2 sm:p-4 md:p-8 dark:bg-zinc-950">
      <WizardCursorOverlay
        ref={cursorOverlayRef}
        selfEmail={sessionEmail}
        containerRef={wizardContainerRef}
        isDriver={isLockDriver}
        isSpectator={isSpectator}
      />

      {/* ── Oversee / follow mode ──────────────────────────────────────────
          When another operator is driving the locked processing session, this
          client watches in a read-only, third-person view that mirrors their
          step. The blocker swallows clicks (wheel is forwarded to the step's
          scroll area); the banner names the driver and offers an opt-out. */}
      {isSpectator && (
        <>
          <div
            className="absolute inset-0 z-40 cursor-not-allowed bg-indigo-500/[0.03] ring-2 ring-inset ring-indigo-500/40"
            onWheel={handleSpectatorWheel}
            aria-hidden="true"
          />
          <div className="pointer-events-none absolute inset-x-0 top-0 z-[60] flex justify-center px-3 pt-3">
            <motion.div
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 420, damping: 30 }}
              className="pointer-events-auto flex items-center gap-3 rounded-full border border-indigo-300/70 bg-white/95 px-4 py-2 shadow-lg shadow-indigo-500/10 backdrop-blur dark:border-indigo-500/40 dark:bg-zinc-900/95"
            >
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-70" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-indigo-500" />
              </span>
              <Eye className="h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-400" />
              <div className="flex flex-col leading-tight">
                <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">
                  Observing <span className="font-mono text-indigo-600 dark:text-indigo-400">{driverLabel}</span>
                </span>
                <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
                  Live view-only &middot; your screen follows their step
                </span>
              </div>
              <button
                type="button"
                onClick={() => setObserving(false)}
                className="ml-1 shrink-0 rounded-full border border-zinc-200 px-2.5 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
              >
                Stop observing
              </button>
            </motion.div>
          </div>
        </>
      )}

      {/* When you are the driver, a quiet badge confirms others are watching. */}
      {isLockDriver && (
        <div className="pointer-events-none absolute right-3 top-3 z-[60]">
          <div className="flex items-center gap-1.5 rounded-full border border-rose-300/70 bg-white/95 px-3 py-1.5 shadow-sm backdrop-blur dark:border-rose-500/40 dark:bg-zinc-900/95">
            <Radio className="h-3.5 w-3.5 text-rose-500" />
            <span className="text-[11px] font-semibold text-rose-600 dark:text-rose-400">
              You are driving &middot; others can watch
            </span>
          </div>
        </div>
      )}

      {/* Re-enter follow mode after opting out, while the session is still live. */}
      {canSpectate && !observing && (
        <button
          type="button"
          onClick={() => {
            setObserving(true);
            if (driverEmail) cursorOverlayRef.current?.applyDriverScroll(driverEmail);
          }}
          className="absolute right-3 top-3 z-[60] flex items-center gap-1.5 rounded-full border border-indigo-300/70 bg-white/95 px-3 py-1.5 text-[11px] font-semibold text-indigo-600 shadow-sm backdrop-blur transition-colors hover:bg-indigo-50 dark:border-indigo-500/40 dark:bg-zinc-900/95 dark:text-indigo-400 dark:hover:bg-zinc-800"
        >
          <Eye className="h-3.5 w-3.5" />
          Resume observing {driverLabel}
        </button>
      )}
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
              This removes the batch{' '}
              <span className="font-mono">{deleteSourceFilePending ?? ''}</span> entirely &mdash; its
              entry in the uploaded-batches list and every hourly row tagged with it. Dispatched
              payments and Reports-tab history for the cycle are kept. If this was the active
              week, the newest remaining batch becomes active. Other batches are not affected.
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
        open={renameSourceFilePending !== null}
        onOpenChange={(open) => {
          if (!open) setRenameSourceFilePending(null);
        }}
      >
        <DialogContent className="border-zinc-200 bg-white sm:max-w-lg dark:border-zinc-800 dark:bg-zinc-950">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-zinc-900 dark:text-white">
              <Pencil className="h-5 w-5 shrink-0 text-indigo-600 dark:text-indigo-400" />
              Rename this upload
            </DialogTitle>
            <DialogDescription className="text-zinc-600 dark:text-zinc-400">
              This filename is the source of truth for the whole week. Renaming updates it
              everywhere &mdash; hourly rows, the Reports tab, dispatched payments, and the
              employee take-home snapshot &mdash; so the week stays linked. You can edit the
              entire name, including the date range.
            </DialogDescription>
          </DialogHeader>
          {renameSourceFilePending !== null && (
            <div className="space-y-3 pt-1">
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Name
                </label>
                <input
                  type="text"
                  autoFocus
                  value={renameNameDraft}
                  onChange={(e) => setRenameNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !renameSourceFileLoading) {
                      e.preventDefault();
                      void confirmRenameSourceFile();
                    }
                  }}
                  placeholder="simple-biz_daily_report_2026-03-22_to_2026-03-28.csv"
                  className="w-full rounded-md border border-zinc-200 bg-transparent px-2.5 py-2 font-mono text-sm text-zinc-900 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 dark:border-zinc-800 dark:text-white"
                />
              </div>
              {renameDateRangeChanged && (
                <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-500/40 dark:bg-amber-950/30">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <p className="text-[11px] leading-snug text-amber-700 dark:text-amber-300">
                    You changed the embedded date range. The payroll period is parsed from
                    this <span className="font-mono">YYYY-MM-DD_to_YYYY-MM-DD</span> block, so
                    only change it if you mean to re-date this batch.
                  </p>
                </div>
              )}
              <div className="rounded-md bg-zinc-50 px-3 py-2 dark:bg-zinc-900/60">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                  New filename
                </p>
                <p className="mt-0.5 break-all font-mono text-sm text-zinc-700 dark:text-zinc-300">
                  {renameTargetName.trim() || <span className="text-zinc-400">(empty)</span>}
                </p>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="border-zinc-200 dark:border-zinc-800"
              disabled={renameSourceFileLoading}
              onClick={() => setRenameSourceFilePending(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                renameSourceFileLoading ||
                !renameTargetName.trim() ||
                renameTargetName.trim() === renameSourceFilePending
              }
              className="gap-2 bg-indigo-600 text-white hover:bg-indigo-700"
              onClick={() => void confirmRenameSourceFile()}
            >
              {renameSourceFileLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Pencil className="h-4 w-4" />
              )}
              Rename everywhere
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
            setPreviewTab('paystubs');
            setPreviewPage(1);
          }
        }}
      >
        <DialogContent
          className={cn(
            'overflow-hidden rounded-2xl border-zinc-200 bg-white p-0 dark:border-zinc-800 dark:bg-zinc-950',
            // Animate the width morph so switching between the recipient list and
            // the single-email preview glides instead of snapping. Only max-width
            // transitions (the open/close keyframes drive transform + opacity).
            'transition-[max-width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
            // Single-email preview hugs the (zoomed-down) statement so the dialog
            // itself is small; wide horizontal layout for the recipient list.
            previewSelectedEmail
              ? 'w-[95vw] sm:max-w-[510px]'
              : 'w-[95vw] sm:max-w-3xl',
          )}
        >
          {(() => {
            const selected = previewSelectedEmail
              ? dispatchData.rows.find((e) => e.email === previewSelectedEmail)
              : null;
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
                  <div className="relative flex max-h-[90vh] flex-col overflow-hidden bg-[#f4f7fb] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] animate-in fade-in-0 zoom-in-95">
                    <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 bg-white/90 px-4 py-2.5 backdrop-blur">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2 text-xs text-zinc-700"
                        onClick={() => setPreviewSelectedEmail(null)}
                      >
                        <ChevronLeft className="h-4 w-4" />
                        Back
                      </Button>
                      <span className="pr-8 text-[10px] font-semibold uppercase tracking-[0.14em] text-orange-600">
                        Preview · Not yet sent
                      </span>
                    </div>
                    {/* Faithful in-app render of docs/features/paystub.html — the exact
                        email the recipient receives (orange card, slate section bars,
                        Total Net Pay hero, Earnings + MESA tables). */}
                    <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-4 py-4">
                      {/* Full-size statement (matches paystub.html proportions exactly),
                          scaled down as a whole via CSS zoom — a true resize, not a
                          per-element squash — so it fits the small dialog with no
                          scrollbar on a normal viewport. */}
                      <div
                        className="w-[560px] shrink-0 overflow-hidden rounded-[17px] bg-[#f97316] p-[3px]"
                        style={{ zoom: 0.84, boxShadow: '0 20px 48px rgba(16,32,52,0.16), 0 2px 6px rgba(16,32,52,0.07)' }}
                      >
                        <div className="overflow-hidden rounded-[14px] bg-[#fbfcfe]">
                          {/* Header */}
                          <div className="border-b border-[#eef2f6] bg-white px-8 py-5 text-center">
                            <img
                              src="https://host.simple.biz/email/simplelogo.png"
                              alt="Simple"
                              className="mx-auto mb-2 block h-auto w-[112px]"
                            />
                            <div className="text-[26px] font-bold leading-8 tracking-tight text-[#102034]">
                              Pay Statement
                            </div>
                            <div className="mt-1 text-[13px] leading-[19px] text-[#556377]">
                              Period ending{' '}
                              <span className="font-bold text-[#334155]">{weekHuman}</span>
                            </div>
                            <div className="mt-1.5 text-[11px] leading-4 text-[#556377]">
                              Confidential pay record
                            </div>
                          </div>

                          {/* Total Net Pay */}
                          <div className="px-8 pb-3 pt-3">
                            <div className="overflow-hidden rounded-[10px] border border-[#e2e8f0] bg-[#f8fafc]">
                              <div className="bg-[#334155] px-5 py-[5px] text-[11px] font-extrabold uppercase leading-[13px] tracking-[0.11em] text-white">
                                Total Net Pay
                              </div>
                              <div className="px-5 pb-2.5 pt-2">
                                <div className="text-[34px] font-extrabold leading-10 tracking-tight text-[#102034] tabular-nums">
                                  {fmt(pp.final)}
                                </div>
                                <div className="mt-1.5 flex items-center justify-between border-t border-[#e2e8f0] pt-1.5">
                                  <span className="text-[12px] leading-[17px] text-[#556377]">USD equivalent</span>
                                  <span className="text-[12px] font-bold leading-[17px] text-[#26384d] tabular-nums">
                                    {pp.final != null && selected.pay_period.fx_rate > 0
                                      ? `$${(pp.final / selected.pay_period.fx_rate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`
                                      : '—'}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Employee */}
                          <div className="px-8 pb-2.5">
                            <div className="bg-[#334155] px-3 py-[5px] text-[11px] font-extrabold uppercase leading-[13px] tracking-[0.12em] text-white">
                              Employee
                            </div>
                            <div className="flex items-start justify-between gap-4 border-b border-[#e2e8f0] py-2">
                              <div>
                                <div className="text-[10px] font-bold uppercase leading-[13px] tracking-[0.12em] text-[#556377]">Recipient</div>
                                <div className="mt-0.5 text-[14px] font-bold leading-5 text-[#102034]">{selected.name}</div>
                              </div>
                              <div className="text-right">
                                <div className="text-[10px] font-bold uppercase leading-[13px] tracking-[0.12em] text-[#556377]">Department</div>
                                <div className="mt-0.5 text-[14px] font-bold leading-5 text-[#102034]">{selected.department_name ?? '—'}</div>
                              </div>
                            </div>
                          </div>

                          {/* Earnings */}
                          <div className="px-8 pb-1">
                            <div className="bg-[#334155] px-3 py-[5px] text-[11px] font-extrabold uppercase leading-[13px] tracking-[0.12em] text-white">
                              Earnings
                            </div>
                            <table className="table-keep w-full border-collapse tabular-nums">
                              <tbody>
                                <tr>
                                  <td className="border-b border-[#cbd5e1] bg-[#f1f5f9] py-1 text-[10px] font-bold uppercase leading-3 tracking-[0.06em] text-[#334155]">Description</td>
                                  <td className="border-b border-[#cbd5e1] bg-[#f1f5f9] px-2 py-1 text-[10px] font-bold uppercase leading-3 tracking-[0.06em] text-[#334155]">Hours × Rate</td>
                                  <td className="border-b border-[#cbd5e1] bg-[#f1f5f9] py-1 text-right text-[10px] font-bold uppercase leading-3 tracking-[0.06em] text-[#334155]">Amount</td>
                                </tr>
                                <tr>
                                  <td className="border-b border-[#edf2f7] py-1.5 text-[13px] leading-[15px] text-[#26384d]">Regular Hours</td>
                                  <td className="whitespace-nowrap border-b border-[#edf2f7] px-2 py-1.5 text-[12px] leading-[15px] text-[#556377]">{selected.hours.regular.toFixed(2)}h × ₱{fmtRate(selected.rates_php.regular)}</td>
                                  <td className="whitespace-nowrap border-b border-[#edf2f7] py-1.5 text-right text-[13px] font-bold leading-[15px] text-[#102034]">{fmt(pp.regular)}</td>
                                </tr>
                                <tr>
                                  <td className="border-b border-[#edf2f7] py-1.5 text-[13px] leading-[15px] text-[#26384d]">Overtime</td>
                                  <td className="whitespace-nowrap border-b border-[#edf2f7] px-2 py-1.5 text-[12px] leading-[15px] text-[#556377]">{selected.hours.ot.toFixed(2)}h × ₱{fmtRate(selected.rates_php.ot)}</td>
                                  <td className="whitespace-nowrap border-b border-[#edf2f7] py-1.5 text-right text-[13px] font-bold leading-[15px] text-[#102034]">{fmt(pp.ot)}</td>
                                </tr>
                                <tr>
                                  <td className="border-b border-[#edf2f7] py-1.5 text-[13px] leading-[15px] text-[#26384d]">Tech Allowance</td>
                                  <td className="border-b border-[#edf2f7] px-2 py-1.5 text-[12px] leading-[15px] text-[#556377]">Bonus</td>
                                  <td className="whitespace-nowrap border-b border-[#edf2f7] py-1.5 text-right text-[13px] font-bold leading-[15px] text-[#102034]">{fmt(pp.tech_bonus)}</td>
                                </tr>
                                <tr>
                                  <td className="border-b border-[#edf2f7] py-1.5 text-[13px] leading-[15px] text-[#26384d]">Attendance Incentive</td>
                                  <td className="border-b border-[#edf2f7] px-2 py-1.5 text-[12px] leading-[15px] text-[#556377]">Bonus</td>
                                  <td className="whitespace-nowrap border-b border-[#edf2f7] py-1.5 text-right text-[13px] font-bold leading-[15px] text-[#102034]">{fmt(pp.perfect_attendance_bonus)}</td>
                                </tr>
                                <tr>
                                  <td className="border-b border-[#edf2f7] py-1.5 text-[13px] leading-[15px] text-[#26384d]">Performance Bonus</td>
                                  <td className="border-b border-[#edf2f7] px-2 py-1.5 text-[12px] leading-[15px] text-[#556377]">Bonus</td>
                                  <td className="whitespace-nowrap border-b border-[#edf2f7] py-1.5 text-right text-[13px] font-bold leading-[15px] text-[#102034]">{fmt(pp.other_bonuses)}</td>
                                </tr>
                                <tr>
                                  <td className="py-1.5 text-[13px] leading-[15px] text-[#26384d]">Adjustment</td>
                                  <td className="px-2 py-1.5 text-[12px] leading-[15px] text-[#556377]">{selected.adjustment_note || 'Manual adjustment'}</td>
                                  <td className="whitespace-nowrap py-1.5 text-right text-[13px] font-bold leading-[15px] text-[#102034]">{fmt(pp.adjustment)}</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>

                          {/* MESA Adjustment */}
                          <div className="px-8 pb-1 pt-2">
                            <div className="bg-[#334155] px-3 py-[5px] text-[11px] font-extrabold uppercase leading-[13px] tracking-[0.12em] text-white">
                              MESA Adjustment
                            </div>
                            <table className="table-keep w-full border-collapse tabular-nums">
                              <tbody>
                                <tr>
                                  <td className="border-b border-[#cbd5e1] bg-[#f1f5f9] py-1 text-[10px] font-bold uppercase leading-3 tracking-[0.06em] text-[#334155]">Description</td>
                                  <td className="border-b border-[#cbd5e1] bg-[#f1f5f9] px-2 py-1 text-[10px] font-bold uppercase leading-3 tracking-[0.06em] text-[#334155]">Type</td>
                                  <td className="border-b border-[#cbd5e1] bg-[#f1f5f9] py-1 text-right text-[10px] font-bold uppercase leading-3 tracking-[0.06em] text-[#334155]">Amount</td>
                                </tr>
                                <tr>
                                  <td className="border-b border-[#edf2f7] py-1.5 text-[13px] leading-[15px] text-[#26384d]">MESA Reimbursement</td>
                                  <td className="border-b border-[#edf2f7] px-2 py-1.5 text-[12px] leading-[15px] text-[#556377]">Payout</td>
                                  <td className="whitespace-nowrap border-b border-[#edf2f7] py-1.5 text-right text-[13px] font-bold leading-[15px] text-[#0f766e]">+{fmt(pp.mesa_disbursement)}</td>
                                </tr>
                                <tr>
                                  <td className="py-1.5 text-[13px] leading-[15px] text-[#26384d]">MESA Deduction</td>
                                  <td className="px-2 py-1.5 text-[12px] leading-[15px] text-[#556377]">Contribution</td>
                                  <td className="whitespace-nowrap py-1.5 text-right text-[13px] font-bold leading-[15px] text-[#b3261e]">-{fmt(pp.mesa_deduction)}</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>

                          {/* Confidential note */}
                          <div className="px-8 pb-4 pt-3">
                            <div className="rounded-[10px] border border-[#e2e8f0] bg-[#f8fafc] px-3.5 py-2 text-[11px] leading-4 text-[#556377]">
                              <strong className="text-[#334155]">Confidential:</strong> This statement is intended only for the recipient named above. Contact your payroll representative if any hours or totals need review.
                            </div>
                          </div>

                          {/* Footer */}
                          <div className="flex items-center justify-between border-t border-[#eef2f6] bg-[#f8fafc] px-8 py-2.5">
                            <span className="text-[11px] leading-4 text-[#556377]">Automated dispatch from Simple HRIS</span>
                            <span className="whitespace-nowrap text-[11px] font-bold leading-4 text-[#334155]">Simple Payroll</span>
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
                    e.email.toLowerCase().includes(needle) ||
                    e.personal_email.toLowerCase().includes(needle),
                )
              : dispatchData.rows;
            const approvedContractors = contractorInvoicesInPeriod.filter((i) => i.status === 'approved');
            const filteredContractors = needle
              ? approvedContractors.filter((inv) =>
                  [inv.contractor_email, inv.from_entity_name, inv.from_name, inv.invoice_number]
                    .join(' ')
                    .toLowerCase()
                    .includes(needle),
                )
              : approvedContractors;

            // Pagination — applies to whichever tab is active. The horizontal
            // modal fits two columns, so a 12-per-page window keeps each page to
            // ~6 rows and avoids one endless scroll of recipients.
            const activeCount =
              previewTab === 'paystubs'
                ? filteredPaystubs.length
                : filteredContractors.length;
            const PREVIEW_PAGE_SIZE = 12;
            const previewTotalPages = Math.max(1, Math.ceil(activeCount / PREVIEW_PAGE_SIZE));
            const previewSafePage = Math.min(Math.max(1, previewPage), previewTotalPages);
            const pageStart = (previewSafePage - 1) * PREVIEW_PAGE_SIZE;
            const pageEnd = pageStart + PREVIEW_PAGE_SIZE;
            const pageFirst = activeCount === 0 ? 0 : pageStart + 1;
            const pageLast = Math.min(pageEnd, activeCount);
            return (
              <>
                <DialogHeader className="px-6 pt-6">
                  <DialogTitle className="text-zinc-900 dark:text-white">Preview Emails</DialogTitle>
                  <DialogDescription className="text-zinc-600 dark:text-zinc-400">
                    {previewTab === 'paystubs'
                      ? `${dispatchData.rows.length} paystub${dispatchData.rows.length === 1 ? '' : 's'} queued for this batch.`
                      : `${approvedContractors.length} approved contractor invoice${approvedContractors.length === 1 ? '' : 's'} queued.`}
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
                        {approvedContractors.length}
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
                <div className="min-h-[220px] max-h-[55vh] overflow-y-auto px-6 pb-4 pt-3">
                  {previewTab === 'paystubs' ? (
                    filteredPaystubs.length === 0 ? (
                      <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                        {dispatchData.rows.length === 0
                          ? 'No employees queued for dispatch.'
                          : `No employees match “${previewSearch}”.`}
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {filteredPaystubs.slice(pageStart, pageEnd).map((e) => (
                          <div
                            key={e.email}
                            className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40"
                          >
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
                  ) : (
                    filteredContractors.length === 0 ? (
                      <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                        {approvedContractors.length === 0
                          ? 'No approved contractor invoices queued for dispatch.'
                          : `No invoices match “${previewSearch}”.`}
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {filteredContractors.slice(pageStart, pageEnd).map((inv) => (
                          <div
                            key={inv.id}
                            className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-zinc-900 dark:text-white">
                                {inv.from_entity_name || inv.from_name || inv.contractor_email}
                              </div>
                              <div className="truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
                                {inv.invoice_number} · {formatMoney(inv.total ?? 0, normalizeCurrency(inv.currency))} {normalizeCurrency(inv.currency)}
                              </div>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 shrink-0"
                              onClick={() => setPreviewSelectedInvoiceId(inv.id)}
                            >
                              View
                            </Button>
                          </div>
                        ))}
                      </div>
                    )
                  )}
                </div>
                {activeCount > 0 && (
                  <div className="flex items-center justify-between gap-3 border-t border-zinc-200 px-6 py-3 dark:border-zinc-800">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      Showing{' '}
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        {pageFirst}–{pageLast}
                      </span>{' '}
                      of {activeCount}
                    </span>
                    {previewTotalPages > 1 && (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1 px-2"
                          disabled={previewSafePage <= 1}
                          onClick={() => setPreviewPage((p) => Math.max(1, p - 1))}
                        >
                          <ChevronLeft className="h-4 w-4" />
                          Prev
                        </Button>
                        <span className="min-w-[64px] text-center text-xs font-medium text-zinc-600 dark:text-zinc-400">
                          {previewSafePage} / {previewTotalPages}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1 px-2"
                          disabled={previewSafePage >= previewTotalPages}
                          onClick={() => setPreviewPage((p) => Math.min(previewTotalPages, p + 1))}
                        >
                          Next
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Contractor receipt — same view the contractor sees in their dashboard,
          opened from Preview Emails → Contractors → View. */}
      <InvoiceViewDialog
        invoice={
          previewSelectedInvoiceId
            ? contractorInvoices.find((i) => i.id === previewSelectedInvoiceId) ?? null
            : null
        }
        open={previewSelectedInvoiceId !== null}
        onClose={() => setPreviewSelectedInvoiceId(null)}
      />

      <div className="mb-3 flex items-start justify-between gap-2 sm:mb-6 md:mb-8">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2.5 text-lg font-bold tracking-tight text-zinc-900 sm:text-xl md:text-2xl dark:text-white">
            <span className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white shadow-md shadow-violet-500/30 sm:h-8 sm:w-8 md:h-9 md:w-9">
              <Sparkles className="h-4 w-4 md:h-[18px] md:w-[18px]" />
              <span aria-hidden className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-inset ring-white/25" />
            </span>
            Payroll Wizard
          </h2>
          <p className="hidden text-xs text-zinc-600 sm:block sm:text-sm dark:text-zinc-500">The &quot;Friday Path&quot; Automated Workflow</p>
          <p className="text-[10px] text-zinc-500 sm:hidden dark:text-zinc-500">
            Step {currentStep} of {steps.length} · {steps.find((s) => s.id === currentStep)?.label}
          </p>
        </div>
        {/* Pay-period (Hubstaff report) selector — replay any past period read-only. */}
        {uploadedSourceFiles.length > 0 && (
          <div className="flex shrink-0 items-center gap-2">
            {isReplay && (
              <span className="hidden items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 sm:inline-flex dark:bg-amber-900/50 dark:text-amber-300">
                <Eye className="h-3 w-3" /> Replay
              </span>
            )}
            <div className="relative">
              <CalendarDays className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <select
                value={calcSourceFile ?? ''}
                onChange={(e) => setCalcSourceFile(e.target.value || null)}
                title="Replay a past payroll period — loads everything that was done for that Hubstaff report"
                className={cn(
                  'h-8 cursor-pointer appearance-none rounded-lg border bg-white py-1 pl-8 pr-7 text-xs font-medium shadow-sm focus:outline-none focus:ring-1 dark:bg-zinc-950',
                  isReplay
                    ? 'border-amber-400 text-amber-800 focus:ring-amber-400 dark:border-amber-700/60 dark:text-amber-300'
                    : 'border-zinc-200 text-zinc-700 focus:ring-indigo-400 dark:border-zinc-800 dark:text-zinc-300',
                )}
              >
                {uploadedSourceFiles.map((f, i) => (
                  <option key={f} value={f}>
                    {formatPeriodLabel(f)}{i === 0 ? ' · current' : ''}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            </div>
          </div>
        )}
      </div>

      {/* Replay banner — view-only review of a closed pay period. */}
      {isReplay && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-amber-300/70 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 sm:mb-4 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
          <Eye className="h-3.5 w-3.5 shrink-0" />
          <span className="font-semibold">Replaying {formatPeriodLabel(calcSourceFile)} — view-only.</span>
          <span className="opacity-80">
            Showing the adjustments, notes, bonuses and final pay saved for this period.
            {replayDispatched ? ' This period was dispatched.' : ' This period was not dispatched.'}
            {' '}Saving and dispatch are disabled.
          </span>
          <button
            type="button"
            onClick={() => setCalcSourceFile(newestSourceFile)}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-amber-400 bg-white/70 px-2 py-1 font-semibold text-amber-800 transition-colors hover:bg-white dark:border-amber-700/60 dark:bg-zinc-900/40 dark:text-amber-200 dark:hover:bg-zinc-900"
          >
            <ArrowLeft className="h-3 w-3" /> Return to current period
          </button>
        </div>
      )}

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
          {/* Modern wizard-progress bar — sits on top of every step's content.
              Indigo diagonal stripes march continuously; the bar fills as you
              advance through the steps and turns emerald at the final step. */}
          {(() => {
            const totalSteps = steps.length;
            const pct = totalSteps > 0 ? Math.round((currentStep / totalSteps) * 100) : 0;
            const complete = currentStep >= totalSteps;
            const activeStepLabel = steps.find((s) => s.id === currentStep)?.label ?? '';
            return (
              <div className="flex-shrink-0 border-b border-zinc-200 bg-gradient-to-r from-white via-indigo-50/50 to-white px-4 py-2.5 sm:px-5 sm:py-3 dark:border-zinc-800 dark:from-zinc-900/60 dark:via-indigo-950/20 dark:to-zinc-900/60">
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
                      <span className={cn(
                        'absolute inline-flex h-full w-full rounded-full opacity-75',
                        complete ? 'animate-ping bg-emerald-400' : 'animate-ping bg-indigo-400',
                      )} />
                      <span className={cn(
                        'relative inline-flex h-1.5 w-1.5 rounded-full',
                        complete ? 'bg-emerald-500' : 'bg-indigo-500',
                      )} />
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-700 sm:text-[11px] dark:text-zinc-200">
                      Payroll Progress
                    </span>
                    <span className="truncate text-[10px] text-zinc-500 dark:text-zinc-400 sm:text-[11px]">
                      &middot; {activeStepLabel}
                    </span>
                  </div>
                  <div className="flex flex-shrink-0 items-baseline gap-1.5 font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                    <span>Step</span>
                    <span className="font-semibold text-zinc-700 dark:text-zinc-200">{currentStep}</span>
                    <span>/</span>
                    <span>{totalSteps}</span>
                    <span className={cn(
                      'ml-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold',
                      complete
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                        : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300',
                    )}>
                      {pct}%
                    </span>
                  </div>
                </div>
                <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-zinc-200/70 ring-1 ring-inset ring-zinc-300/50 dark:bg-zinc-800/80 dark:ring-zinc-700/50">
                  <motion.div
                    className={cn(
                      'relative h-full min-w-[0.625rem] overflow-hidden rounded-full',
                      complete
                        ? 'bg-gradient-to-r from-emerald-400 via-emerald-500 to-teal-500 shadow-[0_0_14px_-2px_rgba(16,185,129,0.65)]'
                        : 'bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500 shadow-[0_0_14px_-2px_rgba(139,92,246,0.6)]',
                    )}
                    initial={false}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Wizard step ${currentStep} of ${totalSteps}`}
                  >
                    {/* Glass top-highlight — a soft sheen along the upper half of the fill. */}
                    <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-1/2 rounded-full bg-white/25" />
                    {/* Light streak that sweeps across the filled portion (transform-only). */}
                    <span aria-hidden className="progress-sheen pointer-events-none absolute inset-y-0 left-0 w-2/5 bg-gradient-to-r from-transparent via-white/60 to-transparent" />
                    {/* Bright leading edge so the fill head reads as a glowing tip. */}
                    <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-1 rounded-full bg-white/80 blur-[0.5px]" />
                  </motion.div>
                </div>
              </div>
            );
          })()}

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
          const paExcluded = isPabExcluded(pabCalendarModalEmail);
          const paStatus = effectivePabStatus.get(normEmpEmail) ?? (paEligible ? 'eligible' : 'ineligible');
          const isHsl =
            employeeDepts[pabCalendarModalEmail] === 'hogan_smith_law' ||
            employeeDepts[pabCalendarModalEmail.toLowerCase()] === 'hogan_smith_law';

          // Weekend premium for this pay week (current source file only)
          const wkndPremiumData = isHsl ? weekendPremiumByEmail.get(normEmpEmail) : undefined;
          const wkndPremiumTotal = wkndPremiumData
            ? Math.round((wkndPremiumData.regPremiumPHP + wkndPremiumData.otPremiumPHP) * 100) / 100
            : 0;
          const breakdown = isHsl
            ? (employeeAllDaysHours.get(normEmpEmail) ?? [])
            : (employeeWeekdayHours.get(normEmpEmail) ?? []);
          // Map ISO date → breakdown entry so we can look up per-cell data quickly.
          const byIso = new Map<string, { seconds: number; passes: boolean; forgivenByDispute: boolean; forgivenByHoliday: boolean; holidayName: string | null }>();
          for (const entry of breakdown) {
            const d = parseColDate(entry.col);
            if (!d) continue;
            const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            byIso.set(iso, {
              seconds: entry.seconds,
              passes: entry.passes,
              forgivenByDispute: entry.forgivenByDispute,
              forgivenByHoliday: entry.forgivenByHoliday,
              holidayName: entry.holidayName,
            });
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

          // For HSL: precompute per Mon–Sun week data so cells can be coloured correctly.
          // Each of the 7 days counts independently; overnight shifts (< 7h today but
          // combined with next-day hours it reaches ≥ 7h) are captured in overnightIsos.
          type HslWeekData = { qualifyingDays: number; weekPasses: boolean; overnightIsos: Set<string> };
          const hslWeekInfo = new Map<string, HslWeekData>();
          if (isHsl && pabMonthRange && effectivePabEnd) {
            const endT = effectivePabEnd.getTime();
            const wCur = new Date(pabMonthRange.start);
            const wDow = wCur.getDay();
            const wToMon = wDow === 0 ? 1 : wDow === 1 ? 0 : 8 - wDow;
            wCur.setDate(wCur.getDate() + wToMon);
            while (wCur.getTime() <= endT) {
              const weekIso = `${wCur.getFullYear()}-${String(wCur.getMonth() + 1).padStart(2, '0')}-${String(wCur.getDate()).padStart(2, '0')}`;
              let qualifyingDays = 0;
              const overnightIsos = new Set<string>();
              const tempCur = new Date(wCur);
              for (let d = 0; d < 7; d++) {
                if (tempCur.getTime() > endT) break;
                const dayIso = `${tempCur.getFullYear()}-${String(tempCur.getMonth() + 1).padStart(2, '0')}-${String(tempCur.getDate()).padStart(2, '0')}`;
                const dayEntry = byIso.get(dayIso);
                // Forgiven days (dispute or US holiday) count as passing (treat as ≥ 7h)
                const sec = dayEntry ? ((dayEntry.forgivenByDispute || dayEntry.forgivenByHoliday) ? 7 * 3600 : dayEntry.seconds) : 0;
                let effectiveSec = sec;
                if (sec > 0 && sec < 7 * 3600) {
                  // Forward: today is the overnight start, add tomorrow's hours
                  const nextDay = new Date(tempCur.getFullYear(), tempCur.getMonth(), tempCur.getDate() + 1);
                  const nextIso = `${nextDay.getFullYear()}-${String(nextDay.getMonth() + 1).padStart(2, '0')}-${String(nextDay.getDate()).padStart(2, '0')}`;
                  const nextEntry = byIso.get(nextIso);
                  if (nextEntry) {
                    const nextSec = (nextEntry.forgivenByDispute || nextEntry.forgivenByHoliday) ? 7 * 3600 : nextEntry.seconds;
                    if (sec + nextSec >= 7 * 3600) effectiveSec = sec + nextSec;
                  }
                  // Backward: today is the overnight tail, add yesterday's hours
                  if (effectiveSec < 7 * 3600) {
                    const prevDay = new Date(tempCur.getFullYear(), tempCur.getMonth(), tempCur.getDate() - 1);
                    const prevIso = `${prevDay.getFullYear()}-${String(prevDay.getMonth() + 1).padStart(2, '0')}-${String(prevDay.getDate()).padStart(2, '0')}`;
                    const prevEntry = byIso.get(prevIso);
                    if (prevEntry && !prevEntry.forgivenByDispute && !prevEntry.forgivenByHoliday) {
                      const prevSec = prevEntry.seconds;
                      if (prevSec > 0 && prevSec < 7 * 3600 && prevSec + sec >= 7 * 3600) effectiveSec = prevSec + sec;
                    }
                  }
                }
                if (effectiveSec >= 7 * 3600) {
                  qualifyingDays++;
                  if (sec < 7 * 3600) overnightIsos.add(dayIso);
                }
                tempCur.setDate(tempCur.getDate() + 1);
                wCur.setDate(wCur.getDate() + 1);
              }
              hslWeekInfo.set(weekIso, { qualifyingDays, weekPasses: qualifyingDays >= 5, overnightIsos });
            }
          }
          // Flat set of all overnight-qualifying ISOs for quick lookup in filters below.
          const hslOvernightIsoSet = new Set<string>();
          if (isHsl) {
            for (const wd of hslWeekInfo.values()) {
              for (const iso of wd.overnightIsos) hslOvernightIsoSet.add(iso);
            }
          }

          // Build calendar grid (weeks × 7 days) spanning the PAB period.
          type Cell = { date: Date; iso: string; inRange: boolean; isWeekday: boolean; data: { seconds: number; passes: boolean; forgivenByDispute: boolean; forgivenByHoliday: boolean; holidayName: string | null } | null; holidayName: string | null };
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
                holidayName: usHolidayDates.get(iso) ?? null,
              });
              cursor.setDate(cursor.getDate() + 1);
            }
          }

          const totalDays = breakdown.length;
          const passedDays = breakdown.filter((b) => {
            if (b.passes && !b.forgivenByDispute && !b.forgivenByHoliday) return true;
            if (isHsl) {
              const d = parseColDate(b.col);
              if (!d) return false;
              const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
              if (hslOvernightIsoSet.has(iso)) return true; // overnight-qualifying counts as passed
            }
            return false;
          }).length;
          const forgivenDays = breakdown.filter((b) => b.forgivenByDispute).length;
          const holidayDays = breakdown.filter((b) => b.forgivenByHoliday).length;
          // For HSL: Sat/Sun are not "failed"; overnight-qualifying and reconciled weekdays are not "failed"
          const failedDays = breakdown.filter((b) => {
            if (b.passes) return false;
            if (isHsl) {
              const d = parseColDate(b.col);
              if (!d) return false;
              const dow = d.getDay();
              if (dow === 0 || dow === 6) return false; // Sat/Sun never count as failed in the tally
              const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
              if (hslOvernightIsoSet.has(iso)) return false; // overnight-qualifying
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
                const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                if (hslOvernightIsoSet.has(iso)) return false; // overnight-qualifying
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

          const normModalEmail = pabCalendarModalEmail?.trim().toLowerCase() ?? '';
          const forgivenIsoSet = new Set<string>(approvedDisputeIds.get(normModalEmail)?.keys() ?? []);

          const handleRevokeDay = async (iso: string) => {
            if (pabRevokeLoadingIso || !pabCalendarModalEmail) return;
            const disputeId = approvedDisputeIds.get(normModalEmail)?.get(iso);
            if (!disputeId) { setPabRevokeError('Issue ID not found — refresh and try again.'); return; }
            setPabRevokeLoadingIso(iso);
            setPabRevokeError(null);
            try {
              const res = await fetch(`/api/pab-disputes/${disputeId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'revoke', decision_note: 'Revoked by Accounting' }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error ?? 'Failed to revoke');
              setApprovedDisputeDates(prev => {
                const next = new Map(prev);
                const dates = new Map(next.get(normModalEmail) ?? []);
                dates.delete(iso);
                next.set(normModalEmail, dates);
                return next;
              });
              setApprovedDisputeIds(prev => {
                const next = new Map(prev);
                const ids = new Map(next.get(normModalEmail) ?? []);
                ids.delete(iso);
                next.set(normModalEmail, ids);
                return next;
              });
              setPabRevokeActiveIso(null);
            } catch (err) {
              setPabRevokeError(err instanceof Error ? err.message : 'An error occurred');
            } finally {
              setPabRevokeLoadingIso(null);
            }
          };

          const handleForgiveDay = async (iso: string, note: string, rawSeconds: number) => {
            if (pabForgiveLoadingIso || !pabCalendarModalEmail) return;
            setPabForgiveLoadingIso(iso);
            setPabForgiveError(null);
            try {
              const createRes = await fetch('/api/pab-disputes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  work_email: pabCalendarModalEmail,
                  dispute_date: iso,
                  reason: 'other',
                  explanation: note.trim() || 'Forgiven by Accounting',
                }),
              });
              const createData = await createRes.json();
              if (!createRes.ok || !createData.id) throw new Error(createData.error ?? 'Failed to create issue');
              // For days with < 4h raw hours the 4h floor inside disputeForgiven would reject a null
              // override, so we set a 5h credit to ensure the amber "forgiven" state activates.
              const overrideHours = rawSeconds < 4 * 3600 ? 5 : null;
              const approveRes = await fetch(`/api/pab-disputes/${createData.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'approve',
                  decision_note: note.trim() || 'Forgiven by Accounting',
                  override_hours: overrideHours,
                }),
              });
              const approveData = await approveRes.json();
              if (!approveRes.ok) throw new Error(approveData.error ?? 'Failed to approve issue');
              const em = pabCalendarModalEmail.trim().toLowerCase();
              setApprovedDisputeDates(prev => {
                const next = new Map(prev);
                const existing = next.get(em) ?? new Map<string, number | null>();
                const updated = new Map(existing);
                updated.set(iso, overrideHours);
                next.set(em, updated);
                return next;
              });
              setApprovedDisputeIds(prev => {
                const next = new Map(prev);
                const existing = next.get(em) ?? new Map<string, string>();
                const updated = new Map(existing);
                updated.set(iso, createData.id);
                next.set(em, updated);
                return next;
              });
              setPabForgiveActiveIso(null);
              setPabForgiveNote('');
            } catch (err) {
              setPabForgiveError(err instanceof Error ? err.message : 'An error occurred');
            } finally {
              setPabForgiveLoadingIso(null);
            }
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
                          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                          paExcluded
                            ? 'bg-rose-100 text-rose-700 ring-1 ring-rose-400/40 dark:bg-rose-950/50 dark:text-rose-300'
                            : paStatus === 'eligible'
                            ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-400/40 dark:bg-emerald-900/40 dark:text-emerald-300'
                            : paStatus === 'ineligible'
                              ? 'bg-red-100 text-red-700 ring-1 ring-red-400/40 dark:bg-red-900/40 dark:text-red-300'
                              : 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-400/40 dark:bg-indigo-900/40 dark:text-indigo-300',
                        )}
                      >
                        {paExcluded
                          ? <><UserX className="h-3 w-3" /> Excluded</>
                          : paStatus === 'eligible' ? '✓ Eligible' : paStatus === 'ineligible' ? '✗ Ineligible' : '⏳ In Progress'}
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
                          <div className="font-mono text-base font-bold leading-none text-amber-700 dark:text-amber-300">{forgivenDays + holidayDays}</div>
                          <div className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700/70 dark:text-amber-400/80">
                            Forgiven{holidayDays > 0 ? ` (${holidayDays} US hol)` : ''}
                          </div>
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
                          let state: 'idle' | 'passed' | 'overnight' | 'forgiven' | 'holiday' | 'reconciled' | 'failed' | 'missing';
                          // US holiday takes priority over everything except passing data —
                          // even if there are no Hubstaff hours, the day is forgiven.
                          if (!cell.inRange) {
                            state = 'idle';
                          } else if (cell.holidayName && (!data || data.seconds < 7 * 3600)) {
                            state = 'holiday';
                          } else if (data?.forgivenByDispute) {
                            state = 'forgiven';
                          } else if (weekend && !isHsl) {
                            state = 'idle';
                          } else if (weekend && isHsl) {
                            // HSL Sat/Sun: green if ≥ 7h standalone, teal if overnight-qualifying,
                            // orange reconciled if week passes despite this day, idle otherwise — NEVER red
                            if (data && data.seconds >= 7 * 3600) {
                              state = 'passed';
                            } else if (hslOvernightIsoSet.has(cell.iso)) {
                              state = 'overnight';
                            } else {
                              const weekData = hslWeekInfo.get(getWeekMondayIso(cell.date));
                              state = weekData?.weekPasses ? 'reconciled' : 'idle';
                            }
                          } else if (data?.passes) {
                            state = 'passed';
                          } else if (data) {
                            if (isHsl) {
                              // Weekday < 7h standalone: teal overnight, orange reconciled, or red failed
                              if (hslOvernightIsoSet.has(cell.iso)) {
                                state = 'overnight';
                              } else {
                                const weekData = hslWeekInfo.get(getWeekMondayIso(cell.date));
                                state = weekData?.weekPasses ? 'reconciled' : 'failed';
                              }
                            } else {
                              state = 'failed';
                            }
                          } else {
                            state = 'missing';
                          }
                          const stateClasses: Record<typeof state, string> = {
                            idle: 'bg-zinc-100/70 text-zinc-400 ring-1 ring-zinc-200/70 dark:bg-zinc-900/50 dark:text-zinc-600 dark:ring-zinc-800/60',
                            passed: 'bg-emerald-200 text-emerald-900 ring-1 ring-emerald-500/70 shadow-[0_1px_2px_rgba(16,185,129,0.15)] dark:bg-emerald-600/40 dark:text-emerald-50 dark:ring-emerald-400/50',
                            overnight: 'bg-teal-200 text-teal-900 ring-1 ring-teal-500/70 shadow-[0_1px_2px_rgba(20,184,166,0.15)] dark:bg-teal-600/40 dark:text-teal-50 dark:ring-teal-400/50',
                            forgiven: 'bg-amber-200 text-amber-900 ring-1 ring-amber-500/70 shadow-[0_1px_2px_rgba(245,158,11,0.18)] dark:bg-amber-600/40 dark:text-amber-50 dark:ring-amber-400/50',
                            holiday: 'bg-sky-200 text-sky-900 ring-1 ring-sky-500/70 shadow-[0_1px_2px_rgba(14,165,233,0.18)] dark:bg-sky-600/40 dark:text-sky-50 dark:ring-sky-400/50',
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
                                  : state === 'holiday'
                                    ? `${cell.date.toDateString()} — ${cell.holidayName} (US holiday, PAB forgiven)`
                                    : (weekend && !isHsl)
                                      ? `${cell.date.toDateString()} — weekend`
                                      : data
                                        ? `${cell.date.toDateString()} · ${formatSeconds(data.seconds)} logged${
                                            cell.holidayName
                                              ? ` · ${cell.holidayName} (US holiday)`
                                              : data.forgivenByDispute
                                                ? ' · ★ forgiven by issue'
                                                : state === 'overnight'
                                                  ? ' · → overnight shift (combined with next day)'
                                                  : state === 'reconciled'
                                                    ? ' · ~ reconciled (week has ≥5 qualifying days)'
                                                    : data.passes
                                                      ? ' · ✓ passes 7h threshold'
                                                      : ` · short by ${formatShortfall(shortfall)}`
                                          }`
                                        : `${cell.date.toDateString()} — no Hubstaff data`
                              }
                              onClick={
                                state === 'failed'
                                  ? () => { setPabForgiveActiveIso(pabForgiveActiveIso === cell.iso ? null : cell.iso); setPabForgiveError(null); }
                                  : state === 'forgiven' && forgivenIsoSet.has(cell.iso)
                                    ? () => { setPabRevokeActiveIso(pabRevokeActiveIso === cell.iso ? null : cell.iso); setPabRevokeError(null); }
                                    : undefined
                              }
                              className={cn(
                                'flex h-[46px] flex-col items-center justify-center overflow-hidden rounded-md px-0.5 text-center transition-shadow',
                                (state === 'failed' || (state === 'forgiven' && forgivenIsoSet.has(cell.iso))) ? 'cursor-pointer' : 'cursor-default',
                                state === 'failed' && pabForgiveActiveIso === cell.iso ? 'ring-4 ring-indigo-500 ring-offset-1 z-10' : '',
                                state === 'forgiven' && pabRevokeActiveIso === cell.iso ? 'ring-4 ring-red-400 ring-offset-1 z-10' : '',
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
                              {state === 'overnight' && (
                                <span className="mt-0.5 text-[8px] leading-none opacity-80">→</span>
                              )}
                              {state === 'forgiven' && (
                                <span className="mt-0.5 text-[8px] leading-none opacity-80">★</span>
                              )}
                              {state === 'holiday' && (
                                <span className="mt-0.5 text-[8px] font-semibold leading-none opacity-90" title={cell.holidayName ?? undefined}>US</span>
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
                              {/* Weekend premium badge for HSL Sat/Sun cells with logged hours */}
                              {isHsl && weekend && cell.inRange && data && data.seconds > 0 && (
                                <span className="mt-0.5 text-[8px] font-bold leading-none text-amber-700 dark:text-amber-300" title="+15 PHP/h weekend rate applied">+₱15</span>
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
                          <span className="h-2.5 w-2.5 rounded-sm bg-emerald-200 ring-1 ring-emerald-500/70 dark:bg-emerald-600/40 dark:ring-emerald-400/50" /> ≥ 7h ✓
                        </span>
                        {isHsl && (
                          <span className="flex items-center gap-1">
                            <span className="h-2.5 w-2.5 rounded-sm bg-teal-200 ring-1 ring-teal-500/70 dark:bg-teal-600/40 dark:ring-teal-400/50" /> Overnight →
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <span className="h-2.5 w-2.5 rounded-sm bg-amber-200 ring-1 ring-amber-500/70 dark:bg-amber-600/40 dark:ring-amber-400/50" /> Forgiven ★
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="h-2.5 w-2.5 rounded-sm bg-sky-200 ring-1 ring-sky-500/70 dark:bg-sky-600/40 dark:ring-sky-400/50" /> US Holiday
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
                          {isHsl ? '< 7h (not needed) / out-of-range' : 'Weekend / out-of-range'}
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
                                  ? `Logged ≥ 7h on at least 5 of the 7 Mon–Sun days per week${forgivenDays > 0 ? ` (${forgivenDays} day${forgivenDays === 1 ? '' : 's'} forgiven)` : ''}. Sat and Sun each count independently. Overnight shifts spanning midnight are combined with the following day.`
                                  : paStatus === 'ineligible'
                                    ? 'HSL rule: every Mon–Sun week needs ≥ 5 of 7 days at ≥ 7h. Sat and Sun each count independently toward the quota. Overnight shifts (hours split across midnight) are combined for the threshold check.'
                                    : 'No week has failed the 5-of-7 rule yet — verdict locks when the period ends.'
                                : paStatus === 'eligible'
                                  ? `Logged ≥ 7h on every Mon–Fri in the PAB period${forgivenDays > 0 ? ` (${forgivenDays} day${forgivenDays === 1 ? '' : 's'} forgiven by issue)` : ''}.`
                                  : paStatus === 'ineligible'
                                    ? 'Every Mon–Fri in the PAB period must reach 7 h of logged time (or be forgiven via an approved issue).'
                                    : 'No past weekdays failed yet — verdict locks once the period ends or the first sub-7h weekday is logged.'}
                            </div>
                          </div>
                        </div>

                        {paStatus === 'ineligible' && failedDetails.length > 0 && (
                          <div className="mt-3 border-t border-red-300/40 pt-2.5 dark:border-red-800/40">
                            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-red-700 dark:text-red-300">
                              <span>Failed days ({failedDetails.length})</span>
                              <span className="font-normal normal-case text-red-500/70 dark:text-red-400/60">— click a day to forgive</span>
                            </div>
                            <div className="space-y-1">
                              {failedDetails.map((f, i) => {
                                const isExpanded = pabForgiveActiveIso === f.iso;
                                const isLoading = pabForgiveLoadingIso === f.iso;
                                return (
                                  <div key={f.iso}>
                                    <motion.div
                                      initial={{ opacity: 0, x: -4 }}
                                      animate={{ opacity: 1, x: 0 }}
                                      transition={{ delay: 0.2 + cells.length * 0.008 + i * 0.03, duration: 0.2 }}
                                      onClick={() => { setPabForgiveActiveIso(isExpanded ? null : f.iso); setPabForgiveError(null); }}
                                      className={cn(
                                        'flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1 text-[11px] transition-colors',
                                        isExpanded
                                          ? 'bg-indigo-50 ring-1 ring-indigo-300/60 dark:bg-indigo-950/40 dark:ring-indigo-700/50'
                                          : 'bg-white/60 hover:bg-white/90 dark:bg-zinc-950/40 dark:hover:bg-zinc-900/60',
                                      )}
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
                                        <span className={cn(
                                          'rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 transition-colors',
                                          isExpanded
                                            ? 'bg-indigo-100 text-indigo-700 ring-indigo-400/50 dark:bg-indigo-900/40 dark:text-indigo-300'
                                            : 'bg-amber-100 text-amber-800 ring-amber-400/40 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-300',
                                        )}>
                                          {isExpanded ? 'Cancel' : 'Forgive'}
                                        </span>
                                      </div>
                                    </motion.div>
                                    {isExpanded && (
                                      <motion.div
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: 'auto' }}
                                        exit={{ opacity: 0, height: 0 }}
                                        transition={{ duration: 0.18, ease: 'easeOut' }}
                                        className="mt-1 overflow-hidden rounded-md border border-amber-300/60 bg-amber-50/90 p-2.5 dark:border-amber-700/40 dark:bg-amber-950/30"
                                      >
                                        {pabForgiveError && (
                                          <div className="mb-2 rounded bg-red-100 px-2 py-1 text-[10px] text-red-700 dark:bg-red-900/40 dark:text-red-300">
                                            {pabForgiveError}
                                          </div>
                                        )}
                                        <div className="mb-1.5 text-[10px] text-amber-800 dark:text-amber-300">
                                          Forgive <span className="font-semibold">{f.date ? f.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : f.iso}</span> — accounting override. Day will count toward PAB.
                                        </div>
                                        <textarea
                                          value={pabForgiveNote}
                                          onChange={e => setPabForgiveNote(e.target.value)}
                                          placeholder="Note (optional) — e.g. Power outage confirmed"
                                          rows={2}
                                          className="w-full resize-none rounded border border-amber-300 bg-white px-2 py-1 text-[10px] text-zinc-800 placeholder-zinc-400 outline-none focus:ring-1 focus:ring-amber-400 dark:border-amber-700/50 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder-zinc-500"
                                        />
                                        <div className="mt-1.5 flex gap-1.5">
                                          <button
                                            disabled={isLoading}
                                            onClick={() => handleForgiveDay(f.iso, pabForgiveNote, f.seconds)}
                                            className="rounded bg-emerald-600 px-2.5 py-1 text-[10px] font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                                          >
                                            {isLoading ? 'Forgiving...' : 'Confirm Forgive'}
                                          </button>
                                          <button
                                            disabled={isLoading}
                                            onClick={() => { setPabForgiveActiveIso(null); setPabForgiveNote(''); setPabForgiveError(null); }}
                                            className="rounded px-2 py-1 text-[10px] font-semibold text-zinc-600 transition-colors hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800"
                                          >
                                            Cancel
                                          </button>
                                        </div>
                                      </motion.div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Forgiven Days — always shown when any days were forgiven by dispute */}
                        {forgivenDays > 0 && (() => {
                          const forgivenEntries = breakdown
                            .filter(b => b.forgivenByDispute)
                            .map(b => {
                              const d = parseColDate(b.col);
                              const iso = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : b.col;
                              return { date: d, iso, seconds: b.seconds };
                            })
                            .sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
                          return (
                            <div className="mt-3 border-t border-amber-300/40 pt-2.5 dark:border-amber-800/40">
                              <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                                <span>Forgiven days ({forgivenEntries.length})</span>
                                <span className="font-normal normal-case text-amber-500/70 dark:text-amber-500/60">— click to revoke</span>
                              </div>
                              {pabRevokeError && (
                                <div className="mb-2 rounded bg-red-100 px-2 py-1 text-[10px] text-red-700 dark:bg-red-900/40 dark:text-red-300">
                                  {pabRevokeError}
                                </div>
                              )}
                              <div className="space-y-1">
                                {forgivenEntries.map((f, i) => {
                                  const isExpanded = pabRevokeActiveIso === f.iso;
                                  const isLoading = pabRevokeLoadingIso === f.iso;
                                  return (
                                    <div key={f.iso}>
                                      <motion.div
                                        initial={{ opacity: 0, x: -4 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        transition={{ delay: 0.22 + i * 0.03, duration: 0.2 }}
                                        onClick={() => { setPabRevokeActiveIso(isExpanded ? null : f.iso); setPabRevokeError(null); }}
                                        className={cn(
                                          'flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1 text-[11px] transition-colors',
                                          isExpanded
                                            ? 'bg-red-50 ring-1 ring-red-300/60 dark:bg-red-950/40 dark:ring-red-700/50'
                                            : 'bg-white/60 hover:bg-white/90 dark:bg-zinc-950/40 dark:hover:bg-zinc-900/60',
                                        )}
                                      >
                                        <div className="flex items-center gap-1.5 min-w-0">
                                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                                          <span className="font-mono text-amber-800 dark:text-amber-300">
                                            {f.date ? f.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : f.iso}
                                          </span>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                          <span className="font-mono text-amber-700 dark:text-amber-400">{formatSeconds(f.seconds)}</span>
                                          <span className="text-[9px] text-amber-600 dark:text-amber-500">★ forgiven</span>
                                          <span className={cn(
                                            'rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 transition-colors',
                                            isExpanded
                                              ? 'bg-indigo-100 text-indigo-700 ring-indigo-400/50 dark:bg-indigo-900/40 dark:text-indigo-300'
                                              : 'bg-red-100 text-red-700 ring-red-400/40 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300',
                                          )}>
                                            {isExpanded ? 'Cancel' : 'Revoke'}
                                          </span>
                                        </div>
                                      </motion.div>
                                      {isExpanded && (
                                        <motion.div
                                          initial={{ opacity: 0, height: 0 }}
                                          animate={{ opacity: 1, height: 'auto' }}
                                          exit={{ opacity: 0, height: 0 }}
                                          transition={{ duration: 0.18, ease: 'easeOut' }}
                                          className="mt-1 overflow-hidden rounded-md border border-red-300/60 bg-red-50/90 p-2.5 dark:border-red-700/40 dark:bg-red-950/30"
                                        >
                                          <div className="mb-2 text-[10px] text-red-800 dark:text-red-300">
                                            Revoke forgiveness for <span className="font-semibold">{f.date ? f.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : f.iso}</span>. The day will return to failed and the issue will be marked revoked.
                                          </div>
                                          <div className="flex gap-1.5">
                                            <button
                                              disabled={isLoading}
                                              onClick={() => handleRevokeDay(f.iso)}
                                              className="rounded bg-red-600 px-2.5 py-1 text-[10px] font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                              {isLoading ? 'Revoking...' : 'Confirm Revoke'}
                                            </button>
                                            <button
                                              disabled={isLoading}
                                              onClick={() => { setPabRevokeActiveIso(null); setPabRevokeError(null); }}
                                              className="rounded px-2 py-1 text-[10px] font-semibold text-zinc-600 transition-colors hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800"
                                            >
                                              Cancel
                                            </button>
                                          </div>
                                        </motion.div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })()}
                      </motion.div>

                      {/* HSL Weekend Pay Premium summary — only for HSL employees */}
                      {isHsl && (
                        <motion.div
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.2 + cells.length * 0.008, duration: 0.3 }}
                          className="mt-3 rounded-xl border border-amber-300/60 bg-amber-50/80 p-3 dark:border-amber-800/50 dark:bg-amber-950/30"
                        >
                          <div className="flex items-start gap-2">
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500 text-xs font-bold text-white shadow-[0_0_0_3px_rgba(245,158,11,0.15)]">
                              ₱+
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-bold text-amber-800 dark:text-amber-200">
                                Weekend Pay Premium &mdash; Current Pay Week
                              </div>
                              {wkndPremiumTotal > 0 ? (
                                <div className="mt-0.5 text-[11px] leading-snug text-amber-700/90 dark:text-amber-300/80">
                                  <span className="font-semibold">{formatPHP(wkndPremiumTotal)}</span> applied (+₱15/h for Sat &amp; Sun hours) &mdash; already included in Initial Pay.
                                  {wkndPremiumData && wkndPremiumData.regPremiumPHP > 0 && wkndPremiumData.otPremiumPHP > 0 && (
                                    <span> Split: {formatPHP(wkndPremiumData.regPremiumPHP)} regular + {formatPHP(wkndPremiumData.otPremiumPHP)} OT.</span>
                                  )}
                                </div>
                              ) : (
                                <div className="mt-0.5 text-[11px] text-amber-700/70 dark:text-amber-400/70">
                                  No weekend hours logged this pay week &mdash; no premium applied.
                                </div>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      )}
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
