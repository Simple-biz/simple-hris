'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, ClipboardCheck, EyeOff, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { cn } from '@/lib/utils';
import { catalogDeptNameFrom } from '@/lib/departments/dept-identity';

/**
 * The Payroll Wizard's step-6 "Done" tab — the RECEIPTS list.
 *
 * Everyone the accountants have acted on this PAB period, from BOTH decision
 * paths: forgiven (approved `pab_day_disputes` days — the step's month batch,
 * the calendar modal, the Attendance Issues panel all write the same rows) and
 * ignored (a `pab_period_exclusions` entry for the month). It exists because a
 * decided row now LEAVES the review list (Kane 2026-09-01 PM), and several
 * people work this step at once — the receipts are how they see each other's
 * decisions instead of re-deciding them.
 *
 * Same contract as `PabIneligibleTable`: it renders THE ROWS THE STEP COMPUTED,
 * verbatim. Nothing here re-derives a verdict; the wizard's `pabDoneRows` memo
 * folds the two existing stores and this component only filters what is
 * DISPLAYED.
 */

export type PabDoneRow = {
  /** Join key. NEVER rendered — the master quoted nickname is what people are called. */
  email: string;
  name: string | null;
  employeeId: string | null;
  workEmail: string | null;
  /** RAW key; formatted at the render site only. */
  departmentKey: string | null;
  isHsl: boolean;
  /** PAB-excluded for this month (Ignore here, or the System Bonus modal). */
  ignored: boolean;
  /** Approved forgiven days inside this PAB period, sorted ISO ascending. */
  forgivenDays: string[];
};

const PAGE_SIZE = 25;
const NO_DEPT = '__none__';

