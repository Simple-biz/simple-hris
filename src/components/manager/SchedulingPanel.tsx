'use client';

/**
 * Manager → Scheduling.
 *
 * Lives inside **My Team → (HSL selected) → Scheduling**, a toggle beside the
 * department search bar (Kane, 2026-09-14: "Scheduling will be inside HSL Department
 * only so when we click HSL Department we should have a tab inside it"). It was
 * top-level and UI-only from 2026-08-26 until then.
 *
 * A banner appears only when saving genuinely cannot work — the table is created by
 * a script an administrator runs, so the code can be live before the table is.
 *
 * The panel is written against `SchedulePeriod`, which mirrors the
 * `employee_schedule_periods` table field for field. It reads and writes
 * `/api/manager/scheduling` as of 2026-09-14; before that it rendered a fixture and
 * discarded every edit.
 *
 * Two rules this screen must keep:
 *
 *  1. **No pay, ever.** `manager-my-team.md:13` — managers see attendance,
 *     recognition and shared profile data, never compensation. A schedule is an
 *     expectation, and nothing on this screen may become a rate, a premium or a
 *     peso figure. See the "money wall" note rendered at the bottom.
 *  2. **"Not set" is a state, not a zero.** A person with days but no hours renders
 *     as "Hours not set" and is counted in its own KPI. Defaulting a missing window
 *     to midnight would be the same bug as collapsing "no timesheet record" into
 *     "day off" — the failure this whole workstream exists to end.
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  CalendarClock,
  CalendarRange,
  Check,
  Clock,
  Info,
  Pencil,
  Users,
  X,
} from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { cn } from '@/lib/utils';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import {
  formatShiftWindow,
  parseShiftWindow,
  shiftDurationMinutes,
  type ShiftWindow,
} from '@/lib/manager/shift-window';
import {
  findOverlaps,
  formatRestDays,
  isWeekend,
  scheduledDaysPerWeek,
  summarizeScheduling,
  weekdayWeekendLoad,
  WEEKDAYS,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  type SchedulePeriod,
  type TeamDefault,
  type Weekday,
} from '@/lib/manager/scheduling';

/* ── small pieces ─────────────────────────────────────────────────────────── */

function KpiCard({
  label,
  value,
  hint,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  hint: string;
  tone: 'blue' | 'amber' | 'zinc' | 'violet';
  icon: React.ComponentType<{ className?: string }>;
}) {
  const tones = {
    blue: 'border-blue-200/70 bg-blue-50/60 text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-100',
    amber:
      'border-amber-200/80 bg-amber-50/70 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-100',
    violet:
      'border-violet-200/70 bg-violet-50/60 text-violet-900 dark:border-violet-900/50 dark:bg-violet-950/30 dark:text-violet-100',
    zinc: 'border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-100',
  } as const;

  return (
    <div className={cn('rounded-lg border px-4 py-3', tones[tone])}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide opacity-70">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums">{value}</p>
      <p className="mt-0.5 text-[11px] leading-tight opacity-70">{hint}</p>
    </div>
  );
}

/** Seven toggles. Selected = a REST day, so the label reads "days off". */
function RestDayPicker({
  restDays,
  onChange,
  disabled = false,
}: {
  restDays: Weekday[];
  onChange: (next: Weekday[]) => void;
  disabled?: boolean;
}) {
  const toggle = (d: Weekday) =>
    onChange(restDays.includes(d) ? restDays.filter((x) => x !== d) : [...restDays, d].sort((a, b) => a - b));

  return (
    <div className="flex flex-wrap gap-1">
      {WEEKDAYS.map((d) => {
        const off = restDays.includes(d);
        return (
          <button
            key={d}
            type="button"
            disabled={disabled}
            onClick={() => toggle(d)}
            aria-pressed={off}
            aria-label={`${WEEKDAY_LONG[d]} — ${off ? 'rest day' : 'working day'}`}
            title={`${WEEKDAY_LONG[d]}: ${off ? 'rest day' : 'working day'}`}
            className={cn(
              'h-8 w-10 rounded-md border text-[11.5px] font-semibold transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
              disabled && 'cursor-not-allowed opacity-50',
              off
                ? 'border-zinc-300 bg-zinc-100 text-zinc-400 line-through dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-600'
                : 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-200',
            )}
          >
            {WEEKDAY_SHORT[d]}
          </button>
        );
      })}
    </div>
  );
}

