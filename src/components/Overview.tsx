"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Users,
  DollarSign,
  Download,
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
import EmployeePabCalendar from './employee/EmployeePabCalendar';
import { X } from 'lucide-react';
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
  getCurrentPabMonth,
  getPabMonthRange,
  resolveCanonicalColumnsToIso,
  columnsAreAllCanonical,
  buildPabCalendarWeeks,
  checkHslPabEligibility,
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

/** Hourglass with animated sand draining top → bottom. */
function AnimatedHourglass() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 xl:h-6 xl:w-6" fill="none">
      <defs>
        {/* Top sand clip: y moves from 2→11, height shrinks 9→0 — surface drops toward neck */}
        <clipPath id="hg-top">
          <rect x="0" width="24">
            <animate attributeName="y" from="2" to="11" dur="2.5s" repeatCount="indefinite" />
            <animate attributeName="height" from="9" to="0" dur="2.5s" repeatCount="indefinite" />
          </rect>
        </clipPath>
        {/* Bottom sand clip: y moves from 22→13, height grows 0→9 — pile builds from bottom */}
        <clipPath id="hg-bot">
          <rect x="0" width="24">
            <animate attributeName="y" from="22" to="13" dur="2.5s" repeatCount="indefinite" />
            <animate attributeName="height" from="0" to="9" dur="2.5s" repeatCount="indefinite" />
          </rect>
        </clipPath>
      </defs>

      {/* Top sand */}
      <polygon points="2,2 22,2 13,11 11,11" fill="#f59e0b" clipPath="url(#hg-top)" />
      {/* Bottom sand */}
      <polygon points="2,22 22,22 13,13 11,13" fill="#f59e0b" clipPath="url(#hg-bot)" />

      {/* Hourglass frame */}
      <path
        d="M2 2 L22 2 L13 11 L13 13 L22 22 L2 22 L11 13 L11 11 Z"
        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"
        className="text-zinc-500 dark:text-zinc-400"
      />

      {/* Falling sand stream through neck */}
      <rect x="11.5" y="11" width="1" height="2" fill="#f59e0b">
        <animate attributeName="opacity" values="0.9;0.3;0.9" dur="0.35s" repeatCount="indefinite" />
        <animate attributeName="y" values="11;11.8;11" dur="0.35s" repeatCount="indefinite" />
      </rect>
    </svg>
  );
}

const MIX_COLORS = [
  '#f97316', '#0d9488', '#7c3aed', '#0891b2', '#db2777',
  '#10b981', '#ca8a04', '#4f46e5', '#16a34a', '#be185d',
  '#ea580c', '#0369a1', '#6d28d9', '#b45309', '#15803d',
  '#1d4ed8', '#7e22ce', '#c2410c', '#047857', '#9d174d',
];

type MixRow = { dept: string; count: number; pct: number };

