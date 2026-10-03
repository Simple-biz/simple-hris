'use client';

/**
 * Payroll Wizard → Validation → HRIS vs NPD — step 1 of 2, "NPD Figures": the INPUT.
 *
 * Kane, 2026-09-30: *"separate the input from the output please hide the input"*, then
 * *"The NPD Figures lets make this the first step after that it will load the output where
 * we can see the mismatches"*. So the tab is two steps: this one takes the paste, and
 * **Load output** moves to step 2 (`HrisNpdComparison`'s output), where the input is hidden.
 *
 * Kane, 2026-10-02: *"once the values from NPD are both locked from ALL DEPT AND HSL - The
 * values from there will automatically feed here"*. So the input has two sources:
 *   - **NPD's locked sheets**, when Accounting → NPD has BOTH tabs locked in for this week.
 *     This step then shows what was read from them (per tab: version, rows, who locked it and
 *     when) instead of a paste box, and the output opens on its own.
 *   - **The paste**, otherwise. A line above the box says what NPD's lock state is, so it is
 *     clear why nothing loaded on its own.
 *
 * Rules this step keeps (docs/features/payroll-wizard-hris-vs-npd.md § The paste, § NPD's
 * locked sheets feed the step):
 *   - Every refused line is listed here, with its line number (or NPD tab and row) and reason.
 *     The output's NPD summary always carries the skipped count, so hiding the input never
 *     hides a refusal.
 *   - It writes nothing. The paste is the wizard's week-keyed state; the locked sheets are read
 *     through a read-only route.
 *   - **Load output** needs at least one readable line. There is no output of nothing
 *     ("absence is not zero").
 *   - A failed NPD check is an error, never "not locked".
 */

