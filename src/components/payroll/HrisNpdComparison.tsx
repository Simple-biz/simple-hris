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
 *   - TWO STEPS, input then output (Kane, 2026-09-30). Step 1, **NPD Figures**
 *     (`NpdFiguresStep`), takes the paste; **Load output** shows step 2, and the input is
 *     hidden there. Step 2 exists only while a line is read. Its rail summary always
 *     carries the skipped count, so a refused line is never out of sight.
 *   - It writes nothing ITSELF. The one write is **Save output** (Kane, 2026-10-01), which
 *     calls the wizard's `save.onSave`: the wizard builds the snapshot from the same
 *     comparison this panel renders and POSTs it to /api/payroll-wizard/npd-comparison
 *     (append-only, service-role tables). Saving restores nothing: the paste still lives in
 *     the wizard's state for the week on screen and is gone on reload.
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

import React, { useDeferredValue, useEffect, useId, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  Check,
  ClipboardPaste,
  Loader2,
  Lock,
  Maximize2,
  PowerOff,
  Save,
  SearchX,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import NpdFiguresStep from '@/components/payroll/NpdFiguresStep';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/contractor-currency';
import { formatPHP } from '@/lib/format-php';
import {
  DEFAULT_MATCH_TOLERANCE_CENTS,
  HRIS_NPD_STATUSES,
  HRIS_SOURCE_LABELS,
  MAX_MATCH_TOLERANCE_CENTS,
  parseToleranceCents,
  centsToDollars,
  filterHrisNpdRows,
  type HrisNpdComparison as Comparison,
  type HrisNpdFilter,
  type HrisNpdHold,
  type HrisNpdLeftOut,
  type HrisNpdRow,
  type HrisNpdStatus,
  type NpdPasteParse,
} from '@/lib/payroll/hris-npd-compare';
import type { HrisNpdSaveMeta } from '@/lib/payroll/hris-npd-snapshot';
import type { NpdFeedTabStatus } from '@/lib/payroll/hris-npd-feed';
import type { NpdSheetKind } from '@/lib/npd/columns';

/**
 * The tab's two steps (Kane, 2026-09-30): `input` = step 1, **NPD Figures** (the paste);
 * `output` = step 2, the comparison, with the input hidden.
 */
export type HrisNpdStep = 'input' | 'output';

/**
 * What the wizard knows about NPD's LOCKED sheets for this week (Kane, 2026-10-02: "once the
 * values from NPD are both locked from ALL DEPT AND HSL - The values from there will
 * automatically feed here"). `ready` with a `feed` = BOTH tabs are locked and their figures
 * ARE the NPD side: the paste box is set aside. `ready` without one = the lock state, and the
 * paste is still the input. A failed check is an error, never "not locked".
 */
export type HrisNpdFeedView =
  | { state: 'loading' }
  | { state: 'error'; message: string; needsGrant: boolean }
  | {
      state: 'ready';
      /** NPD's pay-week Sunday for the wizard's week. */
      week: string;
      tabs: Record<NpdSheetKind, NpdFeedTabStatus>;
      feed: null | {
        versions: Record<NpdSheetKind, number>;
        linesBySheet: Record<NpdSheetKind, number>;
        /** Rows carrying Total Pay US Workers, which is not compared. */
        usWorkersRows: number;
      };
    };

export type HrisNpdFeedProps = {
  view: HrisNpdFeedView;
  /** A re-check is in flight. */
  refreshing: boolean;
  /** A re-check failed; what was read before stays, and this says so beside it. */
  lastError: string | null;
  /** When NPD was last checked (ISO), for the "checked at" line. */
  checkedAt: string | null;
  onRefresh: () => void;
};

/** True while NPD's locked sheets are the NPD figures for this week. */
export function npdFeedIsActive(view: HrisNpdFeedView): boolean {
  return view.state === 'ready' && view.feed != null;
}

/**
 * **Save output** (Kane, 2026-10-01: "save the output for the current week"). The WIZARD
 * owns all of it — the read of the week's newest save, the POST, and why the button is off —
 * and hands it in through `HrisNpdPanelProps`, so the step and full screen show the same.
 */
export type HrisNpdSaveProps = {
  /** The week's newest saved output. A failed read is an error, never "not saved yet". */
  latest:
    | { state: 'loading' }
    | { state: 'ready'; meta: HrisNpdSaveMeta | null }
    | { state: 'error'; message: string; notSetUp: boolean };
  /** Why Save output can't be clicked now (held verdicts, a replay, migration pending), or null. */
  disabledReason: string | null;
  saving: boolean;
  /** The output on screen is exactly what was saved (or confirmed unchanged) this session. */
  savedThisOutput: boolean;
  onSave: () => void;
};

/**
 * Everything the panel shows. The wizard builds ONE of these per render and hands the same
 * object to the step's panel and to the full-screen overlay's (`ValidationFullScreen`), so
 * the two mirror by construction — the rule the Final Pay table's full screen already keeps
 * (payroll-wizard-manual-validation.md § Full screen is a portal).
 */
export type HrisNpdPanelProps = {
  /** The operator's paste — the textarea's text. Set aside while `npdFeed` is active. */
  pasteText: string;
  onPasteChange: (text: string) => void;
  /** The parse of the NPD text the comparison READS: NPD's locked sheets when both are
   *  locked (`npdFeed`), otherwise the paste. */
  parse: NpdPasteParse;
  /** NPD's locked sheets for this week (2026-10-02). */
  npdFeed: HrisNpdFeedProps;
  comparison: Comparison;
  /** This cycle's USD→PHP rate (PHP per $1) — the divisor behind every HRIS dollar figure. */
  fxRate: number;
  /** Rows on the Validation step this week, shown on step 1. */
  hrisPeople: number;
  periodLabel: string | null;
  /**
   * Which step is showing. The WIZARD keeps it, inside the same week-keyed state as the
   * paste, so a new week always starts on step 1 and the step's panel and the overlay's
   * never disagree. `output` shows only while at least one line is read.
   */
  step: HrisNpdStep;
  onStepChange: (next: HrisNpdStep) => void;
  /**
   * How many cents HRIS and NPD may be off by and still match (the output's "off by" box,
   * Kane 2026-09-30). The WIZARD keeps it, so step and overlay agree. Never saved: it starts
   * at `DEFAULT_MATCH_TOLERANCE_CENTS` (3) on every load. The comparison is already built
   * with it; this is only what the box shows.
   */
  toleranceCents: number;
  onToleranceChange: (next: number) => void;
  /** The search and the status chip live in the WIZARD, so opening full screen keeps
   *  them and closing it hands them back — like Final Pay's search. Display only. */
  search: string;
  onSearchChange: (next: string) => void;
  filter: HrisNpdFilter;
  onFilterChange: (next: HrisNpdFilter) => void;
  /** Save output and the week's last save. */
  save: HrisNpdSaveProps;
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

/** The rail, in order. Labels are Kane's words ("NPD Figures … load the output"). */
const STEPS: readonly { key: HrisNpdStep; label: string }[] = [
  { key: 'input', label: 'NPD Figures' },
  { key: 'output', label: 'Output' },
];

/** The step swap: a short directional slide, the house sub-tab motion (ui-standards §11.1). */
const STEP_VARIANTS = {
  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 20 : -20 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir >= 0 ? -20 : 20 }),
};

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
  toleranceCents,
}: {
  r: HrisNpdRow;
  fxRate: number;
  loading: boolean;
  /** The tolerance the verdict was given with (`comparison.toleranceCents`). */
  toleranceCents: number;
}) {
  const tone = r.status === 'match' ? 'match' : r.status == null ? 'held' : 'problem';
  // Ink comes from the row's own ground (ui-standards §15.3), never grey on a tint.
  const sub = tone === 'held' ? 'text-zinc-500 dark:text-zinc-400' : 'opacity-75';

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
        {(r.excludedRowCount > 0 || r.noPayoutRowCount > 0) && (
          <div className="mt-1 flex flex-wrap gap-1">
            {/* Only when the same work email ALSO has a payable row: a person who is
                wholly excluded is not a row at all (they are in the "not compared" list). */}
            {r.excludedRowCount > 0 && (
              <span
                className="whitespace-nowrap rounded-full border border-current/25 bg-white/60 px-1.5 py-px text-[10px] font-semibold dark:bg-black/20"
                title="Excluded on Final Pay (do not pay), so that row is not part of HRIS's figure here"
              >
                {r.excludedRowCount} excluded row{r.excludedRowCount === 1 ? '' : 's'} not counted
              </span>
            )}
            {r.noPayoutRowCount > 0 && (
              <span
                className="whitespace-nowrap rounded-full border border-current/25 bg-white/60 px-1.5 py-px text-[10px] font-semibold dark:bg-black/20"
                title="Payment Dispatch skips this person: there is no payout address on file. The HRIS figure is the Validation step's Gross. The match itself is on the work email."
              >
                No payout this week
              </span>
            )}
          </div>
        )}
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
            <span className="font-semibold">{usd(r.hrisCents)}</span>
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
          // Within the tolerance still counts as a match (Kane, 2026-09-30), but a
          // non-zero difference stays on screen rather than being erased by the green.
          <span
            className="inline-flex flex-col items-center gap-0.5 text-emerald-700 dark:text-emerald-300"
            title={
              r.deltaCents
                ? `Within ${toleranceCents}¢, so counted as a match — NPD is ${usd(Math.abs(r.deltaCents))} ${r.deltaCents > 0 ? 'higher' : 'lower'}`
                : 'HRIS and NPD agree to the cent'
            }
          >
            <Check className="h-4 w-4" strokeWidth={2.75} aria-hidden />
            <span className="sr-only">Match</span>
            {r.deltaCents ? (
              <span className="whitespace-nowrap font-mono text-[10px] font-medium tabular-nums opacity-80">NPD {signedUsd(r.deltaCents)}</span>
            ) : null}
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

// ─── The "off by" box ──────────────────────────────────────────────────────────

/**
 * How many cents HRIS and NPD may be off by and still count as a match. Kane, 2026-09-30:
 * "Lets add a user input at the top please after the load output where the user can set
 * the off by how many cents". The default is 3, his number from the same day.
 *
 * Only a usable value is ever applied (`parseToleranceCents`: whole cents, 0–99). Typing
 * something else marks the box and changes nothing, and leaving the box puts back the value
 * the table is actually using, so the box can never show a number the verdicts don't use.
 */
function ToleranceControl({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  const id = useId();
  const hintId = useId();
  const [draft, setDraft] = useState(String(value));
  // The other mount (step ↔ full screen) or Reset can move the value; follow it.
  useEffect(() => setDraft(String(value)), [value]);
  const invalid = parseToleranceCents(draft) == null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-700 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
      <label htmlFor={id} className="font-medium">
        Count as a match when HRIS and NPD are off by at most
      </label>
      <span className="inline-flex items-center gap-1">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_MATCH_TOLERANCE_CENTS}
          step={1}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            const next = parseToleranceCents(e.target.value);
            if (next != null) onChange(next);
          }}
          onBlur={() => setDraft(String(value))}
          aria-invalid={invalid || undefined}
          aria-describedby={hintId}
          className={cn(
            'h-8 w-16 rounded-md border bg-white px-2 text-right font-mono text-xs tabular-nums text-zinc-900 outline-none transition focus:ring-2 dark:bg-zinc-900 dark:text-zinc-100',
            invalid
              ? 'border-rose-400 focus:ring-rose-200 dark:border-rose-700 dark:focus:ring-rose-900/40'
              : 'border-zinc-300 focus:border-violet-400 focus:ring-violet-200 dark:border-zinc-700 dark:focus:border-violet-600 dark:focus:ring-violet-900/40',
          )}
        />
        <span className="font-medium">¢</span>
      </span>
      <span id={hintId} className={cn('text-[11px]', invalid ? 'text-rose-700 dark:text-rose-400' : 'text-zinc-500 dark:text-zinc-400')}>
        {invalid
          ? `Whole cents from 0 to ${MAX_MATCH_TOLERANCE_CENTS}. Still using ${value}¢`
          : value === 0
            ? 'Only an exact match counts'
            : `Up to ${usd(value)} either way`}
      </span>
      {value !== DEFAULT_MATCH_TOLERANCE_CENTS && (
        <button
          type="button"
          onClick={() => onChange(DEFAULT_MATCH_TOLERANCE_CENTS)}
          className="font-medium text-violet-700 hover:underline dark:text-violet-300"
        >
          Reset to {DEFAULT_MATCH_TOLERANCE_CENTS}¢
        </button>
      )}
    </div>
  );
}

