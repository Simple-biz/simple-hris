"use client";

import React, { useState, useRef, useEffect, useMemo } from 'react';
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
import type { EmployeeRow } from '@/lib/supabase/employees';
import { parseCsv } from '@/lib/csv/parse-csv';
import {
  indexHourlyRatesByEmail,
  type EmployeeHourlyRateRow,
} from '@/lib/supabase/employee-hourly-rates';
import { normEmail } from '@/lib/email/norm-email';
import { comparePayrollToMaster } from '@/lib/payroll/compare-to-master';
import { sha256Hex } from '@/lib/hash';
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
  const emailIdx = findHeaderColumn(header, 'Email');
  const totalIdx = findHeaderColumn(header, 'Total worked');
  if (emailIdx < 0 || totalIdx < 0) return [];
  const memberIdx = findHeaderColumn(header, 'Member');
  const parsedData: HubstaffRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const email = (row[emailIdx] ?? '').trim();
    if (!email) continue;
    const totalCell = row[totalIdx] ?? '';
    const member = memberIdx >= 0 ? (row[memberIdx] ?? '').trim() : '';
    parsedData.push({
      name: member || email,
      email,
      hours: String(totalCell).trim(),
      decimalHours: parseHoursToDecimal(totalCell),
    });
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
      if (!used.has(col)) {
        result.push({ key: col, label: col });
        if (result.length >= MAX_PREVIEW_COLS) break;
      }
    }
  }
  return result;
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

/** Known non-date Hubstaff column names (lowercase). */
const HUBSTAFF_NON_DATE_COLS = new Set([
  'member', 'email', 'total worked', 'activity', 'spent total',
  'organization', 'time zone', 'overtime',
]);

/**
 * Returns true when a Hubstaff column name represents a Mon–Fri workday.
 * Handles:
 *   • "Mon 7/1", "Tue 07/01", "Wed 7/1/2024"  (Hubstaff export format)
 *   • ISO "2024-07-01"
 *   • Full names "Monday 7/1" etc.
 */
