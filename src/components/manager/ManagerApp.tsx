'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import AppFooter from '@/components/AppFooter';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowRightLeft,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Eye,
  EyeOff,
  Inbox,
  Menu,
  Search,
  Sparkles,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Toaster } from '@/components/ui/sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { EmployeeRow } from '@/lib/supabase/employees';
import { normEmail } from '@/lib/email/norm-email';
import { SESSION_EMAIL_KEY, type Role } from '@/lib/rbac/views';
import { cn } from '@/lib/utils';
import ManagerSidebar, { type ManagerTab } from './ManagerSidebar';
import LeaveRequestsPanel from '@/components/LeaveRequestsPanel';
import type { LeaveRequestRow } from '@/lib/supabase/leave-requests';
import AnnouncementWall from '@/components/announcements/AnnouncementWall';
import AnnouncementComposer from '@/components/announcements/AnnouncementComposer';
import SWall from '@/components/swall/SWall';
import HslBonusCalculator from '@/components/manager/HslBonusCalculator';
import DeptBonusCalculator from '@/components/manager/DeptBonusCalculator';
import ManagerBonusHistory from '@/components/manager/ManagerBonusHistory';
import { HSL_DEPT_KEYS, canAccessHslDept } from '@/lib/hsl-bonus/schema';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { DEPT_INPUT_CONFIG } from '@/lib/payroll/department-bonus';
import ManagerMemberDialog from '@/components/manager/ManagerMemberDialog';
import ManagerTransferDialog from '@/components/manager/ManagerTransferDialog';
import NewlyHiredPanel from '@/components/manager/NewlyHiredPanel';
import NotificationsPanel from '@/components/notifications/NotificationsPanel';
import { useOnlineEmails } from '@/components/presence/PresenceProvider';
import {
  MedalProvider,
  MedalPalette,
  MedalBadges,
  useMedalCtx,
} from '@/components/manager/MedalRecognition';

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
        if (!cancelled) setAuthChecked(true);
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

  // Stub — wire to real /api/time-adjustments when that table lands.
  const pendingApprovals = 0;

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

  const handleNavigate = (tab: ManagerTab) => {
    setActiveTab(tab);
    setMobileNavOpen(false);
  };

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
              {activeTab === 'overview' && (
                <Overview
                  viewerEmail={viewerEmail}
                  pendingApprovals={pendingApprovals}
                  teamCount={teamGate.kind === 'loading' ? null : teamMembers.length}
                  teamGate={teamGate}
                  onJumpToApprovals={() => handleNavigate('time-adjustments')}
                  onJumpToTeam={() => handleNavigate('team')}
                />
              )}
              {activeTab === 'time-adjustments' && <TimeAdjustments />}
              {activeTab === 'leaves' && <LeaveRequestsPanel />}
              {activeTab === 'team' && (
                <TeamPanel members={teamMembers} teamGate={teamGate} viewerEmail={viewerEmail} />
              )}
              {activeTab === 'announcements' && (
                <ManagerAnnouncementsTab viewerEmail={viewerEmail} teamGate={teamGate} />
              )}
              {activeTab === 's-wall' && (
                <ManagerSwallTab viewerEmail={viewerEmail} />
              )}
              {activeTab === 'hsl-bonus' && (() => {
                const managed = teamGate.kind === 'department' ? teamGate.departments : [];
                const elevated = teamGate.kind === 'elevated';
                const hslVisible = elevated || HSL_DEPT_KEYS.some((k) => canAccessHslDept(managed, k, false));
                const deptVisible =
                  elevated ||
                  managed.some((dStr) => {
                    const k = normalizeDeptToKey(dStr);
                    return !!k && k in DEPT_INPUT_CONFIG;
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
                return (
                  <>
                    {hslVisible && (
                      <HslBonusCalculator viewerEmail={viewerEmail} managedDepts={managed} isElevated={elevated} />
                    )}
                    {deptVisible && (
                      <DeptBonusCalculator
                        viewerEmail={viewerEmail}
                        teamMembers={teamMembers}
                        managedDepts={managed}
                        isElevated={elevated}
                      />
                    )}
                  </>
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
                <NotificationsPanel viewerEmail={viewerEmail} accent="blue" />
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
  teamCount: number | null;
  teamGate: ManagerTeamGate;
  onJumpToApprovals: () => void;
  onJumpToTeam: () => void;
}

function Overview({
  viewerEmail,
  pendingApprovals,
  teamCount,
  teamGate,
  onJumpToApprovals,
  onJumpToTeam,
}: OverviewProps) {
  const firstName = viewerEmail?.includes('@')
    ? viewerEmail.split('@')[0]!.replace(/[._-]/g, ' ').split(' ')[0]
    : 'there';
  const greeting = firstName.charAt(0).toUpperCase() + firstName.slice(1);

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="relative overflow-hidden rounded-2xl border border-blue-100/70 bg-gradient-to-br from-blue-600 via-blue-700 to-black px-6 py-7 text-white shadow-lg shadow-blue-600/15 dark:border-blue-900/60 dark:from-blue-700 dark:via-blue-900 dark:to-black">
        <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-white/10 blur-3xl" aria-hidden />
        <div className="absolute -bottom-10 -left-10 h-32 w-32 rounded-full bg-blue-300/20 blur-2xl" aria-hidden />
        <div className="relative flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-blue-100/90">
            <Sparkles className="h-3 w-3" />
            Manager dashboard
          </div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Hi {greeting}, here's your team at a glance.
          </h1>
          <p className="max-w-2xl text-sm text-blue-100/80">
            Approve time adjustments, keep tabs on your direct reports, and (soon) submit
            KPI scores so accounting doesn't have to chase.
          </p>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatTile
          label="Pending approvals"
          value={pendingApprovals}
          hint={pendingApprovals === 0 ? 'Nothing in your queue' : 'Time adjustments awaiting your sign-off'}
          icon={ClipboardCheck}
          accent="blue-bright"
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
                    ? `Departments: ${teamGate.departments.join(', ')}`
                    : teamCount === 0
                      ? 'No matching employees in roster'
                      : 'Active roster (org-wide visibility)'
          }
          icon={Users}
          accent="blue-deep"
          onClick={onJumpToTeam}
        />
        <StatTile
          label="This pay cycle"
          value="—"
          hint="Sun–Sat. Bonus entry not wired yet."
          icon={Clock}
          accent="mono"
        />
      </section>

      <Card className="border-blue-100/80 bg-gradient-to-br from-white to-blue-50/50 ring-1 ring-blue-500/10 dark:border-blue-950/60 dark:from-zinc-950 dark:to-blue-950/20 dark:ring-blue-400/15">
        <CardHeader className="flex-row items-center gap-3 space-y-0 pb-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 text-white shadow-sm shadow-blue-500/30">
            <ClipboardCheck className="h-4 w-4" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-base">Time adjustment approvals</CardTitle>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Workers submit, two managers sign off, system posts to Hubstaff. No more email chains.
            </p>
          </div>
          <Button
            size="sm"
            className="bg-gradient-to-r from-blue-600 to-blue-700 text-white hover:from-blue-700 hover:to-blue-800"
            onClick={onJumpToApprovals}
          >
            Open queue
          </Button>
        </CardHeader>
        <CardContent className="grid gap-2 text-xs text-zinc-600 sm:grid-cols-2 dark:text-zinc-400">
          <Requirement icon={Camera} text="Screenshot proof attached to every request" />
          <Requirement icon={Clock} text="Exact start + end timestamps" />
          <Requirement icon={CheckCircle2} text="Two manager sign-offs before payroll sees it" />
          <Requirement icon={AlertTriangle} text="Auto-posts to Hubstaff once both approve" />
        </CardContent>
      </Card>

      <Card className="border-zinc-200/80 bg-white/70 ring-1 ring-zinc-900/5 dark:border-zinc-800 dark:bg-zinc-950/60 dark:ring-white/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">What's coming</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-zinc-600 dark:text-zinc-400">
          <ul className="grid gap-1.5 sm:grid-cols-2">
            <RoadmapItem text="Pick your team via simple.biz email" />
            <RoadmapItem text="Submit team transfers without email" />
            <RoadmapItem text="Enter KPI scores → auto-bonus calc" />
            <RoadmapItem text="Notifications when a request lands" />
          </ul>
        </CardContent>
      </Card>
    </div>
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

function TimeAdjustments() {
  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="flex flex-col gap-1">
        <h2 className="bg-gradient-to-r from-blue-700 via-zinc-900 to-zinc-900 bg-clip-text text-xl font-bold tracking-tight text-transparent dark:from-blue-400 dark:via-white dark:to-white">
          Time adjustment approvals
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Pending requests from your team. Approve or reject; two manager sign-offs send it to Hubstaff.
        </p>
      </header>

      <Card className="border-blue-100/70 bg-gradient-to-br from-white to-blue-50/40 ring-1 ring-blue-500/10 dark:border-blue-950/50 dark:from-zinc-950 dark:to-blue-950/15 dark:ring-blue-400/10">
        <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-white shadow-md shadow-blue-500/25">
            <Inbox className="h-6 w-6" />
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
              No pending approvals.
            </p>
            <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-400">
              Once the time-adjustment table lands, requests from your team will appear here.
              Approval requires a screenshot, exact timestamps, and a second manager's sign-off.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Team tab ───────────────────────────────────────────────────────────────

interface TeamPanelProps {
  members: EmployeeRow[];
  teamGate: ManagerTeamGate;
  viewerEmail: string | null;
}

function AnimatedRate({
  value,
  hidden,
  formatPhp,
}: {
  value: number | null | undefined;
  hidden: boolean;
  formatPhp: (v: number | null | undefined) => string;
}) {
  // opacity + translate only — `filter: blur` is GPU-expensive on mid-tier mobile
  // and stutters when many rows toggle at once. Translate alone reads as a swap.
  const transition = { duration: 0.16, ease: [0.22, 1, 0.36, 1] as const };
  return (
    <span className="inline-block transform-gpu">
      <AnimatePresence mode="wait" initial={false}>
        {hidden ? (
          <motion.span
            key="hidden"
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 3 }}
            transition={transition}
            className="inline-block select-none tracking-widest text-zinc-400 dark:text-zinc-600"
          >
            ••••••
          </motion.span>
        ) : value != null ? (
          <motion.span
            key="shown"
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 3 }}
            transition={transition}
            className="inline-block"
          >
            {formatPhp(value)}
          </motion.span>
        ) : (
          <motion.span
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="inline-block text-zinc-300 dark:text-zinc-700"
          >
            —
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

const TEAM_PAGE_SIZE = 10;

function memberHourlyRate(member: EmployeeRow): number | null {
  return member.hsl_hourly_rate ?? member.regular_rate ?? null;
}

function memberOtRate(member: EmployeeRow): number | null {
  return member.hsl_ot_rate ?? member.ot_rate ?? null;
}

function TeamPanelInner({ members, teamGate, viewerEmail }: TeamPanelProps) {
  const { draggedMedal, dragOverEmail, setDragOverEmail, openAwardForDrop } = useMedalCtx();

  // Inner tab toggle: Roster (existing) | Newly Hired (HR pending hires routed
  // here by department_managers) | AI Team (embedded ai-team.simple.biz site).
  // Lives inside the My Team panel so it doesn't claim a top-level sidebar slot.
  const [innerTab, setInnerTab] = useState<'roster' | 'newly-hired' | 'ai-team'>('roster');
  const unassigned = teamGate.kind === 'department' && teamGate.departments.length === 0;
  const scoped = teamGate.kind === 'department' && teamGate.departments.length > 0;
  const [ratesHidden, setRatesHidden] = useState(true);
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
  const [transferMember, setTransferMember] = useState<EmployeeRow | null>(null);
  const [page, setPage] = useState(1);
  const [deptFilter, setDeptFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [medalOpen, setMedalOpen] = useState(false);
  const showRateCol = members.some(
    (m) => memberHourlyRate(m) != null || memberOtRate(m) != null,
  );

  // ── My Team wallpaper banner — saved per-department in Supabase. The
  //    scope follows the **department filter dropdown** the manager picks
  //    above the roster table, so switching the filter swaps the wallpaper
  //    accordingly. When the filter is "All departments" we fall back to a
  //    `__all__` scope shared by every department.
  const wallpaperDept = useMemo(() => {
    return deptFilter && deptFilter !== 'all' ? deptFilter : '__all__';
  }, [deptFilter]);
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null);
  // True while the wallpaper for the active department is being fetched
  // (department switch or first mount). Drives the futuristic overlay so
  // there's no flash of stale image or empty gradient.
  const [wallpaperLoading, setWallpaperLoading] = useState(true);
  const [wallpaperPos, setWallpaperPos] = useState<string>('50% 50%');
  // Last position that's been persisted to the server. Used to compute the
  // "dirty" state so the Save button only appears after a real drag, and the
  // Reset button can roll back unsaved tweaks.
  const [savedWallpaperPos, setSavedWallpaperPos] = useState<string>('50% 50%');
  const [wallpaperPosSaving, setWallpaperPosSaving] = useState(false);
  // Position is locked by default. The manager clicks "Reposition" to enter
  // edit mode (enables dragging + Save/Reset buttons). Saving or resetting
  // exits edit mode and re-locks the banner.
  const [isPositionEditing, setIsPositionEditing] = useState(false);
  // Two-step delete: first click flips this on and shows a Confirm button so
  // a stray click doesn't wipe the wallpaper. Auto-resets after 4s.
  const [confirmDeleteWallpaper, setConfirmDeleteWallpaper] = useState(false);
  const [wallpaperSaving, setWallpaperSaving] = useState(false);
  const wallpaperInputRef = React.useRef<HTMLInputElement | null>(null);
  // Drag-to-reposition state. We track numeric % offsets during drag so the
  // CSS string is rebuilt cheaply on every mousemove; the server PATCH only
  // fires once on mouseup.
  const wallpaperBannerRef = React.useRef<HTMLDivElement | null>(null);
  const dragStateRef = React.useRef<{
    startX: number;
    startY: number;
    startPosX: number;
    startPosY: number;
    bannerW: number;
    bannerH: number;
  } | null>(null);
  const [isDraggingWallpaper, setIsDraggingWallpaper] = useState(false);

  // Load the saved wallpaper for the current department on mount + whenever the
  // department scope changes. Falls back silently when the migration hasn't
  // been run.
  useEffect(() => {
    let cancelled = false;
    if (!wallpaperDept) {
      setWallpaperUrl(null);
      setWallpaperLoading(false);
      return;
    }
    setWallpaperLoading(true);
    // Drop the old image immediately so the overlay sits on top of an empty
    // panel instead of a stale image from the previous department. Feels
    // snappier and visually communicates "loading new department".
    setWallpaperUrl(null);
    fetch(`/api/manager/team-wallpaper?department=${encodeURIComponent(wallpaperDept)}`, {
      cache: 'no-store',
    })
      .then((r) => r.json())
      .then((j: { url?: string | null; position?: string | null }) => {
        if (cancelled) return;
        setWallpaperUrl(j.url ?? null);
        const pos = j.position ?? '50% 50%';
        setWallpaperPos(pos);
        setSavedWallpaperPos(pos);
        // New department / fresh fetch → always start locked.
        setIsPositionEditing(false);
      })
      .catch(() => {
        if (!cancelled) {
          setWallpaperUrl(null);
          setWallpaperPos('50% 50%');
          setSavedWallpaperPos('50% 50%');
        }
      })
      .finally(() => {
        if (!cancelled) setWallpaperLoading(false);
      });
    return () => { cancelled = true; };
  }, [wallpaperDept]);

  const onPickWallpaper = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Please pick an image file');
      return;
    }
    // 10 MB pre-encode cap. Base64 adds ~33% so the data URL stays under the
    // API's matching 10 MB encoded cap for anything not right at the edge —
    // larger files are rejected here before we spend cycles reading them.
    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image must be under 10 MB — pick a smaller file.');
      return;
    }
    // Upload via multipart/form-data — JSON bodies of this size get
    // truncated mid-stream by Next.js App Router and parse-fail server-side.
    // Multipart streams the binary cleanly.
    setWallpaperSaving(true);
    (async () => {
      try {
        const fd = new FormData();
        fd.append('department', wallpaperDept);
        fd.append('file', file, file.name);
        const res = await fetch('/api/manager/team-wallpaper', {
          method: 'POST',
          body: fd,
        });
        const j = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || !j.success) {
          toast.error(j.error || 'Failed to save wallpaper');
          return;
        }
        // Read the encoded data URL locally for an instant preview rather
        // than refetching from the server.
        const reader = new FileReader();
        reader.onload = () => setWallpaperUrl(String(reader.result ?? ''));
        reader.readAsDataURL(file);
        toast.success(`Wallpaper saved for ${wallpaperDept === '__all__' ? 'all departments' : wallpaperDept}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to save wallpaper');
      } finally {
        setWallpaperSaving(false);
      }
    })();
  };

  const clearWallpaper = async () => {
    setWallpaperSaving(true);
    setConfirmDeleteWallpaper(false);
    try {
      await fetch(`/api/manager/team-wallpaper?department=${encodeURIComponent(wallpaperDept)}`, {
        method: 'DELETE',
      });
      setWallpaperUrl(null);
      setWallpaperPos('50% 50%');
      setSavedWallpaperPos('50% 50%');
      setIsPositionEditing(false);
      toast.success('Wallpaper deleted');
    } catch {
      toast.error('Failed to remove wallpaper');
    } finally {
      setWallpaperSaving(false);
    }
  };

  // Auto-cancel the delete confirmation after 4s so a forgotten Confirm
  // button doesn't sit there forever.
  useEffect(() => {
    if (!confirmDeleteWallpaper) return;
    const id = window.setTimeout(() => setConfirmDeleteWallpaper(false), 4000);
    return () => window.clearTimeout(id);
  }, [confirmDeleteWallpaper]);
  // Reset confirmation when the department changes (so a pending confirm on
  // one department doesn't carry over to another).
  useEffect(() => {
    setConfirmDeleteWallpaper(false);
  }, [wallpaperDept]);

  // Persist a new background-position string for the current department's
  // wallpaper. Called explicitly from the Save Position button — drags no
  // longer auto-save so the manager can preview the framing before
  // committing.
  const persistWallpaperPosition = React.useCallback(async (pos: string) => {
    if (!wallpaperUrl) return;
    setWallpaperPosSaving(true);
    try {
      const res = await fetch('/api/manager/team-wallpaper', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ department: wallpaperDept, position: pos }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        toast.error(j.error || 'Failed to save position');
        return;
      }
      setSavedWallpaperPos(pos);
      // Successful save → lock the position so future clicks on the banner
      // don't pan it accidentally.
      setIsPositionEditing(false);
      toast.success('Position saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save position');
    } finally {
      setWallpaperPosSaving(false);
    }
  }, [wallpaperDept, wallpaperUrl]);

  // Parse the current background-position CSS string into numbers we can
  // adjust during a drag. Defaults gracefully to 50/50 on bad input.
  const parseBgPos = (s: string): { x: number; y: number } => {
    const parts = s.split(/\s+/);
    const x = parseFloat(parts[0] ?? '50');
    const y = parseFloat(parts[1] ?? '50');
    return {
      x: Number.isFinite(x) ? x : 50,
      y: Number.isFinite(y) ? y : 50,
    };
  };

  const onWallpaperDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!wallpaperUrl) return;
    // Position is locked by default — dragging is only allowed in edit mode,
    // entered via the "Reposition" button.
    if (!isPositionEditing) return;
    const banner = wallpaperBannerRef.current;
    if (!banner) return;
    // Only initiate drag on left mouse / primary pointer; ignore clicks that
    // land on the Set/Change/✕ controls (they have their own handlers and
    // call stopPropagation via the button).
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, [data-no-drag]')) return;

    const { x, y } = parseBgPos(wallpaperPos);
    const rect = banner.getBoundingClientRect();
    dragStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPosX: x,
      startPosY: y,
      bannerW: rect.width,
      bannerH: rect.height,
    };
    setIsDraggingWallpaper(true);
    banner.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onWallpaperDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag) return;
    // `background-position: X% Y%` interprets the % relative to *(image - container)*.
    // For a draggable banner, moving the pointer right should pan the image
    // right too — that means the position % goes DOWN (image overflow moves
    // left under the viewport). We invert delta to match user intuition.
    const dxPct = ((e.clientX - drag.startX) / drag.bannerW) * 100;
    const dyPct = ((e.clientY - drag.startY) / drag.bannerH) * 100;
    const nextX = Math.max(0, Math.min(100, drag.startPosX - dxPct));
    const nextY = Math.max(0, Math.min(100, drag.startPosY - dyPct));
    setWallpaperPos(`${nextX.toFixed(1)}% ${nextY.toFixed(1)}%`);
  };

  const onWallpaperDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag) return;
    dragStateRef.current = null;
    setIsDraggingWallpaper(false);
    try { wallpaperBannerRef.current?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    // No auto-save — leave the new position dirty. The Save Position button
    // becomes visible below and the manager commits explicitly.
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

  const totalPages = Math.max(1, Math.ceil(filteredMembers.length / TEAM_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * TEAM_PAGE_SIZE;
  const pageEnd = Math.min(pageStart + TEAM_PAGE_SIZE, filteredMembers.length);
  const pageSlice = filteredMembers.slice(pageStart, pageEnd);

  // Snap back to page 1 if the roster changes (filter/refresh shrinks it under the
  // current page). Cheap to run; no need to memo.
  useEffect(() => {
    setPage(1);
  }, [filteredMembers.length, teamGate.kind]);

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
      {/* My Team wallpaper banner — sits above the section header. Click
          "Change" to upload an image (kept in localStorage so it persists per
          browser). When no image is set, a soft blue gradient is shown. */}
      <div
        ref={wallpaperBannerRef}
        onPointerDown={onWallpaperDragStart}
        onPointerMove={onWallpaperDragMove}
        onPointerUp={onWallpaperDragEnd}
        onPointerCancel={onWallpaperDragEnd}
        className={cn(
          'group relative -mx-4 sm:-mx-6 lg:-mx-8 overflow-hidden touch-none select-none',
          'h-32 sm:h-40 lg:h-44',
          'border-b border-blue-100/70 dark:border-blue-950/40',
          // Cursor + edit-mode ring only show when the banner is actively
          // unlocked for repositioning. Locked banners look static.
          wallpaperUrl && isPositionEditing
            ? isDraggingWallpaper
              ? 'cursor-grabbing ring-2 ring-emerald-400/60 ring-inset'
              : 'cursor-grab ring-2 ring-emerald-400/40 ring-inset'
            : '',
        )}
        style={
          wallpaperUrl
            ? {
                backgroundImage: `url(${wallpaperUrl})`,
                backgroundSize: 'cover',
                backgroundPosition: wallpaperPos,
                backgroundRepeat: 'no-repeat',
              }
            : undefined
        }
      >
        {!wallpaperUrl && (
          <div className="absolute inset-0 bg-gradient-to-br from-blue-100 via-indigo-50 to-white dark:from-blue-950/60 dark:via-indigo-950/30 dark:to-zinc-950" />
        )}
        {/* Subtle bottom fade so any text below stays legible */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-white/40 to-transparent dark:from-zinc-950/40" />

        {/* ── Futuristic loading overlay ──────────────────────────────────
            Renders while the wallpaper is being fetched (department switch
            or first mount) OR uploaded (POST in flight). Composed of three
            layers:
              1. A muted backdrop with a faint grid pattern
              2. A cyan scan-line sweeping top→bottom
              3. A diagonal shimmer wiping across left→right
            Disappears automatically once both flags clear. */}
        {(wallpaperLoading || wallpaperSaving) && (
          <div
            className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
            aria-live="polite"
            aria-busy="true"
          >
            {/* Backdrop — semi-transparent darken so layers below stay readable */}
            <div className="absolute inset-0 bg-gradient-to-br from-slate-950/85 via-blue-950/80 to-cyan-950/80 dark:from-slate-950/90 dark:via-blue-950/85 dark:to-cyan-950/85" />
            {/* Grid pattern — gives the panel a "data-loading" texture */}
            <div
              className="absolute inset-0 opacity-30 mix-blend-screen"
              style={{
                backgroundImage:
                  'linear-gradient(rgba(34,211,238,0.15) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.15) 1px, transparent 1px)',
                backgroundSize: '32px 32px',
                animation: 'wallpaper-pulse 2.2s ease-in-out infinite',
              }}
            />
            {/* Diagonal shimmer sweep — gives a sense of forward motion */}
            <div
              className="absolute inset-0 opacity-50"
              style={{
                background:
                  'linear-gradient(115deg, transparent 30%, rgba(34,211,238,0.35) 50%, transparent 70%)',
                animation: 'wallpaper-shimmer 2.4s linear infinite',
                width: '200%',
                left: '-50%',
              }}
            />
            {/* Cyan scan-line — the signature "futuristic" cue */}
            <div
              className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-cyan-300 to-transparent shadow-[0_0_18px_4px_rgba(34,211,238,0.7)]"
              style={{ animation: 'wallpaper-scan 1.8s ease-in-out infinite' }}
            />
            {/* Status pill — labelled with the current action */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/50 bg-cyan-950/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200 shadow-[0_0_24px_rgba(34,211,238,0.35)] backdrop-blur">
                <span className="relative inline-flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-300" />
                </span>
                {wallpaperSaving ? 'Uploading wallpaper' : 'Loading wallpaper'}
              </div>
            </div>
          </div>
        )}

        {/* Scope label — bottom-left so it's clear which department this image
            belongs to. Stays subtle on a busy background thanks to the frosted
            backdrop. */}
        <div className="pointer-events-none absolute bottom-2 left-3 inline-flex items-center gap-1.5 rounded-md bg-white/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-700 backdrop-blur dark:bg-zinc-900/60 dark:text-zinc-300">
          <span className="opacity-70">Wallpaper</span>
          <span className="text-zinc-300 dark:text-zinc-600">·</span>
          <span>{wallpaperDept === '__all__' ? 'All departments' : wallpaperDept}</span>
        </div>

        <div className="absolute right-3 top-3 flex items-center gap-1.5" data-no-drag>
          <input
            ref={wallpaperInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPickWallpaper}
          />
          {/* When locked: a single "Reposition" button unlocks the banner for
              dragging. When editing: Save + Cancel buttons commit or roll
              back the drag. */}
          {wallpaperUrl && !isPositionEditing && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 border-white/70 bg-white/80 px-2 text-[11px] font-medium text-zinc-700 backdrop-blur transition hover:bg-white dark:border-zinc-700/70 dark:bg-zinc-900/70 dark:text-zinc-200 dark:hover:bg-zinc-900"
              onClick={() => setIsPositionEditing(true)}
              title="Unlock the banner to drag the image into a new position"
            >
              Reposition
            </Button>
          )}
          {wallpaperUrl && isPositionEditing && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={wallpaperPosSaving || wallpaperPos === savedWallpaperPos}
                className="h-7 gap-1.5 border-emerald-300/80 bg-emerald-50/90 px-2 text-[11px] font-semibold text-emerald-800 backdrop-blur transition hover:bg-emerald-100 disabled:opacity-60 dark:border-emerald-700/60 dark:bg-emerald-950/60 dark:text-emerald-200 dark:hover:bg-emerald-900/60"
                onClick={() => void persistWallpaperPosition(wallpaperPos)}
                title="Save the current drag position for this department"
              >
                {wallpaperPosSaving ? 'Saving…' : 'Save position'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={wallpaperPosSaving}
                className="h-7 gap-1.5 border-white/70 bg-white/80 px-2 text-[11px] font-medium text-zinc-600 backdrop-blur transition hover:bg-white disabled:opacity-60 dark:border-zinc-700/70 dark:bg-zinc-900/70 dark:text-zinc-300 dark:hover:bg-zinc-900"
                onClick={() => {
                  // Revert any in-flight drag and exit edit mode.
                  setWallpaperPos(savedWallpaperPos);
                  setIsPositionEditing(false);
                }}
                title="Discard drag changes and lock the banner"
              >
                Cancel
              </Button>
            </>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={wallpaperSaving}
            className="h-7 gap-1.5 border-white/70 bg-white/80 px-2 text-[11px] font-medium text-zinc-700 backdrop-blur transition hover:bg-white disabled:opacity-60 dark:border-zinc-700/70 dark:bg-zinc-900/70 dark:text-zinc-200 dark:hover:bg-zinc-900"
            onClick={() => wallpaperInputRef.current?.click()}
          >
            {wallpaperSaving ? 'Saving…' : wallpaperUrl ? 'Change' : 'Set wallpaper'}
          </Button>
          {wallpaperUrl && (
            confirmDeleteWallpaper ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={wallpaperSaving}
                  className="h-7 gap-1.5 border-red-300/80 bg-red-50/90 px-2 text-[11px] font-semibold text-red-700 backdrop-blur transition hover:bg-red-100 disabled:opacity-60 dark:border-red-700/60 dark:bg-red-950/60 dark:text-red-300 dark:hover:bg-red-900/60"
                  onClick={() => void clearWallpaper()}
                  title="Confirm — this removes the wallpaper for this department"
                >
                  <Trash2 className="h-3 w-3" />
                  Confirm delete
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 border-white/70 bg-white/80 px-2 text-[11px] font-medium text-zinc-600 backdrop-blur transition hover:bg-white dark:border-zinc-700/70 dark:bg-zinc-900/70 dark:text-zinc-300 dark:hover:bg-zinc-900"
                  onClick={() => setConfirmDeleteWallpaper(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={wallpaperSaving}
                className="h-7 gap-1.5 border-white/70 bg-white/80 px-2 text-[11px] font-medium text-red-600 backdrop-blur transition hover:bg-red-50 hover:text-red-700 disabled:opacity-60 dark:border-zinc-700/70 dark:bg-zinc-900/70 dark:text-red-400 dark:hover:bg-red-950/30 dark:hover:text-red-300"
                onClick={() => setConfirmDeleteWallpaper(true)}
                title="Delete the wallpaper for this department"
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </Button>
            )
          )}
        </div>
      </div>

      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="bg-gradient-to-r from-blue-700 via-zinc-900 to-zinc-900 bg-clip-text text-xl font-bold tracking-tight text-transparent dark:from-blue-400 dark:via-white dark:to-white">
            My team
          </h2>
          {members.length > 0 && (
            <div className="flex items-center gap-2">
            <ActiveNowButton members={members} onlineEmails={onlineEmails} />
            <motion.div whileTap={{ scale: 0.96 }} transition={{ duration: 0.12 }}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRatesHidden((v) => !v)}
                className="h-7 gap-1.5 overflow-hidden border-blue-200 text-xs text-blue-700 transition-colors hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/40"
                aria-pressed={!ratesHidden}
                title={ratesHidden ? 'Show hourly and OT rates' : 'Hide hourly and OT rates'}
              >
                <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={ratesHidden ? 'eye' : 'eye-off'}
                      initial={{ rotate: -45, scale: 0.6, opacity: 0 }}
                      animate={{ rotate: 0, scale: 1, opacity: 1 }}
                      exit={{ rotate: 45, scale: 0.6, opacity: 0 }}
                      transition={{ duration: 0.16, ease: 'easeOut' }}
                      className="absolute inline-flex"
                    >
                      {ratesHidden ? (
                        <Eye className="h-3.5 w-3.5" />
                      ) : (
                        <EyeOff className="h-3.5 w-3.5" />
                      )}
                    </motion.span>
                  </AnimatePresence>
                </span>
                <span className="relative block h-4 w-[68px] overflow-hidden text-left">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={ratesHidden ? 'show' : 'hide'}
                      initial={{ y: 8, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      exit={{ y: -8, opacity: 0 }}
                      transition={{ duration: 0.18, ease: 'easeOut' }}
                      className="absolute inset-0"
                    >
                      {ratesHidden ? 'Show rates' : 'Hide rates'}
                    </motion.span>
                  </AnimatePresence>
                </span>
              </Button>
            </motion.div>
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
                {teamGate.departments.join(', ')}
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
          <div className="inline-flex w-fit rounded-md border border-blue-200 bg-blue-50/40 p-0.5 dark:border-blue-900/50 dark:bg-blue-950/20">
            <button
              type="button"
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
              onClick={() => setInnerTab('newly-hired')}
              className={cn(
                'rounded-[5px] px-3 py-1.5 text-xs font-semibold transition',
                innerTab === 'newly-hired'
                  ? 'bg-white text-blue-700 shadow-sm dark:bg-zinc-950 dark:text-blue-300'
                  : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
              )}
            >
              Newly Hired
            </button>
            <button
              type="button"
              onClick={() => setInnerTab('ai-team')}
              className={cn(
                'rounded-[5px] px-3 py-1.5 text-xs font-semibold transition',
                innerTab === 'ai-team'
                  ? 'bg-white text-blue-700 shadow-sm dark:bg-zinc-950 dark:text-blue-300'
                  : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
              )}
            >
              AI Team
            </button>
          </div>
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

      {innerTab === 'ai-team' && (
        <Card className="overflow-hidden border-blue-100/70 dark:border-blue-950/50">
          <CardContent className="p-0">
            <div className="flex items-center justify-between gap-2 border-b border-blue-100/70 bg-blue-50/40 px-3 py-2 dark:border-blue-950/50 dark:bg-blue-950/20">
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                Embedded view of{' '}
                <a
                  href="https://ai-team.simple.biz/"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
                >
                  ai-team.simple.biz
                </a>
              </p>
              <a
                href="https://ai-team.simple.biz/"
                target="_blank"
                rel="noreferrer noopener"
                className="rounded-md border border-blue-200 bg-white px-2 py-1 text-[11px] font-medium text-blue-700 transition-colors hover:bg-blue-50 dark:border-blue-800 dark:bg-zinc-950 dark:text-blue-300 dark:hover:bg-blue-950/40"
              >
                Open in new tab
              </a>
            </div>
            <iframe
              src="https://ai-team.simple.biz/"
              title="AI Team"
              className="block h-[78vh] w-full border-0 bg-white dark:bg-zinc-950"
              referrerPolicy="no-referrer-when-downgrade"
              loading="lazy"
            />
          </CardContent>
        </Card>
      )}

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
                htmlFor="team-dept-filter"
                className="text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
              >
                Department
              </label>
              <select
                id="team-dept-filter"
                value={deptFilter}
                onChange={(e) => setDeptFilter(e.target.value)}
                className="h-8 min-w-[180px] rounded-md border border-blue-200 bg-white px-2 text-xs text-zinc-800 shadow-sm transition-colors hover:border-blue-300 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-blue-900/50 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:border-blue-800 dark:focus:border-blue-700 dark:focus:ring-blue-900/50"
              >
                <option value="all">All ({members.length})</option>
                {deptOptions.map((d) => {
                  const count = members.filter(
                    (m) => (m.department ?? '').trim().toLowerCase() === d.toLowerCase(),
                  ).length;
                  return (
                    <option key={d} value={d}>
                      {d} ({count})
                    </option>
                  );
                })}
              </select>
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
          <span className="ml-auto font-mono text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
            Showing {filteredMembers.length} of {members.length}
          </span>
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
              // Show role only for HSL roster entries; show rate columns when any
              // member has either HSL pay-plan rates or employee_hourly_rates values.
              const showHslRoleCol = members.some(
                (m) => (m.hsl_role ?? '').trim() !== '',
              );
              const formatPhp = (v: number | null | undefined): string => {
                if (v == null) return '—';
                return `₱${v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
              };
              const filterKey = `${deptFilter}|${searchQuery.trim()}`;
              return (
                <>
                  <motion.div
                    key={filterKey}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                  >
                  {/* Desktop / tablet: table */}
                  <div
                    className="hidden overflow-x-auto md:block"
                    onDragOver={(e) => {
                      if (!draggedMedal) return;
                      e.preventDefault();
                      const tr = (e.target as HTMLElement).closest('tr[data-email]') as HTMLElement | null;
                      setDragOverEmail(tr?.dataset.email ?? null);
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setDragOverEmail(null);
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const tr = (e.target as HTMLElement).closest('tr[data-email]') as HTMLElement | null;
                      const email = tr?.dataset.email;
                      const name = tr?.dataset.name ?? null;
                      if (email) openAwardForDrop(email, name);
                      setDragOverEmail(null);
                    }}
                  >
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="w-[220px]">Name</TableHead>
                          <TableHead>Department</TableHead>
                          {showHslRoleCol && (
                            <TableHead className="min-w-[180px]">Department/Role</TableHead>
                          )}
                          <TableHead className="min-w-[110px] text-right">Hourly</TableHead>
                          <TableHead className="min-w-[110px] text-right">OT</TableHead>
                          <TableHead className="min-w-[200px]">Work email</TableHead>
                          <TableHead className="min-w-[200px]">Personal email</TableHead>
                          <TableHead className="w-[170px] text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pageSlice.map((m, idx) => {
                          const rowEmail = m.personal_email ?? m.work_email ?? undefined;
                          const isOver = !!draggedMedal && !!rowEmail && dragOverEmail === rowEmail;
                          return (
                          <TableRow
                            key={`${m.work_email ?? m.personal_email ?? m.name}-${idx}`}
                            data-email={rowEmail}
                            data-name={m.name ?? undefined}
                            className={cn(isOver && 'bg-amber-50/60 dark:bg-amber-950/20')}
                          >
                            <TableCell className="font-medium text-zinc-900 dark:text-zinc-100">
                              <span className="inline-flex items-center gap-1.5">
                                {isMemberOnline(m) && (
                                  <span className="relative flex h-2 w-2 shrink-0" title="Online in HRIS now">
                                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
                                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                                  </span>
                                )}
                                {m.name ?? '—'}
                                <MedalBadges email={rowEmail} />
                              </span>
                            </TableCell>
                            <TableCell className="text-zinc-600 dark:text-zinc-400">
                              {m.department ?? '—'}
                            </TableCell>
                            {showHslRoleCol && (
                              <TableCell className="text-zinc-600 dark:text-zinc-400">
                                <div className="flex flex-wrap gap-1">
                                  {m.hsl_role ? (
                                    <span className="inline-flex items-center rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
                                      {m.hsl_role}
                                    </span>
                                  ) : (
                                    <span className="text-zinc-300 dark:text-zinc-700">—</span>
                                  )}
                                  {m.mesa_member && (
                                    <span title="MESA Program — ₱100 deducted per paycheck" className="inline-flex items-center rounded-md border border-teal-200 bg-teal-50 px-2 py-0.5 text-xs font-semibold text-teal-700 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300">
                                      MESA
                                    </span>
                                  )}
                                </div>
                              </TableCell>
                            )}
                            <TableCell className="text-right font-mono text-xs tabular-nums text-zinc-700 dark:text-zinc-300">
                              <AnimatedRate
                                value={memberHourlyRate(m)}
                                hidden={ratesHidden}
                                formatPhp={formatPhp}
                              />
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs tabular-nums text-zinc-700 dark:text-zinc-300">
                              <AnimatedRate
                                value={memberOtRate(m)}
                                hidden={ratesHidden}
                                formatPhp={formatPhp}
                              />
                            </TableCell>
                            <TableCell className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
                              {m.work_email ?? '—'}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
                              {m.personal_email ?? '—'}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setSelectedMember(m)}
                                  className="h-7 gap-1.5 border-blue-200 text-xs text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/40"
                                  title="View profile and payment history"
                                >
                                  <UserRound className="h-3.5 w-3.5" />
                                  View
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setTransferMember(m)}
                                  className="h-7 gap-1.5 border-amber-200 text-xs text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40"
                                  title="Request a department transfer (HR approval required)"
                                >
                                  <ArrowRightLeft className="h-3.5 w-3.5" />
                                  Transfer
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ); })}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Mobile: stacked cards */}
                  <div className="flex flex-col gap-2.5 p-3 md:hidden">
                    {pageSlice.map((m, idx) => {
                      const cardEmail = m.personal_email ?? m.work_email ?? undefined;
                      const isCardOver = !!draggedMedal && !!cardEmail && dragOverEmail === cardEmail;
                      return (
                      <motion.div
                        key={`${m.work_email ?? m.personal_email ?? m.name}-${idx}`}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                          duration: 0.22,
                          delay: Math.min(idx * 0.025, 0.18),
                          ease: 'easeOut',
                        }}
                        onDragOver={(e) => { if (!draggedMedal) return; e.preventDefault(); setDragOverEmail(cardEmail ?? null); }}
                        onDragLeave={() => setDragOverEmail(null)}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (cardEmail) openAwardForDrop(cardEmail, m.name ?? null);
                          setDragOverEmail(null);
                        }}
                        className={cn(
                          'rounded-xl border border-blue-100/70 bg-white/95 p-3 shadow-sm ring-1 ring-blue-500/5 dark:border-blue-950/50 dark:bg-zinc-950/80 dark:ring-blue-400/10',
                          isCardOver && 'ring-amber-400/60 bg-amber-50/40 dark:bg-amber-950/10',
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                              {isMemberOnline(m) && (
                                <span className="relative flex h-2 w-2 shrink-0" title="Online in HRIS now">
                                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
                                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                                </span>
                              )}
                              <span className="truncate">{m.name ?? '—'}</span>
                              <MedalBadges email={cardEmail} />
                            </div>
                            <div className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                              {m.department ?? '—'}
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            {m.hsl_role && (
                              <span className="rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
                                {m.hsl_role}
                              </span>
                            )}
                            {m.mesa_member && (
                              <span
                                title="MESA Program — ₱100 deducted per paycheck"
                                className="rounded-md border border-teal-200 bg-teal-50 px-2 py-0.5 text-[10px] font-semibold text-teal-700 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300"
                              >
                                MESA −₱100
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-zinc-100 bg-gradient-to-br from-zinc-50 to-blue-50/40 px-3 py-2 dark:border-zinc-800 dark:from-zinc-900/60 dark:to-blue-950/20">
                          <div className="flex flex-col gap-0.5">
                            <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                              Hourly
                            </div>
                            <div className="font-mono text-sm tabular-nums text-zinc-800 dark:text-zinc-200">
                              <AnimatedRate
                                value={memberHourlyRate(m)}
                                hidden={ratesHidden}
                                formatPhp={formatPhp}
                              />
                            </div>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                              OT
                            </div>
                            <div className="font-mono text-sm tabular-nums text-zinc-800 dark:text-zinc-200">
                              <AnimatedRate
                                value={memberOtRate(m)}
                                hidden={ratesHidden}
                                formatPhp={formatPhp}
                              />
                            </div>
                          </div>
                        </div>

                        <dl className="mt-3 grid gap-1 text-[11px]">
                          <div className="flex items-baseline gap-1.5">
                            <dt className="shrink-0 text-zinc-500 dark:text-zinc-400">Work</dt>
                            <dd className="truncate font-mono text-zinc-700 dark:text-zinc-300">
                              {m.work_email ?? '—'}
                            </dd>
                          </div>
                          <div className="flex items-baseline gap-1.5">
                            <dt className="shrink-0 text-zinc-500 dark:text-zinc-400">Personal</dt>
                            <dd className="truncate font-mono text-zinc-700 dark:text-zinc-300">
                              {m.personal_email ?? '—'}
                            </dd>
                          </div>
                        </dl>

                        <div className="mt-3 flex justify-end gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setSelectedMember(m)}
                            className="h-7 gap-1.5 border-blue-200 text-xs text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/40"
                          >
                            <UserRound className="h-3.5 w-3.5" />
                            View
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setTransferMember(m)}
                            className="h-7 gap-1.5 border-amber-200 text-xs text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40"
                          >
                            <ArrowRightLeft className="h-3.5 w-3.5" />
                            Transfer
                          </Button>
                        </div>
                      </motion.div>
                    ); })}
                  </div>
                  </motion.div>

                  {/* Pagination footer */}
                  {filteredMembers.length > TEAM_PAGE_SIZE && (
                    <div className="flex flex-col items-center justify-between gap-2 border-t border-blue-100/70 bg-white/60 px-4 py-3 text-xs text-zinc-600 dark:border-blue-950/50 dark:bg-zinc-950/40 dark:text-zinc-400 sm:flex-row">
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
      />

      <ManagerTransferDialog
        member={transferMember}
        open={!!transferMember}
        onOpenChange={(open) => { if (!open) setTransferMember(null); }}
      />
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
  accent: 'blue-bright' | 'blue-deep' | 'mono';
  onClick?: () => void;
}

function StatTile({ label, value, hint, icon: Icon, accent, onClick }: StatTileProps) {
  const accentMap = {
    'blue-bright':
      'bg-gradient-to-br from-blue-400 to-blue-600 text-white shadow-blue-500/30',
    'blue-deep':
      'bg-gradient-to-br from-blue-700 to-black text-white shadow-blue-900/40',
    mono:
      'bg-gradient-to-br from-zinc-900 to-black text-white shadow-zinc-900/30 dark:from-zinc-100 dark:to-white dark:text-zinc-900 dark:shadow-zinc-100/20',
  } as const;

  const Wrapper = onClick ? 'button' : 'div';

  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'group relative flex items-center gap-4 overflow-hidden rounded-xl border border-blue-100/70 bg-white/90 px-4 py-4 text-left ring-1 ring-blue-500/5 backdrop-blur-sm transition-all dark:border-blue-950/50 dark:bg-zinc-950/70 dark:ring-blue-400/10',
        onClick && 'cursor-pointer hover:-translate-y-0.5 hover:border-blue-300/80 hover:shadow-md hover:shadow-blue-500/10 dark:hover:border-blue-800',
      )}
    >
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg shadow-md',
          accentMap[accent],
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          {label}
        </div>
        <div className="mt-0.5 bg-gradient-to-br from-zinc-900 to-blue-900 bg-clip-text text-2xl font-bold tabular-nums text-transparent dark:from-white dark:to-blue-300">
          {value}
        </div>
        <div className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{hint}</div>
      </div>
    </Wrapper>
  );
}

function Requirement({
  icon: Icon,
  text,
}: {
  icon: React.ComponentType<{ className?: string }>;
  text: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-blue-50/60 px-3 py-2 ring-1 ring-blue-500/5 dark:bg-blue-950/30 dark:ring-blue-400/10">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
      <span>{text}</span>
    </div>
  );
}

function RoadmapItem({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-gradient-to-br from-blue-500 to-blue-700" />
      {text}
    </li>
  );
}
