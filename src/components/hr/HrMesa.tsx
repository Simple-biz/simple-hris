'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  HeartHandshake,
  GraduationCap,
  Search,
  Inbox,
  RefreshCw,
  Mail,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock,
  XCircle,
  X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import HrFpuEnrollments from './HrFpuEnrollments';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import type { EmployeeRow } from '@/lib/supabase/employees';

type MesaTab = 'eligible' | 'requests' | 'fpu';

type EligibleRow = {
  key: string;
  name: string;
  work_email: string | null;
  personal_email: string | null;
  department: string | null;
};

const PAGE_SIZE = 15;

// Module-level cache so flipping between MESA sub-tabs (or away and back to
// the HR sidebar tab) doesn't re-fetch the rates + employees lists. Cleared
// on Refresh and on full page reload.
// Bump the suffix whenever the row-derivation logic changes — that way a
// previously-cached snapshot of "—" names doesn't survive into a session that
// would otherwise compute the email-derived fallback.
let cachedEligible_v3: EligibleRow[] | null = null;

export default function HrMesa() {
  const [tab, setTab] = useState<MesaTab>('eligible');

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-teal-50/30 to-emerald-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
      <div className="mx-auto w-full max-w-6xl space-y-5">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-100 to-emerald-100 text-teal-700 ring-1 ring-teal-100 dark:from-teal-950/60 dark:to-emerald-950/40 dark:text-teal-300 dark:ring-teal-900/60">
            <HeartHandshake className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-700 dark:text-teal-300">
              Medical Emergency Savings Account
            </p>
            <h2 className="mt-0.5 text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
              MESA
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              Review who's already MESA-eligible and follow up on FPU sign-ups —
              completing FPU is the only path into the program.
            </p>
          </div>
        </div>

        {/* Sub-tab switcher */}
        <div
          role="tablist"
          aria-label="MESA sections"
          className="relative inline-flex items-center gap-1 self-start rounded-lg border border-teal-100/80 bg-white/70 p-1 shadow-sm backdrop-blur dark:border-teal-900/40 dark:bg-zinc-900/60"
        >
          <SubTabButton
            active={tab === 'eligible'}
            onClick={() => setTab('eligible')}
            icon={HeartHandshake}
            label="MESA Eligible"
            tabKey="eligible"
          />
          <SubTabButton
            active={tab === 'requests'}
            onClick={() => setTab('requests')}
            icon={ClipboardList}
            label="Opt-in Requests"
            tabKey="requests"
          />
          <SubTabButton
            active={tab === 'fpu'}
            onClick={() => setTab('fpu')}
            icon={GraduationCap}
            label="FPU Enrollments"
            tabKey="fpu"
          />
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 8, filter: 'blur(2px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -6, filter: 'blur(2px)' }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            {tab === 'eligible' ? (
            <MesaEligibleList />
          ) : tab === 'requests' ? (
            <MesaOptInQueue />
          ) : (
            <FpuEmbed />
          )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function SubTabButton({
  active,
  onClick,
  icon: Icon,
  label,
  tabKey,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tabKey: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'relative inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors duration-200',
        active
          ? 'text-white'
          : 'text-zinc-600 hover:bg-teal-50/70 hover:text-teal-700 dark:text-zinc-400 dark:hover:bg-teal-950/40 dark:hover:text-teal-200',
      )}
    >
      {active && (
        <motion.span
          layoutId="hr-mesa-subtab-pill"
          aria-hidden
          className="absolute inset-0 rounded-md bg-gradient-to-r from-teal-500 to-emerald-500 shadow-sm"
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        />
      )}
      <span className="relative z-10 inline-flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <span className="sr-only">{tabKey}</span>
    </button>
  );
}

function FpuEmbed() {
  // HrFpuEnrollments already renders its own page chrome (header, padding,
  // gradient background). Strip the outer wrapper styles by rendering it
  // inside a neutral container — it'll fit naturally under the MESA header.
  return (
    <div className="-mt-4">
      <HrFpuEnrollments />
    </div>
  );
}

