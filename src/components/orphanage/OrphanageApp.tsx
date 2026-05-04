'use client';

import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { useSearchParams } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { useTheme } from 'next-themes';
import { AnimatePresence, motion } from 'motion/react';
import {
  CheckCircle2,
  ClipboardList,
  HeartHandshake,
  Loader2,
  LogOut,
  Menu,
  Moon,
  Newspaper,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Sun,
} from 'lucide-react';
import SWall, { SWallNavLabel } from '@/components/swall/SWall';
import { withViewTransition } from '@/lib/theme/with-view-transition';
import { toast, Toaster } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import ViewSwitcher from '@/components/rbac/ViewSwitcher';
import CreateOrphanageStyleDisputeDialog, {
  type EmployeeOption,
} from '@/components/orphanage/CreateOrphanageStyleDisputeDialog';
import {
  fetchHoursByEmployee,
  type HubstaffHoursByEmployee,
} from '@/lib/hubstaff/fetch-hours-by-employee';
import {
  fetchOrphanageOverlap,
  type DisputesByEmployee,
} from '@/lib/pab-disputes/fetch-orphanage-overlap';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import { normEmail } from '@/lib/email/norm-email';
import type { PabDayDisputeRow, PabDisputeStatus } from '@/lib/supabase/pab-day-disputes';

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function formatVerifiedAt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** Labels + badge styling for orphanage receipt-log rows (`verified` bucket from `/api/orphanage-disputes`). */
function orphanReceiptStatusMeta(status: PabDisputeStatus): {
  label: string;
  badgeClass: string;
} {
  switch (status) {
    case 'orphanage_manager_approved':
      return {
        label: 'With Accounting',
        badgeClass:
          'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950/45 dark:text-sky-100',
      };
    case 'accounting_approved':
    case 'approved':
      return {
        label: status === 'approved' ? 'Accounting approved (legacy)' : 'Accounting approved',
        badgeClass:
          'border-emerald-400/90 bg-emerald-50 text-emerald-950 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100',
      };
    case 'accounting_denied':
      return {
        label: 'Accounting denied',
        badgeClass:
          'border-rose-400/90 bg-rose-50 text-rose-950 dark:border-rose-800 dark:bg-rose-950/35 dark:text-rose-100',
      };
    case 'orphanage_manager_denied':
      return {
        label: 'Denied — manager',
        badgeClass:
          'border-orange-400/85 bg-orange-50 text-orange-950 dark:border-orange-800 dark:bg-orange-950/35 dark:text-orange-100',
      };
    case 'denied':
      return {
        label: 'Denied (legacy)',
        badgeClass:
          'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200',
      };
    default:
      return {
        label: status,
        badgeClass: 'border-zinc-300 bg-zinc-100 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
      };
  }
}

const WELCOME_MESSAGES: { heading: (name: string) => string; body: string }[] = [
  {
    heading: (name) => `Welcome, ${name} — every visit you verify makes a difference. ♥`,
    body: "Behind each entry is a child who had a visitor that day. Your approval ensures the team is recognized for showing up — thank you for being part of their story.",
  },
  {
    heading: (name) => `Hi ${name} — small acts of care leave the biggest marks. ♥`,
    body: "Every time your team walks through those doors, a child feels seen. Your work here makes sure those moments count — keep going.",
  },
  {
    heading: (name) => `Good to see you, ${name} — you're helping write better childhoods. ♥`,
    body: "The hours logged here represent real presence, real warmth, and real hope. Thank you for being the bridge between effort and recognition.",
  },
  {
    heading: (name) => `Welcome back, ${name} — compassion in action, one visit at a time. ♥`,
    body: "Each verified visit is a promise kept to a child who deserves to feel remembered. Your role here is more meaningful than you know.",
  },
  {
    heading: (name) => `Hey ${name} — the kids are lucky to have a team like yours. ♥`,
    body: "Behind every dispute record is a story of someone who showed up. Your verification keeps that story alive — and makes sure it's honored.",
  },
];

const WELCOME_SESSION_KEY = 'orphanage_welcome_idx';