/** Compact read-only week strip for the table. */
function WeekStrip({ restDays }: { restDays: Weekday[] }) {
  return (
    <div className="flex gap-0.5" aria-label={`Rest days: ${formatRestDays(restDays)}`}>
      {WEEKDAYS.map((d) => {
        const off = restDays.includes(d);
        return (
          <span
            key={d}
            title={`${WEEKDAY_LONG[d]}: ${off ? 'rest day' : 'working day'}`}
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded text-[9.5px] font-semibold',
              off
                ? 'bg-zinc-100 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-600'
                : 'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-200',
            )}
          >
            {WEEKDAY_SHORT[d].charAt(0)}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Scheduled headcount per weekday — the one number on this screen a timesheet can
 * never produce, because it is about next week rather than last week. Weekend
 * columns are tinted because thin weekend cover is the question managers actually
 * bring to this surface.
 */
function WeekCoverChart({ byWeekday }: { byWeekday: Record<Weekday, number> }) {
  const reduce = useReducedMotion();
  const max = Math.max(1, ...WEEKDAYS.map((d) => byWeekday[d]));

  // Bars are capped, not stretched. Seven columns spread across a 1200px dashboard
  // stop reading as bars and start reading as blocks, and the extra width carries no
  // extra information — the read-out beside this does.
  return (
    <div className="flex h-36 max-w-[380px] items-end gap-1.5">
      {WEEKDAYS.map((d) => {
        const v = byWeekday[d];
        const pct = (v / max) * 100;
        const weekend = isWeekend(d);
        return (
          <div key={d} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <span
              className={cn(
                'font-mono text-[11px] font-semibold tabular-nums',
                v === 0
                  ? 'text-rose-600 dark:text-rose-400'
                  : 'text-zinc-700 dark:text-zinc-300',
              )}
            >
              {v}
            </span>
            <div className="flex h-full w-full items-end">
              <motion.div
                initial={reduce ? false : { height: 0 }}
                animate={{ height: `${Math.max(pct, v === 0 ? 0 : 2)}%` }}
                transition={{ duration: reduce ? 0 : 0.45, ease: [0.22, 1, 0.36, 1] }}
                className={cn(
                  'w-full rounded-t-md',
                  v === 0
                    ? 'bg-rose-200 dark:bg-rose-900/50'
                    : weekend
                      ? 'bg-violet-400 dark:bg-violet-500/70'
                      : 'bg-blue-500 dark:bg-blue-500/80',
                )}
              />
            </div>
            <span
              className={cn(
                'text-[11px] font-medium',
                weekend ? 'text-violet-700 dark:text-violet-300' : 'text-zinc-500 dark:text-zinc-400',
              )}
            >
              {WEEKDAY_SHORT[d]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── edit dialog ──────────────────────────────────────────────────────────── */

interface DraftState {
  restDays: Weekday[];
  startText: string;
  endText: string;
  effectiveFrom: string;
  effectiveTo: string;
}

function windowToTexts(w: ShiftWindow | null): { start: string; end: string } {
  if (!w) return { start: '', end: '' };
  const fmt = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { start: fmt(w.startMinute), end: fmt(w.endMinute) };
}

function EditPeriodDialog({
  period,
  open,
  onOpenChange,
  onSave,
}: {
  period: SchedulePeriod | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSave: (id: string, patch: Partial<SchedulePeriod>) => void;
}) {
  const [draft, setDraft] = useState<DraftState | null>(null);

  // Re-seed the draft whenever a different period is opened.
  const seeded = useMemo(() => {
    if (!period) return null;
    const t = windowToTexts(period.shiftWindow);
    return {
      restDays: [...period.restDays],
      startText: t.start,
      endText: t.end,
      effectiveFrom: period.effectiveFrom,
      effectiveTo: period.effectiveTo ?? '',
    } satisfies DraftState;
  }, [period]);

  const state = draft ?? seeded;
  const patch = (p: Partial<DraftState>) => state && setDraft({ ...state, ...p });

  // Both blank = "hours not set", which is a legitimate save. One blank is not.
  const bothBlank = !!state && !state.startText && !state.endText;
  const parsedWindow =
    state && !bothBlank ? parseShiftWindow(`${state.startText}-${state.endText}`) : null;
  const windowInvalid = !!state && !bothBlank && parsedWindow === null;
  const rangeInvalid =
    !!state && !!state.effectiveTo && state.effectiveTo < state.effectiveFrom;
  const canSave = !!state && !windowInvalid && !rangeInvalid && !!state.effectiveFrom;

  const close = () => {
    setDraft(null);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setDraft(null);
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{period ? `Schedule — ${period.name}` : 'Schedule'}</DialogTitle>
          <DialogDescription>
            {period ? formatDeptLabel(period.department) : ''} · times are{' '}
            {period?.timezone ?? 'America/New_York'}. Changes stay on this screen — nothing is saved
            yet.
          </DialogDescription>
        </DialogHeader>

        {state && (
          <div className="flex flex-col gap-5 py-1">
            <div className="flex flex-col gap-2">
              <label className="text-[12.5px] font-medium text-zinc-700 dark:text-zinc-300">
                Days off
              </label>
              <RestDayPicker restDays={state.restDays} onChange={(restDays) => patch({ restDays })} />
              <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
                {7 - state.restDays.length} working {7 - state.restDays.length === 1 ? 'day' : 'days'} a
                week · off {formatRestDays(state.restDays).toLowerCase()}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-[12.5px] font-medium text-zinc-700 dark:text-zinc-300">
                Shift window
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  value={state.startText}
                  onChange={(e) => patch({ startText: e.target.value })}
                  aria-label="Shift start"
                  className="h-9 rounded-md border border-zinc-300 bg-white px-2.5 text-[13px] text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
                <span className="text-zinc-400">–</span>
                <input
                  type="time"
                  value={state.endText}
                  onChange={(e) => patch({ endText: e.target.value })}
                  aria-label="Shift end"
                  className="h-9 rounded-md border border-zinc-300 bg-white px-2.5 text-[13px] text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
                {(state.startText || state.endText) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => patch({ startText: '', endText: '' })}
                    className="h-9 px-2 text-[12px] text-zinc-500"
                  >
                    <X className="mr-1 h-3.5 w-3.5" />
                    Not set
                  </Button>
                )}
              </div>
              {windowInvalid ? (
                <p className="text-[11.5px] font-medium text-rose-600 dark:text-rose-400">
                  Both a start and an end are needed. Leave both blank for &ldquo;hours not
                  set&rdquo; — a half-filled window is not saved as one.
                </p>
              ) : parsedWindow ? (
                <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
                  {formatShiftWindow(parsedWindow)} ·{' '}
                  {(shiftDurationMinutes(parsedWindow) / 60).toFixed(2).replace(/\.00$/, '')} hours
                  {parsedWindow.endMinute < parsedWindow.startMinute && ' · crosses midnight'}
                </p>
              ) : (
                <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
                  Hours not set — their days are known, their window is not.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-[12.5px] font-medium text-zinc-700 dark:text-zinc-300">
                Effective period
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <DatePicker
                  value={state.effectiveFrom}
                  onChange={(iso) => patch({ effectiveFrom: iso })}
                  required
                  aria-label="Effective from"
                  containerClassName="w-[168px]"
                />
                <span className="text-zinc-400">→</span>
                <DatePicker
                  value={state.effectiveTo}
                  onChange={(iso) => patch({ effectiveTo: iso })}
                  placeholder="Still current"
                  aria-label="Effective to"
                  containerClassName="w-[168px]"
                />
              </div>
              {rangeInvalid ? (
                <p className="text-[11.5px] font-medium text-rose-600 dark:text-rose-400">
                  The end date is before the start date.
                </p>
              ) : (
                <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
                  Leave the end blank while this is their current schedule. Closing a period and
                  opening a new one keeps past weeks reading the way they actually ran.
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => {
              if (!period || !state || !canSave) return;
              onSave(period.id, {
                restDays: state.restDays,
                shiftWindow: parsedWindow,
                effectiveFrom: state.effectiveFrom,
                effectiveTo: state.effectiveTo || null,
              });
              close();
            }}
          >
            <Check className="mr-1.5 h-4 w-4" />
            Apply on this screen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── panel ────────────────────────────────────────────────────────────────── */

export default function SchedulingPanel({
  myDepartments,
  department,
  departmentLabel,
  teamSizes,
}: {
  myDepartments?: string[];
  /** The selected rail key. Scopes every read and write to one department. */
  department?: string;
  /** Its already-formatted label, for headings. */
  departmentLabel?: string | null;
  /** Live headcount per department key — the denominator of "not yet scheduled".
   *  Real counts, so the backlog reads as the backlog. */
  teamSizes?: Record<string, number>;
}) {
  const [periods, setPeriods] = useState<SchedulePeriod[]>([]);
  const [defaults, setDefaults] = useState<TeamDefault[]>([]);
  const [editing, setEditing] = useState<SchedulePeriod | null>(null);
  const [deptFilter, setDeptFilter] = useState<string>('all');
  /** null = still loading. false = the table is not there yet; the migration is
   *  Kane's to run, and until it does nothing can be saved — which the banner
   *  says rather than the surface pretending an edit stuck. */
  const [migrated, setMigrated] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMigrated(null);
    setLoadError(null);
    fetch('/api/manager/scheduling', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { migrated?: boolean; periods?: SchedulePeriod[]; error?: string }) => {
        if (cancelled) return;
        if (j.error) {
          setLoadError(j.error);
          setMigrated(false);
          return;
        }
        setMigrated(j.migrated !== false);
        setPeriods(j.periods ?? []);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setLoadError(e.message);
        setMigrated(false);
      });
    return () => {
      cancelled = true;
    };
  }, [department]);

  /** Team defaults are a SEEDING aid, not stored state — they generate periods,
   *  and the periods are what persist. Derived from the sub-teams actually
   *  present so the list is the real teams rather than a fixture's five. */
  useEffect(() => {
    const present = [...new Set(Object.keys(teamSizes ?? {}))].sort();
    setDefaults((prev) =>
      present.map(
        (dept) =>
          prev.find((d) => d.department === dept) ?? {
            department: dept,
            restDays: [],
            shiftWindow: null,
            timezone: 'America/New_York',
          },
      ),
    );
  }, [teamSizes]);

  const departments = useMemo(
    () => [...new Set(defaults.map((d) => d.department))],
    [defaults],
  );

  const visible = useMemo(
    () => (deptFilter === 'all' ? periods : periods.filter((p) => p.department === deptFilter)),
    [periods, deptFilter],
  );

  const rosterSize = useMemo(
    () =>
      deptFilter === 'all'
        ? Object.values(teamSizes ?? {}).reduce((a, b) => a + b, 0)
        : (teamSizes?.[deptFilter] ?? 0),
    [deptFilter],
  );

  const summary = useMemo(() => summarizeScheduling(visible, rosterSize), [visible, rosterSize]);
  const overlaps = useMemo(() => findOverlaps(visible), [visible]);
  const load = useMemo(() => weekdayWeekendLoad(summary.byWeekday), [summary.byWeekday]);

  const scopeLabel =
    deptFilter === 'all'
      ? `${departments.length} teams`
      : formatDeptLabel(deptFilter);

  /**
   * Persist one person's periods.
   *
   * The whole person is sent, not the one edited period: the unit is a PERIOD and
   * changing a schedule means closing one and opening another, which is only
   * expressible as a list. The route refuses overlaps outright (409) rather than
   * warning, because an overlapping date has two answers.
   *
   * Optimistic, then reconciled: the edit paints immediately and a failure puts
   * the previous state back and says so, rather than leaving the screen showing a
   * change the database never took.
   */
  const persistPerson = async (workEmail: string, next: SchedulePeriod[], revert: SchedulePeriod[]) => {
    if (migrated === false) return; // the banner already says why
    setSaving(true);
    try {
      const res = await fetch('/api/manager/scheduling', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workEmail, periods: next.filter((p) => p.workEmail === workEmail) }),
      });
      const j = (await res.json()) as { error?: string; migrated?: boolean };
      if (!res.ok) {
        setPeriods(revert);
        if (j.migrated === false) setMigrated(false);
        toast.error(j.error ?? 'Could not save the schedule');
        return;
      }
      toast.success('Schedule saved');
    } catch (e) {
      setPeriods(revert);
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const savePatch = (id: string, patch: Partial<SchedulePeriod>) => {
    const before = periods;
    const next = periods.map((p) => (p.id === id ? { ...p, ...patch } : p));
    setPeriods(next);
    const owner = next.find((p) => p.id === id)?.workEmail;
    if (owner) void persistPerson(owner, next, before);
  };

  const applyDefaultToTeam = (dept: string) => {
    const def = defaults.find((d) => d.department === dept);
    if (!def) return;
    const before = periods;
    const next = periods.map((p) =>
      p.department === dept && p.effectiveTo === null
        ? { ...p, restDays: [...def.restDays], shiftWindow: def.shiftWindow }
        : p,
    );
    setPeriods(next);
    // One request per person: the route's unit is a person's period list, and a
    // team default touches many people. Sequential on purpose — a burst of
    // parallel writes against the same table is how a partial apply becomes
    // impossible to reason about afterwards.
    void (async () => {
      const touched = [...new Set(next.filter((p) => p.department === dept).map((p) => p.workEmail))];
      for (const email of touched) await persistPerson(email, next, before);
    })();
  };

  return (
    <div className="flex flex-col gap-5">
      {/* The banner is the guard. It used to say "nothing here is real"; now it
          only appears when saving genuinely cannot work — the table is created by
          a script Kane runs, so the code can be live before the table is. A
          surface that quietly accepted edits it could not store would be the
          worse failure. */}
      {migrated === false && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300/80 bg-amber-50 px-4 py-3 dark:border-amber-800/70 dark:bg-amber-950/30">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 text-[12.5px] leading-relaxed text-amber-900 dark:text-amber-100">
            <strong className="font-semibold">Schedules cannot be saved yet.</strong>{' '}
            {loadError
              ? `The schedule store could not be read: ${loadError}`
              : 'The schedule table has not been created in this database yet. An administrator runs ' +
                'scripts/apply-employee-schedules-migration.mts --apply once, and this notice disappears.'}{' '}
            You can still work out the shape below — nothing entered here is stored until then.
          </div>
        </div>
      )}
      {migrated === null && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-100/70 bg-blue-50/40 px-4 py-3 text-[12.5px] text-zinc-600 dark:border-blue-950/50 dark:bg-blue-950/20 dark:text-zinc-300">
          <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          Loading schedules…
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[19px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Scheduling
            {departmentLabel && (
              <span className="text-[13px] font-medium text-zinc-500 dark:text-zinc-400">
                · {departmentLabel}
              </span>
            )}
            {saving && (
              <span className="inline-flex items-center gap-1 text-[12px] font-medium text-blue-600 dark:text-blue-400">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
                Saving…
              </span>
            )}
          </h2>
          <p className="mt-0.5 text-[13px] text-zinc-500 dark:text-zinc-400">
            What each person is expected to work, and from when. Of{' '}
            <span className="font-medium text-zinc-700 dark:text-zinc-200">
              {rosterSize} active
            </span>{' '}
            in {scopeLabel}.
          </p>
        </div>

        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setDeptFilter('all')}
            className={cn(
              'rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors',
              deptFilter === 'all'
                ? 'border-blue-500 bg-blue-500 text-white'
                : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900',
            )}
          >
            All teams
          </button>
          {departments.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDeptFilter(d)}
              className={cn(
                'rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors',
                deptFilter === d
                  ? 'border-blue-500 bg-blue-500 text-white'
                  : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900',
              )}
            >
              {formatDeptLabel(d).replace('HSL — ', '')}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Scheduled"
          value={summary.scheduled}
          hint={`of ${rosterSize} active in scope`}
          tone="blue"
          icon={Users}
        />
        <KpiCard
          label="Not yet scheduled"
          value={summary.unscheduled}
          hint="no period on file — the seeding backlog"
          tone="amber"
          icon={CalendarRange}
        />
        <KpiCard
          label="Hours not set"
          value={summary.missingWindow}
          hint="days known, window blank"
          tone="zinc"
          icon={Clock}
        />
        <KpiCard
          label="Thinnest day"
          value={`${WEEKDAY_SHORT[summary.thinnestDay]} · ${summary.byWeekday[summary.thinnestDay]}`}
          hint="fewest people expected"
          tone="violet"
          icon={CalendarClock}
        />
      </div>

      {overlaps.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-rose-300/80 bg-rose-50 px-4 py-3 dark:border-rose-900/60 dark:bg-rose-950/25">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
          <div className="text-[12.5px] text-rose-900 dark:text-rose-100">
            <strong className="font-semibold">
              {overlaps.length} overlapping {overlaps.length === 1 ? 'period' : 'periods'}.
            </strong>{' '}
            {overlaps.map(([a]) => a.name).join(', ')} — a date covered by two periods has two
            answers. Close the earlier period before the later one begins.
          </div>
        </div>
      )}

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
        <div className="mb-3">
          <h3 className="text-[14px] font-semibold text-zinc-800 dark:text-zinc-100">
            Expected cover by weekday
          </h3>
          <p className="mt-0.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">
            From schedules alone. No timesheet involved, so this reads forward.
          </p>
        </div>

        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:gap-8">
          <div className="shrink-0">
            <WeekCoverChart byWeekday={summary.byWeekday} />
            <div className="mt-3 flex max-w-[380px] flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              <span className="flex items-center gap-1.5">
                <i className="h-2 w-2 rounded-sm bg-blue-500" aria-hidden />
                Weekday
              </span>
              <span className="flex items-center gap-1.5">
                <i className="h-2 w-2 rounded-sm bg-violet-400" aria-hidden />
                Weekend
              </span>
              <span className="flex items-center gap-1.5">
                <i className="h-2 w-2 rounded-sm bg-rose-300 dark:bg-rose-900/60" aria-hidden />
                Nobody expected
              </span>
            </div>
          </div>

          {/* The width earns its keep here rather than stretching the bars: mean AND
              range, because a mean alone hides whether a week runs 12/12/12/12/12 or
              20/20/20/0/0. A 1px rule divides the columns; it is a divider, not an
              accent stripe. */}
          <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-4 border-zinc-100 dark:border-zinc-800 lg:border-l lg:pl-8">
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                Weekday cover
              </dt>
              <dd className="mt-1 font-mono text-[19px] font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
                {load.weekdayMean}
              </dd>
              <dd className="text-[11px] text-zinc-500 dark:text-zinc-400">
                mean · {load.weekdayMin}&ndash;{load.weekdayMax} range
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                Weekend cover
              </dt>
              <dd className="mt-1 font-mono text-[19px] font-semibold tabular-nums text-violet-700 dark:text-violet-300">
                {load.weekendMean}
              </dd>
              <dd className="text-[11px] text-zinc-500 dark:text-zinc-400">
                mean · {load.weekendMin}&ndash;{load.weekendMax} range
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                Weekend ratio
              </dt>
              <dd className="mt-1 font-mono text-[19px] font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
                {load.weekdayMean > 0
                  ? `${Math.round((load.weekendMean / load.weekdayMean) * 100)}%`
                  : '—'}
              </dd>
              <dd className="text-[11px] text-zinc-500 dark:text-zinc-400">
                of weekday cover
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                Uncovered days
              </dt>
              <dd
                className={cn(
                  'mt-1 font-mono text-[19px] font-semibold tabular-nums',
                  load.uncoveredDays.length > 0
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-zinc-800 dark:text-zinc-100',
                )}
              >
                {load.uncoveredDays.length}
              </dd>
              <dd className="text-[11px] text-zinc-500 dark:text-zinc-400">
                {load.uncoveredDays.length > 0
                  ? load.uncoveredDays.map((d) => WEEKDAY_SHORT[d]).join(', ')
                  : 'every day has someone'}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[14px] font-semibold text-zinc-800 dark:text-zinc-100">
            Team defaults
          </h3>
          <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
            Five defaults reach most of the roster. Per-person periods exist only where someone
            differs.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {defaults
            .filter((d) => deptFilter === 'all' || d.department === deptFilter)
            .map((d) => {
              // Pulled out of JSX deliberately: this renders a HEADCOUNT, not a
              // department label, and `dept-label-render.test.ts` rightly flags a
              // bare `d.department` sitting in a render position. Naming the count
              // keeps the guard honest instead of widening its allowlist.
              const teamSize = teamSizes?.[d.department] ?? 0;
              return (
              <div
                key={d.department}
                className="flex flex-col gap-2.5 rounded-md border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-100">
                    {formatDeptLabel(d.department)}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-400">
                    {teamSize}
                  </span>
                </div>
                <RestDayPicker
                  restDays={d.restDays}
                  onChange={(restDays) =>
                    setDefaults((prev) =>
                      prev.map((x) => (x.department === d.department ? { ...x, restDays } : x)),
                    )
                  }
                />
                <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
                  {d.shiftWindow ? (
                    formatShiftWindow(d.shiftWindow)
                  ) : (
                    <span className="text-amber-700 dark:text-amber-400">Hours not set</span>
                  )}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11.5px]"
                  onClick={() => applyDefaultToTeam(d.department)}
                >
                  Apply to current periods
                </Button>
              </div>
              );
            })}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950/40">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <h3 className="text-[14px] font-semibold text-zinc-800 dark:text-zinc-100">
            Schedule periods
          </h3>
          <p className="font-mono text-[11.5px] tabular-nums text-zinc-400">
            {visible.length} {visible.length === 1 ? 'period' : 'periods'}
          </p>
        </div>

        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <CalendarRange className="h-6 w-6 text-zinc-300 dark:text-zinc-700" />
            <p className="text-[13px] text-zinc-500 dark:text-zinc-400">
              No schedule periods for this team yet.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead>
                <tr className="border-b border-zinc-100 bg-zinc-50/70 text-left dark:border-zinc-800 dark:bg-zinc-900/50">
                  <th className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                    Person
                  </th>
                  <th className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                    Week
                  </th>
                  <th className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                    Shift window
                  </th>
                  <th className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                    Effective
                  </th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => {
                  const superseded = p.effectiveTo !== null;
                  return (
                    <tr
                      key={p.id}
                      className={cn(
                        'border-b border-zinc-100 last:border-b-0 dark:border-zinc-800/70',
                        superseded && 'bg-zinc-50/60 dark:bg-zinc-900/30',
                      )}
                    >
                      <td className="px-4 py-2.5 align-top">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-zinc-800 dark:text-zinc-100">
                            {p.name}
                          </span>
                          {superseded && (
                            <span className="rounded bg-zinc-200 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                              Past
                            </span>
                          )}
                        </div>
                        <span className="text-[11.5px] text-zinc-400">
                          {formatDeptLabel(p.department)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        <WeekStrip restDays={p.restDays} />
                        <span className="mt-1 block text-[11px] text-zinc-400">
                          {scheduledDaysPerWeek(p)} days · off {formatRestDays(p.restDays).toLowerCase()}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        {p.shiftWindow ? (
                          <span className="font-mono text-[12px] tabular-nums text-zinc-700 dark:text-zinc-200">
                            {formatShiftWindow(p.shiftWindow)}
                          </span>
                        ) : (
                          <span className="text-[12px] font-medium text-amber-700 dark:text-amber-400">
                            Hours not set
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        <span className="font-mono text-[11.5px] tabular-nums text-zinc-600 dark:text-zinc-300">
                          {p.effectiveFrom} → {p.effectiveTo ?? 'current'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right align-top">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[12px]"
                          onClick={() => setEditing(p)}
                        >
                          <Pencil className="mr-1 h-3.5 w-3.5" />
                          Edit
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-zinc-200 bg-zinc-50/70 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
        <div className="min-w-0 space-y-2 text-[12.5px] leading-relaxed text-zinc-600 dark:text-zinc-300">
          <p>
            <strong className="font-semibold text-zinc-800 dark:text-zinc-100">
              Days will be checkable, hours will not.
            </strong>{' '}
            The timesheet stores a total per day and no clock times, so once this is wired we can
            say &ldquo;scheduled Tuesday, no hours Tuesday&rdquo;. We cannot say &ldquo;started
            three hours late&rdquo; — that needs a time-entry feed the system does not have.
          </p>
          <p>
            <strong className="font-semibold text-zinc-800 dark:text-zinc-100">
              Schedules never touch pay.
            </strong>{' '}
            HSL prices days by the calendar — weekend premium, PAB coverage, orphanage OT — and it
            stays that way. A schedule describes what was expected; it is not an input to any rate.
          </p>
        </div>
      </div>

      <EditPeriodDialog
        period={editing}
        open={editing !== null}
        onOpenChange={(v) => !v && setEditing(null)}
        onSave={savePatch}
      />

      {myDepartments && myDepartments.length > 0 && (
        <p className="text-[11px] text-zinc-400">
          Your departments: {myDepartments.map((d) => formatDeptLabel(d)).join(' · ')} — scoping is
          wired when the route is.
        </p>
      )}
    </div>
  );
}
