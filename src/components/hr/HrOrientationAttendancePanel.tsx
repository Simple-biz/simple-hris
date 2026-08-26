'use client';

import { useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  CalendarCheck,
  ChevronDown,
  Clock,
  Loader2,
  RefreshCw,
  RotateCcw,
  TrendingDown,
  TrendingUp,
  UserMinus,
  UserRoundCheck,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { formatWeekLabel } from '@/lib/hr/hiring-week';
import { useHrOrientationAttendance } from '@/hooks/useHrOrientationAttendance';
import {
  buildHrOrientationWeekStats,
  previousMeasuredWeek,
  type HrChecklistListedRow,
  type HrOrientationWeekStats,
} from '@/lib/hr/orientation-week-stats';
import { attendanceRate, type OrientationHire } from '@/lib/manager/orientation-weekly';

/**
 * HR → New Hire Checklist → **Orientation**.
 *
 * How many hires HR listed for the selected week, how many of them the managers
 * were actually given (staged into `hr_pending_employees`), and how many turned
 * up. Scoped to the week the tab's existing selector is on — there is
 * deliberately no second week control on this panel.
 *
 * The rules it renders live in the model, not here
 * (src/lib/hr/orientation-week-stats.ts, docs/features/hr-orientation-attendance.md):
 *
 *  - **The rate runs over STAGED hires**, and is `attendanceRate` itself, so this
 *    panel and the manager tally publish the same percentage for the same week.
 *  - **"Listed" is not the denominator.** ~9 hires a week are on HR's checklist
 *    with no staged row, so no manager can mark them; they get their own card.
 *  - **Nothing marked ⇒ no number.** A week with no staged hires renders a note,
 *    never 0% (Kane, 2026-08-26).
 *
 * No pay figures: the route strips rates and nothing here would render them.
 */
interface HrOrientationAttendancePanelProps {
  /** The week the New Hire Checklist selector is on — Sun-anchored `YYYY-MM-DD`. */
  period: string;
  /** That week's checklist rows, straight from the grid's own state. */
  listedRows: HrChecklistListedRow[];
  /** True while the grid is still loading the week (so "Listed" isn't yet final). */
  listedLoading?: boolean;
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

/** Green ≥95%, amber ≥85%, rose below. Same bands as the manager tally. */
function rateTone(pct: number | null): string {
  if (pct == null) return 'text-zinc-400 dark:text-zinc-600';
  if (pct >= 95) return 'text-emerald-700 dark:text-emerald-300';
  if (pct >= 85) return 'text-amber-700 dark:text-amber-300';
  return 'text-rose-700 dark:text-rose-300';
}

const CARD_TONES = {
  emerald:
    'border-emerald-200 bg-gradient-to-br from-emerald-50 to-white dark:border-emerald-700/40 dark:from-emerald-950/40 dark:to-zinc-950',
  teal: 'border-teal-200 bg-gradient-to-br from-teal-50 to-white dark:border-teal-700/40 dark:from-teal-950/40 dark:to-zinc-950',
  rose: 'border-rose-200 bg-gradient-to-br from-rose-50 to-white dark:border-rose-800/40 dark:from-rose-950/30 dark:to-zinc-950',
  amber:
    'border-amber-200 bg-gradient-to-br from-amber-50 to-white dark:border-amber-700/40 dark:from-amber-950/30 dark:to-zinc-950',
  zinc: 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40',
} as const;

function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'zinc',
  valueClass,
  delta,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ReactNode;
  tone?: keyof typeof CARD_TONES;
  valueClass?: string;
  delta?: { pts: number } | null;
}) {
  return (
    <div className={cn('min-w-0 flex-1 rounded-xl border p-3 shadow-sm', CARD_TONES[tone])}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className={cn('font-mono text-2xl font-bold tabular-nums text-zinc-900 dark:text-white', valueClass)}>
          {value}
        </span>
        {delta && delta.pts !== 0 && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded px-1 py-px text-[10px] font-semibold tabular-nums',
              delta.pts > 0
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                : 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300',
            )}
            title="Change from the previous week that had attendance data"
          >
            {delta.pts > 0 ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
            {delta.pts > 0 ? '+' : ''}
            {delta.pts}
          </span>
        )}
      </div>
      {hint && <div className="mt-0.5 truncate text-[10px] text-zinc-500 dark:text-zinc-400">{hint}</div>}
    </div>
  );
}