import React from 'react';
import { AlertTriangle, ArrowRight, ClipboardPaste, Loader2, Lock, LockOpen, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { NPD_SHEETS, NPD_SHEET_LABELS } from '@/lib/npd/columns';
import { weekLabel } from '@/lib/npd/sheet';
import type { NpdPasteParse } from '@/lib/payroll/hris-npd-compare';
import type { NpdFeedTabStatus } from '@/lib/payroll/hris-npd-feed';
import type { HrisNpdFeedProps } from '@/components/payroll/HrisNpdComparison';

type Props = {
  pasteText: string;
  onPasteChange: (text: string) => void;
  /** The parse of the NPD text in use: the locked sheets' when they feed the step, else the paste's. */
  parse: NpdPasteParse;
  /** NPD's locked sheets for this week. */
  feed: HrisNpdFeedProps;
  /** Rows on the Validation step this week — who NPD will be matched against. */
  hrisPeople: number;
  /** Step 2. Enabled only when at least one line was read. */
  onLoadOutput: () => void;
  /** The full-screen overlay: the box grows into the height instead of a fixed size. */
  fillHeight?: boolean;
};

function stampLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function tabStateWords(t: NpdFeedTabStatus): string {
  if (t.state === 'locked') return `locked${t.lockedBy ? ` by ${t.lockedBy}` : ''}, ${stampLabel(t.lockedAt)}`;
  if (t.state === 'unlocked') return 'not locked yet';
  return 'nothing saved yet';
}

/** Every line that did not become a row, with where it came from and why. */
function RefusalList({ parse }: { parse: NpdPasteParse }) {
  if (parse.refusals.length === 0) return null;
  return (
    <ul aria-label="Skipped lines" className="max-h-56 shrink-0 overflow-auto rounded-lg border border-rose-200/70 bg-rose-50/60 text-[12px] dark:border-rose-900/40 dark:bg-rose-950/20">
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
  );
}

function RefreshButton({ feed, label = 'Check again' }: { feed: HrisNpdFeedProps; label?: string }) {
  return (
    <button
      type="button"
      onClick={feed.onRefresh}
      disabled={feed.refreshing}
      className="inline-flex shrink-0 items-center gap-1 font-medium text-violet-700 enabled:hover:underline disabled:opacity-60 dark:text-violet-300"
    >
      <RefreshCw className={cn('h-3 w-3', feed.refreshing && 'animate-spin motion-reduce:animate-none')} aria-hidden />
      {feed.refreshing ? 'Checking…' : label}
    </button>
  );
}

/**
 * Above the paste box, while NPD's sheets are NOT the input: what NPD's lock state is for this
 * week, so it is clear why nothing loaded on its own. Neutral for "not locked yet" and for a
 * missing grant (a configuration, not a fault); amber for a failed check.
 */
function NpdLockStatus({ feed }: { feed: HrisNpdFeedProps }) {
  const { view } = feed;
  if (view.state === 'loading') {
    return (
      <div role="status" className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-[12px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
        Checking whether NPD is locked in for this week…
      </div>
    );
  }
  if (view.state === 'error') {
    return (
      <div
        role="status"
        className={cn(
          'flex flex-wrap items-start justify-between gap-2 rounded-lg border px-3 py-2 text-[12px]',
          view.needsGrant
            ? 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300'
            : 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300',
        )}
      >
        <span className="flex min-w-0 items-start gap-2">
          {view.needsGrant ? (
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          <span>{view.needsGrant ? view.message : `Couldn't check NPD's locked sheets: ${view.message} Paste NPD's figures below meanwhile.`}</span>
        </span>
        {!view.needsGrant && <RefreshButton feed={feed} label="Try again" />}
      </div>
    );
  }
  return (
    <div role="status" className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-[12px] text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300">
      <span className="flex min-w-0 items-start gap-2">
        <LockOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden />
        <span className="min-w-0">
          <span>
            NPD for <strong className="font-semibold">{weekLabel(view.week)}</strong>:{' '}
            {NPD_SHEETS.map((s, i) => (
              <React.Fragment key={s}>
                {i > 0 && ' · '}
                {NPD_SHEET_LABELS[s]} <span className={view.tabs[s].state === 'locked' ? 'font-medium text-emerald-700 dark:text-emerald-300' : undefined}>{tabStateWords(view.tabs[s])}</span>
              </React.Fragment>
            ))}
            .
          </span>
          <span className="block text-zinc-500 dark:text-zinc-400">
            Once both are locked in, their figures load here on their own. Until then, paste below.
            {feed.lastError ? ` (The last check failed: ${feed.lastError})` : ''}
          </span>
        </span>
      </span>
      <RefreshButton feed={feed} />
    </div>
  );
}

export default function NpdFiguresStep({ pasteText, onPasteChange, parse, feed, hrisPeople, onLoadOutput, fillHeight = false }: Props) {
  const view = feed.view;
  const fromNpd = view.state === 'ready' && view.feed != null;
  const hasText = pasteText.trim() !== '';
  const canLoad = parse.rows.length > 0;

  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950',
        fillHeight && 'min-h-0 flex-1',
      )}
    >
      <div className="flex shrink-0 items-start gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800/70">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-600/10 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300">
          {fromNpd ? <Lock className="h-4 w-4" aria-hidden /> : <ClipboardPaste className="h-4 w-4" aria-hidden />}
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">
            NPD Figures{fromNpd ? ' · from NPD’s locked sheets' : ''}
          </h3>
          {fromNpd && view.state === 'ready' ? (
            <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              Both NPD tabs are locked in for <strong className="font-semibold text-zinc-800 dark:text-zinc-200">{weekLabel(view.week)}</strong>,
              so their figures are read here on their own: the <strong className="font-semibold text-zinc-800 dark:text-zinc-200">Work Email</strong> and{' '}
              <strong className="font-semibold text-zinc-800 dark:text-zinc-200">PHP USD Conversion</strong> of every row on All Departments and HSL.
              A person on two rows has them added together. The {hrisPeople} {hrisPeople === 1 ? 'person' : 'people'} on this step are matched by
              work email, and everyone on either side gets a row.
            </p>
          ) : (
            <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              In the NPD sheet, select from the <strong className="font-semibold text-zinc-800 dark:text-zinc-200">Work Email</strong> column
              across to the <strong className="font-semibold text-zinc-800 dark:text-zinc-200">dollar</strong> column, copy, and paste here.
              The rightmost column is read as the dollar amount, and a person on two lines has them added together.
              The {hrisPeople} {hrisPeople === 1 ? 'person' : 'people'} on this step are matched by work email, and everyone on
              either side gets a row.
            </p>
          )}
        </div>
      </div>

      <div className={cn('flex flex-col gap-3 px-4 py-3', fillHeight && 'min-h-0 flex-1 overflow-y-auto')}>
        {fromNpd && view.state === 'ready' && view.feed ? (
          <>
            {/* What was read, per tab: the version that was locked, and who locked it when. */}
            <ul aria-label="NPD's locked sheets" className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 text-[12px] dark:divide-zinc-800/70 dark:border-zinc-800">
              {NPD_SHEETS.map((s) => {
                const t = view.tabs[s];
                return (
                  <li key={s} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-3 py-2">
                    <span className="flex items-center gap-2 font-medium text-zinc-800 dark:text-zinc-200">
                      <Lock className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
                      {NPD_SHEET_LABELS[s]}
                      <span className="font-mono text-[11px] font-normal text-zinc-500 dark:text-zinc-400">v{view.feed!.versions[s]}</span>
                    </span>
                    <span className="text-zinc-600 dark:text-zinc-400">
                      {view.feed!.linesBySheet[s]} row{view.feed!.linesBySheet[s] === 1 ? '' : 's'} · {tabStateWords(t)}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[13px]">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  {parse.rows.length} row{parse.rows.length === 1 ? '' : 's'} read
                </span>
                {parse.refusals.length > 0 && (
                  <span className="inline-flex items-center gap-1 font-medium text-rose-700 dark:text-rose-400">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                    {parse.refusals.length} skipped
                  </span>
                )}
              </span>
              <span className="text-[12px]">
                <RefreshButton feed={feed} />
              </span>
            </div>
            {view.feed.usWorkersRows > 0 && (
              <p className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-[12px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
                {view.feed.usWorkersRows} NPD row{view.feed.usWorkersRows === 1 ? ' also has' : 's also have'} <strong className="font-semibold">Total Pay US Workers</strong> filled.
                That column is not compared: NPD&apos;s figure here is PHP USD Conversion, the same column a paste reads.
              </p>
            )}
            {feed.lastError && (
              <p role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>Couldn&apos;t re-check NPD just now ({feed.lastError}). These are the figures read before.</span>
              </p>
            )}
            <RefusalList parse={parse} />
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              Read from NPD, not pasted: it is checked again while this tab is open, and on every reload.
              {feed.checkedAt ? ` Checked ${stampLabel(feed.checkedAt)}.` : ''} Save output, on the output, keeps a copy on file.
            </p>
          </>
        ) : (
          <>
            <NpdLockStatus feed={feed} />
            <textarea
              value={pasteText}
              onChange={(e) => onPasteChange(e.target.value)}
              spellCheck={false}
              rows={10}
              aria-label="NPD work emails and dollar amounts"
              placeholder={'kaner@simple.biz\t250.00\nlorar@simple.biz\t276.49'}
              className={cn(
                'w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2.5 font-mono text-[13px] leading-relaxed text-zinc-900 shadow-sm outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-violet-600 dark:focus:ring-violet-900/40',
                fillHeight && 'min-h-[14rem] flex-1',
              )}
            />
            {hasText && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  {parse.rows.length} line{parse.rows.length === 1 ? '' : 's'} read
                </span>
                {parse.refusals.length > 0 && (
                  <span className="inline-flex items-center gap-1 font-medium text-rose-700 dark:text-rose-400">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                    {parse.refusals.length} skipped
                  </span>
                )}
                {parse.headerSkipped && <span className="text-[12px] text-zinc-500 dark:text-zinc-400">header skipped</span>}
                {parse.mode === 'tsv' && parse.amountColumn != null && (
                  <span className="text-[12px] text-zinc-500 dark:text-zinc-400">dollars read from column {parse.amountColumn + 1}</span>
                )}
              </div>
            )}
            {/* Every refused line, always, whenever there are any: this is where a line that did
                not become a row is accounted for. */}
            <RefusalList parse={parse} />
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              The paste stays with this week until the page is reloaded. Save output, on the output, keeps a copy on file.
            </p>
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-100 bg-zinc-50/70 px-4 py-2.5 dark:border-zinc-800/70 dark:bg-zinc-900/40">
        {fromNpd ? (
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">Unlock a tab in Accounting → NPD to go back to pasting.</span>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => onPasteChange('')} disabled={!hasText} className="text-zinc-500">
            Clear
          </Button>
        )}
        <Button
          size="sm"
          onClick={onLoadOutput}
          disabled={!canLoad}
          title={
            canLoad
              ? undefined
              : fromNpd
                ? 'NPD’s locked sheets have no row with a work email and a dollar amount'
                : 'Paste at least one line with a work email and a dollar amount'
          }
          className="gap-1.5 bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
        >
          Load output
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