function DeptMixPieChart({ rows, total }: { rows: MixRow[]; total: number }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const SIZE = 180;
  const cx = SIZE / 2; const cy = SIZE / 2;
  const outerR = 78; const innerR = 44;

  function polar(deg: number, r: number) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function slicePath(s: number, e: number) {
    if (e - s >= 359.99) {
      const t = polar(0, outerR); const b = polar(180, outerR);
      const it = polar(0, innerR); const ib = polar(180, innerR);
      return `M ${t.x} ${t.y} A ${outerR} ${outerR} 0 1 1 ${b.x} ${b.y} A ${outerR} ${outerR} 0 1 1 ${t.x} ${t.y} M ${it.x} ${it.y} A ${innerR} ${innerR} 0 1 0 ${ib.x} ${ib.y} A ${innerR} ${innerR} 0 1 0 ${it.x} ${it.y} Z`;
    }
    const large = e - s > 180 ? 1 : 0;
    const s1 = polar(s, outerR); const e1 = polar(e, outerR);
    const s2 = polar(e, innerR); const e2 = polar(s, innerR);
    return `M ${s1.x} ${s1.y} A ${outerR} ${outerR} 0 ${large} 1 ${e1.x} ${e1.y} L ${s2.x} ${s2.y} A ${innerR} ${innerR} 0 ${large} 0 ${e2.x} ${e2.y} Z`;
  }

  let cum = 0;
  const slices = rows.map((r, i) => {
    const start = cum; cum += (r.count / total) * 360;
    return { ...r, start, end: cum, color: MIX_COLORS[i % MIX_COLORS.length]! };
  });

  const hov = slices.find((s) => s.dept === hovered);

  if (total === 0) return <p className="py-2 text-xs text-zinc-400">No employees loaded.</p>;

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ overflow: 'visible' }}>
        {slices.map((s, i) => (
          <motion.path
            key={s.dept}
            d={slicePath(s.start, s.end)}
            fill={s.color}
            initial={{ opacity: 0 }}
            animate={{ opacity: hovered && hovered !== s.dept ? 0.28 : 1 }}
            transition={{ duration: 0.22, delay: hovered ? 0 : i * 0.025 }}
            onMouseEnter={() => setHovered(s.dept)}
            onMouseLeave={() => setHovered(null)}
            style={{ cursor: 'pointer' }}
          />
        ))}
        <text x={cx} y={cy - 5} textAnchor="middle" fontSize="18" fontWeight="700" fill="#18181b">
          {hov ? hov.count : total}
        </text>
        <text x={cx} y={cy + 10} textAnchor="middle" fontSize="9" fill="#a1a1aa">
          {hov ? hov.dept.slice(0, 13) : 'employees'}
        </text>
      </svg>
      <div className="max-h-[12rem] w-full overflow-y-auto space-y-0.5 pr-0.5">
        {slices.map((s) => (
          <div
            key={s.dept}
            className={`flex cursor-default items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] transition-colors ${hovered === s.dept ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'}`}
            onMouseEnter={() => setHovered(s.dept)}
            onMouseLeave={() => setHovered(null)}
          >
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: s.color }} />
            <span className="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-400">{s.dept}</span>
            <span className="shrink-0 font-mono tabular-nums text-zinc-700 dark:text-zinc-300">{s.count}</span>
            <span className="shrink-0 text-[10px] text-zinc-400">{s.pct.toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
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
    periodEnd: Date | null;
    pabMonth: { year: number; month: number } | null;
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
  monthFilter: string;
  setMonthFilter: (v: string) => void;
  monthOptions: { value: string; label: string }[];
  activeSourceFile: string | null;
  activePeriod: { label: string; week: number | null } | null;
  employeePayByEmail: Record<string, { hours: number; pay: number | null }>;
  onViewRates?: (email: string) => void;
  onNavigate?: (tab: string) => void;
  loading: boolean;
  pabEligibilityByEmail: Map<string, boolean>;
  pabFilter: 'all' | 'eligible' | 'not-eligible';
  setPabFilter: (v: 'all' | 'eligible' | 'not-eligible') => void;
  onExportCsv: () => void;
  /** Live status of the dashboard data feeds — drives the hero pill animation. */
  apiStatus: 'loading' | 'error' | 'live';
  /** Round-trip ms of the most recent API probe — revealed on pill hover. */
  apiLatencyMs: number | null;
  /** Trigger a fresh API ping (used on pill hover) so the MS readout stays current. */
  onPingApi: () => void;
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
  monthFilter,
  setMonthFilter,
  monthOptions,
  activeSourceFile,
  activePeriod,
  employeePayByEmail,
  onViewRates,
  onNavigate,
  loading,
  pabEligibilityByEmail,
  pabFilter,
  setPabFilter,
  onExportCsv,
  apiStatus,
  apiLatencyMs,
  onPingApi,
}: SimpleViewProps) {
  // Hover state for the API status pill — drives the ping ripple + MS readout reveal.
  const [pillHovered, setPillHovered] = useState(false);
  // Bumped every time we trigger a hover-ping; used as a key so the ripple replays.
  const [pingNonce, setPingNonce] = useState(0);
  const [pabCalEmail, setPabCalEmail] = useState<string | null>(null);

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

        {/* Hero — branded chip, accent rule, floating orbs in the corners */}
        <section className="relative mb-5 overflow-hidden rounded-3xl border border-orange-100/80 bg-gradient-to-br from-stone-50 via-orange-50/35 to-blue-50/25 p-5 shadow-[0_12px_32px_-16px_rgba(255,138,76,0.12)] [@media(max-height:900px)]:mb-4 [@media(max-height:900px)]:p-4 lg:mb-8 lg:p-7 xl:mb-10 xl:p-8 dark:border-orange-900/30 dark:from-zinc-950 dark:via-orange-950/15 dark:to-blue-950/15">
          {/* Decorative orbs — pure dopamine */}
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.9 }}
              className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-orange-300/30 blur-3xl dark:bg-orange-500/15"
            />
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 1.1, delay: 0.1 }}
              className="absolute -right-20 top-12 h-64 w-64 rounded-full bg-rose-300/25 blur-3xl dark:bg-rose-500/15"
            />
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 1.3, delay: 0.2 }}
              className="absolute bottom-0 left-1/3 h-56 w-56 rounded-full bg-blue-300/20 blur-3xl dark:bg-blue-500/15"
            />
          </div>

          <motion.div
            initial="hidden"
            animate="visible"
            variants={{
              hidden: { opacity: 0 },
              visible: { opacity: 1, transition: { staggerChildren: 0.06, delayChildren: 0.05 } },
            }}
            className="relative grid grid-cols-1 items-end gap-4 lg:gap-6 lg:grid-cols-[1fr_auto] xl:gap-8"
          >
            <motion.div
              variants={{ hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } }}
            >
              {/* Caption pill — icon pulses continuously based on API status; hover triggers a ping ripple + reveals MS */}
              <motion.button
                type="button"
                onMouseEnter={() => {
                  setPillHovered(true);
                  setPingNonce((n) => n + 1);
                  onPingApi();
                }}
                onMouseLeave={() => setPillHovered(false)}
                onFocus={() => {
                  setPillHovered(true);
                  setPingNonce((n) => n + 1);
                  onPingApi();
                }}
                onBlur={() => setPillHovered(false)}
                className={cn(
                  'group relative mb-3 inline-flex cursor-pointer items-center gap-1.5 overflow-visible rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] backdrop-blur-md transition-[colors,box-shadow] duration-300',
                  apiStatus === 'error'
                    ? 'border-rose-200/80 bg-stone-50/70 text-rose-700 hover:shadow-[0_0_0_3px_rgba(244,63,94,0.12)] dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300'
                    : apiStatus === 'loading'
                      ? 'border-amber-200/80 bg-stone-50/70 text-amber-700 hover:shadow-[0_0_0_3px_rgba(245,158,11,0.15)] dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300'
                      : 'border-orange-200/80 bg-stone-50/70 text-orange-700 hover:shadow-[0_0_0_3px_rgba(249,115,22,0.15)] dark:border-orange-900/40 dark:bg-orange-950/30 dark:text-orange-300',
                )}
                animate={apiStatus === 'error' ? { x: [0, -1.5, 1.5, -1.5, 1.5, 0] } : { x: 0 }}
                transition={
                  apiStatus === 'error'
                    ? { duration: 0.45, repeat: Infinity, repeatDelay: 1.4, ease: 'easeInOut' }
                    : { duration: 0.2 }
                }
                aria-live="polite"
                aria-label={
                  apiStatus === 'loading'
                    ? 'Dashboard data is syncing'
                    : apiStatus === 'error'
                      ? 'Dashboard data feed is offline'
                      : `Dashboard is live${apiLatencyMs != null ? `, API responding in ${apiLatencyMs} milliseconds` : ''}`
                }
              >
                {/* Hover ping — single expanding ring that replays each time the user re-enters */}
                <motion.span
                  key={pingNonce}
                  aria-hidden
                  className={cn(
                    'pointer-events-none absolute inset-0 rounded-full border-2 opacity-0',
                    apiStatus === 'error'
                      ? 'border-rose-400/70 dark:border-rose-400/60'
                      : apiStatus === 'loading'
                        ? 'border-amber-400/70 dark:border-amber-400/60'
                        : 'border-orange-400/80 dark:border-orange-400/60',
                  )}
                  initial={{ opacity: 0, scale: 1 }}
                  animate={pillHovered ? { opacity: [0.7, 0], scale: [1, 1.6] } : { opacity: 0, scale: 1 }}
                  transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
                />

                <span className="relative inline-flex h-3 w-3 items-center justify-center">
                  {/* Halo ring 1 — primary continuous ripple */}
                  <motion.span
                    aria-hidden
                    className={cn(
                      'absolute inset-[-4px] rounded-full',
                      apiStatus === 'error'
                        ? 'bg-rose-400/50 dark:bg-rose-500/45'
                        : apiStatus === 'loading'
                          ? 'bg-amber-400/55 dark:bg-amber-500/50'
                          : 'bg-orange-400/55 dark:bg-orange-500/45',
                    )}
                    animate={
                      apiStatus === 'loading'
                        ? { opacity: [0, 0.75, 0], scale: [0.6, 1.7, 2.0] }
                        : apiStatus === 'error'
                          ? { opacity: [0, 0.4, 0], scale: [0.6, 1.4, 1.6] }
                          : { opacity: [0, 0.65, 0], scale: [0.55, 1.7, 2.0] }
                    }
                    transition={{
                      duration: apiStatus === 'loading' ? 1.1 : apiStatus === 'error' ? 1.6 : 2.2,
                      repeat: Infinity,
                      ease: 'easeOut',
                    }}
                  />
                  {/* Halo ring 2 — offset second ripple for an ECG-radar feel (live + loading only) */}
                  {apiStatus !== 'error' && (
                    <motion.span
                      aria-hidden
                      className={cn(
                        'absolute inset-[-4px] rounded-full',
                        apiStatus === 'loading'
                          ? 'bg-amber-300/40 dark:bg-amber-400/35'
                          : 'bg-orange-300/40 dark:bg-orange-400/35',
                      )}
                      animate={{ opacity: [0, 0.45, 0], scale: [0.5, 1.9, 2.3] }}
                      transition={{
                        duration: apiStatus === 'loading' ? 1.1 : 2.2,
                        repeat: Infinity,
                        ease: 'easeOut',
                        delay: apiStatus === 'loading' ? 0.55 : 1.1,
                      }}
                    />
                  )}
                  {/*
                    ECG-style pulse trace — runs left → right along a reversed Activity path.
                    A faint base trail shows the full waveform; a bright moving dash sweeps
                    along it via animated strokeDashoffset, like a hospital heart monitor.
                  */}
                  <svg
                    className="relative h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden
                  >
                    <path
                      d="M2 12h4l3 -9l6 18l3 -9h4"
                      stroke="currentColor"
                      strokeOpacity="0.32"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <motion.path
                      d="M2 12h4l3 -9l6 18l3 -9h4"
                      stroke="currentColor"
                      strokeWidth={2.85}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      pathLength={1}
                      strokeDasharray="0.26 0.74"
                      initial={{ strokeDashoffset: 0 }}
                      animate={{ strokeDashoffset: [0, -1] }}
                      transition={{
                        duration: apiStatus === 'loading' ? 0.85 : apiStatus === 'error' ? 2.2 : 1.5,
                        repeat: Infinity,
                        ease: 'linear',
                      }}
                    />
                  </svg>
                </span>

                <span>
                  Dashboard ·{' '}
                  {apiStatus === 'loading' ? 'syncing' : apiStatus === 'error' ? 'offline' : 'live'}
                </span>

                {/* MS readout — animates in when the pill is hovered/focused */}
                <AnimatePresence initial={false}>
                  {pillHovered && apiStatus !== 'error' && (
                    <motion.span
                      key="ms-readout"
                      initial={{ width: 0, opacity: 0, marginLeft: 0 }}
                      animate={{ width: 'auto', opacity: 1, marginLeft: 4 }}
                      exit={{ width: 0, opacity: 0, marginLeft: 0 }}
                      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                      className="overflow-hidden whitespace-nowrap"
                    >
                      <span
                        className={cn(
                          'ml-1 inline-flex items-center gap-1 rounded-full px-1.5 py-px font-mono text-[9.5px] font-bold tabular-nums tracking-normal',
                          apiStatus === 'loading'
                            ? 'bg-amber-100/80 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                            : 'bg-orange-100/80 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200',
                        )}
                      >
                        <span aria-hidden className="inline-block h-1 w-1 rounded-full bg-current" />
                        {apiLatencyMs != null ? `${apiLatencyMs}ms` : '—'}
                      </span>
                    </motion.span>
                  )}
                </AnimatePresence>
              </motion.button>
              <p className="mb-2 text-[13px] text-zinc-600 [@media(max-height:900px)]:mb-1 lg:mb-3 dark:text-zinc-400">
                {greeting}.{' '}
                <span className="bg-gradient-to-r from-orange-600 to-rose-500 bg-clip-text font-semibold text-transparent dark:from-orange-400 dark:to-rose-400">
                  Accounting team
                </span>{' '}
                dashboard.
              </p>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-orange-700/80 xl:mb-3 dark:text-orange-400/80">
                Total payout · this accounting pay run
              </p>
              <div className="flex items-baseline">
                <span className="mr-1.5 text-4xl font-medium text-zinc-400 lg:text-5xl xl:text-6xl 2xl:text-7xl dark:text-zinc-500">
                  ₱
                </span>
                {payoutLoading ? (
                  <span className="inline-block h-[1em] w-[220px] animate-pulse rounded-md bg-zinc-200/80 align-bottom text-4xl lg:w-[280px] lg:text-5xl xl:w-[360px] xl:text-6xl 2xl:w-[420px] 2xl:text-7xl dark:bg-zinc-800" />
                ) : (
                  <span className="font-mono text-4xl font-bold tracking-tight text-zinc-900 lg:text-5xl xl:text-6xl 2xl:text-7xl dark:text-white">
                    {totalPayout != null
                      ? totalPayout.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                      : '—'}
                  </span>
                )}
              </div>
              {/* Accent rule — orange→rose hairline under the hero number */}
              <div className="mt-2.5 h-[2px] w-16 rounded-full bg-gradient-to-r from-orange-500 to-rose-500 dark:from-orange-400 dark:to-rose-400" />
              <p className="mt-3 flex flex-wrap items-center gap-3 text-[13px] text-zinc-600 [@media(max-height:900px)]:mt-2 dark:text-zinc-400">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-flex h-5 items-center justify-center rounded-full bg-emerald-100 px-1.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                    {payrollWorkerCount ?? '—'}
                  </span>
                  active workers
                </span>
                {usdEquivalent != null && (
                  <>
                    <span className="text-zinc-300 dark:text-zinc-700">·</span>
                    <span>
                      ≈{' '}
                      <strong className="font-mono font-semibold text-zinc-900 dark:text-white">
                        ${usdEquivalent.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                      </strong>{' '}
                      USD
                    </span>
                  </>
                )}
                <span className="text-zinc-300 dark:text-zinc-700">·</span>
                <span>Initial pay · bonuses applied at payroll</span>
              </p>
            </motion.div>

            {/* Right rail — period pill + status pills with colored icon tiles */}
            <motion.div
              variants={{ hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } }}
              className="flex w-full flex-col gap-2.5 lg:w-auto lg:min-w-[280px]"
            >
              {activePeriod && (
                <div className="inline-flex items-center gap-2 self-start rounded-xl border border-orange-200/80 bg-stone-50/80 px-3 py-1.5 text-[11.5px] backdrop-blur-md lg:self-end dark:border-orange-900/40 dark:bg-zinc-900/70">
                  <CalendarDays className="h-3.5 w-3.5 text-orange-500 dark:text-orange-400" />
                  <span className="flex flex-col leading-tight">
                    <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-zinc-400 dark:text-zinc-500">
                      Payroll period
                    </span>
                    <span className="font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
                      {activePeriod.label}
                      {activePeriod.week != null && (
                        <span className="ml-1.5 text-zinc-400 dark:text-zinc-500">
                          · wk {activePeriod.week}
                        </span>
                      )}
                    </span>
                  </span>
                </div>
              )}
              <HeroStatRow
                Icon={Users}
                tone="neutral"
                label="Master list"
                value={masterTotal}
              />
              <HeroStatRow
                Icon={Activity}
                tone="info"
                label="In this payroll"
                value={payrollWorkerCount ?? null}
              />
              <HeroStatRow
                Icon={AlertTriangle}
                tone={reconcileGaps && reconcileGaps > 0 ? 'warn' : 'ok'}
                label="Reconcile gaps"
                value={reconcileGaps ?? null}
              />
            </motion.div>
          </motion.div>
        </section>

        {/* Attention row */}
        <section className="mb-6 grid grid-cols-1 gap-3.5 [@media(max-height:900px)]:mb-4 lg:mb-10 xl:mb-14 md:grid-cols-3">
          <AttentionCard
            icon={<AlertCircle />}
            label="Needs your decision"
            tone={pendingDisputes && pendingDisputes > 0 ? 'warn' : 'ok'}
            tag={disputeTag}
            value={pendingDisputes ?? 0}
            unit={pendingDisputes === 1 ? 'dispute pending' : 'disputes pending'}
            sub="Approve or deny short-day disputes"
            cta="Review queue"
            onClick={onNavigate ? () => onNavigate('disputes') : undefined}
          />
          <AttentionCard
            icon={<FileWarning />}
            label="Reconciliation"
            tone={reconcileGaps && reconcileGaps > 0 ? 'info' : 'ok'}
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
            icon={<CalendarDays />}
            label="Leave & visits"
            tone={leaveAndVisitsTotal > 0 ? 'ok' : 'neutral'}
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
            cta="Open in HR"
            onClick={() => { window.location.href = '/hr'; }}
          />
        </section>

        {/* Monthly bonuses */}
        <section className="mb-6 [@media(max-height:900px)]:mb-4 lg:mb-10 xl:mb-14">
          <div className="mb-3 flex items-baseline justify-between lg:mb-5">
            <h3 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-white">
              Monthly bonuses
            </h3>
            <span className="text-[12.5px] text-zinc-500 dark:text-zinc-400">
              {pabMetrics.monthLabel ?? '—'}
              {' · '}
              {activeSourceFile ? 'this Hubstaff cycle' : 'merged from all Hubstaff uploads'}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-6 [@media(max-height:900px)]:gap-5 md:grid-cols-2 lg:gap-8 xl:gap-12">
            {/* PAB */}
            <div className="grid grid-cols-[120px_1fr] items-center gap-4 lg:gap-6 xl:gap-7">
              {pabMetrics.loading ? (
                <>
                  <div className="flex flex-col items-center gap-2.5">
                    <div className="h-20 w-20 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800 xl:h-24 xl:w-24" />
                    <span className="h-3 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                  </div>
                  <div className="space-y-2">
                    <div className="h-4 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                    <div className="h-3 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                    <div className="h-12 w-full animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
                  </div>
                </>
              ) : (() => {
                const today0 = new Date(); today0.setHours(0, 0, 0, 0);
                const periodEnd = pabMetrics.periodEnd ? new Date(pabMetrics.periodEnd) : null;
                if (periodEnd) periodEnd.setHours(0, 0, 0, 0);
                const inProgress = !!periodEnd && today0.getTime() <= periodEnd.getTime();
                return (
                  <>
                    <div className="flex flex-col items-center gap-2.5">
                      <div className="relative h-20 w-20 xl:h-24 xl:w-24">
                        <Donut
                          pct={inProgress ? 0 : pabPct}
                          color={inProgress ? '#b45309' : '#047857'}
                          fillContainer
                        />
                        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                          <span className="text-base font-semibold tracking-tight text-zinc-900 xl:text-xl dark:text-white">
                            {inProgress ? (
                              <AnimatedHourglass />
                            ) : pabTotal > 0 ? `${pabPct}%` : '—'}
                          </span>
                          {pabTotal > 0 && (
                            <span className="mt-0.5 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
                              {inProgress ? `${pabTotal} pending` : `${pabMetrics.eligible} / ${pabTotal}`}
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
                        {pabMetrics.monthLabel ?? '—'}
                        {' · '}
                        {inProgress
                          ? 'in progress'
                          : activeSourceFile ? 'selected cycle' : 'merged month'}
                      </p>
                      {inProgress ? (
                        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                          Period still open — final eligibility will be available after{' '}
                          {periodEnd?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.
                        </div>
                      ) : (
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
                      )}
                      <p className="mt-3.5 text-[11.5px] leading-snug text-zinc-400 dark:text-zinc-500">
                        {inProgress
                          ? `Tracking ${pabTotal} workers — accrual locks once period closes.`
                          : `Accrues ₱${(pabMetrics.eligible * 5000).toLocaleString('en-PH')} if all eligible hold through month end.`}
                      </p>
                    </div>
                  </>
                );
              })()}
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
              <select
                value={monthFilter}
                onChange={(e) => setMonthFilter(e.target.value)}
                className="h-8 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12.5px] font-medium text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
                title="PAB month"
              >
                <option value="">All months</option>
                {monthOptions.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
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
              <div className="ml-auto flex items-center gap-3">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  <strong className="font-semibold text-zinc-900 dark:text-white">{filteredTotal}</strong>{' '}
                  workers · page {safePage} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={onExportCsv}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-[12px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <Download className="h-3.5 w-3.5" />
                  Export CSV
                </button>
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
                    <th className="border-b border-zinc-200 bg-[#fafaf8] px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                      Employee ID
                    </th>
                    <th className="border-b border-zinc-200 bg-[#fafaf8] px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                      Source
                    </th>
                    <th className="border-b border-zinc-200 bg-[#fafaf8] px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                      Department
                    </th>
                    <th className="border-b border-zinc-200 bg-[#fafaf8] px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                      Name
                    </th>
                    <th className="border-b border-zinc-200 bg-[#fafaf8] px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                      Email
                    </th>
                    <th className="border-b border-zinc-200 bg-[#fafaf8] px-4 py-3 text-right text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                      Start Date
                    </th>
                    <th className="border-b border-zinc-200 bg-[#fafaf8] px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                      PAB
                    </th>
                    <th className="w-[90px] border-b border-zinc-200 bg-[#fafaf8] px-4 py-3 text-right text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loading || payoutLoading || pabMetrics.loading ? (
                    Array.from({ length: 8 }).map((_, i) => (
                      <tr
                        key={`skel-${i}`}
                        className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800/60"
                      >
                        <td className="px-4 py-3.5">
                          <span className="inline-block h-4 w-20 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                        </td>
                        <td className="px-4 py-3.5">
                          <span className="inline-block h-4 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                        </td>
                        <td className="px-4 py-3.5">
                          <span className="inline-block h-3 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                        </td>
                        <td className="px-4 py-3.5">
                          <span className="inline-block h-3 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                        </td>
                        <td className="px-4 py-3.5">
                          <span className="inline-block h-3 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                        </td>
                        <td className="px-4 py-3.5 text-right">
                          <span className="inline-block h-3 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                        </td>
                        <td className="px-4 py-3.5">
                          <span className="inline-block h-5 w-20 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
                        </td>
                        <td className="px-4 py-3.5 text-right">
                          <span className="inline-block h-7 w-14 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
                        </td>
                      </tr>
                    ))
                  ) : pageRows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
                        No workers match your search.
                      </td>
                    </tr>
                  ) : (
                    pageRows.map((row) => {
                      const email = row.work_email ?? row.personal_email ?? '';
                      const isHubstaff = row.recordSource === 'hubstaff';
                      return (
                        <tr
                          key={`${row.recordSource}-${email}-${row.name ?? ''}`}
                          className="border-b border-zinc-100 last:border-b-0 hover:bg-[#fafaf8] dark:border-zinc-800/60 dark:hover:bg-zinc-900/60"
                        >
                          <td className="px-4 py-3.5">
                            {row.employee_id ? (
                              <span className="inline-flex items-center rounded-md border border-orange-200 bg-orange-50 px-2 py-0.5 font-mono text-xs font-semibold text-orange-700 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-400">
                                {row.employee_id}
                              </span>
                            ) : (
                              <span className="text-xs text-zinc-400 dark:text-zinc-600">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3.5">
                            {isHubstaff ? (
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
                          </td>
                          <td className="px-4 py-3.5 text-zinc-800 dark:text-zinc-200">
                            {row.department ?? '—'}
                          </td>
                          <td className="px-4 py-3.5 font-medium text-zinc-800 dark:text-zinc-200">
                            {row.name ?? '—'}
                          </td>
                          <td className="px-4 py-3.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">
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
                          </td>
                          <td className="px-4 py-3.5 text-right text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                            {formatStartDate(row.start_date)}
                          </td>
                          <td className="px-4 py-3.5">
                            {(() => {
                              const emailKey = normEmail(email) ?? '';
                              const elig = emailKey ? pabEligibilityByEmail.get(emailKey) : undefined;
                              if (elig === undefined) {
                                return <span className="text-zinc-400 dark:text-zinc-600">—</span>;
                              }
                              const today0 = new Date(); today0.setHours(0, 0, 0, 0);
                              const periodEnd = pabMetrics.periodEnd ? new Date(pabMetrics.periodEnd) : null;
                              if (periodEnd) periodEnd.setHours(0, 0, 0, 0);
                              const inProgress = !!periodEnd && today0.getTime() <= periodEnd.getTime();
                              const tone = inProgress
                                ? 'amber'
                                : elig === true ? 'green' : 'red';
                              const label = inProgress
                                ? 'In Progress'
                                : elig === true ? 'Eligible' : 'Not eligible';
                              return (
                                <button
                                  type="button"
                                  onClick={() => email && setPabCalEmail(email)}
                                  disabled={!email}
                                  title="Open PAB calendar"
                                  className={cn(
                                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-all hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60',
                                    tone === 'green' && 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:hover:bg-emerald-900/50',
                                    tone === 'red'   && 'bg-red-100 text-red-800 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50',
                                    tone === 'amber' && 'bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:hover:bg-amber-900/50',
                                  )}
                                >
                                  {label}
                                  <CalendarDays className="h-2.5 w-2.5 opacity-70" />
                                </button>
                              );
                            })()}
                          </td>
                          <td className="px-4 py-3.5 text-right">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!email || !onViewRates}
                              onClick={() => email && onViewRates?.(email)}
                              className="h-7 border-orange-300 px-2 text-[11px] text-orange-700 hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-orange-700 dark:text-orange-400"
                            >
                              <Eye className="mr-1 h-3 w-3" />
                              View
                            </Button>
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

      {/* PAB calendar modal — opens when an Eligible/Not-eligible pill is clicked */}
      <AnimatePresence>
        {pabCalEmail && (
          <motion.div
            key="pab-cal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            onClick={() => setPabCalEmail(null)}
          >
            <motion.div
              key="pab-cal-panel"
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: 4 }}
              transition={{ type: 'spring', stiffness: 340, damping: 28, mass: 0.6 }}
              className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3 border-b border-zinc-200 bg-gradient-to-br from-indigo-50 via-white to-violet-50 px-5 py-3.5 dark:border-zinc-800 dark:from-indigo-950/30 dark:via-zinc-950 dark:to-violet-950/30">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <CalendarDays className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" />
                    <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">
                      PAB Calendar
                    </h2>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
                    {pabCalEmail}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPabCalEmail(null)}
                  className="shrink-0 rounded-md p-1 text-zinc-400 transition hover:bg-zinc-200/60 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <EmployeePabCalendar
                  employeeEmail={pabCalEmail}
                  trimToElapsedWeeks={false}
                  pabMonthOverride={pabMetrics.pabMonth}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

type AttentionTone = 'warn' | 'info' | 'ok' | 'neutral';

const ATTENTION_PALETTE: Record<AttentionTone, {
  ring: string;
  surface: string;
  iconTile: string;
  label: string;
  valueText: string;
  tag: string;
  cta: string;
  hoverShadow: string;
  blob: string;
}> = {
  warn: {
    ring: 'border-amber-200/70 hover:border-amber-300/90 dark:border-amber-900/40 dark:hover:border-amber-700/50',
    surface:
      'bg-gradient-to-br from-amber-50/85 via-orange-50/35 to-stone-50 dark:from-amber-950/40 dark:via-orange-950/20 dark:to-zinc-950',
    iconTile: 'bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-md shadow-amber-500/40',
    label: 'text-amber-800/90 dark:text-amber-300',
    valueText: 'text-amber-900 dark:text-amber-100',
    tag: 'bg-stone-50/80 text-amber-800 ring-1 ring-amber-200/70 dark:bg-zinc-900/70 dark:text-amber-300 dark:ring-amber-900/40',
    cta: 'text-amber-800 dark:text-amber-300',
    hoverShadow: 'group-hover:shadow-[0_12px_32px_-12px_rgba(245,158,11,0.35)]',
    blob: 'bg-amber-300/30 dark:bg-amber-500/15',
  },
  info: {
    ring: 'border-sky-200/70 hover:border-sky-300/90 dark:border-sky-900/40 dark:hover:border-sky-700/50',
    surface:
      'bg-gradient-to-br from-sky-50/85 via-blue-50/35 to-stone-50 dark:from-sky-950/40 dark:via-blue-950/20 dark:to-zinc-950',
    iconTile: 'bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-md shadow-blue-500/40',
    label: 'text-sky-800/90 dark:text-sky-300',
    valueText: 'text-sky-900 dark:text-sky-100',
    tag: 'bg-stone-50/80 text-sky-800 ring-1 ring-sky-200/70 dark:bg-zinc-900/70 dark:text-sky-300 dark:ring-sky-900/40',
    cta: 'text-sky-800 dark:text-sky-300',
    hoverShadow: 'group-hover:shadow-[0_12px_32px_-12px_rgba(59,130,246,0.35)]',
    blob: 'bg-sky-300/30 dark:bg-sky-500/15',
  },
  ok: {
    ring: 'border-emerald-200/70 hover:border-emerald-300/90 dark:border-emerald-900/40 dark:hover:border-emerald-700/50',
    surface:
      'bg-gradient-to-br from-emerald-50/85 via-teal-50/35 to-stone-50 dark:from-emerald-950/40 dark:via-teal-950/20 dark:to-zinc-950',
    iconTile: 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md shadow-emerald-500/40',
    label: 'text-emerald-800/90 dark:text-emerald-300',
    valueText: 'text-emerald-900 dark:text-emerald-100',
    tag: 'bg-stone-50/80 text-emerald-800 ring-1 ring-emerald-200/70 dark:bg-zinc-900/70 dark:text-emerald-300 dark:ring-emerald-900/40',
    cta: 'text-emerald-800 dark:text-emerald-300',
    hoverShadow: 'group-hover:shadow-[0_12px_32px_-12px_rgba(16,185,129,0.35)]',
    blob: 'bg-emerald-300/30 dark:bg-emerald-500/15',
  },
  neutral: {
    ring: 'border-zinc-200/80 hover:border-zinc-300 dark:border-zinc-800/80 dark:hover:border-zinc-700',
    surface: 'bg-gradient-to-br from-stone-50 to-stone-100/60 dark:from-zinc-900/60 dark:to-zinc-950',
    iconTile: 'bg-gradient-to-br from-zinc-700 to-zinc-900 text-white shadow-md shadow-zinc-900/30 dark:from-zinc-100 dark:to-zinc-300 dark:text-zinc-900',
    label: 'text-zinc-600 dark:text-zinc-400',
    valueText: 'text-zinc-900 dark:text-zinc-100',
    tag: 'bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-700',
    cta: 'text-zinc-900 dark:text-zinc-100',
    hoverShadow: 'group-hover:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.18)]',
    blob: 'bg-zinc-200/30 dark:bg-zinc-700/20',
  },
};

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
  /** Visual tone — drives gradient surface, icon tile, and accent palette. */
  tone: AttentionTone;
  tag: string | null;
  value: number;
  unit: string;
  sub: React.ReactNode;
  cta: string;
  onClick?: () => void;
}) {
  const interactive = !!onClick;
  const palette = ATTENTION_PALETTE[tone];
  const Tag = interactive ? motion.button : motion.div;
  return (
    <Tag
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      whileHover={interactive ? { y: -2 } : undefined}
      whileTap={interactive ? { scale: 0.99 } : undefined}
      transition={{ type: 'spring', stiffness: 320, damping: 24 }}
      className={cn(
        'group relative w-full overflow-hidden rounded-2xl border p-5 text-left shadow-sm transition-all duration-300',
        palette.ring,
        palette.surface,
        palette.hoverShadow,
        interactive && 'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40',
      )}
    >
      {/* Decorative corner blob — subtle bloom in the card's tone */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full blur-3xl transition-opacity duration-500 group-hover:opacity-80',
          palette.blob,
          'opacity-50',
        )}
      />

      <div className={cn('relative mb-4 flex items-start justify-between gap-3')}>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg [&_svg]:h-4 [&_svg]:w-4',
              palette.iconTile,
            )}
          >
            {icon}
          </span>
          <span
            className={cn(
              'text-[10px] font-semibold uppercase tracking-[0.16em]',
              palette.label,
            )}
          >
            {label}
          </span>
        </div>
        {tag && (
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-normal',
              palette.tag,
            )}
          >
            {tag}
          </span>
        )}
      </div>

      <div className="relative flex items-baseline gap-2">
        <span
          className={cn(
            'font-mono text-4xl font-bold leading-none tracking-tight tabular-nums',
            palette.valueText,
          )}
        >
          <AnimatedCounter value={value} />
        </span>
        <span className="font-sans text-sm font-medium text-zinc-500 dark:text-zinc-400">
          {unit}
        </span>
      </div>

      <p className="relative mt-2.5 text-[12.5px] leading-relaxed text-zinc-600 dark:text-zinc-400">
        {sub}
      </p>

      {interactive && (
        <div
          className={cn(
            'relative mt-4 inline-flex items-center gap-1 text-xs font-semibold',
            palette.cta,
          )}
        >
          {cta}
          <ArrowRight className="h-3 w-3 transition-transform duration-200 group-hover:translate-x-1" />
        </div>
      )}
    </Tag>
  );
}

/**
 * Compact horizontal stat row used in the hero's right rail. Status icon tile
 * on the left, label, then value right-aligned in mono. Tone drives the icon
 * tile + value color so "reconcile gaps" reads as warning when non-zero.
 */
function HeroStatRow({
  Icon,
  tone,
  label,
  value,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  tone: AttentionTone;
  label: string;
  value: number | null;
}) {
  const palette = ATTENTION_PALETTE[tone];
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-xl border bg-stone-50/70 px-3 py-2 backdrop-blur-md transition-colors',
        palette.ring,
        'dark:bg-zinc-900/60',
      )}
    >
      <span
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg [&_svg]:h-3.5 [&_svg]:w-3.5',
          palette.iconTile,
        )}
      >
        <Icon />
      </span>
      <span className="flex-1 truncate text-[11.5px] text-zinc-600 dark:text-zinc-400">
        {label}
      </span>
      <span
        className={cn(
          'font-mono text-sm font-semibold tabular-nums',
          palette.valueText,
        )}
      >
        {value == null ? '—' : value.toLocaleString('en-US')}
      </span>
    </div>
  );
}

