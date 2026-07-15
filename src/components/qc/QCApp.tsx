'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import {
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Compass,
  Gauge,
  ListTodo,
  Lock,
  Menu,
  PenLine,
  PhoneCall,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  UsersRound,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { normEmail } from '@/lib/email/norm-email';
import { resolveFirstName } from '@/lib/name/first-name';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import { usePublishPresenceTab } from '@/components/presence/PresenceProvider';
import { humanizeTabId } from '@/lib/presence/page-label';
import { useTabDocumentTitle } from '@/hooks/useTabDocumentTitle';
import { usePayWeeks, weekEndFromStart, type PayWeek } from '@/lib/hubstaff/use-pay-weeks';
import { QC_DEPT_KEYS } from '@/lib/qc/constants';
import type { EmployeeRow } from '@/lib/supabase/employees';
import DeptBonusCalculator from '@/components/manager/DeptBonusCalculator';
import NotificationsPanel from '@/components/notifications/NotificationsPanel';
import ReadOnlyTab from '@/components/rbac/ReadOnlyTab';
import PayrollProcessingLock from '@/components/payroll/PayrollProcessingLock';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import { useFeaturePermissions } from '@/hooks/useFeaturePermissions';
import QCSidebar, { type QcTab } from './QCSidebar';

const TAB_IDS: QcTab[] = ['overview', 'qc-calculator', 'notifications'];

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/** Monday-anchored ISO week start — mirrors the calculator so the first fetch
 *  lines up with the pay-week the calculator resolves to. */
