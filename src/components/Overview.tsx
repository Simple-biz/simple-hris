"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
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
  AlertCircle,
  FileWarning,
  CalendarDays,
  ArrowRight,
  LayoutGrid,
  Rows3,
  Activity,
  MapPin,
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
import { fetchPabPeriodSettings, isValidManualPabRange } from '@/lib/pab-period-settings';

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

/** Extract a "Mar 24 – 30, 2026 · week N" style label from a Hubstaff filename. */
function parsePeriodFromFilename(file: string | null): { label: string; week: number | null } | null {
  if (!file) return null;
  const m = /(\d{4})-(\d{2})-(\d{2})_to_(\d{4})-(\d{2})-(\d{2})/.exec(file);
  if (!m) return null;
  const start = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const end = new Date(Date.UTC(+m[4], +m[5] - 1, +m[6]));
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  const sameMonth = start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear();
  const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const label = sameMonth
    ? `${monthShort[start.getUTCMonth()]} ${start.getUTCDate()} – ${end.getUTCDate()}, ${end.getUTCFullYear()}`
    : `${monthShort[start.getUTCMonth()]} ${start.getUTCDate()} – ${monthShort[end.getUTCMonth()]} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  const firstOfYear = Date.UTC(start.getUTCFullYear(), 0, 1);
  const week = Math.floor((start.getTime() - firstOfYear) / (7 * 24 * 3600 * 1000)) + 1;
  return { label, week };
}

/** Donut-chart SVG with a single arc showing `pct` (0–100) of a 100-unit ring. */
function Donut({
  pct,
  color,
  size = 96,
  stroke = 3.2,
  fillContainer,
}: {
  pct: number;
  color: string;
  size?: number;
  stroke?: number;
  /** When true, omit fixed px size so the parent box (e.g. h-20 xl:h-24) controls dimensions. */
  fillContainer?: boolean;
}) {
  const safe = Math.max(0, Math.min(100, pct));
  return (
    <svg
      viewBox="0 0 36 36"
      className={fillContainer ? 'h-full w-full' : undefined}
      width={fillContainer ? undefined : size}
      height={fillContainer ? undefined : size}
      style={{ transform: 'rotate(-90deg)' }}
    >
      <circle cx="18" cy="18" r="15.915" fill="none" stroke="currentColor" strokeWidth={stroke} className="text-zinc-200 dark:text-zinc-800" />
      <circle cx="18" cy="18" r="15.915" fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={`${safe} 100`} strokeLinecap="round" />
    </svg>
  );
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
  onNavigate?: (tab: string) => void;
}

interface SimpleViewProps {
  totalPayout: number | null;
  payoutLoading: boolean;
  payrollWorkerCount: number | null;
  masterTotal: number;
  inPayrollNotMaster: number | null;
  inMasterNotPayroll: number | null;
  pendingDisputes: number | null;
  oldestDisputeDays: number | null;
  pendingLeaves: number | null;
  weekOrphanageVisits: number | null;
  pabMetrics: {
    loading: boolean;
    totalEmployees: number;
    eligible: number;
    notEligible: number;
    monthLabel: string | null;
  };
  techBonusEligibility: { eligible: number; pending: number; unknown: number; total: number };
  pageRows: OverviewEmployeeRow[];
  filteredTotal: number;
  totalPages: number;
  safePage: number;
  setPage: React.Dispatch<React.SetStateAction<number>>;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  departmentFilter: string;
  setDepartmentFilter: (v: string) => void;
  departmentOptions: string[];
  activeSourceFile: string | null;
  activePeriod: { label: string; week: number | null } | null;
  employeePayByEmail: Record<string, { hours: number; pay: number | null }>;
  onViewRates?: (email: string) => void;
  onNavigate?: (tab: string) => void;
  loading: boolean;
  pabEligibilityByEmail: Map<string, boolean>;
  pabFilter: 'all' | 'eligible' | 'not-eligible';
  setPabFilter: (v: 'all' | 'eligible' | 'not-eligible') => void;
}

/** PHP → USD FX rate used only for the informational subtitle under the total payout. */
const PHP_USD_FX = 58.1;

function initialsFromName(n: string | null | undefined): string {
  if (!n) return '—';
  return n
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

function pabTotalForExpanded(metrics: {
  totalEmployees: number;
  eligible: number;
  notEligible: number;
}): number {
  if (metrics.totalEmployees > 0) return metrics.totalEmployees;
  return Math.max(0, metrics.eligible) + Math.max(0, metrics.notEligible);
}

function formatPhp(n: number | null | undefined, min = 0): string {
  if (n == null) return '—';
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: min, maximumFractionDigits: 2 });
}

function SimpleView({
  totalPayout,
  payoutLoading,
  payrollWorkerCount,
  masterTotal,
  inPayrollNotMaster,
  inMasterNotPayroll,
  pendingDisputes,
  oldestDisputeDays,
  pendingLeaves,
  weekOrphanageVisits,
  pabMetrics,
  techBonusEligibility,
  pageRows,
  filteredTotal,
  totalPages,
  safePage,
  setPage,
  searchQuery,
  setSearchQuery,
  departmentFilter,
  setDepartmentFilter,
  departmentOptions,
  activeSourceFile,
  activePeriod,
  employeePayByEmail,
  onViewRates,
  onNavigate,
  loading,
  pabEligibilityByEmail,
  pabFilter,
  setPabFilter,
}: SimpleViewProps) {
  const reconcileGaps =
    inPayrollNotMaster != null && inMasterNotPayroll != null
      ? inPayrollNotMaster + inMasterNotPayroll
      : null;
  const pabTotal = pabMetrics.totalEmployees;
  const pabPct = pabTotal > 0 ? Math.round((pabMetrics.eligible / pabTotal) * 100) : 0;
  const techTotal = techBonusEligibility.total;
  const techPct = techTotal > 0 ? Math.round((techBonusEligibility.eligible / techTotal) * 100) : 0;
  const nowHour = new Date().getHours();
  const greeting = nowHour < 12 ? 'Good morning' : nowHour < 18 ? 'Good afternoon' : 'Good evening';

  const usdEquivalent = totalPayout != null ? totalPayout / PHP_USD_FX : null;

  // ⌘K / Ctrl+K focuses the search input.
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const disputeTag =
    pendingDisputes && pendingDisputes > 0
      ? oldestDisputeDays != null && oldestDisputeDays >= 2
        ? `overdue ${oldestDisputeDays}d`
        : 'review soon'
      : null;
  const orphanageCount = weekOrphanageVisits ?? 0;
  const leaveAndVisitsTotal = (pendingLeaves ?? 0) + orphanageCount;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-[1600px] px-3 pb-6 sm:px-4 md:px-6 lg:px-8 xl:px-10 [@media(max-height:900px)]:pb-4 xl:pb-12">

        {/* Hero — scales up at xl/2xl so 13" laptops (~1280×800) are not dominated by md:text-7xl */}
        <section className="mb-5 grid grid-cols-1 items-end gap-4 border-b border-zinc-200 pb-5 [@media(max-height:900px)]:mb-4 [@media(max-height:900px)]:gap-3 [@media(max-height:900px)]:pb-4 lg:mb-8 lg:gap-6 lg:pb-6 lg:grid-cols-[1fr_auto] xl:mb-10 xl:gap-8 xl:pb-8 dark:border-zinc-800">
          <div>
            <p className="mb-2 text-[13px] text-zinc-500 [@media(max-height:900px)]:mb-1 lg:mb-3 xl:mb-4 dark:text-zinc-400">
              <span>{greeting}. Accounting team dashboard.</span>
            </p>
            <p className="mb-2 text-[12.5px] font-medium text-zinc-500 xl:mb-3 dark:text-zinc-400">
              Total payout for this accounting pay run
            </p>
            <div className="flex items-baseline">
              <span className="mr-1.5 text-4xl font-medium text-zinc-400 lg:text-5xl xl:text-6xl 2xl:text-7xl">₱</span>
              {payoutLoading ? (
                <span className="inline-block h-[1em] w-[220px] animate-pulse rounded-md bg-zinc-200/80 align-bottom text-4xl lg:w-[280px] lg:text-5xl xl:w-[360px] xl:text-6xl 2xl:w-[420px] 2xl:text-7xl dark:bg-zinc-800" />
              ) : (
                <span className="font-mono text-4xl font-semibold tracking-tight text-zinc-900 lg:text-5xl xl:text-6xl 2xl:text-7xl dark:text-white">
                  {totalPayout != null
                    ? totalPayout.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : '—'}
                </span>
              )}
            </div>
            <p className="mt-2 flex flex-wrap items-center gap-3 text-[13px] text-zinc-500 [@media(max-height:900px)]:mt-1.5 lg:mt-3 xl:mt-4 dark:text-zinc-400">
              <span>
                <strong className="font-semibold text-zinc-900 dark:text-white">
                  {payrollWorkerCount ?? '—'}
                </strong>{' '}
                active workers
              </span>
              {usdEquivalent != null && (
                <>
                  <span className="text-zinc-400 dark:text-zinc-600">·</span>
                  <span>
                    ≈{' '}
                    <strong className="font-semibold text-zinc-900 dark:text-white">
                      ${usdEquivalent.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    </strong>{' '}
                    USD
                  </span>
                </>
              )}
              <span className="text-zinc-400 dark:text-zinc-600">·</span>
              <span>Initial pay · bonuses applied at payroll</span>
            </p>
          </div>
          <div className="flex w-full flex-col items-start gap-3 lg:w-auto lg:min-w-[280px] lg:items-end">
            {activePeriod && (
              <div className="text-[12.5px] font-medium text-zinc-500 dark:text-zinc-400">
                <strong className="font-semibold text-zinc-900 dark:text-white">{activePeriod.label}</strong>
                {activePeriod.week != null && <> · week {activePeriod.week}</>}
              </div>
            )}
            <div className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1.5 text-[13px]">
              <div className="flex items-center gap-2 whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                <Users className="h-3 w-3 text-zinc-400" />
                Master list
              </div>
              <div className="text-right font-mono font-medium text-zinc-900 dark:text-white">
                {masterTotal}
              </div>
              <div className="flex items-center gap-2 whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                <Activity className="h-3 w-3 text-zinc-400" />
                In this payroll
              </div>
              <div className="text-right font-mono font-medium text-zinc-900 dark:text-white">
                {payrollWorkerCount ?? '—'}
              </div>
              <div className="flex items-center gap-2 whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                <AlertTriangle className="h-3 w-3 text-zinc-400" />
                Reconcile gaps
              </div>
              <div
                className={cn(
                  'text-right font-mono font-medium',
                  reconcileGaps && reconcileGaps > 0
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-zinc-900 dark:text-white',
                )}
              >
                {reconcileGaps ?? '—'}
              </div>
            </div>
          </div>
        </section>

        {/* Attention row */}
        <section className="mb-6 grid grid-cols-1 gap-3.5 [@media(max-height:900px)]:mb-4 lg:mb-10 xl:mb-14 md:grid-cols-3">
          <AttentionCard
            icon={<AlertCircle className="h-3.5 w-3.5" />}
            label="Needs your decision"
            tone={pendingDisputes && pendingDisputes > 0 ? 'warn' : 'normal'}
            tag={disputeTag}
            value={pendingDisputes ?? 0}
            unit={pendingDisputes === 1 ? 'dispute pending' : 'disputes pending'}
            sub="Approve or deny short-day disputes"
            cta="Review queue"
            onClick={onNavigate ? () => onNavigate('disputes') : undefined}
          />
          <AttentionCard
            icon={<FileWarning className="h-3.5 w-3.5" />}
            label="Reconciliation"
            tone="normal"
            tag="2 sources"
            value={reconcileGaps ?? 0}
            unit={reconcileGaps === 1 ? 'mismatch' : 'mismatches'}
            sub={
              <>
                <strong className="text-zinc-700 dark:text-zinc-300">
                  {inPayrollNotMaster ?? 0}
                </strong>{' '}
                in payroll not on master ·{' '}
                <strong className="text-zinc-700 dark:text-zinc-300">
                  {inMasterNotPayroll ?? 0}
                </strong>{' '}
                on master not in payroll
              </>
            }
            cta="Reconcile"
            onClick={onNavigate ? () => onNavigate('payroll-wizard') : undefined}
          />
          <AttentionCard
            icon={<CalendarDays className="h-3.5 w-3.5" />}
            label="Leave & visits"
            tone="normal"
            tag="this week"
            value={leaveAndVisitsTotal}
            unit={leaveAndVisitsTotal === 1 ? 'item' : 'items'}
            sub={
              <>
                <strong className="text-zinc-700 dark:text-zinc-300">{pendingLeaves ?? 0}</strong>{' '}
                leave requests · <strong className="text-zinc-700 dark:text-zinc-300">{orphanageCount}</strong>{' '}
                orphanage visits
              </>
            }
            cta="Open requests"
            onClick={onNavigate ? () => onNavigate('leave-requests') : undefined}
          />
        </section>

        {/* Monthly bonuses */}
        <section className="mb-6 [@media(max-height:900px)]:mb-4 lg:mb-10 xl:mb-14">
          <div className="mb-3 flex items-baseline justify-between lg:mb-5">
            <h3 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-white">
              Monthly bonuses
            </h3>
            <span className="text-[12.5px] text-zinc-500 dark:text-zinc-400">
              {pabMetrics.monthLabel ?? '—'} · merged from all Hubstaff uploads
            </span>
          </div>

          <div className="grid grid-cols-1 gap-6 [@media(max-height:900px)]:gap-5 md:grid-cols-2 lg:gap-8 xl:gap-12">
            {/* PAB */}
            <div className="grid grid-cols-[120px_1fr] items-center gap-4 lg:gap-6 xl:gap-7">
              <div className="flex flex-col items-center gap-2.5">
                <div className="relative h-20 w-20 xl:h-24 xl:w-24">
                  <Donut pct={pabPct} color="#047857" fillContainer />
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-base font-semibold tracking-tight text-zinc-900 xl:text-xl dark:text-white">
                      {pabTotal > 0 ? `${pabPct}%` : '—'}
                    </span>
                    {pabTotal > 0 && (
                      <span className="mt-0.5 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
                        {pabMetrics.eligible} / {pabTotal}
                      </span>
                    )}
                  </div>
                </div>
                <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                  Perfect Attendance
                </span>
              </div>
              <div>
                <h4 className="mb-1 text-[13px] font-semibold text-zinc-900 dark:text-white">
                  Perfect Attendance Bonus · ₱5,000
                </h4>
                <p className="mb-2 text-xs text-zinc-500 [@media(max-height:900px)]:mb-1.5 xl:mb-3.5 dark:text-zinc-400">
                  {pabMetrics.monthLabel ?? '—'} · merged month
                </p>
                <div className="grid grid-cols-[auto_auto] gap-x-5 gap-y-1 text-[13px]">
                  <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                    <span className="inline-block h-2 w-2 rounded-full bg-emerald-700 dark:bg-emerald-500" />
                    Eligible
                  </div>
                  <div className="text-right font-mono font-medium text-zinc-900 dark:text-white">
                    {pabMetrics.loading ? '…' : pabMetrics.eligible}
                  </div>
                  <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                    <span className="inline-block h-2 w-2 rounded-full bg-red-700 dark:bg-red-500" />
                    Not eligible
                  </div>
                  <div className="text-right font-mono font-medium text-zinc-900 dark:text-white">
                    {pabMetrics.loading ? '…' : pabMetrics.notEligible}
                  </div>
                </div>
                <p className="mt-3.5 text-[11.5px] leading-snug text-zinc-400 dark:text-zinc-500">
                  Accrues ₱{(pabMetrics.eligible * 5000).toLocaleString('en-PH')} if all eligible
                  hold through month end.
                </p>
              </div>
            </div>

            {/* Tech Bonus */}
            <div className="grid grid-cols-[120px_1fr] items-center gap-4 lg:gap-6 xl:gap-7">
              <div className="flex flex-col items-center gap-2.5">
                <div className="relative h-20 w-20 xl:h-24 xl:w-24">
                  <Donut pct={techPct} color="#18181b" fillContainer />
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-base font-semibold tracking-tight text-zinc-900 xl:text-xl dark:text-white">
                      {techTotal > 0 ? `${techPct}%` : '—'}
                    </span>
                    {techTotal > 0 && (
                      <span className="mt-0.5 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
                        {techBonusEligibility.eligible} / {techTotal}
                      </span>
                    )}
                  </div>
                </div>
                <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                  Technology
                </span>
              </div>
              <div>
                <h4 className="mb-1 text-[13px] font-semibold text-zinc-900 dark:text-white">
                  Technology Bonus · ₱1,850
                </h4>
                <p className="mb-2 text-xs text-zinc-500 [@media(max-height:900px)]:mb-1.5 xl:mb-3.5 dark:text-zinc-400">
                  Paid on 3rd paycheck of each month · after 30 days of service
                </p>
                <div className="grid grid-cols-[auto_auto] gap-x-5 gap-y-1 text-[13px]">
                  <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                    <span className="inline-block h-2 w-2 rounded-full bg-emerald-700 dark:bg-emerald-500" />
                    Eligible
                  </div>
                  <div className="text-right font-mono font-medium text-zinc-900 dark:text-white">
                    {techBonusEligibility.eligible}
                  </div>
                  <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                    <span className="inline-block h-2 w-2 rounded-full bg-amber-700 dark:bg-amber-500" />
                    Pending 30d
                  </div>
                  <div className="text-right font-mono font-medium text-zinc-900 dark:text-white">
                    {techBonusEligibility.pending}
                  </div>
                  {techBonusEligibility.unknown > 0 && (
                    <>
                      <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                        <span className="inline-block h-2 w-2 rounded-full bg-zinc-400" />
                        No start date
                      </div>
                      <div className="text-right font-mono font-medium text-zinc-900 dark:text-white">
                        {techBonusEligibility.unknown}
                      </div>
                    </>
                  )}
                </div>
                <p className="mt-3.5 text-[11.5px] leading-snug text-zinc-400 dark:text-zinc-500">
                  Accrues ₱{(techBonusEligibility.eligible * 1850).toLocaleString('en-PH')} on the
                  3rd paycheck of the month.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Workers table */}
        <section>
          <div className="mb-3 flex items-baseline justify-between lg:mb-5">
            <h3 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-white">
              Workers in this payroll run
            </h3>
            <span className="text-[12.5px] text-zinc-500 dark:text-zinc-400">
              Master list + Hubstaff fallback
            </span>
          </div>

          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40">
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-2.5 border-b border-zinc-200 px-4 py-3.5 dark:border-zinc-800">
              <div className="flex max-w-[360px] flex-1 items-center gap-2 rounded-lg bg-[#fafaf8] px-3 py-1.5 dark:bg-zinc-900">
                <Search className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search name, email, department…"
                  className="flex-1 border-0 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-200"
                />
                <kbd className="hidden rounded border border-zinc-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 sm:inline-block dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-500">
                  ⌘K
                </kbd>
              </div>
              <select
                value={departmentFilter}
                onChange={(e) => setDepartmentFilter(e.target.value)}
                className="h-8 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12.5px] font-medium text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
              >
                <option value="">All departments</option>
                {departmentOptions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              {/* PAB filter */}
              <div className="flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
                {(['all', 'eligible', 'not-eligible'] as const).map((f) => {
                  const labels = { all: 'All', eligible: 'PAB Eligible', 'not-eligible': 'Not Eligible' };
                  const active = pabFilter === f;
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setPabFilter(f)}
                      className={cn(
                        'h-7 rounded-md px-2.5 text-[11.5px] font-medium transition-colors',
                        active
                          ? f === 'eligible'
                            ? 'bg-emerald-700 text-white dark:bg-emerald-600'
                            : f === 'not-eligible'
                              ? 'bg-red-700 text-white dark:bg-red-600'
                              : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                          : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
                      )}
                    >
                      {labels[f]}
                    </button>
                  );
                })}
              </div>
              <div className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">
                <strong className="font-semibold text-zinc-900 dark:text-white">{filteredTotal}</strong>{' '}
                workers · page {safePage} of {totalPages}
              </div>
            </div>

            {/* Mobile cards — md:hidden */}
            <div className="grid gap-3 p-3 sm:grid-cols-2 md:hidden">
              {loading ? (
                <div className="col-span-full flex items-center justify-center gap-2 py-8 text-sm text-zinc-500 dark:text-zinc-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : pageRows.length === 0 ? (
                <div className="col-span-full py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  No workers match your search.
                </div>
              ) : (
                pageRows.map((row) => {
                  const email = row.work_email ?? row.personal_email ?? '';
                  const emailKey = normEmail(email) ?? '';
                  const pay = emailKey ? employeePayByEmail[emailKey] : undefined;
                  const isHubstaff = row.recordSource === 'hubstaff';
                  return (
                    <div
                      key={`${row.recordSource}-${email}-${row.name ?? ''}`}
                      className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/40"
                    >
                      <div className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                          {initialsFromName(row.name)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium leading-tight text-zinc-900 dark:text-white">{row.name ?? '—'}</div>
                          <div className="truncate font-mono text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">{email || '—'}</div>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11.5px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                          {row.department ?? '—'}
                        </span>
                        <span className="inline-flex items-center gap-1.5 text-[10.5px] font-medium text-zinc-500 dark:text-zinc-400">
                          <span className={cn('inline-block h-1.5 w-1.5 rounded-full', isHubstaff ? 'bg-blue-700 dark:bg-blue-500' : 'bg-emerald-700 dark:bg-emerald-500')} />
                          {isHubstaff ? 'Hubstaff' : 'Master'}
                        </span>
                        {(() => {
                          const elig = emailKey ? pabEligibilityByEmail.get(emailKey) : undefined;
                          if (elig === true) return (
                            <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10.5px] font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">
                              PAB ✓
                            </span>
                          );
                          if (elig === false) return (
                            <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[10.5px] font-medium text-red-800 dark:bg-red-900/30 dark:text-red-400">
                              PAB ✗
                            </span>
                          );
                          return null;
                        })()}
                        {row.start_date && (
                          <span className="text-[11px] text-zinc-400 dark:text-zinc-600">{formatStartDate(row.start_date)}</span>
                        )}
                      </div>
                      {(() => {
                        const loc = [row.city, row.province].filter(Boolean).join(', ');
                        return loc ? (
                          <div className="flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                            <MapPin className="h-3 w-3 shrink-0" />
                            <span className="truncate">{loc}</span>
                          </div>
                        ) : null;
                      })()}
                      <div className="flex items-center justify-between border-t border-zinc-100 pt-3 dark:border-zinc-800">
                        <div className="flex gap-4">
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-zinc-400 dark:text-zinc-600">Hours</div>
                            <div className="font-mono text-sm font-medium text-zinc-900 dark:text-white">{pay ? `${pay.hours.toFixed(2)}h` : '—'}</div>
                          </div>
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-zinc-400 dark:text-zinc-600">Pay</div>
                            <div className={cn('font-mono text-sm font-medium', pay?.pay == null ? 'text-zinc-400 dark:text-zinc-600' : 'text-zinc-900 dark:text-white')}>{pay ? formatPhp(pay.pay, 2) : '—'}</div>
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={!email || !onViewRates}
                          onClick={() => email && onViewRates?.(email)}
                          className="inline-flex h-8 items-center gap-1 rounded-lg border border-orange-200 bg-orange-50 px-2.5 text-[11px] font-medium text-orange-700 transition-colors hover:bg-orange-100 disabled:cursor-not-allowed disabled:opacity-30 dark:border-orange-800/50 dark:bg-orange-900/20 dark:text-orange-400"
                        >
                          View <ChevronRight className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Desktop table — hidden on mobile */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className="border-b border-zinc-200 bg-[#fafaf8] px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400" style={{ width: '44%' }}>
                      Worker
                    </th>
                    <th className="border-b border-zinc-200 bg-[#fafaf8] px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                      Department
                    </th>
                    <th className="border-b border-zinc-200 bg-[#fafaf8] px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                      Source
                    </th>
                    <th className="border-b border-zinc-200 bg-[#fafaf8] px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                      Start date
                    </th>
                    <th className="border-b border-zinc-200 bg-[#fafaf8] px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                      PAB
                    </th>
                    <th className="border-b border-zinc-200 bg-[#fafaf8] px-4 py-3 text-right text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                      Hours
                    </th>
                    <th className="border-b border-zinc-200 bg-[#fafaf8] px-4 py-3 text-right text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                      Initial pay
                    </th>
                    <th className="w-14 border-b border-zinc-200 bg-[#fafaf8] px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900"></th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-12 text-center text-zinc-500 dark:text-zinc-400">
                        <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                      </td>
                    </tr>
                  ) : pageRows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
                        No workers match your search.
                      </td>
                    </tr>
                  ) : (
                    pageRows.map((row) => {
                      const email = row.work_email ?? row.personal_email ?? '';
                      const emailKey = normEmail(email) ?? '';
                      const pay = emailKey ? employeePayByEmail[emailKey] : undefined;
                      const isHubstaff = row.recordSource === 'hubstaff';
                      return (
                        <tr
                          key={`${row.recordSource}-${email}-${row.name ?? ''}`}
                          className="border-b border-zinc-100 last:border-b-0 hover:bg-[#fafaf8] dark:border-zinc-800/60 dark:hover:bg-zinc-900/60"
                        >
                          <td className="px-4 py-3.5">
                            <div className="flex items-center gap-3">
                              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                                {initialsFromName(row.name)}
                              </span>
                              <div>
                                <div className="font-medium leading-tight text-zinc-900 dark:text-white">
                                  {row.name ?? '—'}
                                </div>
                                <div className="mt-0.5 font-mono text-[11.5px] leading-tight text-zinc-500 dark:text-zinc-400">
                                  {email || '—'}
                                </div>
                                {(() => {
                                  const loc = [row.city, row.province].filter(Boolean).join(', ');
                                  return loc ? (
                                    <div className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                                      <MapPin className="h-3 w-3" />
                                      {loc}
                                    </div>
                                  ) : null;
                                })()}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3.5">
                            <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11.5px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                              {row.department ?? '—'}
                            </span>
                          </td>
                          <td className="px-4 py-3.5">
                            <span className="inline-flex items-center gap-1.5 text-[10.5px] font-medium text-zinc-500 dark:text-zinc-400">
                              <span
                                className={cn(
                                  'inline-block h-1.5 w-1.5 rounded-full',
                                  isHubstaff ? 'bg-blue-700 dark:bg-blue-500' : 'bg-emerald-700 dark:bg-emerald-500',
                                )}
                              />
                              {isHubstaff ? 'Hubstaff' : 'Master'}
                            </span>
                          </td>
                          <td className="px-4 py-3.5 text-[12.5px] text-zinc-500 dark:text-zinc-400">
                            {formatStartDate(row.start_date)}
                          </td>
                          <td className="px-4 py-3.5">
                            {(() => {
                              const emailKey = normEmail(email) ?? '';
                              const elig = emailKey ? pabEligibilityByEmail.get(emailKey) : undefined;
                              if (elig === true) return (
                                <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">
                                  Eligible
                                </span>
                              );
                              if (elig === false) return (
                                <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-800 dark:bg-red-900/30 dark:text-red-400">
                                  Not eligible
                                </span>
                              );
                              return <span className="text-zinc-400 dark:text-zinc-600">—</span>;
                            })()}
                          </td>
                          <td className="px-4 py-3.5 text-right font-mono text-zinc-900 tabular-nums dark:text-white">
                            {pay ? `${pay.hours.toFixed(2)}h` : '—'}
                          </td>
                          <td
                            className={cn(
                              'px-4 py-3.5 text-right font-mono tabular-nums',
                              pay?.pay == null ? 'text-zinc-400 dark:text-zinc-600' : 'text-zinc-900 dark:text-white',
                            )}
                          >
                            {pay ? formatPhp(pay.pay, 2) : '—'}
                          </td>
                          <td className="px-4 py-3.5 text-right">
                            <button
                              type="button"
                              disabled={!email || !onViewRates}
                              onClick={() => email && onViewRates?.(email)}
                              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                              aria-label="View rates"
                              title="View rates"
                            >
                              <ChevronRight className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pager */}
            <div className="flex items-center justify-between border-t border-zinc-200 bg-[#fafaf8] px-4 py-3 text-[12.5px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              <div>
                Showing{' '}
                <strong className="font-medium text-zinc-900 dark:text-white">
                  {filteredTotal === 0 ? 0 : (safePage - 1) * 10 + 1}–
                  {Math.min(safePage * 10, filteredTotal)}
                </strong>{' '}
                of {filteredTotal}
              </div>
              <div className="flex gap-0.5">
                <PagerEdgeBtn disabled={safePage <= 1} onClick={() => setPage(1)} aria-label="First page">
                  <ChevronsLeft className="h-3.5 w-3.5" />
                </PagerEdgeBtn>
                <PagerEdgeBtn disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">
                  <ChevronLeft className="h-3.5 w-3.5" />
                </PagerEdgeBtn>
                {buildPageRange(safePage, totalPages).map((p, idx) =>
                  p === -1 ? (
                    <span key={`e-${idx}`} className="flex h-7 min-w-[28px] items-center justify-center text-zinc-400">
                      …
                    </span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      className={cn(
                        'h-7 min-w-[28px] rounded-md px-2 text-[12.5px] font-medium transition-colors',
                        p === safePage
                          ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                          : 'text-zinc-500 hover:bg-white hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
                      )}
                      aria-current={p === safePage ? 'page' : undefined}
                    >
                      {p}
                    </button>
                  ),
                )}
                <PagerEdgeBtn disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} aria-label="Next page">
                  <ChevronRight className="h-3.5 w-3.5" />
                </PagerEdgeBtn>
                <PagerEdgeBtn disabled={safePage >= totalPages} onClick={() => setPage(totalPages)} aria-label="Last page">
                  <ChevronsRight className="h-3.5 w-3.5" />
                </PagerEdgeBtn>
              </div>
            </div>
          </div>
        </section>

        {/* Footnote */}
        <div className="mt-14 flex flex-wrap justify-between gap-6 border-t border-zinc-200 pt-5 text-xs text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
          <div>
            Source:{' '}
            <span className="font-mono text-zinc-500 dark:text-zinc-400">
              {activeSourceFile ?? 'all uploads combined'}
            </span>{' '}
            · <span className="font-mono text-zinc-500 dark:text-zinc-400">global_master_list</span>
          </div>
          <div>Bonuses applied during payroll processing</div>
        </div>
      </div>
    </div>
  );
}

function AttentionCard({
  icon,
  label,
  tone,
  tag,
  value,
  unit,
  sub,
  cta,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  tone: 'normal' | 'warn';
  tag: string | null;
  value: number;
  unit: string;
  sub: React.ReactNode;
  cta: string;
  onClick?: () => void;
}) {
  const interactive = !!onClick;
  const Tag = interactive ? 'button' : 'div';
  return (
    <Tag
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      disabled={interactive ? false : undefined}
      className={cn(
        'group relative w-full rounded-xl border p-5 text-left transition-colors',
        interactive && 'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40',
        tone === 'warn'
          ? 'border-transparent bg-amber-50 dark:bg-amber-950/30'
          : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40',
        interactive && tone === 'warn' && 'hover:bg-amber-100/80 dark:hover:bg-amber-950/50',
        interactive && tone !== 'warn' && 'hover:border-zinc-400 dark:hover:border-zinc-600',
      )}
    >
      <div
        className={cn(
          'mb-4 flex items-center justify-between text-[11.5px] font-medium uppercase tracking-wider',
          tone === 'warn'
            ? 'text-amber-700 dark:text-amber-400'
            : 'text-zinc-500 dark:text-zinc-400',
        )}
      >
        <span className="flex items-center gap-1.5">
          {icon}
          {label}
        </span>
        {tag && (
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10.5px] font-medium normal-case tracking-normal',
              tone === 'warn'
                ? 'bg-white text-amber-700 dark:bg-zinc-900 dark:text-amber-400'
                : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
            )}
          >
            {tag}
          </span>
        )}
      </div>
      <div
        className={cn(
          'flex items-baseline gap-2 font-mono text-3xl font-semibold leading-none tracking-tight tabular-nums',
          tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-900 dark:text-white',
        )}
      >
        {value}
        <span className="font-sans text-sm font-medium text-zinc-500 dark:text-zinc-400">{unit}</span>
      </div>
      <p className="mt-2.5 text-[12.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">{sub}</p>
      <div
        className={cn(
          'mt-3.5 flex items-center gap-1 text-xs font-medium',
          tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-900 dark:text-white',
        )}
      >
        {cta}
        <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
      </div>
    </Tag>
  );
}

function KpiTile({
  label,
  value,
  sub,
  icon,
  tone = 'normal',
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
  tone?: 'normal' | 'warn';
}) {
  return (
    <div className="min-w-0 border border-zinc-200/70 bg-white/70 p-3 dark:border-zinc-800/80 dark:bg-zinc-900/30">
      <div
        className={cn(
          'mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide',
          tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-500 dark:text-zinc-400',
        )}
      >
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div
        className={cn(
          'truncate font-mono text-lg font-semibold leading-tight tabular-nums',
          tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-900 dark:text-zinc-100',
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-1 truncate text-[11px] text-zinc-500 dark:text-zinc-500">{sub}</div> : null}
    </div>
  );
}

function CompactBonus({
  icon,
  label,
  sub,
  amount,
  eligible,
  total,
  loading = false,
  barClass,
}: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  amount: string;
  eligible: number;
  total: number;
  loading?: boolean;
  barClass: string;
}) {
  const pct = total > 0 ? Math.round((eligible / total) * 100) : 0;
  return (
    <div className="rounded-lg border border-zinc-200/80 bg-white/70 p-2.5 dark:border-zinc-800/80 dark:bg-zinc-900/30">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-semibold text-zinc-800 dark:text-zinc-200">
          {icon}
          <span className="truncate">{label}</span>
        </span>
        <span className="shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          {amount}
        </span>
      </div>
      <div className="mb-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">{sub}</div>
      <div className="mb-1 flex h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div
          className={cn('h-full transition-all duration-500', barClass)}
          style={{ width: `${Math.max(total > 0 ? 4 : 0, pct)}%` }}
        />
      </div>
      <div className="text-[11px] text-zinc-600 dark:text-zinc-400">
        {loading ? 'Loading…' : `${eligible} of ${total} eligible (${pct}%)`}
      </div>
    </div>
  );
}

function PagerEdgeBtn({
  disabled,
  onClick,
  children,
  ...rest
}: {
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'disabled'>) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-7 min-w-[28px] items-center justify-center rounded-md transition-colors',
        disabled
          ? 'cursor-default opacity-30'
          : 'text-zinc-500 hover:bg-white hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export default function Overview({ onViewRates, onNavigate }: OverviewProps = {}) {
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
  /** Per-employee hours + initial pay for the selected payroll scope. */
  const [employeePayByEmail, setEmployeePayByEmail] = useState<Record<
    string,
    { hours: number; pay: number | null }
  >>({});
  /** Pending counts surfaced in the simple view's attention row. */
  const [pendingDisputes, setPendingDisputes] = useState<number | null>(null);
  const [oldestDisputeDays, setOldestDisputeDays] = useState<number | null>(null);
  const [pendingDisputeRows, setPendingDisputeRows] = useState<
    Array<{ id: string; work_email: string; dispute_date: string; created_at?: string; reason: string }>
  >([]);
  const [pendingLeaves, setPendingLeaves] = useState<number | null>(null);
  const [weekOrphanageVisits, setWeekOrphanageVisits] = useState<number | null>(null);
  /** Which layout the user is currently viewing — persisted in localStorage. */
  const [viewMode, setViewMode] = useState<'simple' | 'expanded'>('simple');

  // Load persisted view mode on mount (client-only)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = window.localStorage.getItem('overview.viewMode');
      if (saved === 'simple' || saved === 'expanded') setViewMode(saved);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem('overview.viewMode', viewMode);
    } catch {
      /* ignore */
    }
  }, [viewMode]);

  // Lightweight fetch for pending counts surfaced in the simple view attention cards.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/pab-disputes?awaiting_accounting=1&limit=500', { cache: 'no-store' });
        const json = (await res.json()) as {
          rows?: Array<{
            id: string;
            work_email: string;
            dispute_date: string;
            reason: string;
            created_at?: string;
          }>;
        };
        if (cancelled) return;
        const rows = Array.isArray(json.rows) ? json.rows : [];
        setPendingDisputes(rows.length);
        setPendingDisputeRows(rows);
        if (rows.length > 0) {
          let oldestMs = Number.POSITIVE_INFINITY;
          for (const r of rows) {
            if (!r.created_at) continue;
            const t = new Date(r.created_at).getTime();
            if (!Number.isNaN(t) && t < oldestMs) oldestMs = t;
          }
          if (Number.isFinite(oldestMs)) {
            const days = Math.max(0, Math.floor((Date.now() - oldestMs) / (24 * 3600 * 1000)));
            setOldestDisputeDays(days);
          } else {
            setOldestDisputeDays(null);
          }
        } else {
          setOldestDisputeDays(null);
        }
      } catch {
        if (!cancelled) {
          setPendingDisputes(null);
          setOldestDisputeDays(null);
          setPendingDisputeRows([]);
        }
      }
    })();
    (async () => {
      try {
        const res = await fetch('/api/leave-requests?scope=all', { cache: 'no-store' });
        const json = (await res.json()) as { rows?: { status?: string }[] };
        if (!cancelled) {
          const n = Array.isArray(json.rows)
            ? json.rows.filter((r) => (r.status ?? '').toLowerCase() === 'pending').length
            : 0;
          setPendingLeaves(n);
        }
      } catch {
        if (!cancelled) setPendingLeaves(null);
      }
    })();
    (async () => {
      try {
        // Orphanage visits in a ±3 day window around today (roughly "this week")
        const today = new Date();
        const fmt = (d: Date) =>
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const from = new Date(today.getTime() - 3 * 24 * 3600 * 1000);
        const to = new Date(today.getTime() + 4 * 24 * 3600 * 1000);
        const res = await fetch(
          `/api/pab-disputes/orphanage-visits?from=${fmt(from)}&to=${fmt(to)}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as { rows?: { id: string }[] };
        if (!cancelled) setWeekOrphanageVisits(Array.isArray(json.rows) ? json.rows.length : 0);
      } catch {
        if (!cancelled) setWeekOrphanageVisits(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const [pabEligibilityByEmail, setPabEligibilityByEmail] = useState<Map<string, boolean>>(new Map());
  const [pabFilter, setPabFilter] = useState<'all' | 'eligible' | 'not-eligible'>('all');

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
        // Default to latest file (API returns newest-first)
        if (files.length > 0) {
          setSelectedSourceFile(files[0]);
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
        const perEmployeePay: Record<string, { hours: number; pay: number | null }> = {};

        const parseRate = (v: string | null | undefined): number | null => {
          if (v == null) return null;
          const n = parseFloat(String(v).trim().replace(/,/g, ''));
          return Number.isFinite(n) ? n : null;
        };

        if (isAllTime) {
          // Sum hours per employee across all files, split regular/OT per file
          const perEmployee = new Map<string, { regularSec: number; otSec: number; totalHours: number }>();
          for (const row of allPayrollRows) {
            const em = normEmail(row.email);
            if (!em) continue;
            paySet.add(em);
            const { regularSec, otSec } = splitRegularOvertimeSeconds(row.hoursDecimal);
            const existing = perEmployee.get(em) ?? { regularSec: 0, otSec: 0, totalHours: 0 };
            existing.regularSec += regularSec;
            existing.otSec += otSec;
            existing.totalHours += row.hoursDecimal ?? 0;
            perEmployee.set(em, existing);
          }
          for (const [em, { regularSec, otSec, totalHours }] of perEmployee) {
            const rateRow = ratesByEmail.get(em);
            const regularRate = parseRate(rateRow?.regular_rate);
            const otRate = parseRate(rateRow?.ot_rate);
            const regularPay = regularRate != null ? phpHourlyPayFromSeconds(regularRate, regularSec) : null;
            const otPay = otSec > 0 ? (otRate != null ? phpHourlyPayFromSeconds(otRate, otSec) : null) : 0;
            const initialPay = regularPay != null && otPay != null ? Math.round((regularPay + otPay) * 100) / 100 : null;
            perEmployeePay[em] = { hours: totalHours, pay: initialPay };
            if (initialPay != null) { sum += initialPay; hasAnyPay = true; }
          }
        } else {
          for (const row of allPayrollRows) {
            const em = normEmail(row.email);
            if (em) paySet.add(em);
            const { regularSec, otSec } = splitRegularOvertimeSeconds(row.hoursDecimal);
            const rateRow = em ? ratesByEmail.get(em) : undefined;
            const regularRate = parseRate(rateRow?.regular_rate);
            const otRate = parseRate(rateRow?.ot_rate);
            const regularPay = regularRate != null ? phpHourlyPayFromSeconds(regularRate, regularSec) : null;
            const otPay = otSec > 0 ? (otRate != null ? phpHourlyPayFromSeconds(otRate, otSec) : null) : 0;
            const initialPay = regularPay != null && otPay != null ? Math.round((regularPay + otPay) * 100) / 100 : null;
            if (em) perEmployeePay[em] = { hours: row.hoursDecimal ?? 0, pay: initialPay };
            if (initialPay != null) { sum += initialPay; hasAnyPay = true; }
          }
        }

        if (!cancelled) {
          setPayrollEmailsNorm(paySet.size > 0 ? paySet : null);
          setPayrollWorkerCount(paySet.size > 0 ? paySet.size : null);
          setTotalPayout(hasAnyPay ? sum : null);
          setPayrollIdentityByEmail(mergePayrollIdentity(allPayrollRows));
          setEmployeePayByEmail(perEmployeePay);
        }
      } catch {
        if (!cancelled) {
          setTotalPayout(null);
          setPayrollEmailsNorm(null);
          setPayrollWorkerCount(null);
          setActiveSourceFile(null);
          setPayrollIdentityByEmail(null);
          setEmployeePayByEmail({});
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
        const eligMap = new Map<string, boolean>();

        for (const [email, mergedRow] of rowsByEmail) {
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
          const isEligible = allDays.length > 0 && allDays.every(d => d.passes);
          eligMap.set(email, isEligible);
          if (isEligible) {
            eligible++;
          } else {
            notEligible++;
          }
        }

        if (!cancelled) {
          setPabEligibilityByEmail(eligMap);
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
    if (pabFilter !== 'all') {
      list = list.filter((e) => {
        const emailKey = normEmail(e.work_email ?? e.personal_email ?? '') ?? '';
        const elig = emailKey ? pabEligibilityByEmail.get(emailKey) : undefined;
        return pabFilter === 'eligible' ? elig === true : elig === false;
      });
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
  }, [mergedEmployees, departmentFilter, searchQuery, pabFilter, pabEligibilityByEmail]);

  const totalPages = Math.max(1, Math.ceil(filteredEmployees.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, departmentFilter, pabFilter]);

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

  const activePeriod = useMemo(() => parsePeriodFromFilename(activeSourceFile), [activeSourceFile]);

  /** Expanded view: average pay and hours per active worker. */
  const { avgPay, avgHours } = useMemo(() => {
    const entries = Object.values(employeePayByEmail);
    if (entries.length === 0) return { avgPay: null as number | null, avgHours: null as number | null };
    let paySum = 0;
    let payCount = 0;
    let hoursSum = 0;
    for (const e of entries) {
      hoursSum += e.hours;
      if (e.pay != null) {
        paySum += e.pay;
        payCount += 1;
      }
    }
    return {
      avgPay: payCount > 0 ? paySum / payCount : null,
      avgHours: entries.length > 0 ? hoursSum / entries.length : null,
    };
  }, [employeePayByEmail]);

  /** Expanded view: top departments by headcount (merged master+hubstaff). */
  const departmentMix = useMemo(() => {
    const counts = new Map<string, number>();
    let total = 0;
    for (const e of mergedEmployees) {
      const key = (e.department ?? '—').trim() || '—';
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total += 1;
    }
    const sorted = [...counts.entries()]
      .map(([dept, n]) => ({ dept, count: n, pct: total > 0 ? (n / total) * 100 : 0 }))
      .sort((a, b) => b.count - a.count);
    return { total, rows: sorted };
  }, [mergedEmployees]);

  /** Quick lookup for rendering the activity feed with employee names. */
  const nameByEmail = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of mergedEmployees) {
      const key = normEmail(e.work_email ?? e.personal_email ?? '') ?? '';
      if (key && e.name) m.set(key, e.name);
    }
    return m;
  }, [mergedEmployees]);

  const totalPendingActions = (pendingDisputes ?? 0) + (pendingLeaves ?? 0);

  return (
    <div className={cn(
      'flex h-full min-h-0 flex-col gap-4 overflow-hidden p-5 transition-colors duration-300 ease-out dark:bg-[#0d1117]',
      viewMode === 'simple'
        ? 'bg-[#fafaf8] dark:bg-none'
        : 'bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 dark:bg-none',
    )}>
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">System Overview</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-500">Real-time HRIS and Payroll analytics</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* View mode toggle — with sliding active pill */}
          <div
            role="tablist"
            aria-label="View mode"
            className="relative inline-flex items-center rounded-md border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900"
          >
            {(['simple', 'expanded'] as const).map((mode) => {
              const isActive = viewMode === mode;
              const Icon = mode === 'simple' ? Rows3 : LayoutGrid;
              const label = mode === 'simple' ? 'Simple' : 'Expanded';
              return (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setViewMode(mode)}
                  className={cn(
                    'relative z-10 flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors duration-200',
                    isActive
                      ? 'text-white dark:text-zinc-900'
                      : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
                  )}
                >
                  {isActive && (
                    <motion.span
                      layoutId="overview-viewmode-pill"
                      aria-hidden
                      className="absolute inset-0 rounded bg-zinc-900 dark:bg-zinc-100"
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-1.5">
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-initial">
            <FileText className="h-4 w-4 shrink-0 text-orange-500" />
            <select
              value={selectedSourceFile ?? ''}
              onChange={(e) => setSelectedSourceFile(e.target.value || null)}
              className="h-8 w-full min-w-0 truncate rounded-md border border-zinc-200 bg-white px-2 pr-7 font-mono text-xs text-zinc-700 sm:w-auto sm:max-w-[340px] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            >
              <option value="__all__">All Time (all uploads combined)</option>
              {sourceFiles.map((file, i) => (
                <option key={file} value={file}>
                  {file}{i === 0 ? ' (latest)' : ''}
                </option>
              ))}
            </select>
            {payoutLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-500" />}
          </div>
        </div>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {viewMode === 'simple' ? (
          <motion.div
            key="simple"
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <SimpleView
              totalPayout={totalPayout}
              payoutLoading={payoutLoading}
              payrollWorkerCount={payrollWorkerCount}
              masterTotal={employees.length}
              inPayrollNotMaster={inPayrollNotMaster}
              inMasterNotPayroll={inMasterNotPayroll}
              pendingDisputes={pendingDisputes}
              oldestDisputeDays={oldestDisputeDays}
              pendingLeaves={pendingLeaves}
              weekOrphanageVisits={weekOrphanageVisits}
              pabMetrics={pabMetrics}
              techBonusEligibility={techBonusEligibility}
              pageRows={pageRows}
              filteredTotal={filteredEmployees.length}
              totalPages={totalPages}
              safePage={safePage}
              setPage={setPage}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              departmentFilter={departmentFilter}
              setDepartmentFilter={setDepartmentFilter}
              departmentOptions={departmentOptions}
              activeSourceFile={activeSourceFile}
              activePeriod={activePeriod}
              employeePayByEmail={employeePayByEmail}
              onViewRates={onViewRates}
              onNavigate={onNavigate}
              loading={loading}
              pabEligibilityByEmail={pabEligibilityByEmail}
              pabFilter={pabFilter}
              setPabFilter={setPabFilter}
            />
          </motion.div>
        ) : (
          <motion.div
            key="expanded"
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-px lg:overflow-hidden"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >

      {/* Compact 6-tile KPI strip */}
      <div className="grid shrink-0 grid-cols-2 gap-2 overflow-hidden rounded-xl bg-white ring-1 ring-orange-200/90 sm:grid-cols-3 lg:grid-cols-6 dark:bg-zinc-900/40 dark:ring-blue-900/70">
        <KpiTile
          label="Total payout"
          value={
            payoutLoading
              ? '…'
              : totalPayout != null
                ? '₱' + totalPayout.toLocaleString('en-PH', { maximumFractionDigits: 0 })
                : '—'
          }
          sub={activeSourceFile ? 'latest file' : selectedSourceFile === '__all__' ? 'all uploads' : 'pending'}
          icon={<DollarSign className="h-3.5 w-3.5" />}
        />
        <KpiTile
          label="Active workers"
          value={payrollWorkerCount != null ? String(payrollWorkerCount) : '—'}
          sub={`of ${employees.length} on master`}
          icon={<Users className="h-3.5 w-3.5" />}
        />
        <KpiTile
          label="Avg pay / worker"
          value={avgPay != null ? '₱' + Math.round(avgPay).toLocaleString('en-PH') : '—'}
          sub="initial pay"
          icon={<DollarSign className="h-3.5 w-3.5" />}
        />
        <KpiTile
          label="Avg hours / worker"
          value={avgHours != null ? avgHours.toFixed(1) + 'h' : '—'}
          sub="this period"
          icon={<Clock className="h-3.5 w-3.5" />}
        />
        <KpiTile
          label="Reconcile gaps"
          value={
            inPayrollNotMaster != null && inMasterNotPayroll != null
              ? String(inPayrollNotMaster + inMasterNotPayroll)
              : '—'
          }
          sub={
            inPayrollNotMaster != null && inMasterNotPayroll != null
              ? `${inPayrollNotMaster}↑ · ${inMasterNotPayroll}↓`
              : ''
          }
          tone={
            inPayrollNotMaster != null && inMasterNotPayroll != null && inPayrollNotMaster + inMasterNotPayroll > 0
              ? 'warn'
              : 'normal'
          }
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
        />
        <KpiTile
          label="Pending actions"
          value={String(totalPendingActions)}
          sub={`${pendingDisputes ?? 0} disputes · ${pendingLeaves ?? 0} leaves`}
          tone={totalPendingActions > 0 ? 'warn' : 'normal'}
          icon={<AlertCircle className="h-3.5 w-3.5" />}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:min-h-0 lg:flex-1 lg:overflow-hidden lg:grid-cols-3 2xl:grid-cols-4">
        <Card size="sm" className="flex min-h-0 flex-col overflow-hidden bg-gradient-to-br from-white to-blue-50/20 shadow-sm ring-1 ring-orange-200/90 max-h-[70vh] lg:max-h-none dark:bg-none dark:from-blue-950/20 dark:to-blue-950/5 dark:ring-blue-900/70 lg:col-span-2 2xl:col-span-3">
          <CardHeader className="shrink-0 flex flex-row items-center justify-between gap-4 pb-1.5">
            <CardTitle className="text-base font-semibold text-zinc-900 dark:text-white">Employees</CardTitle>
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
                No employees to show. Import the roster with{' '}
                <span className="font-medium">Admin → Overview → Global master list CSV</span>, or load{' '}
                <code className="font-mono text-xs text-zinc-800 dark:text-zinc-400">global_master_list</code> in Supabase (
                <code className="font-mono text-xs text-zinc-800 dark:text-zinc-400">NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE</code>
                ), and/or upload Hubstaff hours so payroll can list workers.
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

                {/* Mobile cards — md:hidden */}
                <div className="grid min-h-0 flex-1 auto-rows-max gap-3 overflow-y-auto sm:grid-cols-2 md:hidden">
                  {pageRows.length === 0 ? (
                    <p className="col-span-full py-6 text-center text-sm text-zinc-500 dark:text-zinc-500">
                      No employees match your search or filter.
                    </p>
                  ) : (
                    pageRows.map((row, i) => {
                      const email = row.work_email ?? row.personal_email ?? '';
                      const disabled = !email || !onViewRates;
                      return (
                        <div
                          key={`${row.recordSource}-${row.personal_email ?? ''}-${row.name ?? ''}-${(safePage - 1) * PAGE_SIZE + i}`}
                          className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/40"
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            {row.employee_id && (
                              <span className="inline-flex items-center rounded-md border border-orange-200 bg-orange-50 px-2 py-0.5 font-mono text-xs font-semibold text-orange-700 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-400">
                                {row.employee_id}
                              </span>
                            )}
                            {row.recordSource === 'hubstaff' ? (
                              <Badge variant="outline" className="border-sky-300 bg-sky-50 font-mono text-[10px] text-sky-800 dark:border-sky-800/60 dark:bg-sky-950/40 dark:text-sky-300">
                                Hubstaff
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="border-emerald-300 bg-emerald-50 font-mono text-[10px] text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300">
                                Master
                              </Badge>
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate font-medium text-zinc-900 dark:text-white">{row.name ?? '—'}</div>
                            <div className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{row.personal_email ?? row.work_email ?? '—'}</div>
                            {row.department && (
                              <div className="mt-1 text-[11.5px] text-zinc-600 dark:text-zinc-400">{row.department}</div>
                            )}
                            {row.start_date && (
                              <div className="text-[11px] text-zinc-400 dark:text-zinc-600">{formatStartDate(row.start_date)}</div>
                            )}
                            {(() => {
                              const loc = [row.city, row.province].filter(Boolean).join(', ');
                              return loc ? (
                                <div className="mt-1 flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                                  <MapPin className="h-3 w-3 shrink-0" />
                                  <span className="truncate">{loc}</span>
                                </div>
                              ) : null;
                            })()}
                          </div>
                          <div className="flex justify-end border-t border-zinc-100 pt-3 dark:border-zinc-800">
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
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Desktop table — hidden on mobile */}
                <div className="hidden min-h-0 flex-1 overflow-auto rounded-md border border-zinc-200 md:block dark:border-zinc-800">
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
                              <div>{row.personal_email ?? row.work_email ?? '—'}</div>
                              {(() => {
                                const loc = [row.city, row.province].filter(Boolean).join(', ');
                                return loc ? (
                                  <div className="mt-0.5 flex items-center gap-1 font-sans text-[11px] text-zinc-400 dark:text-zinc-500">
                                    <MapPin className="h-3 w-3" />
                                    {loc}
                                  </div>
                                ) : null;
                              })()}
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

        {/* Side stack: bonuses · department mix · pending activity */}
        <div className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto">
          {/* Bonuses compact */}
          <Card size="sm" className="shrink-0 overflow-hidden bg-gradient-to-br from-white to-orange-50/20 shadow-sm ring-1 ring-orange-200/90 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/5 dark:ring-blue-900/70">
            <CardHeader className="shrink-0 pb-1.5">
              <CardTitle className="text-base font-semibold text-zinc-900 dark:text-white">Bonuses</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <CompactBonus
                icon={<Award className="h-3.5 w-3.5 text-indigo-500" />}
                label="Perfect Attendance"
                sub={pabMetrics.monthLabel ?? 'Month pending'}
                amount="₱5,000"
                eligible={pabMetrics.eligible}
                total={pabTotalForExpanded(pabMetrics)}
                loading={pabMetrics.loading}
                barClass="bg-gradient-to-r from-emerald-400 to-emerald-500"
              />
              <CompactBonus
                icon={<Laptop className="h-3.5 w-3.5 text-sky-500" />}
                label="Technology"
                sub="3rd paycheck · after 30d"
                amount="₱1,850"
                eligible={techBonusEligibility.eligible}
                total={techBonusEligibility.total}
                barClass="bg-sky-500"
              />
            </CardContent>
          </Card>

          {/* Department mix */}
          <Card size="sm" className="shrink-0 overflow-hidden bg-white shadow-sm ring-1 ring-orange-200/90 dark:bg-zinc-900/40 dark:ring-blue-900/70">
            <CardHeader className="shrink-0 flex flex-row items-center justify-between pb-1.5">
              <CardTitle className="text-base font-semibold text-zinc-900 dark:text-white">Department mix</CardTitle>
              <Badge variant="outline" className="border-zinc-200 bg-zinc-50 font-mono text-[10px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                {departmentMix.total} total
              </Badge>
            </CardHeader>
            <CardContent className="pb-3">
              {departmentMix.rows.length === 0 ? (
                <p className="py-2 text-xs text-zinc-400">No employees loaded.</p>
              ) : (
                <div className="max-h-[18rem] space-y-1.5 overflow-y-auto pr-1.5 [-webkit-overflow-scrolling:touch] [scrollbar-gutter:stable]">
                  {departmentMix.rows.map((row) => (
                    <div key={row.dept} className="space-y-0.5">
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="truncate text-zinc-700 dark:text-zinc-300" title={row.dept}>
                          {row.dept}
                        </span>
                        <span className="font-mono tabular-nums text-zinc-500 dark:text-zinc-400">
                          {row.count}
                          <span className="ml-1 text-[10px] text-zinc-400">
                            {row.pct.toFixed(0)}%
                          </span>
                        </span>
                      </div>
                      <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                        <div
                          className="h-full bg-orange-400/70 transition-all duration-500 dark:bg-blue-500/70"
                          style={{ width: `${Math.max(2, row.pct)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Pending activity */}
          <Card size="sm" className="flex min-h-[220px] flex-col overflow-hidden bg-white shadow-sm ring-1 ring-orange-200/90 dark:bg-zinc-900/40 dark:ring-blue-900/70">
            <CardHeader className="shrink-0 flex flex-row items-center justify-between pb-1.5">
              <CardTitle className="text-base font-semibold text-zinc-900 dark:text-white">Pending</CardTitle>
              <Badge
                variant="outline"
                className={cn(
                  'font-mono text-[10px]',
                  totalPendingActions > 0
                    ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-400'
                    : 'border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400',
                )}
              >
                {totalPendingActions} actions
              </Badge>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 overflow-y-auto">
              {pendingDisputeRows.length === 0 && (pendingLeaves ?? 0) === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-1.5 py-6 text-center">
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">All caught up.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {pendingDisputeRows.slice(0, 6).map((row) => {
                    const name = nameByEmail.get(row.work_email) ?? row.work_email;
                    const ageDays = row.created_at
                      ? Math.max(
                          0,
                          Math.floor((Date.now() - new Date(row.created_at).getTime()) / 86400000),
                        )
                      : null;
                    return (
                      <button
                        type="button"
                        key={row.id}
                        onClick={() => onNavigate?.('disputes')}
                        className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                      >
                        <span className="mt-1 inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px] font-medium text-zinc-800 dark:text-zinc-200">
                            {name}
                          </div>
                          <div className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                            Dispute · {row.dispute_date}
                            {ageDays != null && (
                              <span className="ml-1.5 text-zinc-400">· {ageDays}d ago</span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                  {(pendingLeaves ?? 0) > 0 && (
                    <button
                      type="button"
                      onClick={() => onNavigate?.('leave-requests')}
                      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                    >
                      <span className="mt-1 inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] font-medium text-zinc-800 dark:text-zinc-200">
                          Leave requests
                        </div>
                        <div className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                          {pendingLeaves} awaiting approval
                        </div>
                      </div>
                    </button>
                  )}
                  {pendingDisputeRows.length > 6 && (
                    <button
                      type="button"
                      onClick={() => onNavigate?.('disputes')}
                      className="flex w-full items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-100"
                    >
                      +{pendingDisputeRows.length - 6} more disputes
                      <ArrowRight className="h-3 w-3" />
                    </button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
