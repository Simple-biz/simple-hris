// src/components/payroll/ValidationBreakdownTable.tsx
'use client';

import React, { useState } from 'react';
import { AlertTriangle, ChevronRight, Ban, BadgeCheck, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatPHP } from '@/lib/format-php';
import type { PayrollBreakdown, ValidationFlag } from '@/lib/payroll/validation-breakdown';
import {
  MV_NOTE_MAX_LEN,
  validationFor,
  type ManualValidation,
  type ManualValidationMap,
} from '@/lib/payroll/manual-validation';

type Props = {
  rows: PayrollBreakdown[];
  deptName: string;
  /** Drives the column set: HSL shows the sheet's M-F / WE / OT½ form. */
  isHsl: boolean;
  disabled: boolean;
  onToggleExcluded: (email: string) => void;
  onToggleAllExcluded: (emails: string[], next: boolean) => void;
  /**
   * Manual validation ("MV") — who has hand-checked which row this cycle, keyed
   * by lowercased work email. An absent key means "not validated"; there is no
   * falsy record for the unticked state.
   */
  validations?: ManualValidationMap;
  /**
   * Ticking MV. Omitted ⇒ the column renders read-only, which is what a replay
   * of a past week wants: the record of who validated it then is history, and
   * offering a checkbox would invite writing into a closed week.
   */
  onToggleValidated?: (email: string, next: boolean, note: string | null) => void;
  /** Emails with an MV write in flight, so the cell can show it is saving. */
  savingValidations?: ReadonlySet<string>;
  /**
   * Fill the parent instead of capping at ~62vh. The inline step-6 validation table sits in
   * a page that scrolls, so it caps its own height; the full-screen mirror is
   * already inside a `min-h-0 flex-1` box and must fill it, or the viewport
   * shows a short table with dead space under it.
   */
  fillHeight?: boolean;
};

const H = 'px-2 py-2 text-right text-[11px] font-medium text-zinc-600 dark:text-zinc-400';
const GROUP =
  'px-2 py-1 text-center text-[9px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500';
const CELL = 'px-2 py-2.5 text-right font-mono text-xs tabular-nums';

function money(n: number, dim = false): React.ReactNode {
  if (n === 0) return <span className="text-zinc-300 dark:text-zinc-600">—</span>;
  return <span className={dim ? 'text-zinc-600 dark:text-zinc-400' : undefined}>{formatPHP(n)}</span>;
}

function hrs(n: number): React.ReactNode {
  if (n === 0) return <span className="text-zinc-300 dark:text-zinc-600">—</span>;
  return <>{n.toFixed(2)}</>;
}

/** Renders `− ₱100.00` for negatives instead of formatPHP's `₱-100.00`. Shared by
 *  the main row's MESA cell and WorkedTotal so the two cannot drift apart again. */
function signedMoney(n: number): React.ReactNode {
  return n < 0 ? <>− {formatPHP(Math.abs(n))}</> : <>{formatPHP(n)}</>;
}

function FlagList({ flags }: { flags: ValidationFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-1">
      {flags.map((f) => (
        <div
          key={f.code}
          className={cn(
            'flex items-start gap-1.5 text-[10px] leading-snug',
            f.severity === 'red'
              ? 'text-rose-700 dark:text-rose-300'
              : 'text-amber-700 dark:text-amber-300',
          )}
        >
          {f.severity === 'red' ? (
            <Ban className="mt-px h-3 w-3 shrink-0" />
          ) : (
            <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          )}
          <span>{f.message}</span>
        </div>
      ))}
    </div>
  );
}

/** `2026-08-21 14:32` in the reader's locale — short, sortable-looking, no seconds. */
function shortStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** The `by · at · note` line, used in the cell tooltip and the expanded row. */
function validationSummary(v: ManualValidation): string {
  const head = `Manually validated by ${v.by} on ${shortStamp(v.at)}`;
  return v.note ? `${head} — “${v.note}”` : head;
}

