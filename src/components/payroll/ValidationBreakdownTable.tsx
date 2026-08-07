// src/components/payroll/ValidationBreakdownTable.tsx
'use client';

import React, { useState } from 'react';
import { AlertTriangle, ChevronRight, Ban } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatPHP } from '@/lib/format-php';
import type { PayrollBreakdown, ValidationFlag } from '@/lib/payroll/validation-breakdown';

type Props = {
  rows: PayrollBreakdown[];
  deptName: string;
  /** Drives the column set: HSL shows the sheet's M-F / WE / OT½ form. */
  isHsl: boolean;
  disabled: boolean;
  onToggleExcluded: (email: string) => void;
  onToggleAllExcluded: (emails: string[], next: boolean) => void;
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

/** The worked calculation, shown when a row is expanded. */
function WorkedTotal({ r }: { r: PayrollBreakdown }) {
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
  const { kpi, pab, tech } = r.earnings.bonusParts;
  if (kpi) lines.push(['KPI / performance', '', kpi]);
  if (pab) lines.push(['Perfect attendance', '', pab]);
  if (tech) lines.push(['Tech bonus', '', tech]);
  if (r.adjustments.adjustment) lines.push(['Adjustment', '', r.adjustments.adjustment]);
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
                {amount < 0 ? `− ${formatPHP(Math.abs(amount))}` : formatPHP(amount)}
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
    </div>
  );
}

export default function ValidationBreakdownTable({
  rows, deptName, isHsl, disabled, onToggleExcluded, onToggleAllExcluded,
}: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggleOpen = (email: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });

  const emails = rows.map((r) => r.email);
  const excludedCount = rows.filter((r) => r.excluded).length;
  const allExcluded = rows.length > 0 && excludedCount === rows.length;
  const someExcluded = excludedCount > 0 && !allExcluded;

  const payable = rows.filter((r) => !r.excluded);
  const subtotal = payable.reduce((s, r) => s + r.gross, 0);

  // Column count for colSpan on the expanded row, the empty state and the footer.
  // Must equal the sum of the group-header spans below, or the expanded row and
  // subtotal footer under-span and the table visibly misaligns:
  //   base: 2 + 2 + 2 + 3 + 3 + 2 = 14
  //   HSL:  2 + 3 + 3 + 4 + 3 + 2 = 17
  const cols = isHsl ? 17 : 14;

  return (
    <div className="overflow-auto [scrollbar-gutter:stable]" style={{ maxHeight: 'min(62vh, calc(100dvh - 26rem))' }}>
      <table className={cn('w-full text-xs', isHsl ? 'min-w-[1240px]' : 'min-w-[1040px]')}>
        <thead className="sticky top-0 z-20 bg-zinc-100/95 shadow-[0_1px_0_0_rgb(228_228_231)] dark:bg-zinc-900/95 dark:shadow-[0_1px_0_0_rgb(39_39_42)]">
          <tr>
            <th className={GROUP} colSpan={2} />
            <th className={cn(GROUP, 'border-l border-zinc-200 dark:border-zinc-800')} colSpan={isHsl ? 3 : 2}>Hours</th>
            <th className={cn(GROUP, 'border-l border-zinc-200 dark:border-zinc-800')} colSpan={isHsl ? 3 : 2}>Rates</th>
            <th className={cn(GROUP, 'border-l border-zinc-200 dark:border-zinc-800')} colSpan={isHsl ? 4 : 3}>Earnings</th>
            <th className={cn(GROUP, 'border-l border-zinc-200 dark:border-zinc-800')} colSpan={3}>Adjustments</th>
            <th className={cn(GROUP, 'border-l border-zinc-200 dark:border-zinc-800')} colSpan={2}>Gross</th>
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
            rows.map((r) => {
              const isOpen = open.has(r.email);
              const hasRed = r.flags.some((f) => f.severity === 'red');
              const hasAmber = !hasRed && r.flags.some((f) => f.severity === 'amber');
              const dim = r.excluded ? 'opacity-55' : '';
              return (
                <React.Fragment key={r.email}>
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
                        onClick={() => toggleOpen(r.email)}
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
                          {formatPHP(r.adjustments.mesaDisbursement - r.adjustments.mesaDeduction)}
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
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={cols} className="p-0">
                        <WorkedTotal r={r} />
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
              <td colSpan={cols - 2} className="px-3 py-2.5 text-xs font-bold text-zinc-700 dark:text-zinc-300">
                {deptName} Subtotal ({payable.length} payable{excludedCount > 0 ? ` · ${excludedCount} excluded` : ''})
              </td>
              <td className="px-2 py-2.5 text-right font-mono text-xs font-bold tabular-nums text-indigo-700 dark:text-indigo-300">
                {formatPHP(subtotal)}
              </td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
