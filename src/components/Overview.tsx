"use client";

import React, { useEffect, useLayoutEffect as useLayoutEffectImpl, useMemo, useState } from 'react';
import { resolveFirstName } from '@/lib/name/first-name';

// `useLayoutEffect` warns on the server (no DOM). Map to `useEffect` during SSR
// so the warning stays silent; on the client both behave identically for our
// purposes (we only use it to read localStorage right after mount).
const useLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffectImpl;
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
  UserMinus,
  UserPlus,
  ArrowRight,
  LayoutGrid,
  Rows3,
  Activity,
  MapPin,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import EmployeePabCalendar from './employee/EmployeePabCalendar';
import PabCalendarLoader from './employee/PabCalendarLoader';
import { type AttentionTone, ATTENTION_PALETTE, HeroStatRow } from '@/components/accounting/hero-stat-row';
import HubstaffMasterMatchesModal from '@/components/accounting/HubstaffMasterMatchesModal';
import {
  type HubstaffMasterRow,
  sortHubstaffReconRows,
  downloadHubstaffReconCsv,
  isHubstaffExemptDept,
  isHubstaffReconExcluded,
  HUBSTAFF_EXCEPTION_STATUS,
  HUBSTAFF_LEAVE_STATUS,
} from '@/lib/payroll/hubstaff-reconciliation';
import { X } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SmoothSelect } from '@/components/ui/smooth-select';
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
  getPabMonthRangeSunSat,
  resolveCanonicalColumnsToIso,
  columnsAreAllCanonical,
  buildPabCalendarWeeks,
  checkHslPabEligibility,
  pabDateKey,
  parseColDate,
  groupDateColumnsByCalendarDay,
  parseDateRangeFromFilename,
} from '@/lib/hubstaff/calendar-column-dedupe';
import { formatPeriodRange } from '@/lib/hubstaff/period-label';
import { applyPabAdjustments, getHslAdjustedEnd } from '@/lib/payroll/dispatch-bonuses';
import {
  HSL_WEEK_MODEL_CUTOVER_KEY,
  resolveHslWeekModelWithDefault,
} from '@/lib/payroll/hsl-week-model';
import { buildOrphanageCoverageMap } from '@/lib/payroll/orphanage-pab-coverage';
import { HSL_DEPT_KEYS } from '@/lib/hsl-bonus/schema';
import {
  fetchPabPeriodSettings,
  isValidManualPabRange,
  resolvePabMonthForDate,
  resolvePabMonthFromColumns,
  resolvePabRangeForMonth,
} from '@/lib/pab-period-settings';
import { getTabCache, hasTabCache, setTabCache, TAB_CACHE_KEYS } from '@/lib/accounting/tab-cache';
import { resolveSystemBonuses, isDeptEligible, systemBonusAmountForDept } from '@/lib/payment-catalog/system-bonus';
import {
  effectiveUsdToCopRateFromStored,
  officialFxRates,
  type FxRates,
} from '@/lib/fx/currency-fx';
import { effectiveUsdToPhpRateFromStored } from '@/lib/fx/usd-php';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import {
  US_HOLIDAYS_ENABLED_KEY,
  US_HOLIDAYS_LIST_KEY,
  parseUsHolidaysList,
  getEnabledHolidayMap,
} from '@/lib/us-holidays';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useDispatchLock } from '@/hooks/useDispatchLock';

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

/** Extract a "Jul 5 - 11, 2026 · week N" style label from a Hubstaff filename.
 *  The label comes from the shared pay-period formatter so this selector stays
 *  in lock-step with the Payroll Wizard and the employee dashboard. */
function parsePeriodFromFilename(file: string | null): { label: string; week: number | null } | null {
  if (!file) return null;
  const m = /(\d{4})-(\d{2})-(\d{2})_to_(\d{4})-(\d{2})-(\d{2})/.exec(file);
  if (!m) return null;
  const start = new Date(+m[1], +m[2] - 1, +m[3]);
  const end = new Date(+m[4], +m[5] - 1, +m[6]);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  const label = formatPeriodRange(start, end);
  const firstOfYear = Date.UTC(+m[1], 0, 1);
  const week = Math.floor((Date.UTC(+m[1], +m[2] - 1, +m[3]) - firstOfYear) / (7 * 24 * 3600 * 1000)) + 1;
  return { label, week };
}

/** Extract the payroll period's ISO start/end (YYYY-MM-DD) from a Hubstaff
 *  filename. Returns null for "All Time" (no single window). ISO strings compare
 *  lexicographically, so callers can date-overlap without timezone math. */
function parsePeriodRange(file: string | null): { startISO: string; endISO: string } | null {
  if (!file) return null;
  const m = /(\d{4})-(\d{2})-(\d{2})_to_(\d{4})-(\d{2})-(\d{2})/.exec(file);
  if (!m) return null;
  return { startISO: `${m[1]}-${m[2]}-${m[3]}`, endISO: `${m[4]}-${m[5]}-${m[6]}` };
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
  initialData?: import('@/lib/accounting/prefetch').InitialAccountingData | null;
  /** Signed-in viewer's email — used to greet them by their real first name. */
  viewerEmail?: string | null;
}

interface SimpleViewProps {
  totalPayout: number | null;
  payoutLoading: boolean;
  /** Whether the payout Realtime websocket is actually up ('live') vs. polling
   *  ('degraded'). Drives the honest green/amber live dot on the hero. */
  payoutRealtime: 'live' | 'degraded';
  /** True while payroll processing / payment dispatch is underway — the Total
   *  Payout is not final and can still move (bonuses, adjustments, dispatch). */
  payrollProcessing: boolean;
  /** Who started the current processing run (from the dispatch lock), for the
   *  processing pill's tooltip. */
  payrollProcessingBy: string | null;
  payrollWorkerCount: number | null;
  masterTotal: number;
  /** Bonuses keyed in (KPI Calculator → catalog + HSL entries) for the active
   *  payroll week. null when no single week is selected or while resolving. */
  bonusesKeyedIn: number | null;
  /** How many Hubstaff work emails for the active payroll scope also exist on
   *  the Global Master List (set intersection). null while payroll is resolving. */
  emailsMatched: number | null;
  /** On the Global Master List but with NO Hubstaff hours this scope (directory
   *  people who didn't work / aren't in this payroll). */
  masterOnlyCount: number | null;
  /** In Hubstaff but NOT on the Global Master List (worked but missing from the
   *  directory — a data gap to reconcile). */
  hubstaffOnlyCount: number | null;
  pendingDisputes: number | null;
  oldestDisputeDays: number | null;
  pendingLeaves: number | null;
  attrition: {
    separations: number;
    activeHeadcount: number;
    avgHeadcount: number;
    ratePct: number;
  } | null;
  newHires: {
    last30d: number;
    last7d: number;
    mostRecentDays: number | null;
  } | null;
  pabMetrics: {
    loading: boolean;
    totalEmployees: number;
    eligible: number;
    notEligible: number;
    /** Σ per-eligible-employee PAB amount (custom dept variants included). */
    accruedPhp: number;
    monthLabel: string | null;
    periodEnd: Date | null;
    pabMonth: { year: number; month: number } | null;
  };
  techBonusEligibility: { eligible: number; pending: number; unknown: number; total: number };
  /** Configurable PAB / Tech amounts (PHP) from the Payment Catalog. */
  pabBonusPhp: number;
  techBonusPhp: number;
  /** Wizard-sourced money added on top of the salary sum (bonuses, adjustments,
   *  orphanage, MESA, urgent) so the hero shows the FULL pay run. Null until
   *  resolved / when the viewed scope has no wizard data. */
  payoutExtras: import('@/lib/payroll/payout-extras').PayoutExtras | null;
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
  techFilter: 'all' | 'eligible' | 'not-eligible';
  setTechFilter: (v: 'all' | 'eligible' | 'not-eligible') => void;
  onExportCsv: () => void;
  /** Export the Master ↔ Hubstaff reconciliation (who worked, who's on the
   *  master list with no hours, who's in Hubstaff but off the directory). */
  onExportHubstaffCsv: () => void;
  /** Open the Hubstaff ↔ Master reconciliation drill-down modal (clicking the tile). */
  onOpenHubstaffModal: () => void;
  /** Live status of the dashboard data feeds — drives the hero pill animation. */
  apiStatus: 'loading' | 'error' | 'live';
  /** Round-trip ms of the most recent API probe — revealed on pill hover. */
  apiLatencyMs: number | null;
  /** Trigger a fresh API ping (used on pill hover) so the MS readout stays current. */
  onPingApi: () => void;
  /** Signed-in viewer's email — used to greet them by their real first name. */
  viewerEmail?: string | null;
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

/** Compact peso label for the hero's extras breakdown (₱1.62M / ₱152K / −₱22K). */
function phpCompact(n: number): string {
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${sign}₱${(a / 1_000_000).toLocaleString('en-PH', { maximumFractionDigits: 2 })}M`;
  if (a >= 1_000) return `${sign}₱${Math.round(a / 1_000).toLocaleString('en-PH')}K`;
  return `${sign}₱${a.toLocaleString('en-PH', { maximumFractionDigits: 0 })}`;
}

function SimpleView({
  totalPayout,
  payoutLoading,
  payoutRealtime,
  payrollProcessing,
  payrollProcessingBy,
  payrollWorkerCount,
  masterTotal,
  bonusesKeyedIn,
  emailsMatched,
  masterOnlyCount,
  hubstaffOnlyCount,
  pendingDisputes,
  oldestDisputeDays,
  pendingLeaves,
  attrition,
  newHires,
  pabMetrics,
  techBonusEligibility,
  pabBonusPhp,
  techBonusPhp,
  payoutExtras,
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
  techFilter,
  setTechFilter,
  onExportCsv,
  onExportHubstaffCsv,
  onOpenHubstaffModal,
  apiStatus,
  apiLatencyMs,
  onPingApi,
  viewerEmail,
}: SimpleViewProps) {
  // Hover state for the API status pill — drives the ping ripple + MS readout reveal.
  const [pillHovered, setPillHovered] = useState(false);
  // Bumped every time we trigger a hover-ping; used as a key so the ripple replays.
  const [pingNonce, setPingNonce] = useState(0);
  const [pabCalEmail, setPabCalEmail] = useState<string | null>(null);
  const [pabCalIsHsl, setPabCalIsHsl] = useState(false);
  // Loading modal over the PAB calendar — real progress from the calendar's
  // hours fetch (not just the skeleton), same pattern as the People dialog.
  const [pabCalLoading, setPabCalLoading] = useState(true);
  const [pabCalProgress, setPabCalProgress] = useState(0);
  const [showPabCalLoader, setShowPabCalLoader] = useState(true);
  const openPabCalendar = (email: string, isHslRow: boolean) => {
    setPabCalLoading(true);
    setPabCalProgress(0);
    setShowPabCalLoader(true);
    setPabCalIsHsl(isHslRow);
    setPabCalEmail(email);
  };

  const pabTotal = pabMetrics.totalEmployees;
  const pabPct = pabTotal > 0 ? Math.round((pabMetrics.eligible / pabTotal) * 100) : 0;
  const techTotal = techBonusEligibility.total;
  const techPct = techTotal > 0 ? Math.round((techBonusEligibility.eligible / techTotal) * 100) : 0;
  // The time-of-day greeting depends on the viewer's LOCAL hour, which only
  // exists on the client. Computing it during SSR uses the server's timezone
  // (UTC on Vercel) and mismatches the browser (Manila, UTC+8) → React #418
  // hydration error, which forces React to discard the server HTML and
  // re-render the whole dashboard client-side (the "laggish on Vercel, fine on
  // localhost" symptom — localhost's dev server shares the browser timezone).
  // Render a stable greeting on the server + first client paint, then switch to
  // the time-based one after mount so server and client agree on first render.
  const [greetingReady, setGreetingReady] = useState(false);
  useEffect(() => { setGreetingReady(true); }, []);
  const nowHour = new Date().getHours();
  const greeting = !greetingReady
    ? 'Welcome'
    : nowHour < 12 ? 'Good morning' : nowHour < 18 ? 'Good afternoon' : 'Good evening';

  // Look up the viewer's real name so the hero greets them by their actual
  // first name; falls back to "Accounting team" when the viewer is unknown.
  const [viewerRealName, setViewerRealName] = useState<string | null>(null);
  useEffect(() => {
    if (!viewerEmail) return;
    let alive = true;
    fetch(`/api/employees?email=${encodeURIComponent(viewerEmail)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive) return;
        const n = j?.employees?.[0]?.name;
        if (typeof n === 'string' && n.trim()) setViewerRealName(n.trim());
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [viewerEmail]);
  const viewerFirstName = resolveFirstName({ name: viewerRealName, email: viewerEmail, fallback: '' });

  // PAB is finalized once today is strictly past the period end date.
  const pabFinalizedForPayout = (() => {
    if (pabMetrics.loading || !pabMetrics.periodEnd) return false;
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const e = new Date(pabMetrics.periodEnd); e.setHours(0, 0, 0, 0);
    return t.getTime() > e.getTime();
  })();
  const pabBonusTotal = pabFinalizedForPayout ? pabMetrics.accruedPhp : 0;
  // Extras are suppressed while the salary is (re)loading: on an uncached cycle
  // switch `totalPayout` still holds the PREVIOUS cycle's salary until the fetch
  // lands, and mixing it with the NEW cycle's extras would show a total that
  // belongs to neither week (the reels are spinning, but the USD line isn't).
  const extrasTotal = !payoutLoading && payoutExtras ? payoutExtras.extrasTotalPhp : 0;
  const displayTotalPayout = totalPayout != null ? totalPayout + pabBonusTotal + extrasTotal : null;

  const usdEquivalent = displayTotalPayout != null ? displayTotalPayout / PHP_USD_FX : null;

  // Itemized extras for the hero's breakdown line — only nonzero parts render.
  // Wizard-derived parts are tracked separately from the urgent part: only the
  // former justify the "Full pay run" subtitle (an urgent-only cycle is still
  // just initial pay + a one-off).
  const wizardParts: string[] = [];
  let urgentPart: string | null = null;
  if (!payoutLoading && payoutExtras) {
    if (payoutExtras.provenance !== 'none') {
      const c = payoutExtras.components;
      const bonuses = c.techPhp + c.otherBonusesPhp;
      if (bonuses !== 0) wizardParts.push(`${phpCompact(bonuses)} bonuses`);
      if (c.adjustmentPhp !== 0) wizardParts.push(`${phpCompact(c.adjustmentPhp)} adjustments`);
      if (c.orphanagePhp !== 0) wizardParts.push(`${phpCompact(c.orphanagePhp)} orphanage`);
      if (c.mesaDeductionPhp !== 0) wizardParts.push(`${phpCompact(-c.mesaDeductionPhp)} MESA`);
      if (c.mesaDisbursementPhp !== 0) wizardParts.push(`${phpCompact(c.mesaDisbursementPhp)} MESA aid`);
    }
    if (payoutExtras.urgentPaidPhp !== 0) {
      urgentPart = `${phpCompact(payoutExtras.urgentPaidPhp)} urgent`;
    }
  }
  const extrasParts = urgentPart ? [...wizardParts, urgentPart] : wizardParts;

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
  const attritionRatePct = attrition?.ratePct ?? null;
  const attritionDisplay = attritionRatePct == null ? 0 : Math.round(attritionRatePct);
  const attritionTone: AttentionTone =
    attritionRatePct == null
      ? 'neutral'
      : attritionRatePct >= 15
        ? 'warn'
        : attritionRatePct >= 5
          ? 'info'
          : 'ok';

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-[1600px] px-3 pb-6 sm:px-4 md:px-6 lg:px-8 xl:px-10 [@media(max-height:900px)]:pb-4 xl:pb-12">

