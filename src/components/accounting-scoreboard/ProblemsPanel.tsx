'use client';

/**
 * Payroll Problems: a log of problems, each with a Problem Type (Carla, 2026-10-02), and the
 * person-by-day table it adds up to. It replaced the daily count grid on 2026-10-06. Counts typed
 * into that grid before then are still read and still count, as "No type"; they are never written
 * again. Managers add types under Setup → Problem types.
 *
 * Every number is computed by problemsWeekStats (scoring.ts); nothing here sums. A logged line is
 * never edited: a mistake is deleted (by whoever logged it, or a manager) and logged again.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Loader2, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SmoothSelect } from '@/components/ui/smooth-select';
import type { BoardSection } from '@/lib/accounting-scoreboard/sections';
import { datesFor, dayHeader } from '@/lib/accounting-scoreboard/week';
import { problemsWeekStats, UNTYPED_PROBLEMS, type EntryLookup, type ProblemEntry } from '@/lib/accounting-scoreboard/scoring';
import { goalLight, weekPace } from '@/lib/accounting-scoreboard/stoplight';
import { MAX_PROBLEMS_PER_LINE, MIN_PROBLEMS_PER_LINE } from '@/lib/accounting-scoreboard/validate';
import type { BoardPayload, BoardRow } from '@/lib/accounting-scoreboard/types';
import { DIM, EASE_SETTLE, EmptyRows, Flash, GoalChip, LIGHT_STYLE, RowTag, SectionHeader, TINY_CAPS, fmtNum, handle } from './shared';

export interface NewProblem {
  rowId: string;
  date: string;
  typeId: string;
  count: number;
}

interface Props {
  section: BoardSection;
  board: BoardPayload;
  rows: BoardRow[];
  lookup: EntryLookup;
  onLog: (p: NewProblem) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}

const TH = cn(TINY_CAPS, 'whitespace-nowrap px-2 py-2 text-zinc-500 dark:text-zinc-400');
const TD = 'px-2 py-2 align-middle';
const NUM = 'text-right font-mono tabular-nums';
const FIELD_LABEL = cn(TINY_CAPS, 'text-zinc-500 dark:text-zinc-400');
const FIELD = 'bg-white focus-visible:border-orange-400 focus-visible:ring-orange-500/20 dark:bg-zinc-950 dark:focus-visible:border-orange-700';

export function ProblemsPanel({ section, board, rows, lookup, onLog, onDelete }: Props) {
  const reduce = useReducedMotion() ?? false;
  const dates = useMemo(() => datesFor(board.weekStart, section.days), [board.weekStart, section.days]);
  const lastDates = useMemo(() => datesFor(board.lastWeekStart, section.days), [board.lastWeekStart, section.days]);
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const week = useMemo(() => problemsWeekStats(ids, board.problems, lookup, dates), [ids, board.problems, lookup, dates]);
  const last = useMemo(() => problemsWeekStats(ids, board.problems, lookup, lastDates), [ids, board.problems, lookup, lastDates]);
  const labelOf = useMemo(() => new Map(rows.map((r) => [r.id, r.label])), [rows]);
  const typeOf = useMemo(() => new Map(board.problemTypes.map((t) => [t.id, t.label])), [board.problemTypes]);
  const liveTypes = board.problemTypes.filter((t) => !t.archived);
  const livePeople = rows.filter((r) => !r.archived);
  const scope = board.weekStart;

  const loggable = dates.filter((d) => d <= board.today);
  const [date, setDate] = useState<string>(() => loggable[loggable.length - 1] ?? '');
  const [rowId, setRowId] = useState<string>(livePeople[0]?.id ?? '');
  const [typeId, setTypeId] = useState<string>(liveTypes[0]?.id ?? '');
  const [count, setCount] = useState('1');
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const effectiveDate = loggable.includes(date) ? date : loggable[loggable.length - 1] ?? '';
  const effectiveRow = livePeople.some((r) => r.id === rowId) ? rowId : livePeople[0]?.id ?? '';
  const effectiveType = liveTypes.some((t) => t.id === typeId) ? typeId : liveTypes[0]?.id ?? '';

  const light = goalLight(section.goal, week.week, weekPace(dates, board.today));
  const lastLight = goalLight(section.goal, last.week, 1);
  const weekLines = useMemo(
    () =>
      board.problems
        .filter((p) => dates.includes(p.date))
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
    [board.problems, dates],
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!effectiveRow || !effectiveDate || !effectiveType) return;
    const n = Number(count);
    // 0 is a real "0 problems" (Kane, 2026-10-07); an empty box is not a 0.
    if (count.trim() === '' || !Number.isInteger(n) || n < MIN_PROBLEMS_PER_LINE || n > MAX_PROBLEMS_PER_LINE) {
      setFieldError(`How many is a whole number from ${MIN_PROBLEMS_PER_LINE} to ${MAX_PROBLEMS_PER_LINE}`);
      return;
    }
    setFieldError(null);
    setBusy(true);
    const ok = await onLog({ rowId: effectiveRow, date: effectiveDate, typeId: effectiveType, count: n });
    setBusy(false);
    if (ok) setCount('1');
  }

  const header = (
    <SectionHeader
      title={section.title}
      help={section.help}
      right={
        <>
          <GoalChip goal={section.goal} light={light} value={week.week} unitFormat={fmtNum} />
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Last week <span className={cn('font-mono tabular-nums', LIGHT_STYLE[lastLight].text)}>{fmtNum(last.week)}</span>
          </span>
        </>
      }
    />
  );

  if (!rows.length) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyRows noun={section.rowNoun} isManager={board.viewer.isManager} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {header}

      <form
        onSubmit={submit}
        className="grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-xl border border-orange-100 bg-orange-50/40 p-3 lg:grid-cols-[9rem_minmax(9rem,12rem)_minmax(12rem,1fr)_6rem_auto] lg:items-end dark:border-orange-950/60 dark:bg-orange-950/10"
      >
        <div className="grid min-w-0 gap-1">
          <span className={FIELD_LABEL}>Day</span>
          <SmoothSelect
            value={effectiveDate}
            onChange={setDate}
            disabled={!loggable.length}
            options={
              loggable.length
                ? loggable.map((d) => ({ value: d, label: `${dayHeader(d).weekday} ${dayHeader(d).short}` }))
                : [{ value: '', label: 'No day yet', disabled: true }]
            }
            accent="orange"
            align="start"
            portal
            aria-label="Day"
            triggerClassName="text-sm"
          />
        </div>
        <div className="grid min-w-0 gap-1">
          <span className={FIELD_LABEL}>Person</span>
          <SmoothSelect
            value={effectiveRow}
            onChange={setRowId}
            options={livePeople.map((r) => ({ value: r.id, label: r.label }))}
            searchable={livePeople.length > 8}
            searchPlaceholder="Find a person…"
            accent="orange"
            align="start"
            portal
            aria-label="Person"
            triggerClassName="text-sm"
          />
        </div>
        <div className="col-span-2 grid min-w-0 gap-1 lg:col-span-1">
          <span className={FIELD_LABEL}>Problem type</span>
          <SmoothSelect
            value={effectiveType}
            onChange={setTypeId}
            disabled={!liveTypes.length}
            options={
              liveTypes.length
                ? liveTypes.map((t) => ({ value: t.id, label: t.label }))
                : [{ value: '', label: 'No types yet', disabled: true }]
            }
            searchable={liveTypes.length > 8}
            searchPlaceholder="Find a type…"
            accent="orange"
            align="start"
            portal
            aria-label="Problem type"
            triggerClassName="text-sm"
          />
        </div>
        <label className="grid min-w-0 gap-1">
          <span className={FIELD_LABEL}>How many</span>
          <Input
            value={count}
            inputMode="numeric"
            title="A whole number, usually 1. Log 0 for a day with no problems."
            aria-invalid={fieldError ? true : undefined}
            onChange={(e) => setCount(e.target.value.replace(/[^0-9]/g, ''))}
            className={cn(FIELD, 'text-right font-mono tabular-nums')}
          />
        </label>
        <Button
          type="submit"
          size="lg"
          disabled={busy || !loggable.length || !effectiveRow || !effectiveType}
          className={cn(
            'h-9 bg-gradient-to-r from-orange-500 to-amber-600 text-white shadow-sm shadow-orange-600/20 hover:from-orange-600 hover:to-amber-700',
            'disabled:bg-none disabled:bg-zinc-200 disabled:text-zinc-500 disabled:opacity-100 disabled:shadow-none dark:disabled:bg-zinc-800 dark:disabled:text-zinc-400',
          )}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          Log problem
        </Button>
        {!liveTypes.length ? (
          <p className="col-span-2 text-xs text-zinc-500 lg:col-span-5">
            {board.viewer.isManager ? 'Add a problem type under Setup → Problem types first.' : 'Carla or Claire add problem types under Setup.'}
          </p>
        ) : null}
        {fieldError ? (
          <p role="alert" className="col-span-2 text-xs font-medium text-rose-600 lg:col-span-5 dark:text-rose-400">
            How many: {fieldError}
          </p>
        ) : null}
      </form>

      {week.byType.length ? (
        <div className="flex flex-wrap items-center gap-2" aria-label="This week by problem type">
          {week.byType.map((t) => (
            <span
              key={t.typeId}
              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11px] text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
              title={t.typeId === UNTYPED_PROBLEMS ? 'Counted in the old grid, before problems had types' : undefined}
            >
              <span className="font-mono font-semibold tabular-nums">
                <Flash value={t.count} scope={scope}>{fmtNum(t.count)}</Flash>
              </span>
              {t.typeId === UNTYPED_PROBLEMS ? 'No type' : typeOf.get(t.typeId) ?? 'Unknown type'}
            </span>
          ))}
        </div>
      ) : null}

      <div className="min-w-0 overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="table-keep w-full border-collapse text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
            <tr>
              <th className={cn(TH, 'text-left')}>{section.rowNoun}</th>
              {dates.map((d) => (
                <th key={d} className={cn(TH, 'text-right', d === board.today && 'text-orange-600 dark:text-orange-400')}>
                  {dayHeader(d).weekday}
                </th>
              ))}
              <th className={cn(TH, 'text-right')}>Week</th>
              <th className={cn(TH, 'text-right')}>Last wk</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {rows.map((r) => {
              const s = week.rows.get(r.id)!;
              const l = last.rows.get(r.id)!;
              return (
                <tr key={r.id} className="transition-colors hover:bg-orange-50/30 dark:hover:bg-zinc-900/40">
                  <td className={cn(TD, 'whitespace-nowrap font-medium text-zinc-800 dark:text-zinc-200')}>
                    {r.label} {r.archived ? <RowTag>removed</RowTag> : null}
                  </td>
                  {s.byDay.map((v, i) => (
                    <td key={dates[i]} className={cn(TD, NUM, v === null ? DIM : 'text-zinc-700 dark:text-zinc-300')}>
                      <Flash value={v} scope={scope}>{fmtNum(v)}</Flash>
                    </td>
                  ))}
                  <td className={cn(TD, NUM, 'font-semibold')}>
                    <Flash value={s.week} scope={scope}>{fmtNum(s.week)}</Flash>
                  </td>
                  <td className={cn(TD, NUM, DIM)}>{fmtNum(l.week)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
            <tr>
              <td className={cn(TD, TINY_CAPS, 'whitespace-nowrap text-zinc-500')}>Day total</td>
              {week.byDay.map((v, i) => (
                <td key={dates[i]} className={cn(TD, NUM, 'font-semibold')}>
                  <Flash value={v} scope={scope}>{fmtNum(v)}</Flash>
                </td>
              ))}
              <td className={cn(TD, NUM, 'font-semibold')}>
                <Flash value={week.week} scope={scope}>{fmtNum(week.week)}</Flash>
              </td>
              <td className={cn(TD, NUM, DIM)}>{fmtNum(last.week)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="space-y-2">
        <h3 className={cn(TINY_CAPS, 'text-zinc-500')}>This week&rsquo;s log ({weekLines.length})</h3>
        {weekLines.length ? (
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-zinc-950">
            <AnimatePresence initial={false}>
              {weekLines.map((p) => (
                <ProblemLine
                  key={p.id}
                  entry={p}
                  person={labelOf.get(p.rowId) ?? '—'}
                  type={typeOf.get(p.typeId) ?? 'Unknown type'}
                  canDelete={board.viewer.isManager || p.createdBy.toLowerCase() === board.viewer.email}
                  onDelete={onDelete}
                  reduce={reduce}
                />
              ))}
            </AnimatePresence>
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-zinc-200 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
            Nothing logged this week yet.
          </p>
        )}
      </div>
    </div>
  );
}

function ProblemLine({
  entry,
  person,
  type,
  canDelete,
  onDelete,
  reduce,
}: {
  entry: ProblemEntry;
  person: string;
  type: string;
  canDelete: boolean;
  onDelete: (id: string) => Promise<boolean>;
  reduce: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const h = dayHeader(entry.date);
  return (
    <motion.li
      layout={reduce ? false : 'position'}
      initial={{ opacity: 0, y: reduce ? 0 : -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: reduce ? 0 : -14, transition: { duration: 0.14 } }}
      transition={{ duration: reduce ? 0 : 0.22, ease: EASE_SETTLE }}
      className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-white px-3 py-2 text-sm dark:bg-zinc-950"
    >
      <span className="w-16 shrink-0 font-mono text-[11px] text-zinc-500">
        {h.weekday} {h.short}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-zinc-800 sm:w-28 sm:flex-none dark:text-zinc-200">{person}</span>
      <span className="order-last w-full min-w-0 break-words text-zinc-700 sm:order-none sm:w-auto sm:flex-1 dark:text-zinc-300">{type}</span>
      <span className="w-10 shrink-0 whitespace-nowrap text-right font-mono tabular-nums">× {fmtNum(entry.count)}</span>
      <span className="hidden w-24 shrink-0 truncate font-mono text-[11px] text-zinc-400 sm:block" title={entry.createdBy}>
        {handle(entry.createdBy)}
      </span>
      {canDelete ? (
        confirming ? (
          <span className="flex items-center gap-1">
            <Button
              size="xs"
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const ok = await onDelete(entry.id);
                setBusy(false);
                if (!ok) setConfirming(false);
              }}
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              Delete
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button size="icon-xs" variant="ghost" aria-label="Delete this problem" onClick={() => setConfirming(true)}>
            <Trash2 />
          </Button>
        )
      ) : (
        <span className="w-6" />
      )}
    </motion.li>
  );
}
