'use client';

/**
 * Collections: the log (one line per collected account), the per-rep points table, the podium,
 * the record, and the Dancing Queen preview. The log replaces the sheet's "Collection Count" tab
 * and the hard-coded DATE() formulas that summed it.
 *
 * The preview is DISPLAY ONLY. HRIS still pays the bonus from the five day totals typed into the
 * KPI calculator, and whether those should be points or accounts is an open money ruling
 * (Open item 315). So this panel shows both readings and never picks one.
 */

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Crown, Loader2, Medal, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { ResolvedSection } from '@/lib/accounting-scoreboard/sections';
import { datesFor, dayHeader, weekLabel } from '@/lib/accounting-scoreboard/week';
import { collectionsWeekStats, goalMet, type CollectionEntry } from '@/lib/accounting-scoreboard/scoring';
import { previewBoth, DAY_VARIABLES } from '@/lib/accounting-scoreboard/bonus-preview';
import type { BoardPayload, BoardRow } from '@/lib/accounting-scoreboard/types';
import { DIM, EmptyRows, GoalChip, SectionHeader, TINY_CAPS, fmtNum, fmtPhp, fmtUsd, handle } from './shared';

export interface NewCollection {
  rowId: string;
  date: string;
  businessName: string;
  points: number;
  amountUsd: number | null;
}

interface Props {
  section: ResolvedSection;
  board: BoardPayload;
  rows: BoardRow[];
  onLog: (c: NewCollection) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}

const TH = cn(TINY_CAPS, 'whitespace-nowrap px-2 py-2 text-zinc-500 dark:text-zinc-400');
const TD = 'px-2 py-2 align-middle';
const NUM = 'text-right font-mono tabular-nums';

const PODIUM = [
  { tone: 'from-amber-400 to-amber-600', Icon: Crown, label: '1st' },
  { tone: 'from-zinc-300 to-zinc-500', Icon: Medal, label: '2nd' },
  { tone: 'from-orange-400 to-orange-700', Icon: Medal, label: '3rd' },
] as const;