// ─── Save output ───────────────────────────────────────────────────────────────

function savedAtLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Save output (Kane, 2026-10-01). One line: the week's last save on the left — version, who,
 * when, and what it held — and the button on the right. Each save is a NEW version; nothing
 * saved is ever replaced. The button is off, with the reason beside it, while the verdicts
 * are held, on a replay, or before the migration lands; it reads "Saved" once this exact
 * output is the one on file.
 */
function SaveOutputBar({ save }: { save: HrisNpdSaveProps }) {
  const { latest, disabledReason, saving, savedThisOutput, onSave } = save;
  const meta = latest.state === 'ready' ? latest.meta : null;
  const c = meta?.counts;
  const disabled = saving || savedThisOutput || disabledReason != null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-700 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
      <div role="status" className="flex min-w-0 items-start gap-2">
        {latest.state === 'loading' ? (
          <>
            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-zinc-400 motion-reduce:animate-none" aria-hidden />
            <span className="text-zinc-500 dark:text-zinc-400">Checking for a saved output this week…</span>
          </>
        ) : latest.state === 'error' ? (
          <>
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            <span className="text-amber-800 dark:text-amber-300">
              {latest.notSetUp
                ? 'Saving the output is not set up yet: the database migration is pending.'
                : `Couldn't read this week's saved output: ${latest.message}`}
            </span>
          </>
        ) : meta && c ? (
          <>
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" strokeWidth={3} aria-hidden />
            <span className="min-w-0">
              <strong className="font-semibold">Saved v{meta.version}</strong>
              <span className="text-zinc-500 dark:text-zinc-400">
                {' '}by {meta.savedBy}, {savedAtLabel(meta.savedAt)}
              </span>
              <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                {c.match} match · {c.mismatch} mismatch · {c.not_in_hris} not in HRIS · {c.not_in_npd} not in NPD
                {meta.leftOutCount > 0 ? ` · ${meta.leftOutCount} not compared` : ''} · off by {meta.toleranceCents}¢
              </span>
            </span>
          </>
        ) : (
          <>
            <Save className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden />
            <span className="text-zinc-500 dark:text-zinc-400">Not saved yet for this week.</span>
          </>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {disabledReason && !saving && (
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{disabledReason}</span>
        )}
        <Button
          type="button"
          size="sm"
          variant={savedThisOutput ? 'outline' : 'default'}
          className="h-8 shrink-0 gap-1.5 text-xs"
          onClick={onSave}
          disabled={disabled}
          title={disabledReason ?? (savedThisOutput ? 'This output is the one on file.' : 'Save this output as the week’s next version')}
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          ) : savedThisOutput ? (
            <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
          ) : (
            <Save className="h-3.5 w-3.5" aria-hidden />
          )}
          {saving ? 'Saving…' : savedThisOutput ? 'Saved' : 'Save output'}
        </Button>
      </div>
    </div>
  );
}

