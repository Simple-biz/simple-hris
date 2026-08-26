'use client';

import { useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  CalendarCheck,
  ChevronRight,
  FileText,
  Loader2,
  RefreshCw,
  RotateCcw,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { useOrientationHistory } from '@/hooks/useOrientationHistory';
import { downloadOrientationPdf } from '@/lib/manager/orientation-pdf';
import {
  attendanceRate,
  OFF_CHECKLIST_LABEL,
  UNDATED_WEEK,
  type OrientationHire,
  type OrientationWeek,
} from '@/lib/manager/orientation-weekly';

/**
 * Manager → My Team → **Orientation**.
 *
 * How many of the people HR sent us each week actually turned up, and who
 * didn't. One row per HR New Hire Checklist week; expand a week to see the
 * people behind the "did not attend" count.
 *
 * The two rules this renders are enforced in the model, not here — see
 * docs/features/manager-orientation-attendance.md:
 *
 *  - "Did not attend" = no `orientation_attended_at` stamp. `status` only splits
 *    that into no-show (already offboarded) vs awaiting (nobody marked them).
 *  - The week is HR's `period_start`, joined on personal email — never derived
 *    from the hire's own dates, which was wrong for 46% of the roster.
 *
 * **No pay figures anywhere.** Managers see attendance and profile data only
 * (docs/features/manager-my-team.md); the route strips rates before they leave
 * the server and nothing here would render them.
 *
 * The motion here is decoration and nothing else: every animated wrapper renders
 * its children unconditionally (an `AnimatePresence` only guards a section that
 * is already conditional on `open`), and `useReducedMotion` collapses all of it
 * to a plain opacity step. No number, gate, or error branch depends on it.
 */

interface OrientationAttendancePanelProps {
  teamGate:
    | { kind: 'loading' }
    | { kind: 'elevated' }
    | { kind: 'department'; departments: string[] }
    | { kind: 'error'; message: string };
}

/** A hire's orientation / no-show date in Manila (the company tz). */
function fmtManilaDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function weekTitle(w: OrientationWeek): string {
  return w.weekStart === UNDATED_WEEK ? 'No date on record' : w.label;
}

/** Green ≥95%, amber ≥85%, rose below. */
function rateTone(pct: number | null): string {
  if (pct == null) return 'text-zinc-400 dark:text-zinc-600';
  if (pct >= 95) return 'text-emerald-700 dark:text-emerald-300';
  if (pct >= 85) return 'text-amber-700 dark:text-amber-300';
  return 'text-rose-700 dark:text-rose-300';
}

function KpiTile({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-zinc-200/80 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={cn('mt-0.5 text-xl font-bold tabular-nums', tone)}>{value}</div>
      {hint && <div className="text-[10px] text-zinc-500 dark:text-zinc-400">{hint}</div>}
    </div>
  );
}

/** One person in an expanded week. */
function HireLine({ h }: { h: OrientationHire }) {
  const attended = Boolean(h.orientation_attended_at);
  const isNoShow = !attended && h.status === 'no_show';
  const when = attended ? h.orientation_attended_at : isNoShow ? h.no_show_at : null;
  const by = attended ? h.orientation_attended_by : isNoShow ? h.no_show_by : null;
  const note = attended ? h.orientation_note : isNoShow ? h.no_show_note : null;

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-t border-zinc-100 px-4 py-1.5 text-xs dark:border-zinc-900">
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          attended ? 'bg-emerald-500' : isNoShow ? 'bg-rose-500' : 'bg-amber-500',
        )}
        aria-hidden
      />
      <span className="font-medium text-zinc-800 dark:text-zinc-100">{h.name ?? '—'}</span>
      <span className="text-[10px] text-zinc-500 dark:text-zinc-400" title={h.department ?? undefined}>
        {formatDeptLabel(h.department)}
      </span>
      <span
        className={cn(
          'rounded px-1.5 py-0.5 text-[10px] font-semibold',
          attended
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
            : isNoShow
              ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
              : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
        )}
      >
        {attended ? 'Attended' : isNoShow ? 'Did not attend' : 'Awaiting'}
      </span>
      <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
        {fmtManilaDate(when)}
        {by ? ` · ${by}` : ''}
      </span>
      {note && (
        <span className="w-full truncate pl-3.5 text-[10px] italic text-zinc-500 dark:text-zinc-400">
          &ldquo;{note}&rdquo;
        </span>
      )}
    </div>
  );
}