export function CollectionsPanel({ section, board, rows, onLog, onDelete }: Props) {
  const dates = useMemo(() => datesFor(board.weekStart, section.days), [board.weekStart, section.days]);
  const lastDates = useMemo(() => datesFor(board.lastWeekStart, section.days), [board.lastWeekStart, section.days]);
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const week = useMemo(() => collectionsWeekStats(ids, board.collections, dates), [ids, board.collections, dates]);
  const last = useMemo(() => collectionsWeekStats(ids, board.collections, lastDates), [ids, board.collections, lastDates]);
  const labelOf = useMemo(() => new Map(rows.map((r) => [r.id, r.label])), [rows]);
  const liveReps = rows.filter((r) => !r.archived);

  const loggable = dates.filter((d) => d <= board.today);
  const [date, setDate] = useState<string>(() => loggable[loggable.length - 1] ?? '');
  const [rowId, setRowId] = useState<string>(liveReps[0]?.id ?? '');
  const [business, setBusiness] = useState('');
  const [points, setPoints] = useState('1');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const businessRef = useRef<HTMLInputElement>(null);
  const effectiveDate = loggable.includes(date) ? date : loggable[loggable.length - 1] ?? '';
  const effectiveRow = liveReps.some((r) => r.id === rowId) ? rowId : liveReps[0]?.id ?? '';

  const weekLogs = useMemo(
    () =>
      board.collections
        .filter((c) => dates.includes(c.date))
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
    [board.collections, dates],
  );

  const preview = board.bonus.ok ? previewBoth(board.bonus.bonus.formula, week.byDay) : null;
  const lastPreview = board.bonus.ok ? previewBoth(board.bonus.bonus.formula, last.byDay) : null;
  const headline = week.week.accounts === 0 ? null : week.week.points;
  const met = goalMet(section.goal, headline);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = Number(points);
    const a = amount.trim() === '' ? null : Number(amount);
    if (!effectiveRow || !effectiveDate || !business.trim()) return;
    if (!Number.isFinite(p) || (a !== null && !Number.isFinite(a))) return;
    setBusy(true);
    const ok = await onLog({ rowId: effectiveRow, date: effectiveDate, businessName: business, points: p, amountUsd: a });
    setBusy(false);
    if (ok) {
      setBusiness('');
      setAmount('');
      setPoints('1');
      businessRef.current?.focus();
    }
  }

  const header = (
    <SectionHeader
      title={section.title}
      help={section.help}
      right={
        <>
          <GoalChip goal={section.goal} met={met} value={headline} unitFormat={fmtNum} />
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Last week <span className="font-mono tabular-nums">{last.week.accounts ? fmtNum(last.week.points) : '—'}</span>
          </span>
          {board.history.record ? (
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
              Record <span className="font-mono tabular-nums">{fmtNum(board.history.record.points)}</span>{' '}
              <span className="opacity-70">({weekLabel(board.history.record.weekStart)})</span>
            </span>
          ) : null}
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
        className="grid gap-2 rounded-xl border border-orange-100 bg-orange-50/40 p-3 sm:grid-cols-[8.5rem_10rem_1fr_5rem_7rem_auto] sm:items-end dark:border-orange-950/60 dark:bg-orange-950/10"
      >
        <label className="grid gap-1">
          <span className={cn(TINY_CAPS, 'text-zinc-500')}>Day</span>
          <select
            value={effectiveDate}
            onChange={(e) => setDate(e.target.value)}
            disabled={!loggable.length}
            className="h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            {loggable.map((d) => (
              <option key={d} value={d}>
                {dayHeader(d).weekday} {dayHeader(d).short}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={cn(TINY_CAPS, 'text-zinc-500')}>Rep</span>
          <select
            value={effectiveRow}
            onChange={(e) => setRowId(e.target.value)}
            className="h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            {liveReps.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={cn(TINY_CAPS, 'text-zinc-500')}>Business name</span>
          <input
            ref={businessRef}
            value={business}
            onChange={(e) => setBusiness(e.target.value)}
            maxLength={200}
            placeholder="e.g. Chocolate Fountain Heaven"
            className="h-9 rounded-md border border-zinc-200 bg-white px-2.5 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          />
        </label>
        <label className="grid gap-1">
          <span className={cn(TINY_CAPS, 'text-zinc-500')}>Points</span>
          <input
            value={points}
            inputMode="decimal"
            onChange={(e) => setPoints(e.target.value.replace(/[^0-9.]/g, ''))}
            className="h-9 rounded-md border border-zinc-200 bg-white px-2 text-right font-mono text-sm tabular-nums dark:border-zinc-800 dark:bg-zinc-950"
          />
        </label>
        <label className="grid gap-1">
          <span className={cn(TINY_CAPS, 'text-zinc-500')}>Amount (USD)</span>
          <input
            value={amount}
            inputMode="decimal"
            placeholder="optional"
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            className="h-9 rounded-md border border-zinc-200 bg-white px-2 text-right font-mono text-sm tabular-nums dark:border-zinc-800 dark:bg-zinc-950"
          />
        </label>
        <Button
          type="submit"
          size="lg"
          disabled={busy || !loggable.length || !effectiveRow || !business.trim()}
          className="bg-gradient-to-r from-orange-500 to-amber-600 text-white hover:from-orange-600 hover:to-amber-700"
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          Log collection
        </Button>
        {!loggable.length ? (
          <p className="text-xs text-zinc-500 sm:col-span-6">This week has no day you can log yet.</p>
        ) : null}
      </form>

      {week.podium.length ? (
        <div className="flex flex-wrap gap-2">
          {week.podium.map((p, i) => {
            const { tone, Icon, label } = PODIUM[i];
            return (
              <div
                key={p.rowId}
                className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <span className={cn('flex size-7 items-center justify-center rounded-md bg-gradient-to-br text-white shadow-sm', tone)}>
                  <Icon className="size-4" />
                </span>
                <div>
                  <div className={cn(TINY_CAPS, 'text-zinc-400')}>{label}</div>
                  <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                    {labelOf.get(p.rowId) ?? '—'}{' '}
                    <span className="font-mono text-xs font-normal tabular-nums text-zinc-500">{fmtNum(p.points)} pts</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="min-w-0 overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full border-collapse text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
            <tr>
              <th className={cn(TH, 'text-left')}>Rep</th>
              {dates.map((d) => (
                <th key={d} className={cn(TH, 'text-right', d === board.today && 'text-orange-600 dark:text-orange-400')}>
                  {dayHeader(d).weekday}
                </th>
              ))}
              <th className={cn(TH, 'text-right')}>WTD</th>
              <th className={cn(TH, 'text-right')}>Last wk</th>
              <th className={cn(TH, 'text-right')}>All time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {rows.map((r) => {
              const s = week.rows.get(r.id)!;
              const l = last.rows.get(r.id)!;
              return (
                <tr key={r.id}>
                  <td className={cn(TD, 'font-medium text-zinc-800 dark:text-zinc-200')}>
                    {r.label}
                    {r.archived ? <span className={cn(TINY_CAPS, 'ml-1.5 text-[9px] text-zinc-400')}>removed</span> : null}
                  </td>
                  {s.byDay.map((d, i) => (
                    <td key={dates[i]} className={cn(TD, NUM, d.accounts ? 'text-zinc-700 dark:text-zinc-300' : DIM)}>
                      {d.accounts ? fmtNum(d.points) : '—'}
                    </td>
                  ))}
                  <td className={cn(TD, NUM, 'font-semibold')}>{s.week.accounts ? fmtNum(s.week.points) : <span className={DIM}>—</span>}</td>
                  <td className={cn(TD, NUM, DIM)}>{l.week.accounts ? fmtNum(l.week.points) : '—'}</td>
                  <td className={cn(TD, NUM, 'text-zinc-600 dark:text-zinc-400')}>
                    {board.history.allTimeByRow[r.id] !== undefined ? fmtNum(board.history.allTimeByRow[r.id]) : <span className={DIM}>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
            <tr>
              <td className={cn(TD, TINY_CAPS, 'text-zinc-500')}>Day total (points)</td>
              {week.byDay.map((d, i) => (
                <td key={dates[i]} className={cn(TD, NUM, 'font-semibold')}>
                  {d.accounts ? fmtNum(d.points) : <span className={DIM}>—</span>}
                </td>
              ))}
              <td className={cn(TD, NUM, 'font-semibold')}>{week.week.accounts ? fmtNum(week.week.points) : <span className={DIM}>—</span>}</td>
              <td className={cn(TD, NUM, DIM)}>{last.week.accounts ? fmtNum(last.week.points) : '—'}</td>
              <td className={cn(TD, NUM, DIM)} />
            </tr>
            <tr>
              <td className={cn(TD, TINY_CAPS, 'text-zinc-500')}>Accounts</td>
              {week.byDay.map((d, i) => (
                <td key={dates[i]} className={cn(TD, NUM, 'text-zinc-500')}>
                  {d.accounts ? d.accounts : <span className={DIM}>—</span>}
                </td>
              ))}
              <td className={cn(TD, NUM, 'text-zinc-500')}>{week.week.accounts || <span className={DIM}>—</span>}</td>
              <td className={cn(TD, NUM, DIM)}>{last.week.accounts || '—'}</td>
              <td className={cn(TD, NUM, DIM)} />
            </tr>
          </tfoot>
        </table>
      </div>

      <BonusPreviewCard
        verdict={board.bonus}
        byDay={week.byDay}
        dates={dates}
        preview={preview}
        lastPreview={lastPreview}
      />

      <div className="space-y-2">
        <h3 className={cn(TINY_CAPS, 'text-zinc-500')}>This week&rsquo;s log ({weekLogs.length})</h3>
        {weekLogs.length ? (
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-zinc-950">
            {weekLogs.map((c) => (
              <LogLine
                key={c.id}
                entry={c}
                rep={labelOf.get(c.rowId) ?? '—'}
                canDelete={board.viewer.isManager || c.createdBy.toLowerCase() === board.viewer.email}
                onDelete={onDelete}
              />
            ))}
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

function LogLine({
  entry,
  rep,
  canDelete,
  onDelete,
}: {
  entry: CollectionEntry;
  rep: string;
  canDelete: boolean;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const h = dayHeader(entry.date);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
      <span className="w-16 shrink-0 font-mono text-[11px] text-zinc-500">
        {h.weekday} {h.short}
      </span>
      <span className="w-28 shrink-0 truncate font-medium text-zinc-800 dark:text-zinc-200">{rep}</span>
      <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300" title={entry.businessName}>
        {entry.businessName}
      </span>
      <span className="w-14 shrink-0 text-right font-mono tabular-nums">{fmtNum(entry.points)} pt</span>
      <span className="w-24 shrink-0 text-right font-mono tabular-nums text-zinc-500">{fmtUsd(entry.amountUsd)}</span>
      <span className="w-24 shrink-0 truncate font-mono text-[11px] text-zinc-400" title={entry.createdBy}>
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
          <Button size="icon-xs" variant="ghost" aria-label="Delete this collection" onClick={() => setConfirming(true)}>
            <Trash2 />
          </Button>
        )
      ) : (
        <span className="w-6" />
      )}
    </li>
  );
}

function BonusPreviewCard({
  verdict,
  byDay,
  dates,
  preview,
  lastPreview,
}: {
  verdict: BoardPayload['bonus'];
  byDay: { points: number; accounts: number }[];
  dates: string[];
  preview: { byPoints: number; byAccounts: number } | null;
  lastPreview: { byPoints: number; byAccounts: number } | null;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {verdict.ok ? verdict.bonus.name : 'Collections bonus'}{' '}
          <span className="text-xs font-normal text-zinc-500">
            {verdict.ok ? `Payment Catalog${verdict.bonus.version ? ` v${verdict.bonus.version}` : ''} · preview only` : 'preview unavailable'}
          </span>
        </h3>
        <span className={cn(TINY_CAPS, 'text-zinc-400')}>per person · nothing is paid from here</span>
      </div>
      {verdict.ok && preview ? (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-orange-100 bg-orange-50/50 p-3 dark:border-orange-950/60 dark:bg-orange-950/15">
              <div className={cn(TINY_CAPS, 'text-orange-700 dark:text-orange-300')}>By points · what HRIS pays today</div>
              <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{fmtPhp(preview.byPoints)}</div>
              <div className="text-[11px] text-zinc-500">Last week {lastPreview ? fmtPhp(lastPreview.byPoints) : '—'}</div>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className={cn(TINY_CAPS, 'text-zinc-500')}>By accounts · if the tier counted accounts</div>
              <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{fmtPhp(preview.byAccounts)}</div>
              <div className="text-[11px] text-zinc-500">Last week {lastPreview ? fmtPhp(lastPreview.byAccounts) : '—'}</div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-zinc-500">
            {DAY_VARIABLES.map((v, i) => (
              <span key={v}>
                {v} {byDay[i] ? `${fmtNum(byDay[i].points)} pts / ${byDay[i].accounts} acct` : '—'}
                <span className="sr-only"> on {dates[i]}</span>
              </span>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            The five day totals still go into the KPI calculator by hand. Whether the tier should count points or
            accounts has not been ruled on, so both are shown.
          </p>
        </>
      ) : (
        <p className="mt-2 text-xs text-zinc-500">{verdict.ok ? '' : verdict.reason}</p>
      )}
    </div>
  );
}
