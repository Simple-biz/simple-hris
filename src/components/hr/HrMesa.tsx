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
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { formatDateOnly } from '@/lib/date-only';
import { getHrTabCache, hasHrTabCache, HR_TAB_CACHE_KEYS, isHrTabCacheFresh, setHrTabCache } from '@/lib/hr/tab-cache';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import HrFpuEnrollments from './HrFpuEnrollments';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import type { EmployeeRow } from '@/lib/supabase/employees';

import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
type MesaTab = 'fpu' | 'eligible';

type EligibleRow = {
  key: string;
  name: string;
  work_email: string | null;
  personal_email: string | null;
  department: string | null;
  /**
   * The day their MESA membership opened — `employee_hourly_rates.mesa_member_since`,
   * taken verbatim. NOT derived here: the toggle route keeps it equal to the open
   * account's `opened_on` and `verify-mesa-backfill.mjs` asserts that, so computing
   * a start date from anything else would invent a second answer.
   */
  mesa_member_since: string | null;
};

const PAGE_SIZE = 15;

// Module-level cache so flipping between MESA sub-tabs (or away and back to
// the HR sidebar tab) doesn't re-fetch the rates + employees lists. Cleared
// on Refresh and on full page reload.
/**
 * The rows live in the shared HR tab store now (2026-09-17), not in a module
 * variable with an unconditional skip.
 *
 * `if (cached !== null) return;` is the exact bug `docs/features/hr-dashboard-cache.md`
 * was written to kill: no stamp, so an HR session left open all day never
 * re-pulled this list at all — only F5 or Refresh moved it. Now a warm entry
 * PAINTS (no skeleton on the way back) and anything past the 30s window
 * revalidates silently behind the rows already on screen.
 *
 * The key carries a schema suffix: bump it whenever the ROW SHAPE changes, or a
 * snapshot written by the previous build paints into a component expecting
 * different fields. v5 = the money rollup left this tab.
 */
const ELIGIBLE_KEY = `${HR_TAB_CACHE_KEYS.mesaEligible}:v5`;

export default function HrMesa() {
  // Lands on FPU Classes: it is the leftmost chip and the tab HR acts on
  // (create a class, approve seats); MESA Eligible is a read-only roll-up.
  const [tab, setTab] = useState<MesaTab>('fpu');

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
              FPU is the only way in — completing a class enrolls the member.
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
            active={tab === 'fpu'}
            onClick={() => setTab('fpu')}
            icon={GraduationCap}
            label="FPU Classes"
            tabKey="fpu"
          />
          <SubTabButton
            active={tab === 'eligible'}
            onClick={() => setTab('eligible')}
            icon={HeartHandshake}
            label="MESA Eligible"
            tabKey="eligible"
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
            {tab === 'eligible' ? <MesaEligibleList /> : <HrFpuEnrollments />}
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

function MesaEligibleList() {
  const [rows, setRows] = useState<EligibleRow[]>(() => getHrTabCache<EligibleRow[]>(ELIGIBLE_KEY) ?? []);
  const [loading, setLoading] = useState(() => !hasHrTabCache(ELIGIBLE_KEY));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  /**
   * `silent` is the revalidate path: no spinner, and on failure it leaves the
   * painted rows and the previous error state alone. A background refresh must
   * never undo the thing the cache is for.
   */
  const load = async (showSpinner = true, silent = false) => {
    if (!silent) {
      if (showSpinner) setLoading(true);
      else setRefreshing(true);
      setError(null);
    }
    try {
      // No ledger call. This tab answers WHO is in MESA and WHEN they joined, and
      // both come off the rates row; the money lives on Accounting -> MESA ->
      // Active Members, which is the surface that owns balances.
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
            mesa_member_since: rate.mesa_member_since ?? null,
          } as EligibleRow;
        })
        .filter((r): r is EligibleRow => r !== null)
        .sort((a, b) => a.name.localeCompare(b.name));

      setHrTabCache(ELIGIBLE_KEY, eligible);
      setRows(eligible);
      setError(null);
    } catch (e) {
      // A blip during a background revalidate must not blank rows or raise an
      // error card over data the user is reading.
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load MESA-eligible employees');
    } finally {
      if (!silent) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  useEffect(() => {
    // PAINT and SKIP are different questions (hr-dashboard-cache.md). A fresh
    // entry skips the round trip; a stale one still paints and revalidates
    // behind it; a cold one loads in the foreground.
    if (isHrTabCacheFresh(ELIGIBLE_KEY)) return;
    const warm = hasHrTabCache(ELIGIBLE_KEY);
    void load(!warm, warm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // A re-write restamps the entry, which re-opens the freshness window.
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
        <StatCard label="MESA members" value={rows.length} tone="teal" />
        <StatCard label="Departments" value={deptCount} tone="zinc" />
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
              : `${filtered.length} MESA ${filtered.length === 1 ? 'member' : 'members'}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <SkeletonRows count={6} />
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
              <Inbox className="h-6 w-6 text-zinc-400" />
              {rows.length === 0
                ? 'Nobody is in MESA yet — members are enrolled by completing an FPU class.'
                : 'No results match your search.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-teal-100/80 bg-teal-50/40 text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-900/40 dark:bg-teal-950/30 dark:text-teal-300">
                  <tr>
                    <th className="px-4 py-2.5">Name</th>
                    <th className="px-4 py-2.5">Work email</th>
                    <th className="px-4 py-2.5">Department</th>
                    <th className="px-4 py-2.5">In MESA since</th>
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
                        data-label="Department"
                        className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400"
                      >
                        {r.department ? (
                          <span className="inline-flex items-center gap-1" title={r.department ?? undefined}>
                            <Building2 className="h-3 w-3 text-zinc-400" />
                            {formatDeptLabel(r.department)}
                          </span>
                        ) : (
                          <span className="text-zinc-400">—</span>
                        )}
                      </td>
                      <td
                        data-label="In MESA since"
                        className="px-4 py-2.5 tabular-nums text-zinc-700 dark:text-zinc-300"
                      >
                        {/* A member with no start date is a real finding, not a blank: it
                            means the flag and the account row disagree, which is what
                            verify-mesa-backfill exists to catch. Say so rather than dash it. */}
                        {r.mesa_member_since ? (
                          formatDateOnly(r.mesa_member_since)
                        ) : (
                          <span className="text-amber-600 dark:text-amber-400" title="Flagged as a member but no mesa_member_since on their rates row">
                            not recorded
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && filtered.length > 0 && (
            <div data-readonly-allow className="flex items-center justify-between border-t border-teal-100/80 px-5 py-2.5 dark:border-teal-900/40">
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
            <th className="px-4 py-2.5">Department</th>
            <th className="px-4 py-2.5 text-right">Contributed</th>
            <th className="px-4 py-2.5 text-right">Simple.biz match</th>
            <th className="px-4 py-2.5 text-right">Balance</th>
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
                <div className="h-3 w-24 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
              </td>
              <td className="px-4 py-3 text-right">
                <div className="ml-auto h-3 w-16 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
              </td>
              <td className="px-4 py-3 text-right">
                <div className="ml-auto h-3 w-16 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
              </td>
              <td className="px-4 py-3 text-right">
                <div className="ml-auto h-3 w-16 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
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