function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function PabDoneTable({
  rows,
  deptNames,
  monthLabel,
}: {
  /** The step's array, verbatim. */
  rows: PabDoneRow[];
  deptNames: ReadonlyMap<string, string>;
  monthLabel: string;
}) {
  const [query, setQuery] = useState('');
  const [decisionFilter, setDecisionFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [page, setPage] = useState(1);
  const reduceMotion = useReducedMotion() ?? false;

  const deptOptions = useMemo(() => {
    const byKey = new Map<string, string>();
    let hasNone = false;
    for (const r of rows) {
      if (r.departmentKey) byKey.set(r.departmentKey, catalogDeptNameFrom(r.departmentKey, deptNames));
      else hasNone = true;
    }
    const opts = [
      { value: '', label: 'All departments' },
      ...[...byKey.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([value, label]) => ({ value, label })),
    ];
    if (hasNone) opts.push({ value: NO_DEPT, label: 'No department' });
    return opts;
  }, [rows, deptNames]);

  // The filter Kane asked for: both decisions, narrowable to either. Options
  // appear only when some row is actually in them, like the review tab's bands.
  const decisionOptions = useMemo(() => {
    const opts = [{ value: '', label: 'All decisions' }];
    if (rows.some((r) => r.forgivenDays.length > 0)) opts.push({ value: 'forgiven', label: 'Forgiven' });
    if (rows.some((r) => r.ignored)) opts.push({ value: 'ignored', label: 'Ignored' });
    return opts;
  }, [rows]);

  // A selection that leaves the data resets itself rather than stranding the
  // table on an empty view with no way back.
  useEffect(() => {
    if (deptFilter && !deptOptions.some((o) => o.value === deptFilter)) setDeptFilter('');
  }, [deptOptions, deptFilter]);
  useEffect(() => {
    if (decisionFilter && !decisionOptions.some((o) => o.value === decisionFilter)) setDecisionFilter('');
  }, [decisionOptions, decisionFilter]);

  const visible = useMemo(() => {
    let list = rows;
    if (decisionFilter === 'forgiven') list = list.filter((r) => r.forgivenDays.length > 0);
    else if (decisionFilter === 'ignored') list = list.filter((r) => r.ignored);
    if (deptFilter) {
      list = deptFilter === NO_DEPT
        ? list.filter((r) => !r.departmentKey)
        : list.filter((r) => r.departmentKey === deptFilter);
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (r) =>
          (r.name ?? '').toLowerCase().includes(q) ||
          (r.employeeId ?? '').toLowerCase().includes(q) ||
          (r.workEmail ?? '').toLowerCase().includes(q) ||
          catalogDeptNameFrom(r.departmentKey, deptNames).toLowerCase().includes(q),
      );
    }
    return list;
  }, [rows, query, decisionFilter, deptFilter, deptNames]);

  // Filters reset the page; row-array changes (a decision arriving live from
  // another operator) do not — same rule as the review tab.
  useEffect(() => { setPage(1); }, [query, decisionFilter, deptFilter]);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const paged = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const forgivenCount = rows.filter((r) => r.forgivenDays.length > 0).length;
  const ignoredCount = rows.filter((r) => r.ignored).length;

  if (rows.length === 0) {
    // One honest empty state: nothing has been decided. Unlike the review tab
    // there is no all-clear hazard here — an empty receipts list claims only
    // that no one has acted yet, which is exactly what it means.
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-zinc-200 bg-zinc-50/60 px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-900/30">
        <ClipboardCheck className="h-6 w-6 text-zinc-400" />
        <p className="text-sm font-semibold text-zinc-900 dark:text-white">
          No decisions yet for {monthLabel}
        </p>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          People forgiven or ignored on the review tab land here — including decisions
          made by other accountants, live.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {forgivenCount > 0 && (
            <span className="rounded-full border border-emerald-300/70 bg-emerald-50 px-2.5 py-0.5 font-medium text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-200">
              {forgivenCount} forgiven
            </span>
          )}
          {ignoredCount > 0 && (
            <span className="rounded-full border border-zinc-300 bg-zinc-100 px-2.5 py-0.5 font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {ignoredCount} ignored
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {decisionOptions.length > 1 && (
            <label className="flex items-center gap-1.5">
              <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Decision</span>
              <SmoothSelect
                aria-label="Filter by decision"
                value={decisionFilter}
                onChange={setDecisionFilter}
                portal
                triggerClassName="h-8 w-[10rem] text-xs"
                options={decisionOptions}
              />
            </label>
          )}
          {deptOptions.length > 1 && (
            <label className="flex items-center gap-1.5">
              <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Dept</span>
              <SmoothSelect
                aria-label="Filter by department"
                value={deptFilter}
                onChange={setDeptFilter}
                portal
                triggerClassName="h-8 w-[14rem] text-xs"
                searchable={deptOptions.length > 8}
                searchPlaceholder="Search departments…"
                options={deptOptions}
              />
            </label>
          )}
          <div className="relative w-[15rem]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, ID, email or department"
              className="h-8 pl-8 text-xs"
            />
          </div>
          {(decisionFilter || deptFilter || query) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-[11px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              onClick={() => { setDecisionFilter(''); setDeptFilter(''); setQuery(''); }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      <div className="min-w-0 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full min-w-[880px] text-sm">
          <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900/60 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-2.5 text-left font-semibold">Employee ID</th>
              <th className="px-3 py-2.5 text-left font-semibold">Employee</th>
              <th className="px-3 py-2.5 text-left font-semibold">Work Email</th>
              <th className="px-3 py-2.5 text-left font-semibold">Department</th>
              <th className="px-3 py-2.5 text-left font-semibold">Decision</th>
              <th className="px-3 py-2.5 text-left font-semibold">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {/* Exit-only, mirroring the review tab: an un-ignored person slides
                out; page flips and live arrivals play no entrances. */}
            <AnimatePresence initial={false}>
            {paged.map((row) => (
              <motion.tr
                key={row.email}
                className="hover:bg-zinc-50/70 dark:hover:bg-zinc-900/40"
                exit={reduceMotion
                  ? { opacity: 0, transition: { duration: 0 } }
                  : { opacity: 0, x: 48, transition: { duration: 0.28, ease: 'easeOut' } }}
              >
                <td className="px-4 py-2.5">
                  <span className="font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
                    {row.employeeId ?? '—'}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  {row.name ? (
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">{row.name}</div>
                  ) : (
                    <div title={row.email} className="font-medium italic text-amber-700 dark:text-amber-400">
                      Unknown — not on the master list
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <span className="font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
                    {row.workEmail ?? '—'}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-xs text-zinc-600 dark:text-zinc-400">
                  {catalogDeptNameFrom(row.departmentKey, deptNames) || '—'}
                  {row.isHsl && (
                    <span className="ml-1.5 rounded border border-violet-300/70 bg-violet-50 px-1 py-px text-[10px] font-semibold text-violet-700 dark:border-violet-700/60 dark:bg-violet-950/40 dark:text-violet-300">
                      HSL
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  {/* A person can carry BOTH — forgiven days and a later Ignore.
                      Both chips render; the exclusion is what pays (₱0). */}
                  <div className="flex flex-wrap items-center gap-1">
                    {row.forgivenDays.length > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300/70 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-200">
                        <Check className="h-3 w-3" /> Forgiven
                      </span>
                    )}
                    {row.ignored && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                        <EyeOff className="h-3 w-3" /> Ignored
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                    {row.forgivenDays.length > 0 && (
                      <>
                        <span className="shrink-0">
                          {row.forgivenDays.length} day{row.forgivenDays.length === 1 ? '' : 's'}:
                        </span>
                        {row.forgivenDays.slice(0, 3).map((iso) => (
                          <span
                            key={iso}
                            className="rounded border border-emerald-200 bg-emerald-50/60 px-1.5 py-px font-mono text-[10px] text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300"
                          >
                            {formatDay(iso)}
                          </span>
                        ))}
                        {row.forgivenDays.length > 3 && (
                          <span
                            title={row.forgivenDays.map(formatDay).join(', ')}
                            className="px-1 text-[10px] text-zinc-400"
                          >
                            +{row.forgivenDays.length - 3} more
                          </span>
                        )}
                      </>
                    )}
                    {row.ignored && (
                      <span className={cn('text-[11px]', row.forgivenDays.length > 0 && 'ml-1')}>
                        ₱0 this period — lift in System Bonus → PAB settings
                      </span>
                    )}
                  </div>
                </td>
              </motion.tr>
            ))}
            </AnimatePresence>
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
          {visible.length !== rows.length && <AlertTriangle className="h-3 w-3" />}
          {visible.length === 0
            ? 'No one matches these filters'
            : `Showing ${(safePage - 1) * PAGE_SIZE + 1}–${Math.min(safePage * PAGE_SIZE, visible.length)} of ${visible.length}`}
          {visible.length !== rows.length && ` (filtered from ${rows.length} — filters narrow this view only, nothing is removed)`}
        </p>
        {pageCount > 1 && (
          <div className="flex items-center gap-1">
            <Button
              type="button" variant="outline" size="sm"
              className="h-7 px-2 text-[11px] disabled:opacity-40"
              disabled={safePage <= 1}
              onClick={() => setPage((n) => Math.max(1, n - 1))}
            >
              <ChevronLeft className="h-3 w-3" /> Prev
            </Button>
            <span className="px-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
              {safePage} / {pageCount}
            </span>
            <Button
              type="button" variant="outline" size="sm"
              className="h-7 px-2 text-[11px] disabled:opacity-40"
              disabled={safePage >= pageCount}
              onClick={() => setPage((n) => Math.min(pageCount, n + 1))}
            >
              Next <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