/** One person's attendance line. */
function HireLine({ h }: { h: OrientationHire }) {
  const attended = Boolean(h.orientation_attended_at);
  const isNoShow = !attended && h.status === 'no_show';
  const when = attended ? h.orientation_attended_at : isNoShow ? h.no_show_at : null;
  const by = attended ? h.orientation_attended_by : isNoShow ? h.no_show_by : null;
  const note = attended ? h.orientation_note : isNoShow ? h.no_show_note : null;

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-t border-zinc-100 px-3 py-1.5 text-xs dark:border-zinc-900">
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
        {attended ? 'Attended' : isNoShow ? 'Did not attend' : 'Not marked'}
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

/** A collapsible section with an animated body. */
function Section({
  title,
  count,
  tone,
  children,
  defaultOpen = false,
  reduceMotion,
}: {
  title: string;
  count: number;
  tone: keyof typeof CARD_TONES;
  children: React.ReactNode;
  defaultOpen?: boolean;
  reduceMotion: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn('overflow-hidden rounded-xl border shadow-sm', CARD_TONES[tone])}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
      >
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform duration-200',
            !open && '-rotate-90',
          )}
        />
        <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">{title}</span>
        <span className="rounded bg-white/70 px-1.5 py-px text-[10px] font-semibold tabular-nums text-zinc-600 dark:bg-zinc-900/70 dark:text-zinc-300">
          {count}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduceMotion ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0.12 : 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-zinc-200/70 bg-white/60 dark:border-zinc-800 dark:bg-zinc-950/40">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function HrOrientationAttendancePanel({
  period,
  listedRows,
  listedLoading = false,
}: HrOrientationAttendancePanelProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const { summary, stagedWeekByEmail, loading, error, refreshing, refresh } =
    useHrOrientationAttendance();
  const [showAll, setShowAll] = useState(false);

  const week = useMemo(
    () => summary.weeks.find((w) => w.weekStart === period) ?? null,
    [summary, period],
  );

  const stats: HrOrientationWeekStats = useMemo(
    () => buildHrOrientationWeekStats({ weekStart: period, listedRows, week, stagedWeekByEmail }),
    [period, listedRows, week, stagedWeekByEmail],
  );

  /** Points of change against the nearest earlier week that HAD data. */
  const delta = useMemo(() => {
    if (stats.rate == null) return null;
    const prev = previousMeasuredWeek(summary, period);
    if (!prev) return null;
    const prevRate = attendanceRate(prev);
    if (prevRate == null) return null;
    return { pts: stats.rate - prevRate, label: formatWeekLabel(prev.weekStart) };
  }, [stats.rate, summary, period]);

  const missed = useMemo(() => stats.hires.filter((h) => !h.orientation_attended_at), [stats.hires]);
  const shownHires = showAll ? stats.hires : missed;

  const fade = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const },
      };

  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading orientation attendance…
        </div>
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-[74px] min-w-[8rem] flex-1 animate-pulse rounded-xl border border-zinc-200 bg-zinc-100/70 dark:border-zinc-800 dark:bg-zinc-900/50"
            />
          ))}
        </div>
        <div className="h-24 animate-pulse rounded-xl border border-zinc-200 bg-zinc-100/70 dark:border-zinc-800 dark:bg-zinc-900/50" />
      </div>
    );
  }

  // No silent degradation: the week key is HR's `period_start`, and the only
  // fallback available is the hire's own dates — wrong for 46% of the roster.
  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-10 text-center dark:border-rose-900/50 dark:bg-rose-950/20">
        <AlertTriangle className="h-6 w-6 text-rose-600 dark:text-rose-400" />
        <p className="text-sm font-medium text-rose-700 dark:text-rose-300">
          Orientation attendance couldn&apos;t load
        </p>
        <p className="max-w-md text-xs text-zinc-600 dark:text-zinc-400">{error}</p>
        <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => void refresh()}>
          <RotateCcw className="h-3 w-3" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 overflow-y-auto pb-2">
      {/* What this week is, and where the numbers come from. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-white">
          <CalendarCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          {formatWeekLabel(period)}
        </div>
        <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          Hires you listed for this week against the ones the managers marked as having attended
          orientation. Attendance is marked on <strong>Manager → My Team → New Hire Check List</strong>;
          this tab only reads it.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="h-8 shrink-0 gap-1.5 border-emerald-200 text-xs text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300"
          title="Reload orientation attendance"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>

      {/* Everything below is re-keyed on the week, so switching weeks crossfades
          instead of snapping — and costs no fetch (the payload is cached). */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={period}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
          transition={{ duration: reduceMotion ? 0.12 : 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col gap-2.5"
        >
          {/* KPI row */}
          <motion.div className="flex flex-wrap gap-2" {...fade}>
            <StatCard
              label="Hires listed"
              value={listedLoading ? '…' : String(stats.listed)}
              hint="on your checklist for this week"
              icon={<Users className="h-3 w-3" />}
              tone="emerald"
            />
            <StatCard
              label="With managers"
              value={String(stats.staged)}
              hint={
                stats.notStaged.length > 0
                  ? `${stats.notStaged.length} never handed over`
                  : 'every listed hire handed over'
              }
              icon={<UserRoundCheck className="h-3 w-3" />}
              tone="teal"
            />
            <StatCard
              label="Attended"
              value={String(stats.attended)}
              icon={<CalendarCheck className="h-3 w-3" />}
              tone="emerald"
              valueClass="text-emerald-700 dark:text-emerald-300"
            />
            <StatCard
              label="Did not attend"
              value={String(stats.notAttended)}
              hint={`${stats.noShow} no-show · ${stats.awaiting} not marked`}
              icon={<UserMinus className="h-3 w-3" />}
              tone={stats.notAttended > 0 ? 'rose' : 'zinc'}
              valueClass={stats.notAttended > 0 ? 'text-rose-700 dark:text-rose-300' : undefined}
            />
            <StatCard
              label="Attendance rate"
              value={stats.rate == null ? '—' : `${stats.rate}%`}
              hint={delta ? `vs ${delta.label}` : stats.measurable ? 'of hires with managers' : 'nothing marked yet'}
              tone={stats.measurable ? 'zinc' : 'amber'}
              valueClass={rateTone(stats.rate)}
              delta={delta}
            />
          </motion.div>

          {/* Kane's ruling: nothing marked ⇒ a note, never a percentage. */}
          {!stats.measurable && (
            <motion.div
              className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-[11px] leading-relaxed text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/25 dark:text-amber-200"
              {...fade}
            >
              <Clock className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>
                {stats.listed === 0 ? (
                  <>No hires are listed for this week yet, so there is nothing to measure.</>
                ) : (
                  <>
                    <strong>Not measurable yet.</strong> {stats.listed}{' '}
                    {stats.listed === 1 ? 'hire is' : 'hires are'} listed for this week, but none of
                    them have reached a manager to be marked attended or not — so there is no
                    attendance rate to show. This is normal for a week that has just been listed,
                    and permanent for weeks that predate manager marking.
                  </>
                )}
              </span>
            </motion.div>
          )}

          {/* Staged, but nobody marked them. They count as did-not-attend. */}
          {stats.awaiting > 0 && (
            <motion.div
              className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-[11px] leading-relaxed text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/25 dark:text-amber-200"
              {...fade}
            >
              <Clock className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>
                <strong>
                  {stats.awaiting} {stats.awaiting === 1 ? 'hire has' : 'hires have'} not been marked
                </strong>{' '}
                by their manager either way. They are counted under{' '}
                <strong>Did not attend</strong> — &ldquo;did not attend&rdquo; means &ldquo;was not
                marked attended&rdquo; — so this week&apos;s rate can only go up once the managers
                mark them.
              </span>
            </motion.div>
          )}

          {/* The intake gap: listed by HR, never staged, so unmarkable. */}
          {stats.notStaged.length > 0 && (
            <motion.div {...fade}>
              <Section
                title="Listed but never handed to a manager"
                count={stats.notStaged.length}
                tone="amber"
                reduceMotion={reduceMotion}
              >
                <p className="px-3 pt-2 text-[10px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                  These hires are on this week&apos;s checklist but have no onboarding record, so no
                  manager can mark them attended and they are <strong>not</strong> part of the
                  attendance rate. Usually they never completed onboarding.
                </p>
                {stats.notStaged.map((r) => (
                  <div
                    key={r.id}
                    className="flex flex-wrap items-baseline gap-x-2 border-t border-zinc-100 px-3 py-1.5 text-xs dark:border-zinc-900"
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden />
                    <span className="font-medium text-zinc-800 dark:text-zinc-100">{r.name || '—'}</span>
                    <span className="text-[10px] text-zinc-500 dark:text-zinc-400" title={r.department ?? undefined}>
                      {formatDeptLabel(r.department)}
                    </span>
                    <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
                      {r.personal_email?.trim() || 'no email on the row'}
                    </span>
                  </div>
                ))}
              </Section>
            </motion.div>
          )}

          {/* Per-department breakdown for the week. */}
          {stats.byDepartment.length > 0 && (
            <motion.div {...fade}>
              <Section
                title="By department"
                count={stats.byDepartment.length}
                tone="zinc"
                defaultOpen
                reduceMotion={reduceMotion}
              >
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[30rem] text-xs">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        <th className="px-3 py-1.5 text-left font-semibold">Department</th>
                        <th className="px-3 py-1.5 text-right font-semibold">Listed</th>
                        <th className="px-3 py-1.5 text-right font-semibold">With mgr</th>
                        <th className="px-3 py-1.5 text-right font-semibold">Attended</th>
                        <th className="px-3 py-1.5 text-right font-semibold">Did not</th>
                        <th className="px-3 py-1.5 text-right font-semibold">Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.byDepartment.map((d) => {
                        const pct = attendanceRate({ total: d.staged, attended: d.attended });
                        return (
                          <tr
                            key={d.department ?? '(none)'}
                            className="border-t border-zinc-100 dark:border-zinc-900"
                          >
                            <td className="px-3 py-1.5 text-zinc-800 dark:text-zinc-100" title={d.department ?? undefined}>
                              {d.department ? formatDeptLabel(d.department) : 'No department'}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{d.listed}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{d.staged}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700 dark:text-emerald-300">{d.attended}</td>
                            <td
                              className={cn(
                                'px-3 py-1.5 text-right tabular-nums',
                                d.notAttended > 0
                                  ? 'font-semibold text-rose-700 dark:text-rose-300'
                                  : 'text-zinc-400 dark:text-zinc-600',
                              )}
                            >
                              {d.notAttended}
                            </td>
                            <td className={cn('px-3 py-1.5 text-right font-semibold tabular-nums', rateTone(pct))}>
                              {pct == null ? '—' : `${pct}%`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Section>
            </motion.div>
          )}

          {/* The people behind the numbers. */}
          {stats.staged > 0 && (
            <motion.div className="flex flex-col gap-1.5" {...fade}>
              <label className="flex w-fit cursor-pointer items-center gap-1.5 text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 cursor-pointer accent-emerald-600"
                  checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                />
                Show everyone, not just the ones who missed
              </label>
              <Section
                title={showAll ? 'All hires with a manager' : 'Did not attend'}
                count={shownHires.length}
                tone={!showAll && missed.length > 0 ? 'rose' : 'zinc'}
                defaultOpen
                reduceMotion={reduceMotion}
              >
                {shownHires.length === 0 ? (
                  <p className="px-3 py-2.5 text-xs text-emerald-700 dark:text-emerald-300">
                    Everyone the managers were given this week attended orientation.
                  </p>
                ) : (
                  shownHires.map((h) => <HireLine key={h.id} h={h} />)
                )}
              </Section>
            </motion.div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