/**
 * One row's MV cell.
 *
 * Ticking asks for a note and does NOT require one — Kane's rule. So the prompt
 * has two ways out that both validate ("Save" and "Skip") and only one that does
 * not (dismiss), rather than a disabled-until-typed Save. Un-ticking is
 * immediate: withdrawing a vouch should never be behind a form.
 *
 * The popover is absolutely positioned inside the cell rather than portalled,
 * because the table body is the scroll container — a portalled panel would stay
 * put while the row it belongs to scrolled away underneath it.
 */
function MvCell({
  row, validation, saving, disabled, onToggle,
}: {
  row: PayrollBreakdown;
  validation: ManualValidation | null;
  saving: boolean;
  disabled: boolean;
  onToggle?: (email: string, next: boolean, note: string | null) => void;
}) {
  const [prompting, setPrompting] = useState(false);
  const [draft, setDraft] = useState('');
  const readOnly = disabled || !onToggle;
  const who = row.name || row.email;

  const commit = (note: string | null) => {
    onToggle?.(row.email, true, note);
    setPrompting(false);
    setDraft('');
  };

  return (
    <td className="relative px-2 py-2.5 text-center align-top">
      {saving ? (
        <Loader2 className="mx-auto h-4 w-4 animate-spin text-zinc-400" aria-label="Saving validation" />
      ) : (
        <input
          type="checkbox"
          checked={validation != null}
          onChange={() => {
            if (readOnly) return;
            if (validation != null) onToggle?.(row.email, false, null);
            else setPrompting(true);
          }}
          disabled={readOnly}
          aria-label={
            validation
              ? `${validationSummary(validation)}. Clear the manual validation for ${who}.`
              : `Mark ${who}'s pay as manually validated`
          }
          title={validation ? validationSummary(validation) : 'Not manually validated'}
          className="h-4 w-4 cursor-pointer rounded border-zinc-300 accent-emerald-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600"
        />
      )}

      {validation && !saving && (
        <BadgeCheck
          className="mx-auto mt-1 h-3 w-3 text-emerald-600 dark:text-emerald-400"
          aria-hidden
        />
      )}

      {prompting && (
        <div
          className="absolute right-1 top-8 z-30 w-64 rounded-lg border border-zinc-200 bg-white p-2.5 text-left shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
          role="dialog"
          aria-label={`Add a note for ${who}`}
        >
          <p className="mb-1.5 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
            Note (optional)
          </p>
          <textarea
            autoFocus
            value={draft}
            maxLength={MV_NOTE_MAX_LEN}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setPrompting(false); setDraft(''); }
              // Enter saves; Shift+Enter keeps a newline, since a note may be a
              // sentence or two.
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(draft); }
            }}
            rows={3}
            placeholder="What did you check?"
            className="w-full resize-none rounded border border-zinc-200 bg-white px-2 py-1.5 text-[11px] text-zinc-800 outline-none focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
          />
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => { setPrompting(false); setDraft(''); }}
              className="rounded px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              Cancel
            </button>
            {/* Skip and Save both validate. The note is genuinely optional, so
                there is no state where the operator is stuck. */}
            <button
              type="button"
              onClick={() => commit(null)}
              className="rounded px-2 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={() => commit(draft)}
              className="rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-500"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </td>
  );
}