function isoWeekStart(d: Date): string {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = day.getDay();
  const back = dow === 0 ? 6 : dow - 1;
  day.setDate(day.getDate() - back);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

/** "Jun 9 – Jun 15" from a Monday-anchored ISO start. */
function weekRange(startIso: string): string {
  const [y, m, d] = startIso.split('-').map(Number);
  if (!y || !m || !d) return '';
  const s = new Date(y, m - 1, d);
  const e = new Date(y, m - 1, d + 6);
  const f = (dt: Date) => dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${f(s)} – ${f(e)}`;
}

interface QcMine {
  memberEmails: string[];
  byDept: Record<string, Array<{ email: string; name: string }>>;
  members: EmployeeRow[];
}
interface QcLock {
  qc_officer_email: string;
  status: 'draft' | 'locked';
  member_count: number;
  locked_at: string | null;
}
interface QcDeptTotal {
  department: string;
  total: number;
  perOfficer: number;
}
interface QcData {
  mine: QcMine;
  locks: QcLock[];
  deptTotals: QcDeptTotal[];
  officerCount: number;
}

const EMPTY_MINE: QcMine = { memberEmails: [], byDept: {}, members: [] };

/** The departments QC scores, in display order (matches the dept bars). Sourced
 *  from QC_DEPT_KEYS so adding/removing a QC dept updates the whole Overview. */
const QC_DEPT_ORDER = QC_DEPT_KEYS;

interface StagedProgress {
  /** Distinct members this officer has entered scores for, per department. */
  byDept: Record<string, number>;
  /** Distinct members this officer has entered scores for, period-wide. */
  total: number;
}
const EMPTY_PROGRESS: StagedProgress = { byDept: {}, total: 0 };

export default function QCApp() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams?.get('email') ?? null;

  const [viewerEmail, setViewerEmail] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<QcTab>('overview');
  usePublishPresenceTab(humanizeTabId(activeTab));
  useTabDocumentTitle(humanizeTabId(activeTab));
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

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

  const { allowedTabs, canEditTab, ready, roles } = useFeaturePermissions(viewerEmail);
  // "Start processing" lock from the Payroll Wizard — while on, the QC
  // dashboard's working tabs (Overview + Calculator) are fully taken over so
  // scores can't move while people are being paid. Notifications stay open.
  const { state: payrollProcessing } = useDispatchLock();

  // Soft client gate: bounce anyone without the qc (or admin) role. /qc + every
  // /api/qc handler enforce this server-side too.
  useEffect(() => {
    if (!ready) return;
    if (!(roles.includes('qc') || roles.includes('admin'))) router.replace('/employee');
  }, [ready, roles, router]);

  const visibleTabs = useMemo(() => {
    const allowed = new Set(allowedTabs('qc'));
    return TAB_IDS.filter((t) => t === 'overview' || allowed.has(t));
  }, [allowedTabs]);

  useEffect(() => {
    if (ready && !visibleTabs.includes(activeTab)) setActiveTab('overview');
  }, [ready, visibleTabs, activeTab]);

  const handleNavigate = useCallback((tab: QcTab) => {
    setActiveTab(tab);
    setMobileNavOpen(false);
  }, []);

  // ── Pay-week ownership (lifted into the shell) ──────────────────────────────
  // The QC Overview's period selector AND the calculator's own WeekPicker both
  // drive this single value. The calculator follows it via `controlledWeek` and
  // reports its own picks back via `onWeekChange`.
  const { weekOptions, currentWeekStart } = usePayWeeks();
  const [weekStart, setWeekStart] = useState<string>(() => isoWeekStart(new Date()));

  // A deliberate period pick — from the Overview selector OR the calculator's own
  // WeekPicker (which reports up via onWeekChange; in controlled mode that fires
  // only on a genuine pick, never as a mount echo). Marks the auto-default as
  // spent so a late-resolving live week can't clobber the choice.
  const defaultedWeek = useRef(false);
  const userPickedWeek = useRef(false);
  const pickWeek = useCallback((w: string) => {
    userPickedWeek.current = true;
    defaultedWeek.current = true;
    setWeekStart(w);
  }, []);

  // Default to the live (currently-dispatched) week exactly once, and never after
  // the user has picked. (Don't sentinel on "today's Monday" — that's itself a
  // selectable week, so a pre-resolution pick of it would be silently reverted.)
  useEffect(() => {
    if (!currentWeekStart || defaultedWeek.current || userPickedWeek.current) return;
    defaultedWeek.current = true;
    setWeekStart(currentWeekStart);
  }, [currentWeekStart]);

  const [qc, setQc] = useState<QcData>({ mine: EMPTY_MINE, locks: [], deptTotals: [], officerCount: 0 });
  const [qcLoaded, setQcLoaded] = useState(false);

  // Per-fetch epoch tokens: stepping through periods quickly fires overlapping
  // requests; only the latest call of each function is allowed to commit, so a
  // slow older response can't overwrite the freshly-selected week's data.
  const assignEpoch = useRef(0);
  const progressEpoch = useRef(0);

  const fetchAssignments = useCallback(async (week: string) => {
    if (!week) return;
    const epoch = ++assignEpoch.current;
    try {
      const res = await fetch(`/api/qc/assignments?period_start=${week}`, { cache: 'no-store' });
      const json = (await res.json()) as {
        mine?: QcMine;
        locks?: QcLock[];
        deptTotals?: QcDeptTotal[];
        officerCount?: number;
      };
      if (epoch !== assignEpoch.current) return; // a newer week was requested
      setQc({
        mine: json.mine ?? EMPTY_MINE,
        locks: json.locks ?? [],
        deptTotals: json.deptTotals ?? [],
        officerCount: json.officerCount ?? 0,
      });
    } catch {
      /* keep last good state */
    } finally {
      if (epoch === assignEpoch.current) setQcLoaded(true);
    }
  }, []);

  useEffect(() => {
    setQcLoaded(false);
    void fetchAssignments(weekStart);
  }, [weekStart, fetchAssignments]);

  // ── Scoring progress (how many of my assigned members I've staged) ──────────
  const me = norm(viewerEmail);
  const [progress, setProgress] = useState<StagedProgress>(EMPTY_PROGRESS);

  const fetchProgress = useCallback(
    async (week: string, officer: string) => {
      const epoch = ++progressEpoch.current;
      if (!week || !officer) {
        if (epoch === progressEpoch.current) setProgress(EMPTY_PROGRESS);
        return;
      }
      try {
        const res = await fetch(
          `/api/qc/submissions?depts=${QC_DEPT_KEYS.join(',')}&period_start=${week}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as {
          rows?: Array<{ department?: string; employee_email?: string; scored_by?: string | null }>;
        };
        const byDeptSets: Record<string, Set<string>> = {};
        const all = new Set<string>();
        for (const r of json.rows ?? []) {
          if (norm(r.scored_by) !== officer) continue;
          const email = norm(r.employee_email);
          const dept = r.department ?? '';
          if (!email || !dept) continue;
          (byDeptSets[dept] ??= new Set()).add(email);
          all.add(email);
        }
        const byDept: Record<string, number> = {};
        for (const [d, set] of Object.entries(byDeptSets)) byDept[d] = set.size;
        if (epoch !== progressEpoch.current) return; // a newer week was requested
        setProgress({ byDept, total: all.size });
      } catch {
        /* keep last good state */
      }
    },
    [],
  );

  // Refresh assignments + progress whenever the week changes or the user returns
  // to the Overview (so scores entered in the calculator show up immediately).
  useEffect(() => {
    void fetchProgress(weekStart, me);
  }, [weekStart, me, fetchProgress]);

  useEffect(() => {
    if (activeTab !== 'overview') return;
    void fetchAssignments(weekStart);
    void fetchProgress(weekStart, me);
  }, [activeTab, weekStart, me, fetchAssignments, fetchProgress]);

  const myLock = qc.locks.find((l) => norm(l.qc_officer_email) === me);
  const qcLocked = myLock?.status === 'locked';

  const onToggleQcLock = useCallback(
    async (next: boolean): Promise<boolean> => {
      try {
        const res = await fetch('/api/qc/lock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ period_start: weekStart, status: next ? 'locked' : 'draft' }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? 'Failed');
        }
        await fetchAssignments(weekStart);
        toast.success(next ? 'Locked & sent to manager' : 'Reopened for editing');
        return true;
      } catch (e) {
        toast.error('Could not update lock', { description: e instanceof Error ? e.message : String(e) });
        return false;
      }
    },
    [weekStart, fetchAssignments],
  );

  const canEditCalc = canEditTab('qc', 'qc-calculator');
  // This officer's OWN per-department counts (their share). Officers see only
  // their portion of each department's roster, never the department total.
  const mineByDept = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [dept, list] of Object.entries(qc.mine.byDept)) out[dept] = list.length;
    return out;
  }, [qc.mine.byDept]);

  // Headline counts are SLOT-based (sum of the three QC departments) so the
  // "Assigned"/"Scored" cards and overall bar always equal the sum of the
  // per-dept rows shown below — a member mid-transfer holds a slot in two depts
  // and is one scoring task in each, so they count once per dept by design.
  const assignedCount = useMemo(
    () => QC_DEPT_ORDER.reduce((a, k) => a + (mineByDept[k] ?? 0), 0),
    [mineByDept],
  );
  const scoredTotal = useMemo(
    () => QC_DEPT_ORDER.reduce((a, k) => a + Math.min(mineByDept[k] ?? 0, progress.byDept[k] ?? 0), 0),
    [mineByDept, progress.byDept],
  );

  return (
    <div className="flex h-dvh max-h-dvh w-full overflow-hidden bg-gradient-to-br from-white via-orange-50/40 to-white text-zinc-900 dark:from-black dark:via-orange-950/25 dark:to-black dark:text-zinc-100">
      {mobileNavOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden"
          aria-label="Close navigation menu"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <QCSidebar
        activeTab={activeTab}
        setActiveTab={handleNavigate}
        mobileOpen={mobileNavOpen}
        viewerEmail={viewerEmail}
        allowedTabs={visibleTabs}
      />

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 border-b border-orange-100 bg-white/95 px-3 py-2.5 backdrop-blur-md dark:border-orange-950/40 dark:bg-zinc-950/95 md:hidden">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0 border-orange-100 bg-orange-50/60 dark:border-orange-950/40 dark:bg-zinc-900"
            onClick={() => setMobileNavOpen(true)}
            aria-controls="qc-sidebar-nav"
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="min-w-0 truncate text-sm font-semibold">QC</span>
        </header>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeTab}
              role="presentation"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
            >
              {payrollProcessing.locked && activeTab !== 'notifications' ? (
                <PayrollProcessingLock
                  surface="The QC dashboard"
                  lockedAt={payrollProcessing.lockedAt}
                />
              ) : (
                <>
              {activeTab === 'overview' && (
                <QcOverview
                  viewerEmail={viewerEmail}
                  weekStart={weekStart}
                  weekOptions={weekOptions}
                  currentWeekStart={currentWeekStart}
                  onSelectWeek={pickWeek}
                  assignedCount={assignedCount}
                  qcLocked={qcLocked}
                  qcLoaded={qcLoaded}
                  mineByDept={mineByDept}
                  scoredByDept={progress.byDept}
                  scoredTotal={scoredTotal}
                  officerCount={qc.officerCount}
                  onOpen={() => handleNavigate('qc-calculator')}
                />
              )}

              {activeTab === 'qc-calculator' && (
                <ReadOnlyTab readOnly={ready && !canEditCalc}>
                  <DeptBonusCalculator
                    viewerEmail={viewerEmail}
                    teamMembers={qc.mine.members}
                    managedDepts={[]}
                    isElevated={false}
                    variant="qc"
                    assignedByDept={qc.mine.byDept}
                    qcLocked={qcLocked}
                    onToggleQcLock={onToggleQcLock}
                    onWeekChange={pickWeek}
                    controlledWeek={weekStart}
                  />
                  {qcLoaded && assignedCount === 0 && (
                    <div className="mx-auto max-w-md px-6 py-16 text-center">
                      <Users className="mx-auto h-10 w-10 text-zinc-300 dark:text-zinc-700" />
                      <p className="mt-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                        No members assigned to you for this week yet.
                      </p>
                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
                        Members are split evenly across QC officers. Check back once the
                        week&rsquo;s roster is in, or ask an admin if you expect an assignment.
                      </p>
                    </div>
                  )}
                </ReadOnlyTab>
              )}

              {activeTab === 'notifications' && (
                <div className="mx-auto w-full max-w-3xl px-4 py-6">
                  <NotificationsPanel viewerEmail={viewerEmail} accent="orange" />
                </div>
              )}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      <Toaster richColors position="top-center" />
    </div>
  );
}

// ── Overview ──────────────────────────────────────────────────────────────────

/** Label + icon for every QC-scoreable department. The rendered set is derived
 *  from QC_DEPT_KEYS, so a dept dropping out of QC scope (e.g. Discovery moving
 *  to its manager) disappears here automatically — and re-adds just as easily. */
const QC_DEPT_META: Record<string, { label: string; icon: typeof Target }> = {
  lead_gen: { label: 'Leadgen', icon: Target },
  callback: { label: 'Callback', icon: PhoneCall },
  discovery: { label: 'Discovery', icon: Compass },
};
const DEPTS: { key: string; label: string; icon: typeof Target }[] = QC_DEPT_KEYS.map((key) => ({
  key,
  label: QC_DEPT_META[key]?.label ?? key,
  icon: QC_DEPT_META[key]?.icon ?? Target,
}));

/** Orange-keyed welcome lines — mirrors HR's rotating greeting register. */
const QC_MESSAGES: { heading: (name: string) => string; body: string }[] = [
  {
    heading: (n) => `Welcome back, ${n}.`,
    body: 'Your first-pass KPI scores set the table for every manager review. Pick a period, score your members, then lock & send.',
  },
  {
    heading: (n) => `Ready when you are, ${n}.`,
    body: 'Score the people assigned to you this period — Leadgen and Callback — and the managers take it from there.',
  },
  {
    heading: (n) => `Let’s get this period scored, ${n}.`,
    body: 'Switch periods anytime to catch up on a week you missed. Everything you enter flows straight into the manager’s calculator.',
  },
  {
    heading: (n) => `Good to see you, ${n}.`,
    body: 'Quality control keeps payroll honest. Work through your assignment, lock it, and we’ll route it to the right manager.',
  },
];

const SPARKLES = [
  { left: '8%', size: '11px', dur: '7.5s', delay: '0s' },
  { left: '24%', size: '8px', dur: '9s', delay: '1.4s' },
  { left: '47%', size: '13px', dur: '6.5s', delay: '0.7s' },
  { left: '63%', size: '9px', dur: '8.5s', delay: '2.1s' },
  { left: '82%', size: '11px', dur: '7s', delay: '1.1s' },
  { left: '93%', size: '8px', dur: '9.5s', delay: '0.4s' },
] as const;

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}