export default function OrientationAttendancePanel({ teamGate }: OrientationAttendancePanelProps) {
  const { summary, loading, refreshing, error, refresh } = useOrientationHistory();
  const reduceMotion = useReducedMotion() ?? false;
  const [pdfBusy, setPdfBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Show every hire in an expanded week, or only the ones who missed. */
  const [showAll, setShowAll] = useState(false);

  const allWeeks = useMemo(
    () => [...summary.weeks, ...summary.offChecklist],
    [summary],
  );

  const scopeLabel =
    teamGate.kind === 'elevated'
      ? 'All departments'
      : teamGate.kind === 'department' && teamGate.departments.length > 0
        ? teamGate.departments.map((d) => formatDeptLabel(d)).join(', ')
        : 'Your departments';

  function toggleWeek(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function exportPdf() {
    setPdfBusy(true);
    try {
      await downloadOrientationPdf({ summary, generatedAt: new Date(), scopeLabel });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to build the PDF');
    } finally {
      setPdfBusy(false);
    }
  }

  // A shared entrance: a small fade-and-rise, collapsed to a plain fade when the
  // viewer asks for reduced motion.
  const rise = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.12 } }
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const },
      };

  if (loading) {
    return (
      <Card className="border-blue-100/70 bg-gradient-to-br from-white to-blue-50/40 ring-1 ring-blue-500/10 dark:border-blue-950/50 dark:from-zinc-950 dark:to-blue-950/15">
        <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500 dark:text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading orientation attendance…
        </CardContent>
      </Card>
    );
  }

  // No silent degradation: the week key comes from HR's checklist, and falling
  // back to the hire's own dates is the 46%-wrong grouping this replaced.
  if (error) {
    return (
      <Card className="border-rose-200/80 bg-gradient-to-br from-white to-rose-50/40 ring-1 ring-rose-500/10 dark:border-rose-900/50 dark:from-zinc-950">
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <AlertTriangle className="h-6 w-6 text-rose-600 dark:text-rose-400" />
          <p className="text-sm font-medium text-rose-700 dark:text-rose-300">
            Orientation attendance couldn&apos;t load
          </p>
          <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">{error}</p>
          <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => void refresh()}>
            <RotateCcw className="h-3 w-3" /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (allWeeks.length === 0) {
    return (
      <Card className="border-blue-100/70 bg-gradient-to-br from-white to-blue-50/40 ring-1 ring-blue-500/10 dark:border-blue-950/50 dark:from-zinc-950 dark:to-blue-950/15">
        <CardContent className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-white shadow-md shadow-blue-500/25">
            <CalendarCheck className="h-6 w-6" />
          </div>
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">No orientation history yet</p>
          <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">
            Once HR stages hires for a department you manage, each hiring week&apos;s attendance shows
            up here.
          </p>
        </CardContent>
      </Card>
    );
  }

  const t = summary.totals;
  const overallRate = attendanceRate(t);

  return (
    <motion.div className="flex flex-col gap-3" {...rise}>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        How many hires turned up for orientation each week, and who didn&apos;t. Weeks are{' '}
        <strong>HR&apos;s New Hire Checklist weeks</strong>. <strong>Did not attend</strong> means
        nobody marked the hire as having attended — split into{' '}
        <strong className="text-rose-600 dark:text-rose-400">no-show</strong> (already offboarded)
        and <strong className="text-amber-600 dark:text-amber-400">awaiting</strong> (still
        unmarked). Mark attendance over on the{' '}
        <strong>New Hire Check List</strong> tab.
      </p>

      {/* Headline numbers for the whole scope. */}
      <motion.div
        className="flex flex-wrap gap-2"
        initial="hidden"
        animate="shown"
        variants={{
          hidden: {},
          shown: { transition: { staggerChildren: reduceMotion ? 0 : 0.05 } },
        }}
      >
        {[
          <KpiTile key="hires" label="Hires" value={String(t.total)} tone="text-zinc-800 dark:text-zinc-100" hint={`${allWeeks.length} week${allWeeks.length === 1 ? '' : 's'}`} />,
          <KpiTile key="attended" label="Attended" value={String(t.attended)} tone="text-emerald-700 dark:text-emerald-300" />,
          <KpiTile
            key="missed"
            label="Did not attend"
            value={String(t.notAttended)}
            tone={t.notAttended > 0 ? 'text-rose-700 dark:text-rose-300' : 'text-zinc-400 dark:text-zinc-600'}
            hint={`${t.noShow} no-show · ${t.stillOpen} awaiting`}
          />,
          <KpiTile key="rate" label="Attendance rate" value={overallRate == null ? '—' : `${overallRate}%`} tone={rateTone(overallRate)} />,
        ].map((tile, i) => (
          <motion.div
            key={i}
            className="flex min-w-[7.5rem] flex-1"
            variants={{
              hidden: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 },
              shown: reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 },
            }}
            transition={{ duration: reduceMotion ? 0.12 : 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            {tile}
          </motion.div>
        ))}
      </motion.div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 cursor-pointer accent-blue-600"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
          />
          Show everyone in an opened week
        </label>
        <div className="ml-auto flex items-center gap-1.5">
          {/* Refreshing no longer swaps the panel for a spinner card — the
              numbers stay put and the icon spins in place. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 text-xs"
            onClick={() => void refresh()}
            disabled={refreshing}
            title="Reload orientation attendance"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} /> Refresh
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 text-xs"
            onClick={() => void exportPdf()}
            disabled={pdfBusy || t.total === 0}
            title="Download the weekly orientation attendance report as a PDF"
          >
            {pdfBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />} Export PDF
          </Button>
        </div>
      </div>

      {/* One card per week. Click a week to see the people behind its counts. */}
      <div className="flex flex-col gap-1.5">
        {allWeeks.map((w, i) => {
          const key = `${w.onChecklist ? 'hr' : 'off'}:${w.weekStart}`;
          const open = expanded.has(key);
          const pct = attendanceRate(w);
          const missed = w.hires.filter((h) => !h.orientation_attended_at);
          const shown = showAll ? w.hires : missed;

          return (
            <motion.div
              key={key}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
              transition={{
                duration: reduceMotion ? 0.12 : 0.26,
                // Cheap stagger without a variant tree: the first handful of
                // weeks cascade, the rest land together rather than trickling in.
                delay: reduceMotion ? 0 : Math.min(i, 6) * 0.035,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
            <Card
              className={cn(
                'overflow-hidden border ring-1 transition-colors',
                w.notAttended > 0
                  ? 'border-rose-200/70 ring-rose-500/5 dark:border-rose-900/40'
                  : 'border-zinc-200/80 ring-transparent dark:border-zinc-800',
              )}
            >
              <CardContent className="p-0">
                <button
                  type="button"
                  onClick={() => toggleWeek(key)}
                  aria-expanded={open}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                >
                  <ChevronRight
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform duration-200 ease-out',
                      open && 'rotate-90',
                    )}
                  />
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white">{weekTitle(w)}</span>
                  {!w.onChecklist && (
                    <span
                      className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300"
                      title="These hires match no row in HR's New Hire Checklist, so they're grouped under the week HR staged them instead."
                    >
                      {OFF_CHECKLIST_LABEL}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                    <Users className="h-3 w-3" /> {w.total}
                  </span>

                  <span className="ml-auto flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                      {w.attended} attended
                    </span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5',
                        w.notAttended > 0
                          ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
                          : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400',
                      )}
                    >
                      {w.notAttended} did not
                    </span>
                    <span className={cn('w-10 text-right tabular-nums font-semibold', rateTone(pct))}>
                      {pct == null ? '—' : `${pct}%`}
                    </span>
                  </span>
                </button>

                <AnimatePresence initial={false}>
                  {open && (
                  <motion.div
                    key="week-body"
                    initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    animate={reduceMotion ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
                    exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    transition={{ duration: reduceMotion ? 0.12 : 0.26, ease: [0.22, 1, 0.36, 1] }}
                    className="overflow-hidden border-t border-zinc-100 bg-zinc-50/40 dark:border-zinc-900 dark:bg-zinc-950/40"
                  >
                    {shown.length === 0 ? (
                      <p className="px-4 py-3 text-xs text-emerald-700 dark:text-emerald-300">
                        Everyone in this week attended orientation.
                      </p>
                    ) : (
                      <>
                        <p className="px-4 pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                          {showAll ? `All hires (${shown.length})` : `Did not attend (${shown.length})`}
                        </p>
                        {shown.map((h) => <HireLine key={h.id} h={h} />)}
                      </>
                    )}
                  </motion.div>
                  )}
                </AnimatePresence>
              </CardContent>
            </Card>
            </motion.div>
          );
        })}
      </div>

      {t.unmatched > 0 && (
        <p className="text-[10px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          {t.unmatched} hire{t.unmatched === 1 ? '' : 's'} match no row in HR&apos;s New Hire
          Checklist — their personal email isn&apos;t on one. They appear under the week HR staged
          them, flagged <strong>{OFF_CHECKLIST_LABEL}</strong>, and are counted in the totals rather
          than folded into an HR week.
        </p>
      )}
    </motion.div>
  );
}