function MesaEligibleList() {
  const [rows, setRows] = useState<EligibleRow[]>(() => cachedEligible_v3 ?? []);
  const [loading, setLoading] = useState(() => cachedEligible_v3 === null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const load = async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const [ratesRes, employeesRes] = await Promise.all([
        fetch('/api/employee-hourly-rates', { cache: 'no-store' }),
        fetch('/api/employees', { cache: 'no-store' }),
      ]);
      if (!ratesRes.ok) throw new Error(`rates HTTP ${ratesRes.status}`);
      if (!employeesRes.ok) throw new Error(`employees HTTP ${employeesRes.status}`);
      const ratesJson = (await ratesRes.json()) as { rows?: EmployeeHourlyRateRow[] };
      const employeesJson = (await employeesRes.json()) as { employees?: EmployeeRow[] };

      // Build a lookup of MESA-eligible rates rows, keyed by both work_email
      // and personal_email. Only rows with mesa_member=true are indexed —
      // employees whose email doesn't appear here are simply not eligible.
      const mesaByEmail = new Map<string, EmployeeHourlyRateRow>();
      for (const r of ratesJson.rows ?? []) {
        if (!r.mesa_member) continue;
        const we = r.work_email?.toLowerCase().trim();
        const pe = r.personal_email?.toLowerCase().trim();
        if (we) mesaByEmail.set(we, r);
        if (pe) mesaByEmail.set(pe, r);
      }

      // Drive the list from the master list. An employee is shown only if at
      // least one of their emails matches a mesa_member=true rates row.
      const eligible: EligibleRow[] = (employeesJson.employees ?? [])
        .map((e) => {
          const we = e.work_email?.toLowerCase().trim();
          const pe = e.personal_email?.toLowerCase().trim();
          const rate = (we && mesaByEmail.get(we)) || (pe && mesaByEmail.get(pe)) || null;
          if (!rate) return null;
          return {
            key: we || pe || (e.employee_id ?? e.name ?? Math.random().toString(36)),
            name: e.name ?? '—',
            work_email: e.work_email ?? null,
            personal_email: e.personal_email ?? null,
            department: e.department ?? rate.department ?? null,
          } as EligibleRow;
        })
        .filter((r): r is EligibleRow => r !== null)
        .sort((a, b) => a.name.localeCompare(b.name));

      cachedEligible_v3 = eligible;
      setRows(eligible);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load MESA-eligible employees');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    // Skip the network round trip if we already have a warm cache —
    // the module-level cache survives sub-tab switches in the current session.
    if (cachedEligible_v3 !== null) return;
    void load(true);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.work_email ?? '').toLowerCase().includes(q) ||
        (r.personal_email ?? '').toLowerCase().includes(q) ||
        (r.department ?? '').toLowerCase().includes(q),
    );
  }, [rows, query]);

  // Reset to first page whenever the search narrows/widens the list.
  useEffect(() => {
    setPage(0);
  }, [query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const handleRefresh = async () => {
    cachedEligible_v3 = null;
    await load(false);
    toast.success('Refreshed MESA-eligible list');
  };

  const deptCount = useMemo(
    () => new Set(rows.map((r) => (r.department ?? '').trim().toLowerCase()).filter(Boolean)).size,
    [rows],
  );

  return (
    <div className="space-y-5">
      {/* Stat strip */}
      <div className="grid gap-3 sm:grid-cols-2">
        <StatCard label="MESA-eligible employees" value={rows.length} tone="teal" />
        <StatCard label="Distinct departments" value={deptCount} tone="zinc" />
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200/80 bg-rose-50/70 px-4 py-2.5 text-xs text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100">
          {error}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, email, or department…"
            className="h-9 border-zinc-200 bg-white pl-9 text-sm focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-800 dark:bg-zinc-900/60"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing || loading}
          className="gap-1.5"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* List */}
      <Card className="overflow-hidden border-teal-100/80 shadow-sm dark:border-teal-900/40">
        <CardHeader className="border-b border-teal-100/80 bg-teal-50/30 px-5 py-3 dark:border-teal-900/40 dark:bg-teal-950/20">
          <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
            {loading
              ? 'Loading MESA members…'
              : `${filtered.length} MESA-eligible ${filtered.length === 1 ? 'employee' : 'employees'}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <SkeletonRows count={6} />
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
              <Inbox className="h-6 w-6 text-zinc-400" />
              {rows.length === 0
                ? 'No MESA-eligible employees yet — members are flagged via the Rates tab.'
                : 'No results match your search.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-teal-100/80 bg-teal-50/40 text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-900/40 dark:bg-teal-950/30 dark:text-teal-300">
                  <tr>
                    <th className="px-4 py-2.5">Name</th>
                    <th className="px-4 py-2.5">Work email</th>
                    <th className="px-4 py-2.5">Personal email</th>
                    <th className="px-4 py-2.5">Department</th>
                    <th className="px-4 py-2.5 text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-teal-100/60 dark:divide-teal-900/40">
                  {pageRows.map((r, i) => (
                    <tr
                      key={`${r.key}-${safePage}-${i}`}
                      className="transition-colors hover:bg-teal-50/40 dark:hover:bg-teal-950/20"
                    >
                      <td
                        data-label="Name"
                        className="px-4 py-2.5 font-medium text-zinc-900 dark:text-zinc-100"
                      >
                        <span className="inline-flex items-center gap-2">
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-teal-50 text-teal-600 ring-1 ring-teal-100 dark:bg-teal-950/50 dark:text-teal-300 dark:ring-teal-900/60">
                            <HeartHandshake className="h-3 w-3" />
                          </span>
                          {r.name}
                        </span>
                      </td>
                      <td
                        data-label="Work email"
                        className="px-4 py-2.5 font-mono text-zinc-600 dark:text-zinc-400"
                      >
                        {r.work_email ? (
                          <a
                            href={`mailto:${r.work_email}`}
                            className="inline-flex items-center gap-1 hover:text-teal-700 dark:hover:text-teal-300"
                          >
                            <Mail className="h-3 w-3 text-zinc-400" />
                            {r.work_email}
                          </a>
                        ) : (
                          <span className="text-zinc-400">—</span>
                        )}
                      </td>
                      <td
                        data-label="Personal email"
                        className="px-4 py-2.5 font-mono text-zinc-600 dark:text-zinc-400"
                      >
                        {r.personal_email ? (
                          <a
                            href={`mailto:${r.personal_email}`}
                            className="hover:text-teal-700 dark:hover:text-teal-300"
                          >
                            {r.personal_email}
                          </a>
                        ) : (
                          <span className="text-zinc-400">—</span>
                        )}
                      </td>
                      <td
                        data-label="Department"
                        className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400"
                      >
                        {r.department ? (
                          <span className="inline-flex items-center gap-1">
                            <Building2 className="h-3 w-3 text-zinc-400" />
                            {r.department}
                          </span>
                        ) : (
                          <span className="text-zinc-400">—</span>
                        )}
                      </td>
                      <td data-label="Status" className="px-4 py-2.5 text-right">
                        <Badge
                          variant="outline"
                          className="border-teal-200 bg-teal-50 text-[10.5px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-200"
                        >
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          Enrolled
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && filtered.length > 0 && (
            <div className="flex items-center justify-between border-t border-teal-100/80 px-5 py-2.5 dark:border-teal-900/40">
              <p className="text-[11px] text-zinc-400">
                {filtered.length === 0
                  ? '0'
                  : `${safePage * PAGE_SIZE + 1}–${Math.min((safePage + 1) * PAGE_SIZE, filtered.length)}`}{' '}
                of {filtered.length}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  disabled={safePage === 0}
                  onClick={() => setPage(0)}
                  aria-label="First page"
                >
                  <ChevronLeft className="h-3 w-3" />
                  <ChevronLeft className="-ml-2 h-3 w-3" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  disabled={safePage === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-3 w-3" />
                </Button>
                <span className="min-w-[4rem] text-center text-[11px] text-zinc-500">
                  {safePage + 1} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-3 w-3" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setPage(totalPages - 1)}
                  aria-label="Last page"
                >
                  <ChevronRight className="h-3 w-3" />
                  <ChevronRight className="-ml-2 h-3 w-3" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="border-b border-teal-100/80 bg-teal-50/40 text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-900/40 dark:bg-teal-950/30 dark:text-teal-300">
          <tr>
            <th className="px-4 py-2.5">Name</th>
            <th className="px-4 py-2.5">Work email</th>
            <th className="px-4 py-2.5">Personal email</th>
            <th className="px-4 py-2.5">Department</th>
            <th className="px-4 py-2.5 text-right">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-teal-100/60 dark:divide-teal-900/40">
          {Array.from({ length: count }).map((_, i) => (
            <tr key={i}>
              <td className="px-4 py-3">
                <div className="h-3.5 w-32 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
              </td>
              <td className="px-4 py-3">
                <div className="h-3 w-44 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
              </td>
              <td className="px-4 py-3">
                <div className="h-3 w-44 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
              </td>
              <td className="px-4 py-3">
                <div className="h-3 w-24 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
              </td>
              <td className="px-4 py-3 text-right">
                <div className="ml-auto h-5 w-20 animate-pulse rounded-full bg-teal-100/60 dark:bg-teal-900/30" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Opt-in Request Queue ───────────────────────────────────────────────────

interface OptInRequest {
  id: string;
  work_email: string;
  full_name: string;
  department: string;
  fpu_date: string | null;
  status: string;
  review_notes: string | null;
  reviewed_by: string | null;
  created_at: string;
}

let cachedOptInRequests: OptInRequest[] | null = null;

function MesaOptInQueue() {
  const [rows, setRows] = useState<OptInRequest[]>(() => cachedOptInRequests ?? []);
  const [loading, setLoading] = useState(cachedOptInRequests === null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [reviewTarget, setReviewTarget] = useState<OptInRequest | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewing, setReviewing] = useState(false);

  const load = async (showSpinner = true) => {
    if (showSpinner) setLoading(true); else setRefreshing(true);
    try {
      const res = await fetch('/api/mesa-requests?request_type=opt_in', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { rows?: OptInRequest[] };
      const data = json.rows ?? [];
      cachedOptInRequests = data;
      setRows(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load opt-in requests');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (cachedOptInRequests !== null) return;
    void load(true);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filterStatus && r.status !== filterStatus) return false;
      if (!q) return true;
      return (
        r.work_email.toLowerCase().includes(q) ||
        r.full_name.toLowerCase().includes(q) ||
        r.department.toLowerCase().includes(q)
      );
    });
  }, [rows, query, filterStatus]);

  const stats = useMemo(() => ({
    total: rows.length,
    pending: rows.filter((r) => r.status === 'pending').length,
    approved: rows.filter((r) => r.status === 'approved').length,
  }), [rows]);

  const openReview = (r: OptInRequest) => {
    setReviewTarget(r);
    setReviewNotes('');
  };

  const submitReview = async (status: 'approved' | 'denied') => {
    if (!reviewTarget) return;
    setReviewing(true);
    try {
      const res = await fetch(`/api/mesa-requests/${reviewTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, review_notes: reviewNotes.trim() || null }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      // On approval, flip the mesa_member flag automatically
      if (status === 'approved') {
        try {
          await fetch('/api/toggle-mesa-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workEmail: reviewTarget.work_email,
              mesaMember: true,
              name: reviewTarget.full_name,
            }),
          });
        } catch {
          toast.error('Approved, but could not auto-enroll in MESA — please toggle manually in Rates.');
        }
      }
      toast.success(`Opt-in request ${status}`);
      setReviewTarget(null);
      cachedOptInRequests = null;
      await load(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Review failed');
    } finally {
      setReviewing(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Stats */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Total opt-in requests" value={stats.total} tone="teal" />
        <StatCard label="Pending review" value={stats.pending} tone="zinc" />
        <StatCard label="Approved" value={stats.approved} tone="teal" />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email, department..."
            className="h-9 border-zinc-200 bg-white pl-9 text-sm focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-800 dark:bg-zinc-900/60"
          />
        </div>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="h-9 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-700 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300"
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="denied">Denied</option>
        </select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => { cachedOptInRequests = null; void load(false); toast.success('Refreshed'); }}
          disabled={refreshing || loading}
          className="gap-1.5"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Table */}
      <Card className="overflow-hidden border-teal-100/80 shadow-sm dark:border-teal-900/40">
        <CardHeader className="border-b border-teal-100/80 bg-teal-50/30 px-5 py-3 dark:border-teal-900/40 dark:bg-teal-950/20">
          <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
            {loading ? 'Loading...' : `${filtered.length} opt-in request${filtered.length === 1 ? '' : 's'}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="divide-y divide-teal-100/60 dark:divide-teal-900/40">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3">
                  <div className="h-4 w-32 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
                  <div className="h-3 w-24 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
                  <div className="ml-auto h-7 w-16 animate-pulse rounded bg-teal-100/60 dark:bg-teal-900/30" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
              <Inbox className="h-6 w-6 text-zinc-400" />
              {rows.length === 0 ? 'No opt-in requests yet.' : 'No results match your search.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-teal-100/80 bg-teal-50/40 text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-900/40 dark:bg-teal-950/30 dark:text-teal-300">
                  <tr>
                    <th className="px-4 py-2.5">Employee</th>
                    <th className="px-4 py-2.5">Department</th>
                    <th className="px-4 py-2.5">FPU Completed</th>
                    <th className="px-4 py-2.5 text-right">Status</th>
                    <th className="px-4 py-2.5 text-right">Submitted</th>
                    <th className="px-4 py-2.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-teal-100/60 dark:divide-teal-900/40">
                  {filtered.map((r) => (
                    <tr key={r.id} className="transition-colors hover:bg-teal-50/40 dark:hover:bg-teal-950/20">
                      <td className="px-4 py-3" data-label="Employee">
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.full_name}</div>
                        <div className="mt-0.5 font-mono text-[11px] text-zinc-500">{r.work_email}</div>
                      </td>
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400" data-label="Department">
                        {r.department}
                      </td>
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400" data-label="FPU Completed">
                        {r.fpu_date ?? <span className="text-zinc-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right" data-label="Status">
                        {r.status === 'approved' ? (
                          <Badge variant="outline" className="border-teal-200 bg-teal-50 text-[10.5px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-200">
                            <CheckCircle2 className="mr-1 h-3 w-3" />Approved
                          </Badge>
                        ) : r.status === 'denied' ? (
                          <Badge variant="outline" className="border-rose-200 bg-rose-50 text-[10.5px] font-semibold uppercase tracking-wide text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-200">
                            <XCircle className="mr-1 h-3 w-3" />Denied
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[10.5px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200">
                            <Clock className="mr-1 h-3 w-3" />Pending
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-zinc-500 dark:text-zinc-500" data-label="Submitted">
                        {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </td>
                      <td className="px-4 py-3 text-right" data-label="Action">
                        {r.status === 'pending' ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => openReview(r)}
                            className="h-7 border-teal-200 bg-teal-50/60 text-[11px] font-semibold text-teal-700 hover:bg-teal-100 dark:border-teal-700/50 dark:bg-teal-950/30 dark:text-teal-300"
                          >
                            Review
                          </Button>
                        ) : (
                          <span className="text-[11px] text-zinc-400">
                            {r.reviewed_by ? `by ${r.reviewed_by.split('@')[0]}` : '—'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Review modal */}
      {reviewTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-teal-600 dark:text-teal-400">
                  MESA Opt-in Request
                </p>
                <h3 className="mt-0.5 text-base font-bold text-zinc-900 dark:text-white">
                  {reviewTarget.full_name}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setReviewTarget(null)}
                className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 px-5 py-4">
              <InfoRow label="Email" value={reviewTarget.work_email} />
              <InfoRow label="Department" value={reviewTarget.department} />
              {reviewTarget.fpu_date && <InfoRow label="FPU Completed" value={reviewTarget.fpu_date} />}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                  Review Notes (optional)
                </p>
                <textarea
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  rows={3}
                  placeholder="Add a note for the employee..."
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </div>
              <div className="rounded-md border border-teal-100 bg-teal-50/60 p-3 text-xs leading-relaxed text-teal-800 dark:border-teal-900/40 dark:bg-teal-950/20 dark:text-teal-200">
                Approving will automatically set this employee as a MESA member in the system.
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <Button type="button" variant="outline" size="sm" onClick={() => setReviewTarget(null)} disabled={reviewing}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={reviewing}
                onClick={() => submitReview('denied')}
                className="border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-300"
              >
                <XCircle className="mr-1.5 h-3.5 w-3.5" />
                Deny
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={reviewing}
                onClick={() => submitReview('approved')}
                className="bg-teal-600 text-white hover:bg-teal-700"
              >
                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                Approve &amp; Enroll
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{label}</p>
      <p className="mt-0.5 text-sm text-zinc-800 dark:text-zinc-200">{value}</p>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'teal' | 'zinc';
}) {
  const styles = {
    teal:
      'border-teal-200 bg-gradient-to-br from-teal-50 to-white text-teal-900 dark:border-teal-700/40 dark:from-teal-950/40 dark:to-zinc-950 dark:text-teal-100',
    zinc:
      'border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-100',
  }[tone];
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${styles}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}