export default function OrphanageApp() {
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams.get('email');
  const [viewerEmail, setViewerEmail] = useState<string | null>(null);
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const isDark = mounted ? resolvedTheme === 'dark' : false;

  const [welcomeIdx, setWelcomeIdx] = useState(0);
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(WELCOME_SESSION_KEY);
      if (stored !== null) {
        setWelcomeIdx(Number(stored));
      } else {
        const idx = Math.floor(Math.random() * WELCOME_MESSAGES.length);
        sessionStorage.setItem(WELCOME_SESSION_KEY, String(idx));
        setWelcomeIdx(idx);
      }
    } catch { /* ignore */ }
  }, []);
  const welcomeMsg = WELCOME_MESSAGES[welcomeIdx]!;

  const [activeTab, setActiveTab] = useState<'queue' | 's-wall'>('queue');

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavOpen]);
  useEffect(() => {
    document.body.style.overflow = mobileNavOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [mobileNavOpen]);

  const [rows, setRows] = useState<PabDayDisputeRow[]>([]);
  const [verifiedRows, setVerifiedRows] = useState<PabDayDisputeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [verifiedSearch, setVerifiedSearch] = useState('');
  const [verifiedPage, setVerifiedPage] = useState(0);
  const PAGE_SIZE = 5;
  const [confirm, setConfirm] = useState<{ row: PabDayDisputeRow; action: 'approve' | 'deny' } | null>(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [pageDir, setPageDir] = useState<1 | -1>(1);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [employeeOptions, setEmployeeOptions] = useState<EmployeeOption[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [hoursByEmployee, setHoursByEmployee] = useState<HubstaffHoursByEmployee>(new Map());
  const [hoursLoading, setHoursLoading] = useState(true);
  const [disputesByEmployee, setDisputesByEmployee] = useState<DisputesByEmployee>(new Map());
  const [disputesByEmployeeLoading, setDisputesByEmployeeLoading] = useState(true);

  // Pre-fetch the roster on mount. Backed by /api/employee-rate-profiles/summary which
  // does a heavy server-side merge; warming it here means the dialog opens instantly.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/employee-rate-profiles/summary', { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: { profiles?: EmployeeOption[] }) => {
        if (cancelled) return;
        const active = (json.profiles ?? []).filter((p) => !p.suspended);
        setEmployeeOptions(active);
      })
      .catch(() => {
        if (!cancelled) setEmployeeOptions([]);
      })
      .finally(() => {
        if (!cancelled) setEmployeesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Pre-fetch + parse Hubstaff hours so the calendar's red days are ready as soon as
  // the user picks a person inside the dialog. Walks every source file in parallel and
  // builds a per-employee daily-seconds map.
  useEffect(() => {
    const ac = new AbortController();
    fetchHoursByEmployee({ signal: ac.signal })
      .then((map) => {
        if (!ac.signal.aborted) setHoursByEmployee(map);
      })
      .finally(() => {
        if (!ac.signal.aborted) setHoursLoading(false);
      });
    return () => ac.abort();
  }, []);

  // Pre-fetch the existing-orphanage-disputes map so the dialog's calendar shows
  // already-forgiven (green) / pending (amber) / denied (red-disabled) cells instead
  // of letting the user re-pick days that already have a row on file.
  useEffect(() => {
    const ac = new AbortController();
    fetchOrphanageOverlap({ signal: ac.signal })
      .then((map) => {
        if (!ac.signal.aborted) setDisputesByEmployee(map);
      })
      .finally(() => {
        if (!ac.signal.aborted) setDisputesByEmployeeLoading(false);
      });
    return () => ac.abort();
  }, []);

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

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/orphanage-disputes', { cache: 'no-store' });
      const json = (await res.json()) as {
        pending?: PabDayDisputeRow[];
        verified?: PabDayDisputeRow[];
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load queue');
      setRows(json.pending ?? []);
      setVerifiedRows(json.verified ?? []);
    } catch (e) {
      setRows([]);
      setVerifiedRows([]);
      toast.error(e instanceof Error ? e.message : 'Could not load orphanage queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const filteredVerified = useMemo(() => {
    const q = verifiedSearch.trim().toLowerCase();
    if (!q) return verifiedRows;
    return verifiedRows.filter((row) =>
      [
        row.work_email,
        row.dispute_date,
        row.explanation ?? '',
        row.decided_by ?? '',
        row.decision_note ?? '',
        row.status,
        orphanReceiptStatusMeta(row.status).label,
      ]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [verifiedRows, verifiedSearch]);

  const awaitingAccountingCount = useMemo(
    () => verifiedRows.filter((r) => r.status === 'orphanage_manager_approved').length,
    [verifiedRows],
  );

  const runDecide = useCallback(async () => {
    if (!confirm || !viewerEmail) return;
    const row = confirm.row;
    const action = confirm.action;
    const noteTrimmed = decisionNote.trim() || null;
    setConfirm(null);
    setDecisionNote('');
    try {
      const res = await fetch(`/api/pab-disputes/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: action === 'approve' ? 'orphanage_manager_approve' : 'orphanage_manager_deny',
          decided_by: viewerEmail,
          decision_note: noteTrimmed,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed');
      if (action === 'approve') {
        toast.success('Verified — sent to Accounting for final payroll approval.', {
          description: `Logged under ${viewerEmail} · ${formatVerifiedAt(new Date().toISOString())}`,
        });
      } else {
        toast.success('Dispute denied.');
      }
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update dispute');
    }
  }, [confirm, viewerEmail, decisionNote, fetchRows]);

  const reviewerFirst =
    viewerEmail?.includes('@') === true
      ? (viewerEmail.split('@')[0]!.replace(/[._-]/g, ' ').split(' ')[0] ?? '')
      : '';
  const greeting =
    reviewerFirst.length > 0
      ? reviewerFirst.charAt(0).toUpperCase() + reviewerFirst.slice(1).toLowerCase()
      : 'there';

  const displayName = viewerEmail?.includes('@')
    ? viewerEmail.split('@')[0]!.replace(/[._-]/g, ' ')
    : viewerEmail || 'Manager';
  const titleName = displayName
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  return (
    <div className="flex h-dvh max-h-dvh overflow-hidden bg-white text-zinc-900 dark:bg-[#0d1117] dark:text-zinc-100">
      {/* Mobile overlay backdrop */}
      {mobileNavOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden"
          aria-label="Close navigation menu"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <aside className={cn(
        'flex w-[220px] max-w-[min(100vw,220px)] shrink-0 flex-col border-r border-pink-100/70 bg-gradient-to-b from-white via-pink-50/20 to-white dark:border-pink-950/40 dark:from-black dark:via-pink-950/15 dark:to-black',
        'fixed inset-y-0 left-0 z-50 transition-transform duration-300 ease-out md:static md:z-auto md:max-w-none md:translate-x-0',
        mobileNavOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
      )}
        id="orphanage-sidebar-nav"
        role="navigation"
        aria-label="Orphanage navigation"
      >
        <div className="flex flex-1 flex-col px-4 pb-4 pt-6">
          {/* Brand */}
          <div className="mb-7 flex items-center gap-2.5 px-1">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-gradient-to-br from-pink-600 to-rose-900 text-sm font-bold tracking-[-0.02em] text-white shadow-sm shadow-pink-600/30">
              s
            </div>
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="bg-gradient-to-r from-pink-700 to-zinc-900 bg-clip-text text-[13.5px] font-semibold tracking-[-0.01em] text-transparent dark:from-pink-300 dark:to-white">
                simple·hris
              </span>
              <span className="mt-0.5 text-[10.5px] tracking-[0.02em] text-pink-600/70 dark:text-pink-400/70">
                Orphanage
              </span>
            </div>
          </div>

          {/* Nav */}
          <div className="flex-1">
            <p className="mb-1.5 px-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-zinc-400 dark:text-zinc-500">
              Workspace
            </p>
            <nav className="flex flex-col gap-px">
              <button
                type="button"
                onClick={() => { setActiveTab('queue'); setMobileNavOpen(false); }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] font-[450] transition-[color,background-color,box-shadow] duration-200 ease-out',
                  activeTab === 'queue'
                    ? 'bg-gradient-to-r from-pink-600 to-rose-700 font-medium text-white shadow-sm shadow-pink-600/25'
                    : 'text-[#3f3f46] hover:bg-pink-50 hover:text-pink-900 dark:text-zinc-300 dark:hover:bg-pink-950/40 dark:hover:text-pink-100',
                )}
              >
                <HeartHandshake className={cn('h-[15px] w-[15px] shrink-0', activeTab === 'queue' ? 'text-white/85' : 'text-[#a1a1aa] dark:text-zinc-500')} />
                <span className="truncate text-left">Dispute queue</span>
              </button>
              <button
                type="button"
                onClick={() => { setActiveTab('s-wall'); setMobileNavOpen(false); }}
                className={cn(
                  'group/sw flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] font-[450] transition-[color,background-color,box-shadow] duration-200 ease-out',
                  activeTab === 's-wall'
                    ? 'bg-gradient-to-r from-violet-600 to-indigo-700 font-medium text-white shadow-sm shadow-violet-600/25'
                    : 'text-[#3f3f46] hover:bg-violet-50 hover:text-violet-900 dark:text-zinc-300 dark:hover:bg-violet-950/40 dark:hover:text-violet-100',
                )}
              >
                <Newspaper className={cn('h-[15px] w-[15px] shrink-0', activeTab === 's-wall' ? 'text-white/85' : 'text-[#a1a1aa] dark:text-zinc-500')} />
                <SWallNavLabel />
              </button>
            </nav>
          </div>

          {/* Bottom controls */}
          <div className="mt-auto border-t border-pink-100/60 pt-4 dark:border-pink-950/40">
            <ViewSwitcher email={viewerEmail} currentView="orphanage" />

            {/* Dark mode toggle */}
            <button
              type="button"
              onClick={() => withViewTransition(() => setTheme(isDark ? 'light' : 'dark'))}
              className="mb-2 mt-3 flex w-full items-center justify-between rounded-md border border-pink-100/70 bg-gradient-to-br from-white to-pink-50/60 px-3 py-2 text-left transition-colors hover:from-pink-50 hover:to-pink-100/60 dark:border-pink-950/40 dark:from-zinc-950 dark:to-pink-950/20 dark:hover:from-pink-950/30 dark:hover:to-pink-950/40"
              aria-label="Toggle dark mode"
            >
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">
                {isDark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                {isDark ? 'Dark' : 'Light'}
              </div>
              <span className="text-zinc-400">{isDark ? '☀' : '☾'}</span>
            </button>
          </div>
        </div>

        {/* User card + sign out */}
        <div className="border-t border-pink-100/60 p-4 dark:border-pink-950/40">
          <div className="flex items-center gap-2.5 rounded-md border border-pink-100/70 bg-gradient-to-br from-white to-pink-50/60 px-2.5 py-2 dark:border-pink-950/40 dark:from-zinc-950 dark:to-pink-950/20">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-pink-600 to-rose-900 text-[11px] font-semibold text-white shadow-sm shadow-pink-600/25">
              {(viewerEmail ?? '?').slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium leading-tight text-zinc-900 dark:text-zinc-100">
                {titleName}
              </div>
              <div className="mt-px text-[11px] leading-tight text-pink-600/70 dark:text-pink-400/70">
                Orphanage Manager
              </div>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 w-full justify-start gap-2.5 text-[13px] text-zinc-500 hover:bg-rose-500/10 hover:text-rose-600 dark:text-zinc-400 dark:hover:text-rose-400"
            onClick={() => {
              try { sessionStorage.removeItem(SESSION_EMAIL_KEY); } catch { /* ignore */ }
              void signOut({ callbackUrl: '/login' });
            }}
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </Button>
        </div>
      </aside>

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-gradient-to-br from-white via-pink-50/30 to-white text-zinc-900 dark:from-[#0d1117] dark:via-pink-950/20 dark:to-[#0d1117] dark:text-zinc-100">
        {/* Mobile header */}
        <header className="flex shrink-0 items-center gap-3 border-b border-pink-100/70 bg-white/95 px-3 py-2.5 backdrop-blur-md supports-[padding:max(0px)]:pt-[max(0.625rem,env(safe-area-inset-top))] dark:border-pink-950/40 dark:bg-zinc-950/95 md:hidden">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0 border-pink-100/70 bg-white dark:border-pink-950/50 dark:bg-zinc-900"
            onClick={() => setMobileNavOpen(true)}
            aria-expanded={mobileNavOpen}
            aria-controls="orphanage-sidebar-nav"
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Orphanage
          </span>
        </header>

        <CreateOrphanageStyleDisputeDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          onSubmitSuccess={() => void fetchRows()}
          employees={employeeOptions}
          employeesLoading={employeesLoading}
          hoursByEmployee={hoursByEmployee}
          hoursLoading={hoursLoading}
          disputesByEmployee={disputesByEmployee}
          disputesLoading={disputesByEmployeeLoading}
        />

        <AnimatePresence mode="wait" initial={false}>
          {activeTab === 'queue' ? (
        <motion.div
          key="queue"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:gap-8 lg:px-8 lg:pt-8">
            <header className="relative overflow-hidden rounded-2xl border border-pink-100/90 bg-gradient-to-br from-pink-600 via-rose-600 to-zinc-900 px-5 py-7 text-white shadow-lg shadow-pink-600/20 dark:border-pink-900/50 dark:from-pink-700 dark:via-rose-900 dark:to-black sm:px-7">
              <style>{`
                @keyframes floatHeart {
                  0%   { transform: translateY(0)     scale(1);    opacity: 0; }
                  12%  {                                            opacity: 0.55; }
                  80%  { transform: translateY(-110px) scale(0.7); opacity: 0.25; }
                  100% { transform: translateY(-130px) scale(0.5); opacity: 0; }
                }
              `}</style>
              {([
                { left: '6%',  delay: '0s',    dur: '4.2s', size: '22px' },
                { left: '14%', delay: '1.1s',  dur: '3.8s', size: '18px' },
                { left: '24%', delay: '2.3s',  dur: '4.6s', size: '26px' },
                { left: '38%', delay: '0.5s',  dur: '3.5s', size: '20px' },
                { left: '52%', delay: '1.8s',  dur: '4.0s', size: '16px' },
                { left: '64%', delay: '0.9s',  dur: '4.4s', size: '24px' },
                { left: '75%', delay: '2.7s',  dur: '3.7s', size: '19px' },
                { left: '85%', delay: '1.4s',  dur: '4.1s', size: '21px' },
                { left: '92%', delay: '3.1s',  dur: '3.9s', size: '17px' },
              ] as const).map((h, i) => (
                <span
                  key={i}
                  aria-hidden
                  style={{
                    position: 'absolute',
                    bottom: '6px',
                    left: h.left,
                    fontSize: h.size,
                    color: 'rgba(255,255,255,0.75)',
                    animation: `floatHeart ${h.dur} ${h.delay} infinite ease-in`,
                    pointerEvents: 'none',
                    userSelect: 'none',
                    lineHeight: 1,
                  }}
                >
                  ♥
                </span>
              ))}
              <div
                className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/15 blur-3xl"
                aria-hidden
              />
              <div
                className="absolute -bottom-12 left-8 h-32 w-32 rounded-full bg-rose-300/25 blur-2xl"
                aria-hidden
              />
              <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
                <div className="flex min-w-0 flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-pink-100/95">
                    <Sparkles className="h-3 w-3 shrink-0" />
                    Orphanage manager
                  </div>
                  <h1 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
                    {welcomeMsg.heading(greeting)}
                  </h1>
                  <p className="max-w-2xl text-sm leading-relaxed text-pink-100/85">
                    {welcomeMsg.body}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    size="lg"
                    className="h-12 border-0 bg-white/95 px-7 text-base font-semibold text-pink-700 shadow-md shadow-black/10 hover:bg-white dark:bg-zinc-100 dark:text-rose-800 dark:hover:bg-white [&_svg]:size-[1.15rem]"
                    onClick={() => setCreateDialogOpen(true)}
                  >
                    <Plus className="mr-2 shrink-0" />
                    Create disputes
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-white/35 bg-white/10 text-white backdrop-blur-sm hover:bg-white/20 hover:text-white"
                    onClick={() => void fetchRows()}
                    disabled={loading}
                  >
                    <RefreshCw
                      className={loading ? 'mr-1.5 h-3.5 w-3.5 animate-spin' : 'mr-1.5 h-3.5 w-3.5'}
                    />
                    Refresh
                  </Button>
                </div>
              </div>
            </header>

            <section className="grid gap-3 sm:grid-cols-3" aria-label="Summary stats">
              <OrphanStatTile
                label="Awaiting review"
                value={rows.length}
                hint={rows.length === 0 ? 'Queue is clear' : 'Needs your verify or deny'}
                icon={HeartHandshake}
                accent="pink"
              />
              <OrphanStatTile
                label="Receipt log"
                value={verifiedRows.length}
                hint={
                  verifiedRows.length === 0
                    ? 'Nothing in the log yet'
                    : filteredVerified.length !== verifiedRows.length
                      ? `${filteredVerified.length} match search · ${awaitingAccountingCount} with Accounting`
                      : `${awaitingAccountingCount} awaiting Accounting · ${verifiedRows.length - awaitingAccountingCount} finalized`
                }
                icon={ClipboardList}
                accent="rose-deep"
              />
              <OrphanStatTile
                label="Hour source"
                value="Hubstaff"
                hint="Forgiveness only — no edits to tracked time."
                icon={CheckCircle2}
                accent="mono"
              />
            </section>

            <Card className="border-pink-100/80 bg-gradient-to-br from-white via-pink-50/30 to-white shadow-md ring-1 ring-pink-500/8 dark:border-pink-950/55 dark:from-zinc-950 dark:via-pink-950/12 dark:to-zinc-950 dark:ring-pink-400/10">
              <CardHeader className="flex flex-col gap-1 border-b border-pink-100/60 pb-4 dark:border-pink-900/40">
                <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-rose-700 to-zinc-900 text-white shadow-sm shadow-rose-700/25">
                        <ClipboardList className="h-4 w-4" />
                      </div>
                      <CardTitle className="text-base font-semibold">
                        Receipt log — manager &amp; Accounting outcomes
                      </CardTitle>
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Every dispute after manager review stays here — with Accounting pending, Accounting approved, or Accounting denied —
                      newest activity first ({awaitingAccountingCount} still with Accounting).
                    </p>
                  </div>
                  {!loading && verifiedRows.length > 0 ? (
                    <span className="shrink-0 text-xs font-medium text-pink-600/90 dark:text-pink-400/90">
                      {filteredVerified.length === verifiedRows.length
                        ? `${verifiedRows.length} in log`
                        : `${filteredVerified.length} of ${verifiedRows.length}`}
                    </span>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 pt-4">
                <div className="relative max-w-md">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                  <Input
                    value={verifiedSearch}
                    onChange={(e) => { setVerifiedSearch(e.target.value); setVerifiedPage(0); }}
                    placeholder="Search by email, note, status, or date..."
                    className="border-pink-100/70 bg-white/90 pl-9 disabled:opacity-60 dark:border-pink-900/50 dark:bg-zinc-900/70"
                    disabled={loading}
                  />
                </div>
                {loading ? null : filteredVerified.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-pink-200/80 bg-white/70 py-10 text-center dark:border-pink-900/50 dark:bg-zinc-950/40">
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                      {verifiedRows.length === 0
                        ? 'No disputes in this log yet — approvals and Accounting decisions will appear here.'
                        : 'No rows match your search.'}
                    </p>
                  </div>
                ) : (
                  <>
                  {/* Mobile: cards */}
                  <AnimatePresence mode="wait" initial={false} custom={pageDir}>
                  <motion.div
                    key={verifiedPage}
                    custom={pageDir}
                    variants={{
                      enter: (dir: number) => ({ opacity: 0, x: dir * 32 }),
                      center: { opacity: 1, x: 0 },
                      exit: (dir: number) => ({ opacity: 0, x: dir * -32 }),
                    }}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                    className="grid gap-3 sm:grid-cols-2 md:hidden"
                  >
                    {filteredVerified.slice(verifiedPage * PAGE_SIZE, (verifiedPage + 1) * PAGE_SIZE).map((row) => {
                      const st = orphanReceiptStatusMeta(row.status);
                      return (
                        <div
                          key={row.id}
                          className="flex flex-col gap-3 rounded-xl border border-pink-100/90 bg-white/85 p-4 ring-1 ring-pink-500/8 transition-shadow hover:shadow-md hover:shadow-pink-500/10 dark:border-pink-900/55 dark:bg-zinc-950/55 dark:ring-pink-400/10"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="min-w-0 break-all font-mono text-xs font-medium text-zinc-800 dark:text-zinc-200">
                              {row.work_email}
                            </p>
                            <Badge
                              variant="outline"
                              className={cn('shrink-0 text-[10px] font-medium', st.badgeClass)}
                            >
                              {st.label}
                            </Badge>
                          </div>
                          <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Visit date</span>
                              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{row.dispute_date}</span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Action by</span>
                              <span className="text-xs text-zinc-700 dark:text-zinc-300">{row.decided_by ?? '—'}</span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Action at</span>
                              <span className="text-xs text-zinc-500 dark:text-zinc-400">{formatVerifiedAt(row.decided_at)}</span>
                            </div>
                          </div>
                          {row.decision_note ? (
                            <p className="rounded-lg border border-pink-100/70 bg-pink-50/60 px-3 py-2 text-xs leading-relaxed text-zinc-600 dark:border-pink-900/40 dark:bg-pink-950/20 dark:text-zinc-400">
                              {row.decision_note}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </motion.div>
                  </AnimatePresence>

                  {/* Desktop: table */}
                  <AnimatePresence mode="wait" initial={false} custom={pageDir}>
                  <motion.div
                    key={verifiedPage}
                    custom={pageDir}
                    variants={{
                      enter: (dir: number) => ({ opacity: 0, x: dir * 32 }),
                      center: { opacity: 1, x: 0 },
                      exit: (dir: number) => ({ opacity: 0, x: dir * -32 }),
                    }}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                    className="hidden md:block overflow-x-auto rounded-xl border border-pink-100/90 ring-1 ring-pink-500/10 dark:border-pink-900/60 dark:ring-pink-400/10"
                  >
                    <table className="w-full min-w-[720px] text-left text-sm">
                      <thead className="sticky top-0 z-[1] bg-gradient-to-r from-pink-50 via-white to-pink-50/80 text-xs text-zinc-600 dark:from-pink-950/50 dark:via-zinc-950 dark:to-pink-950/40 dark:text-zinc-400">
                        <tr>
                          <th className="px-4 py-3 font-semibold">Employee</th>
                          <th className="px-4 py-3 font-semibold">Visit date</th>
                          <th className="px-4 py-3 font-semibold">Status</th>
                          <th className="px-4 py-3 font-semibold">Last action by</th>
                          <th className="px-4 py-3 font-semibold">Last action at</th>
                          <th className="px-4 py-3 font-semibold">Note</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-pink-100/70 bg-white/80 dark:divide-pink-900/35 dark:bg-zinc-950/40">
                        {filteredVerified.slice(verifiedPage * PAGE_SIZE, (verifiedPage + 1) * PAGE_SIZE).map((row) => {
                          const st = orphanReceiptStatusMeta(row.status);
                          return (
                            <tr
                              key={row.id}
                              className="align-top transition-colors hover:bg-pink-50/35 dark:hover:bg-pink-950/25"
                            >
                              <td className="whitespace-normal break-all px-4 py-3 font-mono text-xs">
                                {row.work_email}
                              </td>
                              <td className="whitespace-nowrap px-4 py-3">{row.dispute_date}</td>
                              <td className="whitespace-normal px-4 py-3">
                                <Badge
                                  variant="outline"
                                  className={cn('text-[10px] font-medium', st.badgeClass)}
                                >
                                  {st.label}
                                </Badge>
                              </td>
                              <td className="px-4 py-3 text-xs text-zinc-700 dark:text-zinc-300">
                                {row.decided_by ?? '—'}
                              </td>
                              <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                                {formatVerifiedAt(row.decided_at)}
                              </td>
                              <td className="max-w-[220px] px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                                {row.decision_note || '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </motion.div>
                  </AnimatePresence>
                  {filteredVerified.length > PAGE_SIZE && (
                    <div className="flex items-center justify-between border-t border-pink-100/60 px-4 py-3 dark:border-pink-900/40">
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        Page {verifiedPage + 1} of {Math.ceil(filteredVerified.length / PAGE_SIZE)}
                        {' · '}{filteredVerified.length} total
                      </span>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-3 text-xs border-pink-100/70 dark:border-pink-900/50"
                          disabled={verifiedPage === 0}
                          onClick={() => { setPageDir(-1); setVerifiedPage((p) => p - 1); }}
                        >
                          ← Prev
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-3 text-xs border-pink-100/70 dark:border-pink-900/50"
                          disabled={(verifiedPage + 1) * PAGE_SIZE >= filteredVerified.length}
                          onClick={() => { setPageDir(1); setVerifiedPage((p) => p + 1); }}
                        >
                          Next →
                        </Button>
                      </div>
                    </div>
                  )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </motion.div>
          ) : (
            <motion.div
              key="s-wall"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="shrink-0 border-b border-pink-100/70 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-pink-950/40 dark:bg-zinc-950">
                <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
                  Simple Wall
                </h1>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
                  Company-wide social feed. Post updates, react, and comment — live via Realtime.
                </p>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] dark:bg-[#0d1117]">
                <SWall viewerEmail={viewerEmail} canPost sourceLabel="Orphanage" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      <Toaster position="top-right" />

      <Dialog
        open={!!confirm}
        onOpenChange={(o) => {
          if (!o) {
            setConfirm(null);
            setDecisionNote('');
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {confirm?.action === 'deny' ? 'Deny orphanage dispute?' : 'Verify for Accounting?'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {confirm && (
                <>
                  {confirm.row.work_email} · {confirm.row.dispute_date}
                  <br />
                  No hour changes — PAB still uses Hubstaff time with orphanage rules after Accounting approves.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">Optional note (appears in the receipt log)</Label>
            <textarea
              value={decisionNote}
              onChange={(e) => setDecisionNote(e.target.value)}
              rows={3}
              placeholder="e.g. Confirmed with team lead, visit day matches schedule."
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setConfirm(null);
                setDecisionNote('');
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className={
                confirm?.action === 'deny'
                  ? 'bg-rose-600 hover:bg-rose-700'
                  : 'bg-emerald-600 hover:bg-emerald-700'
              }
              onClick={() => void runDecide()}
            >
              {confirm?.action === 'deny' ? 'Deny' : 'Verify & send to Accounting'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface OrphanStatTileProps {
  label: string;
  value: number | string;
  hint: string;
  icon: ComponentType<{ className?: string }>;
  accent: 'pink' | 'rose-deep' | 'mono';
}

function OrphanStatTile({ label, value, hint, icon: Icon, accent }: OrphanStatTileProps) {
  const accentMap = {
    pink: 'bg-gradient-to-br from-pink-400 to-rose-600 text-white shadow-rose-500/30',
    'rose-deep': 'bg-gradient-to-br from-rose-700 to-zinc-900 text-white shadow-rose-900/35',
    mono:
      'bg-gradient-to-br from-zinc-800 to-black text-white shadow-zinc-900/30 dark:from-zinc-200 dark:to-white dark:text-zinc-900 dark:shadow-zinc-200/20',
  } as const;

  return (
    <div className="group relative flex items-center gap-4 overflow-hidden rounded-xl border border-pink-100/80 bg-white/90 px-4 py-4 ring-1 ring-pink-500/5 backdrop-blur-sm transition-shadow hover:shadow-md hover:shadow-pink-500/10 dark:border-pink-950/50 dark:bg-zinc-950/75 dark:ring-pink-400/10 dark:hover:border-pink-800/60">
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg shadow-md',
          accentMap[accent],
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-pink-600/85 dark:text-pink-400/85">
          {label}
        </div>
        <div className="mt-0.5 bg-gradient-to-br from-zinc-900 via-rose-900 to-zinc-800 bg-clip-text text-xl font-bold tabular-nums text-transparent dark:from-white dark:via-pink-200 dark:to-zinc-200 sm:text-2xl">
          {value}
        </div>
        <div className="mt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{hint}</div>
      </div>
    </div>
  );
}
