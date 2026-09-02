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
  ImageOff,
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
  type BonusScoringItem,
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
import { MANAGER_CACHE_KEYS } from '@/lib/manager/tab-cache';
import {
  useManagerCacheIdentity,
  useManagerCachedState,
} from '@/hooks/useManagerCachedState';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import PayrollProcessingLock from '@/components/payroll/PayrollProcessingLock';
import { KpiCalculatorSwitch } from './kpi-calculator-switch';
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

/**
 * `/api/manager/department-members`, exactly as the route answers it.
 *
 * The RAW payload is what the tab cache holds, never the derived
 * {@link ManagerTeamGate} — see `src/lib/manager/tab-cache.ts`. A gate is a
 * discriminated union with a `loading` and an `error` arm, and caching one would
 * mean a reload could paint "loading" or "error" as a settled fact.
 */
interface ManagerRosterPayload {
  rows: EmployeeRow[];
  scope: 'elevated' | 'department';
  departments: string[];
}

/** Stable empty roster, so `teamMembers` keeps its identity across renders. */
const NO_TEAM_MEMBERS: EmployeeRow[] = [];

/** One `/api/offboarding-queue` row, as the My Team badges read it. */
interface OffboardOutboxRow {
  employee_email: string | null;
  employee_work_email: string | null;
  employee_personal_email: string | null;
  status: OffboardingQueueStatus;
  processed_note: string | null;
}

/** Most-relevant status wins if a person appears under more than one email. */
const OFFBOARD_STATUS_RANK: Record<OffboardingQueueStatus, number> = {
  processing: 6,
  pending: 5,
  returned: 4,
  completed: 3,
  dismissed: 2,
  cancelled: 1,
};

/**
 * Per-email offboarding badge status, plus the HR note for a returned request.
 *
 * Module-scope and pure so the cache-seeded render and the fetch path cannot
 * produce different badges from the same rows.
 */
function deriveOffboardBadges(rows: OffboardOutboxRow[]): {
  status: Record<string, OffboardingQueueStatus>;
  note: Record<string, string>;
} {
  const status: Record<string, OffboardingQueueStatus> = {};
  const note: Record<string, string> = {};
  for (const row of rows) {
    for (const e of [row.employee_email, row.employee_work_email, row.employee_personal_email]) {
      const k = normEmail(e ?? '') ?? '';
      if (!k) continue;
      const prev = status[k];
      if (!prev || OFFBOARD_STATUS_RANK[row.status] > OFFBOARD_STATUS_RANK[prev]) {
        status[k] = row.status;
        if (row.status === 'returned' && row.processed_note) note[k] = row.processed_note;
        else delete note[k];
      }
    }
  }
  return { status, note };
}

/** One `/api/employee-skill-sets` row — a shared profile, never any pay data. */
type SkillSetRow = TeamSkillSet & { work_email: string };

/**
 * Skill sets keyed by normalized work email.
 *
 * Module-scope and pure, same contract as the two derivations above.
 */
function deriveSkillSetMap(rows: SkillSetRow[]): Record<string, TeamSkillSet> {
  const map: Record<string, TeamSkillSet> = {};
  for (const row of rows) {
    const k = normEmail(row.work_email ?? '') ?? '';
    if (k) map[k] = row;
  }
  return map;
}

/**
 * Pending resignations keyed by every email the person is known under.
 *
 * Module-scope and pure for the same reason as {@link deriveOffboardBadges}: the
 * roster floats these people to the top, and the seeded and fetched paths must
 * float exactly the same set.
 */
function derivePendingResignations(
  rows: ResignationRequestRow[],
): Record<string, ResignationRequestRow> {
  const map: Record<string, ResignationRequestRow> = {};
  for (const row of rows) {
    if (row.status !== 'pending') continue;
    for (const e of [row.employee_work_email, row.employee_personal_email, row.employee_email]) {
      const k = normEmail(e ?? '') ?? '';
      if (k && !map[k]) map[k] = row;
    }
  }
  return map;
}

/**
 * The gate a roster payload implies.
 *
 * Module-scope and pure on purpose: it is called once by the live fetch and once
 * by the cache-seeded render, and if those produced different gates the cached
 * paint would be a quiet lie rather than a head start.
 */
