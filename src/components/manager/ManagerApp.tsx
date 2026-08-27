'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { resolveFirstName } from '@/lib/name/first-name';
import { toast } from 'sonner';
import AppFooter from '@/components/AppFooter';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  Briefcase,
  Building2,
  CalendarDays,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CirclePause,
  CirclePlay,
  ClipboardCheck,
  Clock,
  DoorOpen,
  Download,
  Eye,
  EyeOff,
  Inbox,
  LayoutGrid,
  List,
  Loader2,
  Mail,
  Pencil,
  Sparkles,
  Undo2,
  UserMinus,
  X,
  Menu,
  Search,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Toaster } from '@/components/ui/sonner';
import type { EmployeeRow } from '@/lib/supabase/employees';
import { normEmail } from '@/lib/email/norm-email';
import { SESSION_EMAIL_KEY, type Role } from '@/lib/rbac/views';
import { cn } from '@/lib/utils';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import ManagerSidebar, { type ManagerTab } from './ManagerSidebar';
import SchedulingPanel from './SchedulingPanel';
import LeaveRequestsPanel from '@/components/LeaveRequestsPanel';
import type { LeaveRequestRow } from '@/lib/supabase/leave-requests';
import AnnouncementWall from '@/components/announcements/AnnouncementWall';
import AnnouncementComposer from '@/components/announcements/AnnouncementComposer';
import SWall from '@/components/swall/SWall';
import HslBonusCalculator from '@/components/manager/HslBonusCalculator';
import DeptBonusCalculator from '@/components/manager/DeptBonusCalculator';
import ManagerBonusHistory from '@/components/manager/ManagerBonusHistory';
import { HSL_DEPT_KEYS, canAccessHslDept, type HslDeptKey } from '@/lib/hsl-bonus/schema';
import {
  isOutstanding,
  useBonusScoringQueue,
  type BonusScoringQueue,
  type ScoringState,
} from '@/lib/manager/use-bonus-scoring-queue';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { slugifyDeptKey } from '@/lib/departments/registry';
import { DEPT_INPUT_CONFIG, isKpiCalculatorDeptKey } from '@/lib/payroll/department-bonus';
import { isLeadGenDepartment } from '@/lib/hr/calltools-username';
import ManagerMemberDialog from '@/components/manager/ManagerMemberDialog';
import ManagerTransfers from '@/components/manager/ManagerTransfers';
import ManagerOffboardQueueDialog, {
  type OffboardCandidate,
} from '@/components/manager/ManagerOffboardQueueDialog';
import { Checkbox } from '@/components/ui/checkbox';
import type { OffboardingQueueStatus } from '@/lib/supabase/offboarding-queue';
import type { ResignationRequestRow } from '@/lib/supabase/resignation-requests';
import { offboardReasonLabel } from '@/lib/hr/offboard-reasons';
import NewlyHiredPanel from '@/components/manager/NewlyHiredPanel';
import OrientationAttendancePanel from '@/components/manager/OrientationAttendancePanel';
import NotificationsPanel from '@/components/notifications/NotificationsPanel';
import { useFeaturePermissions } from '@/hooks/useFeaturePermissions';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import PayrollProcessingLock from '@/components/payroll/PayrollProcessingLock';
import { usePagesVisibility } from '@/hooks/usePagesVisibility';
import { pageLabel } from '@/lib/pages/visibility';
import UnderConstruction from '@/components/common/UnderConstruction';
import ConstructionBanner from '@/components/common/ConstructionBanner';
import ReadOnlyTab from '@/components/rbac/ReadOnlyTab';
import { useOnlineEmails, usePublishPresenceTab } from '@/components/presence/PresenceProvider';
import { humanizeTabId } from '@/lib/presence/page-label';
import { useTabDocumentTitle } from '@/hooks/useTabDocumentTitle';
import { TeamAvatar, initialsOf, gradientFor } from '@/components/team/team-ui';
import { formatCurrentProjects } from '@/lib/skill-set-titles';
import {
  MedalProvider,
  MedalPalette,
  MedalBadges,
  useMedalCtx,
} from '@/components/manager/MedalRecognition';
import { SmoothSelect } from '@/components/ui/smooth-select';

