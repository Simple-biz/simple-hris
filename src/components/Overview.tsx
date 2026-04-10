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
import { normEmail } from '@/lib/email/norm-email';
import { phpHourlyPayFromSeconds, splitRegularOvertimeSeconds } from '@/lib/payroll/money-php';

const PAGE_SIZE = 5;

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

export default function Overview() {
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [employeesError, setEmployeesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState<string>('');
  const [page, setPage] = useState(1);
  const [totalPayout, setTotalPayout] = useState<number | null>(null);
  const [payoutLoading, setPayoutLoading] = useState(true);
  /** Normalized emails from hubstaff_hours payroll rows; null if not loaded or fetch failed. */
  const [payrollEmailsNorm, setPayrollEmailsNorm] = useState<Set<string> | null>(null);
  /** Distinct work emails in the payroll rows used for stats (latest CSV when uploads are tracked). */
  const [payrollWorkerCount, setPayrollWorkerCount] = useState<number | null>(null);
  /** When hubstaff rows include `source_file`, this is the filename used for payout stats (lexicographically last = latest week for ISO-style names). */
  const [latestSourceFile, setLatestSourceFile] = useState<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let hoursUrl = '/api/hubstaff-hours';
        let pickedSourceFile: string | null = null;
        try {
          const filesRes = await fetch('/api/hubstaff-hours?source_files=1', { cache: 'no-store' });
          const filesJson = (await filesRes.json()) as { files?: string[]; error?: string | null };
          if (filesRes.ok && !filesJson.error && filesJson.files?.length) {
            pickedSourceFile = filesJson.files[filesJson.files.length - 1] ?? null;
            if (pickedSourceFile) {
              hoursUrl = `/api/hubstaff-hours?source_file=${encodeURIComponent(pickedSourceFile)}`;
            }
          }
        } catch {
          /* fall back to full hubstaff_hours fetch */
        }
        if (!cancelled) setLatestSourceFile(pickedSourceFile);

        const [hoursRes, ratesRes] = await Promise.all([
          fetch(hoursUrl, { cache: 'no-store' }),
          fetch('/api/employee-hourly-rates', { cache: 'no-store' }),
        ]);
        const hoursJson = (await hoursRes.json()) as {
          payrollRows?: Array<{ email: string | null; hoursDecimal: number }> | null;
          error?: string | null;
        };
        const ratesJson = (await ratesRes.json()) as {
          rows: EmployeeHourlyRateRow[];
        };

        const ratesByEmail = indexHourlyRatesByEmail(ratesJson.rows ?? []);
        const payrollRows = hoursJson.payrollRows ?? [];

        if (hoursRes.ok && !hoursJson.error) {
          const paySet = new Set<string>();
          for (const row of payrollRows) {
            const em = normEmail(row.email);
            if (em) paySet.add(em);
          }
          setPayrollEmailsNorm(paySet);
          setPayrollWorkerCount(paySet.size);
        } else {
          setPayrollEmailsNorm(null);
          setPayrollWorkerCount(null);
        }

        let sum = 0;
        let hasAnyPay = false;

        for (const row of payrollRows) {
          const totalH = row.hoursDecimal;
          const { regularSec, otSec } = splitRegularOvertimeSeconds(totalH);

          const em = normEmail(row.email);
          const rateRow = em ? ratesByEmail.get(em) : undefined;

          const parseRate = (v: string | null | undefined): number | null => {
            if (v == null) return null;
            const n = parseFloat(String(v).trim().replace(/,/g, ''));
            return Number.isFinite(n) ? n : null;
          };

          const regularRate = parseRate(rateRow?.regular_rate);
          const otRate = parseRate(rateRow?.ot_rate);
          const regularPay =
            regularRate != null ? phpHourlyPayFromSeconds(regularRate, regularSec) : null;
          const otPay =
            otSec > 0 ? (otRate != null ? phpHourlyPayFromSeconds(otRate, otSec) : null) : 0;
          const initialPay =
            regularPay != null && otPay != null
              ? Math.round((regularPay + otPay) * 100) / 100
              : null;

          if (initialPay != null) {
            sum += initialPay;
            hasAnyPay = true;
          }
        }

        if (!cancelled) {
          setTotalPayout(hasAnyPay ? sum : null);
        }
      } catch {
        if (!cancelled) {
          setTotalPayout(null);
          setPayrollEmailsNorm(null);
          setPayrollWorkerCount(null);
          setLatestSourceFile(null);
        }
      } finally {
        if (!cancelled) setPayoutLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const departmentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of employees) {
      const d = e.department?.trim();
      if (d) set.add(d);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [employees]);

  const filteredEmployees = useMemo(() => {
    let list = employees;
    if (departmentFilter) {
      list = list.filter((e) => (e.department ?? '').trim() === departmentFilter);
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((e) => {
        const parts = [e.department, e.name, e.personal_email, e.start_date].map((v) =>
          (v ?? '').toLowerCase(),
        );
        return parts.some((p) => p.includes(q));
      });
    }
    return list;
  }, [employees, departmentFilter, searchQuery]);

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
    const masterSet = new Set<string>();
    for (const e of employees) {
      const em = normEmail(e.personal_email);
      if (em) masterSet.add(em);
    }
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
    <div className="min-h-full space-y-8 bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-8 dark:bg-none dark:bg-[#0d1117]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">System Overview</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-500">Real-time HRIS and Payroll analytics</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            title={latestSourceFile ?? undefined}
            className="max-w-[min(100%,280px)] truncate border-orange-500/20 bg-gradient-to-r from-orange-500/10 to-blue-500/10 px-3 py-1 font-mono text-[11px] text-orange-700 dark:border-orange-500/30 dark:text-orange-400"
          >
            {latestSourceFile ? `CSV: ${latestSourceFile}` : 'Hubstaff data (all rows)'}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
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
                {stat.label === 'Total Payout'
                  ? latestSourceFile
                    ? `Sum of initial pay · ${latestSourceFile}`
                    : 'Sum of initial pay · latest Hubstaff data in database'
                  : stat.label === 'Active Workers'
                    ? latestSourceFile
                      ? `Distinct work emails · ${latestSourceFile}`
                      : 'Distinct work emails in Hubstaff payroll rows'
                    : stat.label === 'Employees in Payroll but not in Master list'
                      ? latestSourceFile
                        ? `Distinct emails in ${latestSourceFile} not in global_master_list`
                        : 'Distinct emails in Hubstaff payroll not in global_master_list'
                      : stat.label === 'Employees in Masterlist but not in Payroll'
                        ? latestSourceFile
                          ? `Distinct emails in global_master_list not in ${latestSourceFile}`
                          : 'Distinct emails in global_master_list not in Hubstaff payroll'
                        : ''}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
        <Card className="border-orange-100/80 bg-gradient-to-br from-white to-blue-50/20 shadow-sm dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/5 lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <CardTitle className="text-lg font-semibold text-zinc-900 dark:text-white">Employees</CardTitle>
            <Badge variant="outline" className="border-blue-500/20 bg-blue-500/10 font-mono text-[10px] text-blue-700 dark:border-blue-500/30 dark:text-blue-400">
              global_master_list
            </Badge>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500 dark:text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading employees…
              </div>
            ) : employeesError ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200/90">
                {employeesError}
              </p>
            ) : employees.length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-500">
                No rows returned. Point{' '}
                <code className="font-mono text-xs text-zinc-800 dark:text-zinc-400">NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE</code>{' '}
                at your table (default <code className="font-mono text-xs text-zinc-800 dark:text-zinc-400">global_master_list</code>) with
                columns{' '}
                <code className="font-mono text-xs text-zinc-800 dark:text-zinc-400">Department</code>,{' '}
                <code className="font-mono text-xs text-zinc-800 dark:text-zinc-400">Name</code>,{' '}
                <code className="font-mono text-xs text-zinc-800 dark:text-zinc-400">Personal Email</code>,{' '}
                <code className="font-mono text-xs text-zinc-800 dark:text-zinc-400">Start Date</code>, and allow{' '}
                <code className="font-mono text-xs text-zinc-800 dark:text-zinc-400">select</code> for the anon key (RLS).
              </p>
            ) : (
              <div className="space-y-4">
                {/* Filters */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
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
                <div className="rounded-md border border-zinc-200 dark:border-zinc-800">
                  <Table>
                    <TableHeader className="bg-gradient-to-r from-orange-50/80 to-blue-50/40 dark:from-blue-950/40 dark:to-blue-950/20">
                      <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                        <TableHead className="text-zinc-600 dark:text-zinc-400">Employee ID</TableHead>
                        <TableHead className="text-zinc-600 dark:text-zinc-400">Department</TableHead>
                        <TableHead className="text-zinc-600 dark:text-zinc-400">Name</TableHead>
                        <TableHead className="text-zinc-600 dark:text-zinc-400">Personal Email</TableHead>
                        <TableHead className="text-right text-zinc-600 dark:text-zinc-400">Start Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pageRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="py-8 text-center text-zinc-600 dark:text-zinc-500">
                            No employees match your search or filter.
                          </TableCell>
                        </TableRow>
                      ) : (
                        pageRows.map((row, i) => (
                          <TableRow
                            key={`${row.personal_email ?? ''}-${row.name ?? ''}-${(safePage - 1) * PAGE_SIZE + i}`}
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
                            <TableCell className="text-zinc-800 dark:text-zinc-200">{row.department ?? '—'}</TableCell>
                            <TableCell className="font-medium text-zinc-800 dark:text-zinc-200">{row.name ?? '—'}</TableCell>
                            <TableCell className="font-mono text-xs text-zinc-600 dark:text-zinc-400">{row.personal_email ?? '—'}</TableCell>
                            <TableCell className="text-right text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                              {formatStartDate(row.start_date)}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>

                {/* Pagination */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
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
                        {filteredEmployees.length !== employees.length && (
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

        <Card className="border-orange-100/80 bg-gradient-to-br from-white to-orange-50/20 shadow-sm dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/5">
          <CardHeader>
            <CardTitle className="text-lg font-semibold text-zinc-900 dark:text-white">System Health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-zinc-600 dark:text-zinc-400">Hubstaff API Sync</span>
                <span className="font-bold text-emerald-600 dark:text-emerald-500">Stable</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div className="h-full w-[98%] bg-emerald-500" />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-zinc-600 dark:text-zinc-400">Payroll Calculation Engine</span>
                <span className="font-bold text-emerald-600 dark:text-emerald-500">Stable</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div className="h-full w-[100%] bg-emerald-500" />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-zinc-600 dark:text-zinc-400">Recruitment DB Pipeline</span>
                <span className="font-bold text-amber-600 dark:text-amber-500">Degraded</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div className="h-full w-[75%] bg-amber-500" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