function colIsWeekday(col: string): boolean {
  const s = col.trim();
  const lower = s.toLowerCase();
  // Skip known non-date cols
  for (const nd of HUBSTAFF_NON_DATE_COLS) {
    if (lower === nd || lower.startsWith(nd + ' ')) return false;
  }
  // "Mon …", "Tue …", "Wed …", "Thu …", "Fri …" → weekday
  if (/^(Mon|Tue|Wed|Thu|Fri)\b/i.test(s)) return true;
  // "Sat …" or "Sun …" → weekend
  if (/^(Sat|Sun)\b/i.test(s)) return false;
  // ISO date: "2024-07-01"
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const d = new Date(parseInt(iso[1]), parseInt(iso[2]) - 1, parseInt(iso[3]));
    if (!isNaN(d.getTime())) {
      const dow = d.getDay();
      return dow >= 1 && dow <= 5;
    }
  }
  return false;
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
        const collected = em(emp.email).collected ?? 0;
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

    // ── Lead Gen — disregarded per policy ─────────────────────────────────
    case 'lead_gen':
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
  const [hubstaffPreviewLoading, setHubstaffPreviewLoading] = useState(false);
  const [hubstaffPreviewError, setHubstaffPreviewError] = useState<string | null>(null);
  const [weeklyUploadLoading, setWeeklyUploadLoading] = useState(false);
  const [hubstaffPage, setHubstaffPage] = useState(1);
  const HUBSTAFF_PAGE_SIZE = 15;
  /** True while data exists in the table — locks the upload button until user explicitly unlocks. */
  const [hubstaffTableLocked, setHubstaffTableLocked] = useState(false);
  const [hubstaffSearch, setHubstaffSearch] = useState('');
  const [initialCalcSearch, setInitialCalcSearch] = useState('');
  /** After a successful weekly upload; blocks re-upload of identical file bytes. */
  const [lastSuccessfulWeeklyCsvHash, setLastSuccessfulWeeklyCsvHash] = useState<string | null>(null);
  const [duplicateCsvDialogOpen, setDuplicateCsvDialogOpen] = useState(false);
  const [approveUploadDialogOpen, setApproveUploadDialogOpen] = useState(false);
  const [pendingWeekly, setPendingWeekly] = useState<{
    text: string;
    fileName: string;
    hash: string;
  } | null>(null);

  const [hourlyRateRows, setHourlyRateRows] = useState<EmployeeHourlyRateRow[]>([]);
  const [hourlyRatesLoading, setHourlyRatesLoading] = useState(false);
  const [hourlyRatesError, setHourlyRatesError] = useState<string | null>(null);

  const [activeDeptTab, setActiveDeptTab] = useState('accounting');
  const [employeeDepts, setEmployeeDepts] = useState<Record<string, string>>({});
  const [employeeBonuses, setEmployeeBonuses] = useState<Record<string, Record<string, boolean>>>({});
  /** Per-employee numeric metrics: email → { metric → value }. Used by formula-based departments. */
  const [employeeMetrics, setEmployeeMetrics] = useState<Record<string, Record<string, number>>>({});
  /** Department-level numeric metrics: deptKey → { metric → value }. Used for pool calculations (QC, HR). */
  const [deptMetrics, setDeptMetrics] = useState<Record<string, Record<string, number>>>({});

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
    void loadEmployeeHourlyRates();
  }, [loadEmployeeHourlyRates]);

  const ratesByEmail = useMemo(
    () => indexHourlyRatesByEmail(hourlyRateRows),
    [hourlyRateRows],
  );

  /**
   * Computes which employees qualify for Perfect Attendance by scanning the
   * raw Hubstaff daily columns. An employee qualifies if every Mon–Fri column
   * in the dataset shows ≥ 7 hours (25 200 seconds).
   */
  const perfectAttendanceEligible = useMemo<Set<string>>(() => {
    if (!hubstaffDisplayColumns || !hubstaffDisplayRows || hubstaffDisplayRows.length === 0) {
      return new Set();
    }
    const weekdayCols = hubstaffDisplayColumns.filter(colIsWeekday);
    if (weekdayCols.length === 0) return new Set();

    const eligible = new Set<string>();
    for (const row of hubstaffDisplayRows) {
      const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
      const email = normEmail(rawEmail) ?? rawEmail.toLowerCase();
      if (!email) continue;

      let perfect = true;
      for (const col of weekdayCols) {
        if (rawValueToTotalSeconds(row[col]) < 7 * 3600) {
          perfect = false;
          break;
        }
      }
      if (perfect) eligible.add(email);
    }
    return eligible;
  }, [hubstaffDisplayColumns, hubstaffDisplayRows]);

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
   * Reg Pay = Reg Rate × min(Total Hrs, 40), OT Pay = OT Rate × OT Hrs, Initial Pay = sum.
   */
  const calcResults = useMemo<CalcRow[]>(() => {
    return hubstaffData.map((row) => {
      const totalH = row.decimalHours;
      const otHours = Math.max(0, totalH - 40);
      const regularHours = totalH - otHours;

      const em = normEmail(row.email);
      const rateRow = em ? ratesByEmail.get(em) : undefined;

      const regularRate = parseRateField(rateRow?.regular_rate);
      const otRate = parseRateField(rateRow?.ot_rate);

      const regularPay = regularRate != null ? regularRate * regularHours : null;
      const otPay = otHours > 0 ? (otRate != null ? otRate * otHours : null) : 0;
      const initialPay =
        regularPay != null && otPay != null ? regularPay + otPay : null;

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
  }, [hubstaffData, ratesByEmail]);

  const bonusTotals = useMemo(() => {
    const result: Record<string, number> = {};

    // Group assigned employees by department for formula-based dept calculations
    const deptEmployeeMap: Record<string, CalcRow[]> = {};
    for (const calcRow of calcResults) {
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
  }, [calcResults, employeeDepts, employeeBonuses, employeeMetrics, deptMetrics]);

  const filteredCalcResults = useMemo(() => {
    const needle = initialCalcSearch.toLowerCase().trim();
    if (!needle) return calcResults;
    return calcResults.filter((row) => {
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
  }, [calcResults, initialCalcSearch]);

  const loadHubstaffPreview = React.useCallback(async () => {
    setHubstaffPreviewLoading(true);
    setHubstaffPreviewError(null);
    try {
      const res = await fetch('/api/hubstaff-hours', { cache: 'no-store' });
      const json = (await res.json()) as {
        columns?: string[] | null;
        rows?: Record<string, unknown>[] | null;
        payrollRows?: Array<{
          email: string | null;
          name: string | null;
          hoursDisplay: string;
          hoursDecimal: number;
        }>;
        error?: string | null;
      };
      if (json.error) {
        setHubstaffPreviewError(json.error);
      }
      if (json.columns?.length && json.rows) {
        console.log('[hubstaff_hours] actual column names:', json.columns);
        setHubstaffDisplayColumns(json.columns);
        setHubstaffDisplayRows(json.rows);
        setHubstaffPage(1);
        setHubstaffSearch('');
        if (json.rows.length > 0) setHubstaffTableLocked(true);
      } else {
        setHubstaffDisplayColumns(null);
        setHubstaffDisplayRows(null);
        setHubstaffPage(1);
        setHubstaffSearch('');
        setHubstaffTableLocked(false);
      }
      if (json.payrollRows?.length) {
        const hd: HubstaffRow[] = json.payrollRows.map((p) => ({
          name: p.name ?? p.email ?? '',
          email: p.email ?? '',
          hours: p.hoursDisplay,
          decimalHours: p.hoursDecimal,
        }));
        setHubstaffData(hd);
        setIssues(buildReconciliationIssues(hd, users));
      }
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

  /**
   * Auto-populate employeeDepts from Supabase global_master_list whenever
   * calcResults or masterEmployees change. Existing manual assignments are
   * preserved — only unassigned employees are filled in.
   *
   * Chain: Hubstaff email → employee_hourly_rates (work_email) → personal_email
   *        → global_master_list (personal_email) → Department → dept key
   */
  useEffect(() => {
    if (calcResults.length === 0 || masterEmployees.length === 0) return;

    setEmployeeDepts(prev => {
      const next = { ...prev };
      let changed = false;

      for (const calcRow of calcResults) {
        if (next[calcRow.email]) continue; // keep manual assignments

        const em = normEmail(calcRow.email);
        const rateRow = em ? ratesByEmail.get(em) : undefined;

        // Try to find the master record via personal email from the rate row
        let deptRaw: string | null = null;
        if (rateRow?.personal_email) {
          const normPE = normEmail(rateRow.personal_email);
          const master = masterEmployees.find(
            e => normEmail(e.personal_email) === normPE,
          );
          deptRaw = master?.department ?? null;
        }

        // Fallback: match by name if personal email lookup failed
        if (!deptRaw && calcRow.name) {
          const nameLower = calcRow.name.trim().toLowerCase();
          const master = masterEmployees.find(
            e => (e.name ?? '').trim().toLowerCase() === nameLower,
          );
          deptRaw = master?.department ?? null;
        }

        const deptKey = normalizeDeptToKey(deptRaw);
        if (deptKey) {
          next[calcRow.email] = deptKey;
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [calcResults, masterEmployees, ratesByEmail]);

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
    const contentHash = await sha256Hex(buffer);

    if (lastSuccessfulWeeklyCsvHash !== null && contentHash === lastSuccessfulWeeklyCsvHash) {
      setDuplicateCsvDialogOpen(true);
      return;
    }

    const text = new TextDecoder('utf-8').decode(buffer);
    const rawGrid = parseCsv(text);
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
    const emailIdx = findHeaderColumn(header, 'Email');
    const totalIdx = findHeaderColumn(header, 'Total worked');
    if (emailIdx < 0 || totalIdx < 0) {
      toast.error('Not a Hubstaff weekly report', {
        description: 'Expected columns including Email and Total worked (Hubstaff export format).',
      });
      return;
    }

    setPendingWeekly({ text, fileName: file.name, hash: contentHash });
    setApproveUploadDialogOpen(true);
  };

  const confirmWeeklyUploadToDatabase = async () => {
    if (!pendingWeekly) return;
    setWeeklyUploadLoading(true);
    try {
      const form = new FormData();
      form.append('file', new Blob([pendingWeekly.text], { type: 'text/csv' }), pendingWeekly.fileName);

      const res = await fetch('/api/hubstaff-hours', { method: 'POST', body: form });
      const json = (await res.json()) as { success?: boolean; error?: string; rowCount?: number };

      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Upload failed');
      }

      setLastSuccessfulWeeklyCsvHash(pendingWeekly.hash);
      setPendingWeekly(null);
      setApproveUploadDialogOpen(false);
      setHubstaffTableLocked(true);

      await loadHubstaffPreview();

      toast.success('Saved to hubstaff_hours', {
        description: `${json.rowCount ?? 0} rows replaced in public.hubstaff_hours.`,
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
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-white">Upload Hubstaff weekly report</h3>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  Choose your Hubstaff export CSV (same columns as the daily report: Organization, Email, Total worked,
                  etc.). After you confirm, all rows are written to the{' '}
                  <span className="font-mono text-zinc-500">public.hubstaff_hours</span> table in Supabase (replacing
                  existing data). Requires <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span> in{' '}
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

                {hubstaffTableLocked ? (
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      <Lock className="h-3.5 w-3.5" />
                      Data locked
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5 border-amber-500/40 text-amber-700 hover:bg-amber-50 hover:text-amber-800 dark:border-amber-500/30 dark:text-amber-400 dark:hover:bg-amber-500/10"
                      onClick={() => setHubstaffTableLocked(false)}
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Replace data
                    </Button>
                  </div>
                ) : (
                  <>
                    <Button
                      type="button"
                      disabled={weeklyUploadLoading}
                      onClick={() => fileInputWeeklyRef.current?.click()}
                      className="gap-2 bg-indigo-600 text-white hover:bg-indigo-700"
                    >
                      {weeklyUploadLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Lock className="h-4 w-4" />
                      )}
                      Upload Hubstaff Weekly Report
                    </Button>
                    {hubstaffDisplayRows && hubstaffDisplayRows.length > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-xs text-zinc-400 hover:text-zinc-600"
                        onClick={() => setHubstaffTableLocked(true)}
                      >
                        Cancel
                      </Button>
                    )}
                  </>
                )}

                <input
                  type="file"
                  ref={fileInputWeeklyRef}
                  onChange={(ev) => void handleWeeklyFileChosen(ev)}
                  accept=".csv,text/csv"
                  className="hidden"
                />
              </div>
            </div>

            <Card className="border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-zinc-800 dark:text-zinc-200">Supabase target</CardTitle>
                <CardDescription className="text-xs text-zinc-600 dark:text-zinc-400">
                  Table <span className="font-mono">public.hubstaff_hours</span> — column order in the preview matches your
                  database (via <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span>).
                </CardDescription>
              </CardHeader>
            </Card>

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
                  <Lock className="h-6 w-6 text-zinc-500" />
                </div>
                <div>
                  <p className="font-medium text-zinc-700 dark:text-zinc-300">Upload Hubstaff weekly report CSV</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Same columns as your Hubstaff export (Organization, Email, Total worked, daily date columns, …)
                  </p>
                </div>
              </div>
            )}
          </div>
        );
      case 2:
        return (
          <div className="space-y-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-white">Initial Calculation</h3>
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

            {hourlyRatesError && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{hourlyRatesError}</span>
              </div>
            )}

            {calcResults.length === 0 ? (
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
                        {calcResults.length} rows
                      </>
                    ) : (
                      <>{calcResults.length} {calcResults.length === 1 ? 'row' : 'rows'}</>
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
                          Initial Pay
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
                          className="border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/30"
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
                            {row.regularRate != null ? formatPHP(row.regularRate) : '—'}
                          </TableCell>
                          <TableCell className="px-2 text-right align-middle font-mono text-xs tabular-nums text-zinc-700 dark:text-zinc-300">
                            {row.otRate != null ? formatPHP(row.otRate) : '—'}
                          </TableCell>
                          <TableCell className="px-2 text-right align-middle font-mono text-xs tabular-nums text-zinc-800 dark:text-zinc-200">
                            {row.regularPay != null ? formatPHP(row.regularPay) : '—'}
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
                          <TableCell className="px-2 text-right align-middle font-mono text-xs font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                            {row.initialPay != null ? formatPHP(row.initialPay) : '—'}
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
      case 3: {
        const activeDept = DEPARTMENTS.find(d => d.key === activeDeptTab) ?? DEPARTMENTS[0]!;
        const deptEmployees = calcResults.filter(r => employeeDepts[r.email] === activeDeptTab);
        const unassignedEmployees = calcResults.filter(r => !employeeDepts[r.email]);
        const totalBonusesAdded = Object.values(bonusTotals).reduce((sum, v) => sum + v, 0);
        const assignedEmployees = calcResults.filter(r => employeeDepts[r.email]);
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
          <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-white">
                  Additions — Department Bonuses
                </h3>
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

            {/* Department Tabs */}
            <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
              {DEPARTMENTS.map(dept => {
                const count = calcResults.filter(r => employeeDepts[r.email] === dept.key).length;
                return (
                  <button
                    key={dept.key}
                    type="button"
                    onClick={() => setActiveDeptTab(dept.key)}
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

            {/* Main layout */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              {/* Left column: Bonus config + Assign panel */}
              <div className="space-y-4 lg:col-span-1">
                {/* Common Bonuses */}
                <Card className="border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
                  <CardHeader className="pb-3 pt-4">
                    <CardTitle className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-indigo-100 dark:bg-indigo-950">
                        <DollarSign className="h-3 w-3 text-indigo-600 dark:text-indigo-400" />
                      </span>
                      Common Bonuses
                    </CardTitle>
                    <CardDescription className="text-xs text-zinc-500">
                      Available in all 12 departments
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 pb-4">
                    {COMMON_BONUSES.map(bonus => {
                      const allChecked =
                        deptEmployees.length > 0 &&
                        deptEmployees.every(e => employeeBonuses[e.email]?.[bonus.id]);
                      const isPerfectAttendance = bonus.id === 'perfect_attendance';
                      const eligibleCount = isPerfectAttendance
                        ? deptEmployees.filter(e =>
                            perfectAttendanceEligible.has(normEmail(e.email) ?? e.email.toLowerCase()),
                          ).length
                        : 0;
                      return (
                        <div key={bonus.id} className="space-y-1.5">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">
                                {bonus.label}
                              </div>
                              <div className="font-mono text-xs font-bold text-emerald-600 dark:text-emerald-400">
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
                                  : 'border-zinc-200 text-zinc-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-zinc-700 dark:text-zinc-400',
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
                          {isPerfectAttendance && deptEmployees.length > 0 && (
                            <div className="flex items-center gap-1.5 rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800/60">
                              <Check className={cn('h-3 w-3 shrink-0', eligibleCount > 0 ? 'text-emerald-500' : 'text-zinc-400')} />
                              <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
                                <span className={cn('font-bold', eligibleCount > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-500')}>
                                  {eligibleCount}/{deptEmployees.length}
                                </span>{' '}eligible (7 h+ every Mon–Fri)
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>

                {/* Dept-specific Bonus Panel — formula descriptions or toggle buttons */}
                {activeDeptTab === 'lead_gen' ? (
                  <Card className="border-amber-200/60 bg-amber-50/60 dark:border-amber-800/40 dark:bg-amber-950/20">
                    <CardHeader className="pb-3 pt-4">
                      <CardTitle className="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-200">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-amber-100 dark:bg-amber-900">
                          <AlertCircle className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                        </span>
                        Lead Gen — Disregarded
                      </CardTitle>
                      <CardDescription className="text-xs text-amber-600/80 dark:text-amber-400/80">
                        No department bonus formula applied to Lead Gen per policy.
                      </CardDescription>
                    </CardHeader>
                  </Card>
                ) : activeDeptTab === 'accounting' ? (
                  <Card className="border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <CardHeader className="pb-3 pt-4">
                      <CardTitle className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-violet-100 dark:bg-violet-950">
                          <Calculator className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                        </span>
                        Accounting — Tiered Bonus
                      </CardTitle>
                      <CardDescription className="text-xs text-zinc-500">Based on total collected per employee</CardDescription>
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
                  <Card className="border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
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
                  <Card className="border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
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
                  <Card className="border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
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
                  <Card className="border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
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
                  <Card className="border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
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
                  <Card className="border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
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
                  <Card className="border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
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
                  <Card className="border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
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
                  <Card className="border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
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
              <div className="lg:col-span-2">
                {deptEmployees.length === 0 ? (
                  <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-zinc-200 text-center dark:border-zinc-800">
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
                ) : (
                  <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
                    <div className="overflow-x-auto">
                      <Table className="w-full">
                        <TableHeader className="[&_th]:bg-zinc-100/95 dark:[&_th]:bg-zinc-900/95">
                          <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                            <TableHead className="min-w-[140px] px-3 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                              Employee
                            </TableHead>
                            <TableHead className="min-w-[100px] px-2 text-right text-xs font-medium text-zinc-600 dark:text-zinc-400">
                              Initial Pay
                            </TableHead>
                            {COMMON_BONUSES.map(b => (
                              <TableHead
                                key={b.id}
                                className="min-w-[90px] px-2 text-center text-[10px] font-medium leading-tight text-indigo-600 dark:text-indigo-400"
                              >
                                {b.label}<br />
                                <span className="font-mono font-bold">{formatPHP(b.amount)}</span>
                              </TableHead>
                            ))}
                            {/* Formula-based dept metric columns */}
                            {activeDeptTab === 'accounting' && (
                              <TableHead className="min-w-[90px] px-2 text-center text-[10px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                Collected<br /><span className="font-mono font-normal text-zinc-400">≥30→₱450 · 22–29→₱300 · 17–21→₱200</span>
                              </TableHead>
                            )}
                            {activeDeptTab === 'edit' && (
                              <TableHead className="min-w-[90px] px-2 text-center text-[10px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                Tickets<br /><span className="font-mono font-normal text-zinc-400">₱50 × tickets</span>
                              </TableHead>
                            )}
                            {activeDeptTab === 'devs' && (
                              <>
                                <TableHead className="min-w-[90px] px-2 text-center text-[10px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                  Tickets<br /><span className="font-mono font-normal text-zinc-400">₱50 × tickets</span>
                                </TableHead>
                                <TableHead className="min-w-[100px] px-2 text-center text-[10px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                  Sites<br /><span className="font-mono font-normal text-zinc-400">Delivery ₱50 · Checking ₱250</span>
                                </TableHead>
                              </>
                            )}
                            {activeDeptTab === 'callback' && (
                              <>
                                <TableHead className="min-w-[90px] px-2 text-center text-[10px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                  Callback Appts<br /><span className="font-mono font-normal text-zinc-400">₱50 × appts</span>
                                </TableHead>
                                <TableHead className="min-w-[100px] px-2 text-center text-[10px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                  Lead Gen Appts<br /><span className="font-mono font-normal text-zinc-400">1–9: ₱250 / 10+: ₱500</span>
                                </TableHead>
                              </>
                            )}
                            {activeDeptTab === 'qc' && (
                              <>
                                <TableHead className="min-w-[110px] px-2 text-center text-[10px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                  Role
                                </TableHead>
                                <TableHead className="min-w-[100px] px-2 text-center text-[10px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                  Callback Appts<br /><span className="font-mono font-normal text-zinc-400">Jerome only</span>
                                </TableHead>
                              </>
                            )}
                            {activeDeptTab === 'discovery' && (
                              <TableHead className="min-w-[90px] px-2 text-center text-[10px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                Units (Prior Wk)<br /><span className="font-mono font-normal text-zinc-400">₱25 × units</span>
                              </TableHead>
                            )}
                            {activeDeptTab === 'hr' && (
                              <TableHead className="min-w-[100px] px-2 text-center text-[10px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                HR Pool Share
                              </TableHead>
                            )}
                            {activeDeptTab === 'sales_assistant' && (
                              <TableHead className="min-w-[90px] px-2 text-center text-[10px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                Sales (Last Wk)<br /><span className="font-mono font-normal text-zinc-400">₱150 × sales</span>
                              </TableHead>
                            )}
                            {activeDeptTab === 'smart_staff' && (
                              <TableHead className="min-w-[100px] px-2 text-center text-[10px] font-medium leading-tight text-violet-600 dark:text-violet-400">
                                Appts Set<br /><span className="font-mono font-normal text-zinc-400">₱250 × appts</span>
                              </TableHead>
                            )}
                            {/* Toggle-based dept bonus columns */}
                            {!FORMULA_DEPT_KEYS.has(activeDeptTab) && activeDept.bonuses.map(b => (
                              <TableHead
                                key={b.id}
                                className="min-w-[90px] px-2 text-center text-[10px] font-medium leading-tight text-violet-600 dark:text-violet-400"
                              >
                                {b.label}<br />
                                <span className="font-mono font-bold">{formatPHP(b.amount)}</span>
                              </TableHead>
                            ))}
                            <TableHead className="min-w-[100px] px-2 text-right text-xs font-medium text-emerald-600 dark:text-emerald-400">
                              Bonus Total
                            </TableHead>
                            <TableHead className="min-w-[100px] px-2 text-right text-xs font-medium text-zinc-600 dark:text-zinc-400">
                              Final Pay
                            </TableHead>
                            <TableHead className="w-8 px-1" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {deptEmployees.map((emp, i) => {
                            const bonusTotal = bonusTotals[emp.email] ?? 0;
                            const finalPay = (emp.initialPay ?? 0) + bonusTotal;
                            const empM = employeeMetrics[emp.email] ?? {};
                            const isJerome = isJeromeRosero(emp.name);
                            return (
                              <TableRow
                                key={`${emp.email}-${i}`}
                                className="border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/30"
                              >
                                <TableCell className="px-3 py-2.5">
                                  <div className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">
                                    {emp.name || '—'}
                                  </div>
                                  <div className="truncate font-mono text-[10px] text-zinc-400">
                                    {emp.email}
                                  </div>
                                </TableCell>
                                <TableCell className="px-2 py-2.5 text-right font-mono text-xs text-zinc-700 dark:text-zinc-300">
                                  {emp.initialPay != null ? formatPHP(emp.initialPay) : '—'}
                                </TableCell>
                                {/* Common bonus toggles */}
                                {COMMON_BONUSES.map(bonus => {
                                  const isPA = bonus.id === 'perfect_attendance';
                                  const paEligible = isPA && perfectAttendanceEligible.has(
                                    normEmail(emp.email) ?? emp.email.toLowerCase(),
                                  );
                                  return (
                                    <TableCell key={bonus.id} className="px-2 py-2 text-center">
                                      <div className="flex flex-col items-center gap-0.5">
                                        <Switch
                                          checked={employeeBonuses[emp.email]?.[bonus.id] ?? false}
                                          onCheckedChange={v => toggleEmployeeBonus(emp.email, bonus.id, v)}
                                          className="data-[state=checked]:bg-indigo-600"
                                        />
                                        {isPA && (
                                          <span className={cn(
                                            'text-[9px] font-semibold leading-none',
                                            paEligible ? 'text-emerald-500' : 'text-zinc-400',
                                          )}>
                                            {paEligible ? '✓ Eligible' : '✗ Ineligible'}
                                          </span>
                                        )}
                                      </div>
                                    </TableCell>
                                  );
                                })}
                                {/* Accounting: collected input */}
                                {activeDeptTab === 'accounting' && (
                                  <TableCell className="px-2 py-2">
                                    <Input
                                      type="number" min={0}
                                      value={empM.collected ?? 0 ? (empM.collected ?? 0) : ''}
                                      placeholder="0"
                                      onChange={e => {
                                        const v = parseInt(e.target.value, 10);
                                        updateEmployeeMetric(emp.email, 'collected', Number.isFinite(v) && v >= 0 ? v : 0);
                                      }}
                                      className="h-7 w-16 border-violet-200 bg-white text-center font-mono text-xs dark:border-violet-800/50 dark:bg-zinc-900"
                                    />
                                  </TableCell>
                                )}
                                {/* Edit: tickets input */}
                                {activeDeptTab === 'edit' && (
                                  <TableCell className="px-2 py-2">
                                    <Input
                                      type="number" min={0}
                                      value={empM.tickets ?? 0 ? (empM.tickets ?? 0) : ''}
                                      placeholder="0"
                                      onChange={e => {
                                        const v = parseInt(e.target.value, 10);
                                        updateEmployeeMetric(emp.email, 'tickets', Number.isFinite(v) && v >= 0 ? v : 0);
                                      }}
                                      className="h-7 w-16 border-violet-200 bg-white text-center font-mono text-xs dark:border-violet-800/50 dark:bg-zinc-900"
                                    />
                                  </TableCell>
                                )}
                                {/* Devs: tickets + site delivery/checking */}
                                {activeDeptTab === 'devs' && (
                                  <>
                                    <TableCell className="px-2 py-2">
                                      <Input
                                        type="number" min={0}
                                        value={empM.tickets ?? 0 ? (empM.tickets ?? 0) : ''}
                                        placeholder="0"
                                        onChange={e => {
                                          const v = parseInt(e.target.value, 10);
                                          updateEmployeeMetric(emp.email, 'tickets', Number.isFinite(v) && v >= 0 ? v : 0);
                                        }}
                                        className="h-7 w-16 border-violet-200 bg-white text-center font-mono text-xs dark:border-violet-800/50 dark:bg-zinc-900"
                                      />
                                    </TableCell>
                                    <TableCell className="px-2 py-2">
                                      {isDevsDelivery(emp.name) ? (
                                        <div className="flex flex-col items-center gap-0.5">
                                          <Input
                                            type="number" min={0}
                                            value={empM.siteDelivery ?? 0 ? (empM.siteDelivery ?? 0) : ''}
                                            placeholder="0"
                                            onChange={e => {
                                              const v = parseInt(e.target.value, 10);
                                              updateEmployeeMetric(emp.email, 'siteDelivery', Number.isFinite(v) && v >= 0 ? v : 0);
                                            }}
                                            className="h-7 w-16 border-violet-200 bg-white text-center font-mono text-xs dark:border-violet-800/50 dark:bg-zinc-900"
                                          />
                                          <span className="text-[9px] text-violet-500">Delivery ₱50</span>
                                        </div>
                                      ) : isDevsChecking(emp.name) ? (
                                        <div className="flex flex-col items-center gap-0.5">
                                          <Input
                                            type="number" min={0}
                                            value={empM.siteChecking ?? 0 ? (empM.siteChecking ?? 0) : ''}
                                            placeholder="0"
                                            onChange={e => {
                                              const v = parseInt(e.target.value, 10);
                                              updateEmployeeMetric(emp.email, 'siteChecking', Number.isFinite(v) && v >= 0 ? v : 0);
                                            }}
                                            className="h-7 w-16 border-violet-200 bg-white text-center font-mono text-xs dark:border-violet-800/50 dark:bg-zinc-900"
                                          />
                                          <span className="text-[9px] text-violet-500">Checking ₱250</span>
                                        </div>
                                      ) : (
                                        <span className="block text-center text-xs text-zinc-400">—</span>
                                      )}
                                    </TableCell>
                                  </>
                                )}
                                {/* Callback: callback appts + lead gen appts */}
                                {activeDeptTab === 'callback' && (
                                  <>
                                    <TableCell className="px-2 py-2">
                                      <Input
                                        type="number" min={0}
                                        value={empM.callbackAppts ?? 0 ? (empM.callbackAppts ?? 0) : ''}
                                        placeholder="0"
                                        onChange={e => {
                                          const v = parseInt(e.target.value, 10);
                                          updateEmployeeMetric(emp.email, 'callbackAppts', Number.isFinite(v) && v >= 0 ? v : 0);
                                        }}
                                        className="h-7 w-16 border-violet-200 bg-white text-center font-mono text-xs dark:border-violet-800/50 dark:bg-zinc-900"
                                      />
                                    </TableCell>
                                    <TableCell className="px-2 py-2">
                                      <div className="flex flex-col items-center gap-0.5">
                                        <Input
                                          type="number" min={0}
                                          value={empM.leadGenAppts ?? 0 ? (empM.leadGenAppts ?? 0) : ''}
                                          placeholder="0"
                                          onChange={e => {
                                            const v = parseInt(e.target.value, 10);
                                            updateEmployeeMetric(emp.email, 'leadGenAppts', Number.isFinite(v) && v >= 0 ? v : 0);
                                          }}
                                          className="h-7 w-16 border-violet-200 bg-white text-center font-mono text-xs dark:border-violet-800/50 dark:bg-zinc-900"
                                        />
                                        {(empM.leadGenAppts ?? 0) > 0 && (
                                          <span className={cn(
                                            'text-[9px] font-bold',
                                            (empM.leadGenAppts ?? 0) >= 10 ? 'text-violet-600' : 'text-zinc-500',
                                          )}>
                                            ×{(empM.leadGenAppts ?? 0) >= 10 ? '₱500' : '₱250'}
                                          </span>
                                        )}
                                      </div>
                                    </TableCell>
                                  </>
                                )}
                                {/* QC: role badge + optional Jerome callback appts */}
                                {activeDeptTab === 'qc' && (
                                  <>
                                    <TableCell className="px-2 py-2 text-center">
                                      {isJerome ? (
                                        <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                                          Jerome · ₱30/unit
                                        </span>
                                      ) : (
                                        <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
                                          Pool ÷ {standardQcMembers.length}
                                          {qcPoolPerMember > 0 && (
                                            <span className="ml-1 font-mono font-bold text-emerald-600 dark:text-emerald-400">
                                              = {formatPHP(qcPoolPerMember)}
                                            </span>
                                          )}
                                        </span>
                                      )}
                                    </TableCell>
                                    <TableCell className="px-2 py-2">
                                      {isJerome ? (
                                        <Input
                                          type="number" min={0}
                                          value={empM.callbackAppts ?? 0 ? (empM.callbackAppts ?? 0) : ''}
                                          placeholder="0"
                                          onChange={e => {
                                            const v = parseInt(e.target.value, 10);
                                            updateEmployeeMetric(emp.email, 'callbackAppts', Number.isFinite(v) && v >= 0 ? v : 0);
                                          }}
                                          className="h-7 w-16 border-violet-200 bg-white text-center font-mono text-xs dark:border-violet-800/50 dark:bg-zinc-900"
                                        />
                                      ) : (
                                        <span className="block text-center text-xs text-zinc-400">—</span>
                                      )}
                                    </TableCell>
                                  </>
                                )}
                                {/* Discovery: units sold prior week */}
                                {activeDeptTab === 'discovery' && (
                                  <TableCell className="px-2 py-2">
                                    <Input
                                      type="number" min={0}
                                      value={empM.unitsSoldPriorWeek ?? 0 ? (empM.unitsSoldPriorWeek ?? 0) : ''}
                                      placeholder="0"
                                      onChange={e => {
                                        const v = parseInt(e.target.value, 10);
                                        updateEmployeeMetric(emp.email, 'unitsSoldPriorWeek', Number.isFinite(v) && v >= 0 ? v : 0);
                                      }}
                                      className="h-7 w-16 border-violet-200 bg-white text-center font-mono text-xs dark:border-violet-800/50 dark:bg-zinc-900"
                                    />
                                  </TableCell>
                                )}
                                {/* HR: show computed pool share */}
                                {activeDeptTab === 'hr' && (
                                  <TableCell className="px-2 py-2.5 text-center font-mono text-xs font-bold">
                                    {hrNewHires > 0 ? (
                                      <span className="text-violet-600 dark:text-violet-400">{formatPHP(hrPoolShare)}</span>
                                    ) : (
                                      <span className="text-zinc-400">— (enter new hires)</span>
                                    )}
                                  </TableCell>
                                )}
                                {/* Sales Assistant: sales last week */}
                                {activeDeptTab === 'sales_assistant' && (
                                  <TableCell className="px-2 py-2">
                                    <Input
                                      type="number" min={0}
                                      value={empM.salesLastWeek ?? 0 ? (empM.salesLastWeek ?? 0) : ''}
                                      placeholder="0"
                                      onChange={e => {
                                        const v = parseInt(e.target.value, 10);
                                        updateEmployeeMetric(emp.email, 'salesLastWeek', Number.isFinite(v) && v >= 0 ? v : 0);
                                      }}
                                      className="h-7 w-16 border-violet-200 bg-white text-center font-mono text-xs dark:border-violet-800/50 dark:bg-zinc-900"
                                    />
                                  </TableCell>
                                )}
                                {/* SmartStaff: appointments set */}
                                {activeDeptTab === 'smart_staff' && (
                                  <TableCell className="px-2 py-2">
                                    <Input
                                      type="number" min={0}
                                      value={empM.appointmentsSet ?? 0 ? (empM.appointmentsSet ?? 0) : ''}
                                      placeholder="0"
                                      onChange={e => {
                                        const v = parseInt(e.target.value, 10);
                                        updateEmployeeMetric(emp.email, 'appointmentsSet', Number.isFinite(v) && v >= 0 ? v : 0);
                                      }}
                                      className="h-7 w-16 border-violet-200 bg-white text-center font-mono text-xs dark:border-violet-800/50 dark:bg-zinc-900"
                                    />
                                  </TableCell>
                                )}
                                {/* Toggle-based dept bonus switches */}
                                {!FORMULA_DEPT_KEYS.has(activeDeptTab) && activeDept.bonuses.map(bonus => (
                                  <TableCell key={bonus.id} className="px-2 py-2.5 text-center">
                                    <Switch
                                      checked={employeeBonuses[emp.email]?.[bonus.id] ?? false}
                                      onCheckedChange={v => toggleEmployeeBonus(emp.email, bonus.id, v)}
                                      className="data-[state=checked]:bg-indigo-600"
                                    />
                                  </TableCell>
                                ))}
                                <TableCell className="px-2 py-2.5 text-right font-mono text-xs font-bold">
                                  {bonusTotal > 0 ? (
                                    <span className="text-emerald-600 dark:text-emerald-400">
                                      +{formatPHP(bonusTotal)}
                                    </span>
                                  ) : (
                                    <span className="text-zinc-400">—</span>
                                  )}
                                </TableCell>
                                <TableCell className="px-2 py-2.5 text-right font-mono text-xs font-semibold text-zinc-900 dark:text-white">
                                  {formatPHP(finalPay)}
                                </TableCell>
                                <TableCell className="px-1 py-2.5">
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
                    <div className="flex items-center justify-between border-t border-zinc-200 bg-zinc-50/80 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40">
                      <span className="text-xs text-zinc-500">
                        {deptEmployees.length} employee{deptEmployees.length !== 1 ? 's' : ''} in{' '}
                        {activeDept.name}
                      </span>
                      <div className="flex items-center gap-4">
                        <span className="text-xs text-zinc-500">
                          Dept Bonuses:{' '}
                          <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                            +{formatPHP(
                              deptEmployees.reduce((sum, e) => sum + (bonusTotals[e.email] ?? 0), 0),
                            )}
                          </span>
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
                )}
              </div>
            </div>
          </div>
        );
      }
      case 4: {
        const finalPayRows = calcResults
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
          <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-white">Pre-Flight Validation</h3>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">Final review before dispatching payments</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
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

            {/* Summary cards */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Card className="border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
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
              <Card className="border-emerald-200/60 bg-emerald-50/60 shadow-sm dark:border-emerald-800/30 dark:bg-emerald-950/20">
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
              <Card className="border-indigo-200/60 bg-indigo-50/60 shadow-sm dark:border-indigo-800/30 dark:bg-indigo-950/20">
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
            <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
              <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50/80 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40">
                <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Final Pay Breakdown</span>
                <span className="text-[10px] text-zinc-400">{finalPayRows.length} employees</span>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="[&_th]:bg-zinc-100/95 dark:[&_th]:bg-zinc-900/95">
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
                    {finalPayRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-10 text-center text-sm text-zinc-400">
                          No Hubstaff data. Complete Steps 1–3 first.
                        </TableCell>
                      </TableRow>
                    ) : (
                      finalPayRows.map((row, i) => (
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

            {/* Validation Checks */}
            <Card className="border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-zinc-900 dark:text-white">Validation Checks</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 pb-4">
                {[
                  { label: 'Hubstaff Hours Uploaded', pass: hubstaffData.length > 0 },
                  { label: 'Initial Calculations Complete', pass: calcResults.some(r => r.initialPay != null) },
                  { label: 'All Employees Dept-Assigned', pass: unassignedCount === 0 },
                  { label: 'Perfect Attendance Evaluated', pass: perfectAttendanceEligible.size > 0 || (hubstaffDisplayColumns?.some(colIsWeekday) === false) },
                  { label: 'Cycle Separation (Standard vs Hogan)', pass: true },
                ].map((check, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span className="text-zinc-500 dark:text-zinc-400">{check.label}</span>
                    <div className="flex items-center gap-2">
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
          <div className="flex flex-col items-center justify-center py-12 space-y-6 text-center">
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
            <div className="flex gap-4">
              <Button 
                variant="outline" 
                className="border-zinc-200 px-8 text-zinc-600 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:text-white"
                onClick={() => {
                  toast.info("Paystub preview generated", {
                    description: "Opening secure preview for Fran M...",
                  });
                }}
              >
                Preview Paystubs
              </Button>
              <Button 
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-12 font-bold"
                onClick={() => {
                  toast.success("Payroll Dispatched", {
                    description: "All payments initiated and paystubs sent.",
                  });
                  setCurrentStep(1);
                }}
              >
                Confirm & Dispatch
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
      <Dialog open={duplicateCsvDialogOpen} onOpenChange={setDuplicateCsvDialogOpen}>
        <DialogContent className="sm:max-w-md border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <DialogHeader>
            <DialogTitle className="text-zinc-900 dark:text-white">You are uploading the same CSV file</DialogTitle>
            <DialogDescription className="text-zinc-600 dark:text-zinc-400">
              This file matches your last successful Hubstaff weekly upload (same contents). Choose a different file or
              export a new report if you need to reload data.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end pt-2">
            <Button
              type="button"
              className="bg-indigo-600 text-white hover:bg-indigo-700"
              onClick={() => setDuplicateCsvDialogOpen(false)}
            >
              OK
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
              This replaces all rows in{' '}
              <span className="font-mono text-zinc-700 dark:text-zinc-300">public.hubstaff_hours</span> with the CSV you
              selected
              {pendingWeekly ? (
                <>
                  {' '}
                  (<span className="font-mono">{pendingWeekly.fileName}</span>).
                </>
              ) : (
                '.'
              )}{' '}
              Approve only if this is the correct week&apos;s export.
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
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
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
    </div>
  );
}
