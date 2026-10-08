'use client';

/**
 * Collections: the log (one line per collected account), the per-rep points table, the podium,
 * the record, and the Dancing Queen preview. The log replaces the sheet's "Collection Count" tab
 * and the hard-coded DATE() formulas that summed it. Each log line carries a "Payment Verified"
 * tick (Carla, 2026-10-02) that saves and shows who ticked it; it lives in its own table, so the
 * append-only log line is never edited.
 *
 * The preview is DISPLAY ONLY. HRIS still pays the bonus from the five day totals typed into the
 * KPI calculator, and whether those should be points or accounts is an open money ruling
 * (Open item 315). So this panel shows both readings and never picks one.
 *
 * Motion (ui-standards § 14): a logged line rises into the log and a deleted one drifts out while
 * the rest close the gap; the podium re-orders by gliding. Totals sweep once when they change (Flash).
 * Movement is gated on useReducedMotion(); the colour sweep is not, because it is the confirmation.
 */

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { BadgeCheck, Crown, Loader2, Medal, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SmoothSelect } from '@/components/ui/smooth-select';
import type { ResolvedSection } from '@/lib/accounting-scoreboard/sections';
import { can } from '@/lib/accounting-scoreboard/roles';
import { datesFor, dayHeader, weekLabel } from '@/lib/accounting-scoreboard/week';
import { collectionsWeekStats, type CollectionEntry } from '@/lib/accounting-scoreboard/scoring';
import { goalLight, weekPace } from '@/lib/accounting-scoreboard/stoplight';
import { MAX_POINTS } from '@/lib/accounting-scoreboard/validate';
import { previewBoth, DAY_VARIABLES } from '@/lib/accounting-scoreboard/bonus-preview';
import type { BoardPayload, BoardRow } from '@/lib/accounting-scoreboard/types';
import {
  DIM,
  EASE_SETTLE,
  EASE_TAB,
  EmptyRows,
  Flash,
  GoalChip,
  LIGHT_STYLE,
  SectionHeader,
  TINY_CAPS,
  fmtNum,
  fmtPhp,
  fmtUsd,
  handle,
} from './shared';

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
  /** Payment Verified: tick or untick one logged collection. */
  onVerify: (id: string, verified: boolean) => Promise<boolean>;
}

const TH = cn(TINY_CAPS, 'whitespace-nowrap px-2 py-2 text-zinc-500 dark:text-zinc-400');
const TD = 'px-2 py-2 align-middle';
const NUM = 'text-right font-mono tabular-nums';
const FIELD_LABEL = cn(TINY_CAPS, 'text-zinc-500 dark:text-zinc-400');
/** The shared Input's focus ring is the theme's neutral ring; here it matches the orange SmoothSelects beside it. */
const FIELD = 'bg-white focus-visible:border-orange-400 focus-visible:ring-orange-500/20 dark:bg-zinc-950 dark:focus-visible:border-orange-700';

const PODIUM = [
  { tone: 'from-amber-400 to-amber-600', Icon: Crown, label: '1st' },
  { tone: 'from-zinc-300 to-zinc-500', Icon: Medal, label: '2nd' },
  { tone: 'from-orange-400 to-orange-700', Icon: Medal, label: '3rd' },
] as const;

