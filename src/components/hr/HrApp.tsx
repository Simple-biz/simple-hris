'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import {
  Building2,
  ChevronLeft,
  ChevronRight,
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
import SWall from '@/components/swall/SWall';
import type { EmployeeRow } from '@/lib/supabase/employees';

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
              {activeTab === 's-wall' && <HrSwallTab viewerEmail={viewerEmail} />}
            </motion.div>
          </AnimatePresence>
        </div>
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


const PAGE_SIZE = 10;

function OverviewBody() {
  const [roster, setRoster] = useState<EmployeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

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

  const filtered = useMemo(() => {
    setPage(0);
    const q = search.trim().toLowerCase();
    if (!q) return roster;
    return roster.filter((r) =>
      [r.name, r.work_email, r.department, r.employee_id]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q)),
    );
  }, [roster, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return (
    <>
      {/* KPI row */}
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: 'Active employees', value: roster.length, sub: 'on the master list',      icon: Users,     grad: 'from-emerald-500 to-teal-700' },
          { label: 'Departments',      value: deptStats.length, sub: 'with active headcount', icon: Building2, grad: 'from-teal-500 to-emerald-700' },
          { label: 'Largest dept',     value: deptStats[0]?.department ?? '—', sub: `${deptStats[0]?.count ?? 0} people`, icon: TrendingUp, grad: 'from-sky-500 to-sky-700' },
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

      {/* Roster */}
      <Card className="border-zinc-100 shadow-sm dark:border-zinc-800">
          <CardHeader className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-sm font-semibold">Active roster</CardTitle>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {loading ? 'Loading…' : `${filtered.length} of ${roster.length}`}
                </p>
              </div>
              <div className="relative w-52 shrink-0">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search…"
                  className="h-8 border-zinc-200 pl-8 text-xs dark:border-zinc-700"
                />
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
                        <td className="px-4 py-2 font-medium text-zinc-800 dark:text-zinc-200">{r.name ?? '—'}</td>
                        <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{r.department ?? '—'}</td>
                        <td className="px-4 py-2 font-mono text-zinc-500 dark:text-zinc-400">{r.work_email ?? '—'}</td>
                        <td className="px-4 py-2 font-mono text-zinc-500 dark:text-zinc-400">{r.personal_email ?? '—'}</td>
                        <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{r.city ?? '—'}</td>
                        <td className="px-4 py-2 text-zinc-400">{fmtDate(r.start_date)}</td>
                        <td className="px-4 py-2 tabular-nums text-zinc-400">{tenure(r.start_date)}</td>
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