/** How `/api/manager/department-members` scoped the roster for this session (server-driven). */
type ManagerTeamGate =
  | { kind: 'loading' }
  | { kind: 'elevated' }
  | { kind: 'department'; departments: string[] }
  | { kind: 'error'; message: string };

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export default function ManagerApp() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams?.get('email') ?? null;

  const [activeTab, setActiveTab] = useState<ManagerTab>('overview');
  usePublishPresenceTab(humanizeTabId(activeTab));
  useTabDocumentTitle(humanizeTabId(activeTab));
  // When a manager owns both HSL branches and regular departments, the KPI tab
  // shows one calculator at a time (null = default to first-assigned).
  const [kpiCalc, setKpiCalc] = useState<'hsl' | 'dept' | null>(null);
  // "Start processing" lock from the Payroll Wizard — while on, the KPI
  // Calculator tab is fully taken over (values are being paid out).
  const { state: payrollProcessing } = useDispatchLock();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [viewerEmail, setViewerEmail] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  // Resolve viewer email from ?email= or sessionStorage.
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

  // Soft client-side gate: bounce non-managers to /employee. Mirrors how the rest of
  // the app handles role-based access (sidebar hides the link, page bounces if reached
  // by URL). Server-side enforcement lives at the API layer.
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
        const allowed = roles.includes('manager') || roles.includes('admin');
        if (cancelled) return;
        if (!allowed) {
          router.replace(viewerEmail ? `/employee?email=${encodeURIComponent(viewerEmail)}` : '/employee');
          return;
        }
        setAuthChecked(true);
      } catch {
        // A failed role check must DENY, not grant. Redirect to the safe
        // employee portal rather than rendering the privileged dashboard.
        if (!cancelled) {
          router.replace(viewerEmail ? `/employee?email=${encodeURIComponent(viewerEmail)}` : '/employee');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, viewerEmail]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavOpen]);

  useEffect(() => {
    if (mobileNavOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [mobileNavOpen]);

  const [pendingApprovals, setPendingApprovals] = useState(0);
  // All pending requests (newest first) + signed URLs for their evidence images —
  // the Overview gallery hero cycles through them.
  const [pendingRequests, setPendingRequests] = useState<TimeAdjustmentRow[]>([]);
  const [pendingSignedUrls, setPendingSignedUrls] = useState<Record<string, string>>({});
  const [requestsLoading, setRequestsLoading] = useState(true);
  // Keep the pending-approval badge live — refetch whenever the tab is opened.
  useEffect(() => {
    let cancelled = false;
    setRequestsLoading(true);
    fetch('/api/manager/time-adjustments', { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: { rows?: TimeAdjustmentRow[]; signedUrls?: Record<string, string> }) => {
        if (cancelled) return;
        const rows = json.rows ?? [];
        // Rows arrive ordered created_at desc, so the first pending row is the newest.
        const pendingRows = rows.filter((r) => r.status === 'pending');
        setPendingApprovals(pendingRows.length);
        setPendingRequests(pendingRows);
        setPendingSignedUrls(json.signedUrls ?? {});
        setRequestsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setPendingApprovals(0);
        setPendingRequests([]);
        setPendingSignedUrls({});
        setRequestsLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeTab]);

  const [teamMembers, setTeamMembers] = useState<EmployeeRow[]>([]);
  const [teamGate, setTeamGate] = useState<ManagerTeamGate>({ kind: 'loading' });

  useEffect(() => {
    if (!authChecked) return;
    let cancelled = false;
    (async () => {
      setTeamGate({ kind: 'loading' });
      try {
        const res = await fetch('/api/manager/department-members', { cache: 'no-store' });
        const json = (await res.json()) as {
          rows?: EmployeeRow[];
          scope?: 'elevated' | 'department';
          departments?: string[];
          error?: string | null;
        };
        if (!res.ok) throw new Error(json.error || 'Failed to load team roster');
        if (cancelled) return;
        setTeamMembers(json.rows ?? []);
        if (json.scope === 'elevated') {
          setTeamGate({ kind: 'elevated' });
          return;
        }
        setTeamGate({
          kind: 'department',
          departments: json.departments ?? [],
        });
      } catch (e) {
        if (!cancelled) {
          setTeamMembers([]);
          setTeamGate({
            kind: 'error',
            message: e instanceof Error ? e.message : 'Failed to load team roster',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authChecked]);

  // Live count of pending leave requests across all departments. We re-fetch on tab
  // switch so the badge reflects approvals decided in the panel without a manual reload.
  const [pendingLeaves, setPendingLeaves] = useState(0);
  useEffect(() => {
    if (!authChecked) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/leave-requests?scope=all', { cache: 'no-store' });
        const json = (await res.json()) as { rows?: LeaveRequestRow[] };
        if (cancelled) return;
        const pending = (json.rows ?? []).filter((r) => r.status === 'pending').length;
        setPendingLeaves(pending);
      } catch {
        if (!cancelled) setPendingLeaves(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authChecked, activeTab]);

  // Per-tab feature-permission overlay (hidden until granted; admin bypasses).
  const { ready: permsReady, allowedTabs, canEditTab } = useFeaturePermissions(viewerEmail);
  // Global Pages overlay (admin-controlled visible / construction / hidden).
  const { ready: pagesReady, visibilityOf, rawVisibilityOf, isAdmin } = usePagesVisibility();
  const allowedManagerTabs = allowedTabs('manager');
  // Drop pages an admin hid; keep "construction" ones (shown with a placeholder).
  const visibleManagerTabs = allowedManagerTabs.filter((t) => visibilityOf('manager', t) !== 'hidden');
  // Badge uses the RAW state so it still shows for admins (who bypass the gate).
  const constructionManagerTabs = allowedManagerTabs.filter((t) => rawVisibilityOf('manager', t) === 'construction');
  const visibleManagerKey = visibleManagerTabs.join(',');
  useEffect(() => {
    if (!permsReady || !pagesReady) return;
    if (!visibleManagerTabs.includes(activeTab)) {
      setActiveTab((visibleManagerTabs[0] as ManagerTab) ?? 'overview');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permsReady, pagesReady, visibleManagerKey, activeTab]);

  // Deep-link from the Overview "Bonuses to score" panel into the KPI Calculator
  // with one department already open. Consumed by each calculator's own
  // initial-open prop when it mounts (the tab switch remounts it).
  const [kpiFocus, setKpiFocus] = useState<{ kind: 'hsl' | 'catalog'; key: string } | null>(null);

  const handleNavigate = (tab: ManagerTab) => {
    setActiveTab(tab);
    setMobileNavOpen(false);
    // A plain nav is not a deep-link: drop any pending Overview focus so the KPI
    // tab doesn't re-open a department the manager already dealt with.
    setKpiFocus(null);
  };

  const handleJumpToScoring = React.useCallback(
    (dept?: { kind: 'hsl' | 'catalog'; key: string }) => {
      setKpiFocus(dept ?? null);
      // Managers who own both calculators see one at a time — show the one that
      // owns the clicked department.
      if (dept) setKpiCalc(dept.kind === 'hsl' ? 'hsl' : 'dept');
      setActiveTab('hsl-bonus');
      setMobileNavOpen(false);
    },
    [],
  );

  // Deep-link from the Overview spotlight into My Team with a specific employee's
  // profile open. `teamFocusEmail` is consumed (cleared) once the panel opens it.
  const [teamFocusEmail, setTeamFocusEmail] = useState<string | null>(null);
  const handleViewEmployee = React.useCallback((email: string) => {
    setTeamFocusEmail(email);
    setActiveTab('team');
    setMobileNavOpen(false);
  }, []);
  const clearTeamFocus = React.useCallback(() => setTeamFocusEmail(null), []);

  if (!authChecked) {
    return (
      <div className="flex h-screen items-center justify-center bg-white dark:bg-[#0d1117]">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-orange-500 border-t-transparent"
          aria-hidden
        />
      </div>
    );
  }

  return (
    <div className="flex h-dvh max-h-dvh w-full overflow-hidden bg-gradient-to-br from-white via-blue-50/40 to-white text-zinc-900 dark:from-black dark:via-blue-950/25 dark:to-black dark:text-zinc-100">
      {mobileNavOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden"
          aria-label="Close navigation menu"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <ManagerSidebar
        activeTab={activeTab}
        setActiveTab={handleNavigate}
        mobileOpen={mobileNavOpen}
        viewerEmail={viewerEmail}
        pendingApprovals={pendingApprovals}
        pendingLeaves={pendingLeaves}
        allowedTabs={visibleManagerTabs}
        constructionTabs={constructionManagerTabs}
      />

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 border-b border-[#ececec] bg-white/95 px-3 py-2.5 backdrop-blur-md supports-[padding:max(0px)]:pt-[max(0.625rem,env(safe-area-inset-top))] dark:border-zinc-800 dark:bg-zinc-950/95 md:hidden">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0 border-[#ececec] bg-[#fafaf8] dark:border-zinc-800 dark:bg-zinc-900"
            onClick={() => setMobileNavOpen(true)}
            aria-expanded={mobileNavOpen}
            aria-controls="manager-sidebar-nav"
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Manager
          </span>
        </header>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeTab}
              role="presentation"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{
                duration: 0.32,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
            >
              {isAdmin && rawVisibilityOf('manager', activeTab) === 'construction' && (
                <ConstructionBanner title={pageLabel('manager', activeTab)} />
              )}
              {visibilityOf('manager', activeTab) !== 'visible' ? (
                <UnderConstruction title={pageLabel('manager', activeTab)} />
              ) : (
              <ReadOnlyTab readOnly={permsReady && !canEditTab('manager', activeTab)}>
              {activeTab === 'overview' && (
                <Overview
                  viewerEmail={viewerEmail}
                  pendingApprovals={pendingApprovals}
                  pendingRequests={pendingRequests}
                  pendingSignedUrls={pendingSignedUrls}
                  requestsLoading={requestsLoading}
                  teamMembers={teamMembers}
                  teamCount={teamGate.kind === 'loading' ? null : teamMembers.length}
                  teamGate={teamGate}
                  canScoreBonuses={visibleManagerTabs.includes('hsl-bonus')}
                  scoringGateReady={permsReady && pagesReady}
                  onJumpToApprovals={() => handleNavigate('time-adjustments')}
                  onJumpToTeam={() => handleNavigate('team')}
                  onViewEmployee={handleViewEmployee}
                  onJumpToScoring={handleJumpToScoring}
                />
              )}
              {activeTab === 'time-adjustments' && (
                <ManagerTimeAdjustments
                  onCountChange={(n) => setPendingApprovals(n)}
                />
              )}
              {activeTab === 'leaves' && <LeaveRequestsPanel />}
              {activeTab === 'team' && (
                <TeamPanel
                  members={teamMembers}
                  teamGate={teamGate}
                  viewerEmail={viewerEmail}
                  focusEmail={teamFocusEmail}
                  onFocusConsumed={clearTeamFocus}
                />
              )}
              {activeTab === 'scheduling' && (
                <SchedulingPanel
                  myDepartments={
                    teamGate.kind === 'department' ? teamGate.departments : undefined
                  }
                />
              )}
              {activeTab === 'transfers' && (
                <ManagerTransfers
                  canInitiate
                  myDepartments={
                    teamGate.kind === 'department'
                      ? teamGate.departments
                      : Array.from(
                          new Set(
                            teamMembers.map((m) => (m.department ?? '').trim()).filter(Boolean),
                          ),
                        )
                  }
                />
              )}
              {activeTab === 'announcements' && (
                <ManagerAnnouncementsTab viewerEmail={viewerEmail} teamGate={teamGate} />
              )}
              {activeTab === 's-wall' && (
                <ManagerSwallTab viewerEmail={viewerEmail} />
              )}
              {activeTab === 'hsl-bonus' && (() => {
                // Hard stop: once Accounting hits "Start processing" in the
                // Payroll Wizard, KPI Calculators are unusable until it stops.
                // Admins bypass — they're trusted to correct numbers mid-cycle
                // (matches the server-side guard in processing-guard.ts).
                if (payrollProcessing.locked && !isAdmin) {
                  return (
                    <PayrollProcessingLock
                      surface="The KPI Calculator"
                      lockedAt={payrollProcessing.lockedAt}
                    />
                  );
                }
                const managed = teamGate.kind === 'department' ? teamGate.departments : [];
                const elevated = teamGate.kind === 'elevated';
                // HSL KPI Calculator is visible ONLY to managers explicitly assigned
                // HSL sub-branches in Admin -> Roles & permissions (the `hsl:*`
                // department_managers rows). Being elevated/admin alone no longer
                // unlocks it — you must be an assigned HSL Manager.
                const hslVisible = HSL_DEPT_KEYS.some((k) => canAccessHslDept(managed, k, false));
                const deptVisible =
                  elevated ||
                  managed.some((dStr) => {
                    const k = normalizeDeptToKey(dStr);
                    if (k) return k in DEPT_INPUT_CONFIG;
                    // In-app (Payment Catalog -> Department) departments miss
                    // the alias map; the calculator renders them as
                    // catalog-driven cards. `hsl:*` strings are HSL access
                    // keys, not departments. Retired departments render no card
                    // at all, so they must not unlock the tab either — else a
                    // manager who holds only those grants lands on an empty
                    // calculator instead of the "no departments" explainer.
                    return (
                      !!dStr &&
                      !dStr.includes(':') &&
                      isKpiCalculatorDeptKey(slugifyDeptKey(dStr))
                    );
                  });
                if (!hslVisible && !deptVisible) {
                  return (
                    <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
                      <Users className="h-10 w-10 text-zinc-300 dark:text-zinc-700" aria-hidden />
                      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                        No bonus departments assigned to you.
                      </p>
                      <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-500">
                        Ask an admin to assign you to a department under Roles &amp; permissions.
                      </p>
                    </div>
                  );
                }

                // Both calculators have their own sticky toolbar; stacking them
                // collides. When a manager owns both, show ONE at a time and
                // default to whichever calculator owns their first-assigned dept
                // (assignment order is preserved in `managed`).
                const both = hslVisible && deptVisible;
                const firstAssigned: 'hsl' | 'dept' = (() => {
                  if (!both) return hslVisible ? 'hsl' : 'dept';
                  for (const dStr of managed) {
                    if (dStr.toLowerCase().startsWith('hsl:')) return 'hsl';
                    const k = normalizeDeptToKey(dStr);
                    if (k && k in DEPT_INPUT_CONFIG) return 'dept';
                    if (!k && !dStr.includes(':') && isKpiCalculatorDeptKey(slugifyDeptKey(dStr))) return 'dept';
                  }
                  return 'hsl';
                })();
                const active: 'hsl' | 'dept' = both ? (kpiCalc ?? firstAssigned) : firstAssigned;

                return (
                  <div className="flex min-h-0 flex-col">
                    {both && (
                      <div role="tablist" aria-label="KPI calculator views" className="flex items-center gap-2 border-b border-zinc-200/80 bg-white px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-950 sm:px-6">
                        <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-400">
                          Calculator
                        </span>
                        {([
                          { id: 'hsl' as const, label: 'HSL Branches' },
                          { id: 'dept' as const, label: 'Departments' },
                        ]).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            role="tab"
                            aria-selected={active === t.id}
                            onClick={() => setKpiCalc(t.id)}
                            className={cn(
                              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                              active === t.id
                                ? 'border-transparent bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                                : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300 dark:hover:bg-zinc-800/60',
                            )}
                          >
                            {t.label}
                            {t.id === firstAssigned && (
                              <span className={cn('ml-1.5 font-mono text-[9px]', active === t.id ? 'opacity-60' : 'text-zinc-400')}>
                                primary
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                    {active === 'hsl' && hslVisible && (
                      <HslBonusCalculator
                        viewerEmail={viewerEmail}
                        managedDepts={managed}
                        isElevated={elevated}
                        initialFilter={
                          kpiFocus?.kind === 'hsl' ? (kpiFocus.key as HslDeptKey) : undefined
                        }
                      />
                    )}
                    {active === 'dept' && deptVisible && (
                      <DeptBonusCalculator
                        viewerEmail={viewerEmail}
                        teamMembers={teamMembers}
                        managedDepts={managed}
                        isElevated={elevated}
                        initialOpenDept={kpiFocus?.kind === 'catalog' ? kpiFocus.key : null}
                      />
                    )}
                  </div>
                );
              })()}
              {activeTab === 'bonus-history' && (
                <ManagerBonusHistory
                  viewerEmail={viewerEmail}
                  managedDepts={teamGate.kind === 'department' ? teamGate.departments : []}
                  isElevated={teamGate.kind === 'elevated'}
                />
              )}
              {activeTab === 'notifications' && (
                <NotificationsPanel viewerEmail={viewerEmail} accent="blue" view="manager" />
              )}
              </ReadOnlyTab>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <AppFooter />
      </main>

      <Toaster richColors position="top-center" />
    </div>
  );
}

// ─── Overview ────────────────────────────────────────────────────────────────

interface OverviewProps {
  viewerEmail: string | null;
  pendingApprovals: number;
  pendingRequests: TimeAdjustmentRow[];
  pendingSignedUrls: Record<string, string>;
  requestsLoading: boolean;
  teamMembers: EmployeeRow[];
  teamCount: number | null;
  teamGate: ManagerTeamGate;
  /** Whether the KPI Calculator tab is available to this viewer — the "Bonuses
   *  to score" box is hidden when it isn't (nothing to click through to). */
  canScoreBonuses: boolean;
  /** False while feature permissions / the department gate are still resolving.
   *  `canScoreBonuses` isn't trustworthy until then, so the box holds a skeleton
   *  rather than flashing "no access" at a manager who has it. */
  scoringGateReady: boolean;
  onJumpToApprovals: () => void;
  onJumpToTeam: () => void;
  onViewEmployee: (email: string) => void;
  /** Open the KPI Calculator, optionally landing on one department's card. */
  onJumpToScoring: (dept?: { kind: 'hsl' | 'catalog'; key: string }) => void;
}

function Overview({
  viewerEmail,
  pendingApprovals,
  pendingRequests,
  pendingSignedUrls,
  requestsLoading,
  teamMembers,
  teamCount,
  teamGate,
  canScoreBonuses,
  scoringGateReady,
  onJumpToApprovals,
  onJumpToTeam,
  onViewEmployee,
  onJumpToScoring,
}: OverviewProps) {
  // Resolve the manager's real first name. The email local part alone is
  // unreliable (e.g. "j.delacruz@…" → "J"), so look up the employee record and
  // use the first token of its "First Last" name; fall back to the email.
  const [realName, setRealName] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

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

  // Resolve the manager's display first name (real name → first token, with an
  // email-local-part fallback and ALL-CAPS proper-casing). See resolveFirstName.
  const greeting = useMemo(
    () => resolveFirstName({ name: realName, email: viewerEmail }),
    [realName, viewerEmail],
  );

  // What the KPI Calculator still owes payroll for the live pay week. Shared by
  // the tile and the "Bonuses to score" panel below so both read one fetch.
  const scoring = useBonusScoringQueue({
    managedDepts: teamGate.kind === 'department' ? teamGate.departments : [],
    isElevated: teamGate.kind === 'elevated',
    ready: scoringGateReady && canScoreBonuses && teamGate.kind !== 'loading',
  });
  // Keep the card's slot while the gate resolves; drop it once we know the
  // viewer has no KPI Calculator to click through to.
  const showScoring = !scoringGateReady || canScoreBonuses;

  // Warm, time-of-day welcome. Computed only after mount so the first client
  // render matches the server (UTC) and we don't trip the Manila-vs-UTC
  // hydration mismatch (React #418).
  const welcome = useMemo(() => {
    if (!mounted) return "Here's everything you need to look after your team today.";
    const h = new Date().getHours();
    const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
    return `Good ${part} — here's everything you need to look after your team today.`;
  }, [mounted]);

  return (
    <div className="flex w-full flex-1 flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      {/* Gradient hero — the whole greeting lives in one calm band */}
      <header className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-900 px-5 py-7 shadow-lg shadow-blue-900/20 sm:px-8">
        <style>{`
          @keyframes wave {
            0%, 60%, 100% { transform: rotate(0deg); }
            10%, 30%      { transform: rotate(14deg); }
            20%           { transform: rotate(-8deg); }
            40%           { transform: rotate(10deg); }
            50%           { transform: rotate(-4deg); }
          }
        `}</style>
        <div
          aria-hidden
          className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-sky-300/25 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-24 left-1/4 h-52 w-52 rounded-full bg-violet-400/20 blur-3xl"
        />
        <div className="relative flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-blue-100/80">
              Manager workspace
            </div>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Hi {greeting}{' '}
              <span className="inline-block origin-[70%_70%] motion-safe:animate-[wave_1.6s_ease-in-out_1]" aria-hidden>
                👋
              </span>
            </h1>
            <p className="mt-1.5 max-w-lg text-sm text-blue-100/85">{welcome}</p>
          </div>
          <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-3 py-1.5 text-[11px] font-medium text-white backdrop-blur-sm sm:inline-flex">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />
            Live
          </span>
        </div>
      </header>

      {/* Three numbers, nothing else */}
      <section className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Pending approvals"
          value={pendingApprovals}
          hint={pendingApprovals === 0 ? 'Nothing in your queue' : 'Awaiting your sign-off'}
          icon={ClipboardCheck}
          accent="blue"
          onClick={onJumpToApprovals}
        />
        <StatTile
          label="My team"
          value={teamCount === null ? '—' : teamCount}
          hint={
            teamGate.kind === 'loading'
              ? 'Loading roster…'
              : teamGate.kind === 'error'
                ? 'Could not load roster'
                : teamGate.kind === 'department' && teamGate.departments.length === 0
                  ? 'No departments assigned yet — ask an admin'
                  : teamGate.kind === 'department'
                    ? teamGate.departments.join(', ')
                    : teamCount === 0
                      ? 'No matching employees in roster'
                      : 'Active roster (org-wide)'
          }
          icon={Users}
          accent="indigo"
          onClick={onJumpToTeam}
        />
        <StatTile
          label="Bonuses to score"
          value={
            !showScoring
              ? '—'
              : scoring.loading || scoring.weekUnresolved
                ? '—'
                : scoring.outstanding
          }
          hint={
            !showScoring
              ? 'No KPI Calculator access'
              : scoring.loading
                ? 'Checking this pay cycle…'
                : scoring.weekUnresolved
                  ? 'Waiting on this week’s Hubstaff upload'
                  : scoring.items.length === 0
                    ? 'No bonus departments assigned'
                    : scoring.outstanding === 0
                      ? `All submitted · ${fmtPayWeek(scoring.weekStart, scoring.weekEnd)}`
                      : `${scoring.outstanding === 1 ? 'Department' : 'Departments'} left · ${fmtPayWeek(scoring.weekStart, scoring.weekEnd)}`
          }
          icon={Sparkles}
          accent={showScoring && scoring.outstanding > 0 ? 'amber' : 'slate'}
          onClick={showScoring ? () => onJumpToScoring() : undefined}
        />
      </section>

      {/* Plain panels — what needs you, who's around, and what payroll is still
          waiting on. `flex-1` lets them stretch to the bottom of the viewport
          instead of floating mid-page. */}
      <section
        className={cn('grid flex-1 gap-4 lg:grid-cols-2', showScoring && 'xl:grid-cols-3')}
      >
        <ApprovalsPanel
          requests={pendingRequests}
          signedUrls={pendingSignedUrls}
          loading={requestsLoading}
          onReview={onJumpToApprovals}
        />
        <TeamGlancePanel
          members={teamMembers}
          loading={teamGate.kind === 'loading'}
          onOpenTeam={onJumpToTeam}
          onViewEmployee={onViewEmployee}
        />
        {showScoring && (
          <BonusScoringPanel
            queue={scoring}
            // Third card in a two-column grid: span the row on lg so it doesn't
            // sit as a lonely half-width box, then take its own column at xl.
            className="lg:col-span-2 xl:col-span-1"
            onOpenCalculator={onJumpToScoring}
          />
        )}
      </section>
    </div>
  );
}

// ─── Overview: shared panel shell ────────────────────────────────────────────

/** Plain card: gradient hairline, icon + title, body, one full-width action. */
function OverviewPanel({
  icon: Icon,
  title,
  meta,
  gradient,
  action,
  className,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  meta?: React.ReactNode;
  /** Tailwind `from-… to-…` pair, reused for the hairline, chip and button. */
  gradient: string;
  action?: { label: string; onClick: () => void };
  /** Grid placement from the caller (column spans). */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex min-h-[17rem] flex-col overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950',
        className,
      )}
    >
      <div className={cn('h-1 w-full shrink-0 bg-gradient-to-r', gradient)} />
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-sm',
              gradient,
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {title}
          </span>
        </div>
        {meta}
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">{children}</div>
      {action && (
        <div className="shrink-0 px-4 pb-4">
          <button
            type="button"
            onClick={action.onClick}
            className={cn(
              'inline-flex w-full items-center justify-center gap-1 rounded-lg bg-gradient-to-r px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:brightness-110',
              gradient,
            )}
          >
            {action.label}
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Overview: pending approvals ─────────────────────────────────────────────

/** How many pending rows the Overview previews before deferring to the queue. */
const APPROVALS_PREVIEW = 6;

function ApprovalsPanel({
  requests,
  signedUrls,
  loading,
  onReview,
}: {
  requests: TimeAdjustmentRow[];
  signedUrls: Record<string, string>;
  loading: boolean;
  onReview: () => void;
}) {
  const rows = requests.slice(0, APPROVALS_PREVIEW);
  const thumbFor = (r: TimeAdjustmentRow) =>
    (r.image_paths ?? []).map((p) => signedUrls[p]).find(Boolean) ?? null;

  return (
    <OverviewPanel
      icon={ClipboardCheck}
      title="Pending approvals"
      gradient="from-blue-500 to-indigo-600"
      meta={
        loading ? null : requests.length > 0 ? (
          <span className="shrink-0 rounded-full bg-gradient-to-r from-blue-500 to-indigo-600 px-2 py-0.5 text-[10px] font-bold tabular-nums text-white">
            {requests.length}
          </span>
        ) : (
          <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
            Clear
          </span>
        )
      }
      action={
        requests.length > 0
          ? { label: requests.length === 1 ? 'Review request' : 'Review all requests', onClick: onReview }
          : undefined
      }
    >
      {loading ? (
        <div className="space-y-1.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-xl border border-zinc-100 px-2.5 py-2 dark:border-zinc-800"
            >
              <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="h-2.5 w-2/3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-2 w-1/3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              </div>
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 pb-6 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 text-white shadow-sm shadow-emerald-500/30">
            <CheckCircle2 className="h-5 w-5" />
          </span>
          <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">All cleared</p>
          <p className="max-w-[16rem] text-xs text-zinc-500 dark:text-zinc-500">
            Nothing is waiting on you. New time adjustments from your team land here.
          </p>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => {
            const thumb = thumbFor(r);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={onReview}
                  className="flex w-full items-center gap-3 rounded-xl border border-zinc-100 bg-gradient-to-r from-blue-50/70 to-transparent px-2.5 py-2 text-left transition hover:border-blue-200 hover:from-blue-100/70 dark:border-zinc-800 dark:from-blue-950/25 dark:hover:border-blue-900"
                >
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element -- signed storage URL
                    <img
                      src={thumb}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded-lg object-cover"
                    />
                  ) : (
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-600">
                      <ImageOff className="h-3.5 w-3.5" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                      {r.work_email}
                    </p>
                    <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                      {TA_REASON_LABEL(r.reason)}
                      <span className="mx-1 text-zinc-300 dark:text-zinc-700">&middot;</span>
                      <span className="font-mono">{r.adjust_date}</span>
                      {r.requested_hours != null && (
                        <>
                          <span className="mx-1 text-zinc-300 dark:text-zinc-700">&middot;</span>
                          {r.requested_hours}h
                        </>
                      )}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-zinc-300 dark:text-zinc-600" />
                </button>
              </li>
            );
          })}
          {requests.length > rows.length && (
            <li className="pt-0.5 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
              +{requests.length - rows.length} more waiting
            </li>
          )}
        </ul>
      )}
    </OverviewPanel>
  );
}

// ─── Overview: roster glance ─────────────────────────────────────────────────

/** How many faces the Overview shows before deferring to the My Team tab. */
const TEAM_GLANCE_LIMIT = 24;

/** Round avatar at an arbitrary pixel size — photo proxy with initials fallback. */
function SpotlightAvatar({
  name,
  email,
  px,
}: {
  name: string;
  email: string | null;
  px: number;
}) {
  const [failed, setFailed] = useState(false);
  const seed = email ?? name;
  if (email && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- internal photo proxy
      <img
        src={`/api/employee-profile-photo?email=${encodeURIComponent(email)}&_fmt=img`}
        alt=""
        width={px}
        height={px}
        className="shrink-0 rounded-full object-cover"
        style={{ height: px, width: px }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-bold text-white shadow-sm',
        gradientFor(seed),
      )}
      style={{ height: px, width: px, fontSize: Math.round(px * 0.34) }}
    >
      {initialsOf(name, email)}
    </div>
  );
}

/** Who's on the roster right now — online first, click through to a profile. */
function TeamGlancePanel({
  members,
  loading,
  onOpenTeam,
  onViewEmployee,
}: {
  members: EmployeeRow[];
  loading: boolean;
  onOpenTeam: () => void;
  onViewEmployee: (email: string) => void;
}) {
  const onlineEmails = useOnlineEmails();
  const isOnline = React.useCallback(
    (m: EmployeeRow) => {
      const w = normEmail(m.work_email ?? '');
      const p = normEmail(m.personal_email ?? '');
      return (!!w && onlineEmails.has(w)) || (!!p && onlineEmails.has(p));
    },
    [onlineEmails],
  );

  // Online members float to the front so the panel reads as live at a glance.
  const ordered = useMemo(
    () => [...members].sort((a, b) => Number(isOnline(b)) - Number(isOnline(a))),
    [members, isOnline],
  );
  const onlineCount = useMemo(() => members.filter(isOnline).length, [members, isOnline]);
  const shown = ordered.slice(0, TEAM_GLANCE_LIMIT);

  return (
    <OverviewPanel
      icon={Users}
      title="My team"
      gradient="from-indigo-500 to-violet-600"
      meta={
        loading ? null : (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            {onlineCount} active
          </span>
        )
      }
      action={members.length > 0 ? { label: 'Open My Team', onClick: onOpenTeam } : undefined}
    >
      {loading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))] gap-2">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="flex flex-col items-center gap-1.5 py-1.5">
              <div className="h-10 w-10 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
              <div className="h-2 w-8 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            </div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 pb-6 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-indigo-400 to-violet-600 text-white shadow-sm shadow-indigo-500/30">
            <Users className="h-5 w-5" />
          </span>
          <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">No team yet</p>
          <p className="max-w-[16rem] text-xs text-zinc-500 dark:text-zinc-500">
            Once a department is assigned to you, its members show up here.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))] gap-1">
            {shown.map((m, i) => {
              const email = m.work_email ?? m.personal_email ?? null;
              return (
                <button
                  key={email ?? m.name ?? `member-${i}`}
                  type="button"
                  onClick={() => (email ? onViewEmployee(email) : onOpenTeam())}
                  title={m.name ?? email ?? undefined}
                  className="group flex flex-col items-center gap-1 rounded-lg px-0.5 py-1.5 transition hover:bg-indigo-50/70 dark:hover:bg-indigo-950/30"
                >
                  <span className="relative">
                    <SpotlightAvatar name={m.name ?? '—'} email={email} px={40} />
                    {isOnline(m) && (
                      <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-zinc-950" />
                    )}
                  </span>
                  <span className="w-full truncate text-center text-[10px] font-medium text-zinc-600 group-hover:text-zinc-900 dark:text-zinc-400 dark:group-hover:text-zinc-100">
                    {resolveFirstName({ name: m.name ?? null, email })}
                  </span>
                </button>
              );
            })}
          </div>
          {members.length > shown.length && (
            <p className="mt-1 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
              +{members.length - shown.length} more on your roster
            </p>
          )}
        </>
      )}
    </OverviewPanel>
  );
}

// ─── Overview: bonuses to score ──────────────────────────────────────────────

/** "Jul 20 – Jul 26" for a resolved pay week; an em dash before it resolves. */
function fmtPayWeek(start: string | null, end: string | null): string {
  if (!start) return '—';
  const opts = { month: 'short', day: 'numeric' } as const;
  const s = new Date(`${start}T00:00:00`).toLocaleDateString('en-US', opts);
  if (!end) return s;
  return `${s} – ${new Date(`${end}T00:00:00`).toLocaleDateString('en-US', opts)}`;
}

/** How the row for each scoring state reads. Two groups only, visually: things
 *  that still need the manager (amber/zinc) and things already handled (green). */
const SCORING_CHIP: Record<ScoringState, { label: string; cls: string }> = {
  todo: {
    label: 'Not scored',
    cls: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  },
  in_progress: {
    label: 'Draft',
    cls: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300',
  },
  submitted: {
    label: 'Submitted',
    cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  },
  locked: {
    label: 'Locked',
    cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  },
  nothing: {
    label: 'No bonuses',
    cls: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  },
  not_due: {
    label: 'Month end',
    cls: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  },
};

/** Departments per page in the panel's rotation. */
const SCORING_PAGE_SIZE = 5;
/** How long each page of departments stays on screen. */
const SCORING_PAGE_MS = 10_000;

/**
 * What the KPI Calculator still owes payroll for the live pay week — one row per
 * department the manager scores, outstanding ones first. Clicking a row opens
 * that department's calculator directly.
 *
 * A manager can own more departments than fit the card, so the list pages itself
 * every 10s rather than hiding the tail behind a "+N more". Rotation pauses
 * while the pointer (or keyboard focus) is inside the card — the rows are
 * buttons, and a page turning mid-click would open the wrong department.
 */
function BonusScoringPanel({
  queue,
  className,
  onOpenCalculator,
}: {
  queue: BonusScoringQueue;
  className?: string;
  onOpenCalculator: (dept?: { kind: 'hsl' | 'catalog'; key: string }) => void;
}) {
  const { loading, items, outstanding, weekStart, weekEnd, weekUnresolved, error } = queue;
  const gradient = 'from-amber-500 to-orange-600';
  const reduceMotion = useReducedMotion();

  const pageCount = Math.max(1, Math.ceil(items.length / SCORING_PAGE_SIZE));
  const [page, setPage] = useState(0);
  const [paused, setPaused] = useState(false);

  // The list can shrink under us (a dept gets submitted, the roster reloads).
  useEffect(() => {
    if (page >= pageCount) setPage(0);
  }, [page, pageCount]);

  // `page` is a dependency on purpose: a manual dot click restarts the dwell so
  // the page the manager just picked gets its full 10s.
  useEffect(() => {
    if (pageCount < 2 || paused) return;
    const id = setTimeout(() => setPage((p) => (p + 1) % pageCount), SCORING_PAGE_MS);
    return () => clearTimeout(id);
  }, [page, pageCount, paused]);

  const safePage = Math.min(page, pageCount - 1);
  // Outstanding departments sort first, so page 1 is always the actual work.
  const rows = items.slice(safePage * SCORING_PAGE_SIZE, (safePage + 1) * SCORING_PAGE_SIZE);
  // Short last page: hold the card's height so the layout doesn't jump on turn.
  const filler = pageCount > 1 ? SCORING_PAGE_SIZE - rows.length : 0;

  return (
    <OverviewPanel
      icon={Sparkles}
      title="Bonuses to score"
      gradient={gradient}
      className={className}
      meta={
        loading ? null : outstanding > 0 ? (
          <span className={cn('shrink-0 rounded-full bg-gradient-to-r px-2 py-0.5 text-[10px] font-bold tabular-nums text-white', gradient)}>
            {outstanding}
          </span>
        ) : items.length > 0 ? (
          <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
            Submitted
          </span>
        ) : null
      }
      action={
        items.length > 0
          ? {
              label: outstanding > 0 ? 'Open KPI Calculator' : 'Review in KPI Calculator',
              onClick: () => onOpenCalculator(),
            }
          : undefined
      }
    >
      {loading ? (
        <div className="space-y-1.5">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-xl border border-zinc-100 px-2.5 py-2 dark:border-zinc-800"
            >
              <div className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="h-2.5 w-1/2 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-2 w-1/4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              </div>
            </div>
          ))}
        </div>
      ) : weekUnresolved ? (
        // The pay week comes from the Hubstaff upload. Without it every status
        // would be read from a period key nothing was saved under, so say so
        // rather than show a list of false to-dos.
        <div className="flex flex-1 flex-col items-center justify-center gap-2 pb-6 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-zinc-300 to-zinc-500 text-white shadow-sm dark:from-zinc-700 dark:to-zinc-800">
            <Clock className="h-5 w-5" />
          </span>
          <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Pay week not open yet</p>
          <p className="max-w-[16rem] text-xs text-zinc-500 dark:text-zinc-500">
            Scoring unlocks once Accounting uploads this week&apos;s Hubstaff hours.
          </p>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 pb-6 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-zinc-300 to-zinc-500 text-white shadow-sm dark:from-zinc-700 dark:to-zinc-800">
            <Sparkles className="h-5 w-5" />
          </span>
          <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">No bonus departments</p>
          <p className="max-w-[16rem] text-xs text-zinc-500 dark:text-zinc-500">
            Ask an admin to assign you a department under Roles &amp; permissions.
          </p>
        </div>
      ) : (
        <div
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocusCapture={() => setPaused(true)}
          onBlurCapture={() => setPaused(false)}
        >
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
              <CalendarDays className="h-3 w-3" />
              {fmtPayWeek(weekStart, weekEnd)}
            </span>
            <span className={cn('font-medium', outstanding > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400')}>
              {outstanding > 0
                ? `${outstanding} of ${items.length} left`
                : 'Everything submitted'}
            </span>
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.ul
              key={safePage}
              className="space-y-1.5"
              initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduceMotion ? 0 : -8 }}
              transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            >
              {rows.map((d) => {
                const chip = SCORING_CHIP[d.state];
                const pending = isOutstanding(d.state);
                return (
                  <li key={`${d.kind}:${d.key}`}>
                    <button
                      type="button"
                      onClick={() => onOpenCalculator({ kind: d.kind, key: d.key })}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition',
                        pending
                          ? 'border-zinc-100 bg-gradient-to-r from-amber-50/70 to-transparent hover:border-amber-200 hover:from-amber-100/70 dark:border-zinc-800 dark:from-amber-950/20 dark:hover:border-amber-900'
                          : 'border-zinc-100 hover:border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:bg-zinc-900/60',
                      )}
                    >
                      <span
                        aria-hidden
                        className="h-6 w-1 shrink-0 rounded-full"
                        style={{ backgroundColor: d.color }}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                          {d.name}
                        </p>
                        <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                          {d.scoredCount > 0 ? (
                            <>
                              {d.scoredCount} scored
                              {d.totalBonus > 0 && (
                                <>
                                  <span className="mx-1 text-zinc-300 dark:text-zinc-700">&middot;</span>
                                  <span className="font-mono">
                                    ₱{d.totalBonus.toLocaleString('en-PH')}
                                  </span>
                                </>
                              )}
                            </>
                          ) : d.state === 'nothing' ? (
                            'Nothing assigned this week'
                          ) : d.state === 'not_due' ? (
                            'Pays on the month’s final week'
                          ) : (
                            'Waiting on your scores'
                          )}
                        </p>
                      </div>
                      <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold', chip.cls)}>
                        {chip.label}
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-zinc-300 dark:text-zinc-600" />
                    </button>
                  </li>
                );
              })}
              {/* Short last page: an invisible clone of a row's box holds the
                  card's height so the layout doesn't jump as pages turn. */}
              {Array.from({ length: filler }).map((_, i) => (
                <li
                  key={`filler-${i}`}
                  aria-hidden
                  className="invisible rounded-xl border px-2.5 py-2"
                >
                  <p className="text-xs font-semibold">&nbsp;</p>
                  <p className="text-[11px]">&nbsp;</p>
                </li>
              ))}
            </motion.ul>
          </AnimatePresence>
          {pageCount > 1 && (
            <div className="mt-2 flex items-center justify-center gap-1.5">
              {Array.from({ length: pageCount }).map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setPage(i)}
                  aria-label={`Show departments ${i * SCORING_PAGE_SIZE + 1}–${Math.min((i + 1) * SCORING_PAGE_SIZE, items.length)} of ${items.length}`}
                  aria-current={i === safePage ? 'true' : undefined}
                  className={cn(
                    'h-1.5 rounded-full transition-all',
                    i === safePage
                      ? cn('w-5 bg-gradient-to-r', gradient)
                      : 'w-1.5 bg-zinc-200 hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600',
                  )}
                />
              ))}
            </div>
          )}
          {error && (
            <p className="mt-1.5 text-center text-[11px] text-amber-700 dark:text-amber-400">{error}</p>
          )}
        </div>
      )}
    </OverviewPanel>
  );
}

// ─── S-Wall tab ──────────────────────────────────────────────────────────────

function ManagerSwallTab({ viewerEmail }: { viewerEmail: string | null }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] dark:bg-[#0d1117]">
        <SWall viewerEmail={viewerEmail} canPost sourceLabel="Manager" />
      </div>
    </div>
  );
}

// ─── Time adjustments tab ───────────────────────────────────────────────────

// ─── Announcements ───────────────────────────────────────────────────────────

function ManagerAnnouncementsTab({
  viewerEmail,
  teamGate,
}: {
  viewerEmail: string | null;
  teamGate: ManagerTeamGate;
}) {
  const departments =
    teamGate.kind === 'department' ? teamGate.departments : [];

  // Wall scope: general + their departments
  const wallScope: 'all' | string[] =
    teamGate.kind === 'elevated' ? 'all' : ['general', ...departments].filter(Boolean);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[#ececec] bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
          Announcements
        </h1>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
          Post to your team or read company-wide updates. New posts appear live.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        <div className="mx-auto max-w-2xl space-y-4">
          <AnnouncementComposer
            authorEmail={viewerEmail ?? ''}
            allowGeneral={teamGate.kind === 'elevated'}
            departments={departments}
            authorLabel={teamGate.kind === 'elevated' ? 'Management' : 'Manager'}
          />
          <AnnouncementWall
            scope={wallScope}
            viewerEmail={viewerEmail}
            isElevated={teamGate.kind === 'elevated'}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Time Adjustment Approvals ──────────────────────────────────────────────

import type { TimeAdjustmentRow } from '@/lib/supabase/time-adjustments';
import { TIME_ADJUSTMENT_REASONS, fmtAdjustmentSegments } from '@/lib/supabase/time-adjustments';

const TA_REASON_LABEL = (code: string) =>
  TIME_ADJUSTMENT_REASONS.find((r) => r.code === code)?.label ?? code;

const TA_STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting your approval',
  awaiting_second_approval: 'Awaiting second approver',
  manager_approved: 'Forwarded to Accounting',
  manager_denied: 'Declined by you',
  approved: 'Approved by Accounting',
  denied: 'Denied by Accounting',
};

const TA_STATUS_DOT: Record<string, string> = {
  // Amber = still owed a decision, matching the "warning, never a control" convention.
  awaiting_second_approval: 'bg-amber-400',
  manager_approved: 'bg-emerald-400',
  manager_denied: 'bg-rose-400',
  approved: 'bg-emerald-500',
  denied: 'bg-rose-400',
};

/** Compact status pill colors for the decided-history rows. */
const TA_STATUS_PILL: Record<string, string> = {
  awaiting_second_approval: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  manager_approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  manager_denied: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300',
  denied: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300',
};

/** A person the manager may name as second approver (GET /api/manager/approver-candidates). */
type ApproverCandidate = { email: string; name: string; department: string };

/**
 * The candidate pool for ONE request. Per-request, not global: since 2026-08-27 the pool
 * is the requesting employee's own team, so a manager of two departments gets a
 * different list per row and the server resolves which from the request id.
 */
type ApproverPool = {
  list: ApproverCandidate[];
  /** The team the list came from — named in the UI so an empty list can say which. */
  department: string | null;
  loading: boolean;
};

const EMPTY_POOL: ApproverPool = { list: [], department: null, loading: true };

/**
 * Rows this viewer still owes a MANAGER decision on. `managedIds` comes from the server
 * (department scope) — a row reaching the viewer only because it names them as second
 * approver must never show the manager's controls.
 */
const taNeedsMyManagerDecision = (r: TimeAdjustmentRow, managedIds?: Set<string>): boolean =>
  r.status === 'pending' &&
  r.manager_decision == null &&
  (managedIds ? managedIds.has(r.id) : true);

/**
 * Rows this viewer still owes a SECOND-APPROVER decision on. Keyed on the assignment,
 * not the status: the second approver may act while the row is still `pending` because
 * the manager has not yet decided.
 */
const taNeedsMySecondDecision = (r: TimeAdjustmentRow, me: string): boolean =>
  !!me &&
  (r.second_approver_email ?? '').trim().toLowerCase() === me &&
  r.second_decision == null &&
  (r.status === 'pending' || r.status === 'awaiting_second_approval');

/** Best available decision timestamp — accounting, else second approver, else manager, else creation. */
const taDecidedAt = (r: TimeAdjustmentRow): string =>
  r.decided_at ?? r.second_decided_at ?? r.manager_decided_at ?? r.updated_at ?? r.created_at ?? '';

function ManagerTimeAdjustments({ onCountChange }: { onCountChange: (n: number) => void }) {
  const [rows, setRows] = useState<TimeAdjustmentRow[]>([]);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [viewerEmail, setViewerEmail] = useState<string>('');
  const [managedIds, setManagedIds] = useState<Set<string>>(new Set());
  const [poolByRow, setPoolByRow] = useState<Record<string, ApproverPool>>({});
  const [approverDraft, setApproverDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [recallingId, setRecallingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<{ urls: string[]; idx: number } | null>(null);

  const fetchRows = React.useCallback(() => {
    setLoading(true);
    fetch('/api/manager/time-adjustments', { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: {
        rows?: TimeAdjustmentRow[];
        signedUrls?: Record<string, string>;
        viewerEmail?: string;
        managedIds?: string[];
      }) => {
        const r = json.rows ?? [];
        const me = (json.viewerEmail ?? '').trim().toLowerCase();
        const managed = new Set(json.managedIds ?? []);
        setRows(r);
        setSignedUrls(json.signedUrls ?? {});
        setViewerEmail(me);
        setManagedIds(managed);
        // The sidebar badge is "things waiting on ME" — both hats. A request naming
        // this person as second approver is as much their queue as one from their team.
        onCountChange(
          r.filter(
            (x) => taNeedsMyManagerDecision(x, managed) || taNeedsMySecondDecision(x, me),
          ).length,
        );
      })
      .catch(() => { setRows([]); setManagedIds(new Set()); onCountChange(0); })
      .finally(() => setLoading(false));
  }, [onCountChange]);

  // Ids the viewer owes a MANAGER decision on — the only rows that render a picker, so
  // the only rows worth a pool fetch. Sorted so the effect key is stable across refetches
  // that return the same set in a different order.
  const pendingIds = useMemo(
    () =>
      rows
        .filter((r) => taNeedsMyManagerDecision(r, managedIds))
        .map((r) => r.id)
        .sort(),
    [rows, managedIds],
  );

  // The pool a manager may name as second approver, fetched PER REQUEST.
  //
  // It used to be one company-wide list fetched once. Since 2026-08-27 the pool is the
  // requesting employee's own team, so it differs row by row for a manager who runs more
  // than one department — and the server resolves the team from the request id rather
  // than trusting a department from here.
  const pendingIdsKey = pendingIds.join(',');
  useEffect(() => {
    if (!pendingIdsKey) return;
    let cancelled = false;
    const ids = pendingIdsKey.split(',');
    // Mark them loading first so the picker says "Loading…" rather than rendering an
    // empty dropdown that reads as "nobody is eligible".
    setPoolByRow((prev) => {
      const next = { ...prev };
      for (const id of ids) if (!next[id]) next[id] = EMPTY_POOL;
      return next;
    });
    void Promise.all(
      ids.map(async (id) => {
        try {
          const res = await fetch(
            `/api/manager/approver-candidates?requestId=${encodeURIComponent(id)}`,
            { cache: 'no-store' },
          );
          const json = (await res.json()) as {
            candidates?: ApproverCandidate[];
            department?: string | null;
          };
          const pool: ApproverPool = {
            list: json.candidates ?? [],
            department: json.department ?? null,
            loading: false,
          };
          return [id, pool] as [string, ApproverPool];
        } catch {
          const pool: ApproverPool = { list: [], department: null, loading: false };
          return [id, pool] as [string, ApproverPool];
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setPoolByRow((prev) => {
        const next = { ...prev };
        for (const [id, pool] of entries) next[id] = pool;
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [pendingIdsKey]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  // Close lightbox on Escape, navigate with arrow keys
  useEffect(() => {
    if (!lightbox) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setLightbox(null); return; }
      if (e.key === 'ArrowRight') setLightbox((lb) => lb && { ...lb, idx: (lb.idx + 1) % lb.urls.length });
      if (e.key === 'ArrowLeft')  setLightbox((lb) => lb && { ...lb, idx: (lb.idx - 1 + lb.urls.length) % lb.urls.length });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightbox]);

  const decide = async (
    id: string,
    action: 'manager_approve' | 'manager_deny' | 'second_approve' | 'second_deny',
  ) => {
    // Approving as the manager carries the chosen second approver in the same call,
    // so the row can never land approved-but-uncountersigned.
    const secondApprover = action === 'manager_approve' ? approverDraft[id] ?? '' : '';
    if (action === 'manager_approve' && !secondApprover) {
      toast.error('Select a second approver first');
      return;
    }
    setDecidingId(id);
    try {
      const res = await fetch(`/api/time-adjustments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          decision_note: notesDraft[id]?.trim() || null,
          ...(secondApprover ? { second_approver_email: secondApprover } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      // A second approval only reaches Accounting if the manager has already signed
      // off; otherwise it is still waiting on them. Say which actually happened.
      const managerAlreadyApproved =
        rows.find((r) => r.id === id)?.manager_decision === 'approved';
      toast.success(
        action === 'manager_approve' ? 'Approved — sent to the second approver'
          : action === 'second_approve'
            ? managerAlreadyApproved
              ? 'Approved — forwarded to Accounting'
              : 'Approved — still awaiting the manager'
            : 'Request declined',
      );
      fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update request');
    } finally {
      setDecidingId(null);
    }
  };

  const recall = async (id: string) => {
    setRecallingId(id);
    try {
      const res = await fetch(`/api/time-adjustments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'recall' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      toast.success('Recalled from Accounting — back in your queue');
      setExpandedId(null);
      fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to recall request');
    } finally {
      setRecallingId(null);
    }
  };

  // Three buckets, because a viewer can wear two hats at once. `pending` is what they
  // owe as the DEPARTMENT MANAGER; `awaitingMe` is what they owe as a NAMED SECOND
  // APPROVER on someone else's team. A row can never be in both — the manager cannot
  // name themselves.
  const pending = rows.filter((r) => taNeedsMyManagerDecision(r, managedIds));
  const awaitingMe = rows.filter((r) => taNeedsMySecondDecision(r, viewerEmail));
  const openIds = new Set([...pending, ...awaitingMe].map((r) => r.id));
  // Everything else: decided, or in flight waiting on somebody who is not this viewer.
  // Note `awaiting_second_approval` lands here when the viewer is the manager who
  // already approved — it is genuinely not their move any more, but it is NOT finished,
  // so the status pill says so and Retrieve stays available.
  const decided = rows
    .filter((r) => !openIds.has(r.id))
    .sort((a, b) => taDecidedAt(b).localeCompare(taDecidedAt(a)));

  return (
    <>
      {/* Image lightbox — AnimatePresence owns both enter and exit */}
      <AnimatePresence>
        {lightbox && (
          <motion.div
            key="mgr-lightbox-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
            onClick={() => setLightbox(null)}
          >
            <motion.div
              key={lightbox.urls[lightbox.idx]}
              initial={{ opacity: 0, scale: 0.9, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 8 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
              className="relative max-h-[88vh] max-w-[90vw]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={lightbox.urls[lightbox.idx]}
                alt="Evidence"
                className="max-h-[88vh] max-w-[90vw] rounded-xl object-contain shadow-2xl"
              />
              <button
                onClick={() => setLightbox(null)}
                className="absolute -right-3 -top-3 flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-md ring-1 ring-white/20 transition hover:bg-white/20"
              >
                <X className="h-4 w-4" />
              </button>
              {lightbox.urls.length > 1 && (
                <>
                  <button
                    onClick={(e) => { e.stopPropagation(); setLightbox((lb) => lb && { ...lb, idx: (lb.idx - 1 + lb.urls.length) % lb.urls.length }); }}
                    className="absolute left-3 top-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-md ring-1 ring-white/20 transition hover:bg-white/20"
                    aria-label="Previous image"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setLightbox((lb) => lb && { ...lb, idx: (lb.idx + 1) % lb.urls.length }); }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-md ring-1 ring-white/20 transition hover:bg-white/20"
                    aria-label="Next image"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                  <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-white backdrop-blur-sm">
                    {lightbox.idx + 1} / {lightbox.urls.length}
                  </span>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {/* Header */}
        <header className="max-w-2xl space-y-1">
          <h2 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-white">
            Time adjustment approvals
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Review your team&apos;s requests. Approve to forward to Accounting, or decline.
            Requests can be from any past date.
          </p>
        </header>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading requests...
          </div>
        ) : pending.length === 0 && awaitingMe.length === 0 && decided.length === 0 ? (
          /* Empty state */
          <div className="max-w-2xl rounded-2xl border border-zinc-200 bg-white px-8 py-14 text-center dark:border-zinc-800 dark:bg-zinc-950">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900">
              <Inbox className="h-5 w-5 text-zinc-400 dark:text-zinc-500" />
            </div>
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">No pending approvals</p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
              Requests from your team will appear here when employees submit a time adjustment.
            </p>
          </div>
        ) : (
          <div className="max-w-2xl space-y-6">
            {pending.length > 0 && (
              <section className="space-y-3">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                  Awaiting your approval &nbsp;&middot;&nbsp; {pending.length}
                </p>
                {pending.map((row) => (
                  <ManagerAdjustmentCard
                    key={row.id}
                    row={row}
                    mode="manager"
                    signedUrls={signedUrls}
                    decidingId={decidingId}
                    note={notesDraft[row.id] ?? ''}
                    onNoteChange={(v) => setNotesDraft((p) => ({ ...p, [row.id]: v }))}
                    pool={poolByRow[row.id] ?? EMPTY_POOL}
                    selectedApprover={approverDraft[row.id] ?? row.second_approver_email ?? ''}
                    onApproverChange={(v) => setApproverDraft((p) => ({ ...p, [row.id]: v }))}
                    onDecide={decide}
                    onImageClick={(urls, idx) => setLightbox({ urls, idx })}
                  />
                ))}
              </section>
            )}

            {awaitingMe.length > 0 && (
              <section className="space-y-3">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                  Awaiting your second approval &nbsp;&middot;&nbsp; {awaitingMe.length}
                </p>
                <p className="-mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                  A manager named you as the second approver on these. They need both
                  signatures before Accounting can act.
                </p>
                {awaitingMe.map((row) => (
                  <ManagerAdjustmentCard
                    key={row.id}
                    row={row}
                    mode="second"
                    signedUrls={signedUrls}
                    decidingId={decidingId}
                    note={notesDraft[row.id] ?? ''}
                    onNoteChange={(v) => setNotesDraft((p) => ({ ...p, [row.id]: v }))}
                    pool={EMPTY_POOL}
                    selectedApprover=""
                    onApproverChange={() => {}}
                    onDecide={decide}
                    onImageClick={(urls, idx) => setLightbox({ urls, idx })}
                  />
                ))}
              </section>
            )}

            {decided.length > 0 && (
              <section className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                  History &nbsp;&middot;&nbsp; {decided.length}
                </p>
                <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                  {decided.map((row, i) => {
                    const decidedOn = taDecidedAt(row).slice(0, 10);
                    const isExpanded = expandedId === row.id;
                    // Recall is the department manager's lever, and it now also rescues a
                    // request parked on a second approver who never acts. The server
                    // enforces the same department scope; hiding it here just avoids
                    // offering a button that would 403.
                    const canRecall =
                      (row.status === 'manager_approved' ||
                        row.status === 'awaiting_second_approval') &&
                      managedIds.has(row.id);
                    const isRecalling = recallingId === row.id;
                    return (
                      <div
                        key={row.id}
                        className={cn(i > 0 && 'border-t border-zinc-100 dark:border-zinc-800/70')}
                      >
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3.5 py-2.5 text-xs">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TA_STATUS_DOT[row.status] ?? 'bg-zinc-300 dark:bg-zinc-600'}`} />
                          <span className="min-w-0 truncate font-medium text-zinc-700 dark:text-zinc-300">{row.work_email}</span>
                          <span className="font-mono text-zinc-400 dark:text-zinc-500">{row.adjust_date}</span>
                          <span className="text-zinc-300 dark:text-zinc-600">&middot;</span>
                          <span className="text-zinc-500 dark:text-zinc-400">{TA_REASON_LABEL(row.reason)}</span>
                          {row.approved_hours != null ? (
                            <span className="font-medium text-zinc-600 dark:text-zinc-300">{row.approved_hours}h</span>
                          ) : row.requested_hours != null ? (
                            <span className="text-zinc-400 dark:text-zinc-500">
                              {(row.requested_segments ?? []).length > 0 ? '+' : ''}
                              {row.requested_hours}h req
                            </span>
                          ) : null}
                          <span className="ml-auto flex shrink-0 items-center gap-1.5">
                            {decidedOn && (
                              <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500">{decidedOn}</span>
                            )}
                            <span
                              className={cn(
                                'rounded px-1.5 py-0.5 text-[10px] font-medium',
                                TA_STATUS_PILL[row.status] ?? 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
                              )}
                            >
                              {TA_STATUS_LABEL[row.status] ?? row.status}
                            </span>
                            {canRecall && (
                              <button
                                type="button"
                                disabled={isRecalling}
                                onClick={() => recall(row.id)}
                                className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-700 transition hover:bg-amber-100 disabled:opacity-40 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20"
                                aria-label="Recall this request from Accounting for a second review"
                              >
                                {isRecalling
                                  ? <Loader2 className="h-3 w-3 animate-spin" />
                                  : <Undo2 className="h-3 w-3" />}
                                Retrieve
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setExpandedId(isExpanded ? null : row.id)}
                              aria-expanded={isExpanded}
                              className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-[10px] font-semibold text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                            >
                              {isExpanded ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                              {isExpanded ? 'Unview' : 'View'}
                              <ChevronDown className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-180')} />
                            </button>
                          </span>
                        </div>

                        <AnimatePresence initial={false}>
                          {isExpanded && (
                            <motion.div
                              key="detail"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                              className="overflow-hidden"
                            >
                              <ManagerHistoryDetail
                                row={row}
                                signedUrls={signedUrls}
                                onImageClick={(urls, idx) => setLightbox({ urls, idx })}
                              />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  );
}

import { ImageOff, Image as ImageIcon } from 'lucide-react';

// Evidence <img> that shows an animated skeleton until the image actually
// decodes. Keyed on `src` so switching the featured image re-shows the
// skeleton instead of flashing the previous photo.
function EvidenceImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      {!loaded && (
        <span aria-hidden className="skeleton-shimmer absolute inset-0 flex flex-col items-center justify-center gap-2">
          <ImageIcon className="h-8 w-8 text-zinc-400/70 dark:text-zinc-600/70" />
          <span className="h-2 w-24 rounded-full bg-zinc-300/70 dark:bg-zinc-700/70" />
          <span className="h-2 w-16 rounded-full bg-zinc-300/60 dark:bg-zinc-700/60" />
        </span>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={src}
        src={src}
        alt={alt}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
        className={cn(className, !loaded && 'opacity-0')}
      />
    </>
  );
}

function ManagerAdjustmentCard({
  row,
  signedUrls,
  decidingId,
  note,
  onNoteChange,
  mode,
  pool,
  selectedApprover,
  onApproverChange,
  onDecide,
  onImageClick,
}: {
  row: TimeAdjustmentRow;
  signedUrls: Record<string, string>;
  decidingId: string | null;
  note: string;
  onNoteChange: (v: string) => void;
  /**
   * Which hat the viewer is wearing on this card. `manager` owns the second-approver
   * picker and forwards the request; `second` countersigns one already routed to them.
   */
  mode: 'manager' | 'second';
  /** Candidate pool for THIS request's team (manager mode only). */
  pool: ApproverPool;
  selectedApprover: string;
  onApproverChange: (v: string) => void;
  onDecide: (
    id: string,
    action: 'manager_approve' | 'manager_deny' | 'second_approve' | 'second_deny',
  ) => void;
  onImageClick: (urls: string[], idx: number) => void;
}) {
  const isDeciding = decidingId === row.id;
  const isManagerMode = mode === 'manager';
  // The team the pool was drawn from, shown so the manager can see WHICH roster the
  // dropdown is offering — and so an empty one names the team it found nobody on.
  const teamLabel = pool.department ? formatDeptLabel(pool.department) : '';
  // Dual approval: the manager cannot forward without naming who countersigns.
  const approveDisabled = isDeciding || (isManagerMode && !selectedApprover);
  const [active, setActive] = useState(0);
  const urls = row.image_paths.map((p) => signedUrls[p]).filter(Boolean) as string[];
  const featured = urls[active] ?? urls[0] ?? null;

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-xl dark:shadow-black/30">
      {/* Top stripe — subtle colored accent */}
      <div className="h-1 w-full bg-gradient-to-r from-blue-500 via-blue-400 to-transparent" />

      <div className="flex flex-col sm:flex-row">
        {/* LEFT — evidence image, the main attraction */}
        <div className="flex shrink-0 flex-col gap-2 p-4 sm:w-[46%] sm:pr-2">
          {featured ? (
            <div className="group relative min-h-[13rem] flex-1 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
              <button
                type="button"
                onClick={() => onImageClick(urls, active)}
                className="absolute inset-0"
                aria-label="View evidence full size"
              >
                <EvidenceImage
                  src={featured}
                  alt={`Evidence ${active + 1}`}
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                />
                <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/25" />
              </button>
              <span className="absolute left-2.5 top-2.5 inline-flex items-center gap-1 rounded-md bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
                <Camera className="h-3 w-3" />
                Proof
              </span>
              {urls.length > 1 && (
                <span className="absolute right-2.5 top-2.5 rounded-md bg-black/55 px-2 py-0.5 text-[10px] font-medium tabular-nums text-white backdrop-blur-sm">
                  {active + 1}/{urls.length}
                </span>
              )}
              <span className="pointer-events-none absolute bottom-2.5 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-white/15 px-3 py-1 text-[10px] font-medium text-white opacity-0 backdrop-blur-md transition-opacity group-hover:opacity-100">
                <Eye className="h-3 w-3" />
                View full size
              </span>
              {urls.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={() => setActive((i) => (i - 1 + urls.length) % urls.length)}
                    className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1 text-white backdrop-blur-sm transition hover:bg-black/70"
                    aria-label="Previous image"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setActive((i) => (i + 1) % urls.length)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1 text-white backdrop-blur-sm transition hover:bg-black/70"
                    aria-label="Next image"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="flex min-h-[13rem] flex-1 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-600">
              <ImageOff className="h-7 w-7" />
              <span className="text-[11px] font-medium">No evidence images attached</span>
            </div>
          )}

          {/* Thumbnail strip — switch the featured image */}
          {urls.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto">
              {urls.map((u, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActive(i)}
                  className={cn(
                    'relative h-11 w-14 shrink-0 overflow-hidden rounded-lg border-2 transition',
                    i === active
                      ? 'border-blue-500 ring-2 ring-blue-500/20'
                      : 'border-transparent opacity-60 hover:opacity-100',
                  )}
                  aria-label={`Show evidence image ${i + 1}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u} alt={`Evidence ${i + 1}`} className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* RIGHT — details + actions */}
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 sm:p-5">
          {/* Header row */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-zinc-900 dark:text-white">{row.work_email}</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">{row.adjust_date}</span>
                <span aria-hidden>&middot;</span>
                <span className="rounded bg-blue-50 px-1.5 py-0.5 font-medium text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">
                  {TA_REASON_LABEL(row.reason)}
                </span>
                {row.requested_hours != null && (
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    {(row.requested_segments ?? []).length > 0 ? '+' : ''}
                    {row.requested_hours}h requested
                  </span>
                )}
                {(row.requested_segments ?? []).length > 0 && (
                  <span className="font-mono text-zinc-600 dark:text-zinc-400">
                    {fmtAdjustmentSegments(row.requested_segments)}
                  </span>
                )}
              </p>
            </div>
            {row.period_label && (
              <span className="shrink-0 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                {row.period_label}
              </span>
            )}
          </div>

          {/* Explanation */}
          {row.explanation && (
            <p className="rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 py-2.5 text-xs leading-relaxed text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              {row.explanation}
            </p>
          )}

          {/* Second approver — the manager picks who countersigns. */}
          {isManagerMode ? (
            <div className="space-y-1.5">
              <label
                htmlFor={`second-approver-${row.id}`}
                className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500"
              >
                Second approver{' '}
                <span className="normal-case font-normal">
                  (required to approve){teamLabel ? ` — ${teamLabel}` : ''}
                </span>
              </label>
              <select
                id={`second-approver-${row.id}`}
                value={selectedApprover}
                onChange={(e) => onApproverChange(e.target.value)}
                className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-xs text-zinc-900 transition-colors focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              >
                <option value="">Select who else must approve…</option>
                {pool.list.map((c) => (
                  <option key={c.email} value={c.email}>
                    {c.name}
                  </option>
                ))}
              </select>
              {pool.loading ? (
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Loading the team…</p>
              ) : pool.list.length === 0 ? (
                // An empty pool means the team has nobody else on it — not that somebody
                // needs provisioning. Since 2026-08-27 no grant is required to be named,
                // so the old "ask an admin" copy would send the manager on a dead errand.
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                  Nobody else is active on
                  {teamLabel ? ` ${teamLabel}` : ' this team'}, so there is no one to
                  countersign. Ask HR to confirm the roster.
                </p>
              ) : (
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  Anyone active on{teamLabel ? ` ${teamLabel}` : ' this team'}. Both of you
                  must approve before Accounting sees this. They will review it from their
                  own employee portal — this grants them nothing else.
                </p>
              )}
            </div>
          ) : (
            <p className="rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-[11px] text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200">
              {row.second_approver_assigned_by
                ? `${row.second_approver_assigned_by} asked you to countersign this.`
                : 'You were named as the second approver on this request.'}
              {row.manager_decision === 'approved'
                ? ' The manager has approved — yours is the last signature before Accounting.'
                : ' The manager has not decided yet; it still needs their approval too.'}
            </p>
          )}

          {/* Note input */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              Note for employee <span className="normal-case font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              placeholder="e.g. Confirmed with project logs"
              className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-xs text-zinc-900 placeholder:text-zinc-400 transition-colors focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600"
            />
          </div>

          {/* Actions */}
          <div className="mt-auto flex gap-2 pt-1">
            <button
              type="button"
              disabled={approveDisabled}
              title={
                isManagerMode && !selectedApprover
                  ? 'Select a second approver first'
                  : undefined
              }
              onClick={() =>
                onDecide(row.id, isManagerMode ? 'manager_approve' : 'second_approve')
              }
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-40"
            >
              {isDeciding
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <CheckCircle2 className="h-3.5 w-3.5" />}
              {isManagerMode ? 'Approve & send to second approver' : 'Approve'}
            </button>
            <button
              type="button"
              disabled={isDeciding}
              onClick={() =>
                onDecide(row.id, isManagerMode ? 'manager_deny' : 'second_deny')
              }
              className="flex items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-600 transition hover:bg-rose-100 disabled:opacity-40 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400 dark:hover:bg-rose-500/20"
            >
              Decline
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Read-only expanded detail for a decided/forwarded history row. Mirrors the
 * awaiting-approval card layout (evidence + explanation) minus the action
 * controls, and adds the manager + accounting decision trail.
 */
function ManagerHistoryDetail({
  row,
  signedUrls,
  onImageClick,
}: {
  row: TimeAdjustmentRow;
  signedUrls: Record<string, string>;
  onImageClick: (urls: string[], idx: number) => void;
}) {
  const [active, setActive] = useState(0);
  const urls = row.image_paths.map((p) => signedUrls[p]).filter(Boolean) as string[];
  const featured = urls[active] ?? urls[0] ?? null;

  return (
    <div className="flex flex-col gap-4 border-t border-zinc-100 bg-zinc-50/60 px-3.5 py-4 dark:border-zinc-800/70 dark:bg-zinc-900/40 sm:flex-row">
      {/* LEFT — evidence */}
      <div className="flex shrink-0 flex-col gap-2 sm:w-[40%]">
        {featured ? (
          <div className="group relative min-h-[11rem] flex-1 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
            <button
              type="button"
              onClick={() => onImageClick(urls, active)}
              className="absolute inset-0"
              aria-label="View evidence full size"
            >
              <EvidenceImage
                src={featured}
                alt={`Evidence ${active + 1}`}
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
              />
              <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/25" />
            </button>
            <span className="absolute left-2.5 top-2.5 inline-flex items-center gap-1 rounded-md bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
              <Camera className="h-3 w-3" />
              Proof
            </span>
            {urls.length > 1 && (
              <span className="absolute right-2.5 top-2.5 rounded-md bg-black/55 px-2 py-0.5 text-[10px] font-medium tabular-nums text-white backdrop-blur-sm">
                {active + 1}/{urls.length}
              </span>
            )}
            {urls.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => setActive((i) => (i - 1 + urls.length) % urls.length)}
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1 text-white backdrop-blur-sm transition hover:bg-black/70"
                  aria-label="Previous image"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setActive((i) => (i + 1) % urls.length)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1 text-white backdrop-blur-sm transition hover:bg-black/70"
                  aria-label="Next image"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="flex min-h-[11rem] flex-1 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-600">
            <ImageOff className="h-7 w-7" />
            <span className="text-[11px] font-medium">No evidence images attached</span>
          </div>
        )}

        {urls.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto">
            {urls.map((u, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setActive(i)}
                className={cn(
                  'relative h-10 w-12 shrink-0 overflow-hidden rounded-lg border-2 transition',
                  i === active
                    ? 'border-blue-500 ring-2 ring-blue-500/20'
                    : 'border-transparent opacity-60 hover:opacity-100',
                )}
                aria-label={`Show evidence image ${i + 1}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u} alt={`Evidence ${i + 1}`} className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* RIGHT — details */}
      <div className="flex min-w-0 flex-1 flex-col gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded bg-blue-50 px-1.5 py-0.5 font-medium text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">
            {TA_REASON_LABEL(row.reason)}
          </span>
          {row.requested_hours != null && (
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              {(row.requested_segments ?? []).length > 0 ? '+' : ''}
              {row.requested_hours}h requested
            </span>
          )}
          {(row.requested_segments ?? []).length > 0 && (
            <span className="font-mono text-zinc-600 dark:text-zinc-400">
              {fmtAdjustmentSegments(row.requested_segments)}
            </span>
          )}
          {row.approved_hours != null && (
            <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
              {row.approved_hours}h approved
            </span>
          )}
          {row.period_label && (
            <span className="rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
              {row.period_label}
            </span>
          )}
        </div>

        {row.explanation && (
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              Employee explanation
            </p>
            <p className="rounded-xl border border-zinc-200 bg-white px-3 py-2 leading-relaxed text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
              {row.explanation}
            </p>
          </div>
        )}

        {(row.manager_decided_by || row.manager_decision_note) && (
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              Manager decision
            </p>
            <p className="leading-relaxed text-zinc-600 dark:text-zinc-400">
              {row.manager_decided_by && <span className="font-medium text-zinc-700 dark:text-zinc-300">{row.manager_decided_by}</span>}
              {row.manager_decided_at && (
                <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500"> &middot; {row.manager_decided_at.slice(0, 10)}</span>
              )}
              {row.manager_decision_note && <span className="block italic text-zinc-500 dark:text-zinc-400">&ldquo;{row.manager_decision_note}&rdquo;</span>}
            </p>
          </div>
        )}

        {/* Second approver — shown once someone is named, even before they decide, so
            a request parked in awaiting_second_approval says WHO it is parked on. */}
        {row.second_approver_email && (
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              Second approver
            </p>
            <p className="leading-relaxed text-zinc-600 dark:text-zinc-400">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">{row.second_approver_email}</span>
              {row.second_decided_at && (
                <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500"> &middot; {row.second_decided_at.slice(0, 10)}</span>
              )}
              <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                {row.second_decision === 'approved' ? 'Approved'
                  : row.second_decision === 'denied' ? 'Declined'
                  : 'Has not decided yet'}
                {row.second_approver_assigned_by ? ` · named by ${row.second_approver_assigned_by}` : ''}
              </span>
              {row.second_decision_note && <span className="block italic text-zinc-500 dark:text-zinc-400">&ldquo;{row.second_decision_note}&rdquo;</span>}
            </p>
          </div>
        )}

        {(row.decided_by || row.decision_note) && (
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              Accounting decision
            </p>
            <p className="leading-relaxed text-zinc-600 dark:text-zinc-400">
              {row.decided_by && <span className="font-medium text-zinc-700 dark:text-zinc-300">{row.decided_by}</span>}
              {row.decided_at && (
                <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500"> &middot; {row.decided_at.slice(0, 10)}</span>
              )}
              {row.decision_note && <span className="block italic text-zinc-500 dark:text-zinc-400">&ldquo;{row.decision_note}&rdquo;</span>}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Team tab ───────────────────────────────────────────────────────────────

interface TeamPanelProps {
  members: EmployeeRow[];
  teamGate: ManagerTeamGate;
  viewerEmail: string | null;
  /** When set, open this employee's profile dialog on mount (deep-link from
   *  the Overview spotlight). Cleared via `onFocusConsumed` once opened. */
  focusEmail?: string | null;
  onFocusConsumed?: () => void;
}

/** Shared-profile fields shown on roster cards + the member dialog. */
interface TeamSkillSet {
  role_title: string;
  currently_working_on: string;
  skills: string;
  strengths: string;
  member_notes: string;
  projects: string[];
  current_projects: string[];
}

const TEAM_PAGE_SIZE = 8;
const TEAM_LIST_PAGE_SIZE = 20;

/** Escape one CSV cell (RFC 4180): quote when it holds a comma, quote or newline. */
function csvCell(v: string | null | undefined): string {
  const s = v ?? '';
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Trigger a browser download of `blob` as `filename`. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Columns for the roster CSV export — mirrors the list view plus the identifying
 *  emails and start date that the compact table hides. */
const ROSTER_EXPORT_HEADERS = [
  'Name',
  'Employee ID',
  'Department',
  'Title',
  'Work Email',
  'Personal Email',
  'CallTools Username',
  'Start Date',
  'Status',
] as const;

/**
 * Inline-editable CallTools dialer username, shown in the roster list for Lead
 * Gen members. Reads the current value (from the onboarding submission or the
 * manual store, resolved server-side); on edit it PATCHes the per-employee store
 * (`/api/manager/calltools-username`) so existing staff can be backfilled right
 * from the roster. Empty saves clear the manual entry.
 */
function CallToolsUsernameCell({
  member,
  value,
  onSaved,
}: {
  member: EmployeeRow;
  value: string | null;
  onSaved: (username: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const keyEmail = member.work_email ?? member.personal_email ?? null;

  useEffect(() => {
    if (!editing) return;
    setDraft(value ?? '');
    const t = window.setTimeout(() => inputRef.current?.select(), 0);
    return () => window.clearTimeout(t);
    // Only re-seed the draft when we ENTER edit mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const save = async () => {
    if (savingRef.current) return;
    const next = draft.trim();
    if (next === (value ?? '')) {
      setEditing(false);
      return;
    }
    if (!keyEmail) {
      toast.error('This person has no email on file to attach a username to.');
      setEditing(false);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const res = await fetch('/api/manager/calltools-username', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: keyEmail, username: next, name: member.name ?? undefined }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j?.error || 'Save failed');
      onSaved(next || null);
      setEditing(false);
      toast.success(next ? 'CallTools username saved' : 'CallTools username cleared');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="group/ct inline-flex items-center gap-1.5 text-left"
        title={value ? `${value} — click to edit` : 'Add CallTools username'}
      >
        {value ? (
          <span className="font-mono text-xs text-zinc-700 dark:text-zinc-200">{value}</span>
        ) : (
          <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            Needs backfill
          </span>
        )}
        <Pencil
          className="h-3 w-3 shrink-0 text-zinc-300 opacity-0 transition group-hover/ct:opacity-100 dark:text-zinc-600"
          aria-hidden
        />
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        ref={inputRef}
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(false);
          }
        }}
        onBlur={() => {
          if (!savingRef.current) void save();
        }}
        placeholder="e.g. Mikey J. T."
        aria-label={`CallTools username for ${member.name ?? keyEmail ?? 'member'}`}
        className="w-36 rounded-md border border-blue-300 bg-white px-1.5 py-0.5 font-mono text-xs text-zinc-800 shadow-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-400 dark:border-blue-700 dark:bg-zinc-950 dark:text-zinc-100"
      />
      {saving ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" aria-hidden />
      ) : (
        <>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void save()}
            className="text-emerald-600 hover:text-emerald-700"
            title="Save"
            aria-label="Save CallTools username"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEditing(false)}
            className="text-zinc-400 hover:text-zinc-600"
            title="Cancel"
            aria-label="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </span>
  );
}

function TeamPanelInner({ members, teamGate, viewerEmail, focusEmail, onFocusConsumed }: TeamPanelProps) {
  const { medals, draggedMedal, dragOverEmail, setDragOverEmail, openAwardForDrop } = useMedalCtx();

  // Inner tab toggle: Roster (existing) | New Hire Check List (HR pending hires
  // routed here by department_managers) | Orientation (the weekly attendance
  // tally + its PDF).
  //
  // All three live inside the My Team panel rather than claiming top-level
  // sidebar slots — which also means they inherit the `manager`/`team` feature
  // permission. A new top-level tab would be a NEW feature key, and a missing
  // grant is hidden by default (docs/features/rbac-feature-permissions.md), so
  // nobody but an admin would see it until it was granted person by person.
  const [innerTab, setInnerTab] = useState<'roster' | 'newly-hired' | 'orientation'>('roster');
  const unassigned = teamGate.kind === 'department' && teamGate.departments.length === 0;
  const scoped = teamGate.kind === 'department' && teamGate.departments.length > 0;
  // Live presence — drives the green "online" dots on roster rows and the
  // "Active now" panel. Sourced from the app-wide PresenceProvider so it
  // reflects everyone signed in to the HRIS, same as the employee My Team tab.
  const onlineEmails = useOnlineEmails();
  const isMemberOnline = (m: EmployeeRow): boolean => {
    const w = normEmail(m.work_email ?? '');
    const p = normEmail(m.personal_email ?? '');
    return (!!w && onlineEmails.has(w)) || (!!p && onlineEmails.has(p));
  };
  const [selectedMember, setSelectedMember] = useState<EmployeeRow | null>(null);

  // Deep-link: open a specific employee's profile when the Overview spotlight
  // requested it, then clear the request so normal navigation doesn't reopen it.
  useEffect(() => {
    if (!focusEmail) return;
    const f = normEmail(focusEmail);
    const target = members.find((m) => {
      const w = normEmail(m.work_email ?? '');
      const p = normEmail(m.personal_email ?? '');
      return (!!w && w === f) || (!!p && p === f);
    });
    if (target) setSelectedMember(target);
    onFocusConsumed?.();
  }, [focusEmail, members, onFocusConsumed]);
  const [page, setPage] = useState(1);
  const [deptFilter, setDeptFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [medalOpen, setMedalOpen] = useState(false);

  // ── Offboarding multi-select (list view) ──
  // Roster can be shown as cards (default) or a compact list. In list mode the
  // manager can tick people and send them to HR's offboarding queue. Selection
  // is keyed by a stable per-person key so it SURVIVES search/filter/paging —
  // ticked people stay ticked even when filtered out of view.
  const [viewMode, setViewMode] = useState<'cards' | 'list'>('cards');
  // Inline CallTools-username edits, keyed by memberKey, so a just-saved value
  // shows immediately without refetching the whole roster. `null` = cleared.
  const [callToolsOverrides, setCallToolsOverrides] = useState<Record<string, string | null>>({});
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [offboardOpen, setOffboardOpen] = useState(false);

  // ── Suspend / Reactivation (list view, per-row) ──
  // The manager-facing temporary-pause pair (the temp-pause reason is disabled
  // in the offboard modal — these buttons replace it), via
  // /api/manager/temp-pause: "Suspend" rides the offboarding-deactivate flow
  // with the HR temp-pause envelope and DISABLES the Workspace account;
  // "Reactivation" fires the reactivate-temp-pause flow to re-enable it.
  // Nothing is deleted and no offboard stamps are written, so there's no DB
  // flag to read back — the session-only set below just flips the clicked
  // row's buttons.
  const [tempPauseTarget, setTempPauseTarget] = useState<{
    member: EmployeeRow;
    action: 'suspend' | 'reactivate';
  } | null>(null);
  const [tempPauseSaving, setTempPauseSaving] = useState(false);
  const [suspendedKeys, setSuspendedKeys] = useState<Set<string>>(new Set());
  // The manager's own outbox → per-email offboarding status for the badges,
  // plus the HR note for a returned request (shown as a tooltip on the badge).
  const [offboardStatus, setOffboardStatus] = useState<Record<string, OffboardingQueueStatus>>({});
  const [offboardNote, setOffboardNote] = useState<Record<string, string>>({});

  const memberKey = (m: EmployeeRow): string =>
    (m.work_email ?? m.personal_email ?? m.name ?? '').trim().toLowerCase();

  // Effective CallTools username = inline-edit override (if any) else the value
  // decorated onto the row by /api/manager/department-members.
  const callToolsValue = (m: EmployeeRow): string | null => {
    const k = memberKey(m);
    return k in callToolsOverrides ? callToolsOverrides[k] : m.calltools_username ?? null;
  };

  // Most-relevant status wins if a person appears under more than one email.
  const STATUS_RANK: Record<OffboardingQueueStatus, number> = useMemo(
    () => ({ processing: 6, pending: 5, returned: 4, completed: 3, dismissed: 2, cancelled: 1 }),
    [],
  );
  const loadOffboardOutbox = React.useCallback(() => {
    fetch('/api/offboarding-queue', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((j: { rows?: Array<{ employee_email: string | null; employee_work_email: string | null; employee_personal_email: string | null; status: OffboardingQueueStatus; processed_note: string | null }> }) => {
        const map: Record<string, OffboardingQueueStatus> = {};
        const notes: Record<string, string> = {};
        for (const row of j.rows ?? []) {
          for (const e of [row.employee_email, row.employee_work_email, row.employee_personal_email]) {
            const k = normEmail(e ?? '') ?? '';
            if (!k) continue;
            const prev = map[k];
            if (!prev || STATUS_RANK[row.status] > STATUS_RANK[prev]) {
              map[k] = row.status;
              if (row.status === 'returned' && row.processed_note) notes[k] = row.processed_note;
              else delete notes[k];
            }
          }
        }
        setOffboardStatus(map);
        setOffboardNote(notes);
      })
      .catch(() => {
        /* non-fatal — badges just won't show */
      });
  }, [STATUS_RANK]);
  useEffect(() => {
    loadOffboardOutbox();
  }, [loadOffboardOutbox]);

  const memberReturnNote = (m: EmployeeRow): string | null => {
    const w = normEmail(m.work_email ?? '') ?? '';
    const p = normEmail(m.personal_email ?? '') ?? '';
    return (w && offboardNote[w]) || (p && offboardNote[p]) || null;
  };

  // ── Resignations (employee-initiated) ──
  // A pending resignation floats its person to the TOP of the roster (cards +
  // list) with the person's message shown inline; the manager approves (→ the
  // person is queued for offboarding, reason "resigned") or declines right here.
  const [resignations, setResignations] = useState<Record<string, ResignationRequestRow>>({});
  const [resignDecision, setResignDecision] = useState<{
    row: ResignationRequestRow;
    action: 'approve' | 'reject';
  } | null>(null);
  const [resignNote, setResignNote] = useState('');
  const [resignSaving, setResignSaving] = useState(false);

  const loadResignations = React.useCallback(() => {
    fetch('/api/resignation-requests?scope=all', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((j: { rows?: ResignationRequestRow[] }) => {
        const map: Record<string, ResignationRequestRow> = {};
        for (const row of j.rows ?? []) {
          if (row.status !== 'pending') continue;
          for (const e of [row.employee_work_email, row.employee_personal_email, row.employee_email]) {
            const k = normEmail(e ?? '') ?? '';
            if (k && !map[k]) map[k] = row;
          }
        }
        setResignations(map);
      })
      .catch(() => {
        /* non-fatal — the roster just won't float resigning people */
      });
  }, []);
  useEffect(() => {
    loadResignations();
  }, [loadResignations]);

  const memberResignation = (m: EmployeeRow): ResignationRequestRow | null => {
    const w = normEmail(m.work_email ?? '') ?? '';
    const p = normEmail(m.personal_email ?? '') ?? '';
    return (w && resignations[w]) || (p && resignations[p]) || null;
  };

  const openResignDecision = (row: ResignationRequestRow, action: 'approve' | 'reject') => {
    setResignNote('');
    setResignDecision({ row, action });
  };

  const submitResignDecision = async () => {
    if (!resignDecision) return;
    const { row, action } = resignDecision;
    if (action === 'reject' && !resignNote.trim()) {
      toast.error('Add a reason for declining.');
      return;
    }
    setResignSaving(true);
    try {
      const res = await fetch(`/api/resignation-requests/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, note: resignNote.trim() || null }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || 'Failed');
      toast.success(
        action === 'approve'
          ? 'Resignation approved — queued for offboarding'
          : 'Resignation declined',
      );
      setResignDecision(null);
      setResignNote('');
      loadResignations();
      // Approval created an offboarding-queue entry → refresh the queue badges.
      loadOffboardOutbox();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to record decision');
    } finally {
      setResignSaving(false);
    }
  };

  const submitTempPause = async () => {
    if (!tempPauseTarget || tempPauseSaving) return;
    const { member, action } = tempPauseTarget;
    const email = member.work_email ?? member.personal_email;
    if (!email) {
      toast.error('No email on file for this person.');
      return;
    }
    setTempPauseSaving(true);
    try {
      const res = await fetch('/api/manager/temp-pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, action }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || `Failed to ${action}`);
      const k = memberKey(member);
      setSuspendedKeys((prev) => {
        const next = new Set(prev);
        if (action === 'suspend') next.add(k);
        else next.delete(k);
        return next;
      });
      toast.success(
        action === 'suspend'
          ? `${member.name ?? email} suspended — account disabled, nothing deleted`
          : `${member.name ?? email} reactivated — account re-enabled`,
      );
      setTempPauseTarget(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Failed to ${action}`);
    } finally {
      setTempPauseSaving(false);
    }
  };

  const fmtEffective = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  };

  // Active (in-flight) status for a member, checking both of their emails.
  const memberOffboardStatus = (m: EmployeeRow): OffboardingQueueStatus | null => {
    const w = normEmail(m.work_email ?? '') ?? '';
    const p = normEmail(m.personal_email ?? '') ?? '';
    const s = (w && offboardStatus[w]) || (p && offboardStatus[p]) || null;
    return (s as OffboardingQueueStatus) || null;
  };
  // Already-queued (pending/processing) people can't be re-selected.
  const isMemberLocked = (m: EmployeeRow): boolean => {
    const s = memberOffboardStatus(m);
    return s === 'pending' || s === 'processing';
  };
  const toggleSelected = (m: EmployeeRow) => {
    if (isMemberLocked(m)) return;
    const k = memberKey(m);
    if (!k) return;
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  // Row-level "Offboard" button — same flow as the multi-select: the person is
  // added to the shared selection (their checkbox ticks) and the queue dialog
  // opens over the whole selection, so ticked people + this row go out as one
  // submission and onSubmitted/clearSelection behave exactly as before.
  const openOffboardFor = (m: EmployeeRow) => {
    if (isMemberLocked(m)) return;
    const k = memberKey(m);
    if (!k) return;
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      next.add(k);
      return next;
    });
    setOffboardOpen(true);
  };

  // Skill sets (role / currently-working-on / manager notes) for the team —
  // bulk-fetched so the roster cards and the member dialog can show the same
  // shared-profile data the employee My Team view renders. Keyed by normalized
  // work email.
  const [skillSets, setSkillSets] = useState<Record<string, TeamSkillSet>>({});
  const teamWorkEmails = useMemo(
    () => members.map((m) => normEmail(m.work_email ?? '') ?? '').filter(Boolean),
    [members],
  );
  const teamWorkEmailsKey = teamWorkEmails.join(',');
  useEffect(() => {
    if (!teamWorkEmailsKey) {
      setSkillSets({});
      return;
    }
    let cancelled = false;
    fetch(`/api/employee-skill-sets?emails=${encodeURIComponent(teamWorkEmailsKey)}`, {
      cache: 'no-store',
    })
      .then((r) => r.json())
      .then((j: { rows?: (TeamSkillSet & { work_email: string })[] }) => {
        if (cancelled) return;
        const map: Record<string, TeamSkillSet> = {};
        for (const row of j.rows ?? []) {
          const k = normEmail(row.work_email ?? '') ?? '';
          if (k) map[k] = row;
        }
        setSkillSets(map);
      })
      .catch(() => {
        /* non-fatal — cards just render without skill-set detail */
      });
    return () => {
      cancelled = true;
    };
  }, [teamWorkEmailsKey]);

  // Last-seen timestamps so offline members read "Last seen 5m ago" rather than
  // a bare dot — mirrors the employee My Team poll.
  const [lastSeen, setLastSeen] = useState<Record<string, string>>({});
  const teamAllEmails = useMemo(
    () =>
      members
        .flatMap((m) => [normEmail(m.work_email ?? '') ?? '', normEmail(m.personal_email ?? '') ?? ''])
        .filter(Boolean),
    [members],
  );
  const teamAllEmailsKey = teamAllEmails.join(',');
  useEffect(() => {
    if (!teamAllEmailsKey) return;
    let cancelled = false;
    const load = () =>
      fetch(`/api/presence/last-seen?emails=${encodeURIComponent(teamAllEmailsKey)}`, {
        cache: 'no-store',
      })
        .then((r) => r.json())
        .then((j: { lastSeen?: Record<string, string> }) => {
          if (!cancelled) setLastSeen(j.lastSeen ?? {});
        })
        .catch(() => {
          /* non-fatal */
        });
    load();
    const interval = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [teamAllEmailsKey]);

  const skillSetFor = (m: EmployeeRow): TeamSkillSet | undefined => {
    const w = normEmail(m.work_email ?? '');
    return w ? skillSets[w] : undefined;
  };
  const lastSeenFor = (m: EmployeeRow): string | null => {
    const w = normEmail(m.work_email ?? '');
    const p = normEmail(m.personal_email ?? '');
    return (w && lastSeen[w]) || (p && lastSeen[p]) || null;
  };

  // Unique department list for the filter dropdown — sorted, blanks stripped.
  const deptOptions = useMemo(() => {
    const set = new Set<string>();
    for (const m of members) {
      const d = (m.department ?? '').trim();
      if (d) set.add(d);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [members]);

  const filteredMembers = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return members.filter((m) => {
      const departmentMatches =
        deptFilter === 'all' ||
        (m.department ?? '').trim().toLowerCase() === deptFilter.toLowerCase();

      if (!departmentMatches) return false;
      if (!normalizedQuery) return true;

      const searchable = [
        m.name,
        m.department,
        m.hsl_role,
        m.work_email,
        m.personal_email,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return searchable.includes(normalizedQuery);
    });
  }, [members, deptFilter, searchQuery]);

  // The list view gains a "CallTools Username" column whenever the visible
  // roster includes a Lead Gen member — the dialer username is Lead-Gen-only, so
  // teams without one never see an all-blank column. Recent hires carry a stored
  // username; older Lead Gen hires read as "needs backfill" for HR to fill in.
  const showCallToolsCol = useMemo(
    () => filteredMembers.some((m) => isLeadGenDepartment(m.department)),
    [filteredMembers],
  );

  // Plain-text status for the CSV, mirroring the badge shown on each roster row:
  // a pending resignation wins over an in-flight offboarding, else the queue
  // status, else "Active".
  const exportStatusLabel = (m: EmployeeRow): string => {
    if (memberResignation(m)) return 'Resigning';
    switch (memberOffboardStatus(m)) {
      case 'pending':
        return 'Queued';
      case 'returned':
        return 'Returned';
      case 'processing':
        return 'Processing';
      case 'completed':
        return 'Offboarded';
      case 'dismissed':
        return 'Dismissed';
      default:
        return 'Active';
    }
  };

  // Export the CURRENTLY shown roster (respects the search + department filter,
  // both Cards and List views) as a CSV. A UTF-8 BOM keeps Excel from mangling
  // non-ASCII names.
  const exportRosterCsv = () => {
    if (filteredMembers.length === 0) return;
    const lines = [ROSTER_EXPORT_HEADERS.map(csvCell).join(',')];
    for (const m of filteredMembers) {
      const title = skillSetFor(m)?.role_title?.trim() || m.hsl_role?.trim() || '';
      const callTools = isLeadGenDepartment(m.department) ? callToolsValue(m) : '';
      lines.push(
        [
          m.name,
          m.employee_id,
          m.department,
          title,
          m.work_email,
          m.personal_email,
          callTools,
          m.start_date,
          exportStatusLabel(m),
        ]
          .map(csvCell)
          .join(','),
      );
    }
    const csv = '﻿' + lines.join('\r\n');
    const scope =
      deptFilter !== 'all'
        ? deptFilter.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
        : 'all';
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
      `team-roster-${scope}-${stamp}.csv`,
    );
  };

  // The list view renders far more per row than a card, and an unpaginated
  // roster of hundreds of rows is what made it laggy — so both views paginate,
  // list at 20/page (denser) and cards at 8.
  // Float anyone with a pending resignation to the TOP of the roster (stable
  // sort keeps the rest in place), so the person the manager must action leads
  // the list in both card and list views — then paginate the sorted result.
  const sortedMembers = useMemo(() => {
    const hasResig = (m: EmployeeRow) => (memberResignation(m) ? 0 : 1);
    return [...filteredMembers].sort((a, b) => hasResig(a) - hasResig(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredMembers, resignations]);

  const pageSize = viewMode === 'list' ? TEAM_LIST_PAGE_SIZE : TEAM_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(filteredMembers.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, filteredMembers.length);
  const pageSlice = sortedMembers.slice(pageStart, pageEnd);

  // Selected people resolved back to rows (from the FULL roster, so a selection
  // survives filtering + paging) — feeds the offboarding dialog + selection bar.
  const selectedMembers = useMemo(
    () => members.filter((m) => selectedKeys.has(memberKey(m))),
    // memberKey is stable; recompute when the roster or selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [members, selectedKeys],
  );
  // Select-all is scoped to the CURRENT PAGE's selectable rows (not the whole
  // filtered set) so it stays intuitive with pagination; per-page selections
  // still accumulate + persist across pages via selectedKeys.
  const selectablePage = useMemo(
    () => pageSlice.filter((m) => !isMemberLocked(m)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pageSlice, offboardStatus],
  );
  const allPageSelected =
    selectablePage.length > 0 && selectablePage.every((m) => selectedKeys.has(memberKey(m)));
  const somePageSelected = selectablePage.some((m) => selectedKeys.has(memberKey(m)));
  const toggleSelectAllPage = () => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        for (const m of selectablePage) next.delete(memberKey(m));
      } else {
        for (const m of selectablePage) next.add(memberKey(m));
      }
      return next;
    });
  };
  const clearSelection = () => setSelectedKeys(new Set());

  // Snap back to page 1 when the roster changes (filter/refresh shrinks it under
  // the current page) or the view toggles (page sizes differ). Cheap; no memo.
  useEffect(() => {
    setPage(1);
  }, [filteredMembers.length, teamGate.kind, viewMode]);

  // Snap filter back to "all" if the active selection is no longer in the list.
  useEffect(() => {
    if (deptFilter !== 'all' && !deptOptions.some((d) => d.toLowerCase() === deptFilter.toLowerCase())) {
      setDeptFilter('all');
    }
  }, [deptOptions, deptFilter]);

  if (teamGate.kind === 'loading') {
    return (
      <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <header className="flex flex-col gap-1">
          <h2 className="bg-gradient-to-r from-blue-700 via-zinc-900 to-zinc-900 bg-clip-text text-xl font-bold tracking-tight text-transparent dark:from-blue-400 dark:via-white dark:to-white">
            My team
          </h2>
        </header>
        <Card className="border-blue-100/70 bg-gradient-to-br from-white to-blue-50/40 ring-1 ring-blue-500/10 dark:border-blue-950/50 dark:from-zinc-950 dark:to-blue-950/15 dark:ring-blue-400/10">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading roster…</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (teamGate.kind === 'error') {
    return (
      <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <header className="flex flex-col gap-1">
          <h2 className="bg-gradient-to-r from-blue-700 via-zinc-900 to-zinc-900 bg-clip-text text-xl font-bold tracking-tight text-transparent dark:from-blue-400 dark:via-white dark:to-white">
            My team
          </h2>
        </header>
        <Card className="border-rose-100/80 bg-gradient-to-br from-white to-rose-50/40 ring-1 ring-rose-500/10 dark:border-rose-950/50 dark:from-zinc-950 dark:to-rose-950/15">
          <CardContent className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-rose-500 to-rose-700 text-white shadow-md">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Could not load roster</p>
            <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">{teamGate.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="bg-gradient-to-r from-blue-700 via-zinc-900 to-zinc-900 bg-clip-text text-xl font-bold tracking-tight text-transparent dark:from-blue-400 dark:via-white dark:to-white">
            My team
          </h2>
          {members.length > 0 && (
            <div className="flex items-center gap-2">
              <ActiveNowButton members={members} onlineEmails={onlineEmails} />
            </div>
          )}
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {unassigned ? (
            <>
              You do not have any departments assigned in Roles & permissions yet. Until an admin adds
              you under{' '}
              <span className="font-medium text-zinc-700 dark:text-zinc-300">department managers</span>,
              your team list and leave queue stay empty.
            </>
          ) : scoped ? (
            <>
              Showing active roster members in{' '}
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                {teamGate.departments.map((d) => formatDeptLabel(d) || d).join(', ')}
              </span>{' '}
              (matched from HR master list, case-insensitive).
            </>
          ) : (
            <>
              Showing the full active roster — your login has org-wide HR/payroll visibility, so every
              department appears here on the manager view.
            </>
          )}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <div role="tablist" aria-label="Team views" className="inline-flex w-fit rounded-md border border-blue-200 bg-blue-50/40 p-0.5 dark:border-blue-900/50 dark:bg-blue-950/20">
            <button
              type="button"
              role="tab"
              aria-selected={innerTab === 'roster'}
              onClick={() => setInnerTab('roster')}
              className={cn(
                'rounded-[5px] px-3 py-1.5 text-xs font-semibold transition',
                innerTab === 'roster'
                  ? 'bg-white text-blue-700 shadow-sm dark:bg-zinc-950 dark:text-blue-300'
                  : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
              )}
            >
              Roster
              <span className="ml-1.5 rounded bg-zinc-200 px-1 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                {members.length}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={innerTab === 'newly-hired'}
              onClick={() => setInnerTab('newly-hired')}
              className={cn(
                'rounded-[5px] px-3 py-1.5 text-xs font-semibold transition',
                innerTab === 'newly-hired'
                  ? 'bg-white text-blue-700 shadow-sm dark:bg-zinc-950 dark:text-blue-300'
                  : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
              )}
            >
              New Hire Check List
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={innerTab === 'orientation'}
              onClick={() => setInnerTab('orientation')}
              className={cn(
                'rounded-[5px] px-3 py-1.5 text-xs font-semibold transition',
                innerTab === 'orientation'
                  ? 'bg-white text-blue-700 shadow-sm dark:bg-zinc-950 dark:text-blue-300'
                  : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
              )}
            >
              Orientation
            </button>
          </div>
          {innerTab === 'roster' && !unassigned && members.length > 0 && (
            <div role="tablist" aria-label="Roster layout" className="flex items-center gap-0.5 rounded-lg border border-blue-100/80 bg-blue-50/50 p-0.5 dark:border-blue-950/50 dark:bg-blue-950/20">
              <button
                type="button"
                role="tab"
                onClick={() => setViewMode('cards')}
                title="Card view"
                aria-selected={viewMode === 'cards'}
                className={cn(
                  'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                  viewMode === 'cards'
                    ? 'bg-white text-blue-700 shadow-sm dark:bg-zinc-950 dark:text-blue-300'
                    : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
                )}
              >
                <LayoutGrid className="h-3.5 w-3.5" /> Cards
              </button>
              <button
                type="button"
                role="tab"
                onClick={() => setViewMode('list')}
                title="List view — multi-select to queue offboarding"
                aria-selected={viewMode === 'list'}
                className={cn(
                  'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                  viewMode === 'list'
                    ? 'bg-white text-blue-700 shadow-sm dark:bg-zinc-950 dark:text-blue-300'
                    : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
                )}
              >
                <List className="h-3.5 w-3.5" /> List
              </button>
            </div>
          )}
          {!unassigned && members.length > 0 && (
            <button
              type="button"
              onClick={() => setMedalOpen((v) => !v)}
              title={medalOpen ? 'Hide recognition' : 'Recognize an employee'}
              className={cn(
                'rounded-md border px-2 py-1.5 text-sm transition-all',
                medalOpen
                  ? 'border-amber-300 bg-amber-50 opacity-80 dark:border-amber-700/60 dark:bg-amber-900/20'
                  : 'border-zinc-200 bg-white opacity-40 grayscale hover:border-zinc-300 hover:bg-zinc-50 hover:opacity-60 dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:border-zinc-700',
              )}
            >
              🏅
            </button>
          )}
        </div>
      </header>

      {innerTab === 'newly-hired' && (
        <NewlyHiredPanel viewerEmail={viewerEmail} teamGate={teamGate} />
      )}

      {innerTab === 'orientation' && <OrientationAttendancePanel teamGate={teamGate} />}

      {innerTab === 'roster' && !unassigned && (
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor="team-search"
            className="text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
          >
            Search
          </label>
          <div className="relative min-w-[220px] flex-1 sm:max-w-[340px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              id="team-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Name or email"
              className="h-8 w-full rounded-md border border-blue-200 bg-white pl-8 pr-2 text-xs text-zinc-800 shadow-sm transition-colors hover:border-blue-300 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-blue-900/50 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:border-blue-800 dark:focus:border-blue-700 dark:focus:ring-blue-900/50"
            />
          </div>
          {deptOptions.length >= 2 && (
            <>
              <label
                className="text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
              >
                Department
              </label>
              <SmoothSelect
                aria-label="Department"
                value={deptFilter}
                onChange={(v) => setDeptFilter(v)}
                triggerClassName="min-w-[180px]"
                options={[
                  { value: 'all', label: `All (${members.length})` },
                  ...deptOptions.map((d) => {
                    const count = members.filter(
                      (m) => (m.department ?? '').trim().toLowerCase() === d.toLowerCase(),
                    ).length;
                    return { value: d, label: `${d} (${count})` };
                  }),
                ]}
              />
            </>
          )}
          {(deptFilter !== 'all' || searchQuery.trim() !== '') && (
            <button
              type="button"
              onClick={() => {
                setDeptFilter('all');
                setSearchQuery('');
              }}
              className="text-[11px] font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              Clear
            </button>
          )}
          <div className="ml-auto flex items-center gap-3">
            <span className="font-mono text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
              Showing {filteredMembers.length} of {members.length}
            </span>
            <button
              type="button"
              onClick={exportRosterCsv}
              disabled={filteredMembers.length === 0}
              title="Download the roster currently shown (respects search + department) as a CSV"
              className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-white px-2.5 py-1.5 text-xs font-medium text-blue-700 shadow-sm transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-blue-900/50 dark:bg-zinc-950 dark:text-blue-300 dark:hover:border-blue-800 dark:hover:bg-blue-950/30"
            >
              <Download className="h-3.5 w-3.5" /> Export CSV
            </button>
          </div>
        </div>
      )}

      <AnimatePresence initial={false}>
        {innerTab === 'roster' && medalOpen && !unassigned && members.length > 0 && (
          <motion.div
            key="medal-palette"
            initial={{ opacity: 0, height: 0, marginBottom: 0 }}
            animate={{ opacity: 1, height: 'auto', marginBottom: 0 }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            <MedalPalette />
          </motion.div>
        )}
      </AnimatePresence>

      {innerTab === 'roster' && (
      <Card className="border-blue-100/70 bg-gradient-to-br from-white to-blue-50/40 ring-1 ring-blue-500/10 dark:border-blue-950/50 dark:from-zinc-950 dark:to-blue-950/15 dark:ring-blue-400/10">
        <CardContent className="p-0 sm:p-0">
          {unassigned ? (
            <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-amber-500 to-orange-700 text-white shadow-md">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">No department assignments</p>
              <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">
                Ask an administrator to assign you to one or more departments in System Settings → Roles &amp;
                permissions (Department managers).
              </p>
            </div>
          ) : filteredMembers.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-white shadow-md shadow-blue-500/25">
                <Users className="h-6 w-6" />
              </div>
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                {members.length === 0 ? 'No employees in scope' : 'No employees match this filter'}
              </p>
              <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">
                {members.length === 0 ? (
                  <>
                    No rows in the active master list matched{' '}
                    {scoped ? 'your departments' : 'the roster query'} (department names must line up with HR).
                  </>
                ) : (
                  <>
                    Try clearing the active filters to see the full team.
                  </>
                )}
              </p>
            </div>
          ) : (
            (() => {
              const filterKey = `${deptFilter}|${searchQuery.trim()}`;
              const offboardBadge = (s: OffboardingQueueStatus | null) => {
                switch (s) {
                  case 'pending':
                    return { label: 'Queued', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' };
                  case 'processing':
                    return { label: 'Processing', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' };
                  case 'completed':
                    return { label: 'Offboarded', cls: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300' };
                  case 'dismissed':
                    return { label: 'Dismissed', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300' };
                  case 'returned':
                    // HR sent it back for revision — amber, and the person stays
                    // re-selectable so the manager can fix the reason and re-queue.
                    return { label: 'Returned', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' };
                  case 'cancelled':
                    // A withdrawn request leaves no trace — the person is back to
                    // normal and re-selectable (isMemberLocked ignores 'cancelled'),
                    // so intentionally show no badge.
                    return null;
                  default:
                    return null;
                }
              };
              return (
                <>
                  {/* Selection action bar — appears when people are ticked in list
                      mode. Selection persists across search/filter/paging. */}
                  <AnimatePresence initial={false}>
                    {selectedKeys.size > 0 && (
                      <motion.div
                        key="offboard-selbar"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        style={{ overflow: 'hidden' }}
                      >
                        <div className="flex flex-wrap items-center gap-2 border-b border-rose-100 bg-rose-50/70 px-4 py-2.5 dark:border-rose-950/50 dark:bg-rose-950/20">
                          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-rose-800 dark:text-rose-300">
                            <CheckCircle2 className="h-4 w-4" />
                            {selectedKeys.size} selected
                          </span>
                          <div className="ml-auto flex items-center gap-2">
                            <button
                              type="button"
                              onClick={clearSelection}
                              className="text-[11px] font-medium text-zinc-500 hover:underline dark:text-zinc-400"
                            >
                              Clear
                            </button>
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => setOffboardOpen(true)}
                              className="h-8 gap-1.5 bg-rose-600 text-white hover:bg-rose-700"
                              title="Send the selected people to HR for offboarding"
                            >
                              <UserMinus className="h-3.5 w-3.5" />
                              Queue for offboarding
                            </Button>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <AnimatePresence mode="wait" initial={false}>
                  {viewMode === 'list' ? (
                    <motion.div
                      key="view-list"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] } }}
                      exit={{ opacity: 0, y: -6, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
                      className="overflow-x-auto"
                    >
                      <div>
                        <table className="w-full text-left text-xs">
                          <thead className="border-b border-blue-100/80 bg-blue-50/40 text-[11px] font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-900/40 dark:bg-blue-950/30 dark:text-blue-300">
                            <tr>
                              <th className="w-8 px-3 py-2.5">
                                <Checkbox
                                  aria-label="Select all on this page"
                                  checked={allPageSelected}
                                  indeterminate={!allPageSelected && somePageSelected}
                                  onCheckedChange={toggleSelectAllPage}
                                  disabled={selectablePage.length === 0}
                                />
                              </th>
                              <th className="px-4 py-2.5">Name</th>
                              <th className="px-4 py-2.5">Department</th>
                              <th className="hidden px-4 py-2.5 sm:table-cell">Title</th>
                              {showCallToolsCol && (
                                <th className="px-4 py-2.5">CallTools Username</th>
                              )}
                              <th className="px-4 py-2.5 text-right">Status</th>
                              <th className="px-4 py-2.5 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-blue-100/60 dark:divide-blue-900/40">
                            {pageSlice.map((m, idx) => {
                              const k = memberKey(m);
                              const checked = selectedKeys.has(k);
                              const locked = isMemberLocked(m);
                              const online = isMemberOnline(m);
                              const ss = skillSetFor(m);
                              const roleLine = ss?.role_title?.trim() || m.hsl_role?.trim() || null;
                              const badge = offboardBadge(memberOffboardStatus(m));
                              const avatarEmail = m.work_email ?? m.personal_email ?? null;
                              const resig = memberResignation(m);
                              const suspended = suspendedKeys.has(k);
                              return (
                                <React.Fragment key={`${m.work_email ?? m.personal_email ?? m.name}-${idx}`}>
                                <tr
                                  className={cn(
                                    'align-middle transition-colors',
                                    resig
                                      ? 'bg-rose-50/70 dark:bg-rose-950/20'
                                      : checked
                                        ? 'bg-rose-50/60 dark:bg-rose-950/15'
                                        : 'hover:bg-blue-50/40 dark:hover:bg-blue-950/20',
                                  )}
                                >
                                  <td className="px-3 py-3" data-label="Select">
                                    <Checkbox
                                      aria-label={`Select ${m.name ?? k}`}
                                      checked={checked}
                                      disabled={locked}
                                      onCheckedChange={() => toggleSelected(m)}
                                    />
                                  </td>
                                  <td data-label="Name" className="px-4 py-3">
                                    <button
                                      type="button"
                                      onClick={() => setSelectedMember(m)}
                                      className="flex items-center gap-2.5 text-left"
                                      title="View profile"
                                    >
                                      <span className="relative shrink-0">
                                        <TeamAvatar name={m.name ?? '—'} email={avatarEmail} />
                                        <span
                                          className={cn(
                                            'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-zinc-950',
                                            online ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
                                          )}
                                          aria-hidden
                                        />
                                      </span>
                                      <span className="min-w-0">
                                        <span className="block truncate font-medium text-zinc-900 dark:text-zinc-100">
                                          {m.name ?? '—'}
                                        </span>
                                        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-500">
                                          {m.work_email ?? m.personal_email ?? '—'}
                                        </span>
                                      </span>
                                    </button>
                                  </td>
                                  <td data-label="Department" className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                                    {m.department ? (
                                      <span className="inline-flex items-center gap-1" title={m.department ?? undefined}>
                                        <Building2 className="h-3 w-3 text-zinc-400" />
                                        {formatDeptLabel(m.department)}
                                      </span>
                                    ) : (
                                      <span className="text-zinc-400">—</span>
                                    )}
                                  </td>
                                  <td data-label="Title" className="hidden px-4 py-3 text-zinc-600 dark:text-zinc-400 sm:table-cell">
                                    <span className="line-clamp-1" title={roleLine ?? undefined}>{roleLine ?? '—'}</span>
                                  </td>
                                  {showCallToolsCol && (
                                    <td data-label="CallTools Username" className="px-4 py-3">
                                      {isLeadGenDepartment(m.department) ? (
                                        <CallToolsUsernameCell
                                          member={m}
                                          value={callToolsValue(m)}
                                          onSaved={(username) =>
                                            setCallToolsOverrides((prev) => ({
                                              ...prev,
                                              [memberKey(m)]: username,
                                            }))
                                          }
                                        />
                                      ) : (
                                        <span className="text-[11px] text-zinc-300 dark:text-zinc-600">—</span>
                                      )}
                                    </td>
                                  )}
                                  <td data-label="Status" className="px-4 py-3 text-right">
                                    {resig ? (
                                      <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
                                        <DoorOpen className="h-3 w-3" />
                                        Resigning
                                      </span>
                                    ) : badge ? (
                                      <span
                                        className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium', badge.cls)}
                                        title={memberOffboardStatus(m) === 'returned' ? (memberReturnNote(m) ?? 'HR sent this back — check your notifications') : undefined}
                                      >
                                        {badge.label}
                                      </span>
                                    ) : suspended ? (
                                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                                        <CirclePause className="h-3 w-3" />
                                        Suspended
                                      </span>
                                    ) : (
                                      <span className="text-[11px] text-zinc-300 dark:text-zinc-600">—</span>
                                    )}
                                  </td>
                                  <td data-label="Actions" className="px-4 py-3 text-right">
                                    <div className="flex items-center justify-end gap-1.5">
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setSelectedMember(m)}
                                        className="h-7 gap-1 border-blue-200 bg-blue-50/60 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 dark:border-blue-700/50 dark:bg-blue-950/30 dark:text-blue-300 dark:hover:bg-blue-950/60"
                                      >
                                        <Eye className="h-3 w-3" />
                                        View
                                      </Button>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        disabled={suspended || !avatarEmail}
                                        onClick={() => setTempPauseTarget({ member: m, action: 'suspend' })}
                                        title={
                                          !avatarEmail
                                            ? 'No email on file — cannot suspend'
                                            : "Disable this person's Workspace account (temporary pause — nothing is deleted)"
                                        }
                                        className="h-7 gap-1 border-amber-200 bg-amber-50/60 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/60"
                                      >
                                        <CirclePause className="h-3 w-3" />
                                        {suspended ? 'Suspended' : 'Suspend'}
                                      </Button>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        disabled={!avatarEmail}
                                        onClick={() => setTempPauseTarget({ member: m, action: 'reactivate' })}
                                        title={
                                          !avatarEmail
                                            ? 'No email on file — cannot reactivate'
                                            : "Re-enable this person's Workspace account after a temporary pause"
                                        }
                                        className="h-7 gap-1 border-emerald-200 bg-emerald-50/60 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-60 dark:border-emerald-700/50 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-950/60"
                                      >
                                        <CirclePlay className="h-3 w-3" />
                                        Reactivation
                                      </Button>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        disabled={locked}
                                        onClick={() => openOffboardFor(m)}
                                        title="Send to HR for offboarding — joins anyone already ticked in the multi-select"
                                        className="h-7 gap-1 border-rose-200 bg-rose-50/60 text-[11px] font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-60 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-300 dark:hover:bg-rose-950/60"
                                      >
                                        <UserMinus className="h-3 w-3" />
                                        Offboard
                                      </Button>
                                    </div>
                                  </td>
                                </tr>
                                {resig && (
                                  <tr className="bg-rose-50/40 dark:bg-rose-950/10">
                                    <td />
                                    <td colSpan={showCallToolsCol ? 6 : 5} className="px-4 pb-3 pt-0">
                                      <div className="rounded-lg border border-rose-200/80 bg-white/70 p-3 dark:border-rose-900/40 dark:bg-zinc-950/40">
                                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-300">
                                          <DoorOpen className="h-3.5 w-3.5" />
                                          Resignation
                                          <span className="font-mono text-[10.5px] font-medium normal-case text-rose-600/80 dark:text-rose-300/70">
                                            · effective {fmtEffective(resig.effective_date)}
                                          </span>
                                        </div>
                                        {resig.message ? (
                                          <p className="mt-1.5 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                                            &ldquo;{resig.message}&rdquo;
                                          </p>
                                        ) : (
                                          <p className="mt-1.5 text-[12px] italic text-zinc-400 dark:text-zinc-600">
                                            No message left.
                                          </p>
                                        )}
                                        <div className="mt-2.5 flex flex-wrap items-center gap-2">
                                          <Button
                                            type="button"
                                            size="sm"
                                            onClick={() => openResignDecision(resig, 'approve')}
                                            className="h-7 gap-1.5 bg-emerald-600 px-2.5 text-[11px] font-semibold text-white hover:bg-emerald-700"
                                            title="Approve — queues this person for offboarding (reason: Resigned)"
                                          >
                                            <CheckCircle2 className="h-3.5 w-3.5" />
                                            Approve
                                          </Button>
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            onClick={() => openResignDecision(resig, 'reject')}
                                            className="h-7 gap-1.5 border-rose-200 px-2.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 dark:border-rose-700/50 dark:text-rose-300 dark:hover:bg-rose-950/40"
                                            title="Decline this resignation"
                                          >
                                            <X className="h-3.5 w-3.5" />
                                            Decline
                                          </Button>
                                        </div>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                                </React.Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div data-readonly-allow className="flex flex-col items-center justify-between gap-2 border-t border-blue-100/80 bg-white/60 px-4 py-2.5 text-[11px] text-zinc-500 dark:border-blue-900/40 dark:bg-zinc-950/40 dark:text-zinc-400 sm:flex-row">
                        <span className="tabular-nums">
                          Showing{' '}
                          <span className="font-medium text-zinc-700 dark:text-zinc-300">{pageStart + 1}–{pageEnd}</span>{' '}
                          of <span className="font-medium text-zinc-700 dark:text-zinc-300">{filteredMembers.length}</span>
                          {selectedKeys.size > 0 ? ` · ${selectedKeys.size} selected` : ''}
                        </span>
                        {totalPages > 1 && (
                          <div className="flex items-center gap-1.5">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={currentPage <= 1}
                              onClick={() => setPage((p) => Math.max(1, p - 1))}
                              className="h-7 gap-1 border-blue-200 px-2 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/40"
                              aria-label="Previous page"
                            >
                              <ChevronLeft className="h-3.5 w-3.5" />
                              Prev
                            </Button>
                            <span className="rounded-md border border-zinc-200 bg-white px-2 py-1 font-mono tabular-nums text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
                              {currentPage} / {totalPages}
                            </span>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={currentPage >= totalPages}
                              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                              className="h-7 gap-1 border-blue-200 px-2 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/40"
                              aria-label="Next page"
                            >
                              Next
                              <ChevronRight className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  ) : (
                  <motion.div
                    key="view-cards"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] } }}
                    exit={{ opacity: 0, y: -6, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
                  >
                  <motion.div
                    key={filterKey}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                  >
                  {/* Roster card grid — mirrors the employee My Team view,
                      with manager actions layered on. Medal drag-drop
                      is wired at the grid level via each card's data-email. */}
                  <div
                    className="grid grid-cols-1 gap-4 p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-3 xl:grid-cols-4"
                    onDragOver={(e) => {
                      if (!draggedMedal) return;
                      e.preventDefault();
                      const card = (e.target as HTMLElement).closest('[data-email]') as HTMLElement | null;
                      setDragOverEmail(card?.dataset.email ?? null);
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setDragOverEmail(null);
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const card = (e.target as HTMLElement).closest('[data-email]') as HTMLElement | null;
                      const email = card?.dataset.email;
                      const name = card?.dataset.name ?? null;
                      if (email) openAwardForDrop(email, name);
                      setDragOverEmail(null);
                    }}
                  >
                    {pageSlice.map((m, idx) => {
                      const cardEmail = m.personal_email ?? m.work_email ?? undefined;
                      const avatarEmail = m.work_email ?? m.personal_email ?? null;
                      const isOver = !!draggedMedal && !!cardEmail && dragOverEmail === cardEmail;
                      const online = isMemberOnline(m);
                      const ss = skillSetFor(m);
                      const roleLine = ss?.role_title?.trim() || m.hsl_role?.trim() || null;
                      const workingOn = formatCurrentProjects(ss?.current_projects, ss?.currently_working_on);
                      const seenIso = online ? null : lastSeenFor(m);
                      const resig = memberResignation(m);
                      const k = memberKey(m);
                      const suspended = suspendedKeys.has(k);
                      const locked = isMemberLocked(m);
                      return (
                        <motion.div
                          key={`${m.work_email ?? m.personal_email ?? m.name}-${idx}`}
                          data-email={cardEmail}
                          data-name={m.name ?? undefined}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.22, delay: Math.min(idx * 0.025, 0.18), ease: 'easeOut' }}
                          className={cn(
                            'group relative flex min-h-[232px] flex-col overflow-hidden rounded-2xl border border-blue-100/70 bg-white shadow-sm ring-1 ring-blue-500/5 transition-[transform,box-shadow,border-color] duration-300 hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md dark:border-blue-950/50 dark:bg-zinc-950/80 dark:ring-blue-400/10 dark:hover:border-blue-900',
                            isOver && 'bg-amber-50/50 ring-2 ring-amber-400/70 dark:bg-amber-950/10',
                            resig && 'border-rose-200 ring-2 ring-rose-400/60 dark:border-rose-900/60 dark:ring-rose-500/30',
                          )}
                        >
                          <div
                            className="flex-1 cursor-pointer p-4"
                            role="button"
                            tabIndex={0}
                            onClick={() => setSelectedMember(m)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setSelectedMember(m);
                              }
                            }}
                          >
                            {/* Header: avatar + name + role */}
                            <div className="flex items-start gap-3">
                              <div className="relative shrink-0">
                                <TeamAvatar name={m.name ?? '—'} email={avatarEmail} />
                                <span
                                  className={cn(
                                    'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-white dark:ring-zinc-950',
                                    online ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
                                  )}
                                  title={online ? 'Online in HRIS now' : seenIso ? `Last seen ${new Date(seenIso).toLocaleString()}` : 'Offline'}
                                  aria-hidden
                                />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <h4 className="truncate text-[0.95rem] font-semibold leading-snug text-zinc-900 dark:text-white">
                                    {m.name ?? '—'}
                                  </h4>
                                  <MedalBadges email={cardEmail} />
                                </div>
                                {/* Title — the headline detail */}
                                <p
                                  className="mt-0.5 truncate text-[13px] font-medium leading-snug text-zinc-700 dark:text-zinc-200"
                                  title={roleLine ?? undefined}
                                >
                                  {roleLine ?? 'No title set'}
                                </p>
                                <div className="mt-1 flex flex-wrap items-center gap-1">
                                  {m.department && (
                                    <span className="rounded-md border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300" title={m.department ?? undefined}>
                                      {formatDeptLabel(m.department)}
                                    </span>
                                  )}
                                  {m.mesa_member && (
                                    <span title="MESA Program — ₱100 deducted per paycheck" className="rounded-md border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-[10px] font-semibold text-teal-700 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300">
                                      MESA −₱100
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Primary card content — a pending resignation takes over
                                the slot so the manager sees the message + effective date. */}
                            {resig ? (
                              <div className="mt-3 rounded-lg border border-rose-200/80 bg-rose-50/70 px-3 py-2 dark:border-rose-900/40 dark:bg-rose-950/25">
                                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-300">
                                  <DoorOpen className="h-3 w-3" />
                                  Resigning
                                  <span className="font-mono text-[10px] font-medium normal-case text-rose-600/80 dark:text-rose-300/70">
                                    · effective {fmtEffective(resig.effective_date)}
                                  </span>
                                </div>
                                {resig.message ? (
                                  <p className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-zinc-800 dark:text-zinc-200" title={resig.message}>
                                    &ldquo;{resig.message}&rdquo;
                                  </p>
                                ) : (
                                  <p className="mt-1 text-[12.5px] italic text-zinc-400 dark:text-zinc-600">
                                    No message left.
                                  </p>
                                )}
                                {/* Same Approve/Decline as the list view's resignation
                                    sub-row. The panel sits inside the card's clickable
                                    body, so stop propagation or the profile opens too. */}
                                <div
                                  className="mt-2 flex flex-wrap items-center gap-2"
                                  role="presentation"
                                  onClick={(e) => e.stopPropagation()}
                                  onKeyDown={(e) => e.stopPropagation()}
                                >
                                  <Button
                                    type="button"
                                    size="sm"
                                    onClick={() => openResignDecision(resig, 'approve')}
                                    className="h-7 gap-1.5 bg-emerald-600 px-2.5 text-[11px] font-semibold text-white hover:bg-emerald-700"
                                    title="Approve — queues this person for offboarding (reason: Resigned)"
                                  >
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                    Approve
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => openResignDecision(resig, 'reject')}
                                    className="h-7 gap-1.5 border-rose-200 px-2.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 dark:border-rose-700/50 dark:text-rose-300 dark:hover:bg-rose-950/40"
                                    title="Decline this resignation"
                                  >
                                    <X className="h-3.5 w-3.5" />
                                    Decline
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <div className="mt-3 rounded-lg border border-zinc-100 bg-zinc-50/70 px-3 py-2 dark:border-zinc-800/70 dark:bg-zinc-900/40">
                                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                                  <Briefcase className="h-3 w-3" />
                                  Currently working on
                                </div>
                                {workingOn ? (
                                  <p className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-zinc-800 dark:text-zinc-200" title={workingOn}>
                                    {workingOn}
                                  </p>
                                ) : (
                                  <p className="mt-1 text-[12.5px] italic text-zinc-400 dark:text-zinc-600">
                                    Nothing shared yet
                                  </p>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Subtle footer detail line — email kept quiet (rates
                              removed: managers no longer see pay rates) */}
                          <div className="flex items-center gap-2 px-4 pb-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                            <span className="inline-flex min-w-0 items-center gap-1">
                              <Mail className="h-3 w-3 shrink-0" />
                              <span className="truncate font-mono" title={m.work_email ?? m.personal_email ?? undefined}>
                                {m.work_email ?? m.personal_email ?? '—'}
                              </span>
                            </span>
                          </div>

                          {/* Actions — the SAME set as the list view's Actions column
                              (a resigning member's Approve/Decline lives in the rose
                              panel above, mirroring the list's sub-row). */}
                          <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800/60">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => setSelectedMember(m)}
                              className="h-7 gap-1 border-blue-200 bg-blue-50/60 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 dark:border-blue-700/50 dark:bg-blue-950/30 dark:text-blue-300 dark:hover:bg-blue-950/60"
                              title="View profile and recognition"
                            >
                              <Eye className="h-3 w-3" />
                              View
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={suspended || !avatarEmail}
                              onClick={() => setTempPauseTarget({ member: m, action: 'suspend' })}
                              title={
                                !avatarEmail
                                  ? 'No email on file — cannot suspend'
                                  : "Disable this person's Workspace account (temporary pause — nothing is deleted)"
                              }
                              className="h-7 gap-1 border-amber-200 bg-amber-50/60 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/60"
                            >
                              <CirclePause className="h-3 w-3" />
                              {suspended ? 'Suspended' : 'Suspend'}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!avatarEmail}
                              onClick={() => setTempPauseTarget({ member: m, action: 'reactivate' })}
                              title={
                                !avatarEmail
                                  ? 'No email on file — cannot reactivate'
                                  : "Re-enable this person's Workspace account after a temporary pause"
                              }
                              className="h-7 gap-1 border-emerald-200 bg-emerald-50/60 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-60 dark:border-emerald-700/50 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-950/60"
                            >
                              <CirclePlay className="h-3 w-3" />
                              Reactivation
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={locked}
                              onClick={() => openOffboardFor(m)}
                              title="Send to HR for offboarding — joins anyone already ticked in the multi-select"
                              className="h-7 gap-1 border-rose-200 bg-rose-50/60 text-[11px] font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-60 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-300 dark:hover:bg-rose-950/60"
                            >
                              <UserMinus className="h-3 w-3" />
                              Offboard
                            </Button>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                  </motion.div>

                  {/* Pagination footer */}
                  {filteredMembers.length > TEAM_PAGE_SIZE && (
                    <div data-readonly-allow className="flex flex-col items-center justify-between gap-2 border-t border-blue-100/70 bg-white/60 px-4 py-3 text-xs text-zinc-600 dark:border-blue-950/50 dark:bg-zinc-950/40 dark:text-zinc-400 sm:flex-row">
                      <span className="tabular-nums">
                        Showing{' '}
                        <span className="font-medium text-zinc-800 dark:text-zinc-200">
                          {pageStart + 1}–{pageEnd}
                        </span>{' '}
                        of{' '}
                        <span className="font-medium text-zinc-800 dark:text-zinc-200">
                          {filteredMembers.length}
                        </span>
                      </span>
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={currentPage <= 1}
                          onClick={() => setPage((p) => Math.max(1, p - 1))}
                          className="h-7 gap-1 border-blue-200 px-2 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/40"
                          aria-label="Previous page"
                        >
                          <ChevronLeft className="h-3.5 w-3.5" />
                          Prev
                        </Button>
                        <span className="rounded-md border border-zinc-200 bg-white px-2 py-1 font-mono tabular-nums text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
                          {currentPage} / {totalPages}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={currentPage >= totalPages}
                          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                          className="h-7 gap-1 border-blue-200 px-2 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/40"
                          aria-label="Next page"
                        >
                          Next
                          <ChevronRight className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                  </motion.div>
                  )}
                  </AnimatePresence>
                </>
              );
            })()
          )}
        </CardContent>
      </Card>
      )}

      <ManagerMemberDialog
        member={selectedMember}
        onClose={() => setSelectedMember(null)}
        skillSet={selectedMember ? skillSetFor(selectedMember) : undefined}
        medals={selectedMember ? medals[selectedMember.personal_email ?? selectedMember.work_email ?? ''] ?? [] : []}
        initialMemberNotes={selectedMember ? skillSetFor(selectedMember)?.member_notes ?? '' : ''}
        onMemberNotesSaved={(notes) => {
          const w = normEmail(selectedMember?.work_email ?? '');
          if (!w) return;
          setSkillSets((prev) => ({
            ...prev,
            [w]: {
              role_title: prev[w]?.role_title ?? '',
              currently_working_on: prev[w]?.currently_working_on ?? '',
              skills: prev[w]?.skills ?? '',
              strengths: prev[w]?.strengths ?? '',
              member_notes: notes,
              projects: prev[w]?.projects ?? [],
              current_projects: prev[w]?.current_projects ?? [],
            },
          }));
        }}
      />

      <ManagerOffboardQueueDialog
        open={offboardOpen}
        people={selectedMembers.map<OffboardCandidate>((m) => ({
          name: m.name,
          work_email: m.work_email ?? null,
          personal_email: m.personal_email ?? null,
          department: m.department ?? null,
        }))}
        onOpenChange={setOffboardOpen}
        onSubmitted={() => {
          clearSelection();
          loadOffboardOutbox();
        }}
      />

      {/* Suspend / Reactivation confirmation — the temp-pause pair, via
          /api/manager/temp-pause (suspend = disable only, never delete;
          reactivate = re-enable). */}
      {tempPauseTarget && (() => {
        const { member, action } = tempPauseTarget;
        const isSuspend = action === 'suspend';
        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-start justify-between gap-2 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <div className="min-w-0">
                <p
                  className={cn(
                    'text-[11px] font-semibold uppercase tracking-wide',
                    isSuspend
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-emerald-600 dark:text-emerald-400',
                  )}
                >
                  {isSuspend ? 'Suspend account' : 'Reactivate account'}
                </p>
                <h3 className="mt-0.5 truncate text-base font-bold text-zinc-900 dark:text-white">
                  {member.name ?? member.work_email ?? member.personal_email}
                </h3>
              </div>
              <button
                type="button"
                disabled={tempPauseSaving}
                onClick={() => setTempPauseTarget(null)}
                className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 px-5 py-4">
              <div className="flex items-center justify-between gap-4 text-[13px]">
                <span className="text-zinc-500 dark:text-zinc-400">Email</span>
                <span className="truncate font-mono text-xs font-medium text-zinc-900 dark:text-zinc-100">
                  {member.work_email ?? member.personal_email ?? '—'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 text-[13px]">
                <span className="text-zinc-500 dark:text-zinc-400">Department</span>
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {formatDeptLabel(member.department) || '—'}
                </span>
              </div>
              {isSuspend ? (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200/70 bg-amber-50/60 px-3 py-2 text-[12px] leading-relaxed text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200">
                  <CirclePause className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Suspending <strong>disables</strong> this person&apos;s Workspace account
                    (sign-in blocked) via the temporary-pause automation — like the Temporary
                    Pause offboarding reason, but without the HR queue. <strong>Nothing is
                    deleted</strong>; use <strong>Reactivation</strong> when they return.
                  </span>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-emerald-200/70 bg-emerald-50/60 px-3 py-2 text-[12px] leading-relaxed text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200">
                  <CirclePlay className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Reactivation <strong>re-enables</strong> this person&apos;s Workspace account
                    (sign-in restored) after a temporary pause, via the reactivation automation.
                  </span>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={tempPauseSaving}
                onClick={() => setTempPauseTarget(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={tempPauseSaving}
                onClick={submitTempPause}
                className={cn(
                  'gap-1.5 text-white',
                  isSuspend ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700',
                )}
              >
                {tempPauseSaving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : isSuspend ? (
                  <CirclePause className="h-3.5 w-3.5" />
                ) : (
                  <CirclePlay className="h-3.5 w-3.5" />
                )}
                {isSuspend ? 'Suspend account' : 'Reactivate account'}
              </Button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Resignation decision modal (approve → offboarding queue, or decline) */}
      {resignDecision && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-start justify-between gap-2 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <div className="min-w-0">
                <p
                  className={cn(
                    'text-[11px] font-semibold uppercase tracking-wide',
                    resignDecision.action === 'approve'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-rose-600 dark:text-rose-400',
                  )}
                >
                  {resignDecision.action === 'approve' ? 'Approve resignation' : 'Decline resignation'}
                </p>
                <h3 className="mt-0.5 truncate text-base font-bold text-zinc-900 dark:text-white">
                  {resignDecision.row.employee_name ?? resignDecision.row.employee_email}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setResignDecision(null)}
                className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 px-5 py-4">
              <div className="flex items-center justify-between gap-4 text-[13px]">
                <span className="text-zinc-500 dark:text-zinc-400">Effective date</span>
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {fmtEffective(resignDecision.row.effective_date)}
                </span>
              </div>
              {resignDecision.row.message && (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/50">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                    Their message
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                    {resignDecision.row.message}
                  </p>
                </div>
              )}
              {resignDecision.action === 'approve' ? (
                <div className="flex items-start gap-2 rounded-lg border border-emerald-200/70 bg-emerald-50/60 px-3 py-2 text-[12px] leading-relaxed text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Approving sends this person to HR&apos;s offboarding queue with the reason{' '}
                    <strong>Resigned</strong>. HR handles the rest.
                  </span>
                </div>
              ) : null}
              <div>
                <label
                  htmlFor="resign-note"
                  className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500"
                >
                  Note {resignDecision.action === 'reject' ? '(required)' : '(optional)'}
                </label>
                <textarea
                  id="resign-note"
                  value={resignNote}
                  onChange={(e) => setResignNote(e.target.value)}
                  rows={3}
                  placeholder={
                    resignDecision.action === 'approve'
                      ? 'Optional note (kept for the record)…'
                      : 'Explain why you’re declining — the employee sees this…'
                  }
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={resignSaving}
                onClick={() => setResignDecision(null)}
              >
                Cancel
              </Button>
              {resignDecision.action === 'approve' ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={resignSaving}
                  onClick={submitResignDecision}
                  className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  {resignSaving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  )}
                  Approve &amp; queue offboarding
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={resignSaving}
                  onClick={submitResignDecision}
                  className="gap-1.5 border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-300 dark:hover:bg-rose-950/60"
                >
                  {resignSaving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                  Decline
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Active now" — a toolbar button that opens a dropdown listing which team
 * members are currently signed in to the HRIS (live, via the app-wide presence
 * channel). Mirrors the employee My Team online badges; managers get a roll-up.
 */
function ActiveNowButton({
  members,
  onlineEmails,
}: {
  members: EmployeeRow[];
  onlineEmails: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onlineMembers = useMemo(() => {
    return members.filter((m) => {
      const w = normEmail(m.work_email ?? '');
      const p = normEmail(m.personal_email ?? '');
      return (!!w && onlineEmails.has(w)) || (!!p && onlineEmails.has(p));
    });
  }, [members, onlineEmails]);

  const count = onlineMembers.length;

  return (
    <div ref={ref} className="relative">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="See who is signed in to the HRIS right now"
        className="h-7 gap-1.5 border-emerald-200 text-xs text-emerald-700 transition-colors hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
      >
        <span className="relative flex h-2 w-2">
          {count > 0 && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
          )}
          <span className={cn('relative inline-flex h-2 w-2 rounded-full', count > 0 ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600')} />
        </span>
        Active now
        <span className="rounded bg-emerald-100 px-1 text-[10px] font-semibold tabular-nums text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
          {count}
        </span>
      </Button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-72 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-950">
          <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
            <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">Active now</span>
            <span className="text-[10px] text-zinc-400">{onlineEmails.size} online in HRIS</span>
          </div>
          {count === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
              No teammates are online right now.
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto py-1">
              {onlineMembers.map((m, idx) => {
                const e = m.work_email ?? m.personal_email ?? '';
                return (
                  <div
                    key={`${e || m.name}-${idx}`}
                    className="flex items-center gap-2.5 px-3 py-1.5"
                  >
                    <span className="relative flex h-2 w-2 shrink-0">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">
                        {m.name ?? (e || '—')}
                      </div>
                      {e && (
                        <div className="truncate font-mono text-[10px] text-zinc-400 dark:text-zinc-500">{e}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TeamPanel(props: TeamPanelProps) {
  const memberEmails = useMemo(
    () =>
      props.members
        .flatMap((m) => [m.personal_email, m.work_email])
        .filter((e): e is string => !!e)
        .map((e) => e.trim().toLowerCase()),
    [props.members],
  );
  return (
    <MedalProvider viewerEmail={props.viewerEmail} memberEmails={memberEmails}>
      <TeamPanelInner {...props} />
    </MedalProvider>
  );
}

// ─── Bits ────────────────────────────────────────────────────────────────────

interface StatTileProps {
  label: string;
  value: number | string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: 'blue' | 'indigo' | 'amber' | 'slate';
  onClick?: () => void;
}

/** Soft gradient surface + gradient icon chip + gradient numeral. One number each. */
function StatTile({ label, value, hint, icon: Icon, accent, onClick }: StatTileProps) {
  const tone = {
    blue: {
      surface:
        'border-blue-100 bg-gradient-to-br from-blue-50 via-white to-white dark:border-blue-950/60 dark:from-blue-950/40 dark:via-zinc-950 dark:to-zinc-950',
      hover: 'hover:border-blue-300 hover:shadow-blue-500/10 dark:hover:border-blue-800',
      chip: 'from-blue-500 to-blue-700 shadow-blue-500/30',
      value: 'from-blue-700 to-indigo-900 dark:from-blue-200 dark:to-indigo-300',
    },
    indigo: {
      surface:
        'border-indigo-100 bg-gradient-to-br from-indigo-50 via-white to-white dark:border-indigo-950/60 dark:from-indigo-950/40 dark:via-zinc-950 dark:to-zinc-950',
      hover: 'hover:border-indigo-300 hover:shadow-indigo-500/10 dark:hover:border-indigo-800',
      chip: 'from-indigo-500 to-violet-700 shadow-indigo-500/30',
      value: 'from-indigo-700 to-violet-900 dark:from-indigo-200 dark:to-violet-300',
    },
    amber: {
      surface:
        'border-amber-100 bg-gradient-to-br from-amber-50 via-white to-white dark:border-amber-950/60 dark:from-amber-950/40 dark:via-zinc-950 dark:to-zinc-950',
      hover: 'hover:border-amber-300 hover:shadow-amber-500/10 dark:hover:border-amber-800',
      chip: 'from-amber-500 to-orange-600 shadow-amber-500/30',
      value: 'from-amber-600 to-orange-800 dark:from-amber-200 dark:to-orange-300',
    },
    slate: {
      surface:
        'border-zinc-200 bg-gradient-to-br from-zinc-50 via-white to-white dark:border-zinc-800 dark:from-zinc-900 dark:via-zinc-950 dark:to-zinc-950',
      hover: 'hover:border-zinc-300 dark:hover:border-zinc-700',
      // Inverts in dark mode, so the glyph flips dark to stay legible.
      chip: 'from-zinc-600 to-zinc-900 shadow-zinc-900/25 dark:from-zinc-300 dark:to-zinc-500 dark:text-zinc-900',
      value: 'from-zinc-700 to-zinc-900 dark:from-zinc-200 dark:to-zinc-400',
    },
  }[accent];

  const Wrapper = onClick ? 'button' : 'div';

  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'group relative flex items-center gap-3.5 overflow-hidden rounded-2xl border px-4 py-4 text-left shadow-sm transition-all',
        tone.surface,
        onClick && cn('cursor-pointer hover:-translate-y-0.5 hover:shadow-md', tone.hover),
      )}
    >
      <span
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md',
          tone.chip,
        )}
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
          {label}
        </div>
        <div
          className={cn(
            'mt-0.5 bg-gradient-to-br bg-clip-text text-2xl font-bold tabular-nums text-transparent',
            tone.value,
          )}
        >
          {value}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">{hint}</div>
      </div>
    </Wrapper>
  );
}
