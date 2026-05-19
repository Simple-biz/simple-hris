'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AppFooter from '@/components/AppFooter';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  GraduationCap,
  HeartHandshake,
  Loader2,
  Menu,
  RefreshCw,
  Search,
  Sparkles,
  TrendingUp,
  UserMinus,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Toaster } from '@/components/ui/sonner';
import { normEmail } from '@/lib/email/norm-email';
import { SESSION_EMAIL_KEY, type Role } from '@/lib/rbac/views';
import { cn } from '@/lib/utils';
import HrSidebar, { type HrTab } from './HrSidebar';
import HrOnboarding from './HrOnboarding';
import HrOffboarding from './HrOffboarding';
import HrMesa from './HrMesa';
import GiftTracker from '@/components/orphanage/GiftTracker';
import LeaveRequestsPanel from '@/components/LeaveRequestsPanel';
import SWall from '@/components/swall/SWall';
import NotificationsPanel from '@/components/notifications/NotificationsPanel';
import type { EmployeeRow } from '@/lib/supabase/employees';
import DeptFilter from './DeptFilter';

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export default function HrApp() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams?.get('email') ?? null;

  const [activeTab, setActiveTab] = useState<HrTab>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [viewerEmail, setViewerEmail] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    try {
      const q = emailFromQuery?.trim() ?? '';
      if (q && isPlausibleEmail(q)) {
        const normalized = normEmail(q) ?? q.toLowerCase();
        sessionStorage.setItem(SESSION_EMAIL_KEY, normalized);
        setViewerEmail(normalized);
        return;
      }
      setViewerEmail(sessionStorage.getItem(SESSION_EMAIL_KEY));
    } catch {
      setViewerEmail(null);
    }
  }, [emailFromQuery]);

  useEffect(() => {
    if (!viewerEmail) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/employee-roles?email=${encodeURIComponent(viewerEmail)}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as { rows?: { role: Role }[] };
        const roles = (json.rows ?? []).map((r) => r.role);
        const allowed = roles.includes('admin') || roles.includes('hr_coordinator');
        if (cancelled) return;
        if (!allowed) {
          router.replace(viewerEmail ? `/employee?email=${encodeURIComponent(viewerEmail)}` : '/employee');
          return;
        }
        setAuthChecked(true);
      } catch {
        if (!cancelled) setAuthChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, [router, viewerEmail]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavOpen]);

  if (!authChecked) {
    return (
      <div className="flex h-screen items-center justify-center bg-white dark:bg-[#0d1117]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" aria-hidden />
      </div>
    );
  }

  return (
    <div className="flex h-dvh max-h-dvh w-full overflow-hidden bg-gradient-to-br from-white via-emerald-50/30 to-white text-zinc-900 dark:from-black dark:via-emerald-950/15 dark:to-black dark:text-zinc-100">
      {mobileNavOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden"
          aria-label="Close navigation menu"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <HrSidebar
        activeTab={activeTab}
        setActiveTab={(tab) => { setActiveTab(tab); setMobileNavOpen(false); }}
        mobileOpen={mobileNavOpen}
        viewerEmail={viewerEmail}
      />

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 border-b border-emerald-100/70 bg-white/95 px-3 py-2.5 backdrop-blur-md dark:border-emerald-950/40 dark:bg-[#0d1117]/95 md:hidden">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0 border-emerald-200/80 bg-white/80 dark:border-emerald-950/60 dark:bg-emerald-950/20"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            HR Dashboard
          </span>
        </header>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
            >
              {activeTab === 'overview' && <HrOverview viewerEmail={viewerEmail} />}
              {activeTab === 'onboarding' && <HrOnboarding />}
              {activeTab === 'offboarding' && <HrOffboarding />}
              {activeTab === 'leaves' && <LeaveRequestsPanel />}
              {activeTab === 'gift-tracker' && <GiftTracker viewerEmail={viewerEmail} />}
              {activeTab === 'mesa' && <HrMesa />}
              {activeTab === 'notifications' && (
                <NotificationsPanel viewerEmail={viewerEmail} accent="emerald" />
              )}
              {activeTab === 's-wall' && <HrSwallTab viewerEmail={viewerEmail} />}
            </motion.div>
          </AnimatePresence>
        </div>
        <AppFooter />
      </main>

      <Toaster richColors position="top-center" />
    </div>
  );
}

const HR_MESSAGES: { heading: (name: string) => string; body: string }[] = [
  {
    heading: (name) => `Welcome, ${name} — every great team starts with great people. ✦`,
    body: "Onboarding, offboarding, and everything in between flows through here. This is your space to shape how people experience the company.",
  },
  {
    heading: (name) => `Hi ${name} — culture is built one hire at a time. ✦`,
    body: "From a smooth first day to a graceful last one, your work here defines what people remember about us. Build it with care.",
  },
  {
    heading: (name) => `Good to see you, ${name} — you're the first face people meet. ✦`,
    body: "The standards you set for onboarding ripple through every team. Make those first impressions count.",
  },
  {
    heading: (name) => `Welcome back, ${name} — people are the product. ✦`,
    body: "Behind every dashboard, every payroll run, every dispute is a person you helped bring on board. Thank you for the work that makes the rest possible.",
  },
  {
    heading: (name) => `Hey ${name} — quietly making the company run. ✦`,
    body: "HR is the glue. Use this dashboard to keep onboarding tight, offboarding kind, and every transition clean.",
  },
];

const SPARKLES = [
  { left: '5%',  delay: '0s',    dur: '4.4s', size: '20px' },
  { left: '14%', delay: '1.2s',  dur: '3.8s', size: '16px' },
  { left: '24%', delay: '2.5s',  dur: '4.8s', size: '24px' },
  { left: '37%', delay: '0.6s',  dur: '3.6s', size: '18px' },
  { left: '51%', delay: '1.9s',  dur: '4.2s', size: '14px' },
  { left: '63%', delay: '0.8s',  dur: '4.6s', size: '22px' },
  { left: '75%', delay: '2.8s',  dur: '3.9s', size: '17px' },
  { left: '85%', delay: '1.5s',  dur: '4.3s', size: '20px' },
  { left: '93%', delay: '3.2s',  dur: '4.0s', size: '15px' },
] as const;

function HrOverview({ viewerEmail }: { viewerEmail: string | null }) {
  const msgIdx = Math.floor(Math.random() * HR_MESSAGES.length);
  const welcomeMsg = HR_MESSAGES[msgIdx]!;

  const rawFirst = viewerEmail?.includes('@')
    ? viewerEmail.split('@')[0]!.replace(/[._-]/g, ' ').split(' ')[0]
    : 'there';
  const greeting = rawFirst.charAt(0).toUpperCase() + rawFirst.slice(1);

  return (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:gap-8 lg:px-8 lg:pt-8">
      {/* Hero card */}
      <header className="relative overflow-hidden rounded-2xl border border-emerald-200/80 bg-gradient-to-br from-emerald-500 via-teal-600 to-zinc-900 px-5 py-7 text-white shadow-lg shadow-emerald-600/20 dark:border-emerald-900/50 dark:from-emerald-600 dark:via-teal-900 dark:to-black sm:px-7">
        <style>{`
          @keyframes floatSparkle {
            0%   { transform: translateY(0)      scale(1);    opacity: 0; }
            12%  {                                             opacity: 0.5; }
            80%  { transform: translateY(-115px) scale(0.65); opacity: 0.22; }
            100% { transform: translateY(-135px) scale(0.45); opacity: 0; }
          }
        `}</style>

        {SPARKLES.map((s, i) => (
          <span
            key={i}
            aria-hidden
            style={{
              position: 'absolute',
              bottom: '6px',
              left: s.left,
              fontSize: s.size,
              color: 'rgba(255,255,255,0.72)',
              animation: `floatSparkle ${s.dur} ${s.delay} infinite ease-in`,
              pointerEvents: 'none',
              userSelect: 'none',
              lineHeight: 1,
            }}
          >
            ✦
          </span>
        ))}

        <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/10 blur-3xl" aria-hidden />
        <div className="absolute -bottom-12 left-8 h-32 w-32 rounded-full bg-teal-300/20 blur-2xl" aria-hidden />

        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-emerald-100/90">
              <Sparkles className="h-3 w-3 shrink-0" />
              HR dashboard
            </div>
            <h1 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              {welcomeMsg.heading(greeting)}
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-emerald-100/85">
              {welcomeMsg.body}
            </p>
          </div>

          {/* Users badge */}
          <div className="flex shrink-0 items-center justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/20 bg-white/10 backdrop-blur-sm shadow-lg shadow-black/20">
              <Users className="h-8 w-8 text-emerald-100" />
            </div>
          </div>
        </div>
      </header>

      <OverviewBody />
    </div>
  );
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function tenure(iso: string | null | undefined): string {
  if (!iso) return '—';
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return '—';
  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  if (months < 0) { years -= 1; months += 12; }
  if (years > 0 && months > 0) return `${years}y ${months}m`;
  if (years > 0) return `${years}y`;
  if (months > 0) return `${months}mo`;
  const days = Math.floor((now.getTime() - start.getTime()) / 86400000);
  return days <= 0 ? 'New' : `${days}d`;
}

// ─── Overview body ────────────────────────────────────────────────────────────

type DeptStat = { department: string; count: number };

type TenureCohort = {
  key: 'new' | 'settling' | 'established' | 'veteran';
  label: string;
  range: string;
  count: number;
  pct: number;
};

const TENURE_COHORT_DEFS: { key: TenureCohort['key']; label: string; range: string; max: number }[] = [
  { key: 'new',         label: 'Newcomers',   range: '0–30 days',   max: 30 },
  { key: 'settling',    label: 'Settling',    range: '1–12 months', max: 365 },
  { key: 'established', label: 'Established', range: '1–3 years',   max: 365 * 3 },
  { key: 'veteran',     label: 'Veterans',    range: '3+ years',    max: Number.POSITIVE_INFINITY },
];

const PAGE_SIZE = 10;

// ─── Editorial Overview composition ──────────────────────────────────────────

const TENURE_PALETTE: Record<TenureCohort['key'], { bg: string; ring: string; dot: string }> = {
  new:         { bg: 'bg-emerald-400',  ring: 'ring-emerald-200/70',  dot: 'bg-emerald-500' },
  settling:    { bg: 'bg-emerald-600',  ring: 'ring-emerald-200/70',  dot: 'bg-emerald-700' },
  established: { bg: 'bg-teal-700',     ring: 'ring-teal-200/70',     dot: 'bg-teal-800' },
  veteran:     { bg: 'bg-zinc-900 dark:bg-zinc-100', ring: 'ring-zinc-200/70', dot: 'bg-zinc-900 dark:bg-zinc-100' },
};

function initialsFromName(name: string | null | undefined): string {
  const s = (name ?? '').trim();
  if (!s) return '··';
  // "Surname, Given 'Nick'" → use Given + Surname initials
  const commaSplit = s.split(',');
  if (commaSplit.length >= 2) {
    const first = (commaSplit[1] ?? '').trim().split(/\s+/)[0] ?? '';
    const last = (commaSplit[0] ?? '').trim();
    return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase() || '··';
  }
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return ((parts[0][0] ?? '') + (parts[parts.length - 1][0] ?? '')).toUpperCase() || '··';
}

interface OverviewEditorialSectionProps {
  loading: boolean;
  roster: EmployeeRow[];
  deptStats: DeptStat[];
  headcountSeries: { points: { label: string; value: number; year: number; month: number }[]; netDelta: number };
  tenureCohorts: TenureCohort[];
  recentHires: { row: EmployeeRow; days: number; t: number }[];
}

function OverviewEditorialSection({
  loading,
  roster,
  deptStats,
  headcountSeries,
  tenureCohorts,
  recentHires,
}: OverviewEditorialSectionProps) {
  const totalActive = roster.length;
  const newcomersThisMonth = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return roster.filter((r) => {
      if (!r.start_date) return false;
      const t = new Date(r.start_date).getTime();
      return Number.isFinite(t) && t >= monthStart;
    }).length;
  }, [roster]);

  return (
    <section className="relative overflow-hidden rounded-2xl border border-emerald-100/70 bg-white p-5 shadow-sm dark:border-emerald-950/40 dark:bg-zinc-950 sm:p-6 lg:p-8">
      {/* Decorative grain / shape */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-gradient-to-br from-emerald-100/60 via-teal-100/30 to-transparent blur-3xl dark:from-emerald-900/30 dark:via-teal-900/20"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 -left-16 h-64 w-64 rounded-full bg-gradient-to-tr from-emerald-50/80 via-transparent to-transparent blur-3xl dark:from-emerald-950/30"
      />

      {/* Editorial header strip */}
      <div className="relative flex flex-col gap-2 border-b border-zinc-100 pb-5 sm:flex-row sm:items-end sm:justify-between dark:border-zinc-900">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-emerald-700/80 dark:text-emerald-400/70">
            Workforce · Issue No. {String(new Date().getFullYear()).slice(-2)}/{String(new Date().getMonth() + 1).padStart(2, '0')}
          </p>
          <h2 className="mt-1 text-2xl font-semibold leading-tight tracking-tight text-zinc-900 dark:text-zinc-50 sm:text-3xl">
            The people behind the payroll.
          </h2>
        </div>
        <p className="max-w-sm text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          A monthly readout of headcount, tenure, and who just joined us — derived directly from the master list.
        </p>
      </div>

      {/* Asymmetric three-column grid: headcount chart spans wide, tenure narrow */}
      <div className="relative mt-6 grid gap-5 lg:grid-cols-5 lg:gap-6">
        {/* Headcount growth — wide left column */}
        <div className="lg:col-span-3">
          <HeadcountStoryCard
            loading={loading}
            totalActive={totalActive}
            netDelta={headcountSeries.netDelta}
            newcomersThisMonth={newcomersThisMonth}
            points={headcountSeries.points}
          />
        </div>

        {/* Tenure cohorts — narrow right column */}
        <div className="lg:col-span-2">
          <TenureCohortCard loading={loading} cohorts={tenureCohorts} totalActive={totalActive} />
        </div>
      </div>

      {/* Recent arrivals + Departments at a glance */}
      <div className="relative mt-6 grid gap-5 lg:grid-cols-5 lg:gap-6">
        <div className="lg:col-span-3">
          <RecentHiresCard loading={loading} hires={recentHires} />
        </div>
        <div className="lg:col-span-2">
          <DepartmentBarsCard loading={loading} deptStats={deptStats} totalActive={totalActive} />
        </div>
      </div>
    </section>
  );
}

// ─── Headcount story (big serif number + sparkline area chart) ──────────────

function HeadcountStoryCard({
  loading,
  totalActive,
  netDelta,
  newcomersThisMonth,
  points,
}: {
  loading: boolean;
  totalActive: number;
  netDelta: number;
  newcomersThisMonth: number;
  points: { label: string; value: number; year: number; month: number }[];
}) {
  // Chart viewBox — proper aspect ratio so dots stay circular and lines read
  // correctly on any container width. Y-axis tick column is real space, not
  // negative margins. The chart fills the card's remaining height via flex.
  const W = 800;
  const H = 280;
  const AXIS_W = 38;      // left gutter for Y-axis tick labels
  const PAD_TOP = 18;
  const PAD_BOTTOM = 28;  // room for month labels
  const PAD_RIGHT = 14;
  const innerX0 = AXIS_W;
  const innerW = W - AXIS_W - PAD_RIGHT;
  const innerH = H - PAD_TOP - PAD_BOTTOM;

  const values = points.map((p) => p.value);
  const max = Math.max(1, ...values);
  const min = Math.min(...values, max - 1);
  // Pad the range a little so the line never hugs the top/bottom edges.
  const span = Math.max(1, max - min);
  const pad = Math.max(1, Math.round(span * 0.18));
  const yMin = Math.max(0, min - pad);
  const yMax = max + pad;
  const yRange = Math.max(1, yMax - yMin);

  const stepX = points.length > 1 ? innerW / (points.length - 1) : innerW;
  const projectY = (v: number) => PAD_TOP + innerH - ((v - yMin) / yRange) * innerH;

  const coords = points.map((p, i) => ({
    x: innerX0 + i * stepX,
    y: projectY(p.value),
    value: p.value,
    label: p.label,
    year: p.year,
    month: p.month,
  }));
  const linePath = coords.map((c, i) => (i === 0 ? `M${c.x},${c.y}` : `L${c.x},${c.y}`)).join(' ');
  const areaPath = coords.length > 0
    ? `${linePath} L${coords[coords.length - 1].x},${PAD_TOP + innerH} L${coords[0].x},${PAD_TOP + innerH} Z`
    : '';

  // Y-axis ticks — 4 evenly-spaced labels covering yMin..yMax.
  const yTicks = useMemo(() => {
    const n = 4;
    const arr: { value: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const v = Math.round(yMin + (yRange * (n - 1 - i)) / (n - 1));
      arr.push({ value: v, y: projectY(v) });
    }
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yMin, yMax, yRange]);

  const positive = netDelta >= 0;

  // Interactivity — hovered point + month-over-month delta for the tooltip.
  const chartRef = useRef<HTMLDivElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const onMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (coords.length === 0 || !chartRef.current) return;
    const rect = chartRef.current.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const vbX = (relX / rect.width) * W;
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const d = Math.abs(coords[i].x - vbX);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    setHoverIdx(bestI);
  }, [coords]);
  const onMouseLeave = useCallback(() => setHoverIdx(null), []);

  const hovered = hoverIdx != null ? coords[hoverIdx] : null;
  const hoverPrev = hoverIdx != null && hoverIdx > 0 ? coords[hoverIdx - 1] : null;
  const hoverDelta = hovered && hoverPrev ? hovered.value - hoverPrev.value : null;
  // Tooltip position in % of chart container so it scales with width AND height.
  const tooltipLeftPct = hovered ? (hovered.x / W) * 100 : 0;
  const tooltipTopPct = hovered ? (hovered.y / H) * 100 : 0;
  // Tooltip nudges itself away from the edges so it never clips.
  const tooltipAlign = hovered ? (hovered.x < W * 0.18 ? 'start' : hovered.x > W * 0.82 ? 'end' : 'center') : 'center';
  const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-xl border border-zinc-200/70 bg-white p-5 dark:border-zinc-800/80 dark:bg-zinc-950">
      {/* Top label strip */}
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-400 dark:text-zinc-500">
            Headcount · trailing 12 mo
          </p>
          <div className="mt-2 flex items-baseline gap-3">
            <p className="text-5xl font-bold tabular-nums leading-none text-zinc-900 dark:text-zinc-50 sm:text-6xl">
              {loading ? <span className="inline-block h-12 w-24 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" /> : totalActive}
            </p>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums',
                positive
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                  : 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300',
              )}
            >
              <TrendingUp className={cn('h-3 w-3', !positive && 'rotate-180')} />
              {positive ? '+' : ''}{netDelta}
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-snug text-zinc-500 dark:text-zinc-400">
            <span className="font-semibold text-zinc-700 dark:text-zinc-300">+{newcomersThisMonth}</span> joined this month
            <span className="mx-1.5 text-zinc-300 dark:text-zinc-700">·</span>
            Net delta over 12 months: <span className="tabular-nums font-medium">{positive ? '+' : ''}{netDelta}</span>
          </p>
        </div>
      </div>

      {/* Chart fills the remaining card height */}
      <div
        ref={chartRef}
        className="relative mt-5 min-h-[220px] flex-1 cursor-crosshair"
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-full w-full"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Headcount growth over the trailing 12 months"
        >
          <defs>
            <linearGradient id="hcGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(16, 185, 129)" stopOpacity="0.34" />
              <stop offset="100%" stopColor="rgb(16, 185, 129)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Y-axis horizontal grid + tick labels */}
          {yTicks.map((t, i) => (
            <g key={i}>
              <line
                x1={innerX0}
                x2={W - PAD_RIGHT}
                y1={t.y}
                y2={t.y}
                stroke="currentColor"
                strokeOpacity={i === yTicks.length - 1 ? 0.18 : 0.07}
                strokeDasharray={i === yTicks.length - 1 ? '0' : '2 4'}
                className="text-zinc-900 dark:text-zinc-100"
              />
              <text
                x={innerX0 - 8}
                y={t.y + 3}
                textAnchor="end"
                fontSize={10}
                fill="currentColor"
                className="font-mono tabular-nums text-zinc-400 dark:text-zinc-500"
              >
                {t.value}
              </text>
            </g>
          ))}

          {areaPath && <path d={areaPath} fill="url(#hcGradient)" />}
          {linePath && (
            <path d={linePath} fill="none" stroke="rgb(5, 150, 105)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          )}

          {/* Quiet dots at every data point — readable density without noise */}
          {coords.map((c, i) => {
            const isHovered = hoverIdx === i;
            const isEnd = i === coords.length - 1;
            const r = isHovered ? 5 : isEnd ? 3.5 : 2.4;
            return (
              <circle
                key={i}
                cx={c.x}
                cy={c.y}
                r={r}
                fill={isHovered ? 'rgb(5, 150, 105)' : isEnd ? 'rgb(5, 150, 105)' : 'white'}
                stroke="rgb(5, 150, 105)"
                strokeWidth={isHovered ? 1.5 : 1.25}
                className="transition-all duration-150"
              />
            );
          })}

          {/* Hover guide line + halo */}
          {hovered && (
            <g>
              <line
                x1={hovered.x}
                x2={hovered.x}
                y1={PAD_TOP}
                y2={PAD_TOP + innerH}
                stroke="rgb(5, 150, 105)"
                strokeOpacity={0.4}
                strokeDasharray="3 4"
                strokeWidth={1}
              />
              <circle
                cx={hovered.x}
                cy={hovered.y}
                r={11}
                fill="rgb(5, 150, 105)"
                fillOpacity={0.16}
              />
            </g>
          )}

          {/* Month labels — every month, all visible since we have the space */}
          {coords.map((c, i) => {
            const isHovered = hoverIdx === i;
            return (
              <text
                key={i}
                x={c.x}
                y={H - 8}
                textAnchor="middle"
                fontSize={11}
                fill="currentColor"
                className={cn(
                  'font-mono transition-colors',
                  isHovered
                    ? 'fill-emerald-700 font-semibold dark:fill-emerald-400'
                    : 'text-zinc-400 dark:text-zinc-500',
                )}
              >
                {c.label}
              </text>
            );
          })}
        </svg>

        {/* Tooltip — absolute HTML, edge-aware so it never clips */}
        {hovered && (
          <div
            className="pointer-events-none absolute z-10 select-none"
            style={{
              left: `${tooltipLeftPct}%`,
              top: `${tooltipTopPct}%`,
              transform:
                tooltipAlign === 'start'
                  ? 'translate(0, 0)'
                  : tooltipAlign === 'end'
                    ? 'translate(-100%, 0)'
                    : 'translate(-50%, 0)',
            }}
          >
            <motion.div
              initial={{ opacity: 0, y: 4, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.12, ease: 'easeOut' }}
              className="-translate-y-[calc(100%+16px)] whitespace-nowrap rounded-lg border border-zinc-200/80 bg-white/95 px-3 py-2 shadow-lg backdrop-blur-sm dark:border-zinc-700/60 dark:bg-zinc-900/95"
            >
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-400">
                {MONTH_FULL[hovered.month]} {hovered.year}
              </p>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-xl font-bold tabular-nums text-zinc-900 dark:text-zinc-50">
                  {hovered.value}
                </span>
                <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                  people
                </span>
                {hoverDelta != null && hoverDelta !== 0 && (
                  <span
                    className={cn(
                      'ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
                      hoverDelta > 0
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                        : 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300',
                    )}
                  >
                    {hoverDelta > 0 ? '+' : ''}{hoverDelta}
                  </span>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tenure cohorts (stacked horizontal bar + cohort cards) ─────────────────

function TenureCohortCard({
  loading,
  cohorts,
  totalActive,
}: {
  loading: boolean;
  cohorts: TenureCohort[];
  totalActive: number;
}) {
  const totalKnown = cohorts.reduce((s, c) => s + c.count, 0);
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-zinc-200/70 bg-white p-5 dark:border-zinc-800/80 dark:bg-zinc-950">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-400 dark:text-zinc-500">
            Tenure cohorts
          </p>
          <p className="mt-1 text-xl font-semibold leading-tight text-zinc-900 dark:text-zinc-50">
            {loading ? '—' : `${totalKnown} of ${totalActive}`}
            <span className="ml-1 text-xs font-normal text-zinc-400">with known start dates</span>
          </p>
        </div>
      </div>

      {/* Stacked bar */}
      <div className="mt-5">
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-zinc-100 ring-1 ring-inset ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800/80">
          {cohorts.map((c) => (
            <div
              key={c.key}
              className={cn('h-full transition-all', TENURE_PALETTE[c.key].bg)}
              style={{ width: `${c.pct}%` }}
              title={`${c.label}: ${c.count}`}
            />
          ))}
        </div>
      </div>

      {/* Cohort cards */}
      <div className="mt-4 grid grid-cols-2 gap-2.5">
        {cohorts.map((c) => (
          <div
            key={c.key}
            className="group relative overflow-hidden rounded-lg border border-zinc-100 bg-zinc-50/60 px-3 py-2.5 transition-colors hover:bg-zinc-50 dark:border-zinc-800/60 dark:bg-zinc-900/40 dark:hover:bg-zinc-900/70"
          >
            <div className="flex items-center gap-1.5">
              <span className={cn('h-1.5 w-1.5 rounded-full', TENURE_PALETTE[c.key].dot)} aria-hidden />
              <p className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                {c.label}
              </p>
            </div>
            <p className="mt-1.5 text-2xl font-bold tabular-nums leading-none text-zinc-900 dark:text-zinc-50">
              {c.count}
            </p>
            <p className="mt-1 text-[10px] text-zinc-400 dark:text-zinc-500">
              {c.range} · {c.pct.toFixed(0)}%
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Recent hires editorial list ─────────────────────────────────────────────

function RecentHiresCard({
  loading,
  hires,
}: {
  loading: boolean;
  hires: { row: EmployeeRow; days: number; t: number }[];
}) {
  const shown = hires.slice(0, 8);
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-zinc-200/70 bg-white p-5 dark:border-zinc-800/80 dark:bg-zinc-950">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-400 dark:text-zinc-500">
            Recent arrivals · last 90 days
          </p>
          <p className="mt-1 text-xl font-semibold leading-tight text-zinc-900 dark:text-zinc-50">
            {loading ? '…' : hires.length === 0 ? 'No new hires yet.' : `${hires.length} ${hires.length === 1 ? 'person' : 'people'} joined.`}
          </p>
        </div>
        <span className="rounded-full border border-emerald-200/70 bg-emerald-50/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
          NEW
        </span>
      </div>

      {/* List */}
      {loading ? (
        <div className="mt-5 space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="h-9 w-9 animate-pulse rounded-full bg-zinc-100 dark:bg-zinc-900" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-1/2 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
                <div className="h-2.5 w-1/3 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
              </div>
            </div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <p className="mt-6 text-xs text-zinc-400 dark:text-zinc-500">No new hires in the last 90 days.</p>
      ) : (
        <ul className="mt-5 divide-y divide-zinc-100 dark:divide-zinc-900">
          {shown.map(({ row, days }, i) => (
            <li
              key={`${row.work_email ?? row.personal_email ?? i}`}
              className="group flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
            >
              {/* Avatar (initials only — keeps the editorial vibe consistent) */}
              <div className="relative shrink-0">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-emerald-100 to-teal-200 text-sm font-bold text-emerald-900 ring-2 ring-white dark:from-emerald-900/50 dark:to-teal-900/50 dark:text-emerald-200 dark:ring-zinc-950">
                  {initialsFromName(row.name)}
                </div>
                {days <= 7 && (
                  <span
                    className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-zinc-950"
                    aria-label="Joined this week"
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {row.name ?? row.work_email ?? '—'}
                </p>
                <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                  <span className="font-medium text-zinc-600 dark:text-zinc-300">{row.department ?? 'Unassigned'}</span>
                  <span className="mx-1.5 text-zinc-300 dark:text-zinc-700">·</span>
                  {row.work_email ?? row.personal_email ?? '—'}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-base font-bold tabular-nums leading-none text-zinc-800 dark:text-zinc-200">
                  {days === 0 ? 'today' : `${days}d`}
                </p>
                <p className="mt-0.5 text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                  {days === 0 ? 'first day' : 'tenure'}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Department bars (replaces the Accounting donut style with editorial bars) ───

function DepartmentBarsCard({
  loading,
  deptStats,
  totalActive,
}: {
  loading: boolean;
  deptStats: DeptStat[];
  totalActive: number;
}) {
  const top = deptStats.slice(0, 8);
  const restCount = deptStats.slice(8).reduce((s, d) => s + d.count, 0);
  const maxCount = Math.max(1, ...top.map((d) => d.count));

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-zinc-200/70 bg-white p-5 dark:border-zinc-800/80 dark:bg-zinc-950">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-400 dark:text-zinc-500">
            Departments at a glance
          </p>
          <p className="mt-1 text-xl font-semibold leading-tight text-zinc-900 dark:text-zinc-50">
            {loading ? '…' : `Top ${Math.min(8, deptStats.length)} of ${deptStats.length}`}
          </p>
        </div>
      </div>

      <ul className="mt-5 space-y-2.5">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => (
              <li key={i} className="flex items-center gap-2">
                <div className="h-3 w-20 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
                <div className="h-2 flex-1 animate-pulse rounded-full bg-zinc-100 dark:bg-zinc-900" />
              </li>
            ))
          : top.map((d, i) => {
              const widthPct = (d.count / maxCount) * 100;
              const sharePct = totalActive > 0 ? (d.count / totalActive) * 100 : 0;
              // Cascade emerald shades so the order itself reads visually
              const shades = [
                'bg-emerald-700 dark:bg-emerald-500',
                'bg-emerald-600 dark:bg-emerald-500/90',
                'bg-emerald-500 dark:bg-emerald-500/80',
                'bg-teal-600 dark:bg-teal-500/80',
                'bg-teal-500 dark:bg-teal-500/70',
                'bg-teal-400 dark:bg-teal-500/60',
                'bg-zinc-500 dark:bg-zinc-400',
                'bg-zinc-400 dark:bg-zinc-500',
              ];
              return (
                <li key={d.department} className="group">
                  <div className="mb-1 flex items-baseline justify-between gap-3">
                    <span className="truncate text-[12px] font-medium text-zinc-700 dark:text-zinc-300">
                      <span className="mr-2 inline-block w-4 text-right font-mono text-[10px] text-zinc-400 tabular-nums dark:text-zinc-600">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      {d.department}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                      {d.count}
                      <span className="ml-1.5 text-zinc-400 dark:text-zinc-600">{sharePct.toFixed(0)}%</span>
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
                    <div
                      className={cn('h-full rounded-full transition-all duration-500 ease-out', shades[i] ?? 'bg-zinc-400')}
                      style={{ width: `${widthPct}%` }}
                    />
                  </div>
                </li>
              );
            })}
      </ul>

      {!loading && restCount > 0 && (
        <p className="mt-4 border-t border-zinc-100 pt-3 text-[11px] text-zinc-400 dark:border-zinc-900 dark:text-zinc-500">
          + {restCount} more across {deptStats.length - 8} other department{deptStats.length - 8 === 1 ? '' : 's'}.
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function OverviewBody() {
  const [roster, setRoster] = useState<EmployeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [dept, setDept] = useState('');
  const [page, setPage] = useState(0);
  /** Trailing-12-month attrition derived from offboard history + active roster. */
  const [attrition, setAttrition] = useState<{
    separations: number;
    avgHeadcount: number;
    ratePct: number;
  } | null>(null);
  /** MESA member count from employee_hourly_rates.mesa_member. */
  const [mesaCount, setMesaCount] = useState<number | null>(null);
  /** Total FPU enrollment submissions, plus a "this month" slice for sub-line. */
  const [fpuStats, setFpuStats] = useState<{ total: number; thisMonth: number } | null>(null);

  const fetchRoster = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/employees', { cache: 'no-store' });
      const json = (await res.json()) as { employees?: EmployeeRow[]; error?: string };
      if (json.error) throw new Error(json.error);
      setRoster(json.employees ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load roster');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchRoster(); }, [fetchRoster]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/hr/offboard-history', { cache: 'no-store' });
        const json = (await res.json()) as { rows?: { off_boarded_at: string | null }[] };
        const cutoff = Date.now() - 365 * 24 * 3600 * 1000;
        const separations = (json.rows ?? []).reduce((n, r) => {
          const t = r.off_boarded_at ? new Date(r.off_boarded_at).getTime() : NaN;
          return Number.isFinite(t) && t >= cutoff ? n + 1 : n;
        }, 0);
        const active = roster.length;
        const avgHeadcount = active + separations / 2;
        const ratePct = avgHeadcount > 0 ? (separations / avgHeadcount) * 100 : 0;
        if (!cancelled) setAttrition({ separations, avgHeadcount, ratePct });
      } catch {
        if (!cancelled) setAttrition(null);
      }
    })();
    return () => { cancelled = true; };
  }, [roster.length]);

  // MESA members — count rows where mesa_member is true on the rates table.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/employee-hourly-rates', { cache: 'no-store' });
        const json = (await res.json()) as { rows?: { mesa_member?: boolean | null }[] };
        const n = (json.rows ?? []).reduce((acc, r) => (r.mesa_member ? acc + 1 : acc), 0);
        if (!cancelled) setMesaCount(n);
      } catch {
        if (!cancelled) setMesaCount(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // FPU enrollments — total submissions plus a current-month count for the sub-line.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/hr/fpu-enrollments', { cache: 'no-store' });
        const json = (await res.json()) as { rows?: { created_at?: string }[] };
        const now = new Date();
        const thisMonth = (json.rows ?? []).reduce((acc, r) => {
          if (!r.created_at) return acc;
          const d = new Date(r.created_at);
          if (Number.isNaN(d.getTime())) return acc;
          return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
            ? acc + 1
            : acc;
        }, 0);
        if (!cancelled) setFpuStats({ total: (json.rows ?? []).length, thisMonth });
      } catch {
        if (!cancelled) setFpuStats(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const deptStats: DeptStat[] = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of roster) {
      const d = r.department ?? 'Unknown';
      map.set(d, (map.get(d) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([department, count]) => ({ department, count }))
      .sort((a, b) => b.count - a.count);
  }, [roster]);

  // Recent hires — last 90 days sorted by start_date desc.
  const recentHires = useMemo(() => {
    const now = Date.now();
    const cutoff = now - 90 * 86400000;
    return roster
      .map((r) => {
        if (!r.start_date) return null;
        const t = new Date(r.start_date).getTime();
        if (!Number.isFinite(t)) return null;
        if (t < cutoff || t > now + 7 * 86400000) return null;
        const days = Math.floor((now - t) / 86400000);
        return { row: r, days, t };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.t - a.t);
  }, [roster]);

  // Headcount growth — cumulative hire count for the trailing 12 months.
  // Each bucket is "people whose start_date falls on or before the end of that month",
  // computed only from current active roster (so departures already net out).
  const headcountSeries = useMemo(() => {
    const now = new Date();
    const months: { label: string; year: number; month: number; endMs: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const endMs = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59).getTime();
      months.push({
        label: d.toLocaleDateString('en-US', { month: 'short' }),
        year: d.getFullYear(),
        month: d.getMonth(),
        endMs,
      });
    }
    const startTimes: number[] = [];
    for (const r of roster) {
      if (!r.start_date) continue;
      const t = new Date(r.start_date).getTime();
      if (Number.isFinite(t)) startTimes.push(t);
    }
    const points = months.map((m) => {
      let cum = 0;
      for (const t of startTimes) if (t <= m.endMs) cum++;
      return { label: m.label, value: cum, year: m.year, month: m.month };
    });
    // Net change over the trailing 12 months
    const netDelta = points.length > 0 ? points[points.length - 1].value - points[0].value : 0;
    return { points, netDelta };
  }, [roster]);

  // Tenure cohorts — bucket the active roster by how long they've been here.
  const tenureCohorts: TenureCohort[] = useMemo(() => {
    const counts = { new: 0, settling: 0, established: 0, veteran: 0 } as Record<TenureCohort['key'], number>;
    const now = Date.now();
    for (const r of roster) {
      if (!r.start_date) continue;
      const t = new Date(r.start_date).getTime();
      if (!Number.isFinite(t)) continue;
      const days = (now - t) / 86400000;
      if (days <= 30) counts.new++;
      else if (days <= 365) counts.settling++;
      else if (days <= 365 * 3) counts.established++;
      else counts.veteran++;
    }
    const total = counts.new + counts.settling + counts.established + counts.veteran;
    return TENURE_COHORT_DEFS.map((def) => ({
      key: def.key,
      label: def.label,
      range: def.range,
      count: counts[def.key],
      pct: total > 0 ? (counts[def.key] / total) * 100 : 0,
    }));
  }, [roster]);

  const filtered = useMemo(() => {
    setPage(0);
    const q = search.trim().toLowerCase();
    return roster.filter((r) => {
      if (dept && (r.department ?? '').trim() !== dept) return false;
      if (!q) return true;
      return [r.name, r.work_email, r.department, r.employee_id]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q));
    });
  }, [roster, search, dept]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return (
    <>
      {/* KPI row */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {[
          { label: 'Active employees', value: roster.length, sub: 'on the master list',      icon: Users,     grad: 'from-emerald-500 to-teal-700' },
          { label: 'Departments',      value: deptStats.length, sub: 'with active headcount', icon: Building2, grad: 'from-teal-500 to-emerald-700' },
          { label: 'Largest dept',     value: deptStats[0]?.department ?? '—', sub: `${deptStats[0]?.count ?? 0} people`, icon: TrendingUp, grad: 'from-sky-500 to-sky-700' },
          {
            label: 'Attrition · 12mo',
            value: attrition == null ? '—' : `${Math.round(attrition.ratePct)}%`,
            sub: attrition == null
              ? 'awaiting offboard data'
              : `${attrition.separations} separation${attrition.separations === 1 ? '' : 's'} · avg ${Math.round(attrition.avgHeadcount)}`,
            icon: UserMinus,
            grad:
              attrition == null
                ? 'from-zinc-400 to-zinc-600'
                : attrition.ratePct >= 15
                  ? 'from-rose-500 to-red-700'
                  : attrition.ratePct >= 5
                    ? 'from-amber-500 to-orange-700'
                    : 'from-emerald-500 to-emerald-700',
          },
          {
            label: 'MESA members',
            value: mesaCount ?? '—',
            sub:
              mesaCount == null
                ? 'awaiting rates data'
                : roster.length > 0
                  ? `${Math.round((mesaCount / Math.max(1, roster.length)) * 100)}% of active`
                  : 'enrolled in the savings account',
            icon: HeartHandshake,
            grad: 'from-teal-500 to-emerald-600',
          },
          {
            label: 'FPU enrollments',
            value: fpuStats?.total ?? '—',
            sub:
              fpuStats == null
                ? 'awaiting submissions'
                : `${fpuStats.thisMonth} this month`,
            icon: GraduationCap,
            grad: 'from-orange-500 to-amber-600',
          },
        ].map(({ label, value, sub, icon: Icon, grad }) => (
          <div key={label} className="flex items-center gap-3 rounded-xl border border-zinc-100 bg-white px-4 py-3.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow', grad)}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">{label}</p>
              <p className={cn('mt-0.5 truncate font-bold tabular-nums text-zinc-900 dark:text-zinc-100', typeof value === 'number' ? 'text-2xl' : 'text-base leading-tight')}>
                {loading ? <span className="inline-block h-5 w-12 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" /> : String(value)}
              </p>
              <p className="text-[10px] text-zinc-400 dark:text-zinc-500">{sub}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Editorial composition — headcount story + recent arrivals */}
      <OverviewEditorialSection
        loading={loading}
        roster={roster}
        deptStats={deptStats}
        headcountSeries={headcountSeries}
        tenureCohorts={tenureCohorts}
        recentHires={recentHires}
      />

      {/* Roster */}
      <Card className="border-zinc-100 shadow-sm dark:border-zinc-800">
          <CardHeader className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <div>
                <CardTitle className="text-sm font-semibold">Active roster</CardTitle>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {loading ? 'Loading…' : `${filtered.length} of ${roster.length}`}
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <DeptFilter rows={roster} getDept={(r) => r.department} value={dept} onChange={setDept} />
                <div className="relative w-full sm:w-44 sm:shrink-0">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search…"
                    className="h-9 border-zinc-200 pl-8 text-xs dark:border-zinc-700"
                  />
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center py-12 text-zinc-400">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <p className="py-10 text-center text-xs text-zinc-400">
                {roster.length === 0 ? 'No active employees. Run a master list import.' : 'No rows match.'}
              </p>
            ) : (
              <>
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-zinc-100 bg-zinc-50/90 text-[11px] font-semibold text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/90 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-2.5">Name</th>
                      <th className="px-4 py-2.5">Dept</th>
                      <th className="px-4 py-2.5">Work email</th>
                      <th className="px-4 py-2.5">Personal email</th>
                      <th className="px-4 py-2.5">Location</th>
                      <th className="px-4 py-2.5">Start date</th>
                      <th className="px-4 py-2.5">Tenure</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800/60">
                    {pageRows.map((r, i) => (
                      <tr key={`${r.work_email ?? r.personal_email ?? i}`} className="hover:bg-zinc-50/60 dark:hover:bg-zinc-800/30">
                        <td data-label="Name" className="px-4 py-2 font-medium text-zinc-800 dark:text-zinc-200">{r.name ?? '—'}</td>
                        <td data-label="Dept" className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{r.department ?? '—'}</td>
                        <td data-label="Work email" className="px-4 py-2 font-mono text-zinc-500 dark:text-zinc-400">{r.work_email ?? '—'}</td>
                        <td data-label="Personal email" className="px-4 py-2 font-mono text-zinc-500 dark:text-zinc-400">{r.personal_email ?? '—'}</td>
                        <td data-label="Location" className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{r.city ?? '—'}</td>
                        <td data-label="Start date" className="px-4 py-2 text-zinc-400">{fmtDate(r.start_date)}</td>
                        <td data-label="Tenure" className="px-4 py-2 tabular-nums text-zinc-400">{tenure(r.start_date)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
                  <p className="text-[11px] text-zinc-400">
                    {filtered.length === 0 ? '0' : `${safePage * PAGE_SIZE + 1}–${Math.min((safePage + 1) * PAGE_SIZE, filtered.length)}`} of {filtered.length}
                  </p>
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage(0)}>
                      <ChevronLeft className="h-3 w-3" /><ChevronLeft className="h-3 w-3 -ml-2" />
                    </Button>
                    <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                      <ChevronLeft className="h-3 w-3" />
                    </Button>
                    <span className="min-w-[4rem] text-center text-[11px] text-zinc-500">
                      {safePage + 1} / {totalPages}
                    </span>
                    <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
                      <ChevronRight className="h-3 w-3" />
                    </Button>
                    <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>
                      <ChevronRight className="h-3 w-3" /><ChevronRight className="h-3 w-3 -ml-2" />
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
      </Card>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────────

function HrSwallTab({ viewerEmail }: { viewerEmail: string | null }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[#ececec] bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
          Simple Wall
        </h1>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
          Company-wide social feed. Post updates, react, and comment — live via Realtime.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] dark:bg-[#0d1117]">
        <SWall viewerEmail={viewerEmail} canPost sourceLabel="HR" />
      </div>
    </div>
  );
}