        {/* Hero — branded chip, accent rule, floating orbs in the corners */}
        <section className={cn(
          'relative mb-5 overflow-hidden rounded-3xl border bg-gradient-to-br from-stone-50 via-orange-50/35 to-blue-50/25 p-5 [@media(max-height:900px)]:mb-4 [@media(max-height:900px)]:p-4 lg:mb-8 lg:p-7 xl:mb-10 xl:p-8 dark:from-zinc-950 dark:via-orange-950/15 dark:to-blue-950/15',
          (payoutLoading || pabMetrics.loading || loading)
            ? 'hero-loading-border'
            : 'border-orange-100/80 shadow-[0_12px_32px_-16px_rgba(255,138,76,0.12)] dark:border-orange-900/30',
        )}>
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
                  'group relative mb-4 inline-flex cursor-pointer items-center gap-2 overflow-visible rounded-full border px-4 py-1.5 text-[13px] font-semibold uppercase tracking-[0.18em] backdrop-blur-md transition-[colors,box-shadow] duration-300',
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

                <span className="relative inline-flex h-4 w-4 items-center justify-center">
                  {/* ECG heartbeat trace — a faint full waveform with a bright dash
                      that sweeps LEFT → RIGHT (CSS `animate-ecg-sweep`, always runs). */}
                  <svg
                    className="relative h-4 w-4"
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
                    <path
                      className="animate-ecg-sweep"
                      style={{
                        animationDuration:
                          apiStatus === 'loading' ? '0.85s' : apiStatus === 'error' ? '2.2s' : '1.5s',
                      }}
                      d="M2 12h4l3 -9l6 18l3 -9h4"
                      stroke="currentColor"
                      strokeWidth={2.85}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      pathLength={1}
                      strokeDasharray="0.26 0.74"
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
              <p className="mb-4 text-2xl font-semibold tracking-tight text-zinc-700 [@media(max-height:900px)]:mb-2 sm:text-3xl lg:mb-5 dark:text-zinc-200">
                {viewerFirstName ? (
                  <>
                    {greeting},{' '}
                    <span className="bg-gradient-to-r from-orange-600 to-rose-500 bg-clip-text font-semibold text-transparent dark:from-orange-400 dark:to-rose-400">
                      {viewerFirstName}
                    </span>
                    .
                  </>
                ) : (
                  <>
                    {greeting}.{' '}
                    <span className="bg-gradient-to-r from-orange-600 to-rose-500 bg-clip-text font-semibold text-transparent dark:from-orange-400 dark:to-rose-400">
                      Accounting team
                    </span>{' '}
                    dashboard.
                  </>
                )}
              </p>
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 xl:mb-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-orange-700/80 dark:text-orange-400/80">
                  Total payout · this accounting pay run
                </p>
                {/* Live indicator — a green dot when the Realtime feed is up, an
                    amber dot when we've fallen back to polling. Honest either way:
                    the number stays fresh, this just says how immediately. */}
                <PayoutLiveDot realtime={payoutRealtime} />
                {/* Processing pill — shown while payroll/dispatch is underway, so
                    the figure reads as provisional (it can still move). */}
                {payrollProcessing && (
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/80 bg-amber-50/90 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/40 dark:text-amber-300"
                    title={
                      payrollProcessingBy
                        ? `Payroll processing in progress (started by ${payrollProcessingBy}). The total can still change.`
                        : 'Payroll processing in progress. The total can still change.'
                    }
                  >
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    Processing · total may change
                  </span>
                )}
              </div>
              <div className="flex items-baseline">
                <span className="mr-1.5 text-4xl font-medium text-zinc-400 lg:text-5xl xl:text-6xl 2xl:text-7xl dark:text-zinc-500">
                  ₱
                </span>
                {/* The reels are the loading state: they free-spin (blurred)
                    while the payout resolves, then settle onto the real figure. */}
                <span className="font-mono text-4xl font-bold tracking-tight text-zinc-900 lg:text-5xl xl:text-6xl 2xl:text-7xl dark:text-white">
                  <RollingPayout
                    value={displayTotalPayout}
                    loading={payoutLoading || pabMetrics.loading || loading}
                  />
                </span>
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
                <span>
                  {payrollProcessing
                    ? 'Provisional — payroll is being processed now'
                    : wizardParts.length > 0
                      ? pabFinalizedForPayout
                        ? 'Full pay run — salary + bonuses + adjustments + PAB'
                        : 'Full pay run — salary + bonuses + adjustments'
                      : pabFinalizedForPayout
                        ? 'Initial pay + PAB · other bonuses applied at payroll'
                        : 'Initial pay · bonuses applied at payroll'}
                </span>
                {extrasParts.length > 0 && (
                  <>
                    <span className="text-zinc-300 dark:text-zinc-700">·</span>
                    <span
                      className="text-zinc-500 dark:text-zinc-500"
                      title={
                        wizardParts.length === 0
                          ? "Urgent one-off payments recorded in this cycle's dispatch week"
                          : payoutExtras?.provenance === 'staged'
                            ? 'From the locked payroll run (Payment Dispatch figures)'
                            : 'Live from the Payroll Wizard'
                      }
                    >
                      incl. {extrasParts.join(' · ')}
                    </span>
                  </>
                )}
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
                Icon={Award}
                tone="info"
                label="Bonuses keyed in"
                value={bonusesKeyedIn}
              />
              <HeroStatRow
                Icon={CheckCircle2}
                tone="ok"
                label="Hubstaff ↔ Master matches"
                value={emailsMatched}
                onClick={onOpenHubstaffModal}
                action={
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onExportHubstaffCsv(); }}
                    title="Export Master ↔ Hubstaff reconciliation (CSV)"
                    aria-label="Export Master to Hubstaff reconciliation as CSV"
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-emerald-200 bg-white/70 text-emerald-700 transition-colors hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 dark:border-emerald-900/50 dark:bg-zinc-900/60 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
                  >
                    <Download className="h-3 w-3" />
                  </button>
                }
                tooltip={
                  <div className="space-y-2">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                        Master List ↔ Hubstaff
                      </p>
                      <p className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
                        The Global Master List is the employee directory. Hubstaff is the
                        2nd pass — who actually logged hours this payroll.
                      </p>
                    </div>
                    <ul className="space-y-1.5 text-[12px]">
                      <li className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          On Master &amp; worked
                        </span>
                        <span className="font-mono font-semibold tabular-nums">
                          {emailsMatched == null ? '—' : emailsMatched.toLocaleString('en-US')}
                        </span>
                      </li>
                      <li className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-300">
                          <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />
                          On Master, no hours
                        </span>
                        <span className="font-mono font-semibold tabular-nums">
                          {masterOnlyCount == null ? '—' : masterOnlyCount.toLocaleString('en-US')}
                        </span>
                      </li>
                      <li className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-1.5 text-rose-700 dark:text-rose-300">
                          <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                          In Hubstaff, not on Master
                        </span>
                        <span className="font-mono font-semibold tabular-nums">
                          {hubstaffOnlyCount == null ? '—' : hubstaffOnlyCount.toLocaleString('en-US')}
                        </span>
                      </li>
                    </ul>
                    {hubstaffOnlyCount != null && hubstaffOnlyCount > 0 && (
                      <p className="border-t border-zinc-100 pt-2 text-[11px] leading-snug text-rose-600 dark:border-zinc-800 dark:text-rose-400">
                        {hubstaffOnlyCount.toLocaleString('en-US')} worked but{' '}
                        {hubstaffOnlyCount === 1 ? "isn't" : "aren't"} on the Master List —
                        reconcile the directory.
                      </p>
                    )}
                    <p className="border-t border-zinc-100 pt-2 text-[11px] leading-snug text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                      Click to open the searchable breakdown — each no-hours person
                      gets a likely reason (on leave, newly onboarded, etc.). Export
                      the full list from there or the ↓ icon.
                    </p>
                  </div>
                }
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
            unit={pendingDisputes === 1 ? 'issue pending' : 'issues pending'}
            sub="Approve or deny short-day issues"
            cta="Review queue"
            onClick={onNavigate ? () => onNavigate('disputes') : undefined}
          />
          <AttentionCard
            icon={<UserPlus />}
            label="New hires"
            tone={newHires && newHires.last30d > 0 ? 'ok' : 'neutral'}
            tag="last 30 days"
            value={newHires?.last30d ?? 0}
            unit={newHires?.last30d === 1 ? 'started' : 'started'}
            sub={
              newHires == null || newHires.last30d === 0 ? (
                <>No new hires in the last 30 days.</>
              ) : (
                <>
                  <strong className="text-zinc-700 dark:text-zinc-300">{newHires.last7d}</strong>{' '}
                  this week
                  {newHires.mostRecentDays != null && (
                    <>
                      {' · '}
                      most recent{' '}
                      <strong className="text-zinc-700 dark:text-zinc-300">
                        {newHires.mostRecentDays === 0
                          ? 'today'
                          : newHires.mostRecentDays === 1
                            ? 'yesterday'
                            : `${newHires.mostRecentDays}d ago`}
                      </strong>
                    </>
                  )}
                </>
              )
            }
            cta="Open in HR"
            onClick={() => { window.location.href = '/hr'; }}
          />
          <AttentionCard
            icon={<UserMinus />}
            label="Attrition"
            tone={attritionTone}
            tag="last 12 months"
            value={attritionDisplay}
            unit="%"
            sub={
              attrition == null ? (
                <>No off-board data available yet.</>
              ) : (
                <>
                  <strong className="text-zinc-700 dark:text-zinc-300">{attrition.separations}</strong>{' '}
                  separation{attrition.separations === 1 ? '' : 's'} ·{' '}
                  <strong className="text-zinc-700 dark:text-zinc-300">{attrition.activeHeadcount}</strong>{' '}
                  active · avg headcount{' '}
                  <strong className="text-zinc-700 dark:text-zinc-300">{Math.round(attrition.avgHeadcount)}</strong>
                </>
              )
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
                const todayDay = new Date().getDate();
                const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
                const monthDayPct = Math.round((todayDay / daysInMonth) * 100);
                return (
                  <>
                    <div className="flex flex-col items-center gap-2.5">
                      <div className="relative h-20 w-20 xl:h-24 xl:w-24">
                        <Donut
                          pct={inProgress ? monthDayPct : pabPct}
                          color={inProgress ? '#b45309' : '#047857'}
                          fillContainer
                        />
                        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                          <span className="text-base font-semibold tracking-tight text-zinc-900 xl:text-xl dark:text-white">
                            {inProgress ? (
                              todayDay
                            ) : pabTotal > 0 ? `${pabPct}%` : '—'}
                          </span>
                          {inProgress ? (
                            <span className="mt-0.5 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
                              of {daysInMonth}
                            </span>
                          ) : pabTotal > 0 && (
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
                        Perfect Attendance Bonus · {formatPhp(pabBonusPhp, 2)}
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
                          : `Accrues ${formatPhp(pabMetrics.accruedPhp, 2)} if all eligible hold through month end.`}
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
                  Technology Bonus · {formatPhp(techBonusPhp, 2)}
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
                  Accrues {formatPhp(techBonusEligibility.eligible * techBonusPhp, 2)} on the
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
              <SmoothSelect
                aria-label="Department"
                value={departmentFilter}
                onChange={(v) => setDepartmentFilter(v)}
                triggerClassName="h-8"
                options={[
                  { value: '', label: 'All departments' },
                  ...departmentOptions.map((d) => ({ value: d, label: d })),
                ]}
              />
              <SmoothSelect
                aria-label="PAB month"
                value={monthFilter}
                onChange={(v) => setMonthFilter(v)}
                triggerClassName="h-8"
                options={[
                  { value: '', label: 'All months' },
                  ...monthOptions.map((m) => ({ value: m.value, label: m.label })),
                ]}
              />
              {/* PAB filter */}
              <div className="relative flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
                {(['all', 'eligible', 'not-eligible'] as const).map((f) => {
                  const labels = { all: 'All', eligible: 'PAB Eligible', 'not-eligible': 'Not Eligible' };
                  const active = pabFilter === f;
                  const activeBg =
                    f === 'eligible'
                      ? 'bg-emerald-700 dark:bg-emerald-600'
                      : f === 'not-eligible'
                        ? 'bg-red-700 dark:bg-red-600'
                        : 'bg-zinc-900 dark:bg-zinc-100';
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setPabFilter(f)}
                      className={cn(
                        'relative h-7 rounded-md px-2.5 text-[11.5px] font-medium transition-colors',
                        active
                          ? f === 'all'
                            ? 'text-white dark:text-zinc-900'
                            : 'text-white'
                          : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
                      )}
                    >
                      {active && (
                        <motion.span
                          layoutId="pab-filter-pill-simple"
                          className={cn('absolute inset-0 rounded-md', activeBg)}
                          transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                        />
                      )}
                      <span className="relative">{labels[f]}</span>
                    </button>
                  );
                })}
              </div>
              {/* Tech Bonus filter */}
              <div className="relative flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
                {(['all', 'eligible', 'not-eligible'] as const).map((f) => {
                  const labels = { all: 'All', eligible: 'Tech Eligible', 'not-eligible': 'Tech Pending' };
                  const active = techFilter === f;
                  const activeBg =
                    f === 'eligible'
                      ? 'bg-indigo-700 dark:bg-indigo-600'
                      : f === 'not-eligible'
                        ? 'bg-amber-700 dark:bg-amber-600'
                        : 'bg-zinc-900 dark:bg-zinc-100';
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setTechFilter(f)}
                      className={cn(
                        'relative h-7 rounded-md px-2.5 text-[11.5px] font-medium transition-colors',
                        active
                          ? f === 'all'
                            ? 'text-white dark:text-zinc-900'
                            : 'text-white'
                          : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
                      )}
                    >
                      {active && (
                        <motion.span
                          layoutId="tech-filter-pill-simple"
                          className={cn('absolute inset-0 rounded-md', activeBg)}
                          transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                        />
                      )}
                      <span className="relative">{labels[f]}</span>
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
                pageRows.map((row, _rowIdx) => {
                  const email = row.work_email ?? row.personal_email ?? '';
                  const emailKey = normEmail(email) ?? '';
                  const pay = emailKey ? employeePayByEmail[emailKey] : undefined;
                  const isHubstaff = row.recordSource === 'hubstaff';
                  return (
                    <div
                      key={`${row.recordSource}-${email}-${row.name ?? ''}-${row.department ?? ''}-${_rowIdx}`}
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
                    pageRows.map((row, _rowIdx) => {
                      const email = row.work_email ?? row.personal_email ?? '';
                      const isHubstaff = row.recordSource === 'hubstaff';
                      return (
                        <tr
                          key={`${row.recordSource}-${email}-${row.name ?? ''}-${row.department ?? ''}-${_rowIdx}`}
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
                                  onClick={() => { if (email) openPabCalendar(email, (row.department ?? '').trim().toLowerCase() === 'hsl'); }}
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
              <div data-readonly-allow className="flex gap-0.5">
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
              <div className="relative min-h-0 flex-1 overflow-y-auto p-4">
                {showPabCalLoader && (
                  <PabCalendarLoader
                    progress={pabCalProgress}
                    done={!pabCalLoading}
                    barClassName="bg-indigo-500"
                    onDone={() => setShowPabCalLoader(false)}
                  />
                )}
                <EmployeePabCalendar
                  employeeEmail={pabCalEmail}
                  trimToElapsedWeeks={false}
                  pabMonthOverride={pabMetrics.pabMonth}
                  isHsl={pabCalIsHsl}
                  onLoadingChange={setPabCalLoading}
                  onProgress={setPabCalProgress}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// AttentionTone + ATTENTION_PALETTE + HeroStatRow now live in
// '@/components/accounting/hero-stat-row' (shared with the CEO System Overview).

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
      whileHover={{ y: -4 }}
      whileTap={interactive ? { scale: 0.985 } : undefined}
      transition={{ type: 'spring', stiffness: 360, damping: 28, mass: 0.6 }}
      className={cn(
        // Animate ONLY transform (GPU-composited) for a buttery lift. We do NOT
        // transition box-shadow here — repainting a large soft shadow every frame
        // is what drops the hover to single-digit fps. Border color is cheap.
        'group relative w-full transform-gpu overflow-hidden rounded-2xl border p-5 text-left shadow-sm transition-colors duration-300 will-change-transform',
        palette.ring,
        palette.surface,
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

// HeroStatRow moved to '@/components/accounting/hero-stat-row' (imported above).

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

/**
 * PayoutLiveDot — a small "live" chip next to the Total Payout eyebrow.
 *  - realtime 'live':     emerald dot with a ping halo + "Live" — the Realtime
 *    websocket is up, so bonus/adjustment changes push in near-instantly.
 *  - realtime 'degraded': steady amber dot + "Live · polling" — the websocket
 *    isn't connected, but the 30s poll + focus refresh still keep it fresh.
 * The distinction is honest: the value is live either way, this says how fast.
 */
function PayoutLiveDot({ realtime }: { realtime: 'live' | 'degraded' }) {
  const live = realtime === 'live';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em]',
        live ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400',
      )}
      title={
        live
          ? 'Live — updates push in as hours, bonuses, and adjustments change.'
          : 'Live — refreshing on a timer (realtime feed unavailable right now).'
      }
      aria-label={live ? 'Live, realtime' : 'Live, polling'}
    >
      <span className="relative inline-flex h-2 w-2" aria-hidden>
        {live && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        )}
        <span
          className={cn(
            'relative inline-flex h-2 w-2 rounded-full',
            live ? 'bg-emerald-500' : 'bg-amber-500',
          )}
        />
      </span>
      {live ? 'Live' : 'Live · polling'}
    </span>
  );
}

// Reel geometry. A hidden ghost "0" inside each reel gives the inline-block its
// normal text baseline, so the visible reel never floats off the line (the fix
// for the "numbers floating" bug). The strip's cells share that exact font /
// line box, so translateY(-N em) lands digit N dead on the baseline. Window and
// cell are both a clean 1em with line-height 1 — no tall-cell / negative-margin
// hacks, no doubled-digit clipping. Width leaves room for a bold mono glyph.
const REEL_WIDTH_EM = 0.62; // per-digit horizontal room

type ReelPhase = 'spinning' | 'settling' | 'rest';

/**
 * DigitReel — one vertical 0-9 strip driven by translateY.
 *  - phase "spinning": the CSS `payout-reel-spin` loop runs it continuously with
 *    a motion blur — this IS the loading indicator.
 *  - phase "settling": a JS transition decelerates the strip onto `digit`, then
 *    a one-shot warm flash marks the lock-in.
 *  - phase "rest": parked on `digit`, static.
 * Reduced motion snaps straight to the digit with no spin, blur, or flash.
 */
function DigitReel({
  digit,
  phase,
  delayMs,
  reduce,
}: {
  digit: number;
  phase: ReelPhase;
  delayMs: number;
  reduce: boolean;
}) {
  const target = Math.min(9, Math.max(0, digit));

  // Extra full turns folded into the settle travel so the deceleration reads as
  // a wheel spinning down rather than a short hop.
  const TURNS = 4;
  // Resting offset depends on how many 0-9 bands the strip renders in this
  // phase. Settling renders TURNS+1 bands (the target lives in the LAST band, so
  // the reel spins through every turn before landing). Rest / reduced-motion
  // render a single band, so the target is simply -target. Using the 49-index
  // offset against a single-band strip scrolls past the end → a blank reel.
  const restOffsetEm = phase === 'settling' ? -(TURNS * 10 + target) : -target;

  const [flash, setFlash] = React.useState(false);
  const [settleOffsetEm, setSettleOffsetEm] = React.useState(0);
  const rafRef = React.useRef(0);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drive the settle: on entering "settling", kick a transition from the top of
  // the strip down to the target, and flash when it lands. Reduced motion or a
  // direct "rest" mount parks immediately.
  React.useEffect(() => {
    if (reduce) {
      setSettleOffsetEm(restOffsetEm);
      setFlash(false);
      return;
    }
    if (phase === 'rest') {
      setSettleOffsetEm(restOffsetEm);
      return;
    }
    if (phase !== 'settling') return;
    setSettleOffsetEm(0);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(() => setSettleOffsetEm(restOffsetEm));
    });
    const SETTLE_MS = 1000;
    timerRef.current = setTimeout(() => setFlash(true), delayMs + SETTLE_MS);
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, digit, reduce, delayMs]);

  // The strip only needs the extra pre-roll bands during a settle; at rest one
  // 0-9 band is enough, and the spinning loop cycles a single band. When
  // spinning, append a trailing "0" so the keyframe (0 → -10em) wraps seamlessly
  // — the 11th cell shows the same glyph the loop restarts on.
  const strips = phase === 'settling' ? TURNS + 1 : 1;
  const cells = React.useMemo(() => {
    const arr: number[] = [];
    for (let t = 0; t < strips; t += 1) for (let d = 0; d <= 9; d += 1) arr.push(d);
    if (phase === 'spinning') arr.push(0); // seamless wrap cell
    return arr;
  }, [strips, phase]);

  const spinning = phase === 'spinning' && !reduce;
  // Fade the reel edges only while it's in motion: the whole time it spins, and
  // during the settle up until the moment it locks in (flash). Off at rest and
  // under reduced motion, so the final digit shows in full.
  const masked = !reduce && (spinning || (phase === 'settling' && !flash));

  return (
    <span
      className={cn(
        'relative inline-block overflow-hidden align-baseline',
        masked && 'payout-reel-masked',
      )}
      style={{ width: `${REEL_WIDTH_EM}em`, height: '1em' }}
      aria-hidden
    >
      {/* Ghost reserves the inline baseline + box so the reel sits on the line. */}
      <span className="invisible" aria-hidden>
        0
      </span>
      <span
        className={cn(
          'absolute left-0 top-0 flex flex-col',
          spinning && 'payout-reel-spinning',
          flash && 'payout-reel-settle',
        )}
        style={{
          // Each reel spins at a slightly different rate so the wheels look
          // independent rather than a single sliding block. Keyed off delayMs.
          ['--reel-spin-dur' as string]: `${0.42 + (delayMs % 5) * 0.03}s`,
          // While spinning the CSS keyframe owns transform; otherwise we drive it.
          transform: spinning ? undefined : `translateY(${settleOffsetEm}em)`,
          transition:
            phase === 'settling' && !reduce
              ? `transform 1000ms cubic-bezier(0.12, 0.8, 0.15, 1) ${delayMs}ms`
              : 'none',
          willChange: 'transform',
        }}
      >
        {cells.map((d, i) => (
          <span
            key={i}
            className="flex h-[1em] items-center justify-center leading-none"
          >
            {d}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * RollingPayout — the Total Payout hero figure as a slot-machine odometer.
 *
 * While `loading`, a fixed set of reels spins continuously (blurred), so the
 * reels themselves ARE the loading state — no separate skeleton. When the value
 * arrives, the reels swap to the real digits and settle left-to-right (most-
 * significant digit lands last) so the eye reads it counting into place. A
 * later value change re-runs the settle. Snaps instantly under reduced motion,
 * and a plain-text mirror carries the real number to assistive tech.
 */
function RollingPayout({
  value,
  loading,
}: {
  value: number | null;
  loading: boolean;
}) {
  const reduce =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const formatted =
    value != null
      ? value.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : null;

  // Phase machine. Loading (or no value yet) → free spin. Once the value is
  // known and loading clears, run one settle, then rest. A new value re-settles.
  const [phase, setPhase] = React.useState<ReelPhase>(loading || formatted == null ? 'spinning' : 'settling');
  const prevFmtRef = React.useRef<string | null>(null);
  const restTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (loading || formatted == null) {
      setPhase('spinning');
      prevFmtRef.current = null;
      return;
    }
    // Value is ready. If it changed (or we were spinning), settle onto it.
    if (prevFmtRef.current !== formatted) {
      prevFmtRef.current = formatted;
      setPhase('settling');
      if (restTimerRef.current) clearTimeout(restTimerRef.current);
      // After the last reel lands, drop to a cheap static rest.
      const lastDelay = (formatted.replace(/\D/g, '').length - 1) * 90;
      restTimerRef.current = setTimeout(() => setPhase('rest'), lastDelay + 1400);
    }
    return () => {
      if (restTimerRef.current) clearTimeout(restTimerRef.current);
    };
  }, [loading, formatted]);

  // Loading placeholder: a plausible number of reels + separators so the layout
  // (and the spin) matches the real figure's footprint. Not the real value.
  const template = formatted ?? '0,000,000.00';

  // Left-to-right settle: each successive DIGIT lands a beat after the previous.
  const STEP_MS = 90;
  let digitOrdinal = -1;

  return (
    <span className="relative inline-flex items-baseline font-mono font-bold tabular-nums">
      {/* Screen-reader-only true value; the reels are aria-hidden. */}
      <span className="sr-only">{formatted != null ? `₱${formatted}` : 'Loading total payout'}</span>
      <span aria-hidden className="inline-flex items-baseline">
        {template.split('').map((ch, i) => {
          if (ch >= '0' && ch <= '9') {
            digitOrdinal += 1;
            return (
              <DigitReel
                // Remount on phase change so each phase starts from a clean
                // state (no CSS-anim → JS-transform hand-off glitch).
                key={`${phase}-${i}`}
                digit={Number(ch)}
                phase={phase}
                reduce={reduce}
                delayMs={digitOrdinal * STEP_MS}
              />
            );
          }
          return (
            <span key={`sep-${i}`} className="inline-block px-[0.02em]">
              {ch}
            </span>
          );
        })}
      </span>
    </span>
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

// --- Accounting tab-cache plumbing for the Overview hero KPIs ---------------
// The payout total and PAB metrics are recomputed from scratch on every mount,
// so without caching the hero strip flashes its loading placeholder each time
// the user returns to the Overview tab. We cache the computed outputs keyed by
// the inputs that determine them and seed component state from that cache so
// the numbers paint instantly, then revalidate in the background.

/** Sorted, comma-joined HSL master-list emails — identifies HSL membership. */
function hslEmailsKeyFromEmployees(employees: EmployeeRow[]): string {
  const ems: string[] = [];
  for (const e of employees) {
    if (e.department?.trim().toLowerCase() === 'hsl') {
      const em = normEmail(e.personal_email ?? null) ?? normEmail(e.work_email ?? null);
      if (em) ems.push(em);
    }
  }
  ems.sort();
  return ems.join(',');
}

type CachedPayout = {
  totalPayout: number | null;
  payrollWorkerCount: number | null;
  payrollEmailsNorm: string[] | null;
  payrollIdentityByEmail: Record<string, { name: string | null; department: string | null }> | null;
  employeePayByEmail: Record<string, { hours: number; pay: number | null }>;
  activeSourceFile: string | null;
  /** Optional: entries cached before 2026-07-30 predate the field. Seeding it
   *  keeps the hero from settling twice (salary first, extras a beat later)
   *  on every warm remount. */
  payoutExtras?: import('@/lib/payroll/payout-extras').PayoutExtras | null;
};

type CachedPabMetrics = {
  totalEmployees: number;
  eligible: number;
  notEligible: number;
  /** Optional: entries cached before 2026-07-30 predate the field. */
  accruedPhp?: number;
  monthLabel: string | null;
  periodEnd: string | null; // ISO string; rehydrated to a Date on read
  pabMonth: { year: number; month: number } | null;
  eligibility: Array<[string, boolean]>; // Map entries
};

const payoutCacheKey = (file: string | null): string =>
  `${TAB_CACHE_KEYS.overviewPayouts}:${file ?? '__latest__'}`;

const pabMetricsCacheKey = (
  file: string | null,
  monthFilter: string,
  employeeCount: number,
  hslKey: string,
): string =>
  `${TAB_CACHE_KEYS.overviewPabMetrics}:${file ?? '__latest__'}:${monthFilter || '__none__'}:${employeeCount}:${hslKey}`;

// Whether this module has already mounted once on the client. The tab-cache is
// sessionStorage-backed, so it is unavailable during SSR but populated on the
// client after a reload — seeding state from it on the very first (hydration)
// render therefore diverges from the server HTML and trips a React hydration
// mismatch. We skip the cache on that first render only; every later remount
// (e.g. Accounting tab switches, which fully unmount/remount this component)
// seeds freely so the instant-paint behaviour is preserved.
let hasMountedOnce = false;

export default function Overview({ onViewRates, onNavigate, initialData, viewerEmail }: OverviewProps = {}) {
  React.useEffect(() => {
    hasMountedOnce = true;
  }, []);
  // USD-anchored FX (usdToPhp + usdToCop) — converts custom USD/COP system-
  // bonus variants to PHP. Official reference rates until the fetch lands.
  const [fx, setFx] = useState<FxRates>(officialFxRates());
  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/app-settings?keys=usd_to_php_rate,usd_to_cop_rate', { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: { values?: Record<string, string | null> }) => {
        if (cancelled) return;
        const v = json.values ?? {};
        setFx({
          usdToPhp: effectiveUsdToPhpRateFromStored(v['usd_to_php_rate']),
          usdToCop: effectiveUsdToCopRateFromStored(v['usd_to_cop_rate']),
        });
      })
      .catch(() => {
        /* keep the official fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // PAB + Tech amounts + per-department allowlist (Payment Catalog System
  // Bonuses, prefetched), incl. custom `pab:*`/`tech:*` currency variants.
  // Falls back to the legacy constants when unset.
  const sysBonusCfg = useMemo(
    () => resolveSystemBonuses(initialData?.systemBonuses ?? [], fx),
    [initialData, fx],
  );
  const prefetchedRatesRef = React.useRef<import('@/lib/supabase/employee-hourly-rates').EmployeeHourlyRateRow[] | null>(
    initialData?.hourlyRates ?? null,
  );
  // Seed the hero KPIs from cache so they don't re-flash on tab switch. The
  // keys must match what the payout / PAB effects compute on first mount:
  // selectedSourceFile defaults to sourceFiles[0], monthFilter defaults to ''.
  const initialEmployeesSeed = initialData?.employees ?? [];
  const initialSourceFileSeed = initialData?.sourceFiles?.[0] ?? null;
  // Gate the (client-only) tab-cache reads behind the first-mount flag so the
  // hydration render matches the server, which has no access to sessionStorage.
  const payoutSeed = hasMountedOnce
    ? getTabCache<CachedPayout>(payoutCacheKey(initialSourceFileSeed))
    : undefined;
  const pabMetricsSeed = hasMountedOnce
    ? getTabCache<CachedPabMetrics>(
        pabMetricsCacheKey(
          initialSourceFileSeed,
          '',
          initialEmployeesSeed.length,
          hslEmailsKeyFromEmployees(initialEmployeesSeed),
        ),
      )
    : undefined;
  const [pabCalEmail, setPabCalEmail] = useState<string | null>(null);
  const [pabCalIsHsl, setPabCalIsHsl] = useState(false);
  // Loading modal over the PAB calendar — real progress from the calendar's
  // hours fetch (not just the skeleton), same pattern as the People dialog.
  const [pabCalLoading, setPabCalLoading] = useState(true);
  const [pabCalProgress, setPabCalProgress] = useState(0);
  const [showPabCalLoader, setShowPabCalLoader] = useState(true);
  const openPabCalendar = (email: string, isHslRow: boolean) => {
    setPabCalLoading(true);
    setPabCalProgress(0);
    setShowPabCalLoader(true);
    setPabCalIsHsl(isHslRow);
    setPabCalEmail(email);
  };
  const [employees, setEmployees] = useState<EmployeeRow[]>(initialData?.employees ?? []);
  const [employeesError, setEmployeesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initialData?.employees?.length);
  /** Round-trip time of the most recent /api/employees probe — drives the hero pill MS readout. */
  const [apiLatencyMs, setApiLatencyMs] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState<string>('');
  /** Month filter (YYYY-MM). Empty string = All months / no override. */
  const [monthFilter, setMonthFilter] = useState<string>('');
  const [page, setPage] = useState(1);
  const [totalPayout, setTotalPayout] = useState<number | null>(payoutSeed?.totalPayout ?? null);
  const [payoutLoading, setPayoutLoading] = useState(!payoutSeed);
  /** Bumped by the live-refresh hook (Realtime / poll / focus) to re-run the
   *  payout fetch effect in place, so the hero re-settles on new hours,
   *  bonuses, or adjustments without a manual reload. */
  const [payoutRefreshNonce, setPayoutRefreshNonce] = useState(0);
  /** Whether the Realtime websocket for the payout feed is actually up ('live')
   *  vs. falling back to polling ('degraded'). Drives the honest green dot. */
  const [payoutRealtime, setPayoutRealtime] = useState<'live' | 'degraded'>('degraded');
  const [payrollEmailsNorm, setPayrollEmailsNorm] = useState<Set<string> | null>(
    payoutSeed?.payrollEmailsNorm ? new Set(payoutSeed.payrollEmailsNorm) : null,
  );
  const [payrollWorkerCount, setPayrollWorkerCount] = useState<number | null>(payoutSeed?.payrollWorkerCount ?? null);
  /** All available source files from the API. */
  const [sourceFiles, setSourceFiles] = useState<string[]>(initialData?.sourceFiles ?? []);
  /** Currently selected source file: null = latest (default), '__all__' = all time, or a specific filename. */
  const [selectedSourceFile, setSelectedSourceFile] = useState<string | null>(
    initialData?.sourceFiles?.[0] ?? null,
  );
  /** The actual file being displayed (resolved from selection). */
  const [activeSourceFile, setActiveSourceFile] = useState<string | null>(payoutSeed?.activeSourceFile ?? null);
  /** Wizard-sourced money the hours×rates sum can't see — KPI/catalog bonuses,
   *  Payroll Notes adjustments, orphanage pay, MESA, and the cycle's paid urgent
   *  one-offs (from /api/accounting/payout-extras). Added on top of the salary
   *  sum so the hero reads as the FULL pay run. Seeded from the tab-cache so a
   *  warm remount paints the full total at once; null until the first fetch. */
  const [payoutExtras, setPayoutExtras] = useState<import('@/lib/payroll/payout-extras').PayoutExtras | null>(
    payoutSeed?.payoutExtras ?? null,
  );
  /** Extras guarded by cycle: a response for a previously-viewed file must never
   *  inflate the current one while its own fetch is in flight. '__all__' scope
   *  (activeSourceFile = null) intentionally gets no extras. */
  const payoutExtrasForCycle =
    payoutExtras && activeSourceFile && payoutExtras.sourceFile === activeSourceFile ? payoutExtras : null;
  const payoutExtrasPhp = payoutExtrasForCycle?.extrasTotalPhp ?? 0;
  /** Name / department from Hubstaff rows for the selected payroll scope (for employees not on master list). */
  const [payrollIdentityByEmail, setPayrollIdentityByEmail] = useState<Record<
    string,
    { name: string | null; department: string | null }
  > | null>(payoutSeed?.payrollIdentityByEmail ?? null);
  /** Per-employee hours + initial pay for the selected payroll scope. */
  const [employeePayByEmail, setEmployeePayByEmail] = useState<Record<
    string,
    { hours: number; pay: number | null }
  >>(payoutSeed?.employeePayByEmail ?? {});
  /** Pending counts surfaced in the simple view's attention row. */
  const [pendingDisputes, setPendingDisputes] = useState<number | null>(null);
  const [oldestDisputeDays, setOldestDisputeDays] = useState<number | null>(null);
  const [pendingDisputeRows, setPendingDisputeRows] = useState<
    Array<{ id: string; work_email: string; dispute_date: string; created_at?: string; reason: string }>
  >([]);
  const [pendingLeaves, setPendingLeaves] = useState<number | null>(null);
  /** Full leave-request rows (email + window + type + status). Powers the
   *  "why is this person on the master list with no hours?" reason in the
   *  Hubstaff ↔ Master reconciliation export (on leave the whole period). */
  const [leaveRows, setLeaveRows] = useState<Array<{
    email: string; start: string; end: string; type: string; status: string;
  }>>([]);
  /** Bonuses keyed in (KPI Calculator → catalog-applied + HSL entries) for the
   *  active payroll week. null when no single week is selected or while loading. */
  const [bonusesKeyedIn, setBonusesKeyedIn] = useState<number | null>(null);
  /** Trailing-12-month attrition: separations + average headcount snapshot. */
  const [attrition, setAttrition] = useState<{
    separations: number;
    activeHeadcount: number;
    avgHeadcount: number;
    ratePct: number;
  } | null>(null);
  /** Offboarded-sheet identities keyed by normalized email (both work AND personal
   *  email point at the same record). Sourced from the Offboarded tab of the master
   *  Google Sheet (via /api/hr/offboard-history). A Hubstaff worker who is missing
   *  from the ACTIVE master list but present here is NOT a directory gap — they've
   *  already been offboarded, so the recon treats them as an expected exception. */
  const [offboardedByEmail, setOffboardedByEmail] = useState<Record<
    string,
    { name: string; personalEmail: string; department: string; offBoardedAt: string | null }
  > | null>(null);
  /** New hires in the trailing 30 days, derived from `start_date` on the master list. */
  const newHires = useMemo(() => {
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    const cutoff30 = now - 30 * day;
    const cutoff7 = now - 7 * day;
    let last30d = 0;
    let last7d = 0;
    let mostRecentMs: number | null = null;
    for (const e of employees) {
      const raw = e.start_date;
      if (!raw) continue;
      const t = new Date(raw).getTime();
      if (!Number.isFinite(t)) continue;
      if (t > now) continue;
      if (t >= cutoff30) {
        last30d += 1;
        if (mostRecentMs === null || t > mostRecentMs) mostRecentMs = t;
      }
      if (t >= cutoff7) last7d += 1;
    }
    const mostRecentDays = mostRecentMs == null
      ? null
      : Math.max(0, Math.floor((now - mostRecentMs) / day));
    return { last30d, last7d, mostRecentDays };
  }, [employees]);
  /** Which layout the user is currently viewing — persisted in localStorage.
   *  Lazy initializer reads from storage synchronously on the FIRST client
   *  render, so the component never momentarily renders 'simple' and then
   *  flips to 'expanded' on a follow-up effect. That flash was what made the
   *  toggle look like it was "switching by itself" on remount. */
  // Initial render MUST match the server output ('simple') — reading
  // localStorage in the useState initializer flipped the first client render
  // to 'expanded' for users with a saved preference, which threw a
  // hydration mismatch on the tablist's aria-selected + class strings.
  // We then sync from localStorage in a layout effect so the swap happens
  // before paint and there's no visible flash for most users.
  const [viewMode, setViewMode] = useState<'simple' | 'expanded'>('simple');
  const hydratedRef = React.useRef(false);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = window.localStorage.getItem('overview.viewMode');
      if (saved === 'simple' || saved === 'expanded') {
        setViewMode(saved);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Persist on change. Guarded by a hydrated flag so the first commit
  // (which already matches storage) doesn't clobber it before the user toggles.
  useEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
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
        const json = (await res.json()) as {
          rows?: {
            employee_email?: string;
            start_date?: string;
            end_date?: string;
            leave_type?: string;
            status?: string;
          }[];
        };
        if (!cancelled) {
          const rows = Array.isArray(json.rows) ? json.rows : [];
          setPendingLeaves(rows.filter((r) => (r.status ?? '').toLowerCase() === 'pending').length);
          setLeaveRows(
            rows
              .map((r) => ({
                email: (r.employee_email ?? '').trim().toLowerCase(),
                start: (r.start_date ?? '').slice(0, 10),
                end: (r.end_date ?? '').slice(0, 10),
                type: r.leave_type ?? '',
                status: (r.status ?? '').toLowerCase(),
              }))
              .filter((r) => r.email && r.start && r.end),
          );
        }
      } catch {
        if (!cancelled) {
          setPendingLeaves(null);
          setLeaveRows([]);
        }
      }
    })();
    (async () => {
      try {
        // Trailing-12-month attrition. Pulls offboarded employees + the active
        // roster and computes separations / average headcount.
        const [offRes, empRes] = await Promise.all([
          fetch('/api/hr/offboard-history', { cache: 'no-store' }),
          fetch('/api/employees', { cache: 'no-store' }),
        ]);
        const offJson = (await offRes.json()) as {
          rows?: {
            Name?: string | null;
            'Work Email'?: string | null;
            'Personal Email'?: string | null;
            Department?: string | null;
            off_boarded_at: string | null;
          }[];
        };
        const empJson = (await empRes.json()) as { employees?: unknown[] };
        const cutoff = Date.now() - 365 * 24 * 3600 * 1000;
        const separations = (offJson.rows ?? []).reduce((n, r) => {
          const t = r.off_boarded_at ? new Date(r.off_boarded_at).getTime() : NaN;
          return Number.isFinite(t) && t >= cutoff ? n + 1 : n;
        }, 0);
        // Index offboarded identities by BOTH normalized emails so the recon can
        // resolve a Hubstaff worker (matched on work email) to an already-offboarded
        // person even when only the personal email is on file.
        const offIndex: Record<
          string,
          { name: string; personalEmail: string; department: string; offBoardedAt: string | null }
        > = {};
        for (const r of offJson.rows ?? []) {
          const rec = {
            name: r.Name ?? '',
            personalEmail: r['Personal Email'] ?? '',
            department: r.Department ?? '',
            offBoardedAt: r.off_boarded_at ?? null,
          };
          const w = normEmail(r['Work Email'] ?? null);
          const p = normEmail(r['Personal Email'] ?? null);
          if (w) offIndex[w] = rec;
          if (p) offIndex[p] = rec;
        }
        if (!cancelled) setOffboardedByEmail(offIndex);
        const activeHeadcount = Array.isArray(empJson.employees) ? empJson.employees.length : 0;
        // Average headcount over the period ≈ start + end / 2.
        // start ≈ activeNow + everyone who left during the period.
        const avgHeadcount = activeHeadcount + separations / 2;
        const ratePct = avgHeadcount > 0 ? (separations / avgHeadcount) * 100 : 0;
        if (!cancelled) setAttrition({ separations, activeHeadcount, avgHeadcount, ratePct });
      } catch {
        if (!cancelled) {
          setAttrition(null);
          setOffboardedByEmail({});
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Bonuses keyed in for the active payroll week. The week's `period_start` is
  // the start date baked into the active Hubstaff filename — the SAME key the
  // Payroll Wizard uses to read applied bonuses (`bonus_catalog_applied` for the
  // KPI Calculator depts + `hsl_bonus_entries` for HSL depts). When no single
  // file is selected (e.g. "All Time"), there's no one week to count, so we
  // leave the count at "—".
  useEffect(() => {
    let cancelled = false;
    const range = activeSourceFile ? parseDateRangeFromFilename(activeSourceFile) : null;
    if (!range) {
      setBonusesKeyedIn(null);
      return;
    }
    const d = range.start;
    const periodStart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    (async () => {
      try {
        const [catRes, hslRes] = await Promise.all([
          fetch(`/api/bonus-catalog-applied?period_start=${periodStart}`, { cache: 'no-store' }),
          fetch(`/api/hsl-bonus/period-summary?depts=${HSL_DEPT_KEYS.join(',')}`, { cache: 'no-store' }),
        ]);
        const catJson = (await catRes.json()) as { rows?: unknown[] };
        const hslJson = (await hslRes.json()) as {
          rows?: { period_start: string; employee_count: number }[];
        };
        if (cancelled) return;
        const catCount = Array.isArray(catJson.rows) ? catJson.rows.length : 0;
        const hslCount = Array.isArray(hslJson.rows)
          ? hslJson.rows
              .filter((r) => r.period_start === periodStart)
              .reduce((n, r) => n + (Number(r.employee_count) || 0), 0)
          : 0;
        setBonusesKeyedIn(catCount + hslCount);
      } catch {
        if (!cancelled) setBonusesKeyedIn(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSourceFile]);

  /** PAB metrics — scoped to the currently selected source file (or merged across all when __all__). */
  const [pabMetrics, setPabMetrics] = useState<{
    loading: boolean;
    totalEmployees: number;
    eligible: number;
    notEligible: number;
    /** Σ per-eligible-employee PAB amount (custom dept variants included). */
    accruedPhp: number;
    monthLabel: string | null;
    periodEnd: Date | null;
    pabMonth: { year: number; month: number } | null;
  }>(
    pabMetricsSeed
      ? {
          loading: false,
          totalEmployees: pabMetricsSeed.totalEmployees,
          eligible: pabMetricsSeed.eligible,
          notEligible: pabMetricsSeed.notEligible,
          // Pre-field cache entries fall back to the flat base-amount product.
          accruedPhp: pabMetricsSeed.accruedPhp ?? pabMetricsSeed.eligible * sysBonusCfg.pab.amountPHP,
          monthLabel: pabMetricsSeed.monthLabel,
          periodEnd: pabMetricsSeed.periodEnd ? new Date(pabMetricsSeed.periodEnd) : null,
          pabMonth: pabMetricsSeed.pabMonth,
        }
      : { loading: true, totalEmployees: 0, eligible: 0, notEligible: 0, accruedPhp: 0, monthLabel: null, periodEnd: null, pabMonth: null },
  );

  const [pabEligibilityByEmail, setPabEligibilityByEmail] = useState<Map<string, boolean>>(
    () => (pabMetricsSeed ? new Map(pabMetricsSeed.eligibility) : new Map()),
  );
  const [pabFilter, setPabFilter] = useState<'all' | 'eligible' | 'not-eligible'>('all');
  const [techFilter, setTechFilter] = useState<'all' | 'eligible' | 'not-eligible'>('all');

  // ── Publish the hero "Total payout" so the CEO board mirrors it EXACTLY ───────
  // The CEO System Overview would otherwise recompute a BASE figure (Σ initial
  // pay) that drifts below this hero once PAB is added at period close (the
  // 10M vs 8M gap). We publish the exact number shown here, per cycle, so the CEO
  // reads Accounting's own total. Mirrors the displayTotalPayout math in
  // AccountingHero: initial pay + (PAB once today is past the period end) +
  // the wizard extras (bonuses / adjustments / orphanage / MESA / urgent).
  const heroTotalPhpForPublish = useMemo(() => {
    if (totalPayout == null) return null;
    let pabFinalized = false;
    if (!pabMetrics.loading && pabMetrics.periodEnd) {
      const t = new Date();
      t.setHours(0, 0, 0, 0);
      const e = new Date(pabMetrics.periodEnd);
      e.setHours(0, 0, 0, 0);
      pabFinalized = t.getTime() > e.getTime();
    }
    const pab = pabFinalized ? pabMetrics.accruedPhp : 0;
    return totalPayout + pab + payoutExtrasPhp;
  }, [totalPayout, pabMetrics.loading, pabMetrics.periodEnd, pabMetrics.accruedPhp, payoutExtrasPhp]);
  // NOTE: the publish effect lives lower down (after emailsMatched / activePeriod
  // are defined) so it can send the FULL hero snapshot the CEO board replicates.

  /**
   * Tech Bonus eligibility: employees who have completed 30 days of service
   * by the **selected period's end date** (or today, if no period is loaded).
   * Picking April's CSV shows tech eligibility as of end-of-April.
   */
  const { techBonusEligibility, techEligibilityByEmail } = useMemo(() => {
    // Tech Bonus eligibility is anchored to TODAY, not the selected PAB period
    // end. An employee is eligible iff their start_date is already at least
    // 30 calendar days in the past as of right now. Future eligibility on a
    // forward-looking period is intentionally NOT counted — we only show
    // people who have actually completed 30 days of service.
    const now = new Date();
    const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    let eligible = 0;
    let pending = 0;
    let unknown = 0;
    let considered = 0;
    // Per-email map drives the table filter — `null` means we couldn't decide
    // (missing or unparseable start_date), `true` = eligible, `false` = pending.
    const byEmail = new Map<string, boolean | null>();
    for (const e of employees) {
      // Skip departments excluded from the Tech bonus allowlist (e.g. US managers).
      if (!isDeptEligible(sysBonusCfg.tech, normalizeDeptToKey(e.department ?? null))) continue;
      considered += 1;
      const emailKey = normEmail(e.work_email ?? e.personal_email ?? '') ?? '';
      if (!e.start_date) {
        unknown += 1;
        if (emailKey) byEmail.set(emailKey, null);
        continue;
      }
      const sd = new Date(e.start_date);
      if (isNaN(sd.getTime())) {
        unknown += 1;
        if (emailKey) byEmail.set(emailKey, null);
        continue;
      }
      const eligibleFrom = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate() + 30).getTime();
      const isElig = todayMid >= eligibleFrom;
      if (isElig) eligible += 1;
      else pending += 1;
      if (emailKey) byEmail.set(emailKey, isElig);
    }
    return {
      techBonusEligibility: { eligible, pending, unknown, total: considered },
      techEligibilityByEmail: byEmail,
    };
  }, [employees, sysBonusCfg]);

  const fetchEmployees = React.useCallback(async (signal?: AbortSignal) => {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
      const res = await fetch('/api/employees', { cache: 'no-store', signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { employees: EmployeeRow[]; error: string | null };
      if (signal?.aborted) return;
      const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      setApiLatencyMs(Math.max(0, Math.round(t1 - t0)));
      setEmployees(json.employees ?? []);
      setEmployeesError(json.error ?? null);
    } catch (e) {
      if (signal?.aborted) return;
      setEmployees([]);
      setEmployeesError(e instanceof Error ? e.message : 'Failed to load employees');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  // Initial load — skip when the server already prefetched the roster.
  // (See app/accounting/page.tsx → prefetchAccountingData.) The visibility
  // and 60s-poll effects below will still refresh on tab focus / interval,
  // so the prefetched data isn't stale forever.
  const skippedInitialFetchRef = React.useRef(Boolean(initialData?.employees?.length));
  useEffect(() => {
    if (skippedInitialFetchRef.current) {
      skippedInitialFetchRef.current = false;
      return;
    }
    const ctrl = new AbortController();
    void fetchEmployees(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchEmployees]);

  // Re-fetch when the user focuses the tab (e.g. after syncing master list in admin)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void fetchEmployees();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchEmployees]);

  // Poll every 60 s as a background safety net
  useEffect(() => {
    const id = window.setInterval(() => void fetchEmployees(), 60_000);
    return () => window.clearInterval(id);
  }, [fetchEmployees]);

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

  // Load source file list once on mount, default to latest.
  // Skip the network fetch when the server already prefetched the list.
  useEffect(() => {
    if (initialData?.sourceFiles?.length) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/hubstaff-hours?source_files=1', { cache: 'no-store' });
        const json = (await res.json()) as { files?: string[]; error?: string | null };
        if (cancelled) return;
        const files = json.files ?? [];
        setSourceFiles(files);
        if (files.length > 0) {
          setSelectedSourceFile(files[0]);
        }
      } catch {
        /* no source files — will fall back to full fetch */
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute stats whenever the selected file changes
  useEffect(() => {
    // Wait for initial source file list to load (selectedSourceFile starts null)
    if (selectedSourceFile === null && sourceFiles.length === 0) {
      // First mount, source files not loaded yet — the above effect will set selectedSourceFile
    }
    let cancelled = false;
    // Show the loading placeholder only when this scope has nothing cached.
    // A warm cache was already painted via the seeded initial state (or is
    // repainted below on a filter switch), so we revalidate quietly.
    const payoutKey = payoutCacheKey(selectedSourceFile);
    const cachedPayout = getTabCache<CachedPayout>(payoutKey);
    if (cachedPayout) {
      setTotalPayout(cachedPayout.totalPayout);
      setPayrollWorkerCount(cachedPayout.payrollWorkerCount);
      setPayrollEmailsNorm(cachedPayout.payrollEmailsNorm ? new Set(cachedPayout.payrollEmailsNorm) : null);
      setPayrollIdentityByEmail(cachedPayout.payrollIdentityByEmail);
      setEmployeePayByEmail(cachedPayout.employeePayByEmail);
      setActiveSourceFile(cachedPayout.activeSourceFile);
      setPayoutLoading(false);
    } else {
      setPayoutLoading(true);
    }
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

        let ratesRows: EmployeeHourlyRateRow[];
        if (prefetchedRatesRef.current) {
          ratesRows = prefetchedRatesRef.current;
          prefetchedRatesRef.current = null; // consume once, subsequent refreshes re-fetch
        } else {
          const ratesRes = await fetch('/api/employee-hourly-rates', { cache: 'no-store' });
          const ratesJson = (await ratesRes.json()) as { rows: EmployeeHourlyRateRow[] };
          ratesRows = ratesJson.rows ?? [];
        }
        const ratesByEmail = indexHourlyRatesByEmail(ratesRows);

        // Accumulate payroll rows across all fetched files. Fetch concurrently
        // (was sequential) so the "All Time" scope doesn't stack one round-trip
        // per weekly upload; the single-file default only fetches one URL.
        const allPayrollRows: PayrollHubstaffRow[] = [];
        const hoursResults = await Promise.all(
          hoursUrls.map(async (url) => {
            try {
              const res = await fetch(url, { cache: 'no-store' });
              const json = (await res.json()) as {
                payrollRows?: PayrollHubstaffRow[] | null;
                error?: string | null;
              };
              return res.ok && !json.error && json.payrollRows ? json.payrollRows : [];
            } catch {
              return [] as PayrollHubstaffRow[];
            }
          }),
        );
        if (cancelled) return;
        for (const rows of hoursResults) allPayrollRows.push(...rows);

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
          const nextEmails = paySet.size > 0 ? paySet : null;
          const nextWorkerCount = paySet.size > 0 ? paySet.size : null;
          const nextTotal = hasAnyPay ? sum : null;
          const nextIdentity = mergePayrollIdentity(allPayrollRows);
          setPayrollEmailsNorm(nextEmails);
          setPayrollWorkerCount(nextWorkerCount);
          setTotalPayout(nextTotal);
          setPayrollIdentityByEmail(nextIdentity);
          setEmployeePayByEmail(perEmployeePay);
          setTabCache<CachedPayout>(payoutKey, {
            totalPayout: nextTotal,
            payrollWorkerCount: nextWorkerCount,
            payrollEmailsNorm: nextEmails ? [...nextEmails] : null,
            payrollIdentityByEmail: nextIdentity,
            employeePayByEmail: perEmployeePay,
            activeSourceFile: displayFile,
          });
        }
      } catch {
        // Keep the last good cached data on a background-refresh failure;
        // only blank the hero when there was nothing cached to fall back to.
        if (!cancelled && !hasTabCache(payoutKey)) {
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
    // payoutRefreshNonce re-runs this exact fetch in place when live data changes
    // (Realtime / poll / focus), so the hero re-settles without a manual reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSourceFile, sourceFiles, payoutRefreshNonce]);

  // Fetch the cycle's payout extras (bonuses / adjustments / orphanage / MESA /
  // urgent) alongside the salary sum. Keyed on the same refresh nonce so the
  // extras re-settle with every Realtime push, poll tick, and tab focus. On a
  // transient failure the last known extras are kept — the sourceFile guard on
  // payoutExtrasForCycle already prevents cross-cycle bleed.
  useEffect(() => {
    const file = activeSourceFile;
    if (!file) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/accounting/payout-extras?source_file=${encodeURIComponent(file)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const json = (await res.json()) as import('@/lib/payroll/payout-extras').PayoutExtras;
        if (!cancelled && json && typeof json.extrasTotalPhp === 'number' && Number.isFinite(json.extrasTotalPhp)) {
          setPayoutExtras(json);
          // Fold into the payout tab-cache entry (when it's for the same file)
          // so the next remount seeds the FULL hero total in one paint.
          const key = payoutCacheKey(selectedSourceFile);
          const cachedEntry = getTabCache<CachedPayout>(key);
          if (cachedEntry && cachedEntry.activeSourceFile === file) {
            setTabCache<CachedPayout>(key, { ...cachedEntry, payoutExtras: json });
          }
        }
      } catch {
        /* keep the last known extras */
      }
    })();
    return () => { cancelled = true; };
    // selectedSourceFile is only read to locate the cache entry — activeSourceFile
    // (derived from it) already keys the fetch, so it's excluded from the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSourceFile, payoutRefreshNonce]);

  // Keep the Total Payout live. Watches the tables that feed the hero figure —
  // hours (new/edited time), hourly rates, and the bonus/adjustment tables — and
  // re-runs the payout fetch (via the nonce) on any change. Realtime pushes the
  // update instantly where the table is in the publication + anon-readable; the
  // 30s poll + tab-focus refresh keep it fresh otherwise. onStatusChange gives us
  // an honest "is the websocket actually live" signal for the green dot.
  useLiveRefresh({
    channel: 'accounting-payout',
    // Core figure = hours × rates. `app_settings` also carries the dispatch lock
    // and any pulse writes. Realtime fires for whichever of these is in the
    // publication + anon-readable; the 30s poll is the universal catch-all for
    // the rest (bonuses, adjustments, PAB) so nothing gets stuck.
    tables: [
      'hubstaff_hours',
      'employee_hourly_rates',
      'time_adjustment_requests',
      'pab_day_disputes',
      'app_settings',
    ],
    enabled: !payoutLoading,
    onRefresh: () => setPayoutRefreshNonce(n => n + 1),
    onStatusChange: setPayoutRealtime,
  });

  // "Is payroll processing / payment dispatch underway right now." When true the
  // Total Payout is not final (bonuses, adjustments, and dispatch can still move
  // it), so the hero shows an amber "processing" pill + note. Realtime-backed.
  const { state: dispatchLock } = useDispatchLock();
  const payrollProcessing = dispatchLock.locked;

  // HSL master-list emails — stable across employee re-fetches when membership is unchanged,
  // so the PAB effect below doesn't re-run (and flash its loading indicator) on every 60s poll.
  const hslMasterEmailsKey = useMemo(() => hslEmailsKeyFromEmployees(employees), [employees]);

  // Compute PAB eligibility for the currently-selected source file
  // (or merged across every file when "__all__" is selected).
  useEffect(() => {
    if (sourceFiles.length === 0) return;
    let cancelled = false;
    const pabKey = pabMetricsCacheKey(selectedSourceFile, monthFilter, employees.length, hslMasterEmailsKey);
    const cachedPab = getTabCache<CachedPabMetrics>(pabKey);
    if (cachedPab) {
      // Paint cached metrics immediately and revalidate without a spinner.
      setPabEligibilityByEmail(new Map(cachedPab.eligibility));
      setPabMetrics({
        loading: false,
        totalEmployees: cachedPab.totalEmployees,
        eligible: cachedPab.eligible,
        notEligible: cachedPab.notEligible,
        accruedPhp: cachedPab.accruedPhp ?? cachedPab.eligible * sysBonusCfg.pab.amountPHP,
        monthLabel: cachedPab.monthLabel,
        periodEnd: cachedPab.periodEnd ? new Date(cachedPab.periodEnd) : null,
        pabMonth: cachedPab.pabMonth,
      });
    } else {
      setPabMetrics(prev => ({ ...prev, loading: true }));
    }
    (async () => {
      try {
        const allCols = new Set<string>();
        const rowsByEmail = new Map<string, Record<string, unknown>>();

        // Always merge every source file so we have a complete picture of every
        // employee's hours. The currently-selected file only affects WHICH PAB
        // month we anchor the eligibility window to (computed below).
        //
        // One batched request: the server groups every archived week by
        // source_file in a single table scan (was an N-parallel fetch, one per
        // weekly upload — the dominant cause of the ~1min Overview load). Re-order
        // the response to `sourceFiles` order so the merge below keeps its "later
        // upload wins for shared columns" semantics; a missing/failed file
        // degrades to null exactly like a failed per-file fetch did.
        let fileResults: {
          file: string;
          columns: string[] | null;
          rows: Record<string, unknown>[] | null;
        }[];
        try {
          const res = await fetch('/api/hubstaff-hours?all_files=1', { cache: 'no-store' });
          const json = (await res.json()) as {
            files?:
              | { source_file: string; columns: string[] | null; rows: Record<string, unknown>[] | null }[]
              | null;
          };
          const byFile = new Map((json.files ?? []).map((f) => [f.source_file, f] as const));
          fileResults = sourceFiles.map((file) => {
            const hit = byFile.get(file);
            return { file, columns: hit?.columns ?? null, rows: hit?.rows ?? null };
          });
        } catch {
          fileResults = sourceFiles.map((file) => ({ file, columns: null, rows: null }));
        }
        if (cancelled) return;

        for (const { file, columns, rows } of fileResults) {
          if (!columns || !rows) continue;
          for (const row of rows) {
            const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
            const email = normEmail(rawEmail) ?? rawEmail.toLowerCase();
            if (!email) continue;

            const needsResolve = columnsAreAllCanonical(columns);
            const resolved = needsResolve ? resolveCanonicalColumnsToIso(row, file) : row;
            for (const col of (needsResolve ? Object.keys(resolved) : columns)) allCols.add(col);

            const existing = rowsByEmail.get(email) ?? {};
            rowsByEmail.set(email, { ...existing, ...resolved });
          }
        }

        if (cancelled) return;

        const cols = [...allCols];
        const pabCfg = await fetchPabPeriodSettings();

        // Fetch US-holiday forgiveness settings — same shape as PayrollWizard uses —
        // plus the HSL week-model cutover (Mon→Sun legacy vs Sun→Sat post-cutover).
        let usHolidayDates: Map<string, string> = new Map();
        let hslCutoverValue: string | null = null;
        try {
          const hRes = await fetch(
            `/api/app-settings?keys=${encodeURIComponent([US_HOLIDAYS_ENABLED_KEY, US_HOLIDAYS_LIST_KEY, HSL_WEEK_MODEL_CUTOVER_KEY].join(','))}`,
            { cache: 'no-store' },
          );
          const hJson = (await hRes.json()) as { values?: Record<string, string | null> };
          const hValues = hJson.values ?? {};
          const hEnabled = hValues[US_HOLIDAYS_ENABLED_KEY] === null || hValues[US_HOLIDAYS_ENABLED_KEY] === undefined
            ? true
            : hValues[US_HOLIDAYS_ENABLED_KEY] === 'true';
          usHolidayDates = getEnabledHolidayMap(parseUsHolidaysList(hValues[US_HOLIDAYS_LIST_KEY] ?? null), hEnabled);
          hslCutoverValue = hValues[HSL_WEEK_MODEL_CUTOVER_KEY] ?? null;
        } catch { /* no-op — empty holiday map preserves prior behavior */ }

        let start: Date;
        let end: Date;
        let startSunSat: Date;
        let endSunSat: Date;
        let monthLabel: string;
        let pabMonth: { year: number; month: number } | null = null;

        if (isValidManualPabRange(pabCfg)) {
          start = pabCfg.start;
          end = pabCfg.end;
          monthLabel = `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
          pabMonth = { year: end.getFullYear(), month: end.getMonth() };
          const rSunSat = getPabMonthRangeSunSat(pabMonth.year, pabMonth.month);
          startSunSat = rSunSat.start;
          endSunSat = rSunSat.end;
        } else {
          // Anchor priority:
          //   1. monthFilter (explicit "Month" dropdown pick)
          //   2. older specific CSV (not the newest)
          //   3. latest date found in uploaded column headers (e.g. May data → May PAB)
          //   4. current calendar month (fallback when no uploads present)
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
              // Resolve from the file's END date through override windows so a CSV
              // inside a custom window (e.g. May → Jun 1–Jul 3) maps to that month.
              const m = /(\d{4})-(\d{2})-(\d{2})_to_(\d{4})-(\d{2})-(\d{2})/.exec(selectedSourceFile);
              if (m) {
                const endDate = new Date(+m[4], +m[5] - 1, +m[6]);
                pabMonth = resolvePabMonthForDate(endDate, pabCfg.overrides);
              }
            }
          }
          // Latest uploaded date, override-window-aware (custom month stays sticky).
          if (!pabMonth) pabMonth = resolvePabMonthFromColumns(cols, pabCfg.overrides) ?? getCurrentPabMonth();
          // Explicit window: saved override for this month, else canonical default.
          // An override is a single range — it bounds both the Mon–Fri and Sun–Sat
          // evaluations (it is authoritative for every department once set).
          const r = resolvePabRangeForMonth(pabMonth.year, pabMonth.month, pabCfg.overrides);
          start = r.start;
          end = r.end;
          const rSunSat = r.isOverride
            ? { start: r.start, end: r.end }
            : getPabMonthRangeSunSat(pabMonth.year, pabMonth.month);
          startSunSat = rSunSat.start;
          endSunSat = rSunSat.end;
          const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          monthLabel = `${monthNames[pabMonth.month]} ${pabMonth.year}`;
        }

        // Approved-dispute forgiveness + approved TIME ADJUSTMENTS + orphanage
        // PAB coverage — the SAME adjustments the wizard applies (its
        // effectiveOverrides = disputes overlaid by time adjustments, then
        // applyPabAdjustments semantics), so the Eligible pill agrees with the
        // PAB Calendar modal and what payroll actually pays. Best-effort: a
        // failed fetch degrades to raw hours exactly like before.
        // HSL week model for this period (Mon→Sun legacy vs Sun→Sat post-cutover)
        // — resolved from the period start exactly like the Payroll Wizard.
        const hslWeekModel = resolveHslWeekModelWithDefault(start, hslCutoverValue);

        const approvedDisputesByEmail = new Map<string, Map<string, number | null>>();
        const approvedAdjustmentsByEmail = new Map<string, Map<string, number>>();
        let orphanageCoverage = new Map<string, Map<string, number>>();
        {
          const from = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
          // Window through the HSL ADJUSTED end (week-closing Sat/Sun), not the
          // raw period end — HSL's last week extends past `end` and the calendar
          // modal fetches disputes unwindowed, so stopping at end+1 would let a
          // forgiven extension day flip the pill but not the calendar.
          const windowEnd = getHslAdjustedEnd(end, hslWeekModel);
          const dayAfterEnd = new Date(windowEnd.getFullYear(), windowEnd.getMonth(), windowEnd.getDate() + 1);
          const to = `${dayAfterEnd.getFullYear()}-${String(dayAfterEnd.getMonth() + 1).padStart(2, '0')}-${String(dayAfterEnd.getDate()).padStart(2, '0')}`;
          // Each source degrades INDEPENDENTLY (like the wizard's three separate
          // fetch effects) — a failed orphanage fetch must not drop the disputes
          // and time adjustments that already succeeded.
          await Promise.all([
            fetch(`/api/pab-disputes?status=approved&status=accounting_approved&from=${from}&to=${to}`, { cache: 'no-store' })
              .then((r) => r.json())
              .then((dJson: { rows?: { work_email: string; dispute_date: string; override_hours: number | null }[] }) => {
                for (const row of dJson.rows ?? []) {
                  const em = (row.work_email ?? '').trim().toLowerCase();
                  if (!em) continue;
                  const dates = approvedDisputesByEmail.get(em) ?? new Map<string, number | null>();
                  dates.set(row.dispute_date, row.override_hours);
                  approvedDisputesByEmail.set(em, dates);
                }
              })
              .catch(() => { /* best-effort — no dispute forgiveness this pass */ }),
            fetch(`/api/time-adjustments?status=approved&from=${from}&to=${to}`, { cache: 'no-store' })
              .then((r) => r.json())
              .then((tJson: { rows?: { work_email: string; adjust_date: string; approved_hours: number | null }[] }) => {
                for (const row of tJson.rows ?? []) {
                  if (row.approved_hours == null) continue;
                  const em = (row.work_email ?? '').trim().toLowerCase();
                  if (!em) continue;
                  const dates = approvedAdjustmentsByEmail.get(em) ?? new Map<string, number>();
                  dates.set(row.adjust_date, row.approved_hours);
                  approvedAdjustmentsByEmail.set(em, dates);
                }
              })
              .catch(() => { /* best-effort — no adjustment overlay this pass */ }),
            fetch('/api/orphanage-pay?all=1', { cache: 'no-store' })
              .then((r) => r.json())
              .then((oJson: { rows?: { source_file: string | null; employee_email: string; hours: number }[] }) => {
                orphanageCoverage = buildOrphanageCoverageMap(
                  (oJson.rows ?? []).map((r) => ({ sourceFile: r.source_file, email: r.employee_email, hours: r.hours })),
                );
              })
              .catch(() => { /* best-effort — no orphanage coverage this pass */ }),
          ]);
        }
        if (cancelled) return;

        // Build HSL email set from the memoized key (stable across no-op employee re-fetches).
        const hslMasterEmails = new Set<string>(hslMasterEmailsKey ? hslMasterEmailsKey.split(',') : []);

        // In-progress month handling: only count days that have BOTH already
        // happened AND have Hubstaff data uploaded for them. Without this clamp:
        //  - future days have seconds=0 → fail
        //  - past days from weeks Hubstaff hasn't uploaded yet also fail
        // The first effect was already obvious; the second one bites every time
        // the dashboard runs ahead of the weekly Hubstaff upload (which is the
        // normal state mid-week, since uploads are weekly batches).
        //
        // After the PAB period ends AND Hubstaff has uploaded the final week,
        // both clamps become no-ops and the chart matches the settled total.
        const today = new Date();
        const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());

        // Latest day Hubstaff has data for. Parse the end date out of every
        // source-file name (format: `…_YYYY-MM-DD_to_YYYY-MM-DD.csv`) and take
        // the max. Falls back to today if no filename parses, which preserves
        // the original behavior for hand-uploaded files.
        const latestHubstaffDay = (() => {
          let maxT = -Infinity;
          for (const f of sourceFiles) {
            const m = /(\d{4})-(\d{2})-(\d{2})_to_(\d{4})-(\d{2})-(\d{2})/.exec(f);
            if (!m) continue;
            const t = new Date(+m[4], +m[5] - 1, +m[6]).getTime();
            if (t > maxT) maxT = t;
          }
          return maxT === -Infinity ? todayMid : new Date(maxT);
        })();

        const evalCeiling = Math.min(todayMid.getTime(), latestHubstaffDay.getTime(), end.getTime());
        const standardEvalEnd = new Date(evalCeiling);
        // Sun–Sat eval ceiling for non-HSL employees.
        const evalCeilingSunSat = Math.min(todayMid.getTime(), latestHubstaffDay.getTime(), endSunSat.getTime());
        const standardEvalEndSunSat = new Date(evalCeilingSunSat);

        // For HSL we need WHOLE weeks (the rule is per-week). When the period is
        // complete, extend to the day that closes its last week (Sunday for
        // mon_sun, Saturday for sun_sat — wizard parity via getHslAdjustedEnd);
        // while in progress, clamp to the last completed week-close day at or
        // before the standard evaluation ceiling so an in-progress week isn't
        // penalized for not having its days filled in yet.
        const hslEvalEnd = (() => {
          if (standardEvalEnd.getTime() >= end.getTime()) return getHslAdjustedEnd(end, hslWeekModel);
          const dow = standardEvalEnd.getDay(); // Sun=0 … Sat=6
          const daysBack = hslWeekModel === 'sun_sat' ? (dow === 6 ? 0 : dow + 1) : dow;
          const lastClose = new Date(
            standardEvalEnd.getFullYear(),
            standardEvalEnd.getMonth(),
            standardEvalEnd.getDate() - daysBack,
          );
          // If even the last week-close day is before the period started, there's
          // nothing to evaluate yet — return the day before the FIRST WEEK'S
          // ANCHOR so the HSL check sees an empty range and treats the employee
          // as still eligible. (`start - 1` is NOT empty under sun_sat: the
          // anchor Sunday sits on/before it and would score a 1-day fragment.)
          if (lastClose.getTime() < start.getTime()) {
            const anchor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
            const aDow = anchor.getDay();
            if (hslWeekModel === 'sun_sat') anchor.setDate(anchor.getDate() - aDow);
            else anchor.setDate(anchor.getDate() + (aDow === 0 ? 1 : aDow === 1 ? 0 : 8 - aDow));
            return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 1);
          }
          return lastClose;
        })();

        let eligible = 0;
        let notEligible = 0;
        let evaluated = 0;
        let accruedPhp = 0;
        const eligMap = new Map<string, boolean>();

        // Iterate the ACTIVE MASTER LIST, not Hubstaff history. The previous
        // loop ran over `rowsByEmail` (every email Hubstaff has ever seen,
        // ~1076 incl. former employees) which made the denominator wrong.
        // For each master employee we look up their Hubstaff row by either
        // work or personal email — if they have no Hubstaff row at all, the
        // empty `hoursByDateKey` naturally fails eligibility (no hours
        // tracked = not perfect attendance).
        const masterEntries: { email: string; rowEmail: string; deptKey: string | null; row: Record<string, unknown> }[] = [];
        for (const e of employees) {
          const w = normEmail(e.work_email ?? null);
          const p = normEmail(e.personal_email ?? null);
          const key = w ?? p;
          if (!key) continue;
          // Skip departments excluded from the PAB allowlist (e.g. US managers)
          // so they don't inflate the eligible count / accrual. The dept key is
          // kept so the accrual can price each person at their department's
          // amount (custom currency variants override the base).
          const deptKey = normalizeDeptToKey(e.department ?? null);
          if (!isDeptEligible(sysBonusCfg.pab, deptKey)) continue;
          const wRow = w ? rowsByEmail.get(w) : undefined;
          const pRow = p ? rowsByEmail.get(p) : undefined;
          const hubRow = wRow ?? pRow ?? {};
          // The email that KEYED the Hubstaff row — forgiveness lookups below use
          // this (not every alias) because the wizard and the server pay engine
          // key dispute/adjustment/orphanage forgiveness strictly by the Hubstaff
          // row's Email; matching a wider alias set would paint an Eligible pill
          // for someone payroll dispatch does not actually pay.
          const rowEmail = wRow ? w! : pRow ? p! : key;
          masterEntries.push({ email: key, rowEmail, deptKey, row: hubRow as Record<string, unknown> });
        }

        const holidayIsoSet = usHolidayDates.size > 0 ? new Set(usHolidayDates.keys()) : undefined;

        for (const { email, rowEmail, deptKey, row: mergedRow } of masterEntries) {
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

          // Engine-parity adjustments — approved-dispute forgiveness overlaid by
          // approved time adjustments (adjustment wins on the same day — wizard's
          // effectiveOverrides ordering), US-holiday force-pass, and orphanage
          // top-up — the exact semantics of the server/wizard engine, keyed by
          // the Hubstaff row email exactly like both of them.
          const disputeDates = approvedDisputesByEmail.get(rowEmail);
          const adjustmentDates = approvedAdjustmentsByEmail.get(rowEmail);
          let forgivenDates: Map<string, number | null> | undefined;
          if (disputeDates?.size || adjustmentDates?.size) {
            forgivenDates = new Map(disputeDates ?? []);
            if (adjustmentDates) for (const [d, h] of adjustmentDates) forgivenDates.set(d, h);
          }
          const orphanageByIso = orphanageCoverage.get(rowEmail);
          const effectiveHours = applyPabAdjustments(hoursByDateKey, forgivenDates, holidayIsoSet, orphanageByIso);

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
            // HSL rule: 7-day weeks (anchor per hslWeekModel), ≥5 days at ≥7 h per
            // week. Evaluate only fully-completed weeks during in-progress months.
            isEligible = checkHslPabEligibility(start, hslEvalEnd, effectiveHours, hslWeekModel);
          } else {
            // Non-HSL rule (Sun–Sat weeks): all Mon–Fri days must be ≥7 h.
            // Use the Sun–Sat PAB range and its evaluation ceiling.
            const weeks = buildPabCalendarWeeks(startSunSat, standardEvalEndSunSat, effectiveHours);
            const allDays = weeks.flat();
            isEligible = allDays.length === 0 || allDays.every(d => d.passes);
          }

          eligMap.set(email, isEligible);
          if (isEligible) {
            eligible++;
            accruedPhp += systemBonusAmountForDept(sysBonusCfg.pab, deptKey);
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
            accruedPhp,
            monthLabel,
            periodEnd: end,
            pabMonth,
          });
          setTabCache<CachedPabMetrics>(pabKey, {
            totalEmployees: evaluated,
            eligible,
            notEligible,
            accruedPhp,
            monthLabel,
            periodEnd: end ? end.toISOString() : null,
            pabMonth,
            eligibility: [...eligMap],
          });
        }
      } catch {
        // Preserve the cached metrics on a background-refresh failure.
        if (!cancelled && !hasTabCache(pabKey)) {
          setPabMetrics({ loading: false, totalEmployees: 0, eligible: 0, notEligible: 0, accruedPhp: 0, monthLabel: null, periodEnd: null, pabMonth: null });
        }
      }
    })();
    return () => { cancelled = true; };
    // `employees.length` (not the full array) so the 60s refetch of the same
    // roster doesn't churn this expensive effect; size changes capture
    // hires/leavers. `hslMasterEmailsKey` already covers HSL membership shifts.
  }, [sourceFiles, selectedSourceFile, monthFilter, hslMasterEmailsKey, employees.length, sysBonusCfg]);

  /** Master-list rows only. Hubstaff-only workers are no longer merged into
   *  Overview totals — the master list is the single source of truth. */
  const mergedEmployees = useMemo((): OverviewEmployeeRow[] => {
    const masterRows: OverviewEmployeeRow[] = employees.map((e) => ({
      ...e,
      recordSource: 'master',
    }));
    masterRows.sort((a, b) => {
      const an = (a.name ?? a.personal_email ?? '').toLowerCase();
      const bn = (b.name ?? b.personal_email ?? '').toLowerCase();
      return an.localeCompare(bn, undefined, { sensitivity: 'base' });
    });
    return masterRows;
  }, [employees]);

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
    if (techFilter !== 'all') {
      list = list.filter((e) => {
        const emailKey = normEmail(e.work_email ?? e.personal_email ?? '') ?? '';
        const elig = emailKey ? techEligibilityByEmail.get(emailKey) : undefined;
        // Treat unknown (null) as not-eligible so it doesn't slip into the
        // "eligible" bucket — matches what techBonusEligibility totals show.
        return techFilter === 'eligible' ? elig === true : elig !== true;
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
  }, [mergedEmployees, departmentFilter, searchQuery, pabFilter, pabEligibilityByEmail, techFilter, techEligibilityByEmail]);

  const totalPages = Math.max(1, Math.ceil(filteredEmployees.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, departmentFilter, pabFilter, techFilter, monthFilter]);

  useEffect(() => {
    setPage((p) => Math.min(p, totalPages));
  }, [totalPages]);

  const pageRows = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredEmployees.slice(start, start + PAGE_SIZE);
  }, [filteredEmployees, safePage]);

  /** Single source of truth for the Master ↔ Hubstaff reconciliation: the
   *  drill-down rows AND every tile count are computed together here so they can
   *  never disagree. Statuses:
   *    - "On Master & worked"        → directory employee who logged hours
   *    - "On Master, no hours"       → an UNEXPLAINED no-hours row → a real gap
   *    - "Exception"                 → no-hours but EXPECTED, so NOT a gap:
   *        a no-Hubstaff-by-nature dept (SMM Freelancer / Site Building), a
   *        just-hired start date, or approved leave covering the period
   *    - "In Hubstaff, not on Master"→ logged hours but missing from the directory
   *  Counts are null until the payroll scope loads (tiles show "—"); the rows are
   *  always built. Feeds the modal, the CSV export, AND the CEO-mirror snapshot. */
  const masterRecon = useMemo(() => {
    const worked = payrollEmailsNorm; // Set of normalized emails with hours this scope, or null
    const payFor = (w: string, p: string): { hours: number; pay: number | null } | undefined => {
      if (w && employeePayByEmail[w]) return employeePayByEmail[w];
      if (p && employeePayByEmail[p]) return employeePayByEmail[p];
      return undefined;
    };

    // Index leaves by normalized email so we can explain a no-hours person as
    // "on leave the whole period" rather than an unexplained gap.
    type Leave = { email: string; start: string; end: string; type: string; status: string };
    const leavesByEmail = new Map<string, Leave[]>();
    for (const lv of leaveRows) {
      const k = normEmail(lv.email) ?? lv.email;
      const arr = leavesByEmail.get(k);
      if (arr) arr.push(lv);
      else leavesByEmail.set(k, [lv]);
    }

    const period = parsePeriodRange(activeSourceFile); // null for "All Time"
    const todayISO = new Date().toISOString().slice(0, 10);
    const prettyType = (t: string) => (t.trim() ? t.trim() : 'Leave');

    /** Classify a no-hours master employee. `exception: true` means the absence
     *  is EXPECTED (dept exempt / just hired / on leave) and is NOT a gap.
     *  Priority: no-Hubstaff dept → leave → onboarding timing → unknown gap. */
    const classifyNoHours = (
      e: EmployeeRow,
      w: string,
      p: string,
    ): { reason: string; exception: boolean; status?: string } => {
      // 0) Department has no Hubstaff by nature (freelance / project-based).
      if (isHubstaffExemptDept(e.department)) {
        return {
          reason: `${e.department ?? 'This team'} — no Hubstaff tracking by nature`,
          exception: true,
        };
      }

      // 1) APPROVED leave (filed through the Employee portal) that OVERLAPS the pay
      //    period OR is UPCOMING relative to it — i.e. any approved leave that
      //    hasn't already ended before this period started (`lv.end >= startISO`).
      //    This lets a leave filed for the following week still excuse the latest
      //    reconciled week. Old leaves that ended before the period do NOT count.
      //    In All-Time view we treat "on leave today or upcoming" the same way.
      //    A no-hours person here is shown as an EXCEPTION with their time-off
      //    excuse as the reason (not a gap). A still-pending request does NOT clear
      //    anything, so those fall through and stay flagged until HR approves them.
      const mine: Leave[] = [];
      for (const k of new Set([w, p].filter(Boolean))) {
        const arr = leavesByEmail.get(k);
        if (arr) mine.push(...arr);
      }
      if (mine.length) {
        const inWindow = mine
          .filter((lv) => lv.status === 'approved')
          .filter((lv) => (period ? lv.end >= period.startISO : lv.end >= todayISO))
          .sort((a, b) => a.start.localeCompare(b.start)); // prefer the earliest relevant leave
        const pick = inWindow[0];
        if (pick) {
          if (period) {
            let phrase: string;
            if (pick.start > period.endISO) {
              phrase = 'Upcoming approved leave';
            } else {
              const whole = pick.start <= period.startISO && pick.end >= period.endISO;
              phrase = whole ? 'On approved leave the entire period' : 'On approved leave part of the period';
            }
            return {
              reason: `${phrase} — ${prettyType(pick.type)} ${pick.start}→${pick.end}`,
              exception: true,
              status: HUBSTAFF_LEAVE_STATUS,
            };
          }
          const phrase = pick.start > todayISO ? 'Upcoming approved leave' : 'Currently on approved leave';
          return {
            reason: `${phrase} — ${prettyType(pick.type)} ${pick.start}→${pick.end}`,
            exception: true,
            status: HUBSTAFF_LEAVE_STATUS,
          };
        }
      }

      // 2) Onboarding timing — a start date landing in/after the period means
      //    they were just hired and hadn't started (or only just started)
      //    logging hours. Parse via Date since "Start Date" isn't guaranteed ISO.
      const startMs = e.start_date ? new Date(e.start_date.trim()).getTime() : NaN;
      if (Number.isFinite(startMs)) {
        const startShown = new Date(startMs).toISOString().slice(0, 10);
        if (period) {
          const pStart = new Date(period.startISO).getTime();
          const pEnd = new Date(period.endISO).getTime();
          if (startMs > pEnd) return { reason: `Not started yet — hired ${startShown}, after this period`, exception: true };
          if (startMs >= pStart) return { reason: `Newly onboarded — started ${startShown}, mid-period`, exception: true };
        } else {
          const now = Date.now();
          if (startMs > now) return { reason: `Not started yet — hired ${startShown}`, exception: true };
          if (now - startMs <= 30 * 24 * 3600 * 1000) return { reason: `Recently onboarded — started ${startShown}`, exception: true };
        }
      }

      // 3) Nothing in the HRIS explains it — a real gap to reconcile.
      return {
        reason: period
          ? 'No hours logged — reason unknown (check Hubstaff upload / time off)'
          : 'No hours on record — reason unknown',
        exception: false,
      };
    };

    const out: HubstaffMasterRow[] = [];
    const masterKeys = new Set<string>();
    let matched = 0;
    let gap = 0; // unexplained no-hours — the reconcile gaps
    let exceptions = 0; // expected no-hours — NOT gaps

    // Every master-list employee → worked / exception / gap.
    for (const e of employees) {
      const w = normEmail(e.work_email ?? null) ?? '';
      const p = normEmail(e.personal_email) ?? '';
      if (w) masterKeys.add(w);
      if (p) masterKeys.add(p);
      // Retired seats we drop from the recon entirely (adding their emails to
      // masterKeys above also keeps the Hubstaff-only loop from re-surfacing them).
      if (isHubstaffReconExcluded(w) || isHubstaffReconExcluded(p)) continue;
      const didWork = worked != null && ((w !== '' && worked.has(w)) || (p !== '' && worked.has(p)));
      const pay = payFor(w, p);
      if (didWork) {
        matched++;
        out.push({
          status: 'On Master & worked',
          reason: '',
          name: e.name ?? '',
          workEmail: e.work_email ?? '',
          personalEmail: e.personal_email ?? '',
          department: e.department ?? '',
          hours: pay ? pay.hours.toFixed(2) : '',
        });
      } else {
        const { reason, exception, status } = classifyNoHours(e, w, p);
        if (exception) exceptions++;
        else gap++;
        out.push({
          status: status ?? (exception ? HUBSTAFF_EXCEPTION_STATUS : 'On Master, no hours'),
          reason,
          name: e.name ?? '',
          workEmail: e.work_email ?? '',
          personalEmail: e.personal_email ?? '',
          department: e.department ?? '',
          hours: pay ? pay.hours.toFixed(2) : '',
        });
      }
    }

    // Hubstaff workers with no ACTIVE master-list match. The active master list
    // only holds CURRENT employees, so anyone who logged hours yet isn't on it has
    // already been offboarded (they were dropped from the directory). That's not a
    // reconciliation gap — treat every one of them as an offboarded exception,
    // enriched with the Offboarded-sheet identity/date when we have a match.
    let hubstaffOnly = 0; // kept at 0 — off-directory workers are no longer counted as gaps
    if (worked != null) {
      for (const em of worked) {
        if (masterKeys.has(em)) continue;
        if (isHubstaffReconExcluded(em)) continue; // retired seat — drop entirely
        exceptions++;
        const pay = employeePayByEmail[em];
        const off = offboardedByEmail?.[em];
        const ident = payrollIdentityByEmail?.[em];
        const when = off?.offBoardedAt ? ` ${String(off.offBoardedAt).slice(0, 10)}` : '';
        out.push({
          status: HUBSTAFF_EXCEPTION_STATUS,
          reason: off
            ? `Already offboarded${when} — on the Offboarded sheet, not a directory gap`
            : 'Not on the active Master List — treated as offboarded, not a directory gap',
          name: off?.name || ident?.name || '',
          workEmail: em,
          personalEmail: off?.personalEmail || '',
          department: off?.department || ident?.department || '',
          hours: pay ? pay.hours.toFixed(2) : '',
        });
      }
    }

    const isNull = payrollEmailsNorm === null;
    return {
      rows: sortHubstaffReconRows(out),
      emailsMatched: isNull ? null : matched,
      inMasterNotPayroll: isNull ? null : gap,
      reconExceptions: isNull ? null : exceptions,
      inPayrollNotMaster: isNull ? null : hubstaffOnly,
    };
  }, [employees, payrollEmailsNorm, employeePayByEmail, leaveRows, activeSourceFile, payrollIdentityByEmail, offboardedByEmail]);

  const { inPayrollNotMaster, inMasterNotPayroll, emailsMatched, reconExceptions } = masterRecon;
  const hubstaffReconRows = masterRecon.rows;

  const pabFinalizedForPayoutExpanded = (() => {
    if (pabMetrics.loading || !pabMetrics.periodEnd) return false;
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const e = new Date(pabMetrics.periodEnd); e.setHours(0, 0, 0, 0);
    return t.getTime() > e.getTime();
  })();
  const totalPayoutWithPab = totalPayout != null
    ? totalPayout + (pabFinalizedForPayoutExpanded ? pabMetrics.accruedPhp : 0) + payoutExtrasPhp
    : totalPayout;

  const stats = [
    {
      label: 'Total Payout',
      value: payoutLoading
        ? '…'
        : totalPayoutWithPab != null
          ? '₱' + totalPayoutWithPab.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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

  // ── Publish the FULL hero snapshot so the CEO board is an EXACT replica ───────
  // The CEO System Overview reads this and renders Accounting's own numbers/tiles.
  // Only for the LIVE cycle (selectedSourceFile === activeSourceFile) so the CEO,
  // which reads the current cycle's snapshot, always gets matching values; a
  // past-week view publishes nothing (CEO keeps the last live snapshot / falls back).
  useEffect(() => {
    const file = selectedSourceFile;
    if (!file || file === '__all__' || file !== activeSourceFile) return;
    if (payoutLoading || pabMetrics.loading || heroTotalPhpForPublish == null) return;
    // Like salary + PAB above, the extras are an async input to the hero total:
    // publishing before their fetch settles would overwrite the CEO board's
    // previously-correct snapshot with a salary-only number (extras read as 0).
    // payoutExtrasForCycle is null until a successful response for THIS cycle —
    // on persistent fetch failure we simply don't publish, and the CEO keeps
    // the last good snapshot or falls back to its own compute.
    if (payoutExtrasForCycle == null) return;
    let pabFinalized = false;
    if (pabMetrics.periodEnd) {
      const t = new Date();
      t.setHours(0, 0, 0, 0);
      const e = new Date(pabMetrics.periodEnd);
      e.setHours(0, 0, 0, 0);
      pabFinalized = t.getTime() > e.getTime();
    }
    const totalPayoutPhp = heroTotalPhpForPublish;
    const payload = {
      sourceFile: file,
      totalPayoutPhp,
      totalPayoutUsd: totalPayoutPhp / PHP_USD_FX,
      activeWorkers: payrollWorkerCount ?? null,
      masterTotal: employees.length,
      bonusesKeyedIn,
      emailsMatched,
      masterOnlyCount: inMasterNotPayroll,
      hubstaffOnlyCount: inPayrollNotMaster,
      exceptionsCount: reconExceptions,
      pabFinalized,
      periodLabel: activePeriod?.label ?? null,
      periodWeek: activePeriod?.week ?? null,
      // The full reconciliation breakdown so the CEO drill-down modal is an
      // exact replica (same rows + reasons) instead of a server recompute.
      reconRows: hubstaffReconRows,
    };
    const id = setTimeout(() => {
      void fetch('/api/accounting/overview-snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {
        /* best-effort — the CEO board falls back to its own computation */
      });
    }, 600);
    return () => clearTimeout(id);
  }, [
    selectedSourceFile,
    activeSourceFile,
    heroTotalPhpForPublish,
    payoutLoading,
    pabMetrics.loading,
    pabMetrics.periodEnd,
    payoutExtrasForCycle,
    payrollWorkerCount,
    employees.length,
    bonusesKeyedIn,
    emailsMatched,
    inMasterNotPayroll,
    inPayrollNotMaster,
    reconExceptions,
    activePeriod,
    hubstaffReconRows,
  ]);

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

  /** Expanded view: top departments by headcount.
   *  Reads the `Department` column straight from global_master_list (via the
   *  `active_employees` view that `/api/employees` returns). Rows whose
   *  Department is blank are NOT charted — they roll up into a separate
   *  "unassigned" tally surfaced as a footnote so the pie reflects real
   *  departments only. */
  const departmentMix = useMemo(() => {
    const counts = new Map<string, number>();
    let charted = 0;
    let unassigned = 0;
    for (const e of mergedEmployees) {
      const raw = (e.department ?? '').trim();
      if (!raw) {
        unassigned += 1;
        continue;
      }
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
      charted += 1;
    }
    const rows = [...counts.entries()]
      .map(([dept, n]) => ({ dept, count: n, pct: charted > 0 ? (n / charted) * 100 : 0 }))
      .sort((a, b) => b.count - a.count);
    return { total: charted, rows, unassigned };
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
      'Start Date', 'Hours', 'Initial Pay (PHP)', 'PAB Eligibility', 'Tech Bonus Eligibility',
    ];
    const rows = filteredEmployees.map((row) => {
      const email = row.work_email ?? row.personal_email ?? '';
      const emailKey = normEmail(email) ?? '';
      const pay = emailKey ? employeePayByEmail[emailKey] : undefined;
      const elig = emailKey ? pabEligibilityByEmail.get(emailKey) : undefined;
      const pabStatus = elig === true ? 'Eligible' : elig === false ? 'Ineligible' : 'N/A';
      const techElig = emailKey ? techEligibilityByEmail.get(emailKey) : undefined;
      const techStatus = techElig === true ? 'Eligible' : techElig === false ? 'Pending' : 'N/A';
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
        techStatus,
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
    });
    const csv = [headers.map((h) => `"${h}"`).join(','), ...rows].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 10);
    const filterSuffix = pabFilter !== 'all' ? `_pab-${pabFilter}` : '';
    const techSuffix = techFilter !== 'all' ? `_tech-${techFilter}` : '';
    const deptSuffix = departmentFilter ? `_${departmentFilter.toLowerCase().replace(/\s+/g, '-')}` : '';
    a.download = `employees_${dateStr}${deptSuffix}${filterSuffix}${techSuffix}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** Download the reconciliation as CSV — the ↓ shortcut on the tile and the
   *  Export button inside the drill-down modal both route here. */
  const exportHubstaffReconciliationCsv = () => {
    const dateStr = new Date().toISOString().slice(0, 10);
    const scope = activeSourceFile ? '_this-cycle' : '_all-time';
    downloadHubstaffReconCsv(
      hubstaffReconRows,
      `hubstaff-master-reconciliation${scope}_${dateStr}.csv`,
    );
  };

  /** Whether the Hubstaff ↔ Master reconciliation drill-down modal is open
   *  (opened by clicking the tile in the System Overview rail). */
  const [reconcileOpen, setReconcileOpen] = useState(false);

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
            <SmoothSelect
              aria-label="Source file"
              value={selectedSourceFile ?? ''}
              onChange={(v) => setSelectedSourceFile(v || null)}
              triggerClassName="h-8 w-full min-w-0 sm:w-auto sm:max-w-[340px]"
              options={[
                { value: '__all__', label: 'All Time (all uploads combined)' },
                ...sourceFiles.map((file, i) => ({ value: file, label: i === 0 ? `${file} (latest)` : file })),
              ]}
            />
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
              payoutRealtime={payoutRealtime}
              payrollProcessing={payrollProcessing}
              payrollProcessingBy={dispatchLock.lockedBy}
              payrollWorkerCount={payrollWorkerCount}
              masterTotal={employees.length}
              bonusesKeyedIn={bonusesKeyedIn}
              emailsMatched={emailsMatched}
              masterOnlyCount={inMasterNotPayroll}
              hubstaffOnlyCount={inPayrollNotMaster}
              pendingDisputes={pendingDisputes}
              oldestDisputeDays={oldestDisputeDays}
              pendingLeaves={pendingLeaves}
              attrition={attrition}
              newHires={newHires}
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
              pabBonusPhp={sysBonusCfg.pab.amountPHP}
              techBonusPhp={sysBonusCfg.tech.amountPHP}
              payoutExtras={payoutExtrasForCycle}
              pabEligibilityByEmail={pabEligibilityByEmail}
              pabFilter={pabFilter}
              setPabFilter={setPabFilter}
              techFilter={techFilter}
              setTechFilter={setTechFilter}
              onExportCsv={exportToCsv}
              onExportHubstaffCsv={exportHubstaffReconciliationCsv}
              onOpenHubstaffModal={() => setReconcileOpen(true)}
              apiStatus={
                employeesError
                  ? 'error'
                  : loading || payoutLoading || pabMetrics.loading
                    ? 'loading'
                    : 'live'
              }
              apiLatencyMs={apiLatencyMs}
              onPingApi={pingApiLatency}
              viewerEmail={viewerEmail}
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
              : totalPayoutWithPab != null
                ? '₱' + totalPayoutWithPab.toLocaleString('en-PH', { maximumFractionDigits: 0 })
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
              ? `${inPayrollNotMaster}↑ · ${inMasterNotPayroll}↓${reconExceptions ? ` · ${reconExceptions} exc` : ''}`
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
          sub={`${pendingDisputes ?? 0} issues · ${pendingLeaves ?? 0} leaves`}
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
                      <Label className="text-xs text-zinc-600 dark:text-zinc-500">
                        Department
                      </Label>
                      <SmoothSelect
                        aria-label="Department"
                        value={departmentFilter}
                        onChange={(v) => setDepartmentFilter(v)}
                        triggerClassName="h-9 w-full"
                        options={[
                          { value: '', label: 'All departments' },
                          ...departmentOptions.map((d) => ({ value: d, label: d })),
                        ]}
                      />
                    </div>
                    <div className="w-full space-y-1.5 sm:w-44">
                      <Label className="text-xs text-zinc-600 dark:text-zinc-500">
                        Month
                      </Label>
                      <SmoothSelect
                        aria-label="Month"
                        value={monthFilter}
                        onChange={(v) => setMonthFilter(v)}
                        triggerClassName="h-9 w-full"
                        options={[
                          { value: '', label: 'All months' },
                          ...monthOptions.map((m) => ({ value: m.value, label: m.label })),
                        ]}
                      />
                    </div>
                  </div>
                  {/* PAB + Tech filters — side-by-side, wrap on narrow widths */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  {/* PAB filter */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">PAB:</span>
                    <div className="relative flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
                      {(['all', 'eligible', 'not-eligible'] as const).map((f) => {
                        const labels = { all: 'All', eligible: 'Eligible', 'not-eligible': 'Not Eligible' };
                        const active = pabFilter === f;
                        const activeBg =
                          f === 'eligible'
                            ? 'bg-emerald-700 dark:bg-emerald-600'
                            : f === 'not-eligible'
                              ? 'bg-red-700 dark:bg-red-600'
                              : 'bg-zinc-900 dark:bg-zinc-100';
                        return (
                          <button
                            key={f}
                            type="button"
                            onClick={() => setPabFilter(f)}
                            className={cn(
                              'relative h-6 rounded-md px-2.5 text-[11px] font-medium transition-colors',
                              active
                                ? f === 'all'
                                  ? 'text-white dark:text-zinc-900'
                                  : 'text-white'
                                : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
                            )}
                          >
                            {active && (
                              <motion.span
                                layoutId="pab-filter-pill-expanded"
                                className={cn('absolute inset-0 rounded-md', activeBg)}
                                transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                              />
                            )}
                            <span className="relative">{labels[f]}</span>
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
                  {/* Tech Bonus filter */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">Tech:</span>
                    <div className="relative flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
                      {(['all', 'eligible', 'not-eligible'] as const).map((f) => {
                        const labels = { all: 'All', eligible: 'Eligible', 'not-eligible': 'Pending' };
                        const active = techFilter === f;
                        const activeBg =
                          f === 'eligible'
                            ? 'bg-indigo-700 dark:bg-indigo-600'
                            : f === 'not-eligible'
                              ? 'bg-amber-700 dark:bg-amber-600'
                              : 'bg-zinc-900 dark:bg-zinc-100';
                        return (
                          <button
                            key={f}
                            type="button"
                            onClick={() => setTechFilter(f)}
                            className={cn(
                              'relative h-6 rounded-md px-2.5 text-[11px] font-medium transition-colors',
                              active
                                ? f === 'all'
                                  ? 'text-white dark:text-zinc-900'
                                  : 'text-white'
                                : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
                            )}
                          >
                            {active && (
                              <motion.span
                                layoutId="tech-filter-pill-expanded"
                                className={cn('absolute inset-0 rounded-md', activeBg)}
                                transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                              />
                            )}
                            <span className="relative">{labels[f]}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
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
                                    onClick={() => { if (rowEmail) openPabCalendar(rowEmail, (row.department ?? '').trim().toLowerCase() === 'hsl'); }}
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

                  <div data-readonly-allow className="flex items-center gap-1">
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
                amount={formatPhp(sysBonusCfg.pab.amountPHP, 2)}
                eligible={pabMetrics.eligible}
                total={pabTotalForExpanded(pabMetrics)}
                loading={pabMetrics.loading}
                barClass="bg-gradient-to-r from-emerald-400 to-emerald-500"
              />
              <CompactBonus
                icon={<Laptop className="h-3.5 w-3.5 text-sky-500" />}
                label="Technology"
                sub="3rd paycheck · after 30d"
                amount={formatPhp(sysBonusCfg.tech.amountPHP, 2)}
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
              {departmentMix.unassigned > 0 && (
                <p className="mt-3 rounded-md border border-amber-200/70 bg-amber-50/60 px-2.5 py-1.5 text-[11px] text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
                  <strong>{departmentMix.unassigned}</strong> employee
                  {departmentMix.unassigned === 1 ? '' : 's'} have no{' '}
                  <span className="font-mono">Department</span> set on the master list — excluded from the chart.
                </p>
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
                            Issue · {row.dispute_date}
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
                      +{pendingDisputeRows.length - 6} more issues
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

      {/* Hubstaff ↔ Master reconciliation — searchable drill-down opened by the
          System Overview tile (mirrors the CSV export, plus live search). */}
      <HubstaffMasterMatchesModal
        open={reconcileOpen}
        onOpenChange={setReconcileOpen}
        rows={hubstaffReconRows}
        counts={{
          matched: emailsMatched,
          masterOnly: inMasterNotPayroll,
          hubstaffOnly: inPayrollNotMaster,
          exceptions: reconExceptions,
        }}
        periodLabel={activePeriod?.label ?? null}
        csvFilename={`hubstaff-master-reconciliation${activeSourceFile ? '_this-cycle' : '_all-time'}_${new Date().toISOString().slice(0, 10)}.csv`}
      />

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
              <div className="relative min-h-0 flex-1 overflow-y-auto p-4">
                {showPabCalLoader && (
                  <PabCalendarLoader
                    progress={pabCalProgress}
                    done={!pabCalLoading}
                    barClassName="bg-indigo-500"
                    onDone={() => setShowPabCalLoader(false)}
                  />
                )}
                <EmployeePabCalendar
                  employeeEmail={pabCalEmail}
                  trimToElapsedWeeks={false}
                  pabMonthOverride={pabMetrics.pabMonth}
                  isHsl={pabCalIsHsl}
                  onLoadingChange={setPabCalLoading}
                  onProgress={setPabCalProgress}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