export function CollectionsPanel({ section, board, rows, onLog, onDelete, onVerify }: Props) {
  const reduce = useReducedMotion() ?? false;
  const dates = useMemo(() => datesFor(board.weekStart, section.days), [board.weekStart, section.days]);
  const lastDates = useMemo(() => datesFor(board.lastWeekStart, section.days), [board.lastWeekStart, section.days]);
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const week = useMemo(() => collectionsWeekStats(ids, board.collections, dates), [ids, board.collections, dates]);
  const last = useMemo(() => collectionsWeekStats(ids, board.collections, lastDates), [ids, board.collections, lastDates]);
  const labelOf = useMemo(() => new Map(rows.map((r) => [r.id, r.label])), [rows]);
  const liveReps = rows.filter((r) => !r.archived);
  const scope = board.weekStart;

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
  const light = goalLight(section.goal, headline, weekPace(dates, board.today));
  const lastHeadline = last.week.accounts ? last.week.points : null;
  const lastLight = goalLight(section.goal, lastHeadline, 1);
  const [fieldError, setFieldError] = useState<{ field: 'points' | 'amount' | 'business'; message: string } | null>(null);

  /** The same rules the server applies (validate.ts), checked first so the message lands under the right box. */
  function checkFields(): { points: number; amount: number | null } | null {
    if (!business.trim()) {
      setFieldError({ field: 'business', message: 'Type the business name' });
      return null;
    }
    const p = Number(points);
    if (points.trim() === '' || !Number.isInteger(p) || p < 0 || p > MAX_POINTS) {
      setFieldError({ field: 'points', message: `Points are a whole number from 0 to ${MAX_POINTS}, usually 1` });
      return null;
    }
    const a = amount.trim() === '' ? null : Number(amount);
    if (a !== null && (!Number.isFinite(a) || a < 0 || Math.abs(a * 100 - Math.round(a * 100)) > 1e-6)) {
      setFieldError({ field: 'amount', message: 'Dollars and cents, like 94.05' });
      return null;
    }
    setFieldError(null);
    return { points: p, amount: a };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!effectiveRow || !effectiveDate) return;
    const checked = checkFields();
    if (!checked) return;
    const p = checked.points;
    const a = checked.amount;
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
          <GoalChip goal={section.goal} light={light} value={headline} unitFormat={fmtNum} />
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Last week{' '}
            <span className={cn('font-mono tabular-nums', LIGHT_STYLE[lastLight].text)}>{fmtNum(lastHeadline)}</span>
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
        <EmptyRows noun={section.rowNoun} canEditSetup={can(board.viewer.role, 'edit_setup')} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {header}

      {/* Wraps by width: two columns on a phone (business and the button full width), one row at lg. */}
      <form
        onSubmit={submit}
        className="grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-xl border border-orange-100 bg-orange-50/40 p-3 lg:grid-cols-[9rem_minmax(9rem,12rem)_minmax(12rem,1fr)_5.5rem_8rem_auto] lg:items-end dark:border-orange-950/60 dark:bg-orange-950/10"
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
          <span className={FIELD_LABEL}>Rep</span>
          <SmoothSelect
            value={effectiveRow}
            onChange={setRowId}
            options={liveReps.map((r) => ({ value: r.id, label: r.label }))}
            searchable={liveReps.length > 8}
            searchPlaceholder="Find a rep…"
            accent="orange"
            align="start"
            portal
            aria-label="Rep"
            triggerClassName="text-sm"
          />
        </div>
        <label className="col-span-2 grid min-w-0 gap-1 lg:col-span-1">
          <span className={FIELD_LABEL}>Business name</span>
          <Input
            ref={businessRef}
            value={business}
            onChange={(e) => setBusiness(e.target.value)}
            maxLength={200}
            placeholder="e.g. Chocolate Fountain Heaven"
            aria-invalid={fieldError?.field === 'business' || undefined}
            className={FIELD}
          />
        </label>
        <label className="grid min-w-0 gap-1">
          <span className={FIELD_LABEL}>Points</span>
          {/* Whole numbers only (every point ever logged is one). A dot is not even typeable here, so a
              dollar figure cannot land in Points by mistake. */}
          <Input
            value={points}
            inputMode="numeric"
            title="A whole number, usually 1"
            aria-invalid={fieldError?.field === 'points' || undefined}
            onChange={(e) => setPoints(e.target.value.replace(/[^0-9]/g, ''))}
            className={cn(FIELD, 'text-right font-mono tabular-nums')}
          />
        </label>
        <label className="grid min-w-0 gap-1">
          <span className={FIELD_LABEL}>Amount (USD)</span>
          <Input
            value={amount}
            inputMode="decimal"
            placeholder="optional"
            aria-invalid={fieldError?.field === 'amount' || undefined}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            className={cn(FIELD, 'text-right font-mono tabular-nums')}
          />
        </label>
        <Button
          type="submit"
          size="lg"
          disabled={busy || !loggable.length || !effectiveRow || !business.trim()}
          title={!business.trim() ? 'Type the business name first' : undefined}
          className={cn(
            'col-span-2 h-9 bg-gradient-to-r from-orange-500 to-amber-600 text-white shadow-sm shadow-orange-600/20 hover:from-orange-600 hover:to-amber-700 lg:col-span-1',
            // A solid, readable disabled state. The default 50% opacity let the orange gradient smear
            // over the orange-tinted form in dark mode.
            'disabled:bg-none disabled:bg-zinc-200 disabled:text-zinc-500 disabled:opacity-100 disabled:shadow-none dark:disabled:bg-zinc-800 dark:disabled:text-zinc-400',
          )}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          Log collection
        </Button>
        {!loggable.length ? (
          <p className="col-span-2 text-xs text-zinc-500 lg:col-span-6">This week has no day you can log yet.</p>
        ) : null}
        {fieldError ? (
          <p role="alert" className="col-span-2 text-xs font-medium text-rose-600 lg:col-span-6 dark:text-rose-400">
            {fieldError.field === 'business' ? 'Business name' : fieldError.field === 'points' ? 'Points' : 'Amount'}: {fieldError.message}
          </p>
        ) : null}
      </form>

      {week.podium.length ? (
        <div className="flex flex-wrap gap-2">
          <AnimatePresence initial={false}>
            {week.podium.map((p, i) => {
              const { tone, Icon, label } = PODIUM[i];
              return (
                <motion.div
                  key={p.rowId}
                  layout={!reduce}
                  initial={{ opacity: 0, y: reduce ? 0 : 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.12 } }}
                  transition={{ duration: reduce ? 0 : 0.28, ease: EASE_TAB }}
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
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      ) : null}

      <div className="min-w-0 overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="table-keep w-full border-collapse text-sm">
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
              const allTime = board.history.allTimeByRow[r.id];
              return (
                <tr key={r.id} className="transition-colors hover:bg-orange-50/30 dark:hover:bg-zinc-900/40">
                  <td className={cn(TD, 'whitespace-nowrap font-medium text-zinc-800 dark:text-zinc-200')}>
                    {r.label}
                    {r.archived ? <span className={cn(TINY_CAPS, 'ml-1.5 text-[9px] text-zinc-400')}>removed</span> : null}
                  </td>
                  {s.byDay.map((d, i) => (
                    <td key={dates[i]} className={cn(TD, NUM, d.accounts ? 'text-zinc-700 dark:text-zinc-300' : DIM)}>
                      <Flash value={d.accounts ? d.points : null} scope={scope}>
                        {d.accounts ? fmtNum(d.points) : '—'}
                      </Flash>
                    </td>
                  ))}
                  <td className={cn(TD, NUM, 'font-semibold')}>
                    <Flash value={s.week.accounts ? s.week.points : null} scope={scope}>
                      {s.week.accounts ? fmtNum(s.week.points) : <span className={DIM}>—</span>}
                    </Flash>
                  </td>
                  <td className={cn(TD, NUM, DIM)}>{l.week.accounts ? fmtNum(l.week.points) : '—'}</td>
                  <td className={cn(TD, NUM, 'text-zinc-600 dark:text-zinc-400')}>
                    <Flash value={allTime ?? null} scope={scope}>
                      {allTime !== undefined ? fmtNum(allTime) : <span className={DIM}>—</span>}
                    </Flash>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
            <tr>
              <td className={cn(TD, TINY_CAPS, 'whitespace-nowrap text-zinc-500')}>Day total (points)</td>
              {week.byDay.map((d, i) => (
                <td key={dates[i]} className={cn(TD, NUM, 'font-semibold')}>
                  <Flash value={d.accounts ? d.points : null} scope={scope}>
                    {d.accounts ? fmtNum(d.points) : <span className={DIM}>—</span>}
                  </Flash>
                </td>
              ))}
              <td className={cn(TD, NUM, 'font-semibold')}>
                <Flash value={week.week.accounts ? week.week.points : null} scope={scope}>
                  {week.week.accounts ? fmtNum(week.week.points) : <span className={DIM}>—</span>}
                </Flash>
              </td>
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
        scope={scope}
      />

      <div className="space-y-2">
        <h3 className={cn(TINY_CAPS, 'text-zinc-500')}>This week&rsquo;s log ({weekLogs.length})</h3>
        {weekLogs.length ? (
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-zinc-950">
            <AnimatePresence initial={false}>
              {weekLogs.map((c) => (
                <LogLine
                  key={c.id}
                  entry={c}
                  rep={labelOf.get(c.rowId) ?? '—'}
                  canDelete={can(board.viewer.role, 'delete_any_line') || c.createdBy.toLowerCase() === board.viewer.email}
                  canUnverify={can(board.viewer.role, 'unverify_any') || c.verified?.by.toLowerCase() === board.viewer.email}
                  onDelete={onDelete}
                  onVerify={onVerify}
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

function LogLine({
  entry,
  rep,
  canDelete,
  canUnverify,
  onDelete,
  onVerify,
  reduce,
}: {
  entry: CollectionEntry;
  rep: string;
  canDelete: boolean;
  /** Whoever ticked it, or a manager (the server checks the same). */
  canUnverify: boolean;
  onDelete: (id: string) => Promise<boolean>;
  onVerify: (id: string, verified: boolean) => Promise<boolean>;
  reduce: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const verified = entry.verified;
  const lockedOn = verified !== null && !canUnverify;
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
      <span className="min-w-0 flex-1 truncate font-medium text-zinc-800 sm:w-28 sm:flex-none dark:text-zinc-200">{rep}</span>
      {/* On a phone the business gets its own full-width line (it is what people scan for); from sm it sits inline. */}
      {/* The full name always shows: it wraps instead of cutting off (Carla, 2026-10-01: "the text cuts off"). */}
      <span className="order-last w-full min-w-0 break-words text-zinc-700 sm:order-none sm:w-auto sm:flex-1 dark:text-zinc-300">
        {entry.businessName}
      </span>
      <span className="w-14 shrink-0 whitespace-nowrap text-right font-mono tabular-nums">{fmtNum(entry.points)} pt</span>
      {/* Never truncated either: wide enough for $10,000,000.00, the largest amount the log takes. */}
      <span className="shrink-0 whitespace-nowrap text-right font-mono tabular-nums text-zinc-500 sm:min-w-28">
        {fmtUsd(entry.amountUsd)}
      </span>
      <span className="hidden w-24 shrink-0 truncate font-mono text-[11px] text-zinc-400 sm:block" title={entry.createdBy}>
        {handle(entry.createdBy)}
      </span>
      {/* Payment Verified (Carla, 2026-10-02): the tick saves and shows who checked it. */}
      <label
        className={cn(
          'flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors sm:min-w-36',
          verified
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
            : 'border-zinc-200 text-zinc-500 hover:border-orange-200 hover:text-orange-800 dark:border-zinc-800 dark:hover:border-orange-900 dark:hover:text-orange-200',
          lockedOn || verifying ? 'cursor-default' : 'cursor-pointer',
        )}
        title={
          verified
            ? `Payment verified by ${verified.name} (${verified.by})${lockedOn ? '. Only they, or Accounting, can uncheck it.' : ''}`
            : 'Tick once the payment is confirmed'
        }
      >
        <input
          type="checkbox"
          className="size-3.5 accent-emerald-600"
          checked={verified !== null}
          disabled={verifying || lockedOn}
          aria-label={`Payment verified: ${entry.businessName}`}
          onChange={async (e) => {
            setVerifying(true);
            await onVerify(entry.id, e.target.checked);
            setVerifying(false);
          }}
        />
        {verifying ? (
          <Loader2 className="size-3 animate-spin" />
        ) : verified ? (
          <>
            <BadgeCheck className="size-3.5" />
            <span className="max-w-28 truncate">{verified.name}</span>
          </>
        ) : (
          'Payment verified'
        )}
      </label>
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
    </motion.li>
  );
}

function BonusPreviewCard({
  verdict,
  byDay,
  dates,
  preview,
  lastPreview,
  scope,
}: {
  verdict: BoardPayload['bonus'];
  byDay: { points: number; accounts: number }[];
  dates: string[];
  preview: { byPoints: number; byAccounts: number } | null;
  lastPreview: { byPoints: number; byAccounts: number } | null;
  scope: string;
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
              <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                <Flash value={preview.byPoints} scope={scope}>{fmtPhp(preview.byPoints)}</Flash>
              </div>
              <div className="text-[11px] text-orange-900/70 dark:text-orange-200/70">
                Last week {lastPreview ? fmtPhp(lastPreview.byPoints) : '—'}
              </div>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className={cn(TINY_CAPS, 'text-zinc-500')}>By accounts · if the tier counted accounts</div>
              <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                <Flash value={preview.byAccounts} scope={scope}>{fmtPhp(preview.byAccounts)}</Flash>
              </div>
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
