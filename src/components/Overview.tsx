"use client";

import React, { useEffect, useMemo, useState } from 'react';
import {
  Users,
  DollarSign,
  Loader2,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FileText,
  Award,
  Laptop,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Eye,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { EmployeeRow } from '@/lib/supabase/employees';
import {
  indexHourlyRatesByEmail,
  type EmployeeHourlyRateRow,
} from '@/lib/supabase/employee-hourly-rates';
import type { PayrollHubstaffRow } from '@/lib/supabase/hubstaff-hours';
import { normEmail } from '@/lib/email/norm-email';
import { phpHourlyPayFromSeconds, splitRegularOvertimeSeconds } from '@/lib/payroll/money-php';
import {
  getPabMonthRange,
  inferPabMonthFromColumns,
  resolveCanonicalColumnsToIso,
  columnsAreAllCanonical,
  buildPabCalendarWeeks,
  pabDateKey,
  parseColDate,
  groupDateColumnsByCalendarDay,
} from '@/lib/hubstaff/calendar-column-dedupe';
import { fetchPabPeriodSettings, isDeptInPabScope, isValidManualPabRange } from '@/lib/pab-period-settings';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';

const PAGE_SIZE = 10;

/** Generates a page number array with ellipsis markers (represented as -1). */
function buildPageRange(current: number, total: number): (number | -1)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | -1)[] = [];
  const addPage = (n: number) => { if (!pages.includes(n)) pages.push(n); };
  const addEllipsis = () => { if (pages[pages.length - 1] !== -1) pages.push(-1); };

  addPage(1);
  if (current > 3) addEllipsis();
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) addPage(i);
  if (current < total - 2) addEllipsis();
  addPage(total);
  return pages;
}

function formatStartDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Match payroll emails to master rows (personal or work email). */
function buildMasterEmailSet(list: EmployeeRow[]): Set<string> {
  const s = new Set<string>();
  for (const e of list) {
    const p = normEmail(e.personal_email);
    const w = normEmail(e.work_email ?? null);
    if (p) s.add(p);
    if (w) s.add(w);
  }
  return s;
}

/** Merge Member / Job type from Hubstaff rows per normalized email (current payroll scope). */
function mergePayrollIdentity(rows: PayrollHubstaffRow[]): Record<string, { name: string | null; department: string | null }> {
  const acc: Record<string, { name: string | null; department: string | null }> = {};
  for (const row of rows) {
    const em = normEmail(row.email);
    if (!em) continue;
    const cur = acc[em];
    const name = row.name?.trim() || cur?.name || null;
    const department = row.department?.trim() || cur?.department || null;
    acc[em] = { name, department };
  }
  return acc;
}

type OverviewEmployeeRow = EmployeeRow & { recordSource: 'master' | 'hubstaff' };

interface OverviewProps {
  onViewRates?: (email: string) => void;
}

