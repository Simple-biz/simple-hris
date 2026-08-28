'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, Check, ChevronLeft, ChevronRight, Loader2, ShieldCheck, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { cn } from '@/lib/utils';
import { pabSeverityBand, type PabFailedDay, type PabSeverityBand } from '@/lib/payroll/pab-ineligibility';
import { catalogDeptNameFrom } from '@/lib/departments/dept-identity';

/**
 * The Payroll Wizard's step-6 PAB review table.
 *
 * ## The one rule this component exists to obey
 *
 * It renders THE SAME rows the step computed — it never re-filters, re-sorts by a
 * different predicate, or re-derives a verdict. That is the contract
 * `ValidationFullScreen` states for the step-7 validation mirror, and it is what
 * keeps this from becoming yet another independent PAB implementation in a codebase
 * that already has eight of them. The search box filters what is DISPLAYED and the
 * count line says so; nothing here decides who is eligible.
 *
 * ## Severity
 *
 * `severity` is how many days actually cost the person the bonus — for HSL that
 * already excludes weekends, overnight-split shifts and weeks that reconciled, so a
 * low number is meaningful rather than an artefact of a shifting schedule. One or
 * two is the band worth a human look, which is the entire reason the column exists.
 * It is a prompt, never a gate.
 *
 * Amber is used ONLY for the review band. It is the wizard's warning colour and must
 * not be borrowed for an OK state (see the step-2 header cards ruling).
 */

export type PabIneligibleRow = {
  /** Join key and the value every write is addressed to. NEVER rendered — it is a
   *  personal address, and the master quoted nickname is what people are called
   *  here (`calcResults.name`, the one fix point for wizard display names). */
  email: string;
  /** Master quoted nickname. `null` when the person is on no master record — the
   *  table says so explicitly rather than falling back to their email address. */
  name: string | null;
  /** Master `employee_id` (`YYMM-NNNN`). Null when the active roster has no row
   *  for them. Safe to show — an internal id, not a contact address. */
  employeeId: string | null;
  /** RAW department key. Formatted at the render site, never before — an
   *  `hsl:*` slug must not reach a human (docs/features/hsl-subdepartments.md). */
  departmentKey: string | null;
  isHsl: boolean;
  severity: number;
  failedDays: PabFailedDay[];
  /** Already zeroed for the month by an accountant — a forgive here would be undone. */
  excluded: boolean;
};

const BAND_STYLES: Record<PabSeverityBand, { chip: string; label: string }> = {
  eligible: {
    chip: 'border-emerald-300/70 bg-emerald-50 text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-200',
    label: 'Eligible',
  },
  review: {
    chip: 'border-amber-300/70 bg-amber-50 text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200',
    label: 'Review',
  },
  high: {
    chip: 'border-rose-300/70 bg-rose-50 text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200',
    label: 'Repeated',
  },
};