// ─── Not compared ──────────────────────────────────────────────────────────────

/**
 * People configured not to be paid this week are left out of the comparison (Kane,
 * 2026-09-30). Said out loud here, with who and why, so leaving them out is never silent.
 * Neutral, not amber: a deliberate configuration is not a warning.
 */
function LeftOutNotice({ leftOut }: { leftOut: readonly HrisNpdLeftOut[] }) {
  const [open, setOpen] = useState(false);
  const excluded = leftOut.filter((l) => l.reason === 'excluded').length;
  const paused = leftOut.length - excluded;
  const inNpd = leftOut.filter((l) => l.npdCents != null).length;
  const why = [
    excluded > 0 ? `${excluded} excluded on Final Pay` : null,
    paused > 0 ? `${paused} in a department paused in Step 1 → Configuration` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 items-start gap-2">
          <PowerOff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden />
          <span>
            <strong className="font-semibold">
              {leftOut.length} {leftOut.length === 1 ? 'person' : 'people'} not compared
            </strong>
            , configured not to be paid this week: {why}.{inNpd > 0 ? ` NPD lists ${inNpd} of them.` : ''}
          </span>
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="shrink-0 font-medium text-violet-700 hover:underline dark:text-violet-300"
        >
          {open ? 'Hide' : 'Show who'}
        </button>
      </div>
      {open && (
        <ul aria-label="Not compared" className="mt-2 max-h-48 overflow-auto rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          {leftOut.map((l) => (
            <li
              key={`${l.reason}:${l.workEmail}`}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-b border-zinc-100 px-3 py-1.5 last:border-b-0 dark:border-zinc-800/70"
            >
              <span className="min-w-0">
                <span className="font-mono">{l.workEmail}</span>
                {l.name && <span className="ml-2 text-zinc-500 dark:text-zinc-400">{l.name}</span>}
              </span>
              <span className="flex items-center gap-3 text-[11px]">
                <span className="text-zinc-500 dark:text-zinc-400">
                  {l.reason === 'excluded' ? 'Excluded on Final Pay' : 'Department paused this week'}
                </span>
                <span className="font-mono tabular-nums">{l.npdCents != null ? `NPD ${usd(l.npdCents)}` : 'not in NPD'}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────────

export default function HrisNpdComparison({
  pasteText,
  onPasteChange,
  parse,
  npdFeed,
  comparison,
  fxRate,
  hrisPeople,
  periodLabel,
  step,
  onStepChange,
  toleranceCents,
  onToleranceChange,
  search,
  onSearchChange,
  filter,
  onFilterChange,
  save,
  fillHeight = false,
  onOpenFullScreen,
}: Props) {
  const reduceMotion = useReducedMotion();
  const deferredSearch = useDeferredValue(search);

  const { hold, counts, totals } = comparison;
  // NPD's locked sheets are the input this week (2026-10-02): step 1 shows them, not a paste box.
  const fromNpd = npdFeedIsActive(npdFeed.view);
  // Step 2 exists only while a line is read — there is no output of nothing, so an emptied
  // or unreadable paste always shows step 1.
  const canOutput = parse.rows.length > 0;
  const view: HrisNpdStep = step === 'output' && canOutput ? 'output' : 'input';
  // Which way the panel slides: forward to the output, back to the input.
  const [dir, setDir] = useState(1);
  const goTo = (next: HrisNpdStep) => {
    if (next === view) return;
    setDir(next === 'output' ? 1 : -1);
    onStepChange(next);
  };
  /** Step 1's button: a fresh output, on All with no search, so a new paste is seen whole. */
  const loadOutput = () => {
    onSearchChange('');
    onFilterChange('all');
    goTo('output');
  };
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
    // (or step 1's paste box) grows — everything above it keeps its natural height.
    <div className={cn('flex min-w-0 flex-col gap-4', fillHeight && 'h-full min-h-0')}>
      {/* ── The two steps: 1 NPD Figures (the input) → 2 Output ─────────────────
          The input is hidden on step 2. Its summary stays on step 2's side of the rail and
          always carries the skipped count, so hiding the input never hides a refusal. */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <nav aria-label="HRIS vs NPD steps">
          <ol className="flex items-center gap-2">
            {STEPS.map((s, i) => {
              const active = view === s.key;
              const done = s.key === 'input' && view === 'output';
              const disabled = s.key === 'output' && !canOutput;
              return (
                <li key={s.key} className="flex items-center gap-2">
                  {i > 0 && <span aria-hidden className="h-px w-6 bg-zinc-300 dark:bg-zinc-700" />}
                  <button
                    type="button"
                    onClick={() => goTo(s.key)}
                    disabled={disabled}
                    aria-current={active ? 'step' : undefined}
                    title={
                      disabled
                        ? fromNpd
                          ? 'NPD’s locked sheets have no readable line'
                          : 'Paste at least one readable line on NPD Figures first'
                        : undefined
                    }
                    className={cn(
                      'inline-flex items-center gap-2 rounded-full py-0.5 pr-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                      active
                        ? 'text-violet-700 dark:text-violet-300'
                        : 'text-zinc-500 enabled:hover:text-zinc-800 dark:text-zinc-400 dark:enabled:hover:text-zinc-200',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold',
                        active
                          ? 'bg-violet-600 text-white'
                          : done
                            ? 'bg-emerald-600 text-white'
                            : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
                      )}
                    >
                      {done ? <Check className="h-3 w-3" strokeWidth={3} aria-hidden /> : i + 1}
                    </span>
                    {s.label}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        {view === 'output' && (
          <button
            type="button"
            onClick={() => goTo('input')}
            title={fromNpd ? 'Back to NPD Figures — NPD’s locked sheets' : 'Back to NPD Figures — the input'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            {fromNpd ? (
              <Lock className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" aria-hidden />
            ) : (
              <ClipboardPaste className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" aria-hidden />
            )}
            <span>
              {fromNpd ? 'NPD locked sheets' : 'NPD Figures'} · {parse.rows.length} {fromNpd ? 'row' : 'line'}
              {parse.rows.length === 1 ? '' : 's'} read
            </span>
            {parse.refusals.length > 0 && (
              <span className="rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                {parse.refusals.length} skipped
              </span>
            )}
            <span className="text-violet-700 dark:text-violet-300">{fromNpd ? 'View' : 'Edit'}</span>
          </button>
        )}
      </div>

      {/* The step swap — `overflow-x-clip` (never -hidden) so the 20px slide cannot spawn a page
          scrollbar without becoming a scroll container; `mode="wait"` so input and output never
          overlap mid-swap. */}
      <div className={cn('overflow-x-clip', fillHeight && 'flex min-h-0 flex-1 flex-col')}>
        <AnimatePresence mode="wait" initial={false} custom={dir}>
          <motion.div
            key={view}
            custom={dir}
            variants={STEP_VARIANTS}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: EASE }}
            className={cn('flex min-w-0 flex-col gap-4', fillHeight && 'min-h-0 flex-1')}
          >
      {view === 'input' ? (
        <NpdFiguresStep
          pasteText={pasteText}
          onPasteChange={onPasteChange}
          parse={parse}
          feed={npdFeed}
          hrisPeople={hrisPeople}
          onLoadOutput={loadOutput}
          fillHeight={fillHeight}
        />
      ) : (
        <>
          {/* ── The "off by" box, the rate, the verdict hold, the chips, the search ── */}
          <div className="flex shrink-0 flex-col gap-3">
            {/* At the top of the output, first thing after Load output (Kane, 2026-09-30). */}
            <ToleranceControl value={toleranceCents} onChange={onToleranceChange} />
            {/* Save output (Kane, 2026-10-01), right under the setting it saves with. */}
            <SaveOutputBar save={save} />
            {fxRate > 0 && (
              <p className="text-[12px] text-zinc-600 dark:text-zinc-400">
                HRIS&apos;s dollar figure is what Payment Dispatch will be sent: final pay ÷{' '}
                <span className="font-mono font-semibold text-zinc-800 dark:text-zinc-200">₱{fxRate.toFixed(2)}</span> per $1,
                this cycle&apos;s USD→PHP rate from Step 2. A gap between the two sheets is often this divisor.
              </p>
            )}
            {hold && <HoldBanner hold={hold} />}
            {comparison.leftOut.length > 0 && <LeftOutNotice leftOut={comparison.leftOut} />}

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

            {/* The output's search — full width, directly above the table, like Final Pay's.
                Display only: it never narrows the totals. */}
            <div className="relative">
              <svg
                className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
                fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden
              >
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              <Input
                placeholder="Search the output by email or name…"
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
                      <ComparisonRow key={r.key} r={r} fxRate={fxRate} loading={loading} toleranceCents={comparison.toleranceCents} />
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
                  </tfoot>
                </table>
                </div>
              </div>
            )}
          </div>
        </>
      )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