function rosterGateOf(payload: ManagerRosterPayload): ManagerTeamGate {
  return payload.scope === 'elevated'
    ? { kind: 'elevated' }
    : { kind: 'department', departments: payload.departments };
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
  // Point the tab cache at this manager BEFORE any cached state below — or any
  // tab — reads it. Unlike the Employee shell this component renders its tabs
  // immediately and resolves `viewerEmail` in the effect below, so the first
  // render binds `null` and every cached read correctly misses; the render in
  // which the email arrives is what seeds them. See `useManagerCachedState`.
  useManagerCacheIdentity(viewerEmail);

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

  const [pendingApprovals, setPendingApprovals] = useManagerCachedState(
    MANAGER_CACHE_KEYS.pendingApprovalCount,
    0,
  );
  // All pending requests (newest first) + signed URLs for their evidence images —
  // the Overview gallery hero cycles through them.
  const [pendingRequests, setPendingRequests] = useManagerCachedState<TimeAdjustmentRow[]>(
    MANAGER_CACHE_KEYS.timeAdjustmentRows,
    [],
  );
  // NOT cached: these are signed storage URLs with an expiry. A cached one paints
  // a broken image where an uncached one paints nothing, so they are re-fetched
  // cold every time and the rows above carry the paint on their own.
  const [pendingSignedUrls, setPendingSignedUrls] = useState<Record<string, string>>({});
  // MUST stay referentially stable. `ManagerTimeAdjustments` folds this callback
  // into its fetch closure, so an inline arrow here re-created the closure on
  // every render of this shell — and because `useManagerCachedState`'s setter
  // returns a fresh `{key, value}` object on every call (React can never bail
  // out), each answered fetch re-rendered the shell, which refired the fetch.
  // That loop hammered the endpoint for as long as the tab was open and flashed
  // the tab's skeleton over the list several times a second.
  const handleApprovalCountChange = React.useCallback(
    (n: number) => setPendingApprovals(n),
    [setPendingApprovals],
  );
  /** Whether the fetch below has answered at least once in this page load. */
  const [requestsSettled, setRequestsSettled] = useState(false);
  // Show the skeleton only when there is genuinely nothing to paint. This effect
  // re-runs on every tab switch to keep the badge live, and the old
  // `setRequestsLoading(true)` at the top of it re-showed the Overview's
  // approvals skeleton each time — with the rows already on screen and
  // unchanged. A cache hit (or a previous settle) now carries the paint through.
  const requestsLoading = !requestsSettled && pendingRequests.length === 0;
  // Keep the pending-approval badge live — refetch whenever the tab is opened.
  useEffect(() => {
    let cancelled = false;
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
        setRequestsSettled(true);
      })
      .catch(() => {
        if (cancelled) return;
        setPendingApprovals(0);
        setPendingRequests([]);
        setPendingSignedUrls({});
        setRequestsSettled(true);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // The roster payload is the cached unit; `teamMembers` and `teamGate` are both
  // derived from it, so a reload cannot resurrect a "loading" or "error" gate as
  // though it were a settled answer.
  const [roster, setRoster] = useManagerCachedState<ManagerRosterPayload | null>(
    MANAGER_CACHE_KEYS.teamRoster,
    null,
  );
  const [rosterError, setRosterError] = useState<string | null>(null);

  const teamMembers = useMemo(() => roster?.rows ?? NO_TEAM_MEMBERS, [roster]);
  const teamGate = useMemo<ManagerTeamGate>(() => {
    if (rosterError !== null) return { kind: 'error', message: rosterError };
    if (roster === null) return { kind: 'loading' };
    return rosterGateOf(roster);
  }, [roster, rosterError]);

  useEffect(() => {
    if (!authChecked) return;
    let cancelled = false;
    (async () => {
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
        setRosterError(null);
        setRoster({
          rows: json.rows ?? [],
          scope: json.scope === 'elevated' ? 'elevated' : 'department',
          departments: json.departments ?? [],
        });
      } catch (e) {
        if (!cancelled) {
          // Drop the cached roster too. The gate is about to say the roster
          // could not be loaded, and leaving a previous team on screen under
          // that banner would imply it is still the server's answer.
          setRoster(null);
          setRosterError(e instanceof Error ? e.message : 'Failed to load team roster');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked]);

  // Live count of pending leave requests across all departments. We re-fetch on tab
  // switch so the badge reflects approvals decided in the panel without a manual reload.
  // The COUNT is cached, not the list: `?scope=all` returns every leave request
  // in the company and this reads one number off it, so caching the rows would
  // spend the whole sessionStorage budget on data nothing else reads. The cached
  // value is the state itself, so there is no second derivation to drift.
  const [pendingLeaves, setPendingLeaves] = useManagerCachedState(
    MANAGER_CACHE_KEYS.pendingLeaveCount,
    0,
  );
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
                  onCountChange={handleApprovalCountChange}
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
                // collides, so a manager who owns both sees ONE at a time.
                //
                // **Departments is the default, and comes first** (Kane,
                // 2026-09-02). This used to scan `managed` in assignment order
                // and open whichever calculator owned the first-assigned dept,
                // which meant two managers with the same two calculators could
                // land on different screens for a reason neither of them could
                // see. A fixed default is one less thing to explain, and the
                // switch is now right there in the toolbar. The old
                // `firstAssigned` scan (and its "primary" marker) went with it.
                const both = hslVisible && deptVisible;
                const active: 'hsl' | 'dept' = both
                  ? (kpiCalc ?? 'dept')
                  : deptVisible
                    ? 'dept'
                    : 'hsl';

                // The switch used to be its own bar stacked above the
                // calculator. It now rides INSIDE whichever calculator is
                // showing, in the toolbar row that already holds that screen's
                // search box (Kane, 2026-09-02) — a full row of page chrome to
                // hold two buttons, directly above a toolbar, read as belonging
                // to the shell rather than to the work. Rendered once here and
                // handed to both, so the two calculators cannot drift into two
                // different-looking navigations.
                // Rendered once and handed to both calculators (and their
                // skeletons), so the two cannot drift into two different-looking
                // navigations. The component owns the sliding indicator — see
                // `kpi-calculator-switch.tsx` for why it must be a `layoutId`.
                const calculatorSwitch = both ? (
                  <KpiCalculatorSwitch active={active} onChange={setKpiCalc} />
                ) : null;

                return (
                  <div className="flex min-h-0 flex-col">
                    {/* A hard swap, on purpose. A crossfade was tried here and
                        pulled (Kane, 2026-09-02: the switch "should not fade
                        out"): the switch lives INSIDE the calculator's toolbar,
                        so fading the calculator faded the navigation with it,
                        and the fade was covering for a jump the indicator no
                        longer makes. Both calculators now paint the identical
                        header, so the only thing that visibly moves on a swap is
                        the switch's pill gliding to the other tab — which its
                        `layoutId` carries across this unmount/mount. No wrapper,
                        no transform: a transformed ancestor re-anchors
                        `position: fixed`, which is what forced the HSL branch
                        overlay into a portal in the first place. */}
                    {active === 'hsl' && hslVisible && (
                      <HslBonusCalculator
                        viewerEmail={viewerEmail}
                        managedDepts={managed}
                        isElevated={elevated}
                        calculatorSwitch={calculatorSwitch}
                        dispatchLock={payrollProcessing}
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
                        calculatorSwitch={calculatorSwitch}
                        dispatchLock={payrollProcessing}
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
  /** Whether the KPI Calculator tab is available to this viewer — the bonus
   *  rows and the scoring stat are hidden when it isn't (nothing to click
   *  through to). */
  canScoreBonuses: boolean;
  /** False while feature permissions / the department gate are still resolving.
   *  `canScoreBonuses` isn't trustworthy until then, so the cell holds a
   *  skeleton rather than flashing "no access" at a manager who has it. */
  scoringGateReady: boolean;
  onJumpToApprovals: () => void;
  onJumpToTeam: () => void;
  onViewEmployee: (email: string) => void;
  /** Open the KPI Calculator, optionally landing on one department's card. */
  onJumpToScoring: (dept?: { kind: 'hsl' | 'catalog'; key: string }) => void;
}

/**
 * The manager's front page, rebuilt 2026-09-02: a greeting, a divided band of
 * four numbers, and then the only two questions this page answers — *what needs
 * me* on the left, *who is on my roster* on the right.
 *
 * Two streams that used to be separate cards (pending approvals, bonus
 * departments still owed to payroll) are merged into one ordered "Needs you"
 * list, so the manager reads one queue instead of triaging across panels.
 *
 * The accent is the theme's own `--secondary` blue; `--primary` orange is
 * reserved app-wide and, at 2.7:1 on these surfaces, could not carry small text
 * at AA. Presence stays emerald because "online" is its own meaning, not an
 * accent. Radii follow the app's `--radius`, matching the sibling tabs.
 *
 * Nothing here decides anything. Every row is a link into the surface that owns
 * the decision — approvals to the Time Adjustments queue where the evidence
 * photo lives, bonus rows to that department's KPI Calculator card.
 */
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
  const [realName, setRealName] = useManagerCachedState<string | null>(
    MANAGER_CACHE_KEYS.viewerName,
    null,
  );
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
  // the stat cell and the bonus rows below so both read one fetch.
  const scoring = useBonusScoringQueue({
    managedDepts: teamGate.kind === 'department' ? teamGate.departments : [],
    isElevated: teamGate.kind === 'elevated',
    ready: scoringGateReady && canScoreBonuses && teamGate.kind !== 'loading',
  });
  // Keep the cell's slot while the gate resolves; drop it once we know the
  // viewer has no KPI Calculator to click through to.
  const showScoring = !scoringGateReady || canScoreBonuses;

  // Who on this roster is tracking time right now. One presence read feeds both
  // the "Active right now" number and the finder's default list.
  const onlineEmails = useOnlineEmails();
  const isOnline = React.useCallback(
    (m: EmployeeRow) => {
      const w = normEmail(m.work_email ?? '');
      const p = normEmail(m.personal_email ?? '');
      return (!!w && onlineEmails.has(w)) || (!!p && onlineEmails.has(p));
    },
    [onlineEmails],
  );
  const activeMembers = useMemo(() => teamMembers.filter(isOnline), [teamMembers, isOnline]);

  // The two to-do streams, merged into one ordered list. Approvals first: they
  // are the only rows on this page that hold up somebody's pay.
  const needsItems = useMemo<NeedsItem[]>(() => {
    const out: NeedsItem[] = pendingRequests.map((r) => ({
      kind: 'approval',
      id: `approval:${r.id}`,
      row: r,
    }));
    if (showScoring && !scoring.weekUnresolved) {
      for (const d of scoring.items) {
        // `nothing` means the department has no bonuses assigned this week —
        // not a to-do, and listing it would read as a false debt.
        if (d.state === 'nothing') continue;
        out.push({ kind: 'bonus', id: `bonus:${d.kind}:${d.key}`, dept: d });
      }
    }
    return out;
  }, [pendingRequests, showScoring, scoring.items, scoring.weekUnresolved]);

  const bonusCount = needsItems.filter((i) => i.kind === 'bonus').length;
  const [filter, setFilter] = useState<NeedsFilter>('all');
  // A filter must never be the reason a row is invisible: when the stream the
  // manager picked empties out, fall back to everything rather than showing a
  // bare "nothing here" over rows that do exist.
  const effectiveFilter: NeedsFilter =
    (filter === 'approvals' && pendingRequests.length === 0) ||
    (filter === 'bonuses' && bonusCount === 0)
      ? 'all'
      : filter;
  const visibleItems = useMemo(
    () =>
      effectiveFilter === 'all'
        ? needsItems
        : needsItems.filter((i) =>
            effectiveFilter === 'approvals' ? i.kind === 'approval' : i.kind === 'bonus',
          ),
    [needsItems, effectiveFilter],
  );

  const payWeek =
    showScoring && scoring.weekStart ? fmtPayWeek(scoring.weekStart, scoring.weekEnd) : null;

  // One honest sentence about the state of the desk. Built from the same counts
  // the band prints, so it can never contradict them.
  const summary = useMemo(() => {
    const parts: string[] = [];
    parts.push(
      pendingApprovals === 0
        ? 'Nothing is waiting on your sign-off'
        : `${pendingApprovals} ${pendingApprovals === 1 ? 'request is' : 'requests are'} waiting on your sign-off`,
    );
    if (showScoring && !scoring.loading) {
      if (scoring.weekUnresolved) parts.push('bonus scoring opens once this week’s hours land');
      else if (scoring.items.length > 0)
        parts.push(
          scoring.outstanding === 0
            ? 'every bonus department is in'
            : `${scoring.outstanding} bonus ${scoring.outstanding === 1 ? 'department still needs' : 'departments still need'} scoring`,
        );
    }
    if (activeMembers.length > 0)
      parts.push(
        `${activeMembers.length} ${activeMembers.length === 1 ? 'person is' : 'people are'} tracking time right now`,
      );
    if (parts.length === 1) return `${parts[0]}.`;
    return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}.`;
  }, [
    pendingApprovals,
    showScoring,
    scoring.loading,
    scoring.weekUnresolved,
    scoring.items.length,
    scoring.outstanding,
    activeMembers.length,
  ]);

  const rosterHint =
    teamGate.kind === 'loading'
      ? 'Loading roster…'
      : teamGate.kind === 'error'
        ? 'Could not load roster'
        : teamGate.kind === 'department' && teamGate.departments.length === 0
          ? 'No departments assigned yet'
          : teamGate.kind === 'department'
            ? teamGate.departments.map(formatDeptLabel).join(', ')
            : teamCount === 0
              ? 'No matching employees'
              : 'Active roster (org-wide)';

  return (
    <div className="ov-root flex w-full flex-1 flex-col gap-3 px-4 py-4 sm:px-6 lg:min-h-0 lg:overflow-hidden lg:px-8 lg:py-5">
      {/* Browser surfaces the page didn't draw — selection, caret, focus ring
          and the finder's scrollbar — carry the accent instead of the UA
          default. Scoped to this subtree so no other tab inherits it. */}
      <style>{`
        .ov-root ::selection { background: hsl(var(--secondary) / 0.2); color: inherit; }
        .ov-root { caret-color: hsl(var(--secondary)); }
        .ov-root :focus-visible {
          outline: 2px solid hsl(var(--secondary));
          outline-offset: 2px;
          border-radius: 0.375rem;
        }
        .ov-scroll { scrollbar-width: thin; scrollbar-color: hsl(var(--secondary) / 0.3) transparent; }
        .ov-scroll::-webkit-scrollbar { width: 6px; }
        .ov-scroll::-webkit-scrollbar-track { background: transparent; }
        .ov-scroll::-webkit-scrollbar-thumb {
          background: hsl(var(--secondary) / 0.3);
          border-radius: 999px;
        }
        .ov-scroll:hover::-webkit-scrollbar-thumb { background: hsl(var(--secondary) / 0.5); }
      `}</style>

      {/* ── Greeting ─────────────────────────────────────────────────────── */}
      <header className="shrink-0 rounded-2xl border border-zinc-200/80 bg-secondary/[0.06] px-5 py-5 sm:px-8 sm:py-6 dark:border-zinc-800 dark:bg-secondary/[0.08]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between lg:gap-10">
          <div className="min-w-0">
            {/* A dateline, not a label: it names the pay week every number on
                this page is scoped to. Omitted entirely when no week is
                resolved — a decorative "Manager workspace" line would say
                nothing the sidebar hasn't already said. */}
            {payWeek && (
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-secondary">
                Pay week · {payWeek}
              </p>
            )}
            <h1 className="text-[clamp(1.5rem,2.9vw,2rem)] font-bold leading-[1.1] tracking-[-0.03em] text-slate-900 text-balance dark:text-slate-50">
              Hi {greeting}
            </h1>
            <p className="mt-2 max-w-[52ch] text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              {summary}
            </p>
          </div>

          <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:w-[17rem] lg:flex-col">
            <button
              type="button"
              onClick={onJumpToApprovals}
              className="group inline-flex items-center justify-between gap-3 rounded-xl bg-secondary px-4 py-2.5 text-sm font-semibold text-secondary-foreground shadow-sm transition hover:brightness-110 sm:flex-1 lg:flex-none"
            >
              {pendingApprovals > 0 ? 'Work the queue' : 'Open approvals'}
              <span className="inline-flex items-center gap-2">
                {pendingApprovals > 0 && (
                  <span className="tabular-nums opacity-80">{pendingApprovals}</span>
                )}
                <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </button>
            {showScoring && (
              <button
                type="button"
                onClick={() => onJumpToScoring()}
                className="group inline-flex items-center justify-between gap-3 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:border-slate-400 hover:bg-slate-50 sm:flex-1 lg:flex-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:hover:border-slate-600 dark:hover:bg-slate-900"
              >
                Open KPI calculator
                <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ── The four numbers ─────────────────────────────────────────────── */}
      <section
        aria-label="Your week at a glance"
        className="grid shrink-0 grid-cols-2 overflow-hidden rounded-2xl border border-zinc-200/80 bg-white lg:grid-cols-4 dark:border-zinc-800 dark:bg-zinc-950"
      >
        <StatCell
          label="Pending approvals"
          value={pendingApprovals}
          hint={pendingApprovals === 0 ? 'Nothing in your queue' : 'Awaiting your sign-off'}
          urgent={pendingApprovals > 0}
          onClick={onJumpToApprovals}
        />
        <StatCell
          label="Bonuses to score"
          value={
            !showScoring || scoring.loading || scoring.weekUnresolved ? '—' : scoring.outstanding
          }
          hint={
            !showScoring
              ? 'No KPI Calculator access'
              : scoring.loading
                ? 'Checking this pay cycle…'
                : scoring.weekUnresolved
                  ? 'Waiting on this week’s hours'
                  : scoring.items.length === 0
                    ? 'No bonus departments assigned'
                    : scoring.outstanding === 0
                      ? `All ${scoring.items.length} submitted`
                      : `of ${scoring.items.length} still open`
          }
          urgent={showScoring && !scoring.loading && scoring.outstanding > 0}
          onClick={showScoring ? () => onJumpToScoring() : undefined}
        />
        <StatCell
          label="Active right now"
          value={teamGate.kind === 'loading' ? '—' : activeMembers.length}
          hint={activeMembers.length === 0 ? 'Nobody tracking time' : 'Tracking time this hour'}
          live={activeMembers.length > 0}
        />
        <StatCell
          label="On your roster"
          value={teamCount === null ? '—' : teamCount.toLocaleString('en-US')}
          hint={rosterHint}
          onClick={onJumpToTeam}
        />
      </section>

      {/* ── Work + finder ────────────────────────────────────────────────── */}
      <div className="grid flex-1 grid-cols-1 gap-3 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
        <NeedsYouPanel
          items={visibleItems}
          totalCount={needsItems.length}
          approvalCount={pendingRequests.length}
          bonusCount={bonusCount}
          filter={effectiveFilter}
          onFilter={setFilter}
          signedUrls={pendingSignedUrls}
          loading={requestsLoading || (showScoring && scoring.loading)}
          mounted={mounted}
          weekUnresolved={showScoring && scoring.weekUnresolved}
          scoringError={showScoring ? scoring.error : null}
          onReviewApproval={onJumpToApprovals}
          onOpenScoring={onJumpToScoring}
        />
        <PersonFinder
          members={teamMembers}
          activeMembers={activeMembers}
          totalCount={teamCount}
          loading={teamGate.kind === 'loading'}
          onViewEmployee={onViewEmployee}
          onOpenTeam={onJumpToTeam}
        />
      </div>
    </div>
  );
}

// ─── Overview: one number in the band ────────────────────────────────────────

/**
 * A cell in the stat band, not a card of its own: the band's hairlines separate
 * it, so it carries no border or shadow. Numerals are tabular so the four values
 * hold a common width as they change.
 */
function StatCell({
  label,
  value,
  hint,
  urgent,
  live,
  onClick,
}: {
  label: string;
  value: number | string;
  hint: string;
  urgent?: boolean;
  live?: boolean;
  onClick?: () => void;
}) {
  const Wrapper = onClick ? 'button' : 'div';
  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'group relative border-zinc-200/80 px-5 py-4 text-left transition-colors dark:border-zinc-800',
        // Interior hairlines only — the band's own radius supplies the edges.
        '[&:nth-child(odd)]:border-r [&:nth-child(-n+2)]:border-b',
        'lg:[&:nth-child(n)]:border-b-0 lg:[&:nth-child(n)]:border-r lg:[&:last-child]:border-r-0',
        onClick && 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/60',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600 dark:text-zinc-400">
          {label}
        </span>
        {live && (
          <span className="relative flex h-1.5 w-1.5" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
        )}
      </div>
      <div
        className={cn(
          'mt-1 text-[clamp(1.5rem,2.6vw,2rem)] font-bold leading-none tabular-nums tracking-[-0.035em]',
          urgent ? 'text-secondary' : 'text-zinc-900 dark:text-zinc-50',
        )}
      >
        {value}
      </div>
      <div className="mt-1 truncate text-[11px] text-zinc-600 dark:text-zinc-400" title={hint}>
        {hint}
      </div>
    </Wrapper>
  );
}

// ─── Overview: what needs you ────────────────────────────────────────────────

/** One row of the merged to-do list. Approvals and bonus scoring only. */
type NeedsItem =
  | { kind: 'approval'; id: string; row: TimeAdjustmentRow }
  | { kind: 'bonus'; id: string; dept: BonusScoringItem };

type NeedsFilter = 'all' | 'approvals' | 'bonuses';

/** How many rows the panel shows before deferring to the owning surface. */
const NEEDS_PREVIEW = 8;

/** "2 days waiting" / "Today" — how long a request has sat. Client-only. */
function waitedLabel(iso: string): string | null {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'Today';
  return `${days} ${days === 1 ? 'day' : 'days'} waiting`;
}

function NeedsYouPanel({
  items,
  totalCount,
  approvalCount,
  bonusCount,
  filter,
  onFilter,
  signedUrls,
  loading,
  mounted,
  weekUnresolved,
  scoringError,
  onReviewApproval,
  onOpenScoring,
}: {
  items: NeedsItem[];
  totalCount: number;
  approvalCount: number;
  bonusCount: number;
  filter: NeedsFilter;
  onFilter: (f: NeedsFilter) => void;
  signedUrls: Record<string, string>;
  loading: boolean;
  mounted: boolean;
  weekUnresolved: boolean;
  scoringError: string | null;
  onReviewApproval: () => void;
  onOpenScoring: (dept?: { kind: 'hsl' | 'catalog'; key: string }) => void;
}) {
  const rows = items.slice(0, NEEDS_PREVIEW);
  const hidden = items.length - rows.length;

  const tabs: { id: NeedsFilter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: totalCount },
    { id: 'approvals', label: 'Approvals', count: approvalCount },
    { id: 'bonuses', label: 'Bonuses', count: bonusCount },
  ];

  return (
    <section
      aria-label="What needs you"
      className="flex min-w-0 flex-col rounded-2xl border border-zinc-200/80 bg-white px-4 py-5 sm:px-6 lg:min-h-0 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="min-w-0 text-lg font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
          Needs you
        </h2>
        {totalCount > 0 && (
          <div
            role="tablist"
            aria-label="Filter what needs you"
            className="flex shrink-0 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800"
          >
            {tabs.map((t, i) => (
              <button
                key={t.id}
                role="tab"
                type="button"
                aria-selected={filter === t.id}
                disabled={t.count === 0 && t.id !== 'all'}
                onClick={() => onFilter(t.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold transition',
                  i > 0 && 'border-l border-zinc-200 dark:border-zinc-800',
                  filter === t.id
                    ? 'bg-secondary text-secondary-foreground'
                    : 'bg-transparent text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:text-zinc-400 dark:hover:bg-zinc-900',
                )}
              >
                {t.label}
                <span className="tabular-nums opacity-70">{t.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        <div className="ov-scroll -mx-1 flex min-h-0 flex-1 flex-col px-1 lg:overflow-y-auto">
        {loading ? (
          <ul className="space-y-1.5">
            {[0, 1, 2].map((i) => (
              <li
                key={i}
                className="flex items-start gap-3 rounded-xl border border-zinc-100 px-3 py-3 dark:border-zinc-800"
              >
                <div className="h-10 w-10 shrink-0 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-2.5 w-1/5 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                  <div className="h-3 w-2/5 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                  <div className="h-2.5 w-3/5 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                </div>
              </li>
            ))}
          </ul>
        ) : rows.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
              <CheckCircle2 className="h-5 w-5" />
            </span>
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              You&apos;re all clear
            </p>
            <p className="max-w-[34ch] text-xs text-zinc-600 dark:text-zinc-400">
              {weekUnresolved
                ? 'Nothing is waiting on your sign-off. Bonus scoring unlocks once Accounting uploads this week’s Hubstaff hours.'
                : 'Nothing is waiting on your sign-off. New time adjustments and bonus weeks land here.'}
            </p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((item) =>
              item.kind === 'approval' ? (
                <ApprovalRow
                  key={item.id}
                  row={item.row}
                  thumb={
                    (item.row.image_paths ?? []).map((p) => signedUrls[p]).find(Boolean) ?? null
                  }
                  mounted={mounted}
                  onReview={onReviewApproval}
                />
              ) : (
                <BonusRow key={item.id} dept={item.dept} onOpen={onOpenScoring} />
              ),
            )}
          </ul>
        )}
        </div>

        {/* Pinned under the scroll area: the count of what didn't fit, and any
            scoring error, must stay visible however far the list is scrolled. */}
        {hidden > 0 && (
          <button
            type="button"
            onClick={onReviewApproval}
            className="mt-2.5 inline-flex shrink-0 items-center gap-1 self-start text-xs font-semibold text-secondary hover:underline"
          >
            +{hidden} more waiting
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}

        {scoringError && (
          <p className="mt-2.5 shrink-0 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            {scoringError}
          </p>
        )}
      </div>
    </section>
  );
}

/** A pending time adjustment. Opens the queue — the decision needs the photo. */
function ApprovalRow({
  row,
  thumb,
  mounted,
  onReview,
}: {
  row: TimeAdjustmentRow;
  thumb: string | null;
  mounted: boolean;
  onReview: () => void;
}) {
  // Date.now() would not match the server render, so the age only appears after
  // mount rather than tripping a hydration mismatch.
  const waited = mounted ? waitedLabel(row.created_at) : null;

  return (
    <li>
      <button
        type="button"
        onClick={onReview}
        className="group flex w-full items-start gap-3 rounded-xl border border-zinc-100 px-3 py-3 text-left transition hover:border-blue-200 hover:bg-blue-50/50 dark:border-zinc-800 dark:hover:border-blue-900 dark:hover:bg-blue-950/20"
      >
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed storage URL
          <img src={thumb} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
        ) : (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-600">
            <ImageOff className="h-4 w-4" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-secondary">
              Approval
            </span>
            {waited && (
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{waited}</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {row.work_email}
          </p>
          <p className="mt-0.5 truncate text-[12px] text-zinc-600 dark:text-zinc-400">
            {TA_REASON_LABEL(row.reason)}
            <span className="mx-1.5 text-zinc-400 dark:text-zinc-600">·</span>
            <span className="font-mono text-[11px]">{row.adjust_date}</span>
            {row.requested_hours != null && (
              <>
                <span className="mx-1.5 text-zinc-400 dark:text-zinc-600">·</span>
                {/* Rounded for display, like the review table. Raw, this
                    printed `4.566666666666666h` on the Overview too. */}
                {fmtAdjustmentHours(row.requested_hours)}
              </>
            )}
          </p>
        </div>
        <span className="mt-2 hidden shrink-0 items-center gap-1 text-xs font-semibold text-zinc-500 transition-colors group-hover:text-secondary sm:inline-flex dark:text-zinc-400">
          Review
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </button>
    </li>
  );
}

/** One bonus department for the live pay week. Opens its calculator card. */
function BonusRow({
  dept,
  onOpen,
}: {
  dept: BonusScoringItem;
  onOpen: (d: { kind: 'hsl' | 'catalog'; key: string }) => void;
}) {
  const chip = SCORING_CHIP[dept.state];
  const pending = isOutstanding(dept.state);

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen({ kind: dept.kind, key: dept.key })}
        className={cn(
          'group flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition',
          pending
            ? 'border-zinc-100 hover:border-blue-200 hover:bg-blue-50/50 dark:border-zinc-800 dark:hover:border-blue-900 dark:hover:bg-blue-950/20'
            : 'border-zinc-100 hover:border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:bg-zinc-900/60',
        )}
      >
        {/* The department's own colour, kept to a slim bar inside the same
            10×10 slot the approval thumbnails use — enough to identify the
            department at a glance without a block of saturated colour on
            every row. */}
        <span className="flex h-10 w-10 shrink-0 items-center justify-center" aria-hidden>
          <span
            className="h-9 w-1.5 rounded-full"
            style={{ backgroundColor: dept.color }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              className={cn(
                'text-[11px] font-bold uppercase tracking-[0.1em]',
                pending ? 'text-secondary' : 'text-zinc-500 dark:text-zinc-400',
              )}
            >
              Bonus
            </span>
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {dept.cadence === 'monthly' ? 'Month end' : 'Weekly'}
            </span>
          </div>
          <p className="mt-0.5 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {dept.name}
          </p>
          <p className="mt-0.5 truncate text-[12px] text-zinc-600 dark:text-zinc-400">
            {dept.scoredCount > 0 ? (
              <>
                {dept.scoredCount} scored
                {dept.totalBonus > 0 && (
                  <>
                    <span className="mx-1.5 text-zinc-400 dark:text-zinc-600">·</span>
                    <span className="font-mono text-[11px]">
                      ₱{dept.totalBonus.toLocaleString('en-PH')}
                    </span>
                  </>
                )}
              </>
            ) : dept.state === 'not_due' ? (
              'Pays on the month’s final week'
            ) : (
              'Waiting on your scores'
            )}
          </p>
        </div>
        <span
          className={cn(
            'mt-2 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold',
            chip.cls,
          )}
        >
          {chip.label}
        </span>
      </button>
    </li>
  );
}

// ─── Overview: find a person ─────────────────────────────────────────────────

/** Rows the finder renders at once — the list scrolls rather than paging. */
const FINDER_LIMIT = 60;

/**
 * Search the whole roster by name, email or team. With no query it lists who is
 * tracking time right now — the only roster slice that changes minute to minute
 * and the reason a manager looks at this rail unprompted.
 */
function PersonFinder({
  members,
  activeMembers,
  totalCount,
  loading,
  onViewEmployee,
  onOpenTeam,
}: {
  members: EmployeeRow[];
  activeMembers: EmployeeRow[];
  totalCount: number | null;
  loading: boolean;
  onViewEmployee: (email: string) => void;
  onOpenTeam: () => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const results = useMemo(() => {
    if (!q) return null;
    return members
      .filter((m) => {
        const dept = formatDeptLabel(m.department);
        return (
          (m.name ?? '').toLowerCase().includes(q) ||
          (m.work_email ?? '').toLowerCase().includes(q) ||
          (m.personal_email ?? '').toLowerCase().includes(q) ||
          dept.toLowerCase().includes(q)
        );
      })
      .slice(0, FINDER_LIMIT);
  }, [members, q]);

  const activeSet = useMemo(() => new Set(activeMembers), [activeMembers]);
  const listed = results ?? activeMembers.slice(0, FINDER_LIMIT);
  const heading = results ? 'Results' : 'Active right now';
  const headingCount = results
    ? `${results.length}${results.length === FINDER_LIMIT ? '+' : ''}`
    : `${activeMembers.length} of ${(totalCount ?? members.length).toLocaleString('en-US')}`;

  return (
    <aside
      aria-label="Find a person"
      className="flex min-w-0 flex-col rounded-2xl border border-zinc-200/80 bg-white px-4 py-5 sm:px-5 lg:min-h-0 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <h2 className="text-lg font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
        Find a person
      </h2>
      <div className="relative mt-3">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name or team…"
          aria-label="Search your roster by name, email or team"
          className="w-full rounded-xl border border-zinc-200 bg-white py-2.5 pl-9 pr-3 text-sm text-zinc-900 placeholder:text-zinc-500 focus:border-secondary focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />
      </div>

      <div className="mt-4 flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600 dark:text-zinc-400">
          {heading}
        </span>
        <span className="text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
          {loading ? '—' : headingCount}
        </span>
      </div>

      <div className="ov-scroll mt-1.5 max-h-[22rem] min-h-0 flex-1 overflow-y-auto lg:max-h-none">
        {loading ? (
          <ul className="space-y-1">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="flex items-center gap-2.5 px-2 py-2">
                <div className="h-8 w-8 shrink-0 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="h-2.5 w-1/2 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                  <div className="h-2 w-1/3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                </div>
              </li>
            ))}
          </ul>
        ) : listed.length === 0 ? (
          <p className="px-2 py-8 text-center text-xs text-zinc-600 dark:text-zinc-400">
            {results
              ? `Nobody on your roster matches “${query.trim()}”.`
              : 'Nobody on your roster is tracking time right now.'}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {listed.map((m, i) => {
              const email = m.work_email ?? m.personal_email ?? null;
              const online = activeSet.has(m);
              const dept = formatDeptLabel(m.department);
              return (
                <li key={email ?? m.name ?? `member-${i}`}>
                  <button
                    type="button"
                    onClick={() => (email ? onViewEmployee(email) : onOpenTeam())}
                    className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
                  >
                    <span className="relative shrink-0">
                      <SpotlightAvatar name={m.name ?? '—'} email={email} px={32} />
                      {online && (
                        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-zinc-950" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
                        {m.name ?? email ?? '—'}
                      </p>
                      <p className="truncate text-[11px] text-zinc-600 dark:text-zinc-400">
                        {dept || 'No department'}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400 transition-colors group-hover:text-secondary dark:text-zinc-600" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {members.length > 0 && (
        <button
          type="button"
          onClick={onOpenTeam}
          className="mt-3 inline-flex shrink-0 items-center gap-1 self-start text-xs font-semibold text-secondary hover:underline"
        >
          Open My Team
          {totalCount !== null && (
            <span className="tabular-nums">· {totalCount.toLocaleString('en-US')} people</span>
          )}
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}
    </aside>
  );
}

// ─── Overview: shared bits ───────────────────────────────────────────────────

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
        'flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-bold text-white',
        gradientFor(seed),
      )}
      style={{ height: px, width: px, fontSize: Math.round(px * 0.34) }}
    >
      {initialsOf(name, email)}
    </div>
  );
}

/** "Jul 20 – Jul 26" for a resolved pay week; an em dash before it resolves. */
function fmtPayWeek(start: string | null, end: string | null): string {
  if (!start) return '—';
  const opts = { month: 'short', day: 'numeric' } as const;
  const s = new Date(`${start}T00:00:00`).toLocaleDateString('en-US', opts);
  if (!end) return s;
  return `${s} – ${new Date(`${end}T00:00:00`).toLocaleDateString('en-US', opts)}`;
}

/** How the chip for each scoring state reads. Two groups only, visually: things
 *  that still need the manager, and things already handled. Status keeps its own
 *  semantics — amber stays warning, emerald stays done — so the blue accent
 *  never has to mean two different things on one row. */
const SCORING_CHIP: Record<ScoringState, { label: string; cls: string }> = {
  todo: {
    label: 'Not scored',
    cls: 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300',
  },
  in_progress: {
    label: 'Draft',
    cls: 'bg-blue-100 text-blue-900 dark:bg-blue-500/15 dark:text-blue-300',
  },
  submitted: {
    label: 'Submitted',
    cls: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-300',
  },
  locked: {
    label: 'Locked',
    cls: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-300',
  },
  nothing: {
    label: 'No bonuses',
    cls: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  },
  not_due: {
    label: 'Month end',
    cls: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  },
};

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
//
// The review workspace itself lives in its own file, like ManagerTransfers —
// rebuilt 2026-09-02 from `references/design_handoff_time_adjustments/`. Only the
// reason-label helper stays here, because the Overview's approvals gallery reads
// it too.

import type { TimeAdjustmentRow } from '@/lib/supabase/time-adjustments';
import { TIME_ADJUSTMENT_REASONS } from '@/lib/supabase/time-adjustments';
import { fmtAdjustmentHours } from '@/lib/manager/time-adjustment-queue';
import ManagerTimeAdjustments from '@/components/manager/ManagerTimeAdjustments';

const TA_REASON_LABEL = (code: string) =>
  TIME_ADJUSTMENT_REASONS.find((r) => r.code === code)?.label ?? code;

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
  // The manager's own outbox. The RAW rows are the cached unit; the per-email
  // status + note maps are re-derived from them by `deriveOffboardBadges`, which
  // both the fetch path and the cache-seeded render call.
  const [offboardQueueRows, setOffboardQueueRows] = useManagerCachedState<OffboardOutboxRow[]>(
    MANAGER_CACHE_KEYS.offboardingQueue,
    [],
  );
  const { status: offboardStatus, note: offboardNote } = useMemo(
    () => deriveOffboardBadges(offboardQueueRows),
    [offboardQueueRows],
  );

  const memberKey = (m: EmployeeRow): string =>
    (m.work_email ?? m.personal_email ?? m.name ?? '').trim().toLowerCase();

  // Effective CallTools username = inline-edit override (if any) else the value
  // decorated onto the row by /api/manager/department-members.
  const callToolsValue = (m: EmployeeRow): string | null => {
    const k = memberKey(m);
    return k in callToolsOverrides ? callToolsOverrides[k] : m.calltools_username ?? null;
  };

  const loadOffboardOutbox = React.useCallback(() => {
    fetch('/api/offboarding-queue', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((j: { rows?: OffboardOutboxRow[] }) => {
        setOffboardQueueRows(j.rows ?? []);
      })
      .catch(() => {
        /* non-fatal — badges just won't show */
      });
    // `setOffboardQueueRows` is a stable useCallback from the cached-state hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  // RAW rows cached; the pending-by-email map is derived by
  // `derivePendingResignations` on both the seeded and the fetched path.
  const [resignationRows, setResignationRows] = useManagerCachedState<ResignationRequestRow[]>(
    MANAGER_CACHE_KEYS.resignations,
    [],
  );
  const resignations = useMemo(
    () => derivePendingResignations(resignationRows),
    [resignationRows],
  );
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
        setResignationRows(j.rows ?? []);
      })
      .catch(() => {
        /* non-fatal — the roster just won't float resigning people */
      });
    // `setResignationRows` is a stable useCallback from the cached-state hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // RAW rows cached; the by-email map is derived by `deriveSkillSetMap` on both
  // the seeded and the fetched path.
  const [skillSetRows, setSkillSetRows] = useManagerCachedState<SkillSetRow[]>(
    MANAGER_CACHE_KEYS.skillSets,
    [],
  );
  const skillSets = useMemo(() => deriveSkillSetMap(skillSetRows), [skillSetRows]);
  const teamWorkEmails = useMemo(
    () => members.map((m) => normEmail(m.work_email ?? '') ?? '').filter(Boolean),
    [members],
  );
  const teamWorkEmailsKey = teamWorkEmails.join(',');
  useEffect(() => {
    if (!teamWorkEmailsKey) {
      setSkillSetRows([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/employee-skill-sets?emails=${encodeURIComponent(teamWorkEmailsKey)}`, {
      cache: 'no-store',
    })
      .then((r) => r.json())
      .then((j: { rows?: SkillSetRow[] }) => {
        if (cancelled) return;
        setSkillSetRows(j.rows ?? []);
      })
      .catch(() => {
        /* non-fatal — cards just render without skill-set detail */
      });
    return () => {
      cancelled = true;
    };
    // `setSkillSetRows` is a stable useCallback from the cached-state hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          // The saved note is applied to the cached ROW, not to the derived map —
          // the map is rebuilt from the rows, so writing it there would be
          // overwritten on the next render and would never reach the cache.
          setSkillSetRows((prev) => {
            const idx = prev.findIndex((r) => (normEmail(r.work_email ?? '') ?? '') === w);
            if (idx === -1) {
              return [
                ...prev,
                {
                  work_email: w,
                  role_title: '',
                  currently_working_on: '',
                  skills: '',
                  strengths: '',
                  member_notes: notes,
                  projects: [],
                  current_projects: [],
                },
              ];
            }
            const next = prev.slice();
            next[idx] = { ...next[idx], member_notes: notes };
            return next;
          });
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
