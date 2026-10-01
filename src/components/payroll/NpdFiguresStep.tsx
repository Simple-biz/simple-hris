'use client';

/**
 * Payroll Wizard → Validation → HRIS vs NPD — step 1 of 2, "NPD Figures": the INPUT.
 *
 * Kane, 2026-09-30: *"separate the input from the output please hide the input"*, then
 * *"The NPD Figures lets make this the first step after that it will load the output where
 * we can see the mismatches"*. So the tab is two steps: this one takes the paste, and
 * **Load output** moves to step 2 (`HrisNpdComparison`'s output), where the input is hidden.
 *
 * Rules this step keeps (docs/features/payroll-wizard-hris-vs-npd.md § The paste):
 *   - Every refused line is listed here, with its line number and reason. The output's NPD
 *     summary always carries the skipped count, so hiding the input never hides a refusal.
 *   - It writes nothing. The text is the wizard's week-keyed paste state, parsed live.
 *   - **Load output** needs at least one readable line. There is no output of nothing
 *     ("absence is not zero").
 */

import React from 'react';
import { AlertTriangle, ArrowRight, ClipboardPaste } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { NpdPasteParse } from '@/lib/payroll/hris-npd-compare';

type Props = {
  pasteText: string;
  onPasteChange: (text: string) => void;
  parse: NpdPasteParse;
  /** Rows on the Validation step this week — who NPD will be matched against. */
  hrisPeople: number;
  /** Step 2. Enabled only when at least one line was read. */
  onLoadOutput: () => void;
  /** The full-screen overlay: the box grows into the height instead of a fixed size. */
  fillHeight?: boolean;
};

export default function NpdFiguresStep({ pasteText, onPasteChange, parse, hrisPeople, onLoadOutput, fillHeight = false }: Props) {
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
          <ClipboardPaste className="h-4 w-4" aria-hidden />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">NPD Figures</h3>
          <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
            In the NPD sheet, select from the <strong className="font-semibold text-zinc-800 dark:text-zinc-200">Work Email</strong> column
            across to the <strong className="font-semibold text-zinc-800 dark:text-zinc-200">dollar</strong> column, copy, and paste here.
            The rightmost column is read as the dollar amount, and a person on two lines has them added together.
            The {hrisPeople} {hrisPeople === 1 ? 'person' : 'people'} on this step are matched by work email, and everyone on
            either side gets a row.
          </p>
        </div>
      </div>

      <div className={cn('flex flex-col gap-3 px-4 py-3', fillHeight && 'min-h-0 flex-1 overflow-y-auto')}>
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
        {parse.refusals.length > 0 && (
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
        )}
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          The paste stays with this week until the page is reloaded. Save output, on the output, keeps a copy on file.
        </p>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-100 bg-zinc-50/70 px-4 py-2.5 dark:border-zinc-800/70 dark:bg-zinc-900/40">
        <Button variant="ghost" size="sm" onClick={() => onPasteChange('')} disabled={!hasText} className="text-zinc-500">
          Clear
        </Button>
        <Button
          size="sm"
          onClick={onLoadOutput}
          disabled={!canLoad}
          title={canLoad ? undefined : 'Paste at least one line with a work email and a dollar amount'}
          className="gap-1.5 bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
        >
          Load output
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
