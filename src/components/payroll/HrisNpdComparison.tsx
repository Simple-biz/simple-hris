'use client';

/**
 * Payroll Wizard → Validation step (7) → "HRIS vs NPD" tab.
 *
 * Accounting pastes the NPD sheet's work emails and dollar figures; every person is shown
 * once with HRIS's dollar figure beside NPD's: green with a check when they agree to the
 * cent, red with an ✗ (and the difference) when they do not, and red "Not in HRIS" /
 * "Not in NPD" when one side has no one by that address. Nobody is dropped from either side.
 *
 * Rules this panel keeps (docs/features/payroll-wizard-hris-vs-npd.md):
 *   - DISPLAY ONLY. It writes nothing, anywhere: no route, no app_settings key, no audit.
 *     The paste lives in the wizard's state for the week on screen and is gone on reload.
 *   - Every row, count, total and verdict comes from `compareHrisNpd` — this file never
 *     decides a match. The search and the status chips are `filterHrisNpdRows`, and they
 *     never narrow the totals.
 *   - No verdict before the figures can be judged: while `comparison.hold` is set, rows
 *     render uncoloured with "—" in Match, and the banner says why.
 *   - HRIS's figure is the dollar amount Payment Dispatch is sent, and the rate it was
 *     divided by is printed, because an HRIS-vs-NPD gap is an FX question first.
 *   - The full-screen overlay renders THIS component from the SAME `HrisNpdPanelProps`
 *     object as the step; only `fillHeight` differs. The search and chip are the wizard's
 *     state, so both mounts show the same slice.
 */