function QcOverview({
  viewerEmail,
  weekStart,
  weekOptions,
  currentWeekStart,
  onSelectWeek,
  assignedCount,
  qcLocked,
  qcLoaded,
  mineByDept,
  scoredByDept,
  scoredTotal,
  officerCount,
  onOpen,
}: {
  viewerEmail: string | null;
  weekStart: string;
  weekOptions: PayWeek[];
  currentWeekStart: string | null;
  onSelectWeek: (week: string) => void;
  assignedCount: number;
  qcLocked: boolean;
  qcLoaded: boolean;
  /** This officer's OWN assigned member count per department (their share). */
  mineByDept: Record<string, number>;
  /** Members this officer has staged scores for, per department. */
  scoredByDept: Record<string, number>;
  scoredTotal: number;
  officerCount: number;
  onOpen: () => void;
}) {
  // Real first name for the greeting (email local part alone is unreliable).
  const [realName, setRealName] = useState<string | null>(null);
  useEffect(() => {
    if (!viewerEmail) return;
    let alive = true;
    fetch(`/api/employees?email=${encodeURIComponent(viewerEmail)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive) return;
        const n = j?.employees?.[0]?.name;
        if (typeof n === 'string' && n.trim()) setRealName(n.trim());
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [viewerEmail]);
  const greeting = resolveFirstName({ name: realName, email: viewerEmail });

  const [msgIdx] = useState(() => Math.floor(Math.random() * QC_MESSAGES.length));
  const welcome = QC_MESSAGES[msgIdx]!;

  const isLive = currentWeekStart != null && weekStart === currentWeekStart;
  const remaining = Math.max(0, assignedCount - scoredTotal);
  const progressPct = pct(scoredTotal, assignedCount);

  const kpis = [
    {
      label: 'Assigned to you',
      value: assignedCount,
      sub: assignedCount === 1 ? 'member this period' : 'members this period',
      icon: Users,
      grad: 'from-orange-500 to-amber-600',
    },
    {
      label: 'Scored',
      value: scoredTotal,
      sub: assignedCount > 0 ? `${progressPct}% of your batch` : 'nothing assigned yet',
      icon: CheckCircle2,
      grad: 'from-emerald-500 to-teal-600',
    },
    {
      label: 'Remaining',
      value: remaining,
      sub: remaining === 0 && assignedCount > 0 ? 'all caught up' : 'left to score',
      icon: ListTodo,
      grad: remaining === 0 && assignedCount > 0 ? 'from-emerald-500 to-emerald-700' : 'from-amber-500 to-orange-700',
    },
    {
      label: 'QC officers',
      value: officerCount || '—',
      sub: officerCount > 1 ? 'sharing the roster' : 'scoring this period',
      icon: UsersRound,
      grad: 'from-orange-400 to-amber-500',
    },
    {
      label: 'Status',
      value: qcLocked ? 'Locked' : 'Scoring',
      sub: qcLocked ? 'sent to managers' : 'in progress',
      icon: qcLocked ? Lock : Clock,
      grad: qcLocked ? 'from-emerald-500 to-teal-700' : 'from-zinc-400 to-zinc-600',
    },
  ];

  return (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:gap-7 lg:px-8 lg:pt-8">
      {/* ── Hero: greeting (HR-style) ────────────────────────────────────────── */}
      <header className="relative overflow-hidden rounded-2xl border border-orange-200/80 bg-gradient-to-br from-orange-500 via-amber-600 to-zinc-900 px-5 py-7 text-white shadow-lg shadow-orange-600/20 dark:border-orange-900/50 dark:from-orange-600 dark:via-amber-900 dark:to-black sm:px-7">
        <style>{`
          @keyframes qcFloatSparkle {
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
              animation: `qcFloatSparkle ${s.dur} ${s.delay} infinite ease-in`,
              pointerEvents: 'none',
              userSelect: 'none',
              lineHeight: 1,
            }}
          >
            ✦
          </span>
        ))}
        <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/10 blur-3xl" aria-hidden />
        <div className="absolute -bottom-12 left-8 h-32 w-32 rounded-full bg-amber-300/20 blur-2xl" aria-hidden />

        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-orange-100/90">
              <Sparkles className="h-3 w-3 shrink-0" />
              QC dashboard
            </div>
            <h1 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              {welcome.heading(greeting)}
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-orange-100/85">{welcome.body}</p>
          </div>

          <div className="hidden h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-white/20 bg-white/10 shadow-lg shadow-black/20 backdrop-blur-sm sm:flex">
            <ClipboardCheck className="h-8 w-8 text-orange-100" />
          </div>
        </div>
      </header>

      {/* ── Control bar: CSV period selector (drives the calculator) ──────────── */}
      <div className="-mt-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-50 text-orange-600 ring-1 ring-orange-200/70 dark:bg-orange-950/40 dark:text-orange-400 dark:ring-orange-900/50">
            <CalendarDays className="h-4 w-4" />
          </span>
          <div className="flex flex-col">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-400 dark:text-zinc-500">
              Scoring period
            </span>
            <PeriodSelector
              value={weekStart}
              options={weekOptions}
              currentWeekStart={currentWeekStart}
              onChange={onSelectWeek}
            />
          </div>
        </div>
        <p className="text-[11px] leading-snug text-zinc-400 dark:text-zinc-500 sm:max-w-[15rem] sm:text-right">
          Switch periods to score — or backfill — a week. Your pick drives the QC calculator too.
        </p>
      </div>

      {/* Backfill notice when scoring a past period. The roster caveat only shows
          for a genuinely untouched week (nothing scored, not locked) — that's the
          case where the split was just built from the CURRENT team, since there's
          no per-week roster history. A week already being scored was split when it
          was worked, so it doesn't get the scare. */}
      {!isLive && currentWeekStart && (
        <div className="-mt-3 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-[12.5px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          <CalendarDays className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            You&rsquo;re scoring a <span className="font-semibold">past period</span> ({weekRange(weekStart)}). Anything you
            enter here backfills that week&rsquo;s QC scores.{' '}
            {scoredTotal === 0 && !qcLocked && (
              <>
                This week is split from the <span className="font-semibold">current</span> team, so double-check membership
                before you rely on the counts.{' '}
              </>
            )}
            <button
              type="button"
              onClick={() => onSelectWeek(currentWeekStart)}
              className="font-semibold underline decoration-amber-400 underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100"
            >
              Jump to the live period
            </button>
            .
          </p>
        </div>
      )}

      {/* ── KPI cards ─────────────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {kpis.map(({ label, value, sub, icon: Icon, grad }) => (
          <div
            key={label}
            className="flex items-center gap-3 rounded-xl border border-zinc-100 bg-white px-4 py-3.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow', grad)}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">{label}</p>
              <p
                className={cn(
                  'mt-0.5 truncate font-bold tabular-nums text-zinc-900 dark:text-zinc-100',
                  typeof value === 'number' ? 'text-2xl' : 'text-base leading-tight',
                )}
              >
                {qcLoaded ? String(value) : <span className="inline-block h-5 w-10 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />}
              </p>
              <p className="text-[10px] text-zinc-400 dark:text-zinc-500">{sub}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Progress + primary action ─────────────────────────────────────────── */}
      <section className="grid gap-4 lg:grid-cols-3">
        {/* Progress panel */}
        <div className="lg:col-span-2 flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-50 text-orange-600 ring-1 ring-orange-200/70 dark:bg-orange-950/40 dark:text-orange-400 dark:ring-orange-900/50">
                <Gauge className="h-4 w-4" />
              </span>
              <div>
                <h2 className="text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-white">This period&rsquo;s scoring</h2>
                <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
                  Week of {weekRange(weekStart)} · {scoredTotal} of {assignedCount} member{assignedCount === 1 ? '' : 's'} scored
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onOpen}
              className="group inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-orange-700 active:scale-[0.98]"
            >
              {qcLocked ? 'Open calculator' : progressPct >= 100 ? 'Review & lock' : 'Open calculator'}
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>

          {/* Overall bar */}
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Overall progress</span>
              <span className="text-[12px] font-bold tabular-nums text-orange-600 dark:text-orange-400">{progressPct}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-orange-500 to-amber-500 transition-[width] duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          {/* Per-department rows with their own progress */}
          <div className="grid gap-2 sm:grid-cols-3">
            {DEPTS.map(({ key, label, icon: Icon }) => {
              const total = mineByDept[key] ?? 0;
              const done = Math.min(total, scoredByDept[key] ?? 0);
              const p = pct(done, total);
              return (
                <div key={key} className="rounded-xl border border-zinc-100 bg-zinc-50/60 px-3.5 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
                      <Icon className="h-3.5 w-3.5 text-orange-500" />
                      {label}
                    </span>
                    <span className="text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                      <span className="font-semibold text-zinc-900 dark:text-white">{qcLoaded ? done : '—'}</span>
                      {' / '}
                      {qcLoaded ? total : '—'}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200/70 dark:bg-zinc-800">
                    <div className="h-full rounded-full bg-orange-500 transition-[width] duration-500" style={{ width: `${p}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          {officerCount > 1 && (
            <p className="text-[11px] text-zinc-400">
              Each department&rsquo;s roster is split equally across {officerCount} QC officers — these counts are your share.
            </p>
          )}
        </div>

        {/* Pipeline panel */}
        <div className="flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            How your scores reach payroll
          </h2>
          <Pipeline qcLocked={qcLocked} />
          <p className="mt-auto text-[11px] leading-relaxed text-zinc-400">
            Lock your batch when you&rsquo;re done — the Leadgen and Callback managers review and finalize your
            first-pass scores before anything is paid.
          </p>
        </div>
      </section>
    </div>
  );
}

// ── Pipeline stepper ────────────────────────────────────────────────────────────

function Pipeline({ qcLocked }: { qcLocked: boolean }) {
  const step = qcLocked ? 1 : 0;
  const steps = [
    { label: 'You score', hint: 'Enter KPI scores for your members', icon: PenLine },
    { label: 'Lock & send', hint: 'Submit your batch to the managers', icon: Lock },
    { label: 'Manager finalizes', hint: 'Reviewed, then paid via payroll', icon: ShieldCheck },
  ];
  return (
    <ol className="flex flex-col gap-2.5">
      {steps.map((s, i) => {
        const Icon = s.icon;
        const done = i < step;
        const active = i === step;
        return (
          <li key={s.label} className="flex items-start gap-3">
            <span
              className={cn(
                'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                active
                  ? 'bg-orange-100 text-orange-700 ring-1 ring-orange-300 dark:bg-orange-950/50 dark:text-orange-300 dark:ring-orange-800'
                  : done
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                    : 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-600',
              )}
            >
              {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
            </span>
            <div className="min-w-0">
              <p
                className={cn(
                  'text-[13px] font-medium',
                  active ? 'text-zinc-900 dark:text-zinc-50' : done ? 'text-zinc-700 dark:text-zinc-300' : 'text-zinc-500 dark:text-zinc-400',
                )}
              >
                {s.label}
              </p>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{s.hint}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── CSV period selector ─────────────────────────────────────────────────────────

/**
 * Period selector on the Overview control bar. Prev/next arrows step through
 * uploaded Hubstaff CSV weeks; the dropdown lists them all and marks the live
 * (currently-dispatched) week. Switching here drives the QC calculator too.
 *
 * Plain-button disclosure (no role=listbox) so Tab + Enter/Space work natively
 * and we don't promise arrow-key navigation the widget doesn't implement.
 */
function PeriodSelector({
  value,
  options,
  currentWeekStart,
  onChange,
}: {
  value: string;
  options: PayWeek[];
  currentWeekStart: string | null;
  onChange: (start: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Always include the selected + live weeks even before the upload list lands.
  const merged = useMemo(() => {
    const map = new Map<string, PayWeek>();
    for (const o of options) map.set(o.start, o);
    for (const s of [currentWeekStart, value]) {
      if (s && !map.has(s)) map.set(s, { start: s, end: weekEndFromStart(s) });
    }
    return Array.from(map.values()).sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
  }, [options, currentWeekStart, value]);

  const idx = merged.findIndex((o) => o.start === value);
  const isLive = currentWeekStart != null && value === currentWeekStart;
  const hasOlder = idx >= 0 && idx < merged.length - 1;
  const hasNewer = idx > 0;

  return (
    <div ref={ref} className="relative inline-flex items-center gap-1">
      <button
        type="button"
        aria-label="Older period"
        disabled={!hasOlder}
        onClick={() => hasOlder && onChange(merged[idx + 1]!.start)}
        className="rounded-md border border-zinc-200 bg-white p-1 text-zinc-500 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-left text-zinc-800 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-100 dark:hover:bg-zinc-800/70"
      >
        <span className="text-[12.5px] font-semibold tracking-tight">{weekRange(value) || '—'}</span>
        <span
          className={cn(
            'rounded-full px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wide',
            isLive
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
              : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
          )}
        >
          {isLive ? 'Live' : 'Past'}
        </span>
        <ChevronDown className={cn('h-3.5 w-3.5 text-zinc-400 transition-transform', open && 'rotate-180')} />
      </button>

      <button
        type="button"
        aria-label="Newer period"
        disabled={!hasNewer}
        onClick={() => hasNewer && onChange(merged[idx - 1]!.start)}
        className="rounded-md border border-zinc-200 bg-white p-1 text-zinc-500 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="absolute left-0 top-full z-30 mt-1.5 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-zinc-200 bg-white text-zinc-900 shadow-xl dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
          >
            <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                Pay periods (CSV)
              </span>
              {currentWeekStart && !isLive && (
                <button
                  type="button"
                  onClick={() => {
                    onChange(currentWeekStart);
                    setOpen(false);
                  }}
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-emerald-700 transition-colors hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/70"
                >
                  <Zap className="h-2.5 w-2.5" /> Live
                </button>
              )}
            </div>
            <ul className="max-h-72 overflow-y-auto py-1">
              {merged.length === 0 ? (
                <li className="px-3 py-3 text-center text-[11px] text-zinc-400">No uploaded periods yet.</li>
              ) : (
                merged.map((o) => {
                  const selected = o.start === value;
                  const live = currentWeekStart != null && o.start === currentWeekStart;
                  return (
                    <li key={o.start}>
                      <button
                        type="button"
                        onClick={() => {
                          onChange(o.start);
                          setOpen(false);
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors',
                          selected ? 'bg-orange-50/70 dark:bg-orange-950/30' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900',
                        )}
                        aria-pressed={selected}
                      >
                        <span className={cn('flex h-3.5 w-3.5 shrink-0 items-center justify-center', selected ? 'text-orange-600 dark:text-orange-400' : 'text-transparent')}>
                          <Check className="h-3.5 w-3.5" strokeWidth={3} />
                        </span>
                        <span className={cn('flex-1 tabular-nums', selected ? 'font-semibold text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-300')}>
                          {weekRange(o.start)}
                        </span>
                        {live && (
                          <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                            Live
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