function formatShortfall(sec: number): string {
  if (sec <= 0) return '0m';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

const PAGE_SIZE = 25;

/** '' = every department; this = rows whose department could not be resolved. */
const NO_DEPT = '__none__';

function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function PabIneligibleTable({
  rows,
  deptNames,
  monthLabel,
  onOpenCalendar,
  onForgiveMonth,
  forgivingEmail,
  readOnly,
  loading,
  evaluatedCount,
}: {
  /** The step's array, verbatim. */
  rows: PabIneligibleRow[];
  /** Payment Catalog `key → display name`, parents and sub-units. Without it a
   *  catalog-only department renders as its raw slug. */
  deptNames: ReadonlyMap<string, string>;
  monthLabel: string;
  onOpenCalendar: (email: string) => void;
  onForgiveMonth: (row: PabIneligibleRow) => void;
  /** Email currently mid-forgive, or null. */
  forgivingEmail: string | null;
  /** Replay of a past week — the figures are history, so no writes. */
  readOnly: boolean;
  /** The all-weeks PAB merge is still in flight. */
  loading: boolean;
  /** How many people the wizard has a PAB verdict for. Zero with `loading` false
   *  means the month could not be evaluated — NOT that everyone passed. */
  evaluatedCount: number;
}) {
  const [query, setQuery] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [bandFilter, setBandFilter] = useState('');
  const [page, setPage] = useState(1);

  // Departments present in THESE rows. Built off the unfiltered list so the
  // options cannot shift under the pointer while another filter is being used.
  // The raw key is the VALUE and the formatted label is what is shown — an
  // `hsl:*` slug must never reach a human (docs/features/hsl-subdepartments.md).
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
    // Unresolvable people stay reachable under their own bucket rather than
    // dropping out of every view — a filter never hides a row.
    if (hasNone) opts.push({ value: NO_DEPT, label: 'No department' });
    return opts;
  }, [rows, deptNames]);

  const bandOptions = useMemo(() => {
    const present = new Set(rows.map((r) => pabSeverityBand(r.severity)));
    const opts = [{ value: '', label: 'All statuses' }];
    if (present.has('review')) opts.push({ value: 'review', label: 'Review (1–2 days)' });
    if (present.has('high')) opts.push({ value: 'high', label: 'Repeated (3+ days)' });
    if (rows.some((r) => r.excluded)) opts.push({ value: 'excluded', label: 'Excluded from PAB' });
    return opts;
  }, [rows]);

  // A value that leaves the data must not strand the table on an empty view with
  // no way back — drop the selection instead of leaving it dangling.
  useEffect(() => {
    if (deptFilter && !deptOptions.some((o) => o.value === deptFilter)) setDeptFilter('');
  }, [deptOptions, deptFilter]);
  useEffect(() => {
    if (bandFilter && !bandOptions.some((o) => o.value === bandFilter)) setBandFilter('');
  }, [bandOptions, bandFilter]);

  const visible = useMemo(() => {
    let list = rows;
    if (deptFilter) {
      list = deptFilter === NO_DEPT
        ? list.filter((r) => !r.departmentKey)
        : list.filter((r) => r.departmentKey === deptFilter);
    }
    if (bandFilter) {
      list = bandFilter === 'excluded'
        ? list.filter((r) => r.excluded)
        : list.filter((r) => pabSeverityBand(r.severity) === bandFilter);
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (r) =>
          (r.name ?? '').toLowerCase().includes(q) ||
          (r.employeeId ?? '').toLowerCase().includes(q) ||
          catalogDeptNameFrom(r.departmentKey, deptNames).toLowerCase().includes(q),
      );
    }
    return list;
  }, [rows, query, deptFilter, bandFilter, deptNames]);

  // Page follows the filter: narrowing the search on page 4 of an unfiltered list
  // would otherwise land on an empty page that looks like "no matches".
  useEffect(() => { setPage(1); }, [query, deptFilter, bandFilter, rows]);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const paged = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const reviewCount = rows.filter((r) => pabSeverityBand(r.severity) === 'review').length;

  // An empty list has THREE causes and they are not interchangeable. Claiming
  // "nobody is ineligible" while the month has not been evaluated is the worst
  // possible failure for this surface: it is the all-clear that hides the very
  // people the step exists to surface. Only assert it when the data is in.
  if (rows.length === 0) {
    if (loading) {
      return (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-zinc-200 bg-zinc-50/60 px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-900/30">
          <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
          <p className="text-sm font-semibold text-zinc-900 dark:text-white">
            Loading attendance for {monthLabel}
          </p>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Merging every uploaded Hubstaff week in the PAB period — this is the slowest
            fetch in the wizard.
          </p>
        </div>
      );
    }
    if (evaluatedCount === 0) {
      return (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-amber-300/70 bg-amber-50/60 px-6 py-10 text-center dark:border-amber-800/50 dark:bg-amber-950/20">
          <AlertTriangle className="h-6 w-6 text-amber-600 dark:text-amber-400" />
          <p className="text-sm font-semibold text-zinc-900 dark:text-white">
            {monthLabel} could not be evaluated
          </p>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            No PAB verdicts were produced for this period, so this is <strong>not</strong> an
            all-clear. Check that the month&rsquo;s Hubstaff weeks are uploaded on Step 1 and
            that the PAB period is set in System Bonus.
          </p>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-emerald-200/70 bg-emerald-50/50 px-6 py-10 text-center dark:border-emerald-900/40 dark:bg-emerald-950/20">
        <ShieldCheck className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
        <p className="text-sm font-semibold text-zinc-900 dark:text-white">
          Nobody is ineligible for {monthLabel}
        </p>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          All {evaluatedCount.toLocaleString()} evaluated people cleared the attendance rule
          for this PAB period.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-rose-300/70 bg-rose-50 px-2.5 py-0.5 font-medium text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
            {rows.length} ineligible
          </span>
          {reviewCount > 0 && (
            <span className="rounded-full border border-amber-300/70 bg-amber-50 px-2.5 py-0.5 font-medium text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
              {reviewCount} worth a look (1–2 days)
            </span>
          )}
        </div>
        {/* Filters share one row and one height with the search box. `portal` is
            required, not cosmetic: the menu would otherwise be clipped by the
            table card's scroll/overflow ancestors and open as a sliver. */}
        <div className="flex flex-wrap items-center gap-2">
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
          {bandOptions.length > 1 && (
            <label className="flex items-center gap-1.5">
              <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Status</span>
              <SmoothSelect
                aria-label="Filter by status"
                value={bandFilter}
                onChange={setBandFilter}
                portal
                triggerClassName="h-8 w-[12rem] text-xs"
                options={bandOptions}
              />
            </label>
          )}
          <div className="relative w-[15rem]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, ID or department"
              className="h-8 pl-8 text-xs"
            />
          </div>
          {(deptFilter || bandFilter || query) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-[11px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              onClick={() => { setDeptFilter(''); setBandFilter(''); setQuery(''); }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      <div className="min-w-0 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900/60 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-2.5 text-left font-semibold">Employee</th>
              <th className="px-3 py-2.5 text-left font-semibold">Department</th>
              <th className="px-3 py-2.5 text-left font-semibold">Status</th>
              {/* Failed days sits immediately left of the buttons: the count and the
                  dates are what the Forgive decision is made on, so they belong beside
                  it rather than a column away. Merging the old "Days missed" number
                  into this cell also drops a column, which is what keeps Actions on
                  screen without horizontal scrolling. */}
              <th className="px-3 py-2.5 text-left font-semibold">Failed days</th>
              <th className="px-3 py-2.5 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {paged.map((row) => {
              const band = pabSeverityBand(row.severity);
              const style = BAND_STYLES[band];
              const busy = forgivingEmail === row.email;
              return (
                <tr key={row.email} className="hover:bg-zinc-50/70 dark:hover:bg-zinc-900/40">
                  <td className="px-4 py-2.5">
                    {/* The id sits where the email used to — an internal
                        identifier is safe to show, a personal address is not. */}
                    {row.name ? (
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">{row.name}</div>
                    ) : (
                      // The address goes in `title` only — identifiable on hover,
                      // never rendered into the table.
                      <div
                        title={row.email}
                        className="font-medium italic text-amber-700 dark:text-amber-400"
                      >
                        Unknown — not on the master list
                      </div>
                    )}
                    <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                      {row.employeeId ?? '—'}
                    </div>
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
                    <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', style.chip)}>
                      {style.label}
                    </span>
                    {row.excluded && (
                      <span className="ml-1.5 rounded-full border border-zinc-300 bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                        Excluded
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span
                        title={`${row.severity} day${row.severity === 1 ? '' : 's'} under 7 hours`}
                        className="shrink-0 font-mono text-base font-bold leading-none text-rose-700 dark:text-rose-300"
                      >
                        {row.severity}
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {row.failedDays.slice(0, 3).map((d) => (
                          <span
                            key={d.iso}
                            title={`${formatShortfall(d.shortfallSec)} short of 7h`}
                            className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-px font-mono text-[10px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
                          >
                            {formatDay(d.iso)}
                          </span>
                        ))}
                        {row.failedDays.length > 3 && (
                          <span
                            // Every date stays reachable on hover — the cap is a
                            // layout limit, never a claim that the rest do not exist.
                            title={row.failedDays.map((d) => formatDay(d.iso)).join(', ')}
                            className="px-1 text-[10px] text-zinc-400"
                          >
                            +{row.failedDays.length - 3} more
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1 px-2 text-[11px]"
                        onClick={() => onOpenCalendar(row.email)}
                      >
                        <CalendarDays className="h-3 w-3" /> PAB Calendar
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 gap-1 bg-emerald-600 px-2 text-[11px] text-white hover:bg-emerald-700 disabled:opacity-40"
                        disabled={readOnly || busy || row.excluded}
                        title={
                          readOnly
                            ? 'Replaying a past week — forgiveness is disabled'
                            : row.excluded
                              ? 'This person is excluded from PAB for the month; lift the exclusion first'
                              : `Forgive all ${row.severity} day${row.severity === 1 ? '' : 's'} for ${monthLabel}`
                        }
                        onClick={() => onForgiveMonth(row)}
                      >
                        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        Forgive month
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
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