/** The worked calculation, shown when a row is expanded. */
function WorkedTotal({ r, validation }: { r: PayrollBreakdown; validation: ManualValidation | null }) {
  const lines: Array<[string, string, number]> = [];
  if (r.isHsl && r.rates?.we != null) {
    lines.push(['M-F', `${r.hours.mf.toFixed(2)} h × ${formatPHP(r.rates.mf)}`, r.earnings.base]);
    if (r.hours.we > 0)
      lines.push(['Weekend', `${r.hours.we.toFixed(2)} h × ${formatPHP(r.rates.we)}`, r.earnings.weekend]);
    if (r.hours.ot > 0 && r.rates.otDifferential != null)
      lines.push(['OT ½', `${r.hours.ot.toFixed(2)} h × ${formatPHP(r.rates.otDifferential)}`, r.earnings.otPay]);
  } else {
    lines.push(['Regular', r.rates ? `${r.hours.mf.toFixed(2)} h × ${formatPHP(r.rates.mf)}` : '—', r.earnings.base]);
    if (r.hours.ot > 0)
      lines.push(['Overtime', r.rates?.ot != null ? `${r.hours.ot.toFixed(2)} h × ${formatPHP(r.rates.ot)}` : '—', r.earnings.otPay]);
  }
  const { kpi, pab, tech, other } = r.earnings.bonusParts;
  if (kpi) lines.push(['KPI / performance', '', kpi]);
  if (pab) lines.push(['Perfect attendance', '', pab]);
  if (tech) lines.push(['Tech bonus', '', tech]);
  if (other) lines.push(['Other bonuses', '', other]);
  // Adjustment is listed UNCONDITIONALLY, unlike every other optional line here.
  // It is the one figure an operator comes to this panel to confirm the absence
  // of: it originates on the Payroll Notes board, so "no adjustment" and "an
  // adjustment I can't see" look identical when the line is simply missing.
  // Read-only — the Notes board is where it is set (see payroll-wizard-notes.md).
  lines.push([
    'Adjustment',
    r.adjustments.adjustment === 0 ? 'none on the Notes board' : 'from the Notes board',
    r.adjustments.adjustment,
  ]);
  if (r.adjustments.orphanage) lines.push(['Orphanage', '', r.adjustments.orphanage]);
  if (r.adjustments.mesaDisbursement) lines.push(['MESA disbursement', '', r.adjustments.mesaDisbursement]);
  if (r.adjustments.mesaDeduction) lines.push(['MESA', '', -r.adjustments.mesaDeduction]);

  const ties = r.dispatchNet != null && Math.abs(r.dispatchNet - r.gross) <= 0.01;

  return (
    <div className="border-l-2 border-indigo-300 bg-indigo-50/40 px-4 py-3 dark:border-indigo-700 dark:bg-indigo-950/15">
      <table className="text-[11px]">
        <tbody>
          {lines.map(([label, basis, amount], i) => (
            <tr key={i}>
              <td className="py-0.5 pr-4 text-zinc-600 dark:text-zinc-400">{label}</td>
              <td className="py-0.5 pr-4 font-mono text-zinc-500 dark:text-zinc-500">{basis}</td>
              <td className="py-0.5 text-right font-mono tabular-nums text-zinc-800 dark:text-zinc-200">
                {signedMoney(amount)}
              </td>
            </tr>
          ))}
          <tr className="border-t border-indigo-300/60 dark:border-indigo-700/60">
            <td className="pt-1 pr-4 font-semibold text-zinc-800 dark:text-zinc-200">Gross</td>
            <td />
            <td className="pt-1 text-right font-mono font-bold tabular-nums text-indigo-700 dark:text-indigo-300">
              {formatPHP(r.gross)}
            </td>
          </tr>
        </tbody>
      </table>
      <p className={cn('mt-1.5 text-[10px]', ties ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
        {r.dispatchNet == null
          ? 'Not staged for dispatch — this row will not be paid.'
          : ties
            ? '✓ ties to dispatch'
            : `Dispatch will send ${formatPHP(r.dispatchNet)}.`}
      </p>
      {validation && (
        <p className="mt-1 flex items-start gap-1.5 text-[10px] leading-snug text-emerald-700 dark:text-emerald-300">
          <BadgeCheck className="mt-px h-3 w-3 shrink-0" aria-hidden />
          <span>{validationSummary(validation)}</span>
        </p>
      )}
    </div>
  );
}

export default function ValidationBreakdownTable({
  rows, deptName, isHsl, disabled, onToggleExcluded, onToggleAllExcluded,
  validations, onToggleValidated, savingValidations, fillHeight,
}: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggleOpen = (rowKey: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });

  const emails = rows.map((r) => r.email);
  const excludedCount = rows.filter((r) => r.excluded).length;
  const allExcluded = rows.length > 0 && excludedCount === rows.length;
  const someExcluded = excludedCount > 0 && !allExcluded;

  const payable = rows.filter((r) => !r.excluded);
  const subtotal = payable.reduce((s, r) => s + r.gross, 0);

  const mvMap = validations ?? {};
  const validatedCount = rows.reduce((n, r) => n + (validationFor(mvMap, r.email) ? 1 : 0), 0);

  // Column count for colSpan on the expanded row, the empty state and the footer.
  // Must equal the sum of the group-header spans below, or the expanded row and
  // subtotal footer under-span and the table visibly misaligns:
  //   base: 2 + 2 + 2 + 3 + 3 + 3 = 15
  //   HSL:  2 + 3 + 3 + 4 + 3 + 3 = 18
  // The last group spans Gross + Excl + MV.
  const cols = isHsl ? 18 : 15;

  return (
    <div
      className={cn('overflow-auto [scrollbar-gutter:stable]', fillHeight && 'h-full')}
      style={fillHeight ? undefined : { maxHeight: 'min(62vh, calc(100dvh - 26rem))' }}
    >
      {/* Min-widths grew with the MV column (+64px) so the numeric cells keep
          their breathing room instead of crushing at the old width. */}
      <table className={cn('w-full text-xs', isHsl ? 'min-w-[1310px]' : 'min-w-[1110px]')}>
        <thead className="sticky top-0 z-20 bg-zinc-100/95 shadow-[0_1px_0_0_rgb(228_228_231)] dark:bg-zinc-900/95 dark:shadow-[0_1px_0_0_rgb(39_39_42)]">
          <tr>
            <th className={GROUP} colSpan={2} />
            <th className={cn(GROUP, 'border-l border-zinc-200 dark:border-zinc-800')} colSpan={isHsl ? 3 : 2}>Hours</th>
            <th className={cn(GROUP, 'border-l border-zinc-200 dark:border-zinc-800')} colSpan={isHsl ? 3 : 2}>Rates</th>
            <th className={cn(GROUP, 'border-l border-zinc-200 dark:border-zinc-800')} colSpan={isHsl ? 4 : 3}>Earnings</th>
            <th className={cn(GROUP, 'border-l border-zinc-200 dark:border-zinc-800')} colSpan={3}>Adjustments</th>
            <th className={cn(GROUP, 'border-l border-zinc-200 dark:border-zinc-800')} colSpan={3}>Gross</th>
          </tr>
          <tr>
            <th className="w-6 px-1" />
            <th className="min-w-[170px] px-3 text-left text-[11px] font-medium text-zinc-600 dark:text-zinc-400">Employee</th>
            {isHsl ? (
              <>
                <th className={cn(H, 'border-l border-zinc-200 dark:border-zinc-800')}>M-F</th>
                <th className={H}>WE</th>
                <th className={H}>OT</th>
                <th className={cn(H, 'border-l border-zinc-200 dark:border-zinc-800')}>M-F rate</th>
                <th className={H} title="M-F rate + ₱15 Sat/Sun premium">WE rate</th>
                <th className={H} title="M-F rate × 0.5 — the second stage of 1.5× overtime">OT ½</th>
                <th className={cn(H, 'border-l border-zinc-200 dark:border-zinc-800')}>Base</th>
                <th className={H}>Wknd</th>
                <th className={H}>OT $</th>
              </>
            ) : (
              <>
                <th className={cn(H, 'border-l border-zinc-200 dark:border-zinc-800')}>Reg</th>
                <th className={H}>OT</th>
                <th className={cn(H, 'border-l border-zinc-200 dark:border-zinc-800')}>Reg rate</th>
                <th className={H}>OT rate</th>
                <th className={cn(H, 'border-l border-zinc-200 dark:border-zinc-800')}>Reg pay</th>
                <th className={H}>OT pay</th>
              </>
            )}
            <th className={H}>Bonus</th>
            <th className={cn(H, 'border-l border-zinc-200 dark:border-zinc-800')} title="₱100/paycheck for enrolled members, plus any approved disbursement">MESA</th>
            <th className={H}>Adj</th>
            <th className={H}>Orph</th>
            <th className={cn(H, 'border-l border-zinc-200 dark:border-zinc-800 font-semibold text-indigo-600 dark:text-indigo-400')}>Gross</th>
            <th className="min-w-[80px] px-2 text-center text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
              <div className="flex items-center justify-center gap-1.5">
                <input
                  type="checkbox"
                  checked={allExcluded}
                  ref={(el) => { if (el) el.indeterminate = someExcluded; }}
                  onChange={() => onToggleAllExcluded(emails, !allExcluded)}
                  disabled={disabled || rows.length === 0}
                  aria-label={`Exclude all employees in ${deptName} from pay`}
                  className="h-4 w-4 cursor-pointer rounded border-zinc-300 accent-rose-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600"
                />
                <span>Excl</span>
              </div>
            </th>
            {/* MV has no master tickbox on purpose: "validate everyone at once"
                is exactly the claim this column exists to make impossible. */}
            <th
              className="min-w-[64px] px-2 text-center text-[11px] font-medium text-zinc-600 dark:text-zinc-400"
              title="Manually Validated — someone opened this person's pay, checked it by hand, and vouched for it"
            >
              <div className="flex flex-col items-center leading-tight">
                <span>MV</span>
                {rows.length > 0 && (
                  <span className="font-mono text-[9px] font-normal text-zinc-400">
                    {validatedCount}/{rows.length}
                  </span>
                )}
              </div>
            </th>
          </tr>
        </thead>

        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={cols} className="py-10 text-center text-sm text-zinc-400">
                No employees in this department.
              </td>
            </tr>
          ) : (
            rows.map((r, i) => {
              // Keyed by email + index, not email alone: upstream calc results are
              // not guaranteed to hold one row per email, and two rows sharing an
              // email must still expand independently.
              const rowKey = `${r.email}-${i}`;
              const isOpen = open.has(rowKey);
              const hasRed = r.flags.some((f) => f.severity === 'red');
              const hasAmber = !hasRed && r.flags.some((f) => f.severity === 'amber');
              const dim = r.excluded ? 'opacity-55' : '';
              const rowValidation = validationFor(mvMap, r.email);
              return (
                <React.Fragment key={rowKey}>
                  <tr
                    className={cn(
                      'hover:bg-zinc-50 dark:hover:bg-zinc-900/30',
                      r.excluded && 'bg-rose-50/40 dark:bg-rose-950/15',
                      hasRed && !r.excluded && 'bg-rose-50/60 dark:bg-rose-950/20',
                      hasAmber && !r.excluded && 'bg-amber-50/50 dark:bg-amber-950/15',
                    )}
                  >
                    <td className="px-1 align-top">
                      <button
                        type="button"
                        onClick={() => toggleOpen(rowKey)}
                        aria-label={isOpen ? `Hide calculation for ${r.name}` : `Show calculation for ${r.name}`}
                        aria-expanded={isOpen}
                        className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                      >
                        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', isOpen && 'rotate-90')} />
                      </button>
                    </td>
                    <td className={cn('px-3 py-2.5 align-top', dim)}>
                      <div className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">{r.name || '—'}</div>
                      <div className="truncate font-mono text-[10px] text-zinc-400">{r.email}</div>
                      <FlagList flags={r.flags} />
                    </td>

                    {isHsl ? (
                      <>
                        <td className={cn(CELL, dim, 'border-l border-zinc-100 dark:border-zinc-800/60')}>{hrs(r.hours.mf)}</td>
                        <td className={cn(CELL, dim)}>{hrs(r.hours.we)}</td>
                        <td className={cn(CELL, dim)}>{hrs(r.hours.ot)}</td>
                        <td className={cn(CELL, dim, 'border-l border-zinc-100 dark:border-zinc-800/60')}>
                          {r.rateChange
                            ? <span title="Rate changed mid-period — pay is prorated across both">{formatPHP(r.rateChange.from)} → {formatPHP(r.rateChange.to)}</span>
                            : r.rates ? formatPHP(r.rates.mf) : '—'}
                        </td>
                        <td className={cn(CELL, dim)}>{r.rates?.we != null ? formatPHP(r.rates.we) : '—'}</td>
                        <td className={cn(CELL, dim)}>{r.rates?.otDifferential != null ? formatPHP(r.rates.otDifferential) : '—'}</td>
                        <td className={cn(CELL, dim, 'border-l border-zinc-100 dark:border-zinc-800/60')}>{money(r.earnings.base, true)}</td>
                        <td className={cn(CELL, dim, 'text-amber-600 dark:text-amber-400')}>{money(r.earnings.weekend)}</td>
                        <td className={cn(CELL, dim)}>{money(r.earnings.otPay, true)}</td>
                      </>
                    ) : (
                      <>
                        <td className={cn(CELL, dim, 'border-l border-zinc-100 dark:border-zinc-800/60')}>{hrs(r.hours.mf)}</td>
                        <td className={cn(CELL, dim)}>{hrs(r.hours.ot)}</td>
                        <td className={cn(CELL, dim, 'border-l border-zinc-100 dark:border-zinc-800/60')}>
                          {r.rateChange
                            ? <span title="Rate changed mid-period — pay is prorated across both">{formatPHP(r.rateChange.from)} → {formatPHP(r.rateChange.to)}</span>
                            : r.rates ? formatPHP(r.rates.mf) : '—'}
                        </td>
                        <td className={cn(CELL, dim)}>{r.rates?.ot != null ? formatPHP(r.rates.ot) : '—'}</td>
                        <td className={cn(CELL, dim, 'border-l border-zinc-100 dark:border-zinc-800/60')}>{money(r.earnings.base, true)}</td>
                        <td className={cn(CELL, dim)}>{money(r.earnings.otPay, true)}</td>
                      </>
                    )}

                    <td className={cn(CELL, dim, 'text-emerald-600 dark:text-emerald-400')}>
                      {r.earnings.bonuses > 0 ? `+${formatPHP(r.earnings.bonuses)}` : <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                    </td>
                    <td className={cn(CELL, dim, 'border-l border-zinc-100 dark:border-zinc-800/60')}>
                      {r.adjustments.mesaDeduction || r.adjustments.mesaDisbursement ? (
                        <span className={r.adjustments.mesaDisbursement ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                          {signedMoney(r.adjustments.mesaDisbursement - r.adjustments.mesaDeduction)}
                        </span>
                      ) : <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                    </td>
                    <td className={cn(CELL, dim)}>{money(r.adjustments.adjustment)}</td>
                    <td className={cn(CELL, dim)}>{money(r.adjustments.orphanage)}</td>
                    <td className={cn(CELL, 'border-l border-zinc-100 font-bold dark:border-zinc-800/60', r.excluded ? 'text-zinc-400 line-through dark:text-zinc-600' : 'text-indigo-700 dark:text-indigo-300')}>
                      {formatPHP(r.gross)}
                    </td>
                    <td className="px-2 py-2.5 text-center align-top">
                      <input
                        type="checkbox"
                        checked={r.excluded}
                        onChange={() => onToggleExcluded(r.email)}
                        disabled={disabled}
                        aria-label={`Exclude ${r.name || r.email} from pay`}
                        className="h-4 w-4 cursor-pointer rounded border-zinc-300 accent-rose-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600"
                      />
                    </td>
                    <MvCell
                      row={r}
                      validation={rowValidation}
                      saving={savingValidations?.has(r.email.trim().toLowerCase()) ?? false}
                      disabled={disabled}
                      onToggle={onToggleValidated}
                    />
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={cols} className="p-0">
                        <WorkedTotal r={r} validation={rowValidation} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })
          )}
        </tbody>

        {rows.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-zinc-300 bg-zinc-100/80 dark:border-zinc-700 dark:bg-zinc-900/60">
              <td colSpan={cols - 3} className="px-3 py-2.5 text-xs font-bold text-zinc-700 dark:text-zinc-300">
                {deptName} Subtotal ({payable.length} payable{excludedCount > 0 ? ` · ${excludedCount} excluded` : ''})
              </td>
              <td className="px-2 py-2.5 text-right font-mono text-xs font-bold tabular-nums text-indigo-700 dark:text-indigo-300">
                {formatPHP(subtotal)}
              </td>
              <td />
              <td className="px-2 py-2.5 text-center font-mono text-[10px] font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
                {validatedCount > 0 ? `${validatedCount} MV` : ''}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