/**
 * Lightweight count-up. Animates a numeric value over ~600ms with ease-out
 * cubic. Snaps to the final value when `prefers-reduced-motion` is set.
 */
function AnimatedCounter({ value, duration = 600 }: { value: number; duration?: number }) {
  const [n, setN] = React.useState(value);
  React.useEffect(() => {
    if (typeof window === 'undefined') {
      setN(value);
      return;
    }
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setN(value);
      return;
    }
    const start = performance.now();
    const from = n;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setN(Math.round(from + (value - from) * eased));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration]);
  return <>{n.toLocaleString('en-US')}</>;
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
  const [pabCalEmail, setPabCalEmail] = useState<string | null>(null);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [employeesError, setEmployeesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Round-trip time of the most recent /api/employees probe — drives the hero pill MS readout. */
  const [apiLatencyMs, setApiLatencyMs] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState<string>('');
  /** Month filter (YYYY-MM). Empty string = All months / no override. */
  const [monthFilter, setMonthFilter] = useState<string>('');
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

  /** PAB metrics — scoped to the currently selected source file (or merged across all when __all__). */
  const [pabMetrics, setPabMetrics] = useState<{
    loading: boolean;
    totalEmployees: number;
    eligible: number;
    notEligible: number;
    monthLabel: string | null;
    periodEnd: Date | null;
    pabMonth: { year: number; month: number } | null;
  }>({ loading: true, totalEmployees: 0, eligible: 0, notEligible: 0, monthLabel: null, periodEnd: null, pabMonth: null });

  const [pabEligibilityByEmail, setPabEligibilityByEmail] = useState<Map<string, boolean>>(new Map());
  const [pabFilter, setPabFilter] = useState<'all' | 'eligible' | 'not-eligible'>('all');

  /**
   * Tech Bonus eligibility: employees who have completed 30 days of service
   * by the **selected period's end date** (or today, if no period is loaded).
   * Picking April's CSV shows tech eligibility as of end-of-April.
   */
  const techBonusEligibility = useMemo(() => {
    const asOf = pabMetrics.periodEnd ?? new Date();
    const asOfMid = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate()).getTime();
    let eligible = 0;
    let pending = 0;
    let unknown = 0;
    for (const e of employees) {
      if (!e.start_date) { unknown += 1; continue; }
      const sd = new Date(e.start_date);
      if (isNaN(sd.getTime())) { unknown += 1; continue; }
      const eligibleFrom = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate() + 30).getTime();
      if (asOfMid >= eligibleFrom) eligible += 1;
      else pending += 1;
    }
    return { eligible, pending, unknown, total: employees.length };
  }, [employees, pabMetrics.periodEnd]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
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
          const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
          setApiLatencyMs(Math.max(0, Math.round(t1 - t0)));
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

  /**
   * Lightweight re-ping (re-issues GET /api/employees just to measure round-trip time).
   * Wired to the hero pill so hovering / tapping refreshes the MS readout without
   * re-loading any UI state. Discards the response payload — we only want timing.
   */
  const pingApiLatency = React.useCallback(async () => {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
      const res = await fetch('/api/employees', { cache: 'no-store' });
      // Drain the body so the connection closes cleanly; we don't read it.
      await res.text();
      const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      setApiLatencyMs(Math.max(0, Math.round(t1 - t0)));
    } catch {
      setApiLatencyMs(null);
    }
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

  // Compute PAB eligibility for the currently-selected source file
  // (or merged across every file when "__all__" is selected).
  useEffect(() => {
    if (sourceFiles.length === 0) return;
    let cancelled = false;
    setPabMetrics(prev => ({ ...prev, loading: true }));
    (async () => {
      try {
        const allCols = new Set<string>();
        const rowsByEmail = new Map<string, Record<string, unknown>>();

        // Always merge every source file so we have a complete picture of every
        // employee's hours. The currently-selected file only affects WHICH PAB
        // month we anchor the eligibility window to (computed below).
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
        let pabMonth: { year: number; month: number } | null = null;

        if (isValidManualPabRange(pabCfg)) {
          start = pabCfg.start;
          end = pabCfg.end;
          monthLabel = `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
          pabMonth = { year: end.getFullYear(), month: end.getMonth() };
        } else {
          // Anchor priority:
          //   1. monthFilter (explicit "Month" dropdown pick)
          //   2. older specific CSV (not the newest)
          //   3. current calendar month (default — keeps "In Progress" view fresh)
          if (monthFilter) {
            const m = /^(\d{4})-(\d{2})$/.exec(monthFilter);
            if (m) pabMonth = { year: +m[1], month: +m[2] - 1 };
          }
          if (!pabMonth) {
            const newest = sourceFiles[0] ?? null;
            const isCustomPick =
              !!selectedSourceFile &&
              selectedSourceFile !== '__all__' &&
              selectedSourceFile !== newest;
            if (isCustomPick) {
              const m = /(\d{4})-(\d{2})-(\d{2})_to_(\d{4})-(\d{2})-(\d{2})/.exec(selectedSourceFile);
              if (m) pabMonth = { year: +m[1], month: +m[2] - 1 };
            }
          }
          if (!pabMonth) pabMonth = getCurrentPabMonth();
          const r = getPabMonthRange(pabMonth.year, pabMonth.month);
          start = r.start;
          end = r.end;
          const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          monthLabel = `${monthNames[pabMonth.month]} ${pabMonth.year}`;
        }

        // Build HSL email set from master list for per-employee rule branching
        const hslMasterEmails = new Set<string>();
        for (const e of employees) {
          if (e.department?.trim().toLowerCase() === 'hsl') {
            const em = normEmail(e.personal_email ?? null) ?? normEmail(e.work_email ?? null);
            if (em) hslMasterEmails.add(em);
          }
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

          // Determine if this employee falls under the HSL rule.
          // Primary source: master list. Fallback: Job type column in the Hubstaff row
          // (covers Hubstaff-only workers not yet on the master list).
          const rawDept = String(
            mergedRow['Job type'] ?? mergedRow['job_type'] ?? mergedRow['Job Type'] ??
            mergedRow['department'] ?? mergedRow['Department'] ?? ''
          ).trim().toLowerCase();
          const isHsl = hslMasterEmails.has(email) || rawDept === 'hsl';

          let isEligible: boolean;
          if (isHsl) {
            // HSL rule: Mon–Sun weeks, ≥5 days at ≥7 h per week
            isEligible = checkHslPabEligibility(start, end, hoursByDateKey);
          } else {
            // Standard rule: all Mon–Fri days must be ≥7 h
            const weeks = buildPabCalendarWeeks(start, end, hoursByDateKey);
            const allDays = weeks.flat();
            isEligible = allDays.length > 0 && allDays.every(d => d.passes);
          }

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
            periodEnd: end,
            pabMonth,
          });
        }
      } catch {
        if (!cancelled) setPabMetrics({ loading: false, totalEmployees: 0, eligible: 0, notEligible: 0, monthLabel: null, periodEnd: null, pabMonth: null });
      }
    })();
    return () => { cancelled = true; };
  }, [sourceFiles, selectedSourceFile, monthFilter, employees]);

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

  /** Distinct months derived from source filenames (YYYY-MM-DD_to_YYYY-MM-DD), newest first. */
  const monthOptions = useMemo<{ value: string; label: string }[]>(() => {
    const seen = new Map<string, { year: number; month: number }>();
    for (const f of sourceFiles) {
      const m = /(\d{4})-(\d{2})-(\d{2})_to_(\d{4})-(\d{2})-(\d{2})/.exec(f);
      if (!m) continue;
      const y = +m[1];
      const mo = +m[2] - 1;
      const key = `${y}-${String(mo + 1).padStart(2, '0')}`;
      if (!seen.has(key)) seen.set(key, { year: y, month: mo });
    }
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return [...seen.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([value, { year, month }]) => ({ value, label: `${monthNames[month]} ${year}` }));
  }, [sourceFiles]);

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
  }, [searchQuery, departmentFilter, pabFilter, monthFilter]);

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

  const exportToCsv = () => {
    const headers = [
      'Name', 'Personal Email', 'Work Email', 'Department', 'Source', 'Employee ID',
      'Start Date', 'Hours', 'Initial Pay (PHP)', 'PAB Eligibility',
    ];
    const rows = filteredEmployees.map((row) => {
      const email = row.work_email ?? row.personal_email ?? '';
      const emailKey = normEmail(email) ?? '';
      const pay = emailKey ? employeePayByEmail[emailKey] : undefined;
      const elig = emailKey ? pabEligibilityByEmail.get(emailKey) : undefined;
      const pabStatus = elig === true ? 'Eligible' : elig === false ? 'Ineligible' : 'N/A';
      return [
        row.name ?? '',
        row.personal_email ?? '',
        row.work_email ?? '',
        row.department ?? '',
        row.recordSource === 'master' ? 'Master' : 'Hubstaff',
        row.employee_id ?? '',
        row.start_date ?? '',
        pay ? pay.hours.toFixed(2) : '',
        pay?.pay != null ? pay.pay.toFixed(2) : '',
        pabStatus,
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
    });
    const csv = [headers.map((h) => `"${h}"`).join(','), ...rows].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 10);
    const filterSuffix = pabFilter !== 'all' ? `_pab-${pabFilter}` : '';
    const deptSuffix = departmentFilter ? `_${departmentFilter.toLowerCase().replace(/\s+/g, '-')}` : '';
    a.download = `employees_${dateStr}${deptSuffix}${filterSuffix}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
            {(payoutLoading || pabMetrics.loading) && (
              <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-orange-600 dark:text-orange-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading…
              </span>
            )}
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
              monthFilter={monthFilter}
              setMonthFilter={setMonthFilter}
              monthOptions={monthOptions}
              activeSourceFile={activeSourceFile}
              activePeriod={activePeriod}
              employeePayByEmail={employeePayByEmail}
              onViewRates={onViewRates}
              onNavigate={onNavigate}
              loading={loading}
              pabEligibilityByEmail={pabEligibilityByEmail}
              pabFilter={pabFilter}
              setPabFilter={setPabFilter}
              onExportCsv={exportToCsv}
              apiStatus={
                employeesError
                  ? 'error'
                  : loading || payoutLoading || pabMetrics.loading
                    ? 'loading'
                    : 'live'
              }
              apiLatencyMs={apiLatencyMs}
              onPingApi={pingApiLatency}
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
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="border-blue-500/20 bg-blue-500/10 font-mono text-[10px] text-blue-700 dark:border-blue-500/30 dark:text-blue-400">
                master + Hubstaff fallback
              </Badge>
              <button
                type="button"
                onClick={exportToCsv}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-[11.5px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <Download className="h-3 w-3" />
                Export CSV
              </button>
            </div>
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
                <div className="flex shrink-0 flex-col gap-2">
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
                    <div className="w-full space-y-1.5 sm:w-44">
                      <Label htmlFor="month-filter" className="text-xs text-zinc-600 dark:text-zinc-500">
                        Month
                      </Label>
                      <select
                        id="month-filter"
                        value={monthFilter}
                        onChange={(e) => setMonthFilter(e.target.value)}
                        className={cn(
                          'h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900',
                          'outline-none focus-visible:border-orange-500 focus-visible:ring-2 focus-visible:ring-orange-500/30',
                          'dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-200',
                        )}
                      >
                        <option value="">All months</option>
                        {monthOptions.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {/* PAB filter */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">PAB:</span>
                    <div className="flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
                      {(['all', 'eligible', 'not-eligible'] as const).map((f) => {
                        const labels = { all: 'All', eligible: 'Eligible', 'not-eligible': 'Not Eligible' };
                        const active = pabFilter === f;
                        return (
                          <button
                            key={f}
                            type="button"
                            onClick={() => setPabFilter(f)}
                            className={cn(
                              'h-6 rounded-md px-2.5 text-[11px] font-medium transition-colors',
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
                    {pabFilter !== 'all' && (
                      <span className="text-[11px] text-zinc-400 dark:text-zinc-600">
                        {filteredEmployees.length} result{filteredEmployees.length !== 1 ? 's' : ''}
                      </span>
                    )}
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
                            {(() => {
                              const emailKey = normEmail(row.work_email ?? row.personal_email ?? '') ?? '';
                              const elig = emailKey ? pabEligibilityByEmail.get(emailKey) : undefined;
                              if (elig === true) return (
                                <Badge variant="outline" className="border-emerald-300 bg-emerald-50 font-mono text-[10px] text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300">
                                  PAB ✓
                                </Badge>
                              );
                              if (elig === false) return (
                                <Badge variant="outline" className="border-red-300 bg-red-50 font-mono text-[10px] text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-300">
                                  PAB ✗
                                </Badge>
                              );
                              return null;
                            })()}
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
                        <TableHead className="text-zinc-600 dark:text-zinc-400">PAB</TableHead>
                        <TableHead className="w-[90px] text-right text-zinc-600 dark:text-zinc-400">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {payoutLoading || pabMetrics.loading ? (
                        Array.from({ length: 8 }).map((_, i) => (
                          <TableRow
                            key={`skel-${i}`}
                            className="border-zinc-200 dark:border-zinc-800"
                          >
                            <TableCell><span className="inline-block h-4 w-20 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" /></TableCell>
                            <TableCell><span className="inline-block h-5 w-16 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" /></TableCell>
                            <TableCell><span className="inline-block h-3 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" /></TableCell>
                            <TableCell><span className="inline-block h-3 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" /></TableCell>
                            <TableCell><span className="inline-block h-3 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" /></TableCell>
                            <TableCell className="text-right"><span className="inline-block h-3 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" /></TableCell>
                            <TableCell><span className="inline-block h-5 w-20 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" /></TableCell>
                            <TableCell className="text-right"><span className="inline-block h-7 w-14 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" /></TableCell>
                          </TableRow>
                        ))
                      ) : pageRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={8} className="py-8 text-center text-zinc-600 dark:text-zinc-500">
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
                            <TableCell>
                              {(() => {
                                const rowEmail = row.work_email ?? row.personal_email ?? '';
                                const emailKey = normEmail(rowEmail) ?? '';
                                const elig = emailKey ? pabEligibilityByEmail.get(emailKey) : undefined;
                                if (elig === undefined) {
                                  return <span className="text-xs text-zinc-400 dark:text-zinc-600">—</span>;
                                }
                                const today0 = new Date(); today0.setHours(0, 0, 0, 0);
                                const periodEnd = pabMetrics.periodEnd ? new Date(pabMetrics.periodEnd) : null;
                                if (periodEnd) periodEnd.setHours(0, 0, 0, 0);
                                const inProgress = !!periodEnd && today0.getTime() <= periodEnd.getTime();
                                const tone = inProgress ? 'amber' : elig === true ? 'green' : 'red';
                                const label = inProgress ? 'In Progress' : elig === true ? 'Eligible' : 'Not eligible';
                                return (
                                  <button
                                    type="button"
                                    onClick={() => rowEmail && setPabCalEmail(rowEmail)}
                                    disabled={!rowEmail}
                                    title="Open PAB calendar"
                                    className={cn(
                                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-all hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60',
                                      tone === 'green' && 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:hover:bg-emerald-900/50',
                                      tone === 'red'   && 'bg-red-100 text-red-800 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50',
                                      tone === 'amber' && 'bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:hover:bg-amber-900/50',
                                    )}
                                  >
                                    {label}
                                    <CalendarDays className="h-2.5 w-2.5 opacity-70" />
                                  </button>
                                );
                              })()}
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
              <DeptMixPieChart rows={departmentMix.rows} total={departmentMix.total} />
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
                      onClick={() => { window.location.href = '/hr'; }}
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

      {/* PAB calendar modal — opens when an Eligible/Not-eligible pill is clicked in the worker table */}
      <AnimatePresence>
        {pabCalEmail && (
          <motion.div
            key="pab-cal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            onClick={() => setPabCalEmail(null)}
          >
            <motion.div
              key="pab-cal-panel"
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: 4 }}
              transition={{ type: 'spring', stiffness: 340, damping: 28, mass: 0.6 }}
              className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3 border-b border-zinc-200 bg-gradient-to-br from-indigo-50 via-white to-violet-50 px-5 py-3.5 dark:border-zinc-800 dark:from-indigo-950/30 dark:via-zinc-950 dark:to-violet-950/30">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <CalendarDays className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" />
                    <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">PAB Calendar</h2>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-400">{pabCalEmail}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setPabCalEmail(null)}
                  className="shrink-0 rounded-md p-1 text-zinc-400 transition hover:bg-zinc-200/60 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <EmployeePabCalendar
                  employeeEmail={pabCalEmail}
                  trimToElapsedWeeks={false}
                  pabMonthOverride={pabMetrics.pabMonth}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