import React, { useDeferredValue, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Loader2,
  Maximize2,
  SearchX,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/contractor-currency';
import { formatPHP } from '@/lib/format-php';
import {
  HRIS_NPD_STATUSES,
  HRIS_SOURCE_LABELS,
  centsToDollars,
  filterHrisNpdRows,
  type HrisNpdComparison as Comparison,
  type HrisNpdFilter,
  type HrisNpdHold,
  type HrisNpdRow,
  type HrisNpdStatus,
  type NpdPasteParse,
} from '@/lib/payroll/hris-npd-compare';

/**
 * Everything the panel shows. The wizard builds ONE of these per render and hands the same
 * object to the step's panel and to the full-screen overlay's (`ValidationFullScreen`), so
 * the two mirror by construction — the rule the Final Pay table's full screen already keeps
 * (payroll-wizard-manual-validation.md § Full screen is a portal).
 */
export type HrisNpdPanelProps = {
  pasteText: string;
  onPasteChange: (text: string) => void;
  parse: NpdPasteParse;
  comparison: Comparison;
  /** This cycle's USD→PHP rate (PHP per $1) — the divisor behind every HRIS dollar figure. */
  fxRate: number;
  /** Rows on the Validation step this week, for the empty state. */
  hrisPeople: number;
  periodLabel: string | null;
  /** The search and the status chip live in the WIZARD, so opening full screen keeps
   *  them and closing it hands them back — like Final Pay's search. Display only. */
  search: string;
  onSearchChange: (next: string) => void;
  filter: HrisNpdFilter;
  onFilterChange: (next: HrisNpdFilter) => void;
};

type Props = HrisNpdPanelProps & {
  /** Fill the parent instead of capping the table at ~62vh — the full-screen overlay's
   *  `min-h-0 flex-1` box, the same lever `ValidationBreakdownTable` takes. */
  fillHeight?: boolean;
  /** Opens the full-screen overlay. Omitted inside the overlay itself. */
  onOpenFullScreen?: () => void;
};

const STATUS_LABEL: Record<HrisNpdStatus, string> = {
  match: 'Match',
  mismatch: 'Mismatch',
  not_in_hris: 'Not in HRIS',
  not_in_npd: 'Not in NPD',
};

const EASE = [0.22, 1, 0.36, 1] as const;

function usd(cents: number): string {
  return formatMoney(centsToDollars(cents), 'USD');
}

/** "+$2.06" / "−$2.06" — NPD minus HRIS. */
function signedUsd(cents: number): string {
  const s = formatMoney(Math.abs(centsToDollars(cents)), 'USD');
  return cents < 0 ? `−${s}` : `+${s}`;
}

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ─── Row ───────────────────────────────────────────────────────────────────────

const ComparisonRow = React.memo(function ComparisonRow({
  r,
  fxRate,
  loading,
}: {
  r: HrisNpdRow;
  fxRate: number;
  loading: boolean;
}) {
  const tone = r.status === 'match' ? 'match' : r.status == null ? 'held' : 'problem';
  // Ink comes from the row's own ground (ui-standards §15.3), never grey on a tint.
  const sub = tone === 'held' ? 'text-zinc-500 dark:text-zinc-400' : 'opacity-75';
  const fullyExcluded = r.excludedRowCount > 0 && r.excludedRowCount === r.hrisRowCount;

  const mismatchTitle =
    r.status === 'mismatch' && r.hrisCents != null && r.npdCents != null
      ? [
          `NPD ${usd(r.npdCents)} vs HRIS ${usd(r.hrisCents)} — NPD is ${usd(Math.abs(r.deltaCents ?? 0))} ${(r.deltaCents ?? 0) > 0 ? 'higher' : 'lower'}.`,
          r.impliedNpdRate != null && r.hrisPhp != null
            ? `Against HRIS's ${formatPHP(r.hrisPhp)}, NPD's figure implies ₱${r.impliedNpdRate.toFixed(2)} per $1; this cycle's rate is ₱${fxRate.toFixed(2)}.`
            : null,
        ]
          .filter(Boolean)
          .join(' ')
      : undefined;

  return (
    <tr
      className={cn(
        tone === 'match' && 'bg-emerald-100/70 text-emerald-950 dark:bg-emerald-900/30 dark:text-emerald-50',
        tone === 'problem' && 'bg-rose-100/70 text-rose-950 dark:bg-rose-900/30 dark:text-rose-50',
        tone === 'held' && 'text-zinc-800 dark:text-zinc-200',
      )}
    >
      <td className="px-3 py-2 align-top">
        <div className="truncate font-mono text-xs font-medium" title={r.workEmail}>{r.workEmail}</div>
        {r.name && <div className={cn('truncate text-[11px]', sub)}>{r.name}</div>}
        {r.npdAliases.length > 0 && (
          <div className={cn('truncate font-mono text-[10px]', sub)} title={r.npdAliases.join(', ')}>
            NPD: {r.npdAliases.join(', ')}
          </div>
        )}
        {(r.excludedRowCount > 0 || r.noPayoutRowCount > 0) && (
          <div className="mt-1 flex flex-wrap gap-1">
            {r.excludedRowCount > 0 && (
              <span className="whitespace-nowrap rounded-full border border-current/25 bg-white/60 px-1.5 py-px text-[10px] font-semibold dark:bg-black/20">
                {fullyExcluded ? 'Excluded from pay' : `${r.excludedRowCount} of ${r.hrisRowCount} excluded`}
              </span>
            )}
            {r.noPayoutRowCount > 0 && (
              <span
                className="whitespace-nowrap rounded-full border border-current/25 bg-white/60 px-1.5 py-px text-[10px] font-semibold dark:bg-black/20"
                title="No personal email on file, so the pay run skips this person — the figure is the Validation step's Gross"
              >
                No payout · no personal email
              </span>
            )}
          </div>
        )}
        {r.note && <div className={cn('mt-1 text-[10px] leading-snug', sub)}>{r.note}</div>}
      </td>

      <td className="px-3 py-2 text-right align-top font-mono text-xs tabular-nums">
        {!r.inHris ? (
          <span className={sub}>—</span>
        ) : loading ? (
          <span className="skeleton-shimmer ml-auto block h-3 w-16 rounded" aria-label="Loading" />
        ) : r.hrisCents == null ? (
          <span className={sub} title="Set this cycle's USD→PHP rate on Step 2">—</span>
        ) : (
          <>
            <span className={cn('font-semibold', fullyExcluded && 'line-through decoration-1')}>{usd(r.hrisCents)}</span>
            {r.hrisRowCount > 1 && <div className={cn('text-[10px] font-sans', sub)}>{r.hrisRowCount} HRIS rows added</div>}
          </>
        )}
      </td>

      <td className="px-3 py-2 text-right align-top font-mono text-xs tabular-nums">
        {r.npdCents == null ? (
          <span className={sub}>—</span>
        ) : (
          <>
            <span className="font-semibold">{usd(r.npdCents)}</span>
            {r.npdLines.length > 1 && (
              <div className={cn('text-[10px] font-sans', sub)} title={`Paste lines ${r.npdLines.join(', ')}`}>
                {r.npdLines.length} lines added
              </div>
            )}
          </>
        )}
      </td>

      <td className="px-3 py-2 text-center align-top">
        {r.status == null ? (
          <span className="text-zinc-400 dark:text-zinc-500" aria-label="Not judged yet">—</span>
        ) : r.status === 'match' ? (
          <span className="inline-flex text-emerald-700 dark:text-emerald-300" title="HRIS and NPD agree to the cent">
            <Check className="h-4 w-4" strokeWidth={2.75} aria-hidden />
            <span className="sr-only">Match</span>
          </span>
        ) : r.status === 'mismatch' ? (
          <span className="inline-flex flex-col items-center gap-0.5 text-rose-700 dark:text-rose-300" title={mismatchTitle}>
            <X className="h-4 w-4" strokeWidth={2.75} aria-hidden />
            <span className="sr-only">Mismatch</span>
            {r.deltaCents != null && (
              <span className="whitespace-nowrap font-mono text-[10px] font-semibold tabular-nums">NPD {signedUsd(r.deltaCents)}</span>
            )}
          </span>
        ) : (
          <span className="whitespace-nowrap text-[11px] font-bold text-rose-700 dark:text-rose-300">{STATUS_LABEL[r.status]}</span>
        )}
      </td>
    </tr>
  );
});

// ─── Hold banner ───────────────────────────────────────────────────────────────

function HoldBanner({ hold }: { hold: HrisNpdHold }) {
  if (hold.kind === 'no_npd_rows') return null;
  if (hold.kind === 'loading') {
    // Still in flight is not a warning (ui-standards §12.3), so this is neutral, not amber.
    return (
      <div role="status" className="flex items-start gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300">
        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
        <span>Reading this week&apos;s pay. Rows are marked once every figure behind HRIS&apos;s dollar amount has landed.</span>
      </div>
    );
  }
  const text =
    hold.kind === 'unavailable'
      ? `Couldn't load ${listWords(hold.sources.map((s) => HRIS_SOURCE_LABELS[s])) || 'part of this week’s pay'}, so HRIS's figures may be missing money and no row is marked. Reload the wizard to try again.`
      : "This cycle's USD→PHP rate is still 0. HRIS's dollar figures are its pay ÷ that rate, so no row is marked until it is set on Step 2 (Initial Calculation).";
  return (
    <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{text}</span>
    </div>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────────

export default function HrisNpdComparison({
  pasteText,
  onPasteChange,
  parse,
  comparison,
  fxRate,
  hrisPeople,
  periodLabel,
  search,
  onSearchChange,
  filter,
  onFilterChange,
  fillHeight = false,
  onOpenFullScreen,
}: Props) {
  const reduceMotion = useReducedMotion();
  const [pasteOpen, setPasteOpen] = useState(() => pasteText.trim() === '');
  const [showSkipped, setShowSkipped] = useState(false);
  const deferredSearch = useDeferredValue(search);

  const hasText = pasteText.trim() !== '';
  const expanded = pasteOpen || !hasText;
  const { hold, counts, totals } = comparison;
  const judged = counts != null;
  // A status chip means nothing while verdicts are held, so the table falls back to All.
  const activeFilter: HrisNpdFilter = judged ? filter : 'all';

  const visible = useMemo(
    () => filterHrisNpdRows(comparison.rows, { needle: deferredSearch, status: activeFilter }),
    [comparison.rows, deferredSearch, activeFilter],
  );
  const loading = hold?.kind === 'loading';
  const narrowed = visible.length !== comparison.rows.length;

  const chips: HrisNpdFilter[] = ['all', ...HRIS_NPD_STATUSES];

  return (
    // `fillHeight` (the full-screen overlay): the column fills its box and only the table
    // grows — everything above it keeps its natural height.
    <div className={cn('flex min-w-0 flex-col gap-4', fillHeight && 'h-full min-h-0')}>
      {/* ── The paste ─────────────────────────────────────────────────────────── */}
      <div className="shrink-0 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <button
          type="button"
          onClick={() => hasText && setPasteOpen((v) => !v)}
          aria-expanded={expanded}
          aria-controls="hris-npd-paste"
          disabled={!hasText}
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors enabled:hover:bg-violet-50/50 disabled:cursor-default dark:enabled:hover:bg-violet-950/15"
        >
          <ClipboardPaste className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-100">NPD figures</span>
            <span className="block truncate text-[12px] text-zinc-600 dark:text-zinc-400">
              {hasText
                ? `${parse.rows.length} line${parse.rows.length === 1 ? '' : 's'} read${parse.refusals.length > 0 ? ` · ${parse.refusals.length} skipped` : ''}${parse.headerSkipped ? ' · header skipped' : ''}`
                : 'Work email and dollar amount, straight from the NPD sheet'}
            </span>
          </span>
          {hasText && (expanded
            ? <ChevronUp className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
            : <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />)}
        </button>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              key="hris-npd-paste"
              id="hris-npd-paste"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
              animate={reduceMotion ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={{ duration: reduceMotion ? 0.12 : 0.24, ease: EASE }}
              className="overflow-hidden"
            >
              <div className="flex flex-col gap-3 border-t border-zinc-100 px-4 pb-4 pt-3 dark:border-zinc-800/70">
                <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                  In the NPD sheet, select from the <strong className="font-semibold text-zinc-800 dark:text-zinc-200">Work Email</strong> column
                  across to the <strong className="font-semibold text-zinc-800 dark:text-zinc-200">dollar</strong> column, copy, and paste here.
                  The rightmost column is read as the dollar amount. A person on two lines has them added together.
                  Nothing is saved: the paste stays with this week until the page is reloaded.
                </p>
                <textarea
                  value={pasteText}
                  onChange={(e) => onPasteChange(e.target.value)}
                  spellCheck={false}
                  rows={7}
                  aria-label="NPD work emails and dollar amounts"
                  placeholder={'kaner@simple.biz\t250.00\nlorar@simple.biz\t276.49'}
                  className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2.5 font-mono text-[13px] leading-relaxed text-zinc-900 shadow-sm outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-violet-600 dark:focus:ring-violet-900/40"
                />
                {hasText && (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">
                      {parse.rows.length} line{parse.rows.length === 1 ? '' : 's'} read
                    </span>
                    {parse.refusals.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowSkipped((v) => !v)}
                        aria-expanded={showSkipped}
                        className="inline-flex items-center gap-1 font-medium text-rose-700 underline-offset-2 hover:underline dark:text-rose-400"
                      >
                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                        {parse.refusals.length} skipped
                        {showSkipped ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
                      </button>
                    )}
                    {parse.mode === 'tsv' && parse.amountColumn != null && (
                      <span className="text-[12px] text-zinc-500 dark:text-zinc-400">dollars read from column {parse.amountColumn + 1}</span>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => { onPasteChange(''); setPasteOpen(true); onFilterChange('all'); }} className="text-zinc-500">
                    Clear
                  </Button>
                </div>
                )}
                {showSkipped && parse.refusals.length > 0 && (
                  <ul className="max-h-48 overflow-auto rounded-lg border border-rose-200/70 bg-rose-50/60 text-[12px] dark:border-rose-900/40 dark:bg-rose-950/20">
                    {parse.refusals.map((f) => (
                      <li key={f.line} className="flex gap-2 border-b border-rose-200/50 px-3 py-1.5 last:border-b-0 dark:border-rose-900/30">
                        <span className="shrink-0 font-mono font-semibold text-rose-800 dark:text-rose-300">L{f.line}</span>
                        <span className="min-w-0 flex-1 text-rose-900 dark:text-rose-200">
                          {f.reason}
                          <span className="block truncate font-mono text-[11px] opacity-70">{f.raw.replace(/\t/g, ' ⇥ ')}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {hold?.kind === 'no_npd_rows' ? (
        <div className="flex shrink-0 flex-col items-center rounded-xl border border-dashed border-zinc-300 bg-white/50 px-6 py-10 text-center dark:border-zinc-700 dark:bg-zinc-950/25">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-600/10 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300">
            <ClipboardPaste className="h-5 w-5" aria-hidden />
          </div>
          <h4 className="text-sm font-semibold text-zinc-900 dark:text-white">
            {hasText ? 'None of the pasted lines could be read' : "Paste NPD's figures to compare"}
          </h4>
          <p className="mt-1 max-w-md text-xs text-zinc-500 dark:text-zinc-400">
            {hasText
              ? 'Open the skipped lines above to see why each one was refused.'
              : `The ${hrisPeople} ${hrisPeople === 1 ? 'person' : 'people'} on this step will be matched to NPD by work email, and everyone on either side gets a row.`}
          </p>
        </div>
      ) : (
        <>
          {/* ── The rate, the verdict hold, the chips ───────────────────────────── */}
          <div className="flex shrink-0 flex-col gap-3">
            {fxRate > 0 && (
              <p className="text-[12px] text-zinc-600 dark:text-zinc-400">
                HRIS&apos;s dollar figure is what Payment Dispatch will be sent: final pay ÷{' '}
                <span className="font-mono font-semibold text-zinc-800 dark:text-zinc-200">₱{fxRate.toFixed(2)}</span> per $1,
                this cycle&apos;s USD→PHP rate from Step 2. A gap between the two sheets is often this divisor.
              </p>
            )}
            {hold && <HoldBanner hold={hold} />}

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div role="group" aria-label="Show rows" className="flex flex-wrap items-center gap-1.5">
                {chips.map((f) => {
                  const active = activeFilter === f;
                  const n = f === 'all' ? comparison.rows.length : counts?.[f];
                  const disabled = f !== 'all' && !judged;
                  const good = f === 'match';
                  const bad = f !== 'all' && f !== 'match';
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => onFilterChange(f)}
                      aria-pressed={active}
                      disabled={disabled}
                      className={cn(
                        'relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                        active
                          ? 'text-white'
                          : 'text-zinc-600 enabled:hover:bg-zinc-100 enabled:hover:text-zinc-900 dark:text-zinc-400 dark:enabled:hover:bg-zinc-800 dark:enabled:hover:text-zinc-100',
                      )}
                    >
                      {active && (
                        <motion.span
                          layoutId="hris-npd-filter"
                          className={cn(
                            'absolute inset-0 rounded-md',
                            good ? 'bg-emerald-600' : bad ? 'bg-rose-600' : 'bg-violet-600',
                          )}
                          transition={{ duration: reduceMotion ? 0 : 0.28, ease: EASE }}
                        />
                      )}
                      <span className="relative">{f === 'all' ? 'All' : STATUS_LABEL[f]}</span>
                      {n != null && (
                        <span
                          className={cn(
                            'relative rounded-full px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none tabular-nums',
                            active ? 'bg-white/25 text-white' : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
                          )}
                        >
                          {n}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="relative sm:w-72">
                <svg
                  className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
                  fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden
                >
                  <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                </svg>
                <Input
                  placeholder="Search by email or name…"
                  value={search}
                  onChange={(e) => onSearchChange(e.target.value)}
                  aria-label="Search HRIS vs NPD"
                  className="h-9 rounded-lg border-zinc-200 bg-white pl-8 pr-8 text-xs shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => onSearchChange('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                    aria-label="Clear search"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ── The table ───────────────────────────────────────────────────────── */}
          <div
            className={cn(
              'overflow-hidden rounded-xl border border-zinc-200 bg-white/50 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/25',
              fillHeight && 'flex min-h-0 flex-1 flex-col',
            )}
          >
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50/90 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/50">
              <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                HRIS vs NPD
                {narrowed && (
                  <span className="ml-1 font-normal text-zinc-500 dark:text-zinc-400">
                    — showing {visible.length} of {comparison.rows.length}
                  </span>
                )}
              </span>
              <span className="flex min-w-0 items-center gap-2">
                {/* The overlay's header already names the week. */}
                {periodLabel && !fillHeight && (
                  <span className="max-w-full truncate font-mono text-[10px] text-zinc-500 dark:text-zinc-400">{periodLabel}</span>
                )}
                {/* The same button, in the same place, as the Final Pay table's. */}
                {onOpenFullScreen && (
                  <button
                    type="button"
                    onClick={onOpenFullScreen}
                    title="Open this table full screen"
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[10px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                  >
                    <Maximize2 className="h-3 w-3" aria-hidden />
                    Full screen
                  </button>
                )}
              </span>
            </div>

            {visible.length === 0 ? (
              <div className={cn('flex flex-col items-center px-6 py-10 text-center', fillHeight && 'flex-1 justify-center')}>
                <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  <SearchX className="h-5 w-5" aria-hidden />
                </div>
                <h4 className="text-sm font-semibold text-zinc-900 dark:text-white">No rows match</h4>
                {deferredSearch.trim() && (
                  <span className="mt-1 rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    {deferredSearch.trim()}
                  </span>
                )}
                <Button variant="outline" size="sm" className="mt-3 h-7 text-xs" onClick={() => { onSearchChange(''); onFilterChange('all'); }}>
                  Show every row
                </Button>
              </div>
            ) : (
              // `relative` so the sr-only labels (absolutely positioned) are clipped by this
              // scroller too — unpositioned, they escape it from the off-screen Match
              // column and widen the whole page on a phone.
              <div
                className={cn('relative overflow-auto [scrollbar-gutter:stable]', fillHeight && 'min-h-0 flex-1')}
                style={fillHeight ? undefined : { maxHeight: 'min(62vh, calc(100dvh - 24rem))' }}
              >
                {/* The minimum width sits on a wrapper, never on the table: browsers ignore
                    `min-width` on a fixed-layout table, which then shrinks to a phone's
                    width and the three fixed columns crush Work Email to nothing.
                    `table-keep` opts out of the site-wide <640px card stack
                    (src/index.css), which would paint every row the card colour — the
                    green / red IS the answer here, and HRIS beside NPD is the point. */}
                <div className="min-w-[560px]">
                <table className="table-keep w-full table-fixed text-xs">
                  <caption className="sr-only">
                    HRIS and NPD dollar figures by work email{periodLabel ? `, ${periodLabel}` : ''}
                  </caption>
                  <colgroup>
                    <col />
                    <col className="w-32" />
                    <col className="w-32" />
                    <col className="w-28" />
                  </colgroup>
                  <thead className="sticky top-0 z-10 bg-zinc-100/95 shadow-[0_1px_0_0_rgb(228_228_231)] dark:bg-zinc-900/95 dark:shadow-[0_1px_0_0_rgb(39_39_42)]">
                    <tr>
                      <th scope="col" className="px-3 py-2 text-left text-[11px] font-medium text-zinc-600 dark:text-zinc-400">Work Email</th>
                      <th scope="col" className="px-3 py-2 text-right text-[11px] font-medium text-zinc-600 dark:text-zinc-400">HRIS</th>
                      <th scope="col" className="px-3 py-2 text-right text-[11px] font-medium text-zinc-600 dark:text-zinc-400">NPD</th>
                      <th scope="col" className="px-3 py-2 text-center text-[11px] font-medium text-zinc-600 dark:text-zinc-400">Match?</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200/70 dark:divide-zinc-800/70">
                    {visible.map((r) => (
                      <ComparisonRow key={r.key} r={r} fxRate={fxRate} loading={loading} />
                    ))}
                  </tbody>
                  {/* Whole-comparison totals: a search or a chip never changes them
                      (a total that follows a filter gets read out as the week's). Sticky,
                      so the two sheets' totals stay in view down a 1,000-row list; the
                      rule above it is a shadow because collapsed borders do not travel
                      with a sticky row. */}
                  <tfoot className="sticky bottom-0 z-10 bg-zinc-100 shadow-[0_-2px_0_0_rgb(212_212_216)] dark:bg-zinc-900 dark:shadow-[0_-2px_0_0_rgb(63_63_70)]">
                    <tr>
                      <td className="px-3 py-2.5 text-xs font-bold text-zinc-700 dark:text-zinc-300">
                        Totals · {totals.people} {totals.people === 1 ? 'person' : 'people'}
                        {narrowed && <span className="ml-1 font-normal text-zinc-500 dark:text-zinc-400">(every row, not just those shown)</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs font-bold tabular-nums text-zinc-800 dark:text-zinc-200">
                        {/* Same rule as the rows: a total over figures still landing is not shown. */}
                        {loading
                          ? <span className="skeleton-shimmer ml-auto block h-3 w-20 rounded" aria-label="Loading" />
                          : totals.hrisCents == null ? '—' : usd(totals.hrisCents)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs font-bold tabular-nums text-zinc-800 dark:text-zinc-200">
                        {usd(totals.npdCents)}
                      </td>
                      <td className="px-3 py-2.5 text-center font-mono text-[10px] font-semibold tabular-nums text-zinc-600 dark:text-zinc-400">
                        {loading || totals.hrisCents == null
                          ? ''
                          : totals.npdCents === totals.hrisCents
                            ? 'equal'
                            : `NPD ${signedUsd(totals.npdCents - totals.hrisCents)}`}
                      </td>
                    </tr>
                    {totals.excludedHrisCents > 0 && (
                      <tr>
                        <td colSpan={4} className="px-3 pb-2.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                          HRIS&apos;s total includes {usd(totals.excludedHrisCents)} for people excluded from pay this week.
                        </td>
                      </tr>
                    )}
                  </tfoot>
                </table>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