export default function Overview({ onViewRates }: OverviewProps = {}) {
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [employeesError, setEmployeesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState<string>('');
  const [page, setPage] = useState(1);
  const [totalPayout, setTotalPayout] = useState<number | null>(null);
  const [payoutLoading, setPayoutLoading] = useState(true);
  const [payrollEmailsNorm, setPayrollEmailsNorm] = useState<Set<string> | null>(null);
  const [payrollWorkerCount, setPayrollWorkerCount] = useState<number | null>(null);
  /** All available source files from the API. */
  const [sourceFiles, setSourceFiles] = useState<string[]>([]);
  /** Currently selected source file: null = latest (default), '__all__' = all time, or a specific filename. */
  const [selectedSourceFile, setSelectedSourceFile] = useState<string | null>(null);
  /** The actual file being displayed (resolved from selection). */
  const [activeSourceFile, setActiveSourceFile] = useState<string | null>(null);
  /** Name / department from Hubstaff rows for the selected payroll scope (for employees not on master list). */
  const [payrollIdentityByEmail, setPayrollIdentityByEmail] = useState<Record<
    string,
    { name: string | null; department: string | null }
  > | null>(null);

  /**
   * Tech Bonus eligibility: employees who have completed 30 days of service
   * from their start_date (as of today). This is the standing eligibility —
   * the bonus is paid on the 3rd paycheck of each month.
   */
  const techBonusEligibility = useMemo(() => {
    const today = new Date();
    const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    let eligible = 0;
    let pending = 0;
    let unknown = 0;
    for (const e of employees) {
      if (!e.start_date) {
        unknown += 1;
        continue;
      }
      const sd = new Date(e.start_date);
      if (isNaN(sd.getTime())) {
        unknown += 1;
        continue;
      }
      const eligibleFrom = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate() + 30).getTime();
      if (todayMid >= eligibleFrom) eligible += 1;
      else pending += 1;
    }
    return { eligible, pending, unknown, total: employees.length };
  }, [employees]);

  /** PAB metrics — computed from all source files. */
  const [pabMetrics, setPabMetrics] = useState<{
    loading: boolean;
    totalEmployees: number;
    eligible: number;
    notEligible: number;
    monthLabel: string | null;
  }>({ loading: true, totalEmployees: 0, eligible: 0, notEligible: 0, monthLabel: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/employees', { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as {
          employees: EmployeeRow[];
          error: string | null;
        };
        if (!cancelled) {
          setEmployees(json.employees ?? []);
          setEmployeesError(json.error ?? null);
        }
      } catch (e) {
        if (!cancelled) {
          setEmployees([]);
          setEmployeesError(e instanceof Error ? e.message : 'Failed to load employees');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load source file list once on mount, default to latest
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/hubstaff-hours?source_files=1', { cache: 'no-store' });
        const json = (await res.json()) as { files?: string[]; error?: string | null };
        if (cancelled) return;
        const files = json.files ?? [];
        setSourceFiles(files);
        // Default to latest file
        if (files.length > 0) {
          setSelectedSourceFile(files[files.length - 1]);
        }
      } catch {
        /* no source files — will fall back to full fetch */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Compute stats whenever the selected file changes
  useEffect(() => {
    // Wait for initial source file list to load (selectedSourceFile starts null)
    if (selectedSourceFile === null && sourceFiles.length === 0) {
      // First mount, source files not loaded yet — the above effect will set selectedSourceFile
    }
    let cancelled = false;
    setPayoutLoading(true);
    (async () => {
      try {
        const isAllTime = selectedSourceFile === '__all__';

        // Build fetch URLs
        let hoursUrls: string[];
        let displayFile: string | null;
        if (isAllTime) {
          // Fetch every source file individually and sum
          hoursUrls = sourceFiles.map(f => `/api/hubstaff-hours?source_file=${encodeURIComponent(f)}`);
          displayFile = null;
        } else if (selectedSourceFile) {
          hoursUrls = [`/api/hubstaff-hours?source_file=${encodeURIComponent(selectedSourceFile)}`];
          displayFile = selectedSourceFile;
        } else {
          hoursUrls = ['/api/hubstaff-hours'];
          displayFile = null;
        }
        setActiveSourceFile(displayFile);

        const ratesRes = await fetch('/api/employee-hourly-rates', { cache: 'no-store' });
        const ratesJson = (await ratesRes.json()) as { rows: EmployeeHourlyRateRow[] };
        const ratesByEmail = indexHourlyRatesByEmail(ratesJson.rows ?? []);

        // Accumulate payroll rows across all fetched files
        const allPayrollRows: PayrollHubstaffRow[] = [];
        for (const url of hoursUrls) {
          const res = await fetch(url, { cache: 'no-store' });
          const json = (await res.json()) as {
            payrollRows?: PayrollHubstaffRow[] | null;
            error?: string | null;
          };
          if (cancelled) return;
          if (res.ok && !json.error && json.payrollRows) {
            allPayrollRows.push(...json.payrollRows);
          }
        }

        if (cancelled) return;

        // For All Time, aggregate hours per employee then compute pay
        const paySet = new Set<string>();
        let sum = 0;
        let hasAnyPay = false;

        if (isAllTime) {
          // Sum hours per employee across all files, split regular/OT per file
          const perEmployee = new Map<string, { regularSec: number; otSec: number }>();
          for (const row of allPayrollRows) {
            const em = normEmail(row.email);
            if (!em) continue;
            paySet.add(em);
            const { regularSec, otSec } = splitRegularOvertimeSeconds(row.hoursDecimal);
            const existing = perEmployee.get(em) ?? { regularSec: 0, otSec: 0 };
            existing.regularSec += regularSec;
            existing.otSec += otSec;
            perEmployee.set(em, existing);
          }
          for (const [em, { regularSec, otSec }] of perEmployee) {
            const rateRow = ratesByEmail.get(em);
            const parseRate = (v: string | null | undefined): number | null => {
              if (v == null) return null;
              const n = parseFloat(String(v).trim().replace(/,/g, ''));
              return Number.isFinite(n) ? n : null;
            };
            const regularRate = parseRate(rateRow?.regular_rate);
            const otRate = parseRate(rateRow?.ot_rate);
            const regularPay = regularRate != null ? phpHourlyPayFromSeconds(regularRate, regularSec) : null;
            const otPay = otSec > 0 ? (otRate != null ? phpHourlyPayFromSeconds(otRate, otSec) : null) : 0;
            const initialPay = regularPay != null && otPay != null ? Math.round((regularPay + otPay) * 100) / 100 : null;
            if (initialPay != null) { sum += initialPay; hasAnyPay = true; }
          }
        } else {
          for (const row of allPayrollRows) {
            const em = normEmail(row.email);
            if (em) paySet.add(em);
            const { regularSec, otSec } = splitRegularOvertimeSeconds(row.hoursDecimal);
            const rateRow = em ? ratesByEmail.get(em) : undefined;
            const parseRate = (v: string | null | undefined): number | null => {
              if (v == null) return null;
              const n = parseFloat(String(v).trim().replace(/,/g, ''));
              return Number.isFinite(n) ? n : null;
            };
            const regularRate = parseRate(rateRow?.regular_rate);
            const otRate = parseRate(rateRow?.ot_rate);
            const regularPay = regularRate != null ? phpHourlyPayFromSeconds(regularRate, regularSec) : null;
            const otPay = otSec > 0 ? (otRate != null ? phpHourlyPayFromSeconds(otRate, otSec) : null) : 0;
            const initialPay = regularPay != null && otPay != null ? Math.round((regularPay + otPay) * 100) / 100 : null;
            if (initialPay != null) { sum += initialPay; hasAnyPay = true; }
          }
        }

        if (!cancelled) {
          setPayrollEmailsNorm(paySet.size > 0 ? paySet : null);
          setPayrollWorkerCount(paySet.size > 0 ? paySet.size : null);
          setTotalPayout(hasAnyPay ? sum : null);
          setPayrollIdentityByEmail(mergePayrollIdentity(allPayrollRows));
        }
      } catch {
        if (!cancelled) {
          setTotalPayout(null);
          setPayrollEmailsNorm(null);
          setPayrollWorkerCount(null);
          setActiveSourceFile(null);
          setPayrollIdentityByEmail(null);
        }
      } finally {
        if (!cancelled) setPayoutLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedSourceFile, sourceFiles]);

  // Compute PAB eligibility across all source files (full month merge)
  useEffect(() => {
    if (sourceFiles.length === 0) return;
    let cancelled = false;
    setPabMetrics(prev => ({ ...prev, loading: true }));
    (async () => {
      try {
        const allCols = new Set<string>();
        const rowsByEmail = new Map<string, Record<string, unknown>>();

        for (const file of sourceFiles) {
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

          for (const row of json.rows) {
            const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
            const email = normEmail(rawEmail) ?? rawEmail.toLowerCase();
            if (!email) continue;

            const needsResolve = columnsAreAllCanonical(json.columns);
            const resolved = needsResolve ? resolveCanonicalColumnsToIso(row, file) : row;
            for (const col of (needsResolve ? Object.keys(resolved) : json.columns)) allCols.add(col);

            const existing = rowsByEmail.get(email) ?? {};
            rowsByEmail.set(email, { ...existing, ...resolved });
          }
        }

        if (cancelled) return;

        const cols = [...allCols];
        const pabCfg = await fetchPabPeriodSettings();

        const emailToDeptKey = new Map<string, string | null>();
        for (const e of employees) {
          const dk = normalizeDeptToKey(e.department);
          const we = normEmail(e.work_email ?? null);
          const pe = normEmail(e.personal_email ?? null);
          if (we) emailToDeptKey.set(we, dk);
          if (pe) emailToDeptKey.set(pe, dk);
        }

        let start: Date;
        let end: Date;
        let monthLabel: string;

        if (isValidManualPabRange(pabCfg)) {
          start = pabCfg.start;
          end = pabCfg.end;
          monthLabel = `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        } else {
          const pabMonth = inferPabMonthFromColumns(cols);
          if (!pabMonth) {
            setPabMetrics({ loading: false, totalEmployees: rowsByEmail.size, eligible: 0, notEligible: rowsByEmail.size, monthLabel: null });
            return;
          }
          const r = getPabMonthRange(pabMonth.year, pabMonth.month);
          start = r.start;
          end = r.end;
          const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          monthLabel = `${monthNames[pabMonth.month]} ${pabMonth.year}`;
        }

        let eligible = 0;
        let notEligible = 0;
        let evaluated = 0;

        for (const [email, mergedRow] of rowsByEmail) {
          if (!isDeptInPabScope(emailToDeptKey.get(email) ?? null, pabCfg.scopeDepartmentKeys)) continue;
          evaluated++;
          // Build date → seconds lookup
          const hoursByDateKey = new Map<string, number>();
          const isDateCol = (c: string): boolean => parseColDate(c) !== null;
          const dateCols = Object.keys(mergedRow).filter(isDateCol);
          const groups = groupDateColumnsByCalendarDay(dateCols, cols);
          for (const group of groups) {
            let d: Date | null = null;
            for (const c of group) { d = parseColDate(c); if (d) break; }
            if (!d) continue;
            let maxS = 0;
            for (const c of group) {
              const v = mergedRow[c];
              if (v == null) continue;
              const s = String(v).trim();
              if (!s) continue;
              const hms = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
              if (hms) { maxS = Math.max(maxS, +hms[1] * 3600 + +hms[2] * 60 + +hms[3]); continue; }
              const dec = parseFloat(s);
              if (Number.isFinite(dec)) maxS = Math.max(maxS, Math.round(dec * 3600));
            }
            hoursByDateKey.set(pabDateKey(d), Math.max(hoursByDateKey.get(pabDateKey(d)) ?? 0, maxS));
          }

          const weeks = buildPabCalendarWeeks(start, end, hoursByDateKey);
          const allDays = weeks.flat();
          if (allDays.length > 0 && allDays.every(d => d.passes)) {
            eligible++;
          } else {
            notEligible++;
          }
        }

        if (!cancelled) {
          setPabMetrics({
            loading: false,
            totalEmployees: evaluated,
            eligible,
            notEligible,
            monthLabel,
          });
        }
      } catch {
        if (!cancelled) setPabMetrics({ loading: false, totalEmployees: 0, eligible: 0, notEligible: 0, monthLabel: null });
      }
    })();
    return () => { cancelled = true; };
  }, [sourceFiles, employees]);

  /** Master list rows plus Hubstaff-only workers (same payroll scope as stats). */
  const mergedEmployees = useMemo((): OverviewEmployeeRow[] => {
    const masterRows: OverviewEmployeeRow[] = employees.map((e) => ({
      ...e,
      recordSource: 'master',
    }));
    const masterSet = buildMasterEmailSet(employees);
    const idMap = payrollIdentityByEmail ?? {};
    const extras: OverviewEmployeeRow[] = [];
    for (const [em, id] of Object.entries(idMap)) {
      if (!masterSet.has(em)) {
        extras.push({
          employee_id: null,
          department: id.department,
          name: id.name,
          personal_email: em,
          work_email: em,
          start_date: null,
          recordSource: 'hubstaff',
        });
      }
    }
    const combined = [...masterRows, ...extras];
    combined.sort((a, b) => {
      const an = (a.name ?? a.personal_email ?? '').toLowerCase();
      const bn = (b.name ?? b.personal_email ?? '').toLowerCase();
      return an.localeCompare(bn, undefined, { sensitivity: 'base' });
    });
    return combined;
  }, [employees, payrollIdentityByEmail]);

  const departmentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of mergedEmployees) {
      const d = e.department?.trim();
      if (d) set.add(d);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [mergedEmployees]);

  const filteredEmployees = useMemo(() => {
    let list = mergedEmployees;
    if (departmentFilter) {
      list = list.filter((e) => (e.department ?? '').trim() === departmentFilter);
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((e) => {
        const parts = [e.department, e.name, e.personal_email, e.work_email, e.start_date].map((v) =>
          (v ?? '').toLowerCase(),
        );
        return parts.some((p) => p.includes(q));
      });
    }
    return list;
  }, [mergedEmployees, departmentFilter, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredEmployees.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, departmentFilter]);

  useEffect(() => {
    setPage((p) => Math.min(p, totalPages));
  }, [totalPages]);

  const pageRows = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredEmployees.slice(start, start + PAGE_SIZE);
  }, [filteredEmployees, safePage]);

  const { inPayrollNotMaster, inMasterNotPayroll } = useMemo(() => {
    const masterSet = buildMasterEmailSet(employees);
    if (payrollEmailsNorm === null) {
      return { inPayrollNotMaster: null as number | null, inMasterNotPayroll: null as number | null };
    }
    let inPayrollNotMasterCount = 0;
    for (const em of payrollEmailsNorm) {
      if (!masterSet.has(em)) inPayrollNotMasterCount++;
    }
    let inMasterNotPayrollCount = 0;
    for (const em of masterSet) {
      if (!payrollEmailsNorm.has(em)) inMasterNotPayrollCount++;
    }
    return {
      inPayrollNotMaster: inPayrollNotMasterCount,
      inMasterNotPayroll: inMasterNotPayrollCount,
    };
  }, [employees, payrollEmailsNorm]);

  const stats = [
    {
      label: 'Total Payout',
      value: payoutLoading
        ? '…'
        : totalPayout != null
          ? '₱' + totalPayout.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : '—',
      icon: DollarSign,
    },
    {
      label: 'Active Workers',
      value: payoutLoading ? '…' : payrollWorkerCount != null ? String(payrollWorkerCount) : '—',
      icon: Users,
    },
    {
      label: 'Employees in Payroll but not in Master list',
      value:
        employeesError
          ? '—'
          : loading || payoutLoading
            ? '…'
            : inPayrollNotMaster == null
              ? '—'
              : String(inPayrollNotMaster),
      icon: DollarSign,
    },
    {
      label: 'Employees in Masterlist but not in Payroll',
      value:
        employeesError
          ? '—'
          : loading || payoutLoading
            ? '…'
            : inMasterNotPayroll == null
              ? '—'
              : String(inMasterNotPayroll),
      icon: Users,
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-5 dark:bg-none dark:bg-[#0d1117]">
      <div className="flex shrink-0 items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">System Overview</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-500">Real-time HRIS and Payroll analytics</p>
        </div>
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-orange-500" />
          <select
            value={selectedSourceFile ?? ''}
            onChange={(e) => setSelectedSourceFile(e.target.value || null)}
            className="h-8 max-w-[min(100%,340px)] truncate rounded-md border border-zinc-200 bg-white px-2 pr-7 font-mono text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            <option value="__all__">All Time (all uploads combined)</option>
            {[...sourceFiles].reverse().map((file, i) => (
              <option key={file} value={file}>
                {file}{i === 0 ? ' (latest)' : ''}
              </option>
            ))}
          </select>
          {payoutLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-500" />}
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat, i) => (
          <Card
            key={i}
            className="border-orange-100/80 bg-gradient-to-br from-white to-orange-50/30 shadow-sm transition-colors duration-300 hover:to-orange-50/60 dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/10 dark:hover:from-blue-950/30"
          >
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-zinc-600 dark:text-zinc-400">{stat.label}</CardTitle>
              <stat.icon className="h-4 w-4 text-zinc-500" />
            </CardHeader>
            <CardContent>
              <div className="font-mono text-2xl font-bold text-zinc-900 dark:text-white">{stat.value}</div>
              <p className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-600">
                {(() => {
                  const isAll = selectedSourceFile === '__all__';
                  const src = activeSourceFile
                    ? activeSourceFile
                    : isAll ? 'all uploads combined' : 'latest Hubstaff data';
                  if (stat.label === 'Total Payout') return `Sum of initial pay · ${src}`;
                  if (stat.label === 'Active Workers') return `Distinct work emails · ${src}`;
                  if (stat.label === 'Employees in Payroll but not in Master list')
                    return `Emails in ${isAll ? 'all payroll files' : src} not in global_master_list`;
                  if (stat.label === 'Employees in Masterlist but not in Payroll')
                    return `Emails in global_master_list not in ${isAll ? 'any payroll file' : src}`;
                  return '';
                })()}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-3">
        <Card className="flex min-h-0 flex-col overflow-hidden border-orange-100/80 bg-gradient-to-br from-white to-blue-50/20 shadow-sm dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/5 lg:col-span-2">
          <CardHeader className="shrink-0 flex flex-row items-center justify-between gap-4 pb-2">
            <CardTitle className="text-lg font-semibold text-zinc-900 dark:text-white">Employees</CardTitle>
            <Badge variant="outline" className="border-blue-500/20 bg-blue-500/10 font-mono text-[10px] text-blue-700 dark:border-blue-500/30 dark:text-blue-400">
              master + Hubstaff fallback
            </Badge>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500 dark:text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading employees…
              </div>
            ) : employeesError && mergedEmployees.length === 0 ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200/90">
                {employeesError}
              </p>
            ) : mergedEmployees.length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-500">
                No employees to show. Load <code className="font-mono text-xs text-zinc-800 dark:text-zinc-400">global_master_list</code> via{' '}
                <code className="font-mono text-xs text-zinc-800 dark:text-zinc-400">NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE</code> and/or upload Hubstaff hours
                so payroll can list workers.
              </p>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
                {employeesError && mergedEmployees.length > 0 && (
                  <p className="shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200/90">
                    Master list could not be loaded ({employeesError}). Showing Hubstaff-derived rows where available.
                  </p>
                )}
                {employees.length === 0 && mergedEmployees.some((r) => r.recordSource === 'hubstaff') && (
                  <p className="shrink-0 rounded-lg border border-sky-200/80 bg-sky-50/80 px-3 py-2 text-xs text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-200">
                    No <span className="font-mono">global_master_list</span> rows loaded — showing names and departments from the selected Hubstaff payroll
                    export only. Add master records to fill IDs and start dates.
                  </p>
                )}
                {/* Filters */}
                <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-end">
                  <div className="flex-1 space-y-1.5">
                    <Label htmlFor="employee-search" className="text-xs text-zinc-600 dark:text-zinc-500">
                      Search
                    </Label>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
                      <Input
                        id="employee-search"
                        placeholder="Name, email, department, date…"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="h-9 border-zinc-200 bg-white pl-9 text-zinc-900 placeholder:text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-200 dark:placeholder:text-zinc-600"
                      />
                    </div>
                  </div>
                  <div className="w-full space-y-1.5 sm:w-48">
                    <Label htmlFor="department-filter" className="text-xs text-zinc-600 dark:text-zinc-500">
                      Department
                    </Label>
                    <select
                      id="department-filter"
                      value={departmentFilter}
                      onChange={(e) => setDepartmentFilter(e.target.value)}
                      className={cn(
                        'h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900',
                        'outline-none focus-visible:border-orange-500 focus-visible:ring-2 focus-visible:ring-orange-500/30',
                        'dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-200',
                      )}
                    >
                      <option value="">All departments</option>
                      {departmentOptions.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Table */}
                <div className="min-h-0 flex-1 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-gradient-to-r from-orange-50/95 to-blue-50/60 backdrop-blur-sm dark:from-blue-950/90 dark:to-blue-950/70">
                      <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                        <TableHead className="text-zinc-600 dark:text-zinc-400">Employee ID</TableHead>
                        <TableHead className="text-zinc-600 dark:text-zinc-400">Source</TableHead>
                        <TableHead className="text-zinc-600 dark:text-zinc-400">Department</TableHead>
                        <TableHead className="text-zinc-600 dark:text-zinc-400">Name</TableHead>
                        <TableHead className="text-zinc-600 dark:text-zinc-400">Email</TableHead>
                        <TableHead className="text-right text-zinc-600 dark:text-zinc-400">Start Date</TableHead>
                        <TableHead className="w-[90px] text-right text-zinc-600 dark:text-zinc-400">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pageRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="py-8 text-center text-zinc-600 dark:text-zinc-500">
                            No employees match your search or filter.
                          </TableCell>
                        </TableRow>
                      ) : (
                        pageRows.map((row, i) => (
                          <TableRow
                            key={`${row.recordSource}-${row.personal_email ?? ''}-${row.name ?? ''}-${(safePage - 1) * PAGE_SIZE + i}`}
                            className="border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/30"
                          >
                            <TableCell>
                              {row.employee_id ? (
                                <span className="inline-flex items-center rounded-md border border-orange-200 bg-orange-50 px-2 py-0.5 font-mono text-xs font-semibold text-orange-700 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-400">
                                  {row.employee_id}
                                </span>
                              ) : (
                                <span className="text-xs text-zinc-400 dark:text-zinc-600">—</span>
                              )}
                            </TableCell>
                            <TableCell>
                              {row.recordSource === 'hubstaff' ? (
                                <Badge
                                  variant="outline"
                                  className="border-sky-300 bg-sky-50 font-mono text-[10px] text-sky-800 dark:border-sky-800/60 dark:bg-sky-950/40 dark:text-sky-300"
                                >
                                  Hubstaff
                                </Badge>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="border-emerald-300 bg-emerald-50 font-mono text-[10px] text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300"
                                >
                                  Master
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-zinc-800 dark:text-zinc-200">{row.department ?? '—'}</TableCell>
                            <TableCell className="font-medium text-zinc-800 dark:text-zinc-200">{row.name ?? '—'}</TableCell>
                            <TableCell className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
                              {row.personal_email ?? row.work_email ?? '—'}
                            </TableCell>
                            <TableCell className="text-right text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                              {formatStartDate(row.start_date)}
                            </TableCell>
                            <TableCell className="text-right">
                              {(() => {
                                const email = row.work_email ?? row.personal_email ?? '';
                                const disabled = !email || !onViewRates;
                                return (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={disabled}
                                    onClick={() => email && onViewRates?.(email)}
                                    className="h-7 border-orange-300 px-2 text-[11px] text-orange-700 hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-orange-700 dark:text-orange-400"
                                  >
                                    <Eye className="mr-1 h-3 w-3" />
                                    View
                                  </Button>
                                );
                              })()}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>

                {/* Pagination */}
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 pt-1">
                  <p className="text-xs text-zinc-500 dark:text-zinc-500">
                    {filteredEmployees.length === 0 ? (
                      'No results'
                    ) : (
                      <>
                        <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">
                          {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filteredEmployees.length)}
                        </span>
                        {' of '}
                        <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">
                          {filteredEmployees.length}
                        </span>
                        {filteredEmployees.length !== mergedEmployees.length && (
                          <span className="text-zinc-400 dark:text-zinc-600"> (filtered)</span>
                        )}
                      </>
                    )}
                  </p>

                  <div className="flex items-center gap-1">
                    {/* First page */}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 w-8 border-zinc-200 p-0 text-zinc-600 disabled:opacity-30 dark:border-zinc-800 dark:text-zinc-400"
                      disabled={safePage <= 1}
                      onClick={() => setPage(1)}
                      aria-label="First page"
                    >
                      <ChevronsLeft className="size-3.5" />
                    </Button>

                    {/* Previous page */}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 w-8 border-zinc-200 p-0 text-zinc-600 disabled:opacity-30 dark:border-zinc-800 dark:text-zinc-400"
                      disabled={safePage <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="size-3.5" />
                    </Button>

                    {/* Numbered pages */}
                    {buildPageRange(safePage, totalPages).map((p, idx) =>
                      p === -1 ? (
                        <span
                          key={`ellipsis-${idx}`}
                          className="flex h-8 w-8 items-center justify-center text-xs text-zinc-400 dark:text-zinc-600"
                        >
                          …
                        </span>
                      ) : (
                        <Button
                          key={p}
                          type="button"
                          variant={p === safePage ? 'default' : 'outline'}
                          size="sm"
                          className={cn(
                            'h-8 w-8 p-0 text-xs font-medium',
                            p === safePage
                              ? 'bg-orange-500 text-white hover:bg-orange-600 border-orange-500 dark:bg-orange-500 dark:hover:bg-orange-600'
                              : 'border-zinc-200 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400',
                          )}
                          onClick={() => setPage(p)}
                          aria-label={`Page ${p}`}
                          aria-current={p === safePage ? 'page' : undefined}
                        >
                          {p}
                        </Button>
                      ),
                    )}

                    {/* Next page */}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 w-8 border-zinc-200 p-0 text-zinc-600 disabled:opacity-30 dark:border-zinc-800 dark:text-zinc-400"
                      disabled={safePage >= totalPages}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      aria-label="Next page"
                    >
                      <ChevronRight className="size-3.5" />
                    </Button>

                    {/* Last page */}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 w-8 border-zinc-200 p-0 text-zinc-600 disabled:opacity-30 dark:border-zinc-800 dark:text-zinc-400"
                      disabled={safePage >= totalPages}
                      onClick={() => setPage(totalPages)}
                      aria-label="Last page"
                    >
                      <ChevronsRight className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="flex min-h-0 flex-col overflow-hidden border-orange-100/80 bg-gradient-to-br from-white to-orange-50/20 shadow-sm dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/5">
          <CardHeader className="shrink-0 pb-2">
            <CardTitle className="text-lg font-semibold text-zinc-900 dark:text-white">Bonus & Status</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 space-y-5 overflow-y-auto">
            {/* PAB Eligibility */}
            <div className="rounded-lg border border-zinc-200/80 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="mb-2.5 flex items-center gap-2">
                <Award className="h-4 w-4 text-indigo-500" />
                <span className="text-xs font-semibold text-zinc-900 dark:text-white">Perfect Attendance Bonus</span>
              </div>
              {pabMetrics.loading ? (
                <div className="flex items-center gap-2 py-2 text-[11px] text-zinc-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Computing PAB eligibility…
                </div>
              ) : (
                <>
                  {pabMetrics.monthLabel && (
                    <p className="mb-2 text-[10px] text-indigo-600 dark:text-indigo-400">
                      PAB period: <span className="font-semibold">{pabMetrics.monthLabel}</span>
                    </p>
                  )}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                        Eligible
                      </div>
                      <span className="font-mono text-sm font-bold text-emerald-600 dark:text-emerald-400">
                        {pabMetrics.eligible}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                        <XCircle className="h-3.5 w-3.5 text-red-400" />
                        Not Eligible
                      </div>
                      <span className="font-mono text-sm font-bold text-red-500 dark:text-red-400">
                        {pabMetrics.notEligible}
                      </span>
                    </div>
                    {pabMetrics.totalEmployees > 0 && (
                      <div className="mt-1.5">
                        <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-500 transition-all duration-500"
                            style={{ width: `${(pabMetrics.eligible / pabMetrics.totalEmployees) * 100}%` }}
                          />
                        </div>
                        <p className="mt-1 text-right text-[10px] text-zinc-400">
                          {Math.round((pabMetrics.eligible / pabMetrics.totalEmployees) * 100)}% eligible of {pabMetrics.totalEmployees}
                        </p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Technology Bonus */}
            <div className="rounded-lg border border-zinc-200/80 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="mb-2.5 flex items-center gap-2">
                <Laptop className="h-4 w-4 text-sky-500" />
                <span className="text-xs font-semibold text-zinc-900 dark:text-white">Technology Bonus</span>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-600 dark:text-zinc-400">Amount per employee</span>
                  <span className="font-mono text-sm font-bold text-sky-600 dark:text-sky-400">₱1,850</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    Eligible
                  </div>
                  <span className="font-mono text-sm font-bold text-sky-600 dark:text-sky-400">
                    {techBonusEligibility.eligible}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                    <Clock className="h-3.5 w-3.5 text-amber-500" />
                    Pending 30d
                  </div>
                  <span className="font-mono text-sm font-bold text-amber-600 dark:text-amber-400">
                    {techBonusEligibility.pending}
                  </span>
                </div>
                {techBonusEligibility.unknown > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-600 dark:text-zinc-400">No start date</span>
                    <span className="font-mono text-sm font-bold text-zinc-500">
                      {techBonusEligibility.unknown}
                    </span>
                  </div>
                )}
                {techBonusEligibility.total > 0 && (
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                    <div
                      className="h-full bg-sky-500 transition-all"
                      style={{ width: `${(techBonusEligibility.eligible / techBonusEligibility.total) * 100}%` }}
                    />
                  </div>
                )}
                <p className="mt-1 text-right text-[10px] text-zinc-400">
                  {techBonusEligibility.total > 0
                    ? `${Math.round((techBonusEligibility.eligible / techBonusEligibility.total) * 100)}% eligible of ${techBonusEligibility.total}`
                    : 'No employees loaded'}
                </p>
                <p className="mt-1 text-[10px] leading-snug text-zinc-400 dark:text-zinc-500">
                  Paid on the 3rd paycheck of each month to employees with ≥ 30 days of service.
                </p>
              </div>
            </div>

            {/* Dispute Requests */}
            <div className="rounded-lg border border-zinc-200/80 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="mb-2.5 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <span className="text-xs font-semibold text-zinc-900 dark:text-white">Dispute Requests</span>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                    <Clock className="h-3.5 w-3.5 text-amber-500" />
                    Pending
                  </div>
                  <span className="font-mono text-sm font-bold text-amber-600 dark:text-amber-400">0</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    Resolved
                  </div>
                  <span className="font-mono text-sm font-bold text-emerald-600 dark:text-emerald-400">0</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                    <XCircle className="h-3.5 w-3.5 text-red-400" />
                    Rejected
                  </div>
                  <span className="font-mono text-sm font-bold text-red-500 dark:text-red-400">0</span>
                </div>
                <p className="mt-1 text-[10px] leading-snug text-zinc-400 dark:text-zinc-500">
                  Dispute system is planned. Counts will populate once the disputes feature is live.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
